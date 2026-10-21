'use strict';

/* Internal Beyond · P26-5 · Feedback Core 测试（F1–F16 + 生产非接线守卫）

   阶段性质：FOUNDATION / CONTRACT / PURE CORE / AUDIT-FIRST / NO PRODUCTION INTEGRATION。
   允许：新增独立纯模块 assets/js/feedback-core.js。
   禁止：Event Bus / Router / Scheduler / Agent Wake / Autonomous Execution / Policy Engine /
        Feedback Store · History · Queue / 任何真实 domain 接线。

   覆盖（§10）：valid feedback · invalid source · invalid reason · deterministic id ·
   no Date.now · no Math.random · no Event Bus · no Autonomy · no Authority · no Executor ·
   no Wake · no Persistence；外加 severity/policy 边界、无正文、无 secret、G1–G9 守卫。
   零浏览器、零网络、零真实 provider。 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ROOT = path.resolve(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const exists = f => fs.existsSync(path.join(ROOT, f));
const sha = f => crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, f))).digest('hex').toUpperCase();
const AP = require(path.join(__dirname, 'activity-partitions.js'));/* P27-C 语义分区（替代整文件哈希） */
const stripComments = src => String(src).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const F = require(path.join(ROOT, 'assets/js/feedback-core.js'));
const SRC = read('assets/js/feedback-core.js');
const CODE = stripComments(SRC);
/* 正文/策略黑名单数组本身包含 payload/priority 等词 —— 那是**拒绝**它们的证据，
   因此依赖守卫先摘掉这两个数组（与 P26-1..4 同一策略）。 */
const CODE_CORE = CODE
  .replace(/var RESERVED_BODY_FIELDS = Object\.freeze\(\[[\s\S]*?\]\);/, '')
  .replace(/var POLICY_ONLY_FIELDS = Object\.freeze\(\[[\s\S]*?\]\);/, '');

let passed = 0, failed = 0;
const failures = [];
function check(name, cond, extra) {
  if (cond) { passed++; console.log('  \u2714 ' + name); }
  else { failed++; failures.push(name); console.log('  \u2716 ' + name + (extra === undefined ? '' : '  -> ' + JSON.stringify(extra).slice(0, 320))); }
}
const T = 1770000000001;
const good = (patch) => Object.assign({ domain: 'cinema', source: 'cinema.runtime',
  reason: 'camera-unavailable', severity: 'high', relatedEntity: 'act_1', derivedFrom: 'obs_1' }, patch || {});
const mk = (patch, opts) => F.createFeedback(good(patch), Object.assign({ timestamp: T }, opts || {}));

console.log('== P26-5 · Feedback Core 测试 ==');

/* ── F1 valid feedback ────────────────────────────────────────────── */
const f1 = mk();
check('F1.validFeedback',
  f1.ok === true && f1.feedback.domain === 'cinema' && f1.feedback.source === 'cinema.runtime'
  && f1.feedback.reason === 'camera-unavailable' && f1.feedback.severity === 'high'
  && f1.feedback.relatedEntity === 'act_1' && f1.feedback.derivedFrom === 'obs_1'
  && f1.feedback.timestamp === T && /^fb_/.test(f1.feedback.feedbackId)
  && Object.isFrozen(f1.feedback)
  /* severity / relatedEntity / derivedFrom 都是可选：最小 feedback 只有 5 个必填字段 */
  && F.createFeedback({ domain: 'cinema', source: 'cinema.runtime', reason: 'no-reply-24h' }, { timestamp: T }).ok === true
  && JSON.stringify(F.REQUIRED_FIELDS) === JSON.stringify(['feedbackId', 'domain', 'source', 'reason', 'timestamp'])
  && JSON.stringify(F.SEVERITY_VALUES) === JSON.stringify(['low', 'medium', 'high']), f1);

/* ── F2 invalid source ───────────────────────────────────────────── */
check('F2.invalidSourceRejected',
  mk({ source: '' }).errors.indexOf('missing-source') >= 0
  && mk({ source: 'Cinema Runtime' }).errors.indexOf('bad-source') >= 0
  && mk({ source: 'cinema..runtime' }).errors.indexOf('bad-source') >= 0
  && mk({ source: '0cinema.runtime' }).errors.indexOf('bad-source') >= 0
  /* 合法：点分小写 token（谁派生这个信号） */
  && mk({ source: 'voice.runtime' }).ok === true
  && mk({ source: 'policy.device' }).ok === true);

/* ── F3 invalid reason ───────────────────────────────────────────── */
check('F3.invalidReasonRejected',
  mk({ reason: '' }).errors.indexOf('missing-reason') >= 0
  && mk({ reason: '需要提醒用户' }).errors.indexOf('bad-reason') >= 0
  && mk({ reason: 'camera unavailable, needs attention' }).errors.indexOf('bad-reason') >= 0
  && mk({ reason: 'Camera-Unavailable' }).errors.indexOf('bad-reason') >= 0
  && mk({ reason: 'x'.repeat(61) }).errors.indexOf('bad-reason') >= 0
  /* 合法：机器可读的原因码（不是自由文本；自由文本属 UI/policy） */
  && mk({ reason: 'camera-unavailable' }).ok === true
  && mk({ reason: 'no_user_reply_24h' }).ok === true);

/* ── F4 deterministic id ─────────────────────────────────────────── */
check('F4.deterministicId',
  mk().feedback.feedbackId === mk().feedback.feedbackId
  && mk({ reason: 'no-reply-24h' }).feedback.feedbackId !== mk().feedback.feedbackId
  && mk({ relatedEntity: 'act_2' }).feedback.feedbackId !== mk().feedback.feedbackId
  && mk({}, { feedbackId: 'fb_injected' }).feedback.feedbackId === 'fb_injected'
  && mk({}, { feedbackId: 'bad id' }).errors.indexOf('bad-feedback-id') >= 0);

/* ── F5–F8 纯度：无时钟 / 无随机 / 无 Event Bus / 无 Autonomy ─────── */
check('F5.noDateNow', CODE.indexOf('Date.now') < 0 && CODE.indexOf('new Date') < 0 && CODE.indexOf('performance.now') < 0);
check('F6.noMathRandom', CODE.indexOf('Math.random') < 0 && CODE.indexOf('crypto.random') < 0);
check('F7.noEventBus',
  ['EventBus', 'emit', 'subscribe', 'dispatch', 'listener', 'router', 'route', 'IBDomainEvent', 'domain-event-core']
    .every(n => CODE_CORE.indexOf(n) < 0) && CODE_CORE.indexOf('class ') < 0,
  'Feedback 不等于 Event，也不订阅/发射事件');
check('F8.noAutonomy',
  ['autonomy', 'Autonomy', 'AUTONOMY_DECISIONS', 'runAutonomyAction', 'AUTONOMY_ACTIONS']
    .every(n => CODE_CORE.indexOf(n) < 0),
  'Feedback 不调用 Autonomy（未来链路 Feedback → Autonomy Policy → Action 不在本阶段）');

/* ── F9–F11 no Authority / Executor / Wake ───────────────────────── */
check('F9.noAuthority',
  ['Authority', 'decide(', 'runMomentMutation', 'runDiaryWrite', 'runActiveMessageSend', 'runRoleLetterWrite']
    .every(n => CODE_CORE.indexOf(n) < 0) && CODE_CORE.indexOf('permission') < 0);
check('F10.noExecutor',
  ['executor', 'createMoment', 'writeDiary', 'sendMessage', 'writeLetter', 'createActivity']
    .every(n => CODE_CORE.indexOf(n) < 0));
check('F11.noWake',
  ['wake', 'trigger', 'notify', 'eligibility'].every(n => CODE_CORE.indexOf(n) < 0)
  /* 头部注释里**解释**"没有 feedback.triggerAgent()"不算实现 —— 判定用剥注释后的代码 */
  && CODE.indexOf('triggerAgent') < 0 && SRC.indexOf('wake:') < 0, 'Feedback Available ≠ Agent Wake');

/* ── F12 no persistence ──────────────────────────────────────────── */
check('F12.noPersistence',
  ['dbPut', 'dbGet', 'dbDelete', 'indexedDB', 'localStorage', 'sessionStorage', 'openDB',
    'store', 'history', 'queue', 'persist', 'cache'].every(n => CODE_CORE.indexOf(n) < 0),
  'Feedback Core 无 store / history / queue；也不触碰 DOM / fetch / IPC');

/* ── F13 severity belongs to feedback；priority/urgency 属于 policy ── */
check('F13.severityVersusPolicyFields',
  mk({ severity: 'low' }).ok === true && mk({ severity: 'medium' }).ok === true && mk({ severity: 'high' }).ok === true
  && mk({ severity: 'urgent' }).errors.indexOf('bad-severity') >= 0
  && mk({ severity: '' }).ok === true                                     /* 空 optional = 未提供 */
  && ['priority', 'urgency', 'rank', 'schedule', 'deadline', 'retry'].every(f => {
    const r = mk({ [f]: 1 });
    return r.ok === false && r.errors.some(x => x.indexOf('policy-only-field') === 0);
  })
  && JSON.stringify(F.POLICY_ONLY_FIELDS).indexOf('priority') >= 0
  && JSON.stringify(F.ALLOWED_FIELDS).indexOf('priority') < 0);

/* ── F14 no payload / canonical body / memory dump ────────────────── */
const bodies = ['payload', 'content', 'body', 'text', 'data', 'memory', 'memories', 'messages', 'history', 'transcript', 'images', 'audio', 'base64', 'dump', 'state'];
check('F14.noBodyOrMemoryDump',
  bodies.every(f => {
    const r = mk({ [f]: f === 'base64' ? 'AAAA' : { any: 1 } });
    return r.ok === false && r.errors.some(x => x.indexOf('forbidden-body-field') === 0);
  })
  && mk({ meta: 1 }).errors.some(x => x.indexOf('unknown-field') === 0)
  && mk({ reason: 'sk-abcdefgh1234' }).errors.indexOf('secret-in-feedback') >= 0
  && mk({ source: 'Bearer sk-abcdefgh1234' }).ok === false);

/* ── F15 normalize / describe 不输出正文 ─────────────────────────── */
check('F15.normalizeAndDescribe',
  (function () {
    const n = F.normalizeFeedback(Object.assign({ feedbackId: 'fb_1', timestamp: T }, good()));
    const d = F.describeFeedback(f1.feedback);
    return n.ok === true && Object.isFrozen(n.feedback)
      && F.normalizeFeedback(Object.assign({ feedbackId: 'fb_1', timestamp: T }, good({ payload: {} }))).errors.some(x => x.indexOf('forbidden-body-field') === 0)
      && d.ok === true && d.reason === 'camera-unavailable' && d.severity === 'high'
      && d.rejectedFields.length === 0
      && Object.keys(d).every(k => F.RESERVED_BODY_FIELDS.indexOf(k.toLowerCase()) < 0)
      && d.timestamp === T;
  })());

/* ── F16 small surface ───────────────────────────────────────────── */
const apiKeys = Object.keys(F).filter(k => typeof F[k] === 'function').sort();
check('F16.smallPureApiSurface',
  JSON.stringify(apiKeys) === JSON.stringify(['createFeedback', 'describeFeedback', 'normalizeFeedback', 'validateFeedback'])
  && SRC.indexOf('window.IB.feedback') < 0 && SRC.indexOf('FeedbackRouter') < 0
  && SRC.indexOf('PolicyEngine') < 0, apiKeys);

/* ── G1–G7 生产非接线：Feedback Contract exists / Production feedback = 0 ── */
const CANDIDATES = {
  cinema: ['apps/ib-app-cinema.js', 'function grabFrame('],
  voice: ['assets/js/communication/voice.js', ''],
  activity: ['assets/js/activity/activity-runtime.js', 'async function nudge(o){'],
  active_message: ['assets/js/active-diary.js', 'async function _activeExecuteRun(run){'],
  role_letter: ['assets/js/role-letters.js', 'async function _roleLettersTick(){'],
  autonomy_core: ['assets/js/autonomy-core.js', 'var AUTONOMY_DECISIONS'],
  orchestration: ['assets/js/agent-orchestration-core.js', 'function runAgentPlan(']
};
const feedbackHits = [];
for (const key of Object.keys(CANDIDATES)) {
  const [file, anchor] = CANDIDATES[key];
  const src = stripComments(read(file));
  if (/IBFeedback|feedback-core|createFeedback/.test(src)) feedbackHits.push(file + ' (' + key + ')');
  if (anchor && src.indexOf(anchor) < 0) feedbackHits.push(file + ' (anchor missing: ' + anchor + ')');
}
check('G1.g7.productionFeedbackZero',
  feedbackHits.length === 0 && exists('assets/js/feedback-core.js')
  /* 生产 HTML 不加载 feedback core（P26-1..4 同策略：foundation-only） */
  && read('InternalBeyond.html').indexOf('feedback-core.js') < 0,
  feedbackHits);

/* ── G8 冻结栈逐字节未变（P26-1..4 foundation + P23/P24/P25 + 域生产 + Autonomy）── */
const FROZEN = {
  'assets/js/domain-event-core.js': ['3D8F339B', '12805562'],
  'assets/js/observation-core.js': ['077DA39B', 'E18ECC3F'],
  'assets/js/session-core.js': ['5778EE01', '2819C529'],
  'assets/js/resource-core.js': ['71318C21', 'EE8A60FA'],
  'assets/js/autonomy-core.js': ['FE1011F1', '9F2956F8'],
  'assets/js/agent-capability-registry.js': ['78AE9DFE', '273BF7A2'],
  'assets/js/agent-orchestration-core.js': ['BA4A3DFA', 'AC204F79'],
  /* Cinema v1.2: progress identity/resume and role-guidance update, explicitly accepted. */
  /* Reviewed Cinema v1.2 source snapshot: 3A574786. */
  'apps/ib-app-cinema.js': ['3A574786', 'C1817BCD'],
  'assets/js/communication/voice.js': ['7DE44751', '6228B3B8'],
  /* P27-C：activity-runtime.js 的**整文件哈希**已移除（HASH_COUPLING_DEBT 结构性修复）——
     改用 tests/activity-partitions.js 的**语义分区**断言（见本文件下方的 activityRuntimeLegacyPartitionsUnchanged）。 */
  'assets/js/active-diary.js': ['D14D4AC6', '89ADE8CA'],
  'assets/js/role-letters.js': ['AAE050AB', 'BF5A43AD'],
  'assets/js/moments.js': ['E23697DE', 'B82CEE31'],
  'assets/js/delivery-planner.js': ['15E7DBD0', 'E887308C'],
  'assets/js/delivery-runtime.js': ['82BC57D7', 'F7F46802'],
  'assets/js/delivery-sequence-core.js': ['5AE59648', 'FEB7EB35'],
  'assets/js/multimodal-delivery-policy.js': ['B7AFDFA6', 'ABC8B370'],
  'assets/js/voice-message-core.js': ['06907AA2', 'DEDDB258'],
  'assets/js/group-runtime-core.js': ['6F30FDE9', '067B35E8'],
  'assets/js/communication.js': ['DEB568A2', 'AC29184F'],
  'assets/js/role-letter-authority.js': ['1743B97D', '39387C90'],
  'assets/js/diary-authority.js': ['BBB7EC88', 'C95E73A9'],
  'assets/js/active-message-authority.js': ['CC2A8BF9', 'AE3892C4']
};
const changed = Object.keys(FROZEN).filter(f => !(sha(f).startsWith(FROZEN[f][0]) && sha(f).endsWith(FROZEN[f][1])));
check('G8.frozenStackUnchanged', changed.length === 0, changed);
/* P27-C：activity-runtime.js 改用**语义分区**断言（不再整文件哈希）。 */
check('G8b.activityRuntimeLegacyPartitionsUnchanged',
  AP.legacyPartitionsMatch(), AP.legacyPartitionMismatches());

/* ── G9 DB 未变（无 feedback 类 store）───────────────────────────── */
const COREJS = read('assets/js/core.js');
const storeList = require('./helpers/db-schema-authority.js').storeList;
check('G9.noDbChange',
  require('./helpers/db-schema-authority.js').isVersion('InternalBeyondDB', 24)
  && ['feedback', 'feedbackStore', 'feedbackHistory', 'feedbackQueue', 'signals'].every(s => storeList.indexOf("'" + s + "'") < 0),
  storeList.slice(-140));

console.log('\n' + (failed
  ? 'P26-5 Feedback Core FAILED: ' + failed + ' failed / ' + passed + ' passed'
  : 'P26-5 Feedback Core passed \u2714 (' + passed + ' checks, production feedback = 0)'));
process.exitCode = failed ? 1 : 0;
