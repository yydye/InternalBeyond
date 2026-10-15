'use strict';
/* ====================================================================
   IB Home Node · P5-B3-D5-R1 · Event Opportunity Authority
   --------------------------------------------------------------------
   A canonical, same-turn TurnTerminal RealityEvent proves that the event
   opportunity completed. Relation is deliberately not inspected here.
   ==================================================================== */

const path = require('path');
const CHAT_CORE = require(path.join(__dirname, '..', '..', 'assets', 'js', 'chat-core.js'));
const PREDICTION_CORE = require(path.join(__dirname, '..', '..', 'assets', 'js', 'memory-recall', 'prediction-record-core.js'));
const OBSERVATION_CORE = require(path.join(__dirname, '..', '..', 'assets', 'js', 'memory-recall', 'outcome-observation-core.js'));
const TURN_TERMINAL_SOURCE = require(path.join(__dirname, 'turn-terminal-reality-source.js'));

const SOURCE_ID = 'turn-terminal';
const SOURCE_INSTANCE = 'runtime.turn-execution';
const SOURCE = 'CANONICAL_RUNTIME';
const DOMAIN = 'runtime';
const TYPE = 'turn_terminal';
const TARGET_DOMAIN = 'runtime_state';

function isPlainObject(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
function text(v) { return v == null ? '' : String(v); }
function finite(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function createRuntimeEventOpportunityAuthority(deps) {
  const d = deps || {};
  const realityEventAuthority = d.realityEventAuthority || null;
  const clock = typeof d.clock === 'function' ? d.clock : function () { return Date.now(); };
  const resolutions = new WeakSet();
  const counters = {
    queries: 0, satisfied: 0, unknown: 0,
    rejectedPrediction: 0, rejectedObservation: 0, rejectedRealityEvent: 0
  };

  function predictionFacts(prediction) {
    const p = isPlainObject(prediction) ? prediction : null;
    const scope = p && isPlainObject(p.scope) ? p.scope : null;
    const sourceRef = p && isPlainObject(p.sourceExpectationRef) ? p.sourceExpectationRef : null;
    const snapshot = p && isPlainObject(p.predictionSnapshotAtCreation) ? p.predictionSnapshotAtCreation : null;
    const payload = snapshot && isPlainObject(snapshot.semanticPayload) ? snapshot.semanticPayload : snapshot;
    const outcome = payload && isPlainObject(payload.expectedOutcome) ? payload.expectedOutcome : null;
    const expectedToken = text(outcome && outcome.token);
    const expectedCode = OBSERVATION_CORE.turnTerminalOutcomeCodeOfToken(expectedToken);
    const window = p && isPlainObject(p.observationWindow) ? p.observationWindow : null;
    const createdAt = finite(p && p.createdAt);
    const opensAt = finite(window && window.opensAt);
    const closesAt = finite(window && window.closesAt);
    if (!p || text(p.predictionType) !== 'event'
      || text(p.contradictionMode) !== 'exclusive_outcome'
      || !p.opportunity || p.opportunity.required !== true
      || text(p.opportunity.kind) !== 'runtime-execution'
      || !expectedCode || !scope || !text(scope.characterId) || !text(scope.conversationId)
      || !sourceRef || !text(sourceRef.turnId)
      || createdAt == null || opensAt == null || closesAt == null || closesAt < opensAt) return null;
    return {
      predictionId: text(p.predictionId),
      createdAt: createdAt,
      opensAt: opensAt,
      closesAt: closesAt,
      characterId: text(scope.characterId),
      conversationId: text(scope.conversationId),
      turnId: text(sourceRef.turnId),
      expectedCode: expectedCode
    };
  }

  function terminalFactsFromEvent(event) {
    if (!realityEventAuthority
      || typeof realityEventAuthority.isRealityEvent !== 'function'
      || typeof realityEventAuthority.getRealityEventById !== 'function'
      || realityEventAuthority.isRealityEvent(event) !== true) return null;
    const eventId = text(event.realityEventId);
    let held = null;
    try { held = realityEventAuthority.getRealityEventById(eventId); } catch (_) { held = null; }
    if (!eventId || held !== event) return null;

    const body = isPlainObject(event.body) ? event.body : null;
    const outcomeCode = text(body && body.outcomeCode);
    const outcomeToken = OBSERVATION_CORE.turnTerminalTokenOfOutcomeCode(outcomeCode);
    const turnId = text(event.entityId);
    const occurredAt = finite(event.occurredAt);
    if (!body || Object.keys(body).length !== 1 || !outcomeToken || !turnId || occurredAt == null
      || text(event.realitySourceId) !== SOURCE_ID
      || text(event.source) !== SOURCE
      || text(event.sourceInstance) !== SOURCE_INSTANCE
      || text(event.domain) !== DOMAIN || text(event.type) !== TYPE
      || !text(event.characterId) || !text(event.conversationId)) return null;

    /* Recompute the D4 source identity from the sealed event facts. */
    let expectedInput = null;
    try {
      expectedInput = TURN_TERMINAL_SOURCE.toRealityEventInput({
        turnId: turnId,
        characterId: text(event.characterId),
        conversationId: text(event.conversationId),
        outcome: outcomeCode,
        occurredAt: occurredAt
      });
    } catch (_) { expectedInput = null; }
    const expected = expectedInput && expectedInput.sourceEvent;
    if (!expected || text(expected.eventId) !== eventId
      || text(expected.entityId) !== turnId
      || Number(expected.timestamp) !== occurredAt) return null;

    return {
      realityEventId: eventId,
      turnId: turnId,
      characterId: text(event.characterId),
      conversationId: text(event.conversationId),
      occurredAt: occurredAt,
      outcomeCode: outcomeCode,
      outcomeToken: outcomeToken,
      terminalFamily: OBSERVATION_CORE.TURN_TERMINAL_TOKEN_FAMILY
    };
  }

  function observationBoundToEvent(observation, facts, terminal, now) {
    const obs = isPlainObject(observation) ? observation : null;
    if (!obs || OBSERVATION_CORE.isBuiltObservation(obs) !== true
      || text(obs.source) !== SOURCE
      || text(obs.sourceInstance) !== SOURCE_INSTANCE
      || text(obs.targetDomain) !== TARGET_DOMAIN
      || !isPlainObject(obs.scope)
      || text(obs.scope.characterId) !== facts.characterId
      || text(obs.scope.conversationId) !== facts.conversationId
      || !isPlainObject(obs.outcomeRef)
      || text(obs.outcomeRef.kind) !== 'token'
      || text(obs.outcomeRef.token) !== terminal.outcomeToken
      || !Array.isArray(obs.evidenceRefs)
      || text(obs.evidenceRefs[0]) !== terminal.realityEventId) return false;

    const observedAt = finite(obs.observedAt);
    const window = isPlainObject(obs.windowRef) ? obs.windowRef : null;
    if (!window || text(window.predictionId) !== facts.predictionId
      || Number(window.opensAt) !== facts.opensAt || Number(window.closesAt) !== facts.closesAt
      || observedAt !== terminal.occurredAt
      || observedAt > now || observedAt < facts.createdAt
      || observedAt < facts.opensAt || observedAt > facts.closesAt) return false;
    return true;
  }

  function opportunityFor(terminal) {
    const opportunityId = 'event_opp_' + CHAT_CORE.stableToken([
      terminal.terminalFamily,
      terminal.realityEventId,
      terminal.turnId,
      terminal.characterId,
      terminal.conversationId,
      String(terminal.occurredAt)
    ].join('|'));
    const identity = Object.freeze({
      opportunityId: opportunityId,
      realityEventId: terminal.realityEventId,
      turnId: terminal.turnId,
      characterId: terminal.characterId,
      conversationId: terminal.conversationId,
      occurredAt: terminal.occurredAt,
      terminalFamily: terminal.terminalFamily
    });
    return Object.freeze({
      required: true,
      kind: 'runtime-execution',
      identity: identity,
      existence: Object.freeze({
        present: true,
        authoritySource: SOURCE,
        opportunityId: opportunityId,
        realityEventId: terminal.realityEventId,
        turnId: terminal.turnId,
        characterId: terminal.characterId,
        conversationId: terminal.conversationId,
        occurredAt: terminal.occurredAt,
        terminalFamily: terminal.terminalFamily
      }),
      consumedAt: terminal.occurredAt
    });
  }

  function resolution(state, terminal, reasonCode) {
    const opportunity = state === 'SATISFIED' && terminal ? opportunityFor(terminal) : null;
    const result = Object.freeze({
      state: state,
      witnessId: terminal ? terminal.realityEventId : null,
      occurredAt: terminal ? terminal.occurredAt : null,
      targetDomain: TARGET_DOMAIN,
      terminalFamily: terminal ? terminal.terminalFamily : null,
      turnId: terminal ? terminal.turnId : null,
      characterId: terminal ? terminal.characterId : null,
      conversationId: terminal ? terminal.conversationId : null,
      opportunity: opportunity,
      reasonCode: reasonCode || 'ok'
    });
    resolutions.add(result);
    if (state === 'SATISFIED') counters.satisfied += 1;
    else counters.unknown += 1;
    return result;
  }

  function resolveForPrediction(input) {
    counters.queries += 1;
    const i = isPlainObject(input) ? input : {};
    const p = isPlainObject(i.prediction) ? i.prediction : null;
    if (p && p.opportunity && p.opportunity.required === false) {
      return resolution('NOT-REQUIRED', null, 'opportunity-not-required');
    }
    const facts = predictionFacts(p);
    if (!facts) {
      counters.rejectedPrediction += 1;
      return resolution('UNKNOWN', null, 'prediction-not-a-scoped-terminal-event');
    }
    const now = finite(i.now);
    if (now == null) return resolution('UNKNOWN', null, 'runtime-time-unavailable');

    const observation = isPlainObject(i.observation) ? i.observation : null;
    if (!observation) return resolution('UNKNOWN', null, 'no-terminal-observation');
    if (!realityEventAuthority || typeof realityEventAuthority.getRealityEventById !== 'function'
      || !Array.isArray(observation.evidenceRefs) || !observation.evidenceRefs.length) {
      counters.rejectedObservation += 1;
      return resolution('UNKNOWN', null, 'terminal-event-reference-unavailable');
    }
    const eventId = text(observation.evidenceRefs[0]);
    let event = null;
    try { event = realityEventAuthority.getRealityEventById(eventId); } catch (_) { event = null; }
    const terminal = terminalFactsFromEvent(event);
    if (!terminal) {
      counters.rejectedRealityEvent += 1;
      return resolution('UNKNOWN', null, 'terminal-reality-event-unavailable-or-unrecognized');
    }
    if (terminal.turnId !== facts.turnId
      || terminal.characterId !== facts.characterId
      || terminal.conversationId !== facts.conversationId
      || terminal.occurredAt < facts.createdAt
      || terminal.occurredAt < facts.opensAt || terminal.occurredAt > facts.closesAt) {
      counters.rejectedPrediction += 1;
      return resolution('UNKNOWN', null, 'terminal-event-prediction-scope-or-window-mismatch');
    }
    if (!observationBoundToEvent(observation, facts, terminal, now)) {
      counters.rejectedObservation += 1;
      return resolution('UNKNOWN', null, 'terminal-observation-not-bound-to-finality');
    }
    return resolution('SATISFIED', terminal, 'canonical-same-turn-terminal-finality');
  }

  return {
    resolveForPrediction: resolveForPrediction,
    isResolution: function (x) { return !!x && resolutions.has(x) && Object.isFrozen(x); },
    isCanonicalTerminalEvent: function (event) { return terminalFactsFromEvent(event) !== null; },
    describe: function () {
      return {
        status: realityEventAuthority
          && typeof realityEventAuthority.isRealityEvent === 'function'
          && typeof realityEventAuthority.getRealityEventById === 'function'
          ? 'LIVE_CAPABLE' : 'UNAVAILABLE',
        authority: 'CANONICAL_RUNTIME_TURN_TERMINAL_FINALITY',
        relationMayCreateOpportunity: 'NO',
        identityContainsPredictionId: 'NO',
        requiresBuiltOutcomeObservation: 'YES',
        requiresSameTurnAndScope: 'YES',
        unknownTerminalOutcome: 'FAIL_CLOSED',
        noTerminalObservation: 'UNKNOWN',
        counters: Object.assign({}, counters)
      };
    }
  };
}

module.exports = { createRuntimeEventOpportunityAuthority: createRuntimeEventOpportunityAuthority };
