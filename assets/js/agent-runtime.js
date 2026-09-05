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

  /* ══ 默认 ModelPort：Adapter over 现有 callApiChatStream/callApiChat ══
     绝不复制 provider 请求 / SSE 解析 / retry 逻辑——只做 参数与事件 的双向转换。 */
  const defaultModelPort = {
    async run(request, options) {
      options = options || {};
      const onEvent = options.onEvent || function () {};
      const spec = (request && request.spec) || {};
      const messages = (request && request.messages) || [];
      const jsonMode = !!(request && request.jsonMode);
      /* 从 ModelSpec 还原执行器需要的最小 cfg 形态（≠ 整个 cfg） */
      const cfg = {
        id: spec.id, provider: spec.provider, model: spec.model, endpoint: spec.endpoint,
        apiKey: spec.apiKey, temperature: spec.temperature, promptCache: spec.promptCache,
        vision: spec.vision, systemPrompt: spec.systemPrompt, streaming: spec.streaming
      };
      /* abort bridge：外部 AbortSignal → 执行器可接受的 AbortController */
      const ac = new AbortController();
      if (options.signal) {
        try {
          if (options.signal.aborted) ac.abort();
          else options.signal.addEventListener('abort', function () { ac.abort(); }, { once: true });
        } catch (e) { /* signal 桥接失败不影响执行 */ }
      }
      const emit = function (ev) { try { onEvent(ev); } catch (e) { /* sink 异常忽略 */ } };
      const searchLog = [];
      const result = { reasoning_content: '', truncated: false };
      try {
        const callOpts = {
          onChunk: function (t) { emit({ type: 'text_delta', text: t }); },
          onThink: function (t) { emit({ type: 'reasoning_delta', text: t }); },
          onSearch: function (ev) { emit({ type: 'search', phase: ev && ev.phase, query: ev && ev.query, results: ev && ev.results }); },
          searchLog: searchLog,
          result: result,
          abortController: ac,
          autoContinue: false,       /* 单次执行；autoContinue 留在现有执行器/触发方 */
          disableTools: true,        /* ModelPort 不参与工具轮 */
          jsonMode: jsonMode,
          _noWebSearch: true,
          wantMeta: true
        };
        let text;
        if (spec.streaming !== false && has(window.callApiChatStream)) {
          text = await window.callApiChatStream(cfg, messages, callOpts);
        } else if (has(window.callApiChat)) {
          const r = await window.callApiChat(cfg, messages, callOpts);
          text = (r && r.text != null) ? r.text : r;
        } else {
          throw new Error('ModelPort: 无可用的模型执行器（callApiChatStream/callApiChat）');
        }
        const reasoning = (result && result.reasoning_content) || '';
        const truncated = !!(result && result.truncated);
        emit({ type: 'done', truncated: truncated, reasoning: reasoning, usage: null });
        return { text: text, reasoning: reasoning, truncated: truncated, usage: null };
      } catch (e) {
        const mapped = _mapModelError(e);
        emit({ type: 'error', kind: mapped.kind, message: mapped.message, status: mapped.status });
        return { text: '', error: mapped };
      }
    }
  };

  /* 最小错误映射：把现有抛错转成 {kind,message,status}，不做 error hierarchy，message 原样透传。 */
  function _mapModelError(e) {
    const name = String((e && e.name) || '');
    const msg = String((e && e.message) || (e ? String(e) : 'unknown'));
    let kind = 'unknown', status;
    if (name === 'AbortError' || /已停止|abort/i.test(msg)) kind = 'abort';
    else if (/超时|timeout/i.test(msg)) kind = 'timeout';
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

    /* ② loadContext(agent) → 世界 / 身份 / 状态 / 记忆上下文（委托现有 _momentsContext）。 */
    async loadContext(agent) {
      const fx = (NS.moments && has(NS.moments._momentsContext))
        ? NS.moments._momentsContext
        : (has(window._momentsContext) ? window._momentsContext : null);
      if (!fx) {
        return { user: { name: '用户' }, character: (agent && agent.cfg) || null,
          recentMessages: [], memories: [], recentProactiveMessages: [],
          chatSummary: '', recentMoments: [], otherRoleMoments: [], lastInteractionAt: 0 };
      }
      return await fx(agent.cfg);
    },

    /* ③ resolveModel(cfg) → ModelSpec（provider-neutral；不把整个 cfg 传给 ModelPort）。
       只负责"决定并发什么"，不负责执行、不负责 retry/fallback 策略。 */
    resolveModel(cfg) {
      /* 优先用 runtime-neutral shared core；window.PROVIDERS 仅作兼容别名/回退 */
      const fmt = (has(window.IBModelCore) && has(window.IBModelCore.providerFormat))
        ? window.IBModelCore.providerFormat(cfg.provider)
        : ((has(window.PROVIDERS) && window.PROVIDERS[cfg.provider] && window.PROVIDERS[cfg.provider].format) || 'openai');
      return {
        format: fmt, provider: String(cfg.provider || ''),
        model: String(cfg.model || ''), endpoint: String(cfg.endpoint || ''),
        apiKey: String(cfg.apiKey || ''),
        maxTokens: (cfg.maxTokens != null ? cfg.maxTokens : null),
        temperature: (cfg.temperature != null ? cfg.temperature : null),
        promptCache: cfg.promptCache, vision: cfg.vision,
        streaming: (cfg.streaming !== undefined ? !!cfg.streaming : undefined),
        systemPrompt: String(cfg.systemPrompt || '')
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
        const ctx = await this.loadContext(agent);
        const model = this.resolveModel(agent.cfg);
        const tools = this.resolveTools(agent.cfg);
        const request = { spec: model, messages: t.messages || [], jsonMode: !!t.jsonMode };
        const events = [];
        const outcome = await this.execute(request, { signal: t.signal, onEvent: function (ev) { events.push(ev); } });
        const text = (outcome && outcome.text != null) ? outcome.text : '';
        const observed = this.observe(text);
        const result = { trigger: trigger, agent: agent, ctx: ctx, model: model, tools: tools,
          observed: observed, events: events, text: text, error: (outcome && outcome.error) || null };
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
    /* 方便单例：默认端口组装，加载即得，但无任何副作用 */
    instance: create()
  });
})(window.IB || (window.IB = {}));
