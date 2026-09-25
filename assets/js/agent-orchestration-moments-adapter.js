/* ====================================================================
   IB Agent Orchestration · Moments Reference Adapter — P25-3A
   --------------------------------------------------------------------
   P25-3A **唯一**允许做的 reference adapter（不迁移生产）：
   把 Moments 的既有权限边界登记成 capability，并声明它们的 authority route：

     moment.post              → authorityType 'autonomy' → P25-2 runMomentAutonomy
     moment.like              → authorityType 'mutation' → P25-2.5 runMomentMutation
     moment.comment           → 'mutation'
     moment.reply             → 'mutation'
     moment.comment.delete    → 'mutation'
     moment.delete            → 'mutation'

   ── 它不做什么 ───────────────────────────────────────────────────────
     · 不复制 Moments authority（没有第二份 decision 逻辑）；authority / executor / writer
       全部经 deps 注入，指向**既有**实现；
     · 不直接写库：本文件零 dbPut / createMoment / DOM / provider / 模型。
   ==================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(null, require('./voice-message-core.js'),
      require('./agent-capability-registry.js'), require('./agent-orchestration-core.js'));
  } else {
    root.IBAgentOrchestrationMoments = factory(root, root.IBVoiceMessage,
      root.IBAgentCapabilityRegistry, root.IBAgentOrchestrationCore);
  }
})(typeof self !== 'undefined' ? self : this, function (root, VOICE, REGISTRY, CORE) {
  'use strict';

  var DOMAIN = 'moment';
  function isObject(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
  function isPlainObject(v) {
    if (!isObject(v)) return false;
    var proto = Object.getPrototypeOf(v);
    return proto === Object.prototype || proto === null;
  }
  function str(v) { return v == null ? '' : String(v); }

  /* ── Capability Descriptors（只声明；实现永远在 domain 侧）──────────── */
  var CAPABILITIES = Object.freeze([
    { id: 'moment.post', domain: DOMAIN, kind: 'write', description: '让角色发布一条动态（经 Moments Autonomy 裁决）',
      sideEffect: 'local', authorityType: 'autonomy', binding: 'moments.autonomy.pipeline' },
    { id: 'moment.like', domain: DOMAIN, kind: 'write', description: '点赞 / 取消点赞一条既有动态',
      sideEffect: 'local', authorityType: 'mutation', binding: 'moments.mutation.like' },
    { id: 'moment.comment', domain: DOMAIN, kind: 'write', description: '在既有动态下发表评论',
      sideEffect: 'local', authorityType: 'mutation', binding: 'moments.mutation.comment' },
    { id: 'moment.reply', domain: DOMAIN, kind: 'write', description: '回复既有评论（父评论必须存在）',
      sideEffect: 'local', authorityType: 'mutation', binding: 'moments.mutation.reply' },
    { id: 'moment.comment.delete', domain: DOMAIN, kind: 'action', description: '删除一条评论（楼主 / 评论作者）',
      sideEffect: 'local', authorityType: 'mutation', binding: 'moments.mutation.comment.delete' },
    { id: 'moment.delete', domain: DOMAIN, kind: 'action', description: '删除一条动态（作者 / 用户所有者）',
      sideEffect: 'local', authorityType: 'mutation', binding: 'moments.mutation.moment.delete' }
  ]);
  function registerMomentsCapabilities(registry) {
    if (!registry || typeof registry.register !== 'function') return { ok: false, errors: ['registry-missing'] };
    var errors = [];
    CAPABILITIES.forEach(function (c) {
      var r = registry.register(Object.assign({}, c));
      if (!r.ok) errors.push(c.id + ':' + r.errors.join('|'));
    });
    return { ok: errors.length === 0, errors: errors };
  }

  /* mutation 类型映射（与 P25-2.5 的闭集一一对应；本层不新增词） */
  var MUTATION_OF_CAPABILITY = Object.freeze({
    'moment.like': 'like',
    'moment.comment': 'comment.create',
    'moment.reply': 'reply.create',
    'moment.comment.delete': 'comment.delete',
    'moment.delete': 'moment.delete'
  });

  /* ── Adapter：authority route + executor 绑定（全部注入）───────────────
     deps:
       autonomy : { runMomentAutonomy(candidate, deps) }        ← 真实 P25-2 管线
       mutation : { runMomentMutation(mutation, facts, exec) }  ← 真实 P25-2.5 权威
       domain   : { createMoment, likeMoment, addMomentComment, deleteMomentComment, deleteMoment }
       autonomyDepsFor(step) → { now, prefs, writeMoment, … }   ← 由调用方提供真实依赖 */
  function createMomentsOrchestrationAdapter(deps) {
    var d = isPlainObject(deps) ? deps : {};
    var captured = Object.create(null);   /* stepId → {payload, options} / mutation */
    var executorCalls = Object.create(null);
    function descriptorOf(capabilityId) {
      for (var i = 0; i < CAPABILITIES.length; i++) if (CAPABILITIES[i].id === capabilityId) return CAPABILITIES[i];
      return null;
    }
    /* ① Authority route：只问既有权威，不自己判断。 */
    async function invokeAuthority(descriptor, step) {
      var capId = str(descriptor && descriptor.id);
      var stepId = str(step && step.stepId);
      var input = isPlainObject(step && step.input) ? step.input : {};
      if (capId === 'moment.post') {
        if (!d.autonomy || typeof d.autonomy.runMomentAutonomy !== 'function') return { decision: 'deny', reason: 'autonomy-missing' };
        captured[stepId] = null;
        var autonomyDeps = (typeof d.autonomyDepsFor === 'function') ? Object.assign({}, d.autonomyDepsFor(step)) : {};
        autonomyDeps.writeMoment = function (payload, options) {
          captured[stepId] = { payload: payload, options: options || {} };   /* 只捕获；真正写入在 executor */
          return Promise.resolve({ ok: true, moment: null });
        };
        var run = await d.autonomy.runMomentAutonomy(input.candidate, autonomyDeps);
        return { decision: str(run && run.decision) || 'deny', reason: str(run && run.reason) || 'unknown', run: run };
      }
      var mutationType = MUTATION_OF_CAPABILITY[capId];
      if (!mutationType) return { decision: 'deny', reason: 'unknown-capability' };
      if (!d.mutation || typeof d.mutation.runMomentMutation !== 'function') return { decision: 'deny', reason: 'mutation-authority-missing' };
      var mutation = {
        mutationType: mutationType,
        actorId: str(input.actorId), actorKind: str(input.actorKind) || 'role',
        source: str(input.source) || 'character',
        targetMomentId: str(input.targetMomentId), targetCommentId: str(input.targetCommentId)
      };
      captured[stepId] = mutation;
      var facts = isPlainObject(input.facts) ? input.facts : {};
      var runMut = await d.mutation.runMomentMutation(mutation, facts, function () { return Promise.resolve({ ok: true }); });
      return { decision: str(runMut && runMut.decision) || 'deny', reason: str(runMut && runMut.reason) || 'unknown', run: runMut };
    }
    /* ② Executor：只有 ALLOW 之后才会被编排层调用；此处只转交**既有** domain 入口。 */
    function resolveExecutor(descriptor) {
      var capId = str(descriptor && descriptor.id);
      return async function (execution) {
        var stepId = str(execution && execution.stepId);
        executorCalls[stepId] = (executorCalls[stepId] || 0) + 1;
        if (executorCalls[stepId] > 1) return { ok: false, errorCode: 'executor-called-twice' };
        var domain = isPlainObject(d.domain) ? d.domain : {};
        if (capId === 'moment.post') {
          var c = captured[stepId];
          if (!c) return { ok: false, errorCode: 'no-authorized-payload' };
          if (typeof domain.createMoment !== 'function') return { ok: false, errorCode: 'executor-missing' };
          var res = await domain.createMoment(c.payload, c.options);
          return { ok: !!(res && res.ok === true), output: { momentId: str(res && res.moment && res.moment.id) }, errorCode: res && res.ok === true ? '' : str(res && res.error) || 'failed' };
        }
        var mutation = captured[stepId];
        if (!mutation) return { ok: false, errorCode: 'no-authorized-mutation' };
        if (capId === 'moment.like') {
          if (typeof domain.likeMoment !== 'function') return { ok: false, errorCode: 'executor-missing' };
          var likeRes = await domain.likeMoment(mutation.targetMomentId, mutation.actorId);
          return { ok: !!(likeRes && likeRes.ok === true), output: { liked: !!(likeRes && likeRes.liked) }, errorCode: likeRes && likeRes.ok ? '' : str(likeRes && likeRes.error) || 'failed' };
        }
        if (capId === 'moment.comment' || capId === 'moment.reply') {
          if (typeof domain.addMomentComment !== 'function') return { ok: false, errorCode: 'executor-missing' };
          var addRes = await domain.addMomentComment(mutation.targetMomentId, {
            authorType: mutation.actorKind === 'user' ? 'user' : 'role', authorId: mutation.actorId,
            content: str(execution && execution.input && execution.input.content),
            replyTo: mutation.targetCommentId || ''
          });
          return { ok: !!(addRes && addRes.ok === true), output: { commentId: str(addRes && addRes.comment && addRes.comment.id) }, errorCode: addRes && addRes.ok ? '' : str(addRes && addRes.error) || 'failed' };
        }
        if (capId === 'moment.comment.delete') {
          if (typeof domain.deleteMomentComment !== 'function') return { ok: false, errorCode: 'executor-missing' };
          var delC = await domain.deleteMomentComment(mutation.targetMomentId, mutation.targetCommentId, mutation.actorKind === 'user' ? '' : mutation.actorId);
          return { ok: !!(delC && delC.ok === true), errorCode: delC && delC.ok ? '' : str(delC && delC.error) || 'failed' };
        }
        if (capId === 'moment.delete') {
          if (typeof domain.deleteMoment !== 'function') return { ok: false, errorCode: 'executor-missing' };
          var delM = await domain.deleteMoment(mutation.targetMomentId, mutation.actorKind === 'user' ? {} : { actorKind: 'role', actorId: mutation.actorId });
          return { ok: !!(delM && delM.ok === true), errorCode: delM && delM.ok ? '' : str(delM && delM.error) || 'failed' };
        }
        return { ok: false, errorCode: 'unknown-capability' };
      };
    }
    function idempotencyKeyFor(descriptor, step) {
      var capId = str(descriptor && descriptor.id);
      var input = isPlainObject(step && step.input) ? step.input : {};
      if (capId === 'moment.post') {
        var c = input.candidate;
        return str(c && c.candidateId) || str(input.requestId);
      }
      return [capId, str(input.actorId), str(input.targetMomentId), str(input.targetCommentId), str(input.idempotencyKey || '')].join('|');
    }
    return {
      capabilities: CAPABILITIES,
      descriptorOf: descriptorOf,
      invokeAuthority: invokeAuthority,
      resolveExecutor: resolveExecutor,
      idempotencyKeyFor: idempotencyKeyFor,
      captured: captured,
      executorCalls: executorCalls
    };
  }

  return {
    MOMENTS_CAPABILITIES: CAPABILITIES,
    MUTATION_OF_CAPABILITY: MUTATION_OF_CAPABILITY,
    registerMomentsCapabilities: registerMomentsCapabilities,
    createMomentsOrchestrationAdapter: createMomentsOrchestrationAdapter
  };
});
