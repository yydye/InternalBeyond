'use strict';

/* Internal Beyond · P26-9 · Activation Intent Core 测试（A1–A20 + 生产非接线守卫）

   阶段性质：FOUNDATION / CONTRACT / PURE CORE / AUDIT-FIRST / NO PRODUCTION INTEGRATION。
   允许：新增独立纯模块 assets/js/activation-intent-core.js。
   禁止：Agent Wake / Agent Start / Planner / Model / Action / P25 Autonomy /
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

const I = require(path.join(ROOT, 'assets/js/activation-intent-core.js'));
const R = require(path.join(ROOT, 'assets/js/wake-runtime-core.js'));
const W = require(path.join(ROOT, 'assets/js/wake-request-core.js'));
const F = require(path.join(ROOT, 'assets/js/feedback-core.js'));
const C = require(path.join(ROOT, 'assets/js/feedback-consumption-core.js'));
const SRC = read('assets/js/activation-intent-core.js');
const CODE = stripComments(SRC);
/* 拒绝清单数组本身包含 priority / content 等词 —— 那是**拒绝**它们的证据，先摘掉。 */
const CODE_CORE = CODE
  .replace(/var RESERVED_BODY_FIELDS = Object\.freeze\(\[[\s\S]*?\]\);/,'')
  .replace(/var POLICY_ONLY_FIELDS = Object\.freeze\(\[[\s\S]*?\]\);/,'');

let passed = 0, failed = 0;
const failures = [];
function check(name, cond, extra) {
  if (cond) { passed++; console.log('  \u2714 ' + name); }
  else { failed++; failures.push(name); console.log('  \u2716 ' + name + (extra === undefined ? '' : '  -> ' + JSON.stringify(extra).slice(0, 320))); }
}
const T = 1770000000001;
const mkFb = (patch) => F.createFeedback(Object.assign({ domain: 'cinema', source: 'cinema.runtime',
  reason: 'user-request-needs-attention' }, patch || {}), { timestamp: T }).feedback;
const mkPair = (options) => {
  const fb = mkFb();
  const req = W.createWakeRequest(C.evaluateFeedbackConsumption(fb, { wakeCapable: true }), fb, options || {}).wakeRequest;
  return { fb: fb, req: req, rt: R.evaluateWakeRequest(req, { runtimeAvailable: true }) };
};
const mkIntent = (options) => {
  const p = mkPair();
  return I.createActivationIntent(p.rt, p.req, options || {});
};

console.log('== P26-9 · Activation Intent Core 测试 ==');

/* ── A1 valid intent ──────────────────────────────────────────────── */
const p1 = mkPair({ causationId: 'evt_abc123' });
const a1 = I.createActivationIntent(p1.rt, p1.req, {});
check('A1.validIntent',
  a1.ok === true && a1.errors.length === 0
  && a1.activationIntent.activationIntentId.indexOf('ai_') === 0
  && a1.activationIntent.wakeRequestId === p1.req.wakeRequestId
  && a1.activationIntent.feedbackId === p1.fb.feedbackId
  && a1.activationIntent.domain === 'cinema' && a1.activationIntent.source === 'cinema.runtime'
  && a1.activationIntent.reason === 'user-request-needs-attention'
  && a1.activationIntent.causationId === 'evt_abc123'
  && a1.activationIntent.version === 'activation-intent/v1'
  && Object.isFrozen(a1.activationIntent)
  && I.validateActivationIntent(a1.activationIntent).ok === true, a1);

/* ── A2 identity（审计：需要；确定性；无 random UUID）─────────────── */
check('A2.identityDeterministic',
  I.createActivationIntent(p1.rt, p1.req, {}).activationIntent.activationIntentId
    === I.createActivationIntent(p1.rt, p1.req, {}).activationIntent.activationIntentId
  /* 注入优先 */
  && I.createActivationIntent(p1.rt, p1.req, { activationIntentId: 'ai_injected_1' })
    .activationIntent.activationIntentId === 'ai_injected_1'
  && I.validateActivationIntent({ activationIntentId: '', wakeRequestId: 'wr_x', feedbackId: 'fb_x',
    domain: 'd', source: 'a.b', reason: 'r', version: 'activation-intent/v1' })
    .errors.indexOf('missing-activation-intent-id') >= 0
  && CODE.indexOf('uuid') < 0 && CODE.indexOf('Math.random') < 0 && CODE.indexOf('randomUUID') < 0);

/* ── A3 causation（feedbackId / wakeRequestId / causationId 保留）──── */
check('A3.causation',
  a1.activationIntent.feedbackId === p1.fb.feedbackId
  && a1.activationIntent.wakeRequestId === p1.req.wakeRequestId
  && a1.activationIntent.causationId === 'evt_abc123'
  /* derivedFrom 随 Wake Request 携带 */
  && (function () {
    const fb = mkFb({ derivedFrom: 'evt_origin_1' });
    const req = W.createWakeRequest(C.evaluateFeedbackConsumption(fb, { wakeCapable: true }), fb, {}).wakeRequest;
    const rt = R.evaluateWakeRequest(req, { runtimeAvailable: true });
    return I.createActivationIntent(rt, req, {}).activationIntent.derivedFrom === 'evt_origin_1';
  })());

/* ── A4 immutability ──────────────────────────────────────────────── */
check('A4.immutableInput',
  (function () {
    const rtBefore = JSON.stringify(p1.rt), reqBefore = JSON.stringify(p1.req);
    const res = I.createActivationIntent(p1.rt, p1.req, {});
    return JSON.stringify(p1.rt) === rtBefore && JSON.stringify(p1.req) === reqBefore
      && res.activationIntent !== p1.rt && res.activationIntent !== p1.req
      && Object.isFrozen(p1.rt) && Object.isFrozen(p1.req) && res.ok === true;
  })());

/* ── A5 determinism ───────────────────────────────────────────────── */
check('A5.deterministicResult',
  JSON.stringify(mkIntent()) === JSON.stringify(mkIntent())
  && (function () {
    const p = mkPair();
    const x = I.createActivationIntent(p.rt, p.req, {}), y = I.createActivationIntent(p.rt, p.req, {});
    return JSON.stringify(x) === JSON.stringify(y) && x.activationIntent !== y.activationIntent;
  })());

/* ── A6 activation gate：只能从 ACTIVATE_ELIGIBLE 创建（不绕过）────── */
check('A6.activationGate',
  /* BLOCKED / REJECTED ⇒ not-activatable */
  I.createActivationIntent(R.evaluateWakeRequest(p1.req, {}), p1.req, {}).errors.indexOf('not-activatable') >= 0
  && I.createActivationIntent(R.evaluateWakeRequest(p1.req, { runtimeAvailable: true, cancelled: true }), p1.req, {})
    .errors.indexOf('not-activatable') >= 0
  /* 裸 Wake Request 当第一参数 ⇒ invalid-wake-result（不得绕过 Wake Runtime） */
  && I.createActivationIntent(p1.req, p1.req, {}).errors.indexOf('invalid-wake-result') >= 0
  && I.createActivationIntent(null, p1.req, {}).ok === false
  /* request 与 result 不同源 ⇒ request-mismatch */
  && (function () {
    const other = mkPair();
    return I.createActivationIntent(p1.rt, other.req, {}).errors.indexOf('request-mismatch') >= 0;
  })()
  /* 非法 request ⇒ invalid-request */
  && I.createActivationIntent(p1.rt, null, {}).errors.indexOf('invalid-request') >= 0);

/* ── A7 词汇表权威（来自 P26-8，不复制第二份）─────────────────────── */
check('A7.vocabularyAuthority',
  I.ELIGIBLE_ACTIVATION === 'ACTIVATE_ELIGIBLE'
  && I.ACTIVATIONS === R.ACTIVATIONS
  && R.ACTIVATIONS.indexOf('ACTIVATE_ELIGIBLE') >= 0
  && SRC.indexOf("require('./wake-runtime-core.js')") >= 0
  && SRC.indexOf("require('./wake-request-core.js')") >= 0);

/* ── A8 no runtime / no agent ─────────────────────────────────────── */
check('A8.noRuntimeNoAgent',
  ['triggerAgent', 'startAgent', 'activateAgent', 'doWake', 'wakeAgent', 'start(']
    .every(n => CODE_CORE.indexOf(n) < 0));

/* ── A9 no model / no planner / no action ─────────────────────────── */
check('A9.noModel',
  ['fetch(', 'callApiChat', 'resolveModel', 'provider', 'prompt', 'streaming', 'WebSocket', 'llm', 'LLM', 'model']
    .every(n => CODE_CORE.indexOf(n) < 0));
check('A10.noPlanner',
  ['planner', 'Planner', 'plannerId', 'plan('].every(n => CODE_CORE.indexOf(n) < 0));
check('A11.noAction',
  ['createAction', 'actionId', 'execute', 'executor', 'Executor', 'runAction', 'performAction']
    .every(n => CODE_CORE.indexOf(n) < 0));

/* ── A12 no autonomy / no authority ───────────────────────────────── */
check('A12.noAutonomy',
  ['autonomy', 'Autonomy', 'autonomy-core', 'AUTONOMY'].every(n => CODE_CORE.indexOf(n) < 0)
  && SRC.indexOf("require('./autonomy-core.js')") < 0);
check('A13.noAuthority',
  ['Authority', 'permission', 'decide(', 'runMomentMutation', 'runDiaryWrite', 'runActiveMessageSend']
    .every(n => CODE_CORE.indexOf(n) < 0));

/* ── A14 no persistence / no queue / no scheduler / no bus ────────── */
check('A14.noPersistence',
  ['dbPut', 'dbGet', 'indexedDB', 'localStorage', 'sessionStorage', 'persist', 'store', 'cache', 'history']
    .every(n => CODE_CORE.indexOf(n) < 0) && SRC.indexOf('IntentStore') < 0);
check('A15.noQueue',
  ['queue', 'enqueue', 'dequeue', 'pending', 'backlog', 'waitingList'].every(n => CODE_CORE.indexOf(n) < 0));
check('A16.noScheduler',
  ['setTimeout', 'setInterval', 'schedule', 'tick', 'backoff', 'retry', 'cron'].every(n => CODE_CORE.indexOf(n) < 0));
check('A17.noEventBus',
  ['subscribe', 'EventBus', 'emit', 'listener', 'dispatch', 'publish', 'router', 'Bus', 'consume']
    .every(n => CODE_CORE.indexOf(n) < 0));

/* ── A18 no state（§7：优先 no state）─────────────────────────────── */
check('A18.noState',
  I.ALLOWED_FIELDS.indexOf('status') < 0 && I.ALLOWED_FIELDS.indexOf('state') < 0
  && ['created', 'consumed', 'expired'].every(s => I.ALLOWED_FIELDS.indexOf(s) < 0)
  && CODE_CORE.indexOf('status') < 0);

/* ── A19 no escape hatch / secret safety / serialization ──────────── */
check('A19.noEscapeHatch',
  I.validateActivationIntent({ activationIntentId: 'ai_x', wakeRequestId: 'wr_x', feedbackId: 'fb_x',
    domain: 'd', source: 'a.b', reason: 'r', version: 'activation-intent/v1', payload: 'x' })
    .errors.some(x => x.indexOf('forbidden-body-field') === 0)
  && ['metadata', 'payload', 'content', 'state', 'priority', 'urgency', 'retry'].every(f => {
    const obj = { activationIntentId: 'ai_x', wakeRequestId: 'wr_x', feedbackId: 'fb_x', domain: 'd',
      source: 'a.b', reason: 'r', version: 'activation-intent/v1' };
    obj[f] = 'x';
    const r = I.validateActivationIntent(obj);
    return r.ok === false && r.errors.some(x => x.indexOf('forbidden-body-field') === 0 || x.indexOf('policy-only-field') === 0);
  })
  && I.createActivationIntent(p1.rt, p1.req, { unknownOpt: 'x' }).errors.some(x => x.indexOf('unknown-option') === 0)
  && I.validateActivationIntent({ activationIntentId: 'ai_x', wakeRequestId: 'wr_x',
    feedbackId: 'sk-abcdefgh1234', domain: 'd', source: 'a.b', reason: 'r', version: 'activation-intent/v1' })
    .errors.indexOf('secret-in-activation-intent') >= 0
  && JSON.stringify(a1).indexOf('sk-') < 0
  && JSON.stringify(JSON.parse(JSON.stringify(a1))) === JSON.stringify(a1)
  && I.describeActivationIntent(a1.activationIntent).activationIntentId === a1.activationIntent.activationIntentId
  && I.describeActivationIntent({ activationIntentId: 'ai_x', wakeRequestId: 'wr_x', feedbackId: 'fb_x',
    domain: 'd', source: 'a.b', reason: 'r', version: 'activation-intent/v1', payload: 'x' })
    .rejectedFields.indexOf('payload') >= 0);

/* ── A20 生产非接线：Production activation intent = 0 ─────────────── */
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
  if (/IBActivationIntent|activation-intent-core|createActivationIntent|validateActivationIntent|describeActivationIntent/.test(src)) consumerHits.push(file);
}
check('A20.productionActivationIntentZero',
  consumerHits.length === 0 && exists('assets/js/activation-intent-core.js')
  && read('InternalBeyond.html').indexOf('activation-intent-core.js') < 0,
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
  && ['activationIntent', 'activationIntents', 'intentStore', 'activationHistory', 'wakeRuntime',
    'wakeRequests', 'wakeHistory', 'agentWake', 'signals'].every(s => storeList.indexOf("'" + s + "'") < 0),
  storeList.slice(-140));

/* ── 小 surface（§14：三个函数即可）──────────────────────────────── */
const apiKeys = Object.keys(I).filter(k => typeof I[k] === 'function').sort();
check('G3.smallPureApiSurface',
  JSON.stringify(apiKeys) === JSON.stringify(['createActivationIntent', 'describeActivationIntent', 'validateActivationIntent'])
  && CODE_CORE.indexOf('ActivationManager') < 0 && CODE_CORE.indexOf('ActivationService') < 0
  && CODE_CORE.indexOf('PolicyEngine') < 0,
  apiKeys);

console.log('\n' + (failed
  ? 'P26-9 Activation Intent Core FAILED: ' + failed + ' failed / ' + passed + ' passed'
  : 'P26-9 Activation Intent Core passed \u2714 (' + passed + ' checks, production activation intent = 0)'));
process.exitCode = failed ? 1 : 0;
