/* ====================================================================
   IB Memory Recall · Orchestrator — runtime-neutral 纯函数（UMD dual-load）
   --------------------------------------------------------------------
   - Browser: <script src="assets/js/memory-recall/memory-recall-orchestrator.js">
              → window.IBMemoryRecallOrchestrator
   - Node   : require('../assets/js/memory-recall/memory-recall-orchestrator.js')
   - 规则：零 window / 零 DOM / 零 IndexedDB / 零 localStorage / 零 fetch /
           零副作用 / 零定时器 / 零随机（random 由调用方注入）/ 零时钟
           （now 由调用方注入）/ 零持久化 / 纯函数。

   ── 本模块是 recall 的**唯一架构入口**，本轮只有两种模式 ──────────────

     legacy mode（options.turn 缺失 —— **production 当前唯一路径**）
         直接委托 memory-retrieval-core.buildMemoryContext(records, options)，
         然后包一层 { result, trace, meta }。
         **不**重新执行 visibility / scoring / sort / budget / render，
         **不** JSON clone，**不**二次构造 result。
         因此 result 与 core 的返回**逐字节一致** —— 这是 R2-C 的硬门。

     turn mode（options.turn 存在 —— 本轮只有测试直接调用）
         turn-signal → early exit?
                    → recall-query（确定性 query）
                    → visibility pre-filter（唯一 ACL）
                    → scoring.scoreRelevance
                    → Hard Gate（relevanceScore > 0）
                    → **复用** core.buildMemoryContext(gated, legacy options)
                    → trace

   ── 为什么 gate 之后仍然复用 core ──────────────────────────────────
     R2-C 的目标是"插入架构层 + Hard Gate + Trace"，**不是**同时重写
     selection。因此 gate 后的排序 / pinned / fatigue / 85-15 预算 /
     renderMemoryLine 全部仍由既有 core 完成。这也意味着 R2-C **不**修
     探索窗口偏置 / break-vs-continue / pinned 超预算 / fatigue /
     activation 语义 —— 那些各有自己的阶段。

   ── 失败语义（与既有分层一致）────────────────────────────────────────
     · 召回内部失败      → fail open：空结果，回合继续
     · 可见性不可判定    → fail closed：不注入任何记忆（'visibility-unavailable'）
     · 本模块不写任何持久化状态（activation 仍由调用方在**选择之后**单独执行）

   ── 依赖方向（禁止反向）─────────────────────────────────────────────
     Host → orchestrator → { turn-signal, recall-query, scoring, recall-trace,
                             memory-retrieval-core, memory-visibility-core }
     memory-retrieval-core ✗→ orchestrator
     memory-visibility-core ✗→ orchestrator
   ==================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    var deps = {};
    try { deps.core = require('../memory-retrieval-core.js'); } catch (e) { deps.core = null; }
    try { deps.visibility = require('../memory-visibility-core.js'); } catch (e) { deps.visibility = null; }
    try { deps.turnSignal = require('./turn-signal.js'); } catch (e) { deps.turnSignal = null; }
    try { deps.query = require('./recall-query.js'); } catch (e) { deps.query = null; }
    try { deps.trace = require('./recall-trace.js'); } catch (e) { deps.trace = null; }
    try { deps.scoring = require('./scoring.js'); } catch (e) { deps.scoring = null; }
    module.exports = factory(deps);
  } else {
    root.IBMemoryRecallOrchestrator = factory({
      core: root.IBMemoryRetrievalCore || null,
      visibility: root.IBMemoryVisibilityCore || null,
      turnSignal: root.IBMemoryRecallTurnSignal || null,
      query: root.IBMemoryRecallQuery || null,
      trace: root.IBMemoryRecallTrace || null,
      scoring: root.IBMemoryRecallScoring || null
    });
  }
})(typeof self !== 'undefined' ? self : this, function (DEFAULT_DEPS) {
  'use strict';

  var CHANNEL_LEGACY = 'legacy';
  var REASON_EARLY_EXIT = 'early-exit';
  var REASON_GATE_REJECTED = 'gate-rejected';
  var REASON_NO_VISIBLE = 'no-visible-memory';
  var REASON_NO_BUDGET = 'no-budget';
  var REASON_VISIBILITY_UNAVAILABLE = 'visibility-unavailable';

  /* seat 值：R2-C **没有** seat planner，因此不伪造未来模块。
     只区分"经既有 core 被选中"与"进入 gate 但未被选中"。
     trace 的 seat 字段因此是一个稳定的、诚实的历史术语值。 */
  var SEAT_LEGACY = 'legacy';

  var REJECT_NOT_SELECTED = 'not-selected-by-core';
  var REJECT_BUDGET = 'budget';

  function isPlainObject(v) {
    return !!v && typeof v === 'object' && !Array.isArray(v);
  }

  function emptyResult(reason) {
    return { text: '', selected: [], count: 0, chars: 0, reason: reason };
  }

  function createOrchestrator(overrides) {
    var deps = {};
    var k;
    for (k in DEFAULT_DEPS) {
      if (Object.prototype.hasOwnProperty.call(DEFAULT_DEPS, k)) deps[k] = DEFAULT_DEPS[k];
    }
    if (isPlainObject(overrides)) {
      for (k in overrides) {
        if (Object.prototype.hasOwnProperty.call(overrides, k)) deps[k] = overrides[k];
      }
    }

    function traceOf() {
      return (deps.trace && typeof deps.trace.buildTrace === 'function') ? deps.trace : null;
    }

    /* ── visibility pre-filter（唯一 ACL）─────────────────────────────
       直接调用共享 visibility primitive，**不**复制 public/only/except/private
       的判断。核心缺失或判定抛错 ⇒ 返回 { ok:false }，由调用方 fail closed。 */
    function filterVisible(records, options) {
      var vis = deps.visibility;
      if (!vis || typeof vis.isMemoryVisibleTo !== 'function') return { ok: false, visible: [] };
      var rows = Array.isArray(records) ? records : [];
      var apiId = String(options.apiId == null ? '' : options.apiId);
      var isGroup = !!options.isGroup;
      var groupMemEnabled = !!options.groupMemEnabled;
      var visible = [];
      /* 单条判定抛错 ⇒ 该条按不可见处理（fail closed，绝不"当作可用"）。
         这是**安全的**：漏掉的记忆只是没被召回，不会反向泄漏。
         但"ACL 核心本身不可调用/在调用处抛错"是另一回事 —— 见下面的外层判定。 */
      for (var i = 0; i < rows.length; i++) {
        var m = rows[i];
        if (!m) continue;
        var ok = false;
        try { ok = !!vis.isMemoryVisibleTo(m, apiId, isGroup, groupMemEnabled); } catch (e) { ok = false; }
        if (ok) visible.push(m);
      }
      return { ok: true, visible: visible };
    }

    /* ACL 是否**可判定**。返回 null 表示不可判定（核心缺失 / 调用即抛）。
       为什么必须与"逐条判 false"分开：
         一条"判定函数抛错"的记录如果被当成 false，整批就会变成"没有可见记忆"，
         调用方看到的是 no-visible-memory —— 一个**正常结论**，
         而真相是"我们根本不知道谁可见"。那正是 fail-closed 要防的语义塌陷。
       因此这里做一次探测调用：它在**任何**记录上抛错，就判 ACL 不可用。 */
    function visibilityIsDecidable(records, options) {
      var vis = deps.visibility;
      if (!vis || typeof vis.isMemoryVisibleTo !== 'function') return false;
      var rows = Array.isArray(records) ? records : [];
      var probe = null;
      for (var i = 0; i < rows.length; i++) { if (rows[i]) { probe = rows[i]; break; } }
      /* 没有任何记录可探测 ⇒ 这是"候选集为空"（no-visible-memory / no-visible），
         不是"ACL 不可判定"。把空集报成 visibility-unavailable 会把一个正常结论
         说成故障。 */
      if (probe === null) return true;
      try {
        vis.isMemoryVisibleTo(probe, String(options.apiId == null ? '' : options.apiId),
          !!options.isGroup, !!options.groupMemEnabled);
        return true;
      } catch (e) {
        return false;
      }
    }

    /* ── legacy mode ──────────────────────────────────────────────── */
    function legacyRecall(records, options) {
      var core = deps.core;
      var inputCount = Array.isArray(records) ? records.length : 0;
      if (!core || typeof core.buildMemoryContext !== 'function') {
        /* fail open：召回不可用不阻塞回合，但如实上报。 */
        var failTrace = traceOf() ? traceOf().emptyTrace(
          CHANNEL_LEGACY, REASON_VISIBILITY_UNAVAILABLE,
          { input: inputCount, visible: 0, gated: 0, selected: 0 },
          { maxChars: options && options.maxChars != null ? options.maxChars : null, usedChars: 0 }
        ) : null;
        return {
          result: emptyResult(REASON_VISIBILITY_UNAVAILABLE),
          trace: failTrace,
          meta: { mode: 'legacy', consulted: false, channel: CHANNEL_LEGACY }
        };
      }
      /* **原样委托**。options 就是调用方的 options（含 apiId / now / random /
         userMessage / isGroup / groupMemEnabled / maxChars / contentLen）。
         绝不在这里补默认值、重排字段或重新计算预算 —— 任何一项都会破坏 parity。 */
      var result = core.buildMemoryContext(records, options);
      var selectedCount = result && Array.isArray(result.selected) ? result.selected.length : 0;
      var legacyTrace = traceOf() ? traceOf().emptyTrace(
        CHANNEL_LEGACY,
        result ? result.reason : null,
        {
          input: inputCount,
          /* legacy 不做 pre-filter，因此不谎报 visible/gated：
             两者与 input 的关系未被观测，置 0 并在 candidates 留空。 */
          visible: 0,
          gated: 0,
          selected: selectedCount
        },
        {
          maxChars: options && options.maxChars != null ? options.maxChars : null,
          usedChars: result && typeof result.chars === 'number' ? result.chars : 0
        }
      ) : null;
      return {
        result: result,
        trace: legacyTrace,
        meta: { mode: 'legacy', consulted: true, channel: CHANNEL_LEGACY }
      };
    }

    /* ── turn mode ────────────────────────────────────────────────── */
    function turnRecall(records, options) {
      var turn = options.turn;
      var core = deps.core;
      var rows = Array.isArray(records) ? records : [];
      var inputCount = rows.length;
      var maxChars = options.maxChars != null ? options.maxChars : null;
      var T = traceOf();

      if (!core || typeof core.buildMemoryContext !== 'function'
        || !deps.turnSignal || typeof deps.turnSignal.analyzeTurnSignal !== 'function') {
        var degraded = T ? T.emptyTrace(CHANNEL_LEGACY, REASON_VISIBILITY_UNAVAILABLE,
          { input: inputCount, visible: 0, gated: 0, selected: 0 },
          { maxChars: maxChars, usedChars: 0 }) : null;
        return {
          result: emptyResult(REASON_VISIBILITY_UNAVAILABLE),
          trace: degraded,
          meta: { mode: 'turn', consulted: false, channel: CHANNEL_LEGACY }
        };
      }

      /* ① turn signal + early exit */
      var signal = deps.turnSignal.analyzeTurnSignal({
        message: turn.message,
        isConversationOpen: turn.isConversationOpen,
        channelHint: turn.channelHint,
        explicitRecallHint: turn.explicitRecallHint,
        hasSemanticPayload: turn.hasSemanticPayload
      });
      var channel = signal.suggestedChannel || signal.decisionSource || null;

      if (signal.earlyExit === true) {
        /* early exit：**不**读 relevance、**不**算 memoryValue、
           **不**执行 buildMemoryContext。 */
        var eeTrace = T ? T.buildTrace({
          channel: channel,
          earlyExit: true,
          earlyExitReason: signal.earlyExitReason,
          query: null,
          counts: { input: inputCount, visible: 0, gated: 0, selected: 0 },
          candidates: [],
          budget: { maxChars: maxChars, usedChars: 0 },
          reason: REASON_EARLY_EXIT
        }) : null;
        return {
          result: emptyResult(REASON_EARLY_EXIT),
          trace: eeTrace,
          meta: { mode: 'turn', consulted: false, channel: channel }
        };
      }

      /* ② query construction（确定性；不自行再 normalize 一遍） */
      var query = null;
      if (deps.query && typeof deps.query.buildRecallQuery === 'function') {
        try {
          query = deps.query.buildRecallQuery(turn.message, options.queryOptions);
        } catch (e) { query = null; }
      }
      var lexicalTerms = (query && Array.isArray(query.lexicalTerms)) ? query.lexicalTerms : [];
      var scoreQuery = { lexicalTerms: lexicalTerms };

      /* ③ visibility pre-filter（**先于**任何 relevance / scoring / trace detail） */
      var visResult = filterVisible(rows, options);
      if (!visResult.ok || !visibilityIsDecidable(rows, options)) {
        var vuTrace = T ? T.buildTrace({
          channel: channel, earlyExit: false, earlyExitReason: null,
          query: query,
          counts: { input: inputCount, visible: 0, gated: 0, selected: 0 },
          candidates: [],
          budget: { maxChars: maxChars, usedChars: 0 },
          reason: REASON_VISIBILITY_UNAVAILABLE
        }) : null;
        return {
          result: emptyResult(REASON_VISIBILITY_UNAVAILABLE),
          trace: vuTrace,
          meta: { mode: 'turn', consulted: false, channel: channel }
        };
      }
      var visible = visResult.visible;

      /* ④ ACL 后没有可见候选 ⇒ no-visible-memory（**不是** gate-rejected：
             gate 根本没有候选）。 */
      if (!visible.length) {
        var nvTrace = T ? T.buildTrace({
          channel: channel, earlyExit: false, earlyExitReason: null,
          query: query,
          counts: { input: inputCount, visible: 0, gated: 0, selected: 0 },
          candidates: [],
          budget: { maxChars: maxChars, usedChars: 0 },
          reason: REASON_NO_VISIBLE
        }) : null;
        return {
          result: emptyResult(REASON_NO_VISIBLE),
          trace: nvTrace,
          meta: { mode: 'turn', consulted: true, channel: channel }
        };
      }

      /* ⑤ relevanceScore + ⑥ Hard Gate。只删 relevanceScore === 0 的候选，
             原始 record **不被修改**。 */
      var scoring = deps.scoring;
      var scored = [];
      var gated = [];
      for (var i = 0; i < visible.length; i++) {
        var m = visible[i];
        var rel = (scoring && typeof scoring.scoreRelevance === 'function')
          ? scoring.scoreRelevance(m, scoreQuery)
          : { score: 0, signals: {} };
        var value = (scoring && typeof scoring.computeLegacyMemoryValue === 'function')
          ? scoring.computeLegacyMemoryValue(m, options.now)
          : 0;
        var passed = (scoring && typeof scoring.passesHardGate === 'function')
          ? scoring.passesHardGate(rel) : false;
        scored.push({ memory: m, relevance: rel, memoryValue: value, passed: passed });
        if (passed) gated.push(m);
      }

      /* ⑦ gate 后仍**复用既有 core** 完成 selection。
           传给 core 的 options 与调用方一致，但做两处**必要**调整：
             · userMessage ← turn.message
               为什么必要：relBoost 由 userMessage 驱动。gate 用的是
               turn.message 的词元，若 core 拿到的 userMessage 不同，
               同一条记忆会出现"过了门槛、却按另一套相关性重新排序/重算分数"
               —— gate 与 selection 用的就不是同一个 relevance 了。
               这不改变文本与预算，只消除两套 relevance 并存的可能。
             · 去掉 turn
               turn 是本模块的编排输入，不是 core 的语义；把它透传下去会让
               "core 不认识 turn" 这条边界变得模糊。 */
      var coreOpts = {};
      for (var k in options) {
        if (Object.prototype.hasOwnProperty.call(options, k) && k !== 'turn') coreOpts[k] = options[k];
      }
      coreOpts.userMessage = turn.message == null ? '' : String(turn.message);
      var gatedResult = core.buildMemoryContext(gated, coreOpts);
      var selectedIds = (gatedResult && Array.isArray(gatedResult.selected))
        ? gatedResult.selected.map(function (s) { return s && s.id; })
        : [];
      var selectedSet = {};
      for (var s = 0; s < selectedIds.length; s++) selectedSet[String(selectedIds[s])] = 1;

      /* ⑧ reason：既有三态保持原义，新增 gate-rejected。 */
      var reason;
      if (gatedResult && gatedResult.reason === REASON_VISIBILITY_UNAVAILABLE) {
        /* 已自行做过 ACL，这里不应再出现；如实透传而不静默改写。 */
        reason = REASON_VISIBILITY_UNAVAILABLE;
      } else if (!gated.length) {
        reason = REASON_GATE_REJECTED;
      } else if (!selectedIds.length) {
        reason = REASON_NO_BUDGET;
      } else {
        reason = null;
      }
      var result;
      if (reason === null) {
        result = gatedResult;
      } else if (reason === REASON_VISIBILITY_UNAVAILABLE) {
        result = gatedResult || emptyResult(REASON_VISIBILITY_UNAVAILABLE);
      } else {
        /* gate-rejected / no-budget 都表示"没有注入"。
           text/chars/selected/count 取自 core（那里已经是空），reason 换成新值。 */
        result = {
          text: gatedResult && typeof gatedResult.text === 'string' ? gatedResult.text : '',
          selected: gatedResult && Array.isArray(gatedResult.selected) ? gatedResult.selected : [],
          count: gatedResult && typeof gatedResult.count === 'number' ? gatedResult.count : 0,
          chars: gatedResult && typeof gatedResult.chars === 'number' ? gatedResult.chars : 0,
          reason: reason
        };
      }

      /* ⑨ candidate trace detail：**只针对 visible 记录**。
            隐藏记录在这里结构上不可能出现 —— 它们从未进入 scored。 */
      var candidates = [];
      if (T) {
        for (var c = 0; c < scored.length; c++) {
          var row = scored[c];
          var id = row.memory && row.memory.id != null ? String(row.memory.id) : null;
          var isSelected = id != null && selectedSet[id] === 1;
          var rowReasons = [];
          if (!row.passed) {
            rowReasons.push(REASON_GATE_REJECTED);
          } else if (!isSelected) {
            rowReasons.push(REJECT_NOT_SELECTED);
            if (reason === REASON_NO_BUDGET) rowReasons.push(REJECT_BUDGET);
          }
          candidates.push(T.createCandidateEntry({
            memoryId: id,
            relevanceScore: row.relevance ? row.relevance.score : 0,
            memoryValue: row.memoryValue,
            /* ── finalScore = null（P21-R2-C.1 · 诚实性裁决）─────────────────
               这里**曾经**填的是 memoryValue × relevanceScore。那是一个自造指标，
               不是 selector 实际使用的分数 —— 必须为 null，理由：

                 · 真正的 legacy ranking 是 core 的
                     getMemoryScore × relBoost × fatigue
                   其中 fatigue（activationCount>5 且 lastActivated<2h → ×0.7）
                   在本层**完全不可见**。
                 · relBoost = calcRelevance(...) ∈ [1, 2.5]，而本层的
                   relevanceScore = (relBoost − 1) / 1.5 ∈ [0, 1] 只是
                   **Hard Gate 用的归一化相关性信号**。
                 · 于是 memoryValue × relevanceScore 既不是那个乘积的值，
                   也不是它的方向：relevanceScore 为 0 时自造值恒 0，
                   而真实 relBoost 恒 ≥ 1，绝不把一条命中记忆压到 0。

               把自造值标成 finalScore 是**伪精确**：读 trace 的人会据此
               推断排序与幅度，而两件都可能是错的。Trace 宁可少一个字段的值，
               也不能给一个会被信以为真的错值。

               什么时候可以非 null：当真实 selector / ranker 的 ranked score
               能从**唯一**实现直接获得时（而不是在本层重算一遍 —— 那会造出
               第二套排序公式，正是 Contract §7/§12 反复禁止的"她记得什么有两套"）。
               R2-C.1 **不**为此修改 memory-retrieval-core.js。 */
            finalScore: null,
            seat: SEAT_LEGACY,
            decision: isSelected ? 'selected' : 'rejected',
            reasons: rowReasons
          }));
        }
      }

      var trace = T ? T.buildTrace({
        channel: channel,
        earlyExit: false,
        earlyExitReason: null,
        query: query,
        counts: {
          input: inputCount,
          visible: visible.length,
          gated: gated.length,
          selected: selectedIds.length
        },
        candidates: candidates,
        budget: {
          maxChars: maxChars,
          usedChars: result && typeof result.chars === 'number' ? result.chars : 0
        },
        reason: reason
      }) : null;

      return {
        result: result,
        trace: trace,
        meta: { mode: 'turn', consulted: true, channel: channel }
      };
    }

    /* ── 唯一公开入口 ─────────────────────────────────────────────── */
    function recall(records, options) {
      var opts = isPlainObject(options) ? options : {};
      /* 触发条件刻意**极简**：没有 options.turn 就是 legacy。
         其它任何"显式 recall signal"当前都通过 turn 对象表达。 */
      if (opts.turn == null) return legacyRecall(records, opts);
      return turnRecall(records, opts);
    }

    return {
      recall: recall,
      /* 暴露给测试：让"哪些步骤被执行了"可以通过注入 spy 证明 */
      _filterVisible: filterVisible,
      _deps: deps
    };
  }

  var defaultInstance = createOrchestrator(null);

  return {
    createOrchestrator: createOrchestrator,
    recall: defaultInstance.recall,
    CHANNEL_LEGACY: CHANNEL_LEGACY,
    REASON_EARLY_EXIT: REASON_EARLY_EXIT,
    REASON_GATE_REJECTED: REASON_GATE_REJECTED,
    REASON_NO_VISIBLE: REASON_NO_VISIBLE,
    REASON_NO_BUDGET: REASON_NO_BUDGET,
    REASON_VISIBILITY_UNAVAILABLE: REASON_VISIBILITY_UNAVAILABLE,
    SEAT_LEGACY: SEAT_LEGACY
  };
});
