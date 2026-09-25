/* ====================================================================
   IB Group Runtime Core — P24-M1 · Group Turn / Member Turn Identity
   --------------------------------------------------------------------
   本模块只回答四个问题（P24 Phase 1 Contract §3/§4）：

     1. 这条消息属于哪一次群体事件？      → groupTurnId
     2. 是哪个角色说的？                  → speakerId（= apiConfigs.id）
     3. 这是该群体事件中的第几个成员回合？ → groupOrder
     4. 该成员自己的 P23 回合身份是什么？   → turnId

   ── 它**不做**什么（越界即缺陷）───────────────────────────────────────
     · 不实现 Participation Planner / Visibility Resolver / Group Context Composer；
     · 不实现 sequence 排序、delivery 队列、拆句、模态策略、voice schema；
     · 不写存储：没有 dbPut / IndexedDB / SQLite / 事务 / 迁移；
     · 不产出任何 canonical 消息（消息只由 delivery-sequence-core 构造）；
     · 不创建 GroupTurn 实体、parent 行、隐藏 system 行。

   ── 纯度 ──────────────────────────────────────────────────────────────
     零 DOM / 零 fetch / 零 IndexedDB / 零 provider / 零 TTS / 零定时器；
     身份只由**输入**决定，因此本文件里不存在任何时钟读取或随机源
     （同一 user message 重放 ⇒ 同一个 groupTurnId）；
     所有校验都是纯函数，返回稳定词表而不是抛异常。

   ── 与 P23 的关系（唯一允许的一次"形状共享"）──────────────────────────
     P23 的回合身份唯一真源是 assets/js/delivery-sequence-core.js:
       turnIdFor(seed) = 'turn_' + CHAT_CORE.stableToken(seed)
     本模块产出**同一个值**：复用 chat-core 的 stableToken 原语（同一个哈希实现），
     不复制第二套哈希；等值性由 tests/test_group_turn_identity.js 的跨模块断言锁住
     （IBGroupRuntime.memberTurnIdFor(...) === IBDeliverySequence.turnIdFor(seed)），
     任何一侧漂移都会立刻变红。

   ── 为什么 speakerId 是 apiConfigs.id 而不是昵称 ────────────────────────
     昵称可改、可重名，是**显示层**；把昵称当身份会让"别人的台词变成我说过的"
     （现存缺陷的根源，见 communication.js 群聊历史映射）。身份必须是稳定 id。

   ── 秘密边界 ─────────────────────────────────────────────────────────
     复用 voice-message-core 的 findSecret（唯一探针），不新增第二套 sanitizer：
     identity context 里任何键名/值命中凭据形态即判不合法（fail closed）。
   ==================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(require('./chat-core.js'), require('./voice-message-core.js')); }
  else { root.IBGroupRuntime = factory(root.IBChatCore, root.IBVoiceMessage); }
})(typeof self !== 'undefined' ? self : this, function (CHAT_CORE, VOICE) {
  'use strict';

  /* ── 契约常量（唯一真源）────────────────────────────────────────────── */
  var GROUP_TURN_PREFIX = 'gturn_';
  var TURN_PREFIX = 'turn_';
  var GROUP_ID_PREFIX = 'group_';
  /* stableToken 是 base36（[0-9a-z]），当前实现给 12 位；这里只约束"是不是一个
     token"，不约束长度 —— 长度是 chat-core 的实现细节，不是本层的契约。 */
  var TOKEN_PATTERN = /^[a-z0-9]{1,32}$/;
  var USER_MESSAGE_ID_PATTERN = /^msg_[A-Za-z0-9_]+$/;
  var GROUP_ID_PATTERN = /^group_[A-Za-z0-9_]+$/;
  var GROUP_TURN_ID_PATTERN = /^gturn_[a-z0-9]{1,32}$/;
  var TURN_ID_PATTERN = /^turn_[a-z0-9]{1,32}$/;
  /* 群成员上限是 10（social.js），这里只做"明显越界即拒绝"的护栏，不重定义上限。 */
  var MAX_GROUP_ORDER = 1000;
  var MAX_ID_LEN = 200;
  /* 控制字符（含换行）：身份值不该带结构字符，否则会污染日志/trace 的元数据面。 */
  var CONTROL_PATTERN = /[\u0000-\u001F\u007F]/;

  function isObject(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
  function str(v) { return v == null ? '' : String(v); }
  function hasSecret(v) {
    try {
      if (VOICE && typeof VOICE.findSecret === 'function') return !!VOICE.findSecret(v);
    } catch (e) { /* 探针不可用 ⇒ 不声称"干净"，交给下面的形状校验兜底 */ }
    return false;
  }
  /* 只接受"可用的 stableToken"：核心缺席时返回 ''，调用方据此退回 legacy 行为，
     绝不用第二套本地哈希补位（那会制造两个真源）。 */
  function tokenOf(input) {
    try {
      if (CHAT_CORE && typeof CHAT_CORE.stableToken === 'function') return str(CHAT_CORE.stableToken(input));
    } catch (e) { /* fallthrough */ }
    return '';
  }
  function posInt(v) {
    var n = Number(v);
    if (!isFinite(n) || n < 0) return -1;
    return Math.floor(n);
  }

  /* ── 1. GroupTurn id ──────────────────────────────────────────────────
     groupTurnId = 'gturn_' + stableToken(triggerUserMessageId)
     确定性来自**输入**：同一个 canonical user message id 永远得到同一个 id。
     注意：user message id 的形状是 msg_<ms>_u（1ms 粒度、无熵），跨会话同毫秒
     可能同 token —— 但 groupTurnId 只在同一个 conversationId 内被比较与消费，
     而"同一个会话内两条 user 消息"被发送锁串行化（communication.js 的
     _chatSendingFor），因此会话内的 identity 不受这层粒度影响。 */
  function groupTurnIdFor(userMessageId) {
    var s = str(userMessageId);
    if (!s) return '';
    var token = tokenOf(s);
    return token ? (GROUP_TURN_PREFIX + token) : '';
  }

  /* ── 2. MemberTurn id ─────────────────────────────────────────────────
     turnId = 'turn_' + stableToken(groupTurnId + ':' + speakerId + ':' + groupOrder)

     为什么种子是复合的而不是 turnIdFor(userMessageId)：
       · 只用户消息 id ⇒ 所有成员共用一个 turnId，P23 的 orderMessages 会把
         整个群回合聚成一个连续块，成员回合边界消失（contract H2）；
       · 只 speakerId ⇒ 同一成员在一次群回合里多次发言（未来的重入/接话）会撞 id。
     复合种子的单射性：末尾一段恒为数字 groupOrder，中间的 speakerId 即使含 ':'
     也无法与另一组 (speakerId, groupOrder) 拼出同一字符串 —— 由 C/B 组测试断言
     "不同 speaker 的 turnId 必不相同"来锁住。 */
  function memberTurnIdFor(groupTurnId, speakerId, groupOrder) {
    var g = str(groupTurnId);
    var sp = str(speakerId);
    var order = posInt(groupOrder);
    if (!g || !sp || order < 0) return '';
    if (order > MAX_GROUP_ORDER) return '';
    var token = tokenOf(g + ':' + sp + ':' + order);
    return token ? (TURN_PREFIX + token) : '';
  }

  /* ── 3. Identity context（运行时对象，不落库）───────────────────────────
     这是 GroupTurn 在本阶段**唯一**的存在形式：内存中的 identity context。
     刷新后丢失 —— Phase 1 §7 明确允许（persistence 的事实来自
     canonical chatMessages.metadata.groupTurnId，而不是这个对象）。

     createdAt 由调用方给（生产中 = 触发本轮的用户消息 timestamp），
     本模块不读时钟：同一输入必须得到逐字相同的对象。 */
  function createIdentityContext(opts) {
    var o = isObject(opts) ? opts : {};
    var trigger = str(o.triggerUserMessageId || o.userMessageId);
    var groupId = str(o.groupId);
    var friendId = str(o.friendId) || groupId;
    var threadId = str(o.threadId);
    var conversationId = '';
    try {
      if (CHAT_CORE && typeof CHAT_CORE.conversationIdOf === 'function') {
        conversationId = str(CHAT_CORE.conversationIdOf(friendId, threadId ? threadId : undefined));
      }
    } catch (e) { conversationId = ''; }
    var ctx = {
      groupTurnId: groupTurnIdFor(trigger),
      groupId: groupId,
      friendId: friendId,
      threadId: threadId,
      conversationId: conversationId,
      triggerUserMessageId: trigger
    };
    var created = Number(o.createdAt);
    if (isFinite(created) && created > 0) ctx.createdAt = Math.floor(created);
    return ctx;
  }

  function createMemberIdentity(ctx, speakerId, groupOrder) {
    var c = isObject(ctx) ? ctx : {};
    var order = posInt(groupOrder);
    var groupTurnId = str(c.groupTurnId);
    var speaker = str(speakerId);
    return {
      turnId: memberTurnIdFor(groupTurnId, speaker, order),
      groupTurnId: groupTurnId,
      speakerId: speaker,
      groupOrder: order
    };
  }

  /* ── 4. 校验（稳定词表；绝不抛异常、绝不修数据）────────────────────────── */

  /* 身份值形状：非空、有界、无控制字符、不是群 id 冒充角色域。
     群 id 冒充角色域这一条与 middle-brain-integrity 的
     MB_GROUP_MEMORY_DENY.GROUP_AS_CHARACTER 同一判据（防"所有成员的私有域
     塌缩进一个群 id"）。 */
  function isUsableSpeakerId(v) {
    var s = str(v);
    if (!s || s.length > MAX_ID_LEN) return false;
    if (CONTROL_PATTERN.test(s)) return false;
    if (s.indexOf(GROUP_ID_PREFIX) === 0) return false;
    return true;
  }

  function validateIdentityContext(ctx) {
    var errors = [];
    if (!isObject(ctx)) return { ok: false, errors: ['not-an-object'] };
    var trigger = str(ctx.triggerUserMessageId);
    if (!trigger) errors.push('missing-trigger-user-message-id');
    else if (!USER_MESSAGE_ID_PATTERN.test(trigger)) errors.push('bad-user-message-id');

    var groupId = str(ctx.groupId);
    if (!groupId) errors.push('missing-group-id');
    else if (!GROUP_ID_PATTERN.test(groupId)) errors.push('bad-group-id');

    var groupTurnId = str(ctx.groupTurnId);
    if (!groupTurnId) errors.push('missing-group-turn-id');
    else if (!GROUP_TURN_ID_PATTERN.test(groupTurnId)) errors.push('bad-group-turn-id');
    /* 确定性：id 必须真的等于从 trigger 派生出来的值（防手写/拼接） */
    else if (trigger && groupTurnId !== groupTurnIdFor(trigger)) errors.push('group-turn-id-mismatch');

    var conversationId = str(ctx.conversationId);
    /* 期望值不在这里字面拼串：conversationId 的派生规则唯一真源是 chat-core，
       本层只做"是不是那个值"的比对（拼串会立刻制造第二份规则）。 */
    var expectedConversationId = '';
    try {
      if (CHAT_CORE && typeof CHAT_CORE.conversationIdOf === 'function' && groupId) {
        expectedConversationId = str(CHAT_CORE.conversationIdOf(groupId, undefined));
      }
    } catch (e) { expectedConversationId = ''; }
    if (!conversationId) errors.push('missing-conversation-id');
    else if (!expectedConversationId) errors.push('conversation-id-unverifiable');
    else if (conversationId !== expectedConversationId) errors.push('conversation-id-mismatch');

    if (hasSecret({
      groupTurnId: groupTurnId, groupId: groupId, friendId: str(ctx.friendId),
      threadId: str(ctx.threadId), conversationId: conversationId, triggerUserMessageId: trigger
    })) errors.push('secret-in-identity');

    return { ok: errors.length === 0, errors: errors };
  }

  function validateMemberIdentity(member) {
    var errors = [];
    if (!isObject(member)) return { ok: false, errors: ['not-an-object'] };
    var groupTurnId = str(member.groupTurnId);
    if (!groupTurnId) errors.push('missing-group-turn-id');
    else if (!GROUP_TURN_ID_PATTERN.test(groupTurnId)) errors.push('bad-group-turn-id');

    var speakerId = str(member.speakerId);
    if (!speakerId) errors.push('missing-speaker-id');
    else if (!isUsableSpeakerId(speakerId)) errors.push('bad-speaker-id');

    var order = posInt(member.groupOrder);
    if (order < 0 || order > MAX_GROUP_ORDER) errors.push('bad-group-order');

    var turnId = str(member.turnId);
    if (!turnId) errors.push('missing-turn-id');
    /* 硬约束 groupTurnId !== turnId 先判：它比形状更根本（形状检查会把它掩盖成 bad-turn-id） */
    else if (turnId === groupTurnId) errors.push('turn-id-equals-group-turn-id');
    else if (!TURN_ID_PATTERN.test(turnId)) errors.push('bad-turn-id');
    /* 确定性：值必须真的等于派生值（防手写/拼接） */
    else if (groupTurnId && speakerId && order >= 0 && turnId !== memberTurnIdFor(groupTurnId, speakerId, order)) errors.push('turn-id-mismatch');

    if (hasSecret({
      turnId: turnId, groupTurnId: groupTurnId, speakerId: speakerId, groupOrder: order
    })) errors.push('secret-in-identity');

    return { ok: errors.length === 0, errors: errors };
  }

  function isGroupTurnId(v) { return GROUP_TURN_ID_PATTERN.test(str(v)); }
  function isMemberTurnId(v) { return TURN_ID_PATTERN.test(str(v)); }

  /* ══════════════════════════════════════════════════════════════════
     P24-M2 · Speaker Identity Resolution（canonical identity 读路径）
     ------------------------------------------------------------------
     为什么需要它：群聊历史此前用 `senderName === selfName` 判断"这是我自己说过的吗"。
     昵称不是身份 —— 两个角色同名时，A 的历史回复会被 B 当成"自己说过的话"，
     污染 persona continuity / self-history / 未来的 Group Brain。

     唯一权威 = message.metadata.speakerId（M1 起由 Sequence extraMetadata 写入）。
     senderName 只剩两个合法用途：显示，以及**唯一精确匹配**的 legacy 回退。

     不对称安全规则（本层最重要的语义，M2 frozen invariant）：
       只有 resolved speakerId === currentSpeakerId 才是 SELF。
       unresolved / ambiguous / invalid / legacy 冲突 一律不是 SELF（判为 OTHER/UNKNOWN）。
       —— false negative（把自己的旧话当别人的）只损失一点上下文；
          false positive（把别人的话当自己说的）会污染角色连续性。两者不对称。

     纯度：本区块零 DOM / 零 fetch / 零存储 / 零时钟 / 零随机 / 零副作用；
     只做 identity → 分类，绝不 build prompt / 查 Memory / 选参与者 / 调模型。
     ══════════════════════════════════════════════════════════════════ */

  /* 参与者归一：接受 ['friend_a'] 或 [{id,name}] 混合输入 → [{id,name}]（去重、保持顺序）。
     参与者名单的**权威来源是调用方**（生产 = canonical groups.members + apiConfigs 显示名），
     本模块绝不自己维护第二份 participant registry。 */
  function normalizeParticipants(list) {
    var out = [];
    if (!Array.isArray(list)) return out;
    for (var i = 0; i < list.length; i++) {
      var raw = list[i];
      var id = '', name = '';
      if (isObject(raw)) { id = str(raw.id); name = str(raw.name); }
      else id = str(raw);
      id = id.trim();
      if (!id) continue;
      var dup = false;
      for (var j = 0; j < out.length; j++) if (out[j].id === id) { dup = true; break; }
      if (dup) continue;
      out.push({ id: id, name: name.trim() });
    }
    return out;
  }

  /* ── resolveSpeakerId(message, opts) ──────────────────────────────────
     opts = { participants: [...] }（参与者权威由调用方给出）
     返回 { speakerId, source, confidence, reason }：
       source     ∈ 'metadata' | 'legacy-exact-name' | 'unresolved'
       confidence ∈ 'canonical' | 'legacy' | 'none'
       reason     稳定词表（unresolved 时给出原因，供测试与 M3 使用；不含正文）

     优先级（唯一顺序，不做任何猜测）：
       ① role==='user' ⇒ 不解析（用户不是角色参与者，§10：不发明 user identity）
       ② metadata.speakerId 存在：
            shape 非法 / 命中秘密形态 ⇒ invalid-speaker-id（**不**降级到名字匹配）
            不属于当前 participants ⇒ speaker-not-a-participant（同样不降级）
            合法且属于 ⇒ canonical
       ③ legacy：senderName 与 participants 的显示名**唯一精确匹配** ⇒ legacy
          0 个匹配 ⇒ legacy-no-match；≥2 个匹配（同名）⇒ legacy-ambiguous（fail closed）
     明确禁止：pick first / 按 groupOrder 猜 / 按 timestamp 猜 / 按 model 猜 / 按数组位置猜。 */
  function resolveSpeakerId(message, opts) {
    var none = function (reason) { return { speakerId: '', source: 'unresolved', confidence: 'none', reason: reason }; };
    if (!isObject(message)) return none('not-an-object');
    var role = str(message.role);
    if (role === 'user') return none('user-role');
    var o = isObject(opts) ? opts : {};
    var participants = normalizeParticipants(o.participants);
    if (!participants.length) return none('no-participants');

    var md = isObject(message.metadata) ? message.metadata : null;
    var sid = md ? str(md.speakerId).trim() : '';
    if (sid) {
      if (!isUsableSpeakerId(sid) || hasSecret({ speakerId: sid })) return none('invalid-speaker-id');
      var member = null;
      for (var i = 0; i < participants.length; i++) if (participants[i].id === sid) { member = participants[i]; break; }
      if (!member) return none('speaker-not-a-participant');
      return { speakerId: member.id, source: 'metadata', confidence: 'canonical', reason: '' };
    }

    var name = str(message.senderName).trim();
    if (!name) return none('no-name');
    var hits = [];
    for (var k = 0; k < participants.length; k++) if (participants[k].name && participants[k].name === name) hits.push(participants[k]);
    if (hits.length === 1) return { speakerId: hits[0].id, source: 'legacy-exact-name', confidence: 'legacy', reason: '' };
    if (hits.length > 1) return none('legacy-ambiguous');
    return none('legacy-no-match');
  }

  /* ── classifyMessageForSpeaker(message, currentSpeakerId, participants) ──
     返回 'USER' | 'SELF' | 'OTHER' | 'UNKNOWN'（纯函数，供 group context 映射使用）。
       USER    : role==='user'（不做角色解析）
       SELF    : 解析出的 speakerId === currentSpeakerId（**只有这一条路**）
       OTHER   : 解析出 speakerId，但不是当前角色
       UNKNOWN : 无法解析（歧义 / 非法 / 不在群内 / 缺参与者 / system 行）—— 永远不是 SELF */
  function classifyMessageForSpeaker(message, currentSpeakerId, participants) {
    if (!isObject(message)) return 'UNKNOWN';
    if (str(message.role) === 'user') return 'USER';
    if (str(message.role) === 'system') return 'UNKNOWN';
    var cur = str(currentSpeakerId).trim();
    if (!cur) return 'UNKNOWN';
    var r = resolveSpeakerId(message, { participants: participants });
    if (r.confidence === 'none') return 'UNKNOWN';
    return (r.speakerId === cur) ? 'SELF' : 'OTHER';
  }

  /* ══════════════════════════════════════════════════════════════════
     P24-M3.3.3.1 · Recent Speaker Derivation（pure helper · capability only）
     ------------------------------------------------------------------
     canonical ordered group history snapshot → `recentSpeakerIds`（**most-recent-first**）。

     定位（本阶段只做 capability，生产不启用）：
       · **不是** eligibility authority、**不是** hard suppression、**不是** runtime filter；
       · 未来只是 budget competition 里的 selection priority input（本阶段甚至不接 selection）。

     冻结语义：
       · window 单位 = **MemberTurn**（不是 message）：同一 MemberTurn 的多条 canonical 消息
         （multipart / 工具续轮：同 turnId、sequenceIndex 递增）只占 **1 个 slot**；
       · 只有 **resolved 且属于当前 participants 的 assistant 消息**消耗 window；
         user / system / UNKNOWN / unresolved / ambiguous / 非本群成员 一律忽略
         —— 它们绝不能把真正的发言者挤出窗口；
       · 身份只经 M2 `resolveSpeakerId`（canonical `metadata.speakerId` 优先；legacy 唯一
         精确显示名回退；ambiguous / unresolved 丢弃）；绝不 `senderName === xxx` 直接判定、绝不猜；
       · MemberTurn dedupe key 优先级：
           ① `metadata.turnId`
           ② `metadata.groupTurnId + ':' + resolvedSpeakerId`（仅当两者都存在）
           ③ `message.id`（legacy 退化：一条消息 = 一个 MemberTurn，允许）
         绝不只用 groupTurnId 去重（同一 GroupTurn 含多个 speaker 的 MemberTurn）；
         绝不按 timestamp / senderName 猜 turn 边界；
       · 输出按 most-recent-first，并对 **speaker 去重**（保留最新位置）；
       · `history` 假定**已 canonical 排序（oldest → newest）**（`_ibOrderMessages` 契约），
         因此扫描方向是**从尾到头**（index 遍历，绝不 sort / reverse / splice 输入）；
       · 纯：零 DB / IndexedDB / DOM / localStorage / fetch / timer / 时钟 / 随机。
     ══════════════════════════════════════════════════════════════════ */
  var RECENT_SPEAKER_ERRORS = Object.freeze(['bad-history', 'bad-participants', 'bad-opts', 'bad-window']);
  function validateRecentSpeakerInput(history, participants, opts) {
    var errors = [];
    if (!Array.isArray(history)) errors.push('bad-history');
    if (!Array.isArray(participants)) errors.push('bad-participants');
    else {
      for (var i = 0; i < participants.length; i++) {
        var p = participants[i];
        var okEntry = (typeof p === 'string' && !!p.trim())
          || (isObject(p) && typeof p.id === 'string' && !!p.id.trim());
        if (!okEntry) { errors.push('bad-participants'); break; }
      }
    }
    if (!isObject(opts)) errors.push('bad-opts');
    else {
      var w = opts.window;
      /* window 必须是**非负有限整数**：不 normalize、不 clamp、不 parseInt、不隐式转换。 */
      if (typeof w !== 'number' || !isFinite(w) || Math.floor(w) !== w || w < 0) errors.push('bad-window');
    }
    return { ok: errors.length === 0, errors: errors };
  }
  function deriveRecentSpeakerIds(history, participants, opts) {
    var verdict = validateRecentSpeakerInput(history, participants, opts);
    if (!verdict.ok) throw participationContractError(verdict.errors);
    var windowSize = opts.window;
    if (windowSize === 0) return { recentSpeakerIds: [] };
    var parts = normalizeParticipants(participants);
    if (!parts.length) return { recentSpeakerIds: [] };
    var seenTurns = Object.create(null);
    var out = [];
    var used = 0;
    for (var i = history.length - 1; i >= 0 && used < windowSize; i--) {
      var m = history[i];
      if (!isObject(m) || str(m.role) !== 'assistant') continue;   /* user / system / 其它 一律不消耗 window */
      var r = resolveSpeakerId(m, { participants: parts });
      if (r.confidence === 'none') continue;                        /* unresolved / ambiguous / 非本群：忽略，绝不猜 */
      var md = isObject(m.metadata) ? m.metadata : null;
      var turnId = md ? str(md.turnId).trim() : '';
      var groupTurnId = md ? str(md.groupTurnId).trim() : '';
      var key = turnId ? ('t:' + turnId)
        : (groupTurnId ? ('g:' + groupTurnId + '\u0000' + r.speakerId) : ('m:' + str(m.id)));
      if (seenTurns[key]) continue;                                 /* 同一 MemberTurn 只占 1 个 slot */
      seenTurns[key] = true;
      used++;
      if (out.indexOf(r.speakerId) < 0) out.push(r.speakerId);      /* speaker 去重：首次（最新）出现即保留 */
    }
    return { recentSpeakerIds: out };
  }

  /* ══════════════════════════════════════════════════════════════════
     P24-M3.1 · Participation Contract + Deterministic Rule Planner
     ------------------------------------------------------------------
     唯一职责：回答 **WHO GETS A MEMBER TURN**（谁获得一次成员回合）。
     它不是 Group Brain（不做模型判断）、不是 delivery（不产 timing/sequence）、
     不是 storage（不写库、不建消息、不建 system 行）。

     ── 冻结不变量（M3.1 contract）──────────────────────────────────────
       P1 runtime-only：plan 只存在于内存；不落库、不进消息 metadata。
       P2 decision 词表 = 'speak'（第一版 entries 只放真正拿到 MemberTurn 的人；
          SKIP 的成员进 omitted）。不含 DEFER / INTERJECT。
       P3 reason 闭集（见 PARTICIPATION_REASONS），绝不自由文本。
       P4 order = **计划发言顺序**（planned participant order，0 起、按 participants
          数组顺序递增）。运行期失败会留下空洞（如 0,2）—— **空洞合法**，
          绝不为了连续把后面的 order 前移。它不是 successful speaker order。
       P5 同 input ⇒ deep-equal plan：无时钟、无随机、顺序只来自 participants 数组，
          且不依赖 trigger.text / history（两者都不参与规则判定）。
       P6 不改写 input、不复用 participant 对象引用（输出对象全部新建）。
       P7 沉默不是消息：SKIP/omitted 只留在 plan 里，不产生任何 canonical 消息。
       P8 参与者身份只认 canonical id（apiConfigs.id）；昵称/senderName 绝不参与；
          未知 status / 重复 id / 非法 id 一律 **fail closed**（抛 contract error），
          绝不静默 normalize 成 active、绝不 pick first。
       P9 budget（M3.3.2，contract v2）：input 可带 `maxResponders`（undefined/null = 无上限；
          非负有限整数以外一律 fail closed）。截断只发生在**本函数内**，且只在
          `eligible 数 > cap`（真实竞争）时启用 mentioned-first（mentioned 内部保持 participant
          顺序）；无竞争时绝不 reorder。order 在 selection 之后分配 0..k-1；溢出者进
          omitted('budget-limit')，omitted 始终按 participant 输入顺序。生产默认不传 cap。
     ══════════════════════════════════════════════════════════════════ */
  var PARTICIPATION_PLANNER_ID = 'group-rule-v1';
  /* P24-M3.3.2 · 契约版本 1 → 2：input schema（maxResponders）、reason 词表
     （budget-limit 转正）、以及 budget 竞争下的选择语义都发生了变化。
     P24-M3.3.3.2 · 契约版本 2 → 3：input schema 增加 recentSpeakerIds、
     budget 竞争下的 selection 增加 recent-aware tiers（reason 词表不变）。
     plannerId 不变（仍是同一条规则型 planner）。 */
  var PARTICIPATION_PLAN_VERSION = 3;
  /* 参与状态枚举（与 social.js 的 group.members[].status 逐字同源）。 */
  var PARTICIPANT_STATUSES = ['active', 'muted', 'removed'];
  var PARTICIPATION_REASONS = Object.freeze({
    SPEAK: Object.freeze(['active-default', 'mentioned']),
    /* P24-M3.3.2：budget-limit 转正（eligible 但因 responder budget 未获得 MemberTurn）。 */
    SKIP: Object.freeze(['muted-not-mentioned', 'removed', 'budget-limit']),
    /* 契约为后续阶段预留：M3.3.2 仍**不产生**（无 apiConfigs 的成员在集成层之前就被过滤）。 */
    RESERVED: Object.freeze(['no-config'])
  });
  var PARTICIPATION_ERRORS = Object.freeze([
    'not-an-object',
    'missing-group-turn-id', 'bad-group-turn-id',
    'missing-trigger', 'bad-trigger', 'missing-user-message-id', 'bad-user-message-id', 'bad-trigger-text',
    'missing-participants', 'bad-participants',
    'participant-not-object', 'missing-participant-id', 'bad-participant-id',
    'duplicate-participant-id', 'missing-participant-status', 'bad-participant-status', 'bad-mentioned',
    'bad-max-responders',
    'bad-recent-speakers',
    'secret-in-input'
  ]);

  /* ── validateParticipationInput(input) → { ok, errors[] } ────────────────
     稳定词表（错误项带下标时形如 'bad-participant-status:2'）；绝不抛异常、绝不修数据。 */
  function validateParticipationInput(input) {
    var errors = [];
    if (!isObject(input)) return { ok: false, errors: ['not-an-object'] };

    var groupTurnId = str(input.groupTurnId).trim();
    if (!groupTurnId) errors.push('missing-group-turn-id');
    else if (!isGroupTurnId(groupTurnId)) errors.push('bad-group-turn-id');

    var trigger = input.trigger;
    var userMessageId = '';
    if (!isObject(trigger)) errors.push('missing-trigger');
    else {
      userMessageId = str(trigger.userMessageId).trim();
      if (!userMessageId) errors.push('missing-user-message-id');
      else if (!USER_MESSAGE_ID_PATTERN.test(userMessageId)) errors.push('bad-user-message-id');
      if (trigger.text != null && typeof trigger.text !== 'string') errors.push('bad-trigger-text');
    }

    var participants = input.participants;
    var participantIdMap = Object.create(null);   /* 供 recentSpeakerIds 的 membership 校验使用 */
    if (participants == null) errors.push('missing-participants');
    else if (!Array.isArray(participants)) errors.push('bad-participants');
    else {
      var seen = Object.create(null);
      for (var i = 0; i < participants.length; i++) {
        var p = participants[i];
        if (!isObject(p)) { errors.push('participant-not-object:' + i); continue; }
        var id = str(p.id).trim();
        if (!id) errors.push('missing-participant-id:' + i);
        else if (!isUsableSpeakerId(id)) errors.push('bad-participant-id:' + i);
        else if (seen[id]) errors.push('duplicate-participant-id:' + i);
        if (id) { seen[id] = true; participantIdMap[id] = true; }
        var status = str(p.status).trim();
        if (!status) errors.push('missing-participant-status:' + i);
        else if (PARTICIPANT_STATUSES.indexOf(status) < 0) errors.push('bad-participant-status:' + i);
        if (p.mentioned != null && typeof p.mentioned !== 'boolean') errors.push('bad-mentioned:' + i);
      }
    }

    /* P24-M3.3.2 · maxResponders：允许 undefined / null（= 无上限），
       或**非负有限整数**。禁止隐式转换：-1 / 1.5 / '2' / NaN / Infinity / true / {} / []
       一律 validation failure（fail closed，绝不 normalize）。 */
    var cap = input.maxResponders;
    if (cap != null) {
      if (typeof cap !== 'number' || !isFinite(cap) || Math.floor(cap) !== cap || cap < 0) errors.push('bad-max-responders');
    }

    /* P24-M3.3.3.2 · recentSpeakerIds（可选）：
         · undefined ⇒ 视为 []（等价缺失）；
         · **null ⇒ 非法**（这是数组契约，与 maxResponders 的 null=unlimited 不同语义）；
         · 必须是非空 canonical 字符串 id、且**属于当前 participants**；重复允许（后者由 planner 归一）；
         · 任何非法元素（''/null/数字/布尔/对象/数组/非本群 id/凭据形态）⇒ fail closed。
       planner **只做 membership 校验**，绝不解析身份（不调 resolveSpeakerId、不做 senderName/config_id 回退）。 */
    var recentInput = input.recentSpeakerIds;
    if (recentInput !== undefined) {
      if (recentInput === null || !Array.isArray(recentInput)) errors.push('bad-recent-speakers');
      else {
        for (var ri = 0; ri < recentInput.length; ri++) {
          var rid = recentInput[ri];
          var ridS = (typeof rid === 'string') ? rid.trim() : '';
          var badRecent = (typeof rid !== 'string') || !ridS || !isUsableSpeakerId(ridS)
            || hasSecret({ speakerId: ridS }) || !participantIdMap[ridS];
          if (badRecent) { errors.push('bad-recent-speakers'); break; }
        }
      }
    }

    /* 秘密边界：只探**结构性身份字段**（id / groupTurnId / userMessageId / status）。
       trigger.text 与 history 是受限的正文载体，**不**直接送进探针（否则普通用户
       正文会被误判）；它们由 P-不变量保证**绝不进入 output**。 */
    if (!errors.length && hasSecret({
      groupTurnId: groupTurnId,
      userMessageId: userMessageId,
      participants: (Array.isArray(participants) ? participants : []).map(function (p) {
        return { id: str(p && p.id).trim(), status: str(p && p.status).trim() };
      })
    })) errors.push('secret-in-input');

    return { ok: errors.length === 0, errors: errors };
  }

  function participationContractError(errors) {
    var e = new Error('participation-contract: ' + errors.join(','));
    e.code = 'PARTICIPATION_CONTRACT';
    e.errors = errors.slice();
    return e;
  }

  /* ── planParticipation(input) ───────────────────────────────────────────
     规则（逐字等价于当前生产 `speakingCfgs` 语义）：
       status === 'removed'                       → omitted / 'removed'          （即使被 @）
       status === 'muted'   && mentioned !== true → omitted / 'muted-not-mentioned'
       status === 'muted'   && mentioned === true → speak   / 'mentioned'
       status === 'active'  && mentioned === true → speak   / 'mentioned'          （mention 不改变 active 的参与结果，但保留 runtime fact）
       status === 'active'                        → speak   / 'active-default'
     order：按 participants 数组顺序对 speak 者从 0 递增；skip 者不占 order。
     非法 input ⇒ 抛 contract error（fail closed，不静默跳过）。 */
  function planParticipation(input) {
    var verdict = validateParticipationInput(input);
    if (!verdict.ok) throw participationContractError(verdict.errors);
    var participants = input.participants;
    var cap = (input.maxResponders == null) ? null : input.maxResponders;
    /* recentSpeakerIds 归一：undefined → 空；重复**保留首次出现顺序**（deterministic），
       planner 只用 membership（tier 内仍按 participant input order，不按本数组顺序重排）。
       不修改输入数组（只读遍历 + 写进本地 map）。 */
    var recentMap = Object.create(null);
    if (Array.isArray(input.recentSpeakerIds)) {
      for (var ri = 0; ri < input.recentSpeakerIds.length; ri++) recentMap[str(input.recentSpeakerIds[ri]).trim()] = true;
    }

    /* ── Phase A · ELIGIBILITY（与 M3.1/M3.2 逐字等价；此处**不**分配 groupOrder）──
       规则：removed → omitted('removed')；muted 且未点名 → omitted('muted-not-mentioned')；
             其余（active，或 muted+mentioned）→ eligible（reason = mentioned | active-default）。
       内部结构 eligibleCandidates 只用于预算取舍，**绝不进入 output**。 */
    var eligibleCandidates = [];
    var omittedByIndex = Object.create(null);   /* participantIndex → reason（输出时按 participant 顺序） */
    for (var i = 0; i < participants.length; i++) {
      var p = participants[i];
      var id = str(p.id).trim();
      var status = str(p.status).trim();
      var mentioned = (p.mentioned === true);
      if (status === 'removed') { omittedByIndex[i] = 'removed'; continue; }
      if (status === 'muted') {
        if (!mentioned) { omittedByIndex[i] = 'muted-not-mentioned'; continue; }
        eligibleCandidates.push({ speakerId: id, reason: 'mentioned', participantIndex: i, mentioned: true });
        continue;
      }
      /* status === 'active' */
      eligibleCandidates.push({ speakerId: id, reason: mentioned ? 'mentioned' : 'active-default', participantIndex: i, mentioned: mentioned });
    }

    /* ── Phase B · BUDGET SELECTION ──
       · cap == null（undefined / null）⇒ 无上限：**保持 participant 顺序，绝不 reorder**（recent 不参与）；
       · cap != null 但 eligibleCandidates.length <= cap ⇒ 没有真实竞争
         ⇒ 同样保持 participant 顺序（recent / mentioned 都不 reorder）；
       · **真实竞争**（eligible > cap）⇒ recent-aware tiers：
           tier1 = mentioned（含 mentioned+recent；用户显式点名豁免 recent penalty）
           tier2 = !mentioned && !recent（fresh unmentioned）
           tier3 = !mentioned && recent（recent unmentioned）
         每个 tier 内部严格 participant input order（不按 recentSpeakerIds 数组顺序）；
         取前 cap；溢出者 → omitted('budget-limit')（**不新增 recent 专用 reason**）。
       order 只在最终 selected 上分配（0..k-1）；omitted 仍按 participant 顺序输出。 */
    var selected = eligibleCandidates;
    if (cap !== null && eligibleCandidates.length > cap) {
      var tier1 = [];
      var tier2 = [];
      var tier3 = [];
      for (var a = 0; a < eligibleCandidates.length; a++) {
        var cand = eligibleCandidates[a];
        if (cand.mentioned) tier1.push(cand);
        else if (!recentMap[cand.speakerId]) tier2.push(cand);
        else tier3.push(cand);
      }
      var selectionOrder = tier1.concat(tier2, tier3);
      selected = selectionOrder.slice(0, cap);
      var overflow = selectionOrder.slice(cap);
      for (var b = 0; b < overflow.length; b++) omittedByIndex[overflow[b].participantIndex] = 'budget-limit';
    }

    var entries = [];
    for (var s = 0; s < selected.length; s++) {
      entries.push({ speakerId: selected[s].speakerId, decision: 'speak', order: s, reason: selected[s].reason });
    }
    var omitted = [];
    for (var oi = 0; oi < participants.length; oi++) {
      var why = omittedByIndex[oi];
      if (why == null) continue;
      omitted.push({ speakerId: str(participants[oi].id).trim(), reason: why });
    }
    return {
      groupTurnId: str(input.groupTurnId).trim(),
      plannerId: PARTICIPATION_PLANNER_ID,
      planVersion: PARTICIPATION_PLAN_VERSION,
      entries: entries,
      omitted: omitted
    };
  }

  /* ══════════════════════════════════════════════════════════════════
     P24-M3.4.1 · Group Participation Policy Resolution（pure · capability only）
     ------------------------------------------------------------------
     唯一职责：把三份**已经切出来的 policy fragment**按固定优先级合成一个
     "唯一的、确定的、可解释的" resolved policy：

        group explicit  >  user default  >  system default      （**per field**）

     为什么只吃 fragment（不吃 group object / apiSettings / runtime object）：
       存储形状（groups store / apiSettings / localStorage）、MB、Memory、Economy
       全属于 adapter。把它们放进 resolver，会让"存储改字段"变成"政策核心改语义"。
       本区块只做 precedence + validation：零存储 / 零 DOM / 零网络 / 零定时器。

     允许字段（**闭集**，白名单）：
       maxResponders        非负有限整数（0 合法 = 本轮无人回复）
       recentSpeakerWindow  非负有限整数（0 合法 = 关闭 recent 偏好）
       任何其它字段 ⇒ 'unknown-field'（fail closed；绝不静默忽略）。

     absence ≠ 0：
       字段缺失 = "没有策略"（返回里不出现该键、也不出现它的 source）；
       显式 0 是**真值**，必须覆盖低优先层（用 own property 判定，禁止 `||` 回退）。

     fail closed：
       任意一层 fragment 非法 ⇒ 整次解析抛 PARTICIPATION_POLICY_CONTRACT。
       绝不"高优先层非法 ⇒ 退回低优先层"（那会把错误配置静默隐藏），
       也绝不 normalize / clamp / 隐式转换 / 回显原 fragment。

     sources 只是**诊断**（UI 展示 / 审计）：绝不进 planner output、
     chatMessages.metadata、provider prompt、Memory、P23；本模块不持久化任何东西。

     与 planner 的关系：resolver 是 planner 的**上游**（adapter 先 resolve，再把
     具体值放进 planning input）。planner 本体永不调用它 —— 因此
     planVersion 仍为 3、reason 词表不变、本阶段 production 零接线。
     ══════════════════════════════════════════════════════════════════ */
  var PARTICIPATION_POLICY_FIELDS = Object.freeze(['maxResponders', 'recentSpeakerWindow']);
  var PARTICIPATION_POLICY_SOURCES = Object.freeze(['group', 'user', 'system']);
  var PARTICIPATION_POLICY_ERRORS = Object.freeze([
    'bad-fragment',
    'unknown-field',
    'bad-max-responders',
    'bad-recent-speaker-window'
  ]);

  /* plain fragment 判定：只接受 Object.prototype 或 null prototype。
     其它 prototype（例如 Object.create({maxResponders:2})）一律 fail closed ——
     否则"继承来的字段"会被当成显式策略（prototype trick 通道）。
     同时排除 null / array / 原始值（它们不是 fragment，见 'bad-fragment'）。 */
  function isPlainPolicyFragment(v) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
    var proto = Object.getPrototypeOf(v);
    return proto === Object.prototype || proto === null;
  }
  /* 非负有限整数：不 normalize / 不 clamp / 不隐式转换。
     '2' / true / 1.5 / NaN / Infinity / null / {} / [] 全部不合格；
     -0 等价于 0（>=0 且 Math.floor(-0) === -0）。 */
  function isNonNegativeInt(v) {
    return typeof v === 'number' && isFinite(v) && Math.floor(v) === v && v >= 0;
  }
  /* validateParticipationPolicyFragment(fragment) → { ok, errors[] }
     稳定词表（与 planner 的 validate* 同风格，绝不抛异常、绝不修数据）：
       'bad-fragment'                fragment 存在但不是 plain object
       'unknown-field'               出现白名单之外的字段（**不回显**字段名/值）
       'bad-max-responders'          maxResponders 不是非负有限整数
       'bad-recent-speaker-window'   recentSpeakerWindow 不是非负有限整数
     undefined = 合法（等价"没有策略"）。

     扫描面 = **全部 own property name**（enumerable 与 non-enumerable 都要看）：
     precedence 用 hasOwnProperty 取值，因此"验证看 enumerable、取值看 own" 会留下
     fail-open 缺口（Object.defineProperty 定义的隐藏字段可以绕过校验直接进入 policy）。
     两端必须口径一致：**own property 一律验证、一律可作显式值；inherited 一律不认**。 */
  function validateParticipationPolicyFragment(fragment) {
    if (fragment === undefined) return { ok: true, errors: [] };
    if (!isPlainPolicyFragment(fragment)) return { ok: false, errors: ['bad-fragment'] };
    var errors = [];
    var keys = Object.getOwnPropertyNames(fragment);   /* 全部 own（含 non-enumerable） */
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      if (PARTICIPATION_POLICY_FIELDS.indexOf(k) < 0) { errors.push('unknown-field'); continue; }
      if (!isNonNegativeInt(fragment[k])) {
        errors.push(k === 'maxResponders' ? 'bad-max-responders' : 'bad-recent-speaker-window');
      }
    }
    return { ok: errors.length === 0, errors: errors };
  }
  function participationPolicyContractError(errors) {
    var e = new Error('participation-policy-contract: ' + errors.join(','));
    e.code = 'PARTICIPATION_POLICY_CONTRACT';
    e.errors = errors.slice();
    return e;
  }
  /* ── resolveParticipationPolicy(groupPolicy, userDefaults, systemDefaults) ──
     固定优先级：group > user > system，且**逐字段**判定（不是整对象胜出）。
     例：group{maxResponders:2} + user{recentSpeakerWindow:3} + system{两个都有}
         ⇒ policy{maxResponders:2, recentSpeakerWindow:3}
            sources{maxResponders:'group', recentSpeakerWindow:'user'}
     三层全 undefined / {} ⇒ { policy:{}, sources:{} }（**不物化**默认值，
     以保持今天 production 的 absence 语义：capability 缺失 = unlimited）。
     任一层非法 ⇒ 抛 PARTICIPATION_POLICY_CONTRACT（fail closed，绝不 fallback）。 */
  function resolveParticipationPolicy(groupPolicy, userDefaults, systemDefaults) {
    var layers = [
      { source: PARTICIPATION_POLICY_SOURCES[0], fragment: groupPolicy },
      { source: PARTICIPATION_POLICY_SOURCES[1], fragment: userDefaults },
      { source: PARTICIPATION_POLICY_SOURCES[2], fragment: systemDefaults }
    ];
    var errors = [];
    for (var i = 0; i < layers.length; i++) {
      var verdict = validateParticipationPolicyFragment(layers[i].fragment);
      if (verdict.ok) continue;
      for (var j = 0; j < verdict.errors.length; j++) errors.push(verdict.errors[j]);
    }
    if (errors.length) throw participationPolicyContractError(errors);
    var policy = {};
    var sources = {};
    for (var f = 0; f < PARTICIPATION_POLICY_FIELDS.length; f++) {
      var field = PARTICIPATION_POLICY_FIELDS[f];
      for (var l = 0; l < layers.length; l++) {
        var frag = layers[l].fragment;
        if (frag && Object.prototype.hasOwnProperty.call(frag, field)) {
          policy[field] = frag[field];
          sources[field] = layers[l].source;
          break;
        }
      }
    }
    return { policy: policy, sources: sources };
  }

  /* ══════════════════════════════════════════════════════════════════
     P24-M3.2 · Canonical Mention Resolution（@ token → participant id）
     ------------------------------------------------------------------
     与 participation planning **分属两步**（planner 只吃 mentioned 布尔）：
     本函数把用户文本里的 @ token 解析成 canonical participant id。

     规则（精确、无模糊、fail closed）：
       · token = '@' 或 '＠' + 显示名；@ 前必须是边界（行首 / 空白 / 标点），
         名字后也必须是边界（空白 / 标点 / 行尾）——因此 `foo@Name` 不算 mention，
         `@初音未来abc` 不算命中「初音未来」；
       · 每个 token 与**当前群 participants 的显示名**做**精确**匹配（显示名只是输入 token，
         最终身份永远是 id）：
           唯一匹配 → target = 该 participant id
           0 匹配   → unresolved（**不点名任何角色**；`@所有人` 因此天然 NOT IMPLEMENTED）
           ≥2 匹配  → ambiguous（**两个都不点名**，绝不 pick first）
       · 不做子串匹配、不做模糊匹配、不做 URL/邮箱误判。
     ══════════════════════════════════════════════════════════════════ */
  var MENTION_PREFIXES = ['@', '＠'];
  var MENTION_TOKEN_MAX = 32;
  /* 边界字符：行首/行尾、空白（含全角空格）、ASCII 与 CJK 常见标点。
     注意：它只用于"@ 前"与"名字后"的边界判定；名字内部的标点（例如 A-B / Mr.X）
     由"按候选名逐字比对"天然支持，不受边界集合影响。 */
  function isMentionBoundary(ch) {
    if (!ch) return true;
    if (/\s/.test(ch)) return true;
    return '，。！？、；：,.!?;:()（）[]【】{}｛｝<>《》""\'\'“”‘’~～…—/\\|+*=&#%^@＠'.indexOf(ch) >= 0;
  }
  function readMentionToken(rest) {
    var out = '';
    for (var i = 0; i < rest.length && out.length < MENTION_TOKEN_MAX; i++) {
      if (isMentionBoundary(rest.charAt(i))) break;
      out += rest.charAt(i);
    }
    return out;
  }
  /* "@" 之前算不算 token 起点：
     · 行首 / 空白 / 标点 ⇒ 是；
     · ASCII 字母数字或 email local-part 形状（`a@Name` / `a.b@Name`）⇒ 不是（邮箱误判保护）；
     · 其它字符（尤其中文：`请问@初音未来` —— 中文没有空格分隔）⇒ 是。
     为什么不一律要求前置边界：CJK 正文里 @ 前面几乎总是汉字，一律要求会让 mention 在中文语境失效。 */
  function isMentionStart(prev) {
    if (isMentionBoundary(prev)) return true;
    return /[^\x00-\x7F]/.test(prev);
  }
  function resolveMentionTargets(text, candidates) {
    var src = str(text);
    var list = normalizeParticipants(candidates);
    var targets = [];
    var ambiguous = [];
    var unresolved = [];
    var push = function (arr, v) { if (v && arr.indexOf(v) < 0) arr.push(v); };
    if (!src) return { targets: targets, ambiguous: ambiguous, unresolved: unresolved };
    for (var i = 0; i < src.length; i++) {
      if (MENTION_PREFIXES.indexOf(src.charAt(i)) < 0) continue;
      if (!isMentionStart(i > 0 ? src.charAt(i - 1) : '')) continue;
      var rest = src.slice(i + 1);
      /* 取**最长**的候选名命中（避免短名吞掉长名的前缀） */
      var matchedName = '';
      for (var k = 0; k < list.length; k++) {
        var name = list[k].name;
        if (!name || name.length <= matchedName.length) continue;
        if (rest.slice(0, name.length) !== name) continue;
        if (!isMentionBoundary(rest.charAt(name.length))) continue;
        matchedName = name;
      }
      if (!matchedName) { push(unresolved, readMentionToken(rest)); continue; }
      var ids = [];
      for (var j = 0; j < list.length; j++) if (list[j].name === matchedName) push(ids, list[j].id);
      if (ids.length === 1) push(targets, ids[0]);
      else push(ambiguous, matchedName);
      i += matchedName.length;
    }
    return { targets: targets, ambiguous: ambiguous, unresolved: unresolved };
  }

  /* ══════════════════════════════════════════════════════════════════
     P24-M3.5.1A · Structured Target Identity（pure · write/read 都走这里）
     ------------------------------------------------------------------
     canonical identity = apiConfigs.id（与 metadata.speakerId **同一 domain**）。
     canonical field    = 用户群消息的 metadata.targetSpeakerIds（string[]）。

     本区块只做四件纯事（零存储 / 零 DOM / 零网络 / 零时钟 / 零随机）：
       validateTargetSpeakerIds(ids)
           结构校验：必须是 array；每项必须是非空 string（无首尾空白、无控制字符、
           非凭据形态）；**不允许重复**。
       canonicalizeTargetSpeakerIds(parsedIds, participantIds)
           文本扫描顺序 → **participant 顺序** + 去重 + 只保留当前参与者
           （历史退出者不报错，也不进入投影结果；数组顺序**无语义**）。
       resolveTargetSpeakerIds({message,text,candidates,participantIds})
           结构化优先：message.metadata 的 **own** `targetSpeakerIds` 存在 ⇒ 它是唯一权威
           （**空数组也是权威**）；缺失 ⇒ legacy：走 resolveMentionTargets。
           `source` 只作 runtime 诊断（'structured' | 'legacy'）。
       projectTargetedParticipants(targetSpeakerIds, participants)
           canonical ids → **当前参与者中**被点名的 id（participant 顺序）。

     冻结（M3.5.1 Phase 0 contract）：
       · target 只是 priority / relevance signal，**不是** exclusive allowlist；
       · target 不突破 maxResponders、不改 recent window；
       · 结构损坏（非数组 / 非法元素 / 重复）⇒ **fail closed**（抛 TARGETING_CONTRACT），
         绝不回退文本解析（那会把损坏静默变成另一套参与结果）；
       · 普通未知 / 歧义文本 mention 不是错误（⇒ 无 target，参与照常）；
       · 历史 nonparticipant id 允许留在 metadata（事实），projection 只映射当前参与者；
       · 本区块**不**决定谁回复：它只产出 ids → planner 仍只吃 mentioned 布尔。
     ══════════════════════════════════════════════════════════════════ */
  var TARGETING_ERRORS = Object.freeze(['bad-target-list', 'bad-target-id', 'duplicate-target-id']);
  var TARGET_SPEAKER_FIELD = 'targetSpeakerIds';

  function targetingContractError(errors) {
    var e = new Error('targeting-contract: ' + errors.join(','));
    e.code = 'TARGETING_CONTRACT';
    e.errors = errors.slice();
    return e;
  }
  /* 结构校验：**只看 structured field 的形状**，不涉及"是否属于当前群成员"
     （那是 projection 的职责：历史 target 可能是已退出成员，属正常事实）。 */
  function validateTargetSpeakerIds(ids) {
    if (!Array.isArray(ids)) return { ok: false, errors: ['bad-target-list'] };
    var errors = [];
    var seen = Object.create(null);
    for (var i = 0; i < ids.length; i++) {
      var raw = ids[i];
      if (typeof raw !== 'string') { errors.push('bad-target-id'); continue; }
      var s = raw;
      if (!s || s !== s.trim() || s.length > MAX_ID_LEN) { errors.push('bad-target-id'); continue; }
      if (CONTROL_PATTERN.test(s)) { errors.push('bad-target-id'); continue; }
      if (hasSecret({ targetSpeakerId: s })) { errors.push('bad-target-id'); continue; }
      if (seen[s]) { errors.push('duplicate-target-id'); continue; }
      seen[s] = true;
    }
    return { ok: errors.length === 0, errors: errors };
  }
  /* parsed（文本顺序 / 任意来源）→ canonical（participant 顺序、去重、仅当前参与者）。 */
  function canonicalizeTargetSpeakerIds(parsedIds, participantIds) {
    var out = [];
    var parsed = Array.isArray(parsedIds) ? parsedIds : [];
    var parts = Array.isArray(participantIds) ? participantIds : [];
    var wanted = Object.create(null);
    for (var i = 0; i < parsed.length; i++) {
      var p = str(parsed[i]).trim();
      if (p) wanted[p] = true;
    }
    for (var j = 0; j < parts.length; j++) {
      var id = str(parts[j]).trim();
      if (!id || !wanted[id]) continue;
      if (out.indexOf(id) >= 0) continue;
      out.push(id);
    }
    return out;
  }
  /* 结构化优先读取器（每 GroupTurn 恰好一次）。非法 structured ⇒ 抛错（fail closed）。
     返回值语义（M3.5.1B 冻结，区分"事实"与"当前映射"）：
       structured 路径 ⇒ **原样保留**校验通过的 canonical ids（含已退出成员的历史 id）——
         这是"用户当时 @ 了谁"的事实，读取历史时**绝不**用当前成员表去改写它；
       legacy     路径 ⇒ 文本解析结果 canonicalize 到当前 participants（文本解析本来就只认当前显示名）。
     成员映射由 projectTargetedParticipants 负责（只投影当前 participants；removed 由 planner hard deny）。 */
  function resolveTargetSpeakerIds(input) {
    var o = isObject(input) ? input : {};
    var message = isObject(o.message) ? o.message : null;
    var md = (message && isObject(message.metadata)) ? message.metadata : null;
    var participantIds = Array.isArray(o.participantIds) ? o.participantIds : [];
    if (md && Object.prototype.hasOwnProperty.call(md, TARGET_SPEAKER_FIELD)) {
      var verdict = validateTargetSpeakerIds(md[TARGET_SPEAKER_FIELD]);
      if (!verdict.ok) throw targetingContractError(verdict.errors);   /* 绝不 fallback 文本解析 */
      return { targetSpeakerIds: md[TARGET_SPEAKER_FIELD].slice(), source: 'structured' };
    }
    var parsed = resolveMentionTargets(o.text, o.candidates);
    return { targetSpeakerIds: canonicalizeTargetSpeakerIds(parsed.targets, participantIds), source: 'legacy' };
  }
  /* ids → 当前参与者中被点名的 id（participant 顺序）。planner 仍只吃 mentioned 布尔。 */
  function projectTargetedParticipants(targetSpeakerIds, participants) {
    var out = [];
    var ids = Array.isArray(targetSpeakerIds) ? targetSpeakerIds : [];
    var list = Array.isArray(participants) ? participants : [];
    for (var i = 0; i < list.length; i++) {
      var p = list[i];
      var id = str(isObject(p) ? p.id : p).trim();
      if (!id || ids.indexOf(id) < 0) continue;
      if (out.indexOf(id) >= 0) continue;
      out.push(id);
    }
    return out;
  }

  /* ══════════════════════════════════════════════════════════════════
     P24-M3.5.2A · Dynamic Runtime State Foundation（pure · **capability only**）
     ------------------------------------------------------------------
     定位（Phase 0 冻结）：
       Participation Planner = GroupTurn **start-time static admission authority**（本区块不替代它）
       Group Runtime         = **dynamic execution authority**（本区块只提供它的纯状态机）
     本阶段**没有** SILENT / DEFER / INTERJECT 行为，也不调用任何模型；它只回答：
       · 初始队列是否忠实反映 planner 的 entries（顺序、order、speaker 唯一性）
       · 执行期 hard gates 是否成立（cancel / 一次一 speaker / removed / cap）
       · 每个 MemberTurn 的开始/完成/失败如何被记账

     硬约束：
       · **不重复 planner authority**：不重新判定 active / mentioned / recent / targeting / 优先级；
       · **不存** targeting / recent / roundExtras / history / provider 配置；
       · 纯：零 DB / DOM / network / time / random；错误词表闭集且**不回显**原始 id；
       · runtime-only：不落库、不进 canonical metadata、不进 prompt（由 adapter 保证）；
       · cancel **不是**本区块的 authority —— 唯一真值仍是 `_gTurn.cancelled`，
         由 adapter 每次以 context 传入；`markDynamicRuntimeCancelled` 只记 telemetry。
     ══════════════════════════════════════════════════════════════════ */
  var DYNAMIC_RUNTIME_ERRORS = Object.freeze([
    'bad-group-turn-id', 'bad-entries', 'bad-speaker-id', 'bad-order',
    'duplicate-speaker', 'duplicate-order', 'bad-cap'
  ]);
  var DYNAMIC_GATE_REASONS = Object.freeze([
    'queue-empty', 'cancelled', 'unknown-entry', 'already-started', 'already-silent', 'removed', 'cap-reached'
  ]);
  /* P24-M3.5.2B · runtime decision vocabulary（**闭集**：只有 SPEAK / SILENT）。
     DEFER / INTERJECT 属后续阶段，**不**加入本词表（即使注入的 decider 返回它们也视为 unsupported）。 */
  /* P24-M3.5.2C：词表扩展为 speak / silent / **defer**（仍闭集；defer = 把既有 pending
     MemberTurn 移到本轮队列尾部，等本轮后续机会 —— 不是 omission / 不是新 participant）。 */
  var DYNAMIC_RUNTIME_DECISIONS = Object.freeze({ SPEAK: 'speak', SILENT: 'silent', DEFER: 'defer' });
  var DYNAMIC_DECISION_SOURCES = Object.freeze(['default', 'injected', 'fallback']);
  var DYNAMIC_DECISION_DIAGNOSTICS = Object.freeze(['decider-threw', 'malformed-result', 'unknown-decision', 'unsupported-decision', 'defer-limit']);
  /* defer 控制面（runtime-only）：失败 ⇒ adapter 继续按 SPEAK 执行（绝不循环、绝不静默丢 entry）。 */
  var DYNAMIC_DEFER_ERRORS = Object.freeze(['unknown-entry', 'already-started', 'already-silent', 'already-deferred', 'not-in-queue']);

  function dynamicRuntimeContractError(errors) {
    var e = new Error('dynamic-runtime-contract: ' + errors.join(','));
    e.code = 'DYNAMIC_RUNTIME_CONTRACT';
    e.errors = errors.slice();
    return e;
  }
  function isNonNegativeInt(v) {                 /* 与 policy 契约同源的非负有限整数判定 */
    return typeof v === 'number' && isFinite(v) && Math.floor(v) === v && v >= 0;
  }
  /* 结构校验（只关心 execution-time invariant；**不**验证 targeting/recent/policy/prompt）。 */
  function validateDynamicRuntimeInput(input) {
    var errors = [];
    if (!isObject(input)) return { ok: false, errors: ['bad-entries'] };
    var groupTurnId = str(input.groupTurnId).trim();
    if (!groupTurnId || !isGroupTurnId(groupTurnId)) errors.push('bad-group-turn-id');
    var entries = input.entries;
    if (!Array.isArray(entries)) errors.push('bad-entries');
    else {
      var seenSpeaker = Object.create(null), seenOrder = Object.create(null);
      for (var i = 0; i < entries.length; i++) {
        var e = entries[i];
        if (!isObject(e)) { errors.push('bad-entries'); continue; }
        var sid = str(e.speakerId).trim();
        if (!sid || !isUsableSpeakerId(sid) || hasSecret({ speakerId: sid })) errors.push('bad-speaker-id');
        else if (seenSpeaker[sid]) errors.push('duplicate-speaker');
        else seenSpeaker[sid] = true;
        var order = e.order;
        if (!isNonNegativeInt(order) || order > MAX_GROUP_ORDER) errors.push('bad-order');
        else if (seenOrder[order]) errors.push('duplicate-order');
        else seenOrder[order] = true;
      }
    }
    /* cap：absent（undefined / null）= unlimited —— **绝不**把 null 当成 0（Phase 0 §18）。 */
    var cap = input.responderCap;
    if (cap != null && !isNonNegativeInt(cap)) errors.push('bad-cap');
    return { ok: errors.length === 0, errors: errors };
  }
  /* 创建 runtime state：非法 planner output ⇒ fail closed（抛契约错误，绝不静默修数据）。 */
  function createDynamicRuntimeState(input) {
    var verdict = validateDynamicRuntimeInput(input);
    if (!verdict.ok) throw dynamicRuntimeContractError(verdict.errors);
    var cap = input.responderCap;
    var entries = [];
    for (var i = 0; i < input.entries.length; i++) {
      var e = input.entries[i];
      entries.push({ speakerId: str(e.speakerId).trim(), order: e.order, reason: str(e.reason) });
    }
    var statusById = Object.create(null);
    if (isObject(input.statusById)) {
      var keys = Object.getOwnPropertyNames(input.statusById);
      for (var k = 0; k < keys.length; k++) statusById[keys[k]] = str(input.statusById[keys[k]]).trim();
    }
    return {
      groupTurnId: str(input.groupTurnId).trim(),
      enabled: true,
      responderCap: (cap == null) ? undefined : cap,
      initialEntries: entries,
      pendingEntries: entries.slice(),
      startedSpeakerIds: [],
      completedSpeakerIds: [],
      failedSpeakerIds: [],
      silentSpeakerIds: [],
      deferredSpeakerIds: [],
      blockedEntries: [],
      cancelSeen: false,
      cancelReason: '',
      statusById: statusById
    };
  }
  /* hard gates（execution-time invariant；**不**重判 planner 的资格/优先级）。 */
  function canStartDynamicRuntimeEntry(st, entry, ctx) {
    var o = isObject(ctx) ? ctx : {};
    if (o.cancelled === true) return { ok: false, reason: 'cancelled' };      /* 最高优先级 */
    if (!isObject(entry) || !str(entry.speakerId).trim()) return { ok: false, reason: 'unknown-entry' };
    var sid = str(entry.speakerId).trim();
    var planned = false;
    for (var i = 0; i < st.initialEntries.length; i++) {
      if (st.initialEntries[i].speakerId === sid && st.initialEntries[i].order === entry.order) { planned = true; break; }
    }
    if (!planned) return { ok: false, reason: 'unknown-entry' };
    if (st.startedSpeakerIds.indexOf(sid) >= 0) return { ok: false, reason: 'already-started' };  /* one MemberTurn/speaker */
    /* P24-M3.5.2B：silent 也是终态 —— 同一 speaker 本轮不得再被准入（不重排、不再决定）。 */
    if (st.silentSpeakerIds.indexOf(sid) >= 0) return { ok: false, reason: 'already-silent' };
    if (str(st.statusById[sid]) === 'removed') return { ok: false, reason: 'removed' };
    /* muted **不**是 runtime deny：muted + user targeted 由 planner 合法准入（Phase 0 §14）。 */
    if (st.responderCap !== undefined && st.startedSpeakerIds.length >= st.responderCap) {
      return { ok: false, reason: 'cap-reached' };
    }
    return { ok: true, reason: '' };
  }
  /* 取下一个 pending entry：peek → gate → 通过才出队（deny ⇒ 不消费、返回 done + reason）。 */
  function nextDynamicRuntimeEntry(st, ctx) {
    var o = isObject(ctx) ? ctx : {};
    if (o.cancelled === true) return { done: true, reason: 'cancelled' };
    if (!st.pendingEntries.length) return { done: true, reason: 'queue-empty' };
    var head = st.pendingEntries[0];
    var gate = canStartDynamicRuntimeEntry(st, head, o);
    if (!gate.ok) return { done: true, reason: gate.reason, blocked: head };
    st.pendingEntries.shift();
    return { done: false, reason: '', entry: head };
  }
  function markDynamicRuntimeStarted(st, entry, ctx) {
    var gate = canStartDynamicRuntimeEntry(st, entry, ctx);
    if (!gate.ok) return gate;
    st.startedSpeakerIds.push(str(entry.speakerId).trim());
    return { ok: true, reason: '' };
  }
  function _ibDynFinish(st, speakerId, bucket) {
    var sid = str(speakerId).trim();
    if (!sid || st.startedSpeakerIds.indexOf(sid) < 0) return { ok: false, reason: 'not-started' };
    if (st[bucket].indexOf(sid) < 0) st[bucket].push(sid);
    return { ok: true, reason: '' };
  }
  function markDynamicRuntimeCompleted(st, speakerId) { return _ibDynFinish(st, speakerId, 'completedSpeakerIds'); }
  function markDynamicRuntimeFailed(st, speakerId) { return _ibDynFinish(st, speakerId, 'failedSpeakerIds'); }
  /* ── P24-M3.5.2B · Runtime SILENT 决策 seam（pure）──────────────────────────
     调用顺序（adapter 保证）：nextDynamicRuntimeEntry（hard gates 已通过）→ 本函数 → SPEAK 执行。
     语义：SILENT = 该 speaker 在 execution-time 终止自己的 MemberTurn（provider / typing /
     canonical 消息 / roundExtras / P23 全部不发生），**但 initial planner 的 admitted fact 保留**。

     决策来源（**runtime-only，不持久化、不进 prompt、不进 canonical metadata**）：
       · 缺省（ctx.decider 缺席）⇒ **SPEAK**（生产默认行为，逐字等同 2A foundation）
       · ctx.decider 是函数 ⇒ 以**只读最小上下文**调用；只有返回 `{decision:'speak'|'silent'}` 才被采纳
       · decider 抛错 / 返回 null / malformed / 未知词（含 'defer'/'interject'）⇒ **fallback SPEAK**，
         并给出闭集 diagnostic（**不**影响执行、**不**升级为 GroupTurn 失败）
     decider 收到的上下文与 state 隔离：只给标量 + 数组副本 ⇒ 恶意返回/篡改都无法改 runtime state。 */
  function resolveDynamicRuntimeDecision(st, entry, ctx) {
    var o = isObject(ctx) ? ctx : {};
    var decider = o.decider;
    if (typeof decider !== 'function') return { decision: 'speak', source: 'default', diagnostic: '' };
    var sid = isObject(entry) ? str(entry.speakerId).trim() : '';
    var brief = {
      groupTurnId: str(st.groupTurnId),
      speakerId: sid,
      groupOrder: isObject(entry) ? entry.order : undefined,
      startedSpeakerIds: st.startedSpeakerIds.slice(),
      completedSpeakerIds: st.completedSpeakerIds.slice(),
      failedSpeakerIds: st.failedSpeakerIds.slice(),
      silentSpeakerIds: st.silentSpeakerIds.slice()
    };
    var out = null;
    try { out = decider(brief); }
    catch (e) { return { decision: 'speak', source: 'fallback', diagnostic: 'decider-threw' }; }
    if (!isObject(out)) return { decision: 'speak', source: 'fallback', diagnostic: 'malformed-result' };
    /* **严格**匹配决策值：不做 trim / 不做隐式转换（' defer ' / 1 / null ⇒ unknown-decision ⇒ SPEAK）。 */
    var d = out.decision;
    if (d === DYNAMIC_RUNTIME_DECISIONS.SPEAK) return { decision: 'speak', source: 'injected', diagnostic: '' };
    if (d === DYNAMIC_RUNTIME_DECISIONS.SILENT) return { decision: 'silent', source: 'injected', diagnostic: '' };
    /* P24-M3.5.2C · DEFER：同一 speaker 本轮**最多 defer 一次**（保证 GroupTurn 收敛）；
       第二次 ⇒ fallback SPEAK（diagnostic='defer-limit'）。 */
    if (d === DYNAMIC_RUNTIME_DECISIONS.DEFER) {
      if (st.deferredSpeakerIds.indexOf(sid) >= 0) return { decision: 'speak', source: 'fallback', diagnostic: 'defer-limit' };
      return { decision: 'defer', source: 'injected', diagnostic: '' };
    }
    if (d === 'defer' || d === 'interject') return { decision: 'speak', source: 'fallback', diagnostic: 'unsupported-decision' };
    return { decision: 'speak', source: 'fallback', diagnostic: 'unknown-decision' };
  }
  /* SILENT 记账：pending → silent terminal（**不**进 started / completed / failed；
     不计 failure；不能再次 start / silent / requeue）。 */
  function markDynamicRuntimeSilent(st, speakerId) {
    var sid = str(speakerId).trim();
    if (!sid) return { ok: false, reason: 'bad-speaker-id' };
    var planned = false;
    for (var i = 0; i < st.initialEntries.length; i++) if (st.initialEntries[i].speakerId === sid) { planned = true; break; }
    if (!planned) return { ok: false, reason: 'unknown-entry' };
    if (st.startedSpeakerIds.indexOf(sid) >= 0) return { ok: false, reason: 'already-started' };
    if (st.silentSpeakerIds.indexOf(sid) >= 0) return { ok: false, reason: 'already-silent' };
    st.silentSpeakerIds.push(sid);
    return { ok: true, reason: '' };
  }
  /* ── P24-M3.5.2C · Runtime DEFER（pure）───────────────────────────────────
     语义：entry 已经通过 hard gate 并**被 next 取出**（不在 pending 里）⇒ DEFER 把它**追加到
     队列尾部**，等本轮后续机会。与 SILENT 的区别：
       SILENT = terminal（不再回来）；DEFER = **NOT terminal**（仍 pending，同 speaker 本轮仍
       最多执行一次 SPEAK —— 由 startedSpeakerIds 保证）。
     记账：deferredSpeakerIds（runtime-only）；**不**进 started / completed / failed / silent；
     不产生 provider / typing / canonical / roundExtras / P23；`order` / turnId / plannedCount 不变。
     失败（不在 plan / 已 started / 已 silent / 已 defer 过 ⇒ defer-limit）⇒ 调用方按 SPEAK 继续。 */
  function deferDynamicRuntimeEntry(st, entry) {
    if (!isObject(entry)) return { ok: false, reason: 'unknown-entry' };
    var sid = str(entry.speakerId).trim();
    if (!sid) return { ok: false, reason: 'unknown-entry' };
    var planned = null;
    for (var i = 0; i < st.initialEntries.length; i++) {
      if (st.initialEntries[i].speakerId === sid && st.initialEntries[i].order === entry.order) { planned = st.initialEntries[i]; break; }
    }
    if (!planned) return { ok: false, reason: 'unknown-entry' };
    if (st.startedSpeakerIds.indexOf(sid) >= 0) return { ok: false, reason: 'already-started' };
    if (st.silentSpeakerIds.indexOf(sid) >= 0) return { ok: false, reason: 'already-silent' };
    if (st.deferredSpeakerIds.indexOf(sid) >= 0) return { ok: false, reason: 'already-deferred' };
    if (st.pendingEntries.some(function (e) { return e.speakerId === sid && e.order === entry.order; })) return { ok: false, reason: 'not-in-queue' };
    st.deferredSpeakerIds.push(sid);
    st.pendingEntries.push({ speakerId: planned.speakerId, order: planned.order, reason: planned.reason });
    return { ok: true, reason: '' };
  }
  /* telemetry-only：**不是** cancel authority（唯一真值仍是 _gTurn.cancelled）。 */
  function markDynamicRuntimeCancelled(st, reason) {
    st.cancelSeen = true;
    st.cancelReason = str(reason).slice(0, 40);
    return { ok: true, reason: '' };
  }
  /* 只读快照（供测试/telemetry；不暴露内部对象引用）。 */
  function dynamicRuntimeSnapshot(st) {
    if (!isObject(st)) return null;
    var copy = function (arr) { return Array.isArray(arr) ? arr.slice() : []; };
    return {
      groupTurnId: str(st.groupTurnId),
      enabled: st.enabled === true,
      responderCap: (st.responderCap === undefined) ? null : st.responderCap,
      pendingEntries: (st.pendingEntries || []).map(function (e) { return { speakerId: str(e.speakerId), order: e.order, reason: str(e.reason) }; }),
      startedSpeakerIds: copy(st.startedSpeakerIds),
      completedSpeakerIds: copy(st.completedSpeakerIds),
      failedSpeakerIds: copy(st.failedSpeakerIds),
      silentSpeakerIds: copy(st.silentSpeakerIds),
      deferredSpeakerIds: copy(st.deferredSpeakerIds),
      blockedEntries: copy(st.blockedEntries),
      cancelSeen: st.cancelSeen === true,
      cancelReason: str(st.cancelReason)
    };
  }

  return {
    GROUP_TURN_PREFIX: GROUP_TURN_PREFIX,
    TURN_PREFIX: TURN_PREFIX,
    GROUP_ID_PREFIX: GROUP_ID_PREFIX,
    MAX_GROUP_ORDER: MAX_GROUP_ORDER,
    groupTurnIdFor: groupTurnIdFor,
    memberTurnIdFor: memberTurnIdFor,
    createIdentityContext: createIdentityContext,
    createMemberIdentity: createMemberIdentity,
    validateIdentityContext: validateIdentityContext,
    validateMemberIdentity: validateMemberIdentity,
    isGroupTurnId: isGroupTurnId,
    isMemberTurnId: isMemberTurnId,
    normalizeParticipants: normalizeParticipants,
    resolveSpeakerId: resolveSpeakerId,
    classifyMessageForSpeaker: classifyMessageForSpeaker,
    RECENT_SPEAKER_ERRORS: RECENT_SPEAKER_ERRORS,
    validateRecentSpeakerInput: validateRecentSpeakerInput,
    deriveRecentSpeakerIds: deriveRecentSpeakerIds,
    PARTICIPATION_PLANNER_ID: PARTICIPATION_PLANNER_ID,
    PARTICIPATION_PLAN_VERSION: PARTICIPATION_PLAN_VERSION,
    PARTICIPANT_STATUSES: PARTICIPANT_STATUSES,
    PARTICIPATION_REASONS: PARTICIPATION_REASONS,
    PARTICIPATION_ERRORS: PARTICIPATION_ERRORS,
    validateParticipationInput: validateParticipationInput,
    planParticipation: planParticipation,
    PARTICIPATION_POLICY_FIELDS: PARTICIPATION_POLICY_FIELDS,
    PARTICIPATION_POLICY_SOURCES: PARTICIPATION_POLICY_SOURCES,
    PARTICIPATION_POLICY_ERRORS: PARTICIPATION_POLICY_ERRORS,
    validateParticipationPolicyFragment: validateParticipationPolicyFragment,
    resolveParticipationPolicy: resolveParticipationPolicy,
    MENTION_PREFIXES: MENTION_PREFIXES,
    isMentionBoundary: isMentionBoundary,
    resolveMentionTargets: resolveMentionTargets,
    TARGETING_ERRORS: TARGETING_ERRORS,
    TARGET_SPEAKER_FIELD: TARGET_SPEAKER_FIELD,
    validateTargetSpeakerIds: validateTargetSpeakerIds,
    canonicalizeTargetSpeakerIds: canonicalizeTargetSpeakerIds,
    resolveTargetSpeakerIds: resolveTargetSpeakerIds,
    projectTargetedParticipants: projectTargetedParticipants,
    DYNAMIC_RUNTIME_ERRORS: DYNAMIC_RUNTIME_ERRORS,
    DYNAMIC_GATE_REASONS: DYNAMIC_GATE_REASONS,
    validateDynamicRuntimeInput: validateDynamicRuntimeInput,
    createDynamicRuntimeState: createDynamicRuntimeState,
    canStartDynamicRuntimeEntry: canStartDynamicRuntimeEntry,
    nextDynamicRuntimeEntry: nextDynamicRuntimeEntry,
    markDynamicRuntimeStarted: markDynamicRuntimeStarted,
    markDynamicRuntimeCompleted: markDynamicRuntimeCompleted,
    markDynamicRuntimeFailed: markDynamicRuntimeFailed,
    DYNAMIC_RUNTIME_DECISIONS: DYNAMIC_RUNTIME_DECISIONS,
    DYNAMIC_DECISION_SOURCES: DYNAMIC_DECISION_SOURCES,
    DYNAMIC_DECISION_DIAGNOSTICS: DYNAMIC_DECISION_DIAGNOSTICS,
    resolveDynamicRuntimeDecision: resolveDynamicRuntimeDecision,
    markDynamicRuntimeSilent: markDynamicRuntimeSilent,
    DYNAMIC_DEFER_ERRORS: DYNAMIC_DEFER_ERRORS,
    deferDynamicRuntimeEntry: deferDynamicRuntimeEntry,
    markDynamicRuntimeCancelled: markDynamicRuntimeCancelled,
    dynamicRuntimeSnapshot: dynamicRuntimeSnapshot
  };
});
