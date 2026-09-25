'use strict';

/* Internal Beyond · P25-3D · Role Letter Authority 测试（RL1–RL16；纯 Node、零浏览器、零网络）

   Role Letter Authority 是 Role Letter **写信**权限的唯一权威（assets/js/role-letter-authority.js）。
   本套件证明四件事：
     ① 决策只取决于闭集 facts，顺序严格是
        invalid-candidate → unknown-actor → unknown-recipient → cancelled → disabled →
        cooldown → duplicate → allow（缺任何关键事实一律 DENY）；
     ② 模块自身纯净：零 DB / DOM / 模型 / Memory / Middle Brain / 通知 / 秘密 / CoT / 时钟；
     ③ domain 的既有行为（cadence / 对偶冷却 / 已回已拒 / 单一 canonical writer / 私有记忆命名空间）
        **没有被改写**；
     ④ verifier 只验证 canonical letter 存在，绝不补写、绝不 retry。

   本套件不产生任何 production side effect（executor / reader 全部注入）。 */

const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const stripComments = src => String(src).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const A = require(path.join(ROOT, 'assets/js/role-letter-authority.js'));
const ASRC = stripComments(read('assets/js/role-letter-authority.js'));
const RL_RAW = read('assets/js/role-letters.js');
const RL = stripComments(RL_RAW);

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
const GOOD_FACTS = { actorKnown: true, recipientKnown: true, cancelled: false, enabled: true, cooldown: false, duplicate: false };
const GOOD_INPUT = { actorId: 'role_a', recipientId: 'role_b', source: 'schedule', letterKind: 'init',
  trigger: 'init', triggerRef: 'cadence_role_a' };
const LETTER = { id: 'rletter_1', fromRoleId: 'role_a', toRoleId: 'role_b', kind: 'init', content: '想跟你聊聊海边的那天。' };

console.log('== P25-3D · Role Letter Authority 测试 ==');

/* ── RL1 valid candidate ────────────────────────────────────────────── */
const built = A.buildRoleLetterCandidate(GOOD_INPUT);
check('RL1.validCandidate', built.ok === true && built.errors.length === 0
  && built.candidate.actorId === 'role_a' && built.candidate.recipientId === 'role_b'
  && built.candidate.source === 'schedule' && built.candidate.letterKind === 'init'
  && /^rlc_[A-Za-z0-9]+$/.test(built.candidate.candidateId), built);

/* ── RL2 invalid candidate denied ───────────────────────────────────── */
const malformed = A.buildRoleLetterCandidate({ actorId: '', recipientId: '', source: 'user', trigger: '' });
const malformedVerdict = A.decideRoleLetterWrite({ candidateId: '', actorId: '', recipientId: '', source: '', letterKind: '' }, GOOD_FACTS);
check('RL2.invalidCandidateDenied', malformed.ok === false
  && malformed.errors.indexOf('missing-actor-id') >= 0 && malformed.errors.indexOf('missing-recipient-id') >= 0
  && malformed.errors.indexOf('bad-source') >= 0
  && malformedVerdict.decision === 'deny' && malformedVerdict.reason === 'invalid-candidate', malformed);

/* 自寄信件结构性拒绝（不是产品策略，是候选契约的一部分） */
const selfLetter = A.buildRoleLetterCandidate({ actorId: 'role_a', recipientId: 'role_a', source: 'schedule', trigger: 'init' });
check('RL2b.selfLetterRejected', selfLetter.ok === false && selfLetter.errors.indexOf('self-letter') >= 0, selfLetter);

/* ── RL3 unknown actor ─────────────────────────────────────────────── */
check('RL3.unknownActorDenied',
  A.decideRoleLetterWrite(built.candidate, Object.assign({}, GOOD_FACTS, { actorKnown: false })).reason === 'unknown-actor'
  && A.decideRoleLetterWrite(built.candidate, { recipientKnown: true, enabled: true }).reason === 'unknown-actor');

/* ── RL4 unknown recipient ─────────────────────────────────────────── */
check('RL4.unknownRecipientDenied',
  A.decideRoleLetterWrite(built.candidate, Object.assign({}, GOOD_FACTS, { recipientKnown: false })).reason === 'unknown-recipient'
  && A.decideRoleLetterWrite(built.candidate, {}).decision === 'deny');

/* ── RL5 disabled ──────────────────────────────────────────────────── */
check('RL5.disabledDenied',
  A.decideRoleLetterWrite(built.candidate, Object.assign({}, GOOD_FACTS, { enabled: false })).reason === 'disabled'
  && A.decideRoleLetterWrite(built.candidate, Object.assign({}, GOOD_FACTS, { cancelled: true })).reason === 'cancelled'
  && A.decideRoleLetterWrite(built.candidate, GOOD_FACTS).decision === 'allow');

/* ── RL6 duplicate ─────────────────────────────────────────────────── */
const replyCandidate = A.buildRoleLetterCandidate({ actorId: 'role_b', recipientId: 'role_a', source: 'character',
  letterKind: 'reply', trigger: 'reply', triggerRef: 'rletter_1' });
check('RL6.duplicateDenied',
  replyCandidate.ok === true
  && A.decideRoleLetterWrite(replyCandidate.candidate, Object.assign({}, GOOD_FACTS, { duplicate: true })).reason === 'duplicate'
  && A.decideRoleLetterWrite(built.candidate, Object.assign({}, GOOD_FACTS, { duplicate: true })).reason === 'duplicate');

/* ── RL7 cooldown（既有对偶冷却）────────────────────────────────────── */
check('RL7.cooldownDenied',
  A.decideRoleLetterWrite(built.candidate, Object.assign({}, GOOD_FACTS, { cooldown: true })).reason === 'cooldown');

/* ── 判定顺序 + 无 DEFER ───────────────────────────────────────────── */
const allBad = { actorKnown: false, recipientKnown: false, cancelled: true, enabled: false, cooldown: true, duplicate: true };
check('RL7b.decisionOrderIsStable',
  A.decideRoleLetterWrite(built.candidate, allBad).reason === 'unknown-actor'
  && A.decideRoleLetterWrite(built.candidate, Object.assign({}, allBad, { actorKnown: true })).reason === 'unknown-recipient'
  && A.decideRoleLetterWrite(built.candidate, Object.assign({}, allBad, { actorKnown: true, recipientKnown: true })).reason === 'cancelled'
  && A.decideRoleLetterWrite(built.candidate, Object.assign({}, allBad, { actorKnown: true, recipientKnown: true, cancelled: false })).reason === 'disabled'
  && A.decideRoleLetterWrite(built.candidate, Object.assign({}, allBad, { actorKnown: true, recipientKnown: true, cancelled: false, enabled: true })).reason === 'cooldown'
  && A.decideRoleLetterWrite(built.candidate, Object.assign({}, allBad, { actorKnown: true, recipientKnown: true, cancelled: false, enabled: true, cooldown: false })).reason === 'duplicate',
  A.decideRoleLetterWrite(built.candidate, allBad));
check('RL7c.noDeferInDecisionSet',
  JSON.stringify(A.ROLE_LETTER_DECISIONS) === JSON.stringify({ ALLOW: 'allow', DENY: 'deny' })
  && ASRC.indexOf('defer') < 0 && A.ROLE_LETTER_REASONS.indexOf('deferred') < 0);

(async () => {
  /* ── RL8 allow executor once ───────────────────────────────────────── */
  let allowCalls = 0;
  const allowRun = await A.runRoleLetterWrite(GOOD_INPUT, GOOD_FACTS, async () => { allowCalls++; return { ok: true, letter: LETTER }; });
  check('RL8.allowRunsExecutorOnce',
    allowRun.decision === 'allow' && allowRun.ok === true && allowRun.executed === true && allowCalls === 1
    && allowRun.letter === LETTER && allowRun.actorId === 'role_a' && allowRun.recipientId === 'role_b', allowRun);

  /* ── RL9 deny executor zero ────────────────────────────────────────── */
  let denyCalls = 0;
  const denyExecutor = async () => { denyCalls++; return { ok: true, letter: LETTER }; };
  const denyCooldown = await A.runRoleLetterWrite(GOOD_INPUT, Object.assign({}, GOOD_FACTS, { cooldown: true }), denyExecutor);
  const denyDup = await A.runRoleLetterWrite(GOOD_INPUT, Object.assign({}, GOOD_FACTS, { duplicate: true }), denyExecutor);
  const denyDisabled = await A.runRoleLetterWrite(GOOD_INPUT, Object.assign({}, GOOD_FACTS, { enabled: false }), denyExecutor);
  const denyNoFn = await A.runRoleLetterWrite(GOOD_INPUT, GOOD_FACTS, null);
  check('RL9.denyRunsExecutorZeroTimes',
    denyCalls === 0 && denyCooldown.executed === false && denyDup.executed === false && denyDisabled.executed === false
    && denyCooldown.letter === null && denyNoFn.reason === 'no-executor',
    { calls: denyCalls, cooldown: denyCooldown.reason, dup: denyDup.reason, disabled: denyDisabled.reason });

  /* ── RL10 executor failure ≠ DENY ──────────────────────────────────── */
  const thrown = await A.runRoleLetterWrite(GOOD_INPUT, GOOD_FACTS, async () => { throw new Error('roleLetters store exploded'); });
  const failedFlag = await A.runRoleLetterWrite(GOOD_INPUT, GOOD_FACTS, async () => ({ ok: false, error: 'write-failed' }));
  check('RL10.executorFailureIsNotDeny',
    thrown.decision === 'allow' && thrown.executed === true && thrown.ok === false && thrown.error === 'roleLetters store exploded'
    && failedFlag.decision === 'allow' && failedFlag.ok === false && failedFlag.error === 'write-failed',
    { thrown: thrown, failedFlag: failedFlag });

  /* ── verifier（§21）：只验证 canonical letter ──────────────────────── */
  const rows = { rletter_1: LETTER };
  let reads = 0;
  const verified = await A.verifyRoleLetterWrite(allowRun, async id => { reads++; return rows[id] || null; });
  const missing = await A.verifyRoleLetterWrite(allowRun, async () => null);
  const fake = await A.verifyRoleLetterWrite({ status: 'completed', ok: true, letterId: 'rletter_ghost', actorId: 'role_a', recipientId: 'role_b' }, async () => null);
  const wrongActor = await A.verifyRoleLetterWrite(allowRun, async () => ({ id: 'rletter_1', fromRoleId: 'someone_else', toRoleId: 'role_b' }));
  const wrongRecipient = await A.verifyRoleLetterWrite(allowRun, async () => ({ id: 'rletter_1', fromRoleId: 'role_a', toRoleId: 'someone_else' }));
  const deniedVerify = await A.verifyRoleLetterWrite(denyCooldown, async () => rows.rletter_1);
  const noVerifier = await A.verifyRoleLetterWrite(allowRun, null);
  check('RL8b.verifierChecksCanonicalLetter',
    verified.verified === true && verified.letterId === 'rletter_1' && reads === 1
    && missing.errorCode === 'canonical-letter-missing' && fake.verified === false
    && wrongActor.errorCode === 'identity-mismatch' && wrongRecipient.errorCode === 'recipient-mismatch'
    && deniedVerify.errorCode === 'not-completed' && noVerifier.errorCode === 'verifier-missing',
    { verified: verified, missing: missing, wrongActor: wrongActor, wrongRecipient: wrongRecipient });

  /* ── RL11 model != permission ──────────────────────────────────────── */
  const modelSaysWrite = Object.assign({}, built.candidate, {
    content: '模型写好的信', write: true, confidence: 0.99, generatedByFallback: false
  });
  const decideBody = ASRC.slice(ASRC.indexOf('function decideRoleLetterWrite('), ASRC.indexOf('async function runRoleLetterWrite('));
  check('RL11.modelOutputIsNotPermission',
    A.decideRoleLetterWrite(modelSaysWrite, Object.assign({}, GOOD_FACTS, { cooldown: true })).decision === 'deny'
    && A.decideRoleLetterWrite(modelSaysWrite, {}).decision === 'deny'
    && A.decideRoleLetterWrite(modelSaysWrite, GOOD_FACTS).decision === 'allow'
    && ASRC.indexOf('confidence') < 0
    /* 决策函数完全不认识信件正文：content / write / draft 都不参与判定 */
    && decideBody.length > 0 && decideBody.indexOf('content') < 0 && decideBody.indexOf('draft') < 0
    && decideBody.indexOf('write:') < 0, decideBody.slice(0, 60));

  /* ── RL12–RL14 纯度（源码守卫；注释先剥离）──────────────────────────── */
  const purity = {
    db: ['dbPut', 'dbGet', 'dbDelete', 'indexedDB', 'roleLetters', 'roleLetterMemories', 'localStorage'],
    dom: ['document', 'getElementById', 'createElement', 'window.', 'navigator', 'toast('],
    model: ['callApiChat', 'fetch(', 'runtime.execute', 'IB.runtime', 'resolveModel', 'streaming'],
    memory: ['memories', 'memoryCandidate', 'IBMemory', 'memory-store', 'updateMemDashboard'],
    brain: ['_mbSideEffectGate', '_execMemOps', 'middleBrain', 'MiddleBrain', '_MB_SEC'],
    delivery: ['Notification', 'tts', 'TTS']
  };
  const hits = key => purity[key].filter(n => ASRC.indexOf(n) >= 0);
  check('RL12.authorityHasNoDatabaseAccess', hits('db').length === 0, hits('db'));
  check('RL13.authorityHasNoMemoryIntegration', hits('memory').length === 0, hits('memory'));
  check('RL14.authorityHasNoMiddleBrainIntegration', hits('brain').length === 0, hits('brain'));
  check('RL14b.authorityHasNoModelOrDeliveryAccess',
    hits('dom').length === 0 && hits('model').length === 0 && hits('delivery').length === 0,
    { dom: hits('dom'), model: hits('model'), delivery: hits('delivery') });

  /* ── RL15 no secret ────────────────────────────────────────────────── */
  const secretCandidate = A.buildRoleLetterCandidate({ actorId: 'role_a', recipientId: 'role_b', source: 'schedule',
    trigger: 'init', contextRef: 'sk-abcdefgh1234' });
  const plainCandidate = A.buildRoleLetterCandidate({ actorId: 'role_a', recipientId: 'role_b', source: 'schedule',
    trigger: 'init', contextRef: '海边的那天' });
  const secretKeys = ['apiKey', 'authorization', 'credential', 'provider', 'systemPrompt'];
  const leaky = secretKeys.filter(k => JSON.stringify(allowRun).indexOf('"' + k + '"') >= 0);
  check('RL15.noSecretInCandidateOrResult',
    secretCandidate.ok === false && secretCandidate.errors.indexOf('secret-in-candidate') >= 0
    && plainCandidate.ok === true && leaky.length === 0
    && ASRC.indexOf('apiKey') < 0 && ASRC.indexOf('Authorization') < 0, { secretCandidate: secretCandidate, leaky: leaky });

  /* ── RL16 no CoT（信件正文不是 CoT）────────────────────────────────── */
  check('RL16.noChainOfThought',
    !hasReasoningKey(allowRun) && !hasReasoningKey(denyCooldown) && !hasReasoningKey(verified)
    && !REASONING.test(ASRC) && ASRC.indexOf('systemPrompt') < 0 && ASRC.indexOf('messages') < 0);

  /* ── 身份确定性 + 不重新发明 letter 身份 ──────────────────────────── */
  const again = A.buildRoleLetterCandidate(GOOD_INPUT);
  const otherRecipient = A.buildRoleLetterCandidate(Object.assign({}, GOOD_INPUT, { recipientId: 'role_c' }));
  const otherKind = A.buildRoleLetterCandidate(Object.assign({}, GOOD_INPUT, { letterKind: 'reply', source: 'character', trigger: 'reply' }));
  check('RL16b.identityDeterministic',
    again.candidate.candidateId === built.candidate.candidateId
    && otherRecipient.candidate.candidateId !== built.candidate.candidateId
    && otherKind.candidate.candidateId !== built.candidate.candidateId
    && otherKind.candidate.candidateId !== otherRecipient.candidate.candidateId
    && ASRC.indexOf('Math.random') < 0 && ASRC.indexOf('Date.now') < 0 && ASRC.indexOf('new Date') < 0
    && built.candidate.candidateId.indexOf('rletter_') !== 0, built.candidate.candidateId);

  /* ── source 闭集 == 审计到的真实入口（没有 user/manual）────────────── */
  check('RL16c.sourceClosedSetMatchesAudit',
    JSON.stringify(A.ROLE_LETTER_SOURCES) === JSON.stringify(['schedule', 'character'])
    && JSON.stringify(A.ROLE_LETTER_KINDS) === JSON.stringify(['init', 'reply'])
    && A.buildRoleLetterCandidate(Object.assign({}, GOOD_INPUT, { source: 'user' })).ok === false
    && A.buildRoleLetterCandidate(Object.assign({}, GOOD_INPUT, { source: 'manual' })).ok === false);

  /* ── domain 既有行为未被改写（cadence / 冷却 / 已回已拒 / 单一 writer）── */
  check('RL16d.domainPoliciesPreserved',
    RL.indexOf('const RL_INIT_PER_DAY=1;') >= 0
    && RL.indexOf('const RL_PAIR_MIN=24*3600000;') >= 0
    && RL.indexOf('const RL_PAIR_MAX=72*3600000;') >= 0
    && RL.indexOf('const RL_REPLY_DELAY_MS=[1*3600000,6*3600000];') >= 0
    && RL.indexOf('function _rlPairCooldownMs(a,b,now){') >= 0
    && RL.indexOf('function _rlReplyStep(recipientId,now){') >= 0
    && RL.indexOf('async function _rlInitStep(cfg,now){') >= 0
    && RL.indexOf('async function _rlStoreLetter(data){') >= 0,
    { pair: RL.indexOf('function _rlPairCooldownMs(') });

  /* ── 单一 canonical writer（§15）：roleLetters 只有一个写入点 ───────── */
  check('RL16e.singleCanonicalWriter',
    countOcc(RL, "dbPut(RL_STORE") === 1
    && RL.indexOf('await dbPut(RL_STORE,r);') >= 0
    && RL.indexOf('async function _rlWriteCanonical(rec){') >= 0
    && RL.indexOf('async function _rlRunWrite(candidate,facts,executor){') >= 0
    && RL.indexOf('function _rlAuthority(){') >= 0
    /* 私有记忆命名空间是独立的既有实现（不是 Memory 子系统），保持不变 */
    && countOcc(RL, "dbPut(RL_MEM_STORE") === 1,
    { letterWrites: countOcc(RL, "dbPut(RL_STORE"), memWrites: countOcc(RL, "dbPut(RL_MEM_STORE") });

  console.log('\n' + (failed
    ? 'P25-3D Role Letter Authority FAILED: ' + failed + ' failed / ' + passed + ' passed'
    : 'P25-3D Role Letter Authority passed \u2714 (' + passed + ' checks, 0 side effects)'));
  process.exitCode = failed ? 1 : 0;
})().catch(e => { console.error(e && e.stack || e); process.exitCode = 1; });
