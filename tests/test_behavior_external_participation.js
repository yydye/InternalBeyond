'use strict';

const behaviorEffectModule = require('../services/home-node/runtime-behavior-effect.js');
const createRuntimeBehaviorEffect = behaviorEffectModule.createRuntimeBehaviorEffect;
const predictionRegistryModule = require('../services/home-node/runtime-prediction-registry.js');
const createRuntimePredictionRegistry = predictionRegistryModule.createRuntimePredictionRegistry;
const createRuntimeOutcomeObservation = require('../services/home-node/runtime-outcome-observation.js').createRuntimeOutcomeObservation;

let passed = 0, failed = 0;
function check(name, ok, detail) {
  if (ok) { passed += 1; console.log('PASS ' + name); }
  else { failed += 1; console.error('FAIL ' + name + (detail ? ' · ' + JSON.stringify(detail) : '')); }
}

function scope(overrides) {
  return Object.assign({
    characterId: 'char-a', conversationId: 'dm:char-a', turnId: 'turn-a',
    sourceKind: 'memory_behavior_modulation'
  }, overrides || {});
}

function runtimeWithClock(clock) {
  return createRuntimeBehaviorEffect({ clock: clock, logger: function () {} });
}

(function main() {
  let now = 10000;
  const runtime = runtimeWithClock(() => now);
  const noInfluence = runtime.snapshotBehaviorEffectAttribution({
    characterId: 'char-a', conversationId: 'dm:char-a', at: now
  });
  check('M0-1.noBehaviorEffectAndNoExternalParticipationRetainsKnownNone',
    noInfluence.status === 'known-none' && noInfluence.coverage === 'complete'
      && noInfluence.effects.length === 0 && noInfluence.externalInfluences.length === 0);

  const badShape = runtime.registerExternalInfluence(Object.assign(scope(), { payload: { marker: 'secret' } }));
  const forgedStatus = runtime.registerExternalInfluence(Object.assign(scope(), {
    behaviorEffectAttributionStatus: 'known-none', predictionInfluencedSystem: false,
    calibrationCounted: true, sealed: true, authority: 'client'
  }));
  const badSource = runtime.registerExternalInfluence(scope({ sourceKind: 'runtime-behavior-effect' }));
  check('M0-2.registrationRejectsPayloadAndUnknownSources',
    badShape.ok === false && forgedStatus.ok === false && badSource.ok === false);

  const registered = runtime.registerExternalInfluence(scope());
  check('M0-3.registrationMintsScopedExternalIdentityWithoutPosturePayload',
    registered.ok === true && registered.status === 'registered'
      && registered.participation.participationId.startsWith('ext_')
      && registered.participation.sourceKind === 'memory_behavior_modulation'
      && !Object.prototype.hasOwnProperty.call(registered.participation, 'payload'));

  const replayed = [];
  for (let i = 0; i < 100; i++) replayed.push(runtime.registerExternalInfluence(scope()));
  check('M0-4.replay100xUsesOneLogicalParticipation',
    replayed.every((r) => r.ok && r.participation.participationId === registered.participation.participationId)
      && runtime.describeAttribution().counters.externalRegistered === 1);

  const pending = runtime.snapshotBehaviorEffectAttribution({
    characterId: 'char-a', conversationId: 'dm:char-a', turnId: 'turn-a', at: now + 1
  });
  check('M0-5.registeredButUnverifiedFailsClosedWithoutClaimingKnownPresent',
    pending.status === 'unknown' && pending.coverage === 'partial'
      && pending.effects.length === 0
      && pending.externalInfluences.length === 1
      && pending.externalInfluences[0].state === 'REGISTERED'
      && pending.reasonCodes.includes('external-influence-unaccounted'));

  const wrongTurn = runtime.consumeExternalInfluence(Object.assign(scope({ turnId: 'turn-b' }), {
    participationId: registered.participation.participationId
  }));
  const wrongTurnReject = runtime.markExternalInfluenceNotConsumed(Object.assign(scope({ turnId: 'turn-b' }), {
    participationId: registered.participation.participationId, reasonCode: 'renderer-refused'
  }));
  const wrongCharacter = runtime.consumeExternalInfluence(Object.assign(scope({ characterId: 'char-b' }), {
    participationId: registered.participation.participationId
  }));
  const wrongConversation = runtime.consumeExternalInfluence(Object.assign(scope({ conversationId: 'dm:other' }), {
    participationId: registered.participation.participationId
  }));
  const wrongTurnSnapshot = runtime.snapshotBehaviorEffectAttribution({
    characterId: 'char-a', conversationId: 'dm:char-a', turnId: 'turn-b', at: now + 1
  });
  check('M0-6.wrongTurnCharacterOrConversationCannotConsume',
    wrongTurn.ok === false && wrongTurnReject.ok === false
      && wrongCharacter.ok === false && wrongConversation.ok === false
      && wrongTurnSnapshot.status === 'known-none' && wrongTurnSnapshot.externalInfluences.length === 0);

  const consumed = runtime.consumeExternalInfluence(Object.assign(scope(), {
    participationId: registered.participation.participationId
  }));
  const consumedAgain = runtime.consumeExternalInfluence(Object.assign(scope(), {
    participationId: registered.participation.participationId
  }));
  check('M0-7.serverConsumptionIsIdempotentAndRemainsExternal',
    consumed.ok === true && consumed.status === 'consumed'
      && consumedAgain.ok === true && consumedAgain.participation.state === 'CONSUMED'
      && runtime.snapshotBehaviorEffectAttribution({
        characterId: 'char-a', conversationId: 'dm:char-a', turnId: 'turn-a', at: now + 2
      }).status === 'unknown');

  const staleClock = { now: 20000 };
  const staleRuntime = runtimeWithClock(() => staleClock.now);
  const stale = staleRuntime.registerExternalInfluence(scope({ turnId: 'turn-stale' }));
  staleClock.now += behaviorEffectModule.EXTERNAL_PARTICIPATION_TTL_MS + 1;
  const staleConsume = staleRuntime.consumeExternalInfluence(Object.assign(scope({ turnId: 'turn-stale' }), {
    participationId: stale.participation.participationId
  }));
  const staleTimeSnapshot = staleRuntime.snapshotBehaviorEffectAttribution({
    characterId: 'char-a', conversationId: 'dm:char-a', turnId: 'turn-stale', at: 20001
  });
  check('M0-8.staleEntryIsRejectedAndItsUnobservedWindowStaysUnknown',
    staleConsume.ok === false && staleConsume.reasonCode === 'external-registration-not-consumable'
      && staleTimeSnapshot.status === 'unknown');

  const rejectedRuntime = runtimeWithClock(() => 30000);
  const rejected = rejectedRuntime.registerExternalInfluence(scope({ turnId: 'turn-not-consumed' }));
  const notConsumed = rejectedRuntime.markExternalInfluenceNotConsumed(Object.assign(scope({ turnId: 'turn-not-consumed' }), {
    participationId: rejected.participation.participationId,
    reasonCode: 'renderer-refused'
  }));
  const afterReject = rejectedRuntime.snapshotBehaviorEffectAttribution({
    characterId: 'char-a', conversationId: 'dm:char-a', turnId: 'turn-not-consumed', at: 30001
  });
  check('M0-9.trustedNotConsumedOutcomeDoesNotPretendTheInfluenceWasApplied',
    notConsumed.ok === true && notConsumed.status === 'not-consumed'
      && afterReject.status === 'known-none' && afterReject.externalInfluences.length === 0);

  const boundedRuntime = runtimeWithClock(() => 40000);
  let oldest = null;
  for (let i = 0; i < behaviorEffectModule.MAX_EXTERNAL_PARTICIPATIONS + 1; i++) {
    const result = boundedRuntime.registerExternalInfluence(scope({
      conversationId: 'dm:bounded:' + i, turnId: 'turn-' + i
    }));
    if (i === 0) oldest = result;
  }
  const evictedSnapshot = boundedRuntime.snapshotBehaviorEffectAttribution({
    characterId: 'char-a', conversationId: 'dm:bounded:0', turnId: 'turn-0', at: 40001
  });
  check('M0-10.externalParticipationHolderIsBoundedAndEvictionCannotCreateKnownNone',
    boundedRuntime.describeAttribution().externalParticipations <= behaviorEffectModule.MAX_EXTERNAL_PARTICIPATIONS
      && evictedSnapshot.status === 'unknown',
    { oldestId: oldest && oldest.participation && oldest.participation.participationId });

  check('M0-11.singleAttributionOwnerSealRemainsCanonical',
    behaviorEffectModule.isCanonicalBehaviorEffectAttributionAuthority(runtime) === true
      && runtime.describeAttribution().oneEffectFactOwner === 'YES'
      && runtime.describeAttribution().durableWrites === 0
      && runtime.describeAttribution().modelCalls === 0);

  let registeredAttribution = runtimeWithClock(() => 50000);
  const registeredPrediction = registeredAttribution.registerExternalInfluence(scope({
    characterId: 'char-p', conversationId: 'dm:char-p', turnId: 'turn-p'
  }));
  const predictionRegistry = createRuntimePredictionRegistry({
    clock: function () { return 50000; }, attributionAuthority: registeredAttribution
  });
  const projected = predictionRegistry.projectFromValidatedExpectation({
    epistemicStatus: 'prediction', prediction: 'A future preference may be stated.',
    trigger: { kind: 'explicit-cue', label: 'explicit cue' }, evidenceMemoryIds: ['m1'],
    contradictoryEvidenceIds: [], generalizationLevel: 'episode-hypothesis',
    subjectivePredictionConfidence: 0.7, subject: { kind: 'user', label: '' },
    predicate: { kind: 'prefers' }, expectedOutcome: { kind: 'exclusive-outcome', token: 'action.confirmed' }
  }, {
    now: 50000, characterId: 'char-p', conversationId: 'dm:char-p',
    turnId: 'turn-p', expectationIndex: 0
  });
  check('M0-12.registeredExternalParticipationFlowsUnknownIntoPredictionWithoutMintingBehaviorEffect',
    registeredPrediction.ok === true && projected.ok === true && projected.record
      && projected.record.behaviorEffectAttributionStatus === 'unknown'
      && projected.record.behaviorEffectsInForce.length === 0,
    { status: projected.record && projected.record.behaviorEffectAttributionStatus,
      effects: projected.record && projected.record.behaviorEffectsInForce });

  const outcomeClock = { now: 60000 };
  const outcomeAuthority = createRuntimeBehaviorEffect({ clock: function () { return outcomeClock.now; }, logger: function () {} });
  const outcomeRegistration = outcomeAuthority.registerExternalInfluence({
    characterId: 'char-outcome', conversationId: 'dm:char-outcome',
    turnId: 'turn-outcome', sourceKind: 'memory_behavior_modulation'
  });
  outcomeAuthority.consumeExternalInfluence({
    characterId: 'char-outcome', conversationId: 'dm:char-outcome',
    turnId: 'turn-outcome', sourceKind: 'memory_behavior_modulation',
    participationId: outcomeRegistration.participation.participationId
  });
  const outcome = createRuntimeOutcomeObservation({
    registry: { getPrediction: function () { return { sourceExpectationRef: { turnId: 'turn-outcome' } }; } },
    attributionAuthority: outcomeAuthority,
    logger: function () {}
  }).mintObservation({
    producerId: 'runtime-state', targetDomain: 'runtime_state',
    predictionRef: { predictionId: 'pred_external', predictionCreatedAt: 60000, opensAt: 60000, closesAt: 90000 },
    sourceEvent: {
      sourceEventId: 'evt_external', characterId: 'char-outcome',
      conversationId: 'dm:char-outcome', occurredAt: 60001,
      kind: 'token', token: 'delivery.completed'
    }
  });
  check('M0-13.outcomeTimeAttributionCarriesUnknownForConsumedExternalInfluence',
    outcome.ok === true && outcome.attribution.status === 'unknown'
      && outcome.observation.interventionContext.contaminationClass === 'UNKNOWN'
      && outcome.observation.interventionContext.contaminationComputed === 'NONE'
      && outcome.observation.interventionContext.contaminationDeclared === 'UNKNOWN',
    { attribution: outcome.attribution, intervention: outcome.observation && outcome.observation.interventionContext });

  console.log('\nBEHAVIOR EXTERNAL PARTICIPATION · ' + passed + ' passed, ' + failed + ' failed');
  if (failed) process.exit(1);
})();
