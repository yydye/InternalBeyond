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

  /* seat 标签词表。**恰好**是当前能真实举证的四项 —— 不多不少。
     R2-D.1 时它只有 pinned/primary，理由是 selectWithinBudget 只返回
     {id, score, line}，从中**猜**谁被探索抽中会让 trace 撒谎。
     P21-R2-F1a 让唯一 selector 通过 selectionMeta.explorationIds **如实提供**
     该事实，猜测的前提因此消失 ⇒ exploration 成为可举证的席位。
     仍然**不得**提前加入 dormant / reminisce / glossary：
     它们没有对应的真实证据来源。 */
  var SEAT_PINNED = 'pinned';
  var SEAT_PRIMARY = 'primary';
  var SEAT_EXPLORATION = 'exploration';
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
    /* 探索 metadata **由 core 提供**（唯一 selector 才知道谁被抽中）。
       本模块绝不根据"最后一条"之类的启发式猜测。 */
    var exploreSet = {};
    if (opts.allowExploration !== false && Array.isArray(opts.explorationIds)) {
      for (var e = 0; e < opts.explorationIds.length; e++) {
        if (opts.explorationIds[e] != null) exploreSet[String(opts.explorationIds[e])] = 1;
      }
    }
    var isExplore = function (row) { return !!row && row.id != null && !!exploreSet[String(row.id)]; };
    /* 注意签名：withSeat 会把 **id** 传进来（它内部调用 labelOf(row.id)），
       所以这里必须按 id 判定，而不是按 row。 */
    var labelWithExplore = function (id) {
      if (id != null && exploreSet[String(id)]) return SEAT_EXPLORATION;
      return labelOf ? labelOf(id) : SEAT_PRIMARY;
    };

    if (cap <= 0) {
      return { seats: [], dropped: rows.slice(), capped: rows.length > 0, cap: cap };
    }

    /* 先按 core 的 canonical 顺序选出要保留的 id 集合，**再**按 canonical 顺序输出。
       配额顺序（§0.7 / §14）：
         1. pinned —— 按 core 顺序，pinned **不会**因为 exploration 被挤掉
         2. 为探索项保留最多 1 个 seat（仍有非-pinned 空间时）
         3. 其余按 core canonical 顺序填 primary
       全程不排序、不算分、不随机、不重选候选 —— 只在 core 已决定的集合上做取舍。 */
    var keep = {};
    var kept = 0;
    var i2;
    for (i2 = 0; i2 < rows.length && kept < cap; i2++) {
      if (labelOf && labelOf(rows[i2].id) === SEAT_PINNED && !keep[String(rows[i2].id)]) {
        keep[String(rows[i2].id)] = 1; kept++;
      }
    }
    if (kept < cap) {
      for (i2 = 0; i2 < rows.length && kept < cap; i2++) {
        if (isExplore(rows[i2]) && !keep[String(rows[i2].id)]) {
          keep[String(rows[i2].id)] = 1; kept++; break;   /* 最多 1 个探索 seat */
        }
      }
    }
    for (i2 = 0; i2 < rows.length && kept < cap; i2++) {
      if (rows[i2].id != null && !keep[String(rows[i2].id)]) { keep[String(rows[i2].id)] = 1; kept++; }
    }

    var seats = [], dropped = [];
    for (i2 = 0; i2 < rows.length; i2++) {
      var key = (rows[i2].id == null) ? null : String(rows[i2].id);
      if (key != null && keep[key]) seats.push(withSeat(rows[i2], labelWithExplore));
      else dropped.push(rows[i2]);
    }
    return {
      seats: seats, dropped: dropped,
      capped: dropped.length > 0, cap: cap,
      /* 观察用：core 抽中但最终**没**进入注入的探索 id（trace 必须如实反映）。 */
      droppedExplorationIds: dropped.filter(isExplore).map(function (r) { return r.id; })
    };
  }

  /* seatLabel(record) → 'pinned' | 'primary'
     pinned 是**记录自身的属性**（canonical record 字段），因此可以可靠判定。
     其余一律 'primary' —— 探索标签**不在这里**判定：它需要 core 的
     selectionMeta，只能由 applySeats 注入（不猜）。 */
  function seatLabel(record) {
    return (record && record.pinned === true) ? SEAT_PINNED : SEAT_PRIMARY;
  }

  return {
    applySeats: applySeats,
    seatLabel: seatLabel,
    SEAT_PINNED: SEAT_PINNED,
    SEAT_PRIMARY: SEAT_PRIMARY,
    SEAT_EXPLORATION: SEAT_EXPLORATION,
    SEAT_UNKNOWN: SEAT_UNKNOWN
  };
}));
