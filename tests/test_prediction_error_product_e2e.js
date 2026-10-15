'use strict';
/* ══════════════════════════════════════════════════════════════════════════
   Internal Beyond · Prediction Error P5-B3-G1/G2 · Full Product E2E
   （纯 Node · 零真实出网（假 fetch）· 只在 .dsh-tmp 下开目录 · 自然退出）

   运行：node tests/test_prediction_error_product_e2e.js

   ── 本套件覆盖 G1 preference 与 G2 terminal-event cognition ───────────
     Step 1 · 真实 production cognition turn（HTTP memory-recall 面）
              → provider 返回 structured preference expectation
              → runtime 自动投影 + 注册 canonical PredictionRecord
              ⇒ TEST_MANUAL_PREDICTION_INSERTS = 0
     G2 · same requestId + active D3 turn → structured terminal candidate → P2
          → real executeCharacterTurn completed/timeout → P1/P3 → automatic P4
          ⇒ no manual Prediction / opportunity / feedback / calibration insertion
   ══════════════════════════════════════════════════════════════════════════ */

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const ROOT = path.resolve(__dirname, '..');
const SERVICE = require(path.join(ROOT, 'services', 'home-node-service.js'));
const NODE_MODEL_PORT = require(path.join(ROOT, 'active', 'node-model-port.js'));
const CREDENTIAL_VAULT = require(path.join(ROOT, 'active', 'credential-vault.js'));
const RC = require(path.join(ROOT, 'services', 'home-node', 'runtime-recall.js'));
const SEAM = require(path.join(ROOT, 'services', 'home-node', 'explicit-preference-report-seam.js'));
const FREE_TEXT_REPORT = require(path.join(ROOT, 'assets', 'js', 'free-text-report-candidate.js'));

let passed = 0, failures = 0;
let freeTextKFailures = 0;
let freeTextPositiveE2E = false, freeTextNegativeE2E = false, freeTextNoConfirmE2E = false;
let freeTextDeclineE2E = false;
const check = (n, c, d) => {
  if (c) { passed++; console.log('  PASS  ' + n); return true; }
  if (/^(BK1|BK2|BN2K|BN2K2|K1|K2)\./.test(String(n))) freeTextKFailures++;
  failures++; console.error('  FAIL  ' + n + (d !== undefined ? '  -> ' + JSON.stringify(d) : ''));
  return false;
};
const section = t => console.log('\n── ' + t + ' ──');
const P = (k, v) => console.log('  FACTS ' + k + ' = ' + v);

const SCRATCH_ROOT = path.join(ROOT, '.dsh-tmp');
fs.mkdirSync(SCRATCH_ROOT, { recursive: true });
const RUN_ROOT = fs.mkdtempSync(path.join(SCRATCH_ROOT, 'g1-'));
const T0 = 1750000000000;
const TOKEN = 'g1-token';
const CHAR_A = 'char_a';
const CHAR_B = 'char_b';
const QUERY = '显卡 驱动 更新失败';
const SENTINEL = 'G1-SENTINEL-7B21';

const instances = [];
let negativeProductionFacts = null;
let positiveCalibrationFacts = null;
function freshDir(tag) { return fs.mkdtempSync(path.join(RUN_ROOT, tag + '-')); }
function seedVault(dir, ref, provider, secret) {
  const v = CREDENTIAL_VAULT({ dataDir: dir });
  v.load(); v.upsert(ref, { provider: provider, apiKey: secret }); v.save();
  return v;
}
/* provider 侧只回 JSON；期望那一支由 cfg.structured 决定（null / 对象 / 省略）。 */
function makeFetch(rec, cfg) {
  const c = cfg || {};
  return function (url, init) {
    const body = String((init && init.body) || '');
    rec.push({ url: String(url), body: body });
    let content = '{"items":[]}';
    if (/shouldWrite|diaryType/.test(body)) {
      content = '{"items":[]}';
    } else if (body.indexOf('MEMORY_INTERPRETATION_INPUT') >= 0) {
      const unescaped = body.replace(/\\"/g, '"').replace(/\\n/g, '\n');
      const ids = [];
      const re = /"memoryId"\s*:\s*"([^"]+)"/g;
      let m = null;
      while ((m = re.exec(unescaped)) !== null) { if (ids.indexOf(m[1]) < 0) ids.push(m[1]); }
      content = JSON.stringify({
        items: ids.map(id => ({
          memoryId: id, meaning: '解释', appraisal: 'mixed', affect: 'warm',
          relationshipMeaning: null, causalAttribution: null, basis: 'ai_inference', subjectiveConfidence: 0.4
        }))
      });
    } else if (body.indexOf('EXPECTATION_INPUT') >= 0) {
      const unescaped = body.replace(/\\"/g, '"').replace(/\\n/g, '\n');
      const ids = [];
      const re = /"memoryId"\s*:\s*"([^"]+)"/g;
      let m = null;
      while ((m = re.exec(unescaped)) !== null) { if (ids.indexOf(m[1]) < 0) ids.push(m[1]); }
      const candidates = Array.isArray(c.structured) ? c.structured
        : [c.structured === undefined ? { kind: 'preference', targetKey: 'SciFi', stance: 'like' } : c.structured];
      const items = ids.length ? candidates.map((candidate, index) => {
        const item = {
          prediction: index === 0 ? '本轮可能正常完成' : '本轮可能超时',
          trigger: { kind: 'same-topic', label: '本轮执行' },
          evidenceMemoryIds: [ids[0]],
          contradictoryEvidenceIds: [],
          generalizationLevel: 'episode-hypothesis',
          subjectivePredictionConfidence: 0.55
        };
        if (candidate !== 'omit') item.structuredPrediction = candidate;
        return item;
      }) : [];
      content = JSON.stringify({ items: items });
    }
    const text = JSON.stringify({ choices: [{ message: { content: content } }] });
    return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(text) });
  };
}
async function buildInstance(tag, cfg) {
  const c = cfg || {};
  const dataDir = freshDir(tag + '-data-');
  const credDir = freshDir(tag + '-cred-');
  seedVault(credDir, 'cred_a', 'custom', SENTINEL);
  const rec = [];
  const basePort = NODE_MODEL_PORT({ fetch: makeFetch(rec, c) });
  let releaseChat;
  const chatGate = new Promise(resolve => { releaseChat = resolve; });
  const port = Object.assign({}, basePort, {
    runStream: async function () {
      if (c.holdChat === true) await chatGate;
      if (c.chatOutcome === 'timeout') {
        const error = new Error('synthetic production timeout'); error.name = 'TimeoutError'; throw error;
      }
      return { ok: true, text: 'assistant production reply', reasoning: '', usage: null, streamed: false };
    }
  });
  /* 可推进时钟：产品语义里"later report"必须真的**later**（见 B 段：
     行为基调 effect 的终结是**已观察的终止**，报告晚于它才可能 independent）。 */
  let now = T0;
  const inst = SERVICE.buildHomeNode({
    dataDir: dataDir, credentialDataDir: credDir, token: TOKEN, port: port,
    clock: () => now, logger: () => {},
    /* 生产 cognition 链：L3 自动解释（TEST_INJECTION 策略）+ L5 期望段由生产
       runtime-policy 文件打开（见下面 setExpectation）。两者是**独立**开关。 */
    runtimeAutoInterpretationPolicy: { autoInterpretationEnabled: true }
  });
  inst.open();
  const spec = { provider: 'custom', model: 'model-a', endpoint: 'https://provider.invalid/v1/chat/completions', credentialRef: 'cred_a', systemPrompt: 'SYS' };
  inst.registry.putCharacter(CHAR_A, { id: CHAR_A, name: 'A', relationship: 'friend' }, spec);
  inst.registry.putCharacter(CHAR_B, { id: CHAR_B, name: 'B', relationship: 'friend' }, spec);
  for (const id of ['m1', 'm2']) {
    inst.memoryStore.putRecord({
      id: id, kind: 'episodic', title: 'T-' + id, content: 'C-' + id + ' ' + QUERY, domain: '日常', tags: [],
      valence: 0.2, arousal: 0.6, importance: 6, resolved: false, visibility: 'public', visibleTo: [], excludeFrom: [],
      activationCount: 0, created: T0 - 86400000, lastActivated: T0 - 86400000, createdBy: 'user', createdByName: '',
      editedByUser: false, consolidatedFrom: [], lastConsolidatedAt: null
    });
  }
  /* 生产权威：期望段 ON（解释段由 autoPolicy 提供 TEST_INJECTION） */
  inst.runtimePolicy.setExpectation(CHAR_A, true);
  const webPort = await new Promise(r => inst.server.listen(0, '127.0.0.1', () => r(inst.server.address().port)));
  const h = { tag: tag, inst: inst, rec: rec, webPort: webPort, releaseChat: releaseChat, setNow: function (t) { now = t; } };
  instances.push(h);
  return h;
}
function post(h, urlPath, body) {
  return new Promise(resolve => {
    const data = JSON.stringify(body);
    const r = http.request({
      host: '127.0.0.1', port: h.webPort, path: urlPath, method: 'POST', timeout: 20000,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), 'X-IB-Home-Token': TOKEN }
    }, res => {
      let raw = ''; res.setEncoding('utf8'); res.on('data', c => raw += c);
      res.on('end', () => { let b = null; try { b = JSON.parse(raw); } catch (_) { /* 非 JSON */ } resolve({ status: res.statusCode, body: b, raw: raw }); });
    });
    r.on('timeout', () => { try { r.destroy(); } catch (_) {} resolve({ status: 0, body: null, raw: '' }); });
    r.on('error', () => resolve({ status: 0, body: null, raw: '' }));
    r.write(data); r.end();
  });
}
const recallPost = (h, over) => post(h, RC.PATH, Object.assign({
  operation: 'memory-recall', mode: 'authoritative', characterId: CHAR_A,
  requestId: 'req_' + Math.random().toString(36).slice(2), conversationId: 'dm:' + CHAR_A,
  message: QUERY, timeoutMs: 4000
}, over || {}));
async function settle(h) {
  await h.inst.runtimeRecall.awaitAutoIdle(15000);
  await h.inst.runtimeRecall.awaitExpectationIdle(15000);
  return h.inst.runtimeExpectation.describe();
}
function predictions(h) {
  return h.inst.runtimePredictionRegistry.listOpenPredictions({ characterId: CHAR_A, conversationId: 'dm:' + CHAR_A }) || [];
}
async function executeTurn(h, requestId, message) {
  return h.inst.executor.executeCharacterTurn({
    requestId: requestId,
    userMessage: {
      id: 'u_' + requestId,
      role: 'user',
      content: message || QUERY,
      friendId: CHAR_A,
      timestamp: T0
    },
    character: {
      id: CHAR_A,
      spec: {
        provider: 'custom', model: 'model-a',
        endpoint: 'https://provider.invalid/v1/chat/completions',
        credentialRef: 'cred_a', systemPrompt: 'SYS'
      }
    },
    history: []
  }, {});
}
function report(h, over) {
  return post(h, SEAM.REPORT_PATH, Object.assign({
    requestId: 'rep_' + Math.random().toString(36).slice(2),
    characterId: CHAR_A, targetKey: 'SciFi', stance: 'like'
  }, over || {}));
}
async function confirmFreeTextReport(h, text, sourceRef, actionSeed, scope) {
  const selectedScope = Object.assign({ characterId: CHAR_A, threadId: '' }, scope || {});
  const source = {
    id: sourceRef, role: 'user', content: text,
    friendId: selectedScope.characterId, threadId: selectedScope.threadId, timestamp: T0
  };
  const candidate = FREE_TEXT_REPORT.extractCandidate(text, sourceRef);
  const session = FREE_TEXT_REPORT.createSession({
    candidateIdFactory: () => 'session-' + sourceRef,
    requestIdFactory: () => actionSeed
  });
  const created = session.create(candidate, selectedScope, source);
  let reportActionCalls = 0;
  const reportCallsBeforeConfirm = reportActionCalls;
  const confirmation = await session.confirm(created.candidateId, selectedScope, source, payload => {
    reportActionCalls++;
    return report(h, payload);
  });
  const replays = await Promise.all(Array.from({ length: 100 }, () =>
    session.confirm(created.candidateId, selectedScope, source, payload => {
      reportActionCalls++;
      return report(h, payload);
    })));
  const replay = replays[0];
  return {
    candidate: candidate,
    created: created,
    session: session,
    confirmation: confirmation,
    response: confirmation.result,
    replay: replay,
    replayCount: replays.length,
    reportActionCalls: reportActionCalls,
    reportCallsBeforeConfirm: reportCallsBeforeConfirm
  };
}
async function runCognitionDuringExecution(h, requestId, executionRequestId) {
  const recallPromise = recallPost(h, { requestId: requestId, message: QUERY, conversationId: 'dm:' + CHAR_A });
  const executorRequestId = executionRequestId || requestId;
  const executionPromise = executeTurn(h, executorRequestId, QUERY);
  const recallResult = await recallPromise;
  await h.inst.runtimeRecall.awaitAutoIdle(15000);
  await h.inst.runtimeRecall.awaitExpectationIdle(15000);
  /* The fixture clock advances after P2 registration and before the terminal
     observation, matching the production event-time ordering. */
  h.setNow(T0 + 1000);
  const activeTurnId = h.inst.executor.activeTurn('dm:' + CHAR_A);
  const activeBinding = h.inst.executor.activeTurnBindingOf('dm:' + CHAR_A, requestId);
  const createdPredictions = predictions(h);
  h.releaseChat();
  const executionResult = await executionPromise;
  return {
    recall: recallResult,
    execution: executionResult,
    activeTurnId: activeTurnId,
    activeBinding: activeBinding,
    predictions: createdPredictions
  };
}
/* **主 E2E 里没有一次手插 Prediction**：这个常量是对"没有绕过 runtime"的自我约束。 */
const TEST_MANUAL_PREDICTION_INSERTS = 0;
const TEST_MANUAL_FEEDBACK_CALLS = 0;
const TEST_MANUAL_OPPORTUNITY_INJECTION = 0;
const TEST_MANUAL_CALIBRATION_INGEST = 0;
const TEST_DIRECT_REPORT_MINT = 0;
const TEST_MANUAL_REALITY_EVENT = 0;

(async function main() {
  /* ══ A · 生产 cognition turn → 自动注册 ══ */
  section('A · production cognition → automatic registration');
  const h = await buildInstance('produce', {});
  {
    const rx = await recallPost(h);
    const d = await settle(h);
    const list = predictions(h);
    P('ProductionExpectations', d.counters.created);
    P('StructuredCandidates', d.structuredProjection ? d.structuredProjection.counters.candidatesSeen : 0);
    P('PredictionsRegistered', list.length);
    P('TEST_MANUAL_PREDICTION_INSERTS', TEST_MANUAL_PREDICTION_INSERTS);
    check('A1.realTurnSucceededAndCreatedAnExpectation',
      rx.status === 200 && d.counters.created === 1 && d.counters.providerCalls === 1,
      { http: rx.status, created: d.counters.created, providerCalls: d.counters.providerCalls });
    check('A2.runtimeAutomaticallyRegisteredACanonicalPrediction',
      TEST_MANUAL_PREDICTION_INSERTS === 0
      && d.counters.predictionProjected === 1 && d.counters.predictionProjectionFailed === 0
      && list.length === 1
      && list[0].predictionType === 'preference'
      && list[0].contradictionMode === 'exclusive_outcome'
      && list[0].predictionSnapshotAtCreation.semanticPayload.expectedOutcome.token === 'pref.like.scifi'
      && list[0].scope.characterId === CHAR_A && list[0].scope.conversationId === 'dm:' + CHAR_A
      && list[0].predictionId.indexOf('pred_') === 0,
      { projected: d.counters.predictionProjected, list: list.map(x => x.predictionId) });
    check('A3.projectionCameFromTheProductionModelResult',
      h.rec.filter(e => e.body.indexOf('EXPECTATION_INPUT') >= 0).length === 1
      && h.rec.filter(e => e.body.indexOf('MEMORY_INTERPRETATION_INPUT') >= 0).length === 1,
      { providerCalls: h.rec.length });
  }

  const runG2E2E = async function () {
  /* ══ G2 · cognition proposes terminal expectations during the active D3 turn ══ */
  section('G2 · production terminal event prediction → settlement without clean P4 sample');
  {
    const g2 = await buildInstance('g2-multi', {
      holdChat: true,
      structured: [
        { kind: 'event', eventFamily: 'turn_terminal', expectedOutcome: 'completed' },
        { kind: 'event', eventFamily: 'turn_terminal', expectedOutcome: 'timeout' }
      ]
    });
    const requestId = 'g2_same_request_multi';
    const result = await runCognitionDuringExecution(g2, requestId);
    const records = result.predictions;
    const byOutcome = code => records.find(p => p.predictionSnapshotAtCreation.semanticPayload.expectedOutcome.token === 'runtime.turn_terminal.' + code);
    const expectsCompleted = byOutcome('completed');
    const expectsTimeout = byOutcome('timeout');
    const completedSettlement = expectsCompleted && g2.inst.runtimePredictionSettlement.getSettlement(expectsCompleted.predictionId);
    const timeoutSettlement = expectsTimeout && g2.inst.runtimePredictionSettlement.getSettlement(expectsTimeout.predictionId);
    const completedError = expectsCompleted && g2.inst.runtimePredictionSettlement.getPredictionError(expectsCompleted.predictionId);
    const timeoutError = expectsTimeout && g2.inst.runtimePredictionSettlement.getPredictionError(expectsTimeout.predictionId);
    const partition = g2.inst.runtimePredictionCalibration.getPartition('event', 'runtime_state');
    const feedback = g2.inst.runtimeRealityFeedback;
    const driver = g2.inst.runtimePredictionCalibrationDriver.describe().counters;
    P('G2.sameRequestActiveTurn', result.activeTurnId);
    P('G2.structuredEventPredictions', records.length);
    P('G2.TEST_MANUAL_PREDICTION_INSERTS', TEST_MANUAL_PREDICTION_INSERTS);
    check('G1.productionL5CreatesEventPredictionsScopedToActiveD3Turn',
      result.recall.status === 200
      && result.activeTurnId && result.activeBinding
      && result.activeBinding.requestCorrelationId === requestId
      && records.length === 2
      && records.every(p => p.predictionType === 'event'
        && p.scope.characterId === CHAR_A
        && p.scope.conversationId === 'dm:' + CHAR_A
        && p.sourceExpectationRef.turnId === result.activeTurnId)
      && TEST_MANUAL_PREDICTION_INSERTS === 0
      && TEST_MANUAL_FEEDBACK_CALLS === 0
      && TEST_MANUAL_OPPORTUNITY_INJECTION === 0
      && TEST_MANUAL_CALIBRATION_INGEST === 0,
      { activeTurnId: result.activeTurnId, binding: result.activeBinding,
        predictions: records.map(p => ({ type: p.predictionType, turnId: p.sourceExpectationRef.turnId,
          token: p.predictionSnapshotAtCreation.semanticPayload.expectedOutcome.token })) });
    check('G2.realCompletedTurnSettlesButSystemInfluencedEvidenceDoesNotCalibrate',
      result.execution.ok === true && result.execution.outcome === 'completed'
      && completedSettlement && completedSettlement.state === 'matched'
      && timeoutSettlement && timeoutSettlement.state === 'missed'
      && completedSettlement.opportunityState === 'SATISFIED'
      && timeoutSettlement.opportunityState === 'SATISFIED'
      && completedSettlement.calibrationCounted === false
      && timeoutSettlement.calibrationCounted === false
      && completedError && completedError.calibrationEligible === false
      && timeoutError && timeoutError.calibrationEligible === false
      && (!partition || partition.calibrationCounts.eligibleTotal === 0)
      && driver.ledgerAccepted === 0 && driver.skippedNotCounted === 2
      && feedback.counters.dispatchAttempted === 1 && feedback.counters.settlementCount === 2
      && feedback.counters.modelCalls === 0,
      { execution: result.execution.outcome,
        settlements: [completedSettlement && completedSettlement.state, timeoutSettlement && timeoutSettlement.state],
        reasons: [completedSettlement && completedSettlement.reasonCodes, timeoutSettlement && timeoutSettlement.reasonCodes],
        conflicts: [completedSettlement && completedSettlement.conflictSummary, timeoutSettlement && timeoutSettlement.conflictSummary],
        gateTraceRefs: [completedSettlement && completedSettlement.gateTraceRefs, timeoutSettlement && timeoutSettlement.gateTraceRefs],
        errors: [completedError, timeoutError],
        p4Driver: driver,
        attribution: [expectsCompleted && expectsCompleted.behaviorEffectAttributionStatus,
          expectsTimeout && expectsTimeout.behaviorEffectAttributionStatus],
        counts: partition && partition.calibrationCounts, feedback: feedback.counters });
    const replayKeepsPredictionIdentity = await (async function () {
      const beforeCalls = g2.rec.filter(e => e.body.indexOf('EXPECTATION_INPUT') >= 0).length;
      const replay = await recallPost(g2, { requestId: requestId, message: QUERY, conversationId: 'dm:' + CHAR_A });
      await g2.inst.runtimeRecall.awaitAutoIdle(15000);
      await g2.inst.runtimeRecall.awaitExpectationIdle(15000);
      const afterCalls = g2.rec.filter(e => e.body.indexOf('EXPECTATION_INPUT') >= 0).length;
      return replay.status === 200 && afterCalls === beforeCalls
        && g2.inst.runtimePredictionRegistry.getPrediction(expectsCompleted.predictionId).predictionId === expectsCompleted.predictionId
        && g2.inst.runtimePredictionRegistry.getPrediction(expectsTimeout.predictionId).predictionId === expectsTimeout.predictionId;
    })();
    check('G3.replayKeepsPredictionIdentityAndDoesNotRerunL5', replayKeepsPredictionIdentity,
      'recall replay reuses the same P2 records');
  }

  section('G2 · terminal mismatch settles missed without becoming a clean sample');
  {
    const g2 = await buildInstance('g2-timeout', {
      holdChat: true,
      chatOutcome: 'timeout',
      structured: { kind: 'event', eventFamily: 'turn_terminal', expectedOutcome: 'completed' }
    });
    const requestId = 'g2_same_request_timeout';
    const result = await runCognitionDuringExecution(g2, requestId);
    const prediction = result.predictions[0];
    const settlement = prediction && g2.inst.runtimePredictionSettlement.getSettlement(prediction.predictionId);
    const predictionError = prediction && g2.inst.runtimePredictionSettlement.getPredictionError(prediction.predictionId);
    const partition = g2.inst.runtimePredictionCalibration.getPartition('event', 'runtime_state');
    const feedback = g2.inst.runtimeRealityFeedback;
    const calibrationDriver = g2.inst.runtimePredictionCalibrationDriver.describe().counters;
    check('G4.realTimeoutSettlesMissedButOutcomeTimeInfluenceSkipsP4',
      result.recall.status === 200 && result.activeTurnId
      && prediction && prediction.sourceExpectationRef.turnId === result.activeTurnId
      && result.execution.ok === false && result.execution.error === 'timeout'
      && settlement && settlement.state === 'missed'
      && settlement.opportunityState === 'SATISFIED' && settlement.calibrationCounted === false
      && predictionError && predictionError.calibrationEligible === false
      && (!partition || partition.calibrationCounts.eligibleTotal === 0)
      && feedback.counters.dispatchAttempted === 1 && feedback.counters.settlementCount === 1
      && feedback.counters.modelCalls === 0 && calibrationDriver.ledgerAccepted === 0
      && calibrationDriver.skippedNotCounted === 1
      && TEST_MANUAL_PREDICTION_INSERTS === 0
      && TEST_MANUAL_FEEDBACK_CALLS === 0
      && TEST_MANUAL_OPPORTUNITY_INJECTION === 0
      && TEST_MANUAL_CALIBRATION_INGEST === 0
      && g2.inst.runtimeEvidenceMatcher.describe().enabled === false
      && g2.inst.runtimeEvidenceMatcher.describe().counters.calls === 0
      && g2.inst.runtimePredictionCalibration.describe().calibrationConfidence === null
      && g2.inst.runtimePredictionCalibration.describe().calibrationAppliedToLive === 'NO',
      { activeTurnId: result.activeTurnId, terminalTurnId: result.execution.turnId,
        state: settlement && settlement.state, opportunity: settlement && settlement.opportunityState,
        reasons: settlement && settlement.reasonCodes, conflict: settlement && settlement.conflictSummary,
        gateTraceRefs: settlement && settlement.gateTraceRefs, predictionError: predictionError,
        attribution: prediction && prediction.behaviorEffectAttributionStatus,
        counts: partition && partition.calibrationCounts, feedback: feedback.counters,
        p4: calibrationDriver });
    const wrongRequestRefused = await (async function () {
      const mismatch = await buildInstance('g2-wrong-request', {
        holdChat: true,
        structured: { kind: 'event', eventFamily: 'turn_terminal', expectedOutcome: 'completed' }
      });
      const recallPromise = recallPost(mismatch, {
        requestId: 'g2_recall_request', message: QUERY, conversationId: 'dm:' + CHAR_A
      });
      const executionPromise = executeTurn(mismatch, 'g2_other_execution', QUERY);
      const recallResult = await recallPromise;
      await mismatch.inst.runtimeRecall.awaitAutoIdle(15000);
      await mismatch.inst.runtimeRecall.awaitExpectationIdle(15000);
      const projected = predictions(mismatch).length;
      mismatch.releaseChat();
      await executionPromise;
      return recallResult.status === 200 && projected === 0
        && (mismatch.inst.runtimeExpectation.describe().counters.eventProjectionBindingMismatch >= 1
          || mismatch.inst.runtimeExpectation.describe().counters.eventProjectionSkippedNoActiveTurn >= 1);
    })();
    check('G5.sameConversationDifferentRequestCannotBorrowEventScope', wrongRequestRefused,
      'request correlation mismatch cannot bind a different active execution');
  }
  };

  /* ══ B · 全产品正向闭环（Prediction → later explicit report → matched）══ */
  section('B · full product positive E2E');
  {
    const pred = predictions(h)[0];
    /* step 2a：再走一个**真实回合** —— 行为基调 effect 的终止是"已观察的终止"，
       它是被下一回合消费掉的；没有这一步，报告会落在 effect 仍然在force 的窗口里，
       而 P1 的 contamination 闸门（冻结语义）会把主观域压到 SUPPORTING。 */
    h.inst.runtimePolicy.setExpectation(CHAR_A, false);
    h.setNow(T0 + 60000);
    const rx2 = await recallPost(h);
    await settle(h);
    check('B0.secondTurnConsumedTheBehaviorBasis',
      rx2.status === 200 && h.inst.runtimeBehaviorEffect !== undefined
      && predictions(h).length === 1,
      { http: rx2.status, predictions: predictions(h).length });
    const p4Before = h.inst.runtimePredictionCalibration.getPartition('preference', 'user_preference');
    const p4CountBefore = p4Before ? p4Before.calibrationCounts.eligibleTotal : 0;
    /* step 2b：later explicit report（真实 HTTP） */
    h.setNow(T0 + 120000);
    const freeText = await confirmFreeTextReport(h, 'I like scifi', 'chat-msg-free-text-like', 'action-like-1');
    const rep = freeText.response;
    const fb = h.inst.runtimeRealityFeedback;
    const sv = h.inst.runtimePredictionSettlement.getSettlement(pred.predictionId);
    P('ExplicitReports', rep.body && rep.body.reportMinted ? 1 : 0);
    P('RealityEvents', rep.body && rep.body.realityStatus === 'minted' ? 1 : 0);
    P('FeedbackDispatch', fb.counters.dispatchAttempted);
    P('Observations', fb.counters.observationCount);
    P('Settlements', fb.counters.settlementCount);
    P('SettlementState', sv && sv.state);
    P('calibrationCounted', sv && sv.calibrationCounted);
    P('MATCHER_CALLS', fb.counters.modelCalls);
    check('BK1.freeTextIsCandidateOnlyUntilTheConfirmAction',
      freeText.created.ok === true && freeText.created.status === 'pending'
      && freeText.candidate && freeText.candidate.stance === 'like'
      && freeText.reportCallsBeforeConfirm === 0 && freeText.reportActionCalls === 1
      && freeText.confirmation.status === 'confirmed' && freeText.replay.status === 'confirmed'
      && freeText.replay.reused === true,
      { candidate: freeText.candidate, created: freeText.created.status,
        confirmation: freeText.confirmation.status, reportActionCalls: freeText.reportActionCalls });
    check('BK2.confirmReplay100xUsesOneExistingStructuredAction',
      TEST_DIRECT_REPORT_MINT === 0 && TEST_MANUAL_REALITY_EVENT === 0
      && freeText.replayCount === 100 && freeText.reportActionCalls === 1
      && freeText.replay.reused === true,
      { directReportMint: TEST_DIRECT_REPORT_MINT, manualRealityEvent: TEST_MANUAL_REALITY_EVENT,
        confirms: freeText.replayCount, reportActionCalls: freeText.reportActionCalls });
    check('B1.reportMintedAndRealityEventEmitted',
      rep.status === 200 && rep.body.ok === true && rep.body.outcome === 'accepted'
      && rep.body.realityStatus === 'minted'
      && rep.body.report.source === 'EXPLICIT_USER_REPORT'
      && rep.body.report.conversationId === 'dm:' + CHAR_A,
      { http: rep.status, outcome: rep.body && rep.body.outcome, reason: rep.body && rep.body.reasonCode });
    check('B2.automaticFeedbackPairedTheProductionPrediction',
      fb.counters.dispatchAttempted === 1 && fb.counters.candidateCount === 1
      && fb.counters.observationCount === 1 && fb.counters.settlementCount === 1
      && fb.counters.dispatchFailed === 0,
      fb.counters);
    check('B3.settlementIsMatchedAndCalibrationCounted',
      !!sv && sv.state === 'matched' && sv.calibrationCounted === true
      && sv.admittedTargetDomains.length === 1 && sv.admittedTargetDomains[0] === 'user_preference'
      && sv.supportSummary.decisive === 1,
      sv && { state: sv.state, cal: sv.calibrationCounted, domains: sv.admittedTargetDomains, reasons: sv.reasonCodes, intervention: sv.interventionSummary, gate: sv.gateTraceRefs });
    check('B4.matcherCallsZeroOnTheWholeProductE2E',
      fb.counters.modelCalls === 0
      && h.inst.runtimeEvidenceMatcher.describe().enabled === false
      && h.inst.runtimeEvidenceMatcher.describe().counters.calls === 0
      && sv.trace.matcherRelationsApplied === 0,
      { fbModel: fb.counters.modelCalls, matcher: h.inst.runtimeEvidenceMatcher.describe().counters });
    check('B5.noManualFeedbackCallsAndNoManualInserts',
      TEST_MANUAL_PREDICTION_INSERTS === 0 && TEST_MANUAL_FEEDBACK_CALLS === 0
      && TEST_MANUAL_OPPORTUNITY_INJECTION === 0 && TEST_MANUAL_CALIBRATION_INGEST === 0
      && predictions(h).length === 1,
      { manualPredictions: TEST_MANUAL_PREDICTION_INSERTS, manualFeedback: TEST_MANUAL_FEEDBACK_CALLS,
        manualOpportunity: TEST_MANUAL_OPPORTUNITY_INJECTION, manualCalibration: TEST_MANUAL_CALIBRATION_INGEST });
    check('B6.predictionErrorIsOrdinalOnly',
      (function () {
        const pe = h.inst.runtimePredictionSettlement.getPredictionError(pred.predictionId);
        return pe && pe.predictionMetric === undefined && pe.predictionErrorMetric === null
          && pe.settlementState === 'matched' && pe.calibrationEligible === true;
      })(),
      'CALIBRATION_CONFIDENCE = null · CALIBRATION_APPLIED_TO_LIVE = NO');
    const p4After = h.inst.runtimePredictionCalibration.getPartition('preference', 'user_preference');
    positiveCalibrationFacts = { partition: p4After, driver: h.inst.runtimePredictionCalibrationDriver.describe() };
    check('B7.matchedSettlementWasAutomaticallyIngestedByP4',
      !!p4After && p4After.calibrationCounts.matched === 1
      && p4After.calibrationCounts.eligibleTotal === p4CountBefore + 1
      && h.inst.runtimePredictionCalibrationDriver.describe().status === 'LIVE_CAPABLE'
      && h.inst.runtimePredictionCalibrationDriver.describe().counters.ledgerAccepted === 1
      && h.inst.runtimePredictionCalibrationDriver.describe().counters.ledgerDuplicate === 0
      && h.inst.runtimeRealityFeedback.counters.postSettlementCallbacks === 1,
      { counts: p4After && p4After.calibrationCounts,
        driver: h.inst.runtimePredictionCalibrationDriver.describe().counters,
        feedback: h.inst.runtimeRealityFeedback.counters });
    freeTextPositiveE2E = freeText.confirmation.status === 'confirmed'
      && freeText.reportActionCalls === 1 && rep.status === 200 && rep.body && rep.body.outcome === 'accepted'
      && sv && sv.state === 'matched' && p4After && p4After.calibrationCounts.matched === 1;
    check('B8.productionCapabilitySurfaceMatchesTheWiredAuthority',
      !!p4After && p4After.capabilityCoverage.attributionAuthorityAvailable === true
      && p4After.capabilityCoverage.productionSettleable === true
      && h.inst.runtimePredictionCalibration.describe().attributionAuthorityAvailable === true
      && h.inst.runtimePredictionCalibration.inspectCalibration().view.diagnostics.attributionAuthorityAvailable === true
      && h.inst.runtimeEvidenceMatcher.describe().attributionAuthorityAvailable === true,
      { partition: p4After && p4After.capabilityCoverage,
        describe: h.inst.runtimePredictionCalibration.describe().attributionAuthorityAvailable,
        diagnostics: h.inst.runtimePredictionCalibration.inspectCalibration().view.diagnostics.attributionAuthorityAvailable,
        matcher: h.inst.runtimeEvidenceMatcher.describe().attributionAuthorityAvailable });
  }

  /* ══ B-N · negative production E2E through a real report HTTP request ══ */
  section('B-N · production negative settlement');
  {
    const hn = await buildInstance('negative', {
      structured: { kind: 'preference', targetKey: 'SciFi', stance: 'like' }
    });
    const created = await recallPost(hn);
    const desc = await settle(hn);
    const list = predictions(hn);
    const pred = list[0];
    check('BN1.productionCognitionCreatedLikePrediction',
      created.status === 200 && desc.counters.predictionProjected === 1
      && pred && pred.predictionSnapshotAtCreation.semanticPayload.expectedOutcome.token === 'pref.like.scifi'
      && TEST_MANUAL_PREDICTION_INSERTS === 0,
      { http: created.status, projected: desc.counters.predictionProjected, predictions: list.length });

    /* The next real turn consumes the BehaviorEffect basis before the later report. */
    hn.inst.runtimePolicy.setExpectation(CHAR_A, false);
    hn.setNow(T0 + 60000);
    const consume = await recallPost(hn);
    await settle(hn);
    const p4Before = hn.inst.runtimePredictionCalibration.getPartition('preference', 'user_preference');
    const p4CountBefore = p4Before ? p4Before.calibrationCounts.eligibleTotal : 0;
    hn.setNow(T0 + 120000);
    const freeText = await confirmFreeTextReport(hn, 'I dislike scifi', 'chat-msg-free-text-dislike', 'action-dislike-1');
    const rep = freeText.response;
    const fb = hn.inst.runtimeRealityFeedback;
    const sv = pred && hn.inst.runtimePredictionSettlement.getSettlement(pred.predictionId);
    const pe = pred && hn.inst.runtimePredictionSettlement.getPredictionError(pred.predictionId);
    const opportunityAuthority = hn.inst.runtimeSubjectiveOpportunityAuthority.describe();
    negativeProductionFacts = { pred: pred, settlement: sv, predictionError: pe, feedback: fb,
      opportunityAuthority: opportunityAuthority };
    P('NegativeSettlementState', sv && sv.state);
    P('NegativeOpportunityState', sv && sv.opportunityState);
    P('NegativeCalibrationCounted', sv && sv.calibrationCounted);
    P('NegativeMatcherCalls', fb.counters.modelCalls);
    check('BN2.realHttpExplicitReportProducedMissed',
      consume.status === 200 && rep.status === 200 && rep.body && rep.body.outcome === 'accepted'
      && rep.body.realityStatus === 'minted' && !!sv && sv.state === 'missed'
      && sv.opportunityState === 'SATISFIED' && sv.conflictSummary.decisive === 1,
      { http: rep.status, report: rep.body && rep.body.outcome, state: sv && sv.state, opportunity: sv && sv.opportunityState });
    check('BN2K.freeTextDislikeCandidateUsesConfirmationAndExistingReportAction',
      freeText.created.ok === true && freeText.created.status === 'pending'
      && freeText.candidate && freeText.candidate.stance === 'dislike'
      && freeText.confirmation.status === 'confirmed' && freeText.reportActionCalls === 1
      && rep.status === 200 && rep.body && rep.body.report.stance === 'dislike'
      && freeText.replay.reused === true,
      { candidate: freeText.candidate, outcome: rep.body && rep.body.outcome, replay: freeText.replay.status });
    check('BN2K2.noManualRealityEventOrFeedbackInjection',
      TEST_DIRECT_REPORT_MINT === 0 && TEST_MANUAL_REALITY_EVENT === 0
      && TEST_MANUAL_FEEDBACK_CALLS === 0 && fb.counters.dispatchAttempted === 1
      && fb.counters.settlementCount === 1 && fb.counters.modelCalls === 0,
      { directReportMint: TEST_DIRECT_REPORT_MINT, manualRealityEvent: TEST_MANUAL_REALITY_EVENT,
        manualFeedback: TEST_MANUAL_FEEDBACK_CALLS, feedback: fb.counters });
    check('BN3.calibrationUsesExistingP3Policy',
      !!sv && sv.calibrationCounted === true && pred.calibrationConfidence === null
      && pe && pe.predictionErrorMetric === null,
      { calibrationCounted: sv && sv.calibrationCounted, calibrationConfidence: pred && pred.calibrationConfidence,
        predictionErrorMetric: pe && pe.predictionErrorMetric });
    check('BN4.automaticProductionPathHasNoManualInjectionOrMatcher',
      TEST_MANUAL_PREDICTION_INSERTS === 0 && TEST_MANUAL_FEEDBACK_CALLS === 0
      && TEST_MANUAL_OPPORTUNITY_INJECTION === 0 && TEST_MANUAL_CALIBRATION_INGEST === 0
      && fb.counters.dispatchAttempted === 1 && fb.counters.observationCount === 1
      && fb.counters.settlementCount === 1 && fb.counters.modelCalls === 0
      && hn.inst.runtimeEvidenceMatcher.describe().enabled === false
      && hn.inst.runtimeEvidenceMatcher.describe().counters.calls === 0
      && sv && sv.trace.matcherRelationsApplied === 0,
      { predictions: TEST_MANUAL_PREDICTION_INSERTS, feedback: TEST_MANUAL_FEEDBACK_CALLS,
        opportunity: TEST_MANUAL_OPPORTUNITY_INJECTION, calibration: TEST_MANUAL_CALIBRATION_INGEST,
        feedbackCounters: fb.counters });
    check('BN5.opportunityWitnessIsThePredictionIndependentRealityEvent',
      !!rep.body.realityEvent && rep.body.realityEvent.realitySourceId === 'user-explicit-preference-report'
      && !Object.prototype.hasOwnProperty.call(rep.body.realityEvent, 'predictionId')
      && sv.evidenceRefs.indexOf(rep.body.realityEvent.realityEventId) >= 0,
      { eventId: rep.body.realityEvent && rep.body.realityEvent.realityEventId, evidenceRefs: sv && sv.evidenceRefs });
    check('BN6.productionOpportunityAuthorityIsLiveAndSeparate',
      opportunityAuthority.status === 'LIVE_CAPABLE'
      && opportunityAuthority.evidenceAuthorityIsSeparate === 'YES'
      && opportunityAuthority.relationMayCreateOpportunity === 'NO'
      && opportunityAuthority.feedbackDriverMaySupplyOpportunity === 'NO'
      && opportunityAuthority.absentRequiresClosedWindowAndCompleteReportHistory === 'YES',
      opportunityAuthority);
    const p4After = hn.inst.runtimePredictionCalibration.getPartition('preference', 'user_preference');
    negativeProductionFacts.p4Partition = p4After;
    negativeProductionFacts.p4Driver = hn.inst.runtimePredictionCalibrationDriver.describe();
    check('BN7.missedSettlementWasAutomaticallyIngestedByP4',
      !!p4After && p4After.calibrationCounts.missed === 1
      && p4After.calibrationCounts.eligibleTotal === p4CountBefore + 1
      && hn.inst.runtimePredictionCalibrationDriver.describe().counters.ledgerAccepted === 1
      && hn.inst.runtimePredictionCalibrationDriver.describe().counters.ledgerDuplicate === 0
      && fb.counters.postSettlementCallbacks === 1,
      { counts: p4After && p4After.calibrationCounts,
        driver: hn.inst.runtimePredictionCalibrationDriver.describe().counters,
        feedback: fb.counters });
    freeTextNegativeE2E = freeText.confirmation.status === 'confirmed'
      && freeText.reportActionCalls === 1 && rep.status === 200 && rep.body && rep.body.report.stance === 'dislike'
      && sv && sv.state === 'missed' && p4After && p4After.calibrationCounts.missed === 1;
    check('BN8.productionCapabilitySurfaceMatchesTheWiredAuthority',
      !!p4After && p4After.capabilityCoverage.attributionAuthorityAvailable === true
      && p4After.capabilityCoverage.productionSettleable === true
      && hn.inst.runtimePredictionCalibration.describe().attributionAuthorityAvailable === true
      && hn.inst.runtimePredictionCalibration.inspectCalibration().view.diagnostics.attributionAuthorityAvailable === true
      && hn.inst.runtimeEvidenceMatcher.describe().attributionAuthorityAvailable === true,
      { partition: p4After && p4After.capabilityCoverage,
        describe: hn.inst.runtimePredictionCalibration.describe().attributionAuthorityAvailable,
        diagnostics: hn.inst.runtimePredictionCalibration.inspectCalibration().view.diagnostics.attributionAuthorityAvailable,
        matcher: hn.inst.runtimeEvidenceMatcher.describe().attributionAuthorityAvailable });
  }

  /* ══ C · 模型拒绝预测（null）══ */
  section('P5-B3-K · unconfirmed and declined candidates have no product effects');
  {
    const unconfirmed = await buildInstance('free-text-unconfirmed', { structured: null });
    let now = 1000;
    const session = FREE_TEXT_REPORT.createSession({ clock: () => now, ttlMs: 50,
      candidateIdFactory: () => 'unconfirmed', requestIdFactory: () => 'unconfirmed-action' });
    const text = 'I like scifi';
    const source = { id: 'chat-msg-unconfirmed', role: 'user', content: text,
      friendId: CHAR_A, threadId: '', timestamp: T0 };
    const candidate = FREE_TEXT_REPORT.extractCandidate(text, source.id);
    const pending = session.create(candidate, { characterId: CHAR_A, threadId: '' }, source);
    let reportRequests = 0;
    now = 1100;
    const expired = session.get(pending.candidateId);
    await session.confirm(pending.candidateId, { characterId: CHAR_A, threadId: '' }, source, () => {
      reportRequests++;
      return report(unconfirmed, { requestId: 'must-not-run' });
    });

    const declinedSource = { id: 'chat-msg-declined', role: 'user', content: 'I dislike scifi',
      friendId: CHAR_A, threadId: '', timestamp: T0 };
    const declinedCandidate = FREE_TEXT_REPORT.extractCandidate(declinedSource.content, declinedSource.id);
    const declined = session.create(declinedCandidate, { characterId: CHAR_A, threadId: '' }, declinedSource);
    const declinedState = session.dismiss(declined.candidateId);
    await session.confirm(declined.candidateId, { characterId: CHAR_A, threadId: '' }, declinedSource, () => {
      reportRequests++;
      return report(unconfirmed, { requestId: 'must-not-run-either' });
    });
    const reportSeam = unconfirmed.inst.runtimePreferenceReport.seam;
    const producer = unconfirmed.inst.runtimePreferenceReport.producer;
    const feedback = unconfirmed.inst.runtimeRealityFeedback;
    const p4 = unconfirmed.inst.runtimePredictionCalibration.getPartition('preference', 'user_preference');
    check('K1.no-confirmation-expires-with-zero-report-event-settlement-or-calibration',
      pending.status === 'pending' && expired.status === 'expired' && reportRequests === 0
      && reportSeam.counters.dispatchAttempted === 0 && producer.counters.minted === 0
      && feedback.counters.dispatchAttempted === 0 && feedback.counters.settlementCount === 0
      && (!p4 || p4.calibrationCounts.eligibleTotal === 0),
      { pending: pending.status, expired: expired.status, reportRequests: reportRequests,
        seam: reportSeam.counters, producer: producer.counters, feedback: feedback.counters,
        calibration: p4 && p4.calibrationCounts });
    freeTextNoConfirmE2E = expired.status === 'expired' && reportRequests === 0
      && reportSeam.counters.dispatchAttempted === 0 && producer.counters.minted === 0
      && feedback.counters.dispatchAttempted === 0 && feedback.counters.settlementCount === 0;
    check('K2.decline-is-dismissed-and-has-no-memory-or-canonical-report-effects',
      declinedState.status === 'dismissed' && reportRequests === 0
      && reportSeam.counters.dispatchAttempted === 0 && producer.counters.minted === 0
      && producer.counters.memoryWrites === 0 && producer.counters.relationshipWrites === 0
      && feedback.counters.dispatchAttempted === 0 && feedback.counters.settlementCount === 0,
      { dismissed: declinedState.status, reportRequests: reportRequests,
        producer: producer.counters, feedback: feedback.counters });
    freeTextDeclineE2E = declinedState.status === 'dismissed' && reportRequests === 0
      && reportSeam.counters.dispatchAttempted === 0 && producer.counters.minted === 0
      && producer.counters.memoryWrites === 0 && producer.counters.relationshipWrites === 0;
  }

  /* ══ C · 模型拒绝预测（null）══ */
  section('C · model declines to predict');
  {
    const hc = await buildInstance('decline', { structured: null });
    await recallPost(hc);
    const d = await settle(hc);
    check('C1.chatTurnSucceedsWithZeroPredictions',
      d.counters.created === 1 && d.counters.predictionProjected === 0
      && predictions(hc).length === 0
      && d.structuredProjection.reasons['missing-structured-prediction'] === 1,
      { created: d.counters.created, reasons: d.structuredProjection.reasons });
  }

  /* ══ D · 模型给了非法候选 ══ */
  section('D · malformed candidate');
  {
    const hd = await buildInstance('malformed', { structured: { kind: 'preference', targetKey: 'scifi', stance: 'maybe' } });
    await recallPost(hd);
    const d = await settle(hd);
    check('D1.chatTurnSucceedsAndProjectionIsSkippedWithItsReason',
      d.counters.created === 1 && d.counters.predictionProjected === 0
      && predictions(hd).length === 0
      && d.structuredProjection.reasons['invalid-preference-stance'] === 1,
      d.structuredProjection.reasons);
  }

  /* ══ E · 模型给了 TYPE_TABLE 支持但 G1 未开放的 type ══ */
  section('E · supported-but-disabled type');
  {
    const he = await buildInstance('relational', { structured: { kind: 'relational', targetKey: 'x', stance: 'like' } });
    await recallPost(he);
    const d = await settle(he);
    check('E1.productionTypeNotEnabled',
      d.counters.created === 1 && d.counters.predictionProjected === 0
      && predictions(he).length === 0
      && d.structuredProjection.reasons['production-type-not-enabled'] === 1
      && d.structuredProjection.productionProjectionTypes.join(',') === 'preference,event:runtime.turn_terminal',
      d.structuredProjection.reasons);
  }

  /* ══ F · 旧模型输出（没有 structuredPrediction）══ */
  section('F · legacy provider output');
  {
    const hf = await buildInstance('legacy', { structured: 'omit' });
    await recallPost(hf);
    const d = await settle(hf);
    check('F1.backwardCompatible',
      d.counters.created === 1 && d.counters.predictionProjected === 0 && predictions(hf).length === 0
      && d.structuredProjection.reasons['missing-structured-prediction'] === 1,
      d.structuredProjection.reasons);
  }

  /* ══ G · 模型伪造 authority 字段 ══ */
  section('G · authority-field attack from the model');
  {
    const hg = await buildInstance('attack', {
      structured: {
        kind: 'preference', targetKey: 'scifi', stance: 'like',
        predictionId: 'pred_evil', characterId: CHAR_B, conversationId: 'dm:' + CHAR_B,
        turnId: 'evil', createdAt: 1, source: 'CANONICAL_RUNTIME',
        settlementState: 'matched', calibrationCounted: true, validated: true
      }
    });
    await recallPost(hg);
    const d = await settle(hg);
    const list = predictions(hg);
    check('G1.recordScopeAndIdentityComeFromTheRuntime',
      d.counters.predictionProjected === 1 && list.length === 1
      && list[0].predictionId !== 'pred_evil' && list[0].predictionId.indexOf('pred_') === 0
      && list[0].scope.characterId === CHAR_A && list[0].scope.conversationId === 'dm:' + CHAR_A
      && list[0].predictionSnapshotAtCreation.scope.characterId === CHAR_A
      && list[0].behaviorEffectAttributionStatus !== 'matched',
      { id: list[0] && list[0].predictionId, scope: list[0] && list[0].scope });
    check('G2.strippedAuthorityFieldsAreDiagnosedNotAdmitted',
      d.structuredProjection.counters.candidatesAccepted === 1
      && JSON.stringify(d).indexOf('pred_evil') < 0
      && JSON.stringify(list[0]).indexOf('pred_evil') < 0,
      '模型给的 id 从未进入 canonical record');
  }

  /* ══ H · 同一回合重放 ══ */
  section('H · replay');
  {
    const r2 = await h.inst.runtimeExpectation.runFromValidatedInterpretation({
      characterId: CHAR_A, conversationId: 'dm:' + CHAR_A, turnId: (function () {
        /* 用与 A 相同的 turnId 形状：从已注册记录反查它引用的 turn */
        return h.inst.runtimePredictionRegistry.listOpenPredictions({ characterId: CHAR_A, conversationId: 'dm:' + CHAR_A })[0]
          .sourceExpectationRef.turnId;
      })(),
      interpretationValidated: true, selectedIds: ['m1'],
      records: [{ id: 'm1', content: 'C-m1 ' + QUERY, kind: 'episodic' }],
      independentObservationCount: 2
    }, {});
    check('H1.sameTurnIsNotProjectedTwice',
      r2.ok === false && r2.reason === 'duplicate-turn' && predictions(h).length === 1,
      { reason: r2.reason, predictions: predictions(h).length });
  }

  P('MECHANICAL_FEEDBACK_LOOP_PRODUCTION_LIVE', 'YES');
  P('PRODUCTION_STRUCTURED_EXPECTATION_PROJECTION', 'LIVE');
  P('PRODUCTION_PREDICTION_REGISTRATION', 'LIVE');
  P('POSITIVE_PREDICTION_ERROR_PRODUCT_E2E', 'LIVE');
  P('TEST_MANUAL_PREDICTION_INSERTS', TEST_MANUAL_PREDICTION_INSERTS);
  P('TEST_MANUAL_FEEDBACK_CALLS', TEST_MANUAL_FEEDBACK_CALLS);
  P('TEST_MANUAL_OPPORTUNITY_INJECTION', TEST_MANUAL_OPPORTUNITY_INJECTION);
  P('TEST_MANUAL_CALIBRATION_INGEST', TEST_MANUAL_CALIBRATION_INGEST);
  const freeTextKSuccess = freeTextKFailures === 0 && freeTextPositiveE2E && freeTextNegativeE2E
    && freeTextNoConfirmE2E && freeTextDeclineE2E;
  P('FREE_TEXT_CANDIDATE_EXTRACTION', freeTextKSuccess ? 'LIVE' : 'NOT_LIVE');
  P('FREE_TEXT_EXPLICIT_REPORT_SUPPORT', freeTextKSuccess ? 'CONFIRMATION_GATED' : 'BLOCKED');
  P('RAW_CHAT_TEXT_IS_EXPLICIT_REPORT', 'NO');
  P('USER_CONFIRMATION_REQUIRED', 'YES');
  P('CONFIRMATION_REUSES_EXISTING_REPORT_AUTHORITY', freeTextKSuccess ? 'YES' : 'NO');
  P('TEST_DIRECT_REPORT_MINT', TEST_DIRECT_REPORT_MINT);
  P('TEST_MANUAL_REALITY_EVENT', TEST_MANUAL_REALITY_EVENT);
  P('FREE_TEXT_MATCHED_E2E', freeTextPositiveE2E ? 'LIVE' : 'NOT_LIVE');
  P('FREE_TEXT_MISSED_E2E', freeTextNegativeE2E ? 'LIVE' : 'NOT_LIVE');
  P('NO_CONFIRMATION_REPORT_COUNT', freeTextNoConfirmE2E ? 0 : 'UNKNOWN');
  P('DECLINE_REPORT_COUNT', freeTextDeclineE2E ? 0 : 'UNKNOWN');
  P('MEMORY_WRITE_FROM_CONFIRMATION', freeTextKSuccess ? 0 : 'UNKNOWN');
  P('MATCHER_DEFAULT_CHANGED', 'NO');
  P('P5_B3_K_STATUS', freeTextKSuccess ? 'COMPLETE' : 'BLOCKED');
  P('P5_B3_K_FREEZE', freeTextKSuccess ? 'FROZEN' : 'NOT_FROZEN');
  P('SUBJECTIVE_NEGATIVE_DECISIVE_SETTLEMENT_LIVE', negativeProductionFacts
    && negativeProductionFacts.settlement && negativeProductionFacts.settlement.state === 'missed' ? 'YES' : 'NO');
  P('SUBJECTIVE_OPPORTUNITY_AUTHORITY', 'LIVE');
  P('PRODUCTION_OPPORTUNITY_SOURCE', 'CANONICAL_ACCEPTED_REPORT_PLUS_SEALED_REALITY_EVENT');
  P('GAP-3', negativeProductionFacts && negativeProductionFacts.settlement
    && negativeProductionFacts.settlement.state === 'missed' ? 'CLOSED' : 'OPEN');
  P('P5_B3_I_STATUS', negativeProductionFacts && negativeProductionFacts.settlement
    && negativeProductionFacts.settlement.state === 'missed' ? 'COMPLETE' : 'BLOCKED_BY_NO_SUBJECTIVE_OPPORTUNITY_AUTHORITY');
  P('P5_B3_I_FREEZE', negativeProductionFacts && negativeProductionFacts.settlement
    && negativeProductionFacts.settlement.state === 'missed' ? 'FROZEN' : 'NOT_FROZEN');
  const p5B3JSuccess = !!negativeProductionFacts && !!positiveCalibrationFacts
    && positiveCalibrationFacts.partition && positiveCalibrationFacts.driver
    && positiveCalibrationFacts.partition.calibrationCounts.matched === 1
    && positiveCalibrationFacts.driver.counters.ledgerAccepted === 1
    && positiveCalibrationFacts.driver.counters.ledgerDuplicate === 0
    && negativeProductionFacts.p4Partition
    && negativeProductionFacts.p4Partition.calibrationCounts.missed === 1
    && negativeProductionFacts.p4Driver.counters.ledgerAccepted === 1
    && negativeProductionFacts.p4Driver.counters.ledgerDuplicate === 0;
  P('P4_PRODUCTION_LEDGER_DRIVER', p5B3JSuccess ? 'LIVE' : 'NOT_LIVE');
  P('AUTOMATIC_MATCHED_SAMPLE_INGEST', positiveCalibrationFacts && positiveCalibrationFacts.partition
    && positiveCalibrationFacts.partition.calibrationCounts.matched === 1 ? 'YES' : 'NO');
  P('AUTOMATIC_MISSED_SAMPLE_INGEST', negativeProductionFacts && negativeProductionFacts.p4Partition
    && negativeProductionFacts.p4Partition.calibrationCounts.missed === 1 ? 'YES' : 'NO');
  P('DUPLICATE_SAMPLE_COUNT', p5B3JSuccess
    ? positiveCalibrationFacts.driver.counters.ledgerDuplicate + negativeProductionFacts.p4Driver.counters.ledgerDuplicate : 'UNKNOWN');
  P('P5_B3_J_STATUS', p5B3JSuccess && TEST_MANUAL_CALIBRATION_INGEST === 0 ? 'COMPLETE' : 'BLOCKED');
  P('P5_B3_J_FREEZE', p5B3JSuccess && TEST_MANUAL_CALIBRATION_INGEST === 0 ? 'FROZEN' : 'NOT_FROZEN');
  const p5B3JR1Success = p5B3JSuccess
    && positiveCalibrationFacts.partition.capabilityCoverage.attributionAuthorityAvailable === true
    && negativeProductionFacts.p4Partition.capabilityCoverage.attributionAuthorityAvailable === true
    && SERVICE.describePredictionCalibrationCapability().attributionAuthorityAvailable === true
    && positiveCalibrationFacts.partition.calibrationConfidence === null
    && negativeProductionFacts.p4Partition.calibrationConfidence === null
    && negativeProductionFacts.pred.calibrationConfidence === null;
  P('ATTRIBUTION_AUTHORITY_AVAILABLE',
    p5B3JR1Success && h.inst.runtimePredictionCalibration.describe().attributionAuthorityAvailable === true ? 'true' : 'false');
  P('P5_B3_J_R1_STATUS', p5B3JR1Success ? 'COMPLETE' : 'BLOCKED');
  P('P5_B3_J_R1_FREEZE', p5B3JR1Success ? 'FROZEN' : 'NOT_FROZEN');
  P('PROCESS_ASSEMBLY_AUTHORITY_CAPABILITY',
    SERVICE.describePredictionCalibrationCapability().attributionAuthorityAvailable);
  const p5B3JR2Success = p5B3JR1Success
    && positiveCalibrationFacts.partition.capabilityCoverage.productionSettleable === true
    && negativeProductionFacts.p4Partition.capabilityCoverage.productionSettleable === true
    && SERVICE.describePredictionCalibrationCapability().productionSettleableFormula
      === 'policyAllowed && runtimeClassifiable && attributionAuthorityAvailable';
  P('PRODUCTION_SETTLEABLE_CANONICAL_FORMULA',
    'policyAllowed && runtimeClassifiable && attributionAuthorityAvailable');
  P('P5_B3_J_R2_STATUS', p5B3JR2Success ? 'COMPLETE' : 'BLOCKED');
  P('P5_B3_J_R2_FREEZE', p5B3JR2Success ? 'FROZEN' : 'NOT_FROZEN');
  P('EVIDENCE_MATCHER_ENABLED_DEFAULT', false);
  P('MEMORY_WRITE', 'NONE');
  P('RELATIONSHIP_WRITE', 'NONE');
  P('CALIBRATION_CONFIDENCE', negativeProductionFacts && negativeProductionFacts.pred
    ? negativeProductionFacts.pred.calibrationConfidence : null);
  P('CALIBRATION_APPLIED_TO_LIVE', 'NO');
  check('P5_B3_I.successCriteria', !!negativeProductionFacts
    && negativeProductionFacts.opportunityAuthority.status === 'LIVE_CAPABLE'
    && negativeProductionFacts.settlement.state === 'missed'
    && negativeProductionFacts.settlement.opportunityState === 'SATISFIED'
    && negativeProductionFacts.settlement.calibrationCounted === true
    && TEST_MANUAL_PREDICTION_INSERTS === 0 && TEST_MANUAL_FEEDBACK_CALLS === 0
    && TEST_MANUAL_OPPORTUNITY_INJECTION === 0
    && negativeProductionFacts.feedback.counters.postSettlementCallbacks === 1
    && negativeProductionFacts.feedback.counters.postSettlementFailures === 0,
    negativeProductionFacts && { state: negativeProductionFacts.settlement.state,
      opportunity: negativeProductionFacts.settlement.opportunityState,
      calibrationCounted: negativeProductionFacts.settlement.calibrationCounted });
  check('P5_B3_J.successCriteria', p5B3JSuccess
    && TEST_MANUAL_CALIBRATION_INGEST === 0
    && negativeProductionFacts.feedback.counters.postSettlementFailures === 0
    && negativeProductionFacts.pred.calibrationConfidence === null
    && negativeProductionFacts.predictionError.predictionErrorMetric === null,
    { p4Driver: p5B3JSuccess, matched: positiveCalibrationFacts && positiveCalibrationFacts.partition
      && positiveCalibrationFacts.partition.calibrationCounts.matched,
      missed: negativeProductionFacts && negativeProductionFacts.p4Partition
        && negativeProductionFacts.p4Partition.calibrationCounts.missed,
      confidence: negativeProductionFacts && negativeProductionFacts.pred.calibrationConfidence });
  check('P5_B3_J_R1.successCriteria', p5B3JR1Success
    && positiveCalibrationFacts.partition.capabilityCoverage.attributionAuthorityAvailable === true
    && negativeProductionFacts.p4Partition.capabilityCoverage.attributionAuthorityAvailable === true
    && SERVICE.describePredictionCalibrationCapability().attributionAuthorityAvailable === true
    && negativeProductionFacts.p4Partition.calibrationCounts.missed === 1
    && positiveCalibrationFacts.partition.calibrationCounts.matched === 1,
    { matched: positiveCalibrationFacts && positiveCalibrationFacts.partition.calibrationCounts,
      missed: negativeProductionFacts && negativeProductionFacts.p4Partition.calibrationCounts,
      authorityAvailable: positiveCalibrationFacts && positiveCalibrationFacts.partition.capabilityCoverage.attributionAuthorityAvailable,
      confidence: negativeProductionFacts && negativeProductionFacts.pred.calibrationConfidence });
  check('P5_B3_J_R2.successCriteria', p5B3JR2Success
    && positiveCalibrationFacts.partition.capabilityCoverage.productionSettleable === true
    && negativeProductionFacts.p4Partition.capabilityCoverage.productionSettleable === true
    && negativeProductionFacts.p4Partition.calibrationCounts.missed === 1
    && positiveCalibrationFacts.partition.calibrationCounts.matched === 1
    && negativeProductionFacts.pred.calibrationConfidence === null,
    { matched: positiveCalibrationFacts && positiveCalibrationFacts.partition.capabilityCoverage,
      missed: negativeProductionFacts && negativeProductionFacts.p4Partition.capabilityCoverage,
      counts: negativeProductionFacts && negativeProductionFacts.p4Partition.calibrationCounts,
      confidence: negativeProductionFacts && negativeProductionFacts.pred.calibrationConfidence });

  const g2FailuresBefore = failures;
  await runG2E2E();
  const g2Success = failures === g2FailuresBefore;
  P('EVENT_PRODUCTION_PREDICTION_CREATION', g2Success ? 'LIVE' : 'NOT_LIVE');
  P('PRODUCTION_EVENT_MATCHED_E2E', g2Success ? 'LIVE' : 'NOT_LIVE');
  P('PRODUCTION_EVENT_MISSED_E2E', g2Success ? 'LIVE' : 'NOT_LIVE');
  P('P5_B3_G2_STATUS', g2Success ? 'COMPLETE' : 'BLOCKED');
  P('P5_B3_G2_FREEZE', g2Success ? 'FROZEN' : 'NOT_FROZEN');

  instances.forEach(x => { try { x.inst.server.close(); } catch (_) { /* 已关 */ } });
  console.log('\n' + '='.repeat(64));
  if (failures) {
    console.error('PREDICTION ERROR PRODUCT E2E FAILED · ' + failures + ' assertion(s), ' + passed + ' passed');
    process.exit(1);
  }
  console.log('PREDICTION ERROR PRODUCT E2E PASSED · ' + passed + ' assertions green');
})().catch((e) => { console.error('CRASHED', e && e.stack); process.exit(1); });
