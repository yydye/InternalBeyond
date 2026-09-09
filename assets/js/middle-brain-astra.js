/* ====================================================================
   Middle Brain · Astra Transport 层（P11-1A 自 middle-brain.js 物理拆分）
   --------------------------------------------------------------------
   职责（唯一网络边界）：
     1. 请求/响应归一（委托 ib-model-core.js 的 AstraAdapter，含内置回落）
     2. Responses API 参数映射（reasoning.effort / service_tier）
     3. Astra 调用 + 结构化 JSON 解析 + 安全校验（失败一律返回 null）
   不含：配置 UI、本地压缩、Admission Gate、Judge。
   拆分只动位置，不改逻辑。
   P11-1B：本层只读 MBC.config / MBC.policy（上游契约）；对外唯一出口 = MBC.astra（冻结）。
   ==================================================================== */
(function (root) {
  'use strict';
  var MBC = (root.IB = root.IB || {}).__middleBrainContracts || (root.IB.__middleBrainContracts = {});
  var CFG = MBC.config, POL = MBC.policy;   /* contract 依赖：config / policy（DAG 上游，只读） */
  /* 归一：adapter 解析（运行时已加载 ib-model-core.js；缺失则回落内置 openai 归一） */
  function adapter() {
    try { if (root.IBModelCore && root.IBModelCore.AstraAdapter) return root.IBModelCore.AstraAdapter; } catch (e) {}
    return null;
  }

  /* —— 归一请求体（委托 AstraAdapter.buildRequest；返回 {endpoint, headers, body}） ——
     供后续 Middle Brain 接入复用；不在此处发起 fetch（保留独立调用权给中间层）。 */
  async function buildMiddleBrainRequest(spec, prompt, options) {
    var a = adapter();
    var cfg = spec || (await CFG.getMiddleBrainConfig());
    /* Middle Brain 系统提示词：缺省注入引擎内部的认知约束（用户不可修改）；
       调用方若显式传入 system 则尊重之（覆盖），否则使用 config 层的 MB_SYSTEM_PROMPT。 */
    var effPrompt = prompt;
    if (effPrompt && effPrompt.messages !== undefined && !effPrompt.system) {
      effPrompt = { system: CFG.MB_SYSTEM_PROMPT, messages: effPrompt.messages };
    } else if (effPrompt && effPrompt.messages === undefined && Array.isArray(effPrompt)) {
      var hasSys = effPrompt.some(function (m) { return m && m.role === 'system'; });
      if (!hasSys) effPrompt = [{ role: 'system', content: CFG.MB_SYSTEM_PROMPT }].concat(effPrompt);
    }
    if (a && typeof a.buildRequest === 'function') {
      var r = a.buildRequest(cfg, effPrompt, options || {});
      return { endpoint: cfg.endpoint, headers: Object.assign({ 'Content-Type': 'application/json' }, (r.headers || {})), body: r.body };
    }
    /* 回落：内置 openai-兼容归一（无 astra adapter 时也能用） */
    var p = (effPrompt && effPrompt.messages !== undefined ? effPrompt : { system: CFG.MB_SYSTEM_PROMPT, messages: effPrompt || [] });
    var model = cfg.model, ps = (p.system || CFG.MB_SYSTEM_PROMPT), msgs = Array.isArray(p.messages) ? p.messages : [];
    var body = { model: model, messages: [{ role: 'system', content: ps }].concat(msgs), max_tokens: (options && options.maxTokens) || 512 };
    if (options && options.jsonMode) body.response_format = { type: 'json_object' };
    if (cfg.temperature != null) body.temperature = Number(cfg.temperature);
    return { endpoint: cfg.endpoint, headers: { 'Content-Type': 'application/json' }, body: body };
  }

  /* —— 归一响应（委托 AstraAdapter.parseResponse → {content, reasoning, truncated, usage}） —— */
  async function parseMiddleBrainResponse(wire, spec, options) {
    var a = adapter();
    var cfg = spec || (await CFG.getMiddleBrainConfig());
    if (a && typeof a.parseResponse === 'function') {
      return a.parseResponse(wire, cfg, options || {});
    }
    /* 回落：内置 openai-兼容解析 */
    var choice = (wire && wire.choices && wire.choices[0]) || {};
    var message = choice.message || {};
    var out = { content: message.content == null ? '' : message.content, reasoning: message.reasoning_content || message.reasoning || '', truncated: choice.finish_reason === 'length', usage: wire && wire.usage ? wire.usage : null };
    return out;
  }

  /* —— OpenAI Responses API · Middle Brain 专用 request builder ——
     委托 AstraAdapter.buildResponsesRequest（绝不发 Chat Completions 旧参数）。
     Phase 4：统一读取 middle_brain 配置的 reasoningEffort / speed，normalize 后映射到官方参数：
       reasoningEffort → reasoning.effort（官方）；speed:'fast' → service_tier:'fast'（官方）。
       speed:'standard'（默认）→ 不发送 service_tier（官方无 "standard" 值）。
     绝不用 temperature / top_p / logprobs / reasoning_effort。 */
  async function buildMiddleBrainResponsesRequest(spec, prompt, options) {
    var a = adapter();
    var cfg = spec || (await CFG.getMiddleBrainConfig());
    options = options || {};
    /* Phase 4：从配置归一推理强度/速度（显式 options 覆盖 > 配置 > 默认）。 */
    var effort = CFG.normalizeMiddleBrainReasoningEffort(options.reasoningEffort != null ? options.reasoningEffort : cfg.reasoningEffort);
    var speed = CFG.normalizeMiddleBrainSpeed(options.speed != null ? options.speed : cfg.speed);
    var reqOptions = Object.assign({}, options, { reasoningEffort: effort });
    if (a && typeof a.buildResponsesRequest === 'function') {
      var r = a.buildResponsesRequest(cfg, prompt, reqOptions);
      var body = r.body || {};
      /* speed:fast → 官方 service_tier:"fast"；standard → 不发送（默认档）。 */
      if (speed === 'fast') body.service_tier = 'fast';
      return { endpoint: cfg.endpoint || r.endpoint, headers: Object.assign({ 'Content-Type': 'application/json' }, (r.headers || {})), body: body, reasoningEffort: effort, speed: speed };
    }
    /* 回落：无 Responses API adapter → 走旧 openai-compat（保可用性，聊天不破）。
       Chat Completions 用 max_tokens / temperature，无 service_tier；仍可带 reasoning.effort。 */
    return await buildMiddleBrainRequest(cfg, prompt, reqOptions);
  }

  /* —— OpenAI Responses API · Middle Brain 专用 parser（委托 AstraAdapter）—— */
  async function parseMiddleBrainResponsesResponse(wire, spec) {
    var a = adapter();
    var cfg = spec || (await CFG.getMiddleBrainConfig());
    if (a && typeof a.parseResponsesResponse === 'function') {
      return a.parseResponsesResponse(wire, cfg, {});
    }
    /* 回落：Chat Completions 解析（保可用性） */
    return await parseMiddleBrainResponse(wire, cfg, {});
  }

  /* —— 统一模型调用（P11-2）———————————————————————————————————————————
     本层是 Middle Brain 的**唯一网络边界**：任何需要"额外一次模型调用"的层
     （judge / integrity）都必须走这里，不得各自实现 HTTP / 鉴权 / SSE / parser。
     复用 buildMiddleBrainResponsesRequest（含 AstraAdapter 归一与 Chat Completions 回落）
     + root._ibApiPost 传输（Bridge-aware）。
     失败不抛异常：返回 {ok:false, error:'not_ready'|'request'|'timeout'|'network'|'http'|'parse'|'empty'|'error'}，
     供调用方做 telemetry 分类与安全 fallback（绝不重试）。
     opts: {maxTokens, jsonMode, schema, schemaName, timeoutMs} */
  async function middleBrainModelCall(prompt, opts) {
    opts = opts || {};
    try {
      if (!(await CFG.middleBrainReady())) return { ok: false, error: 'not_ready' };
      var cfg = await CFG.getMiddleBrainConfig();
      var req = await buildMiddleBrainResponsesRequest(null, prompt, { maxTokens: opts.maxTokens || 900, jsonMode: opts.jsonMode !== false });
      if (!req || !req.body) return { ok: false, error: 'request' };
      /* 结构化输出 schema 覆盖：仅 Responses 风格 body 才有 text.format（Chat Completions 回落不加此字段） */
      if (opts.schema && req.body.messages === undefined) {
        req.body.text = { format: { type: 'json_schema', name: opts.schemaName || 'middle_brain_report', schema: opts.schema } };
      }
      if (cfg.endpoint) req.endpoint = cfg.endpoint;
      var ac = new AbortController();
      var timedOut = false;
      var tm = setTimeout(function () { timedOut = true; ac.abort(); }, (opts.timeoutMs != null ? Number(opts.timeoutMs) : MB_ASTRA_TIMEOUT_MS));
      var res;
      try {
        if (typeof root._ibApiPost === 'function') {
          res = await root._ibApiPost(req.endpoint, Object.assign({}, req.headers, { Authorization: 'Bearer ' + (cfg.apiKey || '') }), JSON.stringify(req.body), { signal: ac.signal });
        } else {
          res = await fetch(req.endpoint, {
            method: 'POST',
            headers: Object.assign({}, req.headers, { Authorization: 'Bearer ' + (cfg.apiKey || '') }),
            body: JSON.stringify(req.body),
            signal: ac.signal
          });
        }
      } catch (e) { clearTimeout(tm); return { ok: false, error: timedOut ? 'timeout' : 'network' }; }
      clearTimeout(tm);
      if (!res || !res.ok) return { ok: false, error: 'http' };
      var data = await res.json().catch(function () { return null; });
      if (!data) return { ok: false, error: 'parse' };
      var parsed = null;
      try { var _a = adapter(); if (_a && typeof _a.parseResponsesResponse === 'function') parsed = _a.parseResponsesResponse(data, null, {}); } catch (e) { parsed = null; }
      if (!parsed) parsed = { content: '', reasoning: '', truncated: false, usage: null };
      if (!parsed.content) return { ok: false, error: 'empty' };
      return { ok: true, content: String(parsed.content), usage: parsed.usage || null };
    } catch (e) { return { ok: false, error: 'error' }; }
  }

  /* ====================================================================
     Middle Brain v0 · Astra 认知协调接入（Context Organization + Compression）
     --------------------------------------------------------------------
     - Astra 只读"已组织好的 Context"（organized），判断相关性/优先级/去重合并，
       生成 structured 结果 + compressedContext。Astra 不是角色模型、不是新 Memory。
     - Astra 不得新增/修改/删除 Memory / Understanding / Thread / Diary / Moments；
       不得改变事实含义、不得把推测变成事实；当前 userMessage/最近 dialogue 必须保留；
       不生成角色回复、不改角色人格文风。
     - Astra 不可用/超时/报错 → 自动 fallback 到本地 pipeline（middleBrainContextPipeline），
       绝不影响正常角色聊天。
     - 结构化输出至少区分 keep / merge / drop / compressedContext，并可追溯到输入。
     ==================================================================== */
  var MB_ASTRA_TIMEOUT_MS = 20000;

  /* 解析 Astra 返回的 JSON 认知结果（Astra 只输出结构化 JSON，不生成角色回复）。
     仅接受白名单字段；任何异常/非 JSON → null（上层走 fallback）。 */
  function _mbParseAstraJson(text) {
    try {
      var s = String(text || '').trim();
      var fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i); if (fence && fence[1]) s = fence[1].trim();
      var start = s.indexOf('{'), end = s.lastIndexOf('}');
      if (start < 0 || end <= start) return null;
      var obj = JSON.parse(s.slice(start, end + 1));
      if (!obj || typeof obj !== 'object') return null;
      return {
        keep: Array.isArray(obj.keep) ? obj.keep.map(String).filter(Boolean).slice(0, 200) : [],
        merge: Array.isArray(obj.merge) ? obj.merge : [],
        drop: Array.isArray(obj.drop) ? obj.drop.map(String).filter(Boolean).slice(0, 200) : [],
        compressedContext: String(obj.compressedContext || '').trim(),
        currentKept: !!(obj.currentKept !== false)
      };
    } catch (e) { return null; }
  }

  /* Astra 结果安全校验：不得把"不确定"变成确定；必须保留当前 userMessage；
     不得生成角色回复（compressedContext 只能是整理后结果，非一段角色台词）。
     违规即返回 null（上层 fallback）。 */
  function _mbValidateAstraResult(result, organized) {
    if (!result) return null;
    if (!result.compressedContext) return null;
    var currentDialogue = organized && organized.dialogue ? organized.dialogue : [];
    /* 当前对话必须保留：Astra 显式 currentKept=false，或文本里不含任何一条当前对话 → 拒绝（走 fallback）。 */
    if (currentDialogue.length && result.currentKept === false) return null;
    if (currentDialogue.length) {
      var hasAny = currentDialogue.some(function (dl) { return String(dl || '') && result.compressedContext.indexOf(String(dl)) >= 0; });
      if (!hasAny) return null;
    }
    return result;
  }

  /* 真正的 Astra 调用：组织上下文 → 构建请求 → 拉取 → 解析 → 安全校验。
     任何失败（超时/网络/非 JSON/未启用/未配置/校验不过）→ 返回 null。 */
  async function middleBrainAstraInvoke(characterId, userMessage, opts) {
    opts = opts || {};
    try {
      if (!(await CFG.middleBrainReady())) return null;
      var organized = await POL.middleBrainOrganizeContext(characterId, userMessage, opts);
      var hasAnything = organized.memory.length || organized.understanding.length || organized.threads.length || organized.moments.length || (organized.dialogue && organized.dialogue.length);
      if (!hasAnything) return { structured: organized, compressedContext: '', stats: { empty: true }, source: 'astra', keep: [], merge: [], drop: [] };

      /* 组织上下文文本 + 当前对话（Astra 判断相关性/优先级/去重合并） */
      var ctxBlocks = [];
      if (organized.memory.length) ctxBlocks.push('【Memory】' + organized.memory.join('\n'));
      if (organized.understanding.length) ctxBlocks.push('【Understanding】' + organized.understanding.join('\n'));
      if (organized.threads.length) ctxBlocks.push('【Thread】' + organized.threads.join('\n'));
      if (organized.moments.length) ctxBlocks.push('【Moments】' + organized.moments.join('\n'));
      ctxBlocks.push('【当前对话】' + ((organized.dialogue && organized.dialogue.join('\n')) || userMessage || ''));

      var userPrompt = '下面是组织好的 IB 上下文，请你作为认知协调层完成 Context Organization + Compression。\n'
        + '只做相关性判断、优先级、去重/合并，输出压缩后的 compressedContext（供下层角色模型读）。\n'
        + '要求：1) 绝不改变事实含义；无法确认的信息保持"可能/未确定"。2) 当前【当前对话】必须完整保留（currentKept:true）。3) 不要生成角色回复、不要改写角色人格文风。\n'
        + '只输出 JSON：{"keep":["保留条目..."],"merge":[{"from":"条目","into":"条目"}],"drop":["应删条目..."],"compressedContext":"合并整理后的精简上下文（含必要的事实、关系、状态、未完成线索；当前对话完整）","currentKept":true}\n'
        + '【上下文】\n' + ctxBlocks.join('\n\n');
      var messages = [{ role: 'user', content: userPrompt }];
      var cfg = await CFG.getMiddleBrainConfig();
      /* Responses API 请求：优先 buildResponsesRequest；失败回落 Chat Completions（保聊天不破）。 */
      var req = await buildMiddleBrainResponsesRequest(null, messages, { maxTokens: 1600, jsonMode: true });
      /* 若用户自定义了 endpoint 且非 responses 路径，仍尊重用户配置（不硬编码覆盖） */
      if (req && cfg.endpoint) req.endpoint = cfg.endpoint;

      var ac = new AbortController();
      var tm = setTimeout(function () { ac.abort(); }, (opts.timeoutMs != null ? Number(opts.timeoutMs) : MB_ASTRA_TIMEOUT_MS));
      /* 复用现有传输（Bridge-aware CORS 处理，file:// 也能直连 mock/远端）；无则回落 raw fetch */
      var res;
      if (typeof root._ibApiPost === 'function') {
        res = await root._ibApiPost(req.endpoint, Object.assign({}, req.headers, { Authorization: 'Bearer ' + (cfg.apiKey || '') }), JSON.stringify(req.body), { signal: ac.signal });
      } else {
        res = await fetch(req.endpoint, {
          method: 'POST',
          headers: Object.assign({}, req.headers, { Authorization: 'Bearer ' + (cfg.apiKey || '') }),
          body: JSON.stringify(req.body),
          signal: ac.signal
        });
      }
      clearTimeout(tm);
      if (!res.ok) return null;
      var data = await res.json().catch(function () { return null; });
      if (!data) return null;
      /* Responses API 解析：优先 output_text / output[].content[].text；不假设 choices。
         委托 AstraAdapter.parseResponsesResponse；任何异常 → 本地兜底解析为 {}（走 fallback）。 */
      var parsed = null;
      try {
        var _a = adapter();
        if (_a && typeof _a.parseResponsesResponse === 'function') parsed = _a.parseResponsesResponse(data, null, {});
      } catch (e) { parsed = null; }
      if (!parsed) parsed = { content: '', reasoning: '', truncated: false, usage: null };
      if (!parsed.content) return null;
      var result = _mbParseAstraJson(parsed.content);
      if (!result) return null;
      result = _mbValidateAstraResult(result, organized);
      if (!result) return null;
      /* 结构化：keep/merge/drop + compressedContext + 可追溯来源 */
      return {
        structured: organized,
        compressedContext: result.compressedContext,
        keep: result.keep, merge: result.merge, drop: result.drop,
        stats: { categories: (organized.memory.length ? 1 : 0) + (organized.understanding.length ? 1 : 0) + (organized.threads.length ? 1 : 0) + (organized.moments.length ? 1 : 0), source: 'astra' },
        source: 'astra'
      };
    } catch (e) { return null; }   /* 超时/网络/校验失败 → fallback */
  }

  /* —— layer contract（P11-1B）：astra 层唯一出口，冻结后下游只读 —— */
  MBC.astra = Object.freeze({
    /* 请求 / 响应归一 */
    buildMiddleBrainRequest: buildMiddleBrainRequest,
    buildMiddleBrainResponsesRequest: buildMiddleBrainResponsesRequest,
    parseMiddleBrainResponsesResponse: parseMiddleBrainResponsesResponse,
    parseMiddleBrainResponse: parseMiddleBrainResponse,
    /* 统一模型调用（judge / integrity 共用；唯一网络边界） */
    middleBrainModelCall: middleBrainModelCall,
    /* Astra 调用 + 结构化解析 */
    middleBrainAstraInvoke: middleBrainAstraInvoke,
    _mbParseAstraJson: _mbParseAstraJson,
    MB_ASTRA_TIMEOUT_MS: MB_ASTRA_TIMEOUT_MS,
    /* judge 复用（Responses 解析器） */
    adapter: adapter
  });
})(typeof self !== 'undefined' ? self : globalThis);
