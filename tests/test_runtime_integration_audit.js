'use strict';

// Read-only runtime audit regression probes. No production data, external APIs,
// browsers or scheduler startup. Execute actual source functions, never copies.
// These assertions describe required integration invariants; known bugs stay red.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

/* Repository root — this file lives in tests/, so the root is one level up. */
const ROOT = path.resolve(__dirname, '..');
const createHttp = require(path.join(ROOT, 'active', 'http.js'));

const source = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
/* moments.js 的模块级常量：审计只抽取**函数片段**，因此这些常量必须显式提供。
   从源码推导而不是手抄 —— 否则两端的 45 分钟会悄悄漂移。 */
const MOMENT_MIN_INTERVAL = (() => {
  const m = /const MOMENT_MIN_INTERVAL\s*=\s*(\d+)\s*\*\s*60000/.exec(source('assets/js/moments.js'));
  assert.ok(m, 'MOMENT_MIN_INTERVAL boundary missing');
  return Number(m[1]) * 60000;
})();
function fragment(file, begin, end) {
  const text = source(file), start = text.indexOf(begin);
  assert.ok(start >= 0, 'source boundary missing: ' + begin);
  const stop = text.indexOf(end, start + begin.length);
  assert.ok(stop > start, 'source boundary missing: ' + end);
  return text.slice(start, stop);
}
const active = 'assets/js/active-diary.js', moments = 'assets/js/moments.js';
const consumers = fragment(active, 'async function _activePullCompanionEvents(){', 'function initActiveMessages(){')
  /* P25-2D：ingest 现在必须经 Autonomy（事件不是许可）。它依赖的两个 helper
     （_momentsCompanionSemantic / _momentsWriteCompanionMoment）定义在 ingest 之前，
     因此审计片段必须**从这里开始**，否则片段自身缺函数。 */
  + fragment(moments, 'function _momentsCompanionSemantic(ev,moment){', '/* 浏览器本地执行');
  /* P25-3C：Active Message 的 canonical 写入已收敛为唯一 writer `_activeWriteCanonical`
     （companion 事件是投递镜像，经它落库且 effects:false）；片段必须包含它，
     否则沙箱里的 ingest 会因为"调用了不存在的外部函数"而失败。 */
const activeWriter = fragment(active, 'async function _activeWriteCanonical(msg,opts){', '/* 唯一裁决入口');
const sync = fragment(moments, 'async function _momentsSyncCompanion(){', '/* 事件回传落库');
/* Phase 4：consolidation 的模型执行已收敛到 _activeConsolidationModelCall 接缝，
   片段必须包含接缝本身（其依赖的 gate/instance/format/telemetry 在下方注入为最小替身）。 */
const consolidation = fragment(active, 'async function _activeConsolidationModelCall(cfg,messages,opts){', 'var _consolidationWaterline=');

function environment(request) {
  const stores = new Map();
  const table = name => { if (!stores.has(name)) stores.set(name, new Map()); return stores.get(name); };
  const cfg = { id: 'role-a', provider: 'custom', model: 'audit-model', endpoint: 'http://127.0.0.1:1', systemPrompt: 'Audit role' };
  const context = {
    console, setTimeout, clearTimeout, Date, Map, Set, apiConfigs: [cfg], archivedConfigs: [],
    ACTIVE_SETTINGS_STORE: 'settings', ACTIVE_HISTORY_STORE: 'history', ACTIVE_PLANS_STORE: 'plans', MOMENT_STORE: 'moments',
    MOMENT_MIN_INTERVAL: MOMENT_MIN_INTERVAL,
    currentPage: '', activeFriendId: '', _activeCompanionOnline: true,
    _activeUserId: () => 'audit-user', _activeCompanionRequest: request,
    dbGetAll: async name => [...table(name).values()], dbGet: async (name, id) => table(name).get(id),
    dbPut: async (name, row) => { assert.ok(row.id, 'row id required'); table(name).set(row.id, structuredClone(row)); },
    getMoment: async id => table('moments').get(id),
    _activeRunId: (id, at) => 'run_' + id + '_' + at, _activeMessageId: (id, at) => 'msg_' + id + '_' + at,
    _activeSetServiceStatus() {}, _activeProactiveLog() {}, _activeNotify() {}, _markUnread() {}, updateChatStorageInfo() {},
    _momentsState: () => ({}), _momentsSetState() {}, _momentsDefaults: x => x,
    _obsRec() {}, _momentsMaybeLike() {}, _momentsMaybeComment() {}, _momentsMaybeMention() {},
    _ibApiReady: () => true, _momentsCfg: () => cfg,
    /* P25-2D：ingest 的裁决链依赖（真实语义核 + 真实 Autonomy adapter；见下面 runInContext）。
       这里只做"接缝替身"：语义核 / adapter 都是**真实实现**，createMoment 落进审计表。 */
    _momentsSemanticCore: () => context.IBMomentsSemanticCore,
    _momentsAutonomyAdapter: () => context.IBMomentsAutonomy,
    /* P25-2.5：mutation 现在也必须过 Mutation Authority（点赞/评论/回复/删除）。
       审计片段只抽函数，因此这两个接缝在这里注入；decision 仍由**真实模块**做。 */
    _momentsMutationAuthority: () => context.IBMomentsMutationAuthority,
    _momentsRunMutation: (mutation, facts, executor) => context.IBMomentsMutationAuthority.runMomentMutation(mutation, facts, executor),
    _momentsMutationFacts: (m, extra) => {
      const e = extra || {};
      const actorId = String(e.actorId || '');
      const authorId = m ? String(m.roleId || m.authorId || '') : '';
      const comment = e.comment || null;
      return {
        actorKnown: true,
        momentExists: !!m,
        momentAuthorKind: ((m && m.authorType) === 'user') ? 'user' : 'role',
        momentAuthorId: authorId,
        actorIsMomentAuthor: e.isUserActor === true ? ((m && m.authorType) === 'user') : (!!m && actorId === authorId),
        commentExists: !!comment,
        commentAuthorId: comment ? String(comment.authorId || '') : '',
        actorIsCommentAuthor: !!comment && String(comment.authorId || '') === actorId,
        actorCanSeeMoment: e.canSeeMoment !== false,
        duplicateComment: e.duplicateComment === true
      };
    },
    /* 不注入 parseJson：让语义核用 context 内的 _activeParsePlanJson（realm-local，
       见 environment() 末尾）—— 跨 realm 的 JSON.parse 会产出"不是本 realm 的普通对象"，
       而 parser 的 isPlainObject 会正确拒绝它。 */
    _momentsParseSemantic: (raw) => context.IBMomentsSemanticCore.parseMomentSemanticOutput(raw),
    _momentsRecentOwn: async () => [],
    _momentsMakeImage: async () => [],
    createMoment: async (data, options) => {
      const id = (options && options.id) || data.id;
      assert.ok(id, 'createMoment id required');
      table('moments').set(id, structuredClone(Object.assign({}, data, { id })));
      return { ok: true, moment: Object.assign({}, data, { id }) };
    },
    _momentsCompanionBrokenAt: 0, _momentsLastSyncAt: 0, _momentsReownTried: {},
    _momentsPrefs: () => ({ enabled: true, autoPublish: true, frequency: 'medium' }),
    _momentsFreqMs: () => 3600000,
    _momentsCompanionSnapshot: async () => ({ character: cfg }),
    _activeParsePlanJson: JSON.parse, _activeTextSimilarity: () => 0,
    /* Phase 4 接缝依赖的最小替身：审计环境无 IB.runtime → 接缝走 direct 回退（仍调用真实 callApiChat 桩） */
    _activeRuntimeInstance: () => null, _activeRuntimeGate: () => true,
    _activeModelFormat: () => 'openai', _activeRuntimeTelemetry: (consumer, data) => data,
    quickCreateMemory: async row => { row = { ...row, id: 'semantic-a' }; table('memories').set(row.id, row); return row.id; }
  };
  context.window = context;
  vm.createContext(context);
  /* M1-C.2d Wave 1：memory 可见性语义的唯一实现已提取到 memory-visibility-core.js。
     memory.js 现在是委托方，因此这里注入**同一份真实实现**，而不是复制一套判断。 */
  context.IBMemoryVisibilityCore = require(path.join(ROOT, 'assets', 'js', 'memory-visibility-core.js'));
  /* P25-2D：把**真实的**语义核、Autonomy Core、Moments adapter 装进审计环境 ——
     审计因此验证的是"事件必须经 Autonomy"这条真实行为，而不是一份替身策略。 */
  context.IBChatCore = require(path.join(ROOT, 'assets', 'js', 'chat-core.js'));
  context.IBVoiceMessage = require(path.join(ROOT, 'assets', 'js', 'voice-message-core.js'));
  context.IBMomentsVisibilityCore = require(path.join(ROOT, 'assets', 'js', 'moments-visibility-core.js'));
  /* 三个 UMD 模块整体装入（它们各自的 UMD 分支在无 module 的环境走 browser 分支，
     把实例挂到本 context 的 IB* 名字上）。 */
  ['assets/js/moments-semantic-core.js', 'assets/js/autonomy-core.js', 'assets/js/moments-autonomy.js',
    'assets/js/moments-mutation-authority.js']
    .forEach(f => vm.runInContext(source(f).replace(/^\uFEFF/, ''), context, { filename: f }));
  /* realm-local 的 JSON 提取器：与审计环境里的 _activeParsePlanJson 契约一致，
     但由本 context 自己的 JSON 产出对象（跨 realm 对象会被 parser 判为非 plain）。 */
  vm.runInContext('window._activeParsePlanJson = function (text) { try { return JSON.parse(String(text)); } catch (e) { return null; } };', context, { filename: 'audit-parse-json.js' });
  /* realm-local 的偏好读取器：adapter 的 policy 会对 prefs 做 isPlainObject 校验，
     跨 realm 对象会被正确拒绝 —— 因此这个桩必须在 context 内定义。 */
  vm.runInContext('window._momentsPrefs = function () { return { enabled: true, autoPublish: true, frequency: "medium" }; };', context, { filename: 'audit-prefs.js' });
  /* 注入真实的可见性函数，使 memory 相关断言按当前 schema 语义成立（而非依赖缺失时的旁路） */
  vm.runInContext(fragment('assets/js/memory.js', 'function _ibMemVisCore(', '/* --- 语义相关性'), context);
  return { context, table, cfg };
}

let failures = 0;
async function check(name, fn) {
  try { await fn(); console.log('PASS ' + name); }
  catch (e) { failures++; console.error('FAIL ' + name + ': ' + e.message); }
}
(async () => {
  const state = { events: {}, history: {}, tasks: {}, plans: {}, moments: {} };
  const { server } = createHttp({ HOST: '127.0.0.1', PORT: 0, maxBody: 100000,
    getState: () => state, armedUsers: new Set(), queueSave() {}, saveNow() {},
    recordUserId: row => String(row.user_id || '') });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const request = async (url, opts = {}) => {
    const response = await fetch(base + url, { method: opts.method || 'GET', headers: { 'Content-Type': 'application/json' },
      body: opts.body == null ? undefined : JSON.stringify(opts.body) });
    assert.ok(response.ok, 'HTTP ' + response.status);
    return response.json();
  };
  try {
    await check('Active messages still import and ACK through real HTTP', async () => {
      state.events = { a: { id: 'a', user_id: 'audit-user', character_id: 'role-a', status: 'sent', content: 'Hello', message_id: 'a-msg', run_id: 'a-run', sent_at: 1 } };
      const { context, table } = environment(request); vm.runInContext(activeWriter + consumers, context);
      await context._activePullCompanionEvents();
      assert.equal(table('chatMessages').get('a-msg').content, 'Hello');
      assert.equal(Object.keys(state.events).length, 0);
    });
    await check('Active then Moments consumers preserve a moment event until ingestion', async () => {
      state.events = { m: { id: 'm', kind: 'moment', user_id: 'audit-user', character_id: 'role-a', status: 'moment_sent', run_id: 'm-run', sent_at: 2,
        moment: { id: 'moment-a', roleId: 'role-a', content: 'A moment', comments: [] } } };
      const { context, table } = environment(request); vm.runInContext(activeWriter + consumers, context);
      await context._activePullCompanionEvents();
      await context._momentsPullCompanionEvents();
      /* P25-2D：canonical Moment id 由 candidate 派生（不再等于事件自带的临时 moment id），
         因此按**内容**确认落库行，并额外证明它确实走了 candidate 身份。 */
      const rows = [...table('moments').values()];
      const hit = rows.filter(r => r && r.content === 'A moment')[0] || null;
      assert.ok(hit, 'event ACKed without a moments row');
      assert.match(String(hit.id), /^mom_/, 'canonical id must be candidate-derived');
    });
    await check('Moments pull dispatches comment-deletion events', async () => {
      /* P25-2.5：删评是 mutation，必须可归属 —— 事件里的 role_id 是执行者（楼主）。
         无 role_id 的事件会被 Mutation Authority 判 DENY（fail closed）。 */
      state.events = { d: { id: 'd', kind: 'moment_comment_deleted', user_id: 'audit-user', moment_id: 'moment-a', comment_id: 'c-a', role_id: 'role-a', character_id: 'role-a', sent_at: 3 } };
      const { context, table } = environment(request); vm.runInContext(activeWriter + consumers, context);
      table('moments').set('moment-a', { id: 'moment-a', roleId: 'role-a', comments: [{ id: 'c-a', content: 'removed' }] });
      await context._momentsPullCompanionEvents();
      assert.equal(table('moments').get('moment-a').comments.length, 0, 'deleted comment remains in browser store');
    });
    await check('Stale accepted schedule remains in reconcile keep set', async () => {
      const seen = [];
      const { context } = environment(async (url, opts = {}) => {
        if (url === '/health') return { moments: 1, reply_chains: 0 };
        if (url.startsWith('/moments/')) return { ok: true, stale: true };
        if (url === '/reconcile') { seen.push(opts.body.moment_ids); return { ok: true }; }
        throw new Error('unexpected route ' + url);
      });
      context._momentsState = () => ({ 'role-a': { nextAt: Date.now() + 100000 } });
      vm.runInContext(sync, context); await context._momentsSyncCompanion();
      assert.ok(seen.length && seen[0].includes('role-a'), 'stale role omitted; real reconcile deletes it');
    });
    await check('Consolidation excludes private memory from provider request', async () => {
      const { context, table, cfg } = environment(request);
      table('memories').set('private-a', { id: 'private-a', createdBy: cfg.id, visibility: 'private', content: 'PRIVATE_AUDIT_MARKER' });
      /* 同时放一条该角色可见的 public 记忆，确保调用确实发生（而不是因无来源提前 return） */
      table('memories').set('public-a', { id: 'public-a', createdBy: cfg.id, visibility: 'public', content: 'PUBLIC_AUDIT_SOURCE' });
      let sent = '';
      context.callApiChat = async (role, messages) => { sent = JSON.stringify(messages); return '{"shouldConsolidate":false}'; };
      vm.runInContext(consolidation, context); await context.consolidateCharacterMemory(cfg);
      assert.ok(sent.includes('PUBLIC_AUDIT_SOURCE'), 'visible source should still reach the model');
      assert.ok(!sent.includes('PRIVATE_AUDIT_MARKER'), 'private memory sent to model despite isMemoryVisibleTo excluding private');
    });
    await check('Consolidation does not publish a restricted source as public memory', async () => {
      const { context, table, cfg } = environment(request);
      table('memories').set('only-a', { id: 'only-a', createdBy: cfg.id, visibility: 'only', visibleTo: [cfg.id], content: 'User long-term preference' });
      context.callApiChat = async () => JSON.stringify({ shouldConsolidate: true, importance: 8, content: '用户长期偏好安静的沟通方式', consolidatedFrom: ['only-a'] });
      vm.runInContext(consolidation, context); await context.consolidateCharacterMemory(cfg);
      assert.notEqual(table('memories').get('semantic-a')?.visibility, 'public', 'restricted source broadened to public');
    });
    await check('Voice reconnect failure settles so retry can continue', async () => {
      const { context } = environment(request);
      context.VoiceCall = function () {};
      context.wsUrl = () => 'ws://audit.invalid'; context.token = () => '';
      // A peer may close cleanly before hello_ack without an error event.
      context.WebSocket = class { constructor() { setTimeout(() => this.onclose(), 0); } };
      /* 边界随源码结构更新：_voiceConnError 是 connect/scheduleReconnect 依赖的纯函数，必须在同一片段内 */
      vm.runInContext(fragment('assets/js/communication/call.js', 'function _voiceConnError(kind){', '/* The worklet posts'), context);
      const call = new context.VoiceCall();
      /* 只证明"会结束"：窗口放宽到 2s，避免机器负载造成假红；真正要抓的是永久 pending。 */
      const outcome = await Promise.race([call.connect(true).then(() => 'resolved', () => 'rejected'), new Promise(r => setTimeout(() => r('pending'), 2000))]);
      assert.equal(outcome, 'rejected', 'failed reconnect promise remains pending');
    });
    await check('Fallback save remains current when old IndexedDB record stays readable', async () => {
      const { context, cfg } = environment(request);
      let fallback = [];
      context.dbPut = async () => { throw new Error('simulated IndexedDB write failure'); };
      context.dbGetAll = async () => [{ ...cfg, model: 'old-model' }];
      context._apiFallbackPut = row => { fallback = [row]; return 'persistent'; };
      context._apiFallbackRead = () => fallback;
      vm.runInContext(fragment('assets/js/social.js', 'function _ibApiConfigRuntimeCopy(cfg){', 'function _ibApiConfigStorageCopy(cfg){')
        + fragment('assets/js/social.js', 'function _ibApiConfigStorageCopy(cfg){', 'function _ibApiHasCredential(cfg){')
        + fragment('assets/js/social.js', 'async function _persistApiConfig(cfg){', '/* 保存提示语')
        + fragment('assets/js/social.js', 'async function loadApiConfigs(){', 'async function renderApiList(){'), context);
      await context._persistApiConfig({ ...cfg, model: 'new-model' });
      await context.loadApiConfigs();
      assert.equal(context.apiConfigs[0].model, 'new-model', 'reload replaces successful fallback save with stale IndexedDB row');
    });
    await check('Opt-in Runtime resolves Anthropic through shared directory', async () => {
      const { context } = environment(request);
      context.IBModelCore = require(path.join(ROOT, 'assets', 'js', 'ib-model-core.js'));
      context.PROVIDERS = require(path.join(ROOT, 'assets', 'js', 'provider-directory.js')).PROVIDERS;
      context.IB = { expose(name, value) { this[name] = value; } };
      vm.runInContext(source('assets/js/agent-runtime.js'), context);
      assert.equal(context.IB.runtime.instance.resolveModel({ provider: 'anthropic' }).format, 'anthropic');
    });
    await check('Diary-created memory can be recalled by its character', async () => {
      const { context, cfg } = environment(request);
      vm.runInContext(fragment('assets/js/active-diary/diary.js', 'async function _diaryWriteMemory(character,memoryCandidate){', '/* 日记输出解析')
        + fragment('assets/js/memory.js', 'function _ibMemVisCore(', '/* --- 语义相关性'), context);
      const memory = await context._diaryWriteMemory(cfg, { content: 'A stable personal preference', importance: 8 });
      assert.ok(memory, 'diary produced a memory row');
      assert.equal(context.isMemoryVisibleTo(memory, cfg.id, false, false), true, 'new diary memory lacks visibility and is excluded by recall');
    });
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  console.log('Runtime integration audit: ' + failures + ' failed');
  process.exitCode = failures ? 1 : 0;
})().catch(error => { console.error(error); process.exitCode = 1; });
