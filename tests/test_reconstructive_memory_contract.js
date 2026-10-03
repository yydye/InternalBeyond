'use strict';
/* ══════════════════════════════════════════════════════════════════════════
   Internal Beyond · P21-R4-A.1 · Reconstructive Memory Contract Guard
   （Node，零依赖，零浏览器，零网络，不开 Home Node）

   运行：node tests/test_reconstructive_memory_contract.js

   本文件证明的是**契约边界被写下来**且**生产面没有被偷偷接线**，
   **不是**"predictive runtime 已实现"。断言分三类：

     [CONTRACT]    contract 文本必须冻结的边界（R4-A + R4-A.1）
     [PRESERVE]    R4-A 已冻结的边界**不得**因加入 prediction 而被改写
     [CURRENT]     生产代码事实：新层必须仍然是 0 引用、schema 必须未变

   为什么不做纯文案测试：文案断言只证明"这句话被写下来了"。
   §37 要求的真正约束是 **layer boundary** + **forbidden production wiring**
   + **schema unchanged**，因此下面把重点放在 [CURRENT] 上；
   [CONTRACT] 只钉那些**一旦丢失就会导致边界失效**的最小措辞。
   ══════════════════════════════════════════════════════════════════════════ */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const CONTRACT = 'docs/contracts/memory/RECONSTRUCTIVE_MEMORY_CONTRACT.md';
const ARCHITECTURE = 'docs/architecture/MEMORY.md';
const DB_SCHEMA = 'assets/js/webcore-db-schema.js';
const MEMORY_STORE = 'services/home-node/memory-store.js';

/* 新层的**实现标识符**。它们目前必须只在 contract / tests 里出现。
   选这些词是因为它们不可能出现在既有 memory 代码里（见 R4-A audit）。 */
const FORBIDDEN_WIRING = ['expectation', 'metamemory', 'counterfactual', 'predictionError', 'prediction_error'];
const FORBIDDEN_STORES = ['expectation', 'expectations', 'counterfactual', 'counterfactuals', 'metamemory'];

let failures = 0;
let passed = 0;
const check = (name, cond, detail) => {
  if (cond) { passed++; console.log('  PASS  ' + name); return true; }
  failures++;
  console.error('  FAIL  ' + name + (detail ? '  -> ' + detail : ''));
  return false;
};
const section = t => console.log('\n── ' + t + ' ──');

const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
const declares = (hay, needle) => hay.toLowerCase().indexOf(String(needle).toLowerCase()) >= 0;
/* 契约文本里的 `**强调**` 与 `` `代码` `` 会让字面量匹配变得脆弱。
   这里把两侧都规范化（去强调符、折叠空白）后再比对 ——
   断言仍然要求"这句话被写下来"，只是不再要求排版逐字一致。 */
const plain = text => String(text).replace(/\*\*/g, '').replace(/`/g, '').replace(/\s+/g, ' ').trim();
const declaresPlain = (hay, needle) => plain(hay).toLowerCase().indexOf(plain(needle).toLowerCase()) >= 0;

/* 递归收集文件；显式跳过 target / node_modules（src-tauri/target 有 2 万+ 文件）。 */
function collect(dir, extensions, out) {
  const acc = out || [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'target' || entry.name === 'node_modules' || entry.name === '.git') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { collect(full, extensions, acc); continue; }
    if (extensions.some(ext => entry.name.endsWith(ext))) acc.push(full);
  }
  return acc;
}

const CONTRACT_TEXT = read(CONTRACT);
const ARCH_TEXT = read(ARCHITECTURE);

/* ══════════════════════════════════════════════════════════════════════
   §1 · Contract 存在并带有两代 phase 标记
   ══════════════════════════════════════════════════════════════════════ */
section('§1 · contract 存在与 phase 标记');

check('C1.contractExists', fs.existsSync(path.join(ROOT, CONTRACT)), CONTRACT + ' must exist');
check('C2.headerFreezesBothPhases',
  declares(CONTRACT_TEXT, 'P21-R4-A') && declares(CONTRACT_TEXT, 'R4-A.1'),
  'contract header must freeze both R4-A and R4-A.1');
check('C3.statusIsContractFreezeNotImplementation',
  declares(CONTRACT_TEXT, 'Implementation: NONE') || declares(CONTRACT_TEXT, 'production files changed = 0'),
  'contract must state that it freezes semantics without implementing them');

/* ══════════════════════════════════════════════════════════════════════
   §2 · [PRESERVE] R4-A 已冻结的边界不得被预测部分改写
   ══════════════════════════════════════════════════════════════════════ */
section('§2 · R4-A 边界保留（PRESERVE）');

check('P1.productPrincipleOneIntact',
  declares(CONTRACT_TEXT, 'FACTS MAY REMAIN STABLE') && declares(CONTRACT_TEXT, 'MEANING MAY CHANGE'),
  'principle one must survive the predictive reconciliation');
check('P2.interpretationDoesNotOverrideCanonical',
  declaresPlain(CONTRACT_TEXT, 'Interpretation MUST NOT 覆盖 Canonical Memory'),
  'Interpretation MUST NOT override canonical evidence must stay verbatim');
check('P3.unreliableRecollectionDoesNotOverrideCanonical',
  declaresPlain(CONTRACT_TEXT, 'UNRELIABLE RECOLLECTION MUST NOT 覆盖 CANONICAL EVIDENCE'),
  'unreliable recollection must never overwrite canonical evidence');
check('P4.fourOriginalLayersStillNamed',
  ['Canonical Memory', 'MemoryInterpretation', 'MetaMemory', 'MemoryBehaviorEffect']
    .every(name => declares(CONTRACT_TEXT, name)),
  'the four original boundary layers must still be named in the truth-boundary table');

/* ══════════════════════════════════════════════════════════════════════
   §3 · [CONTRACT] Predictive 边界
   ══════════════════════════════════════════════════════════════════════ */
section('§3 · predictive 边界（CONTRACT）');

check('C4.predictivePrinciplePresent',
  declares(CONTRACT_TEXT, 'PAST EXPERIENCE MAY SHAPE EXPECTATION')
  && declares(CONTRACT_TEXT, 'EXPECTATION MUST REMAIN A HYPOTHESIS'),
  'the second product principle must be frozen verbatim');
check('C5.expectationIsNeverCanonicalEvidence',
  declaresPlain(CONTRACT_TEXT, '把 Expectation 写成 fact')
  && declaresPlain(CONTRACT_TEXT, '产生或改写任何 L0 record'),
  'expectation must be declared a hypothesis that cannot create or rewrite L0');
check('C6.counterfactualCarriesHypotheticalMarker',
  declares(CONTRACT_TEXT, 'HYPOTHETICAL')
  && declares(CONTRACT_TEXT, 'NOT OBSERVED')
  && declares(CONTRACT_TEXT, 'NOT CANONICAL EVIDENCE'),
  'counterfactual must always carry HYPOTHETICAL / NOT OBSERVED / NOT CANONICAL EVIDENCE');
check('C7.contaminationGuardEnumeratesEveryPath',
  ['consolidation', 'interpretation', 'narrative', 'shared memory', 'unreliable recollection']
    .every(p => declares(CONTRACT_TEXT, p)),
  'the counterfactual contamination guard must enumerate all five laundering paths');
check('C8.predictionErrorIsFeedbackNotMutation',
  declaresPlain(CONTRACT_TEXT, 'Prediction settlement MUST NOT 修改 canonical event')
  && declaresPlain(CONTRACT_TEXT, 'Prediction Error 是 expectation revision 的信号'),
  'prediction error must be a revision signal, never a canonical mutation');
check('C9.observationUncertaintyFailsClosed',
  declaresPlain(CONTRACT_TEXT, 'fail-closed 到 unknown')
  && declaresPlain(CONTRACT_TEXT, 'MUST NOT 猜 confirmed / contradicted'),
  'unknown observations must stay unknown instead of being guessed');
check('C10.selfFulfillingHazardIsRepresentable',
  declares(CONTRACT_TEXT, 'behaviorEffectsApplied')
  && declares(CONTRACT_TEXT, 'selfInfluencePossible')
  && declares(CONTRACT_TEXT, 'attributionConfidence')
  && declares(CONTRACT_TEXT, 'NO SELF-REINFORCING CONFIDENCE LOOP'),
  'the self-fulfilling hazard must require the three attribution fields and forbid a confidence runaway');
check('C11.predictionConfidenceIsNotOneBlob',
  declares(CONTRACT_TEXT, 'subjectiveConfidence')
  && declares(CONTRACT_TEXT, 'evidenceConfidence')
  && declares(CONTRACT_TEXT, 'calibrationEvidence'),
  'expectation confidence must stay split into three separate quantities');
check('C12.expectationHasEvidenceProvenance',
  declares(CONTRACT_TEXT, 'EXPECTATION MUST HAVE EVIDENCE PROVENANCE')
  && declares(CONTRACT_TEXT, 'attestDerivedArtifact'),
  'expectation must require canonical evidence provenance and reuse the attestation gate');
check('C13.generalizationLadderFrozen',
  declares(CONTRACT_TEXT, 'single episode → permanent generalized rule')
  && declares(CONTRACT_TEXT, 'Hypothesis')
  && declares(CONTRACT_TEXT, 'Repeated Observation')
  && declares(CONTRACT_TEXT, 'Generalized Expectation'),
  'the episode → hypothesis → generalized expectation ladder must be frozen');

/* ══════════════════════════════════════════════════════════════════════
   §4 · [CONTRACT] Layer model / loop / roadmap 已调和
   ══════════════════════════════════════════════════════════════════════ */
section('§4 · layer model / loop / roadmap（CONTRACT）');

check('C14.layerModelIsL0ToL9',
  Array.from({ length: 10 }, (_, i) => '**L' + i + '**').every(mark => declares(CONTRACT_TEXT, mark)),
  'the layer model must run from L0 to L9');
check('C15.predictionErrorIsExplicitlyNotALayer',
  declares(CONTRACT_TEXT, 'Prediction Error 不是一层')
  && declares(CONTRACT_TEXT, '≠  独立 layer'),
  'prediction error must be declared a feedback signal, not a layer');
check('C16.newLayersOccupyTheDeclaredSlots',
  declares(CONTRACT_TEXT, 'Expectation / Predictive Model')
  && declares(CONTRACT_TEXT, 'Counterfactual / Causal Hypothesis'),
  'L5 must be Expectation and L6 must be Counterfactual');
check('C17.cognitiveLoopFrozen',
  declares(CONTRACT_TEXT, 'Past Experience') && declares(CONTRACT_TEXT, 'Expectation Revision')
  && declares(CONTRACT_TEXT, 'Interpretation Revision'),
  'the cognitive loop must close over expectation/interpretation revision');
check('C18.newExperienceEntersL0Separately',
  declaresPlain(CONTRACT_TEXT, '作为独立事件进入 L0')
  && declaresPlain(CONTRACT_TEXT, '覆写产生该 expectation 的那条旧 L0'),
  'a new experience must be appended to L0, never overwrite the old L0');
check('C19.roadmapReordersBehaviorAfterPrediction',
  declares(CONTRACT_TEXT, 'Behavior 是否应早于 Prediction？—— 否')
  && declares(CONTRACT_TEXT, 'Prediction 是否必须晚于 Interpretation？—— 是'),
  'the roadmap must justify the reordering instead of adopting the proposed order mechanically');
check('C20.outOfScopeNamesBothNewRuntimes',
  declares(CONTRACT_TEXT, 'Expectation runtime')
  && declares(CONTRACT_TEXT, 'Counterfactual runtime')
  && declares(CONTRACT_TEXT, 'causal graph traversal'),
  'expectation / counterfactual runtimes and causal traversal must be out of scope');

/* ══════════════════════════════════════════════════════════════════════
   §5 · [CURRENT] 生产面必须仍然 0 引用
   ══════════════════════════════════════════════════════════════════════ */
section('§5 · 禁止接线（CURRENT）');

const PRODUCTION_ROOTS = ['assets', 'services', 'bridge', 'src-tauri']
  .map(dir => path.join(ROOT, dir))
  .filter(dir => fs.existsSync(dir));
const PRODUCTION_FILES = [];
PRODUCTION_ROOTS.forEach(dir => collect(dir, ['.js', '.rs', '.toml'], PRODUCTION_FILES));

const wiringHits = [];
PRODUCTION_FILES.forEach(file => {
  const rel = path.relative(ROOT, file).replace(/\\/g, '/');
  const text = fs.readFileSync(file, 'utf8');
  const lower = text.toLowerCase();
  FORBIDDEN_WIRING.forEach(token => {
    if (lower.indexOf(token.toLowerCase()) >= 0) wiringHits.push(rel + ' :: ' + token);
  });
});

check('N1.productionHasZeroPredictiveWiring',
  wiringHits.length === 0,
  'no production file may reference the new layers yet (found: ' + wiringHits.slice(0, 8).join(', ') + ')');
check('N2.productionScanIsNonTrivial',
  PRODUCTION_FILES.length > 200,
  'the production scan must actually cover the tree (scanned ' + PRODUCTION_FILES.length + ' files)');

const DB_SCHEMA_TEXT = read(DB_SCHEMA);
const STORE_NAMES_MATCH = /var\s+STORE_NAMES\s*=\s*\[([\s\S]*?)\]/.exec(DB_SCHEMA_TEXT);
const storeNames = STORE_NAMES_MATCH ? STORE_NAMES_MATCH[1] : '';
check('N3.noNewBrowserObjectStore',
  storeNames.length > 0 && !FORBIDDEN_STORES.some(name => declares(storeNames, "'" + name + "'")),
  'no expectation/counterfactual/metamemory object store may be added to InternalBeyondDB');
check('N4.browserDbVersionUnchanged',
  /var\s+DB_VERSION\s*=\s*24\s*;/.test(DB_SCHEMA_TEXT),
  'browser DB_VERSION must stay 24 (R4-A.1 forbids schema changes)');
check('N5.homeNodeMemorySchemaUnchanged',
  /const\s+MEMORY_SCHEMA_VERSION\s*=\s*1\s*;/.test(read(MEMORY_STORE)),
  'Home Node MEMORY_SCHEMA_VERSION must stay 1');

/* ══════════════════════════════════════════════════════════════════════
   §6 · [CURRENT] 索引与注册
   ══════════════════════════════════════════════════════════════════════ */
section('§6 · 索引与注册');

check('N6.architectureDocIndexesTheContract',
  declares(ARCH_TEXT, 'RECONSTRUCTIVE_MEMORY_CONTRACT.md'),
  'docs/architecture/MEMORY.md must carry a canonical index line for this contract');
check('N7.indexStatesNoRuntimeYet',
  declares(ARCH_TEXT, 'runtime 生产实现 = NONE'),
  'the index line must not let readers believe the layers are live');
check('N8.memoryAuthoritySemanticsUntouched',
  declares(ARCH_TEXT, 'Home Node = canonical') || declares(ARCH_TEXT, 'Home Node owns durable Memory state'),
  'the index addition must not rewrite the existing memory authority statements');

const TEST_ALL = read('tests/test-all.js');
check('N9.registeredInTestAll',
  TEST_ALL.indexOf("'test_reconstructive_memory_contract.js'") >= 0,
  'this guard must be registered in tests/test-all.js');
check('N10.registeredExactlyOnce',
  TEST_ALL.split("'test_reconstructive_memory_contract.js'").length - 1 === 1,
  'this guard must be registered exactly once');

/* ══════════════════════════════════════════════════════════════════════ */

console.log('\n' + '='.repeat(64));
if (failures) {
  console.error('RECONSTRUCTIVE MEMORY CONTRACT FAILED · ' + failures + ' assertion(s), ' + passed + ' passed');
  process.exit(1);
}
console.log('RECONSTRUCTIVE MEMORY CONTRACT PASSED · ' + passed + ' assertions green');
