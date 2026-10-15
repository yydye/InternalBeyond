/* Chat ordinary-message candidate admission. The model proposes; this runtime
   validates evidence, policy, duplication, and provenance before the existing
   canonical Memory writer can reach Home Node. */
(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.IBChatImplicitMemory = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this), function (root) {
  'use strict';

  var CATEGORIES = {
    personal_fact: { domain: '日常', tag: '个人事实' },
    preference: { domain: '日常', tag: '偏好' },
    ongoing_plan: { domain: '日常', tag: '持续计划' },
    ongoing_project: { domain: '创作', tag: '进行中的项目' },
    provider_change: { domain: '思考', tag: '工具变更' }
  };
  var MIN_CONFIDENCE = 80;
  var MIN_FUTURE_VALUE = 0.65;
  var MAX_UNCERTAINTY = 0.25;
  var DUPLICATE_THRESHOLD = 0.8;
  var pendingByMessage = Object.create(null);

  function fail(reason, extra) {
    return Object.assign({ ok: false, admitted: false, reason: reason }, extra || {});
  }

  function parseCreateOperation(op) {
    if (!op || String(op.kind || '').toLowerCase() !== 'create') return null;
    var value;
    try { value = JSON.parse(String(op.body || '')); } catch (_) { return null; }
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  }

  function numberInRange(value, min, max) {
    var number = Number(value);
    return isFinite(number) && number >= min && number <= max ? number : null;
  }

  function normalizeCandidate(raw, userText) {
    if (!raw || typeof raw !== 'object') return fail('candidate-invalid');
    var content = String(raw.content || '').trim();
    var evidence = String(raw.evidence || '').trim();
    var category = String(raw.category || '').trim();
    var policy = CATEGORIES[category];
    if (!policy) return fail('category-unsupported');
    if (content.length < 6 || content.length > 500) return fail('content-size-invalid');
    if (evidence.length < 4 || evidence.length > 240 || !String(userText || '').includes(evidence)) {
      return fail('evidence-not-grounded');
    }

    var durability = String(raw.durability || '').trim();
    if (durability !== 'stable' && durability !== 'ongoing') return fail('not-durable');
    var relevance = String(raw.userRelevance || '').trim();
    if (relevance !== 'high') return fail('user-relevance-insufficient');
    var confidence = numberInRange(raw.confidence, 0, 100);
    var futureValue = numberInRange(raw.futureValue, 0, 1);
    var uncertainty = numberInRange(raw.uncertainty, 0, 1);
    if (confidence == null || confidence < MIN_CONFIDENCE) return fail('confidence-low');
    if (futureValue == null || futureValue < MIN_FUTURE_VALUE) return fail('future-value-low');
    if (uncertainty == null || uncertainty > MAX_UNCERTAINTY) return fail('uncertainty-high');

    var reasons = Array.isArray(raw.reasons) ? raw.reasons : (raw.reason ? [raw.reason] : []);
    reasons = reasons.map(function (item) { return String(item || '').trim(); }).filter(Boolean).slice(0, 3);
    if (!reasons.length) return fail('reason-missing');

    // Build a closed object. Model supplied identity, revision, authority,
    // provenance, and canonical flags are deliberately never copied.
    return {
      ok: true,
      candidate: {
        content: content,
        evidence: evidence,
        category: category,
        domain: policy.domain,
        tag: policy.tag,
        durability: durability,
        confidence: confidence,
        futureValue: futureValue,
        uncertainty: uncertainty,
        reasons: reasons
      }
    };
  }

  function getAuthority(deps) {
    if (deps && deps.authority) return deps.authority;
    try {
      var host = root && (root.window || root);
      var surface = host && host.IB && host.IB.homeNode && host.IB.homeNode.memory;
      return surface && (surface.authority || surface.instance) || null;
    } catch (_) { return null; }
  }

  async function readCanonicalRecords(authority) {
    if (!authority || typeof authority.status !== 'function'
      || typeof authority.probe !== 'function' || typeof authority.getAll !== 'function') {
      return { ok: false, reason: 'canonical-authority-unavailable' };
    }
    var before;
    try { before = authority.status(); } catch (_) { before = null; }
    if (!before || before.mode !== 'canonical' || before.fileOrigin === true) {
      return { ok: false, reason: 'canonical-authority-unavailable' };
    }
    var health;
    try { health = await authority.probe(); } catch (_) { health = null; }
    if (!health || health.online !== true) return { ok: false, reason: 'home-node-offline' };
    var records;
    try { records = await authority.getAll(); } catch (_) { records = null; }
    var after;
    try { after = authority.status(); } catch (_) { after = null; }
    if (!Array.isArray(records) || !after || after.mode !== 'canonical'
      || after.remoteOnline !== true || after.hydrated !== true || after.fullHistory !== true) {
      return { ok: false, reason: 'canonical-memory-read-unavailable' };
    }
    return { ok: true, records: records };
  }

  function normalizeText(value) {
    return String(value || '').toLowerCase().replace(/[\s\u3000，。！？、,.!?;；:：“”"'‘’()（）\[\]【】]/g, '');
  }

  function isDuplicate(candidate, records, deps) {
    var host = root && (root.window || root);
    var similarity = deps && deps.similarity;
    if (typeof similarity !== 'function') {
      try { similarity = host && host._activeTextSimilarity; } catch (_) { similarity = null; }
    }
    var candidateText = candidate.content;
    var candidateNormalized = normalizeText(candidateText);
    for (var i = 0; i < records.length; i++) {
      var row = records[i] || {};
      var fields = [row.content, row.summary, row.title];
      for (var j = 0; j < fields.length; j++) {
        var text = String(fields[j] || '').trim();
        if (!text) continue;
        if (normalizeText(text) === candidateNormalized) return row;
        if (typeof similarity === 'function') {
          try { if (Number(similarity(candidateText, text)) >= DUPLICATE_THRESHOLD) return row; } catch (_) {}
        }
      }
    }
    return null;
  }

  function getWriter(deps) {
    if (deps && typeof deps.quickCreateMemory === 'function') return deps.quickCreateMemory;
    try {
      var host = root && (root.window || root);
      return host && typeof host.quickCreateMemory === 'function' ? host.quickCreateMemory : null;
    } catch (_) { return null; }
  }

  function getCalibrator(deps) {
    if (deps && typeof deps.calibrate === 'function') return deps.calibrate;
    try {
      var host = root && (root.window || root);
      return host && typeof host._calibrateMemoryCandidate === 'function' ? host._calibrateMemoryCandidate : null;
    } catch (_) { return null; }
  }

  async function admit(input, deps) {
    input = input || {};
    deps = deps || {};
    var cfg = input.cfg || {};
    if (cfg.autoMem !== true || cfg.amRecordOnly === true) return fail('implicit-memory-disabled');
    var userText = String(input.userText || '');
    var sourceMessageId = String(input.sourceMessageId || '').trim();
    var conversationId = String(input.conversationId || '').trim();
    if (!sourceMessageId || !conversationId) return fail('provenance-unavailable');

    var operations = Array.isArray(input.operations) ? input.operations : (input.operation ? [input.operation] : []);
    var op = operations.find(function (item) { return item && String(item.kind || '').toLowerCase() === 'create'; });
    var raw = parseCreateOperation(op);
    if (!raw) return fail('candidate-missing-or-malformed');
    var normalized = normalizeCandidate(raw, userText);
    if (!normalized.ok) return normalized;
    var candidate = normalized.candidate;
    var referenceResolution = null;
    var referenceCore = deps.referenceResolver;
    if (!referenceCore) {
      try { referenceCore = root && (root.IBChatReferenceResolution || (root.window && root.window.IBChatReferenceResolution)); } catch (_) { referenceCore = null; }
    }
    if (referenceCore && typeof referenceCore.needsResolution === 'function' && referenceCore.needsResolution(userText)) {
      if (typeof referenceCore.validateForTurn !== 'function') return fail('reference-resolver-unavailable');
      var referenceCheck = referenceCore.validateForTurn(input.referenceResolution, {
        userMessage: userText,
        history: Array.isArray(input.referenceContextMessages) ? input.referenceContextMessages : [],
        memoryReferences: Array.isArray(input.referenceMemoryReferences) ? input.referenceMemoryReferences
          : (Array.isArray(input.referenceResolution.referenceMemoryReferences) ? input.referenceResolution.referenceMemoryReferences : []),
        currentMessageId: sourceMessageId,
        conversationId: conversationId,
        friendId: input.friendId == null ? null : String(input.friendId),
        threadId: input.threadId == null ? null : String(input.threadId)
      });
      if (!referenceCheck || referenceCheck.state !== 'RESOLVED' || !referenceCheck.resolution) {
        return fail(referenceCheck && referenceCheck.state === 'AMBIGUOUS' ? 'reference-ambiguous' : 'reference-unresolved');
      }
      referenceResolution = referenceCheck.resolution;
      candidate.content = referenceResolution.normalizedMeaning;
    } else if (!referenceCore && /(?:那个|那件|上次|之前|老地方|她说的|他说的|它)/.test(userText)) {
      /* The bounded marker guard only activates resolution. It never supplies a
         referent; without the derived resolver, don't admit a dangling fact. */
      return fail('reference-resolver-unavailable');
    }

    var authority = getAuthority(deps);
    var read = await readCanonicalRecords(authority);
    if (!read.ok) return fail(read.reason);
    var duplicate = isDuplicate(candidate, read.records, deps);
    if (duplicate) return { ok: true, admitted: false, reason: 'duplicate', duplicateId: String(duplicate.id || '') };

    var calibrate = getCalibrator(deps);
    if (!calibrate) return fail('admission-unavailable');
    var calibrated;
    var admissionReasons = candidate.reasons.slice();
    admissionReasons.push('用户明确表达并提供了原文证据');
    admissionReasons.push('信息具有对未来互动的持续价值');
    try {
      calibrated = await calibrate({
        content: candidate.content,
        confidence: candidate.confidence,
        reasons: admissionReasons,
        operation: 'create',
        targetStore: 'memories',
        cfg: cfg,
        category: candidate.category === 'preference' ? 'user_instructions' : 'long_term_background',
        createdByUser: true,
        repeatCount: 0
      });
    } catch (_) { calibrated = null; }
    if (!calibrated || calibrated.rejected) return fail('admission-rejected', { admissionReason: calibrated && calibrated.rejected || 'admission-unavailable' });
    var score = Number(calibrated.confidence);
    if (!isFinite(score) || score < 70) return fail('admission-score-low');

    var writer = getWriter(deps);
    if (!writer) return fail('canonical-writer-unavailable');
    var timestamp = Number(input.timestamp);
    if (!isFinite(timestamp) || timestamp <= 0) timestamp = Date.now();
    var payload = {
      canonicalReceipt: true,
      sourceMessageId: sourceMessageId,
      requestId: 'chat-implicit-memory:' + sourceMessageId,
      existingPolicy: 'skip',
      title: candidate.content.slice(0, 80),
      summary: candidate.content,
      content: candidate.content,
      source: 'chat_implicit',
      sourceId: sourceMessageId,
      sourceTimestamp: timestamp,
      provenance: { sourceMessageId: sourceMessageId, conversationId: conversationId },
      domain: candidate.domain,
      tags: ['隐式候选', candidate.tag],
      importance: candidate.category === 'personal_fact' || candidate.category === 'preference' ? 7 : 6,
      visibility: 'public',
      createdBy: 'user'
    };
    if (referenceResolution && Array.isArray(referenceResolution.referentRefs)) {
      payload.provenance.referenceMessageIds = referenceResolution.referentRefs.slice(0, 4).map(String);
    }
    if (referenceResolution && Array.isArray(referenceResolution.referentMemoryIds) && referenceResolution.referentMemoryIds.length) {
      payload.provenance.referenceMemoryIds = referenceResolution.referentMemoryIds.slice(0, 4).map(String);
    }

    var result;
    try { result = await writer(payload); } catch (error) { return fail('canonical-write-failed', { error: String(error && error.code || error && error.message || 'write-failed') }); }
    var receipt = result && result.receipt;
    var revision = receipt && Number(receipt.revision);
    if (!result || result.ok !== true || !result.id || !receipt || receipt.ok !== true
      || receipt.authority !== 'home-node' || String(receipt.id || '') !== String(result.id)
      || receipt.revision == null || !isFinite(revision) || revision < 0
      || ['created', 'updated', 'skipped', 'duplicate-request'].indexOf(String(receipt.outcome || '')) < 0) {
      return fail((receipt && receipt.error) || 'canonical-memory-receipt-invalid');
    }
    return { ok: true, admitted: true, id: String(result.id), receipt: receipt, candidate: candidate,
      referenceResolution: referenceResolution };
  }

  function schedule(input, deps) {
    input = input || {};
    deps = deps || {};
    var messageId = String(input.sourceMessageId || '').trim();
    if (!messageId || pendingByMessage[messageId]) return;
    pendingByMessage[messageId] = true;
    var run = deps.process || admit;
    Promise.resolve().then(function () { return run(input, deps); })
      .then(function (result) { if (typeof deps.onResult === 'function') deps.onResult(result); })
      .catch(function () {})
      .then(function () { delete pendingByMessage[messageId]; });
  }

  return {
    parseCreateOperation: parseCreateOperation,
    normalizeCandidate: normalizeCandidate,
    admit: admit,
    schedule: schedule
  };
});
