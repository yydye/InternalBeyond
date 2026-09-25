'use strict';
/* Internal Beyond · P28-0 · Production Consumer & Agent Runtime Entry Guard
   阶段性质：READ-ONLY ARCHITECTURE AUDIT / EVIDENCE-FIRST /
   NO PRODUCTION MUTATION / NO NEW FOUNDATION / NO NEW MANAGER / NO EVENT BUS。
   把 P28-0 审计到的**运行时事实**固定下来（使后续阶段一旦偏离立即变红）：
     · `assets/js/agent-runtime.js` 是**真实存在且被生产消费**的 ModelPort 运行时
       （`IB.runtime.instance.execute` ← Active Message / Diary / Moments 三个域）；
     · P25-3A（orchestration core / capability registry）**未加载**、`runAgentPlan` 零生产调用；
     · `active_agent_runtime` 是 **Economy consumer 身份**（唯一 bind），**不是**模块路径；
     · P27 三项输出（activity.created / activity.state / getSession）**消费者仍为 0**；
     · Group Runtime（P24）由 communication.js 的生产分支调用；
     · Tool loop（autoContinue / maxRounds）归 communication.js（聊天执行器）；
     · DB_VER = 24、无新增 store。
   零浏览器、零网络。 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const stripComments = src => String(src).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const exists = f => fs.existsSync(path.join(ROOT, f));
let passed = 0, failed = 0;
const failures = [];
function check(name, cond, extra) {
  if (cond) { passed++; console.log('  \u2714 ' + name); }
  else { failed++; failures.push(name); console.log('  \u2716 ' + name + (extra === undefined ? '' : '  -> ' + JSON.stringify(extra).slice(0, 320))); }
}
console.log('== P28-0 · Runtime Entry Guard ==');
const HTML = read('InternalBeyond.html');
const RT_RAW = read('assets/js/agent-runtime.js');
const RT = stripComments(RT_RAW);
const AD = stripComments(read('assets/js/active-diary.js'));
const DY = stripComments(read('assets/js/active-diary/diary.js'));
const MO = stripComments(read('assets/js/moments.js'));
const COMM = stripComments(read('assets/js/communication.js'));
const COREJS = read('assets/js/core.js');
const storeList = (COREJS.match(/\[('posts'[\s\S]*?)\]\.forEach/) || [])[1] || '';
/* R1 真实存在的 ModelPort 运行时 */
check('R1.agentRuntimeIsRealAndLoaded',
  exists('assets/js/agent-runtime.js')
  && HTML.indexOf('assets/js/agent-runtime.js') >= 0
  && /NS\.expose\('runtime'/.test(RT)
  && RT.indexOf('instance: create()') >= 0
  && RT.indexOf('resolveModel(cfg)') >= 0 && RT.indexOf('async execute(request, options)') >= 0
  /* 单次 Model Execution 归 ModelPort；retry/round/FC 明确留在现有执行器 */
  && RT_RAW.indexOf('不引入新的 retry') >= 0 && RT.indexOf('retry') < 0);
/* R2 三个生产域消费它（真实调用点，不是注释） */
check('R2.consumedByThreeDomains',
  ['assets/js/active-diary.js', 'assets/js/active-diary/diary.js', 'assets/js/moments.js']
    .every(f => /IB\.runtime\.instance/.test(stripComments(read(f))))
  && /runtime\.execute\(/.test(AD) && /runtime\.execute\(/.test(DY) && /runtime\.execute\(/.test(MO)
  /* 可回滚：全局/分域开关 */
  && AD.indexOf('runtimeExecuteEnabled') >= 0 && MO.indexOf('runtimeMomentsExecuteEnabled') >= 0);
/* R3 P25-3A 未接线（contract, not runtime） */
check('R3.p25_3aFoundationOnly',
  HTML.indexOf('agent-orchestration-core.js') < 0
  && HTML.indexOf('agent-capability-registry.js') < 0
  && ['assets/js/active-diary.js', 'assets/js/moments.js', 'assets/js/role-letters.js',
    'assets/js/communication.js', 'assets/js/middle-brain.js']
    .every(f => !/runAgentPlan|validateAgentPlan|createCapabilityRegistry/.test(stripComments(read(f)))));
/* R4 active_agent_runtime = Economy consumer 身份（不是 runtime 模块） */
const ECON = read('services/home-node/economy-contract.js');
const ADAPTER = read('services/home-node/economy-action-adapter.js');
check('R4.activeAgentRuntimeIsEconomyConsumer',
  /ACTIVE_AGENT_RUNTIME:\s*'active_agent_runtime'/.test(ECON)
  /* 运行时锚点 = 既有 Active 组件（**不是**一个 agent-runtime 模块） */
  && /active_agent_runtime:\s*'runtime\/component-registry\.js#active'/.test(ECON)
  && ECON.indexOf("HOME_NODE_AUTHORITY: 'home_node_authority'") >= 0
  && ECON.indexOf("USER_DECISION_SEAM: 'user_decision_seam'") >= 0
  /* 装配里**只**绑 active_agent_runtime；其它 consumer id 一律不绑 */
  && ADAPTER.indexOf('gate.bind(C.ECONOMY_CONSUMER.ACTIVE_AGENT_RUNTIME)') >= 0
  && ['HOME_NODE_AUTHORITY', 'DESKTOP_BRIDGE', 'USER_DECISION_SEAM']
    .every(k => ADAPTER.indexOf('C.ECONOMY_CONSUMER.' + k) < 0)
  /* 它不是代码模块 */
  && !exists('assets/js/active_agent_runtime.js')
  && !exists('active/active_agent_runtime.js')
  && HTML.indexOf('active_agent_runtime') < 0);
/* R5 P27 三项输出消费者仍为 0 */
const PROD = ['assets/js/active-diary.js', 'assets/js/active-diary/diary.js', 'assets/js/moments.js',
  'assets/js/role-letters.js', 'assets/js/communication.js', 'assets/js/middle-brain.js',
  'assets/js/group-runtime-core.js', 'assets/js/activity/coread.js', 'apps/ib-app-cinema.js',
  'assets/js/app-store.js', 'active/scheduler.js', 'services/active-message-service.js'];
const p27Hits = PROD.filter(f => exists(f) && /getObservation|getSession|IBObservationCore|IBSessionCore|activity\.created/.test(stripComments(read(f))));
check('R5.p27ConsumersZero', p27Hits.length === 0, p27Hits);
/* R6 Group Runtime 在生产被调用（P24） */
check('R6.groupRuntimeIsProduction',
  COMM.indexOf('_gCore.planParticipation(') >= 0
  && COMM.indexOf('groupOrder') >= 0 && COMM.indexOf('groupTurnId') >= 0
  && exists('assets/js/group-runtime-core.js'));
/* R7 Tool loop 归 communication.js（聊天执行器），非新 runtime */
check('R7.toolLoopOwnedByChatExecutor',
  /maxRounds=opts\.autoContinue/.test(COMM) && /round>=maxRounds/.test(COMM)
  && COMM.indexOf('autoContinue:true') >= 0
  && !/maxRounds/.test(RT));
/* R8 Middle Brain 生成后收口在本位（不移交给 runtime） */
check('R8.middleBrainBoundaryPreserved',
  COMM.indexOf('middleBrainFinalizeReply') >= 0
  && exists('assets/js/middle-brain.js')
  && !/middleBrain/.test(RT));
/* R9 DB 未变 */
check('R9.dbUnchanged',
  COREJS.indexOf("DB_NAME='InternalBeyondDB',DB_VER=24") >= 0
  && ['agentRuntime', 'agentRuntimeState', 'runtimeQueue', 'consumers', 'agentSessions']
    .every(s => storeList.indexOf("'" + s + "'") < 0));
/* R10 无 Event Bus / Manager 新增 */
check('R10.noBusNoManager',
  !/AgentRuntimeManager|ConsumerManager|ConsumerRegistry|EventConsumerBus|WakeManager|ActivationManager|AgentScheduler|AgentQueue/
    .test(HTML.replace(/<!--[\s\S]*?-->/g, '') + RT + COMM)
  && !/\bEventBus\b/.test(RT + COMM));
console.log('\n' + (failed
  ? 'P28-0 runtime entry guard FAILED: ' + failed + ' failed / ' + passed + ' passed'
  : 'P28-0 runtime entry guard passed \u2714 (' + passed + ' checks, read-only audit evidence frozen)'));
process.exitCode = failed ? 1 : 0;
