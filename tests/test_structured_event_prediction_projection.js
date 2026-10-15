'use strict';
/* P5-B3-G2 · narrowed terminal event candidate → canonical P2 projection shape */

const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const CORE = require(path.join(ROOT, 'assets/js/memory-recall/expectation-shadow-core.js'));
const P2 = require(path.join(ROOT, 'assets/js/memory-recall/prediction-record-core.js'));
const P1 = require(path.join(ROOT, 'assets/js/memory-recall/outcome-observation-core.js'));
const PROJECTION = require(path.join(ROOT, 'services/home-node/runtime-structured-expectation.js'));
const WIRING = require('./helpers/activation-wiring-probe.js');
const fs = require('node:fs');

let passed = 0;
let failed = 0;
const check = (name, condition, detail) => {
  if (condition) { passed += 1; console.log('  PASS  ' + name); return; }
  failed += 1; console.error('  FAIL  ' + name + (detail === undefined ? '' : '  -> ' + JSON.stringify(detail)));
};
const section = name => console.log('\n── ' + name + ' ──');
const P = (key, value) => console.log('  FACTS ' + key + ' = ' + value);
const T0 = 1760000000000;
const SCOPE = { characterId: 'char_g2', conversationId: 'dm:char_g2', turnId: 'turn_runtime_only' };
const TOKEN = code => 'runtime.turn_terminal.' + code;

function validate(structuredPrediction) {
  return CORE.validateResponse({
    items: [{
      prediction: '这次执行可能达到指定终局',
      trigger: { kind: 'explicit-cue', label: '当前执行回合' },
      evidenceMemoryIds: ['memory_g2'],
      contradictoryEvidenceIds: [],
      generalizationLevel: 'episode-hypothesis',
      subjectivePredictionConfidence: 0.6,
      structuredPrediction: structuredPrediction
    }]
  }, { allowedMemoryIds: ['memory_g2'], terminalOutcomeCodes: P1.DIRECTIONAL_TURN_TERMINAL_OUTCOME_CODES });
}

const projection = PROJECTION.createRuntimeStructuredExpectationProjection({});
const project = candidate => projection.projectItem(candidate, SCOPE);

(function main() {
  section('candidate schema and canonical terminal vocabulary');
  {
    const request = CORE.buildRequest({
      records: [{ id: 'memory_g2', meaning: 'executed turn evidence', affect: 'neutral' }],
      selectedIds: ['memory_g2'],
      terminalOutcomeCodes: P1.DIRECTIONAL_TURN_TERMINAL_OUTCOME_CODES
    });
    const valid = validate({ kind: 'event', eventFamily: 'turn_terminal', expectedOutcome: 'completed' });
    const item = valid.items[0];
    check('A1.eventIsAValidatedCandidateNotAnAuthorityRecord',
      CORE.STRUCTURED_CANDIDATE_VERSION === 'structured-expectation-candidate/v2'
      && item.structuredPrediction.kind === 'event'
      && item.structuredPrediction.eventFamily === 'turn_terminal'
      && item.structuredPrediction.expectedOutcome === 'completed'
      && item.structuredPrediction.token === undefined
      && item.structuredPrediction.predictionId === undefined,
      item.structuredPrediction);
    check('A2.runtimePromptUsesTheP1RecognizedOutcomeList',
      request.envelope.requestedSchema.items[0].structuredPrediction.indexOf('completed|credential-unavailable') >= 0
      && request.envelope.requestedSchema.items[0].structuredPrediction.indexOf('provider-error') >= 0
      && request.envelope.requestedSchema.items[0].structuredPrediction.indexOf('runtime.turn_terminal.') < 0
      && JSON.stringify(projection.terminalOutcomeCodes()) === JSON.stringify(P1.DIRECTIONAL_TURN_TERMINAL_OUTCOME_CODES),
      request.envelope.requestedSchema.items[0].structuredPrediction);
  }

  section('runtime-only token grammar and P2 TYPE_TABLE');
  {
    const item = validate({ kind: 'event', eventFamily: 'turn_terminal', expectedOutcome: 'completed' }).items[0];
    const result = project(item);
    const expectation = result.expectation;
    const derived = P2.derivePredictionType({
      subject: expectation.subject,
      predicate: expectation.predicate,
      expectedOutcome: expectation.expectedOutcome
    });
    check('B1.runtimeCreatesOnlyTheCanonicalTerminalToken',
      result.ok === true
      && result.projection.token === TOKEN('completed')
      && result.projection.targetDomain === 'runtime_state'
      && result.projection.mechanism === 'exclusive_outcome'
      && expectation.expectedOutcome.token === TOKEN('completed'),
      result);
    check('B2.fixedRuntimeShapeIsDerivedAsP2Event',
      JSON.stringify(expectation.subject) === '{"kind":"system","label":""}'
      && JSON.stringify(expectation.predicate) === '{"kind":"will-occur"}'
      && expectation.expectedOutcome.kind === 'exclusive-outcome'
      && derived.ok === true && derived.predictionType === 'event'
      && P2.deriveContradictionMode('event', expectation.expectedOutcome.kind) === 'exclusive_outcome',
      { expectation: expectation, derived: derived });
    check('B3.onlyPreferenceAndOneTerminalFamilyAreProductionTypes',
      JSON.stringify(PROJECTION.G2_PRODUCTION_PROJECTION_TYPES) === '["preference","event:runtime.turn_terminal"]'
      && project(validate({ kind: 'event', eventFamily: 'arbitrary_event', expectedOutcome: 'completed' }).items[0]).ok === false
      && project(validate({ kind: 'relational', targetKey: 'x', stance: 'like' }).items[0]).reasonCode === 'production-type-not-enabled');
  }

  section('unknown, malformed, free-text, and authority fields fail closed');
  {
    const unknownOutcome = project(validate({ kind: 'event', eventFamily: 'turn_terminal', expectedOutcome: 'provider-custom' }).items[0]);
    const directToken = project(validate({ kind: 'event', eventFamily: 'turn_terminal', expectedOutcome: TOKEN('completed') }).items[0]);
    const malformed = validate({ kind: 'event', eventFamily: 'turn_terminal', expectedOutcome: { code: 'completed' } }).items[0];
    const authority = validate({
      kind: 'event', eventFamily: 'turn_terminal', expectedOutcome: 'completed',
      predictionId: 'pred_attacker', characterId: 'char_other', conversationId: 'dm:other',
      turnId: 'turn_other', targetDomain: 'user_preference', mechanism: 'matcher'
    }).items[0];
    const freeText = validate(null).items[0];
    check('C1.unknownOrModelSuppliedTokenIsRefused',
      unknownOutcome.ok === false && unknownOutcome.reasonCode === 'invalid-terminal-outcome'
      && directToken.ok === false && directToken.reasonCode === 'invalid-terminal-outcome',
      { unknown: unknownOutcome.reasonCode, directToken: directToken.reasonCode });
    check('C2.malformedFamilyPayloadAndAuthorityFieldsYieldZeroCandidate',
      malformed.structuredPrediction === null
      && malformed.structuredPredictionRejection === 'structured-candidate-invalid-event-outcome'
      && authority.structuredPrediction === null
      && authority.structuredPredictionRejection === 'structured-candidate-authority-fields-stripped'
      && freeText.structuredPrediction === null,
      { malformed: malformed.structuredPredictionRejection,
        authority: authority.structuredPredictionRejection, freeText: freeText.structuredPrediction });
    check('C3.P2RegistryWriteRemainsOneExistingRuntimeCallSite', (function () {
      const source = WIRING.stripJsComments(fs.readFileSync(path.join(ROOT, 'services/home-node/runtime-expectation.js'), 'utf8'));
      return (source.match(/predictionRegistry\.projectFromValidatedExpectation\s*\(/g) || []).length === 1
        && source.indexOf('resolveActiveExecutionTurnBinding') >= 0
        && source.indexOf('predictionTurnId = text(activeBinding.turnId)') >= 0;
    })());
  }

  P('EVENT_PROJECTION_FAMILY', 'runtime.turn_terminal');
  P('TYPE_TABLE', 'SOLE P2 TYPE AUTHORITY');
  P('MODEL_MAY_DEFINE_TERMINAL_TOKEN', 'NO');
  P('FREE_TEXT_TO_EVENT_PREDICTION', 'FORBIDDEN');
  P('G2_PRODUCTION_PROJECTION_TYPES', JSON.stringify(PROJECTION.G2_PRODUCTION_PROJECTION_TYPES));
  console.log('\nRESULT ' + (failed ? 'FAIL' : 'PASS') + ' · ' + passed + ' passed · ' + failed + ' failed');
  if (failed) process.exitCode = 1;
})();
