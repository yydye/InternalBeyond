'use strict';

/* Internal Beyond · P25-3A · Moments Reference Adapter 测试（M1–M18；纯 Node）

   本套件把**真实**的 P25-2 Autonomy 与 P25-2.5 Mutation Authority 接到编排层，
   用假 domain writer 证明路由与边界；不产生任何 production side effect。 */

const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const stripComments = src => String(src).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const crypto = require('crypto');
const sha256 = f => crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, f))).digest('hex').toUpperCase();

const R = require(path.join(ROOT, 'assets/js/agent-capability-registry.js'));
const C = require(path.join(ROOT, 'assets/js/agent-orchestration-core.js'));
const A = require(path.join(ROOT, 'assets/js/agent-orchestration-moments-adapter.js'));
const MA = require(path.join(ROOT, 'assets/js/moments-autonomy.js'));
const MM = require(path.join(ROOT, 'assets/js/moments-mutation-authority.js'));

const ADAPTER_SRC = stripComments(read('assets/js/agent-orchestration-moments-adapter.js'));
const MOMENTS_SRC = read('assets/js/moments.js');

let passed = 0, failed = 0;
const failures = [];
function check(name, cond, extra) {
  if (cond) { passed++; console.log('  \u2714 ' + name); }
  else { failed++; failures.push(name); console.log('  \u2716 ' + name + (extra === undefined ? '' : '  -> ' + JSON.stringify(extra).slice(0, 320))); }
}

const reg = R.createCapabilityRegistry();
const registered = A.registerMomentsCapabilities(reg);
const NOW = 1770000000000;

function makeAdapter(overrides) {
  const spies = { autonomy: 0, mutation: 0, domainCalls: [] };
  const autonomy = {
    runMomentAutonomy: (candidate, deps) => { spies.autonomy++; return MA.runMomentAutonomy(candidate, deps); }
  };
  const mutation = {
    runMomentMutation: (mutation, facts, exec) => { spies.mutation++; return MM.runMomentMutation(mutation, facts, exec); }
  };
  const domain = {
    createMoment: async (payload, options) => { spies.domainCalls.push({ fn: 'createMoment', payload, options }); return { ok: true, moment: { id: options && options.id } }; },
    likeMoment: async (id, who) => { spies.domainCalls.push({ fn: 'likeMoment', id, who }); return { ok: true, liked: true }; },
    addMomentComment: async (id, data) => { spies.domainCalls.push({ fn: 'addMomentComment', id, data }); return { ok: true, comment: { id: 'mc_x' } }; },
    deleteMomentComment: async (mid, cid, role) => { spies.domainCalls.push({ fn: 'deleteMomentComment', mid, cid, role }); return { ok: true }; },
    deleteMoment: async (id, opts) => { spies.domainCalls.push({ fn: 'deleteMoment', id, opts }); return { ok: true }; }
  };
  const adapter = A.createMomentsOrchestrationAdapter(Object.assign({
    autonomy: autonomy, mutation: mutation, domain: domain,
    /* 真实调用方（2C/2D）就是这样把注入时钟 + 真实 prefs + 语义推荐交给管线的：
       recommendation 属于 step.input（semantic 结果），不是 adapter 自己编的。 */
    autonomyDepsFor: (step) => ({
      now: NOW, prefs: { enabled: true, autoPublish: true, frequency: 'medium' },
      recommendation: (step && step.input && step.input.recommendation) || null
    })
  }, overrides || {}));
  return { adapter: adapter, spies: spies, domain: domain };
}
function planOf(steps) { return { planId: 'plan_m', actorId: 'role_a', steps: steps }; }
async function runPlan(steps, ctx) {
  const validated = C.validateAgentPlan(planOf(steps), reg);
  if (!validated.ok) return { invalid: validated.errors };
  return C.runAgentPlan(validated.plan, reg, {
    invokeAuthority: ctx.adapter.invokeAuthority,
    resolveExecutor: ctx.adapter.resolveExecutor,
    idempotencyKeyFor: ctx.adapter.idempotencyKeyFor
  });
}
const postStep = (input) => ({ stepId: 's1', capabilityId: 'moment.post', input: input, reasonCode: 'scheduled' });
const mutationStep = (capabilityId, input) => ({ stepId: 's1', capabilityId: capabilityId, input: input, reasonCode: 'social' });
const candidate = { candidateId: 'mca_abc', actorId: 'role_a', actionType: 'moment.post', source: 'schedule', triggerRef: 'schedule:1', topicFingerprint: 'mt_x', context: null };
const recPost = { recommendation: 'post', reasonCode: 'meaningful-moment', topicFingerprint: 'mt_x', draft: 'Closure 阶段的正文。' };
/* P25-2 的身份规则：candidateId 由 (actorId, triggerRef, topicFingerprint) 派生，
   Moment id 再由 candidateId 派生 —— adapter 不参与任何一步（M13）。 */
const derivedCandidateId = MA.buildMomentCandidate({ actorId: 'role_a', source: 'schedule', triggerRef: 'schedule:1', topicFingerprint: 'mt_x' }).candidate.candidateId;
const derivedMomentId = MA.momentIdForCandidate(derivedCandidateId);

console.log('== P25-3A · Moments Reference Adapter 测试 ==');

/* M1–M4 注册 */
check('M1.postRegistered', reg.has('moment.post') && reg.get('moment.post').authorityType === 'autonomy');
check('M2.likeRegistered', reg.has('moment.like') && reg.get('moment.like').authorityType === 'mutation');
check('M3.commentRegistered', reg.has('moment.comment') && reg.has('moment.reply') && reg.get('moment.comment').authorityType === 'mutation');
check('M4.deleteRegistered', reg.has('moment.comment.delete') && reg.has('moment.delete')
  && reg.get('moment.delete').kind === 'action' && registered.ok === true);

(async () => {
  /* M5/M6 post → Autonomy；executor 不得绕过 */
  const ctx = makeAdapter();
  const postRun = await runPlan([postStep({ candidate: candidate, recommendation: recPost })], ctx);
  check('M5.postRoutesToAutonomy',
    ctx.spies.autonomy === 1 && postRun.steps[0].status === 'completed'
    && ctx.spies.domainCalls.length === 1 && ctx.spies.domainCalls[0].fn === 'createMoment', 
    { autonomy: ctx.spies.autonomy, status: postRun.steps[0].status, domain: ctx.spies.domainCalls.length });
  check('M6.postCannotCallCreateMomentDirectly',
    !/window\.createMoment|_momentsWriteCanonical|dbPut|dbDelete/.test(ADAPTER_SRC)
    && !/[^.]\bcreateMoment\(/.test(ADAPTER_SRC.replace(/domain\.createMoment\(/g, 'domain.create()'))
    && ctx.spies.domainCalls.length === 1
    && ctx.spies.domainCalls[0].options && ctx.spies.domainCalls[0].options.id === derivedMomentId,
    ctx.spies.domainCalls[0] && ctx.spies.domainCalls[0].options);

  /* M7/M8 mutation → Mutation Authority */
  const ctx2 = makeAdapter();
  const likeRun = await runPlan([mutationStep('moment.like', {
    actorId: 'role_b', actorKind: 'role', source: 'character', targetMomentId: 'mom_1',
    facts: { momentExists: true, actorKnown: true }
  })], ctx2);
  check('M7.mutationRoutesToMutationAuthority',
    ctx2.spies.mutation === 1 && likeRun.steps[0].status === 'completed'
    && ctx2.spies.domainCalls.length === 1 && ctx2.spies.domainCalls[0].fn === 'likeMoment'
    && ctx2.spies.domainCalls[0].who === 'role_b', { mutation: ctx2.spies.mutation, calls: ctx2.spies.domainCalls });
  check('M8.mutationCannotDbPutDirectly', !/dbPut|dbDelete|MOMENT_STORE/.test(ADAPTER_SRC));

  /* M9/M10/M11 权限 → executor */
  const ctx3 = makeAdapter();
  const denied = await runPlan([mutationStep('moment.like', {
    actorId: 'role_a', actorKind: 'role', source: 'character', targetMomentId: 'mom_1',
    facts: { momentExists: true, actorKnown: true, actorIsMomentAuthor: true }
  })], ctx3);
  check('M9.denyStopsExecutor',
    denied.steps[0].status === 'denied' && denied.steps[0].errorCode === 'self-like' && ctx3.spies.domainCalls.length === 0,
    { status: denied.steps[0].status, err: denied.steps[0].errorCode, calls: ctx3.spies.domainCalls.length });
  const ctx4 = makeAdapter();
  const allowed = await runPlan([mutationStep('moment.comment', {
    actorId: 'role_b', actorKind: 'role', source: 'character', targetMomentId: 'mom_1', content: '一条评论',
    facts: { momentExists: true, actorKnown: true, actorCanSeeMoment: true }
  })], ctx4);
  check('M10.allowExecutorExactlyOnce',
    allowed.steps[0].status === 'completed' && ctx4.spies.domainCalls.length === 1
    && ctx4.adapter.executorCalls.s1 === 1, { calls: ctx4.spies.domainCalls.length, exec: ctx4.adapter.executorCalls });
  const ctx5 = makeAdapter({ domain: { likeMoment: async () => ({ ok: false, error: 'write-failed' }) } });
  const failedRun = await runPlan([mutationStep('moment.like', {
    actorId: 'role_b', actorKind: 'role', source: 'character', targetMomentId: 'mom_1',
    facts: { momentExists: true, actorKnown: true }
  })], ctx5);
  check('M11.executorFailureRemainsFailed',
    failedRun.steps[0].status === 'failed' && failedRun.steps[0].errorCode === 'write-failed'
    && failedRun.reflection.outcome === 'failed');

  /* M12–M16 边界保持 */
  check('M12.manualCreateExceptionNotRedefined',
    A.MOMENTS_CAPABILITIES.every(c => c.authorityType !== 'manual')
    && !/source:'manual'|authorType:'user'/.test(ADAPTER_SRC)
    && /source:'manual'/.test(MOMENTS_SRC));
  check('M13.candidateIdentityUntouched',
    !/stableToken|Math\.random|Date\.now/.test(ADAPTER_SRC)
    && /input\.candidate/.test(ADAPTER_SRC)
    /* 身份完全来自 P25-2 规则（adapter 不 mint）：adapter 只是把 candidate 透传给管线 */
    && ctx.spies.domainCalls[0].options.id === derivedMomentId
    && ctx.spies.domainCalls[0].options.id !== MA.momentIdForCandidate(candidate.candidateId));
  check('M14.mutationActorIdentityUntouched',
    /actorId: str\(input\.actorId\)/.test(ADAPTER_SRC)
    && !/nickname|displayName|apiConfigs/.test(ADAPTER_SRC)
    && ctx2.spies.domainCalls[0].who === 'role_b');
  check('M15.imageOrderingUntouched',
    !/_momentsMakeImage|imageRouter|wantImage|imagePrompt/.test(ADAPTER_SRC)
    && /writeMoment = function/.test(ADAPTER_SRC));
  check('M16.canonicalWriterUntouched',
    !/window\.createMoment|_momentsWriteCanonical|hn\.put|dbPut/.test(ADAPTER_SRC)
    && !/[^.]\bcreateMoment\(/.test(ADAPTER_SRC.replace(/domain\.createMoment\(/g, 'domain.create()'))
    && sha256('assets/js/moments.js') === 'E23697DECE58BA63EFB293432FA71A2CB785CE96E909B066C24A08FAB82CEE31');

  /* M17/M18 既有阶段守卫仍绿 */
  const allTests = read('tests/test-all.js');
  check('M17.p25_2ClosureGuardsStillGreen',
    sha256('assets/js/autonomy-core.js') === 'FE1011F1DC3434DB6A72A328A63AFEEAE99E1E95762EA910CE379F019F2956F8'
    && /test_moments_autonomy_closure\.js/.test(allTests));
  check('M18.p25_2_5GuardsStillGreen',
    sha256('assets/js/moments-mutation-authority.js') === '1FBB1E12FFF79D5FA03621B92F10F49DDAE0058AE7FE686A1DEB26F52FB5A056'
    && /test_moments_mutation_authority\.js/.test(allTests)
    && (await import('node:fs')).existsSync(path.join(ROOT, 'tests/test_moments_mutation_authority.js')));
  check('M18b.orchestratorNotWiredIntoProduction',
    !/agent-orchestration|IBAgentOrchestration|agent-capability-registry/.test(stripComments(MOMENTS_SRC))
    && !/agent-orchestration|IBAgentOrchestration/.test(stripComments(read('assets/js/communication.js')))
    && !/agent-orchestration/.test(read('InternalBeyond.html')));

  console.log('\n' + (failed === 0 ? 'ALL PASS' : 'FAILURES: ' + failures.join(', ')));
  console.log('P25-3A · moments adapter: ' + passed + ' passed, ' + failed + ' failed');
  process.exitCode = failed === 0 ? 0 : 1;
})().catch(e => { console.error('suite crashed:', e && e.stack || e); process.exitCode = 1; });
