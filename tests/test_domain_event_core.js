'use strict';

/* Internal Beyond · P26-1 · Domain Event Contract Foundation 测试（E1–E36 + 生产非接线守卫）

   本阶段性质：FOUNDATION / CONTRACT / PURE CORE / TEST-FIRST。
   允许：少量、独立、无业务接线的 production foundation code（assets/js/domain-event-core.js）。
   禁止：REAL DOMAIN INTEGRATION / EVENT BUS / EVENT STORE / AGENT WAKE-UP / CROSS-RUNTIME ROUTING。

   覆盖（§48）：E1–E36 语义与纯度；外加：
     G1–G5  生产 canonical writer / Activity runtime **零** Domain Event 调用（Production emitters = 0）
     G6     既有事件式机制（Activity on/off/_emit、IBApps.broadcast、Active 事件队列、Mobile Gateway
            通知频道）逐字节未变
     G7     P23 / P24 / P25 Foundation / 四个 domain authority / Autonomy Core 逐字节未变
     G8     DB_VER 与 store 列表未变（无 events / domainEvents / eventLog / subscriptions / observers）

   零浏览器、零网络、零真实 provider。 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ROOT = path.resolve(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const AP = require(path.join(__dirname, 'activity-partitions.js'));/* P27-C 语义分区（替代整文件哈希） */
const exists = f => fs.existsSync(path.join(ROOT, f));
const sha = f => crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, f))).digest('hex').toUpperCase();
const stripComments = src => String(src).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const E = require(path.join(ROOT, 'assets/js/domain-event-core.js'));
const SRC = read('assets/js/domain-event-core.js');
const CODE = stripComments(SRC);

let passed = 0, failed = 0;
const failures = [];
function check(name, cond, extra) {
  if (cond) { passed++; console.log('  \u2714 ' + name); }
  else { failed++; failures.push(name); console.log('  \u2716 ' + name + (extra === undefined ? '' : '  -> ' + JSON.stringify(extra).slice(0, 320))); }
}
const T = 1770000000001;
const good = (patch) => Object.assign({ domain: 'moment', type: 'created', entityId: 'moment_1', timestamp: T }, patch || {});

console.log('== P26-1 · Domain Event Core 测试 ==');

/* ── E1 valid minimal event ─────────────────────────────────────────── */
const e1 = E.createDomainEvent(good());
check('E1.validMinimalEvent',
  e1.ok === true && e1.event.domain === 'moment' && e1.event.type === 'created'
  && e1.event.entityId === 'moment_1' && e1.event.timestamp === T
  && /^evt_/.test(e1.event.eventId), e1);

/* ── E2–E6 必填字段 ─────────────────────────────────────────────────── */
const miss = (patch) => E.createDomainEvent(Object.assign(good(), patch)).errors;
check('E2.missingEventIdRejected',
  E.validateDomainEvent(Object.assign(good(), { eventId: '' })).errors.indexOf('missing-event-id') >= 0
  && E.validateDomainEvent(Object.assign(good(), { eventId: '  ' })).errors.indexOf('missing-event-id') >= 0);
check('E3.missingDomainRejected',
  miss({ domain: '' }).indexOf('missing-domain') >= 0
  && miss({ domain: 'Moment Post' }).indexOf('bad-domain') >= 0
  && miss({ domain: 'moment!post' }).indexOf('bad-domain') >= 0);
check('E4.missingEventTypeRejected',
  miss({ type: '' }).indexOf('missing-event-type') >= 0
  && miss({ type: 'Created' }).indexOf('bad-event-type') >= 0
  && miss({ type: 'created/done' }).indexOf('bad-event-type') >= 0);
check('E5.missingEntityIdRejected',
  miss({ entityId: '' }).indexOf('missing-entity-id') >= 0
  && miss({ entityId: 'has space' }).indexOf('bad-entity-id') >= 0);
check('E6.missingTimestampRejected',
  miss({ timestamp: undefined }).indexOf('missing-timestamp') >= 0
  && miss({ timestamp: '1770000000001' }).indexOf('bad-timestamp') >= 0
  && miss({ timestamp: 0 }).indexOf('bad-timestamp') >= 0
  && miss({ timestamp: -5 }).indexOf('bad-timestamp') >= 0);

/* ── E7 invalid optional identifiers rejected ───────────────────────── */
check('E7.invalidOptionalIdentifiersRejected',
  miss({ actorId: ' ' }).indexOf('bad-actor-id') >= 0
  && miss({ origin: 'tick now' }).indexOf('bad-origin') >= 0
  && miss({ causationId: '#bad' }).indexOf('bad-causation-id') >= 0
  && miss({ correlationId: '#bad' }).indexOf('bad-correlation-id') >= 0
  && E.createDomainEvent(good({ actorId: 'role_a', origin: 'tick', causationId: 'evt_parent', correlationId: 'corr_1' })).ok === true);

/* ── E8 deterministic injected event id ─────────────────────────────── */
const a1 = E.createDomainEvent(good());
const a2 = E.createDomainEvent(good());
const injected = E.createDomainEvent(good(), { eventId: 'evt_injected' });
check('E8.deterministicInjectedEventId',
  a1.event.eventId === a2.event.eventId
  && E.createDomainEvent(good({ entityId: 'moment_2' })).event.eventId !== a1.event.eventId
  && injected.event.eventId === 'evt_injected');

/* ── E9 deterministic timestamp（注入，不读时钟）───────────────────── */
const t9 = E.createDomainEvent({ domain: 'diary', type: 'written', entityId: 'diary_1' }, { timestamp: T + 1 });
check('E9.deterministicTimestamp',
  t9.ok === true && t9.event.timestamp === T + 1
  && E.createDomainEvent({ domain: 'diary', type: 'written', entityId: 'diary_1' }).errors.indexOf('missing-timestamp') >= 0);

/* ── E10/E11 no clock / no randomness ───────────────────────────────── */
check('E10.noDateNowDependency',
  CODE.indexOf('Date.now') < 0 && CODE.indexOf('new Date') < 0 && CODE.indexOf('performance.now') < 0,
  'foundation 不得读取时钟');
check('E11.noMathRandomDependency',
  CODE.indexOf('Math.random') < 0 && CODE.indexOf('crypto.random') < 0,
  'foundation 不得使用随机');

/* ── E12 JSON serializable / E13 function / E14 circular ───────────── */
check('E12.jsonSerializable',
  (function () {
    const round = JSON.parse(JSON.stringify(e1.event));
    return E.validateDomainEvent(round).ok === true && JSON.stringify(round) === JSON.stringify(e1.event);
  })());
check('E13.functionRejected',
  E.validateDomainEvent(Object.assign(good(), { eventId: 'evt_1', fn: () => {} })).errors.some(x => /unknown-field:fn|not-json-value/.test(x))
  && E.createDomainEvent(good()).errors.length === 0);
check('E14.circularRejected',
  (function () {
    const ev = Object.assign({ eventId: 'evt_1' }, good());
    ev.correlationId = ev;
    const r = E.validateDomainEvent(ev);
    return r.ok === false && r.errors.length > 0;
  })());

/* ── E15 secret-shaped field rejected ──────────────────────────────── */
check('E15.secretShapedValueRejected',
  E.createDomainEvent(good({ origin: 'sk-abcdefgh1234' })).errors.indexOf('secret-in-event') >= 0
  && E.createDomainEvent(good({ entityId: 'Bearer sk-abcdefgh1234' })).ok === false
  && E.createDomainEvent(good({ actorId: 'role_a' })).ok === true);

/* ── E16 no business body slot ─────────────────────────────────────── */
const bodyFields = ['content', 'body', 'text', 'payload', 'record', 'snapshot', 'images', 'audio', 'base64', 'memory', 'summary', 'draft'];
const bodyRejected = bodyFields.every(f => {
  const r = E.createDomainEvent(Object.assign(good(), { [f]: '业务正文' }));
  return r.ok === false && r.errors.some(x => x.indexOf('forbidden-body-field') === 0);
});
check('E16.noBusinessBodySlot',
  bodyRejected
  && E.RESERVED_BODY_FIELDS.indexOf('content') >= 0 && E.RESERVED_BODY_FIELDS.indexOf('payloadrecord') >= 0
  && E.ALLOWED_FIELDS.indexOf('content') < 0 && E.ALLOWED_FIELDS.indexOf('body') < 0
  && E.createDomainEvent(Object.assign(good(), { meta: { anything: 1 } })).errors.some(x => x.indexOf('unknown-field') === 0));

/* ── E17 immutability ─────────────────────────────────────────────── */
check('E17.eventImmutable',
  Object.isFrozen(e1.event)
  && (function () { try { e1.event.domain = 'x'; } catch (e) { /* strict 抛错也接受 */ } return e1.event.domain === 'moment'; })()
  && (function () { const n = E.normalizeDomainEvent(Object.assign({ eventId: 'evt_1' }, good())); return n.ok === true && Object.isFrozen(n.event); })());

/* ── E18 dedupe key stable ────────────────────────────────────────── */
check('E18.dedupeKeyStable',
  E.dedupeKeyFor(e1.event) === E.dedupeKeyFor(a2.event)
  && E.dedupeKeyFor(e1.event) !== E.dedupeKeyFor(E.createDomainEvent(good({ entityId: 'moment_2' })).event)
  && E.dedupeKeyFor({}).length === 0 && E.dedupeKeyFor(e1.event).indexOf('de|') === 0);

/* ── E19/E20 ordering scoped / no global ordering ─────────────────── */
check('E19.orderingKeyScoped',
  E.orderingKeyFor(e1.event) === 'moment:moment_1' && E.orderingKeyFor(e1.event, 'entity') === 'moment:moment_1'
  && E.orderingKeyFor(e1.event, 'domain') === 'moment'
  && E.orderingKeyFor(e1.event, 'session') === '' && E.orderingKeyFor(e1.event, 'global') === ''
  && JSON.stringify(E.ORDERING_SCOPES) === JSON.stringify(['entity', 'domain']));
check('E20.noGlobalOrdering',
  CODE.indexOf('sequenceIndex') < 0 && CODE.indexOf('groupOrder') < 0
  && CODE.indexOf('globalSequence') < 0 && CODE.indexOf('counter') < 0
  && E.orderingKeyFor({ domain: 'moment', entityId: 'm1' }, 'domain') === E.orderingKeyFor({ domain: 'moment', entityId: 'm2' }, 'domain'));

/* ── E21/E22 causation / correlation semantics ─────────────────────── */
const caus = E.createDomainEvent(good({ causationId: 'evt_parent', correlationId: 'corr_1' }));
check('E21.causationSemantics',
  caus.ok === true && caus.event.causationId === 'evt_parent'
  && E.createDomainEvent(good()).ok === true                                   /* 默认 OPTIONAL */
  && E.createDomainEvent(good(), { requireCausation: true }).errors.indexOf('causation-required') >= 0
  && E.createDomainEvent(good({ causationId: 'evt_parent' }), { requireCausation: true }).ok === true,
  'causationId：字段级 OPTIONAL；可再触发路径由 options.requireCausation 变为 REQUIRED');
check('E22.correlationOptional',
  caus.event.correlationId === 'corr_1' && E.createDomainEvent(good()).ok === true
  && E.describeEvent(caus.event).hasCorrelation === true && E.describeEvent(e1.event).hasCorrelation === false);

/* ── E23/E24 vocabulary extensible（Core 不硬编码 domain / type）─────── */
const future = E.createDomainEvent({ domain: 'future_domain', type: 'something_happened', entityId: 'x_1', timestamp: T });
check('E23.domainVocabularyExtensible',
  future.ok === true && E.createDomainEvent({ domain: 'cinema', type: 'started', entityId: 'act_1', timestamp: T }).ok === true
  && CODE.indexOf("'moment'") < 0 && CODE.indexOf('"diary"') < 0
  && E.ALLOWED_FIELDS.indexOf('domain') >= 0 && SRC.indexOf('knownDomains') < 0,
  'Core 不持有全局 domain enum（只验证 token 语法）');
check('E24.eventTypeVocabularyExtensible',
  future.ok === true
  && E.createDomainEvent({ domain: 'moment', eventType: 'moment.created', entityId: 'm', timestamp: T }).event.type === 'created'
  && E.createDomainEvent({ domain: 'moment', eventType: 'diary.written', entityId: 'm', timestamp: T }).errors.indexOf('event-type-domain-mismatch') >= 0
  && CODE.indexOf('moment.created') < 0 && CODE.indexOf('role_letter.written') < 0,
  'eventType 采用 domain + type（单一词表持有者）；具体词汇由未来 domain integration 定义');

/* ── E25–E36 纯度与依赖守卫（源码级；先剥注释）──────────────────────── */
const purity = {
  db: ['dbPut', 'dbGet', 'dbDelete', 'indexedDB', 'localStorage', 'sessionStorage', 'openDB'],
  dom: ['document', 'getElementById', 'createElement', 'window.', 'navigator', 'addEventListener'],
  net: ['fetch(', 'XMLHttpRequest', 'WebSocket', 'postMessage', 'EventSource'],
  model: ['callApiChat', 'resolveModel', 'IB.runtime', 'provider', 'streaming'],
  authority: ['Authority', 'autonomy-core', 'runMomentMutation', 'runDiaryWrite', 'runActiveMessageSend', 'runRoleLetterWrite', 'decide'],
  executor: ['createMoment', 'writeDiary', 'sendMessage', 'writeLetter', 'createActivity', 'executor'],
  writer: ['chatMessages', 'diary_entries', 'roleLetters', 'canonicalWriter', 'dbPut'],
  p23: ['delivery-planner', 'delivery-runtime', 'delivery-sequence-core', 'multimodal-delivery-policy', 'sequenceIndex', 'turnId'],
  p24: ['group-runtime-core', 'groupOrder', 'groupTurnId', 'speakerId'],
  wake: ['wake', 'trigger', 'notify', 'notification'],
  bus: ['subscribe', 'on(', 'off(', 'emit(', 'dispatch', 'EventBus', 'listener', 'callback'],
  persist: ['persist', 'replay', 'acknowledg', 'queue', 'eventLog', 'appendEvent', 'EventStore']
};
/* 业务正文黑名单数组本身必然包含 store 名（'memories' / 'moments' …）——那正是**拒绝**它们的证据，
   因此依赖守卫在扫描前先把它摘掉，避免"用拒绝清单证明自己依赖了它"。 */
const CODE_CORE = CODE.replace(/var RESERVED_BODY_FIELDS = Object\.freeze\(\[[\s\S]*?\]\);/, '');
const hits = key => purity[key].filter(n => CODE_CORE.indexOf(n) >= 0);
check('E25.noDbAccess', hits('db').length === 0, hits('db'));
check('E26.noDomAccess', hits('dom').length === 0, hits('dom'));
check('E27.noNetworkAccess', hits('net').length === 0, hits('net'));
check('E28.noProviderOrModelAccess', hits('model').length === 0, hits('model'));
check('E29.noAuthorityDependency',
  hits('authority').length === 0 && CODE.indexOf('IBMomentsMutationAuthority') < 0
  && CODE.indexOf('IBDiaryAuthority') < 0 && CODE.indexOf('IBActiveMessageAuthority') < 0
  && CODE.indexOf('IBRoleLetterAuthority') < 0, hits('authority'));
check('E30.noExecutorDependency', hits('executor').length === 0, hits('executor'));
check('E31.noWriterDependency', hits('writer').length === 0, hits('writer'));
check('E32.noP23Dependency', hits('p23').length === 0, hits('p23'));
check('E33.noP24Dependency', hits('p24').length === 0, hits('p24'));
check('E34.noAgentWake', hits('wake').length === 0, hits('wake'));
check('E35.noSubscriptionBus',
  hits('bus').length === 0 && CODE.indexOf('class ') < 0
  && SRC.indexOf('EventBus') < 0 && SRC.indexOf('SubscriptionManager') < 0
  && SRC.indexOf('class EventEmitter') < 0 && SRC.indexOf('class EventStore') < 0
  && SRC.indexOf('class EventRouter') < 0, hits('bus'));
check('E36.noPersistenceReplayAck', hits('persist').length === 0, hits('persist'));

/* 纯函数面（§37/§38）：小 surface、无 class、无运行时单例 */
const apiKeys = Object.keys(E).filter(k => typeof E[k] === 'function').sort();
check('E36b.smallPureApiSurface',
  JSON.stringify(apiKeys) === JSON.stringify(['createDomainEvent', 'dedupeKeyFor', 'describeEvent',
    'normalizeDomainEvent', 'orderingKeyFor', 'validateDomainEvent'])
  && SRC.indexOf('window.IB.eventBus') < 0 && SRC.indexOf('window.IB.events') < 0
  && SRC.indexOf('window.DomainEventBus') < 0 && SRC.indexOf('new (class') < 0,
  apiKeys);

/* describeEvent 不得输出业务正文（§37） */
check('E36c.describeEventNeverCarriesBody',
  (function () {
    const d = E.describeEvent(e1.event);
    const keys = Object.keys(d);
    return keys.every(k => E.RESERVED_BODY_FIELDS.indexOf(k.toLowerCase()) < 0)
      && d.eventType === 'moment.created' && d.orderingKey === 'moment:moment_1'
      && d.bodyFieldsRejected.length === 0 && d.errors.length === 0;
  })());

/* ── G1–G5 生产接线边界（**P27-2 更新**）：唯一 emitter = activity-runtime.js ── */
const WRITERS = {
  moments: ['assets/js/moments.js', '_momentsWriteApprovedMoment'],
  diary: ['assets/js/active-diary/diary.js', '_diaryWriteCanonical'],
  active_message: ['assets/js/active-diary.js', '_activeWriteCanonical'],
  role_letter: ['assets/js/role-letters.js', '_rlWriteCanonical'],
  activity: ['assets/js/activity/activity-runtime.js', 'async function createActivity(p){']
};
/* P27-2：把 `activity.created`（**仅此一个事件**）接到 createActivity 的 canonical 写入之后。
   因此"零 emitter"变成"**恰好一个** emitter"：activity-runtime.js。其余 writer 仍必须为零。 */
const INTENDED_EMITTERS = ['assets/js/activity/activity-runtime.js'];
const emitterHits = [];
for (const key of Object.keys(WRITERS)) {
  const [file, anchor] = WRITERS[key];
  const src = stripComments(read(file));
  const refs = /IBDomainEvent|domain-event-core|createDomainEvent|createEvent\s*\(/.test(src);
  if (refs && INTENDED_EMITTERS.indexOf(file) < 0) emitterHits.push(file + ' (unexpected emitter)');
  if (!refs && INTENDED_EMITTERS.indexOf(file) >= 0) emitterHits.push(file + ' (intended emitter missing)');
  if (src.indexOf(anchor) < 0) emitterHits.push(file + ' (anchor missing: ' + anchor + ')');
}
check('G1.g5.productionEmittersActivityOnly',
  emitterHits.length === 0
  && exists('assets/js/domain-event-core.js')
  /* P27-2：生产 HTML **现在**加载 domain-event-core（有意打破 P26-1 的 foundation-only 先例，
     与 P25-2C 给 autonomy-core 补依赖同一先例）；其余 P26 core 仍不加载。 */
  && read('InternalBeyond.html').indexOf('domain-event-core.js') >= 0,
  emitterHits);

/* ── G6 既有事件式机制未变 ─────────────────────────────────────────── */
const FROZEN_MECH = {
  /* P27-C：activity-runtime.js 的整文件哈希已移除（改用语义分区断言，见 activityRuntimeLegacyPartitionsUnchanged）。 */
  'assets/js/activity/activity-runtime.js': ['', '', 'function _emit(id,ev,payload){', 'emit:function(){}'],
  'assets/js/app-store.js': ['', '', 'function broadcast(ev,payload){if(!_activeId||!_ev[_activeId]||!_ev[_activeId][ev])return;', ''],
  'services/active-message-service.js': ['F3B670A7', '9944FEFE', '', ''],
  'services/home-node/mobile-gateway.js': ['', '', 'const NOTIFY_EVENTS =', ''],
  'active/scheduler.js': ['8C4CE10C', 'C1695F75', '', '']
};
const mechanismBad = [];
for (const f of Object.keys(FROZEN_MECH)) {
  const [head, tail, needle1, needle2] = FROZEN_MECH[f];
  if (head && !(sha(f).startsWith(head) && sha(f).endsWith(tail))) mechanismBad.push(f + ' (hash)');
  const src = read(f);
  if (needle1 && src.indexOf(needle1) < 0) mechanismBad.push(f + ' (missing: ' + needle1.slice(0, 40) + ')');
  if (needle2 && src.indexOf(needle2) < 0) mechanismBad.push(f + ' (missing: ' + needle2 + ')');
}
check('G6.existingEventMechanismsUnchanged', mechanismBad.length === 0, mechanismBad);
/* P27-C：activity-runtime.js 的**事件机制**改用语义分区断言（不再整文件哈希）。 */
check('G6b.activityEventMechanismPartitionUnchanged',
  AP.partitionDigest('event_mechanism') === AP.LEGACY_DIGESTS.event_mechanism
  && AP.legacyPartitionsMatch(), AP.legacyPartitionMismatches());

/* ── G7 P23 / P24 / P25 / domain authorities 未变 ─────────────────── */
const G7 = {
  'assets/js/delivery-planner.js': ['15E7DBD0', 'E887308C'],
  'assets/js/delivery-runtime.js': ['82BC57D7', 'F7F46802'],
  'assets/js/delivery-sequence-core.js': ['5AE59648', 'FEB7EB35'],
  'assets/js/multimodal-delivery-policy.js': ['B7AFDFA6', 'ABC8B370'],
  'assets/js/voice-message-core.js': ['06907AA2', 'DEDDB258'],
  'assets/js/group-runtime-core.js': ['6F30FDE9', '067B35E8'],
  'assets/js/communication.js': ['DEB568A2', 'AC29184F'],
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
  'assets/js/agent-orchestration-role-letter-adapter.js': ['22495952', 'B11A07A2']
};
const g7Bad = Object.keys(G7).filter(f => !(sha(f).startsWith(G7[f][0]) && sha(f).endsWith(G7[f][1])));
check('G7.frozenStackUnchanged', g7Bad.length === 0, g7Bad);

/* ── G8 DB 未变（无事件类 store）────────────────────────────────────── */
const COREJS = read('assets/js/core.js');
const storeList = require('./helpers/db-schema-authority.js').storeList;
check('G8.noDbChange',
  require('./helpers/db-schema-authority.js').isVersion('InternalBeyondDB', 24)
  && ['events', 'domainEvents', 'eventLog', 'subscriptions', 'observers'].every(s => storeList.indexOf("'" + s + "'") < 0),
  storeList.slice(-140));

console.log('\n' + (failed
  ? 'P26-1 Domain Event Core FAILED: ' + failed + ' failed / ' + passed + ' passed'
  : 'P26-1 Domain Event Core passed \u2714 (' + passed + ' checks, production emitters = activity-runtime (activity.created only))'));
process.exitCode = failed ? 1 : 0;
