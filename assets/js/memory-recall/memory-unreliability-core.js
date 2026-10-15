/* ====================================================================
   IB Memory · Reconstructed Recollection Core (P21-R4-O)
   --------------------------------------------------------------------
   Deterministic, turn-scoped reliability projection over already-derived
   R4-H/R4-N, R3 Association, and R4-K/L provenance. It never reads Memory,
   calls a provider, writes canonical state, or generates event content.
   ==================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.IBMemoryUnreliabilityCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var SCHEMA_VERSION = 'reconstructed-recollection-v1';
  var AUTHORITY = 'DERIVED_CURRENT_RECOLLECTION';
  var DURABILITY = 'TURN_SCOPED';
  var MEMORY_STATES = ['remembered', 'partial', 'uncertain', 'faded', 'interpretation_only', 'unavailable'];
  var RELIABILITY_STATES = ['reliable', 'partial', 'uncertain', 'unavailable'];
  var DISTORTION_TYPES = ['none', 'omission', 'temporal_blur', 'source_blur', 'blending', 'interpretation_leakage'];
  var FORGETTING_STATES = ['accessible', 'faded', 'suppressed', 'latent'];
  var FORGETTING_STATES = ['accessible', 'faded', 'suppressed', 'latent'];
  var UNCERTAINTY = ['low', 'medium', 'high', 'unresolved', 'unknown'];
  var RELATIONS = ['support', 'complement', 'conflict', 'correction', 'continuation', 'contextualize', 'unrelated'];
  var BASIS = ['lexical_overlap', 'provenance_reference', 'temporal_proximity', 'same_recall_cluster'];
  var SOURCE_STATES = ['clear', 'ambiguous'];
  var CLAIM_SECTIONS = ['themes', 'currentBeliefs', 'relationshipBeliefs', 'unresolvedTensions',
    'resolvedTensions', 'turningPoints', 'continuityClaims'];
  var BLEND_RELATIONS = ['support', 'complement', 'continuation', 'contextualize'];
  var BLEND_BASIS = ['lexical_overlap', 'same_recall_cluster'];
  var MAX_REFS = 32;
  var MAX_EDGES = 12;
  var MAX_PROVENANCE = 32;
  var MAX_ID_CHARS = 240;

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
  function isUncertainDetail(state) {
    return state === 'partial' || state === 'uncertain' || state === 'faded';
  }
  function addType(types, type) {
    if (DISTORTION_TYPES.indexOf(type) >= 1 && types.indexOf(type) < 0) types.push(type);
  }
  function normalizeMetaMemory(value) {
    if (!isPlainObject(value) || value.schemaVersion !== 'meta-memory-awareness-v1'
      || value.authority !== 'DERIVED_MEMORY_STATE_AWARENESS' || value.durability !== 'TURN_SCOPED'
      || !Array.isArray(value.memoryStates) || value.memoryStates.length > MAX_REFS
      || !isPlainObject(value.reinterpretation) || !isPlainObject(value.selfNarrative)) return null;
    var byId = Object.create(null), refs = [];
    for (var i = 0; i < value.memoryStates.length; i++) {
      var row = value.memoryStates[i];
      if (!isPlainObject(row) || row.memoryId == null || row.source !== 'selected_recall') return null;
      var id = String(row.memoryId);
      if (!id || id.length > MAX_ID_CHARS || Object.prototype.hasOwnProperty.call(byId, id)) return null;
      if (MEMORY_STATES.indexOf(String(row.state || '')) < 0
        || MEMORY_STATES.indexOf(String(row.factualDetail || '')) < 0
        || MEMORY_STATES.indexOf(String(row.emotionalResidue || '')) < 0
        || MEMORY_STATES.indexOf(String(row.narrativeMeaning || '')) < 0
        || typeof row.resurfaced !== 'boolean') return null;
      byId[id] = {
        memoryId: id,
        state: String(row.state),
        factualDetail: String(row.factualDetail),
        emotionalResidue: String(row.emotionalResidue),
        narrativeMeaning: String(row.narrativeMeaning),
        resurfaced: row.resurfaced
      };
      refs.push(id);
    }
    var interpretation = value.reinterpretation;
    var narrative = value.selfNarrative;
    if (MEMORY_STATES.indexOf(String(interpretation.state || '')) < 0
      || UNCERTAINTY.indexOf(String(interpretation.uncertainty || '')) < 0
      || MEMORY_STATES.indexOf(String(narrative.state || '')) < 0
      || UNCERTAINTY.indexOf(String(narrative.uncertainty || '')) < 0) return null;
    if (interpretation.state !== 'unavailable' && interpretation.historicalClaimsAreWorldFacts !== 'NO') return null;
    var fields = ['historicalFactMemoryIds', 'historicalEmotionMemoryIds', 'currentKnowledgeMemoryIds', 'currentBeliefMemoryIds'];
    for (var f = 0; f < fields.length; f++) {
      if (!Array.isArray(interpretation[fields[f]]) || interpretation[fields[f]].length > MAX_REFS) return null;
      refs = refs.concat(uniqueIds(interpretation[fields[f]], MAX_REFS));
    }
    if (!Array.isArray(interpretation.directMemoryIds) || interpretation.directMemoryIds.length > 8
      || !Array.isArray(interpretation.associatedMemoryIds) || interpretation.associatedMemoryIds.length > 4
      || !Array.isArray(interpretation.associationRelations) || interpretation.associationRelations.length > MAX_EDGES) return null;
    refs = refs.concat(uniqueIds(interpretation.directMemoryIds, 8), uniqueIds(interpretation.associatedMemoryIds, 4));
    for (var ar = 0; ar < interpretation.associationRelations.length; ar++) {
      var relationEdge = interpretation.associationRelations[ar];
      if (!isPlainObject(relationEdge) || relationEdge.anchorMemoryId == null || relationEdge.relatedMemoryId == null
        || RELATIONS.indexOf(String(relationEdge.relation || '')) < 0
        || (relationEdge.pairRole !== 'anchor_candidate' && relationEdge.pairRole !== 'candidate_candidate')) return null;
      refs.push(String(relationEdge.anchorMemoryId), String(relationEdge.relatedMemoryId));
    }
    if (!Array.isArray(narrative.evidenceMemoryIds) || narrative.evidenceMemoryIds.length > MAX_REFS
      || !Array.isArray(narrative.interpretationRefs) || narrative.interpretationRefs.length > 4
      || !Array.isArray(narrative.claims) || narrative.claims.length > 14) return null;
    refs = refs.concat(uniqueIds(narrative.evidenceMemoryIds, MAX_REFS));
    var claims = [];
    for (var c = 0; c < narrative.claims.length; c++) {
      var claim = narrative.claims[c];
      if (!isPlainObject(claim) || CLAIM_SECTIONS.indexOf(String(claim.section || '')) < 0
        || claim.state !== 'interpretation_only' || !Array.isArray(claim.evidenceMemoryIds)) return null;
      var evidenceIds = uniqueIds(claim.evidenceMemoryIds, MAX_REFS);
      refs = refs.concat(evidenceIds);
      claims.push({ section: String(claim.section), evidenceMemoryIds: evidenceIds });
    }
    var uniqueRefs = uniqueIds(refs, MAX_REFS);
    var allowed = Object.create(null);
    uniqueRefs.forEach(function (id) { allowed[id] = true; });
    return {
      byId: byId,
      refs: uniqueRefs,
      allowed: allowed,
      interpretation: {
        state: String(interpretation.state),
        uncertainty: String(interpretation.uncertainty),
        historicalFactMemoryIds: uniqueIds(interpretation.historicalFactMemoryIds, MAX_REFS),
        historicalEmotionMemoryIds: uniqueIds(interpretation.historicalEmotionMemoryIds, MAX_REFS),
        currentKnowledgeMemoryIds: uniqueIds(interpretation.currentKnowledgeMemoryIds, MAX_REFS),
        currentBeliefMemoryIds: uniqueIds(interpretation.currentBeliefMemoryIds, MAX_REFS),
        directMemoryIds: uniqueIds(interpretation.directMemoryIds, 8),
        associatedMemoryIds: uniqueIds(interpretation.associatedMemoryIds, 4),
        associationRelations: interpretation.associationRelations.map(function (edge) {
          return { anchorMemoryId: String(edge.anchorMemoryId), relatedMemoryId: String(edge.relatedMemoryId),
            relation: String(edge.relation), pairRole: edge.pairRole };
        }),
        interpretationRef: interpretation.interpretationRef == null ? null : String(interpretation.interpretationRef).slice(0, 160)
      },
      narrative: { state: String(narrative.state), uncertainty: String(narrative.uncertainty), claims: claims }
    };
  }
  function normalizeEdges(value, allowed) {
    if (value == null) return { ok: true, edges: [] };
    if (!Array.isArray(value) || value.length > MAX_EDGES) return { ok: false, edges: [] };
    var edges = [];
    for (var i = 0; i < value.length; i++) {
      var edge = value[i];
      if (!isPlainObject(edge) || edge.anchorMemoryId == null || edge.relatedMemoryId == null
        || RELATIONS.indexOf(String(edge.relation || '')) < 0 || !Array.isArray(edge.basis)
        || edge.basis.length > 4) return { ok: false, edges: [] };
      var anchor = String(edge.anchorMemoryId), related = String(edge.relatedMemoryId);
      if (!allowed[anchor] || !allowed[related]) return { ok: false, edges: [] };
      var basis = uniqueIds(edge.basis, 4);
      if (basis.some(function (item) { return BASIS.indexOf(item) < 0; })) return { ok: false, edges: [] };
      if (edge.pairRole !== 'anchor_candidate' && edge.pairRole !== 'candidate_candidate') return { ok: false, edges: [] };
      edges.push({ anchorMemoryId: anchor, relatedMemoryId: related, relation: String(edge.relation), basis: basis,
        pairRole: edge.pairRole });
    }
    return { ok: true, edges: edges };
  }
  function statusForForgetting(value) {
    if (value === 'accessible') return 'remembered';
    if (value === 'faded') return 'faded';
    if (value === 'suppressed') return 'partial';
    return 'unavailable';
  }
  function normalizeForgetting(value, memoryStates) {
    if (!Array.isArray(value) || value.length > MAX_REFS) return { ok: false, byId: Object.create(null) };
    var byId = Object.create(null);
    for (var i = 0; i < value.length; i++) {
      var entry = value[i];
      if (!isPlainObject(entry) || entry.memoryId == null || !isPlainObject(entry.projection)) {
        return { ok: false, byId: Object.create(null) };
      }
      var id = String(entry.memoryId), projection = entry.projection;
      if (!memoryStates[id] || Object.prototype.hasOwnProperty.call(byId, id)
        || projection.schemaVersion !== 'semantic-forgetting-v1'
        || FORGETTING_STATES.indexOf(String(projection.accessibility || '')) < 0
        || FORGETTING_STATES.indexOf(String(projection.factualDetail || '')) < 0
        || FORGETTING_STATES.indexOf(String(projection.emotionalResidue || '')) < 0
        || FORGETTING_STATES.indexOf(String(projection.narrativeMeaning || '')) < 0
        || typeof projection.resurfaced !== 'boolean') return { ok: false, byId: Object.create(null) };
      var normalized = {
        accessibility: String(projection.accessibility), factualDetail: String(projection.factualDetail),
        emotionalResidue: String(projection.emotionalResidue), narrativeMeaning: String(projection.narrativeMeaning),
        resurfaced: projection.resurfaced
      };
      var n = memoryStates[id];
      if (statusForForgetting(normalized.accessibility) !== n.state
        || statusForForgetting(normalized.factualDetail) !== n.factualDetail
        || statusForForgetting(normalized.emotionalResidue) !== n.emotionalResidue
        || statusForForgetting(normalized.narrativeMeaning) !== n.narrativeMeaning
        || normalized.resurfaced !== n.resurfaced) return { ok: false, byId: Object.create(null) };
      byId[id] = normalized;
    }
    if (Object.keys(memoryStates).some(function (id) { return !Object.prototype.hasOwnProperty.call(byId, id); })) {
      return { ok: false, byId: Object.create(null) };
    }
    return { ok: true, byId: byId };
  }
  function normalizeProvenance(value, allowed) {
    if (value == null) value = [];
    if (!Array.isArray(value) || value.length > MAX_PROVENANCE) return { ok: false, byId: Object.create(null) };
    var byId = Object.create(null);
    for (var i = 0; i < value.length; i++) {
      var row = value[i];
      if (!isPlainObject(row) || row.memoryId == null || SOURCE_STATES.indexOf(String(row.provenanceState || '')) < 0
        || !Number.isInteger(Number(row.upstreamCount)) || Number(row.upstreamCount) < 0
        || Number(row.upstreamCount) > 64) return { ok: false, byId: Object.create(null) };
      var id = String(row.memoryId);
      if (!allowed[id]) continue;
      if (Object.prototype.hasOwnProperty.call(byId, id)) return { ok: false, byId: Object.create(null) };
      byId[id] = { provenanceState: String(row.provenanceState), kind: String(row.kind || 'other').slice(0, 32),
        upstreamCount: Number(row.upstreamCount) };
    }
    return { ok: true, byId: byId };
  }
  function isUnreliableGate(row, forgetting, meta) {
    return !!(row && (isUncertainDetail(row.factualDetail)
      || row.state === 'partial' || row.state === 'uncertain' || row.state === 'faded'))
      || !!(forgetting && forgetting.factualDetail !== 'accessible')
      || meta.interpretation.state === 'uncertain' || meta.narrative.state === 'uncertain';
  }
  function detailStateFor(row) {
    return row ? row.factualDetail : 'unavailable';
  }

  function derive(input) {
    try {
      var src = isPlainObject(input) ? input : {};
      var meta = normalizeMetaMemory(src.metaMemoryAwareness);
      if (!meta) return { ok: false, status: 'failed', reason: 'meta-memory-gate-invalid', recollection: null };
      var forgettingResult = normalizeForgetting(src.semanticForgettingById, meta.byId);
      var edgesResult = normalizeEdges(src.associationEdges, meta.allowed);
      var provenanceResult = normalizeProvenance(src.memoryProvenanceById, meta.allowed);
      if (!forgettingResult.ok || !edgesResult.ok || !provenanceResult.ok) {
        return { ok: false, status: 'failed', reason: 'recollection-evidence-invalid', recollection: null };
      }
      var types = [], uncertainDetails = [], preservedFacts = [], blendedSources = [], interpretationLeakage = [];
      var detailsSeen = Object.create(null), blendSeen = Object.create(null);
      var allowed = meta.allowed, byId = meta.byId, forgettingById = forgettingResult.byId, prov = provenanceResult.byId;
      var globallyUncertain = meta.interpretation.state === 'uncertain' || meta.narrative.state === 'uncertain';
      function addDetail(ids, dimension, state, reason, type) {
        var keys = ids.slice().sort();
        var key = keys.join('|') + ':' + dimension + ':' + state;
        if (detailsSeen[key]) return;
        detailsSeen[key] = true;
        uncertainDetails.push({ memoryIds: keys, dimension: dimension, state: state, basis: reason,
          distortionType: type || null });
        if (type) addType(types, type);
      }
      meta.refs.forEach(function (id) {
        var row = byId[id];
        if (!row) return;
        var forgetting = forgettingById[id];
        if (forgetting.factualDetail !== 'accessible') {
          var omissionState = statusForForgetting(forgetting.factualDetail);
          addDetail([id], 'factual_detail', omissionState, 'R4-H_AND_R4-N', 'omission');
        }
        var source = prov[id];
        if (source && source.provenanceState === 'ambiguous' && isUnreliableGate(row, forgetting, meta)) {
          addDetail([id], 'source_attribution', 'uncertain', 'PROVENANCE_AMBIGUOUS', 'source_blur');
        }
      });

      edgesResult.edges.forEach(function (edge) {
        var pairIds = [edge.anchorMemoryId, edge.relatedMemoryId];
        var pairUncertain = globallyUncertain || pairIds.some(function (id) {
          return isUnreliableGate(byId[id], forgettingById[id], meta);
        });
        if (!pairUncertain) return;
        if (edge.basis.indexOf('temporal_proximity') >= 0) {
          addDetail(pairIds, 'temporal_order', 'uncertain', 'ASSOCIATION_TEMPORAL_PROXIMITY_DOES_NOT_ESTABLISH_ORDER', 'temporal_blur');
        }
        var hasSimilarity = edge.basis.some(function (basis) { return BLEND_BASIS.indexOf(basis) >= 0; });
        var bothDirectRecall = !!byId[edge.anchorMemoryId] && !!byId[edge.relatedMemoryId]
          && !!forgettingById[edge.anchorMemoryId] && !!forgettingById[edge.relatedMemoryId];
        if (hasSimilarity && bothDirectRecall && BLEND_RELATIONS.indexOf(edge.relation) >= 0) {
          var pairKey = edge.anchorMemoryId < edge.relatedMemoryId
            ? edge.anchorMemoryId + '\u0000' + edge.relatedMemoryId : edge.relatedMemoryId + '\u0000' + edge.anchorMemoryId;
          if (!blendSeen[pairKey]) {
            blendSeen[pairKey] = true;
            blendedSources.push({ sourceMemoryIds: pairIds, relation: edge.relation,
              basis: edge.basis.filter(function (basis) { return BLEND_BASIS.indexOf(basis) >= 0; }),
              uncertainty: 'uncertain', distortionType: 'blending' });
            addType(types, 'blending');
            addDetail(pairIds, 'source_attribution', 'uncertain', 'TWO_REAL_RELATED_MEMORY_REFS', 'blending');
          }
        }
      });

      meta.interpretation.historicalFactMemoryIds.forEach(function (id) {
        var row = byId[id], source = prov[id];
        if (row && row.factualDetail === 'remembered' && row.state === 'remembered'
          && forgettingById[id] && forgettingById[id].factualDetail === 'accessible'
          && source && source.provenanceState === 'clear') {
          preservedFacts.push({ memoryId: id, state: 'remembered',
            claimAuthority: 'CANONICAL_MEMORY_CLAIM_NOT_WORLD_FACT' });
        }
      });

      var laterMeaningIds = uniqueIds(meta.interpretation.currentKnowledgeMemoryIds
        .concat(meta.interpretation.currentBeliefMemoryIds), MAX_REFS);
      var historicalFactIds = meta.interpretation.historicalFactMemoryIds.slice();
      var interpretationIsSeparate = meta.interpretation.state === 'interpretation_only'
        || meta.interpretation.state === 'uncertain';
      if (interpretationIsSeparate && historicalFactIds.length && laterMeaningIds.length) {
        interpretationLeakage.push({ historicalMemoryIds: historicalFactIds,
          currentMeaningMemoryIds: laterMeaningIds,
          interpretationRef: meta.interpretation.interpretationRef,
          state: meta.interpretation.uncertainty === 'low' ? 'interpretation_only' : 'uncertain',
          distortionType: 'interpretation_leakage' });
        addType(types, 'interpretation_leakage');
        addDetail(historicalFactIds.concat(laterMeaningIds), 'historical_vs_current_meaning',
          meta.interpretation.uncertainty === 'low' ? 'interpretation_only' : 'uncertain',
          'R4-K_CURRENT_MEANING_IS_NOT_HISTORICAL_KNOWLEDGE', 'interpretation_leakage');
      }

      if (!types.length) types.push('none');
      var hasPartial = uncertainDetails.some(function (row) { return row.state === 'partial' || row.state === 'faded'; });
      var unavailableCount = meta.refs.filter(function (id) { return !byId[id] || byId[id].state === 'unavailable'; }).length;
      var reliabilityState = !meta.refs.length || (unavailableCount === meta.refs.length && !types.some(function (type) { return type !== 'none'; }))
        ? 'unavailable'
        : (globallyUncertain || types.indexOf('blending') >= 0 || types.indexOf('source_blur') >= 0
          || types.indexOf('interpretation_leakage') >= 0 ? 'uncertain' : (hasPartial ? 'partial' : 'reliable'));
      var recollection = {
        schemaVersion: SCHEMA_VERSION,
        authority: AUTHORITY,
        durability: DURABILITY,
        memoryRefs: meta.refs,
        reliabilityState: reliabilityState,
        distortionTypes: types,
        preservedFacts: preservedFacts.slice(0, MAX_REFS),
        uncertainDetails: uncertainDetails.slice(0, 48),
        blendedSources: blendedSources.slice(0, 8),
        interpretationLeakage: interpretationLeakage.slice(0, 8),
        IMAGINATION_AS_MEMORY: 'OUT_OF_SCOPE_V1',
        fabricatedEventCreation: 0
      };
      return { ok: true, status: 'succeeded', reason: null, recollection: recollection };
    } catch (_) {
      return { ok: false, status: 'failed', reason: 'recollection-projection-failed', recollection: null };
    }
  }

  function renderGuidance(result) {
    if (!result || result.ok !== true || !isPlainObject(result.recollection)) return '';
    var r = result.recollection;
    if (!Array.isArray(r.distortionTypes) || !r.distortionTypes.length) return '';
    if (r.distortionTypes.length === 1 && r.distortionTypes[0] === 'none') {
      if (r.reliabilityState !== 'reliable') return '';
      return '当前记录没有可验证的回想失真信号；不要为了显得像人而扭曲清晰记忆。';
    }
    var lines = [
      '这只是本轮回想的可靠性提示，不是新的事件记忆；只使用列出的真实 Memory 来源，不要补造第三件事。'
    ];
    if (r.distortionTypes.indexOf('omission') >= 0) {
      lines.push('部分事实细节只能省略或承认模糊；不要用推测补齐原话、参与者、日期或情节。');
    }
    if (r.distortionTypes.indexOf('temporal_blur') >= 0) {
      lines.push('记录间的时间接近不等于事件先后已知；不确定时不要断言确切日期或顺序。');
    }
    if (r.distortionTypes.indexOf('source_blur') >= 0) {
      lines.push('某些细节的来源无法确认；说明来源不确定，不要把它归给特定的人或某一次经历。');
    }
    if (r.distortionTypes.indexOf('blending') >= 0) {
      var blendRefs = r.blendedSources.map(function (row) { return '[' + row.sourceMemoryIds.join(', ') + ']'; }).join('、');
      lines.push('只有在谈到这些分别存在的来源 ' + blendRefs + ' 时，才可承认可能混淆；不要把它们合成新事件。');
    }
    if (r.distortionTypes.indexOf('interpretation_leakage') >= 0) {
      lines.push('把当时记录的事实主张与当前派生理解分开；当前解释不是事件发生时已经知道的证据。');
    }
    lines.push('不必生成一个错误版本；没有把握时保留未知，也不必主动披露某段 Memory。');
    return lines.join('\n');
  }

  function describe() {
    return {
      MEMORY_UNRELIABILITY_RUNTIME: 'LIVE',
      RECONSTRUCTED_RECOLLECTION: 'LIVE',
      OMISSION: 'LIVE',
      TEMPORAL_BLUR: 'LIVE',
      SOURCE_BLUR: 'LIVE',
      BLENDING: 'LIVE',
      INTERPRETATION_LEAKAGE_GUARD: 'LIVE',
      META_MEMORY_GATES_UNRELIABILITY: 'YES',
      MEMORY_UNRELIABILITY_IS_DERIVED: 'YES',
      RECONSTRUCTED_RECOLLECTION_IS_NOT_CANONICAL_MEMORY: 'YES',
      IMAGINATION_AS_MEMORY: 'OUT_OF_SCOPE_V1',
      FAILURE_FALLBACK: 'LIVE',
      maxProviderCallsPerCycle: 0,
      FABRICATED_EVENT_CREATION: 0,
      CANONICAL_MEMORY_MUTATION: 0,
      CANONICAL_MEMORY_REWRITE: 0,
      CANONICAL_MEMORY_DELETE: 0,
      PROVENANCE_REWRITE: 0,
      SEMANTIC_FORGETTING_MUTATION: 0,
      META_MEMORY_MUTATION: 0,
      RELATIONSHIP_MUTATION: 0,
      PERSONA_MUTATION: 0,
      SELF_NARRATIVE_MUTATION: 0,
      BEHAVIOR_MODULATION_MUTATION: 0,
      PREDICTION_ERROR_MUTATION: 0,
      states: RELIABILITY_STATES.slice(),
      distortionTypes: DISTORTION_TYPES.slice()
    };
  }

  return Object.freeze({
    SCHEMA_VERSION: SCHEMA_VERSION,
    AUTHORITY: AUTHORITY,
    DURABILITY: DURABILITY,
    MEMORY_STATES: MEMORY_STATES.slice(),
    RELIABILITY_STATES: RELIABILITY_STATES.slice(),
    DISTORTION_TYPES: DISTORTION_TYPES.slice(),
    derive: derive,
    renderGuidance: renderGuidance,
    describe: describe
  });
});
