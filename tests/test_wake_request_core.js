'use strict';

/* Internal Beyond · P26-7 · Wake Request Core 测试（W1–W20 + 生产非接线守卫）

   阶段性质：FOUNDATION / CONTRACT / PURE CORE / AUDIT-FIRST / NO PRODUCTION INTEGRATION。
   允许：新增独立纯模块 assets/js/wake-request-core.js。
   禁止：Wake Runtime / Wake Queue / Agent Wake / Event Bus / Scheduler /
        Production Consumer / Capability Selection / Action Creation。

   零浏览器、零网络、零真实 provider。 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ROOT = path.resolve(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const exists = f => fs.existsSync(path.join(ROOT, f));
const sha = f => crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, f))).digest('hex').toUpperCase();
const stripComments = src => String(src).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const W = require(path.join(ROOT, 'assets/js/wake-request-core.js'));
const F = require(path.join(ROOT, 'assets/js/feedback-core.js'));
const C = require(path.join(ROOT, 'assets/js/feedback-consumption-core.js'));
const SRC = read('assets/js/wake-request-core.js');
const CODE = stripComments(SRC);
/* 拒绝清单数组本身包含 priority / content 等词 —— 那是**拒绝**它们的证据，先摘掉（与 P26-1..6 同一策略）。 */
const CODE_CORE = CODE
  .replace(/var RESERVED_BODY_FIELDS = Object\.freeze\(\[[\s\S]*?\]\);/, '')
  .replace(/var POLICY_ONLY_FIELDS = Object\.freeze\(\[[\s\S]*?\]\);/, '');

let passed = 0, failed = 0;
const failures = [];
function check(name, cond, extra) {
  if (cond) { passed++; console.log('  \u2714 ' + name); }
  else { failed++; failures.push(name); console.log('  \u2716 ' + name + (extra === undefined ? '' : '  -> ' + JSON.stringify(extra).slice(0, 320))); }
}
const T = 1770000000001;
const mkFb = (patch) => F.createFeedback(Object.assign({ domain: 'cinema', source: 'cinema.runtime',
  reason: 'user-request-needs-attention' }, patch || {}), { timestamp: T }).feedback;
const eligible = (fb) => C.evaluateFeedbackConsumption(fb, { wakeCapable: true });
const mkReq = (patch, options) => {
  const fb = mkFb(patch);
  return W.createWakeRequest(eligible(fb), fb, options || {});
};

console.log('== P26-7 · Wake Request Core 测试 ==');

/* ── W1 valid request ─────────────────────────────────────────────── */
const w1fb = mkFb();
const w1 = W.createWakeRequest(eligible(w1fb), w1fb, { causationId: 'evt_abc123' });
check('W1.validRequest',
  w1.ok === true && w1.errors.length === 0
  && w1.wakeRequest.feedbackId === w1fb.feedbackId
  && w1.wakeRequest.domain === 'cinema' && w1.wakeRequest.source === 'cinema.runtime'
  && w1.wakeRequest.reason === 'user-request-needs-attention'
  && w1.wakeRequest.createdFrom === 'consumption'
  && w1.wakeRequest.causationId === 'evt_abc123'
  && w1.wakeRequest.version === 'wake-request/v1'
  && Object.isFrozen(w1.wakeRequest)
  && W.validateWakeRequest(w1.wakeRequest).ok === true, w1);

/* ── W2 invalid feedback reference / not eligible / mismatch ──────── */
check('W2.invalidFeedbackReference',
  W.createWakeRequest(eligible(mkFb()), null, {}).ok === false
  && W.createWakeRequest(eligible(mkFb()), null, {}).errors.indexOf('invalid-feedback') >= 0
  && W.createWakeRequest(eligible(mkFb()), { domain: 'cinema' }, {}).errors.indexOf('invalid-feedback') >= 0
  /* 未经 Consumption（disposition ≠ WAKE_ELIGIBLE）⇒ not-eligible */
  && W.createWakeRequest(C.evaluateFeedbackConsumption(mkFb(), {}), mkFb(), {}).ok === false
  && W.createWakeRequest(C.evaluateFeedbackConsumption(mkFb(), {}), mkFb(), {}).errors.indexOf('not-eligible') >= 0
  /* 不能绕过 Consumption：把裸 feedback 当第一参数 ⇒ not-eligible */
  && (function () { const fb = mkFb(); return W.createWakeRequest(fb, fb, {}).errors.indexOf('not-eligible') >= 0; })()
  /* feedback 与 consumption 身份不一致 ⇒ feedback-mismatch */
  && (function () {
    const a = mkFb(), b = mkFb({ relatedEntity: 'other-thing' });
    return W.createWakeRequest(eligible(a), b, {}).errors.indexOf('feedback-mismatch') >= 0;
  })());

/* ── W3 deterministic id ──────────────────────────────────────────── */
check('W3.deterministicId',
  mkReq().wakeRequest.wakeRequestId === mkReq().wakeRequest.wakeRequestId
  && mkReq().wakeRequest.wakeRequestId.indexOf('wr_') === 0
  /* 注入优先 */
  && mkReq({}, { wakeRequestId: 'wr_injected_1' }).wakeRequest.wakeRequestId === 'wr_injected_1'
  && W.validateWakeRequest({ wakeRequestId: '', feedbackId: 'fb_x', domain: 'd', source: 'a.b',
    reason: 'r', createdFrom: 'consumption', version: 'wake-request/v1' }).errors.indexOf('missing-wake-request-id') >= 0);

/* ── W4 immutable input ───────────────────────────────────────────── */
check('W4.immutableInput',
  (function () {
    const fb = mkFb();
    const cons = eligible(fb);
    const fbBefore = JSON.stringify(fb), consBefore = JSON.stringify(cons);
    const res = W.createWakeRequest(cons, fb, {});
    return JSON.stringify(fb) === fbBefore && JSON.stringify(cons) === consBefore
      && res.wakeRequest !== fb && res.wakeRequest !== cons
      && Object.isFrozen(fb) && Object.isFrozen(cons) && res.ok === true;
  })());

/* ── W5 / W6 no random / no clock ─────────────────────────────────── */
check('W5.noRandom', ['Math.random', 'randomUUID', 'crypto.random', 'uuid'].every(n => CODE.indexOf(n) < 0));
check('W6.noClock', ['Date.now', 'new Date', 'performance.now'].every(n => CODE.indexOf(n) < 0));

/* ── W7 / W8 no queue / no scheduler ──────────────────────────────── */
check('W7.noQueue',
  ['queue', 'enqueue', 'dequeue', 'pending', 'backlog', 'waitingList', 'pendingRequests']
    .every(n => CODE_CORE.indexOf(n) < 0) && SRC.indexOf('WakeQueue') < 0);
check('W8.noScheduler',
  ['setTimeout', 'setInterval', 'schedule', 'tick', 'backoff', 'retry'].every(n => CODE_CORE.indexOf(n) < 0));

/* ── W9 no runtime wake ───────────────────────────────────────────── */
check('W9.noRuntimeWake',
  ['triggerAgent', 'activateAgent', 'startAgent', 'wake(', 'doWake', 'dispatch']
    .every(n => CODE_CORE.indexOf(n) < 0)
  /* 只产出对象，任何 "激活" 语义都不存在 */
  && CODE_CORE.indexOf('WAKE_ELIGIBLE') >= 0);

/* ── W10–W14 no model / planner / autonomy / authority / executor ─── */
check('W10.noModel',
  ['fetch(', 'callApiChat', 'resolveModel', 'provider', 'prompt', 'streaming', 'WebSocket', 'llm', 'LLM']
    .every(n => CODE_CORE.indexOf(n) < 0));
check('W11.noPlanner',
  ['planner', 'Planner', 'plannerId', 'plan('].every(n => CODE_CORE.indexOf(n) < 0));
check('W12.noAutonomy',
  ['autonomy', 'Autonomy', 'autonomy-core', 'AUTONOMY'].every(n => CODE_CORE.indexOf(n) < 0)
  && SRC.indexOf("require('./autonomy-core.js')") < 0);
check('W13.noAuthority',
  ['Authority', 'permission', 'decide(', 'runMomentMutation', 'runDiaryWrite', 'runActiveMessageSend']
    .every(n => CODE_CORE.indexOf(n) < 0));
check('W14.noExecutor',
  ['executor', 'Executor', 'createMoment', 'writeDiary', 'sendMessage', 'createActivity']
    .every(n => CODE_CORE.indexOf(n) < 0));

/* ── W15 / W16 no persistence / no event bus ──────────────────────── */
check('W15.noPersistence',
  ['dbPut', 'dbGet', 'indexedDB', 'localStorage', 'sessionStorage', 'persist', 'store', 'cache', 'history']
    .every(n => CODE_CORE.indexOf(n) < 0) && SRC.indexOf('WakeRequestStore') < 0);
check('W16.noEventBus',
  ['subscribe', 'EventBus', 'emit', 'listener', 'dispatch', 'publish', 'router', 'Bus', 'consume']
    .every(n => CODE_CORE.indexOf(n) < 0));

/* ── W17 no priority / W18 no cooldown state ──────────────────────── */
check('W17.noPriority',
  ['priority', 'urgency', 'rank', 'deadline'].every(n => CODE_CORE.indexOf(n) < 0)
  && W.ALLOWED_FIELDS.indexOf('priority') < 0 && W.ALLOWED_FIELDS.indexOf('urgency') < 0
  && W.validateWakeRequest({ wakeRequestId: 'wr_x', feedbackId: 'fb_x', domain: 'd', source: 'a.b',
    reason: 'r', createdFrom: 'consumption', version: 'wake-request/v1', priority: 'high' })
    .errors.some(x => x.indexOf('policy-only-field') === 0));
check('W18.noCooldownState',
  ['cooldown', 'setTimeout', 'setInterval', 'lastWake'].every(n => CODE_CORE.indexOf(n) < 0)
  && W.OPTION_FIELDS.indexOf('cooldown') < 0);

/* ── W19 no duplicate store（caller 提供 alreadyRequested）─────────── */
check('W19.noDuplicateStore',
  CODE_CORE.indexOf('Store') < 0 && CODE_CORE.indexOf('Set(') < 0
  && CODE_CORE.indexOf('class ') < 0
  && SRC.indexOf('dedupeStore') < 0
  && mkReq({}, { alreadyRequested: true }).errors.indexOf('already-requested') >= 0
  && mkReq({}, { alreadyRequested: true }).ok === false
  /* 不观察 alreadyRequested 时，结果与第一次完全相同（Core 不持有状态） */
  && JSON.stringify(mkReq()) === JSON.stringify(mkReq()));

/* ── W20 same input same result ───────────────────────────────────── */
check('W20.sameInputSameResult',
  (function () {
    const fb = mkFb();
    const cons = eligible(fb);
    const a = W.createWakeRequest(cons, fb, {}), b = W.createWakeRequest(cons, fb, {});
    return JSON.stringify(a) === JSON.stringify(b) && a.wakeRequest !== b.wakeRequest
      && a.wakeRequest.wakeRequestId === b.wakeRequest.wakeRequestId;
  })());

/* ── Consumption 词汇表权威（不复制第二份）────────────────────────── */
check('W21.consumptionVocabularyAuthority',
  W.ELIGIBLE_DISPOSITION === 'WAKE_ELIGIBLE'
  && Array.isArray(C.DISPOSITIONS) && C.DISPOSITIONS.indexOf('WAKE_ELIGIBLE') >= 0
  && W.DISPOSITIONS === C.DISPOSITIONS
  && SRC.indexOf("require('./feedback-consumption-core.js')") >= 0
  && SRC.indexOf("require('./feedback-core.js')") >= 0);

/* ── Serialization / secret safety / describe ─────────────────────── */
check('W22.serializableAndDescribe',
  JSON.stringify(JSON.parse(JSON.stringify(w1))) === JSON.stringify(w1)
  && W.describeWakeRequest({ wakeRequestId: 'wr_x', feedbackId: 'fb_x', domain: 'd', source: 'a.b',
    reason: 'r', createdFrom: 'consumption', version: 'wake-request/v1', payload: 'sk-abcdefgh1234' })
    .rejectedFields.indexOf('payload') >= 0
  && W.validateWakeRequest({ wakeRequestId: 'wr_x', feedbackId: 'sk-abcdefgh1234', domain: 'd',
    source: 'a.b', reason: 'r', createdFrom: 'consumption', version: 'wake-request/v1' })
    .errors.indexOf('secret-in-wake-request') >= 0
  && JSON.stringify(w1).indexOf('sk-') < 0);

/* ── 生产非接线：Production wake request = 0 ──────────────────────── */
const CANDIDATES = [
  'assets/js/active-diary.js', 'assets/js/active-diary/diary.js', 'assets/js/role-letters.js',
  'assets/js/moments.js', 'assets/js/activity/activity-runtime.js', 'apps/ib-app-cinema.js',
  'assets/js/communication/voice.js', 'assets/js/group-runtime-core.js',
  'assets/js/middle-brain.js', 'assets/js/agent-runtime.js', 'assets/js/autonomy-core.js',
  'assets/js/agent-orchestration-core.js', 'assets/js/communication.js'
];
const consumerHits = [];
for (const file of CANDIDATES) {
  if (!exists(file)) continue;
  const src = stripComments(read(file));
  if (/IBWakeRequest|wake-request-core|createWakeRequest|validateWakeRequest|describeWakeRequest/.test(src)) consumerHits.push(file);
}
check('W23.productionWakesZero',
  consumerHits.length === 0 && exists('assets/js/wake-request-core.js')
  /* 生产 HTML 不加载 wake request core（与 P26-1..6 同策略：foundation-only） */
  && read('InternalBeyond.html').indexOf('wake-request-core.js') < 0,
  consumerHits);

/* ── G Guards：foundation 逐字节 + DB 未变 ──────────────────────── */
const FROZEN = {
  'assets/js/domain-event-core.js': ['3D8F339B', '12805562'],
  'assets/js/observation-core.js': ['077DA39B', 'E18ECC3F'],
  'assets/js/session-core.js': ['5778EE01', '2819C529'],
  'assets/js/resource-core.js': ['71318C21', 'EE8A60FA'],
  'assets/js/feedback-core.js': ['6C4A9B10', '436D6129'],
  'assets/js/feedback-consumption-core.js': ['DBBB6F57', 'EBA67714'],
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
  && ['wakeRequests', 'wakeRequest', 'wakeHistory', 'feedbackConsumption', 'attentionQueue',
    'agentWake', 'signals', 'wakeRequestStore'].every(s => storeList.indexOf("'" + s + "'") < 0),
  storeList.slice(-140));

/* ── 小 surface（§18：三个函数即可）──────────────────────────────── */
const apiKeys = Object.keys(W).filter(k => typeof W[k] === 'function').sort();
check('G3.smallPureApiSurface',
  JSON.stringify(apiKeys) === JSON.stringify(['createWakeRequest', 'describeWakeRequest', 'validateWakeRequest'])
  && CODE_CORE.indexOf('WakeManager') < 0 && CODE_CORE.indexOf('WakeService') < 0
  && CODE_CORE.indexOf('WakeQueue') < 0 && CODE_CORE.indexOf('PolicyEngine') < 0,
  apiKeys);

console.log('\n' + (failed
  ? 'P26-7 Wake Request Core FAILED: ' + failed + ' failed / ' + passed + ' passed'
  : 'P26-7 Wake Request Core passed \u2714 (' + passed + ' checks, production wake request = 0)'));
process.exitCode = failed ? 1 : 0;
