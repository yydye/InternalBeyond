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
      temperature: temperature
    });
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
      onEvent({ type: 'done', truncated: parsed.truncated, reasoning: parsed.reasoning, usage: parsed.usage });
      return { text: parsed.content, reasoning: parsed.reasoning, truncated: parsed.truncated, usage: parsed.usage };
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

  return { run: run };
}

module.exports = createNodeModelPort;
