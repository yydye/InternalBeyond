/* ====================================================================
   IB Role DM Social Core — 角色「要不要主动找另一个角色」的**纯决策层**
   --------------------------------------------------------------------
   ── 这一层是什么 ─────────────────────────────────────────────────────
   输入：一个角色的当前处境（关系 / thread / 预算 / 偏好 / 现在几点）。
   输出：一个**决定**，形如

     { shouldInitiate: false, score: 0, peerId: null,
       reasonCode: 'insufficient-intent', reasonCodes: [...], blockers: [...] }

   它是 Role DM Phase 3（Autonomous Social Intent）的**唯一判定真源**。
   执行层（role-dm-social.js）只负责读存储、调本层、然后照本层的决定行事。

   ── 三条不可让步的硬约束（都用签名与结构保证，而不是靠"记得别做"）─────
     1. **零模型调用**。本文件里没有 fetch / callApiChat / 任何异步。
        这不是"当前恰好没调" —— 它是**纯同步函数**，没有任何地方可以发起
        一次请求。因此"100 次 no-action tick = 0 次 API"是结构性的，不是
        被测试偶然观测到的。tick 上花 API 是这类功能的头号设计错误：
        即使最后决定"不聊"，钱已经烧掉了。
     2. **无隐藏状态**。没有 Date.now()、没有 Math.random()、不读存储。
        now / 抖动种子 / 所有事实都从外面注入。同一输入 ⇒ 同一输出，
        所以"她为什么没联系任何人"永远可以被逐条复算。
     3. **不写关系**。本层读 familiarity / affinity / trust，但**绝不**返回
        任何关系增量。"想联系 TA"不是一次互动，不能产生关系变化。
        关系只能由真实发生的 interaction observation 改变（见 role-dm.js
        的 observeRun）。这条边界由"返回结构里根本没有关系字段"保证。

   ── 为什么 intent 与 peer selection 是同一层 ───────────────────────────
   它们共享同一份打分：一个 peer 的"值得联系程度"就是"对她发起联系"的意图
   强度。拆成两个文件会让两处阈值各自演化，最终出现
   "总分过了但候选为空"这种无法解释的状态。这里**一个** score 贯穿：
   排名用它，阈值也用它，trace 里报的也是它。
   ==================================================================== */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) { module.exports = api; return; }
  /* 浏览器：root 就是 window，一切照旧。
     Node（测试里用 (0,eval) 在 mock 全局中求值，与 role-dm-core.js 同款做法）：
     两处都挂 —— `window` 与 globalThis/window 之外的兜底目标。
     这不是"多挂一份以防万一"，而是**真实**需求：运行时层刻意只从 window
     取核心（与 role-dm.js 取 IBRoleDmCore 完全同一纪律），而测试环境里
     `window` 是一个 mock 对象、不等于 globalThis。少挂这一处，
     单测里运行时层会永远拿不到核心并静默降级成 core-unavailable ——
     一个"测试绿、生产正常"的假象，比测试红更难发现。 */
  var targets = [];
  if (root) targets.push(root);
  if (typeof window !== 'undefined' && window && targets.indexOf(window) < 0) targets.push(window);
  if (typeof globalThis !== 'undefined' && globalThis && targets.indexOf(globalThis) < 0) targets.push(globalThis);
  for (var i = 0; i < targets.length; i++) {
    var target = targets[i];
    target.IBRoleDmSocialCore = api;
    if (target.IB && typeof target.IB.expose === 'function') { try { target.IB.expose('roleDmSocialCore', api); } catch (e) { } }
  }
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  var SCHEMA_VERSION = 1;

  /* ══════════ 1. 稳定词表（trace 契约）═══════════════
     这些字符串会出现在开发态 trace 与假时间 soak 统计里，属于**契约**：
     以后做统计/面板时不能因为改文案而破坏它们。绝不 trace 自由文本。 */
  var BLOCK = {
    disabled: 'disabled',
    quietHours: 'quiet-hours',
    characterBusy: 'busy',
    userActive: 'user-active',
    cooldown: 'cooldown',
    quota: 'quota',
    noThread: 'no-thread',
    noCandidates: 'no-candidates',
    insufficientIntent: 'insufficient-intent',
    peerNotReady: 'peer-not-ready',
    threadArchived: 'thread-archived',
    backoff: 'backoff',
    frequencyGate: 'frequency-gate'
  };
  /* 正向信号（构成 score 的项）。 */
  var SIGNAL = {
    existingThread: 'existing-thread',
    relationshipMaintenance: 'relationship-maintenance',
    longTimeNoContact: 'long-time-no-contact',
    sharedPast: 'shared-past',
    positiveAffinity: 'positive-affinity',
    trust: 'trust',
    jitter: 'bounded-jitter'
  };
  /* 决定的 reasonCode（**唯一**向外解释"为什么"的字段）。 */
  var REASON = {
    disabled: 'disabled',
    quietHours: 'quiet-hours',
    busy: 'busy',
    userActive: 'user-active',
    cooldown: 'cooldown',
    quota: 'quota',
    backoff: 'backoff',
    noCandidates: 'no-candidates',
    insufficientIntent: 'insufficient-intent',
    existingThread: 'existing-thread',
    relationshipMaintenance: 'relationship-maintenance',
    longTimeNoContact: 'long-time-no-contact',
    noIntent: 'no-intent',
    /* run 已经发起、但那一轮本身失败了。它是**判定之后**的结果，
       因此属于同一份稳定词表 —— trace 的 reasonCode 只有这一个来源。 */
    providerFailed: 'provider-failed'
  };
  /* 阻塞原因的优先级：决定 reasonCode 用哪一条。
     顺序表达的是"用户最先该知道的原因" —— 总开关关掉永远排第一。 */
  var BLOCK_PRIORITY = [
    BLOCK.disabled, BLOCK.quietHours, BLOCK.backoff, BLOCK.characterBusy,
    BLOCK.userActive, BLOCK.noCandidates, BLOCK.quota, BLOCK.cooldown,
    BLOCK.noThread, BLOCK.peerNotReady, BLOCK.threadArchived, BLOCK.insufficientIntent
  ];
  var BLOCK_REASON = {};
  BLOCK_REASON[BLOCK.disabled] = REASON.disabled;
  BLOCK_REASON[BLOCK.quietHours] = REASON.quietHours;
  BLOCK_REASON[BLOCK.backoff] = REASON.backoff;
  BLOCK_REASON[BLOCK.characterBusy] = REASON.busy;
  BLOCK_REASON[BLOCK.userActive] = REASON.userActive;
  BLOCK_REASON[BLOCK.noCandidates] = REASON.noCandidates;
  BLOCK_REASON[BLOCK.quota] = REASON.quota;
  BLOCK_REASON[BLOCK.cooldown] = REASON.cooldown;
  BLOCK_REASON[BLOCK.noThread] = REASON.noCandidates;
  BLOCK_REASON[BLOCK.peerNotReady] = REASON.noCandidates;
  BLOCK_REASON[BLOCK.threadArchived] = REASON.noCandidates;
  BLOCK_REASON[BLOCK.insufficientIntent] = REASON.insufficientIntent;

  /* ══════════ 2. 常量 ═══════════════ */
  /* 阈值曲线：initiative 是**阈值**，不是概率。
     低 initiative ⇒ 需要更强的社会理由；高 initiative ⇒ 较弱理由也可能联系。
     它永远不会变成"每 tick 掷一次骰子" —— 骰子只出现在 BOUNDED_JITTER_MAX，
     且只用来打破并列（见 scorePeer）。
     0.35（默认）→ 0.522；0 → 0.62；1 → 0.34。 */
  var THRESHOLD_AT_ZERO = 0.62;
  var THRESHOLD_AT_ONE = 0.34;
  var DEFAULT_INITIATIVE = 0.35;
  /* 有界抖动上界。**故意小**：它只能把临界分数推过线，不能独自构成理由
     —— 下面单独一项信号的最高权重是 0.30 > 0.06，所以
     "只有抖动"永远不可能触发一次联系。 */
  var BOUNDED_JITTER_MAX = 0.06;

  var SIGNAL_WEIGHTS = {
    existingThread: 0.30,
    familiarity: 0.36,
    affinity: 0.16,
    trust: 0.10,
    longTimeNoContact: 0.16,
    sharedPast: 0.08
  };
  var FAMILIARITY_BASELINE = 0.2;   /* 与 role-dm-core 的 RELATION_DEFAULT 同值 */
  var RELATION_NEUTRAL = 0.5;

  /* 时间分级（仅在有 thread 时生效）。 */
  var GAP_TIERS = [
    { ms: 72 * 3600000, bonus: 0.16, code: SIGNAL.longTimeNoContact },
    { ms: 24 * 3600000, bonus: 0.10, code: SIGNAL.relationshipMaintenance },
    { ms: 6 * 3600000, bonus: 0.04, code: SIGNAL.relationshipMaintenance }
  ];

  /* 预算（autonomous **独立于** manual；见 role-dm-core 的 ROLE_DAILY_TURN_MAX=40）
     硬约束：autonomous 上限必须严格小于 manual 上限，否则"后台自己烧 API"
     会把用户手动聊天的额度吃掉。 */
  var BUDGET = {
    perCharacterPerDay: 2,
    globalPerDay: 6,
    pairCooldownMs: 6 * 3600000,
    failureBackoffMs: 4 * 3600000,
    failureBackoffMaxMs: 24 * 3600000
  };
  /* 调度（挂在既有 _activeTick 上，**不新增第二个 setInterval**）。
     150 秒的全局 gate 让"30 秒 tick × 14 角色 × 完整候选集"这件事不会发生。 */
  var SCHED = {
    globalGateMs: 150 * 1000,
    evalMinMs: 45 * 60000,
    evalMaxMs: 90 * 60000
  };

  /* ══════════ 3. 小工具 ═══════════════ */
  function str(v) { return v == null ? '' : String(v); }
  function num(v, d) { var n = Number(v); return isFinite(n) ? n : d; }
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function round4(v) { return Math.round(v * 10000) / 10000; }

  /* 稳定 32 位哈希（FNV-1a 变体）。用于**确定性**抖动与 pair 冷却的
     稳定分档：同一对角色永远得到同一个值，重启/刷新不会改变结果。 */
  function hashStr(s) {
    var h = 2166136261;
    var t = str(s);
    for (var i = 0; i < t.length; i++) {
      h ^= t.charCodeAt(i);
      h = (h * 16777619) >>> 0;
    }
    return h >>> 0;
  }
  /* 由 (seed, 天) 决定的确定性抖动 ∈ [0, max]。
     它替换的是 Math.random() —— 一个"想打破并列"的愿望不该让整个决策
     变得不可复算。 */
  function jitterFor(seed, dayBucket, max) {
    var m = num(max, BOUNDED_JITTER_MAX);
    if (m <= 0) return 0;
    var h = hashStr(str(dayBucket) + '|' + str(seed));
    return (h % 1000) / 1000 * m;
  }
  /* 同一对角色（无序）的自主冷却长度：BUDGET.pairCooldownMs 的 1.0~1.5 倍，
     按 pair key 稳定分档。避免所有 pair 在同一时刻同时解冻。 */
  function autonomousPairCooldownMs(aId, bId) {
    var key = pairKey(aId, bId);
    return BUDGET.pairCooldownMs + (hashStr(key) % (BUDGET.pairCooldownMs / 2));
  }
  function pairKey(aId, bId) {
    var a = str(aId), b = str(bId);
    return a < b ? (a + '|' + b) : (b + '|' + a);
  }
  /* 本地日桶。**故意**用本地日而不是 UTC 日：quota 是给用户看的
     "今天还能聊几次"，应随用户的日历翻页。 */
  function dayBucketOf(now) {
    var t = num(now, 0);
    return t > 0 ? Math.floor(t / 86400000) : 0;
  }
  /* 坏时间戳安全：返回 null 表示"这个值不可用"，调用方按"没有记录"处理。
     负值 / NaN / 未来过远的钟（> 1 天）都视为不可用 —— 否则一次时钟回拨
     会让 lastAt 落在未来，冷却永远不会结束（角色永久卡死）。 */
  function safeTs(v, now) {
    var t = Number(v);
    if (!isFinite(t) || t <= 0) return null;
    var n = num(now, 0);
    if (n > 0 && t > n + 86400000) return null;
    return t;
  }

  /* ══════════ 4. 偏好归一（legacy ⇒ 关闭）═══════════════
     关键的不对称：**缺字段必须是 disabled，而不是 default**。
     一次升级绝不能把"用户从未表态"解释成"用户同意了"。 */
  function normalizeGlobal(raw) {
    var r = (raw && typeof raw === 'object') ? raw : {};
    return { enabled: r.enabled === true };
  }
  function normalizeCharacter(raw) {
    var r = (raw && typeof raw === 'object') ? raw : {};
    var limit = parseInt(r.dailyLimit, 10);
    if (!isFinite(limit) || limit <= 0) limit = BUDGET.perCharacterPerDay;
    return {
      /* 只有**显式 true** 才算开启。undefined / null / 'true' / 1 一律关闭。 */
      enabled: r.enabled === true,
      initiative: clamp(num(r.initiative, DEFAULT_INITIATIVE), 0, 1),
      dailyLimit: Math.min(limit, 20),
      allowStrangers: r.allowStrangers === true
    };
  }
  function thresholdFor(initiative) {
    var i = clamp(num(initiative, DEFAULT_INITIATIVE), 0, 1);
    return round4(THRESHOLD_AT_ZERO - (THRESHOLD_AT_ZERO - THRESHOLD_AT_ONE) * i);
  }
  /* 每角色下次值得重新评估的时刻（确定性抖动，45~90 分钟）。
     注意它按**角色 + 天**取模 —— 14 个角色不会挤在同一分钟评估。 */
  function nextEligibleAt(characterId, fromTs, salt) {
    var seed = str(salt) + '|' + str(characterId) + '|' + String(dayBucketOf(fromTs));
    var span = SCHED.evalMaxMs - SCHED.evalMinMs;
    var extra = span > 0 ? (hashStr(seed) % span) : 0;
    return num(fromTs, 0) + SCHED.evalMinMs + extra;
  }

  /* 同一对角色在**自主语义**下的冷却剩余（纯函数）。
     它与 role-dm-core 的 pairCooldownRemaining 是**两个不同的量**，刻意不合并：
       · core 的 90 秒 —— 防连点 / 防两个标签页接力，manual 与 autonomous 共用；
       · 这里的 6h+ —— 自主额度，只约束 autonomous。
     合并它们会导致"用户手动聊完 90 秒内角色被禁止自主联系"（无意义），
     或者"自主聊完只要等 90 秒就能再自主"（烧 API）。 */
  function pairCooldownRemaining(state, peerId, now) {
    var s = state || {};
    var map = s.budget && s.budget.pairCooldowns;
    if (!map || typeof map !== 'object') return 0;
    var last = safeTs(map[pairKey(s.characterId, peerId)], now);
    if (last === null) return 0;
    var cd = autonomousPairCooldownMs(s.characterId, peerId);
    var rem = cd - (num(now, 0) - last);
    if (rem <= 0) return 0;
    /* 钳到冷却自身的长度：一个落在未来的时间戳（时钟被回拨、或状态被
       手工改过）因此**最多**让这一对在 cd 之内不能再自主联系，
       而不是无限期冻结。这是本函数唯一需要防的退化。 */
    return rem > cd ? cd : rem;
  }

  /* ══════════ 5. 单个 peer 的意图打分 ═══════════════
     这是本模块的核心。**每一个**能改变决定的量都在这里被显式记账，
     并留下一个 code —— 于是"为什么是 0.723"永远可复算。 */
  function scorePeer(input) {
    var i = input || {};
    var peer = i.peer || {};
    var peerId = str(peer.id);
    var signals = [];
    var blockers = [];
    var score = 0;

    if (!peerId || !peer.exists) {
      return { peerId: peerId, score: 0, signals: [], blockers: [BLOCK.peerNotReady], ok: false };
    }
    if (str(i.characterId) === peerId) {
      return { peerId: peerId, score: 0, signals: [], blockers: [BLOCK.peerNotReady], ok: false, self: true };
    }

    var fam = clamp(num(peer.familiarity, FAMILIARITY_BASELINE), 0, 1);
    var aff = clamp(num(peer.affinity, RELATION_NEUTRAL), 0, 1);
    var tru = clamp(num(peer.trust, RELATION_NEUTRAL), 0, 1);
    var hasThread = peer.hasThread === true;
    var lastAt = safeTs(peer.lastDmAt, i.now);
    var now = num(i.now, 0);
    var allowStrangers = i.allowStrangers === true;

    /* ── 陌生人政策（§9）：完全陌生默认**根本不参与打分**。
       注意这不是"分数低所以没过线"，而是"这条候选不存在" ——
       因为前者会在 trace 里表现为一个看起来很接近的分数，
       让人误以为"再高一点就会联系陌生人"。 */
    var known = hasThread || (lastAt !== null) || fam > FAMILIARITY_BASELINE;
    if (!known && !allowStrangers) {
      return { peerId: peerId, score: 0, signals: [], blockers: [BLOCK.noThread], ok: false, stranger: true, familiarity: fam, affinity: aff, trust: tru };
    }
    /* allowStrangers=true 时的陌生人：关系分量为零，只有抖动 —— 也就是
       **几乎不可能**过线。这是刻意的：opt-in 打开的是"允许考虑"，
       而不是"开始刷陌生人"。 */
    var base = 0;
    if (hasThread) { base += SIGNAL_WEIGHTS.existingThread; signals.push(SIGNAL.existingThread); }
    if (fam > FAMILIARITY_BASELINE) {
      base += SIGNAL_WEIGHTS.familiarity * ((fam - FAMILIARITY_BASELINE) / (1 - FAMILIARITY_BASELINE));
      signals.push(SIGNAL.relationshipMaintenance);
    }
    if (aff > RELATION_NEUTRAL) {
      base += SIGNAL_WEIGHTS.affinity * (aff - RELATION_NEUTRAL) * 2;
      signals.push(SIGNAL.positiveAffinity);
    }
    if (tru > RELATION_NEUTRAL) base += SIGNAL_WEIGHTS.trust * (tru - RELATION_NEUTRAL) * 2;
    if (i.hasSharedPast === true && hasThread) { base += SIGNAL_WEIGHTS.sharedPast; signals.push(SIGNAL.sharedPast); }

    /* 时间分级只在**已有 thread 或已有关系**时才有意义：
       从未聊过的人不存在"很久没聊"。 */
    if (lastAt !== null && (hasThread || fam > FAMILIARITY_BASELINE)) {
      var gap = now - lastAt;
      for (var t = 0; t < GAP_TIERS.length; t++) {
        if (gap >= GAP_TIERS[t].ms) {
          base += GAP_TIERS[t].bonus;
          if (signals.indexOf(GAP_TIERS[t].code) < 0) signals.push(GAP_TIERS[t].code);
          break;
        }
      }
      /* 刚聊过：这是负信号。它压分的力度必须**大于**任何单个正信号，
         否则"刚刚才聊完"会被 existing-thread 直接抵掉。 */
      if (gap < 3600000) base -= 0.25;
      else if (gap < 6 * 3600000) base -= 0.09;
    } else if (!hasThread) {
      /* 从没有过 thread：没有"共同过去"可用，扣掉继续话题的余量。 */
      base -= 0.06;
    }

    var jit = jitterFor(str(i.characterId) + '>' + peerId, i.dayBucket, BOUNDED_JITTER_MAX);
    if (jit > 0) signals.push(SIGNAL.jitter);

    score = round4(clamp(base + jit, 0, 1));
    return {
      peerId: peerId,
      score: score,
      base: round4(clamp(base, 0, 1)),
      jitter: round4(jit),
      signals: signals,
      blockers: blockers,
      ok: true,
      stranger: !known,
      familiarity: round4(fam),
      affinity: round4(aff),
      trust: round4(tru),
      hasThread: hasThread,
      lastDmAt: lastAt === null ? 0 : lastAt
    };
  }

  /* ══════════ 6. 候选排名 ═══════════════
     过滤已经在 scorePeer 的 blockers 里表达（不可用 ⇒ ok:false）。
     排序：score 降序 → thread 存在优先 → lastDmAt 更早优先 → **peerId 升序**。
     最后这一条不是装饰：没有它，两个完全同分的候选在不同浏览器里的
     排序会依赖 Object 键顺序，于是"同一输入同一结果"这句话不成立。 */
  function rankPeers(scored) {
    var list = (Array.isArray(scored) ? scored : []).filter(function (s) { return s && s.ok; });
    list.sort(function (a, b) {
      if (b.score !== a.score) return b.score - a.score;
      var at = a.hasThread ? 1 : 0, bt = b.hasThread ? 1 : 0;
      if (bt !== at) return bt - at;
      var al = num(a.lastDmAt, 0), bl = num(b.lastDmAt, 0);
      if (al !== bl) return al - bl;
      return str(a.peerId) < str(b.peerId) ? -1 : (str(a.peerId) > str(b.peerId) ? 1 : 0);
    });
    return list;
  }

  /* ══════════ 7. 主决策 ═══════════════
     state: {
       now, characterId,
       global: {enabled},
       prefs:  {enabled, initiative, dailyLimit, allowStrangers},
       character: {exists, ready, busy},
       peers: [{id, exists, ready, allowRoleDm, busy, archived,
                familiarity, affinity, trust, hasThread, threadState, lastDmAt}],
       budget: {characterUsedToday, globalUsedToday, pairCooldowns:{'a|b':lastTs},
                lastUserActiveAt, quietHours, backoffUntil, characterLimit, globalLimit},
       seed, dayBucket, hasSharedPastFor: ['peerId', ...]
     }
     返回的每个字段都是可解释的；decision 只有 'initiate' 与 'no-action'。 */
  function evaluateSocialIntent(state) {
    var s = (state && typeof state === 'object') ? state : {};
    var now = num(s.now, 0);
    var characterId = str(s.characterId);
    var global = normalizeGlobal(s.global);
    var prefs = normalizeCharacter(s.prefs);
    var ch = s.character || {};
    var budget = s.budget || {};
    var dayBucket = num(s.dayBucket, dayBucketOf(now));
    var threshold = thresholdFor(prefs.initiative);
    var blockers = [];
    var reasonCodes = [];
    var sharedPast = Array.isArray(s.hasSharedPastFor) ? s.hasSharedPastFor.map(str) : [];

    function noAction(code, extra) {
      var out = {
        schemaVersion: SCHEMA_VERSION,
        consumer: 'role_dm_autonomous_intent',
        characterId: characterId,
        evaluatedAt: now,
        dayBucket: dayBucket,
        decision: 'no-action',
        shouldInitiate: false,
        score: 0,
        threshold: threshold,
        peerId: null,
        reasonCode: code,
        reasonCodes: reasonCodes.slice(),
        blockers: blockers.slice(),
        candidateCount: 0,
        quotaState: quotaState()
      };
      if (extra) for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) out[k] = extra[k];
      return out;
    }
    function quotaState() {
      return {
        characterUsedToday: num(budget.characterUsedToday, 0),
        characterLimit: num(budget.characterLimit, prefs.dailyLimit),
        globalUsedToday: num(budget.globalUsedToday, 0),
        globalLimit: num(budget.globalLimit, BUDGET.globalPerDay)
      };
    }

    /* ── 硬闸门，顺序即优先级 ── */
    if (!global.enabled || !prefs.enabled) blockers.push(BLOCK.disabled);
    if (budget.quietHours === true) blockers.push(BLOCK.quietHours);
    var backoffUntil = safeTs(budget.backoffUntil, now);
    if (backoffUntil !== null && backoffUntil > now) blockers.push(BLOCK.backoff);
    var userActiveAt = safeTs(budget.lastUserActiveAt, now);
    if (userActiveAt !== null && (now - userActiveAt) < 600000) blockers.push(BLOCK.userActive);
    if (!ch.exists) blockers.push(BLOCK.peerNotReady);
    if (ch.busy === true) blockers.push(BLOCK.characterBusy);
    if (num(budget.characterUsedToday, 0) >= num(budget.characterLimit, prefs.dailyLimit)) blockers.push(BLOCK.quota);
    if (num(budget.globalUsedToday, 0) >= num(budget.globalLimit, BUDGET.globalPerDay)) blockers.push(BLOCK.quota);
    reasonCodes = blockers.slice();
    if (blockers.length) {
      /* 优先级最高的那条决定 reasonCode。 */
      for (var b = 0; b < BLOCK_PRIORITY.length; b++) {
        if (blockers.indexOf(BLOCK_PRIORITY[b]) >= 0) return noAction(BLOCK_REASON[BLOCK_PRIORITY[b]]);
      }
      return noAction(REASON.noIntent);
    }

    /* ── 候选集 ── */
    var peers = Array.isArray(s.peers) ? s.peers : [];
    var scored = [];
    var peerBlockers = [];
    for (var p = 0; p < peers.length; p++) {
      var peer = peers[p] || {};
      var pid = str(peer.id);
      if (!pid || pid === characterId) continue;                 /* self 排除 */
      if (!peer.exists) { peerBlockers.push(BLOCK.peerNotReady); continue; }
      if (peer.archived === true || peer.threadState === 'archived') { peerBlockers.push(BLOCK.threadArchived); continue; }
      if (peer.allowRoleDm === false) { peerBlockers.push(BLOCK.noThread); continue; }
      if (peer.ready === false) { peerBlockers.push(BLOCK.peerNotReady); continue; }
      if (peer.busy === true) { peerBlockers.push(BLOCK.characterBusy); continue; }
      var cd = pairCooldownRemaining(s, pid, now);
      if (cd > 0) { peerBlockers.push(BLOCK.cooldown); continue; }
      var r = scorePeer({
        characterId: characterId, peer: peer, now: now,
        allowStrangers: prefs.allowStrangers, dayBucket: dayBucket,
        hasSharedPast: sharedPast.indexOf(pid) >= 0
      });
      if (r.ok) scored.push(r); else if (r.blockers && r.blockers.length) peerBlockers.push(r.blockers[0]);
    }
    var ranked = rankPeers(scored);
    var candidateCount = ranked.length;
    if (!candidateCount) {
      for (var pb = 0; pb < peerBlockers.length; pb++) if (reasonCodes.indexOf(peerBlockers[pb]) < 0) reasonCodes.push(peerBlockers[pb]);
      var emptyBlockers = blockers.slice();
      if (peerBlockers.length) emptyBlockers.push(peerBlockers[0]); else emptyBlockers.push(BLOCK.noCandidates);
      blockers = emptyBlockers;
      return noAction(REASON.noCandidates, { candidateCount: 0 });
    }

    /* ── 过线判定 ── */
    var best = ranked[0];
    if (best.score < threshold) {
      /* 差多少必须能被看出来，否则"她今天怎么这么安静"无法回答。 */
      return noAction(REASON.insufficientIntent, {
        candidateCount: candidateCount,
        score: best.score,
        peerId: null,
        nearMiss: { peerId: best.peerId, score: best.score, gap: round4(threshold - best.score) },
        reasonCodes: reasonCodes.concat(best.signals.slice(0, 3), [BLOCK.insufficientIntent])
      });
    }

    /* ── initiate ── */
    return {
      schemaVersion: SCHEMA_VERSION,
      consumer: 'role_dm_autonomous_intent',
      characterId: characterId,
      evaluatedAt: now,
      dayBucket: dayBucket,
      decision: 'initiate',
      shouldInitiate: true,
      score: best.score,
      threshold: threshold,
      peerId: best.peerId,
      /* reasonCode 表达的是"最强的那个理由"，即排名第一的候选的最强信号。
         刻意**不是** "relationship-maintenance 永远优先" 这种写死的偏好 ——
         那样 trace 会掩盖真实原因。 */
      reasonCode: primaryReasonCode(best),
      reasonCodes: reasonCodes.concat(best.signals),
      signals: best.signals.slice(),
      blockers: blockers.slice(),
      candidateCount: candidateCount,
      runnerUp: ranked.length > 1 ? { peerId: ranked[1].peerId, score: ranked[1].score } : null,
      quotaState: quotaState(),
      /** 真正的执行参数：由本层决定，执行层不得自行改轮数。 */
      turns: 2
    };
  }
  /* 最强信号 ⇒ reasonCode。顺序表达"哪个理由更值得被记住"。 */
  var REASON_BY_SIGNAL = [
    [SIGNAL.longTimeNoContact, REASON.longTimeNoContact],
    [SIGNAL.existingThread, REASON.existingThread],
    [SIGNAL.relationshipMaintenance, REASON.relationshipMaintenance],
    [SIGNAL.sharedPast, REASON.relationshipMaintenance],
    [SIGNAL.positiveAffinity, REASON.relationshipMaintenance],
    [SIGNAL.trust, REASON.relationshipMaintenance]
  ];
  function primaryReasonCode(scored) {
    var sigs = (scored && Array.isArray(scored.signals)) ? scored.signals : [];
    for (var i = 0; i < REASON_BY_SIGNAL.length; i++) {
      if (sigs.indexOf(REASON_BY_SIGNAL[i][0]) >= 0) return REASON_BY_SIGNAL[i][1];
    }
    return REASON.existingThread;
  }

  /* ══════════ 8. 每角色的评估频率 gate ═══════════════
     为什么单独一个函数：它是"不要每分钟 × 14 个角色"的唯一实现点。
     调用方（执行层）必须用它，而不是自己比较时间戳。 */
  function evaluationDue(input) {
    var i = input || {};
    var now = num(i.now, 0);
    var last = safeTs(i.lastEvaluatedAt, now);
    if (last === null) return { due: true, reason: 'first-evaluation', nextAt: 0 };
    var next = nextEligibleAt(i.characterId, last, i.salt);
    if (now >= next) return { due: true, reason: 'interval-elapsed', nextAt: next };
    return { due: false, reason: 'too-soon', nextAt: next, remainingMs: next - now };
  }

  return {
    SCHEMA_VERSION: SCHEMA_VERSION,
    BLOCK: BLOCK,
    SIGNAL: SIGNAL,
    REASON: REASON,
    BLOCK_PRIORITY: BLOCK_PRIORITY,
    BUDGET: BUDGET,
    SCHED: SCHED,
    SIGNAL_WEIGHTS: SIGNAL_WEIGHTS,
    THRESHOLD_AT_ZERO: THRESHOLD_AT_ZERO,
    THRESHOLD_AT_ONE: THRESHOLD_AT_ONE,
    DEFAULT_INITIATIVE: DEFAULT_INITIATIVE,
    BOUNDED_JITTER_MAX: BOUNDED_JITTER_MAX,
    FAMILIARITY_BASELINE: FAMILIARITY_BASELINE,
    GAP_TIERS: GAP_TIERS,
    /* 纯函数 */
    hashStr: hashStr,
    jitterFor: jitterFor,
    pairKey: pairKey,
    autonomousPairCooldownMs: autonomousPairCooldownMs,
    dayBucketOf: dayBucketOf,
    safeTs: safeTs,
    thresholdFor: thresholdFor,
    nextEligibleAt: nextEligibleAt,
    normalizeGlobal: normalizeGlobal,
    normalizeCharacter: normalizeCharacter,
    scorePeer: scorePeer,
    rankPeers: rankPeers,
    evaluateSocialIntent: evaluateSocialIntent,
    evaluationDue: evaluationDue,
    pairCooldownRemaining: pairCooldownRemaining
  };
});
