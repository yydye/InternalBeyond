/* ====================================================================
   IB Context Snapshot — Context Convergence C2 · step 1（只读 canonical Context 快照）
   --------------------------------------------------------------------
   - Browser: <script src="assets/js/context-snapshot.js"> → window.IBContextSnapshot
   - Node   : require('./assets/js/context-snapshot.js')
   - 规则：零 window / 零 DOM / 零 fetch / 纯函数；本模块**不读取任何 producer**，
     只承载"本轮已读取的结果"，因此可以在 Node 里直接做契约测试。
   - 字段状态契约（C1 已钉住，C2 把它提升为 canonical）：
       present —— producer 已读且非空；value 为原文
       empty   —— producer 已读但无内容（''）；**不得**再触发二次读取
       missing —— 本轮未读取 / 被门控；等价于 undefined（允许消费方自行 retrieval）
     每个字段条目另带 producer / gatedBy / visibility 标记；快照与字段全部 Object.freeze。
   - 只做"表示"，不做"注入"：不决定顺序、不改任何 producer 算法（C2 step 1 的边界）。
   ==================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); }
  else { root.IBContextSnapshot = factory(); }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var VERSION = 1;
  /* canonical 字段顺序：与 _buildSingleChatContext 的 tail 拼接顺序一致 */
  var FIELDS = ['memory', 'understanding', 'thread', 'moments'];
  var STATE = { PRESENT: 'present', EMPTY: 'empty', MISSING: 'missing' };

  function _str(v) { return v == null ? '' : String(v); }

  /* 单字段条目：producer 名 + 状态 + 值 + 门控/可见性标记（只读） */
  function field(producer, value, opts) {
    opts = opts || {};
    var visibility = (opts.visibility === 'unfiltered') ? 'unfiltered' : 'filtered';
    if (opts.missing === true) {
      return Object.freeze({
        producer: _str(producer), state: STATE.MISSING, value: null,
        gatedBy: opts.gatedBy == null ? null : _str(opts.gatedBy), visibility: visibility
      });
    }
    var text = _str(value);
    return Object.freeze({
      producer: _str(producer), state: text ? STATE.PRESENT : STATE.EMPTY, value: text,
      gatedBy: null, visibility: visibility
    });
  }

  function create(input) {
    input = input || {};
    var src = input.fields || {}, fields = {};
    for (var i = 0; i < FIELDS.length; i++) {
      var name = FIELDS[i], f = src[name];
      /* 容忍调用方直接给字符串（等价于"已读"），但推荐用 field() 显式标注 producer/gatedBy */
      fields[name] = (f && typeof f === 'object') ? f : field('', f, {});
    }
    return Object.freeze({
      version: VERSION,
      characterId: _str(input.characterId),
      turnId: _str(input.turnId),
      at: (input.at != null && isFinite(Number(input.at))) ? Number(input.at) : Date.now(),
      fields: Object.freeze(fields),
      gates: Object.freeze(Object.assign({}, input.gates || {}))
    });
  }

  function _entry(snapshot, name) {
    return (snapshot && snapshot.fields && snapshot.fields[name]) || null;
  }
  function state(snapshot, name) {
    var e = _entry(snapshot, name);
    return e ? e.state : '';
  }
  function provided(snapshot, name) {
    var s = state(snapshot, name);
    return s === STATE.PRESENT || s === STATE.EMPTY;
  }
  /* present → 原文；empty → ''（已读为空）；missing → undefined（未提供，允许自行 retrieval） */
  function value(snapshot, name) {
    var e = _entry(snapshot, name);
    if (!e) return undefined;
    if (e.state === STATE.PRESENT) return e.value;
    if (e.state === STATE.EMPTY) return '';
    return undefined;
  }
  /* 兼容视图：与 C1 的 opts.*Ctx 语义逐位一致（Middle Brain organize 可直接消费） */
  function toOrganizeInput(snapshot) {
    return {
      memoryCtx: value(snapshot, 'memory'),
      understandingCtx: value(snapshot, 'understanding'),
      threadCtx: value(snapshot, 'thread'),
      momentsCtx: value(snapshot, 'moments')
    };
  }
  /* 快照中"应当注入"的块：按 canonical 顺序，只含 present */
  function blocks(snapshot) {
    var out = [];
    for (var i = 0; i < FIELDS.length; i++) {
      var e = _entry(snapshot, FIELDS[i]);
      if (e && e.state === STATE.PRESENT) out.push({ name: FIELDS[i], text: e.value, producer: e.producer });
    }
    return out;
  }
  /* 诊断摘要：只含状态与门控标记，绝不含正文（可安全写日志/telemetry） */
  function summary(snapshot) {
    var states = {}, gated = {};
    for (var i = 0; i < FIELDS.length; i++) {
      var e = _entry(snapshot, FIELDS[i]);
      states[FIELDS[i]] = e ? e.state : '';
      if (e && e.gatedBy) gated[FIELDS[i]] = e.gatedBy;
    }
    return {
      version: VERSION,
      characterId: _str(snapshot && snapshot.characterId),
      turnId: _str(snapshot && snapshot.turnId),
      at: Number((snapshot && snapshot.at) || 0),
      states: states, gatedBy: gated
    };
  }

  return {
    VERSION: VERSION, FIELDS: FIELDS, STATE: STATE,
    field: field, create: create,
    state: state, value: value, provided: provided,
    toOrganizeInput: toOrganizeInput, blocks: blocks, summary: summary
  };
});
