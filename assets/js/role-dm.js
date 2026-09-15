/* ====================================================================
   IB Role DM Runtime — 角色私信（Inter-Character Direct Messaging）执行域
   --------------------------------------------------------------------
   ── 这一层是什么 ─────────────────────────────────────────────────────
   它是**角色 A 与角色 B 之间一对一会话**的运行时。它不是一个新 runtime：
   两边的每一次发言都走既有 canonical AI execution seam
   （`callApiChat` / `callApiChatStream`，见 communication.js:4484/4562），
   各自绑定**各自角色**的 provider/model/endpoint 配置，各自拿一个
   **宿主回合**（`_ibTurnScope` → 工具执行周期 → 上下文预算），各自经
   各自角色的 Middle Brain（Character Integrity Guard + trace）。

   A 的发言必须是 A 的模型调用；B 的回复必须是 B 的模型调用。
   本文件里**没有任何地方**让一个模型扮演两个人，也没有"生成 10 轮剧本"
   这种一次性多轮生成 —— 那是剧本，不是私信。

   ── 挂在哪一层（为什么不另造一套 runtime）────────────────────────────
     · 会话身份      → assets/js/chat-core.js 的既有 conversation 键
                       （friendId = roledm_<token> ⇒ conversationId = dm:roledm_<token>）
     · 消息持久化    → 既有 chatMessages 存储（扩展既有 message representation）
     · 模型执行      → 既有 callApiChat*（唯一 seam）
     · 回合/周期/预算 → 既有 _ibTurnScope / _ibTurnLc / IBFC 周期 / planParts 预算
     · 人格闸门      → 既有 IB.middleBrain.middleBrainFinalizeReply
     · 对象/内容生成 → 既有 buildSiteContext / amBuildInject / getMemoryContext
     · 记忆边界      → 既有 memories（episodic）→ 既有 Memory Consolidation
     · 循环/quota    → 既有 reply-chain-core 的 LIMITS 语义 + 本域三个预算
   本文件只补"角色之间"这一维：canonical thread 身份、双角色 context 组装、
   run 守卫、directional 关系观测。其余一律复用。

   ── 硬边界（本域刻意**不**做的事）────────────────────────────────────
     · 不写 Moments（DM ≠ 朋友圈）
     · 不写用户单聊的任何 thread
     · 不执行任何副作用标签（ws_* / mem_* / cal_note / blog_read 一律不解析）
     · 不把 DM 原文写进长期记忆（只写有界 episodic 候选，交既有 consolidation）
     · 不在 UI 层调度（UI 只调用本模块暴露的 canonical 入口）
     · 不用一个模型生成整段对话
   ==================================================================== */
(function (NS) {
  'use strict';

  var CORE = (typeof window !== 'undefined' && window.IBRoleDmCore) || null;
  var PROFILE_CORE = (typeof window !== 'undefined' && window.IBPublicProfileCore) || null;
  /* 本 run 里"真正交给模型"的历史条数上限。角色私信是**会话**而不是检索：
     模型必须看见刚说过的话，因此这里不接 planParts 的可压缩阶梯（那会允许
     裁剪当前对话本身）。作为代价，可压缩块全部使用**固定小上限**：
       · 共享历史       ≤ 12 条
       · memory         ≤ 900 字符（单聊默认是 memSettings.budget）
       · understanding  ≤ 300 字符（与 _IB_BUDGET_CAP_TOKENS.understanding 同值）
       · 站点上下文     由 buildSiteContext 自身的既有上限决定
       · Auto Memory    由本角色 cfg.autoMemBudget 决定
     因此一次角色私信回合的输入远低于 APP_CEILING_TOKENS(64000)，不可能超预算。 */
  var HISTORY_LIMIT = 12;
  var MEMORY_CHAR_CAP = 900;
  var UNDERSTANDING_CHAR_CAP = 300;

  /* ── 持久化命名空间 ────────────────────────────────────────────────
     消息历史在 canonical chatMessages（Home Node 权威 / IndexedDB 镜像）。
     下面两个 key 只存**索引与有界状态**，不存正文：
       · threads  —— canonical thread 记录（participants/createdAt/lastMessageAt/state…）
       · relations —— directional 关系状态（A→B 与 B→A 各自一条）
       · ledger   —— 每角色的轮次时间戳（时/日两级 quota）
       · runs     —— 每 thread 的最近一次 run 结果（停止原因，供 UI 如实展示）
     为什么不用新的 IndexedDB object store：本仓库的既有决策是"数据模型向后
     兼容优先，不轻易升 DB_VER"，而新增 store 会强制升版并牵动多处硬编码
     断言（tests/test_chat_core_contract.js 等）。索引是可从 chatMessages
     重建的**派生数据**（rebuildThreadIndex），因此放在有版本号的私有
     localStorage key 里既不越权也不丢真相：真相始终是消息行本身。
     正文与 provenance 一律写在 canonical 存储（chatMessages / memories）。 */
  var KEY_THREADS = 'ib_role_dm_threads_v1';
  var KEY_RELATIONS = 'ib_role_dm_relations_v1';
  var KEY_LEDGER = 'ib_role_dm_ledger_v1';
  var KEY_PREFS = 'ib_role_dm_prefs_v1';
  var INDEX_VERSION = 1;

  /* ── 运行期锁（本标签页内；跨标签页由 pair cooldown + ledger 兜底）── */
  var _runningThreads = {};   /* friendId -> runId */
  var _running = false;

  /* ══════════ 小工具 ═══════════════ */
  function core() {
    if (CORE) return CORE;
    try { CORE = window.IBRoleDmCore; } catch (e) { CORE = null; }
    return CORE;
  }
  /* 「角色公开认知层」唯一实现（assets/js/public-profile-core.js）。
     与 core() 同款延迟解析 —— 本文件不得在加载期就对另一个脚本求值。 */
  function profileCore() {
    if (PROFILE_CORE) return PROFILE_CORE;
    try { PROFILE_CORE = window.IBPublicProfileCore; } catch (e) { PROFILE_CORE = null; }
    return PROFILE_CORE;
  }
  function apiConfigsLive() {
    try { return window.apiConfigs || []; } catch (e) { return []; }
  }
  function archivedConfigsLive() {
    try { return window.archivedConfigs || []; } catch (e) { return []; }
  }
  function cfgOf(id) {
    var s = String(id);
    var a = apiConfigsLive(), b = archivedConfigsLive();
    for (var i = 0; i < a.length; i++) if (String(a[i] && a[i].id) === s) return a[i];
    for (var j = 0; j < b.length; j++) if (String(b[j] && b[j].id) === s) return b[j];
    return null;
  }
  function nameOf(cfg) {
    if (!cfg) return '（角色已删除）';
    return cfg.nickname || cfg.model || 'AI';
  }
  function apiReady(cfg) {
    try { if (typeof window._ibApiReady === 'function') return !!window._ibApiReady(cfg); } catch (e) { }
    return false;
  }
  function apiHasCredential(cfg) {
    try { if (typeof window._ibApiHasCredential === 'function') return !!window._ibApiHasCredential(cfg); } catch (e) { }
    return true;
  }
  function nowMs() { return Date.now(); }
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
  /* 用户可控 metadata 进入 prompt 的**唯一**消毒实现（与群聊同一个核心）。
     签名必须与 canonical 核心一致。canonical 的
     `sanitizePromptInput(value, options)` 返回的是**对象**
     `{value, changed, findings, reason, ...}`（见 prompt-boundary-core.js §6），
     而 communication.js:1416-1418 的既有读法正是 `r.value`。
     本函数曾经写成 `typeof out === 'string'` —— 在 canonical 对象上永远为
     false，于是生产里 canonical 消毒**一次都没有生效过**，实际一直跑的是
     下面那个更弱的本地兜底（它不处理零宽/双向控制字符，也不报告 findings）。
     单测没抓到，是因为 mock 注入的假实现恰好返回字符串（正是本函数注释里
     警告过的"因为注入了假实现而全绿"）。两种形状都必须接受。 */
  function sanitizeInput(v, options) {
    try {
      var core = window.IBPromptBoundaryCore;
      if (core && typeof core.sanitizePromptInput === 'function') {
        var out = core.sanitizePromptInput(v, (options && typeof options === 'object') ? options : {});
        if (typeof out === 'string') return out;
        if (out && typeof out.value === 'string') return out.value;
      }
    } catch (e) { }
    return String(v == null ? '' : v).replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  }
  function sanitizeName(v) {
    return sanitizeInput(v).slice(0, 60);
  }

  /* ══════════ 索引：threads ═══════════════ */
  function threadsAll() {
    var v = readJSON(KEY_THREADS, null);
    var out = [];
    if (!v || Number(v.v) !== INDEX_VERSION || !v.items || typeof v.items !== 'object') return out;
    for (var k in v.items) {
      if (!Object.prototype.hasOwnProperty.call(v.items, k)) continue;
      var rec = core() ? core().normalizeThreadRecord(v.items[k]) : null;
      if (rec) out.push(rec);
    }
    out.sort(function (a, b) { return (Number(b.lastMessageAt) || Number(b.createdAt) || 0) - (Number(a.lastMessageAt) || Number(a.createdAt) || 0); });
    return out;
  }
  function threadsSave(list) {
    var items = {};
    for (var i = 0; i < list.length; i++) items[list[i].threadId] = list[i];
    return writeJSON(KEY_THREADS, { v: INDEX_VERSION, items: items, updatedAt: nowMs() });
  }
  function threadSave(rec) {
    if (!rec || !core()) return false;
    var norm = core().normalizeThreadRecord(rec);
    if (!norm) return false;
    var v = readJSON(KEY_THREADS, null);
    var items = (v && Number(v.v) === INDEX_VERSION && v.items && typeof v.items === 'object') ? v.items : {};
    items[norm.threadId] = norm;
    return writeJSON(KEY_THREADS, { v: INDEX_VERSION, items: items, updatedAt: nowMs() });
  }
  function threadGet(friendId) {
    var list = threadsAll();
    for (var i = 0; i < list.length; i++) if (list[i].threadId === String(friendId)) return list[i];
    return null;
  }

  /* ══════════ 索引：relations（directional）═══════════════ */
  function relationsAll() {
    var v = readJSON(KEY_RELATIONS, null);
    var out = {};
    if (!v || Number(v.v) !== INDEX_VERSION || !v.items || typeof v.items !== 'object') return out;
    for (var k in v.items) {
      if (!Object.prototype.hasOwnProperty.call(v.items, k)) continue;
      var rec = core() ? core().normalizeRelationRecord(v.items[k]) : null;
      if (rec) out[rec.relationKey] = rec;
    }
    return out;
  }
  function relationGetRaw(fromId, toId) {
    var key = core() ? core().relationKey(fromId, toId) : '';
    if (!key) return null;
    var all = relationsAll();
    return all[key] || null;
  }
  /* 读（缺省即"尚无任何来往"的初值；**绝不**用 pair hash 假装已有关系）。 */
  function relationGet(fromId, toId) {
    var rec = relationGetRaw(fromId, toId);
    if (rec) return rec;
    return core() ? core().buildRelationRecord(fromId, toId, { now: nowMs() }) : null;
  }
  function relationSave(rec) {
    if (!rec || !core()) return false;
    var norm = core().normalizeRelationRecord(rec);
    if (!norm) return false;
    var v = readJSON(KEY_RELATIONS, null);
    var items = (v && Number(v.v) === INDEX_VERSION && v.items && typeof v.items === 'object') ? v.items : {};
    items[norm.relationKey] = norm;
    return writeJSON(KEY_RELATIONS, { v: INDEX_VERSION, items: items, updatedAt: nowMs() });
  }

  /* ══════════ 索引：轮次账本（quota）═══════════════ */
  function ledgerAll() { return readJSON(KEY_LEDGER, {}); }
  function roleTurnTimes(roleId) {
    var led = ledgerAll();
    var arr = led[String(roleId)];
    return Array.isArray(arr) ? arr.filter(function (t) { return Number(t) > 0; }) : [];
  }
  function roleTurnRecord(roleId, at) {
    var led = ledgerAll();
    var key = String(roleId);
    var arr = Array.isArray(led[key]) ? led[key].filter(function (t) { return Number(t) > 0 && (Number(at) - Number(t)) <= 86400000; }) : [];
    arr.push(Number(at) || nowMs());
    led[key] = arr.slice(-200);
    writeJSON(KEY_LEDGER, led);
  }
  function roleTurnDrop(roleId, at) {
    var led = ledgerAll();
    var key = String(roleId);
    var arr = Array.isArray(led[key]) ? led[key].slice() : [];
    var i = arr.lastIndexOf(Number(at));
    if (i >= 0) arr.splice(i, 1);
    led[key] = arr;
    writeJSON(KEY_LEDGER, led);
  }

  /* ══════════ 偏好 ═══════════════ */
  /* 默认**开启**：这是本轮新增的正式能力，用户入口就是"让她们聊一会儿"。
     自动调度（autonomous）默认**关闭** —— 本轮不开启全自动 scheduler。 */
  function prefs() {
    var d = { enabled: true, autonomous: false };
    var raw = readJSON(KEY_PREFS, null);
    if (raw && typeof raw === 'object') {
      if (raw.enabled !== undefined) d.enabled = raw.enabled !== false;
      if (raw.autonomous !== undefined) d.autonomous = raw.autonomous === true;
    }
    return d;
  }
  function setPrefs(patch) {
    var cur = prefs();
    var next = Object.assign({}, cur, patch || {});
    writeJSON(KEY_PREFS, next);
    return next;
  }

  /* ══════════ thread 解析与创建 ═══════════════ */
  /* 同一对角色**只**对应一个 canonical DM identity —— 与 A/B 顺序无关。 */
  async function resolveThread(a, b, opts) {
    opts = opts || {};
    var c = core();
    if (!c) return { ok: false, reason: 'core-unavailable' };
    var sa = String(a == null ? '' : a).trim();
    var sb = String(b == null ? '' : b).trim();
    if (!sa || !sb) return { ok: false, reason: c.REASON.missingCharacter };
    /* 自己不能和自己私信：这条判定必须在**任何**存储动作之前。 */
    if (sa === sb) return { ok: false, reason: c.REASON.sameCharacter };
    var parts = c.canonicalizeParticipants(sa, sb);
    if (parts.length !== 2) return { ok: false, reason: c.REASON.sameCharacter };
    var friendId = c.roleDmFriendId(parts[0], parts[1]);
    var existing = threadGet(friendId);
    if (existing) {
      /* 已有 thread → 直接复用（不重复创建）。参与者若有变化（不可能，但如实处理）→ 以 canonical 为准。 */
      if (existing.participantIds.join('\u0001') !== parts.join('\u0001')) {
        existing.participantIds = parts;
        threadSave(existing);
      }
      return { ok: true, created: false, thread: existing };
    }
    var rec = c.buildThreadRecord(parts[0], parts[1], { now: nowMs(), topic: opts.topic });
    if (!rec) return { ok: false, reason: c.REASON.missingCharacter };
    /* 先把已有历史接上：thread 可能经由导入/其它设备产生过消息（索引是派生的）。
       limit 必须是 **0（不限）** 而不是 1：loadMessages 的 limit 是"只取最后 N 条"，
       传 1 会让 messageCount 恒被写成 1（真实条数 5 也写成 1，已实测）。
       thread 记录的 messageCount 是**计数**，因此这里必须读全量；
       顺带 lastMessageAt / lastTurnRoleId 仍取自最后一条，语义不变。
       （rebuildThreadIndex 一直是对的 —— 这条自愈路径漏了同一件事。） */
    var hist = await loadMessages(friendId, 0);
    if (hist.length) {
      rec.messageCount = hist.length;
      rec.lastMessageAt = Number(hist[hist.length - 1].timestamp) || 0;
      rec.lastTurnRoleId = String((hist[hist.length - 1].metadata || {}).senderId || '');
    }
    threadSave(rec);
    return { ok: true, created: true, thread: rec };
  }

  /* 从 canonical 存储重建索引（导入恢复 / 索引丢失时自愈）。
     真相始终是消息行本身，因此重建是**安全且幂等**的。 */
  async function rebuildThreadIndex() {
    var c = core();
    if (!c) return { ok: false, reason: 'core-unavailable' };
    var rows;
    try { rows = await dbGetAll('chatMessages'); } catch (e) { return { ok: false, reason: 'store-unavailable' }; }
    var byFriend = {};
    for (var i = 0; i < (rows || []).length; i++) {
      var m = rows[i];
      if (!c.isRoleDmMessage(m)) continue;
      var fid = String(m.friendId);
      if (!byFriend[fid]) byFriend[fid] = [];
      byFriend[fid].push(m);
    }
    var list = threadsAll();
    var have = {};
    for (var k = 0; k < list.length; k++) have[list[k].threadId] = list[k];
    /* 索引里存在但**已损坏**的记录（例如 participantIds 缺失/长度不对）不能只是
       被忽略：threadsAll() 会把它滤掉，于是下面 `have[f]` 拿到 undefined，
       而重建又会因为"索引里有这个键"而认定它已存在 —— 结果是这条 thread
       在重建后从列表里彻底消失（实测踩过）。因此显式收集损坏键，并在重建末尾
       把它们从索引里剔除（消息本身不动，历史仍可从消息恢复）。 */
    var raw = readJSON(KEY_THREADS, null);
    var rawItems = (raw && Number(raw.v) === INDEX_VERSION && raw.items && typeof raw.items === 'object') ? raw.items : {};
    var brokenKeys = {};
    for (var rk in rawItems) {
      if (!Object.prototype.hasOwnProperty.call(rawItems, rk)) continue;
      if (!have[rk]) brokenKeys[rk] = true;
    }
    var built = 0;
    var skipped = 0;
    for (var f in byFriend) {
      if (!Object.prototype.hasOwnProperty.call(byFriend, f)) continue;
      var msgs = byFriend[f].sort(function (x, y) { return (Number(x.timestamp) || 0) - (Number(y.timestamp) || 0); });
      var last = msgs[msgs.length - 1];
      var md = (last && last.metadata) || {};
      /* 参与者来源按可靠性排序，绝不写空值：
           ① metadata.senderId / recipientId（本能力的规范字段）；
           ② metadata.config_id（既有 chat 写入点的角色 id 字段；旧消息只有它）；
           ③ 该 thread 里出现过的所有 metadata.senderId/config_id（多轮历史里取全部）。
         仍凑不齐两个不同的参与者 → **跳过**这条 thread，绝不把半截记录写回索引
         （实测踩过：先赋值再校验会让损坏记录覆盖掉可用的索引项）。 */
      var seenIds = [];
      for (var mi = 0; mi < msgs.length; mi++) {
        var mmd = msgs[mi].metadata || {};
        [mmd.senderId, mmd.recipientId, mmd.config_id].forEach(function (v) {
          var s = String(v == null ? '' : v);
          if (s && seenIds.indexOf(s) < 0) seenIds.push(s);
        });
      }
      var fromMsg = [String(md.senderId || md.config_id || ''), String(md.recipientId || '')];
      for (var si = 0; si < seenIds.length && fromMsg.filter(Boolean).length < 2; si++) {
        if (fromMsg.indexOf(seenIds[si]) < 0) fromMsg.push(seenIds[si]);
      }
      var parts = c.canonicalizeParticipants(fromMsg[0] || seenIds[0], fromMsg[1] || seenIds[1]);
      if (parts.length !== 2) { skipped++; continue; }
      var existing = have[f];
      var rec = existing || c.buildThreadRecord(parts[0], parts[1], { now: Number(msgs[0].timestamp) || nowMs() });
      if (!rec) rec = c.buildThreadRecord(parts[0], parts[1], { now: Number(msgs[0].timestamp) || nowMs() });
      if (!rec) { skipped++; continue; }
      rec.participantIds = parts;
      rec.messageCount = msgs.length;
      rec.lastMessageAt = Number(last.timestamp) || 0;
      rec.lastTurnRoleId = String(md.senderId || md.config_id || '');
      rec.updatedAt = rec.lastMessageAt || rec.updatedAt;
      have[f] = rec;
      if (!existing) built++;
    }
    var kept = {};
    for (var hk in have) {
      if (!Object.prototype.hasOwnProperty.call(have, hk)) continue;
      var nrec = c.normalizeThreadRecord(have[hk]);
      if (nrec) kept[hk] = nrec;      /* 只写回**能通过 canonical 校验**的记录 */
    }
    threadsSave(Object.keys(kept).map(function (k2) { return kept[k2]; }));
    return {
      ok: true,
      threads: Object.keys(kept).length,
      discovered: built,
      skipped: skipped,
      dropped: Object.keys(brokenKeys)
    };
  }

  /* ══════════ 消息读写 ═══════════════ */
  async function loadMessages(friendId, limit) {
    var rows;
    try { rows = await dbGetByIndex('chatMessages', 'byFriend', String(friendId)); }
    catch (e) { return []; }
    var c = core();
    var list = (rows || []).filter(function (m) { return c ? c.messageBelongsToThread(m, friendId) : false; });
    list.sort(function (a, b) { return (Number(a.timestamp) || 0) - (Number(b.timestamp) || 0); });
    if (limit && list.length > limit) list = list.slice(-limit);
    return list;
  }
  async function appendMessage(msg) {
    if (!msg) return { ok: false, reason: 'bad-message' };
    try { await dbPut('chatMessages', msg); }
    catch (e) {
      /* Home Node 权威下的 fail-closed：写失败必须让调用方看到失败，
         绝不静默写第二份 canonical（home-node-bootstrap.js 的既有语义）。 */
      return { ok: false, reason: core() ? core().REASON.persistFailed : 'persist-failed', error: String((e && e.message) || e) };
    }
    return { ok: true, id: msg.id };
  }

  /* ══════════ A 侧 / B 侧 context 组装 ═══════════════
     每一侧只用**自己**的人格与**自己**的记忆；对方只以**公开认知层**
     （名字 / 公开简介·身份·特征·兴趣 / 你对 TA 的有向看法）出现。
     这从结构上排除"人格串角色"。

     ── 对方的公开资料从哪里来（Peer Awareness Phase 1）────────────────
     唯一来源是 assets/js/public-profile-core.js 的 buildPeerView()：
     构造式白名单 —— 只读 `publicProfile` 与既有的真正公开字段
     （bio / signature），**绝不**读 systemPrompt / apiKey / endpoint /
     memory / relationship。本文件不做任何自己的"截取 persona"逻辑，
     也不在别处拼第二份公开资料 —— 需要的人去调那一个函数。

     为什么不是 `peer.systemPrompt.slice(...)`：persona 是 **Self-private
     authority**，"哪一段算公开"无法判定；截取长度是任意选择，而秘密设定 /
     OOC 指令 / 隐藏关系一旦被截进去，就是一个无法回滚的泄漏。安全优先于
     信息量：旧角色没有公开资料时，对方就只以**名字**出现。 */
  async function composeSide(speakerId, peerId, thread, opts) {
    var c = core();
    opts = opts || {};
    var speaker = cfgOf(speakerId);
    var peer = cfgOf(peerId);
    var history = opts.history || [];
    /* 对方的公开认知层（唯一投影点）。核心缺失时退回"只有名字"——
       绝不因为依赖缺失就把 persona 塞进去。 */
    var pc = profileCore();
    var peerView = (pc && typeof pc.buildPeerView === 'function')
      ? pc.buildPeerView(peer || {}, { sanitize: sanitizeInput, name: peer ? nameOf(peer) : '' })
      : { name: peer ? nameOf(peer) : '', publicIntro: '', occupation: '', traits: [], interests: [], source: 'name-only' };
    var spec = {
      selfName: sanitizeName(nameOf(speaker)) || 'AI',
      selfSystemPrompt: String((speaker && speaker.systemPrompt) || ''),
      /* 对**用户**的关系：这是既有字段的既有语义（cfg.relationship 描述的是
         角色与用户），在此**原样**注入，不挪用成"角色之间的关系"。 */
      selfRelationshipToUser: sanitizeInput(String((speaker && speaker.relationship) || '')),
      peerName: sanitizeName(nameOf(peer)) || '（角色已删除）',
      peerMissing: !peer,
      /* 你对 TA 的看法：来自**有向**关系记录，不是对方的 relationship 字段。 */
      peerRelationship: describeRelation(relationGet(speakerId, peerId)),
      peerNote: '',
      /* 对方是谁：**只**允许公开的资料（层①）。 */
      peerProfile: {
        publicIntro: peerView.publicIntro,
        occupation: peerView.occupation,
        traits: peerView.traits,
        interests: peerView.interests
      },
      peerProfileSource: peerView.source,
      userPresent: opts.userPresent === true,
      userName: sanitizeInput(opts.userName || ''),
      topic: sanitizeInput(opts.topic || '').slice(0, 200),
      nowLabel: new Date().toLocaleString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long', hour: '2-digit', minute: '2-digit' }),
      threadContext: opts.threadContext || '',
      history: history.map(function (m) {
        var md = m.metadata || {};
        var sid = String(md.senderId || '');
        return {
          senderId: sid,
          senderName: sanitizeName(String(m.senderName || nameOf(cfgOf(sid)))),
          content: String(m.content || ''),
          fromSelf: sid === String(speakerId),
          fromUser: false
        };
      })
    };
    var built = c.buildRoleDmContext(spec);
    /* 站点上下文 / Auto Memory 注入：与群聊逐字同款（按本角色独立门控），
       但**不含**玩家可见性档位之外的任何私密内容 —— 复用既有 producer，
       不新造第二套注入器。 */
    try {
      if (typeof buildSiteContext === 'function') {
        var siteCtx = await buildSiteContext({ profile: true, logs: false, fileOutput: false, blogRead: false }, null);
        if (siteCtx) built.system += '\n\n' + String(siteCtx);
      }
    } catch (e) { }
    try {
      if (typeof window.amEnabled === 'function' && window.amEnabled(speaker)) {
        var inj = await window.amBuildInject(speaker, opts.lastPeerText || '');
        if (inj && inj.sys) built.system += '\n\n' + inj.sys;
        if (inj && inj.tail) built.messages[built.messages.length - 1].content += '\n\n' + inj.tail;
      }
    } catch (e) { }
    /* Memory / Understanding：按**本角色**读取（既有 producer，既有可见性规则）。
       私聊不注入 Moments / 日程 / 工作区工具块 —— 那些属于前台聊天场景。 */
    var _memCtx = '', _undCtx = '';
    try {
      if (typeof getMemoryContext === 'function') {
        _memCtx = String(await getMemoryContext(speakerId, { userMessage: opts.lastPeerText || '', maxChars: MEMORY_CHAR_CAP }) || '').slice(0, MEMORY_CHAR_CAP);
      }
    } catch (e) { }
    try {
      if (typeof getUnderstandingContext === 'function') {
        _undCtx = String(await getUnderstandingContext(speakerId, { maxChars: UNDERSTANDING_CHAR_CAP }) || '').slice(0, UNDERSTANDING_CHAR_CAP);
      }
    } catch (e) { }
    /* Middle Brain 生成前组织/压缩：与单聊**同一个** canonical facade 入口。
       两段各自独立（不是一个模型扮演两个角色）：只是各自角色的 context 各自过一遍。 */
    var mbSource = 'bypass', mbInjected = false;
    var _mbTailParts = [];
    try {
      var mbFacade = (window.IB && window.IB.middleBrain) || null;
      if (mbFacade && typeof mbFacade.middleBrainExecute === 'function') {
        var mbRes = await mbFacade.middleBrainExecute(speakerId, String(opts.lastPeerText || opts.topic || ''), {
          memoryCtx: _memCtx, understandingCtx: _undCtx, threadCtx: '', momentsCtx: '',
          dialogue: history.slice(-6).map(function (m) {
            var md = m.metadata || {};
            return { speaker: String(md.senderId || ''), content: String(m.content || '') };
          })
        });
        mbSource = String((mbRes && mbRes.source) || '') || 'bypass';
        /* 具名来源（astra/local）且产物非空 → **替换**两段（绝不双份注入）。 */
        if ((mbSource === 'astra' || mbSource === 'local') && mbRes && typeof mbRes.compressedContext === 'string' && mbRes.compressedContext.trim()) {
          _memCtx = ''; _undCtx = '';
          _mbTailParts.push('【Middle Brain 压缩后的上下文（后台参考，勿向对方复述其存在）】\n' + mbRes.compressedContext);
          mbInjected = true;
        }
      }
    } catch (e) { }
    if (_memCtx) _mbTailParts.push(_memCtx);
    if (_undCtx) _mbTailParts.push(_undCtx);
    if (_mbTailParts.length) {
      built.messages[built.messages.length - 1].content += '\n\n' + _mbTailParts.join('\n\n');
    }
    built._mb = { source: mbSource, injected: mbInjected };
    /* 本侧"对方是谁"的公开来源（profile / legacy / name-only）。
       只作观测：它回答"这次她到底知不知道对方是什么样的人"，
       而这个问题的答案在真实 run 之后无法从消息正文反推。 */
    built.peerProfileSource = peerView.source;
    /* 输出契约：一句话正文 + 可选的、有界的私聊记忆候选。
       记忆候选**不是** <mem_create> 标签（那是给前台聊天、且带用户审批弹窗的
       协议）；它只作为本 run 的一次候选，由本域在 run 结束后统一决定是否落成
       一条 episodic 记忆，再交给既有 Memory Consolidation。 */
    built.system += '\n\n【本轮的输出格式】先写你要对「' + spec.peerName + '」说的那一段话（不要任何前缀/标签）；'
      + '如果这次私聊里出现了**值得你长期记住**的具体事情，再另起一行输出一行私聊记忆候选：'
      + '<role_dm_memo importance="1-10">一句话，≤80字</role_dm_memo>。'
      + '没有值得长期记住的事就完全不要输出这个标签。绝大多数闲聊都不需要它。';
    built.peerName = spec.peerName;
    built.selfName = spec.selfName;
    return built;
  }

  /* 把有向关系记录说成一句人话（给发言方自己看）。**只有**真实观测过的
     关系才会产生这句话；没有来往时返回 ''（不注入一行"关系未知"）。 */
  function describeRelation(rel) {
    if (!rel) return '';
    var c = core();
    if (!c) return '';
    if (!(Number(rel.dmCount) > 0)) return '';
    var trust = Number(rel.trust), fam = Number(rel.familiarity);
    var t = trust >= 0.75 ? '很信任' : trust >= 0.6 ? '比较信任' : trust >= 0.45 ? '说不上信任与否' : trust >= 0.3 ? '有些保留' : '不太信任';
    var f = fam >= 0.7 ? '非常熟' : fam >= 0.4 ? '挺熟' : fam >= 0.2 ? '有些熟悉' : '还不太熟';
    return '你们私下聊过 ' + Number(rel.dmCount) + ' 次；你' + f + '，对 TA ' + t + '。';
  }

  /* ══════════ 一轮发言（**一次真实模型调用**）═══════════════
     返回值：{ok, text, memo, provider, model, speakerName, reason} */
  async function runTurn(ctx) {
    var c = core();
    var speakerId = String(ctx.speakerId);
    var peerId = String(ctx.peerId);
    var speaker = cfgOf(speakerId);
    if (!speaker) return { ok: false, reason: c.REASON.missingCharacter };
    if (!apiReady(speaker)) return { ok: false, reason: c.REASON.notReady };
    var history = await loadMessages(ctx.thread.threadId, ctx.historyLimit || HISTORY_LIMIT);
    var lastPeer = '';
    for (var i = history.length - 1; i >= 0; i--) {
      if (String((history[i].metadata || {}).senderId) === peerId) { lastPeer = String(history[i].content || ''); break; }
    }
    /* Middle Brain Trace：**在 context 组装之前** begin，因为组装本身就要往
       同一条记录上打点（MB 产出来源）。身份字段一律指本回合的真实执行上下文。 */
    var trace = (function () { try { return (window.IB && window.IB.__mbTrace) || null; } catch (e) { return null; } })();
    if (trace) {
      trace.begin('role_dm', speakerId);
      /* 只记稳定身份；**不记** API key、不记 prompt、不记消息正文。 */
      trace.note(speakerId, 'consumer', 'role_dm');
      trace.note(speakerId, 'threadId', ctx.thread.threadId);
      trace.note(speakerId, 'speaker', speakerId);
      trace.note(speakerId, 'peer', peerId);
      trace.note(speakerId, 'trigger', String(ctx.trigger || 'manual'));
      trace.note(speakerId, 'turn', Number(ctx.turnIndex) || 0);
      trace.note(speakerId, 'model', String(speaker.model || ''));
      trace.note(speakerId, 'executor', 'callApiChat');
    }
    var built = await composeSide(speakerId, peerId, ctx.thread, {
      history: history,
      topic: ctx.topic,
      userName: ctx.userName,
      userPresent: ctx.userPresent,
      threadContext: ctx.threadContext,
      lastPeerText: lastPeer
    });

    /* 宿主回合：ONE HOST AI TURN = ONE TOOL EXECUTION CYCLE = ONE TOTAL BUDGET。
       与群聊里"每个发言成员各自一个宿主回合"逐字同款（communication.js:2165-2167）。 */
    var turn = null, lc = null;
    try {
      if (typeof _ibTurnScope === 'function' && typeof _ibTurnLc === 'function') {
        lc = _ibTurnLc(_ibTurnScope('role_dm'));
        turn = lc.turn();
        lc.begin();
      }
    } catch (e) { lc = null; }
    if (trace && built._mb) {
      /* MB 层的实测来源（astra / local / bypass）与"是否真的注入"，与单聊同名同义。 */
      trace.note(speakerId, 'source', built._mb.source);
      trace.note(speakerId, 'messagesChanged', !!built._mb.injected);
    }
    /* 对方公开认知的来源（profile / legacy / name-only）—— 值本身不含任何
       角色内容，只说明"这一侧有没有拿到公开资料"。 */
    if (trace) trace.note(speakerId, 'peerProfileSource', String(built.peerProfileSource || 'name-only'));
    var raw = '';
    try {
      if (typeof callApiChat !== 'function') {
        if (trace) { try { trace.finish(speakerId, {}); } catch (e) { } }
        return { ok: false, reason: 'executor-unavailable' };
      }
      var res = {};
      raw = await callApiChat(speaker, built.messages, {
        _ibConsumer: 'role_dm',
        _ibTurn: turn || undefined,
        /* 私聊是纯对话：不给工具、不联网、不自动续轮。
           这既是产品边界（角色之间聊天不该去改用户的工作区），
           也去掉了一整类副作用与 runaway 面。 */
        disableTools: true,
        _noWebSearch: true,
        autoContinue: false,
        wantThinking: false,
        maxTokens: ctx.maxTokens || 700,
        timeoutMs: 90000,
        result: res
      });
      built._res = res;
    } catch (err) {
      if (trace) { try { trace.finish(speakerId, {}); } catch (e) { } }
      return { ok: false, reason: c.REASON.providerFailed, error: String((err && err.message) || err).slice(0, 200) };
    } finally {
      try { if (lc) lc.end(); } catch (e) { }
    }

    var text = String(raw == null ? '' : raw);
    if (!text.trim()) {
      if (trace) { try { trace.finish(speakerId, {}); } catch (e) { } }
      return { ok: false, reason: c.REASON.providerFailed, error: 'empty-output' };
    }
    /* 私聊记忆候选：先摘掉标签，**绝不**让标签进入正文 / 持久化 / 渲染。 */
    var memo = null;
    var mm = text.match(/<role_dm_memo\b([^>]*)>([\s\S]*?)<\/role_dm_memo\s*>/i);
    if (mm) {
      text = text.replace(mm[0], '').trim();
      var imp = /importance\s*=\s*"?(\d{1,2})"?/i.exec(mm[1] || '');
      var mc = String(mm[2] || '').trim().slice(0, 200);
      if (mc) memo = { content: mc, importance: imp ? parseInt(imp[1], 10) : 6 };
    }
    /* 兜底：模型可能只输出标签不写正文 → 说明这一轮没有实质内容。 */
    if (!text.trim()) {
      if (trace) { try { trace.finish(speakerId, {}); } catch (e) { } }
      return { ok: false, reason: c.REASON.providerFailed, error: 'empty-output' };
    }
    /* Middle Brain 生成后收口 —— 与单聊同一个唯一调用点、同一份裁定词表。
       consumer=role_dm 不豁免 persona guard / speech style / knowledge 边界。 */
    var verdict = null;
    try {
      var mb = (window.IB && window.IB.middleBrain) || null;
      if (mb && typeof mb.middleBrainFinalizeReply === 'function') {
        var fin = await mb.middleBrainFinalizeReply(speakerId, lastPeer || ctx.topic || '', text, { character: speaker, history: history });
        if (fin && typeof fin.reply === 'string' && fin.reply) text = fin.reply;
        verdict = (fin && fin.outcome && fin.outcome.verdict) || null;
      }
    } catch (e) { }
    if (trace) { try { trace.finish(speakerId, {}); } catch (e) { } }

    /* 私聊不解析任何副作用标签（ws_* / mem_* / cal_note / blog_read / withdraw）。
       若模型仍写出了它们，从正文里剥掉，避免标签原样上屏或入库 —— 这既守住
       "角色之间聊天不操作用户环境"的边界，也不静默丢弃（下面如实报 stripped）。 */
    var stripped = [];
    text = text.replace(/<\/?(?:ws_[a-z_]+|mem_(?:create|update|delete)|cal_note|blog_read|withdraw)\b[^>]*>/gi, function (tag) {
      stripped.push(String(tag).replace(/[<>/]/g, '').split(/\s|>/)[0]);
      return '';
    });
    text = text.replace(/```[a-z]*file:[^\n]*\n[\s\S]*?```/gi, '').trim();
    text = text.trim();
    if (!text) return { ok: false, reason: c.REASON.providerFailed, error: 'empty-output' };

    return {
      ok: true,
      text: text,
      memo: memo,
      stripped: stripped,
      provider: String(speaker.provider || ''),
      model: String(speaker.model || ''),
      speakerName: nameOf(speaker)
    };
  }

  /* ══════════ 一次完整 run：A → B → A → B … ═══════════════
     opts: { aId, bId, turns, topic, trigger, initiatorId, signal } */
  async function run(opts) {
    opts = opts || {};
    var c = core();
    if (!c) return { ok: false, reason: 'core-unavailable' };
    var trigger = (opts.trigger === 'autonomous') ? 'autonomous' : 'manual';
    /* 本轮不放开全自动调度：autonomous 必须显式开偏好，且只有在
       canonical trigger API 被 Active Companion / Diary 调用时才可能进入。 */
    if (trigger === 'autonomous' && prefs().autonomous !== true) {
      return { ok: false, reason: 'autonomous-disabled' };
    }
    var resolved = await resolveThread(opts.aId, opts.bId, { topic: opts.topic });
    if (!resolved.ok) return resolved;
    var thread = resolved.thread;
    var parts = thread.participantIds;
    var friendId = thread.threadId;

    /* ── 守卫 1：per-thread running lock（同一 thread 不允许两个并发 run）── */
    if (_runningThreads[friendId]) return { ok: false, reason: c.REASON.threadBusy, thread: thread };

    /* ── 守卫 2：per-character lock（复用既有全局 _chatSendingFor，因此
       Active Companion / Diary / Voice 能**看见**角色此刻正在私聊并让路）── */
    var held = [];
    var sending = null;
    try { sending = (typeof _chatSendingFor !== 'undefined') ? _chatSendingFor : null; } catch (e) { sending = null; }
    for (var pi = 0; pi < parts.length; pi++) {
      var pid = parts[pi];
      if (sending && sending.has(pid)) {
        for (var ri = 0; ri < held.length; ri++) sending.delete(held[ri]);
        return { ok: false, reason: c.REASON.characterBusy, detail: pid, thread: thread };
      }
      if (sending) { sending.add(pid); held.push(pid); }
    }

    var runId = uid('roledmrun_');
    _runningThreads[friendId] = runId;
    _running = true;
    var startedAt = nowMs();

    /* ── 守卫 3：thread 必须处于 active。
       archived 的唯一来源是"参与者之一被删除"（onCharacterDeleted），因此它同时
       表达"历史保留、但不该再有新对话"。角色若日后被重建，归档状态不自动解除 ——
       解除是明确的用户动作，不是一次隐式回滚。 */
    if (thread.state !== 'active') {
      releaseLocks(friendId, held, sending);
      return { ok: false, reason: c.REASON.missingCharacter, detail: 'thread-archived', thread: thread };
    }

    /* ── 守卫 4：**两个**参与者都必须存在。
       只检查"即将发言的那个"是不够的：那样会出现"一方说了话、另一方根本不在"
       的半截 run（已经落了一条消息，然后以 missing-character 停）。角色私信是
       一对一会话，任何一方不存在，这段会话就**不该开始**。 */
    for (var vi = 0; vi < parts.length; vi++) {
      if (!cfgOf(parts[vi])) {
        releaseLocks(friendId, held, sending);
        return { ok: false, reason: c.REASON.missingCharacter, detail: parts[vi], thread: thread };
      }
    }
    /* ── 守卫 4：同一对角色冷却（防止连点 / 两个标签页互相接力）── */
    var cooldown = c.pairCooldownRemaining(thread.lastRunAt, startedAt);
    if (cooldown > 0 && opts.force !== true) {
      releaseLocks(friendId, held, sending);
      return { ok: false, reason: c.REASON.pairCooldown, remainingMs: cooldown, thread: thread };
    }

    var maxTurns = c.normalizeTurnBudget(trigger, opts.turns);
    var turnsDone = 0;
    var stallCount = 0;
    var produced = [];
    /* 本轮 run 里**出现过的所有文本**（含被判为重复/低信息而丢弃的那些）。
       只用 produced（=已落库）来判重是不够的：第一次重复被丢弃后，第二次的
       比较基准里仍然没有它，于是"同内容对轰"会先漏过一次才熔断。 */
    var seenTexts = [];
    var providerFailed = false;
    var runError = '';
    var stopReason = null;
    var runTopic = String(opts.topic || thread.topic || '').slice(0, 200);
    var userName = '';
    try { var about = await dbGet('about', 'main'); userName = (about && about.name) || ''; } catch (e) { }

    /* 记录 lastRunAt：立刻落盘，于是并发/重复点击在**这一层**就被冷却挡住，
       而不是等 run 结束（否则连点会同时穿过守卫 1-3）。 */
    thread.lastRunAt = startedAt;
    thread.runCount = (Number(thread.runCount) || 0) + 1;
    thread.stoppedReason = '';
    if (runTopic) thread.topic = runTopic;
    threadSave(thread);

    var speakerId = c.chooseFirstSpeaker(thread, opts.initiatorId || parts[0]);
    try {
      for (var t = 0; t < maxTurns; t++) {
        /* ── 守卫 4：abort / 轮数 / 空转熔断 ── */
        if (opts.signal && opts.signal.aborted) { stopReason = c.REASON.aborted; break; }
        var gate = c.canRunMoreTurn({ aborted: !!(opts.signal && opts.signal.aborted), providerFailed: providerFailed, stallCount: stallCount, maxTurns: maxTurns, turnsDone: turnsDone });
        if (!gate.ok) { stopReason = gate.reason; break; }
        /* ── 守卫 5：每角色时/日轮次配额 ── */
        if (!c.roleTurnRoomOk(roleTurnTimes(speakerId), nowMs())) { stopReason = c.REASON.roleDailyCap; break; }
        var peerId = (parts[0] === speakerId) ? parts[1] : parts[0];

        var turnRes = await runTurn({
          thread: thread,
          speakerId: speakerId,
          peerId: peerId,
          topic: runTopic,
          trigger: trigger,
          turnIndex: t,
          userName: userName,
          historyLimit: HISTORY_LIMIT
        });

        if (!turnRes.ok) {
          /* 任何失败都**安全停止**：已完成的消息保留、锁释放、原因落盘。
             绝不自动无限 retry，也绝不 fallback 到另一个角色的模型。 */
          stopReason = turnRes.reason;
          if (turnRes.reason === c.REASON.providerFailed || turnRes.reason === c.REASON.notReady) {
            providerFailed = true;
            /* 角色配置失效：清楚报错（既有用户错误模型），并停止本 run。 */
            try {
              var cfgX = cfgOf(speakerId);
              var canShow = (window.IBERR && typeof window.IBERR.show === 'function' && typeof window.IBERR.model === 'function');
              if (canShow) window.IBERR.show(window.IBERR.model('auth', { reason: 'missing-key', cfg: cfgX, stage: 'role_dm' }));
            } catch (e) { }
          }
          if (turnRes.reason === c.REASON.missingCharacter) providerFailed = true;
          break;
        }

        /* ── 守卫 6：同内容 / 低信息检测 ──
           分两种强度，因为两种事实不同：
             · **低信息**（"哈哈"/"嗯"这类空洞短句）—— 单独出现就没有内容价值，
               直接丢弃、不落库、不计轮，换对手方继续；
             · **同内容**（与本次 run 里已经出现过的文本 bigram Dice ≥ 阈值）——
               第一次出现时那条文本本身是**真实说过的话**，因此照常落库（历史
               要如实）；紧随其后的重复才知道"他们在对轰"，于是计数并熔断。
           两条通道都受 STALL_LIMIT 约束：连续凑数到上限即停止整个 run，
           绝不会把整段重复的对话灌进历史，也不会无限互聊。 */
        var dup = c.isDuplicateTurn(turnRes.text, seenTexts);
        var lowInfo = c.lowInfoMatch(turnRes.text);
        if (lowInfo) {
          stallCount++;
          if (stallCount >= c.STALL_LIMIT) { stopReason = 'low-info-stall'; break; }
          seenTexts.push(String(turnRes.text));
          speakerId = peerId;
          continue;
        }
        if (dup.duplicate) {
          stallCount++;
          seenTexts.push(String(turnRes.text));
          if (stallCount >= c.STALL_LIMIT) { stopReason = c.REASON.duplicateStall; break; }
          speakerId = peerId;
          continue;
        }
        stallCount = 0;
        seenTexts.push(String(turnRes.text));

        var msg = c.buildRoleDmMessage({
          friendId: friendId,
          senderId: speakerId,
          recipientId: peerId,
          senderName: turnRes.speakerName,
          content: turnRes.text,
          timestamp: nowMs(),
          trigger: trigger,
          turnIndex: turnsDone,
          runId: runId,
          provider: turnRes.provider,
          model: turnRes.model
        });
        if (!msg) { stopReason = 'bad-message'; break; }
        var written = await appendMessage(msg);
        if (!written.ok) {
          /* 持久化失败（含 Home Node fail-closed 离线）→ 停止并如实上报；
             已经写进去的消息保留，绝不回滚、绝不重试。 */
          stopReason = written.reason;
          providerFailed = true;
          break;
        }
        roleTurnRecord(speakerId, msg.timestamp);
        produced.push({ roleId: speakerId, messageId: msg.id, content: turnRes.text, memo: turnRes.memo });
        turnsDone++;
        thread.lastMessageAt = msg.timestamp;
        thread.lastTurnRoleId = speakerId;
        thread.messageCount = (Number(thread.messageCount) || 0) + 1;
        thread.updatedAt = msg.timestamp;
        threadSave(thread);
        try { if (typeof NS.roleDmEmit === 'function') NS.roleDmEmit('turn', { threadId: friendId, messageId: msg.id }); } catch (e) { }
        speakerId = peerId;
      }
    } catch (err) {
      stopReason = 'run-error';
      /* 诊断：一次 run 的意外失败必须留下**可回答**的原因（只记 message，
         不含 prompt / 正文 / key）。只吞异常不记原因会让"为什么没聊起来"
         变成一个无法回答的问题（浏览器 smoke 实测踩过）。 */
      runError = String((err && err.message) || err).slice(0, 200);
      try { console.warn('[RoleDM] run failed', runError); } catch (e) { }
    } finally {
      /* 唯一收尾点：任何出口都必须停止、保留已完成消息、释放锁、记录原因。 */
      releaseLocks(friendId, held, sending);
      _running = false;
    }
    if (!stopReason) stopReason = c.REASON.maxTurns;

    /* ── 关系观测：directional + bounded。每个方向各自观测，可以不同。── */
    var relationResult = null;
    try { relationResult = await observeRun(thread, produced, runTopic); } catch (e) { }

    /* ── 记忆边界：有界 episodic 候选 → 既有 consolidation。── */
    var memoryResult = null;
    try { memoryResult = await emitMemories(thread, produced, trigger); } catch (e) { }

    thread.stoppedReason = stopReason;
    thread.updatedAt = nowMs();
    threadSave(thread);

    var last = produced.length ? produced[produced.length - 1] : null;
    try {
      if (typeof NS.roleDmEmit === 'function') {
        NS.roleDmEmit('run', { threadId: friendId, turns: turnsDone, stopReason: stopReason, runId: runId });
      }
    } catch (e) { }

    return {
      ok: turnsDone > 0,
      runId: runId,
      thread: thread,
      turns: turnsDone,
      stopReason: stopReason,
      messages: produced.map(function (p) { return p.messageId; }),
      lastMessageId: last ? last.messageId : null,
      relation: relationResult,
      memory: memoryResult,
      error: runError || null,
      reason: turnsDone > 0 ? null : (stopReason || 'no-turn')
    };
  }

  function releaseLocks(friendId, held, sending) {
    try { delete _runningThreads[friendId]; } catch (e) { }
    for (var i = 0; i < held.length; i++) { try { if (sending) sending.delete(held[i]); } catch (e) { } }
  }

  /* ══════════ 关系观测（有界）═══════════════
     输入 = 本次 run 的真实事实；输出 = 两条有向记录各自的有界增量。
     绝不"每说一句话就永久改人格"：单次 run 的改动被 RELATION_DELTA_CAP 封顶，
     且每个方向只看**那个方向**的发言（于是 A→B 与 B→A 可以不同）。 */
  async function observeRun(thread, produced, topic) {
    var c = core();
    var parts = thread.participantIds;
    if (parts.length !== 2) return null;
    var fromA = produced.filter(function (p) { return p.roleId === parts[0]; });
    var fromB = produced.filter(function (p) { return p.roleId === parts[1]; });
    var out = { a: null, b: null };
    out.a = await observeDirection(parts[0], parts[1], fromA, fromB, produced.length, topic);
    out.b = await observeDirection(parts[1], parts[0], fromB, fromA, produced.length, topic);
    return out;
  }
  async function observeDirection(fromId, toId, mine, theirs, turns, topic) {
    var c = core();
    if (!turns) return null;
    var rel = relationGet(fromId, toId);
    if (!rel) return null;
    var texts = mine.map(function (p) { return p.content; });
    var tones = c.toneCounts(texts);
    var delta = c.relationDelta({
      turns: turns,
      positive: tones.positive,
      negative: tones.negative,
      initiatorId: fromId,
      responderId: toId
    });
    var before = { trust: rel.trust, familiarity: rel.familiarity, affinity: rel.affinity };
    rel = c.applyRelationDelta(rel, delta);
    rel.dmCount = (Number(rel.dmCount) || 0) + 1;
    rel.lastDmAt = nowMs();
    rel.updatedAt = rel.lastDmAt;
    /* 观测环形缓冲：只留**事实**（轮数/基调计数/时间/thread），绝不留正文。 */
    rel.observations.push({
      at: rel.lastDmAt,
      threadId: threadIdOfSafe(fromId, toId),
      turns: turns,
      spoke: mine.length,
      positive: tones.positive,
      negative: tones.negative,
      topic: String(topic || '').slice(0, 40),
      delta: delta
    });
    rel.observations = rel.observations.slice(-(c.OBSERVATION_KEEP));
    relationSave(rel);
    return { fromId: fromId, toId: toId, before: before, after: { trust: rel.trust, familiarity: rel.familiarity, affinity: rel.affinity }, delta: delta };
  }
  function threadIdOfSafe(a, b) { var c = core(); return c ? c.roleDmFriendId(a, b) : ''; }

  /* ══════════ 记忆边界 ═══════════════
     硬要求：**禁止**每条 Role DM → 双方长期记忆。
     做法：一个 run 结束后，每个参与者**最多**贡献 1 条 episodic 记忆，
     且必须同时满足：run 达到最小轮数、模型确实给出了记忆候选、importance 达阈值。
     写入用既有 canonical 构造器 quickCreateMemory（visibility='only' +
     visibleTo=[自己]），因此：
       · 只有该角色自己能召回（读边界与注入边界同源）；
       · kind='episodic' → 进入既有 Memory Consolidation（episodic→semantic）；
       · provenance 指向 thread（不指向消息正文）—— 删除 raw history **不会**
         也不假装会级联删除已固化的长期记忆，UI 如实说明这一点。 */
  async function emitMemories(thread, produced, trigger) {
    var c = core();
    if (!produced.length) return { written: 0, skipped: 'no-productions' };
    var parts = thread.participantIds;
    var written = 0;
    var writtenByRole = {};
    var details = [];
    for (var i = 0; i < parts.length; i++) {
      var roleId = parts[i];
      /* 每 run **每人**最多一条候选（不是全场一条）：A 与 B 各自是自己的记忆所有者，
         各自形成自己的理解。用"本次 run 已为该角色写入的条数"计数，绝不按消息条数放大。 */
      if (!c.memoryBudgetOk(writtenByRole[roleId] || 0)) { details.push({ roleId: roleId, skipped: 'run-budget' }); continue; }
      var mine = produced.filter(function (p) { return p.roleId === roleId; });
      var memos = mine.filter(function (p) { return p.memo && p.memo.content; });
      if (!memos.length) { details.push({ roleId: roleId, skipped: 'no-memo' }); continue; }
      /* 一次 run 内该角色可能给了多条候选：只取 importance 最高的一条。 */
      memos.sort(function (x, y) { return (Number(y.memo.importance) || 0) - (Number(x.memo.importance) || 0); });
      var chosen = memos[0].memo;
      var allowed = c.memoryCandidateAllowed({
        turns: produced.length,
        stallCount: 0,
        importance: Number(chosen.importance) || 0,
        content: chosen.content
      });
      if (!allowed.ok) { details.push({ roleId: roleId, skipped: allowed.reason }); continue; }
      var cfg = cfgOf(roleId);
      if (!cfg) { details.push({ roleId: roleId, skipped: 'missing-character' }); continue; }
      var peerCfg = cfgOf(parts[0] === roleId ? parts[1] : parts[0]);
      var ok = false;
      try {
        if (typeof quickCreateMemory === 'function') {
          var newId = await quickCreateMemory({
            title: ('和' + nameOf(peerCfg) + '的私聊').slice(0, 24),
            summary: String(chosen.content).slice(0, 80),
            content: String(chosen.content).slice(0, 300),
            source: 'role_dm',
            /* provenance = thread（不是消息正文）。 */
            sourceId: thread.threadId,
            domain: '日常',
            tags: ['role_dm'],
            valence: 0.5,
            arousal: 0.4,
            importance: Math.max(0, Math.min(10, Number(chosen.importance) || 0)),
            resolved: false,
            /* visibility='only' + visibleTo=[自己]：只有本角色能召回。
               private 会让角色自己也召回不到（既有语义），因此不能用 private。 */
            visibility: 'only',
            visibleTo: [String(roleId)],
            excludeFrom: [],
            createdBy: String(roleId),
            createdByName: nameOf(cfg),
            kind: 'episodic',
            consolidatedFrom: [],
            lastConsolidatedAt: null
          });
          ok = !!newId;
        }
      } catch (e) { ok = false; }
      if (ok) { written++; writtenByRole[roleId] = (writtenByRole[roleId] || 0) + 1; details.push({ roleId: roleId, written: true }); }
      else { details.push({ roleId: roleId, skipped: 'write-failed' }); }
    }
    return { written: written, details: details, trigger: trigger };
  }

  /* ══════════ 删除 / 清空语义 ═══════════════
     两个动作**语义明确、互不假装**：
       clearThread(friendId) —— 清空聊天记录：删掉该 thread 的**消息**，
                                保留 thread 身份与 directional 关系状态。
       deleteThread(friendId) —— 删除整个私聊：消息 + thread 索引记录一起删。
     **两者都不级联删除已固化的长期记忆**：本仓库没有 provenance-safe 的
     记忆级联删除（记忆的 provenance 只到 thread 粒度，且 consolidation 已把
     episodic 归纳成 semantic，来源可能已被合并/改写）。UI 必须如实说明，
     绝不提供"删除私聊 = 忘记一切"的假按钮。 */
  async function clearThread(friendId) {
    var c = core();
    var fid = String(friendId);
    var msgs = await loadMessages(fid);
    var n = 0, failed = 0;
    for (var i = 0; i < msgs.length; i++) {
      try { await dbDelete('chatMessages', msgs[i].id); n++; }
      catch (e) { failed++; }
    }
    var rec = threadGet(fid);
    if (rec && !failed) {
      rec.messageCount = 0;
      rec.lastMessageAt = 0;
      rec.lastTurnRoleId = '';
      rec.updatedAt = nowMs();
      threadSave(rec);
    }
    return { ok: failed === 0, removed: n, failed: failed, memoryUntouched: true };
  }
  async function deleteThread(friendId) {
    var fid = String(friendId);
    var res = await clearThread(fid);
    var list = threadsAll().filter(function (t) { return t.threadId !== fid; });
    threadsSave(list);
    /* 关系状态**刻意保留**：关系不是这段聊天记录的属性，它是两个角色之间的
       事实；删掉聊天不会让"你们彼此怎么看对方"归零。UI 入口另行提供。 */
    return { ok: res.ok, removedMessages: res.removed, failed: res.failed, relationKept: true, memoryUntouched: true };
  }
  /* 角色被删除时的 thread 处理：参与者缺失 → thread 进入 archived（历史保留、
     不可再启动 run），并如实标注哪一侧缺失。绝不静默删除用户的历史。 */
  async function onCharacterDeleted(roleId) {
    var c = core();
    var rid = String(roleId);
    var list = threadsAll();
    var touched = 0, clearedRelations = 0;
    for (var i = 0; i < list.length; i++) {
      if (list[i].participantIds.indexOf(rid) < 0) continue;
      list[i].state = 'archived';
      list[i].updatedAt = nowMs();
      touched++;
    }
    if (touched) threadsSave(list);
    /* 指向已删除角色的 directional 关系记录：删除（那个方向的主语已不存在）。
       对方→被删角色的记录同理删除。 */
    var rels = relationsAll();
    var keep = {};
    var changed = false;
    for (var k in rels) {
      if (!Object.prototype.hasOwnProperty.call(rels, k)) continue;
      if (rels[k].fromId === rid || rels[k].toId === rid) { changed = true; clearedRelations++; continue; }
      keep[k] = rels[k];
    }
    if (changed) writeJSON(KEY_RELATIONS, { v: INDEX_VERSION, items: keep, updatedAt: nowMs() });
    /* 该角色的轮次账本一并清掉（它已不再存在）。 */
    var led = ledgerAll();
    if (led[rid]) { delete led[rid]; writeJSON(KEY_LEDGER, led); }
    return { ok: true, threads: touched, relations: clearedRelations };
  }

  /* ══════════ canonical trigger API（供 Active Companion / Diary 以后调用）═══
     这是本轮**唯一**给自动调度预留的接缝。scheduler 只调用它，
     绝不碰 DOM（UI 层的渲染由 roleDmEmit 事件驱动）。 */
  function canAutonomousRun(aId, bId, now) {
    var c = core();
    if (!c) return { ok: false, reason: 'core-unavailable' };
    if (prefs().autonomous !== true) return { ok: false, reason: 'autonomous-disabled' };
    var resolved = threadGet(c.roleDmFriendId(aId, bId));
    if (resolved) {
      var cd = c.pairCooldownRemaining(resolved.lastRunAt, Number(now) || nowMs());
      if (cd > 0) return { ok: false, reason: c.REASON.pairCooldown, remainingMs: cd };
      if (resolved.state === 'archived') return { ok: false, reason: 'thread-archived' };
    }
    if (!c.roleTurnRoomOk(roleTurnTimes(aId), now)) return { ok: false, reason: c.REASON.roleDailyCap };
    return { ok: true };
  }
  function start(aId, bId, options) {
    return run(Object.assign({ aId: aId, bId: bId, trigger: 'manual' }, options || {}));
  }
  function startAutonomous(aId, bId, options) {
    return run(Object.assign({ aId: aId, bId: bId, trigger: 'autonomous' }, options || {}));
  }

  /* ══════════ 对外只读视图（UI / 测试共用）═══════════════ */
  async function listThreads() {
    var c = core();
    var list = threadsAll();
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var t = list[i];
      var msgs = await loadMessages(t.threadId, 0);
      var last = msgs.length ? msgs[msgs.length - 1] : null;
      var md = (last && last.metadata) || {};
      var aCfg = cfgOf(t.participantIds[0]);
      var bCfg = cfgOf(t.participantIds[1]);
      out.push({
        threadId: t.threadId,
        participantIds: t.participantIds.slice(),
        participants: [
          { id: t.participantIds[0], name: nameOf(aCfg), missing: !aCfg },
          { id: t.participantIds[1], name: nameOf(bCfg), missing: !bCfg }
        ],
        state: t.state,
        createdAt: t.createdAt,
        lastMessageAt: t.lastMessageAt,
        messageCount: msgs.length,
        lastPreview: last ? String(last.content || '').slice(0, 60) : '',
        lastSpeakerId: String(md.senderId || ''),
        running: !!_runningThreads[t.threadId],
        ready: !!(aCfg && bCfg && apiReady(aCfg) && apiReady(bCfg) && t.state === 'active')
      });
    }
    out.sort(function (x, y) { return (y.lastMessageAt || y.createdAt) - (x.lastMessageAt || x.createdAt); });
    return out;
  }
  async function threadDetail(friendId) {
    var c = core();
    var rec = threadGet(friendId);
    if (!rec) return null;
    var msgs = await loadMessages(friendId, 0);
    var aCfg = cfgOf(rec.participantIds[0]);
    var bCfg = cfgOf(rec.participantIds[1]);
    return {
      thread: rec,
      messages: msgs.map(function (m) {
        var md = m.metadata || {};
        return {
          id: m.id,
          senderId: String(md.senderId || ''),
          recipientId: String(md.recipientId || ''),
          senderName: String(m.senderName || nameOf(cfgOf(md.senderId))),
          content: String(m.content || ''),
          timestamp: Number(m.timestamp) || 0,
          provider: String(md.provider || ''),
          model: String(md.model || ''),
          trigger: String(md.trigger || ''),
          turnIndex: Number(md.turnIndex) || 0
        };
      }),
      participants: [
        { id: rec.participantIds[0], name: nameOf(aCfg), missing: !aCfg, ready: !!aCfg && apiReady(aCfg), provider: String((aCfg && aCfg.provider) || ''), model: String((aCfg && aCfg.model) || '') },
        { id: rec.participantIds[1], name: nameOf(bCfg), missing: !bCfg, ready: !!bCfg && apiReady(bCfg), provider: String((bCfg && bCfg.provider) || ''), model: String((bCfg && bCfg.model) || '') }
      ],
      relations: [
        relationGet(rec.participantIds[0], rec.participantIds[1]),
        relationGet(rec.participantIds[1], rec.participantIds[0])
      ],
      running: !!_runningThreads[friendId],
      stopReason: rec.stoppedReason
    };
  }
  function listCharacters() {
    var out = [];
    var a = apiConfigsLive();
    for (var i = 0; i < a.length; i++) {
      if (!a[i] || !a[i].id) continue;
      out.push({ id: String(a[i].id), name: nameOf(a[i]), provider: String(a[i].provider || ''), model: String(a[i].model || ''), ready: apiReady(a[i]) });
    }
    return out;
  }
  function isRunning(friendId) {
    if (friendId) return !!_runningThreads[String(friendId)];
    return !!_running;
  }

  NS.roleDm = {
    /* 生命周期 / 索引 */
    resolveThread: resolveThread,
    rebuildThreadIndex: rebuildThreadIndex,
    listThreads: listThreads,
    threadDetail: threadDetail,
    listCharacters: listCharacters,
    isRunning: isRunning,
    prefs: prefs,
    setPrefs: setPrefs,
    /* 执行 */
    start: start,
    startAutonomous: startAutonomous,
    canAutonomousRun: canAutonomousRun,
    run: run,
    /* 维护 */
    clearThread: clearThread,
    deleteThread: deleteThread,
    onCharacterDeleted: onCharacterDeleted,
    /* 关系 */
    relationGet: relationGet,
    relationsAll: relationsAll,
    /* 只读内部（测试 / 诊断） */
    _threadsAll: threadsAll,
    _loadMessages: loadMessages,
    _composeSide: composeSide,
    _keys: { threads: KEY_THREADS, relations: KEY_RELATIONS, ledger: KEY_LEDGER, prefs: KEY_PREFS, indexVersion: INDEX_VERSION }
  };
  NS.expose('roleDm', NS.roleDm);
})(window.IB || (window.IB = {}));
