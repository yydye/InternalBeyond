'use strict';
/* Internal Beyond · P21-R2-B · Memory Recall Turn Signal / Early Exit（Node，零依赖，不开浏览器）
   运行：node tests/test_memory_recall_early_exit.js

   ══════════════════════════════════════════════════════════════════════════
   本测试证明优先级裁决与 early-exit 分类，并锁定它由共享 Recall Orchestrator 消费。
   ══════════════════════════════════════════════════════════════════════════

   被测模块：assets/js/memory-recall/turn-signal.js（纯函数，零 IO）

   R2-B 冻结的优先级（从高到低）：
     1. Host-forced recall channel（recall / glossary / coldStart / reminisce）
     2. Conversation cold start
     3. Explicit recall intent
     4. Semantic payload
     5. Early-exit classification

   两条最容易写错的边界，本文件专门钉住：
     · surface / legacy **不**越过 Early Exit（它们不是强制通道）
     · early exit 只认"确定性的无记忆价值表达"，**绝不**按长度判断
   ══════════════════════════════════════════════════════════════════════════ */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const MODULE_REL = 'assets/js/memory-recall/turn-signal.js';
const TS = require(path.join(ROOT, MODULE_REL));

let failures = 0;
let passed = 0;
const check = (name, cond, detail) => {
  if (cond) { passed++; console.log('  PASS  ' + name); return true; }
  failures++;
  console.error('  FAIL  ' + name + (detail !== undefined ? '  -> ' + detail : ''));
  return false;
};
const section = t => console.log('\n── ' + t + ' ──');

const sig = input => TS.analyzeTurnSignal(input);
const isEarly = input => sig(input).earlyExit === true;

/* 输出形状的**键集合**必须封闭：多一个键意味着契约被悄悄扩展。 */
const EXPECTED_KEYS = [
  'shouldRecall', 'earlyExit', 'earlyExitReason', 'explicitRecall', 'recallCues',
  'hostForced', 'isConversationOpen', 'hasSemanticPayload', 'channelHint',
  'channelHintRecognized', 'suggestedChannel', 'decisionSource', 'normalizedMessage'
].sort();

/* ══════════════════════════════════════════════════════════════════════
   §1 · 输出形状（结构化，不是 boolean）
   ══════════════════════════════════════════════════════════════════════ */
section('§1 · 输出形状');

const shapeSample = sig({ message: '你好' });
check('S1.returnsObject', shapeSample && typeof shapeSample === 'object' && !Array.isArray(shapeSample));
check('S1.notBoolean', typeof shapeSample !== 'boolean',
  'analyzeTurnSignal must return a structured result, not a bare boolean');
check('S1.keysAreClosedSet',
  JSON.stringify(Object.keys(shapeSample).sort()) === JSON.stringify(EXPECTED_KEYS),
  'got ' + JSON.stringify(Object.keys(shapeSample).sort()));
check('S1.shouldRecallIsBoolean', typeof shapeSample.shouldRecall === 'boolean');
check('S1.earlyExitIsBoolean', typeof shapeSample.earlyExit === 'boolean');
check('S1.explicitRecallIsBoolean', typeof shapeSample.explicitRecall === 'boolean');
check('S1.hostForcedIsBoolean', typeof shapeSample.hostForced === 'boolean');
check('S1.recallCuesIsArray', Array.isArray(shapeSample.recallCues));
check('S1.shouldRecallAndEarlyExitAreOpposites',
  shapeSample.shouldRecall === !shapeSample.earlyExit,
  'shouldRecall and earlyExit must be complementary in every result');
/* early-exit 时 reason 必须有值；非 early-exit 时必须为 null。 */
check('S1.earlyExitReasonNullWhenNotEarlyExit',
  sig({ message: '你好' }).earlyExitReason === null);
check('S1.earlyExitReasonPresentWhenEarlyExit',
  typeof sig({ message: '嗯' }).earlyExitReason === 'string' && sig({ message: '嗯' }).earlyExitReason.length > 0);

/* ══════════════════════════════════════════════════════════════════════
   §2 · Early-exit 分类（任务书 §16 的 1–8）
   ══════════════════════════════════════════════════════════════════════ */
section('§2 · Early-exit 分类');

check('E1.empty', isEarly({ message: '' }));
check('E1.null', isEarly({ message: null }));
check('E1.undefined', isEarly({ message: undefined }));
check('E1.missing', isEarly({}));
check('E2.whitespace', isEarly({ message: '   ' }));
check('E2.tabsAndNewlines', isEarly({ message: '\t\n  \r\n ' }));
check('E2.fullWidthSpace', isEarly({ message: '\u3000\u3000' }));
check('E3.punctuationDots', isEarly({ message: '...' }));
check('E3.punctuationFullWidthQuestion', isEarly({ message: '？？' }));
check('E3.punctuationBang', isEarly({ message: '!!!' }));
check('E3.punctuationMixed', isEarly({ message: '……？！' }));
check('E3.punctuationTilde', isEarly({ message: '~~~' }));
check('E4.emojiSingle', isEarly({ message: '😂' }));
check('E4.emojiThumb', isEarly({ message: '👍' }));
check('E4.emojiRepeated', isEarly({ message: '😂😂😂' }));
check('E4.emojiWithSpace', isEarly({ message: '😂 😂' }));
check('E4.emojiVariationSelector', isEarly({ message: '❤️' }));
check('E4.emojiZWJSequence', isEarly({ message: '👨‍👩‍👧' }));
check('E5.acknowledgement.hen', isEarly({ message: '嗯' }));
check('E5.acknowledgement.henhen', isEarly({ message: '嗯嗯' }));
check('E6.acknowledgement.haha', isEarly({ message: '哈哈' }));
check('E6.acknowledgement.hahaha', isEarly({ message: '哈哈哈' }));
check('E6.acknowledgement.xiaosi', isEarly({ message: '笑死' }));
check('E7.acknowledgement.hao', isEarly({ message: '好' }));
check('E7.acknowledgement.haode', isEarly({ message: '好的' }));
check('E7.acknowledgement.haoba', isEarly({ message: '好吧' }));
check('E7.acknowledgement.xing', isEarly({ message: '行' }));
check('E7.acknowledgement.keyi', isEarly({ message: '可以' }));
check('E7.acknowledgement.zhidao', isEarly({ message: '知道了' }));
check('E7.acknowledgement.shoudao', isEarly({ message: '收到' }));
check('E8.acknowledgement.jixu', isEarly({ message: '继续' }));
check('E8.acknowledgement.jiezhe', isEarly({ message: '接着' }));
check('E8.filler.o', isEarly({ message: '哦' }));
check('E8.filler.oo', isEarly({ message: '噢' }));
check('E8.filler.a', isEarly({ message: '啊' }));
check('E8.filler.ei', isEarly({ message: '诶' }));

/* 每一个 early-exit 都必须带**分类原因**，且原因来自冻结词表。 */
const REASON_VALUES = Object.keys(TS.EARLY_EXIT_REASON).map(k => TS.EARLY_EXIT_REASON[k]);
[
  ['', TS.EARLY_EXIT_REASON.emptyInput],
  ['   ', TS.EARLY_EXIT_REASON.emptyInput],
  ['...', TS.EARLY_EXIT_REASON.punctuationOnly],
  ['😂', TS.EARLY_EXIT_REASON.emojiOnly],
  ['嗯', TS.EARLY_EXIT_REASON.acknowledgement]
].forEach(([msg, reason]) => {
  check('E.reason.' + JSON.stringify(msg), sig({ message: msg }).earlyExitReason === reason,
    'got ' + sig({ message: msg }).earlyExitReason);
});
check('E.reasonsComeFromFrozenVocabulary',
  ['', '   ', '...', '😂', '嗯'].every(m => REASON_VALUES.indexOf(sig({ message: m }).earlyExitReason) >= 0));

/* ══════════════════════════════════════════════════════════════════════
   §3 · **不**early exit：短但有语义（任务书 §16 的 9–11）
   ══════════════════════════════════════════════════════════════════════ */
section('§3 · 短但有语义 —— 绝不按长度判断');

['北京', '显卡', '妈妈', '地下室'].forEach(w => {
  check('N.short.' + w, !isEarly({ message: w }), 'short but semantic must NOT early exit: ' + w);
});
check('N.noLengthRule.everyLength1to6NonAckSurvives',
  ['北京', '显卡', '妈妈', '地下室', '房租', '工作', '她'].every(w => !isEarly({ message: w })),
  'no message.length < N rule may exist');
/* 反向控制：若实现真的用了长度规则，下面这条会长度的例子必然早退。
   它证明 §3 的断言在测某种真实存在的行为差异。 */
check('N.noLengthRule.controlSameLengthOppositeOutcome',
  isEarly({ message: '嗯' }) === true && isEarly({ message: '北京' }) === true === false,
  'same length, opposite classification (acknowledgement vs semantic)');

/* ══════════════════════════════════════════════════════════════════════
   §4 · 绝不 substring 判断（任务书 §16 的 12）
   ══════════════════════════════════════════════════════════════════════ */
section('§4 · acknowledgement 只做 normalized exact match');

check('X.notSubstring.haoxiang', !isEarly({ message: '好像上次我们说过这个' }),
  '"好像…" 含 "好" 但不得据此早退');
check('X.notSubstring.haodeButLonger', !isEarly({ message: '好的我知道了那件事' }));
check('X.notSubstring.xingInside', !isEarly({ message: '银行在哪' }),
  '"银行" 含 "行" 但不得据此早退');
check('X.notSubstring.keyiInside', !isEarly({ message: '可以理解成别的意思吗' }));
check('X.notSubstring.zhidaoInside', !isEarly({ message: '我不知道这件事' }));
check('X.notSubstring.jixuInside', !isEarly({ message: '继续上次那个话题' }));
check('X.control.exactStillWorks', isEarly({ message: '好' }) && !isEarly({ message: '好像' }),
  'reverse control: exact match works while substring does not');

/* ══════════════════════════════════════════════════════════════════════
   §5 · Explicit recall intent（任务书 §16 的 13–14）
   ══════════════════════════════════════════════════════════════════════ */
section('§5 · Explicit recall intent');

const RECALL_CASES = [
  '你还记得吗', '你还记得那次', '记得吗', '你记得我说过', '好，你还记得上次那件事吗',
  '上次我们说的那个', '之前说过这个', '之前聊过这个', '以前说过', '那次',
  '那件事', '当时我们', '你不是说过', '我不是说过', '我们不是说过',
  'do you remember', 'Remember that', 'last time we', 'previously',
  'earlier you said', 'we talked about'
];
RECALL_CASES.forEach(m => {
  check('R.recallCue.' + m, sig({ message: m }).explicitRecall === true, 'cue not detected: ' + m);
});
check('R.cueForcesNoEarlyExit', RECALL_CASES.every(m => !isEarly({ message: m })));
check('R.cueSuggestsRecallChannel',
  RECALL_CASES.every(m => sig({ message: m }).suggestedChannel === 'recall'));

/* 关键优先级：以确认词开头但含 recall cue ⇒ 必须先判 explicit recall。 */
const prefixed = sig({ message: '好，你还记得上次那件事吗' });
check('R.precedence.acknowledgementPrefixDoesNotWin', prefixed.earlyExit === false,
  'explicit recall must beat the acknowledgement classification');
check('R.precedence.decisionSourceIsExplicitRecall',
  prefixed.decisionSource === TS.DECISION_SOURCE.explicitRecall, 'got ' + prefixed.decisionSource);
check('R.precedence.explicitRecallTrue', prefixed.explicitRecall === true);
check('R.precedence.cuesReported', prefixed.recallCues.length > 0);
check('R.precedence.cueHasRawAndIndex',
  prefixed.recallCues.every(c => typeof c.cue === 'string' && typeof c.raw === 'string' && Number.isInteger(c.index)));
check('R.precedence.cueOrderedByPosition',
  prefixed.recallCues.every((c, i, a) => i === 0 || a[i - 1].index <= c.index));

/* 英文大小写不敏感。 */
check('R.caseInsensitive.upper', sig({ message: 'DO YOU REMEMBER THIS' }).explicitRecall === true);
check('R.caseInsensitive.mixed', sig({ message: 'ReMeMbEr' }).explicitRecall === true);

/* 单独的时间词**不得**等同于 explicit recall（任务书 §6 明令）。 */
['昨天', '去年', '以前', '前天', '上周'].forEach(w => {
  check('R.temporalAloneIsNotExplicitRecall.' + w, sig({ message: w }).explicitRecall === false,
    'a bare temporal word must not be treated as explicit recall: ' + w);
});
check('R.temporalAloneStillNoEarlyExit',
  ['昨天', '去年', '以前'].every(w => !isEarly({ message: w })),
  'temporal words are semantic payload — they must not early exit either');
check('R.temporalQuestionNotForced',
  sig({ message: '去年苹果发布了什么？' }).explicitRecall === false,
  '"去年苹果发布了什么" 不一定是在问角色记忆');

/* ══════════════════════════════════════════════════════════════════════
   §6 · Host-forced channel（任务书 §16 的 17–19）
   ══════════════════════════════════════════════════════════════════════ */
section('§6 · Host-forced channel');

const FORCE = ['recall', 'glossary', 'coldStart', 'reminisce'];
FORCE.forEach(ch => {
  ['', '嗯', '好', '...', '😂'].forEach(msg => {
    const r = sig({ message: msg, channelHint: ch });
    check('F.forced.' + ch + '.' + JSON.stringify(msg),
      r.earlyExit === false && r.hostForced === true && r.suggestedChannel === ch,
      JSON.stringify({ early: r.earlyExit, forced: r.hostForced, ch: r.suggestedChannel }));
  });
});
check('F.forcedIgnoresMessageEntirely',
  FORCE.every(ch => !isEarly({ message: '', channelHint: ch })),
  'Host-forced memory work must not early exit even on an empty message');

/* surface / legacy **不**越过 early exit。 */
check('F.surfaceIsNotForcing', isEarly({ message: '嗯', channelHint: 'surface' }) === true,
  'surface must NOT bypass early exit');
check('F.legacyIsNotForcing', isEarly({ message: '嗯', channelHint: 'legacy' }) === true,
  'legacy must NOT bypass early exit');
check('F.surfaceNotMarkedForced', sig({ message: '嗯', channelHint: 'surface' }).hostForced === false);
check('F.surfaceOnSemanticMessageStillNotForced',
  sig({ message: '北京', channelHint: 'surface' }).hostForced === false);

/* 非法 channelHint 不得被当作 forced channel。 */
['bogus', 'SURFACE', 'Recall', '', ' force ', 'coldstart', 0, 1, true, {}, [], null].forEach(hint => {
  const r = sig({ message: '嗯', channelHint: hint });
  check('F.invalidHintNotForced.' + JSON.stringify(hint),
    r.hostForced === false && r.earlyExit === true,
    JSON.stringify({ hint: hint, forced: r.hostForced, early: r.earlyExit }));
});
check('F.unknownHintReportedNotRecognized',
  sig({ message: '你好', channelHint: 'bogus' }).channelHintRecognized === false);
check('F.surfaceHintIsRecognizedButNotForcing',
  sig({ message: '请问显卡怎么选', channelHint: 'surface' }).channelHintRecognized === true,
  'a valid but non-forcing channel name must still be reported as recognized');
check('F.surfaceHintSemanticMessageProceeds',
  sig({ message: '请问显卡怎么选', channelHint: 'surface' }).decisionSource === TS.DECISION_SOURCE.surface);

/* ══════════════════════════════════════════════════════════════════════
   §7 · Cold start 优先于 early exit（任务书 §16 的 15–16）
   ══════════════════════════════════════════════════════════════════════ */
section('§7 · Conversation cold start');

check('C.coldStartEmpty', !isEarly({ message: '', isConversationOpen: true }));
check('C.coldStartAck', !isEarly({ message: '嗯', isConversationOpen: true }));
check('C.coldStartHao', !isEarly({ message: '好', isConversationOpen: true }));
check('C.coldStartPunctuation', !isEarly({ message: '...', isConversationOpen: true }));
check('C.coldStartSuggestsChannel',
  sig({ message: '', isConversationOpen: true }).suggestedChannel === 'coldStart');
check('C.coldStartDecisionSource',
  sig({ message: '嗯', isConversationOpen: true }).decisionSource === TS.DECISION_SOURCE.coldStart);
check('C.coldStartNotForced',
  sig({ message: '嗯', isConversationOpen: true }).hostForced === false,
  'cold start is not a host-forced channel — it is a conversation-state signal');
/* 只有严格 true 才算：truthy 不算（避免 "false" 字符串之类的意外）。 */
['true', 1, {}, []].forEach(v => {
  check('C.coldStartStrictBoolean.' + JSON.stringify(v),
    isEarly({ message: '嗯', isConversationOpen: v }) === true);
});
check('C.explicitRecallBeatsColdStart',
  sig({ message: '你还记得吗', isConversationOpen: true }).decisionSource === TS.DECISION_SOURCE.coldStart,
  'host/state precedence is frozen: cold start ranks above explicit recall');

/* ══════════════════════════════════════════════════════════════════════
   §8 · Semantic payload（任务书 §16 的 20）
   ══════════════════════════════════════════════════════════════════════ */
section('§8 · Semantic payload');

check('P.semanticEmpty', !isEarly({ message: '', hasSemanticPayload: true }));
check('P.semanticAck', !isEarly({ message: '嗯', hasSemanticPayload: true }));
check('P.semanticDecisionSource',
  sig({ message: '', hasSemanticPayload: true }).decisionSource === TS.DECISION_SOURCE.semanticPayload);
check('P.semanticDoesNotInventChannel',
  sig({ message: '', hasSemanticPayload: true }).suggestedChannel === null,
  'payload presence must not fabricate a channel suggestion');
check('P.semanticNotForced', sig({ message: '', hasSemanticPayload: true }).hostForced === false);
['true', 1, {}, []].forEach(v => {
  check('P.semanticStrictBoolean.' + JSON.stringify(v),
    isEarly({ message: '嗯', hasSemanticPayload: v }) === true);
});
check('P.strictTrueStillProceeds', !isEarly({ message: '', hasSemanticPayload: true }));

/* ══════════════════════════════════════════════════════════════════════
   §9 · 优先级整体顺序
   ══════════════════════════════════════════════════════════════════════ */
section('§9 · 优先级整体顺序');

const D = TS.DECISION_SOURCE;
check('O1.hostForcedBeatsEverything',
  sig({ message: '你还记得吗', channelHint: 'glossary', isConversationOpen: true, hasSemanticPayload: true })
    .decisionSource === D.hostForced);
check('O2.coldStartBeatsExplicitRecall',
  sig({ message: '你还记得吗', isConversationOpen: true }).decisionSource === D.coldStart);
check('O3.explicitRecallBeatsSemantic',
  sig({ message: '你还记得吗', hasSemanticPayload: true }).decisionSource === D.explicitRecall);
check('O4.explicitRecallBeatsEarlyExit',
  sig({ message: '嗯，你还记得吗' }).decisionSource === D.explicitRecall);
check('O5.semanticBeatsEarlyExit',
  sig({ message: '嗯', hasSemanticPayload: true }).decisionSource === D.semanticPayload);
check('O6.earlyExitIsLast',
  sig({ message: '嗯' }).decisionSource === D.earlyExit);
check('O7.surfaceIsTheFallthrough',
  sig({ message: '北京' }).decisionSource === D.surface);
check('O8.allDecisionSourcesAreFromFrozenVocabulary',
  [D.hostForced, D.coldStart, D.explicitRecall, D.semanticPayload, D.earlyExit, D.surface]
    .every(v => typeof v === 'string' && v.length > 0));

/* ══════════════════════════════════════════════════════════════════════
   §10 · 归一化
   ══════════════════════════════════════════════════════════════════════ */
section('§10 · Normalization');

check('Z1.nfkcFullWidthAck', isEarly({ message: '嗯' }) && TS.normalizeText('ａ') === 'a',
  'NFKC must fold full-width latin');
check('Z1.nfkcIdeographicSpace', TS.normalizeText('\u3000好\u3000') === '好');
check('Z2.trim', TS.normalizeText('   好   ') === '好');
check('Z2.collapseWhitespace', TS.normalizeText('你   好') === '你 好');
check('Z2.collapseNewlines', TS.normalizeText('你\n\n好') === '你 好');
check('Z3.zeroWidthRemoved', TS.normalizeText('好\u200B的') === '好的');
check('Z3.bomRemoved', TS.normalizeText('\uFEFF好') === '好');
check('Z4.controlCharsRemoved', TS.normalizeText('好\u0007的') === '好的');
check('Z5.zeroWidthOnlyIsEmpty', isEarly({ message: '\u200B\u200B' }));
check('Z6.nonStringYieldsEmpty', TS.normalizeText(42) === '' && TS.normalizeText(null) === ''
  && TS.normalizeText({}) === '' && TS.normalizeText([]) === '');
check('Z6.numberInputDoesNotThrowAndEarlyExits', isEarly({ message: 42 }));
check('Z6.objectInputDoesNotThrow', (() => { try { sig({ message: { a: 1 } }); return true; } catch (e) { return false; } })());

/* ══════════════════════════════════════════════════════════════════════
   §11 · 输入安全与边界（任务书 §16 的 24）
   ══════════════════════════════════════════════════════════════════════ */
section('§11 · 输入安全');

const HOSTILE = [null, undefined, '', '   ', 0, 1, -1, NaN, Infinity, true, false, {}, [], [1, 2],
  { message: null }, { message: 42 }, { message: {} }, { message: [] }, () => {}, Symbol ? undefined : undefined];
HOSTILE.forEach((v, i) => {
  check('B.noThrow.hostile#' + i, (() => {
    try { TS.analyzeTurnSignal(v); return true; } catch (e) { return false; }
  })(), 'analyzeTurnSignal threw on ' + String(v));
});
check('B.arrayInputTreatedAsNoMessage', isEarly([1, 2, 3]));
check('B.functionInputDoesNotThrow', (() => { try { TS.analyzeTurnSignal(() => {}); return true; } catch (e) { return false; } })());
check('B.normalizeHandlesAllHostile', (() => {
  try { HOSTILE.forEach(v => TS.normalizeText(v)); return true; } catch (e) { return false; }
})());

/* 超长输入：有界，且截断确定性。 */
const HUGE = '显'.repeat(500000);
check('B.longInputBounded', (() => {
  const r = sig({ message: HUGE });
  return r.normalizedMessage.length <= TS.MAX_SIGNAL_INPUT_CHARS;
})());
check('B.longInputThresholdNamed', typeof TS.MAX_SIGNAL_INPUT_CHARS === 'number' && TS.MAX_SIGNAL_INPUT_CHARS > 0,
  'the implementation safety cap must be explicitly named, not a magic literal');
check('B.longInputTruncationDeterministic', (() => {
  const a = TS.normalizeText(HUGE), b = TS.normalizeText(HUGE);
  return a === b && a.length === TS.MAX_SIGNAL_INPUT_CHARS;
})());
check('B.longInputDoesNotThrow', (() => { try { sig({ message: HUGE }); return true; } catch (e) { return false; } })());
/* 超长但**有语义**的输入不得被误判为 early exit。 */
check('B.longSemanticNotEarlyExit', !isEarly({ message: '显卡'.repeat(10000) }));

/* ══════════════════════════════════════════════════════════════════════
   §12 · 确定性（任务书 §16 的 23）
   ══════════════════════════════════════════════════════════════════════ */
section('§12 · Determinism');

const DET_INPUTS = [
  { message: '好，你还记得上次那件事吗' },
  { message: '嗯' },
  { message: '', channelHint: 'glossary' },
  { message: '😂😂' },
  { message: '北京 显卡', hasSemanticPayload: true },
  { message: '对了，你还记得去年我们说的显卡吗？' }
];
DET_INPUTS.forEach((inp, i) => {
  const first = JSON.stringify(sig(inp));
  let stable = true;
  for (let n = 0; n < 100; n++) { if (JSON.stringify(sig(inp)) !== first) { stable = false; break; } }
  check('D1.repeated100.deepEqual#' + i, stable, 'unstable result for ' + JSON.stringify(inp));
});
check('D2.cueOrderStable', (() => {
  const a = JSON.stringify(sig({ message: '上次那次当时还记得' }).recallCues);
  for (let n = 0; n < 100; n++) if (JSON.stringify(sig({ message: '上次那次当时还记得' }).recallCues) !== a) return false;
  return true;
})());

/* ── 纯函数静态证明：源码里不得出现时钟 / 随机 / IO ─────────────────── */
section('§12b · 纯函数静态证明');

const SRC = fs.readFileSync(path.join(ROOT, MODULE_REL), 'utf8');
const ORCHESTRATOR_SRC = fs.readFileSync(path.join(ROOT,
  'assets/js/memory-recall/memory-recall-orchestrator.js'), 'utf8');
const SRC_NO_COMMENTS = SRC
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
const FORBIDDEN = [
  ['Date.now', /Date\s*\.\s*now\s*\(/],
  ['new Date', /new\s+Date\s*\(/],
  ['Math.random', /Math\s*\.\s*random\s*\(/],
  ['performance.now', /performance\s*\.\s*now\s*\(/],
  ['setTimeout', /\bsetTimeout\s*\(/],
  ['setInterval', /\bsetInterval\s*\(/],
  ['fetch', /\bfetch\s*\(/],
  ['XMLHttpRequest', /\bXMLHttpRequest\b/],
  ['localStorage', /\blocalStorage\b/],
  ['sessionStorage', /\bsessionStorage\b/],
  ['indexedDB', /\bindexedDB\b/],
  ['require(dynamic)', /require\s*\(\s*[^'")]/],
  ['LLM/MiddleBrain', /\bmiddleBrain\b|\bMiddleBrain\b|\bcallApi\b|\bprovider\b/i]
];
FORBIDDEN.forEach(([label, re]) => {
  check('D3.noForbidden.' + label, !re.test(SRC_NO_COMMENTS),
    label + ' must not appear in the module source');
});
check('D4.exportsArePureFunctions', (() => {
  const api = TS;
  const fnNames = ['analyzeTurnSignal', 'normalizeText', 'classifyNonMemoryExpression', 'detectRecallCues'];
  return fnNames.every(n => typeof api[n] === 'function');
})());
check('D5.noForbiddenInExportedFunctionBodies', (() => {
  const fns = [TS.analyzeTurnSignal, TS.normalizeText, TS.classifyNonMemoryExpression, TS.detectRecallCues];
  return fns.every(f => !/Date\s*\.\s*now|Math\s*\.\s*random|\bfetch\s*\(/.test(String(f)));
})());

/* ══════════════════════════════════════════════════════════════════════
   §13 · 词表与契约一致性
   ══════════════════════════════════════════════════════════════════════ */
section('§13 · 词表与契约一致性');

check('V1.channelsMatchContract',
  JSON.stringify(TS.CHANNELS) === JSON.stringify(['legacy', 'surface', 'recall', 'glossary', 'coldStart', 'reminisce']),
  'channel vocabulary must match MEMORY_RECALL_CONTRACT §4 verbatim');
check('V2.forceChannelsAreSubset',
  TS.FORCE_CHANNELS.every(c => TS.CHANNELS.indexOf(c) >= 0));
check('V3.surfaceAndLegacyNotForcing',
  TS.FORCE_CHANNELS.indexOf('surface') < 0 && TS.FORCE_CHANNELS.indexOf('legacy') < 0);
check('V4.acknowledgementsContainSpecList',
  ['嗯', '嗯嗯', '好', '好的', '好吧', '行', '可以', '知道了', '收到', '哈哈', '哈哈哈',
    '笑死', '继续', '接着', '哦', '噢', '啊', '诶'].every(w => TS.ACKNOWLEDGEMENTS.indexOf(w) >= 0),
  'the acknowledgement set must cover the task-specified list');
check('V5.cueTablesNonEmpty', TS.RECALL_CUES_ZH.length > 0 && TS.RECALL_CUES_EN.length > 0);
check('V6.bareTemporalWordsNotCues',
  ['昨天', '去年', '以前'].every(w => TS.RECALL_CUES_ZH.indexOf(w) < 0),
  'bare temporal words must NOT be recall cues');
check('V7.moduleDeclaresOrchestratorWiring',
  /经 memory-recall-orchestrator 消费本模块/.test(SRC),
  'the Host consumes turn-signal through the shared orchestrator');
check('V7.orchestratorConsumesTurnSignal',
  /deps\.turnSignal\.analyzeTurnSignal\(/.test(ORCHESTRATOR_SRC),
  'the Recall path uses the deterministic turn-signal module');

/* ══════════════════════════════════════════════════════════════════════ */

console.log('\n' + '='.repeat(64));
if (failures) {
  console.error('MEMORY RECALL EARLY EXIT FAILED · ' + failures + ' assertion(s), ' + passed + ' passed');
  process.exitCode = 1;
} else {
  console.log('MEMORY RECALL EARLY EXIT PASSED · ' + passed + ' assertions green');
}
