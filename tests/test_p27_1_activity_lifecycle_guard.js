'use strict';

/* Internal Beyond · P27-1 · Activity Lifecycle Closure Guard

   阶段性质：PRODUCTION INTEGRATION / LIFECYCLE SEMANTICS ONLY / MINIMAL CHANGE /
   NO NEW WRITER / NO SCHEMA MIGRATION / NO EVENT BUS。

   决策：**A —— finish（以及 pause / resume）今天不需要，保持 NOT PRESENT。**
   依据：读侧已完整实现 `finished` 语义（5 处），但没有**任何调用者**需要它；
   新增一个无调用者的 lifecycle 命令属于投机抽象（与 P26-C 对 REDUNDANT_CANDIDATE 的判据一致），
   且会迫使多个上游冻结守卫（P25-3E / P26-1..4 冻结了 activity-runtime.js）重新基线。
   ⇒ 本阶段**零 production 变更**，只冻结生命周期契约与"读侧已就绪、写侧不存在"这一事实。

   本守卫用 vm + 桩**真实执行**读侧契约（手工经既有 saveActivity 置 finished），
   证明读侧完整、且今天不存在 lifecycle 命令。

   零浏览器、零网络、零真实 provider。 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.resolve(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const stripComments = src => String(src).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

let passed = 0, failed = 0;
const failures = [];
function check(name, cond, extra) {
  if (cond) { passed++; console.log('  \u2714 ' + name); }
  else { failed++; failures.push(name); console.log('  \u2716 ' + name + (extra === undefined ? '' : '  -> ' + JSON.stringify(extra).slice(0, 320))); }
}

const RT = read('assets/js/activity/activity-runtime.js');
const RT_CODE = stripComments(RT);
const CINEMA = stripComments(read('apps/ib-app-cinema.js'));
const COREAD = stripComments(read('assets/js/activity/coread.js'));
const COREJS = read('assets/js/core.js');
const storeList = require('./helpers/db-schema-authority.js').storeList;

console.log('== P27-1 · Activity Lifecycle Closure Guard ==');

/* ── L1 finish 保持 NOT PRESENT（决策 A）──────────────────────────── */
check('L1.finishNotPresent',
  !/function finishActivity\(|finishActivity\s*:/.test(RT_CODE)
  && RT_CODE.indexOf('finish(') < 0
  && !/['"]finish['"]\s*:/.test(RT_CODE));

/* ── L2 pause / resume 保持 NOT PRESENT ──────────────────────────── */
check('L2.pauseResumeNotPresent',
  !/pauseActivity|resumeActivity|function pause\(|function resume\(/.test(RT_CODE)
  && !/activity\.pause|activity\.resume/.test(CINEMA)
  /* Cinema 的 pause 只属于 media adapter（传输） */
  && /_adapter/.test(CINEMA));

/* ── L3 finished 读侧就绪、写侧不存在 ────────────────────────────── */
check('L3.finishedReadOnlyUnreachable',
  /* 读侧 5 处尊重 finished */
  /_usableFor\(rec,roleId\)\{return!!\(rec&&String\(rec\.roleId\)===String\(roleId\)&&rec\.status!=='finished'\)\}/.test(RT_CODE)
  && /if\(!rec\|\|rec\.status==='finished'\)return null/.test(RT_CODE)
  && /activity_finished/.test(RT_CODE)
  /* 生产无任何 `status:'finished'` 写入者 */
  && ['assets/js/activity/activity-runtime.js', 'assets/js/activity/coread.js', 'apps/ib-app-cinema.js',
    'assets/js/communication.js', 'assets/js/app-store.js']
    .every(f => !/status\s*:\s*'finished'/.test(stripComments(read(f)))));

/* ── L4 语义探针：读侧契约完整（经既有 saveActivity 置 finished）──── */
function makeHarness() {
  const stores = { activities: {}, chatThreads: {} };
  const dbGet = (s, id) => Promise.resolve(stores[s] ? stores[s][id] : undefined);
  const dbPut = (s, rec) => { stores[s][rec.id] = JSON.parse(JSON.stringify(rec)); return Promise.resolve(); };
  const dbDelete = (s, id) => { delete stores[s][id]; return Promise.resolve(); };
  const dbGetAll = s => Promise.resolve(Object.values(stores[s] || {}).map(r => JSON.parse(JSON.stringify(r))));
  let ls = {};
  const localStorage = { getItem: k => (k in ls ? ls[k] : null), setItem: (k, v) => { ls[k] = String(v); }, removeItem: k => { delete ls[k]; } };
  const document = { createElement: () => ({ textContent: '', innerHTML: '' }) };
  const ctx = { window: { IB: {} }, document, localStorage, console, dbGet, dbPut, dbDelete, dbGetAll,
    Date, Math, JSON, Object, Array, isFinite, String, Number, Promise };
  vm.createContext(ctx);
  vm.runInContext(RT, ctx);
  return { api: ctx.window.IB.activity, ptr: () => JSON.parse(ls['ib_activity_current_v1'] || '{}') };
}

/* ── L5 writer 唯一性（结构）──────────────────────────────────────── */
const actWriters = [];
for (const f of ['assets/js/activity/activity-runtime.js', 'assets/js/activity/coread.js',
  'apps/ib-app-cinema.js', 'assets/js/communication.js', 'assets/js/app-store.js']) {
  const src = stripComments(read(f));
  if (/dbPut\(\s*'activities'|dbDelete\(\s*'activities'|dbPut\(ACT_STORE|dbDelete\(ACT_STORE/.test(src)) actWriters.push(f);
}
check('L5.soleCanonicalWriter',
  JSON.stringify(actWriters) === JSON.stringify(['assets/js/activity/activity-runtime.js']), actWriters);

/* ── L6 pointer 不是 authority / 不是 session ─────────────────────── */
check('L6.pointerNotAuthorityNotSession',
  RT.indexOf("var CUR_KEY='ib_activity_current_v1'") >= 0
  /* P27-4 起：Session **投影**会产出 sessionId（= activityId），但 Activity **记录**仍无 sessionId 字段；
     这里守护的是"Activity canonical 记录不含 session 身份 / 无 session 存储 / 无 session 生命周期"。 */
  && RT_CODE.indexOf('rec.sessionId') < 0 && RT_CODE.indexOf('setupSessionId') < 0
  && RT_CODE.indexOf('session-core') < 0
  && !/startSession|endSession|transitionSession|createSessionStore/.test(RT_CODE)
  && RT.indexOf('localStorage.setItem(CUR_KEY') >= 0);

/* ── L7 无迁移：DB_VER / store / 字段 ─────────────────────────────── */
check('L7.noMigration',
  require('./helpers/db-schema-authority.js').isVersion('InternalBeyondDB', 24)
  && storeList.indexOf("'activities'") >= 0
  && ['activitySessions', 'activityEvents', 'activityLifecycle', 'sessionEvents']
    .every(s => storeList.indexOf("'" + s + "'") < 0)
  && RT_CODE.indexOf('finishedAt') < 0);

/* ── L8 Cinema：close=clearCurrent（不 finish）；pause=media transport ─ */
check('L8.cinemaCompatibility',
  /clearCurrent\(_aiId,_activity\.id\)/.test(CINEMA)
  && CINEMA.indexOf('finishActivity') < 0
  && /IB\.activity\.setProgress/.test(CINEMA) && /IB\.activity\.send/.test(CINEMA));

/* ── L9 Co-read：leave=clearCurrent；progress/bookmark 语义不变 ───── */
check('L9.coreadCompatibility',
  /clearCurrent\(_activity\.roleId,_activity\.id\)/.test(COREAD)
  && COREAD.indexOf('finishActivity') < 0
  && /IB\.activity\.setProgress/.test(COREAD)
  && /IB\.activity\.saveActivity\(_activity\.id,\{bookmarks/.test(COREAD));

/* ── L10 无 P26-5..10 / 无 Event Bus ─────────────────────────────── */
const FROZEN_5_10 = /IBFeedback|IBWakeRequest|IBWakeRuntime|IBActivationIntent|IBActivationRuntime|WAKE_ELIGIBLE|ACTIVATE_ELIGIBLE|feedback-core|wake-request-core|activation-runtime-core/;
check('L10.noP26_5to10NoEventBus',
  !FROZEN_5_10.test(RT_CODE) && !FROZEN_5_10.test(CINEMA) && !FROZEN_5_10.test(COREAD)
  && !/\bEventBus\b/.test(RT_CODE));

/* ── L11 决策留痕 ────────────────────────────────────────────────── */
check('L11.decisionRecorded',
  fs.existsSync(path.join(ROOT, 'docs/P27-1-ACTIVITY-LIFECYCLE-CLOSURE.md'))
  && read('docs/P27-1-ACTIVITY-LIFECYCLE-CLOSURE.md').indexOf('finish') >= 0);

/* ── L4 语义探针（异步）：读侧完整 + 无 lifecycle 命令 ────────────── */
(async function runSemantics() {
  const h = makeHarness();
  const A = h.api;
  /* 决策 A：不存在 lifecycle 命令 */
  const noCommands = typeof A.finishActivity === 'undefined' && typeof A.pause === 'undefined'
    && typeof A.resume === 'undefined';
  const rec = await A.createActivity({ type: 'cinema', roleId: 'r1', resourceId: 'res1' });
  await A.setCurrent(rec.id);
  const ptrBefore = h.ptr().r1 && h.ptr().r1.activityId;
  /* 经既有 writer 手工置 finished（证明读侧契约） */
  const fin = await A.saveActivity(rec.id, { status: 'finished' });
  const afterPtrKeys = Object.keys(h.ptr()).length;
  const setCur = await A.setCurrent(rec.id);
  const sent = await A.send(rec.id, 'hi');
  const nudged = await A.nudge({ activityId: rec.id });
  const resolved = await A.resolveActivity('r1');
  check('L4.readSideContractComplete',
    noCommands
    && rec.status === 'active' && ptrBefore === rec.id
    && !!fin && fin.status === 'finished'
    && setCur === null
    && !!sent && sent.ok === false && sent.error === 'activity_finished'
    && nudged === false && resolved === null,
    { noCommands: noCommands, setCur: setCur, sent: sent, resolved: resolved, afterPtrKeys: afterPtrKeys });

  console.log('\n' + (failed
    ? 'P27-1 activity lifecycle guard FAILED: ' + failed + ' failed / ' + passed + ' passed'
    : 'P27-1 activity lifecycle guard passed \u2714 (' + passed + ' checks)'));
  process.exitCode = failed ? 1 : 0;
})();
