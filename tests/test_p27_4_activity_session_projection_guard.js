'use strict';
/* Internal Beyond · P27-4 · Activity Session Projection Guard
   阶段性质：PRODUCTION INTEGRATION / READ-ONLY SESSION PROJECTION / MINIMAL WIRING /
   NO SESSION STORE / NO SESSION MANAGER / NO MIGRATION / NO EVENT BUS。
   唯一接线：`IB.activity.getSession(activityId)` —— 把 canonical Activity 记录**只读投影**成
   P26-3 Session（sessionId = activityId；participants = [roleId]；status: active→active,
   finished→ended；createdAt ← rec.createdAt；updatedAt ← rec.updatedAt；**无 endedAt**）。
   **不**调用 resolveActivity（带写副作用）、**不**调用 transitionSession、**不需要** current 指针。
   用 vm + 桩真实执行（真 session/event/observation core），零浏览器、零网络。 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.resolve(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const stripComments = src => String(src).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const S = require(path.join(ROOT, 'assets/js/session-core.js'));
const EVT = require(path.join(ROOT, 'assets/js/domain-event-core.js'));
const OBS = require(path.join(ROOT, 'assets/js/observation-core.js'));
const RT = read('assets/js/activity/activity-runtime.js');
const RT_CODE = stripComments(RT);
const HTML = read('InternalBeyond.html');
const COREJS = read('assets/js/core.js');
const storeList = require('./helpers/db-schema-authority.js').storeList;
const N = o => JSON.parse(JSON.stringify(o));
let passed = 0, failed = 0;
const failures = [];
function check(name, cond, extra) {
  if (cond) { passed++; console.log('  \u2714 ' + name); }
  else { failed++; failures.push(name); console.log('  \u2716 ' + name + (extra === undefined ? '' : '  -> ' + JSON.stringify(extra).slice(0, 320))); }
}
console.log('== P27-4 · Activity Session Projection Guard ==');
function makeHarness(opts) {
  opts = opts || {};
  const calls = { evt: 0, obs: 0 };
  let writes = 0;
  const sessCore = { createSession: (i, o) => S.createSession(N(i), o), validateSession: s => S.validateSession(N(s)), SESSION_STATUSES: S.SESSION_STATUSES };
  const stores = { activities: {}, chatThreads: {} };
  const dbGet = (s, id) => Promise.resolve(stores[s] ? stores[s][id] : undefined);
  const dbPut = (s, rec) => { writes++; stores[s][rec.id] = JSON.parse(JSON.stringify(rec)); return Promise.resolve(); };
  const dbDelete = (s, id) => { writes++; delete stores[s][id]; return Promise.resolve(); };
  const dbGetAll = s => Promise.resolve(Object.values(stores[s] || {}).map(r => JSON.parse(JSON.stringify(r))));
  let ls = {};
  const localStorage = { getItem: k => (k in ls ? ls[k] : null), setItem: (k, v) => { writes++; ls[k] = String(v); }, removeItem: k => { writes++; delete ls[k]; } };
  const document = { createElement: () => ({ textContent: '', innerHTML: '' }) };
  const win = { IB: {} };
  if (opts.sessCore !== null) win.IBSessionCore = opts.sessCore || sessCore;
  win.IBDomainEventCore = { createDomainEvent: (i, o) => { calls.evt++; return EVT.createDomainEvent(N(i), o); } };
  win.IBObservationCore = { createObservation: (i, o) => { calls.obs++; return OBS.createObservation(N(i), o); } };
  const ctx = { window: win, document, localStorage, console, dbGet, dbPut, dbDelete, dbGetAll,
    Date, Math, JSON, Object, Array, isFinite, String, Number, Promise };
  vm.createContext(ctx);
  vm.runInContext(RT, ctx);
  return { api: win.IB.activity, calls: calls, writes: () => writes, ls: () => ls };
}
(async function run() {
  const h = makeHarness();
  const rec = await h.api.createActivity({ type: 'cinema', roleId: 'role_a', resourceId: 'res1', title: 'T' });
  await h.api.setCurrent(rec.id);
  const w0 = h.writes(), e0 = h.calls.evt, o0 = h.calls.obs;
  const s = await h.api.getSession(rec.id);
  /* S1 合法 P26-3 Session */
  check('S1.validSessionFromActiveActivity',
    !!s && S.validateSession(N(s)).ok === true && s.domain === 'activity'
    && s.status === 'active' && s.createdAt === rec.createdAt
    && Object.isFrozen(s) && Array.isArray(s.participants), s);
  /* S2 sessionId 确定性映射且不新增持久字段 */
  check('S2.sessionIdIsActivityIdNoPersistedField',
    s.sessionId === rec.id
    && !Object.prototype.hasOwnProperty.call(await h.api.getActivity(rec.id), 'sessionId')
    && (await h.api.getSession(rec.id)).sessionId === s.sessionId);
  /* S3 参与者映射有据可依（role-only） */
  check('S3.participantsRoleOnly', JSON.stringify(s.participants) === JSON.stringify(['role_a']));
  /* S4 active 状态映射 */
  check('S4.activeMapsToActive', s.status === 'active' && S.SESSION_STATUSES.indexOf(s.status) >= 0);
  /* S5 finished（管理态）映射为 ended 且不发明 endedAt */
  await h.api.saveActivity(rec.id, { status: 'finished' });
  const s5 = await h.api.getSession(rec.id);
  check('S5.finishedMapsToEndedWithoutEndedAt',
    !!s5 && s5.status === 'ended' && S.validateSession(N(s5)).ok === true
    && !Object.prototype.hasOwnProperty.call(s5, 'endedAt'));
  /* S6 缺失 Activity → null */
  check('S6.missingActivityNull',
    (await h.api.getSession('act_missing')) === null
    && (await h.api.getSession(null)) === null && (await h.api.getSession('')) === null);
  /* S7 投影零写入（只测量单次 getSession 窗口） */
  const w7a = h.writes();
  await h.api.getSession(rec.id);
  const w7b = h.writes();
  check('S7.zeroWrites', w7b - w7a === 0, { writes: w7b - w7a });
  /* S8 指针缺失不影响 Session（无指针也投影） */
  const h8 = makeHarness();
  const r8 = await h8.api.createActivity({ type: 'coread', roleId: 'role_b', resourceId: 'res9' });
  const s8 = await h8.api.getSession(r8.id);
  check('S8.pointerAbsenceNotSessionEnd', !!s8 && s8.status === 'active' && s8.sessionId === r8.id);
  /* S9 stale pointer 不触发清理写 */
  const w9 = h8.writes();
  await h8.api.getSession(r8.id);
  check('S9.stalePointerNoCleanupWrite', h8.writes() - w9 === 0);
  /* S12/S13 不发 Event、不产生 Observation */
  check('S12.noDomainEvent', h.calls.evt - e0 === 0 && h8.calls.evt === 1);
  check('S13.noObservation', h.calls.obs - o0 === 0 && h8.calls.obs === 0);
  /* S14 无 Feedback/Wake/Agent；S15 无 Session Manager/Store/Registry */
  const FROZEN_5_10 = /IBFeedback|IBWakeRequest|IBWakeRuntime|IBActivationIntent|IBActivationRuntime|feedback-core|wake-request-core|activation-runtime-core/;
  check('S14.noFeedbackWakeAgent', !FROZEN_5_10.test(RT_CODE) && !/triggerAgent|runAgent|Autonomy/i.test(RT_CODE));
  check('S15.noSessionManagerStoreRegistry',
    !/SessionManager|SessionRegistry|SessionStore|ActivitySessionManager/.test(RT_CODE)
    && !/queue|enqueue|scheduler|setInterval/.test(RT_CODE)
    && RT_CODE.indexOf('transitionSession') < 0 && RT_CODE.indexOf('canTransitionSession') < 0
    && RT_CODE.indexOf('resolveActivity') >= 0 /* 既有函数仍在，但 getSession 不调用它 */ );
  /* getSession 不调用 resolveActivity：只读 getActivity */
  const gsBody = (function () {
    const i = RT_CODE.indexOf('async function getSession(');
    const j = RT_CODE.indexOf('\n  async function ', i + 10);
    return RT_CODE.slice(i, j > 0 ? j : i + 1400);
  })();
  check('S15b.projectionDoesNotCallResolveActivity',
    gsBody.indexOf('resolveActivity') < 0 && gsBody.indexOf('getActivity(') >= 0
    && gsBody.indexOf('localStorage') < 0 && gsBody.indexOf('dbPut') < 0 && gsBody.indexOf('dbDelete') < 0,
    gsBody.slice(0, 160));
  /* S16 DB_VER 24、无 session store */
  check('S16.dbUnchanged',
    require('./helpers/db-schema-authority.js').isVersion('InternalBeyondDB', 24)
    && ['sessions', 'sessionIdentity', 'sessionStore', 'activeSessions']
      .every(x => storeList.indexOf("'" + x + "'") < 0));
  /* S17 只加载预期的 P26 core（domain-event + observation + session） */
  check('S17.onlyIntendedCoresLoaded',
    HTML.indexOf('domain-event-core.js') >= 0 && HTML.indexOf('observation-core.js') >= 0
    && HTML.indexOf('session-core.js') >= 0
    && ['resource-core.js', 'feedback-core.js', 'feedback-consumption-core.js', 'wake-request-core.js',
      'wake-runtime-core.js', 'activation-intent-core.js', 'activation-runtime-core.js']
      .every(c => HTML.indexOf(c) < 0));
  /* S18/S19 P27-2 / P27-3 行为保持 */
  const hS = makeHarness();
  const rS = await hS.api.createActivity({ type: 'cinema', roleId: 'role_z', resourceId: 'resz' });
  const obs = await hS.api.getObservation(rS.id, { observedAt: 1770000000001 });
  check('S18.activityCreatedIntact',
    hS.calls.evt === 1 && rS && rS.status === 'active'
    && RT_CODE.indexOf("_emitActivityCreated(rec);") >= 0);
  check('S19.activityStateIntact',
    !!obs && OBS.validateObservation(N(obs)).ok === true && obs.entityId === rS.id
    && obs.source === 'activity.state' && hS.calls.obs === 1);
  /* 核心缺失 ⇒ null，不抛错、不写 */
  const hN = makeHarness({ sessCore: null });
  const rN = await hN.api.createActivity({ type: 'cinema', roleId: 'role_n', resourceId: 'resn' });
  const wN = hN.writes();
  check('S20.missingCoreSafe', (await hN.api.getSession(rN.id)) === null && hN.writes() - wN === 0);
  /* 未知状态 fail closed */
  const hU = makeHarness();
  const rU = await hU.api.createActivity({ type: 'cinema', roleId: 'role_u', resourceId: 'resu' });
  await hU.api.saveActivity(rU.id, { status: 'weird' });
  check('S21.unknownStatusFailsClosed', (await hU.api.getSession(rU.id)) === null);
  console.log('\n' + (failed
    ? 'P27-4 activity session projection guard FAILED: ' + failed + ' failed / ' + passed + ' passed'
    : 'P27-4 activity session projection guard passed \u2714 (' + passed + ' checks, one projection: activity session)'));
  process.exitCode = failed ? 1 : 0;
})();
