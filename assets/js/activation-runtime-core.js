/* ====================================================================
   IB Activation Runtime Core — P26-10 · Activation Runtime Boundary Foundation
   --------------------------------------------------------------------
   回答一个问题：**一条 Activation Intent 如何进入未来的 agent activation pipeline？**

     Activation Runtime = a runtime boundary that accepts Activation Intent and evaluates
                          whether it may enter an agent activation pipeline.

   不是 Agent Runtime · 不是 Planner · 不是 Executor · 不是 Authority。

   ── 边界阶梯（本阶段只到 Activation Runtime 的 readiness 判定）─────────
     Feedback → Consumption → Wake Request → Wake Runtime → Activation Intent
       → Activation Runtime   ← 本模块（终点：readiness 判定）
       → STOP
     （之后 Agent Runtime → Planner → Action → P25 Autonomy 全部是未来阶段，不实现。）

   ── 关键不等式 ──────────────────────────────────────────────────
     Activation Intent  != Activation Runtime（意图对象 vs 对它的评估）
     READY              != Agent Start（**可进入未来 pipeline** ≠ 已启动 agent）
     Activation Runtime != Autonomy（能否进入 pipeline ≠ Action 是否可执行）

   ── Result Vocabulary（闭集；刻意不用 P25 的 ALLOW/DENY）──────────────
     READY · BLOCKED · REJECTED

   ── Responsibilities ────────────────────────────────────────────
     允许：consume Activation Intent · validate intent · evaluate activation context ·
           produce activation readiness result。
     禁止：start agent · call model · create action · call planner · call authority ·
           排队 · 调度 · 持久化 · 发事件。

   ── 本模块**不是**（禁止的形态）──────────────────────────────────
     ActivationManager · AgentStarter · WakeService · 队列 · 存储 · 事件总线 · Policy Engine。

   ── 纯度 ─────────────────────────────────────────────────────────
     零 DOM / 零 IndexedDB / 零 localStorage / 零 fetch / 零 IPC / 零模型 / 零权威 /
     零 executor / 零订阅 / 零定时器 / 零时钟（**不读 Date.now**）/ 零随机
     （**不用 Math.random**）；activation context 全部由 caller **显式注入**。
   ==================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(null, require('./voice-message-core.js'), require('./activation-intent-core.js'));
  } else {
    root.IBActivationRuntimeCore = factory(root, root.IBVoiceMessage, root.IBActivationIntentCore);
  }
})(typeof self !== 'undefined' ? self : this, function (root, VOICE, ACTIVATION_INTENT) {
  'use strict';

  var ACTIVATION_RUNTIME_VERSION = 'activation-runtime/v1';
  /* readiness 闭集（§5）：只有三个。**没有** ALLOW / DENY / EXECUTE。 */
  var READINESS = Object.freeze(['READY', 'BLOCKED', 'REJECTED']);
  /* 原因码闭集（machine-readable；不是自然语言、不是 CoT）。 */
  var REASONS = Object.freeze([
    'ready',
    'runtime-unavailable',
    'target-unavailable',
    'cancelled',
    'invalid-intent',
    'invalid-context'
  ]);
  /* Context 是**闭集布尔字段**，全部由 caller 显式注入（§7）：
       runtimeAvailable —— 未来 agent activation pipeline 的运行时是否可用
       targetAvailable  —— 该 activation 的目标（角色/会话）是否可用（caller 事实）
       cancelled        —— 现有取消语义；取消 ⇒ 意图作废（REJECTED）
     **未纳入**：任何 session / resource 授权（那些只作 caller 的显式事实来源）。 */
  var CONTEXT_FIELDS = Object.freeze(['runtimeAvailable', 'targetAvailable', 'cancelled']);
  var ALLOWED_RESULT_FIELDS = Object.freeze(['ok', 'readiness', 'reason', 'activationIntentId',
    'wakeRequestId', 'feedbackId', 'causationId', 'version', 'errors']);
  var ACTIVATION_RUNTIME_ERRORS = Object.freeze([
    'not-an-object', 'unknown-field', 'bad-context-value', 'forbidden-context-field',
    'invalid-intent', 'invalid-context', 'not-serializable', 'too-deep', 'not-json-value'
  ]);
  /* context / result **不得**成为凭据逃生舱，也不得复活 policy-only / 正文槽（§7）。 */
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
  /* Activation Intent 校验**委托**给 P26-9（唯一实现；不复制第二份校验器）。 */
  function intentVerdict(intent) {
    if (ACTIVATION_INTENT && typeof ACTIVATION_INTENT.validateActivationIntent === 'function') return ACTIVATION_INTENT.validateActivationIntent(intent);
    return { ok: false, errors: ['invalid-intent'] };
  }
  /* ── Context 校验：闭集布尔字段；未知字段 / 禁用字段 / 非布尔值一律拒绝 ────── */
  function validateActivationContext(context) {
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

  /* ── 唯一入口：纯评估（不修改 intent、不产生副作用、不读时钟）────────────────
     只回答"这条 Activation Intent 能否进入未来 agent activation pipeline"——
     **不**启动 agent、**不**调模型、**不**调 planner、**不**创建 action。
     identity 审计（§6）：**不引入 activationRequestId** —— 结果是对**已有 Intent**的判定，
     intent 已持有 activationIntentId，无需再造第二个运行时身份。
     判定顺序（deterministic；早期阶段先赢）：
       1) intent 非法            → REJECTED / 'invalid-intent'
       2) context 非法           → REJECTED / 'invalid-context'
       3) cancelled === true     → REJECTED / 'cancelled'
       4) targetAvailable !== true → BLOCKED / 'target-unavailable'
       5) runtimeAvailable !== true → BLOCKED / 'runtime-unavailable'
       6) 否则                   → READY / 'ready' */
  function evaluateActivationIntent(intent, context) {
    var verdict = intentVerdict(intent);
    if (!verdict.ok) {
      return deepFreeze({ ok: false, readiness: 'REJECTED', reason: 'invalid-intent',
        activationIntentId: '', wakeRequestId: '', feedbackId: '', version: ACTIVATION_RUNTIME_VERSION,
        errors: verdict.errors });
    }
    var ctxVerdict = validateActivationContext(context);
    if (!ctxVerdict.ok) {
      return deepFreeze({ ok: false, readiness: 'REJECTED', reason: 'invalid-context',
        activationIntentId: str(intent.activationIntentId), wakeRequestId: str(intent.wakeRequestId),
        feedbackId: str(intent.feedbackId), version: ACTIVATION_RUNTIME_VERSION, errors: ctxVerdict.errors });
    }
    var readiness = 'READY', reason = 'ready';
    if (fact(context, 'cancelled')) { readiness = 'REJECTED'; reason = 'cancelled'; }
    else if (!fact(context, 'targetAvailable')) { readiness = 'BLOCKED'; reason = 'target-unavailable'; }
    else if (!fact(context, 'runtimeAvailable')) { readiness = 'BLOCKED'; reason = 'runtime-unavailable'; }
    var out = {
      ok: true, readiness: readiness, reason: reason,
      activationIntentId: str(intent.activationIntentId), wakeRequestId: str(intent.wakeRequestId),
      feedbackId: str(intent.feedbackId), version: ACTIVATION_RUNTIME_VERSION, errors: []
    };
    if (str(intent.causationId)) out.causationId = str(intent.causationId);
    return deepFreeze(out);
  }
  /* ── Describe：给诊断/日志用的**无正文**摘要（reason/readiness 都是闭集词）──── */
  function describeActivationResult(result) {
    var r = isPlainObject(result) ? result : {};
    return {
      ok: r.ok === true,
      version: ACTIVATION_RUNTIME_VERSION,
      readiness: str(r.readiness),
      reason: str(r.reason),
      activationIntentId: str(r.activationIntentId),
      wakeRequestId: str(r.wakeRequestId),
      feedbackId: str(r.feedbackId),
      hasCausationId: !!str(r.causationId),
      errors: Array.isArray(r.errors) ? r.errors.slice(0, 8) : []
    };
  }

  return {
    ACTIVATION_RUNTIME_VERSION: ACTIVATION_RUNTIME_VERSION,
    READINESS: READINESS,
    REASONS: REASONS,
    CONTEXT_FIELDS: CONTEXT_FIELDS,
    FORBIDDEN_CONTEXT_FIELDS: FORBIDDEN_CONTEXT_FIELDS,
    ALLOWED_RESULT_FIELDS: ALLOWED_RESULT_FIELDS,
    ACTIVATION_RUNTIME_ERRORS: ACTIVATION_RUNTIME_ERRORS,
    evaluateActivationIntent: evaluateActivationIntent,
    validateActivationContext: validateActivationContext,
    describeActivationResult: describeActivationResult
  };
});
