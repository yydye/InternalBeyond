(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.IBQQOneBotCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var HISTORY_KEY_PREFIX = 'ib_qq_onebot_history_v1:';
  var HISTORY_LIMIT = 20;
  var MESSAGE_LIMIT = 6000;
  var REPLY_LIMIT = 1800;
  var MAX_INPUT_IMAGES = 3;
  var MAX_OUTPUT_IMAGES = 1;
  var MAX_IMAGE_BYTES = 4 * 1024 * 1024;
  var IMAGE_MIMES = ['image/jpeg', 'image/png', 'image/webp'];

  function cleanText(value, limit) {
    return String(value == null ? '' : value)
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
      .slice(0, limit || MESSAGE_LIMIT);
  }

  function normalizeImages(value, limit, allowName) {
    if (value == null) return [];
    if (!Array.isArray(value) || value.length > limit) return null;
    var result = [];
    for (var index = 0; index < value.length; index++) {
      var image = value[index];
      if (!image || typeof image !== 'object' || Array.isArray(image)) return null;
      var allowedKeys = allowName ? ['mime', 'base64', 'name'] : ['mime', 'base64'];
      if (Object.keys(image).some(function (key) { return allowedKeys.indexOf(key) < 0; })) return null;
      var mime = String(image.mime || '').trim().toLowerCase();
      var base64 = String(image.base64 || '');
      if (IMAGE_MIMES.indexOf(mime) < 0 || !base64
        || base64.length > Math.ceil(MAX_IMAGE_BYTES * 4 / 3) + 4
        || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64)) return null;
      var normalized = { mime: mime, base64: base64 };
      if (allowName) normalized.name = String(image.name || ('image-' + (index + 1)));
      result.push(normalized);
    }
    return result;
  }

  function conversationStorageKey(event) {
    var accountId = String(event && event.accountId || '').trim();
    var messageType = String(event && event.messageType || '').trim();
    var peerId = String(event && event.peerId || '').trim();
    if (!accountId || !peerId || (messageType !== 'private' && messageType !== 'group')) return '';
    var sessionId = String(event && event.sessionId || '').trim();
    var sessionSuffix = sessionId && sessionId !== 'default' ? ':session:' + sessionId : '';
    return HISTORY_KEY_PREFIX + encodeURIComponent(accountId + ':' + messageType + ':' + peerId + sessionSuffix);
  }

  function createHistoryStore(storage) {
    storage = storage || (typeof localStorage !== 'undefined' ? localStorage : null);
    return {
      load: function (key) {
        if (!storage || !key) return [];
        try {
          var raw = storage.getItem(key);
          var rows = raw ? JSON.parse(raw) : [];
          if (!Array.isArray(rows)) return [];
          return rows.slice(-HISTORY_LIMIT).filter(function (row) {
            return row && (row.role === 'user' || row.role === 'assistant') && typeof row.content === 'string';
          }).map(function (row) {
            return { role: row.role, content: cleanText(row.content), timestamp: Number(row.timestamp) || 0 };
          });
        } catch (_) { return []; }
      },
      save: function (key, rows) {
        if (!storage || !key) return false;
        var value = (Array.isArray(rows) ? rows : []).slice(-HISTORY_LIMIT).map(function (row) {
          return { role: row.role, content: cleanText(row.content), timestamp: Number(row.timestamp) || 0 };
        });
        try { storage.setItem(key, JSON.stringify(value)); return true; }
        catch (_) { return false; }
      },
      clear: function (key) {
        if (!storage || !key || typeof storage.removeItem !== 'function') return false;
        try { storage.removeItem(key); return true; } catch (_) { return false; }
      },
      clearAccount: function (accountId) {
        if (!storage || typeof storage.length !== 'number' || typeof storage.key !== 'function' || typeof storage.removeItem !== 'function') return 0;
        var prefix = HISTORY_KEY_PREFIX + encodeURIComponent(String(accountId || '').trim() + ':');
        var removed = 0;
        for (var index = storage.length - 1; index >= 0; index--) {
          try {
            var key = storage.key(index);
            if (key && key.indexOf(prefix) === 0) { storage.removeItem(key); removed++; }
          } catch (_) { /* one unavailable key must not block other account history */ }
        }
        return removed;
      }
    };
  }

  function makeProviderMessages(context, history, currentText, images) {
    var system = String(context && context.system || '').trim();
    var tail = String(context && context.tail || '').trim();
    var systemText = [system, tail].filter(Boolean).join('\n\n');
    var messages = [];
    if (systemText) messages.push({ role: 'system', content: systemText });
    (Array.isArray(history) ? history : []).forEach(function (row) {
      if (row && (row.role === 'user' || row.role === 'assistant') && typeof row.content === 'string') {
        messages.push({ role: row.role, content: cleanText(row.content) });
      }
    });
    var current = messageWithSpeaker(context && context.event, currentText);
    if (Array.isArray(images) && images.length) {
      var parts = [{ type: 'text', text: current || '请查看用户发送的图片。' }];
      images.forEach(function (image) { parts.push({ type: '_image', base64: image.base64, mime: image.mime }); });
      messages.push({ role: 'user', content: parts });
    } else {
      messages.push({ role: 'user', content: current });
    }
    return messages;
  }

  function messageWithSpeaker(event, text) {
    var current = cleanText(text);
    if (!event || event.messageType !== 'group') return current;
    var reference = String(event.senderRef || '').trim();
    if (!/^member-[a-f0-9]{12}$/.test(reference)) return current;
    var name = cleanText(event.senderName, 120).replace(/\s+/g, ' ').trim() || '群成员';
    return '【群成员 ' + name + ' · ' + reference + '】\n' + current;
  }

  function memoryRecallRequest(event, history) {
    event = event && typeof event === 'object' ? event : {};
    var accountId = String(event.accountId || '').trim();
    var roleId = String(event.roleId || '').trim();
    var messageId = String(event.messageId || event.requestId || 'turn').trim();
    return {
      operation: 'memory-recall',
      mode: 'authoritative',
      characterId: roleId,
      requestId: ('qq-' + accountId + '-' + messageId).slice(0, 180),
      conversationId: String(event.conversationId || ''),
      message: messageWithSpeaker(event, event.text) + (Array.isArray(event.images) && event.images.length ? '\n[图片附件]' : ''),
      isFirstTurn: !Array.isArray(history) || history.length === 0,
      conversationSignalAvailable: true,
      /* Memory's existing group visibility rule is the public-only rule. QQ peers
         are external audiences even for a private-message transport. */
      isGroup: true
    };
  }

  function createConversationAdapter(deps) {
    deps = deps || {};
    var historyStore = deps.historyStore || createHistoryStore(deps.storage);
    var getRoleConfig = typeof deps.getRoleConfig === 'function' ? deps.getRoleConfig : function () { return null; };
    var buildContext = typeof deps.buildContext === 'function' ? deps.buildContext : function () { return Promise.resolve({}); };
    var generate = typeof deps.generate === 'function' ? deps.generate : function () { return Promise.reject(new Error('provider-unavailable')); };
    var now = typeof deps.now === 'function' ? deps.now : Date.now;

    async function reply(event) {
      event = event && typeof event === 'object' ? event : {};
      var roleId = String(event.roleId || '').trim();
      var input = cleanText(event.text, MESSAGE_LIMIT).trim();
      var inputImages = normalizeImages(event.images, MAX_INPUT_IMAGES, true);
      var key = conversationStorageKey(event);
      var groupIdentityInvalid = event.messageType === 'group'
        && (!String(event.groupOpenId || '').trim()
          || String(event.groupOpenId || '') !== String(event.peerId || '')
          || !String(event.senderId || '').trim()
          || !/^member-[a-f0-9]{12}$/.test(String(event.senderRef || '')));
      if (!roleId || inputImages === null || (!input && !inputImages.length)
        || !key || !String(event.conversationId || '').trim() || groupIdentityInvalid) {
        return { ok: false, error: inputImages === null ? 'image-input-invalid' : 'invalid-event' };
      }
      var config;
      try { config = await getRoleConfig(roleId); } catch (_) { config = null; }
      if (!config || String(config.id || '') !== roleId) return { ok: false, error: 'role-unavailable' };
      var history = historyStore.load(key);
      var context;
      try { context = await buildContext(config, event, history); }
      catch (_) { return { ok: false, error: 'context-failed' }; }
      var messages = makeProviderMessages({ system: context && context.system, tail: context && context.tail, event: event }, history, input, inputImages);
      var providerOptions = {
        disableTools: true,
        autoContinue: false,
        wantThinking: false,
        maxTokens: 1024,
        timeoutMs: 25000,
        _noWebSearch: true,
        _ibConsumer: event.platform === 'qq-official' ? 'qq-official' : 'qq-onebot',
        _ibCharacterId: roleId,
        _ibThreadId: String(event.conversationId || '')
      };
      var generated;
      try { generated = await generate(config, messages, providerOptions, event); }
      catch (error) {
        var code = String(error && (error.code || error.message) || '');
        if (code === 'CREDENTIAL_UNAVAILABLE') return { ok: false, error: 'credential-vault-unavailable' };
        if (code === 'qq-role-config-unavailable') return { ok: false, error: 'role-config-unavailable' };
        if (code === 'qq-provider-unavailable') return { ok: false, error: 'provider-unavailable' };
        if (code === 'QQ_VISION_UNAVAILABLE') return { ok: false, error: 'vision-unavailable' };
        if (code === 'QQ_IMAGE_OUTPUT_INVALID') return { ok: false, error: 'image-output-invalid' };
        if (code === 'QQ_IMAGE_OUTPUT_DISABLED') return { ok: false, error: 'image-output-disabled' };
        return { ok: false, error: 'provider-failed' };
      } finally {
        inputImages.forEach(function (image) { image.base64 = ''; });
        messages.forEach(function (message) {
          if (!Array.isArray(message && message.content)) return;
          message.content.forEach(function (part) { if (part && part.type === '_image') part.base64 = ''; });
        });
      }
      var replyText = cleanText(generated && typeof generated === 'object'
        ? (generated.reply == null ? generated.text : generated.reply) : generated, REPLY_LIMIT).trim();
      var outputImages = generated && typeof generated === 'object'
        ? normalizeImages(generated.images, MAX_OUTPUT_IMAGES, false) : [];
      if (generated && typeof generated === 'object' && Array.isArray(generated.images)) {
        generated.images.forEach(function (image) { if (image && typeof image === 'object') image.base64 = ''; });
      }
      if (outputImages === null) return { ok: false, error: 'image-output-invalid' };
      if (!replyText && !outputImages.length) return { ok: false, error: 'empty-output' };
      var historyInput = messageWithSpeaker(event, input)
        + (inputImages.length ? (input ? '\n' : '') + '[图片附件 ' + inputImages.length + ' 张]' : '');
      var next = history.concat([
        { role: 'user', content: historyInput, timestamp: Number(event.receivedAt) || Number(now()) || Date.now() },
        { role: 'assistant', content: replyText || '[图片回复]', timestamp: Number(now()) || Date.now() }
      ]).slice(-HISTORY_LIMIT);
      return { ok: true, reply: replyText, images: outputImages, sessionKey: key, historyCount: next.length, _history: next };
    }

    function commit(result) {
      return !!(result && result.ok === true && historyStore.save(result.sessionKey, result._history));
    }

    function reset(event) {
      return historyStore.clear(conversationStorageKey(event));
    }

    return Object.freeze({ reply: reply, commit: commit, reset: reset, historyStore: historyStore });
  }

  return Object.freeze({
    HISTORY_KEY_PREFIX: HISTORY_KEY_PREFIX,
    HISTORY_LIMIT: HISTORY_LIMIT,
    conversationStorageKey: conversationStorageKey,
    createHistoryStore: createHistoryStore,
    makeProviderMessages: makeProviderMessages,
    normalizeImages: normalizeImages,
    memoryRecallRequest: memoryRecallRequest,
    createConversationAdapter: createConversationAdapter
  });
});
