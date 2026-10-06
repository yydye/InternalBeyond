'use strict';
/* ====================================================================
   IB Home Node · Reality Feedback Driver（P5-B3-D4-R3）
   --------------------------------------------------------------------
   REALITY_EVENT_FEEDBACK_DRIVER_OWNER = HOME_NODE_RUNTIME_ASSEMBLY
   FEEDBACK_TRIGGER = NEW_CANONICAL_REALITY_EVENT_MINT
   FEEDBACK_DRIVER_IS_ORCHESTRATION_ONLY = YES

   Driver **只**编排，不拥有任何 authority：
     pairing      → Prediction Registry（candidatePredictions）
     observation  → P1（projectForPrediction / authorityGate）
     settlement   → P3（settlePrediction）
     calibration  → P4（本 driver 不触碰）

   ── Driver **没有**的语义判断 ────────────────────────────────────────
     不比较 outcomeCode；不按 predictionType 过滤；不挑 predictionId；
     不写 matched / missed / support / conflict；
     不把 canonical runtime fact 自动当成 opportunity。
   ==================================================================== */

const dispatches = new WeakSet();

const REASON = Object.freeze({
  ok: 'ok',
  notCanonicalRealityEvent: 'not-canonical-reality-event',
  duplicateDispatchSuppressed: 'duplicate-dispatch-suppressed',
  noCandidates: 'no-candidate-predictions',
  observationRefused: 'observation-projection-refused',
  predictionMissing: 'candidate-prediction-missing',
  registryUnavailable: 'registry-unavailable',
  internalError: 'feedback-internal-error'
});

const BOUNDS = Object.freeze({ MAX_DISPATCH_HISTORY: 512 });

function isPlainObject(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
function text(v) { return v == null ? '' : String(v); }

function createRuntimeRealityFeedback(deps) {
  const d = deps || {};
  const registry = d.registry || null;
  const observationRuntime = d.observationRuntime || null;
  const settlementRuntime = d.settlementRuntime || null;
  const isRealityEvent = typeof d.isRealityEvent === 'function' ? d.isRealityEvent : null;
  const clock = typeof d.clock === 'function' ? d.clock : (() => Date.now());
  const logger = typeof d.logger === 'function' ? d.logger : null;
  const maxHistory = Number.isFinite(Number(d.maxDispatchHistory)) && Number(d.maxDispatchHistory) > 0
    ? Number(d.maxDispatchHistory) : BOUNDS.MAX_DISPATCH_HISTORY;

  /* session-only、bounded：dispatch key = realityEventId（不另造随机 id） */
  const dispatched = new Map();
  const counters = {
    dispatchAttempted: 0, dispatchCompleted: 0, dispatchFailed: 0,
    rejectedNotCanonical: 0, duplicateSuppressed: 0,
    candidateCount: 0, observationCount: 0, settlementCount: 0,
    projectionRefused: 0, perPredictionFailures: 0,
    modelCalls: 0, durableWrites: 0
  };

  function remember(eventId) {
    dispatched.set(eventId, Number(clock()));
    while (dispatched.size > maxHistory) {
      const oldest = dispatched.keys().next();
      if (oldest.done) break;
      dispatched.delete(oldest.value);
    }
  }

  /**
   * processRealityEvent(realityEvent) —— 唯一入口。
   * ★ 只接受 canonical sealed RealityEvent（capability check，不信任 shape）。
   * ★ 绝不抛出；绝不改写 RealityEvent / source fact。
   */
  function processRealityEvent(realityEvent) {
    counters.dispatchAttempted += 1;
    if (!isRealityEvent || isRealityEvent(realityEvent) !== true) {
      counters.rejectedNotCanonical += 1;
      return { ok: false, status: 'refused', reasonCode: REASON.notCanonicalRealityEvent, candidates: 0, observations: 0, settlements: 0 };
    }
    const eventId = text(realityEvent.realityEventId);
    if (dispatched.has(eventId)) {
      counters.duplicateSuppressed += 1;
      return { ok: true, status: 'duplicate-dispatch', reasonCode: REASON.duplicateDispatchSuppressed, candidates: 0, observations: 0, settlements: 0 };
    }
    remember(eventId);

    const out = { ok: true, status: 'dispatched', reasonCode: REASON.ok, candidates: 0, observations: 0, settlements: 0, settlementsByPrediction: [] };
    try {
      if (!registry || !observationRuntime
        || typeof observationRuntime.candidatePredictions !== 'function'
        || typeof observationRuntime.projectForPrediction !== 'function') {
        counters.dispatchFailed += 1;
        return Object.assign(out, { ok: false, status: 'failed', reasonCode: REASON.registryUnavailable });
      }

      /* ① pairing authority = Registry scope query（不做任何本地语义过滤） */
      const scope = {
        characterId: text(realityEvent.characterId),
        conversationId: text(realityEvent.conversationId)
      };
      let candidates = [];
      try {
        candidates = observationRuntime.candidatePredictions(realityEvent, scope) || [];
      } catch (error) {
        counters.dispatchFailed += 1;
        if (logger) logger('reality-feedback-candidates-failed', { realityEventId: eventId, error: String((error && error.message) || error).slice(0, 200) });
        return Object.assign(out, { ok: false, status: 'failed', reasonCode: REASON.internalError });
      }
      out.candidates = Array.isArray(candidates) ? candidates.length : 0;
      counters.candidateCount += out.candidates;
      if (out.candidates === 0) {
        /* ZERO-PAIR 是**成功**：RealityEvent 仍然 canonical，只是没有 observation。 */
        counters.dispatchCompleted += 1;
        return Object.assign(out, { reasonCode: REASON.noCandidates });
      }

      /* ② per-prediction 投影 + 结算（逐条隔离，失败不牵连其它） */
      for (let i = 0; i < candidates.length; i += 1) {
        const predictionId = text(candidates[i]);
        let record = null;
        try {
          record = (registry && typeof registry.getPrediction === 'function') ? registry.getPrediction(predictionId) : null;
        } catch (_) { record = null; }
        if (!isPlainObject(record)) {
          counters.perPredictionFailures += 1;
          out.settlementsByPrediction.push({ predictionId: predictionId, status: 'no-record' });
          continue;
        }
        try {
          const ref = {
            predictionId: predictionId,
            opensAt: record.observationWindow && record.observationWindow.opensAt,
            closesAt: record.observationWindow && record.observationWindow.closesAt,
            predictionCreatedAt: record.observationWindow && record.observationWindow.opensAt
          };
          const projected = observationRuntime.projectForPrediction({ realityEvent: realityEvent, predictionRef: ref });
          if (!projected || projected.ok !== true) {
            counters.projectionRefused += 1;
            out.settlementsByPrediction.push({ predictionId: predictionId, status: 'projection-refused', reasonCode: projected && projected.reasonCode });
            continue;
          }
          out.observations += 1;
          counters.observationCount += 1;
          if (settlementRuntime && typeof settlementRuntime.settlePrediction === 'function') {
            /* ③ settlement authority = P3；driver **不**提供 opportunity /
                   relation / matched 等任何语义输入。 */
            const settled = settlementRuntime.settlePrediction(record, [{ observation: projected.observation }], { now: Number(clock()) });
            const state = settled && settled.settlement ? settled.settlement.state : null;
            if (state) { out.settlements += 1; counters.settlementCount += 1; }
            out.settlementsByPrediction.push({ predictionId: predictionId, status: 'settled', state: state });
          } else {
            out.settlementsByPrediction.push({ predictionId: predictionId, status: 'observation-only' });
          }
        } catch (error) {
          counters.perPredictionFailures += 1;
          out.settlementsByPrediction.push({ predictionId: predictionId, status: 'failed' });
          if (logger) logger('reality-feedback-prediction-failed', { realityEventId: eventId, predictionId: predictionId, error: String((error && error.message) || error).slice(0, 200) });
        }
      }
      counters.dispatchCompleted += 1;
      return out;
    } catch (error) {
      counters.dispatchFailed += 1;
      if (logger) logger('reality-feedback-failed', { realityEventId: eventId, error: String((error && error.message) || error).slice(0, 200) });
      return Object.assign(out, { ok: false, status: 'failed', reasonCode: REASON.internalError });
    }
  }

  /** 供 assembly 绑定的 post-mint subscriber（只接 canonical sealed event）。 */
  function onRealityEventMinted(realityEvent) {
    try { processRealityEvent(realityEvent); }
    catch (error) {
      counters.dispatchFailed += 1;
      if (logger) logger('reality-feedback-subscriber-failed', { error: String((error && error.message) || error).slice(0, 200) });
    }
  }

  function describe() {
    return {
      status: 'LIVE_CAPABLE',
      owner: 'HOME_NODE_RUNTIME_ASSEMBLY',
      trigger: 'NEW_CANONICAL_REALITY_EVENT_MINT',
      orchestrationOnly: 'YES',
      pairingAuthority: 'PREDICTION_REGISTRY',
      observationAuthority: 'P1',
      settlementAuthority: 'P3',
      calibrationAuthority: 'NONE',
      driverChoosesSettlementState: 'NO',
      driverSuppliesOpportunity: 'NO',
      dispatchKey: 'realityEventId',
      dispatchHistory: { max: maxHistory, current: dispatched.size, durability: 'NONE' },
      durableFeedbackQueue: 'NO',
      modelCalls: 0,
      durableWrites: 0,
      counters: Object.assign({}, counters)
    };
  }

  return {
    processRealityEvent: processRealityEvent,
    onRealityEventMinted: onRealityEventMinted,
    describe: describe,
    dispatchedCount: function () { return dispatched.size; },
    counters: counters
  };
}

module.exports = {
  createRuntimeRealityFeedback: createRuntimeRealityFeedback,
  REASON: REASON,
  BOUNDS: BOUNDS
};
