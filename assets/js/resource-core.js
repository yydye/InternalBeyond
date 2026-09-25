/* ====================================================================
   IB Resource Core — P26-4 · Resource Arbitration Boundary Foundation
   --------------------------------------------------------------------
   回答一个问题：**什么是 Resource，以及"两个 requester 同时要它"的契约结果是什么？**

     Resource = a constrained entity whose simultaneous usage requires
                explicit ownership or arbitration.

   不是：Capability · Session · Observation · Event · Permission。

   ── 冻结边界（P26-4 §5）─────────────────────────────────────────────
     Resource Core owns（YES）：resource identity · ownership concept ·
       conflict semantics · arbitration result shape
     Resource Core owns（NO）：actual hardware control · opening device ·
       releasing device · scheduling work · persistence · transport

   ── 仲裁结果闭集（§8）───────────────────────────────────────────────
     grant    —— 该 claim 在当前 holders 下可以满足（剩余容量足够）
     conflict —— 容量已被他人占用/将被超出 ⇒ **不抢占、不排队、不等待**（caller 自己决定何时重试）
     deny     —— claim 本身不可用（非法 / 未知资源 / amount 超上限）
     **没有** auto-preempt、没有 priority、没有 queue（§16/§17）。

   ── 本模块**不是** ──────────────────────────────────────────────────
     Resource Manager · Lease Store · Lock Service · Priority Engine · Scheduler ·
     Queue System · Device Manager · IPC Resource Controller · Hardware Bridge

   ── 纯度 ─────────────────────────────────────────────────────────────
     零 DOM / 零 IndexedDB / 零 localStorage / 零 fetch / 零 IPC / 零硬件 / 零 provider /
     零模型 / 零权威 / 零 executor / 零订阅 / 零定时器 / 零时钟（**不读 Date.now**）/
     零随机（**不用 Math.random**）；holders 由 caller 提供（Core **不持有**任何状态）；
     秘密探测复用既有纯 helper。
   ==================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(null, require('./chat-core.js'), require('./voice-message-core.js'));
  } else {
    root.IBResourceCore = factory(root, root.IBChatCore, root.IBVoiceMessage);
  }
})(typeof self !== 'undefined' ? self : this, function (root, CHAT_CORE, VOICE) {
  'use strict';

  var RESOURCE_VERSION = 'resource/v1';
  var ARBITRATION_DECISIONS = Object.freeze(['grant', 'conflict', 'deny']);
  /* 仲裁**不**实现抢占/排队/优先级/租约 —— 只给结果形状（§16/§17）。 */
  var RESOURCE_CLASSES = Object.freeze(['exclusive', 'shared', 'quota', 'virtual']);
  var ALLOWED_RESOURCE_FIELDS = Object.freeze(['resourceId', 'domain', 'capacity', 'resourceClass', 'version']);
  var REQUIRED_RESOURCE_FIELDS = Object.freeze(['resourceId', 'domain', 'capacity']);
  var ALLOWED_CLAIM_FIELDS = Object.freeze(['claimId', 'resourceId', 'requesterId', 'sessionId', 'amount', 'version']);
  var REQUIRED_CLAIM_FIELDS = Object.freeze(['claimId', 'resourceId', 'requesterId']);
  /* Resource / Claim **不得**携带业务正文（与 P26-1/2/3 同一策略）。 */
  var RESERVED_BODY_FIELDS = Object.freeze([
    'content', 'body', 'text', 'payload', 'data', 'value', 'snapshot', 'record', 'row', 'state',
    'messages', 'stream', 'buffer', 'base64', 'dataurl', 'blob', 'images', 'audio', 'device',
    'handle', 'descriptor', 'file', 'path', 'credential'
  ]);
  var MAX_ID_LEN = 200;
  var MAX_CAPACITY = 1000000;
  var CONTROL_PATTERN = /[\u0000-\u001F\u007F]/;
  var ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:\-@|/]*$/;
  var TOKEN_PATTERN = /^[a-z][a-z0-9_]*$/;
  var RESOURCE_ERRORS = Object.freeze([
    'not-an-object', 'unknown-field', 'forbidden-body-field', 'missing-resource-id', 'bad-resource-id',
    'missing-domain', 'bad-domain', 'missing-capacity', 'bad-capacity', 'bad-resource-class',
    'missing-claim-id', 'bad-claim-id', 'missing-requester-id', 'bad-requester-id',
    'missing-claim-resource-id', 'bad-session-id', 'bad-amount', 'amount-exceeds-capacity',
    'resource-mismatch', 'bad-holders', 'secret-in-resource', 'not-serializable', 'too-deep', 'not-json-value'
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
  function isPositiveInt(v) { return typeof v === 'number' && isFinite(v) && v > 0 && Math.floor(v) === v; }
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
  function scanShape(input, allowed) {
    var errors = [];
    var keys = isPlainObject(input) ? Object.keys(input) : [];
    for (var i = 0; i < keys.length; i++) {
      var raw = String(keys[i]);
      var lower = raw.toLowerCase().replace(/[\s\-_]/g, '');
      if (RESERVED_BODY_FIELDS.indexOf(lower) >= 0) { errors.push('forbidden-body-field:' + raw); continue; }
      if (allowed.indexOf(raw) < 0) errors.push('unknown-field:' + raw);
    }
    return dedupe(errors);
  }

  /* ── Resource identity（§6）：stable / injectable / deterministic；**无全局注册表** ──
     exclusivity 用容量表达：exclusive ⇒ capacity 1；shared ⇒ capacity>1；quota ⇒ capacity=预算；
     virtual ⇒ capacity 1（每个 resourceId 一个 surface）。resourceClass 只是**可选标签**，
     不参与仲裁（分类由文档规定，Core 不持有产品词汇表）。 */
  function createResourceIdentity(input, options) {
    var opts = isPlainObject(options) ? options : {};
    var src = isPlainObject(input) ? input : {};
    var injected = str(src.resourceId) || str(opts.resourceId);
    if (injected) {
      if (!usableId(injected)) return { ok: false, errors: ['bad-resource-id'], resourceId: '' };
      return { ok: true, errors: [], resourceId: injected };
    }
    var token = stableToken([str(src.domain), str(src.capacity)].join('|'));
    if (!token) return { ok: false, errors: ['bad-resource-id'], resourceId: '' };
    return { ok: true, errors: [], resourceId: 'res_' + token };
  }
  /* ── 校验：只验证 shape / 闭集 / 语法；**不**验证任何物理设备事实 ─────────── */
  function validateResource(resource) {
    var errors = [];
    if (!isPlainObject(resource)) return { ok: false, errors: ['not-an-object'] };
    errors = errors.concat(scanShape(resource, ALLOWED_RESOURCE_FIELDS));
    if (resource.resourceId === undefined || resource.resourceId === null || str(resource.resourceId).trim() === '') errors.push('missing-resource-id');
    else if (!usableId(resource.resourceId)) errors.push('bad-resource-id');
    if (resource.domain === undefined || resource.domain === null || str(resource.domain).trim() === '') errors.push('missing-domain');
    else if (!TOKEN_PATTERN.test(str(resource.domain)) || str(resource.domain).length > 40) errors.push('bad-domain');
    if (resource.capacity === undefined || resource.capacity === null || resource.capacity === '') errors.push('missing-capacity');
    else if (!isPositiveInt(resource.capacity) || resource.capacity > MAX_CAPACITY) errors.push('bad-capacity');
    if (resource.resourceClass !== undefined && resource.resourceClass !== null && str(resource.resourceClass) !== '') {
      if (RESOURCE_CLASSES.indexOf(str(resource.resourceClass)) < 0) errors.push('bad-resource-class');
    }
    var jsonErrors = [], present = {};
    Object.keys(resource).forEach(function (k) { if (resource[k] !== undefined) present[k] = resource[k]; });
    if (!isJsonValue(present, 0, jsonErrors, '')) errors = errors.concat(jsonErrors);
    if (hasSecret({ resourceId: resource.resourceId, domain: resource.domain })) errors.push('secret-in-resource');
    errors = dedupe(errors);
    return { ok: errors.length === 0, errors: errors };
  }
  /* ── Resource 构造（唯一入口；deterministic id；深冻结）────────────────── */
  function createResource(input, options) {
    var opts = isPlainObject(options) ? options : {};
    if (!isPlainObject(input)) return { ok: false, errors: ['not-an-object'], resource: null };
    var shapeErrors = scanShape(input, ALLOWED_RESOURCE_FIELDS);
    if (shapeErrors.length) return { ok: false, errors: shapeErrors, resource: null };
    var idResult = createResourceIdentity({ resourceId: input.resourceId, domain: input.domain, capacity: input.capacity },
      { resourceId: opts.resourceId });
    if (!idResult.ok) return { ok: false, errors: idResult.errors, resource: null };
    var draft = { resourceId: idResult.resourceId, domain: str(input.domain), capacity: input.capacity };
    if (input.resourceClass !== undefined && input.resourceClass !== null && str(input.resourceClass) !== '') draft.resourceClass = str(input.resourceClass);
    var verdict = validateResource(draft);
    if (!verdict.ok) return { ok: false, errors: verdict.errors, resource: null };
    return { ok: true, errors: [], resource: deepFreeze(draft) };
  }
  /* ── Claim（§7）：requesterId 是 canonical id —— session / capability / runtime 都可以是
     requester（契约不区分层，也不引入 requester 类型词表）。amount 默认 1；
     "独占"= amount === resource.capacity。 */
  function validateClaim(claim) {
    var errors = [];
    if (!isPlainObject(claim)) return { ok: false, errors: ['not-an-object'] };
    errors = errors.concat(scanShape(claim, ALLOWED_CLAIM_FIELDS));
    if (claim.claimId === undefined || claim.claimId === null || str(claim.claimId).trim() === '') errors.push('missing-claim-id');
    else if (!usableId(claim.claimId)) errors.push('bad-claim-id');
    if (claim.resourceId === undefined || claim.resourceId === null || str(claim.resourceId).trim() === '') errors.push('missing-claim-resource-id');
    else if (!usableId(claim.resourceId)) errors.push('bad-resource-id');
    if (claim.requesterId === undefined || claim.requesterId === null || str(claim.requesterId).trim() === '') errors.push('missing-requester-id');
    else if (!usableId(claim.requesterId)) errors.push('bad-requester-id');
    if (claim.sessionId !== undefined && claim.sessionId !== null && str(claim.sessionId) !== '') {
      if (!usableId(claim.sessionId)) errors.push('bad-session-id');
    }
    if (claim.amount !== undefined && claim.amount !== null && claim.amount !== '') {
      if (!isPositiveInt(claim.amount) || claim.amount > MAX_CAPACITY) errors.push('bad-amount');
    }
    var jsonErrors = [], present = {};
    Object.keys(claim).forEach(function (k) { if (claim[k] !== undefined) present[k] = claim[k]; });
    if (!isJsonValue(present, 0, jsonErrors, '')) errors = errors.concat(jsonErrors);
    if (hasSecret({ claimId: claim.claimId, resourceId: claim.resourceId, requesterId: claim.requesterId, sessionId: claim.sessionId })) errors.push('secret-in-resource');
    errors = dedupe(errors);
    return { ok: errors.length === 0, errors: errors };
  }
  function createClaim(input, options) {
    var opts = isPlainObject(options) ? options : {};
    if (!isPlainObject(input)) return { ok: false, errors: ['not-an-object'], claim: null };
    var shapeErrors = scanShape(input, ALLOWED_CLAIM_FIELDS);
    if (shapeErrors.length) return { ok: false, errors: shapeErrors, claim: null };
    var amount = (input.amount === undefined || input.amount === null || input.amount === '') ? 1 : input.amount;
    var claimId = str(input.claimId) || str(opts.claimId);
    if (!claimId) {
      var token = stableToken([str(input.resourceId), str(input.requesterId), str(input.sessionId), str(amount)].join('|'));
      if (token) claimId = 'clm_' + token;
    }
    var draft = {
      claimId: claimId,
      resourceId: str(input.resourceId),
      requesterId: str(input.requesterId),
      amount: amount
    };
    if (input.sessionId !== undefined && input.sessionId !== null && str(input.sessionId) !== '') draft.sessionId = str(input.sessionId);
    var verdict = validateClaim(draft);
    if (!verdict.ok) return { ok: false, errors: verdict.errors, claim: null };
    return { ok: true, errors: [], claim: deepFreeze(draft) };
  }

  /* ── 仲裁（§8/§16）：**纯函数**，状态由 caller 提供（holders = 当前有效 claim 列表）──
     rows = [{ claimId, resourceId, requesterId, amount }]（只读；Core 不持有、不修改）
     结果闭集：grant / conflict / deny。deterministic；不抢占、不排队、不等待。
       deny     —— resource/claim 非法，或 claim 的资源与 resource 不一致，或 amount > capacity
       conflict —— 同一 requester 已持有同一资源（重复占用），或剩余容量不足
       grant    —— 否则（并返回 remaining = capacity - 已占用量 - 本次 amount）
     注意：**没有** priority 参数、**没有** preempt、**没有** queue/TTL（§17：priority 不提前引入）。 */
  function evaluateConflict(resource, claim, holders) {
    var verdict = validateResource(resource);
    if (!verdict.ok) return { decision: 'deny', reason: 'invalid-resource', remaining: 0, errors: verdict.errors };
    var claimCheck = validateClaim(claim);
    if (!claimCheck.ok) return { decision: 'deny', reason: 'invalid-claim', remaining: 0, errors: claimCheck.errors };
    if (str(claim.resourceId) !== str(resource.resourceId)) {
      return { decision: 'deny', reason: 'resource-mismatch', remaining: 0, errors: ['resource-mismatch'] };
    }
    var amount = Number(claim.amount === undefined ? 1 : claim.amount);
    if (!isPositiveInt(amount) || amount > resource.capacity) {
      return { decision: 'deny', reason: 'amount-exceeds-capacity', remaining: 0, errors: ['amount-exceeds-capacity'] };
    }
    var rows = Array.isArray(holders) ? holders : [];
    var errors = [];
    var used = 0;
    for (var i = 0; i < rows.length; i++) {
      var h = rows[i];
      if (!isPlainObject(h)) { errors.push('bad-holders:' + i); continue; }
      if (str(h.resourceId) !== str(resource.resourceId)) continue;            /* 只统计同一资源 */
      var rowAmount = Number(h.amount === undefined ? 1 : h.amount);
      if (!isPositiveInt(rowAmount)) { errors.push('bad-holders:' + i); continue; }
      if (str(h.claimId) === str(claim.claimId)) { errors.push('bad-holders:' + i); continue; } /* 同一 claim 不应已在 holders */
      if (str(h.requesterId) === str(claim.requesterId)) {
        /* 同一 requester 重复占用同一资源 ⇒ 冲突（不自动合并、不自动抢占） */
        return { decision: 'conflict', reason: 'requester-already-holds', remaining: Math.max(0, resource.capacity - used), errors: [] };
      }
      used += rowAmount;
    }
    if (errors.length) return { decision: 'deny', reason: 'bad-holders', remaining: 0, errors: dedupe(errors) };
    var remaining = resource.capacity - used;
    if (amount > remaining) return { decision: 'conflict', reason: 'capacity-full', remaining: Math.max(0, remaining), errors: [] };
    return { decision: 'grant', reason: 'allowed', remaining: remaining - amount, errors: [] };
  }
  /* 便捷只读视图：当前剩余容量（纯函数；不修改 holders）。 */
  function remainingCapacity(resource, holders) {
    var verdict = validateResource(resource);
    if (!verdict.ok) return { ok: false, remaining: 0, errors: verdict.errors };
    var rows = Array.isArray(holders) ? holders : [];
    var used = 0;
    for (var i = 0; i < rows.length; i++) {
      var h = rows[i];
      if (!isPlainObject(h)) continue;
      if (str(h.resourceId) !== str(resource.resourceId)) continue;
      var rowAmount = Number(h.amount === undefined ? 1 : h.amount);
      if (!isPositiveInt(rowAmount)) continue;
      used += rowAmount;
    }
    return { ok: true, remaining: Math.max(0, resource.capacity - used), errors: [] };
  }

  return {
    RESOURCE_VERSION: RESOURCE_VERSION,
    RESOURCE_CLASSES: RESOURCE_CLASSES,
    ARBITRATION_DECISIONS: ARBITRATION_DECISIONS,
    ALLOWED_RESOURCE_FIELDS: ALLOWED_RESOURCE_FIELDS,
    ALLOWED_CLAIM_FIELDS: ALLOWED_CLAIM_FIELDS,
    RESERVED_BODY_FIELDS: RESERVED_BODY_FIELDS,
    RESOURCE_ERRORS: RESOURCE_ERRORS,
    createResourceIdentity: createResourceIdentity,
    createResource: createResource,
    validateResource: validateResource,
    createClaim: createClaim,
    validateClaim: validateClaim,
    evaluateConflict: evaluateConflict,
    remainingCapacity: remainingCapacity
  };
});
