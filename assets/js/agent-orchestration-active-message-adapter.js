/* ====================================================================
   IB Agent Orchestration · Active Message Capability Adapter — P25-3C
   --------------------------------------------------------------------
   把 Active Message 的**既有**发送权限边界登记成 capability，并声明它的 authority route：

     active_message.send → authorityType 'domain' → Active Message Authority
                           (assets/js/active-message-authority.js · runActiveMessageSend)

   capability 语义（§7）：**“请求向指定用户发送一条主动消息”** ——
   domain capability，不是 raw notification API、不是 db insert、不是 push primitive。

   ── 它不做什么（§22）───────────────────────────────────────────────
     · 不复制 Active Message authority：本文件零 decision 逻辑，裁决永远由注入的
       authority（真实 Active Message Authority）做出；
     · 不直接发送、不直接写库：零 dbPut / 零 chatMessages / 零 DOM / 零 fetch /
       零 provider / 零模型 / 零 Notification / 零 TTS；
     · 不重新发明消息身份：message id 由 domain 持有（`active_msg_*`），本层只透传 idempotencyKey。

   ── double authority（§24）──────────────────────────────────────────
     与 P25-3B Diary 同结论、**不实现** authorized-execution-envelope bypass：
     生产 domain 发送入口（_activeSendAuthorized → _activeWriteCanonical）与 legacy
     scheduler / AI plan 共用同一条 Active Message Authority 链，
     因此不存在“只有 orchestrator 能打开”的第二发送面。
     两次裁决（编排预检查 + domain 内）调用**同一个** authority、**同一份** facts，
     都是 fail-closed ⇒ 第二次不可能放宽第一次的结论。
   ==================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(null, require('./voice-message-core.js'),
      require('./agent-capability-registry.js'), require('./agent-orchestration-core.js'));
  } else {
    root.IBAgentOrchestrationActiveMessage = factory(root, root.IBVoiceMessage,
      root.IBAgentCapabilityRegistry, root.IBAgentOrchestrationCore);
  }
})(typeof self !== 'undefined' ? self : this, function (root, VOICE, REGISTRY, CORE) {
  'use strict';

  var DOMAIN = 'active_message';
  function isObject(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
  function isPlainObject(v) {
    if (!isObject(v)) return false;
    var proto = Object.getPrototypeOf(v);
    return proto === Object.prototype || proto === null;
  }
  function str(v) { return v == null ? '' : String(v); }

  /* ── Capability Descriptor（只声明；实现永远在 domain 侧，§21）────────
     字段遵守 P25-3A frozen descriptor（registry contract 未修改）。
     sideEffect 'local'：主动消息只写本地会话流（IndexedDB）+ 本机提示（可选），
     没有网络投递、没有 push 服务、没有外部副作用。 */
  var CAPABILITIES = Object.freeze([
    { id: 'active_message.send', domain: DOMAIN, kind: 'action',
      description: '请求向指定用户发送一条主动消息（经 Active Message Authority 裁决）',
      sideEffect: 'local', authorityType: 'domain', binding: 'active_message.send' }
  ]);
  function registerActiveMessageCapabilities(registry) {
    if (!registry || typeof registry.register !== 'function') return { ok: false, errors: ['registry-missing'] };
    var errors = [];
    CAPABILITIES.forEach(function (c) {
      var r = registry.register(Object.assign({}, c));
      if (!r.ok) errors.push(c.id + ':' + r.errors.join('|'));
    });
    return { ok: errors.length === 0, errors: errors };
  }

  /* ── Availability（§30 同源语义）─────────────────────────────────────
     availability 只回答**基础设施**是否可用：Active Message 模块是否加载、
     canonical 写入通道是否存在。它**不是** permission：enabled=false / 免打扰 /
     冷却 / 重复一律交给 Authority 裁决（DENY），不能伪装成 "capability unavailable"。 */
  function describeActiveMessageAvailability(input) {
    var env = isPlainObject(input) ? input : {};
    if (env.moduleLoaded === false || env.writerAvailable === false) return 'unavailable';
    return env.degraded === true ? 'degraded' : 'available';
  }

  /* ── Adapter：authority route + executor 绑定（全部注入，§22）──────────
     deps:
       authority : { runActiveMessageSend(candidate, facts, executor), buildActiveMessageCandidate?,
                     verifyActiveMessageSend(result, reader) } ← 真实 Active Message Authority
       domain    : { sendMessage(envelope, options) } ← 真实 domain 入口
                   （生产 = _activeSendAuthorized(...)：它自己再经同一 authority 与同一 writer）
       reader    : async (messageId) → canonical chat row|null ← verifier 用（真实读） */
  function createActiveMessageOrchestrationAdapter(deps) {
    var d = isPlainObject(deps) ? deps : {};
    var captured = Object.create(null);      /* stepId → authorized envelope（runtime-only，非持久） */
    var executorCalls = Object.create(null);
    function descriptorOf(capabilityId) {
      for (var i = 0; i < CAPABILITIES.length; i++) if (CAPABILITIES[i].id === capabilityId) return CAPABILITIES[i];
      return null;
    }
    function candidateOf(input) {
      if (isPlainObject(input.candidate)) return input.candidate;
      var raw = {
        actorId: str(input.actorId), targetId: str(input.targetId),
        source: str(input.source), trigger: str(input.trigger),
        triggerRef: str(input.triggerRef), messageRef: str(input.messageRef), contextRef: str(input.contextRef)
      };
      if (d.authority && typeof d.authority.buildActiveMessageCandidate === 'function') {
        var built = d.authority.buildActiveMessageCandidate(raw);
        return built && built.ok ? built.candidate : raw;
      }
      return raw;
    }
    /* ① Authority route：只问既有权威，不自己判断（Plan != Permission）。 */
    async function invokeAuthority(descriptor, step) {
      var capId = str(descriptor && descriptor.id);
      var stepId = str(step && step.stepId);
      var input = isPlainObject(step && step.input) ? step.input : {};
      if (capId !== 'active_message.send') return { decision: 'deny', reason: 'unknown-capability' };
      if (!d.authority || typeof d.authority.runActiveMessageSend !== 'function') return { decision: 'deny', reason: 'authority-missing' };
      var candidate = candidateOf(input);
      delete captured[stepId];
      var facts = isPlainObject(input.facts) ? input.facts : {};
      /* capture executor：只捕获"已被授权的意图"，绝不发送（真正写入在 executor）。 */
      var run = await d.authority.runActiveMessageSend(candidate, facts, function () {
        return Promise.resolve({ ok: true, message: null });
      });
      var decision = str(run && run.decision) || 'deny';
      if (decision === 'allow') {
        captured[stepId] = {
          capabilityId: 'active_message.send', authorityType: 'active_message', authorized: true,
          candidateId: str(candidate && candidate.candidateId),
          actorId: str((candidate && candidate.actorId) || (run && run.actorId)),
          targetId: str((candidate && candidate.targetId) || (run && run.targetId))
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
        if (capId !== 'active_message.send') return { ok: false, errorCode: 'unknown-capability' };
        var envelope = captured[stepId];
        if (!envelope || envelope.authorized !== true) return { ok: false, errorCode: 'no-authorized-candidate' };
        var domain = isPlainObject(d.domain) ? d.domain : {};
        if (typeof domain.sendMessage !== 'function') return { ok: false, errorCode: 'executor-missing' };
        var input = isPlainObject(execution && execution.input) ? execution.input : {};
        var res = await domain.sendMessage({
          actorId: envelope.actorId, targetId: envelope.targetId, candidateId: envelope.candidateId,
          idempotencyKey: str(execution && execution.idempotencyKey),
          source: str(input.source), trigger: str(input.trigger), triggerRef: str(input.triggerRef),
          contentRef: str(input.contentRef)
        });
        var ok = !!(res && res.ok === true);
        var message = (res && isObject(res.message)) ? res.message : null;
        return {
          ok: ok,
          output: { messageId: str(message && message.id), actorId: str(envelope.actorId), targetId: str(envelope.targetId), candidateId: str(envelope.candidateId) },
          errorCode: ok ? '' : (str(res && res.error) || str(res && res.reason) || 'active-message-send-failed').slice(0, 200)
        };
      };
    }
    /* ③ 幂等键透传（§19 同源）：domain 持有消息身份，本层不重新发明。 */
    function idempotencyKeyFor(descriptor, step) {
      var input = isPlainObject(step && step.input) ? step.input : {};
      if (str(input.idempotencyKey)) return str(input.idempotencyKey);
      var c = candidateOf(input);
      return str(c && c.candidateId);
    }
    /* ④ Verifier（§19）：只验证 canonical message 是否存在，不补发、不 retry、不改状态。
       注意：P25-3A 的 verifyStepResult 是**同步** contract，而 canonical 读（IndexedDB）
       是异步的 —— 因此本 adapter 暴露 async verify()，由调用方 await；**不修改 Foundation contract**。 */
    async function verify(executionResult) {
      var r = isPlainObject(executionResult) ? executionResult : {};
      if (!d.authority || typeof d.authority.verifyActiveMessageSend !== 'function') return { ok: false, verified: false, errorCode: 'authority-missing' };
      var out = isPlainObject(r.output) ? r.output : {};
      var messageId = str(out.messageId);
      var result = {
        status: str(r.status) || 'completed', ok: r.ok === true, actorId: str(out.actorId),
        messageId: messageId,
        message: messageId ? { id: messageId, friendId: str(out.actorId), source: 'active_message' } : null
      };
      return d.authority.verifyActiveMessageSend(result, typeof d.reader === 'function' ? d.reader : null);
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
    ACTIVE_MESSAGE_CAPABILITIES: CAPABILITIES,
    registerActiveMessageCapabilities: registerActiveMessageCapabilities,
    describeActiveMessageAvailability: describeActiveMessageAvailability,
    createActiveMessageOrchestrationAdapter: createActiveMessageOrchestrationAdapter
  };
});
