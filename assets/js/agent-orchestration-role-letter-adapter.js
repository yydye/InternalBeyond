/* ====================================================================
   IB Agent Orchestration · Role Letter Capability Adapter — P25-3D
   --------------------------------------------------------------------
   把 Role Letter 的**既有**写信权限边界登记成 capability，并声明它的 authority route：

     role_letter.write → authorityType 'domain' → Role Letter Authority
                         (assets/js/role-letter-authority.js · runRoleLetterWrite)

   capability 语义（§7）：**“请求一个角色向指定 recipient 创建一封 Role Letter”** ——
   domain capability，不是 raw DB insert、不是 message send、不是 notification、
   不是 relationship update。

   ── 它不做什么（§20）───────────────────────────────────────────────
     · 不复制 Role Letter authority：本文件零 decision 逻辑，裁决永远由注入的
       authority（真实 Role Letter Authority）做出；
     · 不直接写库、不直接调用 writer：零 dbPut / 零 roleLetters / 零 DOM / 零 fetch /
       零 provider / 零模型 / 零 Memory / 零 Middle Brain；
     · 不重新发明 letter 身份：letter id 由 domain 持有（`rletter_*`），本层只透传 idempotencyKey。

   ── double authority（§1 Plan != Permission）────────────────────────
     与 P25-3B / P25-3C 同结论、**不实现** authorized-execution-envelope bypass：
     生产 domain 入口（_rlStoreLetter → _rlWriteCanonical）与 legacy cadence / 回信路径
     共用同一条 Role Letter Authority 链，因此不存在"只有 orchestrator 能打开"的第二写信面。
     两次裁决（编排预检查 + domain 内）调用**同一个** authority、**同一份** facts，
     都是 fail-closed ⇒ 第二次不可能放宽第一次的结论。
   ==================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(null, require('./voice-message-core.js'),
      require('./agent-capability-registry.js'), require('./agent-orchestration-core.js'));
  } else {
    root.IBAgentOrchestrationRoleLetter = factory(root, root.IBVoiceMessage,
      root.IBAgentCapabilityRegistry, root.IBAgentOrchestrationCore);
  }
})(typeof self !== 'undefined' ? self : this, function (root, VOICE, REGISTRY, CORE) {
  'use strict';

  var DOMAIN = 'role_letter';
  function isObject(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
  function isPlainObject(v) {
    if (!isObject(v)) return false;
    var proto = Object.getPrototypeOf(v);
    return proto === Object.prototype || proto === null;
  }
  function str(v) { return v == null ? '' : String(v); }

  /* ── Capability Descriptor（只声明；实现永远在 domain 侧，§19）──────── */
  var CAPABILITIES = Object.freeze([
    { id: 'role_letter.write', domain: DOMAIN, kind: 'write',
      description: '请求一个角色向指定 recipient 创建一封 Role Letter（经 Role Letter Authority 裁决）',
      sideEffect: 'local', authorityType: 'domain', binding: 'role_letter.write' }
  ]);
  function registerRoleLetterCapabilities(registry) {
    if (!registry || typeof registry.register !== 'function') return { ok: false, errors: ['registry-missing'] };
    var errors = [];
    CAPABILITIES.forEach(function (c) {
      var r = registry.register(Object.assign({}, c));
      if (!r.ok) errors.push(c.id + ':' + r.errors.join('|'));
    });
    return { ok: errors.length === 0, errors: errors };
  }

  /* ── Availability ───────────────────────────────────────────────────
     availability 只回答**基础设施**是否可用（Role Letter 模块是否加载、canonical writer 是否存在）；
     它**不是** permission：总开关关闭 / 对偶冷却 / 已回已拒一律交给 Role Letter Authority 裁决。 */
  function describeRoleLetterAvailability(input) {
    var env = isPlainObject(input) ? input : {};
    if (env.moduleLoaded === false || env.writerAvailable === false) return 'unavailable';
    return env.degraded === true ? 'degraded' : 'available';
  }

  /* ── Adapter：authority route + executor 绑定（全部注入，§20）──────────
     deps:
       authority : { runRoleLetterWrite(candidate, facts, executor), buildRoleLetterCandidate?,
                     verifyRoleLetterWrite(result, reader) } ← 真实 Role Letter Authority
       domain    : { writeLetter(envelope, options) } ← 真实 domain 入口
                   （生产 = _rlStoreLetter(...)：它自己再经同一 authority 与同一 writer）
       reader    : async (letterId) → canonical roleLetters row|null ← verifier 用 */
  function createRoleLetterOrchestrationAdapter(deps) {
    var d = isPlainObject(deps) ? deps : {};
    var captured = Object.create(null);
    var executorCalls = Object.create(null);
    function descriptorOf(capabilityId) {
      for (var i = 0; i < CAPABILITIES.length; i++) if (CAPABILITIES[i].id === capabilityId) return CAPABILITIES[i];
      return null;
    }
    function candidateOf(input) {
      if (isPlainObject(input.candidate)) return input.candidate;
      var raw = {
        actorId: str(input.actorId), recipientId: str(input.recipientId),
        source: str(input.source), letterKind: str(input.letterKind) || 'init',
        trigger: str(input.trigger), triggerRef: str(input.triggerRef), contextRef: str(input.contextRef)
      };
      if (d.authority && typeof d.authority.buildRoleLetterCandidate === 'function') {
        var built = d.authority.buildRoleLetterCandidate(raw);
        return built && built.ok ? built.candidate : raw;
      }
      return raw;
    }
    /* ① Authority route：只问既有权威，不自己判断（Plan != Permission）。 */
    async function invokeAuthority(descriptor, step) {
      var capId = str(descriptor && descriptor.id);
      var stepId = str(step && step.stepId);
      var input = isPlainObject(step && step.input) ? step.input : {};
      if (capId !== 'role_letter.write') return { decision: 'deny', reason: 'unknown-capability' };
      if (!d.authority || typeof d.authority.runRoleLetterWrite !== 'function') return { decision: 'deny', reason: 'authority-missing' };
      var candidate = candidateOf(input);
      delete captured[stepId];
      var facts = isPlainObject(input.facts) ? input.facts : {};
      /* capture executor：只捕获"已被授权的意图"，绝不写库（真正写入在 executor）。 */
      var run = await d.authority.runRoleLetterWrite(candidate, facts, function () {
        return Promise.resolve({ ok: true, letter: null });
      });
      var decision = str(run && run.decision) || 'deny';
      if (decision === 'allow') {
        captured[stepId] = {
          capabilityId: 'role_letter.write', authorityType: 'role_letter', authorized: true,
          candidateId: str(candidate && candidate.candidateId),
          actorId: str((candidate && candidate.actorId) || (run && run.actorId)),
          recipientId: str((candidate && candidate.recipientId) || (run && run.recipientId)),
          letterKind: str((candidate && candidate.letterKind) || 'init')
        };
      }
      return { decision: decision, reason: str(run && run.reason) || 'unknown', run: run };
    }
    /* ② Executor：只有 ALLOW 之后编排层才会调用；此处只转交**既有** domain 入口。 */
    function resolveExecutor(descriptor) {
      var capId = str(descriptor && descriptor.id);
      return async function (execution) {
        var stepId = str(execution && execution.stepId);
        executorCalls[stepId] = (executorCalls[stepId] || 0) + 1;
        if (executorCalls[stepId] > 1) return { ok: false, errorCode: 'executor-called-twice' };
        if (capId !== 'role_letter.write') return { ok: false, errorCode: 'unknown-capability' };
        var envelope = captured[stepId];
        if (!envelope || envelope.authorized !== true) return { ok: false, errorCode: 'no-authorized-candidate' };
        var domain = isPlainObject(d.domain) ? d.domain : {};
        if (typeof domain.writeLetter !== 'function') return { ok: false, errorCode: 'executor-missing' };
        var input = isPlainObject(execution && execution.input) ? execution.input : {};
        var res = await domain.writeLetter({
          actorId: envelope.actorId, recipientId: envelope.recipientId, candidateId: envelope.candidateId,
          letterKind: envelope.letterKind, idempotencyKey: str(execution && execution.idempotencyKey),
          content: str(input.content), trigger: str(input.trigger), triggerRef: str(input.triggerRef)
        });
        var ok = !!(res && res.ok === true);
        var letter = (res && isObject(res.letter)) ? res.letter : null;
        return {
          ok: ok,
          output: { letterId: str(letter && letter.id), actorId: str(envelope.actorId), recipientId: str(envelope.recipientId), candidateId: str(envelope.candidateId) },
          errorCode: ok ? '' : (str(res && res.error) || 'role-letter-write-failed').slice(0, 200)
        };
      };
    }
    /* ③ 幂等键透传：domain 持有 letter 身份，本层不重新发明。 */
    function idempotencyKeyFor(descriptor, step) {
      var input = isPlainObject(step && step.input) ? step.input : {};
      if (str(input.idempotencyKey)) return str(input.idempotencyKey);
      var c = candidateOf(input);
      return str(c && c.candidateId);
    }
    /* ④ Verifier（§21）：只验证 canonical letter 是否存在，不补写、不 retry。
       注意：P25-3A 的 verifyStepResult 是**同步** contract，而 canonical 读（IndexedDB）
       是异步的 —— 因此本 adapter 暴露 async verify()，由调用方 await；不修改 Foundation contract。 */
    async function verify(executionResult) {
      var r = isPlainObject(executionResult) ? executionResult : {};
      if (!d.authority || typeof d.authority.verifyRoleLetterWrite !== 'function') return { ok: false, verified: false, errorCode: 'authority-missing' };
      var out = isPlainObject(r.output) ? r.output : {};
      var letterId = str(out.letterId);
      var result = {
        status: str(r.status) || 'completed', ok: r.ok === true,
        actorId: str(out.actorId), recipientId: str(out.recipientId),
        letterId: letterId,
        letter: letterId ? { id: letterId, fromRoleId: str(out.actorId), toRoleId: str(out.recipientId) } : null
      };
      return d.authority.verifyRoleLetterWrite(result, typeof d.reader === 'function' ? d.reader : null);
    }
    return {
      capabilities: CAPABILITIES,
      descriptorOf: descriptorOf,
      invokeAuthority: invokeAuthority,
      resolveExecutor: resolveExecutor,
      idempotencyKeyFor: idempotencyKeyFor,
      verify: verify,
      captured: captured,
      executorCalls: executorCalls
    };
  }

  return {
    ROLE_LETTER_CAPABILITIES: CAPABILITIES,
    registerRoleLetterCapabilities: registerRoleLetterCapabilities,
    describeRoleLetterAvailability: describeRoleLetterAvailability,
    createRoleLetterOrchestrationAdapter: createRoleLetterOrchestrationAdapter
  };
});
