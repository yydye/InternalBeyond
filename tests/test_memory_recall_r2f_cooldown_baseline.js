'use strict';
/* Internal Beyond · P21-R2-F1b · pre-F1b Frozen Behaviour Baseline
   运行：node tests/test_memory_recall_r2f_cooldown_baseline.js

   唯一职责：证明 frozen pre-F1b 基线是**真实静态数据**，且当前 core/orchestrator 与它的差异
   **没有一处是未申报的**。

   ⚠ 本文件**绝不**生成 / 更新 / 接受 snapshot。重新生成只能显式独立命令；
     因此源码里不出现任何写入 API，并有静态断言防止后人加上。
   ══════════════════════════════════════════════════════════════════════════ */

const fs = require('node:fs');

/* R2-F1b-HASH-BYTES-1: verification is byte-level canonical (CRLF->LF only). */
const { canonicalTextBytes, canonicalTextSha256, rawSha256 } = require('./helpers/canonical-text-hash.js');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const DIR = path.join(ROOT, 'tests/fixtures/memory-recall-r2f-cooldown-baseline');
const CORE = require(path.join(ROOT, 'assets/js/memory-retrieval-core.js'));
const ORCH = require(path.join(ROOT, 'assets/js/memory-recall/memory-recall-orchestrator.js'));

let failures = 0, passed = 0;
const check = (n, c, d) => { if (c) { passed++; console.log('  PASS  ' + n); } else { failures++; console.error('  FAIL  ' + n + (d !== undefined ? '  -> ' + d : '')); } };
const section = t => console.log('\n── ' + t + ' ──');

const MANIFEST = JSON.parse(fs.readFileSync(path.join(DIR, 'manifest.json'), 'utf8'));
const FILES = fs.readdirSync(path.join(DIR, 'cases')).filter(f => f.endsWith('.json')).sort();
const CASES = FILES.map(f => JSON.parse(fs.readFileSync(path.join(DIR, 'cases', f), 'utf8')));
const byId = {}; CASES.forEach(c => { byId[c.id] = c; });

/* ── 非再生保证 ── */
section('§5 · 非再生保证');
const SELF = fs.readFileSync(__filename, 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
const PARTS = [['write', 'FileSync'], ['append', 'FileSync'], ['mkdir', 'Sync'], ['rm', 'Sync'],
  ['unlink', 'Sync'], ['update', 'Snapshot'], ['accept', 'Snapshot'], ['regen', 'erate']];
const found = PARTS.map(p => p.join('')).filter(w => SELF.indexOf(w) >= 0);
check('B0.noWriteApiInBaselineTest', found.length === 0, JSON.stringify(found));
check('B0.noGeneratorUnderTests', fs.readdirSync(path.join(ROOT, 'tests'))
  .filter(n => /r2f_cooldown_baseline.*(gen|regen|update)/i.test(n)).length === 0);

/* ── manifest 完整性 ── */
section('§2 · manifest 完整性');
check('B1.schemaVersion', MANIFEST.schemaVersion === 1);
check('B2.phase', MANIFEST.phase === 'P21-R2-F1b', MANIFEST.phase);
check('B3.sourceHeadIsPreF1b', MANIFEST.sourceHead === '1e4f94c', MANIFEST.sourceHead);
check('B4.coreShaIsF1aCore (NOT the pre-F1a one)',
  MANIFEST.coreSha256 === '38F3F5F557D5D634EF432F2CE676BF8FA2EEA1B2D1C9437DD9F82F2954D5C223',
  MANIFEST.coreSha256);
check('B4.notTheOldPreF1aSha',
  MANIFEST.coreSha256 !== 'CC578F2640C68CEA4992389AAC1C2A7D7B8AD9BFAC4311AFB51FB6AA0DCE5B72');
check('B5.caseCount', MANIFEST.caseCount === 20 && FILES.length === 20, MANIFEST.caseCount + '/' + FILES.length);
check('B6.idListMatches', JSON.stringify(MANIFEST.cases.slice().sort())
  === JSON.stringify(FILES.map(f => f.replace(/\.json$/, '')).sort()));
check('B7.idsUnique', new Set(CASES.map(c => c.id)).size === CASES.length);
check('B8.perCaseShaRecorded', (() => {
  const crypto = require('node:crypto');
  return FILES.every(f => MANIFEST.caseSha256[f]
    && canonicalTextSha256(fs.readFileSync(path.join(DIR, 'cases', f)))
       === MANIFEST.caseSha256[f]);
})(), 'each frozen case file must match its recorded SHA-256');

/* ── 覆盖度 ── */
section('§4 · 覆盖度');
const groups = {}; CASES.forEach(c => { groups[c.group] = (groups[c.group] || 0) + 1; });
check('B9.groupCoverage', ['surface', 'pinned', 'channel', 'exploration', 'scope', 'group',
  'exclusion', 'compat', 'control', 'idempotency'].every(g => groups[g] >= 1), JSON.stringify(groups));
check('B9.sequenceCasesPresent', CASES.filter(c => c.kind === 'sequence-core').length >= 5,
  String(CASES.filter(c => c.kind === 'sequence-core').length));
check('B9.retryCaseUsesSameLogicalTurn', (() => {
  const c = byId['c20_retry_equivalent_logical_turn'];
  return c && c.sameLogicalTurn === true && c.turns.length === 3
    && c.turns.every(t => t === 1);
})(), 'the retry case must model three attempts inside ONE logical turn');

/* ── 静态自洽性 ── */
section('§3 · frozen data 自洽性');
let bad = [];
for (const c of CASES) {
  if (c.kind === 'core' || c.kind === 'orch') {
    if (!c.expected || typeof c.expected.count !== 'number') bad.push(c.id + ':no-expected');
    if (c.expected && c.expected.count !== c.expected.selected.length) bad.push(c.id + ':count');
  } else {
    if (!Array.isArray(c.steps) || c.steps.length !== c.turns.length) bad.push(c.id + ':steps');
    c.steps.forEach((s, i) => {
      if (s.logicalTurn !== c.turns[i]) bad.push(c.id + ':turn' + i);
      if (s.expected.count !== s.expected.selected.length) bad.push(c.id + ':count' + i);
    });
  }
  if (typeof c.random !== 'number' || !(c.random >= 0 && c.random < 1)) bad.push(c.id + ':random');
}
check('B10.frozenDataSelfConsistent', bad.length === 0, JSON.stringify(bad));
check('B11.sequenceStepsAreIdentical (pre-F1b had no state)', (() => {
  const seq = CASES.filter(c => c.kind === 'sequence-core');
  return seq.every(c => {
    const sig = JSON.stringify(c.steps[0].expected);
    return c.steps.every(s => JSON.stringify(s.expected) === sig);
  });
})(), 'every pre-F1b sequence step must be byte-identical — that is the delta evidence');

/* ── replay：未申报差异 = 失败 ── */
section('§3 · replay（未申报差异 = 失败）');
const DECLARED_ALL = MANIFEST.changedByR2F1b || {};
const DECLARED = {};
Object.keys(DECLARED_ALL).forEach(k => { if (k !== 'note') DECLARED[k] = DECLARED_ALL[k]; });

const replayCore = c => CORE.buildMemoryContext(c.records, Object.assign({}, c.options, { random: () => c.random }));
const GC = require(path.join(ROOT, 'assets/js/memory-recall/glossary-catalog.js'));
/* 函数型 option 无法序列化 ⇒ fixture 存 entry 列表，replay 时重建 provider。 */
const rebuildProvider = c => (c.glossaryEntries
  ? GC.createGlossaryCatalogProvider(() => c.glossaryEntries) : undefined);
const replayOrch = c => ORCH.recall(c.records, Object.assign({}, c.options, {
  glossaryProvider: rebuildProvider(c),
  /* random 必须注入：否则 replay 走 Math.random，fixture 就不是确定性的。 */
  random: () => c.random,
  turn: Object.assign({ message: c.message, conversationSignalAvailable: true, conversationId: 'dm:' + (c.options.apiId || 'role_a') }, c.turnExtra || {})
}));
const sameCore = (c) => JSON.stringify(replayCore(c)) === JSON.stringify(c.expected);
const sameOrch = (c) => {
  const o = replayOrch(c);
  return JSON.stringify(o.result) === JSON.stringify(c.expected)
    && JSON.stringify(o.trace.candidates.map(x => ({ memoryId: x.memoryId, seat: x.seat, decision: x.decision,
      cooldownFactor: x.cooldownFactor, reasons: x.reasons, finalScore: x.finalScore })))
      === JSON.stringify(c.expectedTrace.candidates)
    && o.meta.activationPolicy === c.expectedMeta.activationPolicy;
};

const matched = [], undeclared = [], declaredButSame = [];
for (const c of CASES) {
  let same = false;
  try {
    if (c.kind === 'core') same = sameCore(c);
    else if (c.kind === 'sequence-core') same = JSON.stringify(replayCore(c)) === JSON.stringify(c.steps[0].expected);
    else same = sameOrch(c);
  } catch (e) { same = false; }
  const isDeclared = Object.prototype.hasOwnProperty.call(DECLARED, c.id);
  if (same) { matched.push(c.id); if (isDeclared) declaredButSame.push(c.id); }
  else if (!isDeclared) undeclared.push(c.id);
}
console.log('    matched=' + matched.length + '  declared-changed=' + Object.keys(DECLARED).length
  + '  undeclared-drift=' + undeclared.length);
check('B12.noUndeclaredDrift', undeclared.length === 0, JSON.stringify(undeclared));
check('B13.declaredChangesActuallyChanged', declaredButSame.length === 0, JSON.stringify(declaredButSame));

console.log('\n' + '='.repeat(64));
console.log('frozen pre-F1b baseline: sourceHead=' + MANIFEST.sourceHead
  + ' coreSha=' + MANIFEST.coreSha256.slice(0, 16) + '… cases=' + CASES.length);
if (failures) { console.error('MEMORY RECALL R2F COOLDOWN BASELINE FAILED · ' + failures + ' assertion(s), ' + passed + ' passed'); process.exitCode = 1; }
else console.log('MEMORY RECALL R2F COOLDOWN BASELINE PASSED · ' + passed + ' assertions green');
