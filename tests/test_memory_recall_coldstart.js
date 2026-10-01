'use strict';
/* Internal Beyond · P21-R2-E1b · ColdStart Retrieval（Node，零依赖）
   运行：node tests/test_memory_recall_coldstart.js

   被测：coldstart-anchor.js（admission）+ orchestrator 的 coldStart 通道。
   最重要的反向证明：**selectedIds 非空 且 activation 为 0**（§18/§21/§36）。
   ══════════════════════════════════════════════════════════════════════════ */

const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const ORCH = require(path.join(ROOT, 'assets/js/memory-recall/memory-recall-orchestrator.js'));
const CA = require(path.join(ROOT, 'assets/js/memory-recall/coldstart-anchor.js'));
const CP = require(path.join(ROOT, 'assets/js/memory-recall/channel-policy.js'));

let failures = 0, passed = 0;
const check = (n, c, d) => { if (c) { passed++; console.log('  PASS  ' + n); } else { failures++; console.error('  FAIL  ' + n + (d !== undefined ? '  -> ' + d : '')); } };
const section = t => console.log('\n── ' + t + ' ──');

const NOW = 1750000000000, DAY = 86400000;
const mk = o => Object.assign({ id: 'm', title: '记录', content: '正文', importance: 5, arousal: .3,
  resolved: false, activationCount: 0, created: NOW - DAY, lastActivated: NOW - DAY,
  visibility: 'public', tags: [], domain: '日常' }, o || {});
const BASE = { apiId: 'role_a', now: NOW, random: () => .42, isGroup: false, groupMemEnabled: false, maxChars: 2000, contentLen: 200 };

const RECS = [
  mk({ id: 'pin', title: '置顶锚点', content: 'pinned 内容', pinned: true, importance: 9 }),
  mk({ id: 'sem', title: '语义锚点', content: 'semantic 内容', kind: 'semantic', importance: 8 }),
  mk({ id: 'manual', title: '手写', content: 'manual 内容', source: 'manual', importance: 9 }),
  mk({ id: 'epi', title: '普通经历', content: 'episodic 内容', importance: 7 }),
  mk({ id: 'hidPin', title: '隐藏置顶', content: 'hidden', pinned: true, visibility: 'private' }),
  mk({ id: 'hidSem', title: '隐藏语义', content: 'hidden', kind: 'semantic', visibility: 'private' }),
  mk({ id: 'resPin', title: '已解决置顶', content: 'resolved', pinned: true, resolved: true }),
  mk({ id: 'resSem', title: '已解决语义', content: 'resolved', kind: 'semantic', resolved: true })
];

const csTurn = (extra) => Object.assign({ conversationSignalAvailable: true, isFirstTurn: true, conversationId: 'dm:role_a' }, extra || {});
const run = (msg, turnExtra, opts) => ORCH.recall(RECS, Object.assign({}, BASE,
  { userMessage: msg }, opts || {}, { turn: Object.assign({ message: msg }, csTurn(turnExtra)) }));

/* ══ §1 · admission（8–12, 34, 35）══ */
section('§1 · admission');
check('8.visiblePinnedAdmitted', CA.isAnchorEligible({ pinned: true }) === true);
check('9.visibleSemanticAdmitted', CA.isAnchorEligible({ kind: 'semantic' }) === true);
check('10.manualOnlyExcluded', CA.isAnchorEligible({ source: 'manual' }) === false,
  'manual is provenance, not stability — it must not buy admission on its own');
check('34.noSourceManualAdmission', CA.anchorAdmission({ source: 'manual' }) === null);
check('11.resolvedPinnedStillEligible', CA.isAnchorEligible({ pinned: true, resolved: true }) === true,
  'evidence only shows resolved affects decay lambda, not anchor worthiness');
check('12.resolvedSemanticStillEligible', CA.isAnchorEligible({ kind: 'semantic', resolved: true }) === true);
check('35.noResolvedHardExclusion', (() => {
  const r = CA.selectEligibleAnchors([{ id: 'a', pinned: true, resolved: true }, { id: 'b', kind: 'semantic', resolved: true }]);
  return r.anchors.length === 2;
})(), 'resolved must NOT be a hard exclusion');
check('admissionIsPinnedOrSemanticOnly', (() => {
  const rows = [{ pinned: true }, { kind: 'semantic' }, { source: 'manual' }, { importance: 10 }, { resolved: false }, {}];
  const r = CA.selectEligibleAnchors(rows);
  return r.anchors.length === 2;
})());
check('noPhantomFieldAdmission', (() => {
  /* identity / relationship / promise 等字段在本仓库**不存在** ⇒ 不得凭名字实现。 */
  return ['identity', 'relationship', 'promise', 'anchor'].every(k => CA.isAnchorEligible({ [k]: true }) === false);
})());

/* ══ §2 · visibility 先于 admission（6–7, 13）══ */
section('§2 · visibility');
check('6.privatePinnedExcluded', (() => {
  const r = run('嗯');
  return r.result.selected.map(s => s.id).indexOf('hidPin') < 0;
})());
check('7.hiddenSemanticExcluded', (() => {
  const r = run('嗯');
  return r.result.selected.map(s => s.id).indexOf('hidSem') < 0;
})());
check('13.visibilityRunsBeforeAnchorAdmission', (() => {
  /* anchor 模块只看得到 visible ⇒ hidden pinned 永远不会出现在 admitted 里 */
  const r = run('嗯');
  const ids = r.trace.candidates.map(c => c.memoryId);
  return ids.indexOf('hidPin') < 0 && ids.indexOf('hidSem') < 0
    && JSON.stringify(r.trace).indexOf('隐藏置顶') < 0;
})(), 'hidden anchors must not leak id, title or existence into the trace');

/* ══ §3 · 触发条件（1–5, 21–23）══ */
section('§3 · 触发条件');
check('1.firstTurnNormalTextColdStarts', run('你好呀').trace.channel === 'coldStart');
check('2.firstTurnAcknowledgementColdStarts', (() => {
  const r = run('嗯');
  return r.trace.channel === 'coldStart' && r.result.reason === null;
})(), 'a first-turn acknowledgement is exactly when coldStart matters most');
check('3.firstTurnExplicitRecallRecalls', run('你还记得上次那个显卡吗').trace.channel === 'recall',
  'explicit recall must beat automatic coldStart');
check('4.nonFirstAcknowledgementEarlyExits', (() => {
  const r = run('嗯', { isFirstTurn: false });
  return r.result.reason === 'early-exit' && r.trace.channel === null;
})());
check('5.nonFirstNormalIsSurface', (() => {
  const r = run('置顶锚点', { isFirstTurn: false });
  return r.trace.channel === 'surface';
})());
check('21.signalUnavailableNoColdStart', (() => {
  const r = run('嗯', { conversationSignalAvailable: false });
  return r.trace.channel !== 'coldStart';
})());
check('22.missingConversationIdNoColdStart', (() => {
  const r = run('嗯', { conversationId: null });
  return r.trace.channel !== 'coldStart';
})());
check('22.emptyConversationIdNoColdStart', (() => {
  const r = run('嗯', { conversationId: '' });
  return r.trace.channel !== 'coldStart';
})());
check('23.groupNeverAutoColdStarts', (() => {
  const r = ORCH.recall(RECS, Object.assign({}, BASE, { isGroup: true, userMessage: '嗯' },
    { turn: Object.assign({ message: '嗯' }, csTurn()) }));
  return r.trace.channel !== 'coldStart';
})(), 'group coldStart remains unavailable (product semantics undecided)');
check('23.groupStillDecidesNormally', (() => {
  const r = ORCH.recall(RECS, Object.assign({}, BASE, { isGroup: true, groupMemEnabled: true, userMessage: '嗯' },
    { turn: Object.assign({ message: '嗯' }, csTurn()) }));
  return r.result.reason === 'early-exit';
})());
check('20.oneShotViaSecondTurn', (() => {
  const first = run('嗯', { isFirstTurn: true });
  const second = run('嗯', { isFirstTurn: false });
  return first.trace.channel === 'coldStart' && second.trace.channel !== 'coldStart';
})(), 'one-shot authority is the Host isFirstTurn, not a retrieval seen-set');

/* ══ §4 · 无 lexical 准入（14, 18, 19）══ */
section('§4 · 无 lexical 准入');
check('14.coldStartDoesNotUseLexicalGate', (() => {
  /* 第一句与所有 anchor 零词元重叠，仍必须得到 anchor。 */
  const r = run('嗯');
  return r.result.selected.length > 0;
})());
check('18.noScoreRelevanceForAnchors', (() => {
  const r = run('嗯');
  return r.trace.candidates.every(c => c.relevanceScore === null);
})(), 'admission is not lexical ⇒ relevanceScore must be null, never a fabricated number');
check('19.currentUserTermsDoNotAffectAdmission', (() => {
  const a = run('嗯').result.selected.map(s => s.id).sort();
  const b = run('完全无关的另一句话').result.selected.map(s => s.id).sort();
  return JSON.stringify(a) === JSON.stringify(b);
})(), 'anchor set must not be perturbed by the first sentence tokens');

/* ══ §5 · selection / seat / budget / renderer（15–17, 31）══ */
section('§5 · selection');
check('15.seatCapInheritsSurface', (() => {
  const pol = CP.resolveChannelPolicy('coldStart').policy;
  return pol.maxTotalSeats === CP.MAX_SURFACE_TOTAL_SEATS && pol.maxTotalSeats === 3;
})(), 'no new magic number — the cap inherits the surface constant');
check('15.selectedNeverExceedsCap', run('嗯').result.selected.length <= CP.MAX_SURFACE_TOTAL_SEATS);
check('16.sharedMaxCharsSingleBudget', (() => {
  const r = run('嗯');
  return r.result.chars <= BASE.maxChars;
})(), 'coldStart owns the turn ⇒ one block, one budget');
check('17.canonicalRendererUsed', (() => {
  const CORE = require(path.join(ROOT, 'assets/js/memory-retrieval-core.js'));
  const r = run('嗯');
  const first = r.result.selected[0];
  if (!first) return false;
  /* selected 条目是 {id, score, line}；renderer 要的是**record**，
     因此按 id 取回原始记录再渲染 —— 这样比的才是"同一份渲染实现"。 */
  const rec = RECS.filter(x => String(x.id) === String(first.id))[0];
  if (!rec) return false;
  return r.result.text.indexOf(first.line) >= 0
    && first.line === CORE.renderMemoryLine(rec, 'role_a', BASE.contentLen);
})(), 'lines must come from the unique renderer (core.renderMemoryLine)');
check('31.deterministicWithInjectedRandom', (() => {
  const a = JSON.stringify(run('嗯').result);
  for (let i = 0; i < 50; i++) if (JSON.stringify(run('嗯').result) !== a) return false;
  return true;
})());
check('15.noSecondSelector', (() => {
  const src = fs.readFileSync(path.join(ROOT, 'assets/js/memory-recall/coldstart-anchor.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  return !/\.sort\s*\(|getMemoryScore|importance\s*[><]|maxChars/.test(src);
})(), 'the anchor module must be a predicate, not a second selector');

/* ══ §6 · no anchor / no visible（13, 26）══ */
section('§6 · 空集');
check('13.noAnchorIsZeroNotFallbackToSurface', (() => {
  const recs = [mk({ id: 'e', title: '普通', content: 'x', importance: 9 })];
  const r = ORCH.recall(recs, Object.assign({}, BASE, { userMessage: '嗯' },
    { turn: Object.assign({ message: '嗯' }, csTurn()) }));
  return r.trace.channel === 'coldStart' && r.result.count === 0 && r.result.text === ''
    && r.result.reason === 'gate-rejected';
})(), 'plan B: coldStart owns the turn ⇒ 0 anchor means 0 memory, NOT a surface fallback');
check('26.noVisibleUsesNoVisibleMemoryReason', (() => {
  const recs = [mk({ id: 'p', pinned: true, visibility: 'private' })];
  const r = ORCH.recall(recs, Object.assign({}, BASE, { userMessage: '嗯' },
    { turn: Object.assign({ message: '嗯' }, csTurn()) }));
  return r.result.reason === 'no-visible-memory' && r.result.count === 0;
})());
check('26.noNewReasonIntroduced', (() => {
  const recs = [mk({ id: 'e' })];
  const r = ORCH.recall(recs, Object.assign({}, BASE, { userMessage: '嗯' },
    { turn: Object.assign({ message: '嗯' }, csTurn()) }));
  return ['no-coldstart-anchor', 'no-anchor'].indexOf(r.result.reason) < 0;
})(), 'existing reasons only — do not grow the result reason vocabulary for this');

/* ══ §7 · trace（27–30）══ */
section('§7 · trace');
check('27.traceChannelIsColdStart', run('嗯').trace.channel === 'coldStart');
check('28.traceAnchorReason', (() => {
  const sel = run('嗯').trace.candidates.filter(c => c.decision === 'selected');
  return sel.length > 0 && sel.every(c => c.reasons.indexOf('cold-start-anchor') >= 0);
})());
check('28.nonAnchorRejectionReason', (() => {
  const rows = run('嗯').trace.candidates.filter(c => c.memoryId === 'epi');
  return rows.length === 1 && rows[0].decision === 'rejected'
    && rows[0].reasons.indexOf('not-cold-start-anchor') >= 0;
})());
check('29.finalScoreStillNull', run('嗯').trace.candidates.every(c => c.finalScore === null));
check('30.relevanceScoreNull', run('嗯').trace.candidates.every(c => c.relevanceScore === null));
check('27.cooldownFactorStillOne', run('嗯').trace.candidates.every(c => c.cooldownFactor === 1));
check('27.noHiddenCandidateRow', (() => {
  const ids = run('嗯').trace.candidates.map(c => c.memoryId);
  return ids.indexOf('hidPin') < 0 && ids.indexOf('hidSem') < 0;
})());
check('27.noCandidateKeysExpansion', (() => {
  const T = require(path.join(ROOT, 'assets/js/memory-recall/recall-trace.js'));
  return JSON.stringify(T.CANDIDATE_KEYS) === JSON.stringify(
    ['memoryId', 'relevanceScore', 'memoryValue', 'cooldownFactor', 'finalScore', 'seat', 'decision', 'reasons']);
})(), 'reasons[] carries the evidence — CANDIDATE_KEYS must not grow');

/* ══ §8 · activation policy（24–26, 32–33, 36）══ */
section('§8 · activation policy');
check('24.hostForcedColdStartWorks', (() => {
  const r = ORCH.recall(RECS, Object.assign({}, BASE, { userMessage: '你好' },
    { turn: { message: '你好', channelHint: 'coldStart' } }));
  return r.trace.channel === 'coldStart';
})(), 'a trusted Host may force coldStart (R2-B FORCE_CHANNELS contract preserved)');
check('24.hostForcedStillUsesAclAndAdmission', (() => {
  const r = ORCH.recall(RECS, Object.assign({}, BASE, { userMessage: '你好' },
    { turn: { message: '你好', channelHint: 'coldStart' } }));
  const ids = r.result.selected.map(s => s.id);
  return ids.indexOf('hidPin') < 0 && ids.indexOf('manual') < 0 && ids.indexOf('epi') < 0;
})());
check('25.activationPolicyNone', run('嗯').meta.activationPolicy === 'none');
check('26.selectedIdsRemainTruthful', run('嗯').result.selected.length > 0,
  'selectedIds must stay non-empty — it is the fact of what was injected');
check('26.resultHasNoActivationFields', (() => {
  const r = run('嗯').result;
  return r.activationPolicy === undefined && r.shouldActivate === undefined && r.suppressActivation === undefined;
})(), '§19: result shape stays frozen; policy lives on meta only');
check('32.noSeenSetInRetrieval', (() => {
  const src = fs.readFileSync(path.join(ROOT, 'assets/js/memory-recall/memory-recall-orchestrator.js'), 'utf8')
    + fs.readFileSync(path.join(ROOT, 'assets/js/memory-recall/coldstart-anchor.js'), 'utf8');
  return !/seenConversations|coldStartFired|firedColdStart|seen-set/.test(
    src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1'));
})(), 'no retrieval-side seen-set — one-shot authority is the Host signal');
check('33.noStorageOrSchema', (() => {
  const a = fs.readFileSync(path.join(ROOT, 'assets/js/memory-recall/coldstart-anchor.js'), 'utf8');
  const schema = fs.readFileSync(path.join(ROOT, 'assets/js/webcore-db-schema.js'), 'utf8');
  return !/localStorage|sessionStorage|indexedDB/.test(a) && schema.indexOf('coldstart') < 0
    && schema.indexOf('coldStart') < 0;
})());
check('33.noActivationInAnchorModule', (() => {
  const a = fs.readFileSync(path.join(ROOT, 'assets/js/memory-recall/coldstart-anchor.js'), 'utf8');
  return !/recordActivation|activationCount\s*\+\+|reinforce/.test(a);
})(), 'the anchor module must never activate anything itself');

console.log('\n' + '='.repeat(64));
if (failures) { console.error('MEMORY RECALL COLDSTART FAILED · ' + failures + ' assertion(s), ' + passed + ' passed'); process.exitCode = 1; }
else console.log('MEMORY RECALL COLDSTART PASSED · ' + passed + ' assertions green');
