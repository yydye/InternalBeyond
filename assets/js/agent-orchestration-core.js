/* ====================================================================
   IB Agent Orchestration Core — P25-3A · Unified Agent Orchestration Foundation
   --------------------------------------------------------------------
   统一编排契约的**纯**实现（不含任何业务知识）：

     Intent → Observe（facts 外部提供）→ Plan（本层只校验）→ Capability Resolution
           → Authority Routing Contract（route 到 domain authority，**本层不裁决**）
           → Execute（executor 注入）→ Verify（只定义 contract）→ Reflect（结构化 summary）

   ── 冻结 ─────────────────────────────────────────────────────────────
     · Plan != Permission：plan 里出现某 capability ≠ 允许执行；执行前必须由
       **domain authority** 裁决（本层只负责把步骤路由到那个 authority）。
     · Orchestrator 不是 super authority：不复制 Moments / Economy 等任何 domain 的权限。
     · 纯：零 DOM / 零 IndexedDB / 零 fetch / 零 provider / 零模型 / 零 Memory /
       零 Middle Brain / 零 scheduler / 零定时器；executor 全部注入。
   ==================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(null, require('./voice-message-core.js'), require('./agent-capability-registry.js'));
  } else {
    root.IBAgentOrchestrationCore = factory(root, root.IBVoiceMessage, root.IBAgentCapabilityRegistry);
  }
})(typeof self !== 'undefined' ? self : this, function (root, VOICE, REGISTRY) {
  'use strict';

  var ORCHESTRATION_SOURCES = Object.freeze(['user', 'schedule', 'character', 'group_runtime', 'system']);
  var EXECUTION_STATUS = Object.freeze(['completed', 'denied', 'deferred', 'failed', 'unavailable']);
  var REFLECTION_OUTCOMES = Object.freeze(['success', 'partial', 'failed']);
  var FORBIDDEN_REASONING_KEYS = Object.freeze(['thinking', 'analysis', 'rationale', 'scratchpad',
    'chain_of_thought', 'chainofthought', 'internal_reasoning', 'cot', 'reasoning']);
  var FORBIDDEN_CONTEXT_KEYS = Object.freeze(['apikey', 'api_key', 'token', 'secret', 'password',
    'credential', 'authorization', 'bearer', 'endpoint', 'provider', 'providerconfig',
    'raw_response', 'rawresponse', 'messages', 'history', 'fullhistory']);
  var MAX_ID_LEN = 200;
  var MAX_GOAL_LEN = 200;
  var MAX_CONTEXT_KEYS = 24;
  var MAX_STEPS = 32;
  var CONTROL_PATTERN = /[\u0000-\u001F\u007F]/;
  var REASON_CODE_PATTERN = /^[a-z][a-z0-9_-]{0,40}$/;

  function isObject(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
  function isPlainObject(v) {
    if (!isObject(v)) return false;
    var proto = Object.getPrototypeOf(v);
    return proto === Object.prototype || proto === null;
  }
  function str(v) { return v == null ? '' : String(v); }
  function dedupe(list) {
    var out = [];
    for (var i = 0; i < list.length; i++) if (out.indexOf(list[i]) < 0) out.push(list[i]);
    return out;
  }
  function hasSecret(v) {
    try { if (VOICE && typeof VOICE.findSecret === 'function') return !!VOICE.findSecret(v); } catch (e) { /* 探测失败不阻断 */ }
    return false;
  }
  function normalizeKey(k) { return String(k).toLowerCase().replace(/[\s\-_]/g, ''); }
  function reasoningKeyOf(value, depth) {
    if (!isPlainObject(value) || (depth || 0) > 4) return '';
    var keys = Object.keys(value);
    for (var i = 0; i < keys.length; i++) {
      var norm = normalizeKey(keys[i]);
      for (var j = 0; j < FORBIDDEN_REASONING_KEYS.length; j++) {
        if (norm === normalizeKey(FORBIDDEN_REASONING_KEYS[j])) return keys[i];
      }
      var deeper = reasoningKeyOf(value[keys[i]], (depth || 0) + 1);
      if (deeper) return deeper;
    }
    return '';
  }
  function contextViolation(ctx) {
    if (ctx === undefined || ctx === null) return '';
    if (!isPlainObject(ctx)) return 'bad-context';
    if (hasSecret(ctx)) return 'secret-in-context';
    var keys = Object.keys(ctx);
    if (keys.length > MAX_CONTEXT_KEYS) return 'context-too-large';
    for (var i = 0; i < keys.length; i++) {
      var norm = normalizeKey(keys[i]);
      if (FORBIDDEN_CONTEXT_KEYS.indexOf(norm) >= 0) return 'forbidden-context-field:' + keys[i];
      if (Array.isArray(ctx[keys[i]]) && ctx[keys[i]].length > 32) return 'context-array-too-large:' + keys[i];
    }
    return '';
  }

  /* ── AgentOrchestrationRequest（§11）───────────────────────────────── */
  function buildOrchestrationRequest(input) {
    if (!isPlainObject(input)) return { ok: false, errors: ['not-an-object'] };
    var errors = [];
    var requestId = str(input.requestId);
    if (!requestId || requestId.length > MAX_ID_LEN || CONTROL_PATTERN.test(requestId) || requestId !== requestId.trim()) errors.push('bad-request-id');
    var actorId = str(input.actorId);
    if (!actorId || actorId.length > MAX_ID_LEN || CONTROL_PATTERN.test(actorId) || actorId !== actorId.trim()) errors.push('bad-actor-id');
    if (ORCHESTRATION_SOURCES.indexOf(str(input.source)) < 0) errors.push('bad-source');
    var intent = input.intent;
    if (!isPlainObject(intent)) errors.push('bad-intent');
    else {
      var goal = str(intent.goal);
      if (!goal || goal.length > MAX_GOAL_LEN || CONTROL_PATTERN.test(goal)) errors.push('bad-goal');
      if (intent.constraints !== undefined && !isPlainObject(intent.constraints)) errors.push('bad-constraints');
      if (intent.preferredCapabilities !== undefined) {
        var preferred = intent.preferredCapabilities;
        var okPreferred = Array.isArray(preferred) && preferred.every(function (c) { return str(c).length > 0 && str(c).length <= MAX_ID_LEN; });
        if (!okPreferred) errors.push('bad-preferred-capabilities');
      }
    }
    var ctxIssue = contextViolation(input.context);
    if (ctxIssue) errors.push(ctxIssue);
    var reasoning = reasoningKeyOf(input);
    if (reasoning) errors.push('forbidden-reasoning-field:' + reasoning);
    if (hasSecret({ requestId: requestId, actorId: actorId, intent: intent })) errors.push('secret-in-request');
    errors = dedupe(errors);
    if (errors.length) return { ok: false, errors: errors };
    return {
      ok: true, errors: [],
      request: {
        requestId: requestId, actorId: actorId, source: str(input.source),
        intent: {
          goal: str(intent.goal),
          constraints: isPlainObject(intent.constraints) ? Object.assign({}, intent.constraints) : {},
          preferredCapabilities: Array.isArray(intent.preferredCapabilities) ? intent.preferredCapabilities.map(str) : []
        },
        context: isPlainObject(input.context) ? Object.assign({}, input.context) : {},
        conversationId: str(input.conversationId), groupTurnId: str(input.groupTurnId)
      }
    };
  }

  /* ── Observation Bundle（§13；只放 plan 所需 facts）─────────────────── */
  function buildObservationBundle(input) {
    if (!isPlainObject(input)) return { ok: false, errors: ['not-an-object'] };
    var errors = [];
    if (!str(input.actorId)) errors.push('missing-actor-id');
    if (input.capabilities !== undefined && !Array.isArray(input.capabilities)) errors.push('bad-capabilities');
    if (input.domainFacts !== undefined && !isPlainObject(input.domainFacts)) errors.push('bad-domain-facts');
    var ctxIssue = contextViolation(input.domainFacts);
    if (ctxIssue) errors.push(ctxIssue);
    var reasoning = reasoningKeyOf(input);
    if (reasoning) errors.push('forbidden-reasoning-field:' + reasoning);
    if (hasSecret({ capabilities: input.capabilities, domainFacts: input.domainFacts })) errors.push('secret-in-observation');
    errors = dedupe(errors);
    if (errors.length) return { ok: false, errors: errors };
    return {
      ok: true, errors: [],
      bundle: {
        actor: isPlainObject(input.actor) ? Object.assign({}, input.actor) : { id: str(input.actorId) },
        conversation: isPlainObject(input.conversation) ? Object.assign({}, input.conversation) : null,
        activity: isPlainObject(input.activity) ? Object.assign({}, input.activity) : null,
        capabilities: Array.isArray(input.capabilities) ? input.capabilities.map(str).slice(0, 64) : [],
        domainFacts: isPlainObject(input.domainFacts) ? Object.assign({}, input.domainFacts) : {}
      }
    };
  }

  /* ── Plan validation（§14/§28：确定性、DAG、无环、有界）─────────────── */
  function validateAgentPlan(plan, registry) {
    if (!isPlainObject(plan)) return { ok: false, errors: ['plan-not-an-object'] };
    var errors = [];
    var planId = str(plan.planId);
    if (!planId || planId.length > MAX_ID_LEN) errors.push('bad-plan-id');
    if (!str(plan.actorId)) errors.push('missing-actor-id');
    if (!Array.isArray(plan.steps) || !plan.steps.length) errors.push('missing-steps');
    if (Array.isArray(plan.steps) && plan.steps.length > MAX_STEPS) errors.push('too-many-steps');
    var reasoning = reasoningKeyOf(plan);
    if (reasoning) errors.push('forbidden-reasoning-field:' + reasoning);
    if (hasSecret(plan)) errors.push('secret-in-plan');
    var steps = Array.isArray(plan.steps) ? plan.steps : [];
    var rawIds = [];
    /* 第一遍：收集**全部** stepId（含重复，用于重复检测；依赖允许前向引用，
       因此必须先把全集收齐再校验 dependsOn）。 */
    for (var k = 0; k < steps.length; k++) {
      var sPre = steps[k];
      if (!isPlainObject(sPre)) continue;
      var idPre = str(sPre.stepId);
      if (!idPre || idPre.length > MAX_ID_LEN) continue;
      rawIds.push(idPre);
    }
    var ids = dedupe(rawIds);
    for (var i = 0; i < steps.length; i++) {
      var s = steps[i];
      if (!isPlainObject(s)) { errors.push('bad-step:' + i); continue; }
      var stepId = str(s.stepId);
      if (!stepId || stepId.length > MAX_ID_LEN) errors.push('bad-step-id:' + i);
      else if (rawIds.filter(function (x) { return x === stepId; }).length > 1) errors.push('duplicate-step-id:' + stepId);
      var capId = str(s.capabilityId);
      if (!capId) errors.push('missing-capability:' + i);
      else if (registry && registry.has && !registry.has(capId)) errors.push('unknown-capability:' + capId);
      if (s.input !== undefined) {
        if (!isPlainObject(s.input)) errors.push('bad-step-input:' + i);
        else {
          var ctxIssue = contextViolation(s.input);
          if (ctxIssue) errors.push(ctxIssue + ':' + i);
        }
      }
      if (s.reasonCode !== undefined && !REASON_CODE_PATTERN.test(str(s.reasonCode))) errors.push('bad-reason-code:' + i);
      if (s.dependsOn !== undefined) {
        if (!Array.isArray(s.dependsOn)) errors.push('bad-depends-on:' + i);
        else if (!s.dependsOn.every(function (dep) { return ids.indexOf(str(dep)) >= 0; })) errors.push('unknown-dependency:' + i);
      }
    }
    if (ids.length) {
      var graph = {};
      steps.forEach(function (s) { graph[str(s.stepId)] = (s.dependsOn || []).map(str); });
      var state = {};
      var cycle = false;
      function visit(id) {
        if (state[id] === 'visiting') { cycle = true; return; }
        if (state[id] === 'done' || cycle) return;
        state[id] = 'visiting';
        (graph[id] || []).forEach(visit);
        state[id] = 'done';
      }
      ids.forEach(visit);
      if (cycle) errors.push('dependency-cycle');   /* 环检测与其它字段错误相互独立 */
    }
    errors = dedupe(errors);
    if (errors.length) return { ok: false, errors: errors };
    return {
      ok: true, errors: [],
      plan: {
        planId: planId, actorId: str(plan.actorId),
        steps: steps.map(function (s) {
          return {
            stepId: str(s.stepId), capabilityId: str(s.capabilityId),
            input: isPlainObject(s.input) ? Object.assign({}, s.input) : {},
            dependsOn: Array.isArray(s.dependsOn) ? s.dependsOn.map(str) : [],
            reasonCode: s.reasonCode === undefined ? '' : str(s.reasonCode)
          };
        })
      }
    };
  }
  /* 确定性执行顺序：拓扑序（同一层按声明顺序）；无环已由上一步保证。 */
  function planStepsInOrder(plan) {
    var steps = (plan && Array.isArray(plan.steps)) ? plan.steps.slice() : [];
    var byId = {};
    steps.forEach(function (s) { byId[str(s.stepId)] = s; });
    var out = [], state = {};
    steps.forEach(function (s) {
      (function visit(step) {
        var id = str(step.stepId);
        if (state[id]) return;
        (step.dependsOn || []).forEach(function (dep) { if (byId[str(dep)]) visit(byId[str(dep)]); });
        state[id] = true;
        out.push(step);
      })(s);
    });
    return out;
  }

  /* ── Authority Routing Contract（§16/§31/§32）─────────────────────────
     本层只回答"这一步该问哪个 authority"，**不回答允许不允许**。 */
  function routeStepAuthority(descriptor, step) {
    if (!descriptor) return { ok: false, error: 'unknown-capability' };
    var kind = str(descriptor.kind);
    var authorityType = str(descriptor.authorityType);
    if (kind === 'read') {
      if (authorityType !== 'read-only') return { ok: false, error: 'invalid-authority-declaration' };
      return { ok: true, route: { required: false, authorityType: 'read-only', binding: str(descriptor.binding) } };
    }
    if (['autonomy', 'mutation', 'domain', 'manual'].indexOf(authorityType) < 0) {
      return { ok: false, error: 'side-effect-capability-needs-authority' };
    }
    return {
      ok: true,
      route: { required: true, authorityType: authorityType, binding: str(descriptor.binding), capabilityId: str(descriptor.id), stepId: str(step && step.stepId) }
    };
  }

  /* 输出只允许结构化、可审计字段；凭据/CoT 一律剥离（§23）。 */
  function sanitizeOutput(output) {
    if (output === undefined || output === null) return null;
    if (typeof output === 'number' || typeof output === 'boolean') return output;
    if (typeof output === 'string') return hasSecret(output) ? null : output.slice(0, 500);
    if (Array.isArray(output)) return output.slice(0, 16).map(sanitizeOutput);
    if (isPlainObject(output)) {
      if (reasoningKeyOf(output)) return null;
      var out = {};
      Object.keys(output).slice(0, 24).forEach(function (k) {
        if (FORBIDDEN_CONTEXT_KEYS.indexOf(normalizeKey(k)) >= 0) return;
        out[k] = sanitizeOutput(output[k]);
      });
      return out;
    }
    return null;
  }

  /* ── Reflect（§21：结构化 outcome summary，无隐藏推理文本）──────────── */
  function reflectSteps(results) {
    var list = Array.isArray(results) ? results : [];
    var completedSteps = [], deniedSteps = [], failedSteps = [], deferredSteps = [], unavailableSteps = [], reasonCodes = [];
    list.forEach(function (r) {
      if (r.status === 'completed') completedSteps.push(r.stepId);
      else if (r.status === 'denied') deniedSteps.push(r.stepId);
      else if (r.status === 'failed') failedSteps.push(r.stepId);
      else if (r.status === 'deferred') deferredSteps.push(r.stepId);
      else unavailableSteps.push(r.stepId);
      if (r.errorCode) reasonCodes.push(r.errorCode);
    });
    var blocked = deniedSteps.length + deferredSteps.length + unavailableSteps.length;
    var outcome = failedSteps.length ? (completedSteps.length ? 'partial' : 'failed')
      : (blocked ? (completedSteps.length ? 'partial' : 'failed') : 'success');
    return {
      outcome: REFLECTION_OUTCOMES.indexOf(outcome) >= 0 ? outcome : 'failed',
      completedSteps: completedSteps,
      deniedSteps: deniedSteps,
      failedSteps: failedSteps,
      deferredSteps: deferredSteps,
      unavailableSteps: unavailableSteps,
      reasonCodes: dedupe(reasonCodes).slice(0, 24)
    };
  }

  /* ── Execution（§18/§19）───────────────────────────────────────────────
     deps（全部注入；本层不做任何 IO）：
       resolveExecutor(descriptor) → function|null
       invokeAuthority(descriptor, step, plan) → {decision:'allow'|'deny'|'defer', reason?}
       isCancelled() → bool
       idempotencyKeyFor(descriptor, step) → string（透传 domain，本层不实现业务幂等） */
  async function runAgentPlan(plan, registry, deps) {
    var d = isObject(deps) ? deps : {};
    var validated = (isObject(plan) && Array.isArray(plan.steps) && plan.planId !== undefined)
      ? { ok: true, plan: plan }
      : validateAgentPlan(plan, registry);
    if (!validated.ok) {
      return {
        ok: false, planId: str(plan && plan.planId), actorId: '', status: 'failed',
        errorCode: 'invalid-plan', errors: validated.errors, steps: [], reflection: reflectSteps([])
      };
    }
    var p = validated.plan;
    var ordered = planStepsInOrder(p);
    var results = [], completed = {};
    for (var i = 0; i < ordered.length; i++) {
      var step = ordered[i];
      var capId = str(step.capabilityId);
      var descriptor = (registry && registry.get) ? registry.get(capId) : null;
      var base = { capabilityId: capId, stepId: str(step.stepId), reasonCode: str(step.reasonCode), ok: false, status: '', errorCode: '' };
      /* ① 取消：后续 step 一律不执行（已完成的 side effect 不回滚，§27） */
      if (typeof d.isCancelled === 'function' && d.isCancelled() === true) {
        results.push(Object.assign({}, base, { status: 'denied', errorCode: 'cancelled' }));
        continue;
      }
      /* ② capability 必须已注册 */
      if (!descriptor) { results.push(Object.assign({}, base, { status: 'unavailable', errorCode: 'unknown-capability' })); continue; }
      /* ③ dependency：依赖未 completed ⇒ 本步不执行 */
      var blocked = (step.dependsOn || []).some(function (dep) { return completed[str(dep)] !== true; });
      if (blocked) { results.push(Object.assign({}, base, { status: 'denied', errorCode: 'dependency-failed' })); continue; }
      /* ④ authority routing（本层不裁决；写能力缺 authority ⇒ unavailable，fail closed） */
      var routed = routeStepAuthority(descriptor, step);
      if (!routed.ok) { results.push(Object.assign({}, base, { status: 'unavailable', errorCode: routed.error })); continue; }
      if (routed.route.required) {
        if (typeof d.invokeAuthority !== 'function') {
          results.push(Object.assign({}, base, { status: 'unavailable', errorCode: 'authority-missing' }));
          continue;
        }
        var verdict = null;
        /* authority 可能是异步的（域内管线/权威普遍 async）⇒ 必须 await 后再读 decision。 */
        try { verdict = await d.invokeAuthority(descriptor, step, p); }
        catch (error) { results.push(Object.assign({}, base, { status: 'denied', errorCode: 'authority-failure' })); continue; }
        var decision = str(verdict && verdict.decision);
        if (decision === 'deny') { results.push(Object.assign({}, base, { status: 'denied', errorCode: str(verdict && verdict.reason) || 'denied' })); continue; }
        if (decision === 'defer') { results.push(Object.assign({}, base, { status: 'deferred', errorCode: str(verdict && verdict.reason) || 'deferred' })); continue; }
        if (decision !== 'allow') { results.push(Object.assign({}, base, { status: 'denied', errorCode: 'authority-failure' })); continue; }
      }
      /* ⑤ executor（注入；缺席 ⇒ unavailable；**不自动 retry side effect**，§29） */
      var executor = (typeof d.resolveExecutor === 'function') ? d.resolveExecutor(descriptor) : null;
      if (typeof executor !== 'function') { results.push(Object.assign({}, base, { status: 'unavailable', errorCode: 'executor-missing' })); continue; }
      var idem = (typeof d.idempotencyKeyFor === 'function') ? str(d.idempotencyKeyFor(descriptor, step)) : '';
      var execResult = null, execError = '';
      try {
        execResult = await executor({
          capabilityId: capId, stepId: step.stepId, input: step.input, idempotencyKey: idem,
          declaration: { authorityType: descriptor.authorityType, sideEffect: descriptor.sideEffect }
        });
      } catch (error) { execError = str((error && error.message) || error).slice(0, 200); }
      var ok = !execError && !(isObject(execResult) && execResult.ok === false);
      var out = (isObject(execResult) && execResult.output !== undefined) ? execResult.output : undefined;
      results.push(Object.assign({}, base, {
        ok: ok,
        status: ok ? 'completed' : 'failed',
        errorCode: ok ? '' : (execError || str(execResult && execResult.errorCode) || 'executor-failed'),
        output: sanitizeOutput(out),
        idempotencyKey: idem
      }));
      if (ok) completed[str(step.stepId)] = true;
    }
    return {
      ok: results.length > 0 && results.every(function (r) { return r.status === 'completed'; }),
      planId: p.planId, actorId: p.actorId, status: 'completed',
      steps: results, reflection: reflectSteps(results)
    };
  }

  /* ── Verify（§20：本阶段只定义 contract，不给模块实现 verifier）──────── */
  function verifyStepResult(result, verifier) {
    if (typeof verifier !== 'function') return { ok: false, verified: false, errorCode: 'verifier-missing' };
    var r = isObject(result) ? result : {};
    if (r.status !== 'completed') return { ok: false, verified: false, errorCode: 'not-completed' };
    try {
      var out = verifier(r);
      if (isObject(out)) return { ok: out.verified === true, verified: out.verified === true, detail: sanitizeOutput(out.detail) };
      return { ok: out === true, verified: out === true };
    } catch (error) { return { ok: false, verified: false, errorCode: 'verifier-failed' }; }
  }

  return {
    ORCHESTRATION_SOURCES: ORCHESTRATION_SOURCES,
    EXECUTION_STATUS: EXECUTION_STATUS,
    REFLECTION_OUTCOMES: REFLECTION_OUTCOMES,
    FORBIDDEN_REASONING_KEYS: FORBIDDEN_REASONING_KEYS,
    buildOrchestrationRequest: buildOrchestrationRequest,
    buildObservationBundle: buildObservationBundle,
    validateAgentPlan: validateAgentPlan,
    planStepsInOrder: planStepsInOrder,
    routeStepAuthority: routeStepAuthority,
    runAgentPlan: runAgentPlan,
    reflectSteps: reflectSteps,
    verifyStepResult: verifyStepResult,
    sanitizeOutput: sanitizeOutput
  };
});
