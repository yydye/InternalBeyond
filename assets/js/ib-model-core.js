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
  if (typeof module === 'object' && module.exports) { module.exports = factory(); }
  else { root.IBModelCore = factory(); }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* 提供者目录（镜像 browser social.js 的 PROVIDERS，供 runtime-neutral 解析使用） */
  var PROVIDERS = {
    anthropic: { name: 'Claude', endpoint: 'https://api.anthropic.com/v1/messages', model: 'claude-sonnet-4-6', format: 'anthropic', vision: true, streaming: true },
    openai: { name: 'GPT', endpoint: 'https://api.openai.com/v1/chat/completions', model: 'gpt-4o-mini', format: 'openai', vision: true, streaming: true },
    grok: { name: 'Grok', endpoint: 'https://api.x.ai/v1/chat/completions', model: 'grok-4', format: 'openai', vision: true, streaming: true },
    deepseek: { name: 'DeepSeek', endpoint: 'https://api.deepseek.com/v1/chat/completions', model: 'deepseek-v4-flash', format: 'openai', vision: true, streaming: true, showThinking: true },
    gemini: { name: 'Gemini', endpoint: 'https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent', model: 'gemini-2.0-flash', format: 'gemini', vision: true, streaming: true },
    glm: { name: 'GLM', endpoint: 'https://open.bigmodel.cn/api/paas/v4/chat/completions', model: 'glm-4-flash', format: 'openai', vision: true, streaming: true, showThinking: false },
    qwen: { name: '通义千问', endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', model: 'qwen-plus', format: 'openai', vision: true, streaming: true },
    doubao: { name: '豆包', endpoint: 'https://ark.cn-beijing.volces.com/api/v3/chat/completions', model: 'doubao-seed-2-0-lite', format: 'openai', vision: true, streaming: true },
    moonshot: { name: 'Kimi', endpoint: 'https://api.moonshot.cn/v1/chat/completions', model: 'kimi-k2.6', format: 'openai', vision: true, streaming: true },
    mimo: { name: 'MiMo', endpoint: 'https://api.xiaomimimo.com/v1/chat/completions', model: 'mimo-v2.5', format: 'openai', vision: true, streaming: true, showThinking: true },
    minimax: { name: 'MiniMax', endpoint: 'https://api.minimax.chat/v1/text/chatcompletion_v2', model: 'MiniMax-Text-01', format: 'openai', vision: false, streaming: true },
    yi: { name: '零一万物', endpoint: 'https://api.lingyiwanwu.com/v1/chat/completions', model: 'yi-lightning', format: 'openai', vision: false, streaming: true },
    baichuan: { name: '百川', endpoint: 'https://api.baichuan-ai.com/v1/chat/completions', model: 'Baichuan4', format: 'openai', vision: false, streaming: true },
    mistral: { name: 'Mistral', endpoint: 'https://api.mistral.ai/v1/chat/completions', model: 'mistral-large-latest', format: 'openai', vision: false, streaming: true },
    custom: { name: 'Custom', endpoint: '', model: '', format: 'openai', vision: true, streaming: true }
  };

  /* provider → wire format（model-client 分支保持一致：anthropic/gemini/else-openai） */
  function providerFormat(provider) {
    return (PROVIDERS[provider] && PROVIDERS[provider].format) || 'openai';
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
      var ab = {
        model: model,
        max_tokens: maxTokens,
        system: system,
        messages: messages.map(function (m) { return { role: m.role, content: adaptMessageParts('anthropic', m.content) }; })
      };
      if (options.jsonMode) {
        var jp = options.jsonPrefill || '{"action":';
        ab.messages = ab.messages.concat([{ role: 'assistant', content: jp }]);
      }
      if (temperature != null) ab.temperature = Number(temperature);
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
    adaptMessageParts: adaptMessageParts,
    geminiParts: geminiParts,
    buildRequestBody: buildRequestBody,
    parseResponse: parseResponse,
    AstraAdapter: AstraAdapter
  };
});
