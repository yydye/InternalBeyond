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
    deps.selectorShadowHost = 'node';
    try { deps.core = require('../memory-retrieval-core.js'); } catch (e) { deps.core = null; }
    try { deps.visibility = require('../memory-visibility-core.js'); } catch (e) { deps.visibility = null; }
    try { deps.turnSignal = require('./turn-signal.js'); } catch (e) { deps.turnSignal = null; }
    try { deps.query = require('./recall-query.js'); } catch (e) { deps.query = null; }
    try { deps.trace = require('./recall-trace.js'); } catch (e) { deps.trace = null; }
    try { deps.scoring = require('./scoring.js'); } catch (e) { deps.scoring = null; }
    try { deps.channelPolicy = require('./channel-policy.js'); } catch (e) { deps.channelPolicy = null; }
    try { deps.seatPlanner = require('./seat-planner.js'); } catch (e) { deps.seatPlanner = null; }
    try { deps.glossaryCatalog = require('./glossary-catalog.js'); } catch (e) { deps.glossaryCatalog = null; }
    try { deps.glossaryMatch = require('./glossary-match.js'); } catch (e) { deps.glossaryMatch = null; }
    try { deps.coldStartAnchor = require('./coldstart-anchor.js'); } catch (e) { deps.coldStartAnchor = null; }
    try { deps.cooldown = require('./cooldown.js'); } catch (e) { deps.cooldown = null; }
    /* R4-B：deterministic MetaMemory shadow。**可选**依赖 —— 缺失时 shadow 为 null，
       recall 行为逐字不变（fail open，绝不影响选择）。 */
    try { deps.metamemoryShadow = require('./metamemory-shadow.js'); } catch (e) { deps.metamemoryShadow = null; }
    module.exports = factory(deps);
  } else {
    root.IBMemoryRecallOrchestrator = factory({
      selectorShadowHost: 'browser',
      core: root.IBMemoryRetrievalCore || null,
      visibility: root.IBMemoryVisibilityCore || null,
      turnSignal: root.IBMemoryRecallTurnSignal || null,
      query: root.IBMemoryRecallQuery || null,
      trace: root.IBMemoryRecallTrace || null,
      scoring: root.IBMemoryRecallScoring || null,
      channelPolicy: root.IBMemoryRecallChannelPolicy || null,
      seatPlanner: root.IBMemoryRecallSeatPlanner || null,
      glossaryCatalog: root.IBMemoryRecallGlossaryCatalog || null,
      glossaryMatch: root.IBMemoryRecallGlossaryMatch || null,
      coldStartAnchor: root.IBMemoryRecallColdStartAnchor || null,
      cooldown: root.IBMemoryRecallCooldown || null,
      metamemoryShadow: root.IBMemoryMetaMemoryShadow || null
    });
  }
})(typeof self !== 'undefined' ? self : this, function (DEFAULT_DEPS) {
  'use strict';

  var CHANNEL_LEGACY = 'legacy';
  var CHANNEL_UNSUPPORTED = 'channel-unsupported';
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
  /* 非 lexical 通道上"未被准入"的诚实措辞（≠ gate-rejected）。 */
  var REJECT_NOT_ADMITTED = 'not-admitted';
  /* 真正被注入的探索项（seat='exploration'）的证据。 */
  var REASON_EXPLORATION_SELECTED = 'exploration-selected';

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

    /* ── glossary catalog：**纯注入** seam（§31）──────────────────────
       优先 options.glossaryProvider（{getEntries}）；
       其次 options.getGlossaryEntries（纯函数）；
       都没有 ⇒ provider absent（available:false）—— 这是 production 默认，
       不是失败：引擎就绪，等待写入侧 authority。
       **绝不**从 DB / storage 读；**绝不**为了"看得见效果"造 demo entries。 */
    function resolveGlossaryCatalog(options, turn) {
      var GC = deps.glossaryCatalog;
      if (!GC || typeof GC.createGlossaryCatalogProvider !== 'function') {
        return { available: false, entries: [], dropped: 0, droppedReasons: {}, truncated: false, reason: 'catalog-module-unavailable' };
      }
      var ctx = {
        apiId: (options && options.apiId != null) ? String(options.apiId) : '',
        conversationId: (turn && typeof turn.conversationId === 'string') ? turn.conversationId : null,
        message: (turn && turn.message != null) ? String(turn.message) : ''
      };
      var provider = options ? options.glossaryProvider : null;
      if (provider && typeof provider.getEntries === 'function') {
        try {
          var got = provider.getEntries(ctx);
          if (got && typeof got === 'object' && typeof got.available === 'boolean') return got;
          /* provider 返回裸数组 ⇒ 按 E1a 的 normalize 路径处理 */
          if (Array.isArray(got)) return GC.createGlossaryCatalogProvider(function () { return got; }).getEntries(ctx);
          return { available: false, entries: [], dropped: 0, droppedReasons: {}, truncated: false, reason: 'provider-bad-result' };
        } catch (e) {
          return { available: false, entries: [], dropped: 0, droppedReasons: {}, truncated: false, reason: 'provider-error' };
        }
      }
      if (options && typeof options.getGlossaryEntries === 'function') {
        try { return GC.createGlossaryCatalogProvider(options.getGlossaryEntries).getEntries(ctx); }
        catch (e) { return { available: false, entries: [], dropped: 0, droppedReasons: {}, truncated: false, reason: 'provider-error' }; }
      }
      return GC.createEmptyCatalogProvider().getEntries(ctx);
    }

    /* 用 core 已渲染好的 `line` 重组被 seat 上限保留的子集。
       · 不复制 renderer：`line` 就是 core.renderMemoryLine 的输出。
       · 不复制 budget 公式：预算已由 core.selectWithinBudget 判定完毕；
         这里只是把 core 实际产出的那些行相加（纯算术恒等式）。
       · header 从 core 的 text 推导，而不是在这里写死标题字面量 ——
         这样即使 core 改了标题，orchestrator 也自动跟随，不会漂移。 */
    function recapped(built, plan, reasonValue) {
      var allLen = 0;
      var allSelected = (built && Array.isArray(built.selected)) ? built.selected : [];
      for (var i = 0; i < allSelected.length; i++) {
        allLen += (allSelected[i] && typeof allSelected[i].line === 'string') ? allSelected[i].line.length : 0;
      }
      var text = String(built && built.text ? built.text : '');
      var headLen = text.length - allLen;
      if (!isFinite(headLen) || headLen < 0) headLen = 0;
      var head = text.slice(0, headLen);
      var out = head;
      var chars = headLen;
      for (var j = 0; j < plan.seats.length; j++) {
        var ln = (plan.seats[j] && typeof plan.seats[j].line === 'string') ? plan.seats[j].line : '';
        out += ln;
        chars += ln.length;
      }
      var result = {
        text: out,
        selected: plan.seats,
        count: plan.seats.length,
        chars: chars,
        reason: reasonValue
      };
      if (Array.isArray(built && built.semanticForgettingById)) {
        var kept = Object.create(null);
        for (var k = 0; k < plan.seats.length; k++) {
          if (plan.seats[k] && plan.seats[k].id != null) kept[String(plan.seats[k].id)] = true;
        }
        result.semanticForgettingById = built.semanticForgettingById.filter(function (entry) {
          return entry && entry.memoryId != null && kept[String(entry.memoryId)];
        });
        result.memoryProvenanceById = Array.isArray(built.memoryProvenanceById)
          ? built.memoryProvenanceById.filter(function (entry) {
            return entry && entry.memoryId != null && kept[String(entry.memoryId)];
          }) : [];
      }
      return result;
    }

    /* cooldown 的 reason 只反映**真实**发生的事；没有 info ⇒ 空数组。 */
    function cooldownReasonOf(info) {
      return (info && typeof info.reason === 'string' && info.reason) ? [info.reason] : [];
    }

    /* ── legacy mode ──────────────────────────────────────────────── */
    function legacyRecall(records, options, metaExtra) {
      var extra = isPlainObject(metaExtra) ? metaExtra : {};
      var core = deps.core;
      var inputCount = Array.isArray(records) ? records.length : 0;
      var legacyMeta = {
        mode: extra.fallback ? 'legacy-fallback' : 'legacy',
        consulted: true,
        channel: CHANNEL_LEGACY,
        /* turnUsable：turn 是否被真正使用。
           false 有两种来源：调用方根本没传 turn（legacy 正常路径），
           或传了但 message 不可用（wiring bug ⇒ fallback）。
           两者对调用方的含义不同，因此额外用 mode 区分。 */
        turnUsable: extra.turnUsable === true
      };
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
          meta: Object.assign({}, legacyMeta, { consulted: false })
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
        meta: legacyMeta
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

      /* ── ①a turn 存在但 message 不可用 ⇒ legacy fallback（**不是** early exit）
         这是 R2-D 新冻结的 fail-safe。为什么必须区分：
           · 真正的空消息：Host **明确**传了字符串 '' ⇒ 用户确实发了个空轮
             ⇒ 允许 Early Exit。
           · message 缺失 / null / 非字符串：这是 Host wiring bug 的形状。
             把它当成"用户发了空消息"会**静默关闭**该 Host 的全部记忆召回 ——
             正是 §9.3/§19 警告的那个严重风险。
         「缺输入 ≠ 用户发了空消息」。宁可退回 legacy（行为与接线前一致），
         并在 meta 里如实报告 turnUsable=false，也不要静默关掉记忆。 */
      /* 可用性判据：`!= null`。
         为什么**不**要求 typeof === 'string'：那会让"Host 中间层做过
         `userMessage || ''` 归一化"变成一次**静默关闭记忆**。
         Home Node 的调用链正好有这个归一化（`options.userMessage || ''`），
         因此字符串判据会把"Host 根本没拿到 user message"伪装成"用户发了空消息"。
         改成 != null 之后：缺输入 ⇒ 退回 legacy（与接线前一致）；
         明确传 '' ⇒ 才是真的空消息，允许 early exit。 */
      var turnUsable = (turn.message != null);
      if (!turnUsable) return legacyRecall(rows, options, { turnUsable: false, fallback: true });

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

      /* ① turn signal */
      var signal = deps.turnSignal.analyzeTurnSignal({
        message: turn.message,
        isConversationOpen: turn.isConversationOpen,
        channelHint: turn.channelHint,
        explicitRecallHint: turn.explicitRecallHint,
        hasSemanticPayload: turn.hasSemanticPayload
      });

      /* ② channel 仲裁（P21-R2-E1b §25 冻结顺序）────────────────────────
           0. host-forced coldStart（trusted explicit override，不参与自动序）
           1. host-forced 其它通道
           2. explicit recall intent
           3. automatic coldStart（生命周期信号）
           4. automatic glossary（exact catalog hit）
           5. early exit
           6. semantic surface

         关键：**自动** coldStart 不得抢走**明确**的 recall 意图；
         而 early exit **排在 glossary/coldStart 之后** —— 新会话第一句
         "嗯" 正是 coldStart 最该起作用的时刻，不能被早退吃掉。
         （turn-signal 已保证 host-forced 通道先于 early exit。） */
      var forcedRaw = (turn.channelHint == null) ? null : String(turn.channelHint);
      var signalChan = signal.suggestedChannel ? String(signal.suggestedChannel) : null;
      /* Only the trusted host hint is forced. `signalChan` may be an automatic
         lifecycle suggestion; treating it as forced let first-turn coldStart
         override an explicit recall cue and remove episodic candidates before
         the Hard Gate. */
      var explicitColdStart = (forcedRaw === 'coldStart');
      var forcedOther = (forcedRaw && forcedRaw !== 'coldStart') ? forcedRaw : null;

      /* E1a 的 latent 会话信号现在是正式输入（§22）。 */
      var convSignal = {
        conversationSignalAvailable: turn.conversationSignalAvailable === true,
        isFirstTurn: turn.isFirstTurn === true,
        conversationId: (typeof turn.conversationId === 'string' && turn.conversationId)
          ? turn.conversationId : null
      };
      var autoColdStart = (deps.coldStartAnchor
        && typeof deps.coldStartAnchor.coldStartApplicable === 'function')
        ? deps.coldStartAnchor.coldStartApplicable(convSignal, { isGroup: options.isGroup === true })
        : false;

      /* glossary：provider **纯注入**，绝不从 DB 读（§31）。
         默认（调用方不提供）⇒ provider absent ⇒ 自动 glossary 不会触发；
         但这**不是**失败：引擎已就绪，等待写入侧 authority。 */
      var catalog = resolveGlossaryCatalog(options, turn);
      var glossaryHits = null;
      var autoGlossary = false;
      if (deps.glossaryMatch && typeof deps.glossaryMatch.matchGlossary === 'function') {
        try { glossaryHits = deps.glossaryMatch.matchGlossary(turn.message, catalog); }
        catch (e) { glossaryHits = null; }
      }
      if (glossaryHits && glossaryHits.available === true && glossaryHits.hits.length > 0) autoGlossary = true;

      var channel;
      if (explicitColdStart) channel = 'coldStart';
      else if (forcedOther) channel = forcedOther;
      else if (signal.explicitRecall === true) channel = 'recall';
      else if (autoColdStart || signalChan === 'coldStart') channel = 'coldStart';
      else if (autoGlossary) channel = 'glossary';
      else if (signal.earlyExit === true) channel = 'early-exit';
      else channel = 'surface';

      if (channel === 'early-exit') {
        /* early exit：**不**读 relevance、**不**算 memoryValue、
           **不**执行 buildMemoryContext、**不**解析 channel policy。
           `channel: null` 是诚实的 —— 这一轮没有通道，因为它没有被启动。 */
        var eeTrace = T ? T.buildTrace({
          channel: null,
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
          meta: {
            mode: 'turn', consulted: false, channel: null,
            earlyExitReason: signal.earlyExitReason,
            decisionSource: signal.decisionSource,
            activationPolicy: 'normal'
          }
        };
      }

      /* ③ channel policy 解析。
         reminisc 仍为 FUTURE；host 显式强制一个未实现通道 ⇒ channel-unsupported
         （fail closed）。**自动**路径永远不会落到未实现通道上。 */
      var policyRes = (deps.channelPolicy && typeof deps.channelPolicy.resolveChannelPolicy === 'function')
        ? deps.channelPolicy.resolveChannelPolicy(channel)
        : null;
      if (policyRes && (policyRes.ok !== true || policyRes.implemented !== true)) {
        var unsupTrace = T ? T.buildTrace({
          channel: channel,
          earlyExit: false,
          earlyExitReason: null,
          query: null,
          counts: { input: inputCount, visible: 0, gated: 0, selected: 0 },
          candidates: [],
          budget: { maxChars: maxChars, usedChars: 0 },
          reason: CHANNEL_UNSUPPORTED
        }) : null;
        return {
          result: emptyResult(CHANNEL_UNSUPPORTED),
          trace: unsupTrace,
          meta: {
            mode: 'turn', consulted: false, channel: channel,
            channelSupported: false, channelImplemented: false,
            channelUnsupportedReason: policyRes.reason || 'channel-unsupported',
            activationPolicy: 'normal'
          }
        };
      }
      /* §5：host **显式强制** glossary 而 provider 不可用 ⇒ channel-unsupported。
         与"provider 可用但没有 entry"必须区分：后者是 0 hit（gate-rejected），
         **不是**通道不可用 —— 把两者混起来会让"术语表是空的"看起来像"没实现"。 */
      if (channel === 'glossary' && catalog.available !== true
        && (forcedRaw === 'glossary' || signalChan === 'glossary')) {
        var glUnsupTrace = T ? T.buildTrace({
          channel: channel, earlyExit: false, earlyExitReason: null, query: null,
          counts: { input: inputCount, visible: 0, gated: 0, selected: 0 },
          candidates: [],
          budget: { maxChars: maxChars, usedChars: 0 },
          reason: CHANNEL_UNSUPPORTED
        }) : null;
        return {
          result: emptyResult(CHANNEL_UNSUPPORTED),
          trace: glUnsupTrace,
          meta: {
            mode: 'turn', consulted: false, channel: channel,
            channelSupported: false, channelImplemented: true,
            channelUnsupportedReason: catalog.reason || 'provider-unavailable',
            activationPolicy: 'normal'
          }
        };
      }

      var channelPolicy = policyRes ? policyRes.policy : null;
      var seatCap = (channelPolicy && isFinite(Number(channelPolicy.maxTotalSeats)))
        ? Math.max(0, Math.floor(Number(channelPolicy.maxTotalSeats))) : 0;
      /* activation policy 只在 **meta** 上暴露（result 形状冻结，§19）。
         coldStart = 'none'：自动恢复上下文 ≠ 用户主动想起。 */
      var activationPolicy = (channelPolicy && channelPolicy.activationPolicy === 'none')
        ? 'none' : 'normal';
      /* requireRelevance=false 的通道用 exact evidence 作准入，**不**跑 lexical gate。 */
      var requireRelevance = !(channelPolicy && channelPolicy.requireRelevance === false);
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

      /* 各通道的**准入证据**（这是 R2-E1b 的核心差异）：
           surface / recall —— relevanceScore > 0（lexical Hard Gate，R2-D 语义不变）
           glossary        —— **exact catalog hit** 本身就是准入证据。
                              刻意**不**再要求 memory content lexical 命中 alias，
                              否则 alias→memoryId 这个确定性映射会被第二层
                              lexical gate 错误拒绝（§8）。
           coldStart       —— anchor eligibility（pinned OR kind==='semantic'）。
                              **不**使用 current-turn lexical relevance，
                              否则它会退化成 surface 的另一个名字（§14）。 */
      var idOf = function (r) { return (r && r.id != null) ? String(r.id) : null; };
      var visibleById = {};
      for (var vb = 0; vb < visible.length; vb++) {
        var vid = idOf(visible[vb]);
        if (vid != null) visibleById[vid] = visible[vb];
      }

      /* 通道特定的准入理由表：id → reasons[]（trace 用，全部真实可观测）。 */
      var admitReasons = {};
      var rejectReasonsByChannel = {};

      if (channel === 'glossary') {
        /* 顺序安全（§6）：records → visibility → visibleById → catalog hit
           → target id → **只保留 visible target** → canonical selection。
           catalog 可以指向 hidden memory，但 hidden id 永不进入 gated/trace。 */
        var byMem = (glossaryHits && glossaryHits.byMemoryId) ? glossaryHits.byMemoryId : {};
        var seenPool = {};
        for (var gm in byMem) {
          if (!Object.prototype.hasOwnProperty.call(byMem, gm)) continue;
          if (!visibleById[gm]) continue;              /* hidden ⇒ 静默排除，不产生 trace row */
          if (seenPool[gm]) continue;
          seenPool[gm] = 1;
          admitReasons[gm] = (byMem[gm].reasons || []).slice();
        }
      } else if (channel === 'coldStart') {
        var anchorRes = (deps.coldStartAnchor && typeof deps.coldStartAnchor.selectEligibleAnchors === 'function')
          ? deps.coldStartAnchor.selectEligibleAnchors(visible)
          : { anchors: [], rejected: visible.slice(), admitted: {} };
        for (var aid in anchorRes.admitted) {
          if (!Object.prototype.hasOwnProperty.call(anchorRes.admitted, aid)) continue;
          admitReasons[aid] = ['cold-start-anchor'];
        }
        for (var rj = 0; rj < anchorRes.rejected.length; rj++) {
          var rjid = idOf(anchorRes.rejected[rj]);
          if (rjid != null) rejectReasonsByChannel[rjid] = ['not-cold-start-anchor'];
        }
      }

      /* scored 覆盖**全部 visible**（trace 只描述 visible 记录），
         但 relevance 只在 lexical 通道上计算 —— glossary / coldStart 上
         它是 **null**：准入证据不是 lexical relevance，伪造一个分数
         会让 trace 撒谎（§11.1 / §27）。 */
      for (var i = 0; i < visible.length; i++) {
        var m = visible[i];
        var mid = idOf(m);
        var rel = null;
        if (requireRelevance) {
          rel = (scoring && typeof scoring.scoreRelevance === 'function')
            ? scoring.scoreRelevance(m, scoreQuery)
            : { score: 0, signals: {} };
        }
        var value = (scoring && typeof scoring.computeLegacyMemoryValue === 'function')
          ? scoring.computeLegacyMemoryValue(m, options.now)
          : 0;
        var passed = false;
        if (requireRelevance) {
          passed = (scoring && typeof scoring.passesHardGate === 'function')
            ? scoring.passesHardGate(rel) : false;
        } else {
          passed = (mid != null) && !!admitReasons[mid];
        }
        scored.push({
          memory: m, relevance: rel, memoryValue: value, passed: passed,
          admit: (mid != null) ? (admitReasons[mid] || null) : null,
          rejectHint: (mid != null) ? (rejectReasonsByChannel[mid] || null) : null
        });
        if (passed) gated.push(m);
      }
      /* 全部通道共用**唯一**一个准入集 `gated`（⑦ 把它交给 core）。
         glossary / coldStart 的准入证据不是 lexical gate，而是
         exact catalog hit / anchor eligibility（见上面的 admitReasons）。 */

      /* ⑦ canonical selection：把**完整** gated 候选集交给既有 core。
            刻意**不**在 core 之前截断候选集，原因有两条，都是硬性的：
              (a) seat planner 会因此变成第二个 selector。
                  canonical ranking 是 base × relBoost × fatigue，而 memoryValue
                  只是其中的 base。按 memoryValue 预先截断，会在候选数 > cap 时
                  删掉一条 canonical 本会排得**更高**的记录（对抗性反例见
                  tests/test_memory_recall_seats.js §8：canonical [D,A,B,C] vs
                  memoryValue [A,B,C,D]，cap=3 时旧的预截断丢掉排第 1 的 D）。
              (b) exploration 的候选空间会被压进 top-N。
                  core.selectWithinBudget 的探索窗口从"尚未入选的**排名尾部**"
                  抽取；提前截断等于偷偷改写了 exploration 的候选空间，
                  而 exploration 重构属 R2-F，不属于 R2-D。
            因此：ranking 与 selection 全部由 core 独家完成。

            传给 core 的 options 与调用方一致，但做两处**必要**调整：
              · userMessage ← turn.message
                为什么必要：relBoost 由 userMessage 驱动。gate 用的是
                turn.message 的词元，若 core 拿到的 userMessage 不同，
                同一条记忆会出现"过了门槛、却按另一套相关性重新排序/重算分数"
                —— gate 与 selection 用的就不是同一个 relevance 了。
              · 去掉 turn
                turn 是本模块的编排输入，不是 core 的语义；把它透传下去会让
                "core 不认识 turn" 这条边界变得模糊。 */
      /* ── P21-R2-F1b · cooldown factor map ─────────────────────────────
         **只在 visibility + Hard Gate 之后**枚举 exposure。原因（契约 §8 / §26）：
         hidden 或 gate-rejected 的 memory 绝不能因为一次 session-state lookup
         而变得可观测（时序、异常或日志都可能泄露其存在）。

         core 只收到 memoryId → factor 这份**纯数据**；它不认识 session state、
         characterId 或 turnIndex。map 用 Object.create(null) 构造，避免
         "__proto__" / "constructor" 之类 id 触发原型链问题。 */
      var cooldownFactorById = Object.create(null);
      var cooldownInfoById = Object.create(null);
      var sessionState = options.sessionState || null;
      var cdModule = deps.cooldown;
      if (sessionState && cdModule && typeof cdModule.computeCooldown === 'function') {
        var cdCharacterId = (options.apiId == null) ? null : String(options.apiId);
        var cdTurnIndex = options.turnIndex;
        for (var cg = 0; cg < gated.length; cg++) {
          var cgm = gated[cg];
          if (!cgm || cgm.id == null) continue;
          var cgid = String(cgm.id);
          if (Object.prototype.hasOwnProperty.call(cooldownInfoById, cgid)) continue;
          var cdExposure = null;
          try { cdExposure = sessionState.getExposure({ characterId: cdCharacterId, memoryId: cgid }); }
          catch (e) { cdExposure = null; }
          var cdRes = cdModule.computeCooldown({
            channel: channel, currentTurnIndex: cdTurnIndex, exposure: cdExposure
          });
          cooldownInfoById[cgid] = cdRes;
          if (cdRes.factor < 1) cooldownFactorById[cgid] = cdRes.factor;
        }
      }

      var coreOpts = {};
      for (var k in options) {
        if (Object.prototype.hasOwnProperty.call(options, k) && k !== 'turn' && k !== 'selectorVersion') coreOpts[k] = options[k];
      }
      coreOpts.userMessage = (turn.message == null) ? '' : String(turn.message);
      /* P21-R2-F1a · 让 channel policy 的 allowExploration 成为**真实**输入。
         在此之前该字段是**零消费者**的死字段，于是 glossary（canonical contract §9
         明文要求关闭）与 coldStart（稳定 anchor 恢复）都在悄悄做随机探索。
         缺省 true ⇒ legacy / 无 policy 的直调路径行为不变。 */
      coreOpts.allowExploration = !(channelPolicy && channelPolicy.allowExploration === false);
      /* 只有唯一 selector 才知道"谁是探索项"。请求内部 metadata；
         它**不会**出现在对外 result 上（见下面的 strip）。 */
      coreOpts.includeSelectionMeta = true;
      if (options.includeSemanticForgettingMeta === true) coreOpts.includeSemanticForgettingMeta = true;
      /* 只在真有 <1 的因子时才传；absent ⇒ core 视为无 cooldown（legacy 兼容）。 */
      if (Object.keys(cooldownFactorById).length) coreOpts.cooldownFactorsById = cooldownFactorById;

      /* Memory v2 · explicit Home Node selector choice and Phase B shadow.
         Capture the one V1 exploration draw, then replay it into V2. This keeps
         the production random stream and V1 selection unchanged while giving
         both selectors the same candidate set, query, time, cooldown map and
         exploration draw. No selector result is exposed to the caller here. */
      var selectorV2Actual = deps.selectorShadowHost === 'node'
        && options.selectorVersion === 'v2'
        && core && typeof core.buildMemoryContextV2 === 'function';
      var selectorShadowEnabled = !selectorV2Actual
        && deps.selectorShadowHost === 'node'
        && options.selectorShadow === true
        && core && typeof core.buildMemoryContextV2 === 'function';
      var selectorShadowRandomValues = [];
      var selectorShadowRandomReplayMisses = 0;
      if (selectorShadowEnabled) {
        var productionRandom = (typeof coreOpts.random === 'function') ? coreOpts.random : Math.random;
        coreOpts.random = function () {
          var value = productionRandom();
          if (selectorShadowRandomValues.length < 8) selectorShadowRandomValues.push(value);
          return value;
        };
      }
      var gatedResult = selectorV2Actual
        ? core.buildMemoryContextV2(gated, coreOpts)
        : core.buildMemoryContext(gated, coreOpts);
      var explorationIds = (gatedResult && gatedResult.selectionMeta
        && Array.isArray(gatedResult.selectionMeta.explorationIds))
        ? gatedResult.selectionMeta.explorationIds.slice() : [];
      var selectorShadowBuilt = null;
      if (selectorShadowEnabled) {
        try {
          var v2Opts = {};
          for (var v2k in coreOpts) {
            if (Object.prototype.hasOwnProperty.call(coreOpts, v2k)) v2Opts[v2k] = coreOpts[v2k];
          }
          var selectorShadowDrawIndex = 0;
          v2Opts.random = function () {
            if (selectorShadowDrawIndex < selectorShadowRandomValues.length) {
              return selectorShadowRandomValues[selectorShadowDrawIndex++];
            }
            selectorShadowRandomReplayMisses += 1;
            return 0.5;
          };
          /* If V1 had no exploration draw, compare the primary selection only.
             Shadow must not invent an extra random opportunity from V2's
             different remaining set. */
          if (!selectorShadowRandomValues.length) v2Opts.allowExploration = false;
          /* These are internal projection fields. The shadow summary below
             drops all ids and text before it leaves this function. */
          v2Opts.includeSelectionMeta = true;
          v2Opts.includeSemanticForgettingMeta = true;
          selectorShadowBuilt = core.buildMemoryContextV2(gated, v2Opts);
        } catch (e) { selectorShadowBuilt = null; }
      }

      /* 记录 id → record，供 seat 标签使用（标签需要 record.pinned）。 */
      var recordById = {};
      for (var rb = 0; rb < gated.length; rb++) {
        if (gated[rb] && gated[rb].id != null) recordById[String(gated[rb].id)] = gated[rb];
      }

      /* ⑧ Seat 上限：对 core **已经决定**的顺序与集合施加 channel policy。
           本步**只截断**：不排序、不重算、不复制 ranking 公式、不重新解释 budget。
           `selected` 已是 canonical 顺序，截断保留的必然是 canonical 前缀 ——
           因此"候选数 > cap"不再可能改变候选之间的相对优先级。
           gate 判据（score > 0，无魔法阈值）与 seat 数上限是两件不同的事：
             gate  回答"这条算不算相关"；
             seat  回答"这一轮最多注入几条"（产品可见预算）。 */
      var planner = deps.seatPlanner;
      var seatPlan = null;
      if (planner && typeof planner.applySeats === 'function' && gatedResult) {
        seatPlan = planner.applySeats(gatedResult.selected, channelPolicy, {
          labelOf: function (id) {
            var rec = recordById[String(id)];
            return planner.seatLabel(rec);
          },
          /* seat planner **不**自己挑探索项：它只能消费 core 已经选出的 id。 */
          explorationIds: explorationIds,
          allowExploration: coreOpts.allowExploration
        });
      }
      var keptSelected = seatPlan ? seatPlan.seats
        : ((gatedResult && Array.isArray(gatedResult.selected)) ? gatedResult.selected : []);
      var selectedIds = [];
      for (var ks = 0; ks < keptSelected.length; ks++) {
        if (keptSelected[ks] && keptSelected[ks].id != null) selectedIds.push(keptSelected[ks].id);
      }
      var selectedSet = {};
      for (var s = 0; s < selectedIds.length; s++) selectedSet[String(selectedIds[s])] = 1;

      /* ⑨ reason：既有三态保持原义，新增 gate-rejected。 */
      var reason;
      if (gatedResult && gatedResult.reason === REASON_VISIBILITY_UNAVAILABLE) {
        /* 已自行做过 ACL，这里不应再出现；如实透传而不静默改写。 */
        reason = REASON_VISIBILITY_UNAVAILABLE;
      } else if (!gated.length) {
        reason = REASON_GATE_REJECTED;
      } else if (!keptSelected.length) {
        reason = REASON_NO_BUDGET;
      } else {
        reason = null;
      }
      var result;
      if (reason === null) {
        /* seat 上限真的截断了 ⇒ 用 core 自己产出的 `line` 重组保留子集。
           header 是**从 core 的 text 推导**出来的（headLen = text.length − Σ line），
           因此这里不复制任何渲染/标题字面量、不重新解释 budget：
           预算已由 core.selectWithinBudget 判定完毕，本步只做"按 canonical 顺序取前 N 条"。
           渲染的唯一来源仍然是 core.renderMemoryLine（`line` 就是它的输出）。 */
        result = seatPlan && seatPlan.capped ? recapped(gatedResult, seatPlan, reason) : gatedResult;
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

      /* selectionMeta 是**内部** seam（core → orchestrator → seat planner）。
         对外 result 的键集合必须与 R2-F 之前逐字相同 ⇒ 这里显式剥掉。 */
      if (result && Object.prototype.hasOwnProperty.call(result, 'selectionMeta')) {
        var stripped = {};
        for (var sk in result) {
          if (Object.prototype.hasOwnProperty.call(result, sk) && sk !== 'selectionMeta') stripped[sk] = result[sk];
        }
        result = stripped;
      }

      /* Compare the complete post-seat V1/V2 selections using aggregate-only
         counters. No memory ids, query text, rendered lines, or record fields
         are retained in the returned metadata. This is deliberately after V1
         has fixed its result and before any caller can write activation. */
      var selectorShadow = null;
      if (selectorShadowBuilt && Array.isArray(selectorShadowBuilt.selected)) {
        try {
          var v2ExplorationIds = selectorShadowBuilt.selectionMeta
            && Array.isArray(selectorShadowBuilt.selectionMeta.explorationIds)
            ? selectorShadowBuilt.selectionMeta.explorationIds.slice() : [];
          var v2Selected = selectorShadowBuilt.selected;
          if (planner && typeof planner.applySeats === 'function') {
            var v2SeatPlan = planner.applySeats(v2Selected, channelPolicy, {
              labelOf: function (id) {
                var rec = recordById[String(id)];
                return planner.seatLabel(rec);
              },
              explorationIds: v2ExplorationIds,
              allowExploration: coreOpts.allowExploration
            });
            if (v2SeatPlan && Array.isArray(v2SeatPlan.seats)) v2Selected = v2SeatPlan.seats;
          }

          var selectedV1Ids = keptSelected.map(function (row) { return row && row.id != null ? String(row.id) : ''; })
            .filter(function (id) { return !!id; });
          var selectedV2Ids = v2Selected.map(function (row) { return row && row.id != null ? String(row.id) : ''; })
            .filter(function (id) { return !!id; });
          var v2Set = Object.create(null), recordByKey = Object.create(null);
          selectedV2Ids.forEach(function (id) { v2Set[id] = true; });
          for (var recIndex = 0; recIndex < gated.length; recIndex++) {
            var metricRecord = gated[recIndex];
            if (metricRecord && metricRecord.id != null) recordByKey[String(metricRecord.id)] = metricRecord;
          }
          var topK = {};
          [1, 3, 5].forEach(function (kTop) {
            var k1 = selectedV1Ids.slice(0, kTop), k2 = selectedV2Ids.slice(0, kTop);
            var kSet = Object.create(null), overlap = 0;
            k1.forEach(function (id) { kSet[id] = true; });
            k2.forEach(function (id) { if (kSet[id]) overlap += 1; });
            topK[String(kTop)] = {
              overlap: overlap,
              compared: Math.min(kTop, Math.max(k1.length, k2.length))
            };
          });
          function countSelectedWhere(ids, predicate) {
            var count = 0;
            for (var si = 0; si < ids.length; si++) {
              var selectedRecord = recordByKey[ids[si]];
              if (selectedRecord && predicate(selectedRecord)) count += 1;
            }
            return count;
          }
          function ageDaysOf(record) {
            var created = Number(record && (record.created != null ? record.created : record.createdAt));
            var nowValue = Number(coreOpts.now);
            return isFinite(created) && isFinite(nowValue) ? Math.max(0, (nowValue - created) / 86400000) : null;
          }
          var activatedMoreThanOnce = function (record) { return Number(record.activationCount) > 1; };
          var longTerm = function (record) { var age = ageDaysOf(record); return age != null && age >= 180; };
          var v2ProjectionById = Object.create(null);
          (selectorShadowBuilt.semanticForgettingById || []).forEach(function (entry) {
            if (entry && entry.memoryId != null && entry.projection) v2ProjectionById[String(entry.memoryId)] = entry.projection;
          });
          var r4hCompared = 0, r4hDetailMismatch = 0, r4hResidueMismatch = 0;
          var r4hNarrativeMismatch = 0, r4hAccessibilityMismatch = 0;
          var v1ActivationResurfaced = 0, v1Resurfaced = 0, v2Resurfaced = 0;
          var keywords = (typeof core.extractKeywords === 'function')
            ? core.extractKeywords(coreOpts.userMessage || '') : [];
          for (var commonIndex = 0; commonIndex < selectedV1Ids.length; commonIndex++) {
            var commonId = selectedV1Ids[commonIndex];
            if (!v2Set[commonId]) continue;
            var commonRecord = recordByKey[commonId];
            var v2Projection = v2ProjectionById[commonId];
            if (!commonRecord || !v2Projection || typeof core.deriveSemanticForgetting !== 'function') continue;
            var relevanceBoost = commonRecord.pinned ? 1
              : ((typeof core.calcRelevance === 'function') ? core.calcRelevance(commonRecord, keywords) : 1);
            var v1Projection = core.deriveSemanticForgetting(commonRecord, coreOpts.now, relevanceBoost);
            if (!v1Projection) continue;
            r4hCompared += 1;
            if (v1Projection.factualDetail !== v2Projection.factualDetail) r4hDetailMismatch += 1;
            if (v1Projection.emotionalResidue !== v2Projection.emotionalResidue) r4hResidueMismatch += 1;
            if (v1Projection.narrativeMeaning !== v2Projection.narrativeMeaning) r4hNarrativeMismatch += 1;
            if (v1Projection.accessibility !== v2Projection.accessibility) r4hAccessibilityMismatch += 1;
            if (v1Projection.resurfaced === true) v1Resurfaced += 1;
            if (v2Projection.resurfaced === true) v2Resurfaced += 1;
            if (v1Projection.resurfaced === true && v2Projection.resurfaced !== true
              && commonRecord.pinned !== true && relevanceBoost < 2) v1ActivationResurfaced += 1;
          }
          selectorShadow = {
            candidateCount: gated.length,
            v1SelectedCount: selectedV1Ids.length,
            v2SelectedCount: selectedV2Ids.length,
            topK: topK,
            repeatedActivationSelectedV1: countSelectedWhere(selectedV1Ids, activatedMoreThanOnce),
            repeatedActivationSelectedV2: countSelectedWhere(selectedV2Ids, activatedMoreThanOnce),
            longTermSelectedV1: countSelectedWhere(selectedV1Ids, longTerm),
            longTermSelectedV2: countSelectedWhere(selectedV2Ids, longTerm),
            r4h: {
              commonSelectedCompared: r4hCompared,
              factualDetailMismatch: r4hDetailMismatch,
              emotionalResidueMismatch: r4hResidueMismatch,
              narrativeMeaningMismatch: r4hNarrativeMismatch,
              accessibilityMismatch: r4hAccessibilityMismatch,
              v1Resurfaced: v1Resurfaced,
              v2Resurfaced: v2Resurfaced,
              v1ActivationOnlyResurfaced: v1ActivationResurfaced
            },
            randomReplayMisses: selectorShadowRandomReplayMisses
          };
        } catch (e) { selectorShadow = null; }
      }

      /* ⑨ candidate trace detail：**只针对 visible 记录**。
            隐藏记录在这里结构上不可能出现 —— 它们从未进入 scored。 */
      /* ⑩a 已注入条目：core 的 selected，按 core 顺序；decision 与 seat 有真实证据。 */
      var selectedSeatById = {};
      var candidates = [];
      if (T) {
        /* 用 keptSelected（seat 截断**之后**）而不是 gatedResult.selected：
           trace 必须描述真正注入的那批，否则 seat 标签与 result 会不一致。 */
        var coreSelectedRows = keptSelected;
        var sq, selRow, selKey, srcRow, sz;
        for (sq = 0; sq < coreSelectedRows.length; sq++) {
          selRow = coreSelectedRows[sq];
          if (!selRow || selRow.id == null) continue;
          selKey = String(selRow.id);
          srcRow = null;
          for (sz = 0; sz < scored.length; sz++) {
            if (scored[sz].memory && String(scored[sz].memory.id) === selKey) { srcRow = scored[sz]; break; }
          }
          selectedSeatById[selKey] = true;
          candidates.push(T.createCandidateEntry({
            memoryId: selKey,
            /* 非 lexical 通道上 relevance 为 null ⇒ 如实写 null（不伪造分数）。 */
            relevanceScore: (srcRow && srcRow.relevance) ? srcRow.relevance.score : null,
            memoryValue: srcRow ? srcRow.memoryValue : null,
            finalScore: null,
            /* seat 已经由 seat planner 在 applySeats 里按 record.pinned 标注好；
               没有 seat planner 时才回落到 SEAT_LEGACY（表示非其管辖的既有路径）。 */
            seat: (selRow && typeof selRow.seat === 'string') ? selRow.seat : SEAT_LEGACY,
            decision: 'selected',
            /* 准入证据进入 reasons[] —— 不扩 CANDIDATE_KEYS（§11）。
               glossary / coldStart 的准入不是 lexical，必须由 reason 表达；
               lexical 通道（surface/recall）保持空数组（分数已由 relevanceScore 表达）。 */
            /* 探索证据叠加在准入证据之上（同一 candidate 可有多个 reasons）。
               只有**真正注入**的探索项才会走到这里 —— seat cap 裁掉的探索项
               在 ⑩b 里以 rejected 报告，绝不声称 seat='exploration'。 */
            /* cooldownFactor 必须与 core 实际使用的一致；reason 只在**真实**
               发生 penalty / bypass 时出现（§19 / §27 诚实性）。 */
            cooldownFactor: (cooldownInfoById[selKey] || {}).factor,
            reasons: (admitReasons[selKey] || []).concat(
              (explorationIds.indexOf(selRow.id) >= 0) ? [REASON_EXPLORATION_SELECTED] : [],
              cooldownReasonOf(cooldownInfoById[selKey])
            )
          }));
        }
      }
      if (T) {
        for (var c = 0; c < scored.length; c++) {
          var row = scored[c];
          var id = row.memory && row.memory.id != null ? String(row.memory.id) : null;
          /* 已注入的条目在 ⑩a 单独报告（那里有真实 seat 证据与 core 顺序），
             这里只处理**未**注入的候选。 */
          if (id != null && selectedSeatById[id]) continue;
          var rowReasons = [];
          if (!row.passed) {
            /* 通道特定的拒绝理由优先（coldStart: not-cold-start-anchor）。 */
            if (row.rejectHint && row.rejectHint.length) {
              for (var rh = 0; rh < row.rejectHint.length; rh++) rowReasons.push(row.rejectHint[rh]);
            } else if (requireRelevance) {
              rowReasons.push(REASON_GATE_REJECTED);
            } else {
              /* 非 lexical 通道上"没被准入"不等于"gate 拒绝"：
                 glossary 是"没有 exact catalog hit"。 */
              rowReasons.push(REJECT_NOT_ADMITTED);
            }
          } else {
            rowReasons.push(REJECT_NOT_SELECTED);
            if (reason === REASON_NO_BUDGET) rowReasons.push(REJECT_BUDGET);
          }
          if (cooldownInfoById[id] && cooldownInfoById[id].reason) {
            rowReasons.push(cooldownInfoById[id].reason);
          }
          candidates.push(T.createCandidateEntry({
            memoryId: id,
            cooldownFactor: (cooldownInfoById[id] || {}).factor,
            relevanceScore: row.relevance ? row.relevance.score : null,
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
            /* 未被选中的条目：core 的内部席位（主选区 / 探索窗口）在本层
               **不可观察**，因此不猜 —— 用 SEAT_LEGACY 表示"既有选择路径"。 */
            seat: SEAT_LEGACY,
            decision: 'rejected',
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

      /* ── R4-B · deterministic MetaMemory SHADOW（advisory-only）────────
         接缝位置：**最终选择之后**（selectedIds 已定、trace 已建），return 之前。
         它读的是**已经过 ACL** 的 visible 集，写的是 meta 上的一个内部键。
         它**不可能**影响 gate / ranking / exploration / seat / budget /
         injection / activation —— 那些在它之前就已全部定稿。
         result / trace / selected / 顺序 / Legacy 分数 / cooldown
         **逐字不变**（由 §15 parity 测试强制）。
         任何异常都被吞掉：影子算不出来，recall 照常返回。 */
      var mmShadow = null;
      try {
        var MM = deps.metamemoryShadow;
        if (MM && typeof MM.evaluateTurnShadow === 'function') {
          mmShadow = MM.evaluateTurnShadow({
            selectedIds: selectedIds,
            records: visible,
            roleId: options.apiId == null ? null : options.apiId,
            now: null
          }, { visibility: deps.visibility });
        }
      } catch (e) { mmShadow = null; }

      var finalMeta = {
        mode: 'turn', consulted: true, channel: channel,
        /* §19：activation policy 只在这里暴露，result 形状保持冻结。 */
        activationPolicy: activationPolicy,
        /* F1b · 内部 seam：**最终注入**（post-core、post-seat）的 ids。
           调用方在模型 success seam 用它写 exposure ——
           绝不使用 core pre-seat selection / gated candidates / reinforcementIds。
           它只在 meta 上，result 的键集合逐字不变。 */
        injectedMemoryIds: selectedIds.slice(),
        /* R4-B：**内部专用**的 shadow 诊断。与 F1b 的 injectedMemoryIds 同款纪律 ——
           只在 meta 上，result 的键集合逐字不变，且**永不**进入 prompt / UI。 */
        metaMemoryShadow: mmShadow
      };
      /* Preserve the default meta shape; Phase B metadata exists only for the
         explicitly shadow-enabled Home Node composition. */
      if (selectorShadow) finalMeta.selectorShadow = selectorShadow;
      if (selectorV2Actual) finalMeta.selectorVersion = 'memory-recall-v2';
      return { result: result, trace: trace, meta: finalMeta };
    }

    /* ── 唯一公开入口 ─────────────────────────────────────────────── */
    function recall(records, options) {
      var opts = isPlainObject(options) ? options : {};
      /* legacy 触发条件刻意保持**极简**：没有 options.turn 就是 legacy。
         这是 R2-C 冻结的兼容契约，R2-D **不**删除它 ——
         orchestrator 缺失、显式兼容调用方、以及"turn 不可用"都要靠它。 */
      if (opts.turn == null) return legacyRecall(records, opts, { turnUsable: false });
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
