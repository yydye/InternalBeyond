'use strict';

/* Internal Beyond · P25-3B · Diary Authority 测试（D1–D20；纯 Node、零浏览器、零网络）

   Diary Authority 是 Diary **写**权限的唯一权威（assets/js/diary-authority.js）。
   本套件证明四件事：
     ① 决策只取决于闭集 facts，缺任何关键事实一律 DENY（fail closed）；
     ② 模块自身纯净：零 DB / 零 DOM / 零模型 / 零 Memory / 零 Middle Brain / 零秘密 / 零 CoT；
     ③ domain 的既有行为（identity / duplicate / frequency / 导出面）**没有被改写**；
     ④ verifier 只验证结果，绝不补写、绝不 retry。

   本套件不产生任何 production side effect（executor / reader 全部注入）。 */

const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const stripComments = src => String(src).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const A = require(path.join(ROOT, 'assets/js/diary-authority.js'));
const ASRC = stripComments(read('assets/js/diary-authority.js'));
const DIARY_RAW = read('assets/js/active-diary/diary.js');
const DIARY = stripComments(DIARY_RAW);

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
const GOOD_FACTS = { actorKnown: true, enabled: true, hasContent: true, cancelled: false };
const GOOD_INPUT = { actorId: 'role_a', source: 'user', trigger: 'manual', triggerRef: '' };

console.log('== P25-3B · Diary Authority 测试 ==');

/* ── D1 valid candidate ─────────────────────────────────────────────── */
const built = A.buildDiaryCandidate(Object.assign({ diaryType: 'weekly' }, GOOD_INPUT));
check('D1.validCandidate', built.ok === true && built.errors.length === 0
  && built.candidate.actorId === 'role_a' && built.candidate.source === 'user'
  && built.candidate.trigger === 'manual' && built.candidate.diaryType === 'weekly'
  && /^dca_[A-Za-z0-9]+$/.test(built.candidate.candidateId), built);

/* ── D2 malformed candidate denied ──────────────────────────────────── */
const malformed = A.buildDiaryCandidate({ actorId: '', source: 'nope', trigger: '' });
const malformedVerdict = A.decideDiaryWrite({ candidateId: '', actorId: '', source: '' }, GOOD_FACTS);
check('D2.malformedCandidateDenied', malformed.ok === false
  && malformed.errors.indexOf('missing-actor-id') >= 0 && malformed.errors.indexOf('bad-source') >= 0
  && malformedVerdict.decision === 'deny' && malformedVerdict.reason === 'invalid-candidate', malformed);

/* ── D3 unknown actor denied ────────────────────────────────────────── */
check('D3.unknownActorDenied',
  A.decideDiaryWrite(built.candidate, Object.assign({}, GOOD_FACTS, { actorKnown: false })).reason === 'unknown-actor'
  && A.decideDiaryWrite(built.candidate, {}).decision === 'deny'
  && A.decideDiaryWrite(built.candidate, { enabled: true, hasContent: true }).reason === 'unknown-actor');

/* ── D4 disabled denied ─────────────────────────────────────────────── */
check('D4.disabledDenied',
  A.decideDiaryWrite(built.candidate, Object.assign({}, GOOD_FACTS, { enabled: false })).reason === 'disabled'
  && A.decideDiaryWrite(built.candidate, Object.assign({}, GOOD_FACTS, { hasContent: false })).reason === 'empty-content'
  && A.decideDiaryWrite(built.candidate, Object.assign({}, GOOD_FACTS, { cancelled: true })).reason === 'cancelled'
  && A.decideDiaryWrite(built.candidate, GOOD_FACTS).decision === 'allow');

/* ── D5 model output != permission ──────────────────────────────────── */
/* 模型"想写"、给出了 content / draft 都不构成权限：facts 不变则结论不变。 */
const modelSaysWrite = Object.assign({}, built.candidate, {
  draft: '今天发生了很多事。', modelWantsWrite: true, confidence: 0.99, importance: 10
});
check('D5.modelOutputIsNotPermission',
  A.decideDiaryWrite(modelSaysWrite, Object.assign({}, GOOD_FACTS, { enabled: false })).decision === 'deny'
  && A.decideDiaryWrite(modelSaysWrite, {}).decision === 'deny'
  && A.decideDiaryWrite(modelSaysWrite, GOOD_FACTS).decision === 'allow'
  && ASRC.indexOf('modelWantsWrite') < 0 && ASRC.indexOf('confidence') < 0);

/* ── D6 scheduler trigger != permission ─────────────────────────────── */
const scheduled = A.buildDiaryCandidate({ actorId: 'role_a', source: 'schedule', trigger: 'weekly', triggerRef: 'wk_1' });
check('D6.schedulerTriggerIsNotPermission',
  A.sourceOfTrigger('weekly') === 'schedule' && A.sourceOfTrigger('daily_plan') === 'schedule'
  && A.sourceOfTrigger('first_chat') === 'character' && A.sourceOfTrigger('manual') === 'user'
  && A.sourceOfTrigger('wish') === 'user' && A.sourceOfTrigger('unknown-trigger') === ''
  && A.decideDiaryWrite(scheduled.candidate, {}).decision === 'deny');

(async () => {
  /* ── D7 ALLOW executor once ─────────────────────────────────────────── */
  let allowCalls = 0;
  const entry = { id: 'diary_1', characterId: 'role_a' };
  const allowRun = await A.runDiaryWrite(GOOD_INPUT, GOOD_FACTS, async () => { allowCalls++; return { ok: true, entry: entry }; });
  check('D7.allowRunsExecutorOnce',
    allowRun.decision === 'allow' && allowRun.ok === true && allowRun.executed === true
    && allowCalls === 1 && allowRun.entry === entry && allowRun.actorId === 'role_a', allowRun);

  /* ── D8 DENY executor zero ──────────────────────────────────────────── */
  let denyCalls = 0;
  const denyExecutor = async () => { denyCalls++; return { ok: true, entry: entry }; };
  const denyRun = await A.runDiaryWrite(GOOD_INPUT, Object.assign({}, GOOD_FACTS, { enabled: false }), denyExecutor);
  const denyNoFn = await A.runDiaryWrite(GOOD_INPUT, GOOD_FACTS, null);
  check('D8.denyRunsExecutorZeroTimes',
    denyRun.decision === 'deny' && denyRun.executed === false && denyRun.entry === null
    && denyCalls === 0 && denyNoFn.reason === 'no-executor', { denyRun: denyRun, denyCalls: denyCalls });

  /* ── D9 executor failure != DENY ────────────────────────────────────── */
  const thrown = await A.runDiaryWrite(GOOD_INPUT, GOOD_FACTS, async () => { throw new Error('db exploded'); });
  const failedFlag = await A.runDiaryWrite(GOOD_INPUT, GOOD_FACTS, async () => ({ ok: false, error: 'write-failed' }));
  check('D9.executorFailureIsNotDeny',
    thrown.decision === 'allow' && thrown.executed === true && thrown.ok === false && thrown.error === 'db exploded'
    && failedFlag.decision === 'allow' && failedFlag.ok === false && failedFlag.error === 'write-failed'
    && allowRun.decision === 'allow');

  /* ── Verifier（§28/§29：只验证，不补写、不 retry）───────────────────── */
  const rows = { diary_1: { id: 'diary_1', characterId: 'role_a' } };
  let verifyReads = 0;
  const verified = await A.verifyDiaryWrite(allowRun, async id => { verifyReads++; return rows[id] || null; });
  const missing = await A.verifyDiaryWrite(allowRun, async () => null);
  const fake = await A.verifyDiaryWrite({ status: 'completed', ok: true, entryId: 'diary_ghost', actorId: 'role_a' }, async () => null);
  const wrongActor = await A.verifyDiaryWrite(allowRun, async () => ({ id: 'diary_1', characterId: 'someone_else' }));
  const denied = await A.verifyDiaryWrite(denyRun, async () => rows.diary_1);
  const noVerifier = await A.verifyDiaryWrite(allowRun, null);
  check('D7b.verifierConfirmsCanonicalRow',
    verified.verified === true && verified.entryId === 'diary_1' && verifyReads === 1
    && missing.errorCode === 'canonical-entry-missing' && fake.verified === false
    && wrongActor.errorCode === 'identity-mismatch' && denied.errorCode === 'not-completed'
    && noVerifier.errorCode === 'verifier-missing', { verified: verified, missing: missing, fake: fake, wrongActor: wrongActor });

  /* ── D10–D14 纯度（源码守卫；注释先剥离）────────────────────────────── */
  const purity = {
    db: ['dbPut', 'dbGet', 'dbDelete', 'indexedDB', 'DIARY_STORE', 'diary_entries', 'localStorage'],
    dom: ['document', 'getElementById', 'createElement', 'window.', 'navigator', 'toast('],
    model: ['callApiChat', 'fetch(', 'runtime.execute', 'IB.runtime', 'resolveModel', 'streaming'],
    memory: ['memories', 'memoryCandidate', 'IBMemory', 'memory-store', 'updateMemDashboard'],
    brain: ['_mbSideEffectGate', '_execMemOps', 'middleBrain', 'MiddleBrain', '_MB_SEC']
  };
  const hits = key => purity[key].filter(needle => ASRC.indexOf(needle) >= 0);
  check('D10.authorityHasNoDatabaseAccess', hits('db').length === 0, hits('db'));
  check('D11.authorityHasNoDomAccess', hits('dom').length === 0, hits('dom'));
  check('D12.authorityHasNoModelAccess', hits('model').length === 0, hits('model'));
  check('D13.authorityHasNoMemoryIntegration', hits('memory').length === 0, hits('memory'));
  check('D14.authorityHasNoMiddleBrainIntegration', hits('brain').length === 0, hits('brain'));

  /* ── D15 no secret ─────────────────────────────────────────────────── */
  const secretCandidate = A.buildDiaryCandidate({ actorId: 'role_a', source: 'user', trigger: 'manual', contextRef: 'sk-abcdefgh1234' });
  const secretDraft = A.buildDiaryCandidate({ actorId: 'role_a', source: 'user', trigger: 'manual', draft: 'Bearer sk-abcdefgh1234' });
  const plainDraft = A.buildDiaryCandidate({ actorId: 'role_a', source: 'user', trigger: 'manual', draft: '今天下雨了，我想起你说的那句话。' });
  const secretKeys = ['apiKey', 'authorization', 'credential', 'provider', 'systemPrompt'];
  const leaky = secretKeys.filter(k => JSON.stringify(allowRun).indexOf('"' + k + '"') >= 0);
  check('D15.noSecretInCandidateOrResult',
    secretCandidate.ok === false && secretCandidate.errors.indexOf('secret-in-candidate') >= 0
    && secretDraft.ok === false && plainDraft.ok === true && leaky.length === 0
    /* 正常日记正文 / 草稿不被误判为 CoT 或秘密（§32） */
    && ASRC.indexOf('apiKey') < 0 && ASRC.indexOf('Authorization') < 0, { secretCandidate: secretCandidate, leaky: leaky });

  /* ── D16 no CoT ────────────────────────────────────────────────────── */
  check('D16.noChainOfThought',
    !hasReasoningKey(allowRun) && !hasReasoningKey(denyRun) && !hasReasoningKey(verified)
    && !REASONING.test(ASRC) && ASRC.indexOf('systemPrompt') < 0 && ASRC.indexOf('messages') < 0);

  /* ── D17 identity deterministic ────────────────────────────────────── */
  const again = A.buildDiaryCandidate(Object.assign({ diaryType: 'weekly' }, GOOD_INPUT));
  const otherTrigger = A.buildDiaryCandidate({ actorId: 'role_a', source: 'user', trigger: 'wish', triggerRef: '' });
  const otherActor = A.buildDiaryCandidate({ actorId: 'role_b', source: 'user', trigger: 'manual', triggerRef: '' });
  const otherRef = A.buildDiaryCandidate({ actorId: 'role_a', source: 'user', trigger: 'manual', triggerRef: 'wk_9' });
  check('D17.identityDeterministic',
    again.candidate.candidateId === built.candidate.candidateId
    && otherTrigger.candidate.candidateId !== built.candidate.candidateId
    && otherActor.candidate.candidateId !== built.candidate.candidateId
    && otherRef.candidate.candidateId !== built.candidate.candidateId
    && ASRC.indexOf('Math.random') < 0 && ASRC.indexOf('Date.now') < 0 && ASRC.indexOf('new Date') < 0
    /* candidateId ≠ Diary entry id：本模块绝不生成 diary_ 前缀身份（§19） */
    && built.candidate.candidateId.indexOf('diary_') !== 0, built.candidate.candidateId);

  /* ── D18 duplicate semantics preserved（domain 侧未被改写）──────────── */
  const dupCall = 'const dup=await _diaryDuplicateCheck(characterId,parsed.title,parsed.content);';
  check('D18.domainDuplicateSemanticsPreserved',
    DIARY.indexOf('const DIARY_SIMILARITY_LIMIT=0.75;') >= 0
    && DIARY.indexOf('async function _diaryDuplicateCheck(characterId,title,content){') >= 0
    && DIARY.indexOf(dupCall) >= 0
    && DIARY.indexOf('你刚才写的内容与最近日记太相似') >= 0
    /* 去重判定必须发生在写权限裁决**之前**（否则会多出一次模型调用 / 少一次重写） */
    && DIARY.indexOf(dupCall) < DIARY.indexOf('await _diaryRunWrite(')
    /* 不新增第二套 duplicate store：authority 侧零 duplicate 概念 */
    && ASRC.indexOf('duplicate') < 0 && ASRC.indexOf('similar') < 0);

  /* ── D19 cooldown / frequency preserved ───────────────────────────── */
  const tick = DIARY.slice(DIARY.indexOf('async function _diaryTick('), DIARY.indexOf('/* 特殊事件'));
  const weeklyWm = tick.indexOf("_diarySetWatermark('wk_'+cfg.id,weekKey);");
  const dailyWm = tick.indexOf("_diarySetWatermark('dl_'+cfg.id,todayKey);");
  check('D19.frequencyWatermarksPreserved',
    weeklyWm >= 0 && weeklyWm < tick.indexOf("generateDiaryEntry(cfg.id,{trigger:'weekly'")
    && dailyWm >= 0 && dailyWm < tick.indexOf('const plan=await _diaryDailyPlanner(')
    && DIARY.indexOf('ib_diary_watermarks_v1') >= 0
    && ASRC.indexOf('setInterval') < 0 && ASRC.indexOf('setTimeout') < 0 && ASRC.indexOf('watermark') < 0);

  /* ── D20 existing Diary behavior preserved ─────────────────────────── */
  const defaults = DIARY.slice(DIARY.indexOf('function _diaryDefaults('), DIARY.indexOf('function _diaryTypeLabel('));
  const exported = ['_diaryPrefs', '_diaryDefaults', '_diaryWriteMemory', '_diaryParseOutput', 'generateDiaryEntry',
    '_diaryDailyPlanner', '_diaryTick', '_diaryMaybeEvent', '_diaryRenderVault', '_diaryDelete', '_diaryOpenVault',
    '_diaryWriteNow', '_diaryTodayWish', '_diaryRenderPrefs', '_diarySavePrefs', 'loadDiaryPage', '_diaryModelCall'];
  const missingExports = exported.filter(sym => DIARY_RAW.indexOf('window.' + sym + '=') < 0 || DIARY_RAW.indexOf(sym + ': ' + sym) < 0);
  check('D20.existingDiarySurfacePreserved',
    DIARY.indexOf("const DIARY_STORE='diary_entries';") >= 0
    && DIARY.indexOf("const DIARY_PREFS_KEY='ib_diary_prefs_v1';") >= 0
    && defaults.indexOf("'diary_'+Date.now().toString(36)") >= 0
    && defaults.indexOf('Math.random()') >= 0
    && missingExports.length === 0, missingExports);

  console.log('\n' + (failed
    ? 'P25-3B Diary Authority FAILED: ' + failed + ' failed / ' + passed + ' passed'
    : 'P25-3B Diary Authority passed \u2714 (' + passed + ' checks, 0 side effects)'));
  process.exitCode = failed ? 1 : 0;
})().catch(e => { console.error(e && e.stack || e); process.exitCode = 1; });
