'use strict';

/* Internal Beyond · P25-3E · Activity Boundary Audit — 静态不变式守卫（A1–A15）

   本阶段是 **AUDIT / CLASSIFICATION / STRESS TEST**，不是实现：
     Production code changed = 0。

   因此本套件只做 static audit tests / contract guards：
     A1  primitive inventory complete（清单与仓库事实一致）
     A2  classification closed set（分类只用允许的闭集；文档表与清单一致）
     A3  no production registry change（未注册任何 activity capability）
     A4  no Activity Authority
     A5  Foundation unchanged（registry / orchestration core / autonomy core 逐字节）
     A6  Role Letter source unchanged
     A7  no global source expansion
     A8  no decision enum expansion
     A9  no Event Bus implementation
     A10 no new queue
     A11 no new session manager
     A12 P23 unchanged
     A13 P24 unchanged
     A14 M1 Activity runtime unchanged
     A15 no DB migration

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

/* ── 阶段开始时的生产文件哈希（P25-3E 不得改动任何生产逻辑）────────────── */
const FROZEN = {
  'assets/js/agent-capability-registry.js': ['78AE9DFE', '273BF7A2'],
  'assets/js/agent-orchestration-core.js': ['BA4A3DFA', 'AC204F79'],
  'assets/js/autonomy-core.js': ['FE1011F1', '9F2956F8'],
  /* P27-C：activity-runtime.js 的**整文件哈希**已移除（HASH_COUPLING_DEBT 结构性修复）——
     改用 tests/activity-partitions.js 的**语义分区**断言（见本文件下方的 activityRuntimeLegacyPartitionsUnchanged）。 */
  'assets/js/activity/coread.js': ['C3DCBD8D', '1D0ACAAD'],
  'apps/ib-app-cinema.js': ['CE581CF2', '65B97B58'],
  'apps/ib-media-adapter.js': null,                       /* 只校验存在与关键 API（见 A14） */
  'assets/js/role-letter-authority.js': ['1743B97D', '39387C90'],
  'assets/js/diary-authority.js': ['BBB7EC88', 'C95E73A9'],
  'assets/js/active-message-authority.js': ['CC2A8BF9', 'AE3892C4'],
  'assets/js/delivery-planner.js': ['15E7DBD0', 'E887308C'],
  'assets/js/delivery-runtime.js': ['82BC57D7', 'F7F46802'],
  'assets/js/delivery-sequence-core.js': ['5AE59648', 'FEB7EB35'],
  'assets/js/multimodal-delivery-policy.js': ['B7AFDFA6', 'ABC8B370'],
  'assets/js/voice-message-core.js': ['06907AA2', 'DEDDB258'],
  'assets/js/group-runtime-core.js': ['6F30FDE9', '067B35E8'],
  'assets/js/communication.js': ['DEB568A2', 'AC29184F']
};

/* ── 审计清单（与 docs/P25-3E-ACTIVITY-BOUNDARY-AUDIT.md 的表必须一致）── */
const CLASSES = ['SINGLE_EFFECT_COMMAND', 'LIFECYCLE_COMMAND', 'STATEFUL_RUNTIME',
  'READ_ONLY_OBSERVATION', 'RESOURCE_OPERATION', 'DOMAIN_EVENT', 'UI_EFFECT', 'UNKNOWN'];
const PLACEMENTS = ['FITS_CAPABILITY', 'FITS_DOMAIN_RUNTIME', 'FITS_OBSERVATION',
  'FITS_EXISTING_EVENT', 'FITS_UI_EFFECT', 'NO_CURRENT_HOME', 'NOT_PRESENT', 'UNKNOWN'];
const INVENTORY = [
  /* primitive, exists, class, placement */
  ['activity.create', true, 'SINGLE_EFFECT_COMMAND', 'FITS_CAPABILITY'],
  ['activity.read.getActivity', true, 'READ_ONLY_OBSERVATION', 'FITS_DOMAIN_RUNTIME'],
  ['activity.read.findActivity', true, 'READ_ONLY_OBSERVATION', 'FITS_DOMAIN_RUNTIME'],
  ['activity.read.listActivities', true, 'READ_ONLY_OBSERVATION', 'FITS_DOMAIN_RUNTIME'],
  ['activity.save', true, 'SINGLE_EFFECT_COMMAND', 'FITS_CAPABILITY'],
  ['activity.progress', true, 'SINGLE_EFFECT_COMMAND', 'FITS_CAPABILITY'],
  ['activity.delete', true, 'SINGLE_EFFECT_COMMAND', 'FITS_CAPABILITY'],
  ['activity.current.set', true, 'STATEFUL_RUNTIME', 'FITS_DOMAIN_RUNTIME'],
  ['activity.current.clear', true, 'STATEFUL_RUNTIME', 'FITS_DOMAIN_RUNTIME'],
  ['activity.current.resolve', true, 'STATEFUL_RUNTIME', 'FITS_DOMAIN_RUNTIME'],
  ['activity.context.build', true, 'READ_ONLY_OBSERVATION', 'FITS_DOMAIN_RUNTIME'],
  ['activity.send', true, 'SINGLE_EFFECT_COMMAND', 'FITS_DOMAIN_RUNTIME'],
  ['activity.openChat', true, 'UI_EFFECT', 'FITS_UI_EFFECT'],
  ['activity.memory.write', true, 'SINGLE_EFFECT_COMMAND', 'FITS_DOMAIN_RUNTIME'],
  ['activity.nudge', true, 'SINGLE_EFFECT_COMMAND', 'FITS_DOMAIN_RUNTIME'],
  ['activity.mark', true, 'DOMAIN_EVENT', 'NO_CURRENT_HOME'],
  ['activity.fav', true, 'UI_EFFECT', 'FITS_UI_EFFECT'],
  ['activity.event.subscribe', true, 'UI_EFFECT', 'FITS_EXISTING_EVENT'],
  ['activity.finish', false, 'LIFECYCLE_COMMAND', 'NOT_PRESENT'],
  ['activity.pause', false, 'LIFECYCLE_COMMAND', 'NOT_PRESENT'],
  ['activity.resume', false, 'LIFECYCLE_COMMAND', 'NOT_PRESENT'],
  ['activity.join', false, 'LIFECYCLE_COMMAND', 'NOT_PRESENT'],
  ['activity.leave', false, 'LIFECYCLE_COMMAND', 'NOT_PRESENT'],
  ['activity.suspend', false, 'LIFECYCLE_COMMAND', 'NOT_PRESENT'],
  ['activity.interrupt', false, 'LIFECYCLE_COMMAND', 'NOT_PRESENT'],
  ['cinema.open', true, 'SINGLE_EFFECT_COMMAND', 'FITS_DOMAIN_RUNTIME'],
  ['cinema.play', true, 'UI_EFFECT', 'FITS_UI_EFFECT'],
  ['cinema.pause', true, 'UI_EFFECT', 'FITS_UI_EFFECT'],
  ['cinema.seek', true, 'UI_EFFECT', 'FITS_UI_EFFECT'],
  ['cinema.progress', true, 'READ_ONLY_OBSERVATION', 'FITS_DOMAIN_RUNTIME'],
  ['cinema.subtitle', true, 'READ_ONLY_OBSERVATION', 'FITS_DOMAIN_RUNTIME'],
  ['cinema.frame', true, 'READ_ONLY_OBSERVATION', 'FITS_OBSERVATION'],
  ['cinema.nudge', true, 'SINGLE_EFFECT_COMMAND', 'FITS_DOMAIN_RUNTIME'],
  ['coread.open', true, 'SINGLE_EFFECT_COMMAND', 'FITS_DOMAIN_RUNTIME'],
  ['coread.page', true, 'SINGLE_EFFECT_COMMAND', 'FITS_CAPABILITY'],
  ['coread.bookmark', true, 'SINGLE_EFFECT_COMMAND', 'FITS_CAPABILITY'],
  ['coread.nudge', true, 'SINGLE_EFFECT_COMMAND', 'FITS_DOMAIN_RUNTIME'],
  ['presence.observe', false, 'READ_ONLY_OBSERVATION', 'NOT_PRESENT'],
  ['timeline.observe', false, 'READ_ONLY_OBSERVATION', 'NOT_PRESENT'],
  ['activity.session.ownership', false, 'RESOURCE_OPERATION', 'NO_CURRENT_HOME'],
  ['activity.event.started', false, 'DOMAIN_EVENT', 'NO_CURRENT_HOME'],
  ['activity.event.finished', false, 'DOMAIN_EVENT', 'NO_CURRENT_HOME'],
  ['activity.event.joined', false, 'DOMAIN_EVENT', 'NO_CURRENT_HOME'],
  ['activity.event.left', false, 'DOMAIN_EVENT', 'NO_CURRENT_HOME'],
  ['activity.event.paused', false, 'DOMAIN_EVENT', 'NO_CURRENT_HOME'],
  ['activity.event.progressed', false, 'DOMAIN_EVENT', 'NO_CURRENT_HOME']
];

console.log('== P25-3E · Activity Boundary Audit guards ==');

/* ── A1 primitive inventory complete ────────────────────────────────── */
const RT_SRC = read('assets/js/activity/activity-runtime.js');
const RT_CODE = stripComments(RT_SRC);
const CINEMA_SRC = read('apps/ib-app-cinema.js');
const COREAD_SRC = read('assets/js/activity/coread.js');
const MEDIA_SRC_EARLY = read('apps/ib-media-adapter.js');
/* 每个 exists=true 的 primitive 必须在生产源码里有**可指认的实现证据**（文件 + 片段）。 */
const EVIDENCE = {
  'activity.create': [RT_SRC, 'async function createActivity(p){'],
  'activity.read.getActivity': [RT_SRC, 'async function getActivity(id){'],
  'activity.read.findActivity': [RT_SRC, 'async function findActivity(type,roleId,resourceId){'],
  'activity.read.listActivities': [RT_SRC, 'async function listActivities(opts){'],
  'activity.save': [RT_SRC, 'async function saveActivity(id,patch){'],
  'activity.progress': [RT_SRC, 'async function setProgress(id,prog){'],
  'activity.delete': [RT_SRC, 'async function deleteActivity(id){'],
  'activity.current.set': [RT_SRC, 'async function setCurrent(activityId){'],
  'activity.current.clear': [RT_SRC, 'function clearCurrent(roleId,activityId){'],
  'activity.current.resolve': [RT_SRC, 'async function resolveActivity(friendId,opts){'],
  'activity.context.build': [RT_SRC, 'async function buildActivityContext(rec,opts){'],
  'activity.send': [RT_SRC, 'async function send(activityId,text,extra){'],
  'activity.openChat': [RT_SRC, 'function openChat(activityId){'],
  'activity.memory.write': [RT_SRC, 'async function writeMemory(activity,title,content){'],
  'activity.nudge': [RT_SRC, 'async function nudge(o){'],
  'activity.mark': [RT_SRC, 'async function mark(activityId,phase,label){'],
  'activity.fav': [RT_SRC, 'async function fav(activity,note){'],
  'activity.event.subscribe': [RT_SRC, 'function _on(id,ev,fn){'],
  'cinema.open': [CINEMA_SRC, "IB.activity.findActivity('cinema',_aiId,key)"],
  'cinema.play': [MEDIA_SRC_EARLY, 'play'],
  'cinema.pause': [MEDIA_SRC_EARLY, 'pause'],
  'cinema.seek': [MEDIA_SRC_EARLY, 'seek'],
  'cinema.progress': [CINEMA_SRC, 'IB.activity.setProgress(_activity.id,{sec:sec'],
  'cinema.subtitle': [CINEMA_SRC, 'function parseSubs(text){'],
  'cinema.frame': [CINEMA_SRC, 'function grabFrame('],
  'cinema.nudge': [CINEMA_SRC, 'IB.activity.nudge({activityId:_activity.id})'],
  'coread.open': [COREAD_SRC, "IB.activity.createActivity({type:'coread'"],
  'coread.page': [COREAD_SRC, 'IB.activity.setProgress(_activity.id,'],
  'coread.bookmark': [COREAD_SRC, 'IB.activity.saveActivity(_activity.id,{bookmarks:'],
  'coread.nudge': [COREAD_SRC, 'IB.activity.nudge({activityId:_activity.id})']
};
const missingEvidence = INVENTORY.filter(r => r[1] === true)
  .filter(r => { const e = EVIDENCE[r[0]]; return !e || e[0].indexOf(e[1]) < 0; })
  .map(r => r[0]);
check('A1.primitiveInventoryComplete',
  INVENTORY.length >= 40 && missingEvidence.length === 0
  && Object.keys(EVIDENCE).length === INVENTORY.filter(r => r[1] === true).length
  && !exists('assets/js/activity/activity-authority.js')
  && exists('assets/js/activity/activity-runtime.js') && exists('assets/js/activity/coread.js')
  && exists('apps/ib-app-cinema.js') && exists('apps/ib-media-adapter.js'),
  { missingEvidence: missingEvidence, evidence: Object.keys(EVIDENCE).length,
    claimed: INVENTORY.filter(r => r[1] === true).length });

/* 清单里的 "exists:false" 必须在生产源码里真的找不到入口（NOT_PRESENT 的证据） */
const PRODUCTION = ['assets/js/activity/activity-runtime.js', 'assets/js/activity/coread.js', 'apps/ib-app-cinema.js'];
const PROD_SRC = PRODUCTION.map(f => stripComments(read(f))).join('\n');
const notPresentOk = INVENTORY.filter(r => r[1] === false).every(r => {
  const bare = r[0].split('.').pop();
  return PROD_SRC.indexOf('function ' + bare + '(') < 0 && PROD_SRC.indexOf(bare + ':') < 0;
});
check('A1b.notPresentPrimitivesHaveNoEntryPoint', notPresentOk,
  INVENTORY.filter(r => r[1] === false).map(r => r[0]));

/* ── A2 classification closed set + 文档表一致 ──────────────────────── */
const DOC = read('docs/P25-3E-ACTIVITY-BOUNDARY-AUDIT.md');
/* 文档表列序（§33）：| Primitive | Exists | Class | Capability | Authority | Executor |
   Writer | Verify | Observation | Runtime | Event | Placement |
   → 解析：cells[1] = primitive，cells[3] = class，最后一个非空单元格 = placement。 */
const docRows = DOC.split(/\r?\n/)
  .filter(l => /^\|\s*`?[a-zA-Z]/.test(l) && l.split('|').length >= 6)
  .map(l => l.split('|').map(c => c.trim().replace(/`/g, '')))
  .map(cells => {
    const nonEmpty = cells.filter(c => c !== '');
    return { primitive: cells[1], cls: cells[3], placement: nonEmpty[nonEmpty.length - 1] };
  });
const badClass = INVENTORY.filter(r => CLASSES.indexOf(r[2]) < 0);
const badPlacement = INVENTORY.filter(r => PLACEMENTS.indexOf(r[3]) < 0);
const docMismatch = INVENTORY.filter(r => !docRows.some(row => row.primitive === r[0] && row.cls === r[2] && row.placement === r[3]));
check('A2.classificationClosedSet', badClass.length === 0 && badPlacement.length === 0 && docMismatch.length === 0,
  { badClass: badClass.map(r => r[0]), badPlacement: badPlacement.map(r => r[0]), docMismatch: docMismatch.map(r => r[0]), docRows: docRows.length });

/* ── A3 no production registry change（未注册 activity capability）──── */
const ASSET_JS = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full);
    else if (/\.js$/i.test(e.name)) ASSET_JS.push(path.relative(ROOT, full).replace(/\\/g, '/'));
  }
})(path.join(ROOT, 'assets', 'js'));
const activityCapabilityRefs = [];
for (const f of ASSET_JS) {
  if (/agent-orchestration-.*-adapter\.js$/.test(f)) continue;      /* adapter 只声明，不注册生产 */
  const code = stripComments(read(f));
  if (/register\w*Capabilities\(/.test(code) && code.indexOf('activity_message') >= 0) activityCapabilityRefs.push(f);
  if (/id:\s*['"]activity\.[a-z_.]+['"]/.test(code)) activityCapabilityRefs.push(f + ' (descriptor)');
}
check('A3.noProductionRegistryChange',
  activityCapabilityRefs.length === 0
  && RT_CODE.indexOf('IBAgentCapabilityRegistry') < 0 && RT_CODE.indexOf('register(') < 0
  && sha('assets/js/agent-capability-registry.js').startsWith('78AE9DFE'),
  activityCapabilityRefs);

/* ── A4 no Activity Authority ──────────────────────────────────────── */
const authoritySymbols = [];
for (const f of ASSET_JS.concat(['apps/ib-app-cinema.js'])) {
  const code = stripComments(read(f));
  if (/IBActivityAuthority|ActivityAuthority\b|activity-authority/.test(code)) authoritySymbols.push(f);
}
check('A4.noActivityAuthority',
  authoritySymbols.length === 0
  && !ASSET_JS.some(f => /activity.*authority/i.test(f))
  && !exists('assets/js/activity-authority.js')
  && !exists('assets/js/activity/activity-authority.js'),
  authoritySymbols);

/* ── A5 Foundation unchanged ───────────────────────────────────────── */
const foundationChanged = ['assets/js/agent-capability-registry.js', 'assets/js/agent-orchestration-core.js', 'assets/js/autonomy-core.js']
  .filter(f => !(sha(f).startsWith(FROZEN[f][0]) && sha(f).endsWith(FROZEN[f][1])));
check('A5.foundationUnchanged', foundationChanged.length === 0, foundationChanged);

/* ── A6 Role Letter source unchanged ───────────────────────────────── */
const RLA = require(path.join(ROOT, 'assets/js/role-letter-authority.js'));
check('A6.roleLetterSourceUnchanged',
  JSON.stringify(RLA.ROLE_LETTER_SOURCES) === JSON.stringify(['schedule', 'character'])
  && JSON.stringify(RLA.ROLE_LETTER_KINDS) === JSON.stringify(['init', 'reply'])
  && sha('assets/js/role-letter-authority.js').startsWith('1743B97D'),
  RLA.ROLE_LETTER_SOURCES);

/* ── A7 no global source expansion ─────────────────────────────────── */
const CORE_SRC = stripComments(read('assets/js/agent-orchestration-core.js'));
const orchestrationSources = (CORE_SRC.match(/ORCHESTRATION_SOURCES = Object\.freeze\(\[([^\]]*)\]\)/) || [])[1] || '';
const diaryA = require(path.join(ROOT, 'assets/js/diary-authority.js'));
const amA = require(path.join(ROOT, 'assets/js/active-message-authority.js'));
check('A7.noGlobalSourceExpansion',
  orchestrationSources.replace(/\s/g, '') === "'user','schedule','character','group_runtime','system'"
  && JSON.stringify(diaryA.DIARY_SOURCES) === JSON.stringify(['schedule', 'character', 'user'])
  && JSON.stringify(amA.ACTIVE_MESSAGE_SOURCES) === JSON.stringify(['schedule', 'plan', 'character', 'user', 'companion'])
  && orchestrationSources.indexOf('activity') < 0 && orchestrationSources.indexOf('event') < 0,
  orchestrationSources);

/* ── A8 no decision enum expansion ─────────────────────────────────── */
const decisionSets = [
  ['role-letter', JSON.stringify(RLA.ROLE_LETTER_DECISIONS)],
  ['diary', JSON.stringify(diaryA.DIARY_DECISIONS)],
  ['active-message', JSON.stringify(amA.ACTIVE_MESSAGE_DECISIONS)]
];
const autonomyCore = stripComments(read('assets/js/autonomy-core.js'));
check('A8.noDecisionEnumExpansion',
  decisionSets.every(d => d[1] === JSON.stringify({ ALLOW: 'allow', DENY: 'deny' }))
  && PROD_SRC.indexOf('DEFER') < 0 && PROD_SRC.indexOf("'defer'") < 0
  /* Autonomy Core 自己的闭集（allow / deny / defer）逐字未变 —— 三个 domain authority 的
     {ALLOW,DENY} 与它刻意分开，本阶段没有为 Activity 扩张任何 decision enum。 */
  && autonomyCore.indexOf("var AUTONOMY_DECISIONS = Object.freeze({ ALLOW: 'allow', DENY: 'deny', DEFER: 'defer' });") >= 0,
  decisionSets);

/* ── A9 no Event Bus implementation ───────────────────────────────── */
/* P26-1 之后：`assets/js/domain-event-core.js` 是**纯 Domain Event 契约**
   （P26-1 FROZEN），不是 Event Bus —— 因此 A9 允许它存在，但要求它自身**没有**
   订阅/发射/路由/listener 语义（否则 A9 才是被绕过）。 */
const busSymbols = [];
for (const f of ASSET_JS) {
  if (/domain-event-core\.js$/.test(f)) continue;
  const code = stripComments(read(f));
  if (/EventBus|event-bus|emitDomainEvent|IBDomainEvents/i.test(code)) busSymbols.push(f);
}
const DEC_SRC = stripComments(read('assets/js/domain-event-core.js'));
const decLooksLikeBus = /subscribe|EventBus|listener|dispatch|EventRouter|EventStore|SubscriptionManager/.test(DEC_SRC);
check('A9.noEventBusImplementation',
  busSymbols.length === 0
  && !ASSET_JS.some(f => /event-bus|eventbus/i.test(f))
  && decLooksLikeBus === false
  && RT_SRC.indexOf('emit:function(){}') >= 0,                    /* 既有 emit 仍是显式 no-op */
  { busSymbols: busSymbols, decLooksLikeBus: decLooksLikeBus });

/* ── A10 no new queue ─────────────────────────────────────────────── */
const queueFiles = ASSET_JS.filter(f => /activity.*queue|queue.*activity/i.test(f));
check('A10.noNewQueue',
  queueFiles.length === 0 && !exists('assets/js/activity-queue.js')
  && RT_CODE.indexOf('queue(') < 0 && RT_CODE.indexOf('Queue') < 0,
  queueFiles);

/* ── A11 no new session manager ───────────────────────────────────── */
const sessionSymbols = [];
for (const f of ASSET_JS) {
  const code = stripComments(read(f));
  if (/SessionManager|session-manager|activity-session/i.test(code)) sessionSymbols.push(f);
}
check('A11.noNewSessionManager',
  sessionSymbols.length === 0 && !ASSET_JS.some(f => /session-manager|activity-session/i.test(f)),
  sessionSymbols);

/* ── A12 P23 unchanged ────────────────────────────────────────────── */
const p23Changed = ['assets/js/delivery-planner.js', 'assets/js/delivery-runtime.js', 'assets/js/delivery-sequence-core.js',
  'assets/js/multimodal-delivery-policy.js', 'assets/js/voice-message-core.js']
  .filter(f => !(sha(f).startsWith(FROZEN[f][0]) && sha(f).endsWith(FROZEN[f][1])));
const p23Code = ['assets/js/delivery-planner.js', 'assets/js/delivery-runtime.js', 'assets/js/delivery-sequence-core.js',
  'assets/js/multimodal-delivery-policy.js'].map(f => stripComments(read(f))).join('\n');
check('A12.p23Unchanged',
  p23Changed.length === 0 && p23Code.indexOf('IBActivity') < 0 && p23Code.indexOf('IBActivityAuthority') < 0,
  p23Changed);

/* ── A13 P24 unchanged ────────────────────────────────────────────── */
const p24Code = stripComments(read('assets/js/group-runtime-core.js'));
check('A13.p24Unchanged',
  sha('assets/js/group-runtime-core.js').startsWith('6F30FDE9')
  && sha('assets/js/communication.js').startsWith('DEB568A2')
  && p24Code.indexOf('activity') < 0, sha('assets/js/group-runtime-core.js').slice(0, 8));

/* ── A14 M1 Activity runtime unchanged（P27-C：改用**语义分区**，不再整文件哈希）── */
const AP = require(path.join(__dirname, 'activity-partitions.js'));
const m1Changed = ['assets/js/activity/coread.js', 'apps/ib-app-cinema.js']
  .filter(f => !(sha(f).startsWith(FROZEN[f][0]) && sha(f).endsWith(FROZEN[f][1])));
const MEDIA_SRC = read('apps/ib-media-adapter.js');
check('A14.m1ActivityRuntimeUnchanged',
  m1Changed.length === 0
  && AP.legacyPartitionsMatch()
  && MEDIA_SRC.indexOf('root.IBMedia={resolveMedia:resolveMedia,createAdapter:createAdapter}') >= 0
  && RT_SRC.indexOf("var CUR_KEY='ib_activity_current_v1';") >= 0
  && RT_SRC.indexOf('function clearCurrent(roleId,activityId){') >= 0
  && RT_SRC.indexOf('async function resolveActivity(friendId,opts){') >= 0
  && RT_SRC.indexOf('function _usableFor(rec,roleId)') >= 0,
  m1Changed);

/* ── A15 no DB migration ──────────────────────────────────────────── */
const COREJS = read('assets/js/core.js');
const storeList = require('./helpers/db-schema-authority.js').storeList;
check('A15.noDbMigration',
  require('./helpers/db-schema-authority.js').isVersion('InternalBeyondDB', 24)
  && storeList.indexOf("'activities'") >= 0 && storeList.indexOf("'favorites'") >= 0
  && storeList.indexOf('activityQueue') < 0 && storeList.indexOf('activitySessions') < 0,
  storeList.slice(-120));

console.log('\n' + (failed
  ? 'P25-3E Activity boundary audit guards FAILED: ' + failed + ' failed / ' + passed + ' passed'
  : 'P25-3E Activity boundary audit guards passed \u2714 (' + passed + ' checks, production code unchanged)'));
process.exitCode = failed ? 1 : 0;
