/* ====================================================================
   IB Chat Core — runtime-neutral chat contract (UMD dual-load · D10)
   --------------------------------------------------------------------
   - Browser: <script src="assets/js/chat-core.js"> → window.IBChatCore
   - Node   : require('../assets/js/chat-core.js')
   - 规则：零 window / 零 DOM / 零 fetch / 零 IndexedDB / 零 provider 判定。
   - 唯一职责：定义「一条 chat message 是什么」「一段 conversation 是谁」，
     并提供确定性的 id / conversationId 推导。**不做 I/O、不做存储、不做传输。**
   - 事实来源：docs/CHAT_MESSAGE_CONTRACT.md（逐行取自生产写入点）。
     本文件是 M1-A 的唯一契约实现；browser 与 Node（store / execution / migration）
     都消费同一份常量与同一批纯函数，禁止在别处复制第二份字段表。
   ==================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); }
  else { root.IBChatCore = factory(); }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ── 存储位置（canonical 名称的唯一真源）────────────────────────────── */
  var STORE_NAME = 'chatMessages';
  var DB_NAME = 'InternalBeyondDB';
  var DB_VER = 23;                 /* 与 assets/js/core.js:3 同步；本阶段**不**升版 */
  var MESSAGE_STORE = 'messages';  /* canonical SQLite 表名 */
  var SCHEMA_VERSION = 1;          /* canonical SQLite schema 版本（迁移用） */

  /* ── 分页默认值 ───────────────────────────────────────────────────── */
  var DEFAULT_LIST_LIMIT = 50;
  var MAX_LIST_LIMIT = 500;
  var DEFAULT_CHANGES_LIMIT = 200;
  var MAX_CHANGES_LIMIT = 1000;
  var DEFAULT_MIGRATION_BATCH = 200;
  var MAX_MIGRATION_BATCH = 500;

  /* ── id 形状（docs/CHAT_MESSAGE_CONTRACT.md §3，逐条对应生产写入点）── */
  var ID_SHAPES = {
    user: 'msg_<ms>_u',
    assistant: 'msg_<ms>_<rand>',
    assistantPart: 'msg_<ms>_<rand>_<i>',
    system: 'msg_sys_<ms>_<rand36>',
    proactive: 'active_<settingId>_<scheduledFor>'
  };
  var ID_PATTERN = /^(?:msg_\d+_(?:u|\d+)(?:_\d+)?|msg_sys_\d+_[a-z0-9]{1,6}|active_.+)$/;

  /* ── 字段分类（唯一真源；schema 校验与 store 列投影都读这里）──────── */
  /* required：每一次生产写入都必须存在的字段。 */
  var REQUIRED_FIELDS = ['id', 'role', 'content', 'friendId', 'timestamp'];
  /* conditional：只在某些 surface 出现，但出现时即为 canonical，必须原样保留。 */
  var CONDITIONAL_FIELDS = [
    'reasoning_content', 'threadId', 'senderName', 'images', 'files', 'voice',
    'metadata', 'truncated', 'withdrawn', 'withdrawnBy',
    'wsSearches', 'memOps', 'calNotes'
  ];
  /* legacy：历史/导出遗留，只读，不参与任何渲染决策。 */
  var LEGACY_FIELDS = ['upstreamRaw', 'thinkingSources'];
  /* 完整白名单 = required + conditional + legacy。白名单之外的字段**不会被丢弃**，
     只是会被 report 出来（见 canonicalize 的 dropped 数组），因为我们绝不静默丢数据。 */
  var KNOWN_FIELDS = REQUIRED_FIELDS.concat(CONDITIONAL_FIELDS, LEGACY_FIELDS);
  var ROLES = ['user', 'assistant', 'system'];

  /* ── conversation identity ─────────────────────────────────────────
     事实（docs/CHAT_MESSAGE_CONTRACT.md §5）：
       · 今天的 conversation key 就是 friendId，没有 conversation 表；
       · threadId 是 friendId 内部的频道，不是独立会话；
       · 群聊只靠 friendId 的前缀 'group_' 区分，没有 flag 字段。
     因此 canonical conversationId 是**派生值**，绝不回写进消息记录：
       dm:<friendId>              1:1 主对话
       dm:<friendId>|<threadId>   1:1 话题频道
       group:<groupId>            群聊主对话
       group:<groupId>|<threadId> 群聊话题频道
     分隔符选 '|' 而不是 ':'：生产环境所有 id 形状（§3）都不含 '|'，
     而 ':' 在自定义 relay / 未来 id 中无法保证不出现。 */
  var GROUP_PREFIX = 'group_';
  var CONV_SEP = '|';
  var DM_PREFIX = 'dm:';
  var GROUP_KEY_PREFIX = 'group:';

  function isGroupFriendId(friendId) {
    return String(friendId == null ? '' : friendId).indexOf(GROUP_PREFIX) === 0;
  }

  function conversationIdOf(friendId, threadId) {
    var fid = String(friendId == null ? '' : friendId);
    var head = (isGroupFriendId(fid) ? GROUP_KEY_PREFIX : DM_PREFIX) + fid;
    var tid = (threadId == null ? '' : String(threadId));
    return tid ? (head + CONV_SEP + tid) : head;
  }

  /* 逆函数：对每一个生产者 id 形状都精确（含 friendId 内含 ':' 的情况，
     因为前缀是固定长度、分隔符唯一）。无法识别时返回 null（绝不猜）。 */
  function parseConversationId(conversationId) {
    var raw = String(conversationId == null ? '' : conversationId);
    var kind, rest;
    if (raw.indexOf(GROUP_KEY_PREFIX) === 0) { kind = 'group'; rest = raw.slice(GROUP_KEY_PREFIX.length); }
    else if (raw.indexOf(DM_PREFIX) === 0) { kind = 'dm'; rest = raw.slice(DM_PREFIX.length); }
    else return null;
    var at = rest.indexOf(CONV_SEP);
    var friendId = at < 0 ? rest : rest.slice(0, at);
    var threadId = at < 0 ? '' : rest.slice(at + 1);
    if (!friendId) return null;
    if (kind === 'group' && !isGroupFriendId(friendId)) return null;
    if (kind === 'dm' && isGroupFriendId(friendId)) return null;
    return {
      conversationId: conversationIdOf(friendId, threadId),
      kind: kind,
      friendId: friendId,
      threadId: threadId,
      isGroup: kind === 'group'
    };
  }

  /* 从一条已存消息派生 conversationId（唯一入口，调用方不得自己拼串）。 */
  function conversationIdOfMessage(message) {
    if (!message || typeof message !== 'object') return null;
    var fid = message.friendId;
    if (fid == null || fid === '') return null;
    return conversationIdOf(fid, message.threadId);
  }

  /* ── id 推导（保持所有既有形状；绝不为了 SQLite 重新编号）──────────── */
  function randomSuffix() {
    return Math.floor(Math.random() * 100000);
  }
  function generateMessageId(role, options) {
    options = options || {};
    var now = (options.now != null) ? Number(options.now) : Date.now();
    var r = String(role || 'assistant');
    if (r === 'user') return 'msg_' + now + '_u';
    if (r === 'system') return 'msg_sys_' + now + '_' + Math.random().toString(36).slice(2, 6);
    var base = 'msg_' + now + '_' + randomSuffix();
    if (options.part != null) base += '_' + Number(options.part);
    return base;
  }

  /* requestId → user message id 的**唯一**确定性映射。
     Home Node 用它做 transport 级幂等：同一个 requestId 永远得到同一个 userMessageId，
     因此重试既不会产生第二条 user 消息，也不会触发第二次模型调用。
     注意与 generateMessageId('user') 的区别：后者是「本地生成一次」的路径，
     前者是「远程可重试」的路径 —— 两条路径都保留，生产 browser 路径继续用后者。 */
  function stableToken(input) {
    var s = String(input == null ? '' : input);
    var h1 = 0x811c9dc5, h2 = 0x01000193;
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      h1 = (h1 ^ c) >>> 0; h1 = (h1 + ((h1 << 1) + (h1 << 4) + (h1 << 7) + (h1 << 8) + (h1 << 24))) >>> 0;
      h2 = ((h2 ^ c) * 16777619) >>> 0;
    }
    return (h1.toString(36) + h2.toString(36)).slice(0, 12);
  }
  function messageIdFromRequest(requestId) {
    var rid = String(requestId == null ? '' : requestId);
    if (!rid) return null;
    return 'msg_req_' + stableToken(rid) + '_u';
  }

  function isKnownMessageId(id) {
    return ID_PATTERN.test(String(id == null ? '' : id));
  }

  /* ── 校验 / 规范化 ───────────────────────────────────────────────── */
  function isFiniteTimestamp(v) {
    return typeof v === 'number' && isFinite(v) && v > 0;
  }

  /* 严格校验：只判「能不能作为 canonical 记录存在」，不修数据。
     返回 {ok, errors[]}；errors 用稳定词表，供日志与测试断言（禁止用字符串匹配分支）。 */
  function validateMessage(message) {
    var errors = [];
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      return { ok: false, errors: ['not-an-object'] };
    }
    if (typeof message.id !== 'string' || !message.id) errors.push('missing-id');
    if (typeof message.role !== 'string' || ROLES.indexOf(message.role) < 0) errors.push('bad-role');
    if (typeof message.content !== 'string') errors.push('bad-content');
    if (typeof message.friendId !== 'string' || !message.friendId) errors.push('missing-friendId');
    if (!isFiniteTimestamp(message.timestamp)) errors.push('bad-timestamp');
    if (message.threadId != null && typeof message.threadId !== 'string') errors.push('bad-threadId');
    if (message.reasoning_content != null && typeof message.reasoning_content !== 'string') errors.push('bad-reasoning_content');
    if (message.images != null && !Array.isArray(message.images)) errors.push('bad-images');
    if (message.files != null && !Array.isArray(message.files)) errors.push('bad-files');
    if (message.voice != null && (typeof message.voice !== 'object' || Array.isArray(message.voice))) errors.push('bad-voice');
    if (message.metadata != null && (typeof message.metadata !== 'object' || Array.isArray(message.metadata))) errors.push('bad-metadata');
    return { ok: errors.length === 0, errors: errors };
  }

  /* 规范化：只做**幂等的浅拷贝**，用于准备 payload。
     · 不改任何已有字段的值（尤其不改 id / timestamp / content）；
     · 未知字段原样保留，但回报在 dropped 中，便于发现 schema 漂移；
     · 空字符串的 threadId 归一为「不存在」，因为全部生产写入点都用真值判断。 */
  function canonicalize(message) {
    var out = {};
    var dropped = [];
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      return { message: null, dropped: dropped, errors: ['not-an-object'] };
    }
    var keys = Object.keys(message);
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      if (k === 'threadId' && (message[k] == null || message[k] === '')) continue;
      out[k] = message[k];
      if (KNOWN_FIELDS.indexOf(k) < 0) dropped.push(k);
    }
    return { message: out, dropped: dropped, errors: [] };
  }

  function normalizeLimit(limit, fallback, max) {
    var n = Number(limit);
    if (!isFinite(n) || n <= 0) return fallback;
    return Math.min(Math.floor(n), max);
  }

  /* 群聊历史注入格式（browser 侧的既有约定，communication.js:1740-1747）：
     非发言成员的行以 '[Name] 内容' 形式参与后续发言者的上下文。
     放在 core 里是为了让 Node execution 与 browser 逐字一致。 */
  function groupPrefix(senderName, content) {
    return '[' + String(senderName || '') + '] ' + String(content == null ? '' : content);
  }

  return {
    STORE_NAME: STORE_NAME,
    DB_NAME: DB_NAME,
    DB_VER: DB_VER,
    MESSAGE_STORE: MESSAGE_STORE,
    SCHEMA_VERSION: SCHEMA_VERSION,
    DEFAULT_LIST_LIMIT: DEFAULT_LIST_LIMIT,
    MAX_LIST_LIMIT: MAX_LIST_LIMIT,
    DEFAULT_CHANGES_LIMIT: DEFAULT_CHANGES_LIMIT,
    MAX_CHANGES_LIMIT: MAX_CHANGES_LIMIT,
    DEFAULT_MIGRATION_BATCH: DEFAULT_MIGRATION_BATCH,
    MAX_MIGRATION_BATCH: MAX_MIGRATION_BATCH,
    GROUP_PREFIX: GROUP_PREFIX,
    CONV_SEP: CONV_SEP,
    ROLES: ROLES,
    REQUIRED_FIELDS: REQUIRED_FIELDS,
    CONDITIONAL_FIELDS: CONDITIONAL_FIELDS,
    LEGACY_FIELDS: LEGACY_FIELDS,
    KNOWN_FIELDS: KNOWN_FIELDS,
    ID_SHAPES: ID_SHAPES,
    isGroupFriendId: isGroupFriendId,
    conversationIdOf: conversationIdOf,
    parseConversationId: parseConversationId,
    conversationIdOfMessage: conversationIdOfMessage,
    generateMessageId: generateMessageId,
    messageIdFromRequest: messageIdFromRequest,
    stableToken: stableToken,
    isKnownMessageId: isKnownMessageId,
    validateMessage: validateMessage,
    canonicalize: canonicalize,
    normalizeLimit: normalizeLimit,
    groupPrefix: groupPrefix
  };
});
