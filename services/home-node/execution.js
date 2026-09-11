/* ====================================================================
   IB Home Node · Canonical Character Turn Execution
   --------------------------------------------------------------------
   这是 Home Node 唯一的「角色回合」执行入口：
       executeCharacterTurn(request, options)
   它把「一次角色生成」定义为**一个事务性的、可流式观察的、幂等的回合**，
   并把用户消息与助手消息都写进 canonical chat store。

   与浏览器路径的关系（Phase 10 Strategy A，见 docs/HOME_NODE_CHAT.md）：
     · 浏览器 communication.js 的 sendChatMessage 仍然是**桌面单聊的**
       编排者（Middle Brain 上下文组织、工具回合、记忆指令、waifu 分段等）。
       本阶段**不**重写它、也不静默降低它的行为。
     · 本模块是 Node 侧唯一的生成缝：它自己组 prompt、自己流式调用 provider、
       自己写 canonical store。它**不**假装已经拥有 Middle Brain ——
       request.contextPolicy 明确表达「本轮用的是哪种上下文策略」，
       调用方（未来的 Mobile Gateway / proactive ingest）必须如实透出。
     · 两者共用同一份 wire 层：IBModelCore.buildRequestBody / parseResponse /
       createStreamParser，以及 NodeModelPort.runStream。禁止在本文件里出现
       provider 字段名判断。

   幂等模型（§7.5 invariant #2 / §9.5）：
     requestId 是**必填**的 transport 级幂等键。
       · 第一次：写 user 消息（store 记住 requestId → userMessageId）→ 生成 → 写 assistant
       · 重试：store.idempotency 命中 → 直接返回原来的 userMessageId，
         **不写第二次 user 消息，也不再调用模型**。
     这条保证由 store 的 idempotency 表提供，不靠内存状态，因此进程重启后仍然成立。

   并发模型：
     每个 conversationId 同时只允许一个 in-flight turn；第二个请求得到
     明确的 busy 错误（不排队 —— 排队的语义是"用户看不见的另一轮"）。
   ==================================================================== */
'use strict';

const CHAT_CORE = require('../../assets/js/chat-core.js');

const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_TIMEOUT_MS = 120000;
const TURN_ID_PREFIX = 'turn_';

function createTurnExecutor(deps) {
  deps = deps || {};
  const store = deps.store;
  const port = deps.port;                       /* NodeModelPort 实例（或同形 mock） */
  const clock = deps.clock || (() => Date.now());
  const logger = deps.logger || (() => {});
  const makeTurnId = deps.makeTurnId || (() => TURN_ID_PREFIX + CHAT_CORE.stableToken(String(clock()) + ':' + Math.random()));
  const inFlight = new Map();                   /* conversationId → turnId */

  function fail(code, extra) {
    return Object.assign({ ok: false, error: code }, extra || {});
  }

  /* ── prompt 组装 ────────────────────────────────────────────────────
     与浏览器路径的**同构**部分：system + 历史（user/assistant 交替）+ 本轮用户内容。
     附件在 canonical 记录里是结构化字段，但送进模型时必须变成文本/图像 part ——
     这个转换只在这里做一次，规则逐条对应生产写入形状（docs/CHAT_MESSAGE_CONTRACT.md §2）：
       · images[] → {type:'_image', mime, base64}（IBModelCore.adaptMessageParts 认识）
       · files[]  → '[文件上传: name]\n' + 文本（与 communication.js:2065 同一约定）
       · voice{}  → 文本转录 + 声学语气行（与 communication.js:2064 同一约定）
     不做工具、不做记忆指令、不做 Middle Brain —— 那些属于调用方或后续阶段。 */
  function messageContent(message) {
    const parts = [];
    let text = String((message && message.content) || '');
    if (message && message.voice) {
      const line = voiceApiLine(message.voice);
      if (line) text += (text ? '\n' : '') + line;
    }
    if (message && Array.isArray(message.files)) {
      for (const f of message.files) {
        if (!f) continue;
        text += '\n\n[文件上传: ' + String(f.name || '') + ']\n' + String(f.text || '');
      }
    }
    if (Array.isArray(message && message.images) && message.images.length) {
      parts.push({ type: 'text', text: text });
      for (const img of message.images) {
        if (!img) continue;
        const base64 = String(img.base64 || '').trim() || String(String(img.dataUrl || '').split(',')[1] || '');
        if (!base64) continue;
        parts.push({ type: '_image', mime: String(img.mime || 'image/jpeg'), base64: base64 });
      }
      return parts;
    }
    return text;
  }

  /* 声学语气行：与浏览器 _voiceApiLine 的对外语义一致（转录 + 一段可读的语气描述）。
     浏览器版本读的是 acoustic tone 对象；这里在 tone 缺失时只给转录，绝不编造。 */
  function voiceApiLine(voice) {
    const transcript = String((voice && voice.transcript) || '').trim();
    const tone = voice && voice.tone;
    if (!transcript && !tone) return '';
    let out = transcript ? '[语音消息] ' + transcript : '[语音消息]';
    if (tone) {
      const bits = [];
      if (tone.label) bits.push(String(tone.label));
      if (tone.pitch) bits.push('音高 ' + String(tone.pitch));
      if (tone.speed) bits.push('语速 ' + String(tone.speed));
      if (bits.length) out += '（' + bits.join(' · ') + '）';
    }
    return out;
  }

  function buildPrompt(request) {
    const character = request.character || {};
    const history = Array.isArray(request.history) ? request.history : [];
    const messages = [];
    for (const item of history) {
      if (!item) continue;
      const role = item.role === 'assistant' ? 'assistant' : (item.role === 'user' ? 'user' : null);
      if (!role) continue;                       /* system 行不进 messages（system 走顶层） */
      const content = String(item.content == null ? '' : item.content);
      if (!content && !(item.images && item.images.length)) continue;
      messages.push({ role: role, content: item.images && item.images.length ? messageContent(item) : content });
    }
    if (request.userMessage) messages.push({ role: 'user', content: messageContent(request.userMessage) });
    /* 运行时上下文（如果调用方给了）注入到 system 尾部，绝不复述给用户。 */
    let system = String(character.systemPrompt || '');
    const ctx = String(request.runtimeContext || '');
    if (ctx) system += (system ? '\n\n' : '') + ctx;
    return { system: system, messages: messages };
  }

  /* ── 单轮执行 ──────────────────────────────────────────────────────── */
  async function executeCharacterTurn(request, options) {
    options = options || {};
    request = request || {};
    if (!store) return fail('store-unavailable');

    const requestId = String(request.requestId || '').trim();
    if (!requestId) return fail('missing-request-id');

    const userMessage = request.userMessage || null;
    if (!userMessage || typeof userMessage !== 'object') return fail('missing-user-message');
    /* 结构校验先行：一条 structurally 非法的消息必须被判为 invalid-message，
       而不是被下游某个具体字段的缺失掩盖（错误词表要能让调用方直接分支）。 */
    const shape = CHAT_CORE.validateMessage(userMessage);
    if (!shape.ok) return fail('invalid-message', { errors: shape.errors });

    const friendId = String(userMessage.friendId || request.friendId || '');
    if (!friendId) return fail('missing-friend-id');
    const threadId = userMessage.threadId != null ? String(userMessage.threadId) : '';
    const conversationId = CHAT_CORE.conversationIdOf(friendId, threadId);

    const character = request.character || {};
    const spec = character.spec || character;
    if (!spec || !spec.endpoint || !spec.model) return fail('character-not-ready');

    /* 并发：一个会话同时只有一个回合。 */
    const existingTurn = inFlight.get(conversationId);
    if (existingTurn) return fail('busy', { conversationId: conversationId, turnId: existingTurn });

    /* ── 幂等：重试同一个 requestId → 返回原 userMessageId，不再生成 ── */
    const seen = store.putMessage(userMessage, { requestId: requestId });
    if (!seen.ok) return fail(seen.error || 'user-message-rejected', { errors: seen.errors, index: seen.index });
    if (seen.outcome === 'duplicate-request') {
      let assistant = null;
      const replyId = request.assistantMessageId;
      if (replyId) assistant = store.getMessage(replyId);
      logger('turn-duplicate-request', { requestId: requestId, conversationId: conversationId, userMessageId: seen.id });
      return {
        ok: true,
        outcome: 'duplicate-request',
        requestId: requestId,
        conversationId: conversationId,
        userMessageId: seen.id,
        revision: seen.revision,
        assistantMessage: assistant,
        replied: !!assistant
      };
    }

    const userMessageId = seen.id;
    const turnId = options.turnId || makeTurnId();
    inFlight.set(conversationId, turnId);
    const onEvent = typeof options.onEvent === 'function' ? options.onEvent : function () {};

    const emit = (event) => {
      try { onEvent(Object.assign({ turnId: turnId, conversationId: conversationId, requestId: requestId }, event)); }
      catch (_) { /* consumer 回调异常不得影响回合 */ }
    };

    emit({ type: 'start', userMessageId: userMessageId, conversationId: conversationId });
    logger('turn-start', {
      requestId: requestId, turnId: turnId, conversationId: conversationId,
      contextPolicy: String(request.contextPolicy || 'unspecified'),
      historyCount: Array.isArray(request.history) ? request.history.length : 0,
      hasImages: !!(userMessage.images && userMessage.images.length),
      hasFiles: !!(userMessage.files && userMessage.files.length),
      hasVoice: !!userMessage.voice
    });

    const startedAt = clock();
    /* 累积流式正文：取消/超时时用它落一条 partial 记录（与浏览器 communication.js:3796-3799
       的「非空部分文本才落库」同一语义）。累积由本文件负责，不由调用方提供。 */
    const partial = { text: '' };
    try {
      const result = await port.runStream({
        spec: spec,
        prompt: buildPrompt(request),
        maxTokens: request.maxTokens != null ? request.maxTokens : DEFAULT_MAX_TOKENS,
        temperature: request.temperature != null ? request.temperature : (spec.temperature != null ? spec.temperature : null),
        reasoningEffort: request.reasoningEffort || 'auto',
        consumer: 'home-node-chat'
      }, {
        signal: options.signal,
        timeoutMs: options.timeoutMs != null ? options.timeoutMs : DEFAULT_TIMEOUT_MS,
        onEvent: (event) => {
          if (event && event.type === 'delta') {
            if (event.kind === 'content') partial.text += String(event.text || '');
            emit({ type: 'delta', kind: event.kind, text: event.text, index: event.index });
          }
        }
      });

      const text = String(result.text || '');
      const reasoning = String(result.reasoning || '');
      if (!text.trim() && !reasoning.trim()) {
        emit({ type: 'error', kind: 'empty-output', message: 'model returned no content', retryable: true });
        logger('turn-empty-output', { turnId: turnId, conversationId: conversationId });
        return fail('empty-output', { turnId: turnId, userMessageId: userMessageId, conversationId: conversationId });
      }

      const assistantMessage = buildAssistantMessage({
        request: request, userMessage: userMessage, friendId: friendId, threadId: threadId,
        text: text, reasoning: reasoning, result: result, conversationId: conversationId
      });
      const written = store.putMessage(assistantMessage, { idempotent: false });
      if (!written.ok) {
        /* 生成成功但 canonical 写入失败 —— 必须显式失败，绝不假装成功。
           重试同一 requestId 会命中 user 消息的幂等记录，不会产生第二条用户消息。 */
        emit({ type: 'error', kind: 'store-write-failed', message: String(written.error || 'write failed'), retryable: true });
        logger('turn-store-write-failed', { turnId: turnId, conversationId: conversationId, error: String(written.error || '') });
        return fail('store-write-failed', { turnId: turnId, userMessageId: userMessageId, conversationId: conversationId, errors: written.errors });
      }

      emit({
        type: 'done', messageId: written.id, revision: written.revision,
        text: text, reasoning: reasoning,
        truncated: !!result.truncated, usage: result.usage || null,
        contextPolicy: String(request.contextPolicy || 'unspecified'),
        durationMs: clock() - startedAt
      });
      logger('turn-done', {
        turnId: turnId, conversationId: conversationId, messageId: written.id,
        revision: written.revision, durationMs: clock() - startedAt,
        truncated: !!result.truncated, streamed: !!result.streamed,
        contentLength: text.length
      });
      return {
        ok: true,
        outcome: 'completed',
        turnId: turnId,
        conversationId: conversationId,
        userMessageId: userMessageId,
        assistantMessageId: written.id,
        revision: written.revision,
        text: text,
        reasoning: reasoning,
        message: assistantMessage
      };
    } catch (error) {
      const kind = classify(error);
      const partialText = partial.text;
      const aborted = kind === 'abort' || kind === 'timeout' || kind === 'cancelled';
      /* 取消/超时且已有部分内容 → 保留为 canonical 的一部分（partial），
         与浏览器 communication.js:3796-3799 的「非空部分文本才落库」同语义。
         这样重试同一 requestId 不会重复生成，客户端能看到已经产出的内容。 */
      if (aborted && partialText.trim()) {
        const partialMessage = buildAssistantMessage({
          request: request, userMessage: userMessage, friendId: friendId, threadId: threadId,
          text: partialText, reasoning: '', result: {}, conversationId: conversationId,
          extraMetadata: { partial: true, interrupted: kind }
        });
        const written = store.putMessage(partialMessage, { idempotent: false });
        emit({ type: 'error', kind: kind, message: String(error && error.message || kind), retryable: kind !== 'cancelled', partialMessageId: written.ok ? written.id : null });
        logger('turn-partial', { turnId: turnId, conversationId: conversationId, kind: kind, partialLength: partialText.length });
        return fail(kind, { turnId: turnId, userMessageId: userMessageId, conversationId: conversationId, partialMessageId: written.ok ? written.id : null });
      }
      emit({ type: 'error', kind: kind, message: String(error && error.message || kind), retryable: kind !== 'cancelled' });
      logger('turn-error', { turnId: turnId, conversationId: conversationId, kind: kind, error: String(error && error.message || '').slice(0, 300) });
      return fail(kind, { turnId: turnId, userMessageId: userMessageId, conversationId: conversationId, message: String(error && error.message || '') });
    } finally {
      inFlight.delete(conversationId);
    }
  }

  function classify(error) {
    const name = String((error && error.name) || '');
    const kind = String((error && error.kind) || '');
    const message = String((error && error.message) || error || '');
    if (name === 'TimeoutError' || /timed out/i.test(message)) return 'timeout';
    if (name === 'AbortError' || kind === 'abort' || /abort/i.test(message)) return 'abort';
    if (kind === 'provider-stream') return 'provider-error';
    if (kind === 'http' || (error && error.status)) return 'provider-error';
    if (kind === 'unknown' && /^invalid JSON response/.test(message)) return 'provider-error';
    return kind || 'provider-error';
  }

  /* assistant 消息的 canonical 构造：字段名逐条对应生产写入形状
     （docs/CHAT_MESSAGE_CONTRACT.md §2 / §4），保证浏览器读到的是同一套字段。 */
  function buildAssistantMessage(ctx) {
    const request = ctx.request || {};
    const userMessage = ctx.userMessage || {};
    const result = ctx.result || {};
    const id = String(request.assistantMessageId || '') || CHAT_CORE.generateMessageId('assistant', { now: clock() });
    const message = {
      id: id,
      role: 'assistant',
      content: ctx.text,
      reasoning_content: ctx.reasoning || '',
      metadata: Object.assign({
        model: String((request.character && (request.character.spec || request.character).provider) || ''),
        model_id: String(((request.character && (request.character.spec || request.character)) || {}).model || ''),
        config_id: String((request.character && request.character.id) || userMessage.friendId || ''),
        source: 'home_node',
        contextPolicy: String(request.contextPolicy || 'unspecified')
      }, ctx.extraMetadata || {}),
      friendId: ctx.friendId,
      timestamp: clock()
    };
    if (ctx.threadId) message.threadId = ctx.threadId;
    if (result && result.truncated) message.truncated = true;
    if (ctx.extraMetadata && ctx.extraMetadata.partial) message.truncated = true;
    return message;
  }

  function activeTurn(conversationId) {
    return inFlight.get(String(conversationId || '')) || null;
  }

  return {
    executeCharacterTurn: executeCharacterTurn,
    activeTurn: activeTurn,
    /* 供测试与诊断：直接暴露 prompt 组装（纯函数，无 I/O）。 */
    buildPrompt: buildPrompt,
    messageContent: messageContent
  };
}

module.exports = createTurnExecutor;
