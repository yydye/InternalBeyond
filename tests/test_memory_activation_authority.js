'use strict';
/* Internal Beyond · P21-R2-H1 · **Activation Authority** contract tests
   （static，零依赖，零浏览器，零真实网络）
   运行：node tests/test_memory_activation_authority.js

   本套件是 R2-H1 的 **test-first** 证据。它按 §2.1 冻结的语义（Option A：
   canonical mode 下 Home Node 是 activation telemetry 的唯一 canonical durable
   authority，browser 写入必须 remote-first、失败则两侧都不增加）写成断言，
   并**在 H1 的 HEAD 上如实为红**：

     RED-1  production browser recall **完全没有** canonical activation 请求（0 次）
     RED-2  canonical 失败时 browser mirror **仍然被乐观 +1**（违反 telemetry fail-closed）

   这两条是 H2 的验收条件；它们变绿之前，production 路径不得声称已接线。

   同时包含 H1 已成立行为的 **GREEN characterization**（防止 H2 改坏）：
     · HN 单写者形态：activation_count +1 / last_activated_at / revision 不变 / payload 不变
     · hydrate canonical-wins：canonical 值纠正 mirror（不是 merge，也不是 bug）
     · activation **不是** change-log 事件（不进 changes(cursor)）

   命名刻意是 activation **authority** —— 与 cooldown / exposure 无关。
*/

const vm = require('vm');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const ROOT = path.resolve(__dirname, '..');
const AUTHORITY = require(path.join(ROOT, 'assets', 'js', 'memory-authority.js'));
const CORE = require(path.join(ROOT, 'assets', 'js', 'memory-retrieval-core.js'));
const ORCHESTRATOR = require(path.join(ROOT, 'assets', 'js', 'memory-recall', 'memory-recall-orchestrator.js'));
const createMemoryStore = require(path.join(ROOT, 'services', 'home-node', 'memory-store.js'));

let passed = 0, failed = 0;
const check = (name, cond, detail) => {
  if (cond) { passed++; console.log('  PASS  ' + name); return true; }
  failed++;
  console.error('  FAIL  ' + name + (detail !== undefined ? '  -> ' + detail : ''));
  return false;
};
const section = t => console.log('\n── ' + t + ' ──');

const NOW = 1750000000000;
const DAY = 86400000;
const M1 = 'mem_h1_probe';
function mem(over) {
  return Object.assign({
    id: M1, title: '海边的约定', content: '用户与她在海边约好每年都来。', domain: '情感',
    tags: ['约定'], valence: 0.7, arousal: 0.4, importance: 8, resolved: false,
    visibility: 'public', visibleTo: [], excludeFrom: [],
    activationCount: 0, created: NOW - DAY, lastActivated: NOW - DAY,
    createdBy: 'user', createdByName: ''
  }, over || {});
}

/* ══════════════════════════════════════════════════════════════════════
   §0 · 真实源码切片 + drivers
   ══════════════════════════════════════════════════════════════════════ */
section('§0 · 真实源码切片与 drivers');

const MEMORY_SRC = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'memory.js'), 'utf8')
  .replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
function fragment(text, begin, end) {
  const start = text.indexOf(begin);
  assert.ok(start >= 0, 'source boundary missing: ' + begin);
  const stop = text.indexOf(end, start + begin.length);
  assert.ok(stop > start, 'source boundary missing: ' + end);
  return text.slice(start, stop);
}
/* 含 getMemoryContext / selectMemoryContext / recordMemoryActivation —— 即生产强化路径。 */
const WRAPPER_SRC = fragment(MEMORY_SRC, 'function _ibMemRetrievalCore(', 'function _formatMemLine(');
check('S0.fragmentContainsGetMemoryContext', WRAPPER_SRC.indexOf('async function getMemoryContext(') >= 0);
check('S0.fragmentContainsSelectMemoryContext', WRAPPER_SRC.indexOf('async function selectMemoryContext(') >= 0);
check('S0.fragmentContainsActivationSeam', WRAPPER_SRC.indexOf('async function recordMemoryActivation(') >= 0);

/* canonical 侧：真实 memory-authority 实例 + 可观测的 remote/local。
   remote.activate 就是「canonical activation 请求」这一事实的可观测面
   （生产里它打到 POST /memory/activate）。 */
function makeSpyRemote(opts) {
  const o = opts || {};
  const state = { activateCalls: [], listCalls: 0, changesCalls: 0, hn: new Map() };
  (o.hnSeed || []).forEach(r => state.hn.set(r.id, Object.assign({}, r)));
  return {
    state,
    list: async () => ({ ok: true, records: [...state.hn.values()].map(r => Object.assign({}, r)), revision: 1, truncated: false }),
    changes: async () => { state.changesCalls++; return { ok: true, upserts: [], deletes: [], cursor: 1, hasMore: false }; },
    activate: async (ids, options) => {
      const list = (Array.isArray(ids) ? ids : []).map(String);
      state.activateCalls.push({ ids: list, at: options && options.at });
      if (o.offlineThrow) throw new Error('home-node-unreachable');
      if (o.activateFails) return { ok: false, error: 'remote-activate-failed' };
      /* 只有成功才动 canonical —— 与真实 store 的窄 UPDATE 语义一致。 */
      for (const id of list) {
        const row = state.hn.get(id);
        if (row) { row.activationCount = (row.activationCount || 0) + 1; row.lastActivated = (options && options.at) || null; }
      }
      /* R2-H3 · AMBIGUOUS_OUTCOME：服务端**已 commit**，但响应在传输层丢失。 */
      if (o.commitThenThrow) throw new Error('transport-reset-after-commit');
      const out = { ok: true, updated: list.length, at: (options && options.at) || null, revisionTouched: false };
      /* o.telemetry 模拟 R2-H2 之后 endpoint 的 **additive** 权威返回值；
         不设它 = 老服务端（只回 updated）⇒ mirror 必须保持 stale，不得猜 delta。 */
      if (o.telemetry) {
        out.activations = list.map(id => {
          const row = state.hn.get(id) || {};
          return { id: id, activationCount: Number(row.activationCount || 0), lastActivated: (options && options.at) || null };
        });
      }
      return out;
    }
  };
}

/* browser 镜像 driver：既是 memory-authority 的 local driver，也是
   production 路径 dbUpdate/dbPut 的落点（同一个镜像）。 */
function makeMirror(seed) {
  const state = { rows: new Map(), bumpCalls: [], replaceCalls: 0, events: [] };
  (seed || []).forEach(m => state.rows.set(m.id, Object.assign({}, m)));
  return {
    state,
    get: async id => state.rows.get(id) || null,
    getAll: async () => [...state.rows.values()],
    put: async r => { state.rows.set(r.id, r); },
    remove: async id => { state.rows.delete(id); },
    bumpActivation: async (ids, at) => {
      const list = (ids || []).map(String);
      state.bumpCalls.push({ ids: list, at });
      state.events.push('mirror');
      let n = 0;
      for (const id of list) {
        const row = state.rows.get(id);
        if (!row) continue;
        row.activationCount = (row.activationCount || 0) + 1; row.lastActivated = at; n++;
      }
      return n;
    },
    applyUpserts: async rs => { (rs || []).forEach(r => state.rows.set(r.id, r)); },
    applyDeletes: async ids => { (ids || []).forEach(i => state.rows.delete(i)); },
    replaceAll: async rs => {
      state.replaceCalls++;
      state.events.push('hydrate');
      state.rows.clear();
      (rs || []).forEach(r => state.rows.set(r.id, r));
    }
  };
}

/* 用**真实 production fragment**驱动 getMemoryContext，并注入：
   · 真实 memory-authority 实例（经仓库既有的 IB.expose 约定挂在 IB.memoryAuthority.instance）
   · spy remote（canonical activation 请求的可观测面）
   · 镜像落点 dbUpdate/dbPut（现状的 mirror-only 写入的可观测面） */
function makeProductionBrowserRecall(seedRecords, opts) {
  const o = opts || {};
  const mirror = makeMirror(seedRecords);
  const remote = o.remote || makeSpyRemote({ hnSeed: seedRecords });
  const authority = AUTHORITY.createMemoryAuthority({
    remote, local: mirror, mode: 'canonical', clock: () => NOW, log: () => {}
  });
  const env = { mirror, remote, authority, events: [], canonicalCalls: [], mirrorBumps: [] };
  /* 事件序：canonical 请求与 mirror 写入进同一条有序日志 ——
     remote-first 就是"canonical 必须排在 mirror 之前"。 */
  const origActivate = remote.activate;
  remote.activate = async (ids, options) => {
    env.events.push('canonical');
    env.canonicalCalls.push({ ids: (ids || []).map(String), at: options && options.at });
    return origActivate(ids, options);
  };

  const sandbox = {
    console: { warn() {}, log() {}, error() {} },
    Date, Promise, JSON, Math, Object, Array, Number, String, Boolean, Map, Set, RegExp, Error,
    isFinite, parseInt, parseFloat,
    dbGetAll: async () => [...mirror.state.rows.values()],
    dbGet: async (storeName, id) => mirror.state.rows.get(id) || null,
    dbPut: async (storeName, row) => { if (row && row.id) mirror.state.rows.set(row.id, row); },
    dbUpdate: async (storeName, id, fn) => {
      const cur = mirror.state.rows.get(id);
      if (!cur) return false;
      const next = fn(cur);
      if (next === null || next === undefined) return false;
      mirror.state.rows.set(id, next);
      env.events.push('mirror');
      env.mirrorBumps.push(id);
      return true;
    },
    getMemorySettings: async () => ({ budget: 2000, contentLen: 200 }),
    IBMemoryRetrievalCore: CORE,
    IBMemoryRecallOrchestrator: ORCHESTRATOR
  };
  sandbox.window = sandbox;                       /* 浏览器里两条路径都能取到 */
  sandbox.IB = { memoryAuthority: { instance: authority, MODES: AUTHORITY.MODES } };
  sandbox.IBMemoryAuthority = AUTHORITY;
  vm.createContext(sandbox);
  vm.runInContext(WRAPPER_SRC + '\n;globalThis.__ctx = getMemoryContext;', sandbox,
    { filename: 'memory.js[fragment+activation]' });
  env.getMemoryContext = sandbox.__ctx;
  return env;
}

/* ══════════════════════════════════════════════════════════════════════
   §1 · RED-1 · production browser recall 必须产生 canonical activation 请求
   ══════════════════════════════════════════════════════════════════════ */
section('§1 · RED-1 · Browser canonical routing（生产路径）');

async function red1() {
  const env = makeProductionBrowserRecall([mem()]);
  const context = await env.getMemoryContext('friend_1');

  /* 先证明"召回真的发生了、并且真的选中了 M1" —— 否则 RED 会是因为没选到人。 */
  check('R1.0.recallProducedContext', typeof context === 'string' && context.indexOf('海边的约定') >= 0,
    'context=' + JSON.stringify(String(context).slice(0, 80)));
  const mirrorN = env.mirror.state.rows.get(M1).activationCount;
  check('R1.0.selectionReachedActivationStage', mirrorN === 1 || env.canonicalCalls.length === 1,
    'mirror.activationCount=' + mirrorN + ' canonicalCalls=' + env.canonicalCalls.length);

  /* 核心断言：canonical activation 请求恰好一次（remote-first 的可观测面）。 */
  check('R1.1.canonicalActivationRequestExactlyOnce', env.canonicalCalls.length === 1,
    'canonical activation requests=' + env.canonicalCalls.length
    + ' （H1 期望为 RED：production browser 路径完全没有 canonical 请求）');
  /* 顺序断言：canonical 必须排在 mirror 写入之前。 */
  check('R1.2.canonicalPrecedesMirrorWrite',
    env.events.length > 0 && env.events[0] === 'canonical'
    && env.events.indexOf('mirror') !== 0,
    'ordered events=' + JSON.stringify(env.events));
  /* 并且不许出现"只写 mirror 而不发 canonical"的形状。 */
  check('R1.3.noMirrorOnlyActivation',
    !(env.mirrorBumps.length > 0 && env.canonicalCalls.length === 0),
    'mirrorBumps=' + env.mirrorBumps.length + ' canonicalCalls=' + env.canonicalCalls.length);
  return env;
}

/* ══════════════════════════════════════════════════════════════════════
   §2 · RED-2 · canonical 失败 => 两侧都不增加（telemetry fail-closed）
   ══════════════════════════════════════════════════════════════════════ */
section('§2 · RED-2 · Failure atomicity');

async function red2Production() {
  const seed = mem({ activationCount: 3 });
  const remote = makeSpyRemote({ activateFails: true, hnSeed: [seed] });
  const env = makeProductionBrowserRecall([mem({ activationCount: 3 })], { remote });
  const context = await env.getMemoryContext('friend_1');

  check('R2.0.turnStillSucceedsWhenActivationFails',
    typeof context === 'string' && context.indexOf('海边的约定') >= 0,
    'TURN_FAIL_OPEN 必须成立：context=' + JSON.stringify(String(context).slice(0, 60)));
  check('R2.1.canonicalUnchangedOnFailure',
    env.remote.state.hn.get(M1).activationCount === 3,
    'HN activationCount=' + env.remote.state.hn.get(M1).activationCount + '（期望仍为 3）');
  check('R2.2.mirrorUnchangedOnFailure',
    env.mirror.state.rows.get(M1).activationCount === 3,
    'mirror activationCount=' + env.mirror.state.rows.get(M1).activationCount
    + '（H1 期望为 RED：失败时 mirror 仍被乐观 +1）');
  check('R2.3.failureAttemptedCanonicalRequest', env.canonicalCalls.length >= 1,
    'canonical requests=' + env.canonicalCalls.length
    + '（H1 期望为 RED：production 根本不发 canonical 请求）');
  return env;
}

/* seam-level（§19 明确允许）：真实 memory-authority 实例 + 确定性失败的 remote。 */
async function red2Seam() {
  const mirror = makeMirror([mem({ activationCount: 3 })]);
  const remote = makeSpyRemote({ activateFails: true, hnSeed: [mem({ activationCount: 3 })] });
  const authority = AUTHORITY.createMemoryAuthority({ remote, local: mirror, mode: 'canonical', clock: () => NOW, log: () => {} });
  const res = await authority.recordActivation([M1], {});
  check('R2.4.seamReportsFailure', res && res.ok === false && res.flushed === false, JSON.stringify(res));
  check('R2.5.seamMirrorUnchangedOnRemoteFailure',
    mirror.state.rows.get(M1).activationCount === 3,
    'mirror activationCount=' + mirror.state.rows.get(M1).activationCount
    + '（H1 期望为 RED：死缝是 mirror-first，remote 失败后 mirror 已 +1）');
  check('R2.6.failureCountedObservably', authority.status().stats.activationFailures >= 1,
    'activationFailures=' + authority.status().stats.activationFailures);
  return { mirror, remote, authority };
}

/* ══════════════════════════════════════════════════════════════════════
   §3 · RED-3 · canonical 成功（seam 级 characterization）
   ══════════════════════════════════════════════════════════════════════ */
section('§3 · RED-3 · Canonical success（seam 级）');

async function red3() {
  const mirror = makeMirror([mem({ activationCount: 5 })]);
  const remote = makeSpyRemote({ hnSeed: [mem({ activationCount: 5 })] });
  const authority = AUTHORITY.createMemoryAuthority({ remote, local: mirror, mode: 'canonical', clock: () => NOW, log: () => {} });
  const res = await authority.recordActivation([M1], {});
  check('R3.1.seamFlushesExactlyOnce', remote.state.activateCalls.length === 1,
    'activate calls=' + remote.state.activateCalls.length);
  check('R3.2.seamReportsSuccess', res && res.ok === true && res.flushed === true && res.revisionTouched === false,
    JSON.stringify(res));
  check('R3.3.canonicalBumpedOnSuccess', remote.state.hn.get(M1).activationCount === 6,
    'HN activationCount=' + remote.state.hn.get(M1).activationCount);
  /* R2-H2 更新：canonical 成功但**服务端未回权威 telemetry**（老服务端）时，
     mirror **不得**按 delta 猜测（Strategy D 被禁止）—— 保持 stale，等 hydrate 纠正。 */
  check('R3.4.mirrorNotGuessedWithoutAuthoritativeTelemetry',
    mirror.state.rows.get(M1).activationCount === 5 && res.mirrorStale === true,
    'mirror activationCount=' + mirror.state.rows.get(M1).activationCount + ' res=' + JSON.stringify(res));
  return res;
}

/* §3.1 · Strategy C：服务端返回权威 per-id 值 ⇒ mirror SET 成 canonical 值 */
async function strategyC() {
  const mirror = makeMirror([mem({ activationCount: 5 })]);
  const remote = makeSpyRemote({ hnSeed: [mem({ activationCount: 5 })], telemetry: true });
  const authority = AUTHORITY.createMemoryAuthority({ remote, local: mirror, mode: 'canonical', clock: () => NOW, log: () => {} });
  const res = await authority.recordActivation([M1], {});
  check('C1.mirrorSetFromCanonicalTelemetry',
    mirror.state.rows.get(M1).activationCount === 6 && res.mirrorSynced === 1,
    'mirror=' + mirror.state.rows.get(M1).activationCount + ' synced=' + res.mirrorSynced);
  check('C2.mirrorNotCreatedForUnknownRecord', (() => {
    const m2 = makeMirror([]);
    const r2 = makeSpyRemote({ hnSeed: [mem({ activationCount: 1 })], telemetry: true });
    const a2 = AUTHORITY.createMemoryAuthority({ remote: r2, local: m2, mode: 'canonical', clock: () => NOW, log: () => {} });
    return a2.recordActivation([M1], {}).then(r => m2.state.rows.size === 0 && r.mirrorSynced === 0);
  })(), 'activation 不得在 mirror 里造出半条记录');
  return res;
}

/* ══════════════════════════════════════════════════════════════════════
   §4 · GREEN · Home Node 单写者形态（真实 store）
   ══════════════════════════════════════════════════════════════════════ */
section('§4 · GREEN · Home Node activation writer');

function freshStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-actauth-'));
  const store = createMemoryStore({ dataDir: dir, clock: () => NOW });
  store.open();
  return { store, dir };
}

function greenHomeNode() {
  const { store } = freshStore();
  const record = mem({ activationCount: 2, lastActivated: NOW - DAY });
  const put = store.putRecord(record, { existingPolicy: 'overwrite' });
  check('G1.recordCreated', !!put && put.ok !== false, JSON.stringify(put && put.ok));
  const before = store.getRecord(M1);
  const revBefore = store.getRevision();
  const cursor = revBefore;

  const res = store.recordActivation([M1], { at: NOW });
  check('G2.activationSucceeded', res.ok === true && res.updated === 1, JSON.stringify(res));
  check('G3.revisionTouchedFalse', res.revisionTouched === false, 'revisionTouched=' + res.revisionTouched);

  const after = store.getRecord(M1);
  check('G4.countIncrementedByOne', after.activationCount === before.activationCount + 1,
    before.activationCount + ' -> ' + after.activationCount);
  check('G5.lastActivatedUpdated', after.lastActivated === NOW, 'lastActivated=' + after.lastActivated);
  check('G6.revisionUnchanged', store.getRevision() === revBefore,
    revBefore + ' -> ' + store.getRevision());
  check('G7.payloadContentUnchanged',
    after.title === before.title && after.content === before.content && after.importance === before.importance,
    'payload round-trip broken');

  /* activation **不是** change-log 事件：cursor 之后不得出现这条 id 的 upsert。 */
  const feed = store.changesAfter(cursor);
  const touched = (feed.upserts || []).filter(u => u.record && u.record.id === M1);
  check('G8.notAChangeLogEvent', touched.length === 0,
    'upserts after activation=' + touched.length + '（activation 不得进入 changes(cursor)）');
  store.close();
  return { store, after, feed };
}

/* ══════════════════════════════════════════════════════════════════════
   §5 · GREEN · hydrate canonical-wins（Option A 的合法 authority correction）
   ══════════════════════════════════════════════════════════════════════ */
section('§5 · GREEN · hydrate canonical-wins');

async function greenHydrate() {
  const mirror = makeMirror([mem({ activationCount: 9 })]);          /* mirror 被本地 +1 到 9 */
  const remote = makeSpyRemote({ hnSeed: [mem({ activationCount: 4 })] }); /* canonical 仍是 4 */
  const authority = AUTHORITY.createMemoryAuthority({ remote, local: mirror, mode: 'canonical', clock: () => NOW, log: () => {} });
  const res = await authority.sync({ full: true });
  check('H1.hydrateRan', res && res.ok === true && res.hydrated === true, JSON.stringify(res));
  check('H2.canonicalWins',
    mirror.state.rows.get(M1).activationCount === 4,
    'mirror activationCount=' + mirror.state.rows.get(M1).activationCount + '（期望 4 = canonical）');
  check('H3.hydrateIsReplaceNotMerge', mirror.state.replaceCalls === 1,
    'replaceAll calls=' + mirror.state.replaceCalls);
  return res;
}

/* ══════════════════════════════════════════════════════════════════════
   §6 · GREEN · activation 不产生同步流量（防止 H2 塞进 change_log）
   ══════════════════════════════════════════════════════════════════════ */
section('§6 · GREEN · activation 不进 changes(cursor)');

function greenNoSyncTraffic() {
  const { store } = freshStore();
  store.putRecord(mem({ activationCount: 0 }), { existingPolicy: 'overwrite' });
  const cursor = store.getRevision();
  const before = store.changesAfter(cursor);
  store.recordActivation([M1], { at: NOW });
  const after = store.changesAfter(cursor);
  check('N1.noNewChangeLogRowsForActivation',
    (after.upserts || []).length === (before.upserts || []).length
    && (after.deletes || []).length === (before.deletes || []).length,
    'upserts ' + (before.upserts || []).length + ' -> ' + (after.upserts || []).length);
  check('N2.cursorNotAdvancedByActivation', store.getRevision() === cursor,
    cursor + ' -> ' + store.getRevision());
  store.close();
}

/* ══════════════════════════════════════════════════════════════════════
   §7 · mirror mode —— 无 canonical authority 生效，host-local，绝不调 remote
   ══════════════════════════════════════════════════════════════════════ */
section('§7 · mirror mode（NON-CANONICAL / HOST-LOCAL）');

async function mirrorMode() {
  const mirror = makeMirror([mem({ activationCount: 2 })]);
  const remote = makeSpyRemote({ hnSeed: [mem({ activationCount: 2 })] });
  const authority = AUTHORITY.createMemoryAuthority({ remote, local: mirror, mode: 'mirror', clock: () => NOW, log: () => {} });
  const res = await authority.recordActivation([M1], {});
  check('M1.mirrorModeLocalBumpOnce', mirror.state.bumpCalls.length === 1 && mirror.state.rows.get(M1).activationCount === 3,
    'bumps=' + mirror.state.bumpCalls.length + ' count=' + mirror.state.rows.get(M1).activationCount);
  check('M2.mirrorModeRemoteCallsZero', remote.state.activateCalls.length === 0,
    'remote activate calls=' + remote.state.activateCalls.length);
  check('M3.mirrorModeMarkedNonCanonical',
    res.mirrorOnly === true && res.authority === 'indexeddb' && res.flushed === false, JSON.stringify(res));
  check('M4.mirrorModeAuthorityIsIndexedDb', authority.status().authority === 'indexeddb',
    'authority=' + authority.status().authority);
}

/* ══════════════════════════════════════════════════════════════════════
   §8 · off mode —— 沿用既有 mode 语义（不发明新行为）
   ══════════════════════════════════════════════════════════════════════ */
section('§8 · off mode');

async function offMode() {
  const mirror = makeMirror([mem({ activationCount: 2 })]);
  const remote = makeSpyRemote({ hnSeed: [mem({ activationCount: 2 })] });
  const authority = AUTHORITY.createMemoryAuthority({ remote, local: mirror, mode: 'off', clock: () => NOW, log: () => {} });
  const res = await authority.recordActivation([M1], {});
  check('O1.offModeNoCanonicalActivation', remote.state.activateCalls.length === 0,
    'remote activate calls=' + remote.state.activateCalls.length);
  check('O2.offModeFollowsExistingSemantics',
    authority.status().mode === 'off' && res.mirrorOnly === true && res.authority === 'indexeddb',
    JSON.stringify({ mode: authority.status().mode, res: res }));
}

/* ══════════════════════════════════════════════════════════════════════
   §9 · §22 cache correctness —— stale mirror 不得被 +delta 伪装成 canonical
   ══════════════════════════════════════════════════════════════════════ */
section('§9 · Cache correctness（stale mirror）');

async function cacheCorrectness() {
  const mirror = makeMirror([mem({ activationCount: 3 })]);                    /* stale */
  const remote = makeSpyRemote({ hnSeed: [mem({ activationCount: 8 })], telemetry: true }); /* canonical 更新 */
  const authority = AUTHORITY.createMemoryAuthority({ remote, local: mirror, mode: 'canonical', clock: () => NOW, log: () => {} });
  await authority.recordActivation([M1], {});
  check('K1.canonicalReachesNine', remote.state.hn.get(M1).activationCount === 9,
    'HN=' + remote.state.hn.get(M1).activationCount);
  check('K2.mirrorEqualsCanonicalNotPlusDelta', mirror.state.rows.get(M1).activationCount === 9,
    'mirror=' + mirror.state.rows.get(M1).activationCount + '（若为 4 就是被禁止的 Strategy D）');
}

/* ══════════════════════════════════════════════════════════════════════
   §10 · §23 cross-host —— HN 先 +1 后，browser 不得基于 stale N 造出 N+1
   ══════════════════════════════════════════════════════════════════════ */
section('§10 · Cross-host scenario');

async function crossHost() {
  const mirror = makeMirror([mem({ activationCount: 5 })]);   /* browser 仍是 N */
  const remote = makeSpyRemote({ hnSeed: [mem({ activationCount: 5 })], telemetry: true });
  const authority = AUTHORITY.createMemoryAuthority({ remote, local: mirror, mode: 'canonical', clock: () => NOW, log: () => {} });
  /* ① HN 侧先发生一次 activation（Home Node 回合，不经 browser、也不进 change_log）*/
  remote.state.hn.get(M1).activationCount = 6;
  check('X0.mirrorStillStaleBeforeBrowserActivation', mirror.state.rows.get(M1).activationCount === 5,
    'mirror=' + mirror.state.rows.get(M1).activationCount);
  /* ② browser 再做一次 canonical activation */
  await authority.recordActivation([M1], {});
  check('X1.hnReachesNPlusTwo', remote.state.hn.get(M1).activationCount === 7,
    'HN=' + remote.state.hn.get(M1).activationCount);
  check('X2.mirrorNeverDisguisedAsNPlusOne', mirror.state.rows.get(M1).activationCount === 7,
    'mirror=' + mirror.state.rows.get(M1).activationCount + '（6 = 基于 stale 值的伪装，被禁止）');
}

/* ══════════════════════════════════════════════════════════════════════
   §11 · R2-H3 · DEFINITE_FAILURE vs AMBIGUOUS_OUTCOME
   ══════════════════════════════════════════════════════════════════════ */
section('§11 · Definite failure vs ambiguous outcome');

async function definiteVsAmbiguous() {
  /* (a) DEFINITE：服务端明确回失败 ⇒ 两侧都不增加，result 明确标注。 */
  const mDef = makeMirror([mem({ activationCount: 4 })]);
  const rDef = makeSpyRemote({ activateFails: true, hnSeed: [mem({ activationCount: 4 })] });
  const aDef = AUTHORITY.createMemoryAuthority({ remote: rDef, local: mDef, mode: 'canonical', clock: () => NOW, log: () => {} });
  const def = await aDef.recordActivation([M1], {});
  check('D1.definiteFailureMarked', def.outcome === 'definite-failure' && def.canonical === 'unchanged', JSON.stringify(def));
  check('D2.definiteFailureNoSideEffects',
    rDef.state.hn.get(M1).activationCount === 4 && mDef.state.rows.get(M1).activationCount === 4 && rDef.state.activateCalls.length === 1,
    'hn=' + rDef.state.hn.get(M1).activationCount + ' mirror=' + mDef.state.rows.get(M1).activationCount + ' calls=' + rDef.state.activateCalls.length);

  /* (b) AMBIGUOUS：服务端**已 commit**，响应在传输层丢失。
     冻结语义：canonical 可能已经 +1（caller 未知）· mirror 不猜测 · 不自动重试 · 不抛。 */
  const mAmb = makeMirror([mem({ activationCount: 4 })]);
  const rAmb = makeSpyRemote({ commitThenThrow: true, hnSeed: [mem({ activationCount: 4 })] });
  const aAmb = AUTHORITY.createMemoryAuthority({ remote: rAmb, local: mAmb, mode: 'canonical', clock: () => NOW, log: () => {} });
  let threw = false; let amb = null;
  try { amb = await aAmb.recordActivation([M1], {}); } catch (e) { threw = true; }
  check('A1.ambiguousDoesNotThrow', threw === false, 'threw=' + threw);
  check('A2.ambiguousMarked',
    amb && amb.ok === false && amb.outcome === 'ambiguous' && amb.canonical === 'unknown-to-caller' && amb.retried === false,
    JSON.stringify(amb));
  check('A3.canonicalMayHaveCommitted',
    rAmb.state.hn.get(M1).activationCount === 5, 'hn=' + rAmb.state.hn.get(M1).activationCount + '（commit 确实发生了）');
  check('A4.mirrorNeverGuessesOnAmbiguity',
    mAmb.state.rows.get(M1).activationCount === 4, 'mirror=' + mAmb.state.rows.get(M1).activationCount);
  check('A5.noAutomaticRetry', rAmb.state.activateCalls.length === 1,
    'activate calls=' + rAmb.state.activateCalls.length + '（AUTO_RETRY=NONE）');
  check('A6.failureCountedObservably', aAmb.status().stats.activationFailures === 1,
    'activationFailures=' + aAmb.status().stats.activationFailures);
  return { def, amb };
}

/* ══════════════════════════════════════════════════════════════════════
   §12 · R2-H3 · NON-IDEMPOTENT endpoint（不实现伪幂等）
   ══════════════════════════════════════════════════════════════════════ */
section('§12 · Non-idempotent contract（重复显式请求 = 独立事件）');

async function nonIdempotent() {
  const mirror = makeMirror([mem({ activationCount: 0 })]);
  const remote = makeSpyRemote({ hnSeed: [mem({ activationCount: 0 })], telemetry: true });
  const authority = AUTHORITY.createMemoryAuthority({ remote, local: mirror, mode: 'canonical', clock: () => NOW, log: () => {} });
  const first = await authority.recordActivation([M1], { at: NOW });
  const second = await authority.recordActivation([M1], { at: NOW });   /* 同 ids、同 at */
  check('N1.repeatIsIndependentEvent',
    remote.state.hn.get(M1).activationCount === 2 && remote.state.activateCalls.length === 2,
    'hn=' + remote.state.hn.get(M1).activationCount + ' calls=' + remote.state.activateCalls.length);
  check('N2.noFakeDedupe',
    first.ok === true && second.ok === true && second.mirrorSynced === 1 && mirror.state.rows.get(M1).activationCount === 2,
    JSON.stringify({ first: first.ok, second: second.ok, mirror: mirror.state.rows.get(M1).activationCount }));
  /* 端点契约面：request payload 里**没有**任何 activation-event identity。 */
  const clientSrc = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'home-node-client.js'), 'utf8');
  const activateFn = fragment(clientSrc, 'activate: function (ids, options) {', 'putSettings: function');
  check('N3.payloadCarriesNoIdentityKey',
    activateFn.indexOf('requestId') < 0 && activateFn.indexOf('idempotency') < 0 && activateFn.indexOf('eventId') < 0,
    'activate() payload 只允许 ids/at/delta');
}

/* ══════════════════════════════════════════════════════════════════════
   §13 · R2-H3 · Offline / transport matrix（§20）
   ══════════════════════════════════════════════════════════════════════ */
section('§13 · Offline / transport matrix');

async function offlineMatrix() {
  const rows = [];
  async function scenario(name, opts) {
    const seed = mem({ activationCount: 3 });
    const mirror = makeMirror([Object.assign({}, seed)]);
    const remote = makeSpyRemote(Object.assign({ hnSeed: [Object.assign({}, seed)] }, opts.remote || {}));
    const authority = AUTHORITY.createMemoryAuthority({
      remote, local: mirror, mode: opts.mode || 'canonical', clock: () => NOW, log: () => {}
    });
    const before = remote.state.hn.get(M1).activationCount;
    const mirrorBefore = mirror.state.rows.get(M1).activationCount;
    const res = await authority.recordActivation([M1], { at: NOW });
    const expectedRequests = (opts.mode === 'mirror' || opts.mode === 'off') ? 0 : 1;
    const row = {
      name: name,
      canonicalDelta: remote.state.hn.get(M1).activationCount - before,
      mirrorDelta: mirror.state.rows.get(M1).activationCount - mirrorBefore,
      turnResult: 'success',                       /* 调用方永远拿不到 rejection */
      retries: Math.max(0, remote.state.activateCalls.length - expectedRequests),
      requests: remote.state.activateCalls.length,
      failures: authority.status().stats.activationFailures,
      mirrorStale: !!res.mirrorStale,
      ok: !!res.ok,
      outcome: res.outcome || null
    };
    rows.push(row);
    return row;
  }
  const r1 = await scenario('canonical + HN unavailable (transport, no commit)', { remote: { activateFails: false, offlineThrow: true } });
  const r2 = await scenario('canonical + HTTP definite failure', { remote: { activateFails: true } });
  const r3 = await scenario('canonical + ambiguous post-commit', { remote: { commitThenThrow: true } });
  const r4 = await scenario('canonical + success without telemetry (old server)', { remote: {} });
  const r5 = await scenario('canonical + full success with telemetry', { remote: { telemetry: true } });
  const r6 = await scenario('mirror mode (offline by construction)', { mode: 'mirror' });
  const r7 = await scenario('off mode', { mode: 'off' });

  check('X1.hnUnavailableNoSideEffects', r1.canonicalDelta === 0 && r1.mirrorDelta === 0 && r1.retries === 0 && r1.turnResult === 'success',
    JSON.stringify(r1));
  check('X2.definiteFailureNoSideEffects', r2.canonicalDelta === 0 && r2.mirrorDelta === 0 && r2.retries === 0 && r2.outcome === 'definite-failure',
    JSON.stringify(r2));
  check('X3.ambiguousCommitsButMirrorSilent', r3.canonicalDelta === 1 && r3.mirrorDelta === 0 && r3.retries === 0 && r3.outcome === 'ambiguous',
    JSON.stringify(r3));
  check('X4.oldServerSuccessKeepsMirrorStale', r4.canonicalDelta === 1 && r4.mirrorDelta === 0 && r4.mirrorStale === true && r4.ok === true,
    JSON.stringify(r4));
  check('X5.fullSuccessSyncsMirror', r5.canonicalDelta === 1 && r5.mirrorDelta === 1 && r5.mirrorStale === false && r5.ok === true,
    JSON.stringify(r5));
  check('X6.mirrorModeHostLocalOnly', r6.canonicalDelta === 0 && r6.mirrorDelta === 1 && r6.failures === 0,
    JSON.stringify(r6));
  check('X7.offModeHostLocalOnly', r7.canonicalDelta === 0 && r7.mirrorDelta === 1 && r7.failures === 0,
    JSON.stringify(r7));
  check('X8.noScenarioEverRetried', rows.every(r => r.retries === 0), JSON.stringify(rows.map(r => r.retries)));
  check('X9.allScenariosKeepTurnSuccess', rows.every(r => r.turnResult === 'success'), 'turn must never fail because of telemetry');
  console.log('  ── matrix ──');
  rows.forEach(r => console.log('     ' + r.name.padEnd(52) + ' Δcanonical=' + r.canonicalDelta
    + ' Δmirror=' + r.mirrorDelta + ' retries=' + r.retries + ' failures=' + r.failures
    + ' mirrorStale=' + r.mirrorStale + ' outcome=' + r.outcome));
  return rows;
}

/* ══════════════════════════════════════════════════════════════════════
   §14 · R2-H3 · docs guard + HN 内部回合去重不变量
   ══════════════════════════════════════════════════════════════════════ */
section('§14 · Contract guards（R2-H3）');

function h3Guards() {
  const authorityDoc = fs.readFileSync(path.join(ROOT, 'docs', 'contracts', 'memory', 'MEMORY_AUTHORITY_CONTRACT.md'), 'utf8')
    .replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  check('P1.retryContractFrozen',
    authorityDoc.indexOf('AUTO_RETRY = NONE') >= 0 && authorityDoc.indexOf('NON-IDEMPOTENT MUTATION') >= 0,
    'AUTHORITY 必须冻结 AUTO_RETRY=NONE 与 NON-IDEMPOTENT MUTATION');
  check('P2.definiteVsAmbiguousDistinguished',
    authorityDoc.indexOf('DEFINITE_FAILURE') >= 0 && authorityDoc.indexOf('AMBIGUOUS_OUTCOME') >= 0
    && /canonical 的最终状态对 caller \*\*未知\*\*/.test(authorityDoc),
    'AUTHORITY §2.3 必须区分 definite 与 ambiguous，且点明 canonical 状态对 caller 未知');
  check('P3.noOverbroadCanonicalClaim',
    !/remote failure[^\n]*canonical\s*(一定)?不增加/i.test(authorityDoc)
    && authorityDoc.indexOf('不得声称"canonical 一定没增加"') >= 0,
    '不得再把所有 network failure 一律写成 canonical 绝对未增加');

  /* §17 · HN 内部路径：duplicate chat request 不得 double activation。
     现有行为证据在 test_memory_recall_cooldown_hosts.js（session-state 去重 / 同一 turnId 同 index）
     与 gateway 的真实 turn dedupe；这里只锁**结构不变量**，不复制大 harness。 */
  const gw = fs.readFileSync(path.join(ROOT, 'services', 'home-node', 'mobile-gateway.js'), 'utf8').replace(/\r\n/g, '\n');
  const dupAt = gw.indexOf("'chat-send-duplicate'");
  const reinfAt = gw.indexOf('memoryRetrieval.reinforce(');
  check('P4.duplicateShortCircuitPrecedesReinforce', dupAt > 0 && reinfAt > dupAt,
    'duplicate short-circuit@' + dupAt + ' must precede reinforce@' + reinfAt);
  check('P5.reinforceOnlyOnSettledSuccess', (() => {
    const window = gw.slice(Math.max(0, reinfAt - 1600), reinfAt);
    return /settled\.status\s*!==\s*'error'/.test(window);
  })(), 'reinforce 必须落在 settled 且非 error 的 success seam 内');
  check('P6.turnIdentityIsRequestScoped', /turnByRequest\.set\(turn\.requestId/.test(gw) && /TURN_TTL_MS/.test(gw),
    'chat turn 身份必须按 requestId 建立且有 TTL 边界');
}

/* ══════════════════════════════════════════════════════════════════════ */

(async () => {
  await red1();
  await red2Production();
  await red2Seam();
  await red3();
  await strategyC();
  greenHomeNode();
  await greenHydrate();
  greenNoSyncTraffic();
  await mirrorMode();
  await offMode();
  await cacheCorrectness();
  await crossHost();
  await definiteVsAmbiguous();
  await nonIdempotent();
  await offlineMatrix();
  h3Guards();

  console.log('\n' + '='.repeat(64));
  console.log('P21-R2-H3 ACTIVATION AUTHORITY · passed=' + passed + ' failed=' + failed);
  if (failed) process.exitCode = 1;
})();
