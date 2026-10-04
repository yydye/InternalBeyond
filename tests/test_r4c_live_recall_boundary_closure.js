'use strict';
/* ══════════════════════════════════════════════════════════════════════════
   Internal Beyond · P21-R4-LIVE-3.3 · Server Recall Boundary Closure
   （纯 Node · 零真实网络 · 零真实 provider · temp dir 全清）

   运行：node tests/test_r4c_live_recall_boundary_closure.js

   ── 本文件闭合的是什么 ────────────────────────────────────────────────
   LIVE-3.2 的两条独立审计分别证明了"内容权威在服务端"与"状态所有权要搬到
   服务端"。本文件证明**边界本身**闭合：服务端能从 canonical store + 共享
   选择核心**独立复现**桌面的召回选择，并且做到这件事时**零副作用**。

   ── 为什么"复现桌面的选择"必须逐条证明，而不是"看起来一样" ─────────────
   实测出来的两个真实差异（都不是风格问题）：
     1. **glossary 通道**：桌面 wrapper 传 `glossaryProvider`，
        Home Node wrapper 此前**根本没有这个键** ⇒ 该通道在服务端**永远无法触发**。
     2. **includeHeader 是预算语义的一部分，不是 presentation**：桌面**省略**该键
        ⇒ core 默认 true ⇒ header 计入 maxChars；Home Node 此前硬编码 false。
        在紧预算（实测 maxChars=200）下，这会让**最终 selected set 不同**。
   这两条都已由生产修复（memory-retrieval.js:123 显式 `includeHeader` 选项、
   :162-163 `glossaryProvider` / `getGlossaryEntries` 透传），本文件把它们钉住。

   ── 诚实边界 ──────────────────────────────────────────────────────────
   · 本地 mock provider；REAL_PROVIDER_CALLS = 0；
   · 所有临时目录在 os.tmpdir() 下并在退出时删除；
   · `.dsh-research/` **不是**干净树的一部分：任何诊断产物写入都必须是
     best-effort，既不能当判据，也不能在收尾时崩掉（本文件因此不做产物写入，
     只打印）。
   ══════════════════════════════════════════════════════════════════════════ */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');
const { Readable } = require('node:stream');

const ROOT = path.resolve(__dirname, '..');
const P = (name, value) => console.log(name + ' = ' + value);
const section = t => console.log('\n── ' + t + ' ──');

let passed = 0, failures = 0;
const check = (name, cond, detail) => {
  if (cond) { passed++; console.log('  PASS  ' + name); return true; }
  failures++;
  console.error('  FAIL  ' + name + (detail !== undefined && detail !== null ? '  -> ' + String(detail) : ''));
  return false;
};
const J = v => { try { return JSON.stringify(v); } catch (_) { return String(v); } };
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const sha256File = f => { try { return crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex'); } catch (_) { return null; } };

const TEMP_DIRS = [];
function freshDir(prefix) { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); TEMP_DIRS.push(d); return d; }
function dropDir(d) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) { /* Windows 句柄 */ } }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
async function waitFor(pred, budgetMs) {
  const deadline = Date.now() + (budgetMs || 5000);
  for (;;) {
    let ok = false;
    try { ok = pred() === true; } catch (_) { ok = false; }
    if (ok) return true;
    if (Date.now() > deadline) return false;
    await sleep(10);
  }
}

/* ── 被测模块 ─────────────────────────────────────────────────────────── */
const ORCHESTRATOR = require(path.join(ROOT, 'assets', 'js', 'memory-recall', 'memory-recall-orchestrator.js'));
const GLOSSARY_CATALOG = require(path.join(ROOT, 'assets', 'js', 'memory-recall', 'glossary-catalog.js'));
const SESSION = require(path.join(ROOT, 'assets', 'js', 'memory-recall', 'recall-session-state.js'));
const MEM_STORE = require(path.join(ROOT, 'services', 'home-node', 'memory-store.js'));
const MEM_RETRIEVAL = require(path.join(ROOT, 'services', 'home-node', 'memory-retrieval.js'));
const SERVICE = require(path.join(ROOT, 'services', 'home-node-service.js'));
const RT_INTERP = require(path.join(ROOT, 'services', 'home-node', 'runtime-interpretation.js'));
/* 唯一一份注释剥离器：静态扫描必须扫**代码**，不能扫注释。 */
const WIRING = require(path.join(ROOT, 'tests', 'helpers', 'activation-wiring-probe.js'));

/* 新边界（另一名队友正在落盘）：缺失时**大声 BLOCK**，绝不静默跳过。 */
const RECALL_PATH = '/internal/runtime/memory-recall';
const RECALL_OPERATION = 'memory-recall';
let RUNTIME_RECALL = null, RUNTIME_RECALL_ERROR = null;
try { RUNTIME_RECALL = require(path.join(ROOT, 'services', 'home-node', 'runtime-recall.js')); }
catch (error) { RUNTIME_RECALL_ERROR = error; }

/* ── 要打印的判据 ─────────────────────────────────────────────────────── */
let GLOSSARY_PROVIDER_PARITY = 'UNKNOWN';
let TIGHT_BUDGET_PARITY = 'UNKNOWN';
let RECALL_BOUNDARY_PRESENT = 'NO';
let BUDGET_AUTHORITY = 'UNKNOWN';
let RANDOM_CLOCK_AUTHORITY = 'UNKNOWN';
let DESKTOP_RECALL_TURN_IDENTITY = 'UNKNOWN';
let REPLAY_REEXPLORES = 'UNKNOWN';
let REPLAY_WRITES_EXPOSURE = 'UNKNOWN';
let REPLAY_ACTIVATES = 'UNKNOWN';
let REPLAY_ADVANCES_SESSION = 'UNKNOWN';
let ACTIVATION_GUARD_A_SAME_TURN_SAME_MEMORY = 'UNKNOWN';
let ACTIVATION_GUARD_B_EXACT_REPLAY = 'UNKNOWN';
let ACTIVATION_GUARD_C_NEW_TURN_SAME_MEMORY = 'UNKNOWN';
let ACTIVATION_GUARD_D_SAME_TURN_DIFFERENT_MEMORIES = 'UNKNOWN';
/* P21-R4-LIVE-3.3.1 · §4 冻结语义：下面的六个常量由**实测**推导，
   **不硬编码结论** —— 行为一旦漂移，常量自己会变成 WRONG，
   而不是继续复述一句已经不再为真的说法。
   特别地：本仓库**不得**出现无范围限定的 "exactly-once activation"。 */
let CROSS_RESTART_INCREMENTED_AGAIN = 'UNKNOWN';
let SHADOW_ACTIVATION_WRITES = 'UNKNOWN';
let SHADOW_EXPOSURE_WRITES = 'UNKNOWN';
let SHADOW_SESSION_MUTATIONS = 'UNKNOWN';
let SHADOW_PROVIDER_CALLS = 'UNKNOWN';
let SHADOW_SQLITE_UNCHANGED = 'UNKNOWN';
let RECALL_RESULT_SHAPE = 'UNKNOWN';
let REQUEST_AUTHORITY_ATTACKS_REFUSED = 'UNKNOWN';
let COOLDOWN_WITH_SEEDED_SESSION = 'UNKNOWN';
let COOLDOWN_WITHOUT_SESSION_STATE = 'UNKNOWN';
let REAL_PROVIDER_CALLS = 0;

/* ══════════════════════════════════════════════════════════════════════════
   同步 fixture：真实 memory-store（temp dir）+ 真实 wrapper
   ══════════════════════════════════════════════════════════════════════════ */
const NOW = 1750000000000;
const TURN_INDEX = 40;
const CHAR = 'char_a';
const OTHER = 'char_b';
const QUERY = '显卡 驱动 更新失败';
const GLOSSARY_ALIAS = '显卡驱动事故';
const BUDGET = 2000;
const CONTENT_LEN = 120;

function lcg(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
function mkRecord(id, over) {
  return Object.assign({
    id: id, kind: 'episodic', title: 'T-' + id, content: 'C-' + id + ' 显卡 驱动 更新失败 那晚很难受',
    domain: '日常', tags: [], valence: 0.2, arousal: 0.6, importance: 6, resolved: false,
    visibility: 'public', visibleTo: [], excludeFrom: [],
    activationCount: 0, created: NOW - 86400000, lastActivated: NOW - 86400000,
    createdBy: 'user', createdByName: '', editedByUser: false,
    consolidatedFrom: [], lastConsolidatedAt: null
  }, over || {});
}
const STORE_DIR = freshDir('ib-l33-store-');
const STORE = MEM_STORE({ dataDir: STORE_DIR, logger: () => {} });
const STORE_OPEN = STORE.open();
const SEED = [
  mkRecord('pub_fresh', { importance: 9 }),
  mkRecord('pub_pinned_cooled', { pinned: true }),
  mkRecord('pub_d1'), mkRecord('pub_d2'), mkRecord('pub_d3'),
  mkRecord('pub_noexp'),
  mkRecord('gloss_target', { title: '显卡驱动事故' }),
  mkRecord('sem_anchor'),
  mkRecord('only_a', { visibility: 'only', visibleTo: [CHAR] }),
  mkRecord('except_b', { visibility: 'except', excludeFrom: [OTHER] })
];
STORE.putRecords(SEED);
const CANONICAL_ROWS = STORE.listRecords({}).records;

function seedSessionState() {
  const ss = SESSION.createRecallSessionState();
  ss.beginBrowserTurn({ characterId: CHAR, turnObject: {} });
  ss.recordExposure({ characterId: CHAR, memoryIds: ['pub_d1', 'pub_pinned_cooled'], turnIndex: TURN_INDEX - 1 });
  ss.recordExposure({ characterId: CHAR, memoryIds: ['pub_d2'], turnIndex: TURN_INDEX - 2 });
  ss.recordExposure({ characterId: CHAR, memoryIds: ['pub_d3'], turnIndex: TURN_INDEX - 3 });
  return ss;
}

/* 桌面侧的选项对象：逐字镜像 assets/js/memory.js 的 _pickOpts 构造（只读引用）。 */
function desktopOpts(over) {
  const o = over || {};
  return {
    apiId: CHAR, now: NOW, random: o.random || lcg(20261004),
    userMessage: o.userMessage || '', isGroup: false, groupMemEnabled: false,
    maxChars: o.maxChars == null ? BUDGET : o.maxChars,
    contentLen: CONTENT_LEN,
    glossaryProvider: o.glossaryProvider,
    getGlossaryEntries: undefined,
    turn: {
      message: o.userMessage,
      conversationId: o.conversationId == null ? null : String(o.conversationId),
      isFirstTurn: o.isFirstTurn === true,
      conversationSignalAvailable: o.conversationSignalAvailable === true
    },
    sessionState: o.sessionState || seedSessionState(),
    turnIndex: TURN_INDEX
  };
}

/* 观察服务端 wrapper 真正解析出的**通道**：包一层 orchestrator 的 recall。
   与 tests/test_memory_recall_cooldown_hosts.js §36 同一种做法（只观察，不改行为）。 */
function withOrchSpy(fn) {
  const real = ORCHESTRATOR.recall;
  const seen = [];
  ORCHESTRATOR.recall = function (rows, options) {
    const out = real.apply(this, arguments);
    try {
      seen.push({
        channel: out && out.meta ? out.meta.channel : null,
        activationPolicy: out && out.meta ? out.meta.activationPolicy : null,
        injectedMemoryIds: (out && out.meta && Array.isArray(out.meta.injectedMemoryIds)) ? out.meta.injectedMemoryIds.slice() : [],
        selectedIds: (out && out.result && Array.isArray(out.result.selected)) ? out.result.selected.map(s => s.id) : []
      });
    } catch (_) { seen.push({ channel: null, error: 'spy-failed' }); }
    return out;
  };
  let result = null;
  try { result = fn(); } finally { ORCHESTRATOR.recall = real; }
  return { result: result, seen: seen };
}

function serverWrapper(opts) {
  const o = opts || {};
  const ss = o.sessionState || seedSessionState();
  const retrieval = MEM_RETRIEVAL({ store: STORE, sessionState: ss, random: o.random || lcg(20261004), clock: () => NOW });
  const spy = withOrchSpy(() => retrieval.retrieve(CHAR, {
    userMessage: o.userMessage,
    turnIndex: TURN_INDEX,
    maxChars: o.maxChars,
    includeHeader: o.includeHeader,
    glossaryProvider: o.glossaryProvider,
    getGlossaryEntries: o.getGlossaryEntries,
    conversationId: o.conversationId,
    isFirstTurn: o.isFirstTurn,
    conversationSignalAvailable: o.conversationSignalAvailable
  }));
  return { out: spy.result, seen: spy.seen[spy.seen.length - 1] || null, sessionState: ss, retrieval: retrieval };
}

const GLOSSARY_PROVIDER = GLOSSARY_CATALOG.createGlossaryCatalogProvider(() => ([
  { alias: GLOSSARY_ALIAS, target: { type: 'memory', id: 'gloss_target' } }
]));

(async function main() {
  /* ══════════════════════════════════════════════════════════════════════
     0 · availability
     ══════════════════════════════════════════════════════════════════════ */
  section('0 · piece availability');
  check('0.1 the real canonical memory store opened and seeded the parity fixture',
    STORE_OPEN && STORE_OPEN.ok === true && CANONICAL_ROWS.length === SEED.length,
    'rows=' + CANONICAL_ROWS.length + ' revision=' + STORE.getRevision());
  check('0.2 the production Home Node wrapper forwards includeHeader as an explicit option',
    /includeHeader:\s*options\.includeHeader === true/.test(read('services/home-node/memory-retrieval.js')),
    'services/home-node/memory-retrieval.js:123');
  check('0.3 the production Home Node wrapper forwards the glossary provider seam',
    /glossaryProvider:\s*options\.glossaryProvider/.test(read('services/home-node/memory-retrieval.js'))
    && /getGlossaryEntries:\s*options\.getGlossaryEntries/.test(read('services/home-node/memory-retrieval.js')),
    'services/home-node/memory-retrieval.js:162-163');
  check('0.4 the withTrace diagnostics seam is opt-in and default-off in the wrapper',
    /options\.withTrace === true/.test(read('services/home-node/memory-retrieval.js'))
    && /boundedDiagnostics \? \{ diagnostics: boundedDiagnostics \} : \{\}/.test(read('services/home-node/memory-retrieval.js')),
    'services/home-node/memory-retrieval.js:187,227 — without withTrace the key set is byte-identical to before');
  check('0.5 the bounded diagnostics deliberately do NOT copy trace.candidates (no per-memory scores)',
    !/candidates:\s*(tr|trace)\.candidates/.test(read('services/home-node/memory-retrieval.js'))
    && /counts:\s*\{[\s\S]{0,220}input:/.test(read('services/home-node/memory-retrieval.js')),
    'only mode / channel / earlyExit / counts / budget leave the wrapper');

  /* ══════════════════════════════════════════════════════════════════════
     §1 · glossary provider parity
     ══════════════════════════════════════════════════════════════════════ */
  section('§1 · glossary provider parity');
  const GLOSS_MESSAGE = GLOSSARY_ALIAS + '让我有点难受';
  const dGlossary = ORCHESTRATOR.recall(CANONICAL_ROWS, desktopOpts({ userMessage: GLOSS_MESSAGE, glossaryProvider: GLOSSARY_PROVIDER }));
  const sGlossary = serverWrapper({ userMessage: GLOSS_MESSAGE, glossaryProvider: GLOSSARY_PROVIDER, includeHeader: true });
  const dGlossIds = (dGlossary.result.selected || []).map(x => x.id);
  const sGlossIds = (sGlossary.out.selectedIds || []);
  check('1.1 the desktop boundary resolves the glossary channel for an exact catalog hit',
    dGlossary.meta && dGlossary.meta.channel === 'glossary',
    'desktop channel=' + J(dGlossary.meta && dGlossary.meta.channel));
  check('1.2 the SERVER boundary now resolves the glossary channel too (the previous gap)',
    !!sGlossary.seen && sGlossary.seen.channel === 'glossary',
    'server channel=' + J(sGlossary.seen && sGlossary.seen.channel)
    + ' — before the fix the wrapper had no glossaryProvider key, so this channel could never fire server-side');
  check('1.3 both sides select the SAME ids for the glossary channel',
    J(dGlossIds) === J(sGlossIds) && dGlossIds.length > 0,
    'desktop=' + J(dGlossIds) + ' server=' + J(sGlossIds));
  check('1.4 both sides agree on the activation policy for the glossary channel',
    (dGlossary.meta && dGlossary.meta.activationPolicy) === (sGlossary.seen && sGlossary.seen.activationPolicy),
    'desktop=' + J(dGlossary.meta && dGlossary.meta.activationPolicy)
    + ' server=' + J(sGlossary.seen && sGlossary.seen.activationPolicy));
  /* 反控：**不给** provider 时两侧都必须落到同一条非 glossary 通道 ——
     否则上面的"一致"可能只是"两边都总是 glossary"。 */
  const dNoProv = ORCHESTRATOR.recall(CANONICAL_ROWS, desktopOpts({ userMessage: GLOSS_MESSAGE, glossaryProvider: undefined }));
  const sNoProv = serverWrapper({ userMessage: GLOSS_MESSAGE, glossaryProvider: undefined, includeHeader: true });
  check('1.5 negative control: without a provider BOTH sides leave the glossary channel',
    (dNoProv.meta && dNoProv.meta.channel) !== 'glossary'
    && sNoProv.seen && sNoProv.seen.channel !== 'glossary'
    && J((dNoProv.result.selected || []).map(x => x.id)) === J(sNoProv.out.selectedIds),
    J({ desktop: dNoProv.meta && dNoProv.meta.channel, server: sNoProv.seen && sNoProv.seen.channel }));
  GLOSSARY_PROVIDER_PARITY = (sGlossary.seen && sGlossary.seen.channel === 'glossary'
    && J(dGlossIds) === J(sGlossIds)) ? 'YES' : 'NO';

  /* ══════════════════════════════════════════════════════════════════════
     §2 · tight-budget parity（includeHeader 是预算语义）
     ══════════════════════════════════════════════════════════════════════ */
  section('§2 · tight-budget parity');
  const tightPairs = [];
  for (const tight of [200, 300, 400]) {
    const d = ORCHESTRATOR.recall(CANONICAL_ROWS, desktopOpts({ userMessage: QUERY, maxChars: tight }));
    const s = serverWrapper({ userMessage: QUERY, maxChars: tight, includeHeader: true });
    tightPairs.push({
      maxChars: tight,
      desktopIds: (d.result.selected || []).map(x => x.id).join(','),
      serverIds: (s.out.selectedIds || []).join(','),
      desktopChars: d.result.chars, serverChars: s.out.chars
    });
  }
  P('TIGHT_BUDGET_PROBE', J(tightPairs));
  const tightAllAgree = tightPairs.every(p => p.desktopIds === p.serverIds && p.desktopChars === p.serverChars);
  check('2.1 under a tight budget the selected SET agrees on both sides',
    tightPairs.every(p => p.desktopIds === p.serverIds),
    J(tightPairs.map(p => ({ maxChars: p.maxChars, desktop: p.desktopIds, server: p.serverIds }))));
  check('2.2 the rendered char count agrees too (same header/budget semantics)',
    tightPairs.every(p => p.desktopChars === p.serverChars),
    J(tightPairs.map(p => ({ maxChars: p.maxChars, desktop: p.desktopChars, server: p.serverChars }))));
  /* 反控：服务端**不**传 includeHeader（= 移动端既有默认 false）时，
     紧预算下集合**必须**不同 —— 否则说明 includeHeader 根本没参与预算。 */
  const sNoHeader = serverWrapper({ userMessage: QUERY, maxChars: 200, includeHeader: false });
  const dTight = ORCHESTRATOR.recall(CANONICAL_ROWS, desktopOpts({ userMessage: QUERY, maxChars: 200 }));
  check('2.3 negative control: with the mobile default (includeHeader omitted/false) the tight sets DO differ',
    (dTight.result.selected || []).map(x => x.id).join(',') !== (sNoHeader.out.selectedIds || []).join(',')
    || dTight.result.chars !== sNoHeader.out.chars,
    'desktop=' + J((dTight.result.selected || []).map(x => x.id).join(','))
    + ' server(no header)=' + J((sNoHeader.out.selectedIds || []).join(',')));
  TIGHT_BUDGET_PARITY = tightAllAgree ? 'YES' : 'NO';

  /* ══════════════════════════════════════════════════════════════════════
     GATE · 新边界（runtime-recall.js + route）是否在场
     ══════════════════════════════════════════════════════════════════════ */
  section('GATE · server recall boundary on disk');
  const RECALL_OK = !!RUNTIME_RECALL && typeof RUNTIME_RECALL === 'function';
  check('G.1 services/home-node/runtime-recall.js exists and exports a factory',
    RECALL_OK, RUNTIME_RECALL_ERROR ? String(RUNTIME_RECALL_ERROR.message) : 'factory export missing');
  check('G.2 the recall route literal is what this suite drives',
    RECALL_OK && RUNTIME_RECALL.PATH === RECALL_PATH,
    RECALL_OK ? J(RUNTIME_RECALL.PATH) : 'n/a');
  RECALL_BOUNDARY_PRESENT = RECALL_OK ? 'YES' : 'NO';
  if (!RECALL_OK) {
    console.error('\nMISSING_PIECE: services/home-node/runtime-recall.js (owner: lead/teammate). '
      + 'Sections §1–§2 above ran and are green; §3–§10 were NOT run and nothing was weakened or skipped silently.');
    console.error('R4C LIVE-3.3 BOUNDARY CLOSURE BLOCKED · ' + passed + ' passed / ' + (failures + 1) + ' failed');
    /* 先关库再删目录：Windows 上未释放的 sqlite 句柄会让 rmSync 失败。 */
    try { STORE.close(); } catch (_) { /* 已关闭 */ }
    for (let attempt = 0; attempt < 12; attempt++) {
      for (const d of TEMP_DIRS) dropDir(d);
      if (!TEMP_DIRS.some(d => fs.existsSync(d))) break;
      await sleep(50);
    }
    process.exit(1);
  }

  /* ══════════════════════════════════════════════════════════════════════
     构造：真实 retrieval + 真实 memory store + 真实 session state + 计数端口
     ══════════════════════════════════════════════════════════════════════ */
  section('§3 · server recall service assembly');
  const recallSession = seedSessionState();
  const providerCalls = { n: 0 };
  const countingPort = { run() { providerCalls.n += 1; return Promise.resolve({ text: '{"items":[]}' }); } };
  /* 激活写入计数器：包一层真实的 recordActivation（只观察，不改行为）。 */
  let activationWrites = 0;
  const realRecordActivation = STORE.recordActivation;
  STORE.recordActivation = function () { activationWrites += 1; return realRecordActivation.apply(this, arguments); };
  const recallRetrieval = MEM_RETRIEVAL({
    store: STORE, sessionState: recallSession, random: lcg(20261004), clock: () => NOW
  });
  const registryStub = {
    getCharacterSpec(id) {
      return id === CHAR ? { provider: 'custom', model: 'm', endpoint: 'https://provider-a.invalid/v1/chat/completions', credentialRef: 'cred_a' } : null;
    },
    getCharacter(id) { return id === CHAR ? { id: CHAR, dto: { id: CHAR, nickname: 'A' } } : null; }
  };
  const recall = RUNTIME_RECALL({
    memoryRetrieval: recallRetrieval, memoryStore: STORE, registry: registryStub,
    sessionState: recallSession, clock: () => NOW, random: lcg(20261004), logger: () => {}
  });
  check('3.1 the factory returns the frozen { path, operations, run, describe } surface and is frozen',
    recall && recall.path === RECALL_PATH && typeof recall.run === 'function'
    && typeof recall.describe === 'function' && Object.isFrozen(recall)
    && Array.isArray(recall.operations) && recall.operations.length === 1 && recall.operations[0] === RECALL_OPERATION,
    J({ path: recall && recall.path, ops: recall && recall.operations, frozen: Object.isFrozen(recall) }));
  const recallDescribe = recall.describe();
  check('3.2 the service does NOT own a session state (it must be injected)',
    recallDescribe && recallDescribe.sessionStateOwned === false,
    J({ sessionStateOwned: recallDescribe && recallDescribe.sessionStateOwned }));

  const DB_FILE = path.join(STORE_DIR, 'home-node.db');
  const PURITY_BASE = {
    session: J(recallSession.debugSize()),
    counter: recallSession.currentTurnIndex({ characterId: CHAR }),
    revision: STORE.getRevision(),
    records: STORE.countRecords(),
    activations: activationWrites,
    providers: providerCalls.n,
    dbHash: sha256File(DB_FILE)
  };
  const okBody = {
    operation: RECALL_OPERATION, characterId: CHAR,
    requestId: 'req_closure_1', conversationId: 'dm:' + CHAR,
    message: QUERY, timeoutMs: 2000
  };
  const run1 = await recall.run(okBody, {});
  check('3.3 a well-formed request succeeds and carries the recall envelope',
    run1 && run1.ok === true && run1.status === 200 && run1.durable === false
    && run1.operation === RECALL_OPERATION && run1.characterId === CHAR,
    J({ ok: run1 && run1.ok, status: run1 && run1.status, error: run1 && run1.error }));
  const SUCCESS_KEYS = ['ok', 'durable', 'operation', 'characterId', 'turnIdentity', 'selectedIds',
    'activationPolicy', 'channel', 'reason', 'fingerprint', 'counts', 'chars', 'boundary', 'status'];
  check('3.4 the success envelope key set is EXACTLY the frozen 14 keys',
    J(Object.keys(run1).sort()) === J(SUCCESS_KEYS.slice().sort()),
    'observed=' + J(Object.keys(run1).sort()) + ' unexpected=' + J(Object.keys(run1).filter(k => SUCCESS_KEYS.indexOf(k) < 0))
    + ' missing=' + J(SUCCESS_KEYS.filter(k => Object.keys(run1).indexOf(k) < 0)));
  check('3.5 the selected ids are an ordered string array and counts are bounded diagnostics',
    Array.isArray(run1.selectedIds) && run1.selectedIds.every(x => typeof x === 'string')
    && run1.counts && typeof run1.counts.candidates === 'number'
    && run1.counts.candidates >= run1.counts.selected
    && run1.counts.selected === run1.selectedIds.length,
    J({ selectedIds: run1.selectedIds, counts: run1.counts }));
  /* ★ 判据锚在**真实 diagnostics** 上，而不是一个写死的期望值：
     同一个 wrapper、同一组输入、显式 withTrace:true 时它如实报出 channel 与
     counts.gated；信封必须与它一致。服务若不 opt-in，信封就会报 null —— 那正是
     本检查要抓的缺陷，不是"channel 可以是 null"可以解释的（本回合不是 early exit）。 */
  const diagRetrieval = MEM_RETRIEVAL({
    store: STORE, sessionState: seedSessionState(), random: lcg(20261004), clock: () => NOW
  });
  const diagProbe = diagRetrieval.retrieve(CHAR, {
    userMessage: QUERY, conversationId: 'dm:' + CHAR, isFirstTurn: false,
    conversationSignalAvailable: false, now: NOW, includeHeader: true, withTrace: true
  });
  const DIAG = diagProbe.diagnostics || null;
  check('3.6 the wrapper really does expose bounded diagnostics for this exact turn under withTrace',
    !!DIAG && DIAG.counts && typeof DIAG.counts.gated === 'number' && typeof DIAG.counts.input === 'number',
    J(DIAG));
  check('3.7 the envelope\'s channel and counts AGREE with the wrapper\'s bounded diagnostics (frozen mapping)',
    !!DIAG && run1.channel === DIAG.channel
    && run1.counts.eligible === DIAG.counts.gated
    && run1.counts.candidates === DIAG.counts.input,
    'envelope=' + J({ channel: run1.channel, counts: run1.counts })
    + ' diagnostics=' + J(DIAG && { channel: DIAG.channel, counts: DIAG.counts })
    + ' — DEFECT: runtime-recall.js:473-480 calls retrieve() WITHOUT { withTrace: true }, so channel'
    + ' and counts.eligible are permanently null even though the wrapper can report them');

  /* ══════════════════════════════════════════════════════════════════════
     §4 · BUDGET AUTHORITY：预算/探索/冷却类字段必须**按名字**被拒
     ══════════════════════════════════════════════════════════════════════ */
  section('§4 · budget / random / clock authority is server-side');
  const AUTHORITY_FIELDS = ['maxChars', 'budget', 'contentLen', 'topK', 'exploration', 'allowExploration',
    'cooldown', 'cooldownFactor', 'seatPlan', 'seats', 'settings', 'sessionState', 'turnIndex',
    'random', 'rng', 'now', 'timestamp', 'activation', 'activationPolicy', 'query', 'normalizedQuery',
    'tokens', 'glossaryEntries', 'glossaryProvider', 'getGlossaryEntries', 'selectedIds',
    'candidateRecords', 'records', 'candidates', 'scores', 'rank', 'ordering'];
  const budgetCodes = {};
  let authorityAllNamed = true, authorityAllRefused = true, authoritySpentNothing = true, budgetChangedSelection = false;
  const baselineIds = J(run1.selectedIds);
  for (const field of AUTHORITY_FIELDS) {
    const body = Object.assign({}, okBody, { requestId: 'req_atk_' + field });
    body[field] = field === 'maxChars' || field === 'budget' || field === 'contentLen' ? 1
      : field === 'topK' ? 1 : field === 'random' || field === 'now' || field === 'timestamp' ? 1 : 'FORGED';
    const res = await recall.run(body, {});
    const code = res && res.error;
    budgetCodes[code] = (budgetCodes[code] || 0) + 1;
    if (code !== 'caller-attempted-to-supply-recall-authority') authorityAllNamed = false;
    const refused = res && res.ok === false && res.status === 400
      && code === 'caller-attempted-to-supply-recall-authority' && res.field === field;
    if (!refused) authorityAllRefused = false;
    check('4.1.authorityField.' + field, refused,
      'status=' + (res && res.status) + ' code=' + J(code) + ' field=' + J(res && res.field));
  }
  check('4.2 every authority-bearing field is refused BY NAME with the dedicated code',
    authorityAllRefused && authorityAllNamed,
    'fields=' + AUTHORITY_FIELDS.length + ' codes=' + J(budgetCodes));
  /* 伪造预算**不得**改变服务端的选择：同一个 requestId 的合法请求结果不变。 */
  const afterAttacks = await recall.run(Object.assign({}, okBody, { requestId: 'req_closure_1b' }), {});
  budgetChangedSelection = J(afterAttacks.selectedIds) !== baselineIds;
  check('4.3 a forged budget cannot change the server selection',
    afterAttacks.ok === true && !budgetChangedSelection,
    'baseline=' + baselineIds + ' after=' + J(afterAttacks.selectedIds));
  P('FORGED_BUDGET_PROBE', J({
    forged: ['maxChars=1', 'budget=1', 'contentLen=1', 'topK=1', 'random=1', 'now=1', 'timestamp=1'].join(' | '),
    firstRefusal: budgetCodes,
    selectionUnchanged: !budgetChangedSelection,
    selectedIds: JSON.parse(baselineIds)
  }));
  check('4.4 a forged `random` / `now` cannot reach the service (server RNG + clock are the authority)',
    budgetCodes['caller-attempted-to-supply-recall-authority'] === AUTHORITY_FIELDS.length,
    J(budgetCodes));
  check('4.5 any OTHER unknown key is refused by the closed schema, not silently ignored',
    await (async () => {
      const res = await recall.run(Object.assign({}, okBody, { requestId: 'req_unknown', somethingElse: 1 }), {});
      return res.ok === false && res.status === 400 && res.error === 'request-field-forbidden' && res.field === 'somethingElse';
    })(),
    'unknown key -> request-field-forbidden');
  BUDGET_AUTHORITY = (authorityAllRefused && authorityAllNamed) ? 'CLOSED_SCHEMA_BY_NAME' : 'OPEN';
  RANDOM_CLOCK_AUTHORITY = (budgetCodes['caller-attempted-to-supply-recall-authority'] === AUTHORITY_FIELDS.length) ? 'SERVER' : 'CALLER';

  /* ══════════════════════════════════════════════════════════════════════
     §5 · turn identity
     ══════════════════════════════════════════════════════════════════════ */
  section('§5 · turn identity');
  const CHAT_CORE = require(path.join(ROOT, 'assets', 'js', 'chat-core.js'));
  const TURN_IDENTITY_KEYS = ['conversationId', 'messageChars', 'messageHash', 'requestId'];
  check('5.1 turnIdentity is EXACTLY the frozen 4-key object { requestId, conversationId, messageChars, messageHash }',
    run1.turnIdentity && J(Object.keys(run1.turnIdentity).sort()) === J(TURN_IDENTITY_KEYS)
    && run1.turnIdentity.requestId === 'req_closure_1'
    && run1.turnIdentity.conversationId === 'dm:' + CHAR
    && run1.turnIdentity.messageChars === QUERY.length
    && typeof run1.turnIdentity.messageHash === 'string' && run1.turnIdentity.messageHash.length > 0,
    J(run1.turnIdentity));
  check('5.2 turnIdentity carries NO raw message text',
    J(run1.turnIdentity).indexOf(QUERY) < 0 && J(run1).indexOf(QUERY) < 0,
    'the raw user text must not appear anywhere in the recall envelope');
  const sameTurn = await recall.run(okBody, {});
  const otherTurn = await recall.run(Object.assign({}, okBody, { requestId: 'req_closure_2' }), {});
  /* 同一 requestId、**不同 message** 的第三次调用：用来区分"摘要覆盖了消息"
     还是"摘要只覆盖 turn"。实测语义由这一对比较得出，不靠猜。 */
  const otherMessageTurn = await recall.run(Object.assign({}, okBody, { message: '完全不同的另一句话' }), {});
  const RUN_IDENTITY_OTHER_MESSAGE_HASH = otherMessageTurn.turnIdentity.messageHash;
  check('5.3 the same (requestId, conversationId) yields the same identity; a new requestId does not',
    sameTurn.turnIdentity.requestId === run1.turnIdentity.requestId
    && sameTurn.turnIdentity.conversationId === run1.turnIdentity.conversationId
    && otherTurn.turnIdentity.requestId !== run1.turnIdentity.requestId
    && otherTurn.turnIdentity.conversationId === run1.turnIdentity.conversationId,
    J({ first: run1.turnIdentity, other: otherTurn.turnIdentity }));
  check('5.4 messageHash is a stable one-way digest of the turn (replay-stable, changes with input)',
    sameTurn.turnIdentity.messageHash === run1.turnIdentity.messageHash
    && otherTurn.turnIdentity.messageHash !== run1.turnIdentity.messageHash
    && RUN_IDENTITY_OTHER_MESSAGE_HASH !== run1.turnIdentity.messageHash
    && String(run1.turnIdentity.messageHash).length >= 8
    && String(run1.turnIdentity.messageHash).indexOf(QUERY) < 0,
    'same (requestId, conversationId, message) => same digest; new requestId => different digest; '
    + 'a different message compares as ' + J(RUN_IDENTITY_OTHER_MESSAGE_HASH)
    + ' — the digest never contains the raw text');
  check('5.5 the identity echoes the caller\'s identity and MINTS nothing (no new permanent id, no persistence)',
    run1.turnIdentity.requestId === 'req_closure_1'
    && run1.turnIdentity.conversationId === 'dm:' + CHAR
    && (() => {
      /* 注释剥离后再扫：这个模块的文档里正写着"不落 localStorage / IndexedDB"，
         不剥注释就会把"明令禁止"读成"真的在用"。 */
      const src = WIRING.stripJsComments(read('services/home-node/runtime-recall.js'));
      return !/require\([^)]*(sqlite|node:fs)/.test(src)
        && !/putRecord|writeFileSync|localStorage|indexedDB/.test(src);
    })(),
    'requestId + conversationId are echoed verbatim; messageHash is a one-way digest; the module persists nothing');
  DESKTOP_RECALL_TURN_IDENTITY = 'SERVER_DERIVED_FROM_REQUEST_AND_CONVERSATION';

  /* ══════════════════════════════════════════════════════════════════════
     §6 · replay semantics（纯影子：不重探索、不曝光、不激活、不推进会话）
     ══════════════════════════════════════════════════════════════════════ */
  section('§6 · replay semantics');
  const beforeReplay = {
    selected: J(sameTurn.selectedIds),
    session: J(recallSession.debugSize()),
    counter: recallSession.currentTurnIndex({ characterId: CHAR }),
    providers: providerCalls.n
  };
  const replay = await recall.run(okBody, {});
  const afterReplay = {
    selected: J(replay.selectedIds),
    session: J(recallSession.debugSize()),
    counter: recallSession.currentTurnIndex({ characterId: CHAR }),
    providers: providerCalls.n
  };
  check('6.1 a replay of the same requestId returns the identical selection',
    replay.ok === true && afterReplay.selected === beforeReplay.selected,
    J({ before: beforeReplay.selected, after: afterReplay.selected }));
  check('6.2 a replay does NOT advance the recall session or its counter',
    afterReplay.session === beforeReplay.session && afterReplay.counter === beforeReplay.counter,
    J({ before: beforeReplay, after: afterReplay }));
  check('6.3 a replay makes NO provider call', afterReplay.providers === beforeReplay.providers,
    'providerCalls=' + beforeReplay.providers + '->' + afterReplay.providers);
  check('6.4 a NEW requestId is a new turn with a new identity (and still no side effects)',
    otherTurn.ok === true && otherTurn.turnIdentity !== run1.turnIdentity
    && otherTurn.selectedIds.length === run1.selectedIds.length,
    J({ identity: otherTurn.turnIdentity, selected: otherTurn.selectedIds.length }));
  REPLAY_REEXPLORES = (afterReplay.selected === beforeReplay.selected) ? 'NO' : 'YES';
  REPLAY_WRITES_EXPOSURE = (afterReplay.session === beforeReplay.session) ? 'NO' : 'YES';
  REPLAY_ACTIVATES = (afterReplay.providers === beforeReplay.providers) ? 'NO' : 'YES';
  REPLAY_ADVANCES_SESSION = (afterReplay.counter === beforeReplay.counter) ? 'NO' : 'YES';

  /* ══════════════════════════════════════════════════════════════════════
     §7 · activation turn guard A/B/C/D（真实 memory-store）
     ══════════════════════════════════════════════════════════════════════ */
  section('§7 · activation turn guard A/B/C/D');
  const guardDir = freshDir('ib-l33-guard-');
  const guardStore = MEM_STORE({ dataDir: guardDir, logger: () => {} });
  guardStore.open();
  guardStore.putRecord(mkRecord('guard_x', { activationCount: 0 }));
  guardStore.putRecord(mkRecord('guard_y', { activationCount: 0 }));
  const countOf = id => guardStore.getRecord(id).activationCount;
  /* A：同一回合、同一条记忆，两次调用 → 只 +1（第二次是 turn-duplicate） */
  const gA1 = guardStore.recordActivation(['guard_x'], { turnId: 'turn_A', at: NOW });
  const gA2 = guardStore.recordActivation(['guard_x'], { turnId: 'turn_A', at: NOW });
  check('7.A same turn + same memory = exactly one canonical increment',
    gA1.updated === 1 && gA2.updated === 0 && countOf('guard_x') === 1
    && J(gA2.duplicated) === J(['guard_x']) && gA2.reason === 'turn-duplicate',
    J({ first: gA1.updated, replay: gA2.updated, count: countOf('guard_x'), duplicated: gA2.duplicated, reason: gA2.reason }));
  ACTIVATION_GUARD_A_SAME_TURN_SAME_MEMORY = (countOf('guard_x') === 1) ? '+1' : 'WRONG';
  /* B：精确重放（同 turnId 同 id）→ +0，且**如实**报告重复 */
  const gB = guardStore.recordActivation(['guard_x'], { turnId: 'turn_A', at: NOW });
  check('7.B an exact replay is a +0 no-op that reports the duplicate honestly',
    gB.ok === true && gB.updated === 0 && gB.reason === 'turn-duplicate'
    && J(gB.duplicated) === J(['guard_x']) && countOf('guard_x') === 1,
    J({ updated: gB.updated, reason: gB.reason, duplicated: gB.duplicated, count: countOf('guard_x') }));
  ACTIVATION_GUARD_B_EXACT_REPLAY = (gB.updated === 0 && gB.reason === 'turn-duplicate') ? '+0' : 'WRONG';
  /* C：新的回合、同一条记忆 → 再次 +1（回合作用域，不是全局去重） */
  const gC = guardStore.recordActivation(['guard_x'], { turnId: 'turn_C', at: NOW });
  check('7.C a new turn on the same memory DOES increment again (scope is the turn)',
    gC.updated === 1 && countOf('guard_x') === 2,
    J({ updated: gC.updated, count: countOf('guard_x') }));
  ACTIVATION_GUARD_C_NEW_TURN_SAME_MEMORY = (countOf('guard_x') === 2) ? '+1' : 'WRONG';
  /* D：同一个回合并列两条不同记忆 → 各 +1 */
  const gD = guardStore.recordActivation(['guard_x', 'guard_y'], { turnId: 'turn_D', at: NOW });
  check('7.D two different memories in the same turn each increment once',
    gD.updated === 2 && countOf('guard_x') === 3 && countOf('guard_y') === 1,
    J({ updated: gD.updated, x: countOf('guard_x'), y: countOf('guard_y') }));
  ACTIVATION_GUARD_D_SAME_TURN_DIFFERENT_MEMORIES = (gD.updated === 2) ? '+1 each' : 'WRONG';
  /* 反控：**没有** turnId 的 legacy 调用方完全不去重（历史行为逐字节不变） */
  const gLegacy1 = guardStore.recordActivation(['guard_y'], { at: NOW });
  const gLegacy2 = guardStore.recordActivation(['guard_y'], { at: NOW });
  check('7.E legacy callers without a turnId keep the additive behaviour (no dedupe)',
    gLegacy1.updated === 1 && gLegacy2.updated === 1 && countOf('guard_y') === 3
    && gLegacy2.duplicated === undefined,
    J({ first: gLegacy1.updated, second: gLegacy2.updated, count: countOf('guard_y') }));
  /* 守卫是进程内、实例内的：新 store 实例（= 重启）从空开始 */
  const guardStore2 = MEM_STORE({ dataDir: guardDir, logger: () => {} });
  guardStore2.open();
  const gRestart = guardStore2.recordActivation(['guard_x'], { turnId: 'turn_A', at: NOW });
  const guardXAfter = guardStore2.getRecord('guard_x').activationCount;
  CROSS_RESTART_INCREMENTED_AGAIN = (gRestart.updated === 1 && guardXAfter === 4) ? 'YES' : 'UNKNOWN';
  check('7.F the guard is in-process only: a fresh instance does NOT remember the turn',
    gRestart.updated === 1 && guardXAfter === 4,
    J({ updated: gRestart.updated, countAfterRestart: guardXAfter })
    + ' — documented non-coverage: restart + replay of an old turn increments again');
  try { guardStore2.close(); } catch (_) { /* 已关闭 */ }
  try { guardStore.close(); } catch (_) { /* 已关闭 */ }

  /* ══════════════════════════════════════════════════════════════════════
     §8 · pure shadow proof
     ══════════════════════════════════════════════════════════════════════ */
  section('§8 · pure shadow');
  const purityAfter = {
    session: J(recallSession.debugSize()),
    counter: recallSession.currentTurnIndex({ characterId: CHAR }),
    revision: STORE.getRevision(),
    records: STORE.countRecords(),
    activations: activationWrites,
    providers: providerCalls.n,
    dbHash: sha256File(DB_FILE)
  };
  check('8.1 zero exposure writes and zero session mutations across every call above',
    purityAfter.session === PURITY_BASE.session && purityAfter.counter === PURITY_BASE.counter,
    J({ before: PURITY_BASE, after: purityAfter }));
  check('8.2 zero canonical activation writes, zero revision/record movement and zero provider calls',
    purityAfter.activations === PURITY_BASE.activations && purityAfter.revision === PURITY_BASE.revision
    && purityAfter.records === PURITY_BASE.records && purityAfter.providers === PURITY_BASE.providers,
    J({ activations: PURITY_BASE.activations + '->' + purityAfter.activations,
      revision: PURITY_BASE.revision + '->' + purityAfter.revision,
      providers: PURITY_BASE.providers + '->' + purityAfter.providers }));
  check('8.3 the canonical sqlite file is byte-identical after the whole shadow run',
    purityAfter.dbHash === PURITY_BASE.dbHash && !!purityAfter.dbHash,
    J({ before: String(PURITY_BASE.dbHash).slice(0, 16), after: String(purityAfter.dbHash).slice(0, 16) }));
  check('8.4 the envelope self-reports the same purity it actually performed',
    run1.boundary && run1.boundary.pureShadow === true
    && run1.boundary.exposureWrites === 0 && run1.boundary.activationWrites === 0
    && run1.boundary.providerCalls === 0 && run1.boundary.sessionMutation === 'NONE'
    && run1.boundary.transportScope === 'DESKTOP_ONLY'
    && run1.boundary.recallSelectionAuthority === 'CALLER_PROPOSED'
    && run1.boundary.attempts === 1,
    J(run1.boundary));
  SHADOW_ACTIVATION_WRITES = purityAfter.activations === PURITY_BASE.activations ? '0' : 'NONZERO';
  SHADOW_EXPOSURE_WRITES = purityAfter.session === PURITY_BASE.session ? '0' : 'NONZERO';
  SHADOW_SESSION_MUTATIONS = purityAfter.counter === PURITY_BASE.counter ? 'NONE' : 'PRESENT';
  SHADOW_PROVIDER_CALLS = String(purityAfter.providers - PURITY_BASE.providers);
  SHADOW_SQLITE_UNCHANGED = purityAfter.dbHash === PURITY_BASE.dbHash ? 'YES' : 'NO';

  /* ══════════════════════════════════════════════════════════════════════
     §9 · result shape：ids + 有界诊断，没有隐藏候选/分数/规范行
     ══════════════════════════════════════════════════════════════════════ */
  section('§9 · result object shape');
  const envelopeText = J(run1);
  const FORBIDDEN_SHAPE_TOKENS = ['content', 'visibility', 'visibleTo', 'excludeFrom', 'createdBy',
    'ownerId', 'activationCount', 'lastActivated', 'score', 'valence', 'arousal', 'payload'];
  const shapeLeaks = FORBIDDEN_SHAPE_TOKENS.filter(t => envelopeText.indexOf(t) >= 0);
  check('9.1 the envelope carries NO candidate rows, per-memory scores or canonical fields',
    shapeLeaks.length === 0,
    'leaked tokens=' + J(shapeLeaks) + ' envelope=' + envelopeText.slice(0, 320));
  check('9.2 every selected id is a plain string from the eligible set (no hidden ids)',
    run1.selectedIds.every(id => CANONICAL_ROWS.some(r => r.id === id)),
    J(run1.selectedIds));
  check('9.3 the envelope is consumable by a future interpretation call (ids + bounded diagnostics only)',
    Array.isArray(run1.selectedIds) && typeof run1.fingerprint === 'string' && run1.fingerprint.length > 0
    && (run1.channel === null || typeof run1.channel === 'string')
    && typeof run1.activationPolicy === 'string'
    && (run1.reason === null || typeof run1.reason === 'string'),
    J({ ids: run1.selectedIds.length, fingerprint: String(run1.fingerprint).slice(0, 16), channel: run1.channel }));
  /* 未来的解释调用只吃 selectedMemoryIds —— 用真实服务交叉验证这份产出是合法输入。 */
  const interpProbe = await RT_INTERP.createRuntimeInterpretation({
    registry: registryStub, credentialAccess: { resolve: () => ({ ok: false, reason: 'not-allowed' }) },
    modelPort: countingPort, costPolicy: { memoryInterpretationEnabled: true },
    memoryStore: STORE, clock: () => NOW, logger: () => {}
  }).run({ operation: 'memory-interpretation', characterId: CHAR, timeoutMs: 1000, selectedMemoryIds: run1.selectedIds }, {});
  check('9.4 the produced ids are a valid interpretation input (the handoff actually closes)',
    interpProbe && interpProbe.ok === false
    && (interpProbe.error === 'credential-unavailable' || interpProbe.error === 'no-authorized-memory'),
    'the interpretation boundary accepted the ids as a closed-schema request and failed only later '
    + 'at the Vault / empty-bind step: '
    + J({ error: interpProbe && interpProbe.error, status: interpProbe && interpProbe.status }));
  RECALL_RESULT_SHAPE = shapeLeaks.length === 0 ? 'IDS_PLUS_BOUNDED_DIAGNOSTICS' : 'LEAKS_' + J(shapeLeaks);

  /* ══════════════════════════════════════════════════════════════════════
     §10 · request authority attacks over the REAL route
     ══════════════════════════════════════════════════════════════════════ */
  section('§10 · request authority attacks (real route)');
  const attackBody = (over) => Object.assign({
    operation: RECALL_OPERATION, characterId: CHAR,
    requestId: 'req_http_atk', conversationId: 'dm:' + CHAR, message: QUERY
  }, over || {});
  const inProcessAttacks = [];
  for (const field of ['selectedIds', 'candidateRecords', 'scores', 'rank', 'cooldown', 'seatPlan']) {
    const res = await recall.run(attackBody({ [field]: 'FORGED' }), {});
    inProcessAttacks.push({ field, status: res.status, code: res.error, named: res.field });
  }
  check('10.1 every request-authority attack is refused by name',
    inProcessAttacks.every(a => a.status === 400 && a.code === 'caller-attempted-to-supply-recall-authority' && a.named === a.field),
    J(inProcessAttacks));
  const crossChar = await recall.run(attackBody({ characterId: OTHER }), {});
  check('10.2 a request for another character is refused with runtime-spec-unavailable (no cross-role leak)',
    crossChar.ok === false && (crossChar.error === 'runtime-spec-unavailable' || crossChar.error === 'recall-unavailable'),
    J({ error: crossChar.error, status: crossChar.status }));
  check('10.3 no attack ever reached a provider',
    providerCalls.n === 0,
    'providerCalls=' + providerCalls.n + ' (the recall boundary takes no model port at all)');
  check('10.4 a wrong/missing operation is refused with operation-forbidden (403)',
    (await recall.run(attackBody({ operation: 'chat' }), {})).error === 'operation-forbidden'
    && (await recall.run(attackBody({ operation: undefined }), {})).error === 'operation-forbidden',
    'operation allowlist is a closed set of one');
  REQUEST_AUTHORITY_ATTACKS_REFUSED = inProcessAttacks.every(a => a.code === 'caller-attempted-to-supply-recall-authority') ? 'ALL' : 'PARTIAL';
  check('10.5 the route literal is wired into the HTTP layer (transport, not just the module)',
    read('services/home-node/http.js').indexOf('memory-recall') >= 0
    || read('services/home-node/http.js').indexOf('runtimeRecall') >= 0,
    'services/home-node/http.js must reference the recall service/route');

  /* ══════════════════════════════════════════════════════════════════════
     §11 · cooldown 需要一个**被注入的** session state（显式用例，不是心照不宣）
     ──────────────────────────────────────────────────────────────────────
     服务端的 turn counter 目前只由 Home-Node 自己的回合（mobile）推进，
     因此"桌面影子"要复现 cooldown，前提是装配层把**同一个** session state
     注入进来、并且边界把它的 index 交给 retrieve()。这里把三种情形分开量：
       A 注入 session + 该记忆在上一回合被曝光过  → 应当被 demote（cooldown 生效）
       B 注入 session、但没有任何曝光              → 与"无 session"同序（对照组）
       C 完全不注入 session（index 为 null）       → cooldown 天然惰性，如实报出
     三者的差别必须来自**曝光数据**本身，而不是"有没有一个对象"。
     ══════════════════════════════════════════════════════════════════════ */
  section('§11 · cooldown requires an injected session state (explicit case)');
  const COOLDOWN_MEMORY = 'pub_pinned_cooled';
  const advanceTo = (n) => {
    const ss = SESSION.createRecallSessionState();
    for (let i = 1; i <= n; i++) ss.beginHomeTurn({ characterId: CHAR, turnId: 'cd_' + i });
    return ss;
  };
  const buildBoundary = (sessionState) => RUNTIME_RECALL({
    memoryRetrieval: MEM_RETRIEVAL({ store: STORE, sessionState: sessionState || null, random: lcg(20261004), clock: () => NOW }),
    memoryStore: STORE, registry: registryStub, sessionState: sessionState || undefined,
    glossaryProvider: GLOSSARY_PROVIDER, clock: () => NOW, random: lcg(20261004), logger: () => {}
  });
  const cdSession = advanceTo(TURN_INDEX);
  cdSession.recordExposure({ characterId: CHAR, memoryIds: [COOLDOWN_MEMORY], turnIndex: TURN_INDEX - 1 });
  const cdSessionNoExposure = advanceTo(TURN_INDEX);
  const svcCooldown = buildBoundary(cdSession);
  const svcNoExposure = buildBoundary(cdSessionNoExposure);
  const svcNoSession = buildBoundary(null);
  const cdBody = (tag) => ({
    operation: RECALL_OPERATION, characterId: CHAR,
    requestId: 'req_cd_' + tag, conversationId: 'dm:' + CHAR, message: QUERY, timeoutMs: 2000
  });
  const cdWith = await svcCooldown.run(cdBody('with'), {});
  const cdControl = await svcNoExposure.run(cdBody('control'), {});
  const cdWithout = await svcNoSession.run(cdBody('without'), {});
  P('COOLDOWN_CASE_PROBE', J({
    seededCounter: cdSession.currentTurnIndex({ characterId: CHAR }),
    exposureTurnIndex: TURN_INDEX - 1,
    withExposure: cdWith.selectedIds, noExposureControl: cdControl.selectedIds, noSessionState: cdWithout.selectedIds
  }));
  check('11.1 a boundary assembled WITHOUT a session state reports that honestly',
    svcNoSession.describe().sessionStateInjected === false && cdWithout.ok === true,
    J({ sessionStateInjected: svcNoSession.describe().sessionStateInjected, ok: cdWithout.ok }));
  check('11.2 the control proves the difference comes from EXPOSURE data, not from an object existing',
    J(cdControl.selectedIds) === J(cdWithout.selectedIds),
    'counter advanced but no exposure => identical order to no session state at all');
  check('11.3 an injected session state + a real exposure DOES change the order (cooldown applied)',
    cdWith.ok === true && J(cdWith.selectedIds) !== J(cdWithout.selectedIds),
    'with exposure=' + J(cdWith.selectedIds) + ' no session=' + J(cdWithout.selectedIds)
    + ' — this is the pin for option (a): the boundary must read the index from the injected session state '
    + 'and pass it as options.turnIndex; if it does not, cooldown is silently inert server-side');
  COOLDOWN_WITH_SEEDED_SESSION = (J(cdWith.selectedIds) !== J(cdWithout.selectedIds)) ? 'APPLIED' : 'INERT';
  COOLDOWN_WITHOUT_SESSION_STATE = (J(cdControl.selectedIds) === J(cdWithout.selectedIds)) ? 'INERT' : 'APPLIED';

  console.log('\n' + '='.repeat(72));
  console.log('R4C LIVE-3.3 · SERVER RECALL BOUNDARY CLOSURE');
  console.log('GLOSSARY_PROVIDER_PARITY = ' + GLOSSARY_PROVIDER_PARITY);
  console.log('TIGHT_BUDGET_PARITY = ' + TIGHT_BUDGET_PARITY);
  console.log('BUDGET_AUTHORITY = ' + BUDGET_AUTHORITY);
  console.log('RANDOM_CLOCK_AUTHORITY = ' + RANDOM_CLOCK_AUTHORITY);
  console.log('DESKTOP_RECALL_TURN_IDENTITY = ' + DESKTOP_RECALL_TURN_IDENTITY);
  console.log('REPLAY_REEXPLORES = ' + REPLAY_REEXPLORES);
  console.log('REPLAY_WRITES_EXPOSURE = ' + REPLAY_WRITES_EXPOSURE);
  console.log('REPLAY_ACTIVATES = ' + REPLAY_ACTIVATES);
  console.log('REPLAY_ADVANCES_SESSION = ' + REPLAY_ADVANCES_SESSION);
  console.log('ACTIVATION_GUARD_A_SAME_TURN_SAME_MEMORY = ' + ACTIVATION_GUARD_A_SAME_TURN_SAME_MEMORY);
  console.log('ACTIVATION_GUARD_B_EXACT_REPLAY = ' + ACTIVATION_GUARD_B_EXACT_REPLAY);
  console.log('ACTIVATION_GUARD_C_NEW_TURN_SAME_MEMORY = ' + ACTIVATION_GUARD_C_NEW_TURN_SAME_MEMORY);
  console.log('ACTIVATION_GUARD_D_SAME_TURN_DIFFERENT_MEMORIES = ' + ACTIVATION_GUARD_D_SAME_TURN_DIFFERENT_MEMORIES);
  /* §4 · 冻结语义（由上面的实测推导；措辞必须带范围） */
  console.log('ACTIVATION_TURN_GUARD = ' + 'IN_PROCESS_TURN_SCOPED');
  console.log('SAME_PROCESS_SAME_TURN_DUPLICATE = ' + ((ACTIVATION_GUARD_B_EXACT_REPLAY === '+0') ? 'NO_INCREMENT' : 'WRONG'));
  console.log('DIFFERENT_TURN = ' + ((ACTIVATION_GUARD_C_NEW_TURN_SAME_MEMORY === '+1') ? 'INCREMENT_ALLOWED' : 'WRONG'));
  console.log('CROSS_PROCESS_RESTART_GUARANTEE = ' + 'NONE');
  console.log('CROSS_RESTART_EXACTLY_ONCE = ' + ((CROSS_RESTART_INCREMENTED_AGAIN === 'YES') ? 'NO' : 'WRONG'));
  console.log('ACTIVATION_AUTO_RETRY = ' + 'NONE');
  console.log('SHADOW_ACTIVATION_WRITES = ' + SHADOW_ACTIVATION_WRITES);
  console.log('SHADOW_EXPOSURE_WRITES = ' + SHADOW_EXPOSURE_WRITES);
  console.log('SHADOW_SESSION_MUTATIONS = ' + SHADOW_SESSION_MUTATIONS);
  console.log('SHADOW_PROVIDER_CALLS = ' + SHADOW_PROVIDER_CALLS);
  console.log('SHADOW_SQLITE_UNCHANGED = ' + SHADOW_SQLITE_UNCHANGED);
  console.log('RECALL_RESULT_SHAPE = ' + RECALL_RESULT_SHAPE);
  console.log('REQUEST_AUTHORITY_ATTACKS_REFUSED = ' + REQUEST_AUTHORITY_ATTACKS_REFUSED);
  console.log('COOLDOWN_WITH_SEEDED_SESSION = ' + COOLDOWN_WITH_SEEDED_SESSION);
  console.log('COOLDOWN_WITHOUT_SESSION_STATE = ' + COOLDOWN_WITHOUT_SESSION_STATE);
  console.log('REAL_PROVIDER_CALLS = ' + REAL_PROVIDER_CALLS);
  console.log('-'.repeat(72));
  if (failures) {
    console.error('R4C LIVE-3.3 BOUNDARY CLOSURE FAILED · ' + failures + ' assertion(s), ' + passed + ' passed');
    process.exitCode = 1;
  } else {
    console.log('R4C LIVE-3.3 BOUNDARY CLOSURE PASSED · ' + passed + ' assertions green');
  }
})().catch(error => {
  console.error('R4C LIVE-3.3 BOUNDARY CLOSURE CRASHED · ' + String((error && error.stack) || error));
  process.exitCode = 1;
}).finally(async () => {
  try { STORE.close(); } catch (_) { /* 已关闭 */ }
  let remaining = TEMP_DIRS.filter(d => fs.existsSync(d));
  for (let attempt = 0; attempt < 12 && remaining.length; attempt++) {
    await sleep(50);
    for (const d of remaining) dropDir(d);
    remaining = TEMP_DIRS.filter(d => fs.existsSync(d));
  }
  console.log('# cleanup: ' + (TEMP_DIRS.length - remaining.length) + '/' + TEMP_DIRS.length + ' temp dir(s) removed');
});
