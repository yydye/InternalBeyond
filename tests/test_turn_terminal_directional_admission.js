'use strict';
/* ══════════════════════════════════════════════════════════════════════════
   Internal Beyond · P5-B3-D5 · Turn Terminal Directional Admission Regression
   （运行 node tests/test_turn_terminal_directional_admission.js）

   D4 generic token remains a fact-only admission marker.
   D5 recognized outcome-specific tokens feed P3 prediction-specific relation.
   Reality source / P1 still do not declare relation or settlement.
   TOKEN_ADMISSION != OPPORTUNITY / SOURCE_AUTHORITY / SETTLEMENT_AUTHORITY
   ══════════════════════════════════════════════════════════════════════════ */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const WIRING = require('./helpers/activation-wiring-probe.js');
const OO = require(path.join(ROOT, 'assets', 'js', 'memory-recall', 'outcome-observation-core.js'));
const { createRuntimeRealityEvent } = require(path.join(ROOT, 'services', 'home-node', 'runtime-reality-event.js'));
const { createTurnTerminalRealitySource } = require(path.join(ROOT, 'services', 'home-node', 'turn-terminal-reality-source.js'));
const { createRuntimeOutcomeObservation } = require(path.join(ROOT, 'services', 'home-node', 'runtime-outcome-observation.js'));
const { createRuntimePredictionRegistry } = require(path.join(ROOT, 'services', 'home-node', 'runtime-prediction-registry.js'));
const { createRuntimePredictionSettlement } = require(path.join(ROOT, 'services', 'home-node', 'runtime-prediction-settlement.js'));
const SETTLEMENT_CORE = require(path.join(ROOT, 'assets', 'js', 'memory-recall', 'prediction-settlement-core.js'));
const { createRuntimeBehaviorEffect } = require(path.join(ROOT, 'services', 'home-node', 'runtime-behavior-effect.js'));
const SRC_REL = 'services/home-node/turn-terminal-reality-source.js';

let passed = 0, failures = 0;
const check = (n, c, d) => {
  if (c) { passed++; console.log('  PASS  ' + n); return true; }
  failures++; console.error('  FAIL  ' + n + (d ? '  -> ' + JSON.stringify(d) : '')); return false;
};
const section = t => console.log('\n── ' + t + ' ──');
const P = (k, v) => console.log('  FACTS ' + k + ' = ' + v);
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const T0 = 1760000000000;
const TOKEN = 'runtime.turn_terminal.completed';
const SCOPE = { characterId: 'char_a', conversationId: 'dm:char_a', subjectKind: 'user', subjectLabel: '' };
const OPP = { required: true, existence: { present: true, authoritySource: 'CANONICAL_RUNTIME' }, consumedAt: T0 + 1500 };
const CLOSE = T0 + 86400000;

function build(over) {
  const o = over || {};
  return OO.buildOutcomeObservation({
    windowRef: { predictionId: 'p1', predictionCreatedAt: T0, opensAt: T0, closesAt: CLOSE },
    source: o.source || 'CANONICAL_RUNTIME',
    sourceInstance: o.sourceInstance || 'runtime.turn-execution',
    targetDomain: 'runtime_state', observedAt: T0 + 1000, completeness: 'point',
    scope: SCOPE, outcomeRef: { kind: 'token', token: o.token || TOKEN }, evidenceRefs: ['re1'],
    interventionContext: { behaviorEffectsInForce: [], predictionInfluencedSystem: null, contaminationClass: 'NONE', contaminationBasis: 'x' }
  });
}
function gate(built) { return OO.authorityGate(built.value, { expectedScope: SCOPE, opportunity: OPP }); }
function direction(token, si) {
  const b = build({ token: token, sourceInstance: si });
  if (!b.ok) return { token: token, build: false, errors: b.errors };
  const g = gate(b);
  return { token: token, build: true, effective: g.gateTrace.effectiveAdmissibility, support: g.gateTrace.directional.support, conflict: g.gateTrace.directional.conflict };
}
function makePrediction(token, over) {
  const o = over || {};
  const reg = o.registry || createRuntimePredictionRegistry({ clock: () => T0, attributionAuthority: o.attributionAuthority || null });
  return reg.projectFromValidatedExpectation({
    epistemicStatus: 'prediction', prediction: '本回合会正常完成',
    trigger: { kind: 'explicit-cue', label: 'l' }, evidenceMemoryIds: ['m1'],
    contradictoryEvidenceIds: [], generalizationLevel: 'episode-hypothesis',
    subjectivePredictionConfidence: 0.8, subject: { kind: 'user', label: '' },
    predicate: { kind: 'will-do' }, expectedOutcome: { kind: 'exclusive-outcome', token: token }
  }, {
    now: T0,
    characterId: o.characterId || 'char_a',
    conversationId: o.conversationId || 'dm:char_a',
    turnId: o.turnId || 'turn_r2',
    expectationIndex: o.expectationIndex || 0
  }).record;
}
function terminal(over) {
  return Object.freeze(Object.assign({
    turnId: 'turn_r2', characterId: 'char_a', conversationId: 'dm:char_a',
    requestCorrelationId: 'req_r2', outcome: 'completed', occurredAt: T0 + 1000
  }, over || {}));
}
function chain(token, opts) {
  const o = opts || {};
  const re = createRuntimeRealityEvent({});
  const src = createTurnTerminalRealitySource({ realityEvent: re });
  const be = createRuntimeBehaviorEffect({ clock: () => T0, logger: () => {} });
  const terminalFact = terminal(o.terminal);
  const registry = createRuntimePredictionRegistry({
    clock: () => T0,
    attributionAuthority: o.attribution === false ? null : be
  });
  const pred = makePrediction(token, {
    registry: registry,
    attributionAuthority: o.attribution === false ? null : be,
    turnId: terminalFact.turnId,
    expectationIndex: o.expectationIndex || 0
  });
  const pr = createRuntimeOutcomeObservation({
    registry: registry,
    isRealityEvent: re.isRealityEvent,
    attributionAuthority: o.attribution === false ? null : be
  });
  const ev = src.emit(terminalFact).realityEvent;
  const obs = pr.projectForPrediction({
    realityEvent: ev,
    predictionRef: {
      predictionId: pred.predictionId,
      opensAt: pred.observationWindow.opensAt,
      closesAt: pred.observationWindow.closesAt,
      predictionCreatedAt: pred.createdAt
    }
  });
  const cands = pr.candidatePredictions(ev, { characterId: o.characterId || 'char_a', conversationId: o.conversationId || 'dm:char_a' });
  return { re: re, src: src, pr: pr, ev: ev, obs: obs, cands: cands, registry: registry, prediction: pred, attributionAuthority: be };
}

(function main() {
  /* ══ A · token change ══ */
  section('A · directional token change');
  {
    check('A1.exactTokenPresent', OO.RUNTIME_STATE_TOKENS.indexOf(TOKEN) >= 0, OO.RUNTIME_STATE_TOKENS);
    check('A2.exactlyOneAddition',
      OO.RUNTIME_STATE_TOKENS.length === 21
      && ['delivery.queued', 'delivery.delivering', 'delivery.completed', 'delivery.cancelled', 'delivery.failed',
        'popup.shown', 'popup.dismissed', 'popup.answered', 'activity.available', 'activity.unavailable',
        'memory.record-written', 'memory.record-refused', 'runtime.turn_terminal',
        'runtime.turn_terminal.completed', 'runtime.turn_terminal.credential-unavailable',
        'runtime.turn_terminal.empty-output', 'runtime.turn_terminal.store-write-failed',
        'runtime.turn_terminal.abort', 'runtime.turn_terminal.timeout',
        'runtime.turn_terminal.cancelled', 'runtime.turn_terminal.provider-error']
        .every(t => OO.RUNTIME_STATE_TOKENS.indexOf(t) >= 0),
      '前 12 项与 generic terminal token 保留；增加 8 个实际 outcome token；总数 = ' + OO.RUNTIME_STATE_TOKENS.length);
    check('A3.noWildcardOrNearToken',
      OO.RUNTIME_STATE_TOKENS.every(t => t.indexOf('*') < 0)
      && OO.RUNTIME_STATE_TOKENS.indexOf('runtime.turn') < 0
      && OO.RUNTIME_STATE_TOKENS.indexOf('runtime.execution') < 0,
      OO.RUNTIME_STATE_TOKENS);
    check('A4.userActionTokensUntouched', OO.USER_ACTION_TOKENS.length === 9, OO.USER_ACTION_TOKENS.length);
    check('A5.frozen', Object.isFrozen(OO.RUNTIME_STATE_TOKENS), 'frozen');
  }

  /* ══ B · controlled experiment（before/after） ══ */
  section('B · controlled directional experiment');
  {
    const turn = direction(TOKEN, 'runtime.turn-execution');
    const ctl = [
      direction('delivery.completed', 'runtime.delivery'),
      direction('activity.available', 'runtime.activity'),
      direction('memory.record-written', 'runtime.memory-store')
    ];
    check('B1.turnTerminalNoLongerTokenForbidden',
      turn.build === true && turn.effective !== 'FORBIDDEN'
      && turn.support !== 'FORBIDDEN' && turn.conflict !== 'FORBIDDEN',
      turn);
    check('B2.controlsUnchanged',
      ctl.every(c => c.effective === 'ELIGIBLE' && c.support === 'ELIGIBLE' && c.conflict === 'ELIGIBLE'),
      ctl);
    check('B3.onlyVariableIsToken', (function () {
      const a = build({ token: TOKEN, sourceInstance: 'runtime.turn-execution' });
      const b = build({ token: 'delivery.completed', sourceInstance: 'runtime.turn-execution' });
      return a.ok && b.ok
        && gate(a).gateTrace.effectiveAdmissibility === gate(b).gateTrace.effectiveAdmissibility;
    })(), '同一 sourceInstance 下两种 token 现在同档');
    P('BEFORE.runtime.turn_terminal', 'FORBIDDEN / FORBIDDEN / FORBIDDEN');
    P('AFTER.runtime.turn_terminal', turn.effective + ' / ' + turn.support + ' / ' + turn.conflict);
  }

  /* ══ C · exactness / laundering ══ */
  section('C · exactness & laundering');
  {
    const near = ['runtime.turn_terminal.foo', 'runtime.turn', 'runtime.turn-terminal', 'runtime.fake', 'delivery.completed'];
    check('C1.nearTokensAreDistinctVocabulary', (function () {
      /* 近似 token 不在词表；且 runtime.turn_terminal 是精确成员 */
      return near.slice(0, 4).every(t => OO.RUNTIME_STATE_TOKENS.indexOf(t) < 0)
        && OO.RUNTIME_STATE_TOKENS.indexOf(TOKEN) >= 0;
    })(), near);
    check('C2.tokenDoesNotSubstituteForObserverAdmission',
      (build({ token: TOKEN, sourceInstance: 'runtime.fake' }).errors || [])
        .some(e => String(e).indexOf('unauthorized-source-instance') === 0),
      'token 正确但 sourceInstance 错 ⇒ 仍 fail authority');
    check('C3.tokenDoesNotUpgradeSourceClass',
      build({ token: TOKEN, source: 'MODEL_INFERENCE' }).ok === false,
      'SOURCE_TOKEN DOES NOT UPGRADE SOURCE_CLASS');
    check('C4.plainObjectForgedObservationNotSealed',
      OO.isBuiltObservation({ source: 'CANONICAL_RUNTIME', sourceInstance: 'runtime.turn-execution', outcomeRef: { token: TOKEN } }) === false,
      '无 capability seal');
    check('C5.realityAuthorityStillBlocksWrongDomainType', (function () {
      const re = createRuntimeRealityEvent({});
      const a = re.ingest({ sourceId: 'turn-terminal', sourceEvent: { eventId: 'e', domain: 'preference', type: 'turn_terminal', entityId: 'x', timestamp: T0 } });
      const b = re.ingest({ sourceId: 'turn-terminal', sourceEvent: { eventId: 'e2', domain: 'runtime', type: 'turn_started', entityId: 'x', timestamp: T0 } });
      return a.ok === false && b.ok === false;
    })(), 'token 入表未绕过 Reality source allowlist');
    check('C6.p1CoreHasNoSettlementAuthority', (function () {
      const c = read('assets/js/memory-recall/outcome-observation-core.js');
      return c.indexOf("settlementState = 'matched'") < 0 && c.indexOf('ingestSettlement') < 0;
    })(), 'P1 仍只判定准入');
    check('C7.adapterStillThin',
      ['settlePrediction', 'computeSettlement', 'ingestSettlement'].every(s => read(SRC_REL).indexOf(s) < 0),
      'adapter 无 settlement authority');
  }

  /* ══ D · zero / one / multi pair ══ */
  section('D · pairing cardinality');
  {
    const zero = chain(TOKEN);
    check('D1.zeroPairIsLegal', zero.re.heldEventCount() === 1, { realityEvent: zero.re.heldEventCount() });
    check('D2.onePairCounts',
      zero.ev !== null && zero.obs.ok === true && T0 + 1000 === zero.obs.observation.observedAt,
      { obs: zero.obs.ok });
    check('D3.multiPairSharesOneRealityEvent', (function () {
      const l = chain(TOKEN);
      const second = makePrediction(TOKEN, {
        registry: l.registry, turnId: l.prediction.sourceExpectationRef.turnId, expectationIndex: 1
      });
      const records = [l.prediction, second];
      const two = records.map(record => l.pr.projectForPrediction({
        realityEvent: l.ev,
        predictionRef: {
          predictionId: record.predictionId,
          opensAt: record.observationWindow.opensAt,
          closesAt: record.observationWindow.closesAt,
          predictionCreatedAt: record.createdAt
        }
      }));
      return l.re.heldEventCount() === 1
        && two.every(r => r.ok === true)
        && new Set(two.map(r => r.realityEventRef)).size === 1
        && new Set(two.map(r => r.observation.observationId)).size === 2;
    })(), 'one RealityEvent → two projections, distinct observationIds');
    check('D4.realityIdentityIndependentOfPrediction', (function () {
      /* 排除 FORBIDDEN_INPUT_KEYS 声明与注释（声名其非法 ≠ 使用它） */
      const c = WIRING.stripJsComments(read(SRC_REL)).replace(/FORBIDDEN_INPUT_KEYS[\s\S]*?\]/, '');
      return c.indexOf('predictionId') < 0;
    })(), 'identity 不含 predictionId');
    check('D5.lineageIsEvidenceRefs0',
      zero.pr.realityEventRefOf(zero.obs.observation) === zero.ev.realityEventId,
      zero.obs.observation.evidenceRefs[0]);
    check('D6.scopePreserved',
      zero.obs.observation.scope.characterId === 'char_a'
      && zero.obs.observation.scope.conversationId === 'dm:char_a'
      && zero.ev.characterId === 'char_a' && zero.ev.conversationId === 'dm:char_a',
      zero.obs.observation.scope);
    check('D7.attributionQueriedAtEventTime',
      zero.obs.attribution.at === T0 + 1000,
      { at: zero.obs.attribution.at });
    check('D8.wrongScopePredictionDoesNotPair', (function () {
      const c = chain(TOKEN);
      const other = c.pr.candidatePredictions(c.ev, { characterId: 'char_b', conversationId: 'dm:char_b' });
      return Array.isArray(other) && other.length === 0;
    })(), 'token admission 未绕过 scope');
  }

  /* ══ E · decisive settlement（真实闭环） ══ */
  section('E · decisive settlement');
  {
    const c = chain(TOKEN);
    const pred = c.prediction;
    const st = createRuntimePredictionSettlement({ clock: () => T0 });
    const r = st.settlePrediction(pred, [{ observation: c.obs.observation }], { now: T0 + 2000 });
    P('E2E.TurnTerminalFact', 1);
    P('E2E.RealityEvent', c.re.heldEventCount());
    P('E2E.OutcomeObservation', c.obs.ok ? 1 : 0);
    P('E2E.SettlementState', r.settlement.state);
    P('E2E.CalibrationCounted', r.settlement.calibrationCounted);
    P('E2E.MatcherCalls', 0);
    check('E1.reachesDecisiveSettlement',
      r.settlement.state === 'matched',
      { state: r.settlement.state, reasons: r.settlement.reasonCodes });
    check('E2.calibrationCountedOnlyFromP3',
      r.settlement.calibrationCounted === true
      && WIRING.stripJsComments(read(SRC_REL)).replace(/FORBIDDEN_INPUT_KEYS[\s\S]*?\]/, '').indexOf('calibrationCounted') < 0,
      'adapter 从未写 calibrationCounted');
    check('E3.exclusiveTerminalMismatchIsConflictButOpportunityStillGatesMissed', (function () {
      const l = chain(TOKEN, { terminal: { outcome: 'store-write-failed' } });
      const relation = SETTLEMENT_CORE.classifyRelation(l.prediction, l.obs.observation);
      const s2 = createRuntimePredictionSettlement({ clock: () => T0 });
      const rr = s2.settlePrediction(l.prediction, [{ observation: l.obs.observation }], { now: CLOSE + 1 });
      return relation === 'conflict'
        && rr.settlement.state !== 'missed'
        && rr.settlement.opportunityState === 'UNKNOWN'
        && rr.settlement.calibrationCounted === false;
    })(), 'mechanical conflict is not an opportunity witness');
    check('E4.matchedNeverProducedByTokenAlone', (function () {
      /* unrelated runtime proposition is irrelevant to a terminal outcome Prediction */
      const other = makePrediction('delivery.completed', { turnId: c.prediction.sourceExpectationRef.turnId });
      const s3 = createRuntimePredictionSettlement({ clock: () => T0 });
      return SETTLEMENT_CORE.classifyRelation(other, c.obs.observation) === 'irrelevant'
        && s3.settlePrediction(other, [{ observation: c.obs.observation }], { now: CLOSE + 1 }).settlement.state !== 'matched';
    })(), 'unrelated event proposition does not become terminal conflict or support');
  }

  /* ══ F · production subscriber audit ══ */
  section('F · production subscriber');
  {
    const feedback = read('services/home-node/runtime-reality-feedback.js');
    const service = read('services/home-node-service.js');
    check('F1.productionSubscriberPairsAndProjectsCanonicalFacts',
      feedback.indexOf('observationRuntime.candidatePredictions') >= 0
      && feedback.indexOf('observationRuntime.projectForPrediction') >= 0
      && service.indexOf('onRealityEventMinted: function (realityEvent)') >= 0,
      'canonical RealityEvent subscriber → Registry pairing → P1 projection');
    check('F2.realitySourceIsProductionWired',
      (read('services/home-node-service.js').match(/onTurnTerminal: buildTurnTerminalSink\(/g) || []).length === 2,
      'executor terminal sink 已接线');
    P('MECHANICAL_FEEDBACK_LOOP_PRODUCTION_LIVE', 'YES');
    P('EVENT_PRODUCTION_PREDICTION_CREATION', 'LIVE · runtime.turn_terminal only');
    P('BLOCKER', 'latent_state / relational / arbitrary event remain disabled');
  }

  /* ══ G · readiness ══ */
  section('G · readiness');
  {
    P('RUNTIME_TURN_TERMINAL_DIRECTIONAL_TOKEN', 'YES');
    P('AUTHORIZED_DIRECTIONAL_TOKEN', TOKEN);
    P('TOKEN_ALLOWED_FOR_DIRECTIONAL_EVALUATION', 'YES');
    P('REALITY_EVENT_SOURCE_LIVE', 'YES');
    P('OUTCOME_OBSERVATION_PRODUCTION_CALLER_LIVE', 'YES');
    P('MECHANICAL_FEEDBACK_LOOP_PRODUCTION_LIVE', 'YES');
    P('EVENT_PRODUCTION_PREDICTION_CREATION', 'LIVE · runtime.turn_terminal only');
    P('EVIDENCE_MATCHER_ENABLED_DEFAULT', false);
    P('CALIBRATION_CONFIDENCE', 'null');
    P('CALIBRATION_APPLIED_TO_LIVE', 'NO');
  }

  console.log('\n' + '='.repeat(64));
  if (failures) {
    console.error('TURN TERMINAL DIRECTIONAL ADMISSION FAILED · ' + failures + ' assertion(s), ' + passed + ' passed');
    process.exit(1);
  }
  console.log('TURN TERMINAL DIRECTIONAL ADMISSION PASSED · ' + passed + ' assertions green');
})();
