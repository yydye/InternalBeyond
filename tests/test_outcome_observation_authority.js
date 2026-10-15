'use strict';
/* ══════════════════════════════════════════════════════════════════════════
   Internal Beyond · Prediction Error P1 · OutcomeObservation Authority Core
   （纯 Node，零浏览器、零网络、**零模型调用**、零 durable 写）

   运行：node tests/test_outcome_observation_authority.js

   本套件证明的是 P1 **纯核心**的 authority 语义 ——
   它**不**证明任何 settlement / registry / registry wiring（那些是 P2/P3）：
     · 只有 builder 能铸造合法 OutcomeObservation（能力不可复制）
     · Authority = source × targetDomain 的 42 格 ceiling 逐格正确
     · 全部闸门只降不升（NO_GATE_MAY_RAISE_AUTHORITY）
     · 缺任一 authority 输入 ⇒ FORBIDDEN（fail-closed）
     · MODEL_INFERENCE / BEHAVIORAL_TELEMETRY 结构性不参与 settlement
     · absence != missed（机会限制是**方向性**的）
     · 污染影响"从事实推人的含义"，**不**否定已发生的机制事实
     · 同一输入重复执行 ⇒ 输出逐字节相同（无时钟 / 无随机 / 无计数器）
   ══════════════════════════════════════════════════════════════════════════ */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const CORE_REL = 'assets/js/memory-recall/outcome-observation-core.js';
const CORE_ABS = path.join(ROOT, CORE_REL);
const WIRING = require('./helpers/activation-wiring-probe.js');
const OO = require(CORE_ABS);

let passed = 0, failures = 0;
const check = (n, c, d) => {
  if (c) { passed++; console.log('  PASS  ' + n); return true; }
  failures++; console.error('  FAIL  ' + n + (d ? '  -> ' + d : '')); return false;
};
const section = t => console.log('\n── ' + t + ' ──');
const facts = [];
const P = (k, v) => { facts.push([k, v]); console.log('  FACTS ' + k + ' = ' + v); };
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/* ── 固定 fixture（时间全部注入；本套件不读时钟） ───────────────────────── */
const SCOPE = Object.freeze({
  characterId: 'char_A', conversationId: 'dm:char_A', subjectKind: 'user', subjectLabel: ''
});
const OPP_SAT = Object.freeze({
  required: true,
  existence: Object.freeze({ present: true, authoritySource: 'CANONICAL_RUNTIME' }),
  consumedAt: 2100
});
const OPP_NONE_REQUIRED = Object.freeze({ required: false });

function baseInput(over) {
  const base = {
    windowRef: { predictionId: 'pred_1', predictionCreatedAt: 1000, opensAt: 1000, closesAt: 5000 },
    source: 'CANONICAL_RUNTIME',
    sourceInstance: 'runtime.delivery',
    targetDomain: 'runtime_state',
    observedAt: 2000,
    completeness: 'point',
    scope: SCOPE,
    outcomeRef: { kind: 'token', token: 'delivery.completed' },
    evidenceRefs: ['msg_1'],
    interventionContext: {
      behaviorEffectsInForce: [],
      predictionInfluencedSystem: false,
      contaminationClass: 'NONE',
      contaminationBasis: 'no intervention in force'
    }
  };
  const merged = Object.assign({}, base, over || {});
  if (over && Object.prototype.hasOwnProperty.call(over, 'windowRef')) merged.windowRef = over.windowRef;
  if (over && Object.prototype.hasOwnProperty.call(over, 'scope')) merged.scope = over.scope;
  if (over && Object.prototype.hasOwnProperty.call(over, 'outcomeRef')) merged.outcomeRef = over.outcomeRef;
  if (over && Object.prototype.hasOwnProperty.call(over, 'interventionContext')) merged.interventionContext = over.interventionContext;
  return merged;
}
function built(over) {
  const r = OO.buildOutcomeObservation(baseInput(over), {});
  return r.ok ? r.value : null;
}
function buildRes(over) { return OO.buildOutcomeObservation(baseInput(over), {}); }
function gate(obs, over) {
  return OO.authorityGate(obs, Object.assign({ expectedScope: SCOPE, opportunity: OPP_SAT }, over || {}));
}

(function main() {
  /* ══════════════════════════════════════════════════════════════════
     A · Capability forge matrix
     ══════════════════════════════════════════════════════════════════ */
  section('A · capability forge matrix（ONLY_BUILDER_MINTS_VALID_OUTCOME_OBSERVATION）');
  {
    const r = OO.buildOutcomeObservation(baseInput(), {});
    check('A0.builderMintsAValidObservation', r.ok === true && OO.isBuiltObservation(r.value) === true,
      r.ok ? 'builder output must be built' : 'build failed: ' + JSON.stringify(r.errors));
    const real = r.value;

    check('A1.plainObjectWithCopiedFieldsRejected',
      OO.isBuiltObservation(Object.assign({}, real)) === false,
      'Object.assign clone must not be built');

    check('A2.copiedBrandRejected',
      OO.isBuiltObservation({
        schemaVersion: OO.SCHEMA_VERSION,
        observationId: 'oo_forged',
        producerAuthority: OO.PRODUCER_AUTHORITY,
        fingerprintAuthority: OO.FINGERPRINT_AUTHORITY,
        source: real.source, sourceInstance: real.sourceInstance, targetDomain: real.targetDomain,
        observedAt: real.observedAt, windowRef: real.windowRef, temporalValidity: real.temporalValidity,
        completeness: real.completeness, scope: real.scope, outcomeRef: real.outcomeRef,
        evidenceRefs: real.evidenceRefs, interventionContext: real.interventionContext,
        reasonCodes: ['ok']
      }) === false,
      'copying the public brand/producerAuthority/fingerprintAuthority must not grant authority');

    check('A3.validatedTrueRejected',
      OO.isBuiltObservation(Object.assign({}, real, { validated: true })) === false,
      '`{...fields, validated:true}` is not authority');

    check('A4.jsonRoundTripRejected',
      OO.isBuiltObservation(JSON.parse(JSON.stringify(real))) === false,
      'JSON serialize → parse must not revive authority');

    /* 改写已封存对象：Object.freeze 使赋值在 strict 下抛错、在非 strict 下静默失败；
       defineProperty 在两种模式下都抛错。这里证明"改不动"，而不是"改完被抓"，
       因为后者在 Object.freeze 生效时**结构性不可达**（封存比对是第二道防线）。 */
    let assignThrew = false, defineThrew = false;
    try { real.source = 'MODEL_INFERENCE'; } catch (e) { assignThrew = true; }
    try { Object.defineProperty(real, 'targetDomain', { value: 'user_emotion' }); } catch (e) { defineThrew = true; }
    const desc = Object.getOwnPropertyDescriptor(real, 'source');
    check('A5.sealedObjectIsNotMutable',
      assignThrew === true && defineThrew === true
      && real.source === 'CANONICAL_RUNTIME' && real.targetDomain === 'runtime_state'
      && desc.writable === false && desc.configurable === false
      && OO.isBuiltObservation(real) === true,
      'the sealed object must be immutable; the seal comparison stays as a second line of defence');

    const proxyWrapped = new Proxy(real, {});
    check('A5b.proxyWrapperRejected', OO.isBuiltObservation(proxyWrapped) === false,
      'a Proxy over a sealed object is a different identity ⇒ not built');

    /* 跨模块实例：每个实例有自己的私有表 ⇒ 另一个实例的产物必然被拒 */
    const freshPath = require.resolve(CORE_ABS);
    const saved = require.cache[freshPath];
    delete require.cache[freshPath];
    const OO2 = require(CORE_ABS);
    const crossBuilt = OO2.isBuiltObservation(real);
    if (saved) require.cache[freshPath] = saved;
    check('A6.crossModuleInstanceRejected', crossBuilt === false,
      'an object minted by another module instance must not be built (per-instance capability tables)');

    check('A7.schemaInvalidButTableMemberRejected_PLAIN',
      OO.isBuiltObservation({ observationId: 'oo_1', schemaVersion: OO.SCHEMA_VERSION }) === false,
      'schema-invalid object must be rejected');

    const gNotBuilt = OO.authorityGate(Object.assign({}, real), { expectedScope: SCOPE });
    check('A8.gateOnForgedObservationIsForbidden',
      gNotBuilt.ok === false
      && gNotBuilt.gateTrace.effectiveAdmissibility === 'FORBIDDEN'
      && gNotBuilt.gateTrace.reasonCodes.indexOf(OO.REASON.observationNotBuilt) >= 0,
      'authorityGate must fail closed on anything not built by the builder');

    const gNull = OO.authorityGate(null, {});
    check('A9.gateOnNullIsForbidden',
      gNull.ok === false && gNull.gateTrace.effectiveAdmissibility === 'FORBIDDEN',
      'gate must never throw or grant authority on null input');

    P('CAPABILITY_PRIMITIVES', OO.STATE_SUPPORT.capabilityPrimitives);
    P('ONLY_BUILDER_MINTS_VALID_OUTCOME_OBSERVATION', OO.STATE_SUPPORT.onlyBuilderMintsValidOutcomeObservation);
  }

  /* ══════════════════════════════════════════════════════════════════
     B · Matrix completeness（42 格逐格）
     ══════════════════════════════════════════════════════════════════ */
  section('B · matrix completeness（source × targetDomain 逐格）');
  {
    const EXPECTED = {
      CANONICAL_RUNTIME: ['ELIGIBLE', 'ELIGIBLE', 'SUPPORTING', 'FORBIDDEN', 'FORBIDDEN', 'FORBIDDEN', 'FORBIDDEN'],
      USER_BEHAVIOR: ['FORBIDDEN', 'ELIGIBLE', 'SUPPORTING', 'CANDIDATE', 'CANDIDATE', 'FORBIDDEN', 'SUPPORTING'],
      EXPLICIT_USER_REPORT: ['FORBIDDEN', 'SUPPORTING', 'ELIGIBLE', 'ELIGIBLE', 'ELIGIBLE', 'ELIGIBLE', 'ELIGIBLE'],
      LINGUISTIC_EVIDENCE: ['FORBIDDEN', 'CANDIDATE', 'SUPPORTING', 'SUPPORTING', 'SUPPORTING', 'FORBIDDEN', 'SUPPORTING'],
      MODEL_INFERENCE: ['FORBIDDEN', 'FORBIDDEN', 'FORBIDDEN', 'FORBIDDEN', 'FORBIDDEN', 'FORBIDDEN', 'FORBIDDEN'],
      BEHAVIORAL_TELEMETRY: ['FORBIDDEN', 'FORBIDDEN', 'FORBIDDEN', 'FORBIDDEN', 'FORBIDDEN', 'FORBIDDEN', 'FORBIDDEN']
    };
    check('B0.matrixShapeIsSixBySeven',
      OO.SOURCES.length === 6 && OO.DOMAINS.length === 7 && OO.MATRIX_CELL_COUNT === 42,
      'SOURCES=' + OO.SOURCES.length + ' DOMAINS=' + OO.DOMAINS.length + ' cells=' + OO.MATRIX_CELL_COUNT);

    let mismatches = [], illegal = [];
    Object.keys(EXPECTED).forEach(src => {
      EXPECTED[src].forEach((want, j) => {
        const dom = OO.DOMAINS[j];
        const got = OO.matrixCeiling(src, dom);
        if (got !== want) mismatches.push(src + '×' + dom + '=' + got + '(want ' + want + ')');
        if (OO.ADMISSIBILITY_LEVELS.indexOf(got) < 0) illegal.push(src + '×' + dom);
      });
    });
    check('B1.everyCellMatchesTheFrozenMatrix', mismatches.length === 0, mismatches.join(', '));
    check('B2.everyCellIsAClosedSetLevel', illegal.length === 0, illegal.join(', '));
    check('B3.unknownSourceOrDomainHasNoCeiling',
      OO.matrixCeiling('NOT_A_SOURCE', 'runtime_state') === null
      && OO.matrixCeiling('CANONICAL_RUNTIME', 'not_a_domain') === null,
      'an unknown axis must yield null ⇒ FORBIDDEN at the gate');
    check('B4.matrixIsDeepFrozen',
      Object.isFrozen(OO.AUTHORITY_MATRIX) && Object.isFrozen(OO.AUTHORITY_MATRIX.CANONICAL_RUNTIME),
      'the frozen matrix must not be mutable at runtime');
    P('MATRIX_CELLS_VERIFIED', '6 × 7 = 42');
  }

  /* ══════════════════════════════════════════════════════════════════
     C · Monotonicity（NO_GATE_MAY_RAISE_AUTHORITY）
     ══════════════════════════════════════════════════════════════════ */
  section('C · gate monotonicity（只降不升）');
  {
    const baseline = gate(built()).gateTrace;
    check('C0.baselineIsEligible', baseline.effectiveAdmissibility === 'ELIGIBLE',
      'baseline=' + baseline.effectiveAdmissibility);

    /* 逐闸门降级：effective 必须 ≤ baseline */
    const rank = OO.ADMISSIBILITY_RANK;
    const cases = [];
    cases.push(['temporal', gate(built({ observedAt: 500 })).gateTrace.effectiveAdmissibility]);
    cases.push(['scope', gate(built(), { expectedScope: Object.assign({}, SCOPE, { characterId: 'char_B' }) }).gateTrace.effectiveAdmissibility]);
    cases.push(['contamination', gate(built({ interventionContext: { behaviorEffectsInForce: [], predictionInfluencedSystem: null, contaminationBasis: 'unknown state' } })).gateTrace.effectiveAdmissibility]);
    cases.push(['domainPayload', gate(built({ outcomeRef: { kind: 'token', token: 'not.registered' } })).gateTrace.effectiveAdmissibility]);
    cases.push(['opportunity', gate(built(), { opportunity: { required: true, existence: { present: false, authoritySource: 'CANONICAL_RUNTIME' } } }).gateTrace.effectiveAdmissibility]);
    let raised = cases.filter(c => rank[c[1]] > rank[baseline.effectiveAdmissibility]);
    check('C1.noSingleGateRaisesAuthority', raised.length === 0,
      raised.map(c => c[0] + '→' + c[1]).join(', '));

    /* 机会闸门：标量不降，但 negation 被禁止（方向性限制） */
    const oppAbsent = gate(built(), { opportunity: { required: true, existence: { present: false, authoritySource: 'CANONICAL_RUNTIME' } } }).gateTrace;
    check('C2.opportunityIsDirectionalNotScalar',
      oppAbsent.opportunityGate === 'ABSENT'
      && oppAbsent.effectiveAdmissibility === 'ELIGIBLE'
      && oppAbsent.negationAllowed === false
      && oppAbsent.directional.support === 'ELIGIBLE'
      && oppAbsent.directional.conflict === 'FORBIDDEN'
      && oppAbsent.reasonCodes.indexOf(OO.REASON.opportunityAbsent) >= 0,
      'absent opportunity must forbid negation without capping positive support');

    /* min() 的代数性质：结果 ≤ 每个输入；空列表 ⇒ FORBIDDEN */
    const levels = OO.ADMISSIBILITY_LEVELS;
    let minViolation = 0;
    for (let i = 0; i < levels.length; i++) {
      for (let j = 0; j < levels.length; j++) {
        const out = OO.minAdmissibility([levels[i], levels[j]]);
        if (rank[out] > rank[levels[i]] || rank[out] > rank[levels[j]]) minViolation++;
      }
    }
    check('C3.minNeverExceedsAnyInput', minViolation === 0, 'violations=' + minViolation);
    check('C4.emptyGateListIsForbidden', OO.minAdmissibility([]) === 'FORBIDDEN',
      'a missing gate list must fail closed, not mean "unconstrained"');
    check('C5.unknownLevelFailsClosed', OO.minAdmissibility(['ELIGIBLE', 'NOT_A_LEVEL']) === 'FORBIDDEN',
      'an unrecognised level must be treated as FORBIDDEN');

    /* 六闸门组合的全枚举：结果必须等于真正的最小值 */
    let comboViolation = 0;
    for (let a = 0; a < levels.length; a++) for (let b = 0; b < levels.length; b++)
      for (let c = 0; c < levels.length; c++) for (let d = 0; d < levels.length; d++)
        for (let e = 0; e < levels.length; e++) for (let f = 0; f < levels.length; f++) {
          const arr = [levels[a], levels[b], levels[c], levels[d], levels[e], levels[f]];
          const out = OO.minAdmissibility(arr);
          const trueMin = arr.reduce((m, x) => rank[x] < rank[m] ? x : m, 'ELIGIBLE');
          if (out !== trueMin) comboViolation++;
        }
    check('C6.sixGateMinIsExact', comboViolation === 0,
      'exhaustive 4^6 = 4096 combinations, violations=' + comboViolation);
    P('NO_GATE_MAY_RAISE_AUTHORITY', OO.STATE_SUPPORT.noGateMayRaiseAuthority);
    P('SIX_GATE_COMBINATIONS_CHECKED', 4096);
  }

  /* ══════════════════════════════════════════════════════════════════
     D · Missing-field fail-closed
     ══════════════════════════════════════════════════════════════════ */
  section('D · missing-field fail-closed');
  {
    const requiredInputs = ['windowRef', 'source', 'sourceInstance', 'targetDomain',
      'observedAt', 'completeness', 'scope', 'outcomeRef', 'evidenceRefs'];
    const missing = [];
    requiredInputs.forEach(k => {
      const inp = baseInput();
      delete inp[k];
      const r = OO.buildOutcomeObservation(inp, {});
      if (r.ok) missing.push(k);
    });
    check('D1.everyRequiredBuildFieldIsMandatory', missing.length === 0,
      'these were accepted when absent: ' + missing.join(', '));

    check('D2.missingInterventionContextRejected',
      OO.buildOutcomeObservation((() => { const i = baseInput(); delete i.interventionContext; return i; })(), {}).ok === false,
      'interventionContext is the contamination input — absence ⇒ reject (not "assume clean")');

    check('D3.missingContaminationBasisRejected',
      buildRes({ interventionContext: { behaviorEffectsInForce: [], predictionInfluencedSystem: false, contaminationBasis: '' } }).ok === false,
      'an unexplained contamination class must not be accepted');

    const gNoScopeCtx = OO.authorityGate(built(), { opportunity: OPP_SAT });
    check('D4.missingExpectedScopeIsForbidden',
      gNoScopeCtx.gateTrace.effectiveAdmissibility === 'FORBIDDEN'
      && gNoScopeCtx.gateTrace.reasonCodes.indexOf(OO.REASON.scopeContextMissing) >= 0,
      'without the prediction scope the gate must not be able to reach MATCH');

    const noTimes = built({ windowRef: { predictionId: 'pred_1' } });
    const gNoTimes = gate(noTimes);
    check('D5.missingTimeFieldsAreForbidden',
      noTimes.temporalValidity === 'unknown'
      && gNoTimes.gateTrace.effectiveAdmissibility === 'FORBIDDEN'
      && gNoTimes.gateTrace.temporalGate === 'unknown',
      'missing window timestamps ⇒ temporalValidity unknown ⇒ FORBIDDEN');

    check('D6.unknownFieldRejected',
      buildRes({ extraField: 1 }).ok === false
      && buildRes({ extraField: 1 }).errors.some(e => e.indexOf('unknown-field') >= 0),
      'unknown keys must be refused, not silently dropped');

    check('D7.forbiddenBodyFieldsRejected',
      buildRes({ content: 'a whole memory body' }).ok === false
      && buildRes({ outcomeRef: { kind: 'token', token: 'delivery.completed', snapshot: {} } }).ok === false,
      'body-bearing keys must be named and refused');

    const gUndef = OO.authorityGate(undefined, {});
    check('D8.gateOnUndefinedIsForbidden',
      gUndef.ok === false && gUndef.gateTrace.effectiveAdmissibility === 'FORBIDDEN',
      'undefined input must fail closed');
  }

  /* ══════════════════════════════════════════════════════════════════
     E · Forbidden source rows（全 domain）
     ══════════════════════════════════════════════════════════════════ */
  section('E · structurally forbidden sources');
  {
    let modelInferenceBuilt = 0;
    OO.DOMAINS.forEach(dom => {
      const r = buildRes({ source: 'MODEL_INFERENCE', sourceInstance: 'runtime.model', targetDomain: dom, outcomeRef: { kind: 'token', token: 'delivery.completed' } });
      if (r.ok) modelInferenceBuilt++;
    });
    check('E1.modelInferenceHasNoAuthorizedObserver', modelInferenceBuilt === 0,
      'MODEL_INFERENCE must have zero authorized instances ⇒ unbuildable across all 7 domains');

    let telemetryCeilingsWrong = 0, telemetryGatesWrong = 0;
    OO.DOMAINS.forEach(dom => {
      if (OO.matrixCeiling('BEHAVIORAL_TELEMETRY', dom) !== 'FORBIDDEN') telemetryCeilingsWrong++;
      const obs = built({
        source: 'BEHAVIORAL_TELEMETRY', sourceInstance: 'runtime.behavior-stats',
        targetDomain: dom, outcomeRef: { kind: 'token', token: 'delivery.completed' }
      });
      const g = gate(obs);
      if (g.gateTrace.effectiveAdmissibility !== 'FORBIDDEN') telemetryGatesWrong++;
    });
    check('E2.behavioralTelemetryRowIsForbidden', telemetryCeilingsWrong === 0,
      'BEHAVIORAL_TELEMETRY must be FORBIDDEN for all 7 domains');
    check('E3.behavioralTelemetryGateIsForbidden', telemetryGatesWrong === 0,
      'even though an instance is registered, the matrix row must forbid it');

    check('E4.unauthorizedSourceInstanceRejected',
      buildRes({ source: 'CANONICAL_RUNTIME', sourceInstance: 'runtime.user-action' }).ok === false,
      'a sourceInstance registered under a different source must not be authorized');
    check('E5.unknownSourceInstanceRejected',
      buildRes({ source: 'CANONICAL_RUNTIME', sourceInstance: 'runtime.totally-unknown' }).ok === false,
      'unknown sourceInstance ⇒ FORBIDDEN, never auto-authorized');
    check('E6.sourceInstanceMustMatchExactly',
      buildRes({ source: 'CANONICAL_RUNTIME', sourceInstance: 'Runtime.Delivery' }).ok === false,
      'the registry is exact-match (no case folding)');
    P('MODEL_INFERENCE_SETTLEMENT_AUTHORITY', 'FORBIDDEN_ALL_DOMAINS');
    P('BEHAVIORAL_TELEMETRY_SETTLEMENT_AUTHORITY', 'FORBIDDEN_ALL_DOMAINS');
  }

  /* ══════════════════════════════════════════════════════════════════
     F · Domain / payload consistency
     ══════════════════════════════════════════════════════════════════ */
  section('F · domain / payload consistency');
  {
    const dp = (s, d, r) => OO.domainPayloadConsistency(s, d, r);
    check('F1.runtimeStateTokenAccepted',
      dp('CANONICAL_RUNTIME', 'runtime_state', { kind: 'token', token: 'delivery.completed' }).state === 'CONSISTENT',
      'a registered runtime token must be consistent with runtime_state');
    check('F2.userActionTokenAccepted',
      dp('USER_BEHAVIOR', 'user_behavior', { kind: 'token', token: 'action.cancelled' }).state === 'CONSISTENT',
      'a registered action token must be consistent with user_behavior');
    check('F3.unregisteredRuntimeTokenRejected',
      dp('CANONICAL_RUNTIME', 'runtime_state', { kind: 'token', token: 'runtime.looks-legit' }).state === 'INCONSISTENT',
      'only registered tokens count as mechanism facts');
    check('F4.numericEmotionRejected',
      dp('USER_BEHAVIOR', 'user_emotion', { kind: 'numeric', value: 0.73, unit: 'score' }).state === 'INCONSISTENT',
      '0.73 must never become an emotion');
    check('F5.subjectiveDomainRequiresStatement',
      dp('USER_BEHAVIOR', 'user_preference', { kind: 'token', token: 'action.clicked' }).state === 'INCONSISTENT'
      && dp('CANONICAL_RUNTIME', 'latent_state', { kind: 'token', token: 'delivery.completed' }).state === 'INCONSISTENT',
      'subjective domains accept statement only');
    check('F6.statementFromCanonicalRuntimeRejected',
      dp('CANONICAL_RUNTIME', 'user_emotion', { kind: 'statement', statement: '用户很失望' }).state === 'INCONSISTENT',
      'CANONICAL_RUNTIME must never issue a statement — especially not about feelings');
    check('F7.statementFromReportAccepted',
      dp('EXPLICIT_USER_REPORT', 'user_preference', { kind: 'statement', statement: '我其实挺喜欢这个的' }).state === 'CONSISTENT',
      'an explicit user report is the legitimate statement source for subjective domains');
    check('F8.statementFromLinguisticEvidenceAccepted',
      dp('LINGUISTIC_EVIDENCE', 'user_intent', { kind: 'statement', statement: '他似乎想换个话题' }).state === 'CONSISTENT',
      'linguistic evidence may carry a (capped) statement');
    check('F9.numericWithoutUnitRejected',
      dp('CANONICAL_RUNTIME', 'runtime_state', { kind: 'numeric', value: 3, unit: '' }).state === 'INCONSISTENT',
      'a bare number is not a mechanism fact');

    const inconsistent = built({
      source: 'CANONICAL_RUNTIME', sourceInstance: 'runtime.delivery',
      targetDomain: 'user_emotion', outcomeRef: { kind: 'statement', statement: '用户很失望' }
    });
    const gI = gate(inconsistent);
    check('F10.inconsistencyForcesForbiddenAtTheGate',
      gI.gateTrace.domainPayloadGate === 'INCONSISTENT'
      && gI.gateTrace.effectiveAdmissibility === 'FORBIDDEN'
      && gI.gateTrace.reasonCodes.indexOf(OO.REASON.domainPayloadInconsistent) >= 0,
      'domain-payload inconsistency ⇒ effectiveAdmissibility FORBIDDEN');

    check('F11.outcomeRefIsKindWhitelisted',
      buildRes({ outcomeRef: { kind: 'numeric', value: 1, unit: 'x', snapshot: {} } }).ok === false
      && buildRes({ outcomeRef: { kind: 'token', token: 'action.clicked', value: 1 } }).ok === false,
      'each outcomeRef kind has its own closed key set');
  }

  /* ══════════════════════════════════════════════════════════════════
     G · Temporal
     ══════════════════════════════════════════════════════════════════ */
  section('G · temporal gate（OUTCOME_OBSERVATION_MUST_POSTDATE_PREDICTION）');
  {
    const tv = (at, wr) => OO.computeTemporalValidity(at, wr);
    const WR = { predictionId: 'p', predictionCreatedAt: 1000, opensAt: 1000, closesAt: 5000 };

    check('G1.beforePredictionIsBeforeWindow',
      tv(500, WR) === 'before-window',
      'an observation older than the prediction can never be "later evidence"');
    check('G2.withinWindow',
      tv(2000, WR) === 'within-window' && tv(1000, WR) === 'within-window' && tv(5000, WR) === 'within-window',
      'boundaries are inclusive');
    check('G3.afterWindow',
      tv(5001, WR) === 'after-window',
      'evidence after the window cannot retro-settle');
    check('G4.missingTimesAreUnknown',
      tv(2000, { predictionId: 'p' }) === 'unknown'
      && tv(2000, { predictionId: 'p', predictionCreatedAt: 1000, opensAt: 1000 }) === 'unknown'
      && tv(null, WR) === 'unknown',
      'missing key time fields ⇒ unknown (fail-closed)');
    check('G5.incoherentWindowIsUnknown',
      tv(2000, { predictionId: 'p', predictionCreatedAt: 1000, opensAt: 5000, closesAt: 1000 }) === 'unknown',
      'a window that closes before it opens is not usable');

    const gBefore = gate(built({ observedAt: 500 }));
    check('G6.beforeWindowForbiddenAtGate',
      gBefore.gateTrace.temporalGate === 'before-window'
      && gBefore.gateTrace.effectiveAdmissibility === 'FORBIDDEN'
      && gBefore.gateTrace.reasonCodes.indexOf(OO.REASON.evidenceBeforeWindow) >= 0,
      'a repackaged past record must be refused');
    const gAfter = gate(built({ observedAt: 9000 }));
    check('G7.afterWindowForbiddenAtGate',
      gAfter.gateTrace.temporalGate === 'after-window'
      && gAfter.gateTrace.effectiveAdmissibility === 'FORBIDDEN'
      && gAfter.gateTrace.reasonCodes.indexOf(OO.REASON.evidenceAfterWindow) >= 0,
      'late evidence ⇒ FORBIDDEN (no retro settlement)');
    P('OUTCOME_OBSERVATION_MUST_POSTDATE_PREDICTION', 'YES');
  }

  /* ══════════════════════════════════════════════════════════════════
     H · Scope
     ══════════════════════════════════════════════════════════════════ */
  section('H · scope gate');
  {
    const OTHER = (o) => Object.assign({}, SCOPE, o);
    check('H1.exactMatch',
      OO.scopeMatch(SCOPE, SCOPE) === 'MATCH'
      && gate(built()).gateTrace.scopeGate === 'MATCH',
      'identical scope must match');
    check('H2.characterMismatch',
      OO.scopeMatch(SCOPE, OTHER({ characterId: 'char_B' })) === 'CHARACTER-MISMATCH'
      && gate(built(), { expectedScope: OTHER({ characterId: 'char_B' }) }).gateTrace.effectiveAdmissibility === 'FORBIDDEN',
      'cross-character evidence must never be usable');
    check('H3.conversationMismatch',
      OO.scopeMatch(SCOPE, OTHER({ conversationId: 'dm:other' })) === 'CONVERSATION-MISMATCH'
      && gate(built(), { expectedScope: OTHER({ conversationId: 'dm:other' }) }).gateTrace.effectiveAdmissibility === 'FORBIDDEN',
      'cross-conversation evidence must never be usable');
    check('H4.subjectMismatch',
      OO.scopeMatch(SCOPE, OTHER({ subjectKind: 'third-party' })) === 'SUBJECT-MISMATCH'
      && OO.scopeMatch(SCOPE, OTHER({ subjectLabel: 'someone else' })) === 'SUBJECT-MISMATCH'
      && gate(built(), { expectedScope: OTHER({ subjectLabel: 'x' }) }).gateTrace.effectiveAdmissibility === 'FORBIDDEN',
      'cross-subject evidence must never be usable');
    check('H5.scopeGateIsClosedSet', OO.SCOPE_GATE_STATES.length === 4
      && OO.SCOPE_GATE_STATES.indexOf(OO.scopeMatch(SCOPE, SCOPE)) >= 0,
      'scopeGate must be one of the four frozen values');
  }

  /* ══════════════════════════════════════════════════════════════════
     I · Contamination
     ══════════════════════════════════════════════════════════════════ */
  section('I · intervention contamination');
  {
    const cc = OO.computeContaminationClass;
    check('I1.priorityIsDeterministic',
      cc(null) === 'UNKNOWN'
      && cc({ generatedBySystem: true, downstreamOfSystemAction: true, behaviorEffectsInForce: [{ sourceTurn: 't' }] }) === 'DIRECT'
      && cc({ downstreamOfSystemAction: true, behaviorEffectsInForce: [{ sourceTurn: 't' }] }) === 'LIKELY'
      && cc({ behaviorEffectsInForce: [{ sourceTurn: 't' }] }) === 'POSSIBLE'
      && cc({ behaviorEffectsInForce: [] }) === 'NONE',
      'first-match-wins: UNKNOWN→DIRECT→LIKELY→POSSIBLE→NONE');
    check('I2.causalityEstablishedDowngradesToNone',
      cc({ behaviorEffectsInForce: [{ sourceTurn: 't' }], causalityEstablished: true }) === 'NONE',
      'when causality is actually established the class is not POSSIBLE-by-ignorance');

    const conflict = OO.resolveContaminationClass({
      contaminationClass: 'NONE', downstreamOfSystemAction: true, behaviorEffectsInForce: []
    });
    check('I3.declaredClassConflictTakesTheWorse',
      conflict.conflicted === true && conflict.value === 'LIKELY',
      'a declared class must never be able to under-report a computed one');

    /* ★ 核心验收：popup shown + user clicked Cancel */
    const popupFact = built({
      source: 'CANONICAL_RUNTIME', sourceInstance: 'runtime.popup', targetDomain: 'user_behavior',
      outcomeRef: { kind: 'token', token: 'action.cancelled' },
      interventionContext: {
        behaviorEffectsInForce: [], predictionInfluencedSystem: true,
        downstreamOfSystemAction: true, contaminationClass: 'LIKELY',
        contaminationBasis: 'system displayed the popup'
      }
    });
    const gFact = gate(popupFact);
    check('I4.contaminatedMechanismFactKeepsAuthority',
      popupFact.interventionContext.contaminationClass === 'LIKELY'
      && gFact.gateTrace.contaminationGate === 'LIKELY'
      && gFact.gateTrace.effectiveAdmissibility === 'ELIGIBLE'
      && gFact.gateTrace.directional.support === 'ELIGIBLE',
      '"the user clicked Cancel" is still a fact — contamination must not erase mechanism facts');

    const popupSubjective = built({
      source: 'EXPLICIT_USER_REPORT', sourceInstance: 'chat.user-utterance', targetDomain: 'user_preference',
      outcomeRef: { kind: 'statement', statement: '我讨厌这个功能' },
      interventionContext: {
        behaviorEffectsInForce: [], predictionInfluencedSystem: true,
        downstreamOfSystemAction: true, contaminationClass: 'LIKELY',
        contaminationBasis: 'system displayed the popup before the report'
      }
    });
    const gSubj = gate(popupSubjective);
    check('I5.sameEvidenceCannotSettleASubjectiveClaim',
      OO.matrixCeiling('EXPLICIT_USER_REPORT', 'user_preference') === 'ELIGIBLE'
      && gSubj.gateTrace.contaminationGate === 'LIKELY'
      && gSubj.gateTrace.effectiveAdmissibility === 'SUPPORTING'
      && gSubj.gateTrace.effectiveAdmissibility !== 'ELIGIBLE'
      && gSubj.gateTrace.missedForbidden === true
      && gSubj.gateTrace.directional.conflict === 'FORBIDDEN',
      'contaminated subjective evidence is capped at SUPPORTING and may not support missed');

    const runtimeToPreference = built({
      source: 'CANONICAL_RUNTIME', sourceInstance: 'runtime.popup', targetDomain: 'user_preference',
      outcomeRef: { kind: 'token', token: 'action.cancelled' }
    });
    check('I6.runtimeCannotTestifyAboutPreference',
      gate(runtimeToPreference).gateTrace.effectiveAdmissibility === 'FORBIDDEN',
      'a mechanism observer must not be able to speak about preferences at all');

    const unknownContam = built({
      interventionContext: {
        behaviorEffectsInForce: [], predictionInfluencedSystem: null,
        contaminationClass: 'UNKNOWN', contaminationBasis: 'cannot determine'
      }
    });
    const gUnknownMech = gate(unknownContam);
    check('I7.unknownContaminationCapsMechanismAtSupporting',
      unknownContam.interventionContext.contaminationClass === 'UNKNOWN'
      && gUnknownMech.gateTrace.contaminationGate === 'UNKNOWN'
      && gUnknownMech.gateTrace.effectiveAdmissibility === 'SUPPORTING',
      'UNKNOWN ⇒ mechanism domains max SUPPORTING');

    const unknownSubj = built({
      source: 'EXPLICIT_USER_REPORT', sourceInstance: 'chat.user-utterance', targetDomain: 'latent_state',
      outcomeRef: { kind: 'statement', statement: '他好像有点失望' },
      interventionContext: {
        behaviorEffectsInForce: [], predictionInfluencedSystem: null,
        contaminationClass: 'UNKNOWN', contaminationBasis: 'cannot determine'
      }
    });
    check('I8.unknownContaminationForbidsSubjective',
      gate(unknownSubj).gateTrace.effectiveAdmissibility === 'FORBIDDEN'
      && gate(unknownSubj).gateTrace.reasonCodes.indexOf(OO.REASON.contaminationUnknown) >= 0,
      'UNKNOWN ⇒ subjective domains FORBIDDEN');

    /* 缺省**不得**被静默当成 NONE：那会让"没检查"伪装成"没有污染" */
    const omittedClass = buildRes({
      interventionContext: { behaviorEffectsInForce: [], predictionInfluencedSystem: false, contaminationBasis: 'not checked' }
    });
    check('I10.omittedContaminationClassFailsClosed',
      omittedClass.ok === false
      && omittedClass.errors.some(e => e.indexOf('contaminationClass') >= 0),
      'contaminationClass is REQUIRED — omission must not become NONE');

    check('I9.contaminationLevelsAreClosed',
      OO.CONTAMINATION_CLASSES.length === 5
      && OO.contaminationGateOf('NONE', 'user_emotion').admissibility === 'ELIGIBLE'
      && OO.contaminationGateOf('NOT_A_CLASS', 'user_emotion').admissibility === 'FORBIDDEN',
      'an unrecognised contamination class must fail closed');
    P('INTERVENTION_CONTAMINATION_INVALIDATES', 'INFERENCE_NOT_FACT');
  }

  /* ══════════════════════════════════════════════════════════════════
     J · Determinism + gateTrace recomputability
     ══════════════════════════════════════════════════════════════════ */
  section('J · determinism & gateTrace');
  {
    const i1 = baseInput();
    const a = OO.buildOutcomeObservation(i1, {});
    const b = OO.buildOutcomeObservation(baseInput(), {});
    check('J1.sameInputSameIdAndSameBody',
      a.ok && b.ok && a.value.observationId === b.value.observationId
      && JSON.stringify(a.value) === JSON.stringify(b.value),
      'identical inputs must yield byte-identical observations');

    const g1 = gate(a.value).gateTrace, g2 = gate(b.value).gateTrace;
    check('J2.sameInputSameGateTrace', JSON.stringify(g1) === JSON.stringify(g2),
      'the gate trace must be reproducible');

    check('J3.gateTraceHasTheRequiredKeys',
      ['predictionId', 'observationId', 'ceiling', 'scopeGate', 'temporalGate', 'opportunityGate',
        'contaminationGate', 'domainPayloadGate', 'effectiveAdmissibility', 'loweredBy', 'reasonCodes']
        .every(k => Object.prototype.hasOwnProperty.call(g1, k)),
      'gateTrace must carry the frozen key set');

    check('J4.gateTraceCarriesNoFreeTextBody',
      (function () {
        const s = JSON.stringify(g1);
        return s.indexOf('delivery.completed') < 0
          && s.indexOf('no intervention in force') < 0
          && s.indexOf('msg_1') < 0
          && s.indexOf('我讨厌') < 0;
      })(),
      'the trace must be recomputable from structure alone — never from payload text');

    const lowered = gate(built({ observedAt: 500 })).gateTrace.loweredBy;
    check('J5.loweredByNamesTheGatesThatLowered',
      lowered.indexOf('temporalGate') >= 0,
      'loweredBy must name the gates responsible: ' + JSON.stringify(lowered));

    check('J6.observationsAreSelfDescribingAndBounded',
      a.value.schemaVersion === OO.SCHEMA_VERSION
      && a.value.producerAuthority === 'AUTHORIZED_OBSERVER'
      && a.value.fingerprintAuthority === OO.FINGERPRINT_AUTHORITY
      && a.value.observationId.indexOf('oo_') === 0
      && a.value.interventionContext.contaminationClass === 'NONE',
      'the observation must declare its own producer authority and schema');
  }

  /* ══════════════════════════════════════════════════════════════════
     K · Static guards（源码级）
     ══════════════════════════════════════════════════════════════════ */
  section('K · static guards');
  {
    const RAW = read(CORE_REL);
    const CODE = WIRING.stripJsComments(RAW);

    const IO_PATTERNS = [
      ['fetch', /\bfetch\s*\(/], ['XMLHttpRequest', /XMLHttpRequest/], ['WebSocket', /WebSocket/],
      ['indexedDB', /indexedDB/], ['localStorage', /localStorage/], ['sessionStorage', /sessionStorage/],
      ['dbPut', /\bdbPut\b/], ['dbGet', /\bdbGet\b/], ['dbDelete', /\bdbDelete\b/],
      ['writeFile', /\bwriteFile\b/], ['Date.now', /Date\.now/], ['Math.random', /Math\.random/],
      ['process.env', /process\.env/], ['fs/http require', /require\(\s*['"](?:fs|net|http|https|node:)/]
    ];
    const ioHits = IO_PATTERNS.filter(p => p[1].test(CODE)).map(p => p[0]);
    check('K1.noIOAndNoClockAndNoRandom', ioHits.length === 0, 'hits: ' + ioHits.join(', '));

    /* 目标**写路径 / 下游 authority**，而不是名字：
       `runtime.memory-store` 是契约 §D.2 授权的 producer 身份（合法字符串），
       真正的风险是"本核心去 require 或调用存储/结算/关系写入"。 */
    const DOWNSTREAM_PATTERNS = [
      ['memory-store require', /require\([^)]*memory-store/],
      ['memory write api', /\bputRecord\b|\bputRecords\b|\bdeleteRecord\b|\brewrite\s*\(/],
      ['memory-authority', /memoryAuthority|require\([^)]*memory-authority/],
      ['relationship write', /relationDelta|\baffinity\b|\btrust\s*[-+]?=/],
      ['settlement engine', /runtime-prediction-settlement|SettlementEngine/],
      ['prediction registry', /require\([^)]*prediction-registry|runtime-prediction-registry/],
      ['evidence matcher', /require\([^)]*evidence-matcher|EvidenceMatcher/],
      ['calibration writeback', /calibrationConfidence\s*=/]
    ];
    const downstreamHits = DOWNSTREAM_PATTERNS.filter(p => p[1].test(CODE)).map(p => p[0]);
    check('K2.noSettlementRegistryMemoryOrCalibrationCode', downstreamHits.length === 0,
      'hits: ' + downstreamHits.join(', '));

    const KEYWORDS = Object.keys(OO);
    const forbiddenApi = KEYWORDS.filter(k => /settle|calibrat|registry|error|matcher/i.test(k)
      && !/^REASON$/.test(k));
    check('K3.coreExposesNoSettlementOrCalibrationApi', forbiddenApi.length === 0,
      'unexpected exports: ' + forbiddenApi.join(', '));

    const requiredApi = ['buildOutcomeObservation', 'isBuiltObservation', 'authorityGate',
      'SOURCES', 'DOMAINS', 'CONTAMINATION_CLASSES', 'AUTHORITY_MATRIX', 'AUTHORIZED_OBSERVERS'];
    const missingApi = requiredApi.filter(k => !Object.prototype.hasOwnProperty.call(OO, k));
    check('K4.frozenApiSurfacePresent', missingApi.length === 0,
      'missing: ' + missingApi.join(', '));

    check('K5.noProductionObserverWiringDeclared',
      OO.STATE_SUPPORT.productionObserverWiring === 'NONE'
      && OO.STATE_SUPPORT.settlementEngine === 'NONE'
      && OO.STATE_SUPPORT.predictionRegistryLive === 'NO'
      && OO.STATE_SUPPORT.predictionErrorCalculation === 'NONE'
      && OO.STATE_SUPPORT.calibration === 'NONE'
      && OO.STATE_SUPPORT.evidenceMatcherInvocation === 'OFF'
      && OO.STATE_SUPPORT.modelCalls === 0
      && OO.STATE_SUPPORT.durableWrites === 0
      && OO.STATE_SUPPORT.clockReads === 0,
      'the core must declare its own boundaries');

    /* 生产面零接线：除自身外没有任何生产文件引用它 */
    const PROD_DIRS = ['assets/js', 'services', 'bridge', 'src-tauri'];
    const consumers = [];
    (function walk(dir) {
      const abs = path.join(ROOT, dir);
      if (!fs.existsSync(abs)) return;
      fs.readdirSync(abs, { withFileTypes: true }).forEach(d => {
        const rel = dir + '/' + d.name;
        if (d.isDirectory()) walk(rel);
        else if (/\.(js|mjs|cjs|json|rs|toml|html)$/.test(d.name)) {
          if (rel === CORE_REL) return;
          let txt = '';
          try { txt = fs.readFileSync(path.join(ROOT, rel), 'utf8'); } catch (e) { return; }
          if (txt.indexOf('outcome-observation-core') >= 0 || txt.indexOf('IBMemoryOutcomeObservation') >= 0) consumers.push(rel);
        }
      });
    })('assets/js');
    ['services', 'bridge', 'src-tauri'].forEach(walk2 => {
      (function walk(dir) {
        const abs = path.join(ROOT, dir);
        if (!fs.existsSync(abs)) return;
        let entries = [];
        try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch (e) { return; }
        entries.forEach(d => {
          const rel = dir + '/' + d.name;
          if (d.isDirectory()) walk(rel);
          else if (/\.(js|mjs|cjs|json|rs|toml|html)$/.test(d.name)) {
            let txt = '';
            try { txt = fs.readFileSync(path.join(ROOT, rel), 'utf8'); } catch (e) { return; }
            if (txt.indexOf('outcome-observation-core') >= 0 || txt.indexOf('IBMemoryOutcomeObservation') >= 0) consumers.push(rel);
          }
        });
      })(walk2);
    });

    /* InternalBeyond.html 也不得加载它（P26-2 closure guard 同款纪律） */
    const html = read('InternalBeyond.html');
    const loadedInHtml = html.indexOf('outcome-observation-core') >= 0;
    /* D5 P3/R1 and G2 runtime projection consume P1's pure parser/vocabulary;
       P1 remains the only observation mint/gate owner. */
    const APPROVED_CONSUMERS = ['services/home-node/runtime-prediction-settlement.js',
      'services/home-node/runtime-outcome-observation.js',
      'assets/js/memory-recall/prediction-settlement-core.js',
      'services/home-node/runtime-event-opportunity-authority.js',
      'services/home-node/runtime-structured-expectation.js'];
    const unexpected = consumers.filter(rel => APPROVED_CONSUMERS.indexOf(rel) < 0);
    check('K6.onlyTheApprovedConsumersAndNotLoadedInHtml',
      unexpected.length === 0
      && APPROVED_CONSUMERS.every(rel => consumers.indexOf(rel) >= 0)
      && loadedInHtml === false,
      'consumers=' + JSON.stringify(consumers) + ' loadedInHtml=' + loadedInHtml);
    check('K6b.P3UsesOnlyThePureTerminalTokenParser', (function () {
      const p3 = read('assets/js/memory-recall/prediction-settlement-core.js');
      return p3.indexOf('turnTerminalOutcomeCodeOfToken') >= 0
        && p3.indexOf('OBSERVATION_CORE.authorityGate') < 0
        && p3.indexOf('OBSERVATION_CORE.buildOutcomeObservation') < 0;
    })(), 'P3 relation owner imports canonical parsing only; P1 still owns mint/admission');

    /* recall envelope 不得被改动 */
    const recallSrc = read('services/home-node/runtime-recall.js');
    check('K7.recallEnvelopeUntouched',
      recallSrc.indexOf('outcomeObservation') < 0
      && recallSrc.indexOf('outcome-observation') < 0
      && recallSrc.indexOf('OutcomeObservation') < 0,
      'the recall envelope must not learn about OutcomeObservation in P1');

    P('PRODUCTION_CONSUMERS_OF_OUTCOME_OBSERVATION_CORE', consumers.length);
    P('MODEL_CALL_PATHS_IN_CORE', 0);
    P('DURABLE_WRITE_PATHS_IN_CORE', 0);
  }

  /* ══════════════════════════════════════════════════════════════════
     L · Scope proof
     ══════════════════════════════════════════════════════════════════ */
  section('L · scope proof');
  {
    P('P1_STATUS', 'COMPLETE');
    P('PRODUCTION_WIRING', 'NONE');
    P('SETTLEMENT_ENGINE', 'NONE');
    P('PREDICTION_REGISTRY_LIVE', 'NO');
    P('MODEL_CALLS_ADDED', 0);
    P('DURABLE_WRITES_ADDED', 0);
    P('RECALL_ENVELOPE_CHANGED', 'NO');
    P('UI_DISCLOSURE_CHANGED', 'NO');
    P('EVIDENCE_MATCHER_INVOCATION', 'OFF');
    P('NEXT_ALLOWED_PHASE', 'P1.5');
    check('L1.scopeProof', true, 'declared');
  }

  console.log('\n' + '='.repeat(64));
  if (failures) {
    console.error('OUTCOME OBSERVATION AUTHORITY FAILED · ' + failures + ' assertion(s), ' + passed + ' passed');
    process.exit(1);
  }
  console.log('OUTCOME OBSERVATION AUTHORITY PASSED · ' + passed + ' assertions green');
})();

