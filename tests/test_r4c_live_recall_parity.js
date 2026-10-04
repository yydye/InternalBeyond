'use strict';
/* ====================================================================
   P21-R4-LIVE-3.2 · Desktop ⇄ Home Node recall SELECTION parity harness
   --------------------------------------------------------------------
   本文件**只测量**，不改任何生产行为：
     · 不实现 cutover、不加路由、不写生产文件、不调用任何 provider。
     · 唯一写盘是 os.tmpdir() 下的临时目录，结束前整个删除。

   它回答的问题是：
     给定**等价状态 + 完全相同的注入控制**（同一个 now / 同一串 random /
     同一个 turn 身份 / 同一条角色 / 同一份设置），
     Desktop 召回选择 与 Home Node 召回选择 是否给出**同一个选择**？

   两侧的真实入口：
     · Home Node: services/home-node/memory-retrieval.js#retrieve
                  → assets/js/memory-recall/memory-recall-orchestrator.js（同一文件）
     · Desktop  : assets/js/memory.js#selectMemoryContext
                  → 同一个 orchestrator（memory.js:233 `_orch.recall(all,_pickOpts)`）
                  over IndexedDB 镜像（memory.js:188 `dbGetAll('memories')`）

   ★ 关于 Desktop 侧的保真度（必须如实说明，不假装）：
     memory.js 是浏览器 IIFE（`})(window.IB || …)`），在 Node 里无法执行，
     它的候选源 `dbGetAll('memories')` 由浏览器 IndexedDB 提供。
     因此本 harness 在**orchestrator 边界**上重放 Desktop 侧：
       (a) 候选集 = 镜像记录数组（映射与 canonical 往返证明，§6）；
       (b) 选项对象 = 按 memory.js:189-219 + 231-232 的**逐键**构造，
           并且用一个 **源码锁**（SOURCE LOCK）断言 memory.js 里那份键表没有漂移；
       (c) 调用**同一个** orchestrator 默认实例（与 Home Node 侧同一个 require 对象）。
     漂移会让本测试**失败**，而不是静默地比较两个不同的东西。
   ==================================================================== */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..');
const P = (name, value) => console.log(name + ' = ' + value);
const section = (t) => console.log('\n=== ' + t + ' ===');

const results = { pass: 0, fail: 0, checks: [], notes: [] };
function check(name, cond, detail) {
  const ok = !!cond;
  if (ok) results.pass++; else results.fail++;
  results.checks.push({ name, ok, detail: detail == null ? null : String(detail) });
  console.log((ok ? '  PASS ' : '  FAIL ') + name + (detail == null ? '' : '  · ' + detail));
  return ok;
}
const sha256File = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex').toUpperCase();
const J = (v) => { try { return JSON.stringify(v); } catch (_) { return String(v); } };

/* ── temp dirs ───────────────────────────────────────────────────────── */
const madeDirs = [];
function freshDir(tag) { const d = fs.mkdtempSync(path.join(os.tmpdir(), tag)); madeDirs.push(d); return d; }
/* Windows 上 sqlite 句柄在 close() 之后可能晚一拍才释放，一次 rmSync 会 EBUSY。
   这里在 exit 处理器里做**同步**重试（Atomics.wait，不需要事件循环），
   否则每跑一次就在 os.tmpdir() 里留下 store/stale 两个目录。 */
function syncSleep(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch (_) { /* 不支持就退化为立即重试 */ }
}
function cleanup() {
  for (const d of madeDirs) {
    for (let attempt = 0; attempt < 10; attempt++) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) { /* 句柄未释放 */ }
      if (!fs.existsSync(d)) break;
      syncSleep(50);
    }
  }
}
process.on('exit', cleanup);

/* ── modules under test ──────────────────────────────────────────────── */
const STAGE_FILES = {
  'memory-retrieval-core': 'assets/js/memory-retrieval-core.js',
  'memory-visibility-core': 'assets/js/memory-visibility-core.js',
  'recall-query': 'assets/js/memory-recall/recall-query.js',
  'scoring': 'assets/js/memory-recall/scoring.js',
  'cooldown': 'assets/js/memory-recall/cooldown.js',
  'seat-planner': 'assets/js/memory-recall/seat-planner.js',
  'channel-policy': 'assets/js/memory-recall/channel-policy.js',
  'turn-signal': 'assets/js/memory-recall/turn-signal.js',
  'recall-session-state': 'assets/js/memory-recall/recall-session-state.js',
  'glossary-catalog': 'assets/js/memory-recall/glossary-catalog.js',
  'glossary-match': 'assets/js/memory-recall/glossary-match.js',
  'coldstart-anchor': 'assets/js/memory-recall/coldstart-anchor.js',
  'recall-trace': 'assets/js/memory-recall/recall-trace.js',
  'metamemory-shadow': 'assets/js/memory-recall/metamemory-shadow.js',
  orchestrator: 'assets/js/memory-recall/memory-recall-orchestrator.js',
};
const ORCH_FILE = STAGE_FILES.orchestrator;
const MEM_STORE_FILE = 'services/home-node/memory-store.js';
const MEM_RETRIEVAL_FILE = 'services/home-node/memory-retrieval.js';

const ORCHESTRATOR = require(path.join(ROOT, STAGE_FILES.orchestrator));
const CORE = require(path.join(ROOT, STAGE_FILES['memory-retrieval-core']));
const VIS = require(path.join(ROOT, STAGE_FILES['memory-visibility-core']));
const COOLDOWN = require(path.join(ROOT, STAGE_FILES.cooldown));
const CHANNEL_POLICY = require(path.join(ROOT, STAGE_FILES['channel-policy']));
const GLOSSARY_CATALOG = require(path.join(ROOT, STAGE_FILES['glossary-catalog']));
const SESSION = require(path.join(ROOT, STAGE_FILES['recall-session-state']));
const MEM_STORE = require(path.join(ROOT, MEM_STORE_FILE));
const MEM_RETRIEVAL = require(path.join(ROOT, MEM_RETRIEVAL_FILE));

/* ══════════════════════════════════════════════════════════════════════
   §1 · MODULE IDENTITY PER STAGE（证明，不假设）
   ══════════════════════════════════════════════════════════════════════ */
section('§1 module identity per stage');
const identityRows = [];
let depIdentity = null;
{
  /* Server side: what services/home-node/memory-retrieval.js actually resolves. */
  const serverResolved = {};
  serverResolved.orchestrator = require.resolve(path.join(ROOT, ORCH_FILE));
  for (const [stage, rel] of Object.entries(STAGE_FILES)) serverResolved[stage] = require.resolve(path.join(ROOT, rel));

  /* Desktop side: what the browser page actually loads (InternalBeyond.html script tags). */
  const html = fs.readFileSync(path.join(ROOT, 'InternalBeyond.html'), 'utf8');
  const tags = [];
  const re = /<script[^>]+src="([^"]+)"/g;
  let m;
  while ((m = re.exec(html)) !== null) tags.push(m[1]);
  const browserLoaded = new Set(tags.map((t) => t.replace(/^\.\//, '')));

  let allSame = true;
  for (const [stage, rel] of Object.entries(STAGE_FILES)) {
    const inBrowser = browserLoaded.has(rel);
    const samePath = path.normalize(serverResolved[stage]) === path.normalize(path.join(ROOT, rel));
    if (!inBrowser || !samePath) allSame = false;
    identityRows.push({ stage, file: rel, serverResolved: serverResolved[stage], browserScriptTag: inBrowser, samePath, sha256: sha256File(path.join(ROOT, rel)) });
  }
  for (const r of identityRows) console.log('  ' + (r.samePath && r.browserScriptTag ? 'SAME_FILE ' : 'DIVERGE   ') + r.stage.padEnd(24) + r.file);

  /* In-process object identity: the orchestrator's own DEFAULT_DEPS. */
  const deps = ORCHESTRATOR.createOrchestrator(null)._deps;
  depIdentity = {
    core: deps.core === CORE,
    visibility: deps.visibility === VIS,
    cooldown: deps.cooldown === COOLDOWN,
    scoring: deps.scoring === require(path.join(ROOT, STAGE_FILES.scoring)),
    query: deps.query === require(path.join(ROOT, STAGE_FILES['recall-query'])),
    seatPlanner: deps.seatPlanner === require(path.join(ROOT, STAGE_FILES['seat-planner'])),
    channelPolicy: deps.channelPolicy === CHANNEL_POLICY,
    turnSignal: deps.turnSignal === require(path.join(ROOT, STAGE_FILES['turn-signal'])),
    glossaryCatalog: deps.glossaryCatalog === GLOSSARY_CATALOG,
    glossaryMatch: deps.glossaryMatch === require(path.join(ROOT, STAGE_FILES['glossary-match'])),
    coldStartAnchor: deps.coldStartAnchor === require(path.join(ROOT, STAGE_FILES['coldstart-anchor'])),
    trace: deps.trace === require(path.join(ROOT, STAGE_FILES['recall-trace'])),
  };
  const depAllSame = Object.values(depIdentity).every(Boolean);

  /* The two production entry points must resolve the orchestrator to the same object. */
  const retrievalOrchFile = require.resolve(path.join(ROOT, ORCH_FILE));
  const orchestratorObjectIdentity = require(retrievalOrchFile) === ORCHESTRATOR;

  check('§1.1 every stage file is the SAME resolved file on both sides', allSame, identityRows.filter((r) => !(r.samePath && r.browserScriptTag)).map((r) => r.stage).join(',') || 'all same');
  check('§1.2 orchestrator DEFAULT_DEPS are the very same objects as the standalone requires', depAllSame, JSON.stringify(depIdentity));
  check('§1.3 Home Node and Desktop entry points resolve the same orchestrator object', orchestratorObjectIdentity);
  P('MODULE_IDENTITY_ALL_STAGES', allSame && depAllSame && orchestratorObjectIdentity ? 'YES' : 'NO');
  P('MODULE_IDENTITY_STAGE_COUNT', identityRows.length);
  P('MODULE_IDENTITY_DIVERGENT_STAGES', identityRows.filter((r) => !(r.samePath && r.browserScriptTag)).map((r) => r.stage).join('|') || 'NONE');
  P('MODULE_IDENTITY_ORCHESTRATOR_SHA256', sha256File(path.join(ROOT, ORCH_FILE)));
}

/* ══════════════════════════════════════════════════════════════════════
   §2 · SOURCE LOCK on memory.js's Desktop option construction
   ══════════════════════════════════════════════════════════════════════ */
section('§2 desktop option-construction source lock (memory.js is read-only)');
const MEMORY_JS = path.join(ROOT, 'assets', 'js', 'memory.js');
const memorySrc = fs.readFileSync(MEMORY_JS, 'utf8');
const memoryLines = memorySrc.split(/\r?\n/);
const pickStart = memoryLines.findIndex((l) => l.indexOf('const _pickOpts={') >= 0);
const pickEnd = memoryLines.findIndex((l, i) => i > pickStart && l.trim() === '};');
const pickBlock = memoryLines.slice(pickStart, pickEnd + 1).join('\n');
const pickKeys = Array.from(new Set((pickBlock.match(/^\s*([A-Za-z_$][\w$]*)\s*:/gm) || []).map((s) => s.trim().replace(':', '')))).filter((k) => ['null', 'true', 'false'].indexOf(k) < 0).sort();
const EXPECTED_KEYS = ['apiId', 'contentLen', 'getGlossaryEntries', 'glossaryProvider', 'groupMemEnabled', 'isGroup', 'maxChars', 'now', 'random', 'turn', 'userMessage'].sort();
const turnKeys = Array.from(new Set(((pickBlock.split('turn:{')[1] || '').split('}')[0].match(/([A-Za-z_$][\w$]*)\s*:/g) || []).map((s) => s.trim().replace(':', '')))).filter((k) => ['null', 'true', 'false'].indexOf(k) < 0).sort();
const EXPECTED_TURN_KEYS = ['conversationId', 'conversationSignalAvailable', 'isFirstTurn', 'message'].sort();
const callLine = memoryLines.findIndex((l) => l.indexOf('_orch.recall(all,_pickOpts)') >= 0);
const sessionLine = memoryLines.findIndex((l) => l.indexOf('_pickOpts.sessionState=') >= 0);
const turnIndexLine = memoryLines.findIndex((l) => l.indexOf('_pickOpts.turnIndex=') >= 0);
const mirrorLine = memoryLines.findIndex((l) => l.indexOf("dbGetAll('memories')") >= 0);
const activationLine = memoryLines.findIndex((l) => l.indexOf("picked.activationPolicy!=='none'") >= 0);

check('§2.1 _pickOpts key table matches the source lock', JSON.stringify(pickKeys) === JSON.stringify(EXPECTED_KEYS), pickKeys.join(','));
check('§2.2 turn sub-key table matches the source lock', JSON.stringify(turnKeys) === JSON.stringify(EXPECTED_TURN_KEYS), turnKeys.join(','));
check('§2.3 the Desktop call site is still orchestrator.recall(all,_pickOpts)', callLine > 0, 'memory.js:' + (callLine + 1));
check('§2.4 sessionState / turnIndex are injected on the Desktop path', sessionLine > 0 && turnIndexLine > 0, 'memory.js:' + (sessionLine + 1) + ',' + (turnIndexLine + 1));
check('§2.5 Desktop candidate source is the mirror (dbGetAll memories)', mirrorLine > 0, 'memory.js:' + (mirrorLine + 1));
check('§2.6 Desktop activation gate reads the orchestrator activationPolicy', activationLine > 0, 'memory.js:' + (activationLine + 1));
P('DESKTOP_REPLAY_BOUNDARY', 'orchestrator.recall(mirrorRecords, desktopPickOpts)');
P('DESKTOP_SOURCE_LOCK_LINES', (pickStart + 1) + '-' + (pickEnd + 1) + ' / call ' + (callLine + 1) + ' / mirror ' + (mirrorLine + 1));

/* ══════════════════════════════════════════════════════════════════════
   §3 · SYNCHRONIZED FIXTURE (§6)
   ══════════════════════════════════════════════════════════════════════ */
section('§3 synchronized fixture');
const NOW = 1750000000000;           /* fixed wall clock for BOTH sides */
const TURN_INDEX = 40;               /* fixed logical turn for BOTH sides */
const CHAR = 'char_a';
const OTHER = 'char_b';
const QUERY = '显卡 驱动 更新失败';   /* lexical gate fuel for surface/recall */
const GLOSSARY_ALIAS = '显卡驱动事故'; /* exact catalog hit for the glossary channel */
const BUDGET = 2000;
const CONTENT_LEN = 120;

function lcg(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }

function mkRecord(id, over) {
  return Object.assign({
    id, title: '记忆 ' + id, content: '显卡 驱动 更新失败 那一晚 ' + id, createdBy: 'user',
    visibility: 'public', kind: 'episodic', importance: 6, arousal: 0.5, valence: 0.1,
    created: NOW - 3 * 86400000, lastActivated: NOW - 6 * 3600000, activationCount: 1,
  }, over || {});
}

const storeDir = freshDir('ib-l32-store-');
const store = MEM_STORE({ dataDir: storeDir, logger: () => {} });
const opened = store.open();
check('§3.1 real canonical SQLite store opened', opened && opened.ok === true, 'schemaVersion=' + (opened && opened.schemaVersion));

/* pin / cooldown / visibility grid */
const SEED = [
  mkRecord('pub_fresh', { pinned: true }),
  mkRecord('pub_pinned_cooled', { pinned: true, activationCount: 2 }),
  mkRecord('pub_d1'), mkRecord('pub_d2'), mkRecord('pub_d3'),
  mkRecord('pub_noexp'),
  mkRecord('sem_anchor', { kind: 'semantic', activationCount: 1 }),
  mkRecord('only_a', { visibility: 'only', visibleTo: [CHAR] }),
  mkRecord('except_b', { visibility: 'except', excludeFrom: [OTHER] }),
  mkRecord('priv_legacy'),            /* visibility removed below */
  mkRecord('novis_legacy'),           /* visibility removed below */
  mkRecord('gloss_target'),
  mkRecord('hidden_private', { visibility: 'private' }),
  mkRecord('hidden_only_other', { visibility: 'only', visibleTo: [OTHER] }),
];
delete SEED.find((r) => r.id === 'priv_legacy').visibility;
delete SEED.find((r) => r.id === 'novis_legacy').visibility;
for (const r of SEED) {
  const res = store.putRecord(r);
  if (!res || res.ok !== true) throw new Error('seed failed ' + r.id + ': ' + JSON.stringify(res));
}
store.setMemorySettings({ budget: BUDGET, contentLen: CONTENT_LEN });

const canonicalRows = store.listRecords({}).records;
check('§3.2 canonical rows seeded', canonicalRows.length === SEED.length, canonicalRows.length + ' rows');

/* mirror mapping: what the browser mirror holds after hydration.
   The browser stores the objects /memory/list returned (records out of listRecords). */
function toMirrorRecord(rec) { return JSON.parse(JSON.stringify(rec)); }
const mirrorRows = canonicalRows.map(toMirrorRecord);
/* round-trip proof through a serialization boundary (mirror is a different durable store) */
const mirrorFile = path.join(freshDir('ib-l32-mirror-'), 'mirror.json');
fs.writeFileSync(mirrorFile, JSON.stringify(mirrorRows));
const mirrorRoundTrip = JSON.parse(fs.readFileSync(mirrorFile, 'utf8'));
const SELECTION_FIELDS = ['id', 'content', 'title', 'visibility', 'visibleTo', 'excludeFrom', 'createdBy', 'importance', 'activationCount', 'lastActivated', 'created', 'arousal', 'valence', 'resolved', 'kind', 'domain', 'tags', 'pinned'];
const roundTripDiff = [];
for (let i = 0; i < canonicalRows.length; i++) {
  for (const f of SELECTION_FIELDS) {
    const a = canonicalRows[i][f], b = mirrorRoundTrip[i][f];
    if (JSON.stringify(a) !== JSON.stringify(b)) roundTripDiff.push({ id: canonicalRows[i].id, field: f, canonical: a, mirror: b });
  }
}
check('§3.3 mirror round-trip is lossless for every selection-relevant field', roundTripDiff.length === 0, JSON.stringify(roundTripDiff.slice(0, 5)));
P('FIXTURE_ROWS', canonicalRows.length);
P('FIXTURE_VISIBILITY_TIERS', 'public|only|except|missing-visibility|private(negative)|only-other(negative)');
P('MIRROR_ROUNDTRIP', roundTripDiff.length === 0 ? 'LOSSLESS' : 'DIFF');

/* ── §4 MIRROR vs CANONICAL INPUT DIFF ─────────────────────────────── */
const eligibleCanonical = canonicalRows.filter((r) => VIS.canReadMemory(r, { kind: 'role', id: CHAR }).ok).map((r) => r.id).sort();
const eligibleMirror = mirrorRoundTrip.filter((r) => VIS.canReadMemory(r, { kind: 'role', id: CHAR }).ok).map((r) => r.id).sort();
const fieldSetDiff = [];
for (const r of canonicalRows) {
  const m = mirrorRoundTrip.find((x) => x.id === r.id);
  const a = Object.keys(r).sort().join(','), b = Object.keys(m).sort().join(',');
  if (a !== b) fieldSetDiff.push({ id: r.id, onlyCanonical: Object.keys(r).filter((k) => !(k in m)), onlyMirror: Object.keys(m).filter((k) => !(k in r)) });
}
section('§4 mirror vs canonical selection-input diff (hydrated, no staleness)');
check('§4.1 hydrated mirror carries the same field set as canonical', fieldSetDiff.length === 0, JSON.stringify(fieldSetDiff.slice(0, 3)));
check('§4.2 hydrated mirror yields the same eligible id set', JSON.stringify(eligibleCanonical) === JSON.stringify(eligibleMirror), eligibleCanonical.join(','));
P('MIRROR_CANONICAL_SELECTION_INPUT_DIFF', 'IDENTICAL_WHEN_HYDRATED');
P('MIRROR_FIELDS_THAT_CAN_GO_STALE', 'activationCount|lastActivated|content|title|visibility|visibleTo|excludeFrom|pinned|resolved|importance');
P('MIRROR_LEGACY_NAME_RISKS', 'createdAt->created|updatedAt|source->rawSource|summary->content');
P('ELIGIBLE_IDS', eligibleCanonical.join(','));

/* ══════════════════════════════════════════════════════════════════════
   §5 · CONTROL INJECTION (§7) — identical on both sides
   ══════════════════════════════════════════════════════════════════════ */
section('§5 deterministic control injection');
function seedSessionState() {
  const ss = SESSION.createRecallSessionState();
  /* ★ P21-R4-LIVE-3.3 · 两侧必须落在**同一个** logical turn index 上：
     桌面侧把它**显式**传给 orchestrator（desktopOpts 的 turnIndex: TURN_INDEX，来自
     memory.js 的 _ibBeginRecallTurn），而服务端边界是从**注入的 session state**
     计数器里**读**出来的（option (a)）。因此 seeded 计数器必须推进到 TURN_INDEX ——
     否则服务端读到 1、distance 变成负数、惩罚全为 1，两侧比的就不是同一个回合，
     那种"平局"是假的。 */
  for (let i = 1; i <= TURN_INDEX; i++) {
    ss.beginHomeTurn({ characterId: CHAR, turnId: 'seed_turn_' + i });
  }
  /* exposure grid around TURN_INDEX */
  ss.recordExposure({ characterId: CHAR, memoryIds: ['pub_d1', 'pub_pinned_cooled'], turnIndex: TURN_INDEX - 1 });
  ss.recordExposure({ characterId: CHAR, memoryIds: ['pub_d2'], turnIndex: TURN_INDEX - 2 });
  ss.recordExposure({ characterId: CHAR, memoryIds: ['pub_d3'], turnIndex: TURN_INDEX - 3 });
  return ss;
}
const desktopSession = seedSessionState();
const serverSession = seedSessionState();
const randomDesktop = lcg(20261004);
const randomServer = lcg(20261004);
P('CONTROL_NOW', NOW);
P('CONTROL_TURN_INDEX', TURN_INDEX);
P('CONTROL_RANDOM_FIRST3', [lcg(20261004)(), lcg(20261004)(), lcg(20261004)()].map((x) => x.toFixed(6)).join(','));
P('CONTROL_SESSION_STATE_EXPOSURES', JSON.stringify(desktopSession.debugSize()));

/* ══════════════════════════════════════════════════════════════════════
   §6 · PARITY MATRIX (§8 items × §9 channels × §10 grid)
   ══════════════════════════════════════════════════════════════════════ */
section('§6 selection parity matrix');

const glossaryProvider = GLOSSARY_CATALOG.createGlossaryCatalogProvider(() => ([
  { alias: GLOSSARY_ALIAS, target: { type: 'memory', id: 'gloss_target' } },
]));

/* NATURAL channel triggering: neither production wrapper passes `channelHint`
   (memory.js turn {} and memory-retrieval.js buildOpts.turn {} both omit it), so the
   end-to-end comparison must let turn-signal/policy select the channel on both sides.
   A separate forced-channel section (§6b) covers the channel policies behaviourally. */
const CHANNELS = [
  { name: 'surface', message: QUERY, turnExtra: {} },
  { name: 'recall', message: '你还记得那晚显卡驱动更新失败的事吗', turnExtra: {} },
  { name: 'glossary', message: '显卡驱动事故让我有点难受', turnExtra: {} },
  { name: 'coldStart', message: '嗯', turnExtra: { isFirstTurn: true, conversationSignalAvailable: true, conversationId: 'conv-l32' } },
];

const CELLS = [
  { name: 'pinnedFresh', ids: [] },
  { name: 'pinnedCooled', ids: ['pub_pinned_cooled'] },
  { name: 'distance1', ids: ['pub_d1'] },
  { name: 'distance2', ids: ['pub_d2'] },
  { name: 'distance3plus', ids: ['pub_d3'] },
  { name: 'noExposure', ids: [] },
];

/* Desktop option object built EXACTLY as memory.js:189-219 + 231-232 (source-locked).
   `normaliseHeader` is a HARNESS CONTROL, not a production value: the Home Node path
   sets includeHeader:false (memory-retrieval.js:113) while the Desktop path does not
   set it at all (memory.js has no such key) → default true. We measure BOTH. */
function desktopOpts(opts) {
  const settings = { budget: BUDGET, contentLen: CONTENT_LEN }; /* = getMemorySettings() from the same published values */
  return {
    apiId: CHAR,
    now: NOW,
    random: randomDesktop,
    userMessage: opts.userMessage || '',
    isGroup: false,
    groupMemEnabled: false,
    maxChars: settings.budget,
    contentLen: settings.contentLen,
    glossaryProvider: opts.glossaryProvider === undefined ? glossaryProvider : opts.glossaryProvider,
    getGlossaryEntries: undefined,
    turn: {
      message: opts.userMessage,
      conversationId: opts.conversationId == null ? null : String(opts.conversationId),
      isFirstTurn: opts.isFirstTurn === true,
      conversationSignalAvailable: opts.conversationSignalAvailable === true,
      /* NO channelHint: memory.js does not pass one (source-locked above) */
    },
    sessionState: desktopSession,
    turnIndex: TURN_INDEX,
  };
}
/* Home Node options built EXACTLY as services/home-node/memory-retrieval.js:101-138. */
function serverOrchOpts(opts) {
  return {
    apiId: CHAR,
    now: NOW,
    random: randomServer,
    userMessage: opts.userMessage || '',
    isGroup: false,
    groupMemEnabled: false,
    maxChars: BUDGET,
    contentLen: CONTENT_LEN,
    includeHeader: opts.serverIncludeHeader === true,
    sessionState: serverSession,
    turnIndex: TURN_INDEX,
    turn: {
      message: opts.userMessage,
      conversationId: opts.conversationId == null ? null : String(opts.conversationId),
      isFirstTurn: opts.isFirstTurn === true,
      conversationSignalAvailable: opts.conversationSignalAvailable === true,
      /* NO channelHint: memory-retrieval.js buildOpts.turn has no such key */
    },
    /* NOTE (measured, §9): the production Home Node path passes NO glossaryProvider
       (memory-retrieval.js buildOpts has no such key). `serverGlossaryProvider` lets the
       harness compare channel semantics when both sides are given the same provider. */
    glossaryProvider: opts.serverGlossaryProvider,
  };
}

const rowsOut = [];
const divergences = [];
const PARITY_ITEMS = ['eligibleIds', 'scoreOrder', 'seatAssignment', 'explorationDecision', 'finalSelectedIds', 'finalOrder', 'chars', 'reason', 'activationPolicy', 'injectedMemoryIds', 'traceReasons'];

/* true ranked order + score, same function both sides, including the SAME cooldown map */
function factorMapFor(rows, channel, ss) {
  const map = Object.create(null);
  for (const r of rows) {
    if (!r || r.id == null) continue;
    const exposure = ss.getExposure({ characterId: CHAR, memoryId: String(r.id) });
    const res = COOLDOWN.computeCooldown({ channel, currentTurnIndex: TURN_INDEX, exposure });
    if (res.factor < 1) map[String(r.id)] = res.factor;
  }
  return map;
}
function rankOf(rows, opts, channel, ss) {
  const ranked = rankRows(rows, opts, channel, ss);
  if (ranked === null) return null;
  return ranked.map((r) => r.id + ':' + Number(r._score).toFixed(4)).join(',');
}
function rankRows(rows, opts, channel, ss) {
  return CORE.rankMemoryCandidates(rows, {
    apiId: CHAR, now: NOW, userMessage: opts.userMessage || '', isGroup: false, groupMemEnabled: false,
    cooldownFactorsById: factorMapFor(rows, channel, ss),
  });
}
function eligibleOf(rows) {
  return rows.filter((r) => VIS.canReadMemory(r, { kind: 'role', id: CHAR }).ok).map((r) => String(r.id)).sort().join(',');
}
function snapshot(out, rows, opts, channel, ss) {
  const selected = (out.result && Array.isArray(out.result.selected)) ? out.result.selected : [];
  const trace = out.trace || null;
  const candidates = (trace && Array.isArray(trace.candidates)) ? trace.candidates : [];
  return {
    eligibleIds: eligibleOf(rows),
    scoreOrder: rankOf(rows, opts, channel, ss) || 'NULL',
    seatAssignment: selected.map((s) => s.id + ':' + (s.seat || '-')).join(','),
    explorationDecision: (out.meta && Array.isArray(out.meta.injectedMemoryIds)
      ? candidates.filter((c) => (c.reasons || []).indexOf('exploration-selected') >= 0).map((c) => c.memoryId).join(',')
      : '') || 'NONE',
    finalSelectedIds: selected.map((s) => s.id).sort().join(','),
    finalOrder: selected.map((s) => s.id).join(','),
    chars: out.result ? out.result.chars : null,
    reason: out.result ? (out.result.reason == null ? 'null' : String(out.result.reason)) : null,
    activationPolicy: out.meta ? out.meta.activationPolicy : null,
    injectedMemoryIds: out.meta && Array.isArray(out.meta.injectedMemoryIds) ? out.meta.injectedMemoryIds.join(',') : null,
    traceReasons: candidates.map((c) => c.memoryId + ':' + (c.reasons || []).join('+')).join(';'),
    channelResolved: out.meta ? out.meta.channel : null,
  };
}
function diffItems(a, b) { return PARITY_ITEMS.filter((k) => String(a[k]) !== String(b[k])); }

for (const ch of CHANNELS) {
  for (const cell of CELLS) {
    const mk = () => { const ss = seedSessionState(); if (cell.ids.length) ss.recordExposure({ characterId: CHAR, memoryIds: cell.ids, turnIndex: TURN_INDEX - 1 }); return ss; };
    const opts = Object.assign({ userMessage: ch.message }, ch.turnExtra);
    const modes = [
      { mode: 'AS_IS', serverGlossaryProvider: undefined, serverIncludeHeader: false },
      { mode: 'PROVIDER_PARITY', serverGlossaryProvider: glossaryProvider, serverIncludeHeader: false },
      /* FAIR BASIS（P21-R4-LIVE-3.3 重新定义）：两侧都用**桌面/生产**的 header 策略。
         桌面 wrapper 省略该键 ⇒ core 默认 true；新的服务端召回边界显式传
         includeHeader:true（runtime-recall.js 的 retrieve 调用）。因此"公平口径"
         就是"两侧同为 true" —— 这也正是新边界真实使用的策略。 */
      { mode: 'HEADER_NORMALISED', serverGlossaryProvider: glossaryProvider, serverIncludeHeader: true }
    ];
    for (const mode of modes) {
      const dSess = mk(); const sSess = mk();
      const dOpts = desktopOpts(Object.assign({}, opts, { serverGlossaryProvider: mode.serverGlossaryProvider }));
      dOpts.sessionState = dSess; dOpts.random = lcg(20261004);
      const dOut = ORCHESTRATOR.recall(mirrorRoundTrip, dOpts);

      const sOpts = serverOrchOpts(Object.assign({}, opts, {
        serverGlossaryProvider: mode.serverGlossaryProvider,
        serverIncludeHeader: mode.serverIncludeHeader
      }));
      sOpts.sessionState = sSess; sOpts.random = lcg(20261004);
      const sOut = ORCHESTRATOR.recall(canonicalRows, sOpts);

      /* the real Home Node end-to-end wrapper (forwards message + turn signals; no channelHint).
         ★ 次要口径也要**公平**：既然 wrapper 现在会透传 glossary provider（memory-retrieval.js:162）
           与显式 includeHeader（:123），这里就必须把**同一套 seam**交给它，
           否则这 6 条"分歧"量的是"我忘了传参"，而不是 wrapper 的行为。 */
      const sRetrieval = MEM_RETRIEVAL({ store, sessionState: sSess, random: lcg(20261004), clock: () => NOW });
      const sRetrieved = sRetrieval.retrieve(CHAR, {
        userMessage: ch.message, turnIndex: TURN_INDEX,
        conversationId: opts.conversationId, isFirstTurn: opts.isFirstTurn,
        conversationSignalAvailable: opts.conversationSignalAvailable,
        includeHeader: mode.serverIncludeHeader,
        glossaryProvider: mode.serverGlossaryProvider
      });

      const channelForRank = (sOut.meta && sOut.meta.channel) || 'surface';
      const dSnap = snapshot(dOut, mirrorRoundTrip, dOpts, channelForRank, dSess);
      const sSnap = snapshot(sOut, canonicalRows, sOpts, channelForRank, sSess);
      const diffs = diffItems(dSnap, sSnap);
      const retrievalIds = (sRetrieved.selectedIds || []).join(',');
      const desktopIds = (dOut.result.selected || []).map((x) => x.id).join(',');
      const retrievalMatchesDesktop = retrievalIds === desktopIds;
      const row = {
        channel: ch.name, cell: cell.name, mode: mode.mode, channelResolved: sSnap.channelResolved,
        desktopChannelResolved: dSnap.channelResolved,
        diffs, desktop: dSnap, server: sSnap, retrievalMatchesDesktop, retrievalIds,
      };
      rowsOut.push(row);
      if (diffs.length || !retrievalMatchesDesktop) {
        divergences.push({
          channel: ch.name, cell: cell.name, mode: mode.mode,
          items: diffs.concat(retrievalMatchesDesktop ? [] : ['retrieveVsDesktopRecall']),
          desktop: dSnap, server: sSnap, retrievalIds,
          classification: classifyDivergence(ch.name, mode.mode, diffs, !retrievalMatchesDesktop),
        });
      }
    }
  }
}
function classifyDivergence(channel, mode, diffs, retrievalMismatch) {
  if (diffs.length === 1 && diffs[0] === 'chars' && mode !== 'HEADER_NORMALISED') return 'KNOWN_BUDGET_DIFFERENCE (server includeHeader:false vs desktop default true; disappears under HEADER_NORMALISED)';
  if (channel === 'glossary' && mode === 'AS_IS') return 'KNOWN_BUDGET_DIFFERENCE + provider seam (the wrapper now forwards glossaryProvider; residual diffs are the includeHeader policy)';
  if (channel === 'glossary' && retrievalMismatch) return 'KNOWN_BUDGET_DIFFERENCE (end-to-end only: the legacy wrapper still defaults includeHeader:false while the desktop reserves one)';
  if (retrievalMismatch && diffs.length === 0) return 'REAL_SEMANTIC_DIFFERENCE (orchestrator agrees but the production retrieve() wrapper does not — investigate)';
  return 'UNCLASSIFIED — REQUIRES REVIEW';
}
/* Rebased-e2e 分类：先看**差在哪几条 id**，再据此归类，而不是先假定原因。
   ★ 顺序差与集合差必须分开报：两者指向的修复完全不同。 */
function classifyRebasedDivergence(channel, cell, desktopOrder, serverOrder) {
  const d = desktopOrder ? desktopOrder.split(',') : [];
  const s = serverOrder ? serverOrder.split(',') : [];
  const desktopOnly = d.filter((x) => s.indexOf(x) < 0);
  const serverOnly = s.filter((x) => d.indexOf(x) < 0);
  if (desktopOnly.length || serverOnly.length) {
    return 'REAL_SEMANTIC_DIFFERENCE (SET): desktopOnly=' + J(desktopOnly) + ' serverOnly=' + J(serverOnly)
      + '. SIDE THAT MUST CHANGE: SERVER (the boundary must reproduce the desktop candidate set).';
  }
  if (d.join(',') !== s.join(',')) {
    const reordered = d.filter((x, i) => s[i] !== x);
    return 'REAL_SEMANTIC_DIFFERENCE (ORDER only, identical set): reordered=' + J(reordered)
      + '. ROOT CAUSE (measured): the recall boundary calls retrieve() with NO turnIndex '
      + '(runtime-recall.js:481-484 passes budget/random/sessionState as wrapper construction deps and '
      + 'deliberately omits turnIndex), so session cooldown is INERT server-side: every candidate keeps '
      + 'factor 1 and a cooled pinned candidate is not demoted, while the desktop applies the seeded '
      + 'exposure distances. SIDE THAT MUST CHANGE: SERVER — supply an authoritative turn index on that '
      + 'retrieve() call (read-only, derived from the injected session state), OR have the contract '
      + 'declare this boundary cooldown-free and pin cooldown OFF on BOTH sides of the parity basis.';
  }
  return 'UNCLASSIFIED — REQUIRES REVIEW';
}

/* ── §6b forced-channel behavioural coverage ───────────────────────────
   Neither production wrapper plumbs `channelHint`; forcing it is a harness
   construction (both sides forced identically) used to exercise every channel
   policy end to end. Results feed §9 coverage; they are NOT production reachability. */
const forcedRows = [];
for (const ch of CHANNELS) {
  const dSess = seedSessionState(); const sSess = seedSessionState();
  const base = { userMessage: ch.message };
  const dOpts = desktopOpts(Object.assign({}, base, { serverGlossaryProvider: glossaryProvider }));
  dOpts.turn.channelHint = ch.name; dOpts.sessionState = dSess; dOpts.random = lcg(20261004); dOpts.includeHeader = false;
  const sOpts = serverOrchOpts(Object.assign({}, base, { serverGlossaryProvider: glossaryProvider }));
  sOpts.turn.channelHint = ch.name; sOpts.sessionState = sSess; sOpts.random = lcg(20261004);
  const dOut = ORCHESTRATOR.recall(mirrorRoundTrip, dOpts);
  const sOut = ORCHESTRATOR.recall(canonicalRows, sOpts);
  const dSnap = snapshot(dOut, mirrorRoundTrip, dOpts, ch.name, dSess);
  const sSnap = snapshot(sOut, canonicalRows, sOpts, ch.name, sSess);
  forcedRows.push({ channel: ch.name, diffs: diffItems(dSnap, sSnap), desktop: dSnap, server: sSnap, desktopChannel: dSnap.channelResolved, serverChannel: sSnap.channelResolved });
  if (dSnap.channelResolved !== ch.name || sSnap.channelResolved !== ch.name) {
    divergences.push({ channel: ch.name, cell: 'FORCED', mode: 'FORCED_CHANNEL', items: ['channelNotReached'], desktop: dSnap, server: sSnap, retrievalIds: null, classification: 'HARNESS or POLICY: forced channel did not resolve' });
  } else if (dSnap.activationPolicy !== sSnap.activationPolicy) {
    divergences.push({ channel: ch.name, cell: 'FORCED', mode: 'FORCED_CHANNEL', items: ['activationPolicy'], desktop: dSnap, server: sSnap, retrievalIds: null, classification: 'REAL_SEMANTIC_DIFFERENCE' });
  }
}
P('FORCED_CHANNEL_ACTIVATION', JSON.stringify(Object.fromEntries(forcedRows.map((r) => [r.channel, r.server.activationPolicy]))));
P('FORCED_CHANNEL_CHAR_MATCH', forcedRows.every((r) => r.desktop.chars === r.server.chars) ? 'YES' : 'NO');

/* Per-item lines. The parity verdict is computed on the FAIR comparison:

   PROVIDER_PARITY + HEADER_NORMALISED (identical provider seam, identical header policy).
   AS_IS is reported separately as the production-shaped delta. */
const fairRows = rowsOut.filter((r) => r.mode === 'HEADER_NORMALISED');
const asIsRows = rowsOut.filter((r) => r.mode === 'AS_IS');
const providerRows = rowsOut.filter((r) => r.mode === 'PROVIDER_PARITY');
const first = fairRows[0];
for (const item of PARITY_ITEMS) {
  const mismatched = fairRows.filter((r) => r.diffs.indexOf(item) >= 0).length;
  P('PARITY_' + item.toUpperCase(), (mismatched === 0 ? 'MATCH' : 'DIVERGE(' + mismatched + '/' + fairRows.length + ')') + '  desktop[' + first.desktop[item] + '] server[' + first.server[item] + ']');
}
const totalCells = rowsOut.length;
const cleanCells = fairRows.filter((r) => r.diffs.length === 0).length;
const fairTotal = fairRows.length;
const retrievalParityCells = fairRows.filter((r) => r.retrievalMatchesDesktop).length;
const asIsCharsOnly = asIsRows.filter((r) => r.diffs.length === 1 && r.diffs[0] === 'chars').length;
const asIsOther = asIsRows.filter((r) => !(r.diffs.length === 1 && r.diffs[0] === 'chars'));
P('PARITY_CELLS', totalCells + ' (' + fairTotal + ' fair / ' + asIsRows.length + ' as-is / ' + providerRows.length + ' provider-parity)');
P('PARITY_CELLS_IDENTICAL', cleanCells + '/' + fairTotal);
P('PARITY_RETRIEVE_VS_DESKTOP_CELLS', retrievalParityCells + '/' + fairTotal);
P('PARITY_AS_IS_CHARS_ONLY_DIVERGENCE', asIsCharsOnly + '/' + asIsRows.length);
P('PARITY_AS_IS_OTHER_DIVERGENCE', asIsOther.length);

/* channel coverage assertions (§9): cooldown mode + exploration policy + activation semantics */
section('§9 channel coverage');
const chanSeen = {};
for (const r of fairRows) chanSeen[r.channelResolved] = (chanSeen[r.channelResolved] || 0) + 1;
const desktopChanSeen = {};
for (const r of fairRows) desktopChanSeen[r.desktopChannelResolved] = (desktopChanSeen[r.desktopChannelResolved] || 0) + 1;
check('§9.1 all four channels were exercised on BOTH sides', ['surface', 'recall', 'glossary', 'coldStart'].every((c) => chanSeen[c] > 0 && desktopChanSeen[c] > 0), 'server=' + JSON.stringify(chanSeen) + ' desktop=' + JSON.stringify(desktopChanSeen));
const forcedSeen = Object.fromEntries(forcedRows.map((r) => [r.channel, r.serverChannel + '|' + r.desktopChannel]));
check('§9.1b all four channels resolve identically under an identical forced hint', forcedRows.every((r) => r.serverChannel === r.channel && r.desktopChannel === r.channel), JSON.stringify(forcedSeen));
check('§9.1c activation semantics agree per channel (coldStart none, others normal)',
  forcedRows.every((r) => r.desktop.activationPolicy === r.server.activationPolicy)
  && forcedRows.find((r) => r.channel === 'coldStart').server.activationPolicy === 'none'
  && forcedRows.filter((r) => r.channel !== 'coldStart').every((r) => r.server.activationPolicy === 'normal'),
  JSON.stringify(Object.fromEntries(forcedRows.map((r) => [r.channel, r.server.activationPolicy]))));
for (const c of ['surface', 'recall', 'glossary', 'coldStart']) {
  const pol = CHANNEL_POLICY.resolveChannelPolicy(c);
  check('§9.2 channel policy present: ' + c, pol && pol.ok === true, JSON.stringify(pol && pol.policy));
}
const cdModes = { surface: 'obey', recall: 'bypass', glossary: 'bypass', coldStart: 'read-none' };
let cdOk = true;
for (const [ch, mode] of Object.entries(cdModes)) if (COOLDOWN.modeOf(ch) !== mode) cdOk = false;
check('§9.3 cooldown mode per channel matches the frozen semantics', cdOk, JSON.stringify(Object.fromEntries(Object.keys(cdModes).map((c) => [c, COOLDOWN.modeOf(c)]))));
P('CHANNEL_COVERAGE', JSON.stringify(chanSeen));

/* cooldown factors measured identically on both sides (§10) */
section('§10 pin / cooldown grid');
const cdProbe = (exposureTurnIndex, channel) => COOLDOWN.computeCooldown({ channel, currentTurnIndex: TURN_INDEX, exposure: exposureTurnIndex == null ? null : { lastExposureTurn: exposureTurnIndex, exposureCount: 1 } });
const factors = {
  noExposure: cdProbe(null, 'surface').factor,
  distance1: cdProbe(TURN_INDEX - 1, 'surface').factor,
  distance2: cdProbe(TURN_INDEX - 2, 'surface').factor,
  distance3plus: cdProbe(TURN_INDEX - 3, 'surface').factor,
  recallBypass: cdProbe(TURN_INDEX - 1, 'recall').factor,
  coldStartReadNone: cdProbe(TURN_INDEX - 1, 'coldStart').factor,
};
check('§10.1 frozen cooldown factors: d1=0.40 d2=0.70 d>=3=1', factors.distance1 === 0.4 && factors.distance2 === 0.7 && factors.distance3plus === 1, JSON.stringify(factors));
check('§10.2 recall bypass and coldStart read-none are factor 1', factors.recallBypass === 1 && factors.coldStartReadNone === 1);
const pfRow = fairRows.find((r) => r.channel === 'surface' && r.cell === 'pinnedFresh');
const pcRow = fairRows.find((r) => r.channel === 'surface' && r.cell === 'pinnedCooled');
const seatOf = (row, id, side) => {
  if (!row) return null;
  const snap = row[side || 'desktop'] || {};
  const hit = String(snap.seatAssignment || '').split(',').find((x) => x.indexOf(id + ':') === 0);
  return hit ? hit.split(':')[1] : null;
};
const freshSeat = seatOf(pfRow, 'pub_fresh');
const cooledSeat = seatOf(pcRow, 'pub_pinned_cooled');
/* R2-F1b frozen semantics: a cooled pinned row falls into the NORMAL loop for scoring
   (_effPinned === false) and must not be an exploration pick, but its seat IDENTITY
   stays 'pinned' (memory-retrieval-core.js:249-250 “seat 身份不变”). */
const pcRows = rankRows(canonicalRows, { userMessage: QUERY }, 'surface', (() => { const ss = seedSessionState(); ss.recordExposure({ characterId: CHAR, memoryIds: ['pub_pinned_cooled'], turnIndex: TURN_INDEX - 1 }); return ss; })()) || [];
const pcEntry = pcRows.find((r) => r.id === 'pub_pinned_cooled') || {};
check('§10.3 a freshly pinned row (no exposure) is effectively pinned and takes the pinned seat', freshSeat === 'pinned' && (rankRows(canonicalRows, { userMessage: QUERY }, 'surface', seedSessionState()) || []).find((r) => r.id === 'pub_fresh')._effPinned === true, 'pub_fresh seat=' + freshSeat);
check('§10.4 a cooled pinned row (distance 1) leaves the pinned fast path but keeps its seat identity', pcEntry._effPinned === false && pcEntry._cooldownFactor === 0.4 && cooledSeat === 'pinned', 'effPinned=' + pcEntry._effPinned + ' factor=' + pcEntry._cooldownFactor + ' seat=' + cooledSeat);
check('§10.5 both sides agree on those seats in the same cell', pfRow && pcRow && pfRow.diffs.indexOf('seatAssignment') < 0 && pcRow.diffs.indexOf('seatAssignment') < 0);
P('COOLDOWN_FACTORS', JSON.stringify(factors));
P('PIN_COOLDOWN_GRID_CELLS', CELLS.map((c) => c.name).join(','));

/* ══════════════════════════════════════════════════════════════════════
   §7 · STALE MIRROR (§5) — parity NOT required here
   ══════════════════════════════════════════════════════════════════════ */
section('§7 stale mirror: canonical wins');
const staleDir = freshDir('ib-l32-stale-');
const staleStore = MEM_STORE({ dataDir: staleDir, logger: () => {} });
staleStore.open();
staleStore.setMemorySettings({ budget: BUDGET, contentLen: CONTENT_LEN });
for (const r of SEED) staleStore.putRecord(r);
for (const r of canonicalRows) { /* nothing */ }
staleStore.putRecord(mkRecord('canonical_extra', { content: '显卡 驱动 更新失败 canonical extra only' }));
staleStore.putRecord(Object.assign({}, canonicalRows.find((r) => r.id === 'pub_fresh'), { content: '显卡 驱动 更新失败 canonical newer revision' }));
const staleCanonical = staleStore.listRecords({}).records;
const staleMirror = canonicalRows.map(toMirrorRecord);
const staleMirrorMissing = staleMirror.filter((r) => r.id !== 'pub_fresh');
staleMirrorMissing.push(Object.assign({}, canonicalRows.find((r) => r.id === 'pub_fresh'), { content: '显卡 驱动 更新失败 MIRROR OLD revision' }));
staleMirrorMissing.push(mkRecord('mirror_only_row', { content: '显卡 驱动 更新失败 mirror only row' }));

function runPair(recordsForServer, recordsForDesktop, label) {
  const ssS = seedSessionState(); const ssD = seedSessionState();
  const sOut = ORCHESTRATOR.recall(recordsForServer, Object.assign(serverOrchOpts({ userMessage: QUERY }), { sessionState: ssS, random: lcg(7) }));
  const dOut = ORCHESTRATOR.recall(recordsForDesktop, Object.assign(desktopOpts({ userMessage: QUERY }), { sessionState: ssD, random: lcg(7) }));
  const sIds = (sOut.result.selected || []).map((x) => x.id);
  const dIds = (dOut.result.selected || []).map((x) => x.id);
  return { label, canonicalSelected: sIds, mirrorSelected: dIds, divergent: JSON.stringify(sIds) !== JSON.stringify(dIds), canonicalExtraIncluded: sIds.includes('canonical_extra'), canonicalNewerContentUsed: sIds.includes('pub_fresh') };
}
const caseA = runPair(staleCanonical, staleMirror, 'canonical-extra-row + newer-revision (mirror stale, same set)');
const caseB = runPair(staleCanonical, staleMirrorMissing, 'mirror missing row + mirror-only row + old revision');
P('STALE_CASE_A_DIVERGENT', caseA.divergent ? 'YES' : 'NO');
P('STALE_CASE_B_DIVERGENT', caseB.divergent ? 'YES' : 'NO');
P('CANONICAL_HOME_NODE_WINS', 'YES');
check('§7.1 at least one stale configuration diverges from canonical (proving staleness is observable)', caseA.divergent || caseB.divergent, JSON.stringify([caseA, caseB]));
check('§7.2 hydrated (non-stale) mirror does NOT diverge for the same set', !runPair(staleCanonical.filter((r) => r.id !== 'canonical_extra'), staleCanonical.filter((r) => r.id !== 'canonical_extra').map(toMirrorRecord), 'hydrated').divergent);

/* ══════════════════════════════════════════════════════════════════════
   §7b · does the header/budget difference change the SET? (tight budget)
   ══════════════════════════════════════════════════════════════════════ */
section('§7b header/budget consequence under a tight budget');
const TIGHT = 200;
const idsOfOut = (o) => (o.result.selected || []).map((x) => x.id).join(',');
const tightPairs = [];
for (const tight of [200, 300, 400]) {
  const dS = seedSessionState(), sS = seedSessionState();
  const dO = desktopOpts({ userMessage: QUERY }); dO.maxChars = tight; dO.sessionState = dS; dO.random = lcg(3);
  const sO = serverOrchOpts({ userMessage: QUERY }); sO.maxChars = tight; sO.sessionState = sS; sO.random = lcg(3);
  /* 与 FAIR BASIS 同一策略：新的服务端召回边界显式 includeHeader:true
     （runtime-recall.js 的 retrieve 调用），桌面 wrapper 省略该键 ⇒ 默认 true。
     因此紧预算探针也必须两侧同为 true，否则它测的是"移动端默认"而不是边界。 */
  sO.includeHeader = true;
  const dR = ORCHESTRATOR.recall(mirrorRoundTrip, dO);
  const sR = ORCHESTRATOR.recall(canonicalRows, sO);
  tightPairs.push({ maxChars: tight, desktopIds: idsOfOut(dR), serverIds: idsOfOut(sR), diverges: idsOfOut(dR) !== idsOfOut(sR), desktopChars: dR.result.chars, serverChars: sR.result.chars });
}
P('TIGHT_BUDGET_PROBE', JSON.stringify(tightPairs));
P('TIGHT_BUDGET_SELECTION_DIVERGES', tightPairs.some((p) => p.diverges) ? 'YES' : 'NO');
/* 反控（已知、已分类的移动端默认差异）：服务端**不**显式 includeHeader 时，
   紧预算下的集合与桌面不同 —— 这条**不**进入 fair divergence 计数，
   它只是把"header 是预算语义"这件事如实记下来。 */
const mobileDefaultPairs = [200, 300, 400].map((tight) => {
  const dO = desktopOpts({ userMessage: QUERY }); dO.maxChars = tight; dO.sessionState = seedSessionState(); dO.random = lcg(3);
  const sO = serverOrchOpts({ userMessage: QUERY }); sO.maxChars = tight; sO.sessionState = seedSessionState(); sO.random = lcg(3);
  sO.includeHeader = false;
  const dR = ORCHESTRATOR.recall(mirrorRoundTrip, dO);
  const sR = ORCHESTRATOR.recall(canonicalRows, sO);
  return { maxChars: tight, desktopIds: idsOfOut(dR), mobileDefaultIds: idsOfOut(sR), diverges: idsOfOut(dR) !== idsOfOut(sR) };
});
P('TIGHT_BUDGET_MOBILE_DEFAULT_PROBE', JSON.stringify(mobileDefaultPairs));
if (tightPairs.some((p) => p.diverges)) {
  divergences.push({ channel: 'surface', cell: 'tightBudget', mode: 'TIGHT_BUDGET', items: ['finalSelectedIds'], desktop: tightPairs[0], server: tightPairs[0], retrievalIds: null, classification: 'REAL_SEMANTIC_DIFFERENCE (identical includeHeader policy on both sides but the selected SET still differs under a tight budget)' });
}

/* ══════════════════════════════════════════════════════════════════════
   §6c · REBASED END-TO-END BASIS (P21-R4-LIVE-3.3)
   ──────────────────────────────────────────────────────────────────────
   旧口径的 e2e 比的是 `MEM_RETRIEVAL.retrieve()` —— 那是**内部 wrapper**，
   不是这一阶段正在闭合的**边界**。新口径把服务端一侧换成真实的新服务
   `services/home-node/runtime-recall.js`（`POST /internal/runtime/memory-recall`
   的 in-process 形态），于是"端到端"终于等于"桌面召回 vs 服务端召回边界"。

   两套口径**都报**（旧口径保留为对照，因为它证明 wrapper 与边界之间的差别
   究竟来自哪一层）。新服务是 async，因此这一段是 async IIFE，§8 的结果块
   一并搬进来。
   ══════════════════════════════════════════════════════════════════════ */
const RUNTIME_RECALL_FILE = 'services/home-node/runtime-recall.js';
let RUNTIME_RECALL = null, RUNTIME_RECALL_ERROR = null;
try { RUNTIME_RECALL = require(path.join(ROOT, RUNTIME_RECALL_FILE)); }
catch (e) { RUNTIME_RECALL_ERROR = e; }

(async function rebasedEndToEnd() {
  section('§6c rebased end-to-end basis (new server recall boundary)');
  const recallBoundaryOk = !!RUNTIME_RECALL && typeof RUNTIME_RECALL === 'function';
  check('§6c.0 services/home-node/runtime-recall.js is on disk and exports a factory',
    recallBoundaryOk,
    recallBoundaryOk ? ('loaded ' + RUNTIME_RECALL_FILE + ' path=' + RUNTIME_RECALL.PATH)
      : (RUNTIME_RECALL_ERROR ? String(RUNTIME_RECALL_ERROR.message) : 'factory export missing'));

  const newServiceRows = [];
  let rebasedE2eMatches = 0, rebasedE2eTotal = 0;
  if (recallBoundaryOk) {
    /* 服务端的 turn 身份来源：requestId + conversationId（与 mobile 同构）。 */
    const recallRegistry = {
      getCharacter(id) { return id === CHAR ? { id: CHAR, dto: { id: CHAR, nickname: 'A' } } : null; },
      getCharacterSpec(id) {
        return id === CHAR
          ? { provider: 'custom', model: 'red-model', endpoint: 'http://127.0.0.1:1/v1/chat/completions', credentialRef: 'c' }
          : null;
      }
    };
    for (const ch of CHANNELS) {
      for (const cell of CELLS) {
        /* 桌面侧：与 §6 完全同构地重建（同一 seed ⇒ 同一结果）。 */
        const dSess = (() => { const ss = seedSessionState(); if (cell.ids.length) ss.recordExposure({ characterId: CHAR, memoryIds: cell.ids, turnIndex: TURN_INDEX - 1 }); return ss; })();
        const dOpts = desktopOpts(Object.assign({ userMessage: ch.message }, ch.turnExtra));
        dOpts.sessionState = dSess; dOpts.random = lcg(20261004);
        const dOut = ORCHESTRATOR.recall(mirrorRoundTrip, dOpts);
        const desktopOrder = (dOut.result.selected || []).map((x) => x.id).join(',');

        /* 服务端：**新边界**（in-process），同一批 canonical 行、同一随机源。 */
        const sSess = (() => { const ss = seedSessionState(); if (cell.ids.length) ss.recordExposure({ characterId: CHAR, memoryIds: cell.ids, turnIndex: TURN_INDEX - 1 }); return ss; })();
        const boundary = RUNTIME_RECALL({
          memoryRetrieval: MEM_RETRIEVAL({ store, sessionState: sSess, random: lcg(20261004), clock: () => NOW }),
          memoryStore: store, registry: recallRegistry, sessionState: sSess,
          /* 与桌面侧**同一个** glossary provider 实例：通道对等的前提是
             "两侧拿到同一个 seam"（runtime-recall.js:173 的装配注入点）。 */
          glossaryProvider: glossaryProvider,
          clock: () => NOW, random: lcg(20261004), logger: () => {}
        });
        const requestId = 'parity_' + ch.name + '_' + cell.name;
        const res = await boundary.run({
          operation: 'memory-recall', characterId: CHAR,
          requestId: requestId, conversationId: 'dm:' + CHAR,
          message: ch.message,
          isFirstTurn: ch.turnExtra.isFirstTurn === true,
          conversationSignalAvailable: ch.turnExtra.conversationSignalAvailable === true
        }, {});
        const serverOrder = (res && Array.isArray(res.selectedIds)) ? res.selectedIds.join(',') : 'ERROR:' + (res && res.error);
        const match = res && res.ok === true && serverOrder === desktopOrder;
        rebasedE2eTotal += 1;
        if (match) rebasedE2eMatches += 1;
        newServiceRows.push({ channel: ch.name, cell: cell.name, desktopOrder, serverOrder, match, error: res && res.error });
        check('§6c.' + ch.name + '.' + cell.name, match,
          'desktop[' + desktopOrder + '] boundary[' + serverOrder + ']'
          + (res && res.ok === false ? ' error=' + res.error : ''));
        if (!match) {
          divergences.push({
            channel: ch.name, cell: cell.name, mode: 'REBASED_E2E',
            items: ['finalSelectedIds'], desktop: { finalOrder: desktopOrder },
            server: { finalOrder: serverOrder }, retrievalIds: serverOrder,
            classification: (res && res.ok === false)
              ? 'BOUNDARY_ERROR: the new recall service refused a well-formed request (' + res.error + ')'
              : classifyRebasedDivergence(ch.name, cell, desktopOrder, serverOrder)
          });
        }
      }
    }
  }
  P('PARITY_CELLS_REBASED_E2E', rebasedE2eMatches + '/' + rebasedE2eTotal);

  /* ══════════════════════════════════════════════════════════════════════
     §8 · RESULT（旧口径 + 新口径**都**报）
     ══════════════════════════════════════════════════════════════════════ */
  section('§8 result');
  const fairDivergences = divergences.filter((d) => d.mode === 'HEADER_NORMALISED' && d.items.join(',') !== 'retrieveVsDesktopRecall');
  const asIsDivergences = divergences.filter((d) => d.mode === 'AS_IS');
  const e2eDivergences = divergences.filter((d) => d.mode === 'HEADER_NORMALISED' && d.items.indexOf('retrieveVsDesktopRecall') >= 0);
  const rebasedDivergences = divergences.filter((d) => d.mode === 'REBASED_E2E');
  const selectionStageParity = fairDivergences.length === 0;
  const e2eParity = retrievalParityCells === fairTotal;
  const rebasedE2eParity = rebasedE2eTotal > 0 && rebasedE2eMatches === rebasedE2eTotal;
  const parityVerdict = (selectionStageParity && rebasedE2eParity) ? 'YES'
    : (selectionStageParity ? 'PARTIAL' : 'NO');
  P('RECALL_SELECTION_PARITY', parityVerdict);
  P('RECALL_SELECTION_SELECTION_STAGE_PARITY', selectionStageParity ? 'YES' : 'NO');
  P('RECALL_SELECTION_END_TO_END_PARITY', rebasedE2eParity ? 'YES' : 'PARTIAL (' + rebasedE2eMatches + '/' + rebasedE2eTotal + ')');
  P('RECALL_SELECTION_END_TO_END_PARITY_LEGACY_WRAPPER', e2eParity ? 'YES' : 'PARTIAL (' + retrievalParityCells + '/' + fairTotal + ')');
  P('RECALL_SELECTION_PARITY_BASIS', 'selection stage = PROVIDER_PARITY + HEADER_ALIGNED orchestrator comparison; '
    + 'e2e = the NEW server recall boundary (services/home-node/runtime-recall.js) vs the desktop-boundary recall; '
    + 'legacy wrapper (`memory-retrieval.js#retrieve`) kept as a second, labelled number');
  P('RECALL_SELECTION_PARITY_DIVERGENCES_SELECTION_STAGE', fairDivergences.length);
  P('RECALL_SELECTION_PARITY_DIVERGENCES_END_TO_END', rebasedDivergences.length);
  P('RECALL_SELECTION_PARITY_DIVERGENCES_LEGACY_WRAPPER', e2eDivergences.length);
  P('RECALL_SELECTION_PARITY_DIVERGENCES_AS_IS', asIsDivergences.length);
  for (const d of divergences) console.log('  DIVERGENCE [' + d.mode + '] ' + d.channel + '/' + d.cell + ' :: ' + d.items.join(',') + '  → ' + d.classification);
  const unclassified = divergences.filter((d) => d.classification.indexOf('UNCLASSIFIED') === 0);
  P('RECALL_SELECTION_PARITY_UNCLASSIFIED_DIVERGENCES', unclassified.length);
  check('§8.1 every divergence is classified (harness artifact vs real semantic difference)', unclassified.length === 0,
    unclassified.map((d) => d.channel + '/' + d.cell + '/' + d.mode).join(','));

  /* machine-readable artifact */
  const artifact = {
    phase: 'P21-R4-LIVE-3.3',
    generatedAt: new Date().toISOString(),
    moduleIdentity: { allSame: identityRows.every((r) => r.samePath && r.browserScriptTag), rows: identityRows, depIdentity, orchestratorSha256: sha256File(path.join(ROOT, ORCH_FILE)) },
    sourceLock: { pickStart: pickStart + 1, pickEnd: pickEnd + 1, callLine: callLine + 1, mirrorLine: mirrorLine + 1, keys: pickKeys, turnKeys },
    fixture: { rows: canonicalRows.length, eligibleIds: eligibleCanonical, roundTripLossless: roundTripDiff.length === 0 },
    controls: { now: NOW, turnIndex: TURN_INDEX, randomSeed: 20261004, exposures: desktopSession.debugSize() },
    channels: { server: chanSeen, desktop: desktopChanSeen },
    cooldownFactors: factors,
    cells: rowsOut,
    rebasedCells: newServiceRows,
    divergences,
    divergenceClassifications: Array.from(new Set(divergences.map((d) => d.classification))),
    parity: {
      verdict: parityVerdict, fairCells: fairTotal, fairIdentical: cleanCells,
      asIsCharsOnlyDivergence: asIsCharsOnly, asIsOtherDivergence: asIsOther.length,
      retrieveVsDesktopCells: retrievalParityCells,
      rebasedE2eCells: rebasedE2eMatches, rebasedE2eTotal: rebasedE2eTotal
    },
    staleMirror: { caseA, caseB, canonicalWins: true },
    checks: results.checks,
    pass: results.pass, fail: results.fail
  };
  /* ★ 诊断产物**不得**成为判据：`git archive` 出来的干净树没有 `.dsh-research/`，
     而一个已经跑完全部断言的套件不该在最后一行因为"写不出诊断 JSON"而崩掉
     （P21-R4-LIVE-3.2 的 baseline-parity 复核正是在那里发现了这一点）。 */
  try {
    const artifactDir = path.join(ROOT, '.dsh-research');
    fs.mkdirSync(artifactDir, { recursive: true });
    fs.writeFileSync(path.join(artifactDir, 'r4c-live-3-3-parity.json'), JSON.stringify(artifact, null, 2));
  } catch (e) {
    console.log('  DIAG  parity artifact not written (' + String((e && e.message) || e) + ') — diagnostic only, not a verdict');
  }

  console.log('\n' + (results.fail === 0 ? 'R4C LIVE-3.3 RECALL PARITY HARNESS PASSED' : 'R4C LIVE-3.3 RECALL PARITY HARNESS FAILED')
    + ' · ' + results.pass + ' passed / ' + results.fail + ' failed · cells=' + totalCells + ' identical=' + cleanCells
    + ' · rebasedE2E=' + rebasedE2eMatches + '/' + rebasedE2eTotal);
  try { store.close(); } catch (_) { /* 已关闭 */ }
  try { staleStore.close(); } catch (_) { /* 已关闭 */ }
  process.exit(results.fail === 0 ? 0 : 1);
})().catch((error) => {
  console.error('R4C LIVE-3.3 RECALL PARITY HARNESS CRASHED · ' + String((error && error.stack) || error));
  try { store.close(); } catch (_) { /* 已关闭 */ }
  process.exit(1);
});
