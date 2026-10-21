'use strict';

/* Internal Beyond · P26-4 · Resource Core 测试（R1–R16 + 生产非接线守卫）

   阶段性质：FOUNDATION / CONTRACT / PURE CORE / AUDIT-FIRST / NO PRODUCTION INTEGRATION。
   允许：新增独立纯模块 assets/js/resource-core.js。
   禁止：Resource Manager / Lease Store / Priority Engine / Scheduler / Lock Service /
        Queue System / Device Controller / Hardware Bridge / 任何真实 domain 接线。

   覆盖（§18）：R1–R16；外加：结果闭集与 determinism、无 body/secret、G1–G9 生产非接线与冻结守卫。
   零浏览器、零网络、零硬件、零真实 provider。 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ROOT = path.resolve(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const exists = f => fs.existsSync(path.join(ROOT, f));
const sha = f => crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, f))).digest('hex').toUpperCase();
const AP = require(path.join(__dirname, 'activity-partitions.js'));/* P27-C 语义分区（替代整文件哈希） */
const stripComments = src => String(src).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const R = require(path.join(ROOT, 'assets/js/resource-core.js'));
const SRC = read('assets/js/resource-core.js');
const CODE = stripComments(SRC);
/* 业务正文黑名单数组本身包含 content/handle 等词 —— 那是**拒绝**它们的证据，
   因此依赖守卫先摘掉该数组（与 P26-1/2/3 同一策略）。 */
const CODE_CORE = CODE.replace(/var RESERVED_BODY_FIELDS = Object\.freeze\(\[[\s\S]*?\]\);/, '');

let passed = 0, failed = 0;
const failures = [];
function check(name, cond, extra) {
  if (cond) { passed++; console.log('  \u2714 ' + name); }
  else { failed++; failures.push(name); console.log('  \u2716 ' + name + (extra === undefined ? '' : '  -> ' + JSON.stringify(extra).slice(0, 320))); }
}
const mic = () => R.createResource({ domain: 'voice', capacity: 1, resourceClass: 'exclusive', resourceId: 'mic.default' }).resource;
const net = () => R.createResource({ domain: 'network', capacity: 3, resourceId: 'net.default' }).resource;
const quota = () => R.createResource({ domain: 'model', capacity: 10, resourceClass: 'quota', resourceId: 'model.budget' }).resource;
const claim = (patch) => R.createClaim(Object.assign({ resourceId: 'mic.default', requesterId: 'role_a' }, patch || {})).claim;

console.log('== P26-4 · Resource Core 测试 ==');

/* ── R1 valid resource ────────────────────────────────────────────── */
const r1 = R.createResource({ domain: 'voice', capacity: 1, resourceClass: 'exclusive', resourceId: 'mic.default' });
check('R1.validResource',
  r1.ok === true && r1.resource.resourceId === 'mic.default' && r1.resource.domain === 'voice'
  && r1.resource.capacity === 1 && r1.resource.resourceClass === 'exclusive'
  && Object.isFrozen(r1.resource)
  && R.validateResource(r1.resource).ok === true
  && R.createResource({ domain: 'ui', capacity: 1 }).ok === true          /* 无 resourceClass 也合法 */
  && R.RESOURCE_CLASSES.indexOf('virtual') >= 0, r1);

/* ── R2 invalid identity ──────────────────────────────────────────── */
check('R2.invalidIdentityRejected',
  R.createResource({ domain: 'voice', capacity: 1, resourceId: 'has space' }).errors.indexOf('bad-resource-id') >= 0
  && R.validateResource({ resourceId: '', domain: 'voice', capacity: 1 }).errors.indexOf('missing-resource-id') >= 0
  && R.validateResource({ resourceId: 'mic', domain: '', capacity: 1 }).errors.indexOf('missing-domain') >= 0
  && R.validateResource({ resourceId: 'mic', domain: 'Voice System', capacity: 1 }).errors.indexOf('bad-domain') >= 0
  && R.validateResource({ resourceId: 'mic', domain: 'voice' }).errors.indexOf('missing-capacity') >= 0
  && R.validateResource({ resourceId: 'mic', domain: 'voice', capacity: 0 }).errors.indexOf('bad-capacity') >= 0
  && R.validateResource({ resourceId: 'mic', domain: 'voice', capacity: 1.5 }).errors.indexOf('bad-capacity') >= 0
  && R.validateResource({ resourceId: 'mic', domain: 'voice', capacity: 1, resourceClass: 'magic' }).errors.indexOf('bad-resource-class') >= 0
  && !/^res_$/.test(R.createResource({ domain: 'voice', capacity: 1 }).resource.resourceId));

/* ── R3 claim validation ──────────────────────────────────────────── */
check('R3.claimValidation',
  R.validateClaim({ resourceId: 'mic.default', requesterId: 'role_a' }).errors.indexOf('missing-claim-id') >= 0
  && R.validateClaim({ claimId: 'clm_1', requesterId: 'role_a' }).errors.indexOf('missing-claim-resource-id') >= 0
  && R.validateClaim({ claimId: 'clm_1', resourceId: 'mic.default' }).errors.indexOf('missing-requester-id') >= 0
  && R.validateClaim({ claimId: 'clm_1', resourceId: 'mic.default', requesterId: 'has space' }).errors.indexOf('bad-requester-id') >= 0
  && R.validateClaim({ claimId: 'clm_1', resourceId: 'mic.default', requesterId: 'role_a', amount: 0 }).errors.indexOf('bad-amount') >= 0
  && R.validateClaim({ claimId: 'clm_1', resourceId: 'mic.default', requesterId: 'role_a', sessionId: 'has space' }).errors.indexOf('bad-session-id') >= 0
  /* amount 默认 1；sessionId 可选（Session 只是可能的 requester 之一） */
  && claim().amount === 1 && claim({ amount: 2 }).amount === 2
  && claim({ sessionId: 'sess_x' }).sessionId === 'sess_x'
  && claim().sessionId === undefined
  && Object.isFrozen(claim()));

/* ── R4 deterministic id ──────────────────────────────────────────── */
const idA = R.createResourceIdentity({ domain: 'voice', capacity: 1 });
const idB = R.createResourceIdentity({ domain: 'voice', capacity: 1 });
const idC = R.createResourceIdentity({ domain: 'voice', capacity: 2 });
check('R4.deterministicIdentity',
  idA.ok === true && idA.resourceId === idB.resourceId && idA.resourceId !== idC.resourceId
  && R.createResourceIdentity({ domain: 'voice', capacity: 1 }, { resourceId: 'res_injected' }).resourceId === 'res_injected'
  && claim().claimId === claim().claimId
  && claim({ requesterId: 'role_b' }).claimId !== claim().claimId
  && claim({}, undefined) && R.createClaim({ resourceId: 'mic.default', requesterId: 'role_a' }, { claimId: 'clm_injected' }).claim.claimId === 'clm_injected',
  { a: idA.resourceId, c: idC.resourceId });

/* ── R5 conflict detection ────────────────────────────────────────── */
const holderA = claim({ claimId: 'clm_a', requesterId: 'role_a' });
const holderB = claim({ claimId: 'clm_b', requesterId: 'role_b' });
const bClaim2 = claim({ claimId: 'clm_b2', requesterId: 'role_b' });
check('R5.conflictDetection',
  /* 独占资源（capacity 1）：第一个 grant，第二个 conflict（不抢占、不排队） */
  R.evaluateConflict(mic(), holderA, []).decision === 'grant'
  && R.evaluateConflict(mic(), holderB, [holderA]).decision === 'conflict'
  && R.evaluateConflict(mic(), holderB, [holderA]).reason === 'capacity-full'
  /* 同一 requester 已持有（不同 claim id）⇒ conflict */
  && R.evaluateConflict(mic(), bClaim2, [holderB]).decision === 'conflict'
  && R.evaluateConflict(mic(), bClaim2, [holderB]).reason === 'requester-already-holds'
  /* 共享资源（capacity 3）：容量足够则 grant，超出则 conflict */
  && R.evaluateConflict(net(), claim({ claimId: 'clm_n1', resourceId: 'net.default' }), []).decision === 'grant'
  && R.evaluateConflict(net(), claim({ claimId: 'clm_n2', resourceId: 'net.default' }), [holderA]).decision === 'grant'
  && R.evaluateConflict(net(), claim({ claimId: 'clm_n3', resourceId: 'net.default', amount: 3 }),
    [{ claimId: 'clm_n1', resourceId: 'net.default', requesterId: 'role_a', amount: 1 },
      { claimId: 'clm_n2', resourceId: 'net.default', requesterId: 'role_c', amount: 1 }]).decision === 'conflict'
  /* quota 资源：按 amount 累计（capacity 10） */
  && R.evaluateConflict(quota(), claim({ claimId: 'clm_q1', resourceId: 'model.budget', amount: 7 }), []).decision === 'grant'
  && R.evaluateConflict(quota(), claim({ claimId: 'clm_q2', resourceId: 'model.budget', amount: 4 }), [{ claimId: 'clm_q1', resourceId: 'model.budget', requesterId: 'role_a', amount: 7 }]).decision === 'conflict'
  /* deny：amount 超上限 / 资源不匹配 */
  && R.evaluateConflict(mic(), claim({ claimId: 'clm_x', amount: 2 }), []).reason === 'amount-exceeds-capacity'
  && R.evaluateConflict(mic(), claim({ claimId: 'clm_y', resourceId: 'net.default' }), []).reason === 'resource-mismatch'
  /* holders 只按同一 resourceId 统计（别的资源的 holder 不影响本资源） */
  && R.evaluateConflict(mic(), holderA, [{ claimId: 'clm_z', resourceId: 'other.res', requesterId: 'role_z', amount: 1 }]).decision === 'grant'
  && R.remainingCapacity(mic(), [holderA]).remaining === 0
  && R.remainingCapacity(quota(), []).remaining === 10
  && JSON.stringify(R.ARBITRATION_DECISIONS) === JSON.stringify(['grant', 'conflict', 'deny']),
  { second: R.evaluateConflict(mic(), holderB, [holderA]) });

/* ── R16 deterministic result ─────────────────────────────────────── */
check('R16.deterministicResult',
  JSON.stringify(R.evaluateConflict(mic(), holderB, [holderA])) === JSON.stringify(R.evaluateConflict(mic(), holderB, [holderA]))
  && JSON.stringify(R.remainingCapacity(quota(), [holderA])) === JSON.stringify(R.remainingCapacity(quota(), [holderA]))
  && JSON.stringify(r1.resource) === JSON.stringify(R.createResource({ domain: 'voice', capacity: 1, resourceClass: 'exclusive', resourceId: 'mic.default' }).resource));

/* ── R6–R15 纯度与依赖守卫（源码级；先剥注释与拒绝清单）────────────── */
const purity = {
  hardware: ['navigator.mediaDevices', 'getUserMedia', 'getDisplayMedia', 'MediaRecorder', 'RTCPeerConnection', 'AudioContext', 'webkitAudioContext', 'requestAnimationFrame', 'element.requestFullscreen'],
  transport: ['fetch(', 'XMLHttpRequest', 'WebSocket', 'postMessage', 'ipcRenderer', 'socket'],
  db: ['dbPut', 'dbGet', 'dbDelete', 'indexedDB', 'localStorage', 'sessionStorage', 'openDB', 'lease', 'lockTable', 'TTL'],
  scheduler: ['setTimeout', 'setInterval', 'queue', 'schedule', 'tick'],
  priority: ['priority', 'preempt', 'wait', 'retry'],
  session: ['sessionManager', 'IBSessionCore', 'session-core', 'createSession', 'transitionSession'],
  capability: ['Authority', 'executor', 'createMoment', 'writeDiary', 'sendMessage', 'writeLetter', 'createActivity', 'decide'],
  observation: ['IBObservation', 'observation-core', 'createObservation', 'observationId'],
  event: ['IBDomainEvent', 'domain-event-core', 'createDomainEvent', 'emit', 'subscribe', 'EventBus', 'dispatch']
};
const hits = key => purity[key].filter(n => CODE_CORE.indexOf(n) >= 0);
check('R6.noHardwareAccess', hits('hardware').length === 0, hits('hardware'));
check('R7.noTransport', hits('transport').length === 0, hits('transport'));
check('R8.noPersistence',
  purity.db.filter(n => CODE_CORE.indexOf(n) >= 0).length === 0
  && SRC.indexOf('ResourceManager') < 0 && SRC.indexOf('LeaseStore') < 0 && SRC.indexOf('LockService') < 0,
  hits('db'));
check('R9.noScheduler', hits('scheduler').length === 0, hits('scheduler'));
check('R10.noPriorityEngine', hits('priority').length === 0, hits('priority'));
check('R11.noPreemption',
  hits('priority').length === 0 && CODE_CORE.indexOf('preempt') < 0
  && R.ARBITRATION_DECISIONS.indexOf('preempt') < 0
  && JSON.stringify(R.ARBITRATION_DECISIONS) === JSON.stringify(['grant', 'conflict', 'deny']),
  R.ARBITRATION_DECISIONS);
check('R12.noSessionOwnership', hits('session').length === 0, hits('session'));
check('R13.noCapabilityExecution', hits('capability').length === 0, hits('capability'));
check('R14.noObservationDependency', hits('observation').length === 0, hits('observation'));
check('R15.noEventBus', hits('event').length === 0 && CODE_CORE.indexOf('class ') < 0, hits('event'));

/* ── 无业务正文 / 无 secret / 无时钟 / 无随机 ─────────────────────── */
const bodyFields = ['content', 'body', 'payload', 'data', 'stream', 'buffer', 'base64', 'device', 'handle', 'file', 'path', 'credential'];
check('R15b.noBusinessBodySlot',
  bodyFields.every(f => {
    const a = R.createResource(Object.assign({ domain: 'voice', capacity: 1 }, { [f]: 'x' }));
    const b2 = R.createClaim(Object.assign({ resourceId: 'mic', requesterId: 'role_a' }, { [f]: 'x' }));
    return a.ok === false && a.errors.some(x => x.indexOf('forbidden-body-field') === 0)
      && b2.ok === false && b2.errors.some(x => x.indexOf('forbidden-body-field') === 0);
  })
  && R.createResource({ domain: 'voice', capacity: 1, meta: 1 }).errors.some(x => x.indexOf('unknown-field') === 0)
  && R.createResource({ domain: 'voice', capacity: 1, resourceId: 'sk-abcdefgh1234' }).errors.indexOf('secret-in-resource') >= 0
  && R.createClaim({ resourceId: 'mic', requesterId: 'role_a', sessionId: 'sk-abcdefgh1234' }).errors.indexOf('secret-in-resource') >= 0);
check('R15c.noClockNoRandom',
  CODE.indexOf('Date.now') < 0 && CODE.indexOf('new Date') < 0 && CODE.indexOf('performance.now') < 0
  && CODE.indexOf('Math.random') < 0 && CODE.indexOf('crypto.random') < 0);
const apiKeys = Object.keys(R).filter(k => typeof R[k] === 'function').sort();
check('R15d.smallPureApiSurface',
  JSON.stringify(apiKeys) === JSON.stringify(['createClaim', 'createResource', 'createResourceIdentity',
    'evaluateConflict', 'remainingCapacity', 'validateClaim', 'validateResource'])
  && SRC.indexOf('window.IB.resources') < 0 && SRC.indexOf('ResourceManager') < 0,
  apiKeys);

/* ── G1–G7 生产非接线：Resource Contract exists / Production resources = 0 ── */
const CANDIDATES = {
  cinema_playback: ['apps/ib-app-cinema.js', 'function grabFrame('],
  cinema_media: ['apps/ib-media-adapter.js', 'root.IBMedia={resolveMedia:resolveMedia,createAdapter:createAdapter}'],
  voice_channel: ['assets/js/communication/voice.js', ''],
  camera_frame: ['apps/ib-app-cinema.js', 'function grabFrame('],
  model_router: ['assets/js/agent-runtime.js', ''],
  mobile_foreground: ['services/home-node/mobile-gateway.js', 'const NOTIFY_EVENTS ='],
  active_message: ['assets/js/active-diary.js', 'async function _activeExecuteRun(run){']
};
const resourceHits = [];
for (const key of Object.keys(CANDIDATES)) {
  const [file, anchor] = CANDIDATES[key];
  const src = stripComments(read(file));
  if (/IBResource|resource-core|createResource|evaluateConflict|createClaim/.test(src)) resourceHits.push(file + ' (' + key + ')');
  if (anchor && src.indexOf(anchor) < 0) resourceHits.push(file + ' (anchor missing: ' + anchor + ')');
}
check('G1.g7.productionResourcesZero',
  resourceHits.length === 0 && exists('assets/js/resource-core.js')
  /* 生产 HTML 不加载 resource core（P26-1/2/3 同策略：foundation-only） */
  && read('InternalBeyond.html').indexOf('resource-core.js') < 0,
  resourceHits);

/* ── G8 冻结栈逐字节未变（P26-1/2/3 foundation + P23/P24/P25 + 域生产）── */
const FROZEN = {
  'assets/js/domain-event-core.js': ['3D8F339B', '12805562'],
  'assets/js/observation-core.js': ['077DA39B', 'E18ECC3F'],
  'assets/js/session-core.js': ['5778EE01', '2819C529'],
  /* Cinema v1.2: explicit versioned change to current Cinema and adapter snapshots. */
  /* Reviewed Cinema v1.2 source snapshot: 3A574786. */
  'apps/ib-app-cinema.js': ['3A574786', 'C1817BCD'],
  'apps/ib-media-adapter.js': ['D044541C', '0D0A5DDA'],
  'assets/js/communication/voice.js': ['7DE44751', '6228B3B8'],
  /* P27-C：activity-runtime.js 的**整文件哈希**已移除（HASH_COUPLING_DEBT 结构性修复）——
     改用 tests/activity-partitions.js 的**语义分区**断言（见本文件下方的 activityRuntimeLegacyPartitionsUnchanged）。 */
  'assets/js/active-diary.js': ['D14D4AC6', '89ADE8CA'],
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
  'assets/js/active-message-authority.js': ['CC2A8BF9', 'AE3892C4']
};
const changed = Object.keys(FROZEN).filter(f => !(sha(f).startsWith(FROZEN[f][0]) && sha(f).endsWith(FROZEN[f][1])));
check('G8.frozenStackUnchanged', changed.length === 0, changed);
/* P27-C：activity-runtime.js 改用**语义分区**断言（不再整文件哈希）。 */
check('G8b.activityRuntimeLegacyPartitionsUnchanged',
  AP.legacyPartitionsMatch(), AP.legacyPartitionMismatches());

/* ── G9 DB 未变（无 resource/lease/lock store）────────────────────── */
const COREJS = read('assets/js/core.js');
const storeList = require('./helpers/db-schema-authority.js').storeList;
check('G9.noDbChange',
  require('./helpers/db-schema-authority.js').isVersion('InternalBeyondDB', 24)
  && ['resources', 'resourceLeases', 'locks', 'leases', 'arbitration'].every(s => storeList.indexOf("'" + s + "'") < 0),
  storeList.slice(-140));

console.log('\n' + (failed
  ? 'P26-4 Resource Core FAILED: ' + failed + ' failed / ' + passed + ' passed'
  : 'P26-4 Resource Core passed \u2714 (' + passed + ' checks, production resources = 0)'));
process.exitCode = failed ? 1 : 0;
