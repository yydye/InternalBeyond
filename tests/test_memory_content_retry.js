'use strict';
/* ══════════════════════════════════════════════════════════════════════════
   Internal Beyond · P21-R4-A.5 · Canonical Content Retry + Downgrade
   （Node，零依赖，零浏览器，零网络 —— 真实 store + 真实 bootstrap 代码片段）

   运行：node tests/test_memory_content_retry.js

   ── 本文件要证明的三件事 ────────────────────────────────────────────────
   1. canonical content mutation 的 **HTTP attempt 数**：不是"memoryAuthority.put
      被调用几次"，而是最终真正打到 Home Node 的次数。retry owner 在
      `home-node-bootstrap.js` 的 `withRetry`，不在 memory-authority 里。
   2. **stale overwrite hazard**：第一次提交成功但响应丢失（ambiguous）⇒ 客户端
      重试**同一个 payload**；若期间有别的写者提交了新版本，重试会用旧内容覆盖新内容。
      `contentFingerprint` 的幂等只在**状态未变**时成立（skipped），**不**能阻止这件事。
   3. **authority unavailable** 时的隐式本地降级必须可区分、可观测，且不得
      在"环境本来应该是 canonical"时静默写入第二份本地真相。

   ── 为什么切片真实 bootstrap 源码 ─────────────────────────────────────
   retry 语义**不在** memory-authority 里，也不在 home-node-client 里，
   而在 `window.dbPut` 的覆盖实现中。因此这里把 `withRetry` / `throwWriteError` /
   `isMemoryStore` / `window.dbPut` / `window.dbDelete` **原样抽出**在隔离 vm 里执行，
   而不是复制一份"差不多的"重试逻辑。

   零网络：remote 由真实 memory-store 或可注入失败的替身提供。
   ══════════════════════════════════════════════════════════════════════════ */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const createMemoryStore = require(path.join(ROOT, 'services', 'home-node', 'memory-store.js'));
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

/* ── 从真实 bootstrap 源码切片 ──────────────────────────────────────────
   注意：home-node-bootstrap.js 在工作树里是 **CRLF + BOM**（.gitattributes 只
   声明了 InternalBeyond.html 与 assets/**\/*.js 的 eol=lf，而该文件的检出
   仍然是 CRLF）。切片前必须归一化，否则 `$` 锚定的行正则会因为行尾的 `\r` 全部失配。 */
const BOOTSTRAP = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'home-node-bootstrap.js'), 'utf8')
  .replace(/^\uFEFF/, '')
  .replace(/\r\n/g, '\n');

function sliceBlock(source, startRe, endRe) {
  const lines = source.split('\n');
  let s = -1;
  for (let i = 0; i < lines.length; i++) {
    if (s < 0) { if (startRe.test(lines[i])) s = i; continue; }
    if (endRe.test(lines[i])) return lines.slice(s, i + 1).join('\n');
  }
  return null;
}
function singleLine(source, re) {
  const m = source.split('\n').find(l => re.test(l));
  return m === undefined ? null : m;
}

const BOOT_PARTS = {
  attempts: sliceBlock(BOOTSTRAP, /^var MIRROR_WRITE_ATTEMPTS = \d+;$/, /^var RETRY_BASE_MS = \d+;$/),
  withRetry: sliceBlock(BOOTSTRAP, /^function withRetry\(fn, attempts\) \{$/, /^\}$/),
  throwWriteError: sliceBlock(BOOTSTRAP, /^function throwWriteError\(result, fallbackId\) \{$/, /^\}$/),
  isMemoryStore: singleLine(BOOTSTRAP, /^function isMemoryStore\(store\)/),
  dbPut: sliceBlock(BOOTSTRAP, /^window\.dbPut = function \(store, data\) \{$/, /^\};$/),
  dbDelete: sliceBlock(BOOTSTRAP, /^window\.dbDelete = function \(store, key\) \{$/, /^\};$/)
};

check('S1.bootstrapSlicesComplete',
  Object.keys(BOOT_PARTS).every(k => typeof BOOT_PARTS[k] === 'string' && BOOT_PARTS[k].length > 0),
  'every retry/override block must be sliceable from the real bootstrap: '
  + JSON.stringify(Object.keys(BOOT_PARTS).filter(k => !BOOT_PARTS[k])));

/* ── 隔离 harness：执行真实 dbPut / dbDelete 覆盖 ──────────────────────── */
function makeBootstrapHarness(options) {
  const opts = options || {};
  const calls = { put: 0, remove: 0, originalPut: 0, originalDel: 0 };
  const windowStub = {};

  const authority = opts.authority || null;
  const memoryAuthority = opts.memoryAuthority === undefined ? authority : opts.memoryAuthority;

  const sandbox = {
    window: windowStub,
    memoryAuthority: memoryAuthority,
    note: function () {},
    Error: Error, Object: Object, Promise: Promise, Array: Array, String: String,
    setTimeout: function (fn) { return setTimeout(fn, 0); },
    console: console,
    /* 非 memory 分支所需的桩：证明它们**不**受影响。 */
    isChatStore: function (store) { return store === 'chatMessages'; },
    isUnderstandingStore: function () { return false; },
    isMomentsStore: function () { return false; },
    understandingWriteClosed: function () { return false; },
    momentsWriteClosed: function () { return false; },
    MODE: opts.mode || 'canonical',
    authority: opts.chatAuthority || { put: function () { return Promise.resolve({ ok: true }); } },
    original: {
      put: function (store, data) { calls.originalPut++; return Promise.resolve(undefined); },
      del: function (store, key) { calls.originalDel++; return Promise.resolve(undefined); }
    }
  };
  /* 让真实切片里的 var 声明生效，并把 backoff 压到最小以免拖慢测试。 */
  const body = BOOT_PARTS.attempts + '\n' + BOOT_PARTS.withRetry + '\n' + BOOT_PARTS.throwWriteError
    + '\n' + BOOT_PARTS.isMemoryStore + '\n' + BOOT_PARTS.dbPut + '\n' + BOOT_PARTS.dbDelete
    + '\nRETRY_BASE_MS = 0;\nreturn { dbPut: window.dbPut, dbDelete: window.dbDelete };';
  const api = vm.runInNewContext('(function(){' + body + '\n})()', sandbox, { timeout: 10000 });
  return { api: api, calls: calls, sandbox: sandbox };
}

/* ── 真实 Home Node store ─────────────────────────────────────────────── */
function openStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-content-retry-'));
  const store = createMemoryStore({ dataDir: dir, logger: () => {} });
  store.open();
  return { dir: dir, store: store };
}
function rawContent(store, id) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(store.file);
  try {
    const row = db.prepare('SELECT payload_json, deleted_at FROM memory_records WHERE record_id=?').get(String(id));
    if (!row) return null;
    return { content: JSON.parse(row.payload_json).content, deletedAt: row.deleted_at };
  } finally { db.close(); }
}
function baseRecord(id, content) {
  return {
    id: id, title: 'T', summary: '', content: content, oneLine: '', domain: '日常',
    rawSource: 'manual', sourceId: '', tags: [], valence: 0.5, arousal: 0.3,
    importance: 5, resolved: false, pinned: false, visibility: 'public',
    visibleTo: [], excludeFrom: [], createdBy: 'user', createdByName: '',
    editedByUser: false, activationCount: 0, created: 1700000000000,
    lastActivated: 1700000000000, kind: 'episodic', consolidatedFrom: [], lastConsolidatedAt: null
  };
}

(async function main() {
  /* ══════════════════════════════════════════════════════════════════
     §1 · Retry topology：最终 HTTP attempt 数
     ══════════════════════════════════════════════════════════════════ */
  section('§1 · retry topology（真实 bootstrap 覆盖）');

  check('T1.retryOwnerIsTheBootstrapOverride',
    /withRetry/.test(BOOT_PARTS.dbPut),
    'the retry owner for canonical memory content writes is window.dbPut in home-node-bootstrap');

  {
    /* transport 失败（memory-authority 把 offline/reject 解析成 ok:false）：
       这里用 memoryAuthority.put 返回 {ok:false}（模拟 offline）来计数。 */
    const h = makeBootstrapHarness({
      authority: { put: function () { h.calls.put++; return Promise.resolve({ ok: false, error: 'home-node-offline' }); } }
    });
    let err = null;
    try { await h.api.dbPut('memories', baseRecord('m1', 'A')); } catch (e) { err = e; }
    check('R3.ambiguousContentWriteHttpAttemptsIsOne',
      h.calls.put === 1,
      'an ambiguous/transport-failed canonical content write must reach Home Node exactly ONCE '
      + '(observed attempts: ' + h.calls.put + ', error: ' + (err && err.code) + ')');
    check('R3b.ambiguousFailureThrowsToCaller',
      !!err && err.code === 'home-node-offline',
      'the caller must see the failure (never a silent success)');
  }

  {
    const h = makeBootstrapHarness({
      authority: { put: function () { h.calls.put++; return Promise.resolve({ ok: false, rejected: true, error: 'home-node-rejected' }); } }
    });
    let err = null;
    try { await h.api.dbPut('memories', baseRecord('m2', 'A')); } catch (e) { err = e; }
    check('R4.definiteRejectionHttpAttemptsIsOne',
      h.calls.put === 1 && !!err && err.rejected === true,
      'a definite rejection must not be retried (observed attempts: ' + h.calls.put + ')');
  }

  {
    const h = makeBootstrapHarness({
      authority: { put: function () { h.calls.put++; return Promise.resolve({ ok: true, outcome: 'updated', revision: 5 }); } }
    });
    const res = await h.api.dbPut('memories', baseRecord('m3', 'A'));
    check('R5.successHttpAttemptsIsOne',
      h.calls.put === 1 && res === undefined,
      'a successful write must reach Home Node exactly once and keep the resolve(undefined) contract');
  }

  {
    /* 传输层 **throw** / timeout 也必须只打一次。 */
    const h = makeBootstrapHarness({
      authority: { put: function () { h.calls.put++; return Promise.reject(new Error('timeout')); } }
    });
    let err = null;
    try { await h.api.dbPut('memories', baseRecord('m4', 'A')); } catch (e) { err = e; }
    check('R5b.transportThrowHttpAttemptsIsOne',
      h.calls.put === 1 && !!err,
      'a transport throw / timeout must reach Home Node exactly once (observed: ' + h.calls.put + ')');
  }

  {
    /* delete 是同一类 canonical content mutation ⇒ 同样不得自动重放。 */
    const h = makeBootstrapHarness({
      authority: { remove: function () { h.calls.remove++; return Promise.resolve({ ok: false, error: 'home-node-offline' }); } }
    });
    let err = null;
    try { await h.api.dbDelete('memories', 'm5'); } catch (e) { err = e; }
    check('R5c.ambiguousDeleteHttpAttemptsIsOne',
      h.calls.remove === 1,
      'an ambiguous canonical delete must also reach Home Node exactly once (observed: ' + h.calls.remove + ')');
  }

  {
    /* §17 R6：用户显式第二次保存 = 两次独立操作，允许。 */
    const h = makeBootstrapHarness({
      authority: { put: function () { h.calls.put++; return Promise.resolve({ ok: true, outcome: 'updated' }); } }
    });
    await h.api.dbPut('memories', baseRecord('m6', '第一次'));
    await h.api.dbPut('memories', baseRecord('m6', '第二次'));
    check('R6.explicitSecondSaveIsANewOperation',
      h.calls.put === 2,
      'two explicit user saves are two independent operations (observed: ' + h.calls.put + ')');
  }

  {
    /* §17 R7：非 memory 的 retry 行为**不变**（chat 仍最多 3 次）。 */
    const h = makeBootstrapHarness({
      chatAuthority: { put: function () { h.calls.originalPut++; return Promise.resolve({ ok: false, error: 'transport' }); } }
    });
    let chatAttempts = 0;
    h.sandbox.authority.put = function () { chatAttempts++; return Promise.reject(new Error('transport')); };
    h.sandbox.MODE = 'canonical';
    try { await h.api.dbPut('chatMessages', { id: 'c1' }); } catch (e) { /* expected */ }
    check('R7.nonMemoryRetryBehaviourUnchanged',
      chatAttempts === 3,
      'the chat store must keep its existing 3-attempt retry (observed: ' + chatAttempts + ')');
  }

  /* ══════════════════════════════════════════════════════════════════
     §2 · Stale overwrite：ambiguous commit + concurrent write + retry
     ══════════════════════════════════════════════════════════════════ */
  section('§2 · stale overwrite hazard（真实 store）');

  const hn = openStore();

  /* 序列化"如果没有修复会发生什么"：attempt1 真的提交了 A（只是响应丢了），
     期间 B 写者提交了新版本，然后旧请求以同一个 payload 重试。 */
  hn.store.putRecord(baseRecord('mem_a', 'A'));                       // attempt 1 已在服务端 commit
  hn.store.putRecord(baseRecord('mem_a', 'B'));                       // 并发写者提交 B
  const retryA = hn.store.putRecord(baseRecord('mem_a', 'A'));        // 旧请求重试
  const finalRow = rawContent(hn.store, 'mem_a');

  check('D1.fingerprintIdempotencyIsSameStateOnly',
    finalRow.content === 'A',
    'CONTENT_FINGERPRINT_IDEMPOTENCY = SAME-STATE ONLY: an identical payload re-sent AFTER a different '
    + 'commit overwrites that newer commit (final=' + finalRow.content + ', outcome=' + retryA.outcome + ')');

  /* 对照：**状态未变**时同 payload 重试确实是幂等的。 */
  const revBefore = hn.store.getRevision();
  const sameStateRetry = hn.store.putRecord(baseRecord('mem_a', 'A'));
  check('D2.retryWithoutInterveningWriteIsSkipped',
    sameStateRetry.outcome === 'skipped' && hn.store.getRevision() === revBefore,
    'retrying the same payload with no intervening write is skipped (no extra revision)');

  /* 对照：这就是 A.4 已登记的 duplicate-request 形状（带 requestId 时才存在）。
     断言必须只看**代码面**（剥离注释）—— 修复注释里逐字提到了 requestId / CAS，
     用原文子串判断会把自己的说明文字当成"带了 requestId"。 */
  const dbPutCode = WIRING.stripJsComments(BOOT_PARTS.dbPut);
  const dbDeleteCode = WIRING.stripJsComments(BOOT_PARTS.dbDelete);
  check('D3.noDurableRequestIdentityOnTheOrdinaryPath',
    /memoryAuthority\.put\(data\)/.test(dbPutCode)
    && /memoryAuthority\.remove\(key\)/.test(dbDeleteCode)
    && !/requestId/.test(dbPutCode) && !/expectedRevision/.test(dbPutCode)
    && !/requestId/.test(dbDeleteCode) && !/expectedRevision/.test(dbDeleteCode),
    'the ordinary content-write path calls put(data) / remove(key) with no options object: '
    + 'no requestId, no expectedRevision — the store semantics stay LAST-WRITE-WINS');

  check('D4.defectRegistered',
    finalRow.content === 'A',
    'R4A5-CONTENT-AMBIGUOUS-RETRY-1 is reproducible: ' + JSON.stringify({ after: finalRow.content, outcome: retryA.outcome }));

  /* 修复后的语义：attempts=1 ⇒ 重试永不发生 ⇒ B 保留。 */
  const hn2 = openStore();
  hn2.store.putRecord(baseRecord('mem_b', 'A'));                      // attempt 1 commit
  hn2.store.putRecord(baseRecord('mem_b', 'B'));                      // 并发 B
  /* 修复后客户端只发一次；它不会再发第二次 A。 */
  const afterPolicy = rawContent(hn2.store, 'mem_b');
  check('D5.singleAttemptLeavesTheConcurrentWriteIntact',
    afterPolicy.content === 'B',
    'with AUTO_RETRY=NONE the concurrent write survives (final=' + afterPolicy.content + ')');

  /* delete 的同类 hazard：重试的 soft delete 会删掉并发复原的内容。 */
  const hn3 = openStore();
  hn3.store.putRecord(baseRecord('mem_c', 'A'));
  hn3.store.deleteRecord('mem_c', {});                                 // attempt 1 已 soft delete
  hn3.store.putRecord(baseRecord('mem_c', 'B-resurrected'));           // 并发写者复原并写新内容
  const retryDelete = hn3.store.deleteRecord('mem_c', {});             // 旧 delete 重试
  const afterDeleteRetry = rawContent(hn3.store, 'mem_c');
  check('D6.ambiguousDeleteRetryAlsoDestroysNewerContent',
    retryDelete.ok === true && afterDeleteRetry && afterDeleteRetry.deletedAt != null,
    'the same stale-overwrite shape exists for delete: a retried soft delete removes the resurrected row '
    + JSON.stringify({ outcome: retryDelete.outcome, deletedAt: afterDeleteRetry && afterDeleteRetry.deletedAt }));

  /* ══════════════════════════════════════════════════════════════════
     §3 · mirror 在 ambiguous 结果下必须保持不变
     ══════════════════════════════════════════════════════════════════ */
  section('§3 · ambiguous result leaves the mirror unchanged');

  {
    const AUTHORITY = require(path.join(ROOT, 'assets', 'js', 'memory-authority.js'));
    const rows = new Map();
    const events = [];
    const local = {
      get: id => Promise.resolve(rows.get(String(id)) || null),
      getAll: () => Promise.resolve(Array.from(rows.values())),
      put: r => { events.push('local.put'); rows.set(String(r.id), r); return Promise.resolve(true); },
      remove: id => { events.push('local.remove'); rows.delete(String(id)); return Promise.resolve(true); },
      replaceAll: rs => { events.push('local.replaceAll'); rows.clear(); rs.forEach(r => rows.set(String(r.id), r)); return Promise.resolve(true); },
      applyUpserts: () => Promise.resolve(true), applyDeletes: () => Promise.resolve(true), bumpActivation: () => Promise.resolve(0)
    };
    const remote = {
      health: () => Promise.resolve({ ok: true }), list: () => Promise.resolve({ ok: true, records: [] }),
      changes: () => Promise.resolve({ ok: true, cursor: 0, upserts: [], deletes: [] }),
      put: () => Promise.resolve({ ok: false, error: 'home-node-unreachable' }),
      remove: () => Promise.resolve({ ok: false, error: 'home-node-unreachable' }),
      activate: () => Promise.resolve({ ok: true, updated: 0, activations: [] }),
      migrationState: () => Promise.resolve({ ok: true }), markMigration: () => Promise.resolve({ ok: true }),
      putBatch: () => Promise.resolve({ ok: true }), putSettings: () => Promise.resolve({ ok: true })
    };
    const a = AUTHORITY.createMemoryAuthority({ mode: 'canonical', local: local, remote: remote, fileOrigin: false });
    rows.set('mem_x', baseRecord('mem_x', '旧镜像内容'));
    const res = await a.put(baseRecord('mem_x', '不该落地的内容'));
    check('M1.ambiguousLeavesMirrorUnchanged',
      res.ok === false && events.indexOf('local.put') < 0 && rows.get('mem_x').content === '旧镜像内容',
      'an ambiguous canonical outcome must leave the mirror untouched: ' + JSON.stringify({ res: res, events: events }));
  }

  /* ══════════════════════════════════════════════════════════════════
     §4 · authority unavailable：区分"合法本地模式"与"初始化失败"
     ══════════════════════════════════════════════════════════════════ */
  section('§4 · authority unavailable（canonical-intended vs local mode）');

  {
    const h = makeBootstrapHarness({ memoryAuthority: null, mode: 'canonical' });
    let err = null;
    let wrote = null;
    try { wrote = await h.api.dbPut('memories', baseRecord('m7', 'A')); } catch (e) { err = e; }
    check('G1.canonicalIntendedWithoutAuthorityFailsClosed',
      !!err && err.code === 'memory-authority-unavailable' && h.calls.originalPut === 0,
      'MODE=canonical + no authority must fail closed with a NAMED error, never a silent local write '
      + JSON.stringify({ error: err && err.code, originalPut: h.calls.originalPut, wrote: wrote }));
  }

  {
    const h = makeBootstrapHarness({ memoryAuthority: null, mode: 'mirror' });
    const res = await h.api.dbPut('memories', baseRecord('m8', 'A'));
    check('G2.explicitMirrorModeKeepsLegacyPath',
      h.calls.originalPut === 1 && res === undefined,
      'MODE=mirror + no authority is the legitimate local mode and must keep the legacy path '
      + JSON.stringify({ originalPut: h.calls.originalPut }));
  }

  {
    const h = makeBootstrapHarness({ memoryAuthority: null, mode: 'off' });
    await h.api.dbPut('memories', baseRecord('m9', 'A'));
    check('G3.explicitOffModeKeepsLegacyPath',
      h.calls.originalPut === 1,
      'MODE=off + no authority is the legitimate local mode and must keep the legacy path');
  }

  {
    const h = makeBootstrapHarness({ memoryAuthority: null, mode: 'canonical' });
    let err = null;
    try { await h.api.dbDelete('memories', 'm10'); } catch (e) { err = e; }
    check('G4.canonicalIntendedDeleteAlsoFailsClosed',
      !!err && err.code === 'memory-authority-unavailable' && h.calls.originalDel === 0,
      'the same guard must cover delete (no silent local delete under canonical intent)');
  }

  {
    /* authority 存在但 mode=mirror ⇒ 合法 host-local，走 authority 的 local-only 分支。 */
    const h = makeBootstrapHarness({
      authority: { put: function () { h.calls.put++; return Promise.resolve({ ok: true, outcome: 'local-only', mirrorOnly: true, authority: 'indexeddb' }); } },
      mode: 'mirror'
    });
    const res = await h.api.dbPut('memories', baseRecord('m11', 'A'));
    check('G5.authorityPresentInMirrorModeStaysHostLocal',
      h.calls.put === 1 && h.calls.originalPut === 0 && res === undefined,
      'with an authority present, mirror mode still routes through it (host-local, no legacy bypass)');
  }

  hn.store.close(); hn2.store.close(); hn3.store.close();

  console.log('\n' + '='.repeat(64));
  if (failures) {
    console.error('MEMORY CONTENT RETRY FAILED · ' + failures + ' assertion(s), ' + passed + ' passed');
    process.exit(1);
  }
  console.log('MEMORY CONTENT RETRY PASSED · ' + passed + ' assertions green');
})().catch(error => {
  console.error('MEMORY CONTENT RETRY CRASHED · ' + String((error && error.stack) || error));
  process.exit(1);
});
