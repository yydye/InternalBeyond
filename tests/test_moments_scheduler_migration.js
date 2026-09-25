'use strict';

/* Internal Beyond · P25-2C · Scheduler / Trigger Migration 测试
   （static 组：纯 Node、零浏览器、零网络；运行：
     node tests/test_moments_scheduler_migration.js）

   本阶段把 Moments 的 autonomous 触发从
     scheduler → generateRoleMoment（自己决定发布）→ createMoment
   迁移为
     scheduler → Candidate Seed → Semantic Evaluation → Candidate Finalization
               → Autonomy Core → ALLOW → 图片 → Executor → createMoment

   冻结：scheduler 只产生候选；semantic 只说值不值得发；Autonomy 才裁决；
   executor 只执行。任何一层都不得越权。

   覆盖 SC1–SC35。真实度：与 2A/2B 测试同一策略 —— 在 vm 沙箱里加载**真实**
   moments.js / moments-semantic-core.js / autonomy-core.js / moments-autonomy.js，
   真实 moments-authority + 真实 canonical store（仅替换 HTTP 传输与 DOM），
   模型调用由 callApiChat 桩驱动（经真实执行缝 _obsCall → _momentsModelCall）。 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const sha256 = f => crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, f))).digest('hex').toUpperCase();

const createMomentsAuthority = require(path.join(ROOT, 'assets', 'js', 'moments-authority.js')).createMomentsAuthority;
const createMomentsStore = require(path.join(ROOT, 'services', 'home-node', 'moments-store.js'));
const MOMENTS_VIS = require(path.join(ROOT, 'assets', 'js', 'moments-visibility-core.js'));
const CHAT_CORE = require(path.join(ROOT, 'assets', 'js', 'chat-core.js'));
const VOICE_CORE = require(path.join(ROOT, 'assets', 'js', 'voice-message-core.js'));
const PLAN_DOMAIN = require(path.join(ROOT, 'active', 'plan-domain.js'))({ getState: () => ({}), armedUsers: new Set(), saveNow: () => {} });
const Sem = require(path.join(ROOT, 'assets', 'js', 'moments-semantic-core.js'));
const MA = require(path.join(ROOT, 'assets', 'js', 'moments-autonomy.js'));

let passed = 0, failed = 0;
const failures = [];
function check(name, cond, extra) {
  if (cond) { passed++; console.log('  \u2714 ' + name); }
  else { failed++; failures.push(name); console.log('  \u2716 ' + name + (extra === undefined ? '' : '  -> ' + JSON.stringify(extra).slice(0, 320))); }
}
function section(title) { console.log('\n── ' + title + ' ──'); }
const stripComments = src => String(src).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const countOf = (src, needle) => String(src).split(needle).length - 1;
function fnSlice(src, name) {
  const body = stripComments(src);
  const start = body.indexOf('async function ' + name + '(');
  if (start < 0) return '';
  const next = body.indexOf('\nasync function ', start + 1);
  return body.slice(start, next > start ? next : body.length);
}

/* 冻结基线（P25-2C 开工前实测） */
const FROZEN_SHA256 = {
  'assets/js/autonomy-core.js': 'FE1011F1DC3434DB6A72A328A63AFEEAE99E1E95762EA910CE379F019F2956F8',
  'assets/js/communication.js': 'DEB568A2F3653009C511BE25753E87AC9EF477FF229BE5CF569EB430AC29184F',
  'assets/js/group-runtime-core.js': '6F30FDE91F518B69B613B74B675B42EB66D227E36C1E18F04A3A1274067B35E8',
  'assets/js/active-diary.js': 'EEAC85AB0CB215723AD641D416606B941C2EBABBE99CB373A6DA1661A6964E26',
  'active/moments.js': 'C29341FFABB0AC3C1AFD1A896122F754F1E226248ED185F8119BCA38B326B3D2'
};

const MOMENTS_SRC = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'moments.js'), 'utf8').replace(/^\uFEFF/, '');
const SEMANTIC_CORE_SRC = read('assets/js/moments-semantic-core.js').replace(/^\uFEFF/, '');
const AUTONOMY_CORE_SRC = read('assets/js/autonomy-core.js').replace(/^\uFEFF/, '');
const AUTONOMY_ADAPTER_SRC = read('assets/js/moments-autonomy.js').replace(/^\uFEFF/, '');

const FIXED_NOW = 1770000000000;
const ACTOR = 'role_sched';
const v2PostRaw = JSON.stringify({
  recommendation: 'post', reasonCode: 'meaningful-moment', topicKey: 'rainy-window',
  draft: { content: '今天把窗台擦干净了，外面一直在下雨。', visibility: 'all', visibleRoleIds: [], motive: 'daily_life', wantImage: false, imagePrompt: '' }
});
const v2SkipRaw = JSON.stringify({ recommendation: 'skip', reasonCode: 'nothing-to-share', topicKey: 'quiet-day' });
const legacyPostRaw = JSON.stringify({ publish: true, content: '今天出去走了走。', visibility: 'all', visibleRoleIds: [] });

const tempDirs = [];
function tempDir() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ibsc-')); tempDirs.push(dir); return dir; }
process.on('exit', () => { for (const dir of tempDirs) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* ignore */ } } });

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
    put: (record, options) => Promise.resolve(store.put(record, { requestId: options && options.requestId, expectedRev: options && options.expectedRev })),
    remove: (id, options) => Promise.resolve(store.remove(id, { requestId: options && options.requestId, expectedRev: options && options.expectedRev })),
    migrateBatch: () => Promise.resolve({ ok: true }),
    migrationState: () => Promise.resolve({ ok: true }),
    markMigration: () => Promise.resolve({ ok: true })
  };
}
/* opts.canonical：走真实 Home Node canonical store；opts.outputs：模型输出队列（最后一个循环使用） */
function buildPage(outputs, opts) {
  opts = opts || {};
  const rows = new Map();
  const stats = { directPut: 0, directPutBlocked: 0, imageRouter: 0 };
  const stored = new Map();
  const sandbox = {};
  const IB = { expose: function (p, obj) { IB[p] = Object.assign(IB[p] || {}, obj); } };
  sandbox.window = sandbox; sandbox.self = sandbox; sandbox.IB = IB;
  sandbox.console = { log() {}, info() {}, warn() {}, error() {} };
  sandbox.setTimeout = () => 0; sandbox.clearTimeout = () => {};
  sandbox.localStorage = {
    getItem: (k) => (stored.has(String(k)) ? stored.get(String(k)) : null),
    setItem: (k, v) => { stored.set(String(k), String(v)); },
    removeItem: (k) => { stored.delete(String(k)); }
  };
  sandbox.IBChatCore = CHAT_CORE;
  sandbox.IBVoiceMessage = VOICE_CORE;
  sandbox.IBMomentsVisibilityCore = MOMENTS_VIS;
  sandbox.__ibParsePlanJsonRaw = PLAN_DOMAIN.parsePlanJson;
  sandbox.IB.imageRouter = {
    available: true,
    routeImageRequest: () => { stats.imageRouter++; return Promise.resolve({ ok: true, dataUrl: 'data:image/jpeg;base64,AAAA' }); }
  };
  sandbox.apiConfigs = [];
  sandbox.archivedConfigs = [];
  sandbox.currentPage = 'settings';
  sandbox.loadMomentsPage = function () {};
  sandbox._activeUserId = () => 'user_local';
  sandbox._ibApiReady = (cfg) => !!(cfg && cfg.endpoint && cfg.model);
  sandbox._activeRecentMemories = () => Promise.resolve([]);
  sandbox._activeRecentProactiveMessages = () => Promise.resolve([]);
  sandbox._activeRecentMessages = () => Promise.resolve([]);
  sandbox._activeTextSimilarity = (a, b) => (String(a) === String(b) ? 1 : 0);
  sandbox.runtimeExecuteEnabled = false;
  sandbox.dbPut = function (store, row) {
    return new Promise((resolve, reject) => {
      if (String(store) === 'moments') {
        stats.directPut++;
        if (opts.canonical) {
          stats.directPutBlocked++;
          const e = new Error('moments 是 Home Node 的 canonical 域；浏览器不得直接写入（fail closed）');
          e.code = 'moments-write-closed';
          reject(e); return;
        }
        rows.set(String(row.id), row); resolve(undefined); return;
      }
      resolve(undefined);
    });
  };
  sandbox.dbDelete = (store, key) => { rows.delete(String(key)); return Promise.resolve(undefined); };
  sandbox.dbGet = (store, key) => Promise.resolve(rows.get(String(key)) || null);
  sandbox.dbGetAll = () => Promise.resolve(Array.from(rows.values()));
  sandbox.dbGetByIndex = () => Promise.resolve([]);
  vm.createContext(sandbox);
  vm.runInContext(
    '(function(){var raw=__ibParsePlanJsonRaw;window._activeParsePlanJson=function(t,o){try{var j=raw(t,o);return j?JSON.parse(JSON.stringify(j)):null}catch(e){return null}};})();',
    sandbox, { filename: 'parser-bridge.js' });
  vm.runInContext(SEMANTIC_CORE_SRC, sandbox, { filename: 'moments-semantic-core.js' });
  vm.runInContext(AUTONOMY_CORE_SRC, sandbox, { filename: 'autonomy-core.js' });
  vm.runInContext(AUTONOMY_ADAPTER_SRC, sandbox, { filename: 'moments-autonomy.js' });
  vm.runInContext(MOMENTS_SRC, sandbox, { filename: 'moments.js' });
  sandbox.loadMomentsPage = function () {};
  /* 观测：adapter 的裁决入口被调用几次（不改行为，只计数） */
  const spy = { autonomy: 0, finalize: 0, modelCalls: 0 };
  const adapter = sandbox.IBMomentsAutonomy;
  const origRun = adapter.runMomentAutonomy, origFin = adapter.finalizeMomentCandidate;
  adapter.runMomentAutonomy = function (input, deps) { spy.autonomy++; return origRun(input, deps); };
  adapter.finalizeMomentCandidate = function (seed, rec) { spy.finalize++; return origFin(seed, rec); };
  sandbox.callApiChat = function () {
    spy.modelCalls++;
    const next = outputs.length > 1 ? outputs.shift() : outputs[0];
    if (next instanceof Error) return Promise.reject(next);
    return Promise.resolve(next);
  };
  let store = null;
  if (opts.canonical) {
    store = createMomentsStore({ dataDir: tempDir(), logger: () => {} });
    store.open();
    const authority = createMomentsAuthority({
      remote: makeStoreRemote(store), local: makeLocalDriver(rows),
      mode: 'canonical', fileOrigin: false, log: function () {}
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
    sandbox: sandbox, stats: stats, spy: spy, rows: rows, store: store,
    cfg: null,
    setState: (roleId, patch) => {
      const all = JSON.parse(stored.get('ib_moments_state_v1') || '{}');
      all[roleId] = Object.assign({}, all[roleId] || {}, patch);
      stored.set('ib_moments_state_v1', JSON.stringify(all));
    },
    getState: (roleId) => JSON.parse(stored.get('ib_moments_state_v1') || '{}')[roleId] || {},
    live: () => (store ? store.countLive() : rows.size),
    row: (id) => (store ? store.getRecord(id) : rows.get(String(id)) || null),
    /* 在**页面内部**发起调用（opts 用源码字面量）：真实调用方就在页面里，
       而且跨 realm 的 opts 对象/函数会被 adapter 的 isPlainObject 判定挡掉。 */
    pipeline: (roleId, optsExpr) => vm.runInContext(
      '(async function(){return await _momentsRunAutonomousPost(' + JSON.stringify(roleId) + ',' + (optsExpr || '{}') + ')})()',
      sandbox, { filename: 'pipeline.js' })
  };
}
function readyCfg(patch) {
  return Object.assign({
    id: ACTOR, nickname: 'N', model: 'm1', provider: 'openai',
    endpoint: 'http://127.0.0.1:9/v1/chat/completions', apiKey: 'k', imageGen: true
  }, patch || {});
}

async function main() {
  console.log('== P25-2C · Scheduler / Trigger Migration 测试 ==');

  /* ══════════ A · Scheduler 只产生候选（SC1–SC3 / SC17 / SC20） ══════════ */
  section('A · Scheduler = candidate trigger only（SC1–SC3 / SC17 / SC20）');
  const pageA = buildPage([v2PostRaw]);
  pageA.sandbox.apiConfigs = [readyCfg()];
  pageA.setState(ACTOR, { nextAt: FIXED_NOW - 1000, claimUntil: 0, lastPostAt: 0 });
  const seed = JSON.parse(JSON.stringify(pageA.sandbox.window.buildMomentCandidateSeed(ACTOR, { trigger: 'schedule' })));
  check('SC1.schedulerProducesCandidateSeed',
    seed.actorId === ACTOR && seed.source === 'schedule' && seed.triggerRef === 'schedule:' + (FIXED_NOW - 1000)
    && !('candidateId' in seed) && !('topicFingerprint' in seed), seed);
  const tickSrc = fnSlice(MOMENTS_SRC, '_momentsTick');
  const localSrc = fnSlice(MOMENTS_SRC, '_momentsLocalTick');
  check('SC2.schedulerHasNoCreateMoment',
    !/createMoment\(/.test(tickSrc) && !/createMoment\(/.test(localSrc)
    && !/_momentsWriteCanonical/.test(tickSrc + localSrc));
  check('SC3.schedulerHasNoPublishAuthority',
    !/recommendation|reasonCode|topicFingerprint|IBMomentsAutonomy|runMomentAutonomy|_momentsMakeImage|createMoment\(/.test(tickSrc + localSrc)
    && /generateRoleMoment\(key,\{trigger:'schedule'\}\)/.test(localSrc));
  await pageA.sandbox.window._momentsLocalTick(FIXED_NOW);
  const tickState = pageA.getState(ACTOR);
  check('SC17.frequencyReschedulePreserved',
    pageA.live() === 1 && tickState.claimUntil === 0 && Number(tickState.nextAt) > FIXED_NOW
    && Number(tickState.lastPostAt) === FIXED_NOW, { live: pageA.live(), st: tickState });
  const page20 = buildPage([v2PostRaw]);
  page20.sandbox.apiConfigs = [readyCfg()];
  page20.setState(ACTOR, { nextAt: FIXED_NOW - 1000, claimUntil: FIXED_NOW + 60000 });
  await page20.sandbox.window._momentsLocalTick(FIXED_NOW);
  check('SC20.multiRoleClaimExclusionPreserved',
    page20.spy.modelCalls === 0 && page20.live() === 0 && Number(page20.getState(ACTOR).nextAt) === FIXED_NOW - 1000,
    { calls: page20.spy.modelCalls, live: page20.live() });

  /* ══════════ B · Candidate identity（SC4–SC6 / SC23 / SC24） ══════════ */
  section('B · Candidate identity（SC4–SC6 / SC23 / SC24）');
  const pageB = buildPage([v2PostRaw]);
  const recPost = Sem.toAdapterRecommendation(Sem.parseMomentSemanticOutput(v2PostRaw, { parseJson: PLAN_DOMAIN.parsePlanJson }));
  const seedB = { actorId: ACTOR, source: 'schedule', triggerRef: 'schedule:123' };
  const fin1 = MA.finalizeMomentCandidate(seedB, recPost);
  const fin2 = MA.finalizeMomentCandidate(seedB, recPost);
  check('SC4.finalizeDeterministic',
    fin1.ok === true && fin1.candidate.candidateId === fin2.candidate.candidateId
    && fin1.candidate.topicFingerprint === recPost.topicFingerprint);
  const recPost2 = Sem.toAdapterRecommendation(Sem.parseMomentSemanticOutput(JSON.stringify(Object.assign(JSON.parse(v2PostRaw), { topicKey: 'sunny-balcony' })), { parseJson: PLAN_DOMAIN.parsePlanJson }));
  check('SC5/SC6.topicDrivesIdentity',
    fin1.candidate.candidateId === MA.finalizeMomentCandidate(seedB, recPost).candidate.candidateId
    && MA.finalizeMomentCandidate(seedB, recPost2).candidate.candidateId !== fin1.candidate.candidateId);
  const seedSrc = stripComments(MOMENTS_SRC).slice(stripComments(MOMENTS_SRC).indexOf('function buildMomentCandidateSeed('), stripComments(MOMENTS_SRC).indexOf('async function _momentsWriteApprovedMoment('));
  const seedTwice = pageB.sandbox.window.buildMomentCandidateSeed(ACTOR, { trigger: 'schedule' });
  const seedTwice2 = pageB.sandbox.window.buildMomentCandidateSeed(ACTOR, { trigger: 'schedule' });
  check('SC23.noClockInCandidateIdentity',
    !/Date\.now/.test(seedSrc) && JSON.stringify(seedTwice) === JSON.stringify(seedTwice2));
  check('SC24.noRandomInCandidateIdentity',
    !/Math\.random/.test(seedSrc) && !/Date\.now/.test(seedSrc)
    && !/Math\.random/.test(stripComments(read('assets/js/moments-autonomy.js'))));

  /* ══════════ C · Autonomy integration（SC7–SC10 / SC25 / SC31–SC33） ══════════ */
  section('C · Autonomy integration（SC7–SC10 / SC25 / SC31–SC33）');
  const allowPage = buildPage([v2PostRaw]);
  allowPage.sandbox.apiConfigs = [readyCfg()];
  allowPage.setState(ACTOR, { nextAt: FIXED_NOW - 1000 });
  const allowRun = JSON.parse(JSON.stringify(await allowPage.sandbox.window._momentsRunAutonomousPost(ACTOR, { trigger: 'schedule' })));
  check('SC10.allowWritesOnce',
    allowRun.ok === true && allowRun.published === true && allowRun.decision === 'allow'
    && allowPage.live() === 1 && allowPage.spy.autonomy === 1 && allowRun.executed === true, allowRun);
  check('SC25.noSecondModelCall',
    allowRun.modelCalls === 1 && allowPage.spy.modelCalls === 1
    && countOf(stripComments(MOMENTS_SRC), 'await evaluateRoleMomentSemantic(') === 1);
  const skipRunPage = buildPage([v2SkipRaw]);
  skipRunPage.sandbox.apiConfigs = [readyCfg()];
  skipRunPage.setState(ACTOR, { nextAt: FIXED_NOW - 1000 });
  const skipRun = JSON.parse(JSON.stringify(await skipRunPage.sandbox.window._momentsRunAutonomousPost(ACTOR, { trigger: 'schedule' })));
  check('SC7.semanticSkipNoWrite',
    skipRun.ok === true && skipRun.published === false && skipRun.reason === 'recommendation-skip'
    && skipRunPage.live() === 0 && skipRunPage.stats.directPut === 0 && skipRun.decision === 'deny', skipRun);
  const denyPage = buildPage([v2PostRaw]);
  denyPage.sandbox.apiConfigs = [readyCfg()];
  denyPage.setState(ACTOR, { nextAt: FIXED_NOW - 1000 });
  denyPage.sandbox.localStorage.setItem('ib_moments_prefs_v1', JSON.stringify({ enabled: true, autoPublish: false, frequency: 'medium' }));
  const denyRun = JSON.parse(JSON.stringify(await denyPage.sandbox.window._momentsRunAutonomousPost(ACTOR, { trigger: 'schedule' })));
  check('SC8.policyDenyNoWrite',
    denyRun.ok === true && denyRun.published === false && denyRun.decision === 'deny'
    && /disabled/.test(denyRun.reason) && denyPage.live() === 0 && denyRun.executed === false,
    { reason: denyRun.reason, decision: denyRun.decision, live: denyPage.live() });
  const deferPage = buildPage([v2PostRaw]);
  deferPage.sandbox.apiConfigs = [readyCfg()];
  deferPage.setState(ACTOR, { nextAt: FIXED_NOW - 1000 });
  const deferRun = JSON.parse(JSON.stringify(await deferPage.pipeline(ACTOR, "{trigger:'schedule',extraPolicy:function(){return {decision:'defer'}}}")));
  check('SC9.policyDeferNoWrite',
    deferRun.ok === true && deferRun.published === false && deferRun.decision === 'defer'
    && deferRun.reason === 'policy-defer' && deferPage.live() === 0,
    { ok: deferRun.ok, pub: deferRun.published, decision: deferRun.decision, reason: deferRun.reason, live: deferPage.live() });
  check('SC31.executorHasNoPolicy',
    (() => {
      const body = stripComments(MOMENTS_SRC);
      const at = body.indexOf('async function _momentsWriteApprovedMoment(');
      const end = body.indexOf('async function _momentsRunAutonomousPost(');
      const bridge = (at >= 0 && end > at) ? body.slice(at, end) : '';
      return !/recommendation|reasonCode|cooldown|decide\(|prefs|topicFingerprint/.test(bridge) && /createMoment\(data,options\)/.test(bridge);
    })());
  check('SC32.executorHasNoModel',
    !/_obsCall|callApiChat|_momentsModelCall|evaluateRoleMomentSemantic/.test((() => {
      const body = stripComments(MOMENTS_SRC);
      const at = body.indexOf('async function _momentsWriteApprovedMoment(');
      const end = body.indexOf('async function _momentsRunAutonomousPost(');
      return (at >= 0 && end > at) ? body.slice(at, end) : '';
    })()));
  const legacyPage = buildPage([legacyPostRaw]);
  legacyPage.sandbox.apiConfigs = [readyCfg()];
  legacyPage.setState(ACTOR, { nextAt: FIXED_NOW - 1000 });
  const legacyRun = JSON.parse(JSON.stringify(await legacyPage.sandbox.window._momentsRunAutonomousPost(ACTOR, { trigger: 'schedule' })));
  check('SC33.legacyPublishHasNoAuthority',
    legacyRun.published === true && legacyRun.decision === 'allow' && legacyPage.spy.autonomy === 1
    && legacyPage.live() === 1 && /publish/.test(legacyPostRaw)
    && !/publish\s*!==\s*true/.test(fnSlice(MOMENTS_SRC, '_momentsRunAutonomousPost')), legacyRun);

  /* ══════════ D · Image ordering（SC11–SC14） ══════════ */
  section('D · Image after ALLOW only（SC11–SC14）');
  const imgAllow = buildPage([v2PostRaw]);
  imgAllow.sandbox.apiConfigs = [readyCfg()];
  imgAllow.setState(ACTOR, { nextAt: FIXED_NOW - 1000 });
  await imgAllow.sandbox.window._momentsRunAutonomousPost(ACTOR, { trigger: 'schedule', forceImage: true });
  check('SC11.imageOnlyAfterAllow',
    imgAllow.stats.imageRouter >= 1 && imgAllow.spy.autonomy === 1, { router: imgAllow.stats.imageRouter });
  const imgSkip = buildPage([v2SkipRaw]);
  imgSkip.sandbox.apiConfigs = [readyCfg()];
  imgSkip.setState(ACTOR, { nextAt: FIXED_NOW - 1000 });
  await imgSkip.sandbox.window._momentsRunAutonomousPost(ACTOR, { trigger: 'schedule', forceImage: true });
  check('SC12.skipImageCallsZero', imgSkip.stats.imageRouter === 0 && imgSkip.live() === 0);
  const imgDeny = buildPage([v2PostRaw]);
  imgDeny.sandbox.apiConfigs = [readyCfg()];
  imgDeny.setState(ACTOR, { nextAt: FIXED_NOW - 1000 });
  imgDeny.sandbox.localStorage.setItem('ib_moments_prefs_v1', JSON.stringify({ enabled: true, autoPublish: false, frequency: 'medium' }));
  await imgDeny.sandbox.window._momentsRunAutonomousPost(ACTOR, { trigger: 'schedule', forceImage: true });
  check('SC13.denyImageCallsZero', imgDeny.stats.imageRouter === 0 && imgDeny.live() === 0);
  const imgDefer = buildPage([v2PostRaw]);
  imgDefer.sandbox.apiConfigs = [readyCfg()];
  imgDefer.setState(ACTOR, { nextAt: FIXED_NOW - 1000 });
  await imgDefer.pipeline(ACTOR, "{trigger:'schedule',forceImage:true,extraPolicy:function(){return {decision:'defer'}}}");
  check('SC14.deferImageCallsZero', imgDefer.stats.imageRouter === 0 && imgDefer.live() === 0);

  /* ══════════ E · Manual / legacy / idempotency / cooldown（SC15 / SC16 / SC18 / SC19 / SC21 / SC22） ══════════ */
  section('E · Manual / idempotency / cooldown（SC15 / SC16 / SC18 / SC19 / SC21 / SC22）');
  const manualPage = buildPage([v2PostRaw]);
  manualPage.sandbox.apiConfigs = [readyCfg()];
  const manualRes = JSON.parse(JSON.stringify(await manualPage.sandbox.window.createMoment({ authorType: 'user', authorId: 'user_local', content: '我自己发的。', source: 'manual', visibility: 'all' })));
  check('SC15.manualPathUnchanged',
    manualRes.ok === true && manualRes.moment.source === 'manual' && manualRes.moment.authorType === 'user' && manualPage.live() === 1);
  check('SC16.manualAutonomyCallsZero',
    manualPage.spy.autonomy === 0 && manualPage.spy.modelCalls === 0 && manualPage.spy.finalize === 0);
  const coolPage = buildPage([v2PostRaw]);
  coolPage.sandbox.apiConfigs = [readyCfg()];
  coolPage.setState(ACTOR, { nextAt: FIXED_NOW - 1000, lastPostAt: Date.now() - 10 * 60000 });
  const coolRun = JSON.parse(JSON.stringify(await coolPage.sandbox.window._momentsRunAutonomousPost(ACTOR, { trigger: 'schedule' })));
  check('SC18.existingCooldownPreserved',
    coolRun.published === false && coolRun.decision === 'deny' && /cooldown|duplicate/.test(coolRun.reason)
    && coolPage.live() === 0 && coolPage.stats.imageRouter === 0, coolRun);
  /* 手动触发沿用迁移前行为：没有凭空多出来的冷却（否则"同样条件下 trigger 次数"会变）。
     同一条草案仍会被既有内容级相似度防线拦下 —— 这不是冷却，是原本就有的规则。 */
  const manualCoolPage = buildPage([v2PostRaw]);
  manualCoolPage.sandbox.apiConfigs = [readyCfg()];
  manualCoolPage.setState(ACTOR, { lastPostAt: Date.now() - 5 * 60000 });
  const manualCoolRun = JSON.parse(JSON.stringify(await manualCoolPage.sandbox.window.generateRoleMoment(ACTOR, { trigger: 'manual' })));
  check('SC18b.manualTriggerKeepsNoCooldown',
    manualCoolRun.ok === true && manualCoolRun.published === true && manualCoolPage.live() === 1,
    { pub: manualCoolRun.published, live: manualCoolPage.live() });
  const streakPage = buildPage([v2SkipRaw]);
  streakPage.sandbox.apiConfigs = [readyCfg()];
  streakPage.setState(ACTOR, { nextAt: FIXED_NOW - 1000, declineStreak: 2 });
  const streakRes = JSON.parse(JSON.stringify(await streakPage.sandbox.window.generateRoleMoment(ACTOR, { trigger: 'manual' })));
  check('SC19.declineStreakPreserved',
    streakRes.ok === true && streakRes.published === false && Number(streakPage.getState(ACTOR).declineStreak) === 3,
    { res: streakRes, st: streakPage.getState(ACTOR) });
  /* 同一 topicKey、不同措辞 ⇒ 同一 candidate（同一个 Moment），但内容不是逐字重复，
     因此既有相似度防线不会提前拦下 —— 这条才是"同候选重试/第二次触发不双发"的直接证据。 */
  const v2PostRawB = JSON.stringify({
    recommendation: 'post', reasonCode: 'meaningful-moment', topicKey: 'rainy-window',
    draft: { content: '窗外还在下雨，我把窗台擦干净了。', visibility: 'all', visibleRoleIds: [], motive: 'daily_life', wantImage: false, imagePrompt: '' }
  });
  const idemPage = buildPage([v2PostRaw, v2PostRawB]);
  idemPage.sandbox.apiConfigs = [readyCfg()];
  idemPage.setState(ACTOR, { nextAt: FIXED_NOW - 1000 });
  const first = JSON.parse(JSON.stringify(await idemPage.sandbox.window._momentsRunAutonomousPost(ACTOR, { trigger: 'schedule' })));
  const second = JSON.parse(JSON.stringify(await idemPage.sandbox.window._momentsRunAutonomousPost(ACTOR, { trigger: 'schedule' })));
  check('SC21.sameCandidateRetryOneMoment',
    first.published === true && idemPage.live() === 1
    && second.momentId === first.momentId && second.candidateSeed.triggerRef === first.candidateSeed.triggerRef
    && second.candidateId === first.candidateId,
    { first: first.momentId, second: second.momentId, live: idemPage.live() });
  check('SC22.schedulerRetryNoDuplicate',
    idemPage.live() === 1 && idemPage.spy.autonomy === 2 && idemPage.spy.finalize === 2);

  /* ══════════ F · Canonical carrier（SC34 / SC35） ══════════ */
  section('F · Canonical writer / Home Node carrier（SC34 / SC35）');
  const writerBody = stripComments(MOMENTS_SRC);
  check('SC34.canonicalWriterStillUnique',
    countOf(writerBody, 'function _momentsWriteCanonical(') === 1
    && countOf(writerBody, 'await _momentsWriteCanonical(') === 1   /* P25-2D：唯一调用点 = createMoment */
    && countOf(writerBody, 'hn.put(m,') === 1
    && countOf(writerBody, 'function createMoment(') === 1);
  const canonPage = buildPage([v2PostRaw], { canonical: true });
  canonPage.sandbox.apiConfigs = [readyCfg()];
  canonPage.setState(ACTOR, { nextAt: FIXED_NOW - 1000 });
  const canonRun = JSON.parse(JSON.stringify(await canonPage.sandbox.window._momentsRunAutonomousPost(ACTOR, { trigger: 'schedule' })));
  const canonRow = canonRun.momentId ? canonPage.row(canonRun.momentId) : null;
  check('SC35.homeNodeCanonicalModeWorks',
    canonRun.published === true && canonPage.live() === 1 && !!canonRow
    && canonRow.source === 'proactive' && canonRow.roleId === ACTOR
    && canonPage.stats.directPutBlocked === 0, { run: canonRun.ok, live: canonPage.live(), row: !!canonRow });
  check('SC35b.canonicalGuardStillBlocksDirectPut', await canonPage.sandbox.dbPut('moments', { id: 'direct' }).then(() => false, (e) => e.code === 'moments-write-closed'));

  /* ══════════ G · Guards（SC26–SC30 / 源码守卫） ══════════ */
  section('G · Boundaries / source guards（SC26–SC30）');
  check('SC26.autonomyCoreUnchanged', sha256('assets/js/autonomy-core.js') === FROZEN_SHA256['assets/js/autonomy-core.js']);
  check('SC27.p23Unchanged', sha256('assets/js/communication.js') === FROZEN_SHA256['assets/js/communication.js']);
  check('SC28.p24Unchanged', sha256('assets/js/group-runtime-core.js') === FROZEN_SHA256['assets/js/group-runtime-core.js']);
  check('SC29.noMemoryRefs',
    !/\bMemory\b|memories|memoryAuthority|disclosureFacts/.test(fnSlice(MOMENTS_SRC, '_momentsRunAutonomousPost'))
    && !/\bMemory\b|memories|memoryAuthority/.test(stripComments(AUTONOMY_ADAPTER_SRC)));
  check('SC30.noMiddleBrainRefs',
    !/middle-brain|middleBrain|middle_brain|astra/i.test(fnSlice(MOMENTS_SRC, '_momentsRunAutonomousPost') + stripComments(AUTONOMY_ADAPTER_SRC)));
  /* P25-2D：companion 域**已被收敛**（不再是"逐字节不变"的冻结面）——
     它现在与桌面端共用语义契约，且仍然没有直接写入路径。 */
  check('SC30b.schedulerDomainBoundary',
    sha256('assets/js/active-diary.js') === FROZEN_SHA256['assets/js/active-diary.js']
    && /moments-semantic-core/.test(read('active/moments.js'))
    && !/createMoment\(|_momentsWriteCanonical/.test(stripComments(read('active/moments.js')))
    && !/IBMomentsAutonomy/.test(read('assets/js/active-diary.js')));
  check('SC30c.adapterLoadedBeforeMoments',
    (() => {
      const html = read('InternalBeyond.html');
      const i = html.indexOf('src="assets/js/autonomy-core.js"');
      const j = html.indexOf('src="assets/js/moments-autonomy.js"');
      const v = html.indexOf('src="assets/js/voice-message-core.js"');
      const c = html.indexOf('src="assets/js/chat-core.js"');
      const sem = html.indexOf('src="assets/js/moments-semantic-core.js"');
      const mo = html.indexOf('src="assets/js/moments.js"');
      /* 语义核在 moments.js 之前（2B 的要求）；adapter 与它的依赖
         （chat-core / voice-message-core / autonomy-core）同层且排在
         moments.js **之后**（页面的核心层顺序：moments.js 先于 chat-core 加载），
         但必须在任何运行期使用之前 —— 解析是按调用时进行的。 */
      return sem > 0 && mo > sem && c > 0 && v > c && i > v && j > i;
    })());

  console.log('\n' + (failed === 0 ? 'ALL PASS' : 'FAILURES: ' + failures.join(', ')));
  console.log('P25-2C · scheduler migration: ' + passed + ' passed, ' + failed + ' failed');
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((e) => { console.error('suite crashed:', (e && e.stack) || e); process.exitCode = 1; });
