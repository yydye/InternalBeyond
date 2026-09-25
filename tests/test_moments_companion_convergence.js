'use strict';

/* Internal Beyond · P25-2D · Companion Runtime Convergence 测试
   （static 组：纯 Node、零浏览器、零外部网络；运行：
     node tests/test_moments_companion_convergence.js）

   本阶段让 **companion autonomous Moment** 与 **desktop autonomous Moment**
   收敛到同一套权限语义：

     Trigger → Candidate → Semantic Recommendation → Autonomy Decision
             → ALLOW only → Canonical Moment Write

   覆盖 CC1–CC50。真实度：
     · companion 侧跑**真实的** services/active-message-service.js +
       active/moments.js + 共享 semantic core（模型调用打到本机 mock HTTP）；
     · 浏览器侧在 vm 沙箱里加载**真实的** moments.js / semantic core /
       autonomy core / adapter（真实 moments-authority + 真实 canonical store）；
     · 事件由 companion 真实产出，再真实喂给浏览器 ingest（不是手写假事件）。 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const sha256 = f => crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, f))).digest('hex').toUpperCase();

/* companion 状态隔离必须在 require service 之前设置（与 test_moments_companion.js 同法） */
process.env.IB_ACTIVE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-cc-'));
const service = require(path.join(ROOT, 'services', 'active-message-service.js'));

const CHAT_CORE = require(path.join(ROOT, 'assets/js/chat-core.js'));
const VOICE_CORE = require(path.join(ROOT, 'assets/js/voice-message-core.js'));
const MOMENTS_VIS = require(path.join(ROOT, 'assets/js/moments-visibility-core.js'));
const PLAN_DOMAIN = require(path.join(ROOT, 'active', 'plan-domain.js'))({ getState: () => ({}), armedUsers: new Set(), saveNow: () => {} });
const WEBSEM = require(path.join(ROOT, 'assets/js/moments-semantic-core.js'));
const createMomentsAuthority = require(path.join(ROOT, 'assets/js/moments-authority.js')).createMomentsAuthority;
const createMomentsStore = require(path.join(ROOT, 'services', 'home-node', 'moments-store.js'));

const MOMENTS_SRC = read('assets/js/moments.js').replace(/^\uFEFF/, '');
const SEMANTIC_CORE_SRC = read('assets/js/moments-semantic-core.js').replace(/^\uFEFF/, '');
const AUTONOMY_CORE_SRC = read('assets/js/autonomy-core.js').replace(/^\uFEFF/, '');
const AUTONOMY_ADAPTER_SRC = read('assets/js/moments-autonomy.js').replace(/^\uFEFF/, '');

let passed = 0, failed = 0;
const failures = [];
function check(name, cond, extra) {
  if (cond) { passed++; console.log('  \u2714 ' + name); }
  else { failed++; failures.push(name); console.log('  \u2716 ' + name + (extra === undefined ? '' : '  -> ' + JSON.stringify(extra).slice(0, 340))); }
}
function section(title) { console.log('\n── ' + title + ' ──'); }
const stripComments = src => String(src).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const countOf = (src, needle) => String(src).split(needle).length - 1;

const FROZEN_SHA256 = {
  'assets/js/autonomy-core.js': 'FE1011F1DC3434DB6A72A328A63AFEEAE99E1E95762EA910CE379F019F2956F8',
  'assets/js/communication.js': 'DEB568A2F3653009C511BE25753E87AC9EF477FF229BE5CF569EB430AC29184F',
  'assets/js/group-runtime-core.js': '6F30FDE91F518B69B613B74B675B42EB66D227E36C1E18F04A3A1274067B35E8',
  'assets/js/active-diary.js': 'EEAC85AB0CB215723AD641D416606B941C2EBABBE99CB373A6DA1661A6964E26'
};

const ACTOR = 'cc_role';
const v2PostRaw = JSON.stringify({
  recommendation: 'post', reasonCode: 'meaningful-moment', topicKey: 'rainy-window',
  draft: { content: '今天把窗台擦干净了，外面一直在下雨。', visibility: 'all', visibleRoleIds: [], motive: 'daily_life', wantImage: false, imagePrompt: '' }
});

const tempDirs = [];
function tempDir() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ibcc-')); tempDirs.push(dir); return dir; }
process.on('exit', () => { for (const dir of tempDirs) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* ignore */ } } });

/* ══════════ Part A · companion runtime（真实 service + mock 模型）══════════ */
let mockPort = 0;
let mockRequests = 0;
function startMockModel() {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      mockRequests += 1;
      let model = '';
      try { model = String(JSON.parse(body || '{}').model || ''); } catch (_) { /* ignore */ }
      let content;
      if (model === 'c-dec') content = JSON.stringify({ recommendation: 'skip', reasonCode: 'nothing-to-share', topicKey: 'quiet-day' });
      else if (model === 'c-legacy') content = JSON.stringify({ publish: true, content: '旧契约的输出。', visibility: 'all' });
      else if (model === 'c-bad') content = 'not json at all';
      else content = v2PostRaw;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content } }] }));
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })));
}
function companionSnapshot(overrides) {
  return Object.assign({
    character: {
      id: 'c1', provider: 'openai', apiKey: 'sk-mock', model: 'c-ok',
      endpoint: `http://127.0.0.1:${mockPort}/v1/chat/completions`, nickname: '测试角色', relationship: '朋友'
    },
    user: { id: 'u1', name: '用户' },
    recent_memories: [],
    recent_messages: [{ role: 'user', content: '今天加班到很晚', timestamp: Date.now() - 3600000, source: '' }],
    recent_proactive_messages: [],
    chat_summary: '用户今天加班',
    last_interaction_at: Date.now() - 3600000,
    recent_moments: [],
    other_role_moments: [],
    moments_prefs: { enabled: true }
  }, overrides || {});
}
function companionSchedule(characterId, extra) {
  const now = Date.now();
  return Object.assign({
    id: characterId, characterId, user_id: 'u1', enabled: true, frequency: 'low',
    nextAt: now - 1000, lastPostAt: 0, status: 'idle', claimedAt: 0, executionId: '',
    attemptCount: 0, revision: 1, updatedAt: new Date(now - 60000).toISOString(),
    executedAt: null, lastMomentId: '', lastError: '', synced_at: 0
  }, extra || {});
}
async function companionRun(model, charId, scheduleExtra) {
  mockRequests = 0;
  service.resetStateForTest();
  service.setArmed('u1');
  const st = service.getState();
  const snap = companionSnapshot();
  snap.character.model = model;
  const id = charId || 'c1';
  st.moments[id] = Object.assign({}, snap, companionSchedule(id, scheduleExtra));
  const res = await service.executeMomentSchedule(id);
  const events = Object.values(service.getState().events || {}).filter(e => e && e.kind === 'moment');
  return { res, event: events.length ? events[events.length - 1] : null, state: service.getState() };
}

/* ══════════ Part B · browser ingest 沙箱 ══════════ */
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
  const stats = { directPut: 0, directPutBlocked: 0, imageRouter: 0, acks: 0, modelCalls: 0 };
  const stored = new Map();
  const sandbox = {};
  const IB = { expose: function (p, obj) { IB[p] = Object.assign(IB[p] || {}, obj); } };
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
  sandbox._activeUserId = () => 'u1';
  sandbox._ibApiReady = (cfg) => !!(cfg && cfg.endpoint && cfg.model);
  sandbox._activeRecentMemories = () => Promise.resolve([]);
  sandbox._activeRecentProactiveMessages = () => Promise.resolve([]);
  sandbox._activeRecentMessages = () => Promise.resolve([]);
  sandbox._activeTextSimilarity = (a, b) => (String(a) === String(b) ? 1 : 0);
  sandbox._credentialSync = () => Promise.resolve(true);
  sandbox.db = { /* _momentsTick 的 IndexedDB 就绪探针（沙箱里只需要 truthy） */ };
  sandbox.runtimeExecuteEnabled = false;
  sandbox.__pendingEvents = (opts.events || []).slice();
  sandbox.__feedEvents = opts.autoFeed !== false;
  sandbox._activeCompanionRequest = function (p) {
    const target = String(p || '');
    if (target.indexOf('/events/') === 0 && target.indexOf('/ack') > 0) { stats.acks++; return Promise.resolve({ ok: true }); }
    if (target.indexOf('/events') === 0) {
      const list = sandbox.__feedEvents ? sandbox.__pendingEvents.slice() : [];
      sandbox.__pendingEvents = [];
      return Promise.resolve({ ok: true, events: list });
    }
    if (target.indexOf('/health') === 0) return Promise.resolve({ ok: true, moments: 0, reply_chains: true });
    if (target.indexOf('/reconcile') === 0) return Promise.resolve({ ok: true });
    if (target.indexOf('/moments/') === 0) return Promise.resolve({ ok: true, schedule: { decline_streak: 0 } });
    return Promise.resolve({ ok: true });
  };
  sandbox.dbPut = function (store, row) {
    return new Promise((resolve, reject) => {
      if (String(store) !== 'moments') { resolve(undefined); return; }
      stats.directPut++;
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
  sandbox.dbDelete = (store, key) => { rows.delete(String(key)); return Promise.resolve(undefined); };
  sandbox.dbGet = (store, key) => Promise.resolve(rows.get(String(key)) || null);
  sandbox.dbGetAll = () => Promise.resolve(Array.from(rows.values()));
  sandbox.dbGetByIndex = () => Promise.resolve([]);
  sandbox.callApiChat = () => { stats.modelCalls++; return Promise.resolve(v2PostRaw); };
  vm.createContext(sandbox);
  vm.runInContext('(function(){var raw=__ibParsePlanJsonRaw;window._activeParsePlanJson=function(t,o){try{var j=raw(t,o);return j?JSON.parse(JSON.stringify(j)):null}catch(e){return null}};})();', sandbox, { filename: 'parser-bridge.js' });
  vm.runInContext(SEMANTIC_CORE_SRC, sandbox, { filename: 'moments-semantic-core.js' });
  vm.runInContext(AUTONOMY_CORE_SRC, sandbox, { filename: 'autonomy-core.js' });
  vm.runInContext(AUTONOMY_ADAPTER_SRC, sandbox, { filename: 'moments-autonomy.js' });
  vm.runInContext(MOMENTS_SRC, sandbox, { filename: 'moments.js' });
  sandbox.loadMomentsPage = function () {};
  const spy = { autonomy: 0 };
  const adapter = sandbox.IBMomentsAutonomy;
  const origRun = adapter.runMomentAutonomy;
  adapter.runMomentAutonomy = function (i, d) { spy.autonomy++; return origRun(i, d); };
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
    sandbox: sandbox, stats: stats, spy: spy, store: store,
    setState: (roleId, patch) => {
      const all = JSON.parse(stored.get('ib_moments_state_v1') || '{}');
      all[roleId] = Object.assign({}, all[roleId] || {}, patch);
      stored.set('ib_moments_state_v1', JSON.stringify(all));
    },
    getState: (roleId) => JSON.parse(stored.get('ib_moments_state_v1') || '{}')[roleId] || {},
    live: () => (store ? store.countLive() : rows.size),
    canonicalIds: () => (store ? store.listRecords({ limit: 50 }).records.map(r => r.id) : Array.from(rows.keys())),
    ingest: (ev) => sandbox.window._momentsIngestEvent(ev, 'u1'),
    tick: (now) => sandbox.window._momentsTick(now)
  };
}
function companionEvent(patch) {
  const p = patch || {};
  const draft = Object.assign({ content: '今天把窗台擦干净了，外面一直在下雨。', visibility: 'all', visibleRoleIds: [], motive: 'daily_life', wantImage: false, imagePrompt: '' }, p.draft || {});
  const ev = {
    id: p.id || 'evt_cc_1', kind: 'moment', run_id: 'moment_run_cc', moment_id: 'mom_provisional',
    user_id: 'u1', character_id: ACTOR, actor_id: ACTOR, character_name: '测试角色',
    scheduled_for: 1770000000000, slot_at: 1770000000000, sent_at: 1770000000000,
    status: 'moment_sent', source: 'schedule', trigger_ref: 'companion:1770000000000',
    semantic_contract: WEBSEM.CONTRACT_ID, recommendation: 'post', reason_code: 'meaningful-moment',
    topic_key: 'rainy-window', topic_fingerprint: WEBSEM.momentTopicFingerprint('rainy-window'),
    draft: draft, next_at: 1770000000000 + 3600000, last_post_at: 1770000000000, decline_streak: 0
  };
  if ('recommendation' in p) ev.recommendation = p.recommendation;
  ev.moment = {
    id: 'mom_provisional', roleId: ACTOR, content: draft.content, images: [], visibility: draft.visibility,
    visibleRoleIds: [], likes: [], comments: [], source: 'proactive', motive: draft.motive,
    createdAt: new Date(1770000000000).toISOString()
  };
  return ev;
}
function legacyEvent(mutate) {
  const ev = companionEvent();
  delete ev.recommendation;
  delete ev.reason_code;
  delete ev.topic_key;
  delete ev.topic_fingerprint;
  delete ev.draft;
  delete ev.semantic_contract;
  ev.want_image = false;
  ev.image_prompt = '';
  if (typeof mutate === 'function') mutate(ev);
  return ev;
}

async function main() {
  console.log('== P25-2D · Companion Runtime Convergence 测试 ==');
  const mock = await startMockModel();
  mockPort = mock.port;
  const readyCfg = { id: ACTOR, nickname: 'N', model: 'm1', provider: 'openai', endpoint: `http://127.0.0.1:${mockPort}/v1/chat/completions`, apiKey: 'k', imageGen: true };

  /* ══════════ A · companion 只产生候选 ══════════ */
  section('A · Companion = candidate producer（CC1/CC2/CC9/CC10/CC11/CC21–CC23/CC34/CC35）');
  const a1 = await companionRun('c-ok');
  const ev1 = a1.event;
  check('CC1.companionTriggerProducesCandidate',
    !!ev1 && ev1.recommendation === 'post' && ev1.reason_code === 'meaningful-moment'
    && !!ev1.topic_key && /^mt_[0-9a-z]+$/.test(String(ev1.topic_fingerprint))
    && !!ev1.draft && ev1.draft.content.indexOf('窗台') >= 0
    && ev1.semantic_contract === WEBSEM.CONTRACT_ID,
    ev1 && { rec: ev1.recommendation, rc: ev1.reason_code, tk: ev1.topic_key });
  check('CC2.companionEventIsNotPermission',
    !!ev1 && a1.res.published === true
    && countOf(stripComments(read('active/moments.js')), 'createMoment(') === 0
    && countOf(stripComments(read('active/moments.js')), '_momentsWriteCanonical') === 0
    && !/permission|\ballow\b/.test(String(ev1.status)));
  check('CC9.normalCandidateOneModelCall', mockRequests === 1, { requests: mockRequests });
  const a2 = await companionRun('c-bad');
  check('CC10.malformedRetryBounded',
    a2.res.published !== true && mockRequests <= 2 && !a2.event, { requests: mockRequests, res: a2.res });
  const ccSlot = Date.now() - 1000;
  const a3 = await companionRun('c-ok', 'c1', { nextAt: ccSlot });
  const a4 = await companionRun('c-ok', 'c1', { nextAt: ccSlot });
  check('CC21.stableTriggerRef',
    !!a3.event && !!a4.event && a3.event.trigger_ref === a4.event.trigger_ref
    && a3.event.trigger_ref === 'companion:' + ccSlot, a3.event && a3.event.trigger_ref);
  check('CC22.noClockInCompanionIdentity',
    a3.event.slot_at === Number(a3.event.trigger_ref.split(':')[1])
    && /trigger_ref: `companion:\$\{Number\(due\) \|\| 0\}`/.test(read('active/moments.js')));
  check('CC23.noRandomInCompanionIdentity',
    /topic_fingerprint: parsed\.recommendation\.topicFingerprint/.test(read('active/moments.js'))
    && !/topic_fingerprint:.*Math\.random/.test(read('active/moments.js')));
  const evJson = JSON.stringify(ev1);
  check('CC34.eventHasNoProviderSecrets',
    !/apiKey|sk-|Authorization|Bearer|endpoint|systemPrompt|credential/i.test(evJson),
    evJson.slice(0, 200));
  check('CC35.eventHasNoCoT',
    !/thinking|cot|reasoning|analysis|rationale|explanation|scratchpad/i.test(evJson));
  const a5 = await companionRun('c-dec');
  check('CC11.skipNoEventNoMoment',
    a5.res.published === false && !a5.event && a5.res.reasonCode === 'nothing-to-share'
    && Number(a5.state.moments.c1.declineStreak) === 1,
    { res: a5.res, streak: a5.state.moments.c1.declineStreak });
  const a6 = await companionRun('c-legacy');
  check('CC3b.legacyCompanionOutputStillProjects',
    !!a6.event && a6.event.recommendation === 'post' && !!a6.event.topic_fingerprint
    && a6.event.draft.content === '旧契约的输出。');

  /* ══════════ B · 浏览器 ingest = final authority ══════════ */
  section('B · Browser ingest = final authority（CC2b/CC2c/CC11b/CC13/CC17–CC20/CC46/CC47）');
  const b1 = buildPage({ canonical: true });
  b1.sandbox.apiConfigs = [readyCfg];
  const ingest1 = await b1.ingest(companionEvent());
  const ids1 = b1.canonicalIds();
  check('CC17.postAllowWritesOneMoment',
    ingest1 === true && b1.live() === 1 && b1.spy.autonomy === 1 && ids1.length === 1
    && /^mom_/.test(String(ids1[0])), { live: b1.live(), ids: ids1 });
  /* 同一 candidate（同 actor/trigger/topic，**措辞不同**）⇒ 同一个 Moment id：
     换措辞不换身份，也不产生第二行。 */
  const altEv = companionEvent({ id: 'evt_cc_alt' });
  altEv.draft = Object.assign({}, altEv.draft, { content: '窗外还在下雨，我把窗台擦干净了。' });
  altEv.moment = Object.assign({}, altEv.moment, { content: altEv.draft.content });
  const ingestAlt = await b1.ingest(altEv);
  check('CC20.sameCandidateSameMomentId',
    ingestAlt === false && b1.live() === 1 && JSON.stringify(b1.canonicalIds()) === JSON.stringify(ids1),
    { ids: b1.canonicalIds(), alt: ingestAlt });
  const ingest1b = await b1.ingest(companionEvent());
  check('CC19.sameEventReplayOneMoment',
    ingest1b === false && b1.live() === 1 && b1.stats.acks >= 1, { live: b1.live(), second: ingest1b });
  check('CC46.homeNodeCanonicalWriteWorks',
    b1.live() === 1 && b1.stats.directPutBlocked === 0 && b1.stats.acks >= 2);
  check('CC47.companionWriteCannotBypassAutonomy',
    b1.spy.autonomy >= 1 && countOf(stripComments(read('active/moments.js')), 'createMoment(') === 0);
  const b2 = buildPage({});
  b2.sandbox.apiConfigs = [readyCfg];
  const ingest2 = await b2.ingest(companionEvent({ recommendation: 'skip', reason_code: 'nothing-to-share' }));
  check('CC11b.structuredSkipConsumedWithoutWrite',
    ingest2 === false && b2.live() === 0 && b2.stats.imageRouter === 0 && b2.stats.acks === 1);
  const b3 = buildPage({});
  b3.sandbox.apiConfigs = [readyCfg];
  b3.sandbox.localStorage.setItem('ib_moments_prefs_v1', JSON.stringify({ enabled: true, autoPublish: false, frequency: 'medium' }));
  const ingest3 = await b3.ingest(companionEvent());
  check('CC13.policyDenyNoMoment',
    ingest3 === false && b3.live() === 0 && b3.spy.autonomy === 1 && b3.stats.imageRouter === 0 && b3.stats.acks === 1);
  const b5 = buildPage({});
  b5.sandbox.apiConfigs = [readyCfg];
  const ingest5 = await b5.ingest(legacyEvent());
  check('CC2b.legacyEnvelopeStillGatedByAutonomy',
    ingest5 === true && b5.live() === 1 && b5.spy.autonomy === 1, { live: b5.live(), autonomy: b5.spy.autonomy });
  const b6 = buildPage({});
  b6.sandbox.apiConfigs = [readyCfg];
  const ingest6 = await b6.ingest(companionEvent({ recommendation: 'allow' }));
  check('CC2c.unknownRecommendationInEventDenied',
    ingest6 === false && b6.live() === 0 && b6.stats.acks === 1);
  const b7 = buildPage({});
  b7.sandbox.apiConfigs = [readyCfg];
  const ingest7 = await b7.ingest(legacyEvent((ev) => { ev.moment.content = '   '; }));
  check('CC2d.emptyLegacyEventDenied', ingest7 === false && b7.live() === 0);
  check('CC18.imageOnlyAfterAllow', await (async () => {
    const imgDraft = { content: '今天看到一只很奇怪的猫。', visibility: 'all', visibleRoleIds: [], motive: 'daily_life', wantImage: true, imagePrompt: 'a strange cat' };
    const pAllow = buildPage({});
    pAllow.sandbox.apiConfigs = [readyCfg];
    const ok = await pAllow.ingest(companionEvent({ draft: imgDraft }));
    const pDeny = buildPage({});
    pDeny.sandbox.apiConfigs = [readyCfg];
    pDeny.sandbox.localStorage.setItem('ib_moments_prefs_v1', JSON.stringify({ enabled: true, autoPublish: false, frequency: 'medium' }));
    await pDeny.ingest(companionEvent({ draft: imgDraft }));
    const pSkip = buildPage({});
    pSkip.sandbox.apiConfigs = [readyCfg];
    await pSkip.ingest(companionEvent({ recommendation: 'skip', reason_code: 'nothing-to-share', draft: imgDraft }));
    return ok === true && pAllow.stats.imageRouter >= 1 && pAllow.live() === 1
      && pDeny.stats.imageRouter === 0 && pDeny.live() === 0
      && pSkip.stats.imageRouter === 0 && pSkip.live() === 0;
  })());
  const b8 = buildPage({});
  b8.sandbox.apiConfigs = [readyCfg];
  b8.setState(ACTOR, { lastPostAt: Date.now() - 5 * 60000 });
  const ingest8 = await b8.ingest(companionEvent());
  check('CC27.cooldownConvergedDeniesWithoutWrite',
    ingest8 === false && b8.live() === 0 && b8.stats.imageRouter === 0
    && /cooldownMs:MOMENT_MIN_INTERVAL/.test(read('assets/js/moments.js'))
    && /MOMENT_MIN_INTERVAL = 45 \* 60000/.test(read('active/moments.js')));

  /* ══════════ C · one shared contract ══════════ */
  section('C · One shared semantic contract（CC3–CC8/CC24–CC26/CC36–CC38）');
  const companionSrc = read('active/moments.js');
  check('CC3.semanticContractSameAsDesktop',
    /require\('\.\.\/assets\/js\/moments-semantic-core\.js'\)/.test(companionSrc)
    && /SEMANTIC\.semanticOutputSchema\(\)/.test(companionSrc)
    && /SEMANTIC\.parseMomentSemanticOutput\(/.test(companionSrc)
    && /SEMANTIC\.forbiddenFieldsSentence\(\)/.test(companionSrc)
    && /SEMANTIC\.semanticCorrectionNote\(/.test(companionSrc));
  check('CC4.reasonCodeVocabularySame',
    /moments-semantic-core/.test(read('assets/js/moments.js'))
    && !/scheduled-window|character-impulse|no-material/.test(companionSrc));
  const cp = (obj) => service.parseMomentSemantic(JSON.stringify(obj));
  const dp = (obj) => WEBSEM.parseMomentSemanticOutput(JSON.stringify(obj), { parseJson: PLAN_DOMAIN.parsePlanJson });
  check('CC5.topicNormalizationSame',
    cp({ recommendation: 'post', reasonCode: 'meaningful-moment', topicKey: ' Rainy  Window ', draft: { content: 'y', visibility: 'all' } }).recommendation.topicKey
      === dp({ recommendation: 'post', reasonCode: 'meaningful-moment', topicKey: ' Rainy  Window ', draft: { content: 'y', visibility: 'all' } }).recommendation.topicKey
    && cp({ recommendation: 'post', reasonCode: 'meaningful-moment', topicKey: '正文当话题', draft: { content: '正文当话题。' } }).ok
      === dp({ recommendation: 'post', reasonCode: 'meaningful-moment', topicKey: '正文当话题', draft: { content: '正文当话题。' } }).ok);
  check('CC6.topicFingerprintSemanticsSame',
    cp({ recommendation: 'post', reasonCode: 'meaningful-moment', topicKey: 'rainy-window', draft: { content: 'a', visibility: 'all' } }).recommendation.topicFingerprint
      === dp({ recommendation: 'post', reasonCode: 'meaningful-moment', topicKey: 'rainy-window', draft: { content: 'b', visibility: 'all' } }).recommendation.topicFingerprint
    && cp({ recommendation: 'post', reasonCode: 'meaningful-moment', topicKey: 'sunny-balcony', draft: { content: 'a', visibility: 'all' } }).recommendation.topicFingerprint
      !== cp({ recommendation: 'post', reasonCode: 'meaningful-moment', topicKey: 'rainy-window', draft: { content: 'a', visibility: 'all' } }).recommendation.topicFingerprint);
  check('CC7.draftContractSame',
    cp({ recommendation: 'post', reasonCode: 'meaningful-moment', topicKey: 'k', draft: { content: 'x', visibility: 'everyone' } }).ok === false
    && dp({ recommendation: 'post', reasonCode: 'meaningful-moment', topicKey: 'k', draft: { content: 'x', visibility: 'everyone' } }).ok === false
    && cp({ recommendation: 'post', reasonCode: 'meaningful-moment', topicKey: 'k', draft: { content: 'x', visibility: 'roles', visibleRoleIds: [] } }).error
      === dp({ recommendation: 'post', reasonCode: 'meaningful-moment', topicKey: 'k', draft: { content: 'x', visibility: 'roles', visibleRoleIds: [] } }).error
    && cp({ recommendation: 'post', reasonCode: 'nope', topicKey: 'k', draft: { content: 'x' } }).error
      === dp({ recommendation: 'post', reasonCode: 'nope', topicKey: 'k', draft: { content: 'x' } }).error);
  check('CC8.cotForbiddenSame',
    cp({ recommendation: 'post', reasonCode: 'meaningful-moment', topicKey: 'k', draft: { content: 'x', visibility: 'all' }, thinking: 'why' }).stage
      === dp({ recommendation: 'post', reasonCode: 'meaningful-moment', topicKey: 'k', draft: { content: 'x', visibility: 'all' }, thinking: 'why' }).stage
    && cp({ recommendation: 'post', reasonCode: 'meaningful-moment', topicKey: 'k', draft: { content: 'x', visibility: 'all' }, thinking: 'why' }).ok === false);
  check('CC24.prefsUseCanonicalAuthority',
    /moments_prefs/.test(companionSrc)
    && !/companion_moments_prefs|ib_moments_prefs_companion/.test(companionSrc + read('assets/js/moments.js'))
    && /prefs: \{ aiComment/.test(read('assets/js/moments.js')));
  check('CC25.historyUsesCanonicalMoments',
    /readRecentOwnMoments:\(id,limit\)=>_momentsRecentOwn\(id,limit\)/.test(read('assets/js/moments.js'))
    && /recent_moments/.test(companionSrc));
  check('CC26.noDuplicateStore',
    !/duplicateStore|duplicate_store|new store/i.test(companionSrc)
    && !/moments_dupe_store/.test(read('assets/js/moments.js')));
  check('CC28.frequencySemanticsPreserved',
    /MOMENT_FREQ = \{/.test(companionSrc) && /advanceNext\(schedule, now\)/.test(companionSrc)
    && /MOMENT_MIN_INTERVAL = 45 \* 60000/.test(companionSrc));
  check('CC36.adapterRemainsModelFree',
    !/generateRoleMoment|_momentsModelCall|callApiChat|fetch\(/.test(stripComments(read('assets/js/moments-autonomy.js'))));
  /* 顶层函数切片：从 `function NAME(`（可带 async）到**下一个**顶层 function 声明。 */
  const fnBody = (name) => {
    const body = stripComments(MOMENTS_SRC);
    let start = body.indexOf('async function ' + name + '(');
    if (start < 0) start = body.indexOf('function ' + name + '(');
    if (start < 0) return '';
    const a = body.indexOf('\nasync function ', start + 1);
    const b = body.indexOf('\nfunction ', start + 1);
    const candidates = [a, b].filter(i => i > start);
    const end = candidates.length ? Math.min.apply(null, candidates) : body.length;
    return body.slice(start, end);
  };
  check('CC37.semanticLayerWriterFree', !/createMoment\(|_momentsWriteCanonical|dbPut\(/.test(fnBody('evaluateRoleMomentSemantic')));
  check('CC38.executorPolicyFree', !/recommendation|reasonCode|cooldown|decide\(|prefs/.test(fnBody('_momentsWriteApprovedMoment')));

  /* ══════════ D · ownership / manual ══════════ */
  section('D · Ownership & manual paths（CC29–CC33）');
  const d1 = buildPage({ events: [companionEvent()] });
  d1.sandbox.apiConfigs = [readyCfg];
  d1.setState(ACTOR, { nextAt: 1, lastPostAt: 0 });
  d1.sandbox.window._activeCompanionOnline = true;
  await d1.tick(1770000000000);
  check('CC29.companionOnlineDesktopYields',
    d1.live() === 1 && d1.stats.modelCalls === 0 && d1.stats.acks === 1 && !!d1.getState(ACTOR).lastMomentId,
    { live: d1.live(), model: d1.stats.modelCalls, st: d1.getState(ACTOR) });
  const d2 = buildPage({});
  d2.sandbox.apiConfigs = [readyCfg];
  d2.setState(ACTOR, { nextAt: 1, lastPostAt: 0 });
  d2.sandbox.window._activeCompanionOnline = false;
  await d2.tick(1770000000000);
  check('CC30.companionOfflineDesktopResumes',
    d2.live() === 1 && d2.stats.modelCalls === 1, { live: d2.live(), model: d2.stats.modelCalls });
  const d3 = buildPage({ events: [companionEvent()] });
  d3.sandbox.apiConfigs = [readyCfg];
  d3.setState(ACTOR, { nextAt: 1, lastPostAt: 0 });
  d3.sandbox.window._activeCompanionOnline = true;
  await d3.tick(1770000000000);
  d3.sandbox.window._activeCompanionOnline = false;
  await d3.tick(1770000000000);
  await d3.tick(1770000000000 + 60000);
  check('CC31.onlineOfflineTransitionNoDoublePost',
    d3.live() === 1, { live: d3.live(), st: d3.getState(ACTOR), model: d3.stats.modelCalls });
  const d4 = buildPage({});
  d4.sandbox.apiConfigs = [readyCfg];
  const manual = JSON.parse(JSON.stringify(await d4.sandbox.window.createMoment({ authorType: 'user', authorId: 'u1', content: '我自己发的。', source: 'manual', visibility: 'all' })));
  check('CC32.manualComposerZeroAutonomy',
    manual.ok === true && d4.live() === 1 && d4.spy.autonomy === 0 && d4.stats.modelCalls === 0);
  const d5 = buildPage({});
  d5.sandbox.apiConfigs = [readyCfg];
  const askTa = JSON.parse(JSON.stringify(await d5.sandbox.window.generateRoleMoment(ACTOR, { trigger: 'manual' })));
  check('CC33.askTaStillGoesThroughAutonomy',
    askTa.ok === true && askTa.published === true && d5.spy.autonomy === 1 && d5.live() === 1);

  /* ══════════ E · guards / enumeration ══════════ */
  section('E · Guards / production path enumeration（CC39–CC45/CC49/CC50）');
  check('CC39.autonomyCoreUnchanged', sha256('assets/js/autonomy-core.js') === FROZEN_SHA256['assets/js/autonomy-core.js']);
  check('CC40.p23Unchanged', sha256('assets/js/communication.js') === FROZEN_SHA256['assets/js/communication.js']);
  check('CC41.p24Unchanged', sha256('assets/js/group-runtime-core.js') === FROZEN_SHA256['assets/js/group-runtime-core.js']);
  check('CC42.noMemoryRefs',
    /* 只认**代码级** Memory 权威/私有披露接入；prompt 文案里的"不要暴露 Memory"是
       既有的反泄漏指令，快照里的 recent_memories 也只是浏览器已经决定给出的上下文。 */
    !/memoryAuthority|disclosureFacts|getMemoryContext|dbGet\('memories'/.test(stripComments(companionSrc))
    && !/memoryAuthority|disclosureFacts/.test(stripComments(read('assets/js/moments-autonomy.js')))
    && !/memoryAuthority|disclosureFacts/.test(stripComments(MOMENTS_SRC)));
  check('CC43.noMiddleBrainRefs',
    !/middle-brain|middleBrain|astra/i.test(stripComments(companionSrc) + stripComments(MOMENTS_SRC)));
  check('CC44.mutationAuthorityUntouched',
    countOf(stripComments(MOMENTS_SRC), 'await dbPut(MOMENT_STORE,m);') >= 4
    && countOf(stripComments(MOMENTS_SRC), 'dbDelete(MOMENT_STORE,id);') === 1
    && /likeMoment|addMomentComment|deleteMomentComment/.test(MOMENTS_SRC));
  check('CC45.canonicalWriterStillUnique',
    countOf(stripComments(MOMENTS_SRC), 'function createMoment(') === 1
    && countOf(stripComments(MOMENTS_SRC), 'await _momentsWriteCanonical(') === 1
    && countOf(stripComments(MOMENTS_SRC), 'hn.put(m,') === 1);
  check('CC49.allAutonomousPathsEnumerateToAutonomy',
    /runMomentAutonomy\(finalized\.candidate,deps\)/.test(stripComments(MOMENTS_SRC))
    && countOf(stripComments(MOMENTS_SRC), 'await _momentsRunAutonomousPost(') === 1
    && countOf(stripComments(companionSrc), 'createMoment(') === 0
    && countOf(stripComments(companionSrc), '_momentsWriteCanonical') === 0
    && !/dbPut\(/.test(stripComments(companionSrc)));
  check('CC50.noSecondPermissionAuthority', (() => {
    /* 权限判定只允许存在于浏览器 Autonomy 一侧：companion 的 **Moment 创建路径**
       （executeMomentSchedule）不再有 `parsed.publish` 这类许可判定。
       回复链（评论）仍用它自己的旧契约 —— 评论 autonomy 在本阶段明确禁止触碰，
       因此这里只统计创建路径，不误报。 */
    const body = stripComments(companionSrc);
    const start = body.indexOf('async function executeMomentSchedule(');
    const end = body.indexOf('async function momentsTick(', start + 1);
    const createPath = (start >= 0 && end > start) ? body.slice(start, end) : '';
    return !/parsed\.publish|publish\s*!==\s*true/.test(createPath)
      /* 设备面（mobile-gateway）只有读 verb（moments/list、moments/visible）：任何写
         verb 都不存在 —— 断言的是"没有创建/写入调用"，不是"文件里没有这个词"
         （`createMomentsRetrieval` 这类读侧工厂是合法的）。 */
      && !/\bcreateMoment\s*\(|_momentsWriteCanonical/.test(stripComments(read('services/home-node/mobile-gateway.js')))
      && createPath.length > 0;
  })());

  console.log('\n' + (failed === 0 ? 'ALL PASS' : 'FAILURES: ' + failures.join(', ')));
  console.log('P25-2D · companion convergence: ' + passed + ' passed, ' + failed + ' failed');
  try { mock.server.close(); } catch (_) { /* ignore */ }
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((e) => { console.error('suite crashed:', (e && e.stack) || e); process.exitCode = 1; });
