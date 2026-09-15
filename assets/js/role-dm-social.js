/* ====================================================================
   IB Role DM Social Runtime — 角色自主发起私聊的**执行层**
   --------------------------------------------------------------------
   ── 这一层是什么 ─────────────────────────────────────────────────────
   它是"要不要找谁"这个问题在**真实存储**上的落地：
     读偏好 / 读关系 / 读 thread / 读预算 → 交给 role-dm-social-core
     （纯函数）判定 → 判定为 initiate 时才调用 IB.roleDm.startAutonomous。

   三层职责不重叠（§15）：
     · Active Companion 的 _activeTick  → **什么时候**评估（复用，不新建 timer）
     · 本文件 + social-core             → **要不要找谁**
     · role-dm.js                        → **真正聊天**

   ── 三条硬约束 ───────────────────────────────────────────────────────
     1. **评估不花 API**。computeIntent 只做本地读与纯函数打分。整个
        "没有意图"的路径上一次 fetch / callApiChat 都不会发生。这不是
        靠纪律维持的：本文件里唯一会花 API 的调用点在 tryInitiate 里，
        而它唯一的调用者是"判定为 initiate"那一个分支。
     2. **绝不替用户开启**。升级老数据时，缺失的自治偏好一律解释为
        **关闭**（见 social-core.normalizeCharacter 的 === true）。
     3. **可立即停止**。总开关关闭后，本模块**连评估都不再做**（不是
        "评估了但没执行"）—— 一次 tick 里的第一个判断就是它。

   ── kill switch 的语义（记录在案，§23）───────────────────────────────
     关闭 = 不再产生**新的** autonomous run。已经开始的 run **不中断**：
     它会自然走完自己的 2 轮。理由：Role DM 的 abort 语义是"用户按下停止"，
     用它来做配置变更的副作用会留下"聊到一半、原因显示为已停止"的记录，
     而那条记录看起来像用户操作的。一次 2 轮的 run 的成本是有界的，
     静默完成比伪造一次用户中止更诚实。
   ==================================================================== */
(function (NS) {
  'use strict';

  var CORE_SOCIAL = null;
  function core() {
    if (CORE_SOCIAL) return CORE_SOCIAL;
    try { CORE_SOCIAL = window.IBRoleDmSocialCore || null; } catch (e) { CORE_SOCIAL = null; }
    return CORE_SOCIAL;
  }

  /* ── 持久化 key ──────────────────────────────────────────────────────
     两个 key 刻意分开：
       · PREFS —— 用户的选择。**只**在用户操作时写。
       · STATE —— 机器的事实（预算/冷却/退避/上次评估）。随时可丢：
         丢掉的代价只是"今天可能多聊一次"，而不是"设置被重置"。
     把两者合成一个 key 会让"清理运行时状态"变成一件会动用户设置的危险操作。 */
  var KEY_PREFS = 'ib_role_dm_social_prefs_v1';
  var KEY_STATE = 'ib_role_dm_social_state_v1';
  var PREFS_VERSION = 1;
  var STATE_VERSION = 1;

  /* 运行时状态在 localStorage 里的保留上限（防无界增长）。 */
  var KEEP_PAIR = 200;

  /* trace 环（开发态可观测性）。**只**白名单字段，绝不存正文/persona/key。 */
  var TRACE_MAX = 80;
  var _trace = [];
  var _traceSeq = 0;

  /* 每个 tick 内"本会话已处理"的角色集：避免同一 tick 里同一个角色被
     评估两次（理论上不会，但让行为与调用顺序无关更安全）。 */
  var _ticking = false;
  var _charInFlight = {};        /* characterId -> runKey：本会话正在跑的自主 run */
  var _sessionRunSeq = 0;

  function nowMs() { return Date.now(); }
  function str(v) { return v == null ? '' : String(v); }

  function readJSON(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      if (!raw) return fallback;
      var v = JSON.parse(raw);
      return (v && typeof v === 'object') ? v : fallback;
    } catch (e) { return fallback; }
  }
  function writeJSON(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); return true; }
    catch (e) { return false; }
  }
  function uid(prefix) { return prefix + nowMs().toString(36) + '_' + Math.random().toString(36).slice(2, 8); }

  function rd() { try { return NS.roleDm || null; } catch (e) { return null; } }
  function socialCore() { return core(); }
  function apiConfigsLive() {
    try { return (window.apiConfigs || []).slice(); } catch (e) { return []; }
  }
  function archivedConfigsLive() {
    try { return (window.archivedConfigs || []).slice(); } catch (e) { return []; }
  }
  function cfgOfLive(id) {
    var s = str(id), a = apiConfigsLive(), b = archivedConfigsLive(), i;
    for (i = 0; i < a.length; i++) if (str(a[i] && a[i].id) === s) return a[i];
    for (i = 0; i < b.length; i++) if (str(b[i] && b[i].id) === s) return b[i];
    return null;
  }
  function apiReady(cfg) {
    try { if (typeof window._ibApiReady === 'function') return !!window._ibApiReady(cfg); } catch (e) { }
    return false;
  }
  function nameOf(cfg) { return cfg ? str(cfg.nickname || cfg.model || 'AI') : '（角色已删除）'; }

  /* ══════════ 1. 偏好 ═══════════════ */
  function prefsAll() {
    var c = socialCore();
    var raw = readJSON(KEY_PREFS, null);
    var out = { v: PREFS_VERSION, global: { enabled: false }, characters: {} };
    if (!raw) return out;
    out.global = c ? c.normalizeGlobal(raw.global) : { enabled: (raw.global && raw.global.enabled) === true };
    var chars = (raw.characters && typeof raw.characters === 'object') ? raw.characters : {};
    for (var k in chars) {
      if (!Object.prototype.hasOwnProperty.call(chars, k)) continue;
      out.characters[str(k)] = c ? c.normalizeCharacter(chars[k]) : { enabled: false, initiative: 0.35, dailyLimit: 2, allowStrangers: false };
    }
    return out;
  }
  function prefsSave(next) {
    var c = socialCore();
    var cur = prefsAll();
    var g = (next && next.global) ? next.global : cur.global;
    var chars = (next && next.characters) ? next.characters : cur.characters;
    var outChars = {};
    for (var k in chars) {
      if (!Object.prototype.hasOwnProperty.call(chars, k)) continue;
      outChars[str(k)] = c ? c.normalizeCharacter(chars[k]) : chars[k];
    }
    var payload = { v: PREFS_VERSION, global: c ? c.normalizeGlobal(g) : g, characters: outChars, updatedAt: nowMs() };
    writeJSON(KEY_PREFS, payload);
    /* 全局开关同时写进 Role DM 自己的 prefs：Role DM 的 run() 用它做
       最后一道闸门（即使调度层出问题，没有这个开关也起不来 run）。
       反过来说：**这个开关有两个读者，但只有一个写者** —— 就是这里。 */
    try {
      var api = rd();
      if (api && typeof api.setPrefs === 'function') api.setPrefs({ autonomous: payload.global.enabled === true });
    } catch (e) { }
    return prefsAll();
  }
  function characterPrefs(id) {
    var c = socialCore();
    var all = prefsAll();
    var raw = all.characters[str(id)];
    if (raw) return raw;
    return c ? c.normalizeCharacter(null) : { enabled: false, initiative: 0.35, dailyLimit: 2, allowStrangers: false };
  }
  function setGlobalEnabled(on) {
    var all = prefsAll();
    all.global = { enabled: !!on };
    return prefsSave(all).global;
  }
  function setCharacterPrefs(id, patch) {
    var all = prefsAll();
    var cur = characterPrefs(id);
    all.characters[str(id)] = Object.assign({}, cur, patch || {});
    return prefsSave(all).characters[str(id)];
  }
  function isGlobalEnabled() { return prefsAll().global.enabled === true; }

  /* ══════════ 2. 运行时状态（预算 / 冷却 / 退避 / 评估时刻）═══════════ */
  function stateAll() {
    var raw = readJSON(KEY_STATE, null);
    var s = {
      v: STATE_VERSION,
      dayBucket: null,
      usedToday: {},
      globalUsedToday: [],
      pairLastAt: {},
      lastEvaluatedAt: {},
      backoffUntil: {},
      failStreak: {},
      lastUserActiveAt: 0,
      updatedAt: 0
    };
    if (!raw || typeof raw !== 'object') return s;
    s.dayBucket = (typeof raw.dayBucket === 'number') ? raw.dayBucket : null;
    s.usedToday = (raw.usedToday && typeof raw.usedToday === 'object') ? raw.usedToday : {};
    s.globalUsedToday = Array.isArray(raw.globalUsedToday) ? raw.globalUsedToday : [];
    s.pairLastAt = (raw.pairLastAt && typeof raw.pairLastAt === 'object') ? raw.pairLastAt : {};
    s.lastEvaluatedAt = (raw.lastEvaluatedAt && typeof raw.lastEvaluatedAt === 'object') ? raw.lastEvaluatedAt : {};
    s.backoffUntil = (raw.backoffUntil && typeof raw.backoffUntil === 'object') ? raw.backoffUntil : {};
    s.failStreak = (raw.failStreak && typeof raw.failStreak === 'object') ? raw.failStreak : {};
    s.lastUserActiveAt = Number(raw.lastUserActiveAt) || 0;
    s.updatedAt = Number(raw.updatedAt) || 0;
    return s;
  }
  /* 日切换：只保留"当前桶"的计数。
     关键的安全属性 —— 时钟回拨（dayBucket 变小）时计数**不会**被继承，
     而是从零开始；时钟前进则旧桶整体丢弃。两种方向都不会出现
     "把昨天的 6 次算进今天"或"永不清零"。
     代价是：一次剧烈的时钟前跳会重置当日额度 —— 这是可接受的，
     因为 per-pair 冷却由独立的时间戳表控制（不随日桶重置）。 */
  function stateForDay(now) {
    var c = socialCore();
    var s = stateAll();
    var bucket = c ? c.dayBucketOf(now) : Math.floor(Number(now) / 86400000);
    if (s.dayBucket !== bucket) {
      s.dayBucket = bucket;
      s.usedToday = {};
      s.globalUsedToday = [];
    }
    /* 修剪：pair 冷却表与评估时刻表只保留仍然有用的项。 */
    var cutoff = now - 7 * 86400000;
    var pk = Object.keys(s.pairLastAt);
    if (pk.length > KEEP_PAIR) {
      pk.sort(function (a, b) { return (Number(s.pairLastAt[b]) || 0) - (Number(s.pairLastAt[a]) || 0); });
      for (var i = KEEP_PAIR; i < pk.length; i++) delete s.pairLastAt[pk[i]];
    }
    for (var k in s.pairLastAt) {
      if (!Object.prototype.hasOwnProperty.call(s.pairLastAt, k)) continue;
      if ((Number(s.pairLastAt[k]) || 0) < cutoff) delete s.pairLastAt[k];
    }
    for (var e in s.lastEvaluatedAt) {
      if (!Object.prototype.hasOwnProperty.call(s.lastEvaluatedAt, e)) continue;
      if ((Number(s.lastEvaluatedAt[e]) || 0) < now - 7 * 86400000) delete s.lastEvaluatedAt[e];
    }
    return s;
  }
  function stateSave(s) {
    s.updatedAt = nowMs();
    return writeJSON(KEY_STATE, s);
  }
  function noteUserActivity(at) {
    var t = Number(at) || nowMs();
    var s = stateForDay(t);
    /* 只前进，不回退 —— 一次迟到的调用不该把"最近活动"时间改早。 */
    if (t > (Number(s.lastUserActiveAt) || 0)) {
      s.lastUserActiveAt = t;
      stateSave(s);
    }
    return s.lastUserActiveAt;
  }
  function recordInitiation(initiatorId, peerId, at) {
    var t = Number(at) || nowMs();
    var s = stateForDay(t);
    var key = str(initiatorId);
    if (!s.usedToday[key]) s.usedToday[key] = [];
    s.usedToday[key].push(t);
    s.globalUsedToday.push(t);
    s.pairLastAt[socialCore().pairKey(key, peerId)] = t;
    /* 成功发起即清掉退避与失败计数：退避是"provider 挂掉时别继续烧"，
       不是"这个角色今天不许再聊"。 */
    delete s.backoffUntil[key];
    s.failStreak[key] = 0;
    stateSave(s);
    return { usedToday: s.usedToday[key].length, globalUsedToday: s.globalUsedToday.length };
  }
  /* 失败退避：指数增长，上界 24h。
     **绝不**立刻换 peer 重试、也**绝不**在下个 tick 再试一次 ——
     否则 provider 挂掉时，scheduler 会变成一台稳定的失败请求发生器。 */
  function recordFailure(characterId, at) {
    var c = socialCore();
    var t = Number(at) || nowMs();
    var s = stateForDay(t);
    var key = str(characterId);
    var streak = (Number(s.failStreak[key]) || 0) + 1;
    s.failStreak[key] = streak;
    var base = c.BUDGET.failureBackoffMs;
    var backoff = Math.min(base * Math.pow(2, streak - 1), c.BUDGET.failureBackoffMaxMs);
    s.backoffUntil[key] = t + backoff;
    stateSave(s);
    return { failStreak: streak, backoffUntil: s.backoffUntil[key], backoffMs: backoff };
  }
  function backoffRemaining(characterId, now) {
    var s = stateAll();
    var until = Number((s.backoffUntil || {})[str(characterId)]) || 0;
    var n = Number(now) || nowMs();
    return until > n ? (until - n) : 0;
  }

  /* ══════════ 3. trace（开发态可观测性）═══════════════
     白名单字段，**没有** persona / publicProfile / memory / memorandum /
     正文 / API key / prompt 的位置 —— 这是结构性的：下面的 note() 只接受
     显式的几个参数，没有"meta 对象透传"这种通道。 */
  function tracePush(rec) {
    _traceSeq++;
    rec.seq = _traceSeq;
    rec.at = Number(rec.at) || nowMs();
    _trace.push(rec);
    if (_trace.length > TRACE_MAX) _trace.shift();
    /* dev 态打印：只打一行、只打 code。生产控制台里这也是可接受的噪音量
       （一个角色最多每 45 分钟一行）。 */
    try {
      if (rec.decision === 'initiate') {
        console.info('[RoleDM·Social] initiate ' + rec.characterId + ' → ' + rec.peerId + ' · ' + rec.reasonCode);
      }
    } catch (e) { }
    return rec;
  }
  function traceOfCharacter(id, limit) {
    var n = Math.max(1, Number(limit) || 5);
    var s = str(id);
    var out = [];
    for (var i = _trace.length - 1; i >= 0 && out.length < n; i--) {
      if (_trace[i].characterId === s) out.push(_trace[i]);
    }
    return out;
  }
  function traceRecent(n) {
    var k = Math.max(1, Math.min(TRACE_MAX, Number(n) || 20));
    return _trace.slice(-k).reverse();
  }
  /* 分数的**分桶**，不是原值：trace 的目的是回答"她在哪个量级上"，
     不是把她的关系数值抄一份到日志里。 */
  function scoreBucket(score) {
    var v = Number(score) || 0;
    if (v <= 0) return '0';
    if (v < 0.25) return '0-0.25';
    if (v < 0.5) return '0.25-0.5';
    if (v < 0.75) return '0.5-0.75';
    return '0.75-1';
  }

  /* ══════════ 4. 上下文装配（读 canonical 存储，不改写）═══════════════ */
  function quietHoursNow() {
    /* 复用既有唯一实现：apiSettings['bgAi'] 的 sleepStart/sleepEnd。
       绝不新建第二套 quiet hours（§17）。核心不可用时**保守**返回 true：
       "不知道现在能不能吵醒 AI"时，不吵。 */
    try {
      if (typeof _bgInSleepWindow !== 'function' || typeof getBgAiConfig !== 'function') return true;
      var cfg = _bgAiConfigCache;
      return !!_bgInSleepWindow(cfg || {});
    } catch (e) { return true; }
  }
  var _bgAiConfigCache = null;
  async function refreshBgAiConfig() {
    try {
      if (typeof getBgAiConfig === 'function') _bgAiConfigCache = await getBgAiConfig();
    } catch (e) { _bgAiConfigCache = null; }
    return _bgAiConfigCache;
  }

  function threadOf(aId, bId) {
    var api = rd();
    var c = socialCore();
    if (!api || !c) return null;
    try {
      var list = api._threadsAll ? api._threadsAll() : [];
      var fid = (window.IBRoleDmCore || {}).roleDmFriendId
        ? window.IBRoleDmCore.roleDmFriendId(aId, bId)
        : null;
      for (var i = 0; i < list.length; i++) if (list[i].threadId === fid) return list[i];
    } catch (e) { }
    return null;
  }
  /* 是否有"共同过去"可用（§10）。
     **只用现有确定性元数据**，不为 Phase 3 重构 memorandum：
       · thread 里已经有一份非空备忘 → 有共同过去；
       · 或者累计消息数已经够多 → 有共同过去。
     "未完成的共同话题"（unfinished-topic）需要 memorandum 里的结构化标记，
     现在**没有**这个标记，因此本能力**不假装**能识别它 —— 见 §K DEFERRED。
     用消息数近似"聊过不止一次"，是一个诚实的下界，而不是一个猜测。 */
  function hasSharedPast(thread) {
    if (!thread) return false;
    if (thread.threadMemorandum && str(thread.threadMemorandum.text || '').trim()) return true;
    return (Number(thread.messageCount) || 0) >= 4;
  }

  function buildContext(characterId, now, s, prefs, globalPrefs) {
    var c = socialCore();
    var api = rd();
    var peers = [];
    var sharedPastFor = [];
    var list = apiConfigsLive();
    var me = cfgOfLive(characterId);
    for (var i = 0; i < list.length; i++) {
      var cfg = list[i];
      if (!cfg || !cfg.id) continue;
      var pid = str(cfg.id);
      if (pid === str(characterId)) continue;            /* self：core 也会排除，这里早退省一次读 */
      var thread = threadOf(str(characterId), pid);
      var rel = null;
      try { rel = api.relationGet(str(characterId), pid); } catch (e) { rel = null; }
      if (hasSharedPast(thread)) sharedPastFor.push(pid);
      peers.push({
        id: pid,
        exists: true,
        ready: apiReady(cfg),
        /* 角色是否允许参与角色私信：本能力没有 per-character 的"拒收"开关，
           因此这里是"存在即可"。留这个字段是为了让 core 的过滤合同完整，
           将来加拒收时不需要改 core。 */
        allowRoleDm: true,
        busy: false,                                      /* 由 tick 层统一按 _chatSendingFor 标注 */
        archived: false,
        relationship: str(cfg.relationship || ''),
        familiarity: rel ? Number(rel.familiarity) : undefined,
        affinity: rel ? Number(rel.affinity) : undefined,
        trust: rel ? Number(rel.trust) : undefined,
        dmCount: rel ? Number(rel.dmCount) || 0 : 0,
        hasThread: !!thread,
        threadState: thread ? str(thread.state) : '',
        lastDmAt: thread ? (Number(thread.lastMessageAt) || Number(thread.lastRunAt) || 0) : 0
      });
    }
    return {
      now: now,
      characterId: str(characterId),
      global: globalPrefs,
      prefs: prefs,
      character: { exists: !!me, ready: !!me && apiReady(me), busy: false },
      peers: peers,
      hasSharedPastFor: sharedPastFor,
      budget: {
        characterUsedToday: (s.usedToday[str(characterId)] || []).length,
        globalUsedToday: s.globalUsedToday.length,
        characterLimit: prefs.dailyLimit,
        globalLimit: c.BUDGET.globalPerDay,
        pairCooldowns: s.pairLastAt,
        lastUserActiveAt: s.lastUserActiveAt,
        quietHours: quietHoursNow(),
        backoffUntil: Number((s.backoffUntil || {})[str(characterId)]) || 0
      },
      dayBucket: s.dayBucket,
      seed: str(characterId)
    };
  }

  /* ══════════ 5. 只读评估（**零 API**）═══════════════
     这是"她要不要找谁"的唯一计算入口，也是测试可以直接调用的入口：
     它不改任何状态、不调模型、不写存储。 */
  function computeIntent(characterId, opts) {
    var o = opts || {};
    var c = socialCore();
    var api = rd();
    if (!c) return { ok: false, reason: 'core-unavailable' };
    if (!api) return { ok: false, reason: 'runtime-unavailable' };
    var now = Number(o.now) || nowMs();
    var s = stateForDay(now);
    var all = prefsAll();
    var prefs = all.characters[str(characterId)] || c.normalizeCharacter(null);
    var ctx = buildContext(characterId, now, s, prefs, all.global);
    /* 角色正在回复（用户单聊 / Voice / 其它后台任务）⇒ 一律不评估。
       复用既有全局锁，不新造锁表（§18）。 */
    var sending = null;
    try { sending = (typeof _chatSendingFor !== 'undefined') ? _chatSendingFor : null; } catch (e) { sending = null; }
    if (sending && sending.size) ctx.character.busy = true;
    if (sending && sending.has(str(characterId))) ctx.character.busy = true;
    for (var i = 0; i < ctx.peers.length; i++) {
      if (sending && sending.has(ctx.peers[i].id)) ctx.peers[i].busy = true;
    }
    return c.evaluateSocialIntent(ctx);
  }

  /* ══════════ 6. 预算闸门（注入给 role-dm.js 的 canAutonomousRun）══════
     这是 autonomous 与 manual **额度分离**的实现点（§13）：
     manual 用的是 role-dm-core 的 ROLE_DAILY_TURN_MAX(40)/hour(20)，
     autonomous 用的是这里的 2/天/角色 + 6/天/全局 + 6h/pair。
     两层叠加，且 autonomous **不消耗** manual 的额度（它另外记账）。 */
  function autonomousBudgetCheck(aId, bId, now) {
    var c = socialCore();
    if (!c) return { ok: false, reason: 'core-unavailable' };
    var n = Number(now) || nowMs();
    var s = stateForDay(n);
    var all = prefsAll();
    var prefs = all.characters[str(aId)] || c.normalizeCharacter(null);
    if (all.global.enabled !== true) return { ok: false, reason: 'autonomous-disabled', blockedBy: c.BLOCK.disabled };
    if (prefs.enabled !== true) return { ok: false, reason: 'autonomous-disabled', blockedBy: c.BLOCK.disabled };
    var bo = backoffRemaining(aId, n);
    if (bo > 0) return { ok: false, reason: 'autonomous-backoff', blockedBy: c.BLOCK.backoff, remainingMs: bo };
    if ((s.usedToday[str(aId)] || []).length >= prefs.dailyLimit) {
      return { ok: false, reason: 'autonomous-character-cap', blockedBy: c.BLOCK.quota };
    }
    if (s.globalUsedToday.length >= c.BUDGET.globalPerDay) {
      return { ok: false, reason: 'autonomous-global-cap', blockedBy: c.BLOCK.quota };
    }
    /* pair 冷却：同一对角色在自主语义下的 6h+ 窗口。
       它与 manual 的 90 秒冷却**不是**同一个量（见 social-core 的注释）：
       那一个防连点，这一个防"后台自己反复烧 API"。 */
    var rem = c.pairCooldownRemaining({ characterId: str(aId), budget: { pairCooldowns: s.pairLastAt } }, str(bId), n);
    if (rem > 0) return { ok: false, reason: 'autonomous-pair-cooldown', blockedBy: c.BLOCK.cooldown, remainingMs: rem };
    if (quietHoursNow()) return { ok: false, reason: 'quiet-hours', blockedBy: c.BLOCK.quietHours };
    return { ok: true };
  }

  /* ══════════ 7. 真正发起（唯一会花 API 的路径）═══════════════ */
  /* 守卫拒绝 ⇒ reasonCode 用**判定性质**的 code，而不是守卫自己的名字。
     守卫名字（pair-cooldown / character-busy / thread-archived…）属于
     Role DM 的词表，不是本层的 reasonCode 词表；把它写进 reasonCode
     会让"reasonCode 落在有限词表内"这条契约失效。名字本身不丢 ——
     它进 blockedBy。 */
  function reasonCodeForGuard(reason) {
    var c = socialCore();
    var r = str(reason);
    if (r === 'pair-cooldown' || r === 'autonomous-pair-cooldown') return c.REASON.cooldown;
    if (r === 'character-busy' || r === 'thread-busy') return c.REASON.busy;
    if (r === 'quiet-hours') return c.REASON.quietHours;
    if (r === 'autonomous-disabled') return c.REASON.disabled;
    if (r === 'autonomous-backoff') return c.REASON.backoff;
    if (r === 'autonomous-character-cap' || r === 'autonomous-global-cap' || r === 'role-daily-cap') return c.REASON.quota;
    if (r === 'thread-archived' || r === 'missing-character') return c.REASON.noCandidates;
    return c.REASON.noIntent;
  }
  async function tryInitiate(decision, now) {
    var api = rd();
    var c = socialCore();
    var initiatorId = str(decision.characterId);
    var peerId = str(decision.peerId);
    if (!initiatorId || !peerId) return { ok: false, reason: 'bad-decision' };

    /* ① 最后一次闸门：canonical API 自己那一套守卫（含全局 kill switch、
       thread 归档、共享轮次额度）。**即使**上面的判定已经检查过，
       这里也必须再问一次 —— 上面到这里有 await，世界可能已经变了。
       被它挡住时**不记账**：什么都没发生，占一次自主额度会让用户看到
       "今天已经主动聊了 2 次"而实际上一次都没聊成。 */
    var can = api.canAutonomousRun(initiatorId, peerId, now);
    if (!can || can.ok !== true) {
      var canReason = str((can && can.reason) || 'not-permitted');
      return audit(decision, now, { initiated: false, blockedBy: canReason, reasonCode: reasonCodeForGuard(canReason) });
    }
    /* ② 本会话级 per-character 在跑检查（另一层兜底：两个标签页各自有
       _chatSendingFor，所以需要 pair 冷却 + 这里）。同样不记账。 */
    if (_charInFlight[initiatorId] || _charInFlight[peerId]) {
      return audit(decision, now, { initiated: false, blockedBy: c.BLOCK.characterBusy, reasonCode: reasonCodeForGuard(c.BLOCK.characterBusy) });
    }
    var runKey = 'autodm_' + (++_sessionRunSeq);
    _charInFlight[initiatorId] = runKey;
    _charInFlight[peerId] = runKey;
    var res = null;
    try {
      res = await api.startAutonomous(initiatorId, peerId, {
        turns: Number(decision.turns) || 2,
        /* 发起人**显式传**：Role DM 不接受"猜谁主动"（见 startAutonomous）。 */
        initiatorId: initiatorId,
        /* 社会理由：**只有** code 进 prompt（role-dm.js 侧再收敛一次）。
           字段名是 initiationSignal 而不是 signal —— `signal` 在
           Role DM 里已经被"中止信号"占用，两者语义无关。 */
        initiationSignal: { reasonCode: String(decision.reasonCode || '') }
      });
    } catch (err) {
      res = { ok: false, reason: 'run-threw', error: str((err && err.message) || err).slice(0, 160) };
    } finally {
      delete _charInFlight[initiatorId];
      delete _charInFlight[peerId];
    }
    /* ③ 记账：**这次真的聊起来了才记**（res.ok === true，即 turns > 0）。
       两个半真的失败必须被排除：
         · 被守卫拒绝（上面两处 early return）—— 什么都没发生，不记账；
         · 发起于守卫之后但**一轮都没说成**（stopReason=provider-failed /
           output-truncated / empty-output / duplicate-stall / bad-message）
           —— 账面上"她主动聊过一次"是假的。
       为什么这不会变成烧 API 的循环：真正花掉调用的那种失败会被
       ④ 的失败退避挡住（该角色 ≥4h 不再被评估），而不是靠额度。
       顺带一个真实后果：额度因此与"用户能看到的那次主动私聊"逐条对应，
       这比"额度是尝试次数"更容易解释，也不会出现"今天额度用完了但一条
       消息都没有"的困惑。
       为什么仍然放在**发起之后**：recordInitiation 会写下这一对的 pair
       时间戳，而 startAutonomous 的 canonical 闸门读的正是同一个表 ——
       先记后发会变成一次自我否决（表现为一个看起来完全合理的
       autonomous-pair-cooldown）。 */
    var runSucceeded = !!res && res.ok === true;
    if (runSucceeded) recordInitiation(initiatorId, peerId, now);
    /* ④ 失败退避（§28）。守卫类失败（thread-busy / character-busy /
       pair-cooldown）不是 provider 故障，退避它们只会让下一次可能的成功
       被推迟。 */
    var failed = !runSucceeded;
    if (failed) {
      var reason = str((res && res.reason) || 'unknown');
      var providerFailedCode = 'provider-failed';
      /* 输出类失败（Phase 3.1）：run 发起了、**请求也成功了**，只是没拿到
         可用正文。它们与 providerFailed 同属"发出去之后没成"这一类，
         因此在 trace 里也各自是一个**真实**的 code（词表见 social-core）。 */
      var outputFailCodes = ['output-truncated', 'empty-output'];
      try {
        var dmCore = window.IBRoleDmCore;
        if (dmCore && dmCore.REASON) {
          if (dmCore.REASON.providerFailed) providerFailedCode = String(dmCore.REASON.providerFailed);
          if (dmCore.REASON.outputTruncated) outputFailCodes[0] = String(dmCore.REASON.outputTruncated);
          if (dmCore.REASON.emptyOutput) outputFailCodes[1] = String(dmCore.REASON.emptyOutput);
        }
      } catch (e) { }
      var isOutputFail = outputFailCodes.indexOf(reason) >= 0;
      /* 退避的对象是"**真的花掉了调用**的失败"。输出类失败同样花掉了调用
         （一级预算 + 一次有界重试），而且它的成因（思考把输出上限吃满）
         不会因为马上再试一次就消失 —— 不退避等于给自主调度留了一条
         隐性 token runaway 的路，而那正是 Phase 3 §6 要挡住的东西。 */
      if (reason === providerFailedCode || reason === 'provider-failed' || reason === 'run-threw' || isOutputFail) {
        recordFailure(initiatorId, now);
      }
      var failedRec = res || {};
      return audit(decision, now, {
        initiated: false,
        /* blockedBy 与 reasonCode 刻意分开：
           blockedBy = **为什么这次没成**（守卫 reason 或 run 的停止原因，
             例如 pair-cooldown）—— 诊断字段，值域开放；
           reasonCode = **这次判定的性质**（一个 REASON 词表里的 code）。
           把任意的停止原因写进 reasonCode 会让"reasonCode 落在有限词表内"
           这条契约失效 —— 而那条契约正是以后做统计的依据。因此输出类失败
           不是"把开放值域塞进来"，而是先成为**词表成员**
           （social-core REASON 的 output-truncated / empty-output，与
           role-dm-core 逐字同码）之后才被用在这里：一次事实只有一个名字。 */
        blockedBy: reason,
        reasonCode: isOutputFail
          ? reason
          : ((c && c.REASON && c.REASON.providerFailed) ? c.REASON.providerFailed : 'provider-failed'),
        runId: str(failedRec.runId || ''),
        /* 字段名必须是 run 结果的**对外**字段名 turns。
           这里一度写成 turnsDone（run 内部局部变量的名字，不在返回对象里）
           → 每条 trace 的轮数恒为 0，而且没有任何断言会红：一个恒为常量
           的观测字段，比缺这个字段更坏。 */
        turns: Number(failedRec.turns) || 0,
        stopReason: str(failedRec.stopReason || reason)
      });
    }
    return audit(decision, now, {
      initiated: true,
      runId: str(res.runId || ''),
      turns: Number(res.turns) || 0,
      stopReason: str(res.stopReason || ''),
      firstSpeakerId: str(res.firstSpeakerId || '')
    });
  }
  /* 观察记录：把判定 + 结果合成一条有界、无正文的 trace 行。 */
  function audit(decision, now, result) {
    var rec = {
      consumer: 'role_dm_autonomous_intent',
      characterId: str(decision.characterId),
      evaluatedAt: Number(now) || nowMs(),
      candidateCount: Number(decision.candidateCount) || 0,
      decision: result && result.initiated ? 'initiate' : 'no-action',
      reasonCode: str((result && result.reasonCode) || decision.reasonCode || 'no-intent'),
      scoreBucket: scoreBucket(decision.score),
      peerId: result && result.initiated ? str(decision.peerId) : '',   /* peerId 只在真正发起时记录 */
      blockedBy: str((result && result.blockedBy) || ''),
      /* 额度状态用**粗粒度**（够不够），不抄具体计数：trace 的读者需要知道
         "是不是额度卡住了"，不需要知道"她今天用了几次"。 */
      quota: {
        characterRoom: (decision.quotaState && decision.quotaState.characterUsedToday < decision.quotaState.characterLimit) ? 'room' : 'full',
        globalRoom: (decision.quotaState && decision.quotaState.globalUsedToday < decision.quotaState.globalLimit) ? 'room' : 'full'
      },
      threshold: Number(decision.threshold) || 0,
      runId: str((result && result.runId) || ''),
      turns: Number((result && result.turns) || 0),
      stopReason: str((result && result.stopReason) || ''),
      at: Number(now) || nowMs()
    };
    return tracePush(rec);
  }
  /* 纯 no-action 的判定也进 trace —— 否则"她为什么一直没动"无法回答。 */
  function auditNoAction(decision, now) {
    return tracePush({
      consumer: 'role_dm_autonomous_intent',
      characterId: str(decision.characterId),
      evaluatedAt: Number(now) || nowMs(),
      candidateCount: Number(decision.candidateCount) || 0,
      decision: 'no-action',
      reasonCode: str(decision.reasonCode || 'no-intent'),
      scoreBucket: scoreBucket(decision.score),
      peerId: '',
      blockedBy: (decision.blockers && decision.blockers[0]) ? str(decision.blockers[0]) : '',
      quota: {
        characterRoom: (decision.quotaState && decision.quotaState.characterUsedToday < decision.quotaState.characterLimit) ? 'room' : 'full',
        globalRoom: (decision.quotaState && decision.quotaState.globalUsedToday < decision.quotaState.globalLimit) ? 'room' : 'full'
      },
      threshold: Number(decision.threshold) || 0,
      at: Number(now) || nowMs()
    });
  }

  /* ══════════ 8. tick（挂在既有 _activeTick 上）═══════════════
     调度分工刻意清楚：
       · _activeTick 决定**何时**调用本函数（30s，且已经在 quiet hours 里让路）；
       · 本函数自己再设一道 globalGateMs 的门 —— 因为 30s × 14 角色 × 完整
         候选集这件事本来就不该发生（§16）。gate 之后，每个角色还要过
         自己的 45~90 分钟评估间隔。
     因此稳态下绝大多数 tick 连一次存储读都不做就返回。 */
  var _lastGateAt = 0;
  var _gateChecked = false;      /* 本会话是否已经成功评估过一次（第一次不等 gate） */

  async function tick(opts) {
    var o = opts || {};
    var c = socialCore();
    var api = rd();
    if (!c || !api) return { ok: false, reason: 'not-ready' };
    if (_ticking) return { ok: false, reason: 'tick-reentrant' };
    var now = Number(o.now) || nowMs();
    /* ① **总开关是第一个判断**。关闭时连评估都不发生（不是"评估了但没做"）。 */
    var all = prefsAll();
    if (all.global.enabled !== true) return { ok: false, reason: 'disabled' };
    /* ② 频率 gate。force 只给测试/探针用。 */
    if (o.force !== true && _gateChecked && (now - _lastGateAt) < c.SCHED.globalGateMs) {
      return { ok: false, reason: 'frequency-gate', nextAt: _lastGateAt + c.SCHED.globalGateMs };
    }
    _ticking = true;
    _lastGateAt = now;
    _gateChecked = true;
    var out = { ok: true, evaluated: 0, attempted: 0, initiated: 0, decisions: [] };
    try {
      await refreshBgAiConfig();
      /* quiet hours：hibernate 期间**角色私信一概不发生**（复用时段的唯一实现）。
         注意这里刻意放在"评估之前"——quiet hours 内不评估，也就不留 trace，
         于是 trace 里不会出现一堆同样的 quiet-hours 记录把真正的决定挤掉。 */
      if (quietHoursNow()) { out.reason = 'quiet-hours'; return out; }
      var s = stateForDay(now);
      var chars = apiConfigsLive();
      for (var i = 0; i < chars.length; i++) {
        var cfg = chars[i];
        if (!cfg || !cfg.id) continue;
        var cid = str(cfg.id);
        var prefs = all.characters[cid];
        /* 未显式开启的角色：**连评估都不做**。这是"默认 OFF 不烧任何东西"
           的最强形式 —— 不只是不发起，而是不计算。 */
        if (!prefs || prefs.enabled !== true) continue;
        if (!apiReady(cfg)) continue;
        /* 每角色评估频率 gate（45~90 分钟，确定性抖动）。 */
        var due = c.evaluationDue({ characterId: cid, now: now, lastEvaluatedAt: s.lastEvaluatedAt[cid], salt: 'roledm' });
        if (o.force !== true && !due.due) continue;
        /* 记录评估时刻是**状态修改**，但它是本模块自己的调度状态，
           不是 canonical 数据 —— 写它不需要问任何人。 */
        s.lastEvaluatedAt[cid] = now;
        stateSave(s);
        out.evaluated++;
        var decision = computeIntent(cid, { now: now });
        if (!decision || decision.ok === false) { out.decisions.push({ characterId: cid, decision: 'error', reason: decision && decision.reason }); continue; }
        if (decision.decision !== 'initiate') {
          auditNoAction(decision, now);
          out.decisions.push({ characterId: cid, decision: 'no-action', reasonCode: decision.reasonCode, candidateCount: decision.candidateCount, score: decision.score });
          continue;
        }
        out.attempted++;
        var r = await tryInitiate(decision, now);
        if (r && r.decision === 'initiate') out.initiated++;
        out.decisions.push({ characterId: cid, decision: r && r.decision, peerId: str(decision.peerId), reasonCode: decision.reasonCode, score: decision.score, blockedBy: r && r.blockedBy });
        /* 一轮 tick 里最多发起一次：第二个角色若也想找人，让它留到下一次
           评估。这既让"谁先"变得确定，也避免同一时刻冒出多段私聊。 */
        break;
      }
    } finally {
      _ticking = false;
    }
    return out;
  }

  /* ══════════ 9. UI 事件的用户活动标记 ═══════════════
     role-dm-ui.js 的 roleDmEmit 是 UI 层唯一的既有钩子。**包装**它而不是
     改动 UI 文件：本能力不该让显示层知道自己被观测。 */
  function wrapEmit() {
    try {
      var prev = NS.roleDmEmit;
      if (typeof prev !== 'function' || prev.__roledmSocialWrapped) return;
      var wrapped = function (kind, payload) {
        try { if (kind === 'run' || kind === 'turn') noteUserActivity(nowMs()); } catch (e) { }
        return prev.apply(this, arguments);
      };
      wrapped.__roledmSocialWrapped = true;
      NS.roleDmEmit = wrapped;
    } catch (e) { }
  }

  /* ══════════ 10. 对外 ═══════════════ */
  var API = {
    /* 偏好 */
    prefs: prefsAll,
    characterPrefs: characterPrefs,
    setGlobalEnabled: setGlobalEnabled,
    setCharacterPrefs: setCharacterPrefs,
    isGlobalEnabled: isGlobalEnabled,
    /* 判定（只读，零 API） */
    computeIntent: computeIntent,
    /* 预算 */
    autonomousBudgetCheck: autonomousBudgetCheck,
    backoffRemaining: backoffRemaining,
    /* 执行 */
    tick: tick,
    noteUserActivity: noteUserActivity,
    /* 清掉"用户最近活动"时间戳。存在的理由是**真实**的：
       它让"避让窗口"可以在不操纵系统时钟的前提下被验证。
       否则每个涉及意图的用例都必须先等 10 分钟，或者去 mock Date.now ——
       后者会让整套测试（含 7 天 soak）跑在一个假时钟上而失去意义。
       `at` 必须可注入：模拟时间下的调用方（假时间 soak / 测试）传的是
       它们自己的 now，用真实 Date.now() 会把状态写进**另一个日桶**。 */
    clearUserActivity: function (at) {
      var s = stateForDay(Number(at) || nowMs());
      s.lastUserActiveAt = 0;
      stateSave(s);
      return true;
    },
    /* 状态（诊断 / 测试） */
    _state: stateAll,
    _recordInitiation: recordInitiation,
    _recordFailure: recordFailure,
    /* 清掉**跨 run** 的预算记忆（额度 / pair 冷却 / 退避），但保留"上次评估时刻"。
       存在的理由：`_resetState` 只换日桶，而过期的 pair 冷却**仍然留在表里**
       （它们按设计要活过日切），于是任何"从零开始观察稀疏性"的模拟都会被上一次
       真实 run 的冷却污染 —— soak 会因此 0 次发起，让"大多数 tick 无动作"变成
       一个空洞的结论而不是证据。 */
    _dropCrossRunState: function (at) {
      var s = stateForDay(Number(at) || nowMs());
      s.usedToday = {};
      s.globalUsedToday = [];
      s.pairLastAt = {};
      s.backoffUntil = {};
      s.failStreak = {};
      s.lastUserActiveAt = 0;
      stateSave(s);
      _lastGateAt = 0;
      _gateChecked = false;
      return true;
    },
    _resetState: function () { writeJSON(KEY_STATE, { v: STATE_VERSION, dayBucket: null }); _lastGateAt = 0; _gateChecked = false; return true; },
    _resetAll: function () { writeJSON(KEY_STATE, { v: STATE_VERSION, dayBucket: null }); writeJSON(KEY_PREFS, { v: PREFS_VERSION, global: { enabled: false }, characters: {} }); _lastGateAt = 0; _gateChecked = false; _trace.length = 0; _charInFlight = {}; return true; },
    _trace: traceRecent,
    _traceOfCharacter: traceOfCharacter,
    _scoreBucket: scoreBucket,
    _keys: { prefs: KEY_PREFS, state: KEY_STATE },
    _charInFlight: function () { return Object.keys(_charInFlight).slice(); }
  };
  NS.roleDmSocial = API;
  NS.expose('roleDmSocial', API);
  /* window 兼容别名：scheduler（active-diary.js）用函数名直接调，与
     _roleLettersTick / _momentsTick 同款约定。 */
  window._roleDmSocialTick = function () { return tick({}); };
  window.IBRoleDmSocial = API;

  /* 把自主预算判定注入 Role DM 的 canonical 入口（单向依赖：Social → Role DM）。 */
  try {
    var api = rd();
    if (api && typeof api.setAutonomousBudgetChecker === 'function') {
      api.setAutonomousBudgetChecker(function (aId, bId, now) { return autonomousBudgetCheck(aId, bId, now); });
    }
  } catch (e) { }
  wrapEmit();
})(window.IB || (window.IB = {}));
