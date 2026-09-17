/* ══════════════════════════════════════════════════════════════════════
   P22-21 · Economy v1 Frozen Contract Drift Guard（§11 / §12）

   ★ 这一条测试**不是**把 P22-1～P22-20 的测试复制一遍。
     它只做一件事：**跨阶段漂移守卫**。

   它解析 `docs/ECONOMY_V1_FROZEN_CONTRACT.md` 的每一张表，再与**真实生产
   代码**逐格比对：

     SCHEMA_VERSION       ← services/home-node/economy-store.js
     READ_SURFACES        ← services/home-node/http.js 的路由判定
     WRITE_SURFACES       ← 三个 seam 的 path / 词表 / 信封
     CAPABILITIES         ← 契约 CAPABILITY + CONSUMER_CAPABILITY_MATRIX
     CONSUMERS            ← 契约 ECONOMY_CONSUMERS + anchor
     CURRENCIES           ← 契约 CURRENCIES + CURRENCY_SCALE
     ASSET_KINDS          ← 契约 ASSET_KINDS + SETTLEMENT_PRIMITIVES
     EVENT_TYPES          ← 契约 EVENT_TYPES
     STATE_MACHINES       ← 契约的六个 *_TRANSITIONS + *_TERMINAL_STATES
     EXTERNAL_BOUNDARIES  ← 契约 BOUNDARY_*
     UI_MODULES           ← assets/ 下真实的九个文件
     FUTURE_NOT_PRESENT   ← capability / command / route / event / 生产调用方

   ── 它必须报出**成员名字**，而不是数字 ────────────────────────────────
     §12 逐字要求：未来有人新增 `POST /economy/buy`、`REFUND`、
     `PROVIDER_TOPUP` 或第 8 个 Economy 生产文件时，这条测试要明确告诉他
     「Economy v1 frozen contract changed; declare a new phase/version instead
     of silently extending v1.」并且要指出**多了哪一个 / 少了哪一个**。
     因此本文件里的每一个集合比较都走 `diffSets()`，而 `check()` 打印的
     永远是集合差，不是 `expected 7 got 8`。

   ── ★ P22-20 的裸词教训在这里被显式继承 ──────────────────────────────
     `FUTURE_NOT_PRESENT` 里有 11 个词都**不是**"在仓库里找不到"：
     `REFUND` / `EXCHANGE` / `PROVIDER_TOPUP` … 都以**拒绝码 / 否认清单 /
     休眠算术**的形式真实存在。因此每一行都带一个 `status`：
       · `absent`              —— 标识符一个都找不到（本阶段没有这样的词，
                                  但格式保留，将来新增的词必须用它）；
       · `identifier-present`  —— 标识符存在，而**能力**不存在。
     测试对后者逐条断言三件事：① 那个标识符**真的存在**（否则文档在
     过度声称"没有"）；② 它**不在**任何 capability / command / route /
     event 集合里；③ 它在 Economy 生产代码里**零调用方**。

   ── 资源 ─────────────────────────────────────────────────────────────
     纯 Node 静态 + 一次真实 store 构造（临时目录）。零子进程、零 socket、
     零浏览器。不 open 任何既有数据库。
   ══════════════════════════════════════════════════════════════════════ */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }
function replacer(k, v) { return typeof v === 'bigint' ? v.toString() + 'n' : v; }
function J(v) { return JSON.stringify(v, replacer); }

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

const MANIFEST = 'docs/ECONOMY_V1_FROZEN_CONTRACT.md';
const STORE_REL = 'services/home-node/economy-store.js';
const HTTP_REL = 'services/home-node/http.js';
const CONTRACT_REL = 'services/home-node/economy-contract.js';
const CHANNEL_REL = 'services/home-node/economy-command-channel.js';
const CONFIG_REL = 'services/home-node/economy-configuration.js';
const DECISION_REL = 'services/home-node/economy-approval-decision.js';

const MD = read(MANIFEST);
const C = require(path.join(ROOT, CONTRACT_REL));
const CHANNEL = require(path.join(ROOT, CHANNEL_REL));
const CONFIG = require(path.join(ROOT, CONFIG_REL));
const DECISION = require(path.join(ROOT, DECISION_REL));
const STORE_MODULE = require(path.join(ROOT, STORE_REL));

/* ══════════════════════════════════════════════════════════════════════
   0 · 冻结契约漂移的**统一报错形状**
   ══════════════════════════════════════════════════════════════════════ */

const VERDICT = 'Economy v1 frozen contract changed; '
  + 'declare a new phase/version instead of silently extending v1.';

function diffSets(doc, code) {
  const d = new Set(doc);
  const c = new Set(code);
  return {
    addedInCode: code.filter(x => !d.has(x)),
    removedFromCode: doc.filter(x => !c.has(x))
  };
}
/* ★ 每一个集合比较都用它。`extra` 里永远带着**成员名字**。 */
function checkSet(label, doc, code) {
  const d = diffSets(doc, code);
  return check(label, d.addedInCode.length === 0 && d.removedFromCode.length === 0, {
    verdict: (d.addedInCode.length || d.removedFromCode.length) ? VERDICT : null,
    newInCode_notInManifest: d.addedInCode,
    inManifest_butGoneFromCode: d.removedFromCode,
    manifestCount: doc.length, codeCount: code.length
  });
}

/* ══════════════════════════════════════════════════════════════════════
   1 · 一个极小的 Markdown 表格解析器
   ══════════════════════════════════════════════════════════════════════ */

/* 从标题行（`#`+ 且含 title）之后，取**第一张连续的表格**。
   ★ 为什么是"第一张连续表"而不是"到这个 section 结束"：`## 4 · CAPABILITIES`
   下面还有 `### 4.1 CONSUMERS` 的第二张表，而第二张表的成员（consumer）
   与第一张表（capability）是**两个不同的集合**。开发期实测：不设界会把
   14 个 consumer 名混进 capability 集合，于是这条断言报出了一批
   **根本不存在**的"文档里多出来的 capability"。 */
function rowsAfter(title, md) {
  const text = md === undefined ? MD : md;
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex(l => /^#{1,4}\s/.test(l) && l.indexOf(title) >= 0);
  if (start < 0) return null;
  const out = [];
  let started = false;
  for (let i = start + 1; i < lines.length; i += 1) {
    const trimmed = lines[i].trim();
    if (trimmed.indexOf('|') === 0) { out.push(lines[i]); started = true; continue; }
    if (started) break;
    if (/^#{1,4}\s/.test(lines[i]) && out.length) break;
  }
  /* ★ 表头行一律没有反引号，因此"至少一个单元格里有反引号"就是一个
     精确的表头过滤器 —— 它不依赖列名，也不依赖列数。 */
  return out.filter(l => /`/.test(l));
}
function cells(line) {
  /* `| a | b | c |` → ['a','b','c']（去掉首尾空单元格）。 */
  const parts = line.split('|');
  parts.shift();
  if (parts.length && parts[parts.length - 1].trim() === '') parts.pop();
  return parts.map(s => s.trim());
}
function unquote(s) { return String(s).replace(/`/g, '').trim(); }
/* `a` · `b` · `c` → ['a','b','c'] */
function tickList(s) { return (String(s).match(/`([^`]+)`/g) || []).map(unquote); }

/* ══════════════════════════════════════════════════════════════════════
   2 · 从**真实代码**里抽集合（不引用任何文档结论）
   ══════════════════════════════════════════════════════════════════════ */

/* 真实路由判定：`if (path === '/x' && method === 'GET')`。 */
function realGetRoutes() {
  const src = read(HTTP_REL);
  const out = [];
  const re = /if\s*\(\s*path === '([^']+)'\s*&&\s*method === 'GET'\s*\)/g;
  let m;
  while ((m = re.exec(src))) out.push(m[1]);
  return out;
}
function realEconomyProductionFiles() {
  return fs.readdirSync(path.join(ROOT, 'services', 'home-node'))
    .filter(f => /^economy-.*\.js$/.test(f)).sort()
    .map(f => 'services/home-node/' + f);
}
function realUiModules() {
  const js = ['assets/js/economy-approval-core.js', 'assets/js/economy-approval.js',
    'assets/js/economy-configuration-core.js', 'assets/js/economy-configuration.js',
    'assets/js/economy-shell-core.js', 'assets/js/economy-shell.js'];
  const css = ['assets/css/economy-approval.css', 'assets/css/economy-configuration.css',
    'assets/css/economy-shell.css'];
  return js.concat(css).filter(f => fs.existsSync(path.join(ROOT, f))).sort();
}

/* ══════════════════════════════════════════════════════════════════════
   3 · SCHEMA_VERSION
   ══════════════════════════════════════════════════════════════════════ */
section('§11 · SCHEMA_VERSION');

const schemaRows = rowsAfter('1 · SCHEMA_VERSION') || [];
const docSchema = schemaRows.map(r => cells(r)).filter(c => c.length >= 2)
  .map(c => ({ key: unquote(c[0]), value: unquote(c[1]) }))[0] || { key: null, value: null };

/* ★ P22-26：这里原本还写着 `String(STORE_MODULE.SCHEMA_VERSION) === '7'`。
   那个字面量在 P22-26 抬水位之后变成了这条断言失败的原因 —— 而它证明的东西
   （"manifest 与代码逐字相同"）一个字没变。因此它被删掉，而"当前是几"这件
   事由 §1 的表格**自己**回答（T1 会用同一个数字去核对真实新建的库）。 */
check('S1 ★★★★★ manifest 里的 schema 水位与 store 的 `SCHEMA_VERSION` 逐字相同',
  docSchema.key === 'ECONOMY_SCHEMA_VERSION' &&
  docSchema.value === String(STORE_MODULE.SCHEMA_VERSION),
  { manifest: docSchema, code: STORE_MODULE.SCHEMA_VERSION, verdict: VERDICT });

/* ★ 契约里**没有** schema 常量 —— 水位只有一个真源。 */
check('S2 ★★★ schema 水位的真源只有一个（契约里不存在第二个 ECON*SCHEMA* 常量）',
  !/SCHEMA_VERSION\s*=\s*\d+/.test(read(CONTRACT_REL)),
  { contractMentionsASchemaNumber: true });

/* ══════════════════════════════════════════════════════════════════════
   4 · READ_SURFACES
   ══════════════════════════════════════════════════════════════════════ */
section('§11 · READ_SURFACES（28 条 /economy/* + /security）');

const docReads = (rowsAfter('2 · READ_SURFACES') || [])
  .map(cells).filter(c => c.length >= 2 && unquote(c[0]) === 'GET').map(c => unquote(c[1]));
const codeReads = realGetRoutes().filter(p => p.indexOf('/economy/') === 0);
const codeSecurity = realGetRoutes().filter(p => p === '/security');

checkSet('R1 ★★★★★ 28 条 `GET /economy/*`：manifest ↔ 真实路由判定逐条相同', docReads.filter(p => p !== '/security'), codeReads);
check('R2 ★★★★★ `/security` 在 manifest 里恰好一条，而且在 http.js 里真的是一条 `GET` 路由',
  docReads.filter(p => p === '/security').length === 1 && codeSecurity.length === 1,
  { manifest: docReads.filter(p => p === '/security'), code: codeSecurity });

/* ★ 反向：代码里**没有**任何一条 `/economy/*` 的非 GET 路由。 */
const nonGetEconomyRoutes = (() => {
  const src = read(HTTP_REL);
  const out = [];
  const re = /if\s*\(\s*path === '([^']+)'\s*&&\s*method === '([A-Z]+)'\s*\)/g;
  let m;
  while ((m = re.exec(src))) { if (m[1].indexOf('/economy/') === 0 && m[2] !== 'GET') out.push(m[1] + ':' + m[2]); }
  return out;
})();
check('R3 ★★★★★ `http.js` 里没有任何一条 `/economy/*` 的非 GET 路由（写形态不存在，而不是被过滤）',
  nonGetEconomyRoutes.length === 0, nonGetEconomyRoutes);

/* ══════════════════════════════════════════════════════════════════════
   5 · WRITE_SURFACES
   ══════════════════════════════════════════════════════════════════════ */
section('§11 · WRITE_SURFACES（恰好三条，且都不在 /economy/ 下）');

const docWrites = (rowsAfter('3 · WRITE_SURFACES') || [])
  .map(cells).filter(c => c.length >= 4 && unquote(c[0]) === 'POST')
  .map(c => ({ path: unquote(c[1]), commands: tickList(c[3]).sort() }));

const CODE_WRITES = [
  { path: CONFIG.CONFIGURATION_PATH, commands: CONFIG.COMMAND_LIST.slice().sort(), seam: CONFIG },
  { path: DECISION.DECISION_PATH, commands: DECISION.DECISION_LIST.slice().sort(), seam: DECISION },
  { path: CHANNEL.COMMAND_PATH, commands: CHANNEL.COMMAND_LIST.slice().sort(), seam: CHANNEL }
];

checkSet('W1 ★★★★★ 写面路径集合：manifest ↔ 三个 seam 的 `path` 逐条相同（多一条 / 少一条都红）',
  docWrites.map(w => w.path), CODE_WRITES.map(w => w.path).sort());

/* ★ 路径必须排序后比较，因此这里逐步对照命令词表。 */
const writeMismatches = docWrites.map(dw => {
  const code = CODE_WRITES.filter(w => w.path === dw.path)[0];
  if (!code) return { path: dw.path, reason: 'path-not-in-code' };
  const d = diffSets(dw.commands, code.commands);
  if (d.addedInCode.length || d.removedFromCode.length) return { path: dw.path, ...d };
  return null;
}).filter(Boolean);
check('W2 ★★★★★ 三条写面的命令 / 决定词：manifest ↔ seam 的封闭词表逐词相同',
  writeMismatches.length === 0, { verdict: writeMismatches.length ? VERDICT : null, mismatches: writeMismatches });

check('W3 ★★★★★ 三条写面**都不在** `/economy/` 下（因此"POST /economy/* 一律 405"是一条结构性事实）',
  CODE_WRITES.every(w => w.path.indexOf('/economy/') !== 0) &&
  docWrites.every(w => w.path.indexOf('/economy/') !== 0),
  { code: CODE_WRITES.map(w => w.path), doc: docWrites.map(w => w.path) });

/* ★ 三条写面的形状自述：信封键也在 manifest 里（第 3 列）。 */
const docEnvelopes = (rowsAfter('3 · WRITE_SURFACES') || [])
  .map(cells).filter(c => c.length >= 4 && unquote(c[0]) === 'POST')
  .map(c => ({ path: unquote(c[1]), envelope: tickList(c[2]).sort() }));
const codeEnvelopes = [
  { path: CONFIG.CONFIGURATION_PATH, envelope: CONFIG.ENVELOPE_KEYS.slice().sort() },
  { path: DECISION.DECISION_PATH, envelope: DECISION.ENVELOPE_KEYS.slice().sort() },
  { path: CHANNEL.COMMAND_PATH, envelope: CHANNEL.ENVELOPE_KEYS.slice().sort() }
];
const envMismatch = docEnvelopes.map(de => {
  const ce = codeEnvelopes.filter(e => e.path === de.path)[0];
  if (!ce) return { path: de.path, reason: 'path-not-in-code' };
  const d = diffSets(de.envelope, ce.envelope);
  return (d.addedInCode.length || d.removedFromCode.length) ? { path: de.path, ...d } : null;
}).filter(Boolean);
check('W4 ★★★★ 三条写面的信封键：manifest ↔ seam 的 `ENVELOPE_KEYS` 逐键相同',
  envMismatch.length === 0, envMismatch);

/* ══════════════════════════════════════════════════════════════════════
   6 · CAPABILITIES / CONSUMERS
   ══════════════════════════════════════════════════════════════════════ */
section('§11 · CAPABILITIES · CONSUMERS');

const docCaps = (rowsAfter('4 · CAPABILITIES') || [])
  .map(cells).filter(c => c.length >= 2).map(c => unquote(c[0]));
checkSet('C1 ★★★★★ capability 集合：manifest ↔ 契约 `CAPABILITIES` 逐条相同',
  docCaps, C.CAPABILITIES.slice().sort());

const docMatrix = (rowsAfter('4.1 CONSUMERS') || [])
  .map(cells).filter(c => c.length >= 3)
  .map(c => ({ consumer: unquote(c[0]), caps: tickList(c[2]).sort() }));
checkSet('C2 ★★★★★ consumer 集合：manifest ↔ 契约 `ECONOMY_CONSUMERS` 逐条相同',
  docMatrix.map(r => r.consumer).sort(), C.ECONOMY_CONSUMERS.slice().sort());

const matrixMismatch = docMatrix.map(dr => {
  const code = C.CONSUMER_CAPABILITY_MATRIX[dr.consumer];
  if (!code) return { consumer: dr.consumer, reason: 'consumer-not-in-matrix' };
  const d = diffSets(dr.caps, code.slice().sort());
  return (d.addedInCode.length || d.removedFromCode.length) ? { consumer: dr.consumer, ...d } : null;
}).filter(Boolean);
check('C3 ★★★★★ 能力矩阵（consumer → capabilities）：manifest ↔ `CONSUMER_CAPABILITY_MATRIX` 逐格相同',
  matrixMismatch.length === 0, { verdict: matrixMismatch.length ? VERDICT : null, mismatches: matrixMismatch });

check('C4 ★★★★ 两个"不是发起者"的 consumer 能力表在**代码里**也是空的（不是文档里才空）',
  C.CONSUMER_CAPABILITY_MATRIX.home_node_authority.length === 0 &&
  C.CONSUMER_CAPABILITY_MATRIX.desktop_bridge.length === 0,
  C.CONSUMER_CAPABILITY_MATRIX);

/* ══════════════════════════════════════════════════════════════════════
   7 · CURRENCIES / ASSET_KINDS
   ══════════════════════════════════════════════════════════════════════ */
section('§11 · CURRENCIES · ASSET_KINDS');

const docCurrencies = (rowsAfter('5 · CURRENCIES') || [])
  .map(cells).filter(c => c.length >= 2).map(c => unquote(c[0]));
checkSet('N1 ★★★★★ 币种封闭集：manifest ↔ 契约 `CURRENCIES` 逐条相同（六个，多一个都红）',
  docCurrencies, C.CURRENCIES.slice().sort());

const docAssets = (rowsAfter('6 · ASSET_KINDS') || [])
  .map(cells).filter(c => c.length >= 2).map(c => unquote(c[0]));
checkSet('N2 ★★★★★ 资产类别封闭集：manifest ↔ 契约 `ASSET_KINDS` 逐条相同（ITEM · COMPUTE）',
  docAssets, C.ASSET_KINDS.slice().sort());

check('N3 ★★★★★ 四资源隔离的**结构性**形式：法币 / provider 计费不在币种集里，而且是逐字否认的',
  C.CURRENCIES.indexOf('USD') < 0 && C.CURRENCIES.indexOf('CNY') < 0 &&
  C.CURRENCIES.every(x => C.isForbiddenCurrencyToken(x) !== true) &&
  C.FORBIDDEN_CURRENCY_TOKENS.indexOf('USD') >= 0 &&
  C.FORBIDDEN_CURRENCY_TOKENS.indexOf('CNY') >= 0 &&
  C.FORBIDDEN_CURRENCY_TOKENS.indexOf('PROVIDER_BALANCE') >= 0,
  { currencies: C.CURRENCIES.length, forbidden: C.FORBIDDEN_CURRENCY_TOKENS.length });

check('N4 ★★★★ `COMPUTE_ENTITLEMENT` 是结算原语（inventory asset 的一种），不是 provider quota',
  C.SETTLEMENT_PRIMITIVES.indexOf('COMPUTE_ENTITLEMENT') >= 0 &&
  C.COMPUTE_UNIT_NAME === 'computeUnit' &&
  C.FORBIDDEN_COMPUTE_ALIASES.indexOf('providerBalance') >= 0 &&
  C.FORBIDDEN_COMPUTE_ALIASES.indexOf('token') >= 0,
  { primitives: C.SETTLEMENT_PRIMITIVES, unit: C.COMPUTE_UNIT_NAME });

/* ══════════════════════════════════════════════════════════════════════
   8 · EVENT_TYPES
   ══════════════════════════════════════════════════════════════════════ */
section('§11 · EVENT_TYPES（52）');

const docEvents = (rowsAfter('7 · EVENT_TYPES') || [])
  .map(cells).filter(c => c.length >= 2).map(c => unquote(c[1]));
checkSet('E1 ★★★★★ 事件类型封闭集：manifest ↔ 契约 `EVENT_TYPES` 逐条相同',
  docEvents.slice().sort(), C.EVENT_TYPES.slice().sort());

check('E2 ★★★★★ 事件类型数量被逐字断言（52），因此"多加一个事件"必须走新版本',
  docEvents.length === 52 && C.EVENT_TYPES.length === 52,
  { manifest: docEvents.length, code: C.EVENT_TYPES.length, verdict: VERDICT });

/* ★ 每一个事件类型都必须是契约注册过的（不是文档里凭空写的词）。 */
const unregisteredEvents = docEvents.filter(e => C.isEconomyEventType(e) !== true);
check('E3 ★★★★ manifest 里的每一个事件类型在契约里都是**已注册**的（文档不能凭空发明词）',
  unregisteredEvents.length === 0, unregisteredEvents);

/* ══════════════════════════════════════════════════════════════════════
   9 · STATE_MACHINES
   ══════════════════════════════════════════════════════════════════════ */
section('§11 · STATE_MACHINES（六个状态机）');

const docMachineRows = (rowsAfter('8 · STATE_MACHINES') || [])
  .map(cells).filter(c => c.length >= 4)
  .map(c => ({
    machine: unquote(c[0]), state: unquote(c[1]),
    terminal: unquote(c[2]).toLowerCase() === 'yes',
    successors: c[3] === '—' ? [] : tickList(c[3]).sort()
  }));

const MACHINES = [
  { name: 'PURCHASE_INTENT', trans: C.PURCHASE_INTENT_TRANSITIONS, terminal: C.PURCHASE_INTENT_TERMINAL_STATES },
  { name: 'APPROVAL', trans: C.APPROVAL_TRANSITIONS, terminal: C.APPROVAL_TERMINAL_STATES },
  { name: 'PURCHASE', trans: C.PURCHASE_TRANSITIONS, terminal: C.PURCHASE_TERMINAL_STATES },
  { name: 'QUOTE', trans: C.QUOTE_TRANSITIONS, terminal: C.QUOTE_TERMINAL_STATES },
  { name: 'RESERVATION', trans: C.RESERVATION_TRANSITIONS, terminal: C.RESERVATION_TERMINAL_STATES },
  { name: 'TRANSACTION', trans: C.TX_TRANSITIONS, terminal: C.TX_TERMINAL_STATES }
];

/* ★ 由**真实契约**展开出 (machine, state) 行，再与文档行逐格比较。 */
const codeMachineRows = [];
for (const m of MACHINES) {
  for (const state of Object.keys(m.trans)) {
    codeMachineRows.push({
      machine: m.name, state: state,
      terminal: m.terminal.indexOf(state) >= 0,
      successors: m.trans[state].slice().sort()
    });
  }
}
const docKey = docMachineRows.map(r => r.machine + '.' + r.state).sort();
const codeKey = codeMachineRows.map(r => r.machine + '.' + r.state).sort();
checkSet('M1 ★★★★★ 六个状态机的 (machine, state) 全集：manifest ↔ 契约转移表逐格相同',
  docKey, codeKey);

const machineCellMismatch = [];
for (const cr of codeMachineRows) {
  const dr = docMachineRows.filter(r => r.machine === cr.machine && r.state === cr.state)[0];
  if (!dr) continue;
  if (dr.terminal !== cr.terminal) machineCellMismatch.push({ at: cr.machine + '.' + cr.state, field: 'terminal', doc: dr.terminal, code: cr.terminal });
  const d = diffSets(dr.successors, cr.successors);
  if (d.addedInCode.length || d.removedFromCode.length) {
    machineCellMismatch.push({ at: cr.machine + '.' + cr.state, field: 'successors', ...d });
  }
}
check('M2 ★★★★★ 每一格的终态标记与后继集合：manifest ↔ 契约逐格相同（多一条转移就红）',
  machineCellMismatch.length === 0,
  { verdict: machineCellMismatch.length ? VERDICT : null, mismatches: machineCellMismatch });

/* ★ 终态**不可复活**：契约的转移表里，终态的后继必须为空集。 */
const resurrectable = codeMachineRows.filter(r => r.terminal && r.successors.length > 0);
check('M3 ★★★★★ 终态不可复活：每一个终态的后继集合在契约里都**是空的**',
  resurrectable.length === 0, resurrectable);

/* ══════════════════════════════════════════════════════════════════════
   10 · EXTERNAL_BOUNDARIES
   ══════════════════════════════════════════════════════════════════════ */
section('§11 · EXTERNAL_BOUNDARIES');

const boundaryRows = (rowsAfter('9 · EXTERNAL_BOUNDARIES') || []).map(cells).filter(c => c.length >= 2);
function boundaryList(label) {
  const row = boundaryRows.filter(c => c[0].indexOf(label) >= 0)[0];
  return row ? tickList(row[1]).sort() : null;
}
checkSet('X1 ★★★★★ 禁止模块清单：manifest ↔ 契约 `BOUNDARY_FORBIDDEN_MODULES` 逐条相同',
  boundaryList('禁止的模块') || [], C.BOUNDARY_FORBIDDEN_MODULES.slice().sort());
checkSet('X2 ★★★★★ 允许模块前缀：manifest ↔ 契约 `BOUNDARY_ALLOWED_MODULE_PREFIXES` 逐条相同',
  boundaryList('允许的模块前缀') || [], C.BOUNDARY_ALLOWED_MODULE_PREFIXES.slice().sort());
checkSet('X3 ★★★★★ 禁止标识符清单：manifest ↔ 契约 `BOUNDARY_FORBIDDEN_IDENTIFIERS` 逐条相同',
  boundaryList('禁止的标识符') || [], C.BOUNDARY_FORBIDDEN_IDENTIFIERS.slice().sort());

/* ★ 标识符禁止 ≠ capability 禁止：这条边界由**调用形态**判定。 */
const forbiddenIdentifierInvocations = (() => {
  const files = realEconomyProductionFiles();
  const out = [];
  for (const f of files) {
    const src = read(f);
    for (const id of C.BOUNDARY_FORBIDDEN_IDENTIFIERS) {
      /* 调用形态：`id(` 或 `.id(` —— 裸词（否认清单里的字符串）**不算**。 */
      const re = new RegExp('(?:^|[^\\w.\'"`])' + id + '\\s*\\(', 'g');
      let m;
      while ((m = re.exec(src))) out.push(f + ':' + id);
    }
  }
  return out;
})();
check('X4 ★★★★★ 13 个禁止标识符在 Economy 生产文件里**零调用形态**（它们在文件里出现时只是否认清单的字符串）',
  forbiddenIdentifierInvocations.length === 0, forbiddenIdentifierInvocations);

/* ★ Economy 的 require 闭包：只有白名单里的前缀。 */
const economyRequires = (() => {
  const out = [];
  for (const f of realEconomyProductionFiles()) {
    const src = read(f);
    const re = /require\(\s*'([^']+)'\s*\)/g;
    let m;
    while ((m = re.exec(src))) out.push({ file: f, spec: m[1] });
  }
  return out;
})();
const offClosure = economyRequires.filter(r => {
  if (r.spec.indexOf('node:') === 0) return false;
  if (r.spec === 'runtime/db-failure.js') return false;
  if (r.spec === '../../runtime/db-failure.js') return false;
  if (/^(\.\/|\.\.\/)*economy[-\/]/.test(r.spec)) return false;
  if (/^(crypto|fs|path|sqlite)$/.test(r.spec)) return false;
  return true;
});
check('X5 ★★★★★ Economy 生产文件的 require 闭包**恰好**落在 manifest 允许的前缀里（零 SDK / 零支付库 / 零凭据库）',
  offClosure.length === 0, offClosure);

/* ★ 而"实际用到的说明符"是一个**封闭的 8 元集**，逐字冻结在 manifest 里。
   为什么要有这一条：前缀白名单允许 `node:` 下的**一切**，而
   `node:child_process` / `node:net` 也能通过前缀检查。说明符集合把
   "闭包到此为止"变成一个精确的、可被推翻的事实。 */
const docSpecs = boundaryList('实际 require 说明符') || [];
const codeSpecs = Array.from(new Set(economyRequires.map(r => r.spec))).sort();
checkSet('X5b ★★★★★ 实际 require 说明符（8 个）：manifest ↔ Economy 生产文件里真实出现过的说明符逐条相同',
  docSpecs, codeSpecs);

check('X6 ★★★★ Economy 生产文件不读 `process.env`、不开服务器（`createServer` / `listen` 为 0）',
  realEconomyProductionFiles().every(f => {
    const code = read(f).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
    return code.indexOf('process.env') < 0 && code.indexOf('createServer') < 0;
  }),
  realEconomyProductionFiles().filter(f => {
    const code = read(f).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
    return code.indexOf('process.env') >= 0 || code.indexOf('createServer') >= 0;
  }));

/* ══════════════════════════════════════════════════════════════════════
   11 · UI_MODULES + 生产文件集合
   ══════════════════════════════════════════════════════════════════════ */
section('§11 · UI_MODULES · production file set');

const docUi = (rowsAfter('10 · UI_MODULES') || [])
  .map(cells).filter(c => c.length >= 2 && ['js', 'css'].indexOf(unquote(c[0])) >= 0)
  .map(c => unquote(c[1]));
checkSet('U1 ★★★★★ UI 模块集合（六个 JS + 三个 CSS）：manifest ↔ `assets/` 下真实文件逐条相同',
  docUi.slice().sort(), realUiModules());

check('U2 ★★★★★ Economy 生产文件恰好 7 个（`services/home-node/economy-*.js`）—— 第 8 个文件必须走新版本',
  realEconomyProductionFiles().length === 7,
  { files: realEconomyProductionFiles(), verdict: VERDICT });

/* ★ UI 面**只有**这九个文件：没有第十个 economy-*.js / *.css。 */
const strayUi = (() => {
  const out = [];
  for (const dir of ['assets/js', 'assets/css']) {
    for (const f of fs.readdirSync(path.join(ROOT, dir))) {
      if (/economy/i.test(f) && realUiModules().indexOf(dir + '/' + f) < 0) out.push(dir + '/' + f);
    }
  }
  return out.sort();
})();
check('U3 ★★★★★ `assets/` 下没有第十个 Economy 文件（多一个 UI 模块也红）',
  strayUi.length === 0, { stray: strayUi, verdict: strayUi.length ? VERDICT : null });

/* ══════════════════════════════════════════════════════════════════════
   12 · FUTURE_NOT_PRESENT —— ★ 本文件最重要的一节
   ══════════════════════════════════════════════════════════════════════ */
section('§11 · FUTURE_NOT_PRESENT（"没有能力" ≠ "没有标识符"）');

const futureRows = (rowsAfter('11 · FUTURE_NOT_PRESENT') || [])
  .map(cells).filter(c => c.length >= 3)
  .map(c => ({ word: unquote(c[0]), status: unquote(c[1]), evidence: c[2] }));

const REQUIRED_FUTURE = ['REFUND', 'EXCHANGE', 'PROVIDER_BILLING', 'PROVIDER_QUOTA',
  'REAL_PAYMENT', 'HUMAN_DIRECT_BUY', 'STORE_ADMIN', 'MERCHANT', 'PROMOTION', 'DISCOUNT', 'COUPON'];
checkSet('F1 ★★★★★ `FUTURE_NOT_PRESENT` 的 11 个词一个不多一个不少（§11 逐字要求的那 11 个）',
  futureRows.map(r => r.word).sort(), REQUIRED_FUTURE.slice().sort());

check('F2 ★★★★★ 每一行都带 `status`，且取值只在 {absent, identifier-present} 里',
  futureRows.length === 11 &&
  futureRows.every(r => r.status === 'absent' || r.status === 'identifier-present'),
  futureRows.map(r => ({ word: r.word, status: r.status })));

/* ★ 能力面必须**零命中**。这是"没有能力"的可断言形式。
   ★ `TX_TYPES` 刻意**不在**这张表里：它是**账本交易类型**的登记（词汇），
     不是能力。`REFUND` / `EXCHANGE` 恰好在里面，而这正是 manifest 说的
     `identifier-present`。把词汇表当成能力面会制造一批**假命中** —— 与
     P22-20 的裸词扫描是同一个错误。词汇那一侧由 F3b 单独断言。 */
const CAPABILITY_SETS = {
  capability: C.CAPABILITIES,
  command: CHANNEL.COMMAND_LIST.concat(CONFIG.COMMAND_LIST).concat(DECISION.DECISION_LIST),
  event: C.EVENT_TYPES,
  route: realGetRoutes()
};
/* ★ 词 → 它在能力面上**可能**出现的形态。这不是裸词扫描：它只查
   "能力面"这五个封闭集合的成员名，而且用的是**成员相等**而不是包含。 */
const FUTURE_PROBES = {
  REFUND: ['REFUND', 'REFUND_APPLY', 'REFUND_PURCHASE', 'PURCHASE_REFUND'],
  EXCHANGE: ['EXCHANGE', 'EXCHANGE_APPLY', 'CONVERT_CURRENCY'],
  PROVIDER_BILLING: ['PROVIDER_TOPUP', 'PROVIDER_BILLING', 'TOP_UP_PROVIDER'],
  PROVIDER_QUOTA: ['PROVIDER_QUOTA', 'QUOTA_GRANT', 'SET_PROVIDER_BALANCE'],
  REAL_PAYMENT: ['PAY', 'PAYMENT', 'CHECKOUT', 'SUBMIT_PAYMENT'],
  HUMAN_DIRECT_BUY: ['BUY', 'BUY_NOW', 'DIRECT_BUY', 'PURCHASE_NOW'],
  STORE_ADMIN: ['STORE_ADMIN', 'STORE_CREATE', 'PRODUCT_CREATE', 'CATALOG_ADMIN'],
  MERCHANT: ['MERCHANT', 'MERCHANT_PAY', 'SELLER_SETTLE'],
  PROMOTION: ['PROMOTION', 'PROMO', 'FEATURED'],
  DISCOUNT: ['DISCOUNT', 'DISCOUNT_APPLY', 'PRICE_OVERRIDE'],
  COUPON: ['COUPON', 'COUPON_REDEEM', 'VOUCHER']
};
const capabilityHits = [];
for (const word of REQUIRED_FUTURE) {
  for (const probe of FUTURE_PROBES[word]) {
    for (const setName of Object.keys(CAPABILITY_SETS)) {
      if (CAPABILITY_SETS[setName].indexOf(probe) >= 0) capabilityHits.push({ word: word, probe: probe, surface: setName });
    }
    /* 路径形态：`/economy/<probe 的小写>` 也必须在能力面上不存在。 */
    const lower = '/economy/' + probe.toLowerCase().replace(/_/g, '-');
    if (CAPABILITY_SETS.route.indexOf(lower) >= 0) capabilityHits.push({ word: word, probe: probe, surface: 'route:' + lower });
  }
}
check('F3 ★★★★★ 11 个未来能力词在**四个能力面**（capability / command / decision / event / route）上零命中',
  capabilityHits.length === 0, { verdict: capabilityHits.length ? VERDICT : null, hits: capabilityHits });

/* ★ F3b · 词汇侧的对照：`REFUND` / `EXCHANGE` **只**出现在账本交易类型里，
   而且那里也**只有**它们两个 —— 于是"词表有、能力没有"这句话本身可证伪。 */
const ledgerVocabularyNames = C.TX_TYPES.filter(t => REQUIRED_FUTURE.indexOf(t) >= 0).sort();
check('F3b ★★★★★ "词表有、能力没有"逐字成立：`REFUND` / `EXCHANGE` 只出现在 `TX_TYPES` 里，别处零命中',
  ledgerVocabularyNames.join(',') === 'EXCHANGE,REFUND' &&
  REQUIRED_FUTURE.filter(w => C.TX_TYPES.indexOf(w) >= 0).length === 2,
  { inTxTypes: ledgerVocabularyNames, txTypes: C.TX_TYPES });

/* ★ status = identifier-present 的那些词：标识符**真的存在**（文档没有过度声称"没有"）。 */

const IDENTITY_EVIDENCE = {
  REFUND: () => C.TX_TYPES.indexOf('REFUND') >= 0 && C.PURCHASE_HAS_REFUND === false,
  EXCHANGE: () => C.EVENT_TYPES.indexOf('EXCHANGE_COMMITTED') >= 0 && typeof C.computeExchangeAmount === 'function',
  PROVIDER_BILLING: () => C.FORBIDDEN_EFFECT_NAMES.indexOf('TOP_UP_PROVIDER') >= 0 && C.FORBIDDEN_EFFECT_NAMES.indexOf('PROVIDER_TOPUP') >= 0,
  PROVIDER_QUOTA: () => C.FORBIDDEN_PRODUCT_FIELDS.indexOf('providerQuota') >= 0 && C.FORBIDDEN_COMPUTE_ALIASES.indexOf('providerBalance') >= 0,
  REAL_PAYMENT: () => C.FORBIDDEN_EFFECT_NAMES.indexOf('SEND_PAYMENT') >= 0 && C.BOUNDARY_FORBIDDEN_IDENTIFIERS.indexOf('submitPayment') >= 0,
  HUMAN_DIRECT_BUY: () => read(HTTP_REL).indexOf("'/economy/buy'") >= 0 && C.PURCHASE_EXPOSES_HTTP_MUTATION === false,
  STORE_ADMIN: () => C.STORE_INPUT_KEYS.length > 0 && C.PRODUCT_INPUT_KEYS.length > 0 && read(HTTP_REL).indexOf("'/economy/store/create'") >= 0,
  MERCHANT: () => C.FORBIDDEN_PURCHASE_LEDGER_ACCOUNTS.indexOf('merchant:external') >= 0 &&
    C.FORBIDDEN_PURCHASE_LEDGER_ACCOUNTS.indexOf('merchant:alipay') >= 0 &&
    C.FORBIDDEN_PURCHASE_LEDGER_ACCOUNTS.indexOf('seller:external') >= 0,
  PROMOTION: () => C.FORBIDDEN_PRODUCT_FIELDS.indexOf('promotion') >= 0 && C.FORBIDDEN_PRODUCT_FIELDS.indexOf('featured') >= 0,
  DISCOUNT: () => C.FORBIDDEN_PRODUCT_FIELDS.indexOf('discount') >= 0 && C.FORBIDDEN_PRODUCT_FIELDS.indexOf('discountRate') >= 0,
  COUPON: () => C.FORBIDDEN_PRODUCT_FIELDS.indexOf('coupon') >= 0
};
const identityFailures = [];
for (const row of futureRows) {
  if (row.status !== 'identifier-present') continue;
  const probe = IDENTITY_EVIDENCE[row.word];
  if (!probe) { identityFailures.push({ word: row.word, reason: 'no-identity-evidence-registered' }); continue; }
  if (probe() !== true) identityFailures.push({ word: row.word, reason: 'claimed-identifier-is-not-in-the-code' });
}
check('F4 ★★★★★ 每一个 `identifier-present` 的行：那个标识符在真实契约里**真的存在**（文档不得过度声称"没有"）',
  identityFailures.length === 0, identityFailures);

/* ★ 而它们在生产代码里**零调用方**（`computeExchangeAmount` 是休眠算术）。 */
const dormantArithmeticCallers = (() => {
  const files = realEconomyProductionFiles().concat([
    'services/home-node-service.js', 'services/active-message-service.js',
    'active/economy-channel-client.js', 'services/home-node/http.js'
  ]);
  const out = [];
  for (const f of files) {
    const code = read(f).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
    if (/computeExchangeAmount\s*\(/.test(code) && f !== CONTRACT_REL) out.push(f);
  }
  return out;
})();
check('F5 ★★★★★ §7 休眠算术：`computeExchangeAmount` 在 Economy 生产文件与装配层里**零调用方**',
  dormantArithmeticCallers.length === 0, dormantArithmeticCallers);

/* ★ `COMMIT_COUNTERPARTIES` 是封闭集合，而且**结构上点名不了一个商户**。
   ★ 为什么从**源码行**读而不是从实例读：它在 store 里是一个闭包内的常量
   （`const COMMIT_COUNTERPARTIES = Object.freeze([...])`），实例上才可见。
   而冻结要的恰好是"这一行不许变"，因此逐字断言那一行更直接 —— 并且
   两个成员必须都是 `C.SYSTEM_ACCOUNT` 的成员。 */
const counterpartyLine = (read(STORE_REL).match(/const COMMIT_COUNTERPARTIES = Object\.freeze\(\[([^\]]+)\]\)/) || [])[1] || '';
const counterpartyMembers = (counterpartyLine.match(/SYSTEM_ACCOUNT\.([A-Z_]+)/g) || [])
  .map(s => s.replace('SYSTEM_ACCOUNT.', ''));
check('F6 ★★★★★ `COMMIT_COUNTERPARTIES` 恰好是 `SYSTEM_ACCOUNT.TREASURY` 与 `SYSTEM_ACCOUNT.MARKET` 两个 system 对手方 —— 账本结构上点名不了一个商户',
  counterpartyMembers.slice().sort().join(',') === 'MARKET,TREASURY' &&
  counterpartyMembers.length === 2 &&
  C.SYSTEM_ACCOUNTS.length === 4 &&
  counterpartyMembers.every(m => C.SYSTEM_ACCOUNTS.indexOf(C.SYSTEM_ACCOUNT[m]) >= 0) &&
  C.FORBIDDEN_PURCHASE_LEDGER_ACCOUNTS.indexOf('merchant:external') >= 0 &&
  C.FORBIDDEN_PURCHASE_LEDGER_ACCOUNTS.indexOf('system:provider') >= 0 &&
  counterpartyMembers.every(m => C.SYSTEM_ACCOUNT[m] !== C.SYSTEM_ACCOUNT.MINT && C.SYSTEM_ACCOUNT[m] !== C.SYSTEM_ACCOUNT.BURN),
  { counterpartyMembers: counterpartyMembers, systemAccounts: C.SYSTEM_ACCOUNTS,
    forbiddenLedgerAccounts: C.FORBIDDEN_PURCHASE_LEDGER_ACCOUNTS.length });

/* ══════════════════════════════════════════════════════════════════════
   13 · 一次真实 store 构造：schema 水位与表集合
   ══════════════════════════════════════════════════════════════════════ */
section('§11 · 真实 store：水位与表集合');

const createdDirs = [];
function tmpDir(tag) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-p22-21fz-' + tag + '-'));
  createdDirs.push(d);
  return d;
}
/* ★ 句柄关掉之后才删得掉（见下面收尾处的说明）；`exit` 上的这一份是兜底。 */
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

const DATA_DIR = tmpDir('db');
const createEconomyStore = require(path.join(ROOT, STORE_REL));
const store = createEconomyStore({ dataDir: DATA_DIR, logger: () => { } });
const opened = store.open();

/* ★ P22-26：水位从 7 抬到 8（manifest §1 有完整申报）。这里因此不再写死那个
   数字 —— 它由 manifest 的 §1 表格**逐字**给出，而 T1 的判据变成"真实新建的
   库水位 = manifest 那个数字 = store 自报的那个数"。写死两个 7 会让这条断言在
   下一次合法抬水位时变成"红色的假象"，而它证明的东西同时消失。 */
const MANIFEST_SCHEMA = (function () {
  const m = MD.match(/\|\s*`ECONOMY_SCHEMA_VERSION`\s*\|\s*`(\d+)`\s*\|/);
  return m ? Number(m[1]) : null;
})();
check('T1 ★★★★★ 真实新建的库水位**就是** manifest 里那个数字，而且 store 自报同一个数',
  MANIFEST_SCHEMA !== null &&
  opened.schemaVersion === STORE_MODULE.SCHEMA_VERSION &&
  store.schemaVersionForTest() === MANIFEST_SCHEMA && opened.schemaVersion === MANIFEST_SCHEMA,
  { opened: opened.schemaVersion, exported: STORE_MODULE.SCHEMA_VERSION, manifest: MANIFEST_SCHEMA });

const TABLES = STORE_MODULE.tables;
check('T2 ★★★★ `TABLES` 导出是**冻结**的：恰好 16 项，而且每一个都以 `economy_` 为前缀（一个独立命名空间）',
  Object.keys(TABLES).length === 16 &&
  Object.keys(TABLES).every(k => String(TABLES[k]).indexOf('economy_') === 0),
  { keys: Object.keys(TABLES), tables: TABLES });

/* ★ 已知的、非阻塞的描述性缺口（manifest §13 D5）：19 个 `const *_TABLE = '…'`
   常量，`TABLES` 导出只有 16 项。这里把**两个数字与三个名字**都断言下来，
   于是它既不会被悄悄修好而被当成"新能力"，也不会被悄悄扩大。 */
const tableConsts = (() => {
  const out = {};
  const re = /^const ([A-Z_]+_TABLE) = '([^']+)'/gm;
  let m;
  while ((m = re.exec(read(STORE_REL)))) out[m[1]] = m[2];
  return out;
})();
const exportedTableNames = Object.keys(TABLES).map(k => TABLES[k]);
const notExported = Object.keys(tableConsts)
  .filter(name => exportedTableNames.indexOf(tableConsts[name]) < 0).sort();
check('T3 ★★★ 描述性缺口被如实冻结：`const *_TABLE` 常量 19 个 · `TABLES` 导出 16 项 · 未导出的是三个被点名的表',
  Object.keys(tableConsts).length === 19 && Object.keys(TABLES).length === 16 &&
  notExported.join(',') === 'APPROVALS_TABLE,AUTONOMY_POLICIES_TABLE,PURCHASE_INTENTS_TABLE',
  { constCount: Object.keys(tableConsts).length, exported: Object.keys(TABLES).length, notExported: notExported });

/* ★ store 的公开面里**没有** manifest 未声明的写动词。 */
const STORE_WRITE_VERBS = ['bootstrapInitialCredit', 'putBudgetPolicy', 'putAutonomyPolicy',
  'decideApproval', 'proposeAgentPurchaseIntent', 'resumeAgentPurchaseIntent', 'appendCapabilityAudit'];
const undocumentedWriteVerbs = STORE_WRITE_VERBS.filter(v => typeof store[v] !== 'function');
check('T4 ★★★★★ manifest §3.1 列出的七个生产可达写动词在 store 的公开面上**都真的存在**',
  undocumentedWriteVerbs.length === 0, undocumentedWriteVerbs);

/* ★ http.js 里**没有**任何 store 写动词的**调用形态**。
   开发期实测：`grantInventory` 在 http.js 里出现过一次 —— 而它在一段
   **注释**里（解释"这五个方法不在名单上"）。裸词扫描会因此报出一个假命中，
   与 P22-20 §7 的教训同源。因此这里先剥注释与字符串，再查。 */
const httpCodeOnly = read(HTTP_REL)
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/(^|[^:])\/\/.*$/gm, '$1 ')
  .replace(/'(?:[^'\\]|\\.)*'/g, "''")
  .replace(/"(?:[^"\\]|\\.)*"/g, '""');
const httpWriteVerbs = ['preparePurchase', 'settlePurchase', 'cancelPurchase', 'reserveFunds',
  'commitReservation', 'releaseReservation', 'grantInventory', 'consumeInventory',
  'mutateInventoryInTx', 'commitLedgerTransaction', 'mintForSystem', 'burnForSystem',
  'transferBetweenWallets', 'openWallet', 'createApprovalRequest', 'authorizePurchaseIntent',
  'expireApproval', 'expireDueApprovals', 'expireDueQuotes', 'expireDueReservations',
  'expireDuePolicies', 'putStore', 'putProduct', 'createProductQuote', 'createQuote',
  'bootstrapInitialCredit', 'putBudgetPolicy', 'putAutonomyPolicy'];
const httpWriteVerbHits = httpWriteVerbs.filter(v => new RegExp('\\.' + v + '\\s*\\(').test(httpCodeOnly));
check('T5 ★★★★★ 28 个 store 写动词在 `http.js` 的**代码**里零调用形态（只在注释里被点名否认）',
  httpWriteVerbHits.length === 0,
  { hits: httpWriteVerbHits, note: '注释与字符串已剥离；裸词扫描会制造假命中（grantInventory 就是一例）' });

try { store.close(); } catch (_) { }
/* ★ 只有在句柄关掉之后才删得掉临时目录（Windows 上开着 SQLite 文件时
   `rmSync` 一直 EPERM）。开发期实测：只挂 `exit` 会每次运行留下一个目录。 */
const tempLeftover = cleanupTempDirs();

/* ══════════════════════════════════════════════════════════════════════
   14 · §12 逐字要求的"拦人"句子
   ══════════════════════════════════════════════════════════════════════ */
section('§12 · 这条测试对下一个人说什么');

check('Z1 ★★★★★ manifest 里**逐字**写着那句"不要静默扩 v1，声明新阶段 / 新版本"（中英各一份）',
  MD.indexOf('declare a new phase/version') >= 0 &&
  MD.indexOf('不要静默扩 v1') >= 0 &&
  MD.indexOf('declare a new phase/version instead of') >= 0,
  { hasEnglishVerdict: MD.indexOf('declare a new phase/version') >= 0,
    hasChineseVerdict: MD.indexOf('不要静默扩 v1') >= 0 });

check('Z2 ★★★★★ 本文件的每一个集合比较都走 `checkSet` / 集合差（报成员名，不报 expected/got）',
  /function diffSets/.test(read('tests/test_p22_21_economy_v1_freeze.js')) &&
  /newInCode_notInManifest/.test(read('tests/test_p22_21_economy_v1_freeze.js')),
  { ok: true });

/* ══════════════════════════════════════════════════════════════════════
   15 · 守卫的**灵敏度自测**：它必须报出成员名
   ══════════════════════════════════════════════════════════════════════
   ★ 为什么需要这一节：§12 逐字要求这条测试**不要**只报
   `expected 7 got 8`。而"我的 diff 会报名字"这句话如果只能靠读源码来相信，
   它就不是一条被执行的规则。因此这里往真实的**能力面**注入一个哨兵成员，
   并断言 `diffSets` 把它**逐名**报出来 —— 两个方向都测
   （代码多一个 / 文档多一个），因为只测一个方向的守卫等于只有一半。 */
section('§12 · 守卫灵敏度自测（报成员名，而不是报数字）');

const sentinelAdded = diffSets(C.CAPABILITIES, C.CAPABILITIES.concat(['SENTINEL_NEW_CAPABILITY']));
check('Y1 ★★★★★ 注入一个"代码里多出来的 capability"：diff 必须**逐名**报出 `SENTINEL_NEW_CAPABILITY`',
  sentinelAdded.addedInCode.length === 1 &&
  sentinelAdded.addedInCode[0] === 'SENTINEL_NEW_CAPABILITY',
  sentinelAdded);

const sentinelRemoved = diffSets(C.CAPABILITIES.concat(['SENTINEL_STALE_CAPABILITY']), C.CAPABILITIES);
check('Y2 ★★★★★ 注入一个"文档里多出来的 capability"：diff 必须**逐名**报出 `SENTINEL_STALE_CAPABILITY`（反方向同样不漏）',
  sentinelRemoved.removedFromCode.length === 1 &&
  sentinelRemoved.removedFromCode[0] === 'SENTINEL_STALE_CAPABILITY',
  sentinelRemoved);

check('Y3 ★★★★★ 失败信封里**永远**带着那句 verdict，而且形状是集合差而不是 expected/got',
  /declare a new phase\/version instead of silently extending v1/.test(VERDICT) &&
  Object.keys(diffSets(['a'], ['a', 'b'])).sort().join(',') === 'addedInCode,removedFromCode',
  { verdict: VERDICT, keys: Object.keys(diffSets(['a'], ['a', 'b'])) });

/* ★ Y4 是本文件里唯一一次**端到端**的灵敏度实验：它把 manifest 在**内存里**
   注入一条多出来的事件类型（不碰磁盘上的文件），然后用**同一个解析器**读它，
   并断言 diff 逐名报出那个哨兵。这才证明"有人偷偷往文档里加一行"会被抓住，
   而不是只证明 `diffSets` 这个小函数是对的。 */
const PERTURBED_MD = MD.replace(
  /(\| 1 \| `WALLET_OPENED` \|)/,
  '| 0 | `SENTINEL_EVENT_TYPE` |\n$1'
);
const perturbedDocEvents = (rowsAfter('7 · EVENT_TYPES', PERTURBED_MD) || [])
  .map(cells).filter(c => c.length >= 2).map(c => unquote(c[1]));
const perturbedDiff = diffSets(perturbedDocEvents, C.EVENT_TYPES);
check('Y4 ★★★★★ 端到端灵敏度：往 manifest 内存副本里注入一条事件类型，同一个解析器必须**逐名**报出 `SENTINEL_EVENT_TYPE`',
  PERTURBED_MD !== MD &&
  perturbedDiff.removedFromCode.length === 1 &&
  perturbedDiff.removedFromCode[0] === 'SENTINEL_EVENT_TYPE' &&
  perturbedDiff.addedInCode.length === 0 && perturbedDocEvents.length === 53,
  { perturbationApplied: PERTURBED_MD !== MD, ...perturbedDiff, docRows: perturbedDocEvents.length });

const changed = checks - failures;
console.log('\n' + '═'.repeat(66));
console.log('P22-21 · freeze drift guard：' + (checks - failures) + ' / ' + checks + ' 通过'
  + (failures ? ' · ' + failures + ' 条红' : ''));
console.log('（集合比较全部报**成员名**。任何一条红都意味着：' + VERDICT + '）');
console.log('临时目录：残留 ' + (typeof tempLeftover === 'number' ? tempLeftover : 0) + ' 个（目标 0）');
process.exitCode = failures ? 1 : 0;
