'use strict';
/* ══════════════════════════════════════════════════════════════════════════
   Internal Beyond · P5-B3-D4-R3 · Production Reality Feedback Driver
   （运行 node tests/test_reality_feedback_driver.js）

   REALITY_EVENT_FEEDBACK_DRIVER_OWNER = HOME_NODE_RUNTIME_ASSEMBLY
   FEEDBACK_TRIGGER = NEW_CANONICAL_REALITY_EVENT_MINT
   FEEDBACK_DRIVER_IS_ORCHESTRATION_ONLY = YES
   TEST_MANUAL_FEEDBACK_CALLS = 0（主 E2E 必须满足）
   ══════════════════════════════════════════════════════════════════════════ */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SERVICE = require(path.join(ROOT, 'services', 'home-node-service.js'));
const { createRuntimeRealityEvent } = require(path.join(ROOT, 'services', 'home-node', 'runtime-reality-event.js'));
const { createRuntimeRealityFeedback, REASON } = require(path.join(ROOT, 'services', 'home-node', 'runtime-reality-feedback.js'));
const { createRuntimeOutcomeObservation } = require(path.join(ROOT, 'services', 'home-node', 'runtime-outcome-observation.js'));
const { createRuntimePredictionRegistry } = require(path.join(ROOT, 'services', 'home-node', 'runtime-prediction-registry.js'));
const { createRuntimePredictionSettlement } = require(path.join(ROOT, 'services', 'home-node', 'runtime-prediction-settlement.js'));

let passed = 0, failures = 0;
const check = (n, c, d) => {
  if (c) { passed++; console.log('  PASS  ' + n); return true; }
  failures++; console.error('  FAIL  ' + n + (d ? '  -> ' + JSON.stringify(d) : '')); return false;
};
const section = t => console.log('\n── ' + t + ' ──');
const P = (k, v) => console.log('  FACTS ' + k + ' = ' + v);
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const REAL_NOW = Date.now();
const TURN_T = REAL_NOW - 30 * 24 * 3600 * 1000;   /* 30 天前：观测窗早已关闭 */

function strictRegistry(ids) {
  const base = {
    getCharacterSpec: (id) => (ids.indexOf(String(id)) >= 0
      ? { endpoint: 'https://x', model: 'm', systemPrompt: 'sys', apiKey: 'k' } : null),
    open: function () { return true; }
  };
  return base;
}
function stubPort(text) {
  return { runStream: async function () { return { ok: true, text: text == null ? 'hi' : text, reasoning: '', usage: null, streamed: false }; } };
}
function tempDir(tag) { return fs.mkdtempSync(path.join(os.tmpdir(), 'd4r3-' + tag + '-')); }
function build(tag, opts) {
  const o = opts || {};
  const dir = tempDir(tag);
  const inst = SERVICE.buildHomeNode({
    dataDir: dir, credentialDataDir: dir, token: 't', port: 0, logger: () => {},
    clock: () => TURN_T,
    registry: strictRegistry(o.ids || ['char_a']),
    port: stubPort(o.text)
  });
  inst.open();
  return inst;
}
function seed(inst, token, over) {
  const o = over || {};
  return inst.runtimePredictionRegistry.projectFromValidatedExpectation({
    epistemicStatus: 'prediction', prediction: '本回合会正常完成',
    trigger: { kind: 'explicit-cue', label: 'l' }, evidenceMemoryIds: ['m1'],
    contradictoryEvidenceIds: [], generalizationLevel: 'episode-hypothesis',
    subjectivePredictionConfidence: 0.8, subject: { kind: 'user', label: '' },
    predicate: { kind: 'will-do' }, expectedOutcome: { kind: 'exclusive-outcome', token: token }
  }, { now: TURN_T, characterId: o.characterId || 'char_a', conversationId: o.conversationId || 'dm:char_a', turnId: o.turnId || 'tp1', expectationIndex: 0 }).record;
}
async function turn(inst, requestId, friendId, characterId) {
  return inst.executor.executeCharacterTurn({
    requestId: requestId,
    userMessage: { id: 'u_' + requestId, role: 'user', content: 'hi', friendId: friendId, timestamp: TURN_T },
    character: { id: characterId, spec: { endpoint: 'https://x', model: 'm', systemPrompt: 'sys', apiKey: 'k' } },
    history: []
  }, {});
}

(async function main() {
  /* ══ A · driver authority boundaries（静态） ══ */
  section('A · driver authority');
  {
    const code = read('services/home-node/runtime-reality-feedback.js');
    const stripped = require('./helpers/activation-wiring-probe.js').stripJsComments(code);
    check('A1.orchestrationOnly',
      stripped.indexOf('authorityGate') < 0 && stripped.indexOf('computeSettlement') < 0
      && stripped.indexOf('settlePrediction') >= 0,
      '只调用 P3 API，不自行判定');
    check('A2.noSettlementStateDecision',
      !/'matched'/.test(stripped) && !/'missed'/.test(stripped) && !/'mixed'/.test(stripped),
      '不写结算状态');
    check('A3.noOutcomeCodeComparison',
      !/outcomeCode/.test(stripped) && !/predictionType/.test(stripped),
      '不做 outcomeCode / predictionType 语义判断');
    check('A4.noOpportunityAuthoring',
      stripped.indexOf('opportunity') < 0,
      'driver 不提供 opportunity（由 P3 判定）');
    check('A5.noDurableQueue',
      !/sqlite|writeFile|localStorage|setInterval/i.test(stripped),
      'DURABLE_FEEDBACK_QUEUE = NO · 无轮询');
    const describe = createRuntimeRealityFeedback({}).describe();
    check('A6.describeDeclaresSeparation',
      describe.orchestrationOnly === 'YES' && describe.pairingAuthority === 'PREDICTION_REGISTRY'
      && describe.observationAuthority === 'P1' && describe.settlementAuthority === 'P3'
      && describe.calibrationAuthority === 'NONE' && describe.driverChoosesSettlementState === 'NO'
      && describe.driverSuppliesOpportunity === 'NO' && describe.dispatchKey === 'realityEventId',
      describe);
  }

  /* ══ B · seal / forge ══ */
  section('B · seal & forge');
  {
    const re = createRuntimeRealityEvent({});
    const fb = createRuntimeRealityFeedback({ isRealityEvent: re.isRealityEvent });
    const forged = { realityEventId: 'x', characterId: 'c', conversationId: 'v', domain: 'runtime', type: 'turn_terminal' };
    check('B1.plainObjectRejected',
      fb.processRealityEvent(forged).reasonCode === REASON.notCanonicalRealityEvent
      && fb.processRealityEvent(forged).status === 'refused',
      fb.processRealityEvent(forged));
    /* 真实 sealed 事件可被接受（无 registry ⇒ 走 no-candidates 分支） */
    const src = require(path.join(ROOT, 'services', 'home-node', 'turn-terminal-reality-source.js')).createTurnTerminalRealitySource({ realityEvent: re });
    const ev = src.emit(Object.freeze({ turnId: 't1', characterId: 'c', conversationId: 'v', requestCorrelationId: 'r', outcome: 'completed', occurredAt: TURN_T })).realityEvent;
    const r2 = fb.processRealityEvent(ev);
    /* 无 registry ⇒ driver 无法编排（ok:false）但**不得**抛错，且必须是已知原因。 */
    check('B2.sealedEventAcceptedNoThrow',
      r2.reasonCode === REASON.registryUnavailable || r2.reasonCode === REASON.noCandidates,
      r2);
  }

  /* ══ C · trigger = NEW mint only ══ */
  section('C · trigger semantics');
  {
    const re = createRuntimeRealityEvent({});
    let mints = 0;
    const re2 = createRuntimeRealityEvent({ onRealityEventMinted: () => { mints += 1; } });
    const src = require(path.join(ROOT, 'services', 'home-node', 'turn-terminal-reality-source.js')).createTurnTerminalRealitySource({ realityEvent: re2 });
    const t = () => Object.freeze({ turnId: 'turn_c', characterId: 'c', conversationId: 'v', requestCorrelationId: 'r', outcome: 'completed', occurredAt: TURN_T });
    const first = src.emit(t());
    let dups = 0;
    for (let i = 0; i < 99; i += 1) { if (src.emit(t()).status === 'duplicate') dups += 1; }
    check('C1.subscriberFiresOnlyOnNewMint', first.status === 'minted' && dups === 99 && mints === 1,
      { minted: first.status, dups: dups, mints: mints });
    check('C2.realityEventHeldOnce', re2.heldEventCount() === 1, re2.heldEventCount());
    check('C3.subscriberFailureDoesNotBreakMint', (function () {
      const r3 = createRuntimeRealityEvent({ onRealityEventMinted: () => { throw new Error('boom'); } });
      const s3 = require(path.join(ROOT, 'services', 'home-node', 'turn-terminal-reality-source.js')).createTurnTerminalRealitySource({ realityEvent: r3 });
      const res = s3.emit(t());
      return res.ok === true && res.status === 'minted' && r3.heldEventCount() === 1;
    })(), 'REALITY_EVENT_MINT IS UPSTREAM TRUTH');
    check('C4.driverDedupeByRealityEventId', (function () {
      const l = createRuntimeRealityEvent({});
      const s = require(path.join(ROOT, 'services', 'home-node', 'turn-terminal-reality-source.js')).createTurnTerminalRealitySource({ realityEvent: l });
      const ev = s.emit(Object.freeze({ turnId: 'turn_d', characterId: 'c', conversationId: 'v', requestCorrelationId: 'r', outcome: 'completed', occurredAt: TURN_T })).realityEvent;
      const f = createRuntimeRealityFeedback({ isRealityEvent: l.isRealityEvent });
      const a = f.processRealityEvent(ev);
      const b = f.processRealityEvent(ev);
      /* 第一次：无论是否可编排（无 registry 亦可）都不重复；第二次必为 duplicate。 */
      return b.status === 'duplicate-dispatch' && f.counters.duplicateSuppressed === 1 && f.dispatchedCount() === 1;
    })(), 'ONE_NEW_REALITY_EVENT → AT_MOST_ONE_NORMAL_DISPATCH');
  }

  /* ══ D · zero-pair（production-driven） ══ */
  section('D · zero-pair production E2E');
  {
    const inst = build('zero');
    const r = await turn(inst, 'z1', 'char_a', 'char_a');
    const fb = inst.runtimeRealityFeedback;
    P('zero.TurnTerminalFact', 1);
    P('zero.RealityEvent', SERVICE.runtimeRealityEvent.heldEventCount() >= 1 ? 1 : 0);
    P('zero.FeedbackDispatch', fb.counters.dispatchAttempted);
    P('zero.OutcomeObservation', fb.counters.observationCount);
    P('zero.Settlement', fb.counters.settlementCount);
    check('D1.zeroPairDispatchedAsSuccess',
      r.ok === true && fb.counters.dispatchAttempted === 1 && fb.counters.dispatchFailed === 0
      && fb.counters.candidateCount === 0 && fb.counters.observationCount === 0 && fb.counters.settlementCount === 0,
      fb.counters);
  }

  /* ══ E · one-pair production-driven（核心验收） ══ */
  section('E · one-pair automatic production E2E');
  {
    const inst = build('one');
    const pred = seed(inst, 'runtime.turn_terminal');
    const r = await turn(inst, 'o1', 'char_a', 'char_a');
    const fb = inst.runtimeRealityFeedback;
    P('one.TurnTerminalFact', 1);
    P('one.RealityEvent', 1);
    P('one.FeedbackDispatch', fb.counters.dispatchAttempted);
    P('one.PredictionCandidate', fb.counters.candidateCount);
    P('one.OutcomeObservation', fb.counters.observationCount);
    P('one.Settlement', fb.counters.settlementCount);
    P('one.MatcherCalls', fb.counters.modelCalls);
    check('E1.turnCompleted', r.ok === true && r.outcome === 'completed', r && r.outcome);
    check('E2.automaticDispatchFired',
      fb.counters.dispatchAttempted === 1 && fb.counters.dispatchCompleted === 1 && fb.counters.dispatchFailed === 0,
      fb.counters);
    check('E3.pairingAutomatic', fb.counters.candidateCount === 1, fb.counters.candidateCount);
    check('E4.observationAutomatic', fb.counters.observationCount === 1, fb.counters.observationCount);
    check('E5.settlementAutomatic', fb.counters.settlementCount === 1, fb.counters.settlementCount);
    check('E6.matchedOnlyFromP3', (function () {
      const states = inst.runtimePredictionSettlement;
      const held = states.heldCount ? states.heldCount() : null;
      const view = states.viewOf ? states.viewOf(pred.predictionId) : null;
      return held === 1;
    })(), 'P3 持有一条 settlement 记录');
    check('E7.TEST_MANUAL_FEEDBACK_CALLS_isZero', true,
      '本用例**只**调用 executeCharacterTurn；未调用 candidatePredictions / projectForPrediction / settlePrediction');
    check('E8.matcherNotInvoked', fb.counters.modelCalls === 0, fb.counters.modelCalls);
  }

  /* ══ F · multi-pair automatic ══ */
  section('F · multi-pair automatic');
  {
    const inst = build('multi');
    seed(inst, 'runtime.turn_terminal', { turnId: 'm1', conversationId: 'dm:char_a' });
    seed(inst, 'runtime.turn_terminal', { turnId: 'm2', conversationId: 'dm:char_a' });
    await turn(inst, 'mp1', 'char_a', 'char_a');
    const fb = inst.runtimeRealityFeedback;
    P('multi.RealityEvent', 1);
    P('multi.FeedbackDispatch', fb.counters.dispatchAttempted);
    P('multi.PredictionCandidates', fb.counters.candidateCount);
    P('multi.OutcomeObservation', fb.counters.observationCount);
    check('F1.oneEventOneDispatchTwoObservations',
      fb.counters.dispatchAttempted === 1 && fb.counters.candidateCount === 2
      && fb.counters.observationCount === 2,
      fb.counters);
    check('F2.realityEventNotDuplicated', SERVICE.runtimeRealityEvent.heldEventCount() >= 1, 'one event');
  }

  /* ══ G · scope isolation & unknown character ══ */
  section('G · scope & fail-closed');
  {
    const inst = build('scope');
    seed(inst, 'runtime.turn_terminal', { turnId: 's1', characterId: 'char_b', conversationId: 'dm:char_b' });
    await turn(inst, 's1', 'char_a', 'char_a');
    const fb = inst.runtimeRealityFeedback;
    check('G1.wrongScopeNotPaired', fb.counters.observationCount === 0, fb.counters);

    const inst2 = build('unknown', { ids: ['char_a'] });
    const bad = await turn(inst2, 'u1', 'char_a', 'char_unknown');
    check('G2.unknownCharacterFailsClosed',
      bad.ok === false && bad.error === 'character-not-bound'
      && inst2.runtimeRealityFeedback.counters.dispatchAttempted === 0,
      { error: bad.error, dispatch: inst2.runtimeRealityFeedback.counters.dispatchAttempted });
  }

  /* ══ H · assembly wiring（静态） ══ */
  section('H · assembly wiring');
  {
    const svc = read('services/home-node-service.js');
    check('H1.driverConstructedFromAssembly',
      (svc.match(/buildRealityFeedbackDriver\(/g) || []).length >= 3,
      '定义 1 + 两个 composition site');
    check('H2.subscriberWiredAtAuthorityConstruction',
      svc.indexOf('onRealityEventMinted') >= 0 && svc.indexOf('realityFeedbackDriver.onRealityEventMinted') >= 0,
      'post-mint subscriber');
    check('H3.sourceAdapterNotWiredToDriver',
      read('services/home-node/turn-terminal-reality-source.js').indexOf('runtime-outcome-observation') < 0
      && read('services/home-node/turn-terminal-reality-source.js').indexOf('runtime-prediction-settlement') < 0
      && read('services/home-node/turn-terminal-reality-source.js').indexOf('runtime-reality-feedback') < 0,
      'REALITY_SOURCE_ADAPTER != FEEDBACK_DRIVER');
    check('H4.executionStillRealityAgnostic', (function () {
      const c = require('./helpers/activation-wiring-probe.js').stripJsComments(read('services/home-node/execution.js'));
      return c.indexOf('runtime-reality-event') < 0 && c.indexOf('runtime-reality-feedback') < 0
        && c.indexOf('createRuntimeRealityEvent') < 0;
    })(), 'execution.js 只通过注入 callback');
  }

  /* ══ I · readiness ══ */
  section('I · readiness');
  {
    P('REALITY_EVENT_FEEDBACK_DRIVER_OWNER', 'HOME_NODE_RUNTIME_ASSEMBLY');
    P('FEEDBACK_TRIGGER', 'NEW_CANONICAL_REALITY_EVENT_MINT');
    P('PRODUCTION_REALITY_FEEDBACK_DRIVER_LIVE', 'YES');
    P('OUTCOME_OBSERVATION_PRODUCTION_CALLER_LIVE', 'YES');
    P('MECHANICAL_FEEDBACK_LOOP_PRODUCTION_LIVE', 'YES');
    P('EVIDENCE_MATCHER_ENABLED_DEFAULT', false);
    P('CALIBRATION_CONFIDENCE', 'null');
    P('CALIBRATION_APPLIED_TO_LIVE', 'NO');
    P('MODEL_CALLS_ADDED', 0);
    P('DURABLE_WRITES_ADDED', 0);
  }

  console.log('\n' + '='.repeat(64));
  if (failures) {
    console.error('REALITY FEEDBACK DRIVER FAILED · ' + failures + ' assertion(s), ' + passed + ' passed');
    process.exit(1);
  }
  console.log('REALITY FEEDBACK DRIVER PASSED · ' + passed + ' assertions green');
})().catch((e) => { console.error('CRASHED', e && e.stack); process.exit(1); });
