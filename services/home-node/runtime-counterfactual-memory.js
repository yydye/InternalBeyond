/* ====================================================================
   IB Home Node · P21-R4-Q Counterfactual Memory Runtime
   --------------------------------------------------------------------
   One bounded, turn-scoped consumer of existing Recall/K/L/N/O/R3 context.
   Optional P.E evidence is read only from sealed P2/P3/P1 authorities.
   No Memory, Prediction, settlement, narrative, relationship, or persona writer.
   ==================================================================== */
'use strict';

const crypto = require('crypto');
const path = require('path');
const CORE = require(path.join(__dirname, '..', '..', 'assets', 'js', 'memory-recall', 'counterfactual-memory-core.js'));
const SHADOW_RUNNER = require(path.join(__dirname, '..', '..', 'assets', 'js', 'memory-recall', 'counterfactual-shadow-runner.js'));
const P3 = require('./runtime-prediction-settlement.js');
const RETRIEVAL = require(path.join(__dirname, '..', '..', 'assets', 'js', 'memory-retrieval-core.js'));

const MAX_TIMEOUT_MS = 900;
const MAX_OUTCOME_PREDICTIONS = 12;
const MAX_OUTCOME_EVIDENCE = 4;
const MAX_REPLAY_RESULTS = 64;
const REPLAY_TTL_MS = 10 * 60 * 1000;

function isPlainObject(value) { return !!value && typeof value === 'object' && !Array.isArray(value); }
function text(value) { return value == null ? '' : String(value); }
function uniqueIds(values, max) {
  const out = [], seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    if (value == null) continue;
    const id = String(value);
    if (!id || id.length > 240 || seen.has(id) || out.length >= max) continue;
    seen.add(id); out.push(id);
  }
  return out;
}
function hash(value) { return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function extractText(result) {
  if (typeof result === 'string') return result;
  if (!isPlainObject(result)) return null;
  if (typeof result.text === 'string') return result.text;
  if (typeof result.content === 'string') return result.content;
  return null;
}
function premiseFromMessage(message) {
  const source = String(message || '').trim();
  if (!source || source.length > 16000) return null;
  let statement = '';
  let isWhatIf = /^what\s+if\b/i.test(source);
  let tail = '';
  const zh = /(?:如果|假如|倘若)\s*([^，,。；;!?！？]{2,240})(?=，|,|。|；|;|\?|？|!|！|$)/u.exec(source);
  if (zh) { statement = zh[1].trim(); tail = source.slice(zh.index + zh[0].length); }
  if (!statement) {
    const en = /(?:what\s+if|if)\s+([^,.;!?]{2,240})(?=[,.;!?]|$)/i.exec(source);
    if (en) { statement = en[1].trim(); tail = source.slice(en.index + en[0].length); isWhatIf = /^what\s+if\b/i.test(en[0]); }
  }
  if (!statement) return null;
  if (!isWhatIf && !/(?:可能|也许|或许|会不会|是否会|会怎样|会发生|会变|could|might|would|perhaps|maybe|what\s+(?:would|could|might)|change|happen|result)/i.test(tail)) {
    return null;
  }
  let kind = null;
  if (/理解|误解|以为|知道|不知道|误会|information|understood|knew|misread|mistook/i.test(statement)) kind = 'information';
  else if (/说|解释|澄清|沟通|告诉|道歉|communicat|clarif|apolog|told/i.test(statement)) kind = 'communication';
  else if (/早|晚|之前|之后|提前|及时|earlier|later|sooner|timing/i.test(statement)) kind = 'timing';
  else if (/选择|决定|拒绝|选择了|choose|chose|decid/i.test(statement)) kind = 'choice';
  else if (/赴约|出现|到场|离开|回来|参加|没来|未到|arriv|attend|showed|came|left|return/i.test(statement)) kind = 'participant-action';
  else if (/天气|交通|设备|外部|weather|traffic|system|external/i.test(statement)) kind = 'external-condition';
  if (!kind) return null;
  return { kind: kind, statement: statement.slice(0, 240), source: 'CURRENT_USER_CONDITIONAL' };
}
function keywords(value) {
  try { return uniqueIds(RETRIEVAL.extractKeywords(String(value || '')), 120); }
  catch (_) { return []; }
}
function hasGrounding(premise, source) {
  const sourceTerms = new Set(keywords(source));
  return keywords(premise).some((term) => term.length >= 2 && sourceTerms.has(term));
}
function isRelatedOutcome(summary, anchorText, premise) {
  const terms = new Set(keywords(String(anchorText || '') + '\n' + String(premise || '')));
  return keywords(summary).some((term) => term.length >= 2 && terms.has(term));
}
function safeOutcomeSummary(event) {
  const body = isPlainObject(event && event.body) ? event.body : {};
  const allowed = ['statement', 'outcomeCode', 'status', 'eventType', 'targetKey', 'stance', 'token'];
  const parts = [];
  ['domain', 'type'].forEach((key) => { if (event && event[key] != null) parts.push(String(event[key]).slice(0, 64)); });
  allowed.forEach((key) => {
    const value = body[key];
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      parts.push(String(value).slice(0, 160));
    }
  });
  return parts.join(' · ').slice(0, 360);
}

function createRuntimeCounterfactualMemory(deps) {
  const d = deps || {};
  const registry = d.registry || null;
  const credentialAccess = d.credentialAccess || null;
  const modelPort = d.modelPort || null;
  const predictionRegistry = d.predictionRegistry || null;
  const predictionSettlement = d.predictionSettlement || null;
  const realityEventAuthority = d.realityEventAuthority || null;
  const clock = typeof d.clock === 'function' ? d.clock : Date.now;
  const logger = typeof d.logger === 'function' ? d.logger : function () {};
  const core = d.core || CORE;
  const runner = d.runner || SHADOW_RUNNER;
  const cache = new Map();
  const inFlight = new Map();
  const counters = { requested: 0, skipped: 0, calls: 0, succeeded: 0, failed: 0, replayed: 0, outcomeEvidenceRead: 0 };

  function note(event, fields) { try { logger(event, fields || {}); } catch (_) { /* logging cannot block Chat */ } }
  function sweep(now) {
    for (const [key, record] of cache) {
      if (!record || now - record.at > REPLAY_TTL_MS) cache.delete(key);
    }
    while (cache.size > MAX_REPLAY_RESULTS) {
      const oldest = cache.keys().next();
      if (oldest.done) break;
      cache.delete(oldest.value);
    }
  }
  function fallback(reason, uncertainty, providerCalls) {
    return { ok: false, status: 'unavailable', reason: String(reason || 'counterfactual-unavailable'),
      uncertainty: uncertainty || 'unsupported', view: null, text: '', durable: false,
      providerCalls: Number(providerCalls) || 0 };
  }
  function collectSettledOutcomeEvidence(scope, anchorText, premise) {
    const characterId = text(scope && scope.characterId), conversationId = text(scope && scope.conversationId);
    if (!characterId || !conversationId || !predictionRegistry || typeof predictionRegistry.listOpenPredictions !== 'function'
      || !predictionSettlement || typeof predictionSettlement.getSettlement !== 'function'
      || typeof predictionSettlement.getPredictionError !== 'function'
      || !realityEventAuthority || typeof realityEventAuthority.getRealityEventById !== 'function'
      || typeof realityEventAuthority.isRealityEvent !== 'function') return [];
    let predictions = [];
    try { predictions = predictionRegistry.listOpenPredictions({ characterId: characterId, conversationId: conversationId }) || []; }
    catch (_) { return []; }
    const result = [];
    for (const prediction of predictions.slice(-MAX_OUTCOME_PREDICTIONS)) {
      if (!isPlainObject(prediction) || prediction.predictionType !== 'event'
        || text(prediction.scope && prediction.scope.characterId) !== characterId
        || text(prediction.scope && prediction.scope.conversationId) !== conversationId) continue;
      let settlement = null, predictionError = null;
      try {
        settlement = predictionSettlement.getSettlement(prediction.predictionId);
        predictionError = predictionSettlement.getPredictionError(prediction.predictionId);
      } catch (_) { continue; }
      if (!P3.isSettlementRecord(settlement) || !P3.isPredictionErrorRecord(predictionError)
        || settlement.lifecycleState !== 'settled' || settlement.state === 'pending'
        || predictionError.predictionId !== settlement.predictionId
        || predictionError.settlementId !== settlement.settlementId
        || predictionError.settlementState !== settlement.state
        || predictionError.predictionErrorMetric !== null
        || !['over-confident', 'under-confident', 'calibrated', 'unknown'].includes(String(predictionError.direction || ''))
        || !['none', 'low', 'moderate', 'high', 'unknown'].includes(String(predictionError.magnitude || ''))
        || !Number.isFinite(Number(settlement.settledAt))
        || Number(settlement.settledAt) > Number(clock())
        || !Array.isArray(settlement.observationRefs) || !settlement.observationRefs.length) continue;
      const eventRefs = uniqueIds(settlement.evidenceRefs, 16);
      for (const eventRef of eventRefs) {
        let event = null;
        try { event = realityEventAuthority.getRealityEventById(eventRef); } catch (_) { event = null; }
        if (!event || realityEventAuthority.isRealityEvent(event) !== true
          || event.realityEventId !== eventRef
          || text(event.characterId) !== characterId || text(event.conversationId) !== conversationId) continue;
        const summary = safeOutcomeSummary(event);
        if (!summary || !isRelatedOutcome(summary, anchorText, premise)) continue;
        let causationEventRef = null;
        if (event.causationId) {
          let cause = null;
          try { cause = realityEventAuthority.getRealityEventById(event.causationId); } catch (_) { cause = null; }
          const causeSummary = safeOutcomeSummary(cause);
          if (cause && realityEventAuthority.isRealityEvent(cause) === true
            && text(cause.characterId) === characterId && text(cause.conversationId) === conversationId
            && cause.realityEventId === text(event.causationId)
            && causeSummary && isRelatedOutcome(causeSummary, anchorText, premise)) causationEventRef = cause.realityEventId;
        }
        result.push({
          authority: 'P3_P1_SEALED_READ', predictionId: settlement.predictionId,
          settlementId: settlement.settlementId, predictionErrorId: predictionError.predictionErrorId,
          realityEventRef: eventRef, observationRefs: settlement.observationRefs.slice(0, 4),
          settlementState: settlement.state, direction: predictionError.direction, magnitude: predictionError.magnitude,
          predictionErrorMetric: predictionError.predictionErrorMetric,
          causationEventRef: causationEventRef,
          summary: summary
        });
        counters.outcomeEvidenceRead += 1;
        if (result.length >= MAX_OUTCOME_EVIDENCE) return result;
      }
    }
    return result;
  }
  function resolveSpec(characterId) {
    if (!registry || typeof registry.getCharacterSpec !== 'function') return null;
    let raw = null;
    try { raw = registry.getCharacterSpec(characterId); } catch (_) { raw = null; }
    if (!isPlainObject(raw)) return null;
    const provider = text(raw.provider).trim(), model = text(raw.model).trim();
    const endpoint = text(raw.endpoint).trim(), credentialRef = text(raw.credentialRef).trim();
    if (!provider || !model || !endpoint || !credentialRef || !credentialAccess
      || typeof credentialAccess.resolve !== 'function') return null;
    let credential = null;
    try { credential = credentialAccess.resolve(credentialRef); } catch (_) { credential = null; }
    if (!credential || credential.ok !== true || typeof credential.secret !== 'string' || !credential.secret) return null;
    return { provider: provider, model: model, endpoint: endpoint, apiKey: credential.secret };
  }
  function makeInput(source) {
    const input = isPlainObject(source) ? source : {};
    const intervention = premiseFromMessage(input.currentMessage);
    if (!intervention) return { ok: false, reason: 'counterfactual-not-requested', uncertainty: 'unsupported' };
    const meaning = input.reinterpretation && input.reinterpretation.ok === true
      ? input.reinterpretation.contextualInterpretation : null;
    const currentMeaning = meaning && isPlainObject(meaning.currentMeaning) ? meaning.currentMeaning : null;
    const facts = currentMeaning && Array.isArray(currentMeaning.historicalFacts) ? currentMeaning.historicalFacts : [];
    const recollection = isPlainObject(input.reconstructedRecollection) ? input.reconstructedRecollection : null;
    const preserved = new Set(recollection && Array.isArray(recollection.preservedFacts)
      ? recollection.preservedFacts.filter((row) => row && row.state === 'remembered'
        && row.claimAuthority === 'CANONICAL_MEMORY_CLAIM_NOT_WORLD_FACT').map((row) => String(row.memoryId)) : []);
    const meta = isPlainObject(input.metaMemoryAwareness) ? input.metaMemoryAwareness : null;
    const memoryStates = new Map((meta && Array.isArray(meta.memoryStates) ? meta.memoryStates : [])
      .filter((row) => row && row.memoryId != null).map((row) => [String(row.memoryId), row]));
    const records = Array.isArray(input.records) ? input.records : [];
    const byId = new Map(records.filter((row) => row && row.id != null).map((row) => [String(row.id), row]));
    const provenance = new Map((Array.isArray(input.memoryProvenanceById) ? input.memoryProvenanceById : [])
      .filter((row) => row && row.memoryId != null).map((row) => [String(row.memoryId), row]));
    const selected = new Set(uniqueIds(input.selectedIds, 32));
    if (recollection && Array.isArray(recollection.memoryRefs)) recollection.memoryRefs.slice(0, 32).forEach((id) => selected.add(String(id)));
    const anchorCandidates = facts.filter((fact) => fact && fact.memoryId != null && typeof fact.statement === 'string')
      .map((fact) => {
        const id = String(fact.memoryId), record = byId.get(id), state = memoryStates.get(id), source = provenance.get(id);
        if (!record || !state || !source || !selected.has(id) || !preserved.has(id)
          || state.factualDetail !== 'remembered' || state.state !== 'remembered'
          || source.provenanceState !== 'clear' || source.authorSide !== 'character_recollection') return null;
        const groundingText = [record.title, record.content == null ? record.summary : record.content,
          record.oneLine, fact.statement, currentMeaning.summary].filter(Boolean).join('\n').slice(0, 900);
        if (!hasGrounding(intervention.statement, groundingText)) return null;
        return { memoryId: id, statement: String(fact.statement).slice(0, 300), groundingText: groundingText };
      }).filter(Boolean);
    if (!anchorCandidates.length) return { ok: false, reason: 'counterfactual-factual-anchor-unavailable', uncertainty: 'unsupported' };
    const anchor = anchorCandidates[0];
    const shared = isPlainObject(input.sharedMemoryView) ? input.sharedMemoryView : null;
    if (shared && Array.isArray(shared.views) && shared.views.some((view) => {
      if (!view || !['disputed', 'unresolved'].includes(String(view.relation || ''))) return false;
      const refs = [].concat(view.characterSide && view.characterSide.memoryRefs || [],
        view.userSide && view.userSide.userReportRefs || []);
      return refs.map(String).indexOf(anchor.memoryId) >= 0;
    })) return { ok: false, reason: 'counterfactual-shared-history-disputed', uncertainty: 'unsupported' };
    const unresolvedEdges = input.association && Array.isArray(input.association.edges) ? input.association.edges : [];
    if (unresolvedEdges.some((edge) => edge && ['conflict', 'correction'].includes(String(edge.relation || ''))
      && (String(edge.anchorMemoryId) === anchor.memoryId || String(edge.relatedMemoryId) === anchor.memoryId))) {
      return { ok: false, reason: 'counterfactual-association-tension-unresolved', uncertainty: 'unsupported' };
    }

    const outcomeEvidence = collectSettledOutcomeEvidence({ characterId: input.characterId, conversationId: input.conversationId },
      anchor.groundingText, intervention.statement);
    const causalBasis = [{ type: 'current-interpretation', memoryRefs: [anchor.memoryId], authority: 'R4-K_VALIDATED' }];
    const associationRefs = [];
    const edges = input.association && Array.isArray(input.association.edges) ? input.association.edges : [];
    edges.forEach((edge) => {
      if (!edge || !['continuation', 'contextualize'].includes(String(edge.relation || ''))) return;
      const edgeBasis = Array.isArray(edge.basis) ? edge.basis.slice(0, 4) : [];
      if (!edgeBasis.some((basis) => ['lexical_overlap', 'provenance_reference', 'same_recall_cluster'].includes(String(basis)))) return;
      if (String(edge.anchorMemoryId) !== anchor.memoryId && String(edge.relatedMemoryId) !== anchor.memoryId) return;
      const relatedId = String(edge.anchorMemoryId) === anchor.memoryId ? String(edge.relatedMemoryId) : String(edge.anchorMemoryId);
      causalBasis.push({ type: edge.relation === 'continuation' ? 'association-continuation' : 'association-contextualize',
        memoryRefs: [anchor.memoryId], relatedMemoryRef: relatedId, relation: String(edge.relation),
        basisRefs: edgeBasis, authority: 'R3_VALIDATED' });
      associationRefs.push(relatedId);
    });
    outcomeEvidence.forEach((row) => {
      causalBasis.push({ type: 'settled-outcome', memoryRefs: [anchor.memoryId], settlementId: row.settlementId,
        predictionErrorId: row.predictionErrorId, realityEventRef: row.realityEventRef, authority: 'P3_P1_SEALED_READ' });
      causalBasis.push({ type: 'prediction-error', memoryRefs: [anchor.memoryId], settlementId: row.settlementId,
        predictionErrorId: row.predictionErrorId, realityEventRef: row.realityEventRef, authority: 'P3_P1_SEALED_READ' });
      if (row.causationEventRef) causalBasis.push({ type: 'explicit-event-causation', memoryRefs: [anchor.memoryId],
        eventRefs: [row.causationEventRef, row.realityEventRef], authority: 'SEALED_REALITY_EVENT_CAUSATION' });
    });
    const selfNarrativeView = input.selfNarrative && isPlainObject(input.selfNarrative.narrative)
      ? input.selfNarrative.narrative : (isPlainObject(input.selfNarrative) ? input.selfNarrative : null);
    const interpretationRefs = uniqueIds([meta && meta.reinterpretation && meta.reinterpretation.interpretationRef]
      .concat(selfNarrativeView && Array.isArray(selfNarrativeView.interpretationRefs)
        ? selfNarrativeView.interpretationRefs : []), 8);
    const interventionInput = Object.assign({}, intervention, { memoryRefs: [anchor.memoryId] });
    const runtimeInput = {
      intervention: interventionInput,
      selectedIds: [anchor.memoryId],
      factualAnchors: [{ memoryId: anchor.memoryId, statement: anchor.statement, groundingText: anchor.groundingText,
        reliabilityState: 'reliable', provenanceState: 'clear' }],
      actualOutcome: { memoryId: anchor.memoryId, statement: anchor.statement,
        claimAuthority: 'CANONICAL_MEMORY_RECORD_CLAIM_NOT_WORLD_FACT' },
      causalBasis: causalBasis,
      settledOutcomeEvidence: outcomeEvidence,
      interpretationRefs: interpretationRefs,
      associationRefs: uniqueIds(associationRefs, 8),
      groundingText: anchor.groundingText + '\n' + intervention.statement
    };
    return { ok: true, value: runtimeInput };
  }

  async function derive(input, options) {
    const src = isPlainObject(input) ? input : {};
    const opts = isPlainObject(options) ? options : {};
    const now = Number(clock());
    sweep(now);
    counters.requested += 1;
    let prepared = null;
    try { prepared = makeInput(src); } catch (_) { prepared = null; }
    if (!prepared) { counters.skipped += 1; return fallback('counterfactual-input-invalid'); }
    if (!prepared.ok) { counters.skipped += 1; return fallback(prepared.reason, prepared.uncertainty); }
    let built = null;
    try { built = core.buildRequest(prepared.value); } catch (_) { built = null; }
    if (!built || built.ok !== true) { counters.skipped += 1; return fallback(built && built.reason, built && built.uncertainty); }
    const key = hash({ characterId: text(src.characterId), conversationId: text(src.conversationId), turnId: text(src.turnId),
      message: text(src.currentMessage), intervention: prepared.value.intervention, factualAnchor: prepared.value.factualAnchors[0],
      actualOutcome: prepared.value.actualOutcome, causalBasis: prepared.value.causalBasis,
      outcomeRefs: prepared.value.settledOutcomeEvidence.map((row) => row.realityEventRef), interpretationRefs: prepared.value.interpretationRefs });
    if (cache.has(key)) { counters.replayed += 1; return JSON.parse(JSON.stringify(cache.get(key).result)); }
    if (inFlight.has(key)) { counters.replayed += 1; return JSON.parse(JSON.stringify(await inFlight.get(key))); }
    const callsBefore = counters.calls;
    const task = (async () => {
      const remaining = Number(opts.remainingBudgetMs);
      const timeoutMs = Math.max(0, Math.min(MAX_TIMEOUT_MS, Number.isFinite(remaining) && remaining > 0 ? remaining : MAX_TIMEOUT_MS));
      if (timeoutMs < 50) return fallback('counterfactual-budget-exhausted');
      const spec = resolveSpec(text(src.characterId));
      if (!spec || !modelPort || typeof modelPort.run !== 'function') return fallback('counterfactual-provider-unavailable');
      const modelAdapter = {
        run: function (request) {
          counters.calls += 1;
          return modelPort.run({
            spec: spec,
            prompt: request.prompt,
            messages: request.messages,
            maxTokens: Math.min(1000, Number(request.maxTokens) || 1000),
            temperature: 0,
            jsonMode: true,
            timeoutMs: timeoutMs,
            signal: request.signal
          });
        }
      };
      let projection = null;
      try {
        projection = await runner.runShadow(prepared.value, {
          enabled: true,
          core: core,
          modelPort: modelAdapter,
          spec: { provider: spec.provider, model: spec.model, endpoint: spec.endpoint },
          timeoutMs: timeoutMs,
          maxTokens: 1000,
          now: clock
        });
      } catch (error) {
        projection = null;
      }
      if (!projection || projection.ok !== true || !projection.view) {
        counters.failed += 1;
        return fallback('counterfactual-derivation-failed', 'uncertain', counters.calls > callsBefore ? 1 : 0);
      }
      const result = { ok: true, status: 'succeeded', reason: null, view: projection.view,
        text: core.renderGuidance(projection), durable: false, providerCalls: 1 };
      counters.succeeded += 1;
      return result;
    })();
    inFlight.set(key, task);
    let result;
    try { result = await task; }
    catch (_) { counters.failed += 1; result = fallback('counterfactual-runtime-failed', 'uncertain', counters.calls > callsBefore ? 1 : 0); }
    finally { inFlight.delete(key); }
    cache.set(key, { at: now, result: JSON.parse(JSON.stringify(result)) });
    sweep(Number(clock()));
    return result;
  }
  function describe() {
    const ready = !!(registry && typeof registry.getCharacterSpec === 'function'
      && credentialAccess && typeof credentialAccess.resolve === 'function'
      && modelPort && typeof modelPort.run === 'function');
    return Object.assign({}, core.describe(), {
      COUNTERFACTUAL_RUNTIME: ready ? 'LIVE' : 'NOT_READY',
      integrationSeam: 'services/home-node/runtime-recall.js#runCurrentMeaningAndNarrative',
      providerCallsPerEligibleCycle: 1,
      providerCallsPerIneligibleCycle: 0,
      usesExistingCounterfactualTransport: true,
      predictionErrorConsumption: 'SEALED_READ_ONLY_EVIDENCE',
      replay: { scope: 'character+conversation+turn+evidence', maxEntries: MAX_REPLAY_RESULTS, ttlMs: REPLAY_TTL_MS, durable: false },
      counters: Object.assign({}, counters)
    });
  }
  return Object.freeze({ derive: derive, describe: describe, awaitIdle: async function () { return { idle: inFlight.size === 0, inFlight: inFlight.size }; } });
}

module.exports = { createRuntimeCounterfactualMemory: createRuntimeCounterfactualMemory };
