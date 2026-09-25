/* ====================================================================
   IB Agent Capability Registry — P25-3A · Unified Agent Orchestration Foundation
   --------------------------------------------------------------------
   Registry 只回答一个问题：**IB 有什么能力？**

   它**不是**：
     · Permission Registry（不裁决）
     · Executor Registry（不执行）
     · Tool Router（不路由到具体实现）

   它只保存 capability **metadata** + 一个 runtime binding **key**（字符串引用），
   真正的 authority / executor 仍然属于各自的 domain（见 descriptor.authorityType）。

   ── 纯度 ─────────────────────────────────────────────────────────────
     零 DOM / 零 IndexedDB / 零 fetch / 零 provider / 零模型 / 零 Memory /
     零 Middle Brain / 零 scheduler / 零定时器；descriptor 必须可序列化（无函数闭包）。
   ==================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(null, require('./voice-message-core.js'));
  } else {
    root.IBAgentCapabilityRegistry = factory(root, root.IBVoiceMessage);
  }
})(typeof self !== 'undefined' ? self : this, function (root, VOICE) {
  'use strict';

  /* ── 最小充分分类（§6：不为漂亮架构造十几种 category）──────────────── */
  var CAPABILITY_KINDS = Object.freeze(['read', 'write', 'action']);
  /* authorityType 只声明"该能力由谁裁决"，实现永远在 domain 侧（§17）。 */
  var AUTHORITY_TYPES = Object.freeze(['autonomy', 'mutation', 'domain', 'manual', 'read-only']);
  var SIDE_EFFECTS = Object.freeze(['none', 'local', 'external']);
  var AVAILABILITY_VALUES = Object.freeze(['available', 'unavailable', 'degraded']);
  /* descriptor 禁止携带的字段（凭据 / provider / 运行时对象 / 函数）。 */
  var FORBIDDEN_DESCRIPTOR_KEYS = Object.freeze([
    'apikey', 'api_key', 'key', 'token', 'secret', 'password', 'credential', 'authorization', 'bearer',
    'endpoint', 'provider', 'model', 'cfg', 'config', 'options',
    'fn', 'function', 'callback', 'handler', 'executor', 'closure', 'node', 'element', 'dom', 'runtime'
  ]);
  var ID_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;    /* domain.action（允许 domain.a.b） */
  var BINDING_PATTERN = /^[A-Za-z0-9_$]+(?:\.[A-Za-z0-9_$]+)*$/; /* 字符串引用，不是函数 */
  var MAX_ID_LEN = 80;
  var MAX_DESCRIPTION_LEN = 200;
  var CONTROL_PATTERN = /[\u0000-\u001F\u007F]/;

  function isObject(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
  function isPlainObject(v) {
    if (!isObject(v)) return false;
    var proto = Object.getPrototypeOf(v);
    return proto === Object.prototype || proto === null;
  }
  function str(v) { return v == null ? '' : String(v); }
  function hasSecret(v) {
    try { if (VOICE && typeof VOICE.findSecret === 'function') return !!VOICE.findSecret(v); } catch (e) { /* 探测失败不阻断 */ }
    return false;
  }
  function deepFreeze(v) {
    if (Array.isArray(v)) { v.forEach(deepFreeze); return Object.freeze(v); }
    if (!isObject(v)) return v;
    Object.keys(v).forEach(function (k) { deepFreeze(v[k]); });
    return Object.freeze(v);
  }
  /* 递归扫描：函数 / 凭据形态 / 禁止键名一律拒绝（§8/§23/R7/R8）。 */
  function scanForbidden(value, path, errors) {
    var here = path || '';
    if (typeof value === 'function') { errors.push('function-not-allowed:' + here); return; }
    if (Array.isArray(value)) { value.forEach(function (v, i) { scanForbidden(v, here + '[' + i + ']', errors); }); return; }
    if (isObject(value)) {
      Object.keys(value).forEach(function (k) {
        var lower = String(k).toLowerCase().replace(/[\s\-_]/g, '');
        var key = (here ? here + '.' : '') + k;
        if (FORBIDDEN_DESCRIPTOR_KEYS.indexOf(lower) >= 0) { errors.push('forbidden-field:' + key); return; }
        scanForbidden(value[k], key, errors);
      });
      return;
    }
    if (typeof value === 'string' && hasSecret(value)) errors.push('secret-value:' + here);
  }

  /* ── Capability Descriptor（纯数据；§8）────────────────────────────── */
  function buildCapabilityDescriptor(input) {
    if (!isPlainObject(input)) return { ok: false, errors: ['not-an-object'] };
    var errors = [];
    var id = str(input.id);
    if (!id) errors.push('missing-id');
    else if (id.length > MAX_ID_LEN || !ID_PATTERN.test(id)) errors.push('bad-id');
    var domain = str(input.domain);
    if (!domain) errors.push('missing-domain');
    if (CAPABILITY_KINDS.indexOf(str(input.kind)) < 0) errors.push('bad-kind');
    var description = str(input.description);
    if (!description) errors.push('missing-description');
    else if (description.length > MAX_DESCRIPTION_LEN || CONTROL_PATTERN.test(description)) errors.push('bad-description');
    if (SIDE_EFFECTS.indexOf(str(input.sideEffect)) < 0) errors.push('bad-side-effect');
    var authorityType = str(input.authorityType);
    if (AUTHORITY_TYPES.indexOf(authorityType) < 0) errors.push('bad-authority-type');
    /* 分支规则：read 恒 read-only；write/action 必须有真实 authority（不能是 read-only）。
       这条把"声明侧"就锁死，避免出现"写能力但没有 authority"的形状。 */
    if (str(input.kind) === 'read' && authorityType !== 'read-only') errors.push('read-capability-must-be-read-only');
    if ((str(input.kind) === 'write' || str(input.kind) === 'action') && authorityType === 'read-only') errors.push('side-effect-capability-needs-authority');
    if (str(input.kind) === 'read' && str(input.sideEffect) !== 'none') errors.push('read-capability-must-be-side-effect-free');
    var binding = str(input.binding);
    if (!binding) errors.push('missing-binding');
    else if (!BINDING_PATTERN.test(binding)) errors.push('bad-binding');
    if (input.availability !== undefined && AVAILABILITY_VALUES.indexOf(str(input.availability)) < 0) errors.push('bad-availability');
    if (input.notes !== undefined && !Array.isArray(input.notes)) errors.push('bad-notes');
    var extra = {};
    Object.keys(input).forEach(function (k) {
      if (['id', 'domain', 'kind', 'description', 'sideEffect', 'authorityType', 'binding', 'availability', 'notes'].indexOf(k) < 0) extra[k] = input[k];
    });
    if (Object.keys(extra).length) errors.push('unknown-field:' + Object.keys(extra).join(','));
    scanForbidden(input, '', errors);
    if (id && domain && id.indexOf(domain + '.') !== 0) errors.push('id-domain-mismatch');
    if (errors.length) return { ok: false, errors: errors };
    return {
      ok: true, errors: [],
      descriptor: deepFreeze({
        id: id,
        domain: domain,
        kind: str(input.kind),
        description: description,
        sideEffect: str(input.sideEffect),
        authorityType: authorityType,
        binding: binding,
        availability: input.availability === undefined ? 'available' : str(input.availability),
        notes: Array.isArray(input.notes) ? input.notes.slice(0, 8).map(function (n) { return str(n).slice(0, 120); }) : []
      })
    };
  }

  /* ── Registry（只注册 / 查询 / 枚举；不执行、不裁决）──────────────────── */
  function createCapabilityRegistry() {
    var byId = Object.create(null);
    var order = [];
    function register(input) {
      var built = buildCapabilityDescriptor(input);
      if (!built.ok) return { ok: false, errors: built.errors };
      var d = built.descriptor;
      if (byId[d.id]) return { ok: false, errors: ['duplicate-id'] };
      byId[d.id] = d;
      order.push(d.id);
      return { ok: true, capability: d };
    }
    function get(id) { return byId[str(id)] || null; }
    function has(id) { return !!byId[str(id)]; }
    function list(filter) {
      var out = order.slice().sort().map(function (id) { return byId[id]; });   /* 稳定枚举（按 id） */
      if (!isObject(filter)) return out;
      if (filter.domain !== undefined) out = out.filter(function (d) { return d.domain === str(filter.domain); });
      if (filter.kind !== undefined) out = out.filter(function (d) { return d.kind === str(filter.kind); });
      if (filter.authorityType !== undefined) out = out.filter(function (d) { return d.authorityType === str(filter.authorityType); });
      return out;
    }
    function snapshot() {
      return { version: 'agent-capability-registry/v1', count: order.length, capabilities: list() };
    }
    return {
      register: register,
      get: get,
      has: has,
      list: list,
      size: function () { return order.length; },
      snapshot: snapshot,
      validate: function (input) { return buildCapabilityDescriptor(input); },
      kinds: CAPABILITY_KINDS,
      authorityTypes: AUTHORITY_TYPES,
      sideEffects: SIDE_EFFECTS,
      availabilityValues: AVAILABILITY_VALUES
    };
  }

  return {
    CAPABILITY_KINDS: CAPABILITY_KINDS,
    AUTHORITY_TYPES: AUTHORITY_TYPES,
    SIDE_EFFECTS: SIDE_EFFECTS,
    AVAILABILITY_VALUES: AVAILABILITY_VALUES,
    FORBIDDEN_DESCRIPTOR_KEYS: FORBIDDEN_DESCRIPTOR_KEYS,
    buildCapabilityDescriptor: buildCapabilityDescriptor,
    createCapabilityRegistry: createCapabilityRegistry
  };
});
