'use strict';
/* ====================================================================
   IB Home Node · Structured Expectation → Prediction Projection（P5-B3-G1）
   --------------------------------------------------------------------
   MODEL_MAY_PROPOSE_STRUCTURED_EXPECTATION = YES
   MODEL_MAY_NOT_MINT_CANONICAL_PREDICTION  = YES
   PREDICTION_PROJECTION_AUTHORITY          = RUNTIME
   TYPE_TABLE_IS_SOLE_PREDICTION_TYPE_AUTHORITY = YES

   ── 本模块在链路里的位置 ──────────────────────────────────────────────
     model JSON
       → expectation-shadow-core.validateResponse   （候选归一：形状 / 闭集 / 共享文法）
       → **本模块**                                  （生产准入 + 组装 canonical expectation）
       → runtime-prediction-registry.projectFromValidatedExpectation
       → prediction-record-core                    （TYPE_TABLE 推导 + 身份 + seal）
       → Prediction Registry

   ── 它**只**做两件事 ─────────────────────────────────────────────────
     ① 生产准入：只有 G1_PRODUCTION_PROJECTION_TYPES 里的 kind 可以被投影
        （即使 TYPE_TABLE 还支持别的 —— §11/§42/§54）
     ② 组装：把候选 (kind, targetKey, stance) 组装成 prediction-record-core
        能吃的 **expectation 形状**（subject / predicate / expectedOutcome），
        其中 token 由**共享** proposition core 生成（模型不定义 token 文法，§18）

   ── 它**没有**的能力 ─────────────────────────────────────────────────
     predictionId 生成（P2）· identity（P2）· scope（runtime）· settlement ·
     calibration · memory · relationship · 模型调用 · durable 写。

   ── authority 字段永不进入本层 ───────────────────────────────────────
     组装是**显式白名单**，不是 Object.assign(rawItem)：
     模型输出里的 predictionId / characterId / conversationId / turnId /
     createdAt / source / registrySourceRef 等即使存在也只是数据，进不了 canonical record。
   ==================================================================== */

const path = require('path');

const ASSETS_JS = path.join(__dirname, '..', '..', 'assets', 'js');
const PREF = require(path.join(ASSETS_JS, 'memory-recall', 'preference-proposition-core.js'));
const EXPECTATION_CORE = require(path.join(ASSETS_JS, 'memory-recall', 'expectation-shadow-core.js'));
/* P2 的**唯一**类型推导函数：本模块用它做"组装出来的三元组真的会被推导成
   同一个 kind"的**真**校验（不是抄一份 TYPE_TABLE）。 */
const RECORD_CORE = require(path.join(ASSETS_JS, 'memory-recall', 'prediction-record-core.js'));

/* ── 生产投影策略（runtime 持有，**不是** prompt 里的一句话，§54）──────── */
const G1_PRODUCTION_PROJECTION_TYPES = Object.freeze(['preference']);

/* kind → (subject, predicate, expectedOutcome.kind) 的**唯一**映射表。
   新增一个 kind 必须同时证明 TYPE_TABLE 能推导出它（见 assertTypeTableAgreement）。 */
const PROJECTION_SHAPE = Object.freeze({
  preference: Object.freeze({
    subjectKind: 'user',
    predicateKind: 'prefers',
    outcomeKind: 'exclusive-outcome'
  })
});

const ENTRY = 'projectStructuredExpectation';
const SCHEMA_VERSION = 'structured-expectation-projection/v1';
const DEFAULT_MAX_PROJECTIONS = EXPECTATION_CORE.BOUNDS.MAX_OUTPUT_ITEMS;   /* = 4（既有 bound，不新增） */

const REASON = Object.freeze({
  ok: 'ok',
  missingStructuredPrediction: 'missing-structured-prediction',
  unsupportedPredictionType: 'unsupported-prediction-type',
  productionTypeNotEnabled: 'production-type-not-enabled',
  invalidPreferenceTarget: 'invalid-preference-target',
  invalidPreferenceStance: 'invalid-preference-stance',
  unstructuredExpectationNotSettleable: 'unstructured-expectation-not-settleable',
  malformedExpectationItem: 'malformed-expectation-item',
  scopeUnavailable: 'scope-unavailable',
  propositionCoreUnavailable: 'proposition-core-unavailable',
  typeTableDisagreement: 'type-table-disagreement',
  projectionLimitReached: 'production-prediction-limit-reached'
});

/* 上游（expectation schema 层）给出的"候选为什么没通过" → 本层封闭 reasonCode。
   这样 §41 的 "diagnostic reason = invalid stance" 是**真的**被报出来的，
   而不是含糊成 missing-structured-prediction。 */
const CANDIDATE_REJECTION_TO_REASON = Object.freeze({
  'structured-candidate-invalid-target': REASON.invalidPreferenceTarget,
  'structured-candidate-invalid-stance': REASON.invalidPreferenceStance,
  'structured-candidate-unsupported-kind': REASON.unsupportedPredictionType,
  'structured-candidate-shape-invalid': REASON.unsupportedPredictionType,
  'structured-candidate-proposition-core-unavailable': REASON.propositionCoreUnavailable
});

/* expectation item 里**允许**进入 canonical record 的字段（显式白名单）。
   ★ 没有 predictionId / characterId / conversationId / turnId / createdAt /
     source / settlementState / calibrationCounted —— 它们不属于 expectation。 */
const ALLOWED_ITEM_KEYS = Object.freeze([
  'prediction', 'trigger', 'evidenceMemoryIds', 'contradictoryEvidenceIds',
  'generalizationLevel', 'subjectivePredictionConfidence', 'epistemicStatus'
]);

function isPlainObject(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
function text(v) { return v == null ? '' : String(v); }

function createRuntimeStructuredExpectationProjection(deps) {
  const d = deps || {};
  const logger = typeof d.logger === 'function' ? d.logger : null;
  const maxProjections = Number.isFinite(Number(d.maxProjections)) && Number(d.maxProjections) > 0
    ? Number(d.maxProjections) : DEFAULT_MAX_PROJECTIONS;
  const counters = {
    candidatesSeen: 0, candidatesAccepted: 0, candidatesRejected: 0,
    planned: 0, limitReached: 0, malformedItems: 0,
    modelCalls: 0, durableWrites: 0,
    memoryWrites: 0, relationshipWrites: 0, settlementCalls: 0
  };
  const reasonTally = Object.create(null);

  function tally(reasonCode) {
    if (!reasonCode) return;
    reasonTally[reasonCode] = (reasonTally[reasonCode] || 0) + 1;
  }
  function refuse(reasonCode, extra) {
    return Object.assign({ ok: false, reasonCode: reasonCode, expectation: null }, extra || {});
  }

  /**
   * projectItem(item, scope) —— 唯一入口（纯函数式：无 IO、无时钟、无随机）。
   *   item  = expectation-shadow-core.validateResponse 的 **已验证 item**
   *   scope = { characterId, conversationId, turnId }（**runtime context**，§9）
   *
   * 返回 { ok:true, expectation, projection:{kind, targetKey, stance, preferenceToken} }
   *  或 { ok:false, reasonCode }
   * ★ 任何失败都只是"没有记录"：调用方照常继续（§26）。
   */
  function projectItem(item, scope) {
    const s = isPlainObject(scope) ? scope : {};
    const characterId = text(s.characterId);
    const conversationId = text(s.conversationId);
    const turnId = text(s.turnId);
    if (!characterId || !conversationId || !turnId) return refuse(REASON.scopeUnavailable);
    if (!isPlainObject(item)) { counters.malformedItems += 1; return refuse(REASON.malformedExpectationItem); }

    const candidate = item.structuredPrediction;
    if (candidate == null) {
      /* 候选被 schema 层拒过 ⇒ 透出**具体**原因（封闭词表映射） */
      const upstream = text(item.structuredPredictionRejection);
      const mapped = CANDIDATE_REJECTION_TO_REASON[upstream] || REASON.missingStructuredPrediction;
      counters.candidatesRejected += 1; tally(mapped);
      return refuse(mapped, upstream ? { candidateRejection: upstream } : null);
    }
    counters.candidatesSeen += 1;
    if (!isPlainObject(candidate) || !text(candidate.kind)) {
      counters.candidatesRejected += 1; tally(REASON.unsupportedPredictionType);
      return refuse(REASON.unsupportedPredictionType);
    }

    /* ① 生产准入：只有策略里的 kind 可以被投影（TYPE_TABLE 支持 ≠ 允许入档） */
    const kind = text(candidate.kind);
    if (G1_PRODUCTION_PROJECTION_TYPES.indexOf(kind) < 0) {
      counters.candidatesRejected += 1; tally(REASON.productionTypeNotEnabled);
      return refuse(REASON.productionTypeNotEnabled, { kind: kind, enabled: G1_PRODUCTION_PROJECTION_TYPES.slice() });
    }
    const shape = PROJECTION_SHAPE[kind];
    if (!shape) {
      counters.candidatesRejected += 1; tally(REASON.unsupportedPredictionType);
      return refuse(REASON.unsupportedPredictionType, { kind: kind });
    }
    if (!PREF || typeof PREF.buildPreferenceToken !== 'function') {
      counters.candidatesRejected += 1; tally(REASON.propositionCoreUnavailable);
      return refuse(REASON.propositionCoreUnavailable);
    }

    /* ② 重新过一遍**共享**文法（不信任上游形状；同一个 core，不抄第二份） */
    const targetKey = PREF.canonicalTargetKey(candidate.targetKey);
    if (targetKey == null) {
      counters.candidatesRejected += 1; tally(REASON.invalidPreferenceTarget);
      return refuse(REASON.invalidPreferenceTarget);
    }
    const stance = text(candidate.stance);
    if (PREF.isStance(stance) !== true) {
      counters.candidatesRejected += 1; tally(REASON.invalidPreferenceStance);
      return refuse(REASON.invalidPreferenceStance, { acceptedStances: PREF.STANCES.slice() });
    }
    const preferenceToken = PREF.buildPreferenceToken(stance, targetKey);
    if (preferenceToken == null) {
      counters.candidatesRejected += 1; tally(REASON.invalidPreferenceTarget);
      return refuse(REASON.invalidPreferenceTarget);
    }

    /* ③ 组装 canonical expectation —— **显式白名单**，authority 字段进不来 */
    const expectation = {};
    for (const key of ALLOWED_ITEM_KEYS) {
      if (Object.prototype.hasOwnProperty.call(item, key)) expectation[key] = item[key];
    }
    expectation.subject = { kind: shape.subjectKind, label: '' };
    expectation.predicate = { kind: shape.predicateKind };
    expectation.expectedOutcome = { kind: shape.outcomeKind, token: preferenceToken, unit: null };

    /* ④ 与 TYPE_TABLE 的一致性自检 —— 用 P2 的**唯一**推导函数验证：
          我们刚组装的 (subject, predicate, expectedOutcome) **真的**会被推导成
          同一个 kind。TYPE_TABLE / OUTCOME_ALLOWED 漂移时这里 fail closed，
          而不是等到投影时才发现（那是 GAP-1 当初的形状）。 */
    var derived = null;
    try {
      derived = (RECORD_CORE && typeof RECORD_CORE.derivePredictionType === 'function')
        ? RECORD_CORE.derivePredictionType({
          subject: expectation.subject,
          predicate: expectation.predicate,
          expectedOutcome: expectation.expectedOutcome
        })
        : null;
    } catch (_) { derived = null; }
    if (!derived || derived.ok !== true || text(derived.predictionType) !== kind) {
      counters.candidatesRejected += 1; tally(REASON.typeTableDisagreement);
      return refuse(REASON.typeTableDisagreement, {
        kind: kind, derived: derived ? text(derived.predictionType) : null
      });
    }

    counters.candidatesAccepted += 1;
    return {
      ok: true,
      reasonCode: REASON.ok,
      expectation: expectation,
      projection: { kind: kind, targetKey: targetKey, stance: stance, preferenceToken: preferenceToken }
    };
  }

  /**
   * plan(items, scope) —— 对一轮 expectation 的全部 item 做投影规划。
   * 返回 { plans:[{index, ok, expectation, reasonCode, projection}], counts }
   * ★ 只规划；注册仍由调用方用**既有** P2 seam 完成（ONE registry call site）。
   */
  function plan(items, scope) {
    const list = Array.isArray(items) ? items : [];
    const out = [];
    let projected = 0;
    for (let index = 0; index < list.length; index += 1) {
      if (projected >= maxProjections) {
        counters.limitReached += 1; tally(REASON.projectionLimitReached);
        out.push({ index: index, ok: false, reasonCode: REASON.projectionLimitReached, expectation: null });
        continue;
      }
      const res = projectItem(list[index], scope);
      if (res.ok) projected += 1;
      out.push({ index: index, ok: res.ok, reasonCode: res.reasonCode, expectation: res.expectation, projection: res.projection || null });
    }
    counters.planned += out.filter(x => x.ok).length;
    return { plans: out, counts: { items: list.length, planned: out.filter(x => x.ok).length } };
  }

  function describe() {
    return {
      status: 'LIVE_CAPABLE',
      entry: ENTRY,
      schemaVersion: SCHEMA_VERSION,
      owner: 'HOME_NODE_COGNITION_RUNTIME',
      projectionAuthority: 'RUNTIME',
      candidateAuthority: 'MODEL_PROPOSAL_ONLY',
      modelMayMintPrediction: 'NO',
      modelMayChoosePredictionId: 'NO',
      modelDefinesTokenGrammar: 'NO',
      typeTableIsSoleTypeAuthority: 'YES',
      productionProjectionTypes: G1_PRODUCTION_PROJECTION_TYPES.slice(),
      projectionShapes: Object.keys(PROJECTION_SHAPE),
      allowedItemKeys: ALLOWED_ITEM_KEYS.slice(),
      authorityFieldsCopied: 0,
      sharedPropositionCore: 'assets/js/memory-recall/preference-proposition-core.js',
      maxProductionPredictionsPerTurn: maxProjections,
      registryWriteAuthority: 'CALLER_OWNED_SINGLE_P2_SEAM',
      typeTableAgreementChecked: 'YES',
      modelCalls: 0, durableWrites: 0, settlementCalls: 0,
      memoryWrites: 0, relationshipWrites: 0,
      counters: Object.assign({}, counters),
      reasons: Object.assign({}, reasonTally)
    };
  }

  return {
    ENTRY: ENTRY,
    projectItem: projectItem,
    plan: plan,
    describe: describe,
    counters: counters,
    reasonTally: function () { return Object.assign({}, reasonTally); }
  };
}

module.exports = {
  createRuntimeStructuredExpectationProjection: createRuntimeStructuredExpectationProjection,
  G1_PRODUCTION_PROJECTION_TYPES: G1_PRODUCTION_PROJECTION_TYPES,
  PROJECTION_SHAPE: PROJECTION_SHAPE,
  ALLOWED_ITEM_KEYS: ALLOWED_ITEM_KEYS,
  DEFAULT_MAX_PROJECTIONS: DEFAULT_MAX_PROJECTIONS,
  REASON: REASON,
  SCHEMA_VERSION: SCHEMA_VERSION,
  ENTRY: ENTRY
};
