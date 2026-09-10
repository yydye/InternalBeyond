'use strict';

/*
 * P4 · 首次设置向导端到端 smoke（真实 Chrome/Edge + CDP + 真实 HTTP 服务）
 *
 * 目标：在干净 profile（无 IndexedDB 数据）上，用「一个完全不懂编程的用户」
 * 的路径走完向导，并真正发出第一条消息（不是只验证「保存成功」）。
 *
 * 覆盖验收场景：
 *   1  全新用户 → 自动出现向导
 *   2  选择 provider → 模型/地址字段随 provider-directory 变化
 *   3  正确 API Key → 测试连接成功
 *   4  错误 Key → P3 用户友好错误（无状态码/地址/密钥）
 *   5  创建角色 → 落入现有 apiConfigs（IndexedDB 持久化）
 *   6  完成 → ibSetupV1Done 写入
 *   7  刷新 → 不重复强制出现
 *   8  中途 Esc 关闭 + 刷新 → 草稿保留、密钥不落盘、可继续
 *   9  Skip → 主界面可用，且可重新打开向导
 *  10  degraded 启动 → 向导仍可用（连接测试仍成功）
 *  11  API Key 不进 console / 不进错误详情 / 不进任何持久化
 *  12  小屏幕基础可用（无横向溢出）
 *  13  完成后真正发送第一条消息并收到回复
 *
 * Run: node test_setup_wizard_smoke.js
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');
const crypto = require('crypto');

const WEB = require('./services/internal-beyond-server.js');
const ROOT = __dirname;

const GOOD_KEY = 'sk-smoke-ok-123456';
const BAD_KEY = 'sk-smoke-bad-abcdef';
const DRAFT_KEY_TEXT = 'sk-draft-secret-xyz';
const MOCK_REPLY = '收到，这是第一条回复。';

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
function httpJson(url, method) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method: method || 'GET', headers: { Connection: 'close' } }, res => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', c => { raw += c; });
      res.on('end', () => { let json = null; try { json = JSON.parse(raw); } catch (e) { } resolve({ ok: res.statusCode < 400, status: res.statusCode, json: json, raw: raw }); });
    });
    req.on('error', reject);
    req.setTimeout(3000, () => { req.destroy(); reject(new Error('timeout ' + url)); });
    req.end();
  });
}

/* Minimal CDP client (same subset as test_error_ui_smoke.js / test_boot_smoke.js). */
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
      const timer = setTimeout(() => { if (this.p.has(id)) { this.p.delete(id); rej(new Error('timeout ' + m)); } }, 25000);
      this.p.set(id, {
        res: v => { clearTimeout(timer); res(v); },
        rej: e => { clearTimeout(timer); rej(e); }
      });
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
    await new Promise(r => setTimeout(r, 120));
  }
  return false;
}
/* 页面内赋值 + 触发 input 事件（与真人输入一致） */
function setVal(id, v) {
  return `(function(){var el=document.getElementById(${JSON.stringify(id)});el.value=${JSON.stringify(v)};el.dispatchEvent(new Event('input',{bubbles:true}));return el.value;})()`;
}
function clickSel(sel) {
  return `(function(){var el=document.querySelector(${JSON.stringify(sel)});if(!el)return false;el.click();return true;})()`;
}

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (detail !== undefined ? ' — ' + JSON.stringify(detail) : '')); }
}

/* ── mock provider：OpenAI 兼容（非流式 + SSE 两种），可校验密钥 ── */
function startMockProvider() {
  return new Promise((resolve) => {
    const state = { okCount: 0, failCount: 0, bodies: [], chatCount: 0 };
    const server = http.createServer((req, res) => {
      const cors = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
        'Access-Control-Allow-Headers': '*'
      };
      if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
      if (req.method !== 'POST' || req.url.indexOf('/chat/completions') === -1) {
        res.writeHead(404, Object.assign({ 'Content-Type': 'application/json' }, cors));
        res.end(JSON.stringify({ error: 'not found' }));
        return;
      }
      const chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => {
        let body = {};
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) { }
        state.bodies.push(body);
        const auth = String(req.headers.authorization || '');
        if (auth !== 'Bearer ' + GOOD_KEY) {
          state.failCount++;
          res.writeHead(401, Object.assign({ 'Content-Type': 'application/json' }, cors));
          res.end(JSON.stringify({ error: { message: 'Incorrect API key provided', type: 'invalid_request_error', code: 'invalid_api_key' } }));
          return;
        }
        state.okCount++;
        if (body.stream) {
          state.chatCount++;
          res.writeHead(200, Object.assign({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' }, cors));
          const pieces = [MOCK_REPLY.slice(0, 4), MOCK_REPLY.slice(4)];
          pieces.forEach(p => res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: p }, finish_reason: null }] }) + '\n\n'));
          res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 6 } }) + '\n\n');
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        }
        res.writeHead(200, Object.assign({ 'Content-Type': 'application/json' }, cors));
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1 } }));
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, state }));
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const watchdog = setTimeout(() => {
    console.error('\nWATCHDOG: setup wizard smoke exceeded 180s — unreleased resources: ' +
      (process.getActiveResourcesInfo ? process.getActiveResourcesInfo().join(',') : 'n/a'));
    process.exit(1);
  }, 180000);
  watchdog.unref();

  console.log('P4 · 首次设置向导 smoke（真实 Chrome + 真实 HTTP）\n');

  const chrome = chromePath();
  if (!chrome) {
    console.log('  ⊘ skipped: no Chrome / Edge found');
    clearTimeout(watchdog);
    process.exitCode = 0;
    return;
  }

  const mock = await startMockProvider();
  const mockEndpoint = 'http://127.0.0.1:' + mock.port + '/v1/chat/completions';
  const webSrv = WEB.createWebServer({ port: 0, root: ROOT });
  const webPort = await new Promise((res, rej) => { webSrv.once('error', rej); webSrv.listen(0, '127.0.0.1', () => res(webSrv.address().port)); });
  const pageUrl = 'http://127.0.0.1:' + webPort + '/InternalBeyond.html';

  const cdpPort = await freePort();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-p4-chrome-'));
  const browser = spawn(chrome, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    '--force-color-profile=srgb', '--window-size=1200,860',
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

    const tab = (await httpJson('http://127.0.0.1:' + cdpPort + '/json/new?' + encodeURIComponent(pageUrl), 'PUT')).json;
    cdp = await Cdp.connect(tab.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    cdp.on('Runtime.exceptionThrown', p => pageErrors.push(String((p.exceptionDetails && p.exceptionDetails.text) || 'exception')));
    cdp.on('Runtime.consoleAPICalled', p => {
      const parts = (p.args || []).map(a => (a.value !== undefined ? String(a.value) : String(a.description || '')));
      consoleText.push(parts.join(' '));
    });

    /* ── 进入站点（splash → 跳过，直接探索） ── */
    const patchDialogs = () => ev(cdp, "window.confirm=function(){return true;};window.alert=function(){};true");
    const enterSite = async () => {
      await wait(cdp, "document.readyState==='complete' && !!document.getElementById('splash')", 25000);
      await patchDialogs();
      await ev(cdp, "(function(){var s=document.getElementById('splash-skip');if(s)s.click();else if(typeof enterSite==='function')enterSite();return true;})()");
    };
    await enterSite();
    check('A1) 模块已挂载且 splash 后自动出现向导', await wait(cdp, "!!window.IBSetup && !!document.querySelector('#ib-setup.is-open')", 20000));
    check('A2) 主界面同时可见（向导不是唯一入口）', await wait(cdp, "!!document.getElementById('app') && document.getElementById('app').classList.contains('visible')", 12000));

    /* ── 场景 1/12：首启欢迎文案 + 小屏幕可用 ── */
    const welcome = await ev(cdp, `(()=>{
      const body=document.getElementById('ib-setup-body');
      return {step:document.getElementById('ib-setup-step').textContent, title:document.getElementById('ib-setup-title').textContent, text:body.textContent};
    })()`);
    check('B1) 第 1 步文案含「几分钟完成第一次设置，不需要编程知识。」', welcome && welcome.text.indexOf('几分钟完成第一次设置，不需要编程知识。') !== -1, welcome && welcome.text.slice(0, 80));
    check('B2) 欢迎页无开发者术语', welcome && ['Node.js', 'Bridge', '端口', 'localhost', 'IndexedDB', 'ws://', '127.0.0.1'].every(w => welcome.text.indexOf(w) === -1), welcome && welcome.text);
    check('B3) 步骤计数 = 第 1 步 / 共 7 步', welcome && welcome.step === '第 1 步 / 共 7 步', welcome && welcome.step);

    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 360, height: 640, deviceScaleFactor: 2, mobile: true });
    await sleep(300);
    const small = await ev(cdp, `(()=>{
      const card=document.querySelector('#ib-setup .ib-setup-card');
      const r=card.getBoundingClientRect();
      return {docW:document.documentElement.scrollWidth, cardW:r.width, cardBottom:r.bottom, vh:window.innerHeight,
        bodyOverflow:getComputedStyle(document.getElementById('ib-setup-body')).overflowY,
        nextVisible:document.getElementById('ib-setup-next').getBoundingClientRect().bottom<=window.innerHeight+1};
    })()`);
    check('B4) 小屏幕无横向溢出', small && small.docW <= 361, small && small.docW);
    check('B5) 小屏幕卡片在视口内且内容可滚动', small && small.cardW <= 360 && small.bodyOverflow === 'auto', small);
    await cdp.send('Emulation.clearDeviceMetricsOverride');
    await sleep(200);

    /* 深色主题（Infernal）下可读：文字使用深色主题内容色，且「遮罩 + 卡片表面」合成后对比度 >= 4.5 */
    await ev(cdp, "document.body.classList.add('theme-infernal');true");
    await sleep(700);
    const dark = await ev(cdp, `(()=>{
      const card=document.querySelector('#ib-setup .ib-setup-card');
      const overlay=document.getElementById('ib-setup');
      const title=document.getElementById('ib-setup-title');
      const body=document.getElementById('ib-setup-body');
      const parse=c=>{const m=String(c).match(/[0-9]*\\.?[0-9]+/g)||[0,0,0,1];return [Number(m[0]),Number(m[1]),Number(m[2]),m[3]===undefined?1:Number(m[3])]};
      const over=(fg,bg)=>{const a=fg[3];return [fg[0]*a+bg[0]*(1-a),fg[1]*a+bg[1]*(1-a),fg[2]*a+bg[2]*(1-a),1]};
      const lum=c=>{const f=v=>{v/=255;return v<=0.03928?v/12.92:Math.pow((v+0.055)/1.055,2.4)};return 0.2126*f(c[0])+0.7152*f(c[1])+0.0722*f(c[2])};
      const ratio=(a,b)=>{const l1=lum(a),l2=lum(b);return (Math.max(l1,l2)+0.05)/(Math.min(l1,l2)+0.05)};
      /* 深色主题基色 --bg-deep:#181e32 → 遮罩 → 卡片表面，逐层 alpha 合成 */
      const bg=over(parse(getComputedStyle(card).backgroundColor), over(parse(getComputedStyle(overlay).backgroundColor), [24,30,50,1]));
      return {dark:document.body.classList.contains('theme-infernal'),
        titleColor:getComputedStyle(title).color, bodyColor:getComputedStyle(body).color,
        cardBg:getComputedStyle(card).backgroundColor,
        title:ratio(parse(getComputedStyle(title).color),bg), body:ratio(parse(getComputedStyle(body).color),bg)};
    })()`);
    check('B6) 深色主题：文字用深色主题内容色', dark && dark.dark === true && dark.titleColor === 'rgb(224, 230, 242)' && dark.bodyColor === 'rgb(173, 184, 208)', dark);
    check('B7) 深色主题：合成背景上对比度 >= 4.5', dark && dark.title >= 4.5 && dark.body >= 4.5, dark);
    await ev(cdp, "document.body.classList.remove('theme-infernal');true");
    await sleep(400);

    /* ── 场景 2：provider 来自 provider-directory，切换即改字段 ── */
    await ev(cdp, clickSel('#ib-setup-next'));
    await wait(cdp, "!!document.querySelector('.ib-setup-provider')", 5000);
    const provStep = await ev(cdp, `(()=>{
      const names=Array.prototype.map.call(document.querySelectorAll('.ib-setup-provider-name'),n=>n.textContent);
      const dir=window.PROVIDERS_DIR.PROVIDERS;
      const dirNames=Object.keys(dir).map(k=>dir[k].name);
      return {count:names.length, names:names, missing:dirNames.filter(n=>names.indexOf(n)===-1)};
    })()`);
    check('C1) provider 卡片数 = provider-directory 条目数', provStep && provStep.count === Object.keys(await ev(cdp, 'window.PROVIDERS_DIR.PROVIDERS')).length, provStep);
    check('C2) provider 名称全部来自 provider-directory', provStep && provStep.missing.length === 0, provStep && provStep.missing);
    await ev(cdp, "document.querySelector('.ib-setup-provider[data-provider=\"openai\"]').click()");
    const afterOpenai = await ev(cdp, "(()=>{const s=window.IBSetup.state();const p=window.PROVIDERS_DIR.PROVIDERS.openai;return {model:s.model,endpoint:s.endpoint,pm:p.model,pe:p.endpoint};})()");
    check('C3) 选 OpenAI → 模型/地址取 provider-directory 默认值', afterOpenai && afterOpenai.model === afterOpenai.pm && afterOpenai.endpoint === afterOpenai.pe, afterOpenai);
    await ev(cdp, "document.querySelector('.ib-setup-provider[data-provider=\"custom\"]').click()");
    const afterCustom = await ev(cdp, "(()=>{const s=window.IBSetup.state();return {model:s.model,endpoint:s.endpoint};})()");
    check('C4) 选自定义 → 清空模型/地址（不残留上一个 provider 的值）', afterCustom && afterCustom.model === '' && afterCustom.endpoint === '', afterCustom);

    /* ── 场景 8：中途 Esc 关闭 → 草稿保留（无密钥）→ 刷新后继续 ── */
    await ev(cdp, clickSel('#ib-setup-next'));
    await wait(cdp, "!!document.getElementById('ib-setup-key')", 5000);
    await ev(cdp, setVal('ib-setup-key', DRAFT_KEY_TEXT));
    const keyMask = await ev(cdp, "(()=>{const i=document.getElementById('ib-setup-key');const t0=i.type;document.querySelector('.ib-setup-reveal').click();const t1=i.type;document.querySelector('.ib-setup-reveal').click();const t2=i.type;return {t0,t1,t2};})()");
    check('D1) 密钥默认遮挡，可显示/隐藏', keyMask && keyMask.t0 === 'password' && keyMask.t1 === 'text' && keyMask.t2 === 'password', keyMask);
    await ev(cdp, "document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
    check('D2) Esc 关闭向导', await wait(cdp, "!document.querySelector('#ib-setup.is-open')", 5000));
    await wait(cdp, "(async()=>!!(await dbGet('apiSettings','ibSetupV1Draft')))()", 5000);
    const draft = await ev(cdp, `(async()=>{
      const d=await dbGet('apiSettings','ibSetupV1Draft');
      const all=await dbGetAll('apiSettings');
      return {draft:JSON.stringify(d||null), all:JSON.stringify(all), ls:JSON.stringify(Object.keys(localStorage||{}).map(k=>[k,String(localStorage.getItem(k))]))};
    })()`);
    check('D3) 草稿已保存', draft && draft.draft.indexOf('"provider":"custom"') !== -1, draft && draft.draft);
    check('D4) 草稿不含密钥（记录里没有 apiKey 键）', draft && draft.draft.indexOf('apiKey') === -1, draft && draft.draft);
    check('D5) 任何持久化层都找不到草稿里的密钥', draft && draft.all.indexOf(DRAFT_KEY_TEXT) === -1 && draft.ls.indexOf(DRAFT_KEY_TEXT) === -1);
    await cdp.send('Page.reload');
    await sleep(800);
    await enterSite();
    check('D6) 刷新后自动继续（草稿生效）', await wait(cdp, "!!document.querySelector('#ib-setup.is-open') && document.getElementById('ib-setup-step').textContent==='第 3 步 / 共 7 步'", 20000));
    const resumed = await ev(cdp, "(()=>{const s=window.IBSetup.state();const i=document.getElementById('ib-setup-key');return {provider:s.provider,step:s.step,keyValue:i?i.value:null,restored:s.draftRestored};})()");
    check('D7) 恢复到第 3 步且密钥为空（需重新输入）', resumed && resumed.provider === 'custom' && resumed.step === 2 && resumed.keyValue === '' && resumed.restored === true, resumed);

    /* ── 场景 4：错误密钥 → P3 用户友好错误 ── */
    await ev(cdp, setVal('ib-setup-key', BAD_KEY));
    await ev(cdp, clickSel('#ib-setup-next'));
    await wait(cdp, "!!document.getElementById('ib-setup-model')", 5000);
    await ev(cdp, setVal('ib-setup-model', 'smoke-model'));
    await ev(cdp, "(function(){var b=document.querySelector('.ib-setup-adv-btn');if(b)b.click();return true;})()");
    await ev(cdp, setVal('ib-setup-endpoint', mockEndpoint));
    await ev(cdp, clickSel('#ib-setup-next'));
    check('E0) 进入测试连接步骤', await wait(cdp, "!!document.getElementById('ib-setup-run-test')", 5000));
    await ev(cdp, clickSel('#ib-setup-run-test'));
    check('E1) 错误密钥 → 出现 P3 错误卡片', await wait(cdp, "!!document.querySelector('#ib-setup-testbox .ib-setup-msg.is-err')", 20000));
    const errCard = await ev(cdp, `(()=>{
      const card=document.querySelector('#ib-setup-testbox .ib-setup-msg.is-err');
      const det=card.querySelector('.ib-setup-err-details');
      const user=card.querySelector('.ib-setup-err-title').textContent+' '+card.querySelector('.ib-setup-err-message').textContent+' '+card.querySelector('.ib-setup-err-suggestion').textContent;
      return {user:user, detailsOpen:det.classList.contains('is-open'), details:det.textContent,
        buttons:Array.prototype.map.call(card.querySelectorAll('.ib-setup-mini'),b=>b.textContent)};
    })()`);
    const LEAKS = ['401', '127.0.0.1', 'http://', 'sk-', 'Bearer', 'invalid_api_key', 'Incorrect API key'];
    check('E2) 普通提示不含状态码/地址/密钥/原始 body', errCard && LEAKS.every(x => errCard.user.indexOf(x) === -1), errCard && errCard.user);
    check('E3) 技术详情默认收起', errCard && errCard.detailsOpen === false);
    check('E4) 详情已脱敏（含 HTTP 状态，不含密钥）', errCard && errCard.details.indexOf('HTTP 状态：401') !== -1 && errCard.details.indexOf(BAD_KEY) === -1, errCard && errCard.details.slice(0, 200));
    check('E5) 提供「再试一次」', errCard && errCard.buttons.indexOf('再试一次') !== -1, errCard && errCard.buttons);
    check('E6) mock 收到 1 次失败请求', mock.state.failCount === 1 && mock.state.okCount === 0, { fail: mock.state.failCount, ok: mock.state.okCount });

    /* ── 场景 3：正确密钥 → 测试成功 ── */
    await ev(cdp, clickSel('#ib-setup-back'));
    await wait(cdp, "!!document.getElementById('ib-setup-model')", 5000);
    await ev(cdp, clickSel('#ib-setup-back'));
    await wait(cdp, "!!document.getElementById('ib-setup-key')", 5000);
    await ev(cdp, setVal('ib-setup-key', GOOD_KEY));
    await ev(cdp, clickSel('#ib-setup-next'));
    await wait(cdp, "!!document.getElementById('ib-setup-model')", 5000);
    await ev(cdp, clickSel('#ib-setup-next'));
    check('F0) 修改密钥后回到测试步骤（上一次结论已失效）', await wait(cdp, "!!document.getElementById('ib-setup-run-test')", 8000));
    await ev(cdp, clickSel('#ib-setup-run-test'));
    check('F1) 正确密钥 → 「连接成功，可以使用。」', await wait(cdp, "(()=>{const m=document.querySelector('#ib-setup-testbox .ib-setup-msg.is-ok');return !!m && m.textContent.indexOf('连接成功，可以使用。')!==-1;})()", 20000));
    const testBody = mock.state.bodies[mock.state.bodies.length - 1];
    check('F2) 测试请求走真实链路且极小（单条 user 消息）', !!testBody && Array.isArray(testBody.messages) && testBody.messages.length === 1 && testBody.messages[0].role === 'user' && testBody.stream !== true, testBody && Object.keys(testBody));
    check('F3) 测试请求不含系统提示词/工具', !!testBody && !testBody.tools && testBody.messages.length === 1);

    /* ── 场景 5：创建角色 → 落入现有 apiConfigs ── */
    await ev(cdp, clickSel('#ib-setup-next'));
    await wait(cdp, "!!document.getElementById('ib-setup-name')", 5000);
    await ev(cdp, setVal('ib-setup-name', 'SmokeAI'));
    await ev(cdp, setVal('ib-setup-rel', '测试伙伴'));
    await ev(cdp, setVal('ib-setup-desc', '说话简短。'));
    const promptSynced = await ev(cdp, "(()=>{const b=document.querySelector('.ib-setup-adv-btn');if(b)b.click();const t=document.getElementById('ib-setup-prompt');return t?t.value:'';})()");
    check('G1) 角色描述自动写入「角色设定」', typeof promptSynced === 'string' && promptSynced.indexOf('说话简短。') !== -1, promptSynced && promptSynced.slice(-40));
    await ev(cdp, clickSel('#ib-setup-next'));
    check('G2) 角色创建成功并进入完成步骤', await wait(cdp, "!!document.querySelector('.ib-setup-summary-row') && document.getElementById('ib-setup-title').textContent==='设置完成'", 20000));
    const saved = await ev(cdp, `(async()=>{
      const list=window.apiConfigs||[];
      const c=list[0]||null;
      const persisted=c?await dbGet('apiConfigs',c.id):null;
      return {count:list.length, cfg:c, persisted:persisted};
    })()`);
    check('G3) apiConfigs 里恰好 1 个角色', saved && saved.count === 1, saved && saved.count);
    check('G4) 角色字段走现有保存链（provider/model/endpoint/key/关系）', !!saved && !!saved.cfg &&
      saved.cfg.provider === 'custom' && saved.cfg.model === 'smoke-model' && saved.cfg.endpoint === mockEndpoint &&
      saved.cfg.apiKey === GOOD_KEY && saved.cfg.nickname === 'SmokeAI' && saved.cfg.relationship === '测试伙伴', saved && saved.cfg);
    check('G5) 系统提示词 = 默认设定 + 描述', !!saved && !!saved.cfg && String(saved.cfg.systemPrompt || '').indexOf('说话简短。') !== -1 && String(saved.cfg.systemPrompt || '').length > 20, saved && saved.cfg && saved.cfg.systemPrompt);
    check('G6) 已落 IndexedDB（不只是内存）', !!saved && !!saved.persisted && saved.persisted.apiKey === GOOD_KEY);
    check('G7) 角色 id 沿用 friend_ 前缀', !!saved && !!saved.cfg && String(saved.cfg.id).indexOf('friend_') === 0, saved && saved.cfg && saved.cfg.id);

    /* ── 场景 6/7/13：完成 → ibSetupV1Done → 进入聊天 → 发出第一条消息 ── */
    await ev(cdp, clickSel('#ib-setup-next'));
    check('H1) 向导关闭', await wait(cdp, "!document.querySelector('#ib-setup.is-open')", 8000));
    const doneRec = await ev(cdp, "(async()=>{const d=await dbGet('apiSettings','ibSetupV1Done');const dr=await dbGet('apiSettings','ibSetupV1Draft');return {done:JSON.stringify(d||null),draft:dr?1:0,page:typeof currentPage!=='undefined'?currentPage:'',friend:(window.activeFriendId||'')};})()");
    check('H2) ibSetupV1Done = done:true / skipped:false', doneRec && doneRec.done.indexOf('"done":true') !== -1 && doneRec.done.indexOf('"skipped":false') !== -1, doneRec && doneRec.done);
    check('H3) 草稿已清除', doneRec && doneRec.draft === 0);
    check('H4) 自动进入 Chat 页', doneRec && doneRec.page === 'chat', doneRec && doneRec.page);
    check('H5) 自动选中刚创建的角色', doneRec && doneRec.friend === saved.cfg.id, doneRec && doneRec.friend);
    check('H6) 聊天区显示该角色', await wait(cdp, "(()=>{const h=document.getElementById('chat-full-messages');return !!h && h.textContent.indexOf('SmokeAI')!==-1;})()", 8000));

    await ev(cdp, setVal('chat-full-input', '你好'));
    await ev(cdp, clickSel('#chat-send-full'));
    check('H7) 第一条消息：用户气泡出现', await wait(cdp, "(()=>{const m=document.getElementById('chat-full-messages');return !!m && m.textContent.indexOf('你好')!==-1;})()", 10000));
    check('H8) 第一条消息：收到真实回复', await wait(cdp, "(()=>{const m=document.getElementById('chat-full-messages');return !!m && m.textContent.indexOf('" + MOCK_REPLY + "')!==-1;})()", 25000));
    const chatStored = await ev(cdp, `(async()=>{
      const all=await dbGetAll('chatMessages');
      return {user:all.filter(m=>m.role==='user'&&m.content==='你好').length,
        assistant:all.filter(m=>m.role==='assistant'&&String(m.content||'').indexOf('收到')!==-1).length};
    })()`);
    check('H9) 第一条消息已持久化（user + assistant）', chatStored && chatStored.user === 1 && chatStored.assistant >= 1, chatStored);
    check('H10) 回复来自 mock provider（流式链路）', mock.state.chatCount >= 1, mock.state.chatCount);

    /* ── 场景 7：刷新 → 不重复强制出现 ── */
    await cdp.send('Page.reload');
    await sleep(800);
    await enterSite();
    await sleep(2500);
    const afterReload = await ev(cdp, "({open:!!document.querySelector('#ib-setup.is-open'), done:(window.IBSetup?window.IBSetup.state():null)!==null})");
    check('I1) 刷新后向导不再自动出现', afterReload && afterReload.open === false, afterReload);

    /* ── 场景 9：Skip → 主界面可用 + 可重新打开 ── */
    await ev(cdp, "(async()=>{const c=window.apiConfigs[0];if(c&&window._hardDeleteApiConfig)await window._hardDeleteApiConfig(c.id);return true;})()");
    await ev(cdp, "window.loadFriendsList&&window.loadFriendsList()");
    check('J1) 没有角色时聊天区显示引导空状态', await wait(cdp, "!!document.getElementById('ib-setup-empty') && !!document.getElementById('ib-setup-start')", 8000));
    await ev(cdp, clickSel('#ib-setup-start'));
    check('J2) 「开始设置」可重新打开向导', await wait(cdp, "!!document.querySelector('#ib-setup.is-open')", 8000));
    await ev(cdp, clickSel('#ib-setup-skip'));
    check('J3) 跳过 → 向导关闭', await wait(cdp, "!document.querySelector('#ib-setup.is-open')", 8000));
    const skipRec = await ev(cdp, "(async()=>{const d=await dbGet('apiSettings','ibSetupV1Done');return {rec:JSON.stringify(d||null),empty:!!document.getElementById('ib-setup-empty'),start:!!document.getElementById('ib-setup-start')};})()");
    check('J4) Skip 记为 skipped:true（不是「永久完成」）', skipRec && skipRec.rec.indexOf('"skipped":true') !== -1, skipRec && skipRec.rec);
    check('J5) 跳过后台仍给出「开始设置」入口', skipRec && skipRec.empty === true && skipRec.start === true, skipRec);
    await ev(cdp, clickSel('#ib-setup-start'));
    check('J6) 跳过后仍可重新打开向导', await wait(cdp, "!!document.querySelector('#ib-setup.is-open')", 8000));
    await ev(cdp, "(function(){var b=document.getElementById('ib-setup-close');if(b)b.click();return true;})()");
    await wait(cdp, "!document.querySelector('#ib-setup.is-open')", 5000);

    /* ── 场景 10：degraded 启动 → 向导仍可用 ── */
    const bootState = await ev(cdp, "(async()=>{const r=await fetch('__boot-state');const j=await r.json();return {http:r.status,present:!!j.present};})()");
    check('K1) /__boot-state 真实可用', bootState && bootState.http === 200, bootState);
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `(function(){
        var of=window.fetch;
        window.fetch=function(u,o){
          try{
            if(String(u).indexOf('__boot-state')!==-1){
              return Promise.resolve(new Response(JSON.stringify({ok:true,present:true,stale:false,schema:'internalbeyond.boot-state',version:1,
                bootState:{overall:'degraded',degraded:true,components:{bridge:{healthy:false,state:'unhealthy',probed:true,reason:{category:'unreachable',message:'bridge unreachable'}}},
                degradedReasons:[{component:'bridge',category:'unreachable',message:'bridge unreachable'}]}}),
                {status:200,headers:{'Content-Type':'application/json'}}));
            }
          }catch(e){}
          return of.apply(this,arguments);
        };
      })();`
    });
    await cdp.send('Page.reload');
    await sleep(800);
    await enterSite();
    await sleep(1500);
    await ev(cdp, "(function(){var b=document.getElementById('ib-setup-rerun');if(b)b.click();return !!b;})()");
    check('K2) degraded 下向导仍可打开', await wait(cdp, "!!document.querySelector('#ib-setup.is-open')", 8000));
    const degraded = await ev(cdp, "(()=>{const d=document.querySelector('.ib-setup-degraded');return d?d.textContent:'';})()");
    check('K3) 显示 P3 用户文案（不暴露 bridge/端口）', !!degraded && degraded.indexOf('本地') !== -1 && degraded.indexOf('Bridge') === -1 && degraded.indexOf('127.0.0.1') === -1, degraded);
    /* degraded 下完整走一遍配置（不是只看提示）：选服务 → 填密钥 → 填模型/地址 → 测试连接 */
    await ev(cdp, "window.IBSetup.goStep(1)");
    await wait(cdp, "!!document.querySelector('.ib-setup-provider[data-provider=\"custom\"]')", 5000);
    await ev(cdp, "document.querySelector('.ib-setup-provider[data-provider=\"custom\"]').click()");
    await ev(cdp, "window.IBSetup.goStep(2)");
    await wait(cdp, "!!document.getElementById('ib-setup-key')", 5000);
    await ev(cdp, setVal('ib-setup-key', GOOD_KEY));
    await ev(cdp, "window.IBSetup.goStep(3)");
    await wait(cdp, "!!document.getElementById('ib-setup-model')", 5000);
    await ev(cdp, setVal('ib-setup-model', 'smoke-model'));
    await ev(cdp, "(function(){var b=document.querySelector('.ib-setup-adv-btn');if(b)b.click();return true;})()");
    await ev(cdp, setVal('ib-setup-endpoint', mockEndpoint));
    await ev(cdp, "window.IBSetup.goStep(4)");
    await wait(cdp, "!!document.getElementById('ib-setup-run-test')", 5000);
    await ev(cdp, clickSel('#ib-setup-run-test'));
    check('K4) degraded 下连接测试仍成功（不阻塞 API 配置）', await wait(cdp, "(()=>{const m=document.querySelector('#ib-setup-testbox .ib-setup-msg.is-ok');return !!m;})()", 20000));

    /* ── 场景 11：密钥不进 console ── */
    const joined = consoleText.join('\n') + '\n' + pageErrors.join('\n');
    check('L1) console / 异常里没有出现任何密钥', joined.indexOf(GOOD_KEY) === -1 && joined.indexOf(BAD_KEY) === -1 && joined.indexOf(DRAFT_KEY_TEXT) === -1,
      [GOOD_KEY, BAD_KEY, DRAFT_KEY_TEXT].filter(k => joined.indexOf(k) !== -1));
    check('L2) 无未捕获页面异常', pageErrors.length === 0, pageErrors.join(' | '));
  } finally {
    if (cdp) cdp.close();
    try { browser.kill(); } catch (e) { }
    await new Promise(r => {
      if (!browser || browser.exitCode !== null || browser.signalCode) return r();
      const fallback = setTimeout(r, 5000);
      browser.once('exit', () => { clearTimeout(fallback); r(); });
    });
    await new Promise(r => { const fallback = setTimeout(r, 2000); webSrv.close(() => { clearTimeout(fallback); r(); }); });
    await new Promise(r => { const fallback = setTimeout(r, 2000); mock.server.close(() => { clearTimeout(fallback); r(); }); });
    try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); }
    catch (e) { console.log('  (note) temp dir left behind (not a failure): ' + profile); }
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
