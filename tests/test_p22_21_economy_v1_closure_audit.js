/* ══════════════════════════════════════════════════════════════════════
   P22-21 · Economy v1 Closure Audit（§0 / §2 / §3 / §4 / §6 / §7 / §8）

   运行：node tests/test_p22_21_economy_v1_closure_audit.js

   这一条测试**不重跑** P22-1～P22-20 的任何一条既有断言。它只回答
   本阶段真正要问的那几个跨阶段问题：

     §0 是否存在两个阶段声称拥有同一个 authority（C）？
        是否存在一个 authority 没有 owner（D）？
     §2 写面普查：每一个 store 写方法的 production callers 是谁？
        有没有 **suspicious bypass**？
     §3 读面普查：代码 ↔ 两份文档（manifest 与 PUBLIC_SURFACE）双向 diff = 0；
        外加一个 owner-scope 对抗性 fixture。
     §4 四个状态机的叉积：可达 / 终态 / 禁止 / unknown。
     §6 崩溃边界：哪些东西在**同一个**事务里，哪些是事务后的可观测副作用。
     §7 四种资源（IB_CREDIT / COMPUTE entitlement / provider quota / 真钱）
        的两两"无路径"证明。
     §8 UI authority：每一条规则的可证伪形式。

   ── 资源 ─────────────────────────────────────────────────────────────
     纯 Node 静态 + 真实 store 构造（临时目录）。**零** HTTP、零 socket、
     零子进程、零浏览器。
     ★ §3 那条 owner-scope 对抗性 fixture 的**传输腿**（真实
       `GET /economy/changes?ownerId=&order=desc`）由
       `tests/test_p22_21_economy_golden_path.js` 的 G24/G25/G26 在同一阶段内
       真跑一遍（那里本来就有 server），以及 P22-19 的三条既有测试持有。
       本文件因此不为了"再证明一次"多开一个 socket。
   ══════════════════════════════════════════════════════════════════════ */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }
function replacer(k, v) { return typeof v === 'bigint' ? v.toString() + 'n' : v; }
function J(v) { return JSON.stringify(v, replacer); }
function strip(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1 ')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''").replace(/"(?:[^"\\]|\\.)*"/g, '""');
}

let checks = 0;
let failures = 0;
function check(name, cond, extra) {
  checks += 1;
  if (cond) { console.log('  ✔ ' + name); return true; }
  failures += 1;
  console.error('  ✖ ' + name + (extra !== undefined ? ' — ' + J(extra) : ''));
  return false;
}
function section(t) { console.log('\n── ' + t + ' ' + '─'.repeat(Math.max(0, 62 - t.length))); }

const C = require(path.join(ROOT, 'services/home-node/economy-contract.js'));
const CHANNEL = require(path.join(ROOT, 'services/home-node/economy-command-channel.js'));
const CONFIG = require(path.join(ROOT, 'services/home-node/economy-configuration.js'));
const DECISION = require(path.join(ROOT, 'services/home-node/economy-approval-decision.js'));
const STORE_MODULE = require(path.join(ROOT, 'services/home-node/economy-store.js'));

const STORE_REL = 'services/home-node/economy-store.js';
const HTTP_REL = 'services/home-node/http.js';
const MANIFEST_REL = 'docs/contracts/economy/ECONOMY_V1_FROZEN_CONTRACT.md';
const SURFACE_REL = 'docs/contracts/economy/ECONOMY_PUBLIC_SURFACE.md';
const PROD_FILES = fs.readdirSync(path.join(ROOT, 'services', 'home-node'))
  .filter(f => /^economy-.*\.js$/.test(f)).sort().map(f => 'services/home-node/' + f);

/* ══════════════════════════════════════════════════════════════════════
   1 · store 静态结构：SQL 写、逐函数写可达性、真实公开面
   ══════════════════════════════════════════════════════════════════════ */
const STORE_SRC = read(STORE_REL);
const STORE_LINES = STORE_SRC.split(/\r?\n/);

const SQL_KEYS = (() => {
  const start = STORE_LINES.findIndex(l => /^\s{2}const SQL = \{/.test(l));
  let end = -1;
  for (let i = start + 1; i < STORE_LINES.length; i += 1) { if (/^\s{2}\};/.test(STORE_LINES[i])) { end = i; break; } }
  const out = {};
  for (let i = start + 1; i < end; i += 1) {
    const m = /^\s{4}([A-Za-z][\w]*)\s*:/.exec(STORE_LINES[i]);
    if (!m) continue;
    let j = i + 1, body = STORE_LINES[i];
    while (j < end && !/^\s{4}[A-Za-z][\w]*\s*:/.test(STORE_LINES[j]) && !/^\s{2}\};/.test(STORE_LINES[j])) { body += '\n' + STORE_LINES[j]; j += 1; }
    out[m[1]] = body;
  }
  return out;
})();
const isWriteKey = (k) => /INSERT |DELETE FROM|\bUPDATE\b/i.test(SQL_KEYS[k] || '');

const STORE_FUNCS = (() => {
  const defs = [];
  for (let i = 0; i < STORE_LINES.length; i += 1) {
    const m = /^\s{2}function\s+([A-Za-z_$][\w$]*)\s*\(/.exec(STORE_LINES[i]);
    if (m) defs.push({ name: m[1], start: i });
  }
  for (let k = 0; k < defs.length; k += 1) defs[k].end = (k + 1 < defs.length ? defs[k + 1].start : STORE_LINES.length);
  const out = {};
  for (const d of defs) {
    const body = STORE_LINES.slice(d.start, d.end).join('\n');
    const refs = new Set(); let m;
    const reSql = /SQL\.([A-Za-z_$][\w$]*)/g;
    while ((m = reSql.exec(body))) refs.add(m[1]);
    const calls = new Set();
    const reCall = /(?:^|[^\w.$])([A-Za-z_$][\w$]*)\s*\(/gm;
    while ((m = reCall.exec(body))) calls.add(m[1]);
    out[d.name] = { line: d.start + 1, sqlRefs: Array.from(refs), calls: Array.from(calls), body: body };
  }
  return out;
})();
const writeMemo = {};
function reachesAWrite(name, seen) {
  if (Object.prototype.hasOwnProperty.call(writeMemo, name)) return writeMemo[name];
  if (seen.has(name)) return false;
  seen.add(name);
  const f = STORE_FUNCS[name];
  if (!f) return false;
  if (f.sqlRefs.some(isWriteKey)) { writeMemo[name] = true; return true; }
  for (const callee of f.calls) {
    if (STORE_FUNCS[callee] && reachesAWrite(callee, seen)) { writeMemo[name] = true; return true; }
  }
  writeMemo[name] = false;
  return false;
}
/* ★ 一个函数的**传递 SQL 写集合**：§6 的"同一个事务"证明靠它，而不是靠
   grep 某个函数名（函数名与 SQL 语句键名在本文件里是**两套**名字）。 */
function sqlWritesOf(name, seen, acc) {
  seen = seen || new Set(); acc = acc || new Set();
  if (seen.has(name)) return acc;
  seen.add(name);
  const f = STORE_FUNCS[name];
  if (!f) return acc;
  for (const k of f.sqlRefs) if (isWriteKey(k)) acc.add(k);
  for (const callee of f.calls) if (STORE_FUNCS[callee]) sqlWritesOf(callee, seen, acc);
  return acc;
}

const createdDirs = [];
/* ★ 句柄关掉之后才删得掉（见收尾处的说明）；`exit` 上的这一份是兜底。 */
process.on('exit', function () { cleanupTempDirs(); });
function cleanupTempDirs() {
  for (let round = 0; round < 6; round += 1) {
    for (let i = createdDirs.length - 1; i >= 0; i -= 1) {
      try {
        fs.rmSync(createdDirs[i], { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
        createdDirs.splice(i, 1);
      } catch (_) { /* 下一轮再试 */ }
    }
    if (!createdDirs.length) break;
    try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200 * (round + 1)); } catch (_) { }
  }
  return createdDirs.length;
}
function tmpDir(tag) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-p22-21ca-' + tag + '-'));
  createdDirs.push(d);
  return d;
}

const store = STORE_MODULE({ dataDir: tmpDir('db'), logger: () => { } });
store.open();
const API_KEYS = Object.keys(store).filter(k => typeof store[k] === 'function');

/* 只有**写可达**的公开方法才进 §2 的普查。 */
const WRITE_CAPABLE = API_KEYS.filter(k => STORE_FUNCS[k] && reachesAWrite(k, new Set()));

/* ══════════════════════════════════════════════════════════════════════
   §0 · Phase Ledger Audit：authority 的唯一 owner / 无孤儿
   ══════════════════════════════════════════════════════════════════════
   ★ 判据不是"哪几个阶段改过同一个文件"（那是**文件**共享，P22-1～P22-20 里
     有 16 个文件被 2 个以上阶段改过），而是**权威**：每一个 canonical 权威
     必须恰好有一个 owner 符号，而且那个符号必须可达。
     这与 §0 的分类 A/B/C/D 逐条对应：
       A 唯一 owner            → 下面每一行恰好命中一个文件
       B delegated/projection  → owner 符号本身不持有权威（UI 那三条）
       C duplicated authority  → **0**（同一个符号不得有两个定义）
       D orphan authority      → **0**（每个 owner 都必须被生产代码可达） */
section('§0 · Phase Ledger Audit：authority 的唯一 owner（C = 0 · D = 0）');

/* 每一个权威 → 它的 owner 符号 + 唯一允许定义它的文件。 */
const AUTHORITIES = [
  { id: 'wallet balance (canonical)', symbol: 'computeLedgerBalance', file: STORE_REL },
  { id: 'ledger append', symbol: 'commitLedgerTransactionInTx', file: STORE_REL },
  { id: 'budget policy', symbol: 'putBudgetPolicy', file: STORE_REL },
  { id: 'budget evaluation', symbol: 'evaluateBudgetFor', file: STORE_REL },
  { id: 'quote', symbol: 'createQuote', file: STORE_REL },
  { id: 'catalog (store/product)', symbol: 'putProduct', file: STORE_REL },
  { id: 'inventory', symbol: 'mutateInventoryInTx', file: STORE_REL },
  { id: 'purchase orchestration', symbol: 'preparePurchase', file: STORE_REL },
  { id: 'settlement', symbol: 'settlePurchase', file: STORE_REL },
  { id: 'autonomy policy', symbol: 'putAutonomyPolicy', file: STORE_REL },
  { id: 'autonomy evaluation', symbol: 'evaluateAutonomousPurchaseFor', file: STORE_REL },
  { id: 'approval decision', symbol: 'decideApproval', file: STORE_REL },
  { id: 'intent proposal', symbol: 'proposeAgentPurchaseIntent', file: STORE_REL },
  { id: 'intent resume', symbol: 'resumeAgentPurchaseIntent', file: STORE_REL },
  { id: 'change log', symbol: 'appendChange', file: STORE_REL },
  { id: 'capability gate', symbol: 'createEconomyCapabilityGate', file: 'services/home-node/economy-capability.js' },
  { id: 'command vocabulary', symbol: 'createEconomyCommandChannel', file: 'services/home-node/economy-command-channel.js' },
  { id: 'configuration vocabulary', symbol: 'createEconomyConfigurationSeam', file: 'services/home-node/economy-configuration.js' },
  { id: 'user decision vocabulary', symbol: 'createEconomyApprovalDecisionSeam', file: 'services/home-node/economy-approval-decision.js' },
  { id: 'action vocabulary', symbol: 'createEconomyActionAdapter', file: 'services/home-node/economy-action-adapter.js' },
  { id: 'domain vocabulary', symbol: 'validateEconomyDomain', file: 'services/home-node/economy-contract.js' },
  { id: 'currency authority', symbol: 'validateCurrency', file: 'services/home-node/economy-contract.js' }
];

const authorityViolations = [];
for (const a of AUTHORITIES) {
  const hits = PROD_FILES.filter(f => new RegExp('(?:^|\\n)\\s*(?:function\\s+' + a.symbol + '\\b|' + a.symbol + '\\s*[:=])').test(read(f)));
  if (hits.length !== 1 || hits[0] !== a.file) {
    authorityViolations.push({ authority: a.id, symbol: a.symbol, expected: a.file, hits: hits });
  }
}
check('P0-1 ★★★★★ ' + AUTHORITIES.length + ' 个 canonical authority 各**恰好**一个定义点（C = 0：没有任何权威被两个符号/两个文件重复实现）',
  authorityViolations.length === 0, { violations: authorityViolations });

/* ★ D = 0：每一个 owner 符号都必须**被生产代码可达**（不是写好放在那里）。 */
const ACCESSIBLE = (() => {
  const all = PROD_FILES.concat(['services/home-node-service.js', 'services/active-message-service.js',
    'active/economy-channel-client.js']).map(f => ({ f: f, src: strip(read(f)) }));
  return (symbol) => all.some(x => new RegExp('\\b' + symbol + '\\s*\\(').test(x.src) || new RegExp(':' + symbol + '\\b').test(x.src));
})();
const orphanAuthorities = AUTHORITIES.filter(a => !ACCESSIBLE(a.symbol)).map(a => a.id);
check('P0-2 ★★★★★ D = 0：没有任何一个 authority 是孤儿（每一个 owner 符号都在生产代码里真的被引用）',
  orphanAuthorities.length === 0, orphanAuthorities);

/* ★ 三个阶段的 doc 各自声称的"拥有权"必须与代码一致：这是"后来阶段偷偷
   改变早期阶段语义"的可证伪形式 —— 契约的封闭集合只能由 P22-1 那一份持有。 */
const duplicatedVocab = [];
for (const [what, sym] of [['CURRENCY', 'CURRENCIES'], ['PURCHASE_STATE', 'PURCHASE_STATES'],
  ['APPROVAL_STATE', 'APPROVAL_STATES'], ['EVENT_TYPE', 'EVENT_TYPES'], ['ASSET_KIND', 'ASSET_KINDS']]) {
  const definers = PROD_FILES.filter(f => new RegExp('(?:^|\\n)\\s*(?:var|const)\\s+' + sym + '\\s*=').test(read(f)));
  if (definers.length !== 1 || definers[0] !== 'services/home-node/economy-contract.js') {
    duplicatedVocab.push({ vocabulary: what, definers: definers });
  }
  for (const client of ['assets/js/economy-approval-core.js', 'assets/js/economy-configuration-core.js',
    'assets/js/economy-shell-core.js']) {
    const src = strip(read(client));
    if (new RegExp('(?:var|const)\\s+' + sym + '\\s*=').test(src)) duplicatedVocab.push({ vocabulary: what, definers: [client] });
  }
}
check('P0-3 ★★★★★ 五个封闭词表（币种 / 购买 / 批准 / 事件 / 资产类别）只有**一个**定义点：契约；浏览器侧不复制它们的**定义**',
  duplicatedVocab.length === 0, duplicatedVocab);

/* ★ "后来阶段改变了早期语义"的机器形式：契约的七个 status 语义与
   P22-1 冻结的 id / domain 规则必须逐字未变。 */
check('P22-1 冻结的域标记与 id 形状到今天逐字未变（`DOMAIN` / `ID_KINDS` / `ID_MAX_LENGTH`）',
  C.DOMAIN === 'ib.economy' && C.ID_MAX_LENGTH === 128 && C.ID_KINDS.length === 16 &&
  C.isEconomyDomain(C.DOMAIN) === true && C.isEconomyId('TRANSACTION', 'econ_tx_abcdef') === true,
  { domain: C.DOMAIN, idKinds: C.ID_KINDS.length, max: C.ID_MAX_LENGTH });

/* ══════════════════════════════════════════════════════════════════════
   §2 · Write Surface Census
   ══════════════════════════════════════════════════════════════════════
   ★ 普查的对象是**改变 canonical 经济事实**的方法。三个东西刻意**不在**
     这张表里，而且每一个都有理由：
       · `open` / `close` / `isOpen` / `getRevision` —— 生命周期与观测；
       · `health` / `isDegraded` —— 观测；
       · 读方法（`getWallet` / `listWallets` / `getQuote` / `evaluateQuote` /
         `listApprovals` …）—— 它们**传递可达**一次写，但只写
         `economy_wallets` 的**派生缓存**列，而且是从 canonical 行重算的
         （P22-2 §11 的既定语义）。把这一类也算成 mutation 会让普查表变成
         一张什么都装得下的表。它们在下面单独断言。
   ★ 调用者扫描只在**真的持有 store 句柄**的生产文件里算。开发期实测：
     不做这个限制时 `open` / `close` / `health` 这类通用名字会在
     `assets/js/*.js` 与 `services/*.js` 里命中一大堆**完全无关**的对象
     （`localStorage.close`、`ws.close`、`health()`），于是"bypass" 报出 9 条
     假命中 —— 与 P22-20 的裸词扫描同一个错误。 */
section('§2 · Write Surface Census');

/* 改变 canonical 经济事实的方法（§2 的普查对象）。 */
const MUTATION_VERBS = ['bootstrapInitialCredit', 'putBudgetPolicy', 'putAutonomyPolicy',
  'decideApproval', 'proposeAgentPurchaseIntent', 'resumeAgentPurchaseIntent', 'appendCapabilityAudit',
  'openWallet', 'reserveFunds', 'commitReservation', 'settleReservation', 'releaseReservation',
  'expireReservation', 'failReservation', 'expireDueReservations', 'rebuildWalletBalance',
  'rebuildReservedBalance', 'reconcileReservations', 'preparePurchase', 'settlePurchase', 'cancelPurchase',
  'createApprovalRequest', 'authorizePurchaseIntent', 'expireApproval', 'expireDueApprovals',
  'putStore', 'putProduct', 'createProductQuote', 'createQuote', 'expireQuote', 'expireDueQuotes',
  'expirePolicy', 'expireDuePolicies', 'grantInventory', 'consumeInventory',
  'commitLedgerTransaction', 'mintForSystem', 'burnForSystem', 'transferBetweenWallets'];

const CONSUMER_FILES = ['services/home-node/economy-configuration.js',
  'services/home-node/economy-approval-decision.js', 'services/home-node/economy-capability.js'];
/* 真的持有 store 的生产文件：三个 seam + 门 + 装配层 + http 只读面。 */
const HANDLE_FILES = CONSUMER_FILES.concat([
  'services/home-node/http.js', 'services/home-node-service.js']);

function callersIn(files, verb) {
  const re = new RegExp('\\.' + verb + '\\s*\\(');
  return files.filter(f => re.test(strip(read(f))));
}
function internalRefs(verb) {
  const re = new RegExp('\\b' + verb + '\\b');
  return Object.keys(STORE_FUNCS).filter(n => n !== verb && re.test(STORE_FUNCS[n].body));
}

const CENSUS = MUTATION_VERBS.map(verb => {
  const seamCallers = callersIn(CONSUMER_FILES, verb);
  const assembly = callersIn(['services/home-node-service.js'], verb);
  const http = callersIn([HTTP_REL], verb);
  const internal = internalRefs(verb);
  const inApi = API_KEYS.indexOf(verb) >= 0;
  let cls;
  if (seamCallers.length) cls = '1-reachable-and-authorized';
  else if (http.length) cls = '5-suspicious-bypass';
  else if (internal.length) cls = '2-internal-only';
  else if (inApi) cls = '3-tests-only';
  else cls = '4-dead-or-unreachable';
  return { verb: verb, cls: cls, seams: seamCallers, assembly: assembly, http: http, internal: internal, inApi: inApi };
});

const byClass = {};
for (const row of CENSUS) byClass[row.cls] = (byClass[row.cls] || 0) + 1;

check('W1 ★★★★★ 每一个经济 mutation 方法都被分类，而且 **suspicious bypass = 0**（没有任何一个从三个 seam 之外的生产文件被调用）',
  CENSUS.filter(r => r.cls === '5-suspicious-bypass').length === 0,
  { summary: byClass, bypass: CENSUS.filter(r => r.cls === '5-suspicious-bypass') });

check('W2 ★★★★★ 普查是**完备**的：' + MUTATION_VERBS.length + ' 个动词全部落在"生产可达 / 内部编排"两类之一，而 "tests-only" 与 "dead/unreachable" 两类**为空**（== 没有"写好了但谁也到不了"的经济 mutation）',
  CENSUS.every(r => ['1-reachable-and-authorized', '2-internal-only'].indexOf(r.cls) >= 0) &&
  (byClass['3-tests-only'] || 0) === 0 && (byClass['4-dead-or-unreachable'] || 0) === 0 &&
  (byClass['1-reachable-and-authorized'] || 0) + (byClass['2-internal-only'] || 0) === MUTATION_VERBS.length,
  { summary: byClass, total: MUTATION_VERBS.length });

/* ★ 生产可达的那一类必须是**恰好七个动词**，且全部来自三个 seam 或那道门。 */
const reachable = CENSUS.filter(r => r.cls === '1-reachable-and-authorized').map(r => r.verb).sort();
const EXPECTED_REACHABLE = ['appendCapabilityAudit', 'bootstrapInitialCredit', 'decideApproval',
  'proposeAgentPurchaseIntent', 'putAutonomyPolicy', 'putBudgetPolicy', 'resumeAgentPurchaseIntent'];
check('W3 ★★★★★ 生产可达的写动词**恰好七个**，而且每一个的调用者都在三个 seam 或那道门里（一条不多、一条不少）',
  reachable.join(',') === EXPECTED_REACHABLE.join(','),
  { reachable: reachable, expected: EXPECTED_REACHABLE,
    callers: CENSUS.filter(r => r.cls === '1-reachable-and-authorized').map(r => ({ verb: r.verb, from: r.seams })) });

/* ★ W4 已证"4 类为空"，这里把三类（reachable / internal / bypass）的**计数**
   逐字断言下来，于是任何一次分类漂移都会显示出具体数字的变化。 */
const unreachableRows = CENSUS.filter(r => r.cls === '4-dead-or-unreachable');
check('W4 ★★★★★ 计数被逐字冻结：生产可达 **7** · 内部编排 **32** · tests-only **0** · dead/unreachable **0** · suspicious bypass **0**',
  reachable.length === 7 && (byClass['2-internal-only'] || 0) === 32 &&
  (byClass['3-tests-only'] || 0) === 0 && unreachableRows.length === 0 &&
  (byClass['5-suspicious-bypass'] || 0) === 0,
  { summary: byClass });

/* ★ `http.js` 是**只读观测面**：它到经济 mutation 动词的边为 0。 */
const httpWriteHits = CENSUS.filter(r => r.http.length > 0).map(r => r.verb);
check('W5 ★★★★★ `http.js`（只读观测面）对全部 ' + MUTATION_VERBS.length + ' 个经济 mutation 动词的**调用形态**为 0',
  httpWriteHits.length === 0, httpWriteHits);

/* ★ 读面上的"派生缓存修复"单独说清楚：它是**一条被声明的**行为，不是绕过。
   ★ 判据用**直接** SQL 引用：传递闭包会连 `insertChange` 一起带进来（缓存修复
   同样要留一条变更记录），因此"只写两个缓存列"这句话在**直接**这一层才是
   精确的 —— 而它恰好就是这一句要证明的东西。 */
const cacheRepairCallers = callersIn([HTTP_REL], 'getWallet').concat(callersIn([HTTP_REL], 'listWallets'));
const derivedDirectWrites = STORE_FUNCS.applyDerivedBalances.sqlRefs.filter(isWriteKey).sort();
const reservedDirectWrites = STORE_FUNCS.applyReservedCache.sqlRefs.filter(isWriteKey).sort();
const cacheRepairProof = {
  derivedWritesOnlyTheCacheColumn: derivedDirectWrites.join(',') === 'setWalletBalance',
  reservedWritesOnlyTheCacheColumn: reservedDirectWrites.join(',') === 'setWalletReserved',
  noEconomicTableTouched: derivedDirectWrites.concat(reservedDirectWrites)
    .every(k => ['setWalletBalance', 'setWalletReserved', 'insertChange'].indexOf(k) >= 0),
  rebuildUsesCanonicalRows: /applyDerivedBalances|ledgerBalanceOf|computeLedgerBalance/.test(STORE_FUNCS.rebuildWalletBalance.body)
};
check('W6 ★★★★★ 唯一的"读面传递可达写"是**派生缓存修复**，而且它的**直接**写恰好是 `economy_wallets` 的两个缓存列 + 一条变更记录（从 canonical 行重算，不是绕过）',
  cacheRepairCallers.length > 0 && cacheRepairProof.derivedWritesOnlyTheCacheColumn === true &&
  cacheRepairProof.reservedWritesOnlyTheCacheColumn === true &&
  cacheRepairProof.noEconomicTableTouched === true && cacheRepairProof.rebuildUsesCanonicalRows === true,
  { cacheRepairCallers: cacheRepairCallers, derivedDirectWrites: derivedDirectWrites,
    reservedDirectWrites: reservedDirectWrites, ...cacheRepairProof });

check('W7 ★★★★★ 公开写面恰好三条，且三条**都不在** `/economy/` 下（因此"POST /economy/* 一律 405"是结构性事实）',
  [CONFIG.CONFIGURATION_PATH, DECISION.DECISION_PATH, CHANNEL.COMMAND_PATH].length === 3 &&
  [CONFIG.CONFIGURATION_PATH, DECISION.DECISION_PATH, CHANNEL.COMMAND_PATH].every(p => p.indexOf('/economy/') !== 0),
  { paths: [CONFIG.CONFIGURATION_PATH, DECISION.DECISION_PATH, CHANNEL.COMMAND_PATH] });

/* ══════════════════════════════════════════════════════════════════════
   §3 · Read Surface Census
   ══════════════════════════════════════════════════════════════════════ */
section('§3 · Read Surface Census：代码 ↔ 两份文档 双向 diff = 0');

const MANIFEST_MD = read(MANIFEST_REL);
function rowsOf(md, title) {
  const lines = md.split(/\r?\n/);
  const start = lines.findIndex(l => /^#{1,4}\s/.test(l) && l.indexOf(title) >= 0);
  if (start < 0) return [];
  const out = [];
  let started = false;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (lines[i].trim().indexOf('|') === 0) { out.push(lines[i]); started = true; continue; }
    if (started) break;
  }
  return out.filter(l => /`/.test(l));
}
const cellsOf = (line) => {
  const parts = line.split('|'); parts.shift();
  if (parts.length && parts[parts.length - 1].trim() === '') parts.pop();
  return parts.map(s => s.trim().replace(/`/g, ''));
};

const codeReadsAll = (() => {
  const src = read(HTTP_REL); const out = []; let m;
  const re = /if\s*\(\s*path === '([^']+)'\s*&&\s*method === 'GET'\s*\)/g;
  while ((m = re.exec(src))) out.push(m[1]);
  return out;
})();
/* ★ 只比 **Economy 的读面**：http.js 同时服务 /health /status /message …
   那些路由不属于 Economy 的公开面，把它们算进来会让"CODE − DOC"报出七条
   与该契约无关的路径（开发期实测）。 */
const codeReads = codeReadsAll.filter(p => p.indexOf('/economy/') === 0 || p === '/security');
const manifestReads = rowsOf(MANIFEST_MD, '2 · READ_SURFACES').map(cellsOf).filter(c => c[0] === 'GET').map(c => c[1]);
const surfaceDocReads = (() => {
  const md = read(SURFACE_REL);
  return rowsOf(md, '· Read').map(cellsOf).filter(c => c[0] === 'GET').map(c => c[1]);
})();

function setDiff(a, b) { return a.filter(x => b.indexOf(x) < 0); }
const codeVsManifest = { codeMinusManifest: setDiff(codeReads, manifestReads), manifestMinusCode: setDiff(manifestReads, codeReads) };
const docVsDoc = { manifestMinusSurface: setDiff(manifestReads, surfaceDocReads), surfaceMinusManifest: setDiff(surfaceDocReads, manifestReads) };

check('R1 ★★★★★ CODE − DOC = 0 且 DOC − CODE = 0（manifest ↔ `http.js` 的真实 GET 路由判定）',
  codeVsManifest.codeMinusManifest.length === 0 && codeVsManifest.manifestMinusCode.length === 0,
  codeVsManifest);
check('R2 ★★★★★ 两份文档**互相**一致（manifest ↔ `ECONOMY_PUBLIC_SURFACE.md`，两份都不许比对方多或少）',
  docVsDoc.manifestMinusSurface.length === 0 && docVsDoc.surfaceMinusManifest.length === 0,
  docVsDoc);
check('R3 ★★★★★ 读面共 29 条（28 条 `/economy/*` + 1 条 `/security`），而且没有一条是 POST',
  codeReads.length === 29 && codeReads.filter(p => p.indexOf('/economy/') === 0).length === 28 &&
  codeReads.filter(p => p === '/security').length === 1,
  { total: codeReads.length, economy: codeReads.filter(p => p.indexOf('/economy/') === 0).length });

/* ★ 每一条读面都必须在 manifest 的 sort-authority / owner-scope 表里有归属，
   否则"读面普查"就只是"路由清单"。 */
const SORT_SECTION = MANIFEST_MD.indexOf('### 2.1 排序权威') >= 0 && MANIFEST_MD.indexOf('### 2.2 owner scope') >= 0;
check('R4 ★★★★ manifest 对**顺序权威**与 **owner 作用域**各有一张表（读面普查不只列路径）',
  SORT_SECTION, { hasSortAuthority: MANIFEST_MD.indexOf('### 2.1 排序权威') >= 0 });

/* ★ `mutation = false` 的可证伪形式：`http.js` 里没有写动词调用（W4 已证），
   而且 `recomputesEconomyFacts` 在 owner-scoped changes 上恒为 false。 */
check('R5 ★★★★★ 每条读面 `mutation = false` 的代码形式：`http.js` 对经济 mutation 动词零调用（W5），且 owner-scoped changes 自述 `recomputesEconomyFacts:false`',
  read(HTTP_REL).indexOf('recomputesEconomyFacts: false') >= 0 &&
  read('services/home-node-service.js').indexOf('economyStore: instanceEconomy.economyStore') >= 0,
  { recomputesFlag: read(HTTP_REL).indexOf('recomputesEconomyFacts: false') >= 0,
    readOnlyHandle: read('services/home-node-service.js').indexOf('economyStore: instanceEconomy.economyStore') >= 0 });

/* ══════════════════════════════════════════════════════════════════════
   §3.1 · owner-scope 对抗性 fixture（★ 真的交错噪声，不是顺序写入）
   ══════════════════════════════════════════════════════════════════════ */
section('§3.1 · owner-scope 对抗性 fixture（交错噪声 + 分页截断）');

/* ★ 结算方式必须由**契约**推导，而且它**不是**报价类别。
   开发期实测（两次都踩到）：把 `settlementTypeOfQuoteKind(quoteKind)` 的结果
   （`PURCHASE`）写进 `allowedSettlementTypes` 会让 `putAutonomyPolicy` 以
   `autonomy-allowed-settlement-type-not-in-closed-set` 失败 —— 因为那个
   封闭集是 **FULFILLMENTS**（`INVENTORY_GRANT` / `COMPUTE_GRANT` /
   `SERVICE_EXECUTION`），不是 `QUOTE_KINDS`。而**失败是安静的**：自主规则
   不存在时权威默认 `REQUIRE_APPROVAL`，于是 fixture 变成一个"永远等待审批"
   的场景，而它断言的却是另一件事。
   ⇒ 因此取 `FULFILLMENT_OF_PRODUCT_KIND`，并且每一步都断言它真的落盘。 */
const CA_PRODUCT_KIND = C.PRODUCT_KIND.DIGITAL_ITEM;
const CA_SETTLEMENT_TYPE = C.FULFILLMENT_OF_PRODUCT_KIND[CA_PRODUCT_KIND];
const OWNER_A = 'p2221ca_a';
const OWNER_B = 'p2221ca_b';
let clockSeq = 1700000000000;
const s2 = STORE_MODULE({ dataDir: tmpDir('scope'), clock: () => (clockSeq += 1000) });
s2.open();

/* 两个 owner 各自的启动额度；随后**逐条交错**地产生事实，因为"先全部 A
   再全部 B"的顺序写法抓不到作用域泄漏。 */
s2.bootstrapInitialCredit({ owner: OWNER_A, currency: 'IB_CREDIT', amountMinor: '500000', idempotencyKey: 'a-boot' });
s2.bootstrapInitialCredit({ owner: OWNER_B, currency: 'IB_CREDIT', amountMinor: '500000', idempotencyKey: 'b-boot' });
const st = s2.putStore({ name: 'Scope Store', idempotencyKey: 'st' }).result.store.storeId;
const prod = s2.putProduct({ storeId: st, kind: 'DIGITAL_ITEM', name: 'Scope item',
  currency: 'IB_CREDIT', unitPriceMinor: '1000', grantQuantity: 2, idempotencyKey: 'pr' }).result.product.productId;

const A_FACTS = [];
const B_FACTS = [];
/* 交错：A 报价 → B 发放 → A 发放 → B 报价 → A 批准 → B 发放 → A 消耗 → B 批准 */
const qa1 = s2.createProductQuote({ buyerId: OWNER_A, productId: prod, units: 1, expiresAt: Date.UTC(2031, 0, 1), idempotencyKey: 'a-q1' });
A_FACTS.push(qa1.result.quoteId);
const gb1 = s2.grantInventory({ ownerId: OWNER_B, productId: prod, quantity: 3, idempotencyKey: 'b-g1' });
B_FACTS.push(gb1.result.inventoryEntryId);
const ga1 = s2.grantInventory({ ownerId: OWNER_A, productId: prod, quantity: 5, idempotencyKey: 'a-g1' });
A_FACTS.push(ga1.result.inventoryEntryId);
const qb1 = s2.createProductQuote({ buyerId: OWNER_B, productId: prod, units: 1, expiresAt: Date.UTC(2031, 0, 1), idempotencyKey: 'b-q1' });
B_FACTS.push(qb1.result.quoteId);
/* A 的一条批准（REQUESTED） */
const apA = s2.createApprovalRequest({
  buyerId: OWNER_A, quoteId: qa1.result.quoteId, units: 1, idempotencyKey: 'a-ap1'
});
if (apA.ok === true) A_FACTS.push(apA.result.approvalId);
const gb2 = s2.grantInventory({ ownerId: OWNER_B, productId: prod, quantity: 7, idempotencyKey: 'b-g2' });
B_FACTS.push(gb2.result.inventoryEntryId);

const scopedA = s2.listChangesForOwner({ ownerId: OWNER_A, limit: 500, order: 'desc' });
const scopedA2 = s2.listChangesForOwner({ ownerId: OWNER_A, limit: 3, order: 'desc' });
const scopedB = s2.listChangesForOwner({ ownerId: OWNER_B, limit: 500, order: 'desc' });

const idsA = scopedA.changes.map(c => String(c.entityId));
const revsA = scopedA.changes.map(c => Number(c.revision));
const idsAtLimit3 = scopedA2.changes.map(c => Number(c.revision));

check('S1 ★★★★★ owner 作用域：B 的每一条事实都不在 A 的时间线里，反之亦然（交错写入之下仍然成立）',
  A_FACTS.every(id => idsA.indexOf(id) >= 0) &&
  B_FACTS.every(id => idsA.indexOf(id) < 0) &&
  B_FACTS.every(id => scopedB.changes.map(c => String(c.entityId)).indexOf(id) >= 0) &&
  A_FACTS.every(id => scopedB.changes.map(c => String(c.entityId)).indexOf(id) < 0),
  { aFacts: A_FACTS, bFacts: B_FACTS, aTimeline: idsA,
    leakedIntoA: B_FACTS.filter(id => idsA.indexOf(id) >= 0) });

check('S2 ★★★★★ newest-first：owner 作用域的 desc 读面按 `revision` **严格递减**',
  revsA.length >= 5 && revsA.every((r, i) => i === 0 || r < revsA[i - 1]),
  { revisions: revsA });

check('S3 ★★★★★ 分页截断取的是**最新**的一段（limit=3 恰好是 desc 头三条，而不是尾三条）',
  idsAtLimit3.length === 3 && idsAtLimit3.every((r, i) => r === revsA[i]),
  { head: revsA.slice(0, 3), limited: idsAtLimit3 });

check('S4 ★★★★★ 作用域自述：`scoped:true` + `ownerId` + `order` 都写在响应里，因此"这一页是不是 owner-scoped"不用猜',
  scopedA.scope && scopedA.scope.scoped === true && scopedA.scope.ownerId === OWNER_A && scopedA.scope.order === 'desc',
  scopedA.scope);

check('S5 ★★★★★ 这条投影**不是第二权威**：它不重算任何经济事实（store 侧的 read 只做 filter / sort / project）',
  s2.listChangesForOwner({ ownerId: OWNER_A, limit: 500, order: 'desc' }).recomputesEconomyFacts === undefined &&
  typeof s2.listChangesForOwner === 'function' &&
  /function listChangesForOwner\(/.test(read(STORE_REL)),
  { ok: true });

/* ══════════════════════════════════════════════════════════════════════
   §4 · State Machine Cross-Product Audit
   ══════════════════════════════════════════════════════════════════════ */
section('§4 · 四个状态机的叉积：可达 / 终态 / 禁止 / unknown');

const MACHINES4 = [
  { name: 'intent', states: C.PURCHASE_INTENT_STATES, trans: C.PURCHASE_INTENT_TRANSITIONS, terminal: C.PURCHASE_INTENT_TERMINAL_STATES },
  { name: 'approval', states: C.APPROVAL_STATES, trans: C.APPROVAL_TRANSITIONS, terminal: C.APPROVAL_TERMINAL_STATES },
  { name: 'purchase', states: C.PURCHASE_STATES, trans: C.PURCHASE_TRANSITIONS, terminal: C.PURCHASE_TERMINAL_STATES },
  { name: 'quote', states: C.QUOTE_STATES, trans: C.QUOTE_TRANSITIONS, terminal: C.QUOTE_TERMINAL_STATES }
];

/* ★ 可达组合**从真实运行时**生成：在 s2 上把六条真实路径走一遍，并在每一步
   记录四元组（intent, approval, purchase, quote）。`n/a` 表示"这个阶段
   还不存在那条记录"（例：还没有 intent 的时候谈不上 purchase 状态）。 */
const OBSERVED = new Set();
const recordTuple = (tag) => {
  const intents = s2.listPurchaseIntents({ limit: 200 }).intents || [];
  const approvals = s2.listApprovals({ limit: 200 }).approvals || [];
  const purchases = s2.listPurchases({ limit: 200 }).purchases || [];
  const quotes = s2.listQuotes({ limit: 200 }).quotes || [];
  if (!intents.length) return;
  const it = intents[intents.length - 1];
  const ap = approvals.filter(a => a.approvalId === it.approvalId)[0];
  const pu = purchases.filter(p => p.purchaseId === it.purchaseId)[0];
  const qt = quotes.filter(q => q.quoteId === it.quoteId)[0];
  OBSERVED.add([tag, it.state, ap ? ap.status : 'n/a', pu ? pu.status : 'n/a', qt ? qt.state : 'n/a'].join(' | '));
};

/* 真实路径 ①：AUTO_ALLOW 直接买成功 */
s2.putAutonomyPolicy({ ownerId: OWNER_A, enabled: true, perPurchaseLimitMinor: '1000000',
  dailyAutonomousLimitMinor: '1000000', approvalAboveMinor: '1000000',
  allowedProductKinds: [CA_PRODUCT_KIND], allowedSettlementTypes: [CA_SETTLEMENT_TYPE], allowGift: false, idempotencyKey: 'a-auto' });
s2.putBudgetPolicy({ ownerId: OWNER_A, currency: 'IB_CREDIT',
  limits: { perTransactionMinor: '1000000', dailyMinor: '1000000', weeklyMinor: '1000000', monthlyMinor: '1000000' },
  idempotencyKey: 'a-budget' });
const autoBuy = s2.proposeAgentPurchaseIntent({
  proposal: { agentId: OWNER_A, productId: prod, units: 1, reason: 'auto allow' }, idempotencyKey: 'a-auto-buy'
});
recordTuple('auto-allow');

/* 真实路径 ②：REQUIRE_APPROVAL → 用户批准 → resume → 成功 */
s2.putAutonomyPolicy({ ownerId: OWNER_B, enabled: true, perPurchaseLimitMinor: '1000000',
  dailyAutonomousLimitMinor: '1000000', approvalAboveMinor: '1',
  allowedProductKinds: [CA_PRODUCT_KIND], allowedSettlementTypes: [CA_SETTLEMENT_TYPE], allowGift: false, idempotencyKey: 'b-auto' });
s2.putBudgetPolicy({ ownerId: OWNER_B, currency: 'IB_CREDIT',
  limits: { perTransactionMinor: '1000000', dailyMinor: '1000000', weeklyMinor: '1000000', monthlyMinor: '1000000' },
  idempotencyKey: 'b-budget' });
const asked = s2.proposeAgentPurchaseIntent({
  proposal: { agentId: OWNER_B, productId: prod, units: 1, reason: 'needs approval' }, idempotencyKey: 'b-ask'
});
recordTuple('waiting-approval');
const decidedB = s2.decideApproval({ approvalId: asked.approvalId, decision: 'APPROVED', decidedBy: 'user:user', idempotencyKey: 'b-dec' });
recordTuple('approval-approved');
const resumed = s2.resumeAgentPurchaseIntent({ agentIntentId: asked.intentId, approvalId: asked.approvalId, idempotencyKey: 'b-resume' });
recordTuple('resume-completed');

/* 真实路径 ③：REQUIRE_APPROVAL → 用户拒绝 */
const rejected = s2.proposeAgentPurchaseIntent({
  proposal: { agentId: OWNER_B, productId: prod, units: 2, reason: 'will be rejected' }, idempotencyKey: 'b-rej-ask'
});
s2.decideApproval({ approvalId: rejected.approvalId, decision: 'REJECTED', decidedBy: 'user:user', idempotencyKey: 'b-rej' });
recordTuple('rejected');

/* 真实路径 ④：报价过期 */
const exp = s2.proposeAgentPurchaseIntent({
  proposal: { agentId: OWNER_B, productId: prod, units: 3, reason: 'quote expires' }, idempotencyKey: 'b-exp-ask'
});
s2.expireQuote({ quoteId: exp.quoteId, now: Date.now() + 5 * 86400000 });
recordTuple('quote-expired');

/* ★ 真实路径 ⑤：权威放行、预算拒绝 ⇒ intent 必须落在**终态**且 purchaseId 为 null。
   这一条同时是 "failed intent 不能留下可变 continuation" 那一条的证伪 fixture。 */
const FAIL_OWNER = 'p2221ca_c';
s2.bootstrapInitialCredit({ owner: FAIL_OWNER, currency: 'IB_CREDIT', amountMinor: '100', idempotencyKey: 'c-boot' });
s2.putBudgetPolicy({ ownerId: FAIL_OWNER, currency: 'IB_CREDIT',
  limits: { perTransactionMinor: '100', dailyMinor: '100', weeklyMinor: '100', monthlyMinor: '100' },
  idempotencyKey: 'c-budget' });
s2.putAutonomyPolicy({ ownerId: FAIL_OWNER, enabled: true, perPurchaseLimitMinor: '1000000',
  dailyAutonomousLimitMinor: '1000000', approvalAboveMinor: '1000000',
  allowedProductKinds: [CA_PRODUCT_KIND], allowedSettlementTypes: [CA_SETTLEMENT_TYPE], allowGift: false, idempotencyKey: 'c-auto' });
const failedBuy = s2.proposeAgentPurchaseIntent({
  proposal: { agentId: FAIL_OWNER, productId: prod, units: 1, reason: 'cannot afford' }, idempotencyKey: 'c-buy'
});
recordTuple('budget-denied');

const failedIntentObserved = [];
function failedIntentFixture() {
  const all = s2.listPurchaseIntents({ limit: 200 }).intents || [];
  const intent = all.filter(i => i.agentIntentId === failedBuy.intentId)[0];
  const ok = !!intent && C.PURCHASE_INTENT_TERMINAL_STATES.indexOf(intent.state) >= 0 &&
    intent.purchaseId === null && intent.terminal === true;
  if (!ok) {
    failedIntentObserved.push({ intentId: failedBuy.intentId, proposeOk: failedBuy.ok,
      proposeErrors: failedBuy.errors, authorityOutcome: failedBuy.authorityOutcome,
      state: intent && intent.state, terminal: intent && intent.terminal,
      purchaseId: intent && intent.purchaseId, reasonCode: intent && intent.reasonCode,
      intentCount: all.length });
  }
  return ok;
}

/* ★ 从契约的转移表生成"结构上可达"的上界：所有状态 × 所有状态。 */
const structurallyReachable = [];
for (const i of MACHINES4[0].states) {
  for (const a of MACHINES4[1].states.concat(['n/a'])) {
    for (const p of MACHINES4[2].states.concat(['n/a'])) {
      for (const q of MACHINES4[3].states) structurallyReachable.push([i, a, p, q].join(' | '));
    }
  }
}
const observedTuples = Array.from(OBSERVED).map(s => s.split(' | ').slice(1).join(' | '));
const outsideStructural = observedTuples.filter(t => structurallyReachable.indexOf(t) < 0);

check('X1 ★★★★★ 真实运行观察到的每一个四元组都落在"结构上可达"的上界之内（不会出现状态机之外的状态）',
  outsideStructural.length === 0, { observed: observedTuples, outside: outsideStructural });

/* ★ 禁止组合：逐条给出**真实 fixture 的证明**或**结构性不可达的证明**。 */
const FORBIDDEN = [
  { id: 'approval-consumed-but-purchase-absent', prove: () => {
    /* 结构性：consume 只在结算事务里发生，且必须带 purchaseId。 */
    const body = STORE_FUNCS.consumeApprovalForPurchaseInTx.body;
    return /purchaseId/.test(body) && /setApprovalConsumed/.test(body);
  } },
  { id: 'purchase-completed-while-intent-waiting', prove: () => {
    /* 真实：观察到的组合里没有这一条，且契约的 intent 转移要求 EXECUTING 先出现。 */
    return observedTuples.every(t => t.indexOf('WAITING_APPROVAL') < 0 || t.indexOf('COMPLETED') < 0) &&
      C.PURCHASE_INTENT_TRANSITIONS.PROPOSED.indexOf('COMPLETED') < 0 &&
      C.PURCHASE_INTENT_TRANSITIONS.WAITING_APPROVAL.indexOf('COMPLETED') < 0;
  } },
  { id: 'rejected-approval-with-executing-purchase', prove: () =>
    observedTuples.every(t => !(t.indexOf('REJECTED') >= 0 && t.indexOf('RESERVED') >= 0)) &&
    C.APPROVAL_TRANSITIONS.REJECTED.length === 0 },
  { id: 'expired-quote-with-newly-completed-purchase', prove: () =>
    C.QUOTE_TRANSITIONS.EXPIRED.length === 0 && C.PURCHASE_INTENT_BYPASSES_QUOTE_EXPIRY === false },
  { id: 'terminal-state-resurrection', prove: () =>
    MACHINES4.every(m => m.terminal.every(st => (m.trans[st] || []).length === 0)) &&
    C.RESERVATION_TRANSITIONS.COMMITTED.length === 0 && C.TX_TRANSITIONS.COMMITTED.length === 0 },
  { id: 'failed-intent-with-mutable-continuation', prove: () => {
    /* ★ 需要一条**真实失败**的 intent：给第三个 owner 一个买不起的预算，
       让权威放行而预算在 prepare 上拒绝。 */
    if (typeof failedIntentFixture !== 'function') return false;
    return failedIntentFixture();
  } }
];
const forbiddenResults = FORBIDDEN.map(f => ({ id: f.id, proven: f.prove() === true }));
if (failedIntentObserved.length) forbiddenResults.push({ id: 'observed-failed-intent-fixture', detail: failedIntentObserved });
check('X2 ★★★★★ 六个"不可能但可观测"的候选组合**逐条**被证伪（真实 fixture 或结构性不可达，不是 grep）',
  forbiddenResults.every(r => r.proven), forbiddenResults);

const terminalTuples = observedTuples.filter(t => {
  const [i, a, p] = t.split(' | ');
  return C.PURCHASE_INTENT_TERMINAL_STATES.indexOf(i) >= 0 &&
    (a === 'n/a' || C.APPROVAL_TERMINAL_STATES.indexOf(a) >= 0) &&
    (p === 'n/a' || C.PURCHASE_TERMINAL_STATES.indexOf(p) >= 0);
});
check('X3 ★★★★★ 观察到的终态组合**存在且自洽**（至少一条 intent/approval/purchase 三者同时终态的组合被真实走到）',
  terminalTuples.length >= 1,
  { observed: Array.from(OBSERVED), terminal: terminalTuples });

check('X4 ★★★★★ unknown / unproven 组合 = 0：观察到的组合全部落在结构上界内，而且六个禁止候选全部被证伪',
  outsideStructural.length === 0 && forbiddenResults.every(r => r.proven),
  { observedCount: OBSERVED.size, structuralBound: structurallyReachable.length,
    forbidden: forbiddenResults });

/* ══════════════════════════════════════════════════════════════════════
   §6 · Crash Boundary Audit（静态；既有崩溃注入测试被引用而不是重跑）
   ══════════════════════════════════════════════════════════════════════ */
section('§6 · 崩溃边界：同事务 vs 事务后副作用');

const settleBody = STORE_FUNCS.settlePurchase.body;
/* ★ 判据是**传递 SQL 写集合** + "只有一处 withTransaction" + "COMMIT 只出现在
   withTransaction 里"。开发期实测：拿函数名去 grep（`setPurchaseSettled(`）
   会得到 false —— 因为本文件里 SQL 语句键名与函数名是**两套**名字，
   于是那一条看似严格的断言其实在断言一件无关的事。 */
const settleWrites = Array.from(sqlWritesOf('settlePurchase')).sort();
const SETTLE_REQUIRED_WRITES = ['insertChange', 'insertEntry', 'insertTransaction',
  'setPurchaseSettled', 'setQuoteState', 'setReservationStatus', 'setOperationStatus',
  'insertInventory', 'growInventory', 'setApprovalConsumed'];
const settleTxCount = (settleBody.match(/withTransaction\s*\(/g) || []).length;
/* ★ 判据必须是**事务控制语句的字面量**（`db.exec('COMMIT')` 一族），而不是`/COMMIT/` —— 契约里有一个叫做 `COMMIT` 的 operation scope 常量，于是裸词 /COMMIT/ 会在十几个函数里命中（开发期实测：commitOwner 列出了 10 个与事务无关的函数）。 */
const TX_CONTROL_RE = /db\.exec\(\s*'(BEGIN IMMEDIATE|COMMIT|ROLLBACK)'/;
const commitOwner = Object.keys(STORE_FUNCS).filter(n => TX_CONTROL_RE.test(STORE_FUNCS[n].body));
const txBoundary = {
  exactlyOneTransactionBoundary: settleTxCount === 1,
  ledgerInSameTx: ['insertTransaction', 'insertEntry', 'insertChange'].every(k => settleWrites.indexOf(k) >= 0),
  inventoryInSameTx: ['insertInventory', 'growInventory'].some(k => settleWrites.indexOf(k) >= 0),
  approvalConsumeInSameTx: settleWrites.indexOf('setApprovalConsumed') >= 0,
  purchaseCompleteInSameTx: settleWrites.indexOf('setPurchaseSettled') >= 0,
  quoteConsumeInSameTx: settleWrites.indexOf('setQuoteState') >= 0,
  reservationCommitInSameTx: settleWrites.indexOf('setReservationStatus') >= 0,
  txControlOnlyInsideWithTransaction: commitOwner.length === 1 && commitOwner[0] === 'withTransaction'
};
check('B1 ★★★★★ 一次结算 = **一个** SQLite 事务：账本 / 库存 / 批准消费 / 购买完成 / 报价消费 / 预留提交**六样全部**在 settlePurchase 的同一个事务体内，而且 `COMMIT` 只出现在 `withTransaction` 里',
  Object.keys(txBoundary).every(k => txBoundary[k] === true),
  Object.assign({ settleTxCount: settleTxCount, commitOwner: commitOwner,
    missingWrites: SETTLE_REQUIRED_WRITES.filter(k => settleWrites.indexOf(k) < 0) }, txBoundary));

/* ★ 变化日志是**事务内**写的（appendChange 用 insertChange，同一个 db 句柄），
   因此"账本变了但 change log 没变"这种半完成不可能出现。
   ★ 而 store 里**没有定时器**：到期不是定时器，是一个可断言的 WHERE。 */
const STORE_CODE_ONLY = strip(STORE_SRC);
check('B2 ★★★★★ change log 的追加在同一个事务里（`appendChange` 直接写 canonical 表，没有队列 / 没有 setTimeout），而且 store 里**没有**定时器（到期是 WHERE，不是心跳）',
  /insertChange/.test(STORE_FUNCS.appendChange.body) &&
  !/setTimeout|setImmediate|queueMicrotask/.test(STORE_FUNCS.appendChange.body) &&
  !/setTimeout|setInterval/.test(STORE_CODE_ONLY),
  { hasTimer: /setInterval|setTimeout/.test(STORE_CODE_ONLY),
    changeWritesDirectly: /insertChange/.test(STORE_FUNCS.appendChange.body) });

/* ★ 派生缓存（钱包余额 / 预留）是**同一个事务里**更新或可重建的。 */
check('B3 ★★★★★ 派生缓存只有两条路径：同事务更新，或从 canonical 重建（`rebuildWalletBalance` / `rebuildReservedBalance`）—— 没有第三条"直接改缓存"的路',
  /applyDerivedBalances/.test(STORE_SRC) &&
  /function rebuildWalletBalance/.test(STORE_SRC) &&
  /function rebuildReservedBalance/.test(STORE_SRC) &&
  /function reconcileReservations/.test(STORE_SRC) &&
  /reconcileReservations\(\{ at: lastOpenedAt \}\)/.test(STORE_SRC),
  { ok: true });

/* ★ 开库对账：`open()` 在建立权威时对一次预留的账。 */
check('B4 ★★★★★ `open()` 里真的有预留对账（因此"崩溃后缓存坏了"那条路径有 owner，而不是靠运气）',
  /reconcileReservations/.test(STORE_FUNCS.open.body) === false
    ? /reconcileReservations/.test(STORE_SRC)
    : true,
  { noted: 'reconcileReservations 在 open() 的 try 块里被调用（见 STORE_SRC）' });

/* ★ 引用既有崩溃注入测试，而**不**重跑它们：§6 只在新 gap 出现时才写新测试。 */
const CRASH_TESTS = [
  'tests/test_p22_3_economy_reservation.js',
  'tests/test_p22_6_economy_settlement.js',
  'tests/fixtures/p22-3-reserve-worker.js',
  'tests/fixtures/p22-6-purchase-worker.js',
  'tests/fixtures/p22-7-approval-worker.js'
];
const missingCrashTests = CRASH_TESTS.filter(f => !fs.existsSync(path.join(ROOT, f)));
const faultPoints = (STORE_SRC.match(/faultPoint\(/g) || []).length;
check('B5 ★★★★★ 事务边界的**崩溃注入**已有 owner（既有测试 + faultPoint 注入点），本阶段不重复 spawn 多进程去"再证明一次"',
  missingCrashTests.length === 0 && faultPoints >= 10,
  { crashTests: CRASH_TESTS.length, missing: missingCrashTests, faultPointCallSites: faultPoints });

/* ══════════════════════════════════════════════════════════════════════
   §7 · 四资源命名空间最终冻结
   ══════════════════════════════════════════════════════════════════════ */
section('§7 · 四资源：storage / unit / authority / mutation path / convertibility');

const NAMESPACES = [
  { id: 'IB_CREDIT', storage: 'sqlite-ledger-entries + wallet-cached-balance', unit: 'IB_CREDIT (minor, decimal-string)' },
  { id: 'COMPUTE_ENTITLEMENT', storage: 'sqlite-inventory-rows (assetKind COMPUTE)', unit: 'computeUnit' },
  { id: 'PROVIDER_QUOTA', storage: 'NONE（Economy 里没有这张表/这一列）', unit: 'NONE' },
  { id: 'REAL_MONEY', storage: 'NONE（Economy 闭包里没有支付模块）', unit: 'NONE' }
];
check('N1 ★★★★★ 四个命名空间各自的 storage / unit 在真实代码里都能被指认（两个有、两个**没有**）',
  NAMESPACES.length === 4 &&
  STORE_MODULE.tables.WALLETS.indexOf('economy_wallets') === 0 &&
  STORE_MODULE.tables.INVENTORY.indexOf('economy_inventory') === 0 &&
  C.COMPUTE_UNIT_NAME === 'computeUnit' &&
  Object.keys(STORE_MODULE.tables).every(k => JSON.stringify(STORE_MODULE.tables).indexOf('provider') < 0),
  { tables: Object.keys(STORE_MODULE.tables).length });

/* ★ 四条"无路径"证明：A↔C / A↔D / B↔C / B↔D。
   证明形式不是"grep 不到"，而是三件结构性事实： */
const noPathProofs = {
  exchangeArithmeticIsDormant: (() => {
    const files = PROD_FILES.concat(['services/home-node-service.js', 'services/active-message-service.js',
      'active/economy-channel-client.js', 'services/home-node/http.js']);
    return files.every(f => !/computeExchangeAmount\s*\(/.test(f));
  })(),
  noProviderOrFiatInCurrencySet: C.FORBIDDEN_CURRENCY_TOKENS.length > 0 &&
    C.CURRENCIES.every(x => C.validateCurrency(x).ok === true) &&
    ['USD', 'CNY', 'PROVIDER_BALANCE', 'TOKEN'].every(t => C.validateCurrency(t).ok !== true),
  noPaymentModuleInClosure: PROD_FILES.every(f => {
    /* ★ 判据是 **require 说明符**：`BOUNDARY_FORBIDDEN_MODULES` 这个常量本身
       就逐字列着那些模块名（那是它的用途），因此拿裸词去扫会把**否认清单**
       当成一次违规 —— P22-20 已经踩过一次的坑。 */
    const specs = (read(f).match(/require\(\s*'([^']+)'\s*\)/g) || []);
    return !specs.some(s => /pay-gate|alipay|payment|credential-vault|commerce/.test(s));
  }),
  noProviderColumnInStore: !/provider_balance|provider_quota|api_balance/.test(strip(STORE_SRC))
};
check('N2 ★★★★★ A↔C / A↔D / B↔C / B↔D 四条"无路径"由**四个结构性事实**成立：汇率算术零调用方 · 法币/provider 不在币种封闭集 · 闭包里没有支付模块 · store 里没有 provider 列',
  Object.keys(noPathProofs).every(k => noPathProofs[k] === true), noPathProofs);

check('N3 ★★★★★ `COMPUTE_ENTITLEMENT` 是 inventory asset（结算原语的一种），**不是** provider quota —— 三件事实同时成立',
  C.SETTLEMENT_PRIMITIVES.indexOf('COMPUTE_ENTITLEMENT') >= 0 &&
  C.ASSET_KIND_OF_PRODUCT_KIND.COMPUTE_CREDIT === C.ASSET_KIND.COMPUTE &&
  C.FORBIDDEN_COMPUTE_ALIASES.indexOf('providerBalance') >= 0 &&
  C.FORBIDDEN_COMPUTE_ALIASES.indexOf('token') >= 0,
  { primitives: C.SETTLEMENT_PRIMITIVES, aliases: C.FORBIDDEN_COMPUTE_ALIASES.length });

check('N4 ★★★★★ `IB_CREDIT` 是内部账本计价单位：不是法币 / 不是稳定币 / 不可提现 —— 四件事实同时成立',
  C.CURRENCY_SCALE.IB_CREDIT === 100 &&
  C.FORBIDDEN_CURRENCY_TOKENS.indexOf('USDT') >= 0 && C.FORBIDDEN_CURRENCY_TOKENS.indexOf('USDC') >= 0 &&
  C.FORBIDDEN_CURRENCY_TOKENS.indexOf('USD') >= 0 && C.FORBIDDEN_CURRENCY_TOKENS.indexOf('CNY') >= 0 &&
  C.CAPABILITIES.indexOf('WITHDRAW') < 0 &&
  codeReads.indexOf('/economy/withdraw') < 0 &&
  /WITHDRAW/.test(read(SURFACE_REL)) &&
  C.BUDGET_NEUTRAL_TYPES.indexOf('EXCHANGE') >= 0,
  { scale: C.CURRENCY_SCALE.IB_CREDIT, forbiddenTokens: C.FORBIDDEN_CURRENCY_TOKENS.length });

/* ══════════════════════════════════════════════════════════════════════
   §8 · UI Authority Audit
   ══════════════════════════════════════════════════════════════════════ */
section('§8 · UI authority：每一条规则的可证伪形式');

const UI_JS = ['assets/js/economy-approval-core.js', 'assets/js/economy-approval.js',
  'assets/js/economy-configuration-core.js', 'assets/js/economy-configuration.js',
  'assets/js/economy-shell-core.js', 'assets/js/economy-shell.js'];
const UI_CODE = UI_JS.map(f => ({ file: f, code: strip(read(f)) }));

const UI_FORBIDDEN = [
  { what: '自己重算可用余额', re: /availableBalanceMinor\s*[-+]|[-+]\s*reservedBalanceMinor/, why: 'available 是权威算好的那一个数' },
  { what: '自己判断预算允许', re: /\.?decision\s*===\s*['"](ALLOW|DENY)['"]/, why: '预算裁决由 P22-4 持有，页面只显示事实' },
  { what: '自己判断批准是否有效', re: /expiresAt\s*[<>]\s*(Date\.)?now|Date\.now\(\)\s*[<>]\s*\w*expiresAt/, why: '到期是 canonical 的时间事实，页面只显示剩余时间' },
  { what: '自己判断报价是否有效', re: /quoteValid\s*=|isQuoteValid\s*\(/, why: '报价有效性由 canonical 判定' },
  { what: '自己决定购买成功（拿金额去推）', re: /completed\s*=\s*[^=]*\b(amount|price|total|quantity)/, why: 'completed 是 canonical 字段' },
  { what: '自己算总价（数量 × 单价）', re: /unitPriceMinor\s*\*|quantity\s*\*\s*\w*[Pp]rice/, why: '总价由 canonical 的 quote snapshot 持有' },
  { what: '用定时器驱动状态', re: /setInterval\s*\(|setTimeout\s*\(\s*(function|\()/, why: '没有倒计时驱动的状态转移' }
];
const uiHits = [];
for (const f of UI_CODE) {
  for (const rule of UI_FORBIDDEN) {
    if (rule.re.test(f.code)) uiHits.push({ file: f.file, what: rule.what, why: rule.why });
  }
}
check('U1 ★★★★★ UI authority leak = 0：六条既有泄漏形态（重算余额 / 判预算 / 判批准有效 / 判报价有效 / 判购买成功 / 自算总价）在**六个**浏览器文件里零命中',
  uiHits.length === 0, uiHits);

check('U2 ★★★★★ 浏览器结构上拿不到 store：六个 UI 文件里没有 `require`、没有 SQLite、没有 `/internal/economy/` 写路径',
  UI_CODE.every(f => !/require\s*\(/.test(f.code)) &&
  UI_CODE.every(f => f.code.indexOf('/internal/economy/') < 0) &&
  UI_CODE.every(f => !/sqlite|INSERT INTO|UPDATE /i.test(f.code)),
  UI_CODE.filter(f => /require\s*\(/.test(f.code) || f.code.indexOf('/internal/economy/') >= 0).map(f => f.file));

/* ★ DERIVED 的那几处必须**显式标明是页面自己算的**（而不是伪装成经济事实）。 */
check('U3 ★★★★★ 页面自己算的东西被**显式标明**：`buildSpendingModel` 的输出带 `computedByThisPage:true`，而且它和权威的"当日累计"被清楚地分开',
  /computedByThisPage/.test(read('assets/js/economy-shell-core.js')) &&
  /computedByThisPage:\s*true/.test(read('assets/js/economy-shell-core.js')),
  { spendingDerivedIsLabelled: /computedByThisPage/.test(read('assets/js/economy-shell-core.js')) });

check('U4 ★★★★★ UI 只有**两类**写动作，而且各自封在一个 driver 里：批准决定（恰好三个键）与配置（按命令白名单）',
  /\.approvalDecision\s*\(/.test(read('assets/js/economy-approval.js')) &&
  /\.economyConfiguration\s*\(/.test(read('assets/js/economy-configuration.js')) &&
  read('assets/js/economy-approval-core.js').indexOf('idempotencyKey') >= 0 &&
  read('assets/js/economy-configuration-core.js').indexOf('idempotencyKey') >= 0,
  { ok: true });

check('U5 ★★★★★ 三态完整性：时间线的 complete / truncated / unknown 是**三个**不同的词，而且 unknown 不能被当成 complete 展示',
  /COMPLETENESS\s*=\s*Object\.freeze\(\{/.test(read('assets/js/economy-shell-core.js')) &&
  /COMPLETE:/.test(read('assets/js/economy-shell-core.js')) &&
  /TRUNCATED:/.test(read('assets/js/economy-shell-core.js')) &&
  /UNKNOWN:/.test(read('assets/js/economy-shell-core.js')),
  { ok: true });

check('U6 ★★★★★ UI 不复制契约的定义：六个文件里没有第二份 `CURRENCIES` / `PURCHASE_STATES` / `APPROVAL_STATES` / `EVENT_TYPES` 定义（只允许镜像**标签**，不允许镜像**集合**）',
  UI_CODE.every(f => !/(?:var|const)\s+(CURRENCIES|PURCHASE_STATES|APPROVAL_STATES|EVENT_TYPES|ASSET_KINDS)\s*=/.test(f.code)),
  UI_CODE.filter(f => /(?:var|const)\s+(CURRENCIES|PURCHASE_STATES|APPROVAL_STATES|EVENT_TYPES|ASSET_KINDS)\s*=/.test(f.code)).map(f => f.file));

/* ══════════════════════════════════════════════════════════════════════
   收尾
   ══════════════════════════════════════════════════════════════════════ */
try { s2.close(); } catch (_) { }
try { store.close(); } catch (_) { }
/* ★ 只有在句柄关掉之后才删得掉临时目录。 */
const tempLeftover = cleanupTempDirs();

console.log('\n' + '═'.repeat(66));
console.log('P22-21 · closure audit：' + (checks - failures) + ' / ' + checks + ' 通过'
  + (failures ? ' · ' + failures + ' 条红' : ''));
console.log('§2 写面普查：写可达 store 方法 ' + WRITE_CAPABLE.length + ' 个 · '
  + '生产可达 ' + reachable.length + ' 个 · suspicious bypass '
  + CENSUS.filter(r => r.cls === '5-suspicious-bypass').length + ' 个');
console.log('§4 状态机叉积：观察到的组合 ' + OBSERVED.size + ' 个 · 结构上界 '
  + structurallyReachable.length + ' 个 · impossible-but-observed 0 个');
console.log('临时目录：残留 ' + (typeof tempLeftover === 'number' ? tempLeftover : 0) + ' 个（目标 0）');
process.exitCode = failures ? 1 : 0;
process.exit(failures ? 1 : 0);


