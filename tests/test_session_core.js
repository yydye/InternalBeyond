'use strict';

/* Internal Beyond · P26-3 · Session Runtime Contract Foundation 测试（S1–S19 + 生产非接线守卫）

   阶段性质：FOUNDATION / CONTRACT / PURE CORE / AUDIT-FIRST / NO PRODUCTION INTEGRATION。
   允许：新增独立纯模块 assets/js/session-core.js。
   禁止：Session Manager / Store / Router / Bus / Realtime Sync / Presence / Voice·Cinema
        Session Runtime；任何真实 domain 接线。

   覆盖（§19）：S1–S19；外加：小 surface、迁移表闭集、G1–G9 生产非接线与冻结守卫。
   零浏览器、零网络、零真实 provider。 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ROOT = path.resolve(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const exists = f => fs.existsSync(path.join(ROOT, f));
const sha = f => crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, f))).digest('hex').toUpperCase();
const stripComments = src => String(src).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const S = require(path.join(ROOT, 'assets/js/session-core.js'));
const AP = require(path.join(__dirname, 'activity-partitions.js'));/* P27-C 语义分区（替代整文件哈希） */
const SRC = read('assets/js/session-core.js');
const CODE = stripComments(SRC);
/* 会话的"禁止业务状态"数组本身必然包含 messages/memory 等词 —— 那是**拒绝**它们的证据，
   因此依赖守卫先摘掉该数组（与 P26-1/P26-2 同一策略）。 */
const CODE_CORE = CODE.replace(/var RESERVED_STATE_FIELDS = Object\.freeze\(\[[\s\S]*?\]\);/, '');

let passed = 0, failed = 0;
const failures = [];
function check(name, cond, extra) {
  if (cond) { passed++; console.log('  \u2714 ' + name); }
  else { failed++; failures.push(name); console.log('  \u2716 ' + name + (extra === undefined ? '' : '  -> ' + JSON.stringify(extra).slice(0, 320))); }
}
const T = 1770000000001;
const base = (patch) => Object.assign({ domain: 'cinema', participants: ['role_a', 'role_b'], createdAt: T }, patch || {});
const mk = (patch) => S.createSession(base(patch));

console.log('== P26-3 · Session Core 测试 ==');

/* ── S1 valid session ──────────────────────────────────────────────── */
const s1 = mk();
check('S1.validSession',
  s1.ok === true && s1.session.domain === 'cinema' && s1.session.status === 'created'
  && s1.session.createdAt === T && JSON.stringify(s1.session.participants) === JSON.stringify(['role_a', 'role_b'])
  && /^sess_/.test(s1.session.sessionId) && Object.isFrozen(s1.session), s1);

/* ── S2 invalid identity ──────────────────────────────────────────── */
check('S2.invalidIdentityRejected',
  S.createSession(base({ sessionId: 'has space' })).errors.indexOf('bad-session-id') >= 0
  /* 直接校验：空 id = 缺失；create：空 optional = 未提供 ⇒ 确定性派生（与 P26-1/P26-2 同策略） */
  && S.validateSession(Object.assign({ status: 'created' }, base({ sessionId: '' }))).errors.indexOf('missing-session-id') >= 0
  && /^sess_/.test(S.createSession(base({ sessionId: '' })).session.sessionId)
  && S.createSessionIdentity({ domain: 'cinema', participants: ['role_a'], createdAt: T }, { sessionId: 'bad id' }).ok === false
  && S.createSession(base({ sessionId: 'sess_ok' })).ok === true);

/* ── S3 deterministic id ──────────────────────────────────────────── */
const idA = S.createSessionIdentity({ domain: 'cinema', participants: ['role_a', 'role_b'], createdAt: T });
const idB = S.createSessionIdentity({ domain: 'cinema', participants: ['role_b', 'role_a'], createdAt: T });
const idC = S.createSessionIdentity({ domain: 'cinema', participants: ['role_a'], createdAt: T });
check('S3.deterministicIdentity',
  idA.ok === true && idA.sessionId === idB.sessionId && idA.sessionId !== idC.sessionId
  && S.createSessionIdentity({ domain: 'cinema', participants: ['role_a'], createdAt: T }, { sessionId: 'sess_injected' }).sessionId === 'sess_injected',
  { a: idA.sessionId, c: idC.sessionId });

/* ── S4 lifecycle transition（与 S17 确定性）───────────────────────── */
const a1 = S.transitionSession(s1.session, 'active', { at: T + 10 });
const e1 = S.transitionSession(a1.session, 'ended', { at: T + 20 });
const f1 = S.transitionSession(a1.session, 'failed', { at: T + 21 });
check('S4.lifecycleTransition',
  a1.ok === true && a1.session.status === 'active' && a1.session.updatedAt === T + 10
  && e1.ok === true && e1.session.status === 'ended' && e1.session.endedAt === T + 20
  && f1.ok === true && f1.session.status === 'failed' && f1.session.endedAt === T + 21
  /* 原对象不变（不可变） */
  && s1.session.status === 'created' && a1.session.status === 'active'
  /* created → ended / failed 也合法（未启动即放弃 / 未启动即失败） */
  && S.transitionSession(s1.session, 'ended', { at: T + 1 }).ok === true
  && S.transitionSession(s1.session, 'failed', { at: T + 1 }).ok === true,
  { a: a1.session, e: e1.session, f: f1.session });

/* ── S5 invalid transition ────────────────────────────────────────── */
check('S5.invalidTransition',
  S.transitionSession(e1.session, 'active', { at: T + 30 }).reason === 'already-terminal'
  && S.transitionSession(f1.session, 'active', { at: T + 30 }).reason === 'already-terminal'
  && S.transitionSession(s1.session, 'paused', { at: T + 30 }).reason === 'invalid-transition'
  && S.transitionSession(a1.session, 'created', { at: T + 30 }).reason === 'invalid-transition'
  && S.transitionSession(a1.session, 'nonsense', { at: T + 30 }).reason === 'invalid-transition'
  && S.canTransitionSession(s1.session, 'active') === true && S.canTransitionSession(s1.session, 'paused') === false
  && S.canTransitionSession(e1.session, 'active') === false
  && JSON.stringify(S.SESSION_STATUSES) === JSON.stringify(['created', 'active', 'ended', 'failed'])
  && JSON.stringify(S.TERMINAL_STATUSES) === JSON.stringify(['ended', 'failed'])
  /* paused 明确不在闭集里（P25-3E：活动级 pause NOT PRESENT） */
  && S.SESSION_STATUSES.indexOf('paused') < 0);

/* ── S6 ended immutable ──────────────────────────────────────────── */
check('S6.endedImmutable',
  Object.isFrozen(e1.session) && Object.isFrozen(f1.session)
  && (function () { try { e1.session.status = 'active'; } catch (err) { /* strict 抛错也接受 */ } return e1.session.status === 'ended'; })()
  && S.transitionSession(e1.session, 'ended', { at: T + 40 }).ok === false
  && S.validateSession(e1.session).ok === true);

/* ── S7 participant validation ───────────────────────────────────── */
check('S7.participantValidation',
  S.createSession(base({ participants: [] })).errors.indexOf('bad-participants') >= 0
  && S.createSession(base({ participants: 'role_a' })).errors.indexOf('missing-participants') >= 0
  && S.createSession(base({ participants: ['测试角色 阿黎'] })).errors.some(x => x.indexOf('bad-participant-id') === 0)
  && S.createSession(base({ participants: ['role_a', 'role_a'] })).errors.some(x => x.indexOf('duplicate-participant-id') === 0)
  && mk().ok === true
  /* 参与者是 canonical id（昵称含空格/非 ASCII 一律拒绝）；成员资格在生命周期内可读 */
  && JSON.stringify(mk({ participants: ['role_b', 'role_a'] }).session.participants) === JSON.stringify(['role_a', 'role_b'])
  /* 单个参与者（1:1 活动）也合法 */
  && mk({ participants: ['role_a'] }).ok === true);

/* ── S8 no canonical data ────────────────────────────────────────── */
const stateFields = ['messages', 'content', 'body', 'payload', 'history', 'chat', 'transcript', 'memories', 'images', 'audio'];
const allRejected = stateFields.every(f => {
  const r = mk({ [f]: [] });
  return r.ok === false && r.errors.some(x => x.indexOf('forbidden-state-field') === 0);
});
check('S8.noCanonicalData',
  allRejected
  && S.ALLOWED_FIELDS.indexOf('messages') < 0 && S.ALLOWED_FIELDS.indexOf('content') < 0
  && S.REQUIRED_FIELDS.indexOf('participants') >= 0 && S.REQUIRED_FIELDS.indexOf('status') >= 0
  && mk({ meta: 1 }).errors.some(x => x.indexOf('unknown-field') === 0)
  /* 允许的 runtime state 只有身份/成员/状态/时间（没有业务正文槽） */
  && JSON.stringify(S.ALLOWED_FIELDS) === JSON.stringify(['sessionId', 'domain', 'participants', 'status', 'createdAt', 'updatedAt', 'endedAt', 'version']));

/* ── S9–S16 纯度与依赖守卫（源码级；先剥注释与拒绝清单）────────────── */
const purity = {
  db: ['dbPut', 'dbGet', 'dbDelete', 'indexedDB', 'localStorage', 'sessionStorage', 'openDB'],
  transport: ['fetch(', 'XMLHttpRequest', 'WebSocket', 'postMessage', 'ipcRenderer', 'RTCPeerConnection', 'socket'],
  bus: ['subscribe', 'unsubscribe', 'EventBus', 'dispatch', 'publish', 'emit(', 'listener'],
  observation: ['IBObservation', 'observation-core', 'createObservation', 'observationId'],
  authority: ['Authority', 'autonomy-core', 'decide', 'runMomentMutation', 'runDiaryWrite', 'runActiveMessageSend', 'runRoleLetterWrite'],
  executor: ['createMoment', 'writeDiary', 'sendMessage', 'writeLetter', 'createActivity', 'executor'],
  resource: ['lease', 'lock', 'priority', 'arbitration', 'acquire', 'releaseLock'],
  wake: ['wake', 'trigger', 'notify', 'eligibility'],
  store: ['SessionManager', 'SessionRegistry', 'SessionStore', 'SessionRouter', 'SessionBus', 'RealtimeSync']
};
const hits = key => purity[key].filter(n => CODE_CORE.indexOf(n) >= 0);
check('S9.noPersistence', hits('db').length === 0 && hits('store').length === 0, { db: hits('db'), store: hits('store') });
check('S10.noTransport', hits('transport').length === 0, hits('transport'));
check('S11.noEventBus', hits('bus').length === 0 && CODE_CORE.indexOf('class ') < 0, hits('bus'));
check('S12.noObservationDependency', hits('observation').length === 0, hits('observation'));
check('S13.noAuthorityDependency', hits('authority').length === 0, hits('authority'));
check('S14.noExecutorDependency', hits('executor').length === 0, hits('executor'));
check('S15.noResourceArbitration', hits('resource').length === 0, hits('resource'));
check('S16.noAgentWake', hits('wake').length === 0, hits('wake'));

/* ── S17 deterministic transition ────────────────────────────────── */
const t1 = S.transitionSession(s1.session, 'active', { at: T + 100 });
const t2 = S.transitionSession(s1.session, 'active', { at: T + 100 });
check('S17.deterministicTransition',
  JSON.stringify(t1.session) === JSON.stringify(t2.session)
  && t1.session.sessionId === s1.session.sessionId
  && S.transitionSession(s1.session, 'active', {}).reason === 'missing-transition-time'
  && S.transitionSession(s1.session, 'active', { at: T - 1 }).reason === 'missing-transition-time'
  /* 终态时间不能倒退 */
  && S.transitionSession(t1.session, 'ended', { at: T + 50 }).ok === false
  && S.transitionSession(t1.session, 'ended', { at: T + 200 }).ok === true);

/* ── S18/S19 no clock / no randomness ────────────────────────────── */
check('S18.noDateNowDependency',
  CODE.indexOf('Date.now') < 0 && CODE.indexOf('new Date') < 0 && CODE.indexOf('performance.now') < 0);
check('S19.noMathRandomDependency',
  CODE.indexOf('Math.random') < 0 && CODE.indexOf('crypto.random') < 0);

/* ── 失败语义（不抛异常、返回 result、不自动恢复）──────────────────── */
check('S19b.failureSemanticsNoThrow',
  (function () {
    var threw = false, res = null;
    try { res = S.transitionSession(null, 'active', { at: T }); } catch (e) { threw = true; }
    var res2 = S.transitionSession(s1.session, 'paused', { at: T });
    return threw === false && res && res.ok === false && res.reason === 'invalid-session'
      && res2.ok === false && res2.session === null && res2.errors.length > 0
      && S.transitionSession(s1.session, 'active', { at: T }).ok === true;
  })());

/* ── 小 surface / 无单例 ─────────────────────────────────────────── */
const apiKeys = Object.keys(S).filter(k => typeof S[k] === 'function').sort();
check('S19c.smallPureApiSurface',
  JSON.stringify(apiKeys) === JSON.stringify(['canTransitionSession', 'createSession', 'createSessionIdentity',
    'transitionSession', 'validateSession'])
  && SRC.indexOf('window.IB.sessions') < 0 && SRC.indexOf('window.SessionManager') < 0,
  apiKeys);

/* ── G1–G8 生产接线边界（**P27-4 更新**）：唯一 session 投影 = activity-runtime.js ── */
const CANDIDATES = {
  cinema: ['apps/ib-app-cinema.js', 'function grabFrame('],
  voice: ['assets/js/communication/voice.js', ''],
  coread: ['assets/js/activity/coread.js', 'function coreadPaintshelf()'],
  activity: ['assets/js/activity/activity-runtime.js', 'async function createActivity(p){'],
  group_runtime: ['assets/js/group-runtime-core.js', 'function groupTurnIdFor(userMessageId) {'],
  p23_delivery: ['assets/js/delivery-runtime.js', 'function createDeliveryRuntime(deps) {'],
  active_message: ['assets/js/active-diary.js', 'async function _activeExecuteRun(run){']
};
const sessionHits = [];
/* P27-4：`IB.activity.getSession(activityId)` 是对 canonical Activity 记录的**只读 Session 投影**
   （领域自有 getter，复用 createSession + validateSession；**不调用 transitionSession**；
   无 SessionManager / Registry / Store）。因此"零 session"变成"**恰好一个** session 投影者"。 */
const INTENDED_SESSIONS = ['assets/js/activity/activity-runtime.js'];
for (const key of Object.keys(CANDIDATES)) {
  const [file, anchor] = CANDIDATES[key];
  const src = stripComments(read(file));
  const refs = /IBSession|session-core|createSession|transitionSession|canTransitionSession/.test(src);
  if (refs && INTENDED_SESSIONS.indexOf(file) < 0) sessionHits.push(file + ' (unexpected session producer)');
  if (!refs && INTENDED_SESSIONS.indexOf(file) >= 0) sessionHits.push(file + ' (intended session producer missing)');
  if (anchor && src.indexOf(anchor) < 0) sessionHits.push(file + ' (anchor missing: ' + anchor + ')');
}
check('G1.g7.productionSessionsActivityOnly',
  sessionHits.length === 0 && exists('assets/js/session-core.js')
  /* P27-4：生产 HTML **现在**加载 session-core（有意打破 P26-3 的 foundation-only 先例）；
     其余 P26 core（resource / feedback / wake / activation）仍不加载。 */
  && read('InternalBeyond.html').indexOf('session-core.js') >= 0
  && ['resource-core.js', 'feedback-core.js', 'feedback-consumption-core.js', 'wake-request-core.js',
    'wake-runtime-core.js', 'activation-intent-core.js', 'activation-runtime-core.js']
    .every(c => read('InternalBeyond.html').indexOf(c) < 0)
  /* 投影**不**生产接线 transitionSession（P26-3 迁移能力仍只属纯 foundation） */
  && stripComments(read('assets/js/activity/activity-runtime.js')).indexOf('transitionSession') < 0,
  sessionHits);

/* ── G8 冻结栈逐字节未变（含 P26-1 / P26-2 foundation）────────────── */
const FROZEN = {
  'assets/js/domain-event-core.js': ['3D8F339B', '12805562'],
  'assets/js/observation-core.js': ['077DA39B', 'E18ECC3F'],
  'apps/ib-app-cinema.js': ['CE581CF2', '65B97B58'],
  /* P27-C：activity-runtime.js 的**整文件哈希**已移除（HASH_COUPLING_DEBT 结构性修复）——
     改用 tests/activity-partitions.js 的**语义分区**断言（见本文件下方的 activityRuntimeLegacyPartitionsUnchanged）。 */
  'assets/js/activity/coread.js': ['C3DCBD8D', '1D0ACAAD'],
  'assets/js/communication/voice.js': ['7DE44751', '6228B3B8'],
  'assets/js/moments.js': ['E23697DE', 'B82CEE31'],
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
check('G8.frozenStackUnchanged',
  changed.length === 0
  && read('assets/js/group-runtime-core.js').indexOf('function groupTurnIdFor(userMessageId) {') >= 0,
  changed);
/* P27-C：activity-runtime.js 改用**语义分区**断言（不再整文件哈希）。 */
check('G8b.activityRuntimeLegacyPartitionsUnchanged',
  AP.legacyPartitionsMatch(), AP.legacyPartitionMismatches());

/* ── G9 DB 未变（无 session 类 store）────────────────────────────── */
const COREJS = read('assets/js/core.js');
const storeList = require('./helpers/db-schema-authority.js').storeList;
check('G9.noDbChange',
  require('./helpers/db-schema-authority.js').isVersion('InternalBeyondDB', 24)
  && ['sessions', 'sessionStore', 'sessionState', 'presence'].every(s => storeList.indexOf("'" + s + "'") < 0),
  storeList.slice(-140));

console.log('\n' + (failed
  ? 'P26-3 Session Core FAILED: ' + failed + ' failed / ' + passed + ' passed'
  : 'P26-3 Session Core passed \u2714 (' + passed + ' checks, production sessions = activity-runtime (read-only projection only))'));
process.exitCode = failed ? 1 : 0;
