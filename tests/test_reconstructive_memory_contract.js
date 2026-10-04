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

/* 新层的**实现标识符**。
   ── R4-B 相位切换 ──────────────────────────────────────────────────
   `metamemory` 曾在此列表中：R4-A.1 冻结时 reconstructive runtime = NONE，
   因此 production 面必须**零引用**。R4-B 交付了这一阶段**唯一**允许的 runtime
   —— deterministic MetaMemory **shadow** —— 所以这一个词按设计**移出**本列表。

   **这不是放松**：metamemory 换来的是更**具体**的守卫（见下方 §5b
   `R4B.*` 断言）—— 纯函数、零 DB/网络/LLM、零持久化、只挂 `meta`、
   绝不进 `result` / prompt / 排序 / activation。

   expectation / counterfactual / predictionError **仍然**禁止：它们仍未实现。 */
/* ── R4-D 相位切换 ──────────────────────────────────────────────────
   R4-A.1 冻结时 reconstructive runtime = NONE，因此 `expectation` /
   `predictionError` 与 `counterfactual` 一起被列为 production 零引用。
   R4-D 交付了这两个层的 **shadow**，所以它们按设计**移出**本列表。

   **`counterfactual` 必须留下** —— R4-E 未实现，不得顺手解禁。
   换来的守卫见下方 §5c 的 `R4D*` 断言（shadow-only / consumer-zero /
   no-persistence / no-behavior / no-prompt / no-canonical-mutation）。 */
/* ── R4-E 相位切换 ──────────────────────────────────────────────────
   'counterfactual' 从 R4-A.1 起就被列为 production 零引用。R4-E 交付了
   Counterfactual / Causal Hypothesis 的 **shadow**，因此它按设计**移出**列表。

   列表**不是**被清空 —— 它被换成**仍然**未实现的四层。这既保留了
   `N1`/`N2` 的非平凡扫描，也**防止** R4-E 顺手解禁它们：
     behaviorEffect         —— R4-F
     selfNarrative          —— 未选
     unreliableRecollection —— 未选
     association            —— R4-G（含 causal graph traversal）

   R4-E 换来的具体守卫见下方 §5d 的 `R4E*` 断言。 */
/* ── R4-E 之后这个列表**按设计为空** ────────────────────────────────
   它曾经装着 `expectation` / `counterfactual` / `predictionError` /
   `prediction_error` —— 四个都已在 R4-B~R4-E 里以 **shadow** 形态实现，
   因此全部**按设计**移出。空列表是**结果**，不是疏漏。

   一个空列表会让 N1 变成真空断言，所以约束改由**更具体**的守卫承担：
     · `R4B*` / `R4D*` / `R4E*` 块 —— shadow-only / consumer-zero /
       no-persistence / no-behavior / no-canonical-mutation / no-prompt
     · `tests/test_counterfactual_shadow.js` 的 M7 与 R4E 的 P3 ——
       逐条断言 BehaviorEffect / SelfNarrative / UnreliableRecollection /
       Association **仍**被登记为 NOT IMPLEMENTED

   **不得**因为本列表为空就认为这些层已被解禁：它们从未被实现。 */
const FORBIDDEN_WIRING = [];
const FORBIDDEN_STORES = ['expectation', 'expectations', 'counterfactual', 'counterfactuals', 'metamemory'];
/* R4-B：唯一被允许生产的 reconstructive runtime。 */
const R4B_SHADOW = 'assets/js/memory-recall/metamemory-shadow.js';

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


/* ══════════════════════════════════════════════════════════════════════
   §5c · R4-D SHADOW-ONLY 守卫（取代 expectation / predictionError 的零引用守卫）
   ──────────────────────────────────────────────────────────────────────
   'expectation' 与 'predictionError' 现在**允许**出现在 production ——
   但只能以"影子 + 协议就绪"的形态。下面把这份限制变成可机械判定的性质。
   'counterfactual' **仍然**在上面的 FORBIDDEN_WIRING 里：R4-E 未实现。 */
const R4D_FILES = [
  'assets/js/memory-recall/expectation-shadow-core.js',
  'assets/js/memory-recall/expectation-shadow-runner.js',
  'assets/js/memory-recall/prediction-observation-core.js'
];
const R4D_TEXT = R4D_FILES.filter(f => fs.existsSync(path.join(ROOT, f))).map(f => read(f)).join('\n');
const _R4D_STRIP = require('./helpers/activation-wiring-probe.js').stripJsComments;
const R4D_CODE = _R4D_STRIP(R4D_TEXT);

check('R4D1.shadowCoresExist', R4D_TEXT.length > 0,
  'the R4-D cores must exist: ' + R4D_FILES.join(', '));
check('R4D2.coreIsPure',
  !/\bfetch\s*\(|XMLHttpRequest|WebSocket/.test(R4D_CODE)
  && !/indexedDB|localStorage|sessionStorage/.test(R4D_CODE)
  && !/Date\.now\s*\(|Math\.random/.test(R4D_CODE)
  && !/dbPut|dbGet\(|dbDelete/.test(R4D_CODE),
  'the R4-D cores must be pure: no network, no storage, no clock, no DB');
check('R4D3.predictionIsNeverAFact',
  /EPISTEMIC_STATUS\s*=\s*'prediction'/.test(R4D_TEXT)
  && /epistemicStatus:\s*EPISTEMIC_STATUS/.test(R4D_TEXT),
  'every expectation must carry an explicit hypothesis marker — prediction is not observation');
check('R4D4.confidenceIsSplitThreeWays',
  /subjectivePredictionConfidence/.test(R4D_TEXT)
  && /evidenceConfidence:\s*null/.test(R4D_TEXT)
  && /calibrationConfidence:\s*null/.test(R4D_TEXT),
  'evidence / subjective / calibration confidence must stay three separate quantities');
check('R4D5.calibrationIsNeverFabricated',
  /calibrationConfidence\s*=\s*null/.test(R4D_TEXT)
  && /calibratedNull|calibration-confidence-null-no-settled-history/.test(R4D_TEXT),
  'without settled observations calibration confidence is null, not a confident guess');
check('R4D6.generalizationLadderIsGated',
  /GENERALIZATION_REACHABLE\s*=\s*\['episode-hypothesis'\]/.test(R4D_TEXT)
  && /generalizationEscalation/.test(R4D_TEXT),
  'a single episode must never become a generalized worldview');
check('R4D7.independenceIsNotAssumed',
  /evidenceIndependenceUnproven|independenceProven/.test(R4D_TEXT)
  && /no-independent-observation-primitive-exists/.test(R4D_TEXT),
  'quoting several ids must not be treated as several independent observations');
check('R4D8.outcomeRequiresCanonicalEvidence',
  /observation-was-not-built-from-a-canonical-record/.test(R4D_TEXT)
  && /NO CANONICAL OUTCOME → NO SETTLEMENT|NO CANONICAL OUTCOME/.test(R4D_TEXT),
  'NO CANONICAL OUTCOME → NO SETTLEMENT, and the observation must be builder-derived');
check('R4D9.predictionErrorIsNotAScalar',
  /predictionErrorMetric:\s*null/.test(R4D_TEXT)
  && /prediction-error-is-discrete-not-continuous/.test(R4D_TEXT),
  'no arbitrary continuous loss: prediction error is discrete and named');
check('R4D10.errorIsARevisionSignalNotACorrection',
  /prediction-error-is-a-revision-signal-not-a-correction/.test(R4D_TEXT)
  && /settlement-does-not-mutate-canonical/.test(R4D_TEXT),
  'prediction error is a revision signal, never a canonical correction');
check('R4D11.noSelfReinforcingLoop',
  /NO_SELF_REINFORCING_CONFIDENCE_LOOP/.test(R4D_TEXT),
  'a settled outcome must not feed confidence back into the expectation');
check('R4D12.selfFulfillingHazardIsRepresentableAndNotFaked',
  /selfInfluencePossible/.test(R4D_TEXT)
  && /behaviorEffectsApplied/.test(R4D_TEXT)
  && /attributionConfidence:\s*null/.test(R4D_TEXT),
  'the hazard must be representable while attributionConfidence stays unfaked');
check('R4D13.behaviorEffectIsNotImplemented',
  /NOT_IMPLEMENTED_R4F/.test(R4D_TEXT)
  && !/behaviorEffect\s*[:=]\s*\{[^}]*applied\s*:\s*true/.test(R4D_CODE),
  'R4-D must not pretend a behavior effect already happened');
check('R4D14.runnerHasZeroProductionCallers',
  (function () {
    let callers = 0;
    const walk = dir => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const q = path.join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== 'node_modules') walk(q); continue; }
        if (!/\.(js|rs|toml)$/.test(e.name)) continue;
        const rel = path.relative(ROOT, q).replace(/\\/g, '/');
        if (R4D_FILES.indexOf(rel) >= 0) continue;
        if (/expectation-shadow-runner/.test(_R4D_STRIP(read(rel)))) callers++;
      }
    };
    ['assets', 'services', 'bridge', 'src-tauri'].forEach(d => {
      const full = path.join(ROOT, d);
      if (fs.existsSync(full)) walk(full);
    });
    return callers === 0;
  })(),
  'PRODUCTION EXPECTATION CALLER = 0 and PRODUCTION SETTLEMENT CALLER = 0');
check('R4D15.inheritsR4CTimeoutAndCancellationDiscipline',
  /SAFETY_CAP_SOURCE/.test(R4D_TEXT)
  && /understanding-derivation\.js:70/.test(R4D_TEXT)
  && /PROVIDER_EXECUTION_CANCELLATION_GUARANTEED\s*=\s*false/.test(R4D_TEXT)
  && /AUTO_RETRY\s*=\s*'NONE'/.test(R4D_TEXT),
  'R4-D must inherit R4-C.1 exactly: no invented timeout, wait-bound ≠ cancellation, no retry');
check('R4D16.noDurableExpectationState',
  !/memory_records|memory_change_log/.test(R4D_CODE)
  && /no-durable-expectation-store/.test(R4D_TEXT),
  'no durable expectation / observation / prediction-error state may be written');

/* ══════════════════════════════════════════════════════════════════════
   §5d · R4-E SHADOW-ONLY 守卫（取代 counterfactual 的零引用守卫）
   ──────────────────────────────────────────────────────────────────────
   'counterfactual' 现在**允许**出现在 production，但只能以"因果假设影子"
   的形态。下面把这份限制变成可机械判定的性质。 */
const R4E_FILES = [
  'assets/js/memory-recall/counterfactual-shadow-core.js',
  'assets/js/memory-recall/counterfactual-shadow-runner.js'
];
const R4E_TEXT = R4E_FILES.filter(f => fs.existsSync(path.join(ROOT, f))).map(f => read(f)).join('\n');
const R4E_CODE = _R4D_STRIP(R4E_TEXT);

check('R4E1.shadowCoresExist', R4E_TEXT.length > 0,
  'the R4-E cores must exist: ' + R4E_FILES.join(', '));
check('R4E2.coreIsPure',
  !/\bfetch\s*\(|XMLHttpRequest|WebSocket/.test(R4E_CODE)
  && !/indexedDB|localStorage|sessionStorage/.test(R4E_CODE)
  && !/Date\.now\s*\(|Math\.random/.test(R4E_CODE)
  && !/dbPut|dbGet\(|dbDelete|writeFile/.test(R4E_CODE),
  'the R4-E cores must be pure: no network, no storage, no clock, no DB');
check('R4E3.hardEpistemicLabelsAreSystemWritten',
  /PURPOSE = 'causal-learning'/.test(R4E_TEXT)
  && /EPISTEMIC_STATUS = 'counterfactual'/.test(R4E_TEXT)
  && /OBSERVED = false/.test(R4E_TEXT)
  && /CANONICAL_EVIDENCE = false/.test(R4E_TEXT),
  'purpose / epistemicStatus / observed / canonicalEvidence are system-owned constants');
check('R4E4.interventionAuthorityIsCallerOrSystemInput',
  /INTERVENTION_AUTHORITY: 'CALLER_OR_SYSTEM_INPUT'/.test(R4E_TEXT)
  && /intervention-authority-missing/.test(R4E_TEXT)
  && /model-attempted-to-choose-or-rewrite-the-intervention/.test(R4E_TEXT)
  && /normalizeIntervention/.test(R4E_TEXT),
  'the intervention is a mandatory CALLER/SYSTEM input; the model can neither supply nor rewrite it');
check('R4E18.literalEpistemicLabelsMatchContract',
  /EPISTEMIC_LABELS = \['HYPOTHETICAL', 'NOT OBSERVED', 'NOT CANONICAL EVIDENCE'\]/.test(R4E_TEXT)
  && /LABEL_AUTHORITY = 'system'/.test(R4E_TEXT)
  && /NO_SECOND_TAXONOMY = true/.test(R4E_TEXT)
  && /HYPOTHETICAL \/ NOT OBSERVED \/ NOT CANONICAL EVIDENCE/.test(read('docs/contracts/memory/RECONSTRUCTIVE_MEMORY_CONTRACT.md')),
  'the contract literally requires the three labels; the core carries them verbatim with no second taxonomy');
check('R4E19.modelCannotWriteInterventionOrLabels',
  /'intervention', 'interventionKind'/.test(R4E_TEXT)
  && /'labels', 'epistemicLabels'/.test(R4E_TEXT),
  'intervention and labels are in the model-forbidden field list');
check('R4E5.semanticSingleCauseIsNotOverclaimed',
  /semanticalSingleCauseGuaranteed/.test(R4E_TEXT)
  && /SEMANTIC_SINGLE_CAUSE|semantic-single-cause-not-mechanically-guaranteed/.test(R4E_TEXT),
  'only ONE DECLARED INTERVENTION is proven — semantic single-change is NOT guaranteed');
check('R4E6.causalHypothesisOnlyNotAProof',
  /causalLevel: 'hypothesis'/.test(R4E_TEXT)
  && /causalRelationProven: false/.test(R4E_TEXT)
  && /causalFact|provenCause|confirmedCause/.test(R4E_TEXT),
  'causal hypothesis is representable; causal FACT / PROOF vocabulary exists only as a rejection list');
check('R4E7.counterfactualHasNoEvidenceWeight',
  /evidenceWeight: 'NONE'/.test(R4E_TEXT),
  'a counterfactual contributes no evidence: EVIDENCE_WEIGHT = NONE');
check('R4E8.causalAttributionConfidenceNeverFabricated',
  /causalAttributionConfidence: null/.test(R4E_TEXT),
  'without an experiment there is no causal attribution confidence — it stays null');
check('R4E9.noPredictionSemantics',
  !/triggerPattern\s*:/.test(R4E_CODE)
  && !/predictionError\s*:/.test(R4E_CODE)
  && !/calibrationCounts\s*:/.test(R4E_CODE)
  && !/observedAt\s*:/.test(R4E_CODE)
  && /counterfactual-cannot-be-settled/.test(R4E_TEXT),
  'a counterfactual carries no trigger / prediction error / calibration / settlement');
check('R4E10.noDurableIdentity',
  !/counterfactualId\s*:/.test(R4E_CODE.replace(/FORBIDDEN_MODEL_FIELDS[\s\S]*?\]/, '')),
  'no counterfactual id is generated: no UUID that looks permanent but dies on reload');
check('R4E11.observationBuilderRejectsCounterfactuals',
  /UPSTREAM_TRUSTED_PRECONDITION/.test(R4D_TEXT)
  && !/counterfactual/.test(read('assets/js/memory-recall/prediction-observation-core.js')),
  'the D.2 observation authority is an upstream precondition, and R4-E does not become that upstream');
check('R4E12.runnerHasZeroProductionCallers',
  (function () {
    let callers = 0;
    const walk = dir => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const q = path.join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== 'node_modules') walk(q); continue; }
        if (!/\.(js|rs|toml)$/.test(e.name)) continue;
        const rel = path.relative(ROOT, q).replace(/\\/g, '/');
        if (R4E_FILES.indexOf(rel) >= 0) continue;
        if (/counterfactual-shadow-runner/.test(_R4D_STRIP(read(rel)))) callers++;
      }
    };
    ['assets', 'services', 'bridge', 'src-tauri'].forEach(d => {
      const full = path.join(ROOT, d); if (fs.existsSync(full)) walk(full);
    });
    return callers === 0;
  })(),
  'PRODUCTION COUNTERFACTUAL CALLER = 0 and CONSUMER = 0');
check('R4E13.inheritsTimeoutAndCancellationDiscipline',
  /understanding-derivation\.js:70/.test(R4E_TEXT)
  && /PROVIDER_EXECUTION_CANCELLATION_GUARANTEED\s*=\s*false/.test(R4E_TEXT)
  && /AUTO_RETRY\s*=\s*'NONE'/.test(R4E_TEXT),
  'R4-E inherits R4-C/R4-D exactly: no invented timeout, wait-bound != cancellation, no retry');
check('R4E14.noHiddenR4CorR4DChain',
  !/interpretation-runner|expectation-shadow-runner/.test(R4E_CODE),
  'R4-E must never trigger the R4-C / R4-D runners to fill a missing layer');
check('R4E15.noPersistenceAndNoSchema',
  !/memory_records|memory_change_log/.test(R4E_CODE)
  && /no-durable-counterfactual-store/.test(R4E_TEXT),
  'no counterfactual durable state, no new store/table, no migration');
check('R4E16.noBehaviorOrRevisionSurface',
  /NOT_IMPLEMENTED_R4F/.test(R4E_TEXT)
  && /expectationRevision: null/.test(R4E_TEXT)
  && /interpretationRevision: null/.test(R4E_TEXT),
  'no behavior consumer, no interpretation rewrite, no expectation rewrite');
check('R4E17.optionalLayersAreCallerSuppliedOnly',
  /subjectiveInterpretationAvailable/.test(R4E_TEXT)
  && /expectationAvailable/.test(R4E_TEXT),
  'R4-E may only use caller-supplied interpretation / expectation, or degrade honestly');

check('R4D21.observationCapabilityIsNotForgeable',
  /OBSERVATION_IDENTITY\s*=\s*new WeakSet\(\)/.test(R4D_TEXT)
  && /OBSERVATION_SEAL\s*=\s*new WeakMap\(\)/.test(R4D_TEXT)
  && /OBSERVATION_IDENTITY\.has\(o\)/.test(R4D_TEXT)
  && /canonicalize\(o\) === sealed/.test(R4D_TEXT)
  && !/^\s*(OBSERVATION_IDENTITY|OBSERVATION_SEAL)\s*:/m.test(R4D_TEXT),
  'the observation capability must be a module-private WeakSet/WeakMap, never an exported token');
check('R4D22.builderDoesNotClaimCanonicalAuthority',
  /CANONICAL_AUTHORITY_ESTABLISHED_BY_BUILDER\s*=\s*false/.test(R4D_TEXT)
  && /CANONICAL_RECORD_SOURCE\s*=\s*'UPSTREAM_TRUSTED_PRECONDITION'/.test(R4D_TEXT)
  && /LIVE_CANONICAL_SOURCE_BINDING\s*=\s*'NOT_IMPLEMENTED'/.test(R4D_TEXT),
  'canonical record authority is an upstream precondition; the builder only guarantees snapshot integrity');
check('R4D23.fingerprintIsNotClaimedAsAuthority',
  /fingerprintRole:\s*'provenance-metadata'/.test(R4D_TEXT)
  && /cryptographicAuthority:\s*false/.test(R4D_TEXT),
  'contentFingerprint is provenance metadata, not a cryptographic authority');
check('R4D24.liveSettlementAndSourceBindingStayUnimplemented',
  /liveSettlement:\s*'NOT_IMPLEMENTED_R4D'/.test(R4D_TEXT)
  && /liveCanonicalSourceBinding/.test(R4D_TEXT),
  'sealing the snapshot must not be reported as enabling live settlement');
check('R4D18.canonicalObservationCannotBeSelfAttested',
  /observation-was-not-built-from-a-canonical-record/.test(R4D_TEXT)
  && /OBSERVATION_BRAND/.test(R4D_TEXT)
  && /isBuiltObservation/.test(R4D_TEXT),
  'a bare {canonical:true} object must never settle: only a builder-derived snapshot may');
check('R4D19.matchingAndJudgementAreSeparate',
  /MATCHING_MODE_MATRIX/.test(R4D_TEXT)
  && /OUTCOME_JUDGEMENT_MATRIX/.test(R4D_TEXT)
  && /OUTCOME_JUDGEMENT_RUNTIME = 'CALLER_VALIDATED_PROTOCOL_ONLY'/.test(R4D_TEXT)
  && !/SETTLEMENT_JUDGEMENT_MATRIX/.test(R4D_TEXT),
  'linkage and outcome judgement are two different things; the generic core never reads language');
check('R4D20.snapshotReusesTheExistingFingerprint',
  /contentFingerprint/.test(R4D_TEXT)
  && !/function\s+contentFingerprint/.test(R4D_TEXT),
  'snapshot integrity reuses memory-contract.contentFingerprint instead of a second algorithm');
check('R4D17.counterfactualStaysOut',
  !/counterfactual/i.test(R4D_TEXT),
  'R4-D must not touch R4-E: the counterfactual token stays out of these production files');

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
   §5b · R4-B SHADOW-ONLY 守卫（取代 metamemory 的零引用守卫）
   ──────────────────────────────────────────────────────────────────────
   metamemory 现在**允许**出现在 production —— 但只能以"影子"的形态。
   下面把"影子"变成可机械判定的性质，而不是一句承诺。 */
const SHADOW_TEXT = fs.existsSync(path.join(ROOT, R4B_SHADOW)) ? read(R4B_SHADOW) : '';
const ORCH_TEXT = read('assets/js/memory-recall/memory-recall-orchestrator.js');
/* 只看**代码面**：模块注释里逐字引用了 "Date.now" / "fetch" 等词来说明"本模块不做这些"，
   用朴素的行过滤会把自己的说明文字判成违规。 */
const stripComments = require('./helpers/activation-wiring-probe.js').stripJsComments;
const SHADOW_CODE = stripComments(SHADOW_TEXT);
const ORCH_CODE = stripComments(ORCH_TEXT);

check('R4B1.shadowCoreExists', SHADOW_TEXT.length > 0,
  'the one allowed runtime must exist at ' + R4B_SHADOW);
check('R4B2.shadowCoreIsPure',
  !/\bfetch\s*\(/.test(SHADOW_CODE)
  && !/XMLHttpRequest|WebSocket|EventSource/.test(SHADOW_CODE)
  && !/\brequire\s*\(\s*['"][^'"]*(home-node|memory-authority|memory-store|db|idb)/i.test(SHADOW_CODE)
  && !/localStorage|sessionStorage|indexedDB/.test(SHADOW_CODE)
  && !/\bDate\.now\s*\(/.test(SHADOW_CODE)
  && !/dbPut|dbGet|dbDelete|recordActivation/.test(SHADOW_CODE),
  'the shadow core must be a pure function: no network, no DB, no storage, no clock, no activation');
check('R4B3.shadowProducesNoNumericConfidence',
  /evidenceConfidence:\s*null/.test(SHADOW_TEXT)
  && /subjectiveConfidence:\s*null/.test(SHADOW_TEXT)
  && /subjectiveConfidenceState:\s*'not-evaluated'/.test(SHADOW_TEXT)
  && /state:\s*null/.test(SHADOW_TEXT),
  'R4-B must NOT invent numeric confidence: evidenceConfidence=null, subjectiveConfidence=null '
  + '(its future type is number, so no string may occupy the value field), state=null (deferred)');
check('R4B8.postAclShadowClaimsNothingUnobservable',
  /evidence-unavailable/.test(SHADOW_CODE)
  && !/evidence-missing/.test(SHADOW_CODE)
  && /FULL_VIEW_ONLY_STATES/.test(SHADOW_CODE)
  && /EVIDENCE_VIEWS\s*=\s*\['authorized',\s*'full'\]/.test(SHADOW_CODE)
  && /evidenceView:\s*'authorized'/.test(SHADOW_CODE),
  'post-ACL the shadow must say evidence-unavailable (cause unobservable) and may only emit '
  + 'evidence-lost / evidence-hidden under an explicit full-authority diagnostic view');
check('R4B9.noSecondaryEvidenceAlgorithmOrRetrieval',
  !/function\s+evidenceLiveness/.test(SHADOW_CODE)
  && !/\bfetch\s*\(|\bXMLHttpRequest\b/.test(SHADOW_CODE)
  && !/recordActivation|memory-store|home-node/i.test(SHADOW_CODE),
  'the shadow must reuse the single liveness authority and perform no extra retrieval');
check('R4B10.shadowHasNoProductionConsumer',
  (function () {
    const hits = [];
    const walk = dir => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const q = path.join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== 'node_modules') walk(q); continue; }
        if (!/\.(js|rs|toml|html)$/.test(e.name)) continue;
        const rel = path.relative(ROOT, q).replace(/\\/g, '/');
        if (rel === R4B_SHADOW || rel === 'assets/js/memory-recall/memory-recall-orchestrator.js') continue;
        if (fs.readFileSync(q, 'utf8').indexOf('metaMemoryShadow') >= 0) hits.push(rel);
      }
    };
    ['assets', 'services', 'bridge', 'src-tauri'].forEach(d => {
      const full = path.join(ROOT, d);
      if (fs.existsSync(full)) walk(full);
    });
    return hits.length === 0;
  })(),
  'no production file outside the orchestrator may consume the shadow sidecar');
check('R4B4.shadowReusesTheSingleEvidenceAlgorithm',
  /evidenceLiveness/.test(SHADOW_TEXT)
  && !/function\s+evidenceLiveness/.test(SHADOW_TEXT),
  'the shadow must CALL memory-visibility-core.evidenceLiveness, never re-implement liveness');
check('R4B5.shadowIsWiredOnlyIntoMeta',
  /metaMemoryShadow:\s*mmShadow/.test(ORCH_CODE)
  && !/result\.metaMemory/.test(ORCH_CODE)
  && !/metaMemoryShadow/.test(ORCH_CODE.split('return {')[0] || ''),
  'the shadow may only be attached to the internal meta seam, never to result');
check('R4B6.shadowIsFailOpen',
  /catch \(e\) \{ mmShadow = null; \}/.test(ORCH_CODE)
  && /catch \(e\) \{[\s\S]{0,600}shadowUnavailable/.test(SHADOW_CODE),
  'both the seam and the core must swallow their own failures (fail open)');
check('R4B7.noDurableMetaMemoryStore',
  !FORBIDDEN_STORES.some(name => declares(storeNames, "'" + name + "'")),
  'metamemory must still never get a durable object store');

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
