'use strict';

/* P21-R4-M · Memory → bounded posture → shared response-guidance → Mobile
 * consumer. Pure fixtures and an isolated temporary chat DB; no installed
 * Home Node, Vault, Memory writes, or Prediction settlement changes. */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const createChatStore = require('../services/home-node/chat-store.js');
const createExecutor = require('../services/home-node/execution.js');
const RESPONSE = require('../assets/js/response-guidance-core.js');
const POSTURE = require('../assets/js/memory-recall/behavior-modulation-core.js');
const createBehaviorModulation = require('../services/home-node/runtime-behavior-modulation.js');
const createBehaviorEffect = require('../services/home-node/runtime-behavior-effect.js').createRuntimeBehaviorEffect;
const createRuntimeRecall = require('../services/home-node/runtime-recall.js').createRuntimeRecall;

let passed = 0, failed = 0;
function check(name, ok, detail) {
  if (ok) { passed += 1; console.log('PASS ' + name); }
  else { failed += 1; console.error('FAIL ' + name + (detail === undefined ? '' : ' · ' + JSON.stringify(detail))); }
}

const AXES = POSTURE.POSTURE_KEYS;
const BASELINE = Object.assign({}, POSTURE.BASELINE_POSTURE);
const IDENTITY = { characterId: 'char-r4m', conversationId: 'dm:char-r4m', requestId: 'req-r4m', turnId: 'turn-r4m' };
const RAW_MEMORY_SENTINEL = 'RAW_MEMORY_DO_NOT_DISCLOSE_71c2';

function relationSet() {
  return {
    anchorMemoryId: 'mem-old', support: [], complement: [], conflict: [], correction: ['mem-correction'],
    continuation: [], contextualize: [], unrelated: []
  };
}
function claim(scope, statement, evidenceMemoryIds) {
  return { scope: scope, statement: statement, evidenceMemoryIds: evidenceMemoryIds.slice() };
}
function evidenceInput(identity, options) {
  const o = options || {};
  const kRef = 'sha256-v1:reinterpretation-' + String(o.revision || 1);
  const lRef = 'sha256-v1:narrative-' + String(o.revision || 1);
  const ids = ['mem-old', 'mem-correction'];
  const meaning = {
    summary: o.summary || 'The earlier hurt remains historically real; a later correction is current evidence.',
    historicalFacts: [{ memoryId: ids[0], statement: 'A painful event occurred.' }],
    historicalEmotions: [{ memoryId: ids[0], statement: 'The character felt hurt at the time.' }],
    currentKnowledge: [{ memoryId: ids[1], statement: 'The earlier account was corrected.' }],
    currentBeliefs: [{ memoryId: ids[1], statement: o.currentBelief || 'The correction is acknowledged; trust can rebuild gradually.' }],
    uncertainty: o.uncertainty || 'medium'
  };
  const interpretationResult = {
    ok: true, status: 'succeeded', durable: false,
    autoPolicy: { enabled: true },
    contextualInterpretation: {
      schemaVersion: 'memory-reinterpretation-v1',
      authority: 'DERIVED_CURRENT_INTERPRETATION',
      durability: 'RUNTIME_ONLY',
      identity: { schemaVersion: 'memory-reinterpretation-v1', value: kRef },
      currentMeaning: meaning
    }
  };
  const interpretationTrace = {
    schemaVersion: 'memory-reinterpretation-v1', status: 'succeeded',
    directMemoryIds: ['mem-old'], associatedMemoryIds: ['mem-correction'],
    relationsUsed: [{ anchorMemoryId: 'mem-old', relatedMemoryId: 'mem-correction',
      relation: 'correction', basis: ['provenance_reference'], pairRole: 'anchor_candidate' }],
    tensionsUsed: [relationSet()],
    identity: { schemaVersion: 'memory-reinterpretation-v1', value: kRef }
  };
  const selfNarrative = {
    themes: [claim('relationship_with_user', 'A corrected understanding can preserve continuity.', ids)],
    currentBeliefs: [claim('self', o.narrativeBelief || 'Caution can coexist with accepting a correction.', ids)],
    relationshipBeliefs: [claim('relationship_with_user', 'Reliability is judged from present evidence over time.', ids)],
    unresolvedTensions: o.unresolved === true
      ? [claim('relationship_with_user', 'The unresolved hurt and the correction both matter.', ids)] : [],
    resolvedTensions: [claim('relationship_with_user', 'The correction changes the current interpretation.', ['mem-correction'])],
    turningPoints: [], continuityClaims: [], uncertainty: o.uncertainty || 'medium'
  };
  const selfNarrativeResult = {
    ok: true, status: o.revision > 1 ? 'revised' : 'created', durable: false,
    narrative: {
      schemaVersion: 'self-narrative-v1', authority: 'DERIVED_CURRENT_NARRATIVE',
      durability: 'SESSION_ONLY', version: Number(o.revision) || 1,
      identity: { schemaVersion: 'self-narrative-v1', value: lRef },
      evidenceMemoryIds: ids, interpretationRefs: [kRef], narrative: selfNarrative
    }
  };
  const selfNarrativeTrace = { schemaVersion: 'self-narrative-v1', status: selfNarrativeResult.status,
    identity: { schemaVersion: 'self-narrative-v1', value: lRef } };
  return Object.assign({}, identity, {
    currentTopic: 'Please respond to the current request.',
    reinterpretationResult: interpretationResult, reinterpretationTrace: interpretationTrace,
    selfNarrativeResult: selfNarrativeResult, selfNarrativeTrace: selfNarrativeTrace,
    rawMemoryBody: RAW_MEMORY_SENTINEL
  });
}

function makeHarness(options) {
  const o = options || {};
  let now = 5000;
  let calls = 0;
  const prompts = [];
  const attribution = o.attribution || createBehaviorEffect({ clock: function () { return now; }, logger: function () {} });
  const runtime = createBehaviorModulation({
    modelPort: { run: async function (request) {
      calls += 1;
      prompts.push(request.prompt.messages[0].content);
      if (o.timeout === true) return new Promise(function () {});
      const value = typeof o.output === 'function' ? o.output(request, calls) : (o.output || BASELINE);
      return { text: JSON.stringify(value) };
    } },
    registry: { getCharacterSpec: function () {
      return { provider: 'mock', model: 'posture-test', endpoint: 'http://provider.invalid', credentialRef: 'cred-r4m' };
    } },
    credentialAccess: { resolve: function () { return { ok: true, secret: 'test-secret' }; } },
    attributionAuthority: attribution,
    timeoutMs: o.timeoutMs || 800,
    clock: function () { return now; },
    logger: function () {}
  });
  return { runtime: runtime, attribution: attribution, calls: function () { return calls; }, prompts: prompts,
    advance: function (n) { now += n; } };
}

function guardedPosture() {
  return { warmth: 'reduced', trustPosture: 'guarded', initiative: 'baseline',
    interpersonalDistance: 'baseline', disclosureWillingness: 'reduced' };
}
function openPosture() {
  return { warmth: 'elevated', trustPosture: 'open', initiative: 'proactive',
    interpersonalDistance: 'reduced', disclosureWillingness: 'elevated' };
}
function mixedPosture() {
  return { warmth: 'baseline', trustPosture: 'guarded', initiative: 'restrained',
    interpersonalDistance: 'increased', disclosureWillingness: 'baseline' };
}
function makeSpec(systemPrompt) {
  return { provider: 'mock', model: 'posture-mobile-test', endpoint: 'http://provider.invalid/v1/chat/completions',
    apiKey: 'test-key', systemPrompt: systemPrompt };
}

async function mobileConsume(envelope, attribution) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-r4m-posture-e2e-'));
  const store = createChatStore({ dataDir: dataDir });
  store.open();
  const seen = [];
  const executor = createExecutor({
    store: store,
    port: { runStream: async function (request) {
      seen.push(request);
      return { text: 'A normal response to the current request.', reasoning: '', usage: null };
    } },
    characterRegistry: { getCharacterSpec: function () {
      return Object.assign({ id: IDENTITY.characterId }, makeSpec('Canonical persona. Keep established voice.'));
    } },
    clock: function () { return 5000; },
    turnIdFactory: function () { return IDENTITY.turnId; },
    logger: function () {},
    responseGuidanceProvider: function (identity, serverEnvelope) { return serverEnvelope; },
    responseGuidanceAttribution: {
      consumeExternalInfluence: function (input) { return attribution.consumeExternalInfluence(input); },
      markExternalInfluenceNotConsumed: function (input) { return attribution.markExternalInfluenceNotConsumed(input); }
    }
  });
  try {
    const result = await executor.executeCharacterTurn({
      requestId: IDENTITY.requestId,
      conversationId: IDENTITY.conversationId,
      characterId: IDENTITY.characterId,
      character: { id: IDENTITY.characterId, spec: makeSpec('Canonical persona. Keep established voice.') },
      userMessage: { id: 'msg-r4m', role: 'user', friendId: IDENTITY.characterId,
        threadId: null, content: 'Please answer my current question.', timestamp: 1000 },
      history: [],
      runtimeContextParts: { runtimeContext: 'Recall context.', memoryConsulted: true },
      responseGuidance: envelope,
      contextPolicy: 'r4m-posture-test'
    }, { timeoutMs: 1000 });
    return { result: result, seen: seen, store: store, dataDir: dataDir };
  } catch (error) {
    try { store.close(); } catch (_) {}
    const resolved = path.resolve(dataDir);
    if (resolved.startsWith(path.resolve(os.tmpdir()) + path.sep)) fs.rmSync(resolved, { recursive: true, force: true });
    throw error;
  }
}
function cleanupMobile(result) {
  try { result.store.close(); } catch (_) {}
  const resolved = path.resolve(result.dataDir);
  if (!resolved.startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error('refusing to remove non-test temp path');
  fs.rmSync(resolved, { recursive: true, force: true });
}

(async function main() {
  const corrected = makeHarness({ output: guardedPosture() });
  const correctedResult = await corrected.runtime.derive(evidenceInput(IDENTITY), { remainingBudgetMs: 500 });
  check('M1.oldHurtPlusCorrectionProducesMildGuardedPostureOnly',
    correctedResult.status === 'derived' && correctedResult.posture.trustPosture === 'guarded'
      && POSTURE.VALUES.trustPosture.indexOf('hostile') < 0
      && correctedResult.posture.initiative === 'baseline'
      && correctedResult.responseGuidance && correctedResult.responseGuidance.entries[0].guidanceKind === 'memory-behavior-posture-v1');

  const correctionPrompt = corrected.prompts[0] || '';
  const renderedCorrected = RESPONSE.renderBehaviorPosture(correctedResult.responseGuidance.entries[0].payload);
  check('M2.currentMeaningIsTheOnlyMemoryEvidenceAndNoRawMemoryIsDisclosed',
    correctionPrompt.includes('The earlier hurt remains historically real')
      && correctionPrompt.includes('The correction is acknowledged')
      && !correctionPrompt.includes(RAW_MEMORY_SENTINEL)
      && renderedCorrected.kind === 'PLACEMENT'
      && renderedCorrected.lines.join(' ').includes('non-hostile')
      && !renderedCorrected.lines.join(' ').includes('mem-old'));

  const reliable = makeHarness({ output: openPosture() });
  const reliableInput = evidenceInput(Object.assign({}, IDENTITY, { requestId: 'req-reliable', turnId: 'turn-reliable' }), {
    summary: 'Repeated reliable follow-through supports a more open current interpretation.',
    currentBelief: 'Reliable follow-through has been shown over time.',
    narrativeBelief: 'Present evidence supports greater openness.', uncertainty: 'low'
  });
  const reliableResult = await reliable.runtime.derive(reliableInput, { remainingBudgetMs: 500 });
  check('M3.sustainedReliableEvidenceCanOpenPosture',
    reliableResult.status === 'derived' && reliableResult.posture.trustPosture === 'open'
      && reliableResult.posture.initiative === 'proactive');

  const unresolved = makeHarness({ output: mixedPosture() });
  const tensionResult = await unresolved.runtime.derive(evidenceInput(Object.assign({}, IDENTITY, {
    requestId: 'req-tension', turnId: 'turn-tension'
  }), { unresolved: true, uncertainty: 'high', summary: 'A correction exists while an unresolved tension remains.' }), { remainingBudgetMs: 500 });
  check('M4.unresolvedTensionAllowsMixedButEveryAxisRemainsBounded',
    tensionResult.status === 'derived' && tensionResult.posture.trustPosture === 'guarded'
      && tensionResult.posture.initiative === 'restrained'
      && tensionResult.posture.interpersonalDistance === 'increased'
      && AXES.every(function (key) { return POSTURE.VALUES[key].includes(tensionResult.posture[key]); }));

  const revisions = makeHarness({ output: function (_, call) { return call === 1 ? guardedPosture() : openPosture(); } });
  const revisionOne = evidenceInput(Object.assign({}, IDENTITY, { requestId: 'req-revision', turnId: 'turn-revision' }), { revision: 1 });
  const revisionTwo = evidenceInput(Object.assign({}, IDENTITY, { requestId: 'req-revision', turnId: 'turn-revision' }), {
    revision: 2, summary: 'The correction and repeated follow-through now support a more open interpretation.',
    currentBelief: 'Repeated reliable follow-through has been established.',
    narrativeBelief: 'Current evidence supports openness.'
  });
  const revisionOneResult = await revisions.runtime.derive(revisionOne, { remainingBudgetMs: 500 });
  const revisionTwoResult = await revisions.runtime.derive(revisionTwo, { remainingBudgetMs: 500 });
  await revisions.runtime.derive(revisionTwo, { remainingBudgetMs: 500 });
  check('M5.R4KAndR4LRevisionChangesPostureAndIdenticalReplayDoesNotRecallProviderAgain',
    revisionOneResult.posture.trustPosture === 'guarded'
      && revisionTwoResult.posture.trustPosture === 'open'
      && revisions.calls() === 2);

  let associationCalls = 0, interpretationCalls = 0, narrativeCalls = 0, memoryListScans = 0;
  const chainAttr = createBehaviorEffect({ clock: function () { return 6000; }, logger: function () {} });
  const chainModulation = makeHarness({ output: guardedPosture(), attribution: chainAttr });
  const chainMemoryStore = {
    getMemorySettings: function () { return { ok: true, settings: { budget: 12000 } }; },
    listRecords: function () { memoryListScans += 1; throw new Error('second Memory scan is forbidden'); }
  };
  const oldRecord = { id: 'mem-old', title: 'public criticism', content: 'The public criticism caused hurt.',
    kind: 'episodic', source: 'user', created: 100, visibility: 'public', visibleTo: [], excludeFrom: [] };
  const correctionRecord = { id: 'mem-correction', title: 'public criticism correction',
    content: 'A later correction acknowledged the public criticism was unfair.',
    kind: 'episodic', source: 'user', created: 200, visibility: 'public', visibleTo: [], excludeFrom: [] };
  const chainMeaning = {
    summary: 'The earlier hurt remains real; the correction is current evidence.',
    historicalFacts: [{ memoryId: 'mem-old', statement: 'Public criticism occurred.' }],
    historicalEmotions: [{ memoryId: 'mem-old', statement: 'Hurt was experienced then.' }],
    currentKnowledge: [{ memoryId: 'mem-correction', statement: 'The criticism was corrected.' }],
    currentBeliefs: [{ memoryId: 'mem-correction', statement: 'A correction permits gradual rebuilding.' }],
    uncertainty: 'medium'
  };
  const chainKIdentity = 'sha256-v1:chain-k';
  const chainLIdentity = 'sha256-v1:chain-l';
  const chainRecall = createRuntimeRecall({
    memoryStore: chainMemoryStore,
    memoryRetrieval: { store: chainMemoryStore },
    registry: { getCharacterSpec: function () { return { relationship: 'character and user' }; } },
    associationRuntime: { expand: async function (binding) {
      associationCalls += 1;
      const edge = { anchorMemoryId: 'mem-old', relatedMemoryId: 'mem-correction', relation: 'correction',
        basis: ['provenance_reference'], pairRole: 'anchor_candidate' };
      return { ok: true, status: 'expanded', providerCalls: 1, memoHits: 0,
        result: { text: 'bounded association', expandedCount: 1, edges: [edge],
          tensionSets: [relationSet()], workingSet: [
            { memoryId: 'mem-old', activationReasons: ['direct_recall'], anchorMemoryIds: ['mem-old'] },
            { memoryId: 'mem-correction', activationReasons: ['association_correction'], anchorMemoryIds: ['mem-old'] }
          ] } };
    } },
    interpretation: {
      AUTO_INTERPRETATION_CHANNELS: ['chat'],
      runFromAuthoritativeRecall: async function (binding) {
        interpretationCalls += 1;
        return { ok: true, status: 'succeeded', durable: false, autoPolicy: { enabled: true },
          contextualInterpretation: { schemaVersion: 'memory-reinterpretation-v1',
            authority: 'DERIVED_CURRENT_INTERPRETATION', durability: 'RUNTIME_ONLY',
            identity: { schemaVersion: 'memory-reinterpretation-v1', value: chainKIdentity },
            currentMeaning: chainMeaning } };
      }
    },
    selfNarrative: { runFromValidatedInterpretation: async function (binding) {
      narrativeCalls += 1;
      const ids = ['mem-old', 'mem-correction'];
      const narrative = {
        themes: [], currentBeliefs: [claim('self', 'The correction is part of the present view.', ids)],
        relationshipBeliefs: [claim('relationship_with_user', 'Trust can rebuild over time.', ids)],
        unresolvedTensions: [], resolvedTensions: [claim('relationship_with_user', 'The correction changes current meaning.', ['mem-correction'])],
        turningPoints: [], continuityClaims: [], uncertainty: 'medium'
      };
      return { ok: true, status: 'created', durable: false,
        narrative: { schemaVersion: 'self-narrative-v1', authority: 'DERIVED_CURRENT_NARRATIVE',
          durability: 'SESSION_ONLY', version: 1,
          identity: { schemaVersion: 'self-narrative-v1', value: chainLIdentity },
          evidenceMemoryIds: ids, interpretationRefs: [chainKIdentity], narrative: narrative },
        trace: { schemaVersion: 'self-narrative-v1', status: 'created',
          identity: { schemaVersion: 'self-narrative-v1', value: chainLIdentity } } };
    } },
    behaviorModulation: chainModulation.runtime,
    clock: function () { return 6000; }, logger: function () {}
  });
  const chainRequestId = 'req-existing-recall-chain', chainConversationId = 'dm:chain-role';
  const chainTurnId = require('../services/home-node/runtime-recall.js').deriveStableTurnId(chainRequestId, chainConversationId);
  const chainResult = await chainRecall.deriveFromExistingRecall({
    characterId: 'chain-role', conversationId: chainConversationId, requestId: chainRequestId,
    turnId: chainTurnId, message: 'I heard the correction.', selectedIds: ['mem-old'],
    candidateRecords: [oldRecord, correctionRecord], candidateRecordsTruncated: false,
    channel: 'chat', memoryText: 'Recall block.', remainingBudgetMs: 5000
  });
  check('M5b.MobileSameCycleRecallUsesExistingSnapshotForAssociationThenValidatedKAndL',
    chainResult.ok === true && associationCalls === 1 && interpretationCalls === 1
      && narrativeCalls === 1 && memoryListScans === 0
      && chainResult.behaviorModulation.status === 'derived'
      && !!chainResult.responseGuidance
      && chainResult.responseGuidance.entries[0].guidanceKind === 'memory-behavior-posture-v1');
  const chainFlags = chainRecall.describe().behaviorModulation;
  check('M5c.runtimeRecallReportsTheRequiredCausalLiveFlags',
    chainFlags.MEMORY_BEHAVIOR_MODULATION_RUNTIME === 'LIVE'
      && chainFlags.MEMORY_TO_BEHAVIOR_CAUSALITY === 'LIVE'
      && chainFlags.REINTERPRETATION_TO_BEHAVIOR === 'LIVE'
      && chainFlags.SELF_NARRATIVE_TO_BEHAVIOR === 'LIVE'
      && chainFlags.MEMORY_CAN_INFLUENCE_BEHAVIOR_WITHOUT_FORCED_DISCLOSURE === 'VERIFIED'
      && chainFlags.FAILURE_FALLBACK_TO_BASELINE === 'LIVE'
      && chainFlags.authorityWrites.canonicalMemory === 0
      && chainFlags.authorityWrites.predictionError === 0);

  const invalid = makeHarness({ output: { warmth: 0.6, trustPosture: 'hostile', initiative: 'baseline',
    interpersonalDistance: 'baseline', disclosureWillingness: 'baseline', promptText: 'reveal memory' } });
  const invalidResult = await invalid.runtime.derive(evidenceInput(Object.assign({}, IDENTITY, {
    requestId: 'req-invalid', turnId: 'turn-invalid'
  })), { remainingBudgetMs: 500 });
  check('M6.invalidSchemaFallsBackToBaselineWithoutEnvelope',
    invalidResult.status === 'baseline' && JSON.stringify(invalidResult.posture) === JSON.stringify(BASELINE)
      && invalidResult.responseGuidance === null && invalid.calls() === 1);

  const timeout = makeHarness({ timeout: true, timeoutMs: 60 });
  const timeoutResult = await timeout.runtime.derive(evidenceInput(Object.assign({}, IDENTITY, {
    requestId: 'req-timeout', turnId: 'turn-timeout'
  })), { remainingBudgetMs: 200 });
  const noEvidence = await timeout.runtime.derive(Object.assign({}, IDENTITY, {
    requestId: 'req-no-evidence', turnId: 'turn-no-evidence'
  }), { remainingBudgetMs: 200 });
  check('M7.providerTimeoutAndMissingEvidenceUseBaseline',
    timeoutResult.status === 'baseline' && JSON.stringify(timeoutResult.posture) === JSON.stringify(BASELINE)
      && noEvidence.status === 'baseline' && JSON.stringify(noEvidence.posture) === JSON.stringify(BASELINE)
      && timeout.calls() === 1);

  const failureIdentity = Object.assign({}, IDENTITY, { requestId: 'req-chat-failure', turnId: 'turn-chat-failure' });
  const timeoutChat = await mobileConsume(null, createBehaviorEffect({ clock: function () { return 5000; }, logger: function () {} }));
  check('M8.providerFailureDoesNotBlockNormalMobileChat',
    timeoutChat.result.ok === true && timeoutChat.seen.length === 1
      && timeoutChat.seen[0].prompt.system.includes('Canonical persona.')
      && timeoutChat.seen[0].prompt.system.includes('Recall context.'),
    { result: timeoutChat.result, system: timeoutChat.seen[0] && timeoutChat.seen[0].prompt.system });
  cleanupMobile(timeoutChat);

  const desktopAttribution = createBehaviorEffect({ clock: function () { return 7000; }, logger: function () {} });
  const desktopHarness = makeHarness({ output: guardedPosture(), attribution: desktopAttribution });
  const desktopInput = evidenceInput(Object.assign({}, IDENTITY, { requestId: 'req-desktop', turnId: 'turn-desktop' }));
  const desktopResult = await desktopHarness.runtime.derive(desktopInput, { remainingBudgetMs: 500 });
  const desktopSnapshot = desktopAttribution.snapshotBehaviorEffectAttribution({
    characterId: desktopInput.characterId, conversationId: desktopInput.conversationId,
    turnId: desktopInput.turnId, at: 7000
  });
  check('M9.DesktopReceiptIsUnverifiedAndFailsClosedToUnknownPartial',
    !!desktopResult.responseGuidance && desktopSnapshot.status === 'unknown'
      && desktopSnapshot.coverage === 'partial'
      && desktopSnapshot.externalInfluences[0].state === 'REGISTERED'
      && desktopSnapshot.contaminationFacts.predictionInfluencedSystem !== false);

  const mobileAttr = createBehaviorEffect({ clock: function () { return 5000; }, logger: function () {} });
  const mobileHarness = makeHarness({ output: guardedPosture(), attribution: mobileAttr });
  const mobilePosture = await mobileHarness.runtime.derive(evidenceInput(IDENTITY), { remainingBudgetMs: 500 });
  const mobileTurn = await mobileConsume(mobilePosture.responseGuidance, mobileAttr);
  const mobileSnapshot = mobileAttr.snapshotBehaviorEffectAttribution({
    characterId: IDENTITY.characterId, conversationId: IDENTITY.conversationId,
    turnId: IDENTITY.turnId, at: 5000
  });
  const mobilePromptSystem = String(mobileTurn.seen[0] && mobileTurn.seen[0].prompt.system || '');
  check('M10.MobilePromptUsesSharedGuidanceAfterPersonaAndRecordsVerifiedConsumption',
    mobileTurn.result.ok === true && mobilePromptSystem.indexOf('Canonical persona.') >= 0
      && mobilePromptSystem.indexOf('Recall context.') > mobilePromptSystem.indexOf('Canonical persona.')
      && mobilePromptSystem.indexOf('单轮行为基调') > mobilePromptSystem.indexOf('Canonical persona.')
      && mobilePromptSystem.includes('OOC/integrity constraints')
      && mobileSnapshot.externalInfluences.length === 1
      && mobileSnapshot.externalInfluences[0].state === 'CONSUMED'
      && mobileSnapshot.effects.length === 0,
    { posture: mobilePosture, result: mobileTurn.result, system: mobilePromptSystem, snapshot: mobileSnapshot });
  cleanupMobile(mobileTurn);

  const status = mobileHarness.runtime.describe();
  const writes = status.authorityWrites;
  check('M11.postureIsDerivedTemporaryTurnScopedBoundedAndAllMutationAssertionsRemainZero',
    status.runtime === 'LIVE' && status.derived === true && status.temporary === true
      && status.turnScoped === true && status.bounded === true
      && status.maxModelCallsPerCognitionCycle === 1
      && writes.canonicalMemory === 0 && writes.relationship === 0 && writes.persona === 0
      && writes.emotionalState === 0 && writes.selfNarrative === 0
      && writes.predictionError === 0 && writes.activeMessageSchedule === 0);

  console.log('\nMEMORY BEHAVIOR MODULATION PRODUCT E2E · ' + passed + ' passed, ' + failed + ' failed');
  if (failed) process.exit(1);
})().catch(function (error) {
  console.error('UNCAUGHT ' + String((error && error.stack) || error));
  process.exit(1);
});
