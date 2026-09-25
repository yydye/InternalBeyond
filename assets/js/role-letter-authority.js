/* ====================================================================
   IB Role Letter Authority — P25-3D · Role Letter Capability Integration
   --------------------------------------------------------------------
   回答一个问题：**某个角色现在是否可以向某个 recipient 创建一封 Role Letter？**

   合法链（唯一）：

     Trigger → Role Letter Candidate → Authority → ALLOW → Executor
             → Canonical Role Letter Writer → Verify

   冻结：
     · PLAN != PERMISSION · MODEL OUTPUT != PERMISSION · SCHEDULER TRIGGER != PERMISSION
     · CAPABILITY AVAILABILITY != PERMISSION
     · 模型只产信件正文（content）；写信权限只属于本模块。
     · 纯：零 DOM / 零 IndexedDB / 零 fetch / 零 provider / 零模型 / 零 Memory /
       零 Middle Brain / 零通知 / 零 scheduler / 零定时器。executor 与 reader 全部注入。

   与 Active Message Authority（P25-3C）的差别（**刻意不复制**）：
     Role Letter 是"低频、异步、私密"的书信域，既有的"稍后"语义由 cadence / pair 冷却 /
     回复队列承担，因此这里**没有** quiet-hours（休眠是调度器的事，不是 letter 的权限），
     cooldown 直接复用既有的 pair 冷却（24–72h），duplicate 复用既有的"已回/已拒"守卫。
   ==================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(null, require('./chat-core.js'), require('./voice-message-core.js'));
  } else {
    root.IBRoleLetterAuthority = factory(root, root.IBChatCore, root.IBVoiceMessage);
  }
})(typeof self !== 'undefined' ? self : this, function (root, CHAT_CORE, VOICE) {
  'use strict';

  /* source 闭集：由 Phase 0 审计的真实入口推出（见 docs/P25-3D-ROLE-LETTER-CAPABILITY.md）。
       schedule  ← 每角色 cadence（_rlInitStep：每角色每天约 1 封 + pair 冷却 + 模型门控）
       character ← 角色读信后的自主回信（_rlReplyStep：延迟 1~6h，模型决定回不回）
     **没有** 'user' / 'manual'：仓库里不存在"用户直接写 Role Letter"的入口
     （USER_REQUESTED_LETTER / MANUAL_USER_LETTER = NOT PRESENT）；将来若新增，
     必须显式扩展这个闭集（在那之前一律 bad-source ⇒ DENY）。 */
  var ROLE_LETTER_SOURCES = Object.freeze(['schedule', 'character']);
  var ROLE_LETTER_KINDS = Object.freeze(['init', 'reply']);
  var ROLE_LETTER_DECISIONS = Object.freeze({ ALLOW: 'allow', DENY: 'deny' });
  /* 无 DEFER：低频/异步语义已经由既有 cadence、pair 冷却与回复队列承担 ——
     写信动作本身没有"稍后执行"的语义，不因为 Orchestrator 支持 deferred 就机械加入。 */
  var ROLE_LETTER_REASONS = Object.freeze([
    'allowed',
    'invalid-candidate',
    'unknown-actor',
    'unknown-recipient',
    'cancelled',
    'disabled',
    'cooldown',
    'duplicate',
    'no-executor',
    'secret-in-candidate'
  ]);
  var ROLE_LETTER_ERRORS = Object.freeze([
    'not-an-object', 'missing-actor-id', 'bad-actor-id', 'missing-recipient-id', 'bad-recipient-id',
    'self-letter', 'bad-source', 'bad-letter-kind', 'missing-trigger', 'bad-trigger',
    'bad-trigger-ref', 'secret-in-candidate'
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

  /* ── Role Letter Candidate（纯数据；身份确定性，不改 roleLetters schema）──
     注意：candidateId **不是** letter id —— letter 身份仍由 domain 持有
     （既有实现是 `rletter_<time36>_<rand>`，本阶段不重新发明）。 */
  function buildRoleLetterCandidate(input) {
    if (!isPlainObject(input)) return { ok: false, errors: ['not-an-object'] };
    var errors = [];
    var actorId = str(input.actorId);
    if (!actorId) errors.push('missing-actor-id');
    else if (!usableId(actorId)) errors.push('bad-actor-id');
    var recipientId = str(input.recipientId);
    if (!recipientId) errors.push('missing-recipient-id');
    else if (!usableId(recipientId)) errors.push('bad-recipient-id');
    if (actorId && recipientId && actorId === recipientId) errors.push('self-letter');
    var source = str(input.source);
    if (ROLE_LETTER_SOURCES.indexOf(source) < 0) errors.push('bad-source');
    var letterKind = str(input.letterKind) || 'init';
    if (ROLE_LETTER_KINDS.indexOf(letterKind) < 0) errors.push('bad-letter-kind');
    var trigger = str(input.trigger);
    if (!trigger) errors.push('missing-trigger');
    else if (trigger.length > MAX_TRIGGER_LEN || CONTROL_PATTERN.test(trigger)) errors.push('bad-trigger');
    var triggerRef = str(input.triggerRef);
    if (triggerRef && !usableId(triggerRef)) errors.push('bad-trigger-ref');
    /* §26：candidate 内任何位置都不允许出现凭据（整对象扫描，与其它模块同一探针）。
       信件**正文**不是秘密对象（它不进 candidate；§25 正文 ≠ CoT）。 */
    if (hasSecret({ actorId: actorId, recipientId: recipientId, trigger: trigger, triggerRef: triggerRef, contextRef: input.contextRef })) {
      errors.push('secret-in-candidate');
    }
    errors = dedupe(errors);
    if (errors.length) return { ok: false, errors: errors };
    var token = stableToken([actorId, recipientId, source, letterKind, trigger, triggerRef].join('|'));
    if (!token) return { ok: false, errors: ['bad-trigger-ref'] };
    return {
      ok: true, errors: [],
      candidate: {
        candidateId: 'rlc_' + token,
        actorId: actorId,
        recipientId: recipientId,
        source: source,
        letterKind: letterKind,
        trigger: trigger,
        triggerRef: triggerRef,
        contextRef: str(input.contextRef)
      }
    };
  }

  /* ── Decision（纯函数；facts 由 caller 从真实状态读出）─────────────────
     facts = { actorKnown, recipientKnown, cancelled, enabled, cooldown, duplicate }
     判定顺序（逐条 fail closed）：
       invalid-candidate → unknown-actor → unknown-recipient → cancelled
       → disabled → cooldown → duplicate → allow
     缺任何关键事实 ⇒ DENY；绝不依赖任何 default-allow。 */
  function decideRoleLetterWrite(candidate, facts) {
    var c = isObject(candidate) ? candidate : null;
    var f = isObject(facts) ? facts : {};
    if (!c || !str(c.candidateId) || !str(c.actorId) || !str(c.recipientId)
      || ROLE_LETTER_SOURCES.indexOf(str(c.source)) < 0
      || ROLE_LETTER_KINDS.indexOf(str(c.letterKind)) < 0
      || str(c.actorId) === str(c.recipientId)) {
      return { decision: ROLE_LETTER_DECISIONS.DENY, reason: 'invalid-candidate' };
    }
    if (f.actorKnown !== true) return { decision: ROLE_LETTER_DECISIONS.DENY, reason: 'unknown-actor' };
    if (f.recipientKnown !== true) return { decision: ROLE_LETTER_DECISIONS.DENY, reason: 'unknown-recipient' };
    if (f.cancelled === true) return { decision: ROLE_LETTER_DECISIONS.DENY, reason: 'cancelled' };
    if (f.enabled !== true) return { decision: ROLE_LETTER_DECISIONS.DENY, reason: 'disabled' };
    if (f.cooldown === true) return { decision: ROLE_LETTER_DECISIONS.DENY, reason: 'cooldown' };
    if (f.duplicate === true) return { decision: ROLE_LETTER_DECISIONS.DENY, reason: 'duplicate' };
    return { decision: ROLE_LETTER_DECISIONS.ALLOW, reason: 'allowed' };
  }

  /* ── 唯一入口：candidate → decision →（仅 ALLOW）执行 ───────────────────
     executor 契约（由 domain 提供）：async (candidate) → { ok, letter?, error? } */
  async function runRoleLetterWrite(candidate, facts, executor) {
    var built = (isPlainObject(candidate) && candidate.candidateId !== undefined)
      ? { ok: true, candidate: candidate, errors: [] }
      : buildRoleLetterCandidate(candidate);
    if (!built.ok) {
      return { ok: false, decision: ROLE_LETTER_DECISIONS.DENY, reason: 'invalid-candidate', errors: built.errors, executed: false, actorId: '', recipientId: '', letter: null, error: '' };
    }
    var actorId = str(built.candidate && built.candidate.actorId);
    var recipientId = str(built.candidate && built.candidate.recipientId);
    if (typeof executor !== 'function') {
      return { ok: false, decision: ROLE_LETTER_DECISIONS.DENY, reason: 'no-executor', errors: [], executed: false, actorId: actorId, recipientId: recipientId, letter: null, error: '' };
    }
    var verdict = decideRoleLetterWrite(built.candidate, facts);
    if (verdict.decision !== ROLE_LETTER_DECISIONS.ALLOW) {
      return { ok: false, decision: verdict.decision, reason: verdict.reason, errors: [], executed: false, actorId: actorId, recipientId: recipientId, letter: null, error: '' };
    }
    var outcome = null;
    try { outcome = await executor(built.candidate); }
    catch (error) {
      /* executor 失败 = ALLOW + 执行失败（**不是** DENY） */
      return { ok: false, decision: ROLE_LETTER_DECISIONS.ALLOW, reason: verdict.reason, errors: [], executed: true, actorId: actorId, recipientId: recipientId, letter: null, error: str((error && error.message) || error).slice(0, 200) };
    }
    if (!isObject(outcome)) {
      return { ok: false, decision: ROLE_LETTER_DECISIONS.ALLOW, reason: verdict.reason, errors: [], executed: true, actorId: actorId, recipientId: recipientId, letter: null, error: 'executor-invalid-result' };
    }
    if (outcome.ok === false) {
      return { ok: false, decision: ROLE_LETTER_DECISIONS.ALLOW, reason: verdict.reason, errors: [], executed: true, actorId: actorId, recipientId: recipientId, letter: null, error: (str(outcome.error) || 'executor-failed').slice(0, 200) };
    }
    return {
      ok: true, decision: ROLE_LETTER_DECISIONS.ALLOW, reason: verdict.reason, errors: [], executed: true,
      actorId: actorId, recipientId: recipientId, letter: isObject(outcome.letter) ? outcome.letter : null, error: ''
    };
  }

  /* ── Verifier（§21：只验证 canonical letter 存在，不补写、不 retry）────────
     reader(letterId) → row|null（注入；生产传真实 canonical 读）。 */
  async function verifyRoleLetterWrite(result, reader) {
    var r = isObject(result) ? result : {};
    if (typeof reader !== 'function') return { ok: false, verified: false, errorCode: 'verifier-missing' };
    if (r.status !== undefined && r.status !== 'completed') return { ok: false, verified: false, errorCode: 'not-completed' };
    if (r.ok !== true) return { ok: false, verified: false, errorCode: 'not-completed' };
    var id = str(r.letter && r.letter.id) || str(r.letterId);
    if (!id) return { ok: false, verified: false, errorCode: 'missing-letter-id' };
    var row = null;
    try { row = await reader(id); }
    catch (error) { return { ok: false, verified: false, errorCode: 'verify-read-failed' }; }
    if (!row) return { ok: false, verified: false, errorCode: 'canonical-letter-missing' };
    /* 归属：寄件人与收件人都必须与本次 candidate 一致。 */
    var expectActor = str(r.actorId) || str(r.letter && r.letter.fromRoleId);
    var expectRecipient = str(r.recipientId) || str(r.letter && r.letter.toRoleId);
    if (expectActor && str(row.fromRoleId) && str(row.fromRoleId) !== expectActor) return { ok: false, verified: false, errorCode: 'identity-mismatch' };
    if (expectRecipient && str(row.toRoleId) && str(row.toRoleId) !== expectRecipient) return { ok: false, verified: false, errorCode: 'recipient-mismatch' };
    return { ok: true, verified: true, errorCode: '', letterId: id };
  }

  return {
    ROLE_LETTER_SOURCES: ROLE_LETTER_SOURCES,
    ROLE_LETTER_KINDS: ROLE_LETTER_KINDS,
    ROLE_LETTER_DECISIONS: ROLE_LETTER_DECISIONS,
    ROLE_LETTER_REASONS: ROLE_LETTER_REASONS,
    ROLE_LETTER_ERRORS: ROLE_LETTER_ERRORS,
    buildRoleLetterCandidate: buildRoleLetterCandidate,
    decideRoleLetterWrite: decideRoleLetterWrite,
    runRoleLetterWrite: runRoleLetterWrite,
    verifyRoleLetterWrite: verifyRoleLetterWrite
  };
});
