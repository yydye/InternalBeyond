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
function fragment(file, begin, end) {
  const text = source(file), start = text.indexOf(begin);
  assert.ok(start >= 0, 'source boundary missing: ' + begin);
  const stop = text.indexOf(end, start + begin.length);
  assert.ok(stop > start, 'source boundary missing: ' + end);
  return text.slice(start, stop);
}
const active = 'assets/js/active-diary.js', moments = 'assets/js/moments.js';
const consumers = fragment(active, 'async function _activePullCompanionEvents(){', 'function initActiveMessages(){')
  + fragment(moments, 'async function _momentsIngestEvent(ev,userId){', '/* 浏览器本地执行');
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
  /* 注入真实的可见性函数，使 memory 相关断言按当前 schema 语义成立（而非依赖缺失时的旁路） */
  vm.runInContext(fragment('assets/js/memory.js', 'function isMemoryVisibleTo(', '/* --- 语义相关性'), context);
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
      const { context, table } = environment(request); vm.runInContext(consumers, context);
      await context._activePullCompanionEvents();
      assert.equal(table('chatMessages').get('a-msg').content, 'Hello');
      assert.equal(Object.keys(state.events).length, 0);
    });
    await check('Active then Moments consumers preserve a moment event until ingestion', async () => {
      state.events = { m: { id: 'm', kind: 'moment', user_id: 'audit-user', character_id: 'role-a', status: 'moment_sent', run_id: 'm-run', sent_at: 2,
        moment: { id: 'moment-a', roleId: 'role-a', content: 'A moment', comments: [] } } };
      const { context, table } = environment(request); vm.runInContext(consumers, context);
      await context._activePullCompanionEvents();
      await context._momentsPullCompanionEvents();
      assert.ok(table('moments').has('moment-a'), 'event ACKed without a moments row');
    });
    await check('Moments pull dispatches comment-deletion events', async () => {
      state.events = { d: { id: 'd', kind: 'moment_comment_deleted', user_id: 'audit-user', moment_id: 'moment-a', comment_id: 'c-a', sent_at: 3 } };
      const { context, table } = environment(request); vm.runInContext(consumers, context);
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
      vm.runInContext(fragment('assets/js/social.js', 'async function _persistApiConfig(cfg){', '/* 保存提示语')
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
        + fragment('assets/js/memory.js', 'function isMemoryVisibleTo(', '/* --- 语义相关性'), context);
      const memory = await context._diaryWriteMemory(cfg, { content: 'A stable personal preference', importance: 8 });
      assert.ok(memory, 'diary produced a memory row');
      assert.equal(context.isMemoryVisibleTo(memory, cfg.id, false, false), true, 'new diary memory lacks visibility and is excluded by recall');
    });
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  console.log('Runtime integration audit: ' + failures + ' failed');
  process.exitCode = failures ? 1 : 0;
})().catch(error => { console.error(error); process.exitCode = 1; });
