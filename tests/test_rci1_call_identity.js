/* ====================================================================
   RCI-1 · Provider 调用归因闭包（consumer / characterId / threadId）
   --------------------------------------------------------------------
   本轮要证明的唯一事实：
     provider/model 只说明"走了哪条通道"；
     consumer/characterId/threadId 才说明"谁为什么发出这次调用"。
   **同 provider + 同 model 不能证明属于同一个 consumer** —— 并发的日记与角色私信
   可以共用同一个 provider/model，把它们的调用数合并统计就会得到错误结论（RCI-0 的
   21+3 就是这样算错的）。

   本文件 0 次真实 AI 调用：
     · 核心段直接 require assets/js/ib-model-core.js（纯函数 + 内存 trace 环）；
     · 接缝段把 assets/js/communication.js 装进 vm 沙箱求值，用**假 fetch** 应答，
       从不接触任何真实 endpoint / apiKey。

   A. trace 契约：consumer / characterId / threadId 写入；缺省为 ''（向后兼容）
   B. 隐私白名单：记录只含 metadata，不含 prompt / apiKey / Authorization / 消息 / 正文
   C. token 回填按身份配对（并发下不把 A 的用量挂到 B 的记录上）
   D. legacy callApi：调用方可声明 consumer；不传 opts 行为逐位不变
   E. canonical callApiChat：role_dm 的两个角色各自带自己的 characterId / threadId
   F. 预算重试：两次 provider attempt 身份不漂移，且是两条独立记录
   G. 并发 diary + role_dm（同 provider/model）能靠 consumer 分开
   H. provider 请求体不含任何身份键
   I. 全仓 legacy callApi 调用点都必须声明 consumer
   J. Middle Brain（astra/judge/compression/integrity）复用同一个 trace writer

   运行：node tests/test_rci1_call_identity.js
   ==================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const IBMC = require(path.join(ROOT, 'assets', 'js', 'ib-model-core.js'));

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('\u2714 ' + name); }
  else { failed++; console.error('\u2718 ' + name + (detail !== undefined ? '  \u2192 ' + JSON.stringify(detail) : '')); }
}
function section(title) { console.log('\n\u2500\u2500 ' + title + ' \u2500\u2500'); }
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/^\uFEFF/, '');
const trace = n => IBMC.reasoningTrace(n);

/* 允许出现在 reasoning trace 记录里的**全部**键（RCI-1 契约）。
   任何新增字段都必须显式登记在这里 —— 这是隐私契约的机器可读形态。 */
const TRACE_KEYS = ['at', 'consumer', 'characterId', 'threadId', 'provider', 'model', 'format',
  'requestedReasoningEffort', 'effectiveReasoningEffort', 'reasoningWireParam',
  'reasoningFallbackReason', 'reasoningTokens'];
const FORBIDDEN_KEYS = ['prompt', 'messages', 'message', 'content', 'text', 'response', 'systemPrompt',
  'apiKey', 'key', 'Authorization', 'authorization', 'endpoint', 'body', 'headers', 'memory', 'persona',
  'usage', 'raw', 'error', 'stack'];

(async () => {

  /* ══════════ A + B + C. 核心 trace 契约（纯函数） ══════════ */
  section('A/B/C · reasoning trace 契约（ib-model-core 直测）');

  const spec = { provider: 'deepseek', model: 'deepseek-flash' };
  const SECRET_PROMPT = 'SECRET_PROMPT_TEXT_DO_NOT_TRACE';
  const SECRET_KEY = 'sk-rci1-do-not-trace';

  IBMC.reasoningTraceReset();
  IBMC.applyReasoningEffort({ messages: [{ role: 'user', content: SECRET_PROMPT }] },
    Object.assign({ apiKey: SECRET_KEY }, spec),
    { format: 'openai', effort: 'auto', consumer: 'diary', characterId: 'char_X', threadId: 'thread_1' });
  const one = trace(1)[0];
  check('A1.consumerRecorded', one && one.consumer === 'diary', one);
  check('A2.characterIdRecorded', one && one.characterId === 'char_X', one);
  check('A3.threadIdRecorded', one && one.threadId === 'thread_1', one);

  IBMC.reasoningTraceReset();
  IBMC.applyReasoningEffort({}, spec, { format: 'openai', effort: 'auto' });
  const bare = trace(1)[0];
  check('A4.identityDefaultsEmpty', bare && bare.consumer === '' && bare.characterId === '' && bare.threadId === '',
    bare);
  check('A5.identityIsStringMetadata',
    bare && typeof bare.consumer === 'string' && typeof bare.characterId === 'string' && typeof bare.threadId === 'string',
    Object.keys(bare || {}));

  IBMC.reasoningTraceReset();
  IBMC.applyReasoningEffort({}, spec, { format: 'openai', effort: 'high', consumer: 'role_dm', characterId: 'char_A', threadId: 'thread_1' });
  IBMC.noteReasoningTokens(125, { consumer: 'role_dm', provider: 'deepseek', model: 'deepseek-flash', characterId: 'char_A', threadId: 'thread_1' });
  const withTok = trace(5)[0];
  check('C1.tokenBackfillSameIdentity', withTok && withTok.reasoningTokens === 125, withTok);

  IBMC.reasoningTraceReset();
  IBMC.applyReasoningEffort({}, spec, { format: 'openai', effort: 'auto', consumer: 'role_dm', characterId: 'char_A', threadId: 'thread_1' });
  IBMC.applyReasoningEffort({}, spec, { format: 'openai', effort: 'auto', consumer: 'role_dm', characterId: 'char_B', threadId: 'thread_1' });
  IBMC.noteReasoningTokens(77, { consumer: 'role_dm', provider: 'deepseek', model: 'deepseek-flash', characterId: 'char_B', threadId: 'thread_1' });
  const pair = trace(5);
  check('C2.noTokenCrossCharacter',
    pair.length === 2 && pair[0].characterId === 'char_A' && pair[0].reasoningTokens == null
    && pair[1].characterId === 'char_B' && pair[1].reasoningTokens === 77, pair);

  /* 隐私白名单：对**每一类**写入者产生的记录做键白名单 + 内容白名单。
     这里刻意把敏感串塞进请求体/配置，证明 trace 从不复制请求内容。 */
  IBMC.reasoningTraceReset();
  IBMC.applyReasoningEffort({ messages: [{ role: 'user', content: SECRET_PROMPT }], system: SECRET_PROMPT },
    Object.assign({ apiKey: SECRET_KEY }, spec),
    { format: 'openai', effort: 'auto', consumer: 'chat', characterId: 'char_X', threadId: 'thread_1' });
  IBMC.noteReasoningTokens(9, { consumer: 'chat', provider: 'deepseek', model: 'deepseek-flash', characterId: 'char_X', threadId: 'thread_1' });
  IBMC.AstraAdapter.buildResponsesRequest({ provider: 'astra', model: 'gpt-6-astra', apiKey: SECRET_KEY },
    [{ role: 'user', content: SECRET_PROMPT }], { consumer: 'middle_brain.judge', reasoningEffort: 'high', maxTokens: 900 });
  const all = trace(20);
  const keySet = new Set();
  for (const rec of all) Object.keys(rec).forEach(k => keySet.add(k));
  const unknown = [...keySet].filter(k => TRACE_KEYS.indexOf(k) < 0);
  check('B1.keyWhitelist', unknown.length === 0, unknown);
  /* B2：一个请求计划 + 一次 token 回填 + 一次 Responses builder = 至少两条记录，
     且回填是**写进已有记录**而不是伪造新记录（这正是"每次 provider attempt 一条记录"的基础）。 */
  const tokenRecs = all.filter(r => r.reasoningTokens === 9);
  check('B2.recordsExist', all.length >= 2 && tokenRecs.length === 1, all.map(r => [r.consumer, r.reasoningTokens]));
  const json = JSON.stringify(all);
  check('B3.noPromptOrKeyInTrace',
    json.indexOf(SECRET_PROMPT) < 0 && json.indexOf(SECRET_KEY) < 0
    && json.indexOf('Bearer') < 0 && json.indexOf('Authorization') < 0, json.slice(0, 200));
  check('B4.noForbiddenKeys', FORBIDDEN_KEYS.every(k => !keySet.has(k)), [...keySet]);

  /* ══════════ 沙箱：真实接缝（communication.js 原文求值） ══════════ */
  section('D/E/F/G/H · 接缝（vm 求值 communication.js + 假 fetch）');

  const calls = [];       /* 每次真实 provider 请求：{url, rawBody} */
  let responder = null;   /* (n) -> {status, json} */

  function fakeRes(status, payload) {
    return {
      ok: status >= 200 && status < 300, status: status,
      headers: { get: k => (String(k).toLowerCase() === 'content-type' ? 'application/json' : '') },
      async text() { return JSON.stringify(payload == null ? {} : payload); },
      async json() { return payload == null ? {} : payload; }
    };
  }

  function makeEl(tag) {
    const e = {
      tagName: String(tag || 'div').toUpperCase(), _cls: '', _html: '', _text: '',
      dataset: {}, style: {}, children: [], parentNode: null,
      appendChild(c) { if (c == null) return c; c.parentNode = this; this.children.push(c); return c; },
      removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); return c; },
      querySelector() { return null; }, querySelectorAll() { return []; },
      insertBefore(c) { return this.appendChild(c); }, remove() { },
      addEventListener() { }, removeEventListener() { }, setAttribute(k, v) { this[k] = v; },
      getAttribute() { return null; },
      set className(v) { this._cls = String(v); }, get className() { return this._cls; },
      set innerHTML(v) { this._html = String(v); this.children.length = 0; }, get innerHTML() { return this._html; },
      set textContent(v) { this._text = String(v); this.children.length = 0; }, get textContent() { return this._text; },
      classList: { add() { }, remove() { }, toggle() { }, contains() { return false; } },
      cloneNode() { return makeEl(tag); }
    };
    return e;
  }
  const doc = {
    createElement: makeEl, createDocumentFragment: () => makeEl('#fragment'),
    createTextNode: t => { const e = makeEl('#text'); e._text = String(t); return e; },
    getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
    addEventListener() { }, removeEventListener() { }, body: makeEl('body'), head: makeEl('head'),
    documentElement: makeEl('html'), cookie: '', readyState: 'complete', hidden: false,
    createEvent: () => ({ initEvent() { } })
  };

  const sandbox = {
    console: { log() { }, info() { }, warn() { }, error() { }, debug() { } },
    setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
    AbortController, Date, Math, JSON, Object, Array, String, Number, Boolean, RegExp, Error, TypeError,
    Map, Set, WeakMap, Promise, parseInt, parseFloat, isNaN, isFinite, encodeURIComponent, decodeURIComponent,
    Uint8Array, ArrayBuffer, Intl, TextDecoder, TextEncoder,
    document: doc, apiConfigs: [], archivedConfigs: [], activeFriendId: '', currentPage: 'chat',
    _cachedUserName: 'You', _cachedUserAvatar: '', localStorage: { getItem: () => null, setItem() { }, removeItem() { } },
    navigator: { userAgent: 'node-test', language: 'zh-CN' },
    location: { href: 'http://localhost/', protocol: 'http:', reload() { } },
    IB: {}, IBERR: { err: m => new Error(m), report: () => null, show() { } },
    /* 唯一网络出口：假 fetch。绝不接触真实 endpoint。 */
    fetch: async function (url, init) {
      const n = calls.length;
      calls.push({ url: String(url), rawBody: String((init && init.body) || '') });
      if (responder) { const r = await responder(n); if (r) return fakeRes(r.status || 200, r.json); }
      return fakeRes(200, { choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] });
    },
    PROVIDERS_DIR: require(path.join(ROOT, 'assets', 'js', 'provider-directory.js')),
    IBModelCore: IBMC,
    module: undefined, exports: undefined, require: undefined
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  const ctx = vm.createContext(new Proxy(sandbox, {
    has: () => true,
    get(t, k) { if (k in t) return t[k]; if (typeof k === 'symbol') return undefined; return function () { }; }
  }));

  let evalOk = true, evalErr = '';
  try {
    /* 门面（IB.expose）由 ib-namespace.js 提供 —— 与真实页面装载顺序一致；
       communication.js 末尾的 NS.expose('chat', …) 需要它，否则 IIFE 会半途抛错。 */
    vm.runInContext(read('assets/js/ib-namespace.js'), ctx, { filename: 'ib-namespace.js' });
    vm.runInContext(read('assets/js/communication.js'), ctx, { filename: 'communication.js' });
  } catch (e) { evalOk = false; evalErr = String((e && e.message) || e); }
  check('S1.communicationEvaluates', evalOk, evalErr);
  check('S2.exportsPresent', typeof sandbox.callApi === 'function' && typeof sandbox.callApiChat === 'function'
    && typeof sandbox.callApiChatStream === 'function');

  /* 同 provider + 同 model 的两个消费者（这正是 M3 记账出错的形状）。 */
  const cfg = { id: 'char_cfg', provider: 'custom', model: 'rci1-fake-model', endpoint: 'http://127.0.0.1:1/v1/chat/completions', apiKey: 'sk-rci1-fake', promptCache: false };
  const msgs = [{ role: 'user', content: 'ping' }];
  const identOf = r => ({ consumer: r.consumer, characterId: r.characterId, threadId: r.threadId });

  /* ── D. legacy callApi 身份闭包 ── */
  IBMC.reasoningTraceReset();
  await sandbox.callApi(cfg, 'legacy body', { _ibConsumer: 'summary', _ibCharacterId: 'char_X' });
  const legacy = trace(1)[0];
  check('D1.legacyConsumerRecorded', legacy && legacy.consumer === 'summary', legacy);
  check('D2.legacyCharacterRecorded', legacy && legacy.characterId === 'char_X', legacy);
  check('D3.legacyProviderModelKept', legacy && legacy.provider === 'custom' && legacy.model === 'rci1-fake-model', legacy);

  IBMC.reasoningTraceReset();
  await sandbox.callApi(cfg, 'legacy body without opts');
  const legacyBare = trace(1)[0];
  check('D4.legacyBackwardCompatible', legacyBare && legacyBare.consumer === '' && legacyBare.characterId === '' && legacyBare.threadId === '',
    legacyBare);

  /* ── E. canonical callApiChat：Role DM 两个角色各带各的身份 ── */
  IBMC.reasoningTraceReset();
  await sandbox.callApiChat(cfg, msgs, {
    _ibConsumer: 'role_dm', _ibCharacterId: 'char_A', _ibThreadId: 'thread_dm_1',
    disableTools: true, _noWebSearch: true, autoContinue: false, wantMeta: true, maxTokens: 256
  });
  await sandbox.callApiChat(cfg, msgs, {
    _ibConsumer: 'role_dm', _ibCharacterId: 'char_B', _ibThreadId: 'thread_dm_1',
    disableTools: true, _noWebSearch: true, autoContinue: false, wantMeta: true, maxTokens: 256
  });
  const dm = trace(5);
  check('E1.roleDmSpeakersDistinct', dm.length === 2 && dm[0].characterId === 'char_A' && dm[1].characterId === 'char_B', dm.map(identOf));
  check('E2.roleDmConsumerStable', dm.every(r => r.consumer === 'role_dm'), dm.map(identOf));
  check('E3.roleDmThreadStable', dm.every(r => r.threadId === 'thread_dm_1'), dm.map(identOf));

  /* ── F. 预算重试：两次 provider attempt，身份不漂移 ──
     角色私信的两级预算梯子 = 两次 callApiChat（同 consumer/character/thread），
     第一次被截断且正文为空、第二次说成 —— 与 D24 观测到的形状一致。 */
  IBMC.reasoningTraceReset();
  calls.length = 0;
  responder = n => (n === 0
    ? { status: 200, json: { choices: [{ message: { content: '' }, finish_reason: 'length' }] } }
    : { status: 200, json: { choices: [{ message: { content: 'hello' }, finish_reason: 'stop' }] } });
  const attempt = bi => sandbox.callApiChat(cfg, msgs, {
    _ibConsumer: 'role_dm', _ibCharacterId: 'char_A', _ibThreadId: 'thread_dm_1',
    disableTools: true, _noWebSearch: true, autoContinue: false, wantMeta: true, maxTokens: bi
  });
  const r1 = await attempt(256);
  const r2 = await attempt(1024);
  responder = null;
  const retry = trace(5);
  check('F1.twoAttemptsTwoRecords', retry.length === 2, retry.map(identOf));
  check('F2.retryIdentityStable',
    retry.length === 2 && retry.every(r => r.consumer === 'role_dm' && r.characterId === 'char_A' && r.threadId === 'thread_dm_1'),
    retry.map(identOf));
  check('F3.retryAttemptsDistinguishable',
    retry.length === 2 && retry[0] !== retry[1] && retry[0].at <= retry[1].at,
    { first: retry[0] && retry[0].at, second: retry[1] && retry[1].at });
  check('F4.retryObservedEmptyThenText',
    String((r1 && r1.text) || '') === '' && r1.truncated === true && String((r2 && r2.text) || '') === 'hello',
    { r1: r1, r2: r2 });

  /* ── G. 并发 diary + role_dm：同 provider/model，仍必须能分开 ── */
  IBMC.reasoningTraceReset();
  calls.length = 0;
  responder = async () => { await new Promise(r => setTimeout(r, 5)); return { status: 200, json: { choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] } }; };
  await Promise.all([
    /* 日记 seam 的 opts 形状与 assets/js/active-diary/diary.js 逐字一致
       （Object.assign({_ibConsumer:'diary'},opts)）。 */
    sandbox.callApiChat(cfg, msgs, Object.assign({ _ibConsumer: 'diary' }, { disableTools: true, _noWebSearch: true, autoContinue: false, wantMeta: true, maxTokens: 256 })),
    sandbox.callApiChat(cfg, msgs, { _ibConsumer: 'role_dm', _ibCharacterId: 'char_B', _ibThreadId: 'thread_dm_1', disableTools: true, _noWebSearch: true, autoContinue: false, wantMeta: true, maxTokens: 256 })
  ]);
  responder = null;
  const conc = trace(5);
  const consumers = conc.map(r => r.consumer).sort();
  check('G1.concurrentConsumersDistinct', conc.length === 2 && consumers.join(',') === 'diary,role_dm', conc.map(identOf));
  check('G2.sameProviderModelWouldNotSeparate',
    conc.length === 2 && conc.every(r => r.provider === cfg.provider && r.model === cfg.model)
    && new Set(conc.map(r => r.consumer)).size === 2, conc.map(r => [r.provider, r.model, r.consumer]));
  check('G3.diaryVsRoleDmCharacter', conc.some(r => r.consumer === 'diary') && conc.some(r => r.consumer === 'role_dm' && r.characterId === 'char_B'),
    conc.map(identOf));

  /* ── H. 请求体不含任何身份键 ── */
  const leaked = calls.filter(c => /_ibConsumer|_ibCharacterId|_ibThreadId|"consumer"|characterId|threadId/.test(c.rawBody));
  check('H1.identityNeverInProviderBody', calls.length >= 2 && leaked.length === 0, leaked.map(c => c.rawBody.slice(0, 160)));
  const badUrl = calls.filter(c => !/^http:\/\/127\.0\.0\.1:1\//.test(c.url));
  check('H2.onlyFakeEndpointTouched', badUrl.length === 0, badUrl.map(c => c.url));

  /* ══════════ I. 全仓 legacy callApi 调用点必须声明 consumer ══════════ */
  section('I · legacy callApi 调用点的 consumer 闭包（静态）');

  function stripComments(s) {
    return s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
  }
  const legacySites = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!/\.js$/i.test(entry.name)) continue;
      const text = stripComments(fs.readFileSync(full, 'utf8').replace(/^\uFEFF/, ''));
      const rel = path.relative(ROOT, full).split(path.sep).join('/');
      const re = /\bcallApi\(/g;
      let m;
      while ((m = re.exec(text))) {
        const line = text.slice(text.lastIndexOf('\n', m.index) + 1, text.indexOf('\n', m.index));
        if (/^\s*(?:async\s+)?function\s/.test(line)) continue;   /* 定义 */
        legacySites.push({ file: rel, line: text.slice(0, m.index).split('\n').length, ok: text.slice(m.index, m.index + 400).indexOf('_ibConsumer') >= 0 });
      }
    }
  })(path.join(ROOT, 'assets', 'js'));

  const undeclaredLegacy = legacySites.filter(s => !s.ok);
  check('I1.legacySitesFound', legacySites.length === 6, legacySites.map(s => s.file + ':' + s.line));
  check('I2.everyLegacySiteDeclaresConsumer', undeclaredLegacy.length === 0,
    undeclaredLegacy.map(s => s.file + ':' + s.line));
  const named = legacySites.filter(s => s.ok).map(s => s.file.replace(/^assets\/js\//, ''));
  check('I3.namedLegacyConsumers', ['communication.js', 'communication/annotations.js', 'communication/summary.js', 'communication/letters.js', 'memory.js']
    .every(f => named.indexOf(f) >= 0), named);

  /* Role DM 接缝：身份必须来自本回合真实执行上下文（speakerId / threadId）。 */
  const roleDm = read('assets/js/role-dm.js');
  check('I4.roleDmCallSiteIdentity', /_ibCharacterId:\s*speakerId/.test(roleDm) && /_ibThreadId:\s*String\(\(ctx\.thread && ctx\.thread\.threadId\)/.test(roleDm));

  /* ══════════ J. Middle Brain 复用同一个 trace writer ══════════ */
  section('J · Middle Brain 归因（同一个 reasoning trace）');

  const astraSrc = read('assets/js/middle-brain-astra.js');
  const judgeSrc = read('assets/js/middle-brain-judge.js');
  const integritySrc = read('assets/js/middle-brain-integrity.js');
  check('J1.judgeConsumerDeclared', /consumer:\s*'middle_brain\.judge'/.test(judgeSrc));
  check('J2.compressionConsumerDeclared', /consumer:\s*'middle_brain\.compression'/.test(astraSrc));
  check('J3.integrityConsumerDeclared', /consumer:\s*'middle_brain\.integrity'/.test(integritySrc));
  check('J4.astraDefaultConsumerDeclared', /opts\.consumer \|\| 'middle_brain'/.test(astraSrc));
  /* 真正的证据：Middle Brain 的 request builder 与角色调用**共用同一个** trace 写入点。 */
  IBMC.reasoningTraceReset();
  IBMC.AstraAdapter.buildResponsesRequest({ provider: 'astra', model: 'gpt-6-astra' },
    [{ role: 'user', content: SECRET_PROMPT }], { consumer: 'middle_brain.judge', reasoningEffort: 'high', maxTokens: 900 });
  const mb = trace(1)[0];
  check('J5.mbRecordInSameTrace', mb && mb.consumer === 'middle_brain.judge' && mb.format === 'responses'
    && mb.effectiveReasoningEffort === 'high', mb);
  check('J6.mbTraceHasNoPrompt', JSON.stringify(mb).indexOf(SECRET_PROMPT) < 0, mb);

  /* ══════════ 汇总 ══════════ */
  console.log('\n' + (failed
    ? 'RCI-1 call identity regression FAILED: ' + failed + ' failed / ' + passed + ' passed'
    : 'RCI-1 call identity regression passed \u2714 (' + passed + ' checks, 0 real AI calls)'));
  process.exitCode = failed ? 1 : 0;
})().catch(e => {
  console.error('RCI-1 test harness error: ' + ((e && e.stack) || e));
  process.exitCode = 1;
});
