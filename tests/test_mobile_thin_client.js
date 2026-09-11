'use strict';
/* ====================================================================
   Internal Beyond · M1-B Thin Client 端到端验收（service 组）
   运行：node tests/test_mobile_thin_client.js

   这个文件扮演**未来 Android 客户端**的角色：一个普通 HTTP/SSE 客户端，
   没有任何 IB UI、没有任何 IB 库、不使用 IB 的浏览器代码。

   它真实 spawn services/home-node-service.js（随机端口 + 临时数据目录），
   真实起一个 SSE mock provider，然后完整走一遍：
     pair → authenticate → character.list → chat.history → chat.send
     → streaming deltas → reconnect/resume → sync.changes
     → retry 同 requestId → 撤销 → 危险路由不可达 → secret 不泄漏

   这是 Phase 30 的 "Chat / Protocol / Security / Character" 四组的集成面，
   也是 Acceptance Criteria 里"测试 client 能完成整条链路"的直接证据。
   ==================================================================== */
const assert = require('assert');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const ADMIN_TOKEN = 'test-home-node-admin-token';
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-mobile-'));

let passed = 0, failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log('✔ ' + name); }
  else { failed++; console.error('✖ ' + name + (extra !== undefined ? ' — ' + JSON.stringify(extra) : '')); }
}

function freePort() {
  return new Promise(resolve => {
    const server = net.createServer();
    server.unref();
    server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); });
  });
}

/* ── 普通 HTTP 客户端：不依赖任何 IB 代码 ───────────────────────────── */
function request(base, method, urlPath, options) {
  options = options || {};
  return new Promise((resolve, reject) => {
    const data = options.body == null ? null
      : (typeof options.body === 'string' ? options.body : JSON.stringify(options.body));
    const headers = Object.assign({}, options.headers || {});
    if (data && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
    if (data) headers['Content-Length'] = Buffer.byteLength(data);
    const req = http.request(base + urlPath, { method: method, headers: headers }, res => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', c => raw += c);
      res.on('end', () => {
        let parsed = null;
        try { parsed = raw ? JSON.parse(raw) : {}; } catch (_) { parsed = { raw: raw }; }
        resolve({ status: res.statusCode, body: parsed, headers: res.headers, raw: raw });
      });
      res.on('error', error => resolve({ status: 0, body: null, error: String(error && error.message || error), raw: '' }));
    });
    /* 连接层错误（含服务端被我们主动断开后的 ECONNRESET）同样解析成一个
       明确的结果对象，而不是 reject —— reject 会让失败信息变成一句
       "read ECONNRESET"，指不出是哪一个请求。 */
    req.on('error', error => resolve({ status: 0, body: null, error: String(error && error.message || error), raw: '' }));
    if (data) req.write(data);
    req.end();
  });
}

/* SSE 流读取：解析 event:/id:/data: 三行组。
   stopWhen 返回 true 时主动销毁连接（模拟"客户端中途断线"）。 */
function readStream(base, method, urlPath, options) {
  options = options || {};
  return new Promise((resolve, reject) => {
    const data = options.body == null ? null
      : (typeof options.body === 'string' ? options.body : JSON.stringify(options.body));
    const headers = Object.assign({ Accept: 'text/event-stream' }, options.headers || {});
    if (data && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
    if (data) headers['Content-Length'] = Buffer.byteLength(data);
    const frames = [];
    let buffer = '';
    let status = 0;
    let settled = false;
    const req = http.request(base + urlPath, { method: method, headers: headers }, res => {
      status = res.statusCode;
      if (status !== 200) {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', c => raw += c);
        res.on('end', () => {
          if (settled) return;
          settled = true;
          let parsed = null;
          try { parsed = JSON.parse(raw); } catch (_) { parsed = { raw: raw }; }
          resolve({ status: status, frames: frames, body: parsed, aborted: false });
        });
        return;
      }
      res.setEncoding('utf8');
      res.on('data', chunk => {
        buffer += chunk;
        let index;
        while ((index = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          const frame = parseFrame(block);
          if (frame) {
            frames.push(frame);
            if (options.stopWhen && options.stopWhen(frame, frames)) {
              if (!settled) { settled = true; try { req.destroy(); } catch (_) { /* 已销毁 */ } resolve({ status: status, frames: frames, aborted: true }); }
              return;
            }
          }
        }
      });
      res.on('end', () => {
        if (settled) return;
        settled = true;
        resolve({ status: status, frames: frames, aborted: false });
      });
      /* 我们主动 destroy 时，Windows 上可能先抛 ECONNRESET 而不是干净的 end。
         没有这个 handler 时它就是一个 unhandled 'error' 事件，直接把测试打死。 */
      res.on('error', () => { /* 主动断开产生的噪声，忽略 */ });
    });    req.on('error', error => {
      if (settled) return;
      settled = true;
      if (frames.length) resolve({ status: status, frames: frames, aborted: true, error: String(error && error.message || error) });
      else reject(error);
    });
    req.on('timeout', () => { try { req.destroy(); } catch (_) { /* 已销毁 */ } });
    if (options.timeoutMs) req.setTimeout(options.timeoutMs, () => { try { req.destroy(); } catch (_) { /* 已销毁 */ } });
    if (data) req.write(data);
    req.end();
  });
}
function parseFrame(block) {
  const lines = String(block).split('\n');
  let event = null, id = null;
  const dataLines = [];
  for (const line of lines) {
    if (line.indexOf('event:') === 0) event = line.slice(6).trim();
    else if (line.indexOf('id:') === 0) id = line.slice(3).trim();
    else if (line.indexOf('data:') === 0) dataLines.push(line.slice(5).trim());
    else if (line.charAt(0) === ':') { /* 注释（心跳） */ }
  }
  if (!event && !dataLines.length) return null;
  let payload = null;
  try { payload = dataLines.length ? JSON.parse(dataLines.join('\n')) : null; } catch (_) { payload = { raw: dataLines.join('\n') }; }
  return { event: event, id: id, data: payload };
}
function sequenceOfFrame(frame) {
  return frame && frame.data && typeof frame.data.sequence === 'number' ? frame.data.sequence : null;
}

function waitForHealth(base, timeoutMs) {
  const started = Date.now();
  return new Promise(resolve => {
    const tick = () => {
      request(base, 'GET', '/health').then(r => {
        if (r.status === 200 && r.body && r.body.ok) return resolve(r.body);
        retry();
      }, retry);
    };
    const retry = () => {
      if (Date.now() - started > timeoutMs) return resolve(null);
      setTimeout(tick, 150);
    };
    tick();
  });
}

/* ── SSE mock provider（OpenAI 兼容流）──────────────────────────────── */
function mockProvider(script, opts) {
  opts = opts || {};
  const seen = { bodies: [], paths: [] };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => raw += c);
    req.on('end', () => {
      seen.paths.push(req.url);
      try { seen.bodies.push(JSON.parse(raw)); } catch (_) { seen.bodies.push(raw); }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const pieces = script.split('\u0000');
      let i = 0;
      const next = () => {
        if (i >= pieces.length) { res.end(); return; }
        res.write(pieces[i++]);
        setTimeout(next, opts.chunkDelayMs == null ? 5 : opts.chunkDelayMs);
      };
      next();
    });
  });
  return { server: server, seen: seen };
}
const chunk = (delta, extra) => 'data: ' + JSON.stringify(Object.assign({ choices: [{ delta: delta }] }, extra || {})) + '\n\n';

/* 该角色的唯一 persona marker：既是"隐藏值不得出站"的证据（thin.6），
   也是"隐藏值必须进 provider 请求"的证据（thin.9b）。同一个常量守住信任边界两侧 ——
   只测得出泄漏、测不出送达，正是 M1-C.2a 之所以能潜伏的原因。 */
const PERSONA_MARKER_A = 'PERSONA-MARKER-A-M1C2A';

/* provider 真正收到的 system 文本（wire-shape 兼容）。
   与 test_model_core_contract.js:65 / :95 / :106 的取法同一语义：
     openai    → messages[] 里 role==='system' 的 content 拼合
     anthropic → 顶层 body.system
     gemini    → body.system_instruction.parts[].text
   格式判定委托生产 core 的 IBModelCore.providerFormat，不在此处复制一套 wire 假设。
   本测试的 provider 都是 'custom' → providerFormat 归为 openai（core 的既有行为）。 */
function systemTextOf(body, provider) {
  if (!body || typeof body !== 'object') return '';
  let fmt;
  if (provider != null && provider !== '') {
    try { fmt = require(path.join(ROOT, 'assets', 'js', 'ib-model-core.js')).providerFormat(provider); }
    catch (_) { fmt = 'openai'; }
  } else {
    fmt = body.system_instruction ? 'gemini' : (typeof body.system === 'string' ? 'anthropic' : 'openai');
  }
  const textOf = (content) => {
    if (content == null) return '';
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) return content.map(p => (typeof p === 'string' ? p : (p && p.text) || '')).filter(Boolean).join('\n');
    if (typeof content === 'object' && typeof content.text === 'string') return content.text;
    return '';
  };
  if (fmt === 'gemini') {
    const si = body.system_instruction;
    if (!si) return '';
    if (Array.isArray(si.parts)) return si.parts.map(p => (p && p.text) || '').filter(Boolean).join('\n');
    return textOf(si);
  }
  if (fmt === 'anthropic' && typeof body.system === 'string') return body.system;
  const msgs = Array.isArray(body.messages) ? body.messages : [];
  return msgs.filter(m => m && m.role === 'system').map(m => textOf(m.content)).filter(Boolean).join('\n\n');
}

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

(async () => {
  const servicePort = await freePort();
  const BASE = 'http://127.0.0.1:' + servicePort;
  const provider = mockProvider([
    chunk({ reasoning_content: '想' }),
    chunk({ content: '你' }),
    chunk({ content: '好' }),
    chunk({}, { choices: [{ delta: {}, finish_reason: 'stop' }] }),
    'data: [DONE]\n\n'
  ].join('\u0000'), { chunkDelayMs: 25 });
  const providerPort = await listen(provider.server);
  const providerEndpoint = 'http://127.0.0.1:' + providerPort + '/v1/chat/completions';

  /* 长流 provider：用于"断线不取消生成"的验证（慢到足以在生成中挂断）。 */
  const slowProvider = mockProvider([
    chunk({ content: 'A' }), chunk({ content: 'B' }), chunk({ content: 'C' }),
    chunk({ content: 'D' }), chunk({ content: 'E' }),
    'data: [DONE]\n\n'
  ].join('\u0000'), { chunkDelayMs: 120 });
  const slowPort = await listen(slowProvider.server);
  const slowEndpoint = 'http://127.0.0.1:' + slowPort + '/v1/chat/completions';

  const child = spawn(process.execPath, [path.join('services', 'home-node-service.js')], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      IB_HOME_NODE_PORT: String(servicePort),
      IB_HOME_NODE_HOST: '127.0.0.1',
      IB_HOME_NODE_DATA_DIR: DATA_DIR,
      IB_HOME_NODE_TOKEN: ADMIN_TOKEN
    }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let serviceOut = '';
  child.stdout.on('data', c => serviceOut += c);
  child.stderr.on('data', c => serviceOut += c);

  const adminHeaders = { 'X-IB-Home-Token': ADMIN_TOKEN };
  let deviceToken = '';
  let deviceId = '';

  try {
    const health = await waitForHealth(BASE, 12000);
    check('thin.health 服务起来且身份正确', !!(health && health.service === 'internal-beyond-home-node'), health);
    if (!health) throw new Error('service did not start: ' + serviceOut.slice(-800));

    /* ── 1 · 发布角色目录（桌面内部 API；mobile 面只读不写）────────────
       模拟桌面把 apiConfigs 交给 Home Node。刻意塞进 apiKey / imageGenApiKey
       等凭据，用来证明它们**不会**出现在任何 mobile 响应里。 */
    const publish = await request(BASE, 'POST', '/characters/publish', {
      headers: adminHeaders,
      body: {
        characters: [
          {
            id: 'friend_test_a',
            nickname: '小满',
            avatar: 'data:image/png;base64,AAAA',
            relationship: '同桌',
            handle: 'xiaoman',
            signature: '今天也要开心',
            bio: '喜欢下雨天',
            banner: 'data:image/png;base64,BBBB',
            model: 'mock-model',
            provider: 'custom',
            endpoint: providerEndpoint,
            apiKey: 'sk-SECRET-should-never-leak',
            imageGenApiKey: 'sk-IMAGEGEN-should-never-leak',
            systemPrompt: '你是小满，' + PERSONA_MARKER_A,
            temperature: 0.7,
            vision: true,
            streaming: true,
            webSearch: false,
            imageGen: true
          },
          {
            id: 'friend_test_b',
            nickname: '阿遥',
            model: 'mock-model',
            provider: 'custom',
            endpoint: providerEndpoint,
            apiKey: 'sk-ANOTHER-secret',
            systemPrompt: 'HIDDEN-B',
            streaming: true
          },
          {
            /* 慢速角色：唯一用途是"生成还没结束时客户端断线"（thin.12）。
               它指向一个每帧延迟 120ms 的 provider，因此断开时回合一定还在跑。
               必须是**独立角色**（独立会话）—— 同一个会话同时只允许一个 in-flight
               turn，用同一个角色发第二条消息会拿到 busy。 */
            id: 'friend_test_slow',
            nickname: '慢慢',
            model: 'mock-model',
            provider: 'custom',
            endpoint: slowEndpoint,
            apiKey: 'sk-SLOW-secret',
            systemPrompt: 'HIDDEN-SLOW',
            streaming: true
          }
        ]
      }
    });
    check('thin.1 桌面发布角色目录成功', publish.status === 200 && publish.body.ok && publish.body.payload.count === 3, publish.body);
    check('thin.1 发布带上了可运行配置（withSpec 3）', publish.body.payload.withSpec === 3, publish.body.payload);
    check('thin.1 发布响应不含任何 apiKey', publish.raw.indexOf('sk-SECRET') < 0 && publish.raw.indexOf('sk-IMAGEGEN') < 0, publish.raw.slice(0, 400));

    /* ── 2 · 创建配对会话（桌面）────────────────────────────────────── */
    const session = await request(BASE, 'POST', '/pairing/session', {
      headers: adminHeaders,
      body: { deviceName: 'My Android', deviceType: 'android' }
    });
    check('thin.2 pairing session 创建成功', session.status === 200 && session.body.ok, session.body);
    const pairing = session.body.payload;
    check('thin.2 pairing secret 是高熵随机（≥32 字符）', typeof pairing.secret === 'string' && pairing.secret.length >= 32, pairing && pairing.secret && pairing.secret.length);
    check('thin.2 pairing 有明确 TTL', pairing.expiresAt > Date.now() && pairing.ttlMs > 0, { expiresAt: pairing.expiresAt, ttlMs: pairing.ttlMs });
    check('thin.2 pairingId 不是 6 位数字码', !/^\d{1,8}$/.test(String(pairing.pairingId)), pairing.pairingId);
    check('thin.2 loopback 绑定时如实声明 LAN 不可达', pairing.lanReachable === false, pairing.lanReachable);

    /* ── 3 · pair（未认证，凭 pairing secret）───────────────────────── */
    const unauth = await request(BASE, 'POST', '/mobile/v1/pairing/complete', {
      body: { v: 1, type: 'pairing.complete', payload: { pairingId: pairing.pairingId, secret: 'wrong-secret', deviceName: 'X' } }
    });
    check('thin.3 错误 pairing secret 被拒', unauth.status === 403 && unauth.body.error.code === 'PAIRING_INVALID', unauth.body);

    const paired = await request(BASE, 'POST', '/mobile/v1/pairing/complete', {
      body: {
        v: 1, type: 'pairing.complete', requestId: 'req-pair-1',
        payload: { pairingId: pairing.pairingId, secret: pairing.secret, deviceName: 'My Android', deviceType: 'android' }
      }
    });
    check('thin.3 pair 成功并签发设备凭据', paired.status === 200 && paired.body.ok && typeof paired.body.payload.token === 'string', paired.body);
    deviceToken = paired.body.payload.token;
    deviceId = paired.body.payload.device.deviceId;
    check('thin.3 deviceId 是独立的 dev_ 前缀标识', /^dev_/.test(deviceId), deviceId);
    check('thin.3 凭据带格式版本段（rotation 路径）', /^ibd1_/.test(deviceToken), deviceToken.slice(0, 8));
    check('thin.3 设备 DTO 不含 token / token_hash',
      paired.body.payload.device.token === undefined && paired.body.payload.device.tokenHash === undefined,
      Object.keys(paired.body.payload.device));
    const auth = { Authorization: 'Bearer ' + deviceToken };

    /* ── 4 · pairing 单次使用 ───────────────────────────────────────── */
    const reuse = await request(BASE, 'POST', '/mobile/v1/pairing/complete', {
      body: { v: 1, payload: { pairingId: pairing.pairingId, secret: pairing.secret, deviceName: 'Y' } }
    });
    check('thin.4 同一个 pairing 不能第二次使用', reuse.status === 409 && reuse.body.error.code === 'PAIRING_USED', reuse.body);

    /* ── 5 · authenticate（未认证请求必须被拒）─────────────────────── */
    const noAuth = await request(BASE, 'GET', '/mobile/v1/character/list');
    check('thin.5 未认证的 mobile 请求被拒（AUTH_REQUIRED）', noAuth.status === 401 && noAuth.body.error.code === 'AUTH_REQUIRED', noAuth.body);
    const badAuth = await request(BASE, 'GET', '/mobile/v1/character/list', { headers: { Authorization: 'Bearer ibd1_notarealtoken_atall_xxxxxxxx' } });
    check('thin.5 伪造 token 被拒（AUTH_INVALID）', badAuth.status === 401 && badAuth.body.error.code === 'AUTH_INVALID', badAuth.body);

    const handshake = await request(BASE, 'GET', '/mobile/v1/handshake', { headers: auth });
    check('thin.5 handshake 返回协议与同步模型', handshake.status === 200 && handshake.body.payload.protocol === 1 &&
      handshake.body.payload.sync.cursorModel === 'home-node-revision', handshake.body);

    const self = await request(BASE, 'GET', '/mobile/v1/device/self', { headers: auth });
    check('thin.5 device.self 返回自己且不含凭据', self.status === 200 && self.body.payload.device.deviceId === deviceId &&
      self.body.payload.device.token === undefined, self.body);

    /* ── 6 · character.list / get：mobile-safe DTO ─────────────────── */
    const characters = await request(BASE, 'GET', '/mobile/v1/character/list', { headers: auth });
    check('thin.6 character.list 返回三个角色', characters.status === 200 && characters.body.payload.count === 3, characters.body.payload && characters.body.payload.count);
    const first = characters.body.payload.characters.find(c => c.id === 'friend_test_a');
    check('thin.6 DTO 暴露显示身份', first && first.name === '小满' && first.relationship === '同桌' && first.handle === 'xiaoman', first);
    check('thin.6 DTO 暴露能力位', first && first.capabilities && first.capabilities.vision === true && first.capabilities.imageGen === true, first && first.capabilities);
    check('thin.6 二次投影不丢字段（发布 → 落库 → 出站仍一致）',
      first && first.name === '小满' && first.bio === '喜欢下雨天' && first.capabilities.stream === true, first);
    /* Phase 27：secret-leak 契约（针对 character / chat / status DTO）。 */
    const leakRegex = /apiKey|api_key|authorization|bearer|"secret"|credential|sk-[A-Za-z0-9]/i;
    check('thin.6 character.list 响应树里没有 secret 形状',
      !leakRegex.test(characters.raw), characters.raw.slice(0, 600));
    /* Phase 27 + M1-C.2a：同一份 persona 值 —— 出站不得出现，入 provider 必须出现。 */
    check('thin.6 character.list 不含隐藏 systemPrompt', characters.raw.indexOf(PERSONA_MARKER_A) < 0, characters.raw.slice(0, 600));
    check('thin.6 character.list 不含 endpoint', characters.raw.indexOf('127.0.0.1:' + providerPort) < 0, characters.raw.slice(0, 600));

    const one = await request(BASE, 'GET', '/mobile/v1/character/friend_test_a', { headers: auth });
    check('thin.6 character.get 单条安全', one.status === 200 && one.body.payload.character.id === 'friend_test_a' &&
      !leakRegex.test(one.raw) && one.raw.indexOf(PERSONA_MARKER_A) < 0, one.raw.slice(0, 400));

    const missing = await request(BASE, 'GET', '/mobile/v1/character/nope', { headers: auth });
    check('thin.6 不存在的角色返回 NOT_FOUND', missing.status === 404 && missing.body.error.code === 'NOT_FOUND', missing.body);

    /* ── 7 · chat.history（读 canonical store）─────────────────────── */
    const emptyHistory = await request(BASE, 'GET', '/mobile/v1/chat/history?characterId=friend_test_a', { headers: auth });
    check('thin.7 空会话 history 可读', emptyHistory.status === 200 && emptyHistory.body.payload.count === 0, emptyHistory.body.payload);

    /* 会话隔离：其它角色的历史是**另一条** conversation，不串台。 */
    const otherHistory = await request(BASE, 'GET', '/mobile/v1/chat/history?characterId=friend_test_b', { headers: auth });
    const slowHistory = await request(BASE, 'GET', '/mobile/v1/chat/history?characterId=friend_test_slow', { headers: auth });
    check('thin.7 conversationId 精确隔离（每个角色自己的会话）',
      otherHistory.body.payload.count === 0 && slowHistory.body.payload.count === 0 &&
      otherHistory.body.payload.conversationId === 'dm:friend_test_b' &&
      slowHistory.body.payload.conversationId === 'dm:friend_test_slow',
      { b: otherHistory.body.payload.conversationId, slow: slowHistory.body.payload.conversationId });

    /* ── 8 · protocol version 语义（Phase 9：v 必须真的被读）────────── */
    const noVersion = await request(BASE, 'POST', '/mobile/v1/chat/send', {
      headers: auth, body: { payload: { characterId: 'friend_test_a', content: 'hi' } }
    });
    check('thin.8 缺 v 被拒（BAD_VERSION）', noVersion.status === 400 && noVersion.body.error.code === 'BAD_VERSION', noVersion.body);

    const badVersion = await request(BASE, 'POST', '/mobile/v1/chat/send', {
      headers: auth, body: { v: 2, requestId: 'r', payload: { characterId: 'friend_test_a', content: 'hi' } }
    });
    check('thin.8 不支持 v 被拒（BAD_VERSION）', badVersion.status === 400 && badVersion.body.error.code === 'BAD_VERSION' &&
      badVersion.body.error.detail === '2', badVersion.body);

    const unknownVerb = await request(BASE, 'POST', '/mobile/v1/does/not/exist', {
      headers: auth, body: { v: 1, requestId: 'r' }
    });
    check('thin.8 未知 verb 被拒（UNKNOWN_VERB）', unknownVerb.status === 404 && unknownVerb.body.error.code === 'UNKNOWN_VERB', unknownVerb.body);

    const badPayload = await request(BASE, 'POST', '/mobile/v1/chat/send', {
      headers: auth, body: { v: 1, requestId: 'r-nocontent', payload: { characterId: 'friend_test_a' } }
    });
    check('thin.8 缺内容的 send 被拒', badPayload.status === 400 && badPayload.body.error.code === 'BAD_REQUEST', badPayload.body);

    const noCharacter = await request(BASE, 'POST', '/mobile/v1/chat/send', {
      headers: auth, body: { v: 1, requestId: 'r-nochar', payload: { content: 'hi' } }
    });
    check('thin.8 缺 characterId 的 send 被拒（客户端不能自选会话键）',
      noCharacter.status === 400 && noCharacter.body.error.code === 'BAD_REQUEST', noCharacter.body);

    /* ── 9 · chat.send + 流式（同一个请求内 SSE）───────────────────── */
    const streams = await readStream(BASE, 'POST', '/mobile/v1/chat/send', {
      headers: auth,
      timeoutMs: 15000,
      body: {
        v: 1, type: 'chat.send', requestId: 'req-send-1', payload: {
          characterId: 'friend_test_a', content: '你好呀'
        }
      }
    });
    check('thin.9 chat.send 直接返回 SSE 流（Accept）', streams.status === 200, streams.status);
    const names = streams.frames.map(f => f.event);
    check('thin.9 事件顺序 start → delta* → done',
      names[0] === 'chat.start' && names[names.length - 1] === 'chat.done' && names.indexOf('chat.delta') > 0, names);
    const deltas = streams.frames.filter(f => f.event === 'chat.delta');
    const reasoning = deltas.filter(f => f.data.payload.kind === 'reasoning');
    const content = deltas.filter(f => f.data.payload.kind === 'content');
    check('thin.9 reasoning 与 content 用同一 delta 事件 + kind 区分',
      reasoning.length === 1 && content.length === 2, { reasoning: reasoning.length, content: content.length });
    check('thin.9 流式正文拼接正确', content.map(f => f.data.payload.text).join('') === '你好', content.map(f => f.data.payload.text));
    const startFrame = streams.frames[0].data;
    const doneFrame = streams.frames[streams.frames.length - 1].data;
    check('thin.9 每个事件都可关联 requestId/conversationId/turnId',
      startFrame.payload.requestId === 'req-send-1' &&
      startFrame.payload.conversationId === 'dm:friend_test_a' &&
      typeof startFrame.payload.turnId === 'string' && startFrame.payload.turnId.length > 4, startFrame.payload);
    check('thin.9 done 携带 canonical assistant 消息', !!(doneFrame.payload.message && doneFrame.payload.message.content === '你好'), doneFrame.payload);
    check('thin.9 done 携带 assistantMessageId 与 revision',
      typeof doneFrame.payload.assistantMessageId === 'string' && doneFrame.payload.revision >= 2, doneFrame.payload);
    check('thin.9 sequence 单调递增（可检测缺帧/重复帧）',
      streams.frames.every((f, i) => i === 0 || sequenceOfFrame(f) > sequenceOfFrame(streams.frames[i - 1])),
      streams.frames.map(sequenceOfFrame));
    const turnId = startFrame.payload.turnId;
    const assistantId = doneFrame.payload.assistantMessageId;

    /* ── 9b · M1-C.2a · 人格真的送到了 provider 吗 ────────────────────
       上面整段 E2E 到此只**数过** provider 被调用几次（thin.11 的幂等断言），
       从没看过它收到什么 —— 于是"角色人格整段丢失、模型裸奔"可以 100% 通过。
       这里补第二道断言：真实 publish → pair → chat.send 之后，provider 收到的
       system 必须非空，且含测试角色唯一的 persona marker。 */
    check('thin.9b chat.send 真的调用了 provider（非零次）', provider.seen.bodies.length >= 1, provider.seen.bodies.length);
    const sentBody = provider.seen.bodies[0];
    const sentSystem = systemTextOf(sentBody, 'custom');
    check('thin.9b provider wire 上的 system 非空（M1-C.2a 修复的人格送达）',
      sentSystem.length > 0, { len: sentSystem.length });
    check('thin.9b provider wire 的 system 含该角色的唯一 persona marker',
      sentSystem.indexOf(PERSONA_MARKER_A) > -1, { len: sentSystem.length, head: sentSystem.slice(0, 40) });
    check('thin.9b provider wire 的 system 以发布的 spec.systemPrompt 开头',
      sentSystem.indexOf('你是小满，' + PERSONA_MARKER_A) === 0, { len: sentSystem.length, head: sentSystem.slice(0, 60) });
    /* M1-C.2c-A（P0 角色连续性）之后 system 不再**只有** persona：Node 会在尾部
       追加运行上下文（用户身份/称呼/关系/当前时间）。所以这条断言从"严格相等"
       改成"persona 是前缀 + 尾部只追加 P0 块"，仍然守住 M1-C.2a 的那个不变式
       （人格绝不被丢弃/替换），同时不再把"system 必须恰好等于 systemPrompt"
       这个已经过时的形状当成契约。P0 各事实的完整断言在
       tests/test_mobile_p0_continuity.js。 */
    const systemTail = sentSystem.slice(('你是小满，' + PERSONA_MARKER_A).length);
    check('thin.9b system 尾部只追加 P0 运行上下文（人格前缀未被改写）',
      systemTail === '' || /^\n\n(当前时间：|【对方的个人资料】|称呼：|你和对方的关系是：)/.test(systemTail),
      { tail: systemTail.slice(0, 120) });
    check('thin.9b 会话历史里的 user 正文仍在（人格与消息各自到位）',
      (sentBody.messages || []).some(m => m.role === 'user' && m.content === '你好呀'));

    /* ── 9c · 信任边界不变式（与 9b 成对）──────────────────────────────
       这次修复只允许 persona 沿 Node runtime spec → Node provider request 移动。
       **同一个值**绝不能出现在任何 Android 可见的响应里 —— 也不得带出 endpoint
       凭据或 systemPrompt 字段名。9b 证明"送得进去"，9c 证明"漏不出来"，
       两道合起来才排除"为了让 9b 通过而把人格拉进 DTO"这种最危险的修法。
       （读流是流式的、没有 raw 缓存，所以对已解析的帧做逐帧检查。） */
    const streamFramesJson = JSON.stringify(streams.frames);
    check('thin.9c SSE 流里不含 persona / systemPrompt 字段 / endpoint 凭据',
      streamFramesJson.indexOf(PERSONA_MARKER_A) < 0 &&
      !/systemPrompt|system_prompt/i.test(streamFramesJson) &&
      streamFramesJson.indexOf('sk-SECRET-should-never-leak') < 0 &&
      streamFramesJson.indexOf('sk-IMAGEGEN-should-never-leak') < 0, streamFramesJson.slice(0, 400));

    /* ── 10 · chat DTO：无 runtime-only 字段、无 secret ─────────────── */
    const history = await request(BASE, 'GET', '/mobile/v1/chat/history?characterId=friend_test_a', { headers: auth });
    check('thin.10 history 能读到两条 canonical 消息', history.status === 200 && history.body.payload.count === 2, history.body.payload && history.body.payload.count);
    const dtoMessages = history.body.payload.messages;
    check('thin.10 user 消息 id 由 requestId 确定性推导',
      dtoMessages[0].id === 'msg_req_' + require(path.join(ROOT, 'assets/js/chat-core.js')).stableToken('req-send-1') + '_u', dtoMessages[0].id);
    check('thin.10 assistant 消息 = canonical id', dtoMessages[1].id === assistantId, { got: dtoMessages[1].id, expected: assistantId });
    check('thin.10 chat DTO 不携带 reasoning_content / wsSearches / memOps',
      dtoMessages.every(m => m.reasoning_content === undefined && m.wsSearches === undefined && m.memOps === undefined && m.calNotes === undefined),
      Object.keys(dtoMessages[1]));
    check('thin.10 chat DTO 保留展示用 metadata', !!(dtoMessages[1].metadata && dtoMessages[1].metadata.model_id === 'mock-model'), dtoMessages[1].metadata);
    check('thin.10 chat.history 不含 persona / systemPrompt 字段 / endpoint 凭据',
      history.raw.indexOf(PERSONA_MARKER_A) < 0 &&
      !/systemPrompt|system_prompt/i.test(history.raw) &&
      history.raw.indexOf('sk-SECRET-should-never-leak') < 0 &&
      history.raw.indexOf('127.0.0.1:' + providerPort) < 0, history.raw.slice(0, 400));
    check('thin.10 分页锚点与 M1-A 一致（cursor/oldest/hasMore）',
      history.body.payload.cursor && history.body.payload.oldest && history.body.payload.hasMore === false, Object.keys(history.body.payload));
    check('thin.10 chat.history 响应树里没有 secret 形状（含 sk-）',
      !leakRegex.test(history.raw) && history.raw.indexOf('sk-') < 0, history.raw.slice(0, 500));

    /* ── 11 · 幂等：同 requestId 重试 ─────────────────────────────── */
    const modelCallsBefore = provider.seen.bodies.length;
    const retry = await request(BASE, 'POST', '/mobile/v1/chat/send', {
      headers: auth,
      body: { v: 1, requestId: 'req-send-1', payload: { characterId: 'friend_test_a', content: '你好呀' } }
    });
    check('thin.11 同 requestId 重试不再新建回合', retry.status === 200 && retry.body.payload.duplicateRequest === true, retry.body);
    check('thin.11 重试返回同一个 userMessageId 与 assistantMessageId',
      retry.body.payload.userMessageId === doneFrame.payload.userMessageId &&
      retry.body.payload.result && retry.body.payload.result.assistantMessageId === assistantId, retry.body.payload);
    await new Promise(r => setTimeout(r, 400));
    check('thin.11 重试**没有**再调用模型', provider.seen.bodies.length === modelCallsBefore,
      { before: modelCallsBefore, after: provider.seen.bodies.length });
    const afterRetryHistory = await request(BASE, 'GET', '/mobile/v1/chat/history?characterId=friend_test_a', { headers: auth });
    check('thin.11 重试**没有**插入第二条 user/assistant 消息',
      afterRetryHistory.body.payload.count === 2, afterRetryHistory.body.payload.count);

    /* ── 12 · 断线不取消生成；重连后能拿到结果 ─────────────────────── */
    const slowSend = await request(BASE, 'POST', '/mobile/v1/chat/send', {
      headers: auth,
      body: { v: 1, requestId: 'req-slow-1', payload: { characterId: 'friend_test_slow', content: '慢慢说' } }
    });
    check('thin.12 返回 202 + streamUrl + 断线语义', slowSend.status === 202 &&
      slowSend.body.payload.disconnectPolicy === 'generation-continues' &&
      /^\/mobile\/v1\/chat\/stream\//.test(slowSend.body.payload.streamUrl), slowSend.body.payload);
    const slowTurnId = slowSend.body.payload.turnId;

    /* 接上流，收到第 2 个 content delta 就**粗暴断开**（模拟手机锁屏/切换网络）。 */
    const partial = await readStream(BASE, 'GET', '/mobile/v1/chat/stream/' + encodeURIComponent(slowTurnId), {
      headers: auth,
      timeoutMs: 15000,
      stopWhen: (frame) => frame.event === 'chat.delta'
    });
    check('thin.12 断线前确实收到了部分 delta', partial.aborted === true && partial.frames.filter(f => f.event === 'chat.delta').length >= 1,
      partial.frames.map(f => f.event + ':' + sequenceOfFrame(f)));
    const maxSeen = Math.max.apply(null, partial.frames.map(sequenceOfFrame).filter(n => n != null));

    /* 断开后立刻重连：应该回放缺失的帧。客户端拿到的可能是
       "回放 + 剩余实时帧 + chat.done"，也可能回放时回合刚好已经结束 —— 
       两种都必须以 done 收尾（这是"断线后总能收敛到一个终态"的断言）。 */
    const resumed = await readStream(BASE, 'GET', '/mobile/v1/chat/stream/' + encodeURIComponent(slowTurnId) + '?after=' + maxSeen, {
      headers: auth,
      timeoutMs: 20000
    });
    const resumedNames = resumed.frames.map(f => f.event);
    check('thin.12 重连后回放缺失帧并最终收到 chat.done',
      resumed.frames.length > 0 && resumedNames[resumedNames.length - 1] === 'chat.done', resumedNames);
    const replayedSeq = resumed.frames.map(sequenceOfFrame).filter(n => n != null);
    check('thin.12 回放的帧序号严格大于客户端已确认的位置（不重复投递）',
      replayedSeq.every(n => n > maxSeen), { maxSeen: maxSeen, replayed: replayedSeq });
    const slowDone = resumed.frames[resumed.frames.length - 1].data;
    check('thin.12 断线期间生成**继续**并已写入 canonical（完整正文 ABCDE）',
      slowDone.payload.message && slowDone.payload.message.content === 'ABCDE',
      slowDone.payload.message && slowDone.payload.message.content);

    /* 已结束的回合再连一次：应当立刻拿到 done（不悬着）。 */
    const afterDone = await readStream(BASE, 'GET', '/mobile/v1/chat/stream/' + encodeURIComponent(slowTurnId), {
      headers: auth, timeoutMs: 8000
    });
    check('thin.12 已结束回合的流请求立刻返回终态',
      afterDone.frames.length >= 1 && afterDone.frames[afterDone.frames.length - 1].event === 'chat.done', afterDone.frames.map(f => f.event));

    const turnStatus = await request(BASE, 'GET', '/mobile/v1/turns/' + encodeURIComponent(slowTurnId), { headers: auth });
    check('thin.12 turn 状态可查询（用 turnId）', turnStatus.status === 200 && turnStatus.body.payload.status === 'done', turnStatus.body.payload);
    const turnByRequest = await request(BASE, 'GET', '/mobile/v1/turns/req-slow-1', { headers: auth });
    check('thin.12 turn 状态可查询（用 requestId）', turnByRequest.status === 200 && turnByRequest.body.payload.turnId === slowTurnId, turnByRequest.body.payload);

    /* ── 13 · sync.changes：直接用 M1-A revision cursor ─────────────── */
    const sync0 = await request(BASE, 'GET', '/mobile/v1/sync/changes?cursor=0', { headers: auth });
    check('thin.13 cursor=0 返回全部 4 条消息（2 个回合 × 2）',
      sync0.status === 200 && sync0.body.payload.upserts.length === 4, sync0.body.payload.upserts.length);
    check('thin.13 cursor 是 M1-A 的 revision（单调整数）',
      typeof sync0.body.payload.cursor === 'number' && sync0.body.payload.revision >= sync0.body.payload.cursor, sync0.body.payload);
    const empty = await request(BASE, 'GET', '/mobile/v1/sync/changes?cursor=' + sync0.body.payload.cursor, { headers: auth });
    check('thin.13 用最新 cursor 再同步得到空增量', empty.status === 200 &&
      empty.body.payload.upserts.length === 0 && empty.body.payload.deletes.length === 0, empty.body.payload);
    check('thin.13 sync DTO 不含 secret / endpoint',
      sync0.raw.indexOf('sk-') < 0 && sync0.raw.indexOf('HIDDEN-SYSTEM-PROMPT') < 0 && sync0.raw.indexOf('apiKey') < 0, sync0.raw.slice(0, 400));

    /* ── 14 · 危险 Bridge 面不可达（Phase 1 / Acceptance）─────────────
       全部用 GET：mobile 的读类限流额度很宽松，这样这个纯粹"路径是否存在"
       的断言不会被任何限流规则干扰（它要证明的只有 404/400/405 这一件事）。 */
    const dangerous = [
      ['GET', '/api/llm-proxy'],
      ['GET', '/submit_payment'],
      ['GET', '/pay_register_checkout'],
      ['GET', '/pay_set_config'],
      ['GET', '/webhook'],
      ['GET', '/tools'],
      ['GET', '/mobile/v1/api/llm-proxy'],
      ['GET', '/mobile/v1/tools/execute'],
      ['GET', '/mobile/v1/pay/checkout'],
      ['GET', '/mobile/v1/webhook'],
      ['GET', '/mobile/v1/resident/chat'],
      ['GET', '/mobile/v2/handshake'],
      ['GET', '/mobile/handshake']
    ];
    let allBlocked = true;
    const allowed = [];
    for (const [method, urlPath] of dangerous) {
      /* 非 mobile 路径属于**桌面内部 API**：它们继承 Home Node 的 loopback/token
         保护，所以测试要带上桌面 token —— 否则拿到的是 401（"没登录"），
         那证明不了"路由不存在"。带 token 之后仍然必须 404。 */
      const headers = Object.assign({}, urlPath.indexOf('/mobile/') === 0 ? auth : adminHeaders);
      const r = await request(BASE, method, urlPath, { headers: headers });
      const blocked = r.status === 404 || r.status === 400 || r.status === 405;
      if (!blocked) allowed.push(method + ' ' + urlPath + ' → ' + r.status + ' ' + JSON.stringify(r.body && r.body.error || r.body));
      if (!blocked) allBlocked = false;
    }
    check('thin.14 Bridge 危险面与未知 mobile 路径全部不可达（404/405）', allBlocked, allowed);

    /* POST 到未知 mobile 路径也必须被同样拒绝（不能只在 GET 上正确）。 */
    const badPost = await request(BASE, 'POST', '/mobile/v1/webhook', {
      headers: auth, body: { v: 1, payload: {} }
    });
    check('thin.14 POST 未知 mobile 路径同样被拒（UNKNOWN_VERB）',
      badPost.status === 404 && badPost.body.error.code === 'UNKNOWN_VERB', badPost.body);

    const security = await request(BASE, 'GET', '/security', { headers: adminHeaders });
    check('thin.14 /security 自述 mobile 暴露面且不是 llm-proxy/工具/支付',
      !!(security.body && security.body.mobile) &&
      security.body.mobile.unreachable.indexOf('/api/llm-proxy') >= 0 &&
      security.body.doesNotExpose.indexOf('llm-proxy') >= 0, security.body);
    check('thin.14 /security 声明设备鉴权模型与传输',
      security.body.deviceAuth && security.body.deviceAuth.revoke === 'immediate' &&
      security.body.mobile.transport === 'http+text/event-stream', security.body.deviceAuth);

    /* ── 15 · 体积上限 ─────────────────────────────────────────────── */
    /* 40MB 远超上限。服务端在读到超限的那一刻就 destroy 连接，客户端于是
       可能拿到 413，也可能拿到连接重置 —— 两者都是**拒绝**，都满足要求。
       真正不能接受的是"接受了这个请求"（200/202 或写进了 store）。 */
    const huge = await request(BASE, 'POST', '/mobile/v1/chat/send', {
      headers: auth,
      body: { v: 1, requestId: 'r-huge', payload: { characterId: 'friend_test_a', content: 'x'.repeat(40 * 1024 * 1024) } }
    });
    const hugeRejected = huge.status === 413 || (huge.status === 0 && /ECONNRESET|EPIPE|socket hang up/i.test(String(huge.error || '')));
    check('thin.15 超大 body 被拒（413 或连接被服务端切断）', hugeRejected, { status: huge.status, error: huge.error });
    const afterHuge = await request(BASE, 'GET', '/mobile/v1/chat/history?characterId=friend_test_a', { headers: auth });
    check('thin.15 超大请求没有留下任何消息（服务不死、store 不变）',
      afterHuge.status === 200 && afterHuge.body.payload.count === 2, afterHuge.body.payload && afterHuge.body.payload.count);

    /* ── 16 · presence（最小 plumbing）─────────────────────────────── */
    const presence = await request(BASE, 'GET', '/mobile/v1/presence', { headers: auth });
    const selfPresence = presence.body.payload.devices.find(d => d.deviceId === deviceId);
    check('thin.16 presence 只含 online/lastSeen/appForeground', presence.status === 200 && selfPresence &&
      selfPresence.lastSeenAt > 0 &&
      selfPresence.battery === undefined && selfPresence.gps === undefined && selfPresence.fingerprint === undefined,
      selfPresence);
    const report = await request(BASE, 'POST', '/mobile/v1/presence/report', {
      headers: auth, body: { v: 1, payload: { appForeground: true } }
    });
    check('thin.16 presence.report 接受 appForeground 并回执', report.status === 200 && report.body.ok &&
      report.body.payload.lastSeenAt > 0, report.body);
    const presenceAfter = await request(BASE, 'GET', '/mobile/v1/presence', { headers: auth });
    const afterReport = presenceAfter.body.payload.devices.find(d => d.deviceId === deviceId);
    check('thin.16 appForeground 被持久化（不是只回执）', afterReport && afterReport.appForeground === true, afterReport);
    check('thin.16 presence 不携带 battery/GPS/sensor/设备指纹',
      afterReport && afterReport.battery === undefined && afterReport.gps === undefined &&
      afterReport.sensor === undefined && afterReport.fingerprint === undefined, afterReport && Object.keys(afterReport));

    /* ── 17 · 第二台设备：互不影响（撤销一台不影响另一台）──────────── */
    const session2 = await request(BASE, 'POST', '/pairing/session', {
      headers: adminHeaders, body: { deviceName: 'Tablet', deviceType: 'tablet' }
    });
    const paired2 = await request(BASE, 'POST', '/mobile/v1/pairing/complete', {
      body: { v: 1, payload: { pairingId: session2.body.payload.pairingId, secret: session2.body.payload.secret, deviceName: 'Tablet', deviceType: 'tablet' } }
    });
    const token2 = paired2.body.payload.token;
    const deviceId2 = paired2.body.payload.device.deviceId;
    check('thin.17 两台设备 → 两个独立 deviceId/token', deviceId2 !== deviceId && token2 !== deviceToken, { deviceId2: deviceId2 });

    /* ── 18 · 撤销立即生效 ─────────────────────────────────────────── */
    const devices = await request(BASE, 'GET', '/devices', { headers: adminHeaders });
    check('thin.18 桌面能列出全部已配对设备', devices.status === 200 && devices.body.payload.devices.length === 2,
      devices.body.payload && devices.body.payload.devices.map(d => d.deviceId + ':' + d.revoked));

    const revoke = await request(BASE, 'POST', '/device/revoke', { headers: adminHeaders, body: { deviceId: deviceId } });
    check('thin.18 桌面撤销设备成功', revoke.status === 200 && revoke.body.payload.device.revoked === true, revoke.body);

    const revokedTry = await request(BASE, 'GET', '/mobile/v1/character/list', { headers: auth });
    check('thin.18 被撤销的设备**立即**被拒（DEVICE_REVOKED）',
      revokedTry.status === 403 && revokedTry.body.error.code === 'DEVICE_REVOKED', revokedTry.body);
    const revokedSend = await request(BASE, 'POST', '/mobile/v1/chat/send', {
      headers: auth, body: { v: 1, requestId: 'r-revoked', payload: { characterId: 'friend_test_a', content: 'hi' } }
    });
    check('thin.18 被撤销的设备不能发消息', revokedSend.status === 403 && revokedSend.body.error.code === 'DEVICE_REVOKED', revokedSend.body);

    const otherStillWorks = await request(BASE, 'GET', '/mobile/v1/character/list', { headers: { Authorization: 'Bearer ' + token2 } });
    check('thin.18 撤销设备 A **不影响**设备 B（per-device 凭据）',
      otherStillWorks.status === 200 && otherStillWorks.body.payload.count === 3, otherStillWorks.body);

    /* ── 19 · rate limit ───────────────────────────────────────────── */
    let sawRateLimit = false;
    for (let i = 0; i < 30; i++) {
      const r = await request(BASE, 'POST', '/mobile/v1/pairing/complete', {
        body: { v: 1, payload: { pairingId: 'pair_nope', secret: 'x' } }
      });
      if (r.status === 429) { sawRateLimit = true; break; }
    }
    check('thin.19 未认证配对尝试会被限流（429）', sawRateLimit, sawRateLimit);

    /* ── 20 · 服务端日志不泄漏 ─────────────────────────────────────── */
    const status = await request(BASE, 'GET', '/status', { headers: adminHeaders });
    check('thin.20 /status 暴露 mobile 元信息', status.status === 200 && status.body.mobile && status.body.mobile.protocolVersion === 1, status.body.mobile);
    check('thin.20 服务日志不含设备 token / pairing secret / apiKey',
      serviceOut.indexOf(deviceToken) < 0 && serviceOut.indexOf(pairing.secret) < 0 &&
      serviceOut.indexOf('sk-SECRET-should-never-leak') < 0, 'log length ' + serviceOut.length);
    check('thin.20 服务日志不含消息正文',
      serviceOut.indexOf('你好呀') < 0 && serviceOut.indexOf('ABCDE') < 0, 'log length ' + serviceOut.length);
  } catch (error) {
    failed++;
    console.error('✖ thin 测试异常终止 — ' + String((error && error.stack) || error));
    console.error('--- service output ---\n' + serviceOut.slice(-4000));
  } finally {
    try { child.kill(); } catch (_) { /* 已退出 */ }
    try { provider.server.close(); } catch (_) { /* 已关闭 */ }
    try { slowProvider.server.close(); } catch (_) { /* 已关闭 */ }
    try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch (_) { /* 尽力而为 */ }
  }

  if (failed) { console.error('M1-B thin client 测试失败：' + failed + ' 项 ✘（通过 ' + passed + '）'); process.exitCode = 1; }
  else console.log('M1-B thin client tests passed ✔ (' + passed + ' 项)');
})();
