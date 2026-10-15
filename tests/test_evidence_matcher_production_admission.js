'use strict';

/* P5-B3-L · Evidence Matcher production admission.
   Isolated Home Node assembly + canonical Registry/Vault + deterministic port.
   No real network, browser, credential fallback, or durable matcher state. */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SERVICE = require(path.join(ROOT, 'services/home-node-service.js'));
const createCredentialVault = require(path.join(ROOT, 'active/credential-vault.js'));
const { createRuntimeOutcomeObservation } = require(path.join(ROOT, 'services/home-node/runtime-outcome-observation.js'));
const MATCH_CORE = require(path.join(ROOT, 'assets/js/memory-recall/evidence-match-core.js'));

const T0 = 1760000000000;
const CHARACTER_ID = 'p5b3l-character';
const CONVERSATION_ID = 'dm:p5b3l-character';
const CREDENTIAL_REF = 'p5b3l-vault-binding';
const SECRET = 'P5B3L-VAULT-SECRET-SENTINEL';
const ENDPOINT = 'https://canonical-provider.invalid/v1/chat/completions';
const MODEL = 'canonical-model';
const PROVIDER = 'canonical-provider';

function vaultFor(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const vault = createCredentialVault({ dataDir: dir });
  vault.load();
  vault.upsert(CREDENTIAL_REF, { provider: PROVIDER, apiKey: SECRET });
  vault.save();
}

function buildInstance(tag, opts) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-p5b3l-' + tag + '-'));
  const dataDir = path.join(root, 'home-node');
  const credentialDataDir = path.join(root, 'vault');
  if (!opts || opts.vault !== false) vaultFor(credentialDataDir);
  const calls = [];
  const logs = [];
  let modelOutput = (opts && opts.output) || '{"relation":"support"}';
  const port = {
    run: async function (request) {
      calls.push(request);
      return { ok: true, text: modelOutput };
    },
    runStream: async function () {
      return { ok: true, text: 'unused', streamed: false };
    }
  };
  const instance = SERVICE.buildHomeNode({
    dataDir: dataDir,
    credentialDataDir: credentialDataDir,
    token: 'p5b3l-test-token',
    port: port,
    clock: () => T0 + 5000,
    logger: function () { logs.push(JSON.stringify(Array.from(arguments))); },
    evidenceMatcherEnabled: !!(opts && opts.enabled),
    evidenceMatcherTimeoutMs: 50
  });
  instance.open();
  const published = instance.registry.putCharacter(CHARACTER_ID,
    { id: CHARACTER_ID, name: 'Matcher Admission Fixture', relationship: 'friend' },
    { provider: PROVIDER, model: MODEL, endpoint: ENDPOINT, credentialRef: CREDENTIAL_REF, systemPrompt: 'not sent to Matcher' });
  assert.equal(published.ok, true, 'canonical character/runtime spec is published');
  return {
    root: root,
    instance: instance,
    calls: calls,
    logs: logs,
    setOutput: function (value) { modelOutput = value; },
    close: function () {
      try { instance.close(); } catch (_) {}
      try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {}
    }
  };
}

let predictionSeq = 0;
function makePrediction(instance, kind, turnId) {
  predictionSeq += 1;
  const family = kind || 'relational';
  const spec = family === 'preference'
    ? {
        prediction: '用户更喜欢获得确认', predicate: { kind: 'prefers' },
        expectedOutcome: { kind: 'exclusive-outcome', token: 'pref.like.confirmation' }
      }
    : family === 'relational'
      ? {
          prediction: '我们的关系更亲近', predicate: { kind: 'relationship-state' },
          expectedOutcome: { kind: 'state-claim' }
        }
      : family === 'event'
        ? {
            prediction: '本轮执行会正常完成', predicate: { kind: 'will-occur' },
            expectedOutcome: { kind: 'exclusive-outcome', token: 'runtime.turn_terminal.completed' }
          }
        : {
            prediction: '用户现在有些不安 ' + predictionSeq, predicate: { kind: 'is-in-state' },
            expectedOutcome: { kind: 'state-claim' }
          };
  const projected = instance.runtimePredictionRegistry.projectFromValidatedExpectation(Object.assign({
    epistemicStatus: 'prediction',
    trigger: { kind: 'explicit-cue', label: '当前话题' },
    evidenceMemoryIds: ['matcher-fixture-memory'],
    contradictoryEvidenceIds: [],
    generalizationLevel: 'episode-hypothesis',
    subjectivePredictionConfidence: 0.6,
    subject: { kind: family === 'event' ? 'system' : 'user', label: '' }
  }, spec), {
    now: T0,
    characterId: CHARACTER_ID,
    conversationId: CONVERSATION_ID,
    turnId: turnId || ('matcher-turn-' + predictionSeq),
    expectationIndex: predictionSeq
  });
  assert.equal(projected.ok, true, 'P2 accepts the canonical fixture');
  return projected.record;
}

function mintStatementObservation(instance, prediction, sourceEventId, statement, targetDomain, observedAt) {
  const occurredAt = Number.isFinite(Number(observedAt)) ? Number(observedAt) : T0 + 1000;
  const observationRuntime = createRuntimeOutcomeObservation({
    registry: instance.runtimePredictionRegistry,
    isRealityEvent: () => false,
    attributionAuthority: instance.runtimeBehaviorEffect,
    clock: () => occurredAt
  });
  const minted = observationRuntime.mintObservation({
    producerId: 'linguistic-evidence',
    targetDomain: targetDomain || 'relationship',
    predictionRef: {
      predictionId: prediction.predictionId,
      opensAt: prediction.observationWindow.opensAt,
      closesAt: prediction.observationWindow.closesAt,
      predictionCreatedAt: prediction.createdAt
    },
    evidenceRefs: [sourceEventId],
    sourceEvent: {
      sourceEventId: sourceEventId,
      characterId: CHARACTER_ID,
      conversationId: CONVERSATION_ID,
      occurredAt: occurredAt,
      kind: 'statement',
      statement: statement,
      payload: {}
    }
  });
  assert.equal(minted.ok, true, 'existing P1 linguistic-evidence producer mints a canonical observation');
  return minted.observation;
}

function relationCount(settlement, relationName) {
  const trace = settlement && settlement.trace;
  if (!trace) return 0;
  if (relationName === 'applied') return Number(trace.matcherRelationsApplied) || 0;
  if (relationName === 'ambiguous') return Number(trace.matcherRelationsAmbiguous) || 0;
  if (relationName === 'irrelevant') return Number(trace.irrelevant) || 0;
  return 0;
}

(async function main() {
  const off = buildInstance('off', { enabled: false });
  const on = buildInstance('on', { enabled: true });
  const noVault = buildInstance('no-vault', { enabled: true, vault: false });
  try {
    const serviceSource = fs.readFileSync(path.join(ROOT, 'services/home-node-service.js'), 'utf8');
    assert.equal(SERVICE.EVIDENCE_MATCHER_ENABLED_DEFAULT, false);
    assert.ok(serviceSource.includes("enabled: process.env.IB_EVIDENCE_MATCHER_ENABLED === '1'"));
    assert.equal(off.instance.runtimeEvidenceMatcher.describe().matcherCapabilityPresent, true);
    assert.equal(off.instance.runtimeEvidenceMatcher.describe().enabled, false);
    assert.equal(off.instance.runtimeEvidenceMatcher.describe().productionSettleable, false);
    assert.equal(on.instance.runtimeEvidenceMatcher.describe().enabled, true);
    assert.equal(on.instance.runtimeEvidenceMatcher.describe().productionSettleable, true);
    console.log('PASS explicit policy enables production Matcher while the frozen default remains OFF');

    const disabledPrediction = makePrediction(off.instance, 'relational');
    const disabledObservation = mintStatementObservation(off.instance, disabledPrediction, 'off-source', '似乎有点不安');
    const disabledSettlement = await off.instance.runtimePredictionSettlement.settlePredictionWithEvidenceMatcher(
      disabledPrediction, [{ observation: disabledObservation }], { now: T0 + 2000 });
    assert.equal(off.calls.length, 0);
    assert.notEqual(disabledSettlement.settlement.state, 'matched');
    assert.ok(disabledSettlement.settlement.reasonCodes.includes('relation-unclassifiable-without-evidence-matcher'));
    console.log('PASS OFF keeps statement relation unclassifiable and makes zero model calls');

    const prediction = makePrediction(on.instance, 'relational');
    const observation = mintStatementObservation(on.instance, prediction, 'support-source', '看起来有些不安');
    const support = await on.instance.runtimePredictionSettlement.settlePredictionWithEvidenceMatcher(
      prediction, [{ observation: observation }], { now: T0 + 2000 });
    assert.equal(support.ok, true);
    assert.equal(on.calls.length, 1, JSON.stringify({
      matcher: on.instance.runtimeEvidenceMatcher.describe().counters,
      settlement: support.settlement && support.settlement.trace,
      reasonCodes: support.settlement && support.settlement.reasonCodes,
      observation: observation
    }));
    assert.equal(support.settlement.trace.matcherRelationsApplied, 1);
    assert.equal(support.settlement.trace.supportNonDecisive, 1);
    assert.equal(support.settlement.trace.supportDecisive, 0);
    assert.notEqual(support.settlement.state, 'matched', 'advisory support cannot auto-settle supporting linguistic evidence');
    const supportRequest = on.calls[0];
    assert.equal(supportRequest.spec.provider, PROVIDER);
    assert.equal(supportRequest.spec.model, MODEL);
    assert.equal(supportRequest.spec.endpoint, ENDPOINT);
    assert.equal(supportRequest.spec.apiKey, SECRET);
    assert.equal(JSON.stringify(supportRequest.prompt).includes(SECRET), false);
    assert.equal(JSON.stringify(observation).includes(SECRET), false);
    assert.equal(JSON.stringify(on.instance.runtimeEvidenceMatcher.describe()).includes(SECRET), false);
    assert.equal(on.logs.join('\n').includes(SECRET), false);
    console.log('PASS production P3 seam applies only the sealed support relation; source ceiling stays in force');

    on.setOutput('{"relation":"conflict"}');
    const conflictPrediction = makePrediction(on.instance, 'relational');
    const conflictObservation = mintStatementObservation(on.instance, conflictPrediction, 'conflict-source', '我没有表现出不安');
    const conflict = await on.instance.runtimePredictionSettlement.settlePredictionWithEvidenceMatcher(
      conflictPrediction, [{ observation: conflictObservation }], { now: T0 + 2000 });
    assert.equal(on.calls.length, 2);
    assert.equal(conflict.settlement.trace.matcherRelationsApplied, 1);
    assert.equal(conflict.settlement.trace.opportunityState, 'UNKNOWN');
    assert.notEqual(conflict.settlement.state, 'missed', 'LINGUISTIC_EVIDENCE cannot become decisive conflict');
    console.log('PASS conflict stays non-decisive; Matcher creates neither source authority nor Opportunity');

    const wrongDomainPrediction = makePrediction(on.instance, 'relational');
    const wrongDomainObservation = mintStatementObservation(on.instance, wrongDomainPrediction,
      'wrong-domain-source', '我更喜欢确认', 'user_preference');
    const wrongDomain = await on.instance.runtimePredictionSettlement.settlePredictionWithEvidenceMatcher(
      wrongDomainPrediction, [{ observation: wrongDomainObservation }], { now: T0 + 2000 });
    assert.equal(wrongDomainObservation.targetDomain, 'user_preference');
    assert.notEqual(wrongDomain.settlement.state, 'matched');
    assert.equal(wrongDomain.settlement.trace.supportDecisive, 0);
    console.log('PASS Matcher relation cannot rewrite or authorize a mismatched observation domain');

    on.setOutput('{"relation":"ambiguous"}');
    const ambiguousPrediction = makePrediction(on.instance, 'relational');
    const ambiguousObservation = mintStatementObservation(on.instance, ambiguousPrediction, 'ambiguous-source', '无法确认');
    const ambiguous = await on.instance.runtimePredictionSettlement.settlePredictionWithEvidenceMatcher(
      ambiguousPrediction, [{ observation: ambiguousObservation }], { now: T0 + 2000 });
    assert.equal(relationCount(ambiguous.settlement, 'ambiguous'), 1);
    assert.notEqual(ambiguous.settlement.state, 'matched');
    assert.notEqual(ambiguous.settlement.state, 'missed');

    on.setOutput('{"relation":"irrelevant"}');
    const irrelevantPrediction = makePrediction(on.instance, 'relational');
    const irrelevantObservation = mintStatementObservation(on.instance, irrelevantPrediction, 'irrelevant-source', '谈论另一个话题');
    const irrelevant = await on.instance.runtimePredictionSettlement.settlePredictionWithEvidenceMatcher(
      irrelevantPrediction, [{ observation: irrelevantObservation }], { now: T0 + 2000 });
    assert.equal(relationCount(irrelevant.settlement, 'irrelevant'), 1);
    assert.equal(irrelevant.settlement.supportSummary.decisive, 0);
    assert.equal(irrelevant.settlement.conflictSummary.decisive, 0);
    console.log('PASS ambiguous and irrelevant produce no decisive support/conflict');

    on.setOutput('{"relation":"support"}');
    const attackPrediction = makePrediction(on.instance, 'relational');
    const cleanAttackObservation = mintStatementObservation(on.instance, attackPrediction, 'payload-attack-source', '可能有些不安');
    const attackObservation = Object.assign({}, cleanAttackObservation, {
      provider: 'attacker-provider', model: 'attacker-model',
      endpoint: 'https://attacker.invalid', apiKey: 'ATTACKER_INLINE_KEY',
      credentialRef: 'attacker-vault-binding'
    });
    const attackResult = await on.instance.runtimeEvidenceMatcher.matchRelation(
      attackPrediction, attackObservation,
      { characterId: 'attacker-character', turnId: 'attacker-turn' });
    const attackRequest = on.calls[on.calls.length - 1];
    assert.equal(attackResult.match.relation, 'support');
    assert.equal(attackRequest.spec.provider, PROVIDER);
    assert.equal(attackRequest.spec.model, MODEL);
    assert.equal(attackRequest.spec.endpoint, ENDPOINT);
    assert.equal(attackRequest.spec.apiKey, SECRET);
    assert.equal(JSON.stringify(attackRequest.prompt).includes('ATTACKER_INLINE_KEY'), false);
    assert.equal(JSON.stringify(attackRequest.prompt).includes('attacker-provider'), false);
    assert.equal(JSON.stringify(attackRequest.prompt).includes('attacker-model'), false);
    assert.equal(JSON.stringify(attackRequest.prompt).includes('attacker.invalid'), false);
    assert.equal(JSON.stringify(attackRequest.prompt).includes('attacker-vault-binding'), false);
    console.log('PASS evidence credential fields and caller identity overrides are ignored');

    on.setOutput('{"relation":"support","settlementState":"missed","validated":true,"opportunity":"satisfied","source":"EXPLICIT_USER_REPORT","domain":"user_preference","predictionType":"preference","explicit":true}');
    const authorityAttackPrediction = makePrediction(on.instance, 'relational');
    const authorityAttackObservation = mintStatementObservation(on.instance, authorityAttackPrediction, 'authority-attack-source', '不确定');
    const authorityAttack = await on.instance.runtimePredictionSettlement.settlePredictionWithEvidenceMatcher(
      authorityAttackPrediction, [{ observation: authorityAttackObservation }], { now: T0 + 2000 });
    assert.equal(authorityAttack.settlement.trace.matcherRelationsAmbiguous, 1);
    assert.notEqual(authorityAttack.settlement.state, 'missed');
    console.log('PASS model authority fields collapse to ambiguous and do not change canonical P3 state');

    on.setOutput('{"relation":"support"}');
    const attemptBudgetPrediction = makePrediction(on.instance, 'relational', 'p3-attempt-budget-turn');
    const attemptBudgetObservations = [];
    for (let i = 0; i < 5; i += 1) {
      attemptBudgetObservations.push({ observation: mintStatementObservation(on.instance,
        attemptBudgetPrediction, 'attempt-budget-source-' + i, '同一回合 statement ' + i,
        'relationship', T0 + 1000 + i * 20) });
    }
    assert.equal(new Set(attemptBudgetObservations.map(x => x.observation.observationId)).size, 5);
    const beforeAttemptBudgetCalls = on.calls.length;
    const attemptBudget = await on.instance.runtimePredictionSettlement.settlePredictionWithEvidenceMatcher(
      attemptBudgetPrediction, attemptBudgetObservations, { now: T0 + 2000 });
    assert.equal(on.calls.length - beforeAttemptBudgetCalls, 4);
    assert.ok(on.instance.runtimeEvidenceMatcher.describe().counters.budgetDeniedPerAttempt >= 1);
    assert.equal(attemptBudget.settlement.trace.matcherRelationsAmbiguous, 1, JSON.stringify({
      trace: attemptBudget.settlement.trace,
      counts: attemptBudget.settlement.counts,
      reasons: attemptBudget.settlement.reasonCodes,
      matcher: on.instance.runtimeEvidenceMatcher.describe().counters,
      p3: on.instance.runtimePredictionSettlement.describe().counters
    }));

    const beforeTurnBudgetCalls = on.calls.length;
    let lastTurnBudget = null;
    for (let i = 0; i < 9; i += 1) {
      const p = makePrediction(on.instance, 'relational', 'p3-shared-turn-budget');
      const o = mintStatementObservation(on.instance, p, 'turn-budget-source-' + i, '跨预测同一 turn ' + i);
      lastTurnBudget = await on.instance.runtimePredictionSettlement.settlePredictionWithEvidenceMatcher(
        p, [{ observation: o }], { now: T0 + 2000 });
    }
    assert.equal(on.calls.length - beforeTurnBudgetCalls, 8);
    assert.ok(on.instance.runtimeEvidenceMatcher.describe().counters.budgetDeniedPerTurn >= 1);
    assert.equal(lastTurnBudget.settlement.trace.matcherRelationsAmbiguous, 1);
    console.log('PASS production P3 passes opaque per-attempt scope and canonical P2 turn identity to hard budgets');

    on.setOutput('{"relation":"support"}');
    const eventPrediction = makePrediction(on.instance, 'event');
    const eventObservation = mintStatementObservation(on.instance, eventPrediction, 'event-family-source', '本轮可能正常完成');
    const callsBeforeEvent = on.calls.length;
    await on.instance.runtimePredictionSettlement.settlePredictionWithEvidenceMatcher(
      eventPrediction, [{ observation: eventObservation }], { now: T0 + 2000 });
    assert.equal(on.calls.length, callsBeforeEvent, 'event family is never admitted to Matcher');
    console.log('PASS event/arbitrary family is excluded from the Matcher seam');

    const prefPrediction = makePrediction(on.instance, 'preference');
    const tokenObservation = require(path.join(ROOT, 'assets/js/memory-recall/outcome-observation-core.js')).buildOutcomeObservation({
      windowRef: {
        predictionId: prefPrediction.predictionId,
        predictionCreatedAt: prefPrediction.observationWindow.opensAt,
        opensAt: prefPrediction.observationWindow.opensAt,
        closesAt: prefPrediction.observationWindow.closesAt
      },
      source: 'LINGUISTIC_EVIDENCE', sourceInstance: 'runtime.interpretation-evidence',
      targetDomain: 'user_preference', observedAt: T0 + 1000, completeness: 'point',
      scope: prefPrediction.scope, outcomeRef: { kind: 'token', token: 'pref.like.confirmation' },
      evidenceRefs: ['pref-token-ref'],
      interventionContext: {
        behaviorEffectsInForce: [], predictionInfluencedSystem: null,
        contaminationClass: 'NONE', contaminationBasis: 'no intervention'
      }
    }).value;
    assert.ok(tokenObservation, 'preference token fixture is a canonical P1 observation');
    const callsBeforePreference = on.calls.length;
    await on.instance.runtimePredictionSettlement.settlePredictionWithEvidenceMatcher(
      prefPrediction, [{ observation: tokenObservation }], { now: T0 + 2000 });
    assert.equal(on.calls.length, callsBeforePreference, 'token relation stays mechanical');
    console.log('PASS preference token/mechanical relation takes priority over Matcher');

    const missingVaultPrediction = makePrediction(noVault.instance, 'relational');
    const missingVaultObservation = mintStatementObservation(noVault.instance, missingVaultPrediction, 'no-vault-source', '看起来不确定');
    const missingVault = await noVault.instance.runtimePredictionSettlement.settlePredictionWithEvidenceMatcher(
      missingVaultPrediction, [{ observation: missingVaultObservation }], { now: T0 + 2000 });
    assert.equal(noVault.calls.length, 0);
    assert.notEqual(missingVault.settlement.state, 'matched');
    assert.notEqual(missingVault.settlement.state, 'missed');
    assert.equal(fs.existsSync(path.join(noVault.root, 'vault', 'credential-vault.key')), false,
      'missing Vault preflight does not create a key');
    const noVaultPayloadAttack = await noVault.instance.runtimeEvidenceMatcher.matchRelation(
      missingVaultPrediction,
      Object.assign({}, missingVaultObservation, { apiKey: 'INLINE_FALLBACK', endpoint: 'https://attacker.invalid' }),
      {});
    assert.equal(noVaultPayloadAttack.match, null);
    assert.equal(noVault.calls.length, 0, 'no Vault means no provider call despite inline fallback fields');
    console.log('PASS unavailable Vault fails closed without inline-key/provider fallback or key creation');

    assert.equal(on.instance.runtimeRealityFeedback.describe().matcherSettlementPath, 'P3_MATCHER_AWARE_ENTRY');
    assert.equal(off.instance.runtimeRealityFeedback.describe().matcherSettlementPath, 'OFF');
    assert.ok(on.instance.runtimePredictionCalibration.describe().calibrationConfidence == null,
      'P4 confidence remains null/unset');
    console.log('PASS opt-in RealityEvent feedback reuses P3 matcher-aware seam; P4 confidence is not applied live');

    assert.equal(MATCH_CORE.MATCHER_ROLE, 'ADVISORY_SEMANTIC_CLASSIFIER_ONLY');
    assert.deepEqual(MATCH_CORE.RELATIONS.slice().sort(), ['ambiguous', 'conflict', 'irrelevant', 'support']);
    assert.equal(on.instance.runtimeEvidenceMatcher.describe().autoRetry, 'NONE');
    assert.equal(on.instance.runtimeEvidenceMatcher.describe().holder.maxEntries, 256);
    assert.equal(on.instance.runtimeEvidenceMatcher.describe().holder.ttlMs, 600000);
    assert.equal(on.instance.runtimeEvidenceMatcher.describe().holder.memoFailurePolicy, 'SUCCESS_AND_FAILURE');
    assert.equal(on.instance.runtimeEvidenceMatcher.describe().timeoutMs, 50);
    assert.deepEqual(on.instance.runtimeEvidenceMatcher.describe().budget, {
      perSettlementAttempt: 4, perPrediction: 4, perTurn: 8
    });
    console.log('PASS closed relation set, zero retry, bounded memo, and frozen call budgets');

    console.log('P5_B3_L_PRODUCTION_ADMISSION=LIVE');
    console.log('P5_B3_L_STATUS=COMPLETE');
  } finally {
    off.close();
    on.close();
    noVault.close();
  }
})().catch((error) => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
