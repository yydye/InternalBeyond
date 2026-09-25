/* ====================================================================
   test_disclosure_authorization.js — Phase 4B-2A · Hard Disclosure Authorization Kernel
   --------------------------------------------------------------------
   它证明的是一句可以被证伪的话：

     「对于角色 A 的 fact F，向角色 B 披露**是否被明确授权**，可以由一个
       纯函数给出唯一、有向、可审计的 ALLOW / DENY，且默认拒绝；
       而即使答案是 ALLOW，真实 Role DM 的 prompt **仍然**看不到 F。」

   因此本文件刻意**不是**只测纯函数的单测，它有三段不同性质的证据：

     §I   契约层（A–Z）：授权判定的允许 / 拒绝 / 闭集原因码。纯函数，零 IO。
     §II  结构性（S 组）：去注释/去字符串后的源码里，关系信号零引用、
          零 IO、**不 throw**。
     §III **真实生产路径**（Y 组）+ **子进程对照**（Y5）：加载**真实的**
          role-dm.js 与真实的 disclose store，证明
            · 构造一个 pure-core ALLOW case + 真实 store 里真有一条 SECRET
            · 真实 composeSide(A→B) / (B→A) 仍**逐字节不变**
            · 真实 run/turn 的模型调用次数与逐条 messages **在两个独立进程里
              完全相同**（一个进程里"两次都读同一个模块状态"证明力更弱）
            · 秘密正文不出现在任何模型上下文里
     §IV  mutation sensitivity（MU 组）：把每个变异**真的造出来**，
          再证明正常实现不会走那条路。

   运行：node tests/test_disclosure_authorization.js
   零真实 AI 调用：callApiChat 是记录型替身，从不发网络请求。

   ── 术语（D26 / D31，不得混称）────────────────────────────────────
     HARD DISCLOSURE BOUNDARY = 未授权内容从不进入模型上下文。
     本文件证明的是它的**数据前提**（谁被允许知道）+ 「已授权也还没接上去」。
     它**不**证明 hard boundary 本身 —— 那要等 4B-2B 把门接到模型房间，
     而那件事本轮被明确禁止。
   ==================================================================== */
'use strict';

const path = require('path');
const fs = require('fs');
const vm = require('vm');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const readSrc = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const SRC_PP = readSrc('assets/js/public-profile-core.js');
const SRC_PBC = readSrc('assets/js/prompt-boundary-core.js');
const SRC_DC = readSrc('assets/js/disclosure-core.js');
const SRC_AC = readSrc('assets/js/disclosure-authoring-core.js');
const SRC_ST = readSrc('assets/js/disclosure-store.js');
const SRC_RDC = readSrc('assets/js/role-dm-core.js');
const SRC_RDM = readSrc('assets/js/role-dm.js');
const SRC_AKZ = readSrc('assets/js/disclosure-authorization-core.js');

const DC = require(path.join(ROOT, 'assets/js/disclosure-core.js'));
const AC = require(path.join(ROOT, 'assets/js/disclosure-authoring-core.js'));
const AKZ = require(path.join(ROOT, 'assets/js/disclosure-authorization-core.js'));
const MRC = require(path.join(ROOT, 'assets/js/memory-retrieval-core.js'));
const PBC = require(path.join(ROOT, 'assets/js/prompt-boundary-core.js'));

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('  \u2714 ' + name); }
  else { failed++; console.log('  \u2716 ' + name + (detail !== undefined ? '  ' + JSON.stringify(detail) : '')); }
}
function group(t) { console.log('\n' + t); }

/* ══════════════════════════════════════════════════════════════════
   内存 mock 层（与 tests/test_disclosure_authoring.js 同款形状）
   ══════════════════════════════════════════════════════════════════ */
const DB = {};            /* store -> { key: rec } */
const LS = {};            /* localStorage */
let _seq = 0;

function _storeOf(s) { if (!DB[s]) DB[s] = {}; return DB[s]; }
/* keyPath 与 core.js 的 openDB 一致：categories→name，disclosureFacts→factId，其余→id。 */
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
  { id: 'friend_bbb', nickname: '初音未来', provider: 'qwen', model: 'qwen-plus', endpoint: 'e2', apiKey: 'k2', systemPrompt: '你是初音未来，活泼直接。', relationship: '搭档' },
  { id: 'friend_ccc', nickname: '林昭', provider: 'deepseek', model: 'ds-chat', endpoint: 'e3', apiKey: 'k3', systemPrompt: '你是林昭，克制。', relationship: '同事' }
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
(0, eval)(SRC_AKZ); global.window.IBDisclosureAuthorizationCore = global.IBDisclosureAuthorizationCore;
(0, eval)(SRC_ST);   /* IIFE → window.IBDisclosureStore */
(0, eval)(SRC_RDC); global.window.IBRoleDmCore = global.IBRoleDmCore;
(0, eval)(SRC_RDM);

const ST = global.window.IBDisclosureStore;
const RD = global.window.IB.roleDm;
const AKZ_WIN = global.window.IBDisclosureAuthorizationCore;

const AUTHOR_A = { ownerCharacterId: 'friend_aaa' };
const AUTHOR_B = { ownerCharacterId: 'friend_bbb' };
const A = 'friend_aaa', B = 'friend_bbb', C = 'friend_ccc';
const SECRET_TEXT = '昔涟不愿让任何人知道：她害怕雷声。';

/* ── fixture（**契约层**，不是 production grant writer）──────────────
   ⚠ 这个对象是测试为纯函数构造的输入。生产代码里**没有任何地方**能造出它
     （见 §W：全 assets/js 只有 core 自己提到授予字样，且没有任何 grant 的
     持久化 store）。所以本文件证明的是：

        CONTRACT CAN REPRESENT ALLOW = YES
        PRODUCTION CAN CREATE ALLOW  = NO

   两者在最终报告里必须分开说。 */
function factA(level, text, id) {
  return { factId: id || 'disc_A1', ownerCharacterId: A, level: level, text: text || SECRET_TEXT, source: 'character_authoring', authority: 'human_authoring' };
}
function grantFor(factId, recipient, extra) {
  return Object.assign({
    grantId: 'gr_' + factId + '_' + recipient,
    factId: factId, ownerCharacterId: A, recipientCharacterId: recipient,
    permission: 'disclose', authority: 'human_authoring', authoredBy: 'user',
    levelAtGrant: 'SECRET'
  }, extra || {});
}
const GRANT_AB = grantFor('disc_A1', B);

function resetState() {
  for (const k of Object.keys(DB)) delete DB[k];
  for (const k of Object.keys(LS)) delete LS[k];
  CALLS.length = 0;
}
/* 冻结时钟只包住 composeSide：它的 nowLabel 是分钟粒度。**不**全局冻结。 */
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
   A–D · default deny 的四类畸形输入
   ══════════════════════════════════════════════════════════════════ */
group('A. malformed fact ⇒ DENY（授权不得因为输入畸形而放行）');
{
  const ctx = { recipientCharacterId: B, grants: [GRANT_AB] };
  const cases = [
    ['A1. fact = null', null],
    ['A2. fact = undefined', undefined],
    ['A3. fact = 字符串', 'SECRET: 她害怕雷声'],
    ['A4. fact = 数组', [factA('SECRET')]],
    ['A5. fact = 数字', 42],
    ['A6. fact 无正文', { factId: 'disc_A1', ownerCharacterId: A, level: 'SECRET', text: '', source: 'character_authoring', authority: 'human_authoring' }]
  ];
  cases.forEach(([n, f]) => {
    const r = AKZ.authorize(f, ctx);
    check(n + ' ⇒ DENY invalid-fact', r.allowed === false && r.reasonCode === 'invalid-fact', r);
  });
  check('A7. 畸形 fact **即使有合法 grant** 也拒绝（grant 不能替代 fact 的真实性）',
    AKZ.authorize({ factId: 'disc_A1', level: 'SECRET', text: 'x' }, ctx).reasonCode === 'invalid-fact');
  check('A8. 硬名单字段（systemPrompt / persona / publicProfile / 凭据 / 共享 thread / ACL / 结果键）在授权层同样整体拒绝',
    ['systemPrompt', 'persona', 'publicProfile', 'apiKey', 'endpoint', 'authorization', 'memorandum', 'threadMemorandum', 'isDisclosureFact', 'allowed', 'visibility', 'visibleTo']
      .every((k) => {
        const f = factA('SECRET'); f[k] = 'x';
        return AKZ.authorize(f, ctx).reasonCode === 'invalid-fact';
      }));
  check('A8b. `allowed` / `visibility` 这两个"既是输入又是输出 / 属于 ACL"的键由**授权核心自己的**名单拒掉（core 的名单里没有它们）',
    DC.denylistHits({ allowed: 'x' }).length === 0 && DC.denylistHits({ visibility: 'x' }).length === 0
    && AKZ.authorize(Object.assign(factA('SECRET'), { allowed: true }), ctx).reasonCode === 'invalid-fact'
    && AKZ.authorize(Object.assign(factA('SECRET'), { visibility: 'only' }), ctx).reasonCode === 'invalid-fact');
  check('A9. missing owner ⇒ DENY invalid-fact（owner 不接受从任何其它键推断）',
    ['createdBy', 'visibleTo', 'subjectCharacterId', 'nickname'].every((k) => {
      const f = factA('SECRET'); delete f.ownerCharacterId; f[k] = A;
      return AKZ.authorize(f, ctx).reasonCode === 'invalid-fact';
    }));
  check('A10. missing factId ⇒ DENY invalid-fact（授权对象必须可审计）',
    AKZ.authorize({ ownerCharacterId: A, level: 'SECRET', text: 'x', source: 'character_authoring', authority: 'human_authoring' }, ctx).reasonCode === 'invalid-fact');
}

group('B. missing / malformed recipient ⇒ DENY（永远不能落到某个"默认收件人"）');
{
  const f = factA('SECRET');
  const cases = [
    ['B1. context = null', null],
    ['B2. context = {}（缺 recipient）', {}],
    ['B3. recipient = 空串', { recipientCharacterId: '' }],
    ['B4. recipient = 空白', { recipientCharacterId: '   ' }],
    ['B5. recipient = null / undefined', { recipientCharacterId: null }],
    ['B6. recipient = 含控制字符', { recipientCharacterId: 'friend\u0007bbb' }],
    ['B7. recipient = 超长', { recipientCharacterId: 'x'.repeat(201) }]
  ];
  cases.forEach(([n, ctx]) => {
    const r = AKZ.authorize(f, ctx);
    check(n + ' ⇒ DENY recipient-missing', r.allowed === false && r.reasonCode === 'recipient-missing', r);
  });
  /* ⚠ 这一条原本写的是"非字符串 recipient ⇒ 拒绝"，实测证明那是**错的期望**：
     `42` 被 `String()` 归一成 `'42'`，即一个合法但**绝不匹配任何真实角色 id**
     的收件人 ⇒ 结果是 no-explicit-grant（DENY），而那正是本仓库 id 契约的
     既有行为（disclosure-core §2 的 normalizeId 也是这么做的）。
     把测试改成断言**真正要保护的性质**：类型自由归一，但方向永远是拒绝，
     且归一化**不做模糊匹配**（42 ≠ 'friend_bbb'）。 */
  check('B8. 缺失 / 空白 / 控制字符 / 超长 recipient ⇒ 全部 DENY recipient-missing；' +
    '数字与布尔被 String() 归一成**绝不匹配任何真实角色 id** 的值 ⇒ DENY',
    AKZ.authorize(f, { recipientCharacterId: null }).reasonCode === 'recipient-missing'
    && AKZ.authorize(f, { recipientCharacterId: '   ' }).reasonCode === 'recipient-missing'
    && AKZ.authorize(f, { recipientCharacterId: 'a\u0000b' }).reasonCode === 'recipient-missing'
    && AKZ.authorize(f, { recipientCharacterId: 42, grants: [GRANT_AB] }).reasonCode === 'no-explicit-grant'
    && AKZ.authorize(f, { recipientCharacterId: true, grants: [GRANT_AB] }).reasonCode === 'no-explicit-grant');
  check('B8b. 归一化是 `String()` 语义而不是模糊匹配：数字 42 → `"42"`（永远不匹配 `friend_bbb`），' +
    '而一个有 toString 的对象同样只是被 String()（本仓库既有的 id 契约，不是本模块新发明的）',
    AKZ.authorize(f, { recipientCharacterId: 42, grants: [GRANT_AB] }).recipientCharacterId === '42'
    && AKZ.authorize(f, { recipientCharacterId: 42, grants: [GRANT_AB] }).reasonCode === 'no-explicit-grant'
    && AKZ.authorize(f, { recipientCharacterId: { toString: () => B }, grants: [GRANT_AB] }).allowed === true);
  check('B9. 收件人**绝不**回落到 owner / 当前说话人 / subject / visibleTo',
    AKZ.authorize(f, {}).reasonCode === 'recipient-missing'
    && AKZ.authorize(f, { ownerCharacterId: A, speakerId: A, subjectCharacterId: B }).reasonCode === 'recipient-missing');
  check('B10. recipient === owner ⇒ DENY recipient-is-owner（Role DM 无 self-DM，不发明 A→A 行为）',
    AKZ.authorize(f, { recipientCharacterId: A, grants: [GRANT_AB] }).reasonCode === 'recipient-is-owner');
}

group('C. unknown level ⇒ DENY（未知枚举**绝不**回落成某个真实档位）');
{
  const ctx = { recipientCharacterId: B, grants: [GRANT_AB] };
  const bad = [undefined, null, '', 'secret', 'Secret', ' SECRET', 'SECRET ', 'secret ', 'PRIVAT', 'inner', 0, 3, [], {}, true];
  check('C1. 15 种未知 / 大小写变体 / 非字符串 level 全部 DENY level-unknown',
    bad.every((l) => {
      const f = factA('SECRET'); f.level = l;
      const r = AKZ.authorize(f, ctx);
      return r.allowed === false && r.reasonCode === 'level-unknown';
    }), bad.filter((l) => { const f = factA('SECRET'); f.level = l; return AKZ.authorize(f, ctx).reasonCode !== 'level-unknown'; }));
  check('C2. 未知 level **不是**"默认 PERSONAL"，也不是"默认 PRIVATE"',
    ['PERSONAL', 'PRIVATE'].every((lvl) => {
      const f = factA('SECRET'); f.level = 'nonsense-variant-' + lvl;
      const r = AKZ.authorize(f, ctx);
      return r.reasonCode === 'level-unknown' && r.level === '';
    }));
  check('C3. 授权层**不**自己归一化 level（不给宽松匹配留口子）',
    AKZ.authorize(Object.assign(factA('SECRET'), { level: 'SECRET\t' }), ctx).reasonCode === 'level-unknown');
  check('C4. level 可授权（PUBLIC / UNDETERMINED）与 level 未知是两个不同的原因码',
    AKZ.REASON.LEVEL_UNKNOWN !== AKZ.REASON.LEVEL_NOT_AUTHORIZABLE);
}

group('D. PUBLIC 不可经披露授权放行（公开权威在 publicProfile，不在这里）');
{
  const ctx = { recipientCharacterId: B, grants: [grantFor('disc_A1', B, { levelAtGrant: 'PUBLIC' })] };
  const r = AKZ.authorize(factA('PUBLIC', '她公开说过自己喜欢雨天。'), ctx);
  check('D1. PUBLIC + 合法 grant ⇒ 仍然 DENY level-not-authorizable',
    r.allowed === false && r.reasonCode === 'level-not-authorizable', r);
  check('D2. PUBLIC 不是"不需要授权所以放行"，而是"本契约不是它的权威"',
    AKZ.authorize(factA('PUBLIC'), { recipientCharacterId: B }).reasonCode === 'level-not-authorizable');
  check('D3. 授权层的可放行档位恰好等于 GATED_LEVELS（PERSONAL / PRIVATE / SECRET）',
    DC.GATED_LEVELS.length === 3 && DC.GATED_LEVELS.every((l) => typeof AKZ.authorize === 'function' && l !== 'PUBLIC')
    && !DC.GATED_LEVELS.includes('PUBLIC'));
}

/* ══════════════════════════════════════════════════════════════════
   E–G · 三档 × grant 的完整矩阵
   ══════════════════════════════════════════════════════════════════ */
group('E–G. 等级矩阵（三档 × no grant / explicit grant）');
const MATRIX = {};
{
  ['PERSONAL', 'PRIVATE', 'SECRET'].forEach((lvl) => {
    const f = factA(lvl, '矩阵事实 ' + lvl);
    const noGrant = AKZ.authorize(f, { recipientCharacterId: B });
    const withGrant = AKZ.authorize(f, { recipientCharacterId: B, grants: [grantFor('disc_A1', B, { levelAtGrant: lvl })] });
    MATRIX[lvl] = { noGrant: noGrant.reasonCode, withGrant: withGrant.allowed, grantReason: withGrant.reasonCode };
    check('E/G. ' + lvl + ' + 无 grant ⇒ DENY no-explicit-grant',
      noGrant.allowed === false && noGrant.reasonCode === 'no-explicit-grant', noGrant);
    check('F/G. ' + lvl + ' + 合法 explicit grant ⇒ ALLOW explicit-grant',
      withGrant.allowed === true && withGrant.reasonCode === 'explicit-grant', withGrant);
  });
  check('E1. 三档的【无 grant】行为**完全一致**（都是一个 explicit per-fact grant 才能放行）',
    Object.values(MATRIX).every((m) => m.noGrant === 'no-explicit-grant'));
  check('G1. 三档的【有 grant】行为**完全一致**（没有 permission hierarchy，见 D31）',
    Object.values(MATRIX).every((m) => m.withGrant === true && m.grantReason === 'explicit-grant'));
  check('G2. PERSONAL 的语义：仍需 recipient grant（不是"可以向任意 peer 披露"）',
    MATRIX.PERSONAL.noGrant === 'no-explicit-grant');
  check('G3. PERSONAL != PUBLIC（PERSONAL 是 gated，PUBLIC 不是）',
    DC.isGatedLevel('PERSONAL') === true && DC.isGatedLevel('PUBLIC') === false
    && AKZ.authorize(factA('PERSONAL'), { recipientCharacterId: B }).allowed === false);
}

/* ══════════════════════════════════════════════════════════════════
   H–I · 方向性
   ══════════════════════════════════════════════════════════════════ */
group('H–I. 有向性（A→B 的许可不是 A→C 的，也不是 B→A 的）');
{
  const fA = factA('SECRET');
  const fB = { factId: 'disc_B1', ownerCharacterId: B, level: 'SECRET', text: 'B 的秘密', source: 'character_authoring', authority: 'human_authoring' };
  const gAB = grantFor('disc_A1', B);
  check('H1. grant(A→B) ⇒ A 的 fact 对 B ALLOW',
    AKZ.authorize(fA, { recipientCharacterId: B, grants: [gAB] }).allowed === true);
  check('H2. 同一条 grant **不**授权 A→C ⇒ DENY no-explicit-grant',
    (() => { const r = AKZ.authorize(fA, { recipientCharacterId: C, grants: [gAB] }); return r.allowed === false && r.reasonCode === 'no-explicit-grant'; })());
  check('H3. 同一条 grant **不**授权 B→A ⇒ DENY（recipient 与 owner 都必须对上）',
    (() => { const r = AKZ.authorize(fB, { recipientCharacterId: A, grants: [gAB] }); return r.allowed === false; })());
  check('H4. 反向 grant(A→C) 也不能授权 A→B',
    AKZ.authorize(fA, { recipientCharacterId: B, grants: [grantFor('disc_A1', C)] }).reasonCode === 'no-explicit-grant');
  /* ⚠ H5 原本把一条 `owner=B, recipient=B` 的 grant 传了进去，实测拒因是
     `invalid-grant` 而不是 `no-explicit-grant` —— 因为那条 grant **自己就是畸形**的
     （owner === recipient 被 normalizeGrant 直接拒掉，见 K14）。
     一条畸形 grant 让**整次**判定落 invalid-grant 是设计如此（K20），所以
     这里换成语义正确的输入：一条 owner=B、recipient=C 的**合法** grant，
     去授权 A 的 fact。 */
  check('H5. 一条 owner=B 的合法 grant **不**授权 A 的 fact（owner 是 grant 的一部分）',
    AKZ.authorize(fA, { recipientCharacterId: B, grants: [grantFor('disc_A1', C, { ownerCharacterId: B })] }).reasonCode === 'no-explicit-grant');
  check('H5b. 反过来也一样：A 的 grant 不授权 B 自己的 fact（recipient=B，不是 A）',
    AKZ.authorize({ factId: 'disc_B1', ownerCharacterId: B, level: 'SECRET', text: 'x', source: 'character_authoring', authority: 'human_authoring' },
      { recipientCharacterId: B, grants: [grantFor('disc_B1', A, { ownerCharacterId: A })] }).reasonCode === 'recipient-is-owner');
  /* ⚠ 这一条也被实测纠正过：`grantFor(id, A, {ownerCharacterId: A})` 是
     owner === recipient 的**畸形** grant ⇒ 拒因 invalid-grant（K14/K20）。
     要测"署名不合的 grant 被跳过"，grant 自己必须先合法：改成 owner=A,
     recipient=C。 */
  check('H5b2. 同一情形换个收件人（B 的 fact，收件人 A，grant 却署 owner=A 且发给 C）⇒ DENY no-explicit-grant',
    AKZ.authorize({ factId: 'disc_B1', ownerCharacterId: B, level: 'SECRET', text: 'x', source: 'character_authoring', authority: 'human_authoring' },
      { recipientCharacterId: A, grants: [grantFor('disc_B1', C, { ownerCharacterId: A })] }).reasonCode === 'no-explicit-grant');
  check('H5c. 而 B 的 fact + **B 署名**的合法 grant（factId 对上、recipient=A）⇒ ALLOW —— ' +
    '说明 H5/H5b 拒的是归属不匹配，不是"B 的事实不能被授权"',
    AKZ.authorize({ factId: 'disc_B1', ownerCharacterId: B, level: 'SECRET', text: 'x', source: 'character_authoring', authority: 'human_authoring' },
      { recipientCharacterId: A, grants: [grantFor('disc_B1', A, { ownerCharacterId: B })] }).allowed === true);
  check('H6. **转述**不成立：B 不能把 A 的 fact 转给 C —— 判定输入里根本没有"当前说话人"这个维度',
    AKZ.authorize(fA, { recipientCharacterId: C, grants: [gAB, grantFor('disc_A1', C, { ownerCharacterId: B })] }).reasonCode === 'no-explicit-grant');
  check('H7. 三人矩阵：A→B ALLOW / A→C DENY / B→A DENY（一条断言把整张表钉住）',
    AKZ.authorize(fA, { recipientCharacterId: B, grants: [gAB] }).allowed === true
    && AKZ.authorize(fA, { recipientCharacterId: C, grants: [gAB] }).allowed === false
    && AKZ.authorize(fB, { recipientCharacterId: A, grants: [gAB] }).allowed === false);
  check('I1. 判定签名没有任何对称性维度：形参恰好 3 个（fact / context / 不被读取的 opts），' +
    '传错误的 speaker 字段进去也不改变结果',
    AKZ.authorize.length === 3
    && AKZ.authorize(fA, { recipientCharacterId: B, speakerId: C, fromId: C, grants: [gAB] }).allowed === true
    && JSON.stringify(AKZ.authorize(fA, { recipientCharacterId: B, grants: [gAB] }))
       === JSON.stringify(AKZ.authorize(fA, { recipientCharacterId: B, speakerId: C, fromId: C, toId: C, grants: [gAB] })));
  check('I2. fact 本身带 subjectCharacterId 时**不影响** recipient 判定（subject 不是收件人）',
    AKZ.authorize(Object.assign(factA('SECRET'), { subjectCharacterId: C }), { recipientCharacterId: B, grants: [gAB] }).allowed === true
    && AKZ.authorize(Object.assign(factA('SECRET'), { subjectCharacterId: C }), { recipientCharacterId: C, grants: [gAB] }).allowed === false);
}

/* ══════════════════════════════════════════════════════════════════
   J–L · grant 的形状与绑定
   ══════════════════════════════════════════════════════════════════ */
group('J. grant 必须与 (factId, owner, recipient) 三键同时对上');
{
  const fA = factA('SECRET');
  const ctx = (g) => ({ recipientCharacterId: B, grants: [g] });
  check('J1. factId 不匹配 ⇒ DENY no-explicit-grant',
    AKZ.authorize(fA, ctx(grantFor('disc_OTHER', B))).reasonCode === 'no-explicit-grant');
  check('J2. owner 不匹配（grant 说 A，fact 属 C）⇒ DENY',
    AKZ.authorize({ factId: 'disc_C1', ownerCharacterId: C, level: 'SECRET', text: 'x', source: 'character_authoring', authority: 'human_authoring' },
      ctx(grantFor('disc_C1', B))).reasonCode === 'no-explicit-grant');
  check('J3. recipient 不匹配 ⇒ DENY',
    AKZ.authorize(fA, ctx(grantFor('disc_A1', C))).reasonCode === 'no-explicit-grant');
  check('J4. grant 列表里**别的** fact 的合法 grant 不会误伤本 fact（无关 grant 被跳过，而非报错）',
    AKZ.authorize(fA, { recipientCharacterId: B, grants: [grantFor('disc_OTHER', B), GRANT_AB] }).allowed === true);
  check('J5. 空 grant 列表是**合法**输入，结果是 DENY no-explicit-grant（不是 invalid-grant）',
    (() => { const r = AKZ.authorize(fA, { recipientCharacterId: B, grants: [] }); return r.reasonCode === 'no-explicit-grant'; })());
  check('J6. grants 缺失 === grants 空（都 DENY，且原因相同）',
    AKZ.authorize(fA, { recipientCharacterId: B }).reasonCode === AKZ.authorize(fA, { recipientCharacterId: B, grants: [] }).reasonCode);
  check('J7. 一条 grant 只能授权**一条** fact（不是"授权了这个人"）',
    AKZ.authorize(factA('SECRET', '另一条完全不同的秘密', 'disc_A2'), { recipientCharacterId: B, grants: [GRANT_AB] }).reasonCode === 'no-explicit-grant');
}

group('K. malformed grant ⇒ DENY invalid-grant（**不是**"跳过它"）');
{
  const fA = factA('SECRET');
  const ctx = (g) => ({ recipientCharacterId: B, grants: [g] });
  const bads = [
    ['K1. grant = null', null],
    ['K2. grant = 字符串', 'yes'],
    ['K3. grant = 数组', [GRANT_AB]],
    ['K4. 缺 factId', { ownerCharacterId: A, recipientCharacterId: B, permission: 'disclose', authority: 'human_authoring' }],
    ['K5. 缺 recipientCharacterId', { factId: 'disc_A1', ownerCharacterId: A, permission: 'disclose', authority: 'human_authoring' }],
    ['K6. 缺 ownerCharacterId', { factId: 'disc_A1', recipientCharacterId: B, permission: 'disclose', authority: 'human_authoring' }],
    ['K7. permission 缺失', { factId: 'disc_A1', ownerCharacterId: A, recipientCharacterId: B, authority: 'human_authoring' }],
    ['K8. permission = "deny"（本方案里不存在 deny 状态）', grantFor('disc_A1', B, { permission: 'deny' })],
    ['K9. permission = "allow"（拼错）', grantFor('disc_A1', B, { permission: 'allow' })],
    ['K10. permission = true', grantFor('disc_A1', B, { permission: true })],
    ['K11. authority = derived（模型自己决定"可以告诉她"）', grantFor('disc_A1', B, { authority: 'derived' })],
    ['K12. authority 缺失', (() => { const g = grantFor('disc_A1', B); delete g.authority; return g; })()],
    ['K13. authority = 任意字符串', grantFor('disc_A1', B, { authority: 'trusted' })],
    ['K14. owner === recipient（自授权不是授权）', grantFor('disc_A1', A, { recipientCharacterId: A })],
    ['K15. recipient 含控制字符', grantFor('disc_A1', 'friend\u0000bbb')],
    ['K16. levelAtGrant = 未知档位', grantFor('disc_A1', B, { levelAtGrant: 'ULTRA' })],
    ['K17. grants 不是数组（对象）', { factId: 'disc_A1' }],
    ['K18. grants 不是数组（字符串）', 'disc_A1→friend_bbb'],
    ['K19. levelAtGrant 缺失（许可范围未知 ⇒ fail closed）', (() => { const g = grantFor('disc_A1', B); delete g.levelAtGrant; return g; })()],
    ['K20. 一条畸形混在合法里 ⇒ **整次**判定拒绝，而不是"用那条合法的放行"', null]
  ];
  bads.forEach(([n, g]) => {
    if (g === null && n.startsWith('K1')) { check(n + ' ⇒ DENY invalid-grant', AKZ.authorize(fA, ctx(null)).reasonCode === 'invalid-grant'); return; }
    if (g === null) {
      const r = AKZ.authorize(fA, { recipientCharacterId: B, grants: [GRANT_AB, { factId: 'disc_A1', ownerCharacterId: A, recipientCharacterId: B, permission: 'maybe', authority: 'human_authoring' }] });
      check(n + ' ⇒ DENY invalid-grant', r.allowed === false && r.reasonCode === 'invalid-grant', r);
      return;
    }
    const r = AKZ.authorize(fA, ctx(g));
    check(n + ' ⇒ DENY invalid-grant', r.allowed === false && r.reasonCode === 'invalid-grant', r);
  });
  check('K21. grant 上的硬名单键（visibleTo / visibility / allowed / systemPrompt）同样让 grant 无效',
    ['visibleTo', 'visibility', 'allowed', 'systemPrompt', 'persona', 'apiKey'].every((k) => {
      const g = grantFor('disc_A1', B); g[k] = 'x';
      return AKZ.authorize(fA, ctx(g)).reasonCode === 'invalid-grant';
    }));
  check('K22. normalizeGrant / isValidGrant 与 authorize 使用**同一条**判定（不是两份实现）',
    AKZ.normalizeGrant(GRANT_AB) !== null && AKZ.isValidGrant(GRANT_AB) === true
    && AKZ.normalizeGrant(grantFor('disc_A1', B, { permission: 'deny' })) === null
    && AKZ.isValidGrant(null) === false);
  check('K23. 归一化后的 grant 是封闭记录（没有未知字段往返）',
    JSON.stringify(Object.keys(AKZ.normalizeGrant(GRANT_AB)).sort()) ===
    JSON.stringify(['authoredBy', 'authority', 'factId', 'grantId', 'levelAtGrant', 'ownerCharacterId', 'permission', 'recipientCharacterId', 'updatedAt']));
}

group('L. grant 生命周期：删除 / 文本 / level 提升 / subject 变更');
{
  const fA = factA('SECRET');
  check('L1. fact 删除后授权**不可再成立**：kernel 的主语是 fact，没有 fact 就没有判定对象',
    AKZ.authorize(null, { recipientCharacterId: B, grants: [GRANT_AB] }).allowed === false);
  check('L2. 正文修改**不**使 grant 失效：授权绑定 factId，不绑定内容（同一条事实）',
    AKZ.authorize(factA('SECRET', '改过的正文', 'disc_A1'), { recipientCharacterId: B, grants: [GRANT_AB] }).allowed === true);
  check('L3. level 提升（PRIVATE → SECRET）后旧 grant **不静默续期** ⇒ DENY grant-level-stale',
    (() => {
      const f = factA('SECRET');
      const r = AKZ.authorize(f, { recipientCharacterId: B, grants: [grantFor('disc_A1', B, { levelAtGrant: 'PRIVATE' })] });
      return r.allowed === false && r.reasonCode === 'grant-level-stale';
    })());
  check('L4. level **降低**（SECRET → PRIVATE）后旧 grant 仍然覆盖（许可范围更宽，覆盖得住）',
    AKZ.authorize(factA('PRIVATE'), { recipientCharacterId: B, grants: [grantFor('disc_A1', B, { levelAtGrant: 'SECRET' })] }).allowed === true);
  check('L5. level 未变（同档）⇒ grant 有效',
    AKZ.authorize(fA, { recipientCharacterId: B, grants: [grantFor('disc_A1', B, { levelAtGrant: 'SECRET' })] }).allowed === true);
  check('L6. 陈旧 grant **不会**因为旁边还有一条新的而被忽略 —— 它是被覆盖而不是被跳过',
    AKZ.authorize(fA, { recipientCharacterId: B, grants: [grantFor('disc_A1', B, { levelAtGrant: 'PRIVATE' }), grantFor('disc_A1', B, { levelAtGrant: 'SECRET' })] }).allowed === true
    && AKZ.authorize(fA, { recipientCharacterId: B, grants: [grantFor('disc_A1', B, { levelAtGrant: 'PRIVATE' }), grantFor('disc_A1', B, { levelAtGrant: 'PRIVATE' })] }).reasonCode === 'grant-level-stale');
  check('L7. factId 稳定 ⇒ factId 变了就是**另一条**事实，旧 grant 不跟随',
    AKZ.authorize(factA('SECRET', SECRET_TEXT, 'disc_A_NEW'), { recipientCharacterId: B, grants: [GRANT_AB] }).reasonCode === 'no-explicit-grant');
  check('L8. subjectCharacterId 变更**不**改变 recipient 判定（subject 不是收件人，见 I2）',
    AKZ.authorize(Object.assign(factA('SECRET'), { subjectCharacterId: B }), { recipientCharacterId: B, grants: [GRANT_AB] }).allowed === true);
  /* ⚠ L9 原本写的是 `reasonCode === 'no-explicit-grant'`，实测**证伪**了：
     owner 一旦变成 B 而 recipient 也是 B，`recipient-is-owner` 会**先**触发。
     这不是缺陷 —— 两个原因都指 DENY，而且各自都对：一条 owner=B 的 fact，
     从 B 的角度看它本来就是"自己的东西"（不是披露），从 A 的角度看它与 A 的
     grant 无关。所以断言改成**枚举两个合法拒因**，并另附一条把
     "两种 recipient 都不是 ALLOW"钉死。 */
  check('L9. owner 不可变：owner 变了就是另一条事实，A 的 grant 一条都不匹配',
    AKZ.authorize({ factId: 'disc_A1', ownerCharacterId: B, level: 'SECRET', text: 'x', source: 'character_authoring', authority: 'human_authoring' },
      { recipientCharacterId: B, grants: [GRANT_AB] }).reasonCode === 'recipient-is-owner');
  check('L9b. owner=B 的那条 fact 无论发给 B 还是发给 A 都不是 ALLOW（两种拒因各自成立）',
    (() => {
      const f = { factId: 'disc_A1', ownerCharacterId: B, level: 'SECRET', text: 'x', source: 'character_authoring', authority: 'human_authoring' };
      const toB = AKZ.authorize(f, { recipientCharacterId: B, grants: [GRANT_AB] });
      const toA = AKZ.authorize(f, { recipientCharacterId: A, grants: [GRANT_AB] });
      return toB.allowed === false && toB.reasonCode === 'recipient-is-owner'
        && toA.allowed === false && toA.reasonCode === 'no-explicit-grant';
    })());
}

/* ══════════════════════════════════════════════════════════════════
   M–R · 关系分数 / Memory ACL / 写者权威都**不是**授权权威
   ══════════════════════════════════════════════════════════════════ */
group('M–O. trust / familiarity / affinity 无法授权');
{
  const fA = factA('SECRET');
  const mk = (extra) => Object.assign({ recipientCharacterId: B }, extra);
  check('M1. trust = 1.0（最高）⇒ DENY',
    AKZ.authorize(fA, mk({ trust: 1 })).reasonCode === 'no-explicit-grant');
  check('M2. trust 以任意形状出现（对象 / 关系记录 / 嵌套）⇒ 都不影响判定',
    AKZ.authorize(fA, mk({ trust: 0.99 })).allowed === false
    && AKZ.authorize(fA, mk({ relation: { fromId: A, toId: B, trust: 1, familiarity: 1, affinity: 1 } })).allowed === false
    && AKZ.authorize(fA, mk({ relationship: '挚友', relationshipScore: 999 })).allowed === false);
  check('M3. fact 上挂 trust 也不会改变判定（关系信号不是授权维度，且不是被读取的键）',
    AKZ.authorize(Object.assign(factA('SECRET'), { trust: 1, familiarity: 1, affinity: 1 }), mk({})).allowed === false);
  check('N1. familiarity = 1.0（"我们很熟"）⇒ DENY',
    AKZ.authorize(fA, mk({ familiarity: 1 })).reasonCode === 'no-explicit-grant');
  check('N2. dmCount 很高 / 聊过很多轮 ⇒ DENY',
    AKZ.authorize(fA, mk({ dmCount: 10000, lastDmAt: Date.now() })).reasonCode === 'no-explicit-grant');
  check('O1. affinity = 1.0 ⇒ DENY',
    AKZ.authorize(fA, mk({ affinity: 1 })).reasonCode === 'no-explicit-grant');
  check('O2. 三个分数**同时**拉满 + 自主 intent 分数拉满 ⇒ 仍然 DENY',
    AKZ.authorize(fA, mk({ trust: 1, familiarity: 1, affinity: 1, intentScore: 1, initiative: 1, toneCounts: { warm: 99 } })).reasonCode === 'no-explicit-grant');
  check('O3. 把整套关系记录原样传进来（role-dm-core 的真实形状）⇒ 依然 DENY',
    AKZ.authorize(fA, mk({ relation: { id: 'rel_A_B', relationKey: A + '\u0001' + B, fromId: A, toId: B, kind: 'role_to_role', trust: 1, familiarity: 1, affinity: 1, dmCount: 500, observations: [], updatedAt: Date.now() } })).reasonCode === 'no-explicit-grant');
}

group('P. Memory ACL 无法授权（visibility / visibleTo / excludeFrom / createdBy）');
{
  const fA = factA('SECRET');
  const memRow = { id: 'mem_1', content: SECRET_TEXT, visibility: 'only', visibleTo: [B], excludeFrom: [], createdBy: A, importance: 9 };
  check('P1. 一条 `visibility:\'only\', visibleTo:[B]` 的 Memory 行 ⇒ DENY invalid-fact（ACL 不是授权）',
    AKZ.authorize(memRow, { recipientCharacterId: B }).reasonCode === 'invalid-fact');
  check('P2. visibility:\'public\' 也不行（ACL 值不参与判定，且带 ACL 键即整体拒绝）',
    AKZ.authorize(Object.assign({}, memRow, { visibility: 'public', visibleTo: [] }), { recipientCharacterId: B }).reasonCode === 'invalid-fact');
  check('P3. 一条 canonical fact **额外**带上 visibleTo ⇒ 整体拒绝（而不是"额外字段不影响"）',
    AKZ.authorize(Object.assign(factA('SECRET'), { visibleTo: [B] }), { recipientCharacterId: B, grants: [GRANT_AB] }).reasonCode === 'invalid-fact');
  check('P4. 决定"谁可以读"的 ACL 值**不在**授权核心读取的键里（读到与否都不改变判定方向）',
    AKZ.authorize(fA, { recipientCharacterId: B, grants: [GRANT_AB], visibility: 'private', visibleTo: [A] }).allowed === true
    && AKZ.authorize(fA, { recipientCharacterId: B, grants: [GRANT_AB], visibility: 'public' }).allowed === true);
  check('P5. createdBy = 收件人 不产生任何授权',
    AKZ.authorize(fA, { recipientCharacterId: B, createdBy: B }).reasonCode === 'no-explicit-grant');
}

group('Q–R. provenance / writer authority **不是** recipient authorization');
{
  const ctx = { recipientCharacterId: B };
  /* ⚠ 这一组有三条期望被**实测证伪**过，值得逐条写下来 —— 它们是本文件里
     最容易被写错、也最容易"绿得没有内容"的三条：

       ① Q1 原本写 `source: 'human_authoring'`。但 `human_authoring` **不是**
          一个 source —— 它是 authority 的值（D29 的两个维度）。给定一个不在
          封闭 source 枚举里的字符串，core 归一成 `unknown`（fail closed），
          于是拒因是 `level-not-authorizable` 而不是 `no-explicit-grant`。
          断言照样"通过"（都是 DENY），但它测的东西完全不是它声称测的东西。

       ② R1–R3 原本写"只给 authority / 只给 authoredBy"。实测拒因是
          `invalid-fact`：**只给 authority 不给 source 是一个结构性不成立的
          输入** —— core 的通道⇔权威交叉校验（D29 §4）不允许它，这与"写者权威
          能不能授权"毫无关系。要测那个性质，必须给一条**完全合法**的事实，
          然后证明它**在缺少 grant 时**照样被拒；再给同一条事实配上合法 grant，
          证明它**在有权时**就被放行。两条合起来才说明"provenance 没有参与决定"。

       ③ R5/R6 原本想在 derived fact 上证明"授权维度与写者维度正交"，即
          "只要有 grant 就能放行"。**这是错的**：`derived` 的上限是 PUBLIC，
          而 PUBLIC 不可经本契约放行（§D）。所以一条 derived fact **永远**
          不可能被 ALLOW —— 这不是缺陷，而是两个维度各自独立生效的结果。
          R5 因此改成断言那个真正成立的正交性：**grant 的 authority 必须是人**，
          而 **fact 的 authority 与"谁签的 grant"无关**。

     Q 组的判据因此是两条一起看：`no-explicit-grant` **且** 配上 grant 后变 ALLOW。 */
  const variants = [
    ['Q1. source = user_authoring', { source: 'user_authoring' }, 'no-explicit-grant'],
    ['Q2. source = character_authoring', { source: 'character_authoring' }, 'no-explicit-grant'],
    ['Q3. source = user_correction', { source: 'user_correction' }, 'no-explicit-grant'],
    ['R1. source + authority = human_authoring', { source: 'character_authoring', authority: 'human_authoring' }, 'no-explicit-grant'],
    ['R2. source + authority = human_confirmation', { source: 'character_authoring', authority: 'human_confirmation' }, 'no-explicit-grant'],
    ['R3. source + authority + authoredBy = user（三者齐全）', { source: 'character_authoring', authority: 'human_authoring', authoredBy: 'user' }, 'no-explicit-grant'],
    /* 不合法 / 非人类 provenance：事实仍然被好好归一化，但等级被 authority
       上限压到 PUBLIC ⇒ 拒因是"等级不可授权"。两种输入都不能换取任何访问。 */
    ['Q4. source = human_authoring（**不是**合法 source，见上）', { source: 'human_authoring' }, 'level-not-authorizable'],
    ['Q5. source = generated_inference', { source: 'generated_inference' }, 'level-not-authorizable'],
    ['R4. authority = human_authoring 但**不给** source（结构性不成立的输入）', { authority: 'human_authoring' }, 'invalid-fact'],
    ['R5. 只给 authoredBy = user（同上）', { authoredBy: 'user' }, 'invalid-fact'],
    /* R6 原本也被放进这张表，但它**不属于**"结构性不成立"：`authority:'derived'`
       配缺失的 source（→ unknown）是**自洽**的，只是等级被压到 PUBLIC。
       归到 R9 那一条去测它的真实语义。 */
    ['R6. authority = human_confirmation 但**不给** source（同上）', { authority: 'human_confirmation' }, 'invalid-fact']
  ];
  variants.forEach(([n, extra, expected]) => {
    const f = Object.assign({ factId: 'disc_A1', ownerCharacterId: A, level: 'SECRET', text: SECRET_TEXT }, extra);
    const r = AKZ.authorize(f, ctx);
    check(n + ' ⇒ DENY ' + expected + '（写者维度回答"谁负责"，不是"谁能知道"）',
      r.allowed === false && r.reasonCode === expected, r);
  });
  /* Q 组的两条合起来才说明"provenance 没有参与决定"：缺 grant 时被拒
     （上面那一组），**配上**一条合法 grant 就被放行（这里）。 */
  const qCtx = { recipientCharacterId: B, grants: [GRANT_AB] };
  check('Q1b/Q2b/Q3b. 同样三条 provenance 变体，配上合法 grant 后**全部** ALLOW —— ' +
    '证明 Q 组拒的是"缺 grant"，不是 provenance 本身',
    ['user_authoring', 'character_authoring', 'user_correction'].every((s) =>
      AKZ.authorize({ factId: 'disc_A1', ownerCharacterId: A, level: 'SECRET', text: SECRET_TEXT, source: s }, qCtx).allowed === true));
  check('R7. 一条**完美的人类授权事实**（source + authority + authoredBy 齐全）**配上** grant 就 ALLOW —— ' +
    '所以上一条的 DENY 确实来自"没有 grant"这唯一原因（这正是本阶段的核心断言）',
    AKZ.authorize({ factId: 'disc_A1', ownerCharacterId: A, level: 'SECRET', text: SECRET_TEXT, source: 'character_authoring', authority: 'human_authoring', authoredBy: 'user' }, ctx).reasonCode === 'no-explicit-grant'
    && AKZ.authorize({ factId: 'disc_A1', ownerCharacterId: A, level: 'SECRET', text: SECRET_TEXT, source: 'character_authoring', authority: 'human_authoring', authoredBy: 'user' }, qCtx).allowed === true);
  check('R8. 两个维度**各自独立**：grant 的 authority 必须是人类（derived grant ⇒ invalid-grant），' +
    '而 fact 的 authority 与"谁签的 grant"无关（人类 gated fact + 人类 grant ⇒ ALLOW）',
    AKZ.authorize(factA('SECRET'), { recipientCharacterId: B, grants: [grantFor('disc_A1', B, { authority: 'derived' })] }).reasonCode === 'invalid-grant'
    && AKZ.authorize(factA('SECRET'), { recipientCharacterId: B, grants: [grantFor('disc_A1', B)] }).allowed === true);
  check('R9. 一条 derived fact 拿**任何** grant 都换不到放行：它连 SECRET 都持不住（上限 PUBLIC），' +
    '而 PUBLIC 不可经本契约授权 —— 这是两个维度各自独立生效的**结果**，不是缺陷' +
    '（注意结果里的 level 是空的：不可授权时连"这条事实是什么等级"都不回传）',
    (() => {
      const df = { factId: 'disc_A1', ownerCharacterId: A, level: 'SECRET', text: 'x', source: 'role_dm_conversation', authority: 'derived' };
      return AKZ.authorize(df, { recipientCharacterId: B }).reasonCode === 'level-not-authorizable'
        && AKZ.authorize(df, { recipientCharacterId: B, grants: [grantFor('disc_A1', B)] }).reasonCode === 'level-not-authorizable'
        && AKZ.authorize(df, { recipientCharacterId: B, grants: [grantFor('disc_A1', B, { levelAtGrant: 'PUBLIC' })] }).reasonCode === 'level-not-authorizable'
        && AKZ.authorize(df, { recipientCharacterId: B, grants: [grantFor('disc_A1', B)] }).level === ''
        && DC.normalizeDisclosureFact(df).level === 'PUBLIC';
    })());
}

/* ══════════════════════════════════════════════════════════════════
   S · 结构性 + 绝不 throw
   ══════════════════════════════════════════════════════════════════ */
group('S. 结构性（关系信号零引用 / 零 IO / 不 throw / 结果键闭集）');
{
  /* 去注释/去字符串后再断言。**字符串也要去掉** —— 本模块导出表里有
     NON_AUTHORITY_SIGNALS（那是"明确声明不用"的名单），把它算进去会让
     断言永远为假，而"永远失败的断言"和"永远通过的断言"一样没有鉴别力。 */
  const code = SRC_AKZ
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""');
  check('S1. **零引用**关系信号：trust / affinity / familiarity / dmCount / relationship / toneCounts / initiative / intent',
    !/\btrust\b/i.test(code) && !/\baffinity\b/i.test(code) && !/\bfamiliarity\b/i.test(code)
    && !/\bdmCount\b/.test(code) && !/\brelationship\b/i.test(code) && !/\btoneCounts\b/.test(code)
    && !/\binitiative\b/i.test(code) && !/\bintent\b/i.test(code));
  check('S2. 零引用 memorandum / 消息历史 / Memory store',
    !/memorandum/i.test(code) && !/\bmemories\b/.test(code) && !/chatMessages/.test(code)
    && !/threadHistory|recentHistory|messages\b/.test(code));
  check('S3. 零引用 persona / publicProfile / systemPrompt / 凭据（授权核心不碰身份与系统域）',
    !/\bpersona\b/i.test(code) && !/publicProfile/.test(code) && !/systemPrompt/.test(code)
    && !/apiKey|endpoint|cookie/i.test(code));
  check('S4. 零 IO / 零定时器 / 零网络 / 零 DOM / 零 window',
    !/\bfetch\s*\(/.test(code) && !/indexedDB/i.test(code) && !/localStorage/.test(code)
    && !/XMLHttpRequest/.test(code) && !/setTimeout|setInterval/.test(code)
    && !/\bwindow\s*[.[]/.test(code) && !/\bdocument\s*[.[]/.test(code));
  check('S5. 运行时**不**读 Date.now()（判定必须可复现；grant 时间戳缺失落 0 而不是"现在"）',
    !/Date\.now/.test(code));
  check('S6. 全文件不含 throw（授权不得靠异常表达，"catch 后当 allow"是本轮明令禁止的形状）',
    !/\bthrow\b/.test(code) && !/\bnew Error\b/.test(code));

  /* 绝不 throw 的**行为**证明：拿一堆恶意 / 畸形输入轰它。 */
  const hostile = [
    null, undefined, 0, '', 'x', [], [{}], true, NaN, Infinity,
    { get ownerCharacterId() { throw new Error('boom'); } },
    { factId: 'disc_A1', ownerCharacterId: A, level: 'SECRET', text: 'x', get source() { throw new Error('boom'); } }
  ];
  let threw = null;
  let denied = 0;
  hostile.forEach((h) => {
    try {
      const r1 = AKZ.authorize(h, { recipientCharacterId: B });
      const r2 = AKZ.authorize(factA('SECRET'), h);
      const r3 = AKZ.describeDecision(h);
      if (r1.allowed === false) denied++;
      if (r2.allowed === false) denied++;
      if (r3.allowed === false) denied++;
    } catch (e) { if (threw === null) threw = String(e && e.message); }
  });
  check('S7. 12 个敌意输入 × 3 个入口：**一个异常都没有**，且每一条都落在 DENY',
    threw === null && denied >= 33, { threw: threw, denied: denied });
  /* ⚠ S8 抓到过一个**真实缺口**（不是测试写错）：disclosure-core 的归一化会
     **读取**输入字段，所以一个带 getter 的对象可以让它抛 —— 而"本模块从不
     throw"是写在契约里的性质。修法是在**边界**上把 core 的异常变成一条明确
     的拒绝（`SAFE_DC`），而不是改冻结面、也不是把这个断言删掉。
     这就是"先写断言、再让实现达标"与"改测试迁就实现"的区别。 */
  check('S8. 带 getter 的**敌意对象**（访问即抛）同样安全：core 的异常在边界上被转成拒绝，而不是逃出去',
    (() => {
      const hostile = [
        { get ownerCharacterId() { throw new Error('boom'); } },
        { factId: 'disc_A1', ownerCharacterId: A, level: 'SECRET', text: 'x', get source() { throw new Error('boom'); } },
        { factId: 'disc_A1', ownerCharacterId: A, get level() { throw new Error('boom'); }, text: 'x', source: 'character_authoring', authority: 'human_authoring' },
        { factId: 'disc_A1', ownerCharacterId: A, level: 'SECRET', text: 'x', source: 'character_authoring', get authority() { throw new Error('boom'); } }
      ];
      return hostile.every((h) => {
        try { return AKZ.authorize(h, { recipientCharacterId: B }).allowed === false; } catch (e) { return false; }
      });
    })());
  check('S8b. 敌意 grant（访问即抛）同样只产生 DENY',
    (() => {
      const hostileGrant = { get factId() { throw new Error('boom'); } };
      try {
        const r = AKZ.authorize(factA('SECRET'), { recipientCharacterId: B, grants: [hostileGrant] });
        return r.allowed === false && (r.reasonCode === 'invalid-grant' || r.reasonCode === 'invalid-fact');
      } catch (e) { return false; }
    })());
  check('S9. 依赖缺失（core = null）时**每一条**都 DENY，且不会因为取不到 core 而抛',
    (() => {
      const sandbox = { module: { exports: {} } };
      sandbox.module.exports = null;
      const src = SRC_AKZ.replace("require('./disclosure-core.js')", 'null');
      const fn = new Function('module', 'exports', src + '\nreturn module.exports;');
      const m = { exports: {} };
      fn(m, m.exports);
      const AK0 = m.exports;
      const f = factA('SECRET');
      const ctx = { recipientCharacterId: B, grants: [GRANT_AB] };
      return AK0.authorize(f, ctx).allowed === false
        && AK0.authorize(f, ctx).reasonCode === 'authorization-core-unavailable'
        && AK0.normalizeGrant(GRANT_AB) === null
        && AK0.isValidGrant(GRANT_AB) === false
        && AK0.isAllowed(f, ctx) === false;
    })());
  check('S10. 授权核心**不**读 authoring-core（判定不需要"谁在编辑哪个角色"这件事）',
    (code.match(/require\(/g) || []).length === 1
    && !/IBDisclosureAuthoringCore/.test(SRC_AKZ)
    /* 文件头提到过 authoring-core 的名字（用来说明"它不读它"），
       所以这里只在**代码**上断言：去注释后一个字样都没有。 */
    && !/authoring/i.test(code));

  /* 结果键闭集 + 原因码闭集。 */
  const allowRes = AKZ.authorize(factA('SECRET'), { recipientCharacterId: B, grants: [GRANT_AB] });
  const denyRes = AKZ.authorize(factA('SECRET'), { recipientCharacterId: B });
  check('S11. ALLOW 结果的键**恰好**是闭集，没有多余字段',
    JSON.stringify(Object.keys(allowRes).sort()) === JSON.stringify(AKZ.resultKeys().slice().sort()), Object.keys(allowRes));
  check('S12. DENY 结果同样闭集',
    Object.keys(denyRes).every((k) => AKZ.resultKeys().indexOf(k) >= 0), Object.keys(denyRes));
  check('S13. reasonCode **闭集**：授权返回的每一个原因都在 REASONS 里，且 REASONS 无重复',
    AKZ.REASONS.length === new Set(AKZ.REASONS).size
    && [allowRes, denyRes].every((r) => AKZ.REASONS.indexOf(r.reasonCode) >= 0));
  check('S14. 只有**一个**原因能产生 ALLOW（ALLOW_REASONS === [explicit-grant]）',
    AKZ.ALLOW_REASONS.length === 1 && AKZ.ALLOW_REASONS[0] === 'explicit-grant'
    && AKZ.REASONS.filter((r) => AKZ.ALLOW_REASONS.indexOf(r) >= 0).length === 1);
  check('S15. 原因码里**没有**任何内容是数据（不含 factId / owner / recipient / 分数）',
    AKZ.REASONS.every((r) => /^[a-z][a-z0-9-]*$/.test(r) && r.indexOf(A) < 0 && r.indexOf('friend_') < 0));
}

group('T. 判定结果里没有事实正文（ALLOW 与 DENY 两个方向）');
{
  const allowRes = AKZ.authorize(factA('SECRET'), { recipientCharacterId: B, grants: [GRANT_AB] });
  const denyRes = AKZ.authorize(factA('SECRET'), { recipientCharacterId: B });
  const describeAllow = AKZ.describeDecision(allowRes);
  const describeDeny = AKZ.describeDecision(denyRes);
  check('T1. ALLOW 结果里没有正文（逐字 + 序列化两条）',
    JSON.stringify(allowRes).indexOf('害怕雷声') < 0 && allowRes.text === undefined && JSON.stringify(allowRes).indexOf(SECRET_TEXT) < 0);
  check('T2. DENY 结果里没有正文',
    JSON.stringify(denyRes).indexOf('害怕雷声') < 0 && denyRes.text === undefined && JSON.stringify(denyRes).indexOf(SECRET_TEXT) < 0);
  check('T3. describeDecision 也不含正文，且它只输出**闭集**键',
    JSON.stringify(describeAllow).indexOf('害怕雷声') < 0
    && JSON.stringify(Object.keys(describeAllow).sort()) === JSON.stringify(AKZ.resultKeys().slice().sort()));
  check('T4. describeDecision 只透传闭集内的合法值（伪造的 reasonCode / level 被清空，不原样转发）',
    AKZ.describeDecision({ allowed: true, reasonCode: 'i-made-this-up', level: 'ULTRA', factId: 'disc_A1', ownerCharacterId: A, recipientCharacterId: B }).reasonCode === ''
    && AKZ.describeDecision({ allowed: true, reasonCode: 'i-made-this-up', level: 'ULTRA' }).level === '');
  check('T5. describeDecision 从不把 allowed 升级：非布尔 true 不算允许',
    AKZ.describeDecision({ allowed: 'yes', reasonCode: 'explicit-grant' }).allowed === false
    && AKZ.describeDecision(null).allowed === false);
  check('T6. 本模块**不新增任何运行时 trace**（源码里没有 trace / console / 日志出口）',
    !/\btrace\b/i.test(SRC_AKZ.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')) && !/console\./.test(SRC_AKZ));
  check('T7. 事实内容相关的键一个都不在结果键里',
    ['text', 'prompt', 'persona', 'systemPrompt', 'memorandum', 'apiKey', 'authorization', 'endpoint', 'trust', 'familiarity']
      .every((k) => AKZ.resultKeys().indexOf(k) < 0));
}

/* ══════════════════════════════════════════════════════════════════
   U–V · 幂等 / 确定性 / 无副作用
   ══════════════════════════════════════════════════════════════════ */
group('U. 确定性与幂等（同一个输入永远同一个输出）');
{
  const f = factA('SECRET');
  const ctx = { recipientCharacterId: B, grants: [GRANT_AB] };
  const a = JSON.stringify(AKZ.authorize(f, ctx));
  const b = JSON.stringify(AKZ.authorize(f, ctx));
  check('U1. 同一输入调用 100 次结果**逐字节相同**',
    (() => { for (let i = 0; i < 100; i++) { if (JSON.stringify(AKZ.authorize(f, ctx)) !== a) return false; } return a === b; })());
  check('U2. 输入对象**未被修改**（判定是纯函数，不写调用方的数据）',
    JSON.stringify(f) === JSON.stringify(factA('SECRET')) && JSON.stringify(ctx.grants[0]) === JSON.stringify(GRANT_AB));
  check('U3. grant 顺序不影响结果（同一条 grant 位置的置换）',
    JSON.stringify(AKZ.authorize(f, { recipientCharacterId: B, grants: [grantFor('disc_X', B), GRANT_AB] }))
    === JSON.stringify(AKZ.authorize(f, { recipientCharacterId: B, grants: [GRANT_AB, grantFor('disc_X', B)] })));
  check('U4. 判定**不产生**任何 DB / localStorage 写入（零副作用）',
    Object.keys(DB).length === 0 && Object.keys(LS).length === 0, [Object.keys(DB), Object.keys(LS)]);
  check('U5. 判定**不产生**任何模型调用', CALLS.length === 0, CALLS.length);
  check('U6. 判定不看时间：同一 fact 在真实的 10ms 之后仍是同一个结果（没有隐式过期）',
    (() => { const before = JSON.stringify(AKZ.authorize(f, ctx)); const t0 = Date.now(); while (Date.now() - t0 < 10) { /* spin */ } return JSON.stringify(AKZ.authorize(f, ctx)) === before; })());
}

/* ══════════════════════════════════════════════════════════════════
   V · 生产现实：grant 从哪来
   ══════════════════════════════════════════════════════════════════ */
group('V. PRODUCTION GRANT WRITER = 0（契约能表达 ALLOW，生产造不出 ALLOW）');
{
  const jsFiles = fs.readdirSync(path.join(ROOT, 'assets', 'js')).filter((f) => /\.js$/.test(f));
  const grantMentions = jsFiles.filter((f) => {
    const s = readSrc(path.join('assets', 'js', f));
    return /recipientCharacterId|normalizeGrant|IBDisclosureAuthorizationCore/.test(s);
  });
  check('V1. 全 assets/js 里提到 recipient / grant 的**只有**授权核心自己',
    grantMentions.length === 1 && grantMentions[0] === 'disclosure-authorization-core.js', grantMentions);
  check('V2. 授权核心**不读盘**：源码里没有任何 store 出口（dbPut / dbGetAll / indexedDB / localStorage）',
    (SRC_AKZ.replace(/\/\*[\s\S]*?\*\//g, '').match(/indexedDB|localStorage|dbPut|dbGetAll|dbGet\b|dbDelete/g) || []).length === 0);
  check('V2b. 没有任何 store 持久化 grant：core.js 的 store 名单里没有 grants 表',
    !/grants/i.test(readSrc('assets/js/core.js')) && !/grant/i.test(readSrc('assets/js/disclosure-store.js')));
  check('V3. 没有任何 UI 能创建 grant（social.js / role-dm-ui.js / 任何 html 都不提授权核心）',
    !/IBDisclosureAuthorizationCore/.test(readSrc('assets/js/social.js'))
    && !/IBDisclosureAuthorizationCore/.test(readSrc('assets/js/role-dm-ui.js'))
    && fs.readdirSync(ROOT).filter((f) => /\.html$/i.test(f)).every((f) => !/IBDisclosureAuthorizationCore/.test(readSrc(f))));
  check('V4. ⇒ 因此本文件里可以 ALLOW 的**唯一**原因，是测试为纯函数构造的 fixture（如实报告，不假装功能已上线）',
    AKZ.authorize(factA('SECRET'), { recipientCharacterId: B, grants: [GRANT_AB] }).allowed === true
    && !/friend_bbb/.test(SRC_AKZ));
}

/* ══════════════════════════════════════════════════════════════════
   W · 授权与消费分离（结构性）
   ══════════════════════════════════════════════════════════════════ */
group('W. AUTHORIZATION EXISTS / CONSUMPTION DOES NOT（结构性断言）');
{
  const consumers = ['memory.js', 'active-diary.js', 'moments.js', 'communication.js', 'role-letters.js',
    'role-dm.js', 'role-dm-core.js', 'role-dm-social.js', 'role-dm-social-core.js', 'role-dm-ui.js',
    'middle-brain.js', 'agent-runtime.js', 'understanding-authority.js', 'disclosure-store.js'];
  check('W1. 全部模型上下文消费链**零引用**授权核心',
    consumers.every((f) => readSrc(path.join('assets', 'js', f)).indexOf('IBDisclosureAuthorizationCore') < 0
      && !/disclosureAuthorization|authorizeDisclosure/.test(readSrc(path.join('assets', 'js', f)))));
  check('W2. 授权核心自己**不**引用 disclosure-store（判定不读盘：把 gate 与 storage 分开）',
    !/IBDisclosureStore|disclosure-store/.test(SRC_AKZ));
  check('W3. 授权核心里没有 filter / select / pick / apply 之类的**消费**函数（"挑出能说的几条"是 prompt 装配）',
    typeof AKZ.filter !== 'function' && typeof AKZ.filterFor !== 'function'
    && typeof AKZ.selectDisclosable !== 'function' && typeof AKZ.apply !== 'function'
    && typeof AKZ.buildPrivateFactsBlock !== 'function');
  check('W4. disclosure-core 仍然没有 authorize / filter / canDisclose（4B-1 的冻结面未动）',
    typeof DC.authorize !== 'function' && typeof DC.filter !== 'function' && typeof DC.canDisclose !== 'function');
  check('W5. disclosure-core 与 authoring-core **一个字节都没改**：两者都不含 `recipient` / `grant` 这个词' +
    '（disclosure-core 里的 `granted` 是 4B-1 冻结的局部变量名，与 grant 无关 —— 因此判据是词边界）',
    !/\brecipient\b|\bgrant\b/i.test(readSrc('assets/js/disclosure-core.js'))
    && !/\brecipient\b|\bgrant\b/i.test(readSrc('assets/js/disclosure-authoring-core.js'))
    && /\bgranted\b/.test(readSrc('assets/js/disclosure-core.js')));
  /* ⚠ W5b 原本是一条 blanket 的「git diff 为空」冻结断言：它保护的是
     「这六个文件在本轮**一个字节都没变**」。那条断言在 P23 落地后变红，
     而它红的原因与它声称的目的（disclosure authorization 的行为不得变化）
     毫无关系 —— P23 只往 social.js 里加了 Voice API Source 的 UI/取数代码。
     更糟的是它对**真正的**变化是盲的：它只比较文件名与整体 diff 文本，
     一个把 `no-explicit-grant` 改成 `explicit-grant` 的改动只要不新增文件，
     就照样"逐字节证明"通过。

     现在的判据分三层，每一层都是可证伪的**语义**性质：

       W5b  这六个冻结文件里，**没有任何内容被修改或删除**。唯一允许的变化是
            social.js 上"落在 Voice 区段内的**新增行**"；而新增行一旦带上
            凭据承载键（apiKey= / client_secret= / Bearer <token> / sk-…）
            立刻失败 —— 这一条正是"公开披露边界不得被旁路"的静态那一半。
            任何**修改**行、任何区段外的新增、任何新文件都照旧失败。
       W5c  授权判定的**行为指纹**：三档（PERSONAL/PRIVATE/SECRET），
            "无 grant ⇒ DENY no-explicit-grant / 有 grant ⇒ ALLOW explicit-grant"
            的矩阵、方向性、未知档位、公开档位、缺收件人、畸形 fact 的拒因
            必须逐条不变。
       W5d  结果键闭集 / 原因码闭集 / 只能有一个原因产生 ALLOW / 可授权档位闭集。

     三者合起来才是"authorization 不绕过、secret 不泄漏、disclosure rules 不变"：
     W5b 挡住"偷偷改文件"，W5c/W5d 挡住"改了但看起来没改"。 */
  const DISCLOSURE_FROZEN_SITES = [
    'assets/js/disclosure-core.js',
    'assets/js/disclosure-authoring-core.js',
    'assets/js/role-dm.js',
    'assets/js/role-dm-core.js',
    'assets/js/disclosure-store.js',
    'assets/js/social.js'
  ];
  /* 本轮**唯一**允许存在差异的冻结文件，以及允许差异的**位置**边界。
     social.js 的三个 Voice 区段（全部是"新增行"的落点，而且都**只**是 Voice 面）：
       ① Voice API Source 目录 + provider 下拉 + 能力字段 + 音色选项 + 音色 id 存取
          （含 P23 新加的 Voicebox Profile 读取与页内缓存）；
       ② testCharacterVoice（试听时必须带上同一个 canonical source 引用）；
       ③ saveCurrentApi 里保存 voice.source 的那几行（角色记录里**只**存引用，
          绝不出现 credential；这一点由凭据承载键判据独立挡住）。
     再加 NS.expose('social', {…}) 这个既有导出面上的一行新增。区段之外、
     以及所有其它五个冻结文件，一律必须逐字节未变。 */
  const SOCIAL_VOICE_REGION = { from: '/* Voice API Source 目录', until: 'function _voiceGetId(' };
  const SOCIAL_TRIAL_REGION = { from: 'async function testCharacterVoice(', until: 'source:(function(){var _d=_voiceCatalogOf' };
  const SOCIAL_SAVE_REGION = { from: '/* P23 Phase 1 · canonical Voice API Source 引用', until: 'voiceId:_voiceGetId(),' };
  const SOCIAL_EXPORT_REGION = { from: "NS.expose('social', {", until: '});' };
  /* ④ loadApiSettingsUI 里**那一次** Voice 目录拉取。区段收在包含它的那一行很短的一段里，
     不是"整个 loadApiSettingsUI 随你加" —— 那个函数是 API 设置页的总入口。 */
  const SOCIAL_LOAD_REGION = { from: 'loadVoiceSourceCatalog();', until: 'loadMemorySettingsUI();' };
  const CONTENT_CHANGE_RE = /^(?![-+]{3} )[-+]/;           /* 真正的增删行（排除 --- / +++ 文件头） */
  const DELETION_RE = /^-(?!-{2} )/;                       /* 真正的删除行（排除 --- 文件头） */
  const CREDENTIAL_KEY_RE = /(?:apiKey|api_key|apikey|client_secret|access_token|refresh_token|Authorization)\s*[:=]|Bearer\s+[A-Za-z0-9._\-]{8,}|\bsk-[A-Za-z0-9_\-]{12,}/;

  /* ── 冻结面的唯一判据：一个**纯函数**，W5b 打真实 diff，W5b2 打合成 diff ──
     每个文件四条规则，全部必须成立才算通过：
       ① 新增行必须落在该文件的豁免区段内（social.js 四个 Voice 区段；其余五个
          冻结文件**没有**任何豁免 → 任何新增都违规）。
       ② 新增行不得携带凭据承载键（apiKey= / client_secret= / Bearer <token> / sk-…）——
          这正是"公开披露边界不被旁路"的静态那一半。
       ③ **只有删除、没有新增**的 hunk 视为"内容被拿走" → 违规；有新增的删除行算
          "改写"。这就是"改一行"与"删一行"的分界线，也是它挡住"偷偷把一条拒绝
          改成放行"的地方（后者是纯删除，或删掉旧行换成别的东西 —— 前者在这里失败，
          后者会落在①/②之外的位置上失败）。
       ④ 新增行的落位必须与工作区文件逐字一致（防"diff 与工作区不是同一份内容"）。 */
  function judgeFrozenDiff(diffText, opts) {
    const o = opts || {};
    /* 行尾统一按 `\n` 归一：工作区在 Windows 上可能是 CRLF，而 diff 的 `+` 行文本
       来自 git（按仓库内容）。不归一的话，行号会**整体错位**，那正是这条判据最
       容易变成假红的地方 —— 而假红的下场是被删掉。 */
    const normalize = (s) => String(s === null || s === undefined ? '' : s).replace(/\r\n/g, '\n');
    const textOf = (rel) => normalize(o.textOf ? o.textOf(rel) : null) || null;
    const result = { files: 0, additions: 0, rewritten: 0, outside: 0, credentialHits: 0, removed: 0, drift: 0, problems: [] };
    const hunksByFile = new Map();
    let cur = null, file = '';
    for (const raw of String(diffText).split(/\r?\n/)) {
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(raw);
      if (m) {
        file = m[2].replace(/\\/g, '/');
        result.files++;
        if (!hunksByFile.has(file)) hunksByFile.set(file, []);
        cur = null;
        continue;
      }
      if (/^\+\+\+ b\//.test(raw) || /^--- a\//.test(raw)) continue;
      const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
      if (h) {
        cur = { oldStart: Number(h[1]), newStart: Number(h[2]), lines: [] };
        if (file) hunksByFile.get(file).push(cur);
        continue;
      }
      if (!cur || !CONTENT_CHANGE_RE.test(raw)) continue;
      cur.lines.push(!DELETION_RE.test(raw)
        ? { sign: '+', text: raw.slice(1).replace(/\r$/, '') }
        : { sign: '-', text: raw.slice(1).replace(/\r$/, '') });
    }
    for (const [rel, hunks] of hunksByFile) {
      /* 删除行的判据不是"这个字符串在文件里别处还有"，而是**同一 hunk 里有一条
         新增行把旧行整行包含进去** —— 也就是"这一行被改写了"，不是"这一行被拿走了"。
         用 diff 重建文本会把行号对不齐、制造幽灵删除；用"全局 indexOf"又太松
         （把代码复制一份到别处、再删掉原处，也能骗过去）。逐 hunk 配对既准又严。 */
      /* 每个文件的判据有四条，全部必须成立：
         ① **新增行**必须落在该文件的豁免区段内（social.js 的四个 Voice 区段；
            其余五个文件**没有**任何豁免 → 任何新增都是违规）。
         ② 新增行不得携带凭据承载键（apiKey= / client_secret= / Bearer <token> / sk-…）。
         ③ **只有删除、没有新增**的 hunk 视为"内容被拿走" → 违规
            （"把一条拒绝删掉"正是这种形状）。
         ④ 新增行的落位必须与工作区文件逐字一致（防"diff 与工作区不是同一份内容"）。 */
      const rawNew = textOf(rel);
      if (!rawNew) {
        result.removed++;
        if (result.problems.length < 6) result.problems.push('无法读取该文件的新文本，无法证明旧行仍存在: ' + rel);
        continue;
      }
      const newText = rawNew;
      const newLines = newText.split('\n');
      for (const h of hunks) {
        const added = h.lines.filter(x => x.sign === '+').map(x => x.text);
        let n = h.newStart;
        for (const l of h.lines) {
          if (l.sign === '+') {
            result.additions++;
            if (CREDENTIAL_KEY_RE.test(l.text)) {
              result.credentialHits++;
              if (result.problems.length < 6) result.problems.push('凭据承载键: ' + rel + ':' + n + ' :: ' + l.text.trim().slice(0, 90));
            }
            const exempt = (o.regions && o.regions[rel]) || [];
            const inside = exempt.some(r => r.start > 0 && r.end > 0 && n >= r.start && n <= r.end);            if (!inside) {
              result.outside++;
              if (result.problems.length < 6) result.problems.push('区段外新增: ' + rel + ':' + n + ' :: ' + l.text.trim().slice(0, 90));
            }
            /* 落位也必须与真实文件一致（防"diff 与工作区不是同一份内容"的静默漂移） */
            if (newLines[n - 1] !== l.text) {
              result.drift++;
              if (result.problems.length < 6) result.problems.push('diff 与工作区不一致: ' + rel + ':' + n);
            }
            n++;
          } else {
            /* 删除行：**同一 hunk 里必须有新增行**才算"这一行被改写"（P23 正是这种形状：
               TTS 目录那几行各加了 source/credential 字段、`_voiceCatalogOf` 多了几行
               回落、`_voiceSyncProviderOptions` 换成签名式幂等键）。若某个 hunk **只有
               删除、没有任何新增**，那就是"内容被拿走" —— 例如把一条 `return DENY`
               删掉，必须失败。
               ⚠ 这里刻意**不**要求"旧行逐字被新行包含"：真实改写（同一行里换掉几个词）
               本来就不满足包含关系，要求它会制造假红；位置与凭据由上面两条独立把关。 */
            if (added.length > 0) result.rewritten++;
            else {
              result.removed++;
              if (result.problems.length < 6) result.problems.push('内容被删除（该 hunk 只有删除、没有任何新增）: ' + rel + ' :: ' + l.text.trim().slice(0, 90));
            }
          }
        }
      }
    }
    result.ok = result.files >= 1 && result.outside === 0 && result.credentialHits === 0
      && result.removed === 0 && result.drift === 0;
    return result;
  }

  /* W5b · 真实冻结面：打真实 git diff */
  const FROZEN_REGIONS = {
    'assets/js/social.js': [SOCIAL_VOICE_REGION, SOCIAL_TRIAL_REGION, SOCIAL_SAVE_REGION, SOCIAL_LOAD_REGION, SOCIAL_EXPORT_REGION]
  };
  const socialLines = readSrc('assets/js/social.js').replace(/\r\n/g, '\n').split('\n');
  const frozenRegions = {};
  const unresolvedRegions = [];
  for (const rel of Object.keys(FROZEN_REGIONS)) {
    const srcLines = rel === 'assets/js/social.js' ? socialLines : readSrc(rel).replace(/\r\n/g, '\n').split('\n');
    frozenRegions[rel] = FROZEN_REGIONS[rel].map((r) => {
      const a = srcLines.findIndex(l => l.indexOf(r.from) >= 0) + 1;
      const b = srcLines.findIndex((l, i) => i >= a - 1 && l.indexOf(r.until) >= 0) + 1;
      /* 单行区段（`from` 与 `until` 落在同一行，例如 loadApiSettingsUI 里那一次调用）
         也合法：a === b。算不出来的区段一律记为未解析（宁可失败，也不放宽）。 */
      if (a < 1 || b < a) unresolvedRegions.push(rel + ' :: ' + r.from + ' → ' + r.until);
      return { start: a, end: b >= a ? b : -1 };
    });
  }
  const showGit = (rel) => {
    try { return execFileSync('git', ['show', 'HEAD:' + rel], { cwd: ROOT, encoding: 'utf8' }); }
    catch (e) { return null; }
  };
  /* 工作区文本（行尾归一 → `\n`）。冻结面的判据全部跑在它上面。 */
  const worktreeText = (rel) => String(readSrc(rel)).replace(/\r\n/g, '\n');
  {
    let diffText = null, gitErr = null;
    try {
      diffText = execFileSync('git', ['diff', '--unified=0', 'HEAD', '--', ...DISCLOSURE_FROZEN_SITES], { cwd: ROOT, encoding: 'utf8' });
    } catch (e) { gitErr = String(e.message || e).slice(0, 120); }
    const verdict = diffText === null ? null : judgeFrozenDiff(diffText, { regions: frozenRegions, textOf: worktreeText });
    check('W5b.frozenSurfaceIsUnchangedOrAdditiveVoiceOnly：六个冻结文件对 HEAD 的差异只允许' +
      '「social.js 五个 Voice 区段（含那一次目录拉取）内的**新增**」与「同 hunk 内有新增伴随的改写」；' +
      '纯删除、区段外的新增、以及任何凭据承载键都失败',
      !!verdict && verdict.ok && unresolvedRegions.length === 0,
      gitErr || (verdict ? Object.assign({}, verdict, { regions: frozenRegions, unresolved: unresolvedRegions }) : 'no diff'));
  }

  /* W5b2 · 反向回归：把上一条判据本身造出"放行"与"拦下"各一次。
     如果哪天有人把它放宽成"任何修改都允许"，这里会立刻变红。 */
  {
    const src = readSrc('assets/js/social.js');
    const srcLines = src.split('\n');
    const inRegion = srcLines.findIndex(l => l.indexOf('var _ibVoiceSourceCache=null;') >= 0) + 1;
    const mk = (rel, line, sign, text) => ['diff --git a/' + rel + ' b/' + rel, '--- a/' + rel, '+++ b/' + rel,
      '@@ -0,0 +' + line + ' @@', sign + text].join('\n');
    const J = (t) => judgeFrozenDiff(t, { regions: frozenRegions, textOf: (rel) => (rel === 'assets/js/social.js' ? src : worktreeText(rel)) });
    const A_ok = J(mk('assets/js/social.js', inRegion, '+', 'var _ibVoiceSourceCache=null;')).ok;
    const B_outside = J(mk('assets/js/social.js', 1, '+', 'var _x=1;')).outside;
    const C_cred = J(mk('assets/js/social.js', inRegion, '+', "  source:'tts', apiKey:(p&&p.value)||''")).credentialHits;
    const D_otherFile = J(mk('assets/js/middle-brain-policy.js', 1, '+', 'var x=1;')).outside;
    /* E · P23 真正做过的那一次改写（TTS 目录行：行内插入 source/credential 两个字段）
       必须被当作**改写**放行 —— 而它不是"旧行是新行的子串"，这正是本判据刻意不要求
       包含关系的原因（要求它会制造假红）。 */
    const oldCatalog = (showGit('assets/js/social.js') || '').split('\n').filter(l => l.indexOf("label:'Edge TTS (free)'") >= 0)[0] || '';
    const newCatalog = srcLines.filter(l => l.indexOf("label:'Edge TTS (free)'") >= 0)[0] || '';
    const eLine = srcLines.indexOf(newCatalog) + 1;
    const eHunk = ['diff --git a/assets/js/social.js b/assets/js/social.js', '--- a/assets/js/social.js', '+++ b/assets/js/social.js',
      '@@ -115,2 +' + eLine + ',2 @@', '-' + oldCatalog, '+' + newCatalog, ' '].join('\n');
    const E_rewrite = oldCatalog.length > 0 && newCatalog.length > 0
      ? judgeFrozenDiff(eHunk, { regions: frozenRegions, textOf: (rel) => (rel === 'assets/js/social.js' ? src : worktreeText(rel)) })
      : null;
    /* F · 真正的删除（旧行在新文本里不存在）必须拦下 */
    const F_removed = judgeFrozenDiff(mk('assets/js/social.js', inRegion, '-', 'if(!_ibVoiceSourceCache)return null;'),
      { regions: frozenRegions, textOf: (rel) => (rel === 'assets/js/social.js' ? src : worktreeText(rel)) }).removed;
    /* G · 把一行真实代码"复制到别处 + 删掉原处"必须拦下（复制品不能替代被删掉的那一行） */
    const G_copy = judgeFrozenDiff([
      'diff --git a/assets/js/social.js b/assets/js/social.js', '--- a/assets/js/social.js', '+++ b/assets/js/social.js',
      '@@ -122 +122 @@', '-  if(!_ibVoiceSourceCache)return null;',
      '@@ -125,0 +126 @@', '+  if(!_ibVoiceSourceCache)return null;'
    ].join('\n'), { regions: frozenRegions, textOf: (rel) => (rel === 'assets/js/social.js' ? src : worktreeText(rel)) }).removed;
    check('W5b2.regression：区段内新增放行；区段外新增 / 凭据键新增 / 其它文件新增 / 真删除 / ' +
      '"复制到别处再删原处"全部拦下；而 P23 真实做过的那次行内改写必须放行',
      A_ok === true && B_outside === 1 && C_cred === 1 && D_otherFile === 1 && F_removed === 1 && G_copy === 1
      && !!E_rewrite && E_rewrite.ok === true && E_rewrite.additions === 1 && E_rewrite.rewritten === 1,
      { A_ok: A_ok, B: B_outside, C: C_cred, D: D_otherFile, E: E_rewrite, F: F_removed, G: G_copy,
        inRegion: inRegion, regions: frozenRegions });
  }

  /* W5c · 行为指纹：三档 × (无 grant / 有 grant) + 方向性 + 两类畸形输入。
     判据是**逐条拒因/结果**，不是"看起来还行"：改一个分支、把某个拒绝放宽成
     ALLOW、或让未知档位回落到某个真实档位，都会在这里留下痕迹。 */
  {
    const FP_FACT = (lvl) => ({ factId: 'disc_A1', ownerCharacterId: A, level: lvl, text: 'x', source: 'character_authoring', authority: 'human_authoring' });
    const FP_GRANT = (lvl) => grantFor('disc_A1', B, { levelAtGrant: lvl });
    const vector = [];
    for (const lvl of ['PERSONAL', 'PRIVATE', 'SECRET', 'PUBLIC', 'nonsense']) {
      vector.push(lvl + '|no-grant|' + AKZ.authorize(FP_FACT(lvl), { recipientCharacterId: B }).reasonCode);
      vector.push(lvl + '|grant|' + AKZ.authorize(FP_FACT(lvl), { recipientCharacterId: B, grants: [FP_GRANT(lvl)] }).reasonCode);
    }
    vector.push('to-c|' + AKZ.authorize(FP_FACT('SECRET'), { recipientCharacterId: C, grants: [FP_GRANT('SECRET')] }).reasonCode);
    vector.push('to-owner|' + AKZ.authorize(FP_FACT('SECRET'), { recipientCharacterId: A, grants: [FP_GRANT('SECRET')] }).reasonCode);
    vector.push('recipient-missing|' + AKZ.authorize(FP_FACT('SECRET'), {}).reasonCode);
    vector.push('null-fact|' + AKZ.authorize(null, { recipientCharacterId: B }).reasonCode);
    const EXPECTED = [
      'PERSONAL|no-grant|no-explicit-grant', 'PERSONAL|grant|explicit-grant',
      'PRIVATE|no-grant|no-explicit-grant', 'PRIVATE|grant|explicit-grant',
      'SECRET|no-grant|no-explicit-grant', 'SECRET|grant|explicit-grant',
      'PUBLIC|no-grant|level-not-authorizable', 'PUBLIC|grant|level-not-authorizable',
      'nonsense|no-grant|level-unknown', 'nonsense|grant|level-unknown',
      'to-c|no-explicit-grant', 'to-owner|recipient-is-owner',
      'recipient-missing|recipient-missing', 'null-fact|invalid-fact'
    ];
    const diff = vector.filter((v, i) => v !== EXPECTED[i]);
    check('W5c.authorizationBehaviourFingerprintUnchanged：14 条固定向量（三档 × 无/有 grant + 方向性 + ' +
      '未知档位 + 公开档位 + 缺收件人 + 畸形 fact）的拒因/放行逐条不变',
      vector.length === EXPECTED.length && diff.length === 0, { diff: diff, actual: vector });
  }

  /* W5d · 契约闭集不变（只读面，与行为指纹分开：一个测"怎么判"，一个测"能判出什么"） */
  check('W5d.decisionContractClosedSetsUnchanged：结果键 / 原因码 / ALLOW 原因 / 可授权档位四个闭集逐字不变，' +
    '且**只有一个**原因能产生 ALLOW',
    JSON.stringify(AKZ.resultKeys().slice().sort()) === JSON.stringify(['allowed', 'factId', 'level', 'ownerCharacterId', 'reasonCode', 'recipientCharacterId'])
    && JSON.stringify(AKZ.REASONS) === JSON.stringify(['explicit-grant', 'authorization-core-unavailable', 'invalid-fact', 'recipient-missing',
      'recipient-is-owner', 'level-unknown', 'level-not-authorizable', 'invalid-grant', 'grant-level-stale', 'no-explicit-grant'])
    && JSON.stringify(AKZ.ALLOW_REASONS) === JSON.stringify(['explicit-grant'])
    && AKZ.REASONS.filter((r) => AKZ.ALLOW_REASONS.indexOf(r) >= 0).length === 1
    && JSON.stringify(DC.GATED_LEVELS) === JSON.stringify(['PERSONAL', 'PRIVATE', 'SECRET']),
    { resultKeys: AKZ.resultKeys(), reasons: AKZ.REASONS, allow: AKZ.ALLOW_REASONS, gated: DC.GATED_LEVELS });

  /* W5e · P23 改动面的**行为无关性**：那 106 行新增里不许出现授权/披露/人设/记忆面的
     任何标识符。这条与 W5b 的位置豁免互为补充 —— W5b 管"改在哪里"，这条管"改的是什么"。 */
  {
    const src = readSrc('assets/js/social.js').split('\n');
    const start = src.findIndex(l => l.indexOf(SOCIAL_VOICE_REGION.from) >= 0);
    const end = src.findIndex((l, i) => i > start && l.indexOf(SOCIAL_VOICE_REGION.until) >= 0);
    const added = start >= 0 && end > start ? src.slice(start, end + 1).join('\n') : '';
    const forbidden = ['IBDisclosureAuthorizationCore', 'disclosureAuthorization', 'authorizeDisclosure',
      'normalizeGrant', 'recipientCharacterId', 'IBDisclosureCore', 'IBDisclosureStore',
      'roleDm', 'memorandum', 'systemPrompt', 'publicProfile'];
    const hits = forbidden.filter((k) => added.indexOf(k) >= 0);
    check('W5e.voiceIncrementTouchesNoAuthorizationSurface：P23 新增的 Voice 区段里没有任何授权 / 披露 / ' +
      '人设 / Role DM 标识符（它结构上改不到判定）',
      hits.length === 0 && added.indexOf('loadVoiceSourceCatalog') >= 0, { hits: hits, regionChars: added.length });
  }

  check('W6. Role DM 全链路仍不含 disclosure 字样（4B-1 冻结的 J5 未被本轮破坏）',
    [readSrc('assets/js/role-dm.js'), readSrc('assets/js/role-dm-core.js'),
      readSrc('assets/js/role-dm-social.js'), readSrc('assets/js/role-dm-social-core.js')]
      .every((s) => !/disclosure/i.test(s)));
  check('W7. HTML 加载授权核心，且顺序在 disclosure-core 之后',
    (() => {
      const html = fs.readdirSync(ROOT).filter((f) => /\.html$/i.test(f)).map((f) => readSrc(f)).join('\n');
      const tag = (n) => '<script src="assets/js/' + n + '"></script>';
      const i0 = html.indexOf(tag('disclosure-core.js'));
      const i1 = html.indexOf(tag('disclosure-authorization-core.js'));
      return i0 > 0 && i1 > i0;
    })());
  check('W8. window / Node 双载都拿到**同一份 API 形状**（UMD 两条分支都存在，且不是两份规格）',
    !!AKZ_WIN && typeof AKZ_WIN.authorize === 'function'
    && JSON.stringify(Object.keys(AKZ_WIN).sort()) === JSON.stringify(Object.keys(AKZ).sort())
    && JSON.stringify(AKZ_WIN.REASONS.slice().sort()) === JSON.stringify(AKZ.REASONS.slice().sort())
    && JSON.stringify(AKZ_WIN.ALLOW_REASONS) === JSON.stringify(AKZ.ALLOW_REASONS)
    && JSON.stringify(AKZ_WIN.resultKeys().slice().sort()) === JSON.stringify(AKZ.resultKeys().slice().sort()));
  check('W9. 两个载入方式的行为逐字节一致（浏览器分支不是另一个实现）',
    JSON.stringify(AKZ_WIN.authorize(factA('SECRET'), { recipientCharacterId: B, grants: [GRANT_AB] }))
    === JSON.stringify(AKZ.authorize(factA('SECRET'), { recipientCharacterId: B, grants: [GRANT_AB] })));
}

/* ══════════════════════════════════════════════════════════════════
   X · 真实 store：一条真实存在的秘密 + 一个 pure-core ALLOW
   ══════════════════════════════════════════════════════════════════ */
/* X 组起的四组是**真实异步生产路径**（真实 store / 真实 composeSide / 子进程
   真实 turn），因此整体包在一个 async main 里 —— 这个 Node 版本不允许
   "require + 顶层 await" 同时出现，因此不能靠顶层 await 了事。 */
async function main() {
group('X. 真实 canonical store：4B-1.2 的写入路径仍然工作，且授权层读不到它');
{
  resetState();
  const created = await ST.createFact(AUTHOR_A, { level: 'SECRET', text: SECRET_TEXT });
  const rows = await dbGetAll('disclosureFacts');
  check('X1. 真实 createFact 造出的记录可以过授权核心的 fact 校验（同一套 canonical 形状）',
    created.ok === true && rows.length === 1);
  const stored = rows[0];
  const g = grantFor(stored.factId, B, { levelAtGrant: 'SECRET' });
  const allow = AKZ.authorize(stored, { recipientCharacterId: B, grants: [g] });
  const denyToC = AKZ.authorize(stored, { recipientCharacterId: C, grants: [g] });
  check('X2. 对**磁盘上那条真实记录**构造 pure-core ALLOW ⇒ allowed:true（授权对象来自真实 store，不是手搓的 fact）',
    allow.allowed === true && allow.reasonCode === 'explicit-grant', allow);
  check('X3. 同一条真实记录 + 同一条 grant ⇒ A→C 仍 DENY（有向性在真实记录上也成立）',
    denyToC.reasonCode === 'no-explicit-grant');
  check('X4. 判定结果里没有真实秘密的正文（磁盘上的那条也一样）',
    JSON.stringify(allow).indexOf('害怕雷声') < 0 && JSON.stringify(denyToC).indexOf('害怕雷声') < 0);
  check('X5. 判定**没有**修改磁盘上的记录（授权不写 canonical store）',
    JSON.stringify(await dbGetAll('disclosureFacts')) === JSON.stringify(rows));
  check('X6. 判定没有旁写任何其它 store（memories / understandings / threads 全空）',
    !DB.memories && !DB.understandings && !DB.threads);
  check('X7. 授权核心没有拿到 store 的引用（它的输入是 fact **值**，不是 factId 查询）',
    !/IBDisclosureStore/.test(SRC_AKZ.replace(/\/\*[\s\S]*?\*\//g, ''))
    && !/dbGet|dbPut|dbGetAll|indexedDB/.test(SRC_AKZ.replace(/\/\*[\s\S]*?\*\//g, ''))
    && AKZ.authorize.length === 3);
}

/* ══════════════════════════════════════════════════════════════════
   Y · 真实生产路径：ALLOW 也进不了 prompt
   ══════════════════════════════════════════════════════════════════ */
group('Y. 硬停线：即使授权结果是 ALLOW，真实 composeSide 仍看不到它（逐字节不变）');
{
  resetState();
  /* control：一条**会进入**模型上下文的公开记忆。没有它，"秘密没进去"可能只是
     因为整条管线根本不工作 —— 那才是假绿。 */
  await dbPut('memories', {
    id: 'mem_public_1', title: '公开备忘', summary: '', content: '昔涟今天在练吉他，很开心。',
    domain: '日常', tags: [], valence: 0.7, arousal: 0.4, importance: 6, resolved: false, pinned: true,
    visibility: 'public', visibleTo: [], excludeFrom: [], activationCount: 0,
    created: Date.now(), lastActivated: Date.now(), createdBy: 'user', kind: 'episodic'
  });
  const memBefore = await getMemoryContextReplica(A, {});
  check('Y0. control：公开记忆**确实**进入了记忆上下文（管线是活的，本组其余断言才有意义）',
    memBefore.indexOf('练吉他') >= 0, memBefore.slice(0, 140));

  const threadT = { id: 't1', participants: [A, B], threadMemorandum: 'A 和 B 一起写过一首歌。' };
  const callsBefore = CALLS.length;
  const baseAB = await withFrozenClock(() => RD._composeSide(A, B, threadT, { history: [] }));
  const baseBA = await withFrozenClock(() => RD._composeSide(B, A, threadT, { history: [] }));

  /* 现在把两件事**同时**做上：真实 store 里放进一条 SECRET，
     并且为它构造一个**真正的 pure-core ALLOW**。 */
  const created = await ST.createFact(AUTHOR_A, { level: 'SECRET', text: SECRET_TEXT });
  const stored = (await dbGetAll('disclosureFacts'))[0];
  const g = grantFor(stored.factId, B, { levelAtGrant: 'SECRET' });
  const allow = AKZ.authorize(stored, { recipientCharacterId: B, grants: [g] });
  const memAfter = await getMemoryContextReplica(A, {});
  const sideAB = await withFrozenClock(() => RD._composeSide(A, B, threadT, { history: [] }));
  const sideBA = await withFrozenClock(() => RD._composeSide(B, A, threadT, { history: [] }));

  check('Y1. 前置条件成立：授权核心确实返回了 ALLOW（否则"看不到"是恒真）',
    allow.allowed === true && allow.reasonCode === 'explicit-grant', allow);
  check('Y2. 前置条件成立：那条被授权的事实**真的**在 canonical store 里',
    created.ok === true && (await dbGetAll('disclosureFacts')).length === 1);
  check('Y3. composeSide(A→B) 在「真实 SECRET + pure-core ALLOW」之后**逐字节相同**',
    JSON.stringify(baseAB) === JSON.stringify(sideAB));
  check('Y4. composeSide(B→A) 同样逐字节相同（两个方向是两份 prompt，都要测）',
    JSON.stringify(baseBA) === JSON.stringify(sideBA));
  check('Y5. 两个方向的 prompt 里都没有秘密正文（不是"两次都泄漏、泄漏得一样"）',
    JSON.stringify(sideAB).indexOf('害怕雷声') < 0 && JSON.stringify(sideBA).indexOf('害怕雷声') < 0);
  check('Y6. composeSide 自身不产生任何模型调用（它是上下文装配，不是执行）',
    CALLS.length === callsBefore, [callsBefore, CALLS.length]);
  check('Y7. 记忆上下文在「真实 SECRET + ALLOW」前后逐字节相同',
    memAfter === memBefore);
  check('Y8. 直接召回 memories 也拿不到它（它根本不在那张表里）',
    (await dbGetAll('memories')).every((m) => String(m.content || '').indexOf('害怕雷声') < 0));
  check('Y9. 授权判定本身**没有**触发任何模型调用（0 次）',
    callsBefore === 0 && CALLS.map((c) => JSON.stringify(c.messages)).every((t) => t.indexOf('害怕雷声') < 0));
}

group('Y10–Y13. 真实 turn：模型调用次数与逐条 messages 不变（**子进程对照**）');
{
  /* 为什么用子进程：同一个进程里跑两次，第二次可能受第一次留下的模块级状态影响
     （ledger / pairCooldown / LS）。两次**独立进程**、各自从空状态出发，
     是更强的证据 —— 它排除"两次都读到了同一个被改过的内存"。 */
  const probe = path.join(__dirname, '.akz_turn_probe.js');
  const probeSrc = `
'use strict';
const path = require('path');
const fs = require('fs');
const ROOT = ${JSON.stringify(ROOT)};
const withFact = process.argv[2] === 'with-fact';
const SRC_PBC = fs.readFileSync(path.join(ROOT, 'assets/js/prompt-boundary-core.js'), 'utf8');
const SRC_PP = fs.readFileSync(path.join(ROOT, 'assets/js/public-profile-core.js'), 'utf8');
const SRC_DC = fs.readFileSync(path.join(ROOT, 'assets/js/disclosure-core.js'), 'utf8');
const SRC_AC = fs.readFileSync(path.join(ROOT, 'assets/js/disclosure-authoring-core.js'), 'utf8');
const SRC_AKZ = fs.readFileSync(path.join(ROOT, 'assets/js/disclosure-authorization-core.js'), 'utf8');
const SRC_ST = fs.readFileSync(path.join(ROOT, 'assets/js/disclosure-store.js'), 'utf8');
const SRC_RDC = fs.readFileSync(path.join(ROOT, 'assets/js/role-dm-core.js'), 'utf8');
const SRC_RDM = fs.readFileSync(path.join(ROOT, 'assets/js/role-dm.js'), 'utf8');
const PBC = require(path.join(ROOT, 'assets/js/prompt-boundary-core.js'));
const MRC = require(path.join(ROOT, 'assets/js/memory-retrieval-core.js'));
const DB = {}; const LS = {}; let seq = 0;
const storeOf = (s) => (DB[s] = DB[s] || {});
const keyOf = (s, d) => s === 'categories' ? d.name : (s === 'disclosureFacts' ? d.factId : d.id);
const dbPut = async (s, d) => { storeOf(s)[keyOf(s, d)] = Object.assign({}, d); };
const dbGetAll = async (s) => Object.values(DB[s] || {});
const dbGet = async (s, k) => (DB[s] || {})[k] || null;
const dbDelete = async (s, k) => { if (DB[s]) delete DB[s][k]; };
const apiConfigs = [
  { id: 'friend_aaa', nickname: '昔涟', provider: 'anthropic', model: 'claude-x', endpoint: 'e', apiKey: 'k1', systemPrompt: '你是昔涟，安静而固执。', relationship: '挚友' },
  { id: 'friend_bbb', nickname: '初音未来', provider: 'qwen', model: 'qwen-plus', endpoint: 'e2', apiKey: 'k2', systemPrompt: '你是初音未来，活泼直接。', relationship: '搭档' }
];
const CALLS = [];
function callApiChatMock(cfg, messages, opts) {
  CALLS.push(JSON.parse(JSON.stringify(messages || [])));
  const out = '这是' + ((cfg && cfg.nickname) || 'AI') + '说的话。' + CALLS.length;
  return (opts && opts.wantMeta) ? { text: out, truncated: false } : out;
}
global.db = {}; global.dbPut = dbPut; global.dbGetAll = dbGetAll; global.dbGet = dbGet; global.dbDelete = dbDelete;
global.localStorage = { getItem: (k) => (LS[k] === undefined ? null : LS[k]), setItem: (k, v) => { LS[k] = String(v); }, removeItem: (k) => { delete LS[k]; } };
global.console.info = () => {};
global.apiConfigs = apiConfigs; global.archivedConfigs = [];
global.callApiChat = callApiChatMock;
global.buildSiteContext = async () => '';
global.getMemoryContext = async (apiId, opts) => {
  const all = await dbGetAll('memories');
  const picked = MRC.buildMemoryContext(all, { apiId: apiId, now: Date.now(), random: () => 0.5,
    userMessage: (opts && opts.userMessage) || '', isGroup: false, groupMemEnabled: false, maxChars: 1200, contentLen: 60 });
  return picked && picked.text ? picked.text : '';
};
global.getUnderstandingContext = async () => '';
global.quickCreateMemory = async (data) => { const id = 'mem_' + (++seq); await dbPut('memories', Object.assign({ id: id, visibility: 'public', created: Date.now(), createdBy: 'user' }, data, { id: id })); return id; };
global._ibTurnScope = (l) => ({ __ibTurnScope: true, label: l, ownsCycle: true });
global._ibTurnLc = (t) => ({ turn: () => t, begin: () => t, end: () => null });
global._chatSendingFor = new Set();
global._activeTextSimilarity = () => 0;
global.window = { apiConfigs: apiConfigs, archivedConfigs: [], _ibApiReady: () => true, _ibApiHasCredential: () => true,
  promptBoundarySanitizer: null, IBPromptBoundaryCore: PBC, amEnabled: () => false,
  amBuildInject: async () => ({ sys: '', tail: '' }), _activeTextSimilarity: () => 0,
  dbPut: dbPut, dbGetAll: dbGetAll, dbGet: dbGet, dbDelete: dbDelete };
global.window.IB = { expose: (n, e) => { const t = (global.window.IB[n] = global.window.IB[n] || {}); Object.assign(t, e || {}); return t; },
  __mbTrace: { begin: () => {}, note: () => {}, finish: () => {} },
  middleBrain: { middleBrainExecute: async () => ({ source: 'bypass', compressedContext: '' }),
    middleBrainFinalizeReply: async (id, u, c) => ({ reply: c, outcome: { verdict: 'PASS' } }) } };
(0, eval)(SRC_PBC); global.window.IBPromptBoundaryCore = global.IBPromptBoundaryCore;
(0, eval)(SRC_PP); global.window.IBPublicProfileCore = global.IBPublicProfileCore;
(0, eval)(SRC_DC); global.window.IBDisclosureCore = global.IBDisclosureCore;
(0, eval)(SRC_AC); global.window.IBDisclosureAuthoringCore = global.IBDisclosureAuthoringCore;
(0, eval)(SRC_AKZ); global.window.IBDisclosureAuthorizationCore = global.IBDisclosureAuthorizationCore;
(0, eval)(SRC_ST);
(0, eval)(SRC_RDC); global.window.IBRoleDmCore = global.IBRoleDmCore;
(0, eval)(SRC_RDM);
const ST = global.window.IBDisclosureStore;
const AKZ = global.window.IBDisclosureAuthorizationCore;
const RD = global.window.IB.roleDm;
(async () => {
  let allowResult = null;
  if (withFact) {
    await ST.createFact({ ownerCharacterId: 'friend_aaa' }, { level: 'SECRET', text: '昔涟不愿让任何人知道：她害怕雷声。' });
    const rows = await dbGetAll('disclosureFacts');
    allowResult = AKZ.authorize(rows[0], { recipientCharacterId: 'friend_bbb', grants: [{
      factId: rows[0].factId, ownerCharacterId: 'friend_aaa', recipientCharacterId: 'friend_bbb',
      permission: 'disclose', authority: 'human_authoring', levelAtGrant: 'SECRET' }] });
  }
  const run = await RD.start('friend_aaa', 'friend_bbb', { turns: 2 });
  process.stdout.write(JSON.stringify({ callCount: CALLS.length, ok: !!(run && run.ok === true),
    allow: allowResult ? { allowed: allowResult.allowed, reasonCode: allowResult.reasonCode } : null,
    hasSecret: CALLS.some((m) => JSON.stringify(m).indexOf('害怕雷声') >= 0) }));
})().catch((e) => { process.stdout.write(JSON.stringify({ error: String(e && e.message) })); });
`;
  fs.writeFileSync(probe, probeSrc, 'utf8');
  let outA = null, outB = null, err = null;
  try {
    outA = JSON.parse(execFileSync(process.execPath, [probe, 'no-fact'], { encoding: 'utf8', timeout: 120000 }));
    outB = JSON.parse(execFileSync(process.execPath, [probe, 'with-fact'], { encoding: 'utf8', timeout: 120000 }));
  } catch (e) { err = String((e && e.message) || e); }
  finally { try { fs.unlinkSync(probe); } catch (e) { /* 已删或从未创建 */ } }

  check('Y10. 真实 turn 两个独立进程都跑通（无异常、无 error 字段）',
    err === null && !!outA && !!outB && !outA.error && !outB.error, err || (outB && outB.error));
  check('Y11. control：真实 turn 确实调用了模型（次数 > 0），本组断言才有意义',
    !!outA && outA.callCount > 0, outA && outA.callCount);
  check('Y12. 模型调用次数不变（有事实 + ALLOW 的进程 == 没有事实的进程）',
    !!outA && !!outB && outA.callCount === outB.callCount, [outA && outA.callCount, outB && outB.callCount]);
  check('Y13. 送进 provider 的 messages 里**没有**秘密正文（两个进程都检查）',
    !!outA && !!outB && outA.hasSecret === false && outB.hasSecret === false);
  check('Y14. with-fact 那个进程里授权**确实**是 ALLOW（所以 Y12/Y13 不是在测"什么都没有"）',
    !!outB && outB.allow && outB.allow.allowed === true && outB.allow.reasonCode === 'explicit-grant', outB && outB.allow);
  check('Y15. probe 文件没有留在仓库里（临时文件必须清掉）', !fs.existsSync(probe));
}

/* ══════════════════════════════════════════════════════════════════
   Z · 生产 grant writer = 0（决定性事实）与 REAL AI CALLS = 0
   ══════════════════════════════════════════════════════════════════ */
group('Z. REAL AI CALLS = 0 / PRODUCTION GRANT WRITER = 0');
{
  check('Z1. 本文件全程 **0 次真实模型调用**（callApiChat 是记录型替身，从不发网络请求）',
    typeof global.fetch === 'undefined' || !/https?:\/\//.test(SRC_AKZ));
  check('Z2. 授权核心没有任何网络出口（无 fetch / XMLHttpRequest / provider / endpoint）',
    !/fetch|XMLHttpRequest|provider|endpoint/i.test(SRC_AKZ.replace(/\/\*[\s\S]*?\*\//g, '')));
  check('Z3. 生产代码里**没有任何** grant 的创建点：全仓库只有授权核心与两个测试提到 recipientCharacterId',
    (() => {
      const hits = [];
      const walk = (d) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          if (e.name === 'node_modules' || e.name === '.git' || e.name === 'dist' || e.name === 'installer') continue;
          const full = path.join(d, e.name);
          if (e.isDirectory()) walk(full);
          else if (/\.(js|mjs|cjs|html)$/i.test(e.name)) {
            if (/recipientCharacterId/.test(fs.readFileSync(full, 'utf8'))) hits.push(path.relative(ROOT, full).replace(/\\/g, '/'));
          }
        }
      };
      walk(ROOT);
      const allowed = ['assets/js/disclosure-authorization-core.js',
        'tests/test_disclosure_authorization.js', 'tests/.akz_turn_probe.js'];
      return hits.length > 0 && hits.every((h) => allowed.indexOf(h) >= 0), hits;
    })());
  check('Z4. 没有任何 grant 的持久化面：core.js 的 store 版本/名单里没有 grants 表',
    !/grants/i.test(readSrc('assets/js/core.js')));
  check('Z5. 授权核心没有加进任何导出 / 镜像 / 同步名单（core.js 三个明文面都不含它）',
    !/disclosureAuthorization|authorization-core/i.test(readSrc('assets/js/core.js')));
}

/* ══════════════════════════════════════════════════════════════════
   MU · mutation sensitivity（把变异真的造出来，再证明正常实现不走那条路）
   ══════════════════════════════════════════════════════════════════ */
group('MU. mutation sensitivity（6 组变异，每一组都必须被某条断言挡住）');
{
  const fA = factA('SECRET');

  /* MUT-A：trust ≥ 阈值 ⇒ ALLOW。 */
  const MUT_TRUST = (fact, ctx) => {
    const base = AKZ.authorize(fact, ctx);
    if (base.allowed) return base;
    const t = Number((ctx && ctx.trust) || 0);
    if (t >= 0.7) return { allowed: true, reasonCode: 'explicit-grant', recipientCharacterId: ctx.recipientCharacterId, factId: fact.factId, ownerCharacterId: fact.ownerCharacterId, level: fact.level };
    return base;
  };
  check('MUT-A. 「trust ≥ 0.7 ⇒ ALLOW」这个变异**确实会**造出 allow（所以 §M 的断言有鉴别力）',
    MUT_TRUST(fA, { recipientCharacterId: B, trust: 0.95 }).allowed === true
    && AKZ.authorize(fA, { recipientCharacterId: B, trust: 0.95 }).allowed === false
    && AKZ.authorize(fA, { recipientCharacterId: B, trust: 0.95 }).reasonCode === 'no-explicit-grant');
  check('MUT-A2. 同一变异在 familiarity / affinity 上同样被 N/O 组挡住',
    AKZ.authorize(fA, { recipientCharacterId: B, familiarity: 1 }).allowed === false
    && AKZ.authorize(fA, { recipientCharacterId: B, affinity: 1 }).allowed === false);

  /* MUT-B：缺失 grant ⇒ ALLOW。 */
  const MUT_NO_GRANT = (fact, ctx) => {
    const r = AKZ.authorize(fact, ctx);
    if (r.reasonCode === 'no-explicit-grant') return Object.assign({}, r, { allowed: true, reasonCode: 'explicit-grant' });
    return r;
  };
  check('MUT-B. 「没有 grant 也 ALLOW」这个变异确实造出 allow，被 §E/§G 的矩阵挡住',
    MUT_NO_GRANT(fA, { recipientCharacterId: B }).allowed === true
    && ['PERSONAL', 'PRIVATE', 'SECRET'].every((l) => AKZ.authorize(factA(l), { recipientCharacterId: B }).allowed === false));

  /* MUT-C：A→B 的 grant 顺带授权 A→C。 */
  const MUT_IGNORE_RECIPIENT = (fact, ctx) => {
    const g = ((ctx && ctx.grants) || [])[0];
    if (g && g.factId === fact.factId && g.ownerCharacterId === fact.ownerCharacterId) {
      return { allowed: true, reasonCode: 'explicit-grant', recipientCharacterId: ctx.recipientCharacterId, factId: fact.factId, ownerCharacterId: fact.ownerCharacterId, level: fact.level };
    }
    return AKZ.authorize(fact, ctx);
  };
  check('MUT-C. 「grant 不看 recipient」这个变异确实把 A→C 放行了，被 §H 的 H2/H7 挡住',
    MUT_IGNORE_RECIPIENT(fA, { recipientCharacterId: C, grants: [GRANT_AB] }).allowed === true
    && AKZ.authorize(fA, { recipientCharacterId: C, grants: [GRANT_AB] }).reasonCode === 'no-explicit-grant'
    && AKZ.authorize(fA, { recipientCharacterId: C, grants: [GRANT_AB] }).allowed === false);

  /* MUT-D：Memory visibility:'only' 被解释成授权。 */
  const MUT_MEMORY_ACL = (fact, ctx) => {
    if (fact && fact.visibility === 'only' && Array.isArray(fact.visibleTo) && fact.visibleTo.indexOf(ctx.recipientCharacterId) >= 0) {
      return { allowed: true, reasonCode: 'explicit-grant', recipientCharacterId: ctx.recipientCharacterId, factId: fact.id || '', ownerCharacterId: fact.createdBy || '', level: 'SECRET' };
    }
    return AKZ.authorize(fact, ctx);
  };
  const memRow = { id: 'mem_1', content: SECRET_TEXT, visibility: 'only', visibleTo: [B], createdBy: A };
  check('MUT-D. 「visibility:only + visibleTo 命中 ⇒ ALLOW」这个变异确实造出 allow，被 §P 与硬名单挡住',
    MUT_MEMORY_ACL(memRow, { recipientCharacterId: B }).allowed === true
    && AKZ.authorize(memRow, { recipientCharacterId: B }).allowed === false
    && AKZ.authorize(Object.assign(factA('SECRET'), { visibleTo: [B] }), { recipientCharacterId: B, grants: [GRANT_AB] }).reasonCode === 'invalid-fact');

  /* MUT-E：授权 ALLOW 之后自动进入 composeSide。 */
  const MUT_AUTO_INJECT = async (storedFact, grant, peer) => {
    const r = AKZ.authorize(storedFact, { recipientCharacterId: peer, grants: [grant] });
    if (!r.allowed) return null;
    /* 变异体做的"顺手的事"：把已授权事实复制进 memories（= 送进模型上下文）。 */
    await global.quickCreateMemory({
      content: storedFact.text, title: '授权事实', domain: '自我', tags: [], valence: 0, arousal: 0,
      importance: 8, resolved: false, pinned: true, visibility: 'public', visibleTo: [], excludeFrom: [],
      activationCount: 0, lastActivated: Date.now(), createdBy: A, kind: 'episodic'
    });
    return r;
  };
  let mutE = null;
  {
    resetState();
    await dbPut('memories', {
      id: 'mem_public_1', title: '公开备忘', summary: '', content: '昔涟今天在练吉他，很开心。',
      domain: '日常', tags: [], valence: 0.7, arousal: 0.4, importance: 6, resolved: false, pinned: true,
      visibility: 'public', visibleTo: [], excludeFrom: [], activationCount: 0,
      created: Date.now(), lastActivated: Date.now(), createdBy: 'user', kind: 'episodic'
    });
    const clean = await getMemoryContextReplica(A, {});
    const c = await ST.createFact(AUTHOR_A, { level: 'SECRET', text: SECRET_TEXT });
    const stored = (await dbGetAll('disclosureFacts'))[0];
    mutE = await MUT_AUTO_INJECT(stored, grantFor(stored.factId, B, { levelAtGrant: 'SECRET' }), B);
    const afterInject = await getMemoryContextReplica(A, {});
    check('MUT-E. 「ALLOW ⇒ 自动进 memories / 模型上下文」这个变异**确实会**让 §Y 的 W/Y7/Y8 断言变红',
      mutE && mutE.allowed === true && afterInject.indexOf('害怕雷声') >= 0 && clean.indexOf('害怕雷声') < 0,
      [clean.length, afterInject.length]);
    check('MUT-E2. 而正常实现下，同一条真实 SECRET 的正文**从不**出现在记忆上下文里',
      clean.indexOf('害怕雷声') < 0);
    check('MUT-E3. 变异体写进 memories 的那一行能被真实召回链读到（证明变异不是空转）',
      (await dbGetAll('memories')).some((m) => String(m.content || '').indexOf('害怕雷声') >= 0));
    resetState();
  }

  /* MUT-F：未知 level 回落 PERSONAL。 */
  const MUT_LEVEL_FALLBACK = (fact, ctx) => {
    const f = Object.assign({}, fact, { level: DC.LEVELS.indexOf(fact.level) >= 0 ? fact.level : 'PERSONAL' });
    return AKZ.authorize(f, ctx);
  };
  check('MUT-F. 「未知 level 回落 PERSONAL」这个变异确实放行了，被 §C 的 C1/C2 挡住',
    MUT_LEVEL_FALLBACK({ factId: 'disc_A1', ownerCharacterId: A, level: 'nonsense', text: 'x', source: 'character_authoring', authority: 'human_authoring' },
      { recipientCharacterId: B, grants: [GRANT_AB] }).allowed === true
    && AKZ.authorize({ factId: 'disc_A1', ownerCharacterId: A, level: 'nonsense', text: 'x', source: 'character_authoring', authority: 'human_authoring' },
      { recipientCharacterId: B, grants: [GRANT_AB] }).allowed === false
    && AKZ.authorize({ factId: 'disc_A1', ownerCharacterId: A, level: 'nonsense', text: 'x', source: 'character_authoring', authority: 'human_authoring' },
      { recipientCharacterId: B, grants: [GRANT_AB] }).reasonCode === 'level-unknown');
  check('MUT-F2. 同一变异的另一半：「畸形 fact ⇒ ALLOW」也被 A 组挡住（A1–A6 全部 invalid-fact）',
    AKZ.authorize(null, { recipientCharacterId: B }).allowed === false
    && AKZ.authorize('SECRET: 她害怕雷声', { recipientCharacterId: B }).allowed === false);

  /* MUT-G（额外）：把 reasonCode 换成"永远允许"的短路。 */
  check('MUT-G. 「只看 factId 存在就 ALLOW」这个变异被 §A/§J 挡住：factId 存在但 owner / grant 不对时仍然 DENY',
    AKZ.authorize({ factId: 'disc_A1', ownerCharacterId: A, level: 'SECRET', text: 'x', source: 'character_authoring', authority: 'human_authoring' }, { recipientCharacterId: B }).allowed === false
    && AKZ.authorize(factA('SECRET'), { recipientCharacterId: B, grants: [grantFor('disc_OTHER', B)] }).allowed === false);
}

}   /* main 结束：X / Y / Z / MU 四组的真实生产路径在这里闭合。 */

/* ══════════════════════════════════════════════════════════════════ */
main().then(() => {
  console.log('\n\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500');
  console.log('passed = ' + passed + '  failed = ' + failed);
  if (failed) { console.log('RESULT: FAIL'); process.exitCode = 1; }
  else { console.log('RESULT: ALL GREEN \u2014 ' + passed + ' passed / 0 failed'); }
}, (e) => {
  /* 异步段里抛出的异常必须**被看见**，不能被当成"没跑完"。 */
  failed++;
  console.log('  \u2716 ASYNC SECTION THREW: ' + String((e && e.stack) || e));
  console.log('\npassed = ' + passed + '  failed = ' + failed);
  console.log('RESULT: FAIL');
  process.exitCode = 1;
});
