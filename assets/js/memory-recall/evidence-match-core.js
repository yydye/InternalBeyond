/* ====================================================================
   IB Memory · Evidence Match Core（Prediction Error P5-B）
   --------------------------------------------------------------------
   ADVISORY SEMANTIC CLASSIFIER ONLY

   它**只**回答一个问题：这段 statement evidence 与这条 Prediction
   在语义上是什么关系？

     relation ∈ { support, conflict, irrelevant, ambiguous }

   ── 它**绝对没有**的能力 ─────────────────────────────────────────────
     source authority · domain authority · predictionType authority ·
     admissibility authority · opportunity authority · settlement authority ·
     calibration authority · memory / relationship authority。

   核心 invariant（出现即拒绝）：

     LLM says conflict  →  missed            ← **禁止**的短路
     model 输出 source / targetDomain / predictionType / settlementState /
                 validated / settleable / calibrationCounted / confidence
                                            ← 一律 strip + 具名 reason

   本文件是**纯核心**：零 I/O · 零网络 · 零模型调用 · 零时钟 · 零随机 ·
   零 durable 写。模型调用只在 runtime-evidence-matcher.js 里发生一次。
   ==================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    var memoryContract = null;
    try { memoryContract = require('../memory-contract.js'); } catch (e) { memoryContract = null; }
    module.exports = factory(memoryContract);
  } else {
    root.IBMemoryEvidenceMatch = factory(root.IBMemoryContract || null);
  }
})(typeof self !== 'undefined' ? self : this, function (CONTRACT) {
  'use strict';

  var SCHEMA_VERSION = 'evidence-match/v1';
  var MATCHER_VERSION = 'evidence-matcher/1';
  var RELATION_AUTHORITY = 'ADVISORY_ONLY';
  var MATCHER_ROLE = 'ADVISORY_SEMANTIC_CLASSIFIER_ONLY';
  var ID_LIFETIME = 'SESSION_ONLY';

  /* ══════════════════════════════════════════════════════════════════
     ① 冻结词表
     ══════════════════════════════════════════════════════════════════ */

  /* **唯一**允许的 relation 闭集（四个，全部 first-class）。 */
  var RELATIONS = Object.freeze(['support', 'conflict', 'irrelevant', 'ambiguous']);
  /* 模型失败时的唯一去向 —— **绝不**是 support/conflict。 */
  var FAILURE_RELATION = 'ambiguous';

  /* strengthHint：**只**是审计线索，不参与任何阈值（STRENGTH_HINT_AUTHORITY = NONE）。 */
  var STRENGTH_HINTS = Object.freeze(['weak', 'moderate', 'strong', 'unspecified']);
  var STRENGTH_HINT_AUTHORITY = 'NONE';

  /* 模型输出里**禁止**出现的键。出现即 strip + 具名 reason（绝不静默接受）。 */
  var FORBIDDEN_OUTPUT_KEYS = Object.freeze([
    /* 结算状态 */
    'matched', 'missed', 'mixed', 'expired_unobserved', 'unresolvable', 'superseded',
    'settlementState', 'state', 'lifecycleState', 'predictionError',
    /* legacy D.2 */
    'confirmed', 'contradicted', 'partial', 'ambiguousResult',
    /* 自证 / 越权 */
    'validated', 'settleable', 'calibrationCounted', 'sealed',
    /* authority 覆盖 */
    'predictionType', 'targetDomain', 'source', 'sourceInstance', 'admissibility',
    'authorityLevel', 'directional', 'opportunity', 'contamination',
    /* 伪精度 */
    'confidence', 'probability', 'score', 'weight', 'predictionErrorMetric'
  ]);

  /* 允许的**输出**键（其余一律 strip）。 */
  var ALLOWED_OUTPUT_KEYS = Object.freeze([
    'relation', 'strengthHint', 'rationale', 'evidenceRefs', 'matcherVersion'
  ]);

  /* ── R5 · `buildMatcherInput` 的**顶层键**（机械冻结，不许再口头数错）──
     code / test / contract / report 必须一致：**5** 个。
     （之前报告写"four top-level keys"却列出五个 —— 那是**报告**笔误，
       实现、测试、契约都是五个。此处把它变成可断言常量。） */
  var MATCHER_INPUT_TOP_LEVEL_KEYS = Object.freeze([
    'schemaVersion', 'predictionId', 'prediction', 'observation', 'scope'
  ]);
  var MATCHER_INPUT_TOP_LEVEL_KEY_COUNT = MATCHER_INPUT_TOP_LEVEL_KEYS.length;

  /* ── R1 · 三层 capability 词表 ────────────────────────────────────── */
  var CAPABILITY_GAP_REASONS = Object.freeze([
    'matcher-not-present',
    'matcher-disabled',
    'statement-relation-unavailable',
    'attribution-unknown',
    'policy-forbidden',
    'source-not-decisive',
    'no-eligible-sample'
  ]);

  /* ── R4 · 调用预算默认值（system config 才是 authority）────────────── */
  var DEFAULT_BUDGET = Object.freeze({
    maxMatcherCallsPerSettlementAttempt: 4,
    maxMatcherCallsPerPrediction: 4,
    maxMatcherCallsPerTurn: 8
  });

  /* ── R3 · bounded memo 默认值 ─────────────────────────────────────── */
  var DEFAULT_HOLDER = Object.freeze({
    maxEntries: 256,
    ttlMs: 10 * 60 * 1000,
    lifetime: 'SESSION_ONLY',
    durability: 'NONE'
  });

  var BOUNDS = Object.freeze({
    MAX_RATIONALE_CHARS: 280,
    MAX_EVIDENCE_REFS: 8,
    MAX_REF_ID_CHARS: 180,
    MAX_STATEMENT_CHARS: 600,
    MAX_PREDICTION_TEXT_CHARS: 280,
    MAX_LABEL_CHARS: 120
  });

  var REASON = Object.freeze({
    ok: 'ok',
    invalidOutput: 'matcher-invalid-output',
    unknownRelation: 'matcher-unknown-relation',
    forbiddenField: 'matcher-forbidden-field',
    emptyResult: 'matcher-empty-result',
    malformedRefs: 'matcher-malformed-evidence-refs',
    inventedRef: 'matcher-invented-evidence-ref',
    oversizedRationale: 'matcher-oversized-rationale',
    timeout: 'matcher-timeout',
    providerError: 'matcher-provider-error',
    transportError: 'matcher-transport-error',
    unavailable: 'matcher-unavailable',
    disabled: 'matcher-disabled',
    notANeed: 'mechanical-relation-available',
    strengthHintIgnored: 'strength-hint-is-advisory-only',
    advisoryOnly: 'relation-is-advisory-only',
    /* R4 */
    budgetExhausted: 'matcher-budget-exhausted',
    /* R3 */
    memoizedSuccess: 'matcher-memo-reuse-success',
    memoizedFailure: 'matcher-memo-reuse-failure'
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
  function clip(v, n) { var s = text(v); return s.length > n ? s.slice(0, n) : s; }
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
  function isRelation(v) { return RELATIONS.indexOf(text(v)) >= 0; }

  /* ══════════════════════════════════════════════════════════════════
     ③ 是否需要 matcher（MUST deterministic）
     ══════════════════════════════════════════════════════════════════
     机械可判的形状**绝不**进模型：token 比较一律 OFF。 */
  function needsEvidenceMatcher(prediction, observation) {
    var snap = isPlainObject(prediction) && isPlainObject(prediction.predictionSnapshotAtCreation)
      ? prediction.predictionSnapshotAtCreation : null;
    var obs = isPlainObject(observation) ? observation : null;
    if (!snap || !obs) return { needed: false, reasonCode: 'input-incomplete' };
    var ref = isPlainObject(obs.outcomeRef) ? obs.outcomeRef : null;
    if (!ref) return { needed: false, reasonCode: 'input-incomplete' };
    /* ① 机械可判：token 对 token ⇒ 永不需要模型 */
    if (text(ref.kind) === 'token') {
      return { needed: false, reasonCode: REASON.notANeed, mechanical: true };
    }
    /* ② statement：需要语义分类 */
    if (text(ref.kind) === 'statement') {
      return { needed: true, reasonCode: 'statement-requires-semantic-classification', mechanical: false };
    }
    return { needed: false, reasonCode: 'unsupported-outcome-ref-kind' };
  }

  /* ══════════════════════════════════════════════════════════════════
     ④ 输入最小化（MINIMUM_CONTEXT_MATCHING = YES）
     ══════════════════════════════════════════════════════════════════ */
  /**
   * buildMatcherInput(prediction, observation)
   *   **只**包含完成 semantic relation classification 所必需的最小上下文。
   *   MUST NOT：完整对话历史 / Memory 全量 / relationship state /
   *             完整 system prompt / 凭据。
   */
  function buildMatcherInput(prediction, observation) {
    var snap = isPlainObject(prediction) ? prediction.predictionSnapshotAtCreation : null;
    if (!isPlainObject(snap) || !isPlainObject(observation)) return null;
    var payload = isPlainObject(snap.semanticPayload) ? snap.semanticPayload : {};
    var subject = isPlainObject(payload.subject) ? payload.subject : {};
    var predicate = isPlainObject(payload.predicate) ? payload.predicate : {};
    var outcome = isPlainObject(payload.expectedOutcome) ? payload.expectedOutcome : {};
    var ref = isPlainObject(observation.outcomeRef) ? observation.outcomeRef : {};
    var window = isPlainObject(prediction.observationWindow) ? prediction.observationWindow : {};
    return deepFreeze({
      schemaVersion: SCHEMA_VERSION,
      predictionId: text(prediction.predictionId),
      prediction: {
        predictionType: text(snap.predictionType),
        subjectKind: text(subject.kind),
        subjectLabel: clip(subject.label, BOUNDS.MAX_LABEL_CHARS),
        predicateKind: text(predicate.kind),
        expectedOutcomeKind: text(outcome.kind),
        expectedOutcomeToken: clip(outcome.token, BOUNDS.MAX_LABEL_CHARS),
        contradictionMode: text(snap.contradictionMode),
        text: clip(payload.prediction, BOUNDS.MAX_PREDICTION_TEXT_CHARS),
        /* temporal framing：让 "我以前喜欢 A" 不被误判成 support 当前预测 */
        temporalFrame: {
          opensAt: Number(window.opensAt) || null,
          closesAt: Number(window.closesAt) || null,
          windowKind: text(window.windowKind)
        }
      },
      observation: {
        observationId: text(observation.observationId),
        /* source / targetDomain **只读**传入，用于让模型理解语境；
           它们**不在**输出 schema 里，模型无法改写。 */
        source: text(observation.source),
        targetDomain: text(observation.targetDomain),
        outcomeRefKind: text(ref.kind),
        statement: clip(ref.statement, BOUNDS.MAX_STATEMENT_CHARS),
        completeness: text(observation.completeness)
      },
      scope: {
        characterId: text(prediction.scope && prediction.scope.characterId),
        subjectKind: text(prediction.scope && prediction.scope.subjectKind),
        subjectLabel: clip(prediction.scope && prediction.scope.subjectLabel, BOUNDS.MAX_LABEL_CHARS)
      }
    });
  }

  /* ══════════════════════════════════════════════════════════════════
     ⑤ 严格解析（fail-closed）
     ══════════════════════════════════════════════════════════════════ */
  /**
   * parseMatcherOutput(raw, { allowedEvidenceRefs })
   *   任何异常形态 ⇒ relation = 'ambiguous' + 具名 reason。
   *   **绝不** failure → support / conflict。
   */
  function parseMatcherOutput(raw, options) {
    var o = isPlainObject(options) ? options : {};
    var allowedRefs = Array.isArray(o.allowedEvidenceRefs) ? o.allowedEvidenceRefs.map(text) : [];
    var reasons = [];
    var stripped = [];
    function fail(code) {
      return {
        ok: false, relation: FAILURE_RELATION, failure: true,
        strengthHint: 'unspecified', rationale: '', evidenceRefs: [],
        strippedKeys: stripped, reasonCodes: [code].concat(reasons)
      };
    }
    var obj = raw;
    if (typeof raw === 'string') {
      var s = raw.trim();
      if (!s) return fail(REASON.emptyResult);
      try { obj = JSON.parse(s); } catch (e) { return fail(REASON.invalidOutput); }
      /* 有些端口会把 JSON 包在代码围栏里 —— 只接受纯 JSON，不做宽容解析 */
    }
    if (obj == null) return fail(REASON.emptyResult);
    if (Array.isArray(obj)) return fail(REASON.invalidOutput);
    /* 有些端口把结果包在 { result: {...} } 里：只解一层，仍要求内部是纯对象 */
    if (isPlainObject(obj) && isPlainObject(obj.result)) obj = obj.result;
    if (!isPlainObject(obj)) return fail(REASON.invalidOutput);
    if (Object.keys(obj).length === 0) return fail(REASON.emptyResult);

    /* ① 禁止键：strip + **具名** reason（出现即整体降级为 ambiguous） */
    Object.keys(obj).forEach(function (k) {
      if (FORBIDDEN_OUTPUT_KEYS.indexOf(k) >= 0) { stripped.push(k); }
    });
    if (stripped.length) reasons.push(REASON.forbiddenField);
    /* ② 未知 relation */
    if (!isRelation(obj.relation)) {
      reasons.push(REASON.unknownRelation);
      return {
        ok: false, relation: FAILURE_RELATION, failure: true,
        strengthHint: 'unspecified', rationale: '', evidenceRefs: [],
        strippedKeys: stripped, reasonCodes: reasons
      };
    }
    /* ③ rationale 边界：超长**必须** fail-closed（不静默截断后放行） */
    var rationale = text(obj.rationale);
    if (rationale.length > BOUNDS.MAX_RATIONALE_CHARS) {
      reasons.push(REASON.oversizedRationale);
      rationale = rationale.slice(0, BOUNDS.MAX_RATIONALE_CHARS);
    }
    /* ④ evidenceRefs：只能引用输入给的 refs */
    var refs = [];
    if (obj.evidenceRefs !== undefined) {
      if (!Array.isArray(obj.evidenceRefs)) {
        reasons.push(REASON.malformedRefs);
      } else {
        for (var i = 0; i < obj.evidenceRefs.length; i++) {
          var r = text(obj.evidenceRefs[i]);
          if (!r || r.length > BOUNDS.MAX_REF_ID_CHARS) { reasons.push(REASON.malformedRefs); continue; }
          if (allowedRefs.length && allowedRefs.indexOf(r) < 0) { reasons.push(REASON.inventedRef); continue; }
          if (refs.length < BOUNDS.MAX_EVIDENCE_REFS) refs.push(r);
        }
      }
    }
    /* ⑤ strengthHint：闭集外 ⇒ unspecified（**不**当作权威，也**不**失败） */
    var strength = STRENGTH_HINTS.indexOf(text(obj.strengthHint)) >= 0 ? text(obj.strengthHint) : 'unspecified';

    /* 任何 forbidden / 结构性 reason ⇒ 仍然降级为 ambiguous（fail-closed） */
    var structural = reasons.filter(function (x) {
      return x === REASON.forbiddenField || x === REASON.malformedRefs
        || x === REASON.inventedRef || x === REASON.oversizedRationale;
    });
    if (structural.length) {
      return {
        ok: false, relation: FAILURE_RELATION, failure: true,
        strengthHint: strength, rationale: rationale, evidenceRefs: [],
        strippedKeys: stripped, reasonCodes: reasons
      };
    }
    return {
      ok: true, relation: text(obj.relation), failure: false,
      strengthHint: strength, rationale: rationale, evidenceRefs: refs,
      strippedKeys: stripped,
      reasonCodes: (stripped.length ? [REASON.forbiddenField] : []).concat([REASON.advisoryOnly])
    };
  }

  /* ══════════════════════════════════════════════════════════════════
     ⑥ 构建规范化 EvidenceMatch（**未经** seal 的纯数据）
     ══════════════════════════════════════════════════════════════════
     真正的 capability seal 由 **runtime-evidence-matcher.js** 打上：
     纯核心不持有身份表（否则浏览器载入的核心也能 mint 权威）。 */
  function buildMatcherPayload(parsed, input) {
    var p = isPlainObject(parsed) ? parsed : null;
    if (!p) return null;
    return deepFreeze({
      schemaVersion: SCHEMA_VERSION,
      matcherVersion: MATCHER_VERSION,
      relation: isRelation(p.relation) ? text(p.relation) : FAILURE_RELATION,
      strengthHint: STRENGTH_HINTS.indexOf(text(p.strengthHint)) >= 0 ? text(p.strengthHint) : 'unspecified',
      rationale: clip(p.rationale, BOUNDS.MAX_RATIONALE_CHARS),
      evidenceRefs: (Array.isArray(p.evidenceRefs) ? p.evidenceRefs : []).map(text).slice(0, BOUNDS.MAX_EVIDENCE_REFS),
      predictionId: text(input && input.predictionId),
      observationId: text(input && input.observation && input.observation.observationId),
      /* 仅供审计的指向信息；**不是** authority */
      sourceAtMatch: text(input && input.observation && input.observation.source),
      targetDomainAtMatch: text(input && input.observation && input.observation.targetDomain),
      predictionTypeAtMatch: text(input && input.prediction && input.prediction.predictionType),
      relationAuthority: RELATION_AUTHORITY,
      strengthHintAuthority: STRENGTH_HINT_AUTHORITY,
      idLifetime: ID_LIFETIME,
      /* 审计用：被 strip 掉的越权键名（**不**进入任何 authority 判定） */
      strippedKeys: (Array.isArray(p.strippedKeys) ? p.strippedKeys : []).map(text).slice(0, 16),
      canonical: canonicalize({
        relation: isRelation(p.relation) ? text(p.relation) : FAILURE_RELATION,
        strengthHint: text(p.strengthHint),
        predictionId: text(input && input.predictionId),
        observationId: text(input && input.observation && input.observation.observationId)
      }),
      reasonCodes: (p.reasonCodes || []).slice(0, 8)
    });
  }

  /** 从 sealed EvidenceMatch 里取出**唯一**可被 Settlement 消费的东西。 */
  function relationOf(match) {
    return isPlainObject(match) && isRelation(match.relation) ? text(match.relation) : FAILURE_RELATION;
  }

  /* ══════════════════════════════════════════════════════════════════
     ⑦ R1 · 三层 capability taxonomy（**唯一**出处，P4 也消费它）
     ══════════════════════════════════════════════════════════════════
       compiled  != enabled  != production-settleable
     */
  function capabilityTaxonomy(input) {
    var i = isPlainObject(input) ? input : {};
    /* compiled：runtime 里存在合法 matcher implementation */
    var compiled = i.matcherCapabilityPresent === true;
    /* enabled：system config 允许真实 model call */
    var enabled = compiled && i.matcherEnabled === true;
    /* policy：P3 是否允许这个 type 走 decisive */
    var policyAllowed = i.policyAllowed === true;
    /* 来源是否**有资格决定**这个 type 的结算（DECISIVE_AUTHORITY_SOURCES） */
    var sourceDecisive = i.sourceDecisive !== false;
    /* 归因 authority 是否足够（(q-14)：主观域 unknown ⇒ 不足） */
    var attributionAvailable = i.attributionAuthorityAvailable === true;
    /* 语义上**现在**能不能分类 */
    var semanticRuntimeClassifiable = compiled && enabled;
    var runtimeClassifiable = semanticRuntimeClassifiable && policyAllowed && sourceDecisive;
    var productionSettleable = runtimeClassifiable && attributionAvailable;
    var noEligibleSample = i.sampleAvailable === false;
    var reasons = [];
    if (!compiled) reasons.push('matcher-not-present');
    if (compiled && !enabled) reasons.push('matcher-disabled');
    if (!policyAllowed) reasons.push('policy-forbidden');
    if (!sourceDecisive) reasons.push('source-not-decisive');
    if (semanticRuntimeClassifiable && !policyAllowed) reasons.push('policy-forbidden');
    if (runtimeClassifiable && !attributionAvailable) reasons.push('attribution-unknown');
    if (compiled && enabled && i.statementOnly === true && !attributionAvailable) {
      /* statement 路径已被语义分类解锁，但归因门仍然关着 */
      if (reasons.indexOf('statement-relation-unavailable') < 0 && !semanticRuntimeClassifiable) {
        reasons.push('statement-relation-unavailable');
      }
    }
    if (noEligibleSample) reasons.push('no-eligible-sample');
    return Object.freeze({
      matcherCapabilityPresent: compiled,
      matcherEnabled: enabled,
      policyAllowed: policyAllowed,
      sourceDecisive: sourceDecisive,
      attributionAuthorityAvailable: attributionAvailable,
      semanticRuntimeClassifiable: semanticRuntimeClassifiable,
      runtimeClassifiable: runtimeClassifiable,
      productionSettleable: productionSettleable,
      noEligibleSample: noEligibleSample,
      capabilityGapReason: reasons.filter(function (v, idx, arr) { return arr.indexOf(v) === idx; })
    });
  }

  /* ══════════════════════════════════════════════════════════════════
     ⑧ R3 · MatchKey（确定性 identity；**禁止** Date.now / random / counter）
     ══════════════════════════════════════════════════════════════════ */
  /** 观察指纹：只取**语义相关**字段（顺序固定 ⇒ 确定性）。 */
  function observationFingerprint(observation) {
    var o = isPlainObject(observation) ? observation : {};
    var ref = isPlainObject(o.outcomeRef) ? o.outcomeRef : {};
    return canonicalize({
      observationId: text(o.observationId),
      source: text(o.source),
      sourceInstance: text(o.sourceInstance),
      targetDomain: text(o.targetDomain),
      observedAt: Number(o.observedAt) || 0,
      completeness: text(o.completeness),
      outcomeRefKind: text(ref.kind),
      outcomeRefToken: text(ref.token),
      outcomeRefStatement: clip(ref.statement, BOUNDS.MAX_STATEMENT_CHARS)
    });
  }
  /** 预测语义指纹：P2 已冻结的 semanticFingerprint（任何真实语义变化都会改变它）。 */
  function predictionFingerprint(prediction) {
    var snap = isPlainObject(prediction) && isPlainObject(prediction.predictionSnapshotAtCreation)
      ? prediction.predictionSnapshotAtCreation : null;
    if (!snap) return null;
    return canonicalize({
      semanticFingerprint: text(snap.semanticFingerprint),
      predictionType: text(snap.predictionType),
      contradictionMode: text(snap.contradictionMode)
    });
  }
  /**
   * matchKeyFor(prediction, observation)
   *   = stableToken(predictionFingerprint | observationFingerprint | matcherVersion [| relationSchemaVersion])
   *   same semantics + same observation + same matcherVersion ⇒ same key
   */
  function matchKeyFor(prediction, observation) {
    var pf = predictionFingerprint(prediction);
    var of = observationFingerprint(observation);
    if (!pf || !of) return null;
    var seed = [pf, of, MATCHER_VERSION, SCHEMA_VERSION].join('|');
    var h1 = 0x811c9dc5, h2 = 0x01000193;
    for (var i = 0; i < seed.length; i++) {
      var c = seed.charCodeAt(i);
      h1 = (h1 ^ c) >>> 0;
      h1 = (h1 + ((h1 << 1) + (h1 << 4) + (h1 << 7) + (h1 << 8) + (h1 << 24))) >>> 0;
      h2 = ((h2 ^ c) * 16777619) >>> 0;
    }
    return 'mk_' + (h1.toString(36) + h2.toString(36)).slice(0, 16);
  }

  /** 预算耗尽的规范化结果：**永远**是 ambiguous（绝不 support/conflict）。 */
  function budgetExhaustedResult(scopeName) {
    return {
      ok: false, relation: FAILURE_RELATION, failure: true,
      strengthHint: 'unspecified', rationale: '', evidenceRefs: [],
      strippedKeys: [],
      reasonCodes: [REASON.budgetExhausted, 'budget-scope:' + text(scopeName || 'unknown')]
    };
  }

  return {
    needsEvidenceMatcher: needsEvidenceMatcher,
    buildMatcherInput: buildMatcherInput,
    parseMatcherOutput: parseMatcherOutput,
    buildMatcherPayload: buildMatcherPayload,
    relationOf: relationOf,
    isRelation: isRelation,
    capabilityTaxonomy: capabilityTaxonomy,
    matchKeyFor: matchKeyFor,
    predictionFingerprint: predictionFingerprint,
    observationFingerprint: observationFingerprint,
    budgetExhaustedResult: budgetExhaustedResult,
    canonicalize: canonicalize,
    clip: clip,

    SCHEMA_VERSION: SCHEMA_VERSION,
    MATCHER_VERSION: MATCHER_VERSION,
    RELATIONS: RELATIONS,
    FAILURE_RELATION: FAILURE_RELATION,
    STRENGTH_HINTS: STRENGTH_HINTS,
    STRENGTH_HINT_AUTHORITY: STRENGTH_HINT_AUTHORITY,
    RELATION_AUTHORITY: RELATION_AUTHORITY,
    MATCHER_ROLE: MATCHER_ROLE,
    ID_LIFETIME: ID_LIFETIME,
    FORBIDDEN_OUTPUT_KEYS: FORBIDDEN_OUTPUT_KEYS,
    ALLOWED_OUTPUT_KEYS: ALLOWED_OUTPUT_KEYS,
    MATCHER_INPUT_TOP_LEVEL_KEYS: MATCHER_INPUT_TOP_LEVEL_KEYS,
    MATCHER_INPUT_TOP_LEVEL_KEY_COUNT: MATCHER_INPUT_TOP_LEVEL_KEY_COUNT,
    CAPABILITY_GAP_REASONS: CAPABILITY_GAP_REASONS,
    DEFAULT_BUDGET: DEFAULT_BUDGET,
    DEFAULT_HOLDER: DEFAULT_HOLDER,
    BOUNDS: BOUNDS,
    REASON: REASON,

    STATE_SUPPORT: Object.freeze({
      role: MATCHER_ROLE,
      mayClassifyRelation: 'YES',
      mayNotUpgradeSource: 'YES',
      mayNotUpgradeDomain: 'YES',
      mayNotChoosePredictionType: 'YES',
      mayNotChooseSettlementState: 'YES',
      mayNotDeclareValidated: 'YES',
      mayNotCreateOpportunity: 'YES',
      mayNotEnterCalibrationDirectly: 'YES',
      relationAuthority: RELATION_AUTHORITY,
      strengthHintAuthority: STRENGTH_HINT_AUTHORITY,
      failureRelation: FAILURE_RELATION,
      minimumContextMatching: 'YES',
      inputTopLevelKeyCount: MATCHER_INPUT_TOP_LEVEL_KEY_COUNT,
      atMostOncePerMatchKeyWithinSession: 'YES',
      matcherHolderLifetime: 'SESSION_ONLY',
      durableMatcherCache: 'NO',
      matcherCallBudget: 'HARD_CEILING',
      budgetExhaustionRelation: FAILURE_RELATION,
      callerRetryCannotUpgradeRelation: 'YES',
      capabilityTaxonomy: 'COMPILED_ENABLED_PRODUCTION_SETTLEABLE',
      matcherCalls: 'CONDITIONAL_ONE_PATH',
      durableWrites: 0,
      memoryAuthority: 'NONE',
      relationshipAuthority: 'NONE'
    })
  };
});
