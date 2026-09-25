'use strict';

/* Internal Beyond · P24-M3.1 · Participation Contract + Deterministic Rule Planner 测试
   （static 组：纯 Node、零浏览器、零网络、零存储；运行：
     node tests/test_group_participation_planner.js）

   M3.1 只交付**纯规则 planner**（不接管生产执行路径）。因此本套件：
     · 不启动浏览器、不碰 IndexedDB / Home Node；
     · 全部断言作用在纯模块 + 源码结构上；
     · 覆盖用户给定 A–W（含 determinism / immutability / metadata safety /
       silence-is-not-message / legacy 等价 / 无 history·text 依赖）。

   冻结契约（见 docs/P24-M3-PARTICIPATION-CONTRACT.md）：
     decision 词表 = speak（entries）/ skip（omitted，仅以 omitted 表达）
     reason 闭集 = active-default | mentioned | muted-not-mentioned | removed
     order = planned participant order（0 起、按 participants 数组顺序；空洞合法）
     runtime-only / 不改 input / 不复用对象 / 无时钟无随机 / 无 storage / 无 P23 字段 */

const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');

const ROOT = path.resolve(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const Core = require(path.join(ROOT, 'assets', 'js', 'group-runtime-core.js'));
const VoiceCore = require(path.join(ROOT, 'assets', 'js', 'voice-message-core.js'));

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
function keysDeep(v, out) {
  out = out || [];
  if (Array.isArray(v)) v.forEach(x => keysDeep(x, out));
  else if (v && typeof v === 'object') Object.keys(v).forEach(k => { out.push(k); keysDeep(v[k], out); });
  return out;
}

const GT = 'gturn_abc123';
const UID = 'msg_1700000000200_u';
const SENTINEL = 'SENTINEL_TEXT_9f3a1c';
function mkInput(participants, over) {
  return Object.assign({
    groupTurnId: GT,
    trigger: { userMessageId: UID, text: '大家怎么看？' + SENTINEL },
    participants: participants
  }, over || {});
}
function P(id, status, mentioned) {
  const p = { id: id, status: status };
  if (mentioned !== undefined) p.mentioned = mentioned;
  return p;
}
function throwsContract(fn) {
  try { fn(); return null; } catch (e) { return e; }
}

/* ── 输入 schema / 校验 ─────────────────────────────────────────────────── */
function validation() {
  const good = mkInput([P('friend_a', 'active')]);
  ok('V1.validInputPasses', Core.validateParticipationInput(good).ok === true, Core.validateParticipationInput(good).errors);
  ok('V2.notAnObject', Core.validateParticipationInput(null).errors.indexOf('not-an-object') >= 0);
  ok('V3.missingGroupTurnId', Core.validateParticipationInput(mkInput([], { groupTurnId: '' })).errors.indexOf('missing-group-turn-id') >= 0);
  ok('V4.badGroupTurnId', Core.validateParticipationInput(mkInput([], { groupTurnId: 'turn_x' })).errors.indexOf('bad-group-turn-id') >= 0);
  ok('V5.missingTrigger', Core.validateParticipationInput({ groupTurnId: GT, participants: [] }).errors.indexOf('missing-trigger') >= 0);
  ok('V6.badUserMessageId', Core.validateParticipationInput(mkInput([], { trigger: { userMessageId: 'nope', text: '' } })).errors.indexOf('bad-user-message-id') >= 0);
  ok('V7.badTriggerText', Core.validateParticipationInput(mkInput([], { trigger: { userMessageId: UID, text: 42 } })).errors.indexOf('bad-trigger-text') >= 0);
  ok('V8.missingParticipants', Core.validateParticipationInput({ groupTurnId: GT, trigger: { userMessageId: UID } }).errors.indexOf('missing-participants') >= 0);
  ok('V9.badParticipants', Core.validateParticipationInput(mkInput(null, { participants: 'x' })).errors.indexOf('bad-participants') >= 0);
  const sec = mkInput([P('sk-abcdefgh12345', 'active')]);
  ok('V10.secretInStructuralField', Core.validateParticipationInput(sec).errors.indexOf('secret-in-input') >= 0, Core.validateParticipationInput(sec).errors);
  ok('V11.triggerTextIsNotSecretProbed',
    Core.validateParticipationInput(mkInput([P('friend_a', 'active')], { trigger: { userMessageId: UID, text: 'sk-abcdefgh12345 这是用户正文' } })).ok === true);
}

/* ── A–G + L/M/N/O · 规则表与形状 ───────────────────────────────────────── */
function ruleTable() {
  const a = Core.planParticipation(mkInput([P('friend_a', 'active')]));
  ok('A.activeDefaultSpeaks', a.entries.length === 1 && a.entries[0].speakerId === 'friend_a'
    && a.entries[0].decision === 'speak' && a.entries[0].order === 0 && a.entries[0].reason === 'active-default', a.entries);

  const b = Core.planParticipation(mkInput([P('friend_a', 'active', true)]));
  ok('B.activeMentionedKeepsSpeakWithMentionReason', b.entries.length === 1 && b.entries[0].decision === 'speak'
    && b.entries[0].order === 0 && b.entries[0].reason === 'mentioned', b.entries);

  const c = Core.planParticipation(mkInput([P('friend_a', 'muted')]));
  ok('C.mutedNotMentionedOmitted', c.entries.length === 0 && c.omitted.length === 1
    && c.omitted[0].reason === 'muted-not-mentioned' && c.omitted[0].speakerId === 'friend_a', c);

  const d = Core.planParticipation(mkInput([P('friend_a', 'muted', true)]));
  ok('D.mutedMentionedSpeaks', d.entries.length === 1 && d.entries[0].reason === 'mentioned' && d.entries[0].order === 0, d.entries);

  const e = Core.planParticipation(mkInput([P('friend_a', 'removed')]));
  ok('E.removedOmitted', e.entries.length === 0 && e.omitted.length === 1 && e.omitted[0].reason === 'removed', e);

  const f = Core.planParticipation(mkInput([P('friend_a', 'removed', true)]));
  ok('F.removedStillOmittedEvenMentioned', f.entries.length === 0 && f.omitted[0].reason === 'removed', f);

  const g = Core.planParticipation(mkInput([P('friend_a', 'active'), P('friend_b', 'muted'), P('friend_c', 'active')]));
  ok('G.orderSkipsOmittedParticipants', g.entries.map(x => x.speakerId + '#' + x.order).join(',') === 'friend_a#0,friend_c#1'
    && g.omitted.length === 1 && g.omitted[0].speakerId === 'friend_b', { entries: g.entries, omitted: g.omitted });

  const l = Core.planParticipation(mkInput([]));
  ok('L.emptyParticipantsIsValidEmptyPlan', l.entries.length === 0 && l.omitted.length === 0
    && l.plannerId === 'group-rule-v1' && l.planVersion === 3 && l.groupTurnId === GT, l);/* P24-M3.3.3.2：planVersion 2→3 */

  const m = Core.planParticipation(mkInput([P('friend_a', 'muted'), P('friend_b', 'removed')]));
  ok('M.allSkippedIsValidEmptyPlan', m.entries.length === 0 && m.omitted.length === 2
    && m.omitted.map(o => o.reason).join(',') === 'muted-not-mentioned,removed', m);

  const frozen = deepFreeze(mkInput([P('friend_a', 'active'), P('friend_b', 'muted', true), P('friend_c', 'removed')]));
  const snapshot = JSON.stringify(frozen);
  const frozenPlan = Core.planParticipation(frozen);
  ok('N.deepFrozenInputStillPlans', frozenPlan.entries.length === 2 && JSON.stringify(frozen) === snapshot);

  const src = mkInput([P('friend_a', 'active')]);
  const planForReuse = Core.planParticipation(src);
  planForReuse.entries[0].order = 999;
  planForReuse.entries[0].speakerId = 'tampered';
  ok('O.outputDoesNotReuseInputObjects', src.participants[0].id === 'friend_a'
    && src.participants[0].order === undefined
    && Core.planParticipation(src).entries[0].speakerId === 'friend_a');
}

/* ── I/J/K · fail closed（绝不静默跳过、绝不 normalize）────────────────── */
function failClosed() {
  const dup = throwsContract(() => Core.planParticipation(mkInput([P('friend_a', 'active'), P('friend_a', 'active')])));
  ok('I.duplicateIdsThrow', !!dup && dup.code === 'PARTICIPATION_CONTRACT'
    && dup.errors.join(',').indexOf('duplicate-participant-id:1') >= 0, dup && dup.errors);
  const badStatus = throwsContract(() => Core.planParticipation(mkInput([P('friend_a', 'sleeping')])));
  ok('J1.unknownStatusThrows', !!badStatus && badStatus.errors.join(',').indexOf('bad-participant-status:0') >= 0, badStatus && badStatus.errors);
  const noStatus = throwsContract(() => Core.planParticipation(mkInput([{ id: 'friend_a' }])));
  ok('J2.missingStatusThrows', !!noStatus && noStatus.errors.join(',').indexOf('missing-participant-status:0') >= 0, noStatus && noStatus.errors);
  const nullStatus = throwsContract(() => Core.planParticipation(mkInput([P('friend_a', null)])));
  ok('J3.nullStatusThrows', !!nullStatus && nullStatus.errors.join(',').indexOf('missing-participant-status:0') >= 0, nullStatus && nullStatus.errors);
  const emptyId = throwsContract(() => Core.planParticipation(mkInput([P('', 'active')])));
  ok('K1.emptyIdThrows', !!emptyId && emptyId.errors.join(',').indexOf('missing-participant-id:0') >= 0, emptyId && emptyId.errors);
  const groupAsId = throwsContract(() => Core.planParticipation(mkInput([P('group_9', 'active')])));
  ok('K2.groupIdAsSpeakerThrows', !!groupIdAsSpeakerThrowsCheck(groupAsId), groupAsId && groupAsId.errors);
  const badMention = throwsContract(() => Core.planParticipation(mkInput([{ id: 'friend_a', status: 'active', mentioned: 'yes' }])));
  ok('K3.nonBooleanMentionThrows', !!badMention && badMention.errors.join(',').indexOf('bad-mentioned:0') >= 0, badMention && badMention.errors);
}
function groupIdAsSpeakerThrowsCheck(e) {
  return !!e && e.code === 'PARTICIPATION_CONTRACT' && e.errors.join(',').indexOf('bad-participant-id:0') >= 0;
}

/* ── H · determinism + 无禁用 API ───────────────────────────────────────── */
function determinism() {
  const input = mkInput([P('friend_a', 'active'), P('friend_b', 'muted'), P('friend_c', 'muted', true), P('friend_d', 'removed')]);
  const first = Core.planParticipation(input);
  let stable = true;
  for (let i = 0; i < 100; i++) {
    try { assert.deepStrictEqual(Core.planParticipation(input), first); } catch (e) { stable = false; break; }
  }
  ok('H.sameInputHundredTimesDeepEqual', stable);
  const code = stripComments(read('assets/js/group-runtime-core.js'));
  const forbidden = ['Math.random', 'Date.now', 'performance.now', 'crypto.randomUUID', 'fetch(', 'dbPut',
    'indexedDB', 'document', 'setTimeout', 'setInterval', 'localStorage', 'XMLHttpRequest'];
  const hits = forbidden.filter(t => code.indexOf(t) >= 0);
  ok('R.noForbiddenApisInPlannerSource', hits.length === 0, hits);
  ok('T.noStorageReferences', ['chatMessages', 'appendChatBubble', 'dbDelete'].every(t => code.indexOf(t) < 0));
}

/* ── S/P/Q · 输出形状、正文与凭据边界 ──────────────────────────────────── */
function metadataSafety() {
  const input = mkInput([P('friend_a', 'active'), P('friend_b', 'muted', true), P('friend_c', 'removed')]);
  const plan = Core.planParticipation(input);
  const allKeys = keysDeep(plan);
  const allowedTop = ['groupTurnId', 'plannerId', 'planVersion', 'entries', 'omitted'];
  const allowedEntry = ['speakerId', 'decision', 'order', 'reason'];
  ok('S1.outputShapeClosed', Object.keys(plan).join(',') === allowedTop.join(',')
    && plan.entries.every(e => Object.keys(e).join(',') === allowedEntry.join(','))
    && plan.omitted.every(o => Object.keys(o).join(',') === 'speakerId,reason'), { keys: Object.keys(plan), allKeys });
  const forbiddenKeys = ['turnId', 'sequenceIndex', 'sequenceTotal', 'voice', 'image', 'delay', 'typing',
    'typingDuration', 'queue', 'content', 'text', 'prompt', 'persona', 'memory', 'apiKey', 'endpoint', 'authorization'];
  const bad = allKeys.filter(k => forbiddenKeys.indexOf(k) >= 0);
  ok('S2.noP23OrContentKeys', bad.length === 0, bad);
  ok('S3.noTurnIdOrSequenceFields', allKeys.join(',').indexOf('turnId') < 0 && allKeys.join(',').indexOf('sequence') < 0, allKeys);
  ok('P.outputCarriesNoTriggerText', JSON.stringify(plan).indexOf(SENTINEL) < 0);
  ok('Q.outputSecretProbeClean', VoiceCore.findSecret(plan) === '');
  const reasons = plan.entries.map(e => e.reason).concat(plan.omitted.map(o => o.reason));
  ok('Q2.reasonsAreClosedSet', reasons.every(r => Core.PARTICIPATION_REASONS.SPEAK.indexOf(r) >= 0 || Core.PARTICIPATION_REASONS.SKIP.indexOf(r) >= 0), reasons);
  /* P24-M3.3.2 更新：budget-limit 已从 RESERVED 转正为 SKIP，
     因此本断言收窄为"仍 reserved 的 no-config 永不产生"。 */
  ok('Q3.reservedReasonsNeverProduced', reasons.every(r => Core.PARTICIPATION_REASONS.RESERVED.indexOf(r) < 0)
    && Core.PARTICIPATION_REASONS.RESERVED.join(',') === 'no-config', Core.PARTICIPATION_REASONS.RESERVED);
  /* P24-M3.3.3.2 更新：planVersion 2 → 3（plannerId 不变）。 */
  ok('Q4.plannerIdsFrozen', plan.plannerId === 'group-rule-v1' && plan.planVersion === 3
    && Core.PARTICIPATION_PLANNER_ID === 'group-rule-v1' && Core.PARTICIPATION_PLAN_VERSION === 3,
    { plannerId: plan.plannerId, planVersion: plan.planVersion });
}

/* ── U/V/W · legacy 等价 + 无 history / text 依赖 ───────────────────────── */
function equivalenceAndIndependence() {
  const legacySelect = ps => ps.filter(p => {
    if (p.status === 'removed') return false;
    if (p.status === 'muted') return p.mentioned === true;
    return true;
  }).map(p => p.id);
  const cases = [
    [P('a', 'active')],
    [P('a', 'active', true), P('b', 'active')],
    [P('a', 'muted'), P('b', 'active')],
    [P('a', 'muted', true), P('b', 'muted')],
    [P('a', 'removed', true), P('b', 'active')],
    []
  ];
  const mismatches = cases.map((ps, i) => {
    const plan = Core.planParticipation(mkInput(ps));
    return plan.entries.map(e => e.speakerId).join(',') === legacySelect(ps).join(',') ? null : i;
  }).filter(x => x !== null);
  ok('U.plannerMatchesLegacySpeakingSemantics', mismatches.length === 0, mismatches);
  const comm = stripComments(read('assets/js/communication.js'));
  const raw = read('assets/js/communication.js');
  /* P24-M3.2 更新：生产参与权威已切换 —— 旧 `speakingCfgs` filter 不再存在（legacy
     nickname 判定也随之下线），循环遍历 planner 的 plan.entries。 */
  /* P24-M3.5.2A 更新：循环头改为 queue 驱动（runtime/static 双分支），
     "生产参与权威 = planner" 仍由 entries 驱动执行体现。 */
  ok('U2.productionAuthorityIsPlanner', /let _gRtCursor=0;/.test(comm)
    && /_gRtCursor>=plannedEntries\.length/.test(comm)
    && /planParticipation\(_gPlanInput\)/.test(comm)
    && !/speakingCfgs\s*=\s*memberCfgs\.filter/.test(comm)
    && !/if\(st==='removed'\)return false;/.test(raw));
  /* P24-M3.5.1A 更新：mention 解析不再直接进 planner —— 它先在**写入之前**把文本解析成
     canonical targetSpeakerIds（user 消息 metadata），再由结构化 reader/投影产 mentioned 布尔。
     守卫因此改为锁定新的唯一链路（解析一次 + 结构化写入 + 结构化读取/投影）。 */
  ok('U3.productionMentionBecomesCanonicalTargetIds',
    /resolveMentionTargets\(_ctxText\|\|'',_gMentionCandidates\)/.test(comm)
    && /metadata=\{targetSpeakerIds:_gTargetIds\}/.test(comm)
    && /resolveTargetSpeakerIds\(\{/.test(comm)
    && /projectTargetedParticipants\(/.test(comm)
    && !/_ctxText\.indexOf\('@'\+nm\)/.test(comm));
  ok('U4.communicationJsConsumesPlanner', comm.indexOf('planParticipation') > 0);

  const base = mkInput([P('a', 'active'), P('b', 'muted')]);
  const withHistory1 = mkInput([P('a', 'active'), P('b', 'muted')], { history: [] });
  const withHistory2 = mkInput([P('a', 'active'), P('b', 'muted')], { history: [{ role: 'assistant', content: 'x', metadata: { speakerId: 'friend_zzz' } }] });
  ok('V1.historyEmptyIsIgnored', JSON.stringify(Core.planParticipation(withHistory1)) === JSON.stringify(Core.planParticipation(base)));
  ok('V2.historyContentIsIgnored', JSON.stringify(Core.planParticipation(withHistory2)) === JSON.stringify(Core.planParticipation(base)));
  /* P24-M3.3.3.1 更新：同一个文件里现在还有 recent-speaker helper（它的参数就叫 history）。
     不变量本身不变 —— **planner 本体**不读 history：把扫描范围收窄到 planner 的功能区
     （validateParticipationInput + planParticipation），而不是整文件。 */
  const coreCode = stripComments(read('assets/js/group-runtime-core.js'));
  const plannerRegion = coreCode.slice(coreCode.indexOf('function validateParticipationInput'), coreCode.lastIndexOf('  return {'));
  ok('V3.historyIsNotReadByPlanner', plannerRegion.length > 0 && plannerRegion.indexOf('history') < 0);

  const t1 = mkInput([P('a', 'active'), P('b', 'muted', true)], { trigger: { userMessageId: UID, text: '完全不同的文本' } });
  const t2 = mkInput([P('a', 'active'), P('b', 'muted', true)], { trigger: { userMessageId: UID, text: 'SENTINEL_TEXT_9f3a1c @初音未来 @friend_b' } });
  ok('W1.triggerTextDoesNotAffectPlan', JSON.stringify(Core.planParticipation(t1)) === JSON.stringify(Core.planParticipation(t2)));
  ok('W2.plannerNeverParsesMentionText', stripComments(read('assets/js/group-runtime-core.js')).indexOf("indexOf('@") < 0);
}

/* ── P24-M3.3.2 · Budget（maxResponders / budget-limit）───────────────────── */
function budgetContract() {
  const four = [P('A', 'active'), P('B', 'active'), P('C', 'active', true), P('D', 'active', true)];
  const ids = plan => plan.entries.map(e => e.speakerId).join(',');
  const spkOrder = plan => plan.entries.map(e => e.speakerId + '#' + e.order).join(',');

  /* B1 · maxResponders undefined ⇒ 与旧语义相同（participant 顺序），但 planVersion = 3 */
  const noCap = Core.planParticipation(mkInput(four));
  ok('B1.undefinedIsUnlimitedWithV2', spkOrder(noCap) === 'A#0,B#1,C#2,D#3' && noCap.omitted.length === 0
    && noCap.planVersion === 3 && noCap.plannerId === 'group-rule-v1', { spkOrder: spkOrder(noCap), v: noCap.planVersion });

  /* B2 · null ⇒ unlimited */
  const nullCap = Core.planParticipation(mkInput(four, { maxResponders: null }));
  ok('B2.nullIsUnlimited', JSON.stringify(nullCap) === JSON.stringify(noCap));

  /* B3 · k=0 ⇒ 合法空计划 + eligible 全 budget-limit（非 eligible 保持自己的 reason） */
  const zero = Core.planParticipation(mkInput([P('A', 'active'), P('B', 'removed'), P('C', 'muted')], { maxResponders: 0 }));
  ok('B3.zeroIsValidEmptyPlan', zero.entries.length === 0
    && zero.omitted.map(o => o.speakerId + ':' + o.reason).join(',') === 'A:budget-limit,B:removed,C:muted-not-mentioned', zero);

  /* B4 · k=1 */
  const one = Core.planParticipation(mkInput(four, { maxResponders: 1 }));
  ok('B4.k1SelectsOneWithOrder0', one.entries.length === 1 && one.entries[0].order === 0
    && one.entries[0].speakerId === 'C' && one.omitted.length === 3, one);

  /* B5/B6 · k=N、k>N ⇒ 与 unlimited 等价（不 reorder） */
  ok('B5.kEqualsNIsUnlimited', JSON.stringify(Core.planParticipation(mkInput(four, { maxResponders: 4 }))) === JSON.stringify(noCap));
  ok('B6.kGreaterThanNIsUnlimited', JSON.stringify(Core.planParticipation(mkInput(four, { maxResponders: 99 }))) === JSON.stringify(noCap));

  /* B7 · 非法 cap ⇒ validation fail + contract throw（无隐式转换） */
  const badCaps = [-1, 1.5, '2', NaN, Infinity, true, {}, []];
  ok('B7.invalidCapsFailClosed', badCaps.every(v => {
    const input = mkInput([P('A', 'active')], { maxResponders: v });
    const verdict = Core.validateParticipationInput(input);
    const thrown = throwsContract(() => Core.planParticipation(input));
    return verdict.ok === false && verdict.errors.indexOf('bad-max-responders') >= 0
      && !!thrown && thrown.code === 'PARTICIPATION_CONTRACT' && thrown.errors.indexOf('bad-max-responders') >= 0;
  }), badCaps.map(v => Core.validateParticipationInput(mkInput([P('A', 'active')], { maxResponders: v })).errors));

  /* B8/B9 · reason 词表：budget-limit ∈ SKIP；no-config 仍 reserved 且永不产生 */
  ok('B8.budgetLimitIsActiveSkipReason', Core.PARTICIPATION_REASONS.SKIP.indexOf('budget-limit') >= 0
    && Core.PARTICIPATION_REASONS.RESERVED.indexOf('budget-limit') < 0);
  const allReasons = [noCap, one, zero].reduce((acc, pl) => acc.concat(pl.entries.map(e => e.reason), pl.omitted.map(o => o.reason)), []);
  ok('B9.noConfigStaysReservedAndNeverProduced', Core.PARTICIPATION_REASONS.RESERVED.join(',') === 'no-config'
    && allReasons.every(r => r !== 'no-config'));

  /* B10/B11 · 3 mentioned + 1 unmentioned、k=2 ⇒ 前两位 mentioned；溢出按 participant 顺序 */
  const threeMentioned = [P('A', 'active', true), P('B', 'active', true), P('C', 'active', true), P('D', 'active')];
  const m10 = Core.planParticipation(mkInput(threeMentioned, { maxResponders: 2 }));
  ok('B10.mentionedWinsUnderCompetition', spkOrder(m10) === 'A#0,B#1' && ids(m10) === 'A,B'
    && m10.omitted.map(o => o.speakerId + ':' + o.reason).join(',') === 'C:budget-limit,D:budget-limit', m10);
  const m11 = Core.planParticipation(mkInput([P('A', 'active'), P('B', 'active'), P('C', 'active', true), P('D', 'active', true)], { maxResponders: 2 }));
  ok('B11.mentionedOverflowKeepsParticipantOrder', spkOrder(m11) === 'C#0,D#1'
    && m11.omitted.map(o => o.speakerId).join(',') === 'A,B', m11);

  /* B12/B13/B14/B15 · 无真实竞争 ⇒ 绝不 reorder（提到的顺序必须保持 participant order） */
  const ab = [P('A', 'active'), P('B', 'active', true)];
  ok('B12.noCompetitionDoesNotReorder', spkOrder(Core.planParticipation(mkInput(ab, { maxResponders: 2 }))) === 'A#0,B#1',
    Core.planParticipation(mkInput(ab, { maxResponders: 2 })).entries);
  ok('B13.kEqualsNNoReorder', spkOrder(Core.planParticipation(mkInput(four, { maxResponders: 4 }))) === 'A#0,B#1,C#2,D#3');
  ok('B14.kGreaterThanNNoReorder', spkOrder(Core.planParticipation(mkInput(four, { maxResponders: 5 }))) === 'A#0,B#1,C#2,D#3');
  ok('B15.unlimitedNoReorder', spkOrder(noCap) === 'A#0,B#1,C#2,D#3');

  /* B16/B17/B18 · 只有 eligible 参与 budget competition */
  const mixed = [P('A', 'removed', true), P('B', 'muted'), P('C', 'muted', true), P('D', 'active')];
  const mB = Core.planParticipation(mkInput(mixed, { maxResponders: 1 }));
  ok('B16.removedNotInCompetition', mB.omitted.some(o => o.speakerId === 'A' && o.reason === 'removed') && ids(mB).indexOf('A') < 0);
  ok('B17.mutedUnmentionedNotInCompetition', mB.omitted.some(o => o.speakerId === 'B' && o.reason === 'muted-not-mentioned'));
  ok('B18.mutedMentionedIsInCompetition', ids(mB) === 'C' && mB.omitted.some(o => o.speakerId === 'D' && o.reason === 'budget-limit'), mB);

  /* B19/B20/B21 · order 0..k-1、omitted 无 order、omitted 保持 participant 顺序 */
  const b19 = Core.planParticipation(mkInput(four, { maxResponders: 2 }));
  ok('B19.orderIsContiguousZeroToKMinus1', b19.entries.map(e => e.order).join(',') === '0,1');
  ok('B20.omittedHasNoOrder', b19.omitted.every(o => !('order' in o) && Object.keys(o).join(',') === 'speakerId,reason'));
  const b21 = Core.planParticipation(mkInput([P('A', 'active'), P('B', 'removed'), P('C', 'active', true), P('D', 'muted')], { maxResponders: 1 }));
  ok('B21.omittedKeepsParticipantOrder', b21.omitted.map(o => o.speakerId + ':' + o.reason).join(',')
    === 'A:budget-limit,B:removed,D:muted-not-mentioned', b21.omitted);

  /* B22/B23 · determinism ×100 + deepFreeze（带 cap） */
  const capInput = mkInput(four, { maxResponders: 2 });
  const capFirst = Core.planParticipation(capInput);
  let capStable = true;
  for (let i = 0; i < 100; i++) {
    try { assert.deepStrictEqual(Core.planParticipation(capInput), capFirst); } catch (e) { capStable = false; break; }
  }
  ok('B22.budgetPlanDeterministicX100', capStable);
  const frozenCap = deepFreeze(mkInput(four, { maxResponders: 2 }));
  const frozenSnap = JSON.stringify(frozenCap);
  const frozenPlan = Core.planParticipation(frozenCap);
  ok('B23.deepFrozenInputWithCapStillPlans', frozenPlan.entries.length === 2 && JSON.stringify(frozenCap) === frozenSnap);

  /* B24/B25 · output 不含 maxResponders / trigger.text */
  ok('B24.outputHasNoMaxResponders', !('maxResponders' in capFirst) && allKeysOf(capFirst).indexOf('maxResponders') < 0, allKeysOf(capFirst));
  ok('B25.outputCarriesNoTriggerText', JSON.stringify(capFirst).indexOf(SENTINEL) < 0);

  /* B26 · source guard：budget selection 只存在于 planner；生产 adapter 不传 cap */
  const core = stripComments(read('assets/js/group-runtime-core.js'));
  const comm = stripComments(read('assets/js/communication.js'));
  /* P24-M3.4.2 更新：adapter 现在**合法**引用 maxResponders（resolver 结果 → planner input 的
     条件映射）。阶段边界守卫因此从"communication.js 不得出现该词"改为**更强的形状约束**：
     production 里没有字面 cap 键、没有硬编码数值、只有唯一一处条件赋值；budget-limit 仍只在 planner。 */
  const commRaw = read('assets/js/communication.js');
  ok('B26.budgetSelectionLivesOnlyInPlanner', /budget-limit/.test(core) && /maxResponders/.test(core)
    && comm.indexOf('budget-limit') < 0
    && (comm.match(/maxResponders:/g) || []).length === 0
    && (comm.match(/\.maxResponders=/g) || []).length === 1
    && !/maxResponders\s*[:=]\s*\d/.test(comm), {
      literals: (comm.match(/maxResponders:/g) || []).length,
      assigns: (comm.match(/\.maxResponders=/g) || []).length,
      raw: commRaw.indexOf('maxResponders') >= 0
    });
  ok('B26b.productionRuntimeLoopHasNoBudgetLogic', !/slice\(0,\s*maxResponders\)/.test(comm)
    && !/startedCount\s*>=/.test(comm) && !/break[^\n]*budget/i.test(comm));
  /* P24-M3.4.2 更新：同上 —— 生产 adapter 已接 resolver，cap 只能**条件**来自 resolved policy；
     "adapter 默认不传 cap" 由集成测试的运行期断言锁定（planner input 无 cap 自有键）。 */
  ok('B26c.productionNeverHardcodesCap', (comm.match(/maxResponders:/g) || []).length === 0
    && !/maxResponders\s*[:=]\s*\d/.test(comm)
    && /Object\.prototype\.hasOwnProperty\.call\(_gResolvedPolicy\.policy,'maxResponders'\)/.test(comm),
    { literals: (comm.match(/maxResponders:/g) || []).length });
}
function allKeysOf(v, out) {
  out = out || [];
  if (Array.isArray(v)) v.forEach(x => allKeysOf(x, out));
  else if (v && typeof v === 'object') Object.keys(v).forEach(k => { out.push(k); allKeysOf(v[k], out); });
  return out;
}

/* ── P24-M3.3.3.2 · recentSpeakerIds / contract v3 ───────────────────────── */
function recentSpeakerContract() {
  const spk = plan => plan.entries.map(e => e.speakerId + '#' + e.order).join(',');
  const omit = plan => plan.omitted.map(o => o.speakerId + ':' + o.reason).join(',');
  const A3 = [P('A', 'active'), P('B', 'active'), P('C', 'active', true)];

  /* RS1/RS2 · 缺失与 [] 等价（且不 reorder） */
  const noRecent = Core.planParticipation(mkInput(A3, { maxResponders: 2 }));
  ok('RS1.missingRecentMatchesV2Semantics', spk(noRecent) === 'C#0,A#1' && omit(noRecent) === 'B:budget-limit'
    && noRecent.planVersion === 3, noRecent);
  ok('RS2.emptyRecentEqualsMissing', JSON.stringify(Core.planParticipation(mkInput(A3, { maxResponders: 2, recentSpeakerIds: [] }))) === JSON.stringify(noRecent));

  /* RS3/RS4/RS5/RS6 · fail closed */
  ok('RS3.nullRecentFailsClosed', throwsContract(() => Core.planParticipation(mkInput(A3, { recentSpeakerIds: null })))
    && Core.validateParticipationInput(mkInput(A3, { recentSpeakerIds: null })).errors.indexOf('bad-recent-speakers') >= 0);
  ok('RS4.nonArrayRecentFailsClosed', ['A', { 0: 'A' }, 1, true].every(v => {
    const e = throwsContract(() => Core.planParticipation(mkInput(A3, { recentSpeakerIds: v })));
    return !!e && e.errors.indexOf('bad-recent-speakers') >= 0;
  }));
  ok('RS5.invalidElementFailsClosed', ['', null, 1, {}, []].every(v => {
    const e = throwsContract(() => Core.planParticipation(mkInput(A3, { recentSpeakerIds: [v] })));
    return !!e && e.errors.indexOf('bad-recent-speakers') >= 0;
  }));
  ok('RS6.nonParticipantIdFailsClosed', (() => {
    const e = throwsContract(() => Core.planParticipation(mkInput(A3, { recentSpeakerIds: ['ZZZ'] })));
    const e2 = throwsContract(() => Core.planParticipation(mkInput(A3, { recentSpeakerIds: ['sk-abcdefgh12345'] })));
    return !!e && e.errors.indexOf('bad-recent-speakers') >= 0 && !!e2 && e2.errors.indexOf('bad-recent-speakers') >= 0;
  })());

  /* RS7/RS8 · 重复接受 + 归一确定性 */
  ok('RS7.duplicateRecentAccepted', (() => {
    const withDup = Core.planParticipation(mkInput(A3, { maxResponders: 2, recentSpeakerIds: ['A', 'A', 'B', 'A'] }));
    /* membership = {A,B} ⇒ tier1=[C] / tier3=[A,B] ⇒ cap=2 取 C,A（tier 内 participant order） */
    return spk(withDup) === 'C#0,A#1' && omit(withDup) === 'B:budget-limit';
  })());
  ok('RS8.duplicateNormalizationDeterministic', (() => {
    const withDup = Core.planParticipation(mkInput(A3, { maxResponders: 2, recentSpeakerIds: ['A', 'A', 'B', 'A'] }));
    const normalized = Core.planParticipation(mkInput(A3, { maxResponders: 2, recentSpeakerIds: ['A', 'B'] }));
    return JSON.stringify(withDup) === JSON.stringify(normalized);
  })());

  /* RS9/RS10 · 无竞争 ⇒ 绝不 reorder */
  ok('RS9.unlimitedIgnoresRecent', (() => {
    const a = Core.planParticipation(mkInput(A3, { recentSpeakerIds: ['A'] }));
    const b = Core.planParticipation(mkInput(A3));
    return JSON.stringify(a) === JSON.stringify(b) && spk(a) === 'A#0,B#1,C#2';
  })());
  ok('RS10.capAtOrAboveEligibleIgnoresRecent', (() => {
    const a = Core.planParticipation(mkInput(A3, { maxResponders: 3, recentSpeakerIds: ['A'] }));
    const b = Core.planParticipation(mkInput(A3, { maxResponders: 3 }));
    return JSON.stringify(a) === JSON.stringify(b) && spk(a) === 'A#0,B#1,C#2';
  })());

  /* RS11 · 核心行为：真实竞争下 fresh unmentioned 胜过 recent unmentioned */
  ok('RS11.freshBeatsRecentUnderCompetition', (() => {
    const plan = Core.planParticipation(mkInput(A3, { maxResponders: 2, recentSpeakerIds: ['A'] }));
    return spk(plan) === 'C#0,B#1' && omit(plan) === 'A:budget-limit';
  })());
  /* RS12 · mentioned 豁免 recent penalty */
  ok('RS12.mentionedRecentBeatsFreshUnmentioned', (() => {
    const plan = Core.planParticipation(mkInput([P('A', 'active', true), P('B', 'active')], { maxResponders: 1, recentSpeakerIds: ['A'] }));
    return spk(plan) === 'A#0' && omit(plan) === 'B:budget-limit';
  })());
  /* RS13 · mentioned tier 内按 participant 顺序（与 recent 无关） */
  ok('RS13.mentionedTierUsesParticipantOrder', (() => {
    const plan = Core.planParticipation(mkInput([P('A', 'active', true), P('B', 'active', true)], { maxResponders: 1, recentSpeakerIds: ['B'] }));
    return spk(plan) === 'A#0' && omit(plan) === 'B:budget-limit';
  })());
  /* RS14/RS15 · tier 内 participant 顺序；recent 数组顺序不参与排序 */
  ok('RS14.multipleFreshUseParticipantOrder', (() => {
    const plan = Core.planParticipation(mkInput([P('A', 'active'), P('B', 'active'), P('C', 'active'), P('D', 'active')], { maxResponders: 2, recentSpeakerIds: ['C', 'D'] }));
    return spk(plan) === 'A#0,B#1' && omit(plan) === 'C:budget-limit,D:budget-limit';
  })());
  ok('RS15.recentArrayOrderDoesNotReorderTier', (() => {
    const plan = Core.planParticipation(mkInput([P('A', 'active'), P('B', 'active'), P('C', 'active'), P('D', 'active')], { maxResponders: 3, recentSpeakerIds: ['B', 'A'] }));
    return spk(plan) === 'C#0,D#1,A#2' && omit(plan) === 'B:budget-limit';
  })());
  /* RS16 · k=0 */
  ok('RS16.k0WithRecentStillEmptyPlan', (() => {
    const plan = Core.planParticipation(mkInput(A3, { maxResponders: 0, recentSpeakerIds: ['A', 'C'] }));
    return plan.entries.length === 0 && omit(plan) === 'A:budget-limit,B:budget-limit,C:budget-limit';
  })());
  /* RS17–RS19 · eligibility 不受 recent 影响 */
  ok('RS17.removedRecentStaysRemoved', (() => {
    const plan = Core.planParticipation(mkInput([P('A', 'removed'), P('B', 'active')], { maxResponders: 1, recentSpeakerIds: ['A'] }));
    return omit(plan) === 'A:removed' && spk(plan) === 'B#0';
  })());
  ok('RS18.mutedUnmentionedRecentStaysMutedNotMentioned', (() => {
    const plan = Core.planParticipation(mkInput([P('A', 'muted'), P('B', 'active')], { maxResponders: 1, recentSpeakerIds: ['A'] }));
    return omit(plan) === 'A:muted-not-mentioned' && spk(plan) === 'B#0';
  })());
  ok('RS19.mutedMentionedRecentJoinsTier1', (() => {
    const plan = Core.planParticipation(mkInput([P('A', 'muted', true), P('B', 'active')], { maxResponders: 1, recentSpeakerIds: ['A'] }));
    return spk(plan) === 'A#0' && plan.entries[0].reason === 'mentioned' && omit(plan) === 'B:budget-limit';
  })());
  /* RS20/RS21/RS22 · omitted 顺序、order 连续、overflow reason */
  const rs20 = Core.planParticipation(mkInput([P('A', 'active'), P('B', 'removed'), P('C', 'active'), P('D', 'muted')], { maxResponders: 1, recentSpeakerIds: ['A'] }));
  ok('RS20.omittedKeepsParticipantOrder', omit(rs20) === 'A:budget-limit,B:removed,D:muted-not-mentioned', rs20.omitted);
  ok('RS21.orderIsContiguous', rs20.entries.map(e => e.order).join(',') === '0');
  ok('RS22.budgetLimitIsOnlyOverflowReason', omit(rs20).indexOf('recent') < 0
    && JSON.stringify(rs20).indexOf('recent') < 0 && JSON.stringify(rs20).indexOf('tier') < 0 && JSON.stringify(rs20).indexOf('fresh') < 0);
  /* RS23–RS25 · 词表与版本 */
  ok('RS23.reasonVocabularyUnchanged',
    JSON.stringify(Core.PARTICIPATION_REASONS.SPEAK) === JSON.stringify(['active-default', 'mentioned'])
    && JSON.stringify(Core.PARTICIPATION_REASONS.SKIP) === JSON.stringify(['muted-not-mentioned', 'removed', 'budget-limit'])
    && JSON.stringify(Core.PARTICIPATION_REASONS.RESERVED) === JSON.stringify(['no-config']));
  ok('RS24.planVersionIsThree', Core.PARTICIPATION_PLAN_VERSION === 3 && noRecent.planVersion === 3);
  ok('RS25.plannerIdUnchanged', Core.PARTICIPATION_PLANNER_ID === 'group-rule-v1' && noRecent.plannerId === 'group-rule-v1');
  /* RS26/RS27 · 输出不泄露 recent 派生物 */
  const rs26 = Core.planParticipation(mkInput(A3, { maxResponders: 2, recentSpeakerIds: ['A'] }));
  const rsKeys = allKeysOf(rs26).join(',');
  ok('RS26.outputExcludesRecentSpeakerIds', !('recentSpeakerIds' in rs26) && rsKeys.indexOf('recentSpeakerIds') < 0);
  ok('RS27.outputExcludesTierFreshHistory', ['tier', 'fresh', 'history', 'priority', 'selectionScore', 'maxResponders'].every(k => rsKeys.indexOf(k) < 0), rsKeys);
  /* RS28/RS29 · immutability + determinism */
  const frozenCap = deepFreeze({ maxResponders: 2, recentSpeakerIds: Object.freeze(['A', 'A', 'B']) });
  const frozenInput = deepFreeze(mkInput([P('A', 'active'), P('B', 'active'), P('C', 'active', true)], frozenCap));
  const frozenSnap = JSON.stringify(frozenInput);
  const frozenPlan = Core.planParticipation(frozenInput);
  ok('RS28.deepFrozenRecentInputStillPlans', spk(frozenPlan) === 'C#0,A#1' && JSON.stringify(frozenInput) === frozenSnap);
  const rsInput = mkInput(A3, { maxResponders: 2, recentSpeakerIds: ['A'] });
  const rsFirst = Core.planParticipation(rsInput);
  let rsStable = true;
  for (let i = 0; i < 100; i++) {
    try { assert.deepStrictEqual(Core.planParticipation(rsInput), rsFirst); } catch (e) { rsStable = false; break; }
  }
  ok('RS29.deterministicX100', rsStable);
  /* RS30–RS32 · source guards */
  const coreCode2 = stripComments(read('assets/js/group-runtime-core.js'));
  const plannerCode2 = coreCode2.slice(coreCode2.indexOf('function validateParticipationInput'), coreCode2.lastIndexOf('  return {'));
  ok('RS30.plannerNeverCallsDeriveHelper', plannerCode2.indexOf('deriveRecentSpeakerIds(') < 0);
  const commCode = stripComments(read('assets/js/communication.js'));
  /* P24-M3.3.3.3 更新：本阶段 production adapter 已接线 recent（planner input 合法出现
     `recentSpeakerIds`），因此 .2 的"communication.js 不得出现 recentSpeakerIds"这条
     阶段边界守卫改为**接线仍然唯一且不外泄**：planner input 里恰好 1 个 recent key，
     且绝不写进 canonical message metadata / 绝不随 dbPut 落库 / 绝不进 system prompt。 */
  ok('RS31.productionRecentInputIsSingleAndSealed',
    (commCode.match(/recentSpeakerIds:/g) || []).length === 1
    && !/metadata[^\n]{0,60}recentSpeakerIds/.test(commCode)
    && !/dbPut\([^\n]{0,160}recentSpeakerIds/.test(commCode)
    && !/recentSpeakerIds[^\n]{0,40}(system|sysContent)/.test(commCode), {
      keys: (commCode.match(/recentSpeakerIds:/g) || []).length
    });
  ok('RS32.budgetTruncationStillOnlyInPlanner', commCode.indexOf('budget-limit') < 0
    && !/slice\(0,\s*maxResponders\)/.test(commCode) && plannerCode2.indexOf('selectionOrder.slice(0, cap)') >= 0);
}

function main() {
  console.log('== P24-M3.1／M3.3.2／M3.3.3.2 · Participation Contract + Deterministic Rule Planner 测试 ==');
  validation();
  ruleTable();
  failClosed();
  determinism();
  metadataSafety();
  equivalenceAndIndependence();
  budgetContract();
  recentSpeakerContract();
  console.log(failures === 0 ? '\n全部通过 ✔  (' + passes + ')' : '\n失败 ' + failures + ' 项（通过 ' + passes + '）');
  process.exitCode = failures ? 1 : 0;
}

main();
