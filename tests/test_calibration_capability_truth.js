'use strict';
/* P5-B3-J-R1 · canonical attribution authority availability truth */

const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const BE_REL = 'services/home-node/runtime-behavior-effect.js';
const BE_PATH = path.join(ROOT, BE_REL);
const BE = require(BE_PATH);
const CAL_CORE = require(path.join(ROOT, 'assets/js/memory-recall/prediction-calibration-core.js'));
const P3_CORE = require(path.join(ROOT, 'assets/js/memory-recall/prediction-settlement-core.js'));
const P3_RUNTIME = require(path.join(ROOT, 'services/home-node/runtime-prediction-settlement.js'));
const RECORD_CORE = require(path.join(ROOT, 'assets/js/memory-recall/prediction-record-core.js'));
const STRUCTURED_EXPECTATION = require(path.join(ROOT, 'services/home-node/runtime-structured-expectation.js'));
const { createRuntimePredictionCalibration } = require(path.join(ROOT, 'services/home-node/runtime-prediction-calibration.js'));
const { createRuntimeEvidenceMatcher } = require(path.join(ROOT, 'services/home-node/runtime-evidence-matcher.js'));

let passed = 0;
let failed = 0;
const check = (name, condition, detail) => {
  if (condition) { passed += 1; console.log('  PASS  ' + name); return; }
  failed += 1;
  console.error('  FAIL  ' + name + (detail === undefined ? '' : '  -> ' + JSON.stringify(detail)));
};
const T0 = 1760000000000;

function p4(authority) {
  return createRuntimePredictionCalibration({ attributionAuthority: authority, clock: () => T0 });
}

console.log('\n── authority instance truth ──');
const wiredAuthority = BE.createRuntimeBehaviorEffect({ clock: () => T0 });
const wiredCalibration = p4(wiredAuthority);
const sealed = wiredAuthority.snapshotBehaviorEffectAttribution({
  characterId: 'char_a', conversationId: 'dm:char_a', at: T0
});
check('A1.factoryRuntimeWithCanonicalSealAndValidatorIsAvailable',
  BE.isCanonicalBehaviorEffectAttributionAuthority(wiredAuthority) === true
  && wiredAuthority.isBehaviorEffectAttributionSnapshot(sealed) === true,
  wiredAuthority.describeAttribution());
check('A2.behaviorEffectDescribeSurfacesAgree',
  wiredAuthority.describe().attributionAuthorityAvailable === true
  && wiredAuthority.describeAttribution().attributionAuthorityAvailable === true);
check('A3.P4DescribeAndDiagnosticsUseTheSameRuntimeTruth',
  wiredCalibration.describe().attributionAuthorityAvailable === true
  && wiredCalibration.inspectCalibration().view.diagnostics.attributionAuthorityAvailable === true,
  wiredCalibration.inspectCalibration().view.diagnostics);
const wiredMatcher = createRuntimeEvidenceMatcher({ attributionAuthority: wiredAuthority });
check('A4.matcherAndP4ShareAuthorityTruthWhileMatcherRemainsDisabled',
  wiredMatcher.describe().matcherCapabilityPresent === true
  && wiredMatcher.describe().attributionAuthorityAvailable === true
  && wiredMatcher.describe().enabled === false
  && wiredMatcher.describe().runtimeClassifiable === false
  && wiredMatcher.describe().productionSettleable === false,
  wiredMatcher.describe());

console.log('\n── fail-closed identity checks ──');
const missingCalibration = p4(undefined);
const copiedAuthority = Object.assign({}, wiredAuthority);
const jsonAuthority = JSON.parse(JSON.stringify(wiredAuthority));
const brandCopy = Object.assign({ brand: 'RUNTIME_BEHAVIOR_EFFECT' }, copiedAuthority);
const missingValidator = {
  snapshotBehaviorEffectAttribution: wiredAuthority.snapshotBehaviorEffectAttribution,
  describeAttribution: wiredAuthority.describeAttribution,
  describe: wiredAuthority.describe
};
check('B1.missingAuthorityFailsClosed',
  missingCalibration.describe().attributionAuthorityAvailable === false
  && missingCalibration.inspectCalibration().view.diagnostics.attributionAuthorityAvailable === false
  && createRuntimeEvidenceMatcher({}).describe().attributionAuthorityAvailable === false);
check('B2.plainObjectBrandOrMethodCopyFailsClosed',
  BE.isCanonicalBehaviorEffectAttributionAuthority(copiedAuthority) === false
  && BE.isCanonicalBehaviorEffectAttributionAuthority(jsonAuthority) === false
  && BE.isCanonicalBehaviorEffectAttributionAuthority(brandCopy) === false
  && p4(copiedAuthority).describe().attributionAuthorityAvailable === false);
check('B3.missingValidatorFailsClosed',
  BE.isCanonicalBehaviorEffectAttributionAuthority(missingValidator) === false
  && p4(missingValidator).describe().attributionAuthorityAvailable === false);

const currentModulePath = require.resolve(BE_PATH);
const currentModuleEntry = require.cache[currentModulePath];
delete require.cache[currentModulePath];
const otherModuleInstance = require(currentModulePath);
if (currentModuleEntry) require.cache[currentModulePath] = currentModuleEntry;
const wrongModuleAuthority = otherModuleInstance.createRuntimeBehaviorEffect({ clock: () => T0 });
check('B4.secondModuleInstanceDoesNotSatisfyThisP4SealOwner',
  otherModuleInstance.isCanonicalBehaviorEffectAttributionAuthority(wrongModuleAuthority) === true
  && BE.isCanonicalBehaviorEffectAttributionAuthority(wrongModuleAuthority) === false
  && p4(wrongModuleAuthority).describe().attributionAuthorityAvailable === false);

console.log('\n── query coverage stays orthogonal ──');
let now = T0;
const partialAuthority = BE.createRuntimeBehaviorEffect({
  clock: () => now,
  maxClosedHistory: 0
});
const l3 = {
  ok: true, status: 'succeeded', recordSource: 'CAPABILITY_TRUTH_TEST',
  interpretation: { ok: true, items: [{ memoryId: 'm1', appraisal: 'positive' }] }
};
const l5 = { ok: true, status: 'created' };
partialAuthority.deriveAndHold({
  characterId: 'char_a', conversationId: 'dm:char_a', turnId: 'turn_1',
  interpretationValidated: true, interpretationResult: l3,
  expectationHeld: true, expectation: l5
});
now = T0 + 10;
partialAuthority.consumeForTurn({ characterId: 'char_a', conversationId: 'dm:char_a', turnId: 'turn_2' });
const partialUnknown = partialAuthority.snapshotBehaviorEffectAttribution({
  characterId: 'char_a', conversationId: 'dm:char_a', at: T0 + 1
});
const partialCalibration = p4(partialAuthority);
const partialCoverage = CAL_CORE.capabilityCoverage({
  predictionType: 'preference', contradictionMode: 'exclusive_outcome',
  counts: CAL_CORE.emptyCounts(), policyAllowed: true, runtimeClassifiable: true,
  attributionAuthorityAvailable: partialCalibration.describe().attributionAuthorityAvailable
});
check('C1.partialHistoryProducesUnknownWithoutRemovingAuthority',
  partialUnknown.coverage === 'partial' && partialUnknown.status === 'unknown'
  && partialAuthority.isBehaviorEffectAttributionSnapshot(partialUnknown) === true
  && partialCalibration.describe().attributionAuthorityAvailable === true
  && partialCalibration.inspectCalibration().view.diagnostics.attributionAuthorityAvailable === true,
  { attribution: { coverage: partialUnknown.coverage, status: partialUnknown.status },
    p4: partialCalibration.describe().attributionAuthorityAvailable });
check('C2.noSampleAndCapabilityGapRemainOrthogonal',
  partialCoverage.attributionAuthorityAvailable === true
  && partialCoverage.noEligibleSample === true
  && partialCoverage.capabilityGap === false
  && partialCoverage.runtimeClassifiable === true,
  partialCoverage);

const unavailableAuthority = BE.createRuntimeBehaviorEffect({
  clock: () => T0,
  attributionAuthorityEnabled: false
});
const unavailableUnknown = unavailableAuthority.snapshotBehaviorEffectAttribution({
  characterId: 'char_a', conversationId: 'dm:char_a', at: T0
});
check('C3.unavailableQueryCoverageDoesNotMeanAuthorityMissing',
  unavailableUnknown.coverage === 'unavailable' && unavailableUnknown.status === 'unknown'
  && BE.isCanonicalBehaviorEffectAttributionAuthority(unavailableAuthority) === true
  && p4(unavailableAuthority).describe().attributionAuthorityAvailable === true,
  { coverage: unavailableUnknown.coverage, status: unavailableUnknown.status });

console.log('\n── canonical productionSettleable formula ──');
function reachable(type, domain, mode, matcherEnabled) {
  return P3_RUNTIME.calibrationReachability({
    predictionType: type,
    targetDomain: domain,
    settlementState: 'matched',
    contradictionMode: mode,
    matcherEnabled: matcherEnabled === true
  });
}
function capability(type, domain, mode, matcherEnabled, authorityAvailable, counts) {
  const p3 = reachable(type, domain, mode, matcherEnabled);
  return {
    reachability: p3,
    coverage: CAL_CORE.capabilityCoverage({
      predictionType: type,
      contradictionMode: mode,
      counts: counts || CAL_CORE.emptyCounts(),
      policyAllowed: P3_CORE.policyAllowsDecisiveSettlement(type),
      runtimeClassifiable: P3_CORE.runtimeCanClassifyMode(mode) || matcherEnabled === true,
      attributionAuthorityAvailable: authorityAvailable === true
    })
  };
}
const eventMechanical = capability('event', 'runtime_state', 'exclusive_outcome', false, true);
const preferenceMechanical = capability('preference', 'user_preference', 'exclusive_outcome', false, true);
const latentMatcherOff = capability('latent_state', 'latent_state', 'explicit_denial', false, true);
const relationalMatcherOff = capability('relational', 'relationship', 'explicit_denial', false, true);
const latentMatcherOn = capability('latent_state', 'latent_state', 'explicit_denial', true, true);
const relationalMatcherOn = capability('relational', 'relationship', 'explicit_denial', true, true);
check('E1.canonicalFormulaIsDeclaredByCoreAndP4Runtime',
  CAL_CORE.STATE_SUPPORT.productionSettleableFormula
    === 'policyAllowed && runtimeClassifiable && attributionAuthorityAvailable'
  && wiredCalibration.describe().productionSettleableFormula === CAL_CORE.STATE_SUPPORT.productionSettleableFormula,
  wiredCalibration.describe().productionSettleableFormula);
check('E2.eventMechanicalPathDoesNotNeedTheMatcher',
  eventMechanical.reachability.class === 'reachable-now'
  && eventMechanical.coverage.policyAllowed === true
  && eventMechanical.coverage.runtimeClassifiable === true
  && eventMechanical.coverage.attributionAuthorityAvailable === true
  && eventMechanical.coverage.productionSettleable === true
  && eventMechanical.coverage.noEligibleSample === true);
check('E3.structuredPreferenceMechanicalPathIsSettleableWithMatcherOff',
  STRUCTURED_EXPECTATION.G1_PRODUCTION_PROJECTION_TYPES.join(',') === 'preference'
  && preferenceMechanical.reachability.reachable === true
  && preferenceMechanical.coverage.runtimeClassifiable === true
  && preferenceMechanical.coverage.productionSettleable === true
  && preferenceMechanical.coverage.noEligibleSample === true
  && RECORD_CORE.POLICY_TABLE.preference.opportunityRequiredForNegative === true);
check('E4.matcherRequiredTypesStayUnsettleableWhileMatcherIsOff',
  latentMatcherOff.reachability.class === 'reachable-policy-only'
  && relationalMatcherOff.reachability.class === 'reachable-policy-only'
  && latentMatcherOff.coverage.policyAllowed === true
  && relationalMatcherOff.coverage.policyAllowed === true
  && latentMatcherOff.coverage.runtimeClassifiable === false
  && relationalMatcherOff.coverage.runtimeClassifiable === false
  && latentMatcherOff.coverage.capabilityGap === true
  && relationalMatcherOff.coverage.capabilityGap === true
  && latentMatcherOff.coverage.noEligibleSample === true
  && relationalMatcherOff.coverage.noEligibleSample === true
  && latentMatcherOff.coverage.productionSettleable === false
  && relationalMatcherOff.coverage.productionSettleable === false);
check('E5.matcherOnlyOpensTheStatementClassificationDimension',
  latentMatcherOn.reachability.class === 'reachable-now'
  && relationalMatcherOn.reachability.class === 'reachable-now'
  && latentMatcherOn.coverage.productionSettleable === true
  && relationalMatcherOn.coverage.productionSettleable === true,
  { latent: latentMatcherOn.reachability, relational: relationalMatcherOn.reachability });
const deniedButMechanicallyClassifiable = CAL_CORE.capabilityCoverage({
  predictionType: 'not-a-type', contradictionMode: 'exclusive_outcome',
  counts: CAL_CORE.emptyCounts(), policyAllowed: false, runtimeClassifiable: true,
  attributionAuthorityAvailable: true
});
check('E6.policyPermissionParticipatesInProductionSettleable',
  deniedButMechanicallyClassifiable.policyAllowed === false
  && deniedButMechanicallyClassifiable.runtimeClassifiable === true
  && deniedButMechanicallyClassifiable.productionSettleable === false
  && deniedButMechanicallyClassifiable.status === 'not-policy-allowed'
  && deniedButMechanicallyClassifiable.capabilityGap === false
  && deniedButMechanicallyClassifiable.noEligibleSample === true
  && deniedButMechanicallyClassifiable.reasonCodes.indexOf('attribution-unknown') < 0,
  deniedButMechanicallyClassifiable);
const preferenceWithSample = capability('preference', 'user_preference', 'exclusive_outcome', false, true,
  Object.assign(CAL_CORE.emptyCounts(), { eligibleTotal: 1 }));
check('E7.sampleAvailabilityNeverChangesProductionSettleable',
  preferenceMechanical.coverage.productionSettleable === preferenceWithSample.coverage.productionSettleable
  && preferenceMechanical.coverage.noEligibleSample === true
  && preferenceWithSample.coverage.noEligibleSample === false);
check('E8.calibrationConfidenceAndApplicationStayFrozen',
  wiredCalibration.describe().calibrationConfidence === null
  && wiredCalibration.describe().calibrationAppliedToLive === 'NO');
check('E9.opportunityRemainsADirectionalPerPredictionGate',
  RECORD_CORE.PREDICTION_TYPES.every(type => RECORD_CORE.POLICY_TABLE[type].opportunityRequiredForNegative === true)
  && RECORD_CORE.OPPORTUNITY_TABLE.event === 'runtime-execution'
  && RECORD_CORE.OPPORTUNITY_TABLE.preference === 'exclusive-choice'
  && RECORD_CORE.OPPORTUNITY_TABLE.latent_state === 'utterance-slot'
  && RECORD_CORE.OPPORTUNITY_TABLE.relational === 'utterance-slot',
  RECORD_CORE.OPPORTUNITY_TABLE);

console.log('\n── frozen boundaries ──');
check('D1.capabilityTruthIsNotConfidenceOrApplication',
  wiredCalibration.describe().calibrationConfidence === null
  && wiredCalibration.describe().calibrationAppliedToLive === 'NO'
  && wiredCalibration.describe().attributionAuthorityAvailable === true);
check('D2.availabilityDoesNotMutateP4SampleCounts',
  wiredCalibration.inspectCalibration().view.partitionCount === 0
  && wiredCalibration.describe().counters.ingested === 0
  && wiredCalibration.describe().attributionAuthorityAvailable === true,
  wiredCalibration.describe().counters);

console.log('\nRESULT ' + (failed ? 'FAIL' : 'PASS') + ' · ' + passed + ' passed · ' + failed + ' failed');
if (failed) process.exitCode = 1;
