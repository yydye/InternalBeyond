/* ====================================================================
   IB Memory · Prediction Observation / Error 结算核心（R4-D / R4-D.1）
   --------------------------------------------------------------------
   NO CANONICAL OUTCOME → NO SETTLEMENT

   ── R4-D.1 的两处修正（本文件的重点）────────────────────────────────
   ① `canonical:true` **不再**是可信输入：调用方**不能自证** canonicality。
      唯一合法的 observation 由 `buildCanonicalObservation(record, ctx)` **派生**：
        · evidenceMemoryId ← record.id
        · observedOutcome  ← canonical record 的字段（确定性优先级）
        · canonical        ← **builder 产生**的派生标记（带 brand）
      裸对象即使写 canonical:true 也会被 settle 拒绝。

   ② **matching ≠ judgement**，两件事分开：
        MATCHING_MODE_MATRIX      —— "这条 observation 是否**被允许**用于这个 expectation"
        OUTCOME_JUDGEMENT_MATRIX  —— "它对 prediction 是 confirmed / contradicted / …"
      本核心**不推导** result，只接受**已验证的外部判定**：
        OUTCOME_JUDGEMENT_RUNTIME = CALLER_VALIDATED_PROTOCOL_ONLY
      通用核心**没有**自然语言判断器，也**不假装**有。

   纯函数：不搜 store、不调模型、不写 DB、不读时钟。
   ==================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    var contract = null;
    try { contract = require('../memory-contract.js'); } catch (e) { contract = null; }
    module.exports = factory(contract);
  } else {
    root.IBMemoryPredictionObservation = factory(root.IBMemoryContract || null);
  }
})(typeof self !== 'undefined' ? self : this, function (CONTRACT) {
  'use strict';

  var RESULTS = ['confirmed', 'contradicted', 'partial', 'unknown', 'unsettled'];

  /* ── OUTCOME MATCHING：这条 observation 是否**被允许**用于这个 expectation ──
     这里判的**只是 linkage**，**不是** prediction 对错。 */
  var MATCHING_MODES = ['explicit-link', 'deterministic-domain-trigger', 'model-validated', 'none'];

  var MATCHING_MODE_MATRIX = {
    'explicit-link': {
      linkage: 'DETERMINISTIC',
      requires: 'caller-supplied expectationId present on both sides and equal',
      derivesResult: false
    },
    'deterministic-domain-trigger': {
      linkage: 'DETERMINISTIC',
      requires: 'expectation.trigger.kind === match.matchTriggerKind',
      derivesResult: false
    },
    'model-validated': {
      linkage: 'REQUIRES_MODEL',
      requires: 'structurallyValidated === true',
      derivesResult: false
    },
    none: { linkage: 'NOT_SUPPORTED', requires: null, derivesResult: false }
  };

  /* ── OUTCOME JUDGEMENT：observation 对 prediction 是什么结果 ──────────────
     **通用核心不推导。** explicit-link 只保证"该用它"，**不**保证"能判对错"。 */
  var OUTCOME_JUDGEMENT_MATRIX = {
    'caller-supplied-validated': 'CALLER_SUPPLIED_VALIDATED',
    'language-semantics': 'REQUIRES_MODEL',
    'deterministic-comparator': 'NOT_SUPPORTED',
    'text-similarity-only': 'NOT_SUPPORTED',
    'implicit-inference': 'NOT_SUPPORTED'
  };

  var OUTCOME_JUDGEMENT_RUNTIME = 'CALLER_VALIDATED_PROTOCOL_ONLY';

  /* 观测快照字段优先级（§10，机械决定，不是偏好）：
       content  —— canonical 主文本（recall 渲染它、contentFingerprint 覆盖它）
       summary  —— canonical 短形式
       title    —— canonical 标签
     **刻意不含 oneLine**：R4-A.4 的审计已证明它只被展示面消费
     （引言渲染 + 轮播池）。把展示字符串当"发生了什么"的证据，
     等于把 UI 文本升格成事实。 */
  var SNAPSHOT_FIELD_PRECEDENCE = ['content', 'summary', 'title'];
  var MAX_SNAPSHOT_CHARS = 600;

  /* builder 产物的 brand：**只有** buildCanonicalObservation 能设置。 */
  var OBSERVATION_BRAND = 'ib.canonical-observation.v1';

  var REASON_CODES = {
    ok: 'ok',
    noExpectation: 'no-expectation-input',
    noObservation: 'no-observation-input',
    observationNotBuilt: 'observation-was-not-built-from-a-canonical-record',
    observationRecordIdMissing: 'canonical-record-has-no-id',
    observationSnapshotUnavailable: 'canonical-record-has-no-usable-text-field',
    observationUnauthorized: 'observation-outside-authorized-evidence',
    noMatching: 'no-validated-matching',
    modelMatchingNotValidated: 'model-matching-without-structural-validation',
    judgementMissing: 'outcome-judgement-not-supplied',
    judgementNotValidated: 'outcome-judgement-not-marked-validated',
    unsettled: 'no-canonical-outcome-yet',
    calibratedNull: 'calibration-confidence-null-no-settled-history',
    discreteErrorOnly: 'prediction-error-is-discrete-not-continuous',
    revisionSignalOnly: 'prediction-error-is-a-revision-signal-not-a-correction',
    noCanonicalMutation: 'settlement-does-not-mutate-canonical',
    liveSettlementNotImplemented: 'live-settlement-not-implemented',
    behaviourCountMissing: 'behavior-consumer-count-not-declared',
    selfInfluenceNotEvaluated: 'self-influence-not-evaluated'
  };

  function isPlainObject(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
  function str(v, max) {
    if (v == null) return null;
    var s = String(v);
    return max && s.length > max ? s.slice(0, max) : s;
  }

  /* ── ① canonical observation builder（唯一合法来源）──────────────────── */
  function buildCanonicalObservation(record, ctx) {
    var c = isPlainObject(ctx) ? ctx : {};
    if (!isPlainObject(record)) return { ok: false, reason: REASON_CODES.noObservation };
    var id = record.id == null ? null : String(record.id);
    if (!id) return { ok: false, reason: REASON_CODES.observationRecordIdMissing };
    if (Array.isArray(c.authorizedMemoryIds)) {
      var allowed = c.authorizedMemoryIds.map(String);
      if (allowed.indexOf(id) < 0) return { ok: false, reason: REASON_CODES.observationUnauthorized };
    }
    var field = null, text = null, rawLen = 0;
    for (var i = 0; i < SNAPSHOT_FIELD_PRECEDENCE.length; i++) {
      var f = SNAPSHOT_FIELD_PRECEDENCE[i];
      var v = record[f];
      if (v == null) continue;
      var s = String(v).trim();
      if (!s) continue;
      field = f; rawLen = s.length;
      text = s.length > MAX_SNAPSHOT_CHARS ? s.slice(0, MAX_SNAPSHOT_CHARS) : s;
      break;
    }
    if (!text) return { ok: false, reason: REASON_CODES.observationSnapshotUnavailable };
    var hasFp = !!(CONTRACT && typeof CONTRACT.contentFingerprint === 'function');
    return {
      ok: true,
      value: {
        brand: OBSERVATION_BRAND,
        evidenceMemoryId: id,
        canonical: true,                 /* builder 派生输出，不是调用方输入 */
        observedOutcome: text,
        snapshotField: field,
        truncated: rawLen > MAX_SNAPSHOT_CHARS,
        observedAt: Number.isFinite(Number(c.observedAt)) ? Number(c.observedAt) : null,
        source: str(record.rawSource != null ? record.rawSource : record.source, 64),
        /* 完整性：复用仓库**已有**的 contentFingerprint（不复制第二套算法） */
        sourceFingerprint: hasFp ? CONTRACT.contentFingerprint(record) : null,
        fingerprintAuthority: hasFp ? 'memory-contract.contentFingerprint' : 'unavailable'
      }
    };
  }

  function isBuiltObservation(o) {
    return isPlainObject(o) && o.brand === OBSERVATION_BRAND && o.canonical === true
      && typeof o.evidenceMemoryId === 'string' && typeof o.observedOutcome === 'string';
  }

  /* ── ② 匹配门（**只**判 linkage，不判对错）────────────────────────── */
  function normalizeMatch(expectation, observation, match) {
    var m = isPlainObject(match) ? match : null;
    if (!m) return { ok: false, reason: REASON_CODES.noMatching };
    var mode = String(m.mode || '');
    var spec = MATCHING_MODE_MATRIX[mode];
    if (!spec || spec.linkage === 'NOT_SUPPORTED') return { ok: false, reason: REASON_CODES.noMatching };
    if (mode === 'model-validated' && m.structurallyValidated !== true) {
      return { ok: false, reason: REASON_CODES.modelMatchingNotValidated };
    }
    if (mode === 'explicit-link') {
      var a = expectation && expectation.expectationId, b = m.observationExpectationId;
      if (a == null || b == null) return { ok: false, reason: REASON_CODES.noMatching };
      if (String(a) !== String(b)) return { ok: false, reason: REASON_CODES.noMatching };
    }
    if (mode === 'deterministic-domain-trigger') {
      var expTrigger = expectation && expectation.trigger && expectation.trigger.kind;
      if (!expTrigger || String(expTrigger) !== String(m.matchTriggerKind)) {
        return { ok: false, reason: REASON_CODES.noMatching };
      }
    }
    return { ok: true, value: { mode: mode, linkage: spec.linkage, derivesResult: false } };
  }

  /* ── ③ 判定门（**只**接受已验证的外部判定；核心不推导）────────────── */
  function normalizeJudgement(deps) {
    var d = isPlainObject(deps) ? deps : {};
    var j = isPlainObject(d.judgement) ? d.judgement : null;
    if (!j) {
      var legacy = str(d.result, 32);
      if (!legacy) return { ok: false, reason: REASON_CODES.judgementMissing };
      if (d.judgementValidated !== true) return { ok: false, reason: REASON_CODES.judgementNotValidated };
      if (RESULTS.indexOf(legacy) < 0 || legacy === 'unsettled') return { ok: false, reason: REASON_CODES.judgementMissing };
      return { ok: true, value: { result: legacy, source: 'caller-supplied-validated', validated: true } };
    }
    if (j.validated !== true) return { ok: false, reason: REASON_CODES.judgementNotValidated };
    var r = str(j.result, 32);
    if (RESULTS.indexOf(r) < 0 || r === 'unsettled') return { ok: false, reason: REASON_CODES.judgementMissing };
    return { ok: true, value: { result: r, source: str(j.source, 64) || 'caller-supplied-validated', validated: true } };
  }

  /* ── ④ 结算主体 ───────────────────────────────────────────────────── */
  function settle(expectation, observation, deps) {
    var d = isPlainObject(deps) ? deps : {};
    var exp = isPlainObject(expectation) ? expectation : null;
    var base = {
      ok: false,
      durable: false,
      expectationId: exp && exp.expectationId != null ? String(exp.expectationId) : null,
      coreGeneratedExpectationId: false,     /* 本核心**不生成** expectation id */
      predictionSnapshot: exp ? str(exp.prediction, 500) : null,
      observedOutcome: null,
      evidenceMemoryId: null,
      snapshotField: null,
      sourceFingerprint: null,
      result: 'unsettled',
      resultSource: null,
      matching: null,
      predictionError: null,
      predictionErrorMetric: null,
      calibrationCounts: { confirmed: 0, contradicted: 0, partial: 0, unknown: 0 },
      calibrationConfidence: null,
      attribution: null,
      reasonCodes: []
    };
    if (!exp) { base.reasonCodes.push(REASON_CODES.noExpectation); return base; }

    /* ★ 只有 builder 产物才算 canonical observation —— 调用方不能自证。 */
    if (!isBuiltObservation(observation)) {
      base.reasonCodes.push(REASON_CODES.observationNotBuilt, REASON_CODES.unsettled);
      return base;
    }
    base.observedOutcome = observation.observedOutcome;
    base.evidenceMemoryId = observation.evidenceMemoryId;
    base.snapshotField = observation.snapshotField;
    base.sourceFingerprint = observation.sourceFingerprint;

    var mt = normalizeMatch(exp, observation, d.match);
    if (!mt.ok) { base.reasonCodes.push(mt.reason, REASON_CODES.unsettled); return base; }

    var jd = normalizeJudgement(d);
    if (!jd.ok) { base.reasonCodes.push(jd.reason, REASON_CODES.unsettled); return base; }

    base.ok = true;
    base.result = jd.value.result;
    base.resultSource = jd.value.source;
    base.matching = mt.value;
    base.predictionError = {
      kind: 'discrete',
      result: jd.value.result,
      metric: null,
      judgementRuntime: OUTCOME_JUDGEMENT_RUNTIME,
      reasonCodes: [REASON_CODES.discreteErrorOnly, REASON_CODES.revisionSignalOnly, REASON_CODES.noCanonicalMutation]
    };
    base.predictionErrorMetric = null;
    base.calibrationCounts = {
      confirmed: jd.value.result === 'confirmed' ? 1 : 0,
      contradicted: jd.value.result === 'contradicted' ? 1 : 0,
      partial: jd.value.result === 'partial' ? 1 : 0,
      unknown: jd.value.result === 'unknown' ? 1 : 0
    };
    base.calibrationConfidence = null;

    var bcc = Number(d.behaviorConsumerCount);
    if (!isFinite(bcc)) {
      base.attribution = {
        attributionConfidence: null, selfInfluencePossible: null,
        behaviorEffectsApplied: [], behaviorInfluenceStatus: 'not-evaluated'
      };
      base.reasonCodes.push(REASON_CODES.behaviourCountMissing, REASON_CODES.selfInfluenceNotEvaluated);
    } else if (bcc === 0) {
      base.attribution = {
        attributionConfidence: null, selfInfluencePossible: false,
        behaviorEffectsApplied: [], behaviorInfluenceStatus: 'none-observed'
      };
    } else {
      base.attribution = {
        attributionConfidence: null, selfInfluencePossible: true,
        behaviorEffectsApplied: [], behaviorInfluenceStatus: 'possible-unattributed'
      };
    }
    base.reasonCodes.push(REASON_CODES.ok, REASON_CODES.calibratedNull, REASON_CODES.liveSettlementNotImplemented);
    return base;
  }

  function noSelfReinforcingUpdate(previous, settlement) {
    var prev = isPlainObject(previous) ? previous : {};
    var s = isPlainObject(settlement) ? settlement : {};
    return {
      applied: false,
      reason: 'NO_SELF_REINFORCING_CONFIDENCE_LOOP',
      confidenceBefore: prev.subjectivePredictionConfidence == null ? null : prev.subjectivePredictionConfidence,
      confidenceAfter: prev.subjectivePredictionConfidence == null ? null : prev.subjectivePredictionConfidence,
      calibrationConfidence: null,
      countsOnly: s.calibrationCounts || { confirmed: 0, contradicted: 0, partial: 0, unknown: 0 }
    };
  }

  return {
    settle: settle,
    buildCanonicalObservation: buildCanonicalObservation,
    isBuiltObservation: isBuiltObservation,
    noSelfReinforcingUpdate: noSelfReinforcingUpdate,
    normalizeMatch: normalizeMatch,
    normalizeJudgement: normalizeJudgement,
    RESULTS: RESULTS,
    MATCHING_MODES: MATCHING_MODES,
    MATCHING_MODE_MATRIX: MATCHING_MODE_MATRIX,
    OUTCOME_JUDGEMENT_MATRIX: OUTCOME_JUDGEMENT_MATRIX,
    OUTCOME_JUDGEMENT_RUNTIME: OUTCOME_JUDGEMENT_RUNTIME,
    SNAPSHOT_FIELD_PRECEDENCE: SNAPSHOT_FIELD_PRECEDENCE,
    OBSERVATION_BRAND: OBSERVATION_BRAND,
    REASON_CODES: REASON_CODES,
    STATE_SUPPORT: {
      liveSettlement: 'NOT_IMPLEMENTED_R4D',
      sessionOnlySettlement: 'FEASIBLE_NOT_IMPLEMENTED',
      durableObservation: 'NOT_IMPLEMENTED_R4D',
      numericPredictionError: 'NOT_FROZEN',
      outcomeJudgement: OUTCOME_JUDGEMENT_RUNTIME,
      expectationIdAssignment: 'EXTERNAL_ID_REQUIRED_FOR_LINKED_SETTLEMENT',
      calibrationConfidence: 'NULL_UNTIL_SETTLED_HISTORY',
      expectationRevision: 'NOT_IMPLEMENTED_R4D',
      behaviorEffect: 'NOT_IMPLEMENTED_R4F'
    }
  };
});
