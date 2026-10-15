/* ====================================================================
   IB Memory · Expectation SHADOW — 模型 runner（R4-D）
   --------------------------------------------------------------------
   这是 R4-D 里**唯一**会发起模型调用的文件，而它**没有任何生产调用方**。

   ── 为什么生产默认不接 ──────────────────────────────────────────────
     与 R4-C 同一个理由（见 contract §24.9(c)/(j)）：recall 调用链是 async
     且被 chat 回合 await；模型调用不可能同步 ⇒ 在关键路径插入必然推迟首 token。
     R4-C 的结论 `MODEL-PORT-PROTOCOL-READY` / production execution boundary
     **unresolved** 继续适用，本阶段**未**新增任何 route/command。

   ── 继承 R4-C.1 的全部纪律 ──────────────────────────────────────────
     · AUTO_RETRY = NONE，MAX_ATTEMPTS = 1（§38）
     · 超时**权威由调用方注入**；本 runner 不发明 20s/30s/60s（§37）
     · `RUNNER_WAIT_BOUNDED = YES` ≠ `PROVIDER_EXECUTION_CANCELLATION_GUARANTEED = NO`
     · `deps.enabled !== true` ⇒ 零调用（默认 OFF，不新增用户设置页）（§39）
     · 任何失败 ⇒ fail open，绝不 fallback / retry / replay
     · **绝不**为了拿 Interpretation 偷偷触发 R4-C runner（§9）
   ==================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    var core = null;
    try { core = require('./expectation-shadow-core.js'); } catch (e) { core = null; }
    module.exports = factory(core);
  } else {
    root.IBMemoryExpectationShadowRunner = factory(root.IBMemoryExpectationShadow || null);
  }
})(typeof self !== 'undefined' ? self : this, function (DEFAULT_CORE) {
  'use strict';

  /* 上界（**不是** policy）：取仓库已有的 derivation 天花板。 */
  var SAFETY_CAP_MS = 120000;
  var SAFETY_CAP_SOURCE = 'services/home-node/understanding-derivation.js:70 UNDERSTANDING_TIMEOUT_MS';
  var DEFAULT_MAX_TOKENS = 1200;
  var AUTO_RETRY = 'NONE';
  var MAX_ATTEMPTS = 1;
  var RUNNER_WAIT_BOUNDED = true;
  var PROVIDER_EXECUTION_CANCELLATION_GUARANTEED = false;

  function isPlainObject(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }

  function unavailable(code) {
    return {
      ok: false, durable: false, epistemicStatus: 'prediction', items: [],
      counts: { requested: 0, returned: 0 },
      model: { providerClass: null, modelId: null, latencyMs: null, status: code, attempts: 0 },
      reasonCodes: [code],
      metaMemoryState: null, behaviorEffectsApplied: [],
      behaviorInfluenceStatus: 'not-evaluated'
    };
  }
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

  async function runShadow(input, deps) {
    var d = isPlainObject(deps) ? deps : {};
    var core = d.core || DEFAULT_CORE;
    if (!core || typeof core.buildRequest !== 'function') return unavailable('expectation-core-missing');
    if (d.enabled !== true) return unavailable('expectation-shadow-disabled');
    var port = d.modelPort;
    if (!port || typeof port.run !== 'function') return unavailable(core.REASON_CODES.noInput === '' ? 'x' : 'model-port-unavailable');

    var req;
    try { req = core.buildRequest(input); } catch (e) { return unavailable(core.REASON_CODES.shapeInvalid); }
    if (!req.stats.evidenceCount) return unavailable(core.REASON_CODES.noInput);

    /* 超时权威必须由调用方注入 —— 与 R4-C.1 同一纪律。 */
    var injected = Number(d.timeoutMs);
    if (!(injected > 0) || !isFinite(injected)) return unavailable('timeout-authority-missing');
    var timeoutMs = injected > SAFETY_CAP_MS ? SAFETY_CAP_MS : injected;
    var maxTokens = Number(d.maxTokens) > 0 ? Number(d.maxTokens) : DEFAULT_MAX_TOKENS;

    var controller = (typeof AbortController === 'function') ? new AbortController() : null;
    var timedOut = false;
    var outer = d.signal || null;
    var onAbort = null;
    if (outer) {
      if (outer.aborted) return unavailable('expectation-aborted');
      onAbort = function () { if (controller) controller.abort(); };
      try { outer.addEventListener('abort', onAbort); } catch (e) { onAbort = null; }
    }
    var startedAt = (typeof d.now === 'function') ? d.now() : null;
    var res = null;
    try {
      var portPromise = port.run({
        spec: d.spec || null,
        prompt: { system: req.system, messages: [{ role: 'user', content: req.user }] },
        messages: [{ role: 'user', content: req.user }],
        maxTokens: maxTokens,
        jsonMode: true,
        signal: controller ? controller.signal : (outer || undefined)
      });
      /* 上界钉在 runner 自己身上：端口忽略 signal 也不会让调用方悬挂。 */
      var bound = new Promise(function (resolve) {
        var t = setTimeout(function () { timedOut = true; resolve({ __timeout: true }); }, timeoutMs);
        if (controller) { try { controller.signal.addEventListener('abort', function () { resolve({ __timeout: true }); }); } catch (e) {} }
      });
      res = await Promise.race([Promise.resolve(portPromise), bound]);
      if (res && res.__timeout) {
        if (onAbort && outer) { try { outer.removeEventListener('abort', onAbort); } catch (e1) {} }
        try { Promise.resolve(portPromise).catch(function () {}); } catch (e2) {}
        return unavailable(timedOut ? 'expectation-timeout' : 'expectation-aborted');
      }
    } catch (e) {
      if (onAbort && outer) { try { outer.removeEventListener('abort', onAbort); } catch (e3) {} }
      return unavailable('expectation-transport-error');
    }
    if (onAbort && outer) { try { outer.removeEventListener('abort', onAbort); } catch (e4) {} }
    if (outer && outer.aborted) return unavailable('expectation-aborted');

    var text = extractText(res);
    if (text == null) return unavailable('expectation-transport-error');
    var parsed = null;
    try { parsed = typeof d.parseJson === 'function' ? d.parseJson(text) : JSON.parse(text); }
    catch (e) { return unavailable('expectation-json-invalid'); }
    if (!isPlainObject(parsed)) return unavailable('expectation-json-invalid');

    var validated = core.validateResponse(parsed, {
      allowedMemoryIds: (input && input.selectedIds) || [],
      independentObservationCount: d.independentObservationCount
    });
    var latency = (startedAt != null && typeof d.now === 'function') ? (Number(d.now()) - Number(startedAt)) : null;
    return core.assembleShadow(input, validated, {
      providerClass: d.providerClass || null,
      modelId: d.modelId || null,
      latencyMs: latency,
      status: validated.ok ? 'ok' : 'no-valid-item'
    });
  }

  return {
    runShadow: runShadow,
    AUTO_RETRY: AUTO_RETRY,
    MAX_ATTEMPTS: MAX_ATTEMPTS,
    SAFETY_CAP_MS: SAFETY_CAP_MS,
    SAFETY_CAP_SOURCE: SAFETY_CAP_SOURCE,
    RUNNER_WAIT_BOUNDED: RUNNER_WAIT_BOUNDED,
    PROVIDER_EXECUTION_CANCELLATION_GUARANTEED: PROVIDER_EXECUTION_CANCELLATION_GUARANTEED,
    DEFAULT_MAX_TOKENS: DEFAULT_MAX_TOKENS,
    isEnabled: function (deps) { return isPlainObject(deps) && deps.enabled === true; }
  };
});
