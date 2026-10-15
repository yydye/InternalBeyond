/* ====================================================================
   P5-B3-K · Free-text Explicit Report Candidate / Confirmation
   --------------------------------------------------------------------
   Candidate understanding only. This module never creates a report,
   RealityEvent, Prediction, settlement, Memory write, or network request.
   ==================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./memory-recall/preference-proposition-core.js'));
  } else {
    root.IBFreeTextReportCandidate = factory(root.IBMemoryPreferenceProposition);
  }
})(typeof self !== 'undefined' ? self : this, function (PREF) {
  'use strict';

  var VERSION = 'free-text-preference-candidate/v1';
  var STATUS = Object.freeze({
    PENDING: 'pending',
    CONFIRMING: 'confirming',
    CONFIRMED: 'confirmed',
    DISMISSED: 'dismissed',
    EXPIRED: 'expired'
  });
  var DEFAULT_TTL_MS = 15 * 60 * 1000;
  var MAX_SESSION_CANDIDATES = 32;
  var MAX_SOURCE_TEXT_CHARS = 5000;

  function text(value) { return value == null ? '' : String(value); }

  function terminalPunctuation(value) {
    var s = String(value == null ? '' : value).trim();
    if (/[?？]$/.test(s)) return '';
    if (/[!。]$/.test(s)) s = s.slice(0, -1).trim();
    else if (/\.$/.test(s)) s = s.slice(0, -1).trim();
    return s;
  }

  /* Exact current first-person sentences only. This proposes a candidate;
     it does not decide explicitness and cannot call the report authority. */
  function extractCandidate(rawText, sourceMessageRef) {
    if (!PREF || typeof rawText !== 'string' || rawText.length > MAX_SOURCE_TEXT_CHARS) return null;
    var raw = rawText.trim();
    if (!raw) return null;

    var stance = null;
    var targetSource = '';
    var english = /^I\s+(like|dislike)\s+(.+)$/i.exec(raw);
    if (english) {
      stance = english[1].toLowerCase();
      targetSource = english[2];
    } else {
      var chinese = /^我(喜欢|不喜欢)\s*(.+)$/.exec(raw);
      if (!chinese) return null;
      stance = chinese[1] === '喜欢' ? 'like' : 'dislike';
      targetSource = chinese[2];
    }

    var targetKey = PREF.canonicalTargetKey(terminalPunctuation(targetSource));
    var sourceRef = text(sourceMessageRef).trim();
    if (!PREF.isStance(stance) || targetKey == null || !sourceRef || sourceRef.length > 200) return null;

    /* Closed candidate shape: no scope, provenance, time, report or
       settlement authority is copied from text or a model payload. */
    return Object.freeze({
      version: VERSION,
      stance: stance,
      targetKey: targetKey,
      sourceMessageRef: sourceRef
    });
  }

  function createSession(options) {
    var o = options || {};
    var clock = typeof o.clock === 'function' ? o.clock : function () { return Date.now(); };
    var ttlMs = Number.isFinite(Number(o.ttlMs)) && Number(o.ttlMs) > 0
      ? Math.min(Number(o.ttlMs), 60 * 60 * 1000) : DEFAULT_TTL_MS;
    var candidateIdFactory = typeof o.candidateIdFactory === 'function' ? o.candidateIdFactory : null;
    var requestIdFactory = typeof o.requestIdFactory === 'function' ? o.requestIdFactory : null;
    var records = new Map();
    var sequence = 0;

    function opaqueId(prefix, customFactory) {
      sequence += 1;
      var supplied = customFactory ? text(customFactory(sequence)).trim() : '';
      if (supplied) return prefix + '_' + supplied.replace(/[^A-Za-z0-9._:-]/g, '').slice(0, 100);
      var random = '';
      try {
        if (typeof crypto !== 'undefined' && crypto && typeof crypto.randomUUID === 'function') random = crypto.randomUUID();
      } catch (_) { /* optional browser capability */ }
      if (!random) random = Date.now().toString(36) + '_' + sequence.toString(36) + '_' + Math.random().toString(36).slice(2, 10);
      return prefix + '_' + random;
    }

    function now() {
      var value = Number(clock());
      return Number.isFinite(value) && value >= 0 ? value : Date.now();
    }

    function normalizeScope(scope) {
      var src = scope && typeof scope === 'object' ? scope : {};
      var characterId = text(src.characterId).trim();
      var threadId = text(src.threadId).trim();
      if (!characterId || characterId.length > 200 || threadId.length > 200) return null;
      return { characterId: characterId, threadId: threadId };
    }

    function sourceMatches(candidate, scope, source) {
      if (!source || typeof source !== 'object' || Array.isArray(source)) return false;
      return text(source.id) === candidate.sourceMessageRef
        && text(source.role).toLowerCase() === 'user'
        && text(source.friendId).trim() === scope.characterId
        && text(source.threadId).trim() === scope.threadId
        && typeof source.content === 'string';
    }

    function expireDue(record, at) {
      if (record && record.status === 'pending' && at >= record.expiresAt) {
        record.status = 'expired';
        record.reasonCode = 'candidate-expired';
      }
    }

    function publicState(record) {
      if (!record) return null;
      expireDue(record, now());
      return Object.freeze({
        candidateId: record.candidateId,
        candidate: record.candidate,
        status: record.status,
        expiresAt: record.expiresAt,
        reasonCode: record.reasonCode || null
      });
    }

    function pruneTerminalRecords() {
      if (records.size < MAX_SESSION_CANDIDATES) return;
      records.forEach(function (record, key) {
        if (records.size >= MAX_SESSION_CANDIDATES && record.status !== 'pending' && record.status !== 'confirming') {
          records.delete(key);
        }
      });
    }

    function create(candidateInput, scopeInput, sourceRecord) {
      var src = candidateInput && typeof candidateInput === 'object' && !Array.isArray(candidateInput)
        ? candidateInput : {};
      var scope = normalizeScope(scopeInput);
      var targetKey = PREF && PREF.canonicalTargetKey(text(src.targetKey));
      var stance = text(src.stance);
      var sourceMessageRef = text(src.sourceMessageRef).trim();
      if (src.version !== VERSION || !scope || !PREF || !PREF.isStance(stance)
        || targetKey == null || !sourceMessageRef || sourceMessageRef.length > 200) {
        return { ok: false, status: 'refused', reasonCode: 'invalid-candidate-envelope', candidate: null };
      }

      var candidate = Object.freeze({
        version: VERSION,
        stance: stance,
        targetKey: targetKey,
        sourceMessageRef: sourceMessageRef
      });
      if (!sourceMatches(candidate, scope, sourceRecord)) {
        return { ok: false, status: 'refused', reasonCode: 'source-message-scope-mismatch', candidate: null };
      }

      var at = now();
      records.forEach(function (record) { expireDue(record, at); });
      pruneTerminalRecords();
      if (records.size >= MAX_SESSION_CANDIDATES) {
        return { ok: false, status: 'refused', reasonCode: 'session-capacity', candidate: null };
      }
      var candidateId = opaqueId('ftpc', candidateIdFactory);
      var record = {
        candidateId: candidateId,
        candidate: candidate,
        scope: scope,
        sourceContent: sourceRecord.content,
        createdAt: at,
        expiresAt: at + ttlMs,
        status: 'pending',
        reasonCode: null,
        requestId: null,
        result: null,
        inFlight: null
      };
      records.set(candidateId, record);
      return Object.assign({ ok: true }, publicState(record));
    }

    function get(candidateId) {
      return publicState(records.get(text(candidateId)) || null);
    }

    function expire(candidateId) {
      var record = records.get(text(candidateId));
      if (!record) return null;
      if (record.status === 'pending') {
        record.status = 'expired';
        record.reasonCode = 'candidate-expired';
      }
      return publicState(record);
    }

    function dismiss(candidateId) {
      var record = records.get(text(candidateId));
      if (!record) return { ok: false, status: 'missing', reasonCode: 'candidate-not-found' };
      expireDue(record, now());
      if (record.status !== 'pending') return Object.assign({ ok: false }, publicState(record));
      record.status = 'dismissed';
      record.reasonCode = null;
      return Object.assign({ ok: true }, publicState(record));
    }

    function confirm(candidateId, currentScopeInput, sourceRecord, submit) {
      var record = records.get(text(candidateId));
      if (!record) return Promise.resolve({ ok: false, status: 'missing', reasonCode: 'candidate-not-found' });
      expireDue(record, now());
      if (record.status === 'confirmed') return Promise.resolve({ ok: true, status: 'confirmed', reused: true, result: record.result });
      if (record.status === 'confirming' && record.inFlight) return record.inFlight;
      if (record.status !== 'pending') return Promise.resolve(Object.assign({ ok: false }, publicState(record)));

      var currentScope = normalizeScope(currentScopeInput);
      if (!currentScope || currentScope.characterId !== record.scope.characterId
        || currentScope.threadId !== record.scope.threadId
        || !sourceMatches(record.candidate, record.scope, sourceRecord)
        || text(sourceRecord && sourceRecord.content) !== record.sourceContent) {
        record.status = 'expired';
        record.reasonCode = 'candidate-stale';
        return Promise.resolve({ ok: false, status: 'expired', reasonCode: record.reasonCode });
      }
      if (typeof submit !== 'function') {
        return Promise.resolve({ ok: false, status: 'pending', reasonCode: 'report-action-unavailable' });
      }

      if (!record.requestId) record.requestId = opaqueId('ftrq', requestIdFactory);
      var payload = Object.freeze({
        requestId: record.requestId,
        characterId: currentScope.characterId,
        targetKey: record.candidate.targetKey,
        stance: record.candidate.stance,
        threadId: currentScope.threadId
      });
      record.status = 'confirming';
      record.reasonCode = null;
      record.inFlight = Promise.resolve().then(function () { return submit(payload); }).then(function (result) {
        var body = result && result.payload && result.reportId == null ? result.payload
          : (result && result.body && result.reportId == null ? result.body : result);
        if (body && body.ok === true && typeof body.reportId === 'string' && body.reportId) {
          record.status = 'confirmed';
          record.result = result;
          record.inFlight = null;
          return { ok: true, status: 'confirmed', reused: body.outcome === 'duplicate', result: result };
        }
        record.status = 'pending';
        record.reasonCode = text((body && (body.reasonCode || body.error)) || 'report-action-refused').slice(0, 120);
        record.inFlight = null;
        return { ok: false, status: 'pending', reasonCode: record.reasonCode, result: result };
      }, function (error) {
        record.status = 'pending';
        record.reasonCode = text(error && error.code || 'report-action-unavailable').slice(0, 120);
        record.inFlight = null;
        return { ok: false, status: 'pending', reasonCode: record.reasonCode };
      });
      return record.inFlight;
    }

    return Object.freeze({
      create: create,
      get: get,
      expire: expire,
      dismiss: dismiss,
      confirm: confirm,
      describe: function () {
        return Object.freeze({
          authority: 'UNTRUSTED_EXPLICIT_REPORT_CANDIDATE',
          durable: false,
          confirmationRequired: true,
          ttlMs: ttlMs,
          maxCandidates: MAX_SESSION_CANDIDATES,
          canonicalReportProducer: 'EXISTING_EXPLICIT_PREFERENCE_REPORT_AUTHORITY',
          modelCalls: 0,
          durableWrites: 0,
          memoryWrites: 0,
          relationshipWrites: 0
        });
      }
    });
  }

  return Object.freeze({
    VERSION: VERSION,
    STATUS: STATUS,
    DEFAULT_TTL_MS: DEFAULT_TTL_MS,
    MAX_SESSION_CANDIDATES: MAX_SESSION_CANDIDATES,
    extractCandidate: extractCandidate,
    createSession: createSession
  });
});
