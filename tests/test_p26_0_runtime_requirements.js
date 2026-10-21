'use strict';

/* Internal Beyond · P26-0 · Runtime Architecture Requirements Closure — 静态守卫（R1–R17）

   本阶段是 AUDIT / REQUIREMENTS CLOSURE / ARCHITECTURE BOUNDARY MAPPING：
     Production code changed = 0。

   守卫（§44）：
     R1  production code zero change
     R2  no Event Bus implementation
     R3  no Observer implementation
     R4  no Session Manager
     R5  no Resource Manager
     R6  no new queue
     R7  no new scheduler
     R8  no capability registration
     R9  no source enum expansion
     R10 no decision enum expansion
     R11 P23 unchanged
     R12 P24 unchanged
     R13 P25 Foundation unchanged
     R14 domain authorities unchanged
     R15 Activity runtime unchanged
     R16 DB_VER / store list unchanged
     R17 requirements baseline documents 存在且包含必需的矩阵与候选表

   零浏览器、零网络、零真实 provider。 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ROOT = path.resolve(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const exists = f => fs.existsSync(path.join(ROOT, f));
const sha = f => crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, f))).digest('hex').toUpperCase();
const stripComments = src => String(src).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

let passed = 0, failed = 0;
const failures = [];
function check(name, cond, extra) {
  if (cond) { passed++; console.log('  \u2714 ' + name); }
  else { failed++; failures.push(name); console.log('  \u2716 ' + name + (extra === undefined ? '' : '  -> ' + JSON.stringify(extra).slice(0, 320))); }
}

/* ── 阶段开始快照（P26-0 不得改动任何生产逻辑）───────────────────────── */
const FROZEN = {
  'assets/js/delivery-planner.js': ['15E7DBD0', 'E887308C'],
  'assets/js/delivery-runtime.js': ['82BC57D7', 'F7F46802'],
  'assets/js/delivery-sequence-core.js': ['5AE59648', 'FEB7EB35'],
  'assets/js/multimodal-delivery-policy.js': ['B7AFDFA6', 'ABC8B370'],
  'assets/js/voice-message-core.js': ['06907AA2', 'DEDDB258'],
  'assets/js/group-runtime-core.js': ['6F30FDE9', '067B35E8'],
  'assets/js/agent-capability-registry.js': ['78AE9DFE', '273BF7A2'],
  'assets/js/agent-orchestration-core.js': ['BA4A3DFA', 'AC204F79'],
  'assets/js/autonomy-core.js': ['FE1011F1', '9F2956F8'],
  'assets/js/role-letter-authority.js': ['1743B97D', '39387C90'],
  'assets/js/diary-authority.js': ['BBB7EC88', 'C95E73A9'],
  'assets/js/active-message-authority.js': ['CC2A8BF9', 'AE3892C4'],
  'assets/js/moments-mutation-authority.js': ['1FBB1E12', '2FB5A056'],
  'assets/js/moments-autonomy.js': ['A4CEE6DA', 'C843CD1A'],
  'assets/js/agent-orchestration-moments-adapter.js': ['DA2506B9', 'EC6BD466'],
  'assets/js/agent-orchestration-diary-adapter.js': ['7D98217B', '34AA9805'],
  'assets/js/agent-orchestration-active-message-adapter.js': ['C1984C7F', '988C0DEE'],
  'assets/js/agent-orchestration-role-letter-adapter.js': ['22495952', 'B11A07A2'],
  /* P27-C：activity-runtime.js 的**整文件哈希**已移除（HASH_COUPLING_DEBT 结构性修复）——
     改用 tests/activity-partitions.js 的**语义分区**断言（见本文件下方的 activityRuntimeLegacyPartitionsUnchanged）。 */
  'assets/js/activity/coread.js': ['C3DCBD8D', '1D0ACAAD'],
  /* Reviewed Cinema v1.2 source snapshot: 3A574786. */
  'apps/ib-app-cinema.js': ['3A574786', 'C1817BCD'],
  'apps/ib-media-adapter.js': ['D044541C', '0D0A5DDA'],
  'assets/js/communication.js': ['DEB568A2', 'AC29184F'],
  'active/scheduler.js': ['8C4CE10C', 'C1695F75'],
  'active/plan-domain.js': ['55BEE8AA', '796BDAD6'],
  'active/model-client.js': ['3EA20D15', 'E640AFC9'],
  'services/active-message-service.js': ['F3B670A7', '9944FEFE']
};
const changedFrozen = () => Object.keys(FROZEN).filter(f => !(sha(f).startsWith(FROZEN[f][0]) && sha(f).endsWith(FROZEN[f][1])));

/* ── 生产文件全表（用于"没有新增生产模块"的证据）─────────────────────── */
const PROD_FILES = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') walk(full); }
    else if (/\.js$/i.test(e.name)) PROD_FILES.push(path.relative(ROOT, full).replace(/\\/g, '/'));
  }
})(ROOT);
const PROD_JS = PROD_FILES.filter(f => !/^(tests|docs|tools|runtime|game)\//.test(f) && !/^Economy-v1-release\//.test(f));
const PROD_CODE = PROD_JS.map(f => stripComments(read(f))).join('\n');
const forbiddenFiles = PROD_JS.filter(f => /(event-bus|eventbus|observer|observation-layer|session-manager|runtime-manager|resource-manager|arbiter|feedback-loop|activity-authority|event-log|event-store)/i.test(f));

console.log('== P26-0 · Runtime architecture requirements guards ==');

/* ── R1 production code zero change ────────────────────────────────── */
check('R1.productionCodeZeroChange',
  changedFrozen().length === 0
  && forbiddenFiles.length === 0
  && !exists('assets/js/event-bus.js') && !exists('assets/js/observer.js')
  && !exists('assets/js/observation-layer.js') && !exists('assets/js/session-manager.js')
  && !exists('assets/js/activity-authority.js'),
  { changed: changedFrozen(), forbidden: forbiddenFiles });

/* ── R2 no Event Bus implementation ───────────────────────────────── */
const busHits = PROD_JS.filter(f => /EventBus|IBDomainEvents|emitDomainEvent|event-bus|eventBus/.test(stripComments(read(f))));
const ACTIVITY_SRC = read('assets/js/activity/activity-runtime.js');
const APPSTORE_CODE = stripComments(read('assets/js/app-store.js'));
check('R2.noEventBusImplementation',
  busHits.length === 0
  && ACTIVITY_SRC.indexOf('emit:function(){}') >= 0                    /* 既有 emit 仍是显式 no-op */
  /* 既有广播仍是"只投给当前打开的 App"的本地回调（无持久化 / 无跨运行时投递） */
  && APPSTORE_CODE.indexOf('function broadcast(ev,payload){if(!_activeId||!_ev[_activeId]||!_ev[_activeId][ev])return;') >= 0,
  busHits);

/* ── R3 no Observer implementation ────────────────────────────────── */
const observerHits = PROD_JS.filter(f => /IBObserver|registerObserver|ObservationLayer|observation-layer/.test(stripComments(read(f))));
check('R3.noObserverImplementation',
  observerHits.length === 0 && !exists('assets/js/observer.js') && !exists('assets/js/observation-layer.js'),
  observerHits);

/* ── R4 no Session Manager ────────────────────────────────────────── */
const sessionHits = PROD_JS.filter(f => /SessionManager|session-manager|sessionRuntime|IBsessionManager/.test(stripComments(read(f))));
check('R4.noSessionManager',
  sessionHits.length === 0 && !exists('assets/js/session-manager.js') && !exists('assets/js/runtime-manager.js'),
  sessionHits);

/* ── R5 no Resource Manager ───────────────────────────────────────── */
const resourceHits = PROD_JS.filter(f => /ResourceManager|resource-manager|resourceLease|acquireLease|LockManager/.test(stripComments(read(f))));
check('R5.noResourceManager',
  resourceHits.length === 0 && !exists('assets/js/resource-manager.js') && !exists('assets/js/arbiter.js'),
  resourceHits);

/* ── R6 no new queue ─────────────────────────────────────────────── */
const queueFiles = PROD_JS.filter(f => /(activity|domain|runtime|event).*queue|queue.*(activity|domain|runtime|event)/i.test(f));
check('R6.noNewQueue',
  queueFiles.length === 0
  && ACTIVITY_SRC.indexOf('queue(') < 0 && ACTIVITY_SRC.indexOf('Queue') < 0
  /* 既有队列语义只在 P23 delivery-runtime（已冻结）里 */
  && read('assets/js/delivery-runtime.js').indexOf("var STATES = ['queued', 'delivering', 'completed', 'cancelled', 'failed'];") >= 0,
  queueFiles);

/* ── R7 no new scheduler ─────────────────────────────────────────── */
const schedulerFiles = PROD_JS.filter(f => /scheduler|schedule-manager/i.test(f));
check('R7.noNewScheduler',
  JSON.stringify(schedulerFiles.sort()) === JSON.stringify(['active/scheduler.js'])
  && !exists('assets/js/scheduler.js') && !exists('services/scheduler.js'),
  schedulerFiles);

/* ── R8 no capability registration ───────────────────────────────── */
const capabilityHits = [];
for (const f of PROD_JS) {
  if (/agent-orchestration-.*-adapter\.js$/.test(f)) continue;         /* adapter 只声明 descriptor */
  const code = stripComments(read(f));
  if (/registerRoleLetterCapabilities|registerDiaryCapabilities|registerActiveMessageCapabilities|registerMomentsCapabilities/.test(code)) capabilityHits.push(f);
  if (/createCapabilityRegistry\s*\(/.test(code) && !/agent-capability-registry\.js$/.test(f)) capabilityHits.push(f + ' (registry instantiation)');
}
check('R8.noCapabilityRegistration',
  capabilityHits.length === 0
  && sha('assets/js/agent-capability-registry.js').startsWith('78AE9DFE')
  /* 生产里的 capability **声明**只允许出现在四个既有 adapter 里，且域集合不得新增
     （本阶段没有注册任何 activity / session / event 能力）。 */
  && JSON.stringify((function () {
    const domains = new Set();
    for (const f of PROD_JS) {
      if (!/agent-orchestration-.*-adapter\.js$/.test(f)) continue;
      const ids = stripComments(read(f)).match(/id:\s*'([a-z_]+)\.[a-z_.]+'/g) || [];
      ids.forEach(s => domains.add(s.replace(/^id:\s*'/, '').split('.')[0]));
    }
    return [...domains].sort();
  })()) === JSON.stringify(['active_message', 'diary', 'moment', 'role_letter']),
  capabilityHits);

/* ── R9 no source enum expansion ─────────────────────────────────── */
const CORE_SRC = stripComments(read('assets/js/agent-orchestration-core.js'));
const orchestrationSources = (CORE_SRC.match(/ORCHESTRATION_SOURCES = Object\.freeze\(\[([^\]]*)\]\)/) || [])[1] || '';
const RLA = require(path.join(ROOT, 'assets/js/role-letter-authority.js'));
const DA = require(path.join(ROOT, 'assets/js/diary-authority.js'));
const AMA = require(path.join(ROOT, 'assets/js/active-message-authority.js'));
/* source 词汇的"落点"文件面：任何新 source vocabulary 都必然出现在这些文件之一。 */
const SOURCE_SCOPE_CODE = ['assets/js/agent-orchestration-core.js', 'assets/js/role-letter-authority.js',
  'assets/js/diary-authority.js', 'assets/js/active-message-authority.js', 'assets/js/moments-autonomy.js',
  'assets/js/moments-mutation-authority.js', 'assets/js/activity/activity-runtime.js',
  'assets/js/activity/coread.js', 'apps/ib-app-cinema.js'].map(f => stripComments(read(f))).join('\n');
check('R9.noSourceEnumExpansion',
  orchestrationSources.replace(/\s/g, '') === "'user','schedule','character','group_runtime','system'"
  && JSON.stringify(RLA.ROLE_LETTER_SOURCES) === JSON.stringify(['schedule', 'character'])
  && JSON.stringify(DA.DIARY_SOURCES) === JSON.stringify(['schedule', 'character', 'user'])
  && JSON.stringify(AMA.ACTIVE_MESSAGE_SOURCES) === JSON.stringify(['schedule', 'plan', 'character', 'user', 'companion'])
  /* source 词汇落点文件里没有任何 activity / session / event 形态的 source 值 */
  && !/source\s*[:=]\s*['"](activity|session|event)['"]/.test(SOURCE_SCOPE_CODE)
  && orchestrationSources.indexOf('activity') < 0 && orchestrationSources.indexOf("'event'") < 0,
  orchestrationSources);

/* ── R10 no decision enum expansion ──────────────────────────────── */
const AUTONOMY_CODE = stripComments(read('assets/js/autonomy-core.js'));
check('R10.noDecisionEnumExpansion',
  JSON.stringify(RLA.ROLE_LETTER_DECISIONS) === JSON.stringify({ ALLOW: 'allow', DENY: 'deny' })
  && JSON.stringify(DA.DIARY_DECISIONS) === JSON.stringify({ ALLOW: 'allow', DENY: 'deny' })
  && JSON.stringify(AMA.ACTIVE_MESSAGE_DECISIONS) === JSON.stringify({ ALLOW: 'allow', DENY: 'deny' })
  && AUTONOMY_CODE.indexOf("var AUTONOMY_DECISIONS = Object.freeze({ ALLOW: 'allow', DENY: 'deny', DEFER: 'defer' });") >= 0
  && ACTIVITY_SRC.indexOf('DEFER') < 0 && ACTIVITY_SRC.indexOf('PAUSE') < 0,
  'Autonomy Core 自己的闭集保持；三个 domain authority 仍是 {ALLOW,DENY}');

/* ── R11 P23 / R12 P24 / R13 Foundation / R14 authorities / R15 Activity ── */
const group = {
  p23: ['assets/js/delivery-planner.js', 'assets/js/delivery-runtime.js', 'assets/js/delivery-sequence-core.js',
    'assets/js/multimodal-delivery-policy.js', 'assets/js/voice-message-core.js'],
  p24: ['assets/js/group-runtime-core.js', 'assets/js/communication.js'],
  foundation: ['assets/js/agent-capability-registry.js', 'assets/js/agent-orchestration-core.js', 'assets/js/autonomy-core.js'],
  authorities: ['assets/js/role-letter-authority.js', 'assets/js/diary-authority.js', 'assets/js/active-message-authority.js',
    'assets/js/moments-mutation-authority.js', 'assets/js/moments-autonomy.js',
    'assets/js/agent-orchestration-moments-adapter.js', 'assets/js/agent-orchestration-diary-adapter.js',
    'assets/js/agent-orchestration-active-message-adapter.js', 'assets/js/agent-orchestration-role-letter-adapter.js'],
  activity: ['assets/js/activity/coread.js', 'apps/ib-app-cinema.js', 'apps/ib-media-adapter.js']
};
const changedIn = list => list.filter(f => !(sha(f).startsWith(FROZEN[f][0]) && sha(f).endsWith(FROZEN[f][1])));
check('R11.p23Unchanged', changedIn(group.p23).length === 0, changedIn(group.p23));
check('R12.p24Unchanged', changedIn(group.p24).length === 0, changedIn(group.p24));
check('R13.p25FoundationUnchanged', changedIn(group.foundation).length === 0, changedIn(group.foundation));
check('R14.domainAuthoritiesUnchanged', changedIn(group.authorities).length === 0, changedIn(group.authorities));
check('R15.activityRuntimeUnchanged', changedIn(group.activity).length === 0, changedIn(group.activity));
/* P27-C：activity-runtime.js 改用**语义分区**断言（不再整文件哈希）——
   P27-2/3/4 只在**既有分区之外**新增领域适配器，因此这些不变量必须仍然成立。 */
const AP = require(path.join(__dirname, 'activity-partitions.js'));
check('R15b.activityRuntimeLegacyPartitionsUnchanged',
  AP.legacyPartitionsMatch(), AP.legacyPartitionMismatches());

/* ── R16 DB_VER / store list unchanged ──────────────────────────── */
const COREJS = read('assets/js/core.js');
const storeList = require('./helpers/db-schema-authority.js').storeList;
check('R16.dbVerAndStoresUnchanged',
  require('./helpers/db-schema-authority.js').isVersion('InternalBeyondDB', 24)
  && storeList.indexOf("'activities'") >= 0 && storeList.indexOf("'disclosureFacts'") >= 0
  && storeList.indexOf("'events'") < 0 && storeList.indexOf("'domainEvents'") < 0
  && storeList.indexOf("'activityEvents'") < 0 && storeList.indexOf("'sessions'") < 0
  && storeList.indexOf("'observations'") < 0,
  storeList.slice(-140));

/* ── R17 requirements baseline documents ────────────────────────── */
const REQ_DOC = read('docs/P26-0-RUNTIME-REQUIREMENTS.md');
const MAP_DOC = read('docs/P26-0-ARCHITECTURE-MAP.md');
const scopeRows = REQ_DOC.split(/\r?\n/).filter(l => /^\|\s*`?[A-Za-z]/.test(l) && l.split('|').length >= 6).length;
const vocabTerms = ['EVENT', 'OBSERVATION', 'STATE', 'POINTER', 'PROJECTION', 'COMMAND',
  'AUTHORITY DECISION', 'EXECUTION', 'DELIVERY', 'FEEDBACK', 'SESSION', 'RESOURCE OWNERSHIP'];
const missingTerms = vocabTerms.filter(t => MAP_DOC.indexOf('| ' + t + ' |') < 0);
check('R17.requirementsBaselineDocuments',
  REQ_DOC.indexOf('MINIMAL_P26') >= 0 && REQ_DOC.indexOf('Candidate') >= 0
  && REQ_DOC.indexOf('HARD_REQUIREMENT') >= 0 && REQ_DOC.indexOf('P26 Non-Goals') >= 0
  && MAP_DOC.indexOf('CURRENT ARCHITECTURE') >= 0 && MAP_DOC.indexOf('REQUIREMENT MAP') >= 0
  && MAP_DOC.indexOf('| Gap |') >= 0 && MAP_DOC.indexOf('| Concern |') >= 0
  && scopeRows >= 12 && missingTerms.length === 0,
  { scopeRows: scopeRows, missingTerms: missingTerms });

console.log('\n' + (failed
  ? 'P26-0 runtime requirements guards FAILED: ' + failed + ' failed / ' + passed + ' passed'
  : 'P26-0 runtime requirements guards passed \u2714 (' + passed + ' checks, production code unchanged)'));
process.exitCode = failed ? 1 : 0;
