/* ====================================================================
   IB Activation Intent Core — P26-9 · Activation Intent Boundary Foundation
   --------------------------------------------------------------------
   回答一个问题：**一条 ACTIVATE_ELIGIBLE 结果如何形成"未来 activation 请求"的意图？**

     Activation Intent = a pure intent object indicating that a runtime activation may be
                         requested in the future.

   不是 Agent Wake · 不是 Agent Start · 不是 Planner Call · 不是 Action · 不是 Capability。

   ── 边界阶梯（本阶段只到 Activation Intent）─────────────────────────
     Feedback → Consumption → WAKE_ELIGIBLE → Wake Request → Wake Runtime
       → ACTIVATE_ELIGIBLE
       → Activation Intent   ← 本模块（终点：Intent Creation）
       → STOP
     （之后 Agent Runtime → Planner → Action → P25 Autonomy 全部是未来阶段，不实现。）

   ── 关键不等式 ──────────────────────────────────────────────────
     ACTIVATE_ELIGIBLE != Activation Intent（runtime 判定 vs **新的意图对象**）
     Activation Intent != Agent Wake（意图 ≠ 已唤醒）
     Activation Intent != Action（不是 Action；P25 不感知）

   ── Producer Boundary ───────────────────────────────────────────
     唯一合法来源是 **Wake Runtime 的 ACTIVATE_ELIGIBLE 判定**：只能从一条 ok === true 且
     activation === ACTIVATE_ELIGIBLE 的 P26-8 结果创建；**禁止** Wake Request → Activation Intent
     （不得绕过 Wake Runtime），也禁止从 BLOCKED / REJECTED 创建。

   ── 本模块**不是**（禁止的形态）──────────────────────────────────
     ActivationManager · ActivationService · 意图队列 · 存储 · 事件总线 · Policy Engine ·
     Agent Runtime · Planner · Executor · Authority。

   ── 纯度 ─────────────────────────────────────────────────────────
     零 DOM / 零 IndexedDB / 零 localStorage / 零 fetch / 零 IPC / 零模型 / 零权威 /
     零 executor / 零订阅 / 零定时器 / 零时钟（**不读 Date.now**）/ 零随机
     （**不用 Math.random**）；身份确定性派生，状态由 caller 注入。
   ==================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(null, require('./chat-core.js'), require('./voice-message-core.js'),
      require('./wake-request-core.js'), require('./wake-runtime-core.js'));
  } else {
    root.IBActivationIntentCore = factory(root, root.IBChatCore, root.IBVoiceMessage,
      root.IBWakeRequestCore, root.IBWakeRuntimeCore);
  }
})(typeof self !== 'undefined' ? self : this, function (root, CHAT_CORE, VOICE, WAKE_REQUEST, WAKE_RUNTIME) {
  'use strict';

  var ACTIVATION_INTENT_VERSION = 'activation-intent/v1';
  /* 唯一合法来源：P26-8 的 ACTIVATE_ELIGIBLE 判定。词汇表**来自** P26-8（不复制第二份）。 */
  var ELIGIBLE_ACTIVATION = 'ACTIVATE_ELIGIBLE';
  /* 意图是**新对象**（区别于 P26-8 的"判定"）——因此需要稳定身份（§5 审计结论）。 */
  var ALLOWED_FIELDS = Object.freeze(['activationIntentId', 'wakeRequestId', 'feedbackId', 'domain',
    'source', 'reason', 'derivedFrom', 'causationId', 'version']);
  var REQUIRED_FIELDS = Object.freeze(['activationIntentId', 'wakeRequestId', 'feedbackId', 'domain',
    'source', 'reason']);
  var OPTIONAL_FIELDS = Object.freeze(['derivedFrom', 'causationId']);
  /* options 也是**闭集**（§13：没有 metadata / payload 逃生舱）。 */
  var OPTION_FIELDS = Object.freeze(['activationIntentId', 'causationId']);
  /* priority / urgency 等属 policy（P26-5 已冻结）——这里是**拒绝**它们，不是实现。 */
  var POLICY_ONLY_FIELDS = Object.freeze(['priority', 'urgency', 'rank', 'schedule', 'deadline', 'retry']);
  /* 不得携带 payload / canonical body / memory dump。 */
  var RESERVED_BODY_FIELDS = Object.freeze([
    'payload', 'content', 'body', 'text', 'data', 'value', 'snapshot', 'record',
    'memory', 'memories', 'messages', 'transcript', 'chat', 'images', 'image',
    'audio', 'base64', 'dataurl', 'blob', 'file', 'files', 'dump', 'state',
    'metadata', 'contextdump'
  ]);
  var ACTIVATION_INTENT_ERRORS = Object.freeze([
    'not-an-object', 'unknown-field', 'forbidden-body-field', 'policy-only-field',
    'missing-activation-intent-id', 'bad-activation-intent-id', 'missing-wake-request-id',
    'bad-wake-request-id', 'missing-feedback-id', 'bad-feedback-id', 'missing-domain', 'bad-domain',
    'missing-source', 'bad-source', 'missing-reason', 'bad-reason', 'bad-derived-from',
    'bad-causation-id', 'bad-version', 'secret-in-activation-intent', 'not-serializable',
    'too-deep', 'not-json-value', 'invalid-wake-result', 'not-activatable', 'invalid-request',
    'request-mismatch', 'unknown-option', 'bad-option'
  ]);
  var MAX_ID_LEN = 200;
  var CONTROL_PATTERN = /[\u0000-\u001F\u007F]/;
  var ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:\-@|]*$/;
  var TOKEN_PATTERN = /^[a-z][a-z0-9_]*$/;
  var SOURCE_PATTERN = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$/;
  var REASON_PATTERN = /^[a-z][a-z0-9_-]*$/;

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
  function stableToken(seed) {
    try { if (CHAT_CORE && typeof CHAT_CORE.stableToken === 'function') return str(CHAT_CORE.stableToken(seed)); } catch (e) { /* fall through */ }
    return '';
  }
  function hasSecret(value) {
    try { if (VOICE && typeof VOICE.findSecret === 'function') return !!VOICE.findSecret(value); } catch (e) { /* 探测失败不阻断 */ }
    return false;
  }
  function deepFreeze(v) {
    if (Array.isArray(v)) { v.forEach(deepFreeze); return Object.freeze(v); }
    if (!isObject(v)) return v;
    Object.keys(v).forEach(function (k) { deepFreeze(v[k]); });
    return Object.freeze(v);
  }
  function usableId(v) {
    var s = str(v);
    if (!s || s !== s.trim() || s.length > MAX_ID_LEN) return false;
    if (CONTROL_PATTERN.test(s)) return false;
    return ID_PATTERN.test(s);
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
  /* Wake Runtime version / 激活词汇表**来自** P26-8（唯一权威），不复制。 */
  function wakeRuntimeVersion() {
    if (WAKE_RUNTIME && typeof WAKE_RUNTIME.WAKE_RUNTIME_VERSION === 'string') return WAKE_RUNTIME.WAKE_RUNTIME_VERSION;
    return 'wake-runtime/v1';
  }
  /* Wake Request 校验**委托**给 P26-7（唯一实现；不复制第二份校验器）。 */
  function requestVerdict(request) {
    if (WAKE_REQUEST && typeof WAKE_REQUEST.validateWakeRequest === 'function') return WAKE_REQUEST.validateWakeRequest(request);
    return { ok: false, errors: ['invalid-request'] };
  }
  function scanIntentShape(intent) {
    var errors = [];
    var keys = isPlainObject(intent) ? Object.keys(intent) : [];
    for (var i = 0; i < keys.length; i++) {
      var raw = String(keys[i]);
      var lower = raw.toLowerCase().replace(/[\s\-_]/g, '');
      if (RESERVED_BODY_FIELDS.indexOf(lower) >= 0) { errors.push('forbidden-body-field:' + raw); continue; }
      if (POLICY_ONLY_FIELDS.indexOf(lower) >= 0) { errors.push('policy-only-field:' + raw); continue; }
      if (ALLOWED_FIELDS.indexOf(raw) < 0) errors.push('unknown-field:' + raw);
    }
    return dedupe(errors);
  }
  /* ── 校验：只验证 shape / 闭集 / 语法；不验证 policy，也不做跨意图比较 ────────── */
  function validateActivationIntent(intent) {
    var errors = [];
    if (!isPlainObject(intent)) return { ok: false, errors: ['not-an-object'] };
    errors = errors.concat(scanIntentShape(intent));
    if (intent.activationIntentId === undefined || intent.activationIntentId === null || str(intent.activationIntentId).trim() === '') errors.push('missing-activation-intent-id');
    else if (!usableId(intent.activationIntentId)) errors.push('bad-activation-intent-id');
    if (intent.wakeRequestId === undefined || intent.wakeRequestId === null || str(intent.wakeRequestId).trim() === '') errors.push('missing-wake-request-id');
    else if (!usableId(intent.wakeRequestId)) errors.push('bad-wake-request-id');
    if (intent.feedbackId === undefined || intent.feedbackId === null || str(intent.feedbackId).trim() === '') errors.push('missing-feedback-id');
    else if (!usableId(intent.feedbackId)) errors.push('bad-feedback-id');
    if (intent.domain === undefined || intent.domain === null || str(intent.domain).trim() === '') errors.push('missing-domain');
    else if (!TOKEN_PATTERN.test(str(intent.domain)) || str(intent.domain).length > 40) errors.push('bad-domain');
    if (intent.source === undefined || intent.source === null || str(intent.source).trim() === '') errors.push('missing-source');
    else if (!SOURCE_PATTERN.test(str(intent.source)) || str(intent.source).length > 80) errors.push('bad-source');
    if (intent.reason === undefined || intent.reason === null || str(intent.reason).trim() === '') errors.push('missing-reason');
    else if (!REASON_PATTERN.test(str(intent.reason)) || str(intent.reason).length > 60) errors.push('bad-reason');
    if (intent.derivedFrom !== undefined && intent.derivedFrom !== null && str(intent.derivedFrom) !== '') {
      if (!usableId(intent.derivedFrom)) errors.push('bad-derived-from');
    }
    if (intent.causationId !== undefined && intent.causationId !== null && str(intent.causationId) !== '') {
      if (!usableId(intent.causationId)) errors.push('bad-causation-id');
    }
    if (str(intent.version) !== ACTIVATION_INTENT_VERSION) errors.push('bad-version');
    var jsonErrors = [], present = {};
    Object.keys(intent).forEach(function (k) { if (intent[k] !== undefined) present[k] = intent[k]; });
    if (!isJsonValue(present, 0, jsonErrors, '')) errors = errors.concat(jsonErrors);
    if (hasSecret({
      activationIntentId: intent.activationIntentId, wakeRequestId: intent.wakeRequestId,
      feedbackId: intent.feedbackId, domain: intent.domain, source: intent.source,
      reason: intent.reason, derivedFrom: intent.derivedFrom, causationId: intent.causationId
    })) errors.push('secret-in-activation-intent');
    errors = dedupe(errors);
    return { ok: errors.length === 0, errors: errors };
  }
  /* ── options 校验：闭集键 + 类型；未知键一律拒绝（无逃生舱）────────────────── */
  function scanOptions(opts) {
    var errors = [];
    var keys = Object.keys(opts);
    for (var i = 0; i < keys.length; i++) {
      var raw = String(keys[i]);
      if (OPTION_FIELDS.indexOf(raw) < 0) { errors.push('unknown-option:' + raw); continue; }
      if (opts[raw] !== undefined && opts[raw] !== null && typeof opts[raw] !== 'string') errors.push('bad-option:' + raw);
    }
    return dedupe(errors);
  }
  /* ── 唯一入口（§4）：只能从 **ACTIVATE_ELIGIBLE** 的 Wake Runtime 结果创建 ────────
       createActivationIntent(wakeResult, request, options)
         wakeResult : P26-8 的运行时结果；必须 ok === true 且 activation === ACTIVATE_ELIGIBLE
         request    : P26-7 的 Wake Request；用于携带 wakeRequestId / feedbackId / domain /
                      source / reason / derivedFrom，且其 wakeRequestId 必须与该结果一致
                      （证明未绕过 Wake Runtime，也证明请求与判定同源）
         options    : { activationIntentId?, causationId? }
       判定顺序（deterministic；早期阶段先赢）：
         1) wakeResult 非对象 / version 不符 → invalid-wake-result
         2) wakeResult 不是 ACTIVATE_ELIGIBLE   → not-activatable（BLOCKED / REJECTED / ok:false）
         3) request 非法                        → invalid-request
         4) request.wakeRequestId ≠ wakeResult.wakeRequestId → request-mismatch
         5) options 非法                        → unknown-option / bad-option
         6) 否则                                → ok:true + 冻结的最小意图对象
       **不读时钟、不用随机、不写任何 store**；activationIntentId 由稳定字段确定性派生。 */
  function createActivationIntent(wakeResult, request, options) {
    var opts = isPlainObject(options) ? options : {};
    if (!isPlainObject(wakeResult)) return { ok: false, errors: ['invalid-wake-result'], activationIntent: null };
    if (str(wakeResult.version) !== wakeRuntimeVersion() || !usableId(wakeResult.wakeRequestId)) {
      return { ok: false, errors: ['invalid-wake-result'], activationIntent: null };
    }
    if (wakeResult.ok !== true || str(wakeResult.activation) !== ELIGIBLE_ACTIVATION) {
      return { ok: false, errors: ['not-activatable'], activationIntent: null };
    }
    var verdict = requestVerdict(request);
    if (!verdict.ok) return { ok: false, errors: ['invalid-request'], activationIntent: null };
    if (str(request.wakeRequestId) !== str(wakeResult.wakeRequestId)) {
      return { ok: false, errors: ['request-mismatch'], activationIntent: null };
    }
    var optErrors = scanOptions(opts);
    if (optErrors.length) return { ok: false, errors: optErrors, activationIntent: null };
    /* causationId：options 优先，否则**随 Wake Request 携带**（§6 保持因果链） */
    var causationId = str(opts.causationId) || str(request.causationId);
    var activationIntentId = str(opts.activationIntentId);
    if (!activationIntentId) {
      var token = stableToken([
        str(request.wakeRequestId), str(request.feedbackId), str(request.domain),
        str(request.source), str(request.reason), str(request.derivedFrom), causationId
      ].join('|'));
      if (token) activationIntentId = 'ai_' + token;
    }
    var draft = {
      activationIntentId: activationIntentId,
      wakeRequestId: str(request.wakeRequestId),
      feedbackId: str(request.feedbackId),
      domain: str(request.domain),
      source: str(request.source),
      reason: str(request.reason)
    };
    if (str(request.derivedFrom)) draft.derivedFrom = str(request.derivedFrom);
    if (causationId) draft.causationId = causationId;
    draft.version = ACTIVATION_INTENT_VERSION;
    var intentVerdict = validateActivationIntent(draft);
    if (!intentVerdict.ok) return { ok: false, errors: intentVerdict.errors, activationIntent: null };
    return { ok: true, errors: [], activationIntent: deepFreeze(draft) };
  }
  /* ── Describe：给诊断/日志用的**无正文**摘要（不输出 payload / memory / 自由文本）── */
  function describeActivationIntent(intent) {
    var r = isPlainObject(intent) ? intent : {};
    var leaked = Object.keys(r).filter(function (k) {
      var lower = String(k).toLowerCase().replace(/[\s\-_]/g, '');
      return RESERVED_BODY_FIELDS.indexOf(lower) >= 0 || POLICY_ONLY_FIELDS.indexOf(lower) >= 0;
    });
    var verdict = validateActivationIntent(r);
    return {
      ok: verdict.ok,
      version: ACTIVATION_INTENT_VERSION,
      activationIntentId: str(r.activationIntentId),
      wakeRequestId: str(r.wakeRequestId),
      feedbackId: str(r.feedbackId),
      domain: str(r.domain),
      source: str(r.source),
      reason: str(r.reason),
      hasDerivedFrom: !!str(r.derivedFrom),
      hasCausationId: !!str(r.causationId),
      rejectedFields: leaked,
      errors: verdict.errors
    };
  }

  return {
    ACTIVATION_INTENT_VERSION: ACTIVATION_INTENT_VERSION,
    ELIGIBLE_ACTIVATION: ELIGIBLE_ACTIVATION,
    ALLOWED_FIELDS: ALLOWED_FIELDS,
    REQUIRED_FIELDS: REQUIRED_FIELDS,
    OPTIONAL_FIELDS: OPTIONAL_FIELDS,
    OPTION_FIELDS: OPTION_FIELDS,
    POLICY_ONLY_FIELDS: POLICY_ONLY_FIELDS,
    RESERVED_BODY_FIELDS: RESERVED_BODY_FIELDS,
    ACTIVATION_INTENT_ERRORS: ACTIVATION_INTENT_ERRORS,
    /* 激活词汇表**来自** P26-8（唯一权威）；不在此复制第二份。 */
    ACTIVATIONS: (WAKE_RUNTIME && WAKE_RUNTIME.ACTIVATIONS) ? WAKE_RUNTIME.ACTIVATIONS : null,
    createActivationIntent: createActivationIntent,
    validateActivationIntent: validateActivationIntent,
    describeActivationIntent: describeActivationIntent
  };
});
