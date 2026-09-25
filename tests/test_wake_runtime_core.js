'use strict';

/* Internal Beyond · P26-8 · Wake Runtime Core 测试（W1–W18 + 生产非接线守卫）

   阶段性质：FOUNDATION / CONTRACT / PURE CORE / AUDIT-FIRST / NO PRODUCTION INTEGRATION。
   允许：新增独立纯模块 assets/js/wake-runtime-core.js。
   禁止：Agent Wake / Model Call / Planner / Action / Autonomy / Authority /
        Queue / Scheduler / Event Bus / Production Consumer。

   零浏览器、零网络、零真实 provider。 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ROOT = path.resolve(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const exists = f => fs.existsSync(path.join(ROOT, f));
const sha = f => crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, f))).digest('hex').toUpperCase();
const stripComments = src => String(src).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const R = require(path.join(ROOT, 'assets/js/wake-runtime-core.js'));
const W = require(path.join(ROOT, 'assets/js/wake-request-core.js'));
const F = require(path.join(ROOT, 'assets/js/feedback-core.js'));
const C = require(path.join(ROOT, 'assets/js/feedback-consumption-core.js'));
const A = require(path.join(ROOT, 'assets/js/autonomy-core.js'));
const SRC = read('assets/js/wake-runtime-core.js');
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
const mkReq = (options) => {
  const fb = mkFb();
  return W.createWakeRequest(C.evaluateFeedbackConsumption(fb, { wakeCapable: true }), fb, options || {}).wakeRequest;
};
const ev = (ctx) => R.evaluateWakeRequest(mkReq(), ctx || {});

console.log('== P26-8 · Wake Runtime Core 测试 ==');

/* ── W1 valid request ─────────────────────────────────────────────── */
const w1 = R.evaluateWakeRequest(mkReq({ causationId: 'evt_abc123' }), { runtimeAvailable: true });
check('W1.validRequest',
  w1.ok === true && w1.activation === 'ACTIVATE_ELIGIBLE' && w1.reason === 'activate-eligible'
  && w1.wakeRequestId === mkReq({ causationId: 'evt_abc123' }).wakeRequestId
  && w1.feedbackId === mkFb().feedbackId
  && w1.causationId === 'evt_abc123'
  && Object.isFrozen(w1) && w1.version === 'wake-runtime/v1'
  && Object.keys(w1).every(k => R.ALLOWED_RESULT_FIELDS.indexOf(k) >= 0), w1);

/* ── W2 invalid request ───────────────────────────────────────────── */
check('W2.invalidRequest',
  R.evaluateWakeRequest(null, { runtimeAvailable: true }).ok === false
  && R.evaluateWakeRequest(null, { runtimeAvailable: true }).activation === 'REJECTED'
  && R.evaluateWakeRequest(null, { runtimeAvailable: true }).reason === 'invalid-request'
  && R.evaluateWakeRequest({ feedbackId: 'x' }, {}).reason === 'invalid-request'
  && R.evaluateWakeRequest(mkFb(), {}).reason === 'invalid-request');

/* ── W3 / W18 deterministic result ────────────────────────────────── */
check('W3.deterministicResult',
  JSON.stringify(ev({ runtimeAvailable: true })) === JSON.stringify(ev({ runtimeAvailable: true }))
  && JSON.stringify(ev({})) === JSON.stringify(ev({})));
check('W18.sameInputSameResult',
  (function () {
    const req = mkReq();
    const a = R.evaluateWakeRequest(req, { runtimeAvailable: true });
    const b = R.evaluateWakeRequest(req, { runtimeAvailable: true });
    return JSON.stringify(a) === JSON.stringify(b) && a !== b;
  })());

/* ── 处置语义：ACTIVATE_ELIGIBLE / BLOCKED / REJECTED（闭集）────────── */
check('W4.activationSemantics',
  ev({ runtimeAvailable: true }).activation === 'ACTIVATE_ELIGIBLE'
  && ev({}).activation === 'BLOCKED' && ev({}).reason === 'runtime-unavailable'
  && ev({ runtimeAvailable: true, alreadyActive: true }).activation === 'BLOCKED'
  && ev({ runtimeAvailable: true, alreadyActive: true }).reason === 'already-active'
  && ev({ runtimeAvailable: true, cancelled: true }).activation === 'REJECTED'
  && ev({ runtimeAvailable: true, cancelled: true }).reason === 'cancelled'
  && ev({ cancelled: true }).reason === 'cancelled');

/* ── W4b no execution / W5 no model / W6 no planner ───────────────── */
check('W4.noExecution',
  ['execute', 'Execute', 'executor', 'Executor', 'runAction', 'performAction', 'triggerAgent', 'invoke(']
    .every(n => CODE_CORE.indexOf(n) < 0)
  && R.ACTIVATIONS.indexOf('EXECUTE') < 0);
check('W5.noModel',
  ['fetch(', 'callApiChat', 'resolveModel', 'provider', 'prompt', 'streaming', 'WebSocket', 'llm', 'LLM', 'model']
    .every(n => CODE_CORE.indexOf(n) < 0));
check('W6.noPlanner',
  ['planner', 'Planner', 'plannerId', 'plan('].every(n => CODE_CORE.indexOf(n) < 0));

/* ── W7 no autonomy / W8 no authority / W9 no executor ────────────── */
check('W7.noAutonomy',
  ['autonomy', 'Autonomy', 'autonomy-core', 'AUTONOMY'].every(n => CODE_CORE.indexOf(n) < 0)
  && SRC.indexOf("require('./autonomy-core.js')") < 0
  && Object.keys(A.AUTONOMY_DECISIONS).every(k =>
    R.ACTIVATIONS.indexOf(k) < 0 && R.ACTIVATIONS.indexOf(A.AUTONOMY_DECISIONS[k].toUpperCase()) < 0)
  /* 原因码可共享（如 cancelled），但激活词汇**不得**复用 P25 的决策词 */
  && R.REASONS.every(r => ['allow', 'deny', 'defer'].indexOf(r) < 0));
check('W8.noAuthority',
  ['Authority', 'permission', 'decide(', 'runMomentMutation', 'runDiaryWrite', 'runActiveMessageSend']
    .every(n => CODE_CORE.indexOf(n) < 0));
check('W9.noExecutor',
  ['createMoment', 'writeDiary', 'sendMessage', 'createActivity', 'capability'].every(n => CODE_CORE.indexOf(n) < 0));

/* ── W10 no queue / W11 no scheduler / W12 no persistence ─────────── */
check('W10.noQueue',
  ['queue', 'enqueue', 'dequeue', 'pending', 'backlog', 'waitingList'].every(n => CODE_CORE.indexOf(n) < 0));
check('W11.noScheduler',
  ['setTimeout', 'setInterval', 'schedule', 'tick', 'backoff', 'retry', 'cron'].every(n => CODE_CORE.indexOf(n) < 0));
check('W12.noPersistence',
  ['dbPut', 'dbGet', 'indexedDB', 'localStorage', 'sessionStorage', 'persist', 'store', 'cache', 'history']
    .every(n => CODE_CORE.indexOf(n) < 0));

/* ── W13 no event bus ─────────────────────────────────────────────── */
check('W13.noEventBus',
  ['subscribe', 'EventBus', 'emit', 'listener', 'dispatch', 'publish', 'router', 'Bus', 'consume']
    .every(n => CODE_CORE.indexOf(n) < 0));

/* ── W14 session read-only / W15 resource read-only ───────────────── */
check('W14.sessionReadOnly',
  ['createSession', 'transitionSession', 'IBSessionCore', 'session-core', 'startSession', 'endSession']
    .every(n => CODE_CORE.indexOf(n) < 0)
  && R.CONTEXT_FIELDS.indexOf('sessionActive') < 0
  && R.validateWakeContext({ sessionActive: true }).errors.some(x => x.indexOf('unknown-field') === 0));
check('W15.resourceReadOnly',
  ['IBResource', 'resource-core', 'evaluateConflict', 'createClaim', 'grant', 'lease', 'lock']
    .every(n => CODE_CORE.indexOf(n) < 0)
  && R.validateWakeContext({ resourceAvailable: true }).errors.some(x => x.indexOf('unknown-field') === 0));

/* ── W16 context explicit（闭集布尔字段，fail closed）──────────────── */
check('W16.contextExplicit',
  JSON.stringify(R.CONTEXT_FIELDS) === JSON.stringify(['runtimeAvailable', 'cancelled', 'alreadyActive'])
  && R.validateWakeContext({}).ok === true
  && R.validateWakeContext({ runtimeAvailable: true }).ok === true
  && R.validateWakeContext({ runtimeAvailable: 'yes' }).errors.indexOf('bad-context-value:runtimeAvailable') >= 0
  && R.validateWakeContext({ unknownThing: true }).errors.some(x => x.indexOf('unknown-field') === 0)
  && R.validateWakeContext(null).errors.indexOf('not-an-object') >= 0);

/* ── W17 activation vocabulary closed ─────────────────────────────── */
check('W17.activationVocabularyClosed',
  JSON.stringify(R.ACTIVATIONS) === JSON.stringify(['ACTIVATE_ELIGIBLE', 'BLOCKED', 'REJECTED'])
  && ['ALLOW', 'DENY', 'EXECUTE'].every(d => R.ACTIVATIONS.indexOf(d) < 0)
  && CODE.indexOf("'ALLOW'") < 0 && CODE.indexOf("'DENY'") < 0 && CODE.indexOf("'EXECUTE'") < 0
  && CODE_CORE.indexOf('ALLOWED_RESULT_FIELDS') >= 0);

/* ── W19 identity audit：不引入 activationId / 无随机/时钟 ────────── */
check('W19.noIdentityNoRandom',
  CODE.indexOf('activationId') < 0
  && Object.keys(w1).indexOf('activationId') < 0
  && ['Math.random', 'randomUUID', 'crypto.random', 'uuid'].every(n => CODE.indexOf(n) < 0)
  && CODE.indexOf('Date.now') < 0 && CODE.indexOf('new Date') < 0 && CODE.indexOf('performance.now') < 0);

/* ── W20 Secret safety / no escape hatch ──────────────────────────── */
check('W20.secretSafety',
  R.validateWakeContext({ metadata: { apiKey: 'sk-abcdefgh1234' } }).errors.some(x => x.indexOf('forbidden-context-field') === 0)
  && R.validateWakeContext({ apiKey: 'sk-abcdefgh1234' }).errors.some(x => x.indexOf('forbidden-context-field') === 0)
  && R.validateWakeContext({ payload: 'sk-abcdefgh1234' }).errors.some(x => x.indexOf('forbidden-context-field') === 0)
  && JSON.stringify(w1).indexOf('sk-') < 0
  && ['apiKey', 'token', 'credential', 'authorization'].every(k => JSON.stringify(w1).indexOf('"' + k + '"') < 0));

/* ── W21 serialization + describe ─────────────────────────────────── */
check('W21.serializableAndDescribe',
  JSON.stringify(JSON.parse(JSON.stringify(w1))) === JSON.stringify(w1)
  && R.describeWakeResult(w1).activation === 'ACTIVATE_ELIGIBLE'
  && R.describeWakeResult(w1).version === 'wake-runtime/v1'
  && R.describeWakeResult(null).errors.length === 0);

/* ── W22 validation delegated to P26-7（唯一实现）──────────────────── */
check('W22.requestValidationDelegated',
  SRC.indexOf("require('./wake-request-core.js')") >= 0
  && SRC.indexOf('validateWakeRequest') >= 0
  && CODE_CORE.indexOf('createWakeRequest') < 0);

/* ── W23 生产非接线：Production wake runtime = 0 ──────────────────── */
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
  if (/IBWakeRuntime|wake-runtime-core|evaluateWakeRequest|validateWakeContext|describeWakeResult/.test(src)) consumerHits.push(file);
}
check('W23.productionWakeRuntimeZero',
  consumerHits.length === 0 && exists('assets/js/wake-runtime-core.js')
  && read('InternalBeyond.html').indexOf('wake-runtime-core.js') < 0,
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
  && ['wakeRuntime', 'wakeState', 'activationHistory', 'wakeDatabase', 'wakeRequests', 'wakeHistory',
    'attentionQueue', 'agentWake', 'signals'].every(s => storeList.indexOf("'" + s + "'") < 0),
  storeList.slice(-140));

/* ── 小 surface（§17：三个函数即可）──────────────────────────────── */
const apiKeys = Object.keys(R).filter(k => typeof R[k] === 'function').sort();
check('G3.smallPureApiSurface',
  JSON.stringify(apiKeys) === JSON.stringify(['describeWakeResult', 'evaluateWakeRequest', 'validateWakeContext'])
  && CODE_CORE.indexOf('WakeManager') < 0 && CODE_CORE.indexOf('WakeService') < 0
  && CODE_CORE.indexOf('ActivationScheduler') < 0 && CODE_CORE.indexOf('PolicyEngine') < 0,
  apiKeys);

console.log('\n' + (failed
  ? 'P26-8 Wake Runtime Core FAILED: ' + failed + ' failed / ' + passed + ' passed'
  : 'P26-8 Wake Runtime Core passed \u2714 (' + passed + ' checks, production wake runtime = 0)'));
process.exitCode = failed ? 1 : 0;
