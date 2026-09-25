'use strict';

/* Internal Beyond · P25-3C · Active Message Capability Adapter + Production Convergence
   （OA1–OA12 + PC1–PC10；纯 Node、零浏览器、零网络）

   OA 段：把**真实**的 Active Message Authority 接到编排层，用假 domain sender 证明
          「Plan != Permission / DENY 零执行 / verifier 只验证」等编排边界。
   PC 段：在 vm 沙箱里加载**真实生产文件**（chat-core / voice-message-core /
          active-message-authority / active-diary.js / active-diary/active-plans.js），
          驱动真实 scheduler（_activeTick → _activeClaimDue → _activeExecuteRun）与真实
          canonical writer，证明生产链也经同一条 authority，且既有行为
          （频率 / 冷却 / 免打扰 / 去重 / 用户偏好 / UI / 会话流 / companion 投递镜像）未被改写。

   本套件不触网、不写真实 IndexedDB：沙箱内 dbPut / dbGetAll / db.transaction 全部由内存桩提供。 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.resolve(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const stripComments = src => String(src).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const R = require(path.join(ROOT, 'assets/js/agent-capability-registry.js'));
const C = require(path.join(ROOT, 'assets/js/agent-orchestration-core.js'));
const D = require(path.join(ROOT, 'assets/js/agent-orchestration-active-message-adapter.js'));
const A = require(path.join(ROOT, 'assets/js/active-message-authority.js'));

const ADAPTER_SRC = stripComments(read('assets/js/agent-orchestration-active-message-adapter.js'));
const AUTHORITY_SRC = stripComments(read('assets/js/active-message-authority.js'));
const ACTIVE_RAW = read('assets/js/active-diary.js');
const ACTIVE = stripComments(ACTIVE_RAW);
const PLANS_RAW = read('assets/js/active-diary/active-plans.js');
const PLANS = stripComments(PLANS_RAW);

let passed = 0, failed = 0;
const failures = [];
function check(name, cond, extra) {
  if (cond) { passed++; console.log('  \u2714 ' + name); }
  else { failed++; failures.push(name); console.log('  \u2716 ' + name + (extra === undefined ? '' : '  -> ' + JSON.stringify(extra).slice(0, 320))); }
}
const REASONING = /thinking|chain_of_thought|chainofthought|scratchpad|internal_reasoning|rationale|\bcot\b/i;
const countOcc = (src, needle) => String(src).split(needle).length - 1;
const candidateIdFor = input => A.buildActiveMessageCandidate(input).candidate.candidateId;

function makeElement() {
  return { value: '', checked: false, textContent: '', innerHTML: '', className: '', style: {}, title: '', children: [],
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    append() { for (let i = 0; i < arguments.length; i++) this.children.push(arguments[i]); },
    appendChild(node) { this.children.push(node); },
    addEventListener() {}, remove() {}, closest() { return null; },
    querySelector() { return null; }, querySelectorAll() { return []; } };
}
/* 内存 IndexedDB 桩：只支持 _activeClaimDue 用到的 transaction/objectStore/get/put 形状
   （get 的结果经微任务回填 onsuccess —— 微任务一定先于任何定时器，因此嵌套的
   get → onsuccess → put 链总是先于 tx.oncomplete 完成；put 同步写入）。 */
function makeIdb(store) {
  return {
    transaction() {
      const tx = { error: null, oncomplete: null, onerror: null, onabort: null };
      tx.objectStore = function (name) {
        return {
          get(id) {
            const req = {};
            queueMicrotask(() => {
              req.result = (store[name] || []).find(r => r.id === id);
              if (req.onsuccess) req.onsuccess({ target: req });
            });
            return req;
          },
          put(row) {
            const arr = (store[name] = store[name] || []);
            const i = arr.findIndex(r => r.id === row.id);
            if (i >= 0) arr[i] = row; else arr.push(row);
            return {};
          }
        };
      };
      setTimeout(() => { if (tx.oncomplete) tx.oncomplete(); }, 10);
      return tx;
    }
  };
}
/* 真实生产文件的沙箱：window 即全局；IndexedDB / model / DOM / companion 全部由内存桩替代。 */
function createActiveRuntime(overrides) {
  const o = overrides || {};
  const win = {};
  win.window = win;
  win.self = win;
  const warns = [];
  win.console = { info() {}, warn: (...a) => { warns.push(a.map(String).join(' ')); }, log() {}, error: (...a) => { warns.push('ERR ' + a.map(String).join(' ')); } };
  win.IB = { expose(name, obj) {
    const parts = String(name).split('.');
    let cur = win.IB;
    for (let i = 0; i < parts.length; i++) { cur = cur[parts[i]] = cur[parts[i]] || {}; }
    if (obj) Object.assign(cur, obj);
    return cur;
  } };
  const storage = Object.create(null);
  win.localStorage = {
    getItem: k => (k in storage ? storage[k] : null),
    setItem: (k, v) => { storage[k] = String(v); },
    removeItem: k => { delete storage[k]; }
  };
  const store = Object.create(null), puts = [], modelCalls = [], bubbles = [], toasts = [];
  win.db = makeIdb(store);
  win.dbPut = async (s, d) => {
    if (o.failStore === s) throw new Error('db put failed: ' + s);
    const row = JSON.parse(JSON.stringify(d));
    const arr = (store[s] = store[s] || []);
    const i = arr.findIndex(r => r.id === row.id);
    if (i >= 0) arr[i] = row; else arr.push(row);
    puts.push({ store: s, id: d && d.id });
  };
  win.dbGet = async (s, id) => ((store[s] || []).find(r => r.id === id) || null);
  win.dbGetAll = async s => (store[s] || []).map(r => JSON.parse(JSON.stringify(r)));
  win.dbDelete = async (s, id) => { store[s] = (store[s] || []).filter(r => r.id !== id); };
  win.dbGetByIndex = async (s, index, key) => (store[s] || []).filter(r => r.friendId === key || r.characterId === key);
  win.apiConfigs = [{ id: 'role_a', provider: 'openai', model: 'active-model', apiKey: 'sk-test-key-1234',
    endpoint: 'http://127.0.0.1:1/v1/chat/completions', nickname: '阿黎', systemPrompt: '你是阿黎。' }];
  win.archivedConfigs = [];
  win._ibApiReady = cfg => !!(cfg && cfg.id);
  /* communication.js 的发送互斥集合（active-diary.js 以全局引用它） */
  win._chatSendingFor = new Set();
  win._assistantResponseParts = (content, reasoning) => ({ content: String(content || ''), reasoning: String(reasoning || '') });
  /* 其它域的 tick 在真实页面来自 diary.js / moments.js 等文件；沙箱里给 no-op（本阶段不测它们）。 */
  win._diaryTick = async () => {};
  win._momentsTick = async () => {};
  win._consolidationTick = async () => {};
  win._understandingAndThreadTick = async () => {};
  win._roleLettersTick = async () => {};
  win._roleDmSocialTick = async () => {};
  win.activeFriendId = 'role_a';
  win.currentPage = 'chat';
  win.appendChatBubble = (role, content, sender, reasoning, id) => { bubbles.push({ role: role, content: content, id: id }); };
  win._markUnread = () => {};
  win.renderChatCalendar = () => {};
  win.updateChatStorageInfo = () => {};
  win.toast = m => { toasts.push(String(m)); };
  win._cachedUserName = '用户';
  win.AbortController = AbortController;
  win.fetch = async () => { throw new Error('companion offline'); };
  win.Notification = undefined;
  /* 应用引导桩：active-diary.js 末尾会自行执行 init()/initChatHeader()，
     这些入口属于整页引导（DB 打开、主题、导航…），与本阶段无关，一律 no-op。 */
  ['openDB', '_ibGuardCheck', 'loadOutputSettings', 'migrateLockedPosts', 'loadApiConfigs',
    '_refreshCachedUserName', 'loadPosts', 'loadCategories', 'updateBlogStats', 'loadAboutDisplay',
    '_updateLastActive', '_fabSyncHeight', '_ibGuardInit', '_vmInit', 'initChatHeader'].forEach(name => { win[name] = () => {}; });
  win.openDB = async () => win.db;
  win.migrateLockedPosts = async () => {};
  win.loadApiConfigs = async () => {};
  win.addEventListener = () => {};
  /* 定时器：只让"重试等待"这类短延时真实发生；长延时/周期任务在沙箱里不启动
     （否则测试期间会冒出额外的 scheduler tick）。 */
  win.setTimeout = (fn, ms) => (Number(ms) || 0) <= 1000 ? setTimeout(fn, Number(ms) || 0) : 0;
  win.clearTimeout = () => {};
  win.setInterval = () => 0;
  win.clearInterval = () => {};
  /* direct executor 的模型输出（`_activeProactiveModelCall` 在 runtime 缺席时回落 callApiChat） */
  win.callApiChat = async () => {
    modelCalls.push('active');
    if (o.onModelCall) o.onModelCall(win);
    return o.modelContent || '今天忽然想起你，想知道你今天过得怎么样。';
  };
  const els = Object.create(null);
  win.document = {
    readyState: 'complete',
    visibilityState: 'visible',
    addEventListener() {},
    createElement: () => makeElement(),
    createTextNode: t => ({ text: String(t) }),
    querySelectorAll: () => [],
    querySelector: () => null,
    getElementById(id) { if (!(id in els)) els[id] = makeElement(); return els[id]; }
  };
  vm.createContext(win);
  for (const f of ['assets/js/chat-core.js', 'assets/js/voice-message-core.js',
    'assets/js/active-message-authority.js', 'assets/js/active-diary/active-plans.js', 'assets/js/active-diary.js']) {
    vm.runInContext(read(f), win, { filename: f });
  }
  return { win, store, puts, modelCalls, bubbles, toasts, warns, storage, els,
    rows: () => (store.chatMessages || []).slice(),
    proactiveRows: () => (store.chatMessages || []).filter(r => r && r.source === 'active_message'),
    history: () => (store.active_message_history || []).slice(),
    settings: () => (store.active_message_settings || []).slice() };
}
async function waitFor(fn, timeout) {
  const end = Date.now() + (timeout || 3000);
  for (;;) {
    if (fn()) return true;
    if (Date.now() > end) return false;
    await new Promise(r => setTimeout(r, 10));
  }
}
const MODEL_TEXT = '今天忽然想起你，想知道你今天过得怎么样。';
function dueSetting(overrides) {
  const now = Date.now();
  return Object.assign({ id: 'set_1', user_id: 'user_1', character_id: 'role_a', enabled: true,
    frequency: 'interval', schedule: { interval_value: 1, interval_unit: 'hours', timezone: 'local' },
    message_type: 'greeting', custom_instruction: '', background_enabled: false, adaptive_enabled: false,
    next_run_at: now - 1000, created_at: now - 100000, updated_at: now - 100000 }, overrides || {});
}

console.log('== P25-3C · Active Message Capability Adapter + Production Convergence ==');

/* ══════════ OA · Orchestration Active Message Adapter ══════════ */
const reg = R.createCapabilityRegistry();
const registered = D.registerActiveMessageCapabilities(reg);
const descriptor = reg.get('active_message.send');

/* OA1 capability registered */
check('OA1.capabilityRegistered', registered.ok === true && reg.has('active_message.send') && reg.size() === 1, registered);

/* OA2 descriptor valid（遵守 P25-3A frozen descriptor） */
check('OA2.descriptorShape',
  !!descriptor && descriptor.domain === 'active_message' && descriptor.kind === 'action'
  && descriptor.sideEffect === 'local' && descriptor.authorityType === 'domain'
  && descriptor.binding === 'active_message.send' && descriptor.availability === 'available'
  && descriptor.description.length > 0 && Object.isFrozen(descriptor) && Object.isFrozen(descriptor.notes), descriptor);

/* OA4/5/9 静态边界：adapter 自身不发送、不写库、不碰 delivery */
const adapterHits = needles => needles.filter(n => ADAPTER_SRC.indexOf(n) >= 0);
check('OA4.cannotSendDirectly',
  adapterHits(['dbPut', 'dbGet', 'indexedDB', 'chatMessages', 'active_message_history', 'sendChatMessage', 'fetch(', 'localStorage']).length === 0,
  adapterHits(['dbPut', 'dbGet', 'indexedDB', 'chatMessages', 'active_message_history', 'sendChatMessage', 'fetch(', 'localStorage']));
check('OA5.cannotCallModelOrDeliveryDirectly',
  adapterHits(['callApiChat', 'runtime.execute', 'resolveModel', 'Notification', 'messages', 'systemPrompt', 'tts']).length === 0,
  adapterHits(['callApiChat', 'runtime.execute', 'resolveModel', 'Notification', 'messages', 'systemPrompt', 'tts']));
check('OA12b.noMemoryNoMiddleBrainNoCot',
  adapterHits(['memories', 'memoryCandidate', 'updateMemDashboard', '_mbSideEffectGate', '_execMemOps', 'middleBrain']).length === 0
  && !REASONING.test(ADAPTER_SRC) && !REASONING.test(AUTHORITY_SRC)
  && AUTHORITY_SRC.indexOf('memories') < 0 && AUTHORITY_SRC.indexOf('_mbSideEffectGate') < 0,
  adapterHits(['memories', 'memoryCandidate', 'updateMemDashboard', '_mbSideEffectGate', '_execMemOps', 'middleBrain']));

function makeAdapter(overrides) {
  const o = overrides || {};
  const spies = { authority: 0, domain: [] };
  const authority = {
    buildActiveMessageCandidate: A.buildActiveMessageCandidate,
    runActiveMessageSend: (candidate, facts, executor) => { spies.authority++; return A.runActiveMessageSend(candidate, facts, executor); },
    verifyActiveMessageSend: A.verifyActiveMessageSend
  };
  const rows = Object.create(null);
  const domain = {
    sendMessage: async envelope => {
      spies.domain.push(envelope);
      if (o.failDomain) return { ok: false, error: 'domain-send-failed' };
      const message = { id: 'active_msg_' + spies.domain.length, friendId: envelope.actorId, source: 'active_message' };
      rows[message.id] = message;
      return { ok: true, message: message };
    }
  };
  const adapter = D.createActiveMessageOrchestrationAdapter({ authority: authority, domain: domain, reader: async id => rows[id] || null });
  return { adapter: adapter, spies: spies, rows: rows, authority: authority, domain: domain };
}
const factsAllow = { actorKnown: true, targetKnown: true, cancelled: false, enabled: true,
  quietHours: false, cooldown: false, duplicate: false };
function planOf(facts, extraInput) {
  return { planId: 'plan_active', actorId: 'role_a', steps: [{ stepId: 's1', capabilityId: 'active_message.send', reasonCode: 'schedule',
    input: Object.assign({ actorId: 'role_a', targetId: 'user_1', source: 'schedule', trigger: 'schedule',
      triggerRef: 'active_run_1', facts: facts }, extraInput || {}) }] };
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
  /* OA3 authority route */
  const okCtx = makeAdapter();
  const okRun = await runPlan(okCtx, planOf(factsAllow));
  check('OA3.routesToAuthority',
    okCtx.spies.authority === 1 && okRun.steps[0].status === 'completed' && okRun.steps[0].ok === true
    && okRun.steps[0].output.messageId === 'active_msg_1', okRun.steps[0]);

  /* OA6 deny stops execution（Plan 合法 ≠ 允许发送） */
  const denyCtx = makeAdapter();
  const denyPlan = planOf(Object.assign({}, factsAllow, { quietHours: true }));
  const denyValidated = C.validateAgentPlan(denyPlan, reg);
  const denyRun = await runPlan(denyCtx, denyPlan);
  check('OA6.denyStopsExecution',
    denyValidated.ok === true && denyRun.steps[0].status === 'denied'
    && denyRun.steps[0].errorCode === 'quiet-hours' && denyCtx.spies.domain.length === 0
    && Object.keys(denyCtx.adapter.captured).length === 0, denyRun.steps[0]);

  /* OA7 allow executes once（同一步第二次执行被拒） */
  const okExecutor = okCtx.adapter.resolveExecutor(descriptor);
  const twice = await okExecutor({ stepId: 's1', input: {}, idempotencyKey: 'k' });
  check('OA7.allowExecutesOnce',
    okCtx.spies.domain.length === 1 && okCtx.adapter.executorCalls.s1 === 2
    && twice.ok === false && twice.errorCode === 'executor-called-twice', twice);

  /* OA8 verify success / OA9 verify missing message */
  const verified = await okCtx.adapter.verify(okRun.steps[0]);
  const missing = await okCtx.adapter.verify({ status: 'completed', ok: true, output: { messageId: 'active_msg_ghost', actorId: 'role_a' } });
  const notCompleted = await okCtx.adapter.verify({ status: 'denied', ok: false, output: { messageId: 'active_msg_1', actorId: 'role_a' } });
  check('OA8.verifyConfirmsCanonicalMessage',
    verified.verified === true && verified.messageId === 'active_msg_1', verified);
  check('OA9.verifyMissingMessageFails',
    missing.verified === false && missing.errorCode === 'canonical-message-missing'
    && notCompleted.errorCode === 'not-completed' && okCtx.spies.domain.length === 1, { missing: missing, notCompleted: notCompleted });

  /* OA10 cancellation before write */
  const cancelCtx = makeAdapter();
  const cancelRun = await runPlan(cancelCtx, planOf(factsAllow), { deps: { isCancelled: () => true } });
  check('OA10.cancellationBeforeSend',
    cancelRun.steps[0].status === 'denied' && cancelRun.steps[0].errorCode === 'cancelled'
    && cancelCtx.spies.authority === 0 && cancelCtx.spies.domain.length === 0, cancelRun.steps[0]);

  /* OA11 idempotency passthrough（domain 持有 message id，本层只透传） */
  const idemStep = planOf(factsAllow).steps[0];
  const derived = okCtx.adapter.idempotencyKeyFor(descriptor, idemStep);
  const explicit = okCtx.adapter.idempotencyKeyFor(descriptor, { stepId: 's2', input: { idempotencyKey: 'domain-owned-key' } });
  const idemCtx = makeAdapter();
  const idemRun = await runPlan(idemCtx, planOf(factsAllow, { idempotencyKey: 'domain-owned-key' }));
  check('OA11.idempotencyKeyPassthrough',
    derived === candidateIdFor({ actorId: 'role_a', targetId: 'user_1', source: 'schedule', trigger: 'schedule', triggerRef: 'active_run_1' })
    && explicit === 'domain-owned-key' && idemRun.steps[0].idempotencyKey === 'domain-owned-key'
    && idemCtx.spies.domain[0].idempotencyKey === 'domain-owned-key'
    && idemCtx.spies.domain[0].candidateId === derived, { derived: derived, envelope: idemCtx.spies.domain[0] });

  /* OA12 result normalization + failed executor */
  const failCtx = makeAdapter({ failDomain: true });
  const failRun = await runPlan(failCtx, planOf(factsAllow));
  const secretPlan = planOf(factsAllow, { apiKey: 'sk-abcdefgh1234' });
  const secretValidated = C.validateAgentPlan(secretPlan, reg);
  check('OA12.resultNormalization',
    failRun.steps[0].status === 'failed' && failRun.steps[0].ok === false
    && failRun.steps[0].errorCode === 'domain-send-failed'
    && failRun.reflection.outcome === 'failed'
    && okRun.steps[0].output.actorId === 'role_a' && okRun.steps[0].output.targetId === 'user_1'
    && !REASONING.test(JSON.stringify(okRun)) && secretValidated.ok === false
    && secretValidated.errors.some(e => e.indexOf('secret') >= 0)
    && D.describeActiveMessageAvailability({}) === 'available'
    && D.describeActiveMessageAvailability({ writerAvailable: false }) === 'unavailable',
    { fail: failRun.steps[0], secret: secretValidated.errors });

  await runProductionChecks();
})().catch(e => { console.error(e && e.stack || e); process.exitCode = 1; });

/* ══════════ PC · Production Convergence（真实 active-diary.js 生产链）══════════ */
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ACTIVE_TICK_BODY = ACTIVE_RAW.slice(ACTIVE_RAW.indexOf('async function _activeTick(){'), ACTIVE_RAW.indexOf('function _activeNotify(cfg,content){'));
const STORE_MSG_BODY = ACTIVE_RAW.slice(ACTIVE_RAW.indexOf('async function _activeStoreMessage('), ACTIVE_RAW.indexOf('async function _activeFinishRun('));
const PLAN_STORE_BODY = PLANS_RAW.slice(PLANS_RAW.indexOf('async function _activeStoreAiPlanMessage('), PLANS_RAW.indexOf('/* 执行 AI 计划状态机'));

function withAuthoritySpy(rt) {
  const decisions = [];
  const real = rt.win.IBActiveMessageAuthority;
  rt.win.IBActiveMessageAuthority = Object.assign({}, real, {
    runActiveMessageSend: async (c, f, e) => {
      const r = await real.runActiveMessageSend(c, f, e);
      decisions.push(r.decision + ':' + r.reason);
      return r;
    }
  });
  return decisions;
}
async function runTickWithSend(rt) {
  await rt.win._activeTick();
  await waitFor(() => rt.proactiveRows().length > 0 || rt.history().length > 0);
}
async function runProductionChecks() {
  /* ── PC1 real scheduler uses the authority ─────────────────────────── */
  const rt1 = createActiveRuntime();
  const decisions1 = withAuthoritySpy(rt1);
  rt1.store.active_message_settings = [dueSetting()];
  await runTickWithSend(rt1);
  const row1 = rt1.rows()[0] || {};
  check('PC1.schedulerUsesAuthority',
    decisions1[0] === 'allow:allowed' && rt1.rows().length === 1
    && row1.source === 'active_message' && row1.friendId === 'role_a'
    && rt1.modelCalls.filter(k => k === 'active').length === 1,
    { decisions: decisions1, rows: rt1.rows().length, calls: rt1.modelCalls, warns: rt1.warns.slice(0, 2) });

  /* ── PC2 old direct send removed（静态 + fail closed 动态）─────────── */
  const rt2 = createActiveRuntime();
  rt2.store.active_message_settings = [dueSetting()];
  rt2.win.IBActiveMessageAuthority = undefined;      /* 权威缺席 */
  await runTickWithSend(rt2);
  const hist2 = rt2.history()[0] || {};
  check('PC2.oldDirectSendRemoved',
    countOcc(ACTIVE, "dbPut('chatMessages'") === 1 && countOcc(PLANS, "dbPut('chatMessages'") === 0
    && STORE_MSG_BODY.indexOf("dbPut('chatMessages'") < 0 && PLAN_STORE_BODY.indexOf("dbPut('chatMessages'") < 0
    && STORE_MSG_BODY.indexOf('_activeSendAuthorized(') >= 0
    && PLAN_STORE_BODY.indexOf('_activePlanSendAuthorized(') >= 0
    && rt2.rows().length === 0 && hist2.status === 'skipped',
    { activeWrites: countOcc(ACTIVE, "dbPut('chatMessages'"), planWrites: countOcc(PLANS, "dbPut('chatMessages'"), rows: rt2.rows().length, hist: hist2.status });

  /* ── PC3 ALLOW sends exactly one canonical message ─────────────────── */
  const rt3 = createActiveRuntime();
  withAuthoritySpy(rt3);
  rt3.store.active_message_settings = [dueSetting()];
  await runTickWithSend(rt3);
  const row3 = rt3.rows()[0] || {}, hist3 = rt3.history()[0] || {};
  const puts3 = rt3.puts.filter(p => p.store === 'chatMessages');
  const recent3 = await rt3.win._activeRecentProactiveMessages('role_a');
  check('PC3.allowSendsExactlyOne',
    rt3.rows().length === 1 && puts3.length === 1 && row3.id.indexOf('active_msg_') === 0
    && row3.role === 'assistant' && row3.senderName === '阿黎' && row3.content === MODEL_TEXT
    && row3.metadata && row3.metadata.model_id === 'active-model'
    && hist3.status === 'sent' && hist3.message_id === row3.id && hist3.source !== 'ai_planned'
    && rt3.bubbles.length === 1 && rt3.bubbles[0].id === row3.id
    && recent3.length === 1 && recent3[0].content === MODEL_TEXT,
    { rows: rt3.rows().length, puts: puts3.length, hist: hist3.status, bubbles: rt3.bubbles.length, warns: rt3.warns.slice(0, 2) });

  /* ── PC4 DENY sends zero（写入时刻的免打扰复核）─────────────────────── */
  const rt4 = createActiveRuntime({
    onModelCall: win => { win.__storeRef.apiSettings = [{ id: 'bgAi', enabled: true, sleepStart: '00:00', sleepEnd: '23:59' }]; }
  });
  rt4.win.__storeRef = rt4.store;
  const decisions4 = withAuthoritySpy(rt4);
  rt4.store.active_message_settings = [dueSetting()];
  await runTickWithSend(rt4);
  const hist4 = rt4.history()[0] || {};
  check('PC4.denySendsZero',
    decisions4.indexOf('deny:quiet-hours') >= 0 && rt4.rows().length === 0
    && rt4.puts.filter(p => p.store === 'chatMessages').length === 0
    && hist4.status === 'skipped' && rt4.bubbles.length === 0,
    { decisions: decisions4, rows: rt4.rows().length, hist: hist4.status, warns: rt4.warns.slice(0, 2) });

  /* ── PC5 cooldown preserved（调度期顺延 + 写入时刻复核）──────────────── */
  /* (a) 既有"12 小时内刚互动过"顺延：在**生成之前**就跳过（不浪费模型调用） */
  const rt5a = createActiveRuntime();
  const decisions5a = withAuthoritySpy(rt5a);
  rt5a.store.active_message_settings = [dueSetting({ adaptive_enabled: true })];
  rt5a.store.chatMessages = [{ id: 'u_recent', role: 'user', content: '刚说了话', friendId: 'role_a', timestamp: Date.now() - 60 * 60 * 1000 }];
  await runTickWithSend(rt5a);
  const hist5a = rt5a.history()[0] || {};
  /* (b) 生成期间用户发言 → 写入时刻 facts 复核 ⇒ DENY cooldown */
  const rt5b = createActiveRuntime({
    onModelCall: win => { win.__storeRef.chatMessages.push({ id: 'u_mid', role: 'user', content: '生成期间插话', friendId: 'role_a', timestamp: Date.now() - 60000 }); }
  });
  rt5b.win.__storeRef = rt5b.store;
  rt5b.store.chatMessages = [];
  const decisions5b = withAuthoritySpy(rt5b);
  rt5b.store.active_message_settings = [dueSetting({ adaptive_enabled: true })];
  await runTickWithSend(rt5b);
  check('PC5.cooldownPreserved',
    rt5a.proactiveRows().length === 0 && hist5a.status === 'skipped' && decisions5a.length === 0
    && rt5a.modelCalls.filter(k => k === 'active').length === 0
    && rt5b.proactiveRows().length === 0 && decisions5b.indexOf('deny:cooldown') >= 0
    && ACTIVE.indexOf('async function _activeAdaptiveReason(setting){') >= 0,
    { aRows: rt5a.proactiveRows().length, aHist: hist5a.status, aDecisions: decisions5a, bDecisions: decisions5b, warns: rt5b.warns.slice(0, 2) });

  /* ── PC6 duplicate preserved（既有相似度规则仍是唯一实现）───────────── */
  const rt6 = createActiveRuntime();
  rt6.store.active_message_settings = [dueSetting()];
  const dupSend = await rt6.win._activeSendAuthorized({
    cfg: rt6.win.apiConfigs[0],
    msg: { id: 'active_msg_dup', role: 'assistant', content: MODEL_TEXT, friendId: 'role_a', source: 'active_message', senderName: '阿黎' },
    targetId: 'user_1', source: 'schedule', trigger: 'schedule', triggerRef: 'active_run_dup',
    enabled: true, quietHours: false, cooldown: false,
    recentProactive: [{ content: MODEL_TEXT, message_id: 'active_msg_prev' }]
  });
  const freshSend = await rt6.win._activeSendAuthorized({
    cfg: rt6.win.apiConfigs[0],
    msg: { id: 'active_msg_fresh', role: 'assistant', content: '换一个完全不同的开头和话题，说说我今天想到的一件事。', friendId: 'role_a', source: 'active_message', senderName: '阿黎' },
    targetId: 'user_1', source: 'schedule', trigger: 'schedule', triggerRef: 'active_run_fresh',
    enabled: true, quietHours: false, cooldown: false,
    recentProactive: [{ content: MODEL_TEXT, message_id: 'active_msg_prev' }]
  });
  check('PC6.duplicatePreserved',
    dupSend.ok === false && dupSend.decision === 'deny' && dupSend.reason === 'duplicate'
    && freshSend.ok === true && rt6.rows().length === 1 && rt6.rows()[0].id === 'active_msg_fresh'
    && ACTIVE.indexOf('const ACTIVE_PROACTIVE_SIMILARITY=0.82;') >= 0
    && ACTIVE.indexOf('function _activeValidateProactiveReply(content,recentProactive){') >= 0,
    { dup: dupSend, fresh: freshSend.ok, rows: rt6.rows().map(r => r.id) });

  /* ── PC7 quiet hours preserved（BG-AI 总开关 + 休眠时段仍是唯一规则）── */
  const rt7 = createActiveRuntime();
  rt7.store.apiSettings = [{ id: 'bgAi', enabled: true, sleepStart: '00:00', sleepEnd: '23:59' }];
  const decisions7 = withAuthoritySpy(rt7);
  rt7.store.active_message_settings = [dueSetting()];
  const gate7 = await rt7.win._bgAiGate();
  await runTickWithSend(rt7);
  check('PC7.quietHoursPreserved',
    gate7 === 'hibernate' && rt7.rows().length === 0 && decisions7.length === 0
    && rt7.modelCalls.filter(k => k === 'active').length === 0
    && ACTIVE.indexOf('function _bgInSleepWindow(cfg){') >= 0 && ACTIVE.indexOf('async function _bgAiGate(){') >= 0,
    { gate: gate7, rows: rt7.rows().length, decisions: decisions7 });

  /* ── PC8 user preference preserved（总开关 / 计划开关 / 手动覆盖语义）── */
  const rt8a = createActiveRuntime();
  withAuthoritySpy(rt8a);
  rt8a.store.active_message_settings = [dueSetting({ enabled: false })];
  await runTickWithSend(rt8a);
  const rt8b = createActiveRuntime();
  withAuthoritySpy(rt8b);
  rt8b.store.apiSettings = [{ id: 'bgAi', enabled: false, sleepStart: '', sleepEnd: '' }];
  rt8b.store.active_message_settings = [dueSetting()];
  await runTickWithSend(rt8b);
  const rt8c = createActiveRuntime();
  rt8c.store.active_message_settings = [dueSetting({ enabled: false })];
  const manualSend = await rt8c.win._activeSendAuthorized({
    cfg: rt8c.win.apiConfigs[0],
    msg: { id: 'active_msg_manual', role: 'assistant', content: '手动点的那一条。', friendId: 'role_a', source: 'active_message', senderName: '阿黎' },
    targetId: 'user_1', source: 'user', trigger: 'manual', triggerRef: 'active_run_manual',
    manual: true, enabled: false, quietHours: true, cooldown: true,
    recentProactive: [{ content: '手动点的那一条。', message_id: 'active_msg_prev' }]
  });
  check('PC8.userPreferencePreserved',
    rt8a.rows().length === 0 && rt8b.rows().length === 0
    && manualSend.ok === true && manualSend.decision === 'allow' && rt8c.rows().length === 1
    && rt8c.rows()[0].id === 'active_msg_manual'
    && ACTIVE.indexOf('if(!s.enabled||!s.next_run_at||Number(s.next_run_at)>now+500)continue;') >= 0,
    { a: rt8a.rows().length, b: rt8b.rows().length, manual: manualSend.decision, c: rt8c.rows().length });

  /* ── PC9 existing UI unaffected ───────────────────────────────────── */
  const rt9 = createActiveRuntime();
  withAuthoritySpy(rt9);
  rt9.store.active_message_settings = [dueSetting()];
  await runTickWithSend(rt9);
  let uiError = '';
  try {
    await rt9.win.loadActiveMessagePage();
    await rt9.win._activeRenderHistory();
    await rt9.win._activeRenderSettings();
  } catch (e) { uiError = String(e && e.message || e); }
  const historyList = rt9.win.document.getElementById('active-history-list');
  const exported = ['_activeStoreMessage', '_activeExecuteRun', '_activeNotify', '_activeRequestNotification',
    'initActiveMessages', '_activeTick', '_activeRenderSettings', '_activeRenderHistory', '_activeClearHistory',
    '_activeRunNow', '_activeSaveSetting', '_activePullCompanionEvents'];
  const missing = exported.filter(k => typeof rt9.win[k] !== 'function' || typeof rt9.win.IB.active[k] !== 'function');
  const planExported = ['_activeExecuteAiPlan', '_activeStoreAiPlanMessage', '_activeTickAiPlans', '_activeIsInDnd',
    '_activeAiPrefs', '_activePlanLatestContext', '_activeRenderAiPlans'];
  const missingPlans = planExported.filter(k => typeof rt9.win.IB.active.plans[k] !== 'function');
  check('PC9.existingUiUnaffected',
    uiError === '' && historyList.children.length > 0 && missing.length === 0 && missingPlans.length === 0
    && typeof rt9.win._activeSendAuthorized === 'function' && typeof rt9.win.IB.active.sendAuthorized === 'function'
    && typeof rt9.win.IB.active.writeCanonicalMessage === 'function'
    && rt9.win.IB.active.writeCanonicalMessage === rt9.win._activeWriteCanonical,
    { uiError: uiError, historyRows: historyList.children.length, missing: missing, missingPlans: missingPlans });

  /* ── PC10 existing conversation unaffected（消息形状 + 读口 + 投递镜像）── */
  const rt10 = createActiveRuntime();
  withAuthoritySpy(rt10);
  rt10.store.active_message_settings = [dueSetting()];
  await runTickWithSend(rt10);
  const row10 = rt10.rows()[0] || {};
  const recent10 = await rt10.win._activeRecentProactiveMessages('role_a');
  /* companion 事件 = 已授权发送的**投递镜像**：走同一条 canonical writer（effects:false），
     不重复裁决发送权限（authority 计数不变），也不重复 UI 副作用。 */
  const authorityBefore = rt10.win.IBActiveMessageAuthority.__spyCalls || 0;
  rt10.win.fetch = async () => ({
    ok: true, status: 200,
    text: async () => JSON.stringify({ events: [{ run_id: 'active_run_mirror', setting_id: 'set_1', user_id: 'user_1',
      character_id: 'role_a', character_name: '阿黎', scheduled_for: Date.now(), sent_at: Date.now(), status: 'sent',
      content: 'companion 发来的那条。', message_id: 'active_msg_mirror', provider: 'openai', model: 'active-model' }] })
  });
  rt10.win._activeCompanionOnline = true;
  await rt10.win._activePullCompanionEvents();
  const mirrorRow = rt10.rows().find(r => r.id === 'active_msg_mirror') || {};
  check('PC10.existingConversationUnaffected',
    rt10.rows().length === 2 && recent10.length === 1 && recent10[0].message_id === row10.id
    && row10.metadata.config_id === 'role_a' && row10.activeSettingId === 'set_1'
    && row10.scheduledFor === rt10.history()[0].scheduled_for
    && mirrorRow.source === 'active_message' && mirrorRow.friendId === 'role_a'
    && (rt10.win.IBActiveMessageAuthority.__spyCalls || 0) === authorityBefore
    && rt10.store.active_message_history.some(h => h.id === 'active_run_mirror' && h.source === 'companion'),
    { rows: rt10.rows().map(r => r.id), recent: recent10.length, mirror: mirrorRow.id, warns: rt10.warns.slice(0, 3) });

  console.log('\n' + (failed
    ? 'P25-3C Active Message adapter / production convergence FAILED: ' + failed + ' failed / ' + passed + ' passed'
    : 'P25-3C Active Message adapter / production convergence passed \u2714 (' + passed + ' checks)'));
  process.exitCode = failed ? 1 : 0;
}
