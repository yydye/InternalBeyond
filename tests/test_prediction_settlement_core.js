'use strict';
/* ══════════════════════════════════════════════════════════════════════════
   Internal Beyond · Prediction Error P3 · Settlement Engine
   （纯 Node，零浏览器、零网络、**零模型调用**、零 durable 写）

   运行：node tests/test_prediction_settlement_core.js

   本套件证明：
     · 七状态 vocabulary（不得产出 legacy 五词表）
     · T8 **有序**判定是 TOTAL FUNCTION（无 else-unknown 兜底）
     · 只**消费** authority，不重判 authority（directional.support/conflict）
     · 语义 conflict ≠ 有资格 missed
     · 机会语义（ABSENT / NOT-CONSUMED / UNKNOWN 绝不产生 missed）
     · 四类 policy 的结算行为
     · `behaviorEffectsInForce: []` **不等于** known-none
     · ordinal Prediction Error 查表 + `predictionErrorMetric === null`
     · 一次性结算 / superseded 优先 / 无 memory·relationship 变更
   ══════════════════════════════════════════════════════════════════════════ */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SETTLE_CORE_REL = 'assets/js/memory-recall/prediction-settlement-core.js';
const SETTLE_RT_REL = 'services/home-node/runtime-prediction-settlement.js';
const RECORD_CORE_REL = 'assets/js/memory-recall/prediction-record-core.js';
const WIRING = require('./helpers/activation-wiring-probe.js');
const G = require('./helpers/runtime-seam-guard.js');
const CORE = require(path.join(ROOT, SETTLE_CORE_REL));
const RECORD_CORE = require(path.join(ROOT, RECORD_CORE_REL));
const OO = require(path.join(ROOT, 'assets/js/memory-recall/outcome-observation-core.js'));
const { createRuntimePredictionRegistry } = require(path.join(ROOT, 'services/home-node/runtime-prediction-registry.js'));
const { createRuntimePredictionSettlement } = require(path.join(ROOT, 'services/home-node/runtime-prediction-settlement.js'));

let passed = 0, failures = 0;
const check = (n, c, d) => {
  if (c) { passed++; console.log('  PASS  ' + n); return true; }
  failures++; console.error('  FAIL  ' + n + (d ? '  -> ' + d : '')); return false;
};
const section = t => console.log('\n── ' + t + ' ──');
const P = (k, v) => console.log('  FACTS ' + k + ' = ' + v);
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const T0 = 1760000000000;
const DAY = 24 * 60 * 60 * 1000;
const SCOPE = { characterId: 'char_A', conversationId: 'dm:char_A', subjectKind: 'user', subjectLabel: '' };

/* ── fixtures ─────────────────────────────────────────────────────────── */
function expectation(over) {
  const base = {
    epistemicStatus: 'prediction',
    prediction: '用户会点 Cancel',
    trigger: { kind: 'explicit-cue', label: '弹窗出现时' },
    evidenceMemoryIds: ['m1'],
    contradictoryEvidenceIds: [],
    generalizationLevel: 'episode-hypothesis',
    subjectivePredictionConfidence: 0.8,
    subject: { kind: 'user', label: '' },
    predicate: { kind: 'will-do' },
    expectedOutcome: { kind: 'exclusive-outcome', token: 'action.cancelled' }
  };
  return Object.assign({}, base, over || {});
}
function makePrediction(expOver, ctxOver) {
  const reg = createRuntimePredictionRegistry({ clock: () => T0 });
  const res = reg.projectFromValidatedExpectation(expectation(expOver), Object.assign({
    now: T0, characterId: SCOPE.characterId, conversationId: SCOPE.conversationId,
    turnId: 'turn_1', expectationIndex: 0
  }, ctxOver || {}));
  return { reg: reg, record: res.record, res: res };
}
function makeObservation(predictionRecord, token, over) {
  const r = OO.buildOutcomeObservation(Object.assign({
    windowRef: {
      predictionId: predictionRecord.predictionId,
      predictionCreatedAt: predictionRecord.observationWindow.opensAt,
      opensAt: predictionRecord.observationWindow.opensAt,
      closesAt: predictionRecord.observationWindow.closesAt
    },
    source: 'CANONICAL_RUNTIME',
    sourceInstance: 'runtime.popup',
    targetDomain: 'user_behavior',
    observedAt: predictionRecord.observationWindow.opensAt + 1000,
    completeness: 'point',
    scope: SCOPE,
    outcomeRef: { kind: 'token', token: token },
    evidenceRefs: ['evidence_1'],
    interventionContext: {
      behaviorEffectsInForce: [], predictionInfluencedSystem: null,
      contaminationClass: 'NONE', contaminationBasis: 'no intervention in force'
    }
  }, over || {}), {});
  return r.ok ? r.value : null;
}
function opp(present, consumed) {
  return { required: true, existence: { present: present, authoritySource: 'CANONICAL_RUNTIME' }, consumedAt: consumed == null ? null : consumed };
}
function testAuthorityState(fixture) {
  if (!fixture || typeof fixture !== 'object') return 'UNKNOWN';
  if (fixture.required === false) return 'NOT-REQUIRED';
  if (!fixture.existence || fixture.existence.authoritySource !== 'CANONICAL_RUNTIME') return 'UNKNOWN';
  if (fixture.existence.present !== true) return 'ABSENT';
  return fixture.consumedAt == null ? 'NOT-CONSUMED' : 'SATISFIED';
}
function testOpportunityAuthority(fixture) {
  const identity = new WeakSet();
  return {
    resolveForPrediction: function () {
      const value = Object.freeze({ state: testAuthorityState(fixture), opportunity: fixture || null });
      identity.add(value);
      return value;
    },
    isResolution: function (value) { return !!value && identity.has(value); }
  };
}
function engine(fixture) {
  const selectedFixture = arguments.length ? fixture : opp(true, T0 + 1500);
  return createRuntimePredictionSettlement({
    clock: () => T0,
    opportunityAuthority: testOpportunityAuthority(selectedFixture)
  });
}
const OPEN = (p) => ({ now: p.observationWindow.opensAt + 2000 });
const CLOSED = (p) => ({ now: p.observationWindow.closesAt + 1 });

function settleWith(pred, obsEntries, ctxOver) {
  const ctx = Object.assign({}, ctxOver || {});
  const fixture = Object.prototype.hasOwnProperty.call(ctx, 'testOpportunityFixture')
    ? ctx.testOpportunityFixture : opp(true, T0 + 1500);
  delete ctx.testOpportunityFixture;
  const e = engine(fixture);
  return e.settlePrediction(pred, obsEntries, ctx);
}

/* ── PE 查表 oracle（独立于实现） ─────────────────────────────────────── */
const ORACLE_PE = {
  pending: { low: ['unknown', 'unknown'], medium: ['unknown', 'unknown'], high: ['unknown', 'unknown'], unstated: ['unknown', 'unknown'] },
  matched: { low: ['under-confident', 'moderate'], medium: ['calibrated', 'low'], high: ['calibrated', 'none'], unstated: ['unknown', 'unknown'] },
  missed: { low: ['over-confident', 'low'], medium: ['over-confident', 'moderate'], high: ['over-confident', 'high'], unstated: ['unknown', 'unknown'] },
  mixed: { low: ['unknown', 'unknown'], medium: ['unknown', 'low'], high: ['unknown', 'moderate'], unstated: ['unknown', 'unknown'] },
  expired_unobserved: { low: ['unknown', 'unknown'], medium: ['unknown', 'unknown'], high: ['unknown', 'moderate'], unstated: ['unknown', 'unknown'] },
  unresolvable: { low: ['unknown', 'unknown'], medium: ['unknown', 'unknown'], high: ['unknown', 'unknown'], unstated: ['unknown', 'unknown'] },
  superseded: { low: ['unknown', 'unknown'], medium: ['unknown', 'unknown'], high: ['unknown', 'unknown'], unstated: ['unknown', 'unknown'] }
};

(function main() {
  /* ══════════════════════════════════════════════════════════════════
     A · Seven states
     ══════════════════════════════════════════════════════════════════ */
  section('A · seven states');
  {
    const base = makePrediction().record;

    /* pending：窗口未关且无可采证据 */
    const pending = settleWith(base, [], { now: T0 + 1000, testOpportunityFixture: opp(true, null) });
    check('A1.pending', pending.settlement && pending.settlement.state === 'pending',
      pending.settlement ? pending.settlement.state : 'no settlement');

    /* matched：decisive support 且无 opposing */
    const matched = settleWith(base, [{ observation: makeObservation(base, 'action.cancelled') }], OPEN(base));
    check('A2.matched', matched.settlement.state === 'matched'
      && matched.settlement.supportSummary.decisive === 1
      && matched.settlement.conflictSummary.total === 0,
      JSON.stringify(matched.settlement.supportSummary));

    /* missed：decisive conflict（机会 SATISFIED + mode 允许 + 互斥 token） */
    const missed = settleWith(base, [{ observation: makeObservation(base, 'action.confirmed') }], OPEN(base));
    check('A3.missed', missed.settlement.state === 'missed'
      && missed.settlement.conflictSummary.decisive === 1,
      JSON.stringify(missed.settlement.conflictSummary));

    /* mixed：support 达门槛 **且** 存在 opposing SUPPORTING（P0 修掉的那个漏格） */
    const mixed = settleWith(base, [
      { observation: makeObservation(base, 'action.cancelled') },
      { observation: makeObservation(base, 'action.confirmed', {
        source: 'EXPLICIT_USER_REPORT', sourceInstance: 'chat.user-utterance'
      }) }
    ], OPEN(base));
    check('A4.mixed', mixed.settlement.state === 'mixed'
      && mixed.settlement.supportSummary.decisive === 1
      && mixed.settlement.conflictSummary.nonDecisive === 1,
      JSON.stringify({ s: mixed.settlement.supportSummary, c: mixed.settlement.conflictSummary }));

    /* expired_unobserved：窗口关闭 + 机会 ABSENT */
    const expired = settleWith(base, [{ observation: makeObservation(base, 'action.confirmed') }],
      { now: base.observationWindow.closesAt + 1, testOpportunityFixture: opp(false, null) });
    check('A5.expiredUnobserved', expired.settlement.state === 'expired_unobserved'
      && expired.settlement.reasonCodes.indexOf('opportunity-absent') >= 0,
      JSON.stringify(expired.settlement.reasonCodes));

    /* unresolvable：窗口关闭 + 单向次门槛证据 */
    const unresolvable = settleWith(base, [{
      observation: makeObservation(base, 'action.cancelled', {
        source: 'EXPLICIT_USER_REPORT', sourceInstance: 'chat.user-utterance'
      })
    }], { now: base.observationWindow.closesAt + 1, testOpportunityFixture: opp(false, null) });
    check('A6.unresolvable', unresolvable.settlement.state === 'unresolvable',
      unresolvable.settlement.state);

    /* superseded */
    const superseded = settleWith(base, [{ observation: makeObservation(base, 'action.cancelled') }],
      Object.assign({ supersededByNewer: true }, OPEN(base)));
    check('A7.superseded', superseded.settlement.state === 'superseded',
      superseded.settlement.state);

    const allSeven = ['pending', 'matched', 'missed', 'mixed', 'expired_unobserved', 'unresolvable', 'superseded'];
    const produced = [pending, matched, missed, mixed, expired, unresolvable, superseded]
      .map(r => r.settlement.state);
    check('A8.allSevenStatesReachable',
      allSeven.every(s => produced.indexOf(s) >= 0),
      JSON.stringify(produced));

    check('A9.noLegacyResultIsEverProduced',
      CORE.LEGACY_RESULT_ADAPTER === 'NONE'
      && CORE.SETTLEMENT_STATES.every(s => CORE.LEGACY_RESULTS.indexOf(s) < 0)
      && [pending, matched, missed, mixed, expired, unresolvable, superseded]
        .every(r => CORE.LEGACY_RESULTS.indexOf(r.settlement.state) < 0),
      'the new engine must never emit confirmed/contradicted/partial/unknown/unsettled');
    P('SEVEN_STATES_REACHED', produced.length);
  }

  /* ══════════════════════════════════════════════════════════════════
     B · Totality
     ══════════════════════════════════════════════════════════════════ */
  section('B · T8 totality');
  {
    /* 直接对状态函数做**全枚举**：support/conflict × decisive/non-decisive × 窗口 × 机会 */
    let cells = 0, violations = [];
    for (const sd of [0, 1]) for (const sn of [0, 1]) for (const cd of [0, 1]) for (const cn of [0, 1])
      for (const windowClosed of [false, true])
        for (const oppState of CORE.OPPORTUNITY_STATES) {
          cells += 1;
          const counts = {
            supportDecisive: sd, supportNonDecisive: sn, conflictDecisive: cd, conflictNonDecisive: cn,
            supportAll: sd + sn, conflictAll: cd + cn, supportThreshold: 1
          };
          const out = CORE.t8State(counts, windowClosed, oppState);
          if (CORE.SETTLEMENT_STATES.indexOf(out) < 0) violations.push(JSON.stringify(counts) + '=>' + out);
        }
    check('B1.t8IsATotalFunctionOverEnumeratedInputs', violations.length === 0,
      'cells=' + cells + ' violations=' + JSON.stringify(violations.slice(0, 3)));
    check('B2.t8CoversTheP0Gap',
      CORE.t8State({ supportDecisive: 1, supportNonDecisive: 0, conflictDecisive: 0, conflictNonDecisive: 1, supportAll: 1, conflictAll: 1, supportThreshold: 1 }, false, 'SATISFIED') === 'mixed',
      'support threshold reached + sub-threshold opposing ⇒ mixed');
    check('B3.decisiveConflictWinsOverSupport',
      CORE.t8State({ supportDecisive: 1, supportNonDecisive: 0, conflictDecisive: 1, conflictNonDecisive: 0, supportAll: 1, conflictAll: 1, supportThreshold: 1 }, false, 'SATISFIED') === 'missed',
      'a permitted decisive conflict outranks support');
    check('B4.absenceNeverBecomesMissed',
      ['ABSENT', 'NOT-CONSUMED', 'UNKNOWN'].every(o =>
        CORE.t8State({ supportDecisive: 0, supportNonDecisive: 0, conflictDecisive: 0, conflictNonDecisive: 0, supportAll: 0, conflictAll: 0, supportThreshold: 1 }, true, o) !== 'missed'),
      'absence of evidence must never produce missed');
    check('B5.noElseUnknownFallback',
      !/else\s*\{\s*return\s*'unknown'/.test(read(SETTLE_CORE_REL))
      && !/'unknown'\s*;?\s*\/\/\s*fallback/.test(read(SETTLE_CORE_REL)),
      'there must be no catch-all "unknown" branch');
    P('T8_CELLS_ENUMERATED', cells);
  }

  /* ══════════════════════════════════════════════════════════════════
     C · One-shot settlement
     ══════════════════════════════════════════════════════════════════ */
  section('C · one-shot settlement');
  {
    const base = makePrediction().record;
    const e = engine();
    const obs = makeObservation(base, 'action.cancelled');
    const first = e.settlePrediction(base, [{ observation: obs }], OPEN(base));
    const again = [];
    for (let i = 0; i < 5; i += 1) again.push(e.settlePrediction(base, [{ observation: obs }], OPEN(base)));
    check('C1.onlyOneTerminalRecord', e.heldCount() === 1 && first.settlement.state === 'matched',
      'held=' + e.heldCount());
    check('C2.resettlementIsRejectedNotRecomputed',
      again.every(r => r.status === 'already-settled' && r.settlement.settlementId === first.settlement.settlementId)
      && e.describe().counters.settled === 1,
      JSON.stringify(e.describe().counters));
    check('C3.resettlementDoesNotAddLedgerEntriesOrCalibration',
      e.describe().counters.alreadySettled === 5
      && e.describe().counters.calibrationEligible === 1,
      JSON.stringify(e.describe().counters));
    check('C4.terminalRecordIsSealed',
      Object.isFrozen(first.settlement) && Object.isFrozen(first.settlement.supportSummary)
      && Object.isFrozen(first.predictionError),
      'the settlement and error records must be deep frozen');
    check('C5.declaredLifecycleRules',
      e.describe().settlementOnce === 'YES' && e.describe().reopen === 'NO_V1'
      && e.describe().resettlement === 'REJECTED' && e.describe().postWindowRetroSettle === 'NO',
      'SETTLEMENT_ONCE / REOPEN=NO_V1 / RESETTLEMENT=REJECTED / POST_WINDOW_RETRO_SETTLE=NO');
    check('C6.postWindowEvidenceDoesNotRetroSettle', (function () {
      const p2 = makePrediction({}, { turnId: 'turn_retro' }).record;
      const e2 = engine(opp(true, p2.observationWindow.opensAt + 1));
      const late = makeObservation(p2, 'action.cancelled', { observedAt: p2.observationWindow.closesAt + 10 });
      const r = e2.settlePrediction(p2, [{ observation: late }], { now: p2.observationWindow.closesAt + 20 });
      return !r.settlement || r.settlement.state !== 'matched';
    })(), 'evidence after the window must not settle');
  }

  /* ══════════════════════════════════════════════════════════════════
     D · Superseded precedence
     ══════════════════════════════════════════════════════════════════ */
  section('D · superseded precedence');
  {
    const base = makePrediction().record;
    const strongSupport = settleWith(base, [{ observation: makeObservation(base, 'action.cancelled') }],
      Object.assign({ supersededByNewer: true }, OPEN(base)));
    const strongConflict = settleWith(base, [{ observation: makeObservation(base, 'action.confirmed') }],
      Object.assign({ supersededByNewer: true }, OPEN(base)));
    check('D1.supersededBeatsStrongSupport', strongSupport.settlement.state === 'superseded',
      strongSupport.settlement.state);
    check('D2.supersededBeatsStrongConflict', strongConflict.settlement.state === 'superseded',
      strongConflict.settlement.state);
    check('D3.revisionDetectedAlsoSupersedes', (function () {
      const drifted = JSON.parse(JSON.stringify(base.predictionSnapshotAtCreation));
      drifted.semanticPayload.prediction = '用户会点 Confirm';
      const r = settleWith(base, [{ observation: makeObservation(base, 'action.cancelled') }],
        Object.assign({ snapshotAtSettlement: drifted }, OPEN(base)));
      return r.settlement.state === 'superseded' && r.settlement.revisionDetected === true;
    })(), 'a revised prediction must be superseded, not retro-blessed');
    check('D4.supersededIsNeverCountedAsCalibration', (function () {
      const r = settleWith(base, [{ observation: makeObservation(base, 'action.cancelled') }],
        Object.assign({ supersededByNewer: true }, OPEN(base)));
      return r.settlement.calibrationCounted === false
        && r.predictionError.calibrationEligible === false;
    })(), 'a superseded prediction cannot be "correct" and cannot count as independent confirmation');
    check('D5.lifecycleSupersededIsHonoured', (function () {
      const p = makePrediction({}, { turnId: 'turn_sup' });
      const sup = p.reg.markSuperseded(p.record.predictionId, 'test');
      return settleWith(sup.record, [{ observation: makeObservation(p.record, 'action.cancelled') }], OPEN(p.record))
        .settlement.state === 'superseded';
    })(), 'a registry-superseded prediction settles as superseded');
  }

  /* ══════════════════════════════════════════════════════════════════
     E · Opportunity
     ══════════════════════════════════════════════════════════════════ */
  section('E · opportunity semantics');
  {
    /* popup never shown → expired_unobserved */
    const p1 = makePrediction({}, { turnId: 'opp_absent' }).record;
    const r1 = settleWith(p1, [{ observation: makeObservation(p1, 'action.confirmed') }],
      { now: p1.observationWindow.closesAt + 1, testOpportunityFixture: opp(false, null) });
    check('E1.popupNeverShownIsExpiredNotMissed', r1.settlement.state === 'expired_unobserved',
      r1.settlement.state + ' ' + JSON.stringify(r1.settlement.reasonCodes));

    /* popup shown, no choice → NOT-CONSUMED → expired_unobserved */
    const p2 = makePrediction({}, { turnId: 'opp_notconsumed' }).record;
    const r2 = settleWith(p2, [{ observation: makeObservation(p2, 'action.confirmed') }],
      { now: p2.observationWindow.closesAt + 1, testOpportunityFixture: opp(true, null) });
    check('E2.shownButNotConsumedIsExpiredNotMissed',
      r2.settlement.state === 'expired_unobserved'
      && r2.settlement.reasonCodes.indexOf('opportunity-not-consumed') >= 0,
      r2.settlement.state + ' ' + JSON.stringify(r2.settlement.reasonCodes));

    /* popup shown + predicted choice → matched */
    const p3 = makePrediction({}, { turnId: 'opp_matched' }).record;
    const r3 = settleWith(p3, [{ observation: makeObservation(p3, 'action.cancelled') }], OPEN(p3));
    check('E3.shownAndPredictedChoiceIsMatched', r3.settlement.state === 'matched', r3.settlement.state);

    /* popup shown + mutually exclusive → missed */
    const p4 = makePrediction({}, { turnId: 'opp_missed' }).record;
    const r4 = settleWith(p4, [{ observation: makeObservation(p4, 'action.confirmed') }], OPEN(p4));
    check('E4.shownAndOppositeChoiceIsMissed', r4.settlement.state === 'missed', r4.settlement.state);

    /* opportunity UNKNOWN → never missed */
    const p5 = makePrediction({}, { turnId: 'opp_unknown' }).record;
    const r5 = settleWith(p5, [{ observation: makeObservation(p5, 'action.confirmed') }],
      { now: p5.observationWindow.closesAt + 1, testOpportunityFixture: null });
    check('E5.unknownOpportunityIsNeverMissed', r5.settlement.state !== 'missed',
      r5.settlement.state);

    check('E6.notRequiredOpportunityAllowsPositiveAuthority',
      CORE.deriveOpportunityFromGates(false, [], null) === 'NOT-REQUIRED',
      'NOT-REQUIRED is a first-class state');
    P('OPPORTUNITY_STATES', CORE.OPPORTUNITY_STATES.join(','));
  }

  /* ══════════════════════════════════════════════════════════════════
     F · Directional authority
     ══════════════════════════════════════════════════════════════════ */
  section('F · directional authority consumed, not reinvented');
  {
    const base = makePrediction().record;
    /* 语义 conflict + directional.conflict = FORBIDDEN ⇒ 不能 missed */
    const noOpp = settleWith(base, [{ observation: makeObservation(base, 'action.confirmed') }],
      { now: base.observationWindow.closesAt + 1, testOpportunityFixture: opp(false, null) });
    check('F1.semanticConflictWithForbiddenDirectionCannotMiss',
      noOpp.settlement.state !== 'missed'
      && noOpp.settlement.trace.discarded >= 1,
      noOpp.settlement.state + ' ' + JSON.stringify(noOpp.settlement.reasonCodes));

    /* 自发 explicit support + 机会 ABSENT ⇒ 正向仍可结算 */
    const spontaneous = settleWith(base, [{
      observation: makeObservation(base, 'action.cancelled', {
        source: 'CANONICAL_RUNTIME', sourceInstance: 'runtime.popup'
      })
    }], { now: base.observationWindow.closesAt + 1, testOpportunityFixture: opp(false, null) });
    check('F2.spontaneousSupportIsNotSuppressedByAbsentOpportunity',
      spontaneous.settlement.state === 'matched',
      spontaneous.settlement.state);

    check('F3.engineCallsTheAuthorityGateItself', (function () {
      const e = engine();
      const obs = makeObservation(base, 'action.cancelled');
      const r = e.settlePrediction(base, [{ observation: obs }], OPEN(base));
      return r.settlement.gateTraceRefs.length === 1
        && typeof r.settlement.gateTraceRefs[0].support === 'string';
    })(), 'the engine consumes the authority gate output');

    check('F4.aForgedGateIsRejected', (function () {
      const e = engine();
      const obs = makeObservation(base, 'action.cancelled');
      const forged = {
        effectiveAdmissibility: 'ELIGIBLE',
        directional: { support: 'ELIGIBLE', conflict: 'ELIGIBLE' },
        opportunityGate: 'SATISFIED'
      };
      const r = e.settlePrediction(base, [{ observation: obs, gate: forged }], OPEN(base));
      /* 真 gate 与伪造值一致时它可以被接受；关键在于**篡改**会被抓 */
      const tampered = Object.assign({}, forged, { directional: { support: 'FORBIDDEN', conflict: 'FORBIDDEN' } });
      const r2 = e.settlePrediction(makePrediction({}, { turnId: 'forge2' }).record,
        [{ observation: obs, gate: tampered }], OPEN(base));
      return (r.ok === true) && (r2.ok === false && r2.reasonCode === 'caller-supplied-gate-mismatch');
    })(), 'a caller-supplied gate must match the authority computation exactly');

    check('F5.engineDeclaresItConsumesAuthority',
      read(SETTLE_RT_REL).indexOf('authorityGate') >= 0
      && read(SETTLE_CORE_REL).indexOf('gate.directional') >= 0
      && read(SETTLE_CORE_REL).indexOf('directionalConflictForbidden') >= 0,
      'the engine must read directional authority and never re-derive it from source/domain');
  }

  /* ══════════════════════════════════════════════════════════════════
     G · Preference policy
     ══════════════════════════════════════════════════════════════════ */
  section('G · preference policy');
  {
    function prefPred(turnId, over) {
      return makePrediction(Object.assign({
        prediction: '用户喜欢这个功能',
        predicate: { kind: 'prefers' },
        expectedOutcome: { kind: 'exclusive-outcome', token: 'action.clicked' }
      }, over || {}), { turnId: turnId }).record;
    }
    const p1 = prefPred('pref_1');
    check('G1.typeIsPreference', p1.predictionType === 'preference', p1.predictionType);

    /* 1 次行为 ⇒ 绝不 matched（矩阵把行为压在 SUPPORTING） */
    const one = settleWith(p1, [{ observation: makeObservation(p1, 'action.clicked') }], OPEN(p1));
    check('G2.singleBehaviorNeverMatches', one.settlement.state !== 'matched',
      one.settlement.state + ' ' + JSON.stringify(one.settlement.reasonCodes));

    /* 3 个不同机会的行为 ⇒ v1 仍不自动 matched */
    const p2 = prefPred('pref_3');
    const three = settleWith(p2, [0, 1, 2].map(i => ({
      observation: makeObservation(p2, 'action.clicked', { observedAt: p2.observationWindow.opensAt + 1000 + i * 10 })
    })), OPEN(p2));
    check('G3.threeDistinctOpportunitiesStillDoNotAutoMatch',
      three.settlement.state !== 'matched'
      && three.settlement.supportSummary.decisive === 0,
      three.settlement.state + ' ' + JSON.stringify(three.settlement.supportSummary));

    /* explicit user report：P3 无 Evidence Matcher ⇒ 不可机械分类 ⇒ 不 decisive */
    const p3 = prefPred('pref_report');
    const report = settleWith(p3, [{
      observation: makeObservation(p3, 'x', {
        source: 'EXPLICIT_USER_REPORT', sourceInstance: 'chat.user-utterance',
        targetDomain: 'user_preference', outcomeRef: { kind: 'statement', statement: '我挺喜欢这个的' }
      })
    }], OPEN(p3));
    check('G4.explicitReportCannotBeMechanicallyClassifiedInP3',
      report.settlement.state !== 'matched'
      && report.settlement.reasonCodes.indexOf('relation-unclassifiable-without-evidence-matcher') >= 0,
      report.settlement.state + ' ' + JSON.stringify(report.settlement.reasonCodes));

    check('G5.independentObservationCountIsNeverWritten',
      read(SETTLE_CORE_REL).indexOf('independentObservationCount') < 0
      && read(SETTLE_RT_REL).indexOf('independentObservationCount') < 0
      && read(RECORD_CORE_REL).indexOf('independentObservationCount') < 0,
      'no PE module may write independentObservationCount');
    check('G6.policyTableKeepsBehaviorAutoSettleOff',
      RECORD_CORE.POLICY_TABLE.preference.autoSettlePreferenceFromBehavior === false,
      'AUTO_SETTLE_PREFERENCE_FROM_BEHAVIOR = OFF');
  }

  /* ══════════════════════════════════════════════════════════════════
     H · Latent-state policy
     ══════════════════════════════════════════════════════════════════ */
  section('H · latent-state policy');
  {
    function latentPred(turnId) {
      return makePrediction({
        prediction: '用户有点失望',
        predicate: { kind: 'is-in-state' },
        expectedOutcome: { kind: 'state-claim' }
      }, { turnId: turnId }).record;
    }
    const p = latentPred('latent_1');
    check('H1.typeIsLatentState', p.predictionType === 'latent_state', p.predictionType);

    /* 21 条 linguistic / supporting 信号 ⇒ 绝不 matched */
    const signals = [];
    for (let i = 0; i < 21; i += 1) {
      const o = makeObservation(p, 'x', {
        source: 'LINGUISTIC_EVIDENCE', sourceInstance: 'runtime.interpretation-evidence',
        targetDomain: 'latent_state',
        outcomeRef: { kind: 'statement', statement: '他好像不太高兴' },
        observedAt: p.observationWindow.opensAt + 500 + i * 5
      });
      if (o) signals.push({ observation: o });
    }
    const many = settleWith(p, signals, OPEN(p));
    check('H2.twentyOneLinguisticSignalsNeverMatch',
      many.settlement.state !== 'matched',
      'signals=' + signals.length + ' state=' + many.settlement.state);

    /* 行为信号 ⇒ 不 decisive */
    const behavior = settleWith(p, [{
      observation: makeObservation(p, 'action.dismissed', { targetDomain: 'user_behavior' })
    }], OPEN(p));
    check('H3.behaviorSignalsNeverSettleDecisively', behavior.settlement.state !== 'matched',
      behavior.settlement.state);

    /* 沉默 / 延迟 / 短回复：BEHAVIORAL_TELEMETRY 结构性禁止 */
    const telemetry = makeObservation(p, 'x', {
      source: 'BEHAVIORAL_TELEMETRY', sourceInstance: 'runtime.behavior-stats',
      targetDomain: 'latent_state', outcomeRef: { kind: 'statement', statement: '回复变短了' }
    });
    const silent = settleWith(p, [{ observation: telemetry }], OPEN(p));
    check('H4.silenceDelayShortReplyHaveNoSettlementAuthority',
      telemetry !== null
      && (silent.settlement.state !== 'matched' && silent.settlement.state !== 'missed')
      && (silent.settlement.trace.discarded >= 1 || silent.settlement.trace.unclassifiable >= 1),
      silent.settlement.state + ' ' + JSON.stringify(silent.settlement.trace));

    /* explicit report / denial ⇒ P3 不可机械分类（需要 Evidence Matcher） */
    const report = settleWith(p, [{
      observation: makeObservation(p, 'x', {
        source: 'EXPLICIT_USER_REPORT', sourceInstance: 'chat.user-utterance',
        targetDomain: 'latent_state', outcomeRef: { kind: 'statement', statement: '我确实有点失望' }
      })
    }], OPEN(p));
    check('H5.explicitReportWaitsForTheMatcher',
      report.settlement.state !== 'matched'
      && report.settlement.reasonCodes.indexOf('relation-unclassifiable-without-evidence-matcher') >= 0,
      report.settlement.state);
    P('STATEMENT_RELATION_CLASSIFICATION', 'REQUIRES_EVIDENCE_MATCHER_P5');
  }

  /* ══════════════════════════════════════════════════════════════════
     I · Relational policy + no relationship write
     ══════════════════════════════════════════════════════════════════ */
  section('I · relational policy');
  {
    const p = makePrediction({
      prediction: '我们的关系更近了一些',
      predicate: { kind: 'relationship-state' },
      expectedOutcome: { kind: 'state-claim' }
    }, { turnId: 'rel_1' }).record;
    check('I1.typeIsRelational', p.predictionType === 'relational', p.predictionType);

    const behavior = settleWith(p, [{
      observation: makeObservation(p, 'action.clicked', { targetDomain: 'relationship' })
    }], OPEN(p));
    check('I2.behaviorGivesNoAutomaticSettlement',
      behavior.settlement.state !== 'matched' && behavior.settlement.state !== 'missed',
      behavior.settlement.state);

    const report = settleWith(p, [{
      observation: makeObservation(p, 'x', {
        source: 'EXPLICIT_USER_REPORT', sourceInstance: 'chat.user-utterance',
        targetDomain: 'relationship', outcomeRef: { kind: 'statement', statement: '我觉得我们更近了' }
      })
    }], OPEN(p));
    check('I3.explicitReportWaitsForTheMatcher',
      report.settlement.state !== 'matched',
      report.settlement.state);

    const e = engine();
    check('I4.noRelationshipAuthorityIsDeclaredOrUsed',
      e.describe().relationshipAuthority === 'NONE'
      && read(SETTLE_CORE_REL).indexOf('relationDelta') < 0
      && read(SETTLE_RT_REL).indexOf('relationDelta') < 0
      && read(SETTLE_CORE_REL).indexOf('trust') < 0
      && read(SETTLE_RT_REL).indexOf('trust') < 0,
      'settlement must never touch trust / affinity / familiarity');
    check('I5.relationalAutoSettlementIsNo',
      RECORD_CORE.POLICY_TABLE.relational.autoSettlement === 'NO',
      'relational v1 never auto-settles');
  }

  /* ══════════════════════════════════════════════════════════════════
     J · Intervention contamination / attribution
     ══════════════════════════════════════════════════════════════════ */
  section('J · intervention contamination & attribution');
  {
    /* `[] != known-none` */
    const defaulted = makePrediction({}, { turnId: 'attr_default' }).record;
    check('J1.emptyEffectsArrayIsNotKnownAbsent',
      defaulted.behaviorEffectsInForce.length === 0
      && defaulted.behaviorEffectAttributionStatus === 'unknown'
      && defaulted.predictionInfluencedSystem === null
      && RECORD_CORE.attributionIsKnownAbsent(defaulted) === false,
      JSON.stringify({ n: defaulted.behaviorEffectsInForce.length, s: defaulted.behaviorEffectAttributionStatus }));

    const explicitNone = makePrediction({}, {
      turnId: 'attr_none', behaviorEffectAttribution: { status: 'known-none', effects: [] }
    }).record;
    check('J2.knownNoneMustBeDeclaredExplicitly',
      explicitNone.behaviorEffectAttributionStatus === 'known-none'
      && RECORD_CORE.attributionIsKnownAbsent(explicitNone) === true,
      explicitNone.behaviorEffectAttributionStatus);

    check('J3.outOfVocabularyAttributionIsRefused',
      makePrediction({}, { turnId: 'attr_bad', behaviorEffectAttribution: { status: 'probably-none' } }).res.settleable === false,
      'attribution status is a closed set');

    /* 主观域 + attribution unknown ⇒ 禁止 decisive settlement */
    const latent = makePrediction({
      prediction: '用户有点失望', predicate: { kind: 'is-in-state' }, expectedOutcome: { kind: 'state-claim' }
    }, { turnId: 'attr_latent' }).record;
    const r = settleWith(latent, [{
      observation: makeObservation(latent, 'action.cancelled', { targetDomain: 'user_behavior' })
    }], OPEN(latent));
    check('J4.unknownAttributionForbidsSubjectiveDecisiveSettlement',
      latent.behaviorEffectAttributionStatus === 'unknown'
      && r.settlement.trace.decisiveForbiddenUnknownAttribution === true
      && r.settlement.state !== 'matched'
      && r.settlement.reasonCodes.indexOf('decisive-settlement-forbidden-unknown-behavior-effect-attribution') >= 0,
      r.settlement.state + ' ' + JSON.stringify(r.settlement.reasonCodes));

    /* mechanism fact under intervention 仍是 fact；但不得升级到 preference 推断 */
    const event = makePrediction({}, { turnId: 'attr_event' }).record;
    const factUnderIntervention = settleWith(event, [{
      observation: makeObservation(event, 'action.confirmed', {
        interventionContext: {
          behaviorEffectsInForce: [], predictionInfluencedSystem: true,
          downstreamOfSystemAction: true, contaminationClass: 'LIKELY',
          contaminationBasis: 'system displayed the popup'
        }
      })
    }], OPEN(event));
    check('J5.mechanismFactKeepsAuthorityUnderIntervention',
      factUnderIntervention.settlement.state === 'missed',
      factUnderIntervention.settlement.state);
    check('J5b.outcomeTimeInfluencedDecisiveEvidenceIsNotCalibrationClean',
      factUnderIntervention.settlement.calibrationCounted === false
        && factUnderIntervention.settlement.calibrationEvidenceBasis.reasonCode
          === 'decisive-evidence-system-influenced',
      JSON.stringify({ counted: factUnderIntervention.settlement.calibrationCounted,
        basis: factUnderIntervention.settlement.calibrationEvidenceBasis }));

    const prefUnderIntervention = makePrediction({
      prediction: '用户喜欢这个功能', predicate: { kind: 'prefers' }, expectedOutcome: { kind: 'state-claim' }
    }, { turnId: 'attr_pref' }).record;
    const capped = settleWith(prefUnderIntervention, [{
      observation: makeObservation(prefUnderIntervention, 'x', {
        source: 'EXPLICIT_USER_REPORT', sourceInstance: 'chat.user-utterance',
        targetDomain: 'user_preference', outcomeRef: { kind: 'statement', statement: '我喜欢' },
        interventionContext: {
          behaviorEffectsInForce: [], predictionInfluencedSystem: true,
          downstreamOfSystemAction: true, contaminationClass: 'LIKELY',
          contaminationBasis: 'system displayed the popup'
        }
      })
    }], OPEN(prefUnderIntervention));
    check('J6.sameFactCannotBeUpgradedIntoPreference',
      capped.settlement.state !== 'matched',
      capped.settlement.state);

    /* known-present ⇒ calibrationCounted = false */
    const withEffect = makePrediction({}, {
      turnId: 'attr_present',
      behaviorEffectAttribution: { status: 'known-present', effects: [{ sourceTurn: 'turn_x' }], influenced: true }
    }).record;
    const influenced = settleWith(withEffect, [{ observation: makeObservation(withEffect, 'action.cancelled') }], OPEN(withEffect));
    check('J7.knownPresentBlocksCalibrationCounting',
      influenced.settlement.state === 'matched'
      && influenced.settlement.calibrationCounted === false
      && influenced.predictionError.calibrationEligible === false
      && influenced.settlement.reasonCodes.indexOf('self-influenced-settlement-is-not-independent-confirmation') >= 0,
      JSON.stringify({ s: influenced.settlement.state, c: influenced.settlement.calibrationCounted }));
  }

  /* ══════════════════════════════════════════════════════════════════
     K · Prediction Error lookup
     ══════════════════════════════════════════════════════════════════ */
  section('K · ordinal Prediction Error');
  {
    let mismatches = [], cells = 0;
    for (const st of CORE.SETTLEMENT_STATES) {
      for (const bucket of CORE.CONFIDENCE_BUCKETS) {
        cells += 1;
        const got = CORE.computePredictionError(st, bucket);
        const want = ORACLE_PE[st][bucket];
        if (got.direction !== want[0] || got.magnitude !== want[1]) {
          mismatches.push(st + '/' + bucket + ' => ' + got.direction + ',' + got.magnitude + ' want ' + want.join(','));
        }
        if (got.predictionErrorMetric !== null) mismatches.push(st + '/' + bucket + ' metric !== null');
      }
    }
    check('K1.lookupTableMatchesTheFrozenTable', mismatches.length === 0,
      'cells=' + cells + ' ' + JSON.stringify(mismatches.slice(0, 3)));
    check('K2.highConfidenceMissIsHighMagnitude',
      CORE.computePredictionError('missed', 'high').direction === 'over-confident'
      && CORE.computePredictionError('missed', 'high').magnitude === 'high',
      'high confidence + miss ⇒ high prediction error');
    check('K3.lowConfidenceMissIsLowerMagnitude',
      CORE.computePredictionError('missed', 'low').magnitude === 'low'
      && CORE.computePredictionError('missed', 'medium').magnitude === 'moderate',
      'a low-confidence miss is a smaller error');
    check('K4.unstatedIsUnknownNeverGuessed',
      ['matched', 'missed', 'mixed', 'expired_unobserved', 'unresolvable', 'superseded'].every(st =>
        CORE.computePredictionError(st, 'unstated').direction === 'unknown'
        && CORE.computePredictionError(st, 'unstated').magnitude === 'unknown'),
      'unstated confidence must never be turned into a number');
    check('K5.metricIsAlwaysNull',
      CORE.PREDICTION_ERROR_METRIC === null
      && CORE.SETTLEMENT_STATES.every(st => CORE.CONFIDENCE_BUCKETS.every(b =>
        CORE.computePredictionError(st, b).predictionErrorMetric === null)),
      'predictionErrorMetric must be null for every cell');
    check('K6.bucketsAreTheFrozenFour',
      JSON.stringify(CORE.CONFIDENCE_BUCKETS) === JSON.stringify(['low', 'medium', 'high', 'unstated'])
      && CORE.confidenceBucketOf(0.1) === 'low' && CORE.confidenceBucketOf(0.34) === 'low'
      && CORE.confidenceBucketOf(0.35) === 'medium' && CORE.confidenceBucketOf(0.66) === 'medium'
      && CORE.confidenceBucketOf(0.67) === 'high' && CORE.confidenceBucketOf(1) === 'high'
      && CORE.confidenceBucketOf(null) === 'unstated',
      'bucket boundaries must be frozen');
    check('K7.noNumericOrBayesianValueAnywhere', (function () {
      const src = read(SETTLE_CORE_REL);
      if (/brier|posterior|bayesian|learnedScore|Math\.sqrt|Math\.pow/i.test(src)) return false;
      /* 每一处 predictionErrorMetric **必须**被赋成 null 或那个常量。
         （不要用 (?!null) 前瞻：`\s*` 会回溯，导致 `: null` 也被判成非 null。） */
      return src.split('\n')
        .filter(l => /predictionErrorMetric\s*[:=]/.test(l))
        .every(l => /predictionErrorMetric\s*[:=]\s*(null|PREDICTION_ERROR_METRIC)\b/.test(l));
    })(), 'no numeric PE metric may exist');
    P('PE_TABLE_CELLS_VERIFIED', cells);
  }

  /* ══════════════════════════════════════════════════════════════════
     L · No mutation
     ══════════════════════════════════════════════════════════════════ */
  section('L · no mutation proof');
  {
    /* 静态：两个新模块零非法路径 */
    const PATTERNS = [
      ['dbPut', /\bdbPut\b/], ['dbGet', /\bdbGet\b/], ['indexedDB', /indexedDB/],
      ['localStorage', /localStorage/], ['writeFile', /\bwriteFile\b/],
      ['fetch', /\bfetch\s*\(/], ['provider', /require\([^)]*provider|providerConfig/],
      ['model port', /require\([^)]*model-port|modelPort\s*\./],
      ['applyCalibration', /applyCalibration/],
      ['memory write', /require\([^)]*memory-store|\bputRecord\b|\brewrite\s*\(/],
      ['relationship write', /relationDelta|relationshipStore/],
      ['trust', /\btrust\b/], ['affinity', /\baffinity\b/], ['familiarity', /\bfamiliarity\b/],
      ['Date.now', /Date\.now/], ['Math.random', /Math\.random/]
    ];
    const hits = [];
    for (const rel of [SETTLE_CORE_REL, SETTLE_RT_REL]) {
      const code = WIRING.stripJsComments(read(rel));
      for (const [name, re] of PATTERNS) if (re.test(code)) hits.push(rel + ':' + name);
    }
    check('L1.staticNoForbiddenPath', hits.length === 0, JSON.stringify(hits));

    /* 动态：真实 canonical memory store 前后逐字节一致 */
    const createMemoryStore = require(path.join(ROOT, 'services', 'home-node', 'memory-store.js'));
    const scratchRoot = path.join(ROOT, '.dsh-tmp');
    fs.mkdirSync(scratchRoot, { recursive: true });
    const dir = fs.mkdtempSync(path.join(scratchRoot, 'p3-nomut-'));
    let store = null;
    try {
      store = createMemoryStore({ dataDir: dir, clock: () => T0, logger: () => {} });
      store.open();
      store.putRecord({
        id: 'mem_p3', title: 'T', summary: 's', content: 'canonical content',
        kind: 'episodic', createdBy: 'user', visibility: 'public',
        created: T0 - 1000, importance: 5
      }, { requestId: 'p3-write-1' });
      const before = JSON.stringify(store.getRecord('mem_p3'));
      const beforeRevision = store.describe ? JSON.stringify(store.describe()) : null;

      const pred = makePrediction({}, { turnId: 'nomut' }).record;
      const e = engine();
      e.settlePrediction(pred, [{
        observation: makeObservation(pred, 'action.confirmed', { evidenceRefs: ['mem_p3'] })
      }], OPEN(pred));

      const after = JSON.stringify(store.getRecord('mem_p3'));
      const afterRevision = store.describe ? JSON.stringify(store.describe()) : null;
      check('L2.canonicalMemoryByteIdenticalAfterSettlement', before === after && before !== 'null',
        'the settlement must leave the canonical record byte-identical');
      check('L3.storeRevisionUnchanged', beforeRevision === afterRevision,
        'the store describe() projection must be unchanged');
    } finally {
      try { if (store && typeof store.close === 'function') store.close(); } catch (e) { /* ignore */ }
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
    }

    check('L4.setttlementNeverRequiresAStore',
      read(SETTLE_RT_REL).indexOf('memory-store') < 0
      && read(SETTLE_RT_REL).indexOf('understanding-store') < 0
      && read(SETTLE_RT_REL).indexOf('role-dm') < 0,
      'the settlement runtime has no store dependency at all');
    check('L5.recallEnvelopeUntouched',
      read('services/home-node/runtime-recall.js').indexOf('predictionSettlement') < 0
      && read('services/home-node/runtime-recall.js').indexOf('settlement') < 0,
      'the recall envelope must not learn about settlement');
    check('L6.uiDisclosureUnchanged',
      read('InternalBeyond.html').indexOf('prediction-settlement') < 0
      && read('InternalBeyond.html').indexOf('runtime-prediction-settlement') < 0,
      'no HTML / UI surface may load the settlement engine');
    check('L7.internalAuditOnlyDeclared',
      engine().describe().disclosure === 'INTERNAL_AUDIT_ONLY'
      && engine().describe().contentExposed === 'NO'
      && engine().describe().routes === 'NONE'
      && engine().describe().browserVisible === 'NO',
      'SETTLEMENT_DISCLOSURE_V1 = INTERNAL_AUDIT_ONLY');
  }

  /* ══════════════════════════════════════════════════════════════════
     M · Guard / seam
     ══════════════════════════════════════════════════════════════════ */
  section('M · guard seam');
  {
    const coreAudit = G.auditSettlementAuthoritySurface(read(SETTLE_CORE_REL));
    const rtAudit = G.auditSettlementAuthoritySurface(read(SETTLE_RT_REL));
    check('M1.settlementAuthoritySurfacesAreClean', coreAudit.ok === true && rtAudit.ok === true,
      JSON.stringify(coreAudit.reasons.concat(rtAudit.reasons)));

    const others = [
      'services/home-node/runtime-recall.js',
      'services/home-node/runtime-interpretation.js',
      'services/home-node/runtime-expectation.js',
      'services/home-node/runtime-behavior-effect.js',
      'assets/js/communication.js'
    ];
    /* 只查**结算**能力记号：`predictionRegistry` 是 P2 已批准的 seam，不属于本断言。 */
    const SETTLEMENT_ONLY_TOKENS = ['runtime-prediction-settlement', 'createRuntimePredictionSettlement',
      'predictionSettlement', 'settlementEngine'];
    const leaky = others.filter(rel => {
      const code = WIRING.stripJsComments(read(rel));
      return !G.auditSettlementSurface(code).ok
        || SETTLEMENT_ONLY_TOKENS.some(t => G.containsSemantic(code, t));
    });
    check('M2.noSecondSettlementSeamInAnyOtherRuntime', leaky.length === 0, JSON.stringify(leaky));

    const svc = read('services/home-node-service.js');
    check('M3.singleApprovedAssemblyPath',
      svc.indexOf('runtime-prediction-settlement.js') >= 0
      && svc.indexOf('createRuntimePredictionSettlement(') >= 0
      && svc.indexOf('runtimePredictionSettlement: runtimePredictionSettlement') >= 0
      && svc.indexOf('runtimePredictionSettlement: instanceRuntimePredictionSettlement') >= 0,
      'exactly one assembly path constructs and exports the settlement engine');

    check('M4.noHttpRouteForSettlement',
      read('services/home-node/http.js').indexOf('predictionSettlement') < 0
      && read('services/home-node/mobile-gateway.js').indexOf('predictionSettlement') < 0,
      'the settlement engine must not gain a route');

    const req = require.resolve(path.join(ROOT, 'assets/js/memory-recall/outcome-observation-core.js'));
    const rtSrc = read(SETTLE_RT_REL);
    check('M5.sharesTheObservationAuthorityInstance',
      rtSrc.indexOf("require(path.join(ASSETS_JS, 'memory-recall', 'outcome-observation-core.js'))") >= 0
      && require.cache[req] !== undefined,
      'same-process require ⇒ same loaded core instance (SAME_MODULE_INSTANCE_REQUIRED)');
  }

  /* ══════════════════════════════════════════════════════════════════
     N · API surface + scope
     ══════════════════════════════════════════════════════════════════ */
  section('N · API surface & scope');
  {
    const e = engine();
    const api = Object.keys(e);
    const forbidden = ['writeMemory', 'writeRelationship', 'updateRelationship', 'applyCalibration',
      'callModel', 'confirm', 'contradict'];
    const leaked = forbidden.filter(f => api.some(k => k.toLowerCase().indexOf(f.toLowerCase()) >= 0));
    check('N1.noForbiddenApi', leaked.length === 0, JSON.stringify(leaked));
    check('N2.apiIsMinimal',
      JSON.stringify(api.sort()) === JSON.stringify([
        'ENTRY', 'awaitIdle', 'calibrationReachability', 'computePredictionError', 'describe',
        'getPredictionError', 'getSettlement', 'heldCount', 'inspectSettlement', 'settlePrediction',
        /* P5-B · 唯一 matcher-aware 入口（async）；同步路径恒无 matcher relation */
        'settlePredictionWithEvidenceMatcher'
      ].sort()),
      JSON.stringify(api.sort()));
    check('N3.inspectViewCarriesNoRawBodies', (function () {
      const pred = makePrediction({}, { turnId: 'inspect' }).record;
      const en = engine();
      en.settlePrediction(pred, [{ observation: makeObservation(pred, 'action.cancelled') }], OPEN(pred));
      const s = JSON.stringify(en.inspectSettlement(pred.predictionId).view);
      return s.indexOf('用户会点') < 0 && s.indexOf('evidence_1') < 0 && s.indexOf('action.cancelled') < 0;
    })(), 'the audit view must be structural only');

    P('P3_STATUS', 'COMPLETE');
    P('SETTLEMENT_ENGINE_LIVE', 'YES');
    P('LIVE_SETTLEMENT', 'YES');
    P('PREDICTION_ERROR', 'ORDINAL_ONLY');
    P('PREDICTION_ERROR_METRIC', 'null');
    P('CALIBRATION_LEDGER_LIVE', 'NO');
    P('CALIBRATION_APPLIED_TO_LIVE', 'NO');
    P('MODEL_CALLS_ADDED', 0);
    P('DURABLE_WRITES_ADDED', 0);
    P('MEMORY_WRITE_FROM_SETTLEMENT', 'FORBIDDEN');
    P('RELATIONSHIP_WRITE_FROM_SETTLEMENT', 'FORBIDDEN');
    P('RECALL_ENVELOPE_CHANGED', 'NO');
    P('UI_DISCLOSURE_CHANGED', 'NO');
    P('NEXT_ALLOWED_PHASE', 'P4');
  }

  console.log('\n' + '='.repeat(64));
  if (failures) {
    console.error('PREDICTION SETTLEMENT FAILED · ' + failures + ' assertion(s), ' + passed + ' passed');
    process.exit(1);
  }
  console.log('PREDICTION SETTLEMENT PASSED · ' + passed + ' assertions green');
})();
