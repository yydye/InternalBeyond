'use strict';

/* Internal Beyond · P26-6 · Feedback Consumption & Wake Eligibility Core 测试
   （C1–C34 + Loop Guards + 生产非接线守卫）

   阶段性质：FOUNDATION / CONTRACT / PURE CORE / AUDIT-FIRST / NO PRODUCTION INTEGRATION。
   允许：新增独立纯模块 assets/js/feedback-consumption-core.js。
   禁止：Wake Runtime / Wake Request Queue / Agent Wake / Event Bus / Feedback Bus /
        Scheduler / Policy Engine / Production Consumer / Capability Selection / Action Creation。

   零浏览器、零网络、零真实 provider。 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ROOT = path.resolve(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const exists = f => fs.existsSync(path.join(ROOT, f));
const sha = f => crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, f))).digest('hex').toUpperCase();
const stripComments = src => String(src).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const C = require(path.join(ROOT, 'assets/js/feedback-consumption-core.js'));
const F = require(path.join(ROOT, 'assets/js/feedback-core.js'));
const SRC = read('assets/js/feedback-consumption-core.js');
const CODE = stripComments(SRC);
/* 闭集/禁用清单数组本身包含 runtimeAvailable / priority / metadata 等词 —— 那是**拒绝**它们的证据，
   因此依赖守卫先摘掉这两个数组（与 P26-1..5 同一策略）。 */
const CODE_CORE = CODE
  .replace(/var FORBIDDEN_CONTEXT_FIELDS = Object\.freeze\(\[[\s\S]*?\]\);/, '')
  .replace(/var REASONS = Object\.freeze\(\[[\s\S]*?\]\);/, '');

let passed = 0, failed = 0;
const failures = [];
function check(name, cond, extra) {
  if (cond) { passed++; console.log('  \u2714 ' + name); }
  else { failed++; failures.push(name); console.log('  \u2716 ' + name + (extra === undefined ? '' : '  -> ' + JSON.stringify(extra).slice(0, 320))); }
}
const T = 1770000000001;
const mkFb = (patch) => F.createFeedback(Object.assign({ domain: 'cinema', source: 'cinema.runtime',
  reason: 'camera-unavailable' }, patch || {}), { timestamp: T }).feedback;
const highFb = () => mkFb({ severity: 'high' });
const ev = (fb, ctx) => C.evaluateFeedbackConsumption(fb, ctx || {});

console.log('== P26-6 · Feedback Consumption Core 测试 ==');

/* ── C1 valid feedback consumption ────────────────────────────────── */
const c1 = ev(highFb(), {});
check('C1.validConsumption',
  c1.ok === true && c1.disposition === 'OBSERVE' && c1.reason === 'default-observe'
  && c1.feedbackId === highFb().feedbackId && c1.domain === 'cinema'
  && Object.isFrozen(c1) && c1.version === 'feedback-consumption/v1', c1);

/* ── C2 invalid feedback rejected ─────────────────────────────────── */
check('C2.invalidFeedbackRejected',
  ev({ domain: 'cinema' }, {}).ok === false
  && ev({ domain: 'cinema' }, {}).reason === 'invalid-feedback'
  && ev({ domain: 'cinema' }, {}).disposition === ''          /* 无 disposition = 未被消费 */
  && ev(null, {}).ok === false && ev('nope', {}).ok === false
  && ev(mkFb(), undefined).ok === true);

/* ── C3 / C31 deterministic result ────────────────────────────────── */
check('C3.deterministicResult',
  JSON.stringify(ev(highFb(), { wakeCapable: true })) === JSON.stringify(ev(highFb(), { wakeCapable: true }))
  && JSON.stringify(ev(highFb(), { cooldownActive: true })) === JSON.stringify(ev(highFb(), { cooldownActive: true })));
check('C31.sameInputSameResult',
  (function () {
    const fb = mkFb();
    const a = ev(fb, { wakeCapable: true }), b = ev(fb, { wakeCapable: true });
    return JSON.stringify(a) === JSON.stringify(b) && a !== b;   /* 每次都是新的结果对象 */
  })());

/* ── C4 minimal context（缺字段 = false，fail closed）──────────────── */
check('C4.minimalContext',
  ev(mkFb(), {}).reason === 'default-observe'
  && ev(mkFb(), { cancelled: false }).reason === 'default-observe'
  && ev(mkFb(), { wakeCapable: false }).reason === 'default-observe'
  && JSON.stringify(C.CONTEXT_FIELDS) === JSON.stringify(['wakeCapable', 'cancelled', 'alreadyConsumed', 'recentEquivalent', 'cooldownActive'])
  && C.validateConsumptionContext({}).ok === true
  && C.validateConsumptionContext({ wakeCapable: true }).ok === true);

/* ── C5 disposition closed set ───────────────────────────────────── */
check('C5.dispositionClosedSet',
  JSON.stringify(C.DISPOSITIONS) === JSON.stringify(['IGNORE', 'OBSERVE', 'WAKE_ELIGIBLE'])
  && ['EXECUTE', 'ACTION', 'ALLOW', 'DENY', 'RUN', 'SEND', 'POST', 'DEFER']
    .every(d => C.DISPOSITIONS.indexOf(d) < 0)
  && C.REASONS.indexOf('deferred') < 0 && JSON.stringify(C.REASONS).indexOf('defer') < 0);

/* ── C6 / C7 / C8 三种处置 ───────────────────────────────────────── */
check('C6.ignoreDisposition',
  ev(mkFb(), { wakeCapable: true, cancelled: true }).disposition === 'IGNORE'
  && ev(mkFb(), { wakeCapable: true, cancelled: true }).reason === 'cancelled'
  && ev(mkFb(), { wakeCapable: true, alreadyConsumed: true }).disposition === 'IGNORE'
  && ev(mkFb(), { wakeCapable: true, recentEquivalent: true }).disposition === 'IGNORE');
check('C7.observeDisposition',
  ev(mkFb(), {}).disposition === 'OBSERVE'
  && ev(mkFb(), { wakeCapable: true, cooldownActive: true }).disposition === 'OBSERVE'
  && ev(mkFb(), { wakeCapable: true, cooldownActive: true }).reason === 'cooldown'
  && ev(mkFb(), { wakeCapable: 'yes' }).disposition === ''      /* 非布尔 context 被拒 ⇒ 无 disposition */
  && C.validateConsumptionContext({ wakeCapable: 'yes' }).errors.indexOf('bad-context-value:wakeCapable') >= 0);
check('C8.wakeEligibleDisposition',
  ev(mkFb(), { wakeCapable: true }).disposition === 'WAKE_ELIGIBLE'
  && ev(mkFb(), { wakeCapable: true }).reason === 'wake-eligible'
  /* 资格 ≠ 唤醒：结果里没有任何 wake/action/capability 字段 */
  && Object.keys(ev(mkFb(), { wakeCapable: true })).every(k => C.ALLOWED_RESULT_FIELDS.indexOf(k) >= 0));

/* ── C9 high severity ≠ automatic wake eligibility ────────────────── */
check('C9.highSeverityIsNotAutomaticWake',
  ev(mkFb({ severity: 'high' }), {}).disposition === 'OBSERVE'
  && ev(mkFb({ severity: 'high' }), { wakeCapable: false }).disposition === 'OBSERVE'
  && ev(mkFb({ severity: 'high' }), { wakeCapable: true }).disposition === 'WAKE_ELIGIBLE'
  /* 判定函数完全不读 severity（源码切片证明） */
  && (function () {
    const body = CODE.slice(CODE.indexOf('function evaluateFeedbackConsumption('), CODE.indexOf('function describeConsumption('));
    return body.length > 0 && body.indexOf('severity') < 0;
  })());

/* ── C10–C14 no Action / Capability / Authority / Executor / Autonomy ── */
const outputs = ev(mkFb(), { wakeCapable: true });
check('C10.noActionOutput',
  ['action', 'actionId', 'act', 'intent', 'command', 'request'].every(k => Object.keys(outputs).indexOf(k) < 0)
  && CODE_CORE.indexOf('createAction') < 0 && CODE_CORE.indexOf("'action'") < 0);
check('C11.noCapabilityOutput',
  Object.keys(outputs).indexOf('capabilityId') < 0
  && ['moment.post', 'diary.write', 'active_message.send', 'role_letter.write'].every(c => CODE_CORE.indexOf(c) < 0)
  && CODE_CORE.indexOf('capability') < 0);
check('C12.noAuthority',
  ['Authority', 'decide(', 'runMomentMutation', 'runDiaryWrite', 'runActiveMessageSend', 'runRoleLetterWrite', 'permission']
    .every(n => CODE_CORE.indexOf(n) < 0));
check('C13.noExecutor',
  ['executor', 'createMoment', 'writeDiary', 'sendMessage', 'writeLetter', 'createActivity']
    .every(n => CODE_CORE.indexOf(n) < 0));
check('C14.noAutonomyDependency',
  ['autonomy', 'Autonomy', 'AUTONOMY_DECISIONS', 'runAutonomyAction', 'autonomy-core']
    .every(n => CODE_CORE.indexOf(n) < 0)
  /* 本契约不依赖 Autonomy Core —— 只依赖 P26-5 feedback 契约（委托校验） */
  && SRC.indexOf("require('./feedback-core.js')") >= 0);

/* ── C15–C19 no model / wake / notification / event / observation ───── */
check('C15.noModelOrProvider',
  ['fetch(', 'callApiChat', 'resolveModel', 'provider', 'prompt', 'IB.runtime', 'streaming', 'WebSocket']
    .every(n => CODE_CORE.indexOf(n) < 0));
check('C16.noWakeExecution',
  ['wakeRequest', 'wakeQueue', 'triggerAgent', 'wake(', 'doWake'].every(n => CODE_CORE.indexOf(n) < 0)
  && SRC.indexOf('triggerAgent') < 0
  /* WAKE_ELIGIBLE 只是字符串常量，没有任何执行面 */
  && CODE_CORE.indexOf('WAKE_ELIGIBLE') >= 0 && CODE_CORE.indexOf('dispatch') < 0);
check('C17.noNotification',
  ['toast', 'Notification', 'notify', 'alert(', 'showNotification', 'serviceWorker']
    .every(n => CODE_CORE.indexOf(n) < 0));
check('C18.noEventSubscription',
  ['subscribe', 'EventBus', 'emit', 'listener', 'dispatch', 'router', 'IBDomainEvent', 'domain-event-core']
    .every(n => CODE_CORE.indexOf(n) < 0));
check('C19.noObservationRead',
  ['IBObservation', 'observation-core', 'createObservation', 'observationId', 'frame', 'progress']
    .every(n => CODE_CORE.indexOf(n) < 0));

/* ── C20–C25 no Session mutation / Resource arbitration / persistence / queue / scheduler / router ── */
check('C20.noSessionMutation',
  ['createSession', 'transitionSession', 'IBSessionCore', 'session-core', 'startSession', 'endSession']
    .every(n => CODE_CORE.indexOf(n) < 0));
check('C21.noResourceArbitration',
  ['IBResource', 'resource-core', 'evaluateConflict', 'createClaim', 'grant', 'lease', 'lock']
    .every(n => CODE_CORE.indexOf(n) < 0));
check('C22.noPersistence',
  ['dbPut', 'dbGet', 'indexedDB', 'localStorage', 'sessionStorage', 'persist', 'history', 'store', 'cache']
    .every(n => CODE_CORE.indexOf(n) < 0));
check('C23.noQueue',
  ['queue', 'enqueue', 'dequeue', 'pending', 'backlog'].every(n => CODE_CORE.indexOf(n) < 0));
check('C24.noScheduler',
  ['setTimeout', 'setInterval', 'schedule', 'tick', 'backoff', 'retry'].every(n => CODE_CORE.indexOf(n) < 0));
check('C25.noRouter',
  ['route', 'routing', 'Bus', 'channel', 'registry'].every(n => CODE_CORE.indexOf(n) < 0)
  && CODE_CORE.indexOf('class ') < 0);

/* ── C26–C29 no clock / no random / serializable / secret safety ───── */
check('C26.noDateNow', CODE.indexOf('Date.now') < 0 && CODE.indexOf('new Date') < 0 && CODE.indexOf('performance.now') < 0);
check('C27.noMathRandom', CODE.indexOf('Math.random') < 0 && CODE.indexOf('crypto.random') < 0);
check('C28.serializable',
  JSON.stringify(JSON.parse(JSON.stringify(outputs))) === JSON.stringify(outputs)
  && C.evaluateFeedbackConsumption(mkFb(), { wakeCapable: true }).ok === true);
check('C29.secretSafety',
  /* context 不能成为凭据逃生舱：禁用字段 / 未知字段一律拒绝 */
  C.validateConsumptionContext({ metadata: { apiKey: 'sk-abcdefgh1234' } }).errors.some(x => x.indexOf('forbidden-context-field') === 0)
  && C.validateConsumptionContext({ apiKey: 'sk-abcdefgh1234' }).errors.some(x => x.indexOf('forbidden-context-field') === 0)
  && C.validateConsumptionContext({ payload: 'sk-abcdefgh1234' }).errors.some(x => x.indexOf('forbidden-context-field') === 0)
  /* 结果不回显任何凭据形态字段 */
  && JSON.stringify(outputs).indexOf('sk-') < 0
  && ['apiKey', 'token', 'credential', 'authorization'].every(k => JSON.stringify(outputs).indexOf('"' + k + '"') < 0));

/* ── C30 Feedback immutable ──────────────────────────────────────── */
check('C30.feedbackImmutable',
  (function () {
    const fb = mkFb();
    const before = JSON.stringify(fb);
    const res = ev(fb, { wakeCapable: true });
    return JSON.stringify(fb) === before && res !== fb
      && Object.isFrozen(fb) && res.feedbackId === fb.feedbackId
      && !Object.prototype.hasOwnProperty.call(res, 'severity')
      && res.disposition === 'WAKE_ELIGIBLE';
  })());

/* ── C32 no metadata / payload / contextDump 逃生舱 ───────────────── */
check('C32.noEscapeHatch',
  ['metadata', 'payload', 'data', 'content', 'body', 'record', 'state', 'dump', 'contextDump',
    'priority', 'urgency', 'rank', 'schedule', 'deadline', 'retry', 'runtimeAvailable', 'userPresent',
    'sessionActive', 'attention', 'score', 'energy', 'budget'].every(f => {
    const r = C.validateConsumptionContext({ [f]: true });
    return r.ok === false && r.errors.some(x => x.indexOf('forbidden-context-field') === 0);
  })
  && C.validateConsumptionContext({ unknownThing: true }).errors.some(x => x.indexOf('unknown-field') === 0)
  && C.ALLOWED_RESULT_FIELDS.indexOf('metadata') < 0
  && C.ALLOWED_RESULT_FIELDS.indexOf('payload') < 0);

/* ── Loop Guards（§46）：重复消费不会自动升级成 wake ──────────────── */
check('LM1.repeatedConsumptionNeverEscalates',
  (function () {
    const fb = mkFb();
    const first = ev(fb, { wakeCapable: true });
    /* 第二次带上"已消费"事实 ⇒ IGNORE/duplicate（绝不因为重复而升级） */
    const second = ev(fb, { wakeCapable: true, alreadyConsumed: true });
    /* 第三次仍然没有状态记忆：不带 alreadyConsumed 时结果与第一次完全相同（Core 不持有状态） */
    const third = ev(fb, { wakeCapable: true });
    return first.disposition === 'WAKE_ELIGIBLE' && second.disposition === 'IGNORE'
      && second.reason === 'duplicate' && JSON.stringify(third) === JSON.stringify(first)
      && C.DISPOSITIONS.indexOf('ESCALATE') < 0;
  })());
check('LM2.alreadyConsumedSemantics',
  C.validateConsumptionContext({ alreadyConsumed: true }).ok === true
  && ev(mkFb(), { alreadyConsumed: true }).disposition === 'IGNORE'
  && ev(mkFb(), { alreadyConsumed: true }).reason === 'duplicate'
  && ev(mkFb(), { alreadyConsumed: true }).feedbackId === mkFb().feedbackId
  /* 语义明确：dedupe 事实由 caller 提供；Core **不**持久化、**不**去重存储 */
  && SRC.indexOf('dedupeStore') < 0 && CODE_CORE.indexOf('Set(') < 0);

/* ── C33 / C34 生产非接线：Production consumers = 0 / Production wakes = 0 ── */
const CANDIDATES = {
  active_message: ['assets/js/active-diary.js', 'async function _activeExecuteRun(run){'],
  diary: ['assets/js/active-diary/diary.js', 'async function _diaryTick(opts){'],
  role_letter: ['assets/js/role-letters.js', 'async function _roleLettersTick(){'],
  moments: ['assets/js/moments.js', '_momentsTick'],
  activity: ['assets/js/activity/activity-runtime.js', 'async function nudge(o){'],
  cinema: ['apps/ib-app-cinema.js', 'function grabFrame('],
  voice: ['assets/js/communication/voice.js', ''],
  p24_group: ['assets/js/group-runtime-core.js', 'function groupTurnIdFor(userMessageId) {'],
  middle_brain: ['assets/js/middle-brain.js', ''],
  agent_runtime: ['assets/js/agent-runtime.js', '']
};
const consumerHits = [];
for (const key of Object.keys(CANDIDATES)) {
  const [file, anchor] = CANDIDATES[key];
  if (!exists(file)) continue;
  const src = stripComments(read(file));
  if (/IBFeedbackConsumption|feedback-consumption-core|evaluateFeedbackConsumption|WAKE_ELIGIBLE/.test(src)) consumerHits.push(file + ' (' + key + ')');
  if (anchor && src.indexOf(anchor) < 0) consumerHits.push(file + ' (anchor missing: ' + anchor + ')');
}
check('C33.C34.productionConsumersAndWakesZero',
  consumerHits.length === 0 && exists('assets/js/feedback-consumption-core.js')
  /* 生产 HTML 不加载 consumption core（P26-1..5 同策略：foundation-only） */
  && read('InternalBeyond.html').indexOf('feedback-consumption-core.js') < 0,
  consumerHits);

/* ── G Guards：foundation 逐字节 + DB 未变 ──────────────────────── */
const FROZEN = {
  'assets/js/domain-event-core.js': ['3D8F339B', '12805562'],
  'assets/js/observation-core.js': ['077DA39B', 'E18ECC3F'],
  'assets/js/session-core.js': ['5778EE01', '2819C529'],
  'assets/js/resource-core.js': ['71318C21', 'EE8A60FA'],
  'assets/js/feedback-core.js': ['6C4A9B10', '436D6129'],
  'assets/js/autonomy-core.js': ['FE1011F1', '9F2956F8'],
  'assets/js/agent-capability-registry.js': ['78AE9DFE', '273BF7A2'],
  'assets/js/agent-orchestration-core.js': ['BA4A3DFA', 'AC204F79'],
  'assets/js/role-letter-authority.js': ['1743B97D', '39387C90'],
  'assets/js/diary-authority.js': ['BBB7EC88', 'C95E73A9'],
  'assets/js/active-message-authority.js': ['CC2A8BF9', 'AE3892C4'],
  'assets/js/moments-mutation-authority.js': ['1FBB1E12', '2FB5A056'],
  'assets/js/moments-autonomy.js': ['A4CEE6DA', 'C843CD1A'],
  'assets/js/delivery-planner.js': ['15E7DBD0', 'E887308C'],
  'assets/js/delivery-runtime.js': ['82BC57D7', 'F7F46802'],
  'assets/js/delivery-sequence-core.js': ['5AE59648', 'FEB7EB35'],
  'assets/js/multimodal-delivery-policy.js': ['B7AFDFA6', 'ABC8B370'],
  'assets/js/voice-message-core.js': ['06907AA2', 'DEDDB258'],
  'assets/js/group-runtime-core.js': ['6F30FDE9', '067B35E8'],
  'assets/js/communication.js': ['DEB568A2', 'AC29184F'],
  'assets/js/active-diary.js': ['D14D4AC6', '89ADE8CA'],
  'assets/js/moments.js': ['E23697DE', 'B82CEE31']
};
const changed = Object.keys(FROZEN).filter(f => !(sha(f).startsWith(FROZEN[f][0]) && sha(f).endsWith(FROZEN[f][1])));
check('G1.foundationGuardsUnchanged', changed.length === 0, changed);
const COREJS = read('assets/js/core.js');
const storeList = require('./helpers/db-schema-authority.js').storeList;
check('G2.dbUnchanged',
  require('./helpers/db-schema-authority.js').isVersion('InternalBeyondDB', 24)
  && ['feedbackConsumption', 'wakeRequests', 'wakeHistory', 'attentionQueue', 'agentWake', 'signals']
    .every(s => storeList.indexOf("'" + s + "'") < 0),
  storeList.slice(-140));

/* ── 小 surface（§35：1–2 个函数够用就不要凑数）──────────────────── */
const apiKeys = Object.keys(C).filter(k => typeof C[k] === 'function').sort();
check('G3.smallPureApiSurface',
  JSON.stringify(apiKeys) === JSON.stringify(['describeConsumption', 'evaluateFeedbackConsumption', 'validateConsumptionContext'])
  && SRC.indexOf('FeedbackConsumerManager') < 0 && SRC.indexOf('WakeManager') < 0
  && SRC.indexOf('AttentionScheduler') < 0 && SRC.indexOf('PolicyEngine') < 0
  && SRC.indexOf('window.IB.wake') < 0, apiKeys);

console.log('\n' + (failed
  ? 'P26-6 Feedback Consumption Core FAILED: ' + failed + ' failed / ' + passed + ' passed'
  : 'P26-6 Feedback Consumption Core passed \u2714 (' + passed + ' checks, production consumers = 0, production wakes = 0)'));
process.exitCode = failed ? 1 : 0;
