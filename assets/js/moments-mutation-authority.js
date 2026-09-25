/* ====================================================================
   IB Moments Mutation Authority — P25-2.5 · Mutation Authority Closure
   --------------------------------------------------------------------
   创建与修改是两种权限，本模块只回答后者：

     「某个主体想修改**已存在**的 Moment（点赞 / 评论 / 回复 / 删除），是否允许？」

   它**不是**：
     · Autonomy Core（那是**创建**权限，本模块绝不接进 runMomentAutonomy）；
     · executor（executor 只执行：本模块产出 decision，写入发生在 caller 的 executor 里）；
     · 第二套 scheduler / 第二套 store（零存储、零队列、零定时器、零模型、零 DOM）。

   ── 冻结的不变量（MOMENTS_MUTATION_AUTHORITY_INVARIANT）──────────────
     任何对已有 Moment 的修改都必须先经过本模块的 decision；
     禁止 UI event → dbPut 的直达边，禁止 companion / AI 直接写（它们只能请求 mutation）。
     找不到合法 authority ⇒ fail closed（DENY），绝不"默认放行"。

   ── 词表（闭集；不接受自然语言）────────────────────────────────────
     mutationType: like | unlike | comment.create | comment.delete | moment.delete | reply.create
     source      : user | role_ai | companion | system
     decision    : allow | deny        （无 DEFER：mutation 是即时幂等动作，
                                         "稍后"没有产品语义 —— 见文档 §Authority Decision）
   ==================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(null, require('./voice-message-core.js'));
  } else {
    root.IBMomentsMutationAuthority = factory(root, root.IBVoiceMessage);
  }
})(typeof self !== 'undefined' ? self : this, function (root, VOICE) {
  'use strict';

  var MUTATION_TYPES = Object.freeze(['like', 'unlike', 'comment.create', 'comment.delete', 'moment.delete', 'reply.create']);
  var MUTATION_SOURCES = Object.freeze(['user', 'role_ai', 'companion', 'system']);
  var ACTOR_KINDS = Object.freeze(['user', 'role']);
  var MUTATION_DECISIONS = Object.freeze({ ALLOW: 'allow', DENY: 'deny' });

  /* 决策原因闭集（诊断/审计用；绝不回显正文、凭据或自然语言理由）。 */
  var MUTATION_REASONS = Object.freeze([
    'allowed',
    'invalid-action',
    'secret-in-action',
    'unknown-actor',
    'unknown-moment',
    'unknown-comment',
    'not-visible',
    'empty-content',
    'duplicate-comment',
    'self-like',
    'ai-unlike-not-permitted',
    'not-comment-author',
    'not-moment-author',
    'not-owner',
    'no-executor',
    'authority-missing'
  ]);
  /* 契约错误词表（buildMomentMutation 的 errors）。 */
  var MUTATION_ERRORS = Object.freeze([
    'not-an-object', 'missing-mutation-type', 'bad-mutation-type', 'missing-actor-id', 'bad-actor-id',
    'bad-actor-kind', 'bad-source', 'missing-target-moment', 'bad-target-moment',
    'missing-target-comment', 'bad-target-comment', 'bad-context', 'secret-in-action'
  ]);

  var MAX_ID_LEN = 200;
  var MAX_CONTENT_LEN = 600;   /* 与 addMomentComment 的 slice(0,600) 同源 */
  var CONTROL_PATTERN = /[\u0000-\u001F\u007F]/;

  function isObject(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
  function isPlainObject(v) {
    if (!isObject(v)) return false;
    var proto = Object.getPrototypeOf(v);
    return proto === Object.prototype || proto === null;
  }
  function str(v) { return v == null ? '' : String(v); }
  function hasSecret(v) {
    try { if (VOICE && typeof VOICE.findSecret === 'function') return !!VOICE.findSecret(v); } catch (e) { /* 探测失败不阻断 */ }
    return false;
  }
  function usableId(v) {
    var s = str(v);
    if (!s || s !== s.trim() || s.length > MAX_ID_LEN) return false;
    return !CONTROL_PATTERN.test(s);
  }
  function deny(reason) { return { decision: MUTATION_DECISIONS.DENY, reason: reason }; }
  function allow(reason) { return { decision: MUTATION_DECISIONS.ALLOW, reason: reason || 'allowed' }; }

  /* ── Mutation Contract ────────────────────────────────────────────────
     { mutationType, actorId, actorKind, source, targetMomentId, targetCommentId?, context? }
     actorId 必须是 canonical identity（apiConfigs.id 或 user principal）——
     displayName / nickname / 临时 id 一律不接受。 */
  function buildMomentMutation(input) {
    if (!isPlainObject(input)) return { ok: false, errors: ['not-an-object'] };
    var errors = [];
    var type = str(input.mutationType);
    if (!type) errors.push('missing-mutation-type');
    else if (MUTATION_TYPES.indexOf(type) < 0) errors.push('bad-mutation-type');
    var actorId = str(input.actorId);
    if (!actorId) errors.push('missing-actor-id');
    else if (!usableId(actorId)) errors.push('bad-actor-id');
    var actorKind = str(input.actorKind);
    if (ACTOR_KINDS.indexOf(actorKind) < 0) errors.push('bad-actor-kind');
    var source = str(input.source);
    if (MUTATION_SOURCES.indexOf(source) < 0) errors.push('bad-source');
    var targetMomentId = str(input.targetMomentId);
    if (!targetMomentId) errors.push('missing-target-moment');
    else if (!usableId(targetMomentId)) errors.push('bad-target-moment');
    var targetCommentId = str(input.targetCommentId);
    if (targetCommentId && !usableId(targetCommentId)) errors.push('bad-target-comment');
    if (type === 'comment.delete' && !targetCommentId) errors.push('missing-target-comment');
    if ((type === 'comment.create' || type === 'reply.create')) {
      var content = isPlainObject(input.context) ? str(input.context.content).trim() : '';
      if (!content) errors.push('bad-context');
      else if (content.length > MAX_CONTENT_LEN) errors.push('bad-context');
    }
    if (input.context !== undefined && input.context !== null && !isPlainObject(input.context)) errors.push('bad-context');
    if (hasSecret({ mutationType: type, actorId: actorId, targetMomentId: targetMomentId, targetCommentId: targetCommentId, context: input.context })) errors.push('secret-in-action');
    errors = errors.filter(function (e, i) { return errors.indexOf(e) === i; });
    if (errors.length) return { ok: false, errors: errors };
    return {
      ok: true,
      errors: [],
      mutation: {
        mutationType: type,
        actorId: actorId,
        actorKind: actorKind,
        source: source,
        targetMomentId: targetMomentId,
        targetCommentId: targetCommentId,
        context: isPlainObject(input.context) ? Object.assign({}, input.context) : null
      }
    };
  }

  /* ── Authority Decision（纯函数；facts 由 caller 从真实状态读出）────────
     facts = {
       momentExists, momentAuthorKind, momentAuthorId, actorIsMomentAuthor,
       commentExists, commentAuthorId, actorIsCommentAuthor,
       actorCanSeeMoment, duplicateComment
     }
     逐条冻结的是**现有产品行为**（审计见 docs/P25-2.5-MOMENTS-MUTATION-AUTHORITY.md）：
       · like        ：作者不能给自己点赞（用户与角色都适用）
       · unlike      ：只有用户主体可取消；AI 点赞不撤销（角色 unlike ⇒ DENY，caller 保持 no-op）
       · comment.create / reply.create：动态必须存在、内容非空、角色主体必须对该动态可见、同评论者同内容去重
       · comment.delete：用户主体可删自己评论，或删**自己发布的动态**下的任何评论；
                         角色主体只能删自己发布动态下**别人**的评论（楼主删评）
       · moment.delete ：用户主体（应用所有者，UI 入口）或动态作者本人 */
  function decideMomentMutation(mutation, facts) {
    var m = isObject(mutation) ? mutation : null;
    var f = isObject(facts) ? facts : {};
    if (!m || MUTATION_TYPES.indexOf(str(m.mutationType)) < 0) return deny('invalid-action');
    /* actor 必须落在 canonical identity 域里（apiConfigs.id / user principal）——
       displayName / nickname / 临时 id 不是身份，facts.actorKnown === false 即拒绝。 */
    if (f.actorKnown === false) return deny('unknown-actor');
    if (!f.momentExists) return deny('unknown-moment');
    var type = m.mutationType;
    if (type === 'like') {
      if (f.actorIsMomentAuthor === true) return deny('self-like');
      return allow();
    }
    if (type === 'unlike') {
      if (m.actorKind !== 'user') return deny('ai-unlike-not-permitted');
      return allow();
    }
    if (type === 'comment.create' || type === 'reply.create') {
      /* reply.create 的 targetCommentId 可选：顶层回复（replyTo 为空）与"被回复评论尚未落库"
         都是既有契约允许的形态。只有**显式给了** targetCommentId 时才要求它存在。 */
      if (type === 'reply.create' && str(m.targetCommentId) && f.commentExists !== true) return deny('unknown-comment');
      if (f.actorCanSeeMoment !== true) return deny('not-visible');
      if (f.duplicateComment === true) return deny('duplicate-comment');
      return allow();
    }
    if (type === 'comment.delete') {
      if (f.commentExists !== true) return deny('unknown-comment');
      if (m.actorKind === 'user') {
        if (f.actorIsMomentAuthor === true || f.actorIsCommentAuthor === true) return allow();
        return deny('not-comment-author');
      }
      /* 角色：只能作为**楼主**删别人的评论（与既有 _momentsAuthorCanDelete 逐字一致） */
      if (f.actorIsMomentAuthor === true && f.actorIsCommentAuthor !== true) return allow();
      return deny('not-comment-author');
    }
    if (type === 'moment.delete') {
      if (m.actorKind === 'user') return allow();
      if (f.actorIsMomentAuthor === true) return allow();
      return deny('not-owner');
    }
    return deny('invalid-action');
  }

  /* ── 唯一入口：契约 → 决策 → （仅 ALLOW）执行 ───────────────────────── */
  async function runMomentMutation(mutationInput, facts, executor) {
    var built = isPlainObject(mutationInput) && mutationInput.mutationType && mutationInput.actorId !== undefined
      ? { ok: true, mutation: mutationInput, errors: [] }
      : buildMomentMutation(mutationInput);
    if (!built.ok) return { ok: false, decision: MUTATION_DECISIONS.DENY, reason: 'invalid-action', errors: built.errors, executed: false, result: null, error: '' };
    var mutation = built.mutation;
    if (typeof executor !== 'function') return { ok: false, decision: MUTATION_DECISIONS.DENY, reason: 'no-executor', errors: [], executed: false, result: null, error: '' };
    var verdict = decideMomentMutation(mutation, facts);
    if (verdict.decision !== MUTATION_DECISIONS.ALLOW) {
      return { ok: false, decision: verdict.decision, reason: verdict.reason, errors: [], executed: false, result: null, error: '' };
    }
    var result = null;
    try { result = await executor(mutation); }
    catch (error) {
      return {
        ok: false, decision: MUTATION_DECISIONS.ALLOW, reason: verdict.reason, errors: [], executed: true, result: null,
        error: String((error && error.message) || error).slice(0, 200)
      };
    }
    var execOk = !(isObject(result) && result.ok === false);
    return {
      ok: execOk, decision: MUTATION_DECISIONS.ALLOW, reason: verdict.reason, errors: [], executed: true,
      result: result, error: execOk ? '' : str(result && result.error).slice(0, 200)
    };
  }

  var CONTRACT = Object.freeze({
    version: 'moment-mutation/v1',
    mutationTypes: MUTATION_TYPES,
    sources: MUTATION_SOURCES,
    actorKinds: ACTOR_KINDS,
    decisions: MUTATION_DECISIONS,
    reasons: MUTATION_REASONS,
    errors: MUTATION_ERRORS,
    limits: Object.freeze({ maxIdLen: MAX_ID_LEN, maxContentLen: MAX_CONTENT_LEN })
  });

  return {
    MOMENTS_MUTATION_CONTRACT: CONTRACT,
    MUTATION_TYPES: MUTATION_TYPES,
    MUTATION_SOURCES: MUTATION_SOURCES,
    ACTOR_KINDS: ACTOR_KINDS,
    MUTATION_DECISIONS: MUTATION_DECISIONS,
    MUTATION_REASONS: MUTATION_REASONS,
    MUTATION_ERRORS: MUTATION_ERRORS,
    buildMomentMutation: buildMomentMutation,
    decideMomentMutation: decideMomentMutation,
    runMomentMutation: runMomentMutation
  };
});
