/* ====================================================================
   IB Feedback Core — P26-5 · Feedback Boundary Foundation
   --------------------------------------------------------------------
   回答一个问题：**什么是 Feedback，以及什么信息有资格进入它？**

     Feedback = a derived signal that evaluates whether existing facts
                or observations require further attention.

   不是：Event（P26-1）· Observation（P26-2）· Action · Command · Decision。

   ── 冻结边界 ────────────────────────────────────────────────────────
     · Event ≠ Feedback：事件**可以**作为输入被派生，但事件监听器**不会**自动执行任何东西；
     · Observation ≠ Feedback："camera unavailable" 是 Observation；
       "需要提醒用户" 才是 Feedback；
     · Feedback **不**执行 Capability、**不**调用 Authority、**不**创建 Action；
       未来链路只能是：Feedback → Autonomy Policy → Action（本阶段不实现）；
     · **Feedback Available ≠ Agent Wake**：没有 feedback.triggerAgent()。

   ── 本模块**不是** ──────────────────────────────────────────────────
     Event Bus · Router · Scheduler · Agent Wake · Autonomous Execution · Policy Engine ·
     Feedback Store / History / Queue

   ── 纯度 ─────────────────────────────────────────────────────────────
     零 DOM / 零 IndexedDB / 零 localStorage / 零 fetch / 零 IPC / 零 provider / 零模型 /
     零权威 / 零 executor / 零订阅 / 零定时器 / 零时钟（**不读 Date.now**）/
     零随机（**不用 Math.random**）；时间与身份由调用方注入；秘密探测复用既有纯 helper。
   ==================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(null, require('./chat-core.js'), require('./voice-message-core.js'));
  } else {
    root.IBFeedbackCore = factory(root, root.IBChatCore, root.IBVoiceMessage);
  }
})(typeof self !== 'undefined' ? self : this, function (root, CHAT_CORE, VOICE) {
  'use strict';

  var FEEDBACK_VERSION = 'feedback/v1';
  /* severity 是**信号自身的属性**（producer 已经做出的评估）⇒ 属于契约；
     priority / urgency 是**跨信号比较**（谁先做）⇒ 属于 policy，**不在**契约里。 */
  var SEVERITY_VALUES = Object.freeze(['low', 'medium', 'high']);
  var POLICY_ONLY_FIELDS = Object.freeze(['priority', 'urgency', 'rank', 'schedule', 'deadline', 'retry']);
  var ALLOWED_FIELDS = Object.freeze(['feedbackId', 'domain', 'source', 'reason', 'timestamp',
    'severity', 'relatedEntity', 'derivedFrom', 'version']);
  var REQUIRED_FIELDS = Object.freeze(['feedbackId', 'domain', 'source', 'reason', 'timestamp']);
  var OPTIONAL_FIELDS = Object.freeze(['severity', 'relatedEntity', 'derivedFrom']);
  /* Feedback 不得携带 payload / canonical body / memory dump。 */
  var RESERVED_BODY_FIELDS = Object.freeze([
    'payload', 'content', 'body', 'text', 'data', 'value', 'snapshot', 'record', 'row',
    'memory', 'memories', 'messages', 'history', 'transcript', 'chat', 'images', 'image',
    'audio', 'base64', 'dataurl', 'blob', 'file', 'files', 'dump', 'state'
  ]);
  var MAX_ID_LEN = 200;
  var MAX_REASON_LEN = 60;
  var CONTROL_PATTERN = /[\u0000-\u001F\u007F]/;
  var ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:\-@|]*$/;
  var TOKEN_PATTERN = /^[a-z][a-z0-9_]*$/;
  var SOURCE_PATTERN = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$/;
  /* reason 是**机器可读的原因码**（token），不是自由文本 —— 自由文本/叙述属 UI 与 policy，
     不进入契约（这也避免把 Feedback 变成第二个 CoT 通道）。 */
  var REASON_PATTERN = /^[a-z][a-z0-9_-]*$/;
  var FEEDBACK_ERRORS = Object.freeze([
    'not-an-object', 'unknown-field', 'policy-only-field', 'forbidden-body-field',
    'missing-feedback-id', 'bad-feedback-id', 'missing-domain', 'bad-domain',
    'missing-source', 'bad-source', 'missing-reason', 'bad-reason',
    'missing-timestamp', 'bad-timestamp', 'bad-severity', 'bad-related-entity', 'bad-derived-from',
    'secret-in-feedback', 'not-serializable', 'too-deep', 'not-json-value'
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
  function isTimestamp(v) { return typeof v === 'number' && isFinite(v) && v > 0; }
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
  function scanShape(input) {
    var errors = [];
    var keys = isPlainObject(input) ? Object.keys(input) : [];
    for (var i = 0; i < keys.length; i++) {
      var raw = String(keys[i]);
      var lower = raw.toLowerCase().replace(/[\s\-_]/g, '');
      if (RESERVED_BODY_FIELDS.indexOf(lower) >= 0) { errors.push('forbidden-body-field:' + raw); continue; }
      if (POLICY_ONLY_FIELDS.indexOf(lower) >= 0) { errors.push('policy-only-field:' + raw); continue; }
      if (ALLOWED_FIELDS.indexOf(raw) < 0) errors.push('unknown-field:' + raw);
    }
    return dedupe(errors);
  }

  /* ── 校验：只验证 shape / 闭集 / 语法；**不**验证 policy，也**不**做跨信号比较 ──── */
  function validateFeedback(feedback) {
    var errors = [];
    if (!isPlainObject(feedback)) return { ok: false, errors: ['not-an-object'] };
    errors = errors.concat(scanShape(feedback));
    if (feedback.feedbackId === undefined || feedback.feedbackId === null || str(feedback.feedbackId).trim() === '') errors.push('missing-feedback-id');
    else if (!usableId(feedback.feedbackId)) errors.push('bad-feedback-id');
    if (feedback.domain === undefined || feedback.domain === null || str(feedback.domain).trim() === '') errors.push('missing-domain');
    else if (!TOKEN_PATTERN.test(str(feedback.domain)) || str(feedback.domain).length > 40) errors.push('bad-domain');
    if (feedback.source === undefined || feedback.source === null || str(feedback.source).trim() === '') errors.push('missing-source');
    else if (!SOURCE_PATTERN.test(str(feedback.source)) || str(feedback.source).length > 80) errors.push('bad-source');
    if (feedback.reason === undefined || feedback.reason === null || str(feedback.reason).trim() === '') errors.push('missing-reason');
    else if (!REASON_PATTERN.test(str(feedback.reason)) || str(feedback.reason).length > MAX_REASON_LEN) errors.push('bad-reason');
    if (feedback.timestamp === undefined || feedback.timestamp === null || feedback.timestamp === '') errors.push('missing-timestamp');
    else if (!isTimestamp(feedback.timestamp)) errors.push('bad-timestamp');
    if (feedback.severity !== undefined && feedback.severity !== null && str(feedback.severity) !== '') {
      if (SEVERITY_VALUES.indexOf(str(feedback.severity)) < 0) errors.push('bad-severity');
    }
    if (feedback.relatedEntity !== undefined && feedback.relatedEntity !== null && str(feedback.relatedEntity) !== '') {
      if (!usableId(feedback.relatedEntity)) errors.push('bad-related-entity');
    }
    if (feedback.derivedFrom !== undefined && feedback.derivedFrom !== null && str(feedback.derivedFrom) !== '') {
      if (!usableId(feedback.derivedFrom)) errors.push('bad-derived-from');
    }
    var jsonErrors = [], present = {};
    Object.keys(feedback).forEach(function (k) { if (feedback[k] !== undefined) present[k] = feedback[k]; });
    if (!isJsonValue(present, 0, jsonErrors, '')) errors = errors.concat(jsonErrors);
    if (hasSecret({
      feedbackId: feedback.feedbackId, domain: feedback.domain, source: feedback.source,
      reason: feedback.reason, relatedEntity: feedback.relatedEntity, derivedFrom: feedback.derivedFrom
    })) errors.push('secret-in-feedback');
    errors = dedupe(errors);
    return { ok: errors.length === 0, errors: errors };
  }
  /* ── 规范化：只保留闭集字段（顺序稳定），并深冻结 ─────────────────────── */
  function normalizeFeedback(feedback) {
    if (!isPlainObject(feedback)) return { ok: false, errors: ['not-an-object'], feedback: null };
    var shapeErrors = scanShape(feedback);
    if (shapeErrors.length) return { ok: false, errors: shapeErrors, feedback: null };
    var out = {
      feedbackId: str(feedback.feedbackId),
      domain: str(feedback.domain),
      source: str(feedback.source),
      reason: str(feedback.reason),
      timestamp: feedback.timestamp
    };
    OPTIONAL_FIELDS.forEach(function (f) {
      var v = feedback[f];
      if (v !== undefined && v !== null && v !== '') out[f] = str(v);
    });
    var verdict = validateFeedback(out);
    if (!verdict.ok) return { ok: false, errors: verdict.errors, feedback: null };
    return { ok: true, errors: [], feedback: deepFreeze(out) };
  }
  /* ── 创建：唯一入口。feedbackId 与 timestamp **必须**由调用方提供或注入 ──────
     options:
       timestamp   : number  —— 注入的"派生时刻"（本模块**不读 Date.now**）
       feedbackId  : string  —— 注入的身份（优先于派生）
     派生身份是**确定性**的（stableToken 对 domain|source|reason|relatedEntity|derivedFrom|timestamp 取哈希）。 */
  function createFeedback(input, options) {
    var opts = isPlainObject(options) ? options : {};
    if (!isPlainObject(input)) return { ok: false, errors: ['not-an-object'], feedback: null };
    var shapeErrors = scanShape(input);
    if (shapeErrors.length) return { ok: false, errors: shapeErrors, feedback: null };
    var timestamp = (input.timestamp === undefined || input.timestamp === null || input.timestamp === '')
      ? opts.timestamp : input.timestamp;
    var feedbackId = str(input.feedbackId) || str(opts.feedbackId);
    if (!feedbackId) {
      var token = stableToken([
        str(input.domain), str(input.source), str(input.reason),
        str(input.relatedEntity), str(input.derivedFrom), str(timestamp)
      ].join('|'));
      if (token) feedbackId = 'fb_' + token;
    }
    var draft = {
      feedbackId: feedbackId,
      domain: str(input.domain),
      source: str(input.source),
      reason: str(input.reason),
      timestamp: timestamp
    };
    OPTIONAL_FIELDS.forEach(function (f) {
      var v = input[f];
      if (v !== undefined && v !== null && v !== '') draft[f] = str(v);
    });
    var verdict = validateFeedback(draft);
    if (!verdict.ok) return { ok: false, errors: verdict.errors, feedback: null };
    return { ok: true, errors: [], feedback: deepFreeze(draft) };
  }
  /* ── Describe：给诊断/日志用的**无正文**摘要（不输出 payload / memory / 自由文本）── */
  function describeFeedback(feedback) {
    var f = isPlainObject(feedback) ? feedback : {};
    var leaked = Object.keys(f).filter(function (k) {
      var lower = String(k).toLowerCase().replace(/[\s\-_]/g, '');
      return RESERVED_BODY_FIELDS.indexOf(lower) >= 0 || POLICY_ONLY_FIELDS.indexOf(lower) >= 0;
    });
    var verdict = validateFeedback(f);
    return {
      ok: verdict.ok,
      version: FEEDBACK_VERSION,
      feedbackId: str(f.feedbackId),
      domain: str(f.domain),
      source: str(f.source),
      reason: str(f.reason),
      severity: str(f.severity) || 'none',
      timestamp: isTimestamp(f.timestamp) ? f.timestamp : null,
      hasRelatedEntity: !!str(f.relatedEntity),
      hasDerivedFrom: !!str(f.derivedFrom),
      rejectedFields: leaked,
      errors: verdict.errors
    };
  }

  return {
    FEEDBACK_VERSION: FEEDBACK_VERSION,
    SEVERITY_VALUES: SEVERITY_VALUES,
    POLICY_ONLY_FIELDS: POLICY_ONLY_FIELDS,
    ALLOWED_FIELDS: ALLOWED_FIELDS,
    REQUIRED_FIELDS: REQUIRED_FIELDS,
    OPTIONAL_FIELDS: OPTIONAL_FIELDS,
    RESERVED_BODY_FIELDS: RESERVED_BODY_FIELDS,
    FEEDBACK_ERRORS: FEEDBACK_ERRORS,
    createFeedback: createFeedback,
    validateFeedback: validateFeedback,
    normalizeFeedback: normalizeFeedback,
    describeFeedback: describeFeedback
  };
});
