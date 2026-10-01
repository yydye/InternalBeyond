'use strict';
/* Internal Beyond · P21-R2-F1a · pre-F Frozen Behaviour Baseline（Node，零依赖）
   运行：node tests/test_memory_recall_r2f_baseline.js

   本文件的**唯一职责**：证明 frozen pre-F 基线**是真实的静态数据**，并且当前 core
   与它的差异**没有一处是未申报的**。

   ⚠ 本文件**绝不**生成 / 更新 / 接受 snapshot。
      fixture 是静态 JSON；重新生成必须用显式的独立命令（Closure 阶段禁止运行）。
      §4：禁止 updateSnapshot 式自动接受 —— 因此这里连写入 API 都不出现，
      并有静态断言防止后人加上。

   新旧行为对比的**权威矩阵**在 tests/test_memory_recall_r2f_delta.js，
   它同样以本目录的静态 fixture 作为 old side。
   ══════════════════════════════════════════════════════════════════════════ */

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert');
const ROOT = path.resolve(__dirname, '..');
const DIR = path.join(ROOT, 'tests/fixtures/memory-recall-r2f-baseline');
const CORE = require(path.join(ROOT, 'assets/js/memory-retrieval-core.js'));

let failures = 0, passed = 0;
const check = (n, c, d) => { if (c) { passed++; console.log('  PASS  ' + n); } else { failures++; console.error('  FAIL  ' + n + (d !== undefined ? '  -> ' + d : '')); } };
const section = t => console.log('\n── ' + t + ' ──');

const MANIFEST = JSON.parse(fs.readFileSync(path.join(DIR, 'manifest.json'), 'utf8'));
const CASE_FILES = fs.readdirSync(path.join(DIR, 'cases')).filter(f => f.endsWith('.json')).sort();
const CASES = CASE_FILES.map(f => JSON.parse(fs.readFileSync(path.join(DIR, 'cases', f), 'utf8')));

/* §4 · 禁止自动 regenerate：本测试源码里不得出现任何写入 / 快照接受 API。 */
section('§4 · 非再生保证');
const SELF = fs.readFileSync(__filename, 'utf8')
  /* 去掉注释后再扫描：判据约束的是**可执行代码**，而不是文档里能不能提到这个词。 */
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
/* 词表在运行时拼出：完整字面量不出现在源码里，否则该断言会命中自己（自指）。 */
const PARTS = [['write', 'FileSync'], ['append', 'FileSync'], ['mkdir', 'Sync'],
  ['rm', 'Sync'], ['unlink', 'Sync'], ['update', 'Snapshot'], ['accept', 'Snapshot'],
  ['regen', 'erate'], ['toMatch', 'Snapshot']];
const WRITE_API = PARTS.map(p => p.join(''));
const found = WRITE_API.filter(w => SELF.indexOf(w) >= 0);
check('B0.noWriteApiInBaselineTest', found.length === 0,
  'the baseline test must never write or accept snapshots: ' + JSON.stringify(found));
check('B0.generatorIsSeparateExplicitCommand', (() => {
  /* 生成器**不在** tests/ 下 ⇒ 测试运行器不可能顺带执行它；
     且 fixture 目录里只有 manifest.json + cases/ ⇒ 没有夹带可执行脚本。 */
  const stray = fs.readdirSync(DIR).filter(n => n !== 'manifest.json' && n !== 'cases');
  const scripts = fs.readdirSync(path.join(ROOT, 'tests'))
    .filter(n => /r2f_baseline.*(gen|regen|update)/i.test(n));
  return stray.length === 0 && scripts.length === 0;
})(), 'no generator/snapshot-updater may live under tests/');

/* §2/§4 · manifest 完整性 */
section('§2 · manifest 完整性');
check('B1.schemaVersion', MANIFEST.schemaVersion === 1, JSON.stringify(MANIFEST.schemaVersion));
check('B2.sourceHeadRecorded', /^[0-9a-f]{7,40}$/.test(String(MANIFEST.sourceHead)), MANIFEST.sourceHead);
check('B3.coreSha256Recorded', /^[0-9A-F]{64}$/.test(String(MANIFEST.coreSha256)), MANIFEST.coreSha256);
check('B3.coreShaMatchesFrozenConstant',
  MANIFEST.coreSha256 === 'CC578F2640C68CEA4992389AAC1C2A7D7B8AD9BFAC4311AFB51FB6AA0DCE5B72',
  'the frozen baseline must name the pre-R2-F core it was captured from');
check('B4.caseCountMatchesFiles', MANIFEST.caseCount === CASE_FILES.length,
  MANIFEST.caseCount + ' vs ' + CASE_FILES.length);
check('B5.manifestCaseListMatchesFiles',
  JSON.stringify(MANIFEST.cases.slice().sort()) === JSON.stringify(CASE_FILES.map(f => f.replace(/\.json$/, '')).sort()));
check('B6.caseIdsUnique', new Set(CASES.map(c => c.id)).size === CASES.length);
check('B6.caseIdMatchesFilename',
  CASES.every(c => fs.existsSync(path.join(DIR, 'cases', c.id + '.json'))));

/* §3 · 覆盖度：§3 要求的四组必须都在 */
section('§3 · 覆盖度');
const groups = {};
CASES.forEach(c => { groups[c.group] = (groups[c.group] || 0) + 1; });
check('B7.groupCoverage', groups.exploration >= 6 && groups.budget >= 8
  && groups.channel >= 4 && groups.shape >= 4, JSON.stringify(groups));
check('B7.explorationRandomsFrozen', (() => {
  const r = CASES.filter(c => c.group === 'exploration').map(c => c.random);
  return r.indexOf(0) >= 0 && r.indexOf(0.5) >= 0 && r.indexOf(0.999) >= 0;
})(), 'random 0 / 0.5 / 0.999 must all be frozen');
check('B7.headerBoundariesFrozen', (() => {
  const mc = CASES.filter(c => c.id.indexOf('header') > 0).map(c => c.options.maxChars);
  return [44, 88, 112].every(x => mc.indexOf(x) >= 0);
})());
check('B7.remainingExceedsWindow', (() => {
  const c = CASES.filter(x => x.id === 'f04_exploration_many_remaining')[0];
  return !!c && c.records.length >= 20;
})(), 'a case with >10 remaining candidates must exist (D-3 evidence)');

/* §2 · 每条 fixture 的形状与自洽性（对 frozen data 的静态验证） */
section('§2 · frozen data 自洽性');
const RESULT_KEYS = ['text', 'selected', 'count', 'chars', 'reason'];
let shapeBad = [], inconsistent = [], headerOverflow = [];
for (const c of CASES) {
  const e = c.expected;
  if (JSON.stringify(Object.keys(e).sort()) !== JSON.stringify(RESULT_KEYS.slice().sort())) shapeBad.push(c.id);
  if (e.count !== e.selected.length) inconsistent.push(c.id + ':count');
  if (!e.selected.every(s => s && typeof s.id === 'string' && typeof s.line === 'string' && typeof s.score === 'number')) {
    inconsistent.push(c.id + ':selected-shape');
  }
  if (typeof c.random !== 'number' || !(c.random >= 0 && c.random < 1)) inconsistent.push(c.id + ':random');
  const headerLen = c.options.includeHeader === false ? 0 : '【记忆（系统参考，勿提及此段）】\n'.length;
  const sum = e.selected.reduce((a, s) => a + s.line.length, 0);
  if (e.chars !== sum + headerLen) inconsistent.push(c.id + ':chars=' + e.chars + ' expected ' + (sum + headerLen));
  if (e.text !== (headerLen ? '【记忆（系统参考，勿提及此段）】\n' : '') + e.selected.map(s => s.line).join('')) {
    inconsistent.push(c.id + ':text');
  }
  if (e.chars > c.options.maxChars) headerOverflow.push(c.id + '(' + e.chars + '>' + c.options.maxChars + ')');
}
check('B8.resultShapeFrozen', shapeBad.length === 0, JSON.stringify(shapeBad));
check('B9.frozenDataSelfConsistent', inconsistent.length === 0, JSON.stringify(inconsistent));
/* pre-F 基线必须**如实记录**当时的预算越界。两类来源不同，因此按 id 精确断言，
   而不是只数个数 —— 数量变了（新增 zero-budget case）不该掩盖来源是否仍正确。 */
const OVERFLOW_EXPECTED = ['f10_header_44', 'f11_header_88', 'f25_zero_budget'];
check('B10.preFBudgetOverflowIsRecorded', (() => {
  const ids = headerOverflow.map(x => String(x).split('(')[0]).sort();
  return JSON.stringify(ids) === JSON.stringify(OVERFLOW_EXPECTED.slice().sort());
})(), 'the frozen baseline must RECORD the pre-F budget violations exactly: '
  + JSON.stringify({ expected: OVERFLOW_EXPECTED, got: headerOverflow }));
check('B10.overflowCategoriesAreDistinct', (() => {
  /* header 溢出（44/88）与 zero-budget（0）是两类不同的历史缺陷。 */
  const hasHeader = headerOverflow.some(x => String(x).indexOf('f10_') === 0)
    && headerOverflow.some(x => String(x).indexOf('f11_') === 0);
  const hasZero = headerOverflow.some(x => String(x).indexOf('f25_') === 0);
  return hasHeader && hasZero;
})(), 'header overflow and zero-budget overflow must both be recorded as first-class cases');

/* §2 · replay：唯一允许的差异必须已在 manifest 中**显式申报** */
section('§2 · replay（未申报差异 = 失败）');
const DECLARED_ALL = MANIFEST.changedByR2F1a || {};
/* `note` 是注释层，不是一条变化声明。 */
const DECLARED = {};
Object.keys(DECLARED_ALL).forEach(k => { if (k !== 'note') DECLARED[k] = DECLARED_ALL[k]; });
const replay = c => CORE.buildMemoryContext(c.records,
  Object.assign({}, c.options, { random: () => c.random }));

const matched = [], undeclared = [], declaredButSame = [];
for (const c of CASES) {
  let same = false;
  try { same = JSON.stringify(replay(c)) === JSON.stringify(c.expected); } catch (err) { same = false; }
  const isDeclared = Object.prototype.hasOwnProperty.call(DECLARED, c.id);
  if (same) { matched.push(c.id); if (isDeclared) declaredButSame.push(c.id); }
  else if (!isDeclared) undeclared.push(c.id);
}
console.log('    matched=' + matched.length + '  declared-changed=' + Object.keys(DECLARED).length
  + '  undeclared-drift=' + undeclared.length);
check('B11.noUndeclaredDrift', undeclared.length === 0,
  'these frozen cases changed without being declared in manifest.changedByR2F1a: '
  + JSON.stringify(undeclared));
check('B12.declaredChangesActuallyChanged', declaredButSame.length === 0,
  'declared as changed but actually identical (stale declaration): ' + JSON.stringify(declaredButSame));
check('B13.baselineIsNonEmpty', CASES.length === 25, String(CASES.length));
check('B13.generationProvenanceRecorded', MANIFEST.generationPasses === 3
  && MANIFEST.extendedAfterFreeze && MANIFEST.extendedAfterFreeze.preFCoreSha256 === MANIFEST.coreSha256,
  'pass-2 cases must record that their expected came from the PRE-F core, not the modified one');

console.log('\n' + '='.repeat(64));
console.log('frozen baseline: sourceHead=' + MANIFEST.sourceHead + ' coreSha=' + MANIFEST.coreSha256.slice(0, 16) + '…'
  + ' cases=' + CASES.length);
if (failures) { console.error('MEMORY RECALL R2F BASELINE FAILED · ' + failures + ' assertion(s), ' + passed + ' passed'); process.exitCode = 1; }
else console.log('MEMORY RECALL R2F BASELINE PASSED · ' + passed + ' assertions green');
