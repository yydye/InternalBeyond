'use strict';

/* Internal Beyond · P25-2A · Moments Autonomy Adapter Foundation 测试
   （static 组：纯 Node、零浏览器、零外部网络；运行：
     node tests/test_moments_autonomy.js）

   本阶段是 P25 的**第一次真实业务接入**，因此这一条测试要同时证明四件事：

     ① 契约：candidate / recommendation / policy 的闭集性与确定性
        （同样输入 ⇒ 同样 candidateId；missing / malformed / 未知词 ⇒ DENY）
     ② 边界：Adapter → P25 Core → Executor
        （只有 allow 才执行；deny / defer ⇒ executor 恰好 0 次；执行失败 ≠ DENY）
     ③ 写入权威：canonical 缺口闭合
        （mirror 与 Home Node canonical 都能合法写入；canonical 下
         **不再**触发 moments-write-closed；同一 candidate 重试只产生一行）
     ④ 不变量：P23 / P24 / Autonomy Core / 手动发帖路径 / 模型 / provider /
        Memory / scheduler 都不动（源码守卫 + 冻结 hash）

   真实度说明：③ 不用"测试自己写的假写者"来证明 canonical 语义 ——
   测试在 Node 里**真实加载 assets/js/moments.js**（vm 沙箱，最小全局桩），
   真实装配 assets/js/moments-authority.js（mirror / canonical 两种承载），
   canonical 侧后端是 services/home-node/moments-store.js 的**真实 store**
   （CAS / 幂等重放 / 内容等价 skipped 都是真的）。唯一被替身替换的是
   HTTP 传输层（remote.put → 真实 store.put），因为本阶段不引入网络。
   `dbPut('moments')` 在沙箱里复刻 home-node-bootstrap 的守卫语义
   （canonical 生效时以 moments-write-closed 拒绝）—— 这正是"缺口是否被闭合"
   的判据本身。 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const sha256 = f => crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, f))).digest('hex').toUpperCase();

const Core = require(path.join(ROOT, 'assets', 'js', 'autonomy-core.js'));
const MA = require(path.join(ROOT, 'assets', 'js', 'moments-autonomy.js'));
const createMomentsAuthority = require(path.join(ROOT, 'assets', 'js', 'moments-authority.js')).createMomentsAuthority;
const createMomentsStore = require(path.join(ROOT, 'services', 'home-node', 'moments-store.js'));
const MOMENTS_VIS = require(path.join(ROOT, 'assets', 'js', 'moments-visibility-core.js'));

let passed = 0, failed = 0;
const failures = [];
function check(name, cond, extra) {
  if (cond) { passed++; console.log('  \u2714 ' + name); }
  else { failed++; failures.push(name); console.log('  \u2716 ' + name + (extra === undefined ? '' : '  -> ' + JSON.stringify(extra).slice(0, 360))); }
}
function section(title) { console.log('\n── ' + title + ' ──'); }
const stripComments = src => String(src).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const countOf = (src, needle) => String(src).split(needle).length - 1;

/* 冻结基线（P25-2A 开工前实测；这三个文件本阶段**不得**变化）：
     autonomy-core.js        P25-1 的产物（本阶段零修改）
     communication.js        P24 冻结（本阶段零修改）
     group-runtime-core.js   P24 冻结（本阶段零修改） */
const FROZEN_SHA256 = {
  'assets/js/autonomy-core.js': 'FE1011F1DC3434DB6A72A328A63AFEEAE99E1E95762EA910CE379F019F2956F8',
  'assets/js/communication.js': 'DEB568A2F3653009C511BE25753E87AC9EF477FF229BE5CF569EB430AC29184F',
  'assets/js/group-runtime-core.js': '6F30FDE91F518B69B613B74B675B42EB66D227E36C1E18F04A3A1274067B35E8'
};

const FIXED_NOW = 1770000000000;   /* 注入时间：本阶段禁止 adapter 自己取时钟 */
const ACTOR = 'role_autonomy';
const PREFS_OK = { enabled: true, autoPublish: true, frequency: 'medium' };

const candidateInput = (patch) => Object.assign({
  actorId: ACTOR, source: 'schedule', triggerRef: 'tick:2026-09-19T10:00Z', topicFingerprint: 'rainy-window'
}, patch || {});
const recommendation = (patch) => Object.assign({
  recommendation: 'post', reasonCode: 'scheduled-window', topicFingerprint: 'rainy-window', draft: '今天把窗台擦干净了。'
}, patch || {});
function counterWriter(result) {
  const box = { calls: 0, payloads: [], options: [], fn: null };
  box.fn = (payload, options) => {
    box.calls++; box.payloads.push(payload); box.options.push(options || {});
    return Promise.resolve(result === undefined ? { ok: true, moment: Object.assign({}, payload) } : result);
  };
  return box;
}

/* ══════════════════ 真实 moments.js 沙箱 ══════════════════ */
const tempDirs = [];
function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ibma-'));
  tempDirs.push(dir);
  return dir;
}
process.on('exit', () => {
  for (const dir of tempDirs) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* 句柄未释放 */ } }
});

const MOMENTS_SRC = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'moments.js'), 'utf8').replace(/^\uFEFF/, '');

function makeLocalDriver(rows) {
  return {
    get: (id) => Promise.resolve(rows.get(String(id)) || null),
    getAll: () => Promise.resolve(Array.from(rows.values())),
    getByOwner: (roleId) => Promise.resolve(Array.from(rows.values()).filter(r => String(r.roleId) === String(roleId))),
    put: (row) => { if (!row || row.id == null) return Promise.resolve(false); rows.set(String(row.id), row); return Promise.resolve(true); },
    remove: (id) => { rows.delete(String(id)); return Promise.resolve(true); },
    replaceAll: (list) => { rows.clear(); (list || []).forEach(r => rows.set(String(r.id), r)); return Promise.resolve(true); },
    markMigrated: () => Promise.resolve({ ok: true }),
    deliveryState: () => Promise.resolve(null),
    saveDeliveryState: () => Promise.resolve(true)
  };
}
function makeStoreRemote(store) {
  return {
    health: () => Promise.resolve({ ok: true }),
    list: () => Promise.resolve({ ok: true, records: [], revision: 0 }),
    changes: () => Promise.resolve({ ok: true, upserts: [], deletes: [], cursor: 0, revision: 0 }),
    ack: () => Promise.resolve({ ok: true }),
    visible: () => Promise.resolve({ ok: true, moments: [] }),
    put: (record, options) => Promise.resolve(store.put(record, {
      requestId: options && options.requestId, expectedRev: options && options.expectedRev
    })),
    remove: (id, options) => Promise.resolve(store.remove(id, {
      requestId: options && options.requestId, expectedRev: options && options.expectedRev
    })),
    migrateBatch: () => Promise.resolve({ ok: true }),
    migrationState: () => Promise.resolve({ ok: true }),
    markMigration: () => Promise.resolve({ ok: true })
  };
}
/* mode: 'none'（无 Home Node 面）/ 'mirror' / 'canonical' / 'canonical-fail' */
function buildPage(mode, opts) {
  opts = opts || {};
  const rows = new Map();                       /* IndexedDB 镜像（浏览器侧） */
  const stats = { directPut: 0, directPutBlocked: 0, directPutOk: 0, loadCalls: 0, timers: 0, warns: [] };
  const stored = new Map();                     /* localStorage 桩 */
  const sandbox = {};
  let canonicalStore = null;
  const authorityEffective = (mode === 'canonical' || mode === 'canonical-fail');
  const IB = {
    expose: function (p, obj) { IB[p] = Object.assign(IB[p] || {}, obj); }
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.IB = IB;
  sandbox.console = { log() {}, info() {}, warn() { stats.warns.push(String(arguments[0])); }, error() {} };
  sandbox.setTimeout = function () { stats.timers++; return 0; };
  sandbox.clearTimeout = function () {};
  sandbox.localStorage = {
    getItem: (k) => (stored.has(String(k)) ? stored.get(String(k)) : null),
    setItem: (k, v) => { stored.set(String(k), String(v)); },
    removeItem: (k) => { stored.delete(String(k)); }
  };
  sandbox.IBMomentsVisibilityCore = MOMENTS_VIS;
  sandbox.apiConfigs = [];
  sandbox.archivedConfigs = [];
  sandbox.currentPage = opts.currentPage || 'moments';
  sandbox.loadMomentsPage = function () { stats.loadCalls++; };
  sandbox._activeUserId = () => 'user_local';
  /* dbPut / dbDelete：复刻 home-node-bootstrap 的守卫语义。
     canonical 生效 ⇒ 直接 dbPut('moments') 必须被拒绝（moments-write-closed）。 */
  sandbox.dbPut = function (store, row) {
    return new Promise((resolve, reject) => {
      if (String(store) === 'moments') {
        stats.directPut++;
        if (authorityEffective) {
          stats.directPutBlocked++;
          const e = new Error('moments 是 Home Node 的 canonical 域；浏览器不得直接写入（fail closed）');
          e.code = 'moments-write-closed';
          e.authority = 'home-node';
          reject(e);
          return;
        }
        rows.set(String(row.id), row); stats.directPutOk++;
        resolve(undefined);
        return;
      }
      resolve(undefined);
    });
  };
  sandbox.dbDelete = function (store, key) {
    return new Promise((resolve, reject) => {
      if (String(store) === 'moments' && authorityEffective) {
        const e = new Error('moments 是 Home Node 的 canonical 域；删除必须经 IB.homeNode.moments.remove');
        e.code = 'moments-delete-closed';
        reject(e);
        return;
      }
      rows.delete(String(key));
      resolve(undefined);
    });
  };
  sandbox.dbGet = (store, key) => Promise.resolve(rows.get(String(key)) || null);
  sandbox.dbGetAll = () => Promise.resolve(Array.from(rows.values()));
  sandbox.dbGetByIndex = () => Promise.resolve([]);
  vm.createContext(sandbox);
  vm.runInContext(MOMENTS_SRC, sandbox, { filename: 'moments.js' });
  /* moments.js 的导出会把 window.loadMomentsPage 指到它自己的真实实现
     （会去动 DOM）。沙箱里重新按回**可观测桩** —— 调用点读的是自由变量，
       因此重挂之后仍然能被观察到（这是"UI 刷新是否发生"的唯一判据）。 */
  sandbox.loadMomentsPage = function () { stats.loadCalls++; };

  if (mode !== 'none') {
    let remote = null;
    if (mode === 'canonical' || mode === 'canonical-fail') {
      if (mode === 'canonical') {
        canonicalStore = createMomentsStore({ dataDir: tempDir(), logger: () => {} });
        canonicalStore.open();
        remote = makeStoreRemote(canonicalStore);
      } else {
        remote = {
          put: () => Promise.resolve({ ok: false, error: 'store-closed' }),
          remove: () => Promise.resolve({ ok: false, error: 'store-closed' }),
          health: () => Promise.resolve({ ok: true }),
          list: () => Promise.resolve({ ok: false, error: 'store-closed' }),
          changes: () => Promise.resolve({ ok: false, error: 'store-closed' })
        };
      }
    }
    const authority = createMomentsAuthority({
      remote: remote, local: makeLocalDriver(rows),
      mode: authorityEffective ? 'canonical' : 'mirror',
      fileOrigin: false,
      log: function () {}
    });
    IB.homeNode = {
      moments: {
        instance: authority, available: true, authority: authority,
        status: function () { return authority.status(); },
        put: function (record, options) { return authority.put(record, options || {}); },
        remove: function (id, options) { return authority.remove(id, options || {}); }
      }
    };
  }
  return {
    sandbox, stats, rows, IB,
    store: canonicalStore,
    createMoment: (data, options) => sandbox.window.createMoment(data, options),
    liveCount: () => (canonicalStore ? canonicalStore.countLive() : rows.size),
    canonicalRow: (id) => (canonicalStore ? canonicalStore.getRecord(id) : rows.get(String(id)) || null)
  };
}

const CANONICAL_KEYS = ['authorId', 'authorType', 'comments', 'content', 'createdAt', 'id', 'images', 'likes',
  'motive', 'repostOf', 'repostText', 'roleId', 'source', 'visibility', 'visibleRoleIds'];

async function main() {
  console.log('== P25-2A · Moments Autonomy Adapter Foundation 测试 ==');

  /* ══════════════ A · Candidate contract / identity ══════════════ */
  section('A · Candidate contract / identity（MA1–MA5）');
  const built = MA.buildMomentCandidate(candidateInput());
  check('MA1.candidateValid', built.ok === true && built.candidate.actionType === 'moment.post'
    && built.candidate.actorId === ACTOR && built.candidate.source === 'schedule', built);
  check('MA1b.candidateRejectsMissingFields',
    MA.buildMomentCandidate({}).ok === false
    && MA.buildMomentCandidate({ actorId: ACTOR, source: 'schedule', triggerRef: 't' }).errors.indexOf('missing-topic-fingerprint') >= 0
    && MA.buildMomentCandidate({ actorId: ACTOR, source: 'schedule', topicFingerprint: 'f' }).errors.indexOf('missing-trigger-ref') >= 0
    && MA.buildMomentCandidate(null).errors.indexOf('not-an-object') >= 0);
  check('MA2.candidateIdDeterministic',
    built.candidate.candidateId === MA.buildMomentCandidate(candidateInput()).candidate.candidateId
    && /^mca_[0-9a-z]+$/.test(built.candidate.candidateId));
  check('MA3.sameCandidateInputsSameId',
    MA.momentCandidateId(candidateInput()).candidateId === built.candidate.candidateId
    && MA.buildMomentCandidate(candidateInput({ context: { a: 1 } })).candidate.candidateId === built.candidate.candidateId);
  check('MA4.differentInputsDifferentId', (() => {
    const ids = [
      built.candidate.candidateId,
      MA.buildMomentCandidate(candidateInput({ actorId: 'other_role' })).candidate.candidateId,
      MA.buildMomentCandidate(candidateInput({ triggerRef: 'other-trigger' })).candidate.candidateId,
      MA.buildMomentCandidate(candidateInput({ topicFingerprint: 'other-topic' })).candidate.candidateId
    ];
    return new Set(ids).size === 4;
  })());
  check('MA5.sourceUserRejected', (() => {
    const r = MA.buildMomentCandidate(candidateInput({ source: 'user' }));
    return r.ok === false && r.errors.indexOf('unsupported-source') >= 0
      && MA.MOMENT_CANDIDATE_SOURCES.indexOf('user') < 0;
  })());
  check('MA5b.fingerprintMustNotBeDraft',
    MA.buildMomentCandidate(candidateInput({ topicFingerprint: '今天把窗台擦干净了，窗外下着雨。', draft: '今天把窗台擦干净了，窗外下着雨。' })).ok === false
    && MA.buildMomentCandidate(candidateInput({ topicFingerprint: 'x'.repeat(200) })).errors.indexOf('bad-topic-fingerprint') >= 0);
  check('MA5c.secretInContextRejected',
    MA.buildMomentCandidate(candidateInput({ context: { apiKey: 'sk-abcdefgh12345678' } })).errors.indexOf('secret-in-context') >= 0);
  check('MA5d.identityCoreRequired', (() => {
    /* stableToken 缺席 ⇒ fail closed（绝不退回随机身份）。用 require 缓存的模块无法直接摘掉
       CHAT_CORE，因此这里以"合约要求"断言：candidateId 必须且只能来自 stableToken。 */
    const src = stripComments(read('assets/js/moments-autonomy.js'));
    return /CHAT_CORE\.stableToken/.test(src) && !/Math\.random/.test(src) && !/Date\.now/.test(src);
  })());

  /* ══════════════ B · Recommendation contract ══════════════ */
  section('B · Recommendation contract（MA6–MA10）');
  const cand = built.candidate;
  check('MA6.recommendationVocabularyClosed',
    JSON.stringify(MA.MOMENT_RECOMMENDATIONS) === JSON.stringify(['post', 'skip'])
    && MA.normalizeMomentRecommendation(recommendation(), cand).ok === true
    && MA.normalizeMomentRecommendation({ recommendation: 'skip', reasonCode: 'no-material', topicFingerprint: 'rainy-window' }, cand).ok === true);
  check('MA6b.skipReasonMustBeSkipReason',
    MA.normalizeMomentRecommendation({ recommendation: 'skip', reasonCode: 'scheduled-window', topicFingerprint: 'rainy-window' }, cand).ok === false
    && MA.normalizeMomentRecommendation({ recommendation: 'post', reasonCode: 'no-material', topicFingerprint: 'rainy-window' }, cand).ok === false);
  check('MA7.missingRecommendationDenied',
    MA.normalizeMomentRecommendation(undefined, cand).ok === false
    && MA.normalizeMomentRecommendation(undefined, cand).errors.indexOf('missing-recommendation') >= 0);
  check('MA8.malformedRecommendationDenied',
    MA.normalizeMomentRecommendation('post', cand).errors.indexOf('recommendation-not-an-object') >= 0
    && MA.normalizeMomentRecommendation({ recommendation: 'post', reasonCode: 'scheduled-window', topicFingerprint: 'rainy-window', draft: { x: 1 } }, cand).errors.indexOf('bad-draft') >= 0
    && MA.normalizeMomentRecommendation({ recommendation: 'post', reasonCode: 'scheduled-window', topicFingerprint: 'rainy-window', thinking: '因为……' }, cand).errors.indexOf('free-text-reason-forbidden') >= 0
    && MA.normalizeMomentRecommendation({ recommendation: 'post', reasonCode: 'scheduled-window', topicFingerprint: 'other' }, cand).errors.indexOf('fingerprint-mismatch') >= 0);
  check('MA9.unknownRecommendationDenied',
    MA.normalizeMomentRecommendation({ recommendation: 'maybe', reasonCode: 'scheduled-window', topicFingerprint: 'rainy-window' }, cand).errors.indexOf('unknown-recommendation') >= 0
    && MA.normalizeMomentRecommendation({ recommendation: 'post', reasonCode: 'whatever', topicFingerprint: 'rainy-window' }, cand).errors.indexOf('unknown-reason-code') >= 0);
  const skipWriter = counterWriter();
  const skipRun = await MA.runMomentAutonomy(candidateInput(), {
    now: FIXED_NOW, prefs: PREFS_OK, writeMoment: skipWriter.fn,
    recommendation: { recommendation: 'skip', reasonCode: 'no-material', topicFingerprint: 'rainy-window' }
  });
  check('MA10.skipDeniesWithoutExecutor',
    skipRun.decision === 'deny' && skipRun.reason === 'recommendation-skip' && skipWriter.calls === 0 && skipRun.written === false);

  /* ══════════════ C · Fail-closed policy ══════════════ */
  section('C · Fail-closed policy（MA11–MA16）');
  const noPolicy = await MA.runMomentAutonomy(candidateInput(), { now: FIXED_NOW, writeMoment: counterWriter().fn, recommendation: recommendation() });
  check('MA11.missingPrefsDenied', noPolicy.decision === 'deny' && noPolicy.reason === 'prefs-unavailable');
  const throwWriter = counterWriter();
  const policyThrow = await MA.runMomentAutonomy(candidateInput(), {
    now: FIXED_NOW, prefs: PREFS_OK, writeMoment: throwWriter.fn, recommendation: recommendation(),
    contentSanitizer: () => { throw new Error('sanitizer exploded'); }
  });
  check('MA12.policyThrowDenied', policyThrow.decision === 'deny' && policyThrow.reason === 'policy-failure' && throwWriter.calls === 0,
    policyThrow);
  const prefsThrow = await MA.runMomentAutonomy(candidateInput(), {
    now: FIXED_NOW, writeMoment: counterWriter().fn, recommendation: recommendation(),
    readPrefs: () => { throw new Error('storage exploded'); }
  });
  check('MA13.prefsReadFailureDenied', prefsThrow.decision === 'deny' && prefsThrow.reason === 'prefs-unavailable');
  const prefsMalformed = await MA.runMomentAutonomy(candidateInput(), {
    now: FIXED_NOW, writeMoment: counterWriter().fn, recommendation: recommendation(), prefs: { enabled: 'yes', autoPublish: true }
  });
  check('MA13b.prefsMalformedDenied', prefsMalformed.decision === 'deny' && prefsMalformed.reason === 'prefs-malformed');
  const disabled = await MA.runMomentAutonomy(candidateInput(), {
    now: FIXED_NOW, prefs: { enabled: false, autoPublish: true, frequency: 'medium' },
    writeMoment: counterWriter().fn, recommendation: recommendation()
  });
  check('MA14.enabledFalseDenied', disabled.decision === 'deny' && disabled.reason === 'prefs-disabled');
  const autoOff = await MA.runMomentAutonomy(candidateInput(), {
    now: FIXED_NOW, prefs: { enabled: true, autoPublish: false, frequency: 'medium' },
    writeMoment: counterWriter().fn, recommendation: recommendation()
  });
  check('MA15.autoPublishFalseDenied', autoOff.decision === 'deny' && autoOff.reason === 'autopublish-disabled');
  const allowedWriter = counterWriter();
  const allowed = await MA.runMomentAutonomy(candidateInput(), {
    now: FIXED_NOW, prefs: PREFS_OK, writeMoment: allowedWriter.fn, recommendation: recommendation()
  });
  check('MA16.postWithValidPolicyCallsCore',
    allowed.decision === 'allow' && allowed.explicitPolicy === true && allowed.coreReason === 'default-allow'
    && allowed.reason === 'policy-allow' && allowed.trace && allowed.trace.decision === 'allow',
    { decision: allowed.decision, reason: allowed.reason, coreReason: allowed.coreReason });
  check('MA16b.coreDefaultAllowNeverUsed',
    allowed.coreReason === 'default-allow' && allowed.reason === 'policy-allow'
    && stripComments(read('assets/js/moments-autonomy.js')).indexOf('ctx.decide') >= 0);

  /* ══════════════ D · Core boundary / executor ══════════════ */
  section('D · Core boundary / executor（MA17–MA21）');
  check('MA17.allowExecutesExactlyOnce', allowedWriter.calls === 1 && allowed.executed === true && allowed.written === true && allowed.ok === true);
  const denyWriter = counterWriter();
  const denied = await MA.runMomentAutonomy(candidateInput(), {
    now: FIXED_NOW, prefs: PREFS_OK, writeMoment: denyWriter.fn, recommendation: recommendation(),
    extraPolicy: () => ({ decision: 'deny' })
  });
  check('MA18.denyExecutesZero', denied.decision === 'deny' && denyWriter.calls === 0 && denied.executed === false && denied.written === false);
  const deferWriter = counterWriter();
  const deferred = await MA.runMomentAutonomy(candidateInput(), {
    now: FIXED_NOW, prefs: PREFS_OK, writeMoment: deferWriter.fn, recommendation: recommendation(),
    extraPolicy: () => ({ decision: 'defer' })
  });
  check('MA19.deferExecutesZero', deferred.decision === 'defer' && deferred.reason === 'policy-defer' && deferWriter.calls === 0 && deferred.written === false);
  const unknownPolicy = await MA.runMomentAutonomy(candidateInput(), {
    now: FIXED_NOW, prefs: PREFS_OK, writeMoment: counterWriter().fn, recommendation: recommendation(),
    extraPolicy: () => ({ decision: 'maybe' })
  });
  check('MA19b.unknownPolicyDecisionDenied', unknownPolicy.decision === 'deny' && unknownPolicy.reason === 'policy-failure');
  const dupState = Core.createAutonomyState();
  const dupWriter = counterWriter();
  const dupDeps = { now: FIXED_NOW, prefs: PREFS_OK, writeMoment: dupWriter.fn, recommendation: recommendation(), state: dupState };
  const dupFirst = await MA.runMomentAutonomy(candidateInput(), dupDeps);
  const dupSecond = await MA.runMomentAutonomy(candidateInput(), dupDeps);
  check('MA20.runtimeDuplicateExecutesZero',
    dupFirst.decision === 'allow' && dupSecond.decision === 'deny' && dupSecond.reason === 'duplicate-runtime' && dupWriter.calls === 1,
    { first: dupFirst.decision, second: dupSecond.decision, secondReason: dupSecond.reason, calls: dupWriter.calls });
  const coolWriter = counterWriter();
  const cooled = await MA.runMomentAutonomy(candidateInput(), {
    now: FIXED_NOW, prefs: PREFS_OK, writeMoment: coolWriter.fn, recommendation: recommendation(),
    lastPostAt: FIXED_NOW - 30 * 60000, cooldownMs: 45 * 60000
  });
  check('MA21.cooldownExecutesZero', cooled.decision === 'deny' && cooled.reason === 'cooldown' && coolWriter.calls === 0, cooled.reason);
  const coolThrow = await MA.runMomentAutonomy(candidateInput(), {
    now: FIXED_NOW, prefs: PREFS_OK, writeMoment: counterWriter().fn, recommendation: recommendation(),
    cooldownMsFor: () => { throw new Error('schedule read failed'); }
  });
  check('MA21b.cooldownReadFailureDenied', coolThrow.decision === 'deny' && coolThrow.reason === 'cooldown-unavailable');
  const noTime = await MA.runMomentAutonomy(candidateInput(), { prefs: PREFS_OK, writeMoment: counterWriter().fn, recommendation: recommendation() });
  check('MA21c.missingInjectedTimeDenied', noTime.decision === 'deny' && noTime.reason === 'time-not-injected');
  const noWriter = await MA.runMomentAutonomy(candidateInput(), { now: FIXED_NOW, prefs: PREFS_OK, recommendation: recommendation() });
  check('MA21d.noWriterIsExecutionFailureNotDeny',
    noWriter.decision === 'allow' && noWriter.executed === true && noWriter.written === false
    && noWriter.ok === false && noWriter.error === 'no-writer',
    { decision: noWriter.decision, executed: noWriter.executed, error: noWriter.error });

  /* ══════════════ E · Content / secret / duplicates ══════════════ */
  section('E · Content / secret / duplicate（MA32–MA35）');
  const emptyContent = await MA.runMomentAutonomy(candidateInput(), {
    now: FIXED_NOW, prefs: PREFS_OK, writeMoment: counterWriter().fn,
    recommendation: recommendation({ draft: '   ' })
  });
  check('MA32.emptyContentDeniedNoWrite', emptyContent.decision === 'deny' && emptyContent.reason === 'content-empty' && emptyContent.written === false);
  const secretContent = await MA.runMomentAutonomy(candidateInput(), {
    now: FIXED_NOW, prefs: PREFS_OK, writeMoment: counterWriter().fn,
    recommendation: recommendation({ draft: '顺手贴一下 sk-abcdefgh12345678 这个 key' })
  });
  check('MA32b.secretContentDenied', secretContent.decision === 'deny' && secretContent.reason === 'content-secret');
  const sanitizedWriter = counterWriter();
  const sanitized = await MA.runMomentAutonomy(candidateInput(), {
    now: FIXED_NOW, prefs: PREFS_OK, writeMoment: sanitizedWriter.fn, recommendation: recommendation(),
    contentSanitizer: (content) => ({ ok: true, content: content.replace('窗台', '阳台') })
  });
  check('MA32c.sanitizerSeamApplied',
    sanitized.decision === 'allow' && sanitizedWriter.payloads[0].content.indexOf('阳台') >= 0, sanitizedWriter.payloads[0]);
  const rejectedWriter = counterWriter();
  const rejected = await MA.runMomentAutonomy(candidateInput(), {
    now: FIXED_NOW, prefs: PREFS_OK, writeMoment: rejectedWriter.fn, recommendation: recommendation(),
    contentSanitizer: () => false
  });
  check('MA32d.sanitizerRejectDenies', rejected.decision === 'deny' && rejected.reason === 'content-rejected' && rejectedWriter.calls === 0);
  const dupContentWriter = counterWriter();
  const dupContent = await MA.runMomentAutonomy(candidateInput(), {
    now: FIXED_NOW, prefs: PREFS_OK, writeMoment: dupContentWriter.fn, recommendation: recommendation(),
    readRecentOwnMoments: () => [{ id: 'mom_old', roleId: ACTOR, content: '今天把窗台擦干净了。', createdAt: FIXED_NOW - 3600000 }]
  });
  check('MA35.crossSessionDuplicateDeniedNoPersist',
    dupContent.decision === 'deny' && dupContent.reason === 'duplicate-content' && dupContentWriter.calls === 0);
  const histFail = await MA.runMomentAutonomy(candidateInput(), {
    now: FIXED_NOW, prefs: PREFS_OK, writeMoment: counterWriter().fn, recommendation: recommendation(),
    readRecentOwnMoments: () => { throw new Error('read failed'); }
  });
  check('MA35b.historyReadFailureDenied', histFail.decision === 'deny' && histFail.reason === 'history-unavailable');
  check('MA32e.badShapeDenied',
    (await MA.runMomentAutonomy(candidateInput(), {
      now: FIXED_NOW, prefs: PREFS_OK, writeMoment: counterWriter().fn, recommendation: recommendation(), visibility: 'everyone'
    })).reason === 'bad-visibility'
    && (await MA.runMomentAutonomy(candidateInput(), {
      now: FIXED_NOW, prefs: PREFS_OK, writeMoment: counterWriter().fn, recommendation: recommendation(), visibility: 'roles', visibleRoleIds: []
    })).reason === 'bad-visible-roles'
    && (await MA.runMomentAutonomy(candidateInput(), {
      now: FIXED_NOW, prefs: PREFS_OK, writeMoment: counterWriter().fn, recommendation: recommendation(), motive: 'brag'
    })).reason === 'bad-motive');

  /* ══════════════ F · 真实 moments.js：canonical 写入权威 ══════════════ */
  section('F · Canonical Moment writer（CW1–CW10 / MA23–MA31 / MA47–MA50）');
  const none = buildPage('none');
  const noneRes = await none.createMoment({ roleId: ACTOR, content: '沙箱：无 Home Node 面。', source: 'manual', visibility: 'all' });
  check('CW3.mirrorLocalWriteWorks',
    noneRes.ok === true && noneRes.persistence.authority === 'indexeddb' && none.liveCount() === 1 && none.stats.directPutOk === 1,
    { res: noneRes.ok, auth: noneRes.persistence && noneRes.persistence.authority, live: none.liveCount() });
  check('CW1.soleShapeNormalizer', countOf(read('assets/js/moments.js'), 'function _momentsDefaults(') === 1
    && JSON.stringify(Object.keys(noneRes.moment).sort()) === JSON.stringify(CANONICAL_KEYS));
  const mirror = buildPage('mirror');
  const mirrorRes = await mirror.createMoment({ roleId: ACTOR, content: '沙箱：mirror 承载。', source: 'manual', visibility: 'all' });
  check('MA24.mirrorModeWriteWorks',
    mirrorRes.ok === true && mirror.liveCount() === 1 && mirror.stats.directPut === 0
    && mirrorRes.persistence.authority === 'indexeddb',
    { ok: mirrorRes.ok, live: mirror.liveCount(), directPut: mirror.stats.directPut, auth: mirrorRes.persistence && mirrorRes.persistence.authority });
  const canon = buildPage('canonical');
  const directBlocked = await canon.sandbox.dbPut('moments', { id: 'direct_x' }).then(() => '', (e) => e.code);
  check('MA26.canonicalGuardStillBlocksDirectDbPut', directBlocked === 'moments-write-closed', directBlocked);
  const canonRes = await canon.createMoment({ roleId: ACTOR, content: '沙箱：canonical 承载。', source: 'manual', visibility: 'all' });
  check('MA25.canonicalModeWriteWorks', canonRes.ok === true && canon.liveCount() === 1,
    { ok: canonRes.ok, error: canonRes.error, live: canon.liveCount() });
  check('MA27.canonicalModeUsesHomeNodeAuthority',
    canonRes.ok === true && canonRes.persistence.authority === 'home-node' && canon.stats.directPutBlocked === 1 && canon.stats.directPutOk === 0,
    canonRes.persistence);
  const canonRow = canon.canonicalRow(canonRes.moment.id);
  check('CW4.canonicalRowStoredByAuthority',
    !!canonRow && canonRow.content === '沙箱：canonical 承载。' && canonRow.roleId === ACTOR && canonRow.source === 'manual'
    && canonRow.rev >= 1, canonRow && { id: canonRow.id, rev: canonRow.rev, source: canonRow.source });
  const failPage = buildPage('canonical-fail');
  const failRes = await failPage.createMoment({ roleId: ACTOR, content: '沙箱：canonical 写失败。', source: 'manual', visibility: 'all' });
  check('CW5.canonicalWriteFailurePropagated',
    failRes.ok === false && /moment-write-failed/.test(String(failRes.error)) && failPage.liveCount() === 0,
    { ok: failRes.ok, error: failRes.error });
  const manualIds = [];
  for (let i = 0; i < 2; i++) {
    manualIds.push((await none.createMoment({ roleId: ACTOR, content: '手动 id 行为 ' + i, source: 'manual', visibility: 'all' })).moment.id);
  }
  check('CW7.manualGeneratedIdStillAccepted',
    manualIds.every(id => /^mom_[0-9a-z]+_[0-9a-z]+$/.test(String(id))) && manualIds[0] !== manualIds[1], manualIds);
  const stableId = 'mom_stable_probe';
  const stableWriter = counterWriter();
  const stableRun = await MA.runMomentAutonomy(candidateInput(), {
    now: FIXED_NOW, prefs: PREFS_OK, recommendation: recommendation(), state: Core.createAutonomyState(),
    writeMoment: (payload, options) => canon.createMoment(payload, options)
  });
  const stableAgain = await MA.runMomentAutonomy(candidateInput(), {
    now: FIXED_NOW, prefs: PREFS_OK, recommendation: recommendation(), state: Core.createAutonomyState(),
    writeMoment: (payload, options) => canon.createMoment(payload, options)
  });
  check('MA28.sameCandidateRetryOneIdentity',
    stableRun.ok === true && stableAgain.ok === true && stableRun.momentId === stableAgain.momentId
    && stableRun.momentId === MA.momentIdForCandidate(candidateInput && MA.buildMomentCandidate(candidateInput()).candidate.candidateId),
    { a: stableRun.momentId, b: stableAgain.momentId });
  check('MA29.sameCandidateRetryNoDuplicateRow',
    canon.liveCount() === 2 && stableAgain.idempotent === true,
    { live: canon.liveCount(), idempotent: stableAgain.idempotent, outcome: stableAgain.persistence && stableAgain.persistence.outcome });
  const otherRun = await MA.runMomentAutonomy(candidateInput({ topicFingerprint: 'sunny-balcony' }), {
    now: FIXED_NOW, prefs: PREFS_OK, recommendation: recommendation({ topicFingerprint: 'sunny-balcony' }),
    state: Core.createAutonomyState(), writeMoment: (payload, options) => canon.createMoment(payload, options)
  });
  check('MA30.differentCandidateDifferentMomentId',
    otherRun.ok === true && otherRun.momentId !== stableRun.momentId && canon.liveCount() === 3,
    { other: otherRun.momentId, base: stableRun.momentId, live: canon.liveCount() });
  const rolesRun = await MA.runMomentAutonomy(candidateInput({ topicFingerprint: 'roles-scope' }), {
    now: FIXED_NOW, prefs: PREFS_OK, recommendation: recommendation({ topicFingerprint: 'roles-scope' }),
    state: Core.createAutonomyState(), visibility: 'roles', visibleRoleIds: ['role_b', 'role_c'],
    motive: 'daily_life', writeMoment: (payload, options) => canon.createMoment(payload, options)
  });
  const rolesRow = canon.canonicalRow(rolesRun.momentId);
  check('MA47.visibilityPreservedOnAutonomousMoment',
    rolesRun.ok === true && rolesRow.visibility === 'roles'
    && JSON.stringify(rolesRow.visibleRoleIds) === JSON.stringify(['role_b', 'role_c'])
    && rolesRow.motive === 'daily_life' && rolesRow.source === 'proactive',
    rolesRow && { vis: rolesRow.visibility, ids: rolesRow.visibleRoleIds, motive: rolesRow.motive, source: rolesRow.source });
  check('MA48.identityIsActorId', rolesRow.roleId === ACTOR && rolesRow.authorId === ACTOR && rolesRow.authorType === 'role',
    rolesRow && { roleId: rolesRow.roleId, authorId: rolesRow.authorId, authorType: rolesRow.authorType });
  check('MA49.sourceProactivePreserved', rolesRow.source === 'proactive', rolesRow && rolesRow.source);
  check('MA23.manualCreateMomentUnchanged',
    noneRes.ok === true && noneRes.moment.source === 'manual' && noneRes.moment.authorType === 'role'
    && noneRes.moment.authorId === ACTOR && none.stats.timers > 0,
    { timers: none.stats.timers, source: noneRes.moment.source });
  const quiet = buildPage('canonical', { currentPage: 'settings' });
  const quietRes = await quiet.createMoment({ roleId: ACTOR, content: '页面不在动态页。', source: 'proactive', visibility: 'all' });
  check('MA50.uiRefreshIsNotPersistencePrerequisite',
    quietRes.ok === true && quiet.liveCount() === 1 && typeof quiet.sandbox.document === 'undefined',
    { ok: quietRes.ok, live: quiet.liveCount() });
  const silentPage = buildPage('canonical', { currentPage: 'moments' });
  const voiced = await silentPage.createMoment({ roleId: ACTOR, content: '有表现层副作用。', source: 'proactive', visibility: 'all' });
  const timersAfterVoiced = silentPage.stats.timers;
  const silent = await silentPage.createMoment({ roleId: ACTOR, content: '纯持久化。', source: 'proactive', visibility: 'all' }, { presentation: false });
  check('CW9.sideEffectsOnlyWhenRequested',
    timersAfterVoiced > 0 && silentPage.stats.timers === timersAfterVoiced
    && silent.ok === true && voiced.ok === true && silentPage.liveCount() === 2,
    { timersAfterVoiced: timersAfterVoiced, timersAfterSilent: silentPage.stats.timers, ok: silent.ok, live: silentPage.liveCount() });
  check('CW8.silentOptionDoesNotAlterStoredShape',
    JSON.stringify(Object.keys(silent.moment).sort()) === JSON.stringify(CANONICAL_KEYS)
    && JSON.stringify(Object.keys(voiced.moment).sort()) === JSON.stringify(CANONICAL_KEYS));
  const adapterSilentPage = buildPage('canonical', { currentPage: 'moments' });
  const adapterSilent = await MA.runMomentAutonomy(candidateInput({ topicFingerprint: 'silent-path' }), {
    now: FIXED_NOW, prefs: PREFS_OK, state: Core.createAutonomyState(),
    recommendation: recommendation({ topicFingerprint: 'silent-path' }),
    presentation: false, writeMoment: (payload, options) => adapterSilentPage.createMoment(payload, options)
  });
  const autonomousRow = adapterSilentPage.canonicalRow(adapterSilent.momentId);
  check('MA49b.autonomousExecutorSilentPresentation',
    adapterSilent.ok === true && adapterSilentPage.stats.timers === 0 && !!autonomousRow
    && autonomousRow.source === 'proactive' && autonomousRow.content === '今天把窗台擦干净了。',
    { ok: adapterSilent.ok, timers: adapterSilentPage.stats.timers, row: !!autonomousRow });
  check('MA34.denyWritesNothing', (() => {
    const idsBefore = canon.liveCount();
    return skipRun.written === false && denied.written === false && idsBefore === canon.liveCount();
  })());
  check('MA36.traceNeverInsideMoment',
    !Object.prototype.hasOwnProperty.call(autonomousRow, 'trace') && JSON.stringify(autonomousRow).indexOf('"trace"') < 0);
  check('MA37.traceNeverInLocalStorage',
    !/localStorage/.test(stripComments(read('assets/js/moments-autonomy.js')))
    && Object.keys(adapterSilentPage.sandbox).every(k => k !== 'ib_moments_autonomy_trace'));
  check('CW10.updateDeletePathsUnchanged', (() => {
    const src = read('assets/js/moments.js');
    /* 点赞 / 评论 / 删评 / companion 更新仍走原 dbPut 路径（本阶段只收敛**创建**权威） */
    return countOf(src, 'await dbPut(MOMENT_STORE,m);') >= 4
      && countOf(src, 'await dbDelete(MOMENT_STORE,id);') === 1;
  })());

  /* ══════════════ G · 边界与源码守卫 ══════════════ */
  section('G · Boundaries / source guards（MA22 / MA33 / MA38–MA48）');
  const adapterSrc = stripComments(read('assets/js/moments-autonomy.js'));
  const momentsSrc = read('assets/js/moments.js');
  check('MA40.autonomyCoreUnchanged', sha256('assets/js/autonomy-core.js') === FROZEN_SHA256['assets/js/autonomy-core.js']);
  check('MA38.p23Untouched', sha256('assets/js/communication.js') === FROZEN_SHA256['assets/js/communication.js']);
  check('MA39.p24Untouched', sha256('assets/js/group-runtime-core.js') === FROZEN_SHA256['assets/js/group-runtime-core.js']);
  check('MA41.noModelCall', !/generateRoleMoment|_momentsModelCall|buildMomentPrompt|IB\.runtime\.instance\.execute|callApiChat/.test(adapterSrc));
  check('MA42.noProviderCall', !/\bfetch\s*\(|XMLHttpRequest|provider-directory/.test(adapterSrc));
  check('MA43.noMemoryAccess', !/\bMemory\b|memories|_activeRecentMemories|memoryAuthority/.test(adapterSrc));
  check('MA44.noMiddleBrain', !/middle-brain|middleBrain|middle_brain/.test(adapterSrc));
  check('MA45.noGroupBrain', !/groupTurn|group-runtime|groupRuntime|SILENT|INTERJECT/.test(adapterSrc));
  check('MA46.noSchedulerMigration', !/setInterval|setTimeout|_momentsTick|_activeTick|_momentsLocalTick/.test(adapterSrc)
    && !/active-diary/.test(adapterSrc));
  /* P25-2C 起 adapter **已经**接入生产（autonomous 触发的裁决层）；语义从
     "完全不被引用"变成"只在**唯一**解析点被引用"。本断言随契约迁移，
     仍然守住 2A 的核心不变量：手动路径与 companion 域不得触碰 autonomy。 */
  check('MA46b.adapterWiredOnlyThroughSingleResolver', (() => {
    const i = momentsSrc.indexOf('function _momentsAutonomyAdapter(');
    const j = momentsSrc.indexOf('function buildMomentCandidateSeed(');
    const resolver = (i >= 0 && j > i) ? momentsSrc.slice(i, j) : '';
    return i > 0 && countOf(momentsSrc, 'IBMomentsAutonomy') === countOf(resolver, 'IBMomentsAutonomy')
      && !/IBMomentsAutonomy/.test(read('assets/js/social-network.js'))
      && !/IBMomentsAutonomy/.test(read('assets/js/active-diary.js'));
  })());
  check('MA22.manualPathExemptFromAutonomy',
    /createMoment\(\{authorType:'user',authorId:_activeUserId\(\),content:text,images:imgs,source:'manual'/.test(momentsSrc)
    && /source:'manual'/.test(read('assets/js/social-network.js'))
    && MA.buildMomentCandidate(candidateInput({ source: 'user' })).ok === false);
  check('MA33.executorFailureIsNotDeny', (() => {
    const body = stripComments(read('assets/js/moments-autonomy.js'));
    return /result\.ok = write\.ok === true/.test(body) && /result\.decision !== autonomyDecisions\(\)\.ALLOW/.test(body);
  })());
  check('CW2.singleCreationAuthority', (() => {
    const body = stripComments(momentsSrc);
    return countOf(body, 'function createMoment(') === 1
      && countOf(body, 'function _momentsWriteCanonical(') === 1
      && countOf(body, 'hn.put(m,') === 1                            /* 唯一权威写点（home-node 路由） */
      /* P25-2D：companion ingest 不再自带写入点 —— 它也走 createMoment（经 Autonomy
         ALLOW 后的 executor）。因此"唯一创建权威"从"2 个调用点"收紧成"1 个调用点"。 */
      && countOf(body, '_momentsWriteCanonical(') === 2              /* 1 处定义 + 1 处调用（createMoment） */
      && countOf(body, 'await _momentsWriteCanonical(') === 1
      && countOf(body, 'await dbPut(MOMENT_STORE,m);') === 4;        /* 本地回滚分支 + 3 个更新路径（点赞/评论/删评） */
  })());
  check('CW6.stableExplicitIdAccepted', (() => {
    const manual = stripComments(none.sandbox.window._momentsDefaults.toString());
    return /p\.id/.test(manual) && /_momentsId\('mom'\)/.test(manual);
  })());
  check('MA37b.adapterHasNoStorageOrDom', !/localStorage|indexedDB|document|window\./.test(adapterSrc));

  /* ── 报告 ── */
  console.log('\n' + (failed === 0 ? 'ALL PASS' : 'FAILURES: ' + failures.join(', ')));
  console.log('P25-2A · moments autonomy adapter: ' + passed + ' passed, ' + failed + ' failed');
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((e) => { console.error('suite crashed:', e && e.stack || e); process.exitCode = 1; });
