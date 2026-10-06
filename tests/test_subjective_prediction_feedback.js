'use strict';
/* ══════════════════════════════════════════════════════════════════════════
   Internal Beyond · Prediction Error P5-B3-E-R1 · Subjective Preference Feedback
   （纯 Node · 零浏览器 · 零网络 · 零真实模型调用）

   运行：node tests/test_subjective_prediction_feedback.js

   ── 本文件的历史（重要）──────────────────────────────────────────────────
   P5-B3-E 时它是 "主观链**不可** decisive" 的冻结证据。P5-B3-E-R1 建立了
   structured explicit preference report + 机械偏好 relation 之后，它被**翻面**：
   仍然成立的 invariant（absence != contradiction、no memory/relationship write、
   matcher OFF、ordinal-only）保留；被推翻的结论改成新的、更强的规则。

   ── 主 E2E（§40/§42）────────────────────────────────────────────────────
     trusted ingress → route validation → canonical report
       → RealityEvent → automatic feedback dispatch → Registry pairing
       → P1 observation → P3 settlement = **matched** · calibrationCounted = true
     MATCHER_CALLS = 0 · TEST_MANUAL_FEEDBACK_CALLS = 0
   ══════════════════════════════════════════════════════════════════════════ */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const ROOT = path.resolve(__dirname, '..');
const WIRING = require('./helpers/activation-wiring-probe.js');
const SERVICE = require(path.join(ROOT, 'services/home-node-service.js'));
const PREF = require(path.join(ROOT, 'assets/js/memory-recall/preference-proposition-core.js'));
const OO = require(path.join(ROOT, 'assets/js/memory-recall/outcome-observation-core.js'));
const SETTLE_CORE = require(path.join(ROOT, 'assets/js/memory-recall/prediction-settlement-core.js'));
const { createRuntimeRealityEvent } = require(path.join(ROOT, 'services/home-node/runtime-reality-event.js'));
const { createRuntimeOutcomeObservation } = require(path.join(ROOT, 'services/home-node/runtime-outcome-observation.js'));
const { createRuntimePredictionRegistry } = require(path.join(ROOT, 'services/home-node/runtime-prediction-registry.js'));
const { createRuntimePredictionSettlement } = require(path.join(ROOT, 'services/home-node/runtime-prediction-settlement.js'));
const { createRuntimeExplicitPreferenceReport } = require(path.join(ROOT, 'services/home-node/runtime-explicit-preference-report.js'));

let passed = 0, failures = 0;
const check = (n, c, d) => {
  if (c) { passed++; console.log('  PASS  ' + n); return true; }
  failures++; console.error('  FAIL  ' + n + (d !== undefined ? '  -> ' + JSON.stringify(d) : ''));
  return false;
};
const section = t => console.log('\n── ' + t + ' ──');
const P = (k, v) => console.log('  FACTS ' + k + ' = ' + v);
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const code = rel => WIRING.stripJsComments(read(rel));

const T0 = 1760000000000;
const TOKEN = 'desktop-token-xyz';
const SCOPE = { characterId: 'char_a', conversationId: 'dm:char_a' };
let seq = 0;

/* ── 生产装配（与 test_reality_feedback_driver 同一构造纪律）────────────── */
function build(tag, over) {
  const o = over || {};
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r1fb-' + tag + '-'));
  const inst = SERVICE.buildHomeNode({
    dataDir: dir, credentialDataDir: dir, token: o.token === undefined ? TOKEN : o.token, port: 0, logger: () => {},
    clock: () => T0,
    registry: {
      getCharacterSpec: id => (String(id) === 'char_a' ? { endpoint: 'https://x', model: 'm', systemPrompt: 'sys', apiKey: 'k' } : null),
      open: function () { return true; }
    },
    port: { runStream: async () => ({ ok: true, text: 'hi', reasoning: '', usage: null, streamed: false }) }
  });
  inst.open();
  return inst;
}
function seedPreference(inst, token, over, ctxOver) {
  seq += 1;
  return inst.runtimePredictionRegistry.projectFromValidatedExpectation(Object.assign({
    epistemicStatus: 'prediction', prediction: '用户喜欢这个',
    trigger: { kind: 'explicit-cue', label: 'x' }, evidenceMemoryIds: ['m1'], contradictoryEvidenceIds: [],
    generalizationLevel: 'episode-hypothesis', subjectivePredictionConfidence: 0.8,
    subject: { kind: 'user', label: '' }, predicate: { kind: 'prefers' },
    expectedOutcome: { kind: 'exclusive-outcome', token: token }
  }, over || {}), Object.assign({
    now: T0, characterId: SCOPE.characterId, conversationId: SCOPE.conversationId,
    turnId: 'tp_' + seq, expectationIndex: 0
  }, ctxOver || {})).record;
}
function act(inst, body, info) {
  return inst.runtimePreferenceReport.seam.dispatch(
    Object.assign({ loopback: true, remoteAddress: '127.0.0.1', desktopCredential: TOKEN }, info || {}),
    body);
}
function body(over) {
  return Object.assign({ requestId: 'req', characterId: 'char_a', targetKey: 'SciFi', stance: 'like' }, over || {});
}
function runTurn(inst, requestId, content) {
  return inst.executor.executeCharacterTurn({
    requestId: requestId,
    userMessage: { id: 'u_' + requestId, role: 'user', content: content || 'I like scifi', friendId: 'char_a', timestamp: T0 },
    character: { id: 'char_a', spec: { endpoint: 'https://x', model: 'm', systemPrompt: 'sys', apiKey: 'k' } },
    history: []
  }, {});
}
/* ── 真实 HTTP：走 production route（§40 的主 E2E 入口）────────────────── */
function postJson(port, pathName, payload, headers) {
  return new Promise((resolve) => {
    const data = Buffer.from(JSON.stringify(payload), 'utf8');
    const req = http.request({
      host: '127.0.0.1', port: port, path: pathName, method: 'POST',
      headers: Object.assign({ 'content-type': 'application/json', 'content-length': data.length }, headers || {})
    }, res => {
      let text = '';
      res.on('data', c => { text += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(text); } catch (_) { json = null; }
        resolve({ status: res.statusCode, json: json, raw: text });
      });
    });
    req.on('error', e => resolve({ status: 0, json: null, raw: String(e && e.message) }));
    req.write(data);
    req.end();
  });
}
function request(port, pathName, method, headers) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: port, path: pathName, method: method, headers: headers || {} },
      res => { res.resume(); res.on('end', () => resolve({ status: res.statusCode })); });
    req.on('error', e => resolve({ status: 0, error: String(e && e.message) }));
    req.end();
  });
}

/* ── 单元级：P3 机械 relation（不经过生产链）────────────────────────────── */
function unitPrediction(token, over, ctxOver) {
  const reg = createRuntimePredictionRegistry({ clock: () => T0 });
  seq += 1;
  return reg.projectFromValidatedExpectation(Object.assign({
    epistemicStatus: 'prediction', prediction: '用户喜欢这个',
    trigger: { kind: 'explicit-cue', label: 'x' }, evidenceMemoryIds: ['m1'], contradictoryEvidenceIds: [],
    generalizationLevel: 'episode-hypothesis', subjectivePredictionConfidence: 0.8,
    subject: { kind: 'user', label: '' }, predicate: { kind: 'prefers' },
    expectedOutcome: { kind: 'exclusive-outcome', token: token }
  }, over || {}), Object.assign({ now: T0, characterId: 'char_A', conversationId: 'dm:char_A', turnId: 'u_' + seq, expectationIndex: 0 }, ctxOver || {})).record;
}
/** 事件型 prediction（用于"A 类型的预测看到 pref.* token"这条边界证明）。 */
function unitEventPrediction(token) {
  const reg = createRuntimePredictionRegistry({ clock: () => T0 });
  seq += 1;
  return reg.projectFromValidatedExpectation({
    epistemicStatus: 'prediction', prediction: '这一回合会正常完成',
    trigger: { kind: 'explicit-cue', label: 'x' }, evidenceMemoryIds: ['m1'], contradictoryEvidenceIds: [],
    generalizationLevel: 'episode-hypothesis', subjectivePredictionConfidence: 0.8,
    subject: { kind: 'character-self', label: '' }, predicate: { kind: 'will-do' },
    expectedOutcome: { kind: 'exclusive-outcome', token: token }
  }, { now: T0, characterId: 'char_A', conversationId: 'dm:char_A', turnId: 'ev_' + seq, expectationIndex: 0 }).record;
}
function statementObs(pred, statement, over) {
  const r = OO.buildOutcomeObservation(Object.assign({
    windowRef: { predictionId: pred.predictionId, predictionCreatedAt: pred.observationWindow.opensAt, opensAt: pred.observationWindow.opensAt, closesAt: pred.observationWindow.closesAt },
    source: 'EXPLICIT_USER_REPORT', sourceInstance: 'user.explicit-preference-report',
    targetDomain: 'user_preference', observedAt: pred.observationWindow.opensAt + 1000,
    completeness: 'point', scope: pred.scope,
    outcomeRef: { kind: 'statement', statement: statement }, evidenceRefs: ['r1'],
    interventionContext: { behaviorEffectsInForce: [], predictionInfluencedSystem: null, contaminationClass: 'NONE', contaminationBasis: 'none' }
  }, over || {}), {});
  return r.ok ? r.value : null;
}
function tokenObs(pred, token, over) {
  const r = OO.buildOutcomeObservation(Object.assign({
    windowRef: { predictionId: pred.predictionId, predictionCreatedAt: pred.observationWindow.opensAt, opensAt: pred.observationWindow.opensAt, closesAt: pred.observationWindow.closesAt },
    source: 'EXPLICIT_USER_REPORT', sourceInstance: 'user.explicit-preference-report',
    targetDomain: 'user_preference', observedAt: pred.observationWindow.opensAt + 1000,
    completeness: 'point', scope: pred.scope,
    outcomeRef: { kind: 'token', token: token }, evidenceRefs: ['r1'],
    interventionContext: { behaviorEffectsInForce: [], predictionInfluencedSystem: null, contaminationClass: 'NONE', contaminationBasis: 'none' }
  }, over || {}), {});
  return r.ok ? r.value : null;
}

(async function main() {
  /* ══ A · 机械 relation（无 Matcher）══ */
  section('A · mechanical preference relation');
  {
    const rel = (want, got, over) => SETTLE_CORE.classifyRelation(
      Object.assign({}, unitPrediction(want), over || {}), { outcomeRef: { kind: 'token', token: got } });
    check('A1.sameTargetSameStanceIsSupport', rel('pref.like.scifi', 'pref.like.scifi') === 'support');
    check('A2.sameTargetOppositeStanceIsConflict', rel('pref.like.scifi', 'pref.dislike.scifi') === 'conflict');
    check('A3.differentTargetIsIrrelevantNeverConflict',
      rel('pref.like.scifi', 'pref.like.coffee') === 'irrelevant'
      && rel('pref.like.scifi', 'pref.dislike.coffee') === 'irrelevant',
      '绝不做语义泛化（§33/§35）');
    check('A4.nonCanonicalTokenIsUnclassifiableNotConflict',
      rel('pref.like.scifi', 'pref.like.SciFi') === 'unclassifiable'
      && rel('pref.like.SciFi', 'pref.like.scifi') === 'unclassifiable'
      && rel('pref.like.scifi', 'pref.love.scifi') === 'unclassifiable',
      'fail closed');
    check('A5.nonPreferencePredictionSeesPreferenceTokenAsIrrelevant',
      SETTLE_CORE.classifyRelation(unitEventPrediction('pref.like.scifi'),
        { outcomeRef: { kind: 'token', token: 'pref.like.scifi' } }) === 'irrelevant'
      && SETTLE_CORE.classifyRelation(unitEventPrediction('runtime.turn_terminal'),
        { outcomeRef: { kind: 'token', token: 'runtime.turn_terminal' } }) === 'support',
      '命名空间不匹配 ⇒ irrelevant；既有 token 相等语义**不变**');
    check('A6.statementStillNeedsTheMatcher',
      SETTLE_CORE.classifyRelation(unitPrediction('pref.like.scifi'), { outcomeRef: { kind: 'statement', statement: '我喜欢科幻' } }) === 'unclassifiable'
      && SETTLE_CORE.EVIDENCE_MATCHER_INVOCATION === 'OFF'
      && JSON.stringify(SETTLE_CORE.RUNTIME_CLASSIFIABLE_MODES) === '["exclusive_outcome","window_closure_negative"]'
      && SETTLE_CORE.STATE_SUPPORT.statementRelationRequires === 'EVIDENCE_MATCHER_P5',
      '结构化命题是机械的；自由文本仍然需要 Matcher（本相位**没有**打开它）');
    check('A7.tokensAreTheOnlySharedRepresentation',
      PREF.buildPreferenceToken('like', 'scifi') === 'pref.like.scifi'
      && PREF.parsePreferenceToken('pref.dislike.coffee_beans').targetKey === 'coffee_beans'
      && PREF.MAX_TOKEN_LENGTH <= OO.BOUNDS.MAX_TOKEN,
      'P1 MAX_TOKEN = ' + OO.BOUNDS.MAX_TOKEN);
  }

  /* ══ B · 生产 one-pair support E2E ══ */
  section('B · one-pair support production E2E');
  {
    const inst = build('support');
    const pred = seedPreference(inst, 'pref.like.scifi');
    const r = act(inst, body({ requestId: 'support-1' }));
    const fb = inst.runtimeRealityFeedback;
    const sv = inst.runtimePredictionSettlement.getSettlement(pred.predictionId);
    P('one.ExplicitPreferenceReport', r.reportMinted ? 1 : 0);
    P('one.RealityEvent', r.realityStatus === 'minted' ? 1 : 0);
    P('one.FeedbackDispatch', fb.counters.dispatchAttempted);
    P('one.PredictionCandidate', fb.counters.candidateCount);
    P('one.OutcomeObservation', fb.counters.observationCount);
    P('one.Settlement', fb.counters.settlementCount);
    P('one.MatcherCalls', fb.counters.modelCalls);
    check('B1.dedicatedActionMintsCanonicalReport',
      r.ok === true && r.outcome === 'accepted' && r.reportMinted === true
      && r.report.source === 'EXPLICIT_USER_REPORT'
      && r.report.targetKey === 'scifi' && r.report.stance === 'like'
      && r.report.characterId === 'char_a' && r.report.conversationId === 'dm:char_a',
      r.report);
    check('B2.realityEventMintedFromTheReport',
      r.realityStatus === 'minted' && r.realityEvent.source === 'EXPLICIT_USER_REPORT'
      && r.realityEvent.sourceInstance === 'user.explicit-preference-report'
      && r.realityEvent.occurredAt === r.report.occurredAt,
      r.realityEvent && r.realityEvent.realityEventId);
    check('B3.automaticDispatchAndProjection',
      fb.counters.dispatchAttempted === 1 && fb.counters.dispatchCompleted === 1 && fb.counters.dispatchFailed === 0
      && fb.counters.candidateCount === 1 && fb.counters.observationCount === 1 && fb.counters.settlementCount === 1,
      fb.counters);
    check('B4.decisiveSupportSettlement',
      !!sv && sv.state === 'matched' && sv.calibrationCounted === true
      && sv.admittedTargetDomains.length === 1 && sv.admittedTargetDomains[0] === 'user_preference'
      && sv.supportSummary.decisive === 1,
      sv && { state: sv.state, cal: sv.calibrationCounted, domains: sv.admittedTargetDomains });
    check('B5.gateTraceShowsTheExplicitReportSource',
      sv.gateTraceRefs.length === 1
      && sv.gateTraceRefs[0].targetDomain === 'user_preference'
      && sv.gateTraceRefs[0].ceiling === 'ELIGIBLE'
      && sv.gateTraceRefs[0].effective === 'ELIGIBLE'
      && sv.gateTraceRefs[0].contaminationGate === 'NONE',
      sv.gateTraceRefs);
    check('B6.matcherCallsZeroAndManualFeedbackCallsZero',
      fb.counters.modelCalls === 0
      && inst.runtimeEvidenceMatcher.describe().enabled === false
      && inst.runtimeEvidenceMatcher.describe().counters.calls === 0
      && sv.trace.matcherRelationsApplied === 0
      && sv.trace.matcherRelationsAmbiguous === 0,
      { fbModel: fb.counters.modelCalls, matcher: inst.runtimeEvidenceMatcher.describe().counters });
    check('B7.predictionErrorIsOrdinalOnly',
      (function () {
        const pe = inst.runtimePredictionSettlement.getPredictionError(pred.predictionId);
        return pe && pe.predictionErrorMetric === null && pe.settlementState === 'matched'
          && pe.calibrationEligible === true && pe.direction !== 'unknown';
      })(),
      'PE metric 恒 null');
  }

  /* ══ B2 · real HTTP ingress E2E（production route，§40）══ */
  section('B2 · real HTTP production route');
  {
    const inst = build('http');
    const port = await new Promise(resolve => {
      inst.server.listen(0, '127.0.0.1', () => resolve(inst.server.address().port));
    });
    const pred = seedPreference(inst, 'pref.like.scifi');
    const pathName = inst.runtimePreferenceReport.seam.path;
    try {
      const ok = await postJson(port, pathName, { requestId: 'http-1', characterId: 'char_a', targetKey: 'SciFi', stance: 'like' },
        { 'x-ib-home-token': TOKEN });
      const fb = inst.runtimeRealityFeedback;
      const sv = inst.runtimePredictionSettlement.getSettlement(pred.predictionId);
      check('B2a.httpRouteAcceptsTheStructuredAction',
        ok.status === 200 && ok.json && ok.json.ok === true && ok.json.outcome === 'accepted'
        && ok.json.report && ok.json.report.source === 'EXPLICIT_USER_REPORT'
        && ok.json.realityStatus === 'minted',
        { status: ok.status, body: ok.json && { ok: ok.json.ok, outcome: ok.json.outcome, reasonCode: ok.json.reasonCode } });
      check('B2b.httpRouteDrivesTheWholeSubjectiveLoop',
        fb.counters.dispatchAttempted === 1 && fb.counters.candidateCount === 1
        && fb.counters.observationCount === 1 && fb.counters.settlementCount === 1
        && !!sv && sv.state === 'matched' && sv.calibrationCounted === true
        && fb.counters.modelCalls === 0,
        { fb: fb.counters, state: sv && sv.state });
      const noCred = await postJson(port, pathName, { requestId: 'http-2', characterId: 'char_a', targetKey: 'scifi', stance: 'like' }, {});
      check('B2c.httpRouteRequiresTheDesktopCredential',
        noCred.status === 401 || noCred.status === 403,
        noCred.status);
      const wrongMethod = await request(port, pathName, 'GET', { 'x-ib-home-token': TOKEN });
      check('B2d.httpRouteIsPostOnly', wrongMethod.status === 405, wrongMethod.status);
      const malformed = await postJson(port, pathName, { requestId: 'http-3', characterId: 'char_a', targetKey: 'scifi', stance: 'love' },
        { 'x-ib-home-token': TOKEN });
      check('B2e.httpRouteAnswersExplicitRefusals',
        malformed.status === 400 && malformed.json && malformed.json.ok === false
        && String(malformed.json.reasonCode).indexOf('EXPLICIT_PREFERENCE_REPORT_') === 0,
        { status: malformed.status, reasonCode: malformed.json && malformed.json.reasonCode });
    } finally {
      await new Promise(resolve => inst.server.close(resolve));
    }
  }

  /* ══ C · raw chat comparison（§38/§39）══ */
  section('C · raw chat text is not a report');
  {
    const inst = build('rawchat');
    const t = await runTurn(inst, 'raw-1', 'I like scifi');
    const fb = inst.runtimeRealityFeedback;
    check('C1.rawChatTurnProducesNoReport',
      t.ok === true && t.outcome === 'completed'
      && inst.runtimePreferenceReport.producer.heldReportCount() === 0
      && inst.runtimePreferenceReport.realitySource.counters.attempted === 0
      && fb.counters.observationCount === 0,
      { reports: inst.runtimePreferenceReport.producer.heldReportCount(), realityEmits: inst.runtimePreferenceReport.realitySource.counters.attempted });
    check('C2.rawChatCannotCarryThePropositionByConstruction', (function () {
      const bad = act(inst, body({ requestId: 'raw-2', text: 'I like scifi' }));
      const bad2 = act(inst, body({ requestId: 'raw-3', message: 'I like scifi' }));
      const bad3 = act(inst, body({ requestId: 'raw-4', content: 'I like scifi' }));
      return [bad, bad2, bad3].every(x => x.ok === false && x.reasonCode === 'EXPLICIT_PREFERENCE_REPORT_NOT_ALLOWED_FOR_A_CALLER_TO_SELF_REPORT');
    })(), 'explicit report 面**没有**自由文本字段');
    check('C3.samePropositionDifferentRouteIsDifferentAuthority', (function () {
      const inst2 = build('rawchat2');
      seedPreference(inst2, 'pref.like.scifi');
      const viaAction = act(inst2, body({ requestId: 'raw-5' }));
      const sv = inst2.runtimePredictionSettlement.getSettlement(inst2.runtimePredictionRegistry.listOpenPredictions({ characterId: 'char_a', conversationId: 'dm:char_a' })[0].predictionId);
      return viaAction.reportMinted === true && !!sv && sv.state === 'matched';
    })(), 'A(raw chat) != report；B(structured action) = report');
  }

  /* ══ D · zero-pair ══ */
  section('D · zero-pair production E2E');
  {
    const inst = build('zero');
    const r = act(inst, body({ requestId: 'zero-1' }));
    const fb = inst.runtimeRealityFeedback;
    P('zero.Report', 1);
    P('zero.RealityEvent', 1);
    P('zero.FeedbackDispatch', fb.counters.dispatchAttempted);
    P('zero.PredictionCandidate', fb.counters.candidateCount);
    P('zero.OutcomeObservation', fb.counters.observationCount);
    P('zero.Settlement', fb.counters.settlementCount);
    check('D1.zeroPairIsSuccessNotFailure',
      r.ok === true && r.realityStatus === 'minted'
      && fb.counters.dispatchAttempted === 1 && fb.counters.dispatchCompleted === 1
      && fb.counters.candidateCount === 0 && fb.counters.observationCount === 0
      && fb.counters.settlementCount === 0,
      fb.counters);
  }

  /* ══ E · conflict ══ */
  section('E · conflict');
  {
    /* 生产路径：driver 不提供 opportunity ⇒ negation 被 directional gate 禁止。 */
    const inst = build('conflict');
    const pred = seedPreference(inst, 'pref.like.coffee');
    const r = act(inst, body({ requestId: 'conflict-1', targetKey: 'coffee', stance: 'dislike' }));
    const sv = inst.runtimePredictionSettlement.getSettlement(pred.predictionId);
    P('conflict.productionSettlement', sv && sv.state);
    P('conflict.productionReason', sv && sv.reasonCodes[0]);
    check('E1.productionConflictDoesNotProduceMissedWithoutAuthoritativeOpportunity',
      r.realityStatus === 'minted' && !!sv && sv.state !== 'missed' && sv.state !== 'matched'
      && sv.reasonCodes.indexOf('directional-conflict-forbidden-cannot-produce-missed') >= 0,
      sv && { state: sv.state, reasons: sv.reasonCodes });
    /* 受控实验（§43 · D4-R2 同款）：提供**权威** opportunity 后，互斥立场确实产 missed。
       ★ 需要 attribution known-none —— 这是 P3.0 冻结的 fail-closed 前提
         （`unknown` ≠ `none`），生产装配已接上 P5-B2 归因权威。 */
    const p2 = unitPrediction('pref.like.coffee', null, { behaviorEffectAttribution: { status: 'known-none', effects: [] } });
    const obs = tokenObs(p2, 'pref.dislike.coffee');
    const settle = createRuntimePredictionSettlement({ clock: () => T0 });
    const controlled = settle.settlePrediction(p2, [{ observation: obs }], {
      now: T0 + 2000,
      opportunity: { required: true, existence: { present: true, authoritySource: 'CANONICAL_RUNTIME' }, consumedAt: T0 + 1000 }
    });
    check('E2.mutuallyExclusiveStanceProducesMissedWhenOpportunityIsAuthoritative',
      controlled.ok === true && controlled.settlement.state === 'missed'
      && controlled.settlement.conflictSummary.decisive === 1,
      controlled.settlement && { state: controlled.settlement.state, conflict: controlled.settlement.conflictSummary });
    P('LIKE_AND_DISLIKE_ARE_MUTUALLY_EXCLUSIVE_ONLY_FOR_SAME_TARGET_AND_SCOPE', 'YES');
  }

  /* ══ F · different target ══ */
  section('F · different target');
  {
    const p = unitPrediction('pref.like.coffee');
    const obs = tokenObs(p, 'pref.like.scifi');
    const settle = createRuntimePredictionSettlement({ clock: () => T0 });
    const r = settle.settlePrediction(p, [{ observation: obs }], { now: T0 + 2000 });
    check('F1.differentTargetIsNeitherSupportNorConflict',
      r.ok === true && r.settlement.supportSummary.total === 0 && r.settlement.conflictSummary.total === 0
      && r.settlement.state !== 'matched' && r.settlement.state !== 'missed'
      && r.settlement.trace.irrelevant >= 1,
      { state: r.settlement.state, trace: r.settlement.trace });
  }

  /* ══ G · wrong scope ══ */
  section('G · wrong scope');
  {
    const inst = build('scope');
    seedPreference(inst, 'pref.like.scifi', {}, { characterId: 'char_b', conversationId: 'dm:char_b' });
    const r = act(inst, body({ requestId: 'scope-1' }));
    check('G1.wrongScopeIsNotPaired',
      r.realityStatus === 'minted' && inst.runtimeRealityFeedback.counters.candidateCount === 0
      && inst.runtimeRealityFeedback.counters.observationCount === 0,
      inst.runtimeRealityFeedback.counters);
  }

  /* ══ H · multi-pair ══ */
  section('H · multi-pair');
  {
    const inst = build('multi');
    seedPreference(inst, 'pref.like.scifi', {}, { turnId: 'm1' });
    seedPreference(inst, 'pref.like.scifi', {}, { turnId: 'm2' });
    const r = act(inst, body({ requestId: 'multi-1' }));
    const fb = inst.runtimeRealityFeedback;
    P('multi.Report', 1);
    P('multi.RealityEvent', 1);
    P('multi.Dispatch', fb.counters.dispatchAttempted);
    P('multi.Predictions', fb.counters.candidateCount);
    P('multi.Observations', fb.counters.observationCount);
    check('H1.oneReportPairsManyPredictions',
      r.realityStatus === 'minted' && fb.counters.dispatchAttempted === 1
      && fb.counters.candidateCount === 2 && fb.counters.observationCount === 2
      && fb.counters.settlementCount === 2,
      fb.counters);
    check('H2.reportAndEventIdentitiesContainNoPredictionId',
      r.report.reportId.indexOf('pref_report_') === 0
      && !Object.prototype.hasOwnProperty.call(r.report, 'predictionId')
      && !Object.prototype.hasOwnProperty.call(r.realityEvent, 'predictionId'),
      Object.keys(r.realityEvent));
  }

  /* ══ I · replay ══ */
  section('I · replay');
  {
    const inst = build('replay');
    seedPreference(inst, 'pref.like.scifi');
    let minted = 0, dup = 0;
    for (let i = 0; i < 100; i += 1) {
      const r = act(inst, body({ requestId: 'replay-1' }));
      if (r.outcome === 'accepted') minted += 1; else if (r.outcome === 'duplicate') dup += 1;
    }
    const fb = inst.runtimeRealityFeedback;
    P('replay.ReportLogical', inst.runtimePreferenceReport.producer.heldReportCount());
    P('replay.RealityEventMinted', inst.runtimePreferenceReport.realitySource.counters.minted);
    P('replay.RealityEventDuplicate', inst.runtimePreferenceReport.realitySource.counters.duplicate);
    P('replay.NormalDispatch', fb.counters.dispatchAttempted);
    check('I1.hundredReplaysYieldOneLogicalReportAndOneDispatch',
      minted === 1 && dup === 99
      && inst.runtimePreferenceReport.producer.heldReportCount() === 1
      && inst.runtimePreferenceReport.realitySource.counters.minted === 1
      && inst.runtimePreferenceReport.realitySource.counters.duplicate === 0
      && fb.counters.dispatchAttempted === 1,
      { minted, dup, reality: inst.runtimePreferenceReport.realitySource.counters, fb: fb.counters.dispatchAttempted });
  }

  /* ══ J · correction sequence ══ */
  section('J · correction is a new fact');
  {
    const inst = build('correct');
    const p = seedPreference(inst, 'pref.like.coffee');
    const t1 = act(inst, body({ requestId: 'c-1', targetKey: 'coffee', stance: 'like' }));
    const t2 = act(inst, body({ requestId: 'c-2', targetKey: 'coffee', stance: 'dislike' }));
    check('J1.correctionCreatesANewReportAndANewRealityEvent',
      t1.reportMinted === true && t2.reportMinted === true
      && t1.reportId !== t2.reportId
      && t1.realityEvent.realityEventId !== t2.realityEvent.realityEventId
      && inst.runtimePreferenceReport.producer.heldReportCount() === 2
      && inst.runtimePreferenceReport.realitySource.counters.minted === 2,
      { r1: t1.reportId, r2: t2.reportId });
    check('J2.firstReportIsNotMutatedOrDeleted',
      t1.report.stance === 'like' && Object.isFrozen(t1.report) === true
      && inst.runtimePreferenceReport.producer.isExplicitPreferenceReport(t1.report) === true,
      'REPORT_HISTORY_REWRITE = NO');
    const sv = inst.runtimePredictionSettlement.getSettlement(p.predictionId);
    P('correction.settlement', sv && sv.state);
  }

  /* ══ K · failure isolation ══ */
  section('K · failure isolation');
  {
    /* producer 失败 ⇒ 显式失败，不铸半点东西 */
    const brokenProducer = createRuntimeExplicitPreferenceReport({
      clock: () => T0,
      logger: null
    });
    const SEAM_MOD = require(path.join(ROOT, 'services/home-node/explicit-preference-report-seam.js'));
    const failing = SEAM_MOD.createExplicitPreferenceReportSeam({
      reportProducer: { submit: () => { throw new Error('boom'); } },
      realitySink: () => ({ ok: true, status: 'minted' }),
      characterRegistry: { getCharacterSpec: () => ({ id: 'char_a' }) },
      desktopCredential: TOKEN, clock: () => T0, logger: () => {}
    });
    const k1 = failing.dispatch({ loopback: true, desktopCredential: TOKEN }, body({ requestId: 'k1' }));
    check('K1.producerFailureIsExplicitAndMintsNothing',
      k1.ok === false && k1.reasonCode === SEAM_MOD.REFUSAL.PRODUCER_REFUSED
      && k1.report === null && k1.reportMinted === false && k1.realityEvent === null,
      k1);
    /* RealityEvent mint 失败 ⇒ report 仍然成立（upstream truth） */
    const inst = build('failreality');
    const re = createRuntimeRealityEvent({});
    const SRC_MOD = require(path.join(ROOT, 'services/home-node/explicit-preference-report-reality-source.js'));
    const brokenSource = SRC_MOD.createExplicitPreferenceReportRealitySource({ realityEvent: null });
    const producer = createRuntimeExplicitPreferenceReport({ clock: () => T0 });
    check('K2.realityMintFailureDoesNotRewriteTheReport', (function () {
      const minted = producer.submit({ actionId: 'pref_action_k2', characterId: 'char_a', conversationId: 'dm:char_a', targetKey: 'scifi', stance: 'like' });
      const emitted = brokenSource.emit(minted.report);
      return minted.ok === true && emitted.ok === false && emitted.reasonCode === 'reality-authority-unavailable'
        && producer.isExplicitPreferenceReport(minted.report) === true
        && producer.heldReportCount() === 1;
    })(), 'REPORT_FACT_IS_UPSTREAM_TRUTH');
    /* 下游订阅者抛错 ⇒ RealityEvent mint 仍然成立（D4 冻结语义不变） */
    const throwing = createRuntimeRealityEvent({ onRealityEventMinted: () => { throw new Error('subscriber boom'); } });
    check('K3.subscriberFailureDoesNotBreakRealityMint',
      (function () {
        const r = re.ingest({ sourceId: 'runtime-delivery', sourceEvent: { eventId: 'k3', domain: 'delivery', type: 'completed', entityId: 'd1', timestamp: T0 } });
        const r2 = throwing.ingest({ sourceId: 'runtime-delivery', sourceEvent: { eventId: 'k3b', domain: 'delivery', type: 'completed', entityId: 'd1', timestamp: T0 } });
        return r.ok === true && r2.ok === true && r2.status === 'minted';
      })(),
      'REALITY_EVENT_MINT IS UPSTREAM TRUTH OF FEEDBACK');
    /* feedback 失败 ⇒ report + RealityEvent 都保留（上游真相不被回滚） */
    const FB_MOD = require(path.join(ROOT, 'services/home-node/runtime-reality-feedback.js'));
    check('K4.feedbackFailureLeavesReportAndRealityIntact',
      (function () {
        const producer2 = createRuntimeExplicitPreferenceReport({ clock: () => T0 });
        const minted = producer2.submit({ actionId: 'pref_action_k4', characterId: 'char_a', conversationId: 'dm:char_a', targetKey: 'scifi', stance: 'like' });
        const emitted = SRC_MOD.createExplicitPreferenceReportRealitySource({ realityEvent: re }).emit(minted.report);
        /* driver 缺 registry ⇒ 反馈无法编排（失败），但两件事实都还在 */
        const brokenDriver = FB_MOD.createRuntimeRealityFeedback({ isRealityEvent: re.isRealityEvent });
        const fbResult = brokenDriver.processRealityEvent(emitted.realityEvent);
        return emitted.status === 'minted'
          && fbResult.ok === false && fbResult.reasonCode === FB_MOD.REASON.registryUnavailable
          && producer2.isExplicitPreferenceReport(minted.report) === true
          && re.isRealityEvent(emitted.realityEvent) === true;
      })(),
      'FEEDBACK_FAILURE MUST_NOT_REWRITE SOURCE_FACT_OR_REALITY_EVENT');
    P('CHAT_SUCCESS_DOES_NOT_DEPEND_ON_PREDICTION_FEEDBACK', 'YES');
  }

  /* ══ L · matcher / calibration / memory boundaries ══ */
  section('L · boundaries');
  {
    check('L1.matcherRemainsOff',
      SETTLE_CORE.EVIDENCE_MATCHER_INVOCATION === 'OFF'
      && SETTLE_CORE.STATE_SUPPORT.matcherMaySupplyAuthority === 'NO'
      && code('services/home-node-service.js').indexOf('enabled: false') >= 0,
      'EVIDENCE_MATCHER_ENABLED_DEFAULT = false');
    check('L2.noMemoryOrRelationshipWriteInTheSubjectivePath',
      SETTLE_CORE.STATE_SUPPORT.memoryAuthority === 'NONE'
      && SETTLE_CORE.STATE_SUPPORT.relationshipAuthority === 'NONE'
      && SETTLE_CORE.STATE_SUPPORT.calibrationWriteback === 'NONE'
      && !/require\([^)]*(memory-store|relationship)/i.test(code('services/home-node/runtime-explicit-preference-report.js')),
      'MEMORY_WRITE = NONE · RELATIONSHIP_WRITE = NONE');
    check('L3.calibrationIsCountedButNeverApplied',
      SETTLE_CORE.PREDICTION_ERROR_METRIC === null
      && SETTLE_CORE.STATE_SUPPORT.predictionError === 'ORDINAL_ONLY',
      'CALIBRATION_CONFIDENCE = null · CALIBRATION_APPLIED_TO_LIVE = NO');
    check('L4.absenceOfReportIsNeverContradiction',
      (function () {
        const p = unitPrediction('pref.like.scifi');
        const settle = createRuntimePredictionSettlement({ clock: () => T0 });
        const r = settle.settlePrediction(p, [], {
          now: p.observationWindow.closesAt + 1,
          opportunity: { required: true, existence: { present: false, authoritySource: 'CANONICAL_RUNTIME' } }
        });
        return r.ok === true && r.settlement.state !== 'missed' && r.settlement.conflictSummary.decisive === 0;
      })(),
      'ABSENCE_OF_REPORT != CONTRADICTION');
  }

  /* ══ M · readiness ══ */
  section('M · readiness');
  {
    P('MECHANICAL_FEEDBACK_LOOP_PRODUCTION_LIVE', 'YES');
    P('STRUCTURED_EXPLICIT_USER_REPORT_PRODUCTION_LIVE', 'YES');
    P('FREE_TEXT_EXPLICIT_USER_REPORT_PRODUCTION_LIVE', 'NO');
    P('SUBJECTIVE_FEEDBACK_LOOP_PRODUCTION_LIVE', 'YES');
    P('P3_DECISIVE_SUBJECTIVE_SETTLEMENT', 'REACHABLE（matched / missed 见 E2 受控实验）');
    P('MATCHER_CALLS_ON_STRUCTURED_PREFERENCE_PATH', 0);
    P('EVIDENCE_MATCHER_ENABLED_DEFAULT', false);
    P('CALIBRATION_CONFIDENCE', 'null');
    P('CALIBRATION_APPLIED_TO_LIVE', 'NO');
    P('P1_CORE_TRACKING_DEBT', 'OPEN');
    P('TURN_TERMINAL_OUTCOME_DIRECTIONAL_DISCRIMINATION', 'CAPABILITY_GAP');
    P('MULTI_HOME_NODE_FEEDBACK_ROUTING', 'ONE_HOME_NODE_INSTANCE_PER_PROCESS');
  }

  console.log('\n' + '='.repeat(64));
  if (failures) {
    console.error('SUBJECTIVE PREFERENCE FEEDBACK FAILED · ' + failures + ' assertion(s), ' + passed + ' passed');
    process.exit(1);
  }
  console.log('SUBJECTIVE PREFERENCE FEEDBACK PASSED · ' + passed + ' assertions green');
})().catch((e) => { console.error('CRASHED', e && e.stack); process.exit(1); });
