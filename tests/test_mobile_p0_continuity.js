'use strict';
/* ====================================================================
   Internal Beyond · M1-C.2c-A · P0 Character Continuity
   运行：node tests/test_mobile_p0_continuity.js

   产品问题（不是"Runtime Parity"）：
     在电脑上认识我的角色，到手机上是否仍然知道
       1. 她是谁            （M1-C.2a 已闭环，本轮只做回归）
       2. 用户是谁
       3. 她该怎么称呼用户
       4. 两个人是什么关系
       5. 现在是什么时候
       6. 刚才聊过什么      （canonical history，本轮只做回归）

   验收方式是 **production-shape E2E**：真实 publish → pair → chat.send →
   Home Node execution → NodeModelPort → 真实 HTTP mock provider，
   然后对 provider 真正收到的 system 文本做断言。

   刻意不做的：
     · 不做 "Canonical Context Composer"，只接一个很小的 Node 侧 producer；
     · 不碰长期 Memory（memories/autoMemory/Understanding/Thread/Moments/
       summary/roleLetterMemories/diary）——第 7 项本轮必须是 NO；
     · 不把 runtimeContext 或 systemPrompt 塞进任何 Android 可见响应。
   ==================================================================== */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const ROOT = path.resolve(__dirname, '..');
const SERVICE = require(path.join(ROOT, 'services', 'home-node-service.js'));
const P0_CONTEXT = require(path.join(ROOT, 'services', 'home-node', 'p0-context.js'));
const MOBILE_DTO = require(path.join(ROOT, 'assets', 'js', 'mobile-dto.js'));

let passed = 0, failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log('OK   ' + name); }
  else { failed++; console.error('FAIL ' + name + (extra !== undefined ? ' — ' + JSON.stringify(extra) : '')); }
}

function request(port, method, urlPath, options) {
  options = options || {};
  return new Promise(resolve => {
    const data = options.body == null ? null
      : (typeof options.body === 'string' ? options.body : JSON.stringify(options.body));
    const headers = Object.assign({}, options.headers || {});
    if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
    const req = http.request({ host: '127.0.0.1', port: port, path: urlPath, method: method, timeout: 10000, headers: headers }, res => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', c => raw += c);
      res.on('end', () => {
        let parsed = null;
        try { parsed = raw ? JSON.parse(raw) : {}; } catch (_) { parsed = { raw: raw }; }
        resolve({ status: res.statusCode, body: parsed, headers: res.headers, raw: raw, text: raw });
      });
      res.on('error', e => resolve({ status: 0, body: null, error: e.message }));
    });
    req.on('timeout', () => { try { req.destroy(); } catch (_) {} resolve({ status: 0, body: null, error: 'timeout' }); });
    req.on('error', e => resolve({ status: 0, body: null, error: e.message }));
    if (data) req.write(data);
    req.end();
  });
}
function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}
/* 内联 SSE：chat.send 带 Accept: text/event-stream 时在同一个请求里返回流
   （与 tests/test_mobile_thin_client.js:75 readStream 同一语义）。
   用它而不是先拿 streamUrl 再开第二条连接：provider 调用与流帧在同一个
   回合里完成，断言不需要靠 sleep 去等。 */
function readStream(base, urlPath, body, headers) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const h = Object.assign({ Accept: 'text/event-stream', 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }, headers || {});
    const frames = [];
    const rawChunks = [];
    let buffer = '';
    let status = 0;
    let settled = false;
    const req = http.request(base + urlPath, { method: 'POST', headers: h, timeout: 15000 }, res => {
      status = res.statusCode;
      res.setEncoding('utf8');
      res.on('data', chunk => {
        rawChunks.push(chunk);
        buffer += chunk;
        let index;
        while ((index = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          const line = block.split('\n').find(l => l.indexOf('data:') === 0);
          if (!line) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === '[DONE]') continue;
          try { frames.push(JSON.parse(payload)); } catch (_) { /* 跳过 */ }
        }
      });
      res.on('end', () => {
        if (settled) return;
        settled = true;
        resolve({ status: status, frames: frames, raw: rawChunks.join('') });
      });
      res.on('error', () => { /* 主动断开噪声 */ });
    });
    req.on('timeout', () => { try { req.destroy(); } catch (_) {} });
    req.on('error', error => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    req.write(data);
    req.end();
  });
}

/* ── 标记值：每个 P0 事实一个唯一字符串，出现在哪里都只能有一个解释 ── */
const M = {
  persona: 'PERSONA-MARKER-M1C2A',
  user: 'USER-MARKER-M1C2C',
  nickname: 'NICKNAME-MARKER-M1C2C',
  relationship: 'RELATIONSHIP-MARKER-M1C2C',
  secret: 'sk-SECRET-should-never-leak',
  imageSecret: 'sk-IMAGEGEN-should-never-leak',
  systemPrompt: 'SYSTEM-PROMPT-MARKER-PRIVATE'
};
const PERSONA_PROMPT = '你是小满，' + M.persona + '。' + M.systemPrompt;

/* 固定时钟：2026-09-12T07:30:00+08:00。断言里要用同一个函数算期望值，
   这样"格式漂移"和"时间不对"能被区分开。 */
const FIXED_MS = Date.parse('2026-09-12T07:30:00+08:00');
const FIXED_TZ = 'Asia/Shanghai';
const EXPECTED_TIME = P0_CONTEXT.formatCurrentTime(FIXED_MS, FIXED_TZ);
const FIXED_NAME_TS = 1789169400000;

/* OpenAI 兼容流的 mock provider：记录 provider 真正收到的请求体。 */
function mockProvider(opts) {
  opts = opts || {};
  const seen = { bodies: [], paths: [] };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => raw += c);
    req.on('end', () => {
      seen.paths.push(req.url);
      try { seen.bodies.push(JSON.parse(raw)); } catch (_) { seen.bodies.push(raw); }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const pieces = [
        'data: ' + JSON.stringify({ choices: [{ delta: { content: '收到' } }] }) + '\n\n',
        'data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + '\n\n',
        'data: [DONE]\n\n'
      ];
      let i = 0;
      const next = () => {
        if (i >= pieces.length) { res.end(); return; }
        res.write(pieces[i++]);
        setTimeout(next, opts.chunkDelayMs == null ? 2 : opts.chunkDelayMs);
      };
      next();
    });
  });
  return { server: server, seen: seen };
}

/* provider wire 上的 system 文本（openai 形状：messages[] 里 role==='system'）。 */
function systemTextOf(body) {
  const msgs = (body && Array.isArray(body.messages)) ? body.messages : [];
  return msgs.filter(m => m && m.role === 'system')
    .map(m => (typeof m.content === 'string' ? m.content
      : (Array.isArray(m.content) ? m.content.map(p => (p && p.text) || '').join('\n') : '')))
    .filter(Boolean).join('\n');
}

(async () => {
  const provider = mockProvider({});
  const providerPort = await listen(provider.server);
  const providerEndpoint = 'http://127.0.0.1:' + providerPort + '/v1/chat/completions';

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-p0-'));
  const ADMIN_TOKEN = 'p0-admin-token';
  /* 固定时钟 + 固定时区注入：让"现在是什么时候"可确定性断言，而不是靠墙钟。
     这是本轮**唯一**为可测试性加的 seam，没有引入 TimeService 框架。 */
  const instance = SERVICE.buildHomeNode({
    dataDir: dataDir, token: ADMIN_TOKEN, logger: () => {},
    clock: () => FIXED_MS, timeZone: FIXED_TZ
  });
  instance.open();
  const port = await listen(instance.server);
  const admin = { 'X-IB-Home-Token': ADMIN_TOKEN };

  try {
    /* ══ 1 · 发布角色目录 + 用户资料 ═════════════════════════════════
       用户资料刻意走**真实投影层** mobile-dto.userProfileDto（桌面
       home-node-bootstrap 用的就是这个），而不是手搓一个对象 —— 这样
       "白名单外字段不得落盘"和"称呼真的送达"是同一个证据链。 */
    const projectedProfile = MOBILE_DTO.userProfileDto({
      name: M.user, nickname: M.nickname, apiKey: M.secret, bio: 'SHOULD-NOT-PERSIST'
    });
    check('P0.1 userProfileDto 白名单：只保留 id/name，丢掉 nickname/apiKey/bio',
      !!projectedProfile && projectedProfile.name === M.user &&
      projectedProfile.id === 'main' &&
      projectedProfile.nickname === undefined && projectedProfile.apiKey === undefined &&
      projectedProfile.bio === undefined, projectedProfile);
    /* 这一条把 P0-C 变成**可区分**的断言：若生产的 preferredAddress 某天改成
       读别的字段（例如误用角色昵称或某个 nickname 字段），reply 的值就会与
       projectedProfile.name 不同，本断言立刻转红。 */
    const reply = P0_CONTEXT.userIdentityOf(projectedProfile);
    check('P0-C 生产的 preferredAddress 等于投影后的 name（IB 无独立称呼字段，二者同源）',
      reply.preferredAddress === projectedProfile.name && reply.preferredAddress === M.user,
      { preferredAddress: reply.preferredAddress, expected: M.user });

    const publish = await request(port, 'POST', '/characters/publish', {
      headers: admin,
      body: {
        merge: true,
        user: projectedProfile,
        characters: [{
          id: 'friend_p0', nickname: '小满', relationship: M.relationship,
          model: 'mock-model', provider: 'custom', endpoint: providerEndpoint,
          apiKey: M.secret, imageGenApiKey: M.imageSecret,
          systemPrompt: PERSONA_PROMPT, vision: true
        }]
      }
    });
    check('P0.0 发布成功且报告 userProfile=true',
      publish.status === 200 && publish.body.payload.count === 1 &&
      publish.body.payload.userProfile === true, publish.body.payload);

    /* ══ 2 · 配对一台设备（Android 视角）══════════════════════════════ */
    const sPair = await request(port, 'POST', '/pairing/session', {
      headers: admin, body: { deviceName: 'P0 Phone', deviceType: 'android' }
    });
    const cPair = await request(port, 'POST', '/mobile/v1/pairing/complete', {
      body: {
        v: 1, payload: {
          pairingId: sPair.body.payload.pairingId, secret: sPair.body.payload.secret,
          deviceName: 'P0 Phone', deviceType: 'android'
        }
      }
    });
    const auth = { Authorization: 'Bearer ' + cPair.body.payload.token };
    check('P0.0 设备配对成功', cPair.status === 200 && typeof cPair.body.payload.token === 'string', cPair.body);

    /* Android 只提交 characterId + 用户发言 + 常规元数据。
       刻意**不**提交任何"现在几点"/身份/关系 —— 这些必须由 Node 自己形成。 */
    const send = await readStream('http://127.0.0.1:' + port, '/mobile/v1/chat/send', {
      v: 1, requestId: 'p0-turn-1',
      payload: { characterId: 'friend_p0', content: '早呀，今天过得怎么样？' }
    }, auth);
    check('P0.0 chat.send 返回内联 SSE 流', send.status === 200, { status: send.status, raw: String(send.raw).slice(0, 300) });
    const frames = send.frames;
    check('P0.0 SSE 至少有一帧', frames.length > 0, frames.length);

    /* ══ 3 · 捕获 provider wire ═════════════════════════════════════ */
    check('P0.0 provider 真的被调用了', provider.seen.bodies.length >= 1, provider.seen.bodies.length);
    const sent = provider.seen.bodies[0];
    const system = systemTextOf(sent);
    check('P0.0 provider wire 的 system 非空', system.length > 0, { len: system.length });

    /* ── P0-A · persona 仍然在（M1-C.2a 回归）─────────────────────── */
    check('P0-A persona marker 仍在 provider system 里',
      system.indexOf(M.persona) > -1, system.slice(0, 120));
    check('P0-A persona 仍是 system 的**开头**（P0 只允许在尾部追加，不改前缀）',
      system.indexOf(PERSONA_PROMPT) === 0, { head: system.slice(0, 120) });

    /* ── P0-B · 用户身份 ─────────────────────────────────────────── */
    check('P0-B provider system 含 USER_MARKER（用户是谁）',
      system.indexOf(M.user) > -1, system.slice(-320));

    /* ── P0-C · 称呼 ─────────────────────────────────────────────── */
    check('P0-C provider system 含称呼（怎么称呼用户）',
      system.indexOf(M.user) > -1, system.slice(-320));

    /* ── P0-D · 关系 ─────────────────────────────────────────────── */
    check('P0-D provider system 含 RELATIONSHIP_MARKER（两个人是什么关系）',
      system.indexOf(M.relationship) > -1, system.slice(-320));

    /* ── P0-E · 当前时间 ─────────────────────────────────────────── */
    check('P0-E provider system 含注入时钟推出的当前时间（非墙钟）',
      system.indexOf('当前时间：' + EXPECTED_TIME) > -1, { expected: EXPECTED_TIME, tail: system.slice(-320) });
    check('P0-E 时间格式含日期 + 星期 + 24 小时时刻（与桌面同一格式串）',
      /^当前时间：\d{4}年\d{1,2}月\d{1,2}日星期. \d{2}:\d{2}。$/.test(
        (system.split('\n').find(l => l.indexOf('当前时间：') === 0) || '').trim()),
      system.split('\n').find(l => l.indexOf('当前时间：') === 0));

    /* 注入时钟的还原性：时间必须随 clock 走，不是缓存/写死的。 */
    check('P0-E 时间由 Node 侧注入的 clock 推导（≠ 真实墙钟）',
      system.indexOf(P0_CONTEXT.formatCurrentTime(FIXED_NAME_TS, FIXED_TZ)) > -1 &&
      system.indexOf(P0_CONTEXT.formatCurrentTime(Date.now(), FIXED_TZ)) === -1 ||
      P0_CONTEXT.formatCurrentTime(Date.now(), FIXED_TZ) === EXPECTED_TIME,
      { expected: EXPECTED_TIME, wallClock: P0_CONTEXT.formatCurrentTime(Date.now(), FIXED_TZ) });

    /* Android 不能上传"现在几点"：伪造的时间字段必须被完全忽略。 */
    const forge = await readStream('http://127.0.0.1:' + port, '/mobile/v1/chat/send', {
      v: 1, requestId: 'p0-turn-forge',
      payload: {
        characterId: 'friend_p0', content: '现在几点？',
        currentTime: '1999年1月1日星期五 00:00', runtimeContext: 'FORGED-CONTEXT-MUST-NOT-APPEAR'
      }
    }, auth);
    const forgeBody = provider.seen.bodies[provider.seen.bodies.length - 1];
    const forgeSystem = systemTextOf(forgeBody);
    check('P0-E Android 上传的 currentTime / runtimeContext 被忽略（Node 自己算时间）',
      forgeSystem.indexOf('1999年1月1日') < 0 &&
      forgeSystem.indexOf('FORGED-CONTEXT-MUST-NOT-APPEAR') < 0 &&
      forgeSystem.indexOf('当前时间：' + EXPECTED_TIME) > -1,
      { forgeStatus: forge.status, tail: forgeSystem.slice(-320) });

    /* ── P0-F · canonical history 行为不变 ───────────────────────── */
    const sentMsgs = Array.isArray(sent.messages) ? sent.messages : [];
    check('P0-F 本轮用户正文在 messages 里（历史组装未被 P0 改动）',
      sentMsgs.some(m => m.role === 'user' && String(m.content).indexOf('早呀，今天过得怎么样？') > -1),
      sentMsgs.map(m => [m.role, String(m.content).slice(0, 40)]));
    check('P0-F P0 上下文只进 system，不进任何 user/assistant 消息',
      sentMsgs.filter(m => m.role !== 'system').every(m =>
        String(m.content).indexOf(M.user) < 0 && String(m.content).indexOf(M.relationship) < 0 &&
        String(m.content).indexOf('当前时间：') < 0),
      sentMsgs.map(m => [m.role, String(m.content).slice(0, 60)]));
    check('P0-F messages 里没有 system role 的重复注入（system 走顶层一次）',
      sentMsgs.filter(m => m.role === 'system').length <= 1,
      sentMsgs.filter(m => m.role === 'system').length);

    const history = await request(port, 'GET', '/mobile/v1/chat/history?characterId=friend_p0', { headers: auth });
    check('P0-F chat.history 正常返回，且含本轮用户消息',
      history.status === 200 &&
      JSON.stringify(history.body.payload).indexOf('早呀，今天过得怎么样？') > -1, history.body.payload);

    /* ── P0-G · secrets / 私有上下文不出站 ───────────────────────── */
    /* 注意：USER_MARKER / NICKNAME_MARKER 走的是**用户资料**（public 展示身份，
       桌面本来就把它渲染进导航栏），RELATIONSHIP 也是角色 DTO 的 public 字段。
       所以它们出现在 character.list 里不算泄漏 —— 真正的边界是：
       组装后的 runtimeContext 整体、systemPrompt、以及任何 provider 凭据。 */
    const characterList = await request(port, 'GET', '/mobile/v1/character/list', { headers: auth });
    const charRaw = characterList.raw;
    check('P0-G character.list 不含 systemPrompt marker',
      charRaw.indexOf(M.systemPrompt) < 0 && charRaw.indexOf(M.persona) < 0, charRaw.slice(0, 300));
    check('P0-G character.list 不含任何 provider 凭据 / endpoint',
      charRaw.indexOf(M.secret) < 0 && charRaw.indexOf(M.imageSecret) < 0 &&
      charRaw.indexOf('127.0.0.1:' + providerPort) < 0, charRaw.slice(0, 300));
    check('P0-G character.list 不含私有 runtimeContext 的组装表示',
      charRaw.indexOf('当前时间：') < 0 && charRaw.indexOf('【对方的个人资料】') < 0 &&
      charRaw.indexOf('runtimeContext') < 0, charRaw.slice(0, 300));

    const streamJson = JSON.stringify(frames);
    check('P0-G SSE 不含 systemPrompt / persona / 凭据 / runtimeContext',
      streamJson.indexOf(M.systemPrompt) < 0 && streamJson.indexOf(M.persona) < 0 &&
      streamJson.indexOf(M.secret) < 0 && streamJson.indexOf(M.imageSecret) < 0 &&
      streamJson.indexOf('runtimeContext') < 0 && streamJson.indexOf('当前时间：') < 0,
      streamJson.slice(0, 400));

    const historyRaw = history.raw;
    check('P0-G chat.history 不含 systemPrompt / 凭据 / runtimeContext',
      historyRaw.indexOf(M.systemPrompt) < 0 && historyRaw.indexOf(M.persona) < 0 &&
      historyRaw.indexOf(M.secret) < 0 && historyRaw.indexOf(M.imageSecret) < 0 &&
      historyRaw.indexOf('runtimeContext') < 0 && historyRaw.indexOf('当前时间：') < 0,
      historyRaw.slice(0, 400));

    /* 发布响应也不得回显资料对象本身（只报布尔位）。 */
    check('P0-G publish 响应只报 userProfile 布尔位，不回显资料内容',
      publish.raw.indexOf(M.user) < 0 && publish.raw.indexOf(M.nickname) < 0 &&
      publish.raw.indexOf(M.secret) < 0, publish.raw.slice(0, 300));

    /* ══ 4 · public DTO 字段不被误判为 secret ═══════════════════════ */
    check('P0.4 角色 DTO 的 relationship 是 public 字段（用于展示，不算泄漏）',
      charRaw.indexOf(M.relationship) > -1, charRaw.slice(0, 400));
    check('P0.4 投影层丢掉的昵称字段没有以任何形式出现在角色 DTO 里',
      charRaw.indexOf(M.nickname) < 0, charRaw.slice(0, 400));

    /* ══ 5 · 空资料发布不得清空已知称呼 ═════════════════════════════ */
    const emptyPublish = await request(port, 'POST', '/characters/publish', {
      headers: admin,
      body: { merge: true, user: { id: 'main', name: '   ' }, characters: [{ id: 'friend_p0', nickname: '小满', relationship: M.relationship, model: 'mock-model', provider: 'custom', endpoint: providerEndpoint, apiKey: M.secret, systemPrompt: PERSONA_PROMPT }] }
    });
    check('P0.5 空名字发布被拒（userProfile=false），不清空已知称呼',
      emptyPublish.status === 200 && emptyPublish.body.payload.userProfile === false, emptyPublish.body.payload);
    const afterEmpty = await readStream('http://127.0.0.1:' + port, '/mobile/v1/chat/send', {
      v: 1, requestId: 'p0-turn-after-empty', payload: { characterId: 'friend_p0', content: '还在吗' }
    }, auth);
    const afterEmptySystem = systemTextOf(provider.seen.bodies[provider.seen.bodies.length - 1]);
    check('P0.5 空资料发布后，称呼仍然保留在 provider system 里',
      afterEmpty.status === 200 && afterEmptySystem.indexOf(M.user) > -1, afterEmptySystem.slice(-320));

    /* ══ 6 · 未发布资料时：只注入时间，不注入假身份 ═════════════════ */
    const bareDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-p0-bare-'));
    const bare = SERVICE.buildHomeNode({
      dataDir: bareDir, token: 'bare-token', logger: () => {},
      clock: () => FIXED_MS, timeZone: FIXED_TZ
    });
    bare.open();
    const barePort = await listen(bare.server);
    try {
      const barePub = await request(barePort, 'POST', '/characters/publish', {
        headers: { 'X-IB-Home-Token': 'bare-token' },
        body: { merge: true, characters: [{ id: 'c', nickname: 'N', relationship: '', model: 'm', provider: 'custom', endpoint: providerEndpoint, apiKey: 'sk-x', systemPrompt: 'BARE-PERSONA' }] }
      });
      check('P0.6 无 user 字段的发布仍然成功（向后兼容旧发布端）',
        barePub.status === 200 && barePub.body.payload.userProfile === false, barePub.body.payload);
    } finally {
      bare.close();
      try { fs.rmSync(bareDir, { recursive: true, force: true }); } catch (_) {}
    }
  } catch (error) {
    failed++;
    console.error('FAIL P0 E2E 测试异常终止 — ' + String((error && error.stack) || error));
  } finally {
    instance.close();
    try { provider.server.close(); } catch (_) {}
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (_) {}
  }

  if (failed) { console.error('M1-C.2c-A P0 continuity 测试失败：' + failed + ' 项（通过 ' + passed + '）'); process.exitCode = 1; }
  else console.log('M1-C.2c-A P0 continuity tests passed (' + passed + ' 项)');
})();
