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
   因为"多一个 manager/service/repository"正是 P22 §1 明确不要的东西。

   P22-9 加入 economy-capability.js（运行时准入门）。
   ★ 它是**第三**个文件，而这不是"又一个 manager"。理由只有一条：
     门必须长在 P22-8 的**上面**。把它写进 store 会让
     proposeAgentPurchaseIntent 自己变成准入判定的一环（P22-8 的
     canonical ownership 就变了），而那时"consumer 是否先过门"这个问题
     会退化成"你有没有记得在 propose 里调那个检查"。
     相反，把权限表写进契约、把执行写进第三个文件之后，**"没有旁路"
     变成了一次可以在整个仓库上做的断言**（见下面的 B18）。
   它没有引入任何新依赖：它 require 的仍是那份契约。 */
const PRODUCTION_FILES = [
  'services/home-node/economy-contract.js',
  'services/home-node/economy-store.js',
  'services/home-node/economy-capability.js',
  /* P22-10 加入 economy-action-adapter.js（Agent/Action → 门的唯一界面）。
     ★ 它是**第四**个文件，理由与 P22-9 逐字同构：适配器必须长在门的
     **上面**。把它写进门里会让"门是否被正确调用"变成门内部的一件事，
     而把它写进 store 就是又一次改写 P22-8 的 canonical ownership。
     它同样没有引入任何新依赖：它 require 的仍是那份契约。 */
  'services/home-node/economy-action-adapter.js',
  /* P22-11 加入 economy-command-channel.js（Active → Home Node 的**唯一**
     command 面）。★ 它是**第五**个文件，理由与第四个逐字同构：通道必须
     长在适配器**上面**，把 handler 写进 http.js 会让"这条路径能做什么"
     散落在路由层里，而写进适配器就是把传输混进动作层。
     它同样没有引入第二份经济依赖：它 require 的仍是那份契约（另加两个
     **核心**模块 node:crypto / node:http，见下面的 B3.1 —— 通道要摘要、
     恒定时间比较与一条出站 HTTP，而这三件事只能来自核心模块）。 */
  'services/home-node/economy-command-channel.js',
  /* P22-13 加入 economy-approval-decision.js（用户对一条等待中的 Agent Intent
     点头 / 摇头的**唯一**生产入口）。★ 它是**第六**个文件，理由与第五个
     逐字同构：这条 seam 必须长在通道**旁边**（它们是两条路径、两个身份），
     而把 handler 写进 http.js 会让"谁在决定"散落在路由层里。
     它的依赖仍然是那份契约（另加 node:crypto —— 与通道同一个理由：
     桌面凭据的恒定时间比较需要摘要）。 */
  'services/home-node/economy-approval-decision.js',
  /* P22-14 加入 economy-configuration.js（fresh install 在**不改代码、不直接
     操作 SQLite** 的前提下完成初始配置 —— 初始 IB Credit / Budget Policy /
     Autonomy Policy —— 的**唯一**生产入口）。★ 它是**第七**个文件，理由与
     第六个刻意**不同**：那一条是"用户对一条具体的 intent 点头/摇头"，这一条
     是"用户**预设**这台节点的钱与规则"。两者都是用户操作，但它们是两种权威；
     合成一条万能 user command endpoint 会让"允许 Agent 自主花多少钱"与
     "批准这一笔"在审计里变成同一件事。
     ★ 它的依赖仍然是那份契约（另加 node:crypto —— 与通道、决定面同一个理由）。
     ★ 它**不** require store，也**不** require 门：装配层交给它的是一份恰好
     三个键的 store 视图（见 services/home-node-service.js 的 economyAssembly），
     因此"配置面顺手做一笔别的经济动作"在依赖上就不成立。 */
  'services/home-node/economy-configuration.js'
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
    /* ★ P22-8 的注记：`purchaseIntentFingerprint` 撞上了 `purchase` 这个
       前缀，而它是一个**纯函数**（给定同一份意图永远返回同一个指纹，不
       接受 db、不接受金额、不返回任何可花的许可）。把它挡掉会让这条断言
       用"名字"去判别能力 —— 而它要判的是**能力**。
       因此这里把判据说准：被挡的是"看起来在动钱"的动词（`purchase*`
       而**不是** `purchaseIntent*`，因为后者是一个名词短语）。
       逐字列在下面，而不是靠一个更宽的前缀规则 —— 一份显式的例外名单
       比一条宽松的正则更容易被下一个人读准。 */
    if (k === 'purchaseIntentFingerprint') return true;
    return !/^(?:topUp|purchase|pay|charge|refund|transfer|withdraw|deposit|send)/i.test(k);
  }), Object.keys(C).filter(k => typeof C[k] === 'function' &&
    k !== 'purchaseIntentFingerprint' &&
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
check('B3.7 Economy 不得依赖**进程 / 网络服务器 / 其它加密原语**（child_process / net / https / tls / dgram / worker_threads）',
  /* ★ P22-11 让这条从"一个字都不能有"变成"逐项点名"：command 通道需要
     node:crypto（SHA-256 摘要 + 恒定时间比较）与 node:http（一条**出站**
     调用）。因此这里把禁令落在真正重要的那几件事上：
       · 不起进程：child_process / worker_threads；
       · 不自己开网络：net / dgram / tls；
       · 更不开第二个 HTTP **服务器** —— Economy 的 handler 走的是
         services/home-node/http.js 已经存在的那个 server（下面 B3.7b
         逐字断言 Economy 里没有 createServer/.listen(）。 */
  allRequires.every(r => !/^(?:node:)?(child_process|net|https|tls|dgram|worker_threads)$/.test(r.value)) &&
  /* 被允许的核心模块必须**恰好**：node:crypto 三处（通道的摘要/恒定时间
     比较，P22-13 那条 seam 对桌面凭据的同一个比较，以及 P22-14 配置面对
     同一个凭据的同一个比较）、
     node:http **一处**（通道那一条出站调用）。
     ★ 每一次都是**加法**，不是放松：多出来的那一处只在它自己的文件里，
     而下面 B3.7c / B3.7d 逐字断言那两条 seam **没有** http / net / listen /
     定时器。 */
  allRequires.filter(r => r.value === 'node:crypto').length === 3 &&
  allRequires.filter(r => r.value === 'node:http').length === 1,
  allRequires.map(r => r.value));

check('B3.7d ★ P22-14 那条配置 seam **不碰网络、不开服务器、不起定时器**：'
  + '它是一条同进程的三命令配置面，凭据比较用的还是那把摘要',
  (() => {
    const rel14 = 'services/home-node/economy-configuration.js';
    const code = stripCommentsAndStrings(read(rel14));
    const requires = scanRequires(read(rel14));
    return requires.every(spec => !/^(?:node:)?(child_process|net|http|https|tls|dgram|worker_threads|fs|worker_threads)$/.test(spec)) &&
      requires.filter(spec => spec === 'node:crypto').length === 1 &&
      !/\bsetTimeout\b|\bsetInterval\b/.test(code) &&
      !/\bnew Date\b|\bDate\.now\b/.test(code) &&
      code.indexOf('createServer') < 0 && code.indexOf('.listen(') < 0 &&
      code.indexOf('fetch(') < 0;
  })(),
  { requires: scanRequires(read('services/home-node/economy-configuration.js')) });

check('B3.7c ★ P22-13 那条 seam **不碰网络、不开服务器、不起定时器**：'
  + '它是一次同进程的两步调用（决定 + 续做），凭据比较用的还是那把摘要',
  (() => {
    const rel13 = 'services/home-node/economy-approval-decision.js';
    const code = stripCommentsAndStrings(read(rel13));
    const specs = scanRequires(read(rel13));
    return code.indexOf('createServer') < 0 &&
      code.indexOf('.listen(') < 0 &&
      code.indexOf('request(') < 0 &&
      code.indexOf('timingSafeEqual') >= 0 &&
      !/\bsetTimeout\b|\bsetInterval\b/.test(code) &&
      specs.length === 2 &&
      specs.indexOf('node:crypto') >= 0 &&
      specs.indexOf('./economy-contract.js') >= 0;
  })(),
  { requires: scanRequires(read('services/home-node/economy-approval-decision.js')) });

check('B3.7b （输入存在）Economy 生产代码里**没有**第二个 HTTP 服务器，也没有任何 .listen( —— 通道只做一条出站调用',
  (() => {
    const code = stripCommentsAndStrings(read('services/home-node/economy-command-channel.js'));
    return code.indexOf('createServer') < 0 &&
      code.indexOf('.listen(') < 0 &&
      code.indexOf('nodeHttp.request(') >= 0 &&
      code.indexOf('timingSafeEqual') >= 0;
  })(),
  {
    createServer: stripCommentsAndStrings(read('services/home-node/economy-command-channel.js')).indexOf('createServer'),
    listen: stripCommentsAndStrings(read('services/home-node/economy-command-channel.js')).indexOf('.listen(')
  });

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
      /* P22-2 的接线**恰好**是一处：装配层 require economy-store.js。
         P22-9 加第二处：装配层 require 准入门（门在上层，装配是它唯一的
         构造点）。
         P22-10 加第三处：装配层 require Action Adapter（适配器同样长在
         门的上面，而它是全仓库唯一一次 gate.bind(consumer) 的所在地）。
         P22-11 加第四处：装配层 require command 通道（通道长在适配器上面，
         装配是它唯一的构造点与唯一的来源登记处）。
         允许清单写成精确集合，而不是"含有 economy 就行"。 */
      const allowed = ['../services/home-node/economy-store.js',
        '../services/home-node/economy-capability.js',
        '../services/home-node/economy-action-adapter.js',
        '../services/home-node/economy-command-channel.js',
        /* P22-13 加第五处：装配层 require Approval Decision Seam（同样是
           "构造就是身份绑定"的那个理由 —— 见 economyAssembly 里的说明）。 */
        '../services/home-node/economy-approval-decision.js',
        /* P22-14 加第六处：装配层 require Configuration Seam（fresh install
           的配置入口）。★ 它为什么必须在**装配层**被构造，而不是被 http.js
           自己 require：因为它的 store 视图恰好三个键 —— 那份"这台节点上
           配置面能碰哪三件事"的**唯一**装配事实只能在装配层成形。 */
        '../services/home-node/economy-configuration.js'];
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
      hits.forEach(h => {
        if (h !== '../services/home-node/economy-store.js' &&
          h !== '../services/home-node/economy-capability.js' &&
          h !== '../services/home-node/economy-action-adapter.js' &&
          h !== '../services/home-node/economy-command-channel.js' &&
          h !== '../services/home-node/economy-approval-decision.js' &&
          h !== '../services/home-node/economy-configuration.js') offenders.push(rel + ' -> ' + h);
      });
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
    /* P22-3 把这份"不许被 http 层调用"的名单扩到它自己的六个 mutation
       方法上。名单必须跟着能力长：只列 P22-2 的那几个，等于给新加的
       写能力留了一扇没有锁的门。
       P22-4 再扩到它的六个（政策与报价），理由逐字相同。
       P22-5 再扩到它的五个（货架 / 商品 / 库存原语 / product-backed 报价）——
       注意 createProductQuote 也在名单里：它是**唯一** canonical 的报价
       生成路径，而"谁能要求系统为哪个 buyer 生成报价"仍然属于未来的
       权限层（P22-5 §33），因此它更不能出现在 HTTP 上。 */
    const writeCalls = ['mintForSystem', 'burnForSystem', 'commitLedgerTransaction',
      'openWallet', 'transferBetweenWallets', 'corruptCachedBalanceForTest',
      'reserveFunds', 'commitReservation', 'releaseReservation', 'expireReservation',
      'failReservation', 'expireDueReservations', 'rebuildReservedBalance',
      'reconcileReservations', 'corruptReservedCacheForTest',
      'putBudgetPolicy', 'expirePolicy', 'expireDuePolicies',
      'createQuote', 'expireQuote', 'expireDueQuotes',
      'putStore', 'putProduct', 'grantInventory', 'consumeInventory', 'createProductQuote']
      .filter(name => stripCommentsAndStrings(src).indexOf(name) >= 0);
    return nonGet.length === 0 && writeCalls.length === 0 &&
      /writesExposed: \[\]/.test(src) && /mintingExposed: false/.test(src);
  })(),
  {
    nonGet: (read('services/home-node/http.js').match(/path === '\/economy\/[^']*' && method === '[A-Z]+'/g) || [])
      .filter(b => !/&& method === 'GET'$/.test(b)),
    writeCalls: ['mintForSystem', 'burnForSystem', 'commitLedgerTransaction', 'openWallet',
      'transferBetweenWallets', 'corruptCachedBalanceForTest',
      'reserveFunds', 'commitReservation', 'releaseReservation', 'expireReservation',
      'failReservation', 'expireDueReservations', 'rebuildReservedBalance',
      'reconcileReservations', 'corruptReservedCacheForTest',
      'putBudgetPolicy', 'expirePolicy', 'expireDuePolicies',
      'createQuote', 'expireQuote', 'expireDueQuotes',
      'putStore', 'putProduct', 'grantInventory', 'consumeInventory', 'createProductQuote']
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
/* B6.3 的"反例存在"证明：这些正是它要挡的读法，而 http.js 逐字使用其中
   至少一种 —— 于是那条断言不是一句空话（它真的能命中）。 */
const PRIVATE_HEADER_PROOF = [
  /req\.headers\s*\.\s*authorization/i,
  /req\.headers\s*\[\s*['"]authorization['"]\s*\]/i,
  /\bBearer\s/
];
check('B6.3 Economy 不读 bearer / Authorization 头', (() => {
  /* ★ 这一条断言的是**读凭据头**这件事，而不是那个词本身。
     P22-7 之前这里写的是 `!/authorization/i.test(code)`，而那时它是等价的：
     Economy 里没有任何别的东西叫 authorization。P22-7 引入了
     `authorization` 这一层（购买行上的授权模式、读面的 authorizationSummary），
     于是"出现这个词"与"读一个凭据头"不再是一回事 —— 继续用词禁会让
     一条真正的安全断言变成对**命名**的禁令，而那会逼出为了绕过断言而
     起的名字（那是断言失效最常见的方式）。
     因此这里逐条点名**真正的**读法：请求头对象上的 authorization / bearer、
     以及任何 `Bearer ` 方案前缀。Economy 一个都不许有。 */
  const headerReads = [
    /req\.headers\s*\.\s*authorization/i,
    /req\.headers\s*\[\s*['"]authorization['"]\s*\]/i,
    /headers\s*\.\s*authorization/i,
    /\bBearer\s/,
    /(?:get|read)Header\s*\(\s*['"]authorization['"]/i
  ];
  const offenders = PRODUCTION_FILES.filter(rel => {
    const code = stripCommentsAndStrings(read(rel));
    return headerReads.some(re => re.test(code));
  });
  /* 而"这些文件里确实存在一个请求头对象"这一面由 http.js 满足（它读
     Authorization 是**它的**职责）—— 因此这一条不是空洞的：
     它的反例是被点名的那几种写法。 */
  const httpCode = stripCommentsAndStrings(read('services/home-node/http.js'));
  return offenders.length === 0 &&
    PRIVATE_HEADER_PROOF.some(re => re.test(httpCode));
})());
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
   B12 · P22-3 runtime：reservation 面不存在"直接改锁定量"或"经 HTTP 写"
   ══════════════════════════════════════════════════════════════════ */

/* 这一组存在的理由和 B11 一模一样，只是对象换成了 reserved：
   P22-3 给了 Economy 六个会改状态的方法（reserve / commit / release /
   expire / fail / sweep），于是"顺手加一个 setReservedBalance()"
   或者"顺手把 reserve 挂到一条 POST 上"都会变成最省事的写法，
   而它们各自会废掉一条本阶段最重要的性质：
     · 直接改 reserved ⇒ "锁定量只能来自 active reservations" 失效；
     · HTTP 可写 ⇒ 任何一个能发请求的人都能替 Agent 决定花钱。
   因此这里对**每一个** Economy 生产文件断言这些形态都不存在。

   ── P22-3 **没有**新增生产文件 ──────────────────────────────────────
   reservation 活在 economy-store.js 里（同一个事务、同一个 db 句柄、
   同一套 withTransaction）。这不是为了省一个文件：把 Reservation 拆成
   独立模块就必须把 db / withTransaction / allocateRevision / appendChange
   / computeLedgerBalance / commitLedgerTransactionInTx 这些私有件暴露出去，
   而那会把 P22 §10 要求的"ledger 与 reservation 同一个 atomic boundary"
   从结构保证降级成跨模块约定。B2.1 会继续断言清单与磁盘一致。 */
section('B12 · P22-3 runtime（reserved 只能来自 active reservations；写能力不上 HTTP）');

const RESERVED_MUTATION_SHAPES = [
  ['setReservedBalance', /\bsetReservedBalance\b/],
  ['updateReservedBalance', /\bupdateReservedBalance\b/],
  ['incrementReserved', /\bincrementReserved\w*/],
  ['decrementReserved', /\bdecrementReserved\w*/],
  ['addReserved', /\baddReserved\w*/],
  ['reserved += / -=', /reserved\w*\s*(?:\+=|-=|\+\+|--)/i],
  ['SQL 自增：reserved_balance_minor = reserved_balance_minor + ?', /reserved_balance_minor\s*=\s*reserved_balance_minor\s*[+\-]/i]
];
RESERVED_MUTATION_SHAPES.forEach(([label, re]) => {
  check('B12.1 Economy 生产文件里不存在 ' + label + '（锁定量只能来自 active reservations 的求和）',
    PRODUCTION_FILES.every(rel => !re.test(stripCommentsAndStrings(read(rel)))),
    PRODUCTION_FILES.filter(rel => re.test(stripCommentsAndStrings(read(rel)))));
});

check('B12.2 唯一写 reserved_balance_minor 的语句是整体赋值（不是增量），且求和入口存在',
  /SET reserved_balance_minor=\?, revision=\?, updated_at=\? WHERE wallet_id=\?/.test(STORE_SRC) &&
  /SET reserved_balance_minor=reserved_balance_minor/.test(STORE_SRC) === false &&
  /sumActiveReserved/.test(STORE_SRC) &&
  /status=\\'ACTIVE\\'/.test(STORE_SRC),
  {
    assignments: (STORE_SRC.match(/SET reserved_balance_minor=[^']*/g) || []),
    hasActiveSum: /sumActiveReserved/.test(STORE_SRC)
  });

/* ── 写能力不上 HTTP：这是本阶段最需要被机器守住的一条 ─────────────── */
const RESERVATION_MUTATION_METHODS = ['reserveFunds', 'commitReservation', 'releaseReservation',
  'expireReservation', 'failReservation', 'expireDueReservations',
  'rebuildReservedBalance', 'reconcileReservations', 'corruptReservedCacheForTest'];
check('B12.3 http.js 里**没有**任何 P22-3 的 mutation 方法名（写能力在路由表上不存在）',
  RESERVATION_MUTATION_METHODS.every(name =>
    stripCommentsAndStrings(read('services/home-node/http.js')).indexOf(name) < 0),
  RESERVATION_MUTATION_METHODS.filter(name =>
    stripCommentsAndStrings(read('services/home-node/http.js')).indexOf(name) >= 0));
check('B12.4 http.js 里出现的 reservation 读取面恰是那三个只读方法（多一个都要解释）',
  (() => {
    const code = stripCommentsAndStrings(read('services/home-node/http.js'));
    const used = ['listReservations', 'getReservation', 'serializeReservation']
      .filter(name => code.indexOf(name) >= 0);
    return used.length === 3;
  })());
check('B12.5 reservation 的两条新路由也都是 GET（不给自己开一个写动词的口子）',
  (() => {
    const src = read('services/home-node/http.js');
    const blocks = src.match(/path === '\/economy\/(?:reservation|reservations)' && method === '[A-Z]+'/g) || [];
    return blocks.length === 2 && blocks.every(b => /&& method === 'GET'$/.test(b));
  })(),
  read('services/home-node/http.js').match(/path === '\/economy\/reservation[s]?' && method === '[A-Z]+'/g));

/* ── append-only 仍然只是 ledger 那三张表的事 ─────────────────────── */
check('B12.6 Economy 生产文件里没有任何一条 UPDATE / DELETE 指向 ledger 的三个事实表',
  (() => {
    const src = read('services/home-node/economy-store.js');
    const hits = (src.match(/(?:UPDATE|DELETE\s+FROM)\s*['"]?\s*\+\s*(TRANSACTIONS_TABLE|ENTRIES_TABLE|CHANGE_LOG_TABLE|ACCOUNTS_TABLE)/g) || []);
    return hits.length === 0;
  })());
check('B12.7 生命周期行的 UPDATE 只赋状态与链接列（经济内容列一次都不出现在 SET 里）',
  (() => {
    const src = read('services/home-node/economy-store.js');
    const windowOf = (name) => {
      const at = src.indexOf(name + ':');
      if (at < 0) return '';
      const rest = src.slice(at);
      const b = rest.search(/\n {4}[A-Za-z]/);
      return b < 0 ? rest : rest.slice(0, b);
    };
    const cols = (name) => {
      const m = /SET ([^']*?) WHERE/.exec(windowOf(name));
      return m ? m[1].split(',').map(s => s.trim().split('=')[0].trim()) : null;
    };
    const op = cols('setOperationStatus');
    const res = cols('setReservationStatus');
    const forbidden = ['wallet_id', 'currency', 'amount_minor', 'operation_id', 'idempotency_key', 'created_at'];
    return op != null && res != null &&
      forbidden.every(c => op.indexOf(c) < 0 && res.indexOf(c) < 0);
  })());

/* ── 过期不是定时器（§14）──────────────────────────────────────────── */
/* ══ P22-11 · 定时器禁令的**精确**形式 ══════════════════════════════
   三条既有的断言（B12.8 / B13.10 / B15.14）说的都是同一件事：Economy
   里**到期是"比较 expires_at <= now"，不是某个调度**（§39）。P22-11 的
   command 通道第一次在 Economy 命名空间里需要 setTimeout —— 但它要的是
   **一次出站请求的最后期限与重试退避**，不是任何到期判定。
   把这条区别写成可核对的形式，而不是把整条禁令删掉：
     · 允许的文件**只有一个**（economy-command-channel.js）；
     · 在那个文件里 setTimeout 的出现次数**恰好两处**（超时中止 + 重试退避）；
     · 而且它**不做**任何到期扫描（没有 expireDue* 的调用、没有 setInterval）。 */
const TIMER_EXEMPT_FILES = ['services/home-node/economy-command-channel.js'];
function timerHitsIn(rel) {
  return (stripCommentsAndStrings(read(rel)).match(/\bset(?:Timeout|Interval)\b/g) || []);
}
function economicCodeHasNoTimers() {
  return PRODUCTION_FILES.every(rel => TIMER_EXEMPT_FILES.indexOf(rel) < 0
    ? timerHitsIn(rel).length === 0
    : true);
}
check('B12.8 到期判定不依赖任何定时器：生产文件里没有 setTimeout / setInterval',
  economicCodeHasNoTimers(),
  PRODUCTION_FILES.filter(rel => TIMER_EXEMPT_FILES.indexOf(rel) < 0 && timerHitsIn(rel).length));
check('B12.8b （输入存在）唯一被豁免的文件里，setTimeout 恰好两处，且都不做任何到期扫描',
  timerHitsIn(TIMER_EXEMPT_FILES[0]).length === 2 &&
  timerHitsIn(TIMER_EXEMPT_FILES[0]).filter(t => t === 'setInterval').length === 0 &&
  /\bsetTimeout\b/.test(stripCommentsAndStrings(read(TIMER_EXEMPT_FILES[0]))) &&
  !/expireDue/i.test(stripCommentsAndStrings(read(TIMER_EXEMPT_FILES[0]))),
  timerHitsIn(TIMER_EXEMPT_FILES[0]));
check('B12.9 到期扫描接受**显式** now（真相是 expires_at <= now 这条比较，不是某个调度）',
  /function expireDueReservations\(input\)/.test(STORE_SRC) &&
  /o\.now != null \? Number\(o\.now\) : clock\(\)/.test(STORE_SRC) &&
  /expires_at IS NOT NULL AND expires_at <= \?/.test(STORE_SRC));

/* ── 输入存在：上面每一条都必须有真实的被检查对象 ─────────────────── */
check('B12.10 （输入存在）六个 mutation 方法与 reserved 求和入口确实在 store 的公开面上',
  ['reserveFunds', 'commitReservation', 'releaseReservation', 'expireReservation',
    'failReservation', 'expireDueReservations'].every(name =>
    new RegExp('\\n    ' + name + ': ' + name + ',').test(STORE_SRC)) &&
  /\bsumActiveReserved\b/.test(STORE_SRC));

/* ══════════════════════════════════════════════════════════════════
   B13 · P22-4：预算规则与报价（真实人民币 maxBudget 的硬隔离 +
         评估纯读 + 写能力仍然不上 HTTP）
   ══════════════════════════════════════════════════════════════════ */
section('B13 · P22-4 budget / quote（maxBudget 隔离、评估纯读、写不上 HTTP）');

/* ── 三个分析辅助件（本节专用；它们是**测试**的一部分，被检查的对象是
   生产文件）───────────────────────────────────────────────────────────
   为什么需要一个"取函数体"的辅助：本阶段最重要的性质是**否定式**的
   —— "评估这一段代码里没有写路径"。用整文件 grep 做不到这一点（文件里
   当然有写路径，只是不在那几个函数里），因此这里先按函数边界切出正文，
   再在正文里找。切法刻意简单：从 `function name(` 起，到下一个**顶格**
   `  function ` / `  const ` 结尾 —— 那两个缩进正是本文件里"下一段"的
   形状。切不出来就返回 null，并让断言失败（宁可失败，也不要静默地
   在一个空字符串上做出"里面没有写路径"的结论）。 */
function functionBody(src, name) {
  const marker = 'function ' + name + '(';
  const at = src.indexOf(marker);
  if (at < 0) return null;
  const rest = src.slice(at);
  const boundary = rest.slice(marker.length).search(/\n {2}(?:function |const |let |return )/);
  return boundary < 0 ? rest : rest.slice(0, marker.length + boundary);
}
function statementWindowOf(src, name) {
  const at = src.indexOf(name + ':');
  if (at < 0) return null;
  const rest = src.slice(at);
  const boundary = rest.search(/\n {4}[A-Za-z]/);
  return boundary < 0 ? rest : rest.slice(0, boundary);
}
function okInput(result) { return !!(result && result.ok === true); }

/* STORE_SRC 在本文件前面已经定义（B11/B12 用它扫 SQL 形状），这里复用
   同一个常量 —— 两处各自 read 一次会让"被检查的文件"在原则上可以是两个
   不同的快照，而本文件里所有断言都假定只有一份。 */

/* ── B13.1：Economy 生产代码不得引用真实购物域的 maxBudget ─────────────
   这不是"再强调一次 B8"，而是那个风险在 P22-4 变得**具体**之后的一次
   重新断言：P22-4 引入了真正的预算限额字段，而最容易发生的错误就是把
   两套预算接起来（`maxPerDayMinor = task.maxBudget * 100`）。
   因此这里扫的是**依赖面**（require 目标）与**代码文本**（剥掉注释与
   字符串）两层。 */
check('B13.1 Economy 生产文件里**没有** maxBudget / dailyBudget / priceCNY 这类真实货币预算键（作为代码）',
  PRODUCTION_FILES.every(rel => {
    const code = stripCommentsAndStrings(read(rel));
    return !/\bmaxBudget\b/.test(code) && !/\bdailyBudget\b/.test(code) &&
      !/\bpriceCNY\b/.test(code) && !/\brealBudget\b/.test(code);
  }),
  PRODUCTION_FILES.filter(rel => /\b(?:maxBudget|dailyBudget|priceCNY|realBudget)\b/.test(stripCommentsAndStrings(read(rel)))));
check('B13.2 Economy 生产文件里**没有** require 到真实购物 / 支付 / 凭据域',
  allRequires.every(r => !/commerce|pay-gate|alipay|payment|credential-vault|shopping/.test(r.value)),
  allRequires.filter(r => /commerce|pay-gate|alipay|payment|credential-vault|shopping/.test(r.value)));
check('B13.3 契约的冲突键清单里确实有 maxBudget，且 Budget 输入拒绝它（否则 B13.1 在保护空气）',
  C.isRealCommerceKey('maxBudget') === true &&
  C.REAL_COMMERCE_COLLIDING_KEYS.indexOf('maxBudget') >= 0 &&
  !okInput(C.normalizeBudgetInput({ ownerId: 'cfg_a', maxBudget: 1000 })));
/* 反向：Economy 的预算字段名与真实人民币预算**字形不同族**。 */
check('B13.4 P22-4 的每一个政策限额字段都带 Minor 后缀（任何裸 budget/price/amount 都没有位置）',
  C.POLICY_LIMIT_TABLE.every(r => /Minor$/.test(r.name) && /_minor$/.test(r.field)) &&
  C.POLICY_LIMIT_NAMES.every(n => C.BUDGET_LIMIT_KEYS.indexOf(n) >= 0) &&
  STORE_SRC.indexOf('max_budget') < 0 && STORE_SRC.indexOf('budget_minor') < 0);

/* ── B13.5：评估是纯读（结构性断言，而不是"我们记得别写"）─────────── */
check('B13.5 预算评估那一段代码里没有**任何**写路径（reserve / ledger / 缓存 / 状态推进）',
  (() => {
    const fn = functionBody(STORE_SRC, 'budgetEvaluationFromSnapshot');
    if (fn == null) return false;
    return ['commitLedgerTransactionInTx', 'applyReservedCache', 'setWalletBalance', 'setWalletReserved',
      'insertOperation', 'insertReservation', 'allocateRevision', 'appendChange', 'insertQuote',
      'setQuoteState', 'upsertBudgetPolicy', 'insertBudgetPolicy'].every(name => fn.indexOf(name) < 0);
  })(),
  { body: functionBody(STORE_SRC, 'budgetEvaluationFromSnapshot') });
check('B13.6 组装快照（buildBudgetSnapshot）同样是纯读',
  (() => {
    const fn = functionBody(STORE_SRC, 'buildBudgetSnapshot');
    if (fn == null) return false;
    return ['commitLedgerTransactionInTx', 'applyReservedCache', 'setWalletBalance', 'setWalletReserved',
      'allocateRevision', 'appendChange'].every(name => fn.indexOf(name) < 0);
  })());
check('B13.7 evaluateQuote 只读：它不 reserve、不消费报价、不改状态',
  (() => {
    const fn = functionBody(STORE_SRC, 'evaluateQuote');
    if (fn == null) return false;
    return ['commitLedgerTransactionInTx', 'applyReservedCache', 'setWalletBalance', 'setWalletReserved',
      'reserveFunds', 'commitReservation', 'setQuoteState', 'allocateRevision', 'appendChange']
      .every(name => fn.indexOf(name) < 0) &&
      fn.indexOf('reserved: false') >= 0 && fn.indexOf('consumed: false') >= 0;
  })());

/* ── B13.8：报价的金额与币种不可变 —— 静态扫 UPDATE 的 SET 列 ────────── */
check('B13.8 唯一写 quotes 的 UPDATE 只赋状态与版本列，金额 / 币种 / 买家 / 商品一次都不出现',
  (() => {
    const window = statementWindowOf(STORE_SRC, 'setQuoteState');
    const m = window == null ? null : /SET ([^']*?) WHERE/.exec(window);
    if (!m) return false;
    const cols = m[1].split(',').map(s => s.trim().split('=')[0].trim());
    const forbidden = ['amount_minor', 'currency', 'buyer_id', 'buyer_type', 'product_id',
      'quantity', 'quote_kind', 'service_role', 'expires_at', 'created_at', 'recipient_id'];
    return forbidden.every(c => cols.indexOf(c) < 0) &&
      cols.indexOf('state') >= 0 && cols.indexOf('revision') >= 0 && cols.indexOf('updated_at') >= 0;
  })(),
  statementWindowOf(STORE_SRC, 'setQuoteState'));
check('B13.9 报价状态推进带并发守卫（`AND state=?`）—— 终态不可回退是 SQL 约束，不是纪律',
  /SET state=\?, revision=\?, updated_at=\? WHERE quote_id=\? AND state=\?/.test(STORE_SRC));
check('B13.10 报价的到期判定是**比较**（state=OPEN AND expires_at <= now），不是定时器',
  /WHERE state=\? AND expires_at <= \?/.test(STORE_SRC) &&
  /function expireDueQuotes\(input\)/.test(STORE_SRC) &&
  economicCodeHasNoTimers());

/* ── B13.11：P22-4 的六个写方法一个都不在 HTTP 上 ─────────────────── */
const POLICY_QUOTE_MUTATION_METHODS = ['putBudgetPolicy', 'expirePolicy', 'expireDuePolicies',
  'createQuote', 'expireQuote', 'expireDueQuotes'];
check('B13.11 http.js 里没有 P22-4 的任何 mutation 方法名（写能力在路由表上不存在）',
  POLICY_QUOTE_MUTATION_METHODS.every(name =>
    stripCommentsAndStrings(read('services/home-node/http.js')).indexOf(name) < 0),
  POLICY_QUOTE_MUTATION_METHODS.filter(name =>
    stripCommentsAndStrings(read('services/home-node/http.js')).indexOf(name) >= 0));
check('B13.12 http.js 里出现的政策 / 报价读取面恰是那几个只读方法（多一个都要解释）',
  (() => {
    const code = stripCommentsAndStrings(read('services/home-node/http.js'));
    const writeish = ['createQuote', 'expireQuote', 'expireDueQuotes', 'putBudgetPolicy',
      'expirePolicy', 'expireDuePolicies'].filter(n => code.indexOf(n) >= 0);
    const readish = ['listBudgetPolicies', 'getBudgetPolicy', 'serializeBudgetPolicy',
      'listQuotes', 'getQuote', 'serializeQuote', 'evaluateQuote', 'evaluateBudgetFor',
      'serializeBudgetSnapshot'].filter(n => code.indexOf(n) >= 0);
    return writeish.length === 0 && readish.length === 9;
  })());
check('B13.13 P22-4 的五条新路由全是 GET，且都在 economyPolicy 的 desktopPaths 里被声明',
  (() => {
    const src = read('services/home-node/http.js');
    const blocks = src.match(/path === '\/economy\/(?:polic(?:y|ies)|quotes?|budget)' && method === '[A-Z]+'/g) || [];
    /* desktopPaths 在 /security 里出现了四次（memory / understanding /
       moments / economy），因此必须从 economyPolicy 那一段里取，而不是
       取第一处 —— 取第一处会让这条断言实际上在检查 memory 的路径表。 */
    const at = src.indexOf('economyPolicy: {');
    const declared = at < 0 ? '' : (src.slice(at).match(/desktopPaths: \[[\s\S]*?\]/) || [''])[0];
    return blocks.length === 5 && blocks.every(b => /&& method === 'GET'$/.test(b)) &&
      ['/economy/policies', '/economy/policy', '/economy/budget', '/economy/quotes', '/economy/quote']
        .every(p => declared.indexOf("'" + p + "'") >= 0);
  })(),
  (read('services/home-node/http.js').match(/path === '\/economy\/(?:polic(?:y|ies)|quotes?|budget)' && method === '[A-Z]+'/g) || []));
check('B13.14 /security 的 economyPolicy 把 P22-4 的"没有"写成可断言字段',
  (() => {
    const src = read('services/home-node/http.js');
    return /budgetWritesExposed: \[\]/.test(src) && /quoteWritesExposed: \[\]/.test(src) &&
      /budgetEvaluationIsASnapshotOnly: true/.test(src) &&
      /budgetEvaluationReservesFunds: false/.test(src) &&
      /quoteLocksFunds: false/.test(src) &&
      /budgetTimezone: 'UTC'/.test(src);
  })());

/* ── B13.15：评估的输入面里没有正文的位置 ──────────────────────────── */
check('B13.15 评估上下文的构造只使用契约白名单里的键（prompt / relationship 无处可放）',
  (() => {
    const fn = functionBody(STORE_SRC, 'budgetContextFromSnapshot');
    if (fn == null) return false;
    const assigned = (fn.match(/^\s{4,}([a-zA-Z][A-Za-z0-9_]*)\s*:/gm) || [])
      .map(s => s.trim().replace(/:$/, ''));
    const allowed = C.BUDGET_INPUT_KEYS.concat(['usage', 'limits']);
    return assigned.length > 0 && assigned.every(k => allowed.indexOf(k) >= 0);
  })(),
  { body: functionBody(STORE_SRC, 'budgetContextFromSnapshot') });
check('B13.16 Economy 生产代码里不出现 trust / affection / affinity 的累加形态（B7.6 在 P22-4 继续成立）',
  PRODUCTION_FILES.every(rel => !/(?:affection|trust|familiarity|affinity)\s*(?:\+=|-=|\+\+|--)/i
    .test(stripCommentsAndStrings(read(rel)))));
check('B13.17 报价表的列**恰好**是"什么/多少钱/到什么时候"那几列，没有任何隐蔽库存列',
  (() => {
    const window = statementWindowOf(STORE_SRC, 'createQuotes');
    if (window == null) return false;
    /* 状态推进语句里只允许出现生命周期列，因此下面这张"允许的列"清单
       是一份**精确**名单：多一列就失败。它同时挡住 inventory_count /
       owned_items / provider_quota_balance 这类把报价变成隐蔽库存的
       字段，以及任何凭据或真实支付字段（§28/§24）。
       剥的只有**注释**，不剥字符串字面量 —— 列名本身就在字符串里，
       而 stripCommentsAndStrings 会把它们一起抹掉（那样这条断言会在
       一个空数组上"通过"）。 */
    const code = window
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/\/\/[^\n]*/g, ' ');
    const cols = Array.from(code.matchAll(/' ([a-z_]+) (?:TEXT|INTEGER)/g)).map(m => m[1]);
    const allowedColumns = ['quote_id', 'product_id', 'buyer_id', 'buyer_type', 'recipient_id',
      'recipient_type', 'currency', 'amount_minor', 'quantity', 'quote_kind', 'service_role',
      'state', 'expires_at', 'predecessor_quote_id', 'idempotency_key', 'fingerprint',
      'revision', 'created_at', 'updated_at'];
    const extra = cols.filter(c => allowedColumns.indexOf(c) < 0);
    const absent = allowedColumns.filter(c => cols.indexOf(c) < 0);
    return cols.length === allowedColumns.length && extra.length === 0 && absent.length === 0 &&
      !/inventory|owned_item|provider_quota|quota_balance|api_key|payment_link|secret|real_currency/i.test(code);
  })(),
  statementWindowOf(STORE_SRC, 'createQuotes'));

/* ── B13.18：输入存在（否则上面每一条都在保护空气）────────────────── */
check('B13.18 （输入存在）P22-4 的每个方法与契约件确实存在',
  POLICY_QUOTE_MUTATION_METHODS.every(name => new RegExp('\\n    ' + name + ': ' + name + ',').test(STORE_SRC)) &&
  ['listBudgetPolicies', 'getBudgetPolicy', 'serializeBudgetPolicy', 'evaluateBudgetFor',
    'buildBudgetSnapshot', 'serializeBudgetSnapshot', 'listQuotes', 'getQuote', 'serializeQuote',
    'evaluateQuote', 'spendingWindows'].every(name => new RegExp('\\n    ' + name + ': ' + name + ',').test(STORE_SRC)) &&
  typeof C.evaluateBudget === 'function' && typeof C.policyIsEffectiveAt === 'function' &&
  Array.isArray(C.BUDGET_SPENDING_TYPES) && C.BUDGET_SPENDING_TYPES.length >= 1);

/* ══════════════════════════════════════════════════════════════════
   B15 · P22-5：目录与库存这一层的静态边界
         （生产文件仍然最小 · 依赖闭包没有变宽 · 没有"删除历史" ·
           没有 provider / 支付 / 关系 / 推荐 · 写能力仍然不上 HTTP）
   ══════════════════════════════════════════════════════════════════ */
section('B15 · P22-5 store / product / inventory（依赖闭包、不可删除、写不上 HTTP）');

/* ── B15.1–B15.2：生产文件清单 ─────────────────────────────────────────
   P22-5 §1 明确要求"不要为了少几张表把这些概念合并"，而它的另一半是
   "也不要为了新概念多开几个文件"。三张表（stores / products / inventory）
   全部落在**同一个** economy-store.js 里，因为它们的写路径必须与
   change log / revision / idempotency 处在**同一个**事务边界里 ——
   抽出去就把那个保证降级成跨模块约定。 */
check('B15.1 P22-5 的三张表全部落在同一个 economy-store.js 里（它自己没新增生产文件）',
  PRODUCTION_FILES.length === 7 &&
  PRODUCTION_FILES.indexOf('services/home-node/economy-contract.js') >= 0 &&
  PRODUCTION_FILES.indexOf('services/home-node/economy-store.js') >= 0 &&
  /* ★ P22-9 的第三个文件是**门**（在 store 上面），不是 P22-5 的表。
     这里断言的是"三张表仍然只由 store 拥有"：契约件里没有 SQL，
     而门里没有一张表 —— 两个断言合起来让"P22-5 没有开新文件"继续成立。
     ★ P22-10 的第四个文件是**动作适配器**（在门上面），它同样没有一张
     表：适配器只做动作净化与转发，SQL 与 schema 仍然只由 store 拥有。
     ★ P22-11 的第五个文件是**command 通道**（在适配器上面），它也没有
     一张表：通道只做信封校验、来源判定与一次转发。
     三句话合起来仍然是 P22-5 §1 那句"不要为了新概念多开几个文件"。 */
  PRODUCTION_FILES.indexOf('services/home-node/economy-capability.js') >= 0 &&
  PRODUCTION_FILES.indexOf('services/home-node/economy-action-adapter.js') >= 0 &&
  PRODUCTION_FILES.indexOf('services/home-node/economy-command-channel.js') >= 0 &&
  /* ★ P22-13 的第六个文件是**用户决定 seam**（在门的旁边，与通道并列），
     它同样没有一张表：它做的是"判定桌面凭据 → 记一次决定 → 用门给的句柄
     续做"，SQL 与 schema 仍然只由 store 拥有。
     四句话合起来仍然是 P22-5 §1 那句"不要为了新概念多开几个文件"。 */
  PRODUCTION_FILES.indexOf('services/home-node/economy-approval-decision.js') >= 0 &&
  /* ★ P22-14 的第七个文件是**配置 seam**（fresh install 的配置入口），
     它同样没有一张表：它做的是"判定桌面凭据 → 三个白名单命令 → 交给 store"，
     SQL 与 schema 仍然只由 store 拥有。
     ★ 它为什么必须是一个**新**文件而不是塞进 P22-13 那条 seam：那一条的
     权威是"用户决定一条 intent"，这一条是"用户预设这台节点的钱与规则"。
     合成一条万能 user command endpoint 会让两种权威在审计里不可分。
     五句话合起来仍然是 P22-5 §1 那句"不要为了新概念多开几个文件"。 */
  PRODUCTION_FILES.indexOf('services/home-node/economy-configuration.js') >= 0 &&
  read('services/home-node/economy-store.js').indexOf('economy_inventory') >= 0 &&
  read('services/home-node/economy-contract.js').indexOf('CREATE TABLE') < 0 &&
  read('services/home-node/economy-command-channel.js').indexOf('CREATE TABLE') < 0 &&
  read('services/home-node/economy-approval-decision.js').indexOf('CREATE TABLE') < 0 &&
  read('services/home-node/economy-configuration.js').indexOf('CREATE TABLE') < 0 &&
  read('services/home-node/economy-action-adapter.js').indexOf('CREATE TABLE') < 0 &&
  read('services/home-node/economy-capability.js').indexOf('CREATE TABLE') < 0,
  PRODUCTION_FILES);
check('B15.2 依赖闭包没有变宽：require 的**目标集合**仍然是那三个（P22-9/P22-10 也一个新依赖都没加）',
  Array.from(new Set(allRequires.map(r => r.value))).sort().join(',') ===
    'node:crypto,node:http,node:sqlite,runtime/db-failure.js,services/home-node/economy-contract.js' &&
  /* ★ 断言的是**目标集合**，不是条目数：P22-9 的第三个文件与 P22-10 的
     第四个文件 require 的都是那份**已经存在**的契约 —— 那是同一个依赖，
     不是两次放宽。P22-11 的第五个文件新增了 node:crypto 与 node:http
     两个**核心**模块（见 B15.2b 对它们的逐字限制）。
     ★ P22-13 的第六个文件只新增了 node:crypto 的**一次**使用（桌面凭据的
     恒定时间比较），因此**目标集合一个成员都没变**，而条目数是 10。
     ★ P22-14 的第七个文件同样只新增了 node:crypto 的**一次**使用（同一个
     比较），因此目标集合**仍然一个成员都没变**，条目数是 12。 */
  allRequires.length === 12,
  allRequires.map(r => r.from + ' -> ' + r.value));
check('B15.2b 依赖里没有任何一个能碰钱 / 凭据 / 真实购物的模块（crypto 与 http 各自只被允许一种用法）',
  allRequires.every(r => !/payment|provider|credential|commerce|alipay|pay-gate|shopping/i.test(r.value)) &&
  /* ★ P22-11 让 Economy 的依赖闭包里第一次出现 node:crypto 与 node:http。
     它们不是"又一个可以碰网络的模块"，而是通道那两件**唯一**需要的能力：
       · node:crypto —— SHA-256 摘要（凭据只以摘要形式进索引）+ 恒定时间比较；
       · node:http  —— 一条有界超时/有界重试的出站调用（Home Node 侧不再
         需要服务器：它本来就是 http.js 的既有 server）。
     ★ P22-13 的第二个 crypto 是**同一个用法**的第二次出现（对桌面凭据的
     恒定时间比较），而它**没有**带来 node:http —— 那条 seam 是同进程的
     两步调用。
     ★ P22-14 的第三个 crypto 逐字是**同一个用法**的第三次出现（对同一份
     桌面凭据的同一个比较），它同样**没有**带来 node:http、没有开服务器、
     没有定时器（见 B3.7d）。
     因此这里逐项写下来：crypto 三处、http 一处。 */
  allRequires.filter(r => r.value === 'node:crypto').length === 3 &&
  allRequires.filter(r => r.value === 'node:http').length === 1,
  allRequires.map(r => r.value));

/* ── B15.3：契约的新数据仍然是**输入**，不是注释 ───────────────────── */
check('B15.3 契约里真的存在 P22-5 的三张否认清单（否则下面的静态检查在保护空气）',
  C.FORBIDDEN_PRODUCT_FIELDS.length >= 20 &&
  C.FORBIDDEN_PRODUCT_FIELDS.indexOf('providerApiKey') >= 0 &&
  C.FORBIDDEN_PRODUCT_FIELDS.indexOf('providerBalance') >= 0 &&
  C.FORBIDDEN_PRODUCT_FIELDS.indexOf('providerTopup') >= 0 &&
  C.FORBIDDEN_PRODUCT_FIELDS.indexOf('checkoutUrl') >= 0 &&
  C.FORBIDDEN_PRODUCT_FIELDS.indexOf('paymentIntent') >= 0 &&
  C.FORBIDDEN_PRODUCT_FIELDS.indexOf('realMoney') >= 0 &&
  C.FORBIDDEN_PRODUCT_FIELDS.indexOf('cny') >= 0 &&
  C.FORBIDDEN_PRODUCT_FIELDS.indexOf('usd') >= 0 &&
  C.FORBIDDEN_PRODUCT_FIELDS.indexOf('discount') >= 0 &&
  C.FORBIDDEN_PRODUCT_FIELDS.indexOf('featured') >= 0 &&
  C.FORBIDDEN_PRODUCT_FIELDS.indexOf('recommended') >= 0 &&
  C.FORBIDDEN_PRODUCT_FIELDS.indexOf('trust') >= 0 &&
  C.PRODUCT_INPUT_KEYS.length >= 12 && C.STORE_INPUT_KEYS.length >= 6 &&
  C.isForbiddenProductFieldName('providerBalance') === true &&
  C.isForbiddenProductFieldName('unitPriceMinor') === false);

/* ── B15.4：P22-5 生产代码里没有 provider / 支付 / 关系 / 推荐 ─────── */
check('B15.4 Economy 生产代码里没有 provider 充值 / 支付 / 结账这类**动词**（作为代码）',
  PRODUCTION_FILES.every(rel => {
    const code = stripCommentsAndStrings(read(rel));
    return !/\btopUpProvider\b/.test(code) && !/\bpurchaseProviderCredits\b/.test(code) &&
      !/\bupdateProviderBalance\b/.test(code) && !/\bproviderBillingMutation\b/.test(code) &&
      !/\bcheckoutUrl\b/.test(code) && !/\bpaymentIntent\b/.test(code) &&
      !/\bsubmitPayment\b/.test(code) && !/\bcommitSpend\b/.test(code);
  }),
  PRODUCTION_FILES.filter(rel => /providerBillingMutation|checkoutUrl|paymentIntent|submitPayment/
    .test(stripCommentsAndStrings(read(rel)))));
check('B15.5 商品 / 库存这一层里没有"推荐"与"折扣"的实现痕迹（§40 / §41）',
  PRODUCTION_FILES.every(rel => {
    const code = stripCommentsAndStrings(read(rel));
    /* 只扫**实现**形态：字段读写在 P22-5 的 serialize* 里逐字写着
       hasDiscount:false / hasRecommendation:false（那是**否认数据**），
       而这里要挡的是"真的去算一个折扣"或"真的去排一个推荐名次"。 */
    return !/\bcalculateDiscount\b/.test(code) && !/\bapplyDiscount\b/.test(code) &&
      !/\brecommendationScore\b/.test(code) && !/\bpersonalizedPrice\b/.test(code) &&
      !/\brelevanceScore\b/.test(code);
  }));
check('B15.6 目录与库存这一层里没有任何"关系维度"的输入（trust / affection 不在商品或库存的字段里）',
  C.PRODUCT_INPUT_KEYS.every(k => !/trust|affection|affinity|familiarity|relationship|memory/i.test(k)) &&
  C.STORE_INPUT_KEYS.every(k => !/trust|affection|affinity|familiarity|relationship|memory/i.test(k)) &&
  C.INVENTORY_CANONICAL_KEY.every(k => !/trust|affection|relationship/i.test(k)));

/* ── B15.7：没有"删除经济历史"的语句（§23）──────────────────────────
   这一条必须**先剥注释**：store 里有一句解释性注释逐字写着
   "没有 DELETE FROM economy_inventory"，而整文件 grep 会把它判成一次
   真实的删除 —— 修法就会变成"把解释删掉"，那是最坏的一种修法
   （boundary B3 的 scanRequires 踩过同一个坑，修的是扫描器）。 */
check('B15.7 生产代码里没有 DELETE FROM stores / products / inventory（§23：只允许状态转换）',
  (() => {
    const code = stripCommentsAndStrings(read('services/home-node/economy-store.js'));
    const targets = (code.match(/DELETE\s+FROM\s*([A-Za-z_][A-Za-z0-9_]*)/g) || [])
      .map(s => s.replace(/DELETE\s+FROM\s*/, ''));
    return targets.every(t => t === 'IDEMPOTENCY_TABLE' || t === 'OPERATION_IDEMPOTENCY_TABLE') &&
      !/economy_(?:stores|products|inventory)\b/.test(code.replace(/DELETE\s+FROM\s*IDEMPOTENCY_TABLE[^\n]*/g, ''));
  })(),
  (stripCommentsAndStrings(read('services/home-node/economy-store.js')).match(/DELETE\s+FROM\s*[A-Za-z_][A-Za-z0-9_]*/g) || []));
check('B15.7b 反向：那两张被允许 DELETE 的表确实是幂等表（TTL 清理），不是经济事实表',
  /pruneIdempotency/.test(read('services/home-node/economy-store.js')) &&
  /pruneOperationIdempotency/.test(read('services/home-node/economy-store.js')));

/* ── B15.8：库存的"不可能为负"有两层**结构**来源 ─────────────────── */
check('B15.8 库存表带 CHECK (quantity >= 0)，且 shrink 语句带 `quantity >= ?` 守卫',
  /CHECK \(quantity >= 0\)/.test(read('services/home-node/economy-store.js')) &&
  /SET quantity = quantity - \?, .*? WHERE inventory_entry_id=\? AND quantity >= \?/
    .test(read('services/home-node/economy-store.js')));
check('B15.8b Grant / product 表的金额与数量也各有一条 CHECK（三个数都不是"只靠 JS 挡着"）',
  /CHECK \(unit_price_minor >= 0\)/.test(read('services/home-node/economy-store.js')) &&
  /CHECK \(grant_quantity >= 0\)/.test(read('services/home-node/economy-store.js')));

/* ── B15.9：P22-5 的五个写方法一个都不在 HTTP 上 ─────────────────── */
const CATALOG_MUTATION_METHODS = ['putStore', 'putProduct', 'grantInventory',
  'consumeInventory', 'createProductQuote'];
check('B15.9 http.js 里没有 P22-5 的任何 mutation 方法名（写能力在路由表上不存在）',
  CATALOG_MUTATION_METHODS.every(name =>
    stripCommentsAndStrings(read('services/home-node/http.js')).indexOf(name) < 0),
  CATALOG_MUTATION_METHODS.filter(name =>
    stripCommentsAndStrings(read('services/home-node/http.js')).indexOf(name) >= 0));
check('B15.10 P22-5 的六条新路由全是 GET，且都在 economyPolicy 的 desktopPaths 里被声明',
  (() => {
    const src = read('services/home-node/http.js');
    const blocks = src.match(/path === '\/economy\/(?:stores?|products?|inventory(?:-entry)?)' && method === '[A-Z]+'/g) || [];
    const at = src.indexOf('economyPolicy: {');
    const declared = at < 0 ? '' : (src.slice(at).match(/desktopPaths: \[[\s\S]*?\]/) || [''])[0];
    return blocks.length === 6 && blocks.every(b => /&& method === 'GET'$/.test(b)) &&
      ['/economy/stores', '/economy/store', '/economy/products', '/economy/product',
        '/economy/inventory', '/economy/inventory-entry']
        .every(p => declared.indexOf("'" + p + "'") >= 0);
  })(),
  (read('services/home-node/http.js').match(/path === '\/economy\/(?:stores?|products?|inventory(?:-entry)?)' && method === '[A-Z]+'/g) || []));
check('B15.11 /security 的 economyPolicy 把 P22-5 的"没有"写成可断言字段',
  (() => {
    const src = read('services/home-node/http.js');
    return /storeWritesExposed: \[\]/.test(src) && /productWritesExposed: \[\]/.test(src) &&
      /inventoryWritesExposed: \[\]/.test(src) && /purchaseExposed: false/.test(src) &&
      /inventoryIsABalance: false/.test(src) && /storeHoldsPrices: false/.test(src) &&
      /storeHoldsOwnership: false/.test(src) &&
      /productPricingIsRelationshipFree: true/.test(src) &&
      /catalogIsPersonalized: false/.test(src);
  })());
check('B15.12 unreachable 里列着"目录与库存的写形态"，而三条真实只读路径**不在**里面',
  (() => {
    const src = read('services/home-node/http.js');
    const at = src.indexOf('economyPolicy: {');
    const declared = at < 0 ? '' : (src.slice(at).match(/unreachable: \[[\s\S]*?\]/) || [''])[0];
    return ['/economy/inventory/grant', '/economy/inventory/consume', '/economy/store/create',
      '/economy/store/update', '/economy/product/create', '/economy/product/update']
      .every(p => declared.indexOf("'" + p + "'") >= 0) &&
      ['/economy/inventory', '/economy/store', '/economy/product']
        .every(p => declared.indexOf("'" + p + "'") < 0);
  })());

/* ── B15.13：P22-5 的能力与契约件确实存在（输入存在断言）──────────── */
check('B15.13 （输入存在）P22-5 的方法与契约件都真的存在',
  CATALOG_MUTATION_METHODS.every(name => new RegExp('\\n    ' + name + ': ' + name + ',').test(STORE_SRC)) &&
  ['getStore', 'listStores', 'getProduct', 'listProducts', 'serializeStore', 'serializeProduct',
    'getInventoryEntry', 'listInventory', 'inventoryQuantity', 'serializeInventoryEntry',
    'productProvenanceOf'].every(name => new RegExp('\\n    ' + name + ': ' + name + ',').test(STORE_SRC)) &&
  typeof C.validateProduct === 'function' && typeof C.validateStore === 'function' &&
  typeof C.productQuoteAmountMinor === 'function' && typeof C.assertProductStatusTransition === 'function' &&
  C.PRODUCT_KINDS.length === 5 && C.FULFILLMENTS.length === 3);
check('B15.14 P22-5 没有引入定时器：目录与库存都**没有**任何基于时间的自动变化（§39）',
  economicCodeHasNoTimers());
check('B15.15 库存这一层没有派生缓存：不存在 inventory_cached_quantity / rebuildInventory',
  (() => {
    /* 同样必须先剥注释：DDL 旁边那句"刻意**没有**的列：
       inventory_cached_quantity"是一句**否认**，不是一次声明。 */
    const code = stripCommentsAndStrings(STORE_SRC);
    return code.indexOf('inventory_cached_quantity') < 0 &&
      code.indexOf('cache_inventory') < 0 &&
      !/\brebuildInventory\b/.test(code);
  })() &&
  /inventoryDerived: 'none'/.test(STORE_SRC),
  { hits: ['inventory_cached_quantity', 'cache_inventory', 'rebuildInventory']
    .filter(n => stripCommentsAndStrings(STORE_SRC).indexOf(n) >= 0) });

/* ══════════════════════════════════════════════════════════════════
   B18 · P22-9 准入门（门在 P22-8 **上面**、没有旁路、写能力不上 HTTP）
   ══════════════════════════════════════════════════════════════════
   这一组的存在理由只有一条：§4 要求"不存在 consumer → proposePurchaseIntent
   的旁路"，而一句"我们记得总是先过门"不是证明。

   能成为证明的只有两件事，这里都做：
     · **句柄没有那个输入位**（consumer 与 capability 在构造期/方法名上绑定
       —— B18.12 断言公开面，P22-9 的测试断言行为）；
     · **全仓库的调用点断言**（B18.3）—— 生产代码里调用 P22-8 两个写入口的
       地方**只有**门的两个方法，一个都不多。
   它与既有的 B12.3 / B13.11 / B15.9（"http.js 里没有那些方法名"）同源：
   一条边界要么可被断言，要么只是一个愿望。 */
section('B18 · P22-9 准入门（门在 P22-8 上面、没有旁路、写能力不上 HTTP）');

const GATE_REL = 'services/home-node/economy-capability.js';
const GATE_SRC = read(GATE_REL);
const GATE_CODE = stripCommentsAndStrings(GATE_SRC);

check('B18.1 门是**第三个** Economy 生产文件，且它的依赖只有那份契约（一个新依赖都没有）',
  PRODUCTION_FILES.indexOf(GATE_REL) >= 0 &&
  scanRequires(GATE_SRC).length === 1 &&
  scanRequires(GATE_SRC)[0] === './economy-contract.js',
  { files: PRODUCTION_FILES, requires: scanRequires(GATE_SRC) });

check('B18.2 门自己**不写库**：源码里没有表名、没有 SQL 动词（它只调 store）',
  ['economy_change_log', 'economy_store', 'INSERT INTO', 'SELECT ', 'UPDATE ', 'appendChange']
    .every(n => GATE_CODE.indexOf(n) < 0),
  ['economy_change_log', 'economy_store', 'INSERT INTO', 'SELECT ', 'UPDATE ', 'appendChange']
    .filter(n => GATE_CODE.indexOf(n) >= 0));

/* ── B18.3 ★ 这一组里最重要的一条：全仓库的调用点 ─────────────────────
   ★ 测试直接调用 store 是**允许且必要**的：P22-6 ~ P22-8 的 canonical 行为
   必须在"没有门"的情况下也能被独立证明（那些阶段的测试就是这么写的）。
   这里断言的是**生产代码**里的调用点，而它只有一个文件。 */
const BYPASS_SCAN_DIRS = ['services', 'active', 'runtime', 'assets/js', 'bridge', 'scripts'];
const BYPASS_CALL_RE = /\.\s*(?:proposeAgentPurchaseIntent|resumeAgentPurchaseIntent)\s*\(/;
const bypassCallSites = [];
function scanBypassCalls(dirRel) {
  const abs = path.join(ROOT, dirRel);
  if (!fs.existsSync(abs)) return;
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    const rel = dirRel + '/' + entry.name;
    if (entry.isDirectory()) { scanBypassCalls(rel); continue; }
    if (!/\.js$/i.test(entry.name)) continue;
    const lines = read(rel).split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (BYPASS_CALL_RE.test(lines[i])) bypassCallSites.push(rel + ':' + (i + 1));
    }
  }
}
BYPASS_SCAN_DIRS.forEach(scanBypassCalls);

check('B18.3 ★ 生产代码里调用 P22-8 两个写入口的地方**只有**门（没有任何旁路）',
  bypassCallSites.length === 2 &&
  bypassCallSites.every(site => site.indexOf(GATE_REL + ':') === 0),
  bypassCallSites);
check('B18.3b 门里那两处恰好各一次：propose 一次、resume 一次（不是"一个循环调一百次"）',
  (GATE_SRC.match(/store\.proposeAgentPurchaseIntent\s*\(/g) || []).length === 1 &&
  (GATE_SRC.match(/store\.resumeAgentPurchaseIntent\s*\(/g) || []).length === 1,
  { propose: (GATE_SRC.match(/store\.proposeAgentPurchaseIntent\s*\(/g) || []).length,
    resume: (GATE_SRC.match(/store\.resumeAgentPurchaseIntent\s*\(/g) || []).length });

check('B18.4 门对 store 的访问全是**字面成员名**，没有 `store[…]` 形式的计算型分派'
  + '（§6：不存在 executeEconomyAction 那种万能入口）',
  !/store\s*\[/.test(GATE_CODE) &&
  (GATE_SRC.match(/store\.appendCapabilityAudit\s*\(/g) || []).length === 1 &&
  GATE_CODE.indexOf('executeEconomyAction') < 0 &&
  GATE_CODE.indexOf('apply(') < 0 &&
  GATE_CODE.indexOf('dispatch') < 0,
  { computedAccess: /store\s*\[/.test(GATE_CODE), src: GATE_CODE.indexOf('store[') });

check('B18.5 门里不存在任何 P22-3 ~ P22-8 的底层写动词（作为标识符）',
  ['settlePurchase', 'preparePurchase', 'cancelPurchase', 'reserveFunds', 'commitReservation',
    'releaseReservation', 'expireReservation', 'failReservation', 'grantInventory',
    'consumeInventory', 'createQuote', 'putProduct', 'putStore', 'putBudgetPolicy',
    'putAutonomyPolicy', 'decideApproval', 'createApprovalRequest', 'authorizePurchaseIntent',
    'mintForSystem', 'burnForSystem', 'commitLedgerTransaction', 'transferBetweenWallets',
    'openWallet']
    .every(v => !new RegExp('\\b' + v + '\\b').test(GATE_CODE)),
  ['settlePurchase', 'preparePurchase', 'cancelPurchase', 'reserveFunds', 'commitReservation',
    'releaseReservation', 'expireReservation', 'failReservation', 'grantInventory',
    'consumeInventory', 'createQuote', 'putProduct', 'putStore', 'putBudgetPolicy',
    'putAutonomyPolicy', 'decideApproval', 'createApprovalRequest', 'authorizePurchaseIntent',
    'mintForSystem', 'burnForSystem', 'commitLedgerTransaction', 'transferBetweenWallets',
    'openWallet'].filter(v => new RegExp('\\b' + v + '\\b').test(GATE_CODE)));

check('B18.6 门不 require 进程 / 网络 / 加密原语，也没有定时器'
  + '（准入是一个**纯查表 + 一次调用**，它不需要时间也不需要端口）',
  scanRequires(GATE_SRC).every(spec => !/^(?:node:)?(child_process|net|http|https|tls|dgram|crypto|worker_threads|fs|worker_threads)$/.test(spec)) &&
  !/\bsetTimeout\b|\bsetInterval\b/.test(GATE_CODE) &&
  !/\bnew Date\b|\bDate\.now\b/.test(GATE_CODE),
  { requires: scanRequires(GATE_SRC) });

check('B18.7 门没有**模块级可变状态**（顶层没有 let / var 声明）'
  + '—— 权限不活在某个进程的内存里，它活在契约里',
  !/^(?:let|var)\s/m.test(GATE_SRC) &&
  /\bObject\.freeze\(/.test(GATE_SRC),
  GATE_SRC.split(/\r?\n/).filter(l => /^(?:let|var)\s/.test(l)));

/* ── B18.8 ~ B18.11：HTTP 面 ───────────────────────────────────────── */
/* ★ 下面两条断言都**剥掉注释与字符串**再比：http.js 的 economyPolicy 那一段
   必须能解释"为什么准入不上 HTTP"，而那段解释里当然会写出这个文件名；
   同理门自己的头部注释里会提到契约那张表的名字。被禁止的是**引用**
   （一个真实的标识符），不是解释 —— 这与 B3.7 的 require 扫描同源
   （那里的注释假阳性修的是扫描器，不是那句话）。 */
const httpCode = stripCommentsAndStrings(read('services/home-node/http.js'));

check('B18.8 http.js 里没有门的**任何**成员名（门不是一项服务，因此连名字都不该出现在路由层）',
  ['economy-capability', 'createEconomyCapabilityGate', 'economyCapabilityGate',
    'appendCapabilityAudit', 'checkEconomyCapability', 'proposePurchaseIntent',
    'resumeApprovedPurchase'].every(n => httpCode.indexOf(n) < 0),
  ['economy-capability', 'createEconomyCapabilityGate', 'economyCapabilityGate',
    'appendCapabilityAudit', 'checkEconomyCapability', 'proposePurchaseIntent',
    'resumeApprovedPurchase'].filter(n => httpCode.indexOf(n) >= 0));

check('B18.9 /security 的 economyPolicy 把 P22-9 的"没有"写成可断言字段'
  + '（读写两个名单**都**是空的：门连读面都不对外）',
  /capabilityGateImplemented:\s*true/.test(read('services/home-node/http.js')) &&
  /capabilityWritesExposed:\s*\[\]/.test(read('services/home-node/http.js')) &&
  /capabilityReadsExposed:\s*\[\]/.test(read('services/home-node/http.js')) &&
  /capabilityGrantViaHttpIsForbidden:\s*true/.test(read('services/home-node/http.js')) &&
  /capabilityIsNotEconomyAuthority:\s*true/.test(read('services/home-node/http.js')) &&
  /capabilityIsNotABudgetDecision:\s*true/.test(read('services/home-node/http.js')));

check('B18.10 六条"授权形态"的路径都在 unreachable 里，且**没有**一条进 desktopPaths'
  + '（声明与真实路由不得分叉）',
  (() => {
    const capabilityPaths = ['/economy/capability', '/economy/capabilities',
      '/economy/capability/grant', '/economy/capability/revoke',
      '/economy/gate', '/economy/gate/check'];
    const inUnreachable = capabilityPaths.every(p => read('services/home-node/http.js').indexOf("'" + p + "'") >= 0);
    const desktopBlock = (read('services/home-node/http.js').match(/desktopPaths:\s*\[[\s\S]*?\]/) || [''])[0];
    const noneInDesktop = capabilityPaths.every(p => desktopBlock.indexOf(p) < 0);
    return inUnreachable && noneInDesktop;
  })());

check('B18.11 权限表只有**一份**：CONSUMER_CAPABILITY_MATRIX 只出现在契约的**代码**里'
  + '（生产代码里没有第二张表）',
  PRODUCTION_FILES.filter(rel => stripCommentsAndStrings(read(rel)).indexOf('CONSUMER_CAPABILITY_MATRIX') >= 0)
    .join(',') === 'services/home-node/economy-contract.js' &&
  GATE_CODE.indexOf('CONSUMER_CAPABILITY_MATRIX') < 0 &&
  GATE_CODE.indexOf('PROPOSE_PURCHASE:') < 0,
  { holders: PRODUCTION_FILES.filter(rel => stripCommentsAndStrings(read(rel)).indexOf('CONSUMER_CAPABILITY_MATRIX') >= 0),
    gateHoldsATable: GATE_CODE.indexOf('PROPOSE_PURCHASE:') >= 0 });

/* ── B18.12：公开面（§6 的机器可读形式）───────────────────────────── */
const createGateForShape = require(path.join(ROOT, GATE_REL));
const shapeGate = createGateForShape({ store: null });

check('B18.12 门只公开六个成员，而且句柄的键**恰好**是那五个'
  + '（没有 store、没有底层动词、没有万能入口）',
  Object.keys(shapeGate).sort().join(',') ===
    ['bind', 'checkEconomyCapability', 'describe', 'HANDLE_KEYS', 'PROPOSE_INPUT_KEYS', 'RESUME_INPUT_KEYS'].sort().join(',') &&
  Object.keys(shapeGate.bind('active_agent_runtime')).sort().join(',') ===
    ['anchor', 'capabilities', 'consumer', 'proposePurchaseIntent', 'resumeApprovedPurchase'].sort().join(','),
  { gate: Object.keys(shapeGate), handle: Object.keys(shapeGate.bind('active_agent_runtime')) });

check('B18.13 句柄是**冻结**的，而且它的原型就是 Object.prototype'
  + '（拿不到 store，也拿不到任何继承来的能力）',
  Object.isFrozen(shapeGate.bind('active_agent_runtime')) &&
  Object.getPrototypeOf(shapeGate.bind('active_agent_runtime')) === Object.prototype &&
  shapeGate.bind('active_agent_runtime').proposePurchaseIntent.length === 1 &&
  shapeGate.bind('active_agent_runtime').resumeApprovedPurchase.length === 1);

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
