'use strict';

/* P5-B3-L-R1 · Canonical UserMessage → bounded P1 linguistic evidence.
   This adapter observes a sealed post-commit fact from Home Node chat-store.
   It does not own chat identity, interpret meaning, mint RealityEvents, or
   provide any relation/authority to P3. */

const path = require('path');
const ASSETS_JS = path.join(__dirname, '..', '..', 'assets', 'js');
const CHAT_CORE = require(path.join(ASSETS_JS, 'chat-core.js'));

const PRODUCER_ID = 'linguistic-evidence';
const TARGET_DOMAIN = 'user_preference';
const MAX_FACTS = 512;
const MAX_PENDING = 128;
const MAX_STATEMENT_CHARS = 400;

function isPlainObject(value) { return !!value && typeof value === 'object' && !Array.isArray(value); }
function text(value) { return value == null ? '' : String(value); }

function createRuntimeLinguisticEvidenceProducer(deps) {
  const d = deps || {};
  const registry = d.registry || null;
  const characterRegistry = d.characterRegistry || null;
  const observationRuntime = d.observationRuntime || null;
  const settlementRuntime = d.settlementRuntime || null;
  const isCanonicalUserMessageFact = typeof d.isCanonicalUserMessageFact === 'function'
    ? d.isCanonicalUserMessageFact : function () { return false; };
  const matcherEnabled = d.matcherEnabled === true;
  const onSettlement = typeof d.onSettlement === 'function' ? d.onSettlement : null;
  const logger = typeof d.logger === 'function' ? d.logger : null;
  const clock = typeof d.clock === 'function' ? d.clock : (() => Date.now());
  const maxFacts = Number.isFinite(Number(d.maxFacts)) && Number(d.maxFacts) > 0
    ? Math.min(MAX_FACTS, Number(d.maxFacts)) : MAX_FACTS;
  const maxPending = Number.isFinite(Number(d.maxPending)) && Number(d.maxPending) > 0
    ? Math.min(MAX_PENDING, Number(d.maxPending)) : MAX_PENDING;

  /* Message ID is the evidence-fact identity. Prediction ID is deliberately
     added only by P1 when projecting one fact into prediction-scoped records. */
  const seenMessages = new Map();
  const pending = new Set();
  const counters = {
    storeCallbackAttempts: 0, factsAccepted: 0, duplicateFactsSuppressed: 0,
    rejectedUnsealedFact: 0, rejectedMessageShape: 0, rejectedCharacter: 0,
    candidatePredictions: 0, nonPreferencePredictionsSkipped: 0,
    observationsMinted: 0, observationsDeduplicated: 0, p1Refused: 0,
    p3Attempts: 0, p3Failures: 0, postSettlementCallbacks: 0,
    postSettlementFailures: 0, pendingCapacityExceeded: 0,
    matcherRelationsApplied: 0, matcherRelationsAmbiguous: 0,
    supportNonDecisive: 0, supportDecisive: 0,
    conflictNonDecisive: 0, conflictDecisive: 0,
    matchedSettlements: 0, missedSettlements: 0, unclassifiableSettlements: 0,
    calibrationCountedSettlements: 0,
    durableWrites: 0, memoryWrites: 0, relationshipWrites: 0
  };

  function rememberMessage(messageId) {
    seenMessages.set(messageId, Number(clock()));
    while (seenMessages.size > maxFacts) {
      const oldest = seenMessages.keys().next();
      if (oldest.done) break;
      seenMessages.delete(oldest.value);
    }
  }

  function canonicalRecordOf(fact) {
    let valid = false;
    try { valid = isCanonicalUserMessageFact(fact) === true; } catch (_) { valid = false; }
    if (!valid || !isPlainObject(fact)) return null;
    const sourceMessageId = text(fact.sourceMessageId).trim();
    const characterId = text(fact.characterId).trim();
    const conversationId = text(fact.conversationId).trim();
    const threadId = text(fact.threadId).trim();
    const occurredAt = Number(fact.occurredAt);
    const statementText = text(fact.statementText).slice(0, MAX_STATEMENT_CHARS);
    if (fact.role !== 'user' || !sourceMessageId || !characterId || !conversationId
      || !Number.isFinite(occurredAt) || occurredAt <= 0 || !statementText.trim()) return null;
    /* Conversation scope is re-derived from the persisted character/thread pair. */
    let derivedConversation = null;
    try { derivedConversation = CHAT_CORE.conversationIdOf(characterId, threadId); } catch (_) { derivedConversation = null; }
    if (!derivedConversation || derivedConversation !== conversationId) return null;
    return {
      sourceMessageId: sourceMessageId,
      characterId: characterId,
      conversationId: conversationId,
      threadId: threadId,
      occurredAt: Math.trunc(occurredAt),
      statementText: statementText
    };
  }

  function characterIsBound(characterId) {
    if (!characterRegistry || typeof characterRegistry.getCharacterSpec !== 'function') return false;
    try { return !!characterRegistry.getCharacterSpec(characterId); } catch (_) { return false; }
  }

  function reportSettlement(settled) {
    if (!settled || !settled.settlement || !onSettlement) return;
    counters.postSettlementCallbacks += 1;
    try {
      const result = onSettlement(settled.settlement, settled.predictionError);
      if (result && typeof result.then === 'function') {
        return result.then((out) => {
          if (!out || out.ok !== true) counters.postSettlementFailures += 1;
        }, () => { counters.postSettlementFailures += 1; });
      }
      if (!result || result.ok !== true) counters.postSettlementFailures += 1;
    } catch (_) {
      counters.postSettlementFailures += 1;
    }
    return null;
  }

  async function projectAndSettle(record, fact) {
    const predictionId = text(record && record.predictionId);
    const predictionWindow = record && record.observationWindow;
    if (!record || record.predictionType !== 'preference' || !isPlainObject(predictionWindow)) {
      counters.nonPreferencePredictionsSkipped += 1;
      return;
    }
    const minted = observationRuntime.mintObservation({
      producerId: PRODUCER_ID,
      targetDomain: TARGET_DOMAIN,
      predictionRef: {
        predictionId: predictionId,
        opensAt: predictionWindow.opensAt,
        closesAt: predictionWindow.closesAt,
        predictionCreatedAt: record.createdAt
      },
      subjectKind: text(record.scope && record.scope.subjectKind) || 'user',
      subjectLabel: text(record.scope && record.scope.subjectLabel),
      completeness: 'point',
      evidenceRefs: [fact.sourceMessageId],
      sourceEvent: {
        sourceEventId: fact.sourceMessageId,
        characterId: fact.characterId,
        conversationId: fact.conversationId,
        occurredAt: fact.occurredAt,
        kind: 'statement',
        statement: fact.statementText,
        payload: {}
      }
    });
    if (!minted || minted.ok !== true || !minted.observation) {
      counters.p1Refused += 1;
      return;
    }
    if (minted.status === 'duplicate' || minted.reused === true) {
      counters.observationsDeduplicated += 1;
      return;
    }
    counters.observationsMinted += 1;

    if (!settlementRuntime) return;
    let settled = null;
    counters.p3Attempts += 1;
    try {
      const context = { now: Number(clock()) || fact.occurredAt };
      if (matcherEnabled && typeof settlementRuntime.settlePredictionWithEvidenceMatcher === 'function') {
        settled = await settlementRuntime.settlePredictionWithEvidenceMatcher(record,
          [{ observation: minted.observation }], context);
      } else if (typeof settlementRuntime.settlePrediction === 'function') {
        settled = settlementRuntime.settlePrediction(record, [{ observation: minted.observation }], context);
      }
    } catch (error) {
      counters.p3Failures += 1;
      if (logger) logger('linguistic-evidence-p3-failed', {
        sourceMessageId: fact.sourceMessageId, predictionId: predictionId,
        error: String((error && error.message) || error).slice(0, 160)
      });
      return;
    }
    const settlement = settled && settled.settlement;
    if (settlement) {
      const trace = settlement.trace || {};
      counters.matcherRelationsApplied += Number(trace.matcherRelationsApplied) || 0;
      counters.matcherRelationsAmbiguous += Number(trace.matcherRelationsAmbiguous) || 0;
      counters.supportNonDecisive += Number(trace.supportNonDecisive) || 0;
      counters.supportDecisive += Number(trace.supportDecisive) || 0;
      counters.conflictNonDecisive += Number(trace.conflictNonDecisive) || 0;
      counters.conflictDecisive += Number(trace.conflictDecisive) || 0;
      if (settlement.state === 'matched') counters.matchedSettlements += 1;
      if (settlement.state === 'missed') counters.missedSettlements += 1;
      if (Array.isArray(settlement.reasonCodes)
        && settlement.reasonCodes.indexOf('relation-unclassifiable-without-evidence-matcher') >= 0) {
        counters.unclassifiableSettlements += 1;
      }
      if (settlement.calibrationCounted === true) counters.calibrationCountedSettlements += 1;
    }
    await reportSettlement(settled);
  }

  async function processFact(fact) {
    if (!characterIsBound(fact.characterId)) {
      counters.rejectedCharacter += 1;
      return;
    }
    if (!observationRuntime || typeof observationRuntime.candidatePredictions !== 'function'
      || typeof observationRuntime.mintObservation !== 'function'
      || !registry || typeof registry.getPrediction !== 'function') return;

    let predictionIds = [];
    try {
      predictionIds = observationRuntime.candidatePredictions({
        characterId: fact.characterId,
        conversationId: fact.conversationId,
        occurredAt: fact.occurredAt
      }, { characterId: fact.characterId, conversationId: fact.conversationId }) || [];
    } catch (_) { predictionIds = []; }
    counters.candidatePredictions += Array.isArray(predictionIds) ? predictionIds.length : 0;
    for (const predictionId of (Array.isArray(predictionIds) ? predictionIds : [])) {
      let record = null;
      try { record = registry.getPrediction(predictionId); } catch (_) { record = null; }
      if (!record || record.predictionType !== 'preference') {
        counters.nonPreferencePredictionsSkipped += 1;
        continue;
      }
      const scope = record.scope || {};
      if (text(scope.characterId) !== fact.characterId || text(scope.conversationId) !== fact.conversationId) continue;
      await projectAndSettle(record, fact);
    }
  }

  function onCanonicalUserMessage(fact) {
    counters.storeCallbackAttempts += 1;
    const canonical = canonicalRecordOf(fact);
    if (!canonical) {
      counters.rejectedUnsealedFact += 1;
      return { ok: false, status: 'refused', reasonCode: 'canonical-user-message-fact-required' };
    }
    if (seenMessages.has(canonical.sourceMessageId)) {
      counters.duplicateFactsSuppressed += 1;
      return { ok: true, status: 'duplicate', sourceMessageId: canonical.sourceMessageId };
    }
    rememberMessage(canonical.sourceMessageId);
    if (pending.size >= maxPending) {
      counters.pendingCapacityExceeded += 1;
      return { ok: false, status: 'capacity', reasonCode: 'linguistic-evidence-pending-capacity' };
    }
    counters.factsAccepted += 1;
    let task = null;
    task = Promise.resolve().then(() => processFact(canonical)).catch((error) => {
      counters.p3Failures += 1;
      if (logger) logger('linguistic-evidence-failed', {
        sourceMessageId: canonical.sourceMessageId,
        error: String((error && error.message) || error).slice(0, 160)
      });
    }).finally(() => pending.delete(task));
    pending.add(task);
    return { ok: true, status: 'scheduled', sourceMessageId: canonical.sourceMessageId };
  }

  function describe() {
    return {
      status: 'LIVE_CAPABLE',
      owner: 'HOME_NODE_CHAT_STORE_POST_COMMIT',
      inputAuthority: 'SEALED_CANONICAL_USER_MESSAGE_FACT',
      source: 'LINGUISTIC_EVIDENCE',
      producerId: PRODUCER_ID,
      targetDomain: TARGET_DOMAIN,
      predictionFamilies: ['preference'],
      identity: 'CANONICAL_SOURCE_MESSAGE_ID',
      occurredAtAuthority: 'CHAT_STORE_CHANGE_LOG_SERVER_TIME',
      rawChatIsExplicitReport: 'NO',
      memoryAuthority: 'NONE',
      relationshipAuthority: 'NONE',
      durableEvidenceStore: 'NO',
      maxFacts: maxFacts,
      maxPending: maxPending,
      pending: pending.size,
      counters: Object.assign({}, counters)
    };
  }

  return Object.freeze({
    onCanonicalUserMessage: onCanonicalUserMessage,
    describe: describe,
    awaitIdle: async function (timeoutMs) {
      const requested = Number(timeoutMs);
      const boundedTimeout = Number.isFinite(requested) && requested > 0 ? Math.min(requested, 30000) : 5000;
      const deadline = Date.now() + boundedTimeout;
      while (pending.size > 0) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        let timer = null;
        try {
          await Promise.race([
            Promise.all(Array.from(pending)),
            new Promise(resolve => { timer = setTimeout(resolve, remaining); })
          ]);
        } finally {
          if (timer) clearTimeout(timer);
        }
      }
      return { idle: pending.size === 0, pending: pending.size, timeoutMs: boundedTimeout };
    }
  });
}

module.exports = { createRuntimeLinguisticEvidenceProducer: createRuntimeLinguisticEvidenceProducer };
