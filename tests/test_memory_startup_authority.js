'use strict';
/* ══════════════════════════════════════════════════════════════════════════
   Internal Beyond · P21-R4-A.6 · Startup Memory Authority Health
   （Node，零依赖，零浏览器，零网络 —— 真实 bootstrap 代码片段 + 真实 HTML 顺序）

   运行：node tests/test_memory_startup_authority.js

   ── 要闭合的缺口 ────────────────────────────────────────────────────
   `home-node-bootstrap.js` 在安装 `window.dbPut` / `window.dbDelete` 覆盖**之前**
   有三处整体 early-return。早退之后：
       memoryAuthority = null  AND  override = NOT INSTALLED
   ⇒ `dbPut('memories', …)` 继续解析到**原始 IndexedDB writer** ⇒ 即使
   `ibHomeNodeMode() === 'canonical'` 也会静默产生 browser-local memory truth。

   A.5 修的是"覆盖已安装 + authority 缺席"（`memory-authority-unavailable`）。
   本轮修的是"覆盖**根本没安装**"：在**任何依赖检查之前**装一道 provisional
   canonical memory guard，并给三个早退点补上稳定 reason code 与降级面。

   ── 与 A.5 的关系（不重复、不冲突）──────────────────────────────────
     · provisional guard 只负责"覆盖未安装"的窗口；
     · 正式覆盖一旦安装就**直接赋值替换**它（不是套娃）；
     · 正式覆盖内部的 A.5 守卫继续负责"覆盖已安装 + authority 缺席"。
   两层守卫覆盖的是两个**互斥**的窗口，没有重叠也没有空隙。

   零网络：所有 remote 都是替身；store 相关断言由 A.4 的真实 SQLite 测试承担。
   ══════════════════════════════════════════════════════════════════════════ */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const WIRING = require('./helpers/activation-wiring-probe.js');

let passed = 0;
let failures = 0;
const check = (name, cond, detail) => {
  if (cond) { passed++; console.log('  PASS  ' + name); return true; }
  failures++;
  console.error('  FAIL  ' + name + (detail ? '  -> ' + detail : ''));
  return false;
};
const section = t => console.log('\n── ' + t + ' ──');

/* ── 真实源码（CRLF 归一化）────────────────────────────────────────────── */
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
const BOOT = read('assets/js/home-node-bootstrap.js');
const BOOT_CODE = WIRING.stripJsComments(BOOT);
const HTML = read('InternalBeyond.html');

function sliceBlock(source, startRe, endRe) {
  const lines = source.split('\n');
  let s = -1;
  for (let i = 0; i < lines.length; i++) {
    if (s < 0) { if (startRe.test(lines[i])) s = i; continue; }
    if (endRe.test(lines[i])) return lines.slice(s, i + 1).join('\n');
  }
  return null;
}
const singleLine = (source, re) => source.split('\n').find(l => re.test(l)) || null;

/* ── 切片 ─────────────────────────────────────────────────────────────── */
const TOP_BLOCK = sliceBlock(BOOT_CODE, /^function bootNote\(event, fields\) \{/, /^\}\)\(\);$/);
const ATTEMPTS = sliceBlock(BOOT_CODE, /^var MIRROR_WRITE_ATTEMPTS = \d+;$/, /^var RETRY_BASE_MS = \d+;$/);
const WITH_RETRY = sliceBlock(BOOT_CODE, /^function withRetry\(fn, attempts\) \{$/, /^\}$/);
const THROW_WRITE_ERR = sliceBlock(BOOT_CODE, /^function throwWriteError\(result, fallbackId\) \{$/, /^\}$/);
const IS_MEMORY_STORE = singleLine(BOOT_CODE, /^function isMemoryStore\(store\)/);
const DB_PUT = sliceBlock(BOOT_CODE, /^window\.dbPut = function \(store, data\) \{$/, /^\};$/);
const DB_DELETE = sliceBlock(BOOT_CODE, /^window\.dbDelete = function \(store, key\) \{$/, /^\};$/);

check('S1.allSlicesExtracted',
  [TOP_BLOCK, ATTEMPTS, WITH_RETRY, THROW_WRITE_ERR, IS_MEMORY_STORE, DB_PUT, DB_DELETE]
    .every(s => typeof s === 'string' && s.length > 0),
  'every real bootstrap block must be sliceable (missing: '
  + JSON.stringify([['TOP_BLOCK', TOP_BLOCK], ['ATTEMPTS', ATTEMPTS], ['WITH_RETRY', WITH_RETRY],
    ['THROW_WRITE_ERR', THROW_WRITE_ERR], ['IS_MEMORY_STORE', IS_MEMORY_STORE],
    ['DB_PUT', DB_PUT], ['DB_DELETE', DB_DELETE]].filter(p => !p[1]).map(p => p[0])) + ')');

/* ── harness：在同一 vm 上下文里依次执行 provisional guard → 正式覆盖 ──── */
function makeHarness(options) {
  const opts = options || {};
  const calls = { originalPut: 0, originalDel: 0, authorityPut: 0, authorityRemove: 0, remotePut: 0 };
  const rows = new Map();
  const log = [];

  const windowStub = {
    dbPut: function (store, data) { calls.originalPut++; rows.set(store + ':' + (data && data.id), data); return Promise.resolve(undefined); },
    dbDelete: function (store, key) { calls.originalDel++; rows.delete(store + ':' + key); return Promise.resolve(undefined); },
    localConsole: null
  };
  if (opts.mode !== undefined && opts.mode !== null) windowStub.ibHomeNodeMode = function () { return opts.mode; };
  const NS = {};

  const sandbox = {
    window: windowStub,
    NS: NS,
    location: { protocol: opts.protocol || 'http:' },
    console: { warn: function (event, fields) { log.push({ event: String(event), fields: fields }); } },
    Promise: Promise, Object: Object, Array: Array, String: String, Error: Error, Date: Date,
    setTimeout: function (fn) { return setTimeout(fn, 0); }
  };
  /* 供正式覆盖使用 */
  sandbox.memoryAuthority = opts.memoryAuthority === undefined ? null : opts.memoryAuthority;
  sandbox.note = function () {};
  sandbox.isChatStore = function (store) { return store === 'chatMessages'; };
  sandbox.isUnderstandingStore = function () { return false; };
  sandbox.isMomentsStore = function () { return false; };
  sandbox.understandingWriteClosed = function () { return false; };
  sandbox.momentsWriteClosed = function () { return false; };
  sandbox.MODE = opts.bootstrapMode || 'canonical';
  sandbox.original = null;
  sandbox.authority = { put: function () { return Promise.resolve({ ok: true }); } };

  /* 阶段 1：真实 provisional guard（含 bootNote / canonicalMemoryIntended / 降级面） */
  vm.runInNewContext(TOP_BLOCK + '\n', sandbox, { timeout: 10000 });
  const afterGuard = { dbPut: windowStub.dbPut, dbDelete: windowStub.dbDelete };

  /* 阶段 2（可选）：真实正式覆盖 —— 直接赋值替换 guard */
  let fullInstalled = false;
  if (opts.installFullOverride) {
    const body = [ATTEMPTS, WITH_RETRY, THROW_WRITE_ERR, IS_MEMORY_STORE,
      'var original = { put: window.dbPut, del: window.dbDelete };',
      'NS.homeNodeOriginalDb = original;',
      DB_PUT, DB_DELETE, 'RETRY_BASE_MS = 0;'].join('\n');
    vm.runInNewContext(body + '\n', sandbox, { timeout: 10000 });
    fullInstalled = true;
  }
  return {
    window: windowStub, NS: NS, calls: calls, rows: rows, log: log,
    afterGuard: afterGuard, fullInstalled: fullInstalled, sandbox: sandbox
  };
}

(async function main() {
  /* ══════════════════════════════════════════════════════════════════
     §1 · BOOTSTRAP_EARLY_EXIT_MATRIX（机械）
     ══════════════════════════════════════════════════════════════════ */
  section('§1 · bootstrap early-exit matrix');

  const overrideLine = BOOT_CODE.split('\n').findIndex(l => /^window\.dbPut = function \(store, data\) \{$/.test(l)) + 1;
  const lines = BOOT_CODE.split('\n');

  /* 机械判定：顶层语句在本文件里一律顶格（column 0），因此早退点 = 顶格的依赖检查。
     用行内文本定位，而不是花括号计数 —— 注释与字符串里的括号会让计数失真。 */
  const exitLineIdx = [];
  lines.forEach((l, i) => {
    if (/^if \(!(_authorityFactory|window\.__dbCoreDb|window\.__ibCoreDb|_remoteFactory)\)/.test(l)) exitLineIdx.push(i + 1);
  });
  const preOverrideLines = exitLineIdx.filter(n => n < overrideLine);
  const preOverride = preOverrideLines.map(n => ({ line: n, text: lines[n - 1].trim() }));

  check('E1.exactlyThreePreOverrideExits',
    preOverride.length === 3,
    'there must be exactly three top-level dependency exits before the override install; found '
    + preOverride.length + ': ' + JSON.stringify(preOverride.map(r => r.line + ':' + r.text)));

  const exitRegion = i => preOverride[i] ? lines.slice(preOverride[i].line - 1, preOverride[i].line + 5).join('\n') : '';
  const deps = ['chat-authority', 'core-db', 'home-node-client'];

  check('E2.everyEarlyExitHasStableReasonAndDowngradeSurface',
    preOverride.every((r, i) => {
      const region = exitRegion(i);
      return /bootNote\('memory-bootstrap-dependency-missing'/.test(region)
        && new RegExp("dependency: '" + deps[i] + "'").test(region)
        && /exposeDegradedMemorySurface\('memory-bootstrap-dependency-missing:/.test(region);
    }),
    'each pre-override exit must emit the stable reason code and expose the degraded surface: '
    + JSON.stringify(preOverride.map((r, i) => ({ line: r.line, dep: deps[i], region: exitRegion(i).slice(0, 80) }))));

  check('E3.noEarlyExitIsSilent',
    preOverride.every((r, i) => /bootNote\(/.test(exitRegion(i))),
    'R4-A.5 left the chat-authority exit completely silent; every exit must now be observable');

  {
    /* 两者都以**行号**比较，不能拿字符偏移和行号比。 */
    const guardLine = lines.findIndex(l => /^\(function installCanonicalMemoryGuard\(\) \{$/.test(l)) + 1;
    const firstExitLine = preOverride.length ? preOverride[0].line : -1;
    check('E4.provisionalGuardInstalledBeforeEveryExit',
      guardLine > 0 && firstExitLine > 0 && guardLine < firstExitLine,
      'the provisional guard must be installed before the first dependency check '
      + JSON.stringify({ guardLine: guardLine, firstExitLine: firstExitLine }));
  }

  check('E5.canonicalIntentIsReadWithoutTheHelper',
    /typeof window\.ibHomeNodeMode === 'function'\) \? window\.ibHomeNodeMode\(\) : 'canonical'/.test(BOOT_CODE)
    && /canonicalMemoryIntended/.test(BOOT_CODE),
    'canonical intent must be resolvable even when home-node-client.js never loaded');

  /* ══════════════════════════════════════════════════════════════════
     §2 · provisional guard：canonical-intended 必须 fail closed
     ══════════════════════════════════════════════════════════════════ */
  section('§2 · provisional guard（canonical-intended）');

  {
    const h = makeHarness({ mode: 'canonical', protocol: 'http:' });
    let err = null;
    try { await h.window.dbPut('memories', { id: 'm1', content: 'A' }); } catch (e) { err = e; }
    check('G1.canonicalMemoryPutRefusedBeforeOverride',
      !!err && err.code === 'memory-authority-not-ready' && h.calls.originalPut === 0,
      'a memory put must be refused when canonical is intended and the override never installed: '
      + JSON.stringify({ code: err && err.code, originalPut: h.calls.originalPut }));
    check('G2.refusalIsObservable',
      h.log.some(e => /memory-authority-not-ready/.test(e.event))
      && h.NS.homeNodeLog && h.NS.homeNodeLog.some(e => e.event === 'memory-authority-not-ready'),
      'the refusal must emit a stable reason code to both console and the homeNodeLog registry');

    let derr = null;
    try { await h.window.dbDelete('memories', 'm1'); } catch (e) { derr = e; }
    check('G3.canonicalMemoryDeleteRefusedBeforeOverride',
      !!derr && derr.code === 'memory-authority-not-ready' && h.calls.originalDel === 0,
      'delete must be refused the same way');

    check('G4.noGhostRowWritten',
      h.rows.size === 0,
      'a refused write must not leave ANY local row (no ghost truth): ' + JSON.stringify([...h.rows.keys()]));

    const res = await h.window.dbPut('chatMessages', { id: 'c1' });
    check('G5.otherStoresUnaffected',
      h.calls.originalPut === 1 && res === undefined,
      'non-memory stores must be forwarded verbatim to the original writer');
  }

  /* ══════════════════════════════════════════════════════════════════
     §3 · explicit local modes must keep working
     ══════════════════════════════════════════════════════════════════ */
  section('§3 · explicit local modes preserved');

  for (const scenario of [
    { name: 'explicitMirror', mode: 'mirror', protocol: 'http:' },
    { name: 'explicitOff', mode: 'off', protocol: 'http:' },
    { name: 'fileOrigin', mode: 'canonical', protocol: 'file:' },
    { name: 'helperMissingDefaultsCanonical', mode: null, protocol: 'http:' }
  ]) {
    const h = makeHarness({ mode: scenario.mode, protocol: scenario.protocol });
    let err = null;
    try { await h.window.dbPut('memories', { id: 'm2', content: 'A' }); } catch (e) { err = e; }
    const expectedLocal = scenario.name !== 'helperMissingDefaultsCanonical';
    check('L1.' + scenario.name + (expectedLocal ? 'StaysHostLocal' : 'RefusesAsCanonical'),
      expectedLocal
        ? (!err && h.calls.originalPut === 1)
        : (!!err && err.code === 'memory-authority-not-ready' && h.calls.originalPut === 0),
      scenario.name + ': legacy host-local semantics must be preserved exactly where they are legitimate '
      + JSON.stringify({ code: err && err.code, originalPut: h.calls.originalPut }));
  }

  /* ══════════════════════════════════════════════════════════════════
     §4 · provisional wrapper safety（§13）
     ══════════════════════════════════════════════════════════════════ */
  section('§4 · provisional wrapper safety');

  {
    /* 幂等安装：重复执行 guard 块不得叠加包装 */
    const h = makeHarness({ mode: 'canonical', protocol: 'http:' });
    const first = h.window.dbPut;
    h.sandbox.window = h.window;
    h.sandbox.NS = h.NS;
    vm.runInNewContext(TOP_BLOCK + '\n', h.sandbox, { timeout: 10000 });
    check('W1.guardInstallIsIdempotent',
      h.window.dbPut === first,
      're-running the guard block must not wrap the wrapper (window.__ibCanonicalMemoryGuard)');
    check('W2.guardFlagSet',
      h.window.__ibCanonicalMemoryGuard === true,
      'the idempotency flag must be observable');
  }

  {
    /* 正式覆盖替换 guard：canonical 写入走 authority，且 guard 不再拦截 */
    const authority = {
      put: function () { calls_counter.put++; return Promise.resolve({ ok: true, outcome: 'updated', revision: 7, mirrored: true }); },
      remove: function () { calls_counter.remove++; return Promise.resolve({ ok: true, outcome: 'deleted', revision: 8 }); }
    };
    const calls_counter = { put: 0, remove: 0 };
    const h = makeHarness({ mode: 'canonical', protocol: 'http:', installFullOverride: true, memoryAuthority: authority, bootstrapMode: 'canonical' });
    await h.window.dbPut('memories', { id: 'm3', content: 'A' });
    check('W3.fullOverrideReplacesGuard',
      calls_counter.put === 1 && h.calls.authorityPut === 0 && h.calls.originalPut === 0,
      'once the real bootstrap installs, the guard must be replaced (not wrapped): '
      + JSON.stringify({ authorityPut: calls_counter.put, originalPut: h.calls.originalPut }));
    check('W4.noDoubleRemoteCall',
      calls_counter.put === 1,
      'a single canonical write must reach the authority exactly once');
    await h.window.dbDelete('memories', 'm3');
    check('W5.deleteAlsoGoesThroughOverrideOnly',
      calls_counter.remove === 1 && h.calls.originalDel === 0,
      'delete must be handled by the override alone');
  }

  {
    /* originalDb 引用不得指向原始 writer：否则它就是最后一条静默本地写路径 */
    const authority = { put: function () { return Promise.resolve({ ok: true, outcome: 'updated' }); }, remove: function () { return Promise.resolve({ ok: true }); } };
    const h = makeHarness({ mode: 'canonical', protocol: 'http:', installFullOverride: true, memoryAuthority: authority, bootstrapMode: 'canonical' });
    let refused = null;
    try { await h.NS.homeNodeOriginalDb.put('memories', { id: 'm4' }); } catch (e) { refused = e; }
    check('W6.originalDbCannotBypassForMemory',
      !!refused && refused.code === 'memory-authority-not-ready' && h.calls.originalPut === 0,
      'NS.homeNodeOriginalDb must not remain a silent local memory writer: '
      + JSON.stringify({ code: refused && refused.code, originalPut: h.calls.originalPut }));
    await h.NS.homeNodeOriginalDb.put('chatMessages', { id: 'c9' });
    check('W7.originalDbStillWorksForOtherStores',
      h.calls.originalPut === 1,
      'the escape hatch must keep working for every non-memory store');
  }

  {
    /* 部分初始化 / 安装后失败：guard 仍在 ⇒ 仍然 fail closed */
    const h = makeHarness({ mode: 'canonical', protocol: 'http:' });
    let err = null;
    try { await h.window.dbPut('memories', { id: 'm5' }); } catch (e) { err = e; }
    check('W8.failureAfterProvisionalInstallStaysClosed',
      !!err && err.code === 'memory-authority-not-ready' && h.calls.originalPut === 0,
      'a bootstrap that dies after the provisional install must still leave memory writes closed');
  }

  /* ══════════════════════════════════════════════════════════════════
     §5 · degraded health surface（复用既有形状，不新造 framework）
     ══════════════════════════════════════════════════════════════════ */
  section('§5 · degraded health surface');

  {
    const h = makeHarness({ mode: 'canonical', protocol: 'http:' });
    h.sandbox.NS = h.NS;
    vm.runInNewContext('exposeDegradedMemorySurface("memory-bootstrap-dependency-missing:core-db");\n', h.sandbox, { timeout: 10000 });
    const st = h.NS.homeNode.memory.status();
    check('D1.degradedSurfaceMatchesSuccessShape',
      st.store === 'memories' && st.available === false && st.degraded === true
      && st.authorityEffective === false && st.degradedReason === 'memory-bootstrap-dependency-missing:core-db',
      'the degraded surface must reuse the success-path memory.status() shape: ' + JSON.stringify(st));
    check('D2.degradedSurfaceExposesNoRemote',
      h.NS.homeNode.remote === undefined,
      'consumers key off remote presence; a degraded surface must not advertise one');
    check('D3.degradedSurfaceIsIdempotent',
      (function () {
        vm.runInNewContext('exposeDegradedMemorySurface("other-reason");\n', h.sandbox, { timeout: 10000 });
        return h.NS.homeNode.memory.status().degradedReason === 'memory-bootstrap-dependency-missing:core-db';
      })(),
      'a later degraded reason must not overwrite the first one');
  }

  /* ══════════════════════════════════════════════════════════════════
     §6 · STARTUP_DEPENDENCY_TIMELINE（§4 / §18）
     ══════════════════════════════════════════════════════════════════ */
  section('§6 · startup dependency timeline');

  const scriptOrder = ['core.js', 'memory-authority.js', 'home-node-client.js', 'home-node-bootstrap.js', 'chat-authority.js']
    .map(f => ({ f: f, at: HTML.indexOf('assets/js/' + f) }))
    .sort((a, b) => a.at - b.at);
  const orderNames = scriptOrder.map(s => s.f);

  check('T1.scriptOrderIsCorrect',
    orderNames.indexOf('core.js') < orderNames.indexOf('chat-authority.js')
    && orderNames.indexOf('chat-authority.js') < orderNames.indexOf('memory-authority.js')
    && orderNames.indexOf('memory-authority.js') < orderNames.indexOf('home-node-client.js')
    && orderNames.indexOf('home-node-client.js') < orderNames.indexOf('home-node-bootstrap.js'),
    'the real script order must place every dependency before the bootstrap: ' + JSON.stringify(orderNames));

  check('T2.noDeferAsyncOrModuleOnTheCriticalChain',
    scriptOrder.every(s => {
      const tag = HTML.slice(HTML.lastIndexOf('<script', s.at), HTML.indexOf('>', s.at) + 1);
      return !/\b(defer|async)\b/.test(tag) && !/type\s*=\s*"module"/.test(tag);
    }),
    'every script on the critical chain must be a classic synchronous script, otherwise ordering is not a guarantee');

  const depsDefinedAtLoad = [
    { name: '__ibCoreDb', file: 'assets/js/core.js', re: /^window\.__ibCoreDb=\{/m },
    { name: 'IBChatAuthority', file: 'assets/js/chat-authority.js', re: /root\.IBChatAuthority = factory\(/ },
    { name: 'IBMemoryAuthority', file: 'assets/js/memory-authority.js', re: /root\.IBMemoryAuthority = factory\(/ },
    { name: 'ibHomeNodeMode', file: 'assets/js/home-node-client.js', re: /^window\.ibHomeNodeMode = ibHomeNodeMode;$/m },
    { name: 'createHomeNodeRemote', file: 'assets/js/home-node-client.js', re: /NS\.createHomeNodeRemote = createHomeNodeRemote;/ }
  ];
  /* 依赖必须在**自身文件的模块顶层**同步赋值（UMD 工厂内部最多两层花括号），
     而不是藏在 DOMContentLoaded / load 回调里 —— 那样 script 顺序就不再是保证。 */
  const braceDepthAt = (src, re) => {
    const code = WIRING.stripJsComments(src);
    const ls = code.split('\n');
    let depth = 0;
    for (let i = 0; i < ls.length; i++) {
      if (re.test(ls[i])) return depth;
      for (const ch of ls[i]) { if (ch === '{') depth++; else if (ch === '}') depth--; }
    }
    return -1;
  };
  const depDepths = depsDefinedAtLoad.map(d => ({ name: d.name, depth: braceDepthAt(read(d.file), d.re) }));
  check('T3.everyDependencyIsAssignedAtModuleTopLevel',
    depDepths.every(d => d.depth >= 0 && d.depth <= 2),
    'each dependency must be assigned at module top level (depth <= 2 for a UMD wrapper), '
    + 'not inside a deferred callback: ' + JSON.stringify(depDepths));

  check('T4.bootstrapIsLastAndSynchronous',
    /assets\/js\/home-node-bootstrap\.js/.test(HTML)
    && scriptOrder[scriptOrder.length - 1].f === 'home-node-bootstrap.js',
    'the bootstrap must be the last script on the chain');

  /* ══════════════════════════════════════════════════════════════════
     §7 · normal-path integration（§18）
     ══════════════════════════════════════════════════════════════════ */
  section('§7 · normal-path integration');

  {
    const seen = [];
    const chatSeen = [];
    const authority = {
      put: function (record) { seen.push(['authority.put', record.id]); return Promise.resolve({ ok: true, outcome: 'created', revision: 1, mirrored: true }); },
      remove: function (id) { seen.push(['authority.remove', id]); return Promise.resolve({ ok: true, outcome: 'deleted', revision: 2 }); }
    };
    const h = makeHarness({ mode: 'canonical', protocol: 'http:', installFullOverride: true, memoryAuthority: authority, bootstrapMode: 'canonical' });
    h.sandbox.authority = { put: function (d) { chatSeen.push(d && d.id); return Promise.resolve({ ok: true }); }, remove: function () { return Promise.resolve({ ok: true }); } };
    await h.window.dbPut('memories', { id: 'n1', content: 'A' });
    await h.window.dbPut('chatMessages', { id: 'n2' });
    /* chat 在 MODE=canonical 下走 chat authority（不是 original）；memory 只走 memoryAuthority。
       断言两者的**去向**都正确，而不是"original 被调用了几次"。 */
    check('N1.normalPathRoutesEachDomainToItsOwnAuthority',
      JSON.stringify(seen) === JSON.stringify([['authority.put', 'n1']])
      && JSON.stringify(chatSeen) === JSON.stringify(['n2'])
      && h.calls.originalPut === 0,
      'memory → memoryAuthority, chat → chatAuthority, and no silent fall-through to the raw writer: '
      + JSON.stringify({ seen: seen, chatSeen: chatSeen, originalPut: h.calls.originalPut }));
  }

  /* ══════════════════════════════════════════════════════════════════
     §8 · CANONICAL_LOCAL_WRITE_PATH_COUNT（§19）
     ══════════════════════════════════════════════════════════════════ */
  section('§8 · canonical local write path count');

  {
    /* 穷举 assets/js 里所有 memories 写点，逐条判定它是否经过被覆盖的 dbPut/dbDelete。 */
    const files = [];
    (function walk(dir) {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.js')) files.push(p);
      }
    })(path.join(ROOT, 'assets', 'js'));

    /* 判据分三类（这才是 §19 要的"穷举"）：
       ① raw IndexedDB 访问（objectStore/transaction on 'memories'）只允许出现在
          core.js 的镜像驱动里；
       ② 任何绕过 seam 的写法（DB.put('memories'…)、homeNodeOriginalDb.put('memories'…)、
          original.put('memories'…)）一律不允许；
       ③ 其余 memories 写必须用裸 `dbPut`/`dbDelete`/`dbUpdate` —— 也就是被覆盖的那个 global。 */
    const rawAccess = [];
    const bypass = [];
    const seam = [];
    for (const f of files) {
      const src = WIRING.stripJsComments(fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n'));
      const rel = path.relative(ROOT, f).replace(/\\/g, '/');
      const rawAllowed = /assets\/js\/(core|home-node-bootstrap)\.js$/.test(rel);
      src.split('\n').forEach((line, i) => {
        const at = rel + ':' + (i + 1) + ': ' + line.trim().slice(0, 70);
        if (/objectStore\(\s*'memories'\s*\)|transaction\(\s*'memories'/.test(line)) { if (!rawAllowed) rawAccess.push(at); return; }
        /* `DB.put('memories', …)` 是**镜像驱动**的合法写法，只允许在 core.js /
           home-node-bootstrap.js（它们就是 authority 的 local driver）。 */
        if (/\bDB\.(put|del|delete)\(\s*'memories'/.test(line)) { if (!rawAllowed) bypass.push(at); return; }
        /* 这三类**任何文件**都不允许：它们是绕过 seam 的写法。 */
        if (/homeNodeOriginalDb\.(put|del|delete)\(\s*'memories'|original\.(put|del|delete)\(\s*'memories'/.test(line)) { bypass.push(at); return; }
        if (/\bdbPut\(\s*'memories'|\bdbDelete\(\s*'memories'|\bdbUpdate\(\s*'memories'/.test(line)) seam.push(at);
      });
    }
    check('C1.noUnsanctionedRawMemoryWriter',
      rawAccess.length === 0 && bypass.length === 0,
      'no file may reach IndexedDB memories directly or bypass the overridden seam: '
      + JSON.stringify({ rawAccess: rawAccess, bypass: bypass }));
    check('C1b.everyContentWriterUsesTheOverriddenSeam',
      seam.length >= 15,
      'every memory content writer must call the bare (overridden) dbPut/dbDelete/dbUpdate; found ' + seam.length);

    /* 被覆盖的 dbPut 在 canonical 下的两条出口只有：authority 或拒绝。 */
    const dbPutCode = WIRING.stripJsComments(DB_PUT);
    check('C2.canonicalExitsAreAuthorityOrRefusal',
      /memoryAuthority\.put\(data\)/.test(dbPutCode)
      && /memory-authority-unavailable/.test(dbPutCode)
      && !/original\.put\(store, data\)/.test(dbPutCode.replace(/if \(!isChatStore\(store\) \|\| MODE !== 'canonical'\) return original\.put\(store, data\);/, '')),
      'inside window.dbPut, a memories write may only reach the authority or be refused');

    check('C3.provisionalGuardClosesTheAbortWindow',
      /installCanonicalMemoryGuard/.test(BOOT_CODE)
      && /memory-authority-not-ready/.test(BOOT_CODE),
      'the override-not-installed window must be closed by the provisional guard');
  }

  /* ══════════════════════════════════════════════════════════════════
     §9 · retry preservation（§21）
     ══════════════════════════════════════════════════════════════════ */
  section('§9 · retry preservation');

  check('R1.withRetryStillExistsForChatOnly',
    (function () {
      const uses = BOOT_CODE.split('\n').filter(l => /withRetry\(function/.test(l));
      return uses.length === 2 && /chatMessages/.test(BOOT_CODE.slice(BOOT_CODE.indexOf('window.dbPut'), BOOT_CODE.indexOf('window.dbGet')));
    })(),
    'A.6 must not reintroduce retry into memory content writes');

  check('R2.memoryBranchesCarryNoWithRetry',
    !/isMemoryStore\(store\)\)\s*\{\s*return withRetry/.test(BOOT_CODE)
    && (BOOT_CODE.split('withRetry(function').length - 1) === 2,
    'the two memory branches must remain retry-free');

  check('R3.provisionalGuardAddsNoRetry',
    !/withRetry/.test(TOP_BLOCK),
    'the startup guard must never replay a mutation');

  /* ══════════════════════════════════════════════════════════════════
     §10 · hydrate safety（§20）
     ══════════════════════════════════════════════════════════════════ */
  section('§10 · hydrate safety');

  {
    const h = makeHarness({ mode: 'canonical', protocol: 'http:' });
    for (const id of ['h1', 'h2']) {
      try { await h.window.dbPut('memories', { id: id, content: 'ghost' }); } catch (e) { /* expected */ }
    }
    check('H1.noLocalRecordSurvivesStartupFailure',
      h.rows.size === 0 && h.calls.originalPut === 0,
      'a startup failure must leave zero local memory rows, so a later hydrate cannot contradict a phantom local write');
  }

  console.log('\n' + '='.repeat(64));
  if (failures) {
    console.error('STARTUP MEMORY AUTHORITY FAILED · ' + failures + ' assertion(s), ' + passed + ' passed');
    process.exit(1);
  }
  console.log('STARTUP MEMORY AUTHORITY PASSED · ' + passed + ' assertions green');
})().catch(error => {
  console.error('STARTUP MEMORY AUTHORITY CRASHED · ' + String((error && error.stack) || error));
  process.exit(1);
});
