'use strict';
/* ====================================================================
   P22-18 · Economy Experience（解释层）— 纯层
   （assets/js/economy-shell-core.js 的 P22-18 追加部分）
   --------------------------------------------------------------------
   运行：node tests/test_p22_18_economy_experience_ui_core.js

   ★ 纯层加载进一个**没有 document、没有 fetch、没有 location** 的沙箱。
   ★ 这一条测试要回答的问题（§2/§3/§4/§7）：
     · canonical change log 的**每一个**事件类型在这一页上都有一句人话
       （名单是从契约与 store 的源码里抽出来的，不是本地编的）；
     · 归属是**用 canonical 自己的键比出来的**，而且收礼者不算（否证）；
     · 时间线按 canonical 的 revision 倒序，截断时**说出来**；
     · §3 的"来源"三词各自要一条证据 —— 没有证据的词一个都不出现；
     · §4 的理由**逐字**（不做摘要、不改写、不再调模型）；
     · §7 的高级信息只有四个编号，默认折叠，且不含版本/迁移/数据库行。
   ==================================================================== */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const CORE_REL = 'assets/js/economy-shell-core.js';
const CFG_CORE_REL = 'assets/js/economy-configuration-core.js';
const CONTRACT_REL = 'services/home-node/economy-contract.js';
const STORE_REL = 'services/home-node/economy-store.js';

let checks = 0;
let failures = 0;
function check(name, cond, extra) {
  checks += 1;
  if (cond) { console.log('  ✔ ' + name); return true; }
  failures += 1;
  console.error('  ✖ ' + name + (extra !== undefined ? ' — ' + JSON.stringify(extra) : ''));
  return false;
}
function section(t) { console.log('\n── ' + t + ' ' + '─'.repeat(Math.max(0, 62 - t.length))); }
function read(f) { return fs.readFileSync(path.join(ROOT, f), 'utf8'); }
function strip(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''").replace(/"(?:[^"\\]|\\.)*"/g, '""');
}

const coreSrc = read(CORE_REL);
const coreCode = strip(coreSrc);
const cfgSrc = read(CFG_CORE_REL);

console.log('P22-18 · Economy Experience 纯层（解释层）');

/* ── 沙箱 ───────────────────────────────────────────────────────────── */
function sandbox() {
  const b = { console: { log() {}, warn() {}, error() {}, info() {} } };
  b.window = b; b.self = b;
  return vm.createContext(b);
}
function loadCore() {
  const s = sandbox();
  vm.runInContext(cfgSrc, s, { filename: 'economy-configuration-core.js' });
  vm.runInContext(coreSrc, s, { filename: 'economy-shell-core.js' });
  return { s, core: s.IB.economyShellCore, cfg: s.IB.economyConfigurationCore };
}
const L = loadCore();
const C = L.core;
const CFG = L.cfg;

/* ── 从 canonical 源码里**抽出**事件类型名单 ──────────────────────────
   ★ 这份名单不能由本测试自己写死：写死之后"契约新增了一个事件类型"
     就不会让任何断言变红，而那正是这一层最容易失效的方式。 */
function canonicalEventKinds() {
  const src = read(CONTRACT_REL);
  const at = src.indexOf('var EVENT_TYPE = Object.freeze({');
  if (at < 0) return [];
  const body = src.slice(at, src.indexOf('});', at));
  const out = [];
  const re = /^\s*([A-Z][A-Z_0-9]*)\s*:\s*'/gm;
  let m;
  while ((m = re.exec(body))) out.push(m[1]);
  return out;
}
/* store 里**写成字面量**的 kind（它们不在契约的封闭集合里）。 */
function storeLiteralKinds() {
  const src = read(STORE_REL);
  const out = [];
  const re = /kind:\s*'([A-Z][A-Z_0-9]*)'/g;
  let m;
  while ((m = re.exec(src))) out.push(m[1]);
  return Array.from(new Set(out));
}
const EVENT_KINDS = canonicalEventKinds();
const LITERAL_KINDS = storeLiteralKinds();
const KNOWN_KINDS = EVENT_KINDS.concat(LITERAL_KINDS);

/* ══ A · 静态结构 ══════════════════════════════════════════════════ */
section('A · 静态结构：解释层不碰 DOM、不发请求、不认识任何写面');

check('A1 ★★★ 纯层里没有 fetch / XMLHttpRequest / require / import',
  !/\bfetch\s*\(/.test(coreCode) && !/XMLHttpRequest/.test(coreCode) &&
  !/\brequire\s*\(/.test(coreCode) && !/\bimport\s*\(/.test(coreCode));

check('A2 ★★★ 纯层里没有任何 /internal/economy/* 路径（一条写面都不认识）',
  !/\/internal\/economy\//.test(coreSrc));

check('A3 ★★★ 纯层里没有一条 POST / PUT / DELETE（它只有"读"这一个词）',
  !/['"]POST['"]/.test(coreCode) && !/['"]PUT['"]/.test(coreCode) && !/['"]DELETE['"]/.test(coreCode));

check('A4 ★★★ READS 仍然是 P22-17 那**八条**（本阶段不偷偷改上一阶段的冻结事实）',
  Object.keys(C.READS).length === 8 &&
  Object.keys(C.READS).map(k => C.READS[k]).indexOf('/economy/changes') < 0);

check('A5 ★★★★ 第九条是**另立**的 CHANGE_READ，而且就是 canonical 的 change log',
  C.CHANGE_READ === '/economy/changes' && C.CHANGE_LIMIT === 200 && C.TIMELINE_KEEP === 24,
  { read: C.CHANGE_READ, limit: C.CHANGE_LIMIT, keep: C.TIMELINE_KEEP });

check('A6 ★★★★ 没有 batchApprove / autoApprove / approveAll 这一类东西（§5 明令）',
  ['batchApprove', 'autoApprove', 'approveAll', 'decideAll', 'bulkApprove']
    .every(w => coreCode.indexOf(w) < 0));

check('A7 ★★★★★ 纯层里没有新增任何经济写入口（§11 的四个动词一个都不在代码里）',
  ['BUY', 'SETTLE', 'TRANSFER', 'REFUND', 'EXCHANGE', 'MINT', 'BURN']
    .every(w => coreCode.indexOf(w) < 0), ['BUY', 'SETTLE', 'TRANSFER', 'REFUND', 'EXCHANGE', 'MINT', 'BURN']
    .filter(w => coreCode.indexOf(w) >= 0));

/* ══ B · 变化词表：每一个 canonical 事件都有话 ════════════════════════ */
section('B · 变化词表：canonical 的每一个事件类型都有一句人话');

check('B1 ★★★ 抽出来的名单不是空的（否则下面几条是在为空气作证）',
  EVENT_KINDS.length >= 45 && LITERAL_KINDS.length >= 2,
  { event: EVENT_KINDS.length, literal: LITERAL_KINDS.length });

check('B2 ★★★★★ 契约 EVENT_TYPE 的**每一个**成员都有一句人话（或落在账本提交族里）',
  (function () {
    const missing = EVENT_KINDS.filter(k => C.CHANGE_KIND_FACE[k] == null && !C.isLedgerCommitKind(k));
    return missing.length === 0;
  })(), EVENT_KINDS.filter(k => C.CHANGE_KIND_FACE[k] == null && !C.isLedgerCommitKind(k)));

check('B3 ★★★★ store 里那两个**字面量**事件（不在封闭集合里）也在表里',
  LITERAL_KINDS.every(k => C.CHANGE_KIND_FACE[k] != null), LITERAL_KINDS);

check('B4 ★★★★ 表里的键**全部**来自 canonical —— 一个编出来的都没有',
  Object.keys(C.CHANGE_KIND_FACE).every(k =>
    EVENT_KINDS.indexOf(k) >= 0 || LITERAL_KINDS.indexOf(k) >= 0));

check('B5 ★★★★ 三个账本提交族成员不逐个登记，而是走模式（§11：不复述交易类型表）',
  C.isLedgerCommitKind('PURCHASE_COMMITTED') === true &&
  C.isLedgerCommitKind('GIFT_COMMITTED') === true &&
  C.isLedgerCommitKind('WALLET_OPENED') === false &&
  C.changeKindFace('GIFT_COMMITTED').known === true &&
  C.changeKindFace('GIFT_COMMITTED').face === C.COPY.changeLedger &&
  C.CHANGE_KIND_FACE['GIFT_COMMITTED'] === undefined);

check('B6 ★★★ 每一张词表的右边都是人话：没有一个值等于它的键',
  (function () {
    const bad = [];
    Object.keys(C.CHANGE_KIND_FACE).forEach(k => {
      const v = String(C.CHANGE_KIND_FACE[k].face);
      if (v === k || v.indexOf(k) >= 0) bad.push(k);
    });
    Object.keys(C.INTENT_STATE_FACE).forEach(k => {
      const v = String(C.INTENT_STATE_FACE[k]);
      if (v === k || v.indexOf(k) >= 0) bad.push('INTENT.' + k);
    });
    Object.keys(C.APPROVAL_STATE_FACE).forEach(k => {
      const v = String(C.APPROVAL_STATE_FACE[k]);
      if (v === k || v.indexOf(k) >= 0) bad.push('APPROVAL.' + k);
    });
    return bad.length === 0;
  })());

check('B7 ★★★ 语气落在封闭集合里（七个成员，一个都不多）',
  (function () {
    const allowed = Object.keys(C.TONE).map(k => C.TONE[k]);
    return Object.keys(C.CHANGE_KIND_FACE).every(k => allowed.indexOf(C.CHANGE_KIND_FACE[k].tone) >= 0) &&
      allowed.length === 8;
  })(), Object.keys(C.TONE));

check('B8 ★★★ 两个新状态词表的键逐字等于契约的封闭集合',
  (function () {
    const src = read(CONTRACT_REL);
    const intentBlock = src.slice(src.indexOf('var PURCHASE_INTENT_STATE = Object.freeze({'));
    const approvalBlock = src.slice(src.indexOf('var APPROVAL_STATE = Object.freeze({'));
    function keysOf(block) {
      const body = block.slice(0, block.indexOf('});'));
      const out = [];
      const re = /^\s*([A-Z][A-Z_0-9]*)\s*:\s*'/gm;
      let m; while ((m = re.exec(body))) out.push(m[1]);
      return out.join(',');
    }
    return Object.keys(C.INTENT_STATE_FACE).join(',') === keysOf(intentBlock) &&
      Object.keys(C.APPROVAL_STATE_FACE).join(',') === keysOf(approvalBlock);
  })(), { intent: Object.keys(C.INTENT_STATE_FACE), approval: Object.keys(C.APPROVAL_STATE_FACE) });

check('B9 ★★★ 未知 kind 不编解释：说一句诚实的"记下了一项变化"，并标 known:false',
  (function () {
    const f = C.changeKindFace('A_KIND_FROM_THE_FUTURE');
    return f.known === false && f.face === C.COPY.changeUnknown && f.tone === C.TONE.NOTE;
  })());

/* ══ C · 归属：用 canonical 自己的键比出来 ════════════════════════════ */
section('C · 归属：只认 canonical 自己的键（收礼者不算）');

const W = 'econ_wallet_a1';

check('C1 ★★★ walletId 列命中（钱包那一格里就有这个值）',
  C.changeBelongsTo({ walletId: W, payload: {} }, 'a1', W) === true &&
  C.changeBelongsTo({ walletId: 'econ_wallet_zzz', payload: {} }, 'a1', W) === false);

check('C2 ★★★★ payload 里的 ownerId / buyerId / agentId 命中（逐字比较）',
  C.changeBelongsTo({ walletId: null, payload: { ownerId: 'a1' } }, 'a1', W) === true &&
  C.changeBelongsTo({ walletId: null, payload: { buyerId: 'a1' } }, 'a1', W) === true &&
  C.changeBelongsTo({ walletId: null, payload: { agentId: 'a1' } }, 'a1', W) === true &&
  C.changeBelongsTo({ walletId: null, payload: { buyerId: 'a2' } }, 'a1', W) === false);

check('C3 ★★★ 账本交易那一端也命中（payload.wallets[].walletId）',
  C.changeBelongsTo({ walletId: null, payload: { wallets: [{ walletId: W }] } }, 'a1', W) === true &&
  C.changeBelongsTo({ walletId: null, payload: { wallets: [{ walletId: 'econ_wallet_b' }] } }, 'a1', W) === false);

check('C4 ★★★★★ 收礼者**不**算归属：一次"买给别人"不是收礼者的余额变化',
  C.changeBelongsTo({ walletId: null, payload: { buyerId: 'a2', recipientId: 'a1' } }, 'a1', W) === false,
  'recipientId 只被当作"别人"');

check('C5 ★★★ 没有归属时什么都不算（不猜）',
  C.changeBelongsTo({ walletId: W, payload: { buyerId: 'a1' } }, null, W) === false &&
  C.changeBelongsTo(null, 'a1', W) === false);

/* ══ D · 时间线 ════════════════════════════════════════════════════ */
section('D · 时间线：按 canonical 的 revision 倒序，截断时说出来');

const CHANGES = {
  ok: true, revision: 61, truncated: false,
  changes: [
    { revision: 10, kind: 'WALLET_OPENED', entityId: W, walletId: W, at: 1000, payload: { ownerId: 'a1' } },
    { revision: 20, kind: 'ECONOMY_INITIAL_CREDIT_BOOTSTRAPPED', entityId: W, walletId: W, at: 2000,
      payload: { ownerId: 'a1', amountMinor: '1000000', currency: 'IB_CREDIT' } },
    { revision: 30, kind: 'AGENT_INTENT_PROPOSED', entityId: 'econ_agent_intent_1', walletId: null, at: 3000,
      payload: { agentId: 'a1', agentIntentId: 'econ_agent_intent_1', productId: 'econ_product_1', units: 1, reason: '用于生成更多视觉素材' } },
    { revision: 40, kind: 'APPROVAL_REQUESTED', entityId: 'econ_approval_1', walletId: null, at: 4000,
      payload: { buyerId: 'a1', approvalId: 'econ_approval_1', quoteId: 'econ_quote_1', amountMinor: '500', currency: 'IB_CREDIT', units: 1 } },
    { revision: 45, kind: 'APPROVAL_APPROVED', entityId: 'econ_approval_1', walletId: null, at: 4500,
      payload: { buyerId: 'a1', approvalId: 'econ_approval_1', productId: 'econ_product_1' } },
    { revision: 50, kind: 'PURCHASE_RESERVED', entityId: 'econ_purchase_1', walletId: W, at: 4800,
      payload: { buyerId: 'a1', purchaseId: 'econ_purchase_1', productId: 'econ_product_1', amountMinor: '500', currency: 'IB_CREDIT' } },
    { revision: 60, kind: 'PURCHASE_COMPLETED', entityId: 'econ_purchase_1', walletId: W, at: 5000,
      payload: { buyerId: 'a1', purchaseId: 'econ_purchase_1', productId: 'econ_product_1', amountMinor: '500', currency: 'IB_CREDIT', units: 1 } },
    /* 另一个角色的事件：必须**不**进这个角色的时间线 */
    { revision: 61, kind: 'PURCHASE_COMPLETED', entityId: 'econ_purchase_9', walletId: 'econ_wallet_zzz', at: 5100,
      payload: { buyerId: 'a9', purchaseId: 'econ_purchase_9', amountMinor: '900', currency: 'IB_CREDIT' } }
  ]
};

check('D1 ★★★★ 有数据时：七条属于这个角色的事件按 revision **倒序**（最新在前）',
  (function () {
    const tl = C.buildTimelineModel(CHANGES, { ownerId: 'a1', walletId: W });
    return tl.read === true && tl.rows.length === 7 && tl.rows[0].revision === 60 &&
      tl.rows[6].revision === 10 &&
      tl.rows.map(r => r.revision).join(',') === '60,50,45,40,30,20,10';
  })(), C.buildTimelineModel(CHANGES, { ownerId: 'a1', walletId: W }).rows.map(r => r.revision));

check('D2 ★★★★ 另一个角色的那条**没有**进来，而且被计进 unattributed（不是被静默丢掉）',
  (function () {
    const tl = C.buildTimelineModel(CHANGES, { ownerId: 'a1', walletId: W });
    return tl.unattributed === 1 && tl.fetched === 8 &&
      tl.rows.every(r => r.refs.purchaseId !== 'econ_purchase_9');
  })());

check('D3 ★★★ 每条都带 revision / 时间 / 人话 / 语气 / 可指回的编号',
  (function () {
    const r = C.buildTimelineModel(CHANGES, { ownerId: 'a1', walletId: W }).rows[0];
    return r.revision === 60 && r.kind === 'PURCHASE_COMPLETED' && r.face === '购买完成' &&
      r.tone === C.TONE.MONEY && typeof r.atText === 'string' && r.atText.length >= 10 &&
      r.refs.purchaseId === 'econ_purchase_1' && r.amountText.indexOf('5.00') >= 0 &&
      r.quantity === 1;
  })(), C.buildTimelineModel(CHANGES, { ownerId: 'a1', walletId: W }).rows[0]);

check('D4 ★★★★ 最近变化取的是**最近一次真的动了钱**的那一条（不是随意一条）',
  (function () {
    const tl = C.buildTimelineModel(CHANGES, { ownerId: 'a1', walletId: W });
    return tl.lastBalanceChange != null && tl.lastBalanceChange.revision === 60 &&
      tl.lastBalanceChange.kind === 'PURCHASE_COMPLETED';
  })());

check('D5 ★★★★ 截断原样带出（"最近什么都没发生"是这个页面最危险的假信息）',
  (function () {
    const tl = C.buildTimelineModel(
      Object.assign({}, CHANGES, { truncated: true }), { ownerId: 'a1', walletId: W });
    return tl.truncated === true;
  })());

check('D6 ★★★ 空 change log 是"还没有任何记录"，不是"读不到"',
  (function () {
    const empty = C.buildTimelineModel({ ok: true, revision: 0, changes: [] }, { ownerId: 'a1', walletId: W });
    const down = C.buildTimelineModel({ ok: false, error: 'home-node-unreachable' }, { ownerId: 'a1', walletId: W });
    return empty.read === true && empty.empty === true && empty.rows.length === 0 &&
      down.read === false && down.empty === false && down.error === 'home-node-unreachable';
  })());

check('D7 ★★ 时间线在页面上有上限（不是无底洞），上限就是常量',
  (function () {
    const many = { ok: true, revision: 100, changes: [] };
    for (let i = 1; i <= 60; i += 1) {
      many.changes.push({ revision: i, kind: 'RESERVATION_CREATED', entityId: 'x' + i, walletId: W, at: 1000 + i, payload: {} });
    }
    const tl = C.buildTimelineModel(many, { ownerId: 'a1', walletId: W });
    return tl.rows.length === C.TIMELINE_KEEP && tl.rows[0].revision === 60;
  })());

/* ══ E · 经济活动：§3 的 join ══════════════════════════════════════ */
section('E · 经济活动：来源三词各有证据，三步各有 canonical 时间');

const PRODUCTS = { ok: true, products: [{ productId: 'econ_product_1', name: '数字绘画额度', unitName: 'computeUnit' }] };
const API_CONFIGS = [{ id: 'a1', nickname: '阿尔法' }];

const PURCHASES = { ok: true, purchases: [
  /* ① 完整的：Agent 提议 → 用户批准 → 系统完成 */
  { purchaseId: 'econ_purchase_1', productId: 'econ_product_1', status: 'COMPLETED', completed: true,
    amountMinor: '500', currency: 'IB_CREDIT', createdAt: 4000, completedAt: 5000,
    approvalMode: 'APPROVAL', units: 1, quoteId: 'econ_quote_1', selfDirected: true,
    approval: { approvalId: 'econ_approval_1', status: 'CONSUMED', decidedBy: 'user:user',
      decidedAt: 4500, consumedByPurchaseId: 'econ_purchase_1' } },
  /* ② 自主放行：**没有**用户批准这一步 */
  { purchaseId: 'econ_purchase_2', productId: 'econ_product_1', status: 'COMPLETED', completed: true,
    amountMinor: '300', currency: 'IB_CREDIT', createdAt: 2000, completedAt: 2500,
    approvalMode: 'AUTO_ALLOW', units: 1, quoteId: 'econ_quote_2', selfDirected: true, approval: null },
  /* ③ 早于授权层：approvalMode === null */
  { purchaseId: 'econ_purchase_3', productId: 'econ_product_1', status: 'RELEASED', completed: false,
    amountMinor: '800', currency: 'IB_CREDIT', createdAt: 1000, completedAt: null,
    approvalMode: null, units: null, quoteId: 'econ_quote_3', selfDirected: true, approval: null }
] };

const INTENTS = { ok: true, intents: [
  { agentIntentId: 'econ_agent_intent_1', agentId: 'a1', productId: 'econ_product_1', state: 'COMPLETED',
    reason: '用于生成更多视觉素材', units: 1, createdAt: 3000, purchaseId: 'econ_purchase_1',
    approvalId: 'econ_approval_1', quoteId: 'econ_quote_1' },
  /* 连不上任何 Purchase 的一条（还在等决定） */
  { agentIntentId: 'econ_agent_intent_2', agentId: 'a1', productId: 'econ_product_1', state: 'WAITING_APPROVAL',
    reason: '想再画一批分镜', units: 2, createdAt: 6000, purchaseId: null,
    approvalId: 'econ_approval_2', quoteId: null }
] };

function activityOf(over) {
  const tl = C.buildTimelineModel(CHANGES, { ownerId: 'a1', walletId: W });
  return C.buildActivityModel(
    (over && over.purchases) || PURCHASES,
    (over && over.intents) || INTENTS,
    PRODUCTS, tl, { apiConfigs: API_CONFIGS, archivedConfigs: [] });
}
const ACT = activityOf({});

check('E1 ★★★★ 三条购买都连出来了，而且按 canonical 的 createdAt **倒序**（canonical 给的是 ASC）',
  ACT.count === 3 &&
  ACT.rows.map(r => r.purchaseId).join(',') === 'econ_purchase_1,econ_purchase_2,econ_purchase_3',
  ACT.rows.map(r => r.purchaseId));

check('E2 ★★★★★ 来源三词齐全，而且**每一词都有一条证据**（完整的那一条）',
  (function () {
    const r = ACT.rows[0];
    const keys = r.source.map(s => s.key).join(',');
    const faces = r.source.map(s => s.face).join(' / ');
    return keys === 'agent,user,system' &&
      faces === 'Agent 提议 / 用户批准 / 系统完成';
  })(), ACT.rows[0].source);

check('E3 ★★★★★ 自主放行的那一条**没有**"用户批准"，多的是"按自主规则放行"',
  (function () {
    const r = ACT.rows[1];
    const keys = r.source.map(s => s.key).join(',');
    return keys === 'auto,system' &&
      r.source.map(s => s.face).indexOf('用户批准') < 0;
  })(), ACT.rows[1].source);

check('E4 ★★★★★ 没完成的那一条**没有**"系统完成"（来源不是写死的三行）',
  (function () {
    const r = ACT.rows[2];
    return r.completed === false && r.source.length === 0 &&
      r.steps[2].stateFace === '已退回';
  })(), ACT.rows[2].source);

check('E5 ★★★★★ 角色名只在目录里真的有时才出现；而且是**角色名**不是 id',
  (function () {
    const withName = ACT.rows[0].source.filter(s => s.key === 'agent')[0];
    const noName = C.buildActivityModel(PURCHASES, INTENTS, PRODUCTS,
      C.buildTimelineModel(CHANGES, { ownerId: 'a1', walletId: W }),
      { apiConfigs: [{ id: 'zzz', nickname: '别人' }] }).rows[0]
      .source.filter(s => s.key === 'agent')[0];
    return withName.who === '由 阿尔法 发起' && noName.who === null &&
      JSON.stringify(ACT.rows).indexOf('"a1"') < 0;
  })(), ACT.rows[0].source);

check('E6 ★★★★ 三步各有 canonical 的时间与状态（Intent → Approval → Purchase）',
  (function () {
    const r = ACT.rows[0];
    const keys = r.steps.map(s => s.key).join(',');
    return keys === 'intent,approval,purchase' &&
      r.steps[0].present === true && r.steps[0].stateFace === '已经完成' &&
      r.steps[1].present === true && r.steps[1].stateFace === '已经用掉了' &&
      r.steps[2].present === true && r.steps[2].stateFace === '已完成';
  })(), ACT.rows[0].steps);

check('E7 ★★★★★ 三步"没有发生"的三种原因**措辞各不相同**（否则它们会被混成同一个答案）',
  (function () {
    const auto = ACT.rows[1].steps[1];
    const beforeAuth = ACT.rows[2].steps[1];
    const noIntent = ACT.rows[2].steps[0];
    return auto.present === false && auto.absentText === C.COPY.stepAutoNoRecord &&
      beforeAuth.present === false && beforeAuth.absentText === C.COPY.stepBeforeAuth &&
      noIntent.present === false && noIntent.absentText === C.COPY.stepAbsent &&
      auto.absentText !== beforeAuth.absentText && beforeAuth.absentText !== noIntent.absentText;
  })(), { auto: ACT.rows[1].steps[1].absentText, beforeAuth: ACT.rows[2].steps[1].absentText });

check('E8 ★★★★ 决定**什么时候**做的是从 canonical change log 读的（Purchase 行上没有这个事实）',
  (function () {
    const r = ACT.rows[0];
    /* 时间线里 APPROVAL_APPROVED 在 at=4500；approval.decidedAt 也是 4500。
       两者都在，而 intent 那一步用的是 intent.createdAt=3000。 */
    return r.steps[0].at === 3000 && r.steps[1].at === 4500 && r.steps[2].at === 5000;
  })(), ACT.rows[0].steps.map(s => [s.key, s.at]));

check('E9 ★★★ 送给别人与给自己是两个键（canonical 这么说，这一层原样带出）',
  ACT.rows[0].selfDirected === true && ACT.rows[0].recipientId === null);

/* ══ F · 支出说明 ══════════════════════════════════════════════════ */
section('F · 支出说明：合计是这一页算的，而且只算已完成的');

const SPEND = C.buildSpendingModel(ACT, {});

check('F1 ★★★★ 合计只算已完成的两次，而且是整数最小单位相加（500 + 300 = 800）',
  SPEND.count === 2 && SPEND.totalMinor === 800 &&
  SPEND.totalText.indexOf('8.00') >= 0, { total: SPEND.totalText, minor: SPEND.totalMinor });

check('F2 ★★★ 没完成的那一次**不进**合计（它连一行都不占）',
  SPEND.rows.every(r => r.purchaseId !== 'econ_purchase_3') && SPEND.anyCompleted === true);

check('F3 ★★★★★ 逐字自述"这个合计是这一页算的" —— 它**不是**第二个权威',
  SPEND.computedByThisPage === true);

check('F4 ★★★★ 金额读不到的行不进合计，并且**单独计数**（宁可合计小一点，也不要编一个数）',
  (function () {
    const broken = { ok: true, purchases: [
      { purchaseId: 'econ_purchase_1', productId: 'econ_product_1', status: 'COMPLETED', completed: true,
        amountMinor: null, currency: 'IB_CREDIT', createdAt: 1, completedAt: 2, approvalMode: 'APPROVAL', units: 1 }
    ] };
    const act = C.buildActivityModel(broken, null, PRODUCTS, null, {});
    const sp = C.buildSpendingModel(act, {});
    return sp.count === 0 && sp.missingAmountRows === 1 && sp.totalMinor === 0 && sp.anyCompleted === true;
  })());

check('F5 ★★★★★ 购买窗口满时合计**明说**它不是全部（canonical 是按最早排的）',
  (function () {
    const many = [];
    for (let i = 0; i < C.LIMITS.PURCHASES; i += 1) {
      many.push({ purchaseId: 'econ_purchase_' + i, productId: 'econ_product_1', status: 'COMPLETED',
        completed: true, amountMinor: '100', currency: 'IB_CREDIT', createdAt: i, completedAt: i + 1,
        approvalMode: 'AUTO_ALLOW', units: 1 });
    }
    const act = C.buildActivityModel({ ok: true, purchases: many }, null, PRODUCTS, null, {});
    const sp = C.buildSpendingModel(act, {});
    return act.saturated === true && sp.saturated === true && sp.complete === false;
  })());

/* ══ G · §4 理由：一个字节都不改 ══════════════════════════════════ */
section('G · §4 理由：逐字搬运，不摘要、不改写、不再调模型');

const EX = C.buildIntentExplanationModel(INTENTS, PRODUCTS, {});

check('G1 ★★★★★ 理由**逐字**：前后空格、换行、标点全部原样保留',
  (function () {
    const weird = '  为了「分镜 03」：需要 1 份，因为上次那批\n不够用。  ';
    const res = { ok: true, intents: [
      { agentIntentId: 'econ_agent_intent_9', agentId: 'a1', productId: 'econ_product_1',
        state: 'PROPOSED', reason: weird, units: 1, createdAt: 1 }
    ] };
    const r = C.buildIntentExplanationModel(res, PRODUCTS, {});
    return r.rows[0].reason === weird;
  })());

check('G2 ★★★★★ 三句结构性的自述都在：原样 / 没有模型摘要 / 理由不是权限',
  EX.rows[0].reasonVerbatim === true && EX.rows[0].reasonSummarizedByAi === false &&
  EX.rows[0].reasonIsAuthority === false &&
  EX.reasonSummarizedByAi === false && EX.reasonIsAuthority === false && EX.reasonIsTelemetry === true);

check('G3 ★★★★ 没有写下原因时说一句诚实的"这次请求没有写下原因"，而不是一个空串',
  (function () {
    const res = { ok: true, intents: [
      { agentIntentId: 'econ_agent_intent_8', agentId: 'a1', productId: 'econ_product_1',
        state: 'PROPOSED', reason: null, units: 1, createdAt: 1 }
    ] };
    const r = C.buildIntentExplanationModel(res, PRODUCTS, {}).rows[0];
    return r.reason === null && r.reasonSummarizedByAi === false &&
      C.COPY.whyNoReason.length > 0;
  })());

check('G4 ★★★ 数量、目标、状态全部来自 canonical（数量就是 intent.units）',
  EX.rows[0].unitsText === '2' && EX.rows[0].name === '数字绘画额度' &&
  EX.rows[0].stateFace === '在等你决定' && EX.rows[1].unitsText === '1');

check('G5 ★★★★★ 这一层不认识任何模型：没有 Provider 名、没有传输原语，摘要位恒为 false',
  /* ★ 这里刻意不把 `summarize` 当禁用词：本层**自己**有一个字段叫
     `reasonSummarizedByAi`，它的值恒为 false —— 那正是这条纪律的形状。
     判的是"有没有真的去摘要"，而不是"有没有出现过那个英文词"。 */
  ['deepseek', 'claude', 'openai', 'gpt-4', 'gpt-3']
    .every(w => coreCode.toLowerCase().indexOf(w) < 0) &&
  !/\bfetch\s*\(/.test(coreCode) && !/XMLHttpRequest/.test(coreCode) &&
  /reasonSummarizedByAi:\s*false/.test(coreCode) &&
  /reasonVerbatim:\s*true/.test(coreCode));

/* ══ H · §7 高级信息 ══════════════════════════════════════════════ */
section('H · §7 高级信息：只有四个编号，默认折叠');

const AUDIT = C.buildAuditModel(ACT, EX, {});

check('H1 ★★★★ 默认折叠（模型里的初值就是 false）', AUDIT.open === false);

check('H2 ★★★ 每一行只有四个编号：Intent / Approval / Purchase / Quote',
  (function () {
    const keys = Object.keys(AUDIT.rows[0].refs).join(',');
    return keys === 'agentIntentId,approvalId,purchaseId,quoteId' &&
      AUDIT.rows[0].refs.agentIntentId === 'econ_agent_intent_1' &&
      AUDIT.rows[0].refs.purchaseId === 'econ_purchase_1';
  })(), AUDIT.rows[0].refs);

check('H3 ★★★★★ 逐字否认四样东西：数据库行 / 账本内部 / 版本号 / 迁移状态',
  AUDIT.showsDatabaseRows === false && AUDIT.showsLedgerInternals === false &&
  AUDIT.showsRevision === false && AUDIT.showsMigrationState === false);

check('H4 ★★★ 还没有 Purchase 的那条 intent 也在里面（最需要它的时候读得到）',
  (function () {
    const ids = AUDIT.rows.map(r => r.refs.agentIntentId);
    /* 三次购买各一行（其中两次没有 intent，两格就是"—"），再加上那条
       还在等决定、连 Purchase 都还没有的 intent。 */
    return ids.indexOf('econ_agent_intent_2') >= 0 && AUDIT.count === 4 &&
      AUDIT.rows.map(r => r.key).indexOf('econ_purchase_1') >= 0;
  })(), AUDIT.rows.map(r => r.refs.agentIntentId));

/* ══ I · 文案纪律 ══════════════════════════════════════════════════ */
section('I · 文案纪律：禁用词 / emoji / 金融化的说法');

const blob = [JSON.stringify(C.COPY), JSON.stringify(C.CHANGE_KIND_FACE),
  JSON.stringify(C.INTENT_STATE_FACE), JSON.stringify(C.APPROVAL_STATE_FACE)].join('\n');

check('I1 ★★★ 文案里没有 §3 的禁用词（充值 / 提现 / 转账 / 银行卡 / 现金 / 人民币 / 美元 / 账户价值 / 支付）',
  ['充值', '提现', '转账', '银行卡', '现金', '人民币', '美元', '账户价值', '支付', '法币', '¥', '￥']
    .every(w => blob.indexOf(w) < 0),
  ['充值', '提现', '转账', '银行卡', '现金', '人民币', '美元', '账户价值', '支付', '法币']
    .filter(w => blob.indexOf(w) >= 0));

check('I2 ★★★ 文案与代码里都没有 emoji',
  !/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/u.test(coreCode) &&
  !/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/u.test(blob) &&
  !/[💰🪙💳🛒✨🎉]/u.test(coreCode + blob));

check('I3 ★★★ 没有金融化的说法（增长率 / 收益率 / 资产价值 / 收益）：§2 明令不要',
  ['增长率', '收益率', '资产价值', '年化', '利息', '汇率', '涨跌', '盈亏']
    .every(w => blob.indexOf(w) < 0));

check('I4 ★★★ 没有 Compute 的禁用说法（Provider quota / API 余额 / Token 余额）',
  ['Provider', 'provider', 'Token', 'token', 'API 余额', 'DeepSeek', 'Claude', 'OpenAI']
    .every(w => blob.indexOf(w) < 0));

check('I5 ★★★★ 时间线是"解释层"而不是"事件系统"：源码里没有 economy_events 这种表',
  ['economy_events', 'economy_event_log', 'CREATE TABLE', 'INSERT INTO']
    .every(w => coreSrc.indexOf(w) < 0));

/* ══ J · 整页模型不回归 ════════════════════════════════════════════ */
section('J · 整页模型：P22-17 的七个面一个都没少，新的五个面各自到位');

const PV = C.buildPageView({
  owner: 'a1', stores: { ok: true, stores: [] }, products: PRODUCTS, intents: INTENTS,
  wallet: { ok: true, wallet: { walletId: W, owner: { type: 'character', id: 'a1' }, currency: 'IB_CREDIT',
    state: 'READY', balanceKnown: true, availableBalanceMinor: '1245000', reservedBalanceMinor: '0' } },
  policy: null, budgetSnapshot: null,
  inventory: { ok: true, entries: [] }, purchases: PURCHASES, changes: CHANGES,
  apiConfigs: API_CONFIGS, archivedConfigs: []
});

check('J1 ★★★★ P22-17 的七个面全在（本阶段不删不改上一阶段的任何一格）',
  PV.wallet.primary === '12,450.00' && PV.stores.rows.length === 0 &&
  PV.products.count === 1 && PV.assets.total === 0 && PV.purchases.count === 3 &&
  PV.budget.present === false && PV.explanations.count === 2);

check('J2 ★★★★★ P22-18 的五个新面全在，而且都读到了同一个归属',
  PV.timeline.rows.length === 7 && PV.activity.count === 3 &&
  PV.spending.count === 2 && PV.explanations.count === 2 && PV.audit.open === false &&
  PV.timeline.ownerId === 'a1');

check('J3 ★★★★ 钱包里"最近变化"的来源就是时间线（同一份数据，没有第二个来源）',
  PV.timeline.lastBalanceChange != null &&
  PV.timeline.lastBalanceChange.face === '购买完成');

/* ══ K · 跨文件：§5 / §6 / §11 的边界 ══════════════════════════════ */
section('K · 跨文件边界：没有新写入口，没有动 P22-15/16 的实现');

const browserFiles = ['assets/js/economy-approval-core.js', 'assets/js/economy-approval.js',
  'assets/js/economy-configuration-core.js', 'assets/js/economy-configuration.js',
  CORE_REL, 'assets/js/economy-shell.js'];
const browserCode = browserFiles.map(f => strip(read(f))).join('\n');

check('K1 ★★★★ 全部浏览器侧经济文件里没有 batchApprove / autoApprove / approveAll',
  ['batchApprove', 'autoApprove', 'approveAll'].every(w => browserCode.indexOf(w) < 0));

check('K2 ★★★★★ P22-15 的 approvalDecision 与 P22-16 的 economyConfiguration 都还在，而且签名没变',
  /approvalDecision\s*:\s*function\s*\(\s*body\s*\)/.test(read('assets/js/economy-approval.js')) ||
  /approvalDecision/.test(read('assets/js/home-node-client.js')),
  '写方法仍然只在 client 上，UI 只调用它');

check('K3 ★★★★★ 没有新增任何 POST /economy/*（§11 明令）',
  browserFiles.every(f => !/['"`]\/economy\/[a-z-]*['"`][\s\S]{0,80}POST/.test(read(f))) &&
  !/method\s*:\s*['"]POST['"]/.test(browserCode));

check('K4 ★★★★ 配置面新增的两句话在源码里，而且它们是**话**（没有新输入、没有新按钮）',
  (function () {
    const src = read('assets/js/economy-configuration.js');
    const core = read('assets/js/economy-configuration-core.js');
    return core.indexOf('这是限制，不是余额。') >= 0 &&
      core.indexOf('启用自主购买 ≠ 绕过审批。') >= 0 &&
      /function experienceNotice\(mark, title, body\)/.test(src) &&
      /* 这一块里没有 input / select / textarea */
      !/experienceNotice[\s\S]{0,400}createElement\('(input|select|textarea)'\)/.test(src);
  })());

console.log('\n结果: ' + checks + ' 通过, ' + failures + ' 失败');
if (failures) process.exit(1);
