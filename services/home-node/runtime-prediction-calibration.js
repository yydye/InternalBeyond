'use strict';
/* ====================================================================
   IB Home Node · Prediction Calibration Ledger（Prediction Error P4）
   --------------------------------------------------------------------
   唯一职责：

     eligible SettlementRecord（calibrationCounted === true）
       → partition（predictionType × targetDomain）
       → 机械计数
       → 只读 ordinal summary

   ── 它**没有**的能力 ─────────────────────────────────────────────────
     settlement authority · observation authority · prediction authority ·
     memory authority · relationship authority · model authority。

   ── 硬规则 ───────────────────────────────────────────────────────────
     CALIBRATION_AUTHORITY_SOURCE = P3 SettlementRecord
     P4_REOPENS_SETTLEMENT_AUTHORITY = NO
       P3 说 calibrationCounted=false ⇒ P4 **不覆盖**。
     GLOBAL_PREDICTION_ACCURACY = FORBIDDEN
     CROSS_PARTITION_CONFIDENCE_TRANSFER = FORBIDDEN
     calibrationConfidence = null（契约冻结 · 无 hidden formula）
     CALIBRATION_LEDGER_LIFETIME = SESSION_ONLY · 纯进程内存 · **零** durable 写
     CALIBRATION_APPLIED_TO_LIVE = NO（**没有** applyToExpectation / writeback API）
     CALIBRATION_DISCLOSURE_V1 = INTERNAL_AUDIT_ONLY

   ── 与 P3 的关系 ─────────────────────────────────────────────────────
     合法的输入**不是**任何长得像结算的对象，而是 P3 模块用 module-private
     capability seal 铸造的 SettlementRecord。本模块调用 `isSettlementRecord()`
     做 provenance 校验 —— 纯对象 / JSON 克隆 / 另一个 loaded 实例一律拒绝。
   ==================================================================== */

const path = require('path');

const ASSETS_JS = path.join(__dirname, '..', '..', 'assets', 'js');
const DEFAULT_CORE = require(path.join(ASSETS_JS, 'memory-recall', 'prediction-calibration-core.js'));
const DEFAULT_SETTLEMENT_RUNTIME = require('./runtime-prediction-settlement.js');
const behaviorEffectRuntimeModule = require('./runtime-behavior-effect.js');

/* 有界持有者：与 Registry / Settlement 同一纪律（纯进程内存 · 会话内 · 有界）。 */
const MAX_PARTITIONS = 64;
const MAX_DEDUPE_ENTRIES = 1024;
const CALIBRATION_TTL_MS = 10 * 60 * 1000;
const HOLDER_SCOPE = 'predictionType+targetDomain';
const ENTRY = 'ingestSettlement';

const REASON = Object.freeze({
  coreMissing: 'prediction-calibration-core-missing',
  settlementRuntimeMissing: 'prediction-settlement-runtime-missing',
  notASettlementRecord: 'not-a-sealed-settlement-record',
  notCalibrationCounted: 'p3-says-not-calibration-counted',
  legacyResultForbidden: 'legacy-d2-result-is-not-a-ledger-key',
  partitionUnresolved: 'calibration-partition-unresolved',
  duplicateEntry: 'duplicate-settlement-entry',
  noInjectedTime: 'injected-time-missing',
  notFound: 'partition-not-found',
  ok: 'ok'
});

function isPlainObject(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
function text(v) { return v == null ? '' : String(v); }

function createRuntimePredictionCalibration(deps) {
  const d = deps || {};
  const core = d.core || DEFAULT_CORE;
  const settlementRuntime = d.settlementRuntime || DEFAULT_SETTLEMENT_RUNTIME;
  const clock = typeof d.clock === 'function' ? d.clock : null;
  const allowClockFallback = d.allowClockFallback === true;
  const maxPartitions = Number.isFinite(Number(d.maxPartitions)) && Number(d.maxPartitions) > 0
    ? Number(d.maxPartitions) : MAX_PARTITIONS;
  const maxDedupeEntries = Number.isFinite(Number(d.maxDedupeEntries)) && Number(d.maxDedupeEntries) > 0
    ? Number(d.maxDedupeEntries) : MAX_DEDUPE_ENTRIES;
  const ttlMs = Number.isFinite(Number(d.ttlMs)) && Number(d.ttlMs) > 0
    ? Number(d.ttlMs) : CALIBRATION_TTL_MS;
  /* reachability 权威：**只**来自 P3 settlement runtime 的共享 primitive。
     允许注入以便测试，但默认必须存在；缺席即 fail closed（拒绝一切 ingest）。 */
  const reachabilityFn = typeof d.reachability === 'function'
    ? d.reachability
    : (settlementRuntime && typeof settlementRuntime.calibrationReachability === 'function'
      ? settlementRuntime.calibrationReachability
      : null);
  /* capability 维度的唯一出处同样是 P3 core；R2 再加"语义分类是否**已启用**"。 */
  function policyAllowedFor(type) {
    return !!(settlementRuntime && typeof settlementRuntime.policyAllowsDecisiveSettlement === 'function'
      ? settlementRuntime.policyAllowsDecisiveSettlement(type)
      : (DEFAULT_SETTLEMENT_RUNTIME.policyAllowsDecisiveSettlement
        ? DEFAULT_SETTLEMENT_RUNTIME.policyAllowsDecisiveSettlement(type) : false));
  }
  function runtimeClassifiableFor(mode, predictionType) {
    var mechanically = !!(settlementRuntime && typeof settlementRuntime.runtimeCanClassifyMode === 'function'
      ? settlementRuntime.runtimeCanClassifyMode(mode)
      : false);
    if (mechanically) return { classifiable: true, reason: [] };
    /* statement 路径要看 matcher 是否**真的启用**（compiled 不够） */
    var subject = DEFAULT_SETTLEMENT_RUNTIME.SUBJECTIVE_DOMAINS || [];
    void subject;
    var matcherState = typeof d.matcherState === 'function'
      ? d.matcherState()
      : (d.matcherCapabilityPresent === true ? { present: true, enabled: d.matcherEnabled === true } : { present: false, enabled: false });
    if (matcherState.present && matcherState.enabled) return { classifiable: true, reason: [] };
    var reason = [];
    if (!matcherState.present) reason.push('matcher-not-present');
    else reason.push('matcher-disabled');
    if (!mechanically) reason.push('statement-relation-unavailable');
    void predictionType;
    return { classifiable: false, reason: reason };
  }
  /**
   * P5-B3-J-R1 · Authority availability comes only from the exact canonical
   * BehaviorEffect runtime injected by assembly. Query coverage and query status
   * are deliberately not consulted here.
   */
  function attributionAuthorityFor(predictionType) {
    void predictionType;
    try {
      return typeof behaviorEffectRuntimeModule.isCanonicalBehaviorEffectAttributionAuthority === 'function'
        && behaviorEffectRuntimeModule.isCanonicalBehaviorEffectAttributionAuthority(d.attributionAuthority) === true;
    } catch (_) {
      return false;   /* missing, wrong-module, or unreachable authority fails closed */
    }
  }

  /* partitionKey → partition state */
  const partitions = new Map();
  /* capability 维度缓存（key = type \0 mode），避免每次 summary 重复查表 */
  const coverageDims = new Map();
  /* 有界 dedupe 索引（**不是**无界 Set） */
  const dedupe = new Map();
  const dedupeOrder = [];
  const partitionOrder = [];

  const counters = {
    attempts: 0, ingested: 0, rejectedProvenance: 0, rejectedNotCounted: 0,
    rejectedLegacy: 0, rejectedReachability: 0, rejectedPartition: 0, duplicates: 0,
    partitionsCreated: 0, partitionsEvicted: 0, dedupeEvictions: 0, ttlEvicted: 0,
    multiDomainSettlements: 0, unreachableCombinations: 0,
    modelCalls: 0, durableWrites: 0, memoryWrites: 0, relationshipWrites: 0,
    expectationWrites: 0, interpretationWrites: 0, calibrationWrites: 0
  };

  function nowFrom(ctx) {
    const n = Number(ctx && ctx.now);
    if (Number.isFinite(n) && n > 0) return n;
    if (allowClockFallback && clock) {
      try { const c = Number(clock()); if (Number.isFinite(c) && c > 0) return c; } catch (e) { /* ignore */ }
    }
    return null;
  }

  function newPartition(partition, now) {
    return {
      partitionKey: partition.key,
      predictionType: partition.predictionType,
      targetDomain: partition.targetDomain,
      contradictionMode: '',
      counts: core.emptyCounts(),
      errorCounts: core.emptyErrorCounts(),
      unclassifiableObservations: 0,
      firstSeenAt: now,
      lastSeenAt: now,
      entryIds: []
    };
  }

  function sweep(now) {
    for (const key of Array.from(partitions.keys())) {
      const p = partitions.get(key);
      if (!p || !Number.isFinite(Number(p.lastSeenAt))) continue;
      if ((now - Number(p.lastSeenAt)) > ttlMs) {
        partitions.delete(key);
        counters.ttlEvicted += 1;
      }
    }
    /* dedupe 索引与 partition 生命周期一致：partition 没了，它的 entry 也应过期 */
    for (const key of Array.from(dedupe.keys())) {
      const e = dedupe.get(key);
      if (!e) { dedupe.delete(key); continue; }
      if (!partitions.has(e.partitionKey)) { dedupe.delete(key); counters.dedupeEvictions += 1; continue; }
      if ((now - Number(e.at)) > ttlMs) { dedupe.delete(key); counters.dedupeEvictions += 1; }
    }
  }
  function evictPartitions() {
    while (partitions.size > maxPartitions && partitionOrder.length) {
      const oldest = partitionOrder.shift();
      if (partitions.has(oldest)) { partitions.delete(oldest); counters.partitionsEvicted += 1; }
    }
  }
  function evictDedupe() {
    while (dedupe.size > maxDedupeEntries && dedupeOrder.length) {
      const oldest = dedupeOrder.shift();
      if (dedupe.has(oldest)) { dedupe.delete(oldest); counters.dedupeEvictions += 1; }
    }
  }

  /* ── 唯一入口 ─────────────────────────────────────────────────────── */
  /**
   * ingestSettlement(settlement, ctx)
   *   入口顺序（即权威顺序）：
   *     ① provenance（module-private capability seal）
   *     ② P3 的 calibrationCounted === true（**唯一**硬入口）
   *     ③ partition 解析
   *     ④ 幂等（calibrationEntryId）
   *     ⑤ 计数
   */
  function ingestSettlement(settlement, ctx) {
    const c = isPlainObject(ctx) ? ctx : {};
    counters.attempts += 1;

    if (!core) return { ok: false, status: 'refused', reasonCode: REASON.coreMissing };
    if (!settlementRuntime || typeof settlementRuntime.isSettlementRecord !== 'function') {
      return { ok: false, status: 'refused', reasonCode: REASON.settlementRuntimeMissing };
    }

    /* ① provenance：只有 P3 模块 seal 过的记录才算合法输入 */
    if (!settlementRuntime.isSettlementRecord(settlement)) {
      counters.rejectedProvenance += 1;
      return { ok: false, status: 'rejected', reasonCode: REASON.notASettlementRecord };
    }

    /* legacy D.2 结果词表绝不能成为 ledger key */
    if (core.LEGACY_D2_RESULTS.indexOf(text(settlement.state)) >= 0) {
      counters.rejectedLegacy += 1;
      return { ok: false, status: 'rejected', reasonCode: REASON.legacyResultForbidden };
    }

    const now = nowFrom(c);
    if (now == null) return { ok: false, status: 'refused', reasonCode: REASON.noInjectedTime };
    sweep(now);

    /* ② calibrationCounted 是**唯一**硬入口；P4 没有 authority 重开 P3 */
    const eligibility = core.entryEligibility(settlement, { settlementRecord: true });
    if (!eligibility.eligible) {
      counters.rejectedNotCounted += 1;
      return {
        ok: false, status: 'rejected',
        reasonCode: eligibility.reasonCodes[0] || REASON.notCalibrationCounted,
        reasonCodes: eligibility.reasonCodes
      };
    }

    /* ③ P3-reachability：这个组合**是否可能**由当前 frozen P3 policy 合法产生？
       —— 这不是推翻 P3 authority，而是防 buggy P3 / test-only 伪造路径 /
          未来 policy drift 污染 Ledger。权威来自 P3 core 的共享 primitive。 */
    const partitionCheck = core.partitionResolution(settlement);
    if (partitionCheck.domainCount > 1) counters.multiDomainSettlements += 1;
    const reach = reachabilityFn({
      predictionType: core.predictionTypeOf(settlement),
      /* `targetDomainOf` 对多域返回 'mixed-domains'、零域返回 '' ⇒ reachability 能
         给出**规范** reasonCode（multi-domain vs no-domain），而不是都塌成一种。 */
      targetDomain: core.targetDomainOf(settlement),
      settlementState: text(settlement.state),
      calibrationCounted: settlement.calibrationCounted === true,
      contradictionMode: core.contradictionModeOf(settlement)
    });
    if (!reach || reach.reachable !== true) {
      counters.rejectedReachability += 1;
      counters.unreachableCombinations += 1;
      return {
        ok: false, status: 'rejected',
        reasonCode: (reach && reach.reasonCode) || REASON.notReachable,
        reachability: reach || null, changed: false,
        diagnosticsOnly: true, participatesInCalibrationCounts: false
      };
    }

    /* ④ partition 解析：**恰好一个** admitted target domain 是硬前提（R3） */
    if (!partitionCheck.ok) {
      counters.rejectedPartition += 1;
      return {
        ok: false, status: 'rejected',
        reasonCode: partitionCheck.reasonCode,
        domainCount: partitionCheck.domainCount, domains: partitionCheck.domains,
        changed: false, diagnosticsOnly: true, participatesInCalibrationCounts: false
      };
    }
    const partition = partitionCheck.partition;
    const entryId = core.calibrationEntryId(settlement, partition);

    /* ⑤ 幂等：同一个 SettlementRecord 至多被统计一次 */
    if (dedupe.has(entryId)) {
      counters.duplicates += 1;
      return {
        ok: true, status: 'duplicate', reasonCode: REASON.duplicateEntry,
        partitionKey: partition.key, entryId: entryId, changed: false
      };
    }

    /* ⑤ 计数（纯机械，无加权） */
    let p = partitions.get(partition.key);
    if (!p) {
      p = newPartition(partition, now);
      partitions.set(partition.key, p);
      partitionOrder.push(partition.key);
      counters.partitionsCreated += 1;
    }
    p.lastSeenAt = now;
    p.contradictionMode = core.contradictionModeOf(settlement) || p.contradictionMode;
    p.counts = core.applyCounts(p.counts, text(settlement.state));
    const trace = isPlainObject(settlement.trace) ? settlement.trace : {};
    p.unclassifiableObservations += Number(trace.unclassifiable) || 0;

    /* ordinal PE bucket 累加：只加 1，绝不加权 */
    const pe = isPlainObject(c.predictionError) ? c.predictionError : null;
    if (pe) {
      p.errorCounts = core.applyPredictionError(p.errorCounts, pe.direction, pe.magnitude);
    } else if (c.predictionErrorRecord) {
      p.errorCounts = core.applyPredictionError(
        p.errorCounts, c.predictionErrorRecord.direction, c.predictionErrorRecord.magnitude);
    }

    if (p.entryIds.length < 128) p.entryIds.push(entryId);
    dedupe.set(entryId, { partitionKey: partition.key, at: now });
    dedupeOrder.push(entryId);
    counters.ingested += 1;
    evictPartitions();
    evictDedupe();

    return {
      ok: true, status: 'ingested', reasonCode: REASON.ok,
      partitionKey: partition.key, entryId: entryId, changed: true,
      state: text(settlement.state),
      counts: Object.assign({}, p.counts)
    };
  }

  /* ── 只读查询 ─────────────────────────────────────────────────────── */
  function summaryOf(p) {
    if (!p) return null;
    const cacheKey = p.predictionType + '\u0000' + p.contradictionMode;
    let dims = coverageDims.get(cacheKey);
    if (!dims) {
      const rc = runtimeClassifiableFor(p.contradictionMode, p.predictionType);
      dims = {
        policyAllowed: policyAllowedFor(p.predictionType),
        runtimeClassifiable: rc.classifiable,
        capabilityGapReason: rc.reason.slice(),
        attributionAuthorityAvailable: attributionAuthorityFor(p.predictionType)
      };
      coverageDims.set(cacheKey, dims);
    }
    return core.calibrationSummary({
      predictionType: p.predictionType,
      contradictionMode: p.contradictionMode,
      partitionKey: p.partitionKey,
      counts: p.counts,
      errorCounts: p.errorCounts,
      policyAllowed: dims.policyAllowed,
      runtimeClassifiable: dims.runtimeClassifiable,
      capabilityCoverage: core.capabilityCoverage({
        predictionType: p.predictionType,
        contradictionMode: p.contradictionMode,
        counts: p.counts,
        policyAllowed: dims.policyAllowed,
        runtimeClassifiable: dims.runtimeClassifiable,
        attributionAuthorityAvailable: dims.attributionAuthorityAvailable,
        capabilityGapReason: dims.capabilityGapReason,
        unclassifiableObservations: p.unclassifiableObservations
      })
    });
  }
  function getPartition(predictionType, targetDomain) {
    const key = text(predictionType) + '\u0000' + text(targetDomain);
    return summaryOf(partitions.get(key));
  }
  function listPartitions() {
    const out = [];
    for (const p of partitions.values()) out.push(summaryOf(p));
    return out;
  }

  /**
   * 审计视图。**只**给内部：没有路由、没有 UI、没有 prompt。
   * `calibrationConfidence` 恒为 null；没有 accuracy / hitRate / probability。
   */
  function inspectCalibration() {
    const list = listPartitions();
    return {
      ok: true,
      view: {
        schemaVersion: core.SCHEMA_VERSION,
        idLifetime: core.ID_LIFETIME,
        disclosure: 'INTERNAL_AUDIT_ONLY',
        canonicalCountsName: core.CANONICAL_COUNTS_NAME,
        partitionCount: list.length,
        partitions: list.map(s => ({
          partitionKey: s.partitionKey,
          predictionType: s.predictionType,
          targetDomain: s.partitionKey ? s.partitionKey.split('\u0000')[1] : null,
          calibrationCounts: s.calibrationCounts,
          sampleStatus: s.sampleStatus,
          capabilityStatus: s.capabilityCoverage.status,
          runtimeClassifiable: s.capabilityCoverage.runtimeClassifiable,
          capabilityCoverage: s.capabilityCoverage,
          calibrationConfidence: s.calibrationConfidence,
          predictionErrorBuckets: s.predictionErrorBuckets
        })),
        /* **只用于审计**：不是任何 confidence 的输入，也不参与 calibrationCounts */
        diagnostics: {
          diagnosticOnly: true,
          participatesInConfidence: false,
          participatesInCalibrationCounts: false,
          attributionAuthorityAvailable: attributionAuthorityFor(null),
          attributionAuthorityAvailabilityMeans: 'CANONICAL_RUNTIME_AUTHORITY_CONSTRUCTED_AND_REACHABLE',
          globalEligibleCount: list.reduce((n, s) => n + s.calibrationCounts.eligibleTotal, 0),
          multiDomainSettlementCount: counters.multiDomainSettlements,
          unresolvablePartitionCount: counters.rejectedPartition,
          unreachableCombinationCount: counters.unreachableCombinations,
          trackedEntries: dedupe.size,
          counters: Object.assign({}, counters)
        }
      }
    };
  }

  function describe() {
    return {
      status: 'LIVE_CAPABLE',
      entry: ENTRY,
      routes: 'NONE',
      browserVisible: 'NO',
      contentExposed: 'NO',
      disclosure: 'INTERNAL_AUDIT_ONLY',
      lifetime: 'SESSION_ONLY',
      durable: false,
      durableWrites: 0,
      crossRestartExactlyOnce: 'NO',
      restartRecovery: 'NONE',
      processMemoryOnly: true,

      calibrationAuthoritySource: 'P3_SETTLEMENT_RECORD',
      reopensSettlementAuthority: 'NO',
      consumesOnlyCalibrationCountedTrue: 'YES',
      provenanceRequiresModulePrivateSeal: 'YES',

      globalPredictionAccuracy: 'FORBIDDEN',
      crossPartitionConfidenceTransfer: 'FORBIDDEN',
      partitionKeyFields: ['predictionType', 'targetDomain'],
      /* P4-R1 · reachability：权威来自 P3 core 的共享 primitive，**不**复制 policy */
      calibrationInputMustBeReachableFromP3: 'YES',
      reachabilityAuthority: 'P3_SETTLEMENT_CORE_SHARED_PRIMITIVE',
      duplicatedPolicyTable: 'NONE',
      reJudgesSettlement: 'NO',
      multiDomainCalibrationPartitionV1: 'FORBIDDEN',
      exactlyOneAdmittedTargetDomainRequired: 'YES',
      capabilityCoverageIsOrthogonal: 'YES',
      productionSettleableFormula: core.STATE_SUPPORT.productionSettleableFormula,
      runtimeClassifiableIncludesPolicyAllowed: 'NO',
      productionSettleableIsSampleDependent: 'NO',
      compiledButDisabledIsNotRuntimeClassifiable: 'YES',
      runtimeClassifiableIsNotProductionSettleable: 'YES',
      attributionAuthorityAvailable: attributionAuthorityFor(null),
      attributionAuthorityAvailabilityMeans: 'CANONICAL_RUNTIME_AUTHORITY_CONSTRUCTED_AND_REACHABLE',
      authorityAvailabilityIsAttributionCoverage: 'NO',
      authorityAvailabilityIsSampleEligibility: 'NO',
      authorityAvailabilityIsCalibrationConfidence: 'NO',
      capabilityGapReasonVocabulary: core.CAPABILITY_GAP_REASONS,

      canonicalCountsName: core.CANONICAL_COUNTS_NAME,
      deprecatedAlias: core.DEPRECATED_ALIAS,
      legacyResultAdapter: core.LEGACY_RESULT_ADAPTER,
      countsMechanical: 'YES',
      numericPeAggregation: 'FORBIDDEN',

      calibrationConfidence: core.CALIBRATION_CONFIDENCE,
      calibrationConfidenceBasis: 'NULL_BY_CONTRACT_NO_FROZEN_DERIVATION_RULE',
      noFormulaInventionToAvoidNull: 'YES',

      calibrationAppliedToLive: 'NO',
      expectationWriteback: 'NONE',
      interpretationWriteback: 'NONE',
      memoryAuthority: 'NONE',
      relationshipAuthority: 'NONE',
      modelCalls: 0,

      exactlyOncePerSettlement: 'YES_WITHIN_BOUNDED_LEDGER_WINDOW',
      holder: {
        maxPartitions: maxPartitions,
        maxDedupeEntries: maxDedupeEntries,
        ttlMs: ttlMs,
        scope: HOLDER_SCOPE,
        durability: 'NONE',
        currentPartitions: partitions.size,
        currentDedupeEntries: dedupe.size
      },
      counters: Object.assign({}, counters)
    };
  }

  function heldEntryCount() { return dedupe.size; }
  function heldPartitionCount() { return partitions.size; }

  return {
    ENTRY: ENTRY,
    ingestSettlement: ingestSettlement,
    getPartition: getPartition,
    listPartitions: listPartitions,
    inspectCalibration: inspectCalibration,
    describe: describe,
    heldEntryCount: heldEntryCount,
    heldPartitionCount: heldPartitionCount,
    awaitIdle: function () { return Promise.resolve({ idle: true, inFlight: 0 }); }
  };
}

module.exports = {
  createRuntimePredictionCalibration: createRuntimePredictionCalibration,
  MAX_PARTITIONS: MAX_PARTITIONS,
  MAX_DEDUPE_ENTRIES: MAX_DEDUPE_ENTRIES,
  CALIBRATION_TTL_MS: CALIBRATION_TTL_MS,
  HOLDER_SCOPE: HOLDER_SCOPE,
  REASON: REASON
};
