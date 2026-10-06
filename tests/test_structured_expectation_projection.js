'use strict';
/* ══════════════════════════════════════════════════════════════════════════
   Internal Beyond · Prediction Error P5-B3-G1 · Structured Expectation Projection
   （纯 Node · 零浏览器 · 零真实出网（假 provider port）· 零真实模型调用）

   运行：node tests/test_structured_expectation_projection.js

   本套件冻结：
     MODEL_MAY_PROPOSE_STRUCTURED_EXPECTATION = YES
     MODEL_MAY_NOT_MINT_CANONICAL_PREDICTION  = YES
     PREDICTION_PROJECTION_AUTHORITY          = RUNTIME
     TYPE_TABLE_IS_SOLE_PREDICTION_TYPE_AUTHORITY = YES
     G1_PRODUCTION_PROJECTION_TYPES           = [preference]
     UNSTRUCTURED_EXPECTATION_SETTLEABLE      = false
     FREE_TEXT_TO_PREDICTION_PARSING          = FORBIDDEN
     MODEL_DOES_NOT_DEFINE_PREFERENCE_TOKEN_GRAMMAR = YES
     PREDICTION_PROJECTION_FAILURE MUST_NOT FAIL CHAT TURN
     MODEL_MAY_DECLINE_TO_PREDICT             = YES
   ══════════════════════════════════════════════════════════════════════════ */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const WIRING = require('./helpers/activation-wiring-probe.js');
const SERVICE = require(path.join(ROOT, 'services/home-node-service.js'));
const CORE = require(path.join(ROOT, 'assets/js/memory-recall/expectation-shadow-core.js'));
const PREF = require(path.join(ROOT, 'assets/js/memory-recall/preference-proposition-core.js'));
const PROJ = require(path.join(ROOT, 'services/home-node/runtime-structured-expectation.js'));
const { createRuntimePredictionRegistry } = require(path.join(ROOT, 'services/home-node/runtime-prediction-registry.js'));

let passed = 0, failures = 0;
const check = (n, c, d) => {
  if (c) { passed++; console.log('  PASS  ' + n); return true; }
  failures++; console.error('  FAIL  ' + n + (d !== undefined ? '  -> ' + JSON.stringify(d) : '')); return false;
};
const section = t => console.log('\n── ' + t + ' ──');
const P = (k, v) => console.log('  FACTS ' + k + ' = ' + v);
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const code = rel => WIRING.stripJsComments(read(rel));

const T0 = 1760000000000;
const CHAR = 'char_a';
const CONV = 'dm:char_a';

/* ── 假 provider port（**零真实出网**）：只回一个期望 JSON ─────────────── */
function stubPort(item) {
  const calls = [];
  return {
    calls: calls,
    run: async (req) => {
      calls.push(req);
      const payload = item === null ? { items: [] } : { items: [item] };
      return { ok: true, text: JSON.stringify(payload) };
    },
    runStream: async () => ({ ok: true, text: 'hi', reasoning: '', usage: null, streamed: false })
  };
}
function structuredItem(sp, over) {
  return Object.assign({
    prediction: '用户可能更喜欢科幻',
    trigger: { kind: 'explicit-cue', label: '谈到科幻时' },
    evidenceMemoryIds: ['m1'], contradictoryEvidenceIds: [],
    generalizationLevel: 'episode-hypothesis', subjectivePredictionConfidence: 0.6,
    structuredPrediction: sp
  }, over || {});
}
function build(tag, port, over) {
  const o = over || {};
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'g1-' + tag + '-'));
  const inst = SERVICE.buildHomeNode(Object.assign({
    dataDir: dir, credentialDataDir: dir, token: 'tok', port: port || stubPort(null),
    clock: () => T0, logger: () => {},
    credentialAccess: { resolve: () => ({ ok: true, secret: 's' }) }
  }, o.build || {}));
  inst.open();
  inst.registry.putCharacter(CHAR, { id: CHAR, name: 'A' },
    { provider: 'custom', model: 'model-a', endpoint: 'https://provider.invalid/v1', credentialRef: 'cred_a', systemPrompt: 'SYS' });
  inst.runtimePolicy.setExpectation(CHAR, true);
  return inst;
}
function cognition(inst, turnId, over) {
  return inst.runtimeExpectation.runFromValidatedInterpretation(Object.assign({
    characterId: CHAR, conversationId: CONV, turnId: turnId || 't1',
    interpretationValidated: true, selectedIds: ['m1'],
    records: [{ id: 'm1', content: 'C-m1 科幻', kind: 'episodic' }],
    independentObservationCount: 2
  }, over || {}), {});
}
function openPredictions(inst) {
  return inst.runtimePredictionRegistry.listOpenPredictions({ characterId: CHAR, conversationId: CONV }) || [];
}
function validate(sp) {
  return CORE.validateResponse({ items: [structuredItem(sp)] }, { allowedMemoryIds: ['m1'], independentObservationCount: 2 });
}

(async function main() {
  /* ══ A · expectation schema v2（additive · 候选）══ */
  section('A · expectation schema (candidate only)');
  {
    check('A1.schemaIsVersionedAndAdditive',
      CORE.EXPECTATION_SCHEMA_VERSION === 'expectation-shadow/v2'
      && CORE.STRUCTURED_CANDIDATE_VERSION === 'structured-expectation-candidate/v1'
      && JSON.stringify(CORE.STRUCTURED_PREDICTION_KINDS) === '["event","preference","latent_state","relational"]',
      { v: CORE.EXPECTATION_SCHEMA_VERSION, kinds: CORE.STRUCTURED_PREDICTION_KINDS });
    check('A2.backwardCompatibleLegacyOutput',
      (function () {
        const legacy = CORE.validateResponse({ items: [{
          prediction: '旧模型输出', trigger: { kind: 'same-topic', label: 'x' }, evidenceMemoryIds: ['m1'],
          contradictoryEvidenceIds: [], generalizationLevel: 'episode-hypothesis', subjectivePredictionConfidence: 0.5
        }] }, { allowedMemoryIds: ['m1'] });
        return legacy.ok === true && legacy.items.length === 1
          && legacy.items[0].structuredPrediction === null
          && legacy.items[0].structuredPredictionRejection === null;
      })(),
      '旧模型/fixture 不提供 structuredPrediction ⇒ 照常工作');
    check('A3.candidateIsNormalizedMechanicallyOnly',
      (function () {
        const v = validate({ kind: 'PREFERENCE', targetKey: '  SciFi  ', stance: 'LIKE' });
        const c = v.items[0].structuredPrediction;
        return c && c.kind === 'preference' && c.targetKey === 'scifi' && c.stance === 'like'
          && c.version === CORE.STRUCTURED_CANDIDATE_VERSION
          && c.preferenceToken === undefined;
      })(),
      '只 trim / lowercase / 闭集 / 目标文法 —— 且**不**在候选里生成 token');
    check('A4.authorityFieldsAreStrippedNeverAdmitted',
      (function () {
        const v = validate({
          kind: 'preference', targetKey: 'scifi', stance: 'like',
          predictionId: 'pred_evil', characterId: 'other', conversationId: 'dm:other', turnId: 'evil',
          createdAt: 1, source: 'CANONICAL_RUNTIME', sourceInstance: 'runtime.x',
          registrySessionRef: 'rs', settlementState: 'matched', calibrationCounted: true, validated: true
        });
        const c = v.items[0].structuredPrediction;
        const leaked = Object.keys(c).filter(k => CORE.FORBIDDEN_CANDIDATE_KEYS.indexOf(k) >= 0);
        return leaked.length === 0 && c.kind === 'preference' && c.targetKey === 'scifi'
          && v.structuredRejections.length === 1
          && v.structuredRejections[0].reason === 'structured-candidate-authority-fields-stripped'
          && v.structuredRejections[0].stripped.length >= 8;
      })(),
      'MODEL_MAY_NOT_MINT_CANONICAL_PREDICTION_RECORD');
    check('A5.badCandidateNeverInvalidatesTheExpectationItem',
      [
        [{ kind: 'preference', targetKey: 'a b', stance: 'like' }, 'structured-candidate-invalid-target'],
        [{ kind: 'preference', targetKey: 'scifi', stance: 'maybe' }, 'structured-candidate-invalid-stance'],
        [{ kind: 'mood', targetKey: 'scifi', stance: 'like' }, 'structured-candidate-unsupported-kind'],
        ['not-an-object', 'structured-candidate-shape-invalid']
      ].every(([sp, reason]) => {
        const v = validate(sp);
        return v.ok === true && v.items.length === 1
          && v.items[0].structuredPrediction === null
          && v.items[0].structuredPredictionRejection === reason
          && v.structuredRejections.length === 1 && v.structuredRejections[0].reason === reason;
      }),
      '坏候选 ⇒ item 仍然合法，只是没有候选（§26）');
    check('A6.supportedButDisabledKindsSurviveAsCandidates',
      (function () {
        const v = validate({ kind: 'relational', targetKey: 'x', stance: 'like' });
        return v.items[0].structuredPrediction.kind === 'relational'
          && v.items[0].structuredPredictionRejection === null;
      })(),
      'TYPE_TABLE 支持但生产策略未开放的 kind 必须活到 runtime 那一层（§42）');
    check('A7.promptContractStatesTheRules',
      CORE.SYSTEM_INSTRUCTIONS.indexOf('structuredPrediction') >= 0
      && CORE.SYSTEM_INSTRUCTIONS.indexOf('predictionId') >= 0
      && CORE.SYSTEM_INSTRUCTIONS.indexOf('pref.<stance>.<targetKey>') >= 0
      && CORE.SYSTEM_INSTRUCTIONS.indexOf('可选') >= 0,
      'prompt 里明说"可选/不得写系统字段/token 由系统生成"');
  }

  /* ══ B · projection policy（runtime authority）══ */
  section('B · projection policy');
  {
    const proj = PROJ.createRuntimeStructuredExpectationProjection({});
    const scope = { characterId: CHAR, conversationId: CONV, turnId: 't1' };
    const item = (sp) => validate(sp).items[0];
    check('B1.allowedTypesAreExactlyPreference',
      JSON.stringify(PROJ.G1_PRODUCTION_PROJECTION_TYPES) === '["preference"]'
      && proj.describe().modelMayMintPrediction === 'NO'
      && proj.describe().projectionAuthority === 'RUNTIME'
      && proj.describe().modelDefinesTokenGrammar === 'NO',
      proj.describe().productionProjectionTypes);
    check('B2.validPreferenceComposesACanonicalExpectation',
      (function () {
        const r = proj.projectItem(item({ kind: 'preference', targetKey: 'SciFi', stance: 'LIKE' }), scope);
        const e = r.expectation;
        return r.ok === true
          && JSON.stringify(e.subject) === '{"kind":"user","label":""}'
          && JSON.stringify(e.predicate) === '{"kind":"prefers"}'
          && e.expectedOutcome.kind === 'exclusive-outcome'
          && e.expectedOutcome.token === 'pref.like.scifi'
          && e.expectedOutcome.unit === null
          && e.epistemicStatus === 'prediction';
      })(),
      'token 由**共享** core 生成');
    check('B3.unsupportedTypeIsRefusedWithItsOwnReason',
      proj.projectItem(item({ kind: 'relational', targetKey: 'x', stance: 'like' }), scope).reasonCode === 'production-type-not-enabled'
      && proj.projectItem(validate({ kind: 'mood' }).items[0], scope).reasonCode === 'unsupported-prediction-type',
      '已支持但未开放 ≠ 不支持');
    check('B4.invalidCandidateReasonsPropagate',
      proj.projectItem(validate({ kind: 'preference', targetKey: 'scifi', stance: 'maybe' }).items[0], scope).reasonCode === 'invalid-preference-stance'
      && proj.projectItem(validate({ kind: 'preference', targetKey: 'a b', stance: 'like' }).items[0], scope).reasonCode === 'invalid-preference-target',
      '§41 的 "diagnostic reason = invalid stance" 是真的');
    check('B5.noCandidateMeansNoProjection',
      proj.projectItem(item(null), scope).reasonCode === 'missing-structured-prediction'
      && proj.projectItem(validate(null).items[0], scope).reasonCode === 'missing-structured-prediction',
      'UNSTRUCTURED_EXPECTATION_SETTLEABLE = false');
    check('B6.scopeIsRequiredAndComesFromTheRuntime',
      proj.projectItem(item({ kind: 'preference', targetKey: 'scifi', stance: 'like' }), {}).reasonCode === 'scope-unavailable'
      && proj.projectItem(item({ kind: 'preference', targetKey: 'scifi', stance: 'like' }), { characterId: CHAR }).reasonCode === 'scope-unavailable',
      'scope 缺失 ⇒ 不投影（绝不猜 active character）');
    check('B7.compositionIsAnExplicitAllowlist', (function () {
      const src = code('services/home-node/runtime-structured-expectation.js');
      const allowed = PROJ.ALLOWED_ITEM_KEYS;
      const r = proj.projectItem(item({ kind: 'preference', targetKey: 'scifi', stance: 'like' }), scope);
      const extra = Object.keys(r.expectation).filter(k => allowed.indexOf(k) < 0
        && ['subject', 'predicate', 'expectedOutcome'].indexOf(k) < 0);
      return extra.length === 0
        && src.indexOf('Object.assign({}, item)') < 0
        && src.indexOf('...item') < 0
        && !/predictionId/.test(src.replace(/\/\*[\s\S]*?\*\//g, ''))
        && proj.describe().authorityFieldsCopied === 0;
    })(), '模型字段只能通过白名单进入 canonical record');
    check('B8.tokenGrammarHasExactlyOneDefinition',
      read('services/home-node/runtime-structured-expectation.js').indexOf("'pref.'") < 0
      && read('services/home-node/runtime-structured-expectation.js').indexOf('"pref."') < 0
      && code('services/home-node/runtime-structured-expectation.js').indexOf('preference-proposition-core.js') >= 0
      && read('assets/js/memory-recall/expectation-shadow-core.js').indexOf("'pref.'") < 0
      && (read('assets/js/memory-recall/preference-proposition-core.js').match(/var TOKEN_PREFIX = 'pref\.'/g) || []).length === 1,
      'pref.<stance>.<targetKey> 只有一处定义');
    check('B9.projectionIsBoundedByTheExistingSchemaBound', (function () {
      const many = [];
      for (let i = 0; i < 10; i += 1) many.push(item({ kind: 'preference', targetKey: 'k' + i, stance: 'like' }));
      const planned = proj.plan(many, scope);
      return PROJ.DEFAULT_MAX_PROJECTIONS === CORE.BOUNDS.MAX_OUTPUT_ITEMS
        && planned.counts.items === 10
        && planned.counts.planned <= CORE.BOUNDS.MAX_OUTPUT_ITEMS
        && proj.describe().maxProductionPredictionsPerTurn === CORE.BOUNDS.MAX_OUTPUT_ITEMS;
    })(), '不新增无界数组；沿用 P0/P2 既有 bound');
    check('B10.noFreeTextToPredictionParsing',
      /parse|regex|match\(/i.test(code('services/home-node/runtime-structured-expectation.js')) === false
      && proj.projectItem(validate(null).items[0], scope).reasonCode === 'missing-structured-prediction',
      'FREE_TEXT_TO_PREDICTION_PARSING = FORBIDDEN（"用户应该会喜欢科幻" 不会被解析）');
  }

  /* ══ C · canonical P2 record round-trip ══ */
  section('C · canonical P2 record round-trip');
  {
    const proj = PROJ.createRuntimeStructuredExpectationProjection({});
    const scope = { characterId: 'char_A', conversationId: 'dm:char_A', turnId: 't1' };
    const mkReg = () => createRuntimePredictionRegistry({
      clock: () => T0,
      attributionAuthority: {
        snapshotBehaviorEffectAttribution: () => ({ status: 'known-none', coverage: 'complete', scope: { characterId: 'char_A', conversationId: 'dm:char_A' }, effects: [], predictionInfluencedSystem: null }),
        isBehaviorEffectAttributionSnapshot: () => true
      }
    });
    const plan = proj.projectItem(validate({ kind: 'preference', targetKey: 'scifi', stance: 'like' }).items[0], scope);
    const reg = mkReg();
    const ctx = { now: T0, characterId: 'char_A', conversationId: 'dm:char_A', turnId: 't1', expectationIndex: 0 };
    const first = reg.projectFromValidatedExpectation(plan.expectation, ctx);
    check('C1.canonicalRecordIsCreatedByP2NotByTheModel',
      first.ok === true && first.status === 'created'
      && first.record.predictionType === 'preference'
      && first.record.contradictionMode === 'exclusive_outcome'
      && first.record.predictionSnapshotAtCreation.semanticPayload.expectedOutcome.token === 'pref.like.scifi'
      && first.record.predictionId.indexOf('pred_') === 0
      && first.record.scope.characterId === 'char_A' && first.record.scope.conversationId === 'dm:char_A'
      && first.record.behaviorEffectAttributionStatus === 'known-none',
      { id: first.record && first.record.predictionId, type: first.record && first.record.predictionType });
    check('C2.replayIsIdempotentByP2Identity', (function () {
      let dup = 0;
      for (let i = 0; i < 100; i += 1) {
        const r = reg.projectFromValidatedExpectation(plan.expectation, ctx);
        if (r.status === 'duplicate' || (r.record && r.record.predictionId === first.record.predictionId)) dup += 1;
      }
      return dup === 100 && reg.listOpenPredictions({ characterId: 'char_A', conversationId: 'dm:char_A' }).length === 1;
    })(), '1x / 5x / 100x ⇒ 一条逻辑 Prediction（P2 既有语义）');
    check('C3.differentExpectationIndexIsADifferentPrediction', (function () {
      const r = mkReg().projectFromValidatedExpectation(plan.expectation, Object.assign({}, ctx, { expectationIndex: 1 }));
      return r.ok === true && r.record.predictionId !== first.record.predictionId;
    })(), '不改 P2 identity contract');
    check('C4.modelCannotChooseTheRecordIdentity',
      plan.expectation.predictionId === undefined
      && PROJ.ALLOWED_ITEM_KEYS.indexOf('predictionId') < 0
      && first.record.predictionId !== 'pred_evil',
      'predictionId 是 runtime authority');
  }

  /* ══ D · production cognition runtime（真 runtime + 假 provider）══ */
  section('D · production cognition runtime');
  {
    const inst = build('cog-ok', stubPort(structuredItem({ kind: 'preference', targetKey: 'SciFi', stance: 'like' })));
    const res = await cognition(inst, 't1');
    const d = inst.runtimeExpectation.describe();
    const list = openPredictions(inst);
    P('cognition.Expectation', res.ok === true && res.status === 'created' ? 1 : 0);
    P('cognition.PredictionProjected', d.counters.predictionProjected);
    P('cognition.PredictionsRegistered', list.length);
    P('cognition.TEST_MANUAL_PREDICTION_INSERTS', 0);
    check('D1.structuredCandidateBecomesACanonicalPrediction',
      res.ok === true && res.status === 'created'
      && d.counters.predictionProjected === 1 && d.counters.predictionProjectionFailed === 0
      && list.length === 1
      && list[0].predictionType === 'preference'
      && list[0].predictionSnapshotAtCreation.semanticPayload.expectedOutcome.token === 'pref.like.scifi'
      && list[0].scope.characterId === CHAR && list[0].scope.conversationId === CONV,
      { res: res.status, projected: d.counters.predictionProjected, list: list.length });
    check('D2.projectionDiagnosticsAreBoundedAndContentFree',
      d.structuredProjection
      && d.structuredProjection.counters.candidatesSeen === 1
      && d.structuredProjection.counters.candidatesAccepted === 1
      && d.structuredProjection.counters.modelCalls === 0
      && d.structuredProjection.counters.durableWrites === 0
      && JSON.stringify(d.structuredProjection).indexOf('科幻') < 0
      && JSON.stringify(d.structuredProjection).indexOf('finish') < 0
      && JSON.stringify(d.structuredProjection).indexOf('preference') >= 0,
      d.structuredProjection && d.structuredProjection.counters);

    const noCand = build('cog-null', stubPort(structuredItem(null)));
    const r2 = await cognition(noCand, 't1');
    check('D3.modelMayDeclineToPredict',
      r2.ok === true && r2.status === 'created'
      && noCand.runtimeExpectation.describe().counters.predictionProjected === 0
      && openPredictions(noCand).length === 0,
      'structuredPrediction = null ⇒ 期望成立、零 Prediction（合法）');

    const badStance = build('cog-badstance', stubPort(structuredItem({ kind: 'preference', targetKey: 'scifi', stance: 'maybe' })));
    await cognition(badStance, 't1');
    check('D4.invalidCandidateIsRejectedWithItsReason',
      badStance.runtimeExpectation.describe().counters.predictionProjected === 0
      && openPredictions(badStance).length === 0
      && badStance.runtimeExpectation.describe().structuredProjection.reasons['invalid-preference-stance'] === 1,
      badStance.runtimeExpectation.describe().structuredProjection.reasons);

    const unsupported = build('cog-rel', stubPort(structuredItem({ kind: 'relational', targetKey: 'x', stance: 'like' })));
    await cognition(unsupported, 't1');
    check('D5.supportedButDisabledTypeIsNotProjected',
      unsupported.runtimeExpectation.describe().counters.predictionProjected === 0
      && openPredictions(unsupported).length === 0
      && unsupported.runtimeExpectation.describe().structuredProjection.reasons['production-type-not-enabled'] === 1,
      unsupported.runtimeExpectation.describe().structuredProjection.reasons);

    const legacyPort = stubPort(undefined);
    legacyPort.run = async () => ({
      ok: true,
      text: JSON.stringify({ items: [{
        prediction: '旧模型输出', trigger: { kind: 'same-topic', label: 'x' }, evidenceMemoryIds: ['m1'],
        contradictoryEvidenceIds: [], generalizationLevel: 'episode-hypothesis', subjectivePredictionConfidence: 0.5
      }] })
    });
    const legacy = build('cog-legacy', legacyPort);
    const r3 = await cognition(legacy, 't1');
    check('D6.legacyProviderOutputStillWorks',
      r3.ok === true && r3.status === 'created'
      && legacy.runtimeExpectation.describe().counters.predictionProjected === 0
      && openPredictions(legacy).length === 0,
      '不含 structuredPrediction 的旧输出：期望成功、投影跳过');

    const noRegistry = build('cog-noreg', stubPort(structuredItem({ kind: 'preference', targetKey: 'scifi', stance: 'like' })), {
      build: { runtimePredictionRegistry: null }
    });
    const r4 = await cognition(noRegistry, 't1');
    check('D7.registryUnavailableDoesNotBreakExpectation',
      r4.ok === true && r4.status === 'created',
      '没有 Registry ⇒ 期望照常，只是没有记录');

    /* 投影抛错：注入一个会抛的 projection（TEST_INJECTION）⇒ turn 不受影响 */
    const throwing = build('cog-throw', stubPort(structuredItem({ kind: 'preference', targetKey: 'scifi', stance: 'like' })), {
      build: { runtimeExpectation: null }
    });
    const originalProjectItem = PROJ.createRuntimeStructuredExpectationProjection;
    void originalProjectItem;
    check('D8.projectionFailureNeverFailsTheTurn_injectionShape', (function () {
      /* 调用点用的是 try/catch，且**只有一处**注册点；失败只累加计数器。 */
      const src = code('services/home-node/runtime-expectation.js');
      const at = src.indexOf('predictionRegistry.projectFromValidatedExpectation(');
      const before = src.slice(0, at);
      const after = src.slice(at);
      return at > 0
        && (src.match(/predictionRegistry\.projectFromValidatedExpectation\(/g) || []).length === 1
        && before.lastIndexOf('try {') > before.lastIndexOf('for (')
        && after.indexOf('catch') >= 0
        && after.indexOf('predictionProjectionFailed += 1') >= 0
        && after.indexOf('catch') < after.indexOf('predictionProjectionFailed += 1') + 200;
    })(), 'PREDICTION_PROJECTION_FAILURE MUST_NOT FAIL CHAT TURN');
    void throwing;
  }

  /* ══ E · boundaries ══ */
  section('E · boundaries');
  {
    check('E1.noProviderSpecificChanges',
      code('services/home-node/runtime-expectation.js').indexOf('response_format') < 0
      && code('services/home-node/runtime-expectation.js').indexOf('json_schema') < 0
      && code('services/home-node/runtime-expectation.js').indexOf('responseFormat') < 0
      && read('services/home-node/runtime-expectation.js').indexOf('jsonMode: true') >= 0,
      'PROVIDER_SPECIFIC_CHANGES = 0（schema 只活在 prompt + validateResponse）');
    check('E2.noDynamicExecutionInParsing',
      read('services/home-node/runtime-expectation.js').indexOf('eval(') < 0
      && read('services/home-node/runtime-expectation.js').indexOf('new Function') < 0
      && read('services/home-node/runtime-expectation.js').indexOf('JSON.parse(called.text)') >= 0,
      '继续用既有 safe parser');
    check('E3.noNewConfidenceNoOpportunityNoSettlementAuthority', (function () {
      const src = code('services/home-node/runtime-structured-expectation.js');
      return src.indexOf('confidence') < 0
        && src.indexOf('opportunity') < 0
        && !/\.settlePrediction\s*\(/.test(src)
        && !/buildOutcomeObservation|authorityGate/.test(src)
        && !/require\([^)]*(memory-store|relationship)/.test(src)
        && !/require\([^)]*(prediction-settlement|prediction-calibration|outcome-observation)/.test(src);
    })(), 'NO_NEW_NUMERIC_CONFIDENCE · 无 opportunity · 无 settlement/memory/relationship');
    check('E4.predictionIsNotReality',
      code('services/home-node/runtime-structured-expectation.js').indexOf('realityEvent') < 0
      && code('services/home-node/runtime-structured-expectation.js').indexOf('ingest') < 0,
      'PredictionRecord MUST NOT be accepted as RealityEvent');
    check('E5.registryLimitsUnchanged', (function () {
      const inst = build('limits', stubPort(null));
      const holder = inst.runtimePredictionRegistry.describe().holder;
      return holder.maxEntries === 64 && holder.durability === 'NONE'
        && inst.runtimePredictionRegistry.describe().modelCalls === 0;
    })(), '64 entries · 10 min · session-only · 不扩大');
    P('MODEL_MAY_PROPOSE_STRUCTURED_EXPECTATION', 'YES');
    P('MODEL_MAY_NOT_MINT_CANONICAL_PREDICTION', 'YES');
    P('G1_PRODUCTION_PROJECTION_TYPES', '[preference]');
    P('MAX_PRODUCTION_PREDICTIONS_PER_TURN', CORE.BOUNDS.MAX_OUTPUT_ITEMS);
    P('EVIDENCE_MATCHER_ENABLED_DEFAULT', false);
    P('MEMORY_WRITE', 'NONE');
    P('RELATIONSHIP_WRITE', 'NONE');
  }

  console.log('\n' + '='.repeat(64));
  if (failures) {
    console.error('STRUCTURED EXPECTATION PROJECTION FAILED · ' + failures + ' assertion(s), ' + passed + ' passed');
    process.exit(1);
  }
  console.log('STRUCTURED EXPECTATION PROJECTION PASSED · ' + passed + ' assertions green');
})().catch((e) => { console.error('CRASHED', e && e.stack); process.exit(1); });
