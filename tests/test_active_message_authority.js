'use strict';

/* Internal Beyond · P25-3C · Active Message Authority 测试（AM1–AM18；纯 Node、零浏览器、零网络）

   Active Message Authority 是主动消息**发送**权限的唯一权威（assets/js/active-message-authority.js）。
   本套件证明四件事：
     ① 决策只取决于闭集 facts，且顺序严格是
        invalid-candidate → unknown-actor → unknown-target → cancelled → disabled →
        quiet-hours → cooldown → duplicate → allow（缺任何关键事实一律 DENY）；
     ② 模块自身纯净：零 DB / DOM / 模型 / Memory / Middle Brain / Notification / TTS /
        秘密 / CoT / 时钟 / 定时器；
     ③ domain 的既有行为（免打扰 / 冷却 / 去重 / 频率 / 单一 canonical writer）**没有被改写**；
     ④ verifier 只验证 canonical message 存在，绝不补发、绝不 retry。

   本套件不产生任何 production side effect（executor / reader 全部注入）。 */

const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const stripComments = src => String(src).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const A = require(path.join(ROOT, 'assets/js/active-message-authority.js'));
const ASRC = stripComments(read('assets/js/active-message-authority.js'));
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
function hasReasoningKey(value, depth) {
  if (!value || typeof value !== 'object' || (depth || 0) > 4) return false;
  return Object.keys(value).some(k => REASONING.test(k) || hasReasoningKey(value[k], (depth || 0) + 1));
}
const countOcc = (src, needle) => String(src).split(needle).length - 1;
const GOOD_FACTS = { actorKnown: true, targetKnown: true, cancelled: false, enabled: true,
  quietHours: false, cooldown: false, duplicate: false };
const GOOD_INPUT = { actorId: 'role_a', targetId: 'user_1', source: 'schedule', trigger: 'schedule', triggerRef: 'active_run_1' };
const MESSAGE = { id: 'active_msg_setting_1', friendId: 'role_a', content: '今天想和你说件小事。', source: 'active_message' };

console.log('== P25-3C · Active Message Authority 测试 ==');

/* ── AM1 valid candidate ────────────────────────────────────────────── */
const built = A.buildActiveMessageCandidate(Object.assign({ messageRef: 'active_msg_setting_1' }, GOOD_INPUT));
check('AM1.validCandidate', built.ok === true && built.errors.length === 0
  && built.candidate.actorId === 'role_a' && built.candidate.targetId === 'user_1'
  && built.candidate.source === 'schedule' && built.candidate.trigger === 'schedule'
  && /^amc_[A-Za-z0-9]+$/.test(built.candidate.candidateId), built);

/* ── AM2 invalid candidate denied ───────────────────────────────────── */
const malformed = A.buildActiveMessageCandidate({ actorId: '', targetId: '', source: 'nope', trigger: '' });
const malformedVerdict = A.decideActiveMessageSend({ candidateId: '', actorId: '', targetId: '', source: '' }, GOOD_FACTS);
check('AM2.malformedCandidateDenied', malformed.ok === false
  && malformed.errors.indexOf('missing-actor-id') >= 0 && malformed.errors.indexOf('missing-target-id') >= 0
  && malformed.errors.indexOf('bad-source') >= 0 && malformedVerdict.decision === 'deny'
  && malformedVerdict.reason === 'invalid-candidate', malformed);

/* ── AM3 unknown actor ─────────────────────────────────────────────── */
check('AM3.unknownActorDenied',
  A.decideActiveMessageSend(built.candidate, Object.assign({}, GOOD_FACTS, { actorKnown: false })).reason === 'unknown-actor'
  && A.decideActiveMessageSend(built.candidate, { targetKnown: true, enabled: true }).reason === 'unknown-actor');

/* ── AM4 unknown target ────────────────────────────────────────────── */
check('AM4.unknownTargetDenied',
  A.decideActiveMessageSend(built.candidate, Object.assign({}, GOOD_FACTS, { targetKnown: false })).reason === 'unknown-target'
  && A.decideActiveMessageSend(built.candidate, {}).decision === 'deny');

/* ── AM5 disabled ──────────────────────────────────────────────────── */
check('AM5.disabledDenied',
  A.decideActiveMessageSend(built.candidate, Object.assign({}, GOOD_FACTS, { enabled: false })).reason === 'disabled'
  && A.decideActiveMessageSend(built.candidate, Object.assign({}, GOOD_FACTS, { cancelled: true })).reason === 'cancelled'
  && A.decideActiveMessageSend(built.candidate, GOOD_FACTS).decision === 'allow');

/* ── AM6 quiet hours ───────────────────────────────────────────────── */
check('AM6.quietHoursDenied',
  A.decideActiveMessageSend(built.candidate, Object.assign({}, GOOD_FACTS, { quietHours: true })).reason === 'quiet-hours');

/* ── AM7 cooldown ──────────────────────────────────────────────────── */
check('AM7.cooldownDenied',
  A.decideActiveMessageSend(built.candidate, Object.assign({}, GOOD_FACTS, { cooldown: true })).reason === 'cooldown');

/* ── AM8 duplicate ─────────────────────────────────────────────────── */
check('AM8.duplicateDenied',
  A.decideActiveMessageSend(built.candidate, Object.assign({}, GOOD_FACTS, { duplicate: true })).reason === 'duplicate');

/* ── 判定顺序（§11）：靠前的 gate 永远先赢 ───────────────────────────── */
const allBad = { actorKnown: false, targetKnown: false, cancelled: true, enabled: false,
  quietHours: true, cooldown: true, duplicate: true };
check('AM8b.decisionOrderIsStable',
  A.decideActiveMessageSend(built.candidate, allBad).reason === 'unknown-actor'
  && A.decideActiveMessageSend(built.candidate, Object.assign({}, allBad, { actorKnown: true })).reason === 'unknown-target'
  && A.decideActiveMessageSend(built.candidate, Object.assign({}, allBad, { actorKnown: true, targetKnown: true })).reason === 'cancelled'
  && A.decideActiveMessageSend(built.candidate, Object.assign({}, allBad, { actorKnown: true, targetKnown: true, cancelled: false })).reason === 'disabled'
  && A.decideActiveMessageSend(built.candidate, Object.assign({}, allBad, { actorKnown: true, targetKnown: true, cancelled: false, enabled: true })).reason === 'quiet-hours'
  && A.decideActiveMessageSend(built.candidate, Object.assign({}, allBad, { actorKnown: true, targetKnown: true, cancelled: false, enabled: true, quietHours: false })).reason === 'cooldown'
  && A.decideActiveMessageSend(built.candidate, Object.assign({}, allBad, { actorKnown: true, targetKnown: true, cancelled: false, enabled: true, quietHours: false, cooldown: false })).reason === 'duplicate',
  A.decideActiveMessageSend(built.candidate, allBad));

/* ── 无 DEFER（§11）：闭集只有 allow / deny ─────────────────────────── */
check('AM8c.noDeferInDecisionSet',
  JSON.stringify(A.ACTIVE_MESSAGE_DECISIONS) === JSON.stringify({ ALLOW: 'allow', DENY: 'deny' })
  && ASRC.indexOf('defer') < 0 && A.ACTIVE_MESSAGE_REASONS.indexOf('deferred') < 0);

(async () => {
  /* ── AM9 allow executor once ───────────────────────────────────────── */
  let allowCalls = 0;
  const allowRun = await A.runActiveMessageSend(GOOD_INPUT, GOOD_FACTS, async () => { allowCalls++; return { ok: true, message: MESSAGE }; });
  check('AM9.allowRunsExecutorOnce',
    allowRun.decision === 'allow' && allowRun.ok === true && allowRun.executed === true && allowCalls === 1
    && allowRun.message === MESSAGE && allowRun.actorId === 'role_a' && allowRun.targetId === 'user_1', allowRun);

  /* ── AM10 deny executor zero ───────────────────────────────────────── */
  let denyCalls = 0;
  const denyExecutor = async () => { denyCalls++; return { ok: true, message: MESSAGE }; };
  const denyQuiet = await A.runActiveMessageSend(GOOD_INPUT, Object.assign({}, GOOD_FACTS, { quietHours: true }), denyExecutor);
  const denyCooldown = await A.runActiveMessageSend(GOOD_INPUT, Object.assign({}, GOOD_FACTS, { cooldown: true }), denyExecutor);
  const denyDup = await A.runActiveMessageSend(GOOD_INPUT, Object.assign({}, GOOD_FACTS, { duplicate: true }), denyExecutor);
  const denyNoFn = await A.runActiveMessageSend(GOOD_INPUT, GOOD_FACTS, null);
  check('AM10.denyRunsExecutorZeroTimes',
    denyCalls === 0 && denyQuiet.executed === false && denyCooldown.executed === false && denyDup.executed === false
    && denyQuiet.message === null && denyNoFn.reason === 'no-executor',
    { calls: denyCalls, quiet: denyQuiet.reason, cooldown: denyCooldown.reason, dup: denyDup.reason });

  /* ── AM11 executor failure ≠ DENY ──────────────────────────────────── */
  const thrown = await A.runActiveMessageSend(GOOD_INPUT, GOOD_FACTS, async () => { throw new Error('chat store exploded'); });
  const failedFlag = await A.runActiveMessageSend(GOOD_INPUT, GOOD_FACTS, async () => ({ ok: false, error: 'write-failed' }));
  check('AM11.executorFailureIsNotDeny',
    thrown.decision === 'allow' && thrown.executed === true && thrown.ok === false && thrown.error === 'chat store exploded'
    && failedFlag.decision === 'allow' && failedFlag.ok === false && failedFlag.error === 'write-failed',
    { thrown: thrown, failedFlag: failedFlag });

  /* ── verifier（§19）：只验证 canonical message ─────────────────────── */
  const rows = { active_msg_setting_1: MESSAGE };
  let reads = 0;
  const verified = await A.verifyActiveMessageSend(allowRun, async id => { reads++; return rows[id] || null; });
  const missing = await A.verifyActiveMessageSend(allowRun, async () => null);
  const fake = await A.verifyActiveMessageSend({ status: 'completed', ok: true, messageId: 'active_msg_ghost', actorId: 'role_a' }, async () => null);
  const wrongActor = await A.verifyActiveMessageSend(allowRun, async () => ({ id: 'active_msg_setting_1', friendId: 'someone_else', source: 'active_message' }));
  const notActive = await A.verifyActiveMessageSend(allowRun, async () => ({ id: 'active_msg_setting_1', friendId: 'role_a', source: 'manual' }));
  const deniedVerify = await A.verifyActiveMessageSend(denyQuiet, async () => rows.active_msg_setting_1);
  const noVerifier = await A.verifyActiveMessageSend(allowRun, null);
  check('AM9b.verifierChecksCanonicalMessage',
    verified.verified === true && verified.messageId === 'active_msg_setting_1' && reads === 1
    && missing.errorCode === 'canonical-message-missing' && fake.verified === false
    && wrongActor.errorCode === 'identity-mismatch' && notActive.errorCode === 'not-an-active-message'
    && deniedVerify.errorCode === 'not-completed' && noVerifier.errorCode === 'verifier-missing',
    { verified: verified, missing: missing, wrongActor: wrongActor, notActive: notActive });

  /* ── AM12 model != permission ──────────────────────────────────────── */
  const modelSaysSend = Object.assign({}, built.candidate, {
    content: '模型写好的正文', modelWantsSend: true, confidence: 0.99, generatedByFallback: false
  });
  const decideBody = ASRC.slice(ASRC.indexOf('function decideActiveMessageSend('), ASRC.indexOf('async function runActiveMessageSend('));
  check('AM12.modelOutputIsNotPermission',
    A.decideActiveMessageSend(modelSaysSend, Object.assign({}, GOOD_FACTS, { quietHours: true })).decision === 'deny'
    && A.decideActiveMessageSend(modelSaysSend, {}).decision === 'deny'
    && A.decideActiveMessageSend(modelSaysSend, GOOD_FACTS).decision === 'allow'
    && ASRC.indexOf('modelWantsSend') < 0 && ASRC.indexOf('confidence') < 0
    /* 决策函数完全不认识正文：content / draft / generatedByFallback 都不参与判定 */
    && decideBody.length > 0 && decideBody.indexOf('content') < 0 && decideBody.indexOf('draft') < 0
    && decideBody.indexOf('generatedByFallback') < 0, decideBody.slice(0, 60));

  /* ── AM13 scheduler trigger != permission ──────────────────────────── */
  const scheduled = A.buildActiveMessageCandidate({ actorId: 'role_a', targetId: 'user_1', source: 'schedule', trigger: 'schedule', triggerRef: 'active_run_9' });
  const planTriggered = A.buildActiveMessageCandidate({ actorId: 'role_a', targetId: 'user_1', source: 'plan', trigger: 'ai_plan', triggerRef: 'proactive_9' });
  const manualTriggered = A.buildActiveMessageCandidate({ actorId: 'role_a', targetId: 'user_1', source: 'user', trigger: 'manual', triggerRef: '' });
  const companionMirror = A.buildActiveMessageCandidate({ actorId: 'role_a', targetId: 'user_1', source: 'companion', trigger: 'companion', triggerRef: 'active_run_9' });
  check('AM13.schedulerTriggerIsNotPermission',
    scheduled.ok === true && planTriggered.ok === true && manualTriggered.ok === true && companionMirror.ok === true
    && A.decideActiveMessageSend(scheduled.candidate, {}).decision === 'deny'
    && A.decideActiveMessageSend(planTriggered.candidate, { actorKnown: true }).decision === 'deny'
    && ASRC.indexOf('next_run_at') < 0 && ASRC.indexOf('scheduledFor') < 0 && ASRC.indexOf('scheduledAt') < 0);

  /* ── AM14–AM16 纯度（源码守卫；注释先剥离）──────────────────────────── */
  const purity = {
    db: ['dbPut', 'dbGet', 'dbDelete', 'indexedDB', 'chatMessages', 'active_message_history', 'localStorage'],
    dom: ['document', 'getElementById', 'createElement', 'window.', 'navigator', 'toast('],
    model: ['callApiChat', 'fetch(', 'runtime.execute', 'IB.runtime', 'resolveModel', 'streaming'],
    memory: ['memories', 'memoryCandidate', 'IBMemory', 'memory-store', 'updateMemDashboard'],
    brain: ['_mbSideEffectGate', '_execMemOps', 'middleBrain', 'MiddleBrain', '_MB_SEC'],
    delivery: ['Notification', 'tts', 'TTS']
  };
  const hits = key => purity[key].filter(n => ASRC.indexOf(n) >= 0);
  check('AM14.authorityHasNoDatabaseAccess', hits('db').length === 0, hits('db'));
  check('AM15.authorityHasNoMemoryIntegration', hits('memory').length === 0, hits('memory'));
  check('AM16.authorityHasNoMiddleBrainIntegration', hits('brain').length === 0, hits('brain'));
  check('AM16b.authorityHasNoDeliverySideEffects',
    hits('dom').length === 0 && hits('model').length === 0 && hits('delivery').length === 0,
    { dom: hits('dom'), model: hits('model'), delivery: hits('delivery') });

  /* ── AM17 no secret ────────────────────────────────────────────────── */
  const secretCandidate = A.buildActiveMessageCandidate({ actorId: 'role_a', targetId: 'user_1', source: 'schedule', trigger: 'schedule', contextRef: 'sk-abcdefgh1234' });
  const plainCandidate = A.buildActiveMessageCandidate({ actorId: 'role_a', targetId: 'user_1', source: 'schedule', trigger: 'schedule', contextRef: '今天想和你说件小事' });
  const secretKeys = ['apiKey', 'authorization', 'credential', 'provider', 'systemPrompt'];
  const leaky = secretKeys.filter(k => JSON.stringify(allowRun).indexOf('"' + k + '"') >= 0);
  check('AM17.noSecretInCandidateOrResult',
    secretCandidate.ok === false && secretCandidate.errors.indexOf('secret-in-candidate') >= 0
    && plainCandidate.ok === true && leaky.length === 0
    && ASRC.indexOf('apiKey') < 0 && ASRC.indexOf('Authorization') < 0, { secretCandidate: secretCandidate, leaky: leaky });

  /* ── AM18 no CoT ──────────────────────────────────────────────────── */
  check('AM18.noChainOfThought',
    !hasReasoningKey(allowRun) && !hasReasoningKey(denyQuiet) && !hasReasoningKey(verified)
    && !REASONING.test(ASRC) && ASRC.indexOf('systemPrompt') < 0 && ASRC.indexOf('messages') < 0);

  /* ── 身份确定性 + 不重新发明消息身份 ──────────────────────────────── */
  const again = A.buildActiveMessageCandidate(Object.assign({ messageRef: 'other_ref' }, GOOD_INPUT));
  const otherTarget = A.buildActiveMessageCandidate(Object.assign({}, GOOD_INPUT, { targetId: 'user_2' }));
  const otherTrigger = A.buildActiveMessageCandidate(Object.assign({}, GOOD_INPUT, { trigger: 'manual', source: 'user' }));
  check('AM18b.identityDeterministic',
    again.candidate.candidateId === built.candidate.candidateId
    && otherTarget.candidate.candidateId !== built.candidate.candidateId
    && otherTrigger.candidate.candidateId !== built.candidate.candidateId
    && ASRC.indexOf('Math.random') < 0 && ASRC.indexOf('Date.now') < 0 && ASRC.indexOf('new Date') < 0
    && built.candidate.candidateId.indexOf('active_msg_') !== 0, built.candidate.candidateId);

  /* ── domain 既有行为未被改写（频率 / 免打扰 / 去重 / 单一 writer）──── */
  check('AM18c.domainPoliciesPreserved',
    ACTIVE.indexOf('const ACTIVE_PROACTIVE_SIMILARITY=0.82;') >= 0
    && ACTIVE.indexOf('const ACTIVE_PROACTIVE_MAX_ATTEMPTS=3;') >= 0
    && ACTIVE.indexOf('function _activeAdaptiveReason(setting){') >= 0
    && ACTIVE.indexOf('function _activeValidateProactiveReply(content,recentProactive){') >= 0
    && ACTIVE.indexOf('function _bgAiGate(){') >= 0
    && ACTIVE.indexOf('async function _activeTick(){') >= 0
    && ACTIVE.indexOf('function _activeSendAuthorized(args){') >= 0
    && PLANS.indexOf('function _activeIsInDnd(nowMs,prefs){') >= 0
    && PLANS.indexOf('const ACTIVE_PLAN_MIN_DELAY_MS=5*60*1000;') >= 0,
    { similarity: ACTIVE.indexOf('const ACTIVE_PROACTIVE_SIMILARITY=0.82;'), dnd: PLANS.indexOf('function _activeIsInDnd(') });

  /* ── 单一 canonical writer（§17）：主动消息域只有一个 chatMessages 写点 ── */
  check('AM18d.singleCanonicalWriter',
    countOcc(ACTIVE, "dbPut('chatMessages'") === 1
    && countOcc(PLANS, "dbPut('chatMessages'") === 0
    && ACTIVE.indexOf("await dbPut('chatMessages',m);") >= 0
    && ACTIVE.indexOf('async function _activeWriteCanonical(msg,opts){') >= 0
    && ACTIVE.indexOf('async function _activeSendAuthorized(args){') >= 0
    && ACTIVE.indexOf('function _activeMessageAuthority(){') >= 0
    && PLANS.indexOf('NS.active') >= 0 && PLANS.indexOf('a.sendAuthorized') >= 0,
    { activeWrites: countOcc(ACTIVE, "dbPut('chatMessages'"), planWrites: countOcc(PLANS, "dbPut('chatMessages'") });

  console.log('\n' + (failed
    ? 'P25-3C Active Message Authority FAILED: ' + failed + ' failed / ' + passed + ' passed'
    : 'P25-3C Active Message Authority passed \u2714 (' + passed + ' checks, 0 side effects)'));
  process.exitCode = failed ? 1 : 0;
})().catch(e => { console.error(e && e.stack || e); process.exitCode = 1; });
