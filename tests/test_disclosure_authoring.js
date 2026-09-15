/* ====================================================================
   test_disclosure_authoring.js — Phase 4B-1.2 · Explicit Disclosure Writer Seam
   --------------------------------------------------------------------
   它证明的是一句可以被证伪的话：

     「用户可以明确地为角色 A 创建一条 canonical PERSONAL / PRIVATE / SECRET
       事实，而整个模型系统仍然完全看不到它。」

   因此本文件刻意**不是**只测纯函数的单测，它有三段不同性质的证据：

     §I   契约层（A–H / P）：seam 的允许与拒绝。纯函数，零 IO。
     §II  持久化层（I–O / Q）：canonical store 的 create / update / delete /
          roundtrip / A-B 分区。用内存 mock 的 IndexedDB 适配器。
     §III **真实生产路径**（R–X）：加载**真实的** role-dm.js 与
          memory-retrieval-core.js，用同一个假 DB，跑真实的 composeSide 与
          真实的「memories → buildMemoryContext」读取路径，证明：
            · 创建一条 SECRET 之后 composeSide 输出**逐字节不变**；
            · 该 SECRET 的正文**不出现在**任何模型上下文里；
            · 模型调用次数不变。

   为什么不把 §III 的 memory 读取写成 `getMemoryContext = async () => ''`：
   那会让"秘密没有进入模型上下文"变成**恒真**（一个永远返回空串的替身
   当然不含任何秘密）。这里复刻的是 memory.js:133-154 `selectMemoryContext`
   的**真实读取形状**（`dbGetAll('memories')` → 共享核心 buildMemoryContext），
   渲染与打分全部委托**真实**的 memory-retrieval-core.js + visibility-core.js。
   于是"秘密不在模型上下文里"在测试里是有内容的：它之所以不在，是因为它
   根本不在 memories store 里；而 MU 组的变异反向证明了这一点 —— 一旦把秘密
   复制进 memories，同一条断言立刻变红。
   文件末尾另有**静态断言**把"复刻"与"生产"焊上：memory.js 的读取点仍是
   dbGetAll('memories')，且模型消费链没有任何一处引用 disclosure store。

   运行：node tests/test_disclosure_authoring.js
   零真实 AI 调用：callApiChat 是记录型替身，从不发网络请求。
   ==================================================================== */
'use strict';

const path = require('path');
const fs = require('fs');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const readSrc = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const SRC_PP = readSrc('assets/js/public-profile-core.js');
const SRC_PBC = readSrc('assets/js/prompt-boundary-core.js');
const SRC_DC = readSrc('assets/js/disclosure-core.js');
const SRC_AC = readSrc('assets/js/disclosure-authoring-core.js');
const SRC_ST = readSrc('assets/js/disclosure-store.js');
const SRC_RDC = readSrc('assets/js/role-dm-core.js');
const SRC_RDM = readSrc('assets/js/role-dm.js');

const DC = require(path.join(ROOT, 'assets/js/disclosure-core.js'));
const AC = require(path.join(ROOT, 'assets/js/disclosure-authoring-core.js'));
const MRC = require(path.join(ROOT, 'assets/js/memory-retrieval-core.js'));
const PBC = require(path.join(ROOT, 'assets/js/prompt-boundary-core.js'));

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('  \u2714 ' + name); }
  else { failed++; console.log('  \u2716 ' + name + (detail !== undefined ? '  ' + JSON.stringify(detail) : '')); }
}
function group(t) { console.log('\n' + t); }

/* ══════════════════════════════════════════════════════════════════
   内存 mock 层（与 tests/test_role_dm.js 同款形状）
   ══════════════════════════════════════════════════════════════════ */
const DB = {};            /* store -> { key: rec } */
const LS = {};            /* localStorage */
let _seq = 0;

function _storeOf(s) { if (!DB[s]) DB[s] = {}; return DB[s]; }
/* keyPath 与 core.js 的 openDB 一致：categories→name，disclosureFacts→factId，其余→id。
   mock 必须照 production 的 keyPath 取键，否则"disclosureFacts 的键是 factId"
   这条断言测的就是 mock 的行为而不是生产的行为。 */
function _keyOf(s, d) {
  if (s === 'categories') return d.name;
  if (s === 'disclosureFacts') return d.factId;
  return d.id;
}

const dbPut = async (s, d) => { _storeOf(s)[_keyOf(s, d)] = Object.assign({}, d); };
const dbGetAll = async (s) => Object.values(DB[s] || {});
const dbGet = async (s, k) => (DB[s] || {})[k] || null;
const dbDelete = async (s, k) => { if (DB[s]) delete DB[s][k]; };

const apiConfigs = [
  { id: 'friend_aaa', nickname: '昔涟', provider: 'anthropic', model: 'claude-x', endpoint: 'e', apiKey: 'k1', systemPrompt: '你是昔涟，安静而固执。', relationship: '挚友' },
  { id: 'friend_bbb', nickname: '初音未来', provider: 'qwen', model: 'qwen-plus', endpoint: 'e2', apiKey: 'k2', systemPrompt: '你是初音未来，活泼直接。', relationship: '搭档' }
];

/* 记录型模型替身：从不发网络请求（REAL AI CALLS = 0 的机制保证）。 */
const CALLS = [];
function callApiChatMock(cfg, messages, opts) {
  CALLS.push({ id: String(cfg && cfg.id), messages: JSON.parse(JSON.stringify(messages || [])) });
  const out = '这是' + ((cfg && cfg.nickname) || (cfg && cfg.id) || 'AI') + '说的话。' + CALLS.length;
  return (opts && opts.wantMeta) ? { text: out, truncated: false } : out;
}

/* 真实读取形状的记忆上下文（复刻 memory.js:133-154 selectMemoryContext）。 */
async function getMemoryContextReplica(apiId, opts) {
  const o = opts || {};
  const all = await dbGetAll('memories');
  const picked = MRC.buildMemoryContext(all, {
    apiId: apiId, now: Date.now(), random: () => 0.5,
    userMessage: o.userMessage || '', isGroup: false, groupMemEnabled: false,
    maxChars: o.maxChars || 1200, contentLen: o.contentLen || 60
  });
  return picked && picked.text ? picked.text : '';
}

/* ── 浏览器全局替身（role-dm.js 的真实加载期依赖）── */
global.db = {};
global.dbPut = dbPut;
global.dbGetAll = dbGetAll;
global.dbGet = dbGet;
global.dbDelete = dbDelete;
global.localStorage = {
  getItem: (k) => (LS[k] === undefined ? null : LS[k]),
  setItem: (k, v) => { LS[k] = String(v); },
  removeItem: (k) => { delete LS[k]; }
};
global.console.info = () => {};
global.apiConfigs = apiConfigs;
global.archivedConfigs = [];
global.callApiChat = callApiChatMock;
global.buildSiteContext = async () => '';
global.getMemoryContext = getMemoryContextReplica;
global.getUnderstandingContext = async () => '';
global.quickCreateMemory = async (data) => {
  const id = 'mem_' + (++_seq);
  await dbPut('memories', Object.assign({ id: id, visibility: 'public', created: Date.now(), createdBy: 'user' }, data, { id: id }));
  return id;
};
global._ibTurnScope = (label) => ({ __ibTurnScope: true, label: label, ownsCycle: true });
global._ibTurnLc = (turn) => ({ turn: () => turn, begin: () => turn, end: () => null });
global._chatSendingFor = new Set();
global._activeTextSimilarity = () => 0;

global.window = {
  apiConfigs: apiConfigs,
  archivedConfigs: [],
  _ibApiReady: () => true,
  _ibApiHasCredential: () => true,
  promptBoundarySanitizer: null,
  IBPromptBoundaryCore: PBC,
  amEnabled: () => false,
  amBuildInject: async () => ({ sys: '', tail: '' }),
  _activeTextSimilarity: () => 0,
  /* window.dbXxx 是 production 的挂载点（core.js:1266-1270），
     disclosure-store.js 的 io() 正是从这里取。 */
  dbPut: dbPut, dbGetAll: dbGetAll, dbGet: dbGet, dbDelete: dbDelete
};
global.window.IB = {
  expose: (name, exp) => { const n = (global.window.IB[name] = global.window.IB[name] || {}); Object.assign(n, exp || {}); return n; },
  __mbTrace: { begin: () => {}, note: () => {}, finish: () => {} },
  middleBrain: {
    middleBrainExecute: async () => ({ source: 'bypass', compressedContext: '' }),
    middleBrainFinalizeReply: async (id, u, candidate) => ({ reply: candidate, outcome: { verdict: 'PASS' } })
  }
};

/* ── 按 InternalBeyond.html 的脚本顺序载入（UMD 浏览器分支）── */
(0, eval)(SRC_PBC); global.window.IBPromptBoundaryCore = global.IBPromptBoundaryCore;
(0, eval)(SRC_PP); global.window.IBPublicProfileCore = global.IBPublicProfileCore;
(0, eval)(SRC_DC); global.window.IBDisclosureCore = global.IBDisclosureCore;
(0, eval)(SRC_AC); global.window.IBDisclosureAuthoringCore = global.IBDisclosureAuthoringCore;
(0, eval)(SRC_ST);   /* IIFE → window.IBDisclosureStore */
(0, eval)(SRC_RDC); global.window.IBRoleDmCore = global.IBRoleDmCore;
(0, eval)(SRC_RDM);

const ST = global.window.IBDisclosureStore;
const RD = global.window.IB.roleDm;

const AUTHOR_A = { ownerCharacterId: 'friend_aaa' };
const AUTHOR_B = { ownerCharacterId: 'friend_bbb' };
const SECRET_TEXT = '昔涟不愿让任何人知道：她害怕雷声。';

function resetState() {
  for (const k of Object.keys(DB)) delete DB[k];
  for (const k of Object.keys(LS)) delete LS[k];
  CALLS.length = 0;
}
/* 冻结时钟只包住 composeSide：它的 nowLabel 是分钟粒度，不冻结会让
   "逐字节相同"偶发假红。**不**全局冻结 —— role-dm 的 ledger / pairCooldown
   依赖真实时间推进，冻死它们会让第二次 run 被冷却挡住，那是测试造成的假结果。 */
function withFrozenClock(fn) {
  const Real = Date;
  const TS = 1735689600000;
  function Frozen() { return arguments.length ? new Real(...arguments) : new Real(TS); }
  Frozen.now = () => TS;
  Frozen.parse = Real.parse; Frozen.UTC = Real.UTC; Frozen.prototype = Real.prototype;
  global.Date = Frozen;
  try { return fn(); } finally { global.Date = Real; }
}

/* ══════════════════════════════════════════════════════════════════
   A–H · 创作契约（纯函数）
   ══════════════════════════════════════════════════════════════════ */
group('A–C. 三档都能创建，且等级**原样**落地（不被静默降级）');
{
  ['PERSONAL', 'PRIVATE', 'SECRET'].forEach((lvl) => {
    const r = AC.planCreate(AUTHOR_A, { level: lvl, text: '一条 ' + lvl + ' 事实' });
    check('A–C.' + lvl + ' 创建成功且 level === ' + lvl,
      r.ok === true && r.fact.level === lvl && r.fact.ownerCharacterId === 'friend_aaa', r.ok ? r.fact.level : r.reason);
  });
  const s = AC.planCreate(AUTHOR_A, { level: 'SECRET', text: 'x' });
  check('A–C.4 SECRET 没有被权威上限降级（human_authoring 的上限就是 SECRET）',
    s.fact.level === 'SECRET' && DC.maxLevelForAuthority(s.fact.authority) === 'SECRET');
  check('A–C.5 三档恰好等于 GATED_LEVELS（本路径产出的每条事实将来都必须过授权）',
    JSON.stringify(AC.AUTHORING_LEVELS) === JSON.stringify(DC.GATED_LEVELS), AC.AUTHORING_LEVELS);
}

group('D. owner 来自 writer context（不是表单、不是当前聊天对象）');
{
  const r = AC.planCreate(AUTHOR_A, { level: 'SECRET', text: '害怕雷声', subjectCharacterId: 'friend_bbb' });
  check('D1. owner === writer context 的 A（subjectCharacterId 指向 B 也不改变归属）',
    r.ok === true && r.fact.ownerCharacterId === 'friend_aaa', r.ok ? r.fact.ownerCharacterId : r.reason);
  check('D1b. 沿"最容易冒充 owner 的键"逐个试：createdBy / id 不是"被忽略"，是**整体被拒**',
    AC.planCreate(AUTHOR_A, { level: 'SECRET', text: 'x', createdBy: 'friend_bbb' }).reason === 'caller-supplied-metadata'
    && AC.planCreate(AUTHOR_A, { level: 'SECRET', text: 'x', id: 'friend_bbb' }).reason === 'caller-supplied-metadata');
  const r2 = AC.planCreate(AUTHOR_B, { level: 'SECRET', text: '害怕雷声' });
  check('D2. 同一段正文、不同 writer context ⇒ owner 跟着 context 变（owner 不是内容派生）',
    r2.ok === true && r2.fact.ownerCharacterId === 'friend_bbb');
  check('D3. source 固定为 character_authoring（seam 填，不是调用方选）',
    r.fact.source === 'character_authoring' && AC.WRITER_SOURCE === 'character_authoring');
  check('D4. authority 固定为 human_authoring（seam 填，不是调用方选）',
    r.fact.authority === 'human_authoring' && AC.WRITER_AUTHORITY === 'human_authoring');
  check('D5. 缺失 / 畸形 writer context ⇒ 拒绝（绝不回落到"当前说话人"）',
    AC.planCreate({}, { level: 'SECRET', text: 'x' }).reason === 'no-writer-owner'
    && AC.planCreate(null, { level: 'SECRET', text: 'x' }).reason === 'bad-writer-context'
    && AC.planCreate({ ownerCharacterId: '   ' }, { level: 'SECRET', text: 'x' }).reason === 'no-writer-owner'
    && AC.planCreate({ ownerCharacterId: 'A B' }, { level: 'SECRET', text: 'x' }).reason === 'no-writer-owner');
  /* writer context 里多出来的键**不被读取** —— 不是"忽略"，是代码里没有读取点。 */
  const r3 = AC.planCreate({ ownerCharacterId: 'friend_aaa', source: 'diary', authority: 'derived' },
    { level: 'SECRET', text: 'x' });
  check('D6. writer context 里伪造 source / authority 无效（仍固定为 authored + human）',
    r3.ok === true && r3.fact.source === 'character_authoring' && r3.fact.authority === 'human_authoring');
}

group('E–G. caller 无法伪造 owner / authority / source');
{
  [
    ['E', 'ownerCharacterId', 'friend_bbb'],
    ['F', 'authority', 'human_authoring'],
    ['F2', 'authority', 'derived'],
    ['G', 'source', 'user_authoring'],
    ['G2', 'source', 'diary'],
    ['G3', 'authoredBy', 'someone'],
    ['G4', 'factId', 'forged_id'],
    ['G5', 'createdBy', 'friend_bbb'],
    ['G6', 'updatedAt', 1],
    ['G7', 'isDisclosureFact', true],
    ['G8', 'id', 'forged']
  ].forEach(([tag, key, val]) => {
    const r = AC.planCreate(AUTHOR_A, { level: 'SECRET', text: 'x', [key]: val });
    check(tag + '. ' + key + ' 出现在表单 ⇒ 整体拒绝（caller-supplied-metadata）',
      r.ok === false && r.reason === 'caller-supplied-metadata' && (r.fields || []).indexOf(key) >= 0,
      r.reason + ' ' + JSON.stringify(r.fields || []));
  });
  check('E2. 保留键列表里的每一个键都真的被拦（列表不是装饰）',
    AC.RESERVED_INPUT_KEYS.every((k) => AC.planCreate(AUTHOR_A, { level: 'SECRET', text: 'x', [k]: 1 }).ok === false),
    AC.RESERVED_INPUT_KEYS);
}

group('H. PUBLIC 从这条路径被拒绝（是拒绝，不是降级）');
{
  const r = AC.planCreate(AUTHOR_A, { level: 'PUBLIC', text: 'x' });
  check('H1. PUBLIC ⇒ 拒绝，且拒因**专门指出**原因（public-not-creatable-by-explicit-writer）',
    r.ok === false && r.reason === 'public-not-creatable-by-explicit-writer', r.reason);
  check('H2. 类型层仍允许 PUBLIC（那是边界语义）—— 与写作层禁止并不矛盾',
    DC.isClassified('PUBLIC') === true
    && DC.normalizeDisclosureFact({ ownerCharacterId: 'A', level: 'PUBLIC', text: 'x', source: 'user_authoring' }).level === 'PUBLIC'
    && AC.isAuthoringLevel('PUBLIC') === false);
  check('H3. 畸形 / 缺失 level ⇒ bad-authoring-level（不是被当成 PUBLIC，也不是被当成 SECRET）',
    ['public', 'Secret', '', null, 7, []].every((v) => AC.planCreate(AUTHOR_A, { level: v, text: 'x' }).reason === 'bad-authoring-level'));
  check('H4. PUBLIC 不在可创作档位里', AC.AUTHORING_LEVELS.indexOf('PUBLIC') < 0 && AC.AUTHORING_LEVELS.length === 3);
}

group('P. 畸形输入 fail closed');
{
  check('P1. 正文缺失 / 非字符串 / 全空白 ⇒ 拒绝',
    AC.planCreate(AUTHOR_A, { level: 'SECRET', text: '' }).reason === 'missing-text'
    && AC.planCreate(AUTHOR_A, { level: 'SECRET', text: '   ' }).reason === 'missing-text'
    && AC.planCreate(AUTHOR_A, { level: 'SECRET', text: 123 }).reason === 'missing-text'
    && AC.planCreate(AUTHOR_A, { level: 'SECRET', text: ['x'] }).reason === 'missing-text');
  check('P2. userInput 非对象 ⇒ 拒绝',
    AC.planCreate(AUTHOR_A, null).reason === 'not-an-object' && AC.planCreate(AUTHOR_A, 'x').reason === 'not-an-object');
  check('P3. persona / publicProfile / 共享 thread / 凭据字段 ⇒ 拒绝（硬名单穿过这条路径生效，不是被静默丢弃）',
    ['systemPrompt', 'persona', 'publicProfile', 'memorandum', 'visibleTo', 'excludeFrom', 'apiKey', 'domain']
      .every((k) => AC.planCreate(AUTHOR_A, { level: 'SECRET', text: 'x', [k]: k === 'domain' ? 'SELF_IDENTITY' : 'v' }).reason === 'text-denylisted'));
  check('P3b. 同一批字段出现在 update 的 patch 里同样被拒（不是只有 create 挡）',
    ['persona', 'publicProfile', 'memorandum', 'apiKey']
      .every((k) => AC.planUpdate({ ownerCharacterId: 'friend_aaa', level: 'SECRET', text: 'x', factId: 'f' },
        AUTHOR_A, { text: 'y', [k]: 'v' }).reason === 'text-denylisted'));
  check('P4. 契约面没有 authorize / filter / canDisclose（"未实现" = 找不到函数）',
    typeof AC.authorize === 'undefined' && typeof AC.canDisclose === 'undefined'
    && typeof AC.filterFor === 'undefined' && typeof ST.authorize === 'undefined');
  check('P5. 超长正文被截到 TEXT_MAX（不是拒绝，也不是无限长）',
    (() => { const r = AC.planCreate(AUTHOR_A, { level: 'SECRET', text: 'x'.repeat(5000) }); return r.ok && r.fact.text.length === DC.TEXT_MAX; })());
  check('P6. 控制字符被剥离（正文里不留换行注入）',
    (() => { const r = AC.planCreate(AUTHOR_A, { level: 'SECRET', text: 'a\u0000b\u001bc\r\nd' }); return r.ok && r.fact.text === 'abc\nd'; })());
  check('P7. disclosure-core 缺失 ⇒ 每一个 plan* 都拒绝（fail closed，不是静默放行）',
    (() => {
      /* 用一个把 require('./disclosure-core.js') 换成 null 的沙箱重新加载本模块 ——
         这才是"核心不可用"的真实形态（而不是删掉 window 上的键，那对已绑定的
         工厂期依赖毫无影响，是假的 fail-closed 测试）。 */
      const mod = { exports: {} };
      const ctx = { module: mod, exports: mod.exports, require: () => null, console: console };
      vm.createContext(ctx);
      vm.runInContext(SRC_AC, ctx);
      const iso = mod.exports;
      return iso.planCreate(AUTHOR_A, { level: 'SECRET', text: 'x' }).reason === 'authoring-core-unavailable'
        && iso.planUpdate({ ownerCharacterId: 'A', level: 'SECRET', text: 'x', factId: 'f' }, AUTHOR_A, { text: 'y' }).reason === 'authoring-core-unavailable'
        && iso.planDelete({ ownerCharacterId: 'A', level: 'SECRET', text: 'x', factId: 'f' }, AUTHOR_A).reason === 'authoring-core-unavailable'
        && iso.isAuthoringLevel('SECRET') === false
        && iso.normalizeOwner('A') === '';
    })());
}

/* ══════════════════════════════════════════════════════════════════
   主体（异步：真实 store + 真实 Role DM 路径）
   ══════════════════════════════════════════════════════════════════ */
(async function main() {

group('I–O. canonical store：create / update / delete / 分区');
{
  resetState();
  const cA = await ST.createFact(AUTHOR_A, { level: 'SECRET', text: '阿A的秘密：害怕雷声' });
  check('I. createFact 成功并返回**写进去的**那条（含真实 factId）',
    cA.ok === true && !!cA.fact.factId && cA.fact.factId.indexOf('disc_') === 0, cA.ok ? cA.fact.factId : cA.reason);
  check('I2. 盘上确实有这一条（键就是 factId，不是 id）',
    !!(DB.disclosureFacts || {})[cA.fact.factId] && DB.disclosureFacts[cA.fact.factId].level === 'SECRET');
  check('I3. 9 个 canonical 字段齐全、无多余键',
    DC.FIELD_ORDER.every((k) => Object.prototype.hasOwnProperty.call(cA.fact, k))
    && Object.keys(cA.fact).length === DC.FIELD_ORDER.length, Object.keys(cA.fact));

  const u1 = await ST.updateFact(AUTHOR_A, cA.fact.factId, { text: '改过之后的正文' });
  check('J. update text 成功，factId / owner 不变',
    u1.ok === true && u1.fact.text === '改过之后的正文' && u1.fact.factId === cA.fact.factId && u1.fact.ownerCharacterId === 'friend_aaa');
  const u2 = await ST.updateFact(AUTHOR_A, cA.fact.factId, { level: 'PRIVATE' });
  check('K. update level 成功（SECRET → PRIVATE 是正常编辑）', u2.ok === true && u2.fact.level === 'PRIVATE');
  const u2b = await ST.updateFact(AUTHOR_A, cA.fact.factId, { level: 'PUBLIC' });
  check('K2. update 到 PUBLIC 同样被拒绝（不是只有 create 挡）',
    u2b.ok === false && u2b.reason === 'public-not-creatable-by-explicit-writer');
  const u3 = await ST.updateFact(AUTHOR_A, cA.fact.factId, { subjectCharacterId: 'friend_bbb' });
  check('K3. update subjectCharacterId 允许（它是"关于谁"，不是归属）',
    u3.ok === true && u3.fact.subjectCharacterId === 'friend_bbb' && u3.fact.ownerCharacterId === 'friend_aaa');

  const k1 = await ST.updateFact(AUTHOR_A, cA.fact.factId, { ownerCharacterId: 'friend_bbb' });
  check('L. update owner ⇒ 拒绝（归属不可变；正确做法是删 A 的、建 B 的）',
    k1.ok === false && k1.reason === 'immutable-field' && k1.fields.indexOf('ownerCharacterId') >= 0, k1.reason);
  const l1 = await ST.updateFact(AUTHOR_A, cA.fact.factId, { authority: 'derived' });
  check('M. update authority ⇒ 拒绝', l1.ok === false && l1.reason === 'immutable-field' && l1.fields.indexOf('authority') >= 0);
  const m1 = await ST.updateFact(AUTHOR_A, cA.fact.factId, { source: 'user_authoring' });
  check('M2. update source ⇒ 拒绝', m1.ok === false && m1.reason === 'immutable-field' && m1.fields.indexOf('source') >= 0);
  check('M3. 归属检查先于不可变检查：换一个 owner 去改别人的事实 ⇒ owner-mismatch',
    (await ST.updateFact(AUTHOR_B, cA.fact.factId, { text: 'x' })).reason === 'owner-mismatch');
  check('M4. 盘上那条没有被上面任何一次失败改动 owner / source / authority',
    DB.disclosureFacts[cA.fact.factId].ownerCharacterId === 'friend_aaa'
    && DB.disclosureFacts[cA.fact.factId].source === 'character_authoring'
    && DB.disclosureFacts[cA.fact.factId].authority === 'human_authoring');
  check('M5. 空 patch ⇒ nothing-to-update（不假装保存成功）',
    (await ST.updateFact(AUTHOR_A, cA.fact.factId, {})).reason === 'nothing-to-update');
  check('M6. 改一条不存在的事实 ⇒ not-found',
    (await ST.updateFact(AUTHOR_A, 'disc_nope', { text: 'x' })).reason === 'not-found');

  const cB = await ST.createFact(AUTHOR_B, { level: 'PERSONAL', text: '阿B的个人事实' });
  const listA = await ST.listFacts('friend_aaa');
  const listB = await ST.listFacts('friend_bbb');
  check('O. listFacts(A) 只返回 A 的、listFacts(B) 只返回 B 的（完全分区）',
    listA.ok && listB.ok && listA.facts.length === 1 && listB.facts.length === 1
    && listA.facts[0].ownerCharacterId === 'friend_aaa' && listB.facts[0].ownerCharacterId === 'friend_bbb');
  check('O2. A 的列表里拿不到 B 的正文（分区在 store，不在 UI）',
    JSON.stringify(listA.facts).indexOf('阿B的个人事实') < 0);
  check('O3. 归属不受 subjectCharacterId 影响（A 的事实 subject 指向 B，仍属 A）',
    listA.facts[0].subjectCharacterId === 'friend_bbb' && listA.facts[0].ownerCharacterId === 'friend_aaa');
  check('O4. 无 owner 的 list ⇒ 拒绝，而不是"返回全部"', (await ST.listFacts('')).ok === false);

  const d1 = await ST.deleteFact(AUTHOR_B, cB.fact.factId);
  check('N. 只有 owner 能删自己的事实（B 删 B 成功）', d1.ok === true);
  check('N2. 删掉之后盘上真的没有（物理删除，无 tombstone / 无影子副本）',
    !(DB.disclosureFacts || {})[cB.fact.factId]);
  const cB2 = await ST.createFact(AUTHOR_B, { level: 'SECRET', text: 'B 的第二个秘密' });
  check('N3. 非 owner 删不掉（A 的 context 删 B 的事实 ⇒ owner-mismatch，且行仍在）',
    (await ST.deleteFact(AUTHOR_A, cB2.fact.factId)).reason === 'owner-mismatch'
    && !!(DB.disclosureFacts || {})[cB2.fact.factId]);
  const cfgSnap0 = JSON.stringify(apiConfigs);
  await ST.deleteFact(AUTHOR_B, cB2.fact.factId);
  check('N4. 删除**不写** Memory / persona / publicProfile / relationship（其它 store 一个都不动，角色配置逐字不变）',
    !DB.memories && !DB.understandings && !DB.threads && JSON.stringify(apiConfigs) === cfgSnap0);

  resetState();
  const rt = await ST.createFact(AUTHOR_A, { level: 'PRIVATE', text: '往返事实：凌晨三点写歌' });
  const all = await dbGetAll('disclosureFacts');
  const norm = DC.normalizeDisclosureFact(all[0]);
  check('Q. 持久化往返：读回来的记录归一化后与写进去的逐字段相同',
    !!norm && DC.serialize(norm) === DC.serialize(rt.fact), [DC.serialize(norm), DC.serialize(rt.fact)]);
  check('Q2. 往返是**幂等**的（normalize(normalize(x)) 逐字节相同）',
    DC.serialize(DC.normalizeDisclosureFact(norm)) === DC.serialize(norm));
  check('Q3. 封闭记录：没有 visibility / visibleTo 等 ACL 字段混进来',
    Object.keys(norm).length === DC.FIELD_ORDER.length && !('visibility' in norm) && !('visibleTo' in norm));

  check('P8. store 层畸形输入 fail closed（一条都不落盘）',
    (await ST.createFact(AUTHOR_A, null)).ok === false
    && (await ST.createFact({}, { level: 'SECRET', text: 'x' })).ok === false
    && (await ST.createFact(AUTHOR_A, { level: 'PUBLIC', text: 'x' })).ok === false
    && Object.keys(DB.disclosureFacts || {}).length === 1);
  check('P9. factId 为空的 update / delete ⇒ 拒绝（不静默变成"没找到然后新建"）',
    (await ST.updateFact(AUTHOR_A, '', { text: 'x' })).reason === 'missing-fact-id'
    && (await ST.deleteFact(AUTHOR_A, '')).reason === 'missing-fact-id');
}

group('R–X. 创建 SECRET 之后，模型系统仍然完全看不到它（真实生产路径）');
{
  resetState();
  /* control：先放一条**会进入**模型上下文的公开记忆。没有它，
     "秘密没进去"可能只是因为整条管线根本不工作 —— 那才是假绿。 */
  await dbPut('memories', {
    id: 'mem_public_1', title: '公开备忘', summary: '', content: '昔涟今天在练吉他，很开心。',
    domain: '日常', tags: [], valence: 0.7, arousal: 0.4, importance: 6, resolved: false, pinned: true,
    visibility: 'public', visibleTo: [], excludeFrom: [], activationCount: 0,
    created: Date.now(), lastActivated: Date.now(), createdBy: 'user', kind: 'episodic'
  });
  const memBefore = await getMemoryContextReplica('friend_aaa', {});
  check('R0. control：公开记忆**确实**进入了记忆上下文（管线是活的，本组其余断言才有意义）',
    memBefore.indexOf('练吉他') >= 0, memBefore.slice(0, 140));

  const cfgSnap = JSON.stringify(apiConfigs);
  const memRowsSnap = JSON.stringify(await dbGetAll('memories'));

  /* U 的基线必须在**创建之前**取。两个方向都取 —— A→B 与 B→A 走的是
     两份**不同**的 prompt（speaker 不同、relationship 有向），
     只测一个方向证明不了"另一侧也读不到"。 */
  const threadT = { id: 't1', participants: ['friend_aaa', 'friend_bbb'], threadMemorandum: 'A 和 B 一起写过一首歌。' };
  const callsBefore = CALLS.length;
  const baseAB = await withFrozenClock(() => RD._composeSide('friend_aaa', 'friend_bbb', threadT, { history: [] }));
  const baseBA = await withFrozenClock(() => RD._composeSide('friend_bbb', 'friend_aaa', threadT, { history: [] }));

  const created = await ST.createFact(AUTHOR_A, { level: 'SECRET', text: SECRET_TEXT });
  check('R. 创建 SECRET 不改动任何 legacy Memory 行（memories 逐字节不变）',
    created.ok === true && JSON.stringify(await dbGetAll('memories')) === memRowsSnap);
  check('R2. 创建 SECRET 不改动角色配置（persona / relationship / 其余字段全不变）',
    JSON.stringify(apiConfigs) === cfgSnap);
  check('S. publicProfile 未被创建也未被写入（这条路径不碰公开权威）',
    !Object.prototype.hasOwnProperty.call(apiConfigs[0], 'publicProfile'));
  check('T. persona（systemPrompt）逐字未变', apiConfigs[0].systemPrompt === '你是昔涟，安静而固执。');

  const memAfter = await getMemoryContextReplica('friend_aaa', {});
  check('W. disclosure fact **不进入** Memory context（正文一字不出现在记忆上下文里）',
    memAfter.indexOf('害怕雷声') < 0 && memAfter.indexOf(SECRET_TEXT) < 0);
  check('W2. 记忆上下文在创建前后**逐字节相同**', memAfter === memBefore);
  check('W3. 直接召回 memories 也拿不到它（它根本不在那张表里）',
    (await dbGetAll('memories')).every((m) => String(m.content || '').indexOf('害怕雷声') < 0));
  check('W4. 它躺在**另一个** store（disclosureFacts），键是 factId',
    (await dbGetAll('disclosureFacts')).length === 1 && !!(DB.disclosureFacts[created.fact.factId]));

  check('X. diary / moments / letters / roleLetterMemories / understanding / thread / autoMemory 全部未被写入',
    !DB.diary_entries && !DB.moments && !DB.roleLetters && !DB.roleLetterMemories
    && !DB.understandings && !DB.threads && !DB.autoMemory);

  /* U · composeSide 逐字节不变（真实生产 prompt 装配） */
  const sideAB = await withFrozenClock(() => RD._composeSide('friend_aaa', 'friend_bbb', threadT, { history: [] }));
  const sideBA = await withFrozenClock(() => RD._composeSide('friend_bbb', 'friend_aaa', threadT, { history: [] }));
  check('U. composeSide(A→B) 在创建 SECRET 前后**逐字节相同**',
    JSON.stringify(baseAB) === JSON.stringify(sideAB));
  check('U2. 该 prompt 里也确实不含秘密正文（不是"两次都泄漏、泄漏得一样"）',
    JSON.stringify(sideAB).indexOf('害怕雷声') < 0);
  check('U3. 反向 composeSide(B→A) 同样逐字节不变（两个方向的 prompt 是两份，都要测）',
    JSON.stringify(baseBA) === JSON.stringify(sideBA));
  check('U4. composeSide 自身**不产生**任何模型调用（它是上下文装配，不是执行）',
    CALLS.length === callsBefore, [callsBefore, CALLS.length]);
  check('U5. B→A 方向也不含 A 的秘密（B 看不到 A 的私密事实）',
    JSON.stringify(sideBA).indexOf('害怕雷声') < 0 && JSON.stringify(sideBA).indexOf(SECRET_TEXT) < 0);
}

group('V. 模型调用次数不变（真实 turn，前后各一次，从同一空状态出发）');
{
  resetState();
  const run1 = await RD.start('friend_aaa', 'friend_bbb', { turns: 2 });
  const callCount1 = CALLS.length;
  const texts1 = CALLS.map((c) => JSON.stringify(c.messages));
  check('V0. control：真实 turn 确实调用了模型（次数 > 0）', callCount1 > 0, callCount1);

  resetState();
  await ST.createFact(AUTHOR_A, { level: 'SECRET', text: SECRET_TEXT });
  const run2 = await RD.start('friend_aaa', 'friend_bbb', { turns: 2 });
  const callCount2 = CALLS.length;
  const texts2 = CALLS.map((c) => JSON.stringify(c.messages));

  check('V. 模型调用次数不变（同一起始状态，创建 SECRET 前后各跑一次真实 turn）',
    callCount1 === callCount2 && callCount1 === texts1.length, [callCount1, callCount2]);
  check('V2. 送到 provider 的 messages 里**没有**秘密正文（逐次检查，不只是次数）',
    texts1.every((t) => t.indexOf('害怕雷声') < 0) && texts2.every((t) => t.indexOf('害怕雷声') < 0));
  check('V3. run 的结果形状不受影响（两次都成功走完）',
    !!run1 && run1.ok === true && !!run2 && run2.ok === true, [run1 && run1.reason, run2 && run2.reason]);
  check('V4. 创建事实这件事本身 0 次模型调用（CALLS 只在 turn 里增长，且次数与 messages 条数一致）',
    callCount2 === texts2.length);
}

/* ══════════════════════════════════════════════════════════════════
   MU · mutation sensitivity（证明上面的断言真的有鉴别力）
   ══════════════════════════════════════════════════════════════════ */
group('MU. mutation sensitivity（每个变异都必须让某条断言变红）');
{
  /* MUT-A：owner 从"当前 peer"推断。 */
  const MUT_PEER_OWNER = (writerContext, userInput, currentPeer) =>
    AC.planCreate({ ownerCharacterId: currentPeer }, userInput);
  const pe = MUT_PEER_OWNER(AUTHOR_A, { level: 'SECRET', text: 'x' }, 'friend_bbb');
  check('MUT-A. 「owner 取当前 peer」被 D1/D2 的断言捕获（正常实现取 writer context）',
    pe.ok === true && pe.fact.ownerCharacterId === 'friend_bbb'
    && AC.planCreate(AUTHOR_A, { level: 'SECRET', text: 'x' }).fact.ownerCharacterId === 'friend_aaa');

  /* MUT-B：允许 caller 传 authority。 */
  const MUT_CALLER_AUTHORITY = (ctx, input) => {
    const r = AC.planCreate(ctx, { level: input.level, text: input.text });
    if (!r.ok) return r;
    return { ok: true, fact: Object.assign({}, r.fact, { authority: input.authority || r.fact.authority }) };
  };
  const mb = MUT_CALLER_AUTHORITY(AUTHOR_A, { level: 'SECRET', text: 'x', authority: 'derived' });
  check('MUT-B. 「caller 能传 authority」被 F/F2 的断言捕获（正常实现整体拒绝）',
    mb.ok === true && mb.fact.authority === 'derived'
    && AC.planCreate(AUTHOR_A, { level: 'SECRET', text: 'x', authority: 'derived' }).reason === 'caller-supplied-metadata');

  /* MUT-C：允许从这条路径创建 PUBLIC。 */
  const MUT_ALLOW_PUBLIC = (ctx, input) => {
    if (input.level === 'PUBLIC') {
      const r = DC.normalizeDisclosureFact({ ownerCharacterId: ctx.ownerCharacterId, level: 'PUBLIC', text: input.text, source: 'character_authoring' });
      return r ? { ok: true, fact: r } : { ok: false, reason: 'not-a-canonical-fact' };
    }
    return AC.planCreate(ctx, input);
  };
  const mc = MUT_ALLOW_PUBLIC(AUTHOR_A, { level: 'PUBLIC', text: 'x' });
  check('MUT-C. 「显式 writer 能造 PUBLIC」被 H1/H4 的断言捕获（正常实现拒绝）',
    mc.ok === true && mc.fact.level === 'PUBLIC'
    && AC.planCreate(AUTHOR_A, { level: 'PUBLIC', text: 'x' }).ok === false
    && AC.AUTHORING_LEVELS.indexOf('PUBLIC') < 0);

  /* MUT-D / MUT-E：把秘密同时写进 memories —— 证明 U/W 的断言是有效的，
     它们不是因为"秘密永远进不去"才绿。 */
  resetState();
  const sideClean = await withFrozenClock(() => RD._composeSide('friend_aaa', 'friend_bbb', null, { history: [] }));
  const memClean = await getMemoryContextReplica('friend_aaa', {});
  await dbPut('memories', {
    id: 'mem_leak', title: '泄', content: '变异探针：她害怕雷声。', domain: '日常', tags: [], valence: .5, arousal: .3,
    importance: 9, resolved: false, pinned: true, visibility: 'public', visibleTo: [], excludeFrom: [],
    activationCount: 0, created: Date.now(), lastActivated: Date.now(), createdBy: 'user', kind: 'episodic'
  });
  const sideLeak = await withFrozenClock(() => RD._composeSide('friend_aaa', 'friend_bbb', null, { history: [] }));
  const memLeak = await getMemoryContextReplica('friend_aaa', {});
  check('MUT-D. 「秘密被复制进公开记忆」被 U/W 的断言捕获（它**会**出现在 prompt 与记忆上下文里）',
    JSON.stringify(sideClean).indexOf('害怕雷声') < 0 && JSON.stringify(sideLeak).indexOf('害怕雷声') >= 0
    && memClean.indexOf('害怕雷声') < 0 && memLeak.indexOf('害怕雷声') >= 0);
  check('MUT-D2. 逐字节断言同样会红（clean 与 leak 的 composeSide 不相同）',
    JSON.stringify(sideClean) !== JSON.stringify(sideLeak));

  resetState();
  const fact = await ST.createFact(AUTHOR_A, { level: 'SECRET', text: SECRET_TEXT });
  const memRowsBefore = JSON.stringify(await dbGetAll('memories'));
  await dbPut('memories', { id: 'mem_dup', content: SECRET_TEXT, visibility: 'public', pinned: true, created: Date.now() });
  check('MUT-E. 「事实同时被复制进 memories」被 R/W3 的断言捕获（memories 快照与召回结果都会变）',
    fact.ok === true && memRowsBefore === '[]'
    && JSON.stringify(await dbGetAll('memories')) !== memRowsBefore
    && (await getMemoryContextReplica('friend_aaa', {})).indexOf('害怕雷声') >= 0);
  check('MUT-E2. 正常实现下事实只在 disclosureFacts（memories 为空）',
    Object.keys(DB.disclosureFacts).length === 1 && Object.keys(DB.memories).length === 1
    && Object.keys(DB.memories)[0] === 'mem_dup');
}

/* ══════════════════════════════════════════════════════════════════
   静态结构：把"复刻的读取路径"与"生产代码"焊上
   ══════════════════════════════════════════════════════════════════ */
group('静态结构：谁读得到 disclosure fact（答案：模型侧没有任何一处）');
{
  const consumers = [
    'memory.js', 'active-diary.js', 'moments.js', 'communication.js', 'role-letters.js',
    'role-dm.js', 'role-dm-core.js', 'role-dm-social.js', 'role-dm-social-core.js', 'role-dm-ui.js',
    'middle-brain.js', 'understanding-authority.js', 'agent-runtime.js', 'social.js'
  ];
  const touched = consumers.filter((f) => {
    const s = readSrc('assets/js/' + f);
    return s.indexOf('IBDisclosureStore') >= 0 || s.indexOf('disclosureFacts') >= 0;
  });
  check('Y1. 唯一引用 disclosure store 的是编辑器 UI（social.js）；其余模型侧消费链零引用',
    touched.length === 1 && touched[0] === 'social.js', touched);
  check('Y2. Role DM 全链路（含 core / social / ui）零引用（4B-1 的 J5 冻结面仍在）',
    ['role-dm.js', 'role-dm-core.js', 'role-dm-social.js', 'role-dm-social-core.js', 'role-dm-ui.js']
      .every((f) => { const s = readSrc('assets/js/' + f); return s.indexOf('disclosure') < 0 && s.indexOf('IBDisclosureCore') < 0; }));
  check('Y3. memory.js 的召回读取点仍是 dbGetAll(\'memories\')（复刻的就是生产读取形状）',
    /const all=await dbGetAll\('memories'\);/.test(readSrc('assets/js/memory.js')));
  check('Y4. memory.js 整文件不出现 disclosure store（召回池不可能含披露事实）',
    readSrc('assets/js/memory.js').indexOf('IBDisclosureStore') < 0);
  check('Y5. consolidation 的候选集仍只来自 memories（没有第二来源被接进去）',
    /dbGetAll\('memories'\)/.test(readSrc('assets/js/active-diary.js')));
  check('Y6. 导出 / 镜像 / 文件夹同步的名单**没有**加入 disclosureFacts（明文备份不含秘密）',
    (() => {
      const core = readSrc('assets/js/core.js');
      const exp = core.slice(core.indexOf('async function _ibBuildExportData'), core.indexOf('_ibScrubSecrets'));
      const pri = core.slice(core.indexOf('function _ibMirrorPack'), core.indexOf('async function _ibMirrorNow'));
      /* 导出名单里"disclosureFacts"只允许出现在 DB_VER 注释里，不允许出现在 store 数组里 */
      return exp.indexOf('disclosureFacts') < 0 && pri.indexOf('disclosureFacts') < 0;
    })());
  check('Y7. 唯一真源：store 名只在 store 定义一次，且 core.js 建表名与它一致',
    /STORE_NAME = 'disclosureFacts'/.test(readSrc('assets/js/disclosure-store.js'))
    && /'disclosureFacts'\]/.test(readSrc('assets/js/core.js')));
  check('Y8. store 的 keyPath 是 factId（身份一个真源，不为迁就 keyPath 复制 id）',
    /s==='disclosureFacts'\?'factId':'id'/.test(readSrc('assets/js/core.js')));
  check('Y9. 两个新模块零网络 / 零定时器（按**去掉注释后**的代码判定：注释里提到 localStorage 不算 IO）',
    (() => {
      const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      return !/\bfetch\s*\(|XMLHttpRequest|setTimeout|setInterval/.test(strip(SRC_AC))
        && !/\bfetch\s*\(|XMLHttpRequest|setTimeout|setInterval|localStorage|indexedDB\.open/.test(strip(SRC_ST));
    })());
  check('Y10. authoring-core 不读 trust / relationship / Memory / visibility（没有越权读）',
    (() => {
      const d = SRC_AC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      return !/\btrust\b/.test(d) && !/relationship/i.test(d) && !/\bmemories\b/.test(d) && !/visibleTo/.test(d);
    })());
  check('Y11. HTML 现在**加载**写入路径三层（本轮的目的），且仍在 role-dm.js 之前',
    (() => {
      const html = fs.readdirSync(ROOT).filter((f) => /\.html$/i.test(f)).map((f) => readSrc(f)).join('\n');
      /* 按完整 script 标签定位：说明注释里也会出现这些文件名。 */
      const tag = (n) => '<script src="assets/js/' + n + '"></script>';
      return html.indexOf(tag('disclosure-core.js')) > 0
        && html.indexOf(tag('disclosure-authoring-core.js')) > 0
        && html.indexOf(tag('disclosure-store.js')) > 0
        && html.indexOf(tag('disclosure-core.js')) < html.indexOf(tag('role-dm.js'));
    })());
  /* 私密事实小节的**精确**切片：从它自己的 id 到下一个 api-ed-block（功能设置）。
     用固定字符数截断会溢出到隔壁小节，那里的 style= 会被误算到本次改动头上。 */
  const dscHtmlBlock = (() => {
    const html = readSrc('InternalBeyond.html');
    const a = html.indexOf('id="api-dsc-block"');
    const b = html.indexOf('api-ed-btitle">功能设置');
    return a >= 0 && b > a ? html.slice(a, b) : '';
  })();
  check('Y12. UI 只暴露三档、且不含 PUBLIC / 不含"谁能看到"类控件',
    dscHtmlBlock.length > 0
    && dscHtmlBlock.indexOf('value="PUBLIC"') < 0
    && dscHtmlBlock.indexOf('value="PERSONAL"') >= 0
    && dscHtmlBlock.indexOf('value="PRIVATE"') >= 0
    && dscHtmlBlock.indexOf('value="SECRET"') >= 0
    && !/trust|threshold|谁能看到|visibleTo|excludeFrom/i.test(dscHtmlBlock));
  check('Y13. UI 提交的 writer context 是"正在编辑的角色"，且表单没有 owner 输入框',
    readSrc('assets/js/social.js').indexOf('{ownerCharacterId:owner}') >= 0
    && dscHtmlBlock.indexOf('api-dsc-owner') < 0);
  check('Y14. 新增 UI 没有突破内联样式棘轮（0 个 style= 属性；样式进了既有样式表）',
    (() => {
      const social = readSrc('assets/js/social.js');
      const socialBlock = social.slice(social.indexOf('function _dscStore'), social.indexOf('async function _dscDelete'));
      return dscHtmlBlock.length > 0
        && (dscHtmlBlock.match(/\bstyle\s*=/gi) || []).length === 0
        && (socialBlock.match(/\bstyle\s*=/gi) || []).length === 0
        && /\.api-dsc-card\{/.test(readSrc('assets/css/core/api-components.css'));
    })());
}

console.log('\n' + (failed === 0 ? 'ALL GREEN' : 'FAILED') + ' — passed=' + passed + ' failed=' + failed);
process.exit(failed === 0 ? 0 : 1);

})().catch((e) => { console.error('HARNESS ERROR', e); process.exit(1); });
