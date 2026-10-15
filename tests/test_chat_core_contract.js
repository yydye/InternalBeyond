'use strict';
/* Internal Beyond · Chat Message Contract 测试（static，零依赖，零网络）
   运行：node tests/test_chat_core_contract.js
   验证 assets/js/chat-core.js 与 docs/CHAT_MESSAGE_CONTRACT.md 的一致性：
     · 字段表与生产写入形状连续（含群聊 senderName、proactive metadata、附件三件套）；
     · 五种 canonical id 形状被承认且被原样保留（绝不重新生成）；
     · conversation identity 派生/逆函数对所有生产者形状精确，thread 不串；
     · 校验词表稳定（错误码可分支，不靠文案匹配）；
     · requestId → messageId 映射确定性（同输入恒同输出）； */
const assert = require('assert');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CORE = require(path.join(ROOT, 'assets', 'js', 'chat-core.js'));

let passed = 0, failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log('✔ ' + name); }
  else { failed++; console.error('✖ ' + name + (extra !== undefined ? ' — ' + JSON.stringify(extra) : '')); }
}

/* ── 1 · 字段表 ───────────────────────────────────────────────────── */
check('字段表 required 与生产写入一致',
  JSON.stringify(CORE.REQUIRED_FIELDS) === JSON.stringify(['id', 'role', 'content', 'friendId', 'timestamp']),
  CORE.REQUIRED_FIELDS);
for (const f of ['reasoning_content', 'threadId', 'senderName', 'images', 'files', 'voice', 'metadata',
  'truncated', 'withdrawn', 'withdrawnBy', 'wsSearches', 'memOps', 'calNotes']) {
  check('字段表含 conditional 字段 ' + f, CORE.CONDITIONAL_FIELDS.indexOf(f) >= 0);
}
check('字段表含 legacy 字段（只读，不参与渲染决策）',
  CORE.LEGACY_FIELDS.indexOf('upstreamRaw') >= 0 && CORE.LEGACY_FIELDS.indexOf('thinkingSources') >= 0);
const DB_SCHEMA_SOURCE = require('fs').readFileSync(path.join(ROOT, 'assets', 'js', 'webcore-db-schema.js'), 'utf8');
const DB_SCHEMA_VERSION = Number((/DB_VERSION\s*=\s*(\d+)/.exec(DB_SCHEMA_SOURCE) || [])[1]);
check('store / db 名称与共享 IndexedDB schema 一致',
  CORE.STORE_NAME === 'chatMessages' && CORE.DB_NAME === 'InternalBeyondDB'
  /* Phase 4B-1.2：DB_VER 合法前进到 24（+ disclosureFacts，属**另一个**阶段），
     因此这里不再把 23 写死。写死有两个问题：每次合法升版都误报，而且它
     **测不到**这行断言声称的东西 —— core.js 现在把数据库名和版本委托给
     webcore-db-schema.js。真正的性质是两个消费者必须使用同一个 schema 版本。 */
  && CORE.DB_VER === DB_SCHEMA_VERSION
  && Number.isInteger(CORE.DB_VER) && CORE.DB_VER >= 23,
  { STORE_NAME: CORE.STORE_NAME, DB_NAME: CORE.DB_NAME, DB_VER: CORE.DB_VER });
check('schema 版本已声明（供未来 migration）', Number.isInteger(CORE.SCHEMA_VERSION) && CORE.SCHEMA_VERSION >= 1);

/* ── 2 · 生产写入形状逐条校验通过 ─────────────────────────────────── */
const SHAPES = {
  '1:1 用户消息 (communication.js:1989-1994)': {
    id: 'msg_1757300000000_u', role: 'user', content: '你好', friendId: 'friend_1', timestamp: 1757300000000,
    threadId: 'thread_9'
  },
  '1:1 助手消息 (communication.js:2297-2303)': {
    id: 'msg_1757300000000_43210', role: 'assistant', content: '回复', reasoning_content: '想',
    metadata: { model: 'deepseek', model_id: 'deepseek-flash', config_id: 'friend_1', showThinking: true, waifu: true },
    friendId: 'friend_1', timestamp: 1757300000000, truncated: true,
    wsSearches: [{ q: 'x' }], memOps: [{ ok: true, status: 'saved', label: '记忆', detail: '' }],
    calNotes: [{ ok: true, label: '便笺', detail: '' }]
  },
  'waifu 分段 (communication.js:2385-2387)': {
    id: 'msg_1757300000000_999_1', role: 'assistant', content: '第二条', reasoning_content: '',
    metadata: { waifu: true }, friendId: 'friend_1', timestamp: 1757300000001
  },
  '群聊系统事件 (social.js:1867-1874)': {
    id: 'msg_sys_1757300000000_ab12', role: 'system', content: 'A joined the group', friendId: 'group_1757',
    timestamp: 1757300000000, metadata: { eventType: 'member_join', characterId: 'friend_1' }
  },
  'proactive (active-diary.js:1301-1304)': {
    id: 'active_setting1_1757300000000', role: 'assistant', content: '在吗', friendId: 'friend_1',
    timestamp: 1757300000000, metadata: { source: 'active_message', activePlanId: 'p1' }
  },
  '语音通话行 (communication.js:1993)': {
    id: 'msg_1757300000000_u', role: 'user', content: 'hi', friendId: 'friend_1', timestamp: 1757300000000,
    metadata: { source: 'voice_call', callSessionId: 'cs1', turnId: 't1' }
  },
  '带附件 (communication.js:1990-1992)': {
    id: 'msg_1757300000000_u', role: 'user', content: '看这个', friendId: 'friend_1', timestamp: 1757300000000,
    images: [{ dataUrl: 'data:image/png;base64,QQ==', base64: 'QQ==', mime: 'image/png', name: 'a.png' }],
    files: [{ name: 'n.txt', ext: 'txt', size: 3, text: 'hey' }],
    voice: { dataUrl: 'data:audio/mp3;base64,QQ==', mime: 'audio/mp3', duration: 2, transcript: '文字', tone: 'calm' }
  },
  '撤回墓碑 (communication.js:3370-3373)': {
    id: 'msg_1757300000000_1', role: 'assistant', content: '【A撤回了一条消息】', friendId: 'friend_1',
    timestamp: 1757300000000, withdrawn: true, withdrawnBy: 'self'
  }
};
for (const [label, sample] of Object.entries(SHAPES)) {
  const v = CORE.validateMessage(sample);
  check('生产形状通过校验：' + label, v.ok === true, v.errors);
}

/* ── 3 · 校验词表稳定且可分支 ─────────────────────────────────────── */
const BAD = [
  ['not-an-object', null],
  ['not-an-object', 'string'],
  ['not-an-object', []],
  ['missing-id', { role: 'user', content: '', friendId: 'f', timestamp: 1 }],
  ['bad-role', { id: 'x', role: 'robot', content: '', friendId: 'f', timestamp: 1 }],
  ['bad-content', { id: 'x', role: 'user', content: 5, friendId: 'f', timestamp: 1 }],
  ['missing-friendId', { id: 'x', role: 'user', content: '', friendId: '', timestamp: 1 }],
  ['bad-timestamp', { id: 'x', role: 'user', content: '', friendId: 'f', timestamp: 0 }],
  ['bad-timestamp', { id: 'x', role: 'user', content: '', friendId: 'f', timestamp: 'now' }],
  ['bad-threadId', { id: 'x', role: 'user', content: '', friendId: 'f', timestamp: 1, threadId: 5 }],
  ['bad-reasoning_content', { id: 'x', role: 'assistant', content: '', friendId: 'f', timestamp: 1, reasoning_content: 5 }],
  ['bad-images', { id: 'x', role: 'user', content: '', friendId: 'f', timestamp: 1, images: {} }],
  ['bad-files', { id: 'x', role: 'user', content: '', friendId: 'f', timestamp: 1, files: 'nope' }],
  ['bad-voice', { id: 'x', role: 'user', content: '', friendId: 'f', timestamp: 1, voice: 'nope' }],
  ['bad-metadata', { id: 'x', role: 'assistant', content: '', friendId: 'f', timestamp: 1, metadata: [] }]
];
for (const [code, sample] of BAD) {
  const v = CORE.validateMessage(sample);
  check('校验词表 ' + code + '（' + JSON.stringify(sample && sample.role) + '）', v.ok === false && v.errors.indexOf(code) >= 0, v.errors);
}
check('校验失败时给出 errors 数组（不是抛错）', Array.isArray(CORE.validateMessage(null).errors));

/* ── 4 · id 形状：承认既有五种，且绝不重新生成 ───────────────────── */
const IDS = [
  ['msg_1757300000000_u', true],
  ['msg_1757300000000_12345', true],
  ['msg_1757300000000_12345_2', true],
  ['msg_sys_1757300000000_ab12', true],
  ['active_setting1_1757300000000', true],
  ['msg_req_1a2b3c4d5e6f_u', true],
  ['', false],
  ['not-a-message-id', false]
];
for (const [id, expected] of IDS) {
  check('id 形状识别 ' + JSON.stringify(id), CORE.isKnownMessageId(id) === expected, CORE.isKnownMessageId(id));
}
check('generateMessageId 保持既有形状（user）', /^msg_\d+_u$/.test(CORE.generateMessageId('user', { now: 1 })));
check('generateMessageId 保持既有形状（assistant）', /^msg_\d+_\d+$/.test(CORE.generateMessageId('assistant', { now: 1 })));
check('generateMessageId 保持既有形状（system）', /^msg_sys_\d+_[a-z0-9]{1,6}$/.test(CORE.generateMessageId('system', { now: 1 })));
check('generateMessageId 分段后缀与 communication.js:2385 同形', /^msg_\d+_\d+_2$/.test(CORE.generateMessageId('assistant', { now: 1, part: 2 })));

/* ── 5 · conversation identity ───────────────────────────────────── */
check('dm 主对话', CORE.conversationIdOf('friend_1', null) === 'dm:friend_1', CORE.conversationIdOf('friend_1', null));
check('dm 主对话（空 threadId 等价于无）', CORE.conversationIdOf('friend_1', '') === 'dm:friend_1');
check('dm 话题频道', CORE.conversationIdOf('friend_1', 'th1') === 'dm:friend_1|th1');
check('group 主对话', CORE.conversationIdOf('group_1757', null) === 'group:group_1757');
check('group 话题频道', CORE.conversationIdOf('group_1757', 'th1') === 'group:group_1757|th1');
check('群聊判定只按前缀（与 production 一致）',
  CORE.isGroupFriendId('group_1') === true && CORE.isGroupFriendId('friend_1') === false && CORE.isGroupFriendId('mygroup_1') === false);
check('从消息派生 conversationId（无 threadId 走主对话）',
  CORE.conversationIdOfMessage({ friendId: 'friend_1' }) === 'dm:friend_1');
check('从消息派生 conversationId（有 threadId）',
  CORE.conversationIdOfMessage({ friendId: 'friend_1', threadId: 'th1' }) === 'dm:friend_1|th1');
check('缺 friendId 的消息派生返回 null（绝不猜）', CORE.conversationIdOfMessage({ threadId: 'th1' }) === null);

/* 逆函数：对每一个生产者形状都精确 */
const PARSE_CASES = [
  ['dm:friend_1', { kind: 'dm', friendId: 'friend_1', threadId: '', isGroup: false }],
  ['dm:friend_1|th1', { kind: 'dm', friendId: 'friend_1', threadId: 'th1', isGroup: false }],
  ['group:group_1757', { kind: 'group', friendId: 'group_1757', threadId: '', isGroup: true }],
  ['group:group_1757|th1', { kind: 'group', friendId: 'group_1757', threadId: 'th1', isGroup: true }],
  /* 真实世界：friendId 自身可能含冒号或竖线以外的字符，前缀长度固定因此仍精确 */
  ['dm:a:b:c', { kind: 'dm', friendId: 'a:b:c', threadId: '', isGroup: false }],
  ['dm:msg_1757_u', { kind: 'dm', friendId: 'msg_1757_u', threadId: '', isGroup: false }]
];
for (const [cid, expected] of PARSE_CASES) {
  const parsed = CORE.parseConversationId(cid);
  check('parseConversationId ' + cid,
    !!parsed && parsed.kind === expected.kind && parsed.friendId === expected.friendId &&
    parsed.threadId === expected.threadId && parsed.isGroup === expected.isGroup && parsed.conversationId === cid,
    parsed);
}
check('parseConversationId 对畸形输入返回 null（绝不猜）',
  CORE.parseConversationId('nonsense') === null &&
  CORE.parseConversationId('dm:') === null &&
  CORE.parseConversationId('dm:group_1') === null &&
  CORE.parseConversationId('group:friend_1') === null);

/* 往返：任意 (friendId, threadId) → id → 解析 → 原样 */
const ROUND_TRIP = [
  ['friend_1', ''], ['friend_1', 'th1'], ['group_1757', ''], ['group_1757', 'th2'],
  ['a:b:c', 'd|e'], ['weird id with spaces', 'th:1']
];
for (const [fid, tid] of ROUND_TRIP) {
  const cid = CORE.conversationIdOf(fid, tid);
  const back = CORE.parseConversationId(cid);
  check('conversationId 往返一致 ' + JSON.stringify([fid, tid]),
    !!back && back.friendId === fid && back.threadId === tid, { cid: cid, back: back });
}
/* thread 不串：同一 friend 的两个 thread 必须是两个不同会话 */
check('不同 thread 派生不同 conversationId（thread 不串）',
  CORE.conversationIdOf('f', 't1') !== CORE.conversationIdOf('f', 't2') &&
  CORE.conversationIdOf('f', 't1') !== CORE.conversationIdOf('f', null));
/* dm 与 group 即使 friendId 只差前缀也不相等 */
check('dm 与 group 命名空间不冲突', CORE.conversationIdOf('group_1') !== CORE.conversationIdOf('1'));

/* ── 6 · requestId → userMessageId 确定性 ───────────────────────── */
const ridA = CORE.messageIdFromRequest('req-abc-123');
check('同 requestId 恒得同 messageId（确定性）',
  ridA === CORE.messageIdFromRequest('req-abc-123') && /^msg_req_[a-z0-9]+_u$/.test(ridA), ridA);
check('不同 requestId 得不同 messageId',
  CORE.messageIdFromRequest('a') !== CORE.messageIdFromRequest('b'));
check('空 requestId 返回 null（绝不生成巧合 id）',
  CORE.messageIdFromRequest('') === null && CORE.messageIdFromRequest(null) === null);
check('requestId 派生 id 被 isKnownMessageId 承认', CORE.isKnownMessageId(ridA) === true);

/* ── 7 · canonicalize：未知字段保留但被报告 ─────────────────────── */
const canonical = CORE.canonicalize({ id: 'i', role: 'user', content: 'c', friendId: 'f', timestamp: 1, futureField: 42, threadId: '' });
check('canonicalize 保留未知字段（绝不静默丢数据）', canonical.message.futureField === 42, canonical.message);
check('canonicalize 把未知字段报告在 dropped', canonical.dropped.indexOf('futureField') >= 0, canonical.dropped);
check('canonicalize 把空 threadId 归一为不存在（与所有生产写入真值判断一致）',
  canonical.message.threadId === undefined, canonical.message.threadId);
check('canonicalize 不改动已知字段的值',
  canonical.message.id === 'i' && canonical.message.timestamp === 1 && canonical.message.content === 'c');
check('canonicalize 是浅拷贝（不共享顶层对象）',
  (function () { const src = { id: 'i', role: 'user', content: 'c', friendId: 'f', timestamp: 1 }; const out = CORE.canonicalize(src).message; return out !== src && JSON.stringify(out) === JSON.stringify(src); })());

/* ── 8 · 分页默认值与审计 §8.2 一致 ─────────────────────────────── */
check('默认列表页 ≤ 50（审计 chat.history limit≤50）', CORE.DEFAULT_LIST_LIMIT === 50, CORE.DEFAULT_LIST_LIMIT);
check('limit 归一：非法值回落默认', CORE.normalizeLimit(0, 50, 500) === 50 && CORE.normalizeLimit(-3, 50, 500) === 50 && CORE.normalizeLimit('x', 50, 500) === 50);
check('limit 归一：超上限被夹住', CORE.normalizeLimit(99999, 50, 500) === 500);
check('批量写入上限 ≤ 500（单请求体积可控）', CORE.MAX_MIGRATION_BATCH <= 500, CORE.MAX_MIGRATION_BATCH);

/* ── 9 · 群聊前缀格式 ───────────────────────────────────────────── */
check('群聊历史注入格式与 communication.js:1740-1747 一致',
  CORE.groupPrefix('小明', '在吗') === '[小明] 在吗', CORE.groupPrefix('小明', '在吗'));

console.log('');
if (failed) { console.error('Chat Message Contract 测试失败：' + failed + ' 项 ✘（通过 ' + passed + '）'); process.exitCode = 1; }
else console.log('Chat Message Contract tests passed ✔ (' + passed + ' 项)');
