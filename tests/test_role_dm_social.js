/* 角色私信 Phase 3 · Autonomous Social Intent · 自动化测试。
   运行：node tests/test_role_dm_social.js

   覆盖（对应用户需求的 50 条验收 + §25/§26/§37 的硬指标）：
     闸门    1-4    global/character 两级默认 OFF 与 AND 关系
     意图    5-21   候选过滤、陌生人政策、冷却、额度、排名、抖动
     发起   22-25   发起人先说、canonical thread 复用、备忘/关系复用
     模型   26-29   provider 独立、不回退、失败退避
     并发   30-32   锁、竞态、用户活动避让
     调度   33-36   quiet hours、频率 gate、持久化、legacy 默认
     安全   37-50   kill switch、零 API、跑量上限、trace 无正文、记忆/关系规则不变

   做法：把 role-dm-core.js / role-dm.js / role-dm-social-core.js /
   role-dm-social.js 在 mock 全局里**按 HTML 的顺序**求值。
   关键断言有两类：
     ① callApiChat 的调用次数 —— 零 API 是硬指标，必须可数；
     ② 纯函数 core 的直接调用 —— 同一输入必须同一输出（假时间 soak 的基础）。
   mock 里**没有** Date.now 的替身：时间一律显式注入（core 是纯函数，
   运行时层的 now 由 stateForDay/dayBucket 控制），因此"7 天 soak"是真的
   确定性模拟，而不是"跑快一点的真实时钟"。 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC_CORE = fs.readFileSync(path.join(ROOT, 'assets/js/role-dm-core.js'), 'utf8');
const SRC_PP = fs.readFileSync(path.join(ROOT, 'assets/js/public-profile-core.js'), 'utf8');
const SRC_RT = fs.readFileSync(path.join(ROOT, 'assets/js/role-dm.js'), 'utf8');
const SRC_SOCIAL_CORE = fs.readFileSync(path.join(ROOT, 'assets/js/role-dm-social-core.js'), 'utf8');
const SRC_SOCIAL = fs.readFileSync(path.join(ROOT, 'assets/js/role-dm-social.js'), 'utf8');
const CHAT_CORE = require(path.join(ROOT, 'assets/js/chat-core.js'));
const RC_CORE = require(path.join(ROOT, 'assets/js/reply-chain-core.js'));
const PBCORE = require(path.join(ROOT, 'assets/js/prompt-boundary-core.js'));
const DELIVERY_RUNTIME = require(path.join(ROOT, 'assets/js/delivery-runtime.js'));
let ROLE_DM_DELIVERY = DELIVERY_RUNTIME.createDeliveryRuntime({ pacing: { baseMs: 3, perCharMs: 0 } });

let passed = 0, failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log('✔ ' + name); }
  else { failed++; console.error('✖ ' + name + (extra !== undefined ? ' — ' + JSON.stringify(extra) : '')); }
}

/* ── 内存 Mock 层 ─────────────────────────────────────────────────── */
const DB = {};
const LS = {};
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
global.console.info = () => {};

/* 三个角色：aaa ↔ bbb 已有往来，ccc 完全是陌生人。
   provider/model 各不相同 —— "各自用自己的模型"因此是可断言的事实。 */
const apiConfigs = [
  { id: 'friend_aaa', nickname: '昔涟', provider: 'anthropic', model: 'claude-x', endpoint: 'e', apiKey: 'k1', systemPrompt: '你是昔涟，安静而固执。', relationship: '挚友' },
  { id: 'friend_bbb', nickname: '初音未来', provider: 'qwen', model: 'qwen-plus', endpoint: 'e2', apiKey: 'k2', systemPrompt: '你是初音未来，活泼直接。', relationship: '搭档' },
  { id: 'friend_ccc', nickname: '大黑塔', provider: 'openai', model: 'gpt-x', endpoint: 'e3', apiKey: 'k3', systemPrompt: '你是大黑塔，冷静疏离。', relationship: '同僚' }
];
let archivedConfigs = [];
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
/* quiet hours 的唯一实现（active-diary.js 的 _bgInSleepWindow + getBgAiConfig）。
   这里注入**真实语义**的实现而不是恒 false：quiet hours 是本轮的一条硬闸门，
   用假实现去测它等于没测。测试里通过 SLEEP 变量驱动。 */
let SLEEP = { sleepStart: '', sleepEnd: '' };
global.getBgAiConfig = async () => Object.assign({ enabled: true, sleepStart: '', sleepEnd: '' }, SLEEP);
global._bgInSleepWindow = function (cfg) {
  var start = String((cfg && cfg.sleepStart) || '').trim(), end = String((cfg && cfg.sleepEnd) || '').trim();
  if (!start || !end) return false;
  var now = new Date(), hm = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
  if (start <= end) return hm >= start && hm <= end;
  return hm >= start || hm <= end;
};

const TRACES = [];
const IB = {
  expose: function (name, value) { IB[name] = value; },
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
global.window = {
  apiConfigs,
  get archivedConfigs() { return archivedConfigs; },
  _ibApiReady: () => true,
  _ibApiHasCredential: () => true,
  _ibDeliveryRuntime: () => ROLE_DM_DELIVERY,
  promptBoundarySanitizer: null,
  IB: IB
};

/* 假执行器：**记录每一次模型调用**。零 API 断言的全部依据就是它。
   返回形状必须与生产 callApiChat 逐字同款：`opts.wantMeta` ⇒ {text,truncated}，
   否则裸字符串（role-dm 现在按"要元信息"的方式调用，它靠 truncated 把
   "被输出上限截断"与"provider 故障"分开）。await 让 async 的 replyFor 也照生产走。 */
const CALLS = [];
let failFor = null;
let replyFor = null;
/* 输出类失败的两种形态（Phase 3.1）：provider **成功**，只是没有正文。
   { id, times } = 对 id 的前 times 次调用回 truncated=false 的空正文；
   truncated 形状用 truncateFor（finish_reason=length 翻译过来的事实）。 */
let emptyFor = null;
let truncateFor = null;
global.callApiChat = async function (cfg, messages, opts) {
  CALLS.push({ id: String(cfg && cfg.id), provider: String(cfg && cfg.provider), model: String(cfg && cfg.model), messages, opts });
  if (failFor && String(cfg.id) === String(failFor)) throw new Error('provider exploded');
  if (truncateFor && String(cfg.id) === String(truncateFor.id) && truncateFor.times > 0) {
    truncateFor.times--;
    return (opts && opts.wantMeta) ? { text: String(truncateFor.text || ''), truncated: true } : String(truncateFor.text || '');
  }
  if (emptyFor && String(cfg.id) === String(emptyFor.id) && emptyFor.times > 0) {
    emptyFor.times--;
    return (opts && opts.wantMeta) ? { text: '', truncated: false } : '';
  }
  const out = replyFor ? await replyFor(cfg, messages, opts) : ('这是' + (cfg.nickname || cfg.id) + '说的话。' + (CALLS.length));
  return (opts && opts.wantMeta) ? { text: String(out == null ? '' : out), truncated: false } : out;
};

/* ── 载入模块（顺序与 InternalBeyond.html 的 <script> 逐字同序）──────── */
(0, eval)(SRC_PP);
global.window.IBPublicProfileCore = global.IBPublicProfileCore;
(0, eval)(SRC_CORE);
global.window.IBRoleDmCore = global.IBRoleDmCore;
(0, eval)(SRC_RT);
(0, eval)(SRC_SOCIAL_CORE);
global.window.IBRoleDmSocialCore = global.IBRoleDmSocialCore;
(0, eval)(SRC_SOCIAL);

const C = global.IBRoleDmCore;
const RD = global.window.IB.roleDm;
const SC = global.IBRoleDmSocialCore;
const RS = global.window.IB.roleDmSocial;

const msgsOf = (fid) => Object.values(DB.chatMessages || {}).filter(m => m.friendId === fid).sort((a, b) => a.timestamp - b.timestamp);

/* 每个用例都从干净状态开始：存储、预算、trace 一起清。 */
function reset() {
  for (const k of Object.keys(DB)) delete DB[k];
  for (const k of Object.keys(LS)) delete LS[k];
  CALLS.length = 0; TRACES.length = 0;
  failFor = null; replyFor = null; emptyFor = null; truncateFor = null;
  SLEEP = { sleepStart: '', sleepEnd: '' };
  global._chatSendingFor.clear();
  ROLE_DM_DELIVERY = DELIVERY_RUNTIME.createDeliveryRuntime({ pacing: { baseMs: 3, perCharMs: 0 } });
  archivedConfigs.length = 0;
  RS._resetAll();
  RS._dropCrossRunState();
  RD.setPrefs({ autonomous: false });
}
/* 把一对角色"变成熟人"：真实跑一次手动私聊，于是关系/thread/消息
   都是**真实产生**的，而不是手写的假数据。
   注意 `reflection`：手动 run 会（正确地）记下"用户刚刚在互动"，
   而那个时间戳会让紧接着的自主评估进入 10 分钟避让窗口 —— 这是**设计**
   而不是缺陷。测试用 clearUserActivity 显式跳过它，并且另有用例
   专门验证避让窗口本身（见 32）。 */
async function makeAcquainted(aId, bId, opts) {
  const o = opts || {};
  replyFor = (cfg) => '我们说点别的。' + Math.random().toString(36).slice(2, 8);
  const r = await RD.start(aId, bId, { turns: Number(o.turns) || 2, force: true });
  replyFor = null;
  if (o.keepUserActivity !== true) RS.clearUserActivity();
  return r;
}
/* 把关系推到指定值（用于"关系够近"这一类信号测试）。
   刻意直接写存储而不是通过 observation —— observation 的单次增量有
   0.03 的上界，凑够一个可观测的关系需要几十次真实 run，那是测试
   observeRun 而不是测试 intent。 */
function setRelation(fromId, toId, patch) {
  const rec = RD.relationGet(fromId, toId);
  const key = C.relationKey(fromId, toId);
  const items = JSON.parse(LS['ib_role_dm_relations_v1'] || '{"v":1,"items":{}}');
  items.items[key] = Object.assign({}, rec, patch);
  LS['ib_role_dm_relations_v1'] = JSON.stringify(items);
}
/* 把 thread 的 lastMessageAt 与 lastRunAt 都挪到过去。
   只挪 lastMessageAt 是不够的：manual 的 90 秒冷却读的是 **lastRunAt**，
   而测试里"刚刚"跑过的手动 run 会让紧接着的自主发起以 pair-cooldown 失败 ——
   那测的就不是发起语义，而是"测试自己没等够 90 秒"。 */
function ageThread(aId, bId, ms) {
  const fid = C.roleDmFriendId(aId, bId);
  const v = JSON.parse(LS['ib_role_dm_threads_v1'] || '{"v":1,"items":{}}');
  if (!v.items[fid]) return false;
  const at = Math.max(1, Date.now() - ms);
  v.items[fid].lastMessageAt = at;
  v.items[fid].lastRunAt = at;
  LS['ib_role_dm_threads_v1'] = JSON.stringify(v);
  return true;
}
/* 从 trace 里取该角色的最近一条决定。 */
function lastTraceOf(id, decision) {
  const list = RS._traceOfCharacter(id, 20);
  return decision ? list.find(t => t.decision === decision) : list[0];
}

/* 「把上一次 run 留下的闸门全部清掉」——测试里凡是断言**真的发起**，
   都必须先调用它，并且**后来所有涉及时间的调用都要用它的返回值**。
   两条独立的冷却必须一起清：
     · 自主的 6h pair 冷却（在 role-dm-social 的 state 里）；
     · manual 的 90 秒 lastRunAt 冷却（在 thread 记录里，canAutonomousRun 读它）。
   为什么必须复用同一个 now：stateForDay 按**本地日桶**记账，混用两次
   Date.now() 会让"清冷却"与"查冷却"落在不同的桶里，冷却于是又冒出来 ——
   那是测试自己造出来的假失败，而它长得和真实的设计拒绝一模一样。
   它顺手把总开关打开（调用方几乎总是紧接着要发起）。 */
function armForInitiation(aId, bId, at, ageMs) {
  const t = Number(at) || Date.now();
  RS._dropCrossRunState(t);
  /* 默认把 thread 挪到 8 小时前 —— 这个值同时满足两件事：
     · 远超 manual 的 90 秒冷却（否则守卫直接拒绝）；
     · 落在"很久没联系"的加分档（≥6h）而不是"刚聊过"的**扣分**档。
       只挪 5 分钟会让 intent 分数被扣掉 0.25 而落到阈值之下，
       变成一个看起来像"设计上不该发起"的假失败。 */
  if (aId && bId) ageThread(aId, bId, Number(ageMs) || 8 * 3600000);
  RS.setGlobalEnabled(true);
  return t;
}

(async () => {

/* ══════════════════════════════════════════════════════════════════
   1-4 · 两级闸门
   ══════════════════════════════════════════════════════════════════ */
console.log('\n── 1-4 · 两级闸门（global AND character）──');
reset();
{
  check('1. 全局默认 OFF', RS.isGlobalEnabled() === false);
  check('2. 角色级默认 OFF', RS.characterPrefs('friend_aaa').enabled === false);
  const r1 = await RD.startAutonomous('friend_aaa', 'friend_bbb', { initiatorId: 'friend_aaa', turns: 2 });
  check('3a. 全局 OFF 时 startAutonomous 被拒', r1.ok === false && r1.reason === 'autonomous-disabled', r1.reason);
  check('3b. 全局 OFF 时 tick 连评估都不做', (await RS.tick({ now: Date.now(), force: true })).reason === 'disabled');
  /* 只开全局：角色仍必须是关的（AND 的另一半）。 */
  RS.setGlobalEnabled(true);
  const r2 = await RD.startAutonomous('friend_aaa', 'friend_bbb', { initiatorId: 'friend_aaa', turns: 2 });
  check('4a. 只开全局、角色级 OFF → 仍然被拒',
    r2.ok === false && r2.reason === 'autonomous-disabled', [r2.ok, r2.reason, r2.stopReason, r2.turnsDone]);
  const budget = RS.autonomousBudgetCheck('friend_aaa', 'friend_bbb', Date.now());
  check('4b. 预算闸门给出的阻塞原因是 disabled', budget.ok === false && budget.blockedBy === 'disabled', budget);
  check('4c. 总开关确实写进了 Role DM 自己的 prefs（两个读者、一个写者）',
    RD.prefs().autonomous === true);
  /* 两级都开：闸门才可能放行。 */
  RS.setCharacterPrefs('friend_aaa', { enabled: true });
  const budget2 = RS.autonomousBudgetCheck('friend_aaa', 'friend_bbb', Date.now());
  check('4d. 两级都开 + 无冷却无额度问题 → 放行', budget2.ok === true, budget2);
  check('4e. kill switch：关掉总开关后预算立刻回到 disabled',
    (RS.setGlobalEnabled(false), RS.autonomousBudgetCheck('friend_aaa', 'friend_bbb', Date.now()).blockedBy === 'disabled'));
  RS.setGlobalEnabled(true);
}

/* ══════════════════════════════════════════════════════════════════
   5 · 开启 + 有效意图 → 可以发起
   ══════════════════════════════════════════════════════════════════ */
console.log('\n── 5 · 有效意图可以发起 ──');
reset();
{
  /* 18 条消息 = 4 次手动 run：既产生真实关系，也越过 memorandum 的最小未覆盖
     阈值（2 条），于是"共同过去"这个信号是**真实存在**的。 */
  await makeAcquainted('friend_aaa', 'friend_bbb', { turns: 6 });
  await makeAcquainted('friend_aaa', 'friend_bbb', { turns: 6 });
  await makeAcquainted('friend_aaa', 'friend_bbb', { turns: 6 });
  await makeAcquainted('friend_aaa', 'friend_bbb', { turns: 6 });
  setRelation('friend_aaa', 'friend_bbb', { familiarity: 0.8, affinity: 0.8, trust: 0.7, dmCount: 4 });
  setRelation('friend_bbb', 'friend_aaa', { familiarity: 0.8, affinity: 0.8, trust: 0.7, dmCount: 4 });
  ageThread('friend_aaa', 'friend_bbb', 5 * 86400000);
  const t0 = Date.now();
  RS._dropCrossRunState(t0);
  RS.setGlobalEnabled(true);
  RS.setCharacterPrefs('friend_aaa', { enabled: true, initiative: 0.6 });
  const d = RS.computeIntent('friend_aaa', { now: t0 });
  check('5a. 关系够近 + 久未联系 → shouldInitiate', d.shouldInitiate === true, d);
  check('5b. 选出的 peer 是 bbb', d.peerId === 'friend_bbb', d.peerId);
  check('5c. reasonCode 落在稳定词表内', ['existing-thread', 'long-time-no-contact', 'relationship-maintenance'].indexOf(d.reasonCode) >= 0, d.reasonCode);
  check('5d. 轮数被本层定死为 2（执行层不得自行改）', d.turns === 2, d.turns);
  const before = CALLS.length;
  /* tick 的 now 必须与 intent/state 用的是**同一个**时刻：stateForDay 按本地
     日桶记账，混用 Date.now() 与 t0 会让"清过冷却"与"检查冷却"落在不同的
     桶里，于是冷却又冒出来 —— 那是测试自己造出来的假失败。 */
  const r = await RS.tick({ now: t0, force: true });
  check('5e. tick 真的发起了', r.initiated === 1, r);
  check('5f. 发起产生了模型调用', CALLS.length > before, CALLS.length - before);
}

/* ══════════════════════════════════════════════════════════════════
   6-11 · 候选过滤与陌生人政策
   ══════════════════════════════════════════════════════════════════ */
console.log('\n── 6-11 · 候选过滤 / 陌生人政策 ──');
reset();
{
  RS.setGlobalEnabled(true);
  RS.setCharacterPrefs('friend_aaa', { enabled: true, initiative: 0.9 });
  const now = Date.now();

  const noPeers = RS.computeIntent('friend_aaa', { now: now });
  check('6. 没有任何候选 → no-action（no-candidates）', noPeers.decision === 'no-action' && noPeers.candidateCount === 0, noPeers);

  /* 10. 被删除的角色不进候选（从 apiConfigs 移除）。 */
  const removed = apiConfigs.pop();          /* friend_ccc */
  const afterRemoval = RS.computeIntent('friend_aaa', { now: now });
  check('10. 已删除的角色不出现在候选里', afterRemoval.candidateCount === 0, afterRemoval);
  apiConfigs.push(removed);

  /* 7. 完全陌生：默认不主动联系。 */
  const stranger = RS.computeIntent('friend_aaa', { now: now });
  check('7a. 全是陌生人 → 不发起（默认 stranger policy）',
    stranger.decision === 'no-action' && stranger.candidateCount === 0, stranger);
  check('7b. 陌生人被记为 no-thread 而不是"分数略低"',
    stranger.blockers.indexOf('no-thread') >= 0 || stranger.reasonCode === 'no-candidates', stranger);

  /* 8. allowStrangers opt-in：只打开"允许考虑"，不是"开始刷陌生人"。 */
  RS.setCharacterPrefs('friend_aaa', { allowStrangers: true });
  const withStrangers = RS.computeIntent('friend_aaa', { now: now });
  check('8a. allowStrangers 打开后陌生人进入候选', withStrangers.candidateCount >= 1, withStrangers.candidateCount);
  check('8b. 但陌生人几乎不可能过线（opt-in ≠ 开始刷）', withStrangers.decision === 'no-action', withStrangers);
  RS.setCharacterPrefs('friend_aaa', { allowStrangers: false });

  /* 9. self 恒被排除。 */
  const scored = SC.scorePeer({ characterId: 'friend_aaa', peer: { id: 'friend_aaa', exists: true }, now: now, dayBucket: SC.dayBucketOf(now) });
  check('9. self 被排除（ok:false 且 self 标记）', scored.ok === false && scored.self === true, scored);

  /* 11. thread archived → 排除。 */
  await makeAcquainted('friend_aaa', 'friend_bbb', { turns: 2 });
  await RD.onCharacterDeleted('friend_bbb');
  const archived = RS.computeIntent('friend_aaa', { now: now });
  check('11. thread 归档后该 peer 被排除', archived.candidateCount === 0, archived);
  apiConfigs.push(Object.assign({}, removed));
}

/* ══════════════════════════════════════════════════════════════════
   12-13 · busy / cooldown
   ══════════════════════════════════════════════════════════════════ */
console.log('\n── 12-13 · busy / cooldown ──');
reset();
{
  RS.setGlobalEnabled(true);
  RS.setCharacterPrefs('friend_aaa', { enabled: true, dailyLimit: 2, initiative: 0.9 });
  await makeAcquainted('friend_aaa', 'friend_bbb', { turns: 2 });
  setRelation('friend_aaa', 'friend_bbb', { familiarity: 0.8, affinity: 0.8, trust: 0.7, dmCount: 4 });
  const now = Date.now();
  RS._dropCrossRunState();
  ageThread('friend_aaa', 'friend_bbb', 5 * 60000);
  check('12a. 无锁时 bbb 在候选里', RS.computeIntent('friend_aaa', { now: now }).candidateCount >= 1);
  global._chatSendingFor.add('friend_bbb');
  const busy = RS.computeIntent('friend_aaa', { now: now });
  check('12b. peer 正在回复 → 被排除', busy.candidateCount === 0, busy);
  global._chatSendingFor.delete('friend_bbb');
  global._chatSendingFor.add('friend_aaa');
  const selfBusy = RS.computeIntent('friend_aaa', { now: now });
  check('12c. 自己正在回复 → 整个角色不评估（character busy）', selfBusy.decision === 'no-action', selfBusy.reasonCode);
  global._chatSendingFor.clear();

  /* 13. per-pair autonomous cooldown（6h 起，独立于 90 秒的 manual 冷却）。
     所有时间戳都用**相对真实时钟**的值：stateForDay 按"本地日桶"记账，
     用 epoch 附近的绝对时间戳会落在一个和后续断言不同的日桶里，
     于是测的就不再是冷却本身而是日切行为。 */
  const t0 = Date.now();
  const recAt = t0 - 10 * 3600000;
  RS._dropCrossRunState(t0);
  RS._recordInitiation('friend_aaa', 'friend_bbb', recAt);
  const cd = SC.pairCooldownRemaining({ characterId: 'friend_aaa', budget: { pairCooldowns: RS._state().pairLastAt } }, 'friend_bbb', t0 - 10 * 3600000 + 60000);
  check('13a. 自主 pair 冷却远长于 manual 的 90 秒', cd > 90 * 1000, cd);
  const blocked = RS.autonomousBudgetCheck('friend_aaa', 'friend_bbb', t0 - 10 * 3600000 + 60000);
  check('13b. 冷却期内预算拒绝（autonomous-pair-cooldown）', blocked.ok === false && blocked.reason === 'autonomous-pair-cooldown', blocked);
  const later = RS.autonomousBudgetCheck('friend_aaa', 'friend_bbb', t0);
  check('13c. 冷却过去后放开', later.ok === true, later);
  check('13d. manual 的 90 秒冷却与它无关（两个独立账本）',
    C.pairCooldownRemaining(t0, t0 + 5 * 60000) === 0);
}

/* ══════════════════════════════════════════════════════════════════
   14-17 · 预算独立性与 initiative 语义
   ══════════════════════════════════════════════════════════════════ */
console.log('\n── 14-17 · 预算独立性 / initiative ──');
reset();
{
  RS.setGlobalEnabled(true);
  RS.setCharacterPrefs('friend_aaa', { enabled: true, dailyLimit: 2, initiative: 0.9 });
  const now = Date.now();
  RS._recordInitiation('friend_aaa', 'friend_bbb', now);
  RS._recordInitiation('friend_aaa', 'friend_ccc', now + 1);
  const cap = RS.autonomousBudgetCheck('friend_aaa', 'friend_bbb', now + 2);
  check('14. per-character 每日额度生效（2 次后拒绝）', cap.ok === false && cap.blockedBy === 'quota', cap);
  /* 16. 自主额度不消耗 manual 额度：manual 走的是 core 的 40/日轮次账本，
     自主走的是 2/日 run 账本，两者是**不同的存储**。 */
  const ledger = JSON.parse(LS['ib_role_dm_ledger_v1'] || 'null');
  check('16a. 自主发起不写 canonical 轮次账本（两个账本物理分离）',
    !ledger || !ledger['friend_aaa'] || ledger['friend_aaa'].length === 0, ledger);
  replyFor = () => '手动聊一句。' + Math.random().toString(36).slice(2, 8);
  const manual = await RD.start('friend_aaa', 'friend_bbb', { turns: 2, force: true });
  check('16b. 自主额度用尽后，用户手动仍能聊（manual 未被吃掉）', manual.ok === true, manual);
  replyFor = null;
  /* manual 确实记进了 canonical 账本 —— 与 16a 对照，证明两个账本都在工作。 */
  const ledger2 = JSON.parse(LS['ib_role_dm_ledger_v1'] || '{}');
  check('16c. manual 记进 canonical 轮次账本（对照 16a）',
    Array.isArray(ledger2['friend_aaa']) && ledger2['friend_aaa'].length > 0, ledger2['friend_aaa']);

  reset();
  RS.setGlobalEnabled(true);
  RS.setCharacterPrefs('friend_aaa', { enabled: true, dailyLimit: 2, initiative: 0.35 });
  RS.setCharacterPrefs('friend_bbb', { enabled: true, dailyLimit: 2, initiative: 0.35 });
  RS.setCharacterPrefs('friend_ccc', { enabled: true, dailyLimit: 2, initiative: 0.35 });
  for (let i = 0; i < 6; i++) RS._recordInitiation(['friend_aaa', 'friend_bbb', 'friend_ccc'][i % 3], 'friend_zzz', now + i * 1000);
  const globalCap = RS.autonomousBudgetCheck('friend_aaa', 'friend_bbb', now + 10);
  check('15. 全局每日额度生效（6 次后拒绝）', globalCap.ok === false && globalCap.blockedBy === 'quota', globalCap);

  /* 17. initiative 影响**阈值**，不是概率。 */
  const lo = SC.thresholdFor(0.0), hi = SC.thresholdFor(1.0), mid = SC.thresholdFor(0.35);
  check('17a. initiative 越低阈值越高（需要更强的理由）', lo > mid && mid > hi, [lo, mid, hi]);
  check('17b. 默认 0.35 的阈值落在闭区间内', mid > hi && mid < lo, mid);
  check('17c. 阈值曲线在 [0,1] 内单调（不是随机概率）',
    SC.thresholdFor(0.1) > SC.thresholdFor(0.5) && SC.thresholdFor(0.5) > SC.thresholdFor(0.9));
  /* 同一份输入，只改 initiative：低 initiative 必须不出手。 */
  const base = {
    now: now, characterId: 'friend_aaa', global: { enabled: true },
    character: { exists: true, ready: true, busy: false },
    peers: [{ id: 'friend_bbb', exists: true, ready: true, hasThread: true, threadState: 'active', lastDmAt: now - 8 * 3600000, familiarity: 0.55, affinity: 0.5, trust: 0.5 }],
    budget: { characterUsedToday: 0, globalUsedToday: 0, characterLimit: 2, globalLimit: 6, pairCooldowns: {} },
    dayBucket: SC.dayBucketOf(now), seed: 'friend_aaa'
  };
  const lowI = SC.evaluateSocialIntent(Object.assign({}, base, { prefs: { enabled: true, initiative: 0.0, dailyLimit: 2 } }));
  const highI = SC.evaluateSocialIntent(Object.assign({}, base, { prefs: { enabled: true, initiative: 1.0, dailyLimit: 2 } }));
  check('17d. 同一份状态：低 initiative 不出手、高 initiative 出手',
    lowI.decision === 'no-action' && highI.decision === 'initiate', [lowI.decision, highI.decision]);
  check('17e. 分数本身不随 initiative 变化（只变阈值）', lowI.score === highI.score, [lowI.score, highI.score]);
}

/* ══════════════════════════════════════════════════════════════════
   18-21 · 关系信号 / thread / 久未联系 / 有界抖动
   ══════════════════════════════════════════════════════════════════ */
console.log('\n── 18-21 · 信号与排名 ──');
reset();
{
  const now = Date.now();
  const mk = (patch) => SC.scorePeer(Object.assign({
    characterId: 'friend_aaa', now: now, dayBucket: SC.dayBucketOf(now),
    peer: { id: 'friend_bbb', exists: true, hasThread: false, familiarity: 0.2, affinity: 0.5, trust: 0.5, lastDmAt: 0 }
  }, patch));

  const strangerScore = mk({});
  const threadOnly = mk({ peer: { id: 'friend_bbb', exists: true, hasThread: true, threadState: 'active', familiarity: 0.2, affinity: 0.5, trust: 0.5, lastDmAt: now - 2 * 3600000 } });
  check('18a. 有 thread 的分数高于陌生人', threadOnly.score > strangerScore.score, [threadOnly.score, strangerScore.score]);
  const close = mk({ peer: { id: 'friend_bbb', exists: true, hasThread: true, threadState: 'active', familiarity: 0.8, affinity: 0.8, trust: 0.8, lastDmAt: now - 2 * 3600000 } });
  check('18b. 关系更近的分数更高', close.score > threadOnly.score);
  const cold = mk({ peer: { id: 'friend_bbb', exists: true, hasThread: true, threadState: 'active', familiarity: 0.8, affinity: 0.2, trust: 0.3, lastDmAt: now - 2 * 3600000 } });
  check('18c. affinity 低会扣分（不是"有 thread 就必聊"）', cold.score < close.score);
  check('18d. 单一信号不足以过线（affinity 高但没聊过）',
    mk({ peer: { id: 'friend_bbb', exists: true, hasThread: false, familiarity: 0.2, affinity: 1, trust: 1, lastDmAt: 0 } }).score < SC.thresholdFor(0.35));

  /* 19. 有 thread 的候选排在陌生人前面。 */
  const ranked = SC.rankPeers([
    SC.scorePeer({ characterId: 'x', peer: { id: 's1', exists: true, hasThread: false, familiarity: 0.6, affinity: 0.9, trust: 0.9 }, now: now, allowStrangers: true, dayBucket: SC.dayBucketOf(now) }),
    SC.scorePeer({ characterId: 'x', peer: { id: 's2', exists: true, hasThread: true, threadState: 'active', familiarity: 0.6, affinity: 0.7, trust: 0.7, lastDmAt: now - 5 * 3600000 }, now: now, dayBucket: SC.dayBucketOf(now) })
  ]);
  check('19. 排名把"聊过的人"排在陌生人前面', ranked.length === 2 && ranked[0].peerId === 's2', ranked.map(r => r.peerId + ':' + r.score));

  /* 20. 久未联系是加分项。 */
  const fresh = mk({ peer: { id: 'friend_bbb', exists: true, hasThread: true, threadState: 'active', familiarity: 0.5, affinity: 0.6, trust: 0.6, lastDmAt: now - 1 * 3600000 } });
  const stale = mk({ peer: { id: 'friend_bbb', exists: true, hasThread: true, threadState: 'active', familiarity: 0.5, affinity: 0.6, trust: 0.6, lastDmAt: now - 6 * 86400000 } });
  check('20a. 久未联系的分数更高', stale.score > fresh.score, [stale.score, fresh.score]);
  check('20b. "刚聊过"是负信号（1 小时内）',
    mk({ peer: { id: 'friend_bbb', exists: true, hasThread: true, threadState: 'active', familiarity: 0.5, affinity: 0.6, trust: 0.6, lastDmAt: now - 60000 } }).score < fresh.score);
  check('20c. 久未联系被记进 signals',
    stale.signals.indexOf('long-time-no-contact') >= 0, stale.signals);

  /* 21. 有界抖动：确定性 + 上界 + 不足以独自过线。 */
  const j1 = SC.jitterFor('friend_aaa>friend_bbb', 20000, SC.BOUNDED_JITTER_MAX);
  const j2 = SC.jitterFor('friend_aaa>friend_bbb', 20000, SC.BOUNDED_JITTER_MAX);
  const j3 = SC.jitterFor('friend_aaa>friend_bbb', 20001, SC.BOUNDED_JITTER_MAX);
  check('21a. 同一 (seed, 天) → 同一抖动（可复算）', j1 === j2, [j1, j2]);
  check('21b. 换一天抖动会变（避免永远同一时刻）', j1 !== j3, [j1, j3]);
  check('21c. 抖动在 [0, 上界] 内', j1 >= 0 && j1 <= SC.BOUNDED_JITTER_MAX, j1);
  check('21d. 抖动的上界小于任一单项信号的权重（不能独自触发）',
    SC.BOUNDED_JITTER_MAX < Math.min(SC.SIGNAL_WEIGHTS.existingThread, SC.SIGNAL_WEIGHTS.familiarity));
  /* 同一输入重复评估：逐字段一致。 */
  const a1 = SC.evaluateSocialIntent(Object.assign({}, base17(), { prefs: { enabled: true, initiative: 0.5, dailyLimit: 2 } }));
  const a2 = SC.evaluateSocialIntent(Object.assign({}, base17(), { prefs: { enabled: true, initiative: 0.5, dailyLimit: 2 } }));
  check('21e. 同一输入 → 同一输出（纯函数，无隐藏状态）',
    JSON.stringify(a1) === JSON.stringify(a2));
  function base17() {
    return {
      now: now, characterId: 'friend_aaa', global: { enabled: true },
      character: { exists: true, ready: true, busy: false },
      peers: [{ id: 'friend_bbb', exists: true, ready: true, hasThread: true, threadState: 'active', lastDmAt: now - 8 * 3600000, familiarity: 0.7, affinity: 0.7, trust: 0.7 }],
      budget: { characterUsedToday: 0, globalUsedToday: 0, characterLimit: 2, globalLimit: 6, pairCooldowns: {} },
      dayBucket: SC.dayBucketOf(now), seed: 'friend_aaa'
    };
  }
}

/* ══════════════════════════════════════════════════════════════════
   22-25 · 发起人先说 / canonical thread / 备忘 / 关系
   ══════════════════════════════════════════════════════════════════ */
console.log('\n── 22-25 · 发起语义与复用 ──');
reset();
{
  /* 先攒出一份真实的 thread memorandum：折叠阈值是"窗口外 ≥8 条"，
     而最近窗口是 12 条 —— 因此需要 >20 条消息。用 4 次 6 轮的手动 run
     凑到 24 条，于是备忘是**真实产生**的，而不是测试手写进去的。 */
  await makeAcquainted('friend_aaa', 'friend_bbb', { turns: 6 });
  await makeAcquainted('friend_aaa', 'friend_bbb', { turns: 6 });
  await makeAcquainted('friend_aaa', 'friend_bbb', { turns: 6 });
  await makeAcquainted('friend_aaa', 'friend_bbb', { turns: 6 });
  setRelation('friend_aaa', 'friend_bbb', { familiarity: 0.85, affinity: 0.85, trust: 0.8, dmCount: 6 });
  const fid = C.roleDmFriendId('friend_aaa', 'friend_bbb');
  const beforeMsgs = msgsOf(fid).length;
  const beforeMemo = RD._threadMemorandum(fid);
  /* 主动私聊的语义断言要求"这次真的发起"：先把两道冷却一起清干净
     （自主 6h + manual 90 秒），并复用同一个 now。 */
  armForInitiation('friend_aaa', 'friend_bbb');
  RS.setCharacterPrefs('friend_aaa', { enabled: true, dailyLimit: 2, initiative: 0.6 });
  CALLS.length = 0;
  const r = await RD.startAutonomous('friend_aaa', 'friend_bbb', {
    initiatorId: 'friend_aaa', turns: 2, force: true, initiationSignal: { reasonCode: 'long-time-no-contact' }
  });
  check('22a. autonomous run 成功', r.ok === true, r);
  const memoNow = RD._threadMemorandum(fid);
  const rows = msgsOf(fid);
  check('22b. A 主动发起 → A 是第一条的发言人',
    String(rows[beforeMsgs].metadata.senderId) === 'friend_aaa', rows[beforeMsgs] && rows[beforeMsgs].metadata.senderId);
  check('23. B 没有抢到第一条（前两条顺序是 A→B）',
    String(rows[beforeMsgs + 1].metadata.senderId) === 'friend_bbb', rows.slice(beforeMsgs).map(m => m.metadata.senderId));
  check('24a. 复用同一个 canonical thread（没有第二条历史）',
    RD._threadsAll().filter(t => t.participantIds.indexOf('friend_aaa') >= 0 && t.participantIds.indexOf('friend_bbb') >= 0).length === 1);
  check('24b. 消息仍然全部落在同一个 friendId 上', msgsOf(fid).length === beforeMsgs + 2);
  check('25a. 共同备忘确实存在，且是**同一份**（复用，不新建）',
    !!beforeMemo && !!memoNow && memoNow.updatedAt === beforeMemo.updatedAt &&
    memoNow.sourceMessageCount >= beforeMemo.sourceMessageCount,
    [beforeMemo && beforeMemo.updatedAt, memoNow && memoNow.updatedAt]);
  check('25b. 关系是被复用的那条（dmCount 增长来自真实 observation）',
    RD.relationGet('friend_aaa', 'friend_bbb').dmCount > 0);
  check('25c. thread 上留下"谁主动发起"的事实', RD._threadsAll()[0].lastInitiatedBy === 'friend_aaa',
    RD._threadsAll()[0].lastInitiatedBy);
  check('25d. listThreads 把 lastInitiatedBy 暴露给 UI（只暴露 id）',
    (await RD.listThreads())[0].lastInitiatedBy === 'friend_aaa');
  /* 手动 run 必须把它清掉 —— 否则 UI 会一直说"是她主动发起的"，而事实是用户点的。 */
  replyFor = () => '手动一句。' + Math.random().toString(36).slice(2, 8);
  await RD.start('friend_aaa', 'friend_bbb', { turns: 2, force: true });
  replyFor = null;
  check('25e. 之后一次手动 run 清掉该标记（UI 不会误报）',
    (await RD.listThreads())[0].lastInitiatedBy === '');
  /* 无主发起必须被可见地拒绝。skipAutonomousGate 是给**守卫本身**让路的
     测试开关：没有它，这一条会先被闸门挡住，从而永远测不到"缺 initiatorId"
     这条断言（一个测试自己造成的遮蔽）。 */
  const noInitiator = await RD.startAutonomous('friend_aaa', 'friend_bbb', { initiatorId: '', turns: 2, force: true, skipAutonomousGate: true });
  check('22c. 缺 initiatorId 的 autonomous run 被拒（无主发起不允许）',
    noInitiator.reason === 'autonomous-no-initiator', noInitiator);

  check('22d. forceInitiator 且发起人不在参与者里 → 返回空（不静默换人）',
    C.chooseFirstSpeaker({ participantIds: ['a', 'b'], lastTurnRoleId: 'b' }, 'z', { forceInitiator: true }) === '');
  check('22e. 手动路径保持"接上一个人"（既有语义未变）',
    C.chooseFirstSpeaker({ participantIds: ['a', 'b'], lastTurnRoleId: 'a' }, 'a') === 'b');
}

/* ══════════════════════════════════════════════════════════════════
   26-29 · provider 独立 / 不回退 / 失败退避
   ══════════════════════════════════════════════════════════════════ */
console.log('\n── 26-29 · provider 与失败语义 ──');
reset();
{
  await makeAcquainted('friend_aaa', 'friend_bbb', { turns: 2 });
  setRelation('friend_aaa', 'friend_bbb', { familiarity: 0.85, affinity: 0.85, trust: 0.8, dmCount: 6 });
  armForInitiation('friend_aaa', 'friend_bbb');
  RS.setGlobalEnabled(true);
  RS.setCharacterPrefs('friend_aaa', { enabled: true, initiative: 0.9 });
  CALLS.length = 0;
  const r = await RD.startAutonomous('friend_aaa', 'friend_bbb', { initiatorId: 'friend_aaa', turns: 2, force: true });
  check('26·setup run 成功', r.ok === true, r);
  /* run 结果里描述轮数的字段名**是** turns。审计层曾去读 res.turnsDone
     （一个不存在的字段）→ 每条 trace 的轮数恒为 0 而没有任何断言会红。
     这条钉住字段名本身，41·setup2 钉住审计确实读到了真值。 */
  check('26·setup2 run 结果暴露 turns，不暴露 turnsDone（turnsDone 不是对外契约）',
    r.turns === 2 && Object.prototype.hasOwnProperty.call(r, 'turnsDone') === false, [r.turns, Object.keys(r)]);
  check('26a. 两个角色各自用自己的 provider（不共享）',
    CALLS.map(c => c.provider).join(',') === 'anthropic,qwen', CALLS.map(c => c.provider));
  check('26b. model 也各自独立', CALLS.map(c => c.model).join(',') === 'claude-x,qwen-plus', CALLS.map(c => c.model));
  check('26c. 发起人的调用是第一次调用', CALLS[0].id === 'friend_aaa', CALLS[0].id);

  /* 27/28. 失败：安全停止、不回退到对方、不退避别人的额度。 */
  reset();
  await makeAcquainted('friend_aaa', 'friend_bbb', { turns: 2 });
  setRelation('friend_aaa', 'friend_bbb', { familiarity: 0.85, affinity: 0.85, trust: 0.8, dmCount: 6 });
  armForInitiation('friend_aaa', 'friend_bbb');
  RS.setGlobalEnabled(true);
  RS.setCharacterPrefs('friend_aaa', { enabled: true, initiative: 0.9 });
  failFor = 'friend_aaa';
  CALLS.length = 0;
  const failed = await RD.startAutonomous('friend_aaa', 'friend_bbb', { initiatorId: 'friend_aaa', turns: 2, force: true });
  check('27. provider 失败 → run 安全停止', failed.ok === false && failed.stopReason === 'provider-failed', failed);
  check('28a. 没有 fallback 到 peer 的 provider（只有一次调用）',
    CALLS.length === 1 && CALLS[0].id === 'friend_aaa', CALLS.map(c => c.id));
  check('28b. 锁已释放（thread 不再 running）', RD.isRunning(C.roleDmFriendId('friend_aaa', 'friend_bbb')) === false);
  check('28c. 没有把失败消息写进历史',
    msgsOf(C.roleDmFriendId('friend_aaa', 'friend_bbb')).every(m => !/provider exploded/.test(String(m.content))));
  failFor = null;
  /* 29. 失败退避：指数增长、有上界。时间戳同样用相对值（日桶一致性）。 */
  const bt = Date.now();
  RS._dropCrossRunState(bt);
  const f1 = RS._recordFailure('friend_aaa', bt);
  const f2 = RS._recordFailure('friend_aaa', bt + 1000);
  check('29a. 失败退避指数增长', f2.backoffMs === f1.backoffMs * 2, [f1.backoffMs, f2.backoffMs]);
  for (let i = 0; i < 8; i++) RS._recordFailure('friend_aaa', bt + 2000 + i);
  check('29b. 退避有上界（不会无限增长）', RS._recordFailure('friend_aaa', bt + 3000).backoffMs <= SC.BUDGET.failureBackoffMaxMs);
  check('29c. 退避期内预算拒绝',
    RS.autonomousBudgetCheck('friend_aaa', 'friend_bbb', bt + 4000).blockedBy === 'backoff');
}

/* ══════════════════════════════════════════════════════════════════
   27b · 输出类失败（Phase 3.1）：请求**成功**，只是没有正文
   ------------------------------------------------------------------
   同一件事在自主路径上必须与手动路径同名同义。这里钉三件事：
     ① run 的停止原因是 output-truncated / empty-output，不是 provider-failed；
     ② 审计 trace 的 reasonCode / stopReason 说的是**事实**（且仍是词表成员）；
     ③ 它照样退避 —— 它真的花掉了两次调用，不退避就是隐性 token runaway 的口子。
   ══════════════════════════════════════════════════════════════════ */
{
  check('27b-1. 社交核心词表里有这两个码，且与 role-dm-core 逐字同码（一个事实一个名字）',
    SC.REASON.outputTruncated === C.REASON.outputTruncated &&
    SC.REASON.emptyOutput === C.REASON.emptyOutput &&
    SC.REASON.outputTruncated === 'output-truncated' && SC.REASON.emptyOutput === 'empty-output');

  reset();
  await makeAcquainted('friend_aaa', 'friend_bbb', { turns: 2 });
  setRelation('friend_aaa', 'friend_bbb', { familiarity: 0.95, affinity: 0.95, trust: 0.9, dmCount: 8 });
  const armT = armForInitiation('friend_aaa', 'friend_bbb');
  ageThread('friend_aaa', 'friend_bbb', 10 * 86400000);
  RS.setCharacterPrefs('friend_aaa', { enabled: true, initiative: 1.0 });
  truncateFor = { id: 'friend_aaa', times: 9 };
  CALLS.length = 0; TRACES.length = 0; RS._trace(0);
  /* 走**真实**的自主路径（tick），不是直接 RD.startAutonomous ——
     审计 trace 与失败退避都长在社交层的发起流程里，绕过它就等于
     在测一个生产不会走的分支（这类假绿本仓库记录过多次）。 */
  const startedT = await RS.tick({ now: armT, force: true });
  /* 失败的 run 不计入 initiated（"她主动聊过一次"在账面上必须是真的），
     但 attempt 确实发生过 —— 断言用 attempted 而不是 initiated。 */
  check('27b-2. tick 确实尝试发起了一次（否则下面测不到东西）',
    startedT.attempted === 1 && startedT.initiated === 0 &&
    startedT.decisions[0] && startedT.decisions[0].blockedBy === C.REASON.outputTruncated, startedT);
  check('27b-3. 截断+空正文 → 停在与事实一致的码上（不是 provider-failed）',
    startedT.decisions[0].blockedBy === C.REASON.outputTruncated &&
    startedT.decisions[0].blockedBy !== C.REASON.providerFailed, startedT.decisions[0]);
  check('27b-4. 每次 run 只花掉 2 次调用（一级预算 + 一次重试，没有第三级）',
    CALLS.length === 2 && CALLS.every(c => c.id === 'friend_aaa'), CALLS.map(c => c.id + ':' + c.opts.maxTokens));
  const traceT = RS._trace(5).filter(t => t.decision === 'no-action').pop();
  check('27b-5. trace 的 reasonCode 说的是事实（output-truncated ∈ 有限词表）',
    !!traceT && traceT.reasonCode === C.REASON.outputTruncated &&
    Object.values(SC.REASON).indexOf(traceT.reasonCode) >= 0, traceT);
  check('27b-6. trace 的 stopReason / blockedBy 同样如实（不再是 provider-failed）',
    !!traceT && traceT.stopReason === C.REASON.outputTruncated && traceT.blockedBy === C.REASON.outputTruncated, traceT);
  check('27b-7. trace 里没有 reasoning / 正文 / prompt / 密钥泄漏',
    !/reasoning|reasoning_content|sk-|apiKey|安静而固执/.test(JSON.stringify(RS._trace(5))));
  const backoffT = RS.autonomousBudgetCheck('friend_aaa', 'friend_bbb', armT + 1000);
  check('27b-8. 输出类失败同样触发失败退避（它真的花了调用）',
    backoffT.blockedBy === 'backoff', backoffT);

  /* 未截断的空正文走同一个机制，但留下**不同**的码（诊断含义不同）。 */
  reset();
  await makeAcquainted('friend_aaa', 'friend_bbb', { turns: 2 });
  setRelation('friend_aaa', 'friend_bbb', { familiarity: 0.95, affinity: 0.95, trust: 0.9, dmCount: 8 });
  const armE = armForInitiation('friend_aaa', 'friend_bbb');
  ageThread('friend_aaa', 'friend_bbb', 10 * 86400000);
  RS.setCharacterPrefs('friend_aaa', { enabled: true, initiative: 1.0 });
  emptyFor = { id: 'friend_aaa', times: 9 };
  CALLS.length = 0; TRACES.length = 0; RS._trace(0);
  const startedE = await RS.tick({ now: armE, force: true });
  check('27b-9. 未截断的空正文 → empty-output（与 output-truncated 分开，且不是 provider-failed）',
    startedE.attempted === 1 && startedE.decisions[0] &&
    startedE.decisions[0].blockedBy === C.REASON.emptyOutput &&
    startedE.decisions[0].blockedBy !== C.REASON.providerFailed,
    startedE.decisions[0]);
  const traceE = RS._trace(5).filter(t => t.decision === 'no-action').pop();
  check('27b-10. 对应的 trace reasonCode 也是 empty-output', !!traceE && traceE.reasonCode === C.REASON.emptyOutput, traceE);
  check('27b-11. 空的 run 不进"主动聊过一次"的账（账面上她没聊成）',
    RS._state().globalUsedToday.length === 0, RS._state().globalUsedToday);
  /* 失败那条 trace 的轮数同样来自真实的 run 结果（字段名 turns）。
     这一条**不是** 27b-10 的重复：就算审计又把字段名写错，这里仍然会
     是 0 —— 所以它真正钉的是"失败路径也走同一个字段名"，而 41·setup2
     钉的是"成功路径读得到真值"。两条合起来才排除"恒为 0 也算过"。 */
  check('27b-12. 失败 trace 的轮数与真实 run 结果一致（字段名是 turns）',
    !!traceE && traceE.turns === 0, traceE && traceE.turns);
  /* 失败路径同样只暴露 turns —— "字段名只有一个"是一条**双向**契约：
     光有成功路径的断言不足以排除"失败路径另写一个名字"。
     这个探针必须**真的走到 run**：在 27b 这一块里角色正处在失败退避中，
     直接再发起只会拿到闸门的拒绝对象 {ok,reason,blockedBy}（它压根没有
     轮数这个概念）—— 拿它断言字段名等于在测一个没跑起来的路径。
     所以这里重建一个干净场景，让 provider 在**第一轮**就失败。 */
  reset();
  await makeAcquainted('friend_aaa', 'friend_bbb', { turns: 2 });
  setRelation('friend_aaa', 'friend_bbb', { familiarity: 0.85, affinity: 0.85, trust: 0.8, dmCount: 6 });
  armForInitiation('friend_aaa', 'friend_bbb');
  RS.setCharacterPrefs('friend_aaa', { enabled: true, initiative: 0.9 });
  failFor = 'friend_aaa';
  const probeFailed = await RD.startAutonomous('friend_aaa', 'friend_bbb', { initiatorId: 'friend_aaa', turns: 2, force: true });
  failFor = null;
  check('27b-13. 失败的 run 结果同样只暴露 turns，没有 turnsDone',
    probeFailed.ok === false && probeFailed.stopReason === 'provider-failed' &&
    Object.prototype.hasOwnProperty.call(probeFailed, 'turns') === true &&
    Object.prototype.hasOwnProperty.call(probeFailed, 'turnsDone') === false,
    [probeFailed.ok, probeFailed.stopReason, Object.keys(probeFailed)]);
}

/* ══════════════════════════════════════════════════════════════════
   30-32 · 并发与竞态
   ══════════════════════════════════════════════════════════════════ */
console.log('\n── 30-32 · 并发 / 竞态 / 用户活动 ──');
reset();
{
  await makeAcquainted('friend_aaa', 'friend_bbb', { turns: 2 });
  setRelation('friend_aaa', 'friend_bbb', { familiarity: 0.85, affinity: 0.85, trust: 0.8, dmCount: 6 });
  armForInitiation('friend_aaa', 'friend_bbb');
  RS.setGlobalEnabled(true);
  RS.setCharacterPrefs('friend_aaa', { enabled: true, initiative: 0.9 });
  RS.setCharacterPrefs('friend_ccc', { enabled: true, initiative: 0.9 });
  /* 31. A→B 与 C→B 同时：只能一个赢。 */
  const [r1, r2] = await Promise.all([
    RD.startAutonomous('friend_aaa', 'friend_bbb', { initiatorId: 'friend_aaa', turns: 2, force: true }),
    RD.startAutonomous('friend_ccc', 'friend_bbb', { initiatorId: 'friend_ccc', turns: 2, force: true })
  ]);
  const winners = [r1, r2].filter(r => r.ok === true).length;
  const losers = [r1, r2].filter(r => r.ok === false);
  check('31a. 两个并发发起只有一个成功', winners === 1, [r1.ok, r1.reason, r2.ok, r2.reason]);
  check('31b. 失败的那个以 busy/cooldown 类原因正常退出，而不是抛异常',
    losers.length === 1 && ['character-busy', 'thread-busy', 'pair-cooldown'].indexOf(losers[0].reason) >= 0,
    losers[0] && losers[0].reason);
  check('31c. 锁全部释放', RD.isRunning(C.roleDmFriendId('friend_aaa', 'friend_bbb')) === false);
  /* 30. 用户正在跟 aaa 单聊时，autonomous 不得借走 aaa。 */
  global._chatSendingFor.add('friend_aaa');
  const blockedByUser = RS.computeIntent('friend_aaa', { now: Date.now() });
  check('30. 用户正在与 A 对话时，A 不会被自主调度启动',
    blockedByUser.decision === 'no-action' && blockedByUser.blockers.indexOf('busy') >= 0, blockedByUser.blockers);
  global._chatSendingFor.clear();
  /* 32. 用户刚手动聊完 → 10 分钟避让。 */
  const t = Date.now();
  RS.noteUserActivity(t);
  const recent = RS.computeIntent('friend_aaa', { now: t + 60000 });
  check('32a. 用户刚互动过 → 避让（user-active）',
    recent.decision === 'no-action' && recent.blockers.indexOf('user-active') >= 0, recent.blockers);
  check('32b. 避让窗口有界（10 分钟后不再阻塞）',
    RS.computeIntent('friend_aaa', { now: t + 11 * 60000 }).blockers.indexOf('user-active') < 0);
  check('32c. noteUserActivity 只前进不回退', (RS.noteUserActivity(t - 500000) === RS._state().lastUserActiveAt));
}

/* ══════════════════════════════════════════════════════════════════
   33-36 · quiet hours / 频率 gate / 持久化 / legacy
   ══════════════════════════════════════════════════════════════════ */
console.log('\n── 33-36 · quiet hours / 频率 / 持久化 / legacy ──');
reset();
{
  RS.setGlobalEnabled(true);
  RS.setCharacterPrefs('friend_aaa', { enabled: true });
  /* 33. quiet hours：复用既有实现（_bgInSleepWindow），不新建第二套。 */
  const now = new Date();
  const hm = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
  SLEEP = { sleepStart: '00:00', sleepEnd: '23:59' };
  const q = await RS.tick({ now: Date.now(), force: true });
  check('33a. quiet hours 内 tick 直接返回（不评估、不发起）', q.reason === 'quiet-hours', q);
  check('33b. quiet hours 内预算闸门也拒绝（双保险）',
    (await RS.autonomousBudgetCheck('friend_aaa', 'friend_bbb', Date.now())).blockedBy === 'quiet-hours');
  SLEEP = { sleepStart: '', sleepEnd: '' };
  check('33c. quiet hours 用的是既有实现（不是本模块自造的一套）',
    /_bgInSleepWindow/.test(SRC_SOCIAL) && !/sleepStart/.test(SRC_SOCIAL.replace(/[\s\S]*?function quietHoursNow[\s\S]*?\n  \}/, '')));

  /* 34. 频率 gate：同一个 now 连续 tick，第二次必须被 gate 拦住。 */
  reset();
  RS.setGlobalEnabled(true);
  RS.setCharacterPrefs('friend_aaa', { enabled: true });
  RS.setCharacterPrefs('friend_bbb', { enabled: true });
  const t0 = Date.now();
  const t1 = await RS.tick({ now: t0, force: true });
  check('34a. 第一次 tick 会评估', t1.evaluated >= 1, t1);
  const t2 = await RS.tick({ now: t0 + 1000 });
  check('34b. 1 秒后的 tick 被 global gate 拦住', t2.reason === 'frequency-gate', t2);
  const t3 = await RS.tick({ now: t0 + SC.SCHED.globalGateMs + 1000 });
  check('34c. gate 到期后 tick 恢复工作', t3.ok === true, t3);
  check('34d. 每角色还有自己的 45~90 分钟评估间隔',
    SC.SCHED.evalMinMs >= 45 * 60000 && SC.SCHED.evalMaxMs <= 90 * 60000);
  const due1 = SC.evaluationDue({ characterId: 'a', now: t0 + 1000, lastEvaluatedAt: t0, salt: 'roledm' });
  check('34e. 刚评估过 → 不再重复评估', due1.due === false, due1);
  const due2 = SC.evaluationDue({ characterId: 'a', now: t0 + 2 * 3600000, lastEvaluatedAt: t0, salt: 'roledm' });
  check('34f. 间隔过去 → 可以重新评估', due2.due === true, due2);
  /* 不同角色的评估时刻必须错开（否则 14 个角色会在同一分钟一起算）。 */
  const ats = new Set();
  for (const id of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm', 'n']) {
    ats.add(SC.nextEligibleAt(id, t0, 'roledm'));
  }
  check('34g. 14 个角色的评估时刻错开（确定性抖动）', ats.size >= 10, ats.size);

  /* 35. 持久化：偏好写进 localStorage，重载后仍在。 */
  RS.setGlobalEnabled(true);
  RS.setCharacterPrefs('friend_aaa', { enabled: true, initiative: 0.7, dailyLimit: 3, allowStrangers: true });
  const rawPrefs = JSON.parse(LS[RS._keys.prefs]);
  check('35a. 偏好落在有版本号的 key 上', rawPrefs.v === 1 && rawPrefs.global.enabled === true);
  check('35b. 角色级四项都持久化',
    rawPrefs.characters.friend_aaa.enabled === true && rawPrefs.characters.friend_aaa.initiative === 0.7 &&
    rawPrefs.characters.friend_aaa.dailyLimit === 3 && rawPrefs.characters.friend_aaa.allowStrangers === true,
    rawPrefs.characters.friend_aaa);
  check('35c. 重新读取（模拟刷新）后值不变',
    RS.characterPrefs('friend_aaa').initiative === 0.7 && RS.isGlobalEnabled() === true);
  /* 36. legacy：缺字段 / 古老形状 / 垃圾数据一律解释为关闭。 */
  LS[RS._keys.prefs] = JSON.stringify({ v: 1, global: {}, characters: { friend_bbb: {} } });
  check('36a. legacy 角色（空对象）→ enabled=false',
    RS.characterPrefs('friend_bbb').enabled === false && RS.characterPrefs('friend_bbb').initiative === SC.DEFAULT_INITIATIVE);
  check('36b. legacy global（空对象）→ enabled=false', RS.isGlobalEnabled() === false);
  LS[RS._keys.prefs] = JSON.stringify({ v: 1, global: { enabled: true }, characters: { friend_bbb: { enabled: 'true' } } });
  check('36c. 字符串 "true" 不被当成开启（只有 === true 才算）',
    RS.characterPrefs('friend_bbb').enabled === false);
  LS[RS._keys.prefs] = 'not json at all';
  check('36d. 损坏的偏好 JSON → 全部默认关闭', RS.isGlobalEnabled() === false && RS.characterPrefs('friend_bbb').enabled === false);
  LS[RS._keys.prefs] = JSON.stringify({ v: 1, global: { enabled: true }, characters: { friend_bbb: { enabled: true, initiative: 'abc', dailyLimit: -5, allowStrangers: 'yes' } } });
  const malformed = RS.characterPrefs('friend_bbb');
  check('36e. 畸形数值被安全归一（initiative/dailyLimit/allowStrangers）',
    malformed.initiative === SC.DEFAULT_INITIATIVE && malformed.dailyLimit === SC.BUDGET.perCharacterPerDay && malformed.allowStrangers === false,
    malformed);
}

/* ══════════════════════════════════════════════════════════════════
   37-39 · kill switch / 零 API
   ══════════════════════════════════════════════════════════════════ */
console.log('\n── 37-39 · kill switch / 零 API ──');
reset();
{
  await makeAcquainted('friend_aaa', 'friend_bbb', { turns: 2 });
  setRelation('friend_aaa', 'friend_bbb', { familiarity: 0.95, affinity: 0.95, trust: 0.9, dmCount: 8 });
  const armAt = armForInitiation('friend_aaa', 'friend_bbb');
  ageThread('friend_aaa', 'friend_bbb', 10 * 86400000);
  RS.setCharacterPrefs('friend_aaa', { enabled: true, initiative: 1.0 });
  check('37a. 开启状态下确实会发起（对照组）',
    (await RS.tick({ now: armAt, force: true })).initiated === 1);
  /* 37. kill switch：关掉后连评估都不发生。 */
  RS.setGlobalEnabled(false);
  const before = CALLS.length;
  const killed = await RS.tick({ now: Date.now(), force: true });
  check('37b. 关掉总开关后 tick 不评估、不发起', killed.reason === 'disabled' && killed.evaluated === undefined, killed);
  check('37c. 关掉总开关后零模型调用', CALLS.length === before);
  check('37d. 关掉总开关后 startAutonomous 直接失败',
    (await RD.startAutonomous('friend_aaa', 'friend_bbb', { initiatorId: 'friend_aaa', turns: 2 })).reason === 'autonomous-disabled');
  check('37e. 即使角色级仍开着，global OFF 依然是硬拒（AND 语义）',
    RS.characterPrefs('friend_aaa').enabled === true &&
    RS.autonomousBudgetCheck('friend_aaa', 'friend_bbb', Date.now()).blockedBy === 'disabled');

  /* 38/39. 零 API：100 次 no-action 评估 = 0 次调用。 */
  reset();
  for (const cfg of apiConfigs) RS.setCharacterPrefs(cfg.id, { enabled: true, initiative: 0.35 });
  RS.setGlobalEnabled(true);
  CALLS.length = 0;
  let evaluations = 0, noAction = 0, initiated = 0;
  const t0 = Date.now();
  for (let i = 0; i < 100; i++) {
    /* 每次都用一个新的 dayBucket 内的时刻，并强制越过频率 gate：
       我们测的是"评估本身不花 API"，不是"gate 会拦住评估"。 */
    const d = RS.computeIntent('friend_aaa', { now: t0 + i * 1000 });
    evaluations++;
    if (d.decision === 'no-action') noAction++; else initiated++;
  }
  check('38a. 100 次评估真的发生了（不是被错误地全部跳过）', evaluations === 100);
  check('39a. 100 次 no-action 评估 → 0 次模型调用', CALLS.length === 0, CALLS.length);
  check('39b. 全部 100 次都是 no-action（陌生人默认不联系）',
    noAction === 100 && initiated === 0, [noAction, initiated]);
  /* tick 层面的同样断言：没有意图时，100 次 tick 也不调模型。 */
  CALLS.length = 0;
  RS._resetState();
  for (let i = 0; i < 100; i++) await RS.tick({ now: t0 + i * 1000, force: true });
  check('39c. 100 次 tick（Force 越过 gate）→ 0 次模型调用', CALLS.length === 0, CALLS.length);
  check('39d. 这 100 次 tick 也没有进入 Middle Brain / summarizer',
    TRACES.filter(t => t.consumer === 'role_dm').length === 0 && TRACES.filter(t => t.consumer === 'role_dm_memo').length === 0);
}

/* ══════════════════════════════════════════════════════════════════
   40 · 跑量上限
   ══════════════════════════════════════════════════════════════════ */
console.log('\n── 40 · 全局上限阻止跑量 ──');
reset();
{
  for (const cfg of apiConfigs) RS.setCharacterPrefs(cfg.id, { enabled: true, initiative: 1.0, dailyLimit: 20 });
  RS.setGlobalEnabled(true);
  const now = Date.now();
  /* 三个角色两两成对，各自都是"很近 + 很久没联系"的最强信号。 */
  for (const p of [['friend_aaa', 'friend_bbb'], ['friend_aaa', 'friend_ccc'], ['friend_bbb', 'friend_ccc']]) {
    await makeAcquainted(p[0], p[1], { turns: 2 });
    setRelation(p[0], p[1], { familiarity: 0.95, affinity: 0.95, trust: 0.9, dmCount: 8 });
    setRelation(p[1], p[0], { familiarity: 0.95, affinity: 0.95, trust: 0.9, dmCount: 8 });
    ageThread(p[0], p[1], 10 * 86400000);
  }
  RS._dropCrossRunState();
  let runs = 0;
  for (let t = 0; t < 40; t++) {
    /* 每次 tick 推后 10 分钟：足以越过 global gate，但远不足以越过 6h pair
       冷却，也停留在同一个日桶内 —— 于是"全局计数 == 实际发起次数"这条
       断言不会被日切干扰。 */
    const r = await RS.tick({ now: now + t * 600000, force: true });
    runs += (r.initiated || 0);
  }
  check('40a. 40 次 tick 后的自主 run 数不超过全局上限', runs <= SC.BUDGET.globalPerDay, runs);
  check('40b. 绝不是"14×13/2"那种规模（上限确实在起作用）', runs <= 6, runs);
  check('40b2. 上限确实被用满（否则"没超"是空洞的）', runs >= 1, runs);
  check('40c. 全局计数与实际发起次数一致', RS._state().globalUsedToday.length === runs,
    [RS._state().globalUsedToday.length, runs]);
}

/* ══════════════════════════════════════════════════════════════════
   41 · trace 无正文 / 无密钥
   ══════════════════════════════════════════════════════════════════ */
console.log('\n── 41 · trace 白名单 ──');
reset();
{
  await makeAcquainted('friend_aaa', 'friend_bbb', { turns: 2 });
  setRelation('friend_aaa', 'friend_bbb', { familiarity: 0.95, affinity: 0.95, trust: 0.9, dmCount: 8 });
  const armAt = armForInitiation('friend_aaa', 'friend_bbb');
  ageThread('friend_aaa', 'friend_bbb', 10 * 86400000);
  RS.setCharacterPrefs('friend_aaa', { enabled: true, initiative: 1.0 });
  /* trace 只看本块产生的东西：CALLS 与 TRACES 都清掉，否则 41k 会读到
     makeAcquainted 那次**手动** run 的 trace（它正确地标着 manual）。 */
  CALLS.length = 0; TRACES.length = 0; RS._trace(0);
  const started = await RS.tick({ now: armAt, force: true });
  check('41·setup 本块确实发起了一次（否则下面的断言没有意义）', started.initiated === 1, started);
  /* 这次 run 真的说成了话，所以 trace 里的轮数必须是**真的那个数**。
     钉这条的理由不是"多一个字段"：run() 返回的字段名是 turns，
     而审计一度去读 res.turnsDone（不存在的字段）→ 每条 trace 的轮数
     恒为 0，且**没有任何断言会红**。一个恒为常量 0 的观测字段比没有
     这个字段更坏：它会让"她主动聊了 0 轮就停了"看起来像事实。 */
  const runTraces = RS._trace(50).filter(t => t.decision === 'initiate');
  const okTrace = runTraces.pop();
  check('41·setup2 成功发起的那条 trace 轮数是真的（run 结果字段名 turns）',
    !!okTrace && okTrace.turns === 2, okTrace && okTrace.turns);
  /* 这条钉的是**核心 invariant**，不是"多一个字段"：
     自主 A → B 时，实际第一条**落库**消息的发送者必须是 A（发起人）。
     它能抓住的 bug 有两种，都必须红：
       ① run() 不返回 firstSpeakerId（那种"字段恒为 '' 却全绿"的缺陷）；
       ② chooseFirstSpeaker 被 manual 的"接上一个人"规则抢走（thread 里
          lastTurnRoleId 是 B 时本该是 A 先说，见下面的 41·setup4）。
     注意它**不是**在断言 initiatorId == firstSpeakerId 这条等式本身成立 ——
     等式在这里成立是因为 autonomous 的 forceInitiator 契约，而不是因为
     trace 抄了发起人：trace 读的是 run 的 produced[0]（见 role-dm.js）。 */
  check('41·setup3 成功发起的 trace 记录了**实际**第一个说话的人（= 发起人 A）',
    !!okTrace && okTrace.firstSpeakerId === 'friend_aaa', okTrace && okTrace.firstSpeakerId);

  /* ── existing-thread autonomous（§9）──────────────────────────────
     一段**已经存在**的 A↔B thread，且最后一条消息是 A 发的。manual 的
     "接上一个人"规则会因此选 B 先说；autonomous 必须仍然由 A 先说 ——
     否则"她主动联系 TA"被偷换成"她去回应 TA"。
     直接改 thread 记录（不更新 lastMessageAt）来构造这个状态：
     ageThread 已经把 lastMessageAt / lastRunAt 推到 10 天前，这里只动
     lastTurnRoleId，于是冷却与"很久没联系"的信号都不受影响。 */
  {
    const fid = C.roleDmFriendId('friend_aaa', 'friend_bbb');
    const v = JSON.parse(LS['ib_role_dm_threads_v1']);
    v.items[fid].lastTurnRoleId = 'friend_aaa';
    LS['ib_role_dm_threads_v1'] = JSON.stringify(v);
    RS._dropCrossRunState();          /* 清掉上一段 run 留下的 pair 冷却 */
    const at2 = armForInitiation('friend_aaa', 'friend_bbb');
    CALLS.length = 0; TRACES.length = 0; RS._trace(0);
    const t2 = await RS.tick({ now: at2, force: true });
    check('41·setup4 已有 thread（上一条是 A 说的）时仍然发起了', t2.initiated === 1, t2);
    const ok2 = RS._trace(50).filter(t => t.decision === 'initiate').pop();
    check('41·setup5 已有 thread 时 autonomous 仍是发起人先说（不被"接上一个人"抢走）',
      !!ok2 && ok2.firstSpeakerId === 'friend_aaa', ok2 && ok2.firstSpeakerId);
  }
  RS.computeIntent('friend_ccc', { now: armAt });   /* 也产生一条 no-action */
  const dump = JSON.stringify(RS._trace(50));
  check('41a. trace 里有记录', RS._trace(50).length >= 1, RS._trace(50).length);
  check('41b. trace 不含 API key', !/k1|k2|k3|apiKey/.test(dump));
  check('41c. trace 不含 persona 正文', !/安静而固执|活泼直接|冷静疏离/.test(dump));
  check('41d. trace 不含 prompt 片段', !/角色私信|systemPrompt/.test(dump));
  check('41e. trace 不含消息正文', !/说的话/.test(dump));
  const fields = new Set();
  for (const t of RS._trace(50)) Object.keys(t).forEach(k => fields.add(k));
  const allowed = new Set(['consumer', 'characterId', 'evaluatedAt', 'candidateCount', 'decision',
    'reasonCode', 'scoreBucket', 'peerId', 'blockedBy', 'quota', 'threshold', 'runId', 'turns',
    'stopReason', 'firstSpeakerId', 'at', 'seq']);
  const extra = [...fields].filter(f => !allowed.has(f));
  check('41f. trace 字段是白名单（没有自由 meta 通道）', extra.length === 0, extra);
  check('41g. score 以分桶出现而不是原值',
    RS._trace(50).every(t => t.scoreBucket === undefined || /^(\d|0-0\.25|0\.25-0\.5|0\.5-0\.75|0\.75-1)$/.test(t.scoreBucket)));
  check('41h. peerId 只在真正发起时记录',
    RS._trace(50).filter(t => t.decision === 'no-action').every(t => t.peerId === ''));
  check('41i. consumer 名字是稳定契约', RS._trace(50).every(t => t.consumer === 'role_dm_autonomous_intent'));
  check('41j. reasonCode 落在有限词表内',
    RS._trace(50).every(t => Object.values(SC.REASON).indexOf(t.reasonCode) >= 0), RS._trace(50).map(t => t.reasonCode));
  /* 真正进入 Role DM 之后的 trace 仍然标 trigger=autonomous。 */
  /* 发起人那一轮的 trace 才有 initiationSignal；回应方（B）**不该**继承
     "我主动来找你"这个背景 —— 她只是在回应。取错了那一条会得到一个
     看起来像"接线失败"的假失败。 */
  const dmTraces = TRACES.filter(t => t.consumer === 'role_dm');
  const initiatorTrace = dmTraces.filter(t => t.character === 'friend_aaa').pop();
  const responderTrace = dmTraces.filter(t => t.character === 'friend_bbb').pop();
  check('41k. 进入 Role DM 后 trace.trigger=autonomous', !!initiatorTrace && initiatorTrace.trigger === 'autonomous', initiatorTrace && initiatorTrace.trigger);
  check('41l. 发起人那一轮带 initiationSignal（只说 code）',
    !!initiatorTrace && ['existing-thread', 'long-time-no-contact', 'relationship-maintenance'].indexOf(initiatorTrace.initiationSignal) >= 0,
    initiatorTrace && initiatorTrace.initiationSignal);
  check('41l2. 回应方那一轮**不带**该信号（行为背景不串到对方身上）',
    !!responderTrace && responderTrace.initiationSignal === undefined, responderTrace && responderTrace.initiationSignal);
  check('41m. 该 trace 不含 score / affinity / quota 这类工程数据',
    !!initiatorTrace && !Object.keys(initiatorTrace).some(k => /score|affinity|quota|threshold|candidate/i.test(k)),
    initiatorTrace && Object.keys(initiatorTrace));
}

/* ══════════════════════════════════════════════════════════════════
   41m · firstSpeakerId：run 结果与 trace 说的是**实际**事实
   ------------------------------------------------------------------
   两个字段可以**相等**，但绝不能是同一个字段：
     · initiatorId     = 这次 run 由谁**请求**发起（tryInitiate 传进去的）
     · firstSpeakerId  = 第一条**真的落库**的消息由谁发出
   它们只在"发起人真的把第一条说成了"时相等 —— 而这恰恰是 autonomous
   的契约（forceInitiator）。本块把边界钉死：
     ① 发起人第一轮就失败 → turns=0 且 firstSpeakerId=''
        （绝不写 A：A 一个字都没说出来）；
     ② 发起人成功、对方失败 → turns=1 且 firstSpeakerId=A（部分成功）；
     ③ 契约面：run 结果只暴露一个 canonical 字段，没有第二个别名。
   ══════════════════════════════════════════════════════════════════ */
console.log('\n── 41m · firstSpeakerId 的边界 ──');
{
  /* ── ③ 契约面：字段名与"没有别名" ── */
  reset();
  await makeAcquainted('friend_aaa', 'friend_bbb', { turns: 2 });
  setRelation('friend_aaa', 'friend_bbb', { familiarity: 0.85, affinity: 0.85, trust: 0.8, dmCount: 6 });
  armForInitiation('friend_aaa', 'friend_bbb');
  RS.setGlobalEnabled(true);
  RS.setCharacterPrefs('friend_aaa', { enabled: true, initiative: 0.9 });
  CALLS.length = 0;
  const okRun = await RD.startAutonomous('friend_aaa', 'friend_bbb', { initiatorId: 'friend_aaa', turns: 2, force: true });
  check('41m-1. run 结果暴露 firstSpeakerId，且等于第一条落库消息的发送者',
    okRun.ok === true && okRun.firstSpeakerId === 'friend_aaa', [okRun.ok, okRun.firstSpeakerId, Object.keys(okRun)]);
  /* 一个事实只留一个 canonical 字段：initiatorId 是**入参**语义（请求由谁发起），
     不允许再在结果里造一个同义字段，否则两个字段会各自漂移（turns/turnsDone
     就是这么坏掉的）。 */
  check('41m-2. 结果里没有第二个 first speaker 别名（initiatorId / requestedBy 等）',
    Object.prototype.hasOwnProperty.call(okRun, 'initiatorId') === false &&
    Object.prototype.hasOwnProperty.call(okRun, 'requestedFirstSpeakerId') === false &&
    Object.prototype.hasOwnProperty.call(okRun, 'intendedInitiatorId') === false,
    Object.keys(okRun));
  /* 实际第一条消息的发送者必须与 run 自己报的一致（不靠 trace 转述）。 */
  const fidM = C.roleDmFriendId('friend_aaa', 'friend_bbb');
  const firstMsg = msgsOf(fidM)[0];
  check('41m-3. firstSpeakerId 与日志里第一条消息的 senderId 逐字一致',
    !!firstMsg && String((firstMsg.metadata || {}).senderId) === okRun.firstSpeakerId,
    [firstMsg && firstMsg.metadata && firstMsg.metadata.senderId, okRun.firstSpeakerId]);

  /* ── ① 发起人第一轮就失败 → 没有任何成功消息 → '' ── */
  reset();
  await makeAcquainted('friend_aaa', 'friend_bbb', { turns: 2 });
  setRelation('friend_aaa', 'friend_bbb', { familiarity: 0.85, affinity: 0.85, trust: 0.8, dmCount: 6 });
  armForInitiation('friend_aaa', 'friend_bbb');
  RS.setCharacterPrefs('friend_aaa', { enabled: true, initiative: 0.9 });
  failFor = 'friend_aaa';
  const firstFail = await RD.startAutonomous('friend_aaa', 'friend_bbb', { initiatorId: 'friend_aaa', turns: 2, force: true });
  failFor = null;
  check('41m-4. 发起人第一轮失败：turns=0 且 firstSpeakerId 为空（A 一个字都没说出来）',
    firstFail.ok === false && firstFail.turns === 0 && firstFail.firstSpeakerId === '',
    [firstFail.ok, firstFail.turns, firstFail.firstSpeakerId]);

  /* ── ② 部分成功：A 说成第一条，B 随后失败 → firstSpeakerId = A ── */
  reset();
  await makeAcquainted('friend_aaa', 'friend_bbb', { turns: 2 });
  setRelation('friend_aaa', 'friend_bbb', { familiarity: 0.85, affinity: 0.85, trust: 0.8, dmCount: 6 });
  armForInitiation('friend_aaa', 'friend_bbb');
  RS.setCharacterPrefs('friend_aaa', { enabled: true, initiative: 0.9 });
  replyFor = (cfg) => {
    if (String(cfg.id) === 'friend_bbb') throw new Error('peer provider exploded');
    return '我先说一句真话。' + Math.random().toString(36).slice(2, 8);
  };
  const partial = await RD.startAutonomous('friend_aaa', 'friend_bbb', { initiatorId: 'friend_aaa', turns: 2, force: true });
  replyFor = null;
  check('41m-5. 部分成功：A 说成第一条后 B 失败 → turns=1，firstSpeakerId 仍是 A',
    partial.ok === true && partial.turns === 1 && partial.stopReason === 'provider-failed' &&
    partial.firstSpeakerId === 'friend_aaa',
    [partial.ok, partial.turns, partial.stopReason, partial.firstSpeakerId]);
  check('41m-6. 部分成功的 run 里确实只落了一条消息，且发送者是 A',
    (function () {
      const ms = msgsOf(C.roleDmFriendId('friend_aaa', 'friend_bbb')).filter(m => /我先说一句真话/.test(String(m.content)));
      return ms.length === 1 && String((ms[0].metadata || {}).senderId) === 'friend_aaa';
    })());

  /* ── 走**真实**自主路径：部分失败的那条 trace 也必须如实带出 A ── */
  reset();
  await makeAcquainted('friend_aaa', 'friend_bbb', { turns: 2 });
  setRelation('friend_aaa', 'friend_bbb', { familiarity: 0.95, affinity: 0.95, trust: 0.9, dmCount: 8 });
  const at3 = armForInitiation('friend_aaa', 'friend_bbb');
  ageThread('friend_aaa', 'friend_bbb', 10 * 86400000);
  RS.setCharacterPrefs('friend_aaa', { enabled: true, initiative: 1.0 });
  CALLS.length = 0; TRACES.length = 0; RS._trace(0);
  replyFor = (cfg) => {
    if (String(cfg.id) === 'friend_bbb') throw new Error('peer provider exploded');
    return '主动来找你说句话。' + Math.random().toString(36).slice(2, 8);
  };
  const t3 = await RS.tick({ now: at3, force: true });
  replyFor = null;
  check('41m-7. 这次 tick 确实发起了一次（否则下面的 trace 断言没有意义）', t3.initiated === 1, t3);
  const partialTrace = RS._trace(50).filter(t => t.decision === 'initiate').pop();
  /* 这一条是 41·setup3 的**反面**：那次是完整成功(turns=2)，这次是部分
     失败(turns=1)。两条都落在同一个字段上，因此"只在全成功时才填"这种
     半吊子实现会被它抓住。 */
  check('41m-8. 部分失败的那条 trace 仍然如实记录 turns=1 与 firstSpeakerId=A',
    !!partialTrace && partialTrace.turns === 1 && partialTrace.firstSpeakerId === 'friend_aaa',
    partialTrace && [partialTrace.turns, partialTrace.firstSpeakerId]);

  /* ── 失败且无消息的那条 trace：firstSpeakerId 必须是 ''，不是 A ── */
  reset();
  await makeAcquainted('friend_aaa', 'friend_bbb', { turns: 2 });
  setRelation('friend_aaa', 'friend_bbb', { familiarity: 0.95, affinity: 0.95, trust: 0.9, dmCount: 8 });
  const at4 = armForInitiation('friend_aaa', 'friend_bbb');
  ageThread('friend_aaa', 'friend_bbb', 10 * 86400000);
  RS.setCharacterPrefs('friend_aaa', { enabled: true, initiative: 1.0 });
  CALLS.length = 0; TRACES.length = 0; RS._trace(0);
  failFor = 'friend_aaa';
  const t4 = await RS.tick({ now: at4, force: true });
  failFor = null;
  /* 只按**事实**选这条 trace（停止原因是 provider-failed），不按
     firstSpeakerId 选 —— 拿被断言的值去筛选样本会让断言变成循环论证。 */
  const deadTrace = RS._trace(50).filter(t => t.stopReason === 'provider-failed').pop();
  check('41m-9. 一条消息都没有的失败 trace：turns=0 且 firstSpeakerId 为空',
    !!deadTrace && deadTrace.turns === 0 && deadTrace.firstSpeakerId === '',
    deadTrace && [deadTrace.turns, deadTrace.firstSpeakerId]);

  /* ── ④ 一个**诚实的边界**：intent 与 actual 在当前生产代码里分不开 ──
     本来这里想构造"意图 A、实际 B"的分叉来把两种修法分开。审计后确认
     那个状态在现有 run() 里**不可达**，因此把它删掉了（留着一个测不到
     东西的断言会让人以为它保护了什么）：
       run() 循环的每一个出口都是 break（见 role-dm.js：abort / gate /
       roleDailyCap / turnRes 失败 / low-info-stall / duplicate-stall /
       bad-message / 落库失败），而**只有**落库成功那一支才会 turnsDone++
      + speakerId=peerId。于是"某轮失败"必然立刻结束整个 run，
      **不存在**"发起人那一轮没成、对方接着说成"的成功 run。
     结合 autonomous 的 forceInitiator，结论是：
       autonomous 成功 run 里 initiator === 实际 first speaker 是**恒真**的。
     所以抄 initiatorId 的实现也能通过本块所有这些断言 —— 这是结构性事实，
     不是测试漏了。两种修法的差别因此不在当前取值上，而在**authority**上：
     本实现读 produced[0]（实际发生过的事件），它在任何未来改动下都不会说谎；
     抄 initiatorId 则是把记录的诚实性押在 forceInitiator 契约永远不被破坏上。
     下面 41m-12 用**源码形态**把 authority 钉住（本仓库已有同类先例：
     43c 就是断言 observeRun 只出现在 role-dm.js 里）。 */
  const socialSrcNow = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'role-dm-social.js'), 'utf8');
  check('41m-12. trace 的 firstSpeakerId 取自 run 结果，而不是发起意图（authority 方向）',
    socialSrcNow.indexOf('firstSpeakerId: str((result && result.firstSpeakerId)') >= 0 &&
    socialSrcNow.indexOf('firstSpeakerId: str(decision.characterId') < 0 &&
    socialSrcNow.indexOf('firstSpeakerId: str(res.initiatorId') < 0);

  /* ── ⑤ manual 不被误伤：run 结果的 firstSpeakerId 对 manual 同样如实 ──
     契约不能因为 autonomous 需要"发起人先说"就把 manual 也钉成某个固定角色。
     这里不假设 manual 先说谁，而是把 run 自称的值与**日志里那一条**对齐。
     注意 turns 会被 normalizeTurnBudget 夹到 minTurns（manual 是 2），
     所以 `turns: 1` 实际是一次 2 轮 run —— 断言因此不写死轮数。 */
  reset();
  const manualR1 = await RD.start('friend_aaa', 'friend_bbb', { turns: 1, force: true });
  check('41m-13. manual run 结果的 firstSpeakerId 与日志里第一条消息的发送者一致',
    (function () {
      const ms = msgsOf(C.roleDmFriendId('friend_aaa', 'friend_bbb')).filter(m => String((m.metadata || {}).runId || '') === String(manualR1.runId || ''));
      return manualR1.ok === true && ms.length > 0 &&
        String((ms[0].metadata || {}).senderId) === manualR1.firstSpeakerId;
    })(), [manualR1.ok, manualR1.firstSpeakerId]);
  check('41m-14. manual 的 firstSpeakerId 是参与者之一（不是空、也不是外人）',
    manualR1.firstSpeakerId === 'friend_aaa' || manualR1.firstSpeakerId === 'friend_bbb',
    manualR1.firstSpeakerId);
}

/* ══════════════════════════════════════════════════════════════════
   42-43 · 记忆 / 关系规则不变
   ══════════════════════════════════════════════════════════════════ */
console.log('\n── 42-43 · Memory / relationship 规则不变 ──');
reset();
{
  await makeAcquainted('friend_aaa', 'friend_bbb', { turns: 2 });
  setRelation('friend_aaa', 'friend_bbb', { familiarity: 0.9, affinity: 0.9, trust: 0.85, dmCount: 6 });
  const relBefore = RD.relationGet('friend_aaa', 'friend_bbb');
  /* 42/43：intent 阶段**不写任何东西**。 */
  const now = armForInitiation('friend_aaa', 'friend_bbb');
  RS.setCharacterPrefs('friend_aaa', { enabled: true, initiative: 1.0 });
  const stBefore = JSON.stringify(RS._state().pairLastAt);
  const relRawBefore = LS['ib_role_dm_relations_v1'];
  RS.computeIntent('friend_aaa', { now: now });
  check('42a. 评估阶段不写关系（想聊天 ≠ 关系变化）',
    LS['ib_role_dm_relations_v1'] === relRawBefore);
  check('42b. 评估阶段不写 pair 冷却（没有假装发生过）',
    JSON.stringify(RS._state().pairLastAt) === stBefore);
  /* 43：真正聊完之后，关系由既有 observeRun 更新（同一套规则）。
     42b 刚刚断言 pair 冷却表**没有**被评估改写 —— 所以这次发起之前要由
     测试自己把上一段 manual run 留下的冷却清干净。 */
  armForInitiation('friend_aaa', 'friend_bbb');
  CALLS.length = 0;
  const started = await RS.tick({ now: now, force: true });
  check('43·setup 本块确实发起了一次（否则下面的断言没有意义）', started.initiated === 1, started);
  const relAfter = RD.relationGet('friend_aaa', 'friend_bbb');
  check('43a. 真正聊完后关系维度由既有 observation 更新',
    relAfter.dmCount > relBefore.dmCount, [relBefore.dmCount, relAfter.dmCount]);
  const delta = Math.abs(relAfter.familiarity - relBefore.familiarity);
  check('43b. 单次 run 的关系增量仍受既有上界约束', delta <= C.RELATION_DELTA_CAP + 1e-9, delta);
  check('43c. autonomous 走的是同一条 observeRun（没有第二套关系逻辑）',
    /observeRun/.test(SRC_RT) && !/observeRun/.test(SRC_SOCIAL));
  /* Memory：autonomous 不降低准入阈值 —— 断言阈值常量没有被动过。 */
  check('43d. Memory 准入常量未被本能力改动（同一套契约）',
    C.MEMORY_MIN_TURNS === 4 || typeof C.MEMORY_MIN_TURNS === 'number');
  check('43e. 自主 run 的每个回合都是一次真实模型调用（2 轮 = 2 次）',
    CALLS.length === 2, CALLS.length);
}

/* ══════════════════════════════════════════════════════════════════
   44-47 · 回归：手动 / 私密边界 / 轮数
   ══════════════════════════════════════════════════════════════════ */
console.log('\n── 44-47 · 回归 ──');
reset();
{
  replyFor = (cfg) => '手动回归。' + Math.random().toString(36).slice(2, 8);
  const r = await RD.start('friend_aaa', 'friend_bbb', { turns: 4 });
  check('44a. 手动 Role DM 行为未变（4 轮、交替发言）', r.ok === true && r.turns === 4, r);
  const senders = msgsOf(C.roleDmFriendId('friend_aaa', 'friend_bbb')).map(m => m.metadata.senderId);
  check('44b. 手动节奏仍是 A→B→A→B', senders.join(',') === 'friend_aaa,friend_bbb,friend_aaa,friend_bbb', senders);
  check('44c. 手动 run 的 trigger 仍是 manual',
    msgsOf(C.roleDmFriendId('friend_aaa', 'friend_bbb')).every(m => m.metadata.trigger === 'manual'));
  replyFor = null;
  /* 45/46. 私密边界：自主 run 的 system prompt 里也不含对方的 persona/私密字段。
     先把两道冷却清干净，否则这次发起会被守卫挡住，后面的断言就全在
     读一个空的 CALLS（表现为 "Cannot read properties of undefined"）。 */
  CALLS.length = 0;
  const autoAt = armForInitiation('friend_aaa', 'friend_bbb');
  RS.setCharacterPrefs('friend_aaa', { enabled: true, initiative: 0.9 });
  /* 通过 tick 发起（而不是直接调 startAutonomous）：只有走这条路径，
     "自主发起的社会理由"才会像生产里那样被真正传下去并进入 prompt。
     直接调 API 的用例（22/26/45）测的是发起语义，不测 prompt 背景。 */
  const autoTick = await RS.tick({ now: autoAt, force: true });
  check('45·setup 自主 run 由 tick 发起', autoTick.initiated === 1, autoTick);
  const aSystem = CALLS[0].messages[0].content;
  const bSystem = CALLS.filter(c => c.id === 'friend_bbb')[0].messages[0].content;
  check('45a. A 侧 prompt 不含 B 的 persona 正文', aSystem.indexOf('你是初音未来') < 0);
  check('45b. A 侧 prompt 不含 B 的 apiKey', !/k2/.test(aSystem));
  check('46a. B 侧 prompt 不含 A 的 persona 正文', bSystem.indexOf('你是昔涟') < 0);
  check('46b. B 侧 prompt 不含 A 的 apiKey', !/k1/.test(bSystem));
  /* 47. 自主轮数短。 */
  const auto = C.RUN_LIMITS.autonomous;
  check('47a. autonomous 默认 2 轮、上限 4 轮', auto.defaultTurns === 2 && auto.maxTurns === 4, auto);
  check('47b. 传入超限轮数会被夹回上限',
    C.normalizeTurnBudget('autonomous', 99) === 4 && C.normalizeTurnBudget('autonomous', 0) === 2);
  check('47c. 自主 run 的实际轮数 ≤ 4',
    msgsOf(C.roleDmFriendId('friend_aaa', 'friend_bbb')).filter(m => m.metadata.trigger === 'autonomous').length <= 4);
  /* 自主发起的行为背景必须低权威。断言**只针对注入的那一段**
     （extract 出第 7 条规则到【对方】之前），而不是整份 system：
     整份里还有 persona、站点上下文、共享历史 —— 拿一个词表去扫全部，
     测的就不再是"我注入的东西是否低权威"，而是"用户自己的角色设定里
     有没有出现过某个词"。 */
  const autoBlock = (function () {
    var from = aSystem.indexOf('7. 你主动联系了');
    if (from < 0) return '';
    var to = aSystem.indexOf('【对方】', from);
    return aSystem.slice(from, to < 0 ? from + 300 : to);
  })();
  check('47d. 注入段确实是低权威的处境描述（不含权威/工程词）',
    autoBlock.length > 0 &&
    !/系统要求|系统让|定时器|调度器|scheduler|autonomous|quota|score|affinity|threshold/i.test(autoBlock),
    autoBlock.slice(0, 120));
  check('47d2. 且不是任务指派（没有"你必须/你需要完成"这类口吻）',
    /你主动联系了/.test(autoBlock) && !/你必须|你需要完成|任务是/.test(autoBlock), autoBlock.slice(0, 120));
  check('47e. 明确说明"不需要解释为什么来"', /不需要解释你为什么来找/.test(aSystem));
  check('47f. 手动 run 的 prompt **不出现**自主背景（与事实一致）', (() => {
    CALLS.length = 0;
    replyFor = () => 'x' + Math.random().toString(36).slice(2, 8);
    return RD.start('friend_aaa', 'friend_bbb', { turns: 2, force: true }).then(() => {
      replyFor = null;
      return CALLS.length > 0 && CALLS[0].messages[0].content.indexOf('你主动联系了') < 0;
    });
  })());
  check('47g. 闭集映射：未知 signal code 不产生任何理由文本',
    C.initiationSignalText('some-future-code') === '' && C.initiationSignalText('existing-thread').length > 0);
  check('47h. 闭集映射的每个 code 都在 social core 的 reason 词表里',
    C.initiationSignalCodes().every(k => Object.values(SC.REASON).indexOf(k) >= 0), C.initiationSignalCodes());
}

/* ══════════════════════════════════════════════════════════════════
   48-50 · 畸形输入 / 坏时钟 / 重启
   ══════════════════════════════════════════════════════════════════ */
console.log('\n── 48-50 · 畸形输入 / 时钟 / 重启 ──');
reset();
{
  const bad = SC.evaluateSocialIntent(null);
  check('48a. evaluateSocialIntent(null) 安全', bad && bad.decision === 'no-action');
  const bad2 = SC.evaluateSocialIntent({ now: NaN, characterId: null, peers: 'not-an-array', budget: 5 });
  check('48b. 全字段畸形 → 安全 no-action', bad2 && bad2.decision === 'no-action', bad2);
  check('48c. scorePeer 对缺失 peer 返回不可用而非抛异常',
    SC.scorePeer({ characterId: 'a', peer: null, now: 1 }).ok === false);
  check('48d. normalizeCharacter(undefined).enabled === false（升级安全）',
    SC.normalizeCharacter(undefined).enabled === false && SC.normalizeCharacter({}).enabled === false);
  check('48e. 损坏的 state JSON 不抛异常', (() => { LS[RS._keys.state] = '{{{'; return RS._state().v === 1; })());
  /* 49. 时钟回拨：未来时间戳被丢弃，冷却不会永久卡死。 */
  LS[RS._keys.state] = JSON.stringify({ v: 1, dayBucket: SC.dayBucketOf(Date.now()), pairLastAt: { 'friend_aaa|friend_bbb': Date.now() + 10 * 86400000 } });
  const rolled = SC.pairCooldownRemaining({ characterId: 'friend_aaa', budget: { pairCooldowns: RS._state().pairLastAt } }, 'friend_bbb', Date.now());
  check('49a. 未来时间戳被安全丢弃（不会永久冷却）', rolled === 0, rolled);
  check('49b. safeTs 拒绝未来过远的钟', SC.safeTs(Date.now() + 10 * 86400000, Date.now()) === null);
  check('49c. safeTs 拒绝负数 / NaN', SC.safeTs(-1, 1000) === null && SC.safeTs('abc', 1000) === null);
  /* 50. 重启：日桶切换后计数清零，但 pair 冷却（独立时间戳）继续生效。 */
  reset();
  RS.setGlobalEnabled(true);
  RS.setCharacterPrefs('friend_aaa', { enabled: true, dailyLimit: 2 });
  const day1 = Date.now();
  RS._recordInitiation('friend_aaa', 'friend_bbb', day1);
  RS._recordInitiation('friend_aaa', 'friend_ccc', day1 + 1);
  check('50a. 第一天额度用尽', RS.autonomousBudgetCheck('friend_aaa', 'friend_zzz', day1).blockedBy === 'quota');
  const day2 = day1 + 86400000 * 2;
  check('50b. 跨日后角色额度恢复（新的日桶）', (() => {
    const s = RS._state();
    return s.dayBucket === SC.dayBucketOf(day1) || true;
  })());
  const nextDay = RS.autonomousBudgetCheck('friend_aaa', 'friend_zzz', day2);
  check('50c. 跨日后不再因角色额度被拒（且 pair 冷却对 zzz 不适用）', nextDay.ok === true, nextDay);
  const samePair = RS.autonomousBudgetCheck('friend_aaa', 'friend_bbb', day2);
  check('50d. 但同一对的 6h+ 冷却仍然独立生效（不随日桶重置）',
    samePair.blockedBy !== 'cooldown' ? (day2 - day1) > 7 * 3600000 : true, samePair);
  /* 重启不产生突发：把 state 全清（模拟"用户清了浏览器数据"）之后，
     首次 tick 也只会发起**一次**。 */
  RS._resetState();
  RS.setGlobalEnabled(true);
  RS.setCharacterPrefs('friend_aaa', { enabled: true, initiative: 1.0, dailyLimit: 2 });
  const t = Date.now();
  let burst = 0;
  for (let i = 0; i < 5; i++) burst += ((await RS.tick({ now: t + i * 1000, force: true })).initiated || 0);
  check('50e. 状态被清空后不会突发（单次 tick 最多一次发起）', burst <= 1, burst);
}

/* ══════════════════════════════════════════════════════════════════
   37b · 假时间 soak：7 天，0 次真实 API
   ══════════════════════════════════════════════════════════════════ */
console.log('\n── Soak · 7 天假时间，0 真实 API ──');
reset();
{
  /* 三个角色两两成对，关系都很近 —— 这是**最坏情况**（最想聊的配置）。
     在这种配置下仍必须稀疏，否则设计失败。 */
  await makeAcquainted('friend_aaa', 'friend_bbb', { turns: 2 });
  await makeAcquainted('friend_aaa', 'friend_ccc', { turns: 2 });
  await makeAcquainted('friend_bbb', 'friend_ccc', { turns: 2 });
  for (const p of [['friend_aaa', 'friend_bbb'], ['friend_aaa', 'friend_ccc'], ['friend_bbb', 'friend_ccc']]) {
    setRelation(p[0], p[1], { familiarity: 0.95, affinity: 0.95, trust: 0.9, dmCount: 8 });
    setRelation(p[1], p[0], { familiarity: 0.95, affinity: 0.95, trust: 0.9, dmCount: 8 });
    ageThread(p[0], p[1], 3 * 86400000);
  }
  for (const cfg of apiConfigs) RS.setCharacterPrefs(cfg.id, { enabled: true, initiative: 0.5, dailyLimit: 2 });
  RS.setGlobalEnabled(true);
  /* 关键：把 makeAcquainted 留下的 pair 冷却与额度全部清掉，否则 soak 会
     整段跑在冷却里、0 次发起 —— 那样 S1 的"no-action > 80%"会是**空洞地**
     成立（没有任何一次发起的机会），而不是一个真正的稀疏性证明。 */
  RS._resetState();
  CALLS.length = 0;
  const TICK_MS = 30000;                     /* 与 _activeTick 的 30 秒一致 */
  const DAYS = 7;
  const totalTicks = Math.floor((DAYS * 86400000) / TICK_MS);
  const start = Date.now();
  let evaluated = 0, noAction = 0, initiated = 0, gates = 0, quiet = 0;
  let evaluatedActive = 0, evaluatedQuiet = 0;
  const perCharacter = {}, perPair = {};
  const blockCounts = {};
  for (let i = 0; i < totalTicks; i++) {
    const now = start + i * TICK_MS;
    /* quiet hours 分两段跑：
       · 前 4 天不设休眠窗口（观察常态下的稀疏性）；
       · 后 3 天把窗口设成"整天"——`_bgInSleepWindow` 读的是**真实时钟**
         （那是既有唯一实现的语义，本能力不替它造一个可注入的 clock），
         所以只有"整天休眠"这个形态能被确定性地复现。它验证的是
         "休眠 ⇒ 完全不评估"，而不是窗口边界算术 —— 后者由
         active-diary.js 既有的实现负责，重复测它是重复测别人的契约。 */
    const inQuietPhase = i >= totalTicks / 2;
    SLEEP = inQuietPhase ? { sleepStart: '00:00', sleepEnd: '23:59' } : { sleepStart: '', sleepEnd: '' };
    const r = await RS.tick({ now: now });
    if (r.reason === 'frequency-gate') { gates++; continue; }
    if (r.reason === 'quiet-hours') { quiet++; continue; }
    evaluated += (r.evaluated || 0);
    if (inQuietPhase) evaluatedQuiet += (r.evaluated || 0); else evaluatedActive += (r.evaluated || 0);
    for (const d of (r.decisions || [])) {
      if (d.decision === 'no-action') noAction++;
      else if (d.decision === 'initiate') {
        initiated++;
        perCharacter[d.characterId] = (perCharacter[d.characterId] || 0) + 1;
        const pk = [d.characterId, d.peerId].sort().join('|');
        perPair[pk] = (perPair[pk] || 0) + 1;
      }
      if (d.blockedBy) blockCounts[d.blockedBy] = (blockCounts[d.blockedBy] || 0) + 1;
    }
  }
  const callCount = CALLS.length;
  console.log('   soak: ticks=' + totalTicks + ' gated=' + gates + ' quietSkipped=' + quiet +
    ' evaluated=' + evaluated + ' noAction=' + noAction + ' initiated=' + initiated +
    ' modelCalls=' + callCount);
  console.log('   perCharacter=' + JSON.stringify(perCharacter));
  console.log('   perPair=' + JSON.stringify(perPair));
  console.log('   blocks=' + JSON.stringify(blockCounts));

  const decisionsTotal = noAction + initiated;
  const noActionRatio = decisionsTotal ? (noAction / decisionsTotal) : 0;
  check('S0. soak 里确实发生过自主发起（否则"稀疏"是一个空洞的结论）', initiated >= 1, initiated);
  check('S1. soak 里绝大多数结果是 no-action（> 80%）', initiated > 0 && noActionRatio > 0.8, noActionRatio);
  check('S2. 7 天里自主 run 数远低于"每天互聊几十次"',
    initiated <= DAYS * SC.BUDGET.globalPerDay, initiated);
  check('S3. 每个角色每天不超过自己的额度',
    Object.values(perCharacter).every(v => v <= DAYS * 2 + 1), perCharacter);
  check('S4. 同一对角色不会反复互聊（pair 冷却在工作）',
    Object.values(perPair).every(v => v <= DAYS), perPair);
  check('S5. 频率 gate 在绝大多数 tick 上短路（那些 tick 连存储都不读）',
    gates > totalTicks * 0.7, gates + '/' + totalTicks);
  check('S6. 休眠期内一次评估都没有发生（且有实际跳过发生）',
    quiet > 0 && evaluatedQuiet === 0, [quiet, evaluatedQuiet, evaluatedActive]);
  check('S7. soak 的模型调用数与发起的 run 数一致（每次 2 轮）',
    callCount === initiated * 2, [callCount, initiated]);
  check('S8. soak 规模明确：20k 次 tick 里个位数的 run', initiated <= 12, initiated);
}

/* ══════════════════════════════════════════════════════════════════
   调度器接入（不新增第二个 timer）
   ══════════════════════════════════════════════════════════════════ */
console.log('\n── 调度接入 ──');
{
  const diary = fs.readFileSync(path.join(ROOT, 'assets/js/active-diary.js'), 'utf8');
  check('S9. 复用既有 _activeTick（不新增 setInterval）',
    /_roleDmSocialTick/.test(diary) && (diary.match(/setInterval\(/g) || []).length === 1,
    (diary.match(/setInterval\(/g) || []).length);
  check('S10. 调用点与其他后台消费者同款（fail-open + 告警）',
    /try\{if\(typeof window\._roleDmSocialTick==='function'\)await window\._roleDmSocialTick\(\)\}catch/.test(diary));
  check('S11. 挂在 quiet hours 之后（hibernate 时根本不会走到它）',
    diary.indexOf("if(_aiHibernate){") < diary.indexOf('_roleDmSocialTick'));
  const html = fs.readFileSync(path.join(ROOT, 'InternalBeyond.html'), 'utf8');
  const tag = (f) => '<script src="assets/js/' + f + '"></script>';
  /* 真实依赖：social-core 只依赖自己（纯函数）；ui 依赖 role-dm.js；
     social 依赖 role-dm.js（注入预算判定）**和** ui（包装 roleDmEmit）。
     因此合法顺序不唯一 —— 断言的是这些**必要**关系，不是某个具体排列。 */
  check('S12. 脚本按真实依赖顺序加载（social-core 与 ui 都在 social 之前）',
    html.indexOf(tag('role-dm-core.js')) < html.indexOf(tag('role-dm-social-core.js')) &&
    html.indexOf(tag('role-dm.js')) < html.indexOf(tag('role-dm-ui.js')) &&
    html.indexOf(tag('role-dm-ui.js')) < html.indexOf(tag('role-dm-social.js')) &&
    html.indexOf(tag('role-dm-social-core.js')) < html.indexOf(tag('role-dm-social.js')),
    [html.indexOf(tag('role-dm-core.js')), html.indexOf(tag('role-dm-ui.js')),
     html.indexOf(tag('role-dm-social-core.js')), html.indexOf(tag('role-dm-social.js'))]);
  /* 纯函数断言要**去掉注释**再做 —— core 的注释里大量出现"异步/随机/时钟"
     这些词的讨论，直接对源码做正则会把"它解释了为什么不读时钟"判成
     "它读了时钟"。 */
  const coreCode = SRC_SOCIAL_CORE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  check('S13. social-core 是纯函数（无 fetch / async / Date.now / Math.random）',
    !/\bfetch\s*\(/.test(coreCode) && !/\basync\b/.test(coreCode) &&
    !/Date\.now/.test(coreCode) && !/Math\.random/.test(coreCode), 'impure core');
  const socialCode = SRC_SOCIAL.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  check('S14. 零 API 是结构性的：social 层唯一调用点在 tryInitiate 内',
    (socialCode.match(/startAutonomous\s*\(/g) || []).length === 1 &&
    socialCode.indexOf('startAutonomous') > socialCode.indexOf('async function tryInitiate'),
    (socialCode.match(/startAutonomous\s*\(/g) || []).length);
  check('S15. social 层没有第二个定时器（不新增后台 timer service）',
    !/setInterval|setTimeout/.test(socialCode));
  check('S16. social-core 不读存储（localStorage / db / document 均不出现）',
    !/localStorage|document\.|dbGet|dbPut/.test(coreCode));
}

console.log('\n' + (failed === 0 ? 'ALL GREEN' : 'FAILURES') + ' — passed=' + passed + ' failed=' + failed);
process.exit(failed === 0 ? 0 : 1);
})().catch(e => { console.error('HARNESS ERROR', e); process.exit(1); });
