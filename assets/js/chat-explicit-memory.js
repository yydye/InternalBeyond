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
  var REQUEST_PREFIX = /^(?:我希望你(?:以后(?:要|请)?)?|你(?:能不能|可以|能)(?:帮我)?|能不能|能(?=记(?:住|得|下来|一下)|保存)|可不可以|可以帮我|麻烦你(?:帮我)?|请你(?:帮我)?|请|帮我|以后(?:要|请)?)[\s\u3000]*/;
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
  var MODEL_MEMORY_PROMPT = '\n\n【显式 Memory 操作】\n'
    + '你可以根据用户当前这条消息，用一次结构化操作记住、修改或删除 Home Node canonical Memory。只在用户明确要求记住/保存/改正/删除一条长期记忆时操作；普通事实陈述、提问、否定、假设、引用或闲聊都不要操作。\n'
    + '需要操作时，只输出一个 <ws_mem_write>JSON</ws_mem_write>，必须是回复的第一项内容，标签外不要写任何文字，也不要声称已成功。Host 会执行操作并根据真实回执回复。每条消息最多一个操作。\n'
    + 'JSON 字段：action=create|update|delete，intentEvidence（当前用户消息中逐字引用的明确操作意图），evidence（当前消息中逐字引用的事实或目标线索）。不得输出 memory id、revision、authority、visibility 或凭据。\n'
    + 'create 另需 title、summary、content、domain（情感/日常/创作/思考）、tags（字符串数组）和 importance（1–10）。内容只写用户要求记住的事实。\n'
    + 'update 需 target（记忆标题或内容线索）和至少一个更新字段；content 必须是修改后的完整正文。不要猜测记忆 id。\n'
    + 'delete 只需 target。Host 会先展示待删记忆并要求用户确认；不得自行确认或声称已删除。\n'
    + '找不到唯一修改目标时，Host 会要求用户澄清，不会猜选。指令彼此冲突或材料不足时不要操作，直接询问用户。\n'
    + '当用户明确要求操作 canonical Memory 时，不要同时输出 <mem_create>、<mem_update> 或 <mem_delete>。';

  function cleanFact(value) {
    return String(value || '').trim()
      .replace(/^[\s:：，,、]+/, '')
      .replace(/(?:吗|呢)[?？]\s*(?:是|为)\s*/g, '是')
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
    var capabilityPrefix = /^(?:你(?:能不能|可以|能)|能不能|能|可不可以)$/.test(prefix);
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

  function modelOperationPrompt() { return MODEL_MEMORY_PROMPT; }

  function parseModelOperation(text) {
    var raw = String(text == null ? '' : text);
    var re = /<ws_mem_write\b[^>]*>([\s\S]*?)<\/ws_mem_write\s*>/ig;
    var matches = [], match;
    while ((match = re.exec(raw)) !== null) matches.push({ index: match.index, end: re.lastIndex, body: match[1] });
    var openAt = raw.search(/<ws_mem_write\b/i);
    if (openAt < 0) return { detected: false, cleanText: raw };
    var cleanText = raw.replace(/<ws_mem_write\b[^>]*>[\s\S]*?(?:<\/ws_mem_write\s*>|$)/ig, '').trim();
    if (matches.length !== 1 || openAt !== matches[0].index) {
      return { detected: true, valid: false, error: matches.length > 1 ? 'multiple-operations' : 'operation-malformed', cleanText: cleanText };
    }
    var entry = matches[0];
    if (raw.slice(0, entry.index).trim() || raw.slice(entry.end).trim()) {
      return { detected: true, valid: false, error: 'operation-must-be-standalone', cleanText: cleanText };
    }
    if (entry.body.length > 12000) return { detected: true, valid: false, error: 'operation-too-large', cleanText: '' };
    var payload;
    try { payload = JSON.parse(String(entry.body || '').trim()); } catch (_) { payload = null; }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return { detected: true, valid: false, error: 'operation-json-invalid', cleanText: '' };
    }
    var allowed = ['action','intentEvidence','evidence','target','title','summary','content','domain','tags','importance'];
    if (Object.keys(payload).some(function (key) { return allowed.indexOf(key) < 0; })) {
      return { detected: true, valid: false, error: 'operation-field-invalid', cleanText: '' };
    }
    var action = String(payload.action || '').trim().toLowerCase();
    if (['create','update','delete'].indexOf(action) < 0) {
      return { detected: true, valid: false, error: 'operation-action-invalid', cleanText: '' };
    }
    return { detected: true, valid: true, operation: Object.assign({}, payload, { action: action }), cleanText: '' };
  }

  function modelHost() {
    try { return typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null); }
    catch (_) { return null; }
  }

  function modelAuthority(deps) {
    if (deps && deps.authority) return deps.authority;
    try {
      var host = modelHost();
      var surface = host && host.IB && host.IB.homeNode && host.IB.homeNode.memory;
      return surface && (surface.authority || surface.instance) || null;
    } catch (_) { return null; }
  }

  function modelWriter(deps) {
    if (deps && typeof deps.quickCreateMemory === 'function') return deps.quickCreateMemory;
    try { var host = modelHost(); return host && typeof host.quickCreateMemory === 'function' ? host.quickCreateMemory : null; }
    catch (_) { return null; }
  }

  async function readModelCanonicalRecords(authority) {
    var before;
    try { before = authority && typeof authority.status === 'function' ? authority.status() : null; } catch (_) { before = null; }
    if (!authority || !before || before.mode !== 'canonical' || before.fileOrigin === true) {
      return { ok: false, reason: 'canonical-authority-unavailable' };
    }
    if (typeof authority.probe !== 'function' || typeof authority.getAll !== 'function') {
      return { ok: false, reason: 'canonical-authority-unavailable' };
    }
    var health;
    try { health = await authority.probe(); } catch (_) { health = null; }
    if (!health || health.online !== true) return { ok: false, reason: 'home-node-offline' };
    var records;
    try { records = await authority.getAll(); } catch (_) { records = null; }
    var after;
    try { after = authority.status(); } catch (_) { after = null; }
    if (!Array.isArray(records) || !after || after.mode !== 'canonical' || after.fileOrigin === true
      || after.remoteOnline !== true || after.hydrated !== true || after.fullHistory !== true) {
      return { ok: false, reason: 'canonical-memory-read-unavailable' };
    }
    return { ok: true, records: records };
  }

  function modelVisible(record, roleId, deps) {
    var visible = deps && deps.isMemoryVisibleTo;
    if (typeof visible !== 'function') {
      var host = modelHost();
      visible = host && (host.isMemoryVisibleTo || (host.IB && host.IB.memory && host.IB.memory.isMemoryVisibleTo));
    }
    if (typeof visible !== 'function') return false;
    try { return visible(record, String(roleId || ''), false, false) === true; } catch (_) { return false; }
  }

  function normalizeTarget(value) {
    return String(value || '').toLowerCase().replace(/[\s\u3000，。！？、,.!?;；:：“”\"'‘’()（）\[\]【】《》]/g, '').trim();
  }

  function resolveModelTarget(target, records, roleId, deps) {
    var needle = normalizeTarget(target);
    if (!needle || /^mem_[a-z0-9_-]+$/i.test(String(target || '').trim())) return { state: 'missing', matches: [] };
    var visible = (records || []).filter(function (record) { return record && modelVisible(record, roleId, deps); });
    var exact = visible.filter(function (record) {
      return [record.title, record.summary, record.content].some(function (field) { return normalizeTarget(field) === needle; });
    });
    var matches = exact.length ? exact : visible.filter(function (record) {
      return [record.title, record.summary, record.content].some(function (field) {
        var hay = normalizeTarget(field);
        return hay && hay.indexOf(needle) >= 0;
      });
    });
    if (!matches.length) return { state: 'missing', matches: [] };
    if (matches.length > 1) return { state: 'ambiguous', matches: matches.slice(0, 5) };
    return { state: 'unique', record: matches[0], matches: matches };
  }

  function modelRecordFingerprint(record) {
    record = record || {};
    return JSON.stringify([
      String(record.id || ''), String(record.title || ''), String(record.summary || ''), String(record.content || ''),
      String(record.domain || ''), JSON.stringify(Array.isArray(record.tags) ? record.tags : []),
      Number(record.created) || 0, Number(record.updated) || 0, !!record.resolved,
      String(record.visibility || ''), JSON.stringify(Array.isArray(record.visibleTo) ? record.visibleTo : []),
      JSON.stringify(Array.isArray(record.excludeFrom) ? record.excludeFrom : [])
    ]);
  }

  function validModelReceipt(result, expectedId, outcomes) {
    var receipt = result && result.receipt;
    var revision = receipt && Number(receipt.revision);
    return !!(result && result.ok === true && result.id && String(result.id) === String(expectedId)
      && receipt && receipt.ok === true && receipt.authority === 'home-node'
      && String(receipt.id || '') === String(expectedId) && receipt.revision != null
      && isFinite(revision) && revision >= 0 && outcomes.indexOf(String(receipt.outcome || '')) >= 0);
  }

  function modelEvidence(input, operation) {
    var text = String(input && input.userText || '');
    if (typeof operation.intentEvidence !== 'string' || typeof operation.evidence !== 'string') return false;
    var intent = operation.intentEvidence.trim(), evidence = operation.evidence.trim();
    return intent.length >= 2 && intent.length <= 240 && text.indexOf(intent) >= 0
      && evidence.length >= 2 && evidence.length <= 240 && text.indexOf(evidence) >= 0;
  }

  function modelReply(ok, status, replyText, details) {
    return Object.assign({ handled: true, ok: ok === true, status: String(status || ''), replyText: String(replyText || '') }, details || {});
  }

  function modelErrorText(reason, action) {
    if (reason === 'home-node-offline') return 'Home Node 当前不可用，这次 Memory 操作没有完成。';
    if (reason === 'canonical-memory-read-unavailable') return '目前无法核对现有记忆，这次 Memory 操作没有完成。';
    if (reason === 'canonical-authority-unavailable' || reason === 'canonical-writer-unavailable') return 'canonical Memory 通道未就绪，这次操作没有完成。';
    if (reason === 'target-ambiguous') return '我找到多条可能相关的记忆，尚未修改。请先指出要处理的标题。';
    if (reason === 'target-not-found') return '没有找到匹配的 canonical Memory，未作修改。';
    if (reason === 'confirmation-unavailable') return '删除确认界面不可用，记忆没有删除。';
    if (reason === 'memory-record-changed') return '目标记忆在确认期间发生了变化，操作已取消。';
    if (reason === 'operation-invalid' || reason === 'operation-evidence-invalid') return '记忆操作内容无法核实，没有执行。请用一句话说明要记住、修改或删除什么。';
    return action === 'delete' ? '记忆没有删除。' : action === 'update' ? '记忆没有更新。' : '这条记忆没有保存。';
  }

  async function executeModelOperation(input, deps) {
    input = input || {};
    deps = deps || {};
    var operation = input.operation && typeof input.operation === 'object' ? input.operation : null;
    var action = String(operation && operation.action || '').toLowerCase();
    if (!operation || ['create','update','delete'].indexOf(action) < 0) {
      return modelReply(false, 'failed', modelErrorText('operation-invalid', action), { reason: 'operation-invalid' });
    }
    if (!modelEvidence(input, operation)) {
      return modelReply(false, 'failed', modelErrorText('operation-evidence-invalid', action), { reason: 'operation-evidence-invalid' });
    }
    var sourceMessageId = String(input.sourceMessageId || '').trim();
    var conversationId = String(input.conversationId || '').trim();
    var roleId = String(input.friendId || (input.cfg && input.cfg.id) || '');
    if (!sourceMessageId || !conversationId || !roleId) {
      return modelReply(false, 'failed', modelErrorText('operation-invalid', action), { reason: 'operation-invalid' });
    }
    var authority = modelAuthority(deps);
    var read = await readModelCanonicalRecords(authority);
    if (!read.ok) return modelReply(false, 'failed', modelErrorText(read.reason, action), { reason: read.reason });

    if (action === 'create') {
      var content = typeof operation.content === 'string' ? operation.content.trim() : '';
      var title = typeof operation.title === 'string' ? operation.title.trim() : '';
      var summary = typeof operation.summary === 'string' ? operation.summary.trim() : '';
      var domains = ['情感','日常','创作','思考'];
      var domain = typeof operation.domain === 'string' ? operation.domain.trim() : (operation.domain == null ? '日常' : '');
      if (!content || content.length > 6000 || title.length > 80 || summary.length > 240 || domains.indexOf(domain) < 0
        || (operation.tags != null && !Array.isArray(operation.tags))
        || (Array.isArray(operation.tags) && operation.tags.some(function (item) { return typeof item !== 'string'; }))
        || (operation.importance != null && (typeof operation.importance !== 'number' || !isFinite(operation.importance) || operation.importance < 1 || operation.importance > 10))) {
        return modelReply(false, 'failed', modelErrorText('operation-invalid', action), { reason: 'operation-invalid' });
      }
      var tags = Array.isArray(operation.tags)
        ? Array.from(new Set(operation.tags.map(function (item) { return String(item || '').trim().slice(0, 24); }).filter(Boolean))).slice(0, 6)
        : [];
      var normalizedContent = normalizeTarget(content);
      var duplicate = read.records.find(function (record) {
        return modelVisible(record, roleId, deps) && normalizeTarget(record.content) === normalizedContent;
      });
      if (duplicate) return modelReply(true, 'duplicate', '已经有相同内容的记忆，没有重复新增：' + String(duplicate.title || content.slice(0, 48)),
        { duplicate: true, existingId: String(duplicate.id || '') });
      var writer = modelWriter(deps);
      if (!writer) return modelReply(false, 'failed', modelErrorText('canonical-writer-unavailable', action), { reason: 'canonical-writer-unavailable' });
      if (!title) title = content.replace(/\s+/g, ' ').slice(0, 80);
      if (!summary) summary = content.replace(/\s+/g, ' ').slice(0, 120);
      if (!tags.length) tags = ['用户明确'];
      var payload = {
        canonicalReceipt: true,
        sourceMessageId: sourceMessageId,
        requestId: 'chat-model-memory-create:' + sourceMessageId,
        existingPolicy: 'skip',
        title: title,
        summary: summary,
        content: content,
        source: 'chat',
        sourceId: sourceMessageId,
        sourceTimestamp: Number(input.timestamp) > 0 ? Number(input.timestamp) : Date.now(),
        provenance: { sourceMessageId: sourceMessageId, conversationId: conversationId },
        domain: domain,
        tags: Array.from(new Set(['用户明确'].concat(tags))).slice(0, 7),
        importance: operation.importance == null ? 5 : Math.round(Number(operation.importance)),
        visibility: 'public',
        createdBy: 'user'
      };
      try {
        var created = await writer(payload);
        if (!validModelReceipt(created, created && created.id, ['created','updated','skipped','duplicate-request'])) {
          return modelReply(false, 'failed', modelErrorText((created && created.receipt && created.receipt.error) || 'write-failed', action),
            { reason: (created && created.receipt && created.receipt.error) || 'canonical-memory-receipt-invalid' });
        }
        var writeOutcome = String(created.receipt.outcome || '');
        return modelReply(true, writeOutcome === 'created' ? 'written' : 'existing',
          writeOutcome === 'created' ? '已记住：' + title : '记忆已确认存在，没有重复新增：' + title,
          { id: String(created.id), receipt: created.receipt, duplicate: writeOutcome !== 'created' });
      } catch (error) {
        var createReason = String(error && error.code || 'canonical-write-failed');
        return modelReply(false, 'failed', modelErrorText(createReason, action), { reason: createReason });
      }
    }

    var target = typeof operation.target === 'string' ? operation.target.trim() : '';
    if (target.length < 2 || target.length > 160) {
      return modelReply(false, 'failed', modelErrorText('operation-invalid', action), { reason: 'operation-invalid' });
    }
    var resolved = resolveModelTarget(target, read.records, roleId, deps);
    if (resolved.state === 'missing') return modelReply(false, 'failed', modelErrorText('target-not-found', action), { reason: 'target-not-found' });
    if (resolved.state === 'ambiguous') {
      var labels = resolved.matches.map(function (record) { return '《' + String(record.title || '无标题').slice(0, 60) + '》'; });
      return modelReply(false, 'clarification', '我找到多条可能相关的记忆：' + labels.join('、') + '。请告诉我要处理哪一条；目前没有修改。',
        { reason: 'target-ambiguous', matchCount: resolved.matches.length });
    }
    var targetRecord = resolved.record;
    var targetId = String(targetRecord && targetRecord.id || '');
    if (!targetId) return modelReply(false, 'failed', modelErrorText('target-not-found', action), { reason: 'target-not-found' });
    var beforeFingerprint = modelRecordFingerprint(targetRecord);

    if (action === 'delete') {
      var approval = deps.requestApproval;
      if (typeof approval !== 'function') {
        var approvalHost = modelHost();
        approval = approvalHost && approvalHost.requestMemoryApproval;
      }
      if (typeof approval !== 'function') {
        return modelReply(false, 'failed', modelErrorText('confirmation-unavailable', action), { reason: 'confirmation-unavailable' });
      }
      try {
        var decision = await approval({
          operation: 'delete', targetStore: 'memories', characterName: String((input.cfg && (input.cfg.nickname || input.cfg.model)) || 'Chat'),
          oldContent: String(targetRecord.content || ''), source: 'Chat · ' + String(targetRecord.title || '长期记忆'),
          confidence: 100, reasons: ['用户明确要求删除', '删除前需要本人确认'],
          commit: async function () {
            var latest = await readModelCanonicalRecords(authority);
            if (!latest.ok) throw Object.assign(new Error(modelErrorText(latest.reason, action)), { code: latest.reason });
            var fresh = latest.records.find(function (record) { return String(record && record.id || '') === targetId; });
            if (!fresh || !modelVisible(fresh, roleId, deps) || modelRecordFingerprint(fresh) !== beforeFingerprint) {
              throw Object.assign(new Error('目标记忆已变化，未删除。'), { code: 'memory-record-changed' });
            }
            var result = await authority.remove(targetId);
            if (!result || result.ok !== true || result.authority !== 'home-node' || result.outcome !== 'deleted'
              || !isFinite(Number(result.revision)) || Number(result.revision) < 0) {
              throw Object.assign(new Error('Home Node 没有确认删除。'), { code: (result && result.error) || 'canonical-memory-receipt-invalid' });
            }
            try { if (typeof deps.reconcileReferences === 'function') await deps.reconcileReferences(targetId); } catch (_) {}
            return result;
          }
        });
        if (!decision || decision.approved !== true || !decision.value) {
          var ignored = !!(decision && decision.ignored);
          return modelReply(false, ignored ? 'cancelled' : 'failed', ignored ? '好的，已取消删除；原记忆保持不变。' : modelErrorText('home-node-rejected', action),
            { reason: ignored ? 'user-cancelled' : String((decision && decision.error && decision.error.code) || 'delete-not-confirmed') });
        }
        var deleteReceipt = decision.value;
        if (deleteReceipt.authority !== 'home-node' || deleteReceipt.outcome !== 'deleted'
          || !isFinite(Number(deleteReceipt.revision)) || Number(deleteReceipt.revision) < 0) {
          return modelReply(false, 'failed', modelErrorText('canonical-memory-receipt-invalid', action), { reason: 'canonical-memory-receipt-invalid' });
        }
        return modelReply(true, 'deleted', '已删除记忆：' + String(targetRecord.title || '这条记忆'),
          { id: targetId, receipt: deleteReceipt });
      } catch (error) {
        var deleteReason = String(error && error.code || 'canonical-delete-failed');
        return modelReply(false, 'failed', modelErrorText(deleteReason, action), { reason: deleteReason });
      }
    }

    var updateKeys = ['title','summary','content','domain','tags','importance'];
    var hasUpdate = updateKeys.some(function (key) { return Object.prototype.hasOwnProperty.call(operation, key); });
    if (!hasUpdate || (operation.content != null && String(operation.content).trim().length > 6000)
      || (operation.content != null && typeof operation.content !== 'string')
      || (operation.title != null && (typeof operation.title !== 'string' || operation.title.trim().length > 120))
      || (operation.summary != null && (typeof operation.summary !== 'string' || operation.summary.trim().length > 300))
      || (operation.domain != null && (typeof operation.domain !== 'string' || ['情感','日常','创作','思考'].indexOf(operation.domain) < 0))
      || (operation.tags != null && !Array.isArray(operation.tags))
      || (Array.isArray(operation.tags) && operation.tags.some(function (tag) { return typeof tag !== 'string'; }))
      || (operation.importance != null && (typeof operation.importance !== 'number' || !isFinite(operation.importance) || operation.importance < 1 || operation.importance > 10))) {
      return modelReply(false, 'failed', modelErrorText('operation-invalid', action), { reason: 'operation-invalid' });
    }
    var updated = Object.assign({}, targetRecord);
    ['title','summary','content','domain'].forEach(function (key) {
      if (Object.prototype.hasOwnProperty.call(operation, key)) updated[key] = String(operation[key] == null ? '' : operation[key]).trim();
    });
    if (Object.prototype.hasOwnProperty.call(operation, 'tags')) {
      updated.tags = Array.from(new Set(operation.tags.map(function (tag) { return String(tag || '').trim().slice(0, 24); }).filter(Boolean))).slice(0, 10);
    }
    if (operation.importance != null) updated.importance = Math.max(1, Math.min(10, Math.round(Number(operation.importance))));
    if (!String(updated.title || '').trim() || !String(updated.content || '').trim()) {
      return modelReply(false, 'failed', modelErrorText('operation-invalid', action), { reason: 'operation-invalid' });
    }
    try {
      var latestUpdate = await readModelCanonicalRecords(authority);
      if (!latestUpdate.ok) return modelReply(false, 'failed', modelErrorText(latestUpdate.reason, action), { reason: latestUpdate.reason });
      var freshUpdate = latestUpdate.records.find(function (record) { return String(record && record.id || '') === targetId; });
      if (!freshUpdate || !modelVisible(freshUpdate, roleId, deps) || modelRecordFingerprint(freshUpdate) !== beforeFingerprint) {
        return modelReply(false, 'failed', modelErrorText('memory-record-changed', action), { reason: 'memory-record-changed' });
      }
      var updatedResult = await authority.put(updated, { requestId: 'chat-model-memory-update:' + sourceMessageId });
      if (!updatedResult || updatedResult.ok !== true || updatedResult.authority !== 'home-node'
        || String(updatedResult.id || '') !== targetId || !isFinite(Number(updatedResult.revision)) || Number(updatedResult.revision) < 0) {
        var updateReason = (updatedResult && updatedResult.error) || 'canonical-memory-receipt-invalid';
        return modelReply(false, 'failed', modelErrorText(updateReason, action), { reason: updateReason });
      }
      try { if (typeof deps.reconcileReferences === 'function') await deps.reconcileReferences(targetId); } catch (_) {}
      return modelReply(true, 'updated', '已更新记忆：' + String(updated.title || '这条记忆'),
        { id: targetId, receipt: updatedResult });
    } catch (error) {
      var updateError = String(error && error.code || 'canonical-write-failed');
      return modelReply(false, 'failed', modelErrorText(updateError, action), { reason: updateError });
    }
  }

  return { classify: classify, route: route, modelOperationPrompt: modelOperationPrompt,
    parseModelOperation: parseModelOperation, executeModelOperation: executeModelOperation };
});
