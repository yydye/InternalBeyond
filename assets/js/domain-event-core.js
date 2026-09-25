/* ====================================================================
   IB Domain Event Core — P26-1 · Domain Event Contract Foundation
   --------------------------------------------------------------------
   回答一个问题：**什么东西有资格叫 Domain Event？**

     Event describes a domain fact.（"发生了什么"，不是"现在是什么"）

   ── 冻结的 15 条不变量（P26-1 §2）────────────────────────────────────
     1. Event describes a domain fact.
     2. Event does not own canonical business data.
     3. Event is not a second canonical writer.
     4. Event must have stable identity.
     5. Event ordering is scoped（per-domain / per-entity；**禁止**默认 global ordering）。
     6. Persistence is domain policy（本模块**不**持久化）。
     7. ACK is domain / transport policy（本模块**不**实现 ACK）。
     8. Replay is not assumed（本模块**不**实现 replay；IB 不是 event-sourced）。
     9. Cross-runtime delivery is not assumed（本模块 runtime-neutral，但**不**做 transport）。
    10. Event emission does not automatically wake an Agent.
    11. Event does not bypass Domain Authority.
    12. Event does not bypass Domain Executor.
    13. Event does not bypass P23 Delivery.
    14. Event does not rewrite P24 Group Runtime.
    15. Event is downstream of an already established domain fact（post-effect fact event）。

   ── 本模块**不是**（P26-1 §3）───────────────────────────────────────
     Event Bus · Transport Message · UI Event · DOM Event · Callback · Observation ·
     Agent Trigger · Canonical Record · Audit Log · Queue Item · Notification

   ── 纯度 ─────────────────────────────────────────────────────────────
     零 DOM / 零 IndexedDB / 零 localStorage / 零 fetch / 零文件 / 零 provider / 零模型 /
     零权威 / 零 executor / 零 writer / 零订阅 / 零定时器 / 零时钟（**不读 Date.now**）/
     零随机（**不用 Math.random**）。时间与 id 全部由调用方注入；秘密探测复用既有纯 helper。
   ==================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(null, require('./chat-core.js'), require('./voice-message-core.js'));
  } else {
    root.IBDomainEventCore = factory(root, root.IBChatCore, root.IBVoiceMessage);
  }
})(typeof self !== 'undefined' ? self : this, function (root, CHAT_CORE, VOICE) {
  'use strict';

  var DOMAIN_EVENT_VERSION = 'domain-event/v1';
  /* ordering 只允许"域内/实体级"两个最小范围；session / turn 留待未来 session 契约。 */
  var ORDERING_SCOPES = Object.freeze(['entity', 'domain']);
  /* 事件**不得**携带的业务正文槽（§13/§14）：出现即拒绝，避免契约鼓励复制 canonical record。 */
  var RESERVED_BODY_FIELDS = Object.freeze([
    'content', 'body', 'text', 'message', 'payload', 'payloadrecord', 'canonicaldata', 'data',
    'record', 'row', 'snapshot', 'images', 'image', 'audio', 'base64', 'dataurl', 'voice',
    'transcript', 'memory', 'memories', 'summary', 'draft'
  ]);
  /* 事件字段闭集（严格形状；未知字段一律拒绝 —— 不给 metadata 逃生舱）。 */
  var ALLOWED_FIELDS = Object.freeze(['eventId', 'domain', 'type', 'entityId', 'timestamp',
    'actorId', 'origin', 'causationId', 'correlationId', 'version']);
  /* 输入侧的别名（只在 create/normalize 的**输入**上接受）：eventType 会被拆成 domain + type。
     规范形状里**只有** domain + type —— 单一词表持有者，不维护两份 authority。 */
  var INPUT_ALIASES = Object.freeze(['eventType']);
  var OPTIONAL_FIELDS = Object.freeze(['actorId', 'origin', 'causationId', 'correlationId']);
  var REQUIRED_FIELDS = Object.freeze(['eventId', 'domain', 'type', 'entityId', 'timestamp']);
  var MAX_ID_LEN = 200;
  var MAX_ORIGIN_LEN = 40;
  var MAX_DEPTH = 4;
  var CONTROL_PATTERN = /[\u0000-\u001F\u007F]/;
  var ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:\-@|]*$/;
  var TOKEN_PATTERN = /^[a-z][a-z0-9_]*$/;
  var EVENT_TYPES = Object.freeze([
    'not-an-object', 'unknown-field', 'forbidden-body-field', 'missing-event-id', 'bad-event-id',
    'missing-domain', 'bad-domain', 'missing-event-type', 'bad-event-type', 'event-type-domain-mismatch',
    'missing-entity-id', 'bad-entity-id', 'missing-timestamp', 'bad-timestamp',
    'bad-actor-id', 'bad-origin', 'bad-causation-id', 'bad-correlation-id',
    'causation-required', 'secret-in-event', 'not-serializable', 'too-deep', 'not-json-value'
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
  function usableId(v, maxLen) {
    var s = str(v);
    if (!s || s !== s.trim() || s.length > (maxLen || MAX_ID_LEN)) return false;
    if (CONTROL_PATTERN.test(s)) return false;
    return ID_PATTERN.test(s);
  }
  function isJsonValue(value, depth, errors, path) {
    var here = path || '';
    if (depth > MAX_DEPTH) { errors.push('too-deep:' + here); return false; }
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
  /* 「发生了什么」的规范表达：domain 是唯一词表持有者，type 是它下面的动作词。
     两者**必须**同时存在且互相匹配（不接受 domain 与 eventType 各自维护一份 authority）。 */
  function splitEventType(input) {
    var out = { domain: str(input.domain), type: str(input.type), errors: [] };
    if (input.eventType !== undefined) {
      var et = str(input.eventType);
      var parts = et.split('.');
      if (parts.length !== 2 || !parts[0] || !parts[1]) { out.errors.push('bad-event-type'); return out; }
      if (out.domain && out.domain !== parts[0]) { out.errors.push('event-type-domain-mismatch'); return out; }
      out.domain = out.domain || parts[0];
      out.type = out.type || parts[1];
    }
    return out;
  }
  /* 输入形状扫描：未知字段与业务正文字段**一律拒绝**（不是静默丢弃）——
     契约不得给 metadata / body 留逃生舱（§14/§44）。 */
  function scanInputShape(input) {
    var errors = [];
    var keys = isPlainObject(input) ? Object.keys(input) : [];
    for (var i = 0; i < keys.length; i++) {
      var lower = String(keys[i]).toLowerCase().replace(/[\s\-_]/g, '');
      if (RESERVED_BODY_FIELDS.indexOf(lower) >= 0) { errors.push('forbidden-body-field:' + keys[i]); continue; }
      if (ALLOWED_FIELDS.indexOf(keys[i]) < 0 && INPUT_ALIASES.indexOf(keys[i]) < 0) errors.push('unknown-field:' + keys[i]);
    }
    return dedupe(errors);
  }
  /* ── 校验（只验证 shape / syntax / 不变量；**不**验证任何 domain business schema）── */
  function validateDomainEvent(event, options) {
    var opts = isPlainObject(options) ? options : {};
    var errors = [];
    if (!isPlainObject(event)) return { ok: false, errors: ['not-an-object'] };
    var keys = Object.keys(event);
    for (var i = 0; i < keys.length; i++) {
      var lower = String(keys[i]).toLowerCase().replace(/[\s\-_]/g, '');
      if (RESERVED_BODY_FIELDS.indexOf(lower) >= 0) { errors.push('forbidden-body-field:' + keys[i]); continue; }
      if (ALLOWED_FIELDS.indexOf(keys[i]) < 0) errors.push('unknown-field:' + keys[i]);
    }
    if (event.eventId === undefined || event.eventId === null || str(event.eventId).trim() === '') errors.push('missing-event-id');
    else if (!usableId(event.eventId)) errors.push('bad-event-id');
    var split = splitEventType(event);
    errors = errors.concat(split.errors);
    var domain = str(event.domain);
    if (!domain) errors.push('missing-domain');
    else if (!TOKEN_PATTERN.test(domain) || domain.length > 40) errors.push('bad-domain');
    var type = str(event.type);
    if (!type) errors.push('missing-event-type');
    else if (!TOKEN_PATTERN.test(type) || type.length > 60) errors.push('bad-event-type');
    if (event.entityId === undefined || event.entityId === null || str(event.entityId).trim() === '') errors.push('missing-entity-id');
    else if (!usableId(event.entityId)) errors.push('bad-entity-id');
    if (event.timestamp === undefined || event.timestamp === null || event.timestamp === '') errors.push('missing-timestamp');
    else if (typeof event.timestamp !== 'number' || !isFinite(event.timestamp) || event.timestamp <= 0) errors.push('bad-timestamp');
    for (var j = 0; j < OPTIONAL_FIELDS.length; j++) {
      var f = OPTIONAL_FIELDS[j];
      var v = event[f];
      if (v === undefined || v === null || v === '') continue;
      if (f === 'origin') {
        if (!usableId(v, MAX_ORIGIN_LEN)) errors.push('bad-origin');
      } else if (!usableId(v)) {
        errors.push('bad-' + (f === 'actorId' ? 'actor-id' : f === 'causationId' ? 'causation-id' : 'correlation-id'));
      }
    }
    if (opts.requireCausation === true && !str(event.causationId)) errors.push('causation-required');
    var jsonErrors = [], present = {};
    Object.keys(event).forEach(function (k) { if (event[k] !== undefined) present[k] = event[k]; });
    if (!isJsonValue(present, 0, jsonErrors, '')) errors = errors.concat(jsonErrors);
    if (hasSecret({
      eventId: event.eventId, domain: event.domain, type: event.type, entityId: event.entityId,
      actorId: event.actorId, origin: event.origin, causationId: event.causationId, correlationId: event.correlationId
    })) errors.push('secret-in-event');
    errors = dedupe(errors);
    return { ok: errors.length === 0, errors: errors };
  }

  /* ── 规范化：只保留闭集字段（顺序稳定），并深冻结 ────────────────────────
     事件表达"已经发生的事实"，因此创建后不可变（与 P25-3A descriptor 的 deepFreeze 同风格）。 */
  function normalizeDomainEvent(event) {
    if (!isPlainObject(event)) return { ok: false, errors: ['not-an-object'], event: null };
    var shapeErrors = scanInputShape(event);
    if (shapeErrors.length) return { ok: false, errors: shapeErrors, event: null };
    var split = splitEventType(event);
    if (split.errors.length) return { ok: false, errors: split.errors, event: null };
    var out = {
      eventId: str(event.eventId),
      domain: split.domain,
      type: split.type,
      entityId: str(event.entityId),
      timestamp: event.timestamp
    };
    OPTIONAL_FIELDS.forEach(function (f) {
      var v = event[f];
      if (v !== undefined && v !== null && v !== '') out[f] = str(v);
    });
    var verdict = validateDomainEvent(out);
    if (!verdict.ok) return { ok: false, errors: verdict.errors, event: null };
    return { ok: true, errors: [], event: deepFreeze(out) };
  }

  /* ── 创建：唯一入口。eventId 与 timestamp **必须**由调用方提供或注入 ──────
     options:
       timestamp        : number      —— 注入的"事实发生时间"（本模块**不读 Date.now**）
       eventId          : string      —— 注入的事件身份（优先于派生）
       requireCausation : boolean     —— 该事件允许再次触发行为时置 true（causationId 变 REQUIRED）
     派生身份是**确定性**的（chat-core.stableToken 对 domain|type|entityId|timestamp|因果字段 取哈希）：
     同一事实重复创建得到同一 eventId ⇒ consumer 可以据此去重；本模块**不**提供持久去重表。 */
  function createDomainEvent(input, options) {
    var opts = isPlainObject(options) ? options : {};
    if (!isPlainObject(input)) return { ok: false, errors: ['not-an-object'], event: null };
    var shapeErrors = scanInputShape(input);
    if (shapeErrors.length) return { ok: false, errors: shapeErrors, event: null };
    var split = splitEventType(input);
    if (split.errors.length) return { ok: false, errors: split.errors, event: null };
    var timestamp = (input.timestamp === undefined || input.timestamp === null || input.timestamp === '')
      ? opts.timestamp
      : input.timestamp;
    var eventId = str(input.eventId) || str(opts.eventId);
    if (!eventId) {
      var token = stableToken([
        split.domain, split.type, str(input.entityId), str(timestamp),
        str(input.causationId), str(input.correlationId), str(input.actorId), str(input.origin)
      ].join('|'));
      if (token) eventId = 'evt_' + token;
    }
    var draft = {
      eventId: eventId,
      domain: split.domain,
      type: split.type,
      entityId: str(input.entityId),
      timestamp: timestamp
    };
    OPTIONAL_FIELDS.forEach(function (f) {
      var v = input[f];
      if (v !== undefined && v !== null && v !== '') draft[f] = str(v);
    });
    var verdict = validateDomainEvent(draft, { requireCausation: opts.requireCausation === true });
    if (!verdict.ok) return { ok: false, errors: verdict.errors, event: null };
    return { ok: true, errors: [], event: deepFreeze(draft) };
  }

  /* ── Ordering（作用域内；**没有**全局序，也没有 sequence number）──────────
     entity（默认）：domain + ':' + entityId  —— 同一实体的事实可按发生时间排序
     domain        ：domain                   —— 只保证"同域可比较"
     session / turn：**NOT PRESENT**（session 契约属 P26-3；本模块不引入 sessionId/turnId 字段） */
  function orderingKeyFor(event, scope) {
    var e = isPlainObject(event) ? event : {};
    var s = str(scope) || 'entity';
    if (ORDERING_SCOPES.indexOf(s) < 0) return '';
    var domain = str(e.domain);
    if (!domain) return '';
    if (s === 'domain') return domain;
    var entityId = str(e.entityId);
    if (!entityId) return '';
    return domain + ':' + entityId;
  }

  /* ── Dedupe key：域内 eventId（consumer 可据此去重；本模块**不**提供去重存储）── */
  function dedupeKeyFor(event) {
    var e = isPlainObject(event) ? event : {};
    var domain = str(e.domain), eventId = str(e.eventId);
    if (!domain || !eventId) return '';
    return 'de|' + stableToken(domain + '|' + eventId);
  }

  /* ── Describe：给诊断/日志用的**无业务正文**摘要（§37：不得输出业务正文）── */
  function describeEvent(event) {
    var e = isPlainObject(event) ? event : {};
    var leaked = Object.keys(e).filter(function (k) {
      return RESERVED_BODY_FIELDS.indexOf(String(k).toLowerCase().replace(/[\s\-_]/g, '')) >= 0;
    });
    var verdict = validateDomainEvent(e);
    return {
      ok: verdict.ok,
      version: DOMAIN_EVENT_VERSION,
      eventType: (str(e.domain) && str(e.type)) ? (str(e.domain) + '.' + str(e.type)) : '',
      domain: str(e.domain),
      type: str(e.type),
      entityId: str(e.entityId),
      timestamp: (typeof e.timestamp === 'number' && isFinite(e.timestamp)) ? e.timestamp : null,
      orderingKey: orderingKeyFor(e, 'entity'),
      dedupeKey: dedupeKeyFor(e),
      hasActor: !!str(e.actorId),
      hasOrigin: !!str(e.origin),
      hasCausation: !!str(e.causationId),
      hasCorrelation: !!str(e.correlationId),
      bodyFieldsRejected: leaked,
      errors: verdict.errors
    };
  }

  return {
    DOMAIN_EVENT_VERSION: DOMAIN_EVENT_VERSION,
    ORDERING_SCOPES: ORDERING_SCOPES,
    ALLOWED_FIELDS: ALLOWED_FIELDS,
    REQUIRED_FIELDS: REQUIRED_FIELDS,
    OPTIONAL_FIELDS: OPTIONAL_FIELDS,
    RESERVED_BODY_FIELDS: RESERVED_BODY_FIELDS,
    EVENT_ERRORS: EVENT_TYPES,
    createDomainEvent: createDomainEvent,
    validateDomainEvent: validateDomainEvent,
    normalizeDomainEvent: normalizeDomainEvent,
    orderingKeyFor: orderingKeyFor,
    dedupeKeyFor: dedupeKeyFor,
    describeEvent: describeEvent
  };
});
