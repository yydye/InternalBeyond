/* ====================================================================
   P11-2A · Character Integrity Calibration Harness（角色一致性校准框架 · 核心）
   --------------------------------------------------------------------
   本阶段唯一目标：回答"P11-2 这把尺子到底准不准？"
   本文件**不是生产代码**：
     - 不被 InternalBeyond.html 加载；
     - 不被 assets/js/** 任何生产文件引用；
     - 不写角色配置 / Memory / Understanding / Thread / Relationship；
     - 不改生产 sensitivity / telemetry / prompt / schema / gate；
     - 不触发真实 rewrite 副作用；不发起任何网络请求（网络由调用方注入）。
   它只做四件纯事：
     1. Case schema + 严格校验（Ground Truth 与 Judge 实际输出**结构上分离**）
     2. Judge → Gate → Rewrite 三级指标（confusion / precision / recall / specificity / F1 / FPR / FNR）
     3. sensitivity 阈值模拟（conservative / balanced / strict；**不修改生产 config**）
     4. 边界分数分析 + dimension confusion + 报告渲染（CLI 文本）
   依赖注入（deps）：真实实现由调用方传入，本文件不重复实现任何判定逻辑：
     - parseJudge(raw) -> report|null       ← 生产 integrity 层 _mbParseCiJson
     - gate(sensitivity, report) -> {rewrite, reason, thresholds}
                                            ← 生产 integrity 层 _mbCiGate
     - evidenceAvailable(case) -> {dimension:boolean}   ← 生产 _mbCiBuildEvidence().available
   ==================================================================== */
'use strict';

const VERSION = 'p11-2a-1';

/* Judge 维度白名单（与生产 MB_CI_DIMENSIONS 一致；此处仅作 schema 校验用） */
const DIMENSIONS = ['persona', 'speech_style', 'relationship', 'emotional_continuity', 'knowledge_boundary', 'behavior'];
const SENSITIVITIES = ['conservative', 'balanced', 'strict'];
/* Judge 观测状态：
     clean      —— Judge 判 pass（未发现 OOC）
     ooc        —— Judge 判 fail（发现 OOC）
     error      —— Judge 调用失败（HTTP/超时/网络）；生产行为 = 不干预
     malformed  —— Judge 返回无法解析/校验不过；生产行为 = 不干预 */
const JUDGE_STATUS = ['clean', 'ooc', 'error', 'malformed'];
/* 观测来源：authored = 人工记录的固定 Judge 输出（Layer A 契约校准用）；
            live     = 真实 Judge 运行记录（Layer B） */
const PROVENANCE = ['authored', 'live'];
/* 边界带宽（0..1 分数空间）：单条判定距离阈值 ≤ 该带宽 → 视为"贴着决策边界" */
const BOUNDARY_BAND = { confidence: 0.05, score: 0.05, severity: 0.05 };
/* Ground Truth 允许的键（结构上禁止把 Judge 输出写进 expected） */
const EXPECTED_KEYS = ['ooc', 'dimensions', 'rewriteExpected', 'notes'];
/* Judge 观测允许的键（结构上禁止把 Ground Truth 写进观测） */
const OBSERVED_KEYS = ['raw', 'error', 'provenance', 'note'];

function ratio(num, den) { return den > 0 ? num / den : null; }
function num(v) { return (typeof v === 'number' && isFinite(v)) ? v : null; }
function fmt(v) { return v == null ? 'n/a' : (Math.round(v * 1000) / 1000).toFixed(3); }
function pct(v) { return v == null ? 'n/a' : (Math.round(v * 1000) / 10).toFixed(1) + '%'; }

/* ── ① 混淆矩阵（唯一指标实现；所有分组指标都走这里，避免多套算法） ── */
function confusion(pairs) {
  let tp = 0, tn = 0, fp = 0, fn = 0;
  for (const p of pairs) {
    const exp = p[0] === true, pred = p[1] === true;
    if (exp && pred) tp++;
    else if (!exp && !pred) tn++;
    else if (!exp && pred) fp++;
    else fn++;
  }
  const precision = ratio(tp, tp + fp);
  const recall = ratio(tp, tp + fn);
  /* F1：分母不存在 → null（未定义）；两者都是 0 → 0（约定，不返回 null） */
  const f1 = (precision == null || recall == null)
    ? null : ((precision + recall) === 0 ? 0 : (2 * precision * recall) / (precision + recall));
  return {
    total: tp + tn + fp + fn, tp, tn, fp, fn,
    precision, recall, f1,
    specificity: ratio(tn, tn + fp),
    falsePositiveRate: ratio(fp, fp + tn),
    falseNegativeRate: ratio(fn, fn + tp),
    accuracy: ratio(tp + tn, tp + tn + fp + fn)
  };
}

/* ── ② Case schema 校验（Ground Truth 与 Judge 输出严格分离） ── */
function validateCase(c) {
  const errs = [];
  const bad = (m) => errs.push(m);
  if (!c || typeof c !== 'object') return ['case 不是对象'];
  if (typeof c.id !== 'string' || !c.id.trim()) bad('id 缺失');
  if (typeof c.category !== 'string' || !c.category.trim()) bad('category 缺失');
  if (!c.character || typeof c.character !== 'object' || typeof c.character.id !== 'string' || !c.character.id) bad('character.id 缺失');
  if (typeof c.userMessage !== 'string') bad('userMessage 必须是字符串');
  if (typeof c.candidate !== 'string' || !c.candidate.trim()) bad('candidate 必须是非空字符串');
  if (c.history != null && !Array.isArray(c.history)) bad('history 必须是数组');
  if (typeof c.reason !== 'string' || !c.reason.trim()) bad('reason 缺失（必须写明 ground truth 依据）');
  if (c.tags != null && !Array.isArray(c.tags)) bad('tags 必须是数组');

  /* Ground Truth 通道 */
  const e = c.expected;
  if (!e || typeof e !== 'object') { bad('expected 缺失'); }
  else {
    const extra = Object.keys(e).filter(k => EXPECTED_KEYS.indexOf(k) < 0);
    if (extra.length) bad('expected 出现非 ground-truth 键: ' + extra.join(','));
    if (typeof e.ooc !== 'boolean') bad('expected.ooc 必须是布尔');
    if (!Array.isArray(e.dimensions)) bad('expected.dimensions 必须是数组');
    else {
      const dup = e.dimensions.filter((d, i) => e.dimensions.indexOf(d) !== i);
      const unknown = e.dimensions.filter(d => DIMENSIONS.indexOf(d) < 0);
      if (dup.length) bad('expected.dimensions 有重复: ' + dup.join(','));
      if (unknown.length) bad('expected.dimensions 非白名单: ' + unknown.join(','));
      if (e.ooc === false && e.dimensions.length) bad('expected.ooc=false 时 dimensions 必须为空');
      if (e.ooc === true && !e.dimensions.length) bad('expected.ooc=true 时必须声明期望维度');
    }
    if (typeof e.rewriteExpected !== 'boolean') bad('expected.rewriteExpected 必须是布尔');
    else if (e.rewriteExpected === true && e.ooc !== true) bad('rewriteExpected=true 蕴含 ooc=true');
  }

  /* Judge 观测通道（与 ground truth 完全独立） */
  const o = c.observedJudge;
  if (!o || typeof o !== 'object') { bad('observedJudge 缺失（不得用 ground truth 代替 Judge 输出）'); }
  else {
    const extra = Object.keys(o).filter(k => OBSERVED_KEYS.indexOf(k) < 0);
    if (extra.length) bad('observedJudge 出现非观测键（疑似混入 ground truth）: ' + extra.join(','));
    const hasRaw = typeof o.raw === 'string';
    const hasErr = typeof o.error === 'string' && !!o.error;
    if (hasRaw && hasErr) bad('observedJudge 不能同时有 raw 与 error');
    if (!hasRaw && !hasErr) bad('observedJudge 必须给出 raw 或 error');
    if (o.provenance != null && PROVENANCE.indexOf(o.provenance) < 0) bad('observedJudge.provenance 非白名单: ' + o.provenance);
  }
  return errs;
}

function validateCases(cases) {
  const errors = [];
  if (!Array.isArray(cases) || !cases.length) return ['cases 必须是非空数组'];
  const seen = new Set();
  for (const c of cases) {
    const errs = validateCase(c);
    const id = (c && typeof c.id === 'string') ? c.id : '(no-id)';
    if (c && typeof c.id === 'string' && seen.has(c.id)) errs.push('id 重复: ' + c.id);
    if (c && typeof c.id === 'string') seen.add(c.id);
    for (const m of errs) errors.push(id + ': ' + m);
  }
  return errors;
}

/* ── ③ Judge 观测 → 判定状态（复用生产 parser；绝不自行解析） ── */
function classifyObserved(observed, parseJudge) {
  if (!observed || typeof observed !== 'object') return { status: 'error', error: 'missing_observation', report: null };
  if (typeof observed.error === 'string' && observed.error) return { status: 'error', error: observed.error, report: null };
  let report = null;
  try { report = parseJudge(observed.raw); } catch (err) { report = null; }
  if (!report) return { status: 'malformed', error: 'malformed', report: null };
  return { status: report.pass === false ? 'ooc' : 'clean', error: null, report };
}

/* ── ④ 单 case 评估：Judge 正确性 / Gate 正确性 / Rewrite 决策 三级分离 ── */
function evaluateCase(c, deps) {
  const judge = classifyObserved(c.observedJudge, deps.parseJudge);
  const report = judge.report;
  const judgedOoc = judge.status === 'ooc';
  const judgedClean = judge.status === 'clean';
  const decided = judgedOoc || judgedClean;

  const gateBy = {};
  for (const s of SENSITIVITIES) {
    let g;
    try { g = deps.gate(s, report); } catch (err) { g = { rewrite: false, reason: 'gate_error', thresholds: null }; }
    gateBy[s] = g;
  }
  const production = deps.productionSensitivity || 'conservative';
  const gateProd = gateBy[production] || { rewrite: false, reason: 'no_gate' };
  const rewrite = gateProd.rewrite === true;

  /* 生产 telemetry 分类：pass && score > failBelow → judgePass；否则 judgeFail */
  let telemetryClass;
  if (judge.status === 'error') telemetryClass = 'error';
  else if (judge.status === 'malformed') telemetryClass = 'malformed';
  else {
    const failBelow = (gateProd.thresholds && num(gateProd.thresholds.failBelow));
    telemetryClass = (report.pass === true && failBelow != null && report.score > failBelow) ? 'pass' : 'fail';
  }

  const expectedDims = (c.expected && Array.isArray(c.expected.dimensions)) ? c.expected.dimensions : [];
  const judgedDims = report && Array.isArray(report.dimensions) ? report.dimensions : [];

  /* dimension confusion（只在 Judge 给出判定时评估）
     分类优先级：exact → superset → subset → partial → disjoint（交集为空）
     missing_all / spurious_only / none 是"单侧为空"的特例。 */
  const missing = expectedDims.filter(d => judgedDims.indexOf(d) < 0);
  const extra = judgedDims.filter(d => expectedDims.indexOf(d) < 0);
  const shared = expectedDims.filter(d => judgedDims.indexOf(d) >= 0);
  let dimMatch = 'n/a';
  if (decided) {
    if (!expectedDims.length && !judgedDims.length) dimMatch = 'none';
    else if (!judgedDims.length) dimMatch = 'missing_all';
    else if (!expectedDims.length) dimMatch = 'spurious_only';
    else if (!missing.length && !extra.length) dimMatch = 'exact';
    else if (!missing.length) dimMatch = 'superset';
    else if (!extra.length) dimMatch = 'subset';
    else if (shared.length) dimMatch = 'partial';
    else dimMatch = 'disjoint';
  }

  /* 边界分析：每条判定距离阈值的余量（>=0 通过） */
  const boundaryBy = {};
  for (const s of SENSITIVITIES) {
    const th = gateBy[s] && gateBy[s].thresholds;
    if (!th || !report) { boundaryBy[s] = null; continue; }
    const maxSev = report.maxSeverity != null ? Number(report.maxSeverity) : 0;
    const margins = {
      confidence: Number(report.confidence) - th.confidence,
      score: th.score - Number(report.score),
      severity: maxSev - th.severity
    };
    const near = Object.keys(margins).filter(k => Math.abs(margins[k]) <= BOUNDARY_BAND[k]);
    /* decisive：rewrite=false 时指"卡住的那一项"（负余量中最接近 0）；
       rewrite=true 时指"最接近翻车的正余量"。 */
    const blocking = Object.keys(margins).filter(k => margins[k] < 0);
    let decisive = null;
    if (blocking.length) {
      decisive = blocking.reduce((a, b) => (margins[a] >= margins[b] ? a : b));
    } else {
      decisive = Object.keys(margins).reduce((a, b) => (margins[a] <= margins[b] ? a : b));
    }
    boundaryBy[s] = {
      margins, near, decisive,
      /* 判定贴着边界：被 decisive 的那一项落在带宽内，且其余项不构成同样的紧约束 */
      isBoundary: judgedOoc && near.indexOf(decisive) >= 0
    };
  }

  /* knowledge_boundary 原则保护：无 canonical 证据时**不得**判该维度 */
  let kbAvailable = null;
  if (deps.evidenceAvailable) {
    try {
      const av = deps.evidenceAvailable(c) || {};
      kbAvailable = av.knowledge_boundary === true;
    } catch (err) { kbAvailable = null; }
  }
  const kbViolation = judgedDims.indexOf('knowledge_boundary') >= 0 && kbAvailable === false;

  return {
    id: c.id, category: c.category, characterId: c.character && c.character.id,
    tags: (c.tags || []).slice(),
    reason: c.reason,
    expected: { ooc: c.expected.ooc, dimensions: expectedDims.slice(), rewriteExpected: c.expected.rewriteExpected === true },
    judge: {
      status: judge.status, error: judge.error,
      provenance: (c.observedJudge && c.observedJudge.provenance) || 'authored',
      pass: report ? report.pass : null,
      score: report ? report.score : null,
      confidence: report ? report.confidence : null,
      maxSeverity: report ? report.maxSeverity : null,
      dimensions: judgedDims.slice(),
      telemetryClass
    },
    judgedOoc, decided,
    judgeCorrect: decided ? (judgedOoc === c.expected.ooc) : null,
    gate: gateBy,
    gateRan: judgedOoc,
    rewrite,
    rewriteReason: gateProd.reason,
    interventionCorrect: rewrite === (c.expected.rewriteExpected === true),
    gateCorrect: judgedOoc ? (rewrite === (c.expected.rewriteExpected === true)) : null,
    dimension: { match: dimMatch, missing, extra },
    knowledgeBoundaryAvailable: kbAvailable,
    knowledgeBoundaryViolation: kbViolation,
    boundary: boundaryBy
  };
}

/* ── ⑤ 全量校准：三级指标 + 分组 + 阈值模拟 + 边界 + 报告 ── */
function runCalibration(cases, deps) {
  deps = deps || {};
  const production = deps.productionSensitivity || 'conservative';
  const rows = cases.map(c => evaluateCase(c, Object.assign({ productionSensitivity: production }, deps)));

  /* Judge 级：仅统计给出了判定的 case（error/malformed 单列） */
  const decidedRows = rows.filter(r => r.decided);
  const judgeDecision = confusion(decidedRows.map(r => [r.expected.ooc, r.judgedOoc]));
  /* Judge 级（生产等效）：error/malformed 生产行为 = 不干预 → 计为"未判 OOC" */
  const judgeEffective = confusion(rows.map(r => [r.expected.ooc, r.judgedOoc]));
  /* 干预级（生产 sensitivity 下最终是否重写） */
  const intervention = confusion(rows.map(r => [r.expected.rewriteExpected, r.rewrite]));
  /* Gate 级：只在 Judge 判 OOC（即 gate 真正运行）的 case 上评估 */
  const gateRows = rows.filter(r => r.gateRan);
  const gateConfusion = confusion(gateRows.map(r => [r.expected.rewriteExpected, r.rewrite]));

  /* 按维度：label 视角的 TP/FP/FN（Judge 报了这个维度 vs ground truth 有这个维度） */
  const byDimension = {};
  for (const d of DIMENSIONS) {
    let tp = 0, fp = 0, fn = 0;
    for (const r of decidedRows) {
      const exp = r.expected.dimensions.indexOf(d) >= 0;
      const got = r.judge.dimensions.indexOf(d) >= 0;
      if (exp && got) tp++; else if (!exp && got) fp++; else if (exp && !got) fn++;
    }
    byDimension[d] = {
      tp, fp, fn,
      precision: ratio(tp, tp + fp),
      recall: ratio(tp, tp + fn),
      /* 误杀率：该维度被报出来、但 ground truth 里没有它 */
      falsePositiveRate: ratio(fp, fp + tp),
      falseNegativeRate: ratio(fn, fn + tp)
    };
  }

  /* dimension confusion 分布 */
  const dimensionConfusion = {};
  for (const k of ['exact', 'superset', 'subset', 'partial', 'disjoint', 'missing_all', 'spurious_only', 'none', 'n/a']) dimensionConfusion[k] = 0;
  const spurious = { speech_style: 0, emotional_continuity: 0, other: 0 };
  const confusionSamples = [];
  for (const r of rows) {
    dimensionConfusion[r.dimension.match] = (dimensionConfusion[r.dimension.match] || 0) + 1;
    if (r.dimension.extra.length && r.decided) {
      for (const d of r.dimension.extra) {
        if (d === 'speech_style') spurious.speech_style++;
        else if (d === 'emotional_continuity') spurious.emotional_continuity++;
        else spurious.other++;
      }
      if (confusionSamples.length < 40) {
        confusionSamples.push({
          id: r.id, expected: r.expected.dimensions, judged: r.judge.dimensions,
          match: r.dimension.match, expectedOoc: r.expected.ooc
        });
      }
    }
  }

  /* sensitivity 模拟（不修改生产 config；只算"如果阈值是这个档，gate 会怎么决定"） */
  const bySensitivity = {};
  for (const s of SENSITIVITIES) {
    const cf = confusion(rows.map(r => [r.expected.rewriteExpected, (r.gate[s] || {}).rewrite === true]));
    const boundaryRows = rows.filter(r => r.boundary[s] && r.boundary[s].isBoundary);
    bySensitivity[s] = {
      sensitivity: s,
      thresholds: (rows.find(r => r.gate[s] && r.gate[s].thresholds) || { gate: {} }).gate[s]
        ? (rows.find(r => r.gate[s] && r.gate[s].thresholds)).gate[s].thresholds : null,
      judgeOoc: rows.filter(r => r.judgedOoc).length,
      rewrites: rows.filter(r => (r.gate[s] || {}).rewrite === true).length,
      rewriteRate: ratio(rows.filter(r => (r.gate[s] || {}).rewrite === true).length, rows.length),
      confusion: cf,
      boundaryCases: boundaryRows.length
    };
  }

  /* 边界分析：跨档统计"经常贴着边界"的 case */
  const boundaryCases = [];
  for (const r of rows) {
    const perS = SENSITIVITIES.filter(s => r.boundary[s] && r.boundary[s].isBoundary)
      .map(s => ({ sensitivity: s, decisive: r.boundary[s].decisive, margins: r.boundary[s].margins }));
    if (!perS.length) continue;
    boundaryCases.push({
      id: r.id, category: r.category, expectedOoc: r.expected.ooc, rewriteExpected: r.expected.rewriteExpected,
      judgeStatus: r.judge.status, score: r.judge.score, confidence: r.judge.confidence, maxSeverity: r.judge.maxSeverity,
      perSensitivity: perS,
      boundaryCount: perS.length,
      flips: SENSITIVITIES.map(s => (r.gate[s] || {}).rewrite === true)
    });
  }
  /* "经常贴线" = 在多个档位都贴线；按此降序（这是 Adaptive Thresholds 的候选依据） */
  boundaryCases.sort((a, b) => b.boundaryCount - a.boundaryCount || a.id.localeCompare(b.id));
  /* 档位翻转：conservative 与 strict 决策不同的 case（说明该 case 对阈值高度敏感） */
  const sensitivityFlips = rows
    .filter(r => (r.gate.conservative || {}).rewrite !== (r.gate.strict || {}).rewrite)
    .map(r => ({
      id: r.id, expectedOoc: r.expected.ooc, rewriteExpected: r.expected.rewriteExpected,
      conservative: (r.gate.conservative || {}).rewrite === true,
      balanced: (r.gate.balanced || {}).rewrite === true,
      strict: (r.gate.strict || {}).rewrite === true,
      score: r.judge.score, confidence: r.judge.confidence, maxSeverity: r.judge.maxSeverity
    }));

  /* 分组指标（按 category / character / 观测来源） */
  const groupBy = (keyFn) => {
    const groups = {};
    for (const r of rows) {
      const k = keyFn(r) || '(unknown)';
      if (!groups[k]) groups[k] = { key: k, rows: [], judgeDecision: [], intervention: [] };
      groups[k].rows.push(r);
      if (r.decided) groups[k].judgeDecision.push([r.expected.ooc, r.judgedOoc]);
      groups[k].intervention.push([r.expected.rewriteExpected, r.rewrite]);
    }
    const out = {};
    for (const k of Object.keys(groups)) {
      out[k] = {
        cases: groups[k].rows.length,
        judge: confusion(groups[k].judgeDecision),
        intervention: confusion(groups[k].intervention)
      };
    }
    return out;
  };

  /* knowledge boundary 专项：
     ① 有证据的 case —— 该维度真的可用，检测率才有意义；
     ② 无证据的 case —— 原则是"不得判 knowledge_boundary"；任何一次都是原则违规。
     注意 ② 的分母是"所有缺 KB 证据的 case"（不只是 kb 类别），因为原则适用于全部用例。 */
  const kbWith = rows.filter(r => r.knowledgeBoundaryAvailable === true);
  const kbWithout = rows.filter(r => r.knowledgeBoundaryAvailable === false);
  const kbViolationRows = rows.filter(r => r.knowledgeBoundaryViolation);
  const knowledgeBoundary = {
    withEvidence: {
      cases: kbWith.length,
      detected: kbWith.filter(r => r.judge.dimensions.indexOf('knowledge_boundary') >= 0).length,
      judge: confusion(kbWith.filter(r => r.decided).map(r => [r.expected.ooc, r.judgedOoc]))
    },
    withoutEvidence: {
      cases: kbWithout.length,
      violations: kbViolationRows.length,
      violationIds: kbViolationRows.map(r => r.id)
    },
    category: {
      withEvidence: rows.filter(r => r.category === 'knowledge_boundary_with_evidence').length,
      withoutEvidence: rows.filter(r => r.category === 'knowledge_boundary_no_evidence').length,
      withoutEvidenceJudgedOoc: rows.filter(r => r.category === 'knowledge_boundary_no_evidence' && r.judgedOoc).length,
      withoutEvidenceRewrites: rows.filter(r => r.category === 'knowledge_boundary_no_evidence' && r.rewrite).length
    }
  };

  /* §八 专项：speech_style / emotional_continuity 是否"吞掉其他问题"或"产生误杀"
     · falseKill —— ground truth 干净却被报出该维度（误杀）
     · swallowed —— ground truth 是 OOC、但正确维度不是它（吞掉了别的问题） */
  const watchDimensions = {};
  for (const d of ['speech_style', 'emotional_continuity']) {
    const withD = decidedRows.filter(r => r.judge.dimensions.indexOf(d) >= 0);
    watchDimensions[d] = {
      reported: withD.length,
      correct: withD.filter(r => r.expected.dimensions.indexOf(d) >= 0).length,
      falseKill: withD.filter(r => !r.expected.ooc).length,
      falseKillIds: withD.filter(r => !r.expected.ooc).map(r => r.id),
      swallowed: withD.filter(r => r.expected.ooc && r.expected.dimensions.indexOf(d) < 0).length,
      swallowedIds: withD.filter(r => r.expected.ooc && r.expected.dimensions.indexOf(d) < 0).map(r => r.id)
    };
  }

  /* false positive / false negative 样例（供报告摘要） */
  const judgeFp = decidedRows.filter(r => !r.expected.ooc && r.judgedOoc);
  const judgeFn = decidedRows.filter(r => r.expected.ooc && !r.judgedOoc);
  const interventionFp = rows.filter(r => !r.expected.rewriteExpected && r.rewrite);
  const interventionFn = rows.filter(r => r.expected.rewriteExpected && !r.rewrite);
  const blockedByGate = decidedRows.filter(r => r.judgedOoc && !r.rewrite && !r.expected.rewriteExpected);

  const provenance = {};
  for (const r of rows) provenance[r.judge.provenance] = (provenance[r.judge.provenance] || 0) + 1;

  return {
    version: VERSION,
    productionSensitivity: production,
    cases: rows.length,
    characters: [...new Set(rows.map(r => r.characterId))].length,
    provenance,
    rows,
    judge: {
      decision: judgeDecision,
      effective: judgeEffective,
      errors: rows.filter(r => r.judge.status === 'error').length,
      malformed: rows.filter(r => r.judge.status === 'malformed').length,
      telemetry: {
        pass: rows.filter(r => r.judge.telemetryClass === 'pass').length,
        fail: rows.filter(r => r.judge.telemetryClass === 'fail').length,
        error: rows.filter(r => r.judge.telemetryClass === 'error').length,
        malformed: rows.filter(r => r.judge.telemetryClass === 'malformed').length
      }
    },
    gate: { ran: gateRows.length, confusion: gateConfusion },
    intervention,
    byDimension,
    watchDimensions,
    dimensionConfusion,
    spurious,
    confusionSamples,
    bySensitivity,
    boundary: { cases: boundaryCases, flips: sensitivityFlips },
    byCategory: groupBy(r => r.category),
    byCharacter: groupBy(r => r.characterId),
    knowledgeBoundary,
    samples: {
      judgeFp: judgeFp.slice(0, 12).map(r => ({ id: r.id, category: r.category, score: r.judge.score, confidence: r.judge.confidence, dimensions: r.judge.dimensions, rewrite: r.rewrite })),
      judgeFn: judgeFn.slice(0, 12).map(r => ({ id: r.id, category: r.category, score: r.judge.score, confidence: r.judge.confidence, expected: r.expected.dimensions })),
      interventionFp: interventionFp.map(r => ({ id: r.id, category: r.category, expected: r.expected.dimensions, judged: r.judge.dimensions })),
      interventionFn: interventionFn.map(r => ({ id: r.id, category: r.category, expected: r.expected.dimensions, judged: r.judge.dimensions, judgeStatus: r.judge.status, gateReason: r.rewriteReason })),
      blockedByGate: blockedByGate.map(r => ({ id: r.id, category: r.category, dimensions: r.judge.dimensions, gateReason: r.rewriteReason }))
    }
  };
}

/* ── ⑥ 报告渲染（CLI 文本；不做 UI） ── */
function renderReport(res) {
  const L = [];
  const line = (s) => L.push(s == null ? '' : s);
  line('Character Integrity Calibration');
  line('Harness ' + res.version + ' · production sensitivity = ' + res.productionSensitivity);
  line('');
  line('Cases: ' + res.cases + '   Characters: ' + res.characters
    + '   Observation provenance: ' + Object.keys(res.provenance).map(k => k + '=' + res.provenance[k]).join(' '));
  line('');
  line('Judge (decided cases only: ' + res.judge.decision.total + '):');
  line('  TP ' + res.judge.decision.tp + '   TN ' + res.judge.decision.tn
    + '   FP ' + res.judge.decision.fp + '   FN ' + res.judge.decision.fn
    + '   (error ' + res.judge.errors + ' / malformed ' + res.judge.malformed + ')');
  line('  Precision ' + fmt(res.judge.decision.precision) + '   Recall ' + fmt(res.judge.decision.recall)
    + '   Specificity ' + fmt(res.judge.decision.specificity) + '   F1 ' + fmt(res.judge.decision.f1));
  line('  FPR ' + fmt(res.judge.decision.falsePositiveRate) + '   FNR ' + fmt(res.judge.decision.falseNegativeRate)
    + '   Accuracy ' + fmt(res.judge.decision.accuracy));
  line('  Judge (production-equivalent, error/malformed = no intervention):');
  line('  TP ' + res.judge.effective.tp + '   TN ' + res.judge.effective.tn
    + '   FP ' + res.judge.effective.fp + '   FN ' + res.judge.effective.fn
    + '   F1 ' + fmt(res.judge.effective.f1));
  line('  Telemetry classes: pass=' + res.judge.telemetry.pass + ' fail=' + res.judge.telemetry.fail
    + ' error=' + res.judge.telemetry.error + ' malformed=' + res.judge.telemetry.malformed);
  line('');
  line('Gate (ran on ' + res.gate.ran + ' Judge-OOC cases) — rewrite vs ground truth:');
  line('  TP ' + res.gate.confusion.tp + '   TN ' + res.gate.confusion.tn
    + '   FP ' + res.gate.confusion.fp + '   FN ' + res.gate.confusion.fn
    + '   Precision ' + fmt(res.gate.confusion.precision) + '   Recall ' + fmt(res.gate.confusion.recall));
  line('');
  line('Intervention (end-to-end rewrite decision, production sensitivity):');
  line('  TP ' + res.intervention.tp + '   TN ' + res.intervention.tn
    + '   FP ' + res.intervention.fp + '   FN ' + res.intervention.fn);
  line('  Precision ' + fmt(res.intervention.precision) + '   Recall ' + fmt(res.intervention.recall)
    + '   Specificity ' + fmt(res.intervention.specificity) + '   F1 ' + fmt(res.intervention.f1));
  line('  FPR ' + fmt(res.intervention.falsePositiveRate) + '   FNR ' + fmt(res.intervention.falseNegativeRate));
  line('');
  line('By dimension (label view over decided cases):');
  for (const d of DIMENSIONS) {
    const m = res.byDimension[d];
    line('  ' + d);
    line('    TP: ' + m.tp + '   FP: ' + m.fp + '   FN: ' + m.fn
      + '   precision: ' + fmt(m.precision) + '   recall: ' + fmt(m.recall));
  }
  line('');
  line('Dimension confusion:');
  for (const k of Object.keys(res.dimensionConfusion)) {
    if (res.dimensionConfusion[k]) line('  ' + k + ': ' + res.dimensionConfusion[k]);
  }
  line('  spurious extras → speech_style ' + res.spurious.speech_style
    + ' / emotional_continuity ' + res.spurious.emotional_continuity
    + ' / other ' + res.spurious.other);
  line('  watch (speech_style / emotional_continuity):');
  for (const d of Object.keys(res.watchDimensions)) {
    const w = res.watchDimensions[d];
    line('    ' + d + ': reported=' + w.reported + ' correct=' + w.correct
      + ' falseKill=' + w.falseKill + ' swallowed=' + w.swallowed);
    if (w.falseKillIds.length) line('      falseKill: ' + w.falseKillIds.join(', '));
    if (w.swallowedIds.length) line('      swallowed: ' + w.swallowedIds.join(', '));
  }
  line('');
  line('Sensitivity simulation (production config NOT modified):');
  for (const s of SENSITIVITIES) {
    const th = res.bySensitivity[s].thresholds;
    if (th) line('  ' + s.padEnd(14) + 'confidence≥' + th.confidence + '  score≤' + th.score
      + '  severity≥' + th.severity + '  failBelow=' + th.failBelow);
  }
  line('  ' + 'sensitivity'.padEnd(14) + 'judgeOOC'.padEnd(10) + 'rewrites'.padEnd(10)
    + 'FP'.padEnd(5) + 'FN'.padEnd(5) + 'rewriteRate'.padEnd(13) + 'boundary');
  for (const s of SENSITIVITIES) {
    const v = res.bySensitivity[s];
    line('  ' + s.padEnd(14) + String(v.judgeOoc).padEnd(10) + String(v.rewrites).padEnd(10)
      + String(v.confusion.fp).padEnd(5) + String(v.confusion.fn).padEnd(5)
      + pct(v.rewriteRate).padEnd(13) + v.boundaryCases);
  }
  line('');
  line('Boundary cases (decision hinges on one criterion within ±' + BOUNDARY_BAND.confidence + '): '
    + res.boundary.cases.length + ' total, '
    + res.boundary.cases.filter(b => b.boundaryCount >= 2).length + ' in ≥2 sensitivities, '
    + res.boundary.cases.filter(b => b.boundaryCount >= 3).length + ' in all 3');
  if (!res.boundary.cases.length) line('  (none)');
  for (const b of res.boundary.cases.slice(0, 20)) {
    const per = b.perSensitivity.map(p => p.sensitivity + ':' + p.decisive).join(' ');
    line('  ' + b.id + '  ooc=' + b.expectedOoc + ' rewriteExpected=' + b.rewriteExpected
      + '  score=' + fmt(b.score) + ' conf=' + fmt(b.confidence) + ' sev=' + fmt(b.maxSeverity)
      + '  [' + per + ']  rewrite=' + b.flips.map(f => f ? '1' : '0').join(''));
  }
  line('');
  line('Sensitivity flips (conservative ≠ strict): ' + res.boundary.flips.length);
  for (const f of res.boundary.flips.slice(0, 20)) {
    line('  ' + f.id + '  c=' + (f.conservative ? 1 : 0) + ' b=' + (f.balanced ? 1 : 0) + ' s=' + (f.strict ? 1 : 0)
      + '  expectedRewrite=' + f.rewriteExpected + '  score=' + fmt(f.score) + ' conf=' + fmt(f.confidence) + ' sev=' + fmt(f.maxSeverity));
  }
  line('');
  line('Knowledge boundary:');
  line('  with canonical evidence: ' + res.knowledgeBoundary.withEvidence.cases + ' cases, detected '
    + res.knowledgeBoundary.withEvidence.detected);
  line('  without canonical evidence: ' + res.knowledgeBoundary.withoutEvidence.cases
    + ' cases, no-evidence violations ' + res.knowledgeBoundary.withoutEvidence.violations
    + (res.knowledgeBoundary.withoutEvidence.violationIds.length
      ? ' [' + res.knowledgeBoundary.withoutEvidence.violationIds.join(', ') + ']' : ''));
  line('  category knowledge_boundary_with_evidence=' + res.knowledgeBoundary.category.withEvidence
    + ' / without_evidence=' + res.knowledgeBoundary.category.withoutEvidence
    + ' (judged OOC ' + res.knowledgeBoundary.category.withoutEvidenceJudgedOoc
    + ', rewritten ' + res.knowledgeBoundary.category.withoutEvidenceRewrites + ')');
  line('');
  line('Samples:');
  line('  Judge FP (' + res.samples.judgeFp.length + ' shown):');
  for (const s of res.samples.judgeFp) line('    ' + s.id + ' [' + s.category + '] dims=' + s.dimensions.join('|') + ' rewrite=' + s.rewrite);
  line('  Judge FN (' + res.samples.judgeFn.length + ' shown):');
  for (const s of res.samples.judgeFn) line('    ' + s.id + ' [' + s.category + '] expected=' + s.expected.join('|') + ' score=' + fmt(s.score));
  line('  Intervention FP (' + res.samples.interventionFp.length + '): ' + res.samples.interventionFp.map(s => s.id).join(', '));
  line('  Intervention FN (' + res.samples.interventionFn.length + '): ' + res.samples.interventionFn.map(s => s.id).join(', '));
  line('  Judge-OOC but gate correctly blocked (' + res.samples.blockedByGate.length + '): '
    + res.samples.blockedByGate.map(s => s.id + '(' + s.gateReason + ')').join(', '));
  return L.join('\n');
}

module.exports = {
  VERSION, DIMENSIONS, SENSITIVITIES, JUDGE_STATUS, PROVENANCE, BOUNDARY_BAND,
  EXPECTED_KEYS, OBSERVED_KEYS,
  ratio, confusion,
  validateCase, validateCases,
  classifyObserved,
  evaluateCase,
  runCalibration,
  renderReport
};
