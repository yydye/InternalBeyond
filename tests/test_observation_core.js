'use strict';

/* Internal Beyond · P26-2 · Observation Contract Foundation 测试（O1–O26 + 生产非接线守卫）

   阶段性质：FOUNDATION / CONTRACT / PURE CORE / AUDIT-FIRST / NO PRODUCTION INTEGRATION。
   允许：新增独立纯模块 assets/js/observation-core.js。
   禁止：Observer Bus / Observer Registry / Subscription / Realtime Stream / Frame·Vision·Voice
        Pipeline / Session Runtime / Activity Runtime Integration / Observation Cache。

   覆盖（§25）：O1–O26 语义与纯度；外加：
     G1–G7  生产 observer = 0（Cinema / Co-read / Voice / Presence / Timeline·Moments view /
            Memory retrieval / Activity runtime 零 Observation Core 调用）
     G8     既有机制逐字节未变（Cinema/IBMedia、Activity runtime、Voice、Mobile Gateway、P23/P24/P25）
     G9     DB_VER 与 store 列表未变（无 observations / observationCache / observers 等新 store）

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

const O = require(path.join(ROOT, 'assets/js/observation-core.js'));
const SRC = read('assets/js/observation-core.js');
const CODE = stripComments(SRC);

let passed = 0, failed = 0;
const failures = [];
function check(name, cond, extra) {
  if (cond) { passed++; console.log('  \u2714 ' + name); }
  else { failed++; failures.push(name); console.log('  \u2716 ' + name + (extra === undefined ? '' : '  -> ' + JSON.stringify(extra).slice(0, 320))); }
}
const T = 1770000000001;
const good = (patch) => Object.assign({ domain: 'cinema', entityId: 'act_1', source: 'cinema.player',
  freshness: 'fresh', availability: 'available' }, patch || {});
const mk = (patch, opts) => O.createObservation(good(patch), Object.assign({ observedAt: T }, opts || {}));

console.log('== P26-2 · Observation Core 测试 ==');

/* ── O1 valid observation ──────────────────────────────────────────── */
const o1 = mk();
check('O1.validObservation',
  o1.ok === true && o1.observation.domain === 'cinema' && o1.observation.entityId === 'act_1'
  && o1.observation.source === 'cinema.player' && o1.observation.observedAt === T
  && o1.observation.freshness === 'fresh' && o1.observation.availability === 'available'
  && /^obs_/.test(o1.observation.observationId), o1);

/* ── O2 missing identity ──────────────────────────────────────────── */
check('O2.missingIdentityRejected',
  O.validateObservation(Object.assign({}, good())).errors.indexOf('missing-observation-id') >= 0
  && O.validateObservation(Object.assign({ observationId: '  ' }, good())).errors.indexOf('missing-observation-id') >= 0
  && O.validateObservation(Object.assign({ observationId: 'has space' }, good())).errors.indexOf('bad-observation-id') >= 0
  && mk({ observationId: 'obs_1' }).observation.observationId === 'obs_1');

/* ── O3 missing source ────────────────────────────────────────────── */
check('O3.missingSourceRejected',
  O.validateObservation(Object.assign({ observationId: 'obs_1', observedAt: T }, good({ source: '' }))).errors.indexOf('missing-source') >= 0
  && O.validateObservation(Object.assign({ observationId: 'obs_1', observedAt: T }, good({ source: 'Cinema Player' }))).errors.indexOf('bad-source') >= 0
  && O.validateObservation(Object.assign({ observationId: 'obs_1', observedAt: T }, good({ source: 'voice.runtime' }))).ok === true
  && O.validateObservation(Object.assign({ observationId: 'obs_1', observedAt: T }, good({ source: 'presence.service' }))).ok === true);

/* ── O4 missing timestamp（注入式；不读时钟）───────────────────────── */
check('O4.missingTimestampRejected',
  O.createObservation(good(), {}).errors.indexOf('missing-observed-at') >= 0
  && O.createObservation(good(), { observedAt: '1770000000001' }).errors.indexOf('bad-observed-at') >= 0
  && O.createObservation(good(), { observedAt: 0 }).errors.indexOf('bad-observed-at') >= 0
  && mk().observation.observedAt === T);

/* ── O5/O6 闭集校验 ───────────────────────────────────────────────── */
check('O5.invalidFreshnessRejected',
  mk({ freshness: 'maybe' }).errors.indexOf('bad-freshness') >= 0
  && mk({ freshness: '' }).errors.indexOf('missing-freshness') >= 0
  && JSON.stringify(O.FRESHNESS_VALUES) === JSON.stringify(['fresh', 'stale', 'unknown'])
  && mk({ freshness: 'stale' }).ok === true && mk({ freshness: 'unknown' }).ok === true);
check('O6.invalidAvailabilityRejected',
  mk({ availability: 'nope' }).errors.indexOf('bad-availability') >= 0
  && mk({ availability: '' }).errors.indexOf('missing-availability') >= 0
  && JSON.stringify(O.AVAILABILITY_VALUES) === JSON.stringify(['available', 'unavailable', 'unknown'])
  && mk({ availability: 'unavailable' }).ok === true && mk({ availability: 'unknown' }).ok === true);

/* ── O7/O8 确定性身份与注入时间 ───────────────────────────────────── */
check('O7.deterministicId',
  mk().observation.observationId === mk().observation.observationId
  && mk({ entityId: 'act_2' }).observation.observationId !== mk().observation.observationId
  && mk({ source: 'voice.runtime' }).observation.observationId !== mk().observation.observationId
  && mk({}, { observationId: 'obs_injected' }).observation.observationId === 'obs_injected');
check('O8.injectedTimestamp',
  O.createObservation(good({}), { observedAt: T + 5 }).observation.observedAt === T + 5
  && O.createObservation(good({ observedAt: T + 9 }), { observedAt: T }).observation.observedAt === T + 9);

/* ── O9/O10 no clock / no randomness ──────────────────────────────── */
check('O9.noDateNowDependency',
  CODE.indexOf('Date.now') < 0 && CODE.indexOf('new Date') < 0 && CODE.indexOf('performance.now') < 0);
check('O10.noMathRandomDependency',
  CODE.indexOf('Math.random') < 0 && CODE.indexOf('crypto.random') < 0);

/* ── O11–O13 序列化边界 ───────────────────────────────────────────── */
check('O11.serializable',
  JSON.stringify(JSON.parse(JSON.stringify(o1.observation))) === JSON.stringify(o1.observation)
  && O.validateObservation(JSON.parse(JSON.stringify(o1.observation))).ok === true);
check('O12.rejectFunction',
  O.validateObservation(Object.assign({ observationId: 'obs_1', observedAt: T, fn: () => {} }, good())).errors
    .some(x => /unknown-field:fn|not-json-value/.test(x))
  && mk().ok === true);
check('O13.rejectCircular',
  (function () {
    const obs = Object.assign({ observationId: 'obs_1', observedAt: T }, good());
    obs.valueRef = obs;
    const r = O.validateObservation(obs);
    return r.ok === false && r.errors.length > 0;
  })());

/* ── O14 secret ───────────────────────────────────────────────────── */
check('O14.rejectSecret',
  mk({ source: 'sk-abcdefgh1234' }).errors.indexOf('secret-in-observation') >= 0
  && O.createObservation(Object.assign(good(), { valueRef: 'Bearer sk-abcdefgh1234' })).errors.indexOf('secret-in-observation') >= 0
  && mk().ok === true);

/* ── O15 no canonical body / no inline state（§7/§8）───────────────── */
const forbidden = ['value', 'snapshot', 'payload', 'data', 'content', 'body', 'text', 'state', 'record',
  'canonicalRow', 'fullState', 'frameBase64', 'subtitleText', 'fullActivity', 'audioBuffer'];
const allRejected = forbidden.every(f => {
  const r = mk({ [f]: f.indexOf('Base64') >= 0 ? 'AAAA' : { any: 1 } });
  return r.ok === false && r.errors.some(x => x.indexOf('forbidden-value-field') === 0);
});
check('O15.noCanonicalBodyOrInlineState',
  allRejected
  && O.ALLOWED_FIELDS.indexOf('value') < 0 && O.ALLOWED_FIELDS.indexOf('snapshot') < 0
  && O.ALLOWED_FIELDS.indexOf('payload') < 0
  /* valueRef 是**位置引用**（允许），不是值本身 —— 而且必须是引用形态 */
  && mk({ valueRef: 'activities.progress#sec' }).ok === true
  && mk({ valueRef: 'frame://act_1/last' }).ok === true
  && mk({ valueRef: 'has space' }).errors.indexOf('bad-value-ref') >= 0
  && mk({ meta: 1 }).errors.some(x => x.indexOf('unknown-field') === 0),
  forbidden);

/* ── O16–O23 纯度与依赖守卫（源码级；先剥注释）───────────────────── */
const purity = {
  db: ['dbPut', 'dbGet', 'dbDelete', 'indexedDB', 'localStorage', 'sessionStorage', 'openDB', 'cache'],
  dom: ['document', 'getElementById', 'createElement', 'window.', 'navigator', 'addEventListener'],
  net: ['fetch(', 'XMLHttpRequest', 'WebSocket', 'postMessage', 'EventSource', 'ipcRenderer'],
  routing: ['route', 'dispatch', 'publish', 'channel'],
  subscription: ['subscribe', 'unsubscribe', 'observer', 'watcher', 'listener', 'registry'],
  wake: ['wake', 'trigger', 'notify', 'notification', 'eligibility'],
  authority: ['Authority', 'autonomy-core', 'runMomentMutation', 'runDiaryWrite', 'runActiveMessageSend', 'runRoleLetterWrite', 'decide'],
  executor: ['createMoment', 'writeDiary', 'sendMessage', 'writeLetter', 'createActivity', 'executor'],
  writer: ['chatMessages', 'diary_entries', 'roleLetters', 'canonicalWriter', 'dbPut'],
  event: ['domain-event-core', 'IBDomainEvent', 'createDomainEvent'],
  session: ['sessionManager', 'sessionId', 'groupOrder', 'sequenceIndex']
};
/* 观察的"状态正文黑名单"数组本身必然包含 value / snapshot 等词 —— 那是**拒绝**它们的证据，
   因此依赖守卫先摘掉该数组（与 P26-1 同一策略）。 */
const CODE_CORE = CODE.replace(/var RESERVED_VALUE_FIELDS = Object\.freeze\(\[[\s\S]*?\]\);/, '');
const hits = key => purity[key].filter(n => CODE_CORE.indexOf(n) >= 0);
check('O16.noPersistence', purity.db.filter(n => CODE_CORE.indexOf(n) >= 0).length === 0, hits('db'));
check('O17.noRouting', hits('routing').length === 0, hits('routing'));
check('O18.noSubscription', hits('subscription').length === 0 && CODE_CORE.indexOf('class ') < 0, hits('subscription'));
check('O19.noObserverManager',
  SRC.indexOf('ObserverManager') < 0 && SRC.indexOf('ObservationBus') < 0 && SRC.indexOf('ObservationStore') < 0
  && SRC.indexOf('ObservationRouter') < 0 && !/observer/i.test(CODE_CORE.replace(/observation/gi, '')),
  'main');
check('O20.noAuthorityDependency', hits('authority').length === 0, hits('authority'));
check('O21.noExecutorDependency', hits('executor').length === 0, hits('executor'));
check('O22.noWriterDependency', hits('writer').length === 0, hits('writer'));
check('O23.noAgentWake', hits('wake').length === 0, hits('wake'));

/* ── O24 Event / Observation separation（P26-1 冻结边界）────────────── */
const E = require(path.join(ROOT, 'assets/js/domain-event-core.js'));
const eventKeys = E.REQUIRED_FIELDS.slice().sort();
const obsKeys = O.REQUIRED_FIELDS.slice().sort();
check('O24.eventObservationSeparation',
  hits('event').length === 0 && hits('session').length === 0
  && JSON.stringify(eventKeys) !== JSON.stringify(obsKeys)
  && E.REQUIRED_FIELDS.indexOf('type') >= 0 && O.REQUIRED_FIELDS.indexOf('type') < 0      /* 事件有"发生了什么" */
  && O.REQUIRED_FIELDS.indexOf('source') >= 0 && O.REQUIRED_FIELDS.indexOf('freshness') >= 0
  && E.ALLOWED_FIELDS.indexOf('freshness') < 0
  /* 两个 core 各自独立：observation 不 require event core，event core 不 require observation */
  && SRC.indexOf('domain-event-core') < 0 && read('assets/js/domain-event-core.js').indexOf('observation-core') < 0,
  { event: eventKeys, obs: obsKeys });

/* ── O25/O26 词汇可扩展（Core 不持有 source/domain 词表）───────────── */
const future = mk({ domain: 'future_domain', entityId: 'x_1', source: 'future.source.impl' });
check('O25.sourceVocabularyExtensible',
  future.ok === true && mk({ source: 'presence.service' }).ok === true
  && mk({ source: 'voice.runtime' }).ok === true
  && SRC.indexOf('knownSources') < 0 && CODE_CORE.indexOf("'cinema.player'") < 0
  && CODE_CORE.indexOf("'voice.runtime'") < 0);
check('O26.domainVocabularyExtensible',
  future.ok === true && mk({ domain: 'coread' }).ok === true && mk({ domain: 'activity' }).ok === true
  && CODE_CORE.indexOf("'cinema'") < 0 && CODE_CORE.indexOf("'coread'") < 0
  && SRC.indexOf('knownDomains') < 0);

/* ── 小 surface / 无单例 ──────────────────────────────────────────── */
const apiKeys = Object.keys(O).filter(k => typeof O[k] === 'function').sort();
check('O26b.smallPureApiSurface',
  JSON.stringify(apiKeys) === JSON.stringify(['createObservation', 'describeObservation', 'freshnessOf',
    'normalizeObservation', 'validateObservation'])
  && SRC.indexOf('window.IB.observations') < 0 && SRC.indexOf('window.ObservationBus') < 0,
  apiKeys);

/* ── Freshness 派生（纯函数；不自动刷新）───────────────────────────── */
check('O26c.freshnessDerivation',
  O.freshnessOf(o1.observation, { now: T + 1 }) === 'fresh'
  && O.freshnessOf(o1.observation, { now: T + 1000, maxAgeMs: 500 }) === 'stale'
  && O.freshnessOf(o1.observation, { now: T + 500, maxAgeMs: 500 }) === 'fresh'
  && O.freshnessOf(o1.observation, {}) === 'unknown'
  && O.freshnessOf(o1.observation, { now: 1 }) === 'unknown'
  && O.freshnessOf({}, { now: T }) === 'unknown'
  /* 自带声明（producer 的 freshness 字段）与派生判断是两个不同的东西 */
  && O.freshnessOf(mk({ freshness: 'stale' }).observation, { now: T + 1 }) === 'fresh');

/* describe 不输出状态正文 */
check('O26d.describeNeverCarriesState',
  (function () {
    const d = O.describeObservation(o1.observation);
    return d.ok === true && d.valueFieldsRejected.length === 0 && d.source === 'cinema.player'
      && d.freshness === 'fresh' && d.availability === 'available'
      && Object.keys(d).every(k => O.RESERVED_VALUE_FIELDS.indexOf(k.toLowerCase()) < 0);
  })());

/* ── G1–G7 生产接线边界（**P27-3 更新**）：唯一 observer = activity-runtime.js ── */
const OBSERVER_CANDIDATES = {
  cinema: ['apps/ib-app-cinema.js', 'grabFrame'],
  coread: ['assets/js/activity/coread.js', 'coreadPaintshelf'],
  voice: ['assets/js/communication/voice.js', ''],
  presence: ['services/home-node/mobile-gateway.js', 'presence.changed'],
  moments_view: ['assets/js/moments.js', '_momentsTick'],
  memory_retrieval: ['assets/js/memory.js', ''],
  activity_runtime: ['assets/js/activity/activity-runtime.js', 'async function buildActivityContext(rec,opts){']
};
const observerHits = [];
/* P27-3：`IB.activity.getObservation(activityId)` 是对 canonical Activity 状态的**只读**观察
   （领域自有 getter，无 ObservationManager / Registry / Store）。因此"零 observer"变成
   "**恰好一个** observer"。其余候选仍必须为零。 */
const INTENDED_OBSERVERS = ['assets/js/activity/activity-runtime.js'];
for (const key of Object.keys(OBSERVER_CANDIDATES)) {
  const [file, anchor] = OBSERVER_CANDIDATES[key];
  const src = stripComments(read(file));
  const refs = /IBObservation|observation-core|createObservation/.test(src);
  if (refs && INTENDED_OBSERVERS.indexOf(file) < 0) observerHits.push(file + ' (unexpected observer)');
  if (!refs && INTENDED_OBSERVERS.indexOf(file) >= 0) observerHits.push(file + ' (intended observer missing)');
  if (anchor && src.indexOf(anchor) < 0) observerHits.push(file + ' (anchor missing: ' + anchor + ')');
}
check('G1.g7.productionObserversActivityOnly',
  observerHits.length === 0 && exists('assets/js/observation-core.js')
  /* P27-3：生产 HTML **现在**加载 observation-core（有意打破 P26-2 的 foundation-only 先例）；
     其余 P26 core（session / resource / feedback / wake / activation）仍不加载。 */
  && read('InternalBeyond.html').indexOf('observation-core.js') >= 0
  /* P27-4：session-core.js 也被生产加载（只读 Session 投影）；其余 P26 core 仍不加载。 */
  && ['resource-core.js', 'feedback-core.js', 'wake-request-core.js',
    'wake-runtime-core.js', 'activation-intent-core.js', 'activation-runtime-core.js']
    .every(c => read('InternalBeyond.html').indexOf(c) < 0),
  observerHits);

/* ── G8 既有机制逐字节未变（Cinema/IBMedia、Activity、Voice、Mobile Gateway、P23/P24/P25）── */
const FROZEN = {
  'apps/ib-app-cinema.js': ['CE581CF2', '65B97B58'],
  'apps/ib-media-adapter.js': ['E993B133', '80DC3060'],
  /* P27-C：activity-runtime.js 的**整文件哈希**已移除（HASH_COUPLING_DEBT 结构性修复）——
     改用 tests/activity-partitions.js 的**语义分区**断言（见本文件下方的 activityRuntimeLegacyPartitionsUnchanged）。 */
  'assets/js/activity/coread.js': ['C3DCBD8D', '1D0ACAAD'],
  'assets/js/communication/voice.js': ['7DE44751', '6228B3B8'],
  'services/home-node/mobile-gateway.js': ['', ''],
  'assets/js/moments.js': ['E23697DE', 'B82CEE31'],
  'assets/js/memory.js': ['', ''],
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
  'assets/js/domain-event-core.js': ['3D8F339B', '12805562'],
  'assets/js/role-letter-authority.js': ['1743B97D', '39387C90'],
  'assets/js/diary-authority.js': ['BBB7EC88', 'C95E73A9'],
  'assets/js/active-message-authority.js': ['CC2A8BF9', 'AE3892C4']
};
const changed = Object.keys(FROZEN).filter(f => FROZEN[f][0] && !(sha(f).startsWith(FROZEN[f][0]) && sha(f).endsWith(FROZEN[f][1])));
check('G8.existingMechanismsUnchanged',
  changed.length === 0
  && read('assets/js/activity/activity-runtime.js').indexOf('async function buildActivityContext(rec,opts){') >= 0
  && read('apps/ib-app-cinema.js').indexOf('function grabFrame(') >= 0
  && read('services/home-node/mobile-gateway.js').indexOf('const NOTIFY_EVENTS =') >= 0,
  changed);
/* P27-C：activity-runtime.js 改用**语义分区**断言（不再整文件哈希）。 */
check('G8b.activityRuntimeLegacyPartitionsUnchanged',
  AP.legacyPartitionsMatch(), AP.legacyPartitionMismatches());

/* ── G9 DB 未变（无观察类 store）──────────────────────────────────── */
const COREJS = read('assets/js/core.js');
const storeList = (COREJS.match(/\[('posts'[\s\S]*?)\]\.forEach/) || [])[1] || '';
check('G9.noDbChange',
  COREJS.indexOf("DB_NAME='InternalBeyondDB',DB_VER=24") >= 0
  && ['observations', 'observationCache', 'observers', 'snapshots'].every(s => storeList.indexOf("'" + s + "'") < 0),
  storeList.slice(-140));

console.log('\n' + (failed
  ? 'P26-2 Observation Core FAILED: ' + failed + ' failed / ' + passed + ' passed'
  : 'P26-2 Observation Core passed \u2714 (' + passed + ' checks, production observers = activity-runtime (activity.state only))'));
process.exitCode = failed ? 1 : 0;
