/* ====================================================================
   IB Delivery Runtime — 「一个 sequence 何时真正进入 conversation stream」的**唯一** authority
   (P23 Phase 2B · UMD dual-load)
   --------------------------------------------------------------------
   - Browser: <script src="assets/js/delivery-runtime.js"> → window.IBDeliveryRuntime
   - Node   : require('../assets/js/delivery-runtime.js')（测试用）
   - 规则：零 DOM / 零 fetch / 零 IndexedDB / 零 provider 判定 / 零 TTS。
     时间只能通过**注入的时钟与调度器**流动（deps.now / deps.setTimeout / deps.clearTimeout），
     因此 Node 测试可以用 fake clock 精确驱动，绝不需要真实 sleep。

   ── 它负责什么 ────────────────────────────────────────────────────
   一次模型回合可能交付 N 条消息（Phase 2A：一条 unit = 一条独立 canonical chatMessage）。
   本模块只回答一件事：**这些 unit 按什么顺序、在什么时刻、以什么状态进入会话流**。
     · 队列状态机：queued → delivering → completed / cancelled / failed
     · 每个 unit 的进入时刻（delayBefore / typingDuration，皆确定性）
     · typing 的开与关（通过注入的 onTyping —— 本模块不认识 DOM）
     · cancel（含 user interrupt / stop）：**保留已交付**，只丢弃未交付
     · 按 conversation 隔离：一个 session 里可以有多条队列并存
   ── 它**不**负责什么 ──────────────────────────────────────────────
     · 拆句 / 决定 kind / 决定内容 / 决定"为什么是四条" —— 那是 Phase 2C Planner
     · 落库与渲染 —— 由注入的 onUnit 回调（communication.js 的 adapter）负责
     · 语音合成与播放 —— Phase 1 的 voice 契约负责
     · 群聊编排 —— 本模块不做任何 group 判定，但 identity 按 conversationId 设计，
       并带 scope（single/group）字段，因此未来 Group Runtime 可以直接复用（不写死 friendId）。

   ── 与 Phase 2A 的关系 ─────────────────────────────────────────────
   delivery-sequence-core 决定"数据长什么样"（结构）；
   本模块决定"什么时候把它放进去"（时间与生命周期）；
   communication.js 的 adapter 决定"怎么放"（dbPut + appendChatBubble）。
   三者单向依赖：core ← runtime ← adapter。本模块**不**反向调用 core。

   ── 持久化时机（Phase 2B §5 的关键决定）────────────────────────────
   **unit 到 delivery time 才落库**（不预先写 DB、不预留"影子消息"）。
   理由（源码事实，不是偏好）：
     · chatMessages 有 91 个读取点（context / Memory / Search / Middle Brain / Diary /
       Role Letters / Home Node dialogue / Mobile DTO），它们**直接**读 canonical store，
       没有一处认识"投递队列"。要让"未交付 unit 不进任何 consumer"，最可靠的做法是
       它根本不在 store 里 —— 于是这条不变量是**结构性**的，而不是需要每个读取点配合过滤。
     · reload / crash 语义因此天然正确：已交付unit 在 DB 里，未交付的随页面一起消失
       （队列是 ephemeral 的内存状态，不做恢复）。
   队列本身只活在内存里，且**不复制任何敏感数据**（只持有 adapter 给的 unit 与 trace）。

   ── 安全边界 ──────────────────────────────────────────────────────
   trace 里只有身份与状态：turnId / conversationId / scope / sequenceIndex / state /
   reason / at。**绝不**记录 unit 正文、provider 请求、API key、voice 凭据（测试断言）。
   ==================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./delivery-sequence-core.js'));
  } else {
    root.IBDeliveryRuntime = factory(root.IBDeliverySequence);
  }
})(typeof self !== 'undefined' ? self : this, function (SEQ) {
  'use strict';

  /* ── 状态词表（唯一真源；调用方与测试都从这里断言，禁止字符串匹配别的写法）── */
  var STATES = ['queued', 'delivering', 'completed', 'cancelled', 'failed'];
  var TERMINAL = { completed: true, cancelled: true, failed: true };

  /* ── 时间安全边界（Phase 2B §6：禁止无限等待）────────────────────── */
  var DELAY_MIN = 0;
  var DELAY_MAX = 8000;     /* 单个 unit 进入前的等待上限：8s */
  var TYPING_MIN = 0;
  var TYPING_MAX = 6000;    /* typing 显示时长上限：6s（且恒 ≤ delayBefore） */
  /* 确定性默认节奏（§7）：base + 字符数 × factor，两端夹紧。**没有** Math.random()。 */
  var DEFAULT_BASE_MS = 240;
  var DEFAULT_PER_CHAR_MS = 14;
  var TYPING_BASE_MS = 180;
  var TYPING_PER_CHAR_MS = 18;

  /* trace / 队列上限：内存有界，绝不随会话无限增长。 */
  var TRACE_MAX = 240;
  var QUEUE_MAX = 32;

  function isObject(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
  function str(v) { return v == null ? '' : String(v); }
  function clamp(v, min, max) { var n = Number(v); if (!isFinite(n)) n = min; return n < min ? min : (n > max ? max : n); }
  function textLen(v) { return str(v).length; }

  /* ── 确定性节奏：默认值（producer 显式给出的值优先，见 timingFor）────── */
  function defaultDelay(prevText, opts) {
    var o = opts || {};
    var base = isFinite(Number(o.baseMs)) ? Number(o.baseMs) : DEFAULT_BASE_MS;
    var per = isFinite(Number(o.perCharMs)) ? Number(o.perCharMs) : DEFAULT_PER_CHAR_MS;
    return clamp(base + textLen(prevText) * per, DELAY_MIN, DELAY_MAX);
  }
  function defaultTyping(text, opts) {
    var o = opts || {};
    var base = isFinite(Number(o.baseMs)) ? Number(o.baseMs) : TYPING_BASE_MS;
    var per = isFinite(Number(o.perCharMs)) ? Number(o.perCharMs) : TYPING_PER_CHAR_MS;
    return clamp(base + textLen(text) * per, TYPING_MIN, TYPING_MAX);
  }

  /* ── 一个 unit 的时间预算（唯一的 timing 契约）──────────────────────
     unit.delivery = { delayBefore?, typingDuration? }：
       delayBefore    —— 上一条交付完成之后、这一条的 typing 出现之前的**静默间隔**；
       typingDuration —— typing 显示时长；它之后这一条才出现。
     时序：  [静默 delayBefore] → [typing typingDuration] → unit 进入会话流
     两者各自独立夹紧（delayBefore ≤ 8s，typingDuration ≤ 6s），总时长因此有上界。

     默认值（producer 没给时）：由**文本长度**确定性派生（base + 字符数 × factor），
     绝无 Math.random()，也绝不读时钟。显式值一律优先 —— 这保证既有 producer
     （MessagePresentation.plan 的 delay）的节奏不被本模块改写。

     isFirst：**序列的首条**在没有任何显式值时完全不等待（legacy 单条 / fast path
     必须与改动前逐字同感：不多一次 typing、不多一次延迟）。 */
  function timingFor(unit, prevText, opts, isFirst) {
    var u = isObject(unit) ? unit : {};
    var d = isObject(u.delivery) ? u.delivery : {};
    var hasDelay = (d.delayBefore != null);
    var hasTyping = (d.typingDuration != null);
    if (isFirst && !hasDelay && !hasTyping) return { delayBefore: 0, typingDuration: 0, explicit: false };
    var delay = hasDelay ? clamp(d.delayBefore, DELAY_MIN, DELAY_MAX) : clamp(defaultDelay(prevText, opts), DELAY_MIN, DELAY_MAX);
    var typing = hasTyping ? clamp(d.typingDuration, TYPING_MIN, TYPING_MAX)
      : clamp(defaultTyping(u.content != null ? u.content : u.text, opts), TYPING_MIN, TYPING_MAX);
    return { delayBefore: delay, typingDuration: typing, explicit: (hasDelay || hasTyping) };
  }

  /* ── conversation identity ───────────────────────────────────────
     队列按 canonical conversationId 绑定（**不是**裸 friendId）——这正是 §23 要求的
     "identity 不要写死为 friendId"：conversationId 的派生规则唯一属于 chat-core
     （dm:<friendId>[|<threadId>] / group:<groupId>…），由调用方（adapter）算好传进来；
     未来 Group Runtime 只要把 group:<id> 送进来就能复用本模块的全部生命周期语义。
     scope（single/group）是**不透明标注**：本模块不做任何基于它的分支判断，
     只把它带进 trace 与状态回调，因此"支持群聊 scope"这件事在类型上已经成立，
     而群聊行为仍然一行都没实现（Phase 2B §23）。 */
  function conversationIdentityOf(spec) {
    var s = isObject(spec) ? spec : {};
    return { conversationId: str(s.conversationId), scope: str(s.scope) || 'single' };
  }

  function createDeliveryRuntime(deps) {
    deps = deps || {};
    var now = (typeof deps.now === 'function') ? deps.now : function () { return Date.now(); };
    var setT = (typeof deps.setTimeout === 'function') ? deps.setTimeout : function (fn, ms) { return setTimeout(fn, ms); };
    var clearT = (typeof deps.clearTimeout === 'function') ? deps.clearTimeout : function (h) { if (h != null) clearTimeout(h); };
    var onEvent = (typeof deps.onEvent === 'function') ? deps.onEvent : function () { };
    var pacing = isObject(deps.pacing) ? deps.pacing : null;

    var queues = Object.create(null);      /* conversationId → queue */
    var traceRing = [];
    var disposed = false;
    var seqNo = 0;

    /* trace 的**写入**端。注意：不要把它也叫 trace —— 下面 "只读观测" 里的
       trace(limit) 是读取端，同名会在函数作用域里互相覆盖（本文件开发期实测踩到过：
       读取端把写入端遮掉，ring 永远是空的）。 */
    function pushTrace(ev) {
      /* 只放身份与状态 —— 绝不放 unit 正文 / provider 请求 / 凭据。 */
      ev.seq = ++seqNo;
      traceRing.push(ev);
      if (traceRing.length > TRACE_MAX) traceRing.shift();
      try { onEvent(ev); } catch (e) { }
    }
    function note(q, state, extra) {
      var ev = {
        at: now(), turnId: q.turnId, conversationId: q.conversationId, scope: q.scope,
        sequenceIndex: (extra && extra.sequenceIndex != null) ? extra.sequenceIndex : null,
        state: state, reason: (extra && extra.reason) || ''
      };
      pushTrace(ev);
    }

    function clearTimer(q) {
      if (q.timer != null) { try { clearT(q.timer); } catch (e) { } q.timer = null; }
    }
    function notifyTyping(q, on) {
      if (!q.onTyping) return;
      try { q.onTyping(!!on, { turnId: q.turnId, conversationId: q.conversationId, sequenceIndex: q.cursor }); } catch (e) { }
    }
    function finish(q, state, reason) {
      clearTimer(q);
      if (q.typingOn) { q.typingOn = false; notifyTyping(q, false); }
      q.state = state;
      if (queues[q.conversationId] === q) delete queues[q.conversationId];
      note(q, state, { reason: reason || '' });
      try { if (q.onState) q.onState(state, { turnId: q.turnId, conversationId: q.conversationId, delivered: q.delivered.length, total: q.units.length, reason: reason || '' }); } catch (e) { }
      if (q.resolve) { try { q.resolve({ state: state, delivered: q.delivered.length, total: q.units.length, reason: reason || '' }); } catch (e) { } }
    }

    /* 交付一个 unit：调用 adapter（可能异步）→ 成功才推进 cursor。
       顺序**严格串行**：绝不出现两个 unit 同时在飞（避免顺序错乱与重复落库）。 */
    function deliverUnit(q, unit) {
      if (q.state !== 'delivering') return;
      var index = q.cursor;
      /* typing OFF ⇒ message appears（§8）：交付前必须收起 typing。 */
      if (q.typingOn) { q.typingOn = false; notifyTyping(q, false); }
      var out;
      try { out = q.onUnit ? q.onUnit(unit, index, q) : true; }
      catch (e) { finish(q, 'failed', 'unit-threw'); return; }
      var advance = function (res) {
        if (res === false || (isObject(res) && res.ok === false)) { finish(q, 'failed', (isObject(res) && res.reason) || 'unit-failed'); return; }
        q.delivered.push(index);
        note(q, 'delivered', { sequenceIndex: index });
        q.cursor++;
        if (q.state !== 'delivering') return;              /* 交付期间被 cancel ⇒ 停在已交付处 */
        step(q);
      };
      if (out && typeof out.then === 'function') out.then(advance, function () { finish(q, 'failed', 'unit-rejected'); });
      else advance(out);
    }

    function step(q) {
      if (disposed || q.state !== 'delivering') return;
      if (q.cursor >= q.units.length) { finish(q, 'completed', ''); return; }
      var unit = q.units[q.cursor];
      var prevText = q.cursor > 0 ? (q.units[q.cursor - 1].content != null ? q.units[q.cursor - 1].content : q.units[q.cursor - 1].text) : '';
      var t = timingFor(unit, prevText, q.pacing, q.cursor === 0);
      var delay = t.delayBefore, typing = t.typingDuration;
      /* 阶段 ①：静默间隔（首条默认 0 ⇒ 直接进 ②/③，legacy 单条路径因此一步不多）。 */
      if (delay > 0) {
        q.timer = setT(function () { q.timer = null; if (q.state !== 'delivering') return; typingStage(q, unit, t); }, delay);
        return;
      }
      typingStage(q, unit, t);
    }
    /* 阶段 ②：typing 显示 typingDuration 秒（0 ⇒ 直接交付）。
       阶段 ③：typing OFF ⇒ 这一条进入会话流。 */
    function typingStage(q, unit, t) {
      if (q.state !== 'delivering') return;
      if (t.typingDuration <= 0) { deliverUnit(q, unit); return; }
      if (!q.typingOn) { q.typingOn = true; notifyTyping(q, true); }
      q.timer = setT(function () {
        q.timer = null;
        if (q.state !== 'delivering') return;
        deliverUnit(q, unit);
      }, t.typingDuration);
    }

    /* ── enqueue：把一条 sequence 交给 runtime ─────────────────────────
       spec = { turnId, conversationId, scope?, units:[…], onUnit, onTyping?, onState? }
       返回 { turnId, conversationId, state, cursor, promise, cancel }（null = 不可交付）。
       同一 conversation 已有未终结队列 ⇒ 先把旧的置为 cancelled('superseded')：
       新的生成意味着上一轮"被新的发言顶上"，与 user interrupt 同一语义。 */
    function enqueue(spec) {
      if (disposed) return null;
      if (!isObject(spec)) return null;
      var ident = conversationIdentityOf(spec);
      if (!ident.conversationId) return null;
      if (!Array.isArray(spec.units) || !spec.units.length) return null;
      if (typeof spec.onUnit !== 'function') return null;
      if (Object.keys(queues).length >= QUEUE_MAX) return null;      /* 有界：绝不放任增长 */
      var existing = queues[ident.conversationId];
      if (existing && !TERMINAL[existing.state]) abortQueue(existing, 'superseded');
      var resolveFn = null;
      var promise = new Promise(function (r) { resolveFn = r; });
      var q = {
        turnId: str(spec.turnId), conversationId: ident.conversationId, scope: ident.scope,
        units: spec.units.slice(), cursor: 0, delivered: [], state: 'queued',
        onUnit: spec.onUnit, onTyping: (typeof spec.onTyping === 'function') ? spec.onTyping : null,
        onState: (typeof spec.onState === 'function') ? spec.onState : null,
        typingOn: false, timer: null, resolve: resolveFn, promise: promise,
        startedAt: now(), pacing: isObject(spec.pacing) ? spec.pacing : pacing
      };
      queues[ident.conversationId] = q;
      note(q, 'queued', { sequenceIndex: null });
      q.state = 'delivering';
      step(q);
      return q;
    }

    /* 取消一条队列：**保留已交付**（partial delivery preservation，§10）。 */
    function abortQueue(q, reason) {
      if (!q || TERMINAL[q.state]) return false;
      finish(q, 'cancelled', reason || 'cancelled');
      return true;
    }
    function abort(conversationId, reason) {
      var q = queues[str(conversationId)];
      return abortQueue(q, reason || 'cancelled');
    }
    function abortAll(reason) {
      var n = 0;
      Object.keys(queues).forEach(function (k) { if (abortQueue(queues[k], reason || 'cancelled')) n++; });
      return n;
    }

    /* ── 只读观测 ─────────────────────────────────────────────────── */
    function stateOf(conversationId) {
      var q = queues[str(conversationId)];
      return q ? q.state : 'idle';
    }
    function pending(conversationId) {
      var q = queues[str(conversationId)];
      if (!q) return null;
      return {
        turnId: q.turnId, conversationId: q.conversationId, scope: q.scope, state: q.state,
        cursor: q.cursor, total: q.units.length, delivered: q.delivered.slice(),
        typing: !!q.typingOn      /* 是否正处于 typing 阶段（供重渲染后重新画 typing） */
      };
    }
    function pendingAll() {
      return Object.keys(queues).map(function (k) { return pending(k); });
    }
    function trace(limit) {
      var n = Number(limit);
      if (!isFinite(n) || n <= 0) n = TRACE_MAX;
      return traceRing.slice(Math.max(0, traceRing.length - n));
    }
    function activeCount() { return Object.keys(queues).length; }
    function hasPendingTimer() {
      var ks = Object.keys(queues);
      for (var i = 0; i < ks.length; i++) if (queues[ks[i]].timer != null) return true;
      return false;
    }
    /* dispose：清掉所有定时器（页面卸载/测试收尾）。返回被取消的队列数。 */
    function dispose(reason) {
      var n = abortAll(reason || 'disposed');
      disposed = true;
      return n;
    }
    function reset() { abortAll('reset'); traceRing.length = 0; seqNo = 0; }

    return {
      STATES: STATES,
      enqueue: enqueue,
      abort: abort,
      abortAll: abortAll,
      stateOf: stateOf,
      pending: pending,
      pendingAll: pendingAll,
      trace: trace,
      activeCount: activeCount,
      hasPendingTimer: hasPendingTimer,
      dispose: dispose,
      reset: reset
    };
  }

  return Object.freeze({
    STATES: STATES,
    DELAY_MIN: DELAY_MIN,
    DELAY_MAX: DELAY_MAX,
    TYPING_MIN: TYPING_MIN,
    TYPING_MAX: TYPING_MAX,
    DEFAULT_BASE_MS: DEFAULT_BASE_MS,
    DEFAULT_PER_CHAR_MS: DEFAULT_PER_CHAR_MS,
    TYPING_BASE_MS: TYPING_BASE_MS,
    TYPING_PER_CHAR_MS: TYPING_PER_CHAR_MS,
    TRACE_MAX: TRACE_MAX,
    QUEUE_MAX: QUEUE_MAX,
    defaultDelay: defaultDelay,
    defaultTyping: defaultTyping,
    timingFor: timingFor,
    createDeliveryRuntime: createDeliveryRuntime
  });
});
