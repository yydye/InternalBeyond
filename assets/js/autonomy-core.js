/* ====================================================================
   IB Autonomy Core — P25-1 · Autonomy Decision Layer（**pure foundation**）
   --------------------------------------------------------------------
   本模块只回答一个问题：

     「某个角色/模块想执行某个自主动作时，**是否允许执行**？」

   它**不是**：scheduler / message generator / AI agent loop / executor。
   它**不做**：生成内容、写业务数据、调 provider、调模型、读写 Memory、
             持久化任何东西、决定产品频率策略。

   ── 标准流程（唯一入口 runAutonomyAction）────────────────────────────
     Action Candidate → Context Evaluation → Decision → Executor → Result Trace

   ── 权威边界 ─────────────────────────────────────────────────────────
     · Autonomy Core 只说 allow / deny / defer；**执行永远由 executor 负责**；
     · 只有 allow 才会调用 executor（deny / defer ⇒ executor 调用次数 = 0）；
     · hard gates（非法 action / cancelled / duplicate / cooldown / 无 executor）
       先于可选的语义 decider；failure ⇒ **DENY**（绝不因为裁决失败而执行）。

   ── 纯度 ─────────────────────────────────────────────────────────────
     零 DOM / 零 fetch / 零 IndexedDB / 零 provider / 零 TTS / 零定时器；
     时间必须由调用方注入（`ctx.now`）—— 本文件里没有 Date.now / Math.random；
     因此同一 input（含同样的注入时间）⇒ 同一 decision 与同一 trace。

   ── 与其它权威的关系 ─────────────────────────────────────────────────
     · 不替代 P24（Group Runtime）—— P24 未来只是本层的一个 Action Runtime 适配者；
     · Middle Brain 未来只能提供 recommendation（不是 authority）；
     · Memory 未来只能提供 context（不是执行许可）；
     · trace 只活在内存里（memory=false / persist=false），不进 chatMessages / social / IndexedDB。
   ==================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(require('./chat-core.js'), require('./voice-message-core.js')); }
  else { root.IBAutonomyCore = factory(root.IBChatCore, root.IBVoiceMessage); }
})(typeof self !== 'undefined' ? self : this, function (CHAT_CORE, VOICE) {
  'use strict';

  /* ── 闭集词表（唯一真源）────────────────────────────────────────────── */
  /* actionType：本阶段只放 **future placeholder**（没有 executor 实现）。 */
  var AUTONOMY_ACTION_TYPES = Object.freeze([
    'moment.post',
    'diary.write',
    'active_message.send',
    'activity.start'
  ]);
  /* source：谁提出的候选（用于审计与去重指纹，不参与授权）。 */
  var AUTONOMY_SOURCES = Object.freeze(['user', 'schedule', 'character', 'group_runtime', 'system']);
  /* decision：闭集，绝不接受自然语言 / 模型原文。 */
  var AUTONOMY_DECISIONS = Object.freeze({ ALLOW: 'allow', DENY: 'deny', DEFER: 'defer' });
  /* reason：闭集词汇（诊断/审计用；绝不回显正文或凭据）。 */
  var AUTONOMY_REASONS = Object.freeze([
    'default-allow',
    'invalid-action',
    'cancelled',
    'duplicate',
    'cooldown',
    'no-executor',
    'decision-deny',
    'decision-defer',
    'decision-failure'
  ]);
  var AUTONOMY_ERRORS = Object.freeze([
    'not-an-object', 'missing-action-type', 'bad-action-type', 'missing-actor-id', 'bad-actor-id',
    'bad-source', 'bad-context', 'secret-in-action'
  ]);
  /* trace 环形上限（runtime-only，避免无限增长）。 */
  var AUTONOMY_TRACE_LIMIT = 50;
  /* duplicate protection 的**默认窗口**（可被 ctx.duplicateWindowMs 覆盖；
     本阶段不绑定任何产品频率策略）。 */
  var AUTONOMY_DUPLICATE_WINDOW_MS = 60000;
  var MAX_ID_LEN = 200;
  var CONTROL_PATTERN = /[\u0000-\u001F\u007F]/;
  var GROUP_ID_PREFIX = 'group_';

  function isObject(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
  function str(v) { return v == null ? '' : String(v); }
  function isPlainObject(v) {
    if (!isObject(v)) return false;
    var proto = Object.getPrototypeOf(v);
    return proto === Object.prototype || proto === null;
  }
  function hasSecret(v) {
    try { if (VOICE && typeof VOICE.findSecret === 'function') return !!VOICE.findSecret(v); } catch (e) { /* fail open on probe */ }
    return false;
  }
  function isUsableActorId(v) {
    var s = str(v);
    if (!s || s !== s.trim() || s.length > MAX_ID_LEN) return false;
    if (CONTROL_PATTERN.test(s)) return false;
    if (s.indexOf(GROUP_ID_PREFIX) === 0) return false;   /* actor 是角色/模块，不是群 */
    return true;
  }
  function isNonNegativeInt(v) {
    return typeof v === 'number' && isFinite(v) && Math.floor(v) === v && v >= 0;
  }
  function autonomyContractError(errors) {
    var e = new Error('autonomy-contract: ' + errors.join(','));
    e.code = 'AUTONOMY_CONTRACT';
    e.errors = errors.slice();
    return e;
  }

  /* ── Action Contract ──────────────────────────────────────────────────
     { actionType, actorId, source, context?, fingerprint? }
     只做**结构**校验：不判断业务合理性、不读任何外部状态。 */
  function validateAutonomyAction(action) {
    if (!isObject(action)) return { ok: false, errors: ['not-an-object'] };
    var errors = [];
    var type = str(action.actionType);
    if (!type) errors.push('missing-action-type');
    else if (AUTONOMY_ACTION_TYPES.indexOf(type) < 0) errors.push('bad-action-type');
    var actorId = str(action.actorId);
    if (!actorId) errors.push('missing-actor-id');
    else if (!isUsableActorId(actorId)) errors.push('bad-actor-id');
    var source = str(action.source);
    if (!source || AUTONOMY_SOURCES.indexOf(source) < 0) errors.push('bad-source');
    if (action.context !== undefined && !isObject(action.context)) errors.push('bad-context');
    if (errors.length === 0 && hasSecret({
      actionType: type, actorId: actorId, source: source,
      fingerprint: str(action.fingerprint), context: isObject(action.context) ? action.context : null
    })) errors.push('secret-in-action');
    return { ok: errors.length === 0, errors: errors };
  }
  /* 去重指纹：actor + actionType + 业务指纹（可由调用方提供）⇒ 稳定字符串。 */
  function autonomyFingerprint(action) {
    var a = isObject(action) ? action : {};
    var seed = str(a.actionType) + '|' + str(a.actorId) + '|' + str(a.fingerprint);
    try { if (CHAT_CORE && typeof CHAT_CORE.stableToken === 'function') return CHAT_CORE.stableToken(seed); } catch (e) { /* fall through */ }
    return seed;
  }
  /* runtime-only state：trace 环 + 最近执行时间（fingerprint → ts）。 */
  function createAutonomyState() {
    return { trace: [], lastExecuted: Object.create(null) };
  }
  function _autonomyNow(ctx) {
    var o = isObject(ctx) ? ctx : {};
    return isNonNegativeInt(o.now) ? o.now : null;
  }
  /* ── Duplicate protection（基础能力，不实现 scheduler）─────────────────
     同一 actor + 同一 actionType + 同一 fingerprint 在窗口内重复 ⇒ true。 */
  function isDuplicateAutonomyAction(state, action, ctx) {
    if (!isObject(state) || !isObject(state.lastExecuted)) return false;
    var now = _autonomyNow(ctx);
    if (now === null) return false;                       /* 未注入时间 ⇒ 不做时间判定（确定性） */
    var o = isObject(ctx) ? ctx : {};
    var win = isNonNegativeInt(o.duplicateWindowMs) ? o.duplicateWindowMs : AUTONOMY_DUPLICATE_WINDOW_MS;
    var ts = state.lastExecuted[autonomyFingerprint(action)];
    return isNonNegativeInt(ts) && (now - ts) < win;
  }
  /* ── Cooldown Contract（只设计接口）────────────────────────────────────
     冷却策略由调用方注入：ctx.cooldownMsFor(action) → 毫秒（缺省/非法 ⇒ 无冷却）。
     本层不绑定"每天几次"之类的时间策略。 */
  function canExecuteAutonomyAction(state, action, ctx) {
    var o = isObject(ctx) ? ctx : {};
    if (typeof o.cooldownMsFor !== 'function') return true;
    var now = _autonomyNow(ctx);
    if (now === null) return true;
    var ms = null;
    try { ms = o.cooldownMsFor(action); } catch (e) { return true; }   /* 冷却来源失败 ⇒ 不阻断（仅记录由调用方决定） */
    if (!isNonNegativeInt(ms) || ms === 0) return true;
    var last = isObject(state) && isObject(state.lastExecuted) ? state.lastExecuted[autonomyFingerprint(action)] : null;
    return !(isNonNegativeInt(last) && (now - last) < ms);
  }
  /* ── Decision Contract ────────────────────────────────────────────────
     hard gates 先判（非法 / cancelled / duplicate / cooldown / 无 executor），
     然后可选语义 decider（ctx.decide）——它只能返回闭集决策；
     未知 / 抛错 / malformed ⇒ **DENY**（decision-failure）：裁决失败绝不导致执行。 */
  function evaluateAutonomyAction(state, action, ctx, executor) {
    var o = isObject(ctx) ? ctx : {};
    var verdict = validateAutonomyAction(action);
    if (!verdict.ok) return { decision: AUTONOMY_DECISIONS.DENY, reason: 'invalid-action', errors: verdict.errors };
    if (o.cancelled === true) return { decision: AUTONOMY_DECISIONS.DENY, reason: 'cancelled' };
    if (typeof executor !== 'function') return { decision: AUTONOMY_DECISIONS.DENY, reason: 'no-executor' };
    if (isDuplicateAutonomyAction(state, action, ctx)) return { decision: AUTONOMY_DECISIONS.DENY, reason: 'duplicate' };
    if (!canExecuteAutonomyAction(state, action, ctx)) return { decision: AUTONOMY_DECISIONS.DENY, reason: 'cooldown' };
    if (typeof o.decide !== 'function') return { decision: AUTONOMY_DECISIONS.ALLOW, reason: 'default-allow' };
    /* 只给 decider 最小只读视图（无凭据 / 无 provider / 无 Memory）。 */
    var brief = {
      actionType: str(action.actionType),
      actorId: str(action.actorId),
      source: str(action.source),
      context: isObject(action.context) ? action.context : null
    };
    var out = null;
    try { out = o.decide(brief); }
    catch (e) { return { decision: AUTONOMY_DECISIONS.DENY, reason: 'decision-failure' }; }
    if (!isObject(out)) return { decision: AUTONOMY_DECISIONS.DENY, reason: 'decision-failure' };
    var d = out.decision;
    if (d === AUTONOMY_DECISIONS.ALLOW) return { decision: AUTONOMY_DECISIONS.ALLOW, reason: 'default-allow' };
    if (d === AUTONOMY_DECISIONS.DENY) return { decision: AUTONOMY_DECISIONS.DENY, reason: 'decision-deny' };
    if (d === AUTONOMY_DECISIONS.DEFER) return { decision: AUTONOMY_DECISIONS.DEFER, reason: 'decision-defer' };
    return { decision: AUTONOMY_DECISIONS.DENY, reason: 'decision-failure' };
  }
  function _autonomyRecordTrace(state, action, decision, reason, now) {
    if (!isObject(state) || !Array.isArray(state.trace)) return null;
    var entry = {
      actionType: str(action.actionType),
      actorId: str(action.actorId),
      decision: str(decision),
      reason: str(reason),
      timestamp: isNonNegativeInt(now) ? now : null
    };
    state.trace.push(entry);
    while (state.trace.length > AUTONOMY_TRACE_LIMIT) state.trace.shift();
    return entry;
  }
  /* ── 唯一入口：裁决 → （仅 allow 时）执行 → trace ───────────────────────
     返回 { decision, reason, executed, ok, error?, trace }。
     executor 抛错不会向上污染调用方：被捕获为 ok:false + error 文本（不落库、不回显凭据）。 */
  function runAutonomyAction(state, action, ctx, executor) {
    var o = isObject(ctx) ? ctx : {};
    var verdict = evaluateAutonomyAction(state, action, ctx, executor);
    var now = _autonomyNow(ctx);
    var executed = false, ok = false, errorText = '';
    if (verdict.decision === AUTONOMY_DECISIONS.ALLOW) {
      executed = true;
      try {
        executor(action);
        ok = true;
      } catch (e) {
        ok = false;
        errorText = String((e && e.message) || e).slice(0, 120);
      }
      if (isObject(state) && isObject(state.lastExecuted) && now !== null) {
        state.lastExecuted[autonomyFingerprint(action)] = now;   /* runtime-only 去重/冷却账本 */
      }
    }
    var trace = _autonomyRecordTrace(state, action, verdict.decision, verdict.reason, now);
    return {
      decision: verdict.decision, reason: verdict.reason,
      executed: executed, ok: ok, error: errorText, trace: trace
    };
  }
  /* 只读 trace 快照（供测试/telemetry；不暴露内部数组引用）。 */
  function autonomyTraceSnapshot(state) {
    if (!isObject(state) || !Array.isArray(state.trace)) return [];
    return state.trace.map(function (t) {
      return {
        actionType: str(t.actionType), actorId: str(t.actorId),
        decision: str(t.decision), reason: str(t.reason),
        timestamp: (t.timestamp === null || t.timestamp === undefined) ? null : t.timestamp
      };
    });
  }

  return {
    AUTONOMY_ACTION_TYPES: AUTONOMY_ACTION_TYPES,
    AUTONOMY_SOURCES: AUTONOMY_SOURCES,
    AUTONOMY_DECISIONS: AUTONOMY_DECISIONS,
    AUTONOMY_REASONS: AUTONOMY_REASONS,
    AUTONOMY_ERRORS: AUTONOMY_ERRORS,
    AUTONOMY_TRACE_LIMIT: AUTONOMY_TRACE_LIMIT,
    AUTONOMY_DUPLICATE_WINDOW_MS: AUTONOMY_DUPLICATE_WINDOW_MS,
    validateAutonomyAction: validateAutonomyAction,
    autonomyFingerprint: autonomyFingerprint,
    createAutonomyState: createAutonomyState,
    isDuplicateAutonomyAction: isDuplicateAutonomyAction,
    canExecuteAutonomyAction: canExecuteAutonomyAction,
    evaluateAutonomyAction: evaluateAutonomyAction,
    runAutonomyAction: runAutonomyAction,
    autonomyTraceSnapshot: autonomyTraceSnapshot
  };
});
