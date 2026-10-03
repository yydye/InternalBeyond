/* ====================================================================
   IB Memory · MemoryInterpretation SHADOW — 模型 runner（R4-C）
   --------------------------------------------------------------------
   这是 R4-C 里**唯一**会发起模型调用的文件，而它**没有任何生产调用方**。

   ── 为什么生产默认不接（§30，这是刻意的交付形态）────────────────────
     `getMemoryContext` 是 **async 且被 chat 回合 await**（communication.js
     里 `const memCtx = await getMemoryContext(...)` 位于首 token 之前）；
     `memory-recall-orchestrator.turnRecall` 则是**同步**的。
     模型调用不可能同步 ⇒ 在关键路径上插入它必然推迟首 token。
     因此 R4-C 交付 **MODEL-READY SHADOW，生产 invocation = DISABLED**，
     而不是为了"完成"牺牲响应延迟。

   ── 纪律 ────────────────────────────────────────────────────────────
     · AUTO_RETRY = NONE —— 影子不该在用户看不见的地方连续烧调用与费用
     · 单次调用（§16：ONE BATCH CALL PER TURN MAX，绝不 N+1）
     · 有界 timeout + 支持 AbortSignal（§29）
     · 任何失败一律 fail open（返回 unavailable），**绝不**抛出、
       **绝不** fallback 到别的模型、**绝不** background replay
     · 只把 `memory-interpretation-core` 装好的结构化信封交给模型端口

   模型端口形状**复用**既有 Understanding derivation 的那一个
   （`services/home-node/understanding-derivation.js:84` 的 `deps.modelPort`，
   以及 `execution.js` 的 NodeModelPort：`port.run({ spec, prompt, messages,
   maxTokens, jsonMode, jsonPrefill })`）—— **不新造第三套模型框架**。
   ==================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    var core = null;
    try { core = require('./memory-interpretation-core.js'); } catch (e) { core = null; }
    module.exports = factory(core);
  } else {
    root.IBMemoryInterpretationRunner = factory(root.IBMemoryInterpretationCore || null);
  }
})(typeof self !== 'undefined' ? self : this, function (DEFAULT_CORE) {
  'use strict';

  /* ── 超时权威（R4-C.1 §12）──────────────────────────────────────────
     本 runner **不拥有**超时策略。曾经的 `DEFAULT_TIMEOUT_MS = 20000` 是
     **凭空发明**的 —— 仓库里没有任何依据支持 20s，把它描述成 provider policy
     是过度声明。现在：

       · 调用方**必须**显式注入 `timeoutMs`；缺失 ⇒ `timeout-authority-missing`；
       · `SAFETY_CAP_MS` 只是一个**上界**（不是 policy）—— 它取仓库**已有**的
         `UNDERSTANDING_TIMEOUT_MS = 120000`（services/home-node/understanding-derivation.js:70）
         作为本项目 derivation 类调用的既有天花板，是**有证据的**取值。 */
  var SAFETY_CAP_MS = 120000;
  var DEFAULT_MAX_TOKENS = 1400;
  var AUTO_RETRY = 'NONE';
  var MAX_ATTEMPTS = 1;

  /* ── 三个**不同**的概念（R4-C.1 §9，绝不再用一个词概括三者）──────────
       RUNNER_WAIT_TIMEOUT  : runner 等结果多久 —— 由 Promise.race 保证，**已证明**
       CLIENT_REQUEST_ABORT : 客户端请求是否真的被取消 —— 取决于 port 是否尊重 signal
       PROVIDER_EXECUTION   : 上游是否已停止计算（以及费用是否停止）—— **未证明**

     本 runner 只**转发** signal，**不**保证后两者。 */
  var RUNNER_WAIT_BOUNDED = true;
  var PROVIDER_EXECUTION_CANCELLATION_GUARANTEED = false;

  function isPlainObject(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }

  function unavailable(code, extra) {
    return Object.assign({
      ok: false,
      durable: false,
      items: [],
      missingFor: [],
      rejected: [],
      counts: { requested: 0, returned: 0 },
      model: { providerClass: null, modelId: null, latencyMs: null, status: code, attempts: 0 },
      reasonCodes: [code],
      metaMemoryState: null,
      recollectionQuality: null
    }, extra || {});
  }

  /* 提取端口返回的文本。端口形状可能有两种（既有仓库里都存在）：
       · { ok, text }        —— 信封式
       · 裸字符串 / { content } */
  function extractText(res) {
    if (res == null) return null;
    if (typeof res === 'string') return res;
    if (isPlainObject(res)) {
      if (typeof res.text === 'string') return res.text;
      if (typeof res.content === 'string') return res.content;
      if (res.ok === false) return null;
    }
    return null;
  }

  /* ── 单次批量解释。**永不抛出**。────────────────────────────────────── */
  async function runShadow(input, deps) {
    var d = isPlainObject(deps) ? deps : {};
    var core = d.core || DEFAULT_CORE;
    if (!core || typeof core.buildRequest !== 'function') return unavailable('interpretation-core-missing');
    if (d.enabled !== true) return unavailable('interpretation-shadow-disabled');
    var port = d.modelPort;
    if (!port || typeof port.run !== 'function') return unavailable(core.REASON_CODES.portMissing);

    var req;
    try { req = core.buildRequest(input); }
    catch (e) { return unavailable(core.REASON_CODES.shapeInvalid); }
    if (!req.stats.memoryCount) return unavailable(core.REASON_CODES.noInput);

    /* 超时权威必须由调用方注入 —— 本 runner 不发明 policy。 */
    var injected = Number(d.timeoutMs);
    if (!(injected > 0) || !isFinite(injected)) return unavailable('timeout-authority-missing');
    var timeoutMs = injected > SAFETY_CAP_MS ? SAFETY_CAP_MS : injected;
    var maxTokens = Number(d.maxTokens) > 0 ? Number(d.maxTokens) : DEFAULT_MAX_TOKENS;
    var controller = (typeof AbortController === 'function') ? new AbortController() : null;
    var timer = null;
    var timedOut = false;
    var outer = d.signal || null;
    var onAbort = null;
    if (outer) {
      if (outer.aborted) return unavailable(core.REASON_CODES.aborted);
      onAbort = function () { if (controller) controller.abort(); };
      try { outer.addEventListener('abort', onAbort); } catch (e) { onAbort = null; }
    }
    if (controller) {
      timer = setTimeout(function () { timedOut = true; controller.abort(); }, timeoutMs);
    }

    var startedAt = (typeof d.now === 'function') ? d.now() : null;
    var res = null;
    try {
      /* ★ 单次调用。MAX_ATTEMPTS = 1；没有任何 retry 循环。
         ★ 超时**不能**只依赖端口尊重 AbortSignal —— 端口是外部实现，
           它完全可能忽略 signal。因此这里用 Promise.race 把上界钉在
           runner 自己身上：无论端口是否配合，runShadow 一定在有界时间内返回。 */
      var portPromise = port.run({
        spec: d.spec || null,
        prompt: { system: req.system, messages: [{ role: 'user', content: req.user }] },
        messages: [{ role: 'user', content: req.user }],
        maxTokens: maxTokens,
        jsonMode: true,
        signal: controller ? controller.signal : (outer || undefined)
      });
      var bound = new Promise(function (resolve) {
        var t = setTimeout(function () { timedOut = true; resolve({ __timeout: true }); }, timeoutMs);
        if (typeof t === 'object' && t && typeof t.unref === 'function') t.unref();
        if (controller) {
          try { controller.signal.addEventListener('abort', function () { resolve({ __timeout: true }); }); } catch (e) {}
        }
      });
      res = await Promise.race([Promise.resolve(portPromise), bound]);
      if (res && res.__timeout) {
        if (timer) clearTimeout(timer);
        if (onAbort && outer) { try { outer.removeEventListener('abort', onAbort); } catch (e4) {} }
        var code0 = timedOut ? core.REASON_CODES.timeout : core.REASON_CODES.aborted;
        if ((outer && outer.aborted) && !timedOut) code0 = core.REASON_CODES.aborted;
        /* 端口若最终 reject，必须被吞掉，否则会变成 unhandled rejection。 */
        try { Promise.resolve(portPromise).catch(function () {}); } catch (e5) {}
        return unavailable(code0);
      }
    } catch (e) {
      if (timer) clearTimeout(timer);
      if (onAbort && outer) { try { outer.removeEventListener('abort', onAbort); } catch (e2) {} }
      var code = timedOut ? core.REASON_CODES.timeout
        : (e && (e.name === 'AbortError' || e.code === 'ABORT_ERR') ? core.REASON_CODES.aborted : core.REASON_CODES.transport);
      return unavailable(code);
    }
    if (timer) clearTimeout(timer);
    if (onAbort && outer) { try { outer.removeEventListener('abort', onAbort); } catch (e3) {} }
    if (timedOut) return unavailable(core.REASON_CODES.timeout);
    if (outer && outer.aborted) return unavailable(core.REASON_CODES.aborted);

    var text = extractText(res);
    if (text == null) return unavailable(core.REASON_CODES.transport);

    var parsed = null;
    try {
      parsed = typeof d.parseJson === 'function' ? d.parseJson(text) : JSON.parse(text);
    } catch (e) { return unavailable(core.REASON_CODES.parseFailed); }
    if (!isPlainObject(parsed)) return unavailable(core.REASON_CODES.parseFailed);

    var validated = core.validateResponse(parsed, { allowedIds: (input && input.selectedIds) || [] });
    var latency = (startedAt != null && typeof d.now === 'function') ? (Number(d.now()) - Number(startedAt)) : null;
    var shadow = core.assembleShadow(input, validated, {
      providerClass: d.providerClass || null,
      modelId: d.modelId || null,
      latencyMs: latency,
      status: validated.ok ? (validated.items.length < ((input && input.selectedIds) || []).length ? 'partial' : 'ok') : 'no-valid-item'
    });
    return shadow;
  }

  return {
    runShadow: runShadow,
    AUTO_RETRY: AUTO_RETRY,
    MAX_ATTEMPTS: MAX_ATTEMPTS,
    DEFAULT_TIMEOUT_MS: undefined,   /* 已删除：本 runner **不**拥有超时 policy */
    /* 三个概念分别暴露，调用方不得把它们混成一个 "bounded" 断言。 */
    SAFETY_CAP_MS: SAFETY_CAP_MS,
    SAFETY_CAP_SOURCE: 'services/home-node/understanding-derivation.js:70 UNDERSTANDING_TIMEOUT_MS',
    RUNNER_WAIT_BOUNDED: RUNNER_WAIT_BOUNDED,
    PROVIDER_EXECUTION_CANCELLATION_GUARANTEED: PROVIDER_EXECUTION_CANCELLATION_GUARANTEED,
    DEFAULT_MAX_TOKENS: DEFAULT_MAX_TOKENS,
    /* 生产开关：**默认 OFF**。R4-C 不新增用户可见设置页（§8）。 */
    isEnabled: function (deps) {
      var d = isPlainObject(deps) ? deps : {};
      return d.enabled === true;
    }
  };
});
