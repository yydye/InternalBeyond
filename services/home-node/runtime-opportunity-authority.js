'use strict';
/* ====================================================================
   IB Home Node · Runtime Opportunity Authority Router
   --------------------------------------------------------------------
   Keeps event and subjective opportunity semantics in separate owners.
   It routes and validates sealed resolutions only; it creates no outcome.
   ==================================================================== */

function isPlainObject(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
function text(v) { return v == null ? '' : String(v); }

function createRuntimeOpportunityAuthority(deps) {
  const d = deps || {};
  const eventAuthority = d.eventAuthority || null;
  const subjectiveAuthority = d.subjectiveAuthority || null;

  function ownerFor(prediction) {
    const p = isPlainObject(prediction) ? prediction : null;
    if (!p) return null;
    if (text(p.predictionType) === 'event'
      || text(p.opportunity && p.opportunity.kind) === 'runtime-execution') return eventAuthority;
    return subjectiveAuthority;
  }

  function resolveForPrediction(input) {
    const i = isPlainObject(input) ? input : {};
    const owner = ownerFor(i.prediction);
    if (!owner || typeof owner.resolveForPrediction !== 'function') return null;
    try { return owner.resolveForPrediction(i); } catch (_) { return null; }
  }

  function isResolution(value) {
    return !!value && (
      !!eventAuthority && typeof eventAuthority.isResolution === 'function' && eventAuthority.isResolution(value) === true
      || !!subjectiveAuthority && typeof subjectiveAuthority.isResolution === 'function' && subjectiveAuthority.isResolution(value) === true
    );
  }

  return {
    resolveForPrediction: resolveForPrediction,
    isResolution: isResolution,
    describe: function () {
      const event = eventAuthority && typeof eventAuthority.describe === 'function' ? eventAuthority.describe() : null;
      const subjective = subjectiveAuthority && typeof subjectiveAuthority.describe === 'function' ? subjectiveAuthority.describe() : null;
      return {
        status: event && event.status === 'LIVE_CAPABLE' && subjective && subjective.status === 'LIVE_CAPABLE'
          ? 'LIVE_CAPABLE' : 'PARTIAL_OR_UNAVAILABLE',
        authority: 'PREDICTION_TYPE_ROUTER',
        relationMayCreateOpportunity: 'NO',
        eventOpportunityOwner: event && event.authority || null,
        subjectiveOpportunityOwner: subjective && subjective.authority || null,
        eventAndSubjectiveSemanticsSeparated: 'YES'
      };
    }
  };
}

module.exports = { createRuntimeOpportunityAuthority: createRuntimeOpportunityAuthority };
