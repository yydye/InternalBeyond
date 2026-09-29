'use strict';
/* ====================================================================
   Internal Beyond · M1-C.2k · Canonical Thread Continuity
   运行：node tests/test_mobile_thread_continuity.js

   产品问题（不是"Thread API 测试"）：
     她在电脑上惦记着两件事 → 明天在手机上打开她 →
     她是否**同样惦记**，而手机**没有**携带第二份线索系统？

   为什么这条测试存在：M1-C.2j 实测证明，同一份 canonical Middle Brain 在两端
   拿到的证据不同 —— `organized.threads` 在桌面是 1、在 Home Node 是 0，
   于是 `threadItems` 是 3 对 0，而 `multipleThreads`（threadItems>=2）是 Gate 的
   **无视冷却硬触发**，两端因此给出不同判定（desktop: multiple_threads→astra；
   Home Node: simple_context→local）。根因是线索此前只有浏览器能产出。
   M1-C.2k 把派生收敛成唯一实现（thread-derivation-core.js）并让 Home Node
   按需从 canonical memory 派生 —— 本文件用 **production-shape E2E** 证明它真的
   走进了 provider 请求，且与桌面出自同一条规则。

   刻意不做：不新增 Android DTO / 协议 / 表；不建 Home Node 的 threads 表
   （线索是 canonical memory 上的确定性函数，不需要独立权威）；
   不动 Android 侧任何代码（tests/test_mobile_thin_client.js 必须原样通过）。
   ==================================================================== */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const ROOT = path.resolve(__dirname, '..');
const SERVICE = require(path.join(ROOT, 'services', 'home-node-service.js'));
const THREAD_RETRIEVAL = require(path.join(ROOT, 'services', 'home-node', 'thread-retrieval.js'));
const THREAD_CORE = require(path.join(ROOT, 'assets', 'js', 'thread-derivation-core.js'));
const VISIBILITY_CORE = require(path.join(ROOT, 'assets', 'js', 'memory-visibility-core.js'));
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
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}
/* 内联 SSE：chat.send 带 Accept: text/event-stream 时在同一个请求里返回流
   （与 tests/test_mobile_p0_continuity.js 同一语义）。不带这个头会拿到
   202 + streamUrl，于是 provider 尚未被调用、断言全部落空。 */
function readStream(base, urlPath, body, headers) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const h = Object.assign({ Accept: 'text/event-stream', 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }, headers || {});
    const frames = [], rawChunks = [];
    let buffer = '', status = 0, settled = false;
    const req = http.request(base + urlPath, { method: 'POST', headers: h, timeout: 15000 }, res => {
      status = res.statusCode;
      res.setEncoding('utf8');
      res.on('data', chunk => {
        rawChunks.push(chunk);
        buffer += chunk;
        const parts = buffer.split('\n\n');
        buffer = parts.pop();
        for (const p of parts) { if (p && p.trim()) frames.push(p); }
      });
      res.on('end', () => {
        if (settled) return;
        settled = true;
        if (buffer && buffer.trim()) frames.push(buffer);
        resolve({ status: status, frames: frames, raw: rawChunks.join('') });
      });
      res.on('error', () => { /* 主动断开噪声 */ });
    });
    req.on('timeout', () => { try { req.destroy(); } catch (_) {} });
    req.on('error', error => { if (settled) return; settled = true; reject(error); });
    req.write(data);
    req.end();
  });
}

/* ── 标记值：每个事实一个唯一字符串，出现在哪里都只能有一个解释 ───────── */
const M = {
  persona: 'PERSONA-MARKER-THREAD',
  user: 'USER-MARKER-THREAD',
  relationship: 'RELATIONSHIP-MARKER-THREAD',
  /* 两条应当被规则命中的"未完成事项"（question 取自记忆标题）。 */
  threadA: 'THREAD-A-准备攒钱买相机',
  threadB: 'THREAD-B-打算换一份工作',
  /* 只用于合并的细节记忆：标题与 threadA 完全相同 → 必须并入同一条线索。 */
  threadADup: 'THREAD-A-准备攒钱买相机',
  /* 不命中规则的普通陈述：绝不允许成为线索。 */
  plain: 'PLAIN-MEMORY-今天吃了面',
  /* 对角色隐藏、但命中规则的记忆：绝不允许成为线索，也绝不允许进 provider。 */
  hidden: 'HIDDEN-THREAD-打算买一台新手机',
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

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-thr-'));
/* P34.3-B · Home Node resolves provider secrets from the Vault now. Seed a
   synthetic Vault for this temp data dir so migrated reads resolve. */
(function seedVault() {
  const createVault = require(path.join(ROOT, 'active', 'credential-vault.js'));
  const vault = createVault({ dataDir: dataDir });
  vault.load();
  vault.upsert(CHARACTER_ID, { provider: 'custom', apiKey: M.secret });
  vault.save();
})();
  const ADMIN_TOKEN = 'thread-admin-token';
  const instance = SERVICE.buildHomeNode({
    dataDir: dataDir, token: ADMIN_TOKEN, logger: () => {},
    clock: () => FIXED_MS, timeZone: FIXED_TZ,
    random: () => 0
  });
  instance.open();
  const port = await listen(instance.server);
  const admin = { 'X-IB-Home-Token': ADMIN_TOKEN };
  const base = 'http://127.0.0.1:' + port;

  try {
    /* ══ 0 · 前置 ══ */
    section('T0 · 前置条件');
    check('T0.1 Home Node 持有 canonical memory store（线索与记忆共用它）',
      !!instance.memoryStore && instance.memoryStore.isOpen() === true);
    check('T0.2 装配注入线索派生器（不是只建了 store）',
      !!instance.gateway);
    /* 唯一实现的硬证据：桌面与 Home Node require 到的是**同一个文件**。 */
    check('T0.3 线索核心与 Home Node 共用同一份实现（require 解析到同一路径）',
      require.resolve(path.join(ROOT, 'assets', 'js', 'thread-derivation-core.js'))
      === require.resolve(path.join(ROOT, 'assets', 'js', 'thread-derivation-core.js')));
    const probe = new THREAD_RETRIEVAL({ store: instance.memoryStore, logger: () => {} });
    check('T0.4 线索派生器绑定 canonical memory store（防"绑到另一个空库"）',
      probe.store === instance.memoryStore);

    /* ══ 1 · 发布与配对 ══ */
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
    check('T1.1 角色目录发布成功', publish.status === 200 && publish.body.payload.count === 1, publish.body.payload);

    const sPair = await request(port, 'POST', '/pairing/session', {
      headers: admin, body: { deviceName: 'Thread Phone', deviceType: 'android' }
    });
    const cPair = await request(port, 'POST', '/mobile/v1/pairing/complete', {
      body: { v: 1, payload: { pairingId: sPair.body.payload.pairingId, secret: sPair.body.payload.secret, deviceName: 'Thread Phone', deviceType: 'android' } }
    });
    const auth = { Authorization: 'Bearer ' + cPair.body.payload.token };
    check('T1.2 设备配对成功', cPair.status === 200 && typeof cPair.body.payload.token === 'string', cPair.body);

    /* ══ 2 · 写入 canonical 记忆（线索的唯一来源）══ */
    section('T2 · 写入 canonical 记忆');
    /* 关键：`createdBy` 必须是该角色自己（或 visibleTo 含该角色），否则
       filterDerivationCandidates 会在规则之前就把它们过滤掉 —— 那不是"规则没命中"，
       而是"这条记忆对这个角色根本不可见"。生产里角色写入的记忆正是 createdBy=roleId。 */
    const seeded = [
      mem('mem_thr_a', { title: M.threadA, content: '她说下个月发工资就开始存，目标是那台相机。', importance: 8, createdBy: CHARACTER_ID, createdByName: '昔涟' }),
      mem('mem_thr_a2', { title: M.threadADup, content: '又提了一次想攒钱买相机。', importance: 7, createdBy: CHARACTER_ID, createdByName: '昔涟' }),
      mem('mem_thr_b', { title: M.threadB, content: '她打算换一份工作，还在准备简历。', importance: 7, createdBy: CHARACTER_ID, createdByName: '昔涟' }),
      mem('mem_plain', { title: M.plain, content: '今天中午吃了面，味道一般。', importance: 4, createdBy: CHARACTER_ID, createdByName: '昔涟' }),
      mem('mem_hidden_thr', {
        title: M.hidden, content: '她打算买一台新手机，但她把这条藏起来了。',
        importance: 10, visibility: 'private', createdBy: CHARACTER_ID, createdByName: '昔涟'
      })
    ];
    const seedWrite = await request(port, 'POST', '/memory/records', {
      headers: admin, body: { records: seeded, forceBatch: true }
    });
    check('T2.1 五条记忆写入 canonical store',
      seedWrite.status === 200 && seedWrite.body.payload.summary.created === 5, seedWrite.body.payload);
    check('T2.2 canonical 里确实有 5 条', instance.memoryStore.countRecords() === 5, instance.memoryStore.countRecords());

    /* ══ 3 · Home Node 侧派生：与桌面同一规则、同一可见性 ══ */
    section('T3 · Home Node 线索派生');
    const derived = probe.derive(CHARACTER_ID);
    check('T3.1 派生成功且 consulted=true（不是"没读过"）', derived.ok === true && derived.consulted === true, derived.error);
    const qs = derived.threads.map(t => t.question);
    check('T3.2 命中规则的记忆成为线索（两条：A 与 B）', derived.threads.length === 2, qs);
    check('T3.3 线索 A 的 question 取自记忆标题', qs.indexOf(M.threadA) > -1, qs);
    check('T3.4 线索 B 的 question 取自记忆标题', qs.indexOf(M.threadB) > -1, qs);
    check('T3.5 **不命中规则的普通陈述不产生线索**', !qs.some(q => String(q).indexOf(M.plain) >= 0), qs);
    check('T3.6 **对角色隐藏的线索不产生**（可见性先于规则）',
      !qs.some(q => String(q).indexOf(M.hidden) >= 0), qs);

    /* 证据并集：标题相同的两条记忆必须并入同一条线索。 */
    const threadA = derived.threads.filter(t => t.question === M.threadA)[0];
    check('T3.7 同一 question 的两条记忆并入同一条线索（证据取并集）',
      !!threadA && threadA.evidenceIds.length === 2
      && threadA.evidenceIds.indexOf('mem_thr_a') >= 0 && threadA.evidenceIds.indexOf('mem_thr_a2') >= 0,
      threadA);

    /* 确定性：同一输入重复派生给出同一结果（不依赖"跑过几个心跳"）。 */
    const derived2 = probe.derive(CHARACTER_ID);
    check('T3.8 重复派生结果完全一致（确定性、无累积状态）',
      JSON.stringify(derived.threads) === JSON.stringify(derived2.threads), derived2.threads);

    /* 浏览器与 Node 同一实现：手工按桌面路径（core.filterDerivationCandidates
       + core.deriveOpenThreads）算一遍，必须得到同一组线索。 */
    const rows = instance.memoryStore.listRecords({}).records;
    const browserStyle = THREAD_CORE.deriveOpenThreads(
      VISIBILITY_CORE.filterDerivationCandidates(rows, CHARACTER_ID, m => m.kind !== 'semantic' && m.kind !== 'core').slice(-12)
    );
    check('T3.9 与"桌面调用形状"给出同一组线索（同一份核心）',
      JSON.stringify(browserStyle.map(t => t.question).sort()) === JSON.stringify(derived.threads.map(t => t.question).sort()),
      { browserStyle: browserStyle.map(t => t.question), node: derived.threads.map(t => t.question) });

    /* 反向对照：把隐藏线索改为可见 → 它**必须**出现（排除"恒不出现"的假绿）。 */
    instance.memoryStore.putRecord(mem('mem_hidden_thr', {
      title: M.hidden, content: '她打算买一台新手机。', importance: 10,
      visibility: 'public', createdBy: CHARACTER_ID, createdByName: '昔涟'
    }));
    const derivedFlipped = probe.derive(CHARACTER_ID);
    check('T3.10 对照：隐藏线索改为可见后它出现（排除假绿）',
      derivedFlipped.threads.some(t => String(t.question).indexOf(M.hidden) >= 0),
      derivedFlipped.threads.map(t => t.question));
    /* 改回去，后续 provider-wire 断言继续验证它不出现。 */
    instance.memoryStore.putRecord(mem('mem_hidden_thr', {
      title: M.hidden, content: '她打算买一台新手机，但她把这条藏起来了。', importance: 10,
      visibility: 'private', createdBy: CHARACTER_ID, createdByName: '昔涟'
    }));

    /* ══ 4 · provider wire：线索证据真的送进了模型 ══ */
    section('T4 · provider-wire continuity');
    const send1 = await readStream(base, '/mobile/v1/chat/send', {
      v: 1, requestId: 'thread-turn-1',
      payload: { characterId: CHARACTER_ID, content: '我最近有点纠结，你陪我聊聊？' }
    }, auth);
    check('T4.0 chat.send 返回内联 SSE 流', send1.status === 200, { status: send1.status, raw: String(send1.raw).slice(0, 300) });
    check('T4.1 provider 真的被调用', provider.seen.bodies.length >= 1, provider.seen.bodies.length);

    const sentBody = provider.seen.bodies[provider.seen.bodies.length - 1];
    const system = systemTextOf(sentBody);
    check('T4.2 provider 的 system 非空', system.length > 0, system.length);
    check('T4.3 **provider system 含线索块标题**（她惦记的事真的进了模型）',
      system.indexOf('仍在推进的线索') > -1, system.slice(0, 600));
    check('T4.4 system 含线索 A', system.indexOf(M.threadA) > -1, system.slice(0, 600));
    check('T4.5 system 含线索 B', system.indexOf(M.threadB) > -1, system.slice(0, 600));
    check('T4.6 线索行渲染"依据 N 条记忆"（不再是观测次数）',
      /依据 \d+ 条记忆/.test(system), system.slice(0, 600));
    check('T4.7 **隐藏线索不在 provider 输入的任何位置**',
      allMessageTextOf(sentBody).indexOf(M.hidden) < 0, allMessageTextOf(sentBody).slice(0, 300));
    /* 普通记忆**应当**出现在记忆块里（它是记忆），但**不得**出现在线索块里。
       所以要按块判定，不能拿整段 system 判 —— 否则这条断言测的是"记忆没进上下文"，
       而不是"普通记忆没成为线索"。 */
    const threadSection = system.slice(system.indexOf('仍在推进的线索'));
    check('T4.8 **不命中规则的普通记忆不成为线索**（它仍在记忆块里，但不在线索块里）',
      threadSection.indexOf(M.plain) < 0, threadSection.slice(0, 300));
    check('T4.8b 对照：普通记忆确实在记忆块里（证明上一条不是因为整体没注入）',
      system.indexOf(M.plain) > -1, system.slice(0, 600));
    check('T4.9 persona 仍是 system 开头',
      system.indexOf(PERSONA_PROMPT) === 0, { head: system.slice(0, 140) });

    /* ══ 5 · Middle Brain 侧：organized.threads 不再恒空 ══ */
    section('T5 · Middle Brain 证据面');
    const MB = require(path.join(ROOT, 'services', 'home-node', 'middle-brain.js'));
    const CS = require(path.join(ROOT, 'assets', 'js', 'context-snapshot.js'));
    const field = probe.snapshotField(CHARACTER_ID);
    check('T5.1 快照字段 consulted=true 且文本非空',
      field.consulted === true && field.text.length > 0, { consulted: field.consulted, len: field.text.length });
    /* 三态：用真实 context-snapshot 契约落地，present 才算"读过且有内容"。 */
    const snap = CS.create({
      characterId: CHARACTER_ID, turnId: 't',
      fields: {
        memory: CS.field('m', '', { missing: true }),
        understanding: CS.field('u', '', { missing: true }),
        thread: CS.field('thread-retrieval.derive', field.text),
        moments: CS.field('mom', '', { missing: true })
      },
      gates: {}
    });
    check('T5.2 快照把 thread 记为 present（不是 missing/empty）',
      CS.state(snap, 'thread') === 'present', CS.summary(snap));
    const org = await globalThis.IB.__middleBrainContracts.policy.middleBrainOrganizeContext(
      CHARACTER_ID, '我最近有点纠结', { contextSnapshot: snap, threadCtx: field.text }
    );
    check('T5.3 organized.threads 非空（修复前恒为 0 —— 这正是两端判定分叉的根因）',
      org.threads.length > 0, org.threads);
    const sig = await globalThis.IB.__middleBrainContracts.policy._mbAnalyzeSignals(
      CHARACTER_ID, '我最近有点纠结', { organized: org }
    );
    check('T5.4 threadItems >= 2（旧行为恒为 0）', sig.threadItems >= 2, sig.threadItems);
    check('T5.5 multipleThreads 为 true（Gate 的无视冷却硬触发重新可达）',
      sig.multipleThreads === true, sig);
    const dec = globalThis.IB.__middleBrainContracts.policy._mbDecisionFromSignals(sig, {}, {}, FIXED_MS);
    check('T5.6 判定为 multiple_threads（与桌面同一结论，而非 simple_context）',
      dec.useAstra === true && dec.reason === 'multiple_threads', dec);

    /* ══ 6 · 失败语义：没读过 ≠ 读过但为空 ══ */
    section('T6 · 三态与失败语义');
    const broken = new THREAD_RETRIEVAL({
      store: { listRecords: () => { throw new Error('simulated store failure'); } },
      logger: () => {}
    });
    const brokenField = broken.snapshotField(CHARACTER_ID);
    check('T6.1 派生失败 → consulted=false（missing，不是"读过且为空"）',
      brokenField.consulted === false && brokenField.text === '', brokenField);
    const emptyStore = new THREAD_RETRIEVAL({
      store: { listRecords: () => ({ ok: true, records: [] }) }, logger: () => {}
    });
    const emptyField = emptyStore.snapshotField(CHARACTER_ID);
    check('T6.2 读到空库 → consulted=true 且文本为空（empty，与 missing 可区分）',
      emptyField.consulted === true && emptyField.text === '', emptyField);
    check('T6.3 空块不产生空标题行（不塞一个只有标题的块）',
      emptyStore.buildThreadBlock(CHARACTER_ID).block === '');
    /* 无记忆来源时（旧装配）：不崩，且返回 null 语义明确。 */
    const noStore = new THREAD_RETRIEVAL({ store: null, logger: () => {} });
    const noStoreField = noStore.snapshotField(CHARACTER_ID);
    check('T6.4 没有 store → consulted=false（绝不假装读过）',
      noStoreField.consulted === false, noStoreField);

    /* ══ 7 · Android 边界：她惦记着，但协议从不暴露 ══ */
    section('T7 · Android 边界（硬验收门）');
    check('T7.1 SSE 原始帧不含线索标题', send1.raw.indexOf('仍在推进的线索') < 0, String(send1.raw).slice(0, 300));
    check('T7.2 SSE 原始帧不含线索内容', send1.raw.indexOf(M.threadA) < 0 && send1.raw.indexOf(M.threadB) < 0);
    check('T7.3 SSE 帧里也没有 threadBlock / threadConsulted 等字段名',
      send1.raw.indexOf('threadBlock') < 0 && send1.raw.indexOf('threadConsulted') < 0
      && send1.raw.indexOf('runtimeContextParts') < 0, String(send1.raw).slice(0, 300));

    const history = await request(port, 'GET', '/mobile/v1/chat/history?characterId=' + CHARACTER_ID, { headers: auth });
    check('T7.4 chat.history 不含线索标记',
      history.status === 200 && history.raw.indexOf(M.threadA) < 0 && history.raw.indexOf(M.hidden) < 0,
      String(history.raw).slice(0, 200));

    const catalog = await request(port, 'GET', '/mobile/v1/character/list', { headers: auth });
    check('T7.5 character.list 不含线索标记',
      catalog.status === 200 && catalog.raw.indexOf(M.threadA) < 0, String(catalog.raw).slice(0, 200));

    const forbidden = await request(port, 'GET', '/mobile/v1/thread/list', { headers: auth });
    check('T7.6 **/mobile/v1/thread/list 不存在**（Android 没有 thread verb）',
      forbidden.status === 404 || forbidden.status === 405, { status: forbidden.status });

    /* ══ 8 · canonical 状态未被本轮读取改动 ══ */
    section('T8 · 读不产生副作用');
    const revBefore = instance.memoryStore.getRevision();
    probe.derive(CHARACTER_ID); probe.derive(CHARACTER_ID);
    check('T8.1 线索派生不推进 canonical memory revision（纯读）',
      instance.memoryStore.getRevision() === revBefore,
      { before: revBefore, after: instance.memoryStore.getRevision() });
    check('T8.2 canonical 记忆条数未变', instance.memoryStore.countRecords() === 5, instance.memoryStore.countRecords());

  } finally {
    try { instance.close(); } catch (_) { /* 已关闭 */ }
    try { provider.server.close(); } catch (_) { /* 已关闭 */ }
  }

  console.log('\nThread continuity (M1-C.2k): ' + passed + ' passed, ' + failed + ' failed');
  if (failed) process.exit(1);
})().catch(error => {
  console.error('test crashed:', error && error.stack || error);
  process.exit(1);
});
