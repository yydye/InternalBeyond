/* ====================================================================
   IB Memory · Meta-Memory Awareness Core (P21-R4-N)
   --------------------------------------------------------------------
   Pure, turn-scoped awareness derived only from already-selected Recall,
   Semantic Forgetting projections, validated reinterpretation, and
   provenance-carrying Self Narrative. No Memory reads or writes, provider,
   clock, random source, durable state, or authority mutation.
   ==================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.IBMetaMemoryAwarenessCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var SCHEMA_VERSION = 'meta-memory-awareness-v1';
  var AUTHORITY = 'DERIVED_MEMORY_STATE_AWARENESS';
  var DURABILITY = 'TURN_SCOPED';
  var STATES = Object.freeze(['remembered', 'partial', 'uncertain', 'faded', 'interpretation_only', 'unavailable']);
  var FORGETTING_STATES = ['accessible', 'faded', 'suppressed', 'latent'];
  var UNCERTAINTY = ['low', 'medium', 'high', 'unresolved'];
  var CLAIM_SECTIONS = [
    'themes', 'currentBeliefs', 'relationshipBeliefs', 'unresolvedTensions',
    'resolvedTensions', 'turningPoints', 'continuityClaims'
  ];
  var RELATIONS = ['support', 'complement', 'conflict', 'correction', 'continuation', 'contextualize', 'unrelated'];
  var MAX_SELECTED = 32;
  var MAX_ID_CHARS = 240;
  var MAX_INTERPRETATION_REFS = 4;

  function isPlainObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    var proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
  }
  function uniqueIds(values, max) {
    var out = [], seen = Object.create(null);
    (Array.isArray(values) ? values : []).forEach(function (value) {
      if (value == null) return;
      var id = String(value);
      if (!id || id.length > MAX_ID_CHARS || seen[id] || out.length >= max) return;
      seen[id] = true;
      out.push(id);
    });
    return out;
  }
  function uncertaintyOf(value) {
    return UNCERTAINTY.indexOf(String(value || '')) >= 0 ? String(value) : 'unknown';
  }
  function stateForForgetting(value) {
    if (value === 'accessible') return 'remembered';
    if (value === 'faded') return 'faded';
    if (value === 'suppressed') return 'partial';
    return 'unavailable';
  }
  function isForgettingProjection(value) {
    return isPlainObject(value)
      && value.schemaVersion === 'semantic-forgetting-v1'
      && FORGETTING_STATES.indexOf(String(value.accessibility || '')) >= 0
      && FORGETTING_STATES.indexOf(String(value.factualDetail || '')) >= 0
      && FORGETTING_STATES.indexOf(String(value.emotionalResidue || '')) >= 0
      && FORGETTING_STATES.indexOf(String(value.narrativeMeaning || '')) >= 0
      && typeof value.resurfaced === 'boolean';
  }
  function forgettingById(entries, selectedIds) {
    if (!Array.isArray(entries)) return { ok: false, byId: Object.create(null) };
    var selected = Object.create(null), out = Object.create(null), invalid = false;
    selectedIds.forEach(function (id) { selected[id] = true; });
    entries.forEach(function (entry) {
      if (!isPlainObject(entry) || entry.memoryId == null) return;
      var id = String(entry.memoryId);
      if (!selected[id]) return; /* Ignore anything outside this Recall selection. */
      if (Object.prototype.hasOwnProperty.call(out, id) || !isForgettingProjection(entry.projection)) {
        invalid = true;
        return;
      }
      var projection = entry.projection;
      out[id] = {
        accessibility: projection.accessibility,
        factualDetail: projection.factualDetail,
        emotionalResidue: projection.emotionalResidue,
        narrativeMeaning: projection.narrativeMeaning,
        resurfaced: projection.resurfaced
      };
    });
    if (invalid) return { ok: false, byId: Object.create(null) };
    return { ok: true, byId: out };
  }
  function normalizeMeaning(result, trace, allowedRefs) {
    var contextual = result && result.ok === true && isPlainObject(result.contextualInterpretation)
      ? result.contextualInterpretation : null;
    var meaning = contextual && isPlainObject(contextual.currentMeaning)
      ? contextual.currentMeaning
      : (trace && isPlainObject(trace.currentMeaning) ? trace.currentMeaning : null);
    if (!meaning) return { ok: true, value: null };
    if (UNCERTAINTY.indexOf(String(meaning.uncertainty || '')) < 0) return { ok: false, value: null };
    var sections = ['historicalFacts', 'historicalEmotions', 'currentKnowledge', 'currentBeliefs'];
    var refs = Object.create(null), out = { uncertainty: String(meaning.uncertainty), refs: {} };
    for (var i = 0; i < sections.length; i++) {
      var section = sections[i];
      if (!Array.isArray(meaning[section]) || meaning[section].length > 8) return { ok: false, value: null };
      var ids = [];
      for (var j = 0; j < meaning[section].length; j++) {
        var claim = meaning[section][j];
        if (!isPlainObject(claim) || claim.memoryId == null || typeof claim.statement !== 'string') {
          return { ok: false, value: null };
        }
        var id = String(claim.memoryId);
        if (!id || id.length > MAX_ID_CHARS || !allowedRefs[id]) return { ok: false, value: null };
        refs[id] = true;
        if (ids.indexOf(id) < 0) ids.push(id);
      }
      out.refs[section] = ids;
    }
    var identity = contextual && contextual.identity
      ? contextual.identity : (trace && trace.identity ? trace.identity : null);
    out.identityRef = identity && identity.value != null ? String(identity.value).slice(0, 160) : null;
    out.memoryIds = Object.keys(refs).slice(0, MAX_SELECTED);
    out.directMemoryIds = uniqueIds(trace && trace.directMemoryIds, 8);
    out.associatedMemoryIds = uniqueIds(trace && trace.associatedMemoryIds, 4);
    out.associationRelations = [];
    (Array.isArray(trace && trace.relationsUsed) ? trace.relationsUsed : []).slice(0, 12).forEach(function (edge) {
      if (!isPlainObject(edge) || edge.anchorMemoryId == null || edge.relatedMemoryId == null
        || RELATIONS.indexOf(String(edge.relation || '')) < 0) return;
      out.associationRelations.push({
        anchorMemoryId: String(edge.anchorMemoryId).slice(0, MAX_ID_CHARS),
        relatedMemoryId: String(edge.relatedMemoryId).slice(0, MAX_ID_CHARS),
        relation: String(edge.relation),
        pairRole: edge.pairRole === 'candidate_candidate' ? 'candidate_candidate' : 'anchor_candidate'
      });
    });
    return { ok: true, value: out };
  }
  function normalizeNarrative(result, allowedRefs) {
    var view = result && result.ok === true && isPlainObject(result.narrative)
      ? result.narrative : null;
    var narrative = view && isPlainObject(view.narrative) ? view.narrative : null;
    if (!narrative) return { ok: true, value: null };
    if (UNCERTAINTY.indexOf(String(narrative.uncertainty || '')) < 0) return { ok: false, value: null };
    var claims = [], refs = [];
    for (var i = 0; i < CLAIM_SECTIONS.length; i++) {
      var section = CLAIM_SECTIONS[i];
      var rows = narrative[section];
      if (!Array.isArray(rows) || rows.length > 2) return { ok: false, value: null };
      for (var j = 0; j < rows.length; j++) {
        var claim = rows[j];
        if (!isPlainObject(claim) || !Array.isArray(claim.evidenceMemoryIds)) return { ok: false, value: null };
        var evidenceIds = uniqueIds(claim.evidenceMemoryIds, MAX_SELECTED);
        if (evidenceIds.some(function (id) { return !allowedRefs[id]; })) return { ok: false, value: null };
        evidenceIds.forEach(function (id) { if (refs.indexOf(id) < 0) refs.push(id); });
        claims.push({ section: section, state: 'interpretation_only', evidenceMemoryIds: evidenceIds });
      }
    }
    var evidenceMemoryIds = uniqueIds(view.evidenceMemoryIds, MAX_SELECTED);
    if (evidenceMemoryIds.some(function (id) { return !allowedRefs[id]; })) return { ok: false, value: null };
    evidenceMemoryIds.forEach(function (id) { if (refs.indexOf(id) < 0) refs.push(id); });
    return {
      ok: true,
      value: {
        uncertainty: String(narrative.uncertainty),
        evidenceMemoryIds: refs.slice(0, MAX_SELECTED),
        interpretationRefs: uniqueIds(view.interpretationRefs, MAX_INTERPRETATION_REFS),
        claims: claims
      }
    };
  }
  function statusForUncertainty(uncertainty) {
    return uncertainty === 'low' ? 'interpretation_only' : 'uncertain';
  }

  function derive(input) {
    var src = isPlainObject(input) ? input : {};
    if (!Array.isArray(src.selectedIds) || !Array.isArray(src.semanticForgettingById)) {
      return { ok: false, status: 'failed', reason: 'meta-memory-input-shape-invalid', awareness: null };
    }
    var selectedIds = uniqueIds(src.selectedIds, MAX_SELECTED);
    var forgetting = forgettingById(src.semanticForgettingById, selectedIds);
    if (!forgetting.ok) {
      return { ok: false, status: 'failed', reason: 'semantic-forgetting-projection-invalid', awareness: null };
    }
    var allowedRefs = Object.create(null);
    selectedIds.forEach(function (id) { allowedRefs[id] = true; });
    uniqueIds(src.reinterpretationTrace && src.reinterpretationTrace.directMemoryIds, 8)
      .concat(uniqueIds(src.reinterpretationTrace && src.reinterpretationTrace.associatedMemoryIds, 4))
      .forEach(function (id) { allowedRefs[id] = true; });
    var meaning = normalizeMeaning(src.reinterpretationResult, src.reinterpretationTrace, allowedRefs);
    var narrative = normalizeNarrative(src.selfNarrativeResult, allowedRefs);
    if (!meaning.ok || !narrative.ok) {
      return { ok: false, status: 'failed', reason: 'derived-cognition-schema-invalid', awareness: null };
    }
    var memoryStates = selectedIds.map(function (memoryId) {
      var projection = forgetting.byId[memoryId] || null;
      return {
        memoryId: memoryId,
        state: projection ? stateForForgetting(projection.accessibility) : 'unavailable',
        factualDetail: projection ? stateForForgetting(projection.factualDetail) : 'unavailable',
        emotionalResidue: projection ? stateForForgetting(projection.emotionalResidue) : 'unavailable',
        narrativeMeaning: projection ? stateForForgetting(projection.narrativeMeaning) : 'unavailable',
        source: 'selected_recall',
        resurfaced: projection ? projection.resurfaced : false
      };
    });
    var currentMeaning = meaning.value;
    var selfNarrative = narrative.value;
    var awareness = {
      schemaVersion: SCHEMA_VERSION,
      authority: AUTHORITY,
      durability: DURABILITY,
      states: STATES.slice(),
      memoryStates: memoryStates,
      reinterpretation: currentMeaning ? {
        state: statusForUncertainty(currentMeaning.uncertainty),
        authority: 'DERIVED_CURRENT_INTERPRETATION',
        source: 'current_derived_interpretation',
        historicalClaimsAreWorldFacts: 'NO',
        uncertainty: currentMeaning.uncertainty,
        historicalFactMemoryIds: currentMeaning.refs.historicalFacts,
        historicalEmotionMemoryIds: currentMeaning.refs.historicalEmotions,
        currentKnowledgeMemoryIds: currentMeaning.refs.currentKnowledge,
        currentBeliefMemoryIds: currentMeaning.refs.currentBeliefs,
        directMemoryIds: currentMeaning.directMemoryIds,
        associatedMemoryIds: currentMeaning.associatedMemoryIds,
        associationRelations: currentMeaning.associationRelations,
        interpretationRef: currentMeaning.identityRef
      } : {
        state: 'unavailable', authority: 'UNAVAILABLE', source: 'unavailable', uncertainty: 'unknown',
        historicalFactMemoryIds: [], historicalEmotionMemoryIds: [],
        currentKnowledgeMemoryIds: [], currentBeliefMemoryIds: [], directMemoryIds: [],
        associatedMemoryIds: [], associationRelations: [], interpretationRef: null
      },
      selfNarrative: selfNarrative ? {
        state: statusForUncertainty(selfNarrative.uncertainty),
        authority: 'DERIVED_CURRENT_NARRATIVE',
        source: 'current_derived_narrative',
        uncertainty: selfNarrative.uncertainty,
        evidenceMemoryIds: selfNarrative.evidenceMemoryIds,
        interpretationRefs: selfNarrative.interpretationRefs,
        claims: selfNarrative.claims
      } : {
        state: 'unavailable', authority: 'UNAVAILABLE', source: 'unavailable', uncertainty: 'unknown',
        evidenceMemoryIds: [], interpretationRefs: [], claims: []
      }
    };
    return { ok: true, status: 'succeeded', reason: null, awareness: awareness };
  }

  function renderGuidance(result) {
    if (!result || result.ok !== true || !isPlainObject(result.awareness)) return '';
    var awareness = result.awareness;
    var memories = Array.isArray(awareness.memoryStates) ? awareness.memoryStates : [];
    if (!memories.length) return '';
    var lines = [
      '只根据本轮已召回记录实际包含的内容描述过去；若出现当前重释或自我叙事，它们是现在形成的理解，不是原始事件事实或当时感受。'
    ];
    var hasLimitedFactDetail = memories.some(function (row) {
      return row.factualDetail === 'partial' || row.factualDetail === 'faded' || row.factualDetail === 'unavailable';
    });
    var affectOutlivesDetail = memories.some(function (row) {
      return (row.factualDetail === 'partial' || row.factualDetail === 'faded' || row.factualDetail === 'unavailable')
        && (row.emotionalResidue === 'remembered' || row.emotionalResidue === 'partial');
    });
    var interpretationUncertain = awareness.reinterpretation.state === 'uncertain'
      || awareness.selfNarrative.state === 'uncertain';
    if (hasLimitedFactDetail) {
      lines.push('部分事实细节已经模糊、只有片段或不可用；不要补写原话、日期或缺失情节，未知就保持未知。');
    }
    if (affectOutlivesDetail) {
      lines.push('情绪印象可能仍然清楚，即使事件细节或具体措辞已经模糊。');
    }
    if (interpretationUncertain) {
      lines.push('当前解释或自我叙事仍有不确定之处；保留这种不确定，不要把它说成确定的历史事实。');
    }
    lines.push('这些认识只校准回忆的确定程度，不要求主动提起或披露某段记忆。');
    return lines.join('\n');
  }

  function describe() {
    return {
      META_MEMORY_RUNTIME: 'LIVE',
      MEMORY_STATE_AWARENESS: 'LIVE',
      FORGETTING_AWARENESS: 'LIVE',
      INTERPRETATION_VS_FACT_AWARENESS: 'LIVE',
      UNCERTAINTY_AWARENESS: 'LIVE',
      META_MEMORY_IS_DERIVED: 'YES',
      META_MEMORY_MAY_DESCRIBE_MEMORY_STATE: 'YES',
      META_MEMORY_MAY_NOT_REWRITE_MEMORY: 'YES',
      META_MEMORY_MAY_NOT_DELETE_MEMORY: 'YES',
      META_MEMORY_MAY_NOT_CHANGE_FORGETTING_STATE: 'YES',
      META_MEMORY_MAY_NOT_MUTATE_RELATIONSHIP: 'YES',
      META_MEMORY_MAY_NOT_MUTATE_PERSONA: 'YES',
      META_MEMORY_MAY_NOT_MUTATE_SELF_NARRATIVE: 'YES',
      META_MEMORY_MAY_NOT_MUTATE_BEHAVIOR_MODULATION: 'YES',
      META_MEMORY_MAY_NOT_MUTATE_PREDICTION_ERROR: 'YES',
      META_MEMORY_DOES_NOT_REWRITE_MEMORY: 'VERIFIED',
      FAILURE_FALLBACK: 'LIVE',
      providerCalls: 0,
      durableWrites: 0,
      states: STATES.slice(),
      maximumSelectedMemories: MAX_SELECTED,
      CANONICAL_MEMORY_MUTATION: 0,
      SEMANTIC_FORGETTING_MUTATION: 0,
      RELATIONSHIP_MUTATION: 0,
      PERSONA_MUTATION: 0,
      SELF_NARRATIVE_MUTATION: 0,
      BEHAVIOR_MODULATION_MUTATION: 0,
      PREDICTION_ERROR_MUTATION: 0
    };
  }

  return Object.freeze({
    SCHEMA_VERSION: SCHEMA_VERSION,
    AUTHORITY: AUTHORITY,
    DURABILITY: DURABILITY,
    STATES: STATES.slice(),
    derive: derive,
    renderGuidance: renderGuidance,
    describe: describe
  });
});
