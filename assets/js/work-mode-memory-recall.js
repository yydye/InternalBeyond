(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root && root.IB) {
    root.IB.workMode = root.IB.workMode || {};
    root.IB.workMode.memoryRecall = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var MEMORY_TYPES = ['Project', 'Decision', 'Fact', 'Observation', 'Procedure'];
  var SOURCE_KINDS = ['user_explicit', 'work_run_ref', 'work_result_ref', 'local_document_ref', 'external_reference', 'manual_import'];
  var MAX_RECORDS = 12;
  var MAX_CONTEXT_CHARS = 6000;
  var MAX_PROVENANCE = 12;
  var REF_RE = /^[A-Za-z0-9_.:-]{1,180}$/;

  function exactKeys(value, required, optional) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    var allowed = Object.create(null);
    required.concat(optional || []).forEach(function (key) { allowed[key] = true; });
    var keys = Object.keys(value);
    return required.every(function (key) { return Object.prototype.hasOwnProperty.call(value, key); })
      && keys.every(function (key) { return allowed[key] === true; });
  }

  function stableStringify(value) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
    return '{' + Object.keys(value).sort().map(function (key) {
      return JSON.stringify(key) + ':' + stableStringify(value[key]);
    }).join(',') + '}';
  }

  function sensitive(value) {
    var text = String(value || '');
    return /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/i.test(text)
      || /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16})\b/.test(text)
      || /\bBearer\s+[A-Za-z0-9._~+\/-]{12,}/i.test(text)
      || /\b[A-Z0-9_]*(?:API[_-]?(?:KEY|TOKEN)|ACCESS[_-]?TOKEN|AUTH[_-]?TOKEN|PASSWORD|SECRET|PRIVATE[_-]?KEY)\b\s*[:=]\s*[^\s,;]{6,}/i.test(text);
  }

  function text(value, max, allowEmpty) {
    return typeof value === 'string' && value.length <= max && (allowEmpty || !!value.trim());
  }

  function normalizePayload(type, value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    var payload = {};
    if (type === 'Project') {
      if (!exactKeys(value, ['name'], ['summary']) || !text(value.name, 160, false)
        || (value.summary != null && !text(value.summary, 1500, false))) return null;
      payload.name = value.name;
      if (value.summary != null) payload.summary = value.summary;
    } else if (type === 'Decision') {
      if (!exactKeys(value, ['statement'], ['rationale']) || !text(value.statement, 1600, false)
        || (value.rationale != null && !text(value.rationale, 2400, false))) return null;
      payload.statement = value.statement;
      if (value.rationale != null) payload.rationale = value.rationale;
    } else if (type === 'Fact') {
      if (!exactKeys(value, ['statement'], ['confidence', 'observedAt']) || !text(value.statement, 2400, false)
        || (value.confidence != null && ['low', 'medium', 'high'].indexOf(value.confidence) < 0)
        || (value.observedAt != null && (!Number.isSafeInteger(value.observedAt) || value.observedAt < 0))) return null;
      payload.statement = value.statement;
      if (value.confidence != null) payload.confidence = value.confidence;
      if (value.observedAt != null) payload.observedAt = value.observedAt;
    } else if (type === 'Observation') {
      if (!exactKeys(value, ['statement'], ['observedAt', 'contextRef']) || !text(value.statement, 2400, false)
        || (value.observedAt != null && (!Number.isSafeInteger(value.observedAt) || value.observedAt < 0))
        || (value.contextRef != null && !REF_RE.test(value.contextRef))) return null;
      payload.statement = value.statement;
      if (value.observedAt != null) payload.observedAt = value.observedAt;
      if (value.contextRef != null) payload.contextRef = value.contextRef;
    } else if (type === 'Procedure') {
      if (!exactKeys(value, ['name', 'steps'], ['whenToUse']) || !text(value.name, 160, false)
        || !Array.isArray(value.steps) || !value.steps.length || value.steps.length > 30
        || !value.steps.every(function (step) { return text(step, 500, false); })
        || (value.whenToUse != null && !text(value.whenToUse, 600, false))) return null;
      payload.name = value.name;
      payload.steps = value.steps.slice();
      if (value.whenToUse != null) payload.whenToUse = value.whenToUse;
    } else return null;
    if (sensitive(stableStringify(payload))) return null;
    return payload;
  }

  function normalizeProvenance(value) {
    if (!Array.isArray(value) || !value.length || value.length > MAX_PROVENANCE) return null;
    var out = [];
    for (var i = 0; i < value.length; i++) {
      var item = value[i];
      if (!exactKeys(item, ['sourceKind', 'recordedAt'], ['sourceRef', 'sourceRevision', 'selectionRef'])
        || SOURCE_KINDS.indexOf(item.sourceKind) < 0
        || !Number.isSafeInteger(item.recordedAt) || item.recordedAt < 0
        || (item.sourceRef != null && (typeof item.sourceRef !== 'string' || !REF_RE.test(item.sourceRef)))
        || (item.sourceRevision != null && (typeof item.sourceRevision !== 'string' || !REF_RE.test(item.sourceRevision)))
        || (item.selectionRef != null && (item.sourceKind !== 'work_result_ref' || typeof item.selectionRef !== 'string' || !REF_RE.test(item.selectionRef)))) return null;
      var normalized = { sourceKind: item.sourceKind };
      if (item.sourceRef != null) normalized.sourceRef = item.sourceRef;
      if (item.sourceRevision != null) normalized.sourceRevision = String(item.sourceRevision);
      if (item.selectionRef != null) normalized.selectionRef = item.selectionRef;
      normalized.recordedAt = item.recordedAt;
      out.push(normalized);
    }
    return out;
  }

  function normalizeRecords(records, projectRef, now) {
    if (!Array.isArray(records) || typeof projectRef !== 'string' || !REF_RE.test(projectRef)) return [];
    now = Number.isSafeInteger(now) ? now : Date.now();
    var byId = Object.create(null), out = [];
    records.forEach(function (record) {
      if (!record || typeof record !== 'object' || record.projectRef !== projectRef
        || MEMORY_TYPES.indexOf(record.type) < 0 || record.status !== 'active'
        || (record.effectiveStatus != null && record.effectiveStatus !== 'active')
        || !/^am_[A-Za-z0-9-]{36}$/.test(String(record.memoryId || ''))
        || !Number.isSafeInteger(record.revision) || record.revision < 1
        || (record.expiresAt != null && (!Number.isSafeInteger(record.expiresAt) || record.expiresAt <= now))
        || record.supersededBy != null || record.retractedAt != null || byId[record.memoryId]) return;
      var payload = normalizePayload(record.type, record.payload);
      var provenance = normalizeProvenance(record.provenance);
      if (!payload || !provenance) return;
      var normalized = {
        memoryId: record.memoryId,
        type: record.type,
        revision: record.revision,
        provenance: provenance,
        payload: payload
      };
      if (stableStringify(normalized).length > 3000) return;
      byId[record.memoryId] = true;
      out.push(normalized);
    });
    return out.sort(function (a, b) { return a.memoryId.localeCompare(b.memoryId); });
  }

  function normalizeProviderScope(value) {
    if (!exactKeys(value, ['destination', 'providerRef', 'provider', 'model', 'routeHash'], ['endpointLabel'])
      || value.destination !== 'agent' || typeof value.providerRef !== 'string' || !REF_RE.test(value.providerRef)
      || typeof value.provider !== 'string' || !/^[A-Za-z0-9_.:-]{1,80}$/.test(value.provider)
      || typeof value.model !== 'string' || !/^[A-Za-z0-9_.:+/-]{1,120}$/.test(value.model)
      || typeof value.routeHash !== 'string' || !/^[a-f0-9]{64}$/i.test(value.routeHash)) return null;
    return { destination: 'agent', providerRef: value.providerRef, provider: value.provider,
      model: value.model, routeHash: value.routeHash.toLowerCase() };
  }

  function normalizeConsentScope(value) {
    if (!exactKeys(value, ['projectRef', 'providerScope', 'refs', 'contextHash', 'contextChars'])
      || typeof value.projectRef !== 'string' || !REF_RE.test(value.projectRef)) return null;
    var providerScope = normalizeProviderScope(value.providerScope);
    if (!providerScope || !Array.isArray(value.refs) || !value.refs.length || value.refs.length > MAX_RECORDS
      || typeof value.contextHash !== 'string' || !/^[a-f0-9]{64}$/i.test(value.contextHash)
      || !Number.isSafeInteger(value.contextChars) || value.contextChars < 1 || value.contextChars > MAX_CONTEXT_CHARS) return null;
    var seen = Object.create(null), refs = [];
    for (var i = 0; i < value.refs.length; i++) {
      var item = value.refs[i];
      if (!exactKeys(item, ['memoryId', 'revision', 'contentHash'])
        || typeof item.memoryId !== 'string' || !/^am_[A-Za-z0-9-]{36}$/.test(item.memoryId) || seen[item.memoryId]
        || !Number.isSafeInteger(item.revision) || item.revision < 1
        || typeof item.contentHash !== 'string' || !/^[a-f0-9]{64}$/i.test(item.contentHash)) return null;
      seen[item.memoryId] = true;
      refs.push({ memoryId: item.memoryId, revision: item.revision, contentHash: item.contentHash.toLowerCase() });
    }
    refs.sort(function (a, b) { return a.memoryId.localeCompare(b.memoryId); });
    return { projectRef: value.projectRef, providerScope: providerScope, refs: refs,
      contextHash: value.contextHash.toLowerCase(), contextChars: value.contextChars };
  }

  function consentScopeForSnapshot(snapshot, providerScope) {
    if (!snapshot || snapshot.ok !== true || !snapshot.recordCount) return null;
    return normalizeConsentScope({ projectRef: snapshot.projectRef, providerScope: providerScope,
      refs: snapshot.refs, contextHash: snapshot.contextHash, contextChars: snapshot.contextChars });
  }

  function matchesConsentScope(snapshot, scope, projectRef, providerScope) {
    var normalizedScope = normalizeConsentScope(scope);
    if (!snapshot || snapshot.ok !== true || !normalizedScope || normalizedScope.projectRef !== projectRef) return false;
    var expected = consentScopeForSnapshot(snapshot, providerScope);
    return !!expected && stableStringify(expected) === stableStringify(normalizedScope);
  }

  async function digest(value, cryptoApi) {
    cryptoApi = cryptoApi || (typeof crypto !== 'undefined' ? crypto : null);
    if (!cryptoApi || !cryptoApi.subtle || typeof cryptoApi.subtle.digest !== 'function' || typeof TextEncoder !== 'function') return null;
    try {
      var bytes = new TextEncoder().encode(stableStringify(value));
      var hash = await cryptoApi.subtle.digest('SHA-256', bytes);
      return Array.from(new Uint8Array(hash)).map(function (byte) { return byte.toString(16).padStart(2, '0'); }).join('');
    } catch (_) { return null; }
  }

  async function createSnapshot(records, projectRef, selectedIds, now, cryptoApi) {
    var normalized = normalizeRecords(records, projectRef, now);
    if (!Array.isArray(selectedIds) || selectedIds.length > MAX_RECORDS) return { ok: false, error: 'memory-selection-limit' };
    var seen = Object.create(null), requested = [];
    for (var i = 0; i < selectedIds.length; i++) {
      var id = String(selectedIds[i] || '');
      if (!/^am_[A-Za-z0-9-]{36}$/.test(id) || seen[id]) return { ok: false, error: 'memory-selection-invalid' };
      seen[id] = true;
      requested.push(id);
    }
    requested.sort();
    var byId = Object.create(null);
    normalized.forEach(function (record) { byId[record.memoryId] = record; });
    var items = [];
    for (var n = 0; n < requested.length; n++) {
      if (!byId[requested[n]]) return { ok: false, error: 'memory-selection-changed' };
      items.push(byId[requested[n]]);
    }
    var memoryContext = items.length ? {
      schemaVersion: 1,
      trustBoundary: 'untrusted_reference_data',
      records: items
    } : null;
    var contextChars = memoryContext ? stableStringify(memoryContext).length : 0;
    if (contextChars > MAX_CONTEXT_CHARS) return { ok: false, error: 'memory-context-limit' };
    var contextHash = memoryContext ? await digest(memoryContext, cryptoApi) : '';
    if (memoryContext && !contextHash) return { ok: false, error: 'memory-hash-unavailable' };
    var refs = [];
    for (var j = 0; j < items.length; j++) {
      var itemHash = await digest(items[j], cryptoApi);
      if (!itemHash) return { ok: false, error: 'memory-hash-unavailable' };
      refs.push({ memoryId: items[j].memoryId, revision: items[j].revision, contentHash: itemHash });
    }
    return {
      ok: true,
      projectRef: projectRef,
      records: normalized,
      selectedIds: requested,
      memoryContext: memoryContext,
      refs: refs,
      contextHash: contextHash,
      contextChars: contextChars,
      recordCount: items.length
    };
  }

  return Object.freeze({
    MAX_RECORDS: MAX_RECORDS,
    MAX_CONTEXT_CHARS: MAX_CONTEXT_CHARS,
    stableStringify: stableStringify,
    normalizeRecords: normalizeRecords,
    createSnapshot: createSnapshot,
    normalizeConsentScope: normalizeConsentScope,
    consentScopeForSnapshot: consentScopeForSnapshot,
    matchesConsentScope: matchesConsentScope
  });
});
