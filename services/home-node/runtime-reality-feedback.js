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
  const evidenceMatcherEnabled = d.evidenceMatcherEnabled === true;
  const onSettlement = typeof d.onSettlement === 'function' ? d.onSettlement : null;
  const isRealityEvent = typeof d.isRealityEvent === 'function' ? d.isRealityEvent : null;
  const clock = typeof d.clock === 'function' ? d.clock : (() => Date.now());
  const logger = typeof d.logger === 'function' ? d.logger : null;
  const maxHistory = Number.isFinite(Number(d.maxDispatchHistory)) && Number(d.maxDispatchHistory) > 0
    ? Number(d.maxDispatchHistory) : BOUNDS.MAX_DISPATCH_HISTORY;

  /* session-only、bounded：dispatch key = realityEventId（不另造随机 id） */
  const dispatched = new Map();
  /* The opt-in P3 Matcher path is asynchronous. Keep only a bounded set of
     session tasks; RealityEvent subscribers never create a durable queue. */
  const pendingMatcherSettlements = new Set();
  const maxPendingMatcherSettlements = Number.isFinite(Number(d.maxPendingMatcherSettlements))
    && Number(d.maxPendingMatcherSettlements) > 0 ? Math.min(128, Number(d.maxPendingMatcherSettlements)) : 128;
  const counters = {
    dispatchAttempted: 0, dispatchCompleted: 0, dispatchFailed: 0,
    rejectedNotCanonical: 0, duplicateSuppressed: 0,
    candidateCount: 0, observationCount: 0, settlementCount: 0,
    postSettlementCallbacks: 0, postSettlementFailures: 0,
    projectionRefused: 0, perPredictionFailures: 0,
    matcherPendingCapacityExceeded: 0,
    modelCalls: 0, durableWrites: 0
  };

  function completeSettlement(settled, predictionId, eventId, out, resultIndex) {
    const state = settled && settled.settlement ? settled.settlement.state : null;
    if (state) { out.settlements += 1; counters.settlementCount += 1; }
    let postSettlement = null;
    if (settled && settled.settlement && onSettlement) {
      counters.postSettlementCallbacks += 1;
      try {
        postSettlement = onSettlement(settled.settlement, settled.predictionError);
        if (!postSettlement || postSettlement.ok !== true) counters.postSettlementFailures += 1;
      } catch (_) {
        counters.postSettlementFailures += 1;
        postSettlement = { ok: false, status: 'failed', reasonCode: 'post-settlement-callback-threw' };
      }
    }
    const result = {
      predictionId: predictionId, status: 'settled', state: state,
      postSettlementStatus: postSettlement ? text(postSettlement.status) : null,
      postSettlementReasonCode: postSettlement ? text(postSettlement.reasonCode) : null
    };
    if (Number.isInteger(resultIndex)) out.settlementsByPrediction[resultIndex] = result;
    else out.settlementsByPrediction.push(result);
    return settled;
  }

  function trackMatcherSettlement(record, observation, predictionId, eventId, out, now) {
    if (pendingMatcherSettlements.size >= maxPendingMatcherSettlements) {
      counters.matcherPendingCapacityExceeded += 1;
      counters.perPredictionFailures += 1;
      out.settlementsByPrediction.push({ predictionId: predictionId, status: 'matcher-pending-capacity' });
      return false;
    }
    const resultIndex = out.settlementsByPrediction.length;
    out.settlementsByPrediction.push({ predictionId: predictionId, status: 'matcher-settlement-pending' });
    let tracked = null;
    tracked = Promise.resolve()
      .then(() => settlementRuntime.settlePredictionWithEvidenceMatcher(record, [{ observation: observation }], { now: now }))
      .then((settled) => completeSettlement(settled, predictionId, eventId, out, resultIndex))
      .catch((error) => {
        counters.perPredictionFailures += 1;
        if (logger) logger('reality-feedback-matcher-settlement-failed', {
          realityEventId: eventId, predictionId: predictionId,
          error: String((error && error.message) || error).slice(0, 200)
        });
        out.settlementsByPrediction[resultIndex] = { predictionId: predictionId, status: 'failed' };
        return null;
      })
      .finally(() => pendingMatcherSettlements.delete(tracked));
    pendingMatcherSettlements.add(tracked);
    return true;
  }

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
            const now = Number(clock());
            if (evidenceMatcherEnabled
              && typeof settlementRuntime.settlePredictionWithEvidenceMatcher === 'function') {
              trackMatcherSettlement(record, projected.observation, predictionId, eventId, out, now);
              continue;
            }
            const settled = settlementRuntime.settlePrediction(record, [{ observation: projected.observation }], { now: now });
            completeSettlement(settled, predictionId, eventId, out);
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
      matcherSettlementPath: evidenceMatcherEnabled ? 'P3_MATCHER_AWARE_ENTRY' : 'OFF',
      matcherPendingSettlements: { max: maxPendingMatcherSettlements, current: pendingMatcherSettlements.size, durability: 'NONE' },
      calibrationAuthority: 'NONE',
      postSettlementCallbackAttached: !!onSettlement,
      postSettlementCallbackMayRewriteP3: 'NO',
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
    awaitIdle: async function (timeoutMs) {
      const requested = Number(timeoutMs);
      const boundedTimeout = Number.isFinite(requested) && requested > 0 ? Math.min(requested, 30000) : 5000;
      const deadline = Date.now() + boundedTimeout;
      while (pendingMatcherSettlements.size > 0) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        let timer = null;
        try {
          await Promise.race([
            Promise.all(Array.from(pendingMatcherSettlements)),
            new Promise(resolve => { timer = setTimeout(resolve, remaining); })
          ]);
        } finally {
          if (timer) clearTimeout(timer);
        }
      }
      return {
        idle: pendingMatcherSettlements.size === 0,
        pending: pendingMatcherSettlements.size,
        timeoutMs: boundedTimeout
      };
    },
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
