/* ====================================================================
   IB Runtime Core — AgentRuntime v2 (Runtime Core + P1 ModelPort)
   --------------------------------------------------------------------
   v2 在 v1（边界与接口定义）基础上新增了 **P1 Model Execution Port**：
   - resolveModel() → ModelSpec（provider-neutral 字段，不携带整个 cfg 进 ModelPort）
   - execute(request, {signal,onEvent}) → 通过注入的 ModelPort 执行（不再是黑盒 loop.opts 透传）
   - 默认 modelPort = 一个 **Adapter**，把现有 callApiChatStream/callApiChat 的
     回调/返回值/异常 转成 统一的 ExecutionEvent 流。

   本文件遵守的硬约束：
   - 不修改 callApiChat / callApiChatStream / callApi / callCharacterModel；
   - 不修改 Memory / Moments / Letters / Proactive / Scheduler / Tool 系统；
   - 不迁移 Chat；sendChatMessage 仍走 callApiChatStream/callApiChat；
   - 不引入新的 retry / autoContinue / FC / budget-fallback（仍留在现有执行器内）；
   - 不改变任何现有行为：本模块是纯增量，现有功能不调用它。

   设计原则：
   - 单次 Model Execution 归 ModelPort；retry/round/FC/autoContinue 一律留在现有执行器。
   - Runtime / ModelPort 绝不引用 DOM / streamRefs / _showStreamingUI / _wsMakeStreamFilter /
     _mkMemLiveFilter / bubble / scroll / typing / chatKey；也不接受 onChunk/onThink/onSearch
     作为公共 API（这些只在 adapter 内部被映射成 text_delta/reasoning_delta/search 后交给 onEvent）。
   ==================================================================== */
(function (NS) {
  'use strict';

  function has(fn) { return typeof fn === 'function'; }
  function isObj(v) { return !!v && typeof v === 'object'; }

  /* composeMessages 取最近多少条历史（与生产 Chat 上下文尾部规模同量级；不塞整段历史）。 */
  const HISTORY_TURNS = 12;

  /* ── provider → wire format（唯一真源 = provider-directory.js）──
     历史缺陷：早期用 has()（只判函数）检查 IBModelCore / PROVIDERS 两个对象，
     条件恒假 → anthropic / gemini 静默回落 openai。现在按对象存在性 + 目录条目判定，
     并显式返回 known / source，未知 provider 才落到 openai（与 provider-directory 的
     providerFormat 缺省一致，不再"静默"：ModelSpec.formatKnown=false 会如实暴露）。 */
  function _providerTable() {
    const core = window.IBModelCore;
    if (isObj(core) && isObj(core.PROVIDERS) && Object.keys(core.PROVIDERS).length) return { table: core.PROVIDERS, source: 'IBModelCore' };
    const dir = window.PROVIDERS_DIR;
    if (isObj(dir) && isObj(dir.PROVIDERS) && Object.keys(dir.PROVIDERS).length) return { table: dir.PROVIDERS, source: 'PROVIDERS_DIR' };
    if (isObj(window.PROVIDERS) && Object.keys(window.PROVIDERS).length) return { table: window.PROVIDERS, source: 'PROVIDERS' };
    return { table: null, source: '' };
  }
  /* P11-0：format 决策委托 canonical provider-directory.js。
     只从 **本次实际读到的那张表** 取 resolver（IBModelCore / PROVIDERS_DIR 各自导出的
     resolveProviderFormat），避免跨表读取造成 known / hasFormat 漂移；
     window.PROVIDERS 是纯表别名、无 resolver → 用与 canonical 等值的本地表达式。 */
  function _canonResolver(source) {
    const pick = obj => (isObj(obj) && typeof obj.resolveProviderFormat === 'function') ? obj.resolveProviderFormat : null;
    if (source === 'IBModelCore') return pick(window.IBModelCore);
    if (source === 'PROVIDERS_DIR') return pick(window.PROVIDERS_DIR);
    return null;
  }
  function resolveProviderFormat(provider) {
    const name = String(provider || '');
    const picked = _providerTable();
    const entry = picked.table ? picked.table[name] : null;
    if (entry) {
      const canon = _canonResolver(picked.source);
      const decided = canon ? canon(provider) : null;
      const localFmt = String(entry.format || '');
      const fmt = (decided && decided.format) ? String(decided.format) : (localFmt || 'openai');
      const hasFormat = decided ? !!decided.hasFormat : !!localFmt;
      return { format: fmt || 'openai', known: true, source: picked.source + (hasFormat ? '' : '(no-format-default)') };
    }
    return { format: 'openai', known: false, source: 'unknown-provider-default' };
  }

  /* 诊断用 format（唯一实现）：与执行链同源 —— resolveModel → provider-directory。
     P11-0：Active / Moments / Diary 三个后台域的 telemetry 共用本函数，
     不再各自复制同一段 3 行代码（各自只保留同域兜底 shim）。 */
  function modelFormat(cfg, runtime) {
    try { if (runtime && typeof runtime.resolveModel === 'function') { const m = runtime.resolveModel(cfg || {}); if (m && m.format) return String(m.format); } } catch (e) { /* 继续兜底 */ }
    try { const core = window.IBModelCore; if (isObj(core) && typeof core.providerFormat === 'function') return String(core.providerFormat((cfg || {}).provider) || ''); } catch (e) { /* 继续兜底 */ }
    try { const dir = window.PROVIDERS_DIR; if (isObj(dir) && typeof dir.providerFormat === 'function') return String(dir.providerFormat((cfg || {}).provider) || ''); } catch (e) { /* 兜底结束 */ }
    return '';
  }

  /* 用量归一：执行器回传的原始形态（{i,cr,cw,o} 或 provider 原生字段）→ 统一结构。
     无任何计量 → null（绝不伪造成 0）。 */
  function normalizeUsage(u) {
    if (!isObj(u)) return null;
    const num = v => Math.max(0, Number(v) || 0);
    if (u.i != null || u.o != null || u.cr != null || u.cw != null) {
      const i = num(u.i), o = num(u.o), cr = num(u.cr);
      if (!(i || o || cr)) return null;
      return { input_tokens: i, output_tokens: o, total_tokens: i + o, cached_tokens: cr };
    }
    const input = num(u.input_tokens != null ? u.input_tokens : u.prompt_tokens);
    const output = num(u.output_tokens != null ? u.output_tokens : u.completion_tokens);
    const cached = num(u.cached_tokens);
    if (!(input || output || cached)) return null;
    return { input_tokens: input, output_tokens: output,
      total_tokens: num(u.total_tokens != null ? u.total_tokens : (input + output)), cached_tokens: cached };
  }
  function abortError(message) {
    const error = new Error(message || 'ModelPort: 执行已中止');
    error.name = 'AbortError';
    error.ibCat = 'aborted';
    return error;
  }

  /* ── 统一迁移诊断（Phase 1 Active / Phase 2 Moments / 后续 consumer 共用同一结构）──
     结构 + 白名单收敛在这里；各 consumer 只用自己的 logger 输出（sink 不同、字段不再各自漂移）。
     白名单之外的键一律丢弃 → apiKey / prompt / messages / 模型正文 / Memory 内容不可能被记录。 */
  const TELEMETRY_FIELDS = ['consumer', 'executor', 'provider', 'format', 'model', 'usage', 'jsonMode',
    'abortMode', 'abortReason', 'fallbackReason', 'attempt', 'taskId', 'characterId', 'kind', 'ok', 'ms'];
  const TELEMETRY_RING = [];
  const TELEMETRY_MAX = 200;
  function telemetryBuild(consumer, data) {
    const out = { consumer: String(consumer || ''), at: Date.now() };
    const src = isObj(data) ? data : {};
    for (let i = 0; i < TELEMETRY_FIELDS.length; i++) {
      const key = TELEMETRY_FIELDS[i];
      if (src[key] === undefined || src[key] === null) continue;
      out[key] = (typeof src[key] === 'string') ? src[key].slice(0, 160) : src[key];
    }
    return out;
  }
  function telemetryRecord(consumer, data) {
    const rec = telemetryBuild(consumer, data);
    try { TELEMETRY_RING.push(rec); if (TELEMETRY_RING.length > TELEMETRY_MAX) TELEMETRY_RING.shift(); } catch (e) { /* ignore */ }
    return rec;
  }
  function telemetryRecent(n) {
    const k = Math.max(1, Math.min(TELEMETRY_MAX, Number(n) || 20));
    return TELEMETRY_RING.slice(-k);
  }

  /* ══ 默认 ModelPort：Adapter over 现有 callApiChatStream/callApiChat ══
     绝不复制 provider 请求 / SSE 解析 / retry 逻辑——只做 参数与事件 的双向转换。

     契约（本阶段补齐，全部可被测试断言）：
     · identity —— 由 resolveAgent().identity（= cfg.systemPrompt）承载；ModelSpec.systemPrompt
                   原样交给执行器，Runtime 不另建身份层。
     · budget   —— request.budget（number|null）。非 null 时作为执行器 maxTokens；
                   null = 交给执行器自身默认（_chatMaxTokens(cfg)）。
     · abort    —— options.signal 必使 execute() 的 Promise 及时结束（不会悬挂）。
                   mode='native'  → 执行器支持原生中断（流式）→ 在途请求真正取消；
                   mode='abandon' → 执行器不支持中断（非流式只接受超时）→ 返回 abort 错误并
                                    放弃在途请求（底层 HTTP 可能仍完成，不谎称已取消）；
                   mode='none'    → 未提供 signal。
                   中止时 outcome.aborted=true、outcome.text=''，中止前已产出的文本在
                   outcome.partialText（不静默丢数据，也不冒充成功结果）。
     · usage    —— 执行器通过 opts.result.usage 回传原始计量，这里归一为
                   {input_tokens,output_tokens,total_tokens,cached_tokens}；
                   执行器未回传 → null 且 usageSource='unavailable'。
     · executor —— request.executor 是**执行器专属选项的白名单透传**（Runtime 不解释其语义）：
                   允许 wantThinking / timeoutMs / heartbeatMs / disableTools 四个键，其它键一律忽略。
                   用途：迁移既有 consumer 时保持"思考通道开关""超时""工具开关"等执行器行为逐位一致
                   （否则会静默改变现有语义）。这里不是任意 opts 通道，禁止塞入 result/abortController/
                   onChunk/onThink/onSearch/autoContinue 等由 Runtime 掌管的字段。
                   disableTools 未显式给出时保持历史默认 true（ModelPort 不参与工具轮）。
     · consumer —— request.consumer 是**调用方声明的请求身份**（诊断 metadata，可选）：
                   'diary' / 'moments' / 'active.proactive' / 'memory_consolidation' 等，取自调用方
                   自己的执行上下文（不是页面、不是 prompt 文本、不是调用栈）。唯一用途是让
                   [IB Cache Audit] 按请求流隔离 baseline；Runtime 不解释其语义、不写回 outcome，
                   也绝不进入 provider 请求体（只作为 callOpts._ibConsumer 传给执行器）。 */
  const EXECUTOR_PASSTHROUGH = ['wantThinking', 'timeoutMs', 'heartbeatMs', 'disableTools'];
  function executorPassthrough(request) {
    const out = {};
    const src = request && request.executor;
    if (!isObj(src)) return out;
    for (let i = 0; i < EXECUTOR_PASSTHROUGH.length; i++) {
      const key = EXECUTOR_PASSTHROUGH[i];
      if (src[key] !== undefined && src[key] !== null) out[key] = src[key];
    }
    return out;
  }

  const defaultModelPort = {
    async run(request, options) {
      options = options || {};
      const onEvent = options.onEvent || function () {};
      const spec = (request && request.spec) || {};
      const messages = (request && request.messages) || [];
      const jsonMode = !!(request && request.jsonMode);
      const rawBudget = request ? request.budget : null;
      const budget = (rawBudget != null && isFinite(Number(rawBudget))) ? Number(rawBudget) : null;
      const executorOpts = executorPassthrough(request);
      /* 请求身份（诊断用，非 wire 字段）：request.consumer 是调用方声明的真实执行上下文
         （'diary' / 'moments' / 'active.proactive' / 'memory_consolidation' …），
         只用于把 Cache Audit 的 baseline 按请求流隔离；不进入 cfg、不进入任何 provider body。 */
      const consumer = String((request && request.consumer) || '').trim().slice(0, 40);
      /* 从 ModelSpec 还原执行器需要的最小 cfg 形态（≠ 整个 cfg）。
         必须带上 id / maxTokens / promptCache / vision / streaming：这些字段参与缓存键、
         输出上限与请求参数决策，早期版本丢字段会让执行器悄悄回落到默认行为。 */
      const cfg = {
        id: spec.id, provider: spec.provider, model: spec.model, endpoint: spec.endpoint,
        apiKey: spec.apiKey, maxTokens: (budget != null ? budget : (spec.maxTokens != null ? spec.maxTokens : null)),
        temperature: spec.temperature, promptCache: spec.promptCache,
        vision: spec.vision, systemPrompt: spec.systemPrompt, streaming: spec.streaming
      };
      /* ── abort 桥接：外部 AbortSignal → 执行器可接受的 AbortController ── */
      const signal = options.signal || null;
      const ac = new AbortController();
      const st = { key: '', think: '', finish: '', stopped: false, ac: ac, abortReason: '' };
      let aborted = false;
      if (signal) {
        const onAbort = function () {
          aborted = true; st.stopped = true;
          /* 结构化中止原因：执行器据此归类为 aborted 而不是 timeout（避免误报超时）。 */
          st.abortReason = 'user_stop';
          try { ac.abort(); } catch (e) { /* ignore */ }
        };
        try {
          if (signal.aborted) onAbort();
          else signal.addEventListener('abort', onAbort, { once: true });
        } catch (e) { /* signal 桥接失败不影响执行 */ }
      }
      const emit = function (ev) { try { onEvent(ev); } catch (e) { /* sink 异常忽略 */ } };
      const searchLog = [];
      const result = { reasoning_content: '', truncated: false, usage: null };
      const streaming = spec.streaming !== false && has(window.callApiChatStream);
      const abortMode = signal ? (streaming ? 'native' : 'abandon') : 'none';
      const outcome = function (extra) {
        return Object.assign({ text: '', partialText: '', reasoning: String((result && result.reasoning_content) || ''),
          truncated: !!(result && result.truncated), usage: normalizeUsage(result && result.usage),
          usageSource: (result && result.usage) ? 'executor' : 'unavailable',
          aborted: aborted, abortMode: abortMode, error: null }, extra || {});
      };
      if (aborted) {
        const mapped = { kind: 'abort', message: '执行在开始前已被中止', status: undefined };
        emit({ type: 'error', kind: mapped.kind, message: mapped.message, abortMode: abortMode });
        return outcome({ error: mapped });
      }
      try {
        const callOpts = {
          onChunk: function (t) { emit({ type: 'text_delta', text: t }); },
          onThink: function (t) { emit({ type: 'reasoning_delta', text: t }); },
          onSearch: function (ev) { emit({ type: 'search', phase: ev && ev.phase, query: ev && ev.query, results: ev && ev.results }); },
          searchLog: searchLog,
          result: result,
          abortController: ac,
          _st: st,
          autoContinue: false,       /* 单次执行；autoContinue 留在现有执行器/触发方 */
          /* 工具开关：默认关闭（ModelPort 不参与工具轮）；consumer 可用 request.executor.disableTools 显式指定，
             以便与既有 direct 调用（opts.disableTools）逐位一致。 */
          disableTools: (executorOpts.disableTools !== undefined) ? !!executorOpts.disableTools : true,
          jsonMode: jsonMode,
          _noWebSearch: true,
          /* 诊断身份：只被 [IB Cache Audit] 读取用于隔离 baseline，执行器不把它写进任何请求体 */
          _ibConsumer: consumer,
          wantMeta: true
        };
        if (budget != null) callOpts.maxTokens = budget;
        /* 白名单透传（wantThinking/timeoutMs/heartbeatMs）：保持既有 consumer 的执行器语义不变 */
        for (const key in executorOpts) { if (key !== 'disableTools') callOpts[key] = executorOpts[key]; }
        let execPromise, text;
        if (streaming) {
          execPromise = window.callApiChatStream(cfg, messages, callOpts);
        } else if (has(window.callApiChat)) {
          execPromise = window.callApiChat(cfg, messages, callOpts).then(function (r) {
            return (r && r.text != null) ? r.text : r;
          });
        } else {
          throw new Error('ModelPort: 无可用的模型执行器（callApiChatStream/callApiChat）');
        }
        if (abortMode === 'abandon') {
          /* 非流式执行器不读 abortController：用竞速让 Promise 及时结束，
             并吞掉在途请求后续的 settle，避免未处理的 rejection。 */
          execPromise.catch(function () {});
          text = await Promise.race([execPromise, new Promise(function (_, reject) {
            if (signal.aborted) return reject(abortError());
            try { signal.addEventListener('abort', function () { reject(abortError()); }, { once: true }); } catch (e) { /* ignore */ }
          })]);
        } else {
          text = await execPromise;
        }
        if (aborted) {
          /* 原生中断：执行器可能已返回部分文本（流式收尾语义）→ 按契约不当作成功结果。 */
          const mapped = { kind: 'abort', message: '执行已中止', status: undefined };
          emit({ type: 'error', kind: mapped.kind, message: mapped.message, abortMode: abortMode });
          return outcome({ text: '', partialText: String(text == null ? '' : text), error: mapped });
        }
        const done = outcome({ text: text });
        emit({ type: 'done', truncated: done.truncated, reasoning: done.reasoning, usage: done.usage, abortMode: abortMode });
        return done;
      } catch (e) {
        const mapped = _mapModelError(e);
        emit({ type: 'error', kind: mapped.kind, message: mapped.message, status: mapped.status, abortMode: abortMode });
        return outcome({ error: mapped, aborted: mapped.kind === 'abort' || aborted });
      }
    }
  };

  /* 最小错误映射：把现有抛错转成 {kind,message,status}，不做 error hierarchy，message 原样透传。
     优先信执行器的结构化分类（e.ibCat），避免仅靠中文文案猜测。 */
  function _mapModelError(e) {
    const name = String((e && e.name) || '');
    const msg = String((e && e.message) || (e ? String(e) : 'unknown'));
    const cat = String((e && e.ibCat) || '');
    let kind = 'unknown', status;
    if (name === 'AbortError' || cat === 'aborted' || /已停止|abort/i.test(msg)) kind = 'abort';
    else if (cat === 'timeout' || /超时|timeout/i.test(msg)) kind = 'timeout';
    else if (/网页|HTML|不是JSON|not valid json|does not look like|非JSON/i.test(msg)) kind = 'parse';
    else {
      const m = String(msg).match(/API返回\s*(\d+)/);
      if (m) { kind = 'http'; status = parseInt(m[1], 10); }
    }
    return { kind: kind, message: msg, status: status };
  }

  /* ── 默认端口：只委托到现有前端实现，绝不重复实现逻辑 ── */
  const defaultPorts = {

    /* ① resolveAgent(id) → 身份 / Role 解析（复用现有 apiConfigs / archivedConfigs）。 */
    resolveAgent(id) {
      const all = [].concat(window.apiConfigs || [], window.archivedConfigs || []);
      const cfg = all.find(a => a && String(a.id) === String(id));
      if (!cfg) return null;
      return {
        id: String(cfg.id), cfg: cfg,
        identity: String(cfg.systemPrompt || ''),
        relationship: String(cfg.relationship || ''),
        nickname: cfg.nickname || cfg.model || 'AI'
      };
    },

    /* ② loadContext(agent) → 世界 / 身份 / 状态 / 记忆上下文（委托现有 _momentsContext）。
       Context 契约（缺省实现与委托结果都必须满足；此处只补默认值，不删/不改已有字段）：
         { user:{id,name}, character, recentMessages[], memories[], recentProactiveMessages[],
           chatSummary:string, recentMoments[], otherRoleMoments[], roleLetterMemories[],
           lastInteractionAt:number }
       注意：本端口只负责"读取"，不写回（getMemoryContext 的激活计数等副作用仍留在生产管线内）。 */
    async loadContext(agent) {
      const fx = (NS.moments && has(NS.moments._momentsContext))
        ? NS.moments._momentsContext
        : (has(window._momentsContext) ? window._momentsContext : null);
      const base = {
        user: { id: '', name: '用户' }, character: (agent && agent.cfg) || null,
        recentMessages: [], memories: [], recentProactiveMessages: [],
        chatSummary: '', recentMoments: [], otherRoleMoments: [], roleLetterMemories: [],
        lastInteractionAt: 0
      };
      if (!fx) return base;
      const ctx = await fx(agent.cfg);
      return Object.assign(base, isObj(ctx) ? ctx : {});
    },

    /* ②b composeMessages(agent, ctx, input) → {system, messages}
       把 identity / loadContext 结果编进 request.messages（此前 run() 读了 ctx 却不使用，
       等于把上下文编译留成隐式债务）。这里是**最小**编译：身份 + 关系 + 聊天摘要 + 最近对话 +
       调用方显式消息。Memory / Understanding / Thread / Moments 的检索与注入仍由生产 Chat
       管线负责（见 P2-04），此处不复制、不重复注入。 */
    composeMessages(agent, ctx, input) {
      const sys = [];
      const identity = String((agent && agent.identity) || '').trim();
      if (identity) sys.push(identity);
      const relation = String((agent && agent.relationship) || '').trim();
      if (relation) sys.push('关系：' + relation);
      const summary = String((ctx && ctx.chatSummary) || '').trim();
      if (summary) sys.push('近期对话摘要：' + summary);
      const messages = [];
      if (sys.length) messages.push({ role: 'system', content: sys.join('\n') });
      const recent = (ctx && Array.isArray(ctx.recentMessages)) ? ctx.recentMessages : [];
      recent.slice(-HISTORY_TURNS).forEach(function (m) {
        if (!m || !m.content) return;
        const role = (m.role === 'assistant' || m.role === 'ai') ? 'assistant' : (m.role === 'system' ? 'system' : 'user');
        messages.push({ role: role, content: m.content });
      });
      const extra = (input && Array.isArray(input.messages)) ? input.messages : [];
      extra.forEach(function (m) { if (m) messages.push(m); });
      return { system: sys.join('\n'), messages: messages };
    },

    /* ③ resolveModel(cfg) → ModelSpec（provider-neutral；不把整个 cfg 传给 ModelPort）。
       只负责"决定并发什么"，不负责执行、不负责 retry/fallback 策略。
       format 由 provider-directory.js 唯一真源决定；未知 provider 才回落 openai，
       且以 formatKnown=false / formatSource 如实暴露（不再静默）。 */
    resolveModel(cfg) {
      const resolved = resolveProviderFormat(cfg && cfg.provider);
      return {
        format: resolved.format, formatKnown: resolved.known, formatSource: resolved.source,
        provider: String((cfg && cfg.provider) || ''),
        model: String((cfg && cfg.model) || ''), endpoint: String((cfg && cfg.endpoint) || ''),
        apiKey: String((cfg && cfg.apiKey) || ''),
        id: (cfg && cfg.id != null ? String(cfg.id) : ''),
        maxTokens: (cfg && cfg.maxTokens != null ? cfg.maxTokens : null),
        temperature: (cfg && cfg.temperature != null ? cfg.temperature : null),
        promptCache: cfg && cfg.promptCache, vision: cfg && cfg.vision,
        streaming: (cfg && cfg.streaming !== undefined ? !!cfg.streaming : undefined),
        systemPrompt: String((cfg && cfg.systemPrompt) || '')
      };
    },

    /* ④ resolveTools(cfg) → 能力 / 开关位（只枚举 cfg 上已存在的标志，不发明新逻辑）。 */
    resolveTools(cfg) {
      const tools = [];
      if (cfg && cfg.imageGen) tools.push('imageGen');
      if (cfg && cfg.autoMem) tools.push('autoMemory');
      return tools;
    },

    /* ⑥ observe(raw) → 只提取结构化信号，绝不写入任何东西。 */
    observe(raw) {
      const out = { content: String(raw == null ? '' : raw), json: null, memOps: [] };
      try {
        if (has(window._parseMemOps)) { const p = window._parseMemOps(out.content); out.memOps = (p && p.ops) || []; }
      } catch (e) { /* 观测失败即忽略，不含副作用 */ }
      try {
        if (has(window._activeParsePlanJson)) out.json = window._activeParsePlanJson(out.content);
      } catch (e) { /* 同上 */ }
      return out;
    },

    /* ⑦ persist(result) → v1 为无操作接缝（持久化本阶段不接管）。 */
    persist(result) { return result; },

    /* ModelPort seam：可被 create({modelPort}) 替换。 */
    modelPort: defaultModelPort
  };

  /* ── create(overrides) → 组装一个 runtime 实例（纯函数引用，零副作用） ── */
  function create(overrides) {
    const ports = Object.assign({}, defaultPorts, overrides || {});
    const runtime = {
      ports: ports,
      async resolveAgent(id) { return await ports.resolveAgent(id); },
      async loadContext(agent) { return await ports.loadContext(agent); },
      resolveModel(cfg) { return ports.resolveModel(cfg); },
      resolveTools(cfg) { return ports.resolveTools(cfg); },
      composeMessages(agent, ctx, input) { return ports.composeMessages(agent, ctx, input); },

      /* budget 契约：input.maxTokens（显式）> cfg.maxTokens（角色配置）> null（执行器默认）。
         返回 source 便于触发方/测试判断"这个上限是谁定的"。 */
      resolveBudget(agent, input) {
        const spec = this.resolveModel((agent && agent.cfg) || {});
        const explicit = (input && input.maxTokens != null) ? Number(input.maxTokens) : null;
        if (explicit != null && isFinite(explicit)) return { maxTokens: explicit, source: 'input' };
        if (spec.maxTokens != null && isFinite(Number(spec.maxTokens))) return { maxTokens: Number(spec.maxTokens), source: 'cfg' };
        return { maxTokens: null, source: 'executor-default' };
      },

      /* ⑤ execute(request, {signal,onEvent}) → 经注入的 ModelPort 执行。
         消除了 v1 的 loop.opts 黑盒：Runtime 不再知道 onChunk/onThink/onSearch，
         也不再直接依赖 callApiChatStream/callApiChat。 */
      get modelPort() { return ports.modelPort; },
      async execute(request, options) {
        return await ports.modelPort.run(request, options || {});
      },

      observe(raw) { return ports.observe(raw); },
      persist(result) { return ports.persist(result); },

      /* ── Agent Loop 契约：Trigger → Resolve → Load → Execute → Observe → Persist ──
         只定义流程形状，不做任何副作用（不执行工具 / 不写记忆 / 不落库）。
         纯 opt-in：当前没有任何现有功能调用 run()。 */
      async run(input) {
        const t = input || {};
        const trigger = t.trigger || 'user_message';
        let agent = t.agent || null;
        if (!agent && t.agentId) agent = await this.resolveAgent(t.agentId);
        if (!agent && t.cfg) agent = {
          id: String(t.cfg.id), cfg: t.cfg,
          identity: String(t.cfg.systemPrompt || ''), relationship: String(t.cfg.relationship || ''),
          nickname: t.cfg.nickname || t.cfg.model || 'AI'
        };
        if (!agent) throw new Error('AgentRuntime: run() 需要 agentId 或 agent');
        /* identity 契约：identity 始终等于 systemPrompt（缺失时从 cfg 补），
           避免不同构造路径给出不同的身份。 */
        if (agent.identity == null || agent.identity === '') {
          agent = Object.assign({}, agent, { identity: String((agent.cfg && agent.cfg.systemPrompt) || '') });
        }
        const ctx = await this.loadContext(agent);
        const model = this.resolveModel(agent.cfg);
        const tools = this.resolveTools(agent.cfg);
        const budget = this.resolveBudget(agent, t);
        const composed = this.composeMessages(agent, ctx, t);
        const request = { spec: model, messages: composed.messages, jsonMode: !!t.jsonMode, budget: budget.maxTokens };
        const events = [];
        const outcome = await this.execute(request, { signal: t.signal, onEvent: function (ev) { events.push(ev); } });
        const text = (outcome && outcome.text != null) ? outcome.text : '';
        const observed = this.observe(text);
        const result = { trigger: trigger, agent: agent, ctx: ctx, model: model, tools: tools,
          budget: budget, system: composed.system,
          observed: observed, events: events, text: text,
          usage: (outcome && outcome.usage) || null,
          usageSource: (outcome && outcome.usageSource) || 'unavailable',
          aborted: !!(outcome && outcome.aborted),
          abortMode: (outcome && outcome.abortMode) || 'none',
          error: (outcome && outcome.error) || null };
        return this.persist(result);
      }
    };
    return runtime;
  }

  /* ── 注册到 IB.runtime（增量命名空间；不触碰任何现有导出） ── */
  NS.expose('runtime', {
    create: create,
    defaultPorts: defaultPorts,
    /* 默认 modelPort 也暴露，便于外部构造自定义 port 时参考/复用 */
    defaultModelPort: defaultModelPort,
    /* P11-0：诊断用 format 的唯一实现（Active / Moments / Diary 共用） */
    modelFormat: modelFormat,
    /* 统一迁移诊断：consumer 用 record() 生成白名单记录，再由各自的 logger 输出 */
    telemetry: { build: telemetryBuild, record: telemetryRecord, recent: telemetryRecent, fields: TELEMETRY_FIELDS },
    /* 方便单例：默认端口组装，加载即得，但无任何副作用 */
    instance: create()
  });
})(window.IB || (window.IB = {}));
