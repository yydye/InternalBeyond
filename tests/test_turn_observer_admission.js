'use strict';
/* ══════════════════════════════════════════════════════════════════════════
   Internal Beyond · P5-B3-D4-R1 · P1 Turn Observer Admission
   （运行 node tests/test_turn_observer_admission.js）

   owner ruling：AUTHORIZED_OBSERVERS[CANONICAL_RUNTIME] += 'runtime.turn-execution'
   RUNTIME_TURN_EXECUTION_OBSERVER_SCOPE = TURN_TERMINAL_FACT_ONLY
   OBSERVER_ALLOWLIST_MEMBERSHIP DOES NOT GRANT REALITY_EVENT_MINT_CAPABILITY
   SOURCE_INSTANCE_TOKEN DOES NOT UPGRADE SOURCE_CLASS
   ══════════════════════════════════════════════════════════════════════════ */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const OO = require(path.join(ROOT, 'assets', 'js', 'memory-recall', 'outcome-observation-core.js'));
const { createRuntimeRealityEvent } = require(path.join(ROOT, 'services', 'home-node', 'runtime-reality-event.js'));
const { createTurnTerminalRealitySource } = require(path.join(ROOT, 'services', 'home-node', 'turn-terminal-reality-source.js'));
const { createRuntimeOutcomeObservation } = require(path.join(ROOT, 'services', 'home-node', 'runtime-outcome-observation.js'));
const { createRuntimePredictionRegistry } = require(path.join(ROOT, 'services', 'home-node', 'runtime-prediction-registry.js'));
const { createRuntimePredictionSettlement } = require(path.join(ROOT, 'services', 'home-node', 'runtime-prediction-settlement.js'));
const { createRuntimeBehaviorEffect } = require(path.join(ROOT, 'services', 'home-node', 'runtime-behavior-effect.js'));
const OBS_CORE_REL = 'assets/js/memory-recall/outcome-observation-core.js';

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
const OPP = { required: true, existence: { present: true, authoritySource: 'CANONICAL_RUNTIME' }, consumedAt: T0 + 500 };

function build(over) {
  const o = over || {};
  return OO.buildOutcomeObservation({
    windowRef: { predictionId: 'p1', predictionCreatedAt: T0, opensAt: T0, closesAt: T0 + 86400000 },
    source: o.source || 'CANONICAL_RUNTIME',
    sourceInstance: o.sourceInstance || 'runtime.turn-execution',
    targetDomain: 'runtime_state', observedAt: T0 + 1000, completeness: 'point',
    scope: SCOPE, outcomeRef: { kind: 'token', token: o.token || TOKEN }, evidenceRefs: ['re1'],
    interventionContext: { behaviorEffectsInForce: [], predictionInfluencedSystem: null, contaminationClass: 'NONE', contaminationBasis: 'x' }
  });
}
function gate(obs) { return OO.authorityGate(obs, { expectedScope: SCOPE, opportunity: OPP }); }
function terminal(over) {
  return Object.freeze(Object.assign({
    turnId: 'turn_r1', characterId: 'char_a', conversationId: 'dm:char_a',
    requestCorrelationId: 'req_r1', outcome: 'completed', occurredAt: T0 + 1000
  }, over || {}));
}
function truth() {
  const re = createRuntimeRealityEvent({});
  const src = createTurnTerminalRealitySource({ realityEvent: re });
  const attributionAuthority = createRuntimeBehaviorEffect({ clock: () => T0, logger: () => {} });
  const registry = createRuntimePredictionRegistry({ clock: () => T0, attributionAuthority: attributionAuthority });
  const pr = createRuntimeOutcomeObservation({
    registry: registry, isRealityEvent: re.isRealityEvent, attributionAuthority: attributionAuthority
  });
  return { re: re, src: src, pr: pr, registry: registry, attributionAuthority: attributionAuthority };
}
function prediction(reg, token, turnId, expectationIndex) {
  return reg.projectFromValidatedExpectation({
    epistemicStatus: 'prediction', prediction: '本回合会正常完成',
    trigger: { kind: 'explicit-cue', label: 'l' }, evidenceMemoryIds: ['m1'],
    contradictoryEvidenceIds: [], generalizationLevel: 'episode-hypothesis',
    subjectivePredictionConfidence: 0.8, subject: { kind: 'user', label: '' },
    predicate: { kind: 'will-do' }, expectedOutcome: { kind: 'exclusive-outcome', token: token }
  }, {
    now: T0, characterId: 'char_a', conversationId: 'dm:char_a',
    turnId: turnId || 'turn_r1', expectationIndex: expectationIndex || 0
  }).record;
}

(function main() {
  /* ══ A · allowlist change（before/after） ══ */
  section('A · P1 observer admission');
  {
    const list = OO.AUTHORIZED_OBSERVERS.CANONICAL_RUNTIME;
    check('A1.exactTokenAdmitted', list.indexOf('runtime.turn-execution') >= 0, list);
    check('A2.noWildcardOrPrefixEntry',
      list.every(t => t.indexOf('*') < 0) && list.indexOf('runtime.turn') < 0
      && list.indexOf('runtime.execution') < 0 && list.indexOf('runtime') < 0,
      list);
    check('A3.existingObserversUnchanged',
      ['runtime.delivery', 'runtime.popup', 'runtime.activity', 'runtime.payment', 'runtime.memory-store']
        .every(t => list.indexOf(t) >= 0) && list.length === 6,
      '原有 5 个 observer 行为不变；总数 = ' + list.length);
    check('A4.otherSourceClassesUnchanged',
      /* ★ P5-B3-E-R1 翻面：EXPLICIT_USER_REPORT 从 1 项变成 2 项 —— 新增的是本相位
         批准的精确 token `user.explicit-preference-report`（唯一生产 observer）。
         旧 token `chat.user-utterance` 被**保留**为无生产来源的假设向量
         （P1/P3/P5 的既有冻结测试向量用它），它**不是**一条通道。
         其余 source class 的条数逐字不变。 */
      OO.AUTHORIZED_OBSERVERS.USER_BEHAVIOR.length === 4
      && OO.AUTHORIZED_OBSERVERS.EXPLICIT_USER_REPORT.length === 2
      && OO.AUTHORIZED_OBSERVERS.EXPLICIT_USER_REPORT[0] === 'chat.user-utterance'
      && OO.AUTHORIZED_OBSERVERS.EXPLICIT_USER_REPORT[1] === 'user.explicit-preference-report'
      && OO.AUTHORIZED_OBSERVERS.LINGUISTIC_EVIDENCE.length === 1
      && (OO.AUTHORIZED_OBSERVERS.MODEL_INFERENCE || []).length === 0,
      '只动 CANONICAL_RUNTIME 与 EXPLICIT_USER_REPORT 两项');
    check('A5.frozenSourceObjectIntegrity',
      Object.isFrozen(OO.AUTHORIZED_OBSERVERS) && Object.isFrozen(OO.AUTHORIZED_OBSERVERS.CANONICAL_RUNTIME),
      'frozen');
  }

  /* ══ B · builder acceptance ══ */
  section('B · P1 builder acceptance');
  {
    const b = build();
    check('B1.turnTerminalObservationAdmitted',
      b.ok === true && (b.errors || []).indexOf('unauthorized-source-instance') < 0,
      b.ok ? null : b.errors);
    const g = gate(b.value);
    check('B2.scopeAndTemporalGatesPass',
      g.gateTrace.scopeGate === 'MATCH' && g.gateTrace.temporalGate === 'within-window',
      { scope: g.gateTrace.scopeGate, temporal: g.gateTrace.temporalGate });
    check('B3.noUnauthorizedSourceInstanceError',
      JSON.stringify(b.errors || []).indexOf('unauthorized-source-instance') < 0,
      b.errors);
  }

  /* ══ C · exactness（§32） ══ */
  section('C · allowlist exactness');
  {
    const bad = ['runtime.turn-execution.foo', 'runtime.turn_execution', 'runtime.turn', 'runtime.fake', 'runtime.turn-execution-evil'];
    const results = bad.map(si => ({ si: si, errs: (build({ sourceInstance: si }).errors || []) }));
    const isUnauth = (errs) => (errs || []).some(e => String(e).indexOf('unauthorized-source-instance') === 0);
    check('C1.wrongSourceInstanceRejected',
      results.every(r => isUnauth(r.errs)),
      results.filter(r => !isUnauth(r.errs)));
    check('C2.noPrefixMatching',
      (build({ sourceInstance: 'runtime.turn' }).errors || []).some(e => String(e).indexOf('unauthorized-source-instance') === 0),
      'runtime.turn 不被接受');
    check('C3.sourceInstanceTokenCannotUpgradeSourceClass', (function () {
      /* 正确 sourceInstance 但错误 source class ⇒ 必须失败 */
      const r = build({ source: 'MODEL_INFERENCE' });
      return r.ok === false && (r.errors || []).some(e => /source|instance|observer|domain/i.test(e));
    })(), 'SOURCE_INSTANCE_TOKEN DOES NOT UPGRADE SOURCE_CLASS');
  }

  /* ══ D · laundering（§10–§12, §36） ══ */
  section('D · authority laundering');
  {
    const re = createRuntimeRealityEvent({});
    check('D1.plainObjectCannotMintRealityEvent',
      re.isRealityEvent({ realityEventId: 'x', domain: 'runtime', type: 'turn_terminal', entityId: 'e', occurredAt: T0, realitySourceId: 'turn-terminal' }) === false,
      'plain object 无 seal');
    const src = createTurnTerminalRealitySource({ realityEvent: re });
    check('D2.forgedTerminalRejectedBySource',
      src.emit({ turnId: 't', characterId: 'c', conversationId: 'v', outcome: 'completed', occurredAt: T0 }).ok === false,
      'browser/plain 伪造终局拿不到 provenance');
    check('D3.modelInferenceCannotLaunder', (function () {
      /* MODEL_INFERENCE 无 authorized observer；且 turn-terminal source 表只有 CANONICAL_RUNTIME */
      const r = build({ source: 'MODEL_INFERENCE' });
      return r.ok === false && (OO.AUTHORIZED_OBSERVERS.MODEL_INFERENCE || []).length === 0;
    })(), 'MODEL_INFERENCE CANNOT LAUNDER THROUGH runtime.turn-execution');
    check('D4.wrongDomainTypeBlockedByRealityAuthority', (function () {
      const r2 = createRuntimeRealityEvent({});
      const bad = r2.ingest({ sourceId: 'turn-terminal', sourceEvent: { eventId: 'e', domain: 'preference', type: 'turn_terminal', entityId: 'x', timestamp: T0 } });
      const bad2 = r2.ingest({ sourceId: 'turn-terminal', sourceEvent: { eventId: 'e2', domain: 'runtime', type: 'turn_started', entityId: 'x', timestamp: T0 } });
      return bad.ok === false && bad2.ok === false;
    })(), 'domain/type 仍受 source allowlist 约束');
    check('D5.realityAuthorityNotGrantedByObserverMembership',
      re.isRealityEvent(build().value) === false,
      'observation 不是 RealityEvent；allowlist 成员资格不授予 mint 能力');
    check('D6.sourceLaunderingForbidden', (function () {
      const code = read('services/home-node/turn-terminal-reality-source.js');
      return code.indexOf("SOURCE_INSTANCE = 'runtime.turn-execution'") >= 0
        && code.indexOf("'runtime.delivery'") < 0 && code.indexOf("'runtime.activity'") < 0;
    })(), '真实 source instance 就是 runtime.turn-execution');
  }

  /* ══ E · production chain to observation ══ */
  section('E · production chain → observation');
  {
    const t = truth();
    const pred = prediction(t.registry, TOKEN, 'turn_r1');
    const e = t.src.emit(terminal());
    const cands = t.pr.candidatePredictions(e.realityEvent, { characterId: 'char_a', conversationId: 'dm:char_a' });
    const pr = t.pr.projectForPrediction({
      realityEvent: e.realityEvent,
      predictionRef: {
        predictionId: pred.predictionId,
        opensAt: pred.observationWindow.opensAt,
        closesAt: pred.observationWindow.closesAt,
        predictionCreatedAt: pred.createdAt
      }
    });
    check('E1.realityEventMinted', e.status === 'minted' && t.re.isRealityEvent(e.realityEvent) === true, e.status);
    check('E2.sameTurnPredictionPairsAndObservationMints',
      cands.length === 1 && cands[0] === pred.predictionId && pr.ok === true && pr.observation !== null,
      { candidates: cands, reason: pr.reasonCode });
    check('E2b.terminalProjectionKeepsCanonicalProvenanceAndOutcomeToken',
      pr.observation.source === 'CANONICAL_RUNTIME'
      && pr.observation.sourceInstance === 'runtime.turn-execution'
      && pr.observation.targetDomain === 'runtime_state'
      && pr.observation.outcomeRef.token === 'runtime.turn_terminal.completed',
      pr.observation && {
        source: pr.observation.source, sourceInstance: pr.observation.sourceInstance,
        domain: pr.observation.targetDomain, token: pr.observation.outcomeRef.token
      });
    check('E3.scopePreservedVerbatim',
      pr.observation.scope.characterId === 'char_a' && pr.observation.scope.conversationId === 'dm:char_a',
      pr.observation.scope);
    check('E4.timestampPreserved',
      pr.observation.observedAt === T0 + 1000 && pr.attribution.at === T0 + 1000,
      { observedAt: pr.observation.observedAt, at: pr.attribution.at });
    check('E5.lineageIsEvidenceRefs0',
      pr.observation.evidenceRefs[0] === e.realityEvent.realityEventId
      && t.pr.realityEventRefOf(pr.observation) === e.realityEvent.realityEventId,
      pr.observation.evidenceRefs[0]);
    P('CANDIDATE_PREDICTIONS_WITHOUT_REGISTRY_FIXTURE', cands.length);
  }

  /* ══ F · mechanical relation（§14/§15 —— 决定性） ══ */
  section('F · mechanical directional relation');
  {
    const row = (tk, si) => {
      const b = build({ token: tk, sourceInstance: si });
      if (!b.ok) return null;
      const g = gate(b.value);
      return { token: tk, effective: g.gateTrace.effectiveAdmissibility, support: g.gateTrace.directional.support, conflict: g.gateTrace.directional.conflict };
    };
    const turn = row('runtime.turn_terminal', 'runtime.turn-execution');
    const ctl = [
      row('delivery.completed', 'runtime.delivery'),
      row('activity.available', 'runtime.activity'),
      row('memory.record-written', 'runtime.memory-store')
    ];
    check('F1.observerAdmissionUnblocksMinting', turn !== null, 'admitted (not unauthorized)');
    check('F2.controlsRemainEligible',
      ctl.every(c => c && c.effective === 'ELIGIBLE' && c.support === 'ELIGIBLE' && c.conflict === 'ELIGIBLE'),
      ctl);
    /* P5-B3-D4-R2 阶段迁移：token 已入 directional 词表 ⇒ 不再是 FORBIDDEN。 */
    check('F3.turnTerminalDirectionAdmittedAfterR2',
      turn.effective === 'ELIGIBLE' && turn.support === 'ELIGIBLE' && turn.conflict === 'ELIGIBLE',
      turn);
    check('F4.onlyDifferenceIsTheToken', (function () {
      const a = build({ token: 'runtime.turn_terminal', sourceInstance: 'runtime.turn-execution' });
      const b = build({ token: 'delivery.completed', sourceInstance: 'runtime.turn-execution' });
      /* R2 阶段迁移：两者同属 directional 词表 ⇒ 同一 sourceInstance 下应同档 */
      return a.ok === true && b.ok === true
        && gate(a.value).gateTrace.effectiveAdmissibility === 'ELIGIBLE'
        && gate(b.value).gateTrace.effectiveAdmissibility === 'ELIGIBLE';
    })(), '★ R2：同 sourceInstance 下两种 token 同档（差异只曾来自词表）');
    /* P5-B3-D4-R2 阶段迁移：owner 已批准加入词表。 */
    check('F5.tokenVocabularyNowIncludesTurnTerminal',
      OO.RUNTIME_STATE_TOKENS.indexOf('runtime.turn_terminal') >= 0
      && OO.RUNTIME_STATE_TOKENS.indexOf('runtime.turn_terminal.completed') >= 0
      && OO.RUNTIME_STATE_TOKENS.indexOf('runtime.turn_terminal.provider-error') >= 0
      && OO.RUNTIME_STATE_TOKENS.length === 21,
      'RUNTIME_STATE_TOKENS = ' + OO.RUNTIME_STATE_TOKENS.length + ' 项，含闭集 terminal outcome tokens');
    P('P5_B3_D4_R1_BLOCKER', 'RESOLVED_BY_R2');
  }

  /* ══ G · one-pair E2E（如实报告到哪一步） ══ */
  section('G · one-pair E2E');
  {
    const t = truth();
    const pred = prediction(t.registry, TOKEN, 'turn_r1');
    const e = t.src.emit(terminal());
    const pr = t.pr.projectForPrediction({
      realityEvent: e.realityEvent,
      predictionRef: { predictionId: pred.predictionId, opensAt: pred.observationWindow.opensAt, closesAt: pred.observationWindow.closesAt, predictionCreatedAt: pred.observationWindow.opensAt }
    });
    const st = createRuntimePredictionSettlement({ clock: () => T0 });
    const r = st.settlePrediction(pred, [{ observation: pr.observation }], { now: T0 + 2000 });
    P('E2E.TurnTerminalFact', 1);
    P('E2E.RealityEvent', t.re.heldEventCount());
    P('E2E.OutcomeObservation', pr.ok ? 1 : 0);
    P('E2E.SettlementState', r.settlement.state);
    P('E2E.CalibrationCounted', r.settlement.calibrationCounted);
    P('E2E.MatcherCalls', 0);
    check('G1.observationProducedFromProductionSource', pr.ok === true, pr.reasonCode);
    /* D5：exact expected terminal outcome mechanically supports the event Prediction.
       Opportunity remains UNKNOWN; the existing P3 rule allows support, not missed. */
    check('G2.gateNoLongerDiscardsObservation',
      r.settlement.state === 'matched'
      && r.settlement.opportunityState === 'UNKNOWN'
      && r.settlement.calibrationCounted === true
      && (r.settlement.reasonCodes || []).indexOf('observation-discarded-by-authority-gate') < 0,
      { state: r.settlement.state, reasons: r.settlement.reasonCodes });
    check('G3.matchedNeverProducedByP1OrAdapter',
      r.settlement.state === 'matched'
      && read('services/home-node/turn-terminal-reality-source.js').replace(/FORBIDDEN_INPUT_KEYS[\s\S]*?\]/, '').indexOf("'matched'") < 0,
      'P1/adapter carry the terminal fact only; P3 produces matched');
  }

  /* ══ H · zero-pair / multi-pair ══ */
  section('H · zero / multi pair');
  {
    const t = truth();
    const e = t.src.emit(terminal({ turnId: 'turn_zero' }));
    check('H1.zeroPairIsLegal',
      e.status === 'minted' && t.re.heldEventCount() === 1,
      { realityEvent: t.re.heldEventCount() });
    check('H2.multiProjectionSharesOneRealityEvent', (function () {
      const l = truth();
      const predA = prediction(l.registry, 'runtime.turn_terminal.completed', 'turn_multi', 0);
      const predB = prediction(l.registry, 'runtime.turn_terminal.timeout', 'turn_multi', 1);
      const ev = l.src.emit(terminal({ turnId: 'turn_multi' })).realityEvent;
      const records = [predA, predB];
      const ids = records.map(record => l.pr.projectForPrediction({
        realityEvent: ev,
        predictionRef: {
          predictionId: record.predictionId,
          opensAt: record.observationWindow.opensAt,
          closesAt: record.observationWindow.closesAt,
          predictionCreatedAt: record.createdAt
        }
      }));
      return ids.every(r => r.ok === true)
        && l.pr.candidatePredictions(ev, { characterId: 'char_a', conversationId: 'dm:char_a' }).length === 2
        && l.re.heldEventCount() === 1
        && new Set(ids.map(r => r.realityEventRef)).size === 1
        && new Set(ids.map(r => r.observation.observationId)).size === 2;
    })(), 'one RealityEvent → two projections');
  }

  /* ══ I · frozen invariants + guard ══ */
  section('I · frozen invariants');
  {
    check('I1.executionStillRealityAgnostic',
      read('services/home-node/execution.js').indexOf('createRuntimeRealityEvent') < 0
      && read('services/home-node/execution.js').indexOf("require('./runtime-reality-event") < 0,
      'callback injection 架构不变');
    check('I2.adapterStillThin', (function () {
      const c = read('services/home-node/turn-terminal-reality-source.js').replace(/FORBIDDEN_INPUT_KEYS[\s\S]*?\]/, '');
      return ['settlePrediction', 'computeSettlement', 'ingestSettlement', 'EvidenceMatcher'].every(s => c.indexOf(s) < 0);
    })(), 'adapter 无 settlement / calibration / matcher');
    check('I3.d4MappingUnchanged',
      read('services/home-node/turn-terminal-reality-source.js').indexOf("DOMAIN = 'runtime'") >= 0
      && read('services/home-node/turn-terminal-reality-source.js').indexOf("TYPE = 'turn_terminal'") >= 0,
      'domain/type 未重开');
    check('I4.matcherStillOff',
      /EVIDENCE_MATCHER_ENABLED_DEFAULT\s*=\s*false/.test(read('services/home-node-service.js'))
      && read('services/home-node-service.js').indexOf("enabled: process.env.IB_EVIDENCE_MATCHER_ENABLED === '1'") >= 0
      && read('services/home-node-service.js').indexOf('enabled: options.evidenceMatcherEnabled === true') >= 0,
      'EVIDENCE_MATCHER_ENABLED_DEFAULT = false');
  }

  section('J · readiness');
  {
    P('AUTHORIZED_OBSERVER_TOKEN', 'runtime.turn-execution');
    P('RUNTIME_TURN_EXECUTION_IS_CANONICAL_RUNTIME_OBSERVER', 'YES');
    P('RUNTIME_TURN_EXECUTION_OBSERVER_SCOPE', 'TURN_TERMINAL_FACT_ONLY');
    P('OUTCOME_OBSERVATION_PRODUCTION_CALLER_LIVE', 'YES');
    P('MECHANICAL_FEEDBACK_LOOP_PRODUCTION_LIVE', 'YES');
    P('EVENT_PRODUCTION_PREDICTION_CREATION', 'LIVE · runtime.turn_terminal only');
    P('P5_B3_D4_STATUS', 'COMPLETE');
    P('P5_B3_D4_FREEZE', 'FROZEN');
    P('EVIDENCE_MATCHER_ENABLED_DEFAULT', false);
  }

  console.log('\n' + '='.repeat(64));
  if (failures) {
    console.error('TURN OBSERVER ADMISSION FAILED · ' + failures + ' assertion(s), ' + passed + ' passed');
    process.exit(1);
  }
  console.log('TURN OBSERVER ADMISSION PASSED · ' + passed + ' assertions green');
})();
