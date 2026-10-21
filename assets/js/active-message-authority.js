/* ====================================================================
   IB Active Message Authority — P25-3C · Active Message Capability Integration
   --------------------------------------------------------------------
   回答一个问题：**某个主体现在是否可以把一条主动消息发给某个目标的会话？**

   合法链（唯一）：

     Trigger → Active Message Candidate → Authority → ALLOW → Executor
             → Canonical Chat Write → Verify

   冻结：
     · PLAN != PERMISSION · MODEL OUTPUT != PERMISSION · SCHEDULER TRIGGER != PERMISSION
     · CAPABILITY AVAILABILITY != PERMISSION
     · 模型只产正文（content / suggestion）；发权限只属于本模块。
     · 纯：零 DOM / 零 IndexedDB / 零 fetch / 零 provider / 零模型 / 零 Memory /
       零 Middle Brain / 零通知 / 零 TTS / 零 scheduler / 零定时器。
       executor 与 reader 全部注入。

   与 Diary Authority（P25-3B）的差别（**刻意不复制**）：
     Active Message 直接影响用户体验，因此 facts 里多了 quiet-hours / cooldown /
       duplicate 三项；它们**不是**本模块发明的策略 —— 判定规则仍然只有一份，
       由 domain 既有的实现算出（BG-AI 休眠窗口 / 12 小时互动冷却 / 主动消息相似度 0.82），
       本模块只做"要不要放行"的裁决。
   ==================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(null, require('./chat-core.js'), require('./voice-message-core.js'));
  } else {
    root.IBActiveMessageAuthority = factory(root, root.IBChatCore, root.IBVoiceMessage);
  }
})(typeof self !== 'undefined' ? self : this, function (root, CHAT_CORE, VOICE) {
  'use strict';

  /* source 闭集：由 Phase 0 审计的真实入口推出（见 docs/P25-3C-ACTIVE-MESSAGE-CAPABILITY.md）。
       schedule  ← 设定计划的调度到期
       plan      ← AI 主动计划（含 companion 同步计划的本地执行）
       character ← 角色自主（预留：当前与 schedule/plan 同源）
       user      ← 用户显式请求（“立即发送”）
       presence  ← 用户可选的 Presence 归来迎接
       companion ← 后台 companion 运行时的投递（**投递镜像**，不是新的发送决策） */
  var ACTIVE_MESSAGE_SOURCES = Object.freeze(['schedule', 'plan', 'character', 'user', 'presence', 'companion']);
  var ACTIVE_MESSAGE_DECISIONS = Object.freeze({ ALLOW: 'allow', DENY: 'deny' });
  /* 无 DEFER：“稍后”语义已经由既有调度器承担（next_run_at / scheduledAt / 水位线），
     发送动作本身没有延迟语义 —— 不因为 Orchestrator 支持 deferred 就机械加入。 */
  var ACTIVE_MESSAGE_REASONS = Object.freeze([
    'allowed',
    'invalid-candidate',
    'unknown-actor',
    'unknown-target',
    'cancelled',
    'disabled',
    'quiet-hours',
    'cooldown',
    'duplicate',
    'no-executor',
    'secret-in-candidate'
  ]);
  var ACTIVE_MESSAGE_ERRORS = Object.freeze([
    'not-an-object', 'missing-actor-id', 'bad-actor-id', 'missing-target-id', 'bad-target-id',
    'bad-source', 'missing-trigger', 'bad-trigger', 'bad-trigger-ref', 'bad-message-ref',
    'secret-in-candidate'
  ]);
  var MAX_ID_LEN = 200;
  var MAX_TRIGGER_LEN = 40;
  var CONTROL_PATTERN = /[\u0000-\u001F\u007F]/;

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
  function stableToken(seed) {
    try { if (CHAT_CORE && typeof CHAT_CORE.stableToken === 'function') return str(CHAT_CORE.stableToken(seed)); } catch (e) { /* fall through */ }
    return '';
  }
  function usableId(v) {
    var s = str(v);
    if (!s || s !== s.trim() || s.length > MAX_ID_LEN) return false;
    return !CONTROL_PATTERN.test(s);
  }

  /* ── Active Message Candidate（纯数据；身份确定性，不改 chatMessages schema）──
     candidateId **不是** chat message id —— 消息 id 仍由 domain 持有
     （既有实现是 `active_msg_<setting|plan>_<秒级时间>`），本阶段不重新发明它。
     candidateId 只用于 authority / 审计 / 幂等键透传。 */
  function buildActiveMessageCandidate(input) {
    if (!isPlainObject(input)) return { ok: false, errors: ['not-an-object'] };
    var errors = [];
    var actorId = str(input.actorId);
    if (!actorId) errors.push('missing-actor-id');
    else if (!usableId(actorId)) errors.push('bad-actor-id');
    var targetId = str(input.targetId);
    if (!targetId) errors.push('missing-target-id');
    else if (!usableId(targetId)) errors.push('bad-target-id');
    var source = str(input.source);
    if (ACTIVE_MESSAGE_SOURCES.indexOf(source) < 0) errors.push('bad-source');
    var trigger = str(input.trigger);
    if (!trigger) errors.push('missing-trigger');
    else if (trigger.length > MAX_TRIGGER_LEN || CONTROL_PATTERN.test(trigger)) errors.push('bad-trigger');
    var triggerRef = str(input.triggerRef);
    if (triggerRef && !usableId(triggerRef)) errors.push('bad-trigger-ref');
    var messageRef = str(input.messageRef);
    if (messageRef && !usableId(messageRef)) errors.push('bad-message-ref');
    /* §26：candidate 内任何位置都不允许出现凭据（整对象扫描，与其它模块同一探针）。 */
    if (hasSecret({ actorId: actorId, targetId: targetId, trigger: trigger, triggerRef: triggerRef, messageRef: messageRef, contentRef: input.contentRef, contextRef: input.contextRef })) {
      errors.push('secret-in-candidate');
    }
    errors = dedupe(errors);
    if (errors.length) return { ok: false, errors: errors };
    var token = stableToken([actorId, targetId, source, trigger, triggerRef].join('|'));
    if (!token) return { ok: false, errors: ['bad-trigger-ref'] };
    return {
      ok: true, errors: [],
      candidate: {
        candidateId: 'amc_' + token,
        actorId: actorId,
        targetId: targetId,
        source: source,
        trigger: trigger,
        triggerRef: triggerRef,
        messageRef: messageRef,
        contextRef: str(input.contextRef)
      }
    };
  }

  /* ── Decision（纯函数；facts 由 caller 从真实状态读出）─────────────────
     facts = { actorKnown, targetKnown, cancelled, enabled, quietHours, cooldown, duplicate }
     判定顺序（§11，逐条 fail closed）：
       invalid-candidate → unknown-actor → unknown-target → cancelled
       → disabled → quiet-hours → cooldown → duplicate → allow
     缺任何关键事实 ⇒ DENY；绝不依赖任何 default-allow。 */
  function decideActiveMessageSend(candidate, facts) {
    var c = isObject(candidate) ? candidate : null;
    var f = isObject(facts) ? facts : {};
    if (!c || !str(c.candidateId) || !str(c.actorId) || !str(c.targetId)
      || ACTIVE_MESSAGE_SOURCES.indexOf(str(c.source)) < 0) {
      return { decision: ACTIVE_MESSAGE_DECISIONS.DENY, reason: 'invalid-candidate' };
    }
    if (f.actorKnown !== true) return { decision: ACTIVE_MESSAGE_DECISIONS.DENY, reason: 'unknown-actor' };
    if (f.targetKnown !== true) return { decision: ACTIVE_MESSAGE_DECISIONS.DENY, reason: 'unknown-target' };
    if (f.cancelled === true) return { decision: ACTIVE_MESSAGE_DECISIONS.DENY, reason: 'cancelled' };
    if (f.enabled !== true) return { decision: ACTIVE_MESSAGE_DECISIONS.DENY, reason: 'disabled' };
    if (f.quietHours === true) return { decision: ACTIVE_MESSAGE_DECISIONS.DENY, reason: 'quiet-hours' };
    if (f.cooldown === true) return { decision: ACTIVE_MESSAGE_DECISIONS.DENY, reason: 'cooldown' };
    if (f.duplicate === true) return { decision: ACTIVE_MESSAGE_DECISIONS.DENY, reason: 'duplicate' };
    return { decision: ACTIVE_MESSAGE_DECISIONS.ALLOW, reason: 'allowed' };
  }

  /* ── 唯一入口：candidate → decision →（仅 ALLOW）执行 ───────────────────
     executor 契约（由 domain 提供，authority 不认识 store）：
       async (candidate) → { ok:boolean, message?:<canonical chat row>, error?:string }
     返回值规范化为 { ok, decision, reason, errors, executed, actorId, targetId, message, error }。 */
  async function runActiveMessageSend(candidate, facts, executor) {
    var built = (isPlainObject(candidate) && candidate.candidateId !== undefined)
      ? { ok: true, candidate: candidate, errors: [] }
      : buildActiveMessageCandidate(candidate);
    if (!built.ok) {
      return { ok: false, decision: ACTIVE_MESSAGE_DECISIONS.DENY, reason: 'invalid-candidate', errors: built.errors, executed: false, actorId: '', targetId: '', message: null, error: '' };
    }
    var actorId = str(built.candidate && built.candidate.actorId);
    var targetId = str(built.candidate && built.candidate.targetId);
    if (typeof executor !== 'function') {
      return { ok: false, decision: ACTIVE_MESSAGE_DECISIONS.DENY, reason: 'no-executor', errors: [], executed: false, actorId: actorId, targetId: targetId, message: null, error: '' };
    }
    var verdict = decideActiveMessageSend(built.candidate, facts);
    if (verdict.decision !== ACTIVE_MESSAGE_DECISIONS.ALLOW) {
      return { ok: false, decision: verdict.decision, reason: verdict.reason, errors: [], executed: false, actorId: actorId, targetId: targetId, message: null, error: '' };
    }
    var outcome = null;
    try { outcome = await executor(built.candidate); }
    catch (error) {
      /* executor 失败 = ALLOW + 执行失败（**不是** DENY，§16） */
      return { ok: false, decision: ACTIVE_MESSAGE_DECISIONS.ALLOW, reason: verdict.reason, errors: [], executed: true, actorId: actorId, targetId: targetId, message: null, error: str((error && error.message) || error).slice(0, 200) };
    }
    if (!isObject(outcome)) {
      return { ok: false, decision: ACTIVE_MESSAGE_DECISIONS.ALLOW, reason: verdict.reason, errors: [], executed: true, actorId: actorId, targetId: targetId, message: null, error: 'executor-invalid-result' };
    }
    if (outcome.ok === false) {
      return { ok: false, decision: ACTIVE_MESSAGE_DECISIONS.ALLOW, reason: verdict.reason, errors: [], executed: true, actorId: actorId, targetId: targetId, message: null, error: (str(outcome.error) || 'executor-failed').slice(0, 200) };
    }
    return {
      ok: true, decision: ACTIVE_MESSAGE_DECISIONS.ALLOW, reason: verdict.reason, errors: [], executed: true,
      actorId: actorId, targetId: targetId, message: isObject(outcome.message) ? outcome.message : null, error: ''
    };
  }

  /* ── Verifier（§19：只验证 canonical message 存在，不补发、不 retry、不改状态）──
     reader(messageId) → row|null（注入；生产传真实 canonical 读）。 */
  async function verifyActiveMessageSend(result, reader) {
    var r = isObject(result) ? result : {};
    if (typeof reader !== 'function') return { ok: false, verified: false, errorCode: 'verifier-missing' };
    if (r.status !== undefined && r.status !== 'completed') return { ok: false, verified: false, errorCode: 'not-completed' };
    if (r.ok !== true) return { ok: false, verified: false, errorCode: 'not-completed' };
    var id = str(r.message && r.message.id) || str(r.messageId);
    if (!id) return { ok: false, verified: false, errorCode: 'missing-message-id' };
    var row = null;
    try { row = await reader(id); }
    catch (error) { return { ok: false, verified: false, errorCode: 'verify-read-failed' }; }
    if (!row) return { ok: false, verified: false, errorCode: 'canonical-message-missing' };
    /* 归属：canonical 行必须属于本次 candidate 的 actor（角色 id），且确实是主动消息。 */
    var expectActor = str(r.actorId) || str(r.message && r.message.friendId);
    if (expectActor && str(row.friendId) && str(row.friendId) !== expectActor) return { ok: false, verified: false, errorCode: 'identity-mismatch' };
    if (str(row.source) && str(row.source) !== 'active_message') return { ok: false, verified: false, errorCode: 'not-an-active-message' };
    return { ok: true, verified: true, errorCode: '', messageId: id };
  }

  return {
    ACTIVE_MESSAGE_SOURCES: ACTIVE_MESSAGE_SOURCES,
    ACTIVE_MESSAGE_DECISIONS: ACTIVE_MESSAGE_DECISIONS,
    ACTIVE_MESSAGE_REASONS: ACTIVE_MESSAGE_REASONS,
    ACTIVE_MESSAGE_ERRORS: ACTIVE_MESSAGE_ERRORS,
    buildActiveMessageCandidate: buildActiveMessageCandidate,
    decideActiveMessageSend: decideActiveMessageSend,
    runActiveMessageSend: runActiveMessageSend,
    verifyActiveMessageSend: verifyActiveMessageSend
  };
});
