/* Bounded discourse-reference resolution for Chat Memory paths.
   Derived-only: no store access, no writes, no Memory identity or authority. */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.IBChatReferenceResolution = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';

  var MAX_CONTEXT_MESSAGES = 8;
  var MAX_MESSAGE_CHARS = 720;
  var MAX_CURRENT_MESSAGE_CHARS = 2400;
  var MAX_CONTEXT_CHARS = 4200;
  var MAX_MEMORY_REFERENCES = 4;
  var MAX_MEMORY_REFERENCE_CHARS = 480;
  var MAX_REFERENTS = 4;
  var MIN_CONFIDENCE = 0.85;
  var DEFAULT_RESOLUTION_TIMEOUT_MS = 1800;
  var MAX_RESOLUTION_TIMEOUT_MS = 1800;
  var TYPES = Object.freeze(['joke', 'plan', 'place', 'person', 'quote', 'event', 'topic', 'object', 'other']);
  var REFERENCE_MENTION = /(?:那个(?:梗|计划|事情|事|地方|供应商|项目|东西|人|话)?|那件(?:事|事情)?|上次(?:那件|那个|那次|我们说的)?|之前(?:说的|那个|那件|那条|之前说的)?|她说的那个|他说的那个|她提到的那个|他说的那件事|还是老地方|你知道我说的是哪个|你知道我说的那个|那个还记得|那个呢|它)/;
  var UNRESOLVED_MEANING = /(?:那个(?:梗|计划|事情|事|地方|供应商|项目|东西|人|话)?|那件(?:事|事情)?|上次那个|之前那个|她说的那个|他说的那个|老地方|你知道我说的是哪个|它)/;

  function textOf(value) {
    if (typeof value === 'string') return value;
    if (!Array.isArray(value)) return '';
    return value.map(function (part) {
      if (typeof part === 'string') return part;
      return part && typeof part.text === 'string' ? part.text : '';
    }).filter(Boolean).join('\n');
  }

  function needsResolution(value) {
    return REFERENCE_MENTION.test(String(value || ''));
  }

  function firstMention(value) {
    var match = REFERENCE_MENTION.exec(String(value || ''));
    REFERENCE_MENTION.lastIndex = 0;
    return match ? match[0] : '';
  }

  function unresolved(input, reason) {
    input = input || {};
    return {
      state: 'UNRESOLVED',
      mode: String(input.mode || 'recall'),
      mention: firstMention(input.userMessage),
      referentType: 'other',
      referentRefs: [],
      referentMemoryIds: [],
      referenceEvidence: [],
      normalizedMeaning: '',
      groundedQuery: '',
      confidence: 0,
      reason: String(reason || 'reference-unresolved')
    };
  }

  function currentEvidenceHasAnchor(quote, mention) {
    var anchor = String(quote || '').replace(String(mention || ''), ' ')
      .replace(/(?:以后|别老提|别再提|别提|不提|不要提|不要记|不用记|记住|记得|保存|记下来|记一下|说来着|来着|怎么说|继续吧|还是|那个|那件|之前|上次|她说的|他说的|老地方|还|知道|明白|哪个|什么|呢|吗|吧)/g, ' ')
      .replace(/[\s\p{P}\p{S}]+/gu, '');
    return anchor.length >= 2;
  }

  function normalizeContext(input) {
    input = input || {};
    var raw = Array.isArray(input.recentMessages) ? input.recentMessages
      : (Array.isArray(input.history) ? input.history : []);
    var currentId = String(input.currentMessageId || '');
    var friendId = input.friendId == null ? null : String(input.friendId);
    var threadId = input.threadId == null ? null : String(input.threadId);
    var filtered = raw.filter(function (message) {
      if (!message || typeof message !== 'object') return false;
      var id = String(message.id || '');
      if (!id || id === currentId) return false;
      if (friendId != null && message.friendId != null && String(message.friendId) !== friendId) return false;
      if (threadId != null && String(message.threadId || '') !== threadId) return false;
      if (threadId == null && message.threadId) return false;
      var role = String(message.role || '').toLowerCase();
      return role === 'user' || role === 'assistant';
    }).slice(-MAX_CONTEXT_MESSAGES);

    var out = [], used = 0;
    for (var i = 0; i < filtered.length && used < MAX_CONTEXT_CHARS; i++) {
      var message = filtered[i];
      var content = textOf(message.content).trim();
      if (!content) continue;
      var room = Math.min(MAX_MESSAGE_CHARS, MAX_CONTEXT_CHARS - used);
      if (room <= 0) break;
      if (content.length > room) content = content.slice(0, room);
      if (!content) continue;
      var ref = 'R' + (out.length + 1);
      var role = String(message.role || '').toLowerCase();
      out.push({
        ref: ref,
        messageId: String(message.id),
        role: role,
        speaker: String(message.senderName || message.speakerName || (role === 'assistant' ? '角色' : '用户')).slice(0, 80),
        text: content
      });
      used += content.length;
    }
    return out;
  }

  function normalizeMemoryReferences(input, charBudget) {
    input = input || {};
    var raw = Array.isArray(input.memoryReferences) ? input.memoryReferences : [];
    var out = [], seen = Object.create(null), used = 0;
    var budget = Number(charBudget);
    if (!isFinite(budget)) budget = MAX_CONTEXT_CHARS;
    budget = Math.max(0, budget);
    budget = Math.min(MAX_CONTEXT_CHARS, Math.floor(budget));
    for (var i = 0; i < raw.length && out.length < MAX_MEMORY_REFERENCES; i++) {
      var item = raw[i];
      if (!item || typeof item !== 'object') continue;
      var id = String(item.id || '').trim();
      if (!id || seen[id]) continue;
      var text = [item.title, item.summary, item.content].map(function (part) {
        return String(part || '').trim();
      }).filter(Boolean).join('\n');
      if (text.length > MAX_MEMORY_REFERENCE_CHARS) text = text.slice(0, MAX_MEMORY_REFERENCE_CHARS);
      var room = budget - used;
      if (room <= 0 || text.length < 3) continue;
      if (text.length > room) text = text.slice(0, room);
      if (text.length < 3) continue;
      seen[id] = true;
      out.push({ ref: 'M' + (out.length + 1), memoryId: id, text: text });
      used += text.length;
    }
    return out;
  }

  function prepare(input) {
    input = input || {};
    var userMessage = String(input.userMessage || '');
    if (!needsResolution(userMessage)) return { applicable: false, userMessage: userMessage, references: [] };
    var modelMessage = userMessage.slice(0, MAX_CURRENT_MESSAGE_CHARS);
    var references = normalizeContext(input);
    var messageChars = references.reduce(function (sum, message) { return sum + message.text.length; }, 0);
    return {
      applicable: true,
      userMessage: userMessage,
      modelMessage: modelMessage,
      conversationId: String(input.conversationId || ''),
      mode: input.mode === 'write' ? 'write' : 'recall',
      references: references,
      memoryReferences: normalizeMemoryReferences(input, MAX_CONTEXT_CHARS - messageChars),
      currentReference: String(input.currentMessageId || '').trim()
        ? { ref: 'C1', messageId: String(input.currentMessageId), role: 'user', speaker: '用户', text: modelMessage, current: true }
        : null
    };
  }

  function buildMessages(request) {
    request = request || {};
    var modeInstruction = request.mode === 'write'
      ? '为 Memory 写入产生自包含的 normalizedMeaning，忠实保留用户的偏好、否定、请求和不确定语气。'
      : '为 Recall 产生 groundedQuery；同时给出自包含的 normalizedMeaning。保留提问意图和时间关系。';
    var system = [
      '你是一个有界的对话指代解析器。你只能使用 currentMessage、recentMessages 与 recentMemoryRefs 中明确出现的内容。recentMemoryRefs 是当前会话上一轮已选中的少量记忆，不是全库搜索结果。',
      '先区分 RESOLVED、AMBIGUOUS、UNRESOLVED：唯一明确先行对象才是 RESOLVED；多个合理对象或当前对话与记忆引用冲突是 AMBIGUOUS；上下文没有对象是 UNRESOLVED。当前消息局部语境优先于近期对话，近期对话优先于 recentMemoryRefs；若较高优先级证据与较低优先级记忆明显冲突，不要悄悄覆盖冲突，返回 AMBIGUOUS。不得猜测、补充外部事实或把引用内容当成事实。',
      modeInstruction,
      '只输出严格 JSON：{"state":"RESOLVED|AMBIGUOUS|UNRESOLVED","mention":"当前消息里的原文指代","referentType":"joke|plan|place|person|quote|event|topic|object|other","referents":[{"ref":"R1","evidence":"该消息中的逐字短引文"}],"normalizedMeaning":"独立、无悬空指代且保留用户语气的含义","groundedQuery":"用具体 referent 替换指代后的简短 Recall 查询","confidence":0到1}',
      'ref 只能取自输入中的 currentMessageRef.ref、recentMessages.ref 或 recentMemoryRefs.ref。currentMessageRef 只有在当前消息自身明确补充了 referent 内容时才可引用，单独重复指代或请求动作不构成 referent 证据。每条 referent 都必须提供该来源里逐字可找到的 evidence。多个可能对象时列出候选并返回 AMBIGUOUS；没有候选时返回 UNRESOLVED。',
      '不要输出 memoryId、id、revision、authority、canonical 状态、事实真伪声明或写入成功声明。'
    ].join('\n');
    return [
      { role: 'system', content: system },
      { role: 'user', content: JSON.stringify({
        task: request.mode,
        currentMessage: request.modelMessage || request.userMessage,
        currentMessageRef: request.currentReference
          ? { ref: request.currentReference.ref, text: request.currentReference.text } : null,
        recentMessages: request.references.map(function (message) {
          return { ref: message.ref, role: message.role, speaker: message.speaker, text: message.text };
        }),
        recentMemoryRefs: (request.memoryReferences || []).map(function (memory) {
          return { ref: memory.ref, text: memory.text };
        })
      }) }
    ];
  }

  async function loadSelectedMemoryReferences(ids, deps) {
    deps = deps || {};
    if (!Array.isArray(ids) || typeof deps.getRecord !== 'function' || typeof deps.isVisible !== 'function') return [];
    var unique = [], seen = Object.create(null);
    ids.slice(0, MAX_MEMORY_REFERENCES).forEach(function (rawId) {
      var id = String(rawId || '').trim();
      if (id && !seen[id]) { seen[id] = true; unique.push(id); }
    });
    var reads = await Promise.all(unique.map(function (id) {
      return Promise.resolve().then(function () { return deps.getRecord(id); }).catch(function () { return null; });
    }));
    var out = [];
    for (var i = 0; i < reads.length; i++) {
      var read = reads[i];
      if (!read || read.authority !== 'home-node' || read.readFrom !== 'mirror') continue;
      var row = read.record && typeof read.record === 'object' ? read.record : read;
      if (!row || String(row.id || '') !== unique[i]) continue;
      var visible = false;
      try { visible = deps.isVisible(row) === true; } catch (_) { visible = false; }
      if (!visible) continue;
      out.push({ id: unique[i], title: String(row.title || '').slice(0, MAX_MEMORY_REFERENCE_CHARS),
        summary: String(row.summary || '').slice(0, MAX_MEMORY_REFERENCE_CHARS),
        content: String(row.content || '').slice(0, MAX_MEMORY_REFERENCE_CHARS) });
    }
    return out;
  }

  function parseObject(raw) {
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw;
    var text = String(raw || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    try { return JSON.parse(text); } catch (_) {}
    var start = text.indexOf('{'), end = text.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try { return JSON.parse(text.slice(start, end + 1)); } catch (_) {}
    }
    return null;
  }

  function parseResolution(raw, request) {
    request = request || {};
    if (!request.applicable) return null;
    var parsed = parseObject(raw);
    if (!parsed || typeof parsed !== 'object') return unresolved(request, 'resolver-parse-failed');
    var state = String(parsed.state || '').toUpperCase();
    var mention = String(parsed.mention || '').trim();
    if (!mention || request.userMessage.indexOf(mention) < 0 || !needsResolution(mention)) {
      return unresolved(request, 'reference-mention-unverified');
    }
    if (state !== 'RESOLVED' && state !== 'AMBIGUOUS' && state !== 'UNRESOLVED') {
      return unresolved(request, 'resolution-state-invalid');
    }
    if (state === 'UNRESOLVED') return unresolved(request, 'no-grounded-referent');

    var byRef = Object.create(null);
    if (request.currentReference) byRef[request.currentReference.ref] = request.currentReference;
    request.references.forEach(function (message) { byRef[message.ref] = message; });
    (request.memoryReferences || []).forEach(function (memory) { byRef[memory.ref] = memory; });
    var items = Array.isArray(parsed.referents) ? parsed.referents.slice(0, MAX_REFERENTS) : [];
    var evidence = [], seen = Object.create(null);
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      if (!item || typeof item !== 'object') continue;
      var source = byRef[String(item.ref || '')];
      var quote = String(item.evidence || '').trim();
      if (!source || quote.length < 3 || quote.length > 200 || source.text.indexOf(quote) < 0) continue;
      if (source.current && !currentEvidenceHasAnchor(quote, mention)) continue;
      var sourceType = source.memoryId ? 'memory' : 'message';
      var sourceId = source.memoryId || source.messageId;
      var evidenceKey = sourceType + ':' + sourceId;
      if (!sourceId || seen[evidenceKey]) continue;
      seen[evidenceKey] = true;
      evidence.push(sourceType === 'memory'
        ? { sourceType: 'memory', memoryId: source.memoryId, quote: quote }
        : { sourceType: 'message', messageId: source.messageId, quote: quote, role: source.role, speaker: source.speaker });
    }
    if (!evidence.length) return unresolved(request, 'referent-evidence-unverified');
    if (state === 'AMBIGUOUS') {
      return {
        state: 'AMBIGUOUS', mode: request.mode, mention: mention,
        referentType: TYPES.indexOf(String(parsed.referentType || '')) >= 0 ? String(parsed.referentType) : 'other',
        referentRefs: evidence.filter(function (item) { return item.sourceType === 'message'; }).map(function (item) { return item.messageId; }),
        referentMemoryIds: evidence.filter(function (item) { return item.sourceType === 'memory'; }).map(function (item) { return item.memoryId; }),
        referenceEvidence: evidence, normalizedMeaning: '', confidence: 0,
        reason: 'multiple-plausible-referents'
      };
    }
    if (evidence.length !== 1) {
      return {
        state: 'AMBIGUOUS', mode: request.mode, mention: mention,
        referentType: TYPES.indexOf(String(parsed.referentType || '')) >= 0 ? String(parsed.referentType) : 'other',
        referentRefs: evidence.filter(function (item) { return item.sourceType === 'message'; }).map(function (item) { return item.messageId; }),
        referentMemoryIds: evidence.filter(function (item) { return item.sourceType === 'memory'; }).map(function (item) { return item.memoryId; }),
        referenceEvidence: evidence, normalizedMeaning: '', groundedQuery: '', confidence: 0,
        reason: 'resolved-state-requires-one-antecedent'
      };
    }

    var confidence = Number(parsed.confidence);
    var normalizedMeaning = String(parsed.normalizedMeaning || '').trim();
    var groundedQuery = String(parsed.groundedQuery || normalizedMeaning).trim();
    if (!isFinite(confidence) || confidence < MIN_CONFIDENCE) return unresolved(request, 'reference-confidence-low');
    if (normalizedMeaning.length < 6 || normalizedMeaning.length > 480 || UNRESOLVED_MEANING.test(normalizedMeaning)
      || groundedQuery.length < 3 || groundedQuery.length > 480 || UNRESOLVED_MEANING.test(groundedQuery)) {
      return unresolved(request, 'normalized-meaning-not-grounded');
    }
    return {
      state: 'RESOLVED', mode: request.mode, mention: mention,
      referentType: TYPES.indexOf(String(parsed.referentType || '')) >= 0 ? String(parsed.referentType) : 'other',
      referentRefs: evidence.filter(function (item) { return item.sourceType === 'message'; }).map(function (item) { return item.messageId; }),
      referentMemoryIds: evidence.filter(function (item) { return item.sourceType === 'memory'; }).map(function (item) { return item.memoryId; }),
      referenceEvidence: evidence, normalizedMeaning: normalizedMeaning, groundedQuery: groundedQuery,
      confidence: confidence, reason: 'unique-grounded-referent'
    };
  }

  function validateResolved(result, input) {
    input = input || {};
    if (!result || result.state !== 'RESOLVED') return { ok: false, state: result && result.state || 'UNRESOLVED', reason: result && result.reason || 'reference-unresolved' };
    var request = prepare(input);
    if (!request.applicable) return { ok: false, state: 'UNRESOLVED', reason: 'reference-not-present' };
    var allowed = Object.create(null);
    if (request.currentReference) allowed[request.currentReference.messageId] = request.currentReference;
    request.references.forEach(function (message) { allowed[message.messageId] = message; });
    var allowedMemory = Object.create(null);
    (request.memoryReferences || []).forEach(function (memory) { allowedMemory[memory.memoryId] = memory; });
    var refs = Array.isArray(result.referentRefs) ? result.referentRefs.map(String) : [];
    var memoryRefs = Array.isArray(result.referentMemoryIds) ? result.referentMemoryIds.map(String) : [];
    var evidence = Array.isArray(result.referenceEvidence) ? result.referenceEvidence : [];
    var confidence = Number(result.confidence);
    if (refs.length + memoryRefs.length !== 1 || !isFinite(confidence) || confidence < MIN_CONFIDENCE) {
      return { ok: false, state: 'UNRESOLVED', reason: 'reference-confidence-or-provenance-invalid' };
    }
    var mention = String(result.mention || '');
    if (!mention || !needsResolution(mention) || request.userMessage.indexOf(mention) < 0) {
      return { ok: false, state: 'UNRESOLVED', reason: 'reference-mention-unverified' };
    }
    for (var i = 0; i < refs.length; i++) if (!allowed[refs[i]]) {
      return { ok: false, state: 'UNRESOLVED', reason: 'referent-ref-outside-conversation' };
    }
    for (var mi = 0; mi < memoryRefs.length; mi++) if (!allowedMemory[memoryRefs[mi]]) {
      return { ok: false, state: 'UNRESOLVED', reason: 'referent-memory-ref-unavailable' };
    }
    var evidenceRefs = Object.create(null);
    for (var j = 0; j < evidence.length; j++) {
      var item = evidence[j];
      var isMemory = item && item.sourceType === 'memory';
      var evidenceId = String(item && (isMemory ? item.memoryId : item.messageId) || '');
      var source = item && (isMemory ? allowedMemory[evidenceId] : allowed[evidenceId]);
      var quote = String(item && item.quote || '');
      var allowedIds = isMemory ? memoryRefs : refs;
      if (!source || allowedIds.indexOf(evidenceId) < 0 || quote.length < 3
        || source.text.indexOf(quote) < 0
        || (source.current && !currentEvidenceHasAnchor(quote, mention))) {
        return { ok: false, state: 'UNRESOLVED', reason: 'reference-evidence-unverified' };
      }
      evidenceRefs[(isMemory ? 'memory:' : 'message:') + evidenceId] = true;
    }
    if (refs.some(function (id) { return !evidenceRefs['message:' + id]; })
      || memoryRefs.some(function (id) { return !evidenceRefs['memory:' + id]; })) {
      return { ok: false, state: 'UNRESOLVED', reason: 'reference-evidence-missing' };
    }
    var meaning = String(result.normalizedMeaning || '').trim();
    var groundedQuery = String(result.groundedQuery || meaning).trim();
    if (meaning.length < 6 || meaning.length > 480 || UNRESOLVED_MEANING.test(meaning)
      || groundedQuery.length < 3 || groundedQuery.length > 480 || UNRESOLVED_MEANING.test(groundedQuery)) {
      return { ok: false, state: 'UNRESOLVED', reason: 'normalized-meaning-not-grounded' };
    }
    return { ok: true, resolution: result };
  }

  function validateForTurn(result, input) {
    input = input || {};
    if (!needsResolution(input.userMessage)) return { ok: true, state: 'NOT_APPLICABLE', resolution: null };
    if (!result || !['RESOLVED', 'AMBIGUOUS', 'UNRESOLVED'].includes(String(result.state || ''))) {
      return { ok: true, state: 'UNRESOLVED', resolution: unresolved(input, 'resolution-missing') };
    }
    if (result.state === 'RESOLVED') {
      var resolved = validateResolved(result, input);
      return resolved.ok ? { ok: true, state: 'RESOLVED', resolution: result } : {
        ok: true, state: 'UNRESOLVED', resolution: unresolved(input, resolved.reason)
      };
    }
    if (result.state === 'UNRESOLVED') return { ok: true, state: 'UNRESOLVED', resolution: unresolved(input, result.reason || 'reference-unresolved') };
    var request = prepare(input), allowed = Object.create(null);
    if (request.currentReference) allowed[request.currentReference.messageId] = request.currentReference;
    request.references.forEach(function (message) { allowed[message.messageId] = message; });
    var allowedMemory = Object.create(null);
    (request.memoryReferences || []).forEach(function (memory) { allowedMemory[memory.memoryId] = memory; });
    var mention = String(result.mention || '');
    if (!mention || !needsResolution(mention) || request.userMessage.indexOf(mention) < 0) {
      return { ok: true, state: 'UNRESOLVED', resolution: unresolved(input, 'ambiguous-reference-mention-invalid') };
    }
    var refs = Array.isArray(result.referentRefs) ? result.referentRefs.map(String) : [];
    var memoryRefs = Array.isArray(result.referentMemoryIds) ? result.referentMemoryIds.map(String) : [];
    var evidence = Array.isArray(result.referenceEvidence) ? result.referenceEvidence : [];
    if (!(refs.length + memoryRefs.length) || !evidence.length || refs.length + memoryRefs.length > MAX_REFERENTS
      || refs.some(function (id) { return !allowed[id]; }) || memoryRefs.some(function (id) { return !allowedMemory[id]; })) {
      return { ok: true, state: 'UNRESOLVED', resolution: unresolved(input, 'ambiguous-reference-provenance-invalid') };
    }
    for (var i = 0; i < evidence.length; i++) {
      var item = evidence[i];
      var isMemory = item && item.sourceType === 'memory';
      var evidenceId = String(item && (isMemory ? item.memoryId : item.messageId) || '');
      var source = item && (isMemory ? allowedMemory[evidenceId] : allowed[evidenceId]);
      var quote = String(item && item.quote || '');
      if (!source || quote.length < 3 || source.text.indexOf(quote) < 0
        || (source.current && !currentEvidenceHasAnchor(quote, mention))) {
        return { ok: true, state: 'UNRESOLVED', resolution: unresolved(input, 'ambiguous-reference-evidence-invalid') };
      }
    }
    var evidenceKeys = Object.create(null);
    evidence.forEach(function (item) {
      var isMemory = item && item.sourceType === 'memory';
      evidenceKeys[(isMemory ? 'memory:' : 'message:') + String(item && (isMemory ? item.memoryId : item.messageId) || '')] = true;
    });
    if (refs.some(function (id) { return !evidenceKeys['message:' + id]; })
      || memoryRefs.some(function (id) { return !evidenceKeys['memory:' + id]; })) {
      return { ok: true, state: 'UNRESOLVED', resolution: unresolved(input, 'ambiguous-reference-evidence-missing') };
    }
    return { ok: true, state: 'AMBIGUOUS', resolution: result };
  }

  async function resolve(input, deps) {
    input = input || {};
    deps = deps || {};
    var request = prepare(input);
    if (!request.applicable) return null;
    if (!request.references.length && !(request.memoryReferences || []).length && !request.currentReference) {
      return unresolved(request, 'no-grounding-context');
    }
    if (typeof deps.resolveModel !== 'function') return unresolved(request, 'resolver-unavailable');
    var timeoutMs = Number(deps.timeoutMs);
    if (!isFinite(timeoutMs) || timeoutMs <= 0) timeoutMs = DEFAULT_RESOLUTION_TIMEOUT_MS;
    timeoutMs = Math.min(timeoutMs, MAX_RESOLUTION_TIMEOUT_MS);
    var timer = null, timeoutMarker = {};
    try {
      var raw = await Promise.race([
        Promise.resolve().then(function () { return deps.resolveModel(buildMessages(request)); }),
        new Promise(function (resolveTimeout) { timer = setTimeout(function () { resolveTimeout(timeoutMarker); }, timeoutMs); })
      ]);
      if (raw === timeoutMarker) return unresolved(request, 'resolver-timeout');
      return parseResolution(raw, request);
    } catch (_) {
      return unresolved(request, 'resolver-failed');
    } finally {
      if (timer != null) clearTimeout(timer);
    }
  }

  return {
    needsResolution: needsResolution,
    firstMention: firstMention,
    prepare: prepare,
    buildMessages: buildMessages,
    loadSelectedMemoryReferences: loadSelectedMemoryReferences,
    parseResolution: parseResolution,
    validateResolved: validateResolved,
    validateForTurn: validateForTurn,
    unresolved: unresolved,
    resolve: resolve,
    MAX_CONTEXT_MESSAGES: MAX_CONTEXT_MESSAGES,
    MAX_CURRENT_MESSAGE_CHARS: MAX_CURRENT_MESSAGE_CHARS,
    MAX_CONTEXT_CHARS: MAX_CONTEXT_CHARS,
    MAX_MESSAGE_CHARS: MAX_MESSAGE_CHARS,
    MAX_MEMORY_REFERENCES: MAX_MEMORY_REFERENCES,
    MAX_MEMORY_REFERENCE_CHARS: MAX_MEMORY_REFERENCE_CHARS,
    MAX_REFERENTS: MAX_REFERENTS,
    MIN_CONFIDENCE: MIN_CONFIDENCE,
    DEFAULT_RESOLUTION_TIMEOUT_MS: DEFAULT_RESOLUTION_TIMEOUT_MS,
    MAX_RESOLUTION_TIMEOUT_MS: MAX_RESOLUTION_TIMEOUT_MS
  };
});
