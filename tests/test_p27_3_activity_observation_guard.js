'use strict';
/* Internal Beyond · P27-3 · Activity Observation Integration Guard
   阶段性质：PRODUCTION INTEGRATION / MINIMAL OBSERVATION WIRING / DOMAIN-OWNED GETTERS /
   NO OBSERVATION MANAGER / NO REGISTRY / NO MIGRATION / NO EVENT BUS。
   唯一接线：`IB.activity.getObservation(activityId, opts)` —— 对 canonical Activity 状态的
   **只读**观察（domain='activity', source='activity.state', entityId=activityId,
   valueRef='activities/<activityId>'），经 P26-2 `createObservation` 创建。
   观察：READ ONLY / NON-CANONICAL / NON-EVENT / NON-ACTION / NON-WAKE。
   用 vm + 桩真实执行（真 event core + 真 observation core + 双间谍），零浏览器、零网络。 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.resolve(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const stripComments = src => String(src).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const OBS = require(path.join(ROOT, 'assets/js/observation-core.js'));
const EVT = require(path.join(ROOT, 'assets/js/domain-event-core.js'));
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
console.log('== P27-3 · Activity Observation Guard ==');
function makeHarness(opts) {
  opts = opts || {};
  const obsCalls = [], evtCalls = [];
  let writes = 0;
  const obsCore = { createObservation: (i, o) => { const n = JSON.parse(JSON.stringify(i)); const r = OBS.createObservation(n, o); obsCalls.push({ input: n, observation: r.observation, ok: r.ok }); return r; } };
  const evtCore = { createDomainEvent: (i, o) => { const n = JSON.parse(JSON.stringify(i)); const r = EVT.createDomainEvent(n, o); evtCalls.push({ input: n, ok: r.ok }); return r; } };
  const stores = { activities: {}, chatThreads: {} };
  const dbGet = (s, id) => Promise.resolve(stores[s] ? stores[s][id] : undefined);
  const dbPut = (s, rec) => { if (opts.failPut) return Promise.reject(new Error('put-failed')); writes++; stores[s][rec.id] = JSON.parse(JSON.stringify(rec)); return Promise.resolve(); };
  const dbDelete = (s, id) => { writes++; delete stores[s][id]; return Promise.resolve(); };
  const dbGetAll = s => Promise.resolve(Object.values(stores[s] || {}).map(r => JSON.parse(JSON.stringify(r))));
  let ls = {};
  const localStorage = { getItem: k => (k in ls ? ls[k] : null), setItem: (k, v) => { writes++; ls[k] = String(v); }, removeItem: k => { writes++; delete ls[k]; } };
  const document = { createElement: () => ({ textContent: '', innerHTML: '' }) };
  const win = { IB: {} };
  if (opts.obsCore !== null) win.IBObservationCore = opts.obsCore || obsCore;
  if (opts.evtCore !== null) win.IBDomainEventCore = opts.evtCore || evtCore;
  const ctx = { window: win, document, localStorage, console, dbGet, dbPut, dbDelete, dbGetAll,
    Date, Math, JSON, Object, Array, isFinite, String, Number, Promise };
  vm.createContext(ctx);
  vm.runInContext(RT, ctx);
  return { api: win.IB.activity, obsCalls: obsCalls, evtCalls: evtCalls, writes: () => writes };
}
(async function run() {
  const h = makeHarness();
  const rec = await h.api.createActivity({ type: 'cinema', roleId: 'role_a', resourceId: 'res1',
    title: 'T', progress: { sec: 12, dur: 100, subs: [[1, 2, 'subtitle text']], recap: 'recap body', upTo: 0, pct: 0 },
    bookmarks: [{ page: 1, snip: 'snippet' }] });
  const writesBeforeObs = h.writes();
  const evtBeforeObs = h.evtCalls.length;
  const o = await h.api.getObservation(rec.id, { observedAt: 1770000000001 });
  const writesAfterObs = h.writes();
  /* O1 合法 P26-2 Observation */
  check('O1.validObservation',
    !!o && OBS.validateObservation(o).ok === true
    && o.domain === 'activity' && o.source === 'activity.state'
    && o.freshness === 'fresh' && o.availability === 'available'
    && o.observedAt === 1770000000001 && /^obs_/.test(o.observationId)
    && Object.isFrozen(o), o);
  /* O2 entityId 指向正确的 Activity */
  check('O2.entityIdIsActivity', o.entityId === rec.id && h.obsCalls[h.obsCalls.length - 1].input.entityId === rec.id);
  /* O3 不复制完整 Activity 对象 */
  check('O3.noFullActivityCopy',
    Object.keys(o).every(k => OBS.ALLOWED_FIELDS.indexOf(k) >= 0)
    && JSON.stringify(o).indexOf(rec.id) >= 0
    && JSON.stringify(o).length < JSON.stringify(rec).length, Object.keys(o));
  /* O4 无 subtitle / frame / page / chat 正文泄漏 */
  const leak = /subtitle text|recap body|snippet|frame|base64|dataurl|content|body|text|transcript|message/i;
  check('O4.noBodyLeakage',
    !leak.test(JSON.stringify(o))
    && Object.keys(o).indexOf('progress') < 0 && Object.keys(o).indexOf('bookmarks') < 0
    && Object.keys(o).indexOf('chatMessages') < 0);
  /* O5 观察读取不产生 canonical 写 */
  check('O5.readOnlyNoWrite', writesAfterObs - writesBeforeObs === 0, { writes: writesAfterObs - writesBeforeObs });
  /* O6 缺失/不可用来源不改变状态 */
  const wBefore6 = h.writes();
  const o6 = await h.api.getObservation('act_missing', { observedAt: 1770000000001 });
  check('O6.unavailableNoMutation',
    !!o6 && o6.availability === 'unavailable' && OBS.validateObservation(o6).ok === true
    && h.writes() - wBefore6 === 0
    /* 非法 entityId ⇒ 不产生观察 */
    && (await h.api.getObservation('')) === null && (await h.api.getObservation(null)) === null);
  /* O7 观察不发 Domain Event */
  check('O7.noEventFromObservation', h.evtCalls.length === evtBeforeObs, { evt: h.evtCalls.length - evtBeforeObs });
  /* O8 无 Feedback / Wake / Agent 行为 */
  const FROZEN_5_10 = /IBFeedback|IBWakeRequest|IBWakeRuntime|IBActivationIntent|IBActivationRuntime|WAKE_ELIGIBLE|ACTIVATE_ELIGIBLE|feedback-core|wake-request-core|activation/;
  check('O8.noFeedbackWakeAgent',
    !FROZEN_5_10.test(RT_CODE)
    && !/triggerAgent|runAgent|startAgent|Autonomy/i.test(RT_CODE));
  /* O9 无 manager / registry / store / queue / scheduler */
  check('O9.noManagerRegistryStore',
    !/ObservationManager|ObservationRegistry|ObservationService|ObservationStore/.test(RT_CODE)
    && !/queue|enqueue|scheduler|setInterval/.test(RT_CODE)
    /* 领域自有 getter：只有一个 observation 入口 */
    && (RT_CODE.match(/IBObservationCore/g) || []).length === 1
    && RT_CODE.split('getObservation(activityId,opts)').length === 2);
  /* O10 DB_VER 仍 24、无 observation store */
  check('O10.dbUnchanged',
    COREJS.indexOf("DB_NAME='InternalBeyondDB',DB_VER=24") >= 0
    && ['observations', 'observationCache', 'observers', 'snapshots', 'observeQueue']
      .every(s => storeList.indexOf("'" + s + "'") < 0));
  /* O11 只加载预期的 P26 core（domain-event + observation + session（P27-4 起）） */
  check('O11.onlyIntendedCoresLoaded',
    HTML.indexOf('domain-event-core.js') >= 0 && HTML.indexOf('observation-core.js') >= 0
    /* P27-4：session-core 也被生产加载（只读 Session 投影） */
    && HTML.indexOf('session-core.js') >= 0
    && ['resource-core.js', 'feedback-core.js', 'feedback-consumption-core.js',
      'wake-request-core.js', 'wake-runtime-core.js', 'activation-intent-core.js',
      'activation-runtime-core.js'].every(c => HTML.indexOf(c) < 0));
  /* O12 P27-2 activity.created 行为保持 */
  check('O12.activityCreatedIntact',
    h.evtCalls.length === 1
    && h.evtCalls[0].ok === true && h.evtCalls[0].input.entityId === rec.id
    && h.evtCalls[0].input.type === 'created' && h.evtCalls[0].input.domain === 'activity'
    && RT_CODE.indexOf("_emit(rec.id,'activity',rec);") >= 0);
  /* 核心缺失 ⇒ 返回 null，不抛错、不改状态 */
  const hNo = makeHarness({ obsCore: null });
  const recN = await hNo.api.createActivity({ type: 'coread', roleId: 'role_a', resourceId: 'res9' });
  const wN = hNo.writes();
  check('O13.missingCoreSafe',
    (await hNo.api.getObservation(recN.id, {})) === null && hNo.writes() - wN === 0);
  console.log('\n' + (failed
    ? 'P27-3 activity observation guard FAILED: ' + failed + ' failed / ' + passed + ' passed'
    : 'P27-3 activity observation guard passed \u2714 (' + passed + ' checks, one observation: activity.state)'));
  process.exitCode = failed ? 1 : 0;
})();
