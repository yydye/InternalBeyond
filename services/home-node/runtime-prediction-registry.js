'use strict';
/* ====================================================================
   IB Home Node · Prediction Registry（Prediction Error P2）
   --------------------------------------------------------------------
   唯一职责：**会话内**持有 PredictionRecord。

     validated Expectation
             ↓ deterministic projection（纯核心）
     PredictionRecord
             ↓ bounded session-only holder
     进程内存 · 不落盘 · 不跨重启

   ── 它拥有的两个唯一权威 ──────────────────────────────────────────────
     PREDICTION_ID_AUTHORITY       —— 只有它 mint predictionId
     PREDICTION_RECORD_MINT_AUTHORITY —— 只有它建档

   ── 它**不**拥有 ─────────────────────────────────────────────────────
     settlement authority · observation authority · memory authority ·
     relationship authority · model authority。

   ── 生命周期（frozen）───────────────────────────────────────────────
     PREDICTION_REGISTRY_LIFETIME = SESSION_ONLY
     DURABLE_PREDICTION_STORE     = NO_V1
     CROSS_RESTART_EXACTLY_ONCE   = NO
     RESTART_RECOVERY             = NONE
     holder: 有界条数 + 有界 TTL + 纯进程内存（沿用既有 holder house style）

   ── P2 不做的事 ─────────────────────────────────────────────────────
     不结算 · 不产出 matched/missed/mixed · 不算 Prediction Error ·
     不做 Calibration · 不调模型 · 不写 memory / relationship ·
     不新增路由 · 不进 recall 信封 · 不进 prompt / UI / export。
   ==================================================================== */

const path = require('path');

const ASSETS_JS = path.join(__dirname, '..', '..', 'assets', 'js');
const DEFAULT_CORE = require(path.join(ASSETS_JS, 'memory-recall', 'prediction-record-core.js'));

/* 有界持有者：与 runtime-expectation.js / runtime-behavior-effect.js 同一纪律
   （64 条 / 10 分钟 / character+conversation+turn 作用域）。**不落盘。** */
const MAX_HELD_PREDICTIONS = 64;
const PREDICTION_TTL_MS = 10 * 60 * 1000;
const HOLDER_SCOPE = 'character+conversation+turn';
const REGISTRY_VERSION = 'prediction-registry/v1';

const ENTRY = 'projectFromValidatedExpectation';

const REASON = Object.freeze({
  coreMissing: 'prediction-record-core-missing',
  notAnObject: 'not-an-object',
  projectionRejected: 'projection-rejected',
  duplicateRecord: 'prediction-already-registered',
  recordInvalid: 'prediction-record-invalid',
  notFound: 'prediction-not-found',
  notOpen: 'prediction-not-open',
  turnIdentityMissing: 'turn-identity-missing'
});

const LIFECYCLE = Object.freeze(['open', 'superseded', 'withdrawn']);

function isPlainObject(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
function text(v) { return v == null ? '' : String(v); }
function bounded(v, n) { return text(v).slice(0, n || 200); }

function createRuntimePredictionRegistry(deps) {
  const d = deps || {};
  const core = d.core || DEFAULT_CORE;
  const clock = typeof d.clock === 'function' ? d.clock : null;
  const maxEntries = Number.isFinite(Number(d.maxEntries)) && Number(d.maxEntries) > 0
    ? Number(d.maxEntries) : MAX_HELD_PREDICTIONS;
  /* P5-B2 · attribution authority（**只读消费**；Registry 无 attribution authority） */
  const attributionAuthority = d.attributionAuthority || null;
  const ttlMs = Number.isFinite(Number(d.ttlMs)) && Number(d.ttlMs) > 0
    ? Number(d.ttlMs) : PREDICTION_TTL_MS;

  /* ── 有界、纯进程内持有者 ─────────────────────────────────────────── */
  const held = new Map();                 /* predictionId → record */
  const order = [];                       /* 插入序（用于 FIFO 淘汰） */
  let registrySessionRef = null;          /* 首次成功投影时 mint；**不是**跨重启身份 */
  let supersededCount = 0;
  let withdrawnCount = 0;
  const counters = {
    attempted: 0, created: 0, duplicate: 0, rejected: 0, notSettleable: 0,
    evicted: 0, expired: 0, superseded: 0, withdrawn: 0, providerCalls: 0, durableWrites: 0
  };

  function note() { /* 结构化日志出口：P2 不接任何 logger，保持零副作用 */ }

  /* 时间**必须由调用方注入**。`clock` 只是显式 opt-in 的测试缝
     （`allowClockFallback: true`），默认**不**回退 —— 避免任何隐式读时钟。 */
  const allowClockFallback = d.allowClockFallback === true;
  function nowFrom(ctx) {
    const n = Number(ctx && ctx.now);
    if (Number.isFinite(n) && n > 0) return n;
    if (allowClockFallback && clock) {
      try { const c = Number(clock()); if (Number.isFinite(c) && c > 0) return c; } catch (e) { /* ignore */ }
    }
    return null;   /* 没有注入时间 ⇒ 调用方错误（fail-closed，不读 Date.now） */
  }

  function sweep(now) {
    const at = Number(now);
    if (!Number.isFinite(at)) return;
    for (const key of Array.from(held.keys())) {
      const rec = held.get(key);
      if (!rec) { held.delete(key); continue; }
      const born = Number(rec.createdAt);
      if (Number.isFinite(born) && (at - born) > ttlMs) {
        held.delete(key);
        counters.expired += 1;
      }
    }
  }

  function evictOverflow() {
    while (held.size > maxEntries && order.length) {
      const oldest = order.shift();
      if (held.has(oldest)) { held.delete(oldest); counters.evicted += 1; }
    }
  }

  function ensureSessionRef(now, characterId, conversationId) {
    if (registrySessionRef) return registrySessionRef;
    if (typeof core.mintRegistrySessionRef !== 'function') return null;
    registrySessionRef = core.mintRegistrySessionRef({
      firstProjectionAt: now, characterId: characterId, conversationId: conversationId
    });
    return registrySessionRef;
  }

  /* ── 唯一建档路径 ─────────────────────────────────────────────────── */
  /* ── P5-B2 · 归因快照消费（**只读**；失败一律回落 unknown）─────────────
     Registry 没有 attribution authority：它只能向 authority 要一个 sealed
     snapshot，并把 status/effects/influenced 映射进 projection。
     ★ Attribution 是 **decisive capability dependency**，不是 prediction
       creation dependency ⇒ 任何失败都不能让建档失败。 */
  function attributionFor(c, characterId, conversationId, now) {
    if (c.behaviorEffectAttribution != null) return c.behaviorEffectAttribution;   /* 显式优先 */
    const authority = c.attributionAuthority || attributionAuthority;
    if (!authority || typeof authority.snapshotBehaviorEffectAttribution !== 'function') {
      return undefined;                                    /* ⇒ 核心默认 'unknown' */
    }
    try {
      const snap = authority.snapshotBehaviorEffectAttribution({
        characterId: characterId, conversationId: conversationId, turnId: text(c.turnId), at: now
      });
      const validatorOk = typeof authority.isBehaviorEffectAttributionSnapshot !== 'function'
        || authority.isBehaviorEffectAttributionSnapshot(snap) === true;
      if (!snap || validatorOk !== true) return undefined;  /* 非法 capability ⇒ unknown */
      if (text(snap.scope && snap.scope.characterId) !== text(characterId)) return undefined;
      if (text(snap.scope && snap.scope.conversationId) !== text(conversationId)) return undefined;
      const effects = Array.isArray(snap.effects) ? snap.effects.map(function (e) { return text(e && e.effectInstanceId); }) : [];
      return {
        status: text(snap.status),
        effects: effects,
        influenced: snap.predictionInfluencedSystem === true ? true : (snap.predictionInfluencedSystem === false ? false : null)
      };
    } catch (_) {
      return undefined;                                    /* 抛错 ⇒ unknown */
    }
  }

  function projectFromValidatedExpectation(expectation, ctx) {
    const c = isPlainObject(ctx) ? ctx : {};
    counters.attempted += 1;

    if (!core || typeof core.projectFromValidatedExpectation !== 'function') {
      counters.rejected += 1;
      return { ok: false, status: 'rejected', reasonCode: REASON.coreMissing, record: null, providerCalls: 0 };
    }
    const now = nowFrom(c);
    if (now == null) {
      counters.rejected += 1;
      return { ok: false, status: 'rejected', reasonCode: 'injected-time-missing', record: null, providerCalls: 0 };
    }
    sweep(now);

    const characterId = text(c.characterId);
    const conversationId = text(c.conversationId);
    const turnId = text(c.turnId);
    if (!characterId || !conversationId || !turnId) {
      counters.rejected += 1;
      return { ok: false, status: 'rejected', reasonCode: REASON.turnIdentityMissing, record: null, providerCalls: 0 };
    }

    const sessionRef = ensureSessionRef(now, characterId, conversationId);
    if (!sessionRef) {
      counters.rejected += 1;
      return { ok: false, status: 'rejected', reasonCode: 'registry-session-ref-missing', record: null, providerCalls: 0 };
    }

    const projected = core.projectFromValidatedExpectation(expectation, {
      now: now,
      characterId: characterId,
      conversationId: conversationId,
      turnId: turnId,
      expectationIndex: c.expectationIndex,
      registrySessionRef: sessionRef,
      interpretationRef: c.interpretationRef,
      /* P3.0 · 干预归因：**生产在 P3 不传** ⇒ 核心取默认 'unknown'
         （`[]` 不等于 known-none）。只有拥有可靠 attribution 来源的内部调用方
         才可以显式传入，且必须落在闭集里。 */
      behaviorEffectAttribution: attributionFor(c, characterId, conversationId, now)
    });

    /* 非结构化 / 不可推导 ⇒ **不是错误**：Expectation 依旧合法，只是不可结算 */
    if (!projected || projected.ok !== true) {
      counters.notSettleable += 1;
      return {
        ok: false, status: 'not-settleable',
        settleable: false,
        reasonCode: (projected && projected.reasonCode) || REASON.projectionRejected,
        record: null, providerCalls: 0
      };
    }

    const record = projected.record;
    if (!record || held.has(record.predictionId)) {
      counters.duplicate += 1;
      /* 幂等：同一语义投影重复到达 ⇒ 返回既有记录，**不**覆盖、**不**改写快照 */
      return {
        ok: true, status: 'already-registered', settleable: true,
        reasonCode: REASON.duplicateRecord,
        record: record && held.has(record.predictionId) ? held.get(record.predictionId) : null,
        providerCalls: 0
      };
    }

    const shape = core.validatePredictionRecord(record);
    if (!shape.ok) {
      counters.rejected += 1;
      return {
        ok: false, status: 'rejected', settleable: false,
        reasonCode: REASON.recordInvalid, errors: shape.errors, record: null, providerCalls: 0
      };
    }

    held.set(record.predictionId, record);
    order.push(record.predictionId);
    counters.created += 1;
    evictOverflow();
    note('prediction-registry-projected', { predictionId: record.predictionId });
    return { ok: true, status: 'created', settleable: true, reasonCode: 'ok', record: record, providerCalls: 0 };
  }

  /* ── 只读查询（**内容不对外**：只回 id / 元数据 / 计数）────────────── */
  function getPrediction(predictionId) {
    const id = text(predictionId);
    if (!id) return null;
    return held.get(id) || null;
  }

  function listOpenPredictions(filter) {
    const f = isPlainObject(filter) ? filter : {};
    const out = [];
    for (const rec of held.values()) {
      if (rec.lifecycleState !== 'open') continue;
      if (f.characterId != null && text(rec.scope.characterId) !== text(f.characterId)) continue;
      if (f.conversationId != null && text(rec.scope.conversationId) !== text(f.conversationId)) continue;
      out.push(rec);
    }
    return out;
  }

  /* 生命周期：P2 只允许 open → superseded / withdrawn（**不**做结算） */
  function markSuperseded(predictionId, reasonCode) {
    const id = text(predictionId);
    const rec = held.get(id);
    if (!rec) return { ok: false, reasonCode: REASON.notFound, record: null };
    if (rec.lifecycleState !== 'open') return { ok: false, reasonCode: REASON.notOpen, record: rec };
    /* 原位改写**只**允许生命周期标记；creation snapshot 是冻结的，改不动。 */
    const next = Object.assign({}, rec, {
      lifecycleState: 'superseded',
      supersededReasonCode: bounded(reasonCode || 'superseded-by-newer-prediction', 64)
    });
    Object.freeze(next);
    held.set(id, next);
    supersededCount += 1;
    counters.superseded += 1;
    return { ok: true, reasonCode: 'ok', record: next };
  }

  function markWithdrawn(predictionId, reasonCode) {
    const id = text(predictionId);
    const rec = held.get(id);
    if (!rec) return { ok: false, reasonCode: REASON.notFound, record: null };
    if (rec.lifecycleState !== 'open') return { ok: false, reasonCode: REASON.notOpen, record: rec };
    const next = Object.assign({}, rec, {
      lifecycleState: 'withdrawn',
      withdrawnReasonCode: bounded(reasonCode || 'withdrawn', 64)
    });
    Object.freeze(next);
    held.set(id, next);
    withdrawnCount += 1;
    counters.withdrawn += 1;
    return { ok: true, reasonCode: 'ok', record: next };
  }

  /* describe / inspect：**只报状态、计数、边界**；绝不暴露预测正文。 */
  function describe() {
    return {
      status: 'LIVE_CAPABLE',
      entry: ENTRY,
      registryVersion: REGISTRY_VERSION,
      routes: 'NONE',
      lifetime: 'SESSION_ONLY',
      durable: false,
      durableWrites: 0,
      crossRestartExactlyOnce: 'NO',
      restartRecovery: 'NONE',
      processMemoryOnly: true,
      sessionRefMinted: !!registrySessionRef,
      sessionRefIsPersistent: false,
      contentExposed: 'NO',
      browserVisible: 'NO',
      holder: {
        maxEntries: maxEntries, ttlMs: ttlMs, scope: HOLDER_SCOPE,
        durability: 'NONE', current: held.size
      },
      /* 唯一权威自述 */
      predictionIdAuthority: 'PREDICTION_REGISTRY',
      predictionRecordMintAuthority: 'PREDICTION_REGISTRY',
      settlementAuthority: 'NONE',
      observationAuthority: 'NONE',
      memoryAuthority: 'NONE',
      relationshipAuthority: 'NONE',
      modelCalls: 0,
      counters: Object.assign({}, counters),
      /* P2 边界：结算相关一律 NONE */
      settlementEngine: 'NONE',
      predictionErrorCalculation: 'NONE',
      calibration: 'NONE',
      evidenceMatcher: 'OFF',
      matchedMissedCalculation: 'NONE'
    };
  }

  function inspectRegistry(predictionId) {
    const rec = getPrediction(predictionId);
    if (!rec) return { ok: false, reasonCode: REASON.notFound, view: null };
    /* 审计视图：**不含** prediction 正文 / subjectLabel / expectedOutcome.token */
    return {
      ok: true,
      view: {
        predictionId: rec.predictionId,
        idLifetime: rec.idLifetime,
        registrySessionRef: rec.registrySessionRef,
        predictionType: rec.predictionType,
        settlementPolicy: rec.settlementPolicy,
        contradictionMode: rec.contradictionMode,
        lifecycleState: rec.lifecycleState,
        settlementState: rec.settlementState,
        createdAt: rec.createdAt,
        windowKind: rec.observationWindow.windowKind,
        opensAt: rec.observationWindow.opensAt,
        closesAt: rec.observationWindow.closesAt,
        opportunityRequired: rec.opportunity.required,
        opportunityKind: rec.opportunity.kind,
        opportunityConsumed: rec.opportunity.consumedAt !== null,
        subjectivePredictionConfidence: rec.subjectivePredictionConfidence,
        evidenceConfidence: rec.evidenceConfidence,
        calibrationConfidence: rec.calibrationConfidence,
        reasonCodes: rec.reasonCodes.slice()
      }
    };
  }

  return {
    ENTRY: ENTRY,
    projectFromValidatedExpectation: projectFromValidatedExpectation,
    getPrediction: getPrediction,
    listOpenPredictions: listOpenPredictions,
    markSuperseded: markSuperseded,
    markWithdrawn: markWithdrawn,
    inspectRegistry: inspectRegistry,
    describe: describe,
    heldCount: function () { return held.size; },
    sessionRef: function () { return registrySessionRef; },
    /* 测试用 settle 缝（不在生产路径上）：等到无在飞工作（本 registry 是同步的） */
    awaitIdle: function () { return Promise.resolve({ idle: true, inFlight: 0 }); }
  };
}

module.exports = {
  createRuntimePredictionRegistry: createRuntimePredictionRegistry,
  MAX_HELD_PREDICTIONS: MAX_HELD_PREDICTIONS,
  PREDICTION_TTL_MS: PREDICTION_TTL_MS,
  HOLDER_SCOPE: HOLDER_SCOPE,
  REGISTRY_VERSION: REGISTRY_VERSION,
  LIFECYCLE: LIFECYCLE,
  REASON: REASON
};
