/* 端到端验证：file://(Origin:null) 场景下，浏览器 → 本地 Bridge /api/llm-proxy → 上游。
   校验：流式透传 / 错误码镜像 / OPTIONS preflight / 上游 Authorization 头转发。 */
'use strict';
const http = require('http');
const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');

const UP_PORT = 19090;
const BR_PORT = 19091;
const results = [];
function ok(name, pass, detail) { results.push({ name, pass, detail }); console.log((pass ? 'PASS' : 'FAIL') + '  ' + name + (detail ? '  — ' + detail : '')); }

/* ── 1. Mock 上游（模拟 OpenAI-compatible） ── */
let capturedAuth = null;
const upstream = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => body += c);
  req.on('end', () => {
    capturedAuth = req.headers['authorization'] || null;
    if (req.url.startsWith('/error')) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Invalid API key', request_id: 'req_abc123' } }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const chunks = ['data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
                    'data: {"choices":[{"delta":{"content":"lo "}}]}\n\n',
                    'data: {"choices":[{"delta":{"content":"World"}}]}\n\n',
                    'data: [DONE]\n\n'];
    let i = 0;
    const iv = setInterval(() => {
      if (i >= chunks.length) { clearInterval(iv); res.end(); return; }
      res.write(chunks[i++]);
    }, 20);
  });
});

/* ── 2. 启动本地 Bridge ── */
const bridgeProc = spawn(process.execPath, [path.join(__dirname, 'ib-bridge-service.js')], {
  env: Object.assign({}, process.env, {
    IB_BRIDGE_PORT: String(BR_PORT),
    IB_BRIDGE_HOST: '127.0.0.1',
    IB_BRIDGE_DATA_DIR: path.join(os.tmpdir(), 'ib-bridge-test-' + Date.now())
  }),
  stdio: 'ignore'
});

function fetchAs(url, opts) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const r = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: (opts.method || 'GET'), headers: opts.headers }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    r.on('error', reject);
    if (opts.body) r.write(opts.body);
    r.end();
  });
}

async function waitBridge() {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetchAs('http://127.0.0.1:' + BR_PORT + '/health', { method: 'GET' });
      if (r.status === 200) return true;
    } catch (e) {}
    await new Promise(r => setTimeout(r, 250));
  }
  return false;
}

(async () => {
  await new Promise(r => upstream.listen(UP_PORT, '127.0.0.1', r));
  const up = await waitBridge();
  ok('Bridge 启动', up);

  /* CORS preflight（file:// Origin:null） */
  const pre = await fetchAs('http://127.0.0.1:' + BR_PORT + '/api/llm-proxy', {
    method: 'OPTIONS',
    headers: { 'Origin': 'null', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type,x-ib-token' }
  });
  ok('OPTIONS 预检 204', pre.status === 204);
  ok('preflight ACAO=null', pre.headers['access-control-allow-origin'] === 'null');
  ok('preflight 允许 X-IB-Token', /x-ib-token/i.test(pre.headers['access-control-allow-headers'] || ''));

  /* 流式透传 */
  const body = JSON.stringify({
    method: 'POST',
    url: 'http://127.0.0.1:' + UP_PORT + '/v1/chat/completions',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer TEST_KEY_123' },
    body: '{"model":"m","stream":true,"messages":[]}'
  });
  const sres = await fetchAs('http://127.0.0.1:' + BR_PORT + '/api/llm-proxy', {
    method: 'POST', headers: { 'Origin': 'null', 'Content-Type': 'application/json', 'X-IB-Token': '' }, body
  });
  ok('流式状态 200', sres.status === 200);
  ok('流式 content-type text/event-stream', /text\/event-stream/.test(sres.headers['content-type'] || ''));
  ok('流式 ACAO=null', sres.headers['access-control-allow-origin'] === 'null');
  /* 按浏览器逻辑解析 SSE：逐行取 data: 并累积 delta.content */
  const joined = sres.body.split('\n').filter(l => l.startsWith('data:')).map(l => {
    const d = l.slice(5).trim();
    if (d === '[DONE]' || !d) return '';
    try { const j = JSON.parse(d); return ((j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content) || ''); } catch (e) { return ''; }
  }).join('');
  ok('流式累积内容 == "Hello World"', joined === 'Hello World', JSON.stringify(joined));
  ok('流式包含 [DONE]', /\[DONE\]/.test(sres.body));
  /* 上游收到 Authorization 头（API Key 被 Bridge 转发）——此刻仅流式请求已发 */
  ok('上游 Authorization 转发', capturedAuth === 'Bearer TEST_KEY_123', 'got ' + JSON.stringify(capturedAuth));

  /* 错误码镜像（上游 401）*/
  const ebody = JSON.stringify({
    method: 'POST',
    url: 'http://127.0.0.1:' + UP_PORT + '/error',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' },
    body: '{}'
  });
  const eres = await fetchAs('http://127.0.0.1:' + BR_PORT + '/api/llm-proxy', {
    method: 'POST', headers: { 'Origin': 'null', 'Content-Type': 'application/json' }, body: ebody
  });
  ok('错误码镜像 401', eres.status === 401, 'got ' + eres.status);
  ok('错误体保留 request_id', /req_abc123/.test(eres.body));

  /* 安全：拒绝非 http/https 目标 */
  const bbody = JSON.stringify({ method: 'POST', url: 'file:///etc/passwd', headers: {}, body: '' });
  const bres = await fetchAs('http://127.0.0.1:' + BR_PORT + '/api/llm-proxy', {
    method: 'POST', headers: { 'Origin': 'null', 'Content-Type': 'application/json' }, body: bbody
  });
  ok('拒绝非 http/https 目标 (400)', bres.status === 400);

  const passCount = results.filter(r => r.pass).length;
  console.log('\n==== ' + passCount + '/' + results.length + ' PASS ====');

  upstream.close();
  bridgeProc.kill();
  process.exit(passCount === results.length ? 0 : 1);
  setTimeout(() => process.exit(2), 2000);
})().catch(e => { console.error('TEST ERROR', e); process.exit(2); });
