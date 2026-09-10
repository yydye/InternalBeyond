/* ====================================================================
   IB Model Core — runtime-neutral provider core (UMD dual-load)
   --------------------------------------------------------------------
   - Browser: <script src="assets/js/ib-model-core.js"> → window.IBModelCore
   - Node   : require('../assets/js/ib-model-core.js')
   - 规则：零 window / 零 DOM / 零 fetch / 零 window.IB / 零 Proactive 依赖 / 纯函数优先。
   - 逐行为提取自 browser social.js(提供者目录) 与 active/model-client.js
     (adaptMessageParts/geminiParts + anthropic/gemini/openai request/response)。
   - 结构参考仓库已有 UMD 共享模块 reply-chain-core.js。
   ==================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(require('./provider-directory.js')); }
  else { root.IBModelCore = factory(root.PROVIDERS_DIR || {}); }
})(typeof self !== 'undefined' ? self : this, function (CANON) {
  'use strict';

  /* 提供者目录：唯一 canonical 数据源为 assets/js/provider-directory.js。
     此处不再维护第二份 provider metadata 字面量；
     Node 下由上方 require 传入，browser 下由 window.PROVIDERS_DIR 传入。 */
  var PROVIDERS = (CANON && CANON.PROVIDERS) || {};

  /* provider → wire format（model-client 分支保持一致：anthropic/gemini/else-openai）
     P11-0：唯一 canonical 决策在 provider-directory.js。
       Node    —— CANON = require('./provider-directory.js')
       Browser —— CANON = window.PROVIDERS_DIR
     宿主只传了裸 PROVIDERS 表（无 providerFormat）时保留原表达式，行为逐位不变。 */
  function providerFormat(provider) {
    if (CANON && typeof CANON.providerFormat === 'function') return CANON.providerFormat(provider);
    return (PROVIDERS[provider] && PROVIDERS[provider].format) || 'openai';
  }
  /* canonical 结构化决策（供 agent-runtime 等读取 known/hasFormat）。 */
  function resolveProviderFormat(provider) {
    if (CANON && typeof CANON.resolveProviderFormat === 'function') return CANON.resolveProviderFormat(provider);
    var entry = (provider == null ? null : PROVIDERS[provider]) || null;
    if (entry) { var fmt = String(entry.format || ''); return { format: fmt || 'openai', known: true, hasFormat: !!fmt }; }
    return { format: 'openai', known: false, hasFormat: false };
  }

  /* P18 · model policy：该 model 是否接受 temperature / top_p / top_k。
     唯一判定在 provider-directory.js（MODEL_POLICIES）；宿主只传了裸 PROVIDERS 表
     （无该函数）时返回 true = 照发，与 P18 之前逐位一致。 */
  function modelSupportsSamplingParameters(model) {
    if (CANON && typeof CANON.modelSupportsSamplingParameters === 'function') {
      return CANON.modelSupportsSamplingParameters(model) !== false;
    }
    return true;
  }

  /* P19 · model policy：该 model 是否接受「最后一条 assistant 消息作为 seed」
     （assistant prefill）。唯一判定仍在 provider-directory.js（MODEL_POLICIES），
     与 sampling 共用同一个 canonical lookup；宿主没有该函数时返回 true =
     保留历史行为（未知 model 绝不擅自改变请求语义）。 */
  function modelSupportsAssistantPrefill(model) {
    if (CANON && typeof CANON.modelSupportsAssistantPrefill === 'function') {
      return CANON.modelSupportsAssistantPrefill(model) !== false;
    }
    return true;
  }

  /* ── P19 · 结构化输出意图（intent）vs 传输实现（transport）────────────────
     调用方只表达「本次请求需要结构化 JSON」（options.jsonMode）。实现方式由
     model policy 决定：
       A. 支持 assistant prefill 的 model → 追加 seed assistant 消息（历史行为）
       B. 不支持的 model（Claude 4.6+）→ 不追加 seed，改为等价的 prompt 约束
     旧的 options.jsonPrefill 仍然被接受，但它只是 A 方案的 seed 文本，
     不再等同于「要 JSON」这个业务语义。 */
  var JSON_ONLY_CONSTRAINT = 'Return exactly one valid JSON object. The first non-whitespace character must be { and the final non-whitespace character must be }. Do not use Markdown code fences. Do not include commentary before or after the JSON.';
  /* 等价 JSON-only 指令的识别标记：命中即认为请求已自带约束（复用，不再插第二份）。
     含本实现自己的标记（保证 rebuild / retry 幂等）与 IB 现有 consumer 的措辞。 */
  var JSON_ONLY_MARKS = [
    'Return exactly one valid JSON object.',
    '只输出一个 JSON',
    '只返回一个 JSON',
    '仅输出一个 JSON',
    '输出严格 JSON'
  ];

  function _contentTextOf(content) {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return content == null ? '' : String(content);
    return content.map(function (p) { return (p && typeof p.text === 'string') ? p.text : ''; }).join('\n');
  }
  function _hasJsonOnlyInstruction(system, messages) {
    var hay = String(system || '');
    for (var i = 0; i < messages.length; i++) hay += '\n' + _contentTextOf(messages[i] && messages[i].content);
    for (var j = 0; j < JSON_ONLY_MARKS.length; j++) { if (hay.indexOf(JSON_ONLY_MARKS[j]) !== -1) return true; }
    return false;
  }
  /* 把 JSON 意图写进最后一条 user 消息（无 user 消息时追加一条）。
     纯函数：不改入参数组 / 不重复注入（同一约束已存在时原样返回）。 */
  function _appendJsonOnlyConstraint(system, messages) {
    var list = Array.isArray(messages) ? messages : [];
    if (_hasJsonOnlyInstruction(system, list)) return list;
    var idx = -1;
    for (var i = list.length - 1; i >= 0; i--) { if (list[i] && list[i].role === 'user') { idx = i; break; } }
    if (idx < 0) return list.concat([{ role: 'user', content: JSON_ONLY_CONSTRAINT }]);
    var msg = list[idx];
    var content = msg.content;
    var next = list.slice();
    if (typeof content === 'string') {
      next[idx] = { role: msg.role, content: content ? (content + '\n\n' + JSON_ONLY_CONSTRAINT) : JSON_ONLY_CONSTRAINT };
    } else if (Array.isArray(content)) {
      next[idx] = { role: msg.role, content: content.concat([{ type: 'text', text: JSON_ONLY_CONSTRAINT }]) };
    } else {
      next[idx] = { role: msg.role, content: JSON_ONLY_CONSTRAINT };
    }
    return next;
  }

  /* 内容 part 适配（提取自 active/model-client.js adaptMessageParts） */
  function adaptMessageParts(fmt, content) {
    if (typeof content === 'string' || !Array.isArray(content)) return content;
    return content.map(function (p) {
      if (p && p.type === '_image' && p.base64) {
        if (fmt === 'anthropic') return { type: 'image', source: { type: 'base64', media_type: p.mime || 'image/jpeg', data: p.base64 } };
        if (fmt === 'gemini') return { inlineData: { mimeType: p.mime || 'image/jpeg', data: p.base64 } };
        return { type: 'image_url', image_url: { url: 'data:' + (p.mime || 'image/jpeg') + ';base64,' + p.base64 } };
      }
      return { type: 'text', text: String((p && p.text) || '') };
    });
  }
  /* gemini content → parts（提取自 model-client.js geminiParts） */
  function geminiParts(content) {
    if (typeof content === 'string') return [{ text: content }];
    if (!Array.isArray(content)) return [{ text: String(content || '') }];
    return adaptMessageParts('gemini', content);
  }

  /* 归一 prompt -> {system, messages}
     Node 形态: {system, messages}；Browser 形态: 纯 messages 数组（system 取 spec.systemPrompt 或首条 system 消息） */
  function _prompt(prompt, spec) {
    if (prompt && prompt.messages && (prompt.system !== undefined || Array.isArray(prompt.messages))) {
      return { system: prompt.system || '', messages: prompt.messages };
    }
    if (Array.isArray(prompt)) {
      var sys = (spec && spec.systemPrompt) ? String(spec.systemPrompt) : '';
      var msgs = [];
      for (var i = 0; i < prompt.length; i++) {
        if (prompt[i] && prompt[i].role === 'system') { if (!sys) sys = String(prompt[i].content || ''); }
        else msgs.push(prompt[i]);
      }
      return { system: sys, messages: msgs };
    }
    return { system: '', messages: [] };
  }

  /* ── P20 · canonical prompt → Anthropic wire 归一（Browser / Node 唯一真源）──────
     IB canonical 输入**允许**出现 system 消息。consumer 的常见形态是「顶层 system 与
     messages 首条 system 同时给同一段文本」，例如：
       { system: '角色设定', messages: [{role:'system',content:'角色设定'},{role:'user',content:'你好'}] }
     这是合法的 IB 内部表示；**provider adapter 负责**把它转成各家的 wire format，
     不能靠"禁止 consumer 产生 system"来解决。

     Anthropic 的 messages 只接受 user / assistant，system 必须放在顶层 system 字段。
     本函数是这条归一的唯一实现（浏览器经 window.IBModelCore 调用同一函数，Node 由
     buildRequestBody 调用同一函数）——禁止在别处复制第二份。

     规则（Browser / Node 逐位一致）：
       ① 候选文本顺序 = 顶层 system（{system,messages} 形态）→ 随后按出现顺序的 messages system；
       ② 完全相同（忽略首尾空白）的文本只保留一次 —— consumer 普遍把同一段 system 同时放进
          两处，去重后与 P20 之前的浏览器语义逐位相同，不会把角色设定送两遍；
       ③ 不同文本用 '\n\n' 连接（稳定分隔符，绝不 join('')）；顺序稳定，多条 system 不丢；
       ④ 都没解析到时回落到 spec.systemPrompt（与 _prompt 的数组形态一致）；
       ⑤ messages 只保留非 system 项（逐条浅拷贝，**绝不改动入参对象**）；
       ⑥ 无法映射的 role **不静默删除**（保留原样，由 provider 判定并报错），
          只记入 unmappedRoles 供诊断使用。
     返回 {system, messages, systemParts, unmappedRoles, extractedSystems}。 */
  var ANTHROPIC_SYSTEM_SEPARATOR = '\n\n';

  /* system content → 文本。canonical 契约里 system 是 string；此处对 block 数组 /
     {text} 形态做最小安全兼容，**绝不用 String(content)**（否则会变 [object Object]）。 */
  function _systemText(content) {
    if (content == null) return '';
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      var texts = [];
      for (var i = 0; i < content.length; i++) {
        var p = content[i];
        if (typeof p === 'string') { if (p) texts.push(p); }
        else if (p && typeof p.text === 'string') { if (p.text) texts.push(p.text); }
      }
      return texts.join('\n');
    }
    if (typeof content === 'object' && typeof content.text === 'string') return content.text;
    return '';
  }

  function normalizeAnthropicMessages(prompt, spec) {
    var raw = [];
    var base = '';
    if (prompt && prompt.messages && (prompt.system !== undefined || Array.isArray(prompt.messages))) {
      base = _systemText(prompt.system);
      raw = Array.isArray(prompt.messages) ? prompt.messages : [];
    } else if (Array.isArray(prompt)) {
      raw = prompt;
    }
    if (!base) base = _systemText(spec && spec.systemPrompt);

    var parts = [], seen = {};
    function _collect(text) {
      if (!text) return;
      var key = String(text).replace(/^\s+/, '').replace(/\s+$/, '');
      if (!key || seen[key]) return;
      seen[key] = true;
      parts.push(text);
    }
    _collect(base);

    var messages = [], unmapped = [], extracted = 0;
    for (var j = 0; j < raw.length; j++) {
      var m = raw[j];
      if (!m || typeof m !== 'object') continue;
      if (m.role === 'system') { extracted++; _collect(_systemText(m.content)); continue; }
      messages.push(Object.assign({}, m));   /* 浅拷贝：调用方数组与其元素对象都不被改动 */
      if (m.role !== 'user' && m.role !== 'assistant') {
        var label = String(m.role);
        if (unmapped.indexOf(label) < 0) unmapped.push(label);
      }
    }
    return {
      system: parts.join(ANTHROPIC_SYSTEM_SEPARATOR),
      messages: messages,
      systemParts: parts,
      unmappedRoles: unmapped,
      extractedSystems: extracted
    };
  }

  /* P20 · Anthropic wire invariant 诊断（纯函数，不抛错）：
     messages 必须是数组、不得残留 system（developer 同样非法）、model 必须存在、
     system 只能是 string 或 block 数组。用于测试与诊断 seam；
     生产路径**不**据此抛错（IB 没有 body 级 fail-fast 契约，不能为一个诊断断言炸掉用户请求）。 */
  function validateAnthropicRequestBody(body) {
    if (!body || typeof body !== 'object') return { ok: false, problems: ['body-not-object'] };
    var problems = [];
    var list = body.messages;
    if (!Array.isArray(list)) problems.push('messages-not-array');
    else {
      for (var i = 0; i < list.length; i++) {
        var role = list[i] && list[i].role;
        if (role === 'system' || role === 'developer') problems.push('system-role-in-messages');
        else if (role !== 'user' && role !== 'assistant') problems.push('unmapped-role:' + String(role));
      }
    }
    if (body.model === undefined || body.model === null || body.model === '') problems.push('missing-model');
    if (body.system !== undefined && typeof body.system !== 'string' && !Array.isArray(body.system)) problems.push('system-not-string');
    return { ok: problems.length === 0, problems: problems };
  }

  /* 构建 provider-specific request body（纯；transport 的 endpoint/headers 由调用方处理）
     spec: {provider, model, format?, temperature?, systemPrompt?}
     prompt: {system, messages} | messages[]
     options: {jsonMode, jsonPrefill, maxTokens, temperature?} */
  function buildRequestBody(spec, prompt, options) {
    options = options || {};
    var fmt = (spec && (spec.format || providerFormat(spec.provider))) || 'openai';
    var model = spec && spec.model;
    var maxTokens = (options.maxTokens != null ? options.maxTokens : 512);
    var temperature = (options.temperature != null) ? options.temperature : (spec && spec.temperature != null ? spec.temperature : null);
    var pres = _prompt(prompt, spec);
    var system = pres.system, messages = pres.messages;

    if (fmt === 'anthropic') {
      /* P20：system/messages 归一走唯一真源 normalizeAnthropicMessages（Browser 同一函数）。
         buildRequestBody 只负责把归一后的 canonical messages 适配成 Anthropic content blocks。 */
      var an = normalizeAnthropicMessages(prompt, spec);
      var ab = {
        model: model,
        max_tokens: maxTokens,
        system: an.system,
        messages: an.messages.map(function (m) { return { role: m.role, content: adaptMessageParts('anthropic', m.content) }; })
      };
      if (options.jsonMode) {
        if (modelSupportsAssistantPrefill(model)) {
          var jp = options.jsonPrefill || '{"action":';
          ab.messages = ab.messages.concat([{ role: 'assistant', content: jp }]);
        } else {
          ab.messages = _appendJsonOnlyConstraint(ab.system, ab.messages);
        }
      }
      if (temperature != null && modelSupportsSamplingParameters(model)) ab.temperature = Number(temperature);
      return ab;
    }
    if (fmt === 'gemini') {
      var gb = {
        system_instruction: { parts: [{ text: system }] },
        contents: messages.map(function (m) { return { role: m.role === 'assistant' ? 'model' : 'user', parts: geminiParts(m.content) }; }),
        generationConfig: { maxOutputTokens: maxTokens }
      };
      if (options.jsonMode) gb.generationConfig.responseMimeType = 'application/json';
      if (temperature != null) gb.generationConfig.temperature = Number(temperature);
      return gb;
    }
    /* openai 系（兼容 custom/其余全部） */
    var baseMessages = [{ role: 'system', content: system }].concat(messages.map(function (m) { return { role: m.role, content: adaptMessageParts('openai', m.content) }; }));
    var ob = { model: model, messages: baseMessages, max_tokens: maxTokens };
    if (options.jsonMode) ob.response_format = { type: 'json_object' };
    if (temperature != null) ob.temperature = Number(temperature);
    return ob;
  }

  /* 解析 provider-specific response → {content, reasoning, truncated, usage}
     spec: {provider, format?} */
  function parseResponse(wire, spec, options) {
    options = options || {};
    var fmt = (spec && (spec.format || providerFormat(spec.provider))) || 'openai';
    var out = { content: '', reasoning: '', truncated: false, usage: null };
    if (!wire) return out;

    if (fmt === 'anthropic') {
      var blocks = Array.isArray(wire.content) ? wire.content : [];
      out.content = blocks.filter(function (b) { return b && b.type === 'text'; }).map(function (b) { return b.text || ''; }).join('');
      out.reasoning = blocks.filter(function (b) { return b && b.type === 'thinking'; }).map(function (b) { return b.thinking || b.text || ''; }).join('\n');
      out.truncated = (wire.stop_reason === 'max_tokens');
      if (wire.usage) out.usage = { input_tokens: wire.usage.input_tokens || 0, output_tokens: wire.usage.output_tokens || 0 };
      return out;
    }
    if (fmt === 'gemini') {
      var cand = (wire.candidates && wire.candidates[0]) || {};
      var parts = (cand.content && cand.content.parts) || [];
      out.content = parts.filter(function (p) { return !p.thought; }).map(function (p) { return p.text || ''; }).join('');
      out.reasoning = parts.filter(function (p) { return p.thought; }).map(function (p) { return p.text || ''; }).join('\n');
      out.truncated = cand.finishReason === 'MAX_TOKENS' || /max_tokens/i.test(String(cand.finishReason || ''));
      if (wire.usageMetadata) out.usage = { input_tokens: wire.usageMetadata.promptTokenCount || 0, output_tokens: wire.usageMetadata.candidatesTokenCount || 0 };
      return out;
    }
    var choice = (wire.choices && wire.choices[0]) || {};
    var message = choice.message || {};
    out.content = (message.content == null ? '' : message.content);
    out.reasoning = message.reasoning_content || message.reasoning || message.analysis || message.thinking || '';
    out.truncated = choice.finish_reason === 'length' || choice.finish_reason === 'max_tokens';
    if (wire.usage) out.usage = { prompt_tokens: wire.usage.prompt_tokens || 0, completion_tokens: wire.usage.completion_tokens || 0 };
    return out;
  }

  /* ── GPT-6 Astra 最小适配层（runtime-neutral，无 DOM）──
     Astra 走 OpenAI-compatible wire（format='openai'），因此 request/response 归一直接复用
     buildRequestBody / parseResponse。此处抽出独立的 AstraAdapter 作为**干净的中间件接口**：
     - isAstra(spec)：判断提供者是否为 Astra（provider 名或 format 标记）
     - buildRequest / parseResponse：委托给通用 openai 归一，字段保持独立可替换
     - normalizePrompt：统一 {system, messages} 入口（与 Middle Brain 后续接管的形状一致）
     目的：让 Astra 后续可以作为独立 middleware 调用，不改动其它 provider 的既有行为。 */
  function _isAstra(spec) {
    if (!spec) return false;
    var provider = String((spec.provider || '')).toLowerCase();
    var model = String((spec.model || '')).toLowerCase();
    return provider === 'astra' || provider === 'gpt-6' || /gpt-6|astra/.test(model);
  }
  var AstraAdapter = {
    isAstra: _isAstra,
    normalizePrompt: function (prompt, spec) { return _prompt(prompt, spec); },
    /* 归一请求体：委托给通用 openai（Astra format='openai'，无特例字段）。中等脑接入时在此挂归一钩子。 */
    buildRequest: function (spec, prompt, options) {
      var fmt = 'openai';
      var p = _prompt(prompt, spec);
      var model = spec && spec.model;
      var maxTokens = (options && options.maxTokens != null) ? options.maxTokens : 512;
      var temperature = (options && options.temperature != null) ? options.temperature : (spec && spec.temperature != null ? spec.temperature : null);
      var msgs = [{ role: 'system', content: p.system }].concat(p.messages.map(function (m) { return { role: m.role, content: adaptMessageParts('openai', m.content) }; }));
      var body = { model: model, messages: msgs, max_tokens: maxTokens };
      if (options && options.jsonMode) body.response_format = { type: 'json_object' };
      if (temperature != null) body.temperature = Number(temperature);
      return { endpoint: spec && spec.endpoint, headers: {}, body: body, format: fmt };
    },
    /* 归一响应：复用通用 openai 归一出 content/reasoning/truncated/usage。 */
    parseResponse: function (wire, spec, options) { return parseResponse(wire, Object.assign({}, spec, { format: 'openai' }), options); },

    /* ── OpenAI Responses API · 专用 request builder ──
       不把 Responses API 当 Chat Completions 发送。正确映射：
       model / input / instructions / max_output_tokens / reasoning.effort /
       stream / text.format。绝不发送 max_tokens / temperature / top_p / logprobs /
       reasoning_effort 等 Chat Completions 旧参数。
       保持旧 buildRequest 不变（其它调用方仍走 OpenAI-compat）。 */
    buildResponsesRequest: function (spec, prompt, options) {
      options = options || {};
      var p = _prompt(prompt, spec);
      var model = (spec && spec.model) || 'gpt-6-astra';
      var maxOut = (options.maxTokens != null ? options.maxTokens : 512);
      /* input：把 system 并入首条，或作为独立 message。Responses input 支持 {role,content}。
         instructions 为独立 top-level 字段（若 Middle Brain 有独立 system/instruction）。 */
      var input = [];
      if (p.system) input.push({ role: 'system', content: p.system });
      (p.messages || []).forEach(function (m) { input.push({ role: m.role, content: adaptMessageParts('openai', m.content) }); });
      var body = { model: model, input: input, max_output_tokens: maxOut, stream: !!options.stream };
      if (p.system) body.instructions = p.system;               /* Responses 独立指令域 */
      if (p.messages && p.messages[0] && p.messages[0].role === 'system') {
        /* system 已在 input 保留（兼容），instructions 作为独立域给 Middle Brain */
      }
      /* reasoning.effort：仅显式指定时设置。缺省不发送（避免误用旧 reasoning_effort）。 */
      if (options.reasoningEffort != null) body.reasoning = { effort: String(options.reasoningEffort) };
      /* 结构化 JSON 输出：Responses 原生 text.format。若结构化参数可能不兼容，
         由上层 catch 后去掉再重试（fallback 不破坏聊天）。 */
      if (options.jsonMode) body.text = { format: { type: 'json_schema', name: 'middle_brain_result', schema: {
        type: 'object',
        properties: {
          keep: { type: 'array', items: { type: 'string' } },
          merge: { type: 'array', items: { type: 'object' } },
          drop: { type: 'array', items: { type: 'string' } },
          compressedContext: { type: 'string' },
          currentKept: { type: 'boolean' }
        },
        required: ['compressedContext', 'currentKept'],
        additionalProperties: false
      } } };
      return { endpoint: (spec && spec.endpoint) || 'https://api.openai.com/v1/responses', headers: {}, body: body, format: 'responses' };
    },

    /* ── OpenAI Responses API · 专用 parser ──
       优先 response.output_text（官方便捷字段）；无或为空时遍历 response.output：
         output[] 是权威来源，可能含不同 type 的输出项（message / reasoning / ...）。
         仅对 type==='message' 读 content；type==='reasoning' 读 summary（→ reasoning）。
         message.content 项：优先官方 output_text，其次 output_text type 的 .text，
         再 fallback 到 text type 的 .text（兼容旧/中转变体）。
       决不假设 choices[0].message.content，也不 assume output[0].content[0].text。
       text 仅在非空时采用，空 output_text 不应挡住 output[] 里的真实内容。 */
    parseResponsesResponse: function (wire, spec, options) {
      var out = { content: '', reasoning: '', truncated: false, usage: null };
      if (!wire) return out;
      var text = null;
      /* 顶层 output_text 是便捷字段；若非空字符串则优先采用 */
      if (typeof wire.output_text === 'string' && wire.output_text !== '') text = wire.output_text;
      /* 若没有顶层 output_text（或为空），则遍历权威的 output[]，按 item.type 分支处理 */
      if (text == null && Array.isArray(wire.output)) {
        var parts = [];
        for (var i = 0; i < wire.output.length; i++) {
          var item = wire.output[i];
          if (!item) continue;
          if (item.type === 'message' && Array.isArray(item.content)) {
            for (var j = 0; j < item.content.length; j++) {
              var c = item.content[j]; if (!c) continue;
              /* message.content 项：优先官方 output_text 字段；再按项 type 取 text */
              if (typeof c.output_text === 'string') parts.push(c.output_text);
              else if (c.type === 'output_text' && typeof c.output_text === 'string' && c.output_text !== '') parts.push(c.output_text);
              else if (c.type === 'output_text' && typeof c.text === 'string') parts.push(c.text);
              else if (c.type === 'text' && typeof c.text === 'string') parts.push(c.text);
            }
          } else if (item.type === 'reasoning' && Array.isArray(item.summary)) {
            item.summary.forEach(function (s) { if (s && typeof s.text === 'string') out.reasoning += (out.reasoning ? '\n' : '') + s.text; });
          }
          /* 其它 type（如 file_search / web_search_call）不属于正文，忽略 */
        }
        if (parts.length) text = parts.join('');
      }
      out.content = (text == null ? '' : String(text));
      /* done/truncated 信号：Responses 无 finish_reason，用 status 判断 */
      if (wire.status && /incomplete/.test(String(wire.status))) out.truncated = true;
      /* usage 映射：Responses API 专用字段 → IB 现有 {input_tokens, output_tokens, total} 结构 */
      if (wire.usage) {
        var u = wire.usage;
        out.usage = {
          input_tokens: u.input_tokens || 0,
          output_tokens: u.output_tokens || 0,
          total_tokens: u.total_tokens != null ? u.total_tokens : ((u.input_tokens || 0) + (u.output_tokens || 0)),
          input_tokens_details: u.input_tokens_details || null,
          output_tokens_details: u.output_tokens_details || null
        };
      }
      return out;
    },

    /* ── OpenAI Responses API · SSE/event stream parser（占位兼容入口）──
       Middle Brain v0 实际用非流式调用；此入口为未来 streaming 预留。
       逐事件解析，仅做保守兼容；不破坏现有 Chat Completions streaming。 */
    parseResponsesStream: function (onEvent) {
      var buf = '';
      return {
        push: function (chunk) {
          buf += chunk;
          for (;;) {
            var nl = buf.indexOf('\n');
            if (nl < 0) break;
            var line = buf.slice(0, nl); buf = buf.slice(nl + 1);
            if (!line.indexOf('data:')) { /* keep */ }
            if (line.indexOf('data:') !== 0) continue;
            var d = line.slice(5).trim(); if (d === '[DONE]') return;
            try { onEvent && onEvent(JSON.parse(d)); } catch (e) {}
          }
        },
        flush: function () { return buf; }
      };
    }
  };

  return {
    PROVIDERS: PROVIDERS,
    providerFormat: providerFormat,
    resolveProviderFormat: resolveProviderFormat,
    modelSupportsSamplingParameters: modelSupportsSamplingParameters,
    modelSupportsAssistantPrefill: modelSupportsAssistantPrefill,
    /* P20：Anthropic wire 归一的唯一真源（Browser / Node 共用同一实现） */
    normalizeAnthropicMessages: normalizeAnthropicMessages,
    validateAnthropicRequestBody: validateAnthropicRequestBody,
    adaptMessageParts: adaptMessageParts,
    geminiParts: geminiParts,
    buildRequestBody: buildRequestBody,
    parseResponse: parseResponse,
    AstraAdapter: AstraAdapter
  };
});
