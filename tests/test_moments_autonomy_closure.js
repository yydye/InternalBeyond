'use strict';

/* Internal Beyond · P25-2 · Moments Autonomy Closure / Freeze 测试
   （static 组：纯 Node、零浏览器、零外部网络；运行：
     node tests/test_moments_autonomy_closure.js）

   Closure 阶段只做三件事：**枚举**生产创建路径、**冻结**不变量、**证明**收敛。
   覆盖 CL1–CL50。本套件与 A/B/C/D 四个阶段的套件互补：
     · A/B/C/D 证明"每个阶段的行为"（管线、语义、调度、companion）；
     · 本套件证明"全仓没有任何 autonomous create 绕过 Autonomy"（枚举 + 守卫）。

   枚举不是手抄清单：每条路径都由源码扫描得到，并按其**所属函数**分类。 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const sha256 = f => crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, f))).digest('hex').toUpperCase();

let passed = 0, failed = 0;
const failures = [];
function check(name, cond, extra) {
  if (cond) { passed++; console.log('  \u2714 ' + name); }
  else { failed++; failures.push(name); console.log('  \u2716 ' + name + (extra === undefined ? '' : '  -> ' + JSON.stringify(extra).slice(0, 320))); }
}
function section(title) { console.log('\n── ' + title + ' ──'); }
const stripComments = src => String(src).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const countOf = (src, needle) => String(src).split(needle).length - 1;

/* ── 生产面（排除 tests/ 与发行快照）────────────────────────────── */
const PROD_FILES = [
  'assets/js/moments.js', 'assets/js/social-network.js', 'assets/js/core.js',
  'assets/js/home-node-bootstrap.js', 'assets/js/active-diary.js',
  'active/moments.js', 'services/active-message-service.js',
  'services/home-node/moments-store.js', 'services/home-node/mobile-gateway.js'
];
const PROD_SRC = PROD_FILES.map(f => ({ file: f, src: stripComments(read(f)) }));
function enclosingFn(src, index) {
  const before = src.slice(0, index);
  const m = [...before.matchAll(/\n(?:async )?function ([A-Za-z0-9_$]+)\(/g)];
  return m.length ? m[m.length - 1][1] : '';
}
function callSites(needle) {
  const out = [];
  for (const { file, src } of PROD_SRC) {
    let i = src.indexOf(needle);
    while (i >= 0) {
      const isDefinition = /(?:async\s+)?function\s+$/.test(src.slice(Math.max(0, i - 24), i));
      out.push({
        file,
        fn: isDefinition ? needle.replace('(', '') : enclosingFn(src, i),
        isDefinition: isDefinition,
        /* ±200 字符：足以覆盖 createMoment({...}) 的整段实参（含 source:'manual'） */
        snippet: src.slice(Math.max(0, i - 200), i + 200).replace(/\s+/g, ' ')
      });
      i = src.indexOf(needle, i + 1);
    }
  }
  return out;
}

const FROZEN_SHA256 = {
  'assets/js/autonomy-core.js': 'FE1011F1DC3434DB6A72A328A63AFEEAE99E1E95762EA910CE379F019F2956F8',
  'assets/js/communication.js': 'DEB568A2F3653009C511BE25753E87AC9EF477FF229BE5CF569EB430AC29184F',
  'assets/js/group-runtime-core.js': '6F30FDE91F518B69B613B74B675B42EB66D227E36C1E18F04A3A1274067B35E8',
  'assets/js/active-diary.js': 'EEAC85AB0CB215723AD641D416606B941C2EBABBE99CB373A6DA1661A6964E26'
};
const P23_CORES = ['assets/js/delivery-planner.js', 'assets/js/multimodal-delivery-policy.js',
  'assets/js/delivery-sequence-core.js', 'assets/js/delivery-runtime.js', 'assets/js/voice-message-core.js'];

const MOMENTS_SRC = read('assets/js/moments.js');
const COMPANION_SRC = read('active/moments.js');
const adapterSrc = stripComments(read('assets/js/moments-autonomy.js'));
const semanticSrc = stripComments(read('assets/js/moments-semantic-core.js'));

const ACTOR = 'cl_role';
const v2PostRaw = JSON.stringify({
  recommendation: 'post', reasonCode: 'meaningful-moment', topicKey: 'closure-topic',
  draft: { content: 'Closure 阶段的正文。', visibility: 'all', visibleRoleIds: [], motive: 'daily_life', wantImage: false, imagePrompt: '' }
});

const tempDirs = [];
function tempDir() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ibcl-')); tempDirs.push(dir); return dir; }
process.on('exit', () => { for (const dir of tempDirs) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* ignore */ } } });

/* ── 浏览器沙箱（与 2A–2D 同一策略：真实 modules，只替换 DOM/网络）── */
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
function buildPage(opts) {
  opts = opts || {};
  const rows = new Map();
  const stats = { imageRouter: 0, acks: 0, modelCalls: 0, directPutBlocked: 0 };
  const stored = new Map();
  const sandbox = {};
  const IB = { expose: function (p, obj) { IB[p] = Object.assign(IB[p] || {}, obj); } };
  const CHAT_CORE = require(path.join(ROOT, 'assets/js/chat-core.js'));
  const VOICE_CORE = require(path.join(ROOT, 'assets/js/voice-message-core.js'));
  const VIS = require(path.join(ROOT, 'assets/js/moments-visibility-core.js'));
  const PLAN_DOMAIN = require(path.join(ROOT, 'active', 'plan-domain.js'))({ getState: () => ({}), armedUsers: new Set(), saveNow: () => {} });
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.IB = IB;
  sandbox.console = { log() {}, info() {}, warn() {}, error() {} };
  sandbox.setTimeout = () => 0;
  sandbox.clearTimeout = () => {};
  sandbox.localStorage = {
    getItem: (k) => (stored.has(String(k)) ? stored.get(String(k)) : null),
    setItem: (k, v) => { stored.set(String(k), String(v)); },
    removeItem: (k) => { stored.delete(String(k)); }
  };
  sandbox.IBChatCore = CHAT_CORE;
  sandbox.IBVoiceMessage = VOICE_CORE;
  sandbox.IBMomentsVisibilityCore = VIS;
  sandbox.__ibParsePlanJsonRaw = PLAN_DOMAIN.parsePlanJson;
  sandbox.IB.imageRouter = { available: true, routeImageRequest: () => { stats.imageRouter++; return Promise.resolve({ ok: true, dataUrl: 'data:image/jpeg;base64,AAAA' }); } };
  sandbox.apiConfigs = [];
  sandbox.archivedConfigs = [];
  sandbox.currentPage = 'settings';
  sandbox.loadMomentsPage = function () {};
  sandbox._activeUserId = () => 'u1';
  sandbox._ibApiReady = () => true;
  sandbox._activeRecentMemories = () => Promise.resolve([]);
  sandbox._activeRecentProactiveMessages = () => Promise.resolve([]);
  sandbox._activeRecentMessages = () => Promise.resolve([]);
  sandbox._activeTextSimilarity = (a, b) => (String(a) === String(b) ? 1 : 0);
  sandbox._credentialSync = () => Promise.resolve(true);
  sandbox.db = {};
  sandbox.runtimeExecuteEnabled = false;
  sandbox.__pendingEvents = (opts.events || []).slice();
  sandbox._activeCompanionRequest = function (p) {
    const target = String(p || '');
    if (target.indexOf('/events/') === 0 && target.indexOf('/ack') > 0) { stats.acks++; return Promise.resolve({ ok: true }); }
    if (target.indexOf('/events') === 0) { const list = sandbox.__pendingEvents.slice(); sandbox.__pendingEvents = []; return Promise.resolve({ ok: true, events: list }); }
    if (target.indexOf('/health') === 0) return Promise.resolve({ ok: true, moments: 0, reply_chains: true });
    if (target.indexOf('/reconcile') === 0) return Promise.resolve({ ok: true });
    if (target.indexOf('/moments/') === 0) return Promise.resolve({ ok: true, schedule: { decline_streak: 0 } });
    return Promise.resolve({ ok: true });
  };
  sandbox.dbPut = function (store, row) {
    return new Promise((resolve, reject) => {
      if (String(store) !== 'moments') { resolve(undefined); return; }
      if (opts.canonical) {
        stats.directPutBlocked++;
        const e = new Error('moments 是 Home Node 的 canonical 域；浏览器不得直接写入（fail closed）');
        e.code = 'moments-write-closed';
        reject(e);
        return;
      }
      rows.set(String(row.id), row);
      resolve(undefined);
    });
  };
  sandbox.dbDelete = (s, k) => { rows.delete(String(k)); return Promise.resolve(undefined); };
  sandbox.dbGet = (s, k) => Promise.resolve(rows.get(String(k)) || null);
  sandbox.dbGetAll = () => Promise.resolve(Array.from(rows.values()));
  sandbox.dbGetByIndex = () => Promise.resolve([]);
  sandbox.callApiChat = () => { stats.modelCalls++; return Promise.resolve(v2PostRaw); };
  vm.createContext(sandbox);
  vm.runInContext('(function(){var raw=__ibParsePlanJsonRaw;window._activeParsePlanJson=function(t,o){try{var j=raw(t,o);return j?JSON.parse(JSON.stringify(j)):null}catch(e){return null}};})();', sandbox, { filename: 'parser-bridge.js' });
  ['assets/js/moments-semantic-core.js', 'assets/js/autonomy-core.js', 'assets/js/moments-autonomy.js', 'assets/js/moments.js']
    .forEach(f => vm.runInContext(read(f).replace(/^\uFEFF/, ''), sandbox, { filename: f }));
  sandbox.loadMomentsPage = function () {};
  const spy = { autonomy: 0 };
  const adapter = sandbox.IBMomentsAutonomy;
  const origRun = adapter.runMomentAutonomy;
  adapter.runMomentAutonomy = function (i, d) { spy.autonomy++; return origRun(i, d); };
  let store = null;
  if (opts.canonical) {
    const createMomentsStore = require(path.join(ROOT, 'services/home-node/moments-store.js'));
    const createMomentsAuthority = require(path.join(ROOT, 'assets/js/moments-authority.js')).createMomentsAuthority;
    store = createMomentsStore({ dataDir: tempDir(), logger: () => {} });
    store.open();
    const authority = createMomentsAuthority({
      remote: makeStoreRemote(store), local: makeLocalDriver(rows), mode: 'canonical', fileOrigin: false, log: function () {}
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
    sandbox: sandbox, stats: stats, spy: spy,
    setState: (roleId, patch) => {
      const all = JSON.parse(stored.get('ib_moments_state_v1') || '{}');
      all[roleId] = Object.assign({}, all[roleId] || {}, patch);
      stored.set('ib_moments_state_v1', JSON.stringify(all));
    },
    live: () => (store ? store.countLive() : rows.size),
    ingest: (ev) => sandbox.window._momentsIngestEvent(ev, 'u1'),
    tick: (now) => sandbox.window._momentsTick(now),
    pipeline: (roleId, optsExpr) => vm.runInContext(
      '(async function(){return await _momentsRunAutonomousPost(' + JSON.stringify(roleId) + ',' + (optsExpr || '{}') + ')})()',
      sandbox, { filename: 'pipeline.js' })
  };
}
function companionEvent(patch) {
  const p = patch || {};
  const draft = Object.assign({ content: 'Closure 阶段的正文。', visibility: 'all', visibleRoleIds: [], motive: 'daily_life', wantImage: false, imagePrompt: '' }, p.draft || {});
  return {
    id: p.id || 'evt_cl_1', kind: 'moment', moment_id: 'mom_provisional',
    user_id: 'u1', character_id: ACTOR, actor_id: ACTOR, character_name: '测试角色',
    slot_at: 1770000000000, sent_at: 1770000000000, status: 'moment_sent', source: 'schedule',
    trigger_ref: 'companion:1770000000000', semantic_contract: 'moment-semantic/v2',
    recommendation: p.recommendation || 'post', reason_code: 'meaningful-moment',
    topic_key: 'closure-topic', topic_fingerprint: 'mt_closure', draft: draft,
    next_at: 1770000000000 + 3600000, last_post_at: 1770000000000, decline_streak: 0,
    moment: { id: 'mom_provisional', roleId: ACTOR, content: draft.content, images: [], visibility: draft.visibility, visibleRoleIds: [], likes: [], comments: [], source: 'proactive', motive: draft.motive, createdAt: new Date(1770000000000).toISOString() }
  };
}

async function main() {
  console.log('== P25-2 · Moments Autonomy Closure / Freeze 测试 ==');

  /* ══════════ A · 生产创建路径枚举（CL1/CL2/CL6–CL9/CL48） ══════════ */
  section('A · Production create-path enumeration（CL1/CL2/CL6–CL9/CL48）');
  const createSites = callSites('createMoment(');
  const classify = (site) => {
    if (site.isDefinition) return 'SYSTEM_AUTHORITY';
    if (site.fn === '_momentsWriteApprovedMoment' || site.fn === '_momentsWriteCompanionMoment') return 'AUTONOMOUS_CREATE';
    if (/source:'manual'/.test(site.snippet)) return 'MANUAL_CREATE';
    return 'UNCLASSIFIED';
  };
  const classified = createSites.map(s => Object.assign({}, s, { cls: classify(s) }));
  check('CL1.enumerateProductionCreatePaths',
    classified.length === 7
    && classified.filter(s => s.cls === 'SYSTEM_AUTHORITY').length === 1
    && classified.filter(s => s.cls === 'AUTONOMOUS_CREATE').length === 2
    && classified.filter(s => s.cls === 'MANUAL_CREATE').length === 4
    && classified.every(s => s.cls !== 'UNCLASSIFIED'),
    classified.map(s => s.file + ':' + s.fn + ':' + s.cls));
  check('CL2.manualCreateIsOnlyBypass',
    classified.filter(s => s.cls === 'MANUAL_CREATE').every(s => /source:'manual'/.test(s.snippet))
    && classified.filter(s => s.cls === 'AUTONOMOUS_CREATE').every(s => /_momentsWrite(Approved|Companion)Moment/.test(s.fn))
    && /source:'manual'/.test(read('assets/js/social-network.js'))
    && /source:'manual'/.test(MOMENTS_SRC));
  check('CL6.companionNodeHasZeroWriter',
    countOf(stripComments(COMPANION_SRC), 'createMoment(') === 0
    && countOf(stripComments(COMPANION_SRC), '_momentsWriteCanonical') === 0
    && !/dbPut\(/.test(stripComments(COMPANION_SRC))
    && !/dbDelete\(/.test(stripComments(COMPANION_SRC)));
  check('CL7.semanticLayerHasZeroWriter', (() => {
    const body = stripComments(MOMENTS_SRC);
    const start = body.indexOf('async function evaluateRoleMomentSemantic(');
    const stops = ['function _momentsAutonomyAdapter(', 'async function generateRoleMoment(']
      .map(m => body.indexOf(m, start)).filter(i => i > start);
    const slice = body.slice(start, stops.length ? Math.min.apply(null, stops) : body.length);
    return !/createMoment\(|_momentsWriteCanonical|dbPut\(/.test(slice) && slice.length > 0;
  })());
  check('CL8.schedulerHasZeroWriter', (() => {
    const body = stripComments(MOMENTS_SRC);
    const local = body.slice(body.indexOf('async function _momentsLocalTick('), body.indexOf('async function _momentsTick('));
    const tick = body.slice(body.indexOf('async function _momentsTick('), body.indexOf('async function _momentsTick(') + 1600);
    return !/createMoment\(|_momentsWriteCanonical|_momentsMakeImage|IBMomentsAutonomy/.test(local + tick)
      && /generateRoleMoment\(key,\{trigger:'schedule'\}\)/.test(local);
  })());
  check('CL9.modelOutputCannotGrantPermission',
    !/recommendation===?'post'[^;]*createMoment/.test(stripComments(MOMENTS_SRC))
    && countOf(stripComments(MOMENTS_SRC), 'runMomentAutonomy(') === 2
    && /decision !== autonomyDecisions\(\)\.ALLOW/.test(adapterSrc));
  check('CL48.mutationPathsClassifiedSeparately', (() => {
    const sites = callSites('dbPut(MOMENT_STORE,m);');
    const fns = [...new Set(sites.map(s => s.fn))].sort();
    return fns.join(',') === ['_momentsWriteCanonical', 'addMomentComment', 'deleteMomentComment', 'likeMoment'].sort().join(',')
      && countOf(stripComments(MOMENTS_SRC), 'dbDelete(MOMENT_STORE,id);') === 1;
  })(), [...new Set(callSites('dbPut(MOMENT_STORE,m);').map(s => s.fn))]);

  /* ══════════ B · 基础不变量（CL3–CL5/CL10–CL12/CL33/CL34） ══════════ */
  section('B · Primary invariant guards（CL3–CL5/CL10–CL12/CL33/CL34）');
  const genSites = callSites('generateRoleMoment(');
  check('CL3.desktopSchedulerRequiresAutonomy',
    genSites.some(s => s.fn === '_momentsLocalTick')
    && countOf(stripComments(MOMENTS_SRC), '_momentsRunAutonomousPost(') === 2  /* 定义 + wrapper 调用 */
    && /async function generateRoleMoment\(/.test(MOMENTS_SRC)
    && countOf(stripComments(MOMENTS_SRC), 'function generateRoleMoment(') === 1
    && !/createMoment\(/.test((() => {
      const body = stripComments(MOMENTS_SRC);
      const start = body.indexOf('async function generateRoleMoment(');
      return body.slice(start, start + 1500);
    })()));
  check('CL4.askTaRequiresAutonomy',
    /generateRoleMoment\(id,Object\.assign\(\{trigger:'manual'\}/.test(MOMENTS_SRC)
    && /_momentsAskGenerate/.test(MOMENTS_SRC)
    && /async function _momentsAskGenerate\(/.test(MOMENTS_SRC));
  check('CL5.companionEventRequiresAutonomy',
    /_momentsIngestEvent\(ev,userId\)/.test(MOMENTS_SRC)
    && /runMomentAutonomy\(finalized\.candidate,deps\)/.test(MOMENTS_SRC)
    && /kind:\s*'moment'/.test(COMPANION_SRC)
    && countOf(stripComments(COMPANION_SRC), 'moment_sent') === 1);
  check('CL10.postIsNotAllow',
    JSON.stringify(require(path.join(ROOT, 'assets/js/moments-semantic-core.js')).MOMENT_SEMANTIC_RECOMMENDATIONS) === JSON.stringify(['post', 'skip'])
    && /RECOMMENDATIONS = Object\.freeze\(\['post', 'skip'\]\)/.test(read('assets/js/moments-semantic-core.js'))
    && /MOMENT_SEMANTIC_RECOMMENDATIONS: RECOMMENDATIONS/.test(semanticSrc)
    && !/'allow'|'deny'|'defer'/.test(stripComments(read('assets/js/moments-semantic-core.js')).slice(
      stripComments(read('assets/js/moments-semantic-core.js')).indexOf('var RECOMMENDATIONS'),
      stripComments(read('assets/js/moments-semantic-core.js')).indexOf('var POST_REASONS'))));
  check('CL11.adapterExplicitPolicy',
    /ctx\.decide = function/.test(adapterSrc)
    && /explicitPolicy = true/.test(adapterSrc)
    && /policy-allow/.test(adapterSrc));
  check('CL12.coreDefaultAllowNotUsed',
    /default-allow/.test(stripComments(read('assets/js/autonomy-core.js')))
    && /ctx\.decide = function/.test(adapterSrc)
    && !/reason: 'default-allow'/.test(adapterSrc));
  check('CL33.canonicalWriterUnique',
    countOf(stripComments(MOMENTS_SRC), 'function _momentsWriteCanonical(') === 1
    && countOf(stripComments(MOMENTS_SRC), 'await _momentsWriteCanonical(') === 1
    && countOf(stripComments(MOMENTS_SRC), 'hn.put(m,') === 1
    && countOf(stripComments(MOMENTS_SRC), 'function createMoment(') === 1);
  check('CL34.canonicalModeWorks', await (async () => {
    const page = buildPage({ canonical: true });
    const ok = await page.ingest(companionEvent());
    return ok === true && page.live() === 1 && page.stats.directPutBlocked === 0;
  })());

  /* ══════════ C · 语义 / 身份 / 契约冻结（CL13–CL30） ══════════ */
  section('C · Contract & identity freeze（CL13–CL30）');
  const denPage = buildPage({});
  denPage.sandbox.apiConfigs = [{ id: ACTOR, model: 'm', endpoint: 'http://127.0.0.1:1', apiKey: 'k' }];
  denPage.setState(ACTOR, { nextAt: 1 });
  denPage.sandbox.localStorage.setItem('ib_moments_prefs_v1', JSON.stringify({ enabled: true, autoPublish: false, frequency: 'medium' }));
  const den = await denPage.pipeline(ACTOR, '{trigger:"schedule"}');
  check('CL13.denyZeroWrite', den.published === false && den.decision === 'deny' && denPage.live() === 0);
  check('CL14.denyZeroImage', denPage.stats.imageRouter === 0 && den.imageCalls === 0);
  const defPage = buildPage({});
  defPage.sandbox.apiConfigs = [{ id: ACTOR, model: 'm', endpoint: 'http://127.0.0.1:1', apiKey: 'k' }];
  defPage.setState(ACTOR, { nextAt: 1 });
  const def = await defPage.pipeline(ACTOR, '{trigger:"schedule",extraPolicy:function(){return {decision:"defer"}}}');
  check('CL15.deferZeroWrite', def.published === false && def.decision === 'defer' && defPage.live() === 0);
  check('CL16.deferZeroImage', defPage.stats.imageRouter === 0 && def.imageCalls === 0);
  const allowPage = buildPage({});
  allowPage.sandbox.apiConfigs = [{ id: ACTOR, model: 'm', endpoint: 'http://127.0.0.1:1', apiKey: 'k', imageGen: true }];
  allowPage.setState(ACTOR, { nextAt: 1 });
  const allow = await allowPage.pipeline(ACTOR, '{trigger:"schedule"}');
  check('CL17.allowExactlyOneCreate', allow.published === true && allowPage.live() === 1 && allow.executed === true);
  check('CL18.imageOnlyAfterAllow', await (async () => {
    const p = buildPage({});
    p.sandbox.apiConfigs = [{ id: ACTOR, model: 'm', endpoint: 'http://127.0.0.1:1', apiKey: 'k', imageGen: true }];
    p.setState(ACTOR, { nextAt: 1 });
    await p.pipeline(ACTOR, '{trigger:"schedule",forceImage:true}');
    return p.stats.imageRouter >= 1 && p.live() === 1 && defPage.stats.imageRouter === 0 && denPage.stats.imageRouter === 0;
  })());
  check('CL19.sameCandidateStableId',
    adapterSrc.indexOf('momentIdForCandidate') > 0
    && /candidateId: 'mca_' \+ token/.test(adapterSrc)
    && /return token \? 'mom_' \+ token : '';/.test(adapterSrc));
  check('CL20.eventReplayIdempotent', await (async () => {
    const p = buildPage({});
    const first = await p.ingest(companionEvent());
    const second = await p.ingest(companionEvent());
    return first === true && second === false && p.live() === 1;
  })());
  check('CL21.desktopTriggerStable',
    /kind==='schedule'\?\('schedule:'\+slot\)/.test(MOMENTS_SRC.replace(/\s+/g, ''))
    && /kind==='schedule'\?/.test(adapterSrc.replace(/\s+/g, '')) === false);
  check('CL22.companionTriggerStable',
    /trigger_ref: `companion:\$\{Number\(due\) \|\| 0\}`/.test(COMPANION_SRC)
    && !/trigger_ref:.*Date\.now/.test(COMPANION_SRC));
  const fnBodyOf = (src, name) => {
    const body = stripComments(src);
    let start = body.indexOf('async function ' + name + '(');
    if (start < 0) start = body.indexOf('function ' + name + '(');
    if (start < 0) return '';
    const a = body.indexOf('\nasync function ', start + 1);
    const b = body.indexOf('\nfunction ', start + 1);
    const cand = [a, b].filter(i => i > start);
    return body.slice(start, cand.length ? Math.min.apply(null, cand) : body.length);
  };
  const companionIdentityLines = stripComments(COMPANION_SRC).split('\n')
    .filter(l => /trigger_ref|topic_fingerprint|slot_at/.test(l)).join('\n');
  check('CL23.noRandomCandidateIdentity',
    !/Math\.random/.test(adapterSrc)
    && !/Math\.random/.test(fnBodyOf(MOMENTS_SRC, 'buildMomentCandidateSeed'))
    && !/Math\.random/.test(companionIdentityLines));
  check('CL24.noTimeBasedCandidateIdentity',
    !/Date\.now/.test(adapterSrc)
    && !/Date\.now/.test(fnBodyOf(MOMENTS_SRC, 'buildMomentCandidateSeed'))
    && !/Date\.now|arrivalAt|receivedAt/.test(companionIdentityLines));
  check('CL25.semanticCoreShared',
    /require\('\.\.\/assets\/js\/moments-semantic-core\.js'\)/.test(COMPANION_SRC)
    && /_momentsSemanticCore\(\)/.test(MOMENTS_SRC)
    && countOf(stripComments(COMPANION_SRC), 'parseMomentSemantic(') >= 2);
  check('CL26.reasonCodeShared',
    !/POST_REASONS\s*=\s*\[/.test(stripComments(COMPANION_SRC))
    && !/SKIP_REASONS\s*=\s*\[/.test(stripComments(COMPANION_SRC))
    && /MOMENT_SEMANTIC_POST_REASONS/.test(read('assets/js/moments-semantic-core.js')));
  check('CL27.topicIdentityShared',
    /SEMANTIC\.parseMomentSemanticOutput\(/.test(COMPANION_SRC)
    && !/normalizeTopicKey|momentTopicFingerprint\s*\(/.test(stripComments(COMPANION_SRC)));
  check('CL28.cotForbiddenShared', /FORBIDDEN_OUTPUT_FIELDS/.test(semanticSrc)
    && /hasForbiddenField/.test(semanticSrc)
    && !/thinking|reasoning|analysis/.test(stripComments(COMPANION_SRC)));
  check('CL29.eventSecretFree',
    !/apiKey|Authorization|credential|systemPrompt/.test(JSON.stringify(companionEvent())));
  check('CL30.actionSecretFree',
    !/apiKey|Authorization|credential|rawCfg|provider/.test(adapterSrc)
    && /secret-in-context/.test(adapterSrc)
    && /secret-in-action/.test(stripComments(read('assets/js/autonomy-core.js'))));

  /* ══════════ D · 双 runtime 行为与所有权（CL31/CL32/CL35–CL37） ══════════ */
  section('D · Runtime behaviour & ownership（CL31/CL32/CL35–CL37）');
  const manPage = buildPage({});
  const man = JSON.parse(JSON.stringify(await manPage.sandbox.window.createMoment({ authorType: 'user', authorId: 'u1', content: '手动。', source: 'manual', visibility: 'all' })));
  check('CL31.manualZeroAutonomy',
    man.ok === true && manPage.live() === 1 && manPage.spy.autonomy === 0 && manPage.stats.modelCalls === 0);
  const askPage = buildPage({});
  askPage.sandbox.apiConfigs = [{ id: ACTOR, model: 'm', endpoint: 'http://127.0.0.1:1', apiKey: 'k' }];
  const ask = JSON.parse(JSON.stringify(await askPage.sandbox.window.generateRoleMoment(ACTOR, { trigger: 'manual' })));
  check('CL32.askTaAutonomyRequired',
    ask.ok === true && ask.published === true && askPage.spy.autonomy === 1 && askPage.live() === 1);
  const onPage = buildPage({ events: [companionEvent()] });
  onPage.sandbox.apiConfigs = [{ id: ACTOR, model: 'm', endpoint: 'http://127.0.0.1:1', apiKey: 'k' }];
  onPage.setState(ACTOR, { nextAt: 1 });
  onPage.sandbox.window._activeCompanionOnline = true;
  await onPage.tick(1770000000000);
  check('CL35.companionOnlineDesktopYields',
    onPage.live() === 1 && onPage.stats.modelCalls === 0 && onPage.stats.acks === 1);
  const offPage = buildPage({});
  offPage.sandbox.apiConfigs = [{ id: ACTOR, model: 'm', endpoint: 'http://127.0.0.1:1', apiKey: 'k' }];
  offPage.setState(ACTOR, { nextAt: 1, lastPostAt: 0 });
  offPage.sandbox.window._activeCompanionOnline = false;
  await offPage.tick(1770000000000);
  check('CL36.companionOfflineDesktopOwns',
    offPage.live() === 1 && offPage.stats.modelCalls === 1, { live: offPage.live(), model: offPage.stats.modelCalls });
  const trPage = buildPage({ events: [companionEvent()] });
  trPage.sandbox.apiConfigs = [{ id: ACTOR, model: 'm', endpoint: 'http://127.0.0.1:1', apiKey: 'k' }];
  trPage.setState(ACTOR, { nextAt: 1, lastPostAt: 0 });
  trPage.sandbox.window._activeCompanionOnline = true;
  await trPage.tick(1770000000000);
  trPage.sandbox.window._activeCompanionOnline = false;
  await trPage.tick(1770000000000);
  await trPage.tick(1770000000000 + 60000);
  check('CL37.transitionNoDoublePost', trPage.live() === 1, { live: trPage.live() });

  /* ══════════ E · 边界与冻结守卫（CL38–CL47/CL49/CL50） ══════════ */
  section('E · Boundaries & freeze guards（CL38–CL47/CL49/CL50）');
  check('CL38.noSecondPrefs',
    !/companion_moments_prefs|ib_moments_prefs_companion/.test(stripComments(COMPANION_SRC) + stripComments(MOMENTS_SRC))
    && /ib_moments_prefs_v1/.test(MOMENTS_SRC)
    && /moments_prefs/.test(COMPANION_SRC));
  check('CL39.noDuplicateStore',
    !/duplicateStore|duplicate_store/i.test(stripComments(COMPANION_SRC) + stripComments(MOMENTS_SRC))
    && !/moments_dupe_store/.test(MOMENTS_SRC));
  check('CL40.noMemoryAuthority', !/memoryAuthority|disclosureFacts|getMemoryContext/.test(stripComments(COMPANION_SRC) + adapterSrc + stripComments(MOMENTS_SRC).replace(/recent_memories/g, '')));
  check('CL41.noMiddleBrain', !/middle-brain|middleBrain|astra/i.test(stripComments(COMPANION_SRC) + adapterSrc));
  check('CL42.p23Unchanged', sha256('assets/js/communication.js') === FROZEN_SHA256['assets/js/communication.js']);
  check('CL43.p24Unchanged', sha256('assets/js/group-runtime-core.js') === FROZEN_SHA256['assets/js/group-runtime-core.js']);
  check('CL44.autonomyCoreUnchanged', sha256('assets/js/autonomy-core.js') === FROZEN_SHA256['assets/js/autonomy-core.js']);
  check('CL45.dbVersionUnchangedByClosure',
    /DB_VER=24/.test(read('assets/js/core.js'))
    && /MOMENTS_SCHEMA_VERSION = 1/.test(read('services/home-node/moments-store.js')));
  check('CL46.noNewStore',
    !/createObjectStore/.test(stripComments(read('assets/js/moments.js')))
    /* milestones：Node 侧 store 与 DB 版本都由 P25-2 之外的东西拥有 ——
       它们的 byte 与 schema version 在本阶段保持不变，就是"没有新 store / 没有迁移"的证据。 */
    && sha256('services/home-node/moments-store.js') === 'F7852B44F5941B1E157A6603E52013A63A774052063A553A2938E4BA97F5F6D2'
    && /MOMENTS_SCHEMA_VERSION = 1/.test(read('services/home-node/moments-store.js')));
  check('CL47.noNewQueue',
    !/deferredQueue|momentQueue|pendingQueue/.test(adapterSrc + stripComments(COMPANION_SRC)));
  check('CL49.noAutonomousBypass',
    countOf(stripComments(MOMENTS_SRC), 'runMomentAutonomy(') === 2
    && countOf(stripComments(COMPANION_SRC), 'createMoment(') === 0
    && classified.every(s => s.cls !== 'UNCLASSIFIED'));
  check('CL50.primaryInvariantHolds',
    classified.filter(s => s.cls === 'AUTONOMOUS_CREATE').length === 2
    && classified.filter(s => s.cls === 'AUTONOMOUS_CREATE').every(s => /_momentsWrite(Approved|Companion)Moment/.test(s.fn))
    && genSites.every(s => s.fn === '_momentsLocalTick' || s.fn === '_momentsAskGenerate' || s.fn === 'generateRoleMoment'
      || s.file.indexOf('assets/js/moments.js') === 0),
    classified.map(s => s.cls + ':' + s.fn));

  console.log('\n' + (failed === 0 ? 'ALL PASS' : 'FAILURES: ' + failures.join(', ')));
  console.log('P25-2 closure: ' + passed + ' passed, ' + failed + ' failed');
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((e) => { console.error('suite crashed:', (e && e.stack) || e); process.exitCode = 1; });
