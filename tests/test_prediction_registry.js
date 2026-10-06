'use strict';
/* ══════════════════════════════════════════════════════════════════════════
   Internal Beyond · Prediction Error P2 · Prediction Registry
   （纯 Node，零浏览器、零网络、**零模型调用**、零 durable 写）

   运行：node tests/test_prediction_registry.js

   本套件证明的是 P2 的**唯一**新 live 能力：

     validated Expectation → deterministic projection → PredictionRecord
     → bounded session-only holder

   它**不**证明（且必须证明**没做**）：
     settlement · matched/missed/mixed · Prediction Error 幅度 ·
     Calibration 回写 · Evidence Matcher · 模型调用 · durable 写 ·
     recall 信封扩展 · UI / prompt / export 披露。
   ══════════════════════════════════════════════════════════════════════════ */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const CORE_REL = 'assets/js/memory-recall/prediction-record-core.js';
const REG_REL = 'services/home-node/runtime-prediction-registry.js';
const G = require('./helpers/runtime-seam-guard.js');
const WIRING = require('./helpers/activation-wiring-probe.js');
const CORE = require(path.join(ROOT, CORE_REL));
const { createRuntimePredictionRegistry } = require(path.join(ROOT, REG_REL));

let passed = 0, failures = 0;
const check = (n, c, d) => {
  if (c) { passed++; console.log('  PASS  ' + n); return true; }
  failures++; console.error('  FAIL  ' + n + (d ? '  -> ' + d : '')); return false;
};
const section = t => console.log('\n── ' + t + ' ──');
const P = (k, v) => console.log('  FACTS ' + k + ' = ' + v);
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const T0 = 1760000000000;
const SCOPE = { characterId: 'char_A', conversationId: 'dm:char_A', turnId: 'turn_1' };

function expectation(over) {
  const base = {
    epistemicStatus: 'prediction',
    prediction: '用户明天会点 Cancel',
    trigger: { kind: 'explicit-cue', label: '弹窗出现时' },
    evidenceMemoryIds: ['m1'],
    contradictoryEvidenceIds: [],
    generalizationLevel: 'episode-hypothesis',
    subjectivePredictionConfidence: 0.7,
    subject: { kind: 'user', label: '' },
    predicate: { kind: 'will-do' },
    expectedOutcome: { kind: 'exclusive-outcome', token: 'action.cancelled' }
  };
  return Object.assign({}, base, over || {});
}
function ctx(over) {
  return Object.assign({ now: T0, expectationIndex: 0 }, SCOPE, over || {});
}
function registry(over) {
  return createRuntimePredictionRegistry(Object.assign({ clock: () => T0 }, over || {}));
}
function project(expOver, ctxOver, regOver) {
  const r = registry(regOver);
  const res = r.projectFromValidatedExpectation(expectation(expOver), ctx(ctxOver));
  return { r: r, res: res, record: res.record };
}

/* ── 测试自带的 TYPE_TABLE oracle（独立于实现，逐格比对）───────────────── */
const ORACLE_TYPE = {
  'will-do': 'event', 'will-not-do': 'event', 'will-occur': 'event',
  'is-in-state': 'latent_state', prefers: 'preference', 'holds-stance': 'preference',
  'relationship-state': 'relational', 'relationship-change': 'relational'
};
const ORACLE_SUBJECT = {
  event: ['character-self', 'user', 'third-party', 'system', 'world'],
  preference: ['user'], latent_state: ['user'], relational: ['user']
};
const ORACLE_OUTCOME = {
  event: ['exclusive-outcome', 'threshold', 'window-occurrence', 'denial-claim'],
  preference: ['exclusive-outcome', 'state-claim', 'denial-claim'],
  latent_state: ['state-claim', 'denial-claim'],
  relational: ['state-claim', 'denial-claim']
};
const ORACLE_MODE = {
  'event|exclusive-outcome': 'exclusive_outcome',
  'event|threshold': 'threshold',
  'event|window-occurrence': 'window_closure_negative',
  'event|denial-claim': 'explicit_denial',
  'preference|exclusive-outcome': 'exclusive_outcome',
  'preference|state-claim': 'explicit_denial',
  'preference|denial-claim': 'explicit_denial',
  'latent_state|state-claim': 'explicit_denial',
  'latent_state|denial-claim': 'explicit_denial',
  'relational|state-claim': 'explicit_denial',
  'relational|denial-claim': 'explicit_denial'
};

(function main() {
  /* ══════════════════════════════════════════════════════════════════
     A · Identity
     ══════════════════════════════════════════════════════════════════ */
  section('A · prediction identity');
  {
    const a = project().record;
    const b = project().record;
    check('A1.sameInputSameId', a.predictionId === b.predictionId, a.predictionId + ' vs ' + b.predictionId);
    check('A2.idIsPrefixedAndDeclaresLifetime',
      a.predictionId.indexOf('pred_') === 0 && a.idLifetime === 'SESSION_ONLY',
      'identity must be prefixed and explicitly session-only');
    check('A3.registrySessionRefPresentAndNotIdentity',
      typeof a.registrySessionRef === 'string' && a.registrySessionRef.indexOf('sess_') === 0
      && a.registrySessionRef !== a.predictionId,
      'registrySessionRef is audit-only, distinct from predictionId');

    const semanticChanges = [
      ['subjectLabel', { subject: { kind: 'user', label: 'someone' } }],
      ['predicate', { predicate: { kind: 'will-not-do' } }],
      ['outcomeToken', { expectedOutcome: { kind: 'exclusive-outcome', token: 'action.confirmed' } }],
      ['predictionText', { prediction: '用户明天会点 Confirm' }]
    ];
    const retained = semanticChanges.filter(c => project(c[1]).record.predictionId === a.predictionId);
    check('A4.semanticChangeChangesIdentity', retained.length === 0,
      'these semantic changes kept the same id: ' + JSON.stringify(retained.map(r => r[0])));

    const slotChanges = [
      ['turnId', { turnId: 'turn_2' }],
      ['expectationIndex', { expectationIndex: 1 }],
      ['conversationId', { conversationId: 'dm:other' }],
      ['characterId', { characterId: 'char_B' }]
    ];
    const slotRetained = slotChanges.filter(c => project({}, c[1]).record.predictionId === a.predictionId);
    check('A5.slotChangeChangesIdentity', slotRetained.length === 0,
      'slot changes kept the same id: ' + JSON.stringify(slotRetained.map(r => r[0])));

    const coreSrc = WIRING.stripJsComments(read(CORE_REL));
    check('A6.identityHasNoRandomClockOrCounter',
      !/Math\.random/.test(coreSrc) && !/Date\.now/.test(coreSrc)
      && !/\+\+\s*$|let\s+counter|var\s+counter/.test(coreSrc),
      'identity must not read a clock/random or increment a global counter');
    check('A7.mintPredictionIdRequiresIdentity',
      CORE.mintPredictionId({ characterId: '', conversationId: 'x', turnId: 'y' }) === null
      && CORE.mintPredictionId({ characterId: 'a', conversationId: 'b', turnId: 'c', semanticFingerprint: 'f' })
        .indexOf('pred_') === 0,
      'the id minter fails closed without a full identity');
  }

  /* ══════════════════════════════════════════════════════════════════
     B · Non-expansive projection
     ══════════════════════════════════════════════════════════════════ */
  section('B · projection discipline');
  {
    const exp = expectation();
    const rec = project().record;
    const snap = rec.predictionSnapshotAtCreation.semanticPayload;
    check('B1.semanticPayloadIsAnExactCopy',
      snap.prediction === exp.prediction
      && snap.subject.kind === exp.subject.kind && snap.subject.label === exp.subject.label
      && snap.predicate.kind === exp.predicate.kind
      && snap.expectedOutcome.kind === exp.expectedOutcome.kind
      && snap.expectedOutcome.token === exp.expectedOutcome.token
      && snap.generalizationLevel === exp.generalizationLevel
      && snap.trigger.kind === exp.trigger.kind,
      'the payload must be the expectation\'s own content, not a paraphrase');
    check('B2.semanticPayloadHasNoExtraCognitiveKeys',
      JSON.stringify(Object.keys(snap).sort()) === JSON.stringify(
        ['expectedOutcome', 'generalizationLevel', 'predicate', 'prediction', 'subject', 'trigger'].sort()),
      'keys=' + JSON.stringify(Object.keys(snap)));
    check('B3.governanceFieldsAreTheOnlyAdditions',
      ['predictionId', 'registrySessionRef', 'idLifetime', 'createdAt', 'observationWindow',
        'settlementPolicy', 'predictionType', 'contradictionMode', 'lifecycleState'].every(k =>
        Object.prototype.hasOwnProperty.call(rec, k)),
      'only system governance fields may be added');

    const unstructured = project({ subject: undefined, predicate: undefined, expectedOutcome: undefined });
    check('B4.unstructuredExpectationIsNotSettleableButNotAnError',
      unstructured.res.settleable === false
      && unstructured.res.status === 'not-settleable'
      && unstructured.res.reasonCode === 'missing-structured-prediction-fields'
      && unstructured.record === null,
      'a legacy expectation stays legal — it is simply not settleable');

    const partial = [
      [{ predicate: undefined }, 'missing-structured-prediction-fields'],
      [{ subject: { kind: 'nobody', label: '' } }, 'subject-kind-out-of-vocabulary'],
      [{ predicate: { kind: 'vibes' } }, 'predicate-kind-out-of-vocabulary'],
      [{ expectedOutcome: { kind: 'whatever' } }, 'outcome-kind-out-of-vocabulary'],
      /* 主观类型只接受 user 主体：第三方 / 系统 / 世界都必须被拒 */
      [{ subject: { kind: 'third-party', label: 'x' }, predicate: { kind: 'prefers' } }, 'subject-kind-not-permitted-for-type'],
      [{ subject: { kind: 'system' }, predicate: { kind: 'is-in-state' } }, 'subject-kind-not-permitted-for-type'],
      /* event 不接受 state-claim */
      [{ expectedOutcome: { kind: 'state-claim' } }, 'contradiction-mode-not-permitted-for-type']
    ];
    const wrong = partial.filter(([over, want]) => project(over).res.reasonCode !== want);
    check('B5.rejectionsAreNamedAndSpecific', wrong.length === 0,
      JSON.stringify(wrong.map(w => w[0] + ' -> wanted ' + w[1])));

    const coreSrc = WIRING.stripJsComments(read(CORE_REL));
    check('B6.noFreeTextParsingOrModelFallback',
      !/\bfetch\s*\(|modelPort|provider|invokeOnce|JSON\.parse/.test(coreSrc)
      && !/split\(|match\(|RegExp|new RegExp/.test(coreSrc),
      'the projection must never parse free text or fall back to a model');
    check('B7.registryMayNotInventContent',
      CORE.STATE_SUPPORT.registryMayNotInventContent === 'YES'
      && CORE.STATE_SUPPORT.freeTextToPredictionParsing === 'FORBIDDEN'
      && CORE.STATE_SUPPORT.projectionIsContentNonExpansive === 'YES',
      'the core must declare its own non-inventive boundary');
  }

  /* ══════════════════════════════════════════════════════════════════
     C · Type authority（TYPE_TABLE 全枚举）
     ══════════════════════════════════════════════════════════════════ */
  section('C · TYPE_TABLE (exhaustive)');
  {
    const subjects = CORE.SUBJECT_KINDS.slice();
    const predicates = CORE.PREDICATE_KINDS.slice();
    const outcomes = CORE.OUTCOME_KINDS.slice();
    let mismatches = [], total = 0;
    for (const pk of predicates) {
      for (const sk of subjects) {
        for (const ok of outcomes) {
          total += 1;
          const got = CORE.derivePredictionType({
            subject: { kind: sk }, predicate: { kind: pk }, expectedOutcome: { kind: ok }
          });
          const type = ORACLE_TYPE[pk];
          let want;
          if (ORACLE_SUBJECT[type].indexOf(sk) < 0) want = { ok: false, reasonCode: 'subject-kind-not-permitted-for-type' };
          else if (ORACLE_OUTCOME[type].indexOf(ok) < 0) want = { ok: false, reasonCode: 'contradiction-mode-not-permitted-for-type' };
          else want = { ok: true, predictionType: type };
          const same = got.ok === want.ok
            && (want.ok ? got.predictionType === want.predictionType : got.reasonCode === want.reasonCode);
          if (!same) mismatches.push(sk + '|' + pk + '|' + ok + ' => ' + JSON.stringify(got) + ' want ' + JSON.stringify(want));
        }
      }
    }
    check('C1.typeTableIsExactlyTheFrozenTable', mismatches.length === 0,
      'mismatches=' + mismatches.length + ' ' + JSON.stringify(mismatches.slice(0, 4)));

    check('C2.prefersIsPreferenceOnly',
      CORE.derivePredictionType({ subject: { kind: 'user' }, predicate: { kind: 'prefers' }, expectedOutcome: { kind: 'state-claim' } }).predictionType === 'preference'
      && CORE.derivePredictionType({ subject: { kind: 'user' }, predicate: { kind: 'prefers' }, expectedOutcome: { kind: 'threshold' } }).ok === false,
      'prefers can never become event (no threshold arbitrage)');
    check('C3.holdsStanceIsPreferenceNotRelational',
      CORE.derivePredictionType({ subject: { kind: 'user' }, predicate: { kind: 'holds-stance' }, expectedOutcome: { kind: 'state-claim' } }).predictionType === 'preference',
      'a stance about a topic is not a relationship claim');
    check('C4.relationshipPredicatesAreTheOnlyRelationalRoute',
      CORE.derivePredictionType({ subject: { kind: 'user' }, predicate: { kind: 'relationship-state' }, expectedOutcome: { kind: 'state-claim' } }).predictionType === 'relational'
      && CORE.derivePredictionType({ subject: { kind: 'user' }, predicate: { kind: 'relationship-change' }, expectedOutcome: { kind: 'state-claim' } }).predictionType === 'relational',
      'relational is reachable only through relationship-state / relationship-change');
    check('C5.subjectKindIsTightenedPerType',
      CORE.derivePredictionType({ subject: { kind: 'world' }, predicate: { kind: 'prefers' }, expectedOutcome: { kind: 'state-claim' } }).ok === false
      && CORE.derivePredictionType({ subject: { kind: 'system' }, predicate: { kind: 'is-in-state' }, expectedOutcome: { kind: 'state-claim' } }).ok === false,
      'subjective types accept only the user as subject');
    check('C6.modelCannotSupplyPredictionType',
      project({ predictionType: 'event' }).record.predictionType === 'event'
      && project({ predictionType: 'preference' }).record.predictionType === 'event',
      'a model-supplied predictionType is ignored — the system derives it');
    P('TYPE_TABLE_COMBINATIONS', total);
  }

  /* ══════════════════════════════════════════════════════════════════
     D · Policy derivation
     ══════════════════════════════════════════════════════════════════ */
  section('D · policy & contradiction mode');
  {
    const cases = [
      [{ predicate: { kind: 'will-do' }, expectedOutcome: { kind: 'exclusive-outcome' } }, 'event', 'exclusive_outcome'],
      [{ predicate: { kind: 'will-occur' }, expectedOutcome: { kind: 'threshold' } }, 'event', 'threshold'],
      [{ predicate: { kind: 'will-occur' }, expectedOutcome: { kind: 'window-occurrence' } }, 'event', 'window_closure_negative'],
      [{ predicate: { kind: 'will-do' }, expectedOutcome: { kind: 'denial-claim' } }, 'event', 'explicit_denial'],
      [{ predicate: { kind: 'prefers' }, expectedOutcome: { kind: 'state-claim' } }, 'preference', 'explicit_denial'],
      [{ predicate: { kind: 'prefers' }, expectedOutcome: { kind: 'exclusive-outcome' } }, 'preference', 'exclusive_outcome'],
      [{ predicate: { kind: 'is-in-state' }, expectedOutcome: { kind: 'state-claim' } }, 'latent_state', 'explicit_denial'],
      [{ predicate: { kind: 'relationship-state' }, expectedOutcome: { kind: 'state-claim' } }, 'relational', 'explicit_denial']
    ];
    const bad = cases.filter(([over, type, mode]) => {
      const rec = project(over).record;
      return !rec || rec.predictionType !== type || rec.contradictionMode !== mode;
    });
    check('D1.policyAndModeAreSystemDerived', bad.length === 0, JSON.stringify(bad));

    const oracleMismatch = Object.keys(ORACLE_MODE).filter(k => {
      const [type, ok] = k.split('|');
      return CORE.deriveContradictionMode(type, ok) !== ORACLE_MODE[k];
    });
    check('D2.modeTableMatchesTheFrozenContract', oracleMismatch.length === 0, JSON.stringify(oracleMismatch));

    check('D3.policyTableIsClosedAndSystemOwned',
      CORE.PREDICTION_TYPES.every(t => CORE.derivePolicy(t) && CORE.derivePolicy(t).type === t)
      && CORE.derivePolicy('not-a-type') === null,
      'every type has exactly one policy; unknown types have none');
    check('D4.preferenceBehaviorAutoSettlementIsOff',
      CORE.POLICY_TABLE.preference.autoSettlePreferenceFromBehavior === false
      && CORE.POLICY_TABLE.relational.autoSettlement === 'NO',
      'AUTO_SETTLE_PREFERENCE_FROM_BEHAVIOR = OFF and relational never auto-settles');
    check('D5.modelCannotInfluenceWindow',
      project({ trigger: { kind: 'time-bound', label: 'x' } }).record.observationWindow.windowKind === 'explicit-cue'
      && project({ trigger: { kind: 'time-bound', label: 'x' } }).record.observationWindow.durationMs
        === project({ trigger: { kind: 'same-topic', label: 'x' } }).record.observationWindow.durationMs,
      'the trigger may relabel the window but never lengthen it');
    check('D6.windowIsSystemDerivedAndBounded',
      project().record.observationWindow.timeAuthority === 'SYSTEM_DERIVED'
      && project().record.observationWindow.opensAt === T0
      && project().record.observationWindow.closesAt > T0,
      'window is derived, not supplied');
  }

  /* ══════════════════════════════════════════════════════════════════
     E · Snapshot immutability
     ══════════════════════════════════════════════════════════════════ */
  section('E · creation snapshot immutability');
  {
    const exp = expectation();
    const r = registry();
    const first = r.projectFromValidatedExpectation(exp, ctx());
    const before = CORE.canonicalize(first.record.predictionSnapshotAtCreation);

    /* 1 · 改写源 Expectation（含嵌套对象与数组）*/
    exp.prediction = 'MUTATED';
    exp.subject.kind = 'system';
    exp.predicate.kind = 'will-occur';
    exp.expectedOutcome.kind = 'threshold';
    exp.evidenceMemoryIds.push('m2');
    exp.trigger.kind = 'time-bound';
    const afterSourceMutation = CORE.canonicalize(first.record.predictionSnapshotAtCreation);
    check('E1.sourceExpectationMutationCannotRewriteTheSnapshot',
      afterSourceMutation === before, 'the snapshot changed when the source expectation was mutated');

    /* 2 · 记录本身被 deepFreeze ⇒ 直接改写不可能 */
    let threw = false;
    try { first.record.predictionType = 'preference'; } catch (e) { threw = true; }
    check('E2.recordAndSnapshotAreDeepFrozen',
      Object.isFrozen(first.record)
      && Object.isFrozen(first.record.predictionSnapshotAtCreation)
      && Object.isFrozen(first.record.predictionSnapshotAtCreation.semanticPayload.subject)
      && threw === true
      && first.record.predictionType === 'event',
      'the record is frozen; the snapshot cannot be rewritten in place');

    /* 3 · 重复投影同一语义 ⇒ 幂等，且不覆盖既有快照 */
    const again = r.projectFromValidatedExpectation(expectation(), ctx());
    check('E3.reprojectionIsIdempotentAndKeepsTheFirstSnapshot',
      again.status === 'already-registered'
      && CORE.canonicalize(again.record.predictionSnapshotAtCreation) === before,
      're-projection must return the original record, never overwrite the snapshot');

    check('E4.snapshotCarriesEverythingSettlementWillNeed',
      (function () {
        const s = first.record.predictionSnapshotAtCreation;
        return !!s.semanticPayload && !!s.semanticFingerprint && !!s.predictionType
          && !!s.settlementPolicy && !!s.contradictionMode
          && Number.isFinite(s.createdAt) && !!s.observationWindow
          && !!s.scope && !!s.sourceMemoryRefs
          && Object.prototype.hasOwnProperty.call(s, 'subjectivePredictionConfidence');
      })(),
      'the P3 comparison needs the full structured prediction frozen here');
  }

  /* ══════════════════════════════════════════════════════════════════
     F · Holder bounds
     ══════════════════════════════════════════════════════════════════ */
  section('F · holder bounds (session-only)');
  {
    const r = registry({ maxEntries: 4 });
    for (let i = 0; i < 10; i += 1) {
      r.projectFromValidatedExpectation(expectation({ prediction: 'p' + i }), ctx({ expectationIndex: i }));
    }
    check('F1.capacityIsBounded', r.heldCount() <= 4, 'held=' + r.heldCount());
    check('F2.evictionIsFifoNotSilentGrowth',
      r.describe().counters.evicted >= 6,
      'evicted=' + r.describe().counters.evicted);

    const ttlReg = registry({ ttlMs: 1000 });
    ttlReg.projectFromValidatedExpectation(expectation(), ctx({ now: T0 }));
    const expired = ttlReg.projectFromValidatedExpectation(expectation({ prediction: 'later' }),
      ctx({ now: T0 + 2000, expectationIndex: 1 }));
    check('F3.ttlExpiresOldRecords',
      expired.ok === true && ttlReg.describe().counters.expired >= 1 && ttlReg.heldCount() === 1,
      'expired=' + ttlReg.describe().counters.expired + ' held=' + ttlReg.heldCount());

    const iso = registry();
    iso.projectFromValidatedExpectation(expectation(), ctx());
    iso.projectFromValidatedExpectation(expectation(), ctx({ characterId: 'char_B', turnId: 'turn_9' }));
    check('F4.perCharacterIsolation',
      iso.listOpenPredictions({ characterId: 'char_A' }).length === 1
      && iso.listOpenPredictions({ characterId: 'char_B' }).length === 1
      && iso.listOpenPredictions().length === 2,
      'records are scoped per character/conversation');
    check('F5.listOpenExcludesSuperseded', (function () {
      const id = iso.listOpenPredictions({ characterId: 'char_A' })[0].predictionId;
      iso.markSuperseded(id, 'test');
      return iso.listOpenPredictions({ characterId: 'char_A' }).length === 0;
    })(), 'superseded records leave the open set');

    check('F6.holderIsProcessMemoryOnly',
      r.describe().durable === false && r.describe().durableWrites === 0
      && r.describe().lifetime === 'SESSION_ONLY'
      && r.describe().crossRestartExactlyOnce === 'NO'
      && r.describe().restartRecovery === 'NONE',
      'no durable store, no cross-restart guarantee');
    check('F7.registryRefusesWithoutInjectedTime',
      (function () {
        const x = registry();
        const res = x.projectFromValidatedExpectation(expectation(), { characterId: 'a', conversationId: 'b', turnId: 'c' });
        return res.ok === false && res.reasonCode === 'injected-time-missing';
      })(),
      'the registry must not read a clock of its own');
  }

  /* ══════════════════════════════════════════════════════════════════
     G · Supersession
     ══════════════════════════════════════════════════════════════════ */
  section('G · supersession');
  {
    const r = registry();
    const first = r.projectFromValidatedExpectation(expectation(), ctx()).record;
    const snapshotBefore = CORE.canonicalize(first.predictionSnapshotAtCreation);
    const sup = r.markSuperseded(first.predictionId, 'revised-by-newer-expectation');
    check('G1.supersessionIsALifecycleMarkOnly',
      sup.ok === true && sup.record.lifecycleState === 'superseded'
      && sup.record.settlementState === 'pending',
      'supersession must not settle anything');
    check('G2.oldSnapshotSurvivesSupersession',
      CORE.canonicalize(sup.record.predictionSnapshotAtCreation) === snapshotBefore,
      'the first historical truth must be preserved');
    check('G3.supersededRecordStaysAuditable',
      r.inspectRegistry(first.predictionId).ok === true
      && r.inspectRegistry(first.predictionId).view.lifecycleState === 'superseded',
      'the old record remains inspectable');
    check('G4.revisedPredictionIsASeparateRecord',
      (function () {
        const second = r.projectFromValidatedExpectation(
          expectation({ prediction: '用户明天会点 Confirm' }), ctx({ expectationIndex: 0 }));
        return second.ok === true && second.record.predictionId !== first.predictionId
          && r.heldCount() === 2;
      })(),
      'a revised prediction is a new record, never an in-place mutation');
    check('G5.doubleSupersessionIsRefused',
      r.markSuperseded(first.predictionId, 'again').ok === false,
      'a terminal record cannot be superseded twice');
    check('G6.p2LifecycleVocabularyIsClosed',
      JSON.stringify(CORE.LIFECYCLE_STATES) === JSON.stringify(['open', 'superseded', 'withdrawn'])
      && CORE.validatePredictionRecord(first).errors.indexOf('settlement-state-must-stay-pending-in-p2') < 0,
      'P2 may only open/supersede/withdraw');
  }

  /* ══════════════════════════════════════════════════════════════════
     H · D.2 self-validation closure
     ══════════════════════════════════════════════════════════════════ */
  section('H · D.2 validated-judgement capability transfer');
  {
    const PO = require(path.join(ROOT, 'assets/js/memory-recall/prediction-observation-core.js'));
    check('H1.callerSuppliedValidatedIsInvalid',
      PO.STATE_SUPPORT.callerSuppliedValidated === 'INVALID'
      && PO.VALIDATED_JUDGEMENT_AUTHORITY === 'MODULE_PRIVATE_CAPABILITY'
      && PO.normalizeJudgement({ result: 'confirmed', judgementValidated: true }).ok === false
      && PO.normalizeJudgement({ result: 'confirmed' }).ok === false
      && PO.normalizeJudgement({ judgement: { result: 'confirmed', validated: true } }).ok === false,
      'the legacy boolean forms must all be rejected');
    const cap = PO.mintValidatedJudgementCapability({ result: 'confirmed', source: 'p2-test' }).value;
    check('H2.onlyTheCapabilityIsAccepted',
      PO.normalizeJudgement({ judgement: cap }).ok === true,
      'the minted capability is the only accepted validation form');
    const saved = require.cache[require.resolve(path.join(ROOT, 'assets/js/memory-recall/prediction-observation-core.js'))];
    const poPath = require.resolve(path.join(ROOT, 'assets/js/memory-recall/prediction-observation-core.js'));
    delete require.cache[poPath];
    const PO2 = require(poPath);
    const cross = PO2.isValidatedJudgementCapability(cap);
    if (saved) require.cache[poPath] = saved;
    check('H3.forgeMatrixAllRejected',
      PO.isValidatedJudgementCapability(cap) === true
      && PO.isValidatedJudgementCapability(JSON.parse(JSON.stringify(cap))) === false
      && PO.isValidatedJudgementCapability(Object.assign({}, cap)) === false
      && PO.isValidatedJudgementCapability({ brand: 'ib.validated-judgement.v1', result: 'confirmed', authority: 'MODULE_PRIVATE_CAPABILITY', validated: true }) === false
      && cross === false,
      'plain / cloned / brand-copied / cross-instance must all fail');
    check('H4.legacyVocabularyAndFieldsPreserved',
      PO.RESULTS.join(',') === 'confirmed,contradicted,partial,unknown,unsettled'
      && PO.OUTCOME_JUDGEMENT_RUNTIME === 'CALLER_VALIDATED_PROTOCOL_ONLY'
      && PO.OUTCOME_JUDGEMENT_MATRIX['caller-supplied-validated'] === 'CALLER_SUPPLIED_VALIDATED'
      && PO.STATE_SUPPORT.judgementIsProtocolPrimitiveOnly === 'YES',
      'the legacy protocol vocabulary is kept; only the authority moved');
    check('H5.noLegacyAdapterWasCreated',
      PO.normalizeJudgement({ judgement: cap }).value.result === 'confirmed'
      && typeof PO.confirmedFromMatched === 'undefined',
      'there must be no matched→confirmed adapter');
  }

  /* ══════════════════════════════════════════════════════════════════
     I · Forbidden APIs
     ══════════════════════════════════════════════════════════════════ */
  section('I · forbidden API surface');
  {
    const reg = registry();
    const api = Object.keys(reg);
    const forbidden = ['settle', 'confirm', 'contradict', 'applyCalibration', 'writeMemory',
      'writeRelationship', 'matched', 'missed', 'computePredictionError'];
    const leaked = forbidden.filter(f => api.some(k => k.toLowerCase().indexOf(f.toLowerCase()) >= 0));
    check('I1.registryExposesNoSettlementOrCalibrationApi', leaked.length === 0,
      'leaked: ' + JSON.stringify(leaked));
    check('I2.registryApiIsMinimal',
      JSON.stringify(api.sort()) === JSON.stringify([
        'ENTRY', 'awaitIdle', 'describe', 'getPrediction', 'heldCount', 'inspectRegistry',
        'listOpenPredictions', 'markSuperseded', 'markWithdrawn',
        'projectFromValidatedExpectation', 'sessionRef'
      ].sort()),
      'api=' + JSON.stringify(api.sort()));
    check('I3.describeDeclaresSingleAuthorityAndNoSettlement',
      reg.describe().predictionIdAuthority === 'PREDICTION_REGISTRY'
      && reg.describe().predictionRecordMintAuthority === 'PREDICTION_REGISTRY'
      && reg.describe().settlementAuthority === 'NONE'
      && reg.describe().observationAuthority === 'NONE'
      && reg.describe().memoryAuthority === 'NONE'
      && reg.describe().relationshipAuthority === 'NONE'
      && reg.describe().settlementEngine === 'NONE'
      && reg.describe().matchedMissedCalculation === 'NONE'
      && reg.describe().predictionErrorCalculation === 'NONE'
      && reg.describe().calibration === 'NONE',
      'the registry must declare exactly what it does and does not own');
    check('I4.inspectViewCarriesNoPredictionText',
      (function () {
        const r = registry();
        const rec = r.projectFromValidatedExpectation(expectation(), ctx()).record;
        const s = JSON.stringify(r.inspectRegistry(rec.predictionId).view);
        return s.indexOf('用户明天') < 0 && s.indexOf('action.cancelled') < 0 && s.indexOf('m1') < 0;
      })(),
      'the audit view must be structural only');
    check('I5.registryContentIsNotExposed',
      reg.describe().contentExposed === 'NO' && reg.describe().browserVisible === 'NO'
      && reg.describe().routes === 'NONE',
      'no route, no browser surface');
  }

  /* ══════════════════════════════════════════════════════════════════
     J · No durable write / no clock / no model
     ══════════════════════════════════════════════════════════════════ */
  section('J · static boundaries');
  {
    const files = [CORE_REL, REG_REL];
    const PATTERNS = [
      ['fetch', /\bfetch\s*\(/], ['XMLHttpRequest', /XMLHttpRequest/], ['WebSocket', /WebSocket/],
      ['indexedDB', /indexedDB/], ['localStorage', /localStorage/], ['sessionStorage', /sessionStorage/],
      ['dbPut', /\bdbPut\b/], ['dbGet', /\bdbGet\b/], ['dbDelete', /\bdbDelete\b/],
      ['writeFile', /\bwriteFile\b/], ['sqlite', /sqlite|SQL\./], ['Date.now', /Date\.now/],
      ['Math.random', /Math\.random/], ['process.env', /process\.env/],
      ['fs require', /require\(\s*['"](?:fs|net|http|https|node:)/],
      /* 精确到**写路径 / require**，不是"出现 memoryAuthority 这个词" */
      ['memory-store require', /require\([^)]*memory-store/],
      ['memory write api', /\bputRecord\b|\bputRecords\b|\bdeleteRecord\b|\bwriteMemory\b/],
      ['memory-authority use', /memoryAuthority\s*\.|require\([^)]*memory-authority/],
      ['relationship write', /relationDelta|relationshipStore|writeRelationship/]
    ];
    const hits = [];
    for (const rel of files) {
      const code = WIRING.stripJsComments(read(rel));
      for (const [name, re] of PATTERNS) if (re.test(code)) hits.push(rel + ':' + name);
    }
    check('J1.zeroDurableWriteAndZeroIO', hits.length === 0, JSON.stringify(hits));
    check('J2.noModelCallPath',
      !/require\([^)]*(?:model-port|provider)|modelPort\s*\.|invokeOnce\s*\(|credentialAccess\s*\./i
        .test(WIRING.stripJsComments(read(REG_REL))),
      'the registry must have no model/credential call path');
    check('J3.coreDeclaresItsBoundaries',
      CORE.STATE_SUPPORT.modelCalls === 0 && CORE.STATE_SUPPORT.durableWrites === 0
      && CORE.STATE_SUPPORT.clockReads === 0
      && CORE.STATE_SUPPORT.settlementEngine === 'NONE'
      && CORE.STATE_SUPPORT.predictionErrorCalculation === 'NONE'
      && CORE.STATE_SUPPORT.calibration === 'NONE'
      && CORE.STATE_SUPPORT.registryLifetime === 'SESSION_ONLY',
      'the core must declare zero calls/writes/clock reads');
  }

  /* ══════════════════════════════════════════════════════════════════
     K · Wiring & scope proof
     ══════════════════════════════════════════════════════════════════ */
  section('K · wiring & scope proof');
  {
    const expSeam = G.auditExpectationSeam(read('services/home-node/runtime-expectation.js'));
    check('K1.approvedRegistrySeamIsPositionPinned',
      expSeam.ok === true
      && expSeam.facts.approvedSeam.depCount === 1
      && expSeam.facts.approvedSeam.callCount === 1
      && expSeam.facts.approvedSeam.callLine > expSeam.facts.approvedSeam.anchorLine,
      JSON.stringify(expSeam.facts.approvedSeam));

    const svc = read('services/home-node-service.js');
    check('K2.assemblyWiresTheRegistry',
      svc.indexOf('createRuntimePredictionRegistry(') >= 0
      && svc.indexOf('runtime-prediction-registry.js') >= 0
      && svc.indexOf('runtimePredictionRegistry: runtimePredictionRegistry') >= 0
      && svc.indexOf('runtimePredictionRegistry: instanceRuntimePredictionRegistry') >= 0,
      'the registry must be constructed and exported by the assembly');

    const recall = read('services/home-node/runtime-recall.js');
    const interp = read('services/home-node/runtime-interpretation.js');
    const html = read('InternalBeyond.html');
    check('K3.noRegistryOrPeCapabilityInRecallInterpretationBrowser',
      G.containsSemantic(WIRING.stripJsComments(recall), 'predictionRegistry') === false
      && G.containsSemantic(WIRING.stripJsComments(interp), 'predictionRegistry') === false
      && G.auditBrowserCognitionBoundary(read('assets/js/communication.js'), { surface: 'assets/js/communication.js' }).ok === true
      && html.indexOf('prediction-record-core') < 0
      && html.indexOf('runtime-prediction-registry') < 0,
      'the registry must not reach recall / interpretation / browser / HTML');

    check('K4.noHttpRouteForTheRegistry',
      read('services/home-node/http.js').indexOf('predictionRegistry') < 0
      && read('services/home-node/http.js').indexOf('prediction-registry') < 0
      && read('services/home-node/mobile-gateway.js').indexOf('predictionRegistry') < 0,
      'the registry must not gain an HTTP or device route');

    const be = G.auditBehaviorEffectSeam(read('services/home-node/runtime-behavior-effect.js'));
    check('K5.behaviorEffectGainedNoRegistrySeam',
      be.ok === true
      && G.containsSemantic(WIRING.stripJsComments(read('services/home-node/runtime-behavior-effect.js')), 'predictionRegistry') === false,
      'behavior-effect must remain free of any registry seam');

    P('P2_STATUS', 'COMPLETE');
    P('PREDICTION_REGISTRY_LIVE', 'YES');
    P('REGISTRY_LIFETIME', 'SESSION_ONLY');
    P('SETTLEMENT_ENGINE', 'NONE');
    P('LIVE_SETTLEMENT', 'NO');
    P('MATCHED_MISSED_CALCULATION', 'NONE');
    P('PREDICTION_ERROR_CALCULATION', 'NONE');
    P('CALIBRATION_APPLIED_TO_LIVE', 'NO');
    P('MODEL_CALLS_ADDED', 0);
    P('DURABLE_WRITES_ADDED', 0);
    P('RECALL_ENVELOPE_CHANGED', 'NO');
    P('UI_DISCLOSURE_CHANGED', 'NO');
    P('NEXT_ALLOWED_PHASE', 'P3');
  }

  console.log('\n' + '='.repeat(64));
  if (failures) {
    console.error('PREDICTION REGISTRY FAILED · ' + failures + ' assertion(s), ' + passed + ' passed');
    process.exit(1);
  }
  console.log('PREDICTION REGISTRY PASSED · ' + passed + ' assertions green');
})();
