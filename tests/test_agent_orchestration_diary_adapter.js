'use strict';

/* Internal Beyond · P25-3B · Diary Capability Adapter + Production Convergence
   （OD1–OD20 + PC1–PC15；纯 Node、零浏览器、零网络）

   OD 段：把**真实**的 Diary Authority 接到编排层，用假 domain writer 证明
          「Plan != Permission / DENY 零执行 / verifier 只验证」等编排边界。
   PC 段：在 vm 沙箱里加载**真实生产文件**（chat-core / voice-message-core /
          diary-authority / active-diary/diary.js），证明 legacy Diary 生产链
          （scheduler → model → authority → executor → canonical writer）
          与编排层共用同一个 authority，且既有行为（identity / duplicate /
          frequency / prompt / UI / Memory 副作用顺序）未被改写。

   本套件不触网、不写真实 IndexedDB：沙箱内 dbPut / dbGetAll 由内存 store 提供。 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.resolve(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const stripComments = src => String(src).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const R = require(path.join(ROOT, 'assets/js/agent-capability-registry.js'));
const C = require(path.join(ROOT, 'assets/js/agent-orchestration-core.js'));
const D = require(path.join(ROOT, 'assets/js/agent-orchestration-diary-adapter.js'));
const A = require(path.join(ROOT, 'assets/js/diary-authority.js'));

const ADAPTER_SRC = stripComments(read('assets/js/agent-orchestration-diary-adapter.js'));
const AUTHORITY_SRC = stripComments(read('assets/js/diary-authority.js'));
const DIARY_SRC = read('assets/js/active-diary/diary.js');
const DIARY = stripComments(DIARY_SRC);

let passed = 0, failed = 0;
const failures = [];
function check(name, cond, extra) {
  if (cond) { passed++; console.log('  \u2714 ' + name); }
  else { failed++; failures.push(name); console.log('  \u2716 ' + name + (extra === undefined ? '' : '  -> ' + JSON.stringify(extra).slice(0, 320))); }
}
const REASONING = /thinking|chain_of_thought|chainofthought|scratchpad|internal_reasoning|rationale|\bcot\b/i;
const MODEL_OUTPUT = { title: 'DIARY_TITLE', content: 'DIARY_CONTENT_A', mood: '平静', diaryType: 'daily',
  importance: 5, relatedMemoryIds: [], memoryCandidate: null };
const MEMORY_OUTPUT = Object.assign({}, MODEL_OUTPUT, { memoryCandidate: { content: '值得记住的一件小事', importance: 8, type: 'experience' } });

function makeElement() {
  return { value: '', textContent: '', innerHTML: '', className: '', style: {}, onclick: null, children: [],
    append() { for (let i = 0; i < arguments.length; i++) this.children.push(arguments[i]); },
    appendChild(node) { this.children.push(node); },
    remove() {} };
}
/* 真实生产文件的沙箱：window 即全局，IndexedDB / model / DOM 全部由内存桩替代。 */
function createDiaryRuntime(overrides) {
  const o = overrides || {};
  const win = {};
  win.window = win;
  win.self = win;
  const warns = [];
  win.console = { info() {}, warn: (...a) => { warns.push(a.map(String).join(' ')); }, log() {}, error() {} };
  /* 真实 NS.expose 支持点号命名空间（'active.diary'）→ 沙箱必须一模一样 */
  win.IB = { expose(name, obj) {
    const parts = String(name).split('.');
    let cur = win.IB;
    for (let i = 0; i < parts.length - 1; i++) { cur = cur[parts[i]] = cur[parts[i]] || {}; }
    cur[parts[parts.length - 1]] = obj;
  } };
  const storage = Object.create(null);
  win.localStorage = {
    getItem: k => (k in storage ? storage[k] : null),
    setItem: (k, v) => { storage[k] = String(v); },
    removeItem: k => { delete storage[k]; }
  };
  const store = Object.create(null), puts = [], modelCalls = [], toasts = [];
  win.db = {};
  win.dbPut = async (s, d) => {
    if (o.failStore === s) throw new Error('db put failed: ' + s);
    const row = JSON.parse(JSON.stringify(d));
    (store[s] = store[s] || []).push(row);
    puts.push({ store: s, id: d && d.id });
  };
  win.dbGet = async (s, id) => ((store[s] || []).find(r => r.id === id) || null);
  win.dbGetAll = async s => (store[s] || []).map(r => JSON.parse(JSON.stringify(r)));
  win.dbDelete = async (s, id) => { store[s] = (store[s] || []).filter(r => r.id !== id); };
  win.dbGetByIndex = async () => [];
  win.apiConfigs = [{ id: 'role_a', provider: 'openai', model: 'diary-model', apiKey: 'sk-test-key-1234',
    endpoint: 'http://127.0.0.1:1/v1/chat/completions', nickname: '阿黎', systemPrompt: '你是阿黎。' }];
  win.archivedConfigs = [];
  win._ibApiReady = cfg => !!(cfg && cfg.id);
  /* 同一个 callApiChat 桩要服务两条真实生产路径：
       planner（_diaryDailyPlanner，prompt 含"判断今天是否值得写"）与 generation。 */
  win.callApiChat = async (cfg, messages) => {
    const raw = JSON.stringify(messages || []);
    if (raw.indexOf('判断今天是否值得写') >= 0) {
      modelCalls.push('planner');
      return JSON.stringify(o.planner || { shouldWrite: true, reason: 'PC-PLAN', diaryType: 'daily', importance: 8 });
    }
    modelCalls.push('generate');
    return JSON.stringify(o.model || MODEL_OUTPUT);
  };
  win._activeParsePlanJson = raw => { try { return JSON.parse(raw); } catch (e) { return null; } };
  win._activeTextSimilarity = () => 0;
  win._activeRecentMemories = async () => [];
  win._activeRecentProactiveMessages = async () => [];
  win._activeRecentMessages = async () => [];
  win._activeUserId = () => 'user_1';
  win._cachedUserName = '用户';
  win.currentPage = 'other';
  win.toast = m => { toasts.push(String(m)); };
  win.confirm = () => true;
  const els = Object.create(null);
  win.document = {
    createElement: () => makeElement(),
    createTextNode: t => ({ text: String(t) }),
    getElementById(id) { if (!(id in els)) els[id] = makeElement(); return els[id]; }
  };
  vm.createContext(win);
  for (const f of ['assets/js/chat-core.js', 'assets/js/voice-message-core.js',
    'assets/js/diary-authority.js', 'assets/js/active-diary/diary.js']) {
    vm.runInContext(read(f), win, { filename: f });
  }
  return { win, store, puts, modelCalls, toasts, els, storage, warns,
    rowsFor: actor => (store.diary_entries || []).filter(r => r.characterId === actor) };
}
async function waitFor(fn, timeout) {
  const end = Date.now() + (timeout || 3000);
  for (;;) {
    if (fn()) return true;
    if (Date.now() > end) return false;
    await new Promise(r => setTimeout(r, 20));
  }
}
const candidateIdFor = input => A.buildDiaryCandidate(input).candidate.candidateId;

console.log('== P25-3B · Diary Capability Adapter + Production Convergence ==');

/* ══════════ OD · Orchestration Diary Adapter ══════════ */
const reg = R.createCapabilityRegistry();
const registered = D.registerDiaryCapabilities(reg);
const descriptor = reg.get('diary.write');

/* OD1 diary.write registered */
check('OD1.diaryWriteRegistered', registered.ok === true && reg.has('diary.write') && reg.size() === 1, registered);

/* OD2 correct descriptor */
check('OD2.descriptorShape',
  !!descriptor && descriptor.domain === 'diary' && descriptor.kind === 'write' && descriptor.sideEffect === 'local'
  && descriptor.authorityType === 'domain' && descriptor.binding === 'diary.write'
  && descriptor.availability === 'available' && descriptor.description.length > 0
  && Object.isFrozen(descriptor) && Object.isFrozen(descriptor.notes), descriptor);

/* OD4/OD5/OD18/OD19/OD20：适配器自身的静态边界（剥注释后判定） */
const adapterHits = needles => needles.filter(n => ADAPTER_SRC.indexOf(n) >= 0);
check('OD4.cannotWriteDatabaseDirectly',
  adapterHits(['dbPut', 'dbGet', 'dbDelete', 'indexedDB', 'DIARY_STORE', 'diary_entries', 'generateDiaryEntry', 'localStorage']).length === 0,
  adapterHits(['dbPut', 'dbGet', 'dbDelete', 'indexedDB', 'DIARY_STORE', 'diary_entries', 'generateDiaryEntry', 'localStorage']));
check('OD5.cannotCallModelDirectly',
  adapterHits(['callApiChat', 'fetch(', 'runtime.execute', 'resolveModel', 'messages', 'systemPrompt']).length === 0,
  adapterHits(['callApiChat', 'fetch(', 'runtime.execute', 'resolveModel', 'messages', 'systemPrompt']));
check('OD18.noMemoryIntegration',
  adapterHits(['memories', 'memoryCandidate', 'updateMemDashboard', 'IBMemory']).length === 0
  && AUTHORITY_SRC.indexOf('memories') < 0 && AUTHORITY_SRC.indexOf('memoryCandidate') < 0,
  adapterHits(['memories', 'memoryCandidate', 'updateMemDashboard', 'IBMemory']));
check('OD19.noMiddleBrainIntegration',
  adapterHits(['_mbSideEffectGate', '_execMemOps', 'middleBrain', '_MB_SEC']).length === 0
  && AUTHORITY_SRC.indexOf('_mbSideEffectGate') < 0 && AUTHORITY_SRC.indexOf('_execMemOps') < 0,
  adapterHits(['_mbSideEffectGate', '_execMemOps', 'middleBrain', '_MB_SEC']));
check('OD20b.noSecretNoCotInAdapterSource',
  !REASONING.test(ADAPTER_SRC) && adapterHits(['apiKey', 'credential', 'reasoningTrace']).length === 0
  && !REASONING.test(AUTHORITY_SRC), { adapter: adapterHits(['apiKey', 'credential', 'reasoningTrace']) });

/* 编排用假 domain writer（真实写入口在 PC 段验证） */
function makeAdapter(overrides) {
  const o = overrides || {};
  const spies = { authority: 0, domain: [] };
  const authority = {
    buildDiaryCandidate: A.buildDiaryCandidate,
    sourceOfTrigger: A.sourceOfTrigger,
    runDiaryWrite: (candidate, facts, executor) => { spies.authority++; return A.runDiaryWrite(candidate, facts, executor); },
    verifyDiaryWrite: A.verifyDiaryWrite
  };
  const rows = Object.create(null);
  const domain = {
    writeDiary: async envelope => {
      spies.domain.push(envelope);
      if (o.failDomain) return { ok: false, error: 'domain-write-failed' };
      const entry = { id: 'diary_' + spies.domain.length, characterId: envelope.actorId, candidateId: envelope.candidateId };
      rows[entry.id] = entry;
      return { ok: true, entry: entry };
    }
  };
  const adapter = D.createDiaryOrchestrationAdapter({ authority: authority, domain: domain, reader: async id => rows[id] || null });
  return { adapter: adapter, spies: spies, rows: rows, authority: authority, domain: domain };
}
const factsAllow = { actorKnown: true, enabled: true, hasContent: true, cancelled: false };
function planOf(facts, extraInput) {
  return { planId: 'plan_diary', actorId: 'role_a', steps: [{ stepId: 's1', capabilityId: 'diary.write', reasonCode: 'manual',
    input: Object.assign({ actorId: 'role_a', source: 'user', trigger: 'manual', triggerRef: '', diaryType: 'daily', facts: facts }, extraInput || {}) }] };
}
async function runPlan(ctx, plan, opts) {
  const validated = C.validateAgentPlan(plan, reg);
  if (!validated.ok) return { invalid: validated.errors, steps: [] };
  return C.runAgentPlan(validated.plan, reg, Object.assign({
    invokeAuthority: ctx.adapter.invokeAuthority,
    resolveExecutor: ctx.adapter.resolveExecutor,
    idempotencyKeyFor: ctx.adapter.idempotencyKeyFor
  }, (opts && opts.deps) || {}));
}

(async () => {
  /* OD3 routes to Diary Authority */
  const okCtx = makeAdapter();
  const okRun = await runPlan(okCtx, planOf(factsAllow));
  check('OD3.routesToDiaryAuthority',
    okCtx.spies.authority === 1 && okRun.steps[0].status === 'completed' && okRun.steps[0].ok === true,
    { authority: okCtx.spies.authority, step: okRun.steps[0] });

  /* OD6 Plan != Permission（plan 合法 ≠ 允许执行） */
  const denyCtx = makeAdapter();
  const denyPlan = planOf({ actorKnown: true, enabled: false, hasContent: true, cancelled: false });
  const denyValidated = C.validateAgentPlan(denyPlan, reg);
  const denyRun = await runPlan(denyCtx, denyPlan);
  check('OD6.planIsNotPermission',
    denyValidated.ok === true && denyRun.steps[0].status === 'denied' && denyRun.steps[0].errorCode === 'disabled'
    && denyRun.ok === false, { validated: denyValidated.ok, step: denyRun.steps[0] });

  /* OD7 DENY zero executor */
  check('OD7.denyRunsNoExecutor',
    denyCtx.spies.domain.length === 0 && Object.keys(denyCtx.adapter.captured).length === 0
    && denyRun.reflection.outcome === 'failed' && denyRun.reflection.deniedSteps.indexOf('s1') >= 0,
    denyCtx.spies.domain);

  /* OD8 ALLOW executor once（第二次调用被拒） */
  const okExecutor = okCtx.adapter.resolveExecutor(descriptor);
  const twice = await okExecutor({ stepId: 's1', input: {}, idempotencyKey: 'k' });
  check('OD8.allowRunsExecutorOnce',
    okCtx.spies.domain.length === 1 && okCtx.adapter.executorCalls.s1 === 2
    && twice.ok === false && twice.errorCode === 'executor-called-twice', twice);

  /* OD9 failed executor → failed */
  const failCtx = makeAdapter({ failDomain: true });
  const failRun = await runPlan(failCtx, planOf(factsAllow));
  check('OD9.executorFailureBecomesFailed',
    failRun.steps[0].status === 'failed' && failRun.steps[0].ok === false
    && failCtx.spies.authority === 1 && failCtx.spies.domain.length === 1
    && failRun.reflection.outcome === 'failed', failRun.steps[0]);

  /* OD10 verifier confirms canonical row */
  const verified = await okCtx.adapter.verify(okRun.steps[0]);
  check('OD10.verifierConfirmsCanonicalRow',
    verified.verified === true && verified.ok === true && verified.entryId === 'diary_1', verified);

  /* OD11 fake success without row fails verify */
  const fakeVerify = await okCtx.adapter.verify({ status: 'completed', ok: true, output: { entryId: 'diary_missing', actorId: 'role_a' } });
  const notCompleted = await okCtx.adapter.verify({ status: 'denied', ok: false, output: { entryId: 'diary_1', actorId: 'role_a' } });
  check('OD11.fakeSuccessFailsVerification',
    fakeVerify.verified === false && fakeVerify.errorCode === 'canonical-entry-missing'
    && notCompleted.errorCode === 'not-completed', { fakeVerify: fakeVerify, notCompleted: notCompleted });

  /* OD12 verifier never writes */
  const writesBefore = okCtx.spies.domain.length;
  await okCtx.adapter.verify(okRun.steps[0]);
  await okCtx.adapter.verify(okRun.steps[0]);
  check('OD12.verifierNeverWrites',
    okCtx.spies.domain.length === writesBefore && okCtx.spies.authority === 1
    && ADAPTER_SRC.indexOf('dbPut') < 0, { domain: okCtx.spies.domain.length, before: writesBefore });

  /* OD13 idempotency passthrough（domain 持有身份，本层只透传） */
  const idemStep = planOf(factsAllow).steps[0];
  const derived = okCtx.adapter.idempotencyKeyFor(descriptor, idemStep);
  const explicit = okCtx.adapter.idempotencyKeyFor(descriptor, { stepId: 's2', input: { idempotencyKey: 'domain-owned-key' } });
  const idemCtx = makeAdapter();
  const idemRun = await runPlan(idemCtx, planOf(factsAllow, { idempotencyKey: 'domain-owned-key' }));
  check('OD13.idempotencyKeyPassthrough',
    derived === candidateIdFor({ actorId: 'role_a', source: 'user', trigger: 'manual', triggerRef: '', diaryType: 'daily' })
    && explicit === 'domain-owned-key' && idemRun.steps[0].idempotencyKey === 'domain-owned-key'
    && idemCtx.spies.domain[0].idempotencyKey === 'domain-owned-key'
    && idemCtx.spies.domain[0].candidateId === derived,
    { derived: derived, explicit: explicit, envelope: idemCtx.spies.domain[0] });

  /* OD14 actor identity preserved */
  check('OD14.actorIdentityPreserved',
    idemCtx.spies.domain[0].actorId === 'role_a' && idemRun.steps[0].output.actorId === 'role_a'
    && idemCtx.adapter.captured.s1.actorId === 'role_a', idemCtx.spies.domain[0]);

  /* OD15 cancellation before write */
  const cancelCtx = makeAdapter();
  const cancelRun = await runPlan(cancelCtx, planOf(factsAllow), { deps: { isCancelled: () => true } });
  check('OD15.cancellationBeforeWrite',
    cancelRun.steps[0].status === 'denied' && cancelRun.steps[0].errorCode === 'cancelled'
    && cancelCtx.spies.authority === 0 && cancelCtx.spies.domain.length === 0, cancelRun.steps[0]);

  /* OD16 completed write not rolled back（取消不回滚已完成的 side effect） */
  const rollbackCtx = makeAdapter();
  let cancelled = false;
  const firstRun = await runPlan(rollbackCtx, planOf(factsAllow), { deps: { isCancelled: () => cancelled } });
  cancelled = true;
  const twoStepPlan = { planId: 'plan_diary_2', actorId: 'role_a', steps: [
    { stepId: 's1', capabilityId: 'diary.write', reasonCode: 'manual', input: planOf(factsAllow).steps[0].input },
    { stepId: 's2', capabilityId: 'diary.write', reasonCode: 'manual', input: planOf(factsAllow).steps[0].input }
  ] };
  const secondRun = await runPlan(rollbackCtx, twoStepPlan, { deps: { isCancelled: () => cancelled } });
  check('OD16.completedWriteNotRolledBack',
    firstRun.steps[0].status === 'completed' && rollbackCtx.spies.domain.length === 1
    && secondRun.steps.every(s => s.status === 'denied' && s.errorCode === 'cancelled')
    && rollbackCtx.spies.domain.length === 1,
    { first: firstRun.steps[0].status, second: secondRun.steps.map(s => s.status) });

  /* OD17 no automatic retry（side effect 绝不自动重试：同一 plan 失败即失败，
     同一个 step 的第二次执行被适配器直接拒绝） */
  const retryCtx = makeAdapter({ failDomain: true });
  const retryFirst = await runPlan(retryCtx, planOf(factsAllow));
  const retrySecond = await runPlan(retryCtx, planOf(factsAllow));
  check('OD17.noAutomaticRetry',
    retryCtx.spies.domain.length === 1
    && retryFirst.steps[0].status === 'failed' && retrySecond.steps[0].status === 'failed'
    && retrySecond.steps[0].errorCode === 'executor-called-twice'
    && retryFirst.steps[0].errorCode === 'domain-write-failed'
    && ADAPTER_SRC.indexOf('retry') < 0, { domainCalls: retryCtx.spies.domain.length });

  /* OD20 动态：secret 不进 plan；结果不含 secret / CoT */
  const secretPlan = planOf(factsAllow, { apiKey: 'sk-abcdefgh1234' });
  const secretValidated = C.validateAgentPlan(secretPlan, reg);
  const okJson = JSON.stringify({ steps: okRun.steps, captured: okCtx.adapter.captured });
  check('OD20.noSecretNoCotInResults',
    secretValidated.ok === false && secretValidated.errors.some(e => e.indexOf('secret') >= 0)
    && !REASONING.test(okJson) && okJson.indexOf('sk-') < 0 && okJson.indexOf('apiKey') < 0,
    { errors: secretValidated.errors });

  await runProductionChecks();
})().catch(e => { console.error(e && e.stack || e); process.exitCode = 1; });

/* ══════════ PC · Production Convergence（真实 diary.js 生产链）══════════ */
const sleep = ms => new Promise(r => setTimeout(r, ms));
const collectText = el => {
  if (!el || typeof el !== 'object') return '';
  let out = String(el.textContent || el.text || '');
  (el.children || []).forEach(c => { out += ' ' + collectText(c); });
  return out;
};
/* 调度到期用**每日 planner**路径验证（确定性，不依赖时钟）：
   weekly 分支需 now >= weeklyTime，而 domain 既有 _diaryHhmm('00:00') 会把 0 点折叠成 22:00
   （既有实现细节，见 docs/P25-3B-DIARY-CAPABILITY.md「Known limitations」）。 */
const PLANNER_DUE_PREFS = () => ({ enabled: true, weeklyEnabled: false, weeklyDay: 0, weeklyTime: '22:00',
  dailyPlannerEnabled: true, eventEnabled: false });
const NOT_WRITING_PREFS = () => ({ enabled: true, weeklyEnabled: false, weeklyDay: 0, weeklyTime: '22:00',
  dailyPlannerEnabled: true, eventEnabled: false });
const TICK_BODY = DIARY_SRC.slice(DIARY_SRC.indexOf('async function _diaryTick('), DIARY_SRC.indexOf('/* 特殊事件'));
const MODEL_SEAM = DIARY_SRC.slice(DIARY_SRC.indexOf('async function _diaryModelCall('), DIARY_SRC.indexOf('/* 主生成管线'));
const PARSE_BODY = DIARY_SRC.slice(DIARY_SRC.indexOf('function _diaryParseOutput('), DIARY_SRC.indexOf('/* ══════════ P25-3B'));

async function runProductionChecks() {
  /* ── PC1 legacy Diary scheduler uses Diary Authority ─────────────────── */
  const rt1 = createDiaryRuntime();
  const decisions1 = [];
  const real1 = rt1.win.IBDiaryAuthority;
  rt1.win.IBDiaryAuthority = Object.assign({}, real1, {
    runDiaryWrite: async (c, f, e) => { const r = await real1.runDiaryWrite(c, f, e); decisions1.push(r.decision); return r; }
  });
  rt1.win._diaryPrefsSave(PLANNER_DUE_PREFS());
  await rt1.win._diaryTick();
  const wrote1 = await waitFor(() => rt1.rowsFor('role_a').length === 1);
  const row1 = rt1.rowsFor('role_a')[0] || {};
  check('PC1.legacySchedulerUsesDiaryAuthority',
    wrote1 && decisions1.length >= 1 && decisions1[0] === 'allow'
    && row1.trigger === 'daily_plan' && row1.diaryType === 'daily'
    && DIARY.indexOf('const run=await _diaryRunWrite(') >= 0,
    { wrote: wrote1, decisions: decisions1, trigger: row1.trigger, warns: rt1.warns.slice(0, 2) });

  /* ── PC2 scheduler cannot write directly ─────────────────────────────── */
  check('PC2.schedulerCannotWriteDirectly',
    TICK_BODY.indexOf('generateDiaryEntry(') >= 0
    && !/dbPut|_diaryWriteCanonical|_diaryRunWrite|DIARY_STORE|_diaryWriteMemory/.test(TICK_BODY));

  /* ── PC3 model cannot write directly ─────────────────────────────────── */
  const rt3 = createDiaryRuntime();
  const real3 = rt3.win.IBDiaryAuthority;
  rt3.win.IBDiaryAuthority = Object.assign({}, real3, {
    runDiaryWrite: async () => ({ ok: false, decision: 'deny', reason: 'model-output-is-not-permission', executed: false, actorId: 'role_a', entry: null, error: '' })
  });
  const denied3 = await rt3.win.generateDiaryEntry('role_a', { trigger: 'manual' });
  check('PC3.modelCannotWriteDirectly',
    rt3.modelCalls.length >= 1 && rt3.puts.length === 0 && denied3.ok === false
    && /model-output-is-not-permission/.test(String(denied3.error))
    && !/dbPut|_diaryWriteCanonical|DIARY_STORE/.test(MODEL_SEAM) && !/dbPut|DIARY_STORE/.test(PARSE_BODY),
    { modelCalls: rt3.modelCalls.length, puts: rt3.puts.length, error: denied3.error });

  /* ── PC4 production ALLOW writes exactly one Diary ───────────────────── */
  const rt4 = createDiaryRuntime();
  const res4 = await rt4.win.generateDiaryEntry('role_a', { trigger: 'manual', diaryType: 'daily', reason: 'PC4' });
  const diaryPuts4 = rt4.puts.filter(p => p.store === 'diary_entries');
  check('PC4.allowWritesExactlyOneDiary',
    res4.ok === true && diaryPuts4.length === 1 && rt4.rowsFor('role_a').length === 1
    && rt4.puts.filter(p => p.store === 'memories').length === 0
    && res4.entry.id === diaryPuts4[0].id && res4.entry.trigger === 'manual',
    { puts: rt4.puts, ok: res4.ok });

  /* ── PC5 production DENY writes zero Diary ───────────────────────────── */
  const rt5 = createDiaryRuntime();
  rt5.win._diaryPrefsSave({ enabled: false, weeklyEnabled: false, weeklyDay: 0, weeklyTime: '22:00',
    dailyPlannerEnabled: false, eventEnabled: false });
  const res5 = await rt5.win.generateDiaryEntry('role_a', { trigger: 'manual' });
  check('PC5.denyWritesZeroDiary',
    res5.ok === false && rt5.puts.length === 0 && rt5.rowsFor('role_a').length === 0
    && /disabled/.test(String(res5.error)), { error: res5.error, puts: rt5.puts.length });

  /* ── PC6 production executor failure does not become DENY ────────────── */
  const rt6 = createDiaryRuntime({ failStore: 'diary_entries' });
  const seen6 = [];
  const real6 = rt6.win.IBDiaryAuthority;
  rt6.win.IBDiaryAuthority = Object.assign({}, real6, {
    runDiaryWrite: async (c, f, e) => { const r = await real6.runDiaryWrite(c, f, e); seen6.push(r.decision + '/' + r.executed + '/' + r.ok); return r; }
  });
  const res6 = await rt6.win.generateDiaryEntry('role_a', { trigger: 'manual' });
  check('PC6.executorFailureIsNotDeny',
    res6.ok === false && seen6[0] === 'allow/true/false'
    && /db put failed/.test(String(res6.error))
    && !/disabled|unknown-actor|cancelled|invalid-candidate/.test(String(res6.error))
    && rt6.puts.filter(p => p.store === 'diary_entries').length === 0,
    { seen: seen6, error: res6.error });

  /* ── PC7 existing scheduler timing unchanged ─────────────────────────── */
  /* (a) 周记日不是今天 → 连模型都不调用 */
  const rt7 = createDiaryRuntime();
  rt7.win._diaryPrefsSave({ enabled: true, weeklyEnabled: true, weeklyDay: (new Date().getDay() + 1) % 7,
    weeklyTime: '22:00', dailyPlannerEnabled: false, eventEnabled: false });
  await rt7.win._diaryTick();
  await sleep(150);
  const notDue = rt7.puts.length === 0 && rt7.modelCalls.length === 0;
  /* (b) planner 判定"不值得写" → 同样不生成 */
  const rt7b = createDiaryRuntime({ planner: { shouldWrite: false, reason: 'nothing', importance: 3 } });
  rt7b.win._diaryPrefsSave(NOT_WRITING_PREFS());
  await rt7b.win._diaryTick();
  await sleep(150);
  const plannerSkip = rt7b.puts.length === 0 && rt7b.modelCalls.join(',') === 'planner';
  /* (c) planner 判定"值得写" → 恰好一次生成 */
  const rt7c = createDiaryRuntime();
  rt7c.win._diaryPrefsSave(NOT_WRITING_PREFS());
  await rt7c.win._diaryTick();
  const due = await waitFor(() => rt7c.rowsFor('role_a').length === 1);
  check('PC7.schedulerTimingUnchanged',
    notDue && plannerSkip && due
    && TICK_BODY.indexOf('if(prefs.weeklyEnabled&&now.getDay()===prefs.weeklyDay){') >= 0
    && TICK_BODY.indexOf('now.getHours()*60+now.getMinutes()>=_diaryHhmm(prefs.weeklyTime)') >= 0
    && TICK_BODY.indexOf("if(dm!==todayKey){") >= 0 && TICK_BODY.indexOf('if(wm!==weekKey') >= 0
    && TICK_BODY.indexOf('const plan=await _diaryDailyPlanner(cfg,{signal:opts.signal});') >= 0
    && TICK_BODY.indexOf('if(plan.shouldWrite){') >= 0,
    { notDue: notDue, plannerSkip: plannerSkip, due: due, warns: rt7.warns.slice(0, 2) });

  /* ── PC8 existing frequency unchanged（水位线：同一天只写一次）───────── */
  const rt8 = createDiaryRuntime();
  rt8.win._diaryPrefsSave(NOT_WRITING_PREFS());
  await rt8.win._diaryTick();
  await waitFor(() => rt8.rowsFor('role_a').length === 1);
  await rt8.win._diaryTick();
  await sleep(200);
  check('PC8.frequencyWatermarkUnchanged',
    rt8.rowsFor('role_a').length === 1 && rt8.storage.ib_diary_watermarks_v1.indexOf('dl_role_a') >= 0
    && rt8.modelCalls.filter(k => k === 'planner').length === 1,
    { rows: rt8.rowsFor('role_a').length, watermarks: rt8.storage.ib_diary_watermarks_v1, calls: rt8.modelCalls.join(',') });

  /* ── PC9 existing role selection unchanged ───────────────────────────── */
  const rt9 = createDiaryRuntime();
  const res9a = await rt9.win.generateDiaryEntry('missing_role', { trigger: 'manual' });
  rt9.win.apiConfigs = [Object.assign({}, rt9.win.apiConfigs[0], { id: 'role_b', apiKey: '' })];
  rt9.win._ibApiReady = cfg => !!(cfg && cfg.id === 'role_a');
  const res9b = await rt9.win.generateDiaryEntry('role_b', { trigger: 'manual' });
  check('PC9.roleSelectionUnchanged',
    res9a.ok === false && res9a.error === '角色配置不存在' && res9b.ok === false && res9b.error === '角色 API 配置不完整'
    && rt9.puts.length === 0
    && DIARY.indexOf('const cfg=apiConfigs.find(a=>a.id===characterId)||archivedConfigs.find(a=>a.id===characterId);') >= 0,
    { a: res9a, b: res9b });

  /* ── PC10 existing prompt / model-call count unchanged ──────────────── */
  const rt10 = createDiaryRuntime();
  const res10 = await rt10.win.generateDiaryEntry('role_a', { trigger: 'manual' });
  const prompt10 = rt10.win.buildDiaryPrompt({ character: rt10.win.apiConfigs[0],
    context: { user: { name: '用户' }, character: rt10.win.apiConfigs[0], recentMessages: [], memories: [] },
    diaryType: 'daily', reason: '手动请求' });
  const sections = ['【任务】', '【今天日期】', '【角色与用户的关系】', '【最近聊天摘要】', '【最近聊天内容】',
    '【相关长期记忆】', '【最近主动消息】', '【本次日记类型】', '【触发原因】', '【写作要求】', '【输出格式】'];
  const idx = sections.map(s => prompt10.messages[1].content.indexOf(s));
  check('PC10.promptAndModelCountUnchanged',
    res10.ok === true && rt10.modelCalls.length === 1 && prompt10.messages.length === 2
    && prompt10.messages[0].role === 'system' && prompt10.system === prompt10.messages[0].content
    && prompt10.messages[1].content.indexOf('第一人称写一篇私人日记') >= 0
    && idx.every((v, i) => v >= 0 && (i === 0 || v > idx[i - 1])), { calls: rt10.modelCalls.length, idx: idx });

  /* ── PC11 existing Diary UI still works ─────────────────────────────── */
  const rt11 = createDiaryRuntime();
  await rt11.win.generateDiaryEntry('role_a', { trigger: 'manual' });
  rt11.win.document.getElementById('diary-character').value = 'role_a';
  rt11.win.loadDiaryPage();
  await rt11.win._diaryRenderVault();
  const listText = collectText(rt11.win.document.getElementById('diary-list'));
  await rt11.win._diaryWriteNow();
  const uiRows = await waitFor(() => rt11.rowsFor('role_a').length === 2);
  check('PC11.diaryUiStillWorks',
    listText.indexOf('DIARY_TITLE') >= 0 && uiRows === true && rt11.toasts.indexOf('正在写日记…') >= 0
    && rt11.toasts.indexOf('日记已写好') >= 0
    && typeof rt11.win.IB.active.diary._diaryRenderVault === 'function'
    && rt11.win.IB.active.diary.generateDiaryEntry === rt11.win.generateDiaryEntry,
    { listText: listText.slice(0, 120), toasts: rt11.toasts });

  /* ── PC12 existing Diary read / delete unchanged ────────────────────── */
  const recent12 = await rt11.win._diaryRecent('role_a', 5);
  const target12 = rt11.rowsFor('role_a')[0];
  await rt11.win._diaryDelete(target12.id);
  const afterDelete12 = rt11.rowsFor('role_a');
  check('PC12.diaryReadAndDeleteUnchanged',
    recent12.length === 2 && recent12[0].date >= recent12[1].date
    && !afterDelete12.some(r => r.id === target12.id) && rt11.toasts.indexOf('日记已删除') >= 0
    && DIARY.indexOf('function _diaryRecent(characterId,limit){') >= 0
    && DIARY.indexOf('await dbDelete(DIARY_STORE,id);') >= 0,
    { recent: recent12.length, left: afterDelete12.length });

  /* ── PC13 _diaryWriteMemory ordering documented and tested ──────────── */
  const rt13 = createDiaryRuntime({ model: MEMORY_OUTPUT });
  const res13 = await rt13.win.generateDiaryEntry('role_a', { trigger: 'manual' });
  const seq13 = rt13.puts.map(p => p.store).join(',');
  const authorityAt13 = DIARY.indexOf('const run=await _diaryRunWrite(');
  const memoryAt13 = DIARY.indexOf('const mem=await _diaryWriteMemory(cfg,parsed.memoryCandidate);');
  check('PC13.memorySideEffectComesAfterCanonicalWrite',
    res13.ok === true && seq13 === 'diary_entries,memories,diary_entries'
    && !!res13.memory && res13.entry.relatedMemoryIds.indexOf(res13.memory.id) >= 0
    && authorityAt13 >= 0 && authorityAt13 < memoryAt13
    && memoryAt13 < DIARY.indexOf("if(currentPage==='diary')_diaryRenderVault();"),
    { seq: seq13, memory: !!res13.memory });

  /* ── PC14 Memory failure semantics preserved ────────────────────────── */
  const rt14 = createDiaryRuntime({ model: MEMORY_OUTPUT, failStore: 'memories' });
  const res14 = await rt14.win.generateDiaryEntry('role_a', { trigger: 'manual' });
  check('PC14.memoryFailureDoesNotFailDiary',
    res14.ok === true && res14.memory === null && rt14.rowsFor('role_a').length === 1
    && rt14.puts.map(p => p.store).join(',') === 'diary_entries',
    { ok: res14.ok, memory: res14.memory, puts: rt14.puts.map(p => p.store) });

  /* ── PC15 no duplicate Diary caused by Orchestration ────────────────── */
  const rt15 = createDiaryRuntime();
  const authorityCalls15 = [];
  const real15 = rt15.win.IBDiaryAuthority;
  rt15.win.IBDiaryAuthority = Object.assign({}, real15, {
    runDiaryWrite: (c, f, e) => { authorityCalls15.push('domain'); return real15.runDiaryWrite(c, f, e); }
  });
  const orchestratingAuthority = {
    buildDiaryCandidate: A.buildDiaryCandidate,
    sourceOfTrigger: A.sourceOfTrigger,
    verifyDiaryWrite: A.verifyDiaryWrite,
    runDiaryWrite: (c, f, e) => { authorityCalls15.push('orchestration'); return A.runDiaryWrite(c, f, e); }
  };
  const reg15 = R.createCapabilityRegistry();
  D.registerDiaryCapabilities(reg15);
  const adapter15 = D.createDiaryOrchestrationAdapter({
    authority: orchestratingAuthority,
    domain: {
      writeDiary: async env => {
        /* 编排层转交的**既有** domain 入口：真实生产 generateDiaryEntry */
        const res = await rt15.win.generateDiaryEntry(env.actorId, { trigger: env.trigger || 'manual',
          diaryType: env.diaryType || 'daily', triggerRef: env.triggerRef || '', reason: env.reason || '' });
        return { ok: res.ok === true, entry: res.entry || null, error: res.error || '' };
      }
    },
    reader: async id => (rt15.store.diary_entries || []).find(r => r.id === id) || null
  });
  const plan15 = { planId: 'plan_pc15', actorId: 'role_a', steps: [{ stepId: 's1', capabilityId: 'diary.write', reasonCode: 'manual',
    input: { actorId: 'role_a', source: 'user', trigger: 'manual', triggerRef: '', diaryType: 'daily',
      facts: { actorKnown: true, enabled: true, hasContent: true } } }] };
  const validated15 = C.validateAgentPlan(plan15, reg15);
  const run15 = await C.runAgentPlan(validated15.plan, reg15, {
    invokeAuthority: adapter15.invokeAuthority,
    resolveExecutor: adapter15.resolveExecutor,
    idempotencyKeyFor: adapter15.idempotencyKeyFor
  });
  const step15 = run15.steps[0];
  const verified15 = await adapter15.verify(step15);
  const rows15 = rt15.rowsFor('role_a');
  const expectedIdem15 = candidateIdFor({ actorId: 'role_a', source: 'user', trigger: 'manual', triggerRef: '', diaryType: 'daily' });
  check('PC15.orchestrationWritesExactlyOneDiary',
    step15.status === 'completed' && rows15.length === 1
    && rt15.puts.filter(p => p.store === 'diary_entries').length === 1
    && authorityCalls15.length === 2 && step15.idempotencyKey === expectedIdem15
    && step15.output.entryId === rows15[0].id && verified15.verified === true,
    { status: step15.status, rows: rows15.length, authorityCalls: authorityCalls15.join(','), idem: step15.idempotencyKey });

  console.log('\n' + (failed
    ? 'P25-3B Diary adapter / production convergence FAILED: ' + failed + ' failed / ' + passed + ' passed'
    : 'P25-3B Diary adapter / production convergence passed \u2714 (' + passed + ' checks)'));
  process.exitCode = failed ? 1 : 0;
}
