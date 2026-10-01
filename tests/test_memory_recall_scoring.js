'use strict';
/* Internal Beyond · P21-R2-C · Scoring（Node，零依赖，不开浏览器）
   运行：node tests/test_memory_recall_scoring.js

   被测：assets/js/memory-recall/scoring.js（纯函数）
   目标：证明 R2-A 冻结的两个独立概念 —— memoryValue 与 relevanceScore ——
         按契约实现，且 **没有复制** 既有 core 的任何公式。
   ══════════════════════════════════════════════════════════════════════════ */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const MODULE_REL = 'assets/js/memory-recall/scoring.js';
const S = require(path.join(ROOT, MODULE_REL));
const CORE = require(path.join(ROOT, 'assets/js/memory-retrieval-core.js'));

let failures = 0;
let passed = 0;
const check = (name, cond, detail) => {
  if (cond) { passed++; console.log('  PASS  ' + name); return true; }
  failures++;
  console.error('  FAIL  ' + name + (detail !== undefined ? '  -> ' + detail : ''));
  return false;
};
const section = t => console.log('\n── ' + t + ' ──');

const NOW = 1750000000000;
const DAY = 86400000;
function mem(over) {
  return Object.assign({
    id: 'm', title: 't', content: 'c', importance: 5, arousal: 0.3, resolved: false,
    activationCount: 0, created: NOW - DAY, lastActivated: NOW - DAY,
    visibility: 'public', tags: [], domain: '日常'
  }, over || {});
}

/* ══════════════════════════════════════════════════════════════════════
   §1 · computeLegacyMemoryValue ≡ core.getMemoryScore（不复制公式）
   ══════════════════════════════════════════════════════════════════════ */
section('§1 · LegacyMemoryValue parity');

const LEGACY_FIXTURES = [
  ['default', mem({})],
  ['pinned', mem({ pinned: true })],
  ['pinnedLowImportance', mem({ pinned: true, importance: 1, arousal: 0 })],
  ['resolved', mem({ resolved: true, created: NOW - DAY * 40, lastActivated: NOW - DAY * 40 })],
  ['unresolvedOld', mem({ created: NOW - DAY * 40, lastActivated: NOW - DAY * 40 })],
  ['highActivation', mem({ activationCount: 900 })],
  ['zeroActivation', mem({ activationCount: 0 })],
  ['highArousal', mem({ arousal: 1 })],
  ['zeroArousal', mem({ arousal: 0 })],
  ['importanceTen', mem({ importance: 10 })],
  ['importanceOne', mem({ importance: 1 })],
  ['justActivated', mem({ lastActivated: NOW })],
  ['noLastActivated', mem({ lastActivated: undefined })],
  ['noCreated', mem({ created: undefined, lastActivated: undefined })],
  ['negativeActivation', mem({ activationCount: -5 })],
  ['stringImportance', mem({ importance: '7' })],
  ['zeroTime', mem({}), 0],
  ['futureTime', mem({ lastActivated: NOW + DAY * 100 })]
];
LEGACY_FIXTURES.forEach(([label, m, t]) => {
  const at = t === undefined ? NOW : t;
  check('L.' + label, S.computeLegacyMemoryValue(m, at) === CORE.getMemoryScore(m, at),
    JSON.stringify({ ours: S.computeLegacyMemoryValue(m, at), core: CORE.getMemoryScore(m, at) }));
});
check('L.pinnedIs999', S.computeLegacyMemoryValue(mem({ pinned: true }), NOW) === 999);
check('L.randomSweepParity', (() => {
  /* 200 组伪随机 fixture：任何一处公式漂移都会在这里露出来。 */
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  for (let i = 0; i < 200; i++) {
    const m = mem({
      importance: 1 + Math.floor(rnd() * 10),
      arousal: rnd(),
      resolved: rnd() < 0.5,
      activationCount: Math.floor(rnd() * 1200),
      created: NOW - Math.floor(rnd() * DAY * 900),
      lastActivated: NOW - Math.floor(rnd() * DAY * 900),
      pinned: rnd() < 0.1
    });
    if (S.computeLegacyMemoryValue(m, NOW) !== CORE.getMemoryScore(m, NOW)) return false;
  }
  return true;
})());
check('L.handlesNullMemory', S.computeLegacyMemoryValue(null, NOW) === CORE.getMemoryScore(null, NOW));
check('L.handlesUndefinedMemory', S.computeLegacyMemoryValue(undefined, NOW) === CORE.getMemoryScore(undefined, NOW));

/* ══════════════════════════════════════════════════════════════════════
   §2 · relevanceScore
   ══════════════════════════════════════════════════════════════════════ */
section('§2 · relevanceScore');

const m1 = mem({ id: 'a', title: '显卡', content: 'RTX 5070 Ti 选购指南', tags: ['硬件'], domain: '日常' });

check('R1.noTermsYieldsZero', S.scoreRelevance(m1, { lexicalTerms: [] }).score === 0);
check('R1.missingQueryYieldsZero', S.scoreRelevance(m1, undefined).score === 0);
check('R1.nullQueryYieldsZero', S.scoreRelevance(m1, null).score === 0);
check('R1.missingTermsKeyYieldsZero', S.scoreRelevance(m1, {}).score === 0);

const noHit = S.scoreRelevance(m1, { lexicalTerms: ['zzz', 'qqq'] });
check('R2.noLexicalHitYieldsZero', noHit.score === 0, 'got ' + noHit.score);

const fullHit = S.scoreRelevance(m1, { lexicalTerms: ['显卡'] });
check('R3.fullHitYieldsOne', fullHit.score === 1, 'got ' + fullHit.score);

const partial = S.scoreRelevance(m1, { lexicalTerms: ['显卡', 'zzz', 'qqq', 'www'] });
check('R4.partialHitIsBetweenZeroAndOne', partial.score > 0 && partial.score < 1, 'got ' + partial.score);

/* 归一化必须**恰好**是 core 的 relBoost 线性映射。 */
(function normalization() {
  const probes = [
    ['显卡'], ['zzz'], ['显卡', 'zzz'], ['显卡', 'zzz', 'qqq'], ['RTX'], ['日常']
  ];
  let ok = true, detail = '';
  probes.forEach(t => {
    const boost = CORE.calcRelevance(m1, t);
    const expect = Math.max(0, Math.min(1, (boost - 1) / 1.5));
    const got = S.scoreRelevance(m1, { lexicalTerms: t }).score;
    if (got !== expect) { ok = false; detail = JSON.stringify({ t, boost, expect, got }); }
  });
  check('R5.normalizationIsCoreLinearMap', ok, detail);
})();
check('R5.boostRangeIs15', S.RELEVANCE_BOOST_RANGE === 1.5);
check('R5.scoreAlwaysWithinUnitInterval', (() => {
  let seed = 999;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  for (let i = 0; i < 300; i++) {
    const terms = Array.from({ length: Math.floor(rnd() * 6) }, () => ['显卡', 'RTX', 'zzz', '日常', '硬件'][Math.floor(rnd() * 5)]);
    const r = S.scoreRelevance(m1, { lexicalTerms: terms });
    if (!(r.score >= 0 && r.score <= 1)) return false;
  }
  return true;
})());

/* signals 形状 */
check('R6.signalsShape', (() => {
  const sig = S.scoreRelevance(m1, { lexicalTerms: ['显卡'] }).signals;
  return typeof sig.lexicalScore === 'number'
    && typeof sig.lexicalTermsPresent === 'boolean'
    && typeof sig.lexicalMatch === 'boolean'
    && typeof sig.lexicalBoost === 'number';
})());
check('R6.signalsTermsPresentTrue', S.scoreRelevance(m1, { lexicalTerms: ['x'] }).signals.lexicalTermsPresent === true);
check('R6.signalsTermsPresentFalse', S.scoreRelevance(m1, { lexicalTerms: [] }).signals.lexicalTermsPresent === false);
check('R6.signalsMatchMirrorsScore',
  (S.scoreRelevance(m1, { lexicalTerms: ['显卡'] }).signals.lexicalMatch === true)
  && (S.scoreRelevance(m1, { lexicalTerms: ['zzz'] }).signals.lexicalMatch === false));
/* 刻意**不**存在 R2-C 之外的 boost 维度（防止范围蔓延）。 */
check('R7.noFutureBoostSignals', (() => {
  const sig = S.scoreRelevance(m1, { lexicalTerms: ['显卡'] }).signals;
  return !('entityBoost' in sig) && !('temporalBoost' in sig) && !('aliasBoost' in sig)
    && !('exactBoost' in sig) && !('tagBoost' in sig);
})(), 'R2-C must not pre-design the final relevance model');

/* ══════════════════════════════════════════════════════════════════════
   §3 · Hard Gate
   ══════════════════════════════════════════════════════════════════════ */
section('§3 · Hard Gate');

check('G1.zeroRejected', S.passesHardGate({ score: 0 }) === false);
check('G2.positivePasses', S.passesHardGate({ score: 1 }) === true);
check('G3.anyPositivePasses', S.passesHardGate({ score: 0.0001 }) === true,
  'R2-C uses score > 0 with NO uncalibrated threshold');
check('G4.missingScoreRejected', S.passesHardGate({}) === false);
check('G4.nullRejected', S.passesHardGate(null) === false);
check('G4.undefinedRejected', S.passesHardGate(undefined) === false);
check('G4.nanRejected', S.passesHardGate({ score: NaN }) === false);
check('G4.infinityRejected', S.passesHardGate({ score: Infinity }) === false);
check('G4.negativeRejected', S.passesHardGate({ score: -1 }) === false);
/* 不使用魔法阈值：0.1 / 0.25 / 0.5 都必须能通过（因为它们 > 0）。 */
[0.1, 0.25, 0.5, 0.99].forEach(v => {
  check('G5.noMagicThreshold.' + v, S.passesHardGate({ score: v }) === true);
});
/* 不对 pinned 特判：gate 只看 relevanceScore。 */
check('G6.gateIgnoresPinned', (() => {
  const src = fs.readFileSync(path.join(ROOT, MODULE_REL), 'utf8');
  const body = src.slice(src.indexOf('function passesHardGate'), src.indexOf('function passesHardGate') + 320);
  return body.indexOf('pinned') < 0;
})(), 'the gate must not special-case pinned');
check('G6.pinnedWithZeroRelevanceIsRejectedByGate',
  S.passesHardGate(S.scoreRelevance(mem({ pinned: true, title: 'zzz', content: 'qqq' }), { lexicalTerms: ['显卡'] })) === false,
  'Contract §6.3: score === 0 must not pass the gate, pinned included');

/* ══════════════════════════════════════════════════════════════════════
   §4 · 确定性 / 纯函数
   ══════════════════════════════════════════════════════════════════════ */
section('§4 · 确定性与纯函数');

check('D1.relevanceDeterministic', (() => {
  const a = JSON.stringify(S.scoreRelevance(m1, { lexicalTerms: ['显卡', 'zzz'] }));
  for (let i = 0; i < 100; i++) {
    if (JSON.stringify(S.scoreRelevance(m1, { lexicalTerms: ['显卡', 'zzz'] })) !== a) return false;
  }
  return true;
})());
check('D1.valueDeterministic', (() => {
  const a = S.computeLegacyMemoryValue(m1, NOW);
  for (let i = 0; i < 100; i++) if (S.computeLegacyMemoryValue(m1, NOW) !== a) return false;
  return true;
})());
check('D2.doesNotMutateMemory', (() => {
  const m = mem({ id: 'a' });
  const snap = JSON.stringify(m);
  S.scoreRelevance(m, { lexicalTerms: ['显卡'] });
  S.computeLegacyMemoryValue(m, NOW);
  return JSON.stringify(m) === snap;
})());
check('D2.doesNotMutateQuery', (() => {
  const q = { lexicalTerms: ['显卡'] };
  const snap = JSON.stringify(q);
  S.scoreRelevance(m1, q);
  return JSON.stringify(q) === snap;
})());

const SRC = fs.readFileSync(path.join(ROOT, MODULE_REL), 'utf8');
const BARE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
[
  ['Date.now', /Date\s*\.\s*now\s*\(/],
  ['new Date', /new\s+Date\s*\(/],
  ['Math.random', /Math\s*\.\s*random\s*\(/],
  ['setTimeout', /\bsetTimeout\s*\(/],
  ['fetch', /\bfetch\s*\(/],
  ['localStorage', /\blocalStorage\b/],
  ['indexedDB', /\bindexedDB\b/],
  ['document', /\bdocument\s*\./]
].forEach(([label, re]) => check('D3.noForbidden.' + label, !re.test(BARE), label + ' must not appear'));
check('D4.noLlmOrMiddleBrain', !/\bmiddleBrain\b|\bcallApi\b|\bprovider\b/i.test(BARE));
check('D4.noVectorOrBm25', !/\bbm25\b|\bembedding\b|\bvector\b|\bfaiss\b|\bchroma\b/i.test(BARE));

/* 唯一依赖 = 既有 core */
check('D5.onlyDependencyIsCore', (() => {
  const reqs = (BARE.match(/require\s*\(\s*'([^']+)'\s*\)/g) || []).map(s => s.replace(/.*'([^']+)'.*/, '$1'));
  return reqs.length === 1 && reqs[0] === '../memory-retrieval-core.js';
})());
/* **不复制公式**：模块内不得出现四因子字面量。 */
check('D6.doesNotDuplicateFourFactorFormula', (() => {
  /* 允许出现 getMemoryScore / calcRelevance 的**调用**；禁止它们的公式字面量。 */
  const banned = [
    /activationCount\s*\/\s*\(\s*activationCount\s*\+\s*300\s*\)/,
    /Math\s*\.\s*exp\s*\(\s*-\s*lambda/,
    /arousal\s*\*\s*0\.8/,
    /resolved\s*\?\s*0\.12\s*:\s*0\.05/
  ];
  return banned.every(re => !re.test(BARE));
})(), 'scoring.js must delegate to the unique core, not re-implement it');
check('D6.delegatesToCoreForBothConcepts',
  /CORE\.getMemoryScore/.test(BARE) && /CORE\.calcRelevance/.test(BARE));
check('D6.coreAvailableReported', typeof S.coreAvailable === 'function' && S.coreAvailable() === true);

/* ══════════════════════════════════════════════════════════════════════ */

console.log('\n' + '='.repeat(64));
if (failures) {
  console.error('MEMORY RECALL SCORING FAILED · ' + failures + ' assertion(s), ' + passed + ' passed');
  process.exitCode = 1;
} else {
  console.log('MEMORY RECALL SCORING PASSED · ' + passed + ' assertions green');
}
