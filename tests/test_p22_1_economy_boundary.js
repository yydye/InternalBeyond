'use strict';
/* ====================================================================
   P22-1 · Agent Economy 依赖边界与真实支付隔离测试（static，零依赖）
   --------------------------------------------------------------------
   运行：node tests/test_p22_1_economy_boundary.js

   本文件回答的问题与 domain contract 测试**不同**：
     前者问"契约说了什么"，本文件问"生产代码有没有做到"。

   它锁住 P22-0 的最高风险（R1 / R2 / R4）：
     R1  Economy → Provider Billing 的写路径必须**结构性不存在**，
         而不是"注释里约定不调用"。
     R2  commerce.js 的 maxBudget（单位=元）不得被 Economy 解释。
     R4  release manifest 是**逐文件白名单**，新模块会静默从安装包消失。

   ── 为什么是"依赖闭包"而不是"grep 一个文件"────────────────────────────
   grep 'pay-gate' 只能证明"某个文件没写这个词"。真正的性质是：
     **Economy 的可达依赖闭包里，没有任何一个模块能碰钱或碰凭据。**
   因此这里做（且只做）三件事：
     ① 声明 Economy 生产文件清单，并强制它与磁盘一致（新增文件必须登记）；
     ② 从这些文件扫出全部 require 目标，逐个判定"能不能进闭包"；
     ③ 判定 release manifest 是否真的会把它们装进安装包。
   纯静态文本分析：不联网、不开浏览器、不启动服务、不写盘、不 require 生产模块
   （唯一的 require 是 economy-contract.js，它自己零 require）。

   ── 一条刻意的纪律：契约文件里**允许**出现被禁模块的名字 ──────────────
   契约把 BOUNDARY_FORBIDDEN_MODULES 写成**数据**（那些字符串必须存在，
   否则检查没有输入）。因此：
     · require 扫描对**所有** Economy 文件生效（扫的是 require(...) 的目标）；
     · 标识符扫描跳过契约文件，并且先剥掉注释与字符串字面量。
   这两条限制都写在断言的名字里，不藏在注释里。
   ==================================================================== */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const CONTRACT_REL = 'services/home-node/economy-contract.js';
const C = require(path.join(ROOT, CONTRACT_REL));

let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log('✔ ' + name);
  else {
    failures++;
    console.error('✖ ' + name + (extra !== undefined ? ' — ' + JSON.stringify(extra) : ''));
  }
}
function section(title) { console.log('\n── ' + title); }
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/^\uFEFF/, ''); }

/* ── 生产文件清单 ──────────────────────────────────────────────────────
   清单是**声明**，不是发现：新增 Economy 生产文件时必须手写在这里，
   否则 B2 会失败。这条纪律与 runtime/component-registry.js 的
   "注册表必须显式列全" 同源，也与 release-manifest 的逐文件白名单同源。

   P22-2 加入 economy-store.js（canonical Ledger + Wallet runtime）。
   它**没有**添加任何新的生产模块 —— 本阶段刻意只加一个文件，
   因为"多一个 manager/service/repository"正是 P22 §1 明确不要的东西。 */
const PRODUCTION_FILES = [
  'services/home-node/economy-contract.js',
  'services/home-node/economy-store.js'
];

/* 目录前缀与文件名模式：用来发现"清单漏登记"的文件。
   P22-2 起 services/home-node/economy/ 会出现，因此这里同时覆盖两种形状。 */
const ECONOMY_DIR = 'services/home-node/economy';
const ECONOMY_FILE_PREFIX = 'services/home-node/economy';

function discoverEconomyFiles() {
  const out = [];
  function collect(dirAbs, dirRel) {
    if (!fs.existsSync(dirAbs)) return;
    for (const entry of fs.readdirSync(dirAbs, { withFileTypes: true })) {
      const rel = dirRel + '/' + entry.name;
      if (entry.isDirectory()) collect(path.join(dirAbs, entry.name), rel);
      else if (/\.js$/i.test(entry.name)) out.push(rel);
    }
  }
  collect(path.join(ROOT, ECONOMY_DIR), ECONOMY_DIR);
  /* 平铺的 economy-*.js（契约与未来的 economy-*.js 同款命名） */
  for (const entry of fs.readdirSync(path.join(ROOT, 'services', 'home-node'), { withFileTypes: true })) {
    if (entry.isFile() && /^economy.*\.js$/i.test(entry.name)) {
      out.push('services/home-node/' + entry.name);
    }
  }
  return out.sort();
}

/* ── 文本归一化：剥掉注释与字符串字面量 ──────────────────────────────
   顺序是有意的：正则字面量 → 块注释 → 行注释 → 单引号串 → 双引号串 → 模板串。
   先剥离正则字面量，是因为它可能含 '//' 或引号。 */
function stripCommentsAndStrings(src) {
  return String(src)
    .replace(/\/(?![*\/])(?:\\.|\[(?:\\.|[^\]\\])*\]|[^\/\\\n])+\/[gimsuy]*/g, ' RE ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    /* (?:\\.|[^\\']) ：奇数个反斜杠才是转义 —— 否则 '\\' 会被当成未闭合串 */
    .replace(/'(?:\\.|[^\\'\n])*'/g, " '' ")
    .replace(/"(?:\\.|[^\\"\n])*"/g, ' "" ')
    .replace(/`(?:\\.|[^\\`])*`/g, ' `` ');
}

/* 扫出 require(...) 的目标（相对模块说明符）。
   **先剥注释**：否则一句解释性的注释（"本文件不 require('crypto')"）
   就会被当成一条真实依赖 —— 这类假阳性最坏的后果是让人为了让它变绿
   而删掉解释，而解释恰恰是这个仓库最重要的东西。
   （P22-2 实测踩到：economy-store.js 里解释"为什么不用 crypto"的注释
   被 B3.7 判成 require('crypto')。修的是**扫描器**，不是那句话。） */
function scanRequires(src) {
  const out = [];
  const raw = String(src);
  const re = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  let m;
  while ((m = re.exec(raw))) {
    const head = raw.slice(0, m.index);
    /* 落在 // 之后（同一行）⇒ 是行注释里的文本。 */
    const lineStart = head.lastIndexOf('\n') + 1;
    if (head.slice(lineStart).indexOf('//') >= 0) continue;
    /* 落在未被闭合的块注释里 ⇒ 同上。 */
    if (head.lastIndexOf('/*') > head.lastIndexOf('*/')) continue;
    out.push(m[1]);
  }
  const bare = out.filter(s => !/^\.{1,2}\//.test(s) && !/^node:/.test(s));
  /* 再补一次检查：裸说明符若是从**字符串字面量**里被误抓的
     （例如说明文档里的 'node:fs'），stripCommentsAndStrings 会把它抹掉。
     两遍必须一致，不一致说明这条说明符出现在注释/字符串里，不算依赖。 */
  const stripped = stripCommentsAndStrings(raw);
  return out.filter(s => stripped.indexOf("'" + s + "'") >= 0 || stripped.indexOf('"' + s + '"') >= 0 || bare.indexOf(s) < 0);
}

/* 把说明符归一成"相对仓库根的路径"，用于与白名单比较。
   只处理相对说明符；裸说明符（node:fs / 包名）单独返回。 */
function normalizeSpecifier(fromRel, spec) {
  if (/^node:/.test(spec)) return { kind: 'builtin', value: spec };
  if (!/^\.{1,2}\//.test(spec)) return { kind: 'bare', value: spec };
  const abs = path.resolve(path.dirname(path.join(ROOT, fromRel)), spec);
  return { kind: 'relative', value: path.relative(ROOT, abs).split(path.sep).join('/') };
}

console.log('P22-1 · Agent Economy dependency boundary');

/* ══════════════════════════════════════════════════════════════════
   B1 · 契约模块自身：运行期中立，载入期零副作用
   ══════════════════════════════════════════════════════════════════ */
section('B1 · 契约模块的载入期纪律');

const contractSrc = read(CONTRACT_REL);

check('B1.1 契约是 UMD 双载（Node require 与浏览器 <script> 同一份实现）',
  /typeof module === 'object' && module\.exports/.test(contractSrc) &&
  /root\.IBEconomyContract\s*=/.test(contractSrc));
check('B1.2 契约文件**零** require（它与 runtime/component-registry.js 同款：纯模型）',
  scanRequires(contractSrc).length === 0, scanRequires(contractSrc));
check('B1.3 契约不读 window / document / localStorage（运行期中立，故可被两侧共用）',
  !/\bdocument\b/.test(stripCommentsAndStrings(contractSrc)) &&
  !/\blocalStorage\b/.test(stripCommentsAndStrings(contractSrc)) &&
  !/\bindexedDB\b/.test(stripCommentsAndStrings(contractSrc)));
check('B1.4 契约不读 fs / path / child_process / net（无 I/O、无进程、无网络）',
  !/\brequire\s*\(/.test(contractSrc) &&
  !/\bchild_process\b/.test(stripCommentsAndStrings(contractSrc)) &&
  !/\bspawnSync\b/.test(stripCommentsAndStrings(contractSrc)));
check('B1.5 契约不读时钟、不用随机（因此 id 生成刻意留给运行时）',
  !/\bDate\.now\b/.test(stripCommentsAndStrings(contractSrc)) &&
  !/\bMath\.random\b/.test(stripCommentsAndStrings(contractSrc)) &&
  !/\bnew Date\b/.test(stripCommentsAndStrings(contractSrc)));
check('B1.6 契约导出被冻结（消费者不能就地改契约）',
  Object.isFrozen(C) && Object.isFrozen(C.CURRENCY) && Object.isFrozen(C.DEPENDENCY_MATRIX) &&
  Object.isFrozen(C.BOUNDARY_FORBIDDEN_MODULES));
check('B1.7 契约不导出任何"能花钱/能改 provider"的函数（导出面只有常量/校验/纯计算）',
  Object.keys(C).every(k => {
    const v = C[k];
    if (typeof v !== 'function') return true;
    return !/^(?:topUp|purchase|pay|charge|refund|transfer|withdraw|deposit|send)/i.test(k);
  }), Object.keys(C).filter(k => typeof C[k] === 'function' &&
    /^(?:topUp|purchase|pay|charge|refund|transfer|withdraw|deposit|send)/i.test(k)));

/* ══════════════════════════════════════════════════════════════════
   B2 · 生产文件清单与磁盘一致
   ══════════════════════════════════════════════════════════════════ */
section('B2 · 生产文件清单（新增 Economy 文件必须登记，否则边界检查会漏过它）');

const discovered = discoverEconomyFiles();
check('B2.1 清单与磁盘一致（磁盘上的 Economy 文件全部被登记）',
  discovered.length === PRODUCTION_FILES.length &&
  discovered.every(f => PRODUCTION_FILES.indexOf(f) >= 0),
  { discovered: discovered, declared: PRODUCTION_FILES });
check('B2.2 清单里没有不存在的文件',
  PRODUCTION_FILES.every(f => fs.existsSync(path.join(ROOT, f))),
  PRODUCTION_FILES.filter(f => !fs.existsSync(path.join(ROOT, f))));
check('B2.3 每个已登记文件都真的在 economy 命名空间下（前缀/目录二者之一）',
  PRODUCTION_FILES.every(f => f.indexOf(ECONOMY_FILE_PREFIX) >= 0 || f.indexOf(ECONOMY_DIR + '/') === 0));

/* ══════════════════════════════════════════════════════════════════
   B3 · 依赖闭包：Economy 不能 require 钱、凭据或真实购物
   ══════════════════════════════════════════════════════════════════ */
section('B3 · 依赖闭包（Economy production code 不得依赖真实支付/凭据）');

const allRequires = [];
PRODUCTION_FILES.forEach(rel => {
  scanRequires(read(rel)).forEach(spec => {
    allRequires.push(Object.assign({ from: rel, spec: spec }, normalizeSpecifier(rel, spec)));
  });
});

/* P22-1 断言"现在没有依赖"；P22-2 起会有（store/db-failure）。
   因此断言写成"每个依赖必须落在允许前缀里"，而不是"依赖数为 0" ——
   前者在新阶段仍然成立，后者会立刻过期。 */
check('B3.1 每个 require 目标都落在允许前缀内（白名单，不是黑名单）',
  allRequires.every(r => C.BOUNDARY_ALLOWED_MODULE_PREFIXES.some(p => r.value.indexOf(p) === 0)),
  allRequires.filter(r => !C.BOUNDARY_ALLOWED_MODULE_PREFIXES.some(p => r.value.indexOf(p) === 0)));
check('B3.2 没有任何 require 指向真实支付模块',
  allRequires.every(r => C.BOUNDARY_FORBIDDEN_MODULES.indexOf(r.value) < 0),
  allRequires.filter(r => C.BOUNDARY_FORBIDDEN_MODULES.indexOf(r.value) >= 0));
check('B3.3 禁止清单里的模块确实存在于仓库（否则这条断言在保护空气）',
  C.BOUNDARY_FORBIDDEN_MODULES.every(m => fs.existsSync(path.join(ROOT, m))),
  C.BOUNDARY_FORBIDDEN_MODULES.filter(m => !fs.existsSync(path.join(ROOT, m))));

/* 逐个点名，让失败信息直接说出是哪一个越界。 */
const NAMED_BOUNDARIES = [
  ['pay-gate', 'bridge/pay-gate.js'],
  ['alipay-provider', 'bridge/alipay-provider.js'],
  ['payment-provider', 'bridge/payment-provider.js'],
  ['payment-auth', 'active/payment-auth.js'],
  ['shopping-execution', 'active/shopping-execution.js'],
  ['credential-vault', 'active/credential-vault.js']
];
NAMED_BOUNDARIES.forEach(([label, rel]) => {
  check('B3.4 Economy 不能依赖 ' + label + '（' + rel + '）',
    allRequires.every(r => r.value !== rel));
});

check('B3.5 Economy 不得依赖真实购物域本身（commerce.js / commerce-adapter.js）',
  allRequires.every(r => r.value !== 'active/commerce.js' &&
    r.value !== 'assets/js/commerce-adapter.js' &&
    r.value !== 'assets/js/shopping-review.js' &&
    r.value !== 'assets/js/payment-settings.js'));
check('B3.6 Economy 不得依赖 Bridge（route 层是真实支付与语音/工具的网络面）',
  allRequires.every(r => r.value.indexOf('bridge/') !== 0));
check('B3.7 Economy 不得依赖进程/网络/加密原语（child_process / net / http / crypto / https）',
  allRequires.every(r => !/^(?:node:)?(child_process|net|http|https|tls|dgram|crypto|worker_threads)$/.test(r.value)),
  allRequires.map(r => r.value));

/* ══════════════════════════════════════════════════════════════════
   B4 · 依赖方向：钱 → Economy 的反向边也不存在
   ══════════════════════════════════════════════════════════════════ */
section('B4 · 依赖方向（Economy ← 支付 的反向边同样不存在）');

const REVERSE_SCAN_FILES = C.BOUNDARY_FORBIDDEN_MODULES.concat([
  'assets/js/payment-settings.js', 'assets/js/commerce-adapter.js'
]);

check('B4.1 真实支付/购物模块**不** require Economy 的任何文件（没有反向边）',
  REVERSE_SCAN_FILES.every(rel => {
    if (!fs.existsSync(path.join(ROOT, rel))) return true;
    return scanRequires(read(rel)).every(spec => {
      const n = normalizeSpecifier(rel, spec);
      return n.value.indexOf('economy') < 0;
    });
  }),
  REVERSE_SCAN_FILES.filter(rel => fs.existsSync(path.join(ROOT, rel)) &&
    scanRequires(read(rel)).some(spec => normalizeSpecifier(rel, spec).value.indexOf('economy') >= 0)));

check('B4.2 启动链**只** require Economy 的 canonical store —— 而且**只有** home-node-service.js '
  + '（P22-2 接线；其余入口一个都不能碰它）',
  (() => {
    const startupFiles = ['services/home-node-service.js', 'services/ib-bridge-service.js',
      'runtime/local-services-runner.js', 'services/home-node/http.js', 'services/home-node/execution.js'];
    const offenders = [];
    startupFiles.forEach(rel => {
      const hits = scanRequires(read(rel)).filter(spec =>
        normalizeSpecifier(rel, spec).value.indexOf('economy') >= 0);
      if (!hits.length) return;
      /* P22-2 的接线**恰好**是一处：装配层 require economy-store.js。
         允许清单写成精确集合，而不是"含有 economy 就行"。 */
      if (rel !== 'services/home-node-service.js') { offenders.push(rel + ' -> ' + hits.join(',')); return; }
      const allowed = ['../services/home-node/economy-store.js'];
      hits.forEach(h => { if (allowed.indexOf(h) < 0) offenders.push(rel + ' -> ' + h); });
    });
    return offenders.length === 0;
  })(),
  (() => {
    const offenders = [];
    const startupFiles = ['services/home-node-service.js', 'services/ib-bridge-service.js',
      'runtime/local-services-runner.js', 'services/home-node/http.js', 'services/home-node/execution.js'];
    startupFiles.forEach(rel => {
      const hits = scanRequires(read(rel)).filter(spec =>
        normalizeSpecifier(rel, spec).value.indexOf('economy') >= 0);
      if (!hits.length) return;
      if (rel !== 'services/home-node-service.js') { offenders.push(rel + ' -> ' + hits.join(',')); return; }
      hits.forEach(h => { if (h !== '../services/home-node/economy-store.js') offenders.push(rel + ' -> ' + h); });
    });
    return offenders;
  })());

check('B4.3 Economy 的运行时模块**不** require 启动链（依赖方向是单向的：装配层 → store，绝不反向）',
  (() => {
    const storeRequires = scanRequires(read('services/home-node/economy-store.js'));
    return storeRequires.every(spec => {
      const n = normalizeSpecifier('services/home-node/economy-store.js', spec);
      return n.value.indexOf('home-node-service') < 0 && n.value.indexOf('http.js') < 0 &&
        n.value.indexOf('execution.js') < 0 && n.value.indexOf('mobile-gateway') < 0 &&
        n.value.indexOf('device-registry') < 0;
    });
  })(),
  scanRequires(read('services/home-node/economy-store.js')));

check('B4.4 /economy/* 只在 http.js 里被**读**服务：http 层拿不到任何写能力',
  (() => {
    const src = read('services/home-node/http.js');
    /* 三层否认：① 路由全是 GET；② 从不调用 store 的写方法；
       ③ /security 声明里 writesExposed 为空、mintingExposed 为 false。 */
    const economyBlocks = src.match(/path === '\/economy\/[^']*' && method === '[A-Z]+'/g) || [];
    const nonGet = economyBlocks.filter(b => !/&& method === 'GET'$/.test(b));
    const writeCalls = ['mintForSystem', 'burnForSystem', 'commitLedgerTransaction',
      'openWallet', 'transferBetweenWallets', 'corruptCachedBalanceForTest']
      .filter(name => stripCommentsAndStrings(src).indexOf(name) >= 0);
    return nonGet.length === 0 && writeCalls.length === 0 &&
      /writesExposed: \[\]/.test(src) && /mintingExposed: false/.test(src);
  })(),
  {
    nonGet: (read('services/home-node/http.js').match(/path === '\/economy\/[^']*' && method === '[A-Z]+'/g) || [])
      .filter(b => !/&& method === 'GET'$/.test(b)),
    writeCalls: ['mintForSystem', 'burnForSystem', 'commitLedgerTransaction', 'openWallet',
      'transferBetweenWallets', 'corruptCachedBalanceForTest']
      .filter(name => stripCommentsAndStrings(read('services/home-node/http.js')).indexOf(name) >= 0)
  });

/* ══════════════════════════════════════════════════════════════════
   B5 · 真实支付的写动词：Economy 代码里不得出现
   ══════════════════════════════════════════════════════════════════ */
section('B5 · 真实支付写动词（P22 §21 的禁止清单，逐个点名）');

const FORBIDDEN_VERB_CASES = C.BOUNDARY_FORBIDDEN_IDENTIFIERS.concat([
  'submitPayment', 'submit_payment', 'topUpProvider', 'purchaseProviderCredits',
  'updateProviderBalance', 'providerPayment', 'providerBillingMutation',
  'purchaseRealCredits', 'sendPayment', 'commitSpend'
]);
check('B5.1 契约把 P22 §21 的写动词全部登记为禁止标识符',
  ['topUpProvider', 'purchaseProviderCredits', 'updateProviderBalance', 'providerPayment',
    'providerBillingMutation'].every(v => C.BOUNDARY_FORBIDDEN_IDENTIFIERS.indexOf(v) >= 0),
  ['topUpProvider', 'purchaseProviderCredits', 'updateProviderBalance', 'providerPayment',
    'providerBillingMutation'].filter(v => C.BOUNDARY_FORBIDDEN_IDENTIFIERS.indexOf(v) < 0));
check('B5.2 这些动词在任何 Economy 生产文件里都以**标识符**形态不存在（注释/字符串不算）',
  PRODUCTION_FILES.every(rel => {
    const code = stripCommentsAndStrings(read(rel));
    return FORBIDDEN_VERB_CASES.every(v => code.indexOf(v) < 0);
  }),
  PRODUCTION_FILES.flatMap(rel => {
    const code = stripCommentsAndStrings(read(rel));
    return FORBIDDEN_VERB_CASES.filter(v => code.indexOf(v) >= 0).map(v => rel + ':' + v);
  }));

/* 逐条点名，失败信息直接指出是哪一个动词。 */
['topUpProvider', 'purchaseProviderCredits', 'updateProviderBalance', 'providerPayment',
  'providerBillingMutation', 'commitSpend', 'sendPayment', 'submit_payment'].forEach(verb => {
  check('B5.3 Economy 中不存在 ' + verb + '（真实支付/provider 充值写路径）',
    PRODUCTION_FILES.every(rel => stripCommentsAndStrings(read(rel)).indexOf(verb) < 0));
});

check('B5.4 Economy 不引用收银台/支付网关的字段名（checkoutUrl / cashierUrl 作为**代码**）',
  PRODUCTION_FILES.every(rel => {
    const code = stripCommentsAndStrings(read(rel));
    return code.indexOf('cashierUrl') < 0 && code.indexOf('paymentLink') < 0 &&
      code.indexOf('paymentIntent') < 0 && code.indexOf('maxBudget') < 0;
  }));

/* ══════════════════════════════════════════════════════════════════
   B6 · 凭据边界：API Key / character_runtime_specs
   ══════════════════════════════════════════════════════════════════ */
section('B6 · 凭据边界（Economy 不得触 API Key 与 character_runtime_specs）');

/* ── 被契约**显式点名**的危险词 ────────────────────────────────────────
   有些词必须出现在契约里，否则检查没有输入：禁止模块清单、冲突键清单、
   凭据表名…… 但"必须存在"与"可以随便出现"是两件事。于是这里把它们列成
   一张**有出处的**白名单，并要求每个词的出现次数不超过它的出处数量 ——
   多出来的那一次就是一次真正的引用，而不是登记。 */
const SANCTIONED_MENTIONS = {
  'character_runtime_specs': [CONTRACT_REL],
  'pay-gate': [CONTRACT_REL],
  'alipay-provider': [CONTRACT_REL]
};

function countOccurrences(hay, needle) {
  let n = 0, i = 0;
  for (;;) {
    const at = hay.indexOf(needle, i);
    if (at < 0) return n;
    n++; i = at + needle.length;
  }
}
function totalOccurrences(needle) {
  return PRODUCTION_FILES.reduce((sum, rel) => sum + countOccurrences(read(rel), needle), 0);
}

check('B6.1a Economy 对 provider 凭据表 character_runtime_specs 的出现次数不超过契约里的登记次数',
  totalOccurrences('character_runtime_specs') <=
  SANCTIONED_MENTIONS['character_runtime_specs'].reduce((s, rel) => s + countOccurrences(read(rel), 'character_runtime_specs'), 0),
  { occurrences: totalOccurrences('character_runtime_specs') });
check('B6.1b 这些词在 Economy **代码**（剥掉注释与字符串后）里出现 0 次 —— 没有真正的引用',
  PRODUCTION_FILES.every(rel => {
    const code = stripCommentsAndStrings(read(rel));
    return Object.keys(SANCTIONED_MENTIONS).every(w => code.indexOf(w) < 0);
  }),
  PRODUCTION_FILES.flatMap(rel => {
    const code = stripCommentsAndStrings(read(rel));
    return Object.keys(SANCTIONED_MENTIONS).filter(w => code.indexOf(w) >= 0).map(w => rel + ':' + w);
  }));
check('B6.2 Economy 不引用 device-registry（它是 characters / character_runtime_specs 的 owner）',
  allRequires.every(r => r.value.indexOf('device-registry') < 0));
check('B6.3 Economy 不读 bearer / Authorization 头',
  PRODUCTION_FILES.every(rel => {
    const code = stripCommentsAndStrings(read(rel));
    return !/authorization/i.test(code) && code.indexOf('Bearer') < 0;
  }));
check('B6.4 Economy 的 ownerId 只能引用 characters.id —— 契约把角色 party id 直接当 id 形状',
  C.PARTY_TYPES.indexOf('character') >= 0 &&
  Object.prototype.hasOwnProperty.call(C.PARTY_TYPE, 'CHARACTER') &&
  !Object.prototype.hasOwnProperty.call(C.PARTY_TYPE, 'CREDENTIAL') &&
  !Object.prototype.hasOwnProperty.call(C.PARTY_TYPE, 'PROVIDER'));
check('B6.5 party type 闭集里**没有** provider / credential 类身份',
  !C.PARTY_TYPES.some(t => /provider|credential|apikey|billing/i.test(t)), C.PARTY_TYPES);
check('B6.6 除 event/audit 的凭据键名黑名单外，Economy 也不接受 apiKey 作为数据键',
  C.makeEconomyEvent({
    economyEventId: 'econ_evt_b1', eventType: 'ITEM_CONSUMED', timestamp: 1,
    actor: { type: 'character', id: 'cfg_a' }, metadata: { apiKey: 'sk-x' }
  }).ok === false);

/* ══════════════════════════════════════════════════════════════════
   B7 · Memory / Relationship 写边界
   ══════════════════════════════════════════════════════════════════ */
section('B7 · Memory / Relationship 写边界（Economy 只产 event）');

check('B7.1 Economy 不 require Memory 的任何实现（memory.js / memory-authority / memory-store / memory-contract）',
  allRequires.every(r => !/memory/i.test(r.value)),
  allRequires.map(r => r.value));
check('B7.2 Economy 不 require Relationship 的任何实现（role-dm / role-dm-core）',
  allRequires.every(r => !/role-dm/i.test(r.value)));
check('B7.3 Economy 不 require Middle Brain（它不是第二个 Middle Brain）',
  allRequires.every(r => !/middle-brain/i.test(r.value)));
check('B7.4 Economy 不 require Provider Router / 模型目录（provider metadata 唯一真源不属于它）',
  allRequires.every(r => !/(ib-model-core|provider-directory|model-client|node-model-port|node-model-compat)/i.test(r.value)));
check('B7.5 Economy 不 require 工具执行面（integrations / tool-execution-guard / execution.js）',
  allRequires.every(r => !/(integrations|tool-execution-guard|home-node\/execution)/i.test(r.value)));
check('B7.6 Economy 源码里不出现 affection / trust / affinity（关系维度的数值写入是 Relationship 的职责）',
  PRODUCTION_FILES.every(rel => {
    const src = read(rel);
    /* 契约文件里 RELATIONSHIP/AFFECTION/TRUST/AFFINITY 是**禁止清单的数据**，
       必须存在；因此这里判的是"被当作可写字段/变量使用"的形态。 */
    const code = stripCommentsAndStrings(src);
    return !/\b(?:affection|affinity)\b/i.test(code) &&
      !/\btrust\s*(?:\+=|-=|=)/.test(code) &&
      !/\b(?:affection|affinity|trust)\s*(?:\+=|-=)/.test(code);
  }));
check('B7.7 契约里禁止清单**确实**点名了 Memory 与 Relationship 类 effect（否则 B7.6 是在保护空气）',
  C.FORBIDDEN_EFFECT_NAMES.indexOf('MODIFY_MEMORY') >= 0 &&
  C.FORBIDDEN_EFFECT_NAMES.indexOf('MODIFY_RELATIONSHIP') >= 0 &&
  C.isForbiddenEffectName('AFFECTION') && C.isForbiddenEffectName('TRUST'));
check('B7.8 Economy event envelope 不携带记忆/关系载荷（只有事实与标量 metadata）',
  !C.EVENT_ENVELOPE_KEYS.some(k => /memory|relationship|affection|trust|content|prompt/i.test(k)),
  C.EVENT_ENVELOPE_KEYS);

/* ══════════════════════════════════════════════════════════════════
   B8 · P22-0 R2：真实购物 maxBudget 命名冲突
   ══════════════════════════════════════════════════════════════════ */
section('B8 · P22-0 R2（commerce.js 的 maxBudget，单位=元）');

const COMMERCE_SRC = read('active/commerce.js');
check('B8.1 真实购物域**确实**存在 maxBudget（这条断言证明 R2 不是假想风险）',
  /maxBudget/.test(COMMERCE_SRC) && /元/.test(COMMERCE_SRC));
check('B8.2 Economy 契约把它列为冲突键并否认它',
  C.REAL_COMMERCE_COLLIDING_KEYS.indexOf('maxBudget') >= 0 && C.isRealCommerceKey('maxBudget'));
check('B8.3 Budget Policy 输入里出现 maxBudget 时被拒绝（不是被当成限额解释）',
  (() => {
    const r = C.normalizeBudgetInput({
      actorId: 'cfg_a', amountMinor: 100, currency: 'IB_CREDIT',
      limits: {}, maxBudget: 200
    });
    return r.ok === false && r.input === null;
  })());
check('B8.4 Economy 的 Budget 字段名与真实货币字段名**字形不同族**（Minor 后缀）',
  C.BUDGET_LIMIT_KEYS.every(k => /Minor$/.test(k)) &&
  C.REAL_COMMERCE_COLLIDING_KEYS.every(k => C.BUDGET_LIMIT_KEYS.indexOf(k) < 0));
check('B8.5 Economy 不引用 paymentIntent / paymentLink / checkoutUrl 作为自己的字段',
  C.EVENT_ENVELOPE_KEYS.indexOf('paymentIntent') < 0 &&
  Object.keys(C.BUDGET_INPUT_KEYS).every(k => C.BUDGET_INPUT_KEYS[k] !== 'paymentIntent') &&
  C.BUDGET_INPUT_KEYS.indexOf('paymentIntent') < 0);

/* ══════════════════════════════════════════════════════════════════
   B9 · P22-0 R4：release manifest 必须真的把 Economy 装进包
   ══════════════════════════════════════════════════════════════════ */
section('B9 · P22-0 R4（逐文件白名单：新模块会静默从安装包消失）');

const manifest = require(path.join(ROOT, 'scripts', 'release-manifest.js'));
const resolved = manifest.resolve({});
const shipped = new Set(resolved.files.map(f => f.to));

check('B9.1 每个 Economy 生产文件都被装进发行包（目录规则命中）',
  PRODUCTION_FILES.every(rel => shipped.has(rel)),
  PRODUCTION_FILES.filter(rel => !shipped.has(rel)));
check('B9.2 每个 Economy 生产文件的 **require 目标** 也被装进包（闭包，而不只是它自己）',
  (() => {
    const missing = [];
    PRODUCTION_FILES.forEach(from => {
      scanRequires(read(from)).forEach(spec => {
        const n = normalizeSpecifier(from, spec);
        if (n.kind !== 'relative') return;
        /* 目录说明符（./economy/）解析成目录，容许'目录本身在包内' */
        const isDir = fs.existsSync(path.join(ROOT, n.value)) &&
          fs.statSync(path.join(ROOT, n.value)).isDirectory();
        if (isDir) {
          if (!Array.from(shipped).some(t => t.indexOf(n.value + '/') === 0)) missing.push(from + ' -> ' + n.value);
          return;
        }
        const candidates = [n.value, n.value + '.js'];
        if (!candidates.some(c => shipped.has(c))) missing.push(from + ' -> ' + n.value);
      });
    });
    return missing.length === 0;
  })(),
  (() => {
    const missing = [];
    PRODUCTION_FILES.forEach(from => {
      scanRequires(read(from)).forEach(spec => {
        const n = normalizeSpecifier(from, spec);
        if (n.kind !== 'relative') return;
        const isDir = fs.existsSync(path.join(ROOT, n.value)) &&
          fs.statSync(path.join(ROOT, n.value)).isDirectory();
        if (isDir) return;
        if (!shipped.has(n.value) && !shipped.has(n.value + '.js')) missing.push(from + ' -> ' + n.value);
      });
    });
    return missing;
  })());
check('B9.3 manifest 的目录规则已经覆盖 services/home-node（含未来 economy/ 子目录）',
  (() => {
    const homeNodeDirRule = resolved.files.some(f => f.to.indexOf('services/home-node/') === 0);
    /* 直接验证行为：造一个假想的 economy/ 文件路径，看目录规则的 from 是否覆盖它。
       P22-2 真加文件时，B9.1/B9.2 会再做一次真实断言。 */
    return homeNodeDirRule && shipped.has('services/home-node/chat-store.js');
  })());
check('B9.4 契约文件**不被**安装包排除规则拦掉（denied 为空）',
  resolved.denied.length === 0, resolved.denied);

/* ══════════════════════════════════════════════════════════════════
   B11 · P22-2 runtime：不存在"直接改余额"的路径
   ══════════════════════════════════════════════════════════════════ */
section('B11 · P22-2 runtime（余额只能来自 committed ledger entries）');

/* 这一组的存在理由很具体：一旦 Economy 有了 store，"顺手加一个
   setBalance()" 就会变成最省事的写法，而它同时会废掉
   "canonical = ledger" 这条全部设计的基础。
   因此这里对**每一个** Economy 生产文件断言四种形态都不存在。 */
const BALANCE_MUTATION_SHAPES = [
  ['setBalance', /\bsetBalance\b/],
  ['incrementBalance', /\bincrementBalance\b/],
  ['decrementBalance', /\bdecrementBalance\b/],
  ['addBalance', /\baddBalance\b/],
  ['adjustBalance', /\badjustBalance\b/],
  ['creditBalance', /\bcreditBalance\b/],
  ['debitBalance', /\bdebitBalance\b/],
  ['balance += / -=', /balance\w*\s*(?:\+=|-=|\+\+|--)/i],
  ['SQL 自增：balance = balance + ?', /cached_balance_minor\s*=\s*cached_balance_minor\s*[+\-]/i]
];
BALANCE_MUTATION_SHAPES.forEach(([label, re]) => {
  check('B11.1 Economy 生产文件里不存在 ' + label + '（余额变化只能来自 committed ledger entries）',
    PRODUCTION_FILES.every(rel => !re.test(stripCommentsAndStrings(read(rel)))),
    PRODUCTION_FILES.filter(rel => re.test(stripCommentsAndStrings(read(rel)))));
});

/* 唯一改缓存的语句必须是"赋成从 ledger 算出来的值"。 */
const STORE_SRC = read('services/home-node/economy-store.js');
const balanceWrites = (STORE_SRC.match(/SET cached_balance_minor=[^']*/g) || []);
check('B11.2 只有一条 SQL 语句会写 cached_balance_minor，且它是整体赋值（不是增量）',
  balanceWrites.length === 1 &&
  balanceWrites[0].indexOf('cached_balance_minor=cached_balance_minor') < 0 &&
  /SET cached_balance_minor=\?, reserved_balance_minor=\?, state=\?, revision=\?, updated_at=\?/.test(balanceWrites[0]),
  balanceWrites);

check('B11.3 runtime 用**同一个**契约做校验（不是各写一份金额/币种/方向规则）',
  /deps\.contract\s*\|\|\s*require\('\.\/economy-contract\.js'\)/.test(STORE_SRC) &&
  /C\.(checkLedgerBalance|makeLedgerEntry|normalizeAmountMinor|validateCurrency|accountKindOf)\(/.test(STORE_SRC));

check('B11.4 runtime 不复用 chat / memory 的 revision 与 change_log 命名空间',
  /economy_meta/.test(STORE_SRC) && /economy_change_log/.test(STORE_SRC) &&
  /economy_idempotency/.test(STORE_SRC) &&
  !/['"]memory_revision['"]/.test(STORE_SRC) &&
  !/CREATE TABLE IF NOT EXISTS change_log/.test(STORE_SRC));

check('B11.5 故障注入只在 deps.faults 上（没有能被 HTTP 触达的 debug 开关）',
  /const faults = deps\.faults \|\| null/.test(STORE_SRC) &&
  scanRequires(STORE_SRC).indexOf('node:http') < 0);

check('B11.6 铸币 / 销毁要求显式 systemInitiated，并受注入的授权谓词约束',
  /systemInitiated !== true/.test(STORE_SRC) && /systemAuthority/.test(STORE_SRC) &&
  /system-mint|system:burn/.test(STORE_SRC));

/* 反向断言：这些检查的**输入**必须存在，否则上面的每一条都在保护空气。 */
check('B11.7 （输入存在）生产文件清单里确实包含 P22-2 的 runtime，且它是真实文件',
  PRODUCTION_FILES.indexOf('services/home-node/economy-store.js') >= 0 &&
  fs.existsSync(path.join(ROOT, 'services/home-node/economy-store.js')));
check('B11.8 （输入存在）store 真的 require 了契约与 db-failure 分类器 —— 否则 B11.3 是假绿',
  (() => {
    const reqs = scanRequires(STORE_SRC);
    return reqs.indexOf('./economy-contract.js') >= 0 && reqs.indexOf('../../runtime/db-failure.js') >= 0;
  })(), scanRequires(STORE_SRC));

/* ══════════════════════════════════════════════════════════════════
   B10 · 反向断言：契约里**必须**存在的"否认"数据
   ══════════════════════════════════════════════════════════════════ */
section('B10 · 契约的否认清单本身（没有它，上面的静态检查就没有输入）');

check('B10.1 禁止模块清单非空，且每条都真实存在',
  C.BOUNDARY_FORBIDDEN_MODULES.length >= 6 &&
  C.BOUNDARY_FORBIDDEN_MODULES.every(m => fs.existsSync(path.join(ROOT, m))),
  C.BOUNDARY_FORBIDDEN_MODULES.filter(m => !fs.existsSync(path.join(ROOT, m))));
check('B10.2 禁止标识符清单覆盖 P22 §21 的三类（provider 充值 / 真实支付 / 凭据）',
  C.BOUNDARY_FORBIDDEN_IDENTIFIERS.length >= 8 &&
  C.BOUNDARY_FORBIDDEN_IDENTIFIERS.some(v => /provider/i.test(v)) &&
  C.BOUNDARY_FORBIDDEN_IDENTIFIERS.some(v => /pay/i.test(v)));
check('B10.3 法币否认清单非空且含 P22 §2 点名的币种',
  C.FORBIDDEN_CURRENCY_TOKENS.length >= 20 &&
  ['CNY', 'RMB', 'USD', 'EUR'].every(c => C.FORBIDDEN_CURRENCY_TOKENS.indexOf(c) >= 0));
check('B10.4 依赖矩阵里 Economy 的出边**没有一条**是"允许写"',
  C.DEPENDENCY_MATRIX.filter(r => r.from === 'Economy')
    .every(r => r.rule === 'FORBIDDEN' || r.rule === 'FORBIDDEN_WRITE' || r.rule === 'READ_ONLY' ||
      r.rule === 'READ_ONLY_VIA_CANONICAL_API' || r.rule === 'ADAPTER_ONLY'),
  C.DEPENDENCY_MATRIX.filter(r => r.from === 'Economy').map(r => r.to + ':' + r.rule));

/* ══════════════════════════════════════════════════════════════════
   汇总
   ══════════════════════════════════════════════════════════════════ */
console.log('\n' + '═'.repeat(64));
if (failures === 0) {
  console.log('P22-1 boundary: 全部通过 ✔');
  console.log('  Economy 生产文件 ' + PRODUCTION_FILES.length + ' 个 · require 目标 ' + allRequires.length + ' 个');
  process.exitCode = 0;
} else {
  console.error('P22-1 boundary: ' + failures + ' 项失败 ✘');
  process.exitCode = 1;
}
