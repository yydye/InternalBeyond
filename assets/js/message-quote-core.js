/* ====================================================================
   IB Message Quote Core — request-local, verified reply references (UMD)
   --------------------------------------------------------------------
   No I/O, DOM, runtime, state, or persistence. A quote is a pointer stored in
   the existing message metadata; the original canonical message remains the
   sole source of its content and author.
   ==================================================================== */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.IBMessageQuoteCore = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var OPEN = '<ib_reply_quote>';
  var CLOSE = '</ib_reply_quote>';
  var SELECTOR_OPEN = '[[quote:';
  var SELECTOR_CLOSE = ']]';
  /* A model may explicitly separate independent bubbles in one generation.
     This is a protocol boundary, never a punctuation/newline heuristic. */
  var MESSAGE_SEPARATOR = '[[ib:message]]';
  var MESSAGE_SEPARATOR_RE = /\[\[ib:message\]\]/gi;
  var MAX_REPLY_MESSAGES = 3;
  var MAX_SOURCES = 12;
  var MAX_EXCERPT_CHARS = 1200;
  var MAX_QUOTE_OPTIONS = 24;
  var MAX_SENTENCES_PER_SOURCE = 4;
  var MAX_QUOTE_SENTENCE_CHARS = 240;

  function str(value) { return String(value == null ? '' : value); }
  function messageText(message) {
    return message && typeof message.content === 'string' ? message.content : '';
  }
  function messageMeta(message) {
    return message && message.metadata && typeof message.metadata === 'object' && !Array.isArray(message.metadata)
      ? message.metadata : {};
  }
  function messageThreadId(message) {
    var meta = messageMeta(message);
    return str((message && message.threadId) || meta.threadId || '');
  }
  function senderKey(message) {
    if (!message || typeof message !== 'object') return '';
    var meta = messageMeta(message);
    if (message.role === 'user') return 'user:' + str(meta.userId || message.senderId || 'local');
    var id = meta.senderId || meta.speakerId || meta.config_id || message.senderId || '';
    if (id) return 'role:' + str(id);
    if (message.senderName) return 'name:' + str(message.senderName);
    return 'role:' + str(message.role || 'unknown');
  }
  function isWithdrawn(message) {
    var meta = messageMeta(message);
    return !!(message && (message.withdrawn === true || message.withdrawnAt || meta.withdrawn === true));
  }
  function sameScope(message, options) {
    var opts = options || {};
    if (opts.friendId != null && str(message.friendId) !== str(opts.friendId)) return false;
    if (opts.threadId != null && messageThreadId(message) !== str(opts.threadId || '')) return false;
    return true;
  }
  function displayName(message, options) {
    var opts = options || {};
    if (message && message.role === 'user') return str(opts.userName || message.senderName || '用户');
    return str((message && message.senderName) || messageMeta(message).senderName || '角色');
  }

  function sentenceExcerpts(content) {
    var text = str(content), out = [], start = 0;
    function add(end) {
      var raw = text.slice(start, end);
      var value = raw.trim();
      if (value.length >= 8 && value.length <= MAX_QUOTE_SENTENCE_CHARS) out.push(value);
      start = end;
    }
    for (var i = 0; i < text.length; i++) {
      var ch = text.charAt(i);
      if (/[。！？!?；;\n]/.test(ch)) {
        var end = i + 1;
        while (end < text.length && /[。！？!?；;]/.test(text.charAt(end))) end++;
        add(end);
        i = end - 1;
      }
    }
    if (start < text.length) add(text.length);
    return out;
  }

  function buildQuoteOptions(sources) {
    var options = [];
    var list = Array.isArray(sources) ? sources : [];
    for (var i = 0; i < list.length && options.length < MAX_QUOTE_OPTIONS; i++) {
      var source = list[i];
      if (!source || !source.key || !source.messageId || !source.content) continue;
      options.push({
        key: source.key,
        messageId: source.messageId,
        senderKey: source.senderKey,
        senderName: source.senderName,
        snippet: source.content,
        mode: 'whole'
      });
      var excerpts = sentenceExcerpts(source.content);
      for (var j = 0; j < excerpts.length && j < MAX_SENTENCES_PER_SOURCE && options.length < MAX_QUOTE_OPTIONS; j++) {
        options.push({
          key: source.key + '.' + (j + 1),
          messageId: source.messageId,
          senderKey: source.senderKey,
          senderName: source.senderName,
          snippet: excerpts[j],
          mode: 'excerpt'
        });
      }
    }
    return options;
  }

  function buildContext(messages, options) {
    var opts = options || {};
    var list = Array.isArray(messages) ? messages : [];
    var currentKey = str(opts.currentSenderKey || (opts.currentSenderId ? 'role:' + opts.currentSenderId : ''));
    var limit = Number(opts.limit) || MAX_SOURCES;
    limit = Math.max(1, Math.min(MAX_SOURCES, Math.floor(limit)));
    var byId = Object.create(null);
    var eligible = [];
    for (var i = 0; i < list.length; i++) {
      var message = list[i];
      if (!message || typeof message !== 'object' || !str(message.id) || !messageText(message)
        || message.role === 'system' || isWithdrawn(message) || !sameScope(message, opts)) continue;
      if (opts.allowedRoles && Array.isArray(opts.allowedRoles) && opts.allowedRoles.indexOf(message.role) < 0) continue;
      var author = senderKey(message);
      if (!author || (currentKey && author === currentKey)) continue;
      if (byId[str(message.id)]) continue;
      var source = {
        key: '',
        messageId: str(message.id),
        senderKey: author,
        senderName: displayName(message, opts),
        content: messageText(message),
        friendId: str(message.friendId),
        threadId: messageThreadId(message),
        role: str(message.role)
      };
      byId[source.messageId] = source;
      eligible.push(source);
    }
    if (eligible.length > limit) eligible = eligible.slice(eligible.length - limit);
    for (var j = 0; j < eligible.length; j++) eligible[j].key = 'Q' + (j + 1);
    var context = {
      mode: str(opts.mode || 'chat'),
      currentSenderKey: currentKey,
      friendId: opts.friendId == null ? '' : str(opts.friendId),
      threadId: opts.threadId == null ? '' : str(opts.threadId || ''),
      candidates: eligible
    };
    context.quoteOptions = buildQuoteOptions(eligible);
    context.prompt = buildPrompt(context.mode, eligible, context.quoteOptions);
    return context;
  }

  function buildPrompt(mode, candidates, quoteOptions) {
    if (!Array.isArray(candidates) || !candidates.length) return '';
    var policy;
    if (mode === 'role-dm') {
      policy = '【可选的引用回复】你可以像自然聊天一样，挑一条对方确实说过的话来回应；也可以完全不引用。长消息有多个话题时，可以只接其中一句，不必总结整段。不要逐句作答或每轮引用，表达仍按你的人设、关系和 IB.brevity。';
    } else if (mode === 'group') {
      policy = '【可选的引用回复】群聊里可以选择引用另一位成员或用户的一句原话，也可以不引用。只回应值得接的话，不逐句点名，也不要让所有成员形成相同习惯。';
    } else {
      policy = '【可选的引用回复】你可以选择引用用户最近说过的一句原话，也可以直接自然回复。引用不必每轮出现，不逐句作答，不改变你原有的聊天风格。';
    }
    policy += ' 只选下面目录里已有的引用项：Q1 代表整条消息，Q1.1 代表该消息的第一句，Q1.2 代表第二句。'
      + ' 若引用，只在最终回复末尾另起一行写一个短标记，例如 [[quote:Q1.2]]；不引用就不要写标记。'
      + ' 不要复制标记里的 key 到正文，不要改写目录中的原句。';
    var options = Array.isArray(quoteOptions) ? quoteOptions : buildQuoteOptions(candidates);
    var entries = options.map(function (option) {
      var entry = { key: option.key, messageId: option.messageId, sender: option.senderName };
      if (option.mode === 'whole') entry.kind = 'whole-message';
      else { entry.kind = 'exact-sentence'; entry.exact = option.snippet; }
      return JSON.stringify(entry);
    });
    return policy + '\n【允许的引用项】\n' + entries.join('\n');
  }

  function stripDirectives(raw) {
    var text = str(raw);
    var directives = [];
    var selectors = [];
    var re = /<ib_reply_quote\s*>([\s\S]*?)<\/ib_reply_quote\s*>/gi;
    var match;
    while ((match = re.exec(text))) directives.push(match[1]);
    var selectorRe = /\[\[quote:(Q\d+(?:\.\d+)?)\]\]/gi;
    while ((match = selectorRe.exec(text))) selectors.push(match[1]);
    var clean = text.replace(re, '').replace(selectorRe, '');
    /* A truncated end marker is control syntax, not assistant prose. The protocol
       is trailing-only, so discard the incomplete frame without losing prior text. */
    clean = clean.replace(/<ib_reply_quote\b[\s\S]*$/gi, '')
      .replace(/\[\[quote:[\s\S]*$/gi, '')
      .replace(/<\/?ib_reply_quote\b[^>]*>/gi, '').trim();
    return { text: clean, directives: directives, selectors: selectors };
  }

  function parseReply(raw, context) {
    var stripped = stripDirectives(raw);
    var directiveCount = stripped.directives.length + stripped.selectors.length;
    var result = { text: stripped.text, quote: null, directiveFound: directiveCount > 0, valid: false, reason: '' };
    if (directiveCount === 0) { result.reason = 'no-directive'; return result; }
    if (directiveCount !== 1) { result.reason = 'duplicate-directive'; return result; }
    if (stripped.selectors.length === 1) {
      var contextOptions = context && Array.isArray(context.quoteOptions) ? context.quoteOptions : [];
      var option = null;
      for (var oi = 0; oi < contextOptions.length; oi++) {
        if (contextOptions[oi] && str(contextOptions[oi].key) === str(stripped.selectors[0])) { option = contextOptions[oi]; break; }
      }
      if (!option) { result.reason = 'unknown-source'; return result; }
      var sourceMessage = null;
      var sourceList = context && Array.isArray(context.candidates) ? context.candidates : [];
      for (var si = 0; si < sourceList.length; si++) {
        if (sourceList[si] && str(sourceList[si].messageId) === str(option.messageId)) { sourceMessage = sourceList[si]; break; }
      }
      if (!sourceMessage || str(sourceMessage.senderKey) !== str(option.senderKey)) { result.reason = 'source-id-mismatch'; return result; }
      var selectedText = String(option.snippet || '');
      var selectedWhole = option.mode === 'whole';
      if (!selectedText || (selectedWhole ? selectedText !== sourceMessage.content : sourceMessage.content.indexOf(selectedText) < 0)) {
        result.reason = 'snippet-not-in-source'; return result;
      }
      if (context.friendId && sourceMessage.friendId && sourceMessage.friendId !== context.friendId) { result.reason = 'wrong-conversation'; return result; }
      if (context.threadId && sourceMessage.threadId !== context.threadId) { result.reason = 'wrong-thread'; return result; }
      result.quote = {
        version: 1,
        sourceMessageId: sourceMessage.messageId,
        sourceSenderKey: sourceMessage.senderKey,
        snippet: selectedText,
        mode: selectedWhole ? 'whole' : 'excerpt'
      };
      result.valid = true;
      return result;
    }
    if (stripped.directives.length !== 1) { result.reason = 'bad-payload'; return result; }
    var payload;
    try { payload = JSON.parse(stripped.directives[0]); } catch (_) { result.reason = 'bad-json'; return result; }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) { result.reason = 'bad-payload'; return result; }
    var contextCandidates = context && Array.isArray(context.candidates) ? context.candidates : [];
    var source = null;
    for (var i = 0; i < contextCandidates.length; i++) {
      if (contextCandidates[i] && str(contextCandidates[i].key) === str(payload.key)) { source = contextCandidates[i]; break; }
    }
    if (!source) { result.reason = 'unknown-source'; return result; }
    var whole = payload.whole === true;
    var snippet = whole ? source.content : (typeof payload.text === 'string' ? payload.text : '');
    if (!snippet || snippet.length > (whole ? source.content.length : MAX_EXCERPT_CHARS)) {
      result.reason = 'bad-snippet'; return result;
    }
    if (whole ? snippet !== source.content : source.content.indexOf(snippet) < 0) {
      result.reason = 'snippet-not-in-source'; return result;
    }
    if (context.friendId && source.friendId && source.friendId !== context.friendId) { result.reason = 'wrong-conversation'; return result; }
    if (context.threadId && source.threadId !== context.threadId) { result.reason = 'wrong-thread'; return result; }
    result.quote = {
      version: 1,
      sourceMessageId: source.messageId,
      sourceSenderKey: source.senderKey,
      snippet: snippet,
      mode: whole ? 'whole' : 'excerpt'
    };
    result.valid = true;
    result.reason = '';
    return result;
  }

  /* Parse one model generation into one to three independent message bodies.
     Without the explicit separator this is exactly the legacy single-message
     path. Every segment uses the same strict request-local quote allowlist.
     Malformed or over-limit sequences degrade to one plain message; ambiguous
     quote directives are stripped instead of being attached to the wrong unit. */
  function parseReplyMessages(raw, context) {
    var source = str(raw);
    var separators = source.match(MESSAGE_SEPARATOR_RE) || [];
    function quoteOutcome(parsed) {
      return {
        text: parsed.text,
        quote: parsed.valid === true ? parsed.quote : null,
        quoteResult: parsed.valid === true ? 'accepted' : (parsed.directiveFound ? 'rejected' : 'no-directive'),
        quoteReason: parsed.valid === true ? '' : (parsed.reason || (parsed.directiveFound ? 'unknown' : 'missing-directive'))
      };
    }
    function fallback(reason) {
      var flattened = source.replace(MESSAGE_SEPARATOR_RE, '\n\n');
      var stripped = stripDirectives(flattened);
      var hadQuote = stripped.directives.length + stripped.selectors.length > 0;
      return {
        messages: [{
          text: stripped.text,
          quote: null,
          quoteResult: hadQuote ? 'rejected' : 'no-directive',
          quoteReason: hadQuote ? 'sequence-fallback' : 'missing-directive'
        }],
        multi: false,
        formatFallback: true,
        formatReason: reason
      };
    }

    if (!separators.length) {
      return {
        messages: [quoteOutcome(parseReply(source, context))],
        multi: false,
        formatFallback: false,
        formatReason: ''
      };
    }
    if (separators.length >= MAX_REPLY_MESSAGES) return fallback('too-many-messages');

    var segments = source.split(MESSAGE_SEPARATOR_RE);
    if (segments.length < 2 || segments.length > MAX_REPLY_MESSAGES) return fallback('too-many-messages');
    var parsedMessages = [];
    for (var i = 0; i < segments.length; i++) {
      if (!String(segments[i] || '').trim()) return fallback('empty-message');
      var parsed = quoteOutcome(parseReply(segments[i], context));
      if (!String(parsed.text || '').trim()) return fallback('empty-message');
      parsedMessages.push(parsed);
    }
    return {
      messages: parsedMessages,
      multi: parsedMessages.length > 1,
      formatFallback: false,
      formatReason: ''
    };
  }

  function validateReference(reference, source, reply, options) {
    var ref = reference && typeof reference === 'object' ? reference : null;
    var opts = options || {};
    if (!ref || ref.version !== 1 || !source || !reply) return { ok: false, reason: 'missing-reference' };
    if (!str(source.id) || str(source.id) !== str(ref.sourceMessageId)) return { ok: false, reason: 'source-id-mismatch' };
    if (isWithdrawn(source)) return { ok: false, reason: 'source-unavailable' };
    var snippet = typeof ref.snippet === 'string' ? ref.snippet : '';
    var content = messageText(source);
    if (!snippet || (ref.mode === 'whole' ? snippet !== content : content.indexOf(snippet) < 0)) {
      return { ok: false, reason: 'snippet-mismatch' };
    }
    var actualSender = senderKey(source);
    if (!actualSender || actualSender !== str(ref.sourceSenderKey)) return { ok: false, reason: 'sender-mismatch' };
    var expectedFriend = opts.friendId != null ? str(opts.friendId) : str(reply.friendId || '');
    if (expectedFriend && (str(source.friendId || expectedFriend) !== expectedFriend
      || str(reply.friendId || expectedFriend) !== expectedFriend)) return { ok: false, reason: 'conversation-mismatch' };
    var expectedThread = opts.threadId != null ? str(opts.threadId || '') : messageThreadId(reply);
    if (messageThreadId(source) !== expectedThread || messageThreadId(reply) !== expectedThread) {
      return { ok: false, reason: 'thread-mismatch' };
    }
    var author = str(opts.replySenderKey || senderKey(reply));
    if (author && author === actualSender) return { ok: false, reason: 'self-reference' };
    return { ok: true, source: source, snippet: snippet, senderName: displayName(source, opts) };
  }

  function resolveReference(reference, messages, reply, options) {
    var id = str(reference && reference.sourceMessageId);
    var list = Array.isArray(messages) ? messages : [];
    for (var i = 0; i < list.length; i++) {
      if (list[i] && str(list[i].id) === id) return validateReference(reference, list[i], reply, options);
    }
    return { ok: false, reason: 'source-missing' };
  }

  /* Hide the optional end-of-response control frame during streaming. Ordinary
     content streams immediately; only bytes after an opening frame are held. */
  function createStreamFilter() {
    var pending = '';
    var insideClose = '';
    var openings = [OPEN, SELECTOR_OPEN];
    function partialOpeningLength(value) {
      var best = 0;
      for (var oi = 0; oi < openings.length; oi++) {
        var token = openings[oi];
        var max = Math.min(value.length, token.length - 1);
        for (var n = max; n > best; n--) {
          if (value.slice(-n).toLowerCase() === token.slice(0, n).toLowerCase()) { best = n; break; }
        }
      }
      return best;
    }
    function consume(input, final) {
      pending += str(input);
      var output = '';
      while (pending) {
        if (insideClose) {
          var closeAt = pending.toLowerCase().indexOf(insideClose);
          if (closeAt >= 0) {
            pending = pending.slice(closeAt + insideClose.length);
            insideClose = '';
            continue;
          }
          if (pending.length > 8192) {
            pending = '';
            insideClose = '';
          }
          break;
        }
        var lowerPending = pending.toLowerCase();
        var tagAt = lowerPending.indexOf(OPEN);
        var selectorAt = lowerPending.indexOf(SELECTOR_OPEN);
        var openAt = tagAt < 0 ? selectorAt : (selectorAt < 0 ? tagAt : Math.min(tagAt, selectorAt));
        if (openAt >= 0) {
          output += pending.slice(0, openAt);
          if (openAt === tagAt) { pending = pending.slice(openAt + OPEN.length); insideClose = CLOSE; }
          else { pending = pending.slice(openAt + SELECTOR_OPEN.length); insideClose = SELECTOR_CLOSE; }
          continue;
        }
        if (final) {
          var partial = partialOpeningLength(pending);
          output += pending.slice(0, pending.length - partial);
          pending = '';
          break;
        }
        var hold = partialOpeningLength(pending);
        output += pending.slice(0, pending.length - hold);
        pending = pending.slice(pending.length - hold);
        break;
      }
      if (final && insideClose) { pending = ''; insideClose = ''; }
      return output;
    }
    return { push: function (chunk) { return consume(chunk, false); }, finish: function () { return consume('', true); } };
  }

  return {
    OPEN: OPEN,
    CLOSE: CLOSE,
    SELECTOR_OPEN: SELECTOR_OPEN,
    SELECTOR_CLOSE: SELECTOR_CLOSE,
    MESSAGE_SEPARATOR: MESSAGE_SEPARATOR,
    MAX_REPLY_MESSAGES: MAX_REPLY_MESSAGES,
    MAX_SOURCES: MAX_SOURCES,
    MAX_EXCERPT_CHARS: MAX_EXCERPT_CHARS,
    senderKey: senderKey,
    buildContext: buildContext,
    buildPrompt: buildPrompt,
    stripDirectives: stripDirectives,
    parseReply: parseReply,
    parseReplyMessages: parseReplyMessages,
    validateReference: validateReference,
    resolveReference: resolveReference,
    createStreamFilter: createStreamFilter
  };
});
