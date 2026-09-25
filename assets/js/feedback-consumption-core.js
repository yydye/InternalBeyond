/* ====================================================================
   IB Feedback Consumption Core — P26-6 · Feedback Consumption &
   Wake Eligibility Contract
   --------------------------------------------------------------------
   回答一个问题：**一个 Feedback 被消费后，能得出什么"注意力处理结论"？**

     Feedback Consumption = a pure evaluation of a Feedback signal against explicit
                            context to determine its attention disposition.

   处置闭集（§8）：IGNORE · OBSERVE · WAKE_ELIGIBLE。**没有** EXECUTE / ACTION /
   ALLOW / DENY / RUN / SEND / POST / DEFER。

   ── 冻结的层间不变量（§2：不得压缩）──────────────────────────────────
     FEEDBACK_AVAILABLE != FEEDBACK_CONSUMED
     FEEDBACK_CONSUMED  != WAKE_ELIGIBLE
     WAKE_ELIGIBLE      != WAKE_REQUESTED
     WAKE_REQUESTED     != AGENT_WOKEN
     AGENT_WOKEN        != ACTION_CREATED
     ACTION_CREATED     != ACTION_ALLOWED
     ACTION_ALLOWED     != ACTION_EXECUTED
   本模块**只到 WAKE_ELIGIBLE** —— 它是**policy 结论**，不是命令、不是执行、不是唤醒。

   ── P25 Boundary（§3：不得成为第二套 Autonomy Core）──────────────────
     · 输入是 **Feedback**（不是 Action）；不回答"应该执行什么动作"；
     · 不调用 Autonomy Core / 任何域权威，不做 permission decision，不选 capability；
     · 不创建 action、不调 executor、不调模型、不发通知、不排队、不调度、不持久化。

   ── 命名（§4）───────────────────────────────────────────────────────
     **不是** autonomy-policy.js / agent-policy.js / action-policy.js（避免与 P25 Autonomy 混淆）；
     Consumption 与 Wake Eligibility 是同一个最小纯契约，因此**合并**在本文件（已证明同职责：
     两者都只是"这个信号是否值得未来 runtime 进一步处理"）。

   ── 纯度 ─────────────────────────────────────────────────────────────
     零 DOM / 零 IndexedDB / 零 localStorage / 零 fetch / 零 IPC / 零 provider / 零模型 /
     零权威 / 零 executor / 零订阅 / 零定时器 / 零时钟（**不读 Date.now**）/
     零随机（**不用 Math.random**）；context 由 caller 提供（Core 不持有状态）。
   ==================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(null, require('./chat-core.js'), require('./voice-message-core.js'),
      require('./feedback-core.js'));
  } else {
    root.IBFeedbackConsumptionCore = factory(root, root.IBChatCore, root.IBVoiceMessage, root.IBFeedbackCore);
  }
})(typeof self !== 'undefined' ? self : this, function (root, CHAT_CORE, VOICE, FEEDBACK) {
  'use strict';

  var CONSUMPTION_VERSION = 'feedback-consumption/v1';
  /* 处置闭集（§8）：只有三个。WAKE_ELIGIBLE 只是**资格**，不是 Wake。 */
  var DISPOSITIONS = Object.freeze(['IGNORE', 'OBSERVE', 'WAKE_ELIGIBLE']);
  /* 原因码闭集（§13：machine-readable，受控词表；不是自然语言、不是 CoT）。 */
  var REASONS = Object.freeze([
    'wake-eligible',
    'default-observe',
    'duplicate',
    'cooldown',
    'cancelled',
    'invalid-feedback',
    'invalid-context'
  ]);
  /* Context 是**闭集布尔字段**（§10/§38：没有 metadata / payload / contextDump 逃生舱）。
     每个字段都对应仓库里真实存在的事实或由 caller 明确持有的策略结论：
       wakeCapable     —— 该 feedback 的原因类别按**显式 policy** 是否"可唤醒"（策略结论由 caller 提供）
       cancelled       —— 现有取消语义（P25-3A isCancelled / delivery cancel / plan cancel）
       alreadyConsumed —— 同一条 feedback 已被消费过（caller 的 dedupe 事实）
       recentEquivalent—— 最近存在等价信号（caller 的 dedupe 事实）
       cooldownActive  —— 现有冷却（Active nudge 8min / plan minInterval / pair 冷却 / 12h 顺延）
     **未纳入**：runtimeAvailable（属 deliverability，见 §19）、userPresent（属通知/投递，见 §30）、
     priority / urgency / rank / deadline / retry（属 policy 排序，见 §15）。 */
  var CONTEXT_FIELDS = Object.freeze(['wakeCapable', 'cancelled', 'alreadyConsumed',
    'recentEquivalent', 'cooldownActive']);
  var ALLOWED_RESULT_FIELDS = Object.freeze(['ok', 'disposition', 'reason', 'feedbackId',
    'domain', 'version', 'errors']);
  var CONSUMPTION_ERRORS = Object.freeze([
    'not-an-object', 'unknown-field', 'bad-context-value', 'forbidden-context-field',
    'invalid-feedback', 'invalid-context', 'not-serializable', 'too-deep', 'not-json-value'
  ]);
  /* context / result **不得**成为凭据逃生舱，也不得复活 policy-only 或正文槽。 */
  var FORBIDDEN_CONTEXT_FIELDS = Object.freeze([
    'metadata', 'payload', 'data', 'content', 'body', 'text', 'record', 'state', 'dump',
    'contextdump', 'priority', 'urgency', 'rank', 'schedule', 'deadline', 'retry',
    'runtimeavailable', 'userpresent', 'sessionactive', 'attention', 'score', 'energy', 'budget',
    'apikey', 'apisecret', 'token', 'secret', 'credential', 'credentials', 'password', 'passwd',
    'auth', 'authorization', 'bearer', 'accesskey', 'privatekey'
  ]);
  var MAX_ID_LEN = 200;

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
  /* Feedback 校验**委托**给 P26-5（唯一实现；不复制第二份校验器）。 */
  function feedbackVerdict(feedback) {
    if (FEEDBACK && typeof FEEDBACK.validateFeedback === 'function') return FEEDBACK.validateFeedback(feedback);
    return { ok: false, errors: ['invalid-feedback'] };
  }
  /* ── Context 校验：闭集布尔字段；未知字段 / 禁用字段 / 非布尔值一律拒绝 ────── */
  function validateConsumptionContext(context) {
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

  /* ── 唯一入口：纯评估（不修改 feedback、不产生副作用、不读时钟）──────────────
     判定顺序（deterministic；早期阶段先赢）：
       1) feedback 非法                → ok:false / reason 'invalid-feedback'（**无** disposition）
       2) context 非法                 → ok:false / reason 'invalid-context'（**无** disposition）
       3) cancelled === true           → IGNORE / 'cancelled'
       4) alreadyConsumed === true     → IGNORE / 'duplicate'
       5) recentEquivalent === true    → IGNORE / 'duplicate'
       6) cooldownActive === true      → OBSERVE / 'cooldown'（信号有意义，只是现在不该唤醒）
       7) wakeCapable !== true         → OBSERVE / 'default-observe'（默认只供状态/telemetry/UI）
       8) 否则                          → WAKE_ELIGIBLE / 'wake-eligible'
     **severity / priority 完全不参与**（§14/§15）：high severity 不会自动变成 WAKE_ELIGIBLE。 */
  function evaluateFeedbackConsumption(feedback, context) {
    var verdict = feedbackVerdict(feedback);
    if (!verdict.ok) {
      return deepFreeze({ ok: false, disposition: '', reason: 'invalid-feedback', feedbackId: '',
        domain: '', version: CONSUMPTION_VERSION, errors: verdict.errors });
    }
    var ctxVerdict = validateConsumptionContext(context);
    if (!ctxVerdict.ok) {
      return deepFreeze({ ok: false, disposition: '', reason: 'invalid-context',
        feedbackId: str(feedback.feedbackId), domain: str(feedback.domain),
        version: CONSUMPTION_VERSION, errors: ctxVerdict.errors });
    }
    var disposition = 'OBSERVE', reason = 'default-observe';
    if (fact(context, 'cancelled')) { disposition = 'IGNORE'; reason = 'cancelled'; }
    else if (fact(context, 'alreadyConsumed') || fact(context, 'recentEquivalent')) { disposition = 'IGNORE'; reason = 'duplicate'; }
    else if (fact(context, 'cooldownActive')) { disposition = 'OBSERVE'; reason = 'cooldown'; }
    else if (fact(context, 'wakeCapable')) { disposition = 'WAKE_ELIGIBLE'; reason = 'wake-eligible'; }
    return deepFreeze({
      ok: true, disposition: disposition, reason: reason,
      feedbackId: str(feedback.feedbackId), domain: str(feedback.domain),
      version: CONSUMPTION_VERSION, errors: []
    });
  }
  /* ── Describe：给诊断/日志用的**无正文**摘要（reason/disposition 都是闭集词）──── */
  function describeConsumption(result) {
    var r = isPlainObject(result) ? result : {};
    return {
      ok: r.ok === true,
      version: CONSUMPTION_VERSION,
      disposition: str(r.disposition),
      reason: str(r.reason),
      feedbackId: str(r.feedbackId),
      domain: str(r.domain),
      errors: Array.isArray(r.errors) ? r.errors.slice(0, 8) : []
    };
  }

  return {
    CONSUMPTION_VERSION: CONSUMPTION_VERSION,
    DISPOSITIONS: DISPOSITIONS,
    REASONS: REASONS,
    CONTEXT_FIELDS: CONTEXT_FIELDS,
    FORBIDDEN_CONTEXT_FIELDS: FORBIDDEN_CONTEXT_FIELDS,
    ALLOWED_RESULT_FIELDS: ALLOWED_RESULT_FIELDS,
    CONSUMPTION_ERRORS: CONSUMPTION_ERRORS,
    evaluateFeedbackConsumption: evaluateFeedbackConsumption,
    validateConsumptionContext: validateConsumptionContext,
    describeConsumption: describeConsumption
  };
});
