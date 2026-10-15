'use strict';
/* ====================================================================
   IB Home Node · P5-B3-I · Subjective Preference Opportunity Authority
   --------------------------------------------------------------------
   This authority recognizes one narrow completed opportunity:
     an accepted, canonical preference-report action for the prediction's
     exact target, character, conversation, and observation window.

   The report proposition remains EXPLICIT_USER_REPORT evidence. The accepted
   report action independently proves a completed, target-specific choice;
   its sealed RealityEvent binds the evidence projection back to that action.
   Relation is never read here, so conflict cannot create its own opportunity.
   ==================================================================== */

const path = require('path');
const PREF = require(path.join(__dirname, '..', '..', 'assets', 'js', 'memory-recall', 'preference-proposition-core.js'));
const REPORT_MODULE = require(path.join(__dirname, 'runtime-explicit-preference-report.js'));
const REPORT_REALITY_SOURCE = require(path.join(__dirname, 'explicit-preference-report-reality-source.js'));

const SOURCE_ID = 'user-explicit-preference-report';
const SOURCE_INSTANCE = 'user.explicit-preference-report';
const DOMAIN = 'user_preference';
const TYPE = 'preference_report';
const AUTHORITY = 'CANONICAL_RUNTIME';

function isPlainObject(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
function text(v) { return v == null ? '' : String(v); }
function finite(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function createRuntimeSubjectiveOpportunityAuthority(deps) {
  const d = deps || {};
  const realityEventAuthority = d.realityEventAuthority || null;
  const reportAuthority = d.reportAuthority || null;
  const clock = typeof d.clock === 'function' ? d.clock : function () { return Date.now(); };
  let authorityStartedAt = null;
  try { authorityStartedAt = finite(clock()); } catch (_) { authorityStartedAt = null; }
  const resolutions = new WeakSet();
  const counters = {
    queries: 0, satisfied: 0, absent: 0, unknown: 0,
    rejectedPrediction: 0, rejectedObservationBinding: 0,
    rejectedRealityEvent: 0, historyIncomplete: 0
  };

  function predictionFacts(prediction) {
    const p = isPlainObject(prediction) ? prediction : null;
    const scope = p && isPlainObject(p.scope) ? p.scope : null;
    const snapshot = p && isPlainObject(p.predictionSnapshotAtCreation) ? p.predictionSnapshotAtCreation : null;
    const payload = snapshot && isPlainObject(snapshot.semanticPayload) ? snapshot.semanticPayload : null;
    const outcome = payload && isPlainObject(payload.expectedOutcome) ? payload.expectedOutcome : null;
    const parsed = PREF.parsePreferenceToken(text(outcome && outcome.token));
    const window = p && isPlainObject(p.observationWindow) ? p.observationWindow : null;
    const createdAt = finite(p && p.createdAt);
    const opensAt = finite(window && window.opensAt);
    const closesAt = finite(window && window.closesAt);
    if (!p || text(p.predictionType) !== 'preference'
      || !p.opportunity || p.opportunity.required !== true
      || text(p.opportunity.kind) !== 'exclusive-choice'
      || !parsed || !scope || !text(scope.characterId) || !text(scope.conversationId)
      || createdAt == null || opensAt == null || closesAt == null || closesAt < opensAt) return null;
    return {
      createdAt: createdAt,
      opensAt: opensAt,
      closesAt: closesAt,
      characterId: text(scope.characterId),
      conversationId: text(scope.conversationId),
      targetKey: parsed.targetKey
    };
  }

  function reportEventFacts(event) {
    if (!realityEventAuthority || typeof realityEventAuthority.isRealityEvent !== 'function'
      || realityEventAuthority.isRealityEvent(event) !== true) return null;
    const body = isPlainObject(event.body) ? event.body : null;
    if (!body || text(event.realitySourceId) !== SOURCE_ID
      || text(event.source) !== 'EXPLICIT_USER_REPORT'
      || text(event.sourceInstance) !== SOURCE_INSTANCE
      || text(event.domain) !== DOMAIN || text(event.type) !== TYPE
      || !text(event.realityEventId) || !text(event.entityId)
      || text(body.reportId) !== text(event.entityId)) return null;
    if (!reportAuthority || typeof reportAuthority.getExplicitPreferenceReportById !== 'function'
      || typeof REPORT_REALITY_SOURCE.toRealityEventInput !== 'function') return null;
    let report = null;
    try { report = reportAuthority.getExplicitPreferenceReportById(body.reportId); } catch (_) { report = null; }
    const rf = reportActionFacts(report);
    if (!rf) return null;
    const expectedInput = REPORT_REALITY_SOURCE.toRealityEventInput(report);
    const expected = expectedInput && expectedInput.sourceEvent;
    if (!expected || text(event.realityEventId) !== text(expected.eventId)
      || text(event.entityId) !== rf.reportId
      || text(event.characterId) !== rf.characterId
      || text(event.conversationId) !== rf.conversationId
      || Number(event.occurredAt) !== Number(expected.timestamp)
      || text(body.targetKey) !== rf.targetKey || text(body.stance) !== rf.stance) return null;
    const targetKey = PREF.canonicalTargetKey(body.targetKey);
    const stance = text(body.stance);
    const occurredAt = finite(event.occurredAt);
    if (targetKey == null || targetKey !== text(body.targetKey)
      || PREF.isStance(stance) !== true || occurredAt == null
      || PREF.buildPreferenceToken(stance, targetKey) == null) return null;
    return {
      realityEventId: text(event.realityEventId),
      reportId: rf.reportId,
      characterId: text(event.characterId),
      conversationId: text(event.conversationId),
      targetKey: targetKey,
      stance: stance,
      token: PREF.buildPreferenceToken(stance, targetKey),
      occurredAt: occurredAt
    };
  }

  function resolution(state, witness, reasonCode) {
    const witnessId = witness ? (text(witness.reportId) || text(witness.realityEventId) || null) : null;
    const opportunity = state === 'SATISFIED'
      ? {
          required: true,
          existence: { present: true, authoritySource: AUTHORITY },
          consumedAt: witness.occurredAt
        }
      : (state === 'ABSENT'
        ? { required: true, existence: { present: false, authoritySource: AUTHORITY } }
        : null);
    const result = Object.freeze({
      state: state,
      witnessId: witnessId,
      occurredAt: witness ? witness.occurredAt : null,
      targetDomain: DOMAIN,
      targetKey: witness ? witness.targetKey : null,
      characterId: witness ? witness.characterId : null,
      conversationId: witness ? witness.conversationId : null,
      opportunity: opportunity,
      reasonCode: reasonCode || 'ok'
    });
    resolutions.add(result);
    if (state === 'SATISFIED') counters.satisfied += 1;
    else if (state === 'ABSENT') counters.absent += 1;
    else counters.unknown += 1;
    return result;
  }

  function eventById(id) {
    if (!realityEventAuthority || typeof realityEventAuthority.getRealityEventById !== 'function') return null;
    try { return realityEventAuthority.getRealityEventById(id); } catch (_) { return null; }
  }

  function queryPreferenceReports(facts, now) {
    if (!reportAuthority || typeof reportAuthority.queryExplicitPreferenceReports !== 'function') {
      return { reports: [], historyComplete: false };
    }
    try {
      return reportAuthority.queryExplicitPreferenceReports({
        characterId: facts.characterId,
        conversationId: facts.conversationId,
        targetKey: facts.targetKey,
        fromAt: Math.max(facts.opensAt, facts.createdAt + 1),
        toAt: Math.min(facts.closesAt, now)
      });
    } catch (_) { return { reports: [], historyComplete: false }; }
  }

  function reportActionFacts(report) {
    if (!REPORT_MODULE.isExplicitPreferenceReport(report)) return null;
    const targetKey = PREF.canonicalTargetKey(report.targetKey);
    const stance = text(report.stance);
    const occurredAt = finite(report.occurredAt);
    if (targetKey == null || targetKey !== text(report.targetKey)
      || PREF.isStance(stance) !== true || occurredAt == null
      || !text(report.reportId) || PREF.buildPreferenceToken(stance, targetKey) == null) return null;
    return {
      reportId: text(report.reportId),
      characterId: text(report.characterId),
      conversationId: text(report.conversationId),
      targetKey: targetKey,
      stance: stance,
      occurredAt: occurredAt
    };
  }

  function matchesPredictionReport(report, facts) {
    const rf = reportActionFacts(report);
    if (!rf) return null;
    if (rf.characterId !== facts.characterId || rf.conversationId !== facts.conversationId
      || rf.targetKey !== facts.targetKey
      || rf.occurredAt <= facts.createdAt
      || rf.occurredAt < facts.opensAt || rf.occurredAt > facts.closesAt) return null;
    return rf;
  }

  function matchesPredictionEvent(event, facts) {
    const ef = reportEventFacts(event);
    if (!ef) return null;
    if (ef.characterId !== facts.characterId || ef.conversationId !== facts.conversationId
      || ef.targetKey !== facts.targetKey
      || ef.occurredAt <= facts.createdAt
      || ef.occurredAt < facts.opensAt || ef.occurredAt > facts.closesAt) return null;
    return ef;
  }

  function observationBoundEvent(observation, facts, now) {
    const obs = isPlainObject(observation) ? observation : null;
    if (!obs || text(obs.source) !== 'EXPLICIT_USER_REPORT'
      || text(obs.sourceInstance) !== SOURCE_INSTANCE
      || text(obs.targetDomain) !== DOMAIN
      || !isPlainObject(obs.outcomeRef) || text(obs.outcomeRef.kind) !== 'token'
      || !Array.isArray(obs.evidenceRefs) || !obs.evidenceRefs.length) return null;
    const observedAt = finite(obs.observedAt);
    const ids = obs.evidenceRefs.map(text);
    for (let i = 0; i < ids.length; i += 1) {
      const event = eventById(ids[i]);
      if (!event) continue;
      const ef = matchesPredictionEvent(event, facts);
      if (!ef) continue;
      const obsScope = isPlainObject(obs.scope) ? obs.scope : null;
      if (!obsScope || text(obsScope.characterId) !== ef.characterId
        || text(obsScope.conversationId) !== ef.conversationId
        || text(obs.outcomeRef.token) !== ef.token
        || observedAt !== ef.occurredAt || ef.occurredAt > now) continue;
      return ef;
    }
    return null;
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
      return resolution('UNKNOWN', null, 'prediction-not-a-scoped-preference-choice');
    }
    const now = finite(i.now);
    if (now == null) return resolution('UNKNOWN', null, 'runtime-time-unavailable');

    const bound = observationBoundEvent(i.observation, facts, now);
    if (bound) return resolution('SATISFIED', bound, 'canonical-preference-choice-observed');
    if (i.observation) counters.rejectedObservationBinding += 1;

    const reportQuery = queryPreferenceReports(facts, now);
    const reports = Array.isArray(reportQuery.reports) ? reportQuery.reports : [];
    let matchingReport = null;
    for (let n = 0; n < reports.length; n += 1) {
      const rf = matchesPredictionReport(reports[n], facts);
      if (rf) { matchingReport = rf; break; }
    }

    /* An accepted report action can establish that the choice was completed,
       even if its downstream RealityEvent mint failed. It cannot create an
       OutcomeObservation or become evidence by itself. */
    if (!i.observation && matchingReport) {
      return resolution('SATISFIED', matchingReport, 'canonical-preference-choice-accepted');
    }
    /* With an observation, only the sealed RealityEvent can bind its evidence
       and opportunity. A report without that event stays non-decisive. */
    if (i.observation && matchingReport) {
      return resolution('UNKNOWN', null, 'accepted-report-has-no-bound-reality-event');
    }

    if (now < facts.closesAt) return resolution('UNKNOWN', null, 'preference-window-open');
    const coveredFromStart = authorityStartedAt != null && facts.createdAt >= authorityStartedAt;
    if (reportQuery.historyComplete === true && coveredFromStart) {
      return resolution('ABSENT', null, 'no-canonical-preference-choice-in-complete-window');
    }
    counters.historyIncomplete += 1;
    return resolution('UNKNOWN', null, 'preference-opportunity-history-incomplete');
  }

  return {
    resolveForPrediction: resolveForPrediction,
    isResolution: function (x) { return !!x && resolutions.has(x) && Object.isFrozen(x); },
    describe: function () {
      return {
        status: realityEventAuthority && typeof realityEventAuthority.queryRealityEvents === 'function'
          && reportAuthority && typeof reportAuthority.queryExplicitPreferenceReports === 'function'
          && typeof reportAuthority.getExplicitPreferenceReportById === 'function'
          ? 'LIVE_CAPABLE' : 'UNAVAILABLE',
        authority: 'CANONICAL_EXPLICIT_PREFERENCE_ACTION_PLUS_RUNTIME_EVENT_OBSERVER',
        source: SOURCE_ID,
        opportunityKind: 'exclusive-choice',
        eventIdentityIndependentOfPrediction: 'YES',
        requiresSealedRealityEvent: 'YES',
        requiresCanonicalAcceptedReportForAbsence: 'YES',
        evidenceAuthorityIsSeparate: 'YES',
        relationMayCreateOpportunity: 'NO',
        targetAndScopeMustMatch: 'YES',
        occurrenceTimeComesFromRealityEvent: 'YES',
        absentRequiresClosedWindowAndCompleteReportHistory: 'YES',
        feedbackDriverMaySupplyOpportunity: 'NO',
        memoryWrites: 0,
        relationshipWrites: 0,
        counters: Object.assign({}, counters)
      };
    }
  };
}

module.exports.createRuntimeSubjectiveOpportunityAuthority = createRuntimeSubjectiveOpportunityAuthority;
