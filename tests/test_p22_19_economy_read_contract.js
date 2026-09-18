/* ══════════════════════════════════════════════════════════════════════
   P22-19 · Economy Read Contract Freeze

   §9 要求把四个 UI（P22-15 / P22-16 / P22-17 / P22-18）的
      READS · WRITES · OPTIONAL_READS · AUTHORITY_FIELDS · DERIVED_FIELDS
   写成**机器可检查**的契约：以后有人改 endpoint / projection 时，
   不是 UI 静默坏掉，而是这份测试变红。

   ★ 这里的 READS **不是**抄一遍常量，而是从各个 core 的**真实导出**里读出来
     再与声明比对 —— 于是"声明"与"实现"分开了，两者漂移会当场变红。
   ★ 不造新的 runtime framework：就是测试常量 + 从 core 抽。

   另外三节：
     D · 归属规则的**唯一实现**（纯层里不许再有第二份）
     E · §10 高级信息仍然只是调试面（默认折叠 + 不含数据库行/账本内部/版本号/迁移状态）
     F · §7 完整性的三态在**页面文案**上就是三句不同的话
     G · §14 本阶段禁止的东西**一个都没出现**
   ══════════════════════════════════════════════════════════════════════ */
'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }
function stripComments(src) {
  return String(src).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:\\])\/\/[^\n\r]*/g, '$1');
}
function stripAll(src) {
  return stripComments(src)
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``');
}

let failures = 0;
let checks = 0;
function check(name, cond, extra) {
  checks += 1;
  if (cond) { console.log('  ✔ ' + name); return true; }
  failures += 1;
  console.error('  ✖ ' + name + (extra !== undefined ? ' — ' + JSON.stringify(extra, replacer) : ''));
  return false;
}
function section(title) { console.log('\n── ' + title + ' ' + '─'.repeat(Math.max(0, 60 - title.length))); }
function replacer(k, v) { return typeof v === 'bigint' ? v.toString() + 'n' : v; }
function J(v) { return JSON.stringify(v, replacer); }

/* ── 沙箱：与 P22-15/16/17/18 的纯层测试同款 ───────────────────────── */
function sandbox() {
  const b = { IB: {}, window: null, document: null, console: { log() {}, warn() {}, error() {} },
    setTimeout: setTimeout, clearTimeout: clearTimeout };
  b.window = b; b.self = b;
  return vm.createContext(b);
}
function loadCores() {
  const s = sandbox();
  vm.runInContext(read('assets/js/economy-configuration-core.js'), s, { filename: 'economy-configuration-core.js' });
  vm.runInContext(read('assets/js/economy-approval-core.js'), s, { filename: 'economy-approval-core.js' });
  vm.runInContext(read('assets/js/economy-shell-core.js'), s, { filename: 'economy-shell-core.js' });
  return { cfg: s.IB.economyConfigurationCore, approval: s.IB.economyApprovalCore, shell: s.IB.economyShellCore };
}
const CORES = loadCores();

console.log('P22-19 · Economy Read Contract Freeze');

/* ══ A · 四个 UI 的读依赖契约 ══════════════════════════════════════ */
section('A · 四个 UI 的 READ / WRITE 契约（声明 × 真实导出）');

/* ★ 声明。每条 READS 都指向一个**既有**的 GET；WRITES 里 null 表示这一页
   一个写面都没有。 */
const UI_CONTRACT = Object.freeze({
  P22_15_APPROVAL: {
    core: 'economy-approval-core.js',
    reads: {
      INTENTS: '/economy/intents',
      APPROVALS: '/economy/approvals',
      PRODUCTS: '/economy/products',
      SECURITY: '/security'
    },
    writes: { DECISION_PATH: '/internal/economy/approval-decision' },
    optionalReads: [],
    authorityFields: ['approvalId', 'status', 'decidedBy', 'decidedAt', 'expiresAt',
      'bindingFingerprint', 'authorityOutcome', 'authorityReasonCode'],
    derivedFields: ['effectiveStatus', 'faces', 'canDecide', 'reasonText']
  },
  P22_16_CONFIGURATION: {
    core: 'economy-configuration-core.js',
    reads: {
      WALLET: '/economy/wallet',
      POLICY: '/economy/policy',
      AUTONOMY_POLICY: '/economy/autonomy-policy',
      BUDGET: '/economy/budget',
      SECURITY: '/security'
    },
    writes: { WRITE_PATH: '/internal/economy/configuration' },
    optionalReads: [],
    /* 这一页显示/提交的都是 canonical 的字段本身（不是它算出来的）。 */
    authorityFields: ['ownerId', 'currency', 'amountMinor', 'limits', 'termEndsAt',
      'autonomyLevel', 'enabled', 'approvalAboveMinor', 'allowedProductKinds',
      'allowedSettlementTypes', 'allowGift', 'ifRevision', 'cachedBalanceMinor'],
    derivedFields: ['commandList', 'ownerOptions', 'limitsDraft', 'scaleText']
  },
  P22_17_STORE: {
    core: 'economy-shell-core.js',
    reads: {
      WALLET: '/economy/wallet', STORES: '/economy/stores', PRODUCTS: '/economy/products',
      INVENTORY: '/economy/inventory', PURCHASES: '/economy/purchases', INTENTS: '/economy/intents',
      POLICY: '/economy/policy', BUDGET: '/economy/budget'
    },
    writes: {},
    optionalReads: ['/economy/changes'],
    authorityFields: ['walletId', 'cachedBalanceMinor', 'availableBalanceMinor', 'reservedBalanceMinor',
      'state', 'balanceKnown', 'unitPriceMinor', 'quantity', 'assetKind', 'amountMinor',
      'purchaseId', 'productId', 'storeId', 'status', 'ownerId', 'currency', 'limits'],
    derivedFields: ['assetCounts', 'purchaseCount', 'saturated', 'visualVariant', 'priceText']
  },
  P22_18_EXPERIENCE: {
    core: 'economy-shell-core.js',
    reads: {
      WALLET: '/economy/wallet', STORES: '/economy/stores', PRODUCTS: '/economy/products',
      INVENTORY: '/economy/inventory', PURCHASES: '/economy/purchases', INTENTS: '/economy/intents',
      POLICY: '/economy/policy', BUDGET: '/economy/budget'
    },
    writes: {},
    /* ★ P22-19：第九条读面**是必需的**（不是可选），因为时间线没有它就没有内容。
       它仍然**不**在 `READS` 里 —— P22-17 的 A4 逐字钉住"八条读面"，那是
       P22-17 那一阶段的冻结事实；P22-18 把它另立为 CHANGE_READ。 */
    optionalReads: [],
    extraReads: { CHANGE_READ: '/economy/changes' },
    authorityFields: ['revision', 'kind', 'entityId', 'walletId', 'transactionId', 'at', 'payload',
      'agentIntentId', 'approvalId', 'purchaseId', 'quoteId', 'reason', 'state',
      'authorityOutcome', 'authorityReasonCode', 'completed'],
    derivedFields: ['face', 'tone', 'knownKind', 'amountText', 'atText', 'source',
      'steps', 'spendTotalMinor', 'completeness']
  }
});

function pathsOf(obj) { return Object.keys(obj).map(k => obj[k]).sort(); }

check('A1 ★★★★★ P22-15 的声明与 core 的真实导出**逐字**一致（写面是 `ID.DECISION_PATH`，' +
  '而且它**只有**这一条、且不在 /economy/ 下）',
  (function () {
    const c = CORES.approval;
    const declared = UI_CONTRACT.P22_15_APPROVAL;
    return J(pathsOf(c.READS)) === J(pathsOf(declared.reads)) &&
      c.ID != null && c.ID.DECISION_PATH === declared.writes.DECISION_PATH &&
      Object.keys(declared.writes).length === 1 &&
      declared.writes.DECISION_PATH.indexOf('/economy/') !== 0 &&
      /* 这一页没有任何经济写方法 */
      typeof c.createPurchase === 'undefined' && typeof c.propose === 'undefined';
  })(), { declared: pathsOf(UI_CONTRACT.P22_15_APPROVAL.reads), actual: pathsOf(CORES.approval.READS), path: CORES.approval.ID && CORES.approval.ID.DECISION_PATH });

check('A2 ★★★★★ P22-16 的声明与 core 的真实导出**逐字**一致（含唯一的写面）',
  (function () {
    const c = CORES.cfg;
    return J(pathsOf(c.READS)) === J(pathsOf(UI_CONTRACT.P22_16_CONFIGURATION.reads)) &&
      c.WRITE_PATH === UI_CONTRACT.P22_16_CONFIGURATION.writes.WRITE_PATH &&
      Object.keys(UI_CONTRACT.P22_16_CONFIGURATION.writes).length === 1;
  })(), { declared: pathsOf(UI_CONTRACT.P22_16_CONFIGURATION.reads), actual: pathsOf(CORES.cfg.READS) });

check('A3 ★★★★★ P22-17 的声明与 core 的真实导出**逐字**一致，且它**一个写面都没有**（' +
  '禁止把 Agent 的购买意图偷拿来当用户购买接口）',
  (function () {
    const c = CORES.shell;
    const c17 = UI_CONTRACT.P22_17_STORE;
    return J(pathsOf(c.READS)) === J(pathsOf(c17.reads)) &&
      Object.keys(c17.writes).length === 0 &&
      c.readPathList().length === 8 &&
      c.readPathList().sort().join('|') === pathsOf(c17.reads).join('|') &&
      /* 这一层连"写方法"的名字都不该出现 */
      typeof c.approvalDecision === 'undefined' && typeof c.economyConfiguration === 'undefined';
  })(), { declared: pathsOf(UI_CONTRACT.P22_17_STORE.reads), actual: pathsOf(CORES.shell.READS) });

check('A4 ★★★★★ P22-18 除同样的八条之外**另有**第九条（change log），' +
  '而且它不在 READS 里（P22-17 的 A4 冻结事实不被改写）',
  (function () {
    const c = CORES.shell;
    const c18 = UI_CONTRACT.P22_18_EXPERIENCE;
    return c.CHANGE_READ === c18.extraReads.CHANGE_READ &&
      c.readPathList().indexOf(c.CHANGE_READ) < 0 &&
      J(pathsOf(c18.reads)) === J(pathsOf(c.READS)) &&
      c.readPathList().length === 8;
  })(), { change: CORES.shell.CHANGE_READ, inReads: CORES.shell.readPathList().indexOf(CORES.shell.CHANGE_READ) });

check('A5 ★★★★★ 四条契约里的每一个读路径都**真的是** canonical 的一条 GET（' +
  '与 http.js 的路由表逐个核对，不是在测试里手写的字符串）',
  (function () {
    const httpSrc = stripComments(read('services/home-node/http.js'));
    const declared = [];
    for (const ui of Object.keys(UI_CONTRACT)) {
      for (const p of pathsOf(UI_CONTRACT[ui].reads)) declared.push(p);
      for (const p of UI_CONTRACT[ui].optionalReads || []) declared.push(p);
      if (UI_CONTRACT[ui].extraReads) for (const p of pathsOf(UI_CONTRACT[ui].extraReads)) declared.push(p);
    }
    const unique = Array.from(new Set(declared));
    const missing = unique.filter(p => httpSrc.indexOf("'" + p + "'") < 0);
    return missing.length === 0 && unique.length >= 10;
  })(), Array.from(new Set(Object.keys(UI_CONTRACT).flatMap(k => pathsOf(UI_CONTRACT[k].reads)))));

check('A6 ★★★★★ 所有 **WRITE** 路径都不在 `/economy/` 下（写面与只读面在路径上就分开）',
  (function () {
    const writes = [];
    for (const ui of Object.keys(UI_CONTRACT)) for (const k of Object.keys(UI_CONTRACT[ui].writes)) {
      writes.push(UI_CONTRACT[ui].writes[k]);
    }
    return writes.length === 2 &&
      writes.every(p => p.indexOf('/economy/') !== 0) &&
      writes.every(p => p.indexOf('/internal/economy/') === 0);
  })(), Object.keys(UI_CONTRACT).map(k => UI_CONTRACT[k].writes));

check('A7 ★★★★★ AUTHORITY_FIELDS 与 DERIVED_FIELDS 不相交（一个字段不可能既是权威又是推导）',
  (function () {
    const bad = [];
    for (const ui of Object.keys(UI_CONTRACT)) {
      const a = new Set(UI_CONTRACT[ui].authorityFields);
      for (const f of UI_CONTRACT[ui].derivedFields) if (a.has(f)) bad.push(ui + ':' + f);
    }
    return bad.length === 0;
  })());

check('A8 ★★★★ canonical 只在 /economy/* 下提供 GET；WRITES 里没有任何一条是 /economy/*',
  (function () {
    const httpSrc = stripComments(read('services/home-node/http.js'));
    /* `/economy/changes` 上的写方法一律落在兜底分支上 —— 405。 */
    return httpSrc.indexOf("economy-is-read-only") >= 0 &&
      httpSrc.indexOf("unknown-economy-path") >= 0;
  })());

/* ══ B · 归属规则的唯一实现 ════════════════════════════════════════ */
section('B · 归属只有**一处**实现');

check('B1 ★★★★★ 四个 core 里都没有归属判据（`changeBelongsTo` / `ownerOfChange` / `belongsToOwner`）',
  (function () {
    const names = ['changeBelongsTo', 'ownerOfChange', 'belongsToOwner', 'isOwnedBy'];
    const files = ['assets/js/economy-shell-core.js', 'assets/js/economy-shell.js',
      'assets/js/economy-approval-core.js', 'assets/js/economy-configuration-core.js'];
    const hits = [];
    for (const f of files) {
      const code = stripAll(read(f));
      for (const n of names) if (code.indexOf(n) >= 0) hits.push(f + ':' + n);
    }
    return hits.length === 0;
  })());

check('B2 ★★★★★ 归属的实现**只在** canonical store 里（一个函数 + 两条 SQL）',
  (function () {
    const store = stripAll(read('services/home-node/economy-store.js'));
    const http = stripAll(read('services/home-node/http.js'));
    const inStore = (store.match(/changeOwnerPredicate/g) || []).length;
    return inStore >= 1 && http.indexOf('changeOwnerPredicate') < 0 &&
      store.indexOf('selectChangesByOwnerAsc') >= 0 &&
      store.indexOf('selectChangesByOwnerDesc') >= 0;
  })());

check('B3 ★★★★★ 归属谓词里**没有** `recipientId`（一次"买给别人"是买家的钱动了）',
  (function () {
    const store = read('services/home-node/economy-store.js');
    const at = store.indexOf('function changeOwnerPredicate');
    const body = store.slice(at, store.indexOf('\n}', at));
    return body.indexOf('recipientId') < 0 && body.indexOf('recipient_id') < 0;
  })());

check('B4 ★★★★★ 时间线那一层**带不出** recipientId（`changeRefsOf` 与 `buildTimelineModel` 里都没有它），' +
  '因此"用收礼者当归属"在这一层没有入口',
  (function () {
    const src = read('assets/js/economy-shell-core.js');
    function bodyOf(name) {
      const at = src.indexOf('function ' + name);
      return at < 0 ? '' : src.slice(at, src.indexOf('\n}', at));
    }
    const refs = bodyOf('changeRefsOf');
    const tl = bodyOf('buildTimelineModel');
    return refs.length > 0 && tl.length > 0 &&
      refs.indexOf('recipientId') < 0 && tl.indexOf('recipientId') < 0 &&
      /* 而它确实在**购买记录**那一层出现（收礼者是购买的属性，不是归属的属性）。 */
      src.indexOf("recipientId: (pu && pu.recipientId") >= 0;
  })());

/* ══ C · §7 完整性三态在**页面文案**上就是三句不同的话 ═════════════ */
section('C · §7 三态各自有自己的话');

check('C1 ★★★★★ 三态的词表是封闭的，而且**默认**不是 complete（没说过的窗口不许当成完整）',
  J(CORES.shell.COMPLETENESS_LIST) === J(['complete', 'truncated', 'unknown']) &&
  (function () {
    const tl = CORES.shell.buildTimelineModel({ ok: true, revision: 3, changes: [
      { revision: 1, kind: 'WALLET_OPENED', entityId: 'w', walletId: 'w', at: 1, payload: {} }
    ] }, { ownerId: 'a1' });
    return tl.completeness === CORES.shell.COMPLETENESS.UNKNOWN;
  })());

check('C2 ★★★★★ 截断与"读不准"是**两句不同**的话（说成同一句，用户就没法区分"看少了"与"不知道看了多少"）',
  CORES.shell.COPY.timelineTruncated !== CORES.shell.COPY.timelineUncertain &&
  CORES.shell.COPY.timelineTruncated.indexOf('最近') >= 0 &&
  CORES.shell.COPY.timelineUncertain.indexOf('完整') >= 0,
  { truncated: CORES.shell.COPY.timelineTruncated, uncertain: CORES.shell.COPY.timelineUncertain });

check('C3 ★★★★★ 渲染器按三态分别落笔，而且 truncated 的那一句说的就是"最近的一部分"',
  (function () {
    const js = stripAll(read('assets/js/economy-shell.js'));
    return js.indexOf('COMPLETENESS.TRUNCATED') >= 0 &&
      js.indexOf('COMPLETENESS.UNKNOWN') >= 0 &&
      js.indexOf('timelineTruncated') >= 0 &&
      js.indexOf('timelineUncertain') >= 0;
  })());

check('C4 ★★★★★ 方向是 newest-first，而且它写在**请求**上（不是靠本地排序假装）',
  (function () {
    const js = stripAll(read('assets/js/economy-shell.js'));
    return CORES.shell.CHANGE_ORDER === 'desc' &&
      js.indexOf('CORE.CHANGE_ORDER') >= 0 &&
      js.indexOf('ownerId') >= 0;
  })());

check('C5 ★★★★★ 完整性是**全页一致**的：经济活动那一格说"更早的仍然在时间线里"之前，' +
  '必须拿到时间线那一格的完整性 —— 两格不许对同一件事给出相反的说法',
  (function () {
    const shell = CORES.shell;
    const purchases = { ok: true, purchases: [] };
    for (let i = 0; i < 8; i += 1) {
      purchases.purchases.push({ purchaseId: 'p' + i, buyerId: 'character:a1', status: 'COMPLETED',
        completed: true, amountMinor: '100', currency: 'IB_CREDIT', createdAt: 1 + i, units: 1 });
    }
    const changes = { ok: true, revision: 3, truncated: false, changes: [
      { revision: 1, kind: 'WALLET_OPENED', entityId: 'w', walletId: 'w', at: 1, payload: { ownerId: 'a1' } }
    ] };
    const done = shell.buildActivityModel(purchases, null, null,
      shell.buildTimelineModel(changes, { ownerId: 'a1' }), {});
    const cut = shell.buildActivityModel(purchases, null, null,
      shell.buildTimelineModel(Object.assign({}, changes, { truncated: true }), { ownerId: 'a1' }), {});
    const js = stripAll(read('assets/js/economy-shell.js'));
    return done.timelineIsComplete === true && cut.timelineIsComplete === false &&
      shell.COPY.activityMoreSuffix !== shell.COPY.activityMoreSuffixPartial &&
      js.indexOf('a.timelineIsComplete') >= 0 &&
      js.indexOf('activityMoreSuffixPartial') >= 0;
  })());

/* ══ D · §10 高级信息仍然只是调试面 ═══════════════════════════════ */
section('D · §10 高级信息：默认折叠，而且不扩成数据库面');

check('D1 ★★★★★ 默认折叠（模型的初值就是 open:false）',
  (function () {
    const audit = CORES.shell.buildAuditModel({ rows: [] }, { rows: [] }, {});
    return audit.open === false && typeof audit.open === 'boolean';
  })());

check('D2 ★★★★★ 四句逐字的自述都在：不含数据库行 / 账本内部 / 版本号 / 迁移状态',
  (function () {
    const a = CORES.shell.buildAuditModel({ rows: [] }, { rows: [] }, {});
    return a.showsDatabaseRows === false && a.showsLedgerInternals === false &&
      a.showsRevision === false && a.showsMigrationState === false;
  })());

check('D3 ★★★★★ 四个编号仍然是**只有**这四个（没有扩成 raw JSON / schema revision / 迁移状态）',
  (function () {
    const audit = CORES.shell.buildAuditModel({
      rows: [{ purchaseId: 'p1', name: 'x', refs: { agentIntentId: 'i1', approvalId: 'a1', purchaseId: 'p1', quoteId: 'q1' } }]
    }, { rows: [] }, {});
    const row = audit.rows[0];
    return J(Object.keys(row.refs).sort()) === J(['agentIntentId', 'approvalId', 'purchaseId', 'quoteId']) &&
      row.refs.reservationId === undefined && row.refs.transactionId === undefined;
  })(), (function () {
    const audit = CORES.shell.buildAuditModel({
      rows: [{ purchaseId: 'p1', name: 'x', refs: { agentIntentId: 'i1', approvalId: 'a1', purchaseId: 'p1', quoteId: 'q1' } }]
    }, { rows: [] }, {});
    return Object.keys(audit.rows[0].refs);
  })());

check('D4 ★★★★★ 页面上没有"整条数据库记录"这条路：`buildAuditModel` 的输出里没有 payload / 行 / JSON',
  (function () {
    const audit = CORES.shell.buildAuditModel({
      rows: [{ purchaseId: 'p1', name: 'x', refs: { purchaseId: 'p1' }, payload: { secret: 1 } }]
    }, { rows: [] }, {});
    const s = J(audit);
    return s.indexOf('secret') < 0 && s.indexOf('payload') < 0 && s.indexOf('payload_json') < 0;
  })());

/* ══ E · §14 本阶段禁止的东西 ═════════════════════════════════════ */
section('E · §14 禁止面：一个都没有出现');

check('E1 ★★★★★ 浏览器侧经济文件里没有 Refund / Provider quota / billing / top-up / ' +
  '真实支付 / 优惠券 / 折扣 / 促销 / 商户 / 结账这一整套词',
  (function () {
    const files = ['assets/js/economy-shell-core.js', 'assets/js/economy-shell.js',
      'assets/js/economy-approval-core.js', 'assets/js/economy-configuration-core.js'];
    const banned = ['refund', 'topup', 'providerquota', 'providerbilling',
      'realpayment', 'stripe', 'coupon', 'discount', 'promotion', 'merchant', 'checkout'];
    const hits = [];
    for (const f of files) {
      const code = stripAll(read(f)).toLowerCase();
      for (const b of banned) if (code.indexOf(b) >= 0) hits.push(f + ':' + b);
    }
    return hits.length === 0;
  })());

check('E1b ★★★★★ `exchange` 的每一次出现都只是 canonical 的**拒绝原因码**' +
  '（`exchange_rate_unknown` 之流），不是一条 Exchange 功能',
  (function () {
    const C = require(path.join(ROOT, 'services', 'home-node', 'economy-contract.js'));
    const reasons = new Set(Object.keys(C.DENY_REASON || {}).concat(Object.values(C.DENY_REASON || {}).map(String)));
    const files = ['assets/js/economy-shell-core.js', 'assets/js/economy-shell.js',
      'assets/js/economy-approval-core.js', 'assets/js/economy-configuration-core.js'];
    const bad = [];
    for (const f of files) {
      const code = stripAll(read(f));
      let i = -1;
      while ((i = code.indexOf('exchange', i + 1)) >= 0) {
        /* 取它所在的整段标识符，逐个核对它是契约里的一个词。 */
        let a = i, z = i + 8;
        while (a > 0 && /[A-Za-z0-9_]/.test(code[a - 1])) a -= 1;
        while (z < code.length && /[A-Za-z0-9_]/.test(code[z])) z += 1;
        const token = code.slice(a, z);
        if (reasons.has(token) === false) bad.push(f + ':' + token);
      }
    }
    return bad.length === 0;
  })(), (function () {
    const files = ['assets/js/economy-approval-core.js'];
    const out = [];
    for (const f of files) {
      const code = stripAll(read(f));
      let i = -1;
      while ((i = code.indexOf('exchange', i + 1)) >= 0) {
        let a = i, z = i + 8;
        while (a > 0 && /[A-Za-z0-9_]/.test(code[a - 1])) a -= 1;
        while (z < code.length && /[A-Za-z0-9_]/.test(code[z])) z += 1;
        out.push(code.slice(a, z));
      }
    }
    return out;
  })());

check('E2 ★★★★★ canonical 侧的 economy 路由里没有新的写入口：' +
  '`/economy/*` 上仍然只有 GET，POST 一律 405',
  (function () {
    const httpSrc = read('services/home-node/http.js');
    /* ★ 判据必须看**代码**：本文件里确实有大量注释在解释这些写路径为什么
       不存在。剥掉注释之后再找路由声明（**保留**字符串 —— 路由路径本身
       就是字符串）。 */
    const code = stripComments(httpSrc);
    return code.indexOf("path === '/economy/changes' && method === 'GET'") >= 0 &&
      code.indexOf("path === '/economy/changes' && method === 'POST'") < 0 &&
      code.indexOf("path === '/economy/owner-scope'") < 0 &&
      code.indexOf('economy-is-read-only') >= 0;
  })());

check('E3 ★★★★★ 本阶段**没有**新增任何 Economy 生产文件（Economy 仍然是那八个）',
  (function () {
    const files = fs.readdirSync(path.join(ROOT, 'services', 'home-node'))
      .filter(f => /^economy-.*\.js$/.test(f)).sort();
    return J(files) === J(['economy-action-adapter.js', 'economy-approval-decision.js',
      'economy-capability.js', 'economy-command-channel.js', 'economy-configuration.js',
      'economy-contract.js', 'economy-store.js']);
  })(), fs.readdirSync(path.join(ROOT, 'services', 'home-node')).filter(f => /^economy/.test(f)));

check('E4 ★★★★★ 本阶段**没有**抬 schema 水位、没有新表、没有第二份读数据库/物化分析表',
  (function () {
    const store = stripComments(read('services/home-node/economy-store.js'));
    /* ★ 水位是"这个库属于哪一代 schema"的权威。P22-19 只加了两个 SQL 常量
       与一个读方法，**不该**抬它 —— 抬了就意味着有迁移，而有迁移就意味着
       本阶段动了写入侧。
       ★★ P22-26：水位确实抬到了 8（`quotes.units`，见
       `docs/contracts/economy/ECONOMY_V1_FROZEN_CONTRACT.md` §1 的申报）。因此这里不再把
       "恰好是 7"写死 —— 那条字面量会让这条断言在下一次**已申报**的抬水位
       之后以红色的假象失败，而它要证明的那件事一个字没变。剩下三条判据
       （没有第二个数据库 / 物化分析表 / 事件表）反而是更硬的那一半。 */
    return store.indexOf('const ECONOMY_SCHEMA_VERSION = 8;') >= 0 &&
      store.indexOf('economy_events') < 0 &&
      store.indexOf('economy_read_model') < 0 &&
      store.indexOf('materialized') < 0 &&
      store.indexOf('createChangeLog') >= 0;
  })());

check('E5 ★★★★★ 没有新的 Agent capability / 新的 Approval capability / 新的 Action',
  (function () {
    const C = require(path.join(ROOT, 'services', 'home-node', 'economy-contract.js'));
    /* 能力的封闭集合与消费者的封闭集合都没有被本阶段碰过。 */
    return J(Object.keys(C.CAPABILITY)) === J(['PROPOSE_PURCHASE', 'RESUME_APPROVED_PURCHASE']) &&
      C.ECONOMY_CONSUMER.USER_DECISION_SEAM != null &&
      C.ECONOMY_CONSUMER.ACTIVE_AGENT_RUNTIME != null &&
      /* 消费者的封闭集合仍然是那四个（P22-13 之后没有第五个）。 */
      J(Object.keys(C.ECONOMY_CONSUMER)) ===
        J(['ACTIVE_AGENT_RUNTIME', 'HOME_NODE_AUTHORITY', 'DESKTOP_BRIDGE', 'USER_DECISION_SEAM']);
  })(), (function () {
    const C = require(path.join(ROOT, 'services', 'home-node', 'economy-contract.js'));
    return { capability: Object.keys(C.CAPABILITY), consumer: Object.keys(C.ECONOMY_CONSUMER) };
  })());

/* ══ F · 本阶段自己的写面纪律 ═════════════════════════════════════ */
section('F · 本阶段没有扩大任何写面');

check('F1 ★★★★★ store 的**导出**里没有新增写方法（新增的只有 listChangesForOwner 这一个读方法）',
  (function () {
    const store = require(path.join(ROOT, 'services', 'home-node', 'economy-store.js'));
    /* ★ 刻意**不** open()：只要导出名单，不需要一个数据库文件 —— 于是这一
       条断言连一个临时目录都不会产生（"leftover = 0"）。 */
    const api = store({ dataDir: path.join(require('node:os').tmpdir(), 'p22-19-api-probe-not-opened'), logger: () => {} });
    const names = Object.keys(api).sort();
    const banned = ['refund', 'exchange', 'topUp', 'grantQuota', 'payProvider'];
    return names.indexOf('listChangesForOwner') >= 0 &&
      names.indexOf('listChanges') >= 0 &&
      banned.every(b => names.indexOf(b) < 0);
  })());

console.log('\n' + '─'.repeat(66));
console.log('结果: ' + (failures === 0 ? 'PASS' : failures + ' FAILED') + '（' + checks + ' 项）');
process.exitCode = failures === 0 ? 0 : 1;
