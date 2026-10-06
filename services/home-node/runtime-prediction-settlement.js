'use strict';
/* ====================================================================
   IB Home Node · Prediction Settlement Engine（Prediction Error P3）
   --------------------------------------------------------------------
   唯一职责：**消费**已经冻结的 PredictionRecord 与已经过 authority gate 的
   OutcomeObservation，确定性地产出：

     SettlementRecord（七状态之一 · sealed · 内部审计）
     PredictionErrorRecord（ordinal only · metric 恒 null）

   ── 它**没有**的能力 ─────────────────────────────────────────────────
     model authority · prediction-type authority · observation authority ·
     memory authority · relationship authority · provider authority。

   ── 硬规则 ───────────────────────────────────────────────────────────
     SETTLEMENT_ONCE = YES · REOPEN = NO_V1 · RESETTLEMENT = REJECTED
     POST_WINDOW_RETRO_SETTLE = NO
     LEGACY_RESULT_ADAPTER = NONE（绝不产出 confirmed/contradicted/…）
     CALIBRATION_WRITEBACK = NONE（只算计数资格，**不**写回任何东西）
     SETTLEMENT_DISCLOSURE_V1 = INTERNAL_AUDIT_ONLY
     MEMORY_WRITE / RELATIONSHIP_WRITE = FORBIDDEN

   ── 与 P1 的关系 ─────────────────────────────────────────────────────
     authority **不是**在这里重判的：本模块与 authority 面**共享同一个**
     loaded core instance（同进程 require ⇒ 同实例），只消费其 gate 输出。
   ==================================================================== */

const path = require('path');

const ASSETS_JS = path.join(__dirname, '..', '..', 'assets', 'js');
const DEFAULT_CORE = require(path.join(ASSETS_JS, 'memory-recall', 'prediction-settlement-core.js'));
const DEFAULT_OBSERVATION_CORE = require(path.join(ASSETS_JS, 'memory-recall', 'outcome-observation-core.js'));
/* P5-B · 纯 matcher 核心（只用来问"是否需要语义分类"），**不**持有任何权威。 */
const MATCHER_CORE = require(path.join(ASSETS_JS, 'memory-recall', 'evidence-match-core.js'));

/* 有界持有者：与其它 runtime 同一纪律（64 条 / 10 分钟 / 纯进程内存）。 */
const MAX_HELD_SETTLEMENTS = 64;
const SETTLEMENT_TTL_MS = 10 * 60 * 1000;
const HOLDER_SCOPE = 'predictionId';
const ENTRY = 'settlePrediction';

const REASON = Object.freeze({
  coreMissing: 'prediction-settlement-core-missing',
  observationCoreMissing: 'outcome-observation-core-missing',
  predictionInvalid: 'prediction-record-invalid',
  predictionMissing: 'prediction-missing',
  alreadySettled: 'already-settled',
  noInjectedTime: 'injected-time-missing',
  notFound: 'settlement-not-found',
  gateMismatch: 'caller-supplied-gate-mismatch',
  gateNotComputed: 'authority-gate-not-computed'
});

/* ── Settlement capability seal（module-private · **module 级**）─────────
   P4 不能只凭 `{ state:'matched', calibrationCounted:true }` 这种普通对象
   进入统计 —— 那等于让任何人自证权威。合法性的唯一来源是本模块铸造的记录。

   与 P1 的 observation capability 同一纪律：
     · WeakSet 身份表（**只有**本模块 seal 过的对象在里面）
     · WeakMap 封存（brand + canonicalize 指纹）⇒ 事后篡改也会被发现
     · 双保险：deepFreeze
   ★ 身份表是 **module 级**而不是 factory 级：同一个 loaded 模块铸造的记录
     都应该被同一进程内的消费方认可（SAME_MODULE_INSTANCE_REQUIRED），
     而**另一个** loaded 实例（JSON 克隆 / 另一个进程）必然被拒。 */
const SETTLEMENT_IDENTITY = new WeakSet();
const SETTLEMENT_SEAL = new WeakMap();
const PREDICTION_ERROR_IDENTITY = new WeakSet();
const PREDICTION_ERROR_SEAL = new WeakMap();
const SETTLEMENT_BRAND = 'ib.settlement-record.v1';
const PREDICTION_ERROR_BRAND = 'ib.prediction-error-record.v1';

function fingerprintOf(value) {
  try {
    if (DEFAULT_CORE && typeof DEFAULT_CORE.canonicalize === 'function') return DEFAULT_CORE.canonicalize(value);
  } catch (e) { /* fall through */ }
  try { return JSON.stringify(value); } catch (e) { return null; }
}
function sealWith(identity, seal, brand, record) {
  identity.add(record);
  seal.set(record, Object.freeze({ brand: brand, fingerprint: fingerprintOf(record) }));
  return record;
}
function verifyWith(identity, seal, brand, shape, x) {
  if (!x || typeof x !== 'object') return false;
  if (!identity.has(x)) return false;            /* 不是本模块铸造的 */
  if (!Object.isFrozen(x)) return false;         /* 必须 sealed */
  const s = seal.get(x);
  if (!s || s.brand !== brand) return false;
  if (typeof shape === 'function' && shape(x) !== true) return false;
  /* 篡改检测：任何字段变化都会改变指纹 */
  return fingerprintOf(x) === s.fingerprint;
}
function settlementShape(x) {
  return typeof x.settlementId === 'string' && x.settlementId.indexOf('stl_') === 0
    && typeof x.predictionId === 'string'
    && DEFAULT_CORE.SETTLEMENT_STATES.indexOf(x.state) >= 0
    && typeof x.calibrationCounted === 'boolean';
}
function predictionErrorShape(x) {
  return typeof x.predictionErrorId === 'string' && x.predictionErrorId.indexOf('perr_') === 0
    && typeof x.settlementId === 'string'
    && DEFAULT_CORE.SETTLEMENT_STATES.indexOf(x.settlementState) >= 0
    && x.predictionErrorMetric === null;
}

/** 只有本模块 seal 过、仍然冻结、且未被篡改的 SettlementRecord 才是真的。 */
function isSettlementRecord(x) {
  return verifyWith(SETTLEMENT_IDENTITY, SETTLEMENT_SEAL, SETTLEMENT_BRAND, settlementShape, x);
}
function isPredictionErrorRecord(x) {
  return verifyWith(PREDICTION_ERROR_IDENTITY, PREDICTION_ERROR_SEAL, PREDICTION_ERROR_BRAND, predictionErrorShape, x);
}
function recordProvenance(x) {
  return {
    settlementRecord: isSettlementRecord(x),
    sealAuthority: 'MODULE_PRIVATE_CAPABILITY',
    brand: SETTLEMENT_BRAND
  };
}

/**
 * P4-R1 · 把 P3 core 的 reachability primitive **绑定**上 authority matrix。
 *   ⇒ P4 只调用它，**不**复制 policy 表，也**不**重新结算。
 *   这是 "one policy table, multiple consumers" 的唯一消费者入口。
 */
function calibrationReachability(input) {
  if (!DEFAULT_CORE || typeof DEFAULT_CORE.calibrationReachability !== 'function') {
    return { reachable: false, class: 'unavailable', reasonCode: 'prediction-settlement-core-missing' };
  }
  var merged = Object.assign({}, input || {});
  if (!merged.authorityMatrix && DEFAULT_OBSERVATION_CORE) {
    merged.authorityMatrix = DEFAULT_OBSERVATION_CORE.AUTHORITY_MATRIX;
  }
  if (!merged.statementOnlyDomains && DEFAULT_OBSERVATION_CORE) {
    merged.statementOnlyDomains = DEFAULT_OBSERVATION_CORE.SUBJECTIVE_DOMAINS;
  }
  return DEFAULT_CORE.calibrationReachability(merged);
}

function isPlainObject(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
function text(v) { return v == null ? '' : String(v); }
function bounded(v, n) { return text(v).slice(0, n || 200); }
function stableTokenLike(seed) {
  let s = text(seed), h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = (h1 ^ c) >>> 0;
    h1 = (h1 + ((h1 << 1) + (h1 << 4) + (h1 << 7) + (h1 << 8) + (h1 << 24))) >>> 0;
    h2 = ((h2 ^ c) * 16777619) >>> 0;
  }
  return (h1.toString(36) + h2.toString(36)).slice(0, 12);
}
function deepFreeze(v) {
  if (!v || typeof v !== 'object' || Object.isFrozen(v)) return v;
  Object.freeze(v);
  Object.keys(v).forEach((k) => deepFreeze(v[k]));
  return v;
}

function createRuntimePredictionSettlement(deps) {
  const d = deps || {};
  const core = d.core || DEFAULT_CORE;
  const observationCore = d.observationCore || DEFAULT_OBSERVATION_CORE;
  /* P5-B · Evidence Matcher（可选注入；缺席 ⇒ statement 保持 unclassifiable） */
  const evidenceMatcher = d.evidenceMatcher || null;
  const clock = typeof d.clock === 'function' ? d.clock : null;
  const allowClockFallback = d.allowClockFallback === true;
  const maxEntries = Number.isFinite(Number(d.maxEntries)) && Number(d.maxEntries) > 0
    ? Number(d.maxEntries) : MAX_HELD_SETTLEMENTS;
  const ttlMs = Number.isFinite(Number(d.ttlMs)) && Number(d.ttlMs) > 0
    ? Number(d.ttlMs) : SETTLEMENT_TTL_MS;

  /* predictionId → { settlement, error } —— **一个 prediction 至多一条终态记录** */
  const held = new Map();
  const order = [];
  const counters = {
    attempts: 0, settled: 0, alreadySettled: 0, refused: 0,
    superseded: 0, matched: 0, missed: 0, mixed: 0,
    expiredUnobserved: 0, unresolvable: 0, pending: 0,
    calibrationEligible: 0, evicted: 0, expired: 0,
    matcherAttempts: 0, matcherCalls: 0, matcherFailures: 0,
    matcherSkippedMechanical: 0, matcherSkippedPolicy: 0,
    providerCalls: 0, durableWrites: 0, memoryWrites: 0, relationshipWrites: 0, calibrationWrites: 0
  };

  function nowFrom(ctx) {
    const n = Number(ctx && ctx.now);
    if (Number.isFinite(n) && n > 0) return n;
    if (allowClockFallback && clock) {
      try { const c = Number(clock()); if (Number.isFinite(c) && c > 0) return c; } catch (e) { /* ignore */ }
    }
    return null;
  }
  function sweep(now) {
    for (const key of Array.from(held.keys())) {
      const rec = held.get(key);
      const at = rec && Number(rec.settledAt);
      if (!Number.isFinite(at)) continue;
      if ((now - at) > ttlMs) { held.delete(key); counters.expired += 1; }
    }
  }
  function evictOverflow() {
    while (held.size > maxEntries && order.length) {
      const oldest = order.shift();
      if (held.has(oldest)) { held.delete(oldest); counters.evicted += 1; }
    }
  }
  function bump(state) {
    if (state === 'matched') counters.matched += 1;
    else if (state === 'missed') counters.missed += 1;
    else if (state === 'mixed') counters.mixed += 1;
    else if (state === 'expired_unobserved') counters.expiredUnobserved += 1;
    else if (state === 'unresolvable') counters.unresolvable += 1;
    else if (state === 'superseded') counters.superseded += 1;
    else if (state === 'pending') counters.pending += 1;
  }

  /* ── 唯一结算入口 ─────────────────────────────────────────────────── */
  /**
   * settlePrediction(predictionRecord, observations, ctx)
   *   observations —— [ { observation, gate? } ]
   *     若给了 gate，本模块会**重算**一次并要求与调用方给的一致（防伪造）；
   *     若没给，本模块用**同一个** authority core 实例算出来。
   *     ⇒ authority 只被**消费**，从不被重新发明。
   */
  function settlePrediction(predictionRecord, observations, ctx) {
    return doSettle(predictionRecord, observations, ctx, []);
  }

  /**
   * P5-B · 唯一 matcher-aware 入口。
   *   ① 先算 authority gate（与同步路径**同一套**确定性判定）
   *   ② 只对"gate 允许 + 机械分类做不到"的 statement observation 调用 matcher
   *   ③ 把 sealed EvidenceMatch 的 **relation** 交给同一个核心
   * ★ EvidenceMatch **只**提供 semantic relation；source / domain /
   *   predictionType / admissibility / opportunity / 结算状态全部照旧重判。
   * ★ 公开 API 上**没有**注入 relation 的路径 —— 同步 `settlePrediction` 恒传空数组。
   */
  async function settlePredictionWithEvidenceMatcher(predictionRecord, observations, ctx) {
    const c = isPlainObject(ctx) ? ctx : {};
    const matcher = c.evidenceMatcher || evidenceMatcher;
    const incoming = Array.isArray(observations) ? observations : [];
    const matches = [];
    if (matcher && typeof matcher.matchRelation === 'function') {
      const p = isPlainObject(predictionRecord) ? predictionRecord : null;
      const expectedScope = p && isPlainObject(p.scope) ? p.scope : null;
      for (let i = 0; i < incoming.length; i++) {
        const entry = isPlainObject(incoming[i]) ? incoming[i] : null;
        const obs = entry && isPlainObject(entry.observation) ? entry.observation : null;
        if (!obs || !observationCore || typeof observationCore.authorityGate !== 'function') continue;
        let gate = null;
        try { gate = observationCore.authorityGate(obs, { expectedScope: expectedScope, opportunity: c.opportunity || null }); }
        catch (e) { gate = null; }
        if (!gate || gate.ok !== true) continue;
        /* gate 判定（确定性、纯函数）：两个方向都不被允许 ⇒ 不必花模型调用 */
        const dir = gate.gateTrace.directional || {};
        const admissibleEither = text(dir.support) === 'ELIGIBLE' || text(dir.conflict) === 'ELIGIBLE';
        if (!admissibleEither) { counters.matcherSkippedPolicy += 1; continue; }
        /* 机械可判 ⇒ 0 次调用 */
        const need = MATCHER_CORE && typeof MATCHER_CORE.needsEvidenceMatcher === 'function'
          ? MATCHER_CORE.needsEvidenceMatcher(p, obs)
          : { needed: true };
        if (!need.needed) { counters.matcherSkippedMechanical += 1; continue; }
        let res = null;
        try {
          res = await matcher.matchRelation(p, obs, { characterId: c.characterId });
        } catch (e) { res = null; }
        counters.matcherAttempts += 1;
        if (res && res.called) counters.matcherCalls += 1;
        if (res && res.match && typeof matcher.isEvidenceMatch === 'function' && matcher.isEvidenceMatch(res.match)) {
          matches.push({ observationId: text(obs.observationId), relation: text(res.match.relation) });
        } else {
          counters.matcherFailures += 1;
        }
      }
    }
    return doSettle(predictionRecord, observations, c, matches);
  }

  function doSettle(predictionRecord, observations, ctx, evidenceMatches) {
    const c = isPlainObject(ctx) ? ctx : {};
    counters.attempts += 1;
    if (!core || typeof core.computeSettlement !== 'function') {
      counters.refused += 1;
      return { ok: false, status: 'refused', reasonCode: REASON.coreMissing, settlement: null, predictionError: null };
    }
    const p = isPlainObject(predictionRecord) ? predictionRecord : null;
    if (!p) {
      counters.refused += 1;
      return { ok: false, status: 'refused', reasonCode: REASON.predictionMissing, settlement: null, predictionError: null };
    }

    /* SETTLEMENT_ONCE：同一 predictionId 已经有终态记录 ⇒ 直接返回，**不**重算 */
    const existing = held.get(text(p.predictionId));
    if (existing && existing.settlement && existing.settlement.lifecycleState === 'settled') {
      counters.alreadySettled += 1;
      return {
        ok: true, status: 'already-settled', reasonCode: REASON.alreadySettled,
        settlement: existing.settlement, predictionError: existing.error, providerCalls: 0
      };
    }

    const now = nowFrom(c);
    if (now == null) {
      counters.refused += 1;
      return { ok: false, status: 'refused', reasonCode: REASON.noInjectedTime, settlement: null, predictionError: null };
    }
    sweep(now);

    /* ── T1–T6 · 消费 authority gate（不重判）──────────────────────── */
    const incoming = Array.isArray(observations) ? observations : [];
    const gated = [];
    for (let i = 0; i < incoming.length; i++) {
      const entry = isPlainObject(incoming[i]) ? incoming[i] : null;
      const obs = entry && isPlainObject(entry.observation) ? entry.observation : null;
      if (!obs) continue;
      const expectedScope = isPlainObject(p.scope) ? p.scope : null;
      const opportunity = c.opportunity || null;
      let gate = null;
      if (observationCore && typeof observationCore.authorityGate === 'function') {
        try { gate = observationCore.authorityGate(obs, { expectedScope: expectedScope, opportunity: opportunity }); }
        catch (e) { gate = null; }
      }
      if (!gate) {
        counters.refused += 1;
        return { ok: false, status: 'refused', reasonCode: REASON.gateNotComputed, settlement: null, predictionError: null };
      }
      /* 调用方若自带 gate，必须与权威面逐字段一致（防伪造），否则拒绝整次结算 */
      if (entry.gate != null) {
        const supplied = isPlainObject(entry.gate) ? entry.gate : null;
        const same = supplied
          && text(supplied.effectiveAdmissibility) === text(gate.gateTrace.effectiveAdmissibility)
          && text(supplied.directional && supplied.directional.support) === text(gate.gateTrace.directional.support)
          && text(supplied.directional && supplied.directional.conflict) === text(gate.gateTrace.directional.conflict)
          && text(supplied.opportunityGate) === text(gate.gateTrace.opportunityGate);
        if (!same) {
          counters.refused += 1;
          return { ok: false, status: 'refused', reasonCode: REASON.gateMismatch, settlement: null, predictionError: null };
        }
      }
      gated.push({ observation: obs, gate: gate.gateTrace });    }

    /* ── T0 / T7 / T8 · 纯核心决定状态 ─────────────────────────────── */
    const computed = core.computeSettlement({
      prediction: p,
      observations: gated,
      now: now,
      snapshotAtSettlement: c.snapshotAtSettlement,
      supersededByNewer: c.supersededByNewer === true,
      /* P5-B：**只**有 semantic relation 从这里进入；其余 authority 照旧重判 */
      evidenceMatches: evidenceMatches || []
    });
    if (!computed || computed.ok !== true) {
      counters.refused += 1;
      return {
        ok: false, status: 'refused',
        reasonCode: (computed && computed.reasonCodes && computed.reasonCodes[0]) || REASON.predictionInvalid,
        settlement: null, predictionError: null, reasonCodes: computed ? computed.reasonCodes : []
      };
    }

    const settlementId = 'stl_' + stableTokenLike([
      text(p.predictionId), text(p.registrySessionRef), String(now), text(computed.state)
    ].join('|'));

    const settlement = {
      schemaVersion: core.SCHEMA_VERSION,
      settlementId: settlementId,
      predictionId: text(p.predictionId),
      registrySessionRef: p.registrySessionRef == null ? null : text(p.registrySessionRef),
      idLifetime: core.ID_LIFETIME,

      state: computed.state,
      lifecycleState: computed.lifecycleState,

      /* 判定一律以 **creation** 快照为基准；settlement 快照只作审计 */
      predictionSnapshotAtCreation: p.predictionSnapshotAtCreation,
      predictionSnapshotAtSettlement: p.predictionSnapshotAtCreation,
      revisionDetected: computed.revisionDetected === true,

      settledAt: now,
      observationWindow: p.observationWindow,
      opportunityState: computed.opportunityState,

      evidenceRefs: (computed.evidenceRefs || []).slice(0, 32),
      observationRefs: (computed.observationRefs || []).slice(0, 32),
      gateTraceRefs: (computed.gateTraceRefs || []).slice(0, 32),
      /* P4 · 分区键的第二个维度：**被采纳**观察的 targetDomain。
         全部一致 ⇒ 就是它；不一致 ⇒ 'mixed-domains'（不静默挑一个）。 */
      admittedTargetDomains: (computed.admittedTargetDomains || []).slice(0, 8),

      supportSummary: {
        decisive: computed.counts.supportDecisive,
        nonDecisive: computed.counts.supportNonDecisive,
        total: computed.counts.supportAll,
        threshold: computed.counts.supportThreshold
      },
      conflictSummary: {
        decisive: computed.counts.conflictDecisive,
        nonDecisive: computed.counts.conflictNonDecisive,
        total: computed.counts.conflictAll
      },

      interventionSummary: {
        behaviorEffectAttributionStatus: text(p.behaviorEffectAttributionStatus),
        behaviorEffectsInForce: (Array.isArray(p.behaviorEffectsInForce) ? p.behaviorEffectsInForce : []).length,
        selfInfluenced: computed.selfInfluenced === true
      },

      calibrationCounted: computed.calibrationCounted === true,
      reasonCodes: computed.reasonCodes.slice(0, 64),
      trace: computed.trace
    };
    deepFreeze(settlement);
    sealWith(SETTLEMENT_IDENTITY, SETTLEMENT_SEAL, SETTLEMENT_BRAND, settlement);

    const pe = core.computePredictionError(computed.state, core.confidenceBucketOf(p.subjectivePredictionConfidence));
    const predictionError = {
      schemaVersion: core.PE_SCHEMA_VERSION,
      predictionErrorId: 'perr_' + stableTokenLike(settlementId),
      predictionId: settlement.predictionId,
      settlementId: settlementId,
      idLifetime: core.ID_LIFETIME,
      settlementState: computed.state,
      subjectiveConfidenceBucket: pe.confidenceBucket,
      direction: pe.direction,
      magnitude: pe.magnitude,
      /* ★ v1：**恒为 null** —— ordinal only，不造数值 */
      predictionErrorMetric: core.PREDICTION_ERROR_METRIC,
      /* 只是**未来** calibration 的指向信息；本轮**不得**写回 */
      affectedExpectationRefs: [{
        characterId: text(p.sourceExpectationRef && p.sourceExpectationRef.characterId),
        conversationId: text(p.sourceExpectationRef && p.sourceExpectationRef.conversationId),
        turnId: text(p.sourceExpectationRef && p.sourceExpectationRef.turnId),
        expectationIndex: p.sourceExpectationRef ? p.sourceExpectationRef.expectationIndex : null
      }],
      affectedInterpretationRefs: p.sourceInterpretationRef ? [p.sourceInterpretationRef] : [],
      calibrationEligible: computed.calibrationCounted === true,
      reasonCodes: pe.reasonCodes.slice(0, 32),
      directionReason: pe.reasonCodes[1] || null
    };
    deepFreeze(predictionError);
    sealWith(PREDICTION_ERROR_IDENTITY, PREDICTION_ERROR_SEAL, PREDICTION_ERROR_BRAND, predictionError);

    held.set(settlement.predictionId, { settlement: settlement, error: predictionError });
    order.push(settlement.predictionId);
    counters.settled += 1;
    if (computed.calibrationCounted) counters.calibrationEligible += 1;
    bump(computed.state);
    evictOverflow();

    return {
      ok: true, status: 'settled',
      reasonCode: computed.reasonCodes[0] || 'ok',
      settlement: settlement, predictionError: predictionError,
      providerCalls: 0, durableWrites: 0
    };
  }

  function getSettlement(predictionId) {
    const e = held.get(text(predictionId));
    return e ? e.settlement : null;
  }
  function getPredictionError(predictionId) {
    const e = held.get(text(predictionId));
    return e ? e.error : null;
  }
  function computePredictionError(predictionId) {
    const e = held.get(text(predictionId));
    if (!e) return { ok: false, reasonCode: REASON.notFound, predictionError: null };
    return { ok: true, reasonCode: 'ok', predictionError: e.error };
  }

  /* 审计视图：**结构性**，不含任何原始正文 */
  function inspectSettlement(predictionId) {
    const e = held.get(text(predictionId));
    if (!e) return { ok: false, reasonCode: REASON.notFound, view: null };
    const s = e.settlement, pe = e.error;
    return {
      ok: true,
      view: {
        settlementId: s.settlementId,
        predictionId: s.predictionId,
        idLifetime: s.idLifetime,
        state: s.state,
        lifecycleState: s.lifecycleState,
        revisionDetected: s.revisionDetected,
        settledAt: s.settledAt,
        windowKind: s.observationWindow ? s.observationWindow.windowKind : null,
        closesAt: s.observationWindow ? s.observationWindow.closesAt : null,
        opportunityState: s.opportunityState,
        supportSummary: s.supportSummary,
        conflictSummary: s.conflictSummary,
        interventionSummary: s.interventionSummary,
        calibrationCounted: s.calibrationCounted,
        observationCount: s.observationRefs.length,
        evidenceCount: s.evidenceRefs.length,
        predictionError: {
          direction: pe.direction, magnitude: pe.magnitude,
          predictionErrorMetric: pe.predictionErrorMetric,
          subjectiveConfidenceBucket: pe.subjectiveConfidenceBucket,
          calibrationEligible: pe.calibrationEligible
        },
        reasonCodes: s.reasonCodes.slice()
      }
    };
  }

  function describe() {
    return {
      status: 'LIVE_CAPABLE',
      entry: ENTRY,
      routes: 'NONE',
      lifetime: 'SESSION_ONLY',
      durable: false,
      durableWrites: 0,
      crossRestartExactlyOnce: 'NO',
      restartRecovery: 'NONE',
      processMemoryOnly: true,
      contentExposed: 'NO',
      browserVisible: 'NO',
      disclosure: 'INTERNAL_AUDIT_ONLY',
      holder: { maxEntries: maxEntries, ttlMs: ttlMs, scope: HOLDER_SCOPE, durability: 'NONE', current: held.size },
      settlementOnce: 'YES',
      reopen: 'NO_V1',
      resettlement: 'REJECTED',
      postWindowRetroSettle: 'NO',
      legacyResultAdapter: core.LEGACY_RESULT_ADAPTER,
      states: core.SETTLEMENT_STATES.slice(),
      predictionError: 'ORDINAL_ONLY',
      predictionErrorMetric: core.PREDICTION_ERROR_METRIC,
      calibrationLedger: 'NONE',
      calibrationAppliedToLive: 'NO',
      authorityConsumedNotReinvented: 'YES',
      sharesObservationAuthorityInstance: true,
      /* P5-B · matcher 只提供 relation；结算状态永远由本引擎决定 */
      evidenceMatcherAttached: !!evidenceMatcher,
      evidenceMatcherSupplies: 'RELATION_ONLY',
      matcherMayAssignSettlementState: 'NO',
      matcherCallAccounting: 'CONDITIONAL_PER_STATEMENT_OBSERVATION',
      /* 明确的自述：这些**没有** */
      memoryAuthority: 'NONE',
      relationshipAuthority: 'NONE',
      modelCalls: 0,
      matchedMissedCalculation: 'YES_DETERMINISTIC',
      counters: Object.assign({}, counters)
    };
  }

  function heldCount() { return held.size; }

  /* P5-B · 本实例的 reachability 绑定：把 matcher enablement 注入进去。
     ★ 这是**实例级**的（matcher 是实例依赖），所以不能挂在 module 级函数上。 */
  function instanceReachability(input) {
    const merged = Object.assign({}, input || {});
    if (merged.matcherEnabled === undefined) {
      merged.matcherEnabled = !!(evidenceMatcher && typeof evidenceMatcher.describe === 'function'
        && evidenceMatcher.describe().enabled === true);
    }
    return calibrationReachability(merged);
  }

  return {
    ENTRY: ENTRY,
    settlePrediction: settlePrediction,
    /* P5-B · 唯一 matcher-aware 入口（async；同步路径恒无 matcher relation） */
    settlePredictionWithEvidenceMatcher: settlePredictionWithEvidenceMatcher,
    /* 实例绑定的 reachability（含 matcher enablement） */
    calibrationReachability: instanceReachability,
    getSettlement: getSettlement,
    getPredictionError: getPredictionError,
    computePredictionError: computePredictionError,
    inspectSettlement: inspectSettlement,
    describe: describe,
    heldCount: heldCount,
    awaitIdle: function () { return Promise.resolve({ idle: true, inFlight: 0 }); }
  };
}

module.exports = {
  createRuntimePredictionSettlement: createRuntimePredictionSettlement,
  /* P4 · provenance capability：只有本模块铸造的记录才被承认为合法输入。 */
  isSettlementRecord: isSettlementRecord,
  isPredictionErrorRecord: isPredictionErrorRecord,
  recordProvenance: recordProvenance,
  /* P4-R1 · 共享 reachability primitive（P4 只消费，不重判 settlement） */
  calibrationReachability: calibrationReachability,
  decisiveAuthoritySourcesFor: function (type) { return DEFAULT_CORE.decisiveAuthoritySourcesFor(type); },
  policyAllowsDecisiveFrom: function (t, s) { return DEFAULT_CORE.policyAllowsDecisiveFrom(t, s); },
  policyAllowsDecisiveSettlement: function (t) { return DEFAULT_CORE.policyAllowsDecisiveSettlement(t); },
  runtimeCanClassifyMode: function (m) { return DEFAULT_CORE.runtimeCanClassifyMode(m); },
  SETTLEMENT_BRAND: SETTLEMENT_BRAND,
  PREDICTION_ERROR_BRAND: PREDICTION_ERROR_BRAND,
  MAX_HELD_SETTLEMENTS: MAX_HELD_SETTLEMENTS,
  SETTLEMENT_TTL_MS: SETTLEMENT_TTL_MS,
  HOLDER_SCOPE: HOLDER_SCOPE,
  REASON: REASON
};
