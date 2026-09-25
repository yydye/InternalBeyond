/* ====================================================================
   IB Diary Authority — P25-3B · Diary Capability Integration
   --------------------------------------------------------------------
   回答一个问题：**某个主体想给某个角色写一篇日记，是否允许？**

   合法链（唯一）：

     Plan → Capability Resolution → Diary Authority → ALLOW → Diary Executor
          → Canonical Diary Writer → Verify

   冻结：
     · PLAN != PERMISSION · MODEL OUTPUT != PERMISSION · SCHEDULER TRIGGER != PERMISSION
       · CAPABILITY AVAILABILITY != PERMISSION
     · 模型只产"想写 + 内容"；写权限只属于本模块。
     · 纯：零 DOM / 零 IndexedDB / 零 fetch / 零 provider / 零模型 / 零 Memory /
       零 Middle Brain / 零 scheduler / 零定时器。executor 与 reader 全部注入。

   注：Autonomy Core（P25-1）管的是 Moments 创建；Diary 的写权限**不在** Core 里，
   也不需要 Core 的 default-allow（本模块永远显式决策）。
   ==================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(null, require('./chat-core.js'), require('./voice-message-core.js'));
  } else {
    root.IBDiaryAuthority = factory(root, root.IBChatCore, root.IBVoiceMessage);
  }
})(typeof self !== 'undefined' ? self : this, function (root, CHAT_CORE, VOICE) {
  'use strict';

  /* source 闭集：由 Phase 0 审计的真实入口推出（见 docs/P25-3B-DIARY-CAPABILITY.md）。
       schedule  ← weekly / daily_plan（调度器到期）
       character ← first_chat / return_after_gap（聊天事件触发的角色自主）
       user      ← manual / wish（用户明确要求角色写） */
  var DIARY_SOURCES = Object.freeze(['schedule', 'character', 'user']);
  var DIARY_DECISIONS = Object.freeze({ ALLOW: 'allow', DENY: 'deny' });
  /* 无 DEFER：Diary 的"稍后"语义已经由 scheduler（weekly/daily 水位线）承担，
     写动作本身没有延迟语义 —— 需要 DEFER 才有意义的是"创建候选"，不是"写这一篇"。 */
  var DIARY_REASONS = Object.freeze([
    'allowed',
    'invalid-candidate',
    'unknown-actor',
    'disabled',
    'empty-content',
    'cancelled',
    'no-executor',
    'not-available',
    'secret-in-candidate'
  ]);
  var DIARY_ERRORS = Object.freeze([
    'not-an-object', 'missing-actor-id', 'bad-actor-id', 'bad-source', 'missing-trigger',
    'bad-trigger', 'bad-trigger-ref', 'bad-diary-type', 'secret-in-candidate'
  ]);
  /* 与 Diary 域 _diaryDefaults 的闭集一致（不新增第二套类型枚举）。 */
  var DIARY_TYPES = Object.freeze(['daily', 'weekly', 'event', 'emotion']);
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

  /* ── Diary Candidate（纯数据；身份确定性，不改 Diary schema）──────────
     注意：candidateId **不是** Diary entry id —— Diary 的 entry id 由 domain 持有
     （现有实现是 `diary_<时间>_<随机>`），本阶段不重新发明它（§19）。
     candidateId 只用于 authority / 审计 / 幂等键透传。 */
  function buildDiaryCandidate(input) {
    if (!isPlainObject(input)) return { ok: false, errors: ['not-an-object'] };
    var errors = [];
    var actorId = str(input.actorId);
    if (!actorId) errors.push('missing-actor-id');
    else if (!usableId(actorId)) errors.push('bad-actor-id');
    var source = str(input.source);
    if (DIARY_SOURCES.indexOf(source) < 0) errors.push('bad-source');
    var trigger = str(input.trigger);
    if (!trigger) errors.push('missing-trigger');
    else if (trigger.length > MAX_TRIGGER_LEN || CONTROL_PATTERN.test(trigger)) errors.push('bad-trigger');
    var triggerRef = str(input.triggerRef);
    if (triggerRef && (!usableId(triggerRef) || triggerRef.length > MAX_ID_LEN)) errors.push('bad-trigger-ref');
    var diaryType = str(input.diaryType) || 'daily';
    if (DIARY_TYPES.indexOf(diaryType) < 0) errors.push('bad-diary-type');
    /* §33：candidate 内任何位置都不允许出现凭据（整对象扫描，与其它模块同一探针）。
       注意：日记**正文**不是 secret 的黑名单对象（§32），只有凭据形态才被拒。 */
    if (hasSecret({ actorId: actorId, trigger: trigger, triggerRef: triggerRef, contextRef: input.contextRef, draft: input.draft })) errors.push('secret-in-candidate');
    errors = dedupe(errors);
    if (errors.length) return { ok: false, errors: errors };
    var token = stableToken([actorId, source, trigger, triggerRef, diaryType].join('|'));
    if (!token) return { ok: false, errors: ['bad-trigger-ref'] };
    return {
      ok: true, errors: [],
      candidate: {
        candidateId: 'dca_' + token,
        actorId: actorId,
        source: source,
        trigger: trigger,
        triggerRef: triggerRef,
        diaryType: diaryType,
        contextRef: str(input.contextRef)
      }
    };
  }
  /* trigger → source 的唯一映射（domain 侧只报 trigger，source 由这里派生）。 */
  function sourceOfTrigger(trigger) {
    var t = str(trigger);
    if (t === 'weekly' || t === 'daily_plan') return 'schedule';
    if (t === 'first_chat' || t === 'return_after_gap') return 'character';
    if (t === 'manual' || t === 'wish') return 'user';
    return '';
  }

  /* ── Decision（纯函数；facts 由 caller 从真实状态读出）─────────────────
     facts = { actorKnown, enabled, hasContent, cancelled }
     全部缺失/为假 ⇒ DENY（fail closed）。绝不依赖任何 default-allow。 */
  function decideDiaryWrite(candidate, facts) {
    var c = isObject(candidate) ? candidate : null;
    var f = isObject(facts) ? facts : {};
    if (!c || !str(c.candidateId) || !str(c.actorId) || DIARY_SOURCES.indexOf(str(c.source)) < 0) {
      return { decision: DIARY_DECISIONS.DENY, reason: 'invalid-candidate' };
    }
    if (f.actorKnown !== true) return { decision: DIARY_DECISIONS.DENY, reason: 'unknown-actor' };
    if (f.cancelled === true) return { decision: DIARY_DECISIONS.DENY, reason: 'cancelled' };
    if (f.enabled !== true) return { decision: DIARY_DECISIONS.DENY, reason: 'disabled' };
    if (f.hasContent !== true) return { decision: DIARY_DECISIONS.DENY, reason: 'empty-content' };
    return { decision: DIARY_DECISIONS.ALLOW, reason: 'allowed' };
  }

  /* ── 唯一入口：candidate → decision →（仅 ALLOW）执行 ───────────────────
     executor 契约（由 domain 提供，authority 不认识 store）：
       async (candidate) → { ok:boolean, entry?:<canonical diary entry>, error?:string }
     返回值**规范化为**：{ ok, decision, reason, errors, executed, entry:<日记条目>, error, actorId }
     —— 这样 verifier 只需读 result.entry.id（不需要知道 executor 的包装形状）。 */
  async function runDiaryWrite(candidate, facts, executor) {
    var built = (isPlainObject(candidate) && candidate.candidateId !== undefined)
      ? { ok: true, candidate: candidate, errors: [] }
      : buildDiaryCandidate(candidate);
    if (!built.ok) {
      return { ok: false, decision: DIARY_DECISIONS.DENY, reason: 'invalid-candidate', errors: built.errors, executed: false, actorId: '', entry: null, error: '' };
    }
    var actorId = str(built.candidate && built.candidate.actorId);
    if (typeof executor !== 'function') {
      return { ok: false, decision: DIARY_DECISIONS.DENY, reason: 'no-executor', errors: [], executed: false, actorId: actorId, entry: null, error: '' };
    }
    var verdict = decideDiaryWrite(built.candidate, facts);
    if (verdict.decision !== DIARY_DECISIONS.ALLOW) {
      return { ok: false, decision: verdict.decision, reason: verdict.reason, errors: [], executed: false, actorId: actorId, entry: null, error: '' };
    }
    var outcome = null;
    try { outcome = await executor(built.candidate); }
    catch (error) {
      /* executor 失败 = ALLOW + 执行失败（**不是** DENY，§9/D9） */
      return { ok: false, decision: DIARY_DECISIONS.ALLOW, reason: verdict.reason, errors: [], executed: true, actorId: actorId, entry: null, error: str((error && error.message) || error).slice(0, 200) };
    }
    /* 执行"已发生"（executed 恒为 true）：下面的 ok 只表示**这一篇是否写成功**。 */
    if (!isObject(outcome)) {
      return { ok: false, decision: DIARY_DECISIONS.ALLOW, reason: verdict.reason, errors: [], executed: true, actorId: actorId, entry: null, error: 'executor-invalid-result' };
    }
    if (outcome.ok === false) {
      return { ok: false, decision: DIARY_DECISIONS.ALLOW, reason: verdict.reason, errors: [], executed: true, actorId: actorId, entry: null, error: (str(outcome.error) || 'executor-failed').slice(0, 200) };
    }
    return {
      ok: true, decision: DIARY_DECISIONS.ALLOW, reason: verdict.reason, errors: [], executed: true,
      actorId: actorId, entry: isObject(outcome.entry) ? outcome.entry : null, error: ''
    };
  }

  /* ── Verifier（§28/§29：只验证，不补写、不重试）────────────────────────
     reader(entryId) → row|null（注入；生产传真实 canonical 读）。
     结果里没有可验证的 entry id，或 canonical 行不存在 ⇒ verification failed。 */
  async function verifyDiaryWrite(result, reader) {
    var r = isObject(result) ? result : {};
    if (typeof reader !== 'function') return { ok: false, verified: false, errorCode: 'verifier-missing' };
    if (r.status !== undefined && r.status !== 'completed') return { ok: false, verified: false, errorCode: 'not-completed' };
    if (r.ok !== true) return { ok: false, verified: false, errorCode: 'not-completed' };
    var id = str(r.entry && r.entry.id) || str(r.entryId);
    if (!id) return { ok: false, verified: false, errorCode: 'missing-entry-id' };
    var row = null;
    try { row = await reader(id); }
    catch (error) { return { ok: false, verified: false, errorCode: 'verify-read-failed' }; }
    if (!row) return { ok: false, verified: false, errorCode: 'canonical-entry-missing' };
    /* 归属校验：canonical 行的角色必须是本次 candidate 的 actor（空则跳过，不臆测）。 */
    var expectActor = str(r.actorId) || str(r.entry && r.entry.characterId);
    if (expectActor && str(row.characterId) !== expectActor) return { ok: false, verified: false, errorCode: 'identity-mismatch' };
    return { ok: true, verified: true, errorCode: '', entryId: id };
  }

  return {
    DIARY_SOURCES: DIARY_SOURCES,
    DIARY_TYPES: DIARY_TYPES,
    DIARY_DECISIONS: DIARY_DECISIONS,
    DIARY_REASONS: DIARY_REASONS,
    DIARY_ERRORS: DIARY_ERRORS,
    buildDiaryCandidate: buildDiaryCandidate,
    sourceOfTrigger: sourceOfTrigger,
    decideDiaryWrite: decideDiaryWrite,
    runDiaryWrite: runDiaryWrite,
    verifyDiaryWrite: verifyDiaryWrite
  };
});
