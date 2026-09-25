/* ====================================================================
   IB Agent Orchestration · Diary Capability Adapter — P25-3B
   --------------------------------------------------------------------
   把 Diary 的**既有**写权限边界登记成 capability，并声明它的 authority route：

     diary.write → authorityType 'domain' → Diary Authority
                   (assets/js/diary-authority.js · runDiaryWrite)

   capability 语义（§7）：**"请求角色生成并写入一篇 Diary entry"** ——
   是 domain capability，不是 raw storage primitive（不是"把一段文本塞进 DB"）。

   ── 它不做什么（§24）───────────────────────────────────────────────
     · 不复制 Diary authority：本文件零 decision 逻辑，裁决永远由注入的
       authority（真实 Diary Authority）做出；
     · 不直接写库：零 dbPut / 零 IndexedDB / 零 DOM / 零 fetch / 零 provider / 零模型；
     · 不重新发明 Diary 身份：entry.id 由 domain 持有，本层只透传 idempotencyKey。

   ── double authority（§26/§27）──────────────────────────────────────
     本 adapter **刻意不实现**"authorized execution envelope bypass"：
     生产 domain 写入入口（generateDiaryEntry）与 legacy scheduler 共用同一条
     Diary Authority 链（§25），因此不存在"只能由 orchestrator 打开"的第二写面。
     编排层预检查与 domain 内裁决调用的是**同一个** authority、**同一份** facts；
     两次都是 fail-closed，第二次不可能放宽第一次的结论。
     详见 docs/P25-3B-DIARY-CAPABILITY.md「Double-authority analysis」。
   ==================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(null, require('./voice-message-core.js'),
      require('./agent-capability-registry.js'), require('./agent-orchestration-core.js'));
  } else {
    root.IBAgentOrchestrationDiary = factory(root, root.IBVoiceMessage,
      root.IBAgentCapabilityRegistry, root.IBAgentOrchestrationCore);
  }
})(typeof self !== 'undefined' ? self : this, function (root, VOICE, REGISTRY, CORE) {
  'use strict';

  var DOMAIN = 'diary';
  function isObject(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
  function isPlainObject(v) {
    if (!isObject(v)) return false;
    var proto = Object.getPrototypeOf(v);
    return proto === Object.prototype || proto === null;
  }
  function str(v) { return v == null ? '' : String(v); }

  /* ── Capability Descriptor（只声明；实现永远在 domain 侧，§23）────────
     字段遵守 P25-3A frozen descriptor：id / domain / kind / description /
     sideEffect / authorityType / binding / availability（不改 registry contract）。 */
  var CAPABILITIES = Object.freeze([
    { id: 'diary.write', domain: DOMAIN, kind: 'write',
      description: '请求角色生成并写入一篇 Diary entry（经 Diary Authority 裁决）',
      sideEffect: 'local', authorityType: 'domain', binding: 'diary.write' }
  ]);
  function registerDiaryCapabilities(registry) {
    if (!registry || typeof registry.register !== 'function') return { ok: false, errors: ['registry-missing'] };
    var errors = [];
    CAPABILITIES.forEach(function (c) {
      var r = registry.register(Object.assign({}, c));
      if (!r.ok) errors.push(c.id + ':' + r.errors.join('|'));
    });
    return { ok: errors.length === 0, errors: errors };
  }

  /* ── Availability（§30）─────────────────────────────────────────────
     availability 只回答**基础设施**是否可用：Diary 模块是否加载、canonical writer 是否存在。
     它**不是** permission：enabled=false / 未知角色一律交给 Diary Authority 裁决（DENY），
     不能伪装成 "capability unavailable"（否则权限问题会被伪装成技术故障）。 */
  function describeDiaryAvailability(input) {
    var env = isPlainObject(input) ? input : {};
    var moduleLoaded = env.diaryModuleLoaded !== false;
    var writerAvailable = env.writerAvailable !== false;
    if (!moduleLoaded || !writerAvailable) return 'unavailable';
    return env.degraded === true ? 'degraded' : 'available';
  }

  /* ── Adapter：authority route + executor 绑定（全部注入，§24）──────────
     deps:
       authority : { runDiaryWrite(candidate, facts, executor), buildDiaryCandidate?, sourceOfTrigger? }
                   ← 真实 assets/js/diary-authority.js
       domain    : { writeDiary(envelope, options) } ← 真实 domain 入口
                   （生产 = generateDiaryEntry(actorId, opts)；它自己再经同一 authority）
       reader    : async (entryId) → canonical row|null  ← verifier 用（真实读） */
  function createDiaryOrchestrationAdapter(deps) {
    var d = isPlainObject(deps) ? deps : {};
    var captured = Object.create(null);      /* stepId → authorized envelope（runtime-only） */
    var executorCalls = Object.create(null);
    function descriptorOf(capabilityId) {
      for (var i = 0; i < CAPABILITIES.length; i++) if (CAPABILITIES[i].id === capabilityId) return CAPABILITIES[i];
      return null;
    }
    function candidateOf(input) {
      var raw = isPlainObject(input.candidate) ? input.candidate : {
        actorId: str(input.actorId),
        source: str(input.source),
        trigger: str(input.trigger),
        triggerRef: str(input.triggerRef),
        diaryType: str(input.diaryType) || 'daily',
        contextRef: str(input.contextRef)
      };
      if (d.authority && typeof d.authority.buildDiaryCandidate === 'function' && !isPlainObject(input.candidate)) {
        var built = d.authority.buildDiaryCandidate(raw);
        return built && built.ok ? built.candidate : raw;
      }
      return raw;
    }
    /* ① Authority route：只问既有权威，不自己判断（Plan != Permission）。 */
    async function invokeAuthority(descriptor, step) {
      var capId = str(descriptor && descriptor.id);
      var stepId = str(step && step.stepId);
      var input = isPlainObject(step && step.input) ? step.input : {};
      if (capId !== 'diary.write') return { decision: 'deny', reason: 'unknown-capability' };
      if (!d.authority || typeof d.authority.runDiaryWrite !== 'function') return { decision: 'deny', reason: 'authority-missing' };
      var candidate = candidateOf(input);
      delete captured[stepId];
      var facts = isPlainObject(input.facts) ? input.facts : {};
      /* capture executor：**只捕获"已被授权的意图"**，绝不落库（真正写入在 executor）。 */
      var run = await d.authority.runDiaryWrite(candidate, facts, function () {
        return Promise.resolve({ ok: true, entry: null });
      });
      var decision = str(run && run.decision) || 'deny';
      if (decision === 'allow') {
        captured[stepId] = {
          capabilityId: 'diary.write', authorityType: 'diary', authorized: true,
          candidateId: str((run && run.entry && run.entry.candidateId) || (candidate && candidate.candidateId)),
          actorId: str((candidate && candidate.actorId) || (run && run.actorId))
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
        if (capId !== 'diary.write') return { ok: false, errorCode: 'unknown-capability' };
        var envelope = captured[stepId];
        if (!envelope || envelope.authorized !== true) return { ok: false, errorCode: 'no-authorized-candidate' };
        var domain = isPlainObject(d.domain) ? d.domain : {};
        if (typeof domain.writeDiary !== 'function') return { ok: false, errorCode: 'executor-missing' };
        var input = isPlainObject(execution && execution.input) ? execution.input : {};
        var res = await domain.writeDiary({
          actorId: envelope.actorId, candidateId: envelope.candidateId,
          idempotencyKey: str(execution && execution.idempotencyKey),
          trigger: str(input.trigger), triggerRef: str(input.triggerRef),
          diaryType: str(input.diaryType), reason: str(input.reason)
        });
        var ok = !!(res && res.ok === true);
        var entry = (res && isObject(res.entry)) ? res.entry : null;
        return {
          ok: ok,
          output: { entryId: str(entry && entry.id), actorId: str(envelope.actorId), candidateId: str(envelope.candidateId) },
          errorCode: ok ? '' : (str(res && res.error) || 'diary-write-failed').slice(0, 200)
        };
      };
    }
    /* ③ 幂等键透传（§19）：domain 持有身份，本层不重新发明。 */
    function idempotencyKeyFor(descriptor, step) {
      var input = isPlainObject(step && step.input) ? step.input : {};
      if (str(input.idempotencyKey)) return str(input.idempotencyKey);
      var c = candidateOf(input);
      return str(c && c.candidateId);
    }
    /* ④ Verifier（§28/§29）：只验证 canonical 行是否存在，不补写、不 retry。
       注意：P25-3A 的 verifyStepResult 是**同步** contract，而 canonical 读（IndexedDB）
       是异步的 —— 因此本 adapter 暴露 async verify()，由调用方 await；
       **不修改 Foundation contract**。 */
    async function verify(executionResult) {
      var r = isPlainObject(executionResult) ? executionResult : {};
      if (!d.authority || typeof d.authority.verifyDiaryWrite !== 'function') return { ok: false, verified: false, errorCode: 'authority-missing' };
      var out = isPlainObject(r.output) ? r.output : {};
      var result = {
        status: str(r.status) || 'completed',
        ok: r.ok === true,
        actorId: str(out.actorId),
        entryId: str(out.entryId),
        entry: str(out.entryId) ? { id: str(out.entryId), characterId: str(out.actorId) } : null
      };
      return d.authority.verifyDiaryWrite(result, typeof d.reader === 'function' ? d.reader : null);
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
    DIARY_CAPABILITIES: CAPABILITIES,
    registerDiaryCapabilities: registerDiaryCapabilities,
    describeDiaryAvailability: describeDiaryAvailability,
    createDiaryOrchestrationAdapter: createDiaryOrchestrationAdapter
  };
});
