'use strict';
/* ====================================================================
   P22-17 · Economy Store / Wallet / Inventory UI — 纯层
   （assets/js/economy-shell-core.js）
   --------------------------------------------------------------------
   运行：node tests/test_p22_17_economy_store_ui_core.js

   ★ 纯层加载进一个**没有 document、没有 fetch、没有 location** 的沙箱：
     于是"它不碰 DOM、不发请求"是环境事实而不是注释。
   ★ 它**依赖** P22-16 的纯层（币种 scale / 展示名 / 商品类别三张镜像表
     只有一个出处），因此沙箱里先加载那一份。

   这一条测试要回答的问题：
     · 确定性视觉身份的输入到底有几个 —— 函数签名只有一个位置参数，
       于是 buyerId / 关系 / 亲和度在结构上进不来（§4 的硬要求）；
     · 顺序就是读面给的顺序，哈希不参与排序（§4）；
     · 钱包三态是**三句话**，而不是一个 0（P22-0 R5 的根因）；
     · 预算模型里**没有** decision 字段（那是一次裁决，不是要显示的事实）；
     · 库存按 canonical assetKind 分组、SERVICE 不被伪造、COMPUTE 的说法
       只有一个（IB 内部算力额度）；
     · 购买历史把 RESERVED / COMPLETED / RELEASED / FAILED 译成人话，
       而且"由谁发起"只在两条读面真的连得上时才出现；
     · 正文里没有禁用词、没有 emoji、没有 canonical 原始代号。
   ==================================================================== */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const CORE_REL = 'assets/js/economy-shell-core.js';
const CFG_CORE_REL = 'assets/js/economy-configuration-core.js';

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
/* 剥注释与字符串：禁令应当写在注释里（解释边界），但不该出现在代码里。 */
function strip(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''").replace(/"(?:[^"\\]|\\.)*"/g, '""');
}

const coreSrc = read(CORE_REL);
const coreCode = strip(coreSrc);
const cfgSrc = read(CFG_CORE_REL);

console.log('P22-17 · Economy Shell 纯层');

/* ── 沙箱 ───────────────────────────────────────────────────────────── */
function sandbox() {
  const b = { console: { log() {}, warn() {}, error() {}, info() {} } };
  b.window = b; b.self = b;
  return vm.createContext(b);
}
function loadCore() {
  const s = sandbox();
  /* ★ 沙箱里**没有** document / fetch / location / XMLHttpRequest。
     纯层若碰了它们，这里会当场炸，而不是"看起来跑过了"。 */
  vm.runInContext(cfgSrc, s, { filename: 'economy-configuration-core.js' });
  vm.runInContext(coreSrc, s, { filename: 'economy-shell-core.js' });
  return { s, core: s.IB.economyShellCore, cfg: s.IB.economyConfigurationCore };
}
const L = loadCore();
const C = L.core;
const CFG = L.cfg;

/* ══ A · 静态结构 ══════════════════════════════════════════════════ */
section('A · 静态结构：纯层不碰 DOM、不发请求、不认识任何写面');

check('A1 ★★★ 纯层里没有 fetch / XMLHttpRequest / require / import',
  !/\bfetch\s*\(/.test(coreCode) && !/XMLHttpRequest/.test(coreCode) &&
  !/\brequire\s*\(/.test(coreCode) && !/\bimport\s*\(/.test(coreCode));

check('A2 ★★★ 纯层里没有任何 /internal/economy/* 路径（一条写面都不认识）',
  !/\/internal\/economy\//.test(coreSrc),
  (coreSrc.match(/\/internal\/economy\/[a-z-]+/g) || []));

check('A3 ★★★ 纯层里没有一条 POST / PUT / DELETE（它只有"读"这一个词）',
  !/method\s*:\s*['"](?:POST|PUT|DELETE|PATCH)/i.test(coreCode) &&
  !/\bPOST\b/.test(coreCode.replace(/COPY[\s\S]*?\}\);/g, '')));

check('A4 ★★★ 八条读面全是既有 GET，而且都是 /economy/ 下的',
  Object.keys(C.READS).length === 8 &&
  Object.keys(C.READS).every(k => /^\/economy\/[a-z-]+$/.test(C.READS[k])),
  Object.keys(C.READS).map(k => C.READS[k]));

check('A5 ★★★ 外层恰好五个页签，顺序就是 §2 的信息架构',
  C.TAB_KEYS.length === 5 &&
  C.TABS.map(t => t.label).join(',') === '概览,商店,我的资产,待处理,设置',
  C.TABS.map(t => t.label));

check('A6 ★★★ 被委托的两格没有自己的 paneId（本模块不画 P22-15/16 的任何一块）',
  (function () {
    const byKey = {};
    C.TABS.forEach(t => { byKey[t.key] = t; });
    return byKey.requests.paneId === null && byKey.requests.delegate === 'approval' &&
      byKey.settings.paneId === null && byKey.settings.delegate === 'config' &&
      byKey.overview.paneId != null && byKey.store.paneId != null && byKey.assets.paneId != null;
  })());

check('A7 ★★★ 纯层里不出现 P22-15 / P22-16 的任何一个 DOM id（不复制它们的实现）',
  coreSrc.indexOf('economy-config-wallet') < 0 &&
  coreSrc.indexOf('economy-config-budget') < 0 &&
  coreSrc.indexOf('economy-config-autonomy') < 0 &&
  coreSrc.indexOf('economy-owner-select') < 0 &&
  coreSrc.indexOf('ec-card') < 0 &&
  coreSrc.indexOf('ecfg-') < 0);

/* ══ B · 镜像表只有一个出处 ════════════════════════════════════════ */
section('B · 镜像表：币种 / 商品类别 / 角色目录都复用 P22-16 那一份');

check('B1 ★★★ 币种展示名逐字等于 P22-16 纯层的那一份（本阶段不建第二张表）',
  Object.keys(CFG.CURRENCY_SCALE).every(c => C.currencyFace(c) === CFG.currencyLabel(c)) &&
  C.currencyFace('IB_CREDIT') === 'IB Credit',
  Object.keys(CFG.CURRENCY_SCALE).map(c => C.currencyFace(c)));

check('B2 ★★★ 纯层源码里没有任何币种中文名（否则就是第二张表）',
  ['标准算力额度', '高级算力额度', '活动点', '图像额度', '语音额度'].every(w => coreSrc.indexOf(w) < 0));

check('B3 ★★★ 纯层源码里没有任何商品类别中文名（同样复用 P22-16 的表）',
  ['数字内容', '消耗品', '接口额度'].every(w => coreSrc.indexOf(w) < 0));

check('B4 ★★★ 依赖自述说谎会被抓到：依赖缺失时币种名与金额都是 null，而不是回退到代号',
  (function () {
    const s2 = sandbox();
    vm.runInContext(coreSrc, s2, { filename: 'economy-shell-core.js' });  /* **不**加载 P22-16 */
    const c2 = s2.IB.economyShellCore;
    return c2.dependencies.configurationCore === false &&
      c2.currencyFace('IB_CREDIT') === null &&
      c2.moneyText('100', 'IB_CREDIT') === null &&
      c2.ownerOptionsOf([{ id: 'a1' }], []).length === 0;
  })());

check('B5 ★★ 角色目录复用 P22-16 的 ownerOptions：同一份输入得到同一组选项，而且没有「我」',
  (function () {
    const cfg = [{ id: 'a1', nickname: '阿尔法' }, { id: 'a2', nickname: '贝塔' }];
    const a = C.ownerOptionsOf(cfg, []);
    const b = CFG.ownerOptions(cfg, []);
    return JSON.stringify(a) === JSON.stringify(b) &&
      a.length === 2 && a.every(o => o.id !== 'user' && o.label !== '我');
  })());

/* ══ C · 确定性视觉身份（§4）═══════════════════════════════════════ */
section('C · 确定性视觉身份：输入只有 productId，而且不进任何判定');

check('C1 ★★★★★ 函数签名只有一个位置参数 —— buyerId / 关系 / 亲和度在**结构上**进不来',
  C.visualIdentityOf.length === 1 && C.hashProductId.length === 1,
  { visualIdentityOf: C.visualIdentityOf.length, hashProductId: C.hashProductId.length });

check('C2 ★★★ 同一个 productId 永远同一张脸（确定性），不同 productId 通常不同',
  (function () {
    const a = C.visualIdentityOf('econ_prod_alpha');
    const b = C.visualIdentityOf('econ_prod_alpha');
    const seen = [];
    for (let i = 0; i < 24; i += 1) seen.push(C.visualIdentityOf('econ_prod_' + i).variant);
    const distinct = Array.from(new Set(seen)).length;
    return JSON.stringify(a) === JSON.stringify(b) && distinct >= 4;
  })());

check('C3 ★★★ 输出落在声明的范围内（变体 / 角度 / 线稿三个都是封闭集合里的成员）',
  (function () {
    for (let i = 0; i < 64; i += 1) {
      const v = C.visualIdentityOf('p' + i);
      if (!(v.variant >= 0 && v.variant < C.VISUAL_VARIANTS)) return false;
      if (C.VISUAL_ANGLES.indexOf(v.angle) < 0) return false;
      if (!(v.mark >= 0 && v.mark < C.VISUAL_MARKS)) return false;
    }
    return true;
  })());

check('C4 ★★★ 价格 / 状态 / 货架变了，脸不变（哈希只吃 productId）',
  (function () {
    const base = { productId: 'econ_prod_x', name: '甲', unitPriceMinor: '100', currency: 'IB_CREDIT', status: 'ACTIVE', storeId: 's1' };
    const moved = Object.assign({}, base, { unitPriceMinor: '99999', status: 'RETIRED', storeId: 's2' });
    const a = C.buildProductModel({ ok: true, products: [base] }, {}).rows[0].identity;
    const b = C.buildProductModel({ ok: true, products: [moved] }, {}).rows[0].identity;
    return JSON.stringify(a) === JSON.stringify(b);
  })());

check('C5 ★★★ 目录顺序就是读面给的顺序：打乱哈希的顺序不改输出（哈希不参与排序）',
  (function () {
    /* 刻意挑一组"哈希序"与"读面序"不同的产品：productId 的字典序 ≠ 哈希序。 */
    const ids = ['econ_prod_zzz', 'econ_prod_a', 'econ_prod_mmm', 'econ_prod_b', 'econ_prod_qq'];
    const rows = ids.map(id => ({ productId: id, name: id, status: 'ACTIVE', fulfillment: 'INVENTORY_GRANT', unitName: 'item', grantQuantity: 1, unitPriceMinor: '100', currency: 'IB_CREDIT' }));
    const hashed = rows.slice().sort((x, y) => C.hashProductId(x.productId) - C.hashProductId(y.productId));
    const model = C.buildProductModel({ ok: true, products: rows }, {});
    const hashOrder = hashed.map(r => r.productId).join(',');
    return model.rows.map(r => r.productId).join(',') === ids.join(',') &&
      hashOrder !== ids.join(',');
  })());

check('C6 ★★★ 纯层里没有任何按 hash / identity 排序的调用',
  !/sort\(\s*function[^)]*\)\s*\{[^}]*identity/.test(coreCode) &&
  !/sort\([^)]*hash/i.test(coreCode));

/* ══ D · 钱包（§3）═════════════════════════════════════════════════ */
section('D · 钱包：三态是三句话，而不是一个 0');

const walletReady = {
  ok: true,
  wallet: {
    walletId: 'econ_wallet_1', owner: { type: 'character', id: 'a1' }, currency: 'IB_CREDIT',
    state: 'READY', balanceKnown: true, availableBalanceMinor: '1245000',
    reservedBalanceMinor: '12000', revision: 7
  }
};

check('D1 ★★★ READY：主数字取自 canonical availableBalanceMinor，而且千分位只影响排版',
  (function () {
    const w = C.buildWalletModel(walletReady, { ownerId: 'a1' });
    return w.known === true && w.state === 'READY' && w.primary === '12,450.00' &&
      w.currencyFace === 'IB Credit' &&
      C.groupedNumber('1245000', 'IB_CREDIT') === '12,450.00' &&
      C.groupedMoney('1245000', 'IB_CREDIT') === '12,450.00 IB Credit' &&
      C.moneyText('1245000', 'IB_CREDIT') === '12450.00 IB Credit';
  })(), C.buildWalletModel(walletReady, { ownerId: 'a1' }));

check('D2 ★★★ 预留额度只在真的 > 0 时出现，而且是**另一行**，不是从可用里扣过再显示',
  (function () {
    const w = C.buildWalletModel(walletReady, { ownerId: 'a1' });
    const zero = C.buildWalletModel({
      ok: true, wallet: Object.assign({}, walletReady.wallet, { reservedBalanceMinor: '0' })
    }, { ownerId: 'a1' });
    return w.reserved === '120.00' && w.reservedLabel === '其中已被预留' && zero.reserved === null &&
      w.primary === '12,450.00';   /* 可用余额**没有**被这一层减过一次 */
  })());

check('D3 ★★★★ COLD / DEGRADED 的主数字是 null —— "不知道"绝不能折成 0（P22-0 R5）',
  (function () {
    const states = ['COLD', 'DEGRADED'];
    return states.every(st => {
      const w = C.buildWalletModel({
        ok: true, wallet: Object.assign({}, walletReady.wallet, {
          state: st, balanceKnown: false, availableBalanceMinor: null,
          cachedBalanceMinor: null, ledgerBalanceMinor: null, reservedBalanceMinor: null
        })
      }, { ownerId: 'a1' });
      return w.known === false && w.primary === null && w.reserved === null &&
        typeof w.note === 'string' && w.note.indexOf('0') < 0;
    });
  })());

check('D4 ★★★ 钱包不存在（404）与读不到（传输失败）是**两句话**，而且第一句给的是"去设置"',
  (function () {
    const absent = C.buildWalletModel({ ok: false, error: 'wallet-not-found', status: 404 }, { ownerId: 'a1' });
    const down = C.buildWalletModel({ ok: false, error: 'home-node-unreachable' }, { ownerId: 'a1' });
    return absent.present === false && absent.absent === true && absent.known === false &&
      down.read === false && down.note === C.COPY.walletAbsent;
  })());

check('D5 ★★★ 没有角色时说的是"还没有配置任何角色"，而不是一个空钱包',
  C.buildWalletModel(null, { ownerId: null }).note === C.COPY.ownerEmpty);

/* ══ E · 预算摘要（§2/§3/§8）══════════════════════════════════════ */
section('E · 预算摘要：数字全部来自权威，decision 一个字段都不进模型');

const policyRes = {
  ok: true,
  policy: {
    policyId: 'econ_policy_1', ownerId: 'a1', currency: 'IB_CREDIT', status: 'ACTIVE',
    limits: { perTransactionMinor: '5000', dailyMinor: '50000', approvalThresholdMinor: '2000', weeklyMinor: '200000', monthlyMinor: null },
    autonomyLevel: 'LIMITED', revision: 3, hardStop: false
  }
};
const snapshotRes = {
  ok: true,
  snapshot: { currency: 'IB_CREDIT', spentTodayMinor: '1250', spentThisWeekMinor: '4300', availableBalanceMinor: '1245000' },
  decision: { outcome: 'ALLOW', reasonCode: 'WITHIN_LIMITS' },
  evaluatedOnly: true, notASpendPermit: true, reserved: false
};

check('E1 ★★★ limits 里有几档就显示几档：没设的那一档**不出现**（不是显示 0）',
  (function () {
    const b = C.buildBudgetModel(policyRes, snapshotRes, {});
    return b.present === true && b.rows.length === 4 &&
      b.rows.map(r => r.key).join(',') === 'perTransactionMinor,dailyMinor,approvalThresholdMinor,weeklyMinor' &&
      b.rows.every(r => r.value != null && r.value !== '0.00');
  })(), C.buildBudgetModel(policyRes, snapshotRes, {}).rows);

check('E2 ★★★★ 模型里**没有** decision / ALLOW / DENY / reasonCode（那是一次裁决，不是要显示的事实）',
  (function () {
    const b = C.buildBudgetModel(policyRes, snapshotRes, {});
    const blob = JSON.stringify(b);
    return blob.indexOf('decision') < 0 && blob.indexOf('ALLOW') < 0 &&
      blob.indexOf('DENY') < 0 && blob.indexOf('reasonCode') < 0;
  })(), Object.keys(C.buildBudgetModel(policyRes, snapshotRes, {})));

check('E3 ★★★ 今日使用量来自权威自己的快照（不是这一层从 ledger 重算的）',
  (function () {
    const b = C.buildBudgetModel(policyRes, snapshotRes, {});
    return b.usage.length === 1 && b.usage[0].label === '今日已用' && b.usage[0].value === '12.50';
  })(), C.buildBudgetModel(policyRes, snapshotRes, {}).usage);

check('E4 ★★★ 快照里没有 spentTodayMinor 时**不显示**这一行（宁可少一行，不编一个 0）',
  C.buildBudgetModel(policyRes, { ok: true, snapshot: { currency: 'IB_CREDIT' } }, {}).usage.length === 0);

check('E5 ★★★ 没有政策时说"还没有设过预算"，而不是给出一组 0',
  (function () {
    const b = C.buildBudgetModel({ ok: false, error: 'budget-policy-not-found', status: 404 }, snapshotRes, {});
    return b.present === false && b.rows.length === 0 && b.note === C.COPY.budgetAbsent;
  })());

/* ══ F · 商店与商品目录（§4）══════════════════════════════════════ */
section('F · 商店与商品：数量是数出来的，状态是人话，价格来自 unitPriceMinor');

const productsRes = {
  ok: true,
  personalized: false, hasRecommendations: false, hasDiscounts: false,
  products: [
    { productId: 'econ_prod_1', storeId: 'econ_store_a', kind: 'DIGITAL_ITEM', fulfillment: 'INVENTORY_GRANT', name: '数字绘画额度', description: '一张图的额度', currency: 'IB_CREDIT', unitPriceMinor: '2000', unitName: 'item', grantQuantity: 1, assetKind: 'ITEM', status: 'ACTIVE' },
    { productId: 'econ_prod_2', storeId: 'econ_store_a', kind: 'COMPUTE_CREDIT', fulfillment: 'COMPUTE_GRANT', name: '算力包', description: '', currency: 'IB_CREDIT', unitPriceMinor: '500', unitName: 'computeUnit', grantQuantity: 100, assetKind: 'COMPUTE', status: 'DISABLED' },
    { productId: 'econ_prod_3', storeId: 'econ_store_b', kind: 'SERVICE', fulfillment: 'SERVICE_EXECUTION', name: '一次修图', description: '人工', currency: 'IB_CREDIT', unitPriceMinor: '800', unitName: 'service', grantQuantity: 1, assetKind: null, status: 'RETIRED' }
  ]
};
const storesRes = {
  ok: true, holdsPrices: false, holdsOwnership: false,
  stores: [
    { storeId: 'econ_store_a', name: '数字工坊', description: '安静的货架', status: 'ACTIVE', sortOrder: 1 },
    { storeId: 'econ_store_b', name: '修图铺', description: '', status: 'DISABLED', sortOrder: 2 },
    { storeId: 'econ_store_c', name: '空货架', description: '', status: 'ACTIVE', sortOrder: 3 }
  ]
};

check('F1 ★★★ 商品数量是从 canonical 商品列表里数出来的，而空货架是 0 而不是 null',
  (function () {
    const s = C.buildStoreModel(storesRes, productsRes);
    return s.rows.map(r => r.productCount).join(',') === '2,1,0' &&
      s.rows[0].productCountText === '2 件商品' && s.countsExact === true &&
      s.holdsPrices === true && s.holdsOwnership === true;
  })(), C.buildStoreModel(storesRes, productsRes).rows);

check('F2 ★★★ 商品窗口被截断时**不显示**数量（一个看起来精确的错数比没有数更糟）',
  (function () {
    const many = { ok: true, products: [] };
    for (let i = 0; i < C.LIMITS.PRODUCTS; i += 1) {
      many.products.push({ productId: 'p' + i, storeId: 'econ_store_a', name: 'x', status: 'ACTIVE', unitName: 'item', grantQuantity: 1, unitPriceMinor: '1', currency: 'IB_CREDIT', kind: 'DIGITAL_ITEM', fulfillment: 'INVENTORY_GRANT' });
    }
    const s = C.buildStoreModel(storesRes, many);
    return s.countsExact === false && s.rows.every(r => r.productCount === null && r.productCountText === null);
  })());

check('F3 ★★★ 三种商品状态各自一句人话，而且都不是 canonical 代号',
  (function () {
    const p = C.buildProductModel(productsRes, {});
    return p.rows.map(r => r.statusFace).join(',') === '在架上,暂停提供,已下架' &&
      p.rows.every(r => ['ACTIVE', 'DISABLED', 'RETIRED'].indexOf(r.statusFace) < 0);
  })(), C.buildProductModel(productsRes, {}).rows.map(r => r.statusFace));

check('F4 ★★★ 价格来自 canonical unitPriceMinor，而且带上币种名（不是代号）',
  (function () {
    const p = C.buildProductModel(productsRes, {});
    return p.rows[0].priceText === '20.00 IB Credit' && p.rows[1].priceText === '5.00 IB Credit' &&
      p.rows.every(r => String(r.priceText).indexOf('IB_CREDIT') < 0);
  })(), C.buildProductModel(productsRes, {}).rows.map(r => r.priceText));

check('F5 ★★★ unitName / grantQuantity 投影成一句"每份发放 N <单位>"；SERVICE 说"一次执行"',
  (function () {
    const p = C.buildProductModel(productsRes, {});
    return p.rows[0].unitLine === '每份发放 1 件' &&
      p.rows[1].unitLine === '每份发放 100 算力单位' &&
      p.rows[2].unitLine === '一次执行';
  })(), C.buildProductModel(productsRes, {}).rows.map(r => r.unitLine));

check('F6 ★★★ 类别与交付方式的中文逐字等于 P22-16 纯层的镜像表',
  (function () {
    const p = C.buildProductModel(productsRes, {});
    return p.rows[0].kindFace === CFG.PRODUCT_KIND_LABEL.DIGITAL_ITEM &&
      p.rows[2].fulfillmentFace === CFG.FULFILLMENT_LABEL.SERVICE_EXECUTION;
  })());

check('F7 ★★★ 读面自己说它不是个性化的 —— 模型把这个否认原样带出来',
  C.buildProductModel(productsRes, {}).notPersonalized === true &&
  C.buildProductModel({ ok: true, products: [] }, {}).notPersonalized === false);

check('F8 ★★★ 商品模型里**没有**任何"能不能买"的判定（只有目录状态）',
  (function () {
    const p = C.buildProductModel(productsRes, {});
    const blob = JSON.stringify(p);
    return p.rows[2].requestable === false && p.rows[0].requestable === true &&
      blob.indexOf('canBuy') < 0 && blob.indexOf('purchasable') < 0 && blob.indexOf('reserve') < 0;
  })());

/* ══ G · 我的资产（§6）═════════════════════════════════════════════ */
section('G · 资产：按 canonical assetKind 分组，SERVICE 不伪造库存');

const inventoryRes = {
  ok: true, isABalance: false, contributesToAvailableBalance: false, locksFunds: false,
  entries: [
    { inventoryEntryId: 'econ_inv_1', ownerId: 'a1', productId: 'econ_prod_1', assetKind: 'ITEM', quantity: 3, revision: 2, createdAt: 1000, updatedAt: 2000, productPresent: true, isABalance: false },
    { inventoryEntryId: 'econ_inv_2', ownerId: 'a1', productId: 'econ_prod_2', assetKind: 'COMPUTE', quantity: 250, revision: 1, createdAt: 1500, updatedAt: 1900, productPresent: true, isABalance: false },
    { inventoryEntryId: 'econ_inv_3', ownerId: 'a1', productId: 'econ_prod_gone', assetKind: 'ITEM', quantity: 1, revision: 1, createdAt: 900, updatedAt: 2100, productPresent: false, isABalance: false }
  ]
};

check('G1 ★★★ 分组就是 canonical 的两个 assetKind，顺序固定（ITEM 先）',
  (function () {
    const a = C.buildAssetsModel(inventoryRes, productsRes, {});
    return a.kinds.join(',') === 'ITEM,COMPUTE' &&
      a.groups.map(g => g.face).join(',') === '物品,算力额度' &&
      a.groups[0].rows.length === 2 && a.groups[1].rows.length === 1;
  })(), C.buildAssetsModel(inventoryRes, productsRes, {}).groups.map(g => g.rows.length));

check('G2 ★★★★ COMPUTE 只有**一个**说法：IB 内部的算力额度，而且模型里没有 Provider / token 的字样',
  (function () {
    const a = C.buildAssetsModel(inventoryRes, productsRes, {});
    const note = a.groups[1].note;
    const blob = JSON.stringify(a);
    const banned = ['Provider', 'provider', 'token', 'Token', 'API 余额', 'DeepSeek', 'Claude', 'OpenAI', '额度充值'];
    return note === C.COPY.assetsComputeNote && note.indexOf('IB 内部') >= 0 &&
      note.indexOf('Compute Entitlement') >= 0 &&
      banned.every(w => blob.indexOf(w) < 0);
  })(), C.buildAssetsModel(inventoryRes, productsRes, {}).groups[1].note);

check('G3 ★★★ SERVICE 不出现为一组（canonical 的 assetKind 里没有它），但有一句它为什么不在这里',
  (function () {
    const a = C.buildAssetsModel(inventoryRes, productsRes, {});
    return a.kinds.indexOf('SERVICE') < 0 && typeof a.serviceNote === 'string' &&
      a.serviceNote.indexOf('一次执行') >= 0;
  })());

check('G4 ★★★ 名字能 join 就 join；join 不上写"已经不存在的商品"，而不是把 productId 摆到脸上',
  (function () {
    const a = C.buildAssetsModel(inventoryRes, productsRes, {});
    const rows = a.groups[0].rows;
    const gone = rows.filter(r => r.productId === 'econ_prod_gone')[0];
    return rows.filter(r => r.productId === 'econ_prod_1')[0].name === '数字绘画额度' &&
      gone.name === C.COPY.productGone &&
      rows.every(r => r.name.indexOf('econ_prod') < 0);
  })(), C.buildAssetsModel(inventoryRes, productsRes, {}).groups[0].rows.map(r => r.name));

check('G5 ★★★ 组内按 canonical 的 updatedAt 排（更新在最上面），而且数量带单位',
  (function () {
    const a = C.buildAssetsModel(inventoryRes, productsRes, {});
    return a.groups[0].rows.map(r => r.inventoryEntryId).join(',') === 'econ_inv_3,econ_inv_1' &&
      a.groups[0].rows.filter(r => r.inventoryEntryId === 'econ_inv_1')[0].quantityText === '3 件' &&
      a.groups[1].rows[0].quantityText === '250 算力单位';
  })(), C.buildAssetsModel(inventoryRes, productsRes, {}).groups[0].rows.map(r => r.inventoryEntryId));

check('G6 ★★★ 读面自己说 isABalance === false —— 模型原样带出来（库存不是余额）',
  C.buildAssetsModel(inventoryRes, productsRes, {}).isNotABalance === true);

check('G7 ★★★ 空资产是一句"还没有任何资产"，而不是三个 0',
  (function () {
    const a = C.buildAssetsModel({ ok: true, entries: [] }, productsRes, {});
    return a.empty === true && a.total === 0 &&
      a.groups.every(g => g.rows.length === 0 && g.emptyText != null);
  })());

/* ══ H · 购买历史（§7）═════════════════════════════════════════════ */
section('H · 购买历史：状态译成人话，"由谁发起"只在真的连得上时才说');

const purchasesRes = {
  ok: true, count: 4, personalized: false, recommended: false, ranked: false, exposesMutation: false,
  purchases: [
    { purchaseId: 'econ_pur_1', buyerId: 'character:a1', productId: 'econ_prod_1', currency: 'IB_CREDIT', amountMinor: '2000', status: 'COMPLETED', terminal: true, completed: true, approvalMode: 'APPROVAL', units: 1, grantedQuantity: 1, unitName: 'item', createdAt: 1700000000000, completedAt: 1700000010000, recipe: null },
    { purchaseId: 'econ_pur_2', buyerId: 'character:a1', productId: 'econ_prod_2', currency: 'IB_CREDIT', amountMinor: '500', status: 'RESERVED', terminal: false, completed: false, approvalMode: 'AUTO_ALLOW', createdAt: 1700000100000 },
    { purchaseId: 'econ_pur_3', buyerId: 'character:a1', productId: 'econ_prod_3', currency: 'IB_CREDIT', amountMinor: '800', status: 'RELEASED', terminal: true, completed: false, approvalMode: null, createdAt: 1700000200000 },
    { purchaseId: 'econ_pur_4', buyerId: 'character:a1', productId: 'econ_prod_1', currency: 'IB_CREDIT', amountMinor: '2000', status: 'FAILED', terminal: true, completed: false, approvalMode: 'APPROVAL', createdAt: 1700000300000 }
  ]
};
const intentsRes = {
  ok: true,
  intents: [
    { agentIntentId: 'econ_int_1', agentId: 'a1', purchaseId: 'econ_pur_1', state: 'COMPLETED' },
    { agentIntentId: 'econ_int_4', agentId: 'a9', purchaseId: 'econ_pur_4', state: 'FAILED' }
  ]
};

check('H1 ★★★★ 四种 purchase state 各自一句人话，模型里没有一处把代号当文案',
  (function () {
    const p = C.buildPurchaseModel(purchasesRes, productsRes, intentsRes, { apiConfigs: [{ id: 'a1', nickname: '阿尔法' }] });
    return p.rows.map(r => r.statusFace).join(',') === '已完成,进行中,已退回,没有完成' &&
      p.rows.every(r => ['RESERVED', 'COMPLETED', 'RELEASED', 'FAILED'].indexOf(r.statusFace) < 0);
  })(), C.buildPurchaseModel(purchasesRes, productsRes, intentsRes, {}).rows.map(r => r.statusFace));

check('H2 ★★★ approvalMode === null 逐字表示"这条记录早于授权层"，**不是** AUTO_ALLOW',
  (function () {
    const p = C.buildPurchaseModel(purchasesRes, productsRes, intentsRes, { apiConfigs: [{ id: 'a1', nickname: '阿尔法' }] });
    const nullOne = p.rows.filter(r => r.mode === null)[0];
    const auto = p.rows.filter(r => r.mode === 'AUTO_ALLOW')[0];
    return nullOne.authText === '这条记录早于授权层' && auto.authText === C.AUTH_MODE_FACE.AUTO_ALLOW &&
      C.AUTH_MODE_FACE.AUTO_ALLOW !== C.AUTH_MODE_FACE.APPROVAL;
  })());

check('H3 ★★★★ "由谁发起"是**连出来的**：两条读面 join 得上才说，而且说的是角色名不是 id',
  (function () {
    const p = C.buildPurchaseModel(purchasesRes, productsRes, intentsRes, { apiConfigs: [{ id: 'a1', nickname: '阿尔法' }] });
    const one = p.rows.filter(r => r.purchaseId === 'econ_pur_1')[0];
    const two = p.rows.filter(r => r.purchaseId === 'econ_pur_2')[0];
    /* econ_pur_4 的 intent 指向 a9 —— 角色目录里没有 a9，因此**不写名字**。 */
    const four = p.rows.filter(r => r.purchaseId === 'econ_pur_4')[0];
    return one.agentLabel === '阿尔法' && two.agentLabel === null && four.agentId === 'a9' && four.agentLabel === null;
  })(), C.buildPurchaseModel(purchasesRes, productsRes, intentsRes, { apiConfigs: [{ id: 'a1', nickname: '阿尔法' }] }).rows.map(r => r.agentLabel));

check('H4 ★★★ 两条读面连不上时（没有 intents）**什么都不说**，绝不写一个猜的发起者',
  (function () {
    const p = C.buildPurchaseModel(purchasesRes, productsRes, null, {});
    return p.rows.every(r => r.agentId === null && r.agentLabel === null);
  })());

check('H5 ★★★ 商品名从目录 join；join 不上写"已经不存在的商品"',
  (function () {
    const p = C.buildPurchaseModel(purchasesRes, productsRes, intentsRes, {});
    return p.rows[0].name === '数字绘画额度' && p.rows[2].name === '一次修图' &&
      C.buildPurchaseModel({ ok: true, purchases: [{ purchaseId: 'x', productId: 'econ_prod_zz', amountMinor: '1', currency: 'IB_CREDIT', status: 'FAILED', createdAt: 1 }] }, null, null, {}).rows[0].name === C.COPY.productGone;
  })());

check('H6 ★★★ 金额取 canonical amountMinor；读面自己的三句否认被原样带出',
  (function () {
    const p = C.buildPurchaseModel(purchasesRes, productsRes, intentsRes, {});
    return p.rows[0].amountText === '20.00 IB Credit' && p.notPersonalized === true &&
      p.rows.every(r => String(r.amountText).indexOf('IB_CREDIT') < 0);
  })());

check('H7 ★★★ 空历史是一句话，不是一张空表',
  (function () {
    const p = C.buildPurchaseModel({ ok: true, purchases: [], personalized: false, recommended: false, ranked: false, exposesMutation: false }, productsRes, null, {});
    return p.empty === true && p.count === 0;
  })());

/* ══ I · 文案纪律 ══════════════════════════════════════════════════ */
section('I · 文案纪律：禁用词 / emoji / canonical 代号');

function userFacingBlob() {
  const parts = [JSON.stringify(C.COPY)];
  parts.push(JSON.stringify(C.STORE_STATUS_FACE));
  parts.push(JSON.stringify(C.PRODUCT_STATUS_FACE));
  parts.push(JSON.stringify(C.PURCHASE_STATE_FACE));
  parts.push(JSON.stringify(C.ASSET_KIND_FACE));
  parts.push(JSON.stringify(C.AUTH_MODE_FACE));
  parts.push(JSON.stringify(C.WALLET_STATE_FACE));
  parts.push(JSON.stringify(C.UNIT_FACE));
  return parts.join('\n');
}
const blob = userFacingBlob();

check('I1 ★★★ 文案里没有 §3 的禁用词（充值 / 提现 / 转账 / 银行卡 / 现金 / 人民币 / 美元 / 账户价值）',
  ['充值', '提现', '转账', '银行卡', '现金', '人民币', '美元', '账户价值', '支付', '法币', '¥', '￥']
    .every(w => blob.indexOf(w) < 0),
  ['充值', '提现', '转账', '银行卡', '现金', '人民币', '美元', '账户价值', '支付', '法币'].filter(w => blob.indexOf(w) >= 0));

check('I2 ★★★ 文案与代码里都没有 emoji（含金币 / 钱包 / 购物车那一类）',
  /* ★ 判的是**代码**（剥掉注释与字符串）与**用户看得见的字**（所有文案表）。
     注释里的 ★ 是这一仓库的排版标记，不是 emoji —— 所以剥掉再判，而不是
     在原文上判（那会得到一条"为了通过必须删掉注释"的假红）。 */
  !/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/u.test(coreCode) &&
  !/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/u.test(blob) &&
  !/[💰🪙💳🛒✨🎉]/u.test(coreCode + blob),
  (coreSrc.match(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu) || []).filter(c => coreCode.indexOf(c) >= 0));

check('I3 ★★★ 文案里没有 Compute 的禁用说法（Provider quota / API 余额 / Token 余额）',
  ['Provider', 'provider', 'Token', 'token', 'API 余额', 'DeepSeek', 'Claude', 'OpenAI'].every(w => blob.indexOf(w) < 0));

check('I4 ★★★★ 每一张状态词表的**右边**都是人话：没有一个值等于它的键（代号不裸漏）',
  (function () {
    const maps = { STORE: C.STORE_STATUS_FACE, PRODUCT: C.PRODUCT_STATUS_FACE, PURCHASE: C.PURCHASE_STATE_FACE, ASSET: C.ASSET_KIND_FACE, AUTH: C.AUTH_MODE_FACE };
    const bad = [];
    Object.keys(maps).forEach(name => {
      const m = maps[name];
      Object.keys(m).forEach(k => {
        const v = String(m[k]);
        if (v === k || v.indexOf(k) >= 0) bad.push(name + '.' + k);
      });
    });
    return bad.length === 0;
  })());

check('I5 ★★★ 状态词表的键与 canonical 契约的封闭集合逐字一致',
  Object.keys(C.STORE_STATUS_FACE).join(',') === 'ACTIVE,DISABLED' &&
  Object.keys(C.PRODUCT_STATUS_FACE).join(',') === 'ACTIVE,DISABLED,RETIRED' &&
  Object.keys(C.PURCHASE_STATE_FACE).join(',') === 'RESERVED,COMPLETED,RELEASED,FAILED' &&
  Object.keys(C.ASSET_KIND_FACE).join(',') === 'ITEM,COMPUTE' &&
  Object.keys(C.AUTH_MODE_FACE).join(',') === 'AUTO_ALLOW,APPROVAL',
  [Object.keys(C.STORE_STATUS_FACE), Object.keys(C.PRODUCT_STATUS_FACE), Object.keys(C.PURCHASE_STATE_FACE)]);

check('I6 ★★★ UNIT_FACE 的三个键就是契约的 PRODUCT_UNIT_NAME 的**值**（item / computeUnit / service）',
  Object.keys(C.UNIT_FACE).join(',') === 'item,computeUnit,service');

check('I7 ★★★ 契约里那三个词表在源码里逐字出现（这条断言证明 I5/I6 不是本地编的）',
  /STORES?_?STATUS[\s\S]{0,120}ACTIVE/.test(read('services/home-node/economy-contract.js')) &&
  /PURCHASE_STATE\s*[:=]/.test(read('services/home-node/economy-contract.js')) &&
  /COMPUTE_UNIT_NAME\s*=\s*'computeUnit'/.test(read('services/home-node/economy-contract.js')));

check('I8 ★★★ 商品请求提示说的是"Agent 可以在规则允许时申请"，而不是"你可以购买"',
  C.COPY.productsRequestNote.indexOf('Agent') >= 0 &&
  C.COPY.productsRequestNote.indexOf('规则') >= 0 &&
  ['购买', '买下', '下单', '结算'].every(w => C.COPY.productsRequestNote.indexOf(w) < 0));

/* ══ J · 金额与时间 ═══════════════════════════════════════════════ */
section('J · 金额与时间：只有一个来源，只做本地化排版');

check('J1 ★★★ 千分位只加在整数部分，而且不改数值',
  C.groupDigits('12450.00') === '12,450.00' &&
  C.groupDigits('999') === '999' &&
  C.groupDigits('1000') === '1,000' &&
  C.groupDigits('1234567.89') === '1,234,567.89' &&
  C.groupDigits(null) === null);

check('J2 ★★★ 未知币种不给数字（不猜 scale，也不回退到代号）',
  C.moneyText('100', 'NOT_A_CURRENCY') === null && C.groupedMoney('100', 'NOT_A_CURRENCY') === null);

check('J3 ★★★ 时间是本地化排版，输入只有 canonical 的毫秒',
  (function () {
    const ms = 1700000000000;
    const d = new Date(ms);
    const p2 = n => (n < 10 ? '0' : '') + n;
    const want = d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()) + ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes());
    return C.timeText(ms) === want && C.timeText(0) === null && C.timeText(null) === null;
  })(), C.timeText(1700000000000));

check('J4 ★★★ 整页模型把六份读面拼成三个面板，而且不新增任何读面',
  (function () {
    const pv = C.buildPageView({
      owner: 'a1', stores: storesRes, products: productsRes, intents: intentsRes,
      wallet: walletReady, policy: policyRes, budgetSnapshot: snapshotRes,
      inventory: inventoryRes, purchases: purchasesRes, apiConfigs: [{ id: 'a1', nickname: '阿尔法' }]
    });
    return pv.wallet.primary === '12,450.00' && pv.budget.present === true &&
      pv.stores.rows.length === 3 && pv.products.count === 3 &&
      pv.assets.total === 3 && pv.purchases.count === 4;
  })());

console.log('\n结果: ' + checks + ' 通过, ' + failures + ' 失败');
if (failures) process.exit(1);
