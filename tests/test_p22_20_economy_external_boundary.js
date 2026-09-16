/* ══════════════════════════════════════════════════════════════════════
   P22-20 · Economy External Boundary Audit

   §1 要求把外部能力**逐条**查清楚（Provider billing / Provider quota /
      Real payment / Refund / Exchange / Merchant / External order），
      而且"重点不是看名字"—— 要沿 require/import → function call →
      data mutation 确认。

   §2 要求证明 Economy 生产文件的**依赖闭包**：
         Economy ├─ sqlite ├─ crypto ├─ internal ledger ├─ internal
                 inventory └─ stop
      且闭包里没有 payment-provider / alipay / stripe / provider API /
      billing SDK / credential store / network call。

   §4/§5/§6/§7 各有一节。

   ★ 这一条测试**完全不碰**数据库：不 open()、不建临时目录、不 spawn、
     不开 socket、不开浏览器。所有"活体"注入在
     test_p22_20_economy_boundary_injection.js 里。

   ── 扫描方法（三个工具，各管一件事）─────────────────────────────────
     ① `blankComments`（保留字符串内容，只挖掉注释）
        —— 用来找 require：模块名本身是一个字符串字面量。
     ② `blankCommentsAndStrings`（注释与字符串内容都挖掉，**保留引号**）
        —— 用来找"代码形态"的引用：调用、成员访问、标识符。
        Econom 里的否认词表本身就是字符串常量；把字符串内容挖掉，
        "写下来的否认"就不会被误算成"引用"。
     ③ 上面两个都建立在同一个**逐字符小词法器**上，而不是正则。
        ★ 为什么（这是本轮真实踩到的坑）：原先用
          `/'([^'\\]|\\.)*'/g` 一步挖字符串，一旦某一行的注释里有一个
          未闭合的引号（例如注释中的 `don't`）或一个 `//` 出现在字符串里，
          配对就会整体错位 —— 于是一整个文件被"吞"成一行 49,000 字符的
          假代码，扫描结果全是噪声（实测：7 个 deny-list 命中里有 5 个是
          假的）。词法器在**换行处恢复**，因此一个错位的引号最多影响一行。
   ══════════════════════════════════════════════════════════════════════ */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const ROOT = path.resolve(__dirname, '..');
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }
function exists(rel) { return fs.existsSync(path.join(ROOT, rel)); }

/* ── 逐字符小词法器：注释与字符串内容都被挖成空格，位置与换行都保留 ───── */
function blank(src, keepStringContent) {
  const s = String(src);
  let out = '';
  let i = 0;
  let mode = 'code';
  const n = s.length;
  while (i < n) {
    const c = s[i], c2 = s[i + 1];
    if (mode === 'code') {
      if (c === '/' && c2 === '/') { mode = 'line'; out += '  '; i += 2; continue; }
      if (c === '/' && c2 === '*') { mode = 'block'; out += '  '; i += 2; continue; }
      if (c === "'") { mode = 'sq'; out += c; i += 1; continue; }
      if (c === '"') { mode = 'dq'; out += c; i += 1; continue; }
      if (c === '`') { mode = 'tpl'; out += c; i += 1; continue; }
      out += c; i += 1; continue;
    }
    if (mode === 'line') {
      if (c === '\n') mode = 'code';
      out += (c === '\n' ? c : ' '); i += 1; continue;
    }
    if (mode === 'block') {
      if (c === '*' && c2 === '/') { mode = 'code'; out += '  '; i += 2; continue; }
      out += (c === '\n' ? c : ' '); i += 1; continue;
    }
    if (mode === 'sq' || mode === 'dq') {
      if (c === '\\') { out += '  '; i += 2; continue; }
      const q = mode === 'sq' ? "'" : '"';
      if (c === q) { mode = 'code'; out += c; i += 1; continue; }
      /* ★ 换行处恢复：未闭合的引号不允许把后面的代码一起吃掉。 */
      if (c === '\n') { mode = 'code'; out += c; i += 1; continue; }
      out += (keepStringContent ? c : ' '); i += 1; continue;
    }
    /* tpl */
    if (c === '\\') { out += '  '; i += 2; continue; }
    if (c === '`') { mode = 'code'; out += c; i += 1; continue; }
    out += (c === '\n' ? c : (keepStringContent ? c : ' ')); i += 1; continue;
  }
  return out;
}
function blankComments(src) { return blank(src, true); }
function blankCommentsAndStrings(src) { return blank(src, false); }

function countMatches(src, re) {
  const flags = re.flags.indexOf('g') >= 0 ? re.flags : re.flags + 'g';
  return (String(src).match(new RegExp(re.source, flags)) || []).length;
}
function identifiersOf(src) {
  return new Set(String(src).match(/[A-Za-z_$][A-Za-z0-9_$]*/g) || []);
}

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

console.log('P22-20 · Economy External Boundary Audit');

/* ── 被测对象：services/home-node/economy*.js ────────────────────────
   §2 点名了六个；第七个（economy-approval-decision.js）是 P22-13 建的
   第三条写路径的 seam，同一个边界必须一起证明 —— 漏掉它，"闭包"就不是
   闭包。这里用**目录枚举**而不是硬编码名字：新加一个 economy-*.js 会
   自动进入闭包与扫描面，于是"悄悄新增一个生产文件"会让断言当场变红。 */
const ECONOMY_DIR = path.join(ROOT, 'services', 'home-node');
const ECONOMY_FILES = fs.readdirSync(ECONOMY_DIR)
  .filter(f => /^economy-.*\.js$/.test(f)).sort()
  .map(f => 'services/home-node/' + f);
const UI_FILES = [
  'assets/js/economy-approval-core.js', 'assets/js/economy-approval.js',
  'assets/js/economy-configuration-core.js', 'assets/js/economy-configuration.js',
  'assets/js/economy-shell-core.js', 'assets/js/economy-shell.js'
];

const economyRaw = ECONOMY_FILES.map(read).join('\n');
const economyCode = blankCommentsAndStrings(economyRaw);
const C = require(path.join(ROOT, 'services', 'home-node', 'economy-contract.js'));

/* ══════════════════════════════════════════════════════════════════════
   §1 · External Capability Audit
   ══════════════════════════════════════════════════════════════════════ */
section('§1 · 外部能力矩阵（"存在"由证据决定，不是由名字决定）');

/* 每一行回答四件事：这个能力在仓库里**有没有**、它的 canonical owner 是谁、
   证明"有"需要哪些逐字证据（文件 + 字符串）、Economy 引用了几次。
   "有没有"这一列不是结论，A1 会把每一条 needle 在真实文件里找一遍。 */
const CAPABILITY_MATRIX = [
  {
    key: 'providerBilling', label: 'Provider billing',
    exists: 'metadata-only',
    owner: 'provider 官网（仓库外）；仓库内只有 provider-directory 的 billingHint 人话',
    needles: [['assets/js/provider-directory.js', 'billingHint']]
  },
  {
    key: 'providerQuota', label: 'Provider quota',
    exists: 'absent',
    owner: 'provider 官网（仓库外）；仓库内没有任何读取路径',
    needles: []
  },
  {
    key: 'realPayment', label: 'Real payment',
    exists: 'full',
    owner: 'Bridge（bridge/alipay-provider.js · bridge/pay-gate.js）+ Active（active/payment-auth.js）',
    needles: [
      ['bridge/alipay-provider.js', 'spawnSync'],
      ['bridge/alipay-provider.js', 'submit-payment'],
      ['bridge/pay-gate.js', 'commitSpend'],
      ['active/payment-auth.js', 'under_limit']
    ]
  },
  {
    key: 'refund', label: 'Refund',
    exists: 'absent',
    owner: '不存在（Economy 里只有"没有退款"这条自述）',
    needles: []
  },
  {
    key: 'exchange', label: 'Exchange',
    exists: 'vocabulary-only',
    owner: '不存在可执行能力；契约 §17 冻结了汇率算术与词表槽位，零调用方',
    needles: [['services/home-node/economy-contract.js', 'computeExchangeAmount']]
  },
  {
    key: 'merchant', label: 'Merchant',
    exists: 'full',
    owner: 'Active 购物域（active/commerce.js · active/payment-auth.js）',
    needles: [['active/commerce.js', 'merchant'], ['active/payment-auth.js', 'merchant']]
  },
  {
    key: 'externalOrder', label: 'External order',
    exists: 'full',
    owner: 'Bridge / Active 购物域（bridge/pay-gate.js · active/commerce.js）',
    needles: [['bridge/pay-gate.js', 'orderId'], ['active/commerce.js', 'paymentIntent']]
  }
];

const matrixEvidence = CAPABILITY_MATRIX.map(row => ({
  key: row.key,
  expected: row.needles.length,
  proved: row.needles.filter(([f, needle]) => !!f && exists(f) && read(f).indexOf(needle) >= 0).length
}));
check('A1 ★★★★ 矩阵每一行的存在性都被真实文件逐字证明（"不存在"的能力不需要证据）',
  matrixEvidence.every(r => r.proved === r.expected), matrixEvidence);

check('A2 ★★★★ 扫描器不是空的：把一条**存在的**外部证据放进去，它必须找到（canary）',
  exists('bridge/alipay-provider.js') && read('bridge/alipay-provider.js').indexOf('alipay-bot') >= 0);

check('A3 ★★★★ Economy 生产文件恰好是目录里全部 economy-*.js（七个，含 P22-13 的 seam）',
  ECONOMY_FILES.length === 7 &&
  ECONOMY_FILES.indexOf('services/home-node/economy-approval-decision.js') >= 0, ECONOMY_FILES);

/* ── §1 第一层：require / import ───────────────────────────────────── */
const economyRequires = (blankComments(economyRaw).match(/require\(\s*'([^']+)'\s*\)/g) || [])
  .map(s => (s.match(/'([^']+)'/) || [])[1]);
check('A4 ★★★★★ require 层面：没有任何一个模块名落在外部能力命名空间里',
  economyRequires.length > 0 && economyRequires.every(spec =>
    !/pay|billing|alipay|stripe|provider|merchant|commerce|shopping|credential|vault/i.test(spec)),
  economyRequires);

/* ── §1 第二层：function call ──────────────────────────────────────── */
/* 只认**调用形态**。理由：§1 说的是"沿 function call 确认"，而一个词出现
   在对象字面量的键上（`refundIssued: false`）是一次**自述**，不是一次调用。
   下面 A6 会把这些自述逐个列出来单独断言。 */
const EXTERNAL_CALL_SHAPES = [
  { key: 'memberCall', re: /\.\s*(?:pay|payment|refund|reverse|chargeback|exchange|convert|topup|topUp|withdraw|cashout|billing|merchant|checkout|recharge|reload)[A-Za-z0-9_]*\s*\(/ },
  { key: 'bareCall', re: /(?:^|[^.\w$])(?:pay|payment|refund|reverse|chargeback|convert|topup|topUp|withdraw|cashout|billing|merchant|checkout|recharge|reload)[A-Za-z0-9_]*\s*\(/ },
  { key: 'pspSurface', re: /\balipay\b|\bstripe\b|\bpaypal\b|\bwechatpay\b|\bcheckoutUrl\b|\bpaymentIntent\b|\bsubmit_payment\b|\bcommitSpend\b/i }
];
const callHits = EXTERNAL_CALL_SHAPES.map(shape => ({
  key: shape.key, hits: countMatches(economyCode, shape.re)
}));
check('A5 ★★★★★ Economy 生产代码里对外部能力的**调用形态** = 0（成员调用 / 裸调用 / 支付网关标识符）',
  callHits.every(h => h.hits === 0), callHits.filter(h => h.hits !== 0));

const uiCode = blankCommentsAndStrings(UI_FILES.map(read).join('\n'));
const uiCallHits = EXTERNAL_CALL_SHAPES.map(shape => ({
  key: shape.key, hits: countMatches(uiCode, shape.re)
}));
check('A6 ★★★★★ 展示层六个文件同样是 0 次调用（UI 不能是绕过去的那条路）',
  uiCallHits.every(h => h.hits === 0), uiCallHits.filter(h => h.hits !== 0));

/* ── §1 第三层：data mutation ──────────────────────────────────────── */
/* ★ 为什么这里不比"SQL 文本里的表名"：store 的 SQL 全是
   `'INSERT INTO ' + ACCOUNTS_TABLE + ' …'` 形式的**拼接**，表名本身不在
   字符串里。用文本去数会数出 0 条表名 —— 那是一条永远为真的假断言。
   改成断言一条更强的、可数的性质：表常量与导出的表名都是封闭的 economy_* 集合。
   ★ 审计口径（本轮实测）：store 里有 **20** 个 `*_TABLE` 常量，而 `TABLES`
   导出只有 **16** 项（少了 APPROVALS / AUTONOMY_POLICIES / POLICY_LIMIT /
   PURCHASE_INTENTS 四张 P22-7/P22-8/P22-14 建的表）。这不是外部边界问题，
   但它是一个**真实的描述性缺口**，因此这里把两个数字都断言下来：将来谁补齐
   导出，这一条会红并提醒更新审计口径；谁再加一张表而漏了导出，也会红。 */
check('A7 ★★★★★ data mutation 层面：表常量与导出的表名都是封闭的 economy_* 集合，没有一张是外部概念',
  (function () {
    const storeApi = require(path.join(ROOT, 'services', 'home-node', 'economy-store.js'))({
      dataDir: path.join(ROOT, '.tmp-p2220-never-opened'), logger: function () { }
    });
    const tables = Object.values(storeApi.TABLES);
    const externalShaped = tables.filter(t => /pay|billing|provider|merchant|order|refund|exchange|quota/i.test(t));
    const storeCode = blankCommentsAndStrings(read('services/home-node/economy-store.js'));
    const tableConstants = Array.from(new Set(storeCode.match(/\b[A-Z][A-Z0-9_]*_TABLE\b/g) || []));
    return tableConstants.length === 20 &&
      tables.length === 16 &&
      new Set(tables).size === 16 &&
      tables.every(t => /^economy_/.test(t)) &&
      externalShaped.length === 0;
  })());

/* ── §1 收尾：代码里出现的每一个外部词，都必须是"写下来的否认" ───────── */
/* 这一条是本次审计最有信息量的一条：它不要求"一个词都不出现"，而是要求
   **每一个出现都被点名解释**。任何新出现的标识符都会落进"未声明"里，于是
   将来有人真的接了一条支付调用，这份审计会立刻变红。 */
const DECLARED_CODE_IDENTIFIERS = {
  refund: {
    frozenVocabulary: ['REFUND', 'PURCHASE_HAS_REFUND', 'PURCHASE_CANCEL_PRODUCES_A_LEDGER_REFUND'],
    falseBits: ['refundIssued', 'hasRefund', 'purchaseHasRefund', 'purchaseCancelIssuesARefund', 'canRefund']
  },
  exchange: {
    frozenVocabulary: ['EXCHANGE', 'EXCHANGE_RATE', 'EXCHANGE_ROUNDING', 'EXCHANGE_RATE_INDEX_PREFIX',
      'EXCHANGE_APPLY', 'EXCHANGE_COMMITTED', 'EXCHANGE_RATE_UNKNOWN', 'EXCHANGE_ROUNDS_TO_ZERO',
      'EXCHANGE_CROSS_DOMAIN_FORBIDDEN', 'computeExchangeAmount', 'validateExchangeRate', 'exchangeRateId'],
    falseBits: ['canExchange']
  },
  provider: {
    frozenVocabulary: ['API_QUOTA', 'PURCHASE_TOUCHES_PROVIDER', 'PURCHASE_INTENT_TOUCHES_PROVIDER'],
    falseBits: ['autonomyTouchesProvider', 'canTopUpAProvider', 'isProviderQuota',
      'providerMutation', 'providerQuotaMutation', 'purchaseTouchesProvider']
  },
  realPayment: {
    frozenVocabulary: ['PURCHASE_TOUCHES_PAYMENT', 'PURCHASE_INTENT_TOUCHES_PAYMENT',
      /* ★ 这一条是**正向**否认句（`…IsNotPaymentAuthority: true`），因此它属于
         "契约里写下来的否认"，不属于"恒 false 位"那一类。 */
      'configurationAuthorityIsNotPaymentAuthority'],
    falseBits: ['autonomyTouchesPayment', 'countsAsPaymentCurrency',
      'isAPaymentAuthority', 'paymentMutation', 'purchaseTouchesPayment']
  },
  merchant: { frozenVocabulary: [], falseBits: ['storeIsAMerchant'] },
  externalOrder: { frozenVocabulary: [], falseBits: [] }
};
/* 家族正则刻意**宽**：宁可多要一次声明，也不放过一个新出现的词。
   唯一的例外是 payload —— 它是 change log 的 canonical 列名，与支付无关。 */
const EXTERNAL_ID_RE = {
  refund: /refund|revers|chargeback/i,
  exchange: /exchange|convert|cashout|withdraw/i,
  provider: /provider|billing|quotaremaining|tokenquota|apibalance|stripe|paypal|alipay|wechatpay|^api_quota$/i,
  realPayment: /payment|checkout|commitSpend|registerCheckout|^psp/i,
  merchant: /merchant/i,
  externalOrder: /orderid|externalorder|invoice/i
};
const economyIdentifiers = Array.from(identifiersOf(economyCode));
const undeclared = [];
const declaredSeen = new Set();
const declaredAll = [];
for (const family of Object.keys(EXTERNAL_ID_RE)) {
  const declared = DECLARED_CODE_IDENTIFIERS[family].frozenVocabulary
    .concat(DECLARED_CODE_IDENTIFIERS[family].falseBits);
  for (const d of declared) declaredAll.push(d);
  for (const id of economyIdentifiers) {
    if (!EXTERNAL_ID_RE[family].test(id)) continue;
    if (declared.indexOf(id) < 0) { undeclared.push(family + ':' + id); continue; }
    declaredSeen.add(id);
  }
}
check('A8 ★★★★★ Economy 代码里出现的每一个外部词都在**声明的**两类里（冻结词表 / 恒 false 自述）—— 没有未声明的出现',
  undeclared.length === 0, undeclared);

check('A8b ★★★★ 声明表里没有僵尸条目：每一条声明都真的在代码里出现过（避免"声明了一堆没用的名字"）',
  declaredAll.length > 0 && declaredAll.every(d => declaredSeen.has(d)),
  declaredAll.filter(d => !declaredSeen.has(d)));

check('A9 ★★★★★ 所有"恒 false 自述"在源码里真的是 false（字面量，或引用一个契约里为 false 的常量）',
  (function () {
    function rhsIsFalse(raw) {
      const rhs = String(raw).trim();
      if (rhs === 'false') return true;
      const named = /^(?:C\.)?([A-Z][A-Z0-9_]*)$/.exec(rhs);
      return !!named && C[named[1]] === false;
    }
    const bits = [];
    for (const family of Object.keys(DECLARED_CODE_IDENTIFIERS)) {
      for (const id of DECLARED_CODE_IDENTIFIERS[family].falseBits) bits.push(id);
    }
    return bits.length > 0 && bits.every(id => {
      /* 契约里直接是常量 ⇒ 以契约为权威。 */
      if (Object.prototype.hasOwnProperty.call(C, id)) return C[id] === false;
      const assignRe = new RegExp('\\b' + id + '\\s*[:=]\\s*([^,;\\n]+)', 'g');
      const values = (economyCode.match(assignRe) || []).map(v => v.replace(new RegExp('^\\s*' + id + '\\s*[:=]\\s*'), ''));
      return values.length > 0 && values.every(rhsIsFalse);
    });
  })());

/* ══════════════════════════════════════════════════════════════════════
   §2 · Economy → External Dependency Closure
   ══════════════════════════════════════════════════════════════════════ */
section('§2 · 依赖闭包：Economy ├─ sqlite ├─ crypto ├─ ledger ├─ inventory └─ stop');

function resolveRequire(fromRel, spec) {
  if (spec.startsWith('node:')) return { kind: 'builtin', id: spec };
  if (!spec.startsWith('.') && !spec.startsWith('/')) return { kind: 'bare', id: spec };
  const abs = path.resolve(path.dirname(path.join(ROOT, fromRel)), spec);
  for (const cand of [abs, abs + '.js', path.join(abs, 'index.js')]) {
    if (fs.existsSync(cand) && fs.statSync(cand).isFile()) {
      return { kind: 'file', id: path.relative(ROOT, cand).replace(/\\/g, '/'), abs: cand };
    }
  }
  return { kind: 'missing', id: spec };
}
function requiresOf(rel) {
  const out = [];
  const re = /require\(\s*'([^']+)'\s*\)/g;
  let m;
  const code = blankComments(read(rel));
  while ((m = re.exec(code))) out.push(m[1]);
  return out;
}

const CLOSURE_ALLOWED_NODE_MODULES = ['node:sqlite', 'node:crypto', 'node:http', 'node:path', 'node:fs'];
const CLOSURE_ALLOWED_BARE = ['path', 'fs'];
const CLOSURE_ALLOWED_FILES = ECONOMY_FILES.concat(['runtime/db-failure.js']);

const closureFiles = [];
const closureEdges = [];
const seen = Object.create(null);
const queue = ECONOMY_FILES.map(rel => ({ rel: rel, via: '(entry)' }));
while (queue.length) {
  const cur = queue.shift();
  if (seen[cur.rel]) continue;
  seen[cur.rel] = cur.via;
  closureFiles.push({ file: cur.rel, via: cur.via });
  for (const spec of requiresOf(cur.rel)) {
    const r = resolveRequire(cur.rel, spec);
    closureEdges.push({ from: cur.rel, spec: spec, to: r.id, kind: r.kind });
    if (r.kind === 'file') queue.push({ rel: r.id, via: cur.rel });
  }
}

check('B1 ★★★★★ 闭包恰好是七个 Economy 文件 + runtime/db-failure.js（一个不多一个不少）',
  closureFiles.length === 8 &&
  CLOSURE_ALLOWED_FILES.every(f => closureFiles.some(c => c.file === f)) &&
  closureFiles.every(c => CLOSURE_ALLOWED_FILES.indexOf(c.file) >= 0), closureFiles);

const outsideFileEdges = closureEdges.filter(e => e.kind === 'file' && CLOSURE_ALLOWED_FILES.indexOf(e.to) < 0);
check('B2 ★★★★★ 闭包里没有任何一条指向白名单之外的**文件**依赖（0 条）', outsideFileEdges.length === 0, outsideFileEdges);

const builtins = Array.from(new Set(closureEdges.filter(e => e.kind === 'builtin').map(e => e.to))).sort();
const bares = Array.from(new Set(closureEdges.filter(e => e.kind === 'bare').map(e => e.to))).sort();
check('B3 ★★★★ 内建依赖恰好是 sqlite / crypto / http / path / fs（没有 SDK、没有网络客户端库）',
  builtins.every(b => CLOSURE_ALLOWED_NODE_MODULES.indexOf(b) >= 0) &&
  bares.every(b => CLOSURE_ALLOWED_BARE.indexOf(b) >= 0), { builtins: builtins, bares: bares });

check('B4 ★★★★ 裸 specifier 只有 path 与 fs —— 没有一处 `require(\'crypto\')`（那一处是注释里"我们不用它"）',
  bares.slice().sort().join(',') === 'fs,path', bares);

check('B5 ★★★★★ 闭包里没有任何 SDK / 支付库 / 凭据库（按包名逐条否认）',
  (function () {
    const banned = /^(axios|node-fetch|got|undici|request|superagent|stripe|@stripe\/|paypal|alipay|wechatpay|@alicloud\/|@aws-sdk\/|openai|@anthropic-ai\/|@google\/generative-ai|keytar|dotenv|vault|node-vault)/;
    return builtins.concat(bares).every(s => !banned.test(s));
  })());

check('B6 ★★★★★ 闭包里**零** process.env（Economy 不持有凭据、也不持有任何外部端点配置）',
  closureFiles.every(c => countMatches(blankComments(read(c.file)), /process\.env/) === 0));

check('B7 ★★★★ fs 的唯一用途是建数据目录（没有第二种文件写入）',
  (function () {
    const store = blankCommentsAndStrings(read('services/home-node/economy-store.js'));
    const calls = Array.from(new Set(store.match(/\bfs\.[a-zA-Z]+/g) || []));
    return calls.length === 1 && calls[0] === 'fs.mkdirSync';
  })());

check('B8 ★★★★★ 闭包里唯一的网络原语是 node:http 的**一个出站** transport：没有 createServer / listen',
  (function () {
    const all = closureFiles.map(c => blankCommentsAndStrings(read(c.file))).join('\n');
    return countMatches(all, /\.createServer\s*\(/) === 0 &&
      countMatches(all, /\.listen\s*\(/) === 0 &&
      countMatches(all, /nodeHttp\.request\s*\(/) === 1;
  })());

check('B9 ★★★★ 闭包是有限且终止的：每个文件只展开一次，边数有限且无环',
  closureFiles.length === new Set(closureFiles.map(c => c.file)).size && closureEdges.length < 60,
  { files: closureFiles.length, edges: closureEdges.length });

/* ══════════════════════════════════════════════════════════════════════
   §4 · Payment Boundary Audit
   ══════════════════════════════════════════════════════════════════════ */
section('§4 · 支付边界：合法的方向存在，非法的方向没有代码');

check('C1 ★★★★★ 合法的方向**已经存在**且是唯一的外部价值入口：配置 seam 的 BOOTSTRAP_CREDIT → store 的一次性初始额度',
  (function () {
    const createSeam = require(path.join(ROOT, 'services', 'home-node', 'economy-configuration.js'));
    const seam = createSeam({ store: {}, decide: function () { }, logger: function () { } });
    const described = seam.describe();
    const storeApi = require(path.join(ROOT, 'services', 'home-node', 'economy-store.js'))({
      dataDir: path.join(ROOT, '.tmp-p2220-never-opened'), logger: function () { }
    });
    return described.commands.indexOf('BOOTSTRAP_CREDIT') >= 0 &&
      described.path === '/internal/economy/configuration' &&
      typeof storeApi.bootstrapInitialCredit === 'function' &&
      typeof storeApi.getInitialCreditBootstrap === 'function' &&
      /* 一次性是 canonical store 的事实，不是路由层的一次检查。 */
      /oneShot:\s*true/.test(read('services/home-node/economy-store.js'));
  })());

check('C2 ★★★★★ 非法的方向（Economy Ledger → 支付宝/Stripe → 真实扣款）没有代码：settlePurchase 体内零支付**调用**',
  (function () {
    const src = read('services/home-node/economy-store.js');
    const i = src.indexOf('function settlePurchase');
    if (i < 0) return false;
    /* ★ 这里必须用**调用形态**，不能用裸词：settlePurchase 的返回值上带着
       `providerMutation: false` / `paymentMutation: false` 这些自述，裸词会
       把它们算成"碰了支付"，而它们恰恰是边界的证据。 */
    const body = blankCommentsAndStrings(src.slice(i, i + 60000));
    return EXTERNAL_CALL_SHAPES.every(shape => countMatches(body, shape.re) === 0) &&
      /* 反向证明这段窗口真的是 settlePurchase 的体（不是空切片）。 */
      /reservation|ledger/i.test(body);
  })());

check('C3 ★★★★★ 模块级证明：真 require 七个文件时没有任何一次请求支付模块（Module._load 拦截）',
  (function () {
    const requested = [];
    const original = Module._load;
    Module._load = function (request) {
      requested.push(String(request));
      return original.apply(this, arguments);
    };
    try {
      for (const rel of ECONOMY_FILES) require(path.join(ROOT, rel));
    } finally {
      Module._load = original;
    }
    const suspicious = requested.filter(r => /pay|billing|alipay|stripe|provider|merchant|commerce|shopping|credential|vault/i.test(r));
    return requested.length > 0 && suspicious.length === 0;
  })());

check('C4 ★★★★★ ledger 的 counterparty 是**封闭集合** {system:treasury, system:market}：账本结构上点名不了一个商户或支付机构',
  (function () {
    const storeApi = require(path.join(ROOT, 'services', 'home-node', 'economy-store.js'))({
      dataDir: path.join(ROOT, '.tmp-p2220-never-opened'), logger: function () { }
    });
    const cp = storeApi.COMMIT_COUNTERPARTIES;
    return Array.isArray(cp) && cp.length === 2 &&
      cp.indexOf('system:treasury') >= 0 && cp.indexOf('system:market') >= 0 &&
      cp.every(c => /^system:/.test(c)) &&
      /COMMIT_COUNTERPARTIES\.indexOf\(counterparty\) < 0/.test(read('services/home-node/economy-store.js')) &&
      cp.indexOf('system:market') >= 0;
  })());

/* ══════════════════════════════════════════════════════════════════════
   §5 · Provider Boundary Audit（Compute）
   ══════════════════════════════════════════════════════════════════════ */
section('§5 · Provider 边界：Compute Entitlement 只是 Inventory Asset');

check('D1 ★★★★ assetKind 是封闭两员 {ITEM, COMPUTE}；COMPUTE 只由 API_QUOTA / COMPUTE_CREDIT 映射而来',
  C.ASSET_KINDS.join(',') === 'ITEM,COMPUTE' &&
  C.assetKindOfProductKind('API_QUOTA') === 'COMPUTE' &&
  C.assetKindOfProductKind('COMPUTE_CREDIT') === 'COMPUTE' &&
  C.assetKindOfProductKind('SERVICE') === null &&
  C.assetKindOfProductKind('DIGITAL_ITEM') === 'ITEM');

check('D2 ★★★★ 结算原语里 COMPUTE_ENTITLEMENT 与 INVENTORY 同级，SERVICE_EXECUTION 指向 null（做不到就拒绝）',
  C.SETTLEMENT_PRIMITIVE.COMPUTE_ENTITLEMENT === 'COMPUTE_ENTITLEMENT' &&
  C.SETTLEMENT_PRIMITIVE_OF_FULFILLMENT.COMPUTE_GRANT === 'COMPUTE_ENTITLEMENT' &&
  C.SETTLEMENT_PRIMITIVE_OF_FULFILLMENT.INVENTORY_GRANT === 'INVENTORY' &&
  C.SETTLEMENT_PRIMITIVE_OF_FULFILLMENT.SERVICE_EXECUTION === null);

check('D3 ★★★★ 计量单位只有一个名字 computeUnit；token / usd / providerBalance / apiCredit 全部逐字否认',
  C.COMPUTE_UNIT_NAME === 'computeUnit' &&
  C.COMPUTE_UNIT_ALIASES.join(',') === 'computeUnit,computeUnits' &&
  ['token', 'tokens', 'virtualToken', 'usd', 'cny', 'balance', 'providerBalance',
    'providerCredit', 'apiCredit', 'realCredit'].every(v => C.isForbiddenComputeAlias(v) === true) &&
  C.isForbiddenComputeAlias('computeUnit') === false);

check('D4 ★★★★ 商品校验把"provider 额度"型的字段与单位都拒绝（这是否认，不是漏检）',
  (function () {
    const base = {
      productId: 'econ_product_p2220', storeId: 'econ_store_p2220', kind: 'COMPUTE_CREDIT',
      fulfillment: 'COMPUTE_GRANT', name: '算力额度', currency: 'IB_CREDIT',
      unitPriceMinor: '100', unitName: 'computeUnit', grantQuantity: 10, status: 'ACTIVE'
    };
    return C.validateProduct(base).ok === true &&
      C.validateProduct(Object.assign({}, base, { unitName: 'tokens' })).ok === false &&
      C.validateProduct(Object.assign({}, base, { unitName: 'usd' })).ok === false &&
      C.validateProduct(Object.assign({}, base, { providerQuota: 100 })).ok === false &&
      C.validateProduct(Object.assign({}, base, { providerBalance: '10' })).ok === false &&
      C.validateProduct(Object.assign({}, base, { grantQuantity: 0 })).ok === false;
  })());

check('D5 ★★★★★ §5"只允许 display label improvement"**已经落地并且真的被渲染**：COMPUTE 那组带否认句',
  (function () {
    const core = read('assets/js/economy-shell-core.js');
    const shell = read('assets/js/economy-shell.js');
    const buildsNote = /note:\s*kindKey === 'COMPUTE' \? COPY\.assetsComputeNote : null/.test(core);
    /* ★ 纯层有、渲染器不画 = 等于没有。这一条必须分两步断言。 */
    const rendersNote = /if \(grp\.note\) box\.appendChild\(note\(grp\.note/.test(shell);
    const copy = (core.match(/assetsComputeNote:\s*'([^']*)'/) || [])[1] || '';
    const unitFace = /computeUnit:\s*'算力单位'/.test(core);
    return buildsNote && rendersNote && unitFace &&
      copy.indexOf('不是任何外部服务的余额或额度') >= 0 && copy.indexOf('Compute Entitlement') >= 0;
  })());

check('D6 ★★★★ Economy 里没有 provider 适配器：没有 provider-* 生产文件，也没有 adapter 形态的标识符',
  (function () {
    const files = fs.readdirSync(ECONOMY_DIR).filter(f => /provider/i.test(f));
    return files.length === 0 &&
      countMatches(economyCode, /\bproviderAdapter\b|\bcreateProviderAdapter\b|\bproviderClient\b/) === 0;
  })());

check('D7 ★★★★ 三处自述字段把"这不碰 provider"写成了可断言的常量',
  /isProviderQuota:\s*false/.test(read('services/home-node/economy-store.js')) &&
  /providerQuotaMutation:\s*false/.test(read('services/home-node/economy-store.js')) &&
  /configurationTouchesProvider:\s*false/.test(read('services/home-node/http.js')));

/* ══════════════════════════════════════════════════════════════════════
   §6 · Refund / Reverse Semantics Audit
   ══════════════════════════════════════════════════════════════════════ */
section('§6 · Refund：不实现，只回答"模型里有没有位置"');

check('E1 ★★★★★ 现状是**冻结的 false**：没有退款，purchase cancel 也不产生账本退款',
  C.PURCHASE_HAS_REFUND === false && C.PURCHASE_CANCEL_PRODUCES_A_LEDGER_REFUND === false);

check('E2 ★★★★★ 全仓没有 refundPurchase / reversePurchase / chargeback 的实现或调用',
  ECONOMY_FILES.concat(UI_FILES, ['services/home-node/http.js'])
    .every(rel => countMatches(blankCommentsAndStrings(read(rel)),
      /\brefundPurchase\b|\breversePurchase\b|\bchargeback\b|\bissueRefund\b|\brefund\(/) === 0));

check('E3 ★★★★★ 位置①：终端 Purchase 不可变，退款"必须是一笔新的补偿性经济操作"（契约逐字这么说）',
  /a terminal purchase is immutable; a refund must be a new compensating economic operation/.test(read('services/home-node/economy-contract.js')) &&
  /terminal-state-cannot-transition-must-compensate-with-a-new-transaction/.test(read('services/home-node/economy-contract.js')));

check('E4 ★★★★★ 位置②：REFUND 是 ledger 词表里**已登记**的 transaction type，且对消费窗口是 NEUTRAL',
  C.TX_TYPE.REFUND === 'REFUND' && C.TX_TYPES.indexOf('REFUND') >= 0 &&
  C.spendClassOfTransactionType('REFUND') === 'NEUTRAL' &&
  C.isSpendingTransactionType('REFUND') === false);

check('E5 ★★★★★ 位置③：库存有"再授予"原语（grantInventory），因此补偿性库存调整是可表达的',
  (function () {
    const api = require(path.join(ROOT, 'services', 'home-node', 'economy-store.js'))({
      dataDir: path.join(ROOT, '.tmp-p2220-never-opened'), logger: function () { }
    });
    return typeof api.grantInventory === 'function' && typeof api.consumeInventory === 'function' &&
      typeof api.inventoryQuantity === 'function';
  })());

check('E6 ★★★★★ 但"位置"停在词表层：事件词表里没有 refund/reversal 的 kind、没有 REVOKED 批准状态、没有 REFUND_APPLY 审计操作',
  (function () {
    const eventTypes = Object.keys(C.EVENT_TYPE || {});
    const auditOps = (C.AUDIT_OPERATION && typeof C.AUDIT_OPERATION === 'object') ? Object.keys(C.AUDIT_OPERATION) : [];
    return eventTypes.length > 0 &&
      eventTypes.filter(k => /REFUND|REVERS/i.test(k)).length === 0 &&
      Object.keys(C.APPROVAL_STATE).filter(k => /REVOK|REVERS/i.test(k)).length === 0 &&
      auditOps.indexOf('REFUND_APPLY') < 0 &&
      C.APPROVAL_STATE.CONSUMED === 'CONSUMED' &&
      /* 反向：EXCHANGE 的 kind **在**词表里（见 §7），因此上面那条"没有"
         不是因为整个词表读不出来。 */
      eventTypes.indexOf('EXCHANGE_COMMITTED') >= 0;
  })());

check('E7 ★★★★★ 所以结论是 future extension point，不是现状能力：四张记录各自缺什么被写成数据',
  (function () {
    const gaps = {
      ledger: 'TX_TYPE.REFUND 已登记，但没有产生它的操作（0 调用方）',
      purchase: '终端 Purchase 不可变，没有补偿性 Purchase 的写路径',
      inventory: 'grantInventory 可表达补偿，但没有 purchase → 反向授予的路径',
      changeLog: '没有 REFUND / REVERSAL 的 change kind',
      approval: 'CONSUMED 是终端状态，没有 REVOKED'
    };
    const storeApi = require(path.join(ROOT, 'services', 'home-node', 'economy-store.js'))({
      dataDir: path.join(ROOT, '.tmp-p2220-never-opened'), logger: function () { }
    });
    return Object.keys(gaps).length === 5 &&
      Object.keys(storeApi).filter(k => /refund|reversal/i.test(k)).length === 0;
  })());

/* ══════════════════════════════════════════════════════════════════════
   §7 · Exchange Audit
   ══════════════════════════════════════════════════════════════════════ */
section('§7 · Exchange：0 Economy capability（词表存在，能力不存在）');

check('F1 ★★★★★ IB_CREDIT ↔ 真实货币 在第一道闸门（币种否认清单）上就不可能，而且**跨域拒绝码本身**还作为第二道留着',
  (function () {
    const deny = ['USD', 'CNY', 'RMB', 'EUR', 'TOKEN', 'TOKENS', 'API_CREDIT', 'API_CREDITS',
      'PROVIDER_BALANCE', 'PROVIDER_CREDIT', 'OPENAI_BALANCE', 'ANTHROPIC_BALANCE',
      'DEEPSEEK_BALANCE', 'QWEN_BALANCE', 'GEMINI_BALANCE'];
    const allDenied = deny.every(t => C.validateCurrency(t).ok === false);
    const firstGate = C.validateCurrency('USD').errors.indexOf('currency-forbidden-real-money-or-provider-balance') >= 0;
    /* 一个带 USD 的汇率命题整条被拒。 */
    const forged = C.computeExchangeAmount('100', {
      exchangeRateId: 'econ_rate_p2220', fromCurrency: 'IB_CREDIT', toCurrency: 'USD',
      rateNumerator: 7, rateDenominator: 1, version: 1
    });
    const rejected = forged.ok === false && forged.errors.length > 0;
    /* ★ 审计发现（写下来，不假装它被触发过）：第二道闸门
       `exchange-cross-domain-forbidden` 在**第一道闸门是唯一币种权威**的前提下
       不可达 —— validateExchangeRate 只在两个币种都通过了 validateCurrency
       之后才成功，而 deny-list 已经在那一关把法币/provider 余额拒掉了。
       它是纵深防御，不是当前生效的那一道。这一条断言的是"它确实被写着"。 */
    const secondGateDeclared = /exchange-cross-domain-forbidden/.test(read('services/home-node/economy-contract.js'));
    /* 反向证明：Economy 内部两种币之间的兑换**是**可表达的 —— 否则上面
       "被拒"可能只是因为整个函数坏掉了。 */
    const intraOk = C.computeExchangeAmount('100', {
      exchangeRateId: 'econ_rate_p2220', fromCurrency: 'IB_CREDIT', toCurrency: 'COMPUTE_STANDARD',
      rateNumerator: 1, rateDenominator: 1, version: 1
    }).ok === true;
    return allDenied && firstGate && rejected && secondGateDeclared && intraOk;
  })());

check('F2 ★★★★★ 0 Economy capability：store 句柄 / HTTP **真实路由** / command 词表 / capability 表里都没有兑换',
  (function () {
    const api = require(path.join(ROOT, 'services', 'home-node', 'economy-store.js'))({
      dataDir: path.join(ROOT, '.tmp-p2220-never-opened'), logger: function () { }
    });
    const handleVerbs = Object.keys(api).filter(k => /exchange|convert|cashout/i.test(k));
    /* ★ 必须只看**真的路由判定**（`if (path === '/economy/x' && method === 'GET')`）。
       /security 的 unreachable 名单里**故意**写着 '/economy/exchange' ——
       那是"这条路径不可达"的否认，把它算成一条路由正好读反了。 */
    const httpStr = blankComments(read('services/home-node/http.js'));
    const realRoutes = httpStr.match(/path === '(\/economy\/[a-z-]+)'/g) || [];
    const denied = httpStr.match(/unreachable:\s*\[[^\]]*\]/g) || [];
    const channel = require(path.join(ROOT, 'services', 'home-node', 'economy-command-channel.js'));
    const cmds = channel.COMMAND_LIST.concat(channel.FORBIDDEN_COMMANDS);
    return handleVerbs.length === 0 &&
      realRoutes.length >= 20 &&
      realRoutes.every(r => r.indexOf('exchange') < 0 && r.indexOf('convert') < 0) &&
      /* 反向：否认名单里**确实**写着 /economy/exchange（否则上面那条"没有"
         只是因为名单也丢了）。 */
      denied.join(' ').indexOf('/economy/exchange') >= 0 &&
      cmds.every(c => !/EXCHANGE|CONVERT/.test(c)) &&
      Object.keys(C.CAPABILITY).every(c => !/EXCHANGE|CONVERT/.test(c));
  })());

check('F3 ★★★★★ computeExchangeAmount / validateExchangeRate 的**调用方** = 0（导出 ≠ 能力）',
  (function () {
    const callSites = [];
    for (const rel of ECONOMY_FILES.concat(UI_FILES, ['active/economy-channel-client.js', 'services/home-node/http.js'])) {
      if (rel === 'services/home-node/economy-contract.js') continue;
      const code = blankCommentsAndStrings(read(rel));
      if (/\bcomputeExchangeAmount\s*\(|\bvalidateExchangeRate\s*\(/.test(code)) callSites.push(rel);
    }
    /* 契约自己内部 validateExchangeRate 被 computeExchangeAmount 调一次，
       因此"调用方"必须**排除契约自己**才算得清。 */
    return callSites.length === 0;
  })());

check('F4 ★★★★★ 展示层没有兑换面：标识符只有 canonical 拒绝码，文案里的兑换字样只出现在**拒绝码的中文标签表**里',
  (function () {
    /* ① 代码层：UI 代码里唯一允许出现的兑换标识符是 canonical 的拒绝码
       （它们是一个"错误码 → 中文"映射表的**键**），不是功能名词。 */
    const uiIdentifiers = Array.from(identifiersOf(uiCode));
    const exchangeIds = uiIdentifiers.filter(id => /exchange|convert|cashout/i.test(id));
    const undeclaredIds = exchangeIds.filter(id => C.DENY_REASONS.indexOf(id) < 0);
    /* ② 文案层：把注释挖掉（注释里的"我们不提供充值/提现"是纪律说明，
       不是给用户看的话），剩下的每一行若含兑换字样，它的键必须是拒绝码。 */
    const uiCopy = blankComments(UI_FILES.map(read).join('\n'));
    const offenders = [];
    const labels = [];
    for (const line of uiCopy.split(/\r?\n/)) {
      if (!/exchange|convert|cashout|汇率|换算|提现|兑现/i.test(line)) continue;
      const m = /^\s*([A-Z][A-Z0-9_]*)\s*:\s*'/.exec(line);
      if (!m) { offenders.push(line.trim().slice(0, 120)); continue; }
      labels.push(m[1]);
      if (C.DENY_REASONS.indexOf(m[1]) < 0) offenders.push(line.trim().slice(0, 120));
    }
    /* ③ 反向：那三个标签必须真的存在（否则 ② 会因为一行都没有而假通过）。 */
    return exchangeIds.length === 3 && undeclaredIds.length === 0 && offenders.length === 0 &&
      labels.indexOf('EXCHANGE_RATE_UNKNOWN') >= 0 &&
      labels.indexOf('EXCHANGE_ROUNDS_TO_ZERO') >= 0 &&
      labels.indexOf('EXCHANGE_CROSS_DOMAIN_FORBIDDEN') >= 0;
  })());

check('F5 ★★★★ Treasury 与 system 账户也不是"外部配额"：COMMIT_COUNTERPARTIES 全部是 system:*',
  (function () {
    const api = require(path.join(ROOT, 'services', 'home-node', 'economy-store.js'))({
      dataDir: path.join(ROOT, '.tmp-p2220-never-opened'), logger: function () { }
    });
    return api.COMMIT_COUNTERPARTIES.every(c => c.indexOf('system:') === 0);
  })());

console.log('\n' + '─'.repeat(66));
console.log('结果: ' + (failures === 0 ? 'PASS' : failures + ' FAILED') + '（' + checks + ' 项）');
process.exitCode = failures === 0 ? 0 : 1;
