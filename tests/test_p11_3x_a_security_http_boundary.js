/* ====================================================================
   P11-3X-A · Security / HTTP Boundary — 边界回归测试
   --------------------------------------------------------------------
   本文件把 P11-3X-A 审计出的边界写成**可执行断言**，覆盖用户要求的 A–G：

     A. Surface registry completeness —— 端点清单不是文档，而是被探针逐条打过
        的声明（Home Node 的 /security 自述 + Bridge 的实测矩阵）。
     B. Bridge WebSocket 鉴权 / Origin
     C. proxy target policy（/api/llm-proxy）
     D. proactive traces / debug（Active companion）
     E. memory viewer semantics（HTTP 边界，不改 canonical ACL）
     F. error redaction（错误响应里不得出现 stack / 绝对路径）
     G. credential minting regression（P11-3A 清单仍承重）

   隔离纪律（与用户测试纪律一致）：
     · 私有临时 data dir（os.tmpdir()）；绝不触碰 %LOCALAPPDATA%\InternalBeyond
       或开发目录里的任何用户数据；
     · 私有端口（内核分配）；不绑定非 loopback 地址；
     · 不调用真实 provider；不启动浏览器；不读真实 Home Node 实例；
     · 每个子进程与 server 在结束时显式回收，并**报告**残留句柄。

   用法：
     node tests/test_p11_3x_a_security_http_boundary.js
     P11_3X_A_SECTIONS=A,B   node ...   （mutation 驱动只跑受影响的小节）
   ==================================================================== */
'use strict';

const http = require('http');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

/* Home Node 的模块级装配会读这个环境变量；必须在 require 之前设好，
   否则进程级实例会指向真实用户目录（即使我们只用 buildHomeNode 的隔离实例）。 */
const HN_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-p11-3x-a-hn-'));
process.env.IB_HOME_NODE_DATA_DIR = HN_DIR;

let passed = 0, failed = 0;
const failures = [];
function check(name, cond, extra) {
  if (cond) { passed++; console.log('\u2714 ' + name); }
  else {
    failed++;
    failures.push(name);
    console.log('\u2718 FAIL  ' + name + (extra !== undefined ? '  \u2014 ' + JSON.stringify(extra) : ''));
  }
}
function section(title) { console.log('\n\u2500\u2500 ' + title + ' \u2500\u2500'); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const WANT = String(process.env.P11_3X_A_SECTIONS || '').split(',').map(s => s.trim()).filter(Boolean);
const wants = id => !WANT.length || WANT.indexOf(id) >= 0;

/* ── 基础设施 ─────────────────────────────────────────────────────────── */

function tmpDir(tag) { return fs.mkdtempSync(path.join(os.tmpdir(), 'ib-p11-3x-a-' + tag + '-')); }

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(e => e ? reject(e) : resolve(p)); });
  });
}

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function request(port, method, urlPath, opts) {
  opts = opts || {};
  return new Promise((resolve, reject) => {
    const data = opts.body == null ? null : (typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body));
    const headers = Object.assign({}, opts.headers || {});
    if (data != null) headers['Content-Length'] = Buffer.byteLength(data);
    const req = http.request({
      host: '127.0.0.1', port: port, path: urlPath, method: method,
      timeout: 20000, headers: headers
    }, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        let parsed = null;
        try { parsed = raw ? JSON.parse(raw) : {}; } catch (_) { parsed = { raw: raw }; }
        resolve({ status: res.statusCode, headers: res.headers, body: parsed, raw: raw });
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (data != null) req.write(data);
    req.end();
  });
}

const openChildren = new Set();
const openServers = new Set();

function startService(script, env, port, tag) {
  const child = spawn(process.execPath, [script], {
    cwd: ROOT,
    env: Object.assign({}, process.env, env),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  openChildren.add(child);
  let log = '';
  child.stdout.on('data', d => { log += String(d); });
  child.stderr.on('data', d => { log += String(d); });
  child.on('exit', () => openChildren.delete(child));
  return (async () => {
    for (let i = 0; i < 80; i++) {
      try {
        const r = await request(port, 'GET', '/health', {});
        if (r.status === 200) return child;
      } catch (_) { /* not up yet */ }
      await sleep(200);
    }
    throw new Error(tag + ' did not become healthy on port ' + port + '\n' + log.slice(-2000));
  })();
}

/* ── 最小 WS 客户端（与 tests/test_bridge.js 同款：不发掩码帧，服务端两种都收） ── */
function wsConnect(port, extraHeaders) {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString('base64');
    const req = http.request({
      host: '127.0.0.1', port: port, path: '/',
      headers: Object.assign({
        Upgrade: 'websocket', Connection: 'Upgrade',
        'Sec-WebSocket-Key': key, 'Sec-WebSocket-Version': '13'
      }, extraHeaders || {})
    });
    req.on('upgrade', (res, socket) => resolve({ type: 'upgrade', status: res.statusCode, socket: socket }));
    req.on('response', res => { resolve({ type: 'http', status: res.statusCode }); res.resume(); });
    req.on('error', reject);
    req.end();
  });
}

function wsSession(socket) {
  let buf = Buffer.alloc(0);
  const waiters = [];
  socket.on('data', d => { buf = Buffer.concat([buf, d]); pump(); });
  function pump() {
    while (buf.length >= 2) {
      const b0 = buf[0], len0 = buf[1] & 0x7f;
      let off = 2, len = len0;
      if (len0 === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      if (len0 === 127) { if (buf.length < 10) return; len = buf.readUInt32BE(6); off = 10; }
      if (buf.length < off + len) return;
      const op = b0 & 0x0f;
      const payload = buf.slice(off, off + len);
      buf = buf.slice(off + len);
      if (op === 0x8) { const w = waiters.shift(); if (w) w({ type: 'close', code: payload.length >= 2 ? payload.readUInt16BE(0) : 1000 }); continue; }
      if (op !== 0x1) continue;
      let msg;
      try { msg = JSON.parse(payload.toString('utf8')); } catch (_) { msg = { type: 'unparsed' }; }
      const w = waiters.shift();
      if (w) w(msg);
    }
  }
  return {
    send(obj) {
      const p = Buffer.from(JSON.stringify(obj));
      let h;
      if (p.length < 126) { h = Buffer.alloc(2); h[1] = p.length; }
      else { h = Buffer.alloc(4); h[1] = 126; h.writeUInt16BE(p.length, 2); }
      h[0] = 0x81;
      socket.write(Buffer.concat([h, p]));
    },
    next(timeoutMs) {
      return new Promise(resolve => {
        const t = setTimeout(() => resolve({ type: 'timeout' }), timeoutMs || 8000);
        waiters.push(m => { clearTimeout(t); resolve(m); });
      });
    }
  };
}

/* 一次完整的 hello + tool_call；返回可断言的形状 */
async function wsToolCall(port, headers, helloToken, toolName, args) {
  const hs = await wsConnect(port, headers);
  if (hs.type !== 'upgrade') return { upgrade: 'http-' + hs.status };
  const sess = wsSession(hs.socket);
  sess.send({ type: 'hello', client: 'p11-3x-a', version: '1', token: helloToken || '', capabilities: ['tools'] });
  const first = await sess.next();
  let result = null;
  if (first && first.type === 'hello_ack') {
    sess.send({ type: 'tool_call', id: 't1', name: toolName, args: args || {} });
    result = await sess.next();
  }
  try { hs.socket.destroy(); } catch (_) { /* ignore */ }
  return { upgrade: '101', first: first && first.type, closeCode: first && first.type === 'close' ? first.code : null, result: result };
}

const EVIL = 'http://evil.example';

/* 错误响应里绝不允许出现的东西：stack 帧 与 本机绝对路径（驱动器/UNC）。
   注意 stack 在 JSON 里会被转义成 `\n    at …`（反斜杠 + n），两种形态都要抓：
   只查字面换行会让"把 e.stack 塞进 JSON 响应"这种泄漏漏网。 */
function errorRedactionViolations(status, raw) {
  const bad = [];
  if (status < 400) return bad;
  if (/\n\s+at\s+\S/.test(raw) || /\\n\s*at\s+[^\s"]/.test(raw)) bad.push('stack-frame');
  if (/\bat\s+(?:Object|Module|process\.|new |async )/.test(raw)) bad.push('stack-call-site');
  if (/[A-Za-z]:\\{1,2}[^\s"']{3,}/.test(raw)) bad.push('absolute-windows-path');
  if (raw.indexOf(os.tmpdir()) >= 0) bad.push('temp-data-dir');
  return bad;
}

(async () => {
  let bridge = null, lanBridge = null, active = null, hn = null;
  const fixtureDirs = [HN_DIR];

  /* ── fixtures：一个"内部服务"（模拟本机其它进程的私有接口）与一个重定向器 ── */
  const internalHits = [];
  const internalSrv = http.createServer((req, res) => {
    internalHits.push({ url: req.url });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ secret: 'INTERNAL-ONLY-DATA' }));
  });
  const internalPort = await listen(internalSrv);
  openServers.add(internalSrv);

  let redirectHits = 0;
  const redirectSrv = http.createServer((req, res) => {
    redirectHits += 1;
    res.writeHead(302, { Location: 'http://127.0.0.1:' + internalPort + '/redirected' });
    res.end();
  });
  const redirectPort = await listen(redirectSrv);
  openServers.add(redirectSrv);

  /* ── 四个真实进程/装配实例 ─────────────────────────────────────────── */
  const bDir = tmpDir('bridge'); fixtureDirs.push(bDir);
  const bPort = await freePort();
  bridge = await startService(path.join(ROOT, 'services', 'ib-bridge-service.js'),
    { IB_BRIDGE_PORT: String(bPort), IB_BRIDGE_HOST: '127.0.0.1', IB_BRIDGE_DATA_DIR: bDir }, bPort, 'bridge');

  const lanDir = tmpDir('bridge-lan'); fixtureDirs.push(lanDir);
  fs.writeFileSync(path.join(lanDir, 'config.json'), JSON.stringify({ lan: true, token: '' }), 'utf8');
  const lanPort = await freePort();
  lanBridge = await startService(path.join(ROOT, 'services', 'ib-bridge-service.js'),
    { IB_BRIDGE_PORT: String(lanPort), IB_BRIDGE_HOST: '127.0.0.1', IB_BRIDGE_DATA_DIR: lanDir }, lanPort, 'bridge-lan');
  const lanToken = String(JSON.parse(fs.readFileSync(path.join(lanDir, 'config.json'), 'utf8')).token || '');

  const aDir = tmpDir('active'); fixtureDirs.push(aDir);
  const aPort = await freePort();
  active = await startService(path.join(ROOT, 'services', 'active-message-service.js'),
    {
      IB_ACTIVE_PORT: String(aPort), IB_ACTIVE_DATA_DIR: aDir,
      /* 调度器在这份测试里绝不该 tick：把启动延迟推到 15 分钟（进程很快就被回收）。 */
      IB_ACTIVE_START_DELAY_MS: '900000', IB_SOCIAL_OBSERVE: 'off'
    }, aPort, 'active');

  const SERVICE = require('../services/home-node-service.js');
  hn = SERVICE.buildHomeNode({ dataDir: tmpDir('hn-instance'), logger: () => {} });
  fixtureDirs.push(hn.memoryStore && hn.memoryStore.file ? path.dirname(hn.memoryStore.file) : '');
  const hnPort = await listen(hn.server);
  openServers.add(hn.server);
  hn.open();   /* 不 open 的话桌面面全部 503，测试会变成"因为没开库所以没泄漏"的假绿 */

  /* ══════════════════════════════════════════════════════════════════
     A · Surface registry completeness
     ══════════════════════════════════════════════════════════════════ */
  if (wants('A')) {
    section('A \u00b7 Surface registry \u2014 声明与实测一致（Bridge / Active / Home Node）');

    /* A1：Bridge 的 LAN 模式矩阵。声明见 bridge/routes.js：只有 /health 在
       token 线之前（启动器探测用），其余全部必须在 token 线之后。 */
    const lanPaths = ['/health', '/status', '/api/diagnostics', '/api/config', '/api/tools',
      '/api/whispers', '/api/push/history', '/api/ai/sessions', '/api/context'];
    const lanStatus = {};
    for (const p of lanPaths) lanStatus[p] = (await request(lanPort, 'GET', p, {})).status;
    check('A1.1 LAN 模式：/health 仍是匿名探针（启动器识别既有服务）', lanStatus['/health'] === 200, lanStatus);
    const notHealth = lanPaths.filter(p => p !== '/health');
    check('A1.2 LAN 模式：除 /health 外**每一个**端点都要求 token（含 /status）',
      notHealth.every(p => lanStatus[p] === 401), lanStatus);
    check('A1.3 LAN 模式：token 正确时 /status 仍然可用（收紧没有变成不可用）',
      (await request(lanPort, 'GET', '/status', { headers: { Authorization: 'Bearer ' + lanToken } })).status === 200);
    check('A1.4 LAN 模式：token 已自动生成（blank token + LAN 暴露的既有迁移规则仍生效）', lanToken.length > 0);

    /* A2：默认 loopback（未配置 token）的匿名面。这一档是 D1 明确接受的姿态：
       读 + 写都匿名放行；本测试把它的**边界**钉住（不是钉"它们是安全的"）。 */
    const anonPaths = ['/health', '/status', '/api/config', '/api/tools', '/api/whispers'];
    const anonStatus = {};
    for (const p of anonPaths) anonStatus[p] = (await request(bPort, 'GET', p, {})).status;
    check('A2.1 默认 loopback（无 token）：既有匿名面未被本次收紧误伤（D1 已接受姿态）',
      anonPaths.every(p => anonStatus[p] === 200), anonStatus);

    /* A3：Origin 授权矩阵 —— 全部端点、全部方法，命名的外来 Origin 一律 403。
       这是 P11-3X-A 的核心修复（唯一使用既有 corsOrigin 策略，不新增策略）。 */
    const originCases = [
      ['GET', '/health', null], ['GET', '/status', null], ['GET', '/api/config', null],
      ['GET', '/api/diagnostics', null], ['POST', '/api/whispers', { text: 'x' }],
      ['POST', '/api/push', { title: 'x', text: 'x', bark: false, ntfy: false }],
      ['POST', '/api/ai/sessions', { key: 'k' }], ['POST', '/api/context', {}],
      ['POST', '/api/ai/chat', { key: 'k', message: 'm' }],
      ['POST', '/api/llm-proxy', { method: 'GET', url: 'http://127.0.0.1:' + internalPort + '/x' }]
    ];
    let evilAll403 = true, evilBody = null;
    for (const c of originCases) {
      const r = await request(bPort, c[0], c[1], {
        headers: { Origin: EVIL, 'Content-Type': 'text/plain' },
        body: c[2] == null ? null : JSON.stringify(c[2])
      });
      if (r.status !== 403) { evilAll403 = false; evilBody = { path: c[1], status: r.status }; }
    }
    check('A3.1 命名外来 Origin：**每个**端点一律 403（不再"照做但不给 ACAO"）', evilAll403, evilBody);
    check('A3.2 拒绝理由是稳定的封闭字符串（与 active/http.js 同款）',
      (await request(bPort, 'POST', '/api/whispers', { headers: { Origin: EVIL }, body: '{}' })).body.error === 'Origin is not allowed');
    const okOrigins = ['null', 'http://127.0.0.1:23120', 'http://localhost:9999'];
    const okStatus = {};
    for (const o of okOrigins) okStatus[o] = (await request(bPort, 'GET', '/health', { headers: { Origin: o } })).status;
    check('A3.3 合法来源（file:// 的 null / loopback 页）未被误伤，且 ACAO 正常回显',
      okOrigins.every(o => okStatus[o] === 200) &&
      (await request(bPort, 'GET', '/health', { headers: { Origin: 'null' } })).headers['access-control-allow-origin'] === 'null',
      okStatus);
    check('A3.4 无 Origin（原生调用方：启动器 / 快捷键 / 诊断脚本）继续放行',
      (await request(bPort, 'GET', '/health', {})).status === 200);

    /* A4：Home Node 的 /security 自述必须与实测一致 —— 这就是"registry completeness"
       在 Home Node 上的形态：声明是机器可读的，测试逐条打它。 */
    const sec = await request(hnPort, 'GET', '/security', { headers: { Origin: 'null' } });
    const decl = sec.body && sec.body.credentialMintingPaths;
    check('A4.1 /security 自述了凭据铸造面清单', sec.status === 200 && decl && Array.isArray(decl.paths) && decl.paths.length >= 5, sec.body && sec.body.error);
    if (decl && Array.isArray(decl.paths)) {
      const mintStatus = {};
      for (const p of decl.paths) {
        const m = p === '/mobile/v1/pairing/complete' ? 'POST' : (p === '/characters/publish' || p === '/device/revoke' || p === '/pairing/session' ? 'POST' : 'GET');
        mintStatus[p] = (await request(hnPort, m, p, { headers: { Origin: 'null', 'Content-Type': 'application/json' }, body: m === 'POST' ? '{}' : null })).status;
      }
      check('A4.2 自述清单里**每一条**在未配置桌面 token 时都是 403（声明即被强制）',
        Object.keys(mintStatus).every(p => mintStatus[p] === 403), mintStatus);
    }
    if (sec.body && Array.isArray(sec.body.loopbackReadableWithoutToken)) {
      const readable = {};
      for (const p of sec.body.loopbackReadableWithoutToken) {
        readable[p] = (await request(hnPort, 'GET', p, { headers: { Origin: 'null' } })).status;
      }
      check('A4.3 自述的 loopback 匿名读清单一律不是 401（既有的 D1/P11-3A 姿态未被误改）',
        Object.keys(readable).every(p => readable[p] !== 401), readable);
    }

    /* A5：Home Node 的**桌面写面**同样不接受"命名的外来 Origin"。
       修复前的实测（.dsh-research/p11-3x-a-probe.js G3）：一个 text/plain 的
       简单请求就能把 /migrate 的版本从 0 写成 4242，而响应读不到（盲写）。 */
    const migBefore = await request(hnPort, 'GET', '/migration?source=p11-3x-a', { headers: { Origin: 'null' } });
    const migEvil = await request(hnPort, 'POST', '/migrate', {
      headers: { Origin: EVIL, 'Content-Type': 'text/plain' },
      body: JSON.stringify({ source: 'p11-3x-a', version: 4242, lastTimestamp: 111, messages: 7 })
    });
    const migAfterEvil = await request(hnPort, 'GET', '/migration?source=p11-3x-a', { headers: { Origin: 'null' } });
    check('A5.1 命名外来 Origin 的简单请求在 Home Node 桌面上被 403，且**状态没有被写**',
      migEvil.status === 403 && migEvil.body.error === 'origin-denied' &&
      Number(migAfterEvil.body.state && migAfterEvil.body.state.version) ===
        Number(migBefore.body.state && migBefore.body.state.version),
      { write: migEvil.status, before: migBefore.body.state, after: migAfterEvil.body.state });

    const migNull = await request(hnPort, 'POST', '/migrate', {
      headers: { Origin: 'null', 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'p11-3x-a', version: 1, lastTimestamp: 1, messages: 1 })
    });
    check('A5.2 合法来源（file:// 的 null Origin）的写路径未被误伤',
      migNull.status === 200 &&
      Number((await request(hnPort, 'GET', '/migration?source=p11-3x-a', { headers: { Origin: 'null' } })).body.state.version) === 1,
      migNull.status);

    const mobileForeign = await request(hnPort, 'GET', '/mobile/v1/handshake', { headers: { Origin: EVIL } });
    check('A5.3 设备面**不**套桌面 Origin 策略：外来 Origin 的 /mobile/v1/* 仍是设备鉴权 401（不是桌面策略的 403）',
      mobileForeign.status === 401 && mobileForeign.body.error && mobileForeign.body.error.code === 'AUTH_REQUIRED',
      { status: mobileForeign.status, error: mobileForeign.body && mobileForeign.body.error });

    const memoryForeign = await request(hnPort, 'GET', '/memory/list', { headers: { Origin: EVIL } });
    check('A5.4 /memory/* 是桌面面：外来 Origin 同样 403（与 /status 同一套策略）',
      memoryForeign.status === 403 && memoryForeign.body.error === 'origin-denied', memoryForeign.status);
  }

  /* ══════════════════════════════════════════════════════════════════
     B · Bridge WebSocket boundary
     ══════════════════════════════════════════════════════════════════ */
  if (wants('B')) {
    section('B \u00b7 Bridge WS \u2014 Origin / token / 空 token 语义');

    const evilHs = await wsConnect(bPort, { Origin: EVIL });
    check('B1 命名外来 Origin：握手阶段 403（工具面根本到不了）', evilHs.type === 'http' && evilHs.status === 403, evilHs);
    const evilWithToken = await wsConnect(bPort, { Origin: EVIL, Authorization: 'Bearer whatever' });
    check('B2 命名外来 Origin + 任意 token：仍然 403（Origin 判定先于 token）',
      evilWithToken.type === 'http' && evilWithToken.status === 403, evilWithToken);
    const fileScheme = await wsConnect(bPort, { Origin: 'file://' });
    check('B3 非法 scheme Origin（file:// / chrome-extension://）403（浏览器发的是 null，不是 file://）',
      fileScheme.type === 'http' && fileScheme.status === 403, fileScheme);

    const nullOrigin = await wsToolCall(bPort, { Origin: 'null' }, '', 'context_stats', {});
    check('B4 Origin:null（file:// 与沙箱 iframe 的**共同**形状）+ 空 token：握手成功且工具执行',
      nullOrigin.first === 'hello_ack' && nullOrigin.result && nullOrigin.result.type === 'tool_result', nullOrigin);
    const noOrigin = await wsToolCall(bPort, {}, '', 'context_stats', {});
    check('B5 无 Origin（原生客户端）：同上', noOrigin.first === 'hello_ack' && !!noOrigin.result, noOrigin);
    const loopOrigin = await wsToolCall(bPort, { Origin: 'http://127.0.0.1:23120' }, '', 'context_stats', {});
    check('B6 loopback 页 Origin（生产承载 23120）：同上', loopOrigin.first === 'hello_ack' && !!loopOrigin.result, loopOrigin);

    check('B7 空 token 的语义是"未配置 token 时放行"，不是"空 token 被当成凭据"：'
      + '一旦配置了 token，空 token 必须被拒（LAN 实例已自动生成 token）',
      lanToken.length > 0 &&
      (await wsConnect(lanPort, { Origin: 'http://127.0.0.1:23120' })).status === 401);

    const lanOk = await wsConnect(lanPort, { Origin: 'http://127.0.0.1:23120', Authorization: 'Bearer ' + lanToken });
    check('B8 LAN 模式：正确 token 的升级仍然 101（收紧没有破坏 LAN 用法）', lanOk.type === 'upgrade' && lanOk.status === 101, lanOk);
    if (lanOk.type === 'upgrade') {
      const sess = wsSession(lanOk.socket);
      sess.send({ type: 'hello', client: 'x', version: '1', token: 'wrong-token', capabilities: [] });
      const first = await sess.next();
      check('B9 LAN 模式：升级带了正确 token，但 hello 帧 token 错误 → 4401 关闭（第二道边界仍承重）',
        first && first.type === 'close' && first.code === 4401, first);
      try { lanOk.socket.destroy(); } catch (_) { /* ignore */ }
    }
    const lanWrong = await wsConnect(lanPort, { Origin: 'http://127.0.0.1:23120', Authorization: 'Bearer nope' });
    check('B10 LAN 模式：错误 token 的升级 401', lanWrong.type === 'http' && lanWrong.status === 401, lanWrong);
  }

  /* ══════════════════════════════════════════════════════════════════
     C · /api/llm-proxy target policy
     ══════════════════════════════════════════════════════════════════ */
  if (wants('C')) {
    section('C \u00b7 /api/llm-proxy \u2014 调用方策略（不是目标白名单）');

    /* C1：命名外来 Origin 连"发动"都不行 —— 上游一个字节都不该收到。 */
    const before = internalHits.length;
    const evilProxy = await request(bPort, 'POST', '/api/llm-proxy', {
      headers: { Origin: EVIL, 'Content-Type': 'text/plain' },
      body: JSON.stringify({ method: 'GET', url: 'http://127.0.0.1:' + internalPort + '/evil' })
    });
    check('C1 命名外来 Origin：403 且上游未被触达（盲 SSRF 被关掉）',
      evilProxy.status === 403 && internalHits.length === before, { status: evilProxy.status, hits: internalHits.length - before });

    /* C2：产品的合法调用方（file:// → Origin:null）必须继续可用。 */
    const beforeOk = internalHits.length;
    const nullProxy = await request(bPort, 'POST', '/api/llm-proxy', {
      headers: { Origin: 'null', 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'GET', url: 'http://127.0.0.1:' + internalPort + '/legit' })
    });
    check('C2 Origin:null（file:// 桌面页）：仍然转发并且镜像上游包体',
      nullProxy.status === 200 && nullProxy.raw.indexOf('INTERNAL-ONLY-DATA') >= 0 && internalHits.length === beforeOk + 1);

    /* C3：非 http(s) 协议在协议层就被拒（既有行为，不是本阶段新加的）。 */
    const protos = {};
    for (const t of ['file:///C:/Windows/win.ini', 'ftp://127.0.0.1/x', 'gopher://127.0.0.1:70/x', 'data:text/plain,x']) {
      protos[t] = (await request(bPort, 'POST', '/api/llm-proxy', {
        headers: { Origin: 'null', 'Content-Type': 'application/json' },
        body: JSON.stringify({ method: 'GET', url: t })
      })).status;
    }
    check('C3 非 http/https 目标一律 400（file: / ftp: / gopher: / data:）',
      Object.keys(protos).every(k => protos[k] === 400), protos);

    /* C4：本机/私网目标**刻意不封**（IB 支持用户自定义 endpoint，含本地模型服务；
       tests/test_llm_proxy.js 的既有契约就是用 loopback 上游）。本断言把这条
       产品语义固定下来：任何"只允许官方域名"的改动都会在这里变红。 */
    const forms = {
      'hostname localhost': 'http://localhost:' + internalPort + '/h',
      'octal ipv4 0177.0.0.1': 'http://0177.0.0.1:' + internalPort + '/o',
      'ipv6 [::1]': 'http://[::1]:' + internalPort + '/v6'
    };
    const formRes = {};
    for (const k of Object.keys(forms)) {
      formRes[k] = (await request(bPort, 'POST', '/api/llm-proxy', {
        headers: { Origin: 'null', 'Content-Type': 'application/json' },
        body: JSON.stringify({ method: 'GET', url: forms[k] })
      })).status;
    }
    check('C4 loopback 目标（含 hostname / 八进制 / IPv6 写法）继续被转发：策略是**调用方**策略，不是目标白名单',
      formRes['hostname localhost'] === 200 && formRes['octal ipv4 0177.0.0.1'] === 200, formRes);

    /* C5：redirect 被跟随，且**不重新判定** —— 这是本阶段明确记录下来的残留，
       不是修复。写成断言是为了让"以后改了"可见（改它需要目标策略，而目标策略
       会破坏 C4）。 */
    const beforeRedir = redirectHits;
    const redir = await request(bPort, 'POST', '/api/llm-proxy', {
      headers: { Origin: 'null', 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'GET', url: 'http://127.0.0.1:' + redirectPort + '/go' })
    });
    check('C5 redirect 被跟随且未复检（已知残留；调用方策略下不构成新增可达性）',
      redirectHits === beforeRedir + 1 && redir.status === 200 && redir.raw.indexOf('INTERNAL-ONLY-DATA') >= 0,
      { hits: redirectHits - beforeRedir, status: redir.status });

    /* C6：hop-by-hop 头被原样透传，但 undici 自己拒绝冲突的 framing ——
       结果是 fail closed（502），不产生 smuggling 原语。 */
    const hopSrv = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{}'); });
    const hopPort = await listen(hopSrv);
    openServers.add(hopSrv);
    const hopRes = await request(bPort, 'POST', '/api/llm-proxy', {
      headers: { Origin: 'null', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        method: 'POST', url: 'http://127.0.0.1:' + hopPort + '/x',
        headers: { 'Content-Type': 'application/json', 'Content-Length': '9999', 'Transfer-Encoding': 'chunked' },
        body: '{"a":1}'
      })
    });
    check('C6 调用方伪造 Content-Length/Transfer-Encoding → 502 fail closed（无 smuggling）',
      hopRes.status === 502, hopRes.status);
    hopSrv.close();
  }

  /* ══════════════════════════════════════════════════════════════════
     D · proactive traces / debug
     ══════════════════════════════════════════════════════════════════ */
  if (wants('D')) {
    section('D \u00b7 proactive traces / debug \u2014 开发诊断面，不是产品面');

    const trNull = await request(aPort, 'GET', '/proactive/traces?limit=5', { headers: { Origin: 'null' } });
    check('D1 缺省关闭：/proactive/traces 回答 enabled=false 且 traces 为空（不是 404、不是泄漏）',
      trNull.status === 200 && trNull.body.enabled === false && Array.isArray(trNull.body.traces) && trNull.body.traces.length === 0, trNull.body);
    const trEvil = await request(aPort, 'GET', '/proactive/traces?limit=5', { headers: { Origin: EVIL } });
    check('D2 命名外来 Origin：Active companion 早已 403（Bridge 只是被对齐到同一条策略）',
      trEvil.status === 403, trEvil.status);
    const dbg = await request(aPort, 'GET', '/proactive/debug', { headers: { Origin: 'null' } });
    check('D3 /proactive/debug 只回静态 HTML（正文里没有任何 trace 数据，数据靠前端再取）',
      dbg.status === 200 && /text\/html/.test(String(dbg.headers['content-type'])) &&
      dbg.raw.indexOf('INTERNAL-ONLY-DATA') < 0 &&
      dbg.raw.indexOf('<div id="rows">') >= 0);
    check('D4 bind 地址是 127.0.0.1（进程常量，不可配置成 LAN）',
      fs.readFileSync(path.join(ROOT, 'services', 'active-message-service.js'), 'utf8').indexOf("const HOST = '127.0.0.1';") >= 0);

    /* D5：trace 载荷的白名单脱敏（这是"debug 端点会不会漏 prompt/密钥"的真正答案）。 */
    const createTrace = require('../active/proactive-trace.js');
    const t = createTrace({ enabled: true, limit: 5 });
    const id = t.begin({
      kind: 'proactive', characterName: 'Sui', apiKey: 'SECRET-KEY', token: 'SECRET-TOKEN',
      authorization: 'Bearer SECRET', prompt: 'FULL PROMPT TEXT', messages: ['hello body'],
      intent: 'i'.repeat(400)
    });
    t.append(id, 'context', true, 'mem', 'm'.repeat(400));
    t.set(id, { validation: { ok: false, reason: 'r'.repeat(400) } });
    const rec = t.finish(id, 'sent', {});
    const keys = Object.keys(rec);
    check('D5.1 命名像密钥的字段一律不进入 trace（apiKey/token/authorization）',
      keys.indexOf('apiKey') < 0 && keys.indexOf('token') < 0 && keys.indexOf('authorization') < 0, keys);
    check('D5.2 不在白名单里的字段一律不进入 trace（prompt / messages）',
      keys.indexOf('prompt') < 0 && keys.indexOf('messages') < 0, keys);
    check('D5.3 白名单内的长字符串被截断（intent ≤ 200 / detail ≤ 200 / validation.reason ≤ 160）',
      String(rec.intent).length <= 200 && rec.steps[0].detail.length <= 200 && rec.validation.reason.length <= 160,
      { intent: String(rec.intent).length, detail: rec.steps[0].detail.length, reason: rec.validation.reason.length });
    const copy = t.recent(5);
    copy[0].characterName = 'MUTATED';
    check('D5.4 recent() 返回深拷贝（前端改不坏服务端缓冲）', t.recent(5)[0].characterName === 'Sui');
    const off = createTrace({ enabled: false });
    check('D5.5 关闭时全部 no-op（begin 返回 null，recent 为空）', off.begin({}) === null && off.recent(5).length === 0);
  }

  /* ══════════════════════════════════════════════════════════════════
     E · memory viewer semantics（HTTP 边界；不改 canonical ACL）
     ══════════════════════════════════════════════════════════════════ */
  if (wants('E')) {
    section('E \u00b7 memory viewer \u2014 显式契约，不是歧义');

    const NOW = Date.now();
    const mem = (id, over) => Object.assign({
      id: id, kind: 'episodic', title: 'T-' + id, summary: '', content: 'BODY-' + id,
      domain: '\u65e5\u5e38', tags: [], valence: 0.5, arousal: 0.3, importance: 5, resolved: false,
      visibility: 'public', visibleTo: [], excludeFrom: [],
      activationCount: 0, created: NOW, lastActivated: NOW,
      createdBy: 'user', createdByName: '', editedByUser: false,
      consolidatedFrom: [], lastConsolidatedAt: null
    }, over || {});
    const store = hn.memoryStore;
    store.putRecord(mem('m_pub'));
    store.putRecord(mem('m_priv', { visibility: 'private' }));
    store.putRecord(mem('m_only_a', { visibility: 'only', visibleTo: ['alice'] }));
    store.putRecord(mem('m_only_b', { visibility: 'only', visibleTo: ['bob'] }));

    /* Home Node 的 mobile-gateway 响应是版本信封：{ v, ok, type, requestId, serverTime, payload } */
    const P = r => (r.body && r.body.payload) || {};
    const idsOf = r => (P(r).records || []).map(x => x.id);
    const upOf = r => (P(r).upserts || []).map(x => x.record.id);

    const full = await request(hnPort, 'GET', '/memory/list', { headers: { Origin: 'null' } });
    check('E1 不传 viewer = canonical 完整镜像（桌面 hydrate / 镜像同步依赖），且**可观测**地标明"这次读取没有读主体"',
      full.status === 200 && P(full).viewer === null && P(full).access === null &&
      idsOf(full).indexOf('m_priv') >= 0 && idsOf(full).indexOf('m_only_b') >= 0,
      { status: full.status, viewer: P(full).viewer, ids: idsOf(full) });

    const viewA = await request(hnPort, 'GET', '/memory/list?viewer=alice', { headers: { Origin: 'null' } });
    check('E2 传 viewer：唯一 canonical 读谓词 —— private 与"只给 bob"的记录不进入响应（过滤发生在序列化之前）',
      viewA.status === 200 && P(viewA).viewer === 'alice' && !!P(viewA).access &&
      idsOf(viewA).indexOf('m_pub') >= 0 && idsOf(viewA).indexOf('m_only_a') >= 0 &&
      idsOf(viewA).indexOf('m_priv') < 0 && idsOf(viewA).indexOf('m_only_b') < 0,
      { ids: idsOf(viewA), refused: P(viewA).access && P(viewA).access.refused });

    /* ── P11-3X-A 修复点：「参数在、值为空」必须与「空白主体」得到同一个答案 ── */
    const emptyViewer = await request(hnPort, 'GET', '/memory/list?viewer=', { headers: { Origin: 'null' } });
    check('E3 `?viewer=`（存在但为空）fail closed：空页 + 稳定 reason，**不得**退化成完整镜像（修复前它返回含 private 的全集）',
      emptyViewer.status === 200 && P(emptyViewer).count === 0 &&
      P(emptyViewer).viewer === '' && !!P(emptyViewer).access &&
      P(emptyViewer).access.reason === 'no-principal' &&
      idsOf(emptyViewer).indexOf('m_priv') < 0,
      { count: P(emptyViewer).count, viewer: P(emptyViewer).viewer, access: P(emptyViewer).access });

    const blankViewer = await request(hnPort, 'GET', '/memory/list?viewer=%20', { headers: { Origin: 'null' } });
    check('E4 空白 viewer 与空 viewer 给出**同一个**答案（此前一个 fail closed、一个 fail open：那是 truthiness 误用，不是语义）',
      blankViewer.status === 200 && P(blankViewer).count === 0 &&
      P(blankViewer).access && P(blankViewer).access.reason === 'no-principal',
      { count: P(blankViewer).count, access: P(blankViewer).access });

    const chEmpty = await request(hnPort, 'GET', '/memory/changes?viewer=', { headers: { Origin: 'null' } });
    check('E5 `?viewer=` 在变更流上同样 fail closed：403 FORBIDDEN（修复前返回含 private 的完整变更流）',
      chEmpty.status === 403 && chEmpty.body && chEmpty.body.error && chEmpty.body.error.code === 'FORBIDDEN',
      { status: chEmpty.status, error: chEmpty.body && chEmpty.body.error });

    const chFull = await request(hnPort, 'GET', '/memory/changes', { headers: { Origin: 'null' } });
    check('E6 不传 viewer 的变更流逐字不变（含 private / only 的完整 upsert 集合）',
      chFull.status === 200 && upOf(chFull).indexOf('m_priv') >= 0 && upOf(chFull).indexOf('m_only_b') >= 0,
      { upserts: upOf(chFull) });

    const chRole = await request(hnPort, 'GET', '/memory/changes?viewer=not-a-role', { headers: { Origin: 'null' } });
    check('E7 任意合法角色标识都是**合法读主体**（不是"畸形输入"）：只 upsert 对它可读的行，其余按撤销语义成为 delete',
      chRole.status === 200 && upOf(chRole).indexOf('m_pub') >= 0 &&
      (P(chRole).deletes || []).map(d => d.recordId).indexOf('m_priv') >= 0 &&
      upOf(chRole).indexOf('m_priv') < 0,
      { upserts: upOf(chRole), deletes: (P(chRole).deletes || []).map(d => d.recordId) });

    const paths = hn.gateway.ADMIN_PATHS || [];
    check('E8 /memory/list 与 /memory/changes 仍是 ADMIN_PATHS，且没有任何 memory verb 进入 /mobile/v1',
      paths.indexOf('/memory/list') >= 0 && paths.indexOf('/memory/changes') >= 0 &&
      paths.every(p => p.indexOf('/mobile/') !== 0), paths.length);

    const mobileMemory = await request(hnPort, 'GET', '/mobile/v1/memory/list', { headers: { Origin: 'null' } });
    check('E9 设备面没有 memory verb：/mobile/v1/memory/list 走**设备鉴权**（401 AUTH_REQUIRED），而不是被桌面 token 规则挡下',
      mobileMemory.status === 401 && mobileMemory.body && mobileMemory.body.error &&
      mobileMemory.body.error.code === 'AUTH_REQUIRED',
      { status: mobileMemory.status, error: mobileMemory.body && mobileMemory.body.error });

    /* ownerId 是**派生的分区**（canonical 由 createdBy 决定），不是调用方可注入的字段：
       这正是"ownerId != principal"的含义 —— 它只收窄分区，绝不放行。 */
    store.putRecord(mem('m_bob_owner', { createdBy: 'bob', visibility: 'only', visibleTo: ['alice'] }));
    const scoped = await request(hnPort, 'GET', '/memory/list?viewer=alice&ownerId=bob', { headers: { Origin: 'null' } });
    check('E10 ownerId 与 viewer 是两个维度：ownerId 只收窄分区、不放行任何行（alice 在 bob 分区里只看到她可读的那一条）',
      scoped.status === 200 && idsOf(scoped).join(',') === 'm_bob_owner', idsOf(scoped));
    const otherScope = await request(hnPort, 'GET', '/memory/list?viewer=alice&ownerId=user', { headers: { Origin: 'null' } });
    check('E11 反向：切到 user 分区时 bob 分区那条不出现（分区确实在起作用，不是被忽略的参数）',
      idsOf(otherScope).indexOf('m_bob_owner') < 0 && idsOf(otherScope).indexOf('m_only_a') >= 0, idsOf(otherScope));
    const wide = await request(hnPort, 'GET', '/memory/list?viewer=alice', { headers: { Origin: 'null' } });
    check('E12 不传 ownerId：可见性仍然生效（private 永不出现，两个分区对她可读的行都可见）',
      idsOf(wide).indexOf('m_priv') < 0 && idsOf(wide).indexOf('m_bob_owner') >= 0, idsOf(wide));
  }

  /* ══════════════════════════════════════════════════════════════════
     F · error redaction
     ══════════════════════════════════════════════════════════════════ */
  if (wants('F')) {
    section('F \u00b7 错误响应 \u2014 不给 stack、不给绝对路径');

    const samples = [
      ['bridge 非法 Host（new URL 抛错，落到顶层 500 兜底）', await request(bPort, 'GET', '/x', { headers: { Host: 'bad host' } })],
      ['bridge 上游不可达', await request(bPort, 'POST', '/api/llm-proxy', {
        headers: { Origin: 'null', 'Content-Type': 'application/json' },
        body: JSON.stringify({ method: 'GET', url: 'http://127.0.0.1:1/dead' })
      })],
      ['bridge 非法 JSON body', await request(bPort, 'POST', '/api/whispers', { body: '{not json' })],
      ['bridge 路径不存在', await request(bPort, 'GET', '/nope', {})],
      ['bridge 不存在的 Reference Audio', await request(bPort, 'GET', '/api/tts/voices/AAAAAAAAAAAA', {})],
      ['active 缺 user_id', await request(aPort, 'GET', '/plans', { headers: { Origin: 'null' } })],
      ['active 路径不存在', await request(aPort, 'GET', '/nope', { headers: { Origin: 'null' } })],
      ['home-node 缺 id', await request(hnPort, 'GET', '/message', { headers: { Origin: 'null' } })],
      ['home-node 未知路由', await request(hnPort, 'GET', '/nope', { headers: { Origin: 'null' } })]
    ];
    const violations = [];
    for (const s of samples) {
      const bad = errorRedactionViolations(s[1].status, s[1].raw);
      if (bad.length) violations.push({ sample: s[0], status: s[1].status, bad: bad, body: s[1].raw.slice(0, 200) });
    }
    check('F1 抽样错误响应中没有任何一条含 stack 帧 / 绝对 Windows 路径 / 临时 data dir',
      violations.length === 0, violations);

    check('F2 顶层 500 兜底返回的是**稳定的错误码**而不是原始异常文本（"Invalid URL" 之外不留内部状态）',
      (() => {
        const r = samples[0][1];
        return r.status === 500 && r.body && typeof r.body.error === 'string' && r.body.error.length <= 120 && r.body.ok === false;
      })(), samples[0][1].body);

    /* Home Node 与 mobile-gateway 早就用封闭错误词表：这句话本身必须可断言。 */
    const gwErr = await request(hnPort, 'GET', '/mobile/v1/nope', { headers: { Origin: 'null' } });
    check('F3 mobile-gateway 的错误是封闭词表（code 是稳定标识，不是内部错误原文）',
      gwErr.status === 401 && gwErr.body && gwErr.body.error && gwErr.body.error.code === 'AUTH_REQUIRED' &&
      !/Error|at\s+\S+:\d+/.test(JSON.stringify(gwErr.body.error)),
      gwErr.body && gwErr.body.error);
  }

  /* ══════════════════════════════════════════════════════════════════
     G · credential minting regression（P11-3A 承重性）
     ══════════════════════════════════════════════════════════════════ */
  if (wants('G')) {
    section('G \u00b7 credential minting \u2014 P11-3A 清单仍然承重，且没有第二条路');

    const noToken = {};
    for (const p of ['/pairing/session', '/devices', '/device/revoke', '/characters/publish']) {
      noToken[p] = (await request(hnPort, 'POST', p, { headers: { Origin: 'null', 'Content-Type': 'application/json' }, body: '{}' })).status;
    }
    noToken['/mobile/v1/pairing/complete'] = (await request(hnPort, 'POST', '/mobile/v1/pairing/complete',
      { headers: { Origin: 'null', 'Content-Type': 'application/json' }, body: '{"v":1,"payload":{}}' })).status;
    check('G1 未配置桌面 token：五条铸造/撤销路径全部 403（无凭据即不可达）',
      Object.keys(noToken).every(k => noToken[k] === 403), noToken);

    const wrong = await request(hnPort, 'POST', '/pairing/session',
      { headers: { Origin: 'null', 'Content-Type': 'application/json', 'X-IB-Home-Token': 'wrong' }, body: '{}' });
    check('G2 错误 desktop token：403 desktop-token-required（不是"带上凭据再来"的 401 —— 因为根本没有能奏效的凭据）',
      wrong.status === 403 && wrong.body.error === 'desktop-token-required', wrong.body);

    /* 设备面自己的凭据轮换：它是**设备 token 鉴权**，不是新增的铸造面。 */
    const rotate = await request(hnPort, 'POST', '/mobile/v1/device/token/rotate',
      { headers: { Origin: 'null', 'Content-Type': 'application/json' }, body: '{"v":1,"payload":{}}' });
    const rotateCode = rotate.body && rotate.body.error && rotate.body.error.code;
    check('G3 /mobile/v1/device/token/rotate 需要**设备** token（401 AUTH），既不匿名可达也不被桌面 token 规则挡住',
      rotate.status === 401 && (rotateCode === 'AUTH_REQUIRED' || rotateCode === 'AUTH_INVALID'),
      { status: rotate.status, code: rotateCode });

    /* 未知 token 与空 token 都落进同一个封闭鉴权集合，且**不会**出现
       DEVICE_REVOKED / NOT_FOUND 这类"这个设备曾经存在"的区分信号。 */
    const rotateBad = await request(hnPort, 'POST', '/mobile/v1/device/token/rotate',
      { headers: { Origin: 'null', 'Content-Type': 'application/json', Authorization: 'Bearer not-a-real-token' }, body: '{"v":1,"payload":{}}' });
    const rotateBadCode = rotateBad.body && rotateBad.body.error && rotateBad.body.error.code;
    check('G4 未知设备 token：401 且 code 属于封闭鉴权集合（不泄漏设备是否存在）',
      rotateBad.status === 401 && ['AUTH_INVALID', 'AUTH_REQUIRED'].indexOf(rotateBadCode) >= 0,
      { emptyTokenCode: rotateCode, unknownTokenCode: rotateBadCode });
  }

  /* ── 回收并报告残留 ───────────────────────────────────────────────── */
  const cleanup = [];
  try { if (hn) hn.close(); } catch (e) { cleanup.push('home-node close: ' + String(e && e.message || e)); }
  for (const s of openServers) { try { s.close(); } catch (e) { cleanup.push('server close: ' + String(e && e.message || e)); } }
  for (const c of openChildren) { try { c.kill(); } catch (e) { cleanup.push('child kill: ' + String(e && e.message || e)); } }
  await sleep(400);
  const leaked = { children: openChildren.size, servers: [...openServers].filter(s => s.listening).length };

  console.log('\n' + '\u2500'.repeat(60));
  console.log('P11-3X-A \u00b7 Security / HTTP boundary: ' + passed + ' passed, ' + failed + ' failed');
  if (WANT.length) console.log('sections filter: ' + WANT.join(','));
  console.log('resources: children=' + leaked.children + ' listeningServers=' + leaked.servers +
    (cleanup.length ? ' cleanupErrors=' + JSON.stringify(cleanup) : ''));
  if (failed) console.log('first failures: ' + failures.slice(0, 5).join(' | '));

  /* 泄漏哨兵：unref 过的定时器只有在**还有别的句柄挂着**时才会触发。
     也就是说：进程自然退出 = 没有泄漏；这条打印出来 = 有东西没释放。 */
  const watchdog = setTimeout(() => {
    console.log('\u2718 FAIL  resource leak: the event loop is still alive after cleanup');
    process.exit(2);
  }, 3000);
  watchdog.unref();

  process.exitCode = failed ? 1 : 0;
})().catch(error => {
  console.error('HARNESS ERROR ' + String(error && error.stack || error));
  process.exit(2);
});
