'use strict';

/* Internal Beyond · P27-0 · Activity Production Wiring Guard（READ-ONLY evidence guard）

   阶段性质：PRODUCTION INTEGRATION PRE-AUDIT / READ-ONLY / EVIDENCE-FIRST /
   NO PRODUCTION MUTATION / NO SCHEMA CHANGE / NO COMMIT。

   本守卫**不修改任何生产代码**，只把 P27-0 审计到的 Activity 生产事实固定下来，
   使后续 P27-x 一旦偏离（新增 writer / 偷接 P26-5..10 / 改 schema）立刻变红。

   零浏览器、零网络。 */

const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const exists = f => fs.existsSync(path.join(ROOT, f));
const stripComments = src => String(src).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

let passed = 0, failed = 0;
const failures = [];
function check(name, cond, extra) {
  if (cond) { passed++; console.log('  \u2714 ' + name); }
  else { failed++; failures.push(name); console.log('  \u2716 ' + name + (extra === undefined ? '' : '  -> ' + JSON.stringify(extra).slice(0, 320))); }
}

console.log('== P27-0 · Activity Production Wiring Guard ==');

const RT = read('assets/js/activity/activity-runtime.js');
const RT_CODE = stripComments(RT);
const COMMUNICATION = stripComments(read('assets/js/communication.js'));
const HTML = read('InternalBeyond.html');
const COREJS = read('assets/js/core.js');

/* ── A1 canonical storage：store + pointer + DB_VER ─────────────────── */
const storeList = require('./helpers/db-schema-authority.js').storeList;
check('A1.canonicalStorage',
  require('./helpers/db-schema-authority.js').isVersion('InternalBeyondDB', 24)
  && require('./helpers/db-schema-authority.js').isWiredBeforeCore(HTML, COREJS)
  && storeList.indexOf("'activities'") >= 0
  && RT.indexOf("var ACT_STORE='activities'") >= 0
  && RT.indexOf("var CUR_KEY='ib_activity_current_v1'") >= 0
  /* 不得出现第二个 Activity canonical store */
  && ['activitySessions', 'activityEvents', 'activityObservations', 'activityResources',
    'activityLifecycle'].every(s => storeList.indexOf("'" + s + "'") < 0),
  [storeList.indexOf("'activities'"), RT.indexOf('ib_activity_current_v1')]);

/* ── A2 canonical writer 唯一性：只有 activity-runtime 写 activities ── */
const writers = [];
for (const f of ['assets/js/activity/coread.js', 'apps/ib-app-cinema.js', 'assets/js/communication.js',
  'assets/js/app-store.js', 'assets/js/activity/activity-runtime.js']) {
  if (!exists(f)) continue;
  const src = stripComments(read(f));
  if (/dbPut\(\s*'activities'|dbDelete\(\s*'activities'|dbPut\(ACT_STORE|dbDelete\(ACT_STORE/.test(src)) writers.push(f);
}
check('A2.soleCanonicalWriter',
  JSON.stringify(writers) === JSON.stringify(['assets/js/activity/activity-runtime.js']), writers);

/* ── A3 API surface 冻结（21 个导出）──────────────────────────────── */
const API_KEYS = ['createActivity', 'getActivity', 'findActivity', 'listActivities', 'saveActivity',
  'deleteActivity', 'setProgress', 'setCurrent', 'clearCurrent', 'resolveActivity',
  'buildActivityContext', 'getActivityContext', 'send', 'openChat', 'writeMemory', 'nudge',
  'mark', 'fav', 'on', 'off', 'emit'];
check('A3.apiSurfaceFrozen',
  API_KEYS.every(k => RT.indexOf(k + ':') >= 0)
  /* lifecycle 命令 **NOT PRESENT**（不得凭空出现） */
  && !/finishActivity|pauseActivity|resumeActivity|activityFinish|activityPause/.test(RT_CODE)
  && RT.indexOf('function finishActivity') < 0 && RT.indexOf('function pauseActivity') < 0,
  API_KEYS.filter(k => RT.indexOf(k + ':') < 0));

/* ── A4 finished 只读：生产无 writer ──────────────────────────────── */
const finishWriters = [];
for (const f of ['assets/js/activity/activity-runtime.js', 'assets/js/activity/coread.js',
  'apps/ib-app-cinema.js', 'assets/js/communication.js', 'assets/js/app-store.js']) {
  const src = stripComments(read(f));
  if (/status\s*:\s*'finished'|status='finished'|status:\s*"finished"/.test(src)) finishWriters.push(f);
}
check('A4.finishedReadOnly', finishWriters.length === 0, finishWriters);

/* ── A5 activity.mark 无生产调用者 ────────────────────────────────── */
const markCallers = [];
for (const f of ['assets/js/activity/coread.js', 'apps/ib-app-cinema.js', 'assets/js/communication.js',
  'assets/js/app-store.js']) {
  if (/\.mark\(\s*(activityId|_activity|rec)/.test(stripComments(read(f)))) markCallers.push(f);
}
check('A5.markNoProductionCaller', markCallers.length === 0, markCallers);

/* ── A6 createActivity 调用者只有 Cinema + Co-read ────────────────── */
const createCallers = [];
for (const f of ['assets/js/activity/coread.js', 'apps/ib-app-cinema.js', 'assets/js/communication.js',
  'assets/js/app-store.js', 'assets/js/role-dm.js']) {
  if (!exists(f)) continue;
  if (/\.createActivity\(|_activityCreate\(/.test(stripComments(read(f)))) createCallers.push(f);
}
check('A6.createCallers',
  JSON.stringify(createCallers.sort()) === JSON.stringify(['apps/ib-app-cinema.js', 'assets/js/activity/coread.js']),
  createCallers);

/* ── A7 Chat 仍拥有 chat message canonical authority ──────────────── */
check('A7.chatBoundary',
  /* 只有 communication.js 写 chatMessages */
  /dbPut\(\s*'chatMessages'/.test(COMMUNICATION)
  && !/dbPut\(\s*'chatMessages'/.test(stripComments(read('apps/ib-app-cinema.js')))
  /* activity.send 委托给 sendChatMessage（不自己写消息） */
  && /sendChatMessage\.call\(window/.test(RT)
  && RT.indexOf("opts={activityId:rec.id}") >= 0);

/* ── A8 Activity/Cinema/Co-read 不引用 P26-5..10 ──────────────────── */
const FROZEN_5_10 = /IBFeedback|IBFeedbackConsumption|IBWakeRequest|IBWakeRuntime|IBActivationIntent|IBActivationRuntime|feedback-core|feedback-consumption-core|wake-request-core|wake-runtime-core|activation-intent-core|activation-runtime-core|WAKE_ELIGIBLE|ACTIVATE_ELIGIBLE/;
const leaks = [];
for (const f of ['assets/js/activity/activity-runtime.js', 'assets/js/activity/coread.js',
  'apps/ib-app-cinema.js', 'assets/js/communication.js']) {
  if (FROZEN_5_10.test(stripComments(read(f)))) leaks.push(f);
}
check('A8.noP26_5to10Wiring', leaks.length === 0, leaks);

/* ── A9 HTML 装载：runtime + coread 静态；Cinema 经 catalog 惰性加载 ── */
const catalog = read('apps/catalog.js');
check('A9.htmlAndCatalogLoad',
  HTML.indexOf('assets/js/activity/activity-runtime.js') >= 0
  && HTML.indexOf('assets/js/activity/coread.js') >= 0
  && HTML.indexOf('ib-app-cinema.js') < 0
  && /"file":\s*"ib-app-cinema\.js"/.test(catalog)
  && exists('apps/ib-app-cinema.js') && exists('apps/ib-media-adapter.js'));

/* ── A10 event-bus 未被引入（广播仍是 UI/transport 局部）──────────── */
check('A10.noEventBus',
  !/\bIBEventBus\b|\bEventBus\b/.test(RT_CODE) && !/\bEventBus\b/.test(COMMUNICATION)
  && HTML.indexOf('event-bus') < 0);

console.log('\n' + (failed
  ? 'P27-0 activity wiring guard FAILED: ' + failed + ' failed / ' + passed + ' passed'
  : 'P27-0 activity wiring guard passed \u2714 (' + passed + ' checks, no production mutation)'));
process.exitCode = failed ? 1 : 0;
