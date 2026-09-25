/* ====================================================================
   IB Observation Core — P26-2 · Observation Contract Foundation
   --------------------------------------------------------------------
   回答一个问题：**什么是 Observation？**

     Observation = 某个 source 在某个时间点，对某个 domain/entity
                   **当前状态**的**可验证描述**。

   ── 冻结边界（P26-2 §2/§3）──────────────────────────────────────────
     Observation owns（YES）：observation identity · source identity · timestamp ·
       freshness semantics · availability semantics
     Observation owns（NO）：canonical ownership · permission · execution · mutation ·
       persistence · routing · subscription · agent wake · session · resource arbitration

   ── 与 Event 的分界（P26-2 §4）──────────────────────────────────────
     Event       = "发生了什么"（past fact；本轮 P26-1 已冻结）
     Observation = "现在是什么"（current snapshot）
     冻结：EVENT_RECEIVED != OBSERVATION_AVAILABLE；OBSERVATION_AVAILABLE != AGENT_WAKE。

   ── 本模块**不是** ──────────────────────────────────────────────────
     Observation Bus · Observer Registry · Subscription System · Realtime Stream ·
     Frame/Vision/Voice Pipeline · Observation Store / Cache · Session Manager

   ── 纯度 ─────────────────────────────────────────────────────────────
     零 DOM / 零 IndexedDB / 零 localStorage / 零 fetch / 零 IPC / 零 provider / 零模型 /
     零权威 / 零 executor / 零 writer / 零订阅 / 零定时器 / 零时钟（**不读 Date.now**）/
     零随机（**不用 Math.random**）。时间与 id 全部由调用方注入；秘密探测复用既有纯 helper。
   ==================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(null, require('./chat-core.js'), require('./voice-message-core.js'));
  } else {
    root.IBObservationCore = factory(root, root.IBChatCore, root.IBVoiceMessage);
  }
})(typeof self !== 'undefined' ? self : this, function (root, CHAT_CORE, VOICE) {
  'use strict';

  var OBSERVATION_VERSION = 'observation/v1';
  /* freshness 闭集：观察必须能说"这有多新"，但不能自动刷新（没有时钟）。 */
  var FRESHNESS_VALUES = Object.freeze(['fresh', 'stale', 'unknown']);
  /* availability 闭集：source 当前**能不能**提供这个观察。 */
  var AVAILABILITY_VALUES = Object.freeze(['available', 'unavailable', 'unknown']);
  /* 观察**不得**携带的状态正文槽（§8）：出现即拒绝 —— 大对象必须走 resource reference，
     不属于 observation core。这里同时覆盖精确键与包含式危险键（base64 / buffer / snapshot …）。 */
  var RESERVED_VALUE_FIELDS = Object.freeze([
    'value', 'snapshot', 'payload', 'data', 'content', 'body', 'text', 'state', 'row', 'record',
    'canonical', 'canonicalrow', 'fullstate', 'inline'
  ]);
  var RESERVED_VALUE_PATTERN = /(base64|dataurl|buffer|blob|objecturl|framebase64|subtitletext|fullactivity|imagebytes|audioformat)/;
  var ALLOWED_FIELDS = Object.freeze(['observationId', 'domain', 'entityId', 'source', 'observedAt',
    'freshness', 'availability', 'valueRef', 'version']);
  var OPTIONAL_FIELDS = Object.freeze(['valueRef']);
  var REQUIRED_FIELDS = Object.freeze(['observationId', 'domain', 'entityId', 'source', 'observedAt',
    'freshness', 'availability']);
  var MAX_ID_LEN = 200;
  var MAX_DEPTH = 4;
  var CONTROL_PATTERN = /[\u0000-\u001F\u007F]/;
  var ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:\-@|/]*$/;
  /* valueRef 是"状态位置引用"（不是值本身），因此允许 URI fragment / query 形态。 */
  var REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:\-@|/#?=&]*$/;
  var TOKEN_PATTERN = /^[a-z][a-z0-9_]*$/;
  var SOURCE_PATTERN = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$/;
  var OBSERVATION_ERRORS = Object.freeze([
    'not-an-object', 'unknown-field', 'forbidden-value-field', 'missing-observation-id',
    'bad-observation-id', 'missing-domain', 'bad-domain', 'missing-entity-id', 'bad-entity-id',
    'missing-source', 'bad-source', 'missing-observed-at', 'bad-observed-at',
    'missing-freshness', 'bad-freshness', 'missing-availability', 'bad-availability',
    'bad-value-ref', 'secret-in-observation', 'not-serializable', 'too-deep', 'not-json-value'
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
  /* 输入形状扫描：未知字段与状态正文字段**一律拒绝**（不是静默丢弃）——
     Observation 描述"状态在哪里"，不携带完整状态（§7/§8）。 */
  function scanInputShape(input) {
    var errors = [];
    var keys = isPlainObject(input) ? Object.keys(input) : [];
    for (var i = 0; i < keys.length; i++) {
      var raw = String(keys[i]);
      var lower = raw.toLowerCase().replace(/[\s\-_]/g, '');
      if (RESERVED_VALUE_FIELDS.indexOf(lower) >= 0 || RESERVED_VALUE_PATTERN.test(lower)) {
        errors.push('forbidden-value-field:' + raw);
        continue;
      }
      if (ALLOWED_FIELDS.indexOf(raw) < 0) errors.push('unknown-field:' + raw);
    }
    return dedupe(errors);
  }
  /* ── 校验（只验证 shape / syntax / 闭集；**不**验证任何 domain business schema）── */
  function validateObservation(observation, options) {
    var errors = [];
    if (!isPlainObject(observation)) return { ok: false, errors: ['not-an-object'] };
    errors = errors.concat(scanInputShape(observation));
    if (observation.observationId === undefined || observation.observationId === null || str(observation.observationId).trim() === '') errors.push('missing-observation-id');
    else if (!usableId(observation.observationId)) errors.push('bad-observation-id');
    if (observation.domain === undefined || observation.domain === null || str(observation.domain).trim() === '') errors.push('missing-domain');
    else if (!TOKEN_PATTERN.test(str(observation.domain)) || str(observation.domain).length > 40) errors.push('bad-domain');
    if (observation.entityId === undefined || observation.entityId === null || str(observation.entityId).trim() === '') errors.push('missing-entity-id');
    else if (!usableId(observation.entityId)) errors.push('bad-entity-id');
    if (observation.source === undefined || observation.source === null || str(observation.source).trim() === '') errors.push('missing-source');
    else if (!SOURCE_PATTERN.test(str(observation.source)) || str(observation.source).length > 80) errors.push('bad-source');
    if (observation.observedAt === undefined || observation.observedAt === null || observation.observedAt === '') errors.push('missing-observed-at');
    else if (typeof observation.observedAt !== 'number' || !isFinite(observation.observedAt) || observation.observedAt <= 0) errors.push('bad-observed-at');
    if (observation.freshness === undefined || observation.freshness === null || str(observation.freshness) === '') errors.push('missing-freshness');
    else if (FRESHNESS_VALUES.indexOf(str(observation.freshness)) < 0) errors.push('bad-freshness');
    if (observation.availability === undefined || observation.availability === null || str(observation.availability) === '') errors.push('missing-availability');
    else if (AVAILABILITY_VALUES.indexOf(str(observation.availability)) < 0) errors.push('bad-availability');
    /* 空的 optional 视为"未提供"（与 create/normalize 的策略一致）。 */
    if (observation.valueRef !== undefined && observation.valueRef !== null && str(observation.valueRef) !== '') {
      var ref = str(observation.valueRef);
      if (!ref || ref !== ref.trim() || ref.length > MAX_ID_LEN || CONTROL_PATTERN.test(ref) || !REF_PATTERN.test(ref)) {
        errors.push('bad-value-ref');
      }
    }
    var jsonErrors = [], present = {};
    Object.keys(observation).forEach(function (k) { if (observation[k] !== undefined) present[k] = observation[k]; });
    if (!isJsonValue(present, 0, jsonErrors, '')) errors = errors.concat(jsonErrors);
    if (hasSecret({
      observationId: observation.observationId, domain: observation.domain, entityId: observation.entityId,
      source: observation.source, valueRef: observation.valueRef
    })) errors.push('secret-in-observation');
    errors = dedupe(errors);
    return { ok: errors.length === 0, errors: errors };
  }

  /* ── 规范化：只保留闭集字段（顺序稳定），并深冻结 ────────────────────────
     观察是"某一时刻的快照描述"，创建后不可变（与 P26-1 event / P25-3A descriptor 同风格）。 */
  function normalizeObservation(observation) {
    if (!isPlainObject(observation)) return { ok: false, errors: ['not-an-object'], observation: null };
    var shapeErrors = scanInputShape(observation);
    if (shapeErrors.length) return { ok: false, errors: shapeErrors, observation: null };
    var out = {
      observationId: str(observation.observationId),
      domain: str(observation.domain),
      entityId: str(observation.entityId),
      source: str(observation.source),
      observedAt: observation.observedAt,
      freshness: str(observation.freshness),
      availability: str(observation.availability)
    };
    OPTIONAL_FIELDS.forEach(function (f) {
      var v = observation[f];
      if (v !== undefined && v !== null && v !== '') out[f] = str(v);
    });
    var verdict = validateObservation(out);
    if (!verdict.ok) return { ok: false, errors: verdict.errors, observation: null };
    return { ok: true, errors: [], observation: deepFreeze(out) };
  }

  /* ── 创建：唯一入口。observationId 与 observedAt **必须**由调用方提供或注入 ───
     options:
       observedAt    : number  —— 注入的"观察时刻"（本模块**不读 Date.now**）
       observationId : string  —— 注入的观察身份（优先于派生）
     派生身份是**确定性**的（stableToken 对 domain|entityId|source|observedAt|valueRef 取哈希）：
     同一 source 对同一实体在同一时刻的重复观察得到同一 observationId ⇒ consumer 可据此去重。 */
  function createObservation(input, options) {
    var opts = isPlainObject(options) ? options : {};
    if (!isPlainObject(input)) return { ok: false, errors: ['not-an-object'], observation: null };
    var shapeErrors = scanInputShape(input);
    if (shapeErrors.length) return { ok: false, errors: shapeErrors, observation: null };
    var observedAt = (input.observedAt === undefined || input.observedAt === null || input.observedAt === '')
      ? opts.observedAt
      : input.observedAt;
    var observationId = str(input.observationId) || str(opts.observationId);
    if (!observationId) {
      var token = stableToken([
        str(input.domain), str(input.entityId), str(input.source), str(observedAt), str(input.valueRef)
      ].join('|'));
      if (token) observationId = 'obs_' + token;
    }
    var draft = {
      observationId: observationId,
      domain: str(input.domain),
      entityId: str(input.entityId),
      source: str(input.source),
      observedAt: observedAt,
      freshness: str(input.freshness),
      availability: str(input.availability)
    };
    OPTIONAL_FIELDS.forEach(function (f) {
      var v = input[f];
      if (v !== undefined && v !== null && v !== '') draft[f] = str(v);
    });
    var verdict = validateObservation(draft);
    if (!verdict.ok) return { ok: false, errors: verdict.errors, observation: null };
    return { ok: true, errors: [], observation: deepFreeze(draft) };
  }

  /* ── Freshness 派生（**纯函数**；不自动刷新、不读时钟）────────────────────
     freshnessOf(observation, { now, maxAgeMs }) →
       'unknown'  当 now / observedAt 缺失或非法（无法判断）
       'stale'    当 now - observedAt > maxAgeMs
       'fresh'    否则
     观察自带的 freshness 值（producer 声明）与这里**派生**的新鲜度是两个不同的东西：
     前者是 producer 的声明，后者是消费者用注入的时间算出来的判断。 */
  function freshnessOf(observation, context) {
    var o = isPlainObject(observation) ? observation : {};
    var c = isPlainObject(context) ? context : {};
    var now = c.now, observedAt = o.observedAt;
    if (typeof now !== 'number' || !isFinite(now) || now <= 0) return 'unknown';
    if (typeof observedAt !== 'number' || !isFinite(observedAt) || observedAt <= 0) return 'unknown';
    if (now < observedAt) return 'unknown';
    var maxAgeMs = Number(c.maxAgeMs);
    if (!isFinite(maxAgeMs) || maxAgeMs <= 0) return 'fresh';
    return (now - observedAt > maxAgeMs) ? 'stale' : 'fresh';
  }

  /* ── Describe：给诊断/日志用的**无状态正文**摘要（§29：不得输出状态正文）── */
  function describeObservation(observation) {
    var o = isPlainObject(observation) ? observation : {};
    var leaked = Object.keys(o).filter(function (k) {
      var lower = String(k).toLowerCase().replace(/[\s\-_]/g, '');
      return RESERVED_VALUE_FIELDS.indexOf(lower) >= 0 || RESERVED_VALUE_PATTERN.test(lower);
    });
    var verdict = validateObservation(o);
    return {
      ok: verdict.ok,
      version: OBSERVATION_VERSION,
      observationId: str(o.observationId),
      domain: str(o.domain),
      entityId: str(o.entityId),
      source: str(o.source),
      observedAt: (typeof o.observedAt === 'number' && isFinite(o.observedAt)) ? o.observedAt : null,
      freshness: str(o.freshness),
      availability: str(o.availability),
      hasValueRef: !!str(o.valueRef),
      valueFieldsRejected: leaked,
      errors: verdict.errors
    };
  }

  return {
    OBSERVATION_VERSION: OBSERVATION_VERSION,
    FRESHNESS_VALUES: FRESHNESS_VALUES,
    AVAILABILITY_VALUES: AVAILABILITY_VALUES,
    ALLOWED_FIELDS: ALLOWED_FIELDS,
    REQUIRED_FIELDS: REQUIRED_FIELDS,
    OPTIONAL_FIELDS: OPTIONAL_FIELDS,
    RESERVED_VALUE_FIELDS: RESERVED_VALUE_FIELDS,
    OBSERVATION_ERRORS: OBSERVATION_ERRORS,
    createObservation: createObservation,
    validateObservation: validateObservation,
    normalizeObservation: normalizeObservation,
    freshnessOf: freshnessOf,
    describeObservation: describeObservation
  };
});
