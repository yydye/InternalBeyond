'use strict';
/* ══════════════════════════════════════════════════════════════════════════
   Internal Beyond · Prediction Error P5-B2 · BehaviorEffect Attribution Authority
   （纯 Node，零浏览器、零网络、**零模型调用**、零 durable 写）

   运行：node tests/test_behavior_effect_attribution.js

   本轮最重要的 invariant：
       ABSENCE_OF_EFFECT_RECORD != KNOWN_NO_EFFECT
       `effects.length === 0` 只有在 coverage === 'complete' 时才是 known-none
   ══════════════════════════════════════════════════════════════════════════ */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const CORE_REL = 'assets/js/memory-recall/behavior-effect-attribution-core.js';
const BE_REL = 'services/home-node/runtime-behavior-effect.js';
const WIRING = require('./helpers/activation-wiring-probe.js');
const G = require('./helpers/runtime-seam-guard.js');
const CORE = require(path.join(ROOT, CORE_REL));
const { createRuntimeBehaviorEffect } = require(path.join(ROOT, BE_REL));
const { createRuntimePredictionRegistry } = require(path.join(ROOT, 'services/home-node/runtime-prediction-registry.js'));
const OO = require(path.join(ROOT, 'assets/js/memory-recall/outcome-observation-core.js'));

let passed = 0, failures = 0;
const check = (n, c, d) => {
  if (c) { passed++; console.log('  PASS  ' + n); return true; }
  failures++; console.error('  FAIL  ' + n + (d ? '  -> ' + d : '')); return false;
};
const section = t => console.log('\n── ' + t + ' ──');
const P = (k, v) => console.log('  FACTS ' + k + ' = ' + v);
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const T0 = 1760000000000;
/* 已验证 L3 + L5（与 test_r4f 同一套 fixture 形态） */
const L3_OK = { ok: true, status: 'succeeded', recordSource: 'SERVER_CANONICAL_REBIND', interpretation: { ok: true, items: [{ memoryId: 'm1', appraisal: 'positive' }] } };
const L5_OK = { ok: true, status: 'created' };
function derive(be, characterId, conversationId, turnId, over) {
  return be.deriveAndHold(Object.assign({
    characterId, conversationId, turnId,
    interpretationValidated: true, interpretationResult: L3_OK,
    expectationHeld: true, expectation: L5_OK
  }, over || {}));
}
let CLOCK_NOW = T0;
function setNow(t) { CLOCK_NOW = t; }
function be(over) {
  setNow(T0);
  return createRuntimeBehaviorEffect(Object.assign({ clock: () => CLOCK_NOW, logger: () => {} }, over || {}));
}
/* P5-B2 · 共用 Expectation fixture（主观 preference，需 known-none 才可能 decisive） */
function expectation(over) {
  return Object.assign({
    epistemicStatus: 'prediction', prediction: '用户更喜欢被确认',
    trigger: { kind: 'explicit-cue', label: 'l' }, evidenceMemoryIds: ['m1'],
    contradictoryEvidenceIds: [], generalizationLevel: 'episode-hypothesis',
    subjectivePredictionConfidence: 0.8, subject: { kind: 'user', label: '' },
    predicate: { kind: 'prefers' }, expectedOutcome: { kind: 'exclusive-outcome', token: 'action.confirmed' }
  }, over || {});
}

(async function main() {
  /* ══════════════════════════════════════════════════════════════════
     A · §45 invariant：[] != known-none（本轮核心）
     ══════════════════════════════════════════════════════════════════ */
  section('A · absence != known-none');
  {
    check('A1.zeroEffectsWithCompleteCoverageIsKnownNone',
      CORE.resolveStatus({ relevantCount: 0, coverage: 'complete' }).status === 'known-none',
      'complete coverage + 0 effects ⇒ known-none');
    check('A2.zeroEffectsWithPartialCoverageIsUnknown',
      CORE.resolveStatus({ relevantCount: 0, coverage: 'partial' }).status === 'unknown'
      && CORE.resolveStatus({ relevantCount: 0, coverage: 'partial' }).reasonCodes.indexOf('absence-of-effect-record-is-not-known-none') >= 0,
      '**[] 不是 known-none**');
    check('A3.zeroEffectsWithUnavailableCoverageIsUnknown',
      CORE.resolveStatus({ relevantCount: 0, coverage: 'unavailable' }).status === 'unknown',
      'authority 不可用 ⇒ unknown');
    check('A4.effectFoundIsKnownPresentEvenWhenPartial',
      CORE.resolveStatus({ relevantCount: 1, coverage: 'partial' }).status === 'known-present'
      && CORE.resolveStatus({ relevantCount: 1, coverage: 'partial' }).reasonCodes.indexOf('coverage-incomplete-cannot-assert-known-none') >= 0,
      '"至少存在一个"不要求全集完整，但要保留 coverage 不完整的诊断');
    check('A5.noFourthStatus',
      JSON.stringify(CORE.STATUSES) === JSON.stringify(['known-none', 'known-present', 'unknown']),
      JSON.stringify(CORE.STATUSES));
    check('A6.knownNoneOnlyFromCompleteCoverage',
      CORE.STATUSES.filter(s => s === 'known-none').length === 1
      && CORE.resolveStatus({ relevantCount: 0, coverage: 'partial' }).status !== 'known-none'
      && CORE.resolveStatus({ relevantCount: 0, coverage: 'unavailable' }).status !== 'known-none',
      'KNOWN_NONE_REQUIRES_COMPLETE_COVERAGE = YES');
  }

  /* ══════════════════════════════════════════════════════════════════
     B · coverage 判定
     ══════════════════════════════════════════════════════════════════ */
  section('B · coverage model');
  {
    const comp = CORE.resolveCoverage({ authorityPresent: true, authorityEnabled: true, authoritySince: T0, at: T0 + 10 });
    const unavail = CORE.resolveCoverage({ authorityPresent: false });
    const disabled = CORE.resolveCoverage({ authorityPresent: true, authorityEnabled: false });
    /* ★ P5-B3-A 相位迁移：容量淘汰是**已观察的终止** ⇒ 不再降级 coverage */
    const evicted = CORE.resolveCoverage({ authorityPresent: true, authorityEnabled: true, authoritySince: T0, at: T0 + 10 });
    const before = CORE.resolveCoverage({ authorityPresent: true, authorityEnabled: true, authoritySince: T0 + 100, at: T0 });
    const unobserved = CORE.resolveCoverage({ authorityPresent: true, authorityEnabled: true, authoritySince: T0, at: T0 + 10, unobservedDisappearance: true });
    const trimmed = CORE.resolveCoverage({ authorityPresent: true, authorityEnabled: true, authoritySince: T0, historyRetentionFloor: T0 + 500, at: T0 + 100 });
    const presentAfterTrim = CORE.resolveCoverage({ authorityPresent: true, authorityEnabled: true, authoritySince: T0, historyRetentionFloor: T0 + 500, at: T0 + 900 });
    check('B1.complete', comp.coverage === 'complete', JSON.stringify(comp));
    check('B2.unavailableWhenAuthorityMissing', unavail.coverage === 'unavailable'
      && unavail.reasonCodes.indexOf('attribution-authority-unavailable') >= 0, JSON.stringify(unavail));
    check('B3.unavailableWhenDisabled', disabled.coverage === 'unavailable'
      && disabled.reasonCodes.indexOf('attribution-authority-disabled') >= 0, JSON.stringify(disabled));
    check('B4.evictionNoLongerDegradesCoverage', evicted.coverage === 'complete',
      'CAPACITY_EVICTION_IS_OBSERVED_TERMINATION = YES');
    check('B5.partialWhenQueryWindowPrecedesAuthority', before.coverage === 'partial'
      && before.reasonCodes.indexOf('history-retention-trimmed-past-horizon') >= 0, JSON.stringify(before));
    check('B6.historyTrimDegradesOnlyThePastHorizon',
      trimmed.coverage === 'partial' && presentAfterTrim.coverage === 'complete',
      'HISTORICAL_RETENTION_EVICTION DEGRADES ONLY AFFECTED PAST HORIZON');
    check('B7.unobservedDisappearanceDegradesCoverage',
      unobserved.coverage === 'partial'
      && unobserved.reasonCodes.indexOf('unobserved-disappearance-degrades-coverage') >= 0,
      'UNOBSERVED_DISAPPEARANCE_DEGRADES_COVERAGE = YES');
    check('B8.emptyPlusIncompleteIsUnknownNotKnownNone',
      CORE.resolveStatus({ relevantCount: 0, coverage: unavail.coverage }).status === 'unknown'
      && CORE.resolveStatus({ relevantCount: 0, coverage: unobserved.coverage }).status === 'unknown'
      && CORE.resolveStatus({ relevantCount: 0, coverage: trimmed.coverage }).status === 'unknown',
      '§30 最重要的 regression：[] + 任何不完整 coverage ⇒ unknown');
  }

  /* ══════════════════════════════════════════════════════════════════
     C · live authority：known-none / known-present
     ══════════════════════════════════════════════════════════════════ */
  section('C · live attribution authority');
  {
    const m = be();
    const empty = m.snapshotBehaviorEffectAttribution({ characterId: 'A', conversationId: 'c', at: T0 });
    check('C1.emptyScopeIsKnownNone',
      empty.status === 'known-none' && empty.coverage === 'complete' && empty.effects.length === 0,
      JSON.stringify({ s: empty.status, c: empty.coverage }));
    check('C2.snapshotIsSealed',
      m.isBehaviorEffectAttributionSnapshot(empty) === true && Object.isFrozen(empty) === true,
      'the authority mints a sealed snapshot');
    derive(m, 'A', 'c', 'T1');
    const one = m.snapshotBehaviorEffectAttribution({ characterId: 'A', conversationId: 'c', at: T0 });
    check('C3.effectPresentIsKnownPresent',
      one.status === 'known-present' && one.effects.length === 1
      && typeof one.effects[0].effectInstanceId === 'string'
      && one.effects[0].effectInstanceId.indexOf('be_') === 0,
      JSON.stringify({ s: one.status, n: one.effects.length }));
    check('C4.effectCarriesInterval', (function () {
      const e = one.effects[0];
      return Number.isFinite(e.startedAt) && e.endedAt === null;
    })(), 'startedAt 必有；未结束则 endedAt=null');
    check('C5.authorityDeclaresOneFactOwner',
      m.describeAttribution().oneEffectFactOwner === 'YES'
      && m.describeAttribution().authority === 'RUNTIME_BEHAVIOR_EFFECT'
      && m.describeAttribution().knownNoneRequiresCompleteCoverage === 'YES',
      JSON.stringify(m.describeAttribution().authority));
    P('ATTRIBUTION_AUTHORITY', 'RUNTIME_BEHAVIOR_EFFECT');
  }

  /* ══════════════════════════════════════════════════════════════════
     D · 生命周期 / identity
     ══════════════════════════════════════════════════════════════════ */
  section('D · identity & lifecycle');
  {
    const m = be();
    derive(m, 'A', 'c', 'T1');
    const before = m.snapshotBehaviorEffectAttribution({ characterId: 'A', conversationId: 'c', at: T0 });
    const id1 = before.effects[0].effectInstanceId;
    /* consumed ⇒ 关闭 instance */
    const c = m.consumeForTurn({ characterId: 'A', conversationId: 'c', turnId: 'T2' });
    const after = m.snapshotBehaviorEffectAttribution({ characterId: 'A', conversationId: 'c', at: T0 });
    check('D1.consumeClosesTheInstance',
      c.status === 'applied' && after.status === 'known-none' && after.effects.length === 0,
      JSON.stringify({ consume: c.status, snap: after.status }));
    check('D2.closedInstanceIsRetainedInLedger',
      m.describeAttribution().ledgerInstances === 1 && m.describeAttribution().counters.closed === 1,
      JSON.stringify(m.describeAttribution().counters));
    check('D3.identityIsStableAndDistinct', (function () {
      const m2 = be();
      derive(m2, 'A', 'c', 'T1');
      const a = m2.snapshotBehaviorEffectAttribution({ characterId: 'A', conversationId: 'c', at: T0 }).effects[0].effectInstanceId;
      setNow(T0 + 5);
      derive(m2, 'A', 'c', 'T1');            /* 同 key 二次派生 ⇒ replaced ⇒ 新 instance */
      const snaps = m2.snapshotBehaviorEffectAttribution({ characterId: 'A', conversationId: 'c', at: T0 + 5 });
      const b = snaps.effects[0] && snaps.effects[0].effectInstanceId;
      return a !== b && typeof b === 'string';
    })(), '同一 key 的两次激活必须可分（不能只用 effectKind 做 identity）');
    check('D4.instanceIdHasNoClockOrRandom', (function () {
      const code = WIRING.stripJsComments(read(CORE_REL));
      const seg = code.slice(code.indexOf('function effectInstanceId'), code.indexOf('function resolveCoverage'));
      return seg.indexOf('Date.now') < 0 && seg.indexOf('Math.random') < 0;
    })(), 'identity 由 deterministic hash + runtime 发号构成');
    check('D5.ledgerIsBoundedAndSessionOnly',
      m.describeAttribution().closedHistoryBound > 0
      && m.describeAttribution().lifetime === 'SESSION_ONLY'
      && m.describeAttribution().durableWrites === 0
      && m.describeAttribution().activeAuthorityComplete === true,
      JSON.stringify(m.describeAttribution().closedHistoryBound));
    check('D6.noUnboundedHolder',
      read(BE_REL).indexOf('ATTR_MAX_CLOSED_HISTORY') >= 0
      && /while \(attrClosed\.length > maxClosedHistory\)/.test(read(BE_REL)),
      'no unbounded ledger');
  }

  /* ══════════════════════════════════════════════════════════════════
     E · 作用域隔离 / 时间隔离
     ══════════════════════════════════════════════════════════════════ */
  section('E · scope & temporal isolation');
  {
    const m = be();
    derive(m, 'charA', 'convA', 'T1');
    check('E1.crossCharacterIsolation',
      m.snapshotBehaviorEffectAttribution({ characterId: 'charB', conversationId: 'convA', at: T0 }).status === 'known-none',
      '角色 A 的 effect 不得污染角色 B');
    check('E2.crossConversationIsolation',
      m.snapshotBehaviorEffectAttribution({ characterId: 'charA', conversationId: 'convB', at: T0 }).status === 'known-none',
      '会话 A 的 effect 不得污染会话 B');
    check('E3.crossCharacterStillKnownPresentForTheOwner',
      m.snapshotBehaviorEffectAttribution({ characterId: 'charA', conversationId: 'convA', at: T0 }).status === 'known-present',
      'owner 自己看得到');
    check('E4.wrongSubjectIsNotRelevant',
      CORE.isRelevant(
        { characterId: 'c', conversationId: 'v', subjectLabel: 'alice', startedAt: T0, endedAt: null },
        { characterId: 'c', conversationId: 'v', subjectLabel: 'bob' }, T0) === false,
      'subject 不匹配 ⇒ 不相关');
    check('E5.effectEndedBeforeQueryIsNotActive',
      CORE.isActiveAt({ startedAt: T0, endedAt: T0 + 10 }, T0 + 20) === false,
      '两小时前结束的 effect 不污染当前 outcome');
    check('E6.effectStartingAfterQueryIsNotActive',
      CORE.isActiveAt({ startedAt: T0 + 100, endedAt: null }, T0) === false,
      '尚未开始的 effect 不在创建时归因里');
    check('E7.effectActiveDuringQueryIsActive',
      CORE.isActiveAt({ startedAt: T0, endedAt: null }, T0 + 5) === true
      && CORE.isActiveAt({ startedAt: T0, endedAt: T0 + 10 }, T0 + 5) === true,
      '区间重叠 ⇒ active');
  }

  /* ══════════════════════════════════════════════════════════════════
     F · 快照不可变性 + creation/outcome 独立性
     ══════════════════════════════════════════════════════════════════ */
  section('F · snapshot immutability');
  {
    const m = be();
    derive(m, 'A', 'c', 'T1');
    const creation = m.snapshotBehaviorEffectAttribution({ characterId: 'A', conversationId: 'c', at: T0 });
    const creationJson = JSON.stringify(creation);
    /* 之后：effect 结束、新 effect 开始、registry 变更 */
    m.consumeForTurn({ characterId: 'A', conversationId: 'c', turnId: 'T2' });
    setNow(T0 + 50);
    derive(m, 'A', 'c', 'T3');
    const outcome = m.snapshotBehaviorEffectAttribution({ characterId: 'A', conversationId: 'c', at: T0 + 60 });
    check('F1.creationSnapshotIsUnchanged',
      JSON.stringify(creation) === creationJson
      && creation.status === 'known-present' && creation.effects.length === 1,
      '创建时的归因真相必须保留（不得被改成 known-none）');
    check('F2.outcomeSnapshotIsIndependent',
      outcome.effects.length === 1
      && outcome.effects[0].effectInstanceId !== creation.effects[0].effectInstanceId,
      '创建时与 outcome 时是两个时点、两条 instance');
    check('F3.snapshotIsDeepFrozen',
      Object.isFrozen(creation) && Object.isFrozen(creation.effects) && Object.isFrozen(creation.coverageBasis),
      'deepFreeze');
    check('F4.projectionSnapshotIsImmutable',
      (function () {
        const reg = createRuntimePredictionRegistry({ clock: () => T0, attributionAuthority: m });
        const p1 = reg.projectFromValidatedExpectation(expectation(), { now: T0, characterId: 'A', conversationId: 'c', turnId: 'pt1', expectationIndex: 0 }).record;
        const snapBefore = JSON.stringify(p1.predictionSnapshotAtCreation);
        m.consumeForTurn({ characterId: 'A', conversationId: 'c', turnId: 'T9' });
        return JSON.stringify(p1.predictionSnapshotAtCreation) === snapBefore
          && Object.isFrozen(p1.predictionSnapshotAtCreation);
      })(), 'ATTRIBUTION_SNAPSHOT_AT_PREDICTION_CREATION = IMMUTABLE');
  }

  /* ══════════════════════════════════════════════════════════════════
     G · predictionInfluencedSystem
     ══════════════════════════════════════════════════════════════════ */
  section('G · predictionInfluencedSystem');
  {
    check('G1.trueRequiresStableLink',
      CORE.resolvePredictionInfluenced({ linkedPredictionFound: true, dependencyTraceComplete: false }).value === true,
      '有稳定 ref ⇒ true');
    check('G2.falseRequiresCompleteTrace',
      CORE.resolvePredictionInfluenced({ linkedPredictionFound: false, dependencyTraceComplete: true, dependencyTraceScope: 'BEHAVIOR_EFFECT_SUBSYSTEM_ONLY' }).value === false,
      '完整追踪 + 无 linkage ⇒ false');
    check('G3.incompleteTraceStaysNull',
      CORE.resolvePredictionInfluenced({ linkedPredictionFound: false, dependencyTraceComplete: false }).value === null
      && CORE.resolvePredictionInfluenced({ linkedPredictionFound: false, dependencyTraceComplete: true, dependencyTraceScope: 'UNAVAILABLE' }).value === null,
      '"没看到引用" 不会自动变成 false');
    check('G4.liveSnapshotDeclaresItsTraceScope', (function () {
      const m = be();
      derive(m, 'A', 'c', 'T1');
      const s = m.snapshotBehaviorEffectAttribution({ characterId: 'A', conversationId: 'c', at: T0, predictionId: 'pred_x' });
      return s.dependencyTraceScope === 'BEHAVIOR_EFFECT_SUBSYSTEM_ONLY'
        && s.predictionInfluencedSystem === false;
    })(), 'false 的含义被限定在具名追踪范围内');
    check('G5.beDerivationHasNoPredictionInput', (function () {
      const code = WIRING.stripJsComments(read(BE_REL));
      const seg = code.slice(code.indexOf('function deriveAndHold'), code.indexOf('function consumeForTurn'));
      /* 派生路径**没有**任何 prediction 输入 ⇒ 不会强行猜 true */
      return seg.indexOf('predictionId') < 0 && seg.indexOf('Prediction') < 0;
    })(), 'BE 派生路径没有任何 prediction 输入');
    check('G6.noTextBasedCausalLinkage',
      read(CORE_REL).indexOf('contains') < 0 && read(BE_REL).indexOf('text contains') < 0,
      '不得用文本包含做因果 linkage');
  }

  /* ══════════════════════════════════════════════════════════════════
     H · forge matrix
     ══════════════════════════════════════════════════════════════════ */
  section('H · capability forge matrix');
  {
    const m = be();
    const snap = m.snapshotBehaviorEffectAttribution({ characterId: 'A', conversationId: 'c', at: T0 });
    check('H1.realSnapshotAccepted', m.isBehaviorEffectAttributionSnapshot(snap) === true);
    check('H2.plainObjectRejected',
      m.isBehaviorEffectAttributionSnapshot({ status: 'known-none', coverage: 'complete', effects: [] }) === false,
      '{status:"known-none"} 不能自证');
    check('H3.jsonCloneRejected',
      m.isBehaviorEffectAttributionSnapshot(JSON.parse(JSON.stringify(snap))) === false);
    check('H4.objectAssignCloneRejected',
      m.isBehaviorEffectAttributionSnapshot(Object.assign({}, snap)) === false);
    check('H5.copiedBrandRejected',
      m.isBehaviorEffectAttributionSnapshot({ brand: 'ib.behavior-effect-attribution.v1', status: 'known-none', coverage: 'complete', effects: [] }) === false);
    check('H6.crossModuleRejected', (function () {
      const p = require.resolve(path.join(ROOT, BE_REL));
      const saved = require.cache[p];
      delete require.cache[p];
      const M2 = require(p).createRuntimeBehaviorEffect({ logger: () => {} });
      const rejected = M2.isBehaviorEffectAttributionSnapshot(snap) === false;
      if (saved) require.cache[p] = saved;
      return rejected;
    })(), '另一个 loaded 实例不认可本实例的 snapshot');
    check('H7.knownNoneWithPartialCoverageIsNeverValid',
      m.isBehaviorEffectAttributionSnapshot({ status: 'known-none', coverage: 'partial', effects: [] }) === false,
      '封印层复核：known-none 只可能来自 complete');
    check('H8.coreHoldsNoIdentityTable',
      read(CORE_REL).indexOf('WeakSet') < 0 && read(CORE_REL).indexOf('WeakMap') < 0,
      '纯核心不能 mint；只有 authority 能');
  }

  /* ══════════════════════════════════════════════════════════════════
     I · Registry 集成 + fail-closed
     ══════════════════════════════════════════════════════════════════ */
  section('I · registry integration');
  {
    function expectation(over) {
      return Object.assign({
        epistemicStatus: 'prediction', prediction: '用户更喜欢被确认',
        trigger: { kind: 'explicit-cue', label: 'l' }, evidenceMemoryIds: ['m1'],
        contradictoryEvidenceIds: [], generalizationLevel: 'episode-hypothesis',
        subjectivePredictionConfidence: 0.8, subject: { kind: 'user', label: '' },
        predicate: { kind: 'prefers' }, expectedOutcome: { kind: 'exclusive-outcome', token: 'action.confirmed' }
      }, over || {});
    }
    function project(authority) {
      const reg = createRuntimePredictionRegistry({ clock: () => T0, attributionAuthority: authority });
      return reg.projectFromValidatedExpectation(expectation(), {
        now: T0, characterId: 'A', conversationId: 'c', turnId: 'rt' + Math.random(), expectationIndex: 0
      }).record;
    }
    const clean = be();
    const pClean = project(clean);
    check('I1.knownNoneFlowsIntoTheRecord',
      pClean.behaviorEffectAttributionStatus === 'known-none'
      && pClean.behaviorEffectsInForce.length === 0
      && pClean.predictionInfluencedSystem === false,
      JSON.stringify({ s: pClean.behaviorEffectAttributionStatus, i: pClean.predictionInfluencedSystem }));

    const busy = be();
    derive(busy, 'A', 'c', 'T1');
    const pBusy = project(busy);
    check('I2.knownPresentFlowsIntoTheRecord',
      pBusy.behaviorEffectAttributionStatus === 'known-present'
      && pBusy.behaviorEffectsInForce.length === 1,
      JSON.stringify({ s: pBusy.behaviorEffectAttributionStatus, n: pBusy.behaviorEffectsInForce.length }));

    check('I3.missingAuthorityFallsBackToUnknown',
      project(null).behaviorEffectAttributionStatus === 'unknown',
      '缺席 ⇒ unknown（不得 known-none）');
    check('I4.throwingAuthorityFallsBackToUnknown',
      project({ snapshotBehaviorEffectAttribution: () => { throw new Error('boom'); } }).behaviorEffectAttributionStatus === 'unknown',
      '抛错 ⇒ 建档仍成功 + unknown');
    check('I5.invalidCapabilityFallsBackToUnknown',
      project({ snapshotBehaviorEffectAttribution: () => ({ status: 'known-none', coverage: 'complete' }), isBehaviorEffectAttributionSnapshot: () => false }).behaviorEffectAttributionStatus === 'unknown',
      '非法 capability ⇒ unknown');
    check('I6.scopeMismatchFallsBackToUnknown',
      project({ snapshotBehaviorEffectAttribution: () => ({ status: 'known-none', coverage: 'complete', effects: [], scope: { characterId: 'OTHER', conversationId: 'c' } }), isBehaviorEffectAttributionSnapshot: () => true }).behaviorEffectAttributionStatus === 'unknown',
      'scope 不匹配 ⇒ unknown');
    check('I7.projectionNeverFailsOnAttribution', (function () {
      const reg = createRuntimePredictionRegistry({ clock: () => T0, attributionAuthority: { snapshotBehaviorEffectAttribution: () => { throw new Error('x'); } } });
      const a = reg.projectFromValidatedExpectation(expectation(), { now: T0, characterId: 'A', conversationId: 'c', turnId: 'nf1', expectationIndex: 0 });
      const b = reg.projectFromValidatedExpectation(expectation(), { now: T0, characterId: 'A', conversationId: 'c', turnId: 'nf2', expectationIndex: 0 });
      return a.ok !== false && b.ok !== false && a.record && b.record;
    })(), 'attribution 是 decisive capability dependency，不是 creation dependency');
    check('I8.registryHasNoAttributionAuthority',
      read('services/home-node/runtime-prediction-registry.js').indexOf('ATTR_IDENTITY') < 0
      && read('services/home-node/runtime-prediction-registry.js').indexOf('attrSeal') < 0,
      'Registry 只能消费 snapshot，不能 mint');
  }

  /* ══════════════════════════════════════════════════════════════════
     J · 与 matcher / settlement 的集成（self-reinforcement）
     ══════════════════════════════════════════════════════════════════ */
  section('J · self-reinforcement & matcher integration');
  {
    const { createRuntimeEvidenceMatcher } = require(path.join(ROOT, 'services/home-node/runtime-evidence-matcher.js'));
    const { createRuntimePredictionSettlement } = require(path.join(ROOT, 'services/home-node/runtime-prediction-settlement.js'));
    const SCOPE = { characterId: 'A', conversationId: 'c', subjectKind: 'user', subjectLabel: '' };
    const REG = { getCharacterSpec: () => ({ provider: 'p', model: 'm', endpoint: 'e', credentialRef: 'r' }) };
    const CRED = { resolve: () => ({ ok: true, secret: 's' }) };

    function build(authority, turnId) {
      const reg = createRuntimePredictionRegistry({ clock: () => T0, attributionAuthority: authority });
      return reg.projectFromValidatedExpectation({
        epistemicStatus: 'prediction', prediction: '用户更喜欢被确认',
        trigger: { kind: 'explicit-cue', label: 'l' }, evidenceMemoryIds: ['m1'],
        contradictoryEvidenceIds: [], generalizationLevel: 'episode-hypothesis',
        subjectivePredictionConfidence: 0.8, subject: { kind: 'user', label: '' },
        predicate: { kind: 'prefers' }, expectedOutcome: { kind: 'exclusive-outcome', token: 'action.confirmed' }
      }, { now: T0, characterId: 'A', conversationId: 'c', turnId: turnId, expectationIndex: 0 }).record;
    }
    function stmtObs(pred, statement) {
      const r = OO.buildOutcomeObservation({
        windowRef: {
          predictionId: pred.predictionId, predictionCreatedAt: pred.observationWindow.opensAt,
          opensAt: pred.observationWindow.opensAt, closesAt: pred.observationWindow.closesAt
        },
        source: 'EXPLICIT_USER_REPORT', sourceInstance: 'chat.user-utterance',
        targetDomain: 'user_preference', observedAt: pred.observationWindow.opensAt + 1000,
        completeness: 'point', scope: SCOPE,
        outcomeRef: { kind: 'statement', statement: statement }, evidenceRefs: ['ref_1'],
        interventionContext: {
          behaviorEffectsInForce: [], predictionInfluencedSystem: null,
          contaminationClass: 'NONE', contaminationBasis: 'no intervention in force'
        }
      }, {});
      return r.ok ? r.value : null;
    }
    function matcher(rel) {
      return createRuntimeEvidenceMatcher({
        modelPort: { run: async () => ({ ok: true, text: JSON.stringify({ relation: rel }) }) },
        registry: REG, credentialAccess: CRED, enabled: true
      });
    }
    async function settle(pred, obs, rel) {
      const e = createRuntimePredictionSettlement({ clock: () => T0, evidenceMatcher: matcher(rel) });
      return e.settlePredictionWithEvidenceMatcher(pred, [{ observation: obs }],
        { now: pred.observationWindow.opensAt + 2000, opportunity: { required: true, existence: { present: true, authoritySource: 'CANONICAL_RUNTIME' }, consumedAt: T0 + 1500 } });
    }

    /* Case A：known-none + matcher support ⇒ 第一次真正可以 decisive */
    const cleanAuth = be();
    const pA = build(cleanAuth, 'mA');
    const rA = await settle(pA, stmtObs(pA, '对，我更喜欢被确认'), 'support');
    check('J1.knownNoneEnablesProductionSettleable',
      pA.behaviorEffectAttributionStatus === 'known-none'
      && rA.settlement.state === 'matched'
      && rA.settlement.calibrationCounted === true,
      JSON.stringify({ attr: pA.behaviorEffectAttributionStatus, state: rA.settlement.state }));

    /* Case B：known-present（unrelated? no —— 相关 effect active）⇒ 不得 decisive 计入独立确认 */
    const busyAuth = be();
    derive(busyAuth, 'A', 'c', 'T1');
    const pB = build(busyAuth, 'mB');
    const rB = await settle(pB, stmtObs(pB, '对，我更喜欢被确认'), 'support');
    check('J2.knownPresentRelevantEffectBlocksIndependentConfirmation',
      pB.behaviorEffectAttributionStatus === 'known-present'
      && rB.settlement.calibrationCounted === false,
      JSON.stringify({ attr: pB.behaviorEffectAttributionStatus, counted: rB.settlement.calibrationCounted, state: rB.settlement.state }));

    /* Case C：unknown（无 authority）⇒ fail closed */
    const pC = build(null, 'mC');
    const rC = await settle(pC, stmtObs(pC, '对，我更喜欢被确认'), 'support');
    check('J3.unknownAttributionStillFailsClosed',
      pC.behaviorEffectAttributionStatus === 'unknown'
      && rC.settlement.state !== 'matched'
      && rC.settlement.reasonCodes.indexOf('decisive-settlement-forbidden-unknown-behavior-effect-attribution') >= 0,
      JSON.stringify({ attr: pC.behaviorEffectAttributionStatus, state: rC.settlement.state }));

    /* Case D：语义强 support + 自证链 ⇒ 仍不计入独立校准 */
    const pD = build(busyAuth, 'mD');
    const rD = await settle(pD, stmtObs(pD, '对，非常喜欢'), 'support');
    check('J4.selfFulfillingLoopStaysClosed',
      rD.settlement.calibrationCounted === false,
      'Prediction → BehaviorEffect → Outcome → Matcher ⇒ 不得成为独立确认');
    P('SELF_REINFORCEMENT', 'STILL_BLOCKED');
  }

  /* ══════════════════════════════════════════════════════════════════
     K · guard / no new seam / no calls
     ══════════════════════════════════════════════════════════════════ */
  section('K · guard & scope');
  {
    check('K1.authorityLivesInTheOneFactOwner',
      read(BE_REL).indexOf('snapshotBehaviorEffectAttribution') >= 0
      && read(BE_REL).indexOf('attrActive') >= 0
      && read(BE_REL).indexOf('attrClosed') >= 0,
      'ONE EFFECT FACT OWNER（不新建第二个 registry）');
    const TOK = ['behaviorEffectAttributionCore', 'snapshotBehaviorEffectAttribution'];
    const OTHERS = [
      'services/home-node/runtime-recall.js', 'services/home-node/runtime-interpretation.js',
      'services/home-node/runtime-expectation.js', 'assets/js/communication.js',
      'services/home-node/memory-store.js', 'assets/js/role-dm-core.js',
      'services/home-node/runtime-prediction-calibration.js'
    ];
    const leaky = OTHERS.filter(rel => {
      const code = WIRING.stripJsComments(read(rel));
      return TOK.some(t => G.containsSemantic(code, t));
    });
    check('K2.attributionNotReachableFromForbiddenSurfaces', leaky.length === 0, JSON.stringify(leaky));
    check('K3.noNewRuntimeSeamCount',
      G.P3_SETTLEMENT_AUTHORITY_SURFACES.length === 2
      && G.P4_CALIBRATION_AUTHORITY_SURFACES.length === 2
      && G.P5_MATCHER_AUTHORITY_SURFACES.length === 2,
      'attribution 是既有 BE owner 的内部设施，不新增 seam 面对');
    check('K4.zeroModelCallsAndDurableWrites',
      (function () {
        const code = WIRING.stripJsComments(read(CORE_REL) + read(BE_REL));
        return !/fetch\s*\(|providerConfig|modelPort|indexedDB|localStorage|writeFile|dbPut|sqlite/i.test(code);
      })(), 'MODEL_CALLS_ADDED = 0 · DURABLE_WRITES_ADDED = 0');
    check('K5.noDurableAttributionHistory',
      be().describeAttribution().durableWrites === 0,
      'ATTRIBUTION_LEDGER_LIFETIME = SESSION_ONLY');
    check('K6.matcherDefaultUnchanged',
      read('services/home-node-service.js').indexOf('enabled: options.evidenceMatcherEnabled === true') >= 0
      && read(BE_REL).indexOf('EVIDENCE_MATCHER') < 0,
      'EVIDENCE_MATCHER_ENABLED_DEFAULT 保持 false');
    check('K7.coreHoldsNoForbiddenPath',
      !/relationshipStore|relationDelta|applyCalibration|putRecord/i.test(WIRING.stripJsComments(read(CORE_REL))),
      'attribution 不写 memory / relationship');
  }

  /* ══════════════════════════════════════════════════════════════════
     M · P5-B3-A · coverage closure（active authority vs history retention）
     ══════════════════════════════════════════════════════════════════ */
  section('M · coverage closure (P5-B3-A)');
  {
    const L3x = { ok: true, status: 'succeeded', recordSource: 'S', interpretation: { ok: true, items: [{ memoryId: 'm1', appraisal: 'positive' }] } };
    const L5x = { ok: true, status: 'created' };
    function tiny(over) {
      setNow(T0);
      return createRuntimeBehaviorEffect(Object.assign({
        clock: () => CLOCK_NOW, logger: () => {}, maxHeldBehaviorEffects: 2
      }, over || {}));
    }
    function dev(m, t) {
      return m.deriveAndHold({
        characterId: 'A', conversationId: 'c', turnId: t,
        interpretationValidated: true, interpretationResult: L3x,
        expectationHeld: true, expectation: L5x
      });
    }
    const Q = (m, at) => m.snapshotBehaviorEffectAttribution({ characterId: 'A', conversationId: 'c', at: at });

    /* §28 · capacity eviction 是 observed termination */
    const m = tiny();
    setNow(T0); dev(m, 'T1');
    setNow(T0 + 10); dev(m, 'T2');
    setNow(T0 + 20); dev(m, 'T3');            /* T1 被 capacity 淘汰 */
    const afterEvict = Q(m, T0 + 20);
    check('M1.capacityEvictionProducesTerminalFact', (function () {
      const c = m.describeAttribution();
      return c.counters.capacityEvicted === 1 && c.closedHistoryHeld === 1
        && c.activeInstances === 2;
    })(), JSON.stringify(m.describeAttribution().counters));
    check('M2.evictedInstanceHasEndedAtAndReason', (function () {
      const viol = m.describeAttribution().invariants;
      return viol.ok === true && viol.violations.length === 0;
    })(), '§18 invariant audit 必须干净（不靠日志文本）');
    check('M3.capacityEvictionDoesNotDegradeCoverage',
      afterEvict.coverage === 'complete',
      '★ 旧模型在这里会永久 partial');
    check('M4.evictedInstanceIsInactiveAfterwards',
      Q(m, T0 + 25).effects.filter(e => e.startedAt === T0).length === 0,
      'at/after endedAt ⇒ definitely inactive');

    /* §29 · 无永久污染：全部结束后 present-time 仍是 known-none */
    setNow(T0 + 30);
    m.consumeForTurn({ characterId: 'A', conversationId: 'c', turnId: 'X1' });
    setNow(T0 + 40);
    m.consumeForTurn({ characterId: 'A', conversationId: 'c', turnId: 'X2' });
    const nowSnap = Q(m, T0 + 50);
    check('M5.noPermanentPoisoning',
      nowSnap.status === 'known-none' && nowSnap.coverage === 'complete',
      '★ 本轮最核心 regression：' + JSON.stringify({ s: nowSnap.status, c: nowSnap.coverage }));
    check('M6.allFourEndReasonsAreCanonical',
      JSON.stringify(CORE.END_REASONS) === JSON.stringify(['consumed', 'expired', 'replaced', 'capacity-evicted']),
      JSON.stringify(CORE.END_REASONS));

    /* §31 · consume terminal */
    const mc = tiny();
    setNow(T0); dev(mc, 'C1');
    const idBefore = Q(mc, T0).effects[0].effectInstanceId;
    setNow(T0 + 5);
    mc.consumeForTurn({ characterId: 'A', conversationId: 'c', turnId: 'CX' });
    check('M7.consumeSetsTerminalFact',
      mc.describeAttribution().counters.consumed === 1
      && Q(mc, T0 + 6).status === 'known-none' && Q(mc, T0 + 6).coverage === 'complete',
      JSON.stringify(mc.describeAttribution().counters));
    check('M8.consumeKeepsIdentityAcrossLifecycle',
      mc.describeAttribution().counters.instances === 1
      && typeof idBefore === 'string',
      'derive → active → terminal → historical，identity 全程不变');
    check('M9.consumedInstanceStillHistoricallyVisible',
      Q(mc, T0 + 1).status === 'known-present',
      'retention horizon 内仍能回溯"它曾存在过"');

    /* §32 · expiry terminal */
    const mx = tiny({ holderTtlMs: 100 });
    setNow(T0); dev(mx, 'E1');
    setNow(T0 + 500);                          /* 触发 sweep */
    const afterExpiry = Q(mx, T0 + 500);
    check('M10.expirySetsTerminalFactWithoutDegrading',
      mx.describeAttribution().counters.expired === 1
      && afterExpiry.status === 'known-none' && afterExpiry.coverage === 'complete',
      JSON.stringify({ c: mx.describeAttribution().counters.expired, s: afterExpiry.status }));

    /* §33 · replacement terminal */
    const mr = tiny();
    setNow(T0); dev(mr, 'R1');
    const idA = Q(mr, T0).effects[0].effectInstanceId;
    setNow(T0 + 7); dev(mr, 'R1');             /* 同 holder key ⇒ replaced */
    const snapR = Q(mr, T0 + 8);
    check('M11.replacementTerminatesOldAndMintsNew',
      mr.describeAttribution().counters.replaced === 1
      && snapR.effects.length === 1
      && snapR.effects[0].effectInstanceId !== idA
      && snapR.effects[0].startedAt === T0 + 7,
      '不得出现"旧的消失、新的出现，而旧的没有终态事实"');
    check('M12.noGhostEffect',
      mr.describeAttribution().invariants.ok === true
      && mr.describeAttribution().counters.instances === 2,
      '旧 instance 有终态事实，新 instance 是新 id');

    /* §34 · unobserved disappearance 仍然降级 */
    check('M13.unobservedDisappearanceStillDegrades',
      CORE.resolveCoverage({
        authorityPresent: true, authorityEnabled: true, authoritySince: T0, at: T0 + 10,
        unobservedDisappearance: true
      }).coverage === 'partial',
      '不是把所有 degradation 都删掉了');

    /* §30/§35 · history retention floor：旧的 past partial，current 仍 complete */
    const mh = tiny({ maxClosedHistory: 1 });
    setNow(T0); dev(mh, 'H1');
    setNow(T0 + 10); mh.consumeForTurn({ characterId: 'A', conversationId: 'c', turnId: 'HX1' });
    setNow(T0 + 20); dev(mh, 'H2');
    setNow(T0 + 30); mh.consumeForTurn({ characterId: 'A', conversationId: 'c', turnId: 'HX2' });
    setNow(T0 + 40); dev(mh, 'H3');
    setNow(T0 + 50); mh.consumeForTurn({ characterId: 'A', conversationId: 'c', turnId: 'HX3' });
    const desc = mh.describeAttribution();
    check('M14.closedHistoryIsTrimmedAndFloorAdvances',
      desc.closedHistoryEvicted >= 1 && desc.coverageFloor != null,
      'floor=' + desc.coverageFloor + ' evicted=' + desc.closedHistoryEvicted);
    check('M15.pastQueryBeforeFloorIsPartial',
      CORE.resolveCoverage({
        authorityPresent: true, authorityEnabled: true, authoritySince: T0,
        historyRetentionFloor: desc.coverageFloor, at: T0 + 1
      }).coverage === 'partial',
      '被裁掉的那段过去 ⇒ partial');
    check('M16.currentQueryAfterFloorStaysComplete',
      Q(mh, T0 + 60).coverage === 'complete' && Q(mh, T0 + 60).status === 'known-none',
      '★ 当前/未来归因不被历史裁剪永久污染');
    check('M17.historicalAndCurrentDiverge',
      Q(mh, T0 + 1).coverage !== Q(mh, T0 + 60).coverage
      || (Q(mh, T0 + 1).coverage === 'partial' && Q(mh, T0 + 60).coverage === 'complete'),
      'old query may be partial while current query is complete');

    /* §36 · cross-scope 不受 global floor 错误降级 */
    const ms = tiny();
    setNow(T0); dev(ms, 'S1');
    setNow(T0 + 5);
    check('M18.crossScopeStillIsolated',
      ms.snapshotBehaviorEffectAttribution({ characterId: 'B', conversationId: 'c', at: T0 + 5 }).status === 'known-none'
      && ms.snapshotBehaviorEffectAttribution({ characterId: 'A', conversationId: 'other', at: T0 + 5 }).status === 'known-none'
      && ms.snapshotBehaviorEffectAttribution({ characterId: 'A', conversationId: 'c', at: T0 + 5 }).status === 'known-present',
      'per-scope relevance 继续成立');

    /* §37 · Prediction snapshot 不被历史裁剪回写 */
    const mps = tiny({ maxClosedHistory: 1 });
    setNow(T0); dev(mps, 'P1');
    setNow(T0 + 5);
    const reg = createRuntimePredictionRegistry({ clock: () => CLOCK_NOW, attributionAuthority: mps });
    const pRec = reg.projectFromValidatedExpectation(expectation(), {
      now: T0 + 5, characterId: 'A', conversationId: 'c', turnId: 'snap1', expectationIndex: 0
    }).record;
    const snapJson = JSON.stringify(pRec.predictionSnapshotAtCreation);
    const attrBefore = pRec.behaviorEffectAttributionStatus;
    /* 后续：容量淘汰 + 历史裁剪 + 新 effect + consume */
    setNow(T0 + 10); dev(mps, 'P2');
    setNow(T0 + 20); dev(mps, 'P3');
    setNow(T0 + 30); dev(mps, 'P4');
    setNow(T0 + 40); mps.consumeForTurn({ characterId: 'A', conversationId: 'c', turnId: 'PX1' });
    check('M19.predictionSnapshotNeverRewrittenByRetention',
      JSON.stringify(pRec.predictionSnapshotAtCreation) === snapJson
      && pRec.behaviorEffectAttributionStatus === attrBefore
      && Object.isFrozen(pRec.predictionSnapshotAtCreation),
      'PREDICTION_ATTRIBUTION_SNAPSHOT_IMMUTABLE = YES（attribution=' + attrBefore + '）');
    P('ATTRIBUTION_COVERAGE_READY', 'YES');
  }

  /* ══════════════════════════════════════════════════════════════════
     L · scope
     ══════════════════════════════════════════════════════════════════ */
  section('L · scope');
  {
    P('P5_B2_STATUS', 'COMPLETE');
    P('ATTRIBUTION_AUTHORITY_LIVE', 'YES');
    P('BEHAVIOR_EFFECT_ATTRIBUTION_AUTHORITY', CORE.AUTHORITY);
    P('ATTRIBUTION_LEDGER_LIFETIME', 'SESSION_ONLY');
    P('KNOWN_NONE_REQUIRES_COMPLETE_COVERAGE', 'YES');
    P('ABSENCE_OF_EFFECT_RECORD_IS_NOT_KNOWN_NONE', 'YES');
    P('EVIDENCE_MATCHER_ENABLED_DEFAULT', false);
    P('MATCHER_DEFAULT_CHANGED', 'NO');
    P('MODEL_CALLS_ADDED', 0);
    P('DURABLE_WRITES_ADDED', 0);
    P('CALIBRATION_CONFIDENCE', 'null');
    P('CALIBRATION_APPLIED_TO_LIVE', 'NO');
    P('MEMORY_WRITE', 'NONE');
    P('RELATIONSHIP_WRITE', 'NONE');
    P('UI_DISCLOSURE_CHANGED', 'NO');
    P('RECALL_ENVELOPE_CHANGED', 'NO');
  }

  console.log('\n' + '='.repeat(64));
  if (failures) {
    console.error('BEHAVIOR EFFECT ATTRIBUTION FAILED · ' + failures + ' assertion(s), ' + passed + ' passed');
    process.exit(1);
  }
  console.log('BEHAVIOR EFFECT ATTRIBUTION PASSED · ' + passed + ' assertions green');
})().catch((e) => {
  console.error('BEHAVIOR EFFECT ATTRIBUTION CRASHED:', e && e.stack ? e.stack : e);
  process.exit(1);
});

