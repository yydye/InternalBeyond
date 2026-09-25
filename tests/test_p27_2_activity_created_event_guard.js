'use strict';
/* Internal Beyond · P27-2 · Activity Created Domain Event Integration Guard
   阶段性质：PRODUCTION INTEGRATION / MINIMAL EVENT WIRING / ONE EVENT ONLY /
   NO EVENT BUS / NO MANAGER / NO MIGRATION。
   唯一接线：`createActivity` 的 canonical 写入**成功之后** → P26-1 `createDomainEvent`
   产生 `activity.created`（domain='activity', type='created', entityId=activityId）。
   边界：事件**不落库**；事件失败**不回滚** canonical Activity；无 consumer
   （不建 Event Bus / Router / Listener / Manager）；**不复制** P26-1 事件契约。
   用 vm + 桩**真实执行** createActivity（真核心 + 间谍核心），零浏览器、零网络。 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.resolve(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const stripComments = src => String(src).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const CORE = require(path.join(ROOT, 'assets/js/domain-event-core.js'));
const RT = read('assets/js/activity/activity-runtime.js');
const RT_CODE = stripComments(RT);
const HTML = read('InternalBeyond.html');
const COREJS = read('assets/js/core.js');
const storeList = (COREJS.match(/\[('posts'[\s\S]*?)\]\.forEach/) || [])[1] || '';
let passed = 0, failed = 0;
const failures = [];
function check(name, cond, extra) {
  if (cond) { passed++; console.log('  \u2714 ' + name); }
  else { failed++; failures.push(name); console.log('  \u2716 ' + name + (extra === undefined ? '' : '  -> ' + JSON.stringify(extra).slice(0, 320))); }
}
console.log('== P27-2 · Activity Created Event Guard ==');
/* vm 运行环境（真核心 + 间谍核心；跨 realm 输入做 JSON 归一化） */
function makeHarness(opts) {
  opts = opts || {};
  const calls = [];
  const spyCore = {
    createDomainEvent: (input, o) => {
      const norm = JSON.parse(JSON.stringify(input));
      const res = CORE.createDomainEvent(norm, o);
      calls.push({ input: norm, event: res.event, ok: res.ok });
      return res;
    }
  };
  const stores = { activities: {}, chatThreads: {} };
  const dbGet = (s, id) => Promise.resolve(stores[s] ? stores[s][id] : undefined);
  const dbPut = (s, rec) => { if (opts.failPut) return Promise.reject(new Error('put-failed')); stores[s][rec.id] = JSON.parse(JSON.stringify(rec)); return Promise.resolve(); };
  const dbDelete = (s, id) => { delete stores[s][id]; return Promise.resolve(); };
  const dbGetAll = s => Promise.resolve(Object.values(stores[s] || {}).map(r => JSON.parse(JSON.stringify(r))));
  let ls = {};
  const localStorage = { getItem: k => (k in ls ? ls[k] : null), setItem: (k, v) => { ls[k] = String(v); }, removeItem: k => { delete ls[k]; } };
  const document = { createElement: () => ({ textContent: '', innerHTML: '' }) };
  const win = { IB: {} };
  if (opts.core !== null) win.IBDomainEventCore = opts.core || spyCore;
  const ctx = { window: win, document, localStorage, console, dbGet, dbPut, dbDelete, dbGetAll,
    Date, Math, JSON, Object, Array, isFinite, String, Number, Promise };
  vm.createContext(ctx);
  vm.runInContext(RT, ctx);
  return { api: win.IB.activity, calls: calls };
}
(async function run() {
  /* E1 createActivity 成功 → 恰好一个事件 */
  const h = makeHarness();
  const rec = await h.api.createActivity({ type: 'cinema', roleId: 'role_a', resourceId: 'res1', title: 'T' });
  const call = h.calls[h.calls.length - 1];
  check('E1.createCreatesEvent',
    !!rec && h.calls.length === 1 && !!call && call.ok === true
    && !!call.event && call.event.eventId.indexOf('evt_') === 0
    && call.event.domain === 'activity' && call.event.type === 'created', h.calls);
  /* E2 事件带 activityId（entityId） */
  check('E2.eventReferencesActivityId',
    call.event.entityId === rec.id
    && call.input.entityId === rec.id
    && call.event.timestamp === rec.createdAt
    && call.event.actorId === 'role_a' && call.event.origin === 'runtime', call.event);
  /* E3 事件不含 Activity 正文 / 聊天历史 / 记忆 / 帧 / 字幕 / 凭证 */
  const evKeys = Object.keys(call.event);
  const bodyLeak = /content|body|text|memory|memories|base64|dataurl|payload|frame|subtitle|subs|progress|bookmarks|image|audio|apikey|token|secret/i;
  check('E3.noActivityBodyInEvent',
    evKeys.every(k => CORE.ALLOWED_FIELDS.indexOf(k) >= 0)
    && !bodyLeak.test(JSON.stringify(call.event))
    && JSON.stringify(call.event).indexOf(rec.id) >= 0
    && JSON.stringify(call.event).length < JSON.stringify(rec).length, evKeys);
  /* E4 canonical writer 失败 → 不产生事件 */
  const h4 = makeHarness({ failPut: true });
  const r4 = await h4.api.createActivity({ type: 'cinema', roleId: 'role_a', resourceId: 'res2' });
  check('E4.failedWriterNoEvent', r4 === null && h4.calls.length === 0, { r4: r4, calls: h4.calls.length });
  /* E5 事件失败 → 不回滚 canonical Activity */
  const h5a = makeHarness({ core: { createDomainEvent: () => { throw new Error('boom'); } } });
  const r5a = await h5a.api.createActivity({ type: 'cinema', roleId: 'role_a', resourceId: 'res3' });
  const h5b = makeHarness({ core: { createDomainEvent: () => ({ ok: false, errors: ['bad-x'], event: null }) } });
  const r5b = await h5b.api.createActivity({ type: 'cinema', roleId: 'role_a', resourceId: 'res4' });
  const h5c = makeHarness({ core: null });
  const r5c = await h5c.api.createActivity({ type: 'cinema', roleId: 'role_a', resourceId: 'res5' });
  check('E5.eventFailureNoRollback',
    !!r5a && r5a.status === 'active' && !!r5b && r5b.status === 'active' && !!r5c && r5c.status === 'active',
    { a: r5a && r5a.status, b: r5b && r5b.status, c: r5c && r5c.status });
  /* E6 无 Event Bus / Manager / event store */
  check('E6.noEventBusNoManagerNoStore',
    !/\bEventBus\b|EventRouter|ActivityEventManager|ActivityEventEmitter/.test(RT_CODE)
    && HTML.indexOf('event-bus') < 0
    && COREJS.indexOf("DB_NAME='InternalBeyondDB',DB_VER=24") >= 0
    && ['domainEvents', 'events', 'eventStore', 'eventHistory', 'eventQueue']
      .every(s => storeList.indexOf("'" + s + "'") < 0));
  /* E7 接线形状：seam 在 canonical 写入之后；不复制契约；只此一个事件 */
  const i = RT_CODE.indexOf('await dbPut(ACT_STORE,rec)');
  const j = RT_CODE.indexOf('_emitActivityCreated(rec);');       /* 调用点（定义处是 '{'） */
  const k = RT_CODE.indexOf('return rec;', j);
  check('E7.seamAfterCanonicalWriteOneEventOnly',
    i >= 0 && j > i && k > j
    /* 恰好一个创建事件调用点 */
    && RT_CODE.split('_emitActivityCreated(rec);').length === 2
    && RT_CODE.indexOf('domain-event/v1') < 0
    && RT_CODE.indexOf('function validateDomainEvent') < 0
    && RT_CODE.indexOf('window.IBDomainEventCore') >= 0
    && !/_emitActivity(Progressed|Finished|Deleted)/.test(RT_CODE)
    && HTML.indexOf('domain-event-core.js') >= 0
    /* P27-3/P27-4：observation-core 与 session-core 也被生产加载（只读观察 / 只读投影）；
       其余 P26 core 仍不加载 */
    && HTML.indexOf('observation-core.js') >= 0 && HTML.indexOf('session-core.js') >= 0
    && ['resource-core.js', 'feedback-core.js',
      'wake-request-core.js', 'activation-intent-core.js'].every(c => HTML.indexOf(c) < 0));
  console.log('\n' + (failed
    ? 'P27-2 activity created event guard FAILED: ' + failed + ' failed / ' + passed + ' passed'
    : 'P27-2 activity created event guard passed \u2714 (' + passed + ' checks, one event: activity.created)'));
  process.exitCode = failed ? 1 : 0;
})();
