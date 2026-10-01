/* ====================================================================
   IB Memory Recall · Seat Planner — runtime-neutral 纯函数（UMD dual-load）
   --------------------------------------------------------------------
   - Browser: <script src="assets/js/memory-recall/seat-planner.js">
              → window.IBMemoryRecallSeatPlanner
   - Node   : require('../assets/js/memory-recall/seat-planner.js')
   - 规则：零 window / 零 DOM / 零 IndexedDB / 零 localStorage / 零 fetch /
           零副作用 / 零定时器 / 零随机 / 零时钟 / 零 LLM / 纯函数。

   ── 本模块的**唯一**职责 ────────────────────────────────────────────
     "对 canonical selector **已经决定**的顺序与集合施加 channel seat policy。"

         core.rankMemoryCandidates(...)   ← 唯一 ranking（base × relBoost × fatigue）
              ↓
         core.selectWithinBudget(...)    ← 唯一 selection（pinned / 主选区 / 探索窗口）
              ↓  selected: [{id, score, line}]，**已是 canonical 顺序**
         seat-planner.applySeats(...)    ← 本模块：只按该顺序截断
              ↓
         调用方用 core 产出的 `line` 重组文本

   ── ⚠ 本模块**绝不**做这些（P21-R2-D.1 冻结）────────────────────────
     ✗ 自己排序 —— 尤其**禁止**按 memoryValue 决定"谁能进入 selector"
     ✗ 复制 base × relBoost × fatigue（哪怕"看起来只有三行"）
     ✗ 复制 fatigue / relBoost 的任何片段
     ✗ 自己算 relevance / memoryValue / _score
     ✗ 用 id 做第二排序器（id 只用于**稳定标识**，不参与定序）
     ✗ 渲染 / 组装文本（渲染唯一来源是 core.renderMemoryLine）
     ✗ 重新解释 budget（预算已由 core.selectWithinBudget 判定完毕）
     ✗ 自己做 ACL

   ── 为什么旧实现是错的（保留这段，避免有人改回去）──────────────────
     旧实现接收 [{record, memoryValue}]，按 memoryValue 降序截断后再交给 core。
     但 canonical ranking 是 base × relBoost × fatigue，而 memoryValue 只是 **base**。
     因此在候选数 > cap 时，它会删掉一条 canonical 本会排得**更高**的记录 ——
     那时它已不只是 seat cap，而是在 core 之前偷偷形成了**第二个 selector**。
     对抗性反例（tests/test_memory_recall_seats.js §8）：
        canonical 序 [D, A, B, C]，memoryValue 序 [A, B, C, D]，cap = 3
        旧实现给 [A, B, C]（丢掉 canonical 排第 1 的 D）
        正确结果 [D, A, B]
     两组都是 3 条 —— 因此"数量对"不等于"顺序对"。

   ── exploration 为什么必须留在这里之后 ──────────────────────────────
     core.selectWithinBudget 的探索窗口从"尚未入选的**排名尾部**"抽取。
     若在它**之前**截断候选集，探索池就被压进 top-N —— 那是 R2-D 非预期的
     semantic delta（R2-F 才负责 exploration seats）。
     因此本模块只在 core 完成选择**之后**施加 seat 数上限：
     探索算法的候选空间不变；上限只影响最终注入条数。
   ==================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); }
  else { root.IBMemoryRecallSeatPlanner = factory(); }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* seat 标签词表（最小集）。
     刻意**不**包含 exploration：core.selectWithinBudget 的 selected 条目
     只带 {id, score, line}，无法从中**可靠**判断一条是否由探索窗口抽中
     （索引位置会被 pinned 与预算截断打乱）。而"猜一个标签"会让 trace 撒谎。
     细分留给 R2-F 重构 exploration 时。 */
  var SEAT_PINNED = 'pinned';
  var SEAT_PRIMARY = 'primary';
  /* 非 seat planner 管辖的既有选择路径（未选中条目的 seat 不可观察）。 */
  var SEAT_UNKNOWN = 'legacy';

  function isPlainObject(v) {
    return !!v && typeof v === 'object' && !Array.isArray(v);
  }

  function capOf(policy) {
    if (!isPlainObject(policy)) return 0;
    /* 字段名是 maxTotalSeats：它限制的是"这一轮最多注入几条"，
       不是"主选区几条"（exploration 另有独立 seat 的概念属 R2-F）。
       过渡期仍接受 maxPrimarySeats，但语义一律按 total 解释。 */
    var raw = policy.maxTotalSeats != null ? policy.maxTotalSeats : policy.maxPrimarySeats;
    var n = Number(raw);
    return (isFinite(n) && n >= 0) ? Math.floor(n) : 0;
  }

  /* 生成带 seat 标签的**浅拷贝**（不改写调用方的对象）。
     顺序、id、score、line 全部原样保留 —— 本模块对它们没有任何解释权。 */
  function withSeat(row, labelOf) {
    var out = {};
    for (var k in row) { if (Object.prototype.hasOwnProperty.call(row, k)) out[k] = row[k]; }
    out.seat = labelOf ? labelOf(row.id) : SEAT_PRIMARY;
    return out;
  }

  /* applySeats(selected, policy, options) → { seats, dropped, capped, cap }
     selected：core 的 selected 数组（**canonical 顺序**），逐条形如
               { id, score, line }。本函数**不排序**、**不重算**、**不改写**。
     options.labelOf(id) → 'pinned' | 'primary'（可选；缺省一律 'primary'）。
       标签是**注入**的，因为它需要 record 的 pinned 字段，而 selected 条目
       只带 {id, score, line} —— 本模块不反向依赖 record 结构。 */
  function applySeats(selected, policy, options) {
    var opts = isPlainObject(options) ? options : {};
    var labelOf = (typeof opts.labelOf === 'function') ? opts.labelOf : null;
    var rows = Array.isArray(selected) ? selected.filter(isPlainObject) : [];
    var cap = capOf(policy);

    if (cap <= 0) {
      return { seats: [], dropped: rows.slice(), capped: rows.length > 0, cap: cap };
    }
    if (rows.length <= cap) {
      /* 恒等变换：不排序、不重排、不重复计算 —— 装得下时对既有语义完全透明。
         仍然逐条加 seat 标签（浅拷贝，不改写调用方对象）。 */
      return {
        seats: rows.map(function (r) { return withSeat(r, labelOf); }),
        dropped: [], capped: false, cap: cap
      };
    }
    return {
      seats: rows.slice(0, cap).map(function (r) { return withSeat(r, labelOf); }),
      dropped: rows.slice(cap),
      capped: true, cap: cap
    };
  }

  /* seatLabel(record) → 'pinned' | 'primary'
     pinned 是**记录自身的属性**（canonical record 字段），因此可以可靠判定。
     其余一律 'primary' —— 不猜 exploration。 */
  function seatLabel(record) {
    return (record && record.pinned === true) ? SEAT_PINNED : SEAT_PRIMARY;
  }

  return {
    applySeats: applySeats,
    seatLabel: seatLabel,
    SEAT_PINNED: SEAT_PINNED,
    SEAT_PRIMARY: SEAT_PRIMARY,
    SEAT_UNKNOWN: SEAT_UNKNOWN
  };
}));
