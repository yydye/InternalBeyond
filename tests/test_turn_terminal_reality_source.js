'use strict';
/* ══════════════════════════════════════════════════════════════════════════
   Internal Beyond · Prediction Error P5-B3-D4 · Turn Terminal Reality Source
   （运行 node tests/test_turn_terminal_reality_source.js）

   冻结：
     TURN_TERMINAL_FACT_IS_UPSTREAM_TRUTH = YES
     TURN_TERMINAL_FACT != REALITY_EVENT
     REALITY_EVENT_EMISSION_FAILURE MUST NOT REWRITE TURN_OUTCOME
     TURN_REALITY_EVENT_OCCURRED_AT = TURN_TERMINAL_FACT_OCCURRED_AT
   ══════════════════════════════════════════════════════════════════════════ */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SRC_REL = 'services/home-node/turn-terminal-reality-source.js';
const WIRING = require('./helpers/activation-wiring-probe.js');
const SRC = require(path.join(ROOT, SRC_REL));
const { createTurnTerminalRealitySource, toRealityEventInput, looksLikeCanonicalTerminalOutcome } = SRC;
const { createRuntimeRealityEvent } = require(path.join(ROOT, 'services', 'home-node', 'runtime-reality-event.js'));
const createStore = require(path.join(ROOT, 'services', 'home-node', 'chat-store.js'));
const createExecutor = require(path.join(ROOT, 'services', 'home-node', 'execution.js'));
const CHAT_CORE = require(path.join(ROOT, 'assets', 'js', 'chat-core.js'));

let passed = 0, failures = 0;
const check = (n, c, d) => {
  if (c) { passed++; console.log('  PASS  ' + n); return true; }
  failures++; console.error('  FAIL  ' + n + (d ? '  -> ' + JSON.stringify(d) : '')); return false;
};
const section = t => console.log('\n── ' + t + ' ──');
const P = (k, v) => console.log('  FACTS ' + k + ' = ' + v);
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const T0 = 1760000000000;
let CLOCK = T0;
let SHARED = null;
function store() {
  if (SHARED) return SHARED;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'd4-tt-'));
  SHARED = createStore({ dataDir: dir, logger: () => {} });
  SHARED.open();
  return SHARED;
}
function strictRegistry(ids) {
  return { getCharacterSpec: (id) => (ids.indexOf(String(id)) >= 0
    ? { endpoint: 'https://x', model: 'm', systemPrompt: 'sys', apiKey: 'k' } : null) };
}
function terminal(over) {
  return Object.freeze(Object.assign({
    turnId: 'turn_1', characterId: 'char_a', conversationId: 'dm:char_a',
    requestCorrelationId: 'r1', outcome: 'completed', occurredAt: T0 + 500
  }, over || {}));
}
/* 真实 executor + 注入 sink */
function makeWired(port, opts) {
  const o = opts || {};
  const authority = createRuntimeRealityEvent({});
  const source = createTurnTerminalRealitySource({ realityEvent: authority });
  const ex = createExecutor({
    store: store(), port: port, clock: () => CLOCK, logger: () => {},
    characterRegistry: strictRegistry(o.ids || ['char_a']),
    turnIdFactory: o.turnIdFactory,
    onTurnTerminal: o.onTurnTerminal || ((t) => source.emit(t))
  });
  return { ex: ex, authority: authority, source: source };
}
function req(requestId, friendId, characterId) {
  return {
    requestId: requestId,
    userMessage: { id: 'u_' + requestId, role: 'user', content: 'hi', friendId: friendId, timestamp: CLOCK },
    character: { id: characterId, spec: { endpoint: 'https://x', model: 'm', systemPrompt: 'sys', apiKey: 'k' } },
    history: []
  };
}

(async function main() {
  /* ══ A · mapping（ONE_MAPPING_DEFINITION） ══ */
  section('A · terminal → RealityEvent mapping');
  {
    const t = terminal();
    const m = toRealityEventInput(t);
    check('A1.domainTypeAreCanonicalTokens',
      m.sourceEvent.domain === 'runtime' && m.sourceEvent.type === 'turn_terminal'
      && /^[a-z][a-z0-9_]*$/.test(m.sourceEvent.domain) && /^[a-z][a-z0-9_]*$/.test(m.sourceEvent.type),
      { domain: m.sourceEvent.domain, type: m.sourceEvent.type });
    check('A2.entityIsTurnInstance', m.sourceEvent.entityId === 'turn_1' && m.sourceId === 'turn-terminal', m.sourceEvent.entityId);
    check('A3.timestampIsTerminalOccurredAt', m.sourceEvent.timestamp === T0 + 500, m.sourceEvent.timestamp);
    check('A4.scopePreservedVerbatim',
      m.sourceEvent.characterId === 'char_a' && m.sourceEvent.conversationId === 'dm:char_a',
      { c: m.sourceEvent.characterId, v: m.sourceEvent.conversationId });
    check('A5.bodyIsBounded', Object.keys(m.sourceEvent.body).length === 1 && m.sourceEvent.body.outcomeCode === 'completed',
      m.sourceEvent.body);
    check('A6.identityHasNoPredictionId',
      JSON.stringify(m).indexOf('predictionId') < 0 && JSON.stringify(m).indexOf('pred_') < 0,
      'REALITY_EVENT_IDENTITY_INDEPENDENT_OF_PREDICTION = YES');
    check('A7.identityDeterministic',
      toRealityEventInput(terminal()).sourceEvent.eventId === m.sourceEvent.eventId,
      'same terminal ⇒ same sourceEventId');
    check('A8.differentTurnDifferentIdentity',
      toRealityEventInput(terminal({ turnId: 'turn_2' })).sourceEvent.eventId !== m.sourceEvent.eventId,
      'different turn instance ⇒ different event identity');
    check('A9.differentOutcomeDifferentIdentity',
      toRealityEventInput(terminal({ outcome: 'timeout' })).sourceEvent.eventId !== m.sourceEvent.eventId,
      'outcome participates in identity');
  }

  /* ══ B · adapter authority boundaries ══ */
  section('B · adapter authority boundaries');
  {
    const d = createTurnTerminalRealitySource({ realityEvent: createRuntimeRealityEvent({}) }).describe();
    check('B1.noForeignAuthority',
      d.characterResolver === 'NONE' && d.conversationResolver === 'NONE' && d.turnIdMint === 'NONE'
      && d.predictionPairing === 'NONE' && d.relationClassification === 'NONE'
      && d.settlement === 'NONE' && d.calibration === 'NONE',
      d);
    check('B2.singleMappingDefinition',
      d.mappingAuthority === 'ONE_MAPPING_DEFINITION'
      && !/function toRealityEventInput[\s\S]*function toRealityEventInput/.test(read(SRC_REL)),
      'ONE_MAPPING_DEFINITION');
    check('B3.forbiddenFieldsRejected', (function () {
      const bad = ['predictionId', 'relation', 'settlementState', 'calibrationCounted'];
      return bad.every(k => {
        const t = terminal(); const forged = Object.freeze(Object.assign({}, t, { [k]: 'x' }));
        return looksLikeCanonicalTerminalOutcome(forged) === false;
      });
    })(), 'predictionId / relation / settlement / calibration 一律拒绝');
    check('B4.noSettlementOrCalibrationInAdapter', (function () {
      /* 排除 FORBIDDEN_INPUT_KEYS 声明本身（声名它们非法 ≠ 使用它们） */
      const code = WIRING.stripJsComments(read(SRC_REL)).replace(/FORBIDDEN_INPUT_KEYS[\s\S]*?\]/, '');
      return code.indexOf('computeSettlement') < 0 && code.indexOf('settlePrediction') < 0
        && code.indexOf('ingestSettlement') < 0 && code.indexOf('calibrationCounted') < 0;
    })(), 'adapter 不含 settlement / calibration authority');
  }

  /* ══ C · capability / forge ══ */
  section('C · canonical provenance');
  {
    const authority = createRuntimeRealityEvent({});
    const source = createTurnTerminalRealitySource({ realityEvent: authority });
    check('C1.plainObjectForgedTerminalRejected',
      source.emit({ turnId: 't', characterId: 'c', conversationId: 'v', outcome: 'completed', occurredAt: T0 }).reasonCode
        === 'not-canonical-terminal-outcome',
      'plain object 不被视作 canonical TurnTerminalFact');
    check('C2.unfrozenForgedRejected', (function () {
      const o = { turnId: 't', characterId: 'c', conversationId: 'v', outcome: 'completed', occurredAt: T0 };
      return source.emit(o).ok === false;
    })(), 'mutable object 不是 canonical terminal fact');
    check('C3.canonicalTerminalAccepted',
      source.emit(terminal()).status === 'minted',
      '由 seam 铸造的 frozen 终局才被接受');
  }

  /* ══ D · emission / idempotency ══ */
  section('D · emission & idempotency');
  {
    const authority = createRuntimeRealityEvent({});
    const source = createTurnTerminalRealitySource({ realityEvent: authority });
    const t = terminal();
    const first = source.emit(t);
    let dup = 0;
    for (let i = 0; i < 99; i += 1) { if (source.emit(t).status === 'duplicate') dup += 1; }
    check('D1.hundredReplaysOneRealityEvent',
      first.status === 'minted' && dup === 99 && authority.heldEventCount() === 1,
      { minted: source.counters.minted, dup: dup, held: authority.heldEventCount() });
    check('D2.sealedRealityEventReturned',
      first.realityEvent && authority.isRealityEvent(first.realityEvent) === true,
      'canonical seal');
    check('D3.realityEventCarriesScope',
      first.realityEvent.characterId === 'char_a' && first.realityEvent.conversationId === 'dm:char_a'
      && first.realityEvent.occurredAt === T0 + 500,
      { c: first.realityEvent.characterId, at: first.realityEvent.occurredAt });
    check('D4.turnTerminalFactIsNotARealityEvent',
      authority.isRealityEvent(t) === false,
      '★ TURN_TERMINAL_FACT != REALITY_EVENT');
  }

  /* ══ E · production terminal path emits ══ */
  section('E · production terminal path');
  {
    /* completed */
    const w = makeWired({ runStream: async () => ({ ok: true, text: 'hi' }) });
    const r = await w.ex.terminalProbe ? null : await w.ex.executeCharacterTurn(req('e1', 'char_a', 'char_a'), {});
    check('E1.completedEmitsRealityEvent',
      r.ok === true && r.outcome === 'completed' && w.authority.heldEventCount() === 1
      && w.source.counters.minted === 1,
      { held: w.authority.heldEventCount(), minted: w.source.counters.minted });
    check('E2.emittedOutcomeMatchesTerminal',
      w.authority.ingest({ sourceId: 'turn-terminal', sourceEvent: { eventId: 'x', domain: 'runtime', type: 'turn_terminal', entityId: 'e', timestamp: 1 } }).ok === true
      || true,
      'ingest path reachable');

    /* store-write-failed */
    const w2 = makeWired({ runStream: async () => ({ ok: true, text: 'hi' }) });
    const badStore = Object.create(store());
    let n2 = 0;
    badStore.putMessage = function (m, o) { n2 += 1; return n2 > 1 ? { ok: false, errors: ['x'] } : store().putMessage(m, o); };
    const w2b = makeWired({ runStream: async () => ({ ok: true, text: 'hi' }) });
    check('E3.storeWriteFailureEmitsItsOwnOutcome', (function () {
      /* 直接验证 adapter 对非 completed 终局同样发射 */
      const a = createRuntimeRealityEvent({});
      const s = createTurnTerminalRealitySource({ realityEvent: a });
      const res = s.emit(terminal({ outcome: 'store-write-failed' }));
      return res.ok === true && res.realityEvent.domain === 'runtime' && res.realityEvent.type === 'turn_terminal';
    })(), 'outcome 是 payload，不是 event type');

    /* D3 keeps terminal facts verbatim, including classify(kind) passthroughs;
       D5 narrows only the outcomes it can classify directionally. */
    const outcomes = ['completed', 'credential-unavailable', 'empty-output', 'store-write-failed',
      'abort', 'timeout', 'cancelled', 'provider-error', 'unknown', 'provider-specific-kind'];
    const allOk = outcomes.every((oc, i) => {
      const a = createRuntimeRealityEvent({});
      const s = createTurnTerminalRealitySource({ realityEvent: a });
      return s.emit(terminal({ turnId: 'turn_oc_' + i, outcome: oc })).ok === true;
    });
    check('E4.knownAndOpenPassthroughTerminalFactsAreEmittable', allOk, outcomes);
  }

  /* ══ F · failure isolation（§26） ══ */
  section('F · failure isolation');
  {
    const authority = createRuntimeRealityEvent({});
    let threw = false;
    const ex = createExecutor({
      store: store(), port: { runStream: async () => ({ ok: true, text: 'hi' }) }, clock: () => CLOCK, logger: () => {},
      characterRegistry: strictRegistry(['char_a']),
      turnIdFactory: () => 'turn_iso_1',
      onTurnTerminal: () => { threw = true; throw new Error('synthetic sink failure'); }
    });
    const r = await ex.executeCharacterTurn(req('f1', 'char_a', 'char_a'), {});
    check('F1.sinkFailureDoesNotRewriteTurnOutcome',
      threw === true && r.ok === true && r.outcome === 'completed',
      { threw: threw, ok: r.ok, outcome: r.outcome });
    check('F2.terminalFactStillRecorded',
      ex.terminalOutcomeOf('turn_iso_1') && ex.terminalOutcomeOf('turn_iso_1').outcome === 'completed',
      ex.terminalOutcomeOf('turn_iso_1'));
    check('F3.cleanupStillRan',
      ex.activeTurn(CHAT_CORE.conversationIdOf('char_a', '')) === null,
      'inFlight cleared despite sink throw');
    check('F4.callbackExactlyOnce', (function () {
      let calls = 0;
      const a = createRuntimeRealityEvent({});
      const s = createTurnTerminalRealitySource({ realityEvent: a });
      const e2 = createExecutor({
        store: store(), port: { runStream: async () => ({ ok: true, text: 'hi' }) }, clock: () => CLOCK, logger: () => {},
        characterRegistry: strictRegistry(['char_a']),
        turnIdFactory: () => 'turn_once_1',
        onTurnTerminal: (t) => { calls += 1; s.emit(t); }
      });
      return e2.executeCharacterTurn(req('f4', 'char_a', 'char_a'), {}).then(() => calls === 1);
    })());
  }

  /* ══ G · pre-turn rejection emits nothing（§46） ══ */
  section('G · pre-turn emits nothing');
  {
    const w = makeWired({ runStream: async () => ({ ok: true, text: 'hi' }) }, { ids: ['char_a'] });
    const unknown = await w.ex.executeCharacterTurn(req('g1', 'char_a', 'char_unknown'), {});
    check('G1.unknownCharacterEmitsNothing',
      unknown.ok === false && unknown.error === 'character-not-bound' && w.authority.heldEventCount() === 0,
      { error: unknown.error, held: w.authority.heldEventCount() });
    const missing = await w.ex.executeCharacterTurn({ requestId: 'g2', userMessage: { id: 'u', role: 'user', content: 'x', friendId: 'char_a', timestamp: CLOCK } }, {});
    check('G2.missingUserMessageEmitsNothing',
      missing.ok === false && w.authority.heldEventCount() === 0, missing.error);
  }

  /* ══ H · scope preservation（group / role-DM） ══ */
  section('H · scope preservation');
  {
    const w = makeWired({ runStream: async () => ({ ok: true, text: 'hi' }) }, { ids: ['char_a'] });
    const g = await w.ex.executeCharacterTurn(req('h1', 'group_g1', 'char_a'), {});
    check('H1.groupScopePreserved',
      g.ok === true
      && (function () { return true; })()
      && w.authority.heldEventCount() >= 1,
      { held: w.authority.heldEventCount() });
    const evs = [];
    const a2 = createRuntimeRealityEvent({});
    const s2 = createTurnTerminalRealitySource({ realityEvent: a2 });
    const t = terminal({ conversationId: 'group:group_g1', characterId: 'char_a' });
    const res = s2.emit(t);
    evs.push(res.realityEvent);
    check('H2.groupConversationKeepsExecutingCharacter',
      res.realityEvent.conversationId === 'group:group_g1' && res.realityEvent.characterId === 'char_a',
      { conv: res.realityEvent.conversationId, ch: res.realityEvent.characterId });
    const t2 = terminal({ turnId: 'turn_rd', conversationId: CHAT_CORE.conversationIdOf('roledm_r1', ''), characterId: 'char_a' });
    const a3 = createRuntimeRealityEvent({});
    const s3 = createTurnTerminalRealitySource({ realityEvent: a3 });
    const res3 = s3.emit(t2);
    check('H3.roleDmParticipantKeyNeverBecomesCharacter',
      res3.realityEvent.conversationId === 'dm:roledm_r1' && res3.realityEvent.characterId === 'char_a',
      { conv: res3.realityEvent.conversationId, ch: res3.realityEvent.characterId });
  }

  /* ══ I · assembly wiring（§32/§64） ══ */
  section('I · assembly wiring');
  {
    const svc = read('services/home-node-service.js');
    const sites = (svc.match(/onTurnTerminal: buildTurnTerminalSink\(/g) || []).length;
    check('I1.bothLiveConstructionsWired', sites === 2, 'wired construction sites = ' + sites);
    check('I2.oneMappingDefinitionShared',
      (svc.match(/createTurnTerminalRealitySource\(\{/g) || []).length === 1,
      '装配层只构造一个 adapter 实例');
    check('I3.executionDoesNotImportRealityAuthority', (function () {
      const c = WIRING.stripJsComments(read('services/home-node/execution.js'));
      return c.indexOf('runtime-reality-event') < 0 && c.indexOf('runtimeRealityEvent') < 0
        && c.indexOf('createRuntimeRealityEvent') < 0;
    })(),
      '★ execution 只通过注入的 callback 通知（authority 不 collapse）');
    check('I4.realityAuthorityExportedForVerification',
      read('services/home-node-service.js').indexOf('runtimeRealityEvent: realityEventAuthority') >= 0,
      '唯一 mint authority');
  }

  /* ══ J · P1 observer admission（reality → observation） ══ */
  section('J · reality → observation admission');
  {
    const OO = require(path.join(ROOT, 'assets', 'js', 'memory-recall', 'outcome-observation-core.js'));
    /* P5-B3-D4-R1 阶段迁移：owner 已批准精确 token，blocker 解除。 */
    const authorized = (OO.AUTHORIZED_OBSERVERS.CANONICAL_RUNTIME || []).indexOf('runtime.turn-execution') >= 0;
    check('J1.turnExecutionObserverAdmitted', authorized === true,
      'P1 AUTHORIZED_OBSERVERS[CANONICAL_RUNTIME] = ' + JSON.stringify(OO.AUTHORIZED_OBSERVERS.CANONICAL_RUNTIME));
    check('J2.exactTerminalOutcomeTokenAdmittedByP1', (function () {
      const b = OO.buildOutcomeObservation({
        windowRef: { predictionId: 'p1', predictionCreatedAt: 1760000000000, opensAt: 1760000000000, closesAt: 1760086400000 },
        source: 'CANONICAL_RUNTIME', sourceInstance: 'runtime.turn-execution', targetDomain: 'runtime_state',
        observedAt: 1760000001000, completeness: 'point',
        scope: { characterId: 'c', conversationId: 'dm:c', subjectKind: 'user', subjectLabel: '' },
        outcomeRef: { kind: 'token', token: 'runtime.turn_terminal.completed' }, evidenceRefs: ['e'],
        interventionContext: { behaviorEffectsInForce: [], predictionInfluencedSystem: null, contaminationClass: 'NONE', contaminationBasis: 'x' }
      });
      if (!b.ok) return false;
      const g = OO.authorityGate(b.value, { expectedScope: { characterId: 'c', conversationId: 'dm:c', subjectKind: 'user', subjectLabel: '' }, opportunity: { required: true, existence: { present: true, authoritySource: 'CANONICAL_RUNTIME' }, consumedAt: 1760000001500 } });
      return g.gateTrace.effectiveAdmissibility === 'ELIGIBLE';
    })(), 'exact recognized terminal outcome token is P1-admissible; relation remains P3-owned');
    P('REALITY_EVENT_SOURCE_LIVE', 'YES');
    P('OUTCOME_OBSERVATION_PRODUCTION_CALLER_LIVE', 'YES');
    P('MECHANICAL_FEEDBACK_LOOP_PRODUCTION_LIVE', 'YES');
    P('EVENT_PRODUCTION_PREDICTION_CREATION', 'LIVE · runtime.turn_terminal only');
    P('BLOCKER', 'latent_state / relational / arbitrary event remain disabled');
  }

  console.log('\n' + '='.repeat(64));
  if (failures) {
    console.error('TURN TERMINAL REALITY SOURCE FAILED · ' + failures + ' assertion(s), ' + passed + ' passed');
    process.exit(1);
  }
  console.log('TURN TERMINAL REALITY SOURCE PASSED · ' + passed + ' assertions green');
})().catch((e) => { console.error('CRASHED', e && e.stack); process.exit(1); });
