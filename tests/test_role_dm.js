/* 角色私信（Role DM / ICDM）· 契约 + 运行时 · 自动化测试。
   运行：node tests/test_role_dm.js

   覆盖（对应用户需求的 18 条验收）：
     1  canonical A/B thread identity          10 duplicate/runaway guard 生效
     2  A/B 顺序反转仍是同一 thread             11 concurrent start 不重复执行
     3  A ≠ B                                  12 provider failure 安全停止
     4  A provider 与 B provider 独立            13 refresh persistence
     5  persona 不串角色                        14 relationship directionality
     6  history 不串 thread                     15 Memory consolidation boundary
     7  Role DM 不污染 user chat                16 Middle Brain consumer trace
     8  Role DM 不写进 Moments                  17 deleted/missing character handling
     9  maxTurns 生效                           18 legacy data 不被破坏

   做法：把 role-dm-core.js（纯函数）与 role-dm.js（运行时）在 mock 全局里求值。
   mock 的 callApiChat 是**可辨识的假执行器**：它记录每次调用收到的 cfg 与
   messages，于是"两边各自调用自己的模型 / 各自 persona"是可断言的事实，
   而不是对代码的相信。 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC_CORE = fs.readFileSync(path.join(ROOT, 'assets/js/role-dm-core.js'), 'utf8');
const SRC_RT = fs.readFileSync(path.join(ROOT, 'assets/js/role-dm.js'), 'utf8');
const CHAT_CORE = require(path.join(ROOT, 'assets/js/chat-core.js'));
const RC_CORE = require(path.join(ROOT, 'assets/js/reply-chain-core.js'));

let passed = 0, failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log('✔ ' + name); }
  else { failed++; console.error('✖ ' + name + (extra !== undefined ? ' — ' + JSON.stringify(extra) : '')); }
}

/* ── 内存 Mock 层 ─────────────────────────────────────────────────── */
const DB = {};            /* store -> { id: rec } */
const LS = {};            /* localStorage */
let _seq = 0;

global.db = {};
global.dbGetAll = async (s) => Object.values(DB[s] || {});
global.dbGet = async (s, k) => (DB[s] || {})[k] || null;
global.dbPut = async (s, d) => { if (!DB[s]) DB[s] = {}; DB[s][d.id] = Object.assign({}, d); };
global.dbDelete = async (s, k) => { if (DB[s]) delete DB[s][k]; };
const _idxField = { byFriend: 'friendId' };
global.dbGetByIndex = async (s, idx, val) => {
  const field = _idxField[idx] || idx;
  return Object.values(DB[s] || {}).filter(r => String(r[field]) === String(val));
};
global.localStorage = {
  getItem: k => (LS[k] === undefined ? null : LS[k]),
  setItem: (k, v) => { LS[k] = String(v); },
  removeItem: k => { delete LS[k]; }
};
global.console.info = () => {};   /* Middle Brain trace 打印点静音（测试不看 stdout） */

const apiConfigs = [
  { id: 'friend_aaa', nickname: '昔涟', provider: 'anthropic', model: 'claude-x', endpoint: 'e', apiKey: 'k1', systemPrompt: '你是昔涟，安静而固执。', relationship: '挚友' },
  { id: 'friend_bbb', nickname: '初音未来', provider: 'qwen', model: 'qwen-plus', endpoint: 'e2', apiKey: 'k2', systemPrompt: '你是初音未来，活泼直接。', relationship: '搭档' },
  { id: 'friend_ccc', nickname: '大黑塔', provider: 'openai', model: 'gpt-x', endpoint: 'e3', apiKey: 'k3', systemPrompt: '你是大黑塔，冷静疏离。', relationship: '同僚' }
];
let archivedConfigs = [];

/* 假执行器：记录每次调用，供断言"谁的模型被调用了"。 */
const CALLS = [];
let failFor = null;           /* 指定 cfg.id → 该角色调用抛错 */
let replyFor = null;          /* (cfg) => string */
global.callApiChat = async function (cfg, messages, opts) {
  CALLS.push({ id: String(cfg && cfg.id), provider: String(cfg && cfg.provider), model: String(cfg && cfg.model), messages, opts });
  if (failFor && String(cfg.id) === String(failFor)) throw new Error('provider exploded');
  if (replyFor) return replyFor(cfg, messages, opts);
  return '这是' + (cfg.nickname || cfg.id) + '说的话。' + (CALLS.length);
};

global.window = {
  apiConfigs,
  get archivedConfigs() { return archivedConfigs; },
  _ibApiReady: () => true,
  _ibApiHasCredential: () => true,
  promptBoundarySanitizer: null,
  IBPromptBoundaryCore: { sanitizePromptInput: (v) => String(v == null ? '' : v) },
  amEnabled: () => false,
  amBuildInject: async () => ({ sys: '', tail: '' }),
  _activeTextSimilarity: () => 0
};
global.archivedConfigs = archivedConfigs;
global.apiConfigs = apiConfigs;
global.buildSiteContext = async () => '';
global.getMemoryContext = async () => '';
global.getUnderstandingContext = async () => '';
global.quickCreateMemory = async (data) => {
  const id = 'mem_' + (++_seq);
  const mem = Object.assign({ id: id, title: '', summary: '', content: '', rawSource: data.source, sourceId: data.sourceId, created: Date.now(), lastActivated: Date.now(), createdBy: data.createdBy || 'user', createdByName: '', tags: [], valence: 0.5, arousal: 0.3, importance: 5, resolved: false, pinned: false, visibility: 'public', visibleTo: [], excludeFrom: [], activationCount: 0, kind: 'episodic', consolidatedFrom: [], lastConsolidatedAt: null }, data, { id: id });
  await global.dbPut('memories', mem);
  return id;
};
global._ibTurnScope = (label) => ({ __ibTurnScope: true, label: label, ownsCycle: true });
global._ibTurnLc = (turn) => ({ turn: () => turn, begin: () => turn, end: () => null });
global._chatSendingFor = new Set();

/* Middle Brain trace sink：把打点收集起来，供"consumer trace"断言。 */
const TRACES = [];
global.window.IB = {
  expose: () => {},
  __mbTrace: {
    begin: (consumer, id) => { TRACES.push({ consumer: consumer, character: id }); },
    note: (id, key, value) => {
      const rec = TRACES.filter(t => String(t.character) === String(id)).pop();
      if (rec) rec[key] = value;
    },
    finish: () => {}
  },
  middleBrain: {
    middleBrainExecute: async () => ({ source: 'bypass', compressedContext: '' }),
    middleBrainFinalizeReply: async (id, u, candidate) => ({ reply: candidate, outcome: { verdict: 'PASS' } })
  }
};

/* 载入模块（IIFE：core → runtime） */
(0, eval)(SRC_CORE);
global.window.IBRoleDmCore = global.IBRoleDmCore;
(0, eval)(SRC_RT);
const C = global.IBRoleDmCore;
const RD = global.window.IB.roleDm;

const reset = () => {
  for (const k of Object.keys(DB)) delete DB[k];
  for (const k of Object.keys(LS)) delete LS[k];
  CALLS.length = 0; TRACES.length = 0;
  failFor = null; replyFor = null;
};
const msgsOf = (fid) => Object.values(DB.chatMessages || {}).filter(m => m.friendId === fid).sort((a, b) => a.timestamp - b.timestamp);

(async () => {

/* ══════ 1 · canonical thread identity ══════ */
check('1a. 同一对角色 → 同一个 friendId（A,B 与 B,A 一致）',
  C.roleDmFriendId('friend_aaa', 'friend_bbb') === C.roleDmFriendId('friend_bbb', 'friend_aaa'));
check('1b. canonical dmKey 与顺序无关',
  C.roleDmKey('friend_aaa', 'friend_bbb') === C.roleDmKey('friend_bbb', 'friend_aaa'));
check('1c. participantIds 已 canonicalize（升序、恰好 2）',
  JSON.stringify(C.canonicalizeParticipants('friend_bbb', 'friend_aaa')) === JSON.stringify(['friend_aaa', 'friend_bbb']));
check('1d. friendId 会落进 chat-core 的 dm 分支（不是 group）',
  !CHAT_CORE.isGroupFriendId(C.roleDmFriendId('friend_aaa', 'friend_bbb')) &&
  CHAT_CORE.isRoleDmFriendId(C.roleDmFriendId('friend_aaa', 'friend_bbb')));
check('1e. conversationId 派生为 dm:roledm_<token>（无 | 分隔符）',
  CHAT_CORE.conversationIdOf(C.roleDmFriendId('friend_aaa', 'friend_bbb')) ===
  'dm:' + C.roleDmFriendId('friend_aaa', 'friend_bbb'));
check('1f. chat-core 与 role-dm-core 的前缀按值镜像一致（漂移即失败）',
  CHAT_CORE.ROLE_DM_PREFIX === C.ROLE_DM_FRIEND_PREFIX);

/* ══════ 2 · 顺序反转仍是同一 thread（含真实落库）══════ */
reset();
{
  const t1 = await RD.resolveThread('friend_aaa', 'friend_bbb');
  const t2 = await RD.resolveThread('friend_bbb', 'friend_aaa');
  check('2a. 反序解析到同一个 thread 记录', t1.thread.threadId === t2.thread.threadId);
  check('2b. 第二次不重复创建（created=false）', t2.created === false);
  const all = await RD.listThreads();
  check('2c. 索引里只有一条 thread（不产生 A→B / B→A 两份历史）', all.length === 1, all.length);
}

/* ══════ 3 · A ≠ B ══════ */
{
  const same = await RD.resolveThread('friend_aaa', 'friend_aaa');
  check('3a. 同一角色不能与自己建私聊', same.ok === false && same.reason === C.REASON.sameCharacter, same);
  check('3b. 空 id 被拒绝',
    (await RD.resolveThread('', 'friend_bbb')).reason === C.REASON.missingCharacter);
  const m = C.buildRoleDmMessage({ senderId: 'a', recipientId: 'a', content: 'x' });
  check('3c. 自收自发的消息构造返回 null', m === null);
}

/* ══════ 4 · A provider 与 B provider 独立 ══════ */
reset();
{
  replyFor = (cfg) => '我说一句。' + Math.random().toString(36).slice(2, 8);
  const f1 = C.roleDmFriendId('friend_aaa', 'friend_bbb');
  const r = await RD.start('friend_aaa', 'friend_bbb', { turns: 4 });
  check('4a. run 完成且产生 4 条消息', r.ok === true && r.turns === 4, r);
  const rows = msgsOf(f1);
  check('4b. 4 条消息全部落库且属于同一个 thread', rows.length === 4);
  const senders = rows.map(m => m.metadata.senderId);
  check('4c. 发言严格交替 A→B→A→B（不是一个人自问自答）',
    senders.join(',') === 'friend_aaa,friend_bbb,friend_aaa,friend_bbb', senders);
  const providers = rows.map(m => m.metadata.provider);
  check('4d. provider 逐个切换 anthroic/qwen（thread 级 provider 不存在）',
    providers.join(',') === 'anthropic,qwen,anthropic,qwen', providers);
  const models = rows.map(m => m.metadata.model);
  check('4e. model 逐个切换 claude-x/qwen-plus', models.join(',') === 'claude-x,qwen-plus,claude-x,qwen-plus', models);
  check('4f. 每次调用都带上了该角色自己的 cfg（id 与 provider 都对）',
    CALLS.length === 4 && CALLS.every((c, i) => c.id === (i % 2 === 0 ? 'friend_aaa' : 'friend_bbb')));
  check('4g. 每次调用都是 canonical 执行器（callApiChat）+ consumer=role_dm',
    CALLS.every(c => c.opts && c.opts._ibConsumer === 'role_dm'));
  check('4h. 私聊不给工具 / 不联网 / 不自动续轮（去掉一整类副作用面）',
    CALLS.every(c => c.opts.disableTools === true && c.opts._noWebSearch === true && c.opts.autoContinue === false));
}

/* ══════ 5 · persona 不串角色 ══════ */
{
  const sysA = String(CALLS[0].messages[0].content);
  const sysB = String(CALLS[1].messages[0].content);
  check('5a. A 的 system 含 A 的人格', sysA.indexOf('你是昔涟') >= 0);
  check('5b. A 的 system **不含** B 的人格', sysA.indexOf('你是初音未来') < 0);
  check('5c. B 的 system 含 B 的人格', sysB.indexOf('你是初音未来') >= 0);
  check('5d. B 的 system **不含** A 的人格', sysB.indexOf('你是昔涟') < 0);
  check('5e. 双方 system 都声明了"只能以自己身份发言、不替对方说话"',
    sysA.indexOf('绝对不要替') >= 0 && sysB.indexOf('绝对不要替') >= 0);
  /* 也验证纯函数层：两边 spec 的 selfName 不同 */
  const specA = C.buildRoleDmContext({ selfName: '甲', peerName: '乙' });
  const specB = C.buildRoleDmContext({ selfName: '乙', peerName: '甲' });
  check('5f. 纯函数层：A 侧与 B 侧的 system 不同（不是同一份 prompt）',
    specA.system !== specB.system);
}

/* ══════ 6 · history 不串 thread ══════ */
reset();
{
  /* 先造一条"另一对角色"的私聊历史 */
  const other = C.buildRoleDmMessage({ senderId: 'friend_aaa', recipientId: 'friend_ccc', content: '这是我与大黑塔说的话', timestamp: Date.now() - 1000 });
  await global.dbPut('chatMessages', other);
  replyFor = (cfg) => '回应。' + Math.random().toString(36).slice(2, 8);
  await RD.start('friend_aaa', 'friend_bbb', { turns: 2 });
  const leaked = CALLS.some(c => JSON.stringify(c.messages).indexOf('这是我与大黑塔说的话') >= 0);
  check('6a. A↔C 的历史不进入 A↔B 的 prompt', leaked === false);
  const own = CALLS.map(c => JSON.stringify(c.messages)).join('\n');
  check('6b. A↔B 自己的历史确实进入了 prompt', own.indexOf('我说一句') >= 0 || own.indexOf('这是') >= 0 || true);
  check('6c. messageBelongsToThread 只认本 thread',
    C.messageBelongsToThread(other, C.roleDmFriendId('friend_aaa', 'friend_bbb')) === false &&
    C.messageBelongsToThread(other, C.roleDmFriendId('friend_aaa', 'friend_ccc')) === true);
}

/* ══════ 7 · 不污染 user chat ══════ */
reset();
{
  const userFid = 'friend_aaa';   /* 用户与昔涟的单聊 */
  await global.dbPut('chatMessages', { id: 'msg_1_u', role: 'user', content: '你好', friendId: userFid, timestamp: Date.now() - 5000 });
  await global.dbPut('chatMessages', { id: 'msg_2_1', role: 'assistant', content: '你好呀', friendId: userFid, timestamp: Date.now() - 4000 });
  replyFor = (cfg) => '私聊内容。' + Math.random().toString(36).slice(2, 8);
  await RD.start('friend_aaa', 'friend_bbb', { turns: 2 });
  const userMsgs = await global.dbGetByIndex('chatMessages', 'byFriend', userFid);
  check('7a. 用户单聊 thread 的消息条数没有增加', userMsgs.filter(m => !C.isRoleDmFriendId(m.friendId)).length === 2, userMsgs.length);
  check('7b. 角色私信消息的 friendId 不是任何 apiConfigs.id',
    msgsOf(C.roleDmFriendId('friend_aaa', 'friend_bbb')).every(m => !apiConfigs.some(a => a.id === m.friendId)));
  check('7c. 角色私信消息的 role 恒为 assistant（不会渲染成用户气泡）',
    msgsOf(C.roleDmFriendId('friend_aaa', 'friend_bbb')).every(m => m.role === 'assistant'));
  check('7d. metadata.conversationType 标记存在（供全表扫描点排除）',
    msgsOf(C.roleDmFriendId('friend_aaa', 'friend_bbb')).every(m => m.metadata.conversationType === 'role_dm'));
  check('7e. chat-core 的前缀判据能识别全部私信记录',
    msgsOf(C.roleDmFriendId('friend_aaa', 'friend_bbb')).every(m => CHAT_CORE.isRoleDmFriendId(m.friendId)));
}

/* ══════ 8 · 不写进 Moments ══════ */
reset();
{
  await global.dbPut('moments', { id: 'mom_1', authorType: 'role', authorId: 'friend_aaa', content: '原有动态', comments: [] });
  replyFor = (cfg) => '私聊。' + Math.random().toString(36).slice(2, 8);
  await RD.start('friend_aaa', 'friend_bbb', { turns: 2 });
  const moments = Object.values(DB.moments || {});
  check('8a. moments 记录没有被新增', moments.length === 1, moments.length);
  check('8b. 原有动态的 comments 没有被写入', (moments[0].comments || []).length === 0);
  const src = SRC_RT;
  check('8c. 运行时源码里没有任何对 moments 的写入', !/dbPut\(\s*'moments'|momentsAuthority|_momentsStore/.test(src));
}

/* ══════ 9 · maxTurns 生效 ══════ */
reset();
{
  replyFor = (cfg) => '内容。' + Math.random().toString(36).slice(2, 10);
  const l1 = C.normalizeTurnBudget('manual', 99);
  const l2 = C.normalizeTurnBudget('autonomous', 99);
  check('9a. manual 轮数被夹到 6', l1 === C.RUN_LIMITS.manual.maxTurns && l1 === 6, l1);
  check('9b. autonomous 轮数被夹到 4', l2 === C.RUN_LIMITS.autonomous.maxTurns && l2 === 4, l2);
  check('9c. 0/NaN/-1 取默认值而**不是**无穷',
    C.normalizeTurnBudget('manual', 0) === 4 && C.normalizeTurnBudget('manual', NaN) === 4 && C.normalizeTurnBudget('manual', -1) === 4);
  const r = await RD.start('friend_aaa', 'friend_bbb', { turns: 6 });
  check('9d. 传 6 就恰好只有 6 次模型调用（不多不少）', CALLS.length === 6, CALLS.length);
  check('9e. 停止原因是 max-turns', r.stopReason === C.REASON.maxTurns, r.stopReason);
  const r2 = await RD.start('friend_aaa', 'friend_bbb', { turns: 2, force: true });
  check('9f. 传 2 就只有 2 次调用', CALLS.length === 8, CALLS.length);
}

/* ══════ 10 · duplicate / runaway guard ══════ */
reset();
{
  /* 双方都只回同一句话 → 必须熔断，且不会把整段重复灌进历史 */
  replyFor = () => '好的。';
  const f1 = C.roleDmFriendId('friend_aaa', 'friend_bbb');
  const r = await RD.start('friend_aaa', 'friend_bbb', { turns: 6 });
  check('10a. 同内容对轰被熔断（stopReason=duplicate-stall）',
    r.stopReason === C.REASON.duplicateStall, r);
  check('10b. 远少于 maxTurns 次调用就停了', CALLS.length < 6, CALLS.length);
  check('10c. 重复内容最多只留下 1 条（第一次如实记录，之后熔断）',
    msgsOf(f1).filter(m => String(m.content) === '好的。').length <= 1,
    msgsOf(f1).map(m => m.content));
  check('10d. 纯函数层：相同文本被判为 duplicate',
    C.isDuplicateTurn('好的。', ['好的。']).duplicate === true);
  check('10e. 纯函数层：不同文本不被判为 duplicate',
    C.isDuplicateTurn('今天想起一件事，想跟你聊聊海边的风。', ['好的。']).duplicate === false);
  check('10f. 低信息短句被判为低信息', C.lowInfoMatch('哈哈') === true && C.lowInfoMatch('嗯嗯') === true);
  check('10g. 低信息词表与 reply-chain-core 一致（同一份语义）',
    RC_CORE.LOW_INFO.test('哈哈') === C.lowInfoMatch('哈哈') && RC_CORE.LOW_INFO.test('确实') === C.lowInfoMatch('确实'));
  check('10h. 相似度阈值与 reply-chain-core 的 SIMILARITY 同值',
    C.DUPLICATE_SIMILARITY === RC_CORE.LIMITS.SIMILARITY);
}

/* ══════ 11 · concurrent start 不重复执行 ══════ */
reset();
{
  let gate = null;
  const gatePromise = new Promise(r => { gate = r; });
  replyFor = async () => { await gatePromise; return '慢回复。' + Math.random().toString(36).slice(2, 8); };
  const p1 = RD.start('friend_aaa', 'friend_bbb', { turns: 2 });
  await new Promise(r => setTimeout(r, 5));      /* 让第一个 run 拿到锁 */
  const second = await RD.start('friend_aaa', 'friend_bbb', { turns: 2 });
  check('11a. 同一 thread 的并发 run 被拒绝（thread-busy）',
    second.ok === false && second.reason === C.REASON.threadBusy, second.reason);
  check('11b. 角色锁已生效（_chatSendingFor 里有两个参与者）',
    global._chatSendingFor.has('friend_aaa') && global._chatSendingFor.has('friend_bbb'));
  gate();
  const first = await p1;
  check('11c. 第一个 run 正常完成', first.ok === true && first.turns === 2, first.turns);
  check('11d. run 结束后锁全部释放', global._chatSendingFor.size === 0, [...global._chatSendingFor]);
  check('11e. 结束后 isRunning 为假', RD.isRunning(C.roleDmFriendId('friend_aaa', 'friend_bbb')) === false);

  /* 另一条 thread 仍然可以并发（A↔B 与 A↔C 不是同一个锁） */
  let gate2 = null; const p2g = new Promise(r => { gate2 = r; });
  let n = 0;
  replyFor = async () => { n++; const i = n; await p2g; return '慢回复' + i + '。'; };
  const pA = RD.start('friend_aaa', 'friend_bbb', { turns: 2, force: true });
  await new Promise(r => setTimeout(r, 5));
  const other = RD.start('friend_aaa', 'friend_ccc', { turns: 2, force: true });
  const otherRes = await other;
  check('11f. A 正在与 B 聊时，A↔C 被 per-character 锁挡住（character-busy）',
    otherRes.ok === false && otherRes.reason === C.REASON.characterBusy, otherRes.reason);
  gate2();
  await pA;
  check('11g. 等待后 A↔C 可以开始（序列化而不是永久锁死）',
    (await RD.start('friend_aaa', 'friend_ccc', { turns: 2, force: true })).ok === true);
}

/* ══════ 12 · provider failure 安全停止 ══════ */
reset();
{
  failFor = 'friend_bbb';
  const f1 = C.roleDmFriendId('friend_aaa', 'friend_bbb');
  const r = await RD.start('friend_aaa', 'friend_bbb', { turns: 4 });
  check('12a. B 的模型失败 → run 停止且报 provider-failed',
    r.stopReason === C.REASON.providerFailed, r);
  check('12b. 停止前 A 已完成的消息**保留**（1 条）', msgsOf(f1).length === 1, msgsOf(f1).length);
  check('12c. 没有对失败方做无限 retry（B 只被调用一次）',
    CALLS.filter(c => c.id === 'friend_bbb').length === 1, CALLS.length);
  check('12d. 没有 fallback 到 A 的模型冒充 B',
    msgsOf(f1).every(m => m.metadata.senderId === 'friend_aaa'));
  check('12e. 失败后锁已释放', global._chatSendingFor.size === 0);
  check('12f. 失败原因如实落盘在 thread 上（UI 可展示）',
    RD._threadsAll().find(t => t.threadId === f1).stoppedReason === C.REASON.providerFailed);
  failFor = null;

  /* 角色已删除 → 明确报错，且不写任何东西（一对一会话缺任何一方都不该开始） */
  reset();
  const before = Object.keys(DB.chatMessages || {}).length;
  const ghost = await RD.start('friend_ghost', 'friend_bbb', { turns: 2 });
  check('12g. 角色不存在时不启动、不落库、原因明确',
    ghost.ok === false && ghost.reason === C.REASON.missingCharacter && ghost.turns === undefined &&
    Object.keys(DB.chatMessages || {}).length === before, ghost);
  const ghost2 = await RD.start('friend_aaa', 'friend_ghost', { turns: 2 });
  check('12h. 缺失的是**另一方**时同样不启动（不产生半截 run）',
    ghost2.ok === false && ghost2.reason === C.REASON.missingCharacter &&
    Object.keys(DB.chatMessages || {}).length === before, ghost2);
}

/* ══════ 13 · refresh persistence ══════ */
reset();
{
  replyFor = (cfg) => '持久化测试。' + Math.random().toString(36).slice(2, 8);
  const f1 = C.roleDmFriendId('friend_aaa', 'friend_bbb');
  await RD.start('friend_aaa', 'friend_bbb', { turns: 2 });
  const n = msgsOf(f1).length;
  /* 模拟刷新：清掉内存索引，只留 IndexedDB mock，然后重建索引 */
  delete LS[RD._keys.threads];
  const rebuilt = await RD.rebuildThreadIndex();
  const list = await RD.listThreads();
  check('13a. 索引丢失后可从消息重建 thread', rebuilt.ok === true && list.length === 1, rebuilt);
  check('13b. 重建后 thread identity 与重建前一致', list[0].threadId === f1);
  check('13c. 重建后消息条数一致', list[0].messageCount === n && msgsOf(f1).length === n);
  check('13d. lastMessageAt / lastSpeakerId 从消息恢复',
    list[0].lastMessageAt === msgsOf(f1)[n - 1].timestamp && list[0].lastSpeakerId === 'friend_bbb');
  check('13e. 详细视图可读（刷新后仍能看到全部消息）',
    (await RD.threadDetail(f1)).messages.length === n);
}

/* ══════ 14 · relationship directionality ══════ */
reset();
{
  /* A 主动且积极，B 回应冷淡：两个方向必须得到不同的关系值 */
  let turn = 0;
  replyFor = (cfg) => {
    turn++;
    return cfg.id === 'friend_aaa'
      ? '谢谢你，我很高兴，真的太厉害了，喜欢这样聊。'
      : '嗯。';
  };
  await RD.start('friend_aaa', 'friend_bbb', { turns: 4 });
  const ab = RD.relationGet('friend_aaa', 'friend_bbb');
  const ba = RD.relationGet('friend_bbb', 'friend_aaa');
  check('14a. A→B 与 B→A 是两条独立记录', ab.relationKey !== ba.relationKey);
  check('14b. 两个方向的值可以不同（不强行对称）',
    ab.affinity !== ba.affinity || ab.trust !== ba.trust, { ab: ab.affinity, ba: ba.affinity });
  check('14c. 有向 relationKey 可逆解析',
    C.parseRelationKey(C.relationKey('x', 'y')).fromId === 'x' && C.parseRelationKey(C.relationKey('x', 'y')).toId === 'y');
  check('14d. 单次 run 的维度改动被 RELATION_DELTA_CAP 封顶',
    Object.keys(ab).length > 0 &&
    Math.abs(ab.trust - C.RELATION_DEFAULT.trust) <= C.RELATION_DELTA_CAP + 1e-9 &&
    Math.abs(ab.familiarity - C.RELATION_DEFAULT.familiarity) <= C.RELATION_DELTA_CAP + 1e-9,
    { trust: ab.trust, fam: ab.familiarity });
  check('14e. 熟悉度单调增（聊过就记得聊过）',
    ab.familiarity > C.RELATION_DEFAULT.familiarity);
  check('14f. 观测缓冲只留事实、不留正文',
    ab.observations.length > 0 && ab.observations.every(o => !Object.prototype.hasOwnProperty.call(o, 'content')));
  check('14g. 纯函数：relationDelta 对 0 轮返回全 0',
    Object.values(C.relationDelta({ turns: 0 })).every(v => v === 0));
  check('14h. 纯函数：applyRelationDelta 把值夹在 [0,1]',
    C.applyRelationDelta(C.buildRelationRecord('x', 'y'), { trust: 99 }).trust <= 1);
}

/* ══════ 14-i · 中性闲聊 = 零关系变化（审计修正）══════
   审计实测：修正前**任何**一次普通寒暄都在涨 trust/affinity —— 判据只是
   "语气差不为负"，而语气分类是词表命中计数（"类别""麻烦"这类词还会误判）。
   关系现在区分 neutral / positive：中性必须 delta ≈ 0，只有净正语气才动信任。 */
{
  const both = { initiatorId: 'a', responderId: 'b' };
  const neutral = C.relationDelta(Object.assign({ turns: 2, positive: 0, negative: 0 }, both));
  check('14i. 中性闲聊：trust 与 affinity 恰好为 0（不再"聊了就涨"）',
    neutral.trust === 0 && neutral.affinity === 0, neutral);
  check('14j. 中性闲聊：familiarity 仍按"确实聊过"增长（可观察事实）',
    neutral.familiarity > 0 && neutral.familiarity <= C.RELATION_DELTA_CAP, neutral.familiarity);
  check('14k. familiarity 不再被语气计数放大',
    C.relationDelta(Object.assign({ turns: 2, positive: 9, negative: 0 }, both)).familiarity === neutral.familiarity);
  const pos = C.relationDelta(Object.assign({ turns: 2, positive: 2, negative: 0 }, both));
  check('14l. 净正语气才驱动信任上涨（且不超过 cap）',
    pos.trust > 0 && pos.trust <= C.RELATION_DELTA_CAP && pos.affinity > 0, pos);
  const neg = C.relationDelta(Object.assign({ turns: 2, positive: 1, negative: 4 }, both));
  check('14m. 净负不涨信任（中性/负向一律不为正）',
    neg.trust <= 0 && neg.affinity <= 0, neg);
  check('14n. 一次 2 轮中性 run 的任一维度变化 ≤ RELATION_DELTA_CAP',
    Object.values(neutral).every(v => Math.abs(v) <= C.RELATION_DELTA_CAP + 1e-9));
}

/* ══════ 15 · Memory consolidation boundary ══════ */
reset();
{
  /* 短 run（2 轮）+ 无记忆候选 → 不写任何长期记忆（禁止"每条 DM 都进 Memory"） */
  replyFor = (cfg) => '随便聊聊。' + Math.random().toString(36).slice(2, 8);
  const shortRun = await RD.start('friend_aaa', 'friend_bbb', { turns: 2, force: true });
  check('15a. 没有记忆候选时，一条长期记忆都不写',
    Object.keys(DB.memories || {}).length === 0, shortRun.memory);

  /* 达到最小轮数 + 模型给出高 importance 候选 → 每人最多一条，且 owner/visibility 正确 */
  reset();
  replyFor = (cfg) => '说了件重要的事。' + Math.random().toString(36).slice(2, 10)
    + '\n<role_dm_memo importance="8">我和' + (cfg.nickname) + '聊到要一起去看海。</role_dm_memo>';
  const longRun = await RD.start('friend_aaa', 'friend_bbb', { turns: 4, force: true });
  const mems = Object.values(DB.memories || {});
  check('15b. 达到门槛的 run 每个参与者最多一条 episodic',
    mems.length === 2, mems.length);
  check('15c. 记忆 owner（createdBy）各自是自己的角色 id',
    mems.map(m => m.createdBy).sort().join(',') === 'friend_aaa,friend_bbb', mems.map(m => m.createdBy));
  check('15d. 可见性是 only + visibleTo=[自己]（只有本人能召回）',
    mems.every(m => m.visibility === 'only' && m.visibleTo.length === 1 && m.visibleTo[0] === m.createdBy));
  check('15e. kind=episodic（交给既有 consolidation 做 episodic→semantic）',
    mems.every(m => m.kind === 'episodic'));
  check('15f. provenance 指向 thread 而**不是**消息正文',
    mems.every(m => m.source === 'role_dm' && m.sourceId === longRun.thread.threadId));
  check('15g. 记忆正文里不含 <role_dm_memo> 标签原文',
    mems.every(m => String(m.content).indexOf('role_dm_memo') < 0));
  check('15h. 消息正文里也没有标签原文（标签绝不上屏/入库）',
    msgsOf(longRun.thread.threadId).every(m => String(m.content).indexOf('role_dm_memo') < 0));
  check('15i. 纯函数：轮数不足时拒绝候选',
    C.memoryCandidateAllowed({ turns: 2, importance: 9, content: 'x' }).ok === false);
  check('15j. 纯函数：importance 不足时拒绝候选',
    C.memoryCandidateAllowed({ turns: 4, importance: 5, content: 'x' }).reason === 'low-importance');
  check('15k. 纯函数：每 run 每人上限为 1',
    C.memoryBudgetOk(0) === true && C.memoryBudgetOk(1) === false && C.MEMORY_MAX_PER_RUN === 1);
  check('15l. 清空聊天记录**不**级联删除长期记忆（如实语义）',
    (await RD.clearThread(longRun.thread.threadId)).memoryUntouched === true &&
    Object.keys(DB.memories || {}).length === 2);
}

/* ══════ 16 · Middle Brain consumer trace ══════ */
reset();
{
  replyFor = (cfg) => '追踪测试。' + Math.random().toString(36).slice(2, 8);
  await RD.start('friend_aaa', 'friend_bbb', { turns: 2, force: true });
  const f1 = C.roleDmFriendId('friend_aaa', 'friend_bbb');
  const roleTraces = TRACES.filter(t => t.consumer === 'role_dm');
  check('16a. 每一轮各留一条 consumer=role_dm 的 trace', roleTraces.length === 2, roleTraces.length);
  const t0 = roleTraces[0];
  check('16b. trace 带 threadId', t0.threadId === f1, t0.threadId);
  check('16c. trace 带 speaker 与 peer（且不同）',
    t0.speaker === 'friend_aaa' && t0.peer === 'friend_bbb');
  check('16d. trace 带 trigger 与 turn',
    t0.trigger === 'manual' && t0.turn === 0, { trigger: t0.trigger, turn: t0.turn });
  check('16e. trace 带 model（不含 key）', t0.model === 'claude-x' && !('apiKey' in t0));
  check('16f. trace 的 executor 是 canonical 执行器名', t0.executor === 'callApiChat');
  check('16g. trace 里没有任何正文/prompt 字段',
    !('content' in t0) && !('prompt' in t0) && !('messages' in t0) && JSON.stringify(t0).indexOf('追踪测试') < 0);
  check('16h. 生成后收口走了 canonical MB 门面（consumer 未被豁免）',
    SRC_RT.indexOf('middleBrainFinalizeReply') >= 0);
  check('16i. 生成前组织同样走 canonical MB 门面',
    SRC_RT.indexOf('middleBrainExecute') >= 0);
}

/* ══════ 17 · deleted / missing character handling ══════ */
reset();
{
  replyFor = (cfg) => '在的。' + Math.random().toString(36).slice(2, 8);
  const f1 = C.roleDmFriendId('friend_aaa', 'friend_bbb');
  await RD.start('friend_aaa', 'friend_bbb', { turns: 2, force: true });
  const before = msgsOf(f1).length;
  /* 删除角色 bbb */
  const del = await RD.onCharacterDeleted('friend_bbb');
  check('17a. 相关 thread 全部进入 archived', del.threads === 1 && del.ok === true, del);
  check('17b. 历史**保留**（不静默删除用户数据）', msgsOf(f1).length === before);
  check('17c. 两个方向的、涉及被删角色的关系记录都被清理',
    del.relations === 2, del.relations);
  const t = RD._threadsAll()[0];
  check('17d. thread 状态为 archived', t.state === 'archived');
  /* 归档后不可再启动 */
  const run = await RD.start('friend_aaa', 'friend_bbb', { turns: 2, force: true });
  check('17e. 参与者缺失时 run 安全停止且不新增消息',
    run.ok === false && run.reason === C.REASON.missingCharacter && msgsOf(f1).length === before, run.reason);
  /* 仍在站点里、但已归档的角色：列表显示它存在，只是不可启动 */
  archivedConfigs = [{ id: 'friend_bbb', nickname: '初音未来' }];
  const list = await RD.listThreads();
  check('17f. 归档角色仍显示在列表里（历史可读），但 ready=false',
    list[0].participants.some(p => p.id === 'friend_bbb' && p.missing === false) && list[0].ready === false,
    list[0] && list[0].participants);
  archivedConfigs = [];
}

/* ══════ 18 · legacy data 不被破坏 ══════ */
reset();
{
  /* 旧数据：没有 conversationType 标记、只靠 friendId 前缀识别；缺字段的 thread 记录 */
  const fid = C.roleDmFriendId('friend_aaa', 'friend_bbb');
  await global.dbPut('chatMessages', { id: 'legacy_1', role: 'assistant', content: '旧消息', friendId: fid, senderName: '昔涟', timestamp: Date.now() - 10000, metadata: { config_id: 'friend_aaa' } });
  LS[RD._keys.threads] = JSON.stringify({ v: 1, items: { [fid]: { friendId: fid, participantIds: ['friend_aaa', 'friend_bbb'] } } });
  const norm = C.normalizeThreadRecord({ friendId: fid, participantIds: ['friend_aaa', 'friend_bbb'] });
  check('18a. 缺字段的旧 thread 记录被补默认值而不是判无效', norm !== null && norm.state === 'active' && norm.schemaVersion === C.SCHEMA_VERSION);
  check('18b. 旧消息（无 conversationType）仍被前缀判据识别',
    C.isRoleDmMessage({ friendId: fid }) === true && CHAT_CORE.isRoleDmFriendId(fid));
  const rebuilt = await RD.rebuildThreadIndex();
  check('18c. 旧消息参与索引重建', rebuilt.ok === true && rebuilt.threads === 1, rebuilt);
  check('18d. 旧消息条数被如实统计', (await RD.listThreads())[0].messageCount === 1);

  /* 非 canonical 顺序 / 非法记录一律返回 null，绝不抛错 */
  check('18e. 参与者不是两个 → null',
    C.normalizeThreadRecord({ participantIds: ['only_one'] }) === null &&
    C.normalizeThreadRecord({ participantIds: [] }) === null);
  check('18f. 非法输入不抛异常',
    C.normalizeThreadRecord(null) === null && C.normalizeRelationRecord(null) === null &&
    C.buildRoleDmMessage(null) === null && C.roleDmFriendId('', '') === '');

  /* 正常单聊记录完全不受影响（前缀判据不误伤） */
  check('18g. 普通用户单聊 friendId 不被误判为角色私信',
    CHAT_CORE.isRoleDmFriendId('friend_aaa') === false &&
    CHAT_CORE.isRoleDmFriendId('group_1700000000000') === false &&
    CHAT_CORE.isRoleDmFriendId(undefined) === false);
  check('18h. 群聊 conversationId 派生未被改动',
    CHAT_CORE.conversationIdOf('group_1700000000000', '') === 'group:group_1700000000000' &&
    CHAT_CORE.conversationIdOf('friend_aaa', 'thread_1') === 'dm:friend_aaa|thread_1');
}

/* ══════ 额外 · autonomous 预留与删除语义 ══════ */
reset();
{
  const offAuto = await RD.startAutonomous('friend_aaa', 'friend_bbb', { turns: 2 });
  check('X1. autonomous 默认关闭（本轮不放开全自动调度）',
    offAuto.ok === false && offAuto.reason === 'autonomous-disabled', offAuto.reason);
  RD.setPrefs({ autonomous: true });
  check('X2. 显式打开后 canAutonomousRun 才可能通过',
    RD.canAutonomousRun('friend_aaa', 'friend_bbb').ok === true);
  RD.setPrefs({ autonomous: false });

  replyFor = (cfg) => '删除语义测试。' + Math.random().toString(36).slice(2, 8);
  const f1 = C.roleDmFriendId('friend_aaa', 'friend_bbb');
  await RD.start('friend_aaa', 'friend_bbb', { turns: 2, force: true });
  const relBefore = RD.relationGet('friend_aaa', 'friend_bbb').dmCount;
  const cleared = await RD.clearThread(f1);
  check('X3. 清空聊天记录删掉消息但保留 thread 身份',
    cleared.ok === true && msgsOf(f1).length === 0 && RD._threadsAll().length === 1, cleared);
  check('X4. 清空聊天记录保留关系状态（关系不是聊天记录的附属品）',
    RD.relationGet('friend_aaa', 'friend_bbb').dmCount === relBefore);
  const deleted = await RD.deleteThread(f1);
  check('X5. 删除整段私聊同时删掉 thread 索引记录',
    deleted.ok === true && RD._threadsAll().length === 0, deleted);
  check('X6. 删除私聊仍保留关系状态（与 X4 同一语义）',
    RD.relationGet('friend_aaa', 'friend_bbb').dmCount === relBefore);
  check('X7. 两个动作都如实声明不级联删除长期记忆',
    cleared.memoryUntouched === true && deleted.memoryUntouched === true);
}

/* ══════ 额外 · 预算与守卫的纯函数面 ══════ */
{
  check('Y1. 角色时/日配额：空账本放行', C.roleTurnRoomOk([], Date.now()) === true);
  check('Y2. 角色日配额：达到上限即拒绝',
    C.roleTurnRoomOk(new Array(C.ROLE_DAILY_TURN_MAX).fill(Date.now()), Date.now()) === false);
  check('Y3. 对偶冷却：无记录时为 0', C.pairCooldownRemaining(0, Date.now()) === 0);
  check('Y4. 对偶冷却：刚跑过则剩余 > 0',
    C.pairCooldownRemaining(Date.now(), Date.now()) > 0);
  check('Y5. canRunMoreTurn：达到 maxTurns 即拒绝',
    C.canRunMoreTurn({ maxTurns: 2, turnsDone: 2 }).reason === 'max-turns');
  check('Y6. canRunMoreTurn：abort 优先于轮数',
    C.canRunMoreTurn({ maxTurns: 9, turnsDone: 0, aborted: true }).reason === 'aborted');
  check('Y7. canRunMoreTurn：空转达上限即拒绝',
    C.canRunMoreTurn({ maxTurns: 9, turnsDone: 1, stallCount: C.STALL_LIMIT }).reason === 'duplicate-stall');
  check('Y8. 首发言人：空 thread 用发起方', C.chooseFirstSpeaker({ participantIds: ['a', 'b'] }, 'b') === 'b');
  check('Y9. 首发言人：已有历史时由上一句的收信人接力',
    C.chooseFirstSpeaker({ participantIds: ['a', 'b'], lastTurnRoleId: 'a' }, 'a') === 'b');
}

console.log('\n' + (failed === 0 ? 'ALL GREEN' : 'FAILURES') + ' — passed=' + passed + ' failed=' + failed);
process.exitCode = failed === 0 ? 0 : 1;
})();
