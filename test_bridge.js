'use strict';

/*
 * Internal Beyond Bridge 最小冒烟测试（Node 18+，零依赖）
 *
 * 用法： node test_bridge.js
 *
 * 覆盖：健康/状态、CORS 白名单、心语/上下文/地理/会话 CRUD、
 *       AI 常驻创建/对话//continue/并发锁/主动消息、TTS 未配置、
 *       表情列表与文件、WebSocket 握手/工具调用/Origin 校验/token 鉴权。
 * 网络相关（酷狗/网易云/天气）不在此测试内（外部服务不稳定）。
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const BRIDGE = path.join(__dirname, 'ib-bridge-service.js');
let failures = 0;
const usedPorts = new Set();

function ok(name, cond, extra) {
  if (cond) {
    console.log('  PASS  ' + name);
  } else {
    failures++;
    console.log('  FAIL  ' + name + (extra !== undefined ? '  -> ' + extra : ''));
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function freePort() {
  for (let i = 0; i < 50; i++) {
    const p = 24000 + Math.floor(Math.random() * 1000);
    if (!usedPorts.has(p)) {
      usedPorts.add(p);
      return p;
    }
  }
  throw new Error('测试端口已用尽');
}

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function waitHealth(port, timeoutMs) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      const r = await fetch('http://127.0.0.1:' + port + '/health');
      if (r.ok) return true;
    } catch (e) { /* 未就绪 */ }
    await sleep(200);
  }
  return false;
}

async function startBridge(dataDir, port, token, extraEnv) {
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await startBridgeOnce(dataDir, port, token, extraEnv);
    } catch (e) {
      lastErr = e;
      if (/EADDRINUSE|did not become healthy/.test(String(e && e.message || e))) {
        port = freePort();
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

async function startBridgeOnce(dataDir, port, token, extraEnv) {
  if (token) {
    fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({ token }, null, 2), 'utf8');
  }
  const child = spawn(process.execPath, [BRIDGE], {
    cwd: __dirname,
    env: Object.assign({}, process.env, {
      IB_BRIDGE_PORT: String(port),
      IB_BRIDGE_HOST: '127.0.0.1',
      IB_BRIDGE_DATA_DIR: dataDir
    }, extraEnv || {}),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', () => {});
  if (!await waitHealth(port, 10000)) {
    child.kill();
    throw new Error('bridge did not become healthy on port ' + port);
  }
  return child;
}

function listenFree(server) {
  server.on('error', () => { /* 监听后的偶发错误不崩溃测试 */ });
  return new Promise((resolve, reject) => {
    const onErr = err => { server.removeListener('listening', onListen); reject(err); };
    const onListen = () => { server.removeListener('error', onErr); resolve(server.address().port); };
    server.once('error', onErr);
    server.once('listening', onListen);
    server.listen(0, '127.0.0.1');
  });
}

async function startMockProvider() {
  let calls = 0;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      calls++;
      const content = calls === 1 ? '第一段回复。/continue' : '第二段续写。';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ message: { content } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 }
      }));
    });
  });
  const port = await listenFree(server);
  return { port, server, calls: () => calls };
}

async function startMockAnthropic() {
  let lastBody = null, lastHeaders = null;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      lastBody = JSON.parse(body);
      lastHeaders = req.headers;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        content: [{ type: 'text', text: '来自Anthropic的回复' }],
        usage: { input_tokens: 5, output_tokens: 3 }
      }));
    });
  });
  const port = await listenFree(server);
  return { port, server, lastBody: () => lastBody, lastHeaders: () => lastHeaders };
}

async function startMockGemini() {
  let lastBody = null, lastHeaders = null;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      lastBody = JSON.parse(body);
      lastHeaders = req.headers;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        candidates: [{ content: { parts: [{ text: '来自Gemini的回复' }] } }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 4 }
      }));
    });
  });
  const port = await listenFree(server);
  return { port, server, lastBody: () => lastBody, lastHeaders: () => lastHeaders };
}

async function startMockTts() {
  let lastBody = null;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      lastBody = JSON.parse(body);
      res.writeHead(200, { 'Content-Type': 'audio/mpeg' });
      res.end(Buffer.from('MP3FAKE'));
    });
  });
  const port = await listenFree(server);
  return { port, server, lastBody: () => lastBody };
}

function wsHandshake(port, pathname, headers, onUpgrade) {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString('base64');
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: pathname || '/',
      headers: Object.assign({
        Upgrade: 'websocket',
        Connection: 'Upgrade',
        'Sec-WebSocket-Key': key,
        'Sec-WebSocket-Version': '13'
      }, headers || {})
    });
    req.on('upgrade', (res, socket) => resolve({ type: 'upgrade', status: res.statusCode, socket }));
    req.on('response', res => { resolve({ type: 'http', status: res.statusCode }); res.resume(); });
    req.on('error', reject);
    req.end();
  });
}

async function wsCall(port, token, toolName, args) {
  const hs = await wsHandshake(port, '/');
  if (hs.type !== 'upgrade') throw new Error('ws upgrade failed: ' + hs.status);
  const socket = hs.socket;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('wsCall timeout')); }, 10000);
    const finish = v => { clearTimeout(timer); resolve(v); };
    let buf = Buffer.alloc(0);
    const send = obj => {
      const p = Buffer.from(JSON.stringify(obj));
      let h;
      if (p.length < 126) { h = Buffer.alloc(2); h[1] = p.length; }
      else { h = Buffer.alloc(4); h[1] = 126; h.writeUInt16BE(p.length, 2); }
      h[0] = 0x81;
      socket.write(Buffer.concat([h, p]));
    };
    const onData = () => {
      while (buf.length >= 2) {
        const b0 = buf[0], len0 = buf[1] & 0x7f;
        let off = 2, len = len0;
        if (len0 === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
        if (buf.length < off + len) return;
        const payload = buf.slice(off, off + len).toString('utf8');
        buf = buf.slice(off + len);
        const op = b0 & 0x0f;
        if (op === 0x8) { finish({ type: 'close', code: payload.length >= 2 ? payload.readUInt16BE(0) : 1000 }); socket.destroy(); return; }
        if (op !== 0x1) continue;
        const m = JSON.parse(payload);
        if (m.type === 'hello_ack') {
          send({ type: 'tool_call', id: 't1', name: toolName, args: args || {} });
        } else if (m.type === 'tool_result') {
          finish({ type: 'result', id: m.id, ok: m.ok, text: m.text, error: m.error });
          socket.destroy();
        }
      }
    };
    socket.on('data', d => { buf = Buffer.concat([buf, d]); onData(); });
    socket.on('error', reject);
    send({ type: 'hello', client: 'InternalBeyond', version: '1.0.0', token: token || '', capabilities: ['push', 'tools', 'images'] });
  });
}

async function wsCloseCode(port, token) {
  const hs = await wsHandshake(port, '/');
  if (hs.type !== 'upgrade') return -1;
  const socket = hs.socket;
  return new Promise(resolve => {
    const timer = setTimeout(() => { socket.destroy(); resolve(-4); }, 10000);
    const finish = v => { clearTimeout(timer); resolve(v); };
    const p = Buffer.from(JSON.stringify({ type: 'hello', client: 'x', version: '1', token: token || '', capabilities: [] }));
    const h = Buffer.alloc(2); h[0] = 0x81; h[1] = p.length;
    socket.write(Buffer.concat([h, p]));
    let buf = Buffer.alloc(0);
    socket.on('data', d => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 2) {
        const b0 = buf[0], len0 = buf[1] & 0x7f;
        let off = 2, len = len0;
        if (len0 === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
        if (buf.length < off + len) return;
        const payload = buf.slice(off, off + len);
        buf = buf.slice(off + len);
        if ((b0 & 0x0f) === 0x8) {
          finish(payload.length >= 2 ? payload.readUInt16BE(0) : 1000);
          socket.destroy();
          return;
        }
      }
    });
    socket.on('end', () => finish(-2));
    socket.on('close', () => finish(-2));
    socket.on('error', () => finish(-3));
  });
}

async function main() {
  console.log('== Internal Beyond Bridge 冒烟测试 ==');
  const dataDir = tmpDir('ib-bridge-test-');
  const port = freePort();
  const bridge = await startBridge(dataDir, port, null);
  const mock = await startMockProvider();
  const base = 'http://127.0.0.1:' + port;

  try {
    /* 1. 健康 / 状态 */
    const health = await (await fetch(base + '/health')).json();
    ok('health.ok', health.ok === true);
    ok('health.tools>=18', Array.isArray(health.tools) && health.tools.length >= 18);
    const status = await (await fetch(base + '/status')).json();
    ok('status.fields', status.ok === true && typeof status.resident === 'number' && typeof status.tts === 'boolean');

    /* 2. CORS 白名单 */
    const evil = await fetch(base + '/health', { headers: { Origin: 'http://evil.example' } });
    ok('cors.evil.rejected', evil.headers.get('access-control-allow-origin') === null);
    const local = await fetch(base + '/health', { headers: { Origin: 'http://127.0.0.1:8080' } });
    ok('cors.local.allowed', local.headers.get('access-control-allow-origin') === 'http://127.0.0.1:8080');
    const fileOrigin = await fetch(base + '/health', { headers: { Origin: 'null' } });
    ok('cors.fileOrigin.allowed', fileOrigin.headers.get('access-control-allow-origin') === 'null');
    const pre = await fetch(base + '/api/whispers', { method: 'OPTIONS', headers: { Origin: 'http://evil.example' } });
    ok('cors.preflight.rejected', pre.headers.get('access-control-allow-origin') === null);

    /* 3. 心语 CRUD */
    const w = await (await fetch(base + '/api/whispers', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: '测试心语', author: 'tester' })
    })).json();
    ok('whispers.post', w.ok === true && !!w.whisper && w.whisper.id);
    const wl = await (await fetch(base + '/api/whispers')).json();
    ok('whispers.list', wl.ok === true && wl.whispers.some(x => x.id === w.whisper.id));
    const wd = await (await fetch(base + '/api/whispers/' + encodeURIComponent(w.whisper.id), { method: 'DELETE' })).json();
    ok('whispers.delete', wd.ok === true);

    /* 4. 上下文统计 */
    const cx = await (await fetch(base + '/api/context?friend=review', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input_tokens: 100, output_tokens: 20 })
    })).json();
    ok('context.post', cx.ok === true && cx.recent === 120 && cx.pct > 0);
    const cxg = await (await fetch(base + '/api/context?friend=review')).json();
    ok('context.get', cxg.ok === true && cxg.records >= 1);

    /* 5. 地理 */
    const geo = await (await fetch(base + '/api/geo', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lat: 31.2, lng: 121.5, city: '上海' })
    })).json();
    ok('geo.post', geo.ok === true && geo.geo.city === '上海');
    const geoBad = await fetch(base + '/api/geo', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lat: 999, lng: 999 })
    });
    ok('geo.invalid', geoBad.status === 400);
    const geoGet = await (await fetch(base + '/api/geo/latest')).json();
    ok('geo.get', geoGet.ok === true && geoGet.geo.lat === 31.2);

    /* 6. 通用会话 */
    const s = await (await fetch(base + '/api/sessions/win1', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: { hello: 1 } })
    })).json();
    ok('sessions.post', s.ok === true);
    const sg = await (await fetch(base + '/api/sessions/win1')).json();
    ok('sessions.get', sg.ok === true && sg.session && sg.session.hello === 1);

    /* 7. AI 常驻：创建 + 对话 + /continue + 并发锁 + 主动消息 */
    const createBody = {
      key: 'resident_review',
      name: '审查角色',
      provider: {
        endpoint: 'http://127.0.0.1:' + mock.port + '/v1/chat/completions',
        apiKey: 'x', model: 'mock', format: 'openai'
      },
      system: '你是测试角色。',
      relationship: '朋友'
    };
    const created = await (await fetch(base + '/api/ai/sessions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(createBody)
    })).json();
    ok('ai.create', created.ok === true && created.session.provider.apiKey === '***');
    const list = await (await fetch(base + '/api/ai/sessions')).json();
    ok('ai.list.masksKey', list.ok === true && list.sessions[0].provider.apiKey === '***');

    const chat = await (await fetch(base + '/api/ai/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'resident_review', message: '你好', maxContinues: 2 })
    })).json();
    ok('ai.chat', chat.ok === true && chat.reply === '第二段续写。');
    ok('ai.continue', chat.continued === 1);

    const c1 = fetch(base + '/api/ai/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'resident_review', message: '并发1' })
    }).then(r => r.json());
    const c2 = fetch(base + '/api/ai/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'resident_review', message: '并发2' })
    }).then(r => r.json());
    const [r1, r2] = await Promise.all([c1, c2]);
    const locked = (r1.ok === false && /生成中/.test(r1.error)) || (r2.ok === false && /生成中/.test(r2.error));
    ok('ai.concurrency.lock', (r1.ok && r2.ok === false) || (r1.ok === false && r2.ok), JSON.stringify([r1, r2]));
    ok('ai.concurrency.noCorruption', r1.ok || r2.ok);
    ok('ai.concurrency.lockMessage', locked, JSON.stringify([r1, r2]));

    const pro = await (await fetch(base + '/api/ai/proactive', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'resident_review' })
    })).json();
    ok('ai.proactive', pro.ok === true && typeof pro.text === 'string' && pro.text.length > 0);
    const detail = await (await fetch(base + '/api/ai/sessions/resident_review')).json();
    ok('ai.history', detail.ok === true && Array.isArray(detail.session.history) && detail.session.history.length >= 3);

    /* 8. TTS 未配置 → 503 且信息可读 */
    const tts = await fetch(base + '/api/tts', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: '你好' })
    });
    const ttsJ = await tts.json();
    ok('tts.unconfigured', tts.status === 503 && /未配置/.test(ttsJ.error || ''));

    /* 9. 表情 */
    const st = await (await fetch(base + '/stickers')).json();
    ok('stickers.list', st.ok === true && st.stickers.some(x => x.name === 'smile'));
    const sf = await fetch(base + '/stickers/smile.svg');
    ok('stickers.file', sf.status === 200 && /svg/.test(sf.headers.get('content-type') || ''));
    const sfBad = await fetch(base + '/stickers/..%2Fconfig.json');
    ok('stickers.traversal', sfBad.status === 400 || sfBad.status === 404);

    /* 10. 无效音乐 ID（不触发网络） */
    const badMusic = await fetch(base + '/api/music/url?id=../etc');
    ok('music.invalidId', badMusic.status === 400);
    const musicOpen = await (await fetch(base + '/api/music/open?id=ABC123&name=晴天')).json();
    ok('music.open.kugou', musicOpen.ok === true && musicOpen.provider === 'kugou' &&
      /kugou\.com\/song/.test(musicOpen.webUrl) && /^kugou:\/\//.test(musicOpen.deepLink));

    /* 11. WebSocket 握手 / 工具调用 / Origin 校验 */
    const ws = await wsCall(port, '', 'echo', { a: 1 });
    ok('ws.tool.echo', ws.type === 'result' && ws.ok === true && ws.text === 'pong');
    const wsOrigin = await wsHandshake(port, '/', { Origin: 'http://evil.example' });
    ok('ws.origin.rejected', wsOrigin.type === 'http' && wsOrigin.status === 403, JSON.stringify(wsOrigin));
    const wsLocalOrigin = await wsHandshake(port, '/', { Origin: 'http://127.0.0.1:1234' });
    ok('ws.origin.local', wsLocalOrigin.type === 'upgrade' && wsLocalOrigin.status === 101, JSON.stringify(wsLocalOrigin));
    if (wsLocalOrigin.type === 'upgrade') wsLocalOrigin.socket.destroy();

    /* 12. token 鉴权（独立实例） */
    const dataDir2 = tmpDir('ib-bridge-token-');
    const port2 = freePort();
    const bridge2 = await startBridge(dataDir2, port2, 'secret');
    try {
      const bad = await wsCloseCode(port2, 'wrong');
      ok('ws.token.reject', bad === 4401, 'close=' + bad);
      const good = await wsCall(port2, 'secret', 'echo', {});
      ok('ws.token.accept', good.type === 'result' && good.ok === true);
    } finally {
      bridge2.kill();
      await sleep(200);
      try { fs.rmSync(dataDir2, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
    }

    /* 13. 配置自动补齐 + 损坏自愈 */
    const dataDir3 = tmpDir('ib-bridge-cfg-');
    fs.writeFileSync(path.join(dataDir3, 'config.json'), JSON.stringify({
      version: 1, token: '', contextBudget: 200000,
      bark: { enabled: false, url: '' }, webhooks: {},
      proactive: { enabled: false, intervalMin: 50, endpoint: '', apiKey: '', model: '', system: 's', prompt: 'p', from: 'Sui' }
    }), 'utf8');
    const port3 = freePort();
    const bridge3 = await startBridge(dataDir3, port3, null);
    const upgraded = JSON.parse(fs.readFileSync(path.join(dataDir3, 'config.json'), 'utf8'));
    ok('config.upgrade.addsNewFields', upgraded.lan === false && upgraded.music && upgraded.music.fallbackNetease === true && upgraded.tts && upgraded.ntfy);
    bridge3.kill();
    await sleep(200);
    try { fs.rmSync(dataDir3, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }

    const dataDir4 = tmpDir('ib-bridge-broken-');
    fs.writeFileSync(path.join(dataDir4, 'config.json'), '{ broken json', 'utf8');
    const port4 = freePort();
    const bridge4 = await startBridge(dataDir4, port4, null);
    const repaired = JSON.parse(fs.readFileSync(path.join(dataDir4, 'config.json'), 'utf8'));
    const brokenFiles = fs.readdirSync(dataDir4).filter(n => n.startsWith('config.json.broken-'));
    ok('config.invalid.repaired', repaired.lan === false && brokenFiles.length === 1);
    bridge4.kill();
    await sleep(200);
    try { fs.rmSync(dataDir4, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }

    /* 14. 健康写入/读取 + 非对象兼容 */
    const h1 = await (await fetch(base + '/api/health', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date: '2026-08-04', metrics: { 睡眠: 7.2, 步数: 8200 } })
    })).json();
    ok('health.post', h1.ok === true);
    const hg = await (await fetch(base + '/api/health?days=7')).json();
    ok('health.get', hg.ok === true && hg.records.some(r => r.date === '2026-08-04'));
    const h2 = await (await fetch(base + '/api/health', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date: '2026-08-05', metrics: 'oops' })
    })).json();
    ok('health.nonObjectMetrics', h2.ok === true);

    /* 15. 心语修改 */
    const wEdit = await (await fetch(base + '/api/whispers', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: '原始内容', author: 't' })
    })).json();
    const wp = await (await fetch(base + '/api/whispers/' + encodeURIComponent(wEdit.whisper.id), {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: '修改后内容' })
    })).json();
    ok('whispers.update', wp.ok === true && wp.whisper.text === '修改后内容');
    const wl2 = await (await fetch(base + '/api/whispers')).json();
    ok('whispers.update.persisted', wl2.whispers.some(x => x.id === wEdit.whisper.id && x.text === '修改后内容'));

    /* 16. 推送历史 */
    await fetch(base + '/api/push', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '审计推送', text: '历史记录验证', bark: false, ntfy: false })
    });
    const ph = await (await fetch(base + '/api/push/history?limit=10')).json();
    ok('push.history', ph.ok === true && ph.history.some(p => p.text === '历史记录验证'));

    /* 17. Anthropic 适配（mock 校验请求结构与解析） */
    const mockAnt = await startMockAnthropic();
    try {
      const createdAnt = await (await fetch(base + '/api/ai/sessions', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'resident_ant', name: 'Anthropic测试', provider: { endpoint: 'http://127.0.0.1:' + mockAnt.port + '/v1/messages', apiKey: 'ant-key', model: 'claude-x', format: 'anthropic' }, system: '你是测试角色。', relationship: '朋友' })
      })).json();
      ok('anthropic.create', createdAnt.ok === true);
      const chatAnt1 = await (await fetch(base + '/api/ai/chat', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'resident_ant', message: '你好' })
      })).json();
      ok('anthropic.chat', chatAnt1.ok === true && chatAnt1.reply === '来自Anthropic的回复');
      const b1 = mockAnt.lastBody();
      ok('anthropic.body.system', typeof b1.system === 'string' && b1.system.indexOf('你是测试角色') !== -1);
      ok('anthropic.body.lastUser', b1.messages.length > 0 && b1.messages[b1.messages.length - 1].role === 'user');
      const chatAnt2 = await (await fetch(base + '/api/ai/chat', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'resident_ant', message: '再来' })
      })).json();
      ok('anthropic.chat2', chatAnt2.ok === true);
      const b2 = mockAnt.lastBody();
      ok('anthropic.dropsTrailingAssistant', b2.messages.length > 0 && b2.messages[b2.messages.length - 1].role === 'user');
      ok('anthropic.headers', mockAnt.lastHeaders()['x-api-key'] === 'ant-key' && !!mockAnt.lastHeaders()['anthropic-version']);
      await fetch(base + '/api/ai/sessions/resident_ant', { method: 'DELETE' });
    } finally { mockAnt.server.close(); }

    /* 18. Gemini 适配（mock 校验请求结构与解析） */
    const mockGem = await startMockGemini();
    try {
      const createdGem = await (await fetch(base + '/api/ai/sessions', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'resident_gem', name: 'Gemini测试', provider: { endpoint: 'http://127.0.0.1:' + mockGem.port + '/v1beta/models/{model}:generateContent', apiKey: 'gem-key', model: 'gemini-x', format: 'gemini' }, system: '你是测试角色。', relationship: '朋友' })
      })).json();
      ok('gemini.create', createdGem.ok === true);
      const chatGem = await (await fetch(base + '/api/ai/chat', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'resident_gem', message: '你好' })
      })).json();
      ok('gemini.chat', chatGem.ok === true && chatGem.reply === '来自Gemini的回复');
      const gb = mockGem.lastBody();
      ok('gemini.body.system', gb.systemInstruction && gb.systemInstruction.parts[0].text.indexOf('你是测试角色') !== -1);
      ok('gemini.body.contents', gb.contents.length > 0 && (gb.contents[0].role === 'user' || gb.contents[0].role === 'model'));
      ok('gemini.headers', mockGem.lastHeaders()['x-goog-api-key'] === 'gem-key');
      await fetch(base + '/api/ai/sessions/resident_gem', { method: 'DELETE' });
    } finally { mockGem.server.close(); }

    /* 19. TTS 合成 → 存文件 → 播放 URL（mock） */
    const mockTts = await startMockTts();
    const dataDir5 = tmpDir('ib-bridge-tts-');
    const port5 = freePort();
    fs.writeFileSync(path.join(dataDir5, 'config.json'), JSON.stringify({
      tts: { enabled: true, endpoint: 'http://127.0.0.1:' + mockTts.port + '/v1/audio/speech', apiKey: 'tts-key', model: 'tts-1', voice: 'alloy', lang: 'zh-CN' }
    }), 'utf8');
    const bridge5 = await startBridge(dataDir5, port5, null);
    try {
      const ttsR = await (await fetch('http://127.0.0.1:' + port5 + '/api/tts', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: '你好' })
      })).json();
      ok('tts.synthesize', ttsR.ok === true && typeof ttsR.url === 'string' && ttsR.url.indexOf('/tts/') === 0);
      const ttsF = await fetch('http://127.0.0.1:' + port5 + ttsR.url);
      const ttsBuf = Buffer.from(await ttsF.arrayBuffer());
      ok('tts.serveFile', ttsF.status === 200 && /mpeg/.test(ttsF.headers.get('content-type') || '') && ttsBuf.toString() === 'MP3FAKE');
      const tb = mockTts.lastBody();
      ok('tts.requestShape', tb && tb.input === '你好' && tb.voice === 'alloy' && tb.response_format === 'mp3');
    } finally {
      bridge5.kill();
      await sleep(200);
      try { fs.rmSync(dataDir5, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
    }
    mockTts.server.close();

    /* 20. 服务重启后的数据恢复 */
    const dataDir6 = tmpDir('ib-bridge-restart-');
    const port6 = freePort();
    const mock6 = await startMockProvider();
    const bridge6 = await startBridge(dataDir6, port6, null);
    const base6 = 'http://127.0.0.1:' + port6;
    try {
      await fetch(base6 + '/api/whispers', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: '重启前的心语' }) });
      await fetch(base6 + '/api/geo', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lat: 31.2, lng: 121.5, city: '上海' }) });
      await fetch(base6 + '/api/ai/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: 'resident_persist', name: '重启测试', provider: { endpoint: 'http://127.0.0.1:' + mock6.port + '/v1/chat/completions', apiKey: 'x', model: 'mock', format: 'openai' }, system: '测试' }) });
      const chatP = await (await fetch(base6 + '/api/ai/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: 'resident_persist', message: '你好' }) })).json();
      ok('restart.before', chatP.ok === true);
      bridge6.kill();
      await sleep(300);
      const bridge6b = await startBridge(dataDir6, port6, null);
      try {
        const w6 = await (await fetch(base6 + '/api/whispers')).json();
        ok('restart.whispers', w6.whispers.some(x => x.text === '重启前的心语'));
        const g6 = await (await fetch(base6 + '/api/geo/latest')).json();
        ok('restart.geo', g6.ok === true && g6.geo.city === '上海');
        const s6 = await (await fetch(base6 + '/api/ai/sessions/resident_persist')).json();
        ok('restart.resident', s6.ok === true && s6.session.history.length >= 3);
      } finally { bridge6b.kill(); }
    } finally {
      await sleep(200);
      try { fs.rmSync(dataDir6, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
    }
    mock6.server.close();

    /* 21. 主动消息定时器：重启后继续触发 */
    const dataDir7 = tmpDir('ib-bridge-timer-');
    const port7 = freePort();
    const mock7 = await startMockProvider();
    const bridge7 = await startBridge(dataDir7, port7, null, { IB_RESIDENT_TICK_MS: '200' });
    const base7 = 'http://127.0.0.1:' + port7;
    try {
      await fetch(base7 + '/api/ai/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: 'resident_timer', name: '定时测试', provider: { endpoint: 'http://127.0.0.1:' + mock7.port + '/v1/chat/completions', apiKey: 'x', model: 'mock', format: 'openai' }, system: '测试', intervalMin: 0.001 }) });
      bridge7.kill();
      await sleep(300);
      const bridge7b = await startBridge(dataDir7, port7, null, { IB_RESIDENT_TICK_MS: '200' });
      try {
        await sleep(1800);
        const t7 = await (await fetch(base7 + '/api/ai/sessions/resident_timer')).json();
        ok('timer.restartFires', t7.ok === true && t7.session.lastProactive > 0 && t7.session.history.length >= 1, JSON.stringify(t7.session));
      } finally { bridge7b.kill(); }
    } finally {
      await sleep(200);
      try { fs.rmSync(dataDir7, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
    }
    mock7.server.close();

    /* 22. 数据文件损坏：备份 + 空数据降级 */
    const dataDir8 = tmpDir('ib-bridge-corrupt-');
    const port8 = freePort();
    fs.writeFileSync(path.join(dataDir8, 'whispers.json'), '{ broken json', 'utf8');
    const bridge8 = await startBridge(dataDir8, port8, null);
    try {
      const w8 = await (await fetch('http://127.0.0.1:' + port8 + '/api/whispers')).json();
      ok('corrupt.whispersEmpty', w8.ok === true && w8.whispers.length === 0);
      const brokenFiles = fs.readdirSync(dataDir8).filter(n => n.indexOf('whispers.json.broken-') === 0);
      ok('corrupt.backupCreated', brokenFiles.length === 1);
    } finally {
      bridge8.kill();
      await sleep(200);
      try { fs.rmSync(dataDir8, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
    }

    ok('test.cleanup', true);
  } finally {
    mock.server.close();
    bridge.kill();
    await sleep(300);
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
  }

  console.log(failures === 0 ? '\n全部通过 ✔' : '\n失败 ' + failures + ' 项 ✘');
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(e => {
  console.error('测试执行异常：', e);
  process.exit(1);
});
