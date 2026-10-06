/* ====================================================================
   IB Memory · Prediction Calibration Core（Prediction Error P4）
   --------------------------------------------------------------------
   NO REINTERPRETATION · NO RE-AUTHORITY · NO GLOBAL ACCURACY · NO MODEL

   它**只**做四件事：
     ① 消费**已经合法结算**且 P3 标记 `calibrationCounted === true` 的 SettlementRecord
     ② 解析 **partition key**（predictionType × targetDomain）
     ③ 做**机械计数**（七状态 vocabulary + ordinal PE bucket）
     ④ 产出一个**只读**、内部审计用的 summary

   ── 它**没有**的能力 ─────────────────────────────────────────────────
     settlement authority · observation authority · prediction authority ·
     memory authority · relationship authority · model authority。
     零 I/O · 零网络 · 零模型 · 零 durable 写 · 零时钟 · 零随机 ·
     零 Expectation / Interpretation / Memory / Relationship 回写。

   ── 三条本相位最重要的硬规则 ─────────────────────────────────────────
     CALIBRATION_AUTHORITY_SOURCE = P3 SettlementRecord
       P3 说 calibrationCounted=false ⇒ P4 **MUST NOT** 覆盖它。没有 authority 重开。
     GLOBAL_PREDICTION_ACCURACY = FORBIDDEN
       不存在 overallAccuracy / globalAccuracy 这类可被 authority 消费的字段。
     CROSS_PARTITION_CONFIDENCE_TRANSFER = FORBIDDEN
       event × runtime_state 很准 ⇒ 绝不抬高 preference / latent_state / relational。
   ==================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    var memoryContract = null;
    try { memoryContract = require('../memory-contract.js'); } catch (e) { memoryContract = null; }
    module.exports = factory(memoryContract);
  } else {
    root.IBMemoryPredictionCalibration = factory(root.IBMemoryContract || null);
  }
})(typeof self !== 'undefined' ? self : this, function (CONTRACT) {
  'use strict';

  var SCHEMA_VERSION = 'prediction-calibration/v1';
  var ENTRY_PREFIX = 'cal_';
  var ID_LIFETIME = 'SESSION_ONLY';

  /* ══════════════════════════════════════════════════════════════════
     ① 冻结词表
     ══════════════════════════════════════════════════════════════════ */

  /* canonical 名称是 `calibrationCounts`；`calibrationEvidence` 是已废弃的散文别名。 */
  var CANONICAL_COUNTS_NAME = 'calibrationCounts';
  var DEPRECATED_ALIAS = 'calibrationEvidence';

  var CALIBRATION_COUNT_KEYS = Object.freeze([
    'matched', 'missed', 'mixed', 'expired_unobserved', 'unresolvable', 'superseded',
    'eligibleTotal', 'decisiveTotal'
  ]);
  /* P3 已冻结：只有 matched / missed 会 calibrationCounted=true。
     其余四态在 calibrationCounts 里保持 **0**（完整审计 vocabulary），
     绝不折算成半个成功/失败。 */
  var DECISIVE_ELIGIBLE_STATES = Object.freeze(['matched', 'missed']);
  var NON_DECISIVE_STATES = Object.freeze(['mixed', 'expired_unobserved', 'unresolvable', 'superseded']);

  /* legacy D.2 结果词表：**不得**成为新 Ledger 的 key（LEGACY_RESULT_ADAPTER = NONE）。 */
  var LEGACY_D2_RESULTS = Object.freeze(['confirmed', 'contradicted', 'partial', 'ambiguous']);
  var LEGACY_RESULT_ADAPTER = 'NONE';

  /* contract 已冻结：v1 `calibrationConfidence` **恒为 null**。
     （`PREDICTION_ERROR_AUTHORITY_CONTRACT.md` §H / §C.3：`calibrationConfidence = null`，
      G24 断言其恒 null 且无写回路径；G27 禁止造未冻结的数值。）
     ⇒ 这是 **Option B**，且不是本相位的自由裁量：契约已经这么冻了。 */
  var CALIBRATION_CONFIDENCE = null;
  var NO_FORMULA_INVENTION_TO_AVOID_NULL = true;

  var SAMPLE_STATUS = Object.freeze(['empty', 'counts-only']);
  var CAPABILITY_COVERAGE_STATUS = Object.freeze([
    'settleable-by-current-runtime',
    'capability-gap',
    'not-policy-allowed'
  ]);

  var DIRECTION_KEYS = Object.freeze(['over-confident', 'under-confident', 'calibrated', 'unknown']);
  var MAGNITUDE_KEYS = Object.freeze(['none', 'low', 'moderate', 'high', 'unknown']);

  /* **禁止**出现的全局精度字段名：它们不得成为可供 authority 消费的 runtime field。 */
  var FORBIDDEN_ACCURACY_FIELDS = Object.freeze([
    'globalAccuracy', 'overallAccuracy', 'predictionAccuracy', 'accuracy',
    'globalConfidence', 'overallConfidence', 'hitRate', 'successRate'
  ]);

  var GLOBAL_ACCURACY = 'FORBIDDEN';
  var CROSS_PARTITION_TRANSFER = 'FORBIDDEN';

  /* 当前 runtime 的机械分类能力由 **P3 settlement core** 单一出处提供
     （`RUNTIME_CLASSIFIABLE_MODES`），P4 **不**再复制一张表。
     这里只保留 P4 自己的自述。 */
  var EVIDENCE_MATCHER_INVOCATION = 'OFF';
  /* R2 · capability gap 的具名原因词表（与 matcher core 的语义一致） */
  var CAPABILITY_GAP_REASONS = Object.freeze([
    'matcher-not-present', 'matcher-disabled', 'statement-relation-unavailable',
    'attribution-unknown', 'policy-forbidden', 'source-not-decisive', 'no-eligible-sample'
  ]);
  var MULTI_DOMAIN_CALIBRATION_PARTITION_V1 = 'FORBIDDEN';
  var EXACTLY_ONE_ADMITTED_TARGET_DOMAIN_REQUIRED = 'YES';

  var REASON = Object.freeze({
    ok: 'ok',
    notASettlementRecord: 'not-a-sealed-settlement-record',
    provenanceMissing: 'settlement-provenance-missing',
    notCalibrationCounted: 'p3-says-not-calibration-counted',
    selfInfluenced: 'self-influenced-settlement',
    nonDecisiveState: 'non-decisive-state-is-not-a-calibration-sample',
    legacyResultForbidden: 'legacy-d2-result-is-not-a-ledger-key',
    predictedTypeMissing: 'prediction-type-missing',
    targetDomainMissing: 'target-domain-missing',
    duplicateEntry: 'duplicate-settlement-entry',
    countNotApplicable: 'count-not-applicable',
    capabilityGap: 'policy-allows-but-runtime-cannot-classify',
    settlementCombinationUnreachable: 'settlement-combination-unreachable',
    partitionUnresolvable: 'calibration-partition-unresolvable',
    partitionUnresolvableNoDomain: 'partition-unresolvable-no-domain',
    partitionUnresolvableMultiDomain: 'partition-unresolvable-multi-domain',
    partitionMultiDomainDiagnosticsOnly: 'partition-unresolvable-multi-domain-diagnostics-only',
    noEligibleSample: 'no-eligible-sample',
    noSampleIsNotPolicyForbidden: 'no-sample-is-not-policy-forbidden',
    noSampleIsNotCapabilityGap: 'no-sample-is-not-capability-gap',
    policyForbidsDecisive: 'policy-forbids-decisive-settlement',
    productionNotSettleable: 'runtime-classifiable-but-production-not-settleable',
    countsOnly: 'counts-only-no-frozen-sufficiency-rule',
    calibrationConfidenceNull: 'calibration-confidence-null-by-contract',
    globalAccuracyForbidden: 'global-accuracy-forbidden',
    crossPartitionForbidden: 'cross-partition-confidence-transfer-forbidden',
    sessionOnly: 'session-only-lifetime',
    internalAuditOnly: 'internal-audit-only'
  });

  /* ══════════════════════════════════════════════════════════════════
     ② 纯 helper
     ══════════════════════════════════════════════════════════════════ */
  function isPlainObject(v) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
    var proto = Object.getPrototypeOf(v);
    return proto === Object.prototype || proto === null;
  }
  function text(v) { return v == null ? '' : String(v); }
  function deepFreeze(v) {
    if (!v || typeof v !== 'object' || Object.isFrozen(v)) return v;
    Object.freeze(v);
    Object.keys(v).forEach(function (k) { deepFreeze(v[k]); });
    return v;
  }
  function stableStringify(v) {
    try {
      if (CONTRACT && typeof CONTRACT.stableStringify === 'function') return CONTRACT.stableStringify(v);
    } catch (e) { /* fall through */ }
    return JSON.stringify(v);
  }
  function stableToken(seed) {
    var s = text(seed), h1 = 0x811c9dc5, h2 = 0x01000193;
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      h1 = (h1 ^ c) >>> 0;
      h1 = (h1 + ((h1 << 1) + (h1 << 4) + (h1 << 7) + (h1 << 8) + (h1 << 24))) >>> 0;
      h2 = ((h2 ^ c) * 16777619) >>> 0;
    }
    return (h1.toString(36) + h2.toString(36)).slice(0, 12);
  }

  /* ══════════════════════════════════════════════════════════════════
     ③ 分区键（**唯一的**跨域隔离机制）
     ══════════════════════════════════════════════════════════════════ */

  /** 从 settlement 抽出 predictionType（判定一律以**建档快照**为准）。 */
  function predictionTypeOf(settlement) {
    var snap = isPlainObject(settlement) && isPlainObject(settlement.predictionSnapshotAtCreation)
      ? settlement.predictionSnapshotAtCreation : null;
    return snap ? text(snap.predictionType) : '';
  }
  function contradictionModeOf(settlement) {
    var snap = isPlainObject(settlement) && isPlainObject(settlement.predictionSnapshotAtCreation)
      ? settlement.predictionSnapshotAtCreation : null;
    return snap ? text(snap.contradictionMode) : '';
  }

  /** targetDomain：**恰好一个**被采纳域才算可解析（R3）。 */
  function targetDomainOf(settlement) {
    var list = isPlainObject(settlement) && Array.isArray(settlement.admittedTargetDomains)
      ? settlement.admittedTargetDomains : [];
    var seen = [], out = [];
    for (var i = 0; i < list.length; i++) {
      var d = text(list[i]);
      if (!d || seen.indexOf(d) >= 0) continue;
      seen.push(d); out.push(d);
    }
    if (out.length === 1) return out[0];
    /* 0 个 ⇒ ''（不可解析）；>1 个 ⇒ 'mixed-domains'（**不是**一个可计数分区） */
    return out.length === 0 ? '' : 'mixed-domains';
  }

  /**
   * partitionResolution(settlement)
   *   R3：**恰好一个** admitted target domain 是 v1 calibration 计数的硬前提。
   *     0 个 ⇒ partition-unresolvable-no-domain
   *     >1 个 ⇒ partition-unresolvable-multi-domain（diagnostics only）
   *   **不得**挑第一个域，**不得**建 mixed-domains 桶，**不得**把一条结算拆进多个分区
   *   （后者会让一条 settlement 被多次统计）。
   */
  function partitionResolution(settlement) {
    var list = isPlainObject(settlement) && Array.isArray(settlement.admittedTargetDomains)
      ? settlement.admittedTargetDomains : [];
    var seen = [], domains = [];
    for (var i = 0; i < list.length; i++) {
      var d = text(list[i]);
      if (!d || seen.indexOf(d) >= 0) continue;
      seen.push(d); domains.push(d);
    }
    var type = predictionTypeOf(settlement);
    if (!type) {
      return { ok: false, reasonCode: REASON.predictionTypeMissing, partition: null, domainCount: domains.length, domains: domains };
    }
    if (domains.length === 0) {
      return { ok: false, reasonCode: REASON.partitionUnresolvableNoDomain, partition: null, domainCount: 0, domains: domains };
    }
    if (domains.length > 1) {
      return {
        ok: false, reasonCode: REASON.partitionUnresolvableMultiDomain,
        partition: null, domainCount: domains.length, domains: domains,
        diagnosticsOnly: true, participatesInCalibrationCounts: false
      };
    }
    var domain = domains[0];
    return {
      ok: true, reasonCode: REASON.ok, domainCount: 1, domains: domains,
      partition: Object.freeze({
        predictionType: type,
        targetDomain: domain,
        key: type + '\u0000' + domain
      })
    };
  }

  /**
   * calibrationPartitionKey(settlement) → { predictionType, targetDomain, key } | null
   * 只有**恰好一个** admitted domain 时才返回；多域/零域一律 null（不猜、不建混合桶）。
   */
  function calibrationPartitionKey(settlement) {
    return partitionResolution(settlement).partition;
  }

  /** consumption identity：同一个 SettlementRecord 至多被统计一次。 */
  function calibrationEntryId(settlement, partition) {
    var p = partition || calibrationPartitionKey(settlement);
    if (!p || !isPlainObject(settlement)) return null;
    return ENTRY_PREFIX + stableToken([
      text(settlement.registrySessionRef),
      text(settlement.settlementId),
      text(settlement.predictionId),
      p.key
    ].join('|'));
  }

  /* ══════════════════════════════════════════════════════════════════
     ④ 计数 vocabulary
     ══════════════════════════════════════════════════════════════════ */
  function emptyCounts() {
    return {
      matched: 0, missed: 0, mixed: 0, expired_unobserved: 0, unresolvable: 0, superseded: 0,
      eligibleTotal: 0, decisiveTotal: 0
    };
  }
  function emptyErrorCounts() {
    var out = { directions: {}, magnitudes: {}, cells: {} };
    DIRECTION_KEYS.forEach(function (d) { out.directions[d] = 0; });
    MAGNITUDE_KEYS.forEach(function (m) { out.magnitudes[m] = 0; });
    DIRECTION_KEYS.forEach(function (d) {
      out.cells[d] = {};
      MAGNITUDE_KEYS.forEach(function (m) { out.cells[d][m] = 0; });
    });
    return out;
  }
  function emptyCapabilityCoverage() {
    var out = {};
    CAPABILITY_COVERAGE_STATUS.forEach(function (s) { out[s] = 0; });
    return out;
  }

  /**
   * 入口判定（顺序即权威顺序）：
   *   ① provenance（由 runtime 用 module-private capability 提供）
   *   ② P3 的 calibrationCounted —— **唯一**硬入口
   *   ③ 状态必须在 decisive-eligible 集合里
   *   ④ 不得是 self-influenced（P3 已经算过，这里只做冗余校验，不重开）
   */
  function entryEligibility(settlement, provenance) {
    var reasons = [];
    if (!isPlainObject(settlement)) return { eligible: false, reasonCodes: [REASON.notASettlementRecord] };
    if (!provenance || provenance.settlementRecord !== true) {
      return { eligible: false, reasonCodes: [REASON.provenanceMissing] };
    }
    var state = text(settlement.state);
    if (LEGACY_D2_RESULTS.indexOf(state) >= 0) {
      return { eligible: false, reasonCodes: [REASON.legacyResultForbidden] };
    }
    if (settlement.calibrationCounted !== true) {
      /* ★ 硬规则：P3 说不算，P4 **没有** authority 重开。 */
      reasons.push(REASON.notCalibrationCounted);
      if (isPlainObject(settlement.interventionSummary)
        && settlement.interventionSummary.selfInfluenced === true) {
        reasons.push(REASON.selfInfluenced);
      }
      if (NON_DECISIVE_STATES.indexOf(state) >= 0) reasons.push(REASON.nonDecisiveState);
      return { eligible: false, reasonCodes: reasons };
    }
    if (DECISIVE_ELIGIBLE_STATES.indexOf(state) < 0) {
      return { eligible: false, reasonCodes: [REASON.nonDecisiveState] };
    }
    return { eligible: true, reasonCodes: [REASON.ok] };
  }

  /** 把一个 eligible entry 机械地并入 counts。**没有**任何加权。 */
  function applyCounts(counts, state) {
    var out = Object.assign({}, counts);
    if (CALIBRATION_COUNT_KEYS.indexOf(state) >= 0) out[state] += 1;
    out.eligibleTotal += 1;
    if (DECISIVE_ELIGIBLE_STATES.indexOf(state) >= 0) out.decisiveTotal += 1;
    return out;
  }
  /** ordinal PE bucket 累加：**只**加 1，绝不加权、绝不相加数值。 */
  function applyPredictionError(errorCounts, direction, magnitude) {
    var out = {
      directions: Object.assign({}, errorCounts.directions),
      magnitudes: Object.assign({}, errorCounts.magnitudes),
      cells: {}
    };
    DIRECTION_KEYS.forEach(function (d) {
      out.cells[d] = Object.assign({}, errorCounts.cells[d]);
    });
    var d = DIRECTION_KEYS.indexOf(text(direction)) >= 0 ? text(direction) : 'unknown';
    var m = MAGNITUDE_KEYS.indexOf(text(magnitude)) >= 0 ? text(magnitude) : 'unknown';
    out.directions[d] += 1;
    out.magnitudes[m] += 1;
    out.cells[d][m] += 1;
    return out;
  }

  /* ══════════════════════════════════════════════════════════════════
     ⑤ capability coverage（R1：三个维度必须正交，绝不塌缩）
     ══════════════════════════════════════════════════════════════════
     维度：policyPermission × runtimeCapability × sampleAvailability
       status = policy 不允许          → 'not-policy-allowed'
              = policy 允许 + 有能力   → 'settleable-by-current-runtime'
              = policy 允许 + 缺能力   → 'capability-gap'
     ★ 样本数量（noEligibleSample）**绝不**参与 status 判定。
       NO_SAMPLE != BAD_PERFORMANCE != POLICY_FORBIDDEN != CAPABILITY_GAP */
  function capabilityCoverage(input) {
    var i = isPlainObject(input) ? input : {};
    var type = text(i.predictionType);
    var mode = text(i.contradictionMode);
    var counts = i.counts || emptyCounts();
    /* policy / capability 的**唯一**出处是 P3 settlement core（由 runtime 传入）。 */
    var policyAllowed = i.policyAllowed === true;
    var runtimeClassifiable = i.runtimeClassifiable === true;
    /* R2 · production settleability 是**第四个**正交维度：
       runtime 能分类 ≠ 生产上真能 decisive（还要归因 authority 足够）。 */
    var productionSettleable = runtimeClassifiable && i.attributionAuthorityAvailable === true;
    var status;
    if (!policyAllowed) status = 'not-policy-allowed';
    else if (runtimeClassifiable) status = 'settleable-by-current-runtime';
    else status = 'capability-gap';
    var noEligibleSample = counts.eligibleTotal === 0;
    var capabilityGap = policyAllowed && !runtimeClassifiable;
    var reasons = [];
    if (!policyAllowed) reasons.push(REASON.policyForbidsDecisive);
    if (capabilityGap) reasons.push(REASON.capabilityGap);
    /* R2 · 具名 reason 列表（不要把原因压成一个无信息字符串） */
    var reasonList = Array.isArray(i.capabilityGapReason) ? i.capabilityGapReason.slice(0, 8) : [];
    if (runtimeClassifiable && !productionSettleable) {
      reasons.push(REASON.productionNotSettleable);
      if (reasonList.indexOf('attribution-unknown') < 0) reasonList.push('attribution-unknown');
    }
    if (noEligibleSample) {
      reasons.push(REASON.noEligibleSample);
      if (policyAllowed) reasons.push(REASON.noSampleIsNotPolicyForbidden);
      reasons.push(REASON.noSampleIsNotCapabilityGap);
    }
    return Object.freeze({
      predictionType: type,
      contradictionMode: mode,
      /* —— 四个正交维度，各自独立可见 —— */
      policyAllowed: policyAllowed,
      runtimeClassifiable: runtimeClassifiable,
      productionSettleable: productionSettleable,
      attributionAuthorityAvailable: i.attributionAuthorityAvailable === true,
      noEligibleSample: noEligibleSample,
      capabilityGap: capabilityGap,
      status: status,
      evidenceMatcherInvocation: EVIDENCE_MATCHER_INVOCATION,
      unclassifiableObservations: Number(i.unclassifiableObservations) || 0,
      capabilityGapReason: reasonList,
      reasonCodes: reasons
    });
  }

  /* ══════════════════════════════════════════════════════════════════
     ⑥ summary（只读 · ordinal · 无全局精度）
     ══════════════════════════════════════════════════════════════════ */
  function sampleStatusOf(counts) {
    /* `empty` 是**定义性**的（0 条），不是阈值。
       contract 没有冻结任何 sufficiency 阈值 ⇒ 有数据也只能是 'counts-only'。
       **不**擅自写 ">= 3 moderate" / ">= 5 strong"。 */
    return counts.eligibleTotal > 0 ? 'counts-only' : 'empty';
  }

  /**
   * calibrationSummary(input)
   *   input = { predictionType, contradictionMode, counts, errorCounts,
   *             capabilityCoverage, unclassifiableObservations }
   * 返回**只读**摘要：counts + ordinal buckets + sampleStatus + capabilityCoverage
   * + `calibrationConfidence = null`（契约冻结）。
   * ★ 里面**没有**任何 accuracy / hitRate / probability / numeric weight 字段。
   */
  function calibrationSummary(input) {
    var counts = Object.assign(emptyCounts(), (input && input.counts) || {});
    var errorCounts = (input && input.errorCounts) || emptyErrorCounts();
    var coverage = (input && input.capabilityCoverage)
      || capabilityCoverage({
        predictionType: input && input.predictionType,
        contradictionMode: input && input.contradictionMode,
        counts: counts,
        policyAllowed: input && input.policyAllowed,
        runtimeClassifiable: input && input.runtimeClassifiable
      });
    var reasons = [REASON.calibrationConfidenceNull, REASON.sessionOnly, REASON.internalAuditOnly];
    if (coverage.capabilityGap) reasons.push(REASON.capabilityGap);
    if (counts.eligibleTotal === 0) reasons.push(REASON.noEligibleSample); else reasons.push(REASON.countsOnly);
    return deepFreeze({
      canonicalCountsName: CANONICAL_COUNTS_NAME,
      deprecatedAlias: DEPRECATED_ALIAS,
      predictionType: text(input && input.predictionType),
      partitionKey: text(input && input.partitionKey) || null,
      calibrationCounts: counts,
      predictionErrorBuckets: errorCounts,
      sampleStatus: sampleStatusOf(counts),
      capabilityCoverage: coverage,
      /* ★ 契约冻结：v1 恒 null。不存在 hidden formula。 */
      calibrationConfidence: CALIBRATION_CONFIDENCE,
      calibrationConfidenceBasis: 'NULL_BY_CONTRACT_NO_FROZEN_DERIVATION_RULE',
      /* 只用于**审计**：不是任何 confidence 的输入 */
      diagnosticOnly: true,
      reasonCodes: reasons
    });
  }

  return {
    /* 主入口 */
    calibrationPartitionKey: calibrationPartitionKey,
    calibrationEntryId: calibrationEntryId,
    entryEligibility: entryEligibility,
    applyCounts: applyCounts,
    applyPredictionError: applyPredictionError,
    capabilityCoverage: capabilityCoverage,
    partitionResolution: partitionResolution,
    calibrationSummary: calibrationSummary,
    predictionTypeOf: predictionTypeOf,
    contradictionModeOf: contradictionModeOf,
    targetDomainOf: targetDomainOf,
    sampleStatusOf: sampleStatusOf,
    emptyCounts: emptyCounts,
    emptyErrorCounts: emptyErrorCounts,
    emptyCapabilityCoverage: emptyCapabilityCoverage,
    deepFreeze: deepFreeze,
    stableToken: stableToken,
    stableStringify: stableStringify,

    SCHEMA_VERSION: SCHEMA_VERSION,
    ENTRY_PREFIX: ENTRY_PREFIX,
    ID_LIFETIME: ID_LIFETIME,
    CANONICAL_COUNTS_NAME: CANONICAL_COUNTS_NAME,
    DEPRECATED_ALIAS: DEPRECATED_ALIAS,
    CALIBRATION_COUNT_KEYS: CALIBRATION_COUNT_KEYS,
    DECISIVE_ELIGIBLE_STATES: DECISIVE_ELIGIBLE_STATES,
    NON_DECISIVE_STATES: NON_DECISIVE_STATES,
    LEGACY_D2_RESULTS: LEGACY_D2_RESULTS,
    LEGACY_RESULT_ADAPTER: LEGACY_RESULT_ADAPTER,
    CALIBRATION_CONFIDENCE: CALIBRATION_CONFIDENCE,
    NO_FORMULA_INVENTION_TO_AVOID_NULL: NO_FORMULA_INVENTION_TO_AVOID_NULL,
    SAMPLE_STATUS: SAMPLE_STATUS,
    CAPABILITY_COVERAGE_STATUS: CAPABILITY_COVERAGE_STATUS,
    DIRECTION_KEYS: DIRECTION_KEYS,
    MAGNITUDE_KEYS: MAGNITUDE_KEYS,
    FORBIDDEN_ACCURACY_FIELDS: FORBIDDEN_ACCURACY_FIELDS,
    GLOBAL_ACCURACY: GLOBAL_ACCURACY,
    CROSS_PARTITION_TRANSFER: CROSS_PARTITION_TRANSFER,
    MULTI_DOMAIN_CALIBRATION_PARTITION_V1: MULTI_DOMAIN_CALIBRATION_PARTITION_V1,
    EXACTLY_ONE_ADMITTED_TARGET_DOMAIN_REQUIRED: EXACTLY_ONE_ADMITTED_TARGET_DOMAIN_REQUIRED,
    EVIDENCE_MATCHER_INVOCATION: EVIDENCE_MATCHER_INVOCATION,
    REASON: REASON,

    STATE_SUPPORT: Object.freeze({
      calibrationAuthoritySource: 'P3_SETTLEMENT_RECORD',
      reopensSettlementAuthority: 'NO',
      consumesOnlyCalibrationCountedTrue: 'YES',
      globalPredictionAccuracy: 'FORBIDDEN',
      crossPartitionConfidenceTransfer: 'FORBIDDEN',
      calibrationInputMustBeReachableFromP3: 'YES',
      multiDomainCalibrationPartitionV1: MULTI_DOMAIN_CALIBRATION_PARTITION_V1,
      exactlyOneAdmittedTargetDomainRequired: EXACTLY_ONE_ADMITTED_TARGET_DOMAIN_REQUIRED,
      reachabilityPrimitive: 'CONSUMED_FROM_P3_SETTLEMENT_CORE_NOT_DUPLICATED',
      capabilityCoverageIsOrthogonal: 'YES',
      compiledButDisabledIsNotRuntimeClassifiable: 'YES',
      runtimeClassifiableIsNotProductionSettleable: 'YES',
      capabilityGapReasonVocabulary: CAPABILITY_GAP_REASONS,
      calibrationConfidence: null,
      calibrationConfidenceBasis: 'NULL_BY_CONTRACT_NO_FROZEN_DERIVATION_RULE',
      noFormulaInventionToAvoidNull: 'YES',
      countsAreMechanical: 'YES',
      numericPeAggregation: 'FORBIDDEN',
      ordinalOnly: 'YES',
      calibrationAppliedToLive: 'NO',
      expectationWriteback: 'NONE',
      interpretationWriteback: 'NONE',
      memoryAuthority: 'NONE',
      relationshipAuthority: 'NONE',
      modelCalls: 0,
      durableWrites: 0,
      clockReads: 0,
      lifetime: 'SESSION_ONLY',
      disclosure: 'INTERNAL_AUDIT_ONLY'
    })
  };
});
