'use strict';
/* Internal Beyond · P28-1 · Runtime Boundary Freeze Guard（F1–F15）
   阶段性质：ARCHITECTURE DECISION CLOSURE / BOUNDARY FREEZE / NO PRODUCTION IMPLEMENTATION /
   NO NEW RUNTIME / NO CONVERGENCE / NO EVENT BUS / NO SCHEMA CHANGE / NO COMMIT。
   本守卫冻结 **语义不变量**（**不用整文件哈希**）：见 docs/P28-1-AGENT-RUNTIME-BOUNDARY-FREEZE.md。
   零浏览器、零网络。 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const exists = f => fs.existsSync(path.join(ROOT, f));
const strip = src => String(src).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const htmlNoComments = () => read('InternalBeyond.html').replace(/<!--[\s\S]*?-->/g, '');
let passed = 0, failed = 0;
const failures = [];
function check(name, cond, extra) {
  if (cond) { passed++; console.log('  \u2714 ' + name); }
  else { failed++; failures.push(name); console.log('  \u2716 ' + name + (extra === undefined ? '' : '  -> ' + JSON.stringify(extra).slice(0, 320))); }
}
console.log('== P28-1 · Runtime Boundary Freeze Guard ==');
const HTML = htmlNoComments();
const RT = strip(read('assets/js/agent-runtime.js'));
const COMM = strip(read('assets/js/communication.js'));
const COREJS = read('assets/js/core.js');
const storeList = (COREJS.match(/\[('posts'[\s\S]*?)\]\.forEach/) || [])[1] || '';
/* F1 IB.runtime 仍是生产加载的**共享模型执行缝** */
check('F1.sharedModelSeamLoaded',
  exists('assets/js/agent-runtime.js') && HTML.indexOf('assets/js/agent-runtime.js') >= 0
  && /IB\.runtime\.instance/.test(RT) === false /* 定义处不是消费点 */
  && read('assets/js/agent-runtime.js').indexOf("NS.expose('runtime'") >= 0
  && RT.indexOf('instance: create()') >= 0
  && ['assets/js/active-diary.js', 'assets/js/active-diary/diary.js', 'assets/js/moments.js']
    .every(f => /IB\.runtime\.instance/.test(strip(read(f)))));
/* F2 P25-3A 未被生产加载 */
check('F2.p25_3aNotLoaded',
  HTML.indexOf('agent-orchestration-core.js') < 0
  && HTML.indexOf('agent-capability-registry.js') < 0);
/* F3 P25-3A 无生产 runAgentPlan 调用者 */
check('F3.noProductionRunAgentPlan',
  ['assets/js/active-diary.js', 'assets/js/active-diary/diary.js', 'assets/js/moments.js',
    'assets/js/role-letters.js', 'assets/js/communication.js', 'assets/js/middle-brain.js',
    'assets/js/activity/activity-runtime.js', 'assets/js/agent-runtime.js']
    .filter(f => exists(f) && /runAgentPlan|validateAgentPlan|createCapabilityRegistry/.test(strip(read(f)))).length === 0);
/* F4 active_agent_runtime 仍是 Economy consumer 身份（非模块/运行时入口） */
const ECON = read('services/home-node/economy-contract.js');
check('F4.activeAgentRuntimeStillConsumerIdentity',
  /ACTIVE_AGENT_RUNTIME:\s*'active_agent_runtime'/.test(ECON)
  && /active_agent_runtime:\s*'runtime\/component-registry\.js#active'/.test(ECON)
  && !exists('assets/js/active_agent_runtime.js') && !exists('active/active_agent_runtime.js')
  && HTML.indexOf('active_agent_runtime') < 0);
/* F5 P27 输出消费者状态冻结（created/session = 0；state = 走既有路径） */
const PROD = ['assets/js/active-diary.js', 'assets/js/active-diary/diary.js', 'assets/js/moments.js',
  'assets/js/role-letters.js', 'assets/js/communication.js', 'assets/js/middle-brain.js',
  'assets/js/group-runtime-core.js', 'assets/js/activity/coread.js', 'apps/ib-app-cinema.js',
  'assets/js/app-store.js', 'active/scheduler.js', 'services/active-message-service.js'];
check('F5.p27ConsumerStateFrozen',
  PROD.filter(f => exists(f) && /getObservation|getSession|IBObservationCore|IBSessionCore|activity\.created/.test(strip(read(f)))).length === 0
  /* 既有更丰富路径仍在（state 走 USE_EXISTING_PATH） */
  && read('assets/js/activity/activity-runtime.js').indexOf('async function getActivityContext(') >= 0
  && COMM.indexOf('getActivityContext') >= 0);
/* F6 P26-5..10 生产未接线 */
check('F6.p26_5to10Unwired',
  ['feedback-core.js', 'feedback-consumption-core.js', 'wake-request-core.js', 'wake-runtime-core.js',
    'activation-intent-core.js', 'activation-runtime-core.js'].every(c => HTML.indexOf(c) < 0)
  && !/IBFeedback|IBWakeRequest|IBWakeRuntime|IBActivationIntent|IBActivationRuntime/.test(
    ['assets/js/agent-runtime.js', 'assets/js/communication.js', 'assets/js/moments.js',
      'assets/js/active-diary.js', 'assets/js/role-letters.js'].map(f => strip(read(f))).join('\n')));
/* F7 P26-9/P26-10 仍非生产 */
check('F7.p26_9_10NonProduction',
  !exists('assets/js/activation-manager.js')
  && HTML.indexOf('activation-intent-core.js') < 0 && HTML.indexOf('activation-runtime-core.js') < 0);
/* F8 无 AgentRuntimeManager / ConsumerManager / Event Bus */
check('F8.noManagerNoBus',
  !/AgentRuntimeManager|ConsumerManager|ConsumerRegistry|EventConsumerBus|WakeManager|ActivationManager|AgentScheduler|AgentQueue/
    .test(HTML + RT + COMM)
  && !/\bEventBus\b/.test(RT + COMM));
/* F9 无 runtime / session / wake store */
check('F9.noRuntimeStores',
  ['agentRuntime', 'agentRuntimeState', 'runtimeQueue', 'consumers', 'agentSessions',
    'wakeRequests', 'wakeQueue', 'agentPlan'].every(s => storeList.indexOf("'" + s + "'") < 0));
/* F10 DB_VER = 24 */
check('F10.dbVersionFrozen', COREJS.indexOf("DB_NAME='InternalBeyondDB',DB_VER=24") >= 0);
/* F11 P23 交付所有权仍在 P23 */
check('F11.p23DeliveryOwnershipIntact',
  ['assets/js/delivery-planner.js', 'assets/js/delivery-runtime.js',
    'assets/js/delivery-sequence-core.js', 'assets/js/multimodal-delivery-policy.js']
    .every(exists)
  && !/delivery|typing|sequenceIndex/.test(RT));
/* F12 P24 群参与所有权仍在 P24 */
check('F12.p24GroupOwnershipIntact',
  exists('assets/js/group-runtime-core.js')
  && COMM.indexOf('planParticipation(') >= 0
  && !/groupTurnId|groupOrder|speakerId|planParticipation/.test(RT));
/* F13 域权威 / 域 writer 仍属域（agent-runtime 不写库、不裁决） */
const AUTHORITIES = ['assets/js/moments-mutation-authority.js', 'assets/js/diary-authority.js',
  'assets/js/active-message-authority.js', 'assets/js/role-letter-authority.js'];
check('F13.domainAuthorityAndWriterOwnership',
  AUTHORITIES.every(exists)
  && !/dbPut|dbDelete|localStorage|Authority|decide\(/.test(RT)
  && /_diaryWriteCanonical|_rlWriteCanonical|_activeWriteCanonical|_momentsWriteApprovedMoment/.test(
    ['assets/js/active-diary/diary.js', 'assets/js/role-letters.js', 'assets/js/active-diary.js', 'assets/js/moments.js']
      .map(f => read(f)).join('\n')));
/* F14 IB.runtime 未吞并 scheduler / authority / writer / delivery */
check('F14.modelSeamStaysNarrow',
  !/setInterval|setTimeout/.test(RT) && !/chatMessages/.test(RT)
  && !/queue|typing/.test(RT) && !/groupRuntime|activityRuntime/.test(RT)
  && read('assets/js/agent-runtime.js').indexOf('不引入新的 retry') >= 0);
/* F15 不存在统一 runtime 生产入口 */
check('F15.noUnifiedRuntimeEntry',
  !exists('assets/js/agent-runtime-manager.js') && !exists('assets/js/unified-agent-runtime.js')
  && !exists('assets/js/agent-entry.js') && !exists('active/agent-runtime.js')
  && HTML.indexOf('agent-runtime-manager') < 0 && HTML.indexOf('unified-agent-runtime') < 0);
console.log('\n' + (failed
  ? 'P28-1 runtime boundary freeze guard FAILED: ' + failed + ' failed / ' + passed + ' passed'
  : 'P28-1 runtime boundary freeze guard passed \u2714 (' + passed + ' checks, P28 runtime boundary frozen)'));
process.exitCode = failed ? 1 : 0;
