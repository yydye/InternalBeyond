/* ====================================================================
   IB Memory · Counterfactual SHADOW — 模型 runner（R4-E）
   --------------------------------------------------------------------
   这是 R4-E 里唯一的有界传输 runner。R4-E 默认核心仍是独立 shadow；
   P21-R4-Q 是唯一生产调用方，并注入自己的严格 Q schema / validator。

   继承 R4-C / R4-D 的全部纪律（不重新发明）：
     · AUTO_RETRY = NONE，MAX_ATTEMPTS = 1
     · 超时**权威由调用方注入**；本 runner 不发明 20s/30s/60s
     · SAFETY_CAP_MS 只是**已有证据上界**（Repo 自身的 UNDERSTANDING_TIMEOUT_MS）
     · RUNNER_WAIT_BOUNDED = YES ≠ PROVIDER_EXECUTION_CANCELLATION_GUARANTEED = NO
     · deps.enabled !== true ⇒ 零调用；R4-Q 仅在显式条件问题与证据门通过后注入 true
     · calls ≤ 1 / 显式 invocation（不是 Tree-of-Thought，不自我辩论）
     · **绝不**为了拿 Interpretation / Expectation 偷偷触发 R4-C / R4-D runner
     · 任何失败 ⇒ fail open，绝不 fallback / retry / replay
   ==================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    var core = null;
    try { core = require('./counterfactual-shadow-core.js'); } catch (e) { core = null; }
    module.exports = factory(core);
  } else {
    root.IBMemoryCounterfactualShadowRunner = factory(root.IBMemoryCounterfactualShadow || null);
  }
})(typeof self !== 'undefined' ? self : this, function (DEFAULT_CORE) {
  'use strict';

  var SAFETY_CAP_MS = 120000;
  var SAFETY_CAP_SOURCE = 'services/home-node/understanding-derivation.js:70 UNDERSTANDING_TIMEOUT_MS';
  var DEFAULT_MAX_TOKENS = 1200;
  var AUTO_RETRY = 'NONE';
  var MAX_ATTEMPTS = 1;
  var RUNNER_WAIT_BOUNDED = true;
  var PROVIDER_EXECUTION_CANCELLATION_GUARANTEED = false;

  function isPlainObject(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }

  function unavailable(code, core) {
    var labels = (core && core.EPISTEMIC_LABELS) ? core.EPISTEMIC_LABELS.slice() : [];
    return {
      ok: false, durable: false, purpose: 'causal-learning', epistemicStatus: 'counterfactual',
      labels: labels, labelAuthority: 'system', noSecondLabelTaxonomy: true,
      observed: false, canonicalEvidence: false, causalLevel: 'hypothesis',
      causalRelationProven: false, evidenceWeight: 'NONE',
      intervention: null, interventionAuthority: 'CALLER_OR_SYSTEM_INPUT', items: [],
      counts: { requested: 0, returned: 0 },
      model: { providerClass: null, modelId: null, latencyMs: null, status: code, attempts: 0 },
      reasonCodes: [code],
      settlement: null, expectationRevision: null, interpretationRevision: null
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
    if (!core || typeof core.buildRequest !== 'function') return unavailable('counterfactual-core-missing', core);
    if (d.enabled !== true) return unavailable('counterfactual-shadow-disabled', core);
    var port = d.modelPort;
    if (!port || typeof port.run !== 'function') return unavailable('model-port-unavailable', core);

    /* ★ R4-E.1：intervention authority 在**输入侧**。模型调用之前就要成立；
       缺失或非法 ⇒ fail closed，**绝不**让模型补一个默认 intervention。 */
    var iv = core.normalizeIntervention(isPlainObject(input) ? input.intervention : null);
    if (!iv.ok) {
      var bad = unavailable(iv.reason, core);
      return bad;
    }

    var req;
    try { req = core.buildRequest(input); } catch (e) { return unavailable(core.REASON_CODES.shapeInvalid, core); }
    if (!req.stats.evidenceCount) return unavailable(core.REASON_CODES.noInput, core);

    /* 超时权威必须由调用方注入 —— 与 R4-C.1 / R4-D 同一纪律。 */
    var injected = Number(d.timeoutMs);
    if (!(injected > 0) || !isFinite(injected)) return unavailable('timeout-authority-missing', core);
    var timeoutMs = injected > SAFETY_CAP_MS ? SAFETY_CAP_MS : injected;
    var maxTokens = Number(d.maxTokens) > 0 ? Number(d.maxTokens) : DEFAULT_MAX_TOKENS;

    var controller = (typeof AbortController === 'function') ? new AbortController() : null;
    var timedOut = false;
    var outer = d.signal || null;
    var onAbort = null;
    if (outer) {
      if (outer.aborted) return unavailable('counterfactual-aborted', core);
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
      /* 上界钉在 runner 自己身上：端口忽略 signal 也不会让调用方悬挂。
         注意：**不能** unref 这个计时器 —— 否则事件循环可能在竞速结束前退出。 */
      var bound = new Promise(function (resolve) {
        setTimeout(function () { timedOut = true; resolve({ __timeout: true }); }, timeoutMs);
        if (controller) { try { controller.signal.addEventListener('abort', function () { resolve({ __timeout: true }); }); } catch (e) {} }
      });
      res = await Promise.race([Promise.resolve(portPromise), bound]);
      if (res && res.__timeout) {
        if (onAbort && outer) { try { outer.removeEventListener('abort', onAbort); } catch (e1) {} }
        try { Promise.resolve(portPromise).catch(function () {}); } catch (e2) {}
        return unavailable(timedOut ? 'counterfactual-timeout' : 'counterfactual-aborted', core);
      }
    } catch (e) {
      if (onAbort && outer) { try { outer.removeEventListener('abort', onAbort); } catch (e3) {} }
      return unavailable('counterfactual-transport-error', core);
    }
    if (onAbort && outer) { try { outer.removeEventListener('abort', onAbort); } catch (e4) {} }
    if (outer && outer.aborted) return unavailable('counterfactual-aborted', core);

    var text = extractText(res);
    if (text == null) return unavailable('counterfactual-transport-error', core);
    var parsed = null;
    try { parsed = typeof d.parseJson === 'function' ? d.parseJson(text) : JSON.parse(text); }
    catch (e) { return unavailable('counterfactual-json-invalid', core); }
    if (!isPlainObject(parsed)) return unavailable('counterfactual-json-invalid', core);

    var validated = core.validateResponse(parsed, {
      allowedMemoryIds: (input && input.selectedIds) || [],
      groundingText: input && input.groundingText,
      changedPremise: input && input.intervention && input.intervention.statement
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
