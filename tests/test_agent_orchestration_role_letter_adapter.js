'use strict';

/* Internal Beyond · P25-3D · Role Letter Capability Adapter + Production Convergence
   （OA1–OA12 + PC1–PC8；纯 Node、零浏览器、零网络）

   OA 段：把**真实**的 Role Letter Authority 接到编排层，用假 domain writer 证明
          「Plan != Permission / DENY 零执行 / verifier 只验证」等编排边界。
   PC 段：在 vm 沙箱里加载**真实生产文件**（chat-core / voice-message-core /
          role-letter-authority / role-letters.js），驱动真实 _roleLettersTick
          （cadence 写信 + 读信后回信）与真实 canonical writer，证明生产链也经同一条
          authority，且既有行为（cadence / 对偶冷却 / 已回已拒 / 私有记忆命名空间 /
          UI / 存储形状 / relationship）未被改写。

   本套件不触网、不写真实 IndexedDB、不产生 OS 通知。 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.resolve(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const stripComments = src => String(src).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const R = require(path.join(ROOT, 'assets/js/agent-capability-registry.js'));
const C = require(path.join(ROOT, 'assets/js/agent-orchestration-core.js'));
const D = require(path.join(ROOT, 'assets/js/agent-orchestration-role-letter-adapter.js'));
const A = require(path.join(ROOT, 'assets/js/role-letter-authority.js'));

const ADAPTER_SRC = stripComments(read('assets/js/agent-orchestration-role-letter-adapter.js'));
const AUTHORITY_SRC = stripComments(read('assets/js/role-letter-authority.js'));
const RL_RAW = read('assets/js/role-letters.js');
const RL = stripComments(RL_RAW);
const CORE_SRC = read('assets/js/core.js');

let passed = 0, failed = 0;
const failures = [];
function check(name, cond, extra) {
  if (cond) { passed++; console.log('  \u2714 ' + name); }
  else { failed++; failures.push(name); console.log('  \u2716 ' + name + (extra === undefined ? '' : '  -> ' + JSON.stringify(extra).slice(0, 320))); }
}
const REASONING = /thinking|chain_of_thought|chainofthought|scratchpad|internal_reasoning|rationale|\bcot\b/i;
const countOcc = (src, needle) => String(src).split(needle).length - 1;
const candidateIdFor = input => A.buildRoleLetterCandidate(input).candidate.candidateId;

function makeElement(id) {
  const classes = new Set();
  return { id: id || '', value: '', checked: false, textContent: '', innerHTML: '', className: '', style: {}, title: '', children: [],
    options: [], outerHTML: '<div></div>', hidden: false, offsetWidth: 10, offsetHeight: 10,
    classList: { add(c) { classes.add(c); }, remove(c) { classes.delete(c); }, toggle(c, on) { if (on === undefined) { classes.has(c) ? classes.delete(c) : classes.add(c); } else if (on) classes.add(c); else classes.delete(c); }, contains(c) { return classes.has(c); } },
    append() { for (let i = 0; i < arguments.length; i++) this.children.push(arguments[i]); },
    appendChild(node) { this.children.push(node); },
    addEventListener() {}, remove() {}, closest() { return null; },
    getBoundingClientRect() { return { left: 0, top: 0, width: 100, height: 100 }; },
    setPointerCapture() {}, releasePointerCapture() {},
    querySelector() { return null; }, querySelectorAll() { return []; } };
}
/* 真实生产文件的沙箱：window 即全局；IndexedDB / model / DOM / moments 全部由内存桩替代。 */
function createRoleLetterRuntime(overrides) {
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
  const store = Object.create(null), puts = [], modelCalls = [], toasts = [];
  win.db = {};
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
  const idxField = { byTo: 'toRoleId', byFrom: 'fromRoleId', byCharacter: 'characterId', byFriend: 'friendId' };
  win.dbGetByIndex = async (s, idx, val) => (store[s] || []).filter(r => String(r[idxField[idx] || idx]) === String(val));
  win.apiConfigs = [
    { id: 'a', nickname: '阿澈', model: 'm-a', apiKey: 'sk-a', endpoint: 'http://127.0.0.1:1', systemPrompt: '你是阿澈。', relationship: '好友' },
    { id: 'b', nickname: '小昕', model: 'm-b', apiKey: 'sk-b', endpoint: 'http://127.0.0.1:1', systemPrompt: '你是小昕。', relationship: '挚友' },
    { id: 'c', nickname: '路人丙', model: 'm-c', apiKey: 'sk-c', endpoint: 'http://127.0.0.1:1', systemPrompt: '你是路人丙。', relationship: '认识' }
  ];
  win.archivedConfigs = [];
  win._ibApiReady = cfg => !!(cfg && cfg.id);
  win._momentsCfg = id => win.apiConfigs.find(c => c.id === id) || null;
  win._momentsPairAffinity = () => 55;
  win._momentsAvatar = () => '';
  win.getRoleMoments = async () => [];
  win._activeTextSimilarity = () => 0;
  win._activeParsePlanJson = t => { try { return JSON.parse(String(t).trim()); } catch (e) { return null; } };
  win._momentsContext = async c => ({ user: { name: '用户' }, character: c, recentMessages: [],
    memories: [{ title: '记忆一', content: '上周一起去了海边' }], recentProactiveMessages: [], chatSummary: '', recentMoments: [], otherRoleMoments: [] });
  win.toast = m => { toasts.push(String(m)); };
  win.esc = s => String(s == null ? '' : s);
  win.updateMemDashboard = () => {};
  /* 假 LLM：按任务标记返回确定性 JSON；onModelCall 用于"生成期间状态变化"的场景。 */
  win.callApiChat = async (cfg, messages) => {
    const msg = (messages || []).map(m => m.content).join('\n');
    if (msg.indexOf('决定此刻是否给某位朋友写一封信') !== -1) {
      modelCalls.push('init');
      if (o.onModelCall) o.onModelCall(win);
      return '{"write":true,"to":1,"content":"最近想起那天在海边说的话，想写封信给你，聊聊那段风。","reason":""}';
    }
    if (msg.indexOf('决定是否回信') !== -1) {
      modelCalls.push('reply');
      if (o.onModelCall) o.onModelCall(win);
      return '{"reply":true,"content":"读了信，想起那些风里的黄昏，回你一封信。","reason":""}';
    }
    return '{}';
  };
  const els = Object.create(null);
  win.document = {
    readyState: 'complete', visibilityState: 'visible',
    addEventListener() {},
    createElement: tag => makeElement(tag),
    createTextNode: t => ({ text: String(t) }),
    querySelectorAll: () => [], querySelector: () => null,
    getElementById(id) { if (!(id in els)) els[id] = makeElement(id); return els[id]; }
  };
  vm.createContext(win);
  for (const f of ['assets/js/chat-core.js', 'assets/js/voice-message-core.js',
    'assets/js/role-letter-authority.js', 'assets/js/role-letters.js']) {
    vm.runInContext(read(f), win, { filename: f });
  }
  return { win, store, puts, modelCalls, toasts, warns, storage, els,
    letters: () => (store.roleLetters || []).slice(),
    lettersOfKind: kind => (store.roleLetters || []).filter(l => l.kind === kind),
    mems: () => (store.roleLetterMemories || []).slice(),
    sharedMemories: () => (store.memories || []).slice() };
}
function seedInit(rt, roleIds) {
  const state = {};
  (roleIds || ['a', 'b']).forEach(id => { state[id] = { nextInitAt: Date.now() - 1000 }; });
  rt.storage.ib_role_letters_state_v1 = JSON.stringify(state);
}
function withAuthoritySpy(rt) {
  const calls = [];
  const real = rt.win.IBRoleLetterAuthority;
  rt.win.IBRoleLetterAuthority = Object.assign({}, real, {
    runRoleLetterWrite: async (c, f, e) => {
      calls.push({ candidate: Object.assign({}, c), facts: Object.assign({}, f) });
      if (rt.__denyAll) return { ok: false, decision: 'deny', reason: 'cooldown', executed: false,
        actorId: c.actorId, recipientId: c.recipientId, letter: null, error: '' };
      return real.runRoleLetterWrite(c, f, e);
    }
  });
  return calls;
}

console.log('== P25-3D · Role Letter Capability Adapter + Production Convergence ==');

/* ══════════ OA · Orchestration Role Letter Adapter ══════════ */
const reg = R.createCapabilityRegistry();
const registered = D.registerRoleLetterCapabilities(reg);
const descriptor = reg.get('role_letter.write');

check('OA1.capabilityRegistered', registered.ok === true && reg.has('role_letter.write') && reg.size() === 1, registered);
check('OA2.descriptorShape',
  !!descriptor && descriptor.domain === 'role_letter' && descriptor.kind === 'write'
  && descriptor.sideEffect === 'local' && descriptor.authorityType === 'domain'
  && descriptor.binding === 'role_letter.write' && descriptor.availability === 'available'
  && descriptor.description.length > 0 && Object.isFrozen(descriptor) && Object.isFrozen(descriptor.notes), descriptor);

const adapterHits = needles => needles.filter(n => ADAPTER_SRC.indexOf(n) >= 0);
check('OA4.cannotWriteDatabaseDirectly',
  adapterHits(['dbPut', 'dbGet', 'indexedDB', 'roleLetters', 'roleLetterMemories', 'localStorage', '_rlStoreLetter']).length === 0,
  adapterHits(['dbPut', 'dbGet', 'indexedDB', 'roleLetters', 'roleLetterMemories', 'localStorage', '_rlStoreLetter']));
check('OA5.cannotCallModelOrWriterDirectly',
  adapterHits(['callApiChat', 'fetch(', 'runtime.execute', 'resolveModel', '_rlWriteCanonical', 'Notification', 'messages', 'systemPrompt']).length === 0,
  adapterHits(['callApiChat', 'fetch(', 'runtime.execute', 'resolveModel', '_rlWriteCanonical', 'Notification', 'messages', 'systemPrompt']));
check('OA12b.noMemoryNoMiddleBrainNoCot',
  adapterHits(['memories', 'memoryCandidate', 'updateMemDashboard', '_mbSideEffectGate', '_execMemOps', 'middleBrain']).length === 0
  && !REASONING.test(ADAPTER_SRC) && !REASONING.test(AUTHORITY_SRC)
  && AUTHORITY_SRC.indexOf('memories') < 0 && AUTHORITY_SRC.indexOf('_mbSideEffectGate') < 0,
  adapterHits(['memories', 'memoryCandidate', 'updateMemDashboard', '_mbSideEffectGate', '_execMemOps', 'middleBrain']));

function makeAdapter(overrides) {
  const o = overrides || {};
  const spies = { authority: 0, domain: [] };
  const authority = {
    buildRoleLetterCandidate: A.buildRoleLetterCandidate,
    runRoleLetterWrite: (candidate, facts, executor) => { spies.authority++; return A.runRoleLetterWrite(candidate, facts, executor); },
    verifyRoleLetterWrite: A.verifyRoleLetterWrite
  };
  const rows = Object.create(null);
  const domain = {
    writeLetter: async envelope => {
      spies.domain.push(envelope);
      if (o.failDomain) return { ok: false, error: 'domain-write-failed' };
      const letter = { id: 'rletter_' + spies.domain.length, fromRoleId: envelope.actorId,
        toRoleId: envelope.recipientId, kind: envelope.letterKind, content: envelope.content || '信' };
      rows[letter.id] = letter;
      return { ok: true, letter: letter };
    }
  };
  const adapter = D.createRoleLetterOrchestrationAdapter({ authority: authority, domain: domain, reader: async id => rows[id] || null });
  return { adapter: adapter, spies: spies, rows: rows, authority: authority, domain: domain };
}
const factsAllow = { actorKnown: true, recipientKnown: true, cancelled: false, enabled: true, cooldown: false, duplicate: false };
function planOf(facts, extraInput) {
  return { planId: 'plan_letter', actorId: 'role_a', steps: [{ stepId: 's1', capabilityId: 'role_letter.write', reasonCode: 'cadence',
    input: Object.assign({ actorId: 'role_a', recipientId: 'role_b', source: 'schedule', letterKind: 'init',
      trigger: 'init', triggerRef: 'cadence_role_a', content: '想跟你聊聊海边的那天。', facts: facts }, extraInput || {}) }] };
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
  /* OA3 authority route（Plan 合法 ≠ 允许写信） */
  const okCtx = makeAdapter();
  const okRun = await runPlan(okCtx, planOf(factsAllow));
  check('OA3.routesToAuthority',
    okCtx.spies.authority === 1 && okRun.steps[0].status === 'completed'
    && okRun.steps[0].output.letterId === 'rletter_1'
    && okRun.steps[0].output.actorId === 'role_a' && okRun.steps[0].output.recipientId === 'role_b', okRun.steps[0]);

  /* OA6 deny blocks */
  const denyCtx = makeAdapter();
  const denyPlan = planOf(Object.assign({}, factsAllow, { cooldown: true }));
  const denyValidated = C.validateAgentPlan(denyPlan, reg);
  const denyRun = await runPlan(denyCtx, denyPlan);
  check('OA6.denyStopsExecution',
    denyValidated.ok === true && denyRun.steps[0].status === 'denied'
    && denyRun.steps[0].errorCode === 'cooldown' && denyCtx.spies.domain.length === 0
    && Object.keys(denyCtx.adapter.captured).length === 0, denyRun.steps[0]);

  /* OA7 allow executes once */
  const okExecutor = okCtx.adapter.resolveExecutor(descriptor);
  const twice = await okExecutor({ stepId: 's1', input: {}, idempotencyKey: 'k' });
  check('OA7.allowExecutesOnce',
    okCtx.spies.domain.length === 1 && okCtx.adapter.executorCalls.s1 === 2
    && twice.ok === false && twice.errorCode === 'executor-called-twice', twice);

  /* OA8 / OA9 verifier */
  const verified = await okCtx.adapter.verify(okRun.steps[0]);
  const missing = await okCtx.adapter.verify({ status: 'completed', ok: true, output: { letterId: 'rletter_ghost', actorId: 'role_a', recipientId: 'role_b' } });
  const notCompleted = await okCtx.adapter.verify({ status: 'denied', ok: false, output: { letterId: 'rletter_1', actorId: 'role_a', recipientId: 'role_b' } });
  check('OA8.verifyConfirmsCanonicalLetter', verified.verified === true && verified.letterId === 'rletter_1', verified);
  check('OA9.verifyMissingLetterFails',
    missing.verified === false && missing.errorCode === 'canonical-letter-missing'
    && notCompleted.errorCode === 'not-completed' && okCtx.spies.domain.length === 1, { missing: missing, notCompleted: notCompleted });

  /* OA10 cancellation before write */
  const cancelCtx = makeAdapter();
  const cancelRun = await runPlan(cancelCtx, planOf(factsAllow), { deps: { isCancelled: () => true } });
  check('OA10.cancellationBeforeWrite',
    cancelRun.steps[0].status === 'denied' && cancelRun.steps[0].errorCode === 'cancelled'
    && cancelCtx.spies.authority === 0 && cancelCtx.spies.domain.length === 0, cancelRun.steps[0]);

  /* OA11 identity preserved（actor / recipient 都是 canonical id） */
  const idCall = okCtx.spies.domain[0];
  check('OA11.identityPreserved',
    idCall.actorId === 'role_a' && idCall.recipientId === 'role_b'
    && okRun.steps[0].output.actorId === 'role_a'
    && ADAPTER_SRC.indexOf('actorId: str(input.actorId)') >= 0
    && ADAPTER_SRC.indexOf('recipientId: str(input.recipientId)') >= 0, idCall);

  /* OA12 idempotency preserved（domain 持有 identity，本层只透传） */
  const idemStep = planOf(factsAllow).steps[0];
  const derived = okCtx.adapter.idempotencyKeyFor(descriptor, idemStep);
  const explicit = okCtx.adapter.idempotencyKeyFor(descriptor, { stepId: 's2', input: { idempotencyKey: 'domain-owned-key' } });
  const idemCtx = makeAdapter();
  const idemRun = await runPlan(idemCtx, planOf(factsAllow, { idempotencyKey: 'domain-owned-key' }));
  check('OA12.idempotencyKeyPassthrough',
    derived === candidateIdFor({ actorId: 'role_a', recipientId: 'role_b', source: 'schedule', letterKind: 'init',
      trigger: 'init', triggerRef: 'cadence_role_a' })
    && explicit === 'domain-owned-key' && idemRun.steps[0].idempotencyKey === 'domain-owned-key'
    && idemCtx.spies.domain[0].idempotencyKey === 'domain-owned-key'
    && derived.indexOf('rletter_') !== 0, { derived: derived, envelope: idemCtx.spies.domain[0] });

  /* OA12c failed executor / result normalization / availability / secret */
  const failCtx = makeAdapter({ failDomain: true });
  const failRun = await runPlan(failCtx, planOf(factsAllow));
  const secretPlan = planOf(factsAllow, { apiKey: 'sk-abcdefgh1234' });
  const secretValidated = C.validateAgentPlan(secretPlan, reg);
  check('OA12c.resultNormalization',
    failRun.steps[0].status === 'failed' && failRun.steps[0].errorCode === 'domain-write-failed'
    && failRun.reflection.outcome === 'failed' && !REASONING.test(JSON.stringify(okRun))
    && secretValidated.ok === false && secretValidated.errors.some(e => e.indexOf('secret') >= 0)
    && D.describeRoleLetterAvailability({}) === 'available'
    && D.describeRoleLetterAvailability({ writerAvailable: false }) === 'unavailable',
    { fail: failRun.steps[0], secret: secretValidated.errors });

  await runProductionChecks();
})().catch(e => { console.error(e && e.stack || e); process.exitCode = 1; });

/* ══════════ PC · Production Convergence（真实 role-letters.js 生产链）══════════ */
const STORE_LETTER_BODY = RL_RAW.slice(RL_RAW.indexOf('async function _rlStoreLetter(data){'), RL_RAW.indexOf('/* ── 调度：主动写信'));
const INIT_BODY = RL_RAW.slice(RL_RAW.indexOf('async function _rlInitStep(cfg,now){'), RL_RAW.indexOf('/* ── 调度：待回信'));
const REPLY_BODY = RL_RAW.slice(RL_RAW.indexOf('async function _rlReplyStep(recipientId,now){'), RL_RAW.indexOf('function cfgOf(id)'));

async function runProductionChecks() {
  /* ── PC1 existing Role Letter flow works（cadence 写信全链路）────────── */
  const rt1 = createRoleLetterRuntime();
  const calls1 = withAuthoritySpy(rt1);
  seedInit(rt1, ['a']);
  await rt1.win._roleLettersTick();
  const letters1 = rt1.letters();
  const init1 = letters1.filter(l => l.kind === 'init');
  const pairs1 = JSON.parse(rt1.storage.ib_role_letters_pair_v1 || '{}');
  const queue1 = JSON.parse(rt1.storage.ib_role_letters_replyq_v1 || '{}');
  check('PC1.existingFlowWorks',
    init1.length === 1 && letters1.length === 1
    && init1[0].fromRoleId === 'a' && init1[0].toRoleId === 'b'
    && init1[0].readAt === null && init1[0].replyStatus === 'pending'
    && typeof pairs1['a|b'] === 'number' && !!queue1.b && queue1.b.letterId === init1[0].id
    && rt1.mems().some(m => m.owner === 'a' && m.direction === 'send' && m.letterId === init1[0].id)
    && rt1.sharedMemories().length === 0
    && rt1.modelCalls.filter(k => k === 'init').length === 1,
    { letters: letters1.length, pairs: pairs1, queue: queue1, mems: rt1.mems().length, warns: rt1.warns.slice(0, 2) });

  /* ── PC2 autonomous path uses authority（init 与 reply 两条）────────── */
  const rt2 = createRoleLetterRuntime();
  const calls2 = withAuthoritySpy(rt2);
  seedInit(rt2);
  await rt2.win._roleLettersTick();
  const initLetter = rt2.lettersOfKind('init')[0];
  /* 让 B 阅读并让回信到期 → 回信路径 */
  rt2.store.roleLetters.find(l => l.id === initLetter.id).readAt = Date.now();
  rt2.storage.ib_role_letters_replyq_v1 = JSON.stringify({ b: { letterId: initLetter.id, dueAt: Date.now() - 1000 } });
  await rt2.win._roleLettersTick();
  const replyLetter = rt2.lettersOfKind('reply')[0];
  const initCall = calls2.find(c => c.candidate.letterKind === 'init');
  const replyCall = calls2.find(c => c.candidate.letterKind === 'reply');
  check('PC2.autonomousPathUsesAuthority',
    !!initCall && initCall.candidate.source === 'schedule' && initCall.candidate.trigger === 'init'
    && initCall.candidate.actorId === 'a' && initCall.candidate.recipientId === 'b'
    && initCall.facts.enabled === true && initCall.facts.cooldown === false
    && !!replyCall && replyCall.candidate.source === 'character' && replyCall.candidate.trigger === 'reply'
    && replyCall.candidate.actorId === 'b' && replyCall.candidate.recipientId === 'a'
    && replyCall.facts.cooldown === false && replyCall.candidate.triggerRef === initLetter.id
    && !!replyLetter && replyLetter.parentId === initLetter.id
    && rt2.store.roleLetters.find(l => l.id === initLetter.id).replyStatus === 'replied',
    { init: initCall && initCall.candidate, reply: replyCall && replyCall.candidate, replyLetter: !!replyLetter, warns: rt2.warns.slice(0, 2) });

  /* ── PC3 direct writer bypass removed（静态 + fail closed 动态）──────── */
  const rt3 = createRoleLetterRuntime();
  withAuthoritySpy(rt3);
  seedInit(rt3);
  const saved = rt3.win.IBRoleLetterAuthority.runRoleLetterWrite;
  delete rt3.win.IBRoleLetterAuthority.runRoleLetterWrite;
  await rt3.win._roleLettersTick();
  rt3.win.IBRoleLetterAuthority.runRoleLetterWrite = saved;
  check('PC3.directWriterBypassRemoved',
    countOcc(RL, "dbPut(RL_STORE") === 1 && countOcc(RL, "dbPut('roleLetters'") === 0
    && STORE_LETTER_BODY.indexOf('_rlRunWrite(') >= 0
    && STORE_LETTER_BODY.indexOf('_rlWriteCanonical(rec)') >= 0
    && rt3.letters().length === 0,                  /* 权威缺席 ⇒ fail closed */
    { writes: countOcc(RL, "dbPut(RL_STORE"), letters: rt3.letters().length });

  /* ── PC4 ALLOW writes once（存储形状不变）────────────────────────────── */
  const rt4 = createRoleLetterRuntime();
  withAuthoritySpy(rt4);
  seedInit(rt4, ['a']);
  await rt4.win._roleLettersTick();
  const row4 = rt4.letters()[0] || {};
  const legacyKeys = ['id', 'createdAt', 'readAt', 'replyStatus', 'fromRoleId', 'toRoleId', 'content', 'kind', 'parentId'];
  const extraKeys = Object.keys(row4).filter(k => legacyKeys.indexOf(k) < 0);
  check('PC4.allowWritesOnce',
    rt4.letters().length === 1 && String(row4.id).indexOf('rletter_') === 0
    && extraKeys.length === 0 && row4.replyStatus === 'pending'
    && rt4.puts.filter(p => p.store === 'roleLetters').length === 1,
    { rows: rt4.letters().length, extra: extraKeys, row: row4 });

  /* ── PC5 DENY writes zero（两条：策略 deny + 生成期间被禁用）────────── */
  const rt5a = createRoleLetterRuntime();
  withAuthoritySpy(rt5a);
  rt5a.__denyAll = true;
  seedInit(rt5a);
  await rt5a.win._roleLettersTick();
  const rt5b = createRoleLetterRuntime({
    onModelCall: win => { win.localStorage.setItem('ib_role_letters_prefs_v1', JSON.stringify({ enabled: false })); }
  });
  const calls5b = withAuthoritySpy(rt5b);
  seedInit(rt5b);
  await rt5b.win._roleLettersTick();
  check('PC5.denyWritesZero',
    rt5a.letters().length === 0 && rt5a.mems().length === 0
    && (rt5a.storage.ib_role_letters_pair_v1 || '{}') === '{}'
    && (rt5a.storage.ib_role_letters_replyq_v1 || '{}') === '{}'
    && rt5b.letters().length === 0 && calls5b.length >= 1 && calls5b[0].facts.enabled === false,
    { a: rt5a.letters().length, aMems: rt5a.mems().length, aPair: rt5a.storage.ib_role_letters_pair_v1 || '{}',
      aQueue: rt5a.storage.ib_role_letters_replyq_v1 || '{}', b: rt5b.letters().length,
      bCalls: calls5b.length, bFacts: calls5b[0] && calls5b[0].facts });

  /* ── PC6 UI unaffected（收/发箱隔离 + 阅读标记）────────────────────── */
  const rt6 = createRoleLetterRuntime();
  withAuthoritySpy(rt6);
  seedInit(rt6, ['a']);
  await rt6.win._roleLettersTick();
  const letter6 = rt6.letters()[0];
  const inboxB = await rt6.win._rlLoadLettersFor('b', 'inbox');
  const inboxC = await rt6.win._rlLoadLettersFor('c', 'inbox');
  const outA = await rt6.win._rlLoadLettersFor('a', 'outbox');
  rt6.win._rlSetBox('inbox');
  rt6.win._rlSetViewAs('b');
  await rt6.win._rlExp(letter6.id);
  const readAt6 = rt6.store.roleLetters.find(l => l.id === letter6.id).readAt;
  let renderError = '';
  try { await rt6.win._rlRenderInbox(); } catch (e) { renderError = String(e && e.message || e); }
  check('PC6.uiUnaffected',
    inboxB.some(l => l.id === letter6.id) && !inboxC.some(l => l.id === letter6.id)
    && outA.some(l => l.id === letter6.id) && !!readAt6 && renderError === ''
    && typeof rt6.win.IB.roleLetters.writeCanonicalLetter === 'function'
    && rt6.win.IB.roleLetters.writeCanonicalLetter === rt6.win._rlWriteCanonical,
    { inboxB: inboxB.length, inboxC: inboxC.length, outA: outA.length, readAt: readAt6, renderError: renderError });

  /* ── PC7 existing storage unchanged（store 名 / 键集 / DB_VER / 私有命名空间）── */
  const rt7 = createRoleLetterRuntime();
  withAuthoritySpy(rt7);
  seedInit(rt7);
  await rt7.win._roleLettersTick();
  const mem7 = rt7.mems()[0] || {};
  check('PC7.existingStorageUnchanged',
    RL_RAW.indexOf("const RL_STORE='roleLetters';") >= 0
    && RL_RAW.indexOf("const RL_MEM_STORE='roleLetterMemories';") >= 0
    && RL_RAW.indexOf('RL_STATE_KEY=') >= 0 && RL_RAW.indexOf('RL_PAIR_KEY=') >= 0
    && RL_RAW.indexOf('RL_REPLYQ_KEY=') >= 0 && RL_RAW.indexOf('RL_PREFS_KEY=') >= 0
    && CORE_SRC.indexOf('DB_VER=24') >= 0
    && rt7.puts.every(p => ['roleLetters', 'roleLetterMemories'].indexOf(p.store) >= 0)
    && mem7.source === 'role_letter' && String(mem7.owner) === 'a'
    && rt7.sharedMemories().length === 0,
    { stores: [...new Set(rt7.puts.map(p => p.store))], mem: mem7.id });

  /* ── PC8 existing relationship behavior unchanged ───────────────────── */
  const rt8 = createRoleLetterRuntime();
  withAuthoritySpy(rt8);
  const cfgsBefore = JSON.stringify(rt8.win.apiConfigs);
  seedInit(rt8);
  await rt8.win._roleLettersTick();
  const cfgsAfter = JSON.stringify(rt8.win.apiConfigs);
  check('PC8.relationshipUnchanged',
    cfgsBefore === cfgsAfter                                   /* 写信不修改 cfg.relationship */
    && RL.indexOf('relationship') >= 0                          /* 只读（Prompt 里的"角色与用户的关系"） */
    && countOcc(RL, 'relationship=') === 0 && countOcc(RL, 'relationship =') === 0
    && countOcc(RL, "dbPut('memories'") === 0,                  /* 不写共享 Memory 子系统 */
    { relWrites: countOcc(RL, 'relationship='), memWrites: countOcc(RL, "dbPut('memories'") });

  console.log('\n' + (failed
    ? 'P25-3D Role Letter adapter / production convergence FAILED: ' + failed + ' failed / ' + passed + ' passed'
    : 'P25-3D Role Letter adapter / production convergence passed \u2714 (' + passed + ' checks)'));
  process.exitCode = failed ? 1 : 0;
}
