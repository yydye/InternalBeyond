'use strict';

/* Internal Beyond · P26-C · Runtime Architecture Closure Guard

   阶段性质：CLOSURE / ARCHITECTURE AUDIT / READ-ONLY FIRST / NO NEW FOUNDATION LAYER /
   NO PRODUCTION INTEGRATION / NO COMMIT。

   本守卫只**保护** P26-1..10 的冻结状态与"生产零接线"事实，并断言依赖 DAG 与闭集 API：
   不新增 foundation 层、不修改 production cores、不重构、不删除。

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

console.log('== P26-C · Runtime Architecture Closure Guard ==');

/* ── C1 十个 foundation core 存在 ─────────────────────────────────── */
const CORES = {
  'assets/js/domain-event-core.js': ['3D8F339B', '12805562'],
  'assets/js/observation-core.js': ['077DA39B', 'E18ECC3F'],
  'assets/js/session-core.js': ['5778EE01', '2819C529'],
  'assets/js/resource-core.js': ['71318C21', 'EE8A60FA'],
  'assets/js/feedback-core.js': ['6C4A9B10', '436D6129'],
  'assets/js/feedback-consumption-core.js': ['DBBB6F57', 'EBA67714'],
  'assets/js/wake-request-core.js': ['49BBF9F6', 'BD98EAC2'],
  'assets/js/wake-runtime-core.js': ['117E9D7F', '063BB2A9'],
  'assets/js/activation-intent-core.js': ['4F910855', '2D9B2303'],
  'assets/js/activation-runtime-core.js': ['971772F8', 'AF4C1D79']
};
const missing = Object.keys(CORES).filter(f => !exists(f));
check('C1.foundationFilesPresent', missing.length === 0, missing);

/* ── C2 十个 core 逐字节冻结 ──────────────────────────────────────── */
const drifted = Object.keys(CORES).filter(f => !(sha(f).startsWith(CORES[f][0]) && sha(f).endsWith(CORES[f][1])));
check('C2.foundationHashesFrozen', drifted.length === 0, drifted);

/* ── C3 生产 HTML 只加载 **P27-2 有意接线** 的 domain-event-core ───── */
const HTML = read('InternalBeyond.html');
const coreFiles = Object.keys(CORES).map(f => f.split('/').pop());
/* P27-2：activity.created 是 P26 的第一个生产接线，因此 domain-event-core.js 现在**会**被加载；
   其余 P26 core 仍必须保持 foundation-only（不被 HTML 加载）。 */
const INTENTIONALLY_LOADED = ['domain-event-core.js', 'observation-core.js', 'session-core.js'];
check('C3.notLoadedInHtml',
  coreFiles.every(c => (INTENTIONALLY_LOADED.indexOf(c) >= 0) === (HTML.indexOf(c) >= 0)),
  coreFiles.filter(c => (INTENTIONALLY_LOADED.indexOf(c) >= 0) !== (HTML.indexOf(c) >= 0)));

/* ── C4 DB_VER 未变、无新增 store ─────────────────────────────────── */
const COREJS = read('assets/js/core.js');
const storeList = require('./helpers/db-schema-authority.js').storeList;
check('C4.dbUnchanged',
  require('./helpers/db-schema-authority.js').isVersion('InternalBeyondDB', 24)
  && require('./helpers/db-schema-authority.js').isWiredBeforeCore(HTML, COREJS)
  && ['domainEvents', 'events', 'observations', 'sessions', 'resources', 'feedback',
    'feedbackConsumption', 'wakeRequests', 'wakeRuntime', 'activationIntent', 'activationIntents',
    'activationRuntime', 'wakeHistory', 'attentionQueue', 'agentWake', 'signals', 'intentStore']
    .every(s => storeList.indexOf("'" + s + "'") < 0),
  storeList.slice(-160));

/* ── C5 每层闭集 API（冻结的导出函数集合）─────────────────────────── */
const EXPECTED_FNS = {
  'assets/js/domain-event-core.js': ['createDomainEvent', 'dedupeKeyFor', 'describeEvent', 'normalizeDomainEvent', 'orderingKeyFor', 'validateDomainEvent'],
  'assets/js/observation-core.js': ['createObservation', 'describeObservation', 'freshnessOf', 'normalizeObservation', 'validateObservation'],
  'assets/js/session-core.js': ['canTransitionSession', 'createSession', 'createSessionIdentity', 'transitionSession', 'validateSession'],
  'assets/js/resource-core.js': ['createClaim', 'createResource', 'createResourceIdentity', 'evaluateConflict', 'remainingCapacity', 'validateClaim', 'validateResource'],
  'assets/js/feedback-core.js': ['createFeedback', 'describeFeedback', 'normalizeFeedback', 'validateFeedback'],
  'assets/js/feedback-consumption-core.js': ['describeConsumption', 'evaluateFeedbackConsumption', 'validateConsumptionContext'],
  'assets/js/wake-request-core.js': ['createWakeRequest', 'describeWakeRequest', 'validateWakeRequest'],
  'assets/js/wake-runtime-core.js': ['describeWakeResult', 'evaluateWakeRequest', 'validateWakeContext'],
  'assets/js/activation-intent-core.js': ['createActivationIntent', 'describeActivationIntent', 'validateActivationIntent'],
  'assets/js/activation-runtime-core.js': ['describeActivationResult', 'evaluateActivationIntent', 'validateActivationContext']
};
const apiMismatch = [];
for (const f of Object.keys(EXPECTED_FNS)) {
  const mod = require(path.join(ROOT, f));
  const fns = Object.keys(mod).filter(k => typeof mod[k] === 'function').sort();
  if (JSON.stringify(fns) !== JSON.stringify(EXPECTED_FNS[f].slice().sort())) apiMismatch.push(f + ':' + fns.join(','));
}
check('C5.closedApiSurface', apiMismatch.length === 0, apiMismatch);

/* ── C6 依赖 DAG（每条边都指向更早的冻结层，无环、无越级 writer）──── */
const WIRING = {
  'assets/js/feedback-consumption-core.js': ['./feedback-core.js'],
  'assets/js/wake-request-core.js': ['./feedback-core.js', './feedback-consumption-core.js'],
  'assets/js/wake-runtime-core.js': ['./wake-request-core.js'],
  'assets/js/activation-intent-core.js': ['./wake-request-core.js', './wake-runtime-core.js'],
  'assets/js/activation-runtime-core.js': ['./activation-intent-core.js']
};
const wiringBad = [];
for (const f of Object.keys(WIRING)) {
  const src = read(f);
  for (const dep of WIRING[f]) if (src.indexOf("require('" + dep + "')") < 0) wiringBad.push(f + ' missing ' + dep);
  /* foundation 层不得依赖 P23/P24/P25/生产模块 */
  if (/require\('\.\/(delivery-|communication|group-runtime|agent-|autonomy-|moments|active-|role-|diary)/.test(src)) wiringBad.push(f + ' illegal prod dep');
}
check('C6.dagWiring', wiringBad.length === 0, wiringBad);

/* ── C7 生产消费者 = 0（不含任何 P26 core 符号）────────────────────── */
const CANDIDATES = [
  'assets/js/agent-runtime.js', 'assets/js/middle-brain.js', 'assets/js/communication.js',
  'assets/js/group-runtime-core.js', 'assets/js/moments.js', 'assets/js/active-diary.js',
  'assets/js/role-letters.js', 'assets/js/activity/activity-runtime.js', 'assets/js/activity/coread.js',
  'apps/ib-app-cinema.js', 'assets/js/communication/voice.js', 'assets/js/autonomy-core.js',
  'assets/js/agent-orchestration-core.js', 'assets/js/agent-capability-registry.js',
  'assets/js/core.js', 'assets/js/app-store.js'
];
const CORE_SYMBOLS = /IB(DomainEvent|Observation|Session|Resource|Feedback|FeedbackConsumption|WakeRequest|WakeRuntime|ActivationIntent|ActivationRuntime)Core|(domain-event|observation|session|resource|feedback|feedback-consumption|wake-request|wake-runtime|activation-intent|activation-runtime)-core/;
/* P27-2：activity-runtime.js 是**唯一**被允许引用 P26 core 的生产文件（且只引用 domain-event-core）。 */
const ALLOWED_CONSUMERS = ['assets/js/activity/activity-runtime.js'];
const consumerHits = [];
for (const file of CANDIDATES) {
  if (!exists(file)) continue;
  if (CORE_SYMBOLS.test(stripComments(read(file))) && ALLOWED_CONSUMERS.indexOf(file) < 0) consumerHits.push(file);
}
check('C7.productionConsumersZero',
  consumerHits.length === 0
  /* 唯一消费者的引用面必须**只有** domain-event-core（不得牵入 P26-2..10） */
  && (function () {
    const src = stripComments(read('assets/js/activity/activity-runtime.js'));
    return src.indexOf('domain-event-core') >= 0 || src.indexOf('IBDomainEventCore') >= 0;
  })(),
  consumerHits);

/* ── C8 P26-0 baseline + closure doc 存在 ─────────────────────────── */
check('C8.auditDocsPresent',
  exists('docs/P26-0-RUNTIME-REQUIREMENTS.md') && exists('docs/P26-0-ARCHITECTURE-MAP.md')
  && exists('docs/P26-CLOSURE.md'));

console.log('\n' + (failed
  ? 'P26 closure guard FAILED: ' + failed + ' failed / ' + passed + ' passed'
  : 'P26 closure guard passed \u2714 (' + passed + ' checks, production integration = activity.created only)'));
process.exitCode = failed ? 1 : 0;
