/* ====================================================================
   IB Memory · Prediction Settlement Core（Prediction Error P3）
   --------------------------------------------------------------------
   NO REINTERPRETATION · NO RE-AUTHORITY · NO MODEL

   它**只**做四件事：
     ① 消费**已经冻结**的 PredictionRecord（不重新解释 prediction）
     ② 消费**已经过 authority gate** 的 OutcomeObservation（不重新判 authority）
     ③ 按 T0–T8 的**有序**判定产出七状态之一（确定性）
     ④ 把结算折算成 **ordinal** Prediction Error（direction + magnitude）

   ── 它**没有**的能力 ─────────────────────────────────────────────────
     模型 authority · prediction-type authority · observation authority ·
     memory authority · relationship authority · provider authority。
     零 I/O · 零网络 · 零模型 · 零 durable 写 · 零时钟（now 由调用方注入）·
     零随机 · 零 calibration 回写。

   ── 本相位**最重要**的两条机械规则 ─────────────────────────────────
     DIRECTIONAL AUTHORITY：语义上 conflict **不等于**有资格产生 missed。
       必须 `gate.directional.conflict === 'ELIGIBLE'` 才可能是 decisive conflict。
     UNKNOWN ATTRIBUTION ≠ NONE：`behaviorEffectsInForce: []` 不等于"没有干预"。
       归因 unknown 时，主观域**禁止** decisive settlement（fail closed）。
   ==================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    var memoryContract = null, preferenceProposition = null;
    try { memoryContract = require('../memory-contract.js'); } catch (e) { memoryContract = null; }
    /* P5-B3-E-R1 · canonical preference proposition 文法的**唯一**出处
       （与 P1 core 用的是同一个文件，不在这里抄第二份正则）。 */
    try { preferenceProposition = require('./preference-proposition-core.js'); } catch (e) { preferenceProposition = null; }
    module.exports = factory(memoryContract, preferenceProposition);
  } else {
    root.IBMemoryPredictionSettlement = factory(
      root.IBMemoryContract || null,
      root.IBMemoryPreferenceProposition || null
    );
  }
})(typeof self !== 'undefined' ? self : this, function (CONTRACT, PREFERENCE) {
  'use strict';

  var SCHEMA_VERSION = 'prediction-settlement/v1';
  var PE_SCHEMA_VERSION = 'prediction-error/v1';
  var ID_PREFIX = 'stl_';
  var PE_ID_PREFIX = 'perr_';
  var ID_LIFETIME = 'SESSION_ONLY';

  /* ══════════════════════════════════════════════════════════════════
     ① 冻结词表
     ══════════════════════════════════════════════════════════════════ */

  /* **唯一** canonical 七状态。 */
  var SETTLEMENT_STATES = Object.freeze([
    'pending', 'matched', 'missed', 'mixed',
    'expired_unobserved', 'unresolvable', 'superseded'
  ]);
  var TERMINAL_STATES = Object.freeze([
    'matched', 'missed', 'mixed', 'expired_unobserved', 'unresolvable', 'superseded'
  ]);
  /* legacy 五词表：**声明但不产出**（LEGACY_RESULT_ADAPTER = NONE）。 */
  var LEGACY_RESULTS = Object.freeze(['confirmed', 'contradicted', 'partial', 'unknown', 'unsettled']);
  var LEGACY_RESULT_ADAPTER = 'NONE';

  var SUBJECTIVE_TYPES = Object.freeze(['preference', 'latent_state', 'relational']);
  var MECHANISM_TYPES = Object.freeze(['event']);

  var CONFIDENCE_BUCKETS = Object.freeze(['low', 'medium', 'high', 'unstated']);
  var DIRECTIONS = Object.freeze(['over-confident', 'under-confident', 'calibrated', 'unknown']);
  var MAGNITUDES = Object.freeze(['none', 'low', 'moderate', 'high', 'unknown']);

  var MECHANICAL_RELATIONS = Object.freeze(['support', 'conflict', 'irrelevant', 'unclassifiable']);
  /* P5-B · Evidence Matcher 可以提供的 relation（闭集；`ambiguous` 是 first-class）。 */
  var MATCHER_RELATIONS = Object.freeze(['support', 'conflict', 'irrelevant', 'ambiguous']);
  var EVIDENCE_MATCHER_ROLE = 'ADVISORY_SEMANTIC_CLASSIFIER_ONLY';
  var OPPORTUNITY_STATES = Object.freeze(['SATISFIED', 'NOT-REQUIRED', 'ABSENT', 'NOT-CONSUMED', 'UNKNOWN']);

  /* contract §F.6 的查表（**唯一**出处；模型不参与）。 */
  var PE_TABLE = Object.freeze({
    pending: Object.freeze({
      low: Object.freeze({ direction: 'unknown', magnitude: 'unknown' }),
      medium: Object.freeze({ direction: 'unknown', magnitude: 'unknown' }),
      high: Object.freeze({ direction: 'unknown', magnitude: 'unknown' }),
      unstated: Object.freeze({ direction: 'unknown', magnitude: 'unknown' })
    }),
    matched: Object.freeze({
      low: Object.freeze({ direction: 'under-confident', magnitude: 'moderate' }),
      medium: Object.freeze({ direction: 'calibrated', magnitude: 'low' }),
      high: Object.freeze({ direction: 'calibrated', magnitude: 'none' }),
      unstated: Object.freeze({ direction: 'unknown', magnitude: 'unknown' })
    }),
    missed: Object.freeze({
      low: Object.freeze({ direction: 'over-confident', magnitude: 'low' }),
      medium: Object.freeze({ direction: 'over-confident', magnitude: 'moderate' }),
      high: Object.freeze({ direction: 'over-confident', magnitude: 'high' }),
      unstated: Object.freeze({ direction: 'unknown', magnitude: 'unknown' })
    }),
    mixed: Object.freeze({
      low: Object.freeze({ direction: 'unknown', magnitude: 'unknown' }),
      medium: Object.freeze({ direction: 'unknown', magnitude: 'low' }),
      high: Object.freeze({ direction: 'unknown', magnitude: 'moderate' }),
      unstated: Object.freeze({ direction: 'unknown', magnitude: 'unknown' })
    }),
    expired_unobserved: Object.freeze({
      low: Object.freeze({ direction: 'unknown', magnitude: 'unknown' }),
      medium: Object.freeze({ direction: 'unknown', magnitude: 'unknown' }),
      high: Object.freeze({ direction: 'unknown', magnitude: 'moderate' }),
      unstated: Object.freeze({ direction: 'unknown', magnitude: 'unknown' })
    }),
    unresolvable: Object.freeze({
      low: Object.freeze({ direction: 'unknown', magnitude: 'unknown' }),
      medium: Object.freeze({ direction: 'unknown', magnitude: 'unknown' }),
      high: Object.freeze({ direction: 'unknown', magnitude: 'unknown' }),
      unstated: Object.freeze({ direction: 'unknown', magnitude: 'unknown' })
    }),
    superseded: Object.freeze({
      low: Object.freeze({ direction: 'unknown', magnitude: 'unknown' }),
      medium: Object.freeze({ direction: 'unknown', magnitude: 'unknown' }),
      high: Object.freeze({ direction: 'unknown', magnitude: 'unknown' }),
      unstated: Object.freeze({ direction: 'unknown', magnitude: 'unknown' })
    })
  });
  var PREDICTION_ERROR_METRIC = null;   /* v1：**恒为 null**，不造数值 */

  var WINDOW_ABSENCE_TOKEN = 'window.closed-without-occurrence';

  /* ── decisive authority sources（**唯一**的 settlement policy 出处）──────
     一个 predictionType 只有在证据来自**被允许的来源**时，才可能产生
     decisive settlement。这与 authority matrix（天花板）是**两件事**：
       matrix 说"这个 source 对这个 domain 有没有资格被看见"；
       这张表说"这个 type 的结算能不能由这个 source 决定"。

     ★ 它是 **one policy table, multiple consumers** 的唯一出处：
         · P3 `computeSettlement` —— 决定 support/conflict 是否 decisive
         · P4 `calibrationReachability` —— 决定一个组合是否可能被 P3 合法产生
       P3 / P4 各自**不得**再复制一套 if。
       tests 断言它与 P2 `POLICY_TABLE[type].strongestAuthority` **逐字一致**。

     为什么 preference/latent_state/relational 只有 EXPLICIT_USER_REPORT：
       AUTO_SETTLE_PREFERENCE_FROM_BEHAVIOR = OFF
       行为、沉默、语言推断 **不得**产生 decisive settlement（(q-15)/(q-13)）。 */
  var DECISIVE_AUTHORITY_SOURCES = Object.freeze({
    event: Object.freeze(['CANONICAL_RUNTIME', 'USER_BEHAVIOR']),
    preference: Object.freeze(['EXPLICIT_USER_REPORT']),
    latent_state: Object.freeze(['EXPLICIT_USER_REPORT']),
    relational: Object.freeze(['EXPLICIT_USER_REPORT'])
  });

  /* 当前 runtime 真正具备**机械** relation 分类能力的 contradiction mode。
     其余形状需要 Evidence Matcher（P5，当前 OFF）⇒ capability gap，而不是 policy forbidden。 */
  var RUNTIME_CLASSIFIABLE_MODES = Object.freeze(['exclusive_outcome', 'window_closure_negative']);
  var EVIDENCE_MATCHER_INVOCATION = 'OFF';

  function decisiveAuthoritySourcesFor(predictionType) {
    return DECISIVE_AUTHORITY_SOURCES[text(predictionType)] || [];
  }
  function policyAllowsDecisiveFrom(predictionType, source) {
    return decisiveAuthoritySourcesFor(predictionType).indexOf(text(source)) >= 0;
  }
  function policyAllowsDecisiveSettlement(predictionType) {
    return decisiveAuthoritySourcesFor(predictionType).length > 0;
  }
  function runtimeCanClassifyMode(contradictionMode) {
    return RUNTIME_CLASSIFIABLE_MODES.indexOf(text(contradictionMode)) >= 0;
  }

  /**
   * calibrationReachability(input) —— 这个组合**是否可能**由当前 frozen P3 policy
   * 合法地产生？这是 reachability validation，**不是** settlement re-judgement：
   * 它不重算状态，只查两张已冻结的表（decisive authority sources + authority matrix）。
   */
  function calibrationReachability(input) {
    var i = isPlainObject(input) ? input : {};
    var type = text(i.predictionType);
    var domain = text(i.targetDomain);
    var state = text(i.settlementState);
    var matrix = isPlainObject(i.authorityMatrix) ? i.authorityMatrix : null;
    var out = {
      reachable: false, class: null, reasonCode: null,
      predictionType: type, targetDomain: domain, settlementState: state,
      decisiveAuthoritySources: decisiveAuthoritySourcesFor(type).slice(),
      eligibleSourcesInDomain: []
    };

    /* ① 只有 matched / missed 能 calibrationCounted=true */
    if (state !== 'matched' && state !== 'missed') {
      out.class = 'not-a-calibration-state';
      out.reasonCode = 'settlement-state-is-not-calibration-eligible';
      return out;
    }
    /* ② type 必须能产生 decisive settlement */
    if (!policyAllowsDecisiveSettlement(type)) {
      out.class = 'unreachable-policy';
      out.reasonCode = 'prediction-type-cannot-settle-decisively';
      return out;
    }
    /* ③ 分区必须可解析（域唯一） */
    if (!domain || domain === 'mixed-domains') {
      out.class = 'unreachable-partition';
      out.reasonCode = domain ? 'partition-unresolvable-multi-domain' : 'partition-unresolvable-no-domain';
      return out;
    }
    /* ④ 该 domain 下必须存在一个**既 ELIGIBLE 又被 policy 允许**的来源 */
    if (matrix) {
      var eligible = Object.keys(matrix).filter(function (s) {
        return isPlainObject(matrix[s]) && text(matrix[s][domain]) === 'ELIGIBLE';
      });
      out.eligibleSourcesInDomain = eligible.slice();
      var permitted = eligible.filter(function (s) { return policyAllowsDecisiveFrom(type, s); });
      if (permitted.length === 0) {
        out.reachable = false;
        out.class = eligible.length === 0 ? 'unreachable-matrix' : 'unreachable-policy';
        /* 这是**规范** reasonCode：capability-valid ≠ calibration-reachable */
        out.reasonCode = eligible.length === 0
          ? 'no-eligible-source-for-domain'
          : 'settlement-combination-unreachable';
        return out;
      }
    }
    /* ⑤ policy 上可达。当前 runtime 是否**具备**分类能力是另一个维度：
         · contradiction mode 必须能机械比较
         · 且该 domain 不得是"只能带 statement 载荷"的主观域
           （statement 的 support/conflict 需要 Evidence Matcher，当前 OFF）
       ⇒ 这才是 CAPABILITY_GAP，**不是** policy forbidden。 */
    var statementOnly = Array.isArray(i.statementOnlyDomains) ? i.statementOnlyDomains : [];
    var domainNeedsStatement = statementOnly.indexOf(domain) >= 0;
    var classifiable = runtimeCanClassifyMode(i.contradictionMode) && !domainNeedsStatement;
    /* P5-B · Evidence Matcher 一旦**启用**，statement 的 semantic relation 就有了
       合法来源 ⇒ 这一条 capability gap 被关闭。
       ★ 只有 "EXPLICIT_USER_REPORT + valid EvidenceMatch" 这条路径被打开：
         domain 必须仍由 provenance 决定，行为路径**不会**因此变得可达
         （`DECISIVE_AUTHORITY_SOURCES` 检查在上面已经挡住了）。 */
    var matcherEnabled = i.matcherEnabled === true;
    if (!classifiable && domainNeedsStatement && matcherEnabled) classifiable = true;
    out.reachable = true;
    out.class = classifiable ? 'reachable-now' : 'reachable-policy-only';
    out.reasonCode = classifiable ? 'ok' : 'policy-allowed-but-runtime-capability-unavailable';
    out.runtimeClassifiable = classifiable;
    out.domainRequiresStatement = domainNeedsStatement;
    out.evidenceMatcherEnabled = matcherEnabled;
    return out;
  }

  var REASON = Object.freeze({
    ok: 'ok',
    predictionMissing: 'prediction-missing',
    predictionNotOpen: 'prediction-not-open',
    predictionWithdrawn: 'prediction-withdrawn',
    alreadySettled: 'already-settled',
    revisionDetected: 'revision-detected',
    supersededByLifecycle: 'superseded-by-lifecycle',
    supersededByNewerPrediction: 'superseded-by-newer-prediction',
    noInjectedTime: 'injected-time-missing',
    observationNotBuilt: 'observation-not-built',
    observationDiscarded: 'observation-discarded-by-authority-gate',
    relationUnclassifiable: 'relation-unclassifiable-without-evidence-matcher',
    evidenceMatcherRelationApplied: 'evidence-matcher-relation-applied',
    evidenceMatcherRelationAmbiguous: 'evidence-matcher-relation-ambiguous',
    evidenceMatcherRelationRejected: 'evidence-matcher-relation-rejected',
    directionalConflictForbidden: 'directional-conflict-forbidden-cannot-produce-missed',
    evidenceSourceNotDecisiveForType: 'evidence-source-cannot-decide-this-prediction-type',
    settlementCombinationUnreachable: 'settlement-combination-unreachable',
    partitionUnresolvableMultiDomain: 'partition-unresolvable-multi-domain',
    partitionUnresolvableNoDomain: 'partition-unresolvable-no-domain',
    decisiveForbiddenUnknownAttribution: 'decisive-settlement-forbidden-unknown-behavior-effect-attribution',
    opportunityAbsent: 'opportunity-absent',
    opportunityNotConsumed: 'opportunity-not-consumed',
    opportunityUnknown: 'opportunity-unknown',
    windowOpen: 'observation-window-still-open',
    windowClosed: 'observation-window-closed',
    thresholdNotReached: 'support-threshold-not-reached',
    mixedEvidence: 'mixed-evidence-no-permitted-decisive-settlement',
    behaviourEffectObserved: 'behavior-effect-attribution-known-present',
    notIndependentConfirmation: 'self-influenced-settlement-is-not-independent-confirmation',
    calibrationCounted: 'calibration-counted',
    legacyAdapterDisabled: 'legacy-result-adapter-disabled',
    sessionOnly: 'session-only-lifetime'
  });

  /* ══════════════════════════════════════════════════════════════════
     ② 纯 helper
     ══════════════════════════════════════════════════════════════════ */

  function isPlainObject(v) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
    var proto = Object.getPrototypeOf(v);
    return proto === Object.prototype || proto === null;
  }
  function text(v) { return v == null ? '' : String(v); }
  function finiteTime(v) { var n = Number(v); return isFinite(n) && n > 0 ? n : null; }
  function canonicalize(v) {
    try {
      if (CONTRACT && typeof CONTRACT.stableStringify === 'function') return CONTRACT.stableStringify(v);
    } catch (e) { /* fall through */ }
    return JSON.stringify(v);
  }
  function deepFreeze(v) {
    if (!v || typeof v !== 'object' || Object.isFrozen(v)) return v;
    Object.freeze(v);
    Object.keys(v).forEach(function (k) { deepFreeze(v[k]); });
    return v;
  }
  function uniq(list) {
    var out = [], seen = Object.create(null);
    (Array.isArray(list) ? list : []).forEach(function (x) {
      if (x == null) return;
      var s = String(x);
      if (!s || seen[s]) return;
      seen[s] = true; out.push(s);
    });
    return out;
  }

  /* ══════════════════════════════════════════════════════════════════
     ③ 机械 relation 分类（**不调模型**）
     ══════════════════════════════════════════════════════════════════
     只有**确定可以机械比较**的形状才给出 support/conflict：
       · exclusive_outcome  —— 期望 token vs 观察 token 的**机械相等/不等**
       · window_closure_negative —— 需要 full-window-attested 的缺失 token
     其余（threshold 无数值阈值 / explicit_denial 需要语言理解）一律
     'unclassifiable' ⇒ **不产生 decisive settlement**。
     ★ 这是 P3 的诚实边界：Evidence Matcher = OFF（P5 才启用），
       因此基于 statement 的主观预测在 P3 不可能被决定性结算。 */
  /* ── P5-B3-E-R1 · 结构化偏好命题（**唯一**新增的机械可判形状）──────────
     问题：`exclusive_outcome` 的旧规则是"token 相等 ⇒ support，否则 ⇒ conflict"。
     对**自由 token** 这是对的（互斥结果）。对"用户对 X 的立场"它是**错的**：
     不同 target 会被判成 conflict ⇒ 一条关于咖啡的报告会把"喜欢科幻"的
     prediction 判成 missed。§33/§45 逐字禁止这件事。

     因此：一旦任一侧进入 `pref.` 命名空间，就必须走结构化比较
       · 两侧都必须是 canonical preference token（否则 unclassifiable）
       · target 不同            ⇒ 'irrelevant'（绝不 conflict）
       · target 同 + stance 同  ⇒ 'support'
       · target 同 + stance 反  ⇒ 'conflict'
     并且：只有 `predictionType === 'preference'` 的预测才有资格进入这个
     命名空间；其它类型的预测看到 `pref.*` token 一律 'irrelevant'
     （不是 conflict —— 那条证据根本不在讲它的事）。

     ★ fail closed：任一侧无法解析 ⇒ 'unclassifiable'，**绝不**退化成
       "不相等就是 conflict"。 */
  function isPreferenceNamespace(token) {
    return !!(PREFERENCE && typeof PREFERENCE.isPreferenceNamespace === 'function'
      && PREFERENCE.isPreferenceNamespace(token) === true);
  }
  function relatePreferenceTokens(expectedToken, observedToken) {
    if (!PREFERENCE || typeof PREFERENCE.relatePreferenceTokens !== 'function') return null;
    try { return PREFERENCE.relatePreferenceTokens(expectedToken, observedToken); } catch (e) { return null; }
  }

  function classifyRelation(prediction, observation) {
    var snap = isPlainObject(prediction) && isPlainObject(prediction.predictionSnapshotAtCreation)
      ? prediction.predictionSnapshotAtCreation : null;
    var obs = isPlainObject(observation) ? observation : null;
    if (!snap || !obs) return 'unclassifiable';
    /* 建档快照把语义放在 `semanticPayload` 里（P2 的形状）；兼容直接挂在快照上的老形状。 */
    var payload = isPlainObject(snap.semanticPayload) ? snap.semanticPayload : snap;
    var exp = isPlainObject(payload.expectedOutcome) ? payload.expectedOutcome : null;
    var ref = isPlainObject(obs.outcomeRef) ? obs.outcomeRef : null;
    if (!exp || !ref) return 'unclassifiable';
    var mode = text(prediction.contradictionMode);

    /* ① P5-B3-E-R1 · 结构化偏好命名空间（**先**于旧的相等规则判定） */
    if (mode === 'exclusive_outcome' && text(ref.kind) === 'token') {
      var wantProbe = text(exp.token);
      var gotProbe = text(ref.token);
      if (isPreferenceNamespace(wantProbe) || isPreferenceNamespace(gotProbe)) {
        if (text(prediction.predictionType) !== 'preference') return 'irrelevant';
        var structured = relatePreferenceTokens(wantProbe, gotProbe);
        return structured == null ? 'unclassifiable' : structured;
      }
    }

    if (mode === 'exclusive_outcome') {
      if (text(ref.kind) !== 'token') return 'unclassifiable';   /* statement ⇒ 需要语言 */
      var want = text(exp.token);
      if (!want) return 'unclassifiable';
      var got = text(ref.token);
      if (!got) return 'unclassifiable';
      return got === want ? 'support' : 'conflict';
    }
    if (mode === 'window_closure_negative') {
      if (text(ref.kind) !== 'token') return 'unclassifiable';
      if (text(ref.token) !== WINDOW_ABSENCE_TOKEN) return 'irrelevant';
      if (text(obs.completeness) !== 'full-window-attested') return 'unclassifiable';
      return 'conflict';
    }
    /* threshold（无数值阈值）/ explicit_denial（需语言）/ none ⇒ 不可机械判 */
    return 'unclassifiable';
  }

  function confidenceBucketOf(value) {
    if (value == null) return 'unstated';
    var n = Number(value);
    if (!isFinite(n)) return 'unstated';
    if (n <= 0.34) return 'low';
    if (n <= 0.66) return 'medium';
    return 'high';
  }

  /* ══════════════════════════════════════════════════════════════════
     ④ ordinal Prediction Error（查表；模型不参与）
     ══════════════════════════════════════════════════════════════════ */
  function computePredictionError(settlementState, confidenceBucket) {
    var st = SETTLEMENT_STATES.indexOf(text(settlementState)) >= 0 ? text(settlementState) : null;
    var cb = CONFIDENCE_BUCKETS.indexOf(text(confidenceBucket)) >= 0 ? text(confidenceBucket) : 'unstated';
    var row = st ? PE_TABLE[st] : null;
    var cell = row ? row[cb] : null;
    if (!cell) {
      return {
        direction: 'unknown', magnitude: 'unknown',
        predictionErrorMetric: PREDICTION_ERROR_METRIC,
        confidenceBucket: cb, settlementState: st,
        reasonCodes: ['prediction-error-unknown-state']
      };
    }
    return {
      direction: cell.direction,
      magnitude: cell.magnitude,
      /* ★ 恒为 null：v1 只有 ordinal，没有冻结的连续公式 ⇒ 不给 0.63 这种数字 */
      predictionErrorMetric: PREDICTION_ERROR_METRIC,
      confidenceBucket: cb,
      settlementState: st,
      reasonCodes: [
        'ordinal-only-no-numeric-metric',
        directionReason(cell.direction, cb, st)
      ]
    };
  }
  function directionReason(direction, cb, st) {
    if (direction === 'over-confident') return 'high-confidence-prediction-missed';
    if (direction === 'under-confident') return 'low-confidence-prediction-matched';
    if (direction === 'calibrated') return 'confidence-consistent-with-outcome';
    return 'direction-unknown-do-not-guess';
  }

  /* ══════════════════════════════════════════════════════════════════
     ⑤ T8：**有序**判定（先命中先返回 ⇒ TOTAL FUNCTION）
     ══════════════════════════════════════════════════════════════════ */
  function deriveOpportunityFromGates(required, gates, prediction) {
    if (required !== true) return 'NOT-REQUIRED';
    var seen = { SATISFIED: false, ABSENT: false, 'NOT-CONSUMED': false };
    for (var i = 0; i < gates.length; i++) {
      var s = text(gates[i] && gates[i].opportunityGate);
      if (s === 'SATISFIED') seen.SATISFIED = true;
      else if (s === 'ABSENT') seen.ABSENT = true;
      else if (s === 'NOT-CONSUMED') seen['NOT-CONSUMED'] = true;
    }
    if (seen.SATISFIED) return 'SATISFIED';
    if (seen.ABSENT) return 'ABSENT';
    if (seen['NOT-CONSUMED']) return 'NOT-CONSUMED';
    void prediction;
    return 'UNKNOWN';
  }

  function t8State(counts, windowClosed, opportunityState) {
    /* 1 · 允许的 decisive conflict ⇒ missed */
    if (counts.conflictDecisive >= 1) return 'missed';
    /* 2 · 支持达门槛 **且** 没有任何 opposing 证据 ⇒ matched */
    if (counts.supportDecisive >= counts.supportThreshold && counts.conflictAll === 0) return 'matched';
    /* 3 · 双向都有可采证据且没有形成允许的 decisive settlement ⇒ mixed */
    if (counts.supportAll > 0 && counts.conflictAll > 0) return 'mixed';
    /* 4 · 单向次门槛 ⇒ 窗口关则 unresolvable，否则 pending */
    if (counts.supportAll > 0 || counts.conflictAll > 0) return windowClosed ? 'unresolvable' : 'pending';
    /* 5 · 没有任何可采证据 ⇒ 看机会与窗口 */
    if (!windowClosed) return 'pending';
    if (opportunityState === 'ABSENT' || opportunityState === 'NOT-CONSUMED') return 'expired_unobserved';
    return 'unresolvable';
  }

  /* ══════════════════════════════════════════════════════════════════
     ⑥ 结算主体：T0 / T7 / T8
     ══════════════════════════════════════════════════════════════════ */

  /**
   * computeSettlement(input)
   *   input = {
   *     prediction,        PredictionRecord（**已冻结**）
   *     observations,      [ { observation, gate } ] —— gate 来自 P1 authorityGate
   *     now,               注入时间
   *     snapshotAtSettlement（可选）—— P3 用来检测"预测被修订过"
   *     supersededByNewer   bool（可选）—— 由 Registry 的 supersede 事实提供
   *   }
   * 返回 { ok, state, lifecycleState, reasonCodes, trace, calibrationCounted }
   */
  function computeSettlement(input) {
    var i = isPlainObject(input) ? input : {};
    var p = isPlainObject(i.prediction) ? i.prediction : null;
    var now = finiteTime(i.now);
    var reasons = [];
    var trace = {
      predictionId: p ? text(p.predictionId) : null,
      predictionType: p ? text(p.predictionType) : null,
      contradictionMode: p ? text(p.contradictionMode) : null,
      gatesSeen: 0, admitted: 0, discarded: 0,
      supportDecisive: 0, supportNonDecisive: 0,
      conflictDecisive: 0, conflictNonDecisive: 0,
      policyNonDecisive: 0,
      matcherRelationsApplied: 0, matcherRelationsAmbiguous: 0, matcherRelationsRejected: 0,
      unclassifiable: 0, irrelevant: 0,
      opportunityState: null, windowClosed: null,
      decisiveForbiddenUnknownAttribution: false,
      attributionStatus: p ? text(p.behaviorEffectAttributionStatus) : null
    };

    /* T0 · prediction 存在且 open */
    if (!p) return { ok: false, state: null, lifecycleState: null, reasonCodes: [REASON.predictionMissing], trace: trace, calibrationCounted: false };
    if (now == null) return { ok: false, state: null, lifecycleState: null, reasonCodes: [REASON.noInjectedTime], trace: trace, calibrationCounted: false };
    if (text(p.lifecycleState) === 'withdrawn') {
      return { ok: false, state: null, lifecycleState: 'withdrawn', reasonCodes: [REASON.predictionWithdrawn], trace: trace, calibrationCounted: false };
    }

    /* T7 · 修订 / 取代 —— **优先于** T8 的一切判定 */
    var revisionDetected = false;
    if (i.snapshotAtSettlement != null) {
      revisionDetected = canonicalize(i.snapshotAtSettlement) !== canonicalize(p.predictionSnapshotAtCreation);
    }
    if (text(p.lifecycleState) === 'superseded' || i.supersededByNewer === true || revisionDetected) {
      reasons.push(text(p.lifecycleState) === 'superseded'
        ? REASON.supersededByLifecycle
        : (revisionDetected ? REASON.revisionDetected : REASON.supersededByNewerPrediction));
      reasons.push(REASON.legacyAdapterDisabled);
      return {
        ok: true, state: 'superseded', lifecycleState: 'settled',
        reasonCodes: uniq(reasons), trace: trace, calibrationCounted: false,
        /* 形状必须与普通路径一致（消费方不应为早退分支写特例） */
        counts: {
          supportDecisive: 0, supportNonDecisive: 0, conflictDecisive: 0,
          conflictNonDecisive: 0, supportAll: 0, conflictAll: 0, supportThreshold: 1
        },
        observationRefs: [], evidenceRefs: [], gateTraceRefs: [],
        admittedTargetDomains: [],
        opportunityState: 'UNKNOWN', selfInfluenced: false,
        revisionDetected: revisionDetected
      };
    }

    /* T1–T6 · 由 authority gate 承担：本引擎**只消费**它的输出，绝不重判 */
    var threshold = 1;   /* v1：所有类型的 supportThreshold = 1（见 P2 POLICY_TABLE） */
    var gates = [];
    var obsList = Array.isArray(i.observations) ? i.observations : [];
    var counts = {
      supportDecisive: 0, supportNonDecisive: 0, conflictDecisive: 0, conflictNonDecisive: 0,
      supportAll: 0, conflictAll: 0, supportThreshold: threshold
    };
    var observationRefs = [];
    var evidenceRefs = [];
    var gateTraceRefs = [];
    var admittedTargetDomains = [];
    /* ── P5-B · Evidence Matcher 提供的 semantic relation ────────────────
       **只**接受闭集内的 relation，**只**按 observationId 索引。
       这是唯一的 capability gap 替换点：机械分类做不到时**才**用它。
       ★ 它**不**携带 source / domain / predictionType / 结算状态 ——
         那些仍然全部由本引擎重新判定。 */
    var matchByObs = Object.create(null);
    (Array.isArray(i.evidenceMatches) ? i.evidenceMatches : []).forEach(function (m) {
      if (!isPlainObject(m)) return;
      var id = text(m.observationId);
      var rel = text(m.relation);
      if (!id) return;
      if (MATCHER_RELATIONS.indexOf(rel) < 0) {
        trace.matcherRelationsRejected += 1;
        reasons.push(REASON.evidenceMatcherRelationRejected);
        return;
      }
      matchByObs[id] = rel;
    });
    for (var k = 0; k < obsList.length; k++) {
      var entry = isPlainObject(obsList[k]) ? obsList[k] : null;
      var gateIn = entry && isPlainObject(entry.gate) ? entry.gate : null;
      var obs = entry && isPlainObject(entry.observation) ? entry.observation : null;
      trace.gatesSeen += 1;
      /* 归一：authority gate 的**结果**（{ok, gateTrace}）与**trace 本身**都接受。
         trace 自带 effectiveAdmissibility 时视为已成功计算。 */
      var gate = null, gateOk = false;
      if (gateIn) {
        if (isPlainObject(gateIn.gateTrace)) { gate = gateIn.gateTrace; gateOk = gateIn.ok === true; }
        else if (gateIn.effectiveAdmissibility != null) { gate = gateIn; gateOk = true; }
      }
      if (!gateOk || !gate || !obs) { trace.discarded += 1; reasons.push(REASON.observationNotBuilt); continue; }      gates.push({ opportunityGate: text(gate.opportunityGate) });
      gateTraceRefs.push({
        observationId: text(obs.observationId),
        targetDomain: text(obs.targetDomain),
        ceiling: gate.ceiling == null ? null : text(gate.ceiling),
        effective: text(gate.effectiveAdmissibility),
        support: text(gate.directional && gate.directional.support),
        conflict: text(gate.directional && gate.directional.conflict),
        opportunityGate: text(gate.opportunityGate),
        contaminationGate: text(gate.contaminationGate)
      });
      observationRefs.push(text(obs.observationId));
      (Array.isArray(obs.evidenceRefs) ? obs.evidenceRefs : []).forEach(function (r) { evidenceRefs.push(text(r)); });

      var relation = classifyRelation(p, obs);
      if (relation === 'unclassifiable') {
        /* P5-B：机械分类做不到 ⇒ 若有一个 sealed matcher relation，就用它。
           **只有** relation 参与；authority 全部照旧重新判定。 */
        var supplied = matchByObs[text(obs.observationId)];
        if (supplied) {
          if (supplied === 'ambiguous') {
            trace.matcherRelationsAmbiguous += 1;
            trace.unclassifiable += 1;
            reasons.push(REASON.evidenceMatcherRelationAmbiguous);
            continue;
          }
          relation = supplied;
          trace.matcherRelationsApplied += 1;
          reasons.push(REASON.evidenceMatcherRelationApplied);
        }
      }
      if (relation === 'irrelevant') { trace.irrelevant += 1; continue; }
      if (relation === 'unclassifiable') {
        trace.unclassifiable += 1;
        reasons.push(REASON.relationUnclassifiable);
        continue;
      }
      var adm = relation === 'support'
        ? text(gate.directional && gate.directional.support)
        : text(gate.directional && gate.directional.conflict);
      if (adm === 'FORBIDDEN') {
        trace.discarded += 1;
        reasons.push(relation === 'conflict' ? REASON.directionalConflictForbidden : REASON.observationDiscarded);
        continue;
      }
      if (adm === 'CANDIDATE') { trace.discarded += 1; reasons.push(REASON.observationDiscarded); continue; }
      trace.admitted += 1;
      admittedTargetDomains.push(text(obs.targetDomain));
      /* ★ 来源是否**有资格决定**这个 type 的结算（decisive authority sources）。
         `ELIGIBLE` 只说明"看得见"，不说明"能定案"：
         preference/latent_state/relational 的行为证据永远只能是 non-decisive。 */
      var policyDecisive = policyAllowsDecisiveFrom(text(p.predictionType), text(obs.source));
      if (!policyDecisive) {
        trace.policyNonDecisive += 1;
        reasons.push(REASON.evidenceSourceNotDecisiveForType);
      }
      var isDecisive = adm === 'ELIGIBLE' && policyDecisive;
      if (relation === 'support') {
        counts.supportAll += 1;
        if (isDecisive) counts.supportDecisive += 1; else counts.supportNonDecisive += 1;
      } else {
        counts.conflictAll += 1;
        if (isDecisive) counts.conflictDecisive += 1; else counts.conflictNonDecisive += 1;
      }
    }

    /* ── P3.0 · attribution unknown ≠ none ───────────────────────────────
       主观域 + 归因 unknown ⇒ **禁止** decisive settlement（fail closed）。
       把 decisive 降级为 non-decisive —— 它仍然被**记录**，只是不能结算。 */
    var subjective = SUBJECTIVE_TYPES.indexOf(text(p.predictionType)) >= 0;
    var attributionStatus = text(p.behaviorEffectAttributionStatus);
    var decisiveForbidden = subjective && attributionStatus === 'unknown';
    trace.decisiveForbiddenUnknownAttribution = decisiveForbidden;
    if (decisiveForbidden) {
      reasons.push(REASON.decisiveForbiddenUnknownAttribution);
      counts.supportNonDecisive += counts.supportDecisive; counts.supportDecisive = 0;
      counts.conflictNonDecisive += counts.conflictDecisive; counts.conflictDecisive = 0;
    }

    /* ── opportunity / window ── */
    var opportunityRequired = !!(p.opportunity && p.opportunity.required === true);
    var opportunityState = deriveOpportunityFromGates(opportunityRequired, gates, p);
    var closesAt = finiteTime(p.observationWindow && p.observationWindow.closesAt);
    var windowClosed = closesAt != null && now >= closesAt;
    trace.opportunityState = opportunityState;
    trace.windowClosed = windowClosed;
    /* trace 与 counts 必须一致（可复算性要求 trace 反映**最终**计数） */
    trace.supportDecisive = counts.supportDecisive;
    trace.supportNonDecisive = counts.supportNonDecisive;
    trace.conflictDecisive = counts.conflictDecisive;
    trace.conflictNonDecisive = counts.conflictNonDecisive;

    var state = t8State(counts, windowClosed, opportunityState);
    if (state === 'missed') reasons.push('permitted-decisive-conflict');
    if (state === 'matched') reasons.push('support-threshold-reached-no-opposing-evidence');
    if (state === 'mixed') reasons.push(REASON.mixedEvidence);
    if (state === 'pending') reasons.push(REASON.windowOpen);
    if (state === 'unresolvable') reasons.push(REASON.thresholdNotReached);
    if (state === 'expired_unobserved') {
      reasons.push(REASON.windowClosed, opportunityState === 'ABSENT' ? REASON.opportunityAbsent : REASON.opportunityNotConsumed);
    }
    if (opportunityState === 'UNKNOWN') reasons.push(REASON.opportunityUnknown);

    /* ── calibration 记数资格（**只算不写**）─────────────────────────── */
    var effects = Array.isArray(p.behaviorEffectsInForce) ? p.behaviorEffectsInForce : [];
    var selfInfluenced = effects.length > 0 || attributionStatus === 'known-present';
    var calibrationCounted = (state === 'matched' || state === 'missed') && !selfInfluenced;
    if (selfInfluenced) reasons.push(REASON.behaviourEffectObserved, REASON.notIndependentConfirmation);
    if (calibrationCounted) reasons.push(REASON.calibrationCounted);
    reasons.push(REASON.legacyAdapterDisabled, REASON.sessionOnly);

    /* T8-TOTALITY 自检：必须恰好落在**一个** canonical 状态上。
       这里**没有** "else unknown" 兜底 —— 落不到七状态之一就是引擎缺陷。 */
    if (SETTLEMENT_STATES.indexOf(state) < 0) {
      return {
        ok: false, state: null, lifecycleState: null,
        reasonCodes: ['t8-not-total'], trace: trace, calibrationCounted: false
      };
    }

    return {
      ok: true,
      state: state,
      lifecycleState: state === 'pending' ? 'open' : 'settled',
      reasonCodes: uniq(reasons),
      trace: trace,
      counts: counts,
      observationRefs: uniq(observationRefs),
      evidenceRefs: uniq(evidenceRefs),
      gateTraceRefs: gateTraceRefs,
      admittedTargetDomains: uniq(admittedTargetDomains),
      opportunityState: opportunityState,
      calibrationCounted: calibrationCounted,
      selfInfluenced: selfInfluenced,
      revisionDetected: revisionDetected
    };
  }

  return {
    computeSettlement: computeSettlement,
    computePredictionError: computePredictionError,
    classifyRelation: classifyRelation,
    /* P5-B3-E-R1 · 结构化偏好命题（唯一出处 = preference-proposition-core.js） */
    PREFERENCE: PREFERENCE,
    isPreferenceNamespace: isPreferenceNamespace,
    relatePreferenceTokens: relatePreferenceTokens,
    confidenceBucketOf: confidenceBucketOf,
    t8State: t8State,
    deriveOpportunityFromGates: deriveOpportunityFromGates,
    canonicalize: canonicalize,
    /* P4-R1 · 共享 policy / reachability primitive（one table, multiple consumers） */
    decisiveAuthoritySourcesFor: decisiveAuthoritySourcesFor,
    policyAllowsDecisiveFrom: policyAllowsDecisiveFrom,
    policyAllowsDecisiveSettlement: policyAllowsDecisiveSettlement,
    runtimeCanClassifyMode: runtimeCanClassifyMode,
    calibrationReachability: calibrationReachability,

    SCHEMA_VERSION: SCHEMA_VERSION,
    PE_SCHEMA_VERSION: PE_SCHEMA_VERSION,
    ID_PREFIX: ID_PREFIX,
    PE_ID_PREFIX: PE_ID_PREFIX,
    ID_LIFETIME: ID_LIFETIME,
    SETTLEMENT_STATES: SETTLEMENT_STATES,
    TERMINAL_STATES: TERMINAL_STATES,
    LEGACY_RESULTS: LEGACY_RESULTS,
    LEGACY_RESULT_ADAPTER: LEGACY_RESULT_ADAPTER,
    SUBJECTIVE_TYPES: SUBJECTIVE_TYPES,
    MECHANISM_TYPES: MECHANISM_TYPES,
    CONFIDENCE_BUCKETS: CONFIDENCE_BUCKETS,
    DIRECTIONS: DIRECTIONS,
    MAGNITUDES: MAGNITUDES,
    MECHANICAL_RELATIONS: MECHANICAL_RELATIONS,
    MATCHER_RELATIONS: MATCHER_RELATIONS,
    EVIDENCE_MATCHER_ROLE: EVIDENCE_MATCHER_ROLE,
    OPPORTUNITY_STATES: OPPORTUNITY_STATES,
    PE_TABLE: PE_TABLE,
    PREDICTION_ERROR_METRIC: PREDICTION_ERROR_METRIC,
    WINDOW_ABSENCE_TOKEN: WINDOW_ABSENCE_TOKEN,
    DECISIVE_AUTHORITY_SOURCES: DECISIVE_AUTHORITY_SOURCES,
    RUNTIME_CLASSIFIABLE_MODES: RUNTIME_CLASSIFIABLE_MODES,
    EVIDENCE_MATCHER_INVOCATION: EVIDENCE_MATCHER_INVOCATION,
    REASON: REASON,

    STATE_SUPPORT: Object.freeze({
      settlementEngine: 'PURE_STATE_MACHINE',
      states: 7,
      legacyResultAdapter: LEGACY_RESULT_ADAPTER,
      predictionError: 'ORDINAL_ONLY',
      predictionErrorMetric: null,
      evidenceMatcherInvocation: 'OFF',
      relationClassification: 'MECHANICAL_ONLY',
      /* P5-B3-E-R1：第一条**主观域**的机械可判形状 —— 结构化偏好命题。
         它不需要 Evidence Matcher（token 对 token 是机械可判的），
         而 statement 载荷仍然需要（见下一行，未变）。 */
      structuredPreferenceRelation: 'MECHANICAL_TOKEN_PROPOSITION',
      structuredPreferenceRelationRequiresMatcher: 'NO',
      statementRelationRequires: 'EVIDENCE_MATCHER_P5',
      statementRelationSource: 'SEALED_EVIDENCE_MATCH_RELATION_ONLY',
      matcherMaySupplyRelation: 'YES',
      matcherMaySupplyAuthority: 'NO',
      matcherMayAssignSettlementState: 'NO',
      decisiveAuthoritySourcesTable: 'DECISIVE_AUTHORITY_SOURCES',
      p4ReachabilityGate: 'SHARED_PRIMITIVE_NOT_DUPLICATED',
      decisiveSettlementForbiddenWhenAttributionUnknown: 'YES',
      directionalAuthorityConsumedNotReinvented: 'YES',
      calibrationWriteback: 'NONE',
      memoryAuthority: 'NONE',
      relationshipAuthority: 'NONE',
      modelCalls: 0,
      durableWrites: 0,
      clockReads: 0
    })
  };
});
