'use strict';

/* Internal Beyond · P26-10 · Activation Runtime Core 测试（B1–B18 + 生产非接线守卫）

   阶段性质：FOUNDATION / CONTRACT / PURE CORE / AUDIT-FIRST / NO PRODUCTION INTEGRATION。
   允许：新增独立纯模块 assets/js/activation-runtime-core.js。
   禁止：Agent Runtime / Agent Wake / Model / Planner / Action / P25 Autonomy /
        Queue / Scheduler / Persistence / Event Bus / Production Consumer。

   零浏览器、零网络、零真实 provider。 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ROOT = path.resolve(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const exists = f => fs.existsSync(path.join(ROOT, f));
const sha = f => crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, f))).digest('hex').toUpperCase();
const stripComments = src => String(src).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const AR = require(path.join(ROOT, 'assets/js/activation-runtime-core.js'));
const I = require(path.join(ROOT, 'assets/js/activation-intent-core.js'));
const R = require(path.join(ROOT, 'assets/js/wake-runtime-core.js'));
const W = require(path.join(ROOT, 'assets/js/wake-request-core.js'));
const F = require(path.join(ROOT, 'assets/js/feedback-core.js'));
const C = require(path.join(ROOT, 'assets/js/feedback-consumption-core.js'));
const A = require(path.join(ROOT, 'assets/js/autonomy-core.js'));
const SRC = read('assets/js/activation-runtime-core.js');
const CODE = stripComments(SRC);
/* 禁用清单数组本身包含 provider / model / priority 等词 —— 那是**拒绝**它们的证据，先摘掉。 */
const CODE_CORE = CODE.replace(/var FORBIDDEN_CONTEXT_FIELDS = Object\.freeze\(\[[\s\S]*?\]\);/,'');

let passed = 0, failed = 0;
const failures = [];
function check(name, cond, extra) {
  if (cond) { passed++; console.log('  \u2714 ' + name); }
  else { failed++; failures.push(name); console.log('  \u2716 ' + name + (extra === undefined ? '' : '  -> ' + JSON.stringify(extra).slice(0, 320))); }
}
const T = 1770000000001;
const mkFb = (patch) => F.createFeedback(Object.assign({ domain: 'cinema', source: 'cinema.runtime',
  reason: 'user-request-needs-attention' }, patch || {}), { timestamp: T }).feedback;
const mkIntent = (options) => {
  const fb = mkFb();
  const req = W.createWakeRequest(C.evaluateFeedbackConsumption(fb, { wakeCapable: true }), fb, options || {}).wakeRequest;
  const rt = R.evaluateWakeRequest(req, { runtimeAvailable: true });
  return { fb: fb, req: req, intent: I.createActivationIntent(rt, req, {}).activationIntent };
};
const ev = (ctx) => AR.evaluateActivationIntent(mkIntent().intent, ctx || {});

console.log('== P26-10 · Activation Runtime Core 测试 ==');

/* ── B1 valid intent ──────────────────────────────────────────────── */
const p1 = mkIntent({ causationId: 'evt_abc123' });
const b1 = AR.evaluateActivationIntent(p1.intent, { runtimeAvailable: true, targetAvailable: true });
check('B1.validReady',
  b1.ok === true && b1.readiness === 'READY' && b1.reason === 'ready'
  && b1.activationIntentId === p1.intent.activationIntentId
  && b1.wakeRequestId === p1.intent.wakeRequestId && b1.feedbackId === p1.fb.feedbackId
  && b1.causationId === 'evt_abc123'
  && Object.isFrozen(b1) && b1.version === 'activation-runtime/v1'
  && Object.keys(b1).every(k => AR.ALLOWED_RESULT_FIELDS.indexOf(k) >= 0), b1);

/* ── B2 invalid intent ────────────────────────────────────────────── */
check('B2.invalidIntent',
  AR.evaluateActivationIntent(null, { runtimeAvailable: true }).ok === false
  && AR.evaluateActivationIntent(null, {}).readiness === 'REJECTED'
  && AR.evaluateActivationIntent(null, {}).reason === 'invalid-intent'
  && AR.evaluateActivationIntent({ activationIntentId: 'ai_x' }, {}).reason === 'invalid-intent'
  && AR.evaluateActivationIntent(mkFb(), {}).reason === 'invalid-intent');

/* ── B3 readiness semantics ───────────────────────────────────────── */
check('B3.readinessSemantics',
  ev({ runtimeAvailable: true, targetAvailable: true }).readiness === 'READY'
  && ev({ runtimeAvailable: true }).readiness === 'BLOCKED' && ev({ runtimeAvailable: true }).reason === 'target-unavailable'
  && ev({ targetAvailable: true }).readiness === 'BLOCKED' && ev({ targetAvailable: true }).reason === 'runtime-unavailable'
  && ev({ runtimeAvailable: true, targetAvailable: true, cancelled: true }).readiness === 'REJECTED'
  && ev({ runtimeAvailable: true, targetAvailable: true, cancelled: true }).reason === 'cancelled'
  && ev({ cancelled: true }).reason === 'cancelled');

/* ── B4 determinism ───────────────────────────────────────────────── */
check('B4.deterministicResult',
  JSON.stringify(ev({ runtimeAvailable: true, targetAvailable: true })) === JSON.stringify(ev({ runtimeAvailable: true, targetAvailable: true }))
  && (function () {
    const intent = mkIntent().intent;
    const x = AR.evaluateActivationIntent(intent, { runtimeAvailable: true, targetAvailable: true });
    const y = AR.evaluateActivationIntent(intent, { runtimeAvailable: true, targetAvailable: true });
    return JSON.stringify(x) === JSON.stringify(y) && x !== y;
  })());

/* ── B5 causation ─────────────────────────────────────────────────── */
check('B5.causation',
  b1.feedbackId === p1.intent.feedbackId && b1.wakeRequestId === p1.intent.wakeRequestId
  && b1.activationIntentId === p1.intent.activationIntentId && b1.causationId === 'evt_abc123');

/* ── B6 identity audit：不引入 activationRequestId / 无随机/时钟 ──── */
check('B6.noRuntimeIdentityNoRandom',
  CODE.indexOf('activationRequestId') < 0 && Object.keys(b1).indexOf('activationRequestId') < 0
  && ['Math.random', 'randomUUID', 'crypto.random', 'uuid'].every(n => CODE.indexOf(n) < 0)
  && CODE.indexOf('Date.now') < 0 && CODE.indexOf('new Date') < 0 && CODE.indexOf('performance.now') < 0);

/* ── B7 no agent / no model ───────────────────────────────────────── */
check('B7.noAgent',
  ['createAgent', 'wakeAgent', 'runAgent', 'startAgent', 'triggerAgent', 'activateAgent', 'start(']
    .every(n => CODE_CORE.indexOf(n) < 0));
check('B8.noModel',
  ['fetch(', 'callApiChat', 'resolveModel', 'provider', 'prompt', 'streaming', 'WebSocket', 'llm', 'LLM', 'model']
    .every(n => CODE_CORE.indexOf(n) < 0));

/* ── B9 no planner / no action ────────────────────────────────────── */
check('B9.noPlanner',
  ['planner', 'Planner', 'plannerId', 'plan('].every(n => CODE_CORE.indexOf(n) < 0));
check('B10.noAction',
  ['createAction', 'actionId', 'execute', 'executor', 'Executor', 'runAction', 'performAction']
    .every(n => CODE_CORE.indexOf(n) < 0));

/* ── B11 no autonomy / no authority ───────────────────────────────── */
check('B11.noAutonomy',
  ['autonomy', 'Autonomy', 'autonomy-core', 'AUTONOMY'].every(n => CODE_CORE.indexOf(n) < 0)
  && SRC.indexOf("require('./autonomy-core.js')") < 0
  && Object.keys(A.AUTONOMY_DECISIONS).every(k =>
    AR.READINESS.indexOf(k) < 0 && AR.READINESS.indexOf(A.AUTONOMY_DECISIONS[k].toUpperCase()) < 0)
  && AR.REASONS.every(r => ['allow', 'deny', 'defer'].indexOf(r) < 0));
check('B12.noAuthority',
  ['Authority', 'permission', 'decide(', 'runMomentMutation', 'runDiaryWrite', 'runActiveMessageSend']
    .every(n => CODE_CORE.indexOf(n) < 0));

/* ── B13 no queue / no scheduler / no persistence / no bus ────────── */
check('B13.noQueue',
  ['queue', 'enqueue', 'dequeue', 'pending', 'backlog', 'waitingList'].every(n => CODE_CORE.indexOf(n) < 0));
check('B14.noScheduler',
  ['setTimeout', 'setInterval', 'schedule', 'tick', 'backoff', 'retry', 'cron'].every(n => CODE_CORE.indexOf(n) < 0));
check('B15.noPersistence',
  ['dbPut', 'dbGet', 'indexedDB', 'localStorage', 'sessionStorage', 'persist', 'store', 'cache', 'history']
    .every(n => CODE_CORE.indexOf(n) < 0));
check('B16.noEventBus',
  ['subscribe', 'EventBus', 'emit', 'listener', 'dispatch', 'publish', 'router', 'Bus', 'consume']
    .every(n => CODE_CORE.indexOf(n) < 0));

/* ── B17 vocabulary closed + context explicit ─────────────────────── */
check('B17.vocabularyClosed',
  JSON.stringify(AR.READINESS) === JSON.stringify(['READY', 'BLOCKED', 'REJECTED'])
  && ['ALLOW', 'DENY', 'EXECUTE'].every(d => AR.READINESS.indexOf(d) < 0)
  && CODE.indexOf("'ALLOW'") < 0 && CODE.indexOf("'DENY'") < 0 && CODE.indexOf("'EXECUTE'") < 0
  && CODE_CORE.indexOf('ALLOWED_RESULT_FIELDS') >= 0);
check('B18.contextExplicit',
  JSON.stringify(AR.CONTEXT_FIELDS) === JSON.stringify(['runtimeAvailable', 'targetAvailable', 'cancelled'])
  && AR.validateActivationContext({}).ok === true
  && AR.validateActivationContext({ runtimeAvailable: true, targetAvailable: true }).ok === true
  && AR.validateActivationContext({ runtimeAvailable: 'yes' }).errors.indexOf('bad-context-value:runtimeAvailable') >= 0
  && AR.validateActivationContext({ unknownThing: true }).errors.some(x => x.indexOf('unknown-field') === 0)
  && AR.validateActivationContext(null).errors.indexOf('not-an-object') >= 0);

/* ── B19 secret safety / no escape hatch / serialization ──────────── */
check('B19.secretSafetyAndDescribe',
  AR.validateActivationContext({ metadata: { apiKey: 'sk-abcdefgh1234' } }).errors.some(x => x.indexOf('forbidden-context-field') === 0)
  && AR.validateActivationContext({ apiKey: 'sk-abcdefgh1234' }).errors.some(x => x.indexOf('forbidden-context-field') === 0)
  && AR.validateActivationContext({ payload: 'sk-abcdefgh1234' }).errors.some(x => x.indexOf('forbidden-context-field') === 0)
  && AR.validateActivationContext({ model: 'x' }).errors.some(x => x.indexOf('forbidden-context-field') === 0)
  && JSON.stringify(b1).indexOf('sk-') < 0
  && JSON.stringify(JSON.parse(JSON.stringify(b1))) === JSON.stringify(b1)
  && AR.describeActivationResult(b1).readiness === 'READY' && AR.describeActivationResult(b1).version === 'activation-runtime/v1'
  && ['apiKey', 'token', 'credential', 'authorization'].every(k => JSON.stringify(b1).indexOf('"' + k + '"') < 0));

/* ── B20 validation delegated to P26-9 ────────────────────────────── */
check('B20.intentValidationDelegated',
  SRC.indexOf("require('./activation-intent-core.js')") >= 0
  && SRC.indexOf('validateActivationIntent') >= 0
  && CODE_CORE.indexOf('createActivationIntent') < 0);

/* ── B21 生产非接线：Production activation runtime = 0 ────────────── */
const CANDIDATES = [
  'assets/js/agent-runtime.js', 'assets/js/active-diary.js', 'assets/js/role-letters.js',
  'assets/js/activity/activity-runtime.js', 'apps/ib-app-cinema.js', 'assets/js/communication/voice.js',
  'assets/js/middle-brain.js', 'assets/js/group-runtime-core.js', 'assets/js/moments.js',
  'assets/js/autonomy-core.js', 'assets/js/agent-orchestration-core.js', 'assets/js/communication.js'
];
const consumerHits = [];
for (const file of CANDIDATES) {
  if (!exists(file)) continue;
  const src = stripComments(read(file));
  if (/IBActivationRuntime|activation-runtime-core|evaluateActivationIntent|validateActivationContext|describeActivationResult/.test(src)) consumerHits.push(file);
}
check('B21.productionActivationRuntimeZero',
  consumerHits.length === 0 && exists('assets/js/activation-runtime-core.js')
  && read('InternalBeyond.html').indexOf('activation-runtime-core.js') < 0,
  consumerHits);

/* ── G Guards：foundation 逐字节 + DB 未变 ──────────────────────── */
const FROZEN = {
  'assets/js/domain-event-core.js': ['3D8F339B', '12805562'],
  'assets/js/observation-core.js': ['077DA39B', 'E18ECC3F'],
  'assets/js/session-core.js': ['5778EE01', '2819C529'],
  'assets/js/resource-core.js': ['71318C21', 'EE8A60FA'],
  'assets/js/feedback-core.js': ['6C4A9B10', '436D6129'],
  'assets/js/feedback-consumption-core.js': ['DBBB6F57', 'EBA67714'],
  'assets/js/wake-request-core.js': ['49BBF9F6', '98EAC2'],
  'assets/js/wake-runtime-core.js': ['117E9D7F', '063BB2A9'],
  'assets/js/activation-intent-core.js': ['4F910855', '2D9B2303'],
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
const storeList = (COREJS.match(/\[('posts'[\s\S]*?)\]\.forEach/) || [])[1] || '';
check('G2.dbUnchanged',
  COREJS.indexOf("DB_NAME='InternalBeyondDB',DB_VER=24") >= 0
  && ['activationRuntime', 'activationRequest', 'intentStore', 'activationHistory', 'wakeRuntime',
    'wakeRequests', 'agentWake', 'signals'].every(s => storeList.indexOf("'" + s + "'") < 0),
  storeList.slice(-140));

/* ── 小 surface（§12：三个函数即可）──────────────────────────────── */
const apiKeys = Object.keys(AR).filter(k => typeof AR[k] === 'function').sort();
check('G3.smallPureApiSurface',
  JSON.stringify(apiKeys) === JSON.stringify(['describeActivationResult', 'evaluateActivationIntent', 'validateActivationContext'])
  && CODE_CORE.indexOf('ActivationManager') < 0 && CODE_CORE.indexOf('AgentStarter') < 0
  && CODE_CORE.indexOf('WakeService') < 0 && CODE_CORE.indexOf('PolicyEngine') < 0,
  apiKeys);

console.log('\n' + (failed
  ? 'P26-10 Activation Runtime Core FAILED: ' + failed + ' failed / ' + passed + ' passed'
  : 'P26-10 Activation Runtime Core passed \u2714 (' + passed + ' checks, production activation runtime = 0)'));
process.exitCode = failed ? 1 : 0;
