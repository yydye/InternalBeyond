/* ====================================================================
   IB Role DM Core — 角色私信（Inter-Character Direct Messaging）的**唯一契约实现**
   --------------------------------------------------------------------
   UMD 双载：
     - Browser: <script src="assets/js/role-dm-core.js"> → window.IBRoleDmCore
     - Node   : require('../assets/js/role-dm-core.js')

   规则（与 chat-core.js / reply-chain-core.js 同款）：**零 window / 零 DOM /
   零 fetch / 零 IndexedDB / 零 localStorage / 零副作用 / 全部纯函数**。
   本文件不发起任何模型调用，也不写任何数据 —— 它只定义"角色私信是什么"。

   ── 为什么需要它 ────────────────────────────────────────────────────
   Role DM 不是 Moments（朋友圈是公开动态 + 评论串，评论没有收信人字段），
   不是群聊人数=2（群聊的成员集合与群 id 都是用户建的），也不是用户单聊的
   伪装（用户不是 participant）。三者都已有自己的 canonical 实现，本能力
   因此必须**自带**一份可版本化的身份/消息契约，并把它放在唯一一处。

   ── 与既有契约的关系（复用，不并行）─────────────────────────────────
   · thread 身份**落在既有 chat 会话键上**：friendId 由 participants 从
     无序对确定性地派生，于是 chat-core.js 的 conversationIdOf(friendId)
     直接给出 `dm:roledm_<token>`，Home Node 的 chat-store 无需任何改动
     就能把它当成一个正常的 canonical conversation 接收与同步。
   · 消息记录**扩展既有 message representation**（id/role/content/friendId/
     timestamp/metadata），绝不新造第二套消息体系。
   · 循环/重复/低信息三类守卫的**常量与算法复用**
     assets/js/reply-chain-core.js（LIMITS / diceSimilarity / lowInfoMatch /
     replyRoomOk 语义），本文件只补 Role DM 自己的三个预算维度
     （单次 run 轮数上限、同一对角色冷却、单角色每日轮数上限）。
   ==================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); }
  else { root.IBRoleDmCore = factory(); }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ══════════ 1. 常量（本能力的唯一真源）══════════════ */

  /* friendId 前缀。为什么用独立前缀而不是塞进 `group_`：
     chat-core.js 的 conversationIdOf 只按 `group_` 前缀二分 kind，因此
     `roledm_` 天然落进 'dm' 分支 —— 既不改 chat-core 的分支结构，也不让
     角色私信被任何"群聊"判定误认。 */
  var ROLE_DM_FRIEND_PREFIX = 'roledm_';
  /* 消息层的 conversationType 标记（写进 metadata，用作扫描点的显式排除谓词）。
     刻意不新增 friendId 之外的 kind 字段：conversationId 仍是派生值。 */
  var CONVERSATION_TYPE = 'role_dm';
  var MESSAGE_TYPE = 'role_dm';
  var SCHEMA_VERSION = 1;

  /* 稳定 id 形状（与 chat-core 的 msg_* 家族并列，互不冲突）。 */
  var THREAD_ID_PREFIX = 'roleDm_';
  var MESSAGE_ID_PREFIX = 'roledmmsg_';
  var RELATION_ID_PREFIX = 'roleRel_';

  /* run 预算。manual = 用户点"让她们聊一会儿"；autonomous = 未来由
     Active Companion / Diary / relationship engine 触发。两者都远小于无穷：
     这是本能力最重要的安全边界，不是 TODO。 */
  var RUN_LIMITS = {
    manual: { minTurns: 2, defaultTurns: 4, maxTurns: 6 },
    autonomous: { minTurns: 1, defaultTurns: 2, maxTurns: 4 }
  };
  /* 同一对角色两次 run 之间的冷却（防止连点、防止两个标签页互相接力）。 */
  var PAIR_COOLDOWN_MS = 90 * 1000;
  /* 单角色每日轮数上限（成本护栏；与 Moments 的 DAILY_MAX 同量级）。 */
  var ROLE_DAILY_TURN_MAX = 40;
  /* 同一角色每小时轮数上限。 */
  var ROLE_HOURLY_TURN_MAX = 20;
  /* 单条角色私信正文上限（字符）。 */
  var CONTENT_MAX = 1200;
  /* 连续两条消息的"同内容"判定阈值（bigram Dice）。 */
  var DUPLICATE_SIMILARITY = 0.8;
  /* 空转熔断：连续 N 轮被判为重复/低信息即停止整个 run。 */
  var STALL_LIMIT = 2;

  /* 「对方是谁」这一整块在 system 里的字符预算。
     注意它与 public-profile-core.js 的 LIMITS **不是同一件事**，刻意不合并：
       · public-profile-core.LIMITS —— **数据**能有多长（字段级契约，
         别的消费者如 UI / 未来的群聊也用同一份）；
       · 本常量 —— **prompt** 里这块能占多少（本能力的预算维度，
         与 MEMORY_CHAR_CAP / UNDERSTANDING_CHAR_CAP 同一类）。
     把两者合成一个数，等于让"UI 能存多长"和"模型能看多少"互相绑架。
     整块按**整行**累积，绝不从中间切断一行。 */
  var PEER_PROFILE_CHAR_CAP = 600;

  /* ── 跨 run 的 thread memorandum（层④「我们以前聊过什么」）───────────
     它不是 A 的记忆，也不是 B 的记忆，而是 **A↔B 这条私聊本身**的共同历史。
     因此它挂在 **thread 记录**上（一对角色一份），而不是挂在任一角色身上 ——
     A 与 B 读到的必须是**同一份**（memorandum(A,B) === memorandum(B,A)），
     而 relationship 仍是有向的两份。这个区别是这一层存在的全部理由。

     为什么是"滚动 + watermark"而不是"每次重新总结整段历史"：
     重新总结会让同一批消息被反复喂给模型（成本随轮数平方增长），并且
     summary(summary(...)) 会逐代丢失事实。rolling 的输入恒为
     「上一份备忘 + **尚未覆盖**的新消息」，watermark 指到哪就是哪。

     下面 4 个上限各自回答一个不同的问题，刻意不合并成一个"摘要长度"：
       · MEMORANDUM_TEXT_MAX      —— **存储**能有多长（thread 记录里的字段上限）
       · MEMORANDUM_CHAR_CAP      —— **prompt** 里这块能占多少（整行累积）
       · MEMORANDUM_LINE_MAX      —— 单条事实能有多长
       · MEMORANDUM_MIN_UNCOVERED —— 攒够多少条"已经离开最近窗口"的旧消息才值得折叠
     把前两个合成一个数，就等于让"存得下"和"模型看得到"互相绑架。 */
  var MEMORANDUM_SCHEMA_VERSION = 1;
  var MEMORANDUM_TEXT_MAX = 2000;
  var MEMORANDUM_CHAR_CAP = 1200;
  var MEMORANDUM_LINE_MAX = 160;
  /* 触发阈值。取值理由：最近窗口是 12 条（role-dm.js 的 HISTORY_LIMIT），
     阈值取得比它小 —— 于是"刚离开窗口的一小批旧消息"就能被折叠进备忘，
     不必等到又攒满一整个窗口。取 8 是 12 的 2/3：既不会每两轮就写一次，
     也不会让"聊了 19 条、备忘还是空的"这种情况发生。 */
  var MEMORANDUM_MIN_UNCOVERED = 8;

  /* 关系观测（directional）的有界步长与初值。 */
  var RELATION_DIMS = ['trust', 'familiarity', 'affinity'];
  var RELATION_DEFAULT = { trust: 0.5, familiarity: 0.2, affinity: 0.5 };
  var RELATION_MIN = 0;
  var RELATION_MAX = 1;
  /* 单次 run 对任一维度的**最大**改动量（bounded update）。 */
  var RELATION_DELTA_CAP = 0.03;
  /* 观测环形缓冲上限（每条记录只留最近 N 条事实，绝不留正文）。 */
  var OBSERVATION_KEEP = 12;

  /* 进入 memory candidate 的准入阈值：只有真正承载"值得记住的事"的 run 才
     产出候选。默认严格 —— 宁可少记，也不把 DM 原文灌进长期记忆。 */
  var MEMORY_MIN_TURNS = 3;
  var MEMORY_MIN_IMPORTANCE = 6;
  var MEMORY_MAX_PER_RUN = 1;

  /* ══════════ 2. 纯工具 ═══════════════ */
  function str(v) { return String(v == null ? '' : v); }

  function isNonEmptyString(v) { return typeof v === 'string' && v.trim().length > 0; }

  /* 把公开资料的列表字段（traits / interests）渲染成一行。
     非数组一律视为"没有" —— 绝不把对象/字符串 toString 之后塞进 prompt
     （那会把 `[object Object]` 变成"公开特征"，比缺失更糟）。 */
  function peerListLine(list, maxItems, maxItemChars) {
    if (!Array.isArray(list)) return '';
    var out = [];
    for (var i = 0; i < list.length && out.length < maxItems; i++) {
      var item = str(list[i]).replace(/[\r\n]+/g, ' ').trim();
      if (!item) continue;
      out.push(item.slice(0, maxItemChars));
    }
    return out.join('、');
  }

  /* 与 reply-chain-core.js 的 hashStr 逐位同款（同一位运算链），
     但**自带一份**：本模块必须能在 reply-chain-core 未加载时工作
     （例如 Node 侧单测），因此不能依赖它。两份实现由测试钉住一致性。 */
  function hashStr(s) {
    var h = 7, t = str(s);
    for (var i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) >>> 0;
    return h;
  }
  function rand36(n) {
    var out = '';
    while (out.length < (n || 10)) out += Math.random().toString(36).slice(2);
    return out.slice(0, n || 10);
  }

  /* ══════════ 3. thread 身份 ═══════════════
     canonicalizeParticipants —— 参与者顺序的**唯一**归一化点。
     排序 + 去重后比较：因此 roleDmKey(A,B) === roleDmKey(B,A)，
     无论谁先发起、也无论调用方按什么顺序传参，解析到**同一个** thread。 */
  function canonicalizeParticipants(a, b) {
    var x = str(a).trim(), y = str(b).trim();
    if (!x || !y) return [];
    if (x === y) return [];
    var list = [x, y];
    list.sort(function (p, q) { return p < q ? -1 : (p > q ? 1 : 0); });
    return list;
  }
  /* 无序对的稳定键（人类可读、可断言；不含方向）。 */
  function roleDmKey(a, b) {
    var p = canonicalizeParticipants(a, b);
    return p.length === 2 ? (p[0] + '|' + p[1]) : '';
  }
  /* friendId：由无序对**确定性**派生。同一对角色恒得同一个 friendId，
     不同对角色碰撞概率极低（68 bit 哈希 + 静态前缀）。 */
  function roleDmFriendId(a, b) {
    var key = roleDmKey(a, b);
    if (!key) return '';
    var h1 = hashStr(key), h2 = hashStr('\u0001' + key), h3 = hashStr('\u0002' + key);
    var token = (h1.toString(36) + h2.toString(36) + h3.toString(36)).slice(0, 14);
    return ROLE_DM_FRIEND_PREFIX + token;
  }
  function isRoleDmFriendId(friendId) {
    return str(friendId).indexOf(ROLE_DM_FRIEND_PREFIX) === 0;
  }
  /* 一条**已存消息**是否属于角色私信域。
     判据严格按 metadata.conversationType（canonical 标记），friendId 前缀
     只作为**兼容回退**（旧记录 / 手工数据）—— 两个判据都必须存在，
     因为扫描点需要在不解包 metadata 的前提下也能安全排除。 */
  function isRoleDmMessage(m) {
    if (!m || typeof m !== 'object') return false;
    var md = m.metadata;
    if (md && typeof md === 'object' && str(md.conversationType) === CONVERSATION_TYPE) return true;
    return isRoleDmFriendId(m.friendId);
  }

  /* threadId 就是 friendId —— 本能力**不使用** chat-core 的 threadId 频道
     （频道是"同一会话内的话题分区"，而角色私信本身就是会话）。因此
     conversationId 恒为 `dm:<friendId>`，没有 `|` 分隔符。 */
  function threadIdOf(a, b) { return roleDmFriendId(a, b); }

  function newMessageId(now) {
    return MESSAGE_ID_PREFIX + (Number(now) || Date.now()) + '_' + rand36(8);
  }
  function newRelationId(a, b) {
    return RELATION_ID_PREFIX + hashStr(relationKey(a, b)).toString(36) + '_' + rand36(6);
  }

  /* ══════════ 4. thread 记录 ═══════════════ */
  function buildThreadRecord(a, b, opts) {
    opts = opts || {};
    var p = canonicalizeParticipants(a, b);
    if (p.length !== 2) return null;
    var now = Number(opts.now) || Date.now();
    var friendId = roleDmFriendId(p[0], p[1]);
    return {
      id: THREAD_ID_PREFIX + hashStr(friendId).toString(36),
      schemaVersion: SCHEMA_VERSION,
      threadId: friendId,
      friendId: friendId,
      dmKey: roleDmKey(p[0], p[1]),
      conversationType: CONVERSATION_TYPE,
      participantIds: p,          /* canonical：已排序，长度恒为 2 */
      createdAt: now,
      updatedAt: now,
      lastMessageAt: 0,
      state: 'active',            /* active | archived */
      messageCount: 0,
      lastTurnRoleId: '',
      /* 最近一次 run 是**谁主动发起**的（'' = 没有 / 手动发起）。
         存在的理由只有一个：让"她主动找我"这件事在 run 结束后依然可解释
         （UI 与冷启动后的诊断都需要它）。它**不**参与谁先说的判定 ——
         那个判定只认调用方显式传入的 initiatorId（见 chooseFirstSpeaker）。 */
      lastInitiatedBy: '',
      lastRunAt: 0,
      runCount: 0,
      stoppedReason: '',
      topic: str(opts.topic).slice(0, 200)
    };
  }
  /* 旧数据兼容：缺字段一律补默认值，**绝不**因为字段缺失而判无效。
     返回 null 只表示"这条记录在身份上不可用"（缺 participantIds / 顺序非 canonical）。 */
  function normalizeThreadRecord(rec) {
    if (!rec || typeof rec !== 'object') return null;
    var p = Array.isArray(rec.participantIds) ? rec.participantIds.map(str) : [];
    if (p.length !== 2) return null;
    var canon = canonicalizeParticipants(p[0], p[1]);
    if (canon.length !== 2) return null;
    var friendId = isNonEmptyString(rec.friendId) ? str(rec.friendId) : roleDmFriendId(canon[0], canon[1]);
    if (!isRoleDmFriendId(friendId)) return null;
    var out = Object.assign({}, rec);
    out.schemaVersion = Number(rec.schemaVersion) || SCHEMA_VERSION;
    out.threadId = friendId;
    out.friendId = friendId;
    out.dmKey = roleDmKey(canon[0], canon[1]);
    out.conversationType = CONVERSATION_TYPE;
    out.participantIds = canon;
    out.createdAt = Number(rec.createdAt) || 0;
    out.updatedAt = Number(rec.updatedAt) || out.createdAt;
    out.lastMessageAt = Number(rec.lastMessageAt) || 0;
    out.state = (rec.state === 'archived' ? 'archived' : 'active');
    out.messageCount = Number(rec.messageCount) || 0;
    out.lastTurnRoleId = str(rec.lastTurnRoleId);
    out.lastInitiatedBy = str(rec.lastInitiatedBy);
    out.lastRunAt = Number(rec.lastRunAt) || 0;
    out.runCount = Number(rec.runCount) || 0;
    out.stoppedReason = str(rec.stoppedReason);
    out.topic = str(rec.topic).slice(0, 200);
    /* thread memorandum：**可选字段**，因此这里绝不升 DB_VER、也绝不新增
       object store —— 它只是 thread 记录上的一个嵌套对象，旧记录没有它就是
       "还没有备忘"，行为与加这一层之前逐字相同。
       归一化刻意是"无效即**删除键**"而不是"写成 null"：旧记录经过本函数后
       必须保持**逐字节不变**（多了 null 键就会让导入/导出的 diff 与既有断言
       发生变化），而"键不存在"与"值为 null"在本能力里语义相同（都表示没有）。 */
    var memo = normalizeMemorandum(rec.threadMemorandum);
    if (memo) out.threadMemorandum = memo;
    else delete out.threadMemorandum;
    return out;
  }
  /* 参与者顺序是否已经是 canonical 的（用来回答"这份历史是不是同一个 thread"）。 */
  function participantsAreCanonical(list) {
    if (!Array.isArray(list) || list.length !== 2) return false;
    return str(list[0]) <= str(list[1]);
  }

  /* ══════════ 5. 消息契约 ═══════════════
     形状 = 既有 canonical message（id/role/content/friendId/timestamp）+ metadata。
     · senderId / recipientId / threadId / conversationType / trigger 全部落在
       metadata —— 这样既有 `role` 三值词表（user/assistant/system）**不必**扩展，
       而"这条消息是谁发给谁的"仍然是一等字段。
     · role 恒为 'assistant'：speaker 是角色（不是用户），沿用既有语义
       （群聊里每个角色的发言同样是 assistant）。 */
  function buildRoleDmMessage(input) {
    input = input || {};
    var senderId = str(input.senderId).trim();
    var recipientId = str(input.recipientId).trim();
    var friendId = str(input.friendId).trim() || roleDmFriendId(senderId, recipientId);
    var content = str(input.content);
    if (!senderId || !recipientId || senderId === recipientId) return null;
    if (!isRoleDmFriendId(friendId)) return null;
    if (!content.trim()) return null;
    var now = Number(input.timestamp) || Date.now();
    var n = Number(input.turnIndex);
    var md = {
      conversationType: CONVERSATION_TYPE,
      threadId: friendId,
      senderId: senderId,
      recipientId: recipientId,
      trigger: str(input.trigger) || 'manual',
      turnIndex: (isFinite(n) && n >= 0) ? n : 0,
      config_id: senderId,
      provider: str(input.provider),
      model: str(input.model)
    };
    if (isNonEmptyString(input.runId)) md.runId = str(input.runId);
    var msg = {
      id: str(input.id) || newMessageId(now),
      role: 'assistant',
      content: content.slice(0, CONTENT_MAX),
      friendId: friendId,
      senderName: str(input.senderName),
      timestamp: now,
      type: MESSAGE_TYPE,
      metadata: md
    };
    if (isNonEmptyString(input.reasoning_content)) msg.reasoning_content = str(input.reasoning_content);
    return msg;
  }
  /* 校验：错误词表稳定，供测试与日志断言（禁止用字符串匹配分支）。 */
  function validateRoleDmMessage(m) {
    var errors = [];
    if (!m || typeof m !== 'object' || Array.isArray(m)) return { ok: false, errors: ['not-an-object'] };
    if (!isNonEmptyString(m.id)) errors.push('missing-id');
    if (m.role !== 'assistant') errors.push('bad-role');
    if (typeof m.content !== 'string' || !m.content) errors.push('bad-content');
    if (!isRoleDmFriendId(m.friendId)) errors.push('bad-friendId');
    if (!isFinite(Number(m.timestamp)) || Number(m.timestamp) <= 0) errors.push('bad-timestamp');
    var md = m.metadata;
    if (!md || typeof md !== 'object') errors.push('missing-metadata');
    else {
      if (str(md.conversationType) !== CONVERSATION_TYPE) errors.push('bad-conversationType');
      if (!isNonEmptyString(md.senderId)) errors.push('missing-senderId');
      if (!isNonEmptyString(md.recipientId)) errors.push('missing-recipientId');
      if (str(md.senderId) === str(md.recipientId)) errors.push('self-addressed');
      if (str(md.threadId) !== str(m.friendId)) errors.push('thread-mismatch');
    }
    return { ok: errors.length === 0, errors: errors };
  }
  /* 这条消息是否可以进入 speaker 的 prompt 历史。
     **历史绝不串 thread**：threadId 不同即不可见。 */
  function messageBelongsToThread(m, friendId) {
    if (!m || typeof m !== 'object') return false;
    if (str(m.friendId) !== str(friendId)) return false;
    return isRoleDmMessage(m);
  }

  /* ══════════ 6. 关系（directional）═══════════════
     A→B 与 B→A 是**两条独立记录**，允许不同值。绝不强行对称。 */
  function relationKey(a, b) {
    var x = str(a).trim(), y = str(b).trim();
    if (!x || !y || x === y) return '';
    return x + '\u0001' + y;   /* 有向：from \u0001 to */
  }
  function parseRelationKey(key) {
    var raw = str(key);
    var at = raw.indexOf('\u0001');
    if (at <= 0 || at >= raw.length - 1) return null;
    return { fromId: raw.slice(0, at), toId: raw.slice(at + 1) };
  }
  function buildRelationRecord(fromId, toId, opts) {
    opts = opts || {};
    var key = relationKey(fromId, toId);
    if (!key) return null;
    var now = Number(opts.now) || Date.now();
    var rec = {
      id: newRelationId(fromId, toId),
      schemaVersion: SCHEMA_VERSION,
      relationKey: key,
      fromId: str(fromId),
      toId: str(toId),
      kind: 'role_to_role',
      trust: RELATION_DEFAULT.trust,
      familiarity: RELATION_DEFAULT.familiarity,
      affinity: RELATION_DEFAULT.affinity,
      observations: [],
      updatedAt: now,
      createdAt: now,
      dmCount: 0,
      lastDmAt: 0
    };
    Object.assign(rec, opts.init || {});
    return rec;
  }
  function normalizeRelationRecord(rec) {
    if (!rec || typeof rec !== 'object') return null;
    var fromId = str(rec.fromId).trim(), toId = str(rec.toId).trim();
    if (!fromId || !toId || fromId === toId) {
      var p = parseRelationKey(rec.relationKey);
      if (!p) return null;
      fromId = p.fromId; toId = p.toId;
    }
    var out = Object.assign({}, rec);
    out.fromId = fromId; out.toId = toId;
    out.relationKey = relationKey(fromId, toId);
    out.kind = str(rec.kind) || 'role_to_role';
    RELATION_DIMS.forEach(function (d) {
      var v = Number(rec[d]);
      out[d] = isFinite(v) ? clamp01(v) : RELATION_DEFAULT[d];
    });
    out.observations = Array.isArray(rec.observations) ? rec.observations.slice(-OBSERVATION_KEEP) : [];
    out.dmCount = Number(rec.dmCount) || 0;
    out.lastDmAt = Number(rec.lastDmAt) || 0;
    out.updatedAt = Number(rec.updatedAt) || 0;
    out.createdAt = Number(rec.createdAt) || out.updatedAt;
    return out;
  }
  function clamp01(v) { return v < RELATION_MIN ? RELATION_MIN : (v > RELATION_MAX ? RELATION_MAX : v); }

  /* 有界的关系更新步（**纯函数**，无 IO）。
     输入 = 本次 run 的观测事实；输出 = 各维度的**增量**（不是最终值）。
     绝不做"每说一句话就永久改人格"：单次 run 对任一维度的改动被
     RELATION_DELTA_CAP 硬顶封住，且增量按维度白名单过滤。

     中性 = 零变化（P-audit 修正）。此前 trust/affinity 只要"语气差不为负"
     就固定上涨，于是**任何**一次普通寒暄都在涨信任 —— 而语气分类本身是词表
     命中计数，"类别""麻烦"这类词还会把中性句判成正/负。现在明确：
       · familiarity 只由"确实聊过几轮"驱动（可观察事实，不可伪造）；
       · trust / affinity 只由**净正语气**驱动；净 ≤ 0（中性或负）一律 0，
         绝不用"没检测到负面"当成"正面"。 */
  function relationDelta(observation) {
    var o = observation || {};
    var turns = Math.max(0, Number(o.turns) || 0);
    var pos = Math.max(0, Number(o.positive) || 0);
    var neg = Math.max(0, Number(o.negative) || 0);
    var initiatorId = str(o.initiatorId), responderId = str(o.responderId);
    var out = {};
    if (turns <= 0) { RELATION_DIMS.forEach(function (d) { out[d] = 0; }); return out; }
    /* 熟悉度：只与"聊过"这件事有关，与语气无关 —— 单向累积，永不下滑。 */
    out.familiarity = capDelta(0.004 * turns);
    /* 净正才驱动信任/好感。发起方的主动更值钱一点（主动联系是关系强度的证据）。 */
    var drive = 0;
    if (pos > neg) {
      var politeness = (pos - neg) / Math.max(1, turns);
      drive = politeness * 0.02 + (initiatorId !== responderId ? 0.002 : 0);
    }
    out.trust = capDelta(drive);
    out.affinity = capDelta(drive * 0.8);
    return out;
  }
  function capDelta(v) {
    var n = Number(v) || 0;
    if (n > RELATION_DELTA_CAP) return RELATION_DELTA_CAP;
    if (n < -RELATION_DELTA_CAP) return -RELATION_DELTA_CAP;
    return n;
  }
  function applyRelationDelta(record, delta) {
    var rec = normalizeRelationRecord(record);
    if (!rec) return null;
    var d = delta || {};
    RELATION_DIMS.forEach(function (dim) {
      if (!Object.prototype.hasOwnProperty.call(d, dim)) return;
      var v = Number(d[dim]);
      if (!isFinite(v)) return;
      rec[dim] = clamp01(rec[dim] + capDelta(v));
    });
    return rec;
  }

  /* 语气极性：只用**稳定词表**，绝不把模型自述当作事实。
     positive / negative 都是"命中数"，不是概率。 */
  var POSITIVE_RE = /(谢谢|感谢|太好了|很高兴|开心|喜欢|佩服|厉害|赞同|同意|真好|温暖|期待|不错|辛苦了|恭喜|加油|thanks|thank you|glad|happy|love|appreciate|agreed|great)/i;
  var NEGATIVE_RE = /(抱歉|生气|难过|失望|讨厌|不同意|不认同|反对|无聊|别|滚|烦|生气|sorry|angry|upset|disappointed|hate|disagree|annoyed)/i;
  function toneCounts(texts) {
    var list = Array.isArray(texts) ? texts : [];
    var pos = 0, neg = 0;
    for (var i = 0; i < list.length; i++) {
      var t = str(list[i]);
      if (!t) continue;
      var p = t.match(new RegExp(POSITIVE_RE.source, 'gi'));
      var n = t.match(new RegExp(NEGATIVE_RE.source, 'gi'));
      if (p) pos += p.length;
      if (n) neg += n.length;
    }
    return { positive: pos, negative: neg };
  }

  /* ══════════ 7. run 守卫（纯决策；执行与落盘在 runtime 层）═══════════════ */
  function normalizeRunMode(mode) {
    return (mode === 'autonomous') ? 'autonomous' : 'manual';
  }
  function runLimits(mode) {
    var m = normalizeRunMode(mode);
    return Object.assign({ mode: m }, RUN_LIMITS[m]);
  }
  /* 请求轮数归一到本模式允许的闭区间；非法/缺省取默认值（**绝不**解释成无穷）。 */
  function normalizeTurnBudget(mode, requested) {
    var lim = runLimits(mode);
    var n = parseInt(requested, 10);
    if (!isFinite(n) || n <= 0) return lim.defaultTurns;
    if (n < lim.minTurns) return lim.minTurns;
    if (n > lim.maxTurns) return lim.maxTurns;
    return n;
  }
  /* 是否还能再走一轮。返回 {ok, reason}；reason 用稳定词表。 */
  function canRunMoreTurn(state) {
    var s = state || {};
    if (s.aborted === true) return { ok: false, reason: 'aborted' };
    if (s.providerFailed === true) return { ok: false, reason: 'provider-failed' };
    if ((Number(s.stallCount) || 0) >= STALL_LIMIT) return { ok: false, reason: 'duplicate-stall' };
    var budget = Number(s.maxTurns) || 0;
    var done = Number(s.turnsDone) || 0;
    if (done >= budget) return { ok: false, reason: 'max-turns' };
    return { ok: true, reason: null };
  }
  /* 同一角色此刻是否还有轮数额度（日/小时两级）。times = 该角色近期轮次时间戳。 */
  function roleTurnRoomOk(times, now) {
    var t = Number(now) || Date.now();
    var arr = (Array.isArray(times) ? times : []).filter(function (v) { return Number(v) > 0; });
    if (arr.filter(function (v) { return t - Number(v) <= 3600000; }).length >= ROLE_HOURLY_TURN_MAX) return false;
    if (arr.filter(function (v) { return t - Number(v) <= 86400000; }).length >= ROLE_DAILY_TURN_MAX) return false;
    return true;
  }
  /* 同一对角色是否仍在冷却中（无序对）。 */
  function pairCooldownRemaining(lastRunAt, now) {
    var last = Number(lastRunAt) || 0;
    if (!last) return 0;
    var rem = PAIR_COOLDOWN_MS - ((Number(now) || Date.now()) - last);
    return rem > 0 ? rem : 0;
  }
  /* 与上一批发言的重复判定（bigram Dice；算法取自 reply-chain-core 的语义）。
     返回 {duplicate, similarity}。 */
  function isDuplicateTurn(content, recentContents) {
    var text = str(content).trim();
    if (!text) return { duplicate: true, similarity: 1, reason: 'empty' };
    var list = Array.isArray(recentContents) ? recentContents : [];
    var best = 0;
    for (var i = 0; i < list.length; i++) {
      var s = diceSimilarity(text, str(list[i]));
      if (s > best) best = s;
    }
    return { duplicate: best >= DUPLICATE_SIMILARITY, similarity: best, reason: best >= DUPLICATE_SIMILARITY ? 'same-content' : null };
  }
  /* bigram Dice（与 reply-chain-core / _activeTextSimilarity 同语义）。 */
  function textKey(text) {
    return str(text).toLowerCase().replace(/<[^>]*>/g, '').replace(/[\s\p{P}\p{S}]+/gu, '');
  }
  function diceSimilarity(a, b) {
    var x = textKey(a), y = textKey(b);
    if (!x || !y) return 0;
    if (x === y) return 1;
    if (x.length < 2 || y.length < 2) return 0;
    var grams = function (s) { var out = {}; for (var i = 0; i < s.length - 1; i++) out[s.slice(i, i + 2)] = 1; return out; };
    var gx = grams(x), gy = grams(y), keys = Object.keys(gx), overlap = 0, ny = 0;
    for (var k in gy) if (Object.prototype.hasOwnProperty.call(gy, k)) ny++;
    for (var i2 = 0; i2 < keys.length; i2++) if (gy[keys[i2]]) overlap++;
    if (!keys.length || !ny) return 0;
    return (2 * overlap) / (keys.length + ny);
  }
  /* 低信息过滤：复用 reply-chain-core 的**同一份**词表（存在则用它的，
     否则用本模块的冻结副本）—— 两处由测试钉住一致。 */
  var LOW_INFO_FALLBACK = /^(哈哈+|嗯+|嗯嗯+|好的|好|不错|\+1|666|nb|强|赞|可爱|好看|加油|嘿|哎|哦|哈|呵|笑死|点赞|收藏|转发|同感|是啊|确实)$/i;
  function lowInfoMatch(content) {
    var t = str(content).trim();
    if (!t) return true;
    if (t.length <= 1) return true;
    try {
      var rc = (typeof window !== 'undefined') && window._replyChainCore;
      if (rc && typeof rc.lowInfoMatch === 'function') return !!rc.lowInfoMatch(t);
    } catch (e) { /* 共享核心不可用 → 用冻结副本 */ }
    return LOW_INFO_FALLBACK.test(t);
  }

  /* ══════════ 7a. autonomous initiation signal（行为背景，不是指令）═══════
     自主发起时给模型的那**一句话**，是"她为什么现在想起这个人"的
     **低权威**表述。它**不是**"系统要求你主动找 TA 聊天" —— 那会把一次
     社会行为降级成一次任务执行，模型会开始解释、汇报、或演一个"被指派"的角色。

     ── 为什么这里是一个闭集映射，而不是把 trace 里的字符串透传 ──────────
     上游的 signal 来自 role-dm-social-core 的 reasonCode 词表。如果这里直接
     拼接原始字符串，那么将来任何人在上游加一个 code，就自动获得了一条
     进入 prompt 的通道 —— 这正是"工程数据泄漏进人格"最常见的形成方式。
     因此本函数**按 code 翻译**，未知 code 一律返回 ''（那就只保留
     "你主动联系了对方"这句最弱的行为背景，不编造理由）。

     ── 它为什么不可注入 ────────────────────────────────────────────────
     返回值只可能是下面这张表里的常量之一，输入是 code 而不是自由文本，
     所以不存在"用户可以构造一段话来改写这句 prompt"的路径。
     消毒仍由调用方在进入 prompt 前统一执行（canonical prompt boundary）。 */
  var INITIATION_SIGNAL_TEXT = {
    'existing-thread': '你想接着之前和 TA 的话题再说两句。',
    'long-time-no-contact': '你有一阵子没和 TA 说话了，忽然想起 TA。',
    'relationship-maintenance': '你有点想知道 TA 最近怎么样。'
  };
  function initiationSignalText(code) {
    var key = str(code).trim();
    if (!key) return '';
    return Object.prototype.hasOwnProperty.call(INITIATION_SIGNAL_TEXT, key) ? INITIATION_SIGNAL_TEXT[key] : '';
  }
  function initiationSignalCodes() { return Object.keys(INITIATION_SIGNAL_TEXT); }

  /* ══════════ 7b. thread memorandum（跨 run 的共同历史）═══════════════
     这一层的**唯一**输入是「这条 A↔B 私聊里双方已经互相说过的话」。
     因此它绝不读：A/B 的 systemPrompt、apiKey、customInstruction、
     任一方的 private memory、Understanding 私有状态、Middle Brain 私有状态、
     relationship-to-user 的私有文本、**其他** thread / 群聊的内容。
     这条边界不是靠"记得别读"维持的 —— 本节的函数签名里根本没有角色对象，
     它们只接受**已经按 thread 过滤过的消息数组**。想越界就必须先改签名。

     ── 为什么不复用 Memory Consolidation / Middle Brain 的产物 ──────────
     它们产出的都是**按角色**的私有归纳（visibility='only' / 角色自己的
     compressedContext）。把它塞进一份 A 与 B 共读的共享块，等于把 A 的私有
     记忆泄漏给 B —— 那不是"省一次模型调用"，那是跨角色泄漏。
     所以本阶段的生成器**刻意是纯确定性的**：不加任何模型调用。 */
  function boundMemorandumLines(lines, cap) {
    var arr = Array.isArray(lines) ? lines : [];
    var keep = [];
    var total = 0;
    /* 从**最新**往前收：滚动备忘保留的是"离现在最近的过去"。
       最早的内容在预算用尽时被丢 —— 这一点必须如实承认（见 contract 注释），
       而不是假装 2000 字符能装下无限历史。 */
    for (var i = arr.length - 1; i >= 0; i--) {
      var line = str(arr[i]);
      if (!line) continue;
      var add = keep.length ? (line.length + 1) : line.length;
      if (keep.length && (total + add) > cap) break;
      if (!keep.length && line.length > cap) { keep.unshift(line.slice(0, cap)); break; }
      keep.unshift(line);
      total += add;
    }
    return keep.join('\n');
  }
  /* 记忆备忘的**唯一**合法形状。无效一律返回 null（调用方据此当作"没有备忘"），
     绝不抛异常、绝不返回半截对象 —— 一个畸形的备忘若能进入 prompt，
     它会是以"历史事实"的身份进去的，那比缺失更糟。 */
  function normalizeMemorandum(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    /* text **必须**是字符串。刻意不走 str() 的隐式归一：那会把 `{text:123}`
       变成一份"内容为 123"的历史事实，把 `{text:['a']}` 变成 'a' ——
       一次类型强转就凭空造出一条事实，比缺失更糟。畸形一律当"没有备忘"。 */
    if (typeof raw.text !== 'string') return null;
    var rawLines = raw.text.split('\n');
    var lines = [];
    for (var i = 0; i < rawLines.length; i++) {
      var ln = rawLines[i].replace(/[\r\n]+/g, ' ').trim();
      if (!ln) continue;
      lines.push(ln.slice(0, MEMORANDUM_LINE_MAX));
    }
    if (!lines.length) return null;
    var text = boundMemorandumLines(lines, MEMORANDUM_TEXT_MAX);
    if (!text) return null;
    var count = Number(raw.sourceMessageCount);
    return {
      schemaVersion: MEMORANDUM_SCHEMA_VERSION,
      text: text,
      coveredUntilMessageId: str(raw.coveredUntilMessageId),
      coveredUntilAt: Number(raw.coveredUntilAt) || 0,
      updatedAt: Number(raw.updatedAt) || 0,
      sourceMessageCount: (isFinite(count) && count > 0) ? Math.floor(count) : 0
    };
  }
  function memorandumOfThread(rec) {
    if (!rec || typeof rec !== 'object') return null;
    return normalizeMemorandum(rec.threadMemorandum);
  }
  /* 已覆盖到有序消息列表的哪个下标。返回 -1 = 还没有 watermark（一条都没覆盖）。
     id 优先（主键，无歧义），timestamp 兜底（消息被清空后 id 会找不到）。
     两者都定位不到时返回 -1 —— 保守的一侧：宁可多折叠一次，
     也绝不假装"覆盖过了"而永久丢掉一段共同历史。 */
  function memorandumCoveredIndex(messages, memo) {
    var list = Array.isArray(messages) ? messages : [];
    if (!memo) return -1;
    var id = str(memo.coveredUntilMessageId);
    if (id) {
      for (var i = 0; i < list.length; i++) if (str(list[i] && list[i].id) === id) return i;
    }
    var at = Number(memo.coveredUntilAt) || 0;
    if (at > 0) {
      var last = -1;
      for (var j = 0; j < list.length; j++) if ((Number(list[j] && list[j].timestamp) || 0) <= at) last = j;
      return last;
    }
    return -1;
  }
  /* 尚未覆盖、且**已经离开最近窗口**的那些消息。
     第二个条件是本层与层⑤（最近原文）不重复的**结构性**保证：
     最近 recentLimit 条永远不进备忘，因此"备忘里说了什么"与
     "模型能看到的最近原文"不可能覆盖同一个窗口。

     recentLimit 的三态语义（刻意区分"忘记传"与"显式不要窗口"）：
       · 正数 / 显式 0 —— 受保护的最近窗口 = 最后 N 条（0 = 不保护，全部可折叠）；
       · 缺省 / null / NaN / 负数 —— **不折叠任何东西**（返回空 eligible）。
     最后一条是 fail-safe 的一侧：调用方忘了声明窗口时，宁可什么都不做，
     也不能把模型马上就能读到的原文又抄进备忘（那正是本层要避免的重复）。
     生产的唯一调用点是 role-dm.js 的 updateMemorandum，它恒传入 HISTORY_LIMIT。 */
  function memorandumEligible(messages, memo, recentLimit) {
    var list = Array.isArray(messages) ? messages : [];
    var lim = recentLimit;
    var declared = (typeof lim === 'number' && isFinite(lim) && lim >= 0);
    var recentStart = declared ? Math.max(0, list.length - Math.floor(lim)) : list.length;
    var from = memorandumCoveredIndex(list, memo) + 1;
    if (from < 0) from = 0;
    var out = [];
    for (var i = from; i < recentStart; i++) out.push(list[i]);
    return { eligible: out, from: from, recentStart: recentStart, windowDeclared: declared };
  }
  /* 确定性抽取：把消息变成"共同历史"的行，而不是文学化的总结。
     保留：谁说了什么（可核查的事实）。
     降低：寒暄（走 canonical 的 lowInfoMatch 词表）、逐字重复的相邻行。
     绝不"补充"消息里没有的推论 —— 确定性抽取的价值就在于它不会编。 */
  function memorandumFoldLines(messages, opts) {
    opts = opts || {};
    var nameOf = (typeof opts.nameOf === 'function') ? opts.nameOf : function () { return ''; };
    var lineMax = Number(opts.lineMax) > 0 ? Number(opts.lineMax) : MEMORANDUM_LINE_MAX;
    var list = Array.isArray(messages) ? messages : [];
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var m = list[i] || {};
      var content = str(m.content).replace(/\s+/g, ' ').trim();
      if (!content) continue;
      if (lowInfoMatch(content)) continue;
      var md = (m.metadata && typeof m.metadata === 'object') ? m.metadata : {};
      /* 名字解析拿到**整条消息**：历史行必须用"说这句话时的名字"（消息里
         存的 senderName），而不是"现在这个角色的名字" —— 角色改名或被删除后，
         共同历史里仍然应该是当时那个名字。（id 作为兜底。） */
      var who = str(nameOf(str(md.senderId), m)) || '（角色已删除）';
      var line = who + '：' + content;
      if (line.length > lineMax) line = line.slice(0, lineMax);
      if (out.length && out[out.length - 1] === line) continue;
      out.push(line);
    }
    return out;
  }
  /* 决策 + 滚动折叠（纯函数：已读到的消息 + 现有备忘 → 新备忘）。
     reason 是稳定词表，供 §16 的可观测性回答"这次为什么没更新"：
       'no-messages'      这条 thread 还没有消息
       'no-window'        调用方没声明最近窗口 → 拒绝折叠（fail-safe）
       'covered'          没有尚未覆盖的旧消息
       'below-threshold'  有旧消息，但不足 MEMORANDUM_MIN_UNCOVERED
       'no-facts'         旧消息全被判为寒暄/空 → 不留痕，也不推进 watermark
       'fold'             本次真的更新了
     只有 'fold' 会改变结果；其余一律**原样返回旧备忘**（可能是 null）。
     'no-facts' 刻意**不推进** watermark：不推进最多让同一批寒暄被重新看一眼
     （确定性、零成本），推进则会写下一个"覆盖过但内容不在文本里"的假声明。 */
  function foldMemorandum(input) {
    var s = input || {};
    var messages = Array.isArray(s.messages) ? s.messages : [];
    var memo = normalizeMemorandum(s.memo);
    if (!messages.length) return { changed: false, reason: 'no-messages', memo: memo, folded: 0, eligible: 0 };
    var picked = memorandumEligible(messages, memo, s.recentLimit);
    var eligible = picked.eligible;
    if (!picked.windowDeclared) {
      /* 调用方没有声明"最近窗口有多大" → 拒绝折叠（fail-safe，见 memorandumEligible）。 */
      return { changed: false, reason: 'no-window', memo: memo, folded: 0, eligible: 0 };
    }
    if (!eligible.length) {
      return { changed: false, reason: 'covered', memo: memo, folded: 0, eligible: 0, recentStart: picked.recentStart };
    }
    var min = Number(s.minUncovered) > 0 ? Number(s.minUncovered) : MEMORANDUM_MIN_UNCOVERED;
    if (eligible.length < min) {
      return { changed: false, reason: 'below-threshold', memo: memo, folded: 0, eligible: eligible.length, recentStart: picked.recentStart };
    }
    var lines = memorandumFoldLines(eligible, { nameOf: s.nameOf, lineMax: s.lineMax });
    if (!lines.length) {
      return { changed: false, reason: 'no-facts', memo: memo, folded: 0, eligible: eligible.length, recentStart: picked.recentStart };
    }
    var prevText = memo ? memo.text : '';
    var combined = prevText ? prevText.split('\n').concat(lines) : lines.slice();
    var text = boundMemorandumLines(combined, Number(s.textMax) > 0 ? Number(s.textMax) : MEMORANDUM_TEXT_MAX);
    var lastM = eligible[eligible.length - 1] || {};
    var next = normalizeMemorandum({
      text: text,
      coveredUntilMessageId: str(lastM.id),
      coveredUntilAt: Number(lastM.timestamp) || 0,
      updatedAt: Number(s.now) || Date.now(),
      sourceMessageCount: (memo ? memo.sourceMessageCount : 0) + eligible.length
    });
    if (!next) return { changed: false, reason: 'no-facts', memo: memo, folded: 0, eligible: eligible.length };
    return { changed: true, reason: 'fold', memo: next, folded: eligible.length, eligible: eligible.length, lines: lines.length };
  }
  /* 注入 prompt 的那一段：整行累积到 cap，**绝不**从行中间切断。
     刻意只做"取多少"的决定，不做消毒 —— 消毒是进入 prompt 前的唯一
     canonical 边界（prompt-boundary-core），本函数不发明第二套。 */
  function memorandumPromptText(memo, cap) {
    var m = normalizeMemorandum(memo);
    if (!m) return '';
    return boundMemorandumLines(m.text.split('\n'), Number(cap) > 0 ? Number(cap) : MEMORANDUM_CHAR_CAP);
  }

  /* ══════════ 8. context 组装（纯：输入事实 → 输出待发 messages）═══════════
     spec：{
       selfName, selfSystemPrompt, selfRelationshipToUser,      ← Self
       peerName, peerMissing, peerRelationship, peerNote,       ← Peer（只给允许公开的信息）
       peerProfile, peerIntro, userPresent, userName,           ← User（默认不出现）
       threadMemorandum,                                        ← Shared Past（跨 run）
       history:[{senderId,content,fromPeer,fromUser}],          ← 只含本 thread
       threadContext, nowLabel, topic, turnIndex, trigger
     }

     ── 五层必须独立（Peer Awareness Phase 1 + Thread Memorandum Phase 2）──
     组装结果里这五层各自成块、互不混写，因为它们回答五个不同的问题、
     有各自的真源与生命周期：

       ① SELF          我是谁          ← persona / private context
                                       （system 开头，最高 authority）
       ② PEER          你是谁          ← public-profile-core（构造式白名单，相对稳定）
       ③ RELATIONSHIP  我怎么看你      ← relationRecord（**有向**、每次 run 都会变）
       ④ SHARED PAST   我们以前聊过什么 ← threadMemorandum（**无向**、一对角色一份）
       ⑤ RECENT        我们刚才说了什么 ← 本 thread 的最近 12 条**原文**

     ④ 与 ⑤ 刻意分成两层，因为它们精度不同、生命周期不同：
     ⑤ 是逐字原文（措辞 / 最近的问题 / 承接），窗口外就没了；
     ④ 是更久以前的共同历史（讨论过什么 / 未完成的话题 / 已建立的共同事实），
     由 watermark 推进。**④ 绝不重复 ⑤ 的窗口** —— 这个不重复由
     memorandumEligible() 的 recentStart 从结构上保证，而不是靠提示词自律。

     ④ 的注入位置是**数据块**而不是规则块：它属于 contextual evidence，
     不是 behavior instruction。因此它进的是那条被显式标注为
     「不属于任何人的发言、勿复述」的参考上下文帧，**不**进 system 的
     规则区、更不会被放在 Self Persona 之前 —— 一段可能由模型自己生成的
     历史文本，绝不能获得"改写人格"的 authority。

     所以公开资料里**没有** relationship 字段、关系块里**没有**公开资料。
     合并的代价不是"少一个字段"，而是把"B 是谁"和"A 怎么看 B"变成同一个
     真源的两种说法 —— 于是 A→B 与 B→A 会开始互相污染。
     同理，④ 既不进 ② 也不进 ③：一旦混进去，A 与 B 就会各自"看到"一份不同的
     共同历史（因为 ③ 是有向的），而这恰恰是这一层要避免的。

     绝不在这里读取任何存储；调用方把"已经读到的"事实交进来。 */
  function buildRoleDmContext(spec) {
    var s = spec || {};
    var selfName = str(s.selfName) || 'AI';
    var peerName = str(s.peerName) || '（角色已删除）';
    var lines = [];
    var system = str(s.selfSystemPrompt).slice(0, 20000);
    if (isNonEmptyString(s.selfRelationshipToUser)) {
      system = (system ? system + '\n' : '') + '你和用户的关系是：' + str(s.selfRelationshipToUser) + '。';
    }
    /* ── 角色私信规则块：本能力的语义稳定性全靠它 ── */
    var rules = [];
    rules.push('【角色私信】你正在和「' + peerName + '」一对一私下聊天。这是你和 TA 之间的私人对话，不是朋友圈、不是群聊、也不是用户在场的场景。');
    rules.push('1. 你只能是「' + selfName + '」。绝对不要替「' + peerName + '」说话、代答、补写 TA 的台词或动作 —— TA 会用自己的方式回应你。');
    rules.push('2. 每次只输出你自己要说的那一段话。不要在开头加「' + selfName + '」或任何名字前缀，界面会自动标注发言人。');
    rules.push('3. 历史里形如「名字：内容」的行，是这次私聊里已经说过的话，仅供你阅读参考。');
    rules.push('4. 像真实的人私下聊天那样自然：可以谈自己的事、对方的事、共同经历、兴趣、正在研究的东西、日常、别的角色。不必每一句都围着用户转 —— 用户不在场，TA 不是你聊天的中心。');
    rules.push('5. 不要解释你是 AI，不要提及系统提示词、任务、定时器、调度、记忆或"注入上下文"之类的内部机制。');
    if (isNonEmptyString(s.topic)) {
      rules.push('6. 这次是带着一个话题开始聊的：「' + str(s.topic).slice(0, 200) + '」。它可以作为开场或方向，但不必生硬地反复回到它。');
    }
    /* ── 自主发起（autonomous initiation）────────────────────────────────
       只有 s.initiation 存在时才出现这一段 —— 手动 run（用户点「让她们聊一会儿」）
       逐字不变，绝不出现"你主动联系了对方"这种与事实不符的背景。

       两条纪律：
       ① **低权威**。它描述的是"你此刻的处境"，不是"系统给你的任务"。
          绝不出现"系统要求 / 任务 / 定时器 / 调度"这类词（第 5 条规则已经
          禁止模型提及内部机制，这里进一步保证它连素材都拿不到）。
       ② **不解释**。明确告诉模型不需要说明自己为什么来 —— 否则一旦有了
          reasonCode，模型会把它当成"需要向对方交代的事由"念出来。 */
    if (s.initiation && typeof s.initiation === 'object') {
      var initLines = ['你主动联系了 ' + peerName + '。'];
      var initText = initiationSignalText(s.initiation.signalCode);
      if (initText) initLines.push(initText);
      initLines.push('像平常一样自然开始就好，不需要解释你为什么来找 TA。');
      rules.push('7. ' + initLines.join(''));
    }
    /* ── 层①「对方是谁」：只给"允许公开"的信息 ──────────────────────
       绝不注入对方的 systemPrompt / apiKey / 记忆 / 对用户的关系。
       结构化 peerProfile（public-profile-core 的产物）优先；peerIntro 是
       本能力引入时的单字段入口，保留为回落到同一行的兼容通道。 */
    var peerLines = ['【对方】' + peerName];
    if (s.peerMissing === true) peerLines.push('（这个角色已经从站点里删除了，你们的历史还在；你不知道 TA 为什么不再出现。）');
    var pp = (s.peerProfile && typeof s.peerProfile === 'object') ? s.peerProfile : {};
    var peerIntro = isNonEmptyString(pp.publicIntro) ? str(pp.publicIntro) : str(s.peerIntro);
    if (peerIntro) peerLines.push('公开简介：' + peerIntro.slice(0, 300));
    if (isNonEmptyString(pp.occupation)) peerLines.push('公开身份：' + str(pp.occupation).slice(0, 60));
    var peerTraits = peerListLine(pp.traits, 5, 24);
    if (peerTraits) peerLines.push('公开特征：' + peerTraits);
    var peerInterests = peerListLine(pp.interests, 5, 32);
    if (peerInterests) peerLines.push('兴趣：' + peerInterests);
    if (isNonEmptyString(s.peerNote)) peerLines.push('关于 TA 你已知的信息：' + str(s.peerNote).slice(0, 300));

    /* ── 层②「我怎么看 TA」：来自**有向**关系记录 ──────────────────────
       与层①刻意分开（见 §8 文件头）：公开资料是"B 是谁"，
       这一层是"A 怎么看 B"，两者不同真源、不同生命周期。 */
    var relationBlock = '';
    if (isNonEmptyString(s.peerRelationship)) {
      relationBlock = '【你怎么看 TA】' + str(s.peerRelationship).slice(0, 300);
    }

    var peerBlock = '';
    for (var pi = 0; pi < peerLines.length; pi++) {
      var pl = peerLines[pi];
      if (!pl) continue;
      if (peerBlock && (peerBlock.length + pl.length + 1) > PEER_PROFILE_CHAR_CAP) break;
      peerBlock = peerBlock ? (peerBlock + '\n' + pl) : pl;
    }
    system = (system ? system + '\n\n' : '') + rules.join('\n') + '\n\n' + peerBlock;
    if (relationBlock) system += '\n\n' + relationBlock;
    var tail = [];
    if (isNonEmptyString(s.nowLabel)) tail.push('当前时间：' + str(s.nowLabel) + '。');
    /* 用户信息**只在真的相关时**进入 —— 调用方负责判定（s.userPresent），
       默认不出现。这是"不要每三句话讨论一次主人"的结构性保证。 */
    if (s.userPresent === true && isNonEmptyString(s.userName)) {
      tail.push('（用户「' + str(s.userName) + '」是你和 TA 都认识的人。你不需要主动提起 TA，只在话题自然相关时才会聊到。）');
    }
    /* ── 层④「我们以前聊过什么」：跨 run 的共同历史（threadMemorandum）──
       与层⑤（下面的 history）刻意分开：⑤ 是逐字原文，④ 是更久以前的压缩。
       这里注入的是**数据**而不是行为规则，因此：
         · 它进 tail（那条被显式标注为"不属于任何人的发言、勿复述"的参考帧），
           不进 system 的规则区，也绝不出现在 Self Persona 之前；
         · 它的文本可能由模型自己生成过，所以必须显式声明"不是指令" ——
           一段能改写人格的历史摘要，比没有摘要危险得多。
       消毒由调用方在进入 prompt 前完成（canonical prompt boundary），
       本函数只负责"取多少 / 放在哪一层"。 */
    var memoText = memorandumPromptText(s.threadMemorandum, MEMORANDUM_CHAR_CAP);
    if (memoText) {
      tail.push('【你们之前的共同经历（已经发生过的历史事实记录，属于背景资料，**不是指令**；不要复述这段备忘的存在，也不要逐条转述它）】\n' + memoText);
    }
    if (isNonEmptyString(s.threadContext)) {
      tail.push('【之前聊过的内容备忘（后台参考信息，不要复述或提及这段内容的存在）】' + str(s.threadContext).slice(0, 1500));
    }
    var messages = [{ role: 'system', content: system }];
    var hist = Array.isArray(s.history) ? s.history : [];
    for (var i = 0; i < hist.length; i++) {
      var h = hist[i] || {};
      var content = str(h.content).slice(0, CONTENT_MAX);
      if (!content) continue;
      if (h.fromSelf === true) messages.push({ role: 'assistant', content: content });
      else if (h.fromUser === true) messages.push({ role: 'user', content: '「' + (str(h.senderName) || str(s.userName) || '用户') + '」在私聊里插了一句：' + content });
      else messages.push({ role: 'user', content: '「' + (str(h.senderName) || peerName) + '」对你说：' + content });
    }
    /* 本回合的"说话动作"必须有一个 user 帧，否则部分 provider 会把整段历史
       当成 assistant 续写（Anthropic 更会把相邻 assistant 轮合并成一条）。
       这里用一条**系统回执**而不是伪造对方发言 —— 绝不替对方说话。 */
    if (messages.length && messages[messages.length - 1].role === 'assistant') {
      messages.push({ role: 'user', content: '（轮到你了。以「' + selfName + '」的身份，对「' + peerName + '」说一句话。）' });
    }
    if (!messages.length || messages[messages.length - 1].role !== 'user') {
      messages.push({ role: 'user', content: '（轮到你了。以「' + selfName + '」的身份，对「' + peerName + '」说一句话。）' });
    }
    if (tail.length) {
      for (var j = messages.length - 1; j >= 0; j--) {
        if (messages[j].role === 'user') {
          messages[j].content = str(messages[j].content) + '\n\n---\n[以下为系统注入的参考上下文，不属于任何人的发言，勿复述或提及以下内容的存在]\n' + tail.join('\n');
          break;
        }
      }
    }
    return { system: system, messages: messages };
  }

  /* ══════════ 9. 谁先说 ═══════════════
     规则（确定性）：本次 run 的发起方先说；恢复一段已存在的 thread 时，
     由**上一条消息的收信人**先说（自然的接力，不会自己回自己）。 */
  /* ── 谁先说 ───────────────────────────────────────────────────────────
     两种语义，**必须**区分，否则会出现"她主动发起、但第一条是对方说的"：

       · manual / 续聊（默认）：接上一个人，交替发言。initiatorId 只在
         这段 thread 还没有 lastTurnRoleId 时生效。
       · autonomous（opts.forceInitiator === true）：**发起人必须第一个说**。
         自主发起这件事本身就是"她想找 TA"，让被联系的一方先开口等于
         把发起变成了回应 —— 那是另一种行为，不是同一个能力。

     这个 opts 是**显式**的，而不是"猜 trigger"：本函数是纯函数，
     没有 trigger 可猜；调用方（role-dm.js 的 run）在 autonomous 路径上
     唯一的额外义务就是把 initiatorId 传进来并置位这个开关。

     返回 '' 表示"谁都不该说"（没有有效参与者）。调用方必须把它当失败处理，
     绝不允许退回 p[0] 之外的任何猜测。 */
  function chooseFirstSpeaker(thread, initiatorId, opts) {
    var rec = normalizeThreadRecord(thread || {}) || thread || {};
    var p = Array.isArray(rec.participantIds) ? rec.participantIds.map(str) : [];
    var init = str(initiatorId);
    var o = (opts && typeof opts === 'object') ? opts : {};
    if (o.forceInitiator === true) {
      /* 发起人不在参与者里 ⇒ **返回空**，不静默退化成"让别人先说"。
         一个错误的 initiatorId 必须是一次可见的失败，而不是一次
         看起来正常、实际违背契约的 run。 */
      return (init && p.indexOf(init) >= 0) ? init : '';
    }
    var lastTurn = str(rec.lastTurnRoleId);
    if (lastTurn && p.length === 2) {
      var next = (p[0] === lastTurn) ? p[1] : p[0];
      if (next) return next;
    }
    if (init && p.indexOf(init) >= 0) return init;
    return p[0] || '';
  }

  /* ══════════ 10. memory 边界（决策，不做写入）═══════════════
     只有"真有值得记住的事"的 run 才产出候选，且每 run 每人最多一条。
     本函数**不读任何存储**：调用方把已经读到的行交进来。 */
  function memoryCandidateAllowed(input) {
    var i = input || {};
    if ((Number(i.turns) || 0) < MEMORY_MIN_TURNS) return { ok: false, reason: 'too-short' };
    /* 低信息/重复占主导的 run 不值得扎根。 */
    if ((Number(i.stallCount) || 0) > 0 && (Number(i.turns) || 0) <= MEMORY_MIN_TURNS) return { ok: false, reason: 'low-value' };
    var importance = Number(i.importance) || 0;
    if (importance < MEMORY_MIN_IMPORTANCE) return { ok: false, reason: 'low-importance' };
    if (!isNonEmptyString(i.content)) return { ok: false, reason: 'empty-content' };
    return { ok: true, reason: null };
  }
  /* 每个 run 每人最多一条候选：计数用"本次 run 已写条数"，绝不按消息条数放大。 */
  function memoryBudgetOk(writtenThisRun) {
    return (Number(writtenThisRun) || 0) < MEMORY_MAX_PER_RUN;
  }

  /* ══════════ 11. 稳定错误词表（不新增第二套）═══════════════
     与 runtime/db-failure.js、component-registry 的既有 REASON 词表
     同形（短横线小写）；这里只列本能力**自己**产生的请求级原因。 */
  var REASON = {
    sameCharacter: 'same-character',
    missingCharacter: 'missing-character',
    notReady: 'provider-not-ready',
    noThread: 'thread-not-found',
    threadBusy: 'thread-busy',
    characterBusy: 'character-busy',
    pairCooldown: 'pair-cooldown',
    roleDailyCap: 'role-daily-cap',
    aborted: 'aborted',
    maxTurns: 'max-turns',
    providerFailed: 'provider-failed',
    /* 输出类失败（Phase 3.1）：**请求本身是成功的**，只是这一轮没拿到可用正文。
       它们与 provider-failed 是两件不同的事实，用户该做的事也相反 ——
       provider-failed 才可能指向 key / endpoint / 网络；输出类失败指向
       "模型没有生成正文"（稍后重试，或调整该角色模型的思考/输出设置）。
       两个成员都只在**有界预算 + 一次重试之后仍无正文**时才成立（见 role-dm.js
       runTurn），绝不退化成"任何空回复"。
         output-truncated  有可靠元信息证据表明输出被上限截断（finish_reason=length）
         empty-output      请求成功、无截断证据，但正文仍为空 */
    outputTruncated: 'output-truncated',
    emptyOutput: 'empty-output',
    duplicateStall: 'duplicate-stall',
    persistFailed: 'persist-failed',
    completed: 'run-complete'
  };

  return {
    /* 常量 */
    ROLE_DM_FRIEND_PREFIX: ROLE_DM_FRIEND_PREFIX,
    CONVERSATION_TYPE: CONVERSATION_TYPE,
    MESSAGE_TYPE: MESSAGE_TYPE,
    SCHEMA_VERSION: SCHEMA_VERSION,
    THREAD_ID_PREFIX: THREAD_ID_PREFIX,
    MESSAGE_ID_PREFIX: MESSAGE_ID_PREFIX,
    RELATION_ID_PREFIX: RELATION_ID_PREFIX,
    RUN_LIMITS: RUN_LIMITS,
    PAIR_COOLDOWN_MS: PAIR_COOLDOWN_MS,
    ROLE_DAILY_TURN_MAX: ROLE_DAILY_TURN_MAX,
    ROLE_HOURLY_TURN_MAX: ROLE_HOURLY_TURN_MAX,
    CONTENT_MAX: CONTENT_MAX,
    DUPLICATE_SIMILARITY: DUPLICATE_SIMILARITY,
    STALL_LIMIT: STALL_LIMIT,
    PEER_PROFILE_CHAR_CAP: PEER_PROFILE_CHAR_CAP,
    RELATION_DIMS: RELATION_DIMS,
    RELATION_DEFAULT: RELATION_DEFAULT,
    RELATION_DELTA_CAP: RELATION_DELTA_CAP,
    OBSERVATION_KEEP: OBSERVATION_KEEP,
    MEMORY_MIN_TURNS: MEMORY_MIN_TURNS,
    MEMORY_MIN_IMPORTANCE: MEMORY_MIN_IMPORTANCE,
    MEMORY_MAX_PER_RUN: MEMORY_MAX_PER_RUN,
    MEMORANDUM_SCHEMA_VERSION: MEMORANDUM_SCHEMA_VERSION,
    MEMORANDUM_TEXT_MAX: MEMORANDUM_TEXT_MAX,
    MEMORANDUM_CHAR_CAP: MEMORANDUM_CHAR_CAP,
    MEMORANDUM_LINE_MAX: MEMORANDUM_LINE_MAX,
    MEMORANDUM_MIN_UNCOVERED: MEMORANDUM_MIN_UNCOVERED,
    REASON: REASON,
    /* 身份 */
    canonicalizeParticipants: canonicalizeParticipants,
    roleDmKey: roleDmKey,
    roleDmFriendId: roleDmFriendId,
    isRoleDmFriendId: isRoleDmFriendId,
    isRoleDmMessage: isRoleDmMessage,
    threadIdOf: threadIdOf,
    participantsAreCanonical: participantsAreCanonical,
    newMessageId: newMessageId,
    newRelationId: newRelationId,
    buildThreadRecord: buildThreadRecord,
    normalizeThreadRecord: normalizeThreadRecord,
    /* 消息 */
    buildRoleDmMessage: buildRoleDmMessage,
    validateRoleDmMessage: validateRoleDmMessage,
    messageBelongsToThread: messageBelongsToThread,
    /* 关系 */
    relationKey: relationKey,
    parseRelationKey: parseRelationKey,
    buildRelationRecord: buildRelationRecord,
    normalizeRelationRecord: normalizeRelationRecord,
    relationDelta: relationDelta,
    applyRelationDelta: applyRelationDelta,
    toneCounts: toneCounts,
    /* run 守卫 */
    normalizeRunMode: normalizeRunMode,
    runLimits: runLimits,
    normalizeTurnBudget: normalizeTurnBudget,
    canRunMoreTurn: canRunMoreTurn,
    roleTurnRoomOk: roleTurnRoomOk,
    pairCooldownRemaining: pairCooldownRemaining,
    isDuplicateTurn: isDuplicateTurn,
    diceSimilarity: diceSimilarity,
    lowInfoMatch: lowInfoMatch,
    chooseFirstSpeaker: chooseFirstSpeaker,
    /* autonomous 行为背景（闭集映射；见 §7a）。 */
    initiationSignalText: initiationSignalText,
    initiationSignalCodes: initiationSignalCodes,
    /* thread memorandum（层④）——纯函数，唯一的真源 */
    normalizeMemorandum: normalizeMemorandum,
    memorandumOfThread: memorandumOfThread,
    memorandumCoveredIndex: memorandumCoveredIndex,
    memorandumEligible: memorandumEligible,
    memorandumFoldLines: memorandumFoldLines,
    foldMemorandum: foldMemorandum,
    memorandumPromptText: memorandumPromptText,
    /* context / memory */
    buildRoleDmContext: buildRoleDmContext,
    memoryCandidateAllowed: memoryCandidateAllowed,
    memoryBudgetOk: memoryBudgetOk,
    /* 工具 */
    hashStr: hashStr
  };
});
