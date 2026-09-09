/* ====================================================================
   P11-2A · Character Integrity Calibration Harness · Layer A（确定性契约校准）
   --------------------------------------------------------------------
   目标：回答"P11-2 这把尺子到底准不准？"，且**不碰生产**。
   做法：把仓库真实的 config / policy / astra / integrity 四层脚本原样加载进沙箱
        （唯一被替换的是 HTTP 传输与 IndexedDB 读写），因此
          - Judge prompt 是生产的；
          - Judge JSON 解析是生产的（_mbParseCiJson）；
          - Rewrite Gate 是生产的（_mbCiGate）；
          - telemetry 是生产实现（沙箱内的独立实例）；
          - 没有任何一行业务判定被本测试重新实现。
   覆盖（Layer A 契约校准）：
     A. schema 与通道分离：Ground Truth 与 Judge 观测结构上不可混用
     B. 指标正确性：confusion / precision / recall / specificity / F1 / FPR / FNR 边界情况
     C. Judge → Gate → Rewrite 三级分离（Judge 正确但 Gate 拦住 ≠ 失败）
     D. dimension confusion：exact / superset / subset / partial / missing_all / spurious
     E. sensitivity 模拟：conservative / balanced / strict（不修改生产 config）
     F. 边界分数分析：贴线判定 + 跨档翻转
     G. knowledge_boundary 无证据保护（违反即记违规）
     H. 零污染：不写配置 / 不写存储 / 不触发真实 rewrite / 不产生任何网络请求
     I. 真实 Guard 与纯 Gate 判定等价（同一批 case × 三档）
   运行：node test_middle_brain_calibration.js  （零依赖、离线、确定性）
   ==================================================================== */
'use strict';

const fs = require('fs'), path = require('path');

let failures = 0;
const check = (name, cond, detail) => {
  if (cond) console.log('  PASS  ' + name);
  else { failures++; console.error('  FAIL  ' + name + (detail ? '  -> ' + detail : '')); }
};

const CAL = require('./middle-brain-calibration.js');
const DATA = require('./middle-brain-calibration-cases.js');
const CASES = DATA.CASES;

/* ── 真实生产层沙箱：只替换 HTTP 传输 + IndexedDB ── */
function readLayer(rel) { return fs.readFileSync(path.join(__dirname, rel), 'utf8').replace(/^\uFEFF/, ''); }

function loadProductionSandbox(opts) {
  opts = opts || {};
  const transport = { calls: [], judgePayload: null, rewritePayload: null, judgeMode: 'ok', rewriteMode: 'ok' };
  const store = { apiSettings: {} };
  const dbWrites = [];
  store.apiSettings.middle_brain = Object.assign({
    enabled: true, provider: 'astra', endpoint: 'https://calibration.invalid/v1/responses',
    model: 'cal-model', apiKey: 'cal-key', reasoningEffort: 'medium', speed: 'standard',
    characterIntegrityEnabled: true, characterIntegritySensitivity: 'conservative',
    characterIntegrityRewrite: true, characterIntegrityVerify: false
  }, opts.mbConfig || {});

  const providerDir = require(path.join(__dirname, 'assets', 'js', 'provider-directory.js'));
  const body =
    'var root=self;\n' +
    readLayer('assets/js/ib-model-core.js') + '\n' +
    readLayer('assets/js/context-snapshot.js') + '\n' +
    readLayer('assets/js/middle-brain-config.js') + '\n' +
    readLayer('assets/js/middle-brain-policy.js') + '\n' +
    readLayer('assets/js/middle-brain-astra.js') + '\n' +
    readLayer('assets/js/middle-brain-integrity.js') + '\n' +
    ';return self.IB.__middleBrainContracts;';
  const factory = new Function('self', 'module', 'document', 'dbGet', 'dbPut', 'require', body);
  const self = { PROVIDERS_DIR: providerDir };
  const documentStub = { getElementById: () => null, readyState: 'complete', addEventListener: () => {} };
  const MBC = factory(
    self, undefined, documentStub,
    async (s, k) => (s === 'apiSettings' ? store.apiSettings[k] : undefined),
    async (s, d) => { dbWrites.push({ store: s, id: d && d.id }); if (s === 'apiSettings') store.apiSettings[d.id] = JSON.parse(JSON.stringify(d)); },
    require
  );

  /* 唯一网络边界被替换成确定性桩：按 schemaName 区分 judge / rewrite */
  self._ibApiPost = async function (endpoint, headers, bodyStr) {
    let b = {};
    try { b = JSON.parse(bodyStr); } catch (e) {}
    const name = (b.text && b.text.format && b.text.format.name) || '';
    transport.calls.push({ endpoint, name });
    const responses = (text) => ({
      ok: true,
      json: async () => ({ output: [{ type: 'message', content: [{ type: 'output_text', text: String(text) }] }], usage: { input_tokens: 1, output_tokens: 1 } })
    });
    if (name === 'character_integrity_report') {
      if (transport.judgeMode === 'fail') return { ok: false, status: 500, json: async () => ({}) };
      return responses(transport.judgePayload == null ? JSON.stringify({ pass: true, score: 0.95, confidence: 0.9, violations: [] }) : transport.judgePayload);
    }
    if (name === 'character_integrity_rewrite') {
      if (transport.rewriteMode === 'fail') return { ok: false, status: 500, json: async () => ({}) };
      return responses(transport.rewritePayload == null ? JSON.stringify({ reply: 'CAL_REWRITTEN' }) : transport.rewritePayload);
    }
    return responses('{}');
  };

  /* 真实层契约引用（用于断言 deps 就是生产实现，不是本测试的替代品） */
  const integrity = MBC.integrity;
  return {
    MBC, self, store, dbWrites, transport,
    parseJudge: integrity._mbParseCiJson,
    gate: (sensitivity, report) => integrity._mbCiGate(report, {
      characterIntegrityRewrite: true, characterIntegritySensitivity: sensitivity
    }, {}),
    buildEvidence: (characterId, userMessage, o) => integrity._mbCiBuildEvidence(characterId, userMessage, o),
    guard: integrity.middleBrainCharacterIntegrity,
    telemetry: integrity.middleBrainCharacterIntegrityTelemetry,
    resetTelemetry: integrity.middleBrainCharacterIntegrityReset,
    sensitivities: integrity.MB_CI_SENSITIVITY,
    dimensions: integrity.MB_CI_DIMENSIONS,
    judgePrompt: integrity._mbCiJudgePrompt,
    visibleText: integrity._mbCiVisibleText,
    schema: integrity.MB_CI_SCHEMA,
    snapshot: self.IBContextSnapshot
  };
}

/* canonical context snapshot（真实 context-snapshot.js 构造） */
function snapshotFor(sbx, caseObj) {
  const CS = sbx.snapshot;
  const ctx = caseObj.context || {};
  const fields = {};
  ['memory', 'understanding', 'thread', 'moments'].forEach(name => {
    fields[name] = ctx[name] ? CS.field('cal:' + name, ctx[name]) : CS.field('cal:' + name, '');
  });
  return CS.create({ characterId: caseObj.character.id, turnId: 'cal', fields, gates: {} });
}
function guardOpts(sbx, caseObj) {
  return {
    character: caseObj.character,
    history: caseObj.history || [],
    contextSnapshot: snapshotFor(sbx, caseObj)
  };
}
function evidenceAvailable(sbx, caseObj) {
  return sbx.buildEvidence(caseObj.character.id, caseObj.userMessage, guardOpts(sbx, caseObj)).available;
}

console.log('P11-2A · Character Integrity Calibration Harness (Layer A)\n');

const sbx = loadProductionSandbox();
const deps = {
  parseJudge: sbx.parseJudge,
  gate: sbx.gate,
  productionSensitivity: 'conservative',
  evidenceAvailable: (c) => evidenceAvailable(sbx, c)
};
/* 全量校准结果（后续 A–I 各节都会引用；纯计算，不产生副作用） */
const RES = CAL.runCalibration(CASES, deps);

/* ═══════════════ A. schema 与通道分离 ═══════════════ */
check('A1.realProductionLayersLoaded', !!sbx.MBC.config && !!sbx.MBC.policy && !!sbx.MBC.astra && !!sbx.MBC.integrity
  && typeof sbx.parseJudge === 'function' && typeof sbx.gate === 'function');
check('A2.depsAreProductionImpl', deps.parseJudge === sbx.MBC.integrity._mbParseCiJson
  && deps.gate('conservative', { pass: false, score: 0.1, confidence: 0.9, violations: [], maxSeverity: 0.9 }).thresholds.confidence === sbx.sensitivities.conservative.confidence);
check('A3.caseSetValid', CAL.validateCases(CASES).length === 0, CAL.validateCases(CASES).slice(0, 3).join(' | '));
check('A4.caseCountAndCharacters', CASES.length >= 120 && new Set(CASES.map(c => c.character.id)).size >= 5,
  CASES.length + ' cases / ' + new Set(CASES.map(c => c.character.id)).size + ' characters');
check('A5.groundTruthInJudgeRejected', CAL.validateCase({
  id: 'x', category: 'x', character: { id: 'c' }, userMessage: 'u', candidate: 'c', reason: 'r',
  expected: { ooc: false, dimensions: [], rewriteExpected: false },
  observedJudge: { pass: true, score: 0.9 }
}).some(e => /非观测键/.test(e)));
check('A6.judgeInGroundTruthRejected', CAL.validateCase({
  id: 'x', category: 'x', character: { id: 'c' }, userMessage: 'u', candidate: 'c', reason: 'r',
  expected: { ooc: false, dimensions: [], rewriteExpected: false, pass: true },
  observedJudge: { raw: '{}' }
}).some(e => /非 ground-truth 键/.test(e)));
check('A7.missingObservationRejected', CAL.validateCase({
  id: 'x', category: 'x', character: { id: 'c' }, userMessage: 'u', candidate: 'c', reason: 'r',
  expected: { ooc: false, dimensions: [], rewriteExpected: false }
}).some(e => /observedJudge 缺失/.test(e)));
check('A8.contradictoryGroundTruthRejected', CAL.validateCase({
  id: 'x', category: 'x', character: { id: 'c' }, userMessage: 'u', candidate: 'c', reason: 'r',
  expected: { ooc: false, dimensions: ['persona'], rewriteExpected: true }, observedJudge: { raw: '{}' }
}).length >= 2);
check('A9.duplicateIdRejected', CAL.validateCases([CASES[0], CASES[0]]).some(e => /id 重复/.test(e)));
check('A10.nonWhitelistDimensionRejected', CAL.validateCase({
  id: 'x', category: 'x', character: { id: 'c' }, userMessage: 'u', candidate: 'c', reason: 'r',
  expected: { ooc: true, dimensions: ['vibes'], rewriteExpected: true }, observedJudge: { raw: '{}' }
}).some(e => /非白名单/.test(e)));
check('A11.channelIndependence', (() => {
  const base = { id: 'sep', category: 'sep', character: { id: 'c' }, userMessage: 'u', candidate: 'c', reason: 'r', history: [] };
  const clean = Object.assign({}, base, { expected: { ooc: false, dimensions: [], rewriteExpected: false }, observedJudge: { raw: JSON.stringify({ pass: true, score: 0.9, confidence: 0.9, violations: [] }) } });
  const flippedJudge = Object.assign({}, base, { expected: clean.expected, observedJudge: { raw: JSON.stringify({ pass: false, score: 0.1, confidence: 0.9, violations: [{ dimension: 'persona', severity: 0.9, evidence: 'e', reason: 'r' }] }) } });
  const flippedTruth = Object.assign({}, base, { expected: { ooc: true, dimensions: ['persona'], rewriteExpected: true }, observedJudge: clean.observedJudge });
  const r = [clean, flippedJudge, flippedTruth].map(c => CAL.evaluateCase(c, deps));
  return r[0].judgeCorrect === true && r[1].judgeCorrect === false && r[2].judgeCorrect === false
    && r[0].expected.ooc === false && r[2].expected.ooc === true;
})());

/* ═══════════════ B. 指标正确性 + 边界情况 ═══════════════ */
check('B1.confusionCounts', (() => {
  const c = CAL.confusion([[true, true], [true, true], [false, false], [false, true], [true, false]]);
  return c.tp === 2 && c.tn === 1 && c.fp === 1 && c.fn === 1 && c.total === 5;
})());
check('B2.metricsMath', (() => {
  const c = CAL.confusion([[true, true], [true, true], [true, false], [false, true], [false, false], [false, false]]);
  const near = (a, b) => Math.abs(a - b) < 1e-9;
  return c.tp === 2 && c.fp === 1 && c.fn === 1 && c.tn === 2
    && near(c.precision, 2 / 3) && near(c.recall, 2 / 3) && near(c.f1, 2 / 3)
    && near(c.specificity, 2 / 3) && near(c.falsePositiveRate, 1 / 3) && near(c.falseNegativeRate, 1 / 3)
    && near(c.accuracy, 4 / 6);
})());
check('B3.edgeNoPositives', (() => {
  const c = CAL.confusion([[false, false], [false, false]]);
  return c.precision === null && c.recall === null && c.f1 === null && c.specificity === 1 && c.falsePositiveRate === 0;
})());
check('B4.edgeNoNegatives', (() => {
  const c = CAL.confusion([[true, true]]);
  return c.precision === 1 && c.recall === 1 && c.f1 === 1 && c.specificity === null && c.falsePositiveRate === null;
})());
check('B5.edgeAllWrong', (() => {
  const c = CAL.confusion([[true, false], [false, true]]);
  return c.tp === 0 && c.tn === 0 && c.fp === 1 && c.fn === 1 && c.precision === 0 && c.recall === 0 && c.f1 === 0 && c.accuracy === 0;
})());
check('B6.edgeEmpty', (() => {
  const c = CAL.confusion([]);
  return c.total === 0 && c.precision === null && c.accuracy === null;
})());
check('B7.ratioZeroDenominator', CAL.ratio(1, 0) === null && CAL.ratio(0, 0) === null && CAL.ratio(1, 2) === 0.5);

/* ═══════════════ C. Judge → Gate → Rewrite 三级分离 ═══════════════ */
const byId = {};
CASES.forEach(c => { byId[c.id] = c; });
const evalOne = (id) => CAL.evaluateCase(byId[id], deps);

check('C1.judgeCorrectGateBlockedIsNotFailure', (() => {
  /* Judge 正确识别出 OOC（自评把握不足）→ 保守档正确地不重写：Judge 正确、Gate 决策与 ground truth 不同 */
  const r = evalOne('ooc-behavior_constraint-builder');
  return r.judgeCorrect === true && r.judgedOoc === true && r.rewrite === false
    && r.rewriteReason === 'low_confidence' && r.interventionCorrect === false;
})());
check('C2.judgeFpStillRecordedWhenGateBlocks', (() => {
  const r = evalOne('fp-anger-builder');
  return r.judgeCorrect === false && r.judgedOoc === true && r.rewrite === false && r.interventionCorrect === true;
})());
check('C3.telemetryVsIntervention', (() => {
  const r = evalOne('fp-user-short-companion');
  return r.judge.telemetryClass === 'fail' && r.judge.status === 'clean' && r.rewrite === false && r.rewriteReason === 'judge_pass';
})());
check('C4.transportErrorIsNotJudgeDecision', (() => {
  const r = evalOne('tr-error-ooc-timeout');
  return r.judge.status === 'error' && r.decided === false && r.judgeCorrect === null && r.rewrite === false && r.rewriteReason === 'no_report';
})());
check('C5.gateOnlyEvaluatedWhenJudgeOoc', (() => {
  const clean = evalOne('fp-smalltalk-companion'), ooc = evalOne('ooc-persona_inversion-companion');
  return clean.gateRan === false && clean.gateCorrect === null && ooc.gateRan === true && typeof ooc.gateCorrect === 'boolean';
})());

/* ═══════════════ D. Dimension confusion ═══════════════ */
check('D1.disjoint', evalOne('dc-relationship-as-emotional').dimension.match === 'disjoint'
  && evalOne('dc-relationship-as-emotional').dimension.extra[0] === 'emotional_continuity');
check('D2.supersetExtra', (() => {
  const r = evalOne('dc-relationship-plus-speech');
  return r.dimension.match === 'superset' && r.dimension.extra.indexOf('speech_style') >= 0 && r.dimension.missing.length === 0;
})());
check('D3.subset', (() => {
  const r = evalOne('dc-subset-emotional');
  return r.dimension.match === 'subset' && r.dimension.missing.indexOf('behavior') >= 0;
})());
check('D4.partial', evalOne('dc-partial-mixed').dimension.match === 'partial');
check('D5.exactOrderInsensitive', evalOne('dc-exact-reordered').dimension.match === 'exact');
check('D6.missingAll', evalOne('dc-behavior-missed-empty').dimension.match === 'missing_all');
check('D7.spuriousOnlyOnClean', (() => {
  const r = evalOne('fp-anger-cold');
  return r.expected.ooc === false && r.dimension.match === 'spurious_only' && r.dimension.extra.indexOf('speech_style') >= 0;
})());
check('D8.watchSpeechStyle', (() => {
  const w = RES.watchDimensions.speech_style;
  return w && w.reported > 0 && w.falseKill > 0 && w.swallowed > 0 && w.falseKill > w.swallowed
    && w.correct + w.falseKill + w.swallowed === w.reported
    && w.falseKillIds.every(id => byId[id]) && w.swallowedIds.every(id => byId[id]);
})(), JSON.stringify(RES.watchDimensions.speech_style));
check('D9.watchEmotionalContinuity', (() => {
  const w = RES.watchDimensions.emotional_continuity;
  return w && w.reported > 0 && w.falseKill > 0 && w.swallowed > 0 && w.swallowed > w.falseKill
    && w.correct + w.falseKill + w.swallowed === w.reported;
})(), JSON.stringify(RES.watchDimensions.emotional_continuity));
check('D10.watchCountsMatchPerDimension', (() => {
  const ss = RES.watchDimensions.speech_style, ec = RES.watchDimensions.emotional_continuity;
  return ss.falseKill + ss.swallowed === RES.byDimension.speech_style.fp
    && ss.correct === RES.byDimension.speech_style.tp
    && ec.falseKill + ec.swallowed === RES.byDimension.emotional_continuity.fp
    && ec.correct === RES.byDimension.emotional_continuity.tp;
})());

/* ═══════════════ E. 全量校准 + sensitivity 模拟 ═══════════════ */
check('E1.productionConfigUntouched', (() => {
  const before = JSON.stringify(sbx.store.apiSettings.middle_brain);
  CAL.runCalibration(CASES, deps);
  return sbx.dbWrites.length === 0 && JSON.stringify(sbx.store.apiSettings.middle_brain) === before;
})(), 'dbWrites=' + sbx.dbWrites.length);
check('E2.noNetworkDuringCalibration', sbx.transport.calls.length === 0, 'transport calls=' + sbx.transport.calls.length);
check('E3.allCasesEvaluated', RES.cases === CASES.length && RES.rows.length === CASES.length);
check('E4.sensitivityThresholdsAreProduction', (() => {
  const s = RES.bySensitivity;
  return s.conservative.thresholds.confidence === sbx.sensitivities.conservative.confidence
    && s.balanced.thresholds.score === sbx.sensitivities.balanced.score
    && s.strict.thresholds.severity === sbx.sensitivities.strict.severity;
})());
check('E5.strictRewritesMoreThanConservative', RES.bySensitivity.strict.rewrites > RES.bySensitivity.conservative.rewrites,
  'conservative=' + RES.bySensitivity.conservative.rewrites + ' strict=' + RES.bySensitivity.strict.rewrites);
check('E6.conservativeFpNotMoreThanStrict', RES.bySensitivity.conservative.confusion.fp <= RES.bySensitivity.strict.confusion.fp);
check('E7.productionSensitivityConservative', RES.productionSensitivity === 'conservative'
  && RES.intervention.total === CASES.length);
check('E8.judgeConfusionSumsToDecided', (() => {
  const d = RES.judge.decision;
  return d.total === CASES.length - RES.judge.errors - RES.judge.malformed
    && d.tp + d.tn + d.fp + d.fn === d.total;
})());
check('E9.effectiveTreatsErrorsAsNoIntervention', (() => {
  const e = RES.judge.effective;
  return e.total === CASES.length && e.fn >= RES.judge.decision.fn;
})());
check('E10.deterministic', JSON.stringify(CAL.runCalibration(CASES, deps)) === JSON.stringify(RES));
check('E11.perDimensionLabels', (() => {
  const m = RES.byDimension;
  return CAL.DIMENSIONS.every(d => m[d] && typeof m[d].tp === 'number' && typeof m[d].fp === 'number' && typeof m[d].fn === 'number');
})());
check('E12.byCategoryAndCharacter', Object.keys(RES.byCategory).length >= 20 && Object.keys(RES.byCharacter).length >= 5);

/* ═══════════════ F. 边界分数分析 ═══════════════ */
check('F1.boundaryExactScoreDetected', (() => {
  const r = evalOne('bd-conservative-exact-score');
  const b = r.boundary.conservative;
  return b.isBoundary === true && b.decisive === 'score' && Math.abs(b.margins.score) < 1e-9 && r.rewrite === true;
})());
check('F2.boundaryJustAboveIsBlockedAndBoundary', (() => {
  const r = evalOne('bd-conservative-just-above-score');
  const b = r.boundary.conservative;
  return b.isBoundary === true && b.margins.score < 0 && r.rewrite === false && r.rewriteReason === 'score_above_threshold';
})());
check('F3.nonBoundaryCase', (() => {
  const r = evalOne('fp-smalltalk-companion');
  return r.boundary.conservative.isBoundary === false;
})());
check('F4.boundaryCasesReported', RES.boundary.cases.length >= 10, 'boundary=' + RES.boundary.cases.length);
check('F5.sensitivityFlipsDetected', RES.boundary.flips.length >= 5, 'flips=' + RES.boundary.flips.length);
check('F6.flipsHaveDifferentDecisions', RES.boundary.flips.every(f => f.conservative !== f.strict));
check('F7.boundaryBandMatchesProductionThresholds', CAL.BOUNDARY_BAND.confidence === 0.05
  && sbx.sensitivities.conservative.confidence === 0.8 && sbx.sensitivities.strict.score === 0.55);

/* ═══════════════ G. knowledge_boundary 无证据保护 ═══════════════ */
check('G1.noEvidenceAvailabilityFalse', (() => {
  const c = byId['kb-no-evidence-1'];
  return evidenceAvailable(sbx, c).knowledge_boundary === false;
})());
check('G2.evidenceAvailabilityTrue', (() => {
  const c = byId['kb-evidence-memory-name'];
  return evidenceAvailable(sbx, c).knowledge_boundary === true;
})());
check('G3.injectedViolationDetected', (() => {
  const r = evalOne('kb-no-evidence-injected-violation');
  return r.knowledgeBoundaryViolation === true && r.knowledgeBoundaryAvailable === false;
})());
check('G4.noUnexpectedViolations', (() => {
  const ids = RES.knowledgeBoundary.withoutEvidence.violationIds;
  return ids.length === 1 && ids[0] === 'kb-no-evidence-injected-violation';
})(), JSON.stringify(RES.knowledgeBoundary.withoutEvidence.violationIds));
check('G5.evidenceCaseDetected', (() => {
  const r = evalOne('kb-evidence-memory-name');
  return r.judge.dimensions.indexOf('knowledge_boundary') >= 0 && r.rewrite === true && r.interventionCorrect === true;
})());
check('G6.noEvidenceCategoryNotRewritten', RES.knowledgeBoundary.category.withoutEvidence === 8
  && RES.knowledgeBoundary.category.withoutEvidenceJudgedOoc === 1
  && RES.knowledgeBoundary.category.withoutEvidenceRewrites === 1
  && RES.knowledgeBoundary.category.withEvidence === 4,
  JSON.stringify(RES.knowledgeBoundary.category));
check('G7.judgePromptDeclaresUnavailable', (() => {
  const c = byId['kb-no-evidence-1'];
  const ev = sbx.buildEvidence(c.character.id, c.userMessage, guardOpts(sbx, c));
  const prompt = sbx.judgePrompt(ev, c.candidate);
  return /knowledge_boundary/.test(prompt) && /【证据不可用】[\s\S]*knowledge_boundary/.test(prompt);
})());

/* ═══════════════ H. 零污染（校准不写生产状态 / 不触发真实副作用） ═══════════════ */
check('H1.noDbWritesAtAll', sbx.dbWrites.length === 0);
check('H2.noTransportCallsAtAll', sbx.transport.calls.length === 0);
check('H3.calibrationDoesNotTouchTelemetry', sbx.telemetry().checked === 0 && sbx.telemetry().judgeRuns === 0,
  JSON.stringify({ checked: sbx.telemetry().checked, judgeRuns: sbx.telemetry().judgeRuns }));
check('H4.noProductionFileModified', (() => {
  const before = fs.readFileSync(path.join(__dirname, 'assets', 'js', 'middle-brain-integrity.js'), 'utf8');
  CAL.runCalibration(CASES, deps);
  return fs.readFileSync(path.join(__dirname, 'assets', 'js', 'middle-brain-integrity.js'), 'utf8') === before;
})());
check('H5.harnessNotLoadedInHtml', !/middle-brain-calibration/.test(fs.readFileSync(path.join(__dirname, 'InternalBeyond.html'), 'utf8')));
check('H6.harnessNotInProductionAssets', !fs.existsSync(path.join(__dirname, 'assets', 'js', 'middle-brain-calibration.js'))
  && !fs.existsSync(path.join(__dirname, 'assets', 'js', 'middle-brain-calibration-cases.js')));
check('H7.noProductionFileReferencesHarness', (() => {
  const dir = path.join(__dirname, 'assets', 'js');
  const hits = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.js$/.test(e.name) && /middle-brain-calibration/.test(fs.readFileSync(p, 'utf8'))) hits.push(path.relative(__dirname, p));
    }
  })(dir);
  return hits.length === 0;
})());

/* ═══════════════ I. 真实 Guard 与纯 Gate 等价（生产执行路径 = 被校准的对象） ═══════════════ */
(async () => {
  const sampleIds = [
    'ooc-persona_inversion-companion', 'ooc-behavior_constraint-builder', 'ooc-long_term_attitude_shift-cold',
    'fp-anger-cold', 'fp-user-formal-cold', 'fp-user-short-companion', 'fp-smalltalk-companion',
    'bd-conservative-exact-score', 'bd-conservative-just-above-score', 'bd-strict-exact-triple',
    'dc-relationship-as-emotional', 'tr-malformed-ooc-truncated'
  ];
  let equivalenceOk = true, equivalenceDetail = '', rewritesMax = 0, guardCalls = 0, malformedHandled = true;
  const mismatch = [];
  sbx.resetTelemetry();
  for (const sensitivity of CAL.SENSITIVITIES) {
    for (const id of sampleIds) {
      const c = byId[id];
      const simulated = sbx.gate(sensitivity, sbx.parseJudge(c.observedJudge.raw == null ? 'null' : c.observedJudge.raw));
      sbx.store.apiSettings.middle_brain.characterIntegritySensitivity = sensitivity;
      sbx.store.apiSettings.middle_brain.characterIntegrityRewrite = true;
      sbx.transport.calls.length = 0;
      sbx.transport.judgePayload = c.observedJudge.error ? null : c.observedJudge.raw;
      sbx.transport.judgeMode = c.observedJudge.error ? 'fail' : 'ok';
      sbx.transport.rewritePayload = JSON.stringify({ reply: 'CAL_REWRITTEN' });
      const before = sbx.transport.calls.length;
      const out = await sbx.guard(c.character.id, c.userMessage, c.candidate, guardOpts(sbx, c));
      guardCalls++;
      const judgeCalls = sbx.transport.calls.filter(x => x.name === 'character_integrity_report').length;
      const rewriteCalls = sbx.transport.calls.filter(x => x.name === 'character_integrity_rewrite').length;
      rewritesMax = Math.max(rewritesMax, rewriteCalls);
      const guardRewrote = rewriteCalls > 0;
      /* 等价性只在 Judge 真的给出了 report 时成立（错误/畸形 → 生产 no_report，同样不重写） */
      if (simulated.reason !== 'no_report' && guardRewrote !== simulated.rewrite) {
        equivalenceOk = false;
        mismatch.push(sensitivity + '/' + id + ' guard=' + guardRewrote + ' gate=' + simulated.rewrite);
      }
      if (simulated.reason === 'no_report' && guardRewrote) {
        equivalenceOk = false; mismatch.push(sensitivity + '/' + id + ' 无 report 却重写');
      }
      if (c.observedJudge.error && judgeCalls !== 1) malformedHandled = false;
      if (!c.observedJudge.error && judgeCalls !== 1) malformedHandled = false;
      if (rewriteCalls > 1) equivalenceOk = false;
      if (before !== 0) equivalenceDetail = 'stub 未清空';
    }
  }
  check('I1.guardMatchesPureGateAllSensitivities', equivalenceOk, mismatch.slice(0, 5).join(' | '));
  check('I2.guardAtMostOneRewrite', rewritesMax <= 1, 'max rewrites=' + rewritesMax);
  check('I3.guardAlwaysOneJudgeCall', malformedHandled, equivalenceDetail);
  check('I4.guardRanForAllSamples', guardCalls === sampleIds.length * CAL.SENSITIVITIES.length);
  check('I5.telemetryIsSandboxInstance', (() => {
    const t = sbx.telemetry();
    return t.judgeRuns === guardCalls && t.rewriteTriggered <= guardCalls && t.maxRewritesPerTurn <= 1;
  })(), JSON.stringify(sbx.telemetry()));

  /* 恢复沙箱配置（沙箱内，非生产） */
  sbx.store.apiSettings.middle_brain.characterIntegritySensitivity = 'conservative';

  /* ═══════════════ 报告 ═══════════════ */
  console.log('\n' + '='.repeat(72));
  console.log(CAL.renderReport(RES));
  console.log('='.repeat(72));

  /* 报告内容断言（保证报告不是空壳） */
  const report = CAL.renderReport(RES);
  check('R1.reportHasAllSections', ['Cases:', 'Judge (decided cases only', 'Gate (ran on', 'Intervention (end-to-end',
    'By dimension', 'Dimension confusion', 'watch (speech_style', 'Sensitivity simulation', 'Boundary cases',
    'Knowledge boundary', 'Samples:'].every(s => report.indexOf(s) >= 0));
  check('R2.reportPrintsAllSensitivities', CAL.SENSITIVITIES.every(s => new RegExp('^  ' + s, 'm').test(report)));
  check('R3.reportPrintsSixDimensions', CAL.DIMENSIONS.every(d => report.indexOf('  ' + d + '\n') >= 0));
  check('R4.reportIsDeterministic', report === CAL.renderReport(RES));

  /* 把报告落到系统临时目录（不写仓库） */
  const outPath = process.argv.find(a => a.startsWith('--out='));
  if (outPath) {
    const p = outPath.slice('--out='.length);
    fs.writeFileSync(p, report + '\n', 'utf8');
    console.log('\n报告已写入: ' + p);
  }

  console.log('\nCharacter Integrity Calibration (P11-2A Layer A): ' + failures + ' failed');
  process.exitCode = failures ? 1 : 0;
})().catch(e => { console.error(e); process.exit(1); });
