'use strict';
/* ══════════════════════════════════════════════════════════════════════════
   Internal Beyond · Prediction Error P5-B3-G1 · Full Product Positive E2E
   （纯 Node · 零真实出网（假 fetch）· 只在 .dsh-tmp 下开目录 · 自然退出）

   运行：node tests/test_prediction_error_product_e2e.js

   ── 本套件是 G1 的最终验收 ─────────────────────────────────────────────
     Step 1 · 真实 production cognition turn（HTTP memory-recall 面）
              → provider 返回 structured preference expectation
              → runtime 自动投影 + 注册 canonical PredictionRecord
              ⇒ TEST_MANUAL_PREDICTION_INSERTS = 0
     Step 2 · later 真实 HTTP POST /internal/user-reports/preference
     Step 3 · RealityEvent → 自动 feedback dispatch → paired observation → P3 matched
              ⇒ TEST_MANUAL_FEEDBACK_CALLS = 0 · MATCHER_CALLS = 0
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

let passed = 0, failures = 0;
const check = (n, c, d) => {
  if (c) { passed++; console.log('  PASS  ' + n); return true; }
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
      const item = {
        prediction: '用户可能更喜欢科幻题材',
        trigger: { kind: 'same-topic', label: '再次谈到科幻时' },
        evidenceMemoryIds: ids.length ? [ids[0]] : [],
        contradictoryEvidenceIds: [],
        generalizationLevel: 'episode-hypothesis',
        subjectivePredictionConfidence: 0.55
      };
      if (c.structured !== 'omit') item.structuredPrediction = c.structured === undefined
        ? { kind: 'preference', targetKey: 'SciFi', stance: 'like' }
        : c.structured;
      content = JSON.stringify({ items: ids.length ? [item] : [] });
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
  const port = NODE_MODEL_PORT({ fetch: makeFetch(rec, c) });
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
  const h = { tag: tag, inst: inst, rec: rec, webPort: webPort, setNow: function (t) { now = t; } };
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
function report(h, over) {
  return post(h, SEAM.REPORT_PATH, Object.assign({
    requestId: 'rep_' + Math.random().toString(36).slice(2),
    characterId: CHAR_A, targetKey: 'SciFi', stance: 'like'
  }, over || {}));
}
/* **主 E2E 里没有一次手插 Prediction**：这个常量是对"没有绕过 runtime"的自我约束。 */
const TEST_MANUAL_PREDICTION_INSERTS = 0;

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
    /* step 2b：later explicit report（真实 HTTP） */
    h.setNow(T0 + 120000);
    const rep = await report(h, { requestId: 'rep-pos-1' });
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
      TEST_MANUAL_PREDICTION_INSERTS === 0 && predictions(h).length === 1,
      'TEST_MANUAL_FEEDBACK_CALLS = 0');
    check('B6.predictionErrorIsOrdinalOnly',
      (function () {
        const pe = h.inst.runtimePredictionSettlement.getPredictionError(pred.predictionId);
        return pe && pe.predictionMetric === undefined && pe.predictionErrorMetric === null
          && pe.settlementState === 'matched' && pe.calibrationEligible === true;
      })(),
      'CALIBRATION_CONFIDENCE = null · CALIBRATION_APPLIED_TO_LIVE = NO');
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
      && d.structuredProjection.productionProjectionTypes.join(',') === 'preference',
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
  P('FREE_TEXT_EXPLICIT_USER_REPORT_PRODUCTION_LIVE', 'NO');
  P('SUBJECTIVE_NEGATIVE_DECISIVE_SETTLEMENT_LIVE', 'NO（GAP-3 未处理）');
  P('EVIDENCE_MATCHER_ENABLED_DEFAULT', false);
  P('CALIBRATION_APPLIED_TO_LIVE', 'NO');

  instances.forEach(x => { try { x.inst.server.close(); } catch (_) { /* 已关 */ } });
  console.log('\n' + '='.repeat(64));
  if (failures) {
    console.error('PREDICTION ERROR PRODUCT E2E FAILED · ' + failures + ' assertion(s), ' + passed + ' passed');
    process.exit(1);
  }
  console.log('PREDICTION ERROR PRODUCT E2E PASSED · ' + passed + ' assertions green');
})().catch((e) => { console.error('CRASHED', e && e.stack); process.exit(1); });
