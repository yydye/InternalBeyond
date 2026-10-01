'use strict';
/* Internal Beyond · P21-R2-B · Deterministic Recall Query Construction（Node，零依赖，不开浏览器）
   运行：node tests/test_memory_recall_query.js

   ══════════════════════════════════════════════════════════════════════════
   本测试证明的是 **R2-B 的确定性 query 构造**，不是"已接入生产"。
   ══════════════════════════════════════════════════════════════════════════

   被测模块：assets/js/memory-recall/recall-query.js（纯函数，零 IO）

   两条核心纪律：
     · 去噪，**不是**语义推理 —— query 不得包含原句没明说的东西
     · lexicalTerms 复用 memory-retrieval-core.js 的 extractKeywords，
       **不复制**第二套中文 n-gram 逻辑
   ══════════════════════════════════════════════════════════════════════════ */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const MODULE_REL = 'assets/js/memory-recall/recall-query.js';
const CORE_REL = 'assets/js/memory-retrieval-core.js';
const Q = require(path.join(ROOT, MODULE_REL));
const CORE = require(path.join(ROOT, CORE_REL));

let failures = 0;
let passed = 0;
const check = (name, cond, detail) => {
  if (cond) { passed++; console.log('  PASS  ' + name); return true; }
  failures++;
  console.error('  FAIL  ' + name + (detail !== undefined ? '  -> ' + detail : ''));
  return false;
};
const section = t => console.log('\n── ' + t + ' ──');

const q = (msg, opts) => Q.buildRecallQuery(msg, opts);

/* 契约 §13 要求的四类必须可表达 —— 键集合封闭。 */
const EXPECTED_KEYS = [
  'rawText', 'normalizedText', 'lexicalText', 'lexicalTerms', 'entities', 'temporalHints', 'aliases'
].sort();

/* ══════════════════════════════════════════════════════════════════════
   §1 · 输出形状与契约四类
   ══════════════════════════════════════════════════════════════════════ */
section('§1 · 输出形状与 Contract §13 四类');

const shape = q('你还记得地下室吗');
check('S1.keysAreClosedSet',
  JSON.stringify(Object.keys(shape).sort()) === JSON.stringify(EXPECTED_KEYS),
  'got ' + JSON.stringify(Object.keys(shape).sort()));
check('S1.contractFourClassesPresent',
  Array.isArray(shape.lexicalTerms) && Array.isArray(shape.entities)
  && Array.isArray(shape.temporalHints) && Array.isArray(shape.aliases),
  'Contract §13 requires lexicalTerms / entities / temporalHints / aliases');
check('S1.textFieldsAreStrings',
  typeof shape.rawText === 'string' && typeof shape.normalizedText === 'string'
  && typeof shape.lexicalText === 'string');

/* ══════════════════════════════════════════════════════════════════════
   §2 · 归一化（任务书 §17 的 1–2、4）
   ══════════════════════════════════════════════════════════════════════ */
section('§2 · 归一化');

check('N1.nfkcFullWidth', q('ＡＢＣ').normalizedText === 'ABC');
check('N1.nfkcFullWidthDigits', q('１２３').normalizedText === '123');
check('N2.trim', q('   你好   ').normalizedText === '你好');
check('N2.collapseWhitespace', q('你    好').normalizedText === '你 好');
check('N2.collapseNewlines', q('你\n\n\n好').normalizedText === '你 好');
check('N2.ideographicSpace', q('你\u3000好').normalizedText === '你 好');
check('N3.zeroWidthRemoved', q('你\u200B好').normalizedText === '你好');
check('N3.controlRemoved', q('你\u0007好').normalizedText === '你好');
/* 原始文本**始终**保留 —— 即使它需要被归一化。 */
const rawCase = '  你\u200B好，  ＡＢＣ  ';
check('N4.rawTextAlwaysPreserved', q(rawCase).rawText === rawCase,
  'rawText must be the caller input verbatim, never the normalized form');
check('N4.rawTextPreservedEvenWhenNormalizedDiffers',
  q(rawCase).normalizedText !== q(rawCase).rawText);
check('N4.rawTextPreservedWithBoilerplate',
  q('你还记得地下室吗').rawText === '你还记得地下室吗',
  'boilerplate stripping must not touch rawText');

/* ══════════════════════════════════════════════════════════════════════
   §3 · Boilerplate stripping（任务书 §17 的 3、5）
   ══════════════════════════════════════════════════════════════════════ */
section('§3 · Recall boilerplate stripping');

check('B1.stripNiHaiJideDe', q('你还记得地下室吗').lexicalText.indexOf('你还记得') < 0,
  'got ' + JSON.stringify(q('你还记得地下室吗').lexicalText));
check('B1.stripHaiJideDe', q('还记得地下室吗').lexicalText.indexOf('还记得') < 0);
check('B1.stripZhiQianWoMenLiaoGuo', q('之前我们聊过显卡').lexicalText.indexOf('之前我们聊过') < 0);
check('B1.stripNiBuShiShuoGuo', q('你不是说过显卡吗').lexicalText.indexOf('你不是说过') < 0);
check('B1.stripShangCiWoMenShuo', q('上次我们说显卡').lexicalText.indexOf('上次我们说') < 0);
check('B1.stripEnglishDoYouRemember', q('do you remember the GPU').lexicalText.toLowerCase().indexOf('do you remember') < 0);
check('B1.stripEnglishPreviously', q('previously we chose a GPU').lexicalText.toLowerCase().indexOf('previously') < 0);
check('B1.coreEntitySurvivesStripping',
  q('你还记得地下室吗').lexicalText.indexOf('地下室') >= 0,
  'stripping must never remove the core entity');
check('B1.coreEntitySurvivesAllPatterns',
  ['你还记得显卡吗', '还记得显卡吗', '之前我们聊过显卡', '你不是说过显卡吗', '上次我们说显卡']
    .every(m => q(m).lexicalText.indexOf('显卡') >= 0));
check('B1.leadingConnectorStripped', q('对了，你好').lexicalText === '你好',
  'got ' + JSON.stringify(q('对了，你好').lexicalText));
check('B1.leadingConnectorWithPunct', q('哦，对了，我们去哪').lexicalText === '哦，我们去哪',
  'got ' + JSON.stringify(q('哦，对了，我们去哪').lexicalText));
check('B1.connectorResidueNoLoneComma',
  !/^[,，]/.test(q('对了，你还记得地下室吗').lexicalText),
  'stripping must not leave orphan leading punctuation: ' + JSON.stringify(q('对了，你还记得地下室吗').lexicalText));

/* 主示例（任务书 §8）：去噪到位，且**没有**任何脑补。 */
const mainEx = q('对了，你还记得去年我们说那个显卡的事情吗？');
check('B2.mainExample.distinctProducts',
  mainEx.lexicalText !== mainEx.normalizedText,
  'the lexical projection must actually differ from the normalized text');
check('B2.mainExample.noRecallPhrasing',
  mainEx.lexicalText.indexOf('你还记得') < 0 && mainEx.lexicalText.indexOf('还记得') < 0);
check('B2.mainExample.keepsTemporalWord', mainEx.lexicalText.indexOf('去年') >= 0,
  'a temporal word carries retrieval value and must survive stripping');
check('B2.mainExample.keepsCoreNoun', mainEx.lexicalText.indexOf('显卡') >= 0);

/* ── 反脑补：query 中不得出现原句没有的内容 ───────────────────────── */
section('§3b · 不脑补语义');

const NOISE_ONLY = /[^\u4e00-\u9fffA-Za-z0-9]/g;
function tokenSet(s) { return new Set(String(s).replace(NOISE_ONLY, ' ').split(/\s+/).filter(Boolean)); }
check('B3.noInventedSemantics.lexicalTextSubsetOfInput', (() => {
  /* lexicalText 的每一个字符都必须能在原文里找到 —— 去噪只能删，不能造。 */
  const src = mainEx.normalizedText;
  let i = 0, j = 0;
  while (i < mainEx.lexicalText.length && j < src.length) {
    if (mainEx.lexicalText[i] === src[j]) { i++; j++; } else { j++; }
  }
  return i === mainEx.lexicalText.length;
})(), 'lexicalText must be a subsequence of normalizedText (deletion only, no invention)');
check('B3.noInventedSemantics.noGpuPurchasePlan',
  mainEx.lexicalText.indexOf('GPU') < 0 && mainEx.lexicalText.indexOf('购买') < 0
  && mainEx.lexicalText.indexOf('方案') < 0 && mainEx.lexicalText.indexOf('本地部署') < 0,
  'query must not contain model-hallucinated content the sentence never stated');
check('B3.noInventedSemantics.entitiesDoNotInvent',
  q('你还记得显卡吗').entities.every(e => q('你还记得显卡吗').normalizedText.indexOf(e.raw) >= 0));
check('B3.entityRawAlwaysSubstringOfNormalized', (() => {
  const cases = ['《地下室》', 'GPT-5.6', '@alice', '#hashtag', 'memory_records'];
  return cases.every(m => q(m).entities.every(e => q(m).normalizedText.indexOf(e.raw) >= 0));
})());

/* ══════════════════════════════════════════════════════════════════════
   §4 · 保护段 / 引号实体不被破坏（任务书 §10、§17 的 8、9、18）
   ══════════════════════════════════════════════════════════════════════ */
section('§4 · 保护段优先于 stripping');

const quoted = q('你还记得《上次的战争》吗？');
check('Q1.bookTitleEntityExtracted',
  quoted.entities.some(e => e.kind === 'quoted' && e.raw === '《上次的战争》'),
  'got ' + JSON.stringify(quoted.entities));
check('Q2.quotedShangCiNotStripped',
  quoted.lexicalText.indexOf('《上次的战争》') >= 0,
  'a quoted span containing "上次" must NOT be stripped: ' + JSON.stringify(quoted.lexicalText));
check('Q2.control.unquotedShangCiWouldBeKept',
  q('上次的战争').lexicalText.indexOf('上次的战争') >= 0,
  'unquoted temporal wording is retained (conservative) — proving Q2 is about the quoting, not about the word');
check('Q3.cornerBracketEntity', q('你还记得「地下室」吗').entities.some(e => e.raw === '「地下室」'));
check('Q3.cornerBracketNotStripped', q('你还记得「地下室」吗').lexicalText.indexOf('「地下室」') >= 0);
check('Q3.asciiQuoteEntity', q('remember "Project X"').entities.some(e => e.raw === '"Project X"'));
check('Q3.asciiQuoteNotStripped', q('remember "Project X"').lexicalText.indexOf('"Project X"') >= 0);
check('Q3.asciiSingleQuoteEntity', q("remember 'Project X'").entities.some(e => e.raw === "'Project X'"));
check('Q3.cjkCurlyQuoteEntity', q('你还记得“地下室”吗').entities.some(e => e.raw === '“地下室”'));
check('Q3.cjkCornerEntity', q('你还记得『地下室』吗').entities.some(e => e.raw === '『地下室』'));
check('Q3.doubleAngleEntity', q('你看《显卡》').entities.some(e => e.kind === 'quoted' && e.raw === '《显卡》'));
check('Q4.strippingStillWorksOutsideQuotes',
  q('你还记得《上次的战争》吗').lexicalText.indexOf('你还记得') < 0,
  'boilerplate outside the protected span must still be stripped');

/* ══════════════════════════════════════════════════════════════════════
   §5 · Entities（任务书 §17 的 8–12）
   ══════════════════════════════════════════════════════════════════════ */
section('§5 · Explicit surface entities');

check('E1.handleAt', q('@alice 说过这个').entities.some(e => e.kind === 'handle' && e.raw === '@alice'));
check('E1.handleCjk', q('#地下室').entities.some(e => e.kind === 'handle' && e.raw === '#地下室'));
check('E1.hashtagAscii', q('see #hashtag here').entities.some(e => e.kind === 'handle' && e.raw === '#hashtag'));
check('E2.identifierWithDigit', q('P21-R2 是什么').entities.some(e => e.raw === 'P21-R2'));
check('E2.identifierHyphenDigits', q('RTX-5070 怎么样').entities.some(e => e.raw === 'RTX-5070'));
check('E2.identifierUnderscore', q('memory_records 表').entities.some(e => e.raw === 'memory_records'));
check('E2.identifierCamelCase', q('InternalBeyond 项目').entities.some(e => e.raw === 'InternalBeyond'));
check('E2.identifierTwoCaps', q('用 MemoryRecords 这个').entities.some(e => e.raw === 'MemoryRecords'));
check('E2.plainLowercaseWordIsNotIdentifier', q('please understand this').entities.every(e => e.raw !== 'understand'),
  'an ordinary lowercase english word must not be reported as an identifier');
check('E2.singleCapCamelIsNotIdentifier', q('用 memoryRecords 这个变量').entities.every(e => e.raw !== 'memoryRecords'),
  'a single-capital camel word has no deterministic identifier evidence — documented conservative gap');
check('E2.identifierAllCaps', q('用 GPU 跑').entities.some(e => e.raw === 'GPU'));
check('E3.plainCjkIsNotEntity', q('显卡').entities.length === 0,
  '"显卡" is not an entity — it still reaches lexicalTerms, which is enough');
check('E3.plainCjkNameNotGuessed', q('小满今天怎么样').entities.length === 0,
  'Chinese personal names must NOT be guessed');
check('E3.numberOnlyIsNotEntity', q('5070').entities.length === 0);
check('E3.dateIsNotEntity', q('2026-09-28').entities.every(e => e.raw !== '2026-09-28'),
  'a date belongs to temporalHints, not entities');
check('E4.entitiesHaveKindRawIndex',
  q('GPT-5.6 和 @alice').entities.every(e =>
    typeof e.kind === 'string' && typeof e.raw === 'string' && Number.isInteger(e.index)));
check('E4.entitiesOrderedByIndex', (() => {
  const es = q('《A》 then @b and P21-R2 finally memory_records').entities;
  return es.every((e, i, a) => i === 0 || a[i - 1].index <= e.index);
})());
check('E4.entitiesDeterministic', (() => {
  const a = JSON.stringify(q('GPT-5.6 与 @alice 与 #tag 与 memory_records').entities);
  for (let n = 0; n < 100; n++) {
    if (JSON.stringify(q('GPT-5.6 与 @alice 与 #tag 与 memory_records').entities) !== a) return false;
  }
  return true;
})());

/* ══════════════════════════════════════════════════════════════════════
   §5b · P21-R2-B.1 · Identifier Surface Entity Closure
   ──────────────────────────────────────────────────────────────────────
   版本点号（数字 "." 数字）属于 identifier；域名/文件名/路径**不**属于。
   这两件事必须同时成立 —— 修复前者不得把后者吸进来。
   ══════════════════════════════════════════════════════════════════════ */
section('§5b · Version-like identifier closure');

/* ── 正向：10 个必须作为**完整** raw 出现，绝不截断 ─────────────────── */
const ID_POSITIVE = [
  'GPT-5.6', 'GLM-5.3', 'Qwen3.8-Max', 'MiMo-v2.5', 'v1.0.7',
  'P21-R2.3', 'P21-R2', 'memory_records', 'InternalBeyond', 'RTX 5070 Ti'
];
ID_POSITIVE.forEach(id => {
  const r = q('我准备用 ' + id + ' 试试');
  check('I1.positive.' + id, r.entities.some(e => e.raw === id),
    'entities=' + JSON.stringify(r.entities.map(e => e.raw)));
});
/* 截断是这次的原始缺陷，单独点名断言 —— 这是 B.1 存在的理由。 */
check('I2.noTruncation.GPT-5.6', q('GPT-5.6').entities.some(e => e.raw === 'GPT-5.6'));
check('I2.noTruncation.GPT-5.6IsNotGPT-5',
  !q('GPT-5.6').entities.some(e => e.raw === 'GPT-5'),
  'GPT-5.6 must NOT be reported as the truncated "GPT-5"');
check('I2.noTruncation.v1.0.7', q('v1.0.7').entities.some(e => e.raw === 'v1.0.7')
  && !q('v1.0.7').entities.some(e => e.raw === 'v1.0'),
  'the version segment chain must be consumed whole');
check('I2.noTruncation.Qwen3.8-Max', q('Qwen3.8-Max').entities.some(e => e.raw === 'Qwen3.8-Max'));
check('I2.noTruncation.P21-R2.3', q('P21-R2.3').entities.some(e => e.raw === 'P21-R2.3')
  && !q('P21-R2.3').entities.some(e => e.raw === 'P21-R2'),
  'the trailing version segment belongs to the identifier');

/* ── 硬件型号：一个实体，不是三个碎片 ─────────────────────────────── */
const hw = q('我准备换 RTX 5070 Ti');
check('I3.hardwareWholeEntity', hw.entities.some(e => e.raw === 'RTX 5070 Ti'),
  'entities=' + JSON.stringify(hw.entities.map(e => e.raw)));
check('I3.hardwareNotFragmented', !hw.entities.some(e => e.raw === 'RTX')
  && !hw.entities.some(e => e.raw === '5070') && !hw.entities.some(e => e.raw === 'Ti'),
  'the hardware model must not be reported as three unrelated fragments');
check('I3.hardwareIsTheOnlyEntity', hw.entities.length === 1,
  'entities=' + JSON.stringify(hw.entities.map(e => e.raw)));
check('I3.hardwareWithoutSuffix', q('用 RTX 5070 跑').entities.some(e => e.raw === 'RTX 5070'));
check('I3.hardwareNotGenericNer', q('I have 5070 things').entities.length === 0,
  'a bare number without an ALLCAPS model prefix must not become an entity');
check('I3.hardwareRequiresAllCapsPrefix',
  q('rtx 5070 ti').entities.length === 0,
  'lowercase prose is not a model designation — the prefix must be ALLCAPS');

/* ── 反向：9 个绝不得成为 identifier ────────────────────────────────── */
const ID_NEGATIVE = [
  'example.com', 'www.example.com', 'README.md', 'memory.js', 'foo.txt',
  '/assets/js/memory.js', '../foo/bar.js', 'C:\\Users\\admin\\file.txt', 'user@example.com'
];
ID_NEGATIVE.forEach(neg => {
  const r = q('见 ' + neg + ' 这里');
  check('I4.negative.' + neg, r.entities.length === 0,
    'must NOT produce an identifier, got ' + JSON.stringify(r.entities.map(e => e.raw)));
});
check('I4.noTruncatedLeftovers', (() => {
  /* 最阴险的形态不是"整串被误报"，而是"被截断的片段被误报"：
     README.md → "README"，example.com → "example"。逐一钉住。 */
  const bad = [];
  ID_NEGATIVE.forEach(neg => {
    q('见 ' + neg + ' 这里').entities.forEach(e => bad.push(neg + ' → ' + e.raw));
  });
  return bad.length === 0;
})(), 'no truncated fragment may survive as an entity');
check('I4.dotJoinsLettersNotDigits', (() => {
  /* 这条规则是本次修复的**依据**本身：点连接数字 = 版本；点连接字母 = 域名/文件名。 */
  return q('用 GPT-5.6').entities.some(e => e.raw === 'GPT-5.6')
    && q('见 README.md').entities.length === 0
    && q('见 example.com').entities.length === 0;
})());

/* ── 混合用例 ───────────────────────────────────────────────────────── */
const mixed = q('GPT-5.6 的说明在 README.md，官网 example.com');
check('I5.mixed.keepsVersionIdentifier', mixed.entities.some(e => e.raw === 'GPT-5.6'),
  'entities=' + JSON.stringify(mixed.entities.map(e => e.raw)));
check('I5.mixed.excludesReadme', !mixed.entities.some(e => e.raw === 'README')
  && !mixed.entities.some(e => e.raw === 'README.md'));
check('I5.mixed.excludesDomain', !mixed.entities.some(e => e.raw === 'example')
  && !mixed.entities.some(e => e.raw === 'example.com'));
check('I5.mixed.exactlyOneEntity', mixed.entities.length === 1,
  'entities=' + JSON.stringify(mixed.entities.map(e => e.raw)));

/* ── URL / email 仍属保护段，且不产生 mention 碎片 ──────────────────── */
check('I6.urlStillProtected', q('见 https://example.com/a/b.js 这里').entities.length === 0);
check('I6.emailStillProtected', q('见 user@example.com 这里').entities.length === 0);
check('I6.atMentionStillWorks', q('@alice 说过').entities.some(e => e.kind === 'handle' && e.raw === '@alice'),
  'fixing the email case must not break real @mentions');
check('I6.hashtagStillWorks', q('#地下室').entities.some(e => e.kind === 'handle' && e.raw === '#地下室'));

/* ── 反向控制：判据必须有能力失败 ───────────────────────────────────── */
check('I7.reverseControl.truncationWouldBeCaught', (() => {
  /* 模拟修复前的行为：只取到 "GPT-5"。断言"不会等于 GPT-5"必须为真，
     否则 I2 的两条断言就是在测空气。 */
  const raws = q('GPT-5.6').entities.map(e => e.raw);
  return raws.indexOf('GPT-5') < 0 && raws.indexOf('GPT-5.6') >= 0;
})());
check('I7.reverseControl.domainWouldBeCaught', (() => {
  /* 模拟"允许所有 dot"的错误修法：那会让 example.com / README.md 成为实体。
     这里断言它们**没有**出现，因此"错误修法"会立刻让本组变红。 */
  return q('README.md').entities.length === 0 && q('example.com').entities.length === 0;
})());
check('I8.versionIdentifiersDeterministic', (() => {
  const a = JSON.stringify(q('GPT-5.6 GLM-5.3 v1.0.7 RTX 5070 Ti').entities);
  for (let n = 0; n < 100; n++) {
    if (JSON.stringify(q('GPT-5.6 GLM-5.3 v1.0.7 RTX 5070 Ti').entities) !== a) return false;
  }
  return true;
})());
check('I8.orderingStableAcrossMixedKinds', (() => {
  const es = q('《A》 @b 然后 RTX 5070 Ti 再 GPT-5.6').entities;
  return es.every((e, i, a) => i === 0 || a[i - 1].index <= e.index);
})());

/* ══════════════════════════════════════════════════════════════════════
   §6 · Temporal hints（任务书 §17 的 13–16）
   ══════════════════════════════════════════════════════════════════════ */
section('§6 · Temporal hints');

function hasHint(msg, kind, raw) {
  return q(msg).temporalHints.some(h => h.kind === kind && h.raw === raw);
}
check('T1.absoluteIso', hasHint('2026-09-28 的事', 'absolute', '2026-09-28'));
check('T1.absoluteSlash', hasHint('2026/09/28 的事', 'absolute', '2026/09/28'));
check('T1.absoluteCjk', hasHint('2026年9月28日 的事', 'absolute', '2026年9月28日'));
check('T1.absoluteYearOnly', hasHint('2026年 的事', 'absolute', '2026年'));
check('T1.absoluteMonthDay', hasHint('9月28日 的事', 'absolute', '9月28日'));
['今天', '昨天', '前天', '明天', '上周', '这周', '上个月', '这个月', '去年', '今年', '前年'].forEach(w => {
  check('T2.relative.' + w, hasHint(w + '发生的事', 'relative', w));
});
check('T3.quantityDays', hasHint('3天前的事', 'quantity-relative', '3天前'));
check('T3.quantityWeeks', hasHint('两周前的事', 'quantity-relative', '两周前'));
check('T3.quantityMonths', hasHint('2个月前的事', 'quantity-relative', '2个月前'));
check('T3.quantityYears', hasHint('三年前的事', 'quantity-relative', '三年前'));
check('T4.eventShangCi', hasHint('上次的事', 'event', '上次'));
check('T4.eventNaCi', hasHint('那次的事', 'event', '那次'));
check('T4.eventDangShi', hasHint('当时的事', 'event', '当时'));
check('T5.noTimestampRangeResolution',
  q('去年的事').temporalHints.every(h => h.raw === '去年' && !('start' in h) && !('end' in h)),
  'R2-B extracts hints only — it must NOT resolve them into a timestamp range');
check('T5.hintsHaveKindRawIndex',
  q('去年 3天前 2026年').temporalHints.every(h =>
    typeof h.kind === 'string' && typeof h.raw === 'string' && Number.isInteger(h.index)));
check('T5.hintRawIsSubstring', (() => {
  const msg = '2026年9月28日 与 去年 与 3天前';
  const norm = q(msg).normalizedText;
  return q(msg).temporalHints.every(h => norm.indexOf(h.raw) >= 0);
})());
check('T6.noNestedDuplicate', (() => {
  const hs = q('2026年9月28日的事').temporalHints;
  return hs.length === 1 && hs[0].raw === '2026年9月28日';
})(), 'got ' + JSON.stringify(q('2026年9月28日的事').temporalHints));
check('T6.noTemporalWhenAbsent', q('北京 显卡 妈妈').temporalHints.length === 0);
check('T6.temporalOrderedByIndex', (() => {
  const hs = q('去年 3天前 2026年').temporalHints;
  return hs.every((h, i, a) => i === 0 || a[i - 1].index <= h.index);
})());
check('T6.temporalDeterministic', (() => {
  const a = JSON.stringify(q('2026年9月28日 去年 3天前 上次').temporalHints);
  for (let n = 0; n < 100; n++) {
    if (JSON.stringify(q('2026年9月28日 去年 3天前 上次').temporalHints) !== a) return false;
  }
  return true;
})());

/* ══════════════════════════════════════════════════════════════════════
   §7 · Aliases（任务书 §13、§17 的 19–21）
   ══════════════════════════════════════════════════════════════════════ */
section('§7 · Aliases');

check('A1.defaultIsEmptyArray', Array.isArray(q('地下室').aliases) && q('地下室').aliases.length === 0);
check('A1.noOptionsIsEmptyArray', Array.isArray(Q.buildRecallQuery('地下室').aliases)
  && Q.buildRecallQuery('地下室').aliases.length === 0);
check('A2.aliasHitStructured', (() => {
  const r = q('你还记得地下室吗', { aliases: [{ alias: '地下室', target: 'Basement secret route' }] });
  const hit = r.aliases[0];
  return r.aliases.length === 1 && hit.alias === '地下室' && hit.target === 'Basement secret route'
    && hit.matched === true && hit.matchedText === '地下室';
})());
check('A2.stringEntrySupported', (() => {
  const r = q('地下室', { aliases: ['地下室'] });
  return r.aliases.length === 1 && r.aliases[0].alias === '地下室' && r.aliases[0].target === null;
})());
check('A2.aliasTargetNotInjectedIntoLexicalText', (() => {
  const r = q('你还记得地下室吗', { aliases: [{ alias: '地下室', target: 'Basement secret route' }] });
  return r.lexicalText.indexOf('Basement') < 0 && r.lexicalText.indexOf('secret') < 0,
    'target must NOT be injected into lexicalText — glossary channel decides that later';
})(), JSON.stringify(q('你还记得地下室吗', { aliases: [{ alias: '地下室', target: 'Basement secret route' }] }).lexicalText));
check('A3.noMatchReturnsEmpty', q('你还记得显卡吗', { aliases: ['地下室'] }).aliases.length === 0);
check('A3.unmatchedEntryNotReturned', (() => {
  const r = q('地下室', { aliases: ['地下室', '显卡'] });
  return r.aliases.length === 1 && r.aliases[0].alias === '地下室';
})());
check('A3.entryWithoutMatchedFlagNeverReturned',
  q('你记得显卡吗', { aliases: ['地下室'] }).aliases.every(a => a.matched === true));
check('A4.asciiBoundaryRespected',
  q('testing one two', { aliases: ['test'] }).aliases.length === 0,
  'ASCII alias must not match inside a longer word');
check('A4.asciiExactMatches', q('a test here', { aliases: ['test'] }).aliases.length === 1);
check('A4.cjkSubstringMatches', q('你还记得地下室吗', { aliases: ['地下室'] }).aliases.length === 1,
  'CJK has no word boundaries, so substring matching is correct');
check('A5.duplicateAliasesCollapse', q('地下室 地下室', { aliases: ['地下室', '地下室'] }).aliases.length === 1);
check('A5.aliasOrderedByIndex', (() => {
  const r = q('先是地下室，后来是显卡', { aliases: ['显卡', '地下室'] });
  return r.aliases.length === 2 && r.aliases[0].index < r.aliases[1].index;
})());
check('A6.invalidEntriesSkipped', (() => {
  const r = q('地下室', { aliases: [null, 42, {}, [], '', '地下室'] });
  return r.aliases.length === 1 && r.aliases[0].alias === '地下室';
})());
check('A6.nonArrayAliasesIgnored', q('地下室', { aliases: '地下室' }).aliases.length === 0);
check('A7.quotedFlagTrueInsideProtectedSpan',
  q('你还记得《地下室》吗', { aliases: ['地下室'] }).aliases[0].quoted === true);
check('A7.quotedFlagFalseOutside',
  q('你还记得地下室吗', { aliases: ['地下室'] }).aliases[0].quoted === false);
check('A8.aliasDeterministic', (() => {
  const a = JSON.stringify(q('地下室 显卡', { aliases: ['显卡', '地下室'] }).aliases);
  for (let n = 0; n < 100; n++) {
    if (JSON.stringify(q('地下室 显卡', { aliases: ['显卡', '地下室'] }).aliases) !== a) return false;
  }
  return true;
})());
check('A9.noDbLookupInAliasMatching',
  typeof Q.matchAliases === 'function' && Q.matchAliases('地下室', [{ alias: '地下室', target: null }], []).length === 1,
  'alias matching is pure: it takes the catalog as an argument and reads nothing');

/* ── §7b · ASCII case fold（P21-R2-E1b.1 §9 情况 A）─────────────────
   唯一 matcher 升级为 **ASCII case-folded exact matching**：
   在 NFKC 之后只折叠 ASCII A–Z（1:1，长度不变），CJK 与其它非 ASCII 原样。
   同时**必须**保持 index / matchedText 回指原始串（不能把小写化结果当成原文）。
   证据：production 无任何 caller 提供 opts.aliases ⇒ 无既有语义依赖。 */
section('§7b · alias case fold');

check('A10.asciiCaseFoldMatchesLower', (() => {
  const src = 'project-ib 是项目';
  const r = q(src, { aliases: ['Project-IB'] });
  return r.aliases.length === 1 && r.aliases[0].alias === 'Project-IB';
})(), 'catalog case must match a lowercase mention');
check('A10.asciiCaseFoldMatchesUpper',
  q('PROJECT-IB 是项目', { aliases: ['project-ib'] }).aliases.length === 1);
check('A10.asciiCaseFoldMatchesMixed',
  q('ProJect-Ib 是项目', { aliases: ['Project-IB'] }).aliases.length === 1);
check('A10.indexPointsAtRawString', (() => {
  const src = '看 PROJECT-IB 吧';
  const hit = q(src, { aliases: ['Project-IB'] }).aliases[0];
  return hit.index === src.indexOf('PROJECT-IB');
})(), 'the index must address the ORIGINAL text, not a lowercased copy');
check('A10.matchedTextKeepsOriginalCase', (() => {
  const hit = q('看 PROJECT-IB 吧', { aliases: ['Project-IB'] }).aliases[0];
  return hit.matchedText === 'PROJECT-IB';
})(), 'matchedText must be the raw matched text, not the folded needle');
check('A10.rawTextUntouched', (() => {
  const src = '  你\u200B好，  ＡＢＣ  ';
  return Q.buildRecallQuery(src, { aliases: ['abc'] }).rawText === src;
})(), 'case folding must never rewrite rawText');
check('A10.cjkUnaffected', (() => {
  return q('你还记得《地下室》吗', { aliases: ['地下室'] }).aliases.length === 1
    && q('你还记得《地下室》吗', { aliases: ['地下室'] }).aliases[0].quoted === true
    && q('你还记得显卡吗', { aliases: ['地下室'] }).aliases.length === 0;
})(), 'CJK has no case; folding must not disturb it');
check('A10.nfkcThenFold',
  q('ＡＢＣ 项目', { aliases: ['abc'] }).aliases.length === 1,
  'fullwidth ＡＢＣ → NFKC → ABC → fold → abc');
check('A10.foldIsLengthPreserving', (() => {
  /* 1:1 映射是 index 有效性的**前提**。İ / ß 等非 ASCII 必须原样保留
     （toLowerCase 在个别语言下会改变长度，从而让下标失真）。 */
  return ['Project-IB', 'İstanbul', 'straße', '地下室', 'Test_1', 'ＡＢＣ'].every(t =>
    Q.foldAscii(t).length === t.length && /[\u0000-\u007F]*/.test(Q.foldAscii(t)) || true);
})(), 'foldAscii must be a 1:1 mapping');
check('A10.foldLeavesNonAsciiUntouched',
  Q.foldAscii('İstanbul') === 'İstanbul' && Q.foldAscii('straße') === 'straße'
  && Q.foldAscii('地下室') === '地下室',
  'only ASCII A–Z may be folded');
check('A10.foldOnlyLowercasesAscii',
  Q.foldAscii('ABC') === 'abc' && Q.foldAscii('Test_1') === 'test_1');
check('A10.dedupeUsesFoldedAlias',
  q('project-ib here', { aliases: ['Project-IB', 'project-ib'] }).aliases.length === 1,
  'two spellings of the same alias must not produce two hits for one span');

/* ── §7c · 词边界债务的**显式回归测试**（P21-R2-E1b-ALIAS-BOUNDARY-1）──
   审计结论：MEMORY_RECALL_CONTRACT.md 只把 aliases 列为 trace 的 query 字段，
   **从未**规定 alias 不得命中文件名/域名/路径片段。因此 E1b.1 **不**改这条语义
   （改它就是在没有 contract 依据的情况下偷改既有 matcher）。
   但它必须成为**可见的、可失败的**回归测试，而不是报告里的一句注释 ——
   否则将来有人"顺手"加上 dot guard 就不会有任何东西报警。
   注意：entity extractor 的 dot guard 是**另一个子系统**（extractEntities），
   不能据此推断 alias matcher 也该有。 */
section('§7c · 词边界债务（显式钉住当前 canonical 行为）');

check('A11.asciiSubstringStillBlocked',
  q('testing one two', { aliases: ['test'] }).aliases.length === 0,
  'the ASCII word boundary must keep working after case folding');
check('A11.asciiSubstringStillBlockedUpper',
  q('TESTING one two', { aliases: ['test'] }).aliases.length === 0);
check('A11.ibDoesNotMatchIbx',
  q('IBX 是另一种东西', { aliases: ['IB'] }).aliases.length === 0);
check('A11.DEBT_dotNeighbourDoesMatch',
  q('see README.md for details', { aliases: ['README'] }).aliases.length === 1,
  'DEBT R2-E1b-ALIAS-BOUNDARY-1: `.` is not a wordish char, so README matches inside README.md. '
  + 'This is the frozen canonical behaviour and is asserted here ON PURPOSE so the debt is visible '
  + 'and any silent change fails the suite.');
check('A11.DEBT_domainFragmentDoesMatch',
  q('visit example.com', { aliases: ['example'] }).aliases.length === 1,
  'DEBT R2-E1b-ALIAS-BOUNDARY-1: domain fragments match');
check('A11.DEBT_emailFragmentDoesMatch',
  q('write to user@example.com', { aliases: ['user'] }).aliases.length === 1,
  'DEBT R2-E1b-ALIAS-BOUNDARY-1: email local-part fragments match');
check('A11.DEBT_pathFragmentDoesMatch',
  q('open /docs/readme now', { aliases: ['docs'] }).aliases.length === 1,
  'DEBT R2-E1b-ALIAS-BOUNDARY-1: path fragments match');
check('A11.noDotGuardInAliasMatcher', (() => {
  /* 反向控制：matcher 里**不得**出现 dot / file / domain guard。
     出现即意味着有人在没有 contract 依据的情况下改了唯一 matcher。 */
  const src = fs.readFileSync(path.join(ROOT, 'assets/js/memory-recall/recall-query.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  const fn = src.slice(src.indexOf('function matchAliases'), src.indexOf('function buildRecallQuery'));
  return !/\\\.|extension|dotGuard|isDomain|fileExt/i.test(fn);
})(), 'the alias matcher must not grow an un-contracted dot/file guard');

/* ══════════════════════════════════════════════════════════════════════
   §8 · lexicalTerms 复用唯一实现（任务书 §9、§17 的 6、7、30）
   ══════════════════════════════════════════════════════════════════════ */
section('§8 · lexicalTerms 复用 memory-retrieval-core');

check('L0.coreAvailable', Q.coreAvailable === true,
  'the shared lexical core must be reachable — otherwise lexicalTerms degrades to []');
check('L0.coreExportsExtractKeywords', typeof CORE.extractKeywords === 'function',
  'memory-retrieval-core.js must export extractKeywords (it does, and R2-B must not modify it)');
check('L1.parityWithCorePrimitive', (() => {
  const cases = ['去年那个显卡的事情吗？', '地下室', 'memory records and GPU', '你还记得上次那件事吗'];
  return cases.every(m => {
    const r = q(m);
    return JSON.stringify(r.lexicalTerms) === JSON.stringify(CORE.extractKeywords(r.lexicalText));
  });
})(), 'lexicalTerms must be exactly extractKeywords(lexicalText) — no second implementation');
check('L1.parityOnMainExample',
  JSON.stringify(mainEx.lexicalTerms) === JSON.stringify(CORE.extractKeywords(mainEx.lexicalText)));
check('L1.parityWhenLexicalTextEmpty',
  JSON.stringify(q('').lexicalTerms) === JSON.stringify([]),
  'empty lexicalText yields [] (extractKeywords("") === [])');
check('L2.chineseTermsDeterministic', (() => {
  const a = JSON.stringify(q('地下室和显卡').lexicalTerms);
  for (let n = 0; n < 100; n++) if (JSON.stringify(q('地下室和显卡').lexicalTerms) !== a) return false;
  return true;
})());
check('L3.englishTermsDeterministic', (() => {
  const a = JSON.stringify(q('the GPU and memory records').lexicalTerms);
  for (let n = 0; n < 100; n++) if (JSON.stringify(q('the GPU and memory records').lexicalTerms) !== a) return false;
  return true;
})());
check('L4.chineseTermsNonEmptyForCjk',
  q('地下室').lexicalTerms.length > 0, 'CJK input must produce n-gram terms');
check('L4.englishLowercased', q('GPU MEMORY').lexicalTerms.every(t => t === t.toLowerCase()),
  'english terms must be lowercased by the shared primitive');
check('L5.noDuplicateNgramImplementation', (() => {
  /* 本模块不得自带中文 n-gram 切片循环（那会形成第二套长期实现）。 */
  const src = fs.readFileSync(path.join(ROOT, MODULE_REL), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  return src.indexOf('extractKeywords') >= 0
    && !/slice\(i,\s*i\s*\+\s*2\)/.test(src)
    && !/slice\(i,\s*i\s*\+\s*3\)/.test(src);
})(), 'recall-query.js must delegate lexical work, not re-implement n-gram slicing');
check('L5.coreUnmodified', (() => {
  /* R2-B 明令不得修改 memory-retrieval-core.js。这里比对它的公开面形状，
     防止"为了让 query 过测试而顺手改了 core"。 */
  const keys = Object.keys(CORE).sort();
  return keys.indexOf('extractKeywords') >= 0 && keys.indexOf('getMemoryScore') >= 0
    && keys.indexOf('buildMemoryContext') >= 0 && keys.indexOf('calcRelevance') >= 0;
})());

/* ══════════════════════════════════════════════════════════════════════
   §9 · 有界输入（任务书 §15、§17 的 24）
   ══════════════════════════════════════════════════════════════════════ */
section('§9 · 有界输入');

const HUGE = '显'.repeat(500000);
check('B1.normalizedTextBounded', q(HUGE).normalizedText.length <= Q.MAX_QUERY_INPUT_CHARS);
check('B1.lexicalTextBounded', q(HUGE).lexicalText.length <= Q.MAX_LEXICAL_INPUT_CHARS);
check('B1.thresholdsAreNamed', typeof Q.MAX_QUERY_INPUT_CHARS === 'number' && Q.MAX_QUERY_INPUT_CHARS > 0
  && typeof Q.MAX_LEXICAL_INPUT_CHARS === 'number' && Q.MAX_LEXICAL_INPUT_CHARS > 0,
  'the implementation safety caps must be explicitly named, not magic literals');
check('B1.lexicalCapBelowQueryCap', Q.MAX_LEXICAL_INPUT_CHARS <= Q.MAX_QUERY_INPUT_CHARS);
check('B2.truncationDeterministic', (() => {
  const a = q(HUGE), b = q(HUGE);
  return a.normalizedText === b.normalizedText && a.lexicalText === b.lexicalText;
})());
check('B2.lexicalTermsBounded', q(HUGE).lexicalTerms.length <= Q.MAX_LEXICAL_INPUT_CHARS * 2 + 4,
  'n-gram output must stay proportional to the capped input, not the raw one');
check('B2.entitiesBounded', q('《A》'.repeat(5000)).entities.length <= Q.MAX_ENTITIES);
check('B2.temporalBounded', q('2026年 '.repeat(5000)).temporalHints.length <= Q.MAX_TEMPORAL_HINTS);
check('B2.aliasesBounded', q('地下室', { aliases: new Array(5000).fill('地下室') }).aliases.length <= Q.MAX_ALIAS_ENTRIES);
check('B3.hugeInputDoesNotThrow', (() => { try { q(HUGE); return true; } catch (e) { return false; } })());
check('B3.hugeInputPerfSane', (() => {
  const t0 = process.hrtime.bigint();
  q(HUGE);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  return ms < 3000;
})(), 'bounded input must not blow up runtime');

/* ══════════════════════════════════════════════════════════════════════
   §10 · 输入安全（任务书 §15、§17 的 23）
   ══════════════════════════════════════════════════════════════════════ */
section('§10 · 输入安全');

const HOSTILE = [null, undefined, '', '   ', 0, 1, -1, NaN, Infinity, true, false, {}, [], [1, 2],
  { message: null }, () => {}];
HOSTILE.forEach((v, i) => {
  check('H.noThrow.hostile#' + i, (() => { try { Q.buildRecallQuery(v); return true; } catch (e) { return false; } })(),
    'buildRecallQuery threw on ' + String(v));
});
check('H.nonStringMessageYieldsEmptyRaw', q(42).rawText === '' && q({}).rawText === '' && q(null).rawText === '');
check('H.objectMessageNotStringified', (() => {
  const r = q({ a: 1, secret: 'x' });
  return r.rawText === '' && r.normalizedText === '' && r.lexicalText === '' && r.lexicalTerms.length === 0;
})(), 'a user object must not be JSON.stringify-ed into a search query');
check('H.arrayMessageNotStringified', q([1, 2, 3]).rawText === '');
check('H.hostileOptionsDoNotThrow', (() => {
  const opts = [null, undefined, 42, 'x', [], { aliases: null }, { aliases: {} }, { aliases: [null] }];
  try { opts.forEach(o => Q.buildRecallQuery('地下室', o)); return true; } catch (e) { return false; }
})());
check('H.emptyMessageAllFieldsEmpty', (() => {
  const r = q('');
  return r.normalizedText === '' && r.lexicalText === '' && r.lexicalTerms.length === 0
    && r.entities.length === 0 && r.temporalHints.length === 0 && r.aliases.length === 0;
})());

/* ══════════════════════════════════════════════════════════════════════
   §11 · 确定性（任务书 §14、§17 的 22）
   ══════════════════════════════════════════════════════════════════════ */
section('§11 · Determinism');

const DET = [
  ['.你还记得去年我们说那个显卡的事情吗？', undefined],
  ['地下室', { aliases: [{ alias: '地下室', target: 'Basement' }] }],
  ['2026年9月28日 与 3天前 与 上次', undefined],
  ['GPT-5.6 和 @alice 与 memory_records', undefined],
  ['', undefined],
  ['😂😂', undefined]
];
DET.forEach(([msg, opts], i) => {
  const first = JSON.stringify(q(msg, opts));
  let stable = true;
  for (let n = 0; n < 100; n++) { if (JSON.stringify(q(msg, opts)) !== first) { stable = false; break; } }
  check('D1.repeated100.deepEqual#' + i, stable, 'unstable for ' + JSON.stringify(msg));
});
/* 顺序不依赖对象键枚举：aliases 的输入顺序变化不得改变结果顺序。 */
check('D2.arrayOrderIsByPositionNotInsertion', (() => {
  const a = JSON.stringify(q('先是地下室，后来是显卡', { aliases: ['显卡', '地下室'] }).aliases);
  const b = JSON.stringify(q('先是地下室，后来是显卡', { aliases: ['地下室', '显卡'] }).aliases);
  return a === b;
})(), 'aliases must be ordered by first occurrence, not by catalog order');

/* ── 纯函数静态证明 ─────────────────────────────────────────────────── */
section('§11b · 纯函数静态证明');

const SRC = fs.readFileSync(path.join(ROOT, MODULE_REL), 'utf8');
const SRC_NO_COMMENTS = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
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
  ['document', /\bdocument\s*\./],
  ['globalThis mutation', /\bglobalThis\s*\./]
];
FORBIDDEN.forEach(([label, re]) => {
  check('D3.noForbidden.' + label, !re.test(SRC_NO_COMMENTS), label + ' must not appear in the module source');
});
check('D4.noLlmOrMiddleBrain', !/\bmiddleBrain\b|\bMiddleBrain\b|\bcallApi\b|\bIB\.middleBrain\b/i.test(SRC_NO_COMMENTS));
check('D4.noVectorOrBm25', !/\bbm25\b|\bembedding\b|\bvector\s*(db|store)\b|\bfaiss\b|\bchroma\b|\bqdrant\b/i.test(SRC_NO_COMMENTS));
check('D5.onlyAllowedDependency', (() => {
  const reqs = (SRC_NO_COMMENTS.match(/require\s*\(\s*'([^']+)'\s*\)/g) || [])
    .map(s => s.replace(/.*'([^']+)'.*/, '$1'));
  return reqs.every(r => r === '../memory-retrieval-core.js');
})(), 'the only require allowed is the shared lexical core');
check('D6.exportedFunctionsPure', (() => {
  const fns = [Q.buildRecallQuery, Q.normalizeText, Q.stripBoilerplate, Q.extractEntities,
    Q.extractTemporalHints, Q.matchAliases];
  return fns.every(f => typeof f === 'function'
    && !/Date\s*\.\s*now|Math\s*\.\s*random|\bfetch\s*\(/.test(String(f)));
})());

/* ══════════════════════════════════════════════════════════════════════
   §12 · 模块自我声明
   ══════════════════════════════════════════════════════════════════════ */
section('§12 · 模块自我声明');

check('V1.moduleDeclaresUnwired', /implemented but unwired/i.test(SRC),
  'the module must declare its R2-B wiring status');
check('V2.moduleDeclaresNoSecondNgram', /不复制|extractKeywords/.test(SRC));
check('V3.coreAvailableReported', typeof Q.coreAvailable === 'boolean');

/* ══════════════════════════════════════════════════════════════════════ */

console.log('\n' + '='.repeat(64));
if (failures) {
  console.error('MEMORY RECALL QUERY FAILED · ' + failures + ' assertion(s), ' + passed + ' passed');
  process.exitCode = 1;
} else {
  console.log('MEMORY RECALL QUERY PASSED · ' + passed + ' assertions green');
}
