'use strict';

/* P5-B3-L-R1 · canonical Home Node user message → existing P1/P3/Matcher.
   The only injected item is a canonical P2 fixture. Messages enter via the
   production chat-store writer; no P1 observation, evidence, or feedback is
   manually inserted. All model responses are deterministic local fixtures. */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SERVICE = require(path.join(ROOT, 'services/home-node-service.js'));
const createCredentialVault = require(path.join(ROOT, 'active/credential-vault.js'));
const CHAT_CORE = require(path.join(ROOT, 'assets/js/chat-core.js'));

const T0 = Date.now();
const CHARACTER_ID = 'ling-r1-character';
const CONVERSATION_ID = CHAT_CORE.conversationIdOf(CHARACTER_ID, '');
const CREDENTIAL_REF = 'ling-r1-vault-binding';
const SECRET = 'LING-R1-VAULT-SECRET-SENTINEL';
const ENDPOINT = 'https://canonical-provider.invalid/v1/chat/completions';
const MODEL = 'canonical-model';
const PROVIDER = 'canonical-provider';

let predictionSeq = 0;
function seedVault(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const vault = createCredentialVault({ dataDir: dir });
  vault.load();
  vault.upsert(CREDENTIAL_REF, { provider: PROVIDER, apiKey: SECRET });
  vault.save();
}

function buildInstance(tag, options) {
  const o = options || {};
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-ling-r1-' + tag + '-'));
  const credentialDataDir = path.join(root, 'vault');
  if (o.vault !== false) seedVault(credentialDataDir);
  let modelOutput = o.output || '{"relation":"support"}';
  const calls = [];
  const logs = [];
  const port = {
    run: async function (request) {
      calls.push(request);
      if (o.failProvider === true) throw new Error('synthetic provider failure');
      if (typeof o.outputForRequest === 'function') modelOutput = o.outputForRequest(request);
      return { ok: true, text: modelOutput };
    },
    runStream: async function () { return { ok: true, text: 'unused', streamed: false }; }
  };
  const instance = SERVICE.buildHomeNode({
    dataDir: path.join(root, 'home-node'),
    credentialDataDir: credentialDataDir,
    token: 'ling-r1-test-token',
    port: port,
    clock: () => T0 + 2000,
    logger: (...args) => logs.push(JSON.stringify(args)),
    evidenceMatcherEnabled: o.enabled === true,
    evidenceMatcherTimeoutMs: 50
  });
  instance.open();
  const published = instance.registry.putCharacter(CHARACTER_ID,
    { id: CHARACTER_ID, name: 'Linguistic Evidence Fixture', relationship: 'friend' },
    { provider: PROVIDER, model: MODEL, endpoint: ENDPOINT, credentialRef: CREDENTIAL_REF, systemPrompt: 'private system prompt' });
  assert.equal(published.ok, true);
  return {
    root: root,
    instance: instance,
    calls: calls,
    logs: logs,
    setOutput: value => { modelOutput = value; },
    close: function () {
      try { instance.close(); } catch (_) {}
      try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {}
    }
  };
}

function createPreferencePrediction(instance, turnId, expectationIndex) {
  predictionSeq += 1;
  const projected = instance.runtimePredictionRegistry.projectFromValidatedExpectation({
    epistemicStatus: 'prediction',
    prediction: '用户更喜欢 sci-fi',
    trigger: { kind: 'explicit-cue', label: '讨论电影类型时' },
    evidenceMemoryIds: ['fixture-memory'],
    contradictoryEvidenceIds: [],
    generalizationLevel: 'episode-hypothesis',
    subjectivePredictionConfidence: 0.6,
    subject: { kind: 'user', label: '' },
    predicate: { kind: 'prefers' },
    expectedOutcome: { kind: 'exclusive-outcome', token: 'pref.like.scifi' }
  }, {
    now: T0,
    characterId: CHARACTER_ID,
    conversationId: CONVERSATION_ID,
    turnId: turnId || ('ling-r1-turn-' + predictionSeq),
    expectationIndex: expectationIndex == null ? predictionSeq : expectationIndex
  });
  assert.equal(projected.ok, true, 'P2 registry creates the canonical preference Prediction fixture');
  return projected.record;
}

function canonicalUserMessage(id, content, extra) {
  return Object.assign({
    id: id,
    role: 'user',
    content: content,
    friendId: CHARACTER_ID,
    timestamp: T0 + 1000
  }, extra || {});
}

function writeCanonicalMessage(instance, message, requestId) {
  return instance.store.putMessage(message, { requestId: requestId });
}

async function settleMessage(instance, message, requestId) {
  const written = writeCanonicalMessage(instance, message, requestId);
  assert.equal(written.ok, true, 'canonical chat write succeeds independently of evidence processing');
  assert.equal(instance.store.getMessage(message.id).role, 'user');
  const idle = await instance.runtimeLinguisticEvidence.awaitIdle(1000);
  assert.equal(idle.idle, true, 'bounded linguistic producer settles its in-memory work');
  return written;
}

async function main() {
  const off = buildInstance('off', { enabled: false });
  const support = buildInstance('support', {
    enabled: true,
    outputForRequest: request => String(request.prompt.messages[0].content).includes('dislike')
      ? '{"relation":"conflict"}' : '{"relation":"support"}'
  });
  const conflict = buildInstance('conflict', { enabled: true, output: '{"relation":"conflict"}' });
  const ambiguous = buildInstance('ambiguous', { enabled: true, output: '{"relation":"ambiguous"}' });
  const providerFailure = buildInstance('provider-failure', { enabled: true, failProvider: true });
  const vaultUnavailable = buildInstance('vault-unavailable', { enabled: true, vault: false });
  const nodes = [off, support, conflict, ambiguous, providerFailure, vaultUnavailable];
  const eventCountBefore = SERVICE.runtimeRealityEvent.heldEventCount();
  try {
    const offPrediction = createPreferencePrediction(off.instance, 'off-turn', 1);
    const offMessage = canonicalUserMessage('desktop-user-off', 'I like sci-fi', {
      metadata: { provider: 'payload-provider', model: 'payload-model', endpoint: 'https://payload.invalid', apiKey: 'PAYLOAD_SECRET' },
      images: [{ dataUrl: 'data:image/png;base64,ATTACHMENT_SENTINEL' }]
    });
    await settleMessage(off.instance, offMessage, 'request-off');
    const offFacts = off.instance.runtimeLinguisticEvidence.describe();
    assert.equal(offFacts.counters.factsAccepted, 1, JSON.stringify(offFacts));
    assert.equal(offFacts.counters.observationsMinted, 1, JSON.stringify(offFacts));
    assert.equal(offFacts.source, 'LINGUISTIC_EVIDENCE');
    assert.equal(offFacts.targetDomain, 'user_preference');
    assert.equal(off.instance.runtimeEvidenceMatcher.describe().enabled, false);
    assert.equal(off.calls.length, 0);
    assert.equal(offFacts.counters.unclassifiableSettlements, 1);
    console.log('PASS canonical message creates a bounded P1 statement while Matcher OFF stays unclassifiable');

    const supportPrediction = createPreferencePrediction(support.instance, 'support-turn', 2);
    const supportMessage = canonicalUserMessage('desktop-user-support', 'I like sci-fi', {
      metadata: { apiKey: 'PAYLOAD_SECRET', provider: 'attacker-provider' },
      files: [{ name: 'unrelated.txt', text: 'NOT_FOR_MATCHER_HISTORY' }]
    });
    const memoryRevisionBefore = support.instance.memoryStore.getRevision();
    const reportMintsBefore = support.instance.runtimePreferenceReport.producer.describe().counters.minted;
    await settleMessage(support.instance, supportMessage, 'request-support');
    const supportFacts = support.instance.runtimeLinguisticEvidence.describe();
    assert.equal(support.calls.length, 1);
    assert.equal(supportFacts.counters.matcherRelationsApplied, 1);
    assert.equal(supportFacts.counters.supportNonDecisive, 1);
    assert.equal(supportFacts.counters.supportDecisive, 0);
    assert.equal(supportFacts.counters.matchedSettlements, 0);
    assert.equal(support.instance.runtimePredictionSettlement.describe().counters.missed, 0);
    const matcherPrompt = support.calls[0].prompt.messages[0].content;
    assert.ok(matcherPrompt.includes('I like sci-fi'));
    assert.equal(matcherPrompt.includes('PAYLOAD_SECRET'), false);
    assert.equal(matcherPrompt.includes('attacker-provider'), false);
    assert.equal(matcherPrompt.includes('private system prompt'), false);
    assert.equal(matcherPrompt.includes('NOT_FOR_MATCHER_HISTORY'), false);
    assert.equal(support.logs.join('\n').includes('PAYLOAD_SECRET'), false);
    assert.equal(support.instance.runtimeLinguisticEvidence.describe().counters.memoryWrites, 0);
    assert.equal(support.instance.memoryStore.getRevision(), memoryRevisionBefore);
    assert.equal(support.instance.runtimePreferenceReport.producer.describe().counters.minted, reportMintsBefore);
    console.log('PASS Matcher support remains non-decisive and receives only the bounded current statement');

    const offMessageBefore = offFacts.counters.factsAccepted;
    const replay = canonicalUserMessage('desktop-user-off', 'I like sci-fi', {
      metadata: { provider: 'payload-provider', model: 'payload-model', endpoint: 'https://payload.invalid', apiKey: 'PAYLOAD_SECRET' },
      images: [{ dataUrl: 'data:image/png;base64,ATTACHMENT_SENTINEL' }]
    });
    for (let i = 0; i < 100; i += 1) {
      const write = writeCanonicalMessage(off.instance, replay, 'request-off');
      assert.equal(write.ok, true);
    }
    await off.instance.runtimeLinguisticEvidence.awaitIdle(1000);
    assert.equal(off.instance.runtimeLinguisticEvidence.describe().counters.factsAccepted, offMessageBefore);
    assert.equal(off.instance.runtimeEvidenceMatcher.describe().counters.calls, 0);
    console.log('PASS 100 canonical store replays preserve one message fact and one observation');

    const conflictPrediction = createPreferencePrediction(conflict.instance, 'conflict-turn', 3);
    await settleMessage(conflict.instance,
      canonicalUserMessage('desktop-user-conflict', 'I dislike sci-fi'), 'request-conflict');
    const conflictFacts = conflict.instance.runtimeLinguisticEvidence.describe();
    assert.equal(conflict.calls.length, 1);
    assert.equal(conflictFacts.counters.matcherRelationsApplied, 1);
    assert.equal(conflictFacts.counters.conflictDecisive, 0);
    assert.equal(conflictFacts.counters.missedSettlements, 0);
    assert.equal(conflict.instance.runtimePredictionSettlement.describe().counters.missed, 0);
    console.log('PASS Matcher conflict cannot create opportunity or missed settlement');

    createPreferencePrediction(ambiguous.instance, 'ambiguous-turn', 4);
    await settleMessage(ambiguous.instance,
      canonicalUserMessage('desktop-user-ambiguous', 'I may like sci-fi'), 'request-ambiguous');
    assert.equal(ambiguous.instance.runtimeLinguisticEvidence.describe().counters.matcherRelationsAmbiguous, 1);
    assert.equal(ambiguous.instance.runtimeLinguisticEvidence.describe().counters.matchedSettlements, 0);
    console.log('PASS Matcher ambiguous remains non-decisive');

    createPreferencePrediction(providerFailure.instance, 'provider-failure-turn', 5);
    const providerWrite = await settleMessage(providerFailure.instance,
      canonicalUserMessage('desktop-user-provider-failure', 'I like sci-fi'), 'request-provider-failure');
    assert.equal(providerWrite.ok, true);
    assert.equal(providerFailure.instance.store.getMessage('desktop-user-provider-failure').role, 'user');
    assert.equal(providerFailure.instance.runtimeLinguisticEvidence.describe().counters.p3Failures, 0);
    assert.equal(providerFailure.instance.runtimeLinguisticEvidence.describe().counters.matcherRelationsAmbiguous, 1);
    assert.equal(providerFailure.instance.runtimeLinguisticEvidence.describe().counters.matchedSettlements, 0);
    console.log('PASS provider failure does not fail or rewrite the canonical user message');

    createPreferencePrediction(vaultUnavailable.instance, 'vault-failure-turn', 6);
    const vaultWrite = await settleMessage(vaultUnavailable.instance,
      canonicalUserMessage('desktop-user-vault-failure', 'I like sci-fi', { apiKey: 'INLINE_FALLBACK' }), 'request-vault-failure');
    assert.equal(vaultWrite.ok, true);
    assert.equal(vaultUnavailable.calls.length, 0);
    assert.equal(vaultUnavailable.instance.runtimeLinguisticEvidence.describe().counters.matchedSettlements, 0);
    assert.equal(fs.existsSync(path.join(vaultUnavailable.root, 'vault', 'credential-vault.key')), false);
    console.log('PASS unavailable Vault produces no fallback call and chat write remains successful');

    const unboundWrite = writeCanonicalMessage(support.instance,
      Object.assign({}, canonicalUserMessage('desktop-user-unbound', 'I like sci-fi'), { friendId: 'unknown-character' }),
      'request-unbound');
    assert.equal(unboundWrite.ok, true);
    await support.instance.runtimeLinguisticEvidence.awaitIdle(1000);
    assert.equal(support.instance.runtimeLinguisticEvidence.describe().counters.rejectedCharacter, 1);
    console.log('PASS unbound character message is not projected');

    assert.equal(SERVICE.runtimeRealityEvent.heldEventCount(), eventCountBefore,
      'linguistic evidence creates no RealityEvent');
    assert.equal(off.instance.runtimeRealityFeedback.counters.dispatchAttempted, 0);
    assert.equal(off.instance.runtimePredictionCalibration.describe().calibrationConfidence == null, true);
    assert.equal(off.instance.runtimeLinguisticEvidence.describe().durableEvidenceStore, 'NO');
    console.log('PASS no RealityEvent, Memory, Explicit Report, Opportunity, or live calibration side effect');

    console.log('FACTS RAW_CHAT_TO_STATEMENT_OBSERVATION = LIVE');
    console.log('FACTS CANONICAL_USER_MESSAGE_AUTHORITY_REUSED = YES');
    console.log('FACTS MATCHER_DEFAULT_CHANGED = NO');
    console.log('P5_B3_L_R1_STATUS=COMPLETE');
    console.log('P5_B3_L_R1_FREEZE=FROZEN');
  } finally {
    for (const node of nodes) node.close();
  }
}

main().catch(error => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
