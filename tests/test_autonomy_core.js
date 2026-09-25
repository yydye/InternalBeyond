'use strict';

/* Internal Beyond · P25-1 · Autonomy Core Foundation 测试
   （static 组：纯 Node、零浏览器、零网络、零存储；运行：
     node tests/test_autonomy_core.js）

   本阶段只建立 **Autonomy Decision Layer 的纯地基**：
     Action Candidate → Context Evaluation → Decision → Executor → Result Trace
   覆盖用户给定 A1–A18 与源码守卫。**不接任何业务模块**（Moments / Diary / Active / Activity / P24）。 */

const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');

const ROOT = path.resolve(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const Core = require(path.join(ROOT, 'assets', 'js', 'autonomy-core.js'));

let failures = 0;
let passes = 0;
function ok(name, cond, detail) {
  if (cond) { passes++; console.log('  PASS  ' + name); }
  else { failures++; console.error('  FAIL  ' + name + (detail !== undefined ? '  -> ' + JSON.stringify(detail).slice(0, 320) : '')); }
}

const A = (patch) => Object.assign({ actionType: 'moment.post', actorId: 'friend_a', source: 'character' }, patch || {});
const counter = () => { const box = { n: 0 }; box.fn = () => { box.n++; }; return box; };
const stripComments = src => String(src).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

function main() {
  console.log('== P25-1 · Autonomy Core Foundation 测试 ==');

  /* ── A1 · Action contract validation ─────────────────────────────────── */
  ok('A1.validActionAccepted', Core.validateAutonomyAction(A()).ok === true);
  ok('A1b.allPlaceholderActionTypesAccepted',
    Core.AUTONOMY_ACTION_TYPES.every(t => Core.validateAutonomyAction(A({ actionType: t })).ok === true)
    && JSON.stringify(Core.AUTONOMY_ACTION_TYPES)
    === JSON.stringify(['moment.post', 'diary.write', 'active_message.send', 'activity.start']));
  ok('A1c.badActionTypeRejected', Core.validateAutonomyAction(A({ actionType: 'nope' })).errors.indexOf('bad-action-type') >= 0
    && Core.validateAutonomyAction(A({ actionType: '' })).errors.indexOf('missing-action-type') >= 0);
  ok('A1d.badSourceRejected', Core.validateAutonomyAction(A({ source: 'unknown' })).errors.indexOf('bad-source') >= 0
    && Core.validateAutonomyAction(A({ source: '' })).errors.indexOf('bad-source') >= 0);
  ok('A1e.badContextRejected', Core.validateAutonomyAction(A({ context: 'x' })).errors.indexOf('bad-context') >= 0
    && Core.validateAutonomyAction(A({ context: {} })).ok === true);
  ok('A1f.nonObjectRejected', Core.validateAutonomyAction(null).errors.indexOf('not-an-object') >= 0
    && Core.validateAutonomyAction([]).errors.indexOf('not-an-object') >= 0);

  /* ── A11 · Identity required ─────────────────────────────────────────── */
  ok('A11.identityRequired',
    Core.validateAutonomyAction(A({ actorId: '' })).errors.indexOf('missing-actor-id') >= 0
    && Core.validateAutonomyAction(A({ actorId: 'group_x' })).errors.indexOf('bad-actor-id') >= 0
    && Core.validateAutonomyAction(A({ actorId: ' friend_a ' })).errors.indexOf('bad-actor-id') >= 0
    && Core.validateAutonomyAction(A({ actorId: 'x\u0000y' })).errors.indexOf('bad-actor-id') >= 0);

  /* ── A12 · No secret leakage ─────────────────────────────────────────── */
  ok('A12.secretRejected',
    Core.validateAutonomyAction(A({ context: { apiKey: 'sk-abcdefgh12345678' } })).errors.indexOf('secret-in-action') >= 0
    && Core.validateAutonomyAction(A({ actorId: 'sk-abcdefgh12345678' })).errors.indexOf('secret-in-action') >= 0);
  ok('A12b.errorDoesNotEchoSecret', (() => {
    const secret = 'sk-abcdefgh12345678';
    try { Core.validateAutonomyAction(A({ context: { apiKey: secret } })); } catch (e) { /* validator 不抛 */ }
    const res = Core.evaluateAutonomyAction(Core.createAutonomyState(), A({ actorId: secret }), {}, () => {});
    return res.decision === 'deny' && JSON.stringify(res).indexOf(secret) < 0;
  })());

  /* ── A2/A3/A4 · Decision vocabulary & failure semantics ──────────────── */
  ok('A2.decisionVocabularyClosed',
    JSON.stringify(Core.AUTONOMY_DECISIONS) === JSON.stringify({ ALLOW: 'allow', DENY: 'deny', DEFER: 'defer' })
    && Core.AUTONOMY_REASONS.length > 0 && Core.AUTONOMY_REASONS.indexOf('decision-failure') >= 0);
  ok('A3.unknownDecisionDenied',
    Core.evaluateAutonomyAction(Core.createAutonomyState(), A(), { decide: () => ({ decision: 'maybe' }) }, () => {}).reason === 'decision-failure'
    && Core.evaluateAutonomyAction(Core.createAutonomyState(), A(), { decide: () => ({ decision: 'ALLOW' }) }, () => {}).decision === 'deny'
    && Core.evaluateAutonomyAction(Core.createAutonomyState(), A(), { decide: () => 'allow' }, () => {}).decision === 'deny');
  ok('A4.decisionThrowSafe',
    Core.evaluateAutonomyAction(Core.createAutonomyState(), A(), { decide: () => { throw new Error('boom'); } }, () => {}).decision === 'deny'
    && Core.evaluateAutonomyAction(Core.createAutonomyState(), A(), { decide: () => null }, () => {}).decision === 'deny');
  ok('A4b.cancelledDeniedWithoutDecision',
    Core.evaluateAutonomyAction(Core.createAutonomyState(), A(), { cancelled: true }, () => {}).reason === 'cancelled');
  ok('A4c.noExecutorDenied',
    Core.evaluateAutonomyAction(Core.createAutonomyState(), A(), {}, undefined).reason === 'no-executor');
  ok('A4d.malformedActionDenied',
    Core.evaluateAutonomyAction(Core.createAutonomyState(), { actionType: 'nope' }, {}, () => {}).reason === 'invalid-action');

  /* ── A5/A6 · Executor boundary ───────────────────────────────────────── */
  ok('A5.executorNotCalledWhenDenied', (() => {
    const c = counter();
    const r = Core.runAutonomyAction(Core.createAutonomyState(), A(), { decide: () => ({ decision: 'deny' }) }, c.fn);
    return r.executed === false && c.n === 0;
  })());
  ok('A5b.executorNotCalledWhenDeferred', (() => {
    const c = counter();
    const r = Core.runAutonomyAction(Core.createAutonomyState(), A(), { decide: () => ({ decision: 'defer' }) }, c.fn);
    return r.decision === 'defer' && r.executed === false && c.n === 0;
  })());
  ok('A5c.executorNotCalledOnDecisionFailure', (() => {
    const c = counter();
    const r = Core.runAutonomyAction(Core.createAutonomyState(), A(), { decide: () => { throw new Error('x'); } }, c.fn);
    return r.decision === 'deny' && c.n === 0;
  })());
  ok('A6.executorCalledWhenAllowed', (() => {
    const c = counter();
    const r = Core.runAutonomyAction(Core.createAutonomyState(), A(), {}, c.fn);
    return r.decision === 'allow' && r.executed === true && r.ok === true && c.n === 1;
  })());
  ok('A6b.executorThrowCapturedNotPropagated', (() => {
    const r = Core.runAutonomyAction(Core.createAutonomyState(), A(), {}, () => { throw new Error('executor boom'); });
    return r.decision === 'allow' && r.executed === true && r.ok === false
      && String(r.error).indexOf('executor boom') >= 0;
  })());

  /* ── A7/A8 · Trace ───────────────────────────────────────────────────── */
  ok('A7.traceGenerated', (() => {
    const s = Core.createAutonomyState();
    Core.runAutonomyAction(s, A(), { now: 5 }, () => {});
    const t = Core.autonomyTraceSnapshot(s);
    return t.length === 1 && t[0].actionType === 'moment.post' && t[0].actorId === 'friend_a'
      && t[0].decision === 'allow' && t[0].timestamp === 5;
  })());
  ok('A7b.traceIsBounded',
    (() => {
      const s = Core.createAutonomyState();
      for (let i = 0; i < Core.AUTONOMY_TRACE_LIMIT + 20; i++) Core.runAutonomyAction(s, A({ fingerprint: 'f' + i }), { now: i * 10 }, () => {});
      return Core.autonomyTraceSnapshot(s).length === Core.AUTONOMY_TRACE_LIMIT;
    })());
  ok('A8.traceNotPersisted', (() => {
    const s = Core.createAutonomyState();
    Core.runAutonomyAction(s, A(), { now: 1 }, () => {});
    return JSON.stringify(Object.keys(s).sort()) === JSON.stringify(['lastExecuted', 'trace'])
      && Core.autonomyTraceSnapshot({}).length === 0;
  })());

  /* ── A9 · Duplicate protection ───────────────────────────────────────── */
  ok('A9.duplicateDetected', (() => {
    const s = Core.createAutonomyState();
    const c = counter();
    const first = Core.runAutonomyAction(s, A({ fingerprint: 'same' }), { now: 1000 }, c.fn);
    const second = Core.runAutonomyAction(s, A({ fingerprint: 'same' }), { now: 2000 }, c.fn);
    const other = Core.runAutonomyAction(s, A({ actorId: 'friend_b', fingerprint: 'same' }), { now: 2000 }, c.fn);
    return first.executed === true && second.reason === 'duplicate' && second.executed === false
      && other.executed === true && c.n === 2;
  })());
  ok('A9b.duplicateWindowRespected', (() => {
    const s = Core.createAutonomyState();
    Core.runAutonomyAction(s, A({ fingerprint: 'w' }), { now: 0, duplicateWindowMs: 500 }, () => {});
    const inside = Core.isDuplicateAutonomyAction(s, A({ fingerprint: 'w' }), { now: 400, duplicateWindowMs: 500 });
    const outside = Core.isDuplicateAutonomyAction(s, A({ fingerprint: 'w' }), { now: 900, duplicateWindowMs: 500 });
    return inside === true && outside === false;
  })());
  ok('A9c.noInjectedTimeMeansNoTimeGating', (() => {
    const s = Core.createAutonomyState();
    Core.runAutonomyAction(s, A({ fingerprint: 'n' }), {}, () => {});
    return Core.isDuplicateAutonomyAction(s, A({ fingerprint: 'n' }), {}) === false;
  })());

  /* ── A10 · Cooldown interface ────────────────────────────────────────── */
  ok('A10.cooldownInterface', (() => {
    const s = Core.createAutonomyState();
    Core.runAutonomyAction(s, A({ fingerprint: 'c' }), { now: 1000 }, () => {});
    const blocked = Core.canExecuteAutonomyAction(s, A({ fingerprint: 'c' }), { now: 2000, cooldownMsFor: () => 3600000 });
    const open = Core.canExecuteAutonomyAction(s, A({ fingerprint: 'c' }), { now: 1000 + 3600000, cooldownMsFor: () => 3600000 });
    const noPolicy = Core.canExecuteAutonomyAction(s, A({ fingerprint: 'c' }), { now: 2000 });
    return blocked === false && open === true && noPolicy === true;
  })());
  ok('A10b.cooldownFailureDoesNotBlock', (() => {
    const s = Core.createAutonomyState();
    return Core.canExecuteAutonomyAction(s, A(), { now: 10, cooldownMsFor: () => { throw new Error('x'); } }) === true
      && Core.canExecuteAutonomyAction(s, A(), { now: 10, cooldownMsFor: () => -1 }) === true;
  })());
  ok('A10c.cooldownDeniesExecution', (() => {
    const s = Core.createAutonomyState();
    const c = counter();
    Core.runAutonomyAction(s, A({ fingerprint: 'cd' }), { now: 0 }, c.fn);
    const second = Core.runAutonomyAction(s, A({ fingerprint: 'cd' }), { now: 10, cooldownMsFor: () => 60000, duplicateWindowMs: 1 }, c.fn);
    return second.reason === 'cooldown' && second.executed === false && c.n === 1;
  })());

  /* ── A13–A17 · 无 provider / 模型 / Memory / MB / Group Brain ────────── */
  const coreSrc = read('assets/js/autonomy-core.js');
  const coreCode = stripComments(coreSrc);
  ok('A13.noProviderCall',
    ['callApi', 'callApiChat', 'fetch(', 'XMLHttpRequest', 'endpoint', 'apiKey'].every(t => coreCode.indexOf(t) < 0));
  ok('A14.noModelCall', coreCode.indexOf('model') < 0 && coreCode.indexOf('PROVIDERS') < 0);
  ok('A15.noMemoryAuthority',
    coreCode.indexOf('Memory') < 0 && coreCode.indexOf('getMemoryContext') < 0 && coreCode.indexOf('memories') < 0);
  ok('A16.noMiddleBrainAuthority',
    coreCode.indexOf('MiddleBrain') < 0 && coreCode.indexOf('middle-brain') < 0 && coreCode.indexOf('_mbVerdict') < 0);
  ok('A17.noGroupBrainImplementation',
    coreCode.indexOf('GroupBrain') < 0 && coreCode.indexOf('groupBrain') < 0 && coreCode.indexOf('group_brain') < 0);

  /* ── A18 · Determinism ──────────────────────────────────────────────── */
  ok('A18.deterministic', (() => {
    const build = () => {
      const s = Core.createAutonomyState();
      Core.runAutonomyAction(s, A({ fingerprint: 'd1' }), { now: 100 }, () => {});
      Core.runAutonomyAction(s, A({ fingerprint: 'd1' }), { now: 200 }, () => {});
      Core.runAutonomyAction(s, A({ actionType: 'diary.write', fingerprint: 'd2' }), { now: 300, decide: () => ({ decision: 'defer' }) }, () => {});
      return JSON.stringify({ trace: Core.autonomyTraceSnapshot(s), last: s.lastExecuted });
    };
    const first = build();
    for (let i = 0; i < 100; i++) if (build() !== first) return false;
    return true;
  })());
  ok('A18b.pureNoClockOrRandom',
    ['Date.now', 'Math.random', 'performance.now', 'crypto.randomUUID', 'setTimeout', 'setInterval', 'new Date(']
      .every(t => coreCode.indexOf(t) < 0));

  /* ── Source guards（跨模块边界）──────────────────────────────────────── */
  const p24Core = read('assets/js/group-runtime-core.js');
  const comm = read('assets/js/communication.js');
  const social = read('assets/js/social.js');
  ok('SG1.p24FilesHaveNoAutonomyCoupling',
    p24Core.indexOf('autonomy') < 0 && comm.indexOf('autonomy') < 0
    && p24Core.indexOf('IBAutonomyCore') < 0 && comm.indexOf('IBAutonomyCore') < 0);
  ok('SG2.noBusinessExecutorImplemented',
    ['createMoment', 'writeDiary', 'sendMessage', 'postMoment', 'generateDiary']
      .every(t => coreCode.indexOf(t) < 0));
  ok('SG3.noChatMessagesOrSocialWrite',
    coreCode.indexOf('chatMessages') < 0 && coreCode.indexOf('dbPut') < 0
    && coreCode.indexOf('social') < 0 && social.indexOf('IBAutonomyCore') < 0);
  ok('SG4.noPersistenceApis',
    ['indexedDB', 'localStorage', 'sessionStorage', 'dbSet', 'dbGet'].every(t => coreCode.indexOf(t) < 0)
    && coreCode.indexOf('persist = true') < 0);
  ok('SG5.newModuleIsStandalone',
    coreSrc.indexOf("root.IBAutonomyCore = factory") >= 0
    && coreSrc.indexOf("require('./chat-core.js')") >= 0
    && coreSrc.indexOf("require('./voice-message-core.js')") >= 0);

  console.log(failures === 0 ? '\n全部通过 ✔  (' + passes + ')' : '\n失败 ' + failures + ' 项（通过 ' + passes + '）');
  process.exitCode = failures ? 1 : 0;
}

main();
