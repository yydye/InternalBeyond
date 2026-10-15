/* Explicit user-requested Memory writes for the existing Chat host. */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.IBChatExplicitMemory = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';

  // A deliberately bounded request grammar: one optional, known request prefix
  // followed by one persistence action. It does not scan arbitrary sentences
  // for memory verbs, which keeps questions, quotations, and ordinary prose out.
  var REQUEST_PREFIX = /^(?:我希望你(?:以后(?:要|请)?)?|你(?:能不能|可以|能)(?:帮我)?|能不能|可不可以|可以帮我|麻烦你(?:帮我)?|请你(?:帮我)?|请|帮我|以后(?:要|请)?)[\s\u3000]*/;
  var ACTIONS = [
    /^把(这个|这件事|它)\s*记下来/,
    /^保存这件事/,
    /^(?:以后(?:要|请)?\s*)?记得/,
    /^记住/,
    /^保存/,
    /^记下来/,
    /^记一下/,
    /^别忘了/
  ];
  var NEGATED_REQUEST = /^(?:请(?:你)?\s*)?(?:不要|不必|无需|不用|不需要|别(?:再)?)\s*(?:请(?:你)?\s*)?(?:记住|记得|保存|记下来|记一下|记)/;
  var META_QUESTION = /(?:是什么意思|是什么(?:意思|含义)|表示什么|指什么|指的是什么|会发生什么|会怎么样)\s*[。.!！?？…]*$/;
  var GENERIC_CAPABILITY_TARGET = /^(?:东西|任何东西|什么东西|信息|任何信息|内容|事情|记忆)$/;

  function cleanFact(value) {
    return String(value || '').trim()
      .replace(/^[\s:：，,、]+/, '')
      .replace(/[\s。.!！?？…]+$/, '')
      .replace(/(?:吗|呢)$/, '')
      .replace(/[\s。.!！?？…]+$/, '')
      .trim();
  }

  function classify(text) {
    var original = String(text == null ? '' : text).trim();
    if (!original || NEGATED_REQUEST.test(original) || META_QUESTION.test(original)) return null;

    var prefixMatch = REQUEST_PREFIX.exec(original);
    var prefix = prefixMatch ? String(prefixMatch[0] || '').trim() : '';
    var remainder = prefixMatch ? original.slice(prefixMatch[0].length).trim() : original;
    var action = null;
    for (var i = 0; i < ACTIONS.length; i++) {
      action = ACTIONS[i].exec(remainder);
      if (action) break;
    }
    if (!action) return null;

    var fact = cleanFact(remainder.slice(action[0].length));
    var capabilityPrefix = /^(?:你(?:能不能|可以|能)|能不能|可不可以)$/.test(prefix);
    if (capabilityPrefix && GENERIC_CAPABILITY_TARGET.test(fact)) return null;

    return {
      kind: 'explicit-memory',
      originalText: original,
      fact: fact,
      needsContent: !fact
    };
  }

  function failure(code) {
    var message = '长期 Memory 写入失败，未保存。';
    if (code === 'home-node-offline' || code === 'home-node-unhealthy') {
      message = 'Home Node 当前不可用，未能保存到长期 Memory。';
    } else if (code === 'home-node-rejected' || code === 'invalid-record') {
      message = 'Home Node 拒绝了这条记忆，未保存。';
    } else if (code === 'memory-authority-unavailable' || code === 'memory-authority-not-ready'
      || code === 'canonical-memory-authority-unavailable') {
      message = 'canonical Memory 写入通道未就绪，未保存。';
    }
    return { handled: true, ok: false, error: code || 'memory-write-failed', replyText: message };
  }

  async function route(input, deps) {
    input = input || {};
    deps = deps || {};
    var intent = classify(input.text);
    if (!intent) return { handled: false, ok: false, error: 'not-explicit-memory-intent' };
    var sourceMessageId = String(input.sourceMessageId || '').trim();
    var conversationId = String(input.conversationId || '').trim();
    if (!sourceMessageId || !conversationId) return failure('memory-provenance-unavailable');

    var fact = intent.fact;
    var referenceIds = [];
    var referenceMemoryIds = [];
    var referenceCore = deps.referenceResolver;
    if (!referenceCore) {
      try { referenceCore = typeof window !== 'undefined' ? window.IBChatReferenceResolution : null; } catch (_) { referenceCore = null; }
    }
    var referenceNeeded = referenceCore && typeof referenceCore.needsResolution === 'function'
      ? referenceCore.needsResolution(input.text)
      : /(?:那个(?:梗|计划|事情|事|地方|供应商|项目|东西|人|话)?|那件(?:事|事情)?|上次(?:那件|那个|那次|我们说的)?|之前(?:说的|那个|那件|那条)?|她说的那个|他说的那个|她提到的那个|还是老地方|你知道我说的是哪个|你知道我说的那个|那个还记得|那个呢|它)/.test(String(input.text || ''));
    if (referenceNeeded) {
      if (!referenceCore || typeof referenceCore.validateForTurn !== 'function') {
        return { handled: false, ok: false, error: 'reference-resolver-unavailable' };
      }
      var referenceCheck = referenceCore.validateForTurn(deps.referenceResolution, {
        userMessage: String(input.text || ''),
        history: Array.isArray(deps.referenceContextMessages) ? deps.referenceContextMessages : [],
        memoryReferences: Array.isArray(deps.referenceMemoryReferences) ? deps.referenceMemoryReferences
          : (Array.isArray(deps.referenceResolution.referenceMemoryReferences) ? deps.referenceResolution.referenceMemoryReferences : []),
        currentMessageId: sourceMessageId,
        conversationId: conversationId,
        friendId: deps.friendId == null ? null : String(deps.friendId),
        threadId: deps.threadId == null ? null : String(deps.threadId)
      });
      if (!referenceCheck || referenceCheck.state !== 'RESOLVED' || !referenceCheck.resolution) {
        return { handled: false, ok: false, error: referenceCheck && referenceCheck.state === 'AMBIGUOUS'
          ? 'reference-ambiguous' : 'reference-unresolved' };
      }
      fact = referenceCheck.resolution.normalizedMeaning;
      referenceIds = referenceCheck.resolution.referentRefs.slice(0, 4).map(String);
      referenceMemoryIds = Array.isArray(referenceCheck.resolution.referentMemoryIds)
        ? referenceCheck.resolution.referentMemoryIds.slice(0, 4).map(String) : [];
    }
    if (intent.needsContent && !fact) {
      return { handled: true, ok: false, error: 'memory-content-unavailable', replyText: '请告诉我要保存的具体内容。' };
    }

    var writer = deps.quickCreateMemory;
    if (typeof writer !== 'function') {
      try { writer = typeof window !== 'undefined' ? window.quickCreateMemory : null; } catch (_) { writer = null; }
    }
    if (typeof writer !== 'function') return failure('canonical-memory-authority-unavailable');

    var payload = {
      canonicalReceipt: true,
      sourceMessageId: sourceMessageId,
      requestId: 'chat-explicit-memory:' + sourceMessageId,
      existingPolicy: 'skip',
      title: fact.slice(0, 80) || '用户明确要求保存的信息',
      summary: fact,
      content: fact,
      source: 'chat',
      sourceId: sourceMessageId,
      sourceTimestamp: Number(input.timestamp) || Date.now(),
      provenance: { sourceMessageId: sourceMessageId, conversationId: conversationId,
        ...(referenceIds.length ? { referenceMessageIds: referenceIds } : {}),
        ...(referenceMemoryIds.length ? { referenceMemoryIds: referenceMemoryIds } : {}) },
      domain: '日常',
      tags: ['用户明确'],
      importance: 5,
      visibility: 'public',
      createdBy: 'user'
    };

    try {
      var result = await writer(payload);
      var receipt = result && result.receipt;
      var revision = receipt && Number(receipt.revision);
      var outcomes = ['created', 'updated', 'skipped', 'duplicate-request'];
      if (!result || result.ok !== true || !receipt || receipt.ok !== true
        || receipt.authority !== 'home-node' || String(receipt.id || '') !== String(result.id || '')
        || !result.id || receipt.revision == null || !isFinite(revision) || revision < 0
        || outcomes.indexOf(String(receipt.outcome || '')) < 0) {
        return failure((receipt && receipt.error) || 'canonical-memory-receipt-invalid');
      }
      return {
        handled: true,
        ok: true,
        fact: fact,
        id: String(result.id),
        receipt: receipt,
        replyText: '记住了：' + fact
      };
    } catch (error) {
      return failure(String(error && error.code || 'memory-write-failed'));
    }
  }

  return { classify: classify, route: route };
});
