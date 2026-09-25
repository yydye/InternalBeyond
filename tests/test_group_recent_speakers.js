'use strict';

/* Internal Beyond · P24-M3.3.3.1 · Recent Speaker Derivation 测试
   （static 组：纯 Node、零浏览器、零网络、零存储；运行：
     node tests/test_group_recent_speakers.js）

   本子阶段只交付 **pure helper**（capability only）：
     deriveRecentSpeakerIds(history, participants, { window })
       → { recentSpeakerIds: [speakerId, ...] }   // most-recent-first

   冻结语义：window 单位 = MemberTurn；只有 resolved 且属于当前 participants 的 assistant
   消息消耗 window；身份只经 M2 `resolveSpeakerId`；turnId → (groupTurnId+speakerId) →
   message.id 的 dedupe key 链；输出按 speaker 去重并保留最新位置。
   本阶段**不改 planner / 不改 planVersion / 不改 communication.js / 不启用 suppression**。 */

const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');

const ROOT = path.resolve(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const Core = require(path.join(ROOT, 'assets', 'js', 'group-runtime-core.js'));

let failures = 0;
let passes = 0;
function ok(name, cond, detail) {
  if (cond) { passes++; console.log('  PASS  ' + name); }
  else { failures++; console.error('  FAIL  ' + name + (detail !== undefined ? '  -> ' + JSON.stringify(detail).slice(0, 320) : '')); }
}
function stripComments(src) {
  return String(src).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}
function deepFreeze(v) {
  if (v && typeof v === 'object') { Object.getOwnPropertyNames(v).forEach(k => deepFreeze(v[k])); Object.freeze(v); }
  return v;
}
function throws(fn) { try { fn(); return null; } catch (e) { return e; } }

/* ── 构造器 ─────────────────────────────────────────────────────────────── */
const PARTS = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
const NAMED = [{ id: 'a', name: 'X' }, { id: 'b', name: 'X' }, { id: 'c', name: 'Y' }];
function memberTurn(speakerId, turnId, seq, extra) {
  const md = { speakerId: speakerId, turnId: turnId };
  if (seq !== undefined) md.sequenceIndex = seq;
  if (extra) Object.assign(md, extra);
  return { id: 'msg_' + turnId + '_' + (seq === undefined ? '0' : String(seq)), role: 'assistant', content: 'REPLY-' + speakerId, metadata: md };
}
function userMsg(id, text) { return { id: id || 'msg_u1', role: 'user', content: text || 'USER-TEXT' }; }
function systemMsg(id) { return { id: id || 'msg_sys_1', role: 'system', content: 'SYSTEM-TEXT' }; }
const R = (history, participants, window) => Core.deriveRecentSpeakerIds(history, participants || PARTS, { window: window === undefined ? 1 : window });
const IDS = r => r.recentSpeakerIds;

/* ── R1/R2 · 空与零窗口 ─────────────────────────────────────────────────── */
function emptyCases() {
  ok('R1.emptyHistoryYieldsEmpty', JSON.stringify(IDS(R([], PARTS, 5))) === '[]');
  ok('R2.windowZeroIsValidAndEmpty', JSON.stringify(IDS(R([memberTurn('a', 'T1')], PARTS, 0))) === '[]'
    && Core.validateRecentSpeakerInput([memberTurn('a', 'T1')], PARTS, { window: 0 }).ok === true);
  ok('R1b.emptyParticipantsYieldsEmpty', JSON.stringify(IDS(R([memberTurn('a', 'T1')], [], 3))) === '[]');
}

/* ── R3–R10 · 身份与可计数性 ────────────────────────────────────────────── */
function identityAndCountable() {
  ok('R3.canonicalSpeakerIdCounts', JSON.stringify(IDS(R([memberTurn('b', 'T1')], PARTS, 1))) === '["b"]');
  const onlyConfigId = { id: 'msg_cfg', role: 'assistant', content: 'x', metadata: { config_id: 'a' } };
  ok('R4.configIdAloneIsNotCanonical', JSON.stringify(IDS(R([onlyConfigId], PARTS, 1))) === '[]');
  const helperCode = stripComments(read('assets/js/group-runtime-core.js')).split('function deriveRecentSpeakerIds')[1].split('function planParticipation')[0];
  ok('R4b.helperHasNoOwnConfigIdLogic', helperCode.indexOf('config_id') < 0);
  ok('R5.legacyUniqueSenderNameCounts', JSON.stringify(IDS(R([{ id: 'L1', role: 'assistant', senderName: 'Y', metadata: {} }], NAMED, 1))) === '["c"]');
  ok('R6.legacySameNameAmbiguousIgnored', JSON.stringify(IDS(R([{ id: 'L2', role: 'assistant', senderName: 'X', metadata: {} }], NAMED, 1))) === '[]');
  ok('R7.unknownIgnored', JSON.stringify(IDS(R([{ id: 'L3', role: 'assistant', metadata: {} }], PARTS, 1))) === '[]');
  ok('R8.nonParticipantIgnored', JSON.stringify(IDS(R([memberTurn('zzz', 'T1')], PARTS, 1))) === '[]');
  ok('R9.userIgnored', JSON.stringify(IDS(R([userMsg('msg_u1'), memberTurn('a', 'T1')], PARTS, 1))) === '["a"]');
  ok('R10.systemIgnored', JSON.stringify(IDS(R([systemMsg('msg_s1'), memberTurn('a', 'T1')], PARTS, 1))) === '["a"]');
  ok('R10b.invalidSpeakerIdIgnored', JSON.stringify(IDS(R([{ id: 'g', role: 'assistant', metadata: { speakerId: 'group_9', turnId: 'T1' } }], PARTS, 1))) === '[]');
}

/* ── R11–R20 · MemberTurn 单位、dedupe key、顺序 ────────────────────────── */
function memberTurnSemantics() {
  const ms3 = [memberTurn('a', 'T1', 0), memberTurn('a', 'T1', 1), memberTurn('a', 'T1', 2)];
  ok('R11.multipartSameTurnIdCountsOnce', JSON.stringify(IDS(R(ms3, PARTS, 3))) === '["a"]');
  const ms2 = [memberTurn('a', 'T1', 0), memberTurn('a', 'T1', 1)];
  ok('R12.toolContinuationSameTurnIdCountsOnce', JSON.stringify(IDS(R(ms2, PARTS, 2))) === '["a"]');
  const hist = [memberTurn('a', 'T1'), memberTurn('b', 'T2'), memberTurn('a', 'T3'), memberTurn('c', 'T4')];
  ok('R13.sameSpeakerDifferentTurnsConsumeSlots', JSON.stringify(IDS(R(hist, PARTS, 2))) === '["c","a"]');
  ok('R14.speakerOutputUniqueKeepsLatest', JSON.stringify(IDS(R(hist, PARTS, 4))) === '["c","a","b"]'
    && JSON.stringify(IDS(R(hist, PARTS, 99))) === '["c","a","b"]');
  ok('R15.windowOneReturnsLastSpeaker', JSON.stringify(IDS(R(hist, PARTS, 1))) === '["c"]');
  ok('R16.windowTwoReturnsTwoMostRecent', JSON.stringify(IDS(R(hist, PARTS, 2))) === '["c","a"]');
  ok('R17.windowLargerThanHistoryReturnsAllUnique', JSON.stringify(IDS(R(hist, PARTS, 3))) === '["c","a","b"]');
  const l1 = { id: 'L_old_1', role: 'assistant', senderName: 'Y', metadata: {} };
  const l2 = { id: 'L_old_2', role: 'assistant', senderName: 'Y', metadata: {} };
  ok('R18.legacyNoTurnIdFallsBackToMessageId', JSON.stringify(IDS(R([l1, l2], NAMED, 1))) === '["c"]'
    && JSON.stringify(IDS(R([l1, l2], NAMED, 2))) === '["c"]');
  ok('R18b.legacyMessageIsItsOwnTurn', JSON.stringify(IDS(R([l1, memberTurn('a', 'T9')], NAMED, 1))) === '["a"]');
  const gt1 = { id: 'g_1', role: 'assistant', metadata: { groupTurnId: 'gt1', speakerId: 'a' } };
  const gt2 = { id: 'g_2', role: 'assistant', metadata: { groupTurnId: 'gt1', speakerId: 'a' } };
  ok('R19.groupTurnPlusSpeakerFallbackDedupes', JSON.stringify(IDS(R([gt1, gt2], PARTS, 2))) === '["a"]');
  const gtB = { id: 'g_3', role: 'assistant', metadata: { groupTurnId: 'gt1', speakerId: 'b' } };
  ok('R20.groupTurnAloneNeverDedupesDifferentSpeakers', JSON.stringify(IDS(R([gt1, gtB], PARTS, 2))) === '["b","a"]');
  ok('R26.mostRecentFirstOrder', JSON.stringify(IDS(R(hist, PARTS, 3))) === '["c","a","b"]');
}

/* ── R21–R25 · 非法输入与"不消耗窗口" ───────────────────────────────────── */
function validationAndWindowConsumption() {
  const badWindows = [-1, 1.5, '2', NaN, Infinity, true, {}, []];
  ok('R21.invalidWindowFailsClosed', badWindows.every(w => {
    const e = throws(() => Core.deriveRecentSpeakerIds([], PARTS, { window: w }));
    return !!e && e.code === 'PARTICIPATION_CONTRACT' && e.errors.indexOf('bad-window') >= 0
      && Core.validateRecentSpeakerInput([], PARTS, { window: w }).ok === false;
  }), badWindows.map(w => Core.validateRecentSpeakerInput([], PARTS, { window: w }).errors));
  const missingWin = throws(() => Core.deriveRecentSpeakerIds([], PARTS, {}));
  ok('R21b.missingWindowFailsClosed', !!missingWin && missingWin.errors.indexOf('bad-window') >= 0);
  const nullOpts = throws(() => Core.deriveRecentSpeakerIds([], PARTS, null));
  ok('R21c.nonObjectOptsFailsClosed', !!nullOpts && nullOpts.errors.indexOf('bad-opts') >= 0);
  const badHist = throws(() => Core.deriveRecentSpeakerIds({}, PARTS, { window: 1 }));
  ok('R22.invalidHistoryShapeFailsClosed', !!badHist && badHist.errors.indexOf('bad-history') >= 0);
  const e1 = throws(() => Core.deriveRecentSpeakerIds([], 'a,b', { window: 1 }));
  const e2 = throws(() => Core.deriveRecentSpeakerIds([], [{}], { window: 1 }));
  const e3 = throws(() => Core.deriveRecentSpeakerIds([], [42], { window: 1 }));
  ok('R23.invalidParticipantsShapeFailsClosed', [e1, e2, e3].every(e => !!e && e.errors.indexOf('bad-participants') >= 0));
  ok('R21d.errorVocabularyClosed', JSON.stringify(Core.RECENT_SPEAKER_ERRORS) === JSON.stringify(['bad-history', 'bad-participants', 'bad-opts', 'bad-window']));
  ok('R24.currentUserMessageDoesNotConsumeWindow', JSON.stringify(IDS(R([memberTurn('a', 'T1'), userMsg('msg_now')], PARTS, 1))) === '["a"]');
  const unknown = { id: 'L_unknown', role: 'assistant', metadata: {} };
  ok('R25.invalidOrUnknownDoesNotConsumeWindow', JSON.stringify(IDS(R([memberTurn('b', 'T1'), unknown, systemMsg('msg_s2')], PARTS, 1))) === '["b"]');
  const clean = [memberTurn('a', 'T1'), memberTurn('b', 'T2')];
  const noisy = [userMsg('u1'), memberTurn('a', 'T1'), systemMsg('s1'), { id: 'x', role: 'assistant', metadata: {} }, userMsg('u2'), memberTurn('b', 'T2')];
  ok('R25b.interleavedJunkDoesNotChangeResult', JSON.stringify(IDS(R(clean, PARTS, 2))) === JSON.stringify(IDS(R(noisy, PARTS, 2))));
}

/* ── R27–R34 · 纯度、输出安全、非回归 ──────────────────────────────────── */
function purityAndNonRegression() {
  const hist = deepFreeze([deepFreeze(memberTurn('a', 'T1')), deepFreeze(memberTurn('b', 'T2'))]);
  const parts = deepFreeze([deepFreeze({ id: 'a' }), deepFreeze({ id: 'b' })]);
  const opts = deepFreeze({ window: 2 });
  const snapHist = JSON.stringify(hist), snapParts = JSON.stringify(parts), snapOpts = JSON.stringify(opts);
  const frozen = Core.deriveRecentSpeakerIds(hist, parts, opts);
  ok('R27.deepFrozenInputsStillWork', JSON.stringify(IDS(frozen)) === '["b","a"]'
    && JSON.stringify(hist) === snapHist && JSON.stringify(parts) === snapParts && JSON.stringify(opts) === snapOpts);

  const input = [memberTurn('a', 'T1'), memberTurn('b', 'T2'), memberTurn('a', 'T3')];
  const first = Core.deriveRecentSpeakerIds(input, PARTS, { window: 3 });
  let stable = true;
  for (let i = 0; i < 100; i++) {
    try { assert.deepStrictEqual(Core.deriveRecentSpeakerIds(input, PARTS, { window: 3 }), first); } catch (e) { stable = false; break; }
  }
  ok('R28.deterministicX100', stable);

  ok('R29.outputKeysClosed', Object.keys(first).join(',') === 'recentSpeakerIds'
    && Array.isArray(first.recentSpeakerIds) && first.recentSpeakerIds.every(x => typeof x === 'string'));
  const flat = JSON.stringify(first);
  ok('R30.noContentLeak', flat.indexOf('REPLY-') < 0 && flat.indexOf('USER-TEXT') < 0
    && flat.indexOf('turnId') < 0 && flat.indexOf('"T1"') < 0 && flat.indexOf('msg_') < 0);

  const core = read('assets/js/group-runtime-core.js');
  const coreCode = stripComments(core);
  const helperCode = coreCode.slice(coreCode.indexOf('function validateRecentSpeakerInput'), coreCode.indexOf('function planParticipation'));
  ok('R31.noStorageNetworkTimeRandomInHelper',
    !/dbPut|chatMessages|indexedDB|localStorage|fetch\(|XMLHttpRequest|document|setTimeout|setInterval|Math\.random|Date\.now|performance\.now|crypto\.randomUUID/.test(helperCode),
    helperCode.slice(0, 80));
  const plannerCode = coreCode.slice(coreCode.indexOf('function validateParticipationInput'), coreCode.lastIndexOf('  return {'));
  /* P24-M3.3.3.2 更新：契约已合法升级到 v3（planner input 增加 recentSpeakerIds）。
     本条真正要守的不变量是"helper 与 planner 分离"：
       · helper 不实现 config_id 回退；
       · planner **不调用** helper（它只吃调用方给的 recentSpeakerIds id 列表）。 */
  ok('R32.plannerDoesNotDependOnHelper', helperCode.indexOf('config_id') < 0 && plannerCode.indexOf('deriveRecentSpeakerIds(') < 0);
  const onePlan = Core.planParticipation({
    groupTurnId: 'gturn_abc123', trigger: { userMessageId: 'msg_1700000000200_u', text: 'x' },
    participants: [{ id: 'a', status: 'active' }]
  });
  /* P24-M3.3.3.2 更新：这一条在 .1 里是"阶段边界守卫"（当时 planner 契约仍是 v2）。
     现在 planner 契约已**合法升级**到 v3（新增 recentSpeakerIds input + recent-aware tiers）；
     本 helper 本体仍未修改、也未接入 planner —— 只是版本号随契约前移。 */
  ok('R33.planVersionIsThree', Core.PARTICIPATION_PLAN_VERSION === 3 && onePlan.planVersion === 3
    && onePlan.plannerId === 'group-rule-v1');
  ok('R34.reasonVocabularyUnchanged',
    JSON.stringify(Core.PARTICIPATION_REASONS.SPEAK) === JSON.stringify(['active-default', 'mentioned'])
    && JSON.stringify(Core.PARTICIPATION_REASONS.SKIP) === JSON.stringify(['muted-not-mentioned', 'removed', 'budget-limit'])
    && JSON.stringify(Core.PARTICIPATION_REASONS.RESERVED) === JSON.stringify(['no-config']));
  /* P24-M3.3.3.3 更新：.1 的阶段边界守卫（"helper 未被生产接线"）已随阶段推进失效 ——
     本阶段 production adapter 正式接线 helper。守卫改为**接线方式**仍然唯一且早于规划：
     恰好 1 处调用，且该调用出现在 planParticipation 调用**之前**（先派生 recent，再规划）。 */
  const commSrc = read('assets/js/communication.js');
  ok('R34b.productionWiresHelperExactlyOnceBeforePlanning',
    (commSrc.match(/deriveRecentSpeakerIds\(/g) || []).length === 1
    && commSrc.indexOf('deriveRecentSpeakerIds(') < commSrc.indexOf('planParticipation(_gPlanInput)'), {
      calls: (commSrc.match(/deriveRecentSpeakerIds\(/g) || []).length,
      derive: commSrc.indexOf('deriveRecentSpeakerIds('),
      plan: commSrc.indexOf('planParticipation(_gPlanInput)')
    });
}

function main() {
  console.log('== P24-M3.3.3.1 · Recent Speaker Derivation 测试 ==');
  emptyCases();
  identityAndCountable();
  memberTurnSemantics();
  validationAndWindowConsumption();
  purityAndNonRegression();
  console.log(failures === 0 ? '\n全部通过 ✔  (' + passes + ')' : '\n失败 ' + failures + ' 项（通过 ' + passes + '）');
  process.exitCode = failures ? 1 : 0;
}

main();
