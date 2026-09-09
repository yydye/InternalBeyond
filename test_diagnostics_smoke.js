'use strict';

/*
 * P5 · 系统诊断端到端 smoke（真实 Chrome/Edge + 真实 HTTP 服务 + 真实 boot-state）
 *
 * 覆盖验收场景：
 *   1  normal        —— 六项能力全部正常（真实 /__boot-state + 真实探测）
 *   2  boot-state    —— 启动 degraded、当前已恢复（启动快照 ≠ 当前状态）
 *   3  bridge down   —— 当前不可用 + 「仍然可以正常聊天」+ 出现「尝试修复」
 *   4  recheck       —— 重新检查有 loading、有更新时间、不崩页
 *   5  restart 失败   —— 自动修复没有成功…（不假装修好）
 *   6  restart 成功   —— 本地功能已经恢复。（真实 POST /restart → 轮询 → 重新 probe）
 *   7  vision 可选    —— 视觉功能不影响总体状态
 *   8  export        —— 导出真实报告；注入 sk-/Bearer/JWT/query key/Cookie/prompt/
 *                       聊天正文，报告里必须全部不存在
 *   9  AI 连接测试    —— 复用 callApiChat：成功 / 401 走 P3 文案
 *  10  技术详情       —— 主页面不暴露组件名/端口，展开后才出现（且已脱敏）
 *  11  P3 错误卡片    —— 本地服务错误卡片「系统诊断」动作跳转到诊断页
 *
 * Run: node test_diagnostics_smoke.js
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');
const crypto = require('crypto');

const WEB = require('./internal-beyond-server.js');
const bootState = require('./boot-state.js');
const ROOT = __dirname;

const GOOD_KEY = 'sk-smoke-diag-ok-123456';
const BAD_KEY = 'sk-smoke-diag-bad-abcdef';
const SECRETS = {
  sk: 'sk-live-DEADBEEF0123456789',
  bearer: 'Bearer eyABCDEFGHIJ0123456789',
  jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk',
  query: 'https://api.example.com/v1/chat/completions?key=SECRET-QUERY-VALUE',
  cookie: 'Cookie: session=SECRETCOOKIEVALUE123',
  prompt: '我的系统提示词是：你是一个秘密角色，不要告诉任何人。',
  chat: '聊天正文：昨天我们去海边看了日落，这句话只应该留在本地。'
};

function chromePath() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  for (const c of [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
  ]) if (fs.existsSync(c)) return c;
  return null;
}
function freePort() {
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.unref();
    s.on('error', rej);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(e => e ? rej(e) : res(p)); });
  });
}
function httpJson(url, method, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request({
      host: u.hostname, port: u.port, path: u.pathname + u.search, method: method || 'GET',
      headers: { Connection: 'close', 'Content-Type': 'application/json' }
    }, res => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', c => { raw += c; });
      res.on('end', () => { let json = null; try { json = JSON.parse(raw); } catch (e) { } resolve({ ok: res.statusCode < 400, status: res.statusCode, json, raw }); });
    });
    req.on('error', reject);
    req.setTimeout(4000, () => { req.destroy(); reject(new Error('timeout ' + url)); });
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

/* Minimal CDP client (same subset as test_setup_wizard_smoke.js). */
class Cdp {
  constructor(s) { this.s = s; this.b = Buffer.alloc(0); this.id = 0; this.p = new Map(); this.l = new Map(); s.on('data', c => { this.b = Buffer.concat([this.b, c]); this.parse(); }); s.on('error', () => { }); }
  static connect(url) {
    return new Promise((res, rej) => {
      const u = new URL(url);
      const r = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, headers: { Upgrade: 'websocket', Connection: 'Upgrade', 'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'), 'Sec-WebSocket-Version': '13' } });
      r.on('upgrade', (r2, s) => res(new Cdp(s)));
      r.on('error', rej);
      r.end();
    });
  }
  on(m, l) { if (!this.l.has(m)) this.l.set(m, []); this.l.get(m).push(l); }
  send(m, p = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      const timer = setTimeout(() => { if (this.p.has(id)) { this.p.delete(id); rej(new Error('timeout ' + m)); } }, 30000);
      this.p.set(id, { res: v => { clearTimeout(timer); res(v); }, rej: e => { clearTimeout(timer); rej(e); } });
      this.t({ id, method: m, params: p });
    });
  }
  t(m) {
    const p = Buffer.from(JSON.stringify(m), 'utf8'), mask = crypto.randomBytes(4), b = Buffer.alloc(p.length);
    for (let i = 0; i < p.length; i++) b[i] = p[i] ^ mask[i & 3];
    let h;
    if (p.length < 126) h = Buffer.from([0x81, 0x80 | p.length]);
    else { h = Buffer.alloc(4); h[0] = 0x81; h[1] = 0x80 | 126; h.writeUInt16BE(p.length, 2); }
    this.s.write(Buffer.concat([h, mask, b]));
  }
  parse() {
    for (;;) {
      if (this.b.length < 2) return;
      const f = this.b[0], sl = this.b[1] & 0x7f;
      let o = 2, len = sl;
      if (sl === 126) { if (this.b.length < 4) return; len = this.b.readUInt16BE(2); o = 4; }
      else if (sl === 127) { if (this.b.length < 10) return; len = this.b.readUInt32BE(6); o = 10; }
      const masked = (this.b[1] & 0x80) !== 0;
      let mask = null;
      if (masked) { if (this.b.length < o + 4) return; mask = this.b.subarray(o, o + 4); o += 4; }
      if (this.b.length < o + len) return;
      let p = this.b.subarray(o, o + len);
      this.b = this.b.subarray(o + len);
      if (mask) { const d = Buffer.alloc(p.length); for (let i = 0; i < p.length; i++) d[i] = p[i] ^ mask[i & 3]; p = d; }
      const op = f & 0xf;
      if (op === 0x8) { try { this.s.destroy(); } catch (e) { } return; }
      if (op === 0x9) continue;
      if (op !== 0x1) continue;
      let msg;
      try { msg = JSON.parse(p.toString('utf8')); } catch (e) { continue; }
      if (msg.id && this.p.has(msg.id)) {
        const q = this.p.get(msg.id); this.p.delete(msg.id);
        if (msg.error) q.rej(new Error(JSON.stringify(msg.error))); else q.res(msg.result || {});
      } else if (msg.method && this.l.has(msg.method)) {
        for (const l of this.l.get(msg.method)) l(msg.params || {});
      }
    }
  }
  close() { try { this.s.destroy(); } catch (e) { } }
}

async function ev(cdp, expr) {
  const r = await cdp.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error('page exception: ' + JSON.stringify(r.exceptionDetails.exception));
  return r.result && r.result.value;
}
async function wait(cdp, expr, ms) {
  const end = Date.now() + (ms || 15000);
  while (Date.now() < end) {
    try { if (await ev(cdp, expr)) return true; } catch (e) { }
    await new Promise(r => setTimeout(r, 150));
  }
  return false;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (detail !== undefined ? ' — ' + JSON.stringify(detail) : '')); }
}

/* ── mock Bridge：真实 HTTP，可被「停掉 / 重启」 ── */
function createMockBridge() {
  let server = null;
  const state = { port: 0, up: false, hits: { health: 0, status: 0, diagnostics: 0 } };
  function handler(req, res) {
    const cors = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
    const pathname = String(req.url || '').split('?')[0];
    if (pathname === '/health') {
      state.hits.health++;
      res.writeHead(200, cors);
      res.end(JSON.stringify({ ok: true, server: 'IB Bridge', version: '9.9.9', uptime: 3, connections: 0, tools: [], lan: false, tokenRequired: false }));
      return;
    }
    if (pathname === '/status') {
      state.hits.status++;
      res.writeHead(200, cors);
      res.end(JSON.stringify({
        ok: true, server: 'IB Bridge', version: '9.9.9', connections: 1,
        whispers: 2, health: 3, letters: 1, sessions: 4, contextFriends: 5, stickers: 6,
        tts: true, mimoTts: false, voiceAsr: false, bark: false, ntfy: false, proactive: true,
        /* 敌意注入：真实服务不会这样返回，但报告必须一条都不带出去 */
        token: SECRETS.sk, authorization: SECRETS.bearer, cookie: SECRETS.cookie,
        systemPrompt: SECRETS.prompt, lastMessage: SECRETS.chat, note: SECRETS.jwt
      }));
      return;
    }
    if (pathname === '/api/diagnostics') {
      state.hits.diagnostics++;
      res.writeHead(200, cors);
      res.end(JSON.stringify({
        ok: true,
        service: { name: 'IB Bridge', version: '9.9.9', uptimeSeconds: 12, host: '127.0.0.1', port: state.port, websocketConnections: 1 },
        data: { records: { whispers: 2, health: 3, letters: 1 }, files: [] },
        warnings: [SECRETS.prompt, SECRETS.cookie, SECRETS.query]
      }));
      return;
    }
    res.writeHead(404, cors);
    res.end(JSON.stringify({ ok: false }));
  }
  return {
    state,
    async up() {
      if (server) return state.port;
      if (!state.port) state.port = await freePort();
      server = http.createServer(handler);
      await new Promise((res, rej) => { server.once('error', rej); server.listen(state.port, '127.0.0.1', res); });
      state.up = true;
      return state.port;
    },
    async down() {
      state.up = false;
      if (!server) return;
      const s = server; server = null;
      try { s.closeAllConnections && s.closeAllConnections(); } catch (e) { }
      await new Promise(r => { const t = setTimeout(r, 2000); s.close(() => { clearTimeout(t); r(); }); });
    }
  };
}

/* ── mock Active companion（前端客户端固定指向 23114，smoke 用同形客户端注入）── */
function createMockActive() {
  const state = { port: 0, up: false, server: null };
  return {
    state,
    async up() {
      if (state.server) return state.port;
      state.port = await freePort();
      state.server = http.createServer((req, res) => {
        const pathname = String(req.url || '').split('?')[0];
        const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
        if (pathname === '/health') {
          res.writeHead(200, headers);
          res.end(JSON.stringify({ ok: true, service: 'internal-beyond-active-messages', version: 3, tasks: 1, plans: 2, moments: 3, reply_chains: 0, pending_events: 0, armed_users: 1, now: Date.now() }));
          return;
        }
        res.writeHead(404, headers); res.end('{}');
      });
      await new Promise((res, rej) => { state.server.once('error', rej); state.server.listen(state.port, '127.0.0.1', res); });
      state.up = true;
      return state.port;
    },
    async close() {
      state.up = false;
      if (!state.server) return;
      const s = state.server; state.server = null;
      try { s.closeAllConnections && s.closeAllConnections(); } catch (e) { }
      await new Promise(r => { const t = setTimeout(r, 2000); s.close(() => { clearTimeout(t); r(); }); });
    }
  };
}

/* ── mock restart control plane：真实 /status + /restart 状态机 ── */
function createMockRestart(onRestart) {
  const state = { port: 0, status: 'idle', mode: 'ok', server: null, restarts: 0 };
  return {
    state,
    async up() {
      if (state.server) return state.port;
      state.port = await freePort();
      state.server = http.createServer((req, res) => {
        const pathname = String(req.url || '').split('?')[0];
        const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
        if (req.method === 'GET' && pathname === '/status') {
          res.writeHead(200, headers);
          res.end(JSON.stringify({ ok: true, service: 'InternalBeyond Restart', state: state.status, error: '' }));
          return;
        }
        if (req.method === 'POST' && pathname === '/restart') {
          if (state.status === 'restarting') { res.writeHead(409, headers); res.end(JSON.stringify({ ok: false, state: 'restarting' })); return; }
          state.status = 'restarting';
          state.restarts++;
          res.writeHead(202, headers);
          res.end(JSON.stringify({ ok: true, state: 'restarting' }));
          setTimeout(async () => {
            if (state.mode === 'fail') { state.status = 'failed'; return; }
            try { await onRestart(); state.status = 'ready'; }
            catch (e) { state.status = 'failed'; }
          }, 1200);
          return;
        }
        res.writeHead(404, headers); res.end('{}');
      });
      await new Promise((res, rej) => { state.server.once('error', rej); state.server.listen(state.port, '127.0.0.1', res); });
      return state.port;
    },
    async close() {
      if (!state.server) return;
      const s = state.server; state.server = null;
      try { s.closeAllConnections && s.closeAllConnections(); } catch (e) { }
      await new Promise(r => { const t = setTimeout(r, 2000); s.close(() => { clearTimeout(t); r(); }); });
    }
  };
}

/* ── mock provider（OpenAI 兼容，非流式；用于 AI 连接测试）── */
function startMockProvider() {
  return new Promise(resolve => {
    const state = { okCount: 0, failCount: 0 };
    const server = http.createServer((req, res) => {
      const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': '*', 'Content-Type': 'application/json' };
      if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
      if (req.method !== 'POST' || String(req.url).indexOf('/chat/completions') === -1) { res.writeHead(404, cors); res.end('{}'); return; }
      const chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => {
        if (String(req.headers.authorization || '') !== 'Bearer ' + GOOD_KEY) {
          state.failCount++;
          res.writeHead(401, cors);
          res.end(JSON.stringify({ error: { message: 'Incorrect API key provided', type: 'invalid_request_error', code: 'invalid_api_key' } }));
          return;
        }
        state.okCount++;
        res.writeHead(200, cors);
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '你好呀' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2 } }));
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, state }));
  });
}

function writeLaunchRecord(dir, webPort, opts) {
  const o = opts || {};
  const comps = {
    static: { required: true, affectsOverall: true, probed: true, healthy: true, state: 'healthy', host: '127.0.0.1', port: webPort, url: 'http://127.0.0.1:' + webPort, identity: 'InternalBeyond Web' },
    bridge: o.bridgeDown
      ? { required: false, affectsOverall: true, probed: true, healthy: false, state: 'offline', port: o.bridgePort, reason: { category: 'offline', message: 'Bridge is not answering /health on port ' + o.bridgePort + ' ' + SECRETS.prompt + ' ' + SECRETS.sk } }
      : { required: false, affectsOverall: true, probed: true, healthy: true, state: 'healthy', port: o.bridgePort },
    active: o.activeDown
      ? { required: false, affectsOverall: true, probed: true, healthy: false, state: 'offline', port: o.activePort, reason: { category: 'offline', message: 'Active offline ' + SECRETS.chat + ' ' + SECRETS.jwt } }
      : { required: false, affectsOverall: true, probed: true, healthy: true, state: 'healthy', port: o.activePort },
    restart: { required: false, affectsOverall: false, probed: true, healthy: true, state: 'healthy', port: o.restartPort },
    vision: { required: false, affectsOverall: false, probed: false, healthy: false, state: 'not-enabled', port: 8765, reason: { category: 'not-enabled', message: 'Vision is an optional extra ' + SECRETS.cookie } }
  };
  const st = bootState.buildBootState({
    bootId: bootState.newBootId(Date.now()),
    now: Date.now(),
    phase: 'complete',
    opened: true,
    launcher: {
      pid: process.pid, startedAt: Date.now() - 5000, finishedAt: Date.now(),
      root: ROOT, platform: process.platform, arch: process.arch,
      node: { path: process.execPath, version: process.version, source: 'bundled', bundled: true, requiredMajor: 18, ok: true },
      serviceManager: { state: 'up', wasRunning: true, started: false, error: null }
    },
    components: comps,
    warnings: [{ code: 'runner-unavailable', message: SECRETS.prompt + ' ' + SECRETS.bearer }]
  });
  const written = bootState.writeBootState(st, { dir });
  if (!written.ok) throw new Error('boot-state write failed: ' + JSON.stringify(written.error));
  return st;
}

(async () => {
  const watchdog = setTimeout(() => {
    console.error('\nWATCHDOG: diagnostics smoke exceeded 240s — unreleased resources: ' +
      (process.getActiveResourcesInfo ? process.getActiveResourcesInfo().join(',') : 'n/a'));
    process.exit(1);
  }, 240000);
  watchdog.unref();

  console.log('P5 · 系统诊断 smoke（真实 Chrome + 真实 HTTP + 真实 boot-state）\n');

  const chrome = chromePath();
  if (!chrome) {
    console.log('  ⊘ skipped: no Chrome / Edge found');
    clearTimeout(watchdog);
    process.exitCode = 0;
    return;
  }

  const tmpStateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-p5-state-'));
  const prevStateDir = process.env.IB_BOOT_STATE_DIR;
  process.env.IB_BOOT_STATE_DIR = tmpStateDir;

  const mockProvider = await startMockProvider();
  const providerEndpoint = 'http://127.0.0.1:' + mockProvider.port + '/v1/chat/completions';

  const bridge = createMockBridge();
  const bridgePort = await bridge.up();
  const active = createMockActive();
  const activePort = await active.up();
  const restart = createMockRestart(async () => { await bridge.up(); });
  const restartPort = await restart.up();

  const webSrv = WEB.createWebServer({ port: 0, root: ROOT });
  const webPort = await new Promise((res, rej) => { webSrv.once('error', rej); webSrv.listen(0, '127.0.0.1', () => res(webSrv.address().port)); });
  const pageUrl = 'http://127.0.0.1:' + webPort + '/InternalBeyond.html';

  const cdpPort = await freePort();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-p5-chrome-'));
  const browser = spawn(chrome, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    '--force-color-profile=srgb', '--window-size=1440,900',
    '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=' + cdpPort,
    '--user-data-dir=' + profile, 'about:blank'
  ], { stdio: 'ignore' });

  let cdp = null;
  const pageErrors = [];
  const consoleText = [];
  try {
    let ready = false;
    for (let i = 0; i < 150; i++) {
      try { const r = await httpJson('http://127.0.0.1:' + cdpPort + '/json/version'); if (r.ok) { ready = true; break; } } catch (e) { }
      await sleep(100);
    }
    check('browser ready', ready);
    if (!ready) throw new Error('Chrome DevTools did not become ready');

    /* 启动快照：normal（Bridge/Active 都健康） */
    writeLaunchRecord(tmpStateDir, webPort, { bridgePort, activePort, restartPort });

    const tab = (await httpJson('http://127.0.0.1:' + cdpPort + '/json/new?' + encodeURIComponent(pageUrl), 'PUT')).json;
    cdp = await Cdp.connect(tab.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    cdp.on('Runtime.exceptionThrown', p => pageErrors.push(String((p.exceptionDetails && p.exceptionDetails.text) || 'exception')));
    cdp.on('Runtime.consoleAPICalled', p => {
      const parts = (p.args || []).map(a => (a.value !== undefined ? String(a.value) : String(a.description || '')));
      consoleText.push(parts.join(' '));
    });

    const enterSite = async () => {
      await wait(cdp, "document.readyState==='complete' && !!document.getElementById('splash')", 25000);
      await ev(cdp, "window.confirm=function(){return true;};window.alert=function(){};true");
      await ev(cdp, "(function(){var s=document.getElementById('splash-skip');if(s)s.click();else if(typeof enterSite==='function')enterSite();return true;})()");
    };
    await enterSite();
    check('A1) 模块已挂载', await wait(cdp, "!!window.IBDiagnostics && !!document.getElementById('page-diagnostics')", 15000));

    /* 把真实探测指向本机 mock 服务：只改「地址来源」，不改探测逻辑本身 */
    const wireMocks = async () => {
      await ev(cdp, `(function(){
        try{ localStorage.setItem('ib_bridge_http','http://127.0.0.1:${bridgePort}'); }catch(e){}
        window.IB_RESTART_PORT=${restartPort};
        /* Active 前端客户端固定指向 23114（真实服务），smoke 用同形客户端指向 mock */
        window._activeCompanionRequest=function(path,opts){
          var ac=new AbortController(),tm=setTimeout(function(){ac.abort();},(opts&&opts.timeout)||2500);
          return fetch('http://127.0.0.1:${activePort}'+path,{cache:'no-store',signal:ac.signal})
            .then(function(r){return r.text().then(function(t){
              if(!r.ok){var e=new Error('后台服务 '+r.status);e.ibSource='local_service';e.ibComponent='active';e.status=r.status;throw e;}
              return t?JSON.parse(t):{};})})
            .finally(function(){clearTimeout(tm);});
        };
        return true;
      })()`);
    };
    await wireMocks();

    /* 一个已配置好的角色（normal 阶段 AI 聊天应为「正常」）：
       走既有持久化路径 dbPut + loadApiConfigs，避免与页面初始化竞态。 */
    const seeded = await ev(cdp, `(async function(){
      var role={id:'ib-diag-smoke-role',nickname:'诊断测试角色',provider:'custom',
        model:'smoke-model',endpoint:${JSON.stringify(providerEndpoint)},apiKey:${JSON.stringify(GOOD_KEY)},
        temperature:1,streaming:false,created:Date.now()};
      try{ await dbPut('apiConfigs', role); }catch(e){}
      try{ if(typeof loadApiConfigs==='function') await loadApiConfigs(); }catch(e){}
      var list=window.apiConfigs||[];
      if(!list.some(function(c){return c.id===role.id;})){ list.push(role); }
      return {count:list.length, ready:(typeof _ibApiReady==='function')?_ibApiReady(list.filter(function(c){return c.id===role.id;})[0]):null};
    })()`);
    check('A2) 已有一个可用角色（真实 apiConfigs 路径）', seeded && seeded.count >= 1 && seeded.ready === true, seeded);

    /* ── 1) 独立导航入口 → 诊断页 ── */
    const navClick = await ev(cdp, `(function(){
      var a=document.querySelector('.nav-links a[data-page="diagnostics"]');
      if(!a)return {found:false};
      a.click();
      return {found:true, href:a.getAttribute('href'), text:a.textContent};
    })()`);
    check('B1) 导航里有独立 Diagnostics 入口', navClick && navClick.found === true && navClick.href === '#diagnostics', navClick);
    check('B2) 点击后诊断页成为当前页', await wait(cdp, "document.getElementById('page-diagnostics').classList.contains('active')", 8000));
    check('B3) 自动完成首次检查', await wait(cdp, "!!document.querySelector('#ib-diag-list .ib-diag-row') && !document.getElementById('ib-diag-recheck').disabled", 20000));

    /* ── normal ── */
    const normal = await ev(cdp, `(()=>{
      const rows=[...document.querySelectorAll('#ib-diag-list .ib-diag-row')].map(r=>({cap:r.dataset.cap,status:r.dataset.status,text:r.textContent}));
      return {headline:document.getElementById('ib-diag-headline').textContent,
        updated:document.getElementById('ib-diag-updated').textContent,
        rows:rows, pageText:document.getElementById('page-diagnostics').textContent};
    })()`);
    check('C1) 全部正常 → 标题「系统运行正常」', normal && normal.headline === '系统运行正常', normal && normal.headline);
    check('C2) 四项主要能力全部「正常」', normal && ['base', 'chat', 'bridge', 'active'].every(id => normal.rows.filter(r => r.cap === id)[0].status === 'ok'),
      normal && normal.rows.map(r => r.cap + ':' + r.status));
    check('C3) 显示最近检查时间', normal && /最近检查：\d{2}:\d{2}:\d{2}/.test(normal.updated), normal && normal.updated);
    /* 本仓库存在 .venv-vision → 视觉「已安装但未启动」；它是可选组件，绝不能拖累总体状态 */
    const visionRow = normal && normal.rows.filter(r => r.cap === 'vision')[0];
    check('C4) 视觉功能可选：未运行也不影响总体状态', normal && normal.headline === '系统运行正常' && ['ok', 'down', 'optional'].indexOf(visionRow.status) !== -1, visionRow);

    /* 主页面不暴露技术概念 */
    const LEAK_WORDS = ['Bridge', 'Active', '23115', '23114', '127.0.0.1', 'WebSocket', 'ws://', 'Node', '端口'];
    const pageLeaks = LEAK_WORDS.filter(w => normal.pageText.indexOf(w) !== -1);
    check('C5) 主页面不出现技术概念', pageLeaks.length === 0, pageLeaks);

    /* ── 技术详情：展开后才出现，且已脱敏 ── */
    await ev(cdp, "document.getElementById('ib-diag-details').click();true");
    check('D1) 展开技术详情后出现组件名 / 端口 / bootId', await wait(cdp, `(()=>{
      const p=document.getElementById('ib-diag-tech');
      if(!p)return false;
      const t=p.textContent;
      return t.indexOf('bridge：')!==-1 && t.indexOf('port=')!==-1 && t.indexOf('bootId')!==-1;
    })()`, 12000));
    const techText = await ev(cdp, "(document.getElementById('ib-diag-tech')||{}).textContent||''");
    check('D2) 技术详情已脱敏（不含注入的密钥 / 提示词 / 聊天正文）', Object.keys(SECRETS).every(k => techText.indexOf(SECRETS[k]) === -1), Object.keys(SECRETS).filter(k => techText.indexOf(SECRETS[k]) !== -1));
    check('D3) 技术详情含组件与探测信息', /bridge：/.test(techText) && techText.indexOf('健康 / 诊断摘要') !== -1, techText.slice(0, 200));
    await ev(cdp, "document.getElementById('ib-diag-details').click();true");

    /* ── 2) boot-state degraded、当前已恢复 ── */
    writeLaunchRecord(tmpStateDir, webPort, { bridgePort, activePort, restartPort, bridgeDown: true, activeDown: true });
    await ev(cdp, "document.getElementById('ib-diag-recheck').click();true");
    check('E1) 启动 degraded + 当前恢复 → 仍显示「正常」', await wait(cdp, `(()=>{
      const r=document.querySelector('#ib-diag-list .ib-diag-row[data-cap="bridge"]');
      return !!r && r.dataset.status==='ok' && /启动时这项功能曾经降级，现在已经恢复/.test(r.textContent);
    })()`, 15000));
    const recoveredHeadline = await ev(cdp, "document.getElementById('ib-diag-headline').textContent");
    check('E2) 不因启动快照 degraded 就永久显示故障', recoveredHeadline === '系统运行正常', recoveredHeadline);

    /* ── 3) Bridge 当前 down ── */
    await bridge.down();
    await ev(cdp, "document.getElementById('ib-diag-recheck').click();true");
    check('F1) Bridge down → 本地增强功能=不可用', await wait(cdp, `(()=>{
      const r=document.querySelector('#ib-diag-list .ib-diag-row[data-cap="bridge"]');
      return !!r && r.dataset.status==='down' && /本地增强功能暂时不可用/.test(r.textContent);
    })()`, 15000));
    const downState = await ev(cdp, `(()=>({
      headline:document.getElementById('ib-diag-headline').textContent,
      sub:(document.getElementById('ib-diag-sub')||{}).textContent||'',
      voice:document.querySelector('#ib-diag-list .ib-diag-row[data-cap="voice"]').dataset.status,
      repair:!!document.getElementById('ib-diag-repair-btn'),
      pageText:document.getElementById('page-diagnostics').textContent
    }))()`);
    check('F2) 总体「部分功能暂时不可用」+「你仍然可以正常聊天」', downState.headline === '部分功能暂时不可用' && /你仍然可以正常聊天/.test(downState.sub), downState);
    check('F3) 语音功能随之下线', downState.voice === 'down', downState.voice);
    check('F4) 出现「尝试修复」（重启控制面可用）', downState.repair === true, downState.repair);
    check('F5) 故障态主页面仍不含技术概念', LEAK_WORDS.every(w => downState.pageText.indexOf(w) === -1), LEAK_WORDS.filter(w => downState.pageText.indexOf(w) !== -1));

    /* ── 4) restart 失败 ── */
    restart.state.mode = 'fail';
    await ev(cdp, "document.getElementById('ib-diag-repair-btn').click();true");
    check('G1) 修复进行中有明确 loading', await wait(cdp, "/正在尝试恢复/.test(document.getElementById('ib-diag-repair').textContent)", 6000));
    check('G2) restart 失败 → 「自动修复没有成功。你仍然可以继续使用可用功能。」', await wait(cdp, `/自动修复没有成功。你仍然可以继续使用可用功能。/.test(document.getElementById('ib-diag-repair').textContent)`, 40000));
    check('G3) 失败后 Bridge 仍显示不可用（不假装修好）', await wait(cdp, `document.querySelector('#ib-diag-list .ib-diag-row[data-cap="bridge"]').dataset.status==='down'`, 15000));

    /* ── 5) restart 成功 ── */
    restart.state.mode = 'ok';
    await wait(cdp, "!document.getElementById('ib-diag-recheck').disabled && !!document.getElementById('ib-diag-repair-btn')", 20000);
    await ev(cdp, "document.getElementById('ib-diag-repair-btn').click();true");
    check('H1) restart 成功 → 「本地功能已经恢复。」', await wait(cdp, `/本地功能已经恢复。/.test(document.getElementById('ib-diag-repair').textContent)`, 45000));
    check('H2) 重启后重新 probe → 本地增强功能=正常', await wait(cdp, `document.querySelector('#ib-diag-list .ib-diag-row[data-cap="bridge"]').dataset.status==='ok'`, 15000));
    check('H3) 总体恢复「系统运行正常」', await wait(cdp, "document.getElementById('ib-diag-headline').textContent==='系统运行正常'", 8000));
    check('H4) 修复只触发一次真实 /restart', restart.state.restarts === 2, restart.state.restarts);

    /* ── 6) AI 连接测试（复用 callApiChat）── */
    await ev(cdp, "document.getElementById('ib-diag-recheck').click();true");
    await wait(cdp, "!document.getElementById('ib-diag-recheck').disabled", 20000);
    await ev(cdp, "document.getElementById('ib-diag-ai-btn').click();true");
    check('I1) AI 连接测试成功', await wait(cdp, `/连接正常/.test(document.getElementById('ib-diag-ai').textContent)`, 30000));
    check('I2) 明确提示会实际发送一个很小的请求', await ev(cdp, "/测试会实际向 AI 服务发送一个很小的请求/.test(document.getElementById('ib-diag-ai').textContent)"));
    check('I3) 成功时只发一次请求（不遍历所有角色）', mockProvider.state.okCount >= 1 && mockProvider.state.okCount <= 3, mockProvider.state);

    await ev(cdp, `(function(){
      var c=(window.apiConfigs||[]).filter(function(x){return x.id==='ib-diag-smoke-role';})[0];
      c.apiKey=${JSON.stringify(BAD_KEY)};
      try{ dbPut('apiConfigs', c); }catch(e){}
      return true;
    })()`);
    await ev(cdp, "document.getElementById('ib-diag-ai-btn').click();true");
    check('I4) 401 → 复用 P3 用户文案（API 密钥无法使用）', await wait(cdp, `/API 密钥无法使用/.test(document.getElementById('ib-diag-ai').textContent)`, 30000));
    const aiFailText = await ev(cdp, "document.getElementById('ib-diag-ai').textContent");
    check('I5) 401 用户提示不含状态码 / 密钥 / 地址', ['401', BAD_KEY, 'sk-', 'http://', '127.0.0.1'].every(w => aiFailText.indexOf(w) === -1), aiFailText);

    /* ── 7) P3 本地服务错误卡片 → 系统诊断（先发生错误，再导出报告，顺序与真人一致）── */
    const cardNav = await ev(cdp, `(function(){
      if(typeof navTo==='function')navTo('home');
      window.IBERR.hideAll();
      window.IBERR.show(window.IBERR.model('local_service',{component:'bridge'}));
      var card=document.querySelector('#ib-err-stack .ib-err-card');
      if(!card)return {found:false};
      var btn=card.querySelector('.ib-err-action');
      var label=btn?btn.textContent:'';
      if(btn)btn.click();
      return {found:true,label:label,page:(typeof currentPage!=='undefined'?currentPage:'')};
    })()`);
    check('K1) 本地服务错误卡片提供「系统诊断」动作', cardNav && cardNav.found === true && cardNav.label === '系统诊断', cardNav);
    check('K2) 点击后跳转到诊断页', cardNav && cardNav.page === 'diagnostics' && await wait(cdp, "document.getElementById('page-diagnostics').classList.contains('active')", 6000), cardNav);
    const errCardText = await ev(cdp, `(function(){window.IBERR.hideAll();window.IBERR.show(window.IBERR.model('local_service',{component:'bridge'}));var c=document.querySelector('#ib-err-stack .ib-err-card');return c?c.textContent:'';})()`);
    check('K3) 错误卡片用户文案不含 Bridge / 端口', ['Bridge', '23115', '127.0.0.1', 'ws://'].every(w => errCardText.indexOf(w) === -1), errCardText);

    /* ── 8) 导出诊断报告 + 密钥扫描 ── */
    await ev(cdp, `(function(){
      window.__ibExportBlob=null;
      var o=URL.createObjectURL;
      URL.createObjectURL=function(b){window.__ibExportBlob=b;return o.call(URL,b);};
      return true;
    })()`);
    await ev(cdp, "document.getElementById('ib-diag-export').click();true");
    await wait(cdp, "!!window.__ibExportBlob", 15000);
    const report = await ev(cdp, "(window.__ibExportBlob?window.__ibExportBlob.text():'')");
    check('J1) 报告导出成功且内容完整', !!report && report.length > 300 && /InternalBeyond 诊断报告/.test(report) && /【当前功能状态】/.test(report) && /【当前探测】/.test(report), report && report.length);
    check('J2) 报告含启动快照 / 组件 / 健康摘要 / P3 错误码', /【启动快照/.test(report) && /bridge：/.test(report) && /\/status：/.test(report) && /IBERR\./.test(report), report && report.slice(0, 200));
    const reportLeaks = Object.keys(SECRETS).filter(k => report.indexOf(SECRETS[k]) !== -1);
    check('J3) 报告密钥扫描通过（sk-/Bearer/JWT/query/Cookie/prompt/聊天正文）', reportLeaks.length === 0, reportLeaks);
    check('J4) 报告不含 apiKey 值', report.indexOf(GOOD_KEY) === -1 && report.indexOf(BAD_KEY) === -1);
    check('J5) 报告说明未导出本地日志文件', /未导出本地日志文件/.test(report));

    /* ── 9) 密钥 / 异常不出现在 console ── */
    const joined = consoleText.join('\n') + '\n' + pageErrors.join('\n');
    check('L1) console / 异常里没有出现任何密钥或注入内容', [GOOD_KEY, BAD_KEY].concat(Object.keys(SECRETS).map(k => SECRETS[k])).every(s => joined.indexOf(s) === -1),
      [GOOD_KEY, BAD_KEY].concat(Object.keys(SECRETS).map(k => SECRETS[k])).filter(s => joined.indexOf(s) !== -1).map(s => s.slice(0, 16)));
    check('L2) 无未捕获页面异常', pageErrors.length === 0, pageErrors.join(' | '));
  } finally {
    if (cdp) cdp.close();
    try { browser.kill(); } catch (e) { }
    await new Promise(r => {
      if (!browser || browser.exitCode !== null || browser.signalCode) return r();
      const fallback = setTimeout(r, 5000);
      browser.once('exit', () => { clearTimeout(fallback); r(); });
    });
    await new Promise(r => { const t = setTimeout(r, 2000); webSrv.close(() => { clearTimeout(t); r(); }); });
    await bridge.down();
    await active.close();
    await restart.close();
    await new Promise(r => { const t = setTimeout(r, 2000); mockProvider.server.close(() => { clearTimeout(t); r(); }); });
    try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch (e) { console.log('  (note) temp profile left behind (not a failure): ' + profile); }
    try { fs.rmSync(tmpStateDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch (e) { }
    if (prevStateDir === undefined) delete process.env.IB_BOOT_STATE_DIR; else process.env.IB_BOOT_STATE_DIR = prevStateDir;
  }

  clearTimeout(watchdog);
  console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
  process.exitCode = fail ? 1 : 0;
  setTimeout(() => {
    console.error('\nLEAK: event loop still alive 5s after the smoke finished — unreleased resources: ' +
      (process.getActiveResourcesInfo ? process.getActiveResourcesInfo().join(',') : 'n/a'));
    process.exit(2);
  }, 5000).unref();
})().catch(e => {
  console.error('UNEXPECTED FAILURE: ' + (e && e.stack || e));
  process.exitCode = 1;
});
