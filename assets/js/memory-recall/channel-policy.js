/* ====================================================================
   IB Memory Recall · Channel Policy — runtime-neutral 纯函数（UMD dual-load）
   --------------------------------------------------------------------
   - Browser: <script src="assets/js/memory-recall/channel-policy.js">
              → window.IBMemoryRecallChannelPolicy
   - Node   : require('../assets/js/memory-recall/channel-policy.js')
   - 规则：零 window / 零 DOM / 零 IndexedDB / 零 localStorage / 零 fetch /
           零副作用 / 零定时器 / 零随机 / 零时钟 / 零 LLM / 纯函数。

   ── 本模块只回答一个问题 ────────────────────────────────────────────
     "这个 channel 用什么 policy？"
     它**不**做召回、不排序、不算分数、不渲染、不做 ACL。

   ── R2-D 正式实现 / 未实现 ──────────────────────────────────────────
     已实现：surface · recall
     未实现（显式返回 FUTURE，**不**静默降级成 surface）：
             coldStart · glossary · reminisce
     不在本模块：legacy —— 它是 orchestrator 的**兼容路径**，
             不由 channel policy 接管（见 Contract §4.1 / §12）。
             把它写进这里会让"兼容层"看起来像一个功能通道。

   ── 为什么 seat 上限是**产品预算**而不是打分阈值 ────────────────────
     MAX_SURFACE_TOTAL_SEATS = 3 · MAX_RECALL_TOTAL_SEATS = 5
     这两条是"每轮最多**注入**多少条记忆"，属于产品可见预算（seat 数上限），
     与"多少相关度才算相关"是两类不同的东西。后者是 gate 的事，
     而 gate 的唯一判据仍是 `relevanceScore > 0`（**无**魔法阈值）。
     把它们混为一谈会让未来的人以为 3 是校准出来的相关性门槛。

   ── 为什么 recall 的 seat 比 surface 宽 ─────────────────────────────
     用户明确要求回想时，"想起几条"的期望本来就更高；这是**策略**差异，
     不是"recall 更相关"。两者的 gate 判据完全相同（> 0）。
   ==================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); }
  else { root.IBMemoryRecallChannelPolicy = factory(); }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* R2-D product policy：每轮最多让多少条 gated 候选进入既有 selector。
     写成常量而不是散落的字面量，是为了让"这是产品预算"这件事可被 review。 */
  /* 命名裁决（P21-R2-D.1 §5）：这两个数限制的是"这一轮最多注入几条"。
     旧名 maxPrimarySeats / MAX_*_PRIMARY_SEATS 会被读成"主选区条数，
     exploration 另有独立 seat"—— 而那个语义本轮**没有**实现（R2-F 才负责），
     且 seat 上限现在施加在 core 完成选择**之后**，限制的确实是总数。
     因此按"准确命名"裁决改为 Total。数字 3 / 5 本身不变。 */
  var MAX_SURFACE_TOTAL_SEATS = 3;
  var MAX_RECALL_TOTAL_SEATS = 5;

  var CHANNEL_SURFACE = 'surface';
  var CHANNEL_RECALL = 'recall';
  var CHANNEL_GLOSSARY = 'glossary';
  var CHANNEL_COLDSTART = 'coldStart';
  /* R2-E1b：glossary 与 coldStart 已实现；**只剩 reminisce** 是 future。 */
  var FUTURE_CHANNELS = ['reminisce'];

  /* gate 判据只有一种：score > 0。
     刻意**不**提供 'strict-positive-0.1' 之类的档位 —— 那会变成
     未经校准的 relevance 阈值，正是 Contract §6 与 §4.2 禁止的东西。 */
  var GATE_MODE_POSITIVE = 'strict-positive';

  var POLICIES = {};
  POLICIES[CHANNEL_SURFACE] = Object.freeze({
    channel: CHANNEL_SURFACE,
    implemented: true,
    /* surface：普通聊天中的自然浮现。保守第一版。 */
    requireRelevance: true,
    gateMode: GATE_MODE_POSITIVE,
    /* 允许既有 core 的探索窗口继续工作。R2-D **不**改探索算法
       （top-10 偏置属 R2-F）。 */
    allowExploration: true,
    cooldownMode: 'obey',
    maxTotalSeats: MAX_SURFACE_TOTAL_SEATS
  });
  POLICIES[CHANNEL_RECALL] = Object.freeze({
    channel: CHANNEL_RECALL,
    implemented: true,
    /* recall：用户明确要求回想。gate 判据与 surface **完全相同**（> 0），
       差别只在座位预算与"不早退"。 */
    requireRelevance: true,
    gateMode: GATE_MODE_POSITIVE,
    allowExploration: true,
    cooldownMode: 'bypass',
    maxTotalSeats: MAX_RECALL_TOTAL_SEATS
  });

  /* ── R2-E1b · glossary ────────────────────────────────────────────
     用户显式提到一个**已知术语/别名**时的确定性查表。
     准入判据不是 memory-content 的 lexical 相关性，而是
     「catalog exact hit」本身（见 glossary-match.js）。
     seat 上限**继承 recall**，不新增未经校准的数字。 */
  POLICIES[CHANNEL_GLOSSARY] = Object.freeze({
    channel: CHANNEL_GLOSSARY,
    implemented: true,
    requireRelevance: false,   /* 准入证据 = exact catalog hit，不是 lexical */
    gateMode: GATE_MODE_POSITIVE,
    allowExploration: false,
    cooldownMode: 'bypass',
    maxTotalSeats: MAX_RECALL_TOTAL_SEATS,
    activationPolicy: 'normal' /* 用户确实提到了该术语 ⇒ 正常强化 */
  });

  /* ── R2-E1b · coldStart ───────────────────────────────────────────
     新会话开头恢复少量**长期锚点**，不是"随机塞几条高分记忆"。
     准入判据 = pinned OR kind==='semantic'（见 coldstart-anchor.js），
     **不**使用 current-turn lexical relevance —— 否则它会退化成
     surface 的另一个名字。seat 上限**继承 surface**（小型 anchor set）。
     activationPolicy='none'：自动恢复上下文 ≠ 用户主动想起，
     必须防止 coldStart→activation++→memoryValue↑→更易被 coldStart
     选中的自强化回路（§18）。 */
  POLICIES[CHANNEL_COLDSTART] = Object.freeze({
    channel: CHANNEL_COLDSTART,
    implemented: true,
    requireRelevance: false,
    gateMode: GATE_MODE_POSITIVE,
    allowExploration: false,
    cooldownMode: 'read-none',   /* 生命周期恢复：完全不读 cooldown */
    maxTotalSeats: MAX_SURFACE_TOTAL_SEATS,
    activationPolicy: 'none'
  });

  /* P21-R2-F1b · cooldown mode（declarative，唯一来源）。
       surface   obey      —— 受 session cooldown 影响
       recall    bypass    —— 用户显式索取，selection 恒不受影响
       glossary  bypass    —— 确定性 lookup 不得被隐藏
       coldStart read-none —— 生命周期恢复，**完全不读** cooldown
     放在 policy 上而不是散落在 orchestrator：避免多份
     `if (channel === "surface") …` 硬编码。 */
  var FUTURE_POLICY = Object.freeze({
    channel: null,
    implemented: false,
    requireRelevance: true,
    gateMode: GATE_MODE_POSITIVE,
    allowExploration: false,
    maxTotalSeats: 0
  });

  /* ── resolveChannelPolicy(channel) ─────────────────────────────────
     返回 { ok, channel, implemented, policy, reason }。
     非法 / 未实现 channel **显式失败**，绝不静默映射到 surface ——
     静默映射会让 R2-E 无法区分"还没做"和"做了但走错通道"。 */
  function resolveChannelPolicy(channel) {
    var name = (channel == null) ? '' : String(channel);

    if (name === CHANNEL_SURFACE || name === CHANNEL_RECALL
      || name === CHANNEL_GLOSSARY || name === CHANNEL_COLDSTART) {
      var p = POLICIES[name];
      return { ok: true, channel: name, implemented: true, future: false, policy: p, reason: null };
    }
    if (FUTURE_CHANNELS.indexOf(name) >= 0) {
      return {
        ok: false, channel: name, implemented: false, future: true,
        policy: FUTURE_POLICY, reason: 'channel-not-implemented'
      };
    }
    if (name === 'legacy') {
      /* legacy 不是 channel policy 的管辖对象。 */
      return {
        ok: false, channel: name, implemented: false, future: false,
        policy: FUTURE_POLICY, reason: 'legacy-not-managed-by-channel-policy'
      };
    }
    return {
      ok: false, channel: name, implemented: false, future: false,
      policy: FUTURE_POLICY, reason: 'unknown-channel'
    };
  }

  function isImplementedChannel(channel) {
    var r = resolveChannelPolicy(channel);
    return r.ok === true && r.implemented === true;
  }

  function listImplementedChannels() {
    return [CHANNEL_SURFACE, CHANNEL_RECALL, CHANNEL_GLOSSARY, CHANNEL_COLDSTART];
  }
  function listFutureChannels() {
    return FUTURE_CHANNELS.slice();
  }

  return {
    resolveChannelPolicy: resolveChannelPolicy,
    isImplementedChannel: isImplementedChannel,
    listImplementedChannels: listImplementedChannels,
    listFutureChannels: listFutureChannels,
    CHANNEL_SURFACE: CHANNEL_SURFACE,
    CHANNEL_RECALL: CHANNEL_RECALL,
    CHANNEL_GLOSSARY: CHANNEL_GLOSSARY,
    CHANNEL_COLDSTART: CHANNEL_COLDSTART,
    FUTURE_CHANNELS: FUTURE_CHANNELS.slice(),
    GATE_MODE_POSITIVE: GATE_MODE_POSITIVE,
    MAX_SURFACE_TOTAL_SEATS: MAX_SURFACE_TOTAL_SEATS,
    MAX_RECALL_TOTAL_SEATS: MAX_RECALL_TOTAL_SEATS
  };
});
