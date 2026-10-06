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
  /* M1-C.2i · canonical Middle Brain 执行缝（可选依赖）。
     缺席 = 与 M1-C.2i 之前**逐字节相同**的行为：contextPolicy 保持调用方给的值，
     reasoningEffort 保持 'auto'，不做任何上下文替换。这让现有调用方（测试、
     只走 /turn 的桌面路径）不需要知道 Middle Brain 存在。 */
  const middleBrain = deps.middleBrain || null;
  /* P34.3-B · Home Node credential access layer (ADR P34.3-A.1 Decision 1).
     Optional: when absent the executor keeps pre-P34.3 behavior (spec.apiKey). */
  const credentialAccess = deps.credentialAccess || null;
  /* ── P5-B3-D3-B · turn instance identity authority ──────────────────
     TURN_INSTANCE_ID_AUTHORITY = EXECUTION_RUNTIME。
     生产路径**不得**由 caller 提供 turnId；`turnIdFactory` 只是**构造期**注入的
     依赖（测试用），owner mint 的调用点始终在本模块内。 */
  const turnIdFactory = typeof deps.turnIdFactory === 'function' ? deps.turnIdFactory : null;
  const makeTurnId = turnIdFactory || (() => TURN_ID_PREFIX + CHAT_CORE.stableToken(String(clock()) + ':'
    + Math.random()));
  /* ── P5-B3-D3-A · canonical character binding authority ─────────────
     RAW_CLIENT_CHARACTER_ID_IS_AUTHORITY = NO
     FRIEND_ID_CHARACTER_FALLBACK = FORBIDDEN
     character scope 只能来自服务端 canonical registry（device-registry
     的 getCharacterSpec 接口，与 runtime-recall / runtime-interpretation 同一个）。 */
  const characterRegistry = deps.characterRegistry || null;
  /* ── P5-B3-D4 · downstream terminal sink（assembly 注入）────────────────
     执行 runtime 只 **通知** 终局；RealityEvent authority 属于 runtime-reality-event。
     本模块**不得** import runtime-reality-event（见 seam guard）。 */
  const onTurnTerminal = typeof deps.onTurnTerminal === 'function' ? deps.onTurnTerminal : null;
  const inFlight = new Map();                   /* conversationId → turnId */

  function fail(code, extra) {
    return Object.assign({ ok: false, error: code }, extra || {});
  }

  /* ── P5-B3-D3 · canonical Turn Context（authority fields **immutable**）── */
  function deepFreezeTurnContext(ctx) {
    Object.keys(ctx).forEach((k) => { if (ctx[k] && typeof ctx[k] === 'object') Object.freeze(ctx[k]); });
    return Object.freeze(ctx);
  }
  function createTurnContext(input) {
    return deepFreezeTurnContext({
      turnId: String(input.turnId),
      requestCorrelationId: String(input.requestCorrelationId),
      characterId: String(input.characterId),
      conversationId: String(input.conversationId)
    });
  }

  /* character selector → server-validated canonical binding。
     失败一律 fail closed；**绝不**回退到 friendId / 默认角色 / 当前角色。

     ★ 权威边界（P5-B3-D3 owner ruling）：
       · **identity**（characterId）必须由服务端 canonical registry 确认存在
         ⇒ RAW_CLIENT_CHARACTER_ID_IS_AUTHORITY = NO
       · provider 配置（endpoint / model / systemPrompt）沿用既有 request 契约
         （与本轮 ruling 无关，不在 D3 scope 内；此处显式记录，不静默扩权）。 */
  function resolveCharacterBinding(request) {
    const declared = (request && typeof request.character === 'object' && request.character) ? request.character : null;
    const selector = declared && declared.id != null ? String(declared.id).trim() : '';
    if (!selector) return { ok: false, error: 'missing-character-selector' };
    /* 客户端 id 只是 selector，不是 authority。 */
    if (!characterRegistry || typeof characterRegistry.getCharacterSpec !== 'function') {
      return { ok: false, error: 'character-authority-unavailable', characterId: selector };
    }
    let registrySpec = null;
    try { registrySpec = characterRegistry.getCharacterSpec(selector); } catch (_) { registrySpec = null; }
    if (!registrySpec || typeof registrySpec !== 'object') {
      return { ok: false, error: 'character-not-bound', characterId: selector };
    }
    const declaredSpec = (declared.spec && typeof declared.spec === 'object') ? declared.spec : declared;
    const spec = Object.assign({}, registrySpec, declaredSpec);
    if (!spec.endpoint || !spec.model) {
      return { ok: false, error: 'character-not-ready', characterId: selector };
    }
    return { ok: true, characterId: selector, spec: spec, authority: 'server-registry' };
  }

  /* ── P5-B3-D3-C · ONE canonical terminal settle seam ─────────────────
     TERMINAL_DECISION_COUNT_PER_TURN = 1
     所有 **turn instance 创建之后** 的终局路径都必须只经过这里。
     finally 仍然是 cleanup，**不是** terminal authority。 */
  const TERMINAL_HOLDER_MAX = 256;
  const terminalByTurnId = new Map();
  function settleTurnOutcome(turnContext, outcomeCode) {
    if (!turnContext || !turnContext.turnId) return { ok: false, status: 'no-instance', terminal: null };
    const prior = terminalByTurnId.get(turnContext.turnId);
    if (prior) return { ok: false, status: 'duplicate', terminal: prior };
    const terminal = Object.freeze({
      turnId: turnContext.turnId,
      characterId: turnContext.characterId,
      conversationId: turnContext.conversationId,
      requestCorrelationId: turnContext.requestCorrelationId,
      outcome: String(outcomeCode),
      occurredAt: Number(clock())
    });
    terminalByTurnId.set(turnContext.turnId, terminal);
    while (terminalByTurnId.size > TERMINAL_HOLDER_MAX) {
      const oldest = terminalByTurnId.keys().next();
      if (oldest.done) break;
      terminalByTurnId.delete(oldest.value);
    }
    return { ok: true, status: 'terminal', terminal: terminal };
  }
  /* 返回值**逐字节不变**：seam 只负责记录终局，不改变既有结果形状。 */
  function finalize(turnContext, outcomeCode, result) {
    const settled = settleTurnOutcome(turnContext, outcomeCode);
    /* CALLBACK TIMING：terminal fact **先**成立，之后才 notify。
       §28：只有**新**终局才通知（第二次 settle 是 duplicate ⇒ 不再 emit）。
       §6/§26：下游抛错只做 diagnostics，**绝不**改写 turn outcome。 */
    if (settled && settled.ok === true && onTurnTerminal) {
      try { onTurnTerminal(settled.terminal); }
      catch (error) {
        try { logger('turn-terminal-sink-failed', { turnId: settled.terminal.turnId, error: String((error && error.message) || error).slice(0, 200) }); } catch (_) { /* diagnostics 不得影响回合 */ }
      }
    }
    return result;
  }

  /* P34.3-B · resolve this turn's provider secret from the Vault.
     Prefers spec.credentialRef → Vault (request-scoped); during migration a
     plaintext spec.apiKey is still honored; otherwise fail-closed.
     The returned apiKey lives only in the request-scoped spec handed to the port. */
  function resolveRuntimeSpec(spec) {
    const hasCredentialRef = !!(spec && Object.prototype.hasOwnProperty.call(spec, 'credentialRef'));
    const ref = String((spec && spec.credentialRef) || '').trim();
    if (hasCredentialRef) {
      if (!ref) return { ok: false, error: 'credential-unavailable' };
      if (!credentialAccess) return { ok: false, error: 'credential-unavailable' };
      const resolved = credentialAccess.resolve(ref);
      if (resolved && resolved.ok === true && resolved.secret) {
        return { ok: true, requestScoped: true, spec: Object.assign({}, spec, { apiKey: resolved.secret }) };
      }
      return { ok: false, error: 'credential-unavailable' };
    }
    /* Legacy readers remain only for pre-ref snapshots; once a ref exists, Vault failure is final. */
    if (spec && typeof spec.apiKey === 'string' && spec.apiKey.trim()) return { ok: true, requestScoped: true, spec: Object.assign({}, spec) };
    return { ok: false, error: 'credential-unavailable' };
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

  /* prompt 组装。
     M1-C.2i：运行时上下文不再由本函数直接决定 —— 调用方先把 canonical 上下文组织成
     `runtimeContext`，Middle Brain 执行缝（若参与）再把它**替换**成压缩结果。
     因此这里收的是已经定稿的那一段，而不是自己去读 request.runtimeContext：
     保证"执行缝在 provider 请求构造之前"这条顺序在类型上成立（late 参数 = 定稿值）。 */
  function buildPrompt(request, composedRuntimeContext) {
    const character = request.character || {};
    /* spec resolution 必须与 executeCharacterTurn() 逐字一致（同为 character.spec || character）。
       生产调用方（mobile-gateway.js）给的是 { id, spec }：顶层**没有** systemPrompt。
       此前只读 character.systemPrompt，于是人格被静默丢弃、模型收到空 system。 */
    const spec = character.spec || character;
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
    let system = String(spec.systemPrompt || character.systemPrompt || '');
    const ctx = String(composedRuntimeContext == null ? (request.runtimeContext || '') : composedRuntimeContext);
    if (ctx) system += (system ? '\n\n' : '') + ctx;
    return { system: system, messages: messages };
  }

  /* ── M1-C.2i · canonical Middle Brain 注入契约（与桌面 _mbInjectable 同一纪律）──
     seam 的返回值 → "是否允许改写最终角色请求里的上下文"。三个条件**全部**成立才注入，
     任一不成立即保留原始上下文（绝不"近似注入"）：
       ① seam 确实产出（adapter 的 applied）；
       ② 来源具名（'local' / 'astra'）——不得把 source 判成 truthy；
       ③ payload 非空且**确实组织过上下文**（stats.empty !== true）。
            否则 compressedContext 只是当前用户消息的回声，注入它只会加一段无信息的重复块。
     与桌面的一处**已知差异**（如实标注，不假装一致）：
     桌面在 local 分支额外要求 `payload.indexOf(userMessage) >= 0`，用来反证 payload 来自
     本轮上下文而不是残骸。Home Node 不做这条 —— 因为本节点的 local pipeline 拿到的是
     dialogue（历史 + 当前消息），当前消息由**适配层**在 compose 之后追加，
     seam 的返回值里不保证含它。用"本节点拿不到的证据"去判定会变成一条恒假条件，
     那不是更严格，而是把注入悄悄关掉。 */
  function injectable(result) {
    try {
      if (!result || result.applied !== true) return false;
      const source = String(result.source || '');
      if (source !== 'astra' && source !== 'local') return false;
      const payload = result.compressedContext;
      if (typeof payload !== 'string' || !payload.trim()) return false;
      if (result.stats && result.stats.empty === true) return false;
      return true;
    } catch (error) { return false; }
  }

  /* 把 Middle Brain 的压缩上下文拼进 canonical 上下文：**替换**证据块，保留 P0。
     为什么按"块"替换而不是整段替换：canonical 上下文的形状是
         P0(身份/称呼/关系) + 证据块(记忆, 线索) + 当前时间
     （见 memory-retrieval.js 的顺序契约）。P0 与时间不是 Middle Brain 的输入，
     它们也不该被它的输出吃掉 —— 桌面同样是"只替换那些 producer 的块"。
     parts 逐块显式给，缺块就跳过：不靠字符串搜索定位（碰巧同形会替换错位置）。

     M1-C.2k：线索块的处理与记忆块**同款**（中间件产出则被它吸收，未产出则放回原位）。
     为什么不把线索单独再拼一次：那会在中间件已经产出时把同一份证据注入两遍 ——
     桌面是"四个块一起被处理结果替换"，Home Node 必须保持同一条不重复纪律。 */
  function composeRuntimeContext(parts, middlewareContext) {
    const list = [];
    if (parts) {
      if (parts.p0Stable) list.push(String(parts.p0Stable));
      if (middlewareContext) {
        list.push(String(middlewareContext));
      } else {
        /* 顺序与桌面逐字一致（communication.js:1476-1479：
           memory → understanding → thread）：块顺序变了，同一批证据拼出的
           prompt 就不同，而"两端同一份语义证据"正是本阶段要证明的东西。 */
        if (parts.memoryBlock) list.push(String(parts.memoryBlock));
        if (parts.understandingBlock) list.push(String(parts.understandingBlock));
        if (parts.threadBlock) list.push(String(parts.threadBlock));
        /* M1-C.2n：动态块与桌面同序（communication.js:1475-1479 的
           memory → understanding → thread → moments）。 */
        if (parts.momentsBlock) list.push(String(parts.momentsBlock));
      }
      if (parts.p0Time) list.push(String(parts.p0Time));
      if (list.length) return list.join('\n\n');
    }
    /* 没有分块信息（旧装配 / 直接调用 executor 的调用方）→ 退回单段 runtimeContext。 */
    if (middlewareContext) return String(middlewareContext);
    return String(parts && parts.runtimeContext ? parts.runtimeContext : '');
  }

  /* 从调用方给的 canonical 上下文分块里取出**记忆块**，交给 Middle Brain 执行缝。
     为什么要有这个函数：执行缝需要的是"本轮已读到的记忆"，而不是整段 runtimeContext
     （后者还含 P0 身份/关系/时间 —— 那些不是 Middle Brain 的输入，也不该被它压缩）。
     取不到分块信息时如实返回 {consulted:false}：组织层据此走 missing 分支，
     **不会**误判成"读过且为空"而跳过它自己的 retrieval 语义。 */
  function memoryPartOf(request) {
    const parts = request && request.runtimeContextParts;
    if (!parts || typeof parts !== 'object') return { text: '', consulted: false };
    return {
      text: String(parts.memoryBlock || ''),
      consulted: parts.memoryConsulted === true
    };
  }

  /* M1-C.2k · 同款取出**线索块**（canonical memory 上的确定性派生，见
     thread-retrieval.js）。为什么不复用 memoryPartOf：两者是三态契约的同形但
     **不同来源**，混用会把"线索没读"记成"记忆为空"。与 memoryPartOf 一样，
     取不到分块信息时如实返回 consulted:false（missing），组织层据此保留自己的
     retrieval 语义，**不会**误判成"读过且为空"。 */
  function threadPartOf(request) {
    const parts = request && request.runtimeContextParts;
    if (!parts || typeof parts !== 'object') return { text: '', consulted: false };
    return {
      text: String(parts.threadBlock || ''),
      consulted: parts.threadConsulted === true
    };
  }

  /* M1-C.2m · 同款取出**理解块**（canonical understanding_records，见
     understanding-retrieval.js）。与 threadPartOf 逐字同形，理由也相同：
     三个来源各有自己的三态，混用会把"理解没读"记成"记忆为空" ——
     而两者的诊断含义完全不同。 */
  function understandingPartOf(request) {
    const parts = request && request.runtimeContextParts;
    if (!parts || typeof parts !== 'object') return { text: '', consulted: false };
    return {
      text: String(parts.understandingBlock || ''),
      consulted: parts.understandingConsulted === true
    };
  }

  /* M1-C.2n · 同款取出**动态块**（canonical moment_records，见 moments-retrieval.js）。
     四个来源各有自己的三态，混用会把"动态没读"记成"记忆为空" ——
     而两者的诊断含义完全不同。 */
  function momentsPartOf(request) {
    const parts = request && request.runtimeContextParts;
    if (!parts || typeof parts !== 'object') return { text: '', consulted: false };
    return {
      text: String(parts.momentsBlock || ''),
      consulted: parts.momentsConsulted === true
    };
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

    /* character 必须经服务端 canonical registry 绑定；失败 fail closed。 */
    const binding = resolveCharacterBinding(request);
    if (!binding.ok) {
      logger('turn-character-unbound', {
        requestId: requestId, conversationId: conversationId,
        reason: binding.error, characterSelector: binding.characterId || null
      });
      return fail(binding.error, { characterId: binding.characterId || null });
    }
    const characterId = binding.characterId;
    const spec = binding.spec;

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
    /* PRODUCTION_CALLER_SUPPLIED_TURN_ID = FORBIDDEN：
       caller 的 options.turnId / request.turnId **不**参与 identity。 */
    const turnId = makeTurnId();
    inFlight.set(conversationId, turnId);
    /* TURN_CONTEXT_CREATION_POINT —— 此刻 turnId / characterId /
       conversationId / requestCorrelationId 全部已知且此后 immutable。 */
    const turnContext = createTurnContext({
      turnId: turnId,
      requestCorrelationId: requestId,
      characterId: characterId,
      conversationId: conversationId
    });
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
    /* ── M1-C.2i · canonical Middle Brain 执行缝 ──────────────────────────
       顺序是硬约束（与桌面 communication.js 一致）：
         canonical context 组装（调用方，已在 request.runtimeContextParts 里）
           → **执行缝** middleBrainExecute（本处，provider 请求构造之前）
           → buildPrompt（定稿 system）
           → port.runStream → IBModelCore.buildRequestBody（provider 请求在此才构造）
       执行缝刻意放在 buildPrompt 调用点**之前**：一旦 prompt 已经定型，
       再"应用" Middle Brain 就只是在事后改一个字符串，模型早就收到了。
       每轮**只进一次**：本函数是单轮执行入口，没有第二个调用点。 */
    const mbCtx = {
      characterId: turnContext.characterId,
      turnId: turnId,
      userMessage: String(userMessage.content || ''),
      /* M1-C.2o：当前回合的**身份**（不是内容）。canonical 用户行 id 由 requestId
         确定性推导（chat-core.messageIdFromRequest，网关在 parseSendPayload 里用它
         构造 userMessage）。把它交给共享 dialogue 核心，是为了让"这一轮已经在历史
         窗口里"可以被按身份识别 —— 而不是靠比对文本（文本相近的两句话是合法的，
         按内容去重会把用户真的连发的第二条静默吃掉）。 */
      currentMessageId: (userMessage && userMessage.id != null) ? String(userMessage.id) : null,
      history: Array.isArray(request.history) ? request.history : [],
      memory: memoryPartOf(request),
      /* M1-C.2k：线索证据（与 memory 同一三态纪律）。它让 canonical Middle Brain
         在 Home Node 上也能看到 `organized.threads` —— 此前该字段恒为空，
         使 `threadItems` 恒 0，而 `multipleThreads`（threadItems>=2）是 Gate 的
         无视冷却硬触发，于是同一份策略在两端给出不同判定。 */
      thread: threadPartOf(request),
      /* M1-C.2m：理解证据（与 memory / thread 同一三态纪律）。
         它让 canonical Middle Brain 在 Home Node 上也能看到 organized.understanding ——
         此前该字段恒为空（节点根本没有理解来源），于是注入块里**从来不含**
         "她怎么理解我"，而同一份策略在桌面上是含的：那就是两端认知证据的差异。 */
      understanding: understandingPartOf(request),
      /* M1-C.2n：动态证据（与 memory / thread / understanding 同一三态纪律）。
         它让 canonical Middle Brain 在 Home Node 上也能看到 organized.moments ——
         此前该字段恒为空（节点根本没有动态来源），于是 Gate 的 momentItems
         恒 0、注入块里从来没有"她最近发过什么"。 */
      moments: momentsPartOf(request),
      /* 角色证据与桌面 communication.js 传的是**同一个形状**（cfg = spec）：
         spec.systemPrompt 是 integrity 的 persona 维度唯一来源，缺了它守卫会
         因"证据不可用"而拒绝判定（那是防误杀的设计，不是失败）。 */
      character: Object.assign({ id: turnContext.characterId }, spec),
      voice: !!userMessage.voice
    };
    let mbPolicy = String(request.contextPolicy || 'unspecified');
    let mbReasoningEffort = 'auto';
    try {
      if (middleBrain && typeof middleBrain.isEnabled === 'function') {
        const enabled = await middleBrain.isEnabled();
        if (enabled) {
          /* 思考深度是**执行策略**，由 canonical Middle Brain 配置决定；
             它不再接受 payload 传来的值（见 mobile-gateway 的 parseSendPayload）。
             未启用时保持 'auto' —— 与桌面 _mbReasoningEffortForRequest 同一语义。 */
          if (typeof middleBrain.reasoningEffort === 'function') {
            mbReasoningEffort = String((await middleBrain.reasoningEffort()) || 'auto');
          }
          const organized = await middleBrain.organizeContext(mbCtx);
          if (organized && organized.snapshot) mbCtx.snapshot = organized.snapshot;
          if (organized && organized.policy) mbPolicy = String(organized.policy);
          if (injectable(organized)) {
            mbCtx.injectedContext = String(organized.compressedContext);
            mbPolicy += '/injected';
          } else if (organized && organized.reason) {
            mbPolicy += '/' + String(organized.reason);
          }
        }
      }
    } catch (error) {
      /* Middle Brain 是认知增强层，不是聊天单点故障：任何故障只记一行，回合继续。
         策略标签里必须留下**原因** —— 否则"未启用"与"启用但炸了"会渲染成同一个
         字符串，运维只能看到"好像没生效"（本阶段要求两者可区分）。 */
      logger('turn-middle-brain-failed', { turnId: turnId, conversationId: conversationId, error: String((error && error.message) || error).slice(0, 300) });
      const memoryReadiness = (request.runtimeContextParts && request.runtimeContextParts.memoryConsulted === true) ? 'present' : 'missing';
      mbPolicy = 'middle-brain:bypass/memory:' + memoryReadiness + '/error';
    }
    const composedRuntimeContext = composeRuntimeContext(request.runtimeContextParts, mbCtx.injectedContext);
    try {
      /* credential 解析属于 **post-instance** terminal —— 必须在本 try 之内，
         否则既不记录终局、也走不到 finally 的 inFlight 清理。 */
      const runtimeSpec = resolveRuntimeSpec(spec);
      if (!runtimeSpec.ok) return finalize(turnContext, 'credential-unavailable', fail(runtimeSpec.error || 'credential-unavailable', { turnId: turnId, userMessageId: userMessageId, conversationId: conversationId }));
      let result;
      try {
        result = await port.runStream({
          spec: runtimeSpec.spec,
          prompt: buildPrompt(request, composedRuntimeContext),
          maxTokens: request.maxTokens != null ? request.maxTokens : DEFAULT_MAX_TOKENS,
          temperature: request.temperature != null ? request.temperature : (spec.temperature != null ? spec.temperature : null),
          reasoningEffort: mbReasoningEffort,
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
      } finally {
        if (runtimeSpec.requestScoped) runtimeSpec.spec.apiKey = '';
      }

      const text = String(result.text || '');
      const reasoning = String(result.reasoning || '');
      if (!text.trim() && !reasoning.trim()) {
        emit({ type: 'error', kind: 'empty-output', message: 'model returned no content', retryable: true });
        logger('turn-empty-output', { turnId: turnId, conversationId: conversationId });
        return finalize(turnContext, 'empty-output', fail('empty-output', { turnId: turnId, userMessageId: userMessageId, conversationId: conversationId }));
      }

      /* ── 执行缝 2 · 生成后（Character Integrity Guard）──────────────────
         与桌面 communication.js:2330 位置一致：在**候选回复之后、canonical 落库之前**，
         只作用于角色可见文本。任何故障 → 原样返回候选（facade 自己保证），
         因此这里不需要也不再包一层"失败就用原文"的判定。 */
      let finalText = text;
      try {
        if (middleBrain && typeof middleBrain.isEnabled === 'function' && await middleBrain.isEnabled()) {
          const finalized = await middleBrain.finalizeReply(Object.assign({}, mbCtx, { candidate: text }));
          if (finalized && typeof finalized.reply === 'string' && finalized.reply) {
            finalText = finalized.reply;
            if (finalized.rewritten === true) mbPolicy += '/integrity-rewritten';
            /* P11-2B · 最小 provenance：只标记**异常态**（尝试过但没有拿到 verdict）。
               BYPASSED 不标 —— 那是每一轮"未启用/未就绪"的常态，给它加标记会让
               "本轮实际发生了什么"的语义变浑浊（M1-C.2i 的诚实性不变量）。
               也不改变任何 downstream 行为（下游策略属 P11-2C，本阶段不碰）。 */
            if (finalized.verdict === 'UNDECIDED') mbPolicy += '/integrity-undecided';
          }
        }
      } catch (error) {
        logger('turn-middle-brain-finalize-failed', { turnId: turnId, conversationId: conversationId, error: String((error && error.message) || error).slice(0, 300) });
      }

      const assistantMessage = buildAssistantMessage({
        characterId: turnContext.characterId,
        request: request, userMessage: userMessage, friendId: friendId, threadId: threadId,
        text: finalText, reasoning: reasoning, result: result, conversationId: conversationId,
        extraMetadata: { contextPolicy: mbPolicy }
      });
      const written = store.putMessage(assistantMessage, { idempotent: false });
      if (!written.ok) {
        /* 生成成功但 canonical 写入失败 —— 必须显式失败，绝不假装成功。
           重试同一 requestId 会命中 user 消息的幂等记录，不会产生第二条用户消息。 */
        emit({ type: 'error', kind: 'store-write-failed', message: String(written.error || 'write failed'), retryable: true });
        logger('turn-store-write-failed', { turnId: turnId, conversationId: conversationId, error: String(written.error || '') });
        return finalize(turnContext, 'store-write-failed', fail('store-write-failed', { turnId: turnId, userMessageId: userMessageId, conversationId: conversationId, errors: written.errors }));
      }

      emit({
        type: 'done', messageId: written.id, revision: written.revision,
        text: finalText, reasoning: reasoning,
        truncated: !!result.truncated, usage: result.usage || null,
        contextPolicy: mbPolicy,
        durationMs: clock() - startedAt
      });
      logger('turn-done', {
        turnId: turnId, conversationId: conversationId, messageId: written.id,
        revision: written.revision, durationMs: clock() - startedAt,
        truncated: !!result.truncated, streamed: !!result.streamed,
        contentLength: finalText.length,
        contextPolicy: mbPolicy,
        reasoningEffort: mbReasoningEffort
      });
      /* PERSISTENCE_SUCCESS_REQUIRED_FOR_COMPLETED = YES：
         走到这里意味着 store.putMessage 已经成功。 */
      return finalize(turnContext, 'completed', {
        ok: true,
        outcome: 'completed',
        turnId: turnId,
        conversationId: conversationId,
        userMessageId: userMessageId,
        assistantMessageId: written.id,
        revision: written.revision,
        text: finalText,
        reasoning: reasoning,
        contextPolicy: mbPolicy,
        message: assistantMessage
      });
    } catch (error) {
      const kind = classify(error);
      const partialText = partial.text;
      const aborted = kind === 'abort' || kind === 'timeout' || kind === 'cancelled';
      /* 取消/超时且已有部分内容 → 保留为 canonical 的一部分（partial），
         与浏览器 communication.js:3796-3799 的「非空部分文本才落库」同语义。
         这样重试同一 requestId 不会重复生成，客户端能看到已经产出的内容。 */
      if (aborted && partialText.trim()) {
        const partialMessage = buildAssistantMessage({
          characterId: turnContext.characterId,
          request: request, userMessage: userMessage, friendId: friendId, threadId: threadId,
          text: partialText, reasoning: '', result: {}, conversationId: conversationId,
          extraMetadata: { partial: true, interrupted: kind }
        });
        const written = store.putMessage(partialMessage, { idempotent: false });
        emit({ type: 'error', kind: kind, message: String(error && error.message || kind), retryable: kind !== 'cancelled', partialMessageId: written.ok ? written.id : null });
        logger('turn-partial', { turnId: turnId, conversationId: conversationId, kind: kind, partialLength: partialText.length });
        return finalize(turnContext, kind, fail(kind, { turnId: turnId, userMessageId: userMessageId, conversationId: conversationId, partialMessageId: written.ok ? written.id : null }));
      }
      emit({ type: 'error', kind: kind, message: String(error && error.message || kind), retryable: kind !== 'cancelled' });
      logger('turn-error', { turnId: turnId, conversationId: conversationId, kind: kind, error: String(error && error.message || '').slice(0, 300) });
      return finalize(turnContext, kind, fail(kind, { turnId: turnId, userMessageId: userMessageId, conversationId: conversationId, message: String(error && error.message || '') }));
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
    const extra = ctx.extraMetadata || {};
    const message = {
      id: id,
      role: 'assistant',
      content: ctx.text,
      reasoning_content: ctx.reasoning || '',
      metadata: Object.assign({
        model: String((request.character && (request.character.spec || request.character).provider) || ''),
        model_id: String(((request.character && (request.character.spec || request.character)) || {}).model || ''),
        config_id: String(ctx.characterId || ''),
        source: 'home_node',
        /* M1-C.2i：contextPolicy 由**本轮实际发生的事**决定（执行缝参与了没有、
           注入有没有发生）。这个字段是"这一轮到底吃了什么上下文"的唯一诚实记录，
           所以它是算出来的（extra.contextPolicy），不是标注出来的。
           `extra` 在 Object.assign 里位于其后，因此不会把算出来的值又盖回静态标注。 */
        contextPolicy: String((ctx.extraMetadata && ctx.extraMetadata.contextPolicy != null)
          ? ctx.extraMetadata.contextPolicy : (request.contextPolicy || 'unspecified'))
      }, extra),
      friendId: ctx.friendId,
      timestamp: clock()
    };
    if (ctx.threadId) message.threadId = ctx.threadId;
    if (result && result.truncated) message.truncated = true;
    if (ctx.extraMetadata && ctx.extraMetadata.partial) message.truncated = true;
    return message;
  }

  /* P5-B3-D3 · 只读终局访问器。**不** mint RealityEvent，**不**做 pairing。 */
  function terminalOutcomeOf(turnId) {
    const t = terminalByTurnId.get(String(turnId || ''));
    return t || null;
  }
  function terminalHolderSize() { return terminalByTurnId.size; }

  function activeTurn(conversationId) {
    return inFlight.get(String(conversationId || '')) || null;
  }

  return {
    executeCharacterTurn: executeCharacterTurn,
    activeTurn: activeTurn,
    /* 供测试与诊断：直接暴露 prompt 组装（纯函数，无 I/O）。 */
    buildPrompt: buildPrompt,
    messageContent: messageContent,
    /* P5-B3-D3 · 终局见证（只读）。D4 将用它投影 RealityEvent；
       本模块**不**接 RealityEvent。 */
    terminalOutcomeOf: terminalOutcomeOf,
    terminalHolderSize: terminalHolderSize
  };
}

module.exports = createTurnExecutor;
