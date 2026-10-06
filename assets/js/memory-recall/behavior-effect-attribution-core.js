/* ====================================================================
   IB Memory · BehaviorEffect Attribution Core（Prediction Error P5-B2）
   --------------------------------------------------------------------
   ABSENCE_OF_EFFECT_RECORD != KNOWN_NO_EFFECT

   `effects.length === 0` **永远不能单独**证明"当时没有干预"。
   只有当一个 authoritative attribution producer 能证明：

       all relevant BehaviorEffect sources were observed
       AND none were active/relevant

   才能给出 `known-none`。否则一律 `unknown`。

   ── 本文件是纯核心 ───────────────────────────────────────────────────
     零 I/O · 零模型 · 零时钟（`at` 由调用方注入）· 零随机 · 零 durable 写。
     capability seal **不在这里**：只有 attribution authority（BE runtime）能 mint。
   ==================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    var memoryContract = null;
    try { memoryContract = require('../memory-contract.js'); } catch (e) { memoryContract = null; }
    module.exports = factory(memoryContract);
  } else {
    root.IBMemoryBehaviorEffectAttribution = factory(root.IBMemoryContract || null);
  }
})(typeof self !== 'undefined' ? self : this, function (CONTRACT) {
  'use strict';

  var SCHEMA_VERSION = 'behavior-effect-attribution/v1';
  var AUTHORITY = 'RUNTIME_BEHAVIOR_EFFECT';
  var ID_LIFETIME = 'SESSION_ONLY';

  /* ══════════════════════════════════════════════════════════════════
     ① 冻结词表
     ══════════════════════════════════════════════════════════════════ */
  var STATUSES = Object.freeze(['known-none', 'known-present', 'unknown']);
  var COVERAGES = Object.freeze(['complete', 'partial', 'unavailable']);

  /* 归因 authority 的依赖追踪范围。**必须**具名 ——
     "没有依赖" 只有在追踪范围被显式声明为完整时才算证明。 */
  var TRACE_SCOPES = Object.freeze([
    'BEHAVIOR_EFFECT_SUBSYSTEM_ONLY',
    'UNAVAILABLE'
  ]);

  var REASON = Object.freeze({
    ok: 'ok',
    authorityUnavailable: 'attribution-authority-unavailable',
    authorityDisabled: 'attribution-authority-disabled',
    historyTrimmedPastHorizon: 'history-retention-trimmed-past-horizon',
    unobservedDisappearance: 'unobserved-disappearance-degrades-coverage',
    scopeNotRepresented: 'attribution-scope-not-represented',
    observedTermination: 'observed-termination-preserves-active-coverage',
    capacityEvicted: 'capacity-eviction-is-observed-termination',
    noEffectFound: 'no-relevant-active-effect-found',
    effectFound: 'relevant-active-effect-found',
    coverageIncomplete: 'coverage-incomplete-cannot-assert-known-none',
    absenceIsNotEvidence: 'absence-of-effect-record-is-not-known-none',
    predictionInfluenced: 'prediction-conditioned-effect-present',
    predictionNotInfluenced: 'no-behavior-effect-path-consumed-this-prediction',
    predictionInfluenceUnknown: 'prediction-influence-trace-incomplete'
  });

  /* canonical 生命周期终态（P5-B3-A 全仓枚举：这是**全部**真实存在的 exit） */
  var END_REASONS = Object.freeze([
    'consumed',          /* consumeForTurn：单次消费 */
    'expired',           /* sweep：HOLDER_TTL_MS 到期 */
    'replaced',          /* 同 holder key 再次 derive */
    'capacity-evicted'   /* evictOverflow：活跃持有者容量上限 */
  ]);

  var BOUNDS = Object.freeze({ MAX_EFFECTS: 16, MAX_KINDS: 8 });

  /* ══════════════════════════════════════════════════════════════════
     ② 纯 helper
     ══════════════════════════════════════════════════════════════════ */
  function isPlainObject(v) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
    var proto = Object.getPrototypeOf(v);
    return proto === Object.prototype || proto === null;
  }
  function text(v) { return v == null ? '' : String(v); }
  function num(v) { var n = Number(v); return isFinite(n) ? n : null; }
  function deepFreeze(v) {
    if (!v || typeof v !== 'object' || Object.isFrozen(v)) return v;
    Object.freeze(v);
    Object.keys(v).forEach(function (k) { deepFreeze(v[k]); });
    return v;
  }
  function canonicalize(v) {
    try {
      if (CONTRACT && typeof CONTRACT.stableStringify === 'function') return CONTRACT.stableStringify(v);
    } catch (e) { /* fall through */ }
    try { return JSON.stringify(v); } catch (e) { return null; }
  }
  function stableToken(seed) {
    var s = text(seed), h1 = 0x811c9dc5, h2 = 0x01000193;
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      h1 = (h1 ^ c) >>> 0;
      h1 = (h1 + ((h1 << 1) + (h1 << 4) + (h1 << 7) + (h1 << 8) + (h1 << 24))) >>> 0;
      h2 = ((h2 ^ c) * 16777619) >>> 0;
    }
    return (h1.toString(36) + h2.toString(36)).slice(0, 14);
  }
  function isStatus(v) { return STATUSES.indexOf(text(v)) >= 0; }
  function isCoverage(v) { return COVERAGES.indexOf(text(v)) >= 0; }

  /* ══════════════════════════════════════════════════════════════════
     ③ Effect 相关性过滤（**机械**，不看 effect 之外的任何东西）
     ══════════════════════════════════════════════════════════════════
     至少考虑：characterId · conversationId · 时间区间重叠。
     ⇒ 角色 A 的 effect 绝不污染角色 B；两小时前结束的 effect 不污染当前 outcome。 */
  function isActiveAt(effect, at) {
    var t = num(at);
    var started = num(effect && effect.startedAt);
    if (t == null || started == null) return false;
    if (started > t) return false;                       /* 尚未开始 */
    var ended = effect.endedAt == null ? null : num(effect.endedAt);
    if (ended != null && ended <= t) return false;        /* 已结束 */
    return true;
  }
  function isRelevant(effect, scope, at) {
    var s = isPlainObject(scope) ? scope : {};
    var e = isPlainObject(effect) ? effect : null;
    if (!e) return false;
    if (text(e.characterId) !== text(s.characterId)) return false;
    if (text(e.conversationId) !== text(s.conversationId)) return false;
    /* subject：只有双方都给出具体值时才比较（未指定 = 不产生额外约束） */
    var wantSubject = text(s.subjectLabel);
    var gotSubject = text(e.subjectLabel);
    if (wantSubject && gotSubject && wantSubject !== gotSubject) return false;
    return isActiveAt(e, at);
  }
  function relevantEffects(effects, scope, at) {
    var list = Array.isArray(effects) ? effects : [];
    var out = [];
    for (var i = 0; i < list.length; i++) {
      if (isRelevant(list[i], scope, at)) out.push(list[i]);
    }
    return out;
  }

  /* ══════════════════════════════════════════════════════════════════
     ④ Effect instance identity（runtime-issued，session-scoped）
     ══════════════════════════════════════════════════════════════════
     不能只用 effectKind 做 identity：同 type 的两次激活、同一 effect 被观察两次
     都必须可分。`instanceSeq` 由 authority 单调发号 ⇒ 确定性可复算。 */
  function effectInstanceId(input) {
    var i = isPlainObject(input) ? input : {};
    return 'be_' + stableToken([
      text(i.characterId), text(i.conversationId), text(i.sourceTurn),
      String(num(i.createdAt) == null ? 0 : num(i.createdAt)),
      String(num(i.instanceSeq) == null ? 0 : num(i.instanceSeq))
    ].join('|'));
  }

  /* ══════════════════════════════════════════════════════════════════
     ⑤ Coverage 判定（**唯一**出处）
     ══════════════════════════════════════════════════════════════════
     P5-B3-A · 核心区分：

         ACTIVE_EFFECT_AUTHORITY  !=  ATTRIBUTION_HISTORY_RETENTION

     · 活跃 authority 回答"T 时刻有哪些 relevant effect 在生效"，**必须完整**。
       capacity 压力由**终止**解决（capacity-evicted），而不是靠遗忘 ⇒ 活跃集合
       永远不会因为容量而无证据丢失。
     · 历史 retention 回答"能回溯到多早"，**可以有界**。历史被裁剪只影响
       被裁掉的那段过去（`at < effectiveCoverageFloor`），
       **不得**让当前/未来的归因永久 partial。
     */
  /** effectiveCoverageFloor = max(authoritySince, historyRetentionFloor) */
  function effectiveCoverageFloorOf(authoritySince, historyRetentionFloor) {
    /* 注意：`Number(null) === 0` ⇒ 必须先判空，否则 null 会被当成时间戳 0 */
    var a = (authoritySince == null || authoritySince === '') ? null : num(authoritySince);
    var h = (historyRetentionFloor == null || historyRetentionFloor === '') ? null : num(historyRetentionFloor);
    if (a == null && h == null) return null;
    if (a == null) return h;
    if (h == null) return a;
    return Math.max(a, h);
  }
  /**
   * resolveCoverage(basis)
   *   basis = { authorityPresent, authorityEnabled, authoritySince,
   *             historyRetentionFloor, unobservedDisappearance,
   *             scopeRepresented, at }
   */
  function resolveCoverage(basis) {
    var b = isPlainObject(basis) ? basis : {};
    var at = num(b.at);
    var floor = effectiveCoverageFloorOf(b.authoritySince, b.historyRetentionFloor);
    var facts = {
      authoritySince: (b.authoritySince == null || b.authoritySince === '') ? null : num(b.authoritySince),
      historyRetentionFloor: (b.historyRetentionFloor == null || b.historyRetentionFloor === '') ? null : num(b.historyRetentionFloor),
      effectiveCoverageFloor: floor
    };
    if (b.authorityPresent !== true) {
      return { coverage: 'unavailable', reasonCodes: [REASON.authorityUnavailable], facts: facts };
    }
    if (b.authorityEnabled !== true) {
      return { coverage: 'unavailable', reasonCodes: [REASON.authorityDisabled], facts: facts };
    }
    /* 真正的降级：active 集合出现**未被观察到的消失**（invariant 破坏 / 状态损坏） */
    if (b.unobservedDisappearance === true) {
      return { coverage: 'partial', reasonCodes: [REASON.unobservedDisappearance], facts: facts };
    }
    if (b.scopeRepresented === false) {
      return { coverage: 'partial', reasonCodes: [REASON.scopeNotRepresented], facts: facts };
    }
    /* 历史被裁剪：**只**影响被裁掉的那段过去 */
    if (floor != null && at != null && at < floor) {
      return { coverage: 'partial', reasonCodes: [REASON.historyTrimmedPastHorizon], facts: facts };
    }
    return { coverage: 'complete', reasonCodes: [REASON.ok], facts: facts };
  }

  /* ══════════════════════════════════════════════════════════════════
     ⑥ Status 判定 —— 本轮最重要的 invariant 所在
     ══════════════════════════════════════════════════════════════════ */
  /**
   * resolveStatus({ relevantCount, coverage })
   *   ≥1 个真实 relevant effect ⇒ known-present（**不要求**全集完整）
   *   0 个 ∧ coverage === 'complete' ⇒ known-none
   *   0 个 ∧ coverage !== 'complete'  ⇒ **unknown**   ← [] != known-none
   */
  function resolveStatus(input) {
    var i = isPlainObject(input) ? input : {};
    var count = Number(i.relevantCount) || 0;
    var coverage = isCoverage(i.coverage) ? text(i.coverage) : 'unavailable';
    if (count > 0) {
      return {
        status: 'known-present', coverage: coverage,
        reasonCodes: [REASON.effectFound].concat(
          coverage === 'complete' ? [] : [REASON.coverageIncomplete])
      };
    }
    if (coverage === 'complete') {
      return { status: 'known-none', coverage: coverage, reasonCodes: [REASON.noEffectFound] };
    }
    return {
      status: 'unknown', coverage: coverage,
      reasonCodes: [REASON.coverageIncomplete, REASON.absenceIsNotEvidence]
    };
  }

  /* ══════════════════════════════════════════════════════════════════
     ⑦ predictionInfluencedSystem：三态各自的 authority 要求
     ══════════════════════════════════════════════════════════════════
     true  ：有 effect 通过**稳定 ref**证明它由这条 Prediction 条件化
     false ：依赖追踪**完整**且证明没有任何 behavior 路径消费该 Prediction
     null  ：追踪不可用 / 不完整 ⇒ **绝不**猜 false */
  function resolvePredictionInfluenced(input) {
    var i = isPlainObject(input) ? input : {};
    if (i.linkedPredictionFound === true) {
      return { value: true, reasonCode: REASON.predictionInfluenced, dependencyTraceScope: text(i.dependencyTraceScope) || 'UNAVAILABLE' };
    }
    var traceComplete = i.dependencyTraceComplete === true
      && TRACE_SCOPES.indexOf(text(i.dependencyTraceScope)) >= 0
      && text(i.dependencyTraceScope) !== 'UNAVAILABLE';
    if (traceComplete) {
      return { value: false, reasonCode: REASON.predictionNotInfluenced, dependencyTraceScope: text(i.dependencyTraceScope) };
    }
    return { value: null, reasonCode: REASON.predictionInfluenceUnknown, dependencyTraceScope: 'UNAVAILABLE' };
  }

  /* ══════════════════════════════════════════════════════════════════
     ⑧ contamination **facts**（不是 contamination class）
     ══════════════════════════════════════════════════════════════════
     §20：attribution authority 只产出事实；分类属于 P1 core。 */
  function contaminationFacts(snapshot) {
    var s = isPlainObject(snapshot) ? snapshot : {};
    var effects = Array.isArray(s.effects) ? s.effects.slice(0, BOUNDS.MAX_EFFECTS) : [];
    var kinds = [];
    effects.forEach(function (e) {
      var k = text(e && e.effectKind);
      if (k && kinds.indexOf(k) < 0 && kinds.length < BOUNDS.MAX_KINDS) kinds.push(k);
    });
    return deepFreeze({
      effectPresent: effects.length > 0,
      effectCount: effects.length,
      effectKinds: kinds,
      predictionConditioned: s.predictionInfluencedSystem === true,
      predictionInfluenceUnknown: s.predictionInfluencedSystem == null,
      temporalOverlap: effects.length > 0,
      coverage: text(s.coverage),
      attributionStatus: text(s.status),
      /* ★ 明确**不**给出 contaminationClass：那是 P1 core 的判定 */
      contaminationClassAssignedHere: 'NO',
      reasonCodes: (s.reasonCodes || []).slice(0, 8)
    });
  }

  return {
    isActiveAt: isActiveAt,
    isRelevant: isRelevant,
    relevantEffects: relevantEffects,
    effectInstanceId: effectInstanceId,
    resolveCoverage: resolveCoverage,
    effectiveCoverageFloorOf: effectiveCoverageFloorOf,
    resolveStatus: resolveStatus,
    resolvePredictionInfluenced: resolvePredictionInfluenced,
    contaminationFacts: contaminationFacts,
    deepFreeze: deepFreeze,
    canonicalize: canonicalize,
    stableToken: stableToken,

    SCHEMA_VERSION: SCHEMA_VERSION,
    AUTHORITY: AUTHORITY,
    ID_LIFETIME: ID_LIFETIME,
    STATUSES: STATUSES,
    COVERAGES: COVERAGES,
    TRACE_SCOPES: TRACE_SCOPES,
    END_REASONS: END_REASONS,
    BOUNDS: BOUNDS,
    REASON: REASON,

    STATE_SUPPORT: Object.freeze({
      absenceOfEffectRecordIsNotKnownNone: 'YES',
      knownNoneRequiresCompleteCoverage: 'YES',
      onlyAuthorityMintsValidSnapshot: 'YES',
      predictionInfluencedFalseRequiresCompleteTrace: 'YES',
      predictionCreationAttributionIsImmutable: 'YES',
      predictionCreationAndOutcomeAttributionAreSeparate: 'YES',
      authority: AUTHORITY,
      lifetime: ID_LIFETIME,
      durableWrites: 0,
      modelCalls: 0,
      clockReads: 0,
      oneEffectFactOwner: 'YES'
    })
  };
});
