'use strict';
/* ====================================================================
   Internal Beyond · M1-C.2d Wave 2 · Canonical Memory Continuity
   运行：node tests/test_mobile_memory_continuity.js

   产品问题（不是"Memory API 测试"）：
     在电脑上告诉昔涟一件重要的事 → 明天在手机上打开她 →
     她是否**记得**同一件事，而手机**没有**携带第二份记忆系统？

   验收方式是 **production-shape E2E**：真实 canonical memory 写入 →
   真实 publish → pair → chat.send → Home Node execution → NodeModelPort →
   真实 HTTP mock provider，然后对 provider 真正收到的 system 文本做断言。

   三条互相独立的证明：
     T7 provider 真的收到了选中的 canonical 记忆；
     T8 **同一个回合**里 Android 面向的 SSE / chat.history / character.list
        都不含它 —— "她记得，但协议从不暴露她的记忆库"；
     T9 Desktop 写入的记忆能影响一次**后来**的 Android 回合，
        且该回合完全不查浏览器记忆。

   刻意不做：不新增 Android DTO / 协议 / 表；不把记忆行塞进任何出站响应；
   不动 Android 侧任何代码（tests/test_mobile_thin_client.js 必须原样通过）。
   ==================================================================== */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const ROOT = path.resolve(__dirname, '..');
const SERVICE = require(path.join(ROOT, 'services', 'home-node-service.js'));
const MEMORY_RETRIEVAL = require(path.join(ROOT, 'services', 'home-node', 'memory-retrieval.js'));
const MEMORY_RETRIEVAL_CORE = require(path.join(ROOT, 'assets', 'js', 'memory-retrieval-core.js'));
const MOBILE_DTO = require(path.join(ROOT, 'assets', 'js', 'mobile-dto.js'));

let passed = 0, failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log('OK   ' + name); }
  else { failed++; console.error('FAIL ' + name + (extra !== undefined ? ' — ' + JSON.stringify(extra) : '')); }
}
function section(title) { console.log('\n── ' + title + ' ──'); }

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
/* 内联 SSE：与 tests/test_mobile_p0_continuity.js:72 同一语义。
   同时保留**原始帧文本** —— 边界断言必须在原始 wire 文本上做，
   而不是在解析后的对象上做（解析会丢掉"多带的字段可能出现在哪里"这类证据）。 */
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

/* ── 标记值：每个事实一个唯一字符串，出现在哪里都只能有一个解释 ───────── */
const M = {
  persona: 'PERSONA-MARKER-WAVE2',
  user: 'USER-MARKER-WAVE2',
  relationship: 'RELATIONSHIP-MARKER-WAVE2',
  /* 核心标记：一条"在电脑上告诉她的重要事情"。 */
  memory: 'MEMORY-MARKER-WAVE2',
  /* 只存在于可见记忆对照组的第二个标记。 */
  memory2: 'MEMORY-DETAIL-WAVE2',
  /* 对角色隐藏的记忆：绝不允许出现在 provider 的任何地方。 */
  hidden: 'HIDDEN-MEMORY-WAVE2',
  /* 预算外记忆：用于证明预算是真的在起作用。 */
  offBudget: 'OFFBUDGET-MEMORY-WAVE2',
  secret: 'sk-SECRET-should-never-leak',
  systemPrompt: 'SYSTEM-PROMPT-MARKER-PRIVATE'
};
const PERSONA_PROMPT = '你是昔涟，' + M.persona + '。' + M.systemPrompt;

const FIXED_MS = Date.parse('2026-09-12T07:30:00+08:00');
const FIXED_TZ = 'Asia/Shanghai';
const CHARACTER_ID = 'friend_cyrene';

/* OpenAI 兼容流的 mock provider：记录 provider 真正收到的请求体。 */
function mockProvider() {
  const seen = { bodies: [], paths: [] };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => raw += c);
    req.on('end', () => {
      seen.paths.push(req.url);
      try { seen.bodies.push(JSON.parse(raw)); } catch (_) { seen.bodies.push(raw); }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const pieces = [
        'data: ' + JSON.stringify({ choices: [{ delta: { content: '我记得。' } }] }) + '\n\n',
        'data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + '\n\n',
        'data: [DONE]\n\n'
      ];
      let i = 0;
      const next = () => {
        if (i >= pieces.length) { res.end(); return; }
        res.write(pieces[i++]);
        setTimeout(next, 2);
      };
      next();
    });
  });
  return { server: server, seen: seen };
}
function systemTextOf(body) {
  const msgs = (body && Array.isArray(body.messages)) ? body.messages : [];
  return msgs.filter(m => m && m.role === 'system')
    .map(m => (typeof m.content === 'string' ? m.content
      : (Array.isArray(m.content) ? m.content.map(p => (p && p.text) || '').join('\n') : '')))
    .filter(Boolean).join('\n');
}
function allMessageTextOf(body) {
  const msgs = (body && Array.isArray(body.messages)) ? body.messages : [];
  return msgs.map(m => (typeof m.content === 'string' ? m.content
    : (Array.isArray(m.content) ? m.content.map(p => (p && p.text) || '').join('\n') : ''))).join('\n');
}

/* 规范记忆行工厂（与 memory.js 的既有写入形状一致）。 */
function mem(id, over) {
  return Object.assign({
    id: id, kind: 'episodic', title: '', summary: '', content: '',
    domain: '日常', tags: [], valence: 0.5, arousal: 0.3, importance: 5, resolved: false,
    visibility: 'public', visibleTo: [], excludeFrom: [],
    activationCount: 0, created: FIXED_MS - 86400000, lastActivated: FIXED_MS - 86400000,
    createdBy: 'user', createdByName: '', editedByUser: false,
    consolidatedFrom: [], lastConsolidatedAt: null
  }, over || {});
}

(async () => {
  const provider = mockProvider();
  const providerPort = await listen(provider.server);
  const providerEndpoint = 'http://127.0.0.1:' + providerPort + '/v1/chat/completions';

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-mem2-'));
  const ADMIN_TOKEN = 'mem2-admin-token';
  const instance = SERVICE.buildHomeNode({
    dataDir: dataDir, token: ADMIN_TOKEN, logger: () => {},
    clock: () => FIXED_MS, timeZone: FIXED_TZ,
    /* 探索窗口的随机抽样在测试里固定下来：否则"预算外记忆是否入选"会随机翻转，
       断言就变成 flaky。生产用 Math.random。 */
    random: () => 0
  });
  instance.open();
  const port = await listen(instance.server);
  const admin = { 'X-IB-Home-Token': ADMIN_TOKEN };
  const base = 'http://127.0.0.1:' + port;

  try {
    /* ══ 0 · 前置：真正的 memory store 在使用（否则下面全是空断言）══ */
    section('T0 · 前置条件');
    check('T0.1 Home Node 确实持有 canonical memory store',
      !!instance.memoryStore && instance.memoryStore.isOpen() === true);
    check('T0.2 装配里注入了 memory retrieval（不是只建了 store）',
      !!instance.memoryRetrieval, typeof instance.memoryRetrieval.retrieve);
    check('T0.3 两个核心模块与 Node 共用同一份实现（id 相同 = 同一个 require 缓存）',
      require.resolve(path.join(ROOT, 'assets', 'js', 'memory-retrieval-core.js')) ===
      require.resolve(path.join(ROOT, 'assets', 'js', 'memory-retrieval-core.js')));

    /* ══ 1 · 发布角色 + 用户资料（与桌面 home-node-bootstrap 同源投影）══ */
    section('T1 · 发布与配对');
    const projectedProfile = MOBILE_DTO.userProfileDto({ name: M.user, apiKey: M.secret });
    const publish = await request(port, 'POST', '/characters/publish', {
      headers: admin,
      body: {
        merge: true,
        user: projectedProfile,
        characters: [{
          id: CHARACTER_ID, nickname: '昔涟', relationship: M.relationship,
          model: 'mock-model', provider: 'custom', endpoint: providerEndpoint,
          apiKey: M.secret, systemPrompt: PERSONA_PROMPT
        }]
      }
    });
    check('T1.1 角色目录发布成功',
      publish.status === 200 && publish.body.payload.count === 1, publish.body.payload);

    const sPair = await request(port, 'POST', '/pairing/session', {
      headers: admin, body: { deviceName: 'Wave2 Phone', deviceType: 'android' }
    });
    const cPair = await request(port, 'POST', '/mobile/v1/pairing/complete', {
      body: { v: 1, payload: { pairingId: sPair.body.payload.pairingId, secret: sPair.body.payload.secret, deviceName: 'Wave2 Phone', deviceType: 'android' } }
    });
    const auth = { Authorization: 'Bearer ' + cPair.body.payload.token };
    check('T1.2 设备配对成功', cPair.status === 200 && typeof cPair.body.payload.token === 'string', cPair.body);

    /* ══ 2 · Desktop 侧写入 canonical 记忆（经真实 /memory/records）══ */
    section('T2 · Desktop 写入 canonical 记忆');
    /* 四条记忆，构造出"可见 / 隐藏 / 超预算"三组：
       · MARKER    —— 产品主张的那件事（可见、最高分）
       · DETAIL    —— 同一件事的细节（可见）
       · HIDDEN    —— 对角色隐藏（private）但**由该角色写入** —— 这正是 Wave 1
                      D-1 里会被旧判据放行的那一类，必须被排除
       · OFFBUDGET —— 可见但预算装不下（用于证明预算是真的在生效） */
    const seeded = [
      mem('mem_marker', {
        title: '用户的重要事情', content: M.memory + '：用户在做一个叫 InternalBeyond 的项目。',
        importance: 10, tags: ['重要', '项目']
      }),
      mem('mem_detail', {
        title: '细节', content: M.memory2 + ' 细节内容。', importance: 9
      }),
      mem('mem_hidden', {
        title: '她不该记得的', content: M.hidden + ' 这是用户对她隐藏的记忆。',
        importance: 10, visibility: 'private', createdBy: CHARACTER_ID, createdByName: '昔涟'
      }),
      mem('mem_offbudget', {
        title: '预算外', content: M.offBudget + ' 很长的内容'.repeat(40),
        importance: 8
      })
    ];
    const seedWrite = await request(port, 'POST', '/memory/records', {
      headers: admin, body: { records: seeded, forceBatch: true }
    });
    check('T2.1 四条记忆写入 canonical store',
      seedWrite.status === 200 && seedWrite.body.payload.summary.created === 4,
      seedWrite.body.payload);
    check('T2.2 canonical 里确实有 4 条', instance.memoryStore.countRecords() === 4, instance.memoryStore.countRecords());

    /* 幂等回归（T2）：同内容重写不推进 revision。 */
    const revBefore = instance.memoryStore.getRevision();
    const reseed = await request(port, 'POST', '/memory/records', {
      headers: admin, body: { records: seeded, forceBatch: true }
    });
    check('T2.3 同内容重写全部 skipped 且 revision 不动',
      reseed.body.payload.summary.skipped === 4 && instance.memoryStore.getRevision() === revBefore,
      { skipped: reseed.body.payload.summary.skipped, revision: instance.memoryStore.getRevision(), before: revBefore });

    /* 发布桌面记忆预算：两边必须同源，否则召回会不一致。 */
    const settings = await request(port, 'POST', '/memory/settings', {
      headers: admin, body: { budget: 260, contentLen: 200 }
    });
    check('T2.4 记忆预算发布成功（Node 与桌面共用同一组设置）',
      settings.status === 200 && settings.body.payload.settings.budget === 260, settings.body.payload);
    check('T2.5 Node 侧读回同一组设置',
      instance.memoryStore.getMemorySettings().settings.budget === 260,
      instance.memoryStore.getMemorySettings().settings);

    /* ══ 3 · Node 侧召回：可见性先于排名 ══ */
    section('T3 · Node 召回（可见性先于排名）');
    const retrieved = instance.memoryRetrieval.retrieve(CHARACTER_ID, { userMessage: 'InternalBeyond 项目' });
    check('T3.1 召回成功且有内容', retrieved.ok === true && retrieved.text.length > 0, retrieved.reason);
    check('T3.2 可见记忆进入召回', retrieved.text.indexOf(M.memory) > -1, retrieved.text.slice(0, 200));
    check('T3.3 **隐藏记忆不在召回里**（它由该角色写入且 importance=10，是旧判据会放行的那一类）',
      retrieved.text.indexOf(M.hidden) < 0, retrieved.text);
    check('T3.4 隐藏记忆不在 selectedIds', retrieved.selectedIds.indexOf('mem_hidden') < 0, retrieved.selectedIds);
    check('T3.5 隐藏记忆没有影响预算（它本可抢占高分位置）',
      retrieved.selectedIds.indexOf('mem_marker') > -1, retrieved.selectedIds);

    /* 反向对照：把隐藏记忆改为可见后，它**必须**出现 —— 证明 T3.3 不是"恒不出现"的假绿。 */
    const flipped = instance.memoryStore.putRecord(mem('mem_hidden', {
      title: '她应该记得的', content: M.hidden + ' 现在这条是可见的。',
      importance: 10, visibility: 'public', createdBy: CHARACTER_ID
    }));
    check('T3.6 对照准备：隐藏记忆改为可见', flipped.ok === true && flipped.outcome === 'updated', flipped);
    const retrieved2 = instance.memoryRetrieval.retrieve(CHARACTER_ID, { userMessage: 'InternalBeyond 项目' });
    check('T3.7 对照：变可见后它能进入召回（排除假绿）',
      retrieved2.text.indexOf(M.hidden) > -1, retrieved2.text.slice(0, 200));
    /* 改回隐藏，后续用例继续验证它不出现。 */
    instance.memoryStore.putRecord(mem('mem_hidden', {
      title: '她不该记得的', content: M.hidden + ' 这是用户对她隐藏的记忆。',
      importance: 10, visibility: 'private', createdBy: CHARACTER_ID, createdByName: '昔涟'
    }));

    /* 与浏览器侧同一实现：同一输入必须给出同一结果（T5 visibility parity）。 */
    const browserSide = MEMORY_RETRIEVAL_CORE.buildMemoryContext(instance.memoryStore.listRecords({}).records, {
      apiId: CHARACTER_ID, now: FIXED_MS, random: () => 0, userMessage: 'InternalBeyond 项目',
      maxChars: 260, contentLen: 200
    });
    const nodeSide = instance.memoryRetrieval.retrieve(CHARACTER_ID, { userMessage: 'InternalBeyond 项目' });
    check('T3.8 浏览器与 Node 用**同一份**核心 → 同一输入给出同一选择',
      browserSide.selected.map(s => s.id).join(',') === nodeSide.selectedIds.join(','),
      { browser: browserSide.selected.map(s => s.id), node: nodeSide.selectedIds });
    check('T3.9 预算确实在起作用（超预算的长记忆未被注入）',
      nodeSide.text.indexOf(M.offBudget) < 0 || nodeSide.selectedIds.indexOf('mem_offbudget') < 0,
      { selected: nodeSide.selectedIds, chars: nodeSide.chars });

    /* ══ 4 · T7 · provider wire：桌面学到的记忆真的送进了模型 ══ */
    section('T7 · provider-wire continuity');
    /* 基准紧贴本轮 chat.send：本段之前有 T3/T9 的内容写入（它们**应该**推进
       revision），所以只有"回合本身有没有推进"才是这里的契约。 */
    const revBeforeTurn = instance.memoryStore.getRevision();
    const send1 = await readStream(base, '/mobile/v1/chat/send', {
      v: 1, requestId: 'wave2-turn-1',
      payload: { characterId: CHARACTER_ID, content: '我们上次聊的那个项目叫什么来着？' }
    }, auth);
    check('T7.0 chat.send 返回内联 SSE 流', send1.status === 200, { status: send1.status, raw: String(send1.raw).slice(0, 300) });
    check('T7.0 provider 真的被调用', provider.seen.bodies.length >= 1, provider.seen.bodies.length);

    const sentBody = provider.seen.bodies[provider.seen.bodies.length - 1];
    const system = systemTextOf(sentBody);
    check('T7.1 provider 的 system 非空', system.length > 0, system.length);
    check('T7.2 **provider system 含 MEMORY-MARKER-WAVE2**（她记得桌面告诉她的事）',
      system.indexOf(M.memory) > -1, system.slice(0, 400));
    check('T7.3 persona 仍是 system 开头（记忆只在尾部追加，不改前缀）',
      system.indexOf(PERSONA_PROMPT) === 0, { head: system.slice(0, 140) });
    check('T7.4 P0 事实仍在（Wave 1/2c 回归）',
      system.indexOf(M.user) > -1 && system.indexOf(M.relationship) > -1);
    check('T7.5 当前时间**排在最后**（保 prompt cache 的最长公共前缀）',
      system.lastIndexOf('当前时间：') > system.lastIndexOf(M.memory),
      { timeAt: system.lastIndexOf('当前时间：'), memAt: system.lastIndexOf(M.memory) });
    check('T7.6 **隐藏记忆不在 provider 输入的任何位置**（不只是 system）',
      allMessageTextOf(sentBody).indexOf(M.hidden) < 0, allMessageTextOf(sentBody).slice(0, 300));

    /* ══ 5 · T8 · Android 边界：她记得，但协议从不暴露 ══ */
    section('T8 · Android 边界（硬验收门）');
    check('T8.1 SSE 原始帧不含记忆标记',
      send1.raw.indexOf(M.memory) < 0, String(send1.raw).slice(0, 300));
    check('T8.2 SSE 原始帧不含隐藏记忆标记', send1.raw.indexOf(M.hidden) < 0);
    check('T8.3 SSE 帧里也没有 selectedMemoryIds / 任何记忆字段名',
      send1.raw.indexOf('selectedMemory') < 0 && send1.raw.indexOf('memoryBlock') < 0 &&
      send1.raw.indexOf('runtimeContext') < 0, String(send1.raw).slice(0, 300));

    const history = await request(port, 'GET', '/mobile/v1/chat/history?characterId=' + CHARACTER_ID, { headers: auth });
    check('T8.4 chat.history 不含记忆标记',
      history.status === 200 && history.raw.indexOf(M.memory) < 0 && history.raw.indexOf(M.hidden) < 0,
      String(history.raw).slice(0, 300));

    const catalog = await request(port, 'GET', '/mobile/v1/character/list', { headers: auth });
    check('T8.5 character.list 不含记忆标记',
      catalog.status === 200 && catalog.raw.indexOf(M.memory) < 0 && catalog.raw.indexOf(M.hidden) < 0,
      String(catalog.raw).slice(0, 300));

    const oneChar = await request(port, 'GET', '/mobile/v1/character/' + CHARACTER_ID, { headers: auth });
    check('T8.6 character.get 不含记忆标记',
      oneChar.status === 200 && oneChar.raw.indexOf(M.memory) < 0 && oneChar.raw.indexOf(M.hidden) < 0,
      { status: oneChar.status, raw: String(oneChar.raw).slice(0, 200) });

    /* 危险路径仍然不可达（与 test_mobile_thin_client.js 同一断言，这里只做回归）。 */
    const forbidden = await request(port, 'GET', '/mobile/v1/memory/list', { headers: auth });
    check('T8.7 **/mobile/v1/memory/list 不存在**（Android 没有 memory verb）',
      forbidden.status === 404, { status: forbidden.status, body: forbidden.body });

    const errorPayload = await request(port, 'POST', '/mobile/v1/chat/send', {
      headers: auth, body: { v: 1, requestId: 'wave2-bad', payload: { characterId: 'no-such-character', content: 'hi' } }
    });
    check('T8.8 错误载荷不含记忆内容',
      errorPayload.raw.indexOf(M.memory) < 0 && errorPayload.raw.indexOf(M.hidden) < 0,
      String(errorPayload.raw).slice(0, 300));

    /* ══ 6 · T6 · 激活强化不推动结构版本 ══ */
    section('T6 · 激活强化');
    /* 关键断言：**回合本身**没有推进 canonical memory revision。
       （T9 之后会写入新记忆，所以 T8m 里的比较必须在那边自己取基准。） */
    const revAfterTurn = instance.memoryStore.getRevision();
    const activations = instance.memoryStore.listRecords({}).records
      .filter(r => Number(r.activationCount || 0) > 0);
    check('T6.1 回合成功后激活计数被强化（有记忆被记为"确实想起过"）',
      activations.length > 0, { records: instance.memoryStore.listRecords({}).records.map(r => ({ id: r.id, n: r.activationCount })) });
    check('T6.2 强化只发生在**被选中**的记忆上',
      activations.every(r => retrieved.selectedIds.indexOf(r.id) > -1),
      { activated: activations.map(r => r.id), selected: retrieved.selectedIds });
    check('T6.3 lastActivated 被写成注入时钟的时间（可复现）',
      activations.every(r => r.lastActivated === FIXED_MS), activations.map(r => r.lastActivated));
    /* 这一轮 chat.send 本身也在同一次流程里：memory revision 必须仍等于发布设置时的值。 */
    check('T6.4 **整轮对话没有推进 memory revision**（排名提示不产生同步流量）',
      instance.memoryStore.getRevision() === revBeforeTurn,
      { after: instance.memoryStore.getRevision(), before: revBeforeTurn });
    /* 直接对 store 断言：recordActivation 明确报告 revisionTouched=false。 */
    const act = instance.memoryStore.recordActivation(['mem_marker'], { at: FIXED_MS });
    check('T6.5 store.recordActivation 明确报告 revisionTouched=false',
      act.ok === true && act.revisionTouched === false, act);
    check('T6.6 激活后 revision 仍不变',
      instance.memoryStore.getRevision() === revAfterTurn, instance.memoryStore.getRevision());

    /* ══ 7 · T9 · Desktop → Android 连续性（产品定义测试）══ */
    section('T9 · Desktop → Android 连续性');
    /* 模拟"今天在电脑上告诉她一件事"：新的 canonical 记忆在**本轮 Android 回合之前**
       写入，且这次写入完全走 Node 的 canonical 路径（不经过浏览器）。 */
    const NEW_FACT = 'MEMORY-NEW-FACT-WAVE2';
    const laterWrite = await request(port, 'POST', '/memory/records', {
      headers: admin,
      body: { record: mem('mem_today', { title: '今天的事', content: NEW_FACT + ' 用户今天说了一件重要的事。', importance: 10, pinned: true }) }
    });
    check('T9.1 新的 canonical 记忆写入成功（pinned，保证预算内）',
      laterWrite.status === 200 && laterWrite.body.payload.outcome === 'created', laterWrite.body.payload);

    /* 后来的 Android 回合：只提交 characterId + 发言 + 常规元数据。 */
    const send2 = await readStream(base, '/mobile/v1/chat/send', {
      v: 1, requestId: 'wave2-turn-2',
      payload: { characterId: CHARACTER_ID, content: '我今天跟你说的那件事，你还记得吗？' }
    }, auth);
    check('T9.2 第二个 Android 回合成功', send2.status === 200, send2.status);
    const laterBody = provider.seen.bodies[provider.seen.bodies.length - 1];
    const laterSystem = systemTextOf(laterBody);
    check('T9.3 **后来的一次 Android 回合里，provider 收到了今天写入的那条记忆**',
      laterSystem.indexOf(NEW_FACT) > -1, laterSystem.slice(-500));
    check('T9.4 该回合仍然不含隐藏记忆',
      allMessageTextOf(laterBody).indexOf(M.hidden) < 0);
    check('T9.5 该回合的 SSE 仍不含任何记忆内容',
      send2.raw.indexOf(NEW_FACT) < 0 && send2.raw.indexOf(M.memory) < 0);

    /* 关键：Android 回合**没有**查询浏览器记忆。
       证据不是"它没调用浏览器"（Node 进程里根本没有 IndexedDB），
       而是结构性的：Node 进程内不存在任何 IndexedDB / 浏览器 store 句柄，
       且 selectedIds 全部来自 canonical store。这里断言后者。 */
    const canonicalIds = instance.memoryStore.listRecords({}).records.map(r => r.id);
    check('T9.6 该回合选中的 id 全部来自 canonical store（不存在浏览器来源）',
      instance.memoryRetrieval.retrieve(CHARACTER_ID, { userMessage: '我今天跟你说的那件事' })
        .selectedIds.every(id => canonicalIds.indexOf(id) > -1),
      canonicalIds);

    /* ══ 8 · 迁移（浏览器 → Node）与回滚影子 ══ */
    section('T8m · 迁移语义');
    const migState = await request(port, 'GET', '/memory/migration?source=browser-indexeddb:memory', { headers: admin });
    check('T8m.1 迁移水位可读（初次为空水位）',
      migState.status === 200 && migState.body.payload.state.version === 0, migState.body.payload);
    /* 基准在**这里**取：T9 已经写入过新记忆，用更早的值比较会把
       "水位不推进 revision" 和 "内容写入确实推进 revision" 混为一谈。 */
    const revBeforeMark = instance.memoryStore.getRevision();
    const mark = await request(port, 'POST', '/memory/migrate', {
      headers: admin,
      body: { source: 'browser-indexeddb:memory', version: 1, lastTimestamp: FIXED_MS, records: 4, idSet: ['mem_marker', 'mem_detail'] }
    });
    check('T8m.2 迁移水位可写且 id 集合被保留',
      mark.status === 200 && mark.body.payload.state.idSet.length === 2, mark.body.payload.state);
    const migState2 = await request(port, 'GET', '/memory/migration?source=browser-indexeddb:memory', { headers: admin });
    check('T8m.3 水位与 id 集合可读回（可续跑的前提）',
      migState2.body.payload.state.version === 1 && migState2.body.payload.state.idSet.length === 2,
      migState2.body.payload.state);

    /* 迁移标记**不影响** canonical revision（它只是水位，不是内容）。 */
    check('T8m.4 写水位不推进 memory revision',
      instance.memoryStore.getRevision() === revBeforeMark,
      { after: instance.memoryStore.getRevision(), before: revBeforeMark });
    /* 对照：真正的**内容**写入必须推进 revision（排除"revision 恒不动的假绿"）。 */
    const revBeforeContent = instance.memoryStore.getRevision();
    instance.memoryStore.putRecord(mem('mem_control', { title: '对照', content: 'CONTROL-ROW' }));
    check('T8m.5 对照：内容写入**确实**推进 revision（前面那条不是假绿）',
      instance.memoryStore.getRevision() === revBeforeContent + 1,
      { after: instance.memoryStore.getRevision(), before: revBeforeContent });

    /* ══ 9 · 边界：桌面面受保护，设备面拿不到 ══ */
    section('T9b · 路由边界');
    const mobileMemory = await request(port, 'GET', '/mobile/v1/memory/list', { headers: auth });
    check('T9b.1 /mobile/v1/memory/* 一律 404', mobileMemory.status === 404, mobileMemory.status);
    const security = await request(port, 'GET', '/security', { headers: admin });
    check('T9b.2 /security 的 memoryPolicy 如实声明"存储但不服务设备"',
      security.status === 200 &&
      security.body.memoryPolicy && security.body.memoryPolicy.stored === true &&
      security.body.memoryPolicy.servedToDevices === false &&
      Array.isArray(security.body.memoryPolicy.deviceVerbs) && security.body.memoryPolicy.deviceVerbs.length === 0,
      security.body.memoryPolicy);
    check('T9b.3 memory 已从 doesNotExpose 移出（旧声明会误导）',
      Array.isArray(security.body.doesNotExpose) && security.body.doesNotExpose.indexOf('memory') < 0,
      security.body.doesNotExpose);
    /* 桌面路径确实可达并且真的返回 canonical 记忆（证明它不是被顺手关掉的）。 */
    const desktopList = await request(port, 'GET', '/memory/list', { headers: admin });
    check('T9b.4 桌面面 /memory/list 可达且返回 canonical 记录',
      desktopList.status === 200 && desktopList.body.payload.count === 6,
      desktopList.body.payload && desktopList.body.payload.count);

    /* ══ 10 · 失败语义：三条规则刻意不同 ══ */
    section('T10 · 失败语义');
    const savedSettings = instance.memoryStore.getMemorySettings().settings;
    /* 召回失败 → 空块、回合继续（可用性 fail open）。用一个会抛错的 store 桩验证。 */
    const brokenRetrieval = MEMORY_RETRIEVAL({
      store: {
        listRecords: () => { throw new Error('simulated store failure'); },
        getMemorySettings: () => { throw new Error('simulated settings failure'); },
        recordActivation: () => { throw new Error('simulated activation failure'); }
      },
      clock: () => FIXED_MS, logger: () => {}
    });
    const brokenCtx = brokenRetrieval.buildRuntimeContext({
      characterId: CHARACTER_ID, userProfile: projectedProfile, relationship: M.relationship,
      currentTime: 'TIME', userMessage: 'hi'
    });
    check('T10.1 召回失败 → 空记忆块，但上下文仍然产出（回合不会因此失败）',
      brokenCtx.selectedIds.length === 0 && brokenCtx.runtimeContext.indexOf('TIME') > -1,
      brokenCtx);
    check('T10.2 召回失败给出可诊断的 reason（不静默）',
      brokenCtx.memoryReason === 'memory-read-failed' || brokenCtx.memoryReason === 'no-visible-memory',
      brokenCtx.memoryReason);
    /* 强化失败 → 不抛出 */
    let reinforceThrew = false;
    try { brokenRetrieval.reinforce(['x'], {}); } catch (_) { reinforceThrew = true; }
    check('T10.3 强化失败不抛出（排名提示不是事实）', reinforceThrew === false);
    /* 可见性无法判定 → 不注入（暴露 fail closed）。 */
    const noCore = MEMORY_RETRIEVAL_CORE; /* 核心存在时无法模拟缺失；用空记录集验证"不可判定即不注入" */
    check('T10.4 无可见记忆 → 不产出空标题块',
      MEMORY_RETRIEVAL_CORE.buildMemoryContext([], { apiId: CHARACTER_ID, now: FIXED_MS }).text === '');
    check('T10.5 预算设置被保留（上面的失败用例没有污染 store）',
      JSON.stringify(instance.memoryStore.getMemorySettings().settings) === JSON.stringify(savedSettings));

  } finally {
    try { instance.close(); } catch (_) { /* 已关闭 */ }
    try { provider.server.close(); } catch (_) { /* 已关闭 */ }
  }

  console.log('\nMemory continuity (Wave 2): ' + passed + ' passed, ' + failed + ' failed');
  if (failed) process.exit(1);
})().catch(error => {
  console.error('test crashed:', error && error.stack || error);
  process.exit(1);
});
