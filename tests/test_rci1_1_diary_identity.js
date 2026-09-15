/* ====================================================================
   RCI-1.1 · Diary 角色归因闭包（reasoningTrace.characterId）
   --------------------------------------------------------------------
   上一轮（RCI-1）留下的唯一缺口：diary 的调用**有** consumer='diary'，但 characterId=''
   —— 于是 trace 只能说"这是日记调用"，说不出"这是哪个角色的日记调用"。
   本轮要证明的唯一事实：
     同一 consumer（diary）并发服务多个角色时，characterId（= 该次调用真实执行上下文里的
     cfg.id）是唯一能把它们分开的身份；provider/model 完全不能代替它。
   同时证明两条执行路径都覆盖：
     runtime 路径（IB.runtime.instance.execute，默认）
     direct 回滚路径（window.runtimeDiaryExecuteEnabled=false）

   本文件 0 次真实 AI 调用：
     · 把 assets/js 的真实原文装进 vm 沙箱求值（ib-namespace → ib-model-core →
       communication → agent-runtime → active-diary/diary）；
     · 唯一网络出口是**假 fetch**，endpoint 只指向 127.0.0.1:1（并有断言保证只碰过它）。

   A. authority：角色身份 = 本域权威 cfg.id（不是昵称 / 不是 model / 不是 provider）
   B. runtime 路径：consumer='diary' + characterId=cfg.id
   C. direct 回滚路径：同上（两路径逐位一致）
   D. 同 provider + 同 model 的两个角色仍可分开（并发）
   E. 拿不到 cfd.id 时写 ''（不猜、不回落、不用昵称）
   F. 预算重试形状：两次 attempt 身份不漂移，是两条独立记录
   G. 隐私：只增 ID metadata；请求体与 trace 都不含身份键以外的任何东西
   H. 结构：planner 与 generation 都只经 _diaryModelCall；consumer 不碎片化

   运行：node tests/test_rci1_1_diary_identity.js
   ==================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('\u2714 ' + name); }
  else { failed++; console.error('\u2718 ' + name + (detail !== undefined ? '  \u2192 ' + JSON.stringify(detail) : '')); }
}
function section(title) { console.log('\n\u2500\u2500 ' + title + ' \u2500\u2500'); }
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/^\uFEFF/, '');
/* 页面内那一份 core（沙箱自注册的 window.IBModelCore）才是真实写入者 —— 见 S5 的同一性断言。 */
let trace = () => [];
let resetTrace = () => { };

/* RCI-1 trace 契约（未改动）：身份字段之外不得新增任何键。 */
const TRACE_KEYS = ['at', 'consumer', 'characterId', 'threadId', 'provider', 'model', 'format',
  'requestedReasoningEffort', 'effectiveReasoningEffort', 'reasoningWireParam',
  'reasoningFallbackReason', 'reasoningTokens'];
const FORBIDDEN_KEYS = ['nickname', 'persona', 'systemPrompt', 'relationship', 'memory', 'content',
  'title', 'prompt', 'messages', 'response', 'apiKey', 'key', 'endpoint', 'Authorization',
  'body', 'headers', 'usage', 'raw', 'error', 'stack'];

(async () => {

  /* ══════════ 沙箱：三份真实原文（communication / agent-runtime / diary） ══════════ */
  section('S · 沙箱装载（真实原文 + 假 fetch）');

  const calls = [];
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
    document: doc, apiConfigs: [], archivedConfigs: [], activeFriendId: '', currentPage: 'diary',
    _cachedUserName: 'You', _cachedUserAvatar: '',
    localStorage: { getItem: () => null, setItem() { }, removeItem() { } },
    navigator: { userAgent: 'node-test', language: 'zh-CN' },
    location: { href: 'http://localhost/', protocol: 'http:', reload() { } },
    IBERR: { err: m => new Error(m), report: () => null, show() { } },
    /* 唯一网络出口：假 fetch。绝不接触真实 endpoint。 */
    fetch: async function (url, init) {
      calls.push({ url: String(url), rawBody: String((init && init.body) || '') });
      return fakeRes(200, {
        choices: [{ message: { content: JSON.stringify({ shouldWrite: false }) }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 4 }
      });
    },
    PROVIDERS_DIR: require(path.join(ROOT, 'assets', 'js', 'provider-directory.js')),
    module: undefined, exports: undefined, require: undefined
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  const ctx = vm.createContext(new Proxy(sandbox, {
    has: () => true,
    get(t, k) { if (k in t) return t[k]; if (typeof k === 'symbol') return undefined; return function () { }; }
  }));

  const loaded = [];
  let evalErr = '';
  for (const f of ['assets/js/ib-namespace.js', 'assets/js/ib-model-core.js', 'assets/js/communication.js',
    'assets/js/agent-runtime.js', 'assets/js/active-diary/diary.js']) {
    try { vm.runInContext(read(f), ctx, { filename: path.basename(f) }); loaded.push(f); }
    catch (e) { evalErr = f + ': ' + String((e && e.message) || e); break; }
  }
  check('S1.allSourcesEvaluate', loaded.length === 5, evalErr || loaded);
  check('S2.executorSeamsPresent',
    typeof sandbox.callApiChat === 'function' && typeof sandbox.callApiChatStream === 'function'
    && typeof sandbox._diaryModelCall === 'function', typeof sandbox._diaryModelCall);
  check('S3.runtimeInstancePresent',
    !!(sandbox.IB && sandbox.IB.runtime && sandbox.IB.runtime.instance
      && typeof sandbox.IB.runtime.instance.execute === 'function'));
  check('S4.diarySeamIsSameFunction',
    sandbox.window._diaryModelCall === sandbox._diaryModelCall
    && sandbox.IB.active && sandbox.IB.active.diary && sandbox.IB.active.diary._diaryModelCall === sandbox._diaryModelCall);
  /* trace 读取口径：必须读**页面内那一份** IBModelCore（唯一写入者），而不是 Node require 的副本。 */
  check('S5.sandboxCoreIsTheWriter',
    !!sandbox.IBModelCore && typeof sandbox.IBModelCore.reasoningTrace === 'function'
    && typeof sandbox.IBModelCore.applyReasoningEffort === 'function');
  trace = n => sandbox.IBModelCore.reasoningTrace(n);
  resetTrace = () => sandbox.IBModelCore.reasoningTraceReset();

  /* 两个角色：同 provider + 同 model + 同 endpoint（除 id 外完全同形）。 */
  const mkCfg = id => ({
    id: id, provider: 'custom', model: 'rci11-diary-model',
    endpoint: 'http://127.0.0.1:1/v1/chat/completions', apiKey: 'sk-rci11-fake', promptCache: false
  });
  const CHAR_A = mkCfg('char_A'), CHAR_B = mkCfg('char_B');
  const msgs = [{ role: 'system', content: 'DIARY_SYS' }, { role: 'user', content: 'DIARY_USER' }];
  const identOf = r => ({ consumer: r.consumer, characterId: r.characterId, threadId: r.threadId });

  const callDiary = (cfg, opts) => sandbox._diaryModelCall(cfg, msgs,
    Object.assign({ maxTokens: 300, timeoutMs: 60000, wantMeta: false, jsonMode: true, _noWebSearch: true, disableTools: true }, opts || {}),
    { kind: 'planner' });

  /* ══════════ B. runtime 路径（默认接缝） ══════════ */
  section('B · runtime 路径（IB.runtime.instance.execute）');

  sandbox.window.runtimeExecuteEnabled = true;
  sandbox.window.runtimeDiaryExecuteEnabled = undefined;   /* 默认 = 走 runtime */
  resetTrace(); calls.length = 0;
  const rtA = await callDiary(CHAR_A);
  const rtB = await callDiary(CHAR_B);
  const rt = trace(5);
  check('B1.runtimePathUsed', rt.length === 2, rt.map(identOf));
  check('B2.runtimeConsumerIsDiary', rt.length === 2 && rt.every(r => r.consumer === 'diary'), rt.map(identOf));
  check('B3.runtimeCharacterIsOwnerId',
    rt.length === 2 && rt[0].characterId === 'char_A' && rt[1].characterId === 'char_B', rt.map(identOf));
  check('B4.runtimeThreadStillEmpty', rt.every(r => r.threadId === ''), rt.map(identOf));
  check('B5.runtimeReturnsText', typeof rtA === 'string' && rtA.length > 0, rtA);
  check('B6.identityIsNotNicknameOrModel',
    rt.every(r => r.characterId !== r.model && r.characterId !== 'rci11-diary-model'), rt.map(identOf));

  /* ══════════ C. direct 回滚路径 ══════════ */
  section('C · direct 回滚路径（runtimeDiaryExecuteEnabled=false）');

  sandbox.window.runtimeDiaryExecuteEnabled = false;
  resetTrace(); calls.length = 0;
  await callDiary(CHAR_A);
  await callDiary(CHAR_B);
  sandbox.window.runtimeDiaryExecuteEnabled = undefined;
  const dr = trace(5);
  check('C1.directConsumerIsDiary', dr.length === 2 && dr.every(r => r.consumer === 'diary'), dr.map(identOf));
  check('C2.directCharacterIsOwnerId',
    dr.length === 2 && dr[0].characterId === 'char_A' && dr[1].characterId === 'char_B', dr.map(identOf));
  check('C3.twoPathsIdentityShapeIdentical',
    JSON.stringify(dr.map(identOf)) === JSON.stringify(rt.map(identOf)), { direct: dr.map(identOf), runtime: rt.map(identOf) });

  /* ══════════ D. 同 provider/model 的两个角色（并发） ══════════ */
  section('D · 同 provider + 同 model 的两角色并发');

  resetTrace(); calls.length = 0;
  await Promise.all([callDiary(CHAR_A), callDiary(CHAR_B), callDiary(CHAR_A)]);
  const conc = trace(5);
  check('D1.threeRecords', conc.length === 3, conc.map(identOf));
  check('D2.providerModelCannotSeparate',
    conc.every(r => r.provider === 'custom' && r.model === 'rci11-diary-model')
    && new Set(conc.map(r => r.characterId)).size === 2, conc.map(r => [r.provider, r.model, r.characterId]));
  check('D3.characterIdSeparatesOwners',
    conc[0].characterId === 'char_A' && conc[1].characterId === 'char_B' && conc[2].characterId === 'char_A',
    conc.map(identOf));
  check('D4.allStillDiaryConsumer', conc.every(r => r.consumer === 'diary'), conc.map(identOf));

  /* ══════════ E. 拿不到 cfg.id → ''（不猜） ══════════ */
  section('E · 无 id 的 cfg');

  resetTrace();
  await callDiary({ provider: 'custom', model: 'rci11-diary-model', endpoint: 'http://127.0.0.1:1/v1/chat/completions', apiKey: 'sk-rci11-fake' });
  await callDiary({ nickname: '小夜', provider: 'custom', model: 'rci11-diary-model', endpoint: 'http://127.0.0.1:1/v1/chat/completions', apiKey: 'sk-rci11-fake' });
  const noId = trace(5);
  check('E1.noIdMeansEmpty', noId.length === 2 && noId.every(r => r.characterId === ''), noId.map(identOf));
  check('E2.nicknameNeverBecomesIdentity', noId.every(r => r.characterId !== '小夜'), noId.map(identOf));
  check('E3.consumerStillDeclared', noId.every(r => r.consumer === 'diary'), noId.map(identOf));

  /* ══════════ F. 预算重试形状 ══════════ */
  section('F · 两次 attempt 的身份继承');

  resetTrace();
  await callDiary(CHAR_A, { maxTokens: 300 });
  await callDiary(CHAR_A, { maxTokens: 2000 });
  const retry = trace(5);
  check('F1.twoAttemptsTwoRecords', retry.length === 2, retry.map(identOf));
  check('F2.retryIdentityStable',
    retry.length === 2 && retry.every(r => r.consumer === 'diary' && r.characterId === 'char_A'),
    retry.map(identOf));

  /* ══════════ G. 隐私 ══════════ */
  section('G · 隐私（只增 ID metadata）');

  resetTrace(); calls.length = 0;
  await callDiary(CHAR_A);
  const one = trace(5);
  const keySet = new Set();
  for (const rec of one) Object.keys(rec).forEach(k => keySet.add(k));
  const unknown = [...keySet].filter(k => TRACE_KEYS.indexOf(k) < 0);
  check('G1.traceKeyWhitelistUnchanged', unknown.length === 0, unknown);
  check('G2.noForbiddenKeys', FORBIDDEN_KEYS.every(k => !keySet.has(k)), [...keySet]);
  const json = JSON.stringify(one);
  check('G3.noPromptInTrace',
    json.indexOf('DIARY_SYS') < 0 && json.indexOf('DIARY_USER') < 0 && json.indexOf('sk-rci11-fake') < 0, json);
  check('G4.characterIdIsPlainStableId', one.every(r => typeof r.characterId === 'string' && r.characterId === 'char_A'), one.map(identOf));
  const leaked = calls.filter(c => /_ibConsumer|_ibCharacterId|_ibThreadId|"characterId"|"consumer"/.test(c.rawBody));
  check('G5.identityNeverInProviderBody', calls.length >= 1 && leaked.length === 0, leaked.map(c => c.rawBody.slice(0, 160)));
  const badUrl = calls.filter(c => !/^http:\/\/127\.0\.0\.1:1\//.test(c.url));
  check('G6.onlyFakeEndpointTouched', badUrl.length === 0, badUrl.map(c => c.url));

  /* ══════════ H. 结构（两条业务路径 + consumer 不碎片化） ══════════ */
  section('H · 结构契约（静态）');

  const src = read('assets/js/active-diary/diary.js');
  const seam = src.slice(src.indexOf('async function _diaryModelCall('), src.indexOf('/* 主生成管线'));
  check('H1.singleDirectCallSite', (src.match(/callApiChat\s*\(/g) || []).length === 1);
  check('H2.directCarriesIdentity',
    seam.includes("Object.assign({_ibConsumer:'diary',_ibCharacterId:_ibCharId},opts)"));
  check('H3.authorityIsCfgId', seam.includes("const _ibCharId=String((cfg&&cfg.id)||'');"));
  check('H4.runtimeRequestCarriesIdentity', /consumer:'diary',characterId:_ibCharId,spec:spec/.test(seam));
  /* planner 与 generation 两条路径都只经同一接缝；consumer 保持 'diary'（不新增 diary.planner/diary.entry）。 */
  const plannerSrc = src.slice(src.indexOf('async function _diaryDailyPlanner('), src.indexOf('/* 调度 tick'));
  const genSrc = src.slice(src.indexOf('/* 主生成管线'), src.indexOf('/* 每日 AI planner'));
  check('H5.plannerUsesSeam', /await _diaryModelCall\(/.test(plannerSrc) && !/callApiChat/.test(plannerSrc));
  check('H6.generationUsesSeam', /await _diaryModelCall\(/.test(genSrc) && !/callApiChat/.test(genSrc));
  check('H7.noFragmentedDiaryConsumers', !/_ibConsumer:'diary\./.test(src) && !/consumer:'diary\./.test(src));
  check('H8.plannerKindStillSeparate',
    /\{kind:'planner'\}/.test(plannerSrc) && /kind:'generate'|_diaryExecLog\(cfg,\{executor:'runtime'/.test(src));

  /* agent-runtime 的 runtime 信封：characterId 与 consumer 同一类（可选、默认 ''、永不进 wire）。 */
  const rtSrc = read('assets/js/agent-runtime.js');
  check('H9.runtimeEnvelopeAcceptsCharacterId',
    /const characterId = String\(\(request && request\.characterId\) \|\| ''\)/.test(rtSrc));
  check('H10.runtimeForwardsAsCallOpt', /_ibCharacterId: characterId/.test(rtSrc));
  check('H11.identityNotInExecutorWhitelist',
    /const EXECUTOR_PASSTHROUGH = \['wantThinking', 'timeoutMs', 'heartbeatMs', 'disableTools'\];/.test(rtSrc));

  console.log('\n' + (failed
    ? 'RCI-1.1 diary identity regression FAILED: ' + failed + ' failed / ' + passed + ' passed'
    : 'RCI-1.1 diary identity regression passed \u2714 (' + passed + ' checks, 0 real AI calls)'));
  process.exitCode = failed ? 1 : 0;
})().catch(e => {
  console.error('RCI-1.1 test harness error: ' + ((e && e.stack) || e));
  process.exitCode = 1;
});
