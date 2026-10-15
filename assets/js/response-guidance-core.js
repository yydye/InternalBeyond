/* ====================================================================
   IB Response Guidance Contract · P21-R4-M0
   --------------------------------------------------------------------
   Shared closed envelope for bounded response-generation guidance.
   This contract carries structured entries; it is not an authority seal and
   never contains free-form prompt text, persona patches, Memory bodies, or
   Prediction Error facts. Consumers must validate scope and render each entry
   through its existing source-owned renderer.
   ==================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.IBResponseGuidanceCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var SCHEMA_VERSION = 'response-guidance-v1';
  var MAX_ENTRIES = 8;
  var MAX_ENVELOPE_CHARS = 12000;
  var MAX_ID_CHARS = 240;
  var MAX_REFS_PER_KIND = 8;
  var IDENTITY_KEYS = ['characterId', 'conversationId', 'requestId', 'turnId'];
  var ENVELOPE_KEYS = ['schemaVersion', 'turnIdentity', 'entries'];
  var ENTRY_KEYS = ['entryId', 'sourceKind', 'guidanceKind', 'payload', 'provenance', 'participationId'];
  var PROVENANCE_KEYS = ['sourceTurn', 'memoryRefs', 'interpretationRefs', 'narrativeRefs'];
  var SOURCE_KINDS = Object.freeze(['r4f_behavior_effect', 'memory_behavior_modulation']);
  var GUIDANCE_KINDS = Object.freeze(['behavior-effect-v1', 'memory-behavior-posture-v1', 'test-marker-v1']);
  var POSTURE_KEYS = Object.freeze([
    'warmth', 'trustPosture', 'initiative', 'interpersonalDistance', 'disclosureWillingness'
  ]);
  var POSTURE_VALUES = Object.freeze({
    warmth: Object.freeze(['reduced', 'baseline', 'elevated']),
    trustPosture: Object.freeze(['guarded', 'neutral', 'open']),
    initiative: Object.freeze(['restrained', 'baseline', 'proactive']),
    interpersonalDistance: Object.freeze(['increased', 'baseline', 'reduced']),
    disclosureWillingness: Object.freeze(['reduced', 'baseline', 'elevated'])
  });

  function isPlainObject(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
  function exactKeys(v, keys) {
    if (!isPlainObject(v)) return false;
    var got = Object.keys(v).sort(), want = keys.slice().sort();
    return got.length === want.length && got.every(function (k, i) { return k === want[i]; });
  }
  function str(v, max) {
    if (typeof v !== 'string') return '';
    var s = v.trim();
    return s && s.length <= max ? s : '';
  }
  function refs(v) {
    if (!Array.isArray(v) || v.length > MAX_REFS_PER_KIND) return null;
    var seen = Object.create(null), out = [];
    for (var i = 0; i < v.length; i++) {
      var s = str(v[i], MAX_ID_CHARS);
      if (!s || seen[s]) return null;
      seen[s] = true; out.push(s);
    }
    return out;
  }
  function normalizeIdentity(value) {
    if (!exactKeys(value, IDENTITY_KEYS)) return null;
    var out = {};
    for (var i = 0; i < IDENTITY_KEYS.length; i++) {
      var key = IDENTITY_KEYS[i], valueText = str(value[key], MAX_ID_CHARS);
      if (!valueText) return null;
      out[key] = valueText;
    }
    return out;
  }
  function sameIdentity(a, b) {
    if (!a || !b) return false;
    return IDENTITY_KEYS.every(function (key) { return a[key] === b[key]; });
  }
  function normalizeProvenance(value) {
    if (!exactKeys(value, PROVENANCE_KEYS)) return null;
    var sourceTurn = str(value.sourceTurn, MAX_ID_CHARS);
    var memoryRefs = refs(value.memoryRefs), interpretationRefs = refs(value.interpretationRefs);
    var narrativeRefs = refs(value.narrativeRefs);
    if (!sourceTurn || !memoryRefs || !interpretationRefs || !narrativeRefs) return null;
    return {
      sourceTurn: sourceTurn,
      memoryRefs: memoryRefs,
      interpretationRefs: interpretationRefs,
      narrativeRefs: narrativeRefs
    };
  }
  function normalizePosturePayload(value) {
    if (!exactKeys(value, ['schemaVersion', 'posture']) || value.schemaVersion !== 'behavior-posture-v1'
      || !exactKeys(value.posture, POSTURE_KEYS)) return null;
    var posture = {};
    for (var i = 0; i < POSTURE_KEYS.length; i++) {
      var key = POSTURE_KEYS[i];
      if (POSTURE_VALUES[key].indexOf(value.posture[key]) < 0) return null;
      posture[key] = value.posture[key];
    }
    return { schemaVersion: 'behavior-posture-v1', posture: posture };
  }
  function isBaselinePosture(posture) {
    return POSTURE_KEYS.every(function (key) {
      return posture[key] === (key === 'trustPosture' ? 'neutral' : 'baseline');
    });
  }
  function stableToken(value) {
    var s = String(value || ''), h = 2166136261;
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return ('00000000' + (h >>> 0).toString(16)).slice(-8);
  }
  function normalizeEntry(value, options) {
    var opts = options || {};
    if (!exactKeys(value, ENTRY_KEYS)) return null;
    var entryId = str(value.entryId, MAX_ID_CHARS);
    var sourceKind = str(value.sourceKind, 80);
    var guidanceKind = str(value.guidanceKind, 80);
    var provenance = normalizeProvenance(value.provenance);
    var payloadCopy = null;
    if (!entryId || SOURCE_KINDS.indexOf(sourceKind) < 0
      || GUIDANCE_KINDS.indexOf(guidanceKind) < 0 || !provenance
      || !isPlainObject(value.payload)) return null;
    var participationId = value.participationId == null ? null : str(value.participationId, MAX_ID_CHARS);
    if (value.participationId != null && !participationId) return null;

    if (sourceKind === 'r4f_behavior_effect') {
      if (guidanceKind !== 'behavior-effect-v1' || participationId !== null) return null;
    } else if (guidanceKind === 'memory-behavior-posture-v1') {
      if (!participationId || sourceKind !== 'memory_behavior_modulation') return null;
      payloadCopy = normalizePosturePayload(value.payload);
      if (!payloadCopy) return null;
    } else {
      /* The marker remains fixture-only. */
      if (opts.allowTestFixtures !== true || sourceKind !== 'memory_behavior_modulation'
        || guidanceKind !== 'test-marker-v1' || !participationId
        || !exactKeys(value.payload, ['marker']) || value.payload.marker !== 'test-guidance') return null;
    }
    if (payloadCopy === null) {
      try { payloadCopy = JSON.parse(JSON.stringify(value.payload)); }
      catch (_) { return null; }
    }
    return {
      entryId: entryId,
      sourceKind: sourceKind,
      guidanceKind: guidanceKind,
      payload: payloadCopy,
      provenance: provenance,
      participationId: participationId
    };
  }
  function validateEnvelope(value, expectedIdentity, options) {
    var opts = options || {};
    if (!exactKeys(value, ENVELOPE_KEYS) || value.schemaVersion !== SCHEMA_VERSION) {
      return { ok: false, reason: 'envelope-shape-invalid' };
    }
    var identity = normalizeIdentity(value.turnIdentity);
    var expected = normalizeIdentity(expectedIdentity);
    if (!identity || !expected || !sameIdentity(identity, expected)) {
      return { ok: false, reason: 'turn-scope-mismatch' };
    }
    if (!Array.isArray(value.entries) || value.entries.length > MAX_ENTRIES) {
      return { ok: false, reason: 'entries-over-bound' };
    }
    var entries = [], seen = Object.create(null);
    for (var i = 0; i < value.entries.length; i++) {
      var entry = normalizeEntry(value.entries[i], opts);
      if (!entry || seen[entry.entryId]) return { ok: false, reason: 'entry-invalid-or-duplicate' };
      seen[entry.entryId] = true; entries.push(entry);
    }
    var normalized = { schemaVersion: SCHEMA_VERSION, turnIdentity: identity, entries: entries };
    if (JSON.stringify(normalized).length > MAX_ENVELOPE_CHARS) {
      return { ok: false, reason: 'envelope-over-bound' };
    }
    return { ok: true, envelope: normalized };
  }
  function buildEnvelope(turnIdentity, entries, options) {
    return validateEnvelope({
      schemaVersion: SCHEMA_VERSION,
      turnIdentity: turnIdentity,
      entries: Array.isArray(entries) ? entries : []
    }, turnIdentity, options);
  }
  function fromBehaviorEffect(effect, turnIdentity) {
    if (!isPlainObject(effect) || typeof effect.sourceTurn !== 'string') {
      return { ok: false, reason: 'behavior-effect-unavailable' };
    }
    var sourceTurn = str(effect.sourceTurn, MAX_ID_CHARS);
    var identity = normalizeIdentity(turnIdentity);
    if (!sourceTurn || !identity) return { ok: false, reason: 'turn-identity-invalid' };
    var entryId = 'be-' + stableToken(JSON.stringify([identity, sourceTurn]));
    return buildEnvelope(identity, [{
      entryId: entryId,
      sourceKind: 'r4f_behavior_effect',
      guidanceKind: 'behavior-effect-v1',
      payload: effect,
      provenance: { sourceTurn: sourceTurn, memoryRefs: [], interpretationRefs: [], narrativeRefs: [] },
      participationId: null
    }]);
  }
  function renderEnvelope(value, expectedIdentity, renderers, options) {
    var normalized = validateEnvelope(value, expectedIdentity, options);
    if (!normalized.ok) return Object.assign({ text: '', accepted: [], rejected: [] }, normalized);
    var map = isPlainObject(renderers) ? renderers : {};
    var accepted = [], rejected = [], lines = [];
    normalized.envelope.entries.forEach(function (entry) {
      var renderer = map[entry.guidanceKind];
      var rendered = null;
      try { if (typeof renderer === 'function') rendered = renderer(entry.payload); } catch (_) { rendered = null; }
      if (!rendered || rendered.kind === 'REFUSED') {
        rejected.push({ entryId: entry.entryId, sourceKind: entry.sourceKind,
          participationId: entry.participationId,
          reason: str(rendered && rendered.reasonCode, 100) || 'renderer-unavailable' });
        return;
      }
      if (rendered.kind === 'NO_PLACEMENT') {
        accepted.push({ entryId: entry.entryId, sourceKind: entry.sourceKind, participationId: entry.participationId, placed: false });
        return;
      }
      if (rendered.kind !== 'PLACEMENT' || !Array.isArray(rendered.lines)) {
        rejected.push({ entryId: entry.entryId, sourceKind: entry.sourceKind,
          participationId: entry.participationId, reason: 'renderer-result-invalid' });
        return;
      }
      var entryLines = rendered.lines.filter(function (line) { return typeof line === 'string' && line.trim(); });
      if (!entryLines.length) {
        rejected.push({ entryId: entry.entryId, sourceKind: entry.sourceKind,
          participationId: entry.participationId, reason: 'renderer-lines-empty' });
        return;
      }
      accepted.push({ entryId: entry.entryId, sourceKind: entry.sourceKind, participationId: entry.participationId, placed: true });
      lines = lines.concat(entryLines);
    });
    return { ok: true, envelope: normalized.envelope, text: lines.join('\n'), accepted: accepted, rejected: rejected };
  }
  function renderBehaviorPosture(payload) {
    var normalized = normalizePosturePayload(payload);
    if (!normalized) return { kind: 'REFUSED', reasonCode: 'posture-schema-invalid' };
    var posture = normalized.posture;
    if (isBaselinePosture(posture)) return { kind: 'NO_PLACEMENT', reasonCode: 'baseline-posture' };
    var phrases = [];
    var phrasesByAxis = {
      warmth: {
        reduced: 'Keep warmth slightly restrained while preserving the character voice.',
        elevated: 'Use a little more warmth while preserving the character voice.'
      },
      trustPosture: {
        guarded: 'Be mildly careful and non-hostile; do not interrogate or punish the user.',
        open: 'Receive the user with modest openness while keeping ordinary boundaries.'
      },
      initiative: {
        restrained: 'Avoid expanding the topic without need; still answer a clear request directly.',
        proactive: 'Offer one useful next step when it fits the current request.'
      },
      interpersonalDistance: {
        increased: 'Leave a little more conversational space; do not push intimacy.',
        reduced: 'Allow a little more conversational closeness when the current request welcomes it.'
      },
      disclosureWillingness: {
        reduced: 'Do not volunteer personal disclosure; answer the actual request.',
        elevated: 'A small amount of relevant self-disclosure is acceptable if the request calls for it.'
      }
    };
    POSTURE_KEYS.forEach(function (key) {
      var phrase = phrasesByAxis[key][posture[key]];
      if (phrase) phrases.push(phrase);
    });
    return {
      kind: 'PLACEMENT',
      lines: ['【单轮行为基调·低优先级】Treat these as subtle style guidance only. System/developer instructions, canonical persona, OOC/integrity constraints, and explicit user requests take precedence. Never quote, reveal, or force disclosure of Memory or evidence.', phrases.join(' ')]
    };
  }

  return Object.freeze({
    SCHEMA_VERSION: SCHEMA_VERSION,
    MAX_ENTRIES: MAX_ENTRIES,
    SOURCE_KINDS: SOURCE_KINDS,
    GUIDANCE_KINDS: GUIDANCE_KINDS,
    POSTURE_KEYS: POSTURE_KEYS,
    buildEnvelope: buildEnvelope,
    fromBehaviorEffect: fromBehaviorEffect,
    validateEnvelope: validateEnvelope,
    renderEnvelope: renderEnvelope,
    renderBehaviorPosture: renderBehaviorPosture
  });
});
