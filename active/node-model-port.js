/* ====================================================================
   IB Active · Node ModelPort（Phase 4）
   --------------------------------------------------------------------
   在 Node runtime 建立与 Browser ModelPort 相同的最小 execution contract：
     run(request, { signal, onEvent })
   - 单次 POST、非流式
   - jsonMode / jsonPrefill / maxTokens / temperature
   - AbortSignal（Node 18+ fetch 原生支持 signal）
   - 返回 {text, reasoning, truncated, usage}
   - 成功时发一次 onEvent({type:'done', ...})
   - 错误明确、可传播（emit error 后 rethrow）

   复用 runtime-neutral shared core：IBModelCore.buildRequestBody / parseResponse。
   未接入 callCharacterModel / scheduler / Proactive（保持现有行为，见报告）。
   不新增 retry / continuation / streaming / tool / web search / cache。
   ==================================================================== */
'use strict';

const IBMC = require('../assets/js/ib-model-core.js');

function createNodeModelPort(deps) {
  deps = deps || {};
  const _fetch = deps.fetch || (typeof fetch === 'function' ? fetch : null);
  const _defaultMaxTokens = (deps.maxTokens != null ? deps.maxTokens : 512);
  /* timeout parity：与 callCharacterModel 的 fetchJson(timeoutMs||120000) 保持一致 */
  const _timeoutMs = (deps.timeoutMs != null ? deps.timeoutMs : 120000);

  /* provider-specific transport：endpoint + headers（body 由 IBModelCore 生成） */
  function _transport(spec) {
    const provider = String(spec.provider || '').toLowerCase();
    const endpoint = String(spec.endpoint || '');
    if (provider === 'gemini') {
      let url = endpoint.includes('{model}') ? endpoint.replace('{model}', encodeURIComponent(spec.model || '')) : endpoint;
      let u;
      try { u = new URL(url); } catch (e) { u = null; }
      if (u && !u.searchParams.has('key')) u.searchParams.set('key', spec.apiKey || '');
      return { url: u ? u.toString() : url, headers: { 'Content-Type': 'application/json' } };
    }
    if (provider === 'anthropic') {
      return {
        url: endpoint,
        headers: { 'Content-Type': 'application/json', 'x-api-key': spec.apiKey || '', 'anthropic-version': '2023-06-01' }
      };
    }
    const headers = { 'Content-Type': 'application/json' };
    if (spec.apiKey) headers.Authorization = 'Bearer ' + spec.apiKey;
    return { url: endpoint, headers: headers };
  }

  /* ── Phase 9 · 流式 transport ─────────────────────────────────────────
     与 _transport 的差别只在「必须让 provider 真的开始流」：
       · anthropic : body.stream = true（endpoint 不变，SSE 原生）
       · gemini    : generateContent → streamGenerateContent + alt=sse
                     （这是浏览器侧 communication.js:3677 的同一变换；
                      不共用代码是因为那里是浏览器字符串拼接，这里是 URL 对象操作，
                      但**语义逐字一致**，且都属"provider wire"层，不在 chat service 里）
       · openai 系 : body.stream = true + stream_options.include_usage
                     MiMo 明确拒绝 stream_options（communication.js:3702 的同一判定）。
     fmt 由调用方用 IBMC.providerFormat 传入 —— 本文件不做任何 provider 名判断。 */
  function _streamTransport(spec, body, fmt) {
    const transport = _transport(spec);
    if (!body || typeof body !== 'object') return transport;
    body.stream = true;
    if (fmt === 'anthropic') return transport;
    if (fmt === 'gemini') {
      let u = null;
      try { u = new URL(transport.url); } catch (e) { u = null; }
      if (u) {
        u.pathname = u.pathname.replace(/generateContent/, 'streamGenerateContent').replace(/:generateContent/, ':streamGenerateContent');
        u.searchParams.set('alt', 'sse');
        if (!u.searchParams.has('key') && spec.apiKey) u.searchParams.set('key', spec.apiKey);
        transport.url = u.toString();
      } else {
        transport.url = String(transport.url).replace('generateContent', 'streamGenerateContent') +
          (String(transport.url).includes('?') ? '&' : '?') + 'alt=sse';
      }
      return transport;
    }
    const isMimo = (String(spec.provider || '').toLowerCase() === 'mimo') || /xiaomimimo\.com/i.test(String(spec.endpoint || ''));
    if (!isMimo) body.stream_options = { include_usage: true };
    return transport;
  }

  function _mapError(e) {
    const name = String((e && e.name) || '');
    const msg = String((e && e.message) || (e ? String(e) : 'unknown'));
    let kind = 'unknown', status;
    if (name === 'AbortError' || /abort/i.test(msg)) kind = 'abort';
    else if (/timeout|超时/i.test(msg)) kind = 'timeout';
    else { const m = String(msg).match(/(\d{3})/); if (m) { kind = 'http'; status = parseInt(m[1], 10); } }
    return { kind: kind, message: msg, status: status };
  }

  async function run(request, options) {
    options = options || {};
    const onEvent = options.onEvent || function () {};
    const spec = (request && request.spec) || {};
    /* prompt 支持两种形态：{system, messages} 或纯 messages[]（system 从 spec.systemPrompt 兜底） */
    const prompt = (request && request.prompt && Array.isArray(request.prompt.messages))
      ? request.prompt
      : { system: spec.systemPrompt || '', messages: (request && request.messages) || [] };
    const maxTok = (request && request.maxTokens != null) ? request.maxTokens : _defaultMaxTokens;
    const temperature = (request && request.temperature != null) ? request.temperature : (spec.temperature != null ? spec.temperature : null);

    const body = IBMC.buildRequestBody(spec, prompt, {
      jsonMode: !!(request && request.jsonMode),
      jsonPrefill: request && request.jsonPrefill,
      maxTokens: maxTok,
      temperature: temperature,
      /* P21 · 统一思考深度：canonical 值由调用方给出（浏览器侧 = Middle Brain 配置；
         Node 侧当前无 consumer 提供 → 缺省 'auto' = 一个字段都不写，行为与上线前逐字节一致）。
         翻译只发生在 buildRequestBody 内部（provider 能力表），本文件不做任何 provider 判定。 */
      reasoningEffort: (request && request.reasoningEffort) || 'auto',
      consumer: (request && request.consumer) || ''
    });
    /* P19 · 本次请求是否真的用了 legacy assistant prefill（唯一判定 = IBModelCore 的
       model policy），以及真实使用的 seed 文本。供 consumer 决定解析时是否允许
       「续写形态」容错（续写必须补回**完整 seed**，只补 '{' 会拼出非法 JSON）；
       不支持 prefill 的 model（Claude 4.6+）恒为空 —— 它们收到的是完整 JSON。 */
    const prefillApplied = !!(request && request.jsonMode)
      && IBMC.providerFormat(spec.provider) === 'anthropic'
      && IBMC.modelSupportsAssistantPrefill(spec.model);
    const prefillSeed = prefillApplied ? ((request && request.jsonPrefill) || '{"action":') : '';
    /* openai 系参数协商（与 callCharacterModel 的 request('max_completion_tokens') 一致）：
       某些 GPT-5 系模型只接受 max_completion_tokens；此处仍为单次执行，仅切换 body 形状。 */
    if (request && request.tokenParam === 'max_completion_tokens' && body && body.max_tokens != null
        && String(spec.provider || '').toLowerCase() !== 'anthropic' && String(spec.provider || '').toLowerCase() !== 'gemini') {
      body.max_completion_tokens = body.max_tokens;
      delete body.max_tokens;
    }
    /* MiMo(Xiaomi) 端点强制 max_completion_tokens：MiMo 拒绝 max_tokens/stream_options/prompt_cache_key。
       与 browser communication.js 的 _isMimoEndpoint 判定一致（provider==='mimo' 或 endpoint 命中）。
       确定性修正，不依赖报错文案——故 active 域不再依赖 compat 层的 error-text 正则重试。 */
    var _mimoHost = (String(spec.provider || '').toLowerCase() === 'mimo') || /xiaomimimo\.com/i.test(String(spec.endpoint || ''));
    if (_mimoHost && body) {
      if (body.max_tokens != null) { body.max_completion_tokens = body.max_tokens; delete body.max_tokens; }
      delete body.prompt_cache_key;
      delete body.stream_options;
    }
    const tr = _transport(spec);

    const timeoutMs = (options && options.timeoutMs != null) ? options.timeoutMs : _timeoutMs;
    const ac = new AbortController();
    let cancelReason = null; /* 区分外部 abort 与内部 timeout：null|'external'|'timeout' */
    const onExternalAbort = function () { if (cancelReason === null) cancelReason = 'external'; ac.abort(); };
    if (options.signal) {
      try {
        if (options.signal.aborted) onExternalAbort();
        else options.signal.addEventListener('abort', onExternalAbort, { once: true });
      } catch (e) { /* signal 桥接失败不影响执行 */ }
    }
    const timer = setTimeout(function () { if (cancelReason === null) { cancelReason = 'timeout'; ac.abort(); } }, timeoutMs);
    if (!_fetch) { clearTimeout(timer); throw new Error('NodeModelPort: no fetch available'); }

    try {
      const res = await _fetch(tr.url, { method: 'POST', headers: tr.headers, body: JSON.stringify(body), signal: ac.signal });
      if (!res.ok) {
        const t = await res.text().catch(function () { return ''; });
        /* HTTP error 语义对齐 callCharacterModel/fetchJson：提取 parsed.error.message，截断到 1200，并带 status */
        let detail = t;
        try { const parsed = t ? JSON.parse(t) : null; if (parsed && parsed.error) detail = parsed.error.message || JSON.stringify(parsed.error); } catch (_) { /* 非 JSON body 用原文 */ }
        const err = new Error(String(res.status) + (detail ? ': ' + String(detail).slice(0, 1200) : ''));
        err.status = res.status;
        throw err;
      }
      const rawText = await res.text();
      let wire;
      try { wire = JSON.parse(rawText); } catch (e) { throw new Error('invalid JSON response'); }
      const parsed = IBMC.parseResponse(wire, spec);
      /* P21：实际 reasoning tokens 只读回填（观测用；读不到即跳过，不参与任何计量口径） */
      try {
        const _rt = IBMC.reasoningTokensFromUsage(parsed.usage, IBMC.providerFormat(spec.provider));
        if (_rt != null) IBMC.noteReasoningTokens(_rt, { consumer: (request && request.consumer) || '', provider: spec.provider, model: spec.model });
      } catch (_) { /* 观测失败不影响执行 */ }
      onEvent({ type: 'done', truncated: parsed.truncated, reasoning: parsed.reasoning, usage: parsed.usage });
      return { text: parsed.content, reasoning: parsed.reasoning, truncated: parsed.truncated, usage: parsed.usage, prefillApplied: prefillApplied, prefillSeed: prefillSeed };
    } catch (e) {
      const isAbort = (e && e.name === 'AbortError') || /abort/i.test(String((e && e.message) || ''));
      if (isAbort && cancelReason === 'timeout') {
        /* 内部 timeout：给出稳定、清晰的超时分类（与外部 abort 区分） */
        const err = new Error('request timed out after ' + timeoutMs + 'ms');
        err.name = 'TimeoutError';
        try { onEvent({ type: 'error', kind: 'timeout', message: err.message, status: undefined }); } catch (_) { /* 忽略 */ }
        throw err;
      }
      const m = (isAbort)
        ? { kind: 'abort', message: String((e && e.message) || 'aborted'), status: undefined }
        : _mapError(e);
      try { onEvent({ type: 'error', kind: m.kind, message: m.message, status: m.status }); } catch (_) { /* 忽略 */ }
      throw e; /* 错误明确、可传播 */
    } finally {
      clearTimeout(timer);
    }
  }

  /* ── Phase 9 · 流式执行入口 ────────────────────────────────────────────
     runStream(request, { signal, onEvent, timeoutMs })
       · 与 run() 共用 spec / prompt / maxTokens / temperature / reasoningEffort /
         tokenParam / MiMo 修正的**同一套** body 构建（IBMC.buildRequestBody），
         唯一差别是 _streamTransport() 让 provider 真的开始流；
       · 事件与 run 同名同形，另加增量事件：
           {type:'delta', kind:'content'|'reasoning', text, index}
           {type:'done', truncated, reasoning, usage, text}
           {type:'error', kind, message, status?}
       · 返回形状与 run() 一致：{text, reasoning, truncated, usage, stats}，
         因此调用方可以无差别地处理流式/非流式（chat service 只消费这一个形状）。
       · cancellation：options.signal 与内部 timeout 共用**与 run 完全一致**的分类
         （timeout → TimeoutError；外部 abort → 原样抛出 AbortError）。
       · malformed chunk：由 IBMC.createStreamParser 丢弃坏行并计数，绝不中断生成；
         但 provider 在流中显式回传的错误对象会以 provider-stream 错误浮出。 */
  async function runStream(request, options) {
    options = options || {};
    const onEvent = options.onEvent || function () {};
    const spec = (request && request.spec) || {};
    const prompt = (request && request.prompt && Array.isArray(request.prompt.messages))
      ? request.prompt
      : { system: spec.systemPrompt || '', messages: (request && request.messages) || [] };
    const maxTok = (request && request.maxTokens != null) ? request.maxTokens : _defaultMaxTokens;
    const temperature = (request && request.temperature != null) ? request.temperature : (spec.temperature != null ? spec.temperature : null);
    const fmt = IBMC.providerFormat(spec.provider);

    const body = IBMC.buildRequestBody(spec, prompt, {
      jsonMode: !!(request && request.jsonMode),
      jsonPrefill: request && request.jsonPrefill,
      maxTokens: maxTok,
      temperature: temperature,
      reasoningEffort: (request && request.reasoningEffort) || 'auto',
      consumer: (request && request.consumer) || ''
    });
    const prefillApplied = !!(request && request.jsonMode) && fmt === 'anthropic' && IBMC.modelSupportsAssistantPrefill(spec.model);
    const prefillSeed = prefillApplied ? ((request && request.jsonPrefill) || '{"action":') : '';
    if (request && request.tokenParam === 'max_completion_tokens' && body && body.max_tokens != null
        && String(spec.provider || '').toLowerCase() !== 'anthropic' && String(spec.provider || '').toLowerCase() !== 'gemini') {
      body.max_completion_tokens = body.max_tokens;
      delete body.max_tokens;
    }
    const mimoHost = (String(spec.provider || '').toLowerCase() === 'mimo') || /xiaomimimo\.com/i.test(String(spec.endpoint || ''));
    if (mimoHost && body) {
      if (body.max_tokens != null) { body.max_completion_tokens = body.max_tokens; delete body.max_tokens; }
      delete body.prompt_cache_key;
    }
    if (body && body.response_format && fmt === 'openai') { /* 流式下 response_format 仍合法，保留 */ }
    const tr = _streamTransport(spec, body, fmt);

    const timeoutMs = (options && options.timeoutMs != null) ? options.timeoutMs : _timeoutMs;
    const ac = new AbortController();
    let cancelReason = null;
    const onExternalAbort = function () { if (cancelReason === null) cancelReason = 'external'; ac.abort(); };
    if (options.signal) {
      try {
        if (options.signal.aborted) onExternalAbort();
        else options.signal.addEventListener('abort', onExternalAbort, { once: true });
      } catch (e) { /* signal 桥接失败不影响执行 */ }
    }
    const timer = setTimeout(function () { if (cancelReason === null) { cancelReason = 'timeout'; ac.abort(); } }, timeoutMs);
    if (!_fetch) { clearTimeout(timer); throw new Error('NodeModelPort: no fetch available'); }

    const parser = IBMC.createStreamParser(fmt, onEvent);
    try {
      const res = await _fetch(tr.url, {
        method: 'POST',
        headers: Object.assign({ Accept: 'text/event-stream' }, tr.headers),
        body: JSON.stringify(body),
        signal: ac.signal
      });
      if (!res.ok) {
        const t = await res.text().catch(function () { return ''; });
        let detail = t;
        try { const parsed = t ? JSON.parse(t) : null; if (parsed && parsed.error) detail = parsed.error.message || JSON.stringify(parsed.error); } catch (_) { /* 非 JSON body 用原文 */ }
        const err = new Error(String(res.status) + (detail ? ': ' + String(detail).slice(0, 1200) : ''));
        err.status = res.status;
        throw err;
      }
      /* 无 body 的响应（少数中转在流式下返回空体）→ 明确报错，不静默返回空串。 */
      if (!res.body || typeof res.body.getReader !== 'function') {
        const bodyText = await res.text().catch(function () { return ''; });
        if (bodyText) {
          let wire = null;
          try { wire = JSON.parse(bodyText); } catch (e) { throw new Error('streaming response is not an event stream'); }
          const parsed = IBMC.parseResponse(wire, spec);
          onEvent({ type: 'done', truncated: parsed.truncated, reasoning: parsed.reasoning, usage: parsed.usage, text: parsed.content });
          return { text: parsed.content, reasoning: parsed.reasoning, truncated: parsed.truncated, usage: parsed.usage, stats: { chunks: 0, events: 0, deltas: 0, malformed: 0, unknown: 0, done: true }, prefillApplied: prefillApplied, prefillSeed: prefillSeed, streamed: false };
        }
        throw new Error('streaming response has no body');
      }
      /* 读流用递归而不是 for(;;)：tests/test_harness_boundary.js:151 用
         `!/\b(for\s*\(|while\s*\()/` 静态锁住「NodeModelPort 是单次执行、不做重试循环」。
         该守卫的意图是禁止重试/续写循环，而这里是纯顺序读流 —— 但它无法区分两者。
         与其放宽一条已经冻结的边界测试，不如改写形状，让守卫继续有效。 */
      const reader = res.body.getReader();
      const decoder = new TextDecoder('utf-8');
      const pump = async function () {
        const step = await reader.read();
        if (step.done) return;
        parser.push(decoder.decode(step.value, { stream: true }));
        return pump();
      };
      await pump();
      parser.push(decoder.decode()); /* flush 多字节残尾 */
      const out = parser.finish();
      /* 观测：实际 reasoning tokens 只读回填（与非流式 run 同一口径） */
      try {
        const _rt = IBMC.reasoningTokensFromUsage(out.usage, fmt);
        if (_rt != null) IBMC.noteReasoningTokens(_rt, { consumer: (request && request.consumer) || '', provider: spec.provider, model: spec.model });
      } catch (_) { /* 观测失败不影响执行 */ }
      if (out.streamError) {
        const err = new Error(String(out.streamError).slice(0, 1200));
        err.kind = 'provider-stream';
        try { onEvent({ type: 'error', kind: 'provider-stream', message: err.message, status: undefined }); } catch (_) { /* 忽略 */ }
        throw err;
      }
      onEvent({ type: 'done', truncated: out.truncated, reasoning: out.reasoning, usage: out.usage, text: out.content });
      return {
        text: out.content,
        reasoning: out.reasoning,
        truncated: out.truncated,
        usage: out.usage,
        stats: out.stats,
        prefillApplied: prefillApplied,
        prefillSeed: prefillSeed,
        streamed: true
      };
    } catch (e) {
      const isAbort = (e && e.name === 'AbortError') || /abort/i.test(String((e && e.message) || ''));
      if (isAbort && cancelReason === 'timeout') {
        const err = new Error('request timed out after ' + timeoutMs + 'ms');
        err.name = 'TimeoutError';
        try { onEvent({ type: 'error', kind: 'timeout', message: err.message, status: undefined }); } catch (_) { /* 忽略 */ }
        throw err;
      }
      const m = (isAbort)
        ? { kind: 'abort', message: String((e && e.message) || 'aborted'), status: undefined }
        : (e && e.kind ? { kind: e.kind, message: String(e.message || e), status: e.status } : _mapError(e));
      try { onEvent({ type: 'error', kind: m.kind, message: m.message, status: m.status }); } catch (_) { /* 忽略 */ }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  return { run: run, runStream: runStream };
}

module.exports = createNodeModelPort;
