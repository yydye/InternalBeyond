/* ====================================================================
   IB Wake Request Core — P26-7 · Wake Request Boundary Foundation
   --------------------------------------------------------------------
   回答一个问题：**一个已经"有资格唤醒"的信号，如何表达"请未来的 runtime 考虑一次
   激活"？**

     Wake Request = a request object representing that a previously eligible signal
                    asks a future runtime to consider activation.

   ── 边界阶梯（本阶段只到 Wake Request）─────────────────────────────
     Feedback Exists
       → Feedback Consumption
       → WAKE_ELIGIBLE
       → Wake Request        ← 本模块（终点）
       → STOP
     （之后 Wake Runtime → Planner → Action → P25 Autonomy 全部是未来阶段，不实现。）

   ── 关键不等式（不得压缩）────────────────────────────────────────
     WAKE_ELIGIBLE != Wake Request（判断结果 vs 一个新的请求对象）
     Wake Request  != Wake（请求 ≠ 激活）
     Wake          != Action
     Action        != ALLOW（创建 ≠ 授权 ≠ 执行）

   ── Producer Boundary ───────────────────────────────────────────
     唯一合法生产者是 **Feedback Consumption**：只能从一条 disposition = WAKE_ELIGIBLE
     的消费结果创建；**禁止** Feedback → Wake Request（不得绕过 Consumption）。
     Event / Observation producer · Capability · Authority · Executor 都不能创建。

   ── 本模块**不是**（禁止的形态）──────────────────────────────────
     Wake Runtime · 请求队列 · 调度器 · 事件总线 · Policy Engine · 请求存储 ·
     Agent 激活 · Action · Capability Call · Permission。

   ── 纯度 ─────────────────────────────────────────────────────────
     零 DOM / 零 IndexedDB / 零 localStorage / 零 fetch / 零 IPC / 零模型 / 零权威 /
     零 executor / 零订阅 / 零定时器 / 零时钟（**不读 Date.now**）/ 零随机
     （**不用 Math.random**）；身份确定性派生，去重/冷却等状态由 caller 注入。
   ==================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(null, require('./chat-core.js'), require('./voice-message-core.js'),
      require('./feedback-core.js'), require('./feedback-consumption-core.js'));
  } else {
    root.IBWakeRequestCore = factory(root, root.IBChatCore, root.IBVoiceMessage,
      root.IBFeedbackCore, root.IBFeedbackConsumptionCore);
  }
})(typeof self !== 'undefined' ? self : this, function (root, CHAT_CORE, VOICE, FEEDBACK, CONSUMPTION) {
  'use strict';

  var WAKE_REQUEST_VERSION = 'wake-request/v1';
  /* 唯一合法来源：P26-6 的 WAKE_ELIGIBLE 处置。词汇表**来自** P26-6（不复制第二份）。 */
  var ELIGIBLE_DISPOSITION = 'WAKE_ELIGIBLE';
  /* 生产者步骤标识（§5：唯一生产者是 Feedback Consumption）。 */
  var DEFAULT_CREATED_FROM = 'consumption';
  /* Wake Request 是**最小对象**（§6）：只带身份 + 因果指针，不带调度/policy 字段。 */
  var ALLOWED_FIELDS = Object.freeze(['wakeRequestId', 'feedbackId', 'domain', 'source', 'reason',
    'createdFrom', 'derivedFrom', 'causationId', 'version']);
  var REQUIRED_FIELDS = Object.freeze(['wakeRequestId', 'feedbackId', 'domain', 'source', 'reason',
    'createdFrom']);
  var OPTIONAL_FIELDS = Object.freeze(['derivedFrom', 'causationId']);
  /* options 也是**闭集**（§10/§38：没有 metadata / payload / contextDump 逃生舱）。 */
  var OPTION_FIELDS = Object.freeze(['wakeRequestId', 'createdFrom', 'causationId', 'alreadyRequested']);
  /* priority / urgency 等属 policy（P26-5 已冻结）——这里是**拒绝**它们，不是实现。 */
  var POLICY_ONLY_FIELDS = Object.freeze(['priority', 'urgency', 'rank', 'schedule', 'deadline', 'retry']);
  /* 不得携带 payload / canonical body / memory dump。 */
  var RESERVED_BODY_FIELDS = Object.freeze([
    'payload', 'content', 'body', 'text', 'data', 'value', 'snapshot', 'record',
    'memory', 'memories', 'messages', 'transcript', 'chat', 'images', 'image',
    'audio', 'base64', 'dataurl', 'blob', 'file', 'files', 'dump', 'state'
  ]);
  var WAKE_REQUEST_ERRORS = Object.freeze([
    'not-an-object', 'unknown-field', 'forbidden-body-field', 'policy-only-field',
    'missing-wake-request-id', 'bad-wake-request-id', 'missing-feedback-id', 'bad-feedback-id',
    'missing-domain', 'bad-domain', 'missing-source', 'bad-source', 'missing-reason', 'bad-reason',
    'missing-created-from', 'bad-created-from', 'bad-derived-from', 'bad-causation-id',
    'bad-version', 'secret-in-wake-request', 'not-serializable', 'too-deep', 'not-json-value',
    'invalid-consumption', 'not-eligible', 'invalid-feedback', 'feedback-mismatch',
    'unknown-option', 'bad-option', 'already-requested'
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
  /* consumption version 词汇表**来自** P26-6（唯一实现），不复制。 */
  function consumptionVersion() {
    if (CONSUMPTION && typeof CONSUMPTION.CONSUMPTION_VERSION === 'string') return CONSUMPTION.CONSUMPTION_VERSION;
    return 'feedback-consumption/v1';
  }
  /* Feedback 校验**委托**给 P26-5（唯一实现）。 */
  function feedbackVerdict(feedback) {
    if (FEEDBACK && typeof FEEDBACK.validateFeedback === 'function') return FEEDBACK.validateFeedback(feedback);
    return { ok: false, errors: ['invalid-feedback'] };
  }
  function scanRequestShape(request) {
    var errors = [];
    var keys = isPlainObject(request) ? Object.keys(request) : [];
    for (var i = 0; i < keys.length; i++) {
      var raw = String(keys[i]);
      var lower = raw.toLowerCase().replace(/[\s\-_]/g, '');
      if (RESERVED_BODY_FIELDS.indexOf(lower) >= 0) { errors.push('forbidden-body-field:' + raw); continue; }
      if (POLICY_ONLY_FIELDS.indexOf(lower) >= 0) { errors.push('policy-only-field:' + raw); continue; }
      if (ALLOWED_FIELDS.indexOf(raw) < 0) errors.push('unknown-field:' + raw);
    }
    return dedupe(errors);
  }
  /* ── 校验：只验证 shape / 闭集 / 语法；不验证 policy，也不做跨请求比较 ────────── */
  function validateWakeRequest(request) {
    var errors = [];
    if (!isPlainObject(request)) return { ok: false, errors: ['not-an-object'] };
    errors = errors.concat(scanRequestShape(request));
    if (request.wakeRequestId === undefined || request.wakeRequestId === null || str(request.wakeRequestId).trim() === '') errors.push('missing-wake-request-id');
    else if (!usableId(request.wakeRequestId)) errors.push('bad-wake-request-id');
    if (request.feedbackId === undefined || request.feedbackId === null || str(request.feedbackId).trim() === '') errors.push('missing-feedback-id');
    else if (!usableId(request.feedbackId)) errors.push('bad-feedback-id');
    if (request.domain === undefined || request.domain === null || str(request.domain).trim() === '') errors.push('missing-domain');
    else if (!TOKEN_PATTERN.test(str(request.domain)) || str(request.domain).length > 40) errors.push('bad-domain');
    if (request.source === undefined || request.source === null || str(request.source).trim() === '') errors.push('missing-source');
    else if (!SOURCE_PATTERN.test(str(request.source)) || str(request.source).length > 80) errors.push('bad-source');
    if (request.reason === undefined || request.reason === null || str(request.reason).trim() === '') errors.push('missing-reason');
    else if (!REASON_PATTERN.test(str(request.reason)) || str(request.reason).length > 60) errors.push('bad-reason');
    if (request.createdFrom === undefined || request.createdFrom === null || str(request.createdFrom).trim() === '') errors.push('missing-created-from');
    else if (!TOKEN_PATTERN.test(str(request.createdFrom)) || str(request.createdFrom).length > 60) errors.push('bad-created-from');
    if (request.derivedFrom !== undefined && request.derivedFrom !== null && str(request.derivedFrom) !== '') {
      if (!usableId(request.derivedFrom)) errors.push('bad-derived-from');
    }
    if (request.causationId !== undefined && request.causationId !== null && str(request.causationId) !== '') {
      if (!usableId(request.causationId)) errors.push('bad-causation-id');
    }
    if (str(request.version) !== WAKE_REQUEST_VERSION) errors.push('bad-version');
    var jsonErrors = [], present = {};
    Object.keys(request).forEach(function (k) { if (request[k] !== undefined) present[k] = request[k]; });
    if (!isJsonValue(present, 0, jsonErrors, '')) errors = errors.concat(jsonErrors);
    if (hasSecret({
      wakeRequestId: request.wakeRequestId, feedbackId: request.feedbackId, domain: request.domain,
      source: request.source, reason: request.reason, createdFrom: request.createdFrom,
      derivedFrom: request.derivedFrom, causationId: request.causationId
    })) errors.push('secret-in-wake-request');
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
      if (raw === 'alreadyRequested') {
        if (typeof opts[raw] !== 'boolean') errors.push('bad-option:' + raw);
      } else if (opts[raw] !== undefined && opts[raw] !== null && typeof opts[raw] !== 'string') {
        errors.push('bad-option:' + raw);
      }
    }
    return dedupe(errors);
  }
  /* ── 唯一入口（§4）：只能从**已 eligibility 的消费结果**创建 ──────────────────
       createWakeRequest(consumption, feedback, options)
         consumption : P26-6 的消费结果；必须 ok === true 且 disposition === WAKE_ELIGIBLE
         feedback    : P26-5 的 Feedback；用于携带 source / domain / reason / derivedFrom，
                       且其 feedbackId 必须与 consumption.feedbackId 一致（证明未绕过 Consumption）
         options     : { wakeRequestId?, createdFrom?, causationId?, alreadyRequested? }
       判定顺序（deterministic；早期阶段先赢）：
         1) consumption 非对象 / 缺身份              → invalid-consumption
         2) consumption 不是 WAKE_ELIGIBLE            → not-eligible（含 ok:false / IGNORE / OBSERVE）
         3) feedback 非法                              → invalid-feedback
         4) feedback.feedbackId ≠ consumption.feedbackId → feedback-mismatch
         5) options 非法                               → unknown-option / bad-option
         6) alreadyRequested === true                  → already-requested（caller 的 dedupe 事实）
         7) 否则                                       → ok:true + 冻结的最小请求对象
       **不读时钟、不用随机、不写任何 store**；wakeRequestId 由稳定字段确定性派生。 */
  function createWakeRequest(consumption, feedback, options) {
    var opts = isPlainObject(options) ? options : {};
    if (!isPlainObject(consumption)) return { ok: false, errors: ['invalid-consumption'], wakeRequest: null };
    if (consumption.ok !== true || str(consumption.disposition) !== ELIGIBLE_DISPOSITION) {
      return { ok: false, errors: ['not-eligible'], wakeRequest: null };
    }
    if (str(consumption.version) !== consumptionVersion() || !usableId(consumption.feedbackId)) {
      return { ok: false, errors: ['invalid-consumption'], wakeRequest: null };
    }
    var verdict = feedbackVerdict(feedback);
    if (!verdict.ok) return { ok: false, errors: ['invalid-feedback'], wakeRequest: null };
    if (str(feedback.feedbackId) !== str(consumption.feedbackId)) {
      return { ok: false, errors: ['feedback-mismatch'], wakeRequest: null };
    }
    var optErrors = scanOptions(opts);
    if (optErrors.length) return { ok: false, errors: optErrors, wakeRequest: null };
    if (opts.alreadyRequested === true) return { ok: false, errors: ['already-requested'], wakeRequest: null };
    var createdFrom = str(opts.createdFrom) || DEFAULT_CREATED_FROM;
    var wakeRequestId = str(opts.wakeRequestId);
    if (!wakeRequestId) {
      var token = stableToken([
        str(feedback.feedbackId), str(feedback.domain), str(feedback.source),
        str(feedback.reason), createdFrom, str(feedback.derivedFrom), str(opts.causationId)
      ].join('|'));
      if (token) wakeRequestId = 'wr_' + token;
    }
    var draft = {
      wakeRequestId: wakeRequestId,
      feedbackId: str(feedback.feedbackId),
      domain: str(feedback.domain),
      source: str(feedback.source),
      reason: str(feedback.reason),
      createdFrom: createdFrom
    };
    if (str(feedback.derivedFrom)) draft.derivedFrom = str(feedback.derivedFrom);
    if (str(opts.causationId)) draft.causationId = str(opts.causationId);
    draft.version = WAKE_REQUEST_VERSION;
    var requestVerdict = validateWakeRequest(draft);
    if (!requestVerdict.ok) return { ok: false, errors: requestVerdict.errors, wakeRequest: null };
    return { ok: true, errors: [], wakeRequest: deepFreeze(draft) };
  }
  /* ── Describe：给诊断/日志用的**无正文**摘要（不输出 payload / memory / 自由文本）── */
  function describeWakeRequest(request) {
    var r = isPlainObject(request) ? request : {};
    var leaked = Object.keys(r).filter(function (k) {
      var lower = String(k).toLowerCase().replace(/[\s\-_]/g, '');
      return RESERVED_BODY_FIELDS.indexOf(lower) >= 0 || POLICY_ONLY_FIELDS.indexOf(lower) >= 0;
    });
    var verdict = validateWakeRequest(r);
    return {
      ok: verdict.ok,
      version: WAKE_REQUEST_VERSION,
      wakeRequestId: str(r.wakeRequestId),
      feedbackId: str(r.feedbackId),
      domain: str(r.domain),
      source: str(r.source),
      reason: str(r.reason),
      createdFrom: str(r.createdFrom) || 'none',
      hasDerivedFrom: !!str(r.derivedFrom),
      hasCausationId: !!str(r.causationId),
      rejectedFields: leaked,
      errors: verdict.errors
    };
  }

  return {
    WAKE_REQUEST_VERSION: WAKE_REQUEST_VERSION,
    ALLOWED_FIELDS: ALLOWED_FIELDS,
    REQUIRED_FIELDS: REQUIRED_FIELDS,
    OPTIONAL_FIELDS: OPTIONAL_FIELDS,
    OPTION_FIELDS: OPTION_FIELDS,
    POLICY_ONLY_FIELDS: POLICY_ONLY_FIELDS,
    RESERVED_BODY_FIELDS: RESERVED_BODY_FIELDS,
    WAKE_REQUEST_ERRORS: WAKE_REQUEST_ERRORS,
    ELIGIBLE_DISPOSITION: ELIGIBLE_DISPOSITION,
    /* 处置词汇表**来自** P26-6（唯一权威）；不在此复制第二份。 */
    DISPOSITIONS: (CONSUMPTION && CONSUMPTION.DISPOSITIONS) ? CONSUMPTION.DISPOSITIONS : null,
    createWakeRequest: createWakeRequest,
    validateWakeRequest: validateWakeRequest,
    describeWakeRequest: describeWakeRequest
  };
});
