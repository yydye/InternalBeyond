'use strict';

/* Internal Beyond · P25-3A · Agent Orchestration Core 测试（O1–O25；纯 Node） */

const fs = require('fs');
const path = require('path');
const R = require(path.join(__dirname, '..', 'assets', 'js', 'agent-capability-registry.js'));
const C = require(path.join(__dirname, '..', 'assets', 'js', 'agent-orchestration-core.js'));

const ROOT = path.resolve(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const stripComments = src => String(src).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const CORE_SRC = stripComments(read('assets/js/agent-orchestration-core.js'));

let passed = 0, failed = 0;
const failures = [];
function check(name, cond, extra) {
  if (cond) { passed++; console.log('  \u2714 ' + name); }
  else { failed++; failures.push(name); console.log('  \u2716 ' + name + (extra === undefined ? '' : '  -> ' + JSON.stringify(extra).slice(0, 320))); }
}

const reg = R.createCapabilityRegistry();
reg.register({ id: 'moment.post', domain: 'moment', kind: 'write', description: '发布动态', sideEffect: 'local', authorityType: 'autonomy', binding: 'moments.autonomy.pipeline' });
reg.register({ id: 'moment.read', domain: 'moment', kind: 'read', description: '读取动态', sideEffect: 'none', authorityType: 'read-only', binding: 'moments.read' });
reg.register({ id: 'label.bad', domain: 'label', kind: 'write', description: '非法声明（写但 read-only）', sideEffect: 'local', authorityType: 'read-only', binding: 'x' }).ok;

const request = (patch) => Object.assign({
  requestId: 'req_1', actorId: 'role_a', source: 'character',
  intent: { goal: '发一条动态', preferredCapabilities: ['moment.post'] }, context: { reason: 'scheduled' }
}, patch || {});
const plan = (patch, steps) => Object.assign({ planId: 'plan_1', actorId: 'role_a', steps: steps || [{ stepId: 's1', capabilityId: 'moment.post', input: { topic: 'weather' }, reasonCode: 'scheduled' }] }, patch || {});
const noop = () => Promise.resolve({ ok: true, output: { done: true } });

console.log('== P25-3A · Agent Orchestration Core 测试 ==');

/* ── Request / Intent / Observation ── */
check('O1.validRequest', (() => {
  const r = C.buildOrchestrationRequest(request());
  return r.ok === true && r.request.requestId === 'req_1' && r.request.intent.goal === '发一条动态'
    && JSON.stringify(r.request.intent.preferredCapabilities) === JSON.stringify(['moment.post']);
})());
check('O2.invalidActor',
  C.buildOrchestrationRequest(request({ actorId: '' })).errors.indexOf('bad-actor-id') >= 0
  && C.buildOrchestrationRequest(request({ actorId: ' role_a' })).errors.indexOf('bad-actor-id') >= 0
  && C.buildOrchestrationRequest(request({ actorId: 'role\u0000a' })).errors.indexOf('bad-actor-id') >= 0);
check('O3.invalidSource',
  C.buildOrchestrationRequest(request({ source: 'magic' })).errors.indexOf('bad-source') >= 0
  && C.buildOrchestrationRequest(request({ source: '' })).errors.indexOf('bad-source') >= 0);
check('O3b.contextBoundary',
  C.buildOrchestrationRequest(request({ context: { messages: [] } })).errors.join(',').indexOf('forbidden-context-field') >= 0
  && C.buildOrchestrationRequest(request({ context: { history: new Array(40).fill('x') } })).ok === false
  && C.buildObservationBundle({ actorId: 'role_a', domainFacts: { recentCount: 2 } }).ok === true
  && C.buildObservationBundle({ actorId: 'role_a', domainFacts: { token: 'abc' } }).ok === false);

/* ── Plan ── */
check('O4.validPlan', C.validateAgentPlan(plan(), reg).ok === true);
check('O5.unknownCapabilityRejected',
  C.validateAgentPlan(plan({}, [{ stepId: 's1', capabilityId: 'moment.nope', input: {} }]), reg).errors.join(',').indexOf('unknown-capability') >= 0);
check('O6.planIsNotPermission', (() => {
  /* plan 合法 ≠ 允许执行：authority 说 deny ⇒ executor 0 次 */
  let calls = 0;
  return C.runAgentPlan(plan(), reg, {
    invokeAuthority: () => ({ decision: 'deny', reason: 'not-allowed' }),
    resolveExecutor: () => async () => { calls++; return { ok: true }; }
  }).then(out => out.steps[0].status === 'denied' && out.steps[0].errorCode === 'not-allowed' && calls === 0);
})());
check('O7.authorityRequiredForSideEffect', (() => {
  let calls = 0;
  return C.runAgentPlan(plan(), reg, {
    resolveExecutor: () => async () => { calls++; return { ok: true }; }
  }).then(out => out.steps[0].status === 'unavailable' && out.steps[0].errorCode === 'authority-missing' && calls === 0);
})());
check('O23.deterministicPlanValidation', (() => {
  const a = JSON.stringify(C.validateAgentPlan(plan(), reg));
  const b = JSON.stringify(C.validateAgentPlan(plan(), reg));
  const c = C.validateAgentPlan(plan({}, [{ stepId: 's1', capabilityId: 'moment.post', input: {} }, { stepId: 's1', capabilityId: 'moment.post', input: {} }]), reg);
  return a === b && c.errors.indexOf('duplicate-step-id:s1') >= 0;
})());
check('O17.cycleRejected',
  C.validateAgentPlan(plan({}, [
    { stepId: 's1', capabilityId: 'moment.post', input: {}, dependsOn: ['s2'] },
    { stepId: 's2', capabilityId: 'moment.post', input: {}, dependsOn: ['s1'] }
  ]), reg).errors.indexOf('dependency-cycle') >= 0);

(async () => {
  /* ── Status 语义 ── */
  const okRun = await C.runAgentPlan(plan(), reg, { invokeAuthority: () => ({ decision: 'allow' }), resolveExecutor: () => noop });
  check('O8.deniedIsNotFailed', (await C.runAgentPlan(plan(), reg, {
    invokeAuthority: () => ({ decision: 'deny', reason: 'policy' }), resolveExecutor: () => noop
  })).steps[0].status === 'denied');
  check('O9.deferredIsNotFailed', (() => C.runAgentPlan(plan(), reg, {
    invokeAuthority: () => ({ decision: 'defer', reason: 'later' }), resolveExecutor: () => noop
  }).then(out => out.steps[0].status === 'deferred' && out.steps[0].errorCode === 'later'))());
  check('O10.executorFailureIsFailed', (await C.runAgentPlan(plan(), reg, {
    invokeAuthority: () => ({ decision: 'allow' }), resolveExecutor: () => async () => ({ ok: false, errorCode: 'write-failed' })
  })).steps[0].status === 'failed');
  check('O11.unavailable', (await C.runAgentPlan(plan(), reg, {
    invokeAuthority: () => ({ decision: 'allow' })
  })).steps[0].status === 'unavailable');
  check('O18.noAutomaticSideEffectRetry', (() => {
    let calls = 0;
    return C.runAgentPlan(plan(), reg, {
      invokeAuthority: () => ({ decision: 'allow' }),
      resolveExecutor: () => async () => { calls++; return { ok: false, errorCode: 'boom' }; }
    }).then(out => calls === 1 && out.steps[0].status === 'failed');
  })());

  /* ── 取消 ── */
  let cancelled = true;
  const cancelBefore = await C.runAgentPlan(plan(), reg, {
    isCancelled: () => cancelled, invokeAuthority: () => ({ decision: 'allow' }), resolveExecutor: () => noop
  });
  check('O12.cancellationBeforeStep',
    cancelBefore.steps[0].status === 'denied' && cancelBefore.steps[0].errorCode === 'cancelled');
  let stepCount = 0;
  const cancelMid = await C.runAgentPlan(plan({}, [
    { stepId: 's1', capabilityId: 'moment.post', input: {} },
    { stepId: 's2', capabilityId: 'moment.post', input: {} },
    { stepId: 's3', capabilityId: 'moment.post', input: {} }
  ]), reg, {
    isCancelled: () => stepCount >= 1,
    invokeAuthority: () => ({ decision: 'allow' }),
    resolveExecutor: () => async () => { stepCount++; return { ok: true }; }
  });
  check('O13.cancellationMidPlan',
    cancelMid.steps[0].status === 'completed' && cancelMid.steps[1].errorCode === 'cancelled' && cancelMid.steps[2].errorCode === 'cancelled');
  check('O14.completedSideEffectPreserved',
    cancelMid.steps[0].status === 'completed' && cancelMid.reflection.completedSteps.join(',') === 's1');

  /* ── 依赖 ── */
  const ordered = await C.runAgentPlan(plan({}, [
    { stepId: 's2', capabilityId: 'moment.post', input: {}, dependsOn: ['s1'] },
    { stepId: 's1', capabilityId: 'moment.post', input: {} }
  ]), reg, { invokeAuthority: () => ({ decision: 'allow' }), resolveExecutor: () => noop });
  check('O15.dependencyOrder',
    ordered.steps.map(s => s.stepId).join(',') === 's1,s2');
  const depFail = await C.runAgentPlan(plan({}, [
    { stepId: 's1', capabilityId: 'moment.post', input: {} },
    { stepId: 's2', capabilityId: 'moment.post', input: {}, dependsOn: ['s1'] }
  ]), reg, {
    invokeAuthority: () => ({ decision: 'deny', reason: 'blocked' }), resolveExecutor: () => noop
  });
  check('O16.dependencyFailureBlocksDependent',
    depFail.steps[0].status === 'denied' && depFail.steps[1].errorCode === 'dependency-failed');

  /* ── idempotency / reflection / CoT / secret ── */
  const idem = await C.runAgentPlan(plan(), reg, {
    invokeAuthority: () => ({ decision: 'allow' }),
    idempotencyKeyFor: (descriptor, step) => 'key:' + descriptor.id + ':' + step.stepId,
    resolveExecutor: () => noop
  });
  check('O19.idempotencyKeyPassthrough', idem.steps[0].idempotencyKey === 'key:moment.post:s1');
  check('O20.structuredReflection',
    typeof idem.reflection.outcome === 'string' && Array.isArray(idem.reflection.completedSteps)
    && JSON.stringify(Object.keys(idem.reflection).sort()) === JSON.stringify(['completedSteps', 'deferredSteps', 'deniedSteps', 'failedSteps', 'outcome', 'reasonCodes', 'unavailableSteps']));
  check('O21.noCoT',
    C.buildOrchestrationRequest(request({ thinking: 'why' })).errors.join(',').indexOf('forbidden-reasoning-field') >= 0
    && C.validateAgentPlan(plan({ analysis: 'because' }), reg).errors.join(',').indexOf('forbidden-reasoning-field') >= 0
    && C.sanitizeOutput({ ok: true, chain_of_thought: 'x' }) === null);
  check('O22.noSecret',
    C.buildOrchestrationRequest(request({ context: { apiKey: 'sk-abcdefgh12345678' } })).ok === false
    && C.validateAgentPlan(plan({}, [{ stepId: 's1', capabilityId: 'moment.post', input: { token: 'sk-abcdefgh12345678' } }]), reg).ok === false
    && C.sanitizeOutput({ apiKey: 'sk-abcdefgh12345678', content: 'ok' }) !== null);
  check('O24.zeroPersistence', !/localStorage|indexedDB|dbPut|dbGet|sessionStorage/.test(CORE_SRC));
  check('O25.zeroProviderCall', !/callApiChat|fetch\(|XMLHttpRequest|runtime\.instance\.execute|_momentsModelCall/.test(CORE_SRC));
  check('O25b.pureModule',
    !/document|window\.|setTimeout|setInterval|Date\.now|Math\.random|Memory|middle-brain/.test(CORE_SRC));
  check('O25c.verifyContract',
    C.verifyStepResult({ status: 'completed' }, () => true).verified === true
    && C.verifyStepResult({ status: 'denied' }, () => true).errorCode === 'not-completed'
    && C.verifyStepResult({ status: 'completed' }).errorCode === 'verifier-missing');

  console.log('\n' + (failed === 0 ? 'ALL PASS' : 'FAILURES: ' + failures.join(', ')));
  console.log('P25-3A · orchestration core: ' + passed + ' passed, ' + failed + ' failed');
  process.exitCode = failed === 0 ? 0 : 1;
})().catch(e => { console.error('suite crashed:', e && e.stack || e); process.exitCode = 1; });
