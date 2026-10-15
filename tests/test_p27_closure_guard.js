'use strict';
/* Internal Beyond · P27-C · Activity Production Integration Closure Guard
   阶段性质：CLOSURE / PRODUCTION-INTEGRATION AUDIT / TEST-ARCHITECTURE CLEANUP /
   NO NEW DOMAIN FEATURE / NO NEW P26 WIRING / NO RESOURCE INTEGRATION / NO EVENT BUS。
   断言 P27 的高层冻结架构（C1–C12），并**在临时副本上**做变异测试证明分区守卫仍有效
   （不修改仓库任何文件）。零浏览器、零网络。 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const ROOT = path.resolve(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const stripComments = src => String(src).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const sha = f => require('crypto').createHash('sha256').update(fs.readFileSync(path.join(ROOT, f))).digest('hex').toUpperCase();
const AP = require(path.join(__dirname, 'activity-partitions.js'));
const RT = read('assets/js/activity/activity-runtime.js');
const RT_CODE = stripComments(RT);
const HTML = read('InternalBeyond.html');
const COREJS = read('assets/js/core.js');
const storeList = require('./helpers/db-schema-authority.js').storeList;
let passed = 0, failed = 0;
const failures = [];
function check(name, cond, extra) {
  if (cond) { passed++; console.log('  \u2714 ' + name); }
  else { failed++; failures.push(name); console.log('  \u2716 ' + name + (extra === undefined ? '' : '  -> ' + JSON.stringify(extra).slice(0, 320))); }
}
console.log('== P27-C · Activity Production Integration Closure Guard ==');
const PROD_JS = (function walk(dir, acc) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      /* The production scan must not traverse repository metadata or ignored
         build/test scratch; none of these directories are shipped producers. */
      if (!['.git', '.dsh-tmp', 'node_modules', 'target', 'dist', 'tmp'].includes(e.name)) walk(full, acc);
    }
    else if (/\.js$/i.test(e.name)) acc.push(path.relative(ROOT, full).replace(/\\/g, '/'));
  }
  return acc;
})(ROOT, []).filter(f => !/^(tests|docs|tools|runtime|game)\//.test(f));
/* C1 canonical Activity authority 唯一
   （`assets/js/core.js` 的 `dbPut('activities')` 属**既有**备份导入/恢复路径 importAll，
     不是 Activity 域 writer；除此之外全仓只有 activity-runtime 写 activities。） */
const ACTIVITY_FILES = ['assets/js/activity/activity-runtime.js', 'assets/js/activity/coread.js',
  'apps/ib-app-cinema.js', 'apps/ib-media-adapter.js', 'assets/js/communication.js', 'assets/js/app-store.js'];
const actWriters = ACTIVITY_FILES.filter(f => /dbPut\(\s*'activities'|dbDelete\(\s*'activities'|dbPut\(ACT_STORE|dbDelete\(ACT_STORE/.test(stripComments(read(f))));
const coreRestoreOnly = (function () {
  const code = stripComments(read('assets/js/core.js'));
  const at = code.indexOf("dbPut('activities'");
  if (at < 0) return true;
  return code.lastIndexOf('async function importAll', at) >= 0;
})();
check('C1.canonicalAuthorityUnique',
  JSON.stringify(actWriters) === JSON.stringify(['assets/js/activity/activity-runtime.js']) && coreRestoreOnly,
  actWriters);
/* C2 唯一生产 Activity Domain Event = activity.created */
check('C2.onlyActivityCreatedEvent',
  RT_CODE.split('createDomainEvent({').length === 2
  && /domain:'activity',type:'created'/.test(RT_CODE)
  && !/_emitActivity(Progressed|Finished|Deleted|SessionStarted)/.test(RT_CODE)
  && PROD_JS.filter(f => f !== 'assets/js/activity/activity-runtime.js'
    && f !== 'assets/js/domain-event-core.js'
    && /IBDomainEventCore|createDomainEvent/.test(stripComments(read(f)))).length === 0);
/* C3 唯一生产 Activity Observation = activity.state */
check('C3.onlyActivityStateObservation',
  RT_CODE.split('createObservation({').length === 2
  && RT_CODE.indexOf("source:'activity.state'") >= 0
  && PROD_JS.filter(f => f !== 'assets/js/activity/activity-runtime.js'
    && f !== 'assets/js/observation-core.js'
    && /IBObservationCore|createObservation/.test(stripComments(read(f)))).length === 0);
/* C4 getSession 只读投影 */
const gsBody = (function () {
  const i = RT_CODE.indexOf('async function getSession(');
  const j = RT_CODE.indexOf('\n  async function ', i + 10);
  return RT_CODE.slice(i, j > 0 ? j : i + 1400);
})();
check('C4.getSessionReadOnlyProjection',
  gsBody.length > 0
  && ['dbPut', 'dbDelete', 'localStorage', 'resolveActivity', 'transitionSession',
    'createDomainEvent', 'createObservation'].every(t => gsBody.indexOf(t) < 0)
  && gsBody.indexOf('getActivity(') >= 0 && gsBody.indexOf('createSession') >= 0
  && gsBody.indexOf('validateSession') >= 0);
/* C5 P27-5 Resource 未集成 */
check('C5.resourceUnintegrated',
  !/IBResourceCore|resource-core|evaluateConflict|createClaim/.test(RT_CODE)
  && HTML.indexOf('resource-core.js') < 0
  && !/grantResource|lockResource|claimResource/.test(RT_CODE));
/* C6 P26-5..10 未接线 */
check('C6.feedbackWakeUnwired',
  ['feedback-core.js', 'feedback-consumption-core.js', 'wake-request-core.js', 'wake-runtime-core.js',
    'activation-intent-core.js', 'activation-runtime-core.js'].every(c => HTML.indexOf(c) < 0)
  && !/IBFeedback|IBWakeRequest|IBWakeRuntime|IBActivationIntent|IBActivationRuntime/.test(RT_CODE));
/* C7 DB_VER = 24 且无新 store */
check('C7.dbUnchanged',
  require('./helpers/db-schema-authority.js').isVersion('InternalBeyondDB', 24)
  && ['events', 'domainEvents', 'observations', 'sessions', 'sessionIdentity', 'resources',
    'resourceClaims', 'feedback', 'wakeRequests', 'activationIntents', 'observationCache',
    'activityEvents', 'observeQueue'].every(s => storeList.indexOf("'" + s + "'") < 0));
/* C8 无 Event Bus / Manager / 新 store */
check('C8.noBusNoManagerNoStore',
  /* HTML 注释里出现"Event Bus"是在说明**没有**它 ⇒ 先剥 HTML 注释再判定 */
  !/\bEventBus\b|EventRouter|ObservationManager|ObservationRegistry|SessionManager|SessionRegistry|SessionStore|ActivityEventManager|ResourceManager|WakeManager/
    .test(HTML.replace(/<!--[\s\S]*?-->/g, '') + RT_CODE)
  && !/subscribe\(|addEventListener\('event'/.test(RT_CODE)
  && !/enqueue|backlog|scheduler|setInterval/.test(RT_CODE));
/* C9 只加载预期的 P26 core */
check('C9.onlyIntendedCoresLoaded',
  ['domain-event-core.js', 'observation-core.js', 'session-core.js'].every(c => HTML.indexOf(c) >= 0)
  && ['resource-core.js', 'feedback-core.js', 'feedback-consumption-core.js', 'wake-request-core.js',
    'wake-runtime-core.js', 'activation-intent-core.js', 'activation-runtime-core.js']
    .every(c => HTML.indexOf(c) < 0));
/* C10 Cinema / Co-read 所有权保持 */
check('C10.cinemaCoreadPreserved',
  sha('apps/ib-app-cinema.js').startsWith('CE581CF2')
  && sha('assets/js/activity/coread.js').startsWith('C3DCBD8D')
  && !/finishActivity|endSession/.test(stripComments(read('apps/ib-app-cinema.js')))
  && !/finishActivity|endSession/.test(stripComments(read('assets/js/activity/coread.js'))));
/* C11 P23 / P24 / P25 边界保持 */
check('C11.p23p24p25BoundariesPreserved',
  sha('assets/js/delivery-runtime.js').startsWith('82BC57D7')
  && sha('assets/js/communication.js').startsWith('DEB568A2')
  && sha('assets/js/group-runtime-core.js').startsWith('6F30FDE9')
  && sha('assets/js/autonomy-core.js').startsWith('FE1011F1')
  && !/sequenceIndex|groupOrder|groupTurnId|speakerId|autonomy/i.test(RT_CODE));
/* C12 hash-coupling 清理：不再依赖整文件哈希 + 变异测试仍有效 */
const GUARDS = ['test_domain_event_core.js', 'test_feedback_core.js', 'test_observation_core.js',
  'test_resource_core.js', 'test_session_core.js', 'test_p25_3e_activity_boundary_audit.js',
  'test_p26_0_runtime_requirements.js'];
const stillHashCoupled = GUARDS.filter(f => /activity-runtime\.js': \['[0-9A-Fa-f]{6,}/.test(read('tests/' + f)));
const usesPartitions = GUARDS.filter(f => /legacyPartitionsMatch|partitionDigest/.test(read('tests/' + f)));
/* 变异测试：在**字符串副本**上做，不写仓库文件 */
const mutCanonical = RT.replace("status:'active',createdAt:_now()", "status:'active',createdAt:_now(),tampered:1");
const mutPointer = RT.replace('all[String(roleId)]={activityId:String(activityId),at:_now()};',
  'all[String(roleId)]={activityId:String(activityId),at:_now()+1};');
const mutNewGetter = RT.replace('  /* ---- Current 指针显式读写',
  '  async function getTotallyUnrelatedGetter(x){return x;}\n  /* ---- Current 指针显式读写');
const mutAdapter = RT.replace('async function getSession(activityId){', 'async function getSession(activityId,extra){');
const unchangedOn = (src) => Object.keys(AP.PARTITIONS).every(k => AP.partitionDigest(k, src) === AP.partitionDigest(k, RT));
check('C12.hashCouplingDebtAddressed',
  stillHashCoupled.length === 0
  && usesPartitions.length === GUARDS.length
  && AP.legacyPartitionsMatch()
  /* 语义变化必须被检测 */
  && AP.partitionDigest('canonical_writer', mutCanonical) !== AP.partitionDigest('canonical_writer', RT)
  && AP.partitionDigest('pointer', mutPointer) !== AP.partitionDigest('pointer', RT)
  /* 新增独立 getter / 改 P27 适配器 **不应**触发既有分区重签 */
  && unchangedOn(mutNewGetter) && unchangedOn(mutAdapter)
  && AP.P27_ADAPTERS.every(a => RT_CODE.indexOf('function ' + a + '(') >= 0 || RT_CODE.indexOf(a + ':') >= 0),
  { stillHashCoupled: stillHashCoupled, usesPartitions: usesPartitions.length });
console.log('\n' + (failed
  ? 'P27 closure guard FAILED: ' + failed + ' failed / ' + passed + ' passed'
  : 'P27 closure guard passed \u2714 (' + passed + ' checks, P27 production integration = event + observation + session)'));
process.exitCode = failed ? 1 : 0;
