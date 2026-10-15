'use strict';

const core = require('../assets/js/response-guidance-core.js');
const behaviorRenderer = require('../assets/js/behavior-effect-render.js');

let passed = 0, failed = 0;
function check(name, ok, detail) {
  if (ok) { passed += 1; console.log('PASS ' + name); }
  else { failed += 1; console.error('FAIL ' + name + (detail ? ' · ' + JSON.stringify(detail) : '')); }
}

const identity = {
  characterId: 'char-a', conversationId: 'dm:char-a', requestId: 'req-a', turnId: 'turn-a'
};
const effect = {
  stance: 'guarded', strategy: 'ask_clarifying', initiativeTendency: 'low',
  rationaleCode: 'derived-from-negative-interpretation', sourceTurn: 'turn-source',
  derivedFrom: 'L3_AND_L5', ttlTurns: 1
};
const provenance = {
  sourceTurn: 'turn-source', memoryRefs: [], interpretationRefs: [], narrativeRefs: []
};

(function main() {
  const wrapped = core.fromBehaviorEffect(effect, identity);
  check('G1.R4FBehaviorEffectWrapsWithoutChangingItsClosedPayload',
    wrapped.ok === true && wrapped.envelope.schemaVersion === core.SCHEMA_VERSION
      && wrapped.envelope.turnIdentity.requestId === identity.requestId
      && wrapped.envelope.turnIdentity.turnId === identity.turnId
      && wrapped.envelope.entries.length === 1
      && wrapped.envelope.entries[0].sourceKind === 'r4f_behavior_effect'
      && JSON.stringify(wrapped.envelope.entries[0].payload) === JSON.stringify(effect));

  const rendered = core.renderEnvelope(wrapped.envelope, identity, {
    'behavior-effect-v1': behaviorRenderer.render
  });
  const oldRendered = behaviorRenderer.render(effect);
  check('G2.sharedContractPreservesExistingR4FRendererOutput',
    rendered.ok === true && rendered.accepted.length === 1
      && rendered.text === oldRendered.lines.join('\n')
      && rendered.text.indexOf(effect.sourceTurn) < 0);

  check('G3.turnScopeMismatchFailsClosed',
    core.validateEnvelope(wrapped.envelope, Object.assign({}, identity, { turnId: 'turn-b' })).reason === 'turn-scope-mismatch');
  const extraEnvelopeKey = Object.assign({}, wrapped.envelope, { consumed: true });
  check('G4.envelopeCannotCarryCallerConsumptionOrAuthorityFields',
    core.validateEnvelope(extraEnvelopeKey, identity).ok === false);
  const extraEntryKey = Object.assign({}, wrapped.envelope, {
    entries: [Object.assign({}, wrapped.envelope.entries[0], { promptText: 'free text' })]
  });
  check('G5.entryCannotCarryPromptTextOrUnknownKeys',
    core.validateEnvelope(extraEntryKey, identity).ok === false);
  const cyclicPayload = {}; cyclicPayload.loop = cyclicPayload;
  const cyclicEnvelope = Object.assign({}, wrapped.envelope, {
    entries: [Object.assign({}, wrapped.envelope.entries[0], { payload: cyclicPayload })]
  });
  check('G5b.cyclicPayloadFailsClosedWithoutThrowing',
    core.validateEnvelope(cyclicEnvelope, identity).ok === false);
  const duplicate = Object.assign({}, wrapped.envelope, { entries: [wrapped.envelope.entries[0], wrapped.envelope.entries[0]] });
  check('G6.duplicateEntryIsRejectedInsteadOfRenderedTwice',
    core.validateEnvelope(duplicate, identity).ok === false);

  const participationId = 'ext_fixture_1';
  const externalFixture = core.buildEnvelope(identity, [{
    entryId: participationId,
    sourceKind: 'memory_behavior_modulation',
    guidanceKind: 'test-marker-v1',
    payload: { marker: 'test-guidance' },
    provenance: Object.assign({}, provenance, { sourceTurn: identity.turnId }),
    participationId: participationId
  }], { allowTestFixtures: true });
  check('G7.testMarkerRemainsFixtureOnlyAndDoesNotCarryPostureOrMemoryText',
    externalFixture.ok === true
      && core.validateEnvelope(externalFixture.envelope, identity).ok === false
      && externalFixture.envelope.entries[0].payload.marker === 'test-guidance'
      && !Object.prototype.hasOwnProperty.call(externalFixture.envelope.entries[0].payload, 'posture'));
  const fixtureRender = core.renderEnvelope(externalFixture.envelope, identity, {
    'test-marker-v1': function (payload) {
      return payload.marker === 'test-guidance'
        ? { kind: 'PLACEMENT', lines: ['M0 fixed fixture line'] }
        : { kind: 'REFUSED', reasonCode: 'fixture-marker-invalid' };
    }
  }, { allowTestFixtures: true });
  check('G8.testFixtureUsesFixedRendererTextWithoutInterpolatingPayload',
    fixtureRender.ok === true && fixtureRender.text === 'M0 fixed fixture line'
      && fixtureRender.text.indexOf('test-guidance') < 0
      && fixtureRender.accepted[0].participationId === participationId);

  const posture = {
    warmth: 'reduced', trustPosture: 'guarded', initiative: 'restrained',
    interpersonalDistance: 'increased', disclosureWillingness: 'reduced'
  };
  const postureEnvelope = core.buildEnvelope(identity, [{
    entryId: 'posture-entry-1', sourceKind: 'memory_behavior_modulation',
    guidanceKind: 'memory-behavior-posture-v1',
    payload: { schemaVersion: 'behavior-posture-v1', posture: posture },
    provenance: { sourceTurn: identity.turnId, memoryRefs: ['mem-1'],
      interpretationRefs: ['interp-1'], narrativeRefs: ['narrative-1'] },
    participationId: 'ext-posture-1'
  }]);
  const postureRendered = postureEnvelope.ok && core.renderEnvelope(postureEnvelope.envelope, identity, {
    'memory-behavior-posture-v1': core.renderBehaviorPosture
  });
  check('G9.productionPostureUsesClosedOrdinalsAndSharedFixedRenderer',
    postureEnvelope.ok === true && postureRendered.ok === true
      && postureRendered.text.includes('non-hostile')
      && postureRendered.text.includes('OOC/integrity constraints')
      && postureRendered.text.indexOf('mem-1') < 0
      && postureRendered.text.indexOf('narrative-1') < 0);
  const floatingPosture = Object.assign({}, postureEnvelope.envelope, {
    entries: [Object.assign({}, postureEnvelope.envelope.entries[0], {
      payload: { schemaVersion: 'behavior-posture-v1', posture: Object.assign({}, posture, { warmth: 0.5 }) }
    })]
  });
  check('G10.postureRejectsScoresExtraKeysAndOpenEndedValues',
    core.validateEnvelope(floatingPosture, identity).ok === false);
  const baselineRender = core.renderBehaviorPosture({
    schemaVersion: 'behavior-posture-v1',
    posture: { warmth: 'baseline', trustPosture: 'neutral', initiative: 'baseline',
      interpersonalDistance: 'baseline', disclosureWillingness: 'baseline' }
  });
  check('G11.baselinePostureHasNoPromptPlacement', baselineRender.kind === 'NO_PLACEMENT');

  console.log('\nRESPONSE GUIDANCE CONTRACT · ' + passed + ' passed, ' + failed + ' failed');
  if (failed) process.exit(1);
})();
