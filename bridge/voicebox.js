/* IB Bridge · Voicebox Local Runtime（P23 Phase 1）。
   Voicebox（https://github.com/jamiepine/voicebox）是**独立本地运行的 Voice Runtime**，
   IB 不复制、不嵌入、不启动、不安装它的任何模型实现，只通过其公开 REST API 调用。

   本文件是 Voicebox endpoint 的**唯一权威**（默认地址只在这里出现一次）：
   解析顺序 config.voicebox.endpoint → 环境变量 IB_VOICEBOX_ENDPOINT → DEFAULT_ENDPOINT。

   架构边界（contract，见 docs/P23-1-VOICE-RUNTIME-FOUNDATION.md §4）：
     · IB 是「说什么」的 authority —— 文本原样送过去，绝不请求改写；
       请求体恒带 personality:false，Voicebox 的 personality/rewrite 通道永不启用。
     · Voicebox 只负责「怎么念」——TTS inference / voice profile / engine / audio。

   实测的上游 contract（backend/routes/generations.py · health.py · audio.py · models.py，
   见 docs 的 §4 表格，逐条有 file 证据）：
      POST /generate          {profile_id,text,language?,engine?,instruct?,personality:false}
                              → 202 语义：立即返回 GenerationResponse{id,status:'generating'}
      POST /generate/{id}/cancel → 请求取消该 generation
      GET  /history/{id}      → HistoryResponse{status,duration,audio_path,error,engine}
     GET  /audio/{id}        → 音频字节（Content-Type 由扩展名推导）
     GET  /health            → HealthResponse{status,model_loaded,...}
     GET  /profiles          → VoiceProfileResponse[]
   生成为**异步队列 + SSE/轮询**，不是同步返回音频 —— 本适配器用 /history 轮询收口。
    错误以 {ok:false,error} 返回；调用方取消为 {ok:false,cancelled:true,error}；绝不静默 fallback。 */
'use strict';

/* Voicebox 默认监听地址：上游 README 的 API 示例与 backend/app.py 的默认 CORS 白名单
   一致（同一端口）。全仓库仅此一处硬编码。 */
const DEFAULT_ENDPOINT = 'http://127.0.0.1:17493';

/* 上游 GenerationRequest 的 engine enum（backend/models.py 的 pattern）。
   这里只作为「可选项清单」镜像一次：留空时请求不带 engine，由 Voicebox profile 的
   default_engine 决定 —— IB 不猜测、不重复上游的默认策略。 */
const ENGINES = ['qwen', 'qwen_custom_voice', 'luxtts', 'chatterbox', 'chatterbox_turbo', 'tada', 'kokoro'];

/* 上游 GenerationRequest 的 language enum（backend/models.py）。空值不发送。 */
const LANGUAGES = ['zh', 'en', 'ja', 'ko', 'de', 'fr', 'ru', 'pt', 'es', 'it', 'he', 'ar', 'da', 'el', 'fi', 'hi', 'ms', 'nl', 'no', 'pl', 'sv', 'sw', 'tr'];

const HEALTH_TIMEOUT_MS = 2500;
const REQUEST_TIMEOUT_MS = 15000;
const AUDIO_TIMEOUT_MS = 30000;
const POLL_INTERVAL_MS = 400;
const GENERATE_TIMEOUT_MS = 180000;

function createVoicebox(deps) {
  const config = deps.config || {};
  const injectedTimeouts = deps.timeouts || {};
  const requestTimeoutMs = Math.max(1, Number(injectedTimeouts.requestMs) || REQUEST_TIMEOUT_MS);
  const audioTimeoutMs = Math.max(1, Number(injectedTimeouts.audioMs) || AUDIO_TIMEOUT_MS);
  const generationTimeoutMs = Math.max(1, Number(injectedTimeouts.generationMs) || GENERATE_TIMEOUT_MS);
  const pollIntervalMs = Math.max(1, Number(injectedTimeouts.pollMs) || POLL_INTERVAL_MS);

  function section() {
    return (config.voicebox && typeof config.voicebox === 'object') ? config.voicebox : {};
  }

  /* endpoint 的唯一解析点。尾部斜杠归一，避免拼出 //generate。 */
  function endpoint() {
    const raw = section().endpoint || process.env.IB_VOICEBOX_ENDPOINT || DEFAULT_ENDPOINT;
    return String(raw || '').trim().replace(/\/+$/, '');
  }

  function isEnabled() {
    return section().enabled !== false;
  }

  function notConfigured() {
    return { ok: false, error: 'Voicebox 未启用：请在 Bridge config.json 的 voicebox 区块把 enabled 设为 true（本地运行时默认不需要 API Key）' };
  }

  function sleep(ms, signal) {
    if (signal && signal.aborted) return Promise.resolve(false);
    return new Promise((resolve) => {
      let settled = false;
      const finish = (elapsed) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (signal && typeof signal.removeEventListener === 'function') signal.removeEventListener('abort', onAbort);
        resolve(elapsed);
      };
      const onAbort = () => finish(false);
      const timer = setTimeout(() => finish(true), ms);
      if (signal) {
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) finish(false);
      }
    });
  }

  function notify(ctx, event, detail) {
    const c = ctx || {};
    const payload = { event, provider: 'voicebox' };
    ['callId', 'sessionId', 'callSessionId', 'generationId', 'generation', 'sentenceId', 'requestId'].forEach(function (key) {
      if (c[key] != null && (typeof c[key] === 'string' || typeof c[key] === 'number')) payload[key] = c[key];
    });
    const d = detail || {};
    if (d.status != null && Number.isFinite(Number(d.status))) payload.status = Number(d.status);
    if (typeof d.stage === 'string') payload.stage = d.stage;
    if (typeof d.reason === 'string') payload.reason = d.reason;
    if (d.generationId != null) payload.voiceboxGenerationId = String(d.generationId);
    if (typeof c.onDiagnostic === 'function') {
      try { c.onDiagnostic(payload); } catch (e) { /* diagnostics must not affect synthesis */ }
    } else if (event === 'cancel_failed') {
      /* A compact fallback diagnostic. Never log text, profile data, audio, or credentials. */
      try { console.warn('[IB Voicebox] ' + JSON.stringify(payload)); } catch (e) { /* ignore */ }
    }
  }

  /* 单次 HTTP 请求。外部 signal 表示调用方取消；本地 timer 表示 timeout，两者保持可区分。 */
  async function requestJson(pathname, options) {
    const opts = options || {};
    const base = endpoint();
    const url = base + pathname;
    const ctrl = new AbortController();
    const timeoutMs = opts.timeoutMs || requestTimeoutMs;
    let timedOut = false;
    const externalSignal = opts.signal || null;
    if (externalSignal && externalSignal.aborted) return { ok: false, cancelled: true };
    const onAbort = () => ctrl.abort();
    if (externalSignal) externalSignal.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, timeoutMs);
    try {
      if (externalSignal && externalSignal.aborted) return { ok: false, cancelled: true };
      const init = { method: opts.method || 'GET', signal: ctrl.signal };
      if (opts.body !== undefined) {
        init.headers = { 'Content-Type': 'application/json' };
        init.body = JSON.stringify(opts.body);
      }
      const res = await fetch(url, init);
      const text = await res.text().catch(() => '');
      if (externalSignal && externalSignal.aborted) return { ok: false, cancelled: true };
      if (!res.ok) {
        return { ok: false, status: res.status, error: 'Voicebox ' + pathname + ' failed (HTTP ' + res.status + '): ' + String(text || '').slice(0, 200) };
      }
      if (opts.expectJson === false) return { ok: true, status: res.status };
      let json = null;
      try { json = JSON.parse(text); } catch (e) { json = null; }
      if (json === null || typeof json !== 'object') {
        return { ok: false, status: res.status, error: 'Voicebox ' + pathname + ' 返回了非 JSON 响应（malformed response）' };
      }
      return { ok: true, status: res.status, data: json };
    } catch (e) {
      const msg = String(e && e.message || e).slice(0, 200);
      if (externalSignal && externalSignal.aborted) return { ok: false, cancelled: true };
      const isAbort = timedOut || (e && e.name === 'AbortError');
      return {
        ok: false,
        error: isAbort
          ? 'Voicebox 请求超时（' + Math.max(1, Math.ceil(timeoutMs / 1000)) + 's）：' + url
          : 'Voicebox 未连接（' + base + '）：' + msg
      };
    } finally {
      clearTimeout(timer);
      if (externalSignal && typeof externalSignal.removeEventListener === 'function') externalSignal.removeEventListener('abort', onAbort);
    }
  }

  /* GET /health —— 可见的健康检查；offline 时返回 ok:false，绝不假装在线。 */
  async function health() {
    if (!isEnabled()) return notConfigured();
    const r = await requestJson('/health', { timeoutMs: HEALTH_TIMEOUT_MS });
    if (!r.ok) return r;
    const d = r.data || {};
    return {
      ok: true,
      endpoint: endpoint(),
      status: String(d.status || ''),
      modelLoaded: !!d.model_loaded,
      gpuAvailable: !!d.gpu_available,
      gpuType: d.gpu_type ? String(d.gpu_type) : ''
    };
  }

  /* GET /profiles —— 只透传选择所必需的非秘密字段（profile id 是 IB 侧要保存的唯一标识）。 */
  async function profiles(signal) {
    if (!isEnabled()) return notConfigured();
    const r = await requestJson('/profiles', { timeoutMs: requestTimeoutMs, signal });
    if (!r.ok) return r;
    const list = Array.isArray(r.data) ? r.data : [];
    return {
      ok: true,
      endpoint: endpoint(),
      profiles: list.map(function (p) {
        return {
          id: String(p && p.id || ''),
          name: String(p && p.name || ''),
          language: String(p && p.language || ''),
          voiceType: String(p && p.voice_type || ''),
          defaultEngine: String(p && p.default_engine || '')
        };
      }).filter(function (p) { return !!p.id; })
    };
  }

  /* Voice Profile 解析：接受 profile id 或 name（大小写不敏感），与上游 /speak 的
     「name (case-insensitive) or id」优先级一致；IB 侧始终把**解析后的 id** 发给 /generate。 */
  async function resolveProfile(ref, signal) {
    const want = String(ref == null ? '' : ref).trim();
    if (!want) return { ok: false, error: 'Voicebox 需要选择 Voice Profile（voice.voiceId 为空）' };
    const list = await profiles(signal);
    if (!list.ok) return list;
    const lowered = want.toLowerCase();
    const byId = list.profiles.filter(function (p) { return p.id === want; })[0];
    if (byId) return { ok: true, profile: byId };
    const byName = list.profiles.filter(function (p) { return p.name.toLowerCase() === lowered; })[0];
    if (byName) return { ok: true, profile: byName };
    return { ok: false, error: 'Voicebox 未找到 Voice Profile：' + want + '（当前运行时共 ' + list.profiles.length + ' 个 profile）' };
  }

  /* GET /audio/{id} → 原始字节。返回 {ok,bytes,mime}；mime 取响应头，缺失时按 wav 兜底
     （上游 /audio 对生成结果是 wav，对导入音频沿用源格式）。 */
  async function fetchAudio(generationId, signal) {
    const base = endpoint();
    const url = base + '/audio/' + encodeURIComponent(generationId);
    const ctrl = new AbortController();
    let timedOut = false;
    if (signal && signal.aborted) return { ok: false, cancelled: true };
    const onAbort = () => ctrl.abort();
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    if (signal && signal.aborted) ctrl.abort();
    const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, audioTimeoutMs);
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      if (signal && signal.aborted) return { ok: false, cancelled: true };
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        if (signal && signal.aborted) return { ok: false, cancelled: true };
        return { ok: false, error: 'Voicebox /audio 获取失败 (HTTP ' + res.status + '): ' + String(text || '').slice(0, 200) };
      }
      const buf = Buffer.from(await res.arrayBuffer());
      if (!buf.length) return { ok: false, error: 'Voicebox 返回空音频（empty audio）' };
      const ct = String(res.headers.get('content-type') || '').split(';')[0].trim();
      return { ok: true, bytes: buf, mime: ct || 'audio/wav' };
    } catch (e) {
      const msg = String(e && e.message || e).slice(0, 200);
      if (signal && signal.aborted) return { ok: false, cancelled: true };
      return { ok: false, error: (timedOut || (e && e.name === 'AbortError')) ? ('Voicebox 音频下载超时：' + url) : ('Voicebox 未连接（' + base + '）：' + msg) };
    } finally {
      clearTimeout(timer);
      if (signal && typeof signal.removeEventListener === 'function') signal.removeEventListener('abort', onAbort);
    }
  }

  /* 轮询 GET /history/{id} 直到 completed / failed / 超时。
     上游 status: loading_model | generating | completed | failed。 */
  async function waitForGeneration(generationId, signal) {
    const deadline = Date.now() + generationTimeoutMs;
    for (;;) {
      if (signal && signal.aborted) return { ok: false, cancelled: true };
      const r = await requestJson('/history/' + encodeURIComponent(generationId), { timeoutMs: requestTimeoutMs, signal });
      if (r.cancelled) return r;
      if (!r.ok) return r;
      const d = r.data || {};
      const status = String(d.status || 'completed');
      if (status === 'completed') return { ok: true, generation: d };
      if (status === 'failed') {
        return { ok: false, error: 'Voicebox 生成失败：' + String(d.error || 'unknown') };
      }
      if (Date.now() >= deadline) {
        return { ok: false, error: 'Voicebox 生成超时（' + Math.round(generationTimeoutMs / 1000) + 's，最后状态 ' + status + '）' };
      }
      if (!await sleep(pollIntervalMs, signal)) return { ok: false, cancelled: true };
    }
  }

  function cancelledResult() {
    return { ok: false, cancelled: true, error: 'Voicebox generation cancelled' };
  }

  function raceWithSignal(promise, signal) {
    if (!signal) return Promise.resolve(promise).then(value => ({ value }));
    if (signal.aborted) return Promise.resolve({ cancelled: true });
    return new Promise(resolve => {
      let settled = false;
      const finish = result => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        resolve(result);
      };
      const onAbort = () => finish({ cancelled: true });
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) { onAbort(); return; }
      Promise.resolve(promise).then(value => finish({ value }), error => finish({ error }));
    });
  }

  function createGenerationCancellation(ctx) {
    const signal = ctx && ctx.signal;
    const state = { requested: false, generationId: '', promise: null };
    function sendCancel() {
      if (!state.generationId || state.promise) return state.promise;
      const id = state.generationId;
      state.promise = requestJson('/generate/' + encodeURIComponent(id) + '/cancel', {
        method: 'POST',
        timeoutMs: requestTimeoutMs,
        expectJson: false
      }).then(function (result) {
        if (result.ok) notify(ctx, 'cancel_acknowledged', { stage: 'cancel', generationId: id, status: result.status });
        else notify(ctx, 'cancel_failed', {
          stage: 'cancel', generationId: id,
          status: result.status,
          reason: result.error && result.error.indexOf('超时') !== -1 ? 'timeout' : 'request_failed'
        });
        return result;
      }).catch(function () {
        notify(ctx, 'cancel_failed', { stage: 'cancel', generationId: id, reason: 'request_failed' });
        return { ok: false, error: 'Voicebox generation cancellation request failed' };
      });
      return state.promise;
    }
    return {
      get requested() { return state.requested; },
      registerGenerationId: function (id) {
        state.generationId = String(id || '');
        if (state.generationId) notify(ctx, 'generation_created', { stage: 'generate', generationId: state.generationId });
        if (state.requested && state.generationId) void sendCancel();
      },
      request: function () {
        state.requested = true;
        if (state.generationId) void sendCancel();
      }
    };
  }

  /*
   * synthesize(profile, saveAudio) → {ok:true,id,url,bytes,ext,mime,duration,engine,lang}
   *
   * profile 是 bridge/tts.js 的 normalizeVoiceProfile 输出（统一内部形态）：
   *   { provider:'voicebox', model:<engine|''>, voice:{type,id,data}, language, style, rate, pitch, text }
   * 映射（唯一映射点，Test Voice 与生产共用）：
   *   text     → text（原样，IB 是「说什么」的 authority）
   *   voice.id → profile_id（先按 id/name 解析）
   *   model    → engine（留空则不发送，由 profile 决定）
   *   language → language（不在上游 enum 内则不发送）
   *   style    → instruct（交付/语气指令，max 500 上游限制）
   *   rate / pitch → 丢弃（上游无 prosody 参数，capabilities.prosody=false 已在上游被过滤）
   *   personality  → 恒为 false（禁止 Voicebox 改写 IB 文本）
   */
  async function synthesize(profile, saveAudio, ctx) {
    if (!isEnabled()) return notConfigured();
    if (typeof saveAudio !== 'function') return { ok: false, error: 'Voicebox adapter 缺少 saveAudio 依赖' };
    const signal = ctx && ctx.signal;
    const cancellation = createGenerationCancellation(ctx);
    const onAbort = () => cancellation.request();
    if (signal && signal.aborted) return cancelledResult();
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    try {
    const p = profile && typeof profile === 'object' ? profile : {};
    const text = String(p.text == null ? '' : p.text);
    if (!text.trim()) return { ok: false, error: 'No text to speak' };

    const resolved = await resolveProfile(p.voice && p.voice.id, signal);
    if (resolved.cancelled || (signal && signal.aborted)) return cancelledResult();
    if (!resolved.ok) return resolved;

    const body = {
      profile_id: resolved.profile.id,
      text: text,
      /* 不请求任何改写：IB 已经决定了要说什么。 */
      personality: false
    };
    const engine = (typeof p.model === 'string') ? p.model.trim() : '';
    if (engine) body.engine = engine;
    const language = (typeof p.language === 'string') ? p.language.trim() : '';
    if (language && LANGUAGES.indexOf(language) !== -1) body.language = language;
    const instruct = (typeof p.style === 'string') ? p.style.trim() : '';
    if (instruct) body.instruct = instruct.slice(0, 500);

    /* Keep the bounded /generate handshake alive after cancellation so an accepted
       upstream job ID is not lost. If cancellation wins this race, the late ID is
       immediately cancelled and never polled. */
    const createPromise = requestJson('/generate', { method: 'POST', body: body, timeoutMs: requestTimeoutMs });
    const createRace = await raceWithSignal(createPromise, signal);
    if (createRace.cancelled) {
      createPromise.then(function (late) {
        const lateId = late && late.ok && late.data && late.data.id;
        if (lateId) cancellation.registerGenerationId(lateId);
        else notify(ctx, 'cancel_failed', { stage: 'generate', reason: 'generation_id_unavailable' });
      }).catch(function () {
        notify(ctx, 'cancel_failed', { stage: 'generate', reason: 'generation_id_unavailable' });
      });
      return cancelledResult();
    }
    if (createRace.error) return { ok: false, error: String(createRace.error && createRace.error.message || createRace.error) };
    const created = createRace.value;
    if (!created.ok) return created;
    const generationId = String((created.data && created.data.id) || '');
    if (!generationId) return { ok: false, error: 'Voicebox 返回缺少 generation id（malformed response）' };
    cancellation.registerGenerationId(generationId);
    if ((signal && signal.aborted) || cancellation.requested) return cancelledResult();

    const done = await waitForGeneration(generationId, signal);
    if (done.cancelled || (signal && signal.aborted) || cancellation.requested) {
      cancellation.request();
      return cancelledResult();
    }
    if (!done.ok) return done;

    const audio = await fetchAudio(generationId, signal);
    if (audio.cancelled || (signal && signal.aborted) || cancellation.requested) {
      cancellation.request();
      return cancelledResult();
    }
    if (!audio.ok) return audio;

    /* Do not create a Bridge artifact if cancellation arrived after the download. */
    if (signal && signal.aborted) {
      cancellation.request();
      return cancelledResult();
    }

    const isWav = /wav/i.test(audio.mime);
    const saved = saveAudio(audio.bytes, {
      ext: isWav ? 'wav' : 'mp3',
      mime: isWav ? 'audio/wav' : 'audio/mpeg',
      duration: Number(done.generation && done.generation.duration) || 0,
      engine: String((done.generation && done.generation.engine) || engine || ''),
      profileName: resolved.profile.name,
      endpoint: endpoint()
    });
    if (!saved || !saved.ok) return saved || { ok: false, error: 'Voicebox 音频写入失败' };
    return saved;
    } finally {
      if (signal && typeof signal.removeEventListener === 'function') signal.removeEventListener('abort', onAbort);
    }
  }

  return { endpoint, isEnabled, health, profiles, resolveProfile, synthesize, DEFAULT_ENDPOINT, ENGINES, LANGUAGES };
}

module.exports = createVoicebox;
module.exports.DEFAULT_ENDPOINT = DEFAULT_ENDPOINT;
module.exports.ENGINES = ENGINES;
module.exports.LANGUAGES = LANGUAGES;
