/* ====================================================================
   IB Wake Runtime Core — P26-8 · Wake Runtime Boundary Foundation
   --------------------------------------------------------------------
   回答一个问题：**一个 Wake Request 被谁消费、什么时候可以考虑 activation？**

     Wake Runtime = a runtime boundary that evaluates whether a Wake Request may proceed
                    toward activation.

   不是 Agent Runtime · 不是 Planner · 不是 Executor · 不是 Authority · 不是 Scheduler。

   ── 边界阶梯（本阶段只到 Wake Runtime 的 activation 判定）─────────────
     Feedback → Consumption → WAKE_ELIGIBLE → Wake Request
       → Wake Runtime        ← 本模块（终点：Activation Decision）
       → STOP
     （之后 Activation → Planner → Action → P25 Autonomy 全部是未来阶段，不实现。）

   ── 关键不等式 ──────────────────────────────────────────────────
     Wake Request       != Wake Runtime（请求对象 vs 请求评估）
     ACTIVATE_ELIGIBLE  != Agent Execution（**有资格进入未来 activation** ≠ 已激活）
     Activation         != Autonomy（是否进入未来 activation ≠ Action 是否可执行）
     Wake Runtime       != permission check（不是 permission check，也不是 action decision）

   ── Activation Vocabulary（闭集；刻意不用 P25 的 ALLOW/DENY）──────────
     ACTIVATE_ELIGIBLE · BLOCKED · REJECTED
     （唯一用途：表达"这条请求能否向未来 activation 前进"——不是授权，不是执行。）

   ── Responsibilities ────────────────────────────────────────────
     允许：consume Wake Request · validate request · evaluate runtime conditions ·
           produce activation result。
     禁止：start agent · call model · create action · call authority · execute capability ·
           排队 · 调度 · 持久化 · 发事件。

   ── 本模块**不是**（禁止的形态）──────────────────────────────────
     WakeManager · WakeService · ActivationScheduler · 队列 · 存储 · 事件总线 · Policy Engine。

   ── 纯度 ─────────────────────────────────────────────────────────
     零 DOM / 零 IndexedDB / 零 localStorage / 零 fetch / 零 IPC / 零模型 / 零权威 /
     零 executor / 零订阅 / 零定时器 / 零时钟（**不读 Date.now**）/ 零随机
     （**不用 Math.random**）；runtime context 全部由 caller **显式注入**。
   ==================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(null, require('./voice-message-core.js'), require('./wake-request-core.js'));
  } else {
    root.IBWakeRuntimeCore = factory(root, root.IBVoiceMessage, root.IBWakeRequestCore);
  }
})(typeof self !== 'undefined' ? self : this, function (root, VOICE, WAKE_REQUEST) {
  'use strict';

  var WAKE_RUNTIME_VERSION = 'wake-runtime/v1';
  /* 激活闭集（§5）：只有三个。**没有** ALLOW / DENY / EXECUTE（避免与 P25 Autonomy 冲突）。 */
  var ACTIVATIONS = Object.freeze(['ACTIVATE_ELIGIBLE', 'BLOCKED', 'REJECTED']);
  /* 原因码闭集（machine-readable；不是自然语言、不是 CoT）。 */
  var REASONS = Object.freeze([
    'activate-eligible',
    'runtime-unavailable',
    'already-active',
    'cancelled',
    'invalid-request',
    'invalid-context'
  ]);
  /* Context 是**闭集布尔字段**，全部由 caller 显式注入（§7：explicit injected）。
       runtimeAvailable —— 未来 activation 的运行时是否可用（**是 context 事实，不是投递/scheduler**）
       cancelled        —— 现有取消语义（P26-6 同义；取消 ⇒ 请求作废）
       alreadyActive    —— 该信号对应的角色/会话是否已在激活中（caller 事实，避免重复激活）
     **未纳入**：sessionActive（Session 只作为 context 事实，见 §8；不在此实现）、任何 resource 授权。 */
  var CONTEXT_FIELDS = Object.freeze(['runtimeAvailable', 'cancelled', 'alreadyActive']);
  var ALLOWED_RESULT_FIELDS = Object.freeze(['ok', 'activation', 'reason', 'wakeRequestId',
    'feedbackId', 'causationId', 'version', 'errors']);
  var WAKE_RUNTIME_ERRORS = Object.freeze([
    'not-an-object', 'unknown-field', 'bad-context-value', 'forbidden-context-field',
    'invalid-request', 'invalid-context', 'not-serializable', 'too-deep', 'not-json-value'
  ]);
  /* context / result **不得**成为凭据逃生舱，也不得复活 policy-only 或正文槽（§7）。 */
  var FORBIDDEN_CONTEXT_FIELDS = Object.freeze([
    'metadata', 'payload', 'data', 'content', 'body', 'text', 'record', 'state', 'dump',
    'contextdump', 'provider', 'model', 'prompt', 'llm', 'apikey', 'apisecret', 'token',
    'secret', 'credential', 'credentials', 'password', 'passwd', 'auth', 'authorization',
    'bearer', 'accesskey', 'privatekey', 'memory', 'memories', 'priority', 'urgency', 'rank',
    'schedule', 'deadline', 'retry'
  ]);

  function isObject(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
  function isPlainObject(v) {
    if (!isObject(v)) return false;
    var proto = Object.getPrototypeOf(v);
    return proto === Object.prototype || proto === null;
  }
  function str(v) { return v == null ? '' : String(v); }
  function dedupe(list) {
    var out = [];
    for (var i = 0; i < list.length; i++) if (out.indexOf(list[i]) < 0) out.push(list[i]);
    return out;
  }
  function deepFreeze(v) {
    if (Array.isArray(v)) { v.forEach(deepFreeze); return Object.freeze(v); }
    if (!isObject(v)) return v;
    Object.keys(v).forEach(function (k) { deepFreeze(v[k]); });
    return Object.freeze(v);
  }
  function isJsonValue(value, depth, errors, path) {
    var here = path || '';
    if (depth > 4) { errors.push('too-deep:' + here); return false; }
    if (value === null) return true;
    var t = typeof value;
    if (t === 'string') return true;
    if (t === 'number') return isFinite(value);
    if (t === 'boolean') return true;
    if (t === 'function' || t === 'symbol' || t === 'undefined' || t === 'bigint') { errors.push('not-json-value:' + here); return false; }
    if (Array.isArray(value)) {
      for (var i = 0; i < value.length; i++) if (!isJsonValue(value[i], depth + 1, errors, here + '[' + i + ']')) return false;
      return true;
    }
    if (!isPlainObject(value)) { errors.push('not-serializable:' + here); return false; }
    var keys = Object.keys(value);
    for (var k = 0; k < keys.length; k++) if (!isJsonValue(value[keys[k]], depth + 1, errors, here + '.' + keys[k])) return false;
    return true;
  }
  /* Wake Request 校验**委托**给 P26-7（唯一实现；不复制第二份校验器）。 */
  function requestVerdict(request) {
    if (WAKE_REQUEST && typeof WAKE_REQUEST.validateWakeRequest === 'function') return WAKE_REQUEST.validateWakeRequest(request);
    return { ok: false, errors: ['invalid-request'] };
  }
  /* ── Context 校验：闭集布尔字段；未知字段 / 禁用字段 / 非布尔值一律拒绝 ────── */
  function validateWakeContext(context) {
    var errors = [];
    if (!isPlainObject(context)) return { ok: false, errors: ['not-an-object'] };
    var keys = Object.keys(context);
    for (var i = 0; i < keys.length; i++) {
      var raw = String(keys[i]);
      var lower = raw.toLowerCase().replace(/[\s\-_]/g, '');
      if (FORBIDDEN_CONTEXT_FIELDS.indexOf(lower) >= 0) { errors.push('forbidden-context-field:' + raw); continue; }
      if (CONTEXT_FIELDS.indexOf(raw) < 0) { errors.push('unknown-field:' + raw); continue; }
      if (typeof context[raw] !== 'boolean') errors.push('bad-context-value:' + raw);
    }
    var jsonErrors = [], present = {};
    keys.forEach(function (k) { if (context[k] !== undefined) present[k] = context[k]; });
    if (!isJsonValue(present, 0, jsonErrors, '')) errors = errors.concat(jsonErrors);
    errors = dedupe(errors);
    return { ok: errors.length === 0, errors: errors };
  }
  /* 缺字段一律按 false（fail closed）；只有严格 true 才算"成立"。 */
  function fact(context, key) { return isPlainObject(context) && context[key] === true; }

  /* ── 唯一入口：纯评估（不修改 request、不产生副作用、不读时钟）──────────────
     只回答"这条 Wake Request 能否向未来 activation 前进"——**不是** permission check，
     **不是** action decision（§6），**不**执行、**不**调模型、**不**调用权威。
     判定顺序（deterministic；早期阶段先赢）：
       1) request 非法         → REJECTED / 'invalid-request'
       2) context 非法         → REJECTED / 'invalid-context'
       3) cancelled === true   → REJECTED / 'cancelled'
       4) alreadyActive === true → BLOCKED / 'already-active'
       5) runtimeAvailable !== true → BLOCKED / 'runtime-unavailable'
       6) 否则                 → ACTIVATE_ELIGIBLE / 'activate-eligible'
     **identity 审计（§15）：不引入 activationId** —— 结果是**判定**而非实体，
     没有需要跨阶段追踪的激活身份，因此不造身份、不用 random UUID。 */
  function evaluateWakeRequest(request, context) {
    var verdict = requestVerdict(request);
    if (!verdict.ok) {
      return deepFreeze({ ok: false, activation: 'REJECTED', reason: 'invalid-request',
        wakeRequestId: '', feedbackId: '', version: WAKE_RUNTIME_VERSION, errors: verdict.errors });
    }
    var ctxVerdict = validateWakeContext(context);
    if (!ctxVerdict.ok) {
      return deepFreeze({ ok: false, activation: 'REJECTED', reason: 'invalid-context',
        wakeRequestId: str(request.wakeRequestId), feedbackId: str(request.feedbackId),
        version: WAKE_RUNTIME_VERSION, errors: ctxVerdict.errors });
    }
    var activation = 'ACTIVATE_ELIGIBLE', reason = 'activate-eligible';
    if (fact(context, 'cancelled')) { activation = 'REJECTED'; reason = 'cancelled'; }
    else if (fact(context, 'alreadyActive')) { activation = 'BLOCKED'; reason = 'already-active'; }
    else if (!fact(context, 'runtimeAvailable')) { activation = 'BLOCKED'; reason = 'runtime-unavailable'; }
    var out = {
      ok: true, activation: activation, reason: reason,
      wakeRequestId: str(request.wakeRequestId), feedbackId: str(request.feedbackId),
      version: WAKE_RUNTIME_VERSION, errors: []
    };
    if (str(request.causationId)) out.causationId = str(request.causationId);
    return deepFreeze(out);
  }
  /* ── Describe：给诊断/日志用的**无正文**摘要（reason/activation 都是闭集词）──── */
  function describeWakeResult(result) {
    var r = isPlainObject(result) ? result : {};
    return {
      ok: r.ok === true,
      version: WAKE_RUNTIME_VERSION,
      activation: str(r.activation),
      reason: str(r.reason),
      wakeRequestId: str(r.wakeRequestId),
      feedbackId: str(r.feedbackId),
      hasCausationId: !!str(r.causationId),
      errors: Array.isArray(r.errors) ? r.errors.slice(0, 8) : []
    };
  }

  return {
    WAKE_RUNTIME_VERSION: WAKE_RUNTIME_VERSION,
    ACTIVATIONS: ACTIVATIONS,
    REASONS: REASONS,
    CONTEXT_FIELDS: CONTEXT_FIELDS,
    FORBIDDEN_CONTEXT_FIELDS: FORBIDDEN_CONTEXT_FIELDS,
    ALLOWED_RESULT_FIELDS: ALLOWED_RESULT_FIELDS,
    WAKE_RUNTIME_ERRORS: WAKE_RUNTIME_ERRORS,
    evaluateWakeRequest: evaluateWakeRequest,
    validateWakeContext: validateWakeContext,
    describeWakeResult: describeWakeResult
  };
});
