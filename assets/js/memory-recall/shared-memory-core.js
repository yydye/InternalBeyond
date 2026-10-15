/* ====================================================================
   IB Memory · Shared Memory View Core (P21-R4-P)
   --------------------------------------------------------------------
   Pure co-constructed relationship view over already-selected, provenance
   marked Memory refs, R3 relations, R4-N awareness, and R4-O recollection.
   It never merges sides, writes Memory, calls a provider, or adjudicates truth.
   ==================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.IBSharedMemoryCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var SCHEMA_VERSION = 'shared-memory-view-v1';
  var AUTHORITY = 'DERIVED_CO_CONSTRUCTED_RELATIONSHIP_VIEW';
  var DURABILITY = 'TURN_SCOPED';
  var RELATIONS = ['support', 'complement', 'conflict', 'correction', 'continuation', 'contextualize', 'unrelated'];
  var BASIS = ['lexical_overlap', 'provenance_reference', 'temporal_proximity', 'same_recall_cluster'];
  var AUTHOR_SIDES = ['character_recollection', 'user_report', 'unknown'];
  var VIEW_STATES = ['aligned', 'complementary', 'asymmetric', 'disputed', 'jointly_acknowledged', 'unresolved'];
  var RELIABILITY = ['reliable', 'partial', 'uncertain', 'unavailable'];
  var UNCERTAINTY = ['low', 'medium', 'high', 'unresolved', 'unknown'];
  var MEMORY_STATES = ['remembered', 'partial', 'uncertain', 'faded', 'interpretation_only', 'unavailable'];
  var DISTORTIONS = ['none', 'omission', 'temporal_blur', 'source_blur', 'blending', 'interpretation_leakage'];
  var MAX_REFS = 32, MAX_EDGES = 12, MAX_ACKS = 8, MAX_ID_CHARS = 240;

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
  function includesAll(values, subset) {
    var set = Object.create(null);
    values.forEach(function (value) { set[value] = true; });
    return subset.every(function (value) { return !!set[value]; });
  }
  function normalizeRecollection(value) {
    if (!isPlainObject(value) || value.schemaVersion !== 'reconstructed-recollection-v1'
      || value.authority !== 'DERIVED_CURRENT_RECOLLECTION' || value.durability !== 'TURN_SCOPED'
      || RELIABILITY.indexOf(String(value.reliabilityState || '')) < 0
      || value.fabricatedEventCreation !== 0 || value.IMAGINATION_AS_MEMORY !== 'OUT_OF_SCOPE_V1'
      || !Array.isArray(value.memoryRefs) || value.memoryRefs.length > MAX_REFS
      || !Array.isArray(value.distortionTypes) || !Array.isArray(value.preservedFacts)
      || !Array.isArray(value.uncertainDetails) || value.uncertainDetails.length > 48
      || !Array.isArray(value.blendedSources) || value.blendedSources.length > 8
      || !Array.isArray(value.interpretationLeakage) || value.interpretationLeakage.length > 8) return null;
    var refs = uniqueIds(value.memoryRefs, MAX_REFS);
    if (refs.length !== value.memoryRefs.length) return null;
    var details = [], preserved = [], blends = [], leakage = [];
    for (var i = 0; i < value.uncertainDetails.length; i++) {
      var detail = value.uncertainDetails[i];
      if (!isPlainObject(detail) || !Array.isArray(detail.memoryIds)
        || MEMORY_STATES.indexOf(String(detail.state || '')) < 0
        || (detail.distortionType != null && DISTORTIONS.indexOf(String(detail.distortionType)) < 0)) return null;
      var detailIds = uniqueIds(detail.memoryIds, MAX_REFS);
      if (!detailIds.length || detailIds.length !== detail.memoryIds.length || !includesAll(refs, detailIds)) return null;
      details.push({ memoryIds: detailIds, dimension: String(detail.dimension || 'unknown'),
        state: String(detail.state), distortionType: detail.distortionType == null ? null : String(detail.distortionType) });
    }
    for (var p = 0; p < value.preservedFacts.length; p++) {
      var fact = value.preservedFacts[p];
      if (!isPlainObject(fact) || fact.memoryId == null || fact.state !== 'remembered'
        || fact.claimAuthority !== 'CANONICAL_MEMORY_CLAIM_NOT_WORLD_FACT') return null;
      var factId = String(fact.memoryId);
      if (refs.indexOf(factId) < 0) return null;
      preserved.push({ memoryId: factId, state: 'remembered', claimAuthority: fact.claimAuthority });
    }
    for (var b = 0; b < value.blendedSources.length; b++) {
      var blend = value.blendedSources[b];
      if (!isPlainObject(blend) || !Array.isArray(blend.sourceMemoryIds)
        || blend.distortionType !== 'blending' || blend.uncertainty !== 'uncertain') return null;
      var blendIds = uniqueIds(blend.sourceMemoryIds, MAX_REFS);
      if (blendIds.length < 2 || blendIds.length !== blend.sourceMemoryIds.length || !includesAll(refs, blendIds)) return null;
      blends.push({ sourceMemoryIds: blendIds, uncertainty: 'uncertain', distortionType: 'blending' });
    }
    for (var l = 0; l < value.interpretationLeakage.length; l++) {
      var leak = value.interpretationLeakage[l];
      if (!isPlainObject(leak) || !Array.isArray(leak.historicalMemoryIds)
        || !Array.isArray(leak.currentMeaningMemoryIds) || DISTORTIONS.indexOf(String(leak.distortionType || '')) < 0) return null;
      var historicalIds = uniqueIds(leak.historicalMemoryIds, MAX_REFS);
      var currentIds = uniqueIds(leak.currentMeaningMemoryIds, MAX_REFS);
      if (!historicalIds.length || !currentIds.length || !includesAll(refs, historicalIds.concat(currentIds))) return null;
      leakage.push({ historicalMemoryIds: historicalIds, currentMeaningMemoryIds: currentIds,
        state: MEMORY_STATES.indexOf(String(leak.state || '')) >= 0 ? String(leak.state) : 'uncertain',
        distortionType: String(leak.distortionType) });
    }
    var distortionTypes = uniqueIds(value.distortionTypes, DISTORTIONS.length);
    if (distortionTypes.length !== value.distortionTypes.length
      || distortionTypes.some(function (type) { return DISTORTIONS.indexOf(type) < 0; })) return null;
    return {
      memoryRefs: refs,
      reliabilityState: String(value.reliabilityState),
      distortionTypes: distortionTypes,
      preservedFacts: preserved.slice(0, MAX_REFS),
      uncertainDetails: details.slice(0, 48),
      blendedSources: blends.slice(0, 8),
      interpretationLeakage: leakage.slice(0, 8)
    };
  }
  function normalizeMetaMemory(value) {
    if (!isPlainObject(value) || value.schemaVersion !== 'meta-memory-awareness-v1'
      || value.authority !== 'DERIVED_MEMORY_STATE_AWARENESS' || value.durability !== 'TURN_SCOPED'
      || !Array.isArray(value.states) || value.states.length !== MEMORY_STATES.length
      || !Array.isArray(value.memoryStates) || value.memoryStates.length > MAX_REFS
      || !isPlainObject(value.reinterpretation) || !isPlainObject(value.selfNarrative)) return null;
    if (uniqueIds(value.states, MEMORY_STATES.length).length !== MEMORY_STATES.length
      || value.states.some(function (state) { return MEMORY_STATES.indexOf(String(state)) < 0; })) return null;
    var ids = [], seen = Object.create(null);
    value.memoryStates.forEach(function (row) {
      if (!isPlainObject(row) || row.memoryId == null || row.source !== 'selected_recall'
        || typeof row.resurfaced !== 'boolean' || MEMORY_STATES_CONSISTENT(row.state) === false
        || MEMORY_STATES_CONSISTENT(row.factualDetail) === false
        || MEMORY_STATES_CONSISTENT(row.emotionalResidue) === false
        || MEMORY_STATES_CONSISTENT(row.narrativeMeaning) === false) return;
      var id = String(row.memoryId);
      if (!id || id.length > MAX_ID_CHARS || seen[id]) { ids.push(''); return; }
      seen[id] = true;
      ids.push(id);
    });
    if (ids.some(function (id) { return !id; })) return null;
    var interp = value.reinterpretation, narrative = value.selfNarrative;
    if (MEMORY_STATES_CONSISTENT(interp.state) === false || MEMORY_STATES_CONSISTENT(narrative.state) === false
      || UNCERTAINTY.indexOf(String(interp.uncertainty || '')) < 0
      || UNCERTAINTY.indexOf(String(narrative.uncertainty || '')) < 0) return null;
    var refs = ids.slice();
    ['historicalFactMemoryIds', 'historicalEmotionMemoryIds', 'currentKnowledgeMemoryIds', 'currentBeliefMemoryIds',
      'directMemoryIds', 'associatedMemoryIds'].forEach(function (field) {
      if (!Array.isArray(interp[field]) || interp[field].length > MAX_REFS) return;
      refs = refs.concat(uniqueIds(interp[field], MAX_REFS));
    });
    if (!Array.isArray(interp.historicalFactMemoryIds) || !Array.isArray(interp.historicalEmotionMemoryIds)
      || !Array.isArray(interp.currentKnowledgeMemoryIds) || !Array.isArray(interp.currentBeliefMemoryIds)
      || !Array.isArray(interp.directMemoryIds) || !Array.isArray(interp.associatedMemoryIds)
      || !Array.isArray(interp.associationRelations)) return null;
    if (Array.isArray(narrative.evidenceMemoryIds)) refs = refs.concat(uniqueIds(narrative.evidenceMemoryIds, MAX_REFS));
    else return null;
    if (!Array.isArray(narrative.interpretationRefs) || !Array.isArray(narrative.claims)) return null;
    var allowedIds = uniqueIds(refs, MAX_REFS), allowed = Object.create(null);
    allowedIds.forEach(function (id) { allowed[id] = true; });
    var interpretationRefs = [];
    if (interp.interpretationRef != null && String(interp.interpretationRef)) interpretationRefs.push(String(interp.interpretationRef).slice(0, 160));
    if (Array.isArray(narrative.interpretationRefs)) interpretationRefs = interpretationRefs.concat(
      narrative.interpretationRefs.filter(function (id) { return id != null; }).slice(0, 4).map(function (id) { return String(id).slice(0, 160); })
    );
    return {
      allowed: allowed,
      interpretationRefs: uniqueIds(interpretationRefs, 4),
      interpretation: { state: String(interp.state), uncertainty: String(interp.uncertainty) },
      narrative: { state: String(narrative.state), uncertainty: String(narrative.uncertainty) }
    };
  }
  function MEMORY_STATES_CONSISTENT(value) {
    return ['remembered', 'partial', 'uncertain', 'faded', 'interpretation_only', 'unavailable'].indexOf(String(value || '')) >= 0;
  }
  function normalizeProvenance(value, allowed) {
    if (!Array.isArray(value) || value.length > MAX_REFS) return null;
    var byId = Object.create(null);
    for (var i = 0; i < value.length; i++) {
      var row = value[i];
      if (!isPlainObject(row) || row.memoryId == null || AUTHOR_SIDES.indexOf(String(row.authorSide || '')) < 0) return null;
      var id = String(row.memoryId);
      if (!allowed[id]) continue;
      if (Object.prototype.hasOwnProperty.call(byId, id)) return null;
      var evidenceSource = String(row.evidenceSource || 'selected_recall');
      if (evidenceSource !== 'selected_recall' && evidenceSource !== 'association_candidate_snapshot') return null;
      var provenanceState = String(row.provenanceState || 'ambiguous');
      if (provenanceState !== 'clear' && provenanceState !== 'ambiguous') return null;
      var upstreamCount = Number(row.upstreamCount);
      if (!Number.isInteger(upstreamCount) || upstreamCount < 0 || upstreamCount > 64) return null;
      byId[id] = { authorSide: String(row.authorSide), provenanceState: provenanceState,
        kind: String(row.kind || 'other'), upstreamCount: upstreamCount, evidenceSource: evidenceSource };
    }
    return byId;
  }
  function normalizeEdges(value, allowed) {
    if (!Array.isArray(value) || value.length > MAX_EDGES) return null;
    var edges = [];
    for (var i = 0; i < value.length; i++) {
      var edge = value[i];
      if (!isPlainObject(edge) || edge.anchorMemoryId == null || edge.relatedMemoryId == null
        || RELATIONS.indexOf(String(edge.relation || '')) < 0 || !Array.isArray(edge.basis) || edge.basis.length > 4
        || (edge.pairRole !== 'anchor_candidate' && edge.pairRole !== 'candidate_candidate')) return null;
      var a = String(edge.anchorMemoryId), b = String(edge.relatedMemoryId);
      if (!allowed[a] || !allowed[b]) continue;
      var basis = uniqueIds(edge.basis, 4);
      if (basis.some(function (item) { return BASIS.indexOf(item) < 0; })) return null;
      edges.push({ anchorMemoryId: a, relatedMemoryId: b, relation: String(edge.relation), basis: basis, pairRole: edge.pairRole });
    }
    return edges;
  }
  function sideReliability(refs, recollection) {
    if (!refs.length) return 'unavailable';
    if (refs.some(function (id) { return recollection.memoryRefs.indexOf(id) < 0; })) return 'unavailable';
    var detailRows = recollection.uncertainDetails.filter(function (row) {
      return isPlainObject(row) && Array.isArray(row.memoryIds)
        && row.memoryIds.some(function (id) { return refs.indexOf(String(id)) >= 0; });
    });
    if (detailRows.some(function (row) { return row.state === 'uncertain' || row.state === 'interpretation_only'; })) return 'uncertain';
    if (detailRows.length) return recollection.reliabilityState === 'uncertain' ? 'uncertain' : 'partial';
    var preserved = new Set(recollection.preservedFacts.filter(isPlainObject).map((row) => String(row.memoryId || '')));
    if (refs.every(function (id) { return preserved.has(id); })) return 'reliable';
    return recollection.reliabilityState;
  }
  function sideDistortions(refs, recollection) {
    var types = [];
    recollection.uncertainDetails.forEach(function (row) {
      if (!isPlainObject(row) || !Array.isArray(row.memoryIds) || !row.distortionType) return;
      if (row.memoryIds.some(function (id) { return refs.indexOf(String(id)) >= 0; })
        && types.indexOf(String(row.distortionType)) < 0) types.push(String(row.distortionType));
    });
    recollection.blendedSources.forEach(function (row) {
      if (isPlainObject(row) && Array.isArray(row.sourceMemoryIds)
        && row.sourceMemoryIds.some(function (id) { return refs.indexOf(String(id)) >= 0; })
        && types.indexOf('blending') < 0) types.push('blending');
    });
    recollection.interpretationLeakage.forEach(function (row) {
      if (isPlainObject(row) && [].concat(row.historicalMemoryIds || [], row.currentMeaningMemoryIds || [])
        .some(function (id) { return refs.indexOf(String(id)) >= 0; })
        && types.indexOf('interpretation_leakage') < 0) types.push('interpretation_leakage');
    });
    return types.length ? types : ['none'];
  }
  function uncertaintyFor(relation, recollection) {
    if (relation === 'disputed' || relation === 'unresolved' || relation === 'asymmetric') return 'unresolved';
    if (recollection.reliabilityState === 'uncertain') return 'high';
    if (recollection.reliabilityState === 'partial') return 'medium';
    if (recollection.reliabilityState === 'unavailable') return 'unknown';
    return 'low';
  }
  function relationForEdges(edges) {
    if (!edges.length) return 'unresolved';
    if (edges.some(function (edge) { return edge.relation === 'conflict' || edge.relation === 'correction'; })) return 'disputed';
    if (edges.some(function (edge) { return ['complement', 'continuation', 'contextualize'].indexOf(edge.relation) >= 0; })) return 'complementary';
    if (edges.some(function (edge) { return edge.relation === 'support'; })) return 'aligned';
    return 'unresolved';
  }
  function edgeBasisRows(edges) {
    return edges.map(function (edge) {
      return { characterMemoryId: edge.characterMemoryId, userReportMemoryId: edge.userReportMemoryId,
        relation: edge.relation, basis: edge.basis.slice(), pairRole: edge.pairRole };
    });
  }
  function sideProvenanceRows(refs, provenance) {
    return refs.map(function (id) {
      var row = provenance[id] || {};
      return { memoryId: id, authorSide: row.authorSide || 'unknown',
        provenanceState: row.provenanceState || 'ambiguous', kind: row.kind || 'other',
        upstreamCount: Number(row.upstreamCount) || 0, evidenceSource: row.evidenceSource || 'selected_recall' };
    });
  }
  function pairKey(characterId, userId) { return String(characterId) + '\u0000' + String(userId); }
  function acknowledgementMatches(ack, characterIds, userIds, verify) {
    if (typeof verify !== 'function' || !isPlainObject(ack)
      || ack.schemaVersion !== 'shared-history-acknowledgement-v1'
      || ack.authority !== 'EXPLICIT_SHARED_HISTORY_ACK'
      || ack.explicitUserConfirmation !== true || ack.explicitCharacterConfirmation !== true
      || !ack.confirmationRef || String(ack.confirmationRef).length > 160
      || !Array.isArray(ack.characterMemoryRefs) || !Array.isArray(ack.userReportRefs)) return false;
    var ackCharacter = uniqueIds(ack.characterMemoryRefs, MAX_REFS);
    var ackUser = uniqueIds(ack.userReportRefs, MAX_REFS);
    if (ackCharacter.length !== characterIds.length || ackUser.length !== userIds.length
      || !characterIds.every(function (id) { return ackCharacter.indexOf(id) >= 0; })
      || !userIds.every(function (id) { return ackUser.indexOf(id) >= 0; })) return false;
    try {
      var binding = Object.freeze({ characterMemoryRefs: Object.freeze(characterIds.slice()),
        userReportRefs: Object.freeze(userIds.slice()) });
      return verify(Object.freeze({ schemaVersion: ack.schemaVersion, authority: ack.authority,
        confirmationRef: String(ack.confirmationRef), characterMemoryRefs: Object.freeze(ackCharacter),
        userReportRefs: Object.freeze(ackUser), explicitUserConfirmation: true,
        explicitCharacterConfirmation: true }), binding) === true;
    } catch (_) { return false; }
  }
  function relationView(options) {
    var o = options || {};
    var charRefs = o.characterRefs || [], userRefs = o.userRefs || [], edges = o.edges || [];
    var baseRelation = o.relation || relationForEdges(edges);
    if (!charRefs.length || !userRefs.length) baseRelation = 'asymmetric';
    var jointFacts = [];
    var relation = baseRelation;
    var acknowledgements = Array.isArray(o.acknowledgements) ? o.acknowledgements : [];
    for (var i = 0; i < acknowledgements.length; i++) {
      var ack = acknowledgements[i];
      if (baseRelation === 'disputed') continue;
      if (acknowledgementMatches(ack, charRefs, userRefs, o.verifyJointAcknowledgement)) {
        relation = 'jointly_acknowledged';
        jointFacts.push({ memoryRefs: charRefs.concat(userRefs), confirmationRef: String(ack.confirmationRef),
          authority: 'VERIFIED_EXPLICIT_ACKNOWLEDGEMENT' });
      }
    }
    var differences = [];
    if (baseRelation === 'disputed' || baseRelation === 'unresolved') {
      differences.push({ characterMemoryRefs: charRefs.slice(), userReportRefs: userRefs.slice(),
        relationBasis: edgeBasisRows(edges), resolution: 'UNRESOLVED_NO_WINNER' });
    } else if (baseRelation === 'asymmetric') {
      differences.push({ characterMemoryRefs: charRefs.slice(), userReportRefs: userRefs.slice(),
        relationBasis: [], resolution: (charRefs.length && userRefs.length)
          ? 'NO_VALIDATED_CROSS_SIDE_BASIS' : 'COUNTERPART_NOT_AVAILABLE' });
    }
    return {
      topicIdentity: { characterMemoryRefs: charRefs.slice(), userReportRefs: userRefs.slice() },
      characterSide: { memoryRefs: charRefs.slice(), reliabilityState: sideReliability(charRefs, o.recollection),
        distortionTypes: sideDistortions(charRefs, o.recollection),
        provenance: sideProvenanceRows(charRefs, o.provenanceById) },
      userSide: { userReportRefs: userRefs.slice(), sourceBasis: 'CANONICAL_USER_AUTHORED_MEMORY_RECORD',
        reliabilityState: 'NOT_ASSESSED', distortionTypes: [],
        provenance: sideProvenanceRows(userRefs, o.provenanceById) },
      relation: relation,
      jointlyAcknowledgedFacts: jointFacts,
      unresolvedDifferences: differences,
      uncertainty: uncertaintyFor(relation, { reliabilityState: sideReliability(charRefs, o.recollection) }),
      provenance: {
        characterMemoryRefs: charRefs.slice(),
        userReportRefs: userRefs.slice(),
        characterSources: sideProvenanceRows(charRefs, o.provenanceById),
        userSources: sideProvenanceRows(userRefs, o.provenanceById),
        interpretationRefs: o.interpretationRefs.slice(),
        agreementDisagreementBasis: edgeBasisRows(edges)
      },
      automaticTruthMerge: 0
    };
  }

  function derive(input, options) {
    try {
      var src = isPlainObject(input) ? input : {};
      var recollection = normalizeRecollection(src.reconstructedRecollection);
      var meta = normalizeMetaMemory(src.metaMemoryAwareness);
      if (!recollection || !meta) return { ok: false, status: 'failed', reason: 'shared-memory-input-invalid', projection: null };
      if (!includesAll(Object.keys(meta.allowed), recollection.memoryRefs)) {
        return { ok: false, status: 'failed', reason: 'shared-memory-reference-not-authorized', projection: null };
      }
      var associationRefs = Object.create(null);
      if (!Array.isArray(src.associationEdges) || src.associationEdges.length > MAX_EDGES) {
        return { ok: false, status: 'failed', reason: 'shared-memory-association-invalid', projection: null };
      }
      src.associationEdges.forEach(function (edge) {
        if (!isPlainObject(edge)) return;
        [edge.anchorMemoryId, edge.relatedMemoryId].forEach(function (id) {
          if (id == null || String(id).length > MAX_ID_CHARS) return;
          associationRefs[String(id)] = true;
        });
      });
      var evidenceAllowed = Object.create(null);
      Object.keys(meta.allowed).forEach(function (id) { evidenceAllowed[id] = true; });
      Object.keys(associationRefs).forEach(function (id) { evidenceAllowed[id] = true; });
      var provenance = normalizeProvenance(src.memoryProvenanceById, evidenceAllowed);
      if (!provenance) return { ok: false, status: 'failed', reason: 'shared-memory-provenance-invalid', projection: null };
      Object.keys(provenance).forEach(function (id) {
        if (!meta.allowed[id] && (provenance[id].evidenceSource !== 'association_candidate_snapshot'
          || !associationRefs[id])) delete provenance[id];
      });
      var edges = normalizeEdges(src.associationEdges, evidenceAllowed);
      if (!edges) return { ok: false, status: 'failed', reason: 'shared-memory-association-invalid', projection: null };
      edges = edges.filter(function (edge) { return !!provenance[edge.anchorMemoryId] && !!provenance[edge.relatedMemoryId]; });
      var edgeReferenced = Object.create(null);
      edges.forEach(function (edge) { edgeReferenced[edge.anchorMemoryId] = true; edgeReferenced[edge.relatedMemoryId] = true; });
      var characterRefs = Object.keys(provenance).filter(function (id) {
        return provenance[id].authorSide === 'character_recollection' && (meta.allowed[id] || edgeReferenced[id]);
      });
      var userRefs = Object.keys(provenance).filter(function (id) {
        return provenance[id].authorSide === 'user_report' && (meta.allowed[id] || edgeReferenced[id]);
      });
      if (!characterRefs.length && !userRefs.length) {
        return { ok: true, status: 'not-needed', reason: 'no-authored-perspective-records', projection: {
          schemaVersion: SCHEMA_VERSION, authority: AUTHORITY, durability: DURABILITY,
          memoryRefs: [], views: [], relation: 'unresolved', jointlyAcknowledgedFacts: [],
          unresolvedDifferences: [], provenance: { characterMemoryRefs: [], userReportRefs: [],
            interpretationRefs: meta.interpretationRefs, agreementDisagreementBasis: [] },
          automaticTruthMerge: 0
        } };
      }
      var crossEdges = edges.filter(function (edge) {
        return edge.relation !== 'unrelated'
          && ((characterRefs.indexOf(edge.anchorMemoryId) >= 0 && userRefs.indexOf(edge.relatedMemoryId) >= 0)
            || (characterRefs.indexOf(edge.relatedMemoryId) >= 0 && userRefs.indexOf(edge.anchorMemoryId) >= 0));
      }).map(function (edge) {
        var characterMemoryId = characterRefs.indexOf(edge.anchorMemoryId) >= 0 ? edge.anchorMemoryId : edge.relatedMemoryId;
        var userReportMemoryId = characterMemoryId === edge.anchorMemoryId ? edge.relatedMemoryId : edge.anchorMemoryId;
        return { characterMemoryId: characterMemoryId, userReportMemoryId: userReportMemoryId,
          relation: edge.relation, basis: edge.basis, pairRole: edge.pairRole };
      });
      var grouped = Object.create(null);
      crossEdges.filter(function (edge) { return edge.relation !== 'unrelated'; }).forEach(function (edge) {
        var key = pairKey(edge.characterMemoryId, edge.userReportMemoryId);
        if (!grouped[key]) grouped[key] = [];
        grouped[key].push(edge);
      });
      var acknowledgements = Array.isArray(src.explicitAcknowledgements) ? src.explicitAcknowledgements.slice(0, MAX_ACKS) : [];
      var opts = isPlainObject(options) ? options : {};
      var views = [];
      Object.keys(grouped).forEach(function (key) {
        var pairEdges = grouped[key];
        var charId = pairEdges[0].characterMemoryId, userId = pairEdges[0].userReportMemoryId;
        views.push(relationView({ characterRefs: [charId], userRefs: [userId], edges: pairEdges,
          relation: relationForEdges(pairEdges), recollection: recollection,
          interpretationRefs: meta.interpretationRefs, provenanceById: provenance, acknowledgements: acknowledgements,
          verifyJointAcknowledgement: opts.verifyJointAcknowledgement }));
      });
      if (!views.length) {
        /* Without a validated cross-side Association, keep each record as its own
           one-sided view. Bundling all selected rows would imply an event link. */
        characterRefs.concat(userRefs).forEach(function (id) {
          var isCharacter = characterRefs.indexOf(id) >= 0;
          views.push(relationView({ characterRefs: isCharacter ? [id] : [], userRefs: isCharacter ? [] : [id],
            edges: [], relation: 'asymmetric', recollection: recollection,
            interpretationRefs: meta.interpretationRefs, provenanceById: provenance, acknowledgements: [],
            verifyJointAcknowledgement: opts.verifyJointAcknowledgement }));
        });
      }
      var allJoint = views.every(function (view) { return view.relation === 'jointly_acknowledged'; });
      var uniformRelation = views.every(function (view) { return view.relation === views[0].relation; });
      var summaryRelation = allJoint ? 'jointly_acknowledged'
        : (uniformRelation ? views[0].relation : 'unresolved');
      var jointlyAcknowledgedFacts = [], unresolvedDifferences = [];
      views.forEach(function (view) {
        jointlyAcknowledgedFacts.push.apply(jointlyAcknowledgedFacts, view.jointlyAcknowledgedFacts);
        unresolvedDifferences.push.apply(unresolvedDifferences, view.unresolvedDifferences);
      });
      return {
        ok: true, status: 'succeeded', reason: null,
        projection: {
          schemaVersion: SCHEMA_VERSION,
          authority: AUTHORITY,
          durability: DURABILITY,
          memoryRefs: uniqueIds(characterRefs.concat(userRefs), MAX_REFS),
          views: views.slice(0, MAX_REFS),
          relation: summaryRelation,
          jointlyAcknowledgedFacts: jointlyAcknowledgedFacts.slice(0, MAX_REFS),
          unresolvedDifferences: unresolvedDifferences.slice(0, MAX_REFS),
          provenance: {
            characterMemoryRefs: characterRefs,
            userReportRefs: userRefs,
            interpretationRefs: meta.interpretationRefs,
            agreementDisagreementBasis: crossEdges.map(function (edge) {
              return { characterMemoryId: edge.characterMemoryId, userReportMemoryId: edge.userReportMemoryId,
                relation: edge.relation, basis: edge.basis.slice(), pairRole: edge.pairRole };
            }).slice(0, MAX_EDGES)
          },
          automaticTruthMerge: 0
        }
      };
    } catch (_) {
      return { ok: false, status: 'failed', reason: 'shared-memory-projection-failed', projection: null };
    }
  }

  function renderGuidance(result) {
    if (!result || result.ok !== true || !isPlainObject(result.projection)
      || !Array.isArray(result.projection.views) || !result.projection.views.length) return '';
    var lines = ['这是双方来源分开的关系记忆视图，不是合并后的唯一真相。'];
    result.projection.views.forEach(function (view) {
      if (view.relation === 'jointly_acknowledged') {
        lines.push('只有经显式确认 authority 绑定的引用可以称为共同确认；仍保留双方各自的来源。');
      } else if (view.relation === 'disputed') {
        lines.push('双方回忆存在明确差异；保留两个版本和不确定性，不选赢家，也不覆盖任一侧。');
      } else if (view.relation === 'aligned') {
        lines.push('双方记录在当前关系视图中相符，但相符本身不等于共同确认。');
      } else if (view.relation === 'complementary') {
        lines.push('双方记录可以互补；保持各自出处，不合并成新的单一叙事。');
      } else if (view.relation === 'asymmetric') {
        lines.push('当前只有一方有可用记录；不要推断另一方同意或也记得。');
      } else {
        lines.push('双方是否描述同一事件尚不确定；先保留不对称，不合并。');
      }
      if (view.characterSide.reliabilityState === 'partial' || view.characterSide.reliabilityState === 'uncertain'
        || view.characterSide.reliabilityState === 'unavailable') {
        lines.push('角色侧回想自身不完整或不确定；用户侧版本不能修复或改写角色的 canonical Memory。');
      }
    });
    lines.push('用户报告不是角色回忆，关系视图也不裁决事实；不要仅因该视图存在就主动披露任一方的原始记忆，也不要修改 Memory、relationship、persona 或 Self Narrative。');
    return lines.join('\n');
  }

  function describe() {
    return {
      SHARED_MEMORY_RUNTIME: 'LIVE',
      CO_CONSTRUCTED_MEMORY_VIEW: 'LIVE',
      ASYMMETRIC_MEMORY: 'SUPPORTED',
      DISPUTED_MEMORY: 'SUPPORTED',
      JOINT_ACKNOWLEDGEMENT: 'AUTHORITY_GATED',
      CHARACTER_MEMORY_PRESERVED: 'YES',
      USER_RECOLLECTION_PRESERVED: 'YES',
      SHARED_MEMORY_IS_DERIVED: 'YES',
      SHARED_MEMORY_IS_NOT_CANONICAL_MERGE: 'YES',
      AUTOMATIC_TRUTH_MERGE: 0,
      CANONICAL_MEMORY_MUTATION: 0,
      USER_REPORT_REWRITE: 0,
      RELATIONSHIP_MUTATION: 0,
      PERSONA_MUTATION: 0,
      SELF_NARRATIVE_MUTATION: 0,
      BEHAVIOR_MODULATION_MUTATION: 0,
      PREDICTION_ERROR_MUTATION: 0,
      FAILURE_FALLBACK: 'LIVE',
      providerCalls: 0,
      durableWrites: 0,
      states: VIEW_STATES.slice()
    };
  }

  return Object.freeze({
    SCHEMA_VERSION: SCHEMA_VERSION,
    AUTHORITY: AUTHORITY,
    DURABILITY: DURABILITY,
    VIEW_STATES: VIEW_STATES.slice(),
    derive: derive,
    renderGuidance: renderGuidance,
    describe: describe
  });
});
