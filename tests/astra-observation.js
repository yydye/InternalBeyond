/* ====================================================================
   Astra Readiness Phase 1 · 观测 schema / 指标 / 预算 / 脱敏（观测器）
   --------------------------------------------------------------------
   本文件**不是生产代码**，也不是测试：它是"观测"这件事的唯一实现。
   它回答四个问题，而且只回答这四个：
     ① 一次真实运行**允许**发起多少次调用？（预算：先算、后跑、跑完对账）
     ② 一次真实运行**看到了什么**？（§4 观测记录，缺失一律 null，绝不填 0）
     ③ 这些观测**意味着什么**？（judge / rewrite / verify 分开度量；期望与观测分开统计）
     ④ 报告里**绝不出现**什么？（凭据、私人对话正文）

   ── 为什么"期望 vs 观测"必须分开统计 ─────────────────────────────────
   语料里的 expectation 是**契约或人工期望**（见 astra-readiness-corpus.js）。
   模型结果是**观测**。两者一旦混进同一个字段，"校准"就变成用模型第一次的答案
   给自己打分。所以：
     · judgement 类样本 → 可以算 agreement / FP / FN；
     · contract 类样本   → **不算** agreement（没有人工标签可对），只算契约是否被违反，
                           并单独进入"证据不足 / 歧义"清单。
   这一条在 report 里是分开的两块，不合并成一个"准确率"。
   ==================================================================== */
'use strict';

/* ── 1 · 预算是硬约束，不是建议 ─────────────────────────────────────────
   任何真实运行都必须先算出"计划调用次数"，再与预算比较，不通过就**根本不跑**。
   上限有两层，取更小的那个：
     · 调用方给的 --budget=N
     · 本模块的绝对上限 MAX_PLANNED_CALLS（防止有人把 --budget 写到天上）
   每个样本最多 3 次调用（judge + rewrite + verify）——因为生产守卫每轮
   最多一次 judge、最多一次 rewrite、最多一次 verify（integrity 层的硬不变量）。 */
const MAX_PLANNED_CALLS = 240;
const MAX_REPEAT = 5;
const CALLS_PER_PHASE = { judge: 1, rewrite: 1, verify: 1 };

function planCalls(cases, opts) {
  opts = opts || {};
  const repeat = Math.max(1, Math.min(Number(opts.repeat) || 1, MAX_REPEAT));
  const requested = Number(opts.budget);
  const cap = Math.min(
    Number.isFinite(requested) && requested > 0 ? Math.floor(requested) : MAX_PLANNED_CALLS,
    MAX_PLANNED_CALLS
  );
  const perCase = [];
  let expected = 0;
  let anyRewrite = false, anyVerify = false;
  for (const c of cases) {
    const phases = opts.phasesOf ? opts.phasesOf(c) : { judge: true, rewrite: false, verify: false };
    if (phases.rewrite) anyRewrite = true;
    if (phases.verify) anyVerify = true;
    let n = 0;
    for (const k of Object.keys(CALLS_PER_PHASE)) if (phases[k]) n += CALLS_PER_PHASE[k];
    perCase.push({ id: c.id, phases: phases, calls: n * repeat });
    expected += n * repeat;
  }
  /* **预算判据用最坏情况**，不是用"我们以为会走到哪一步"：
     Judge 判 OOC 的样本数在跑之前是不知道的，所以只要本轮**允许** rewrite，
     就必须按"每条样本都可能 judge+rewrite(+verify)"去申请预算。
     注意最坏情况来自"本轮开了哪些阶段"（worstCasePhases），而不是
     "语料里哪些样本声明了该阶段" —— 后者只是期望估计，用它当预算会低估。
     先声明最坏情况、再核对实际值，是唯一诚实的做法。 */
  const wp = opts.worstCasePhases || { rewrite: anyRewrite, verify: anyVerify };
  const worstCase = cases.length * repeat * (1 + (wp.rewrite ? 1 : 0) + (wp.verify ? 1 : 0));
  return {
    repeat: repeat,
    maxRepeat: MAX_REPEAT,
    hardCap: MAX_PLANNED_CALLS,
    budget: cap,
    budgetWasRequested: Number.isFinite(requested) && requested > 0,
    plannedCalls: worstCase,
    plannedBasis: 'worst_case: cases × repeat × (judge' + (wp.rewrite ? ' + rewrite' : '') + (wp.verify ? ' + verify' : '') + ')',
    expectedCalls: expected,
    phasesEnabled: { judge: true, rewrite: !!wp.rewrite, verify: !!wp.verify },
    perCase: perCase,
    ok: worstCase <= cap,
    reason: worstCase <= cap ? 'within_budget' : 'planned_exceeds_budget'
  };
}

/* ── 2 · 脱敏：凭据永远不进任何输出 ─────────────────────────────────────
   纪律：**只按值脱敏**（知道秘密是什么才能替换它），不做"看起来像 key"的启发式
   猜测——启发式会漏，也会把正常文本改坏。另外请求头里的 Authorization 由调用方
   保证"只记存在性、不记值"（观测器提供 authPresence() 给它用）。 */
function redact(text, secrets) {
  let out = String(text == null ? '' : text);
  for (const s of (secrets || [])) {
    const v = String(s == null ? '' : s);
    if (!v || v.length < 6) continue;             /* 太短的值不替换：会破坏正常文本且无意义 */
    out = out.split(v).join('<redacted:' + v.length + '>');
  }
  return out;
}
function leaksSecret(text, secrets) {
  const s = String(text == null ? '' : text);
  for (const v of (secrets || [])) { const t = String(v == null ? '' : v); if (t && t.length >= 6 && s.indexOf(t) >= 0) return t; }
  return null;
}
/* 只回存在性，绝不回值（观测器唯一的"读请求头"方式） */
function authPresence(headers) {
  try {
    const h = headers || {};
    for (const k of Object.keys(h)) if (/^authorization$/i.test(k)) return !!String(h[k] || '').trim();
    return false;
  } catch (e) { return null; }
}

/* ── 3 · 数值工具：分位数（nearest-rank；空集一律 null，不返回 0）──────── */
function percentiles(values) {
  const v = (values || []).filter(x => typeof x === 'number' && isFinite(x)).slice().sort((a, b) => a - b);
  if (!v.length) return { count: 0, min: null, p10: null, p25: null, median: null, p75: null, p90: null, p95: null, max: null, sum: null, mean: null };
  const at = (q) => v[Math.min(v.length - 1, Math.max(0, Math.ceil(q * v.length) - 1))];
  const sum = v.reduce((a, b) => a + b, 0);
  return {
    count: v.length, min: v[0], p10: at(0.10), p25: at(0.25), median: at(0.50),
    p75: at(0.75), p90: at(0.90), p95: at(0.95), max: v[v.length - 1],
    sum: sum, mean: Math.round((sum / v.length) * 1000) / 1000
  };
}
function ratio(num, den) { return den > 0 ? Math.round((num / den) * 10000) / 10000 : null; }

/* ── 4 · 观测记录（§4）：每个字段要么是观测到的事实，要么是 null ─────────
   null 的语义固定为"这次运行没有拿到这个事实"，并且 costBasis / reason 会说明
   为什么没有 —— 绝不用 0 或猜测值冒充。 */
function emptyObservation(fixture, hostName) {
  return {
    fixtureId: fixture.id,
    classes: fixture.classes.slice(),
    host: hostName || null,
    attempt: null,
    inputFacts: {
      evidenceDimensionsAvailable: null,   /* 由真实 evidence 层填 */
      evidenceDimensionsUnavailable: null,
      dialogueRowCount: null,
      dialogueChars: null,                 /* Guard 消费预算后的【最近对话】字符数 */
      dialogueCharsBeforeBudget: null,
      dialogueBudgetDropped: null,
      dialogueCurrentTurnRows: null,
      currentUserChars: fixture.user.length,
      candidateChars: fixture.candidate.length,
      memory: { present: null, chars: null },
      understanding: { present: null, chars: null },
      thread: { present: null, chars: null },
      moments: { present: null, chars: null },
      multipleThreadsInputState: null,
      gateBucket: null,                    /* 'below_low' | 'ramp' | 'at_or_above_high' */
      gateBucketReason: null
    },
    execution: {
      provider: null, model: null, reasoningEffort: null,
      latencyMs: null,
      usage: null,                         /* {inputTokens,outputTokens,totalTokens,cachedTokens} */
      costUsd: null,
      costBasis: 'not_computable: 仓库内没有任何 provider 定价元数据（绝不硬编码猜测价格）',
      calls: null,                         /* {judge, rewrite, verify} 实际发起的调用数 */
      error: null, timeout: null, retry: null
    },
    judge: {
      ran: null, pass: null, score: null, confidence: null, maxSeverity: null,
      dimensions: null, violations: null,
      responseChars: null, promptChars: null,
      malformed: null, error: null,
      latencyMs: null, usage: null
    },
    rewrite: {
      triggered: null, ok: null, error: null, rejectReason: null,
      changed: null, lengthRatio: null,
      contractViolations: null,
      excerpt: null,
      latencyMs: null, usage: null
    },
    verify: {
      triggered: null, ok: null, pass: null, error: null,
      score: null, maxSeverity: null,
      latencyMs: null, usage: null
    },
    disposition: null,
    expectation: {
      kind: fixture.expectation.kind,
      ooc: fixture.expectation.ooc,
      dimensions: (fixture.expectation.dimensions || []).slice(),
      rewriteExpected: fixture.expectation.rewriteExpected,
      rule: fixture.expectation.rule || null,
      note: fixture.expectation.note || ''
    },
    comparison: {
      labelKind: fixture.expectation.kind === 'judgement' ? 'judgement' : 'contract',
      agreement: null,
      falsePositiveCandidate: null,
      falseNegativeCandidate: null,
      ambiguous: fixture.expectation.kind === 'contract',
      ambiguousReason: fixture.expectation.kind === 'contract' ? (fixture.expectation.rule || 'contract') : null,
      contractViolation: null
    }
  };
}

/* 从 provider usage 中**如实**取数：取不到就是 null（绝不写 0） */
function usageOf(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const num = (x) => (typeof x === 'number' && isFinite(x)) ? x : null;
  const out = {
    inputTokens: num(usage.input_tokens != null ? usage.input_tokens : usage.prompt_tokens),
    outputTokens: num(usage.output_tokens != null ? usage.output_tokens : usage.completion_tokens),
    totalTokens: num(usage.total_tokens),
    cachedTokens: null
  };
  const details = usage.input_tokens_details || usage.prompt_tokens_details;
  if (details && typeof details === 'object' && typeof details.cached_tokens === 'number') out.cachedTokens = details.cached_tokens;
  if (out.totalTokens == null && out.inputTokens != null && out.outputTokens != null) out.totalTokens = out.inputTokens + out.outputTokens;
  if (out.inputTokens == null && out.outputTokens == null && out.totalTokens == null && out.cachedTokens == null) return null;
  return out;
}
function addUsage(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  const s = (x, y) => (x == null && y == null) ? null : (x || 0) + (y || 0);
  return { inputTokens: s(a.inputTokens, b.inputTokens), outputTokens: s(a.outputTokens, b.outputTokens), totalTokens: s(a.totalTokens, b.totalTokens), cachedTokens: s(a.cachedTokens, b.cachedTokens) };
}

/* ── 5 · 比较：期望 vs 观测（judgement 类才判对错）───────────────────── */
function compare(rec) {
  const c = rec.comparison, e = rec.expectation, j = rec.judge;
  if (e.kind === 'judgement') {
    if (j.ran !== true || (j.pass == null && rec.judge.malformed !== true && !rec.judge.error)) {
      /* 观测没有给出判定（调用失败 / 畸形 / 未就绪）→ agreement 未知，不得算对或错 */
      c.agreement = null;
      c.ambiguous = true;
      c.ambiguousReason = 'no_judge_decision(' + (rec.judge.error || (rec.judge.malformed ? 'malformed' : 'norun')) + ')';
      return c;
    }
    const observedOoc = j.pass === false;
    c.agreement = (observedOoc === e.ooc);
    c.falsePositiveCandidate = (!e.ooc && observedOoc);
    c.falseNegativeCandidate = (e.ooc && !observedOoc);
    c.ambiguous = false;
    return c;
  }
  /* contract 类：没有人工标签 → 不算 agreement；只算契约是否被违反 */
  c.agreement = null;
  c.ambiguous = true;
  if (e.rule === 'no_dimension_without_evidence') {
    const unavail = rec.inputFacts.evidenceDimensionsUnavailable || [];
    const judged = j.dimensions || [];
    const violated = judged.filter(d => unavail.indexOf(d) >= 0);
    c.contractViolation = violated.length ? { rule: e.rule, dimensions: violated } : null;
  } else if (e.rule === 'verify_observes_only') {
    const calls = rec.execution.calls || {};
    c.contractViolation = (calls.rewrite != null && calls.rewrite > 1) ? { rule: e.rule, rewriteCalls: calls.rewrite } : null;
  } else {
    c.contractViolation = null;   /* borderline_undecided：只用于稳定性观测 */
  }
  return c;
}

/* ── 6 · 汇总：judge / rewrite / verify **分开**度量 ──────────────────── */
function summarize(records, ctx) {
  ctx = ctx || {};
  const rows = records || [];
  const judgementRows = rows.filter(r => r.expectation.kind === 'judgement');
  const contractRows = rows.filter(r => r.expectation.kind === 'contract');

  /* judge */
  const decided = judgementRows.filter(r => r.comparison.agreement !== null);
  const tp = decided.filter(r => r.expectation.ooc === true && r.judge.pass === false).length;
  const tn = decided.filter(r => r.expectation.ooc === false && r.judge.pass === true).length;
  const fp = decided.filter(r => r.expectation.ooc === false && r.judge.pass === false).length;
  const fn = decided.filter(r => r.expectation.ooc === true && r.judge.pass === true).length;
  const judgeErrors = rows.filter(r => r.judge.error).length;
  const judgeMalformed = rows.filter(r => r.judge.malformed === true).length;
  const judgeNotRun = rows.filter(r => r.judge.ran !== true).length;

  const judge = {
    samples: rows.length,
    judgementSamples: judgementRows.length,
    contractSamples: contractRows.length,
    decided: decided.length,
    tp: tp, tn: tn, fp: fp, fn: fn,
    agreement: ratio(tp + tn, decided.length),
    precision: ratio(tp, tp + fp),
    recall: ratio(tp, tp + fn),
    specificity: ratio(tn, tn + fp),
    errors: judgeErrors,
    malformed: judgeMalformed,
    notRun: judgeNotRun,
    latencyMs: percentiles(rows.map(r => r.judge.latencyMs)),
    usage: rows.reduce((acc, r) => addUsage(acc, r.judge.usage), null),
    usageSamples: rows.filter(r => r.judge.usage).length
  };

  /* rewrite（只在真的走到 rewrite 的样本上评估）*/
  const rewriteRows = rows.filter(r => r.rewrite.triggered === true);
  const rewriteOk = rewriteRows.filter(r => r.rewrite.ok === true);
  const violated = rewriteOk.filter(r => r.rewrite.contractViolations && r.rewrite.contractViolations.length);
  const shortened = rewriteOk.filter(r => r.rewrite.lengthRatio != null && r.rewrite.lengthRatio < 0.5);
  const rewrite = {
    triggered: rewriteRows.length,
    ok: rewriteOk.length,
    failed: rewriteRows.filter(r => r.rewrite.ok === false).length,
    errorKinds: rewriteRows.filter(r => r.rewrite.ok === false).reduce((m, r) => { const k = r.rewrite.rejectReason || r.rewrite.error || 'unknown'; m[k] = (m[k] || 0) + 1; return m; }, {}),
    changed: rewriteOk.filter(r => r.rewrite.changed === true).length,
    unchanged: rewriteOk.filter(r => r.rewrite.changed === false).length,
    lengthRatio: percentiles(rewriteOk.map(r => r.rewrite.lengthRatio)),
    contractViolatingIds: violated.map(r => r.fixtureId),
    shortenedIds: shortened.map(r => r.fixtureId),
    latencyMs: percentiles(rewriteRows.map(r => r.rewrite.latencyMs)),
    usage: rewriteRows.reduce((acc, r) => addUsage(acc, r.rewrite.usage), null),
    usageSamples: rewriteRows.filter(r => r.rewrite.usage).length
  };

  /* verify（只观测）*/
  const verifyRows = rows.filter(r => r.verify.triggered === true);
  const verifyRan = verifyRows.filter(r => r.verify.ok === true);
  const acceptedBad = verifyRan.filter(r => r.verify.pass === true && r.rewrite.contractViolations && r.rewrite.contractViolations.length);
  const rejectedGood = verifyRan.filter(r => r.verify.pass === false && (!r.rewrite.contractViolations || !r.rewrite.contractViolations.length) && r.rewrite.ok === true);
  const verify = {
    triggered: verifyRows.length,
    ran: verifyRan.length,
    pass: verifyRan.filter(r => r.verify.pass === true).length,
    fail: verifyRan.filter(r => r.verify.pass === false).length,
    errors: verifyRows.filter(r => r.verify.ok === false).length,
    secondRewriteCount: rows.filter(r => (r.execution.calls || {}).rewrite > 1).length,
    acceptedBadRewriteIds: acceptedBad.map(r => r.fixtureId),
    rejectedGoodRewriteIds: rejectedGood.map(r => r.fixtureId),
    latencyMs: percentiles(verifyRows.map(r => r.verify.latencyMs)),
    usage: verifyRows.reduce((acc, r) => addUsage(acc, r.verify.usage), null),
    usageSamples: verifyRows.filter(r => r.verify.usage).length
  };

  /* 阶段组合（judge-only / +rewrite / +verify）—— §10 的三档成本要分开看 */
  const combos = { judge_only: [], judge_rewrite: [], judge_rewrite_verify: [], incomplete: [] };
  for (const r of rows) {
    const c = r.execution.calls || {};
    const rw = Number(c.rewrite) || 0, vf = Number(c.verify) || 0;
    if (rw === 0 && vf === 0) combos.judge_only.push(r);
    else if (rw >= 1 && vf === 0) combos.judge_rewrite.push(r);
    else if (rw >= 1 && vf >= 1) combos.judge_rewrite_verify.push(r);
    else combos.incomplete.push(r);
  }
  const combo = (list) => ({
    samples: list.length,
    latencyMs: percentiles(list.map(r => r.execution.latencyMs)),
    usage: list.reduce((acc, r) => addUsage(acc, r.execution.usage), null),
    usageSamples: list.filter(r => r.execution.usage).length
  });

  /* tokens（只报 token；不报钱）*/
  const totalUsage = rows.reduce((acc, r) => addUsage(acc, r.execution.usage), null);
  const candidateChars = rows.reduce((a, r) => a + r.inputFacts.candidateChars, 0);
  const tokens = {
    total: totalUsage,
    perPhase: { judge: judge.usage, rewrite: rewrite.usage, verify: verify.usage },
    samplesWithUsage: rows.filter(r => r.execution.usage).length,
    samplesWithoutUsage: rows.filter(r => !r.execution.usage).length,
    /* 放大倍数：**总 token ÷ 候选回复字符数**（不是钱，也不是"成本"）*/
    tokensPerCandidateChar: (totalUsage && totalUsage.totalTokens != null) ? ratio(totalUsage.totalTokens, candidateChars) : null,
    candidateChars: candidateChars
  };

  /* 期望 vs 观测 */
  const comparison = {
    fpCandidates: decided.filter(r => r.comparison.falsePositiveCandidate).map(r => ({ id: r.fixtureId, classes: r.classes, dimensions: r.judge.dimensions || [], note: r.expectation.note })),
    fnCandidates: decided.filter(r => r.comparison.falseNegativeCandidate).map(r => ({ id: r.fixtureId, classes: r.classes, dimensions: r.judge.dimensions || [], note: r.expectation.note })),
    ambiguous: rows.filter(r => r.comparison.ambiguous).map(r => ({ id: r.fixtureId, classes: r.classes, reason: r.comparison.ambiguousReason })),
    contractViolations: rows.filter(r => r.comparison.contractViolation).map(r => ({ id: r.fixtureId, violation: r.comparison.contractViolation }))
  };

  /* 可重复性（§5）：同一 fixture 多次运行是否给出同一个判定 */
  const byId = {};
  for (const r of rows) (byId[r.fixtureId] = byId[r.fixtureId] || []).push(r);
  const stability = { fixtures: 0, singleRun: 0, stable: 0, unstable: 0, unstableIds: [], details: [] };
  for (const id of Object.keys(byId)) {
    const list = byId[id];
    stability.fixtures++;
    if (list.length < 2) { stability.singleRun++; continue; }
    const passes = list.map(r => r.judge.pass);
    const dims = list.map(r => JSON.stringify((r.judge.dimensions || []).slice().sort()));
    const dispo = list.map(r => r.disposition);
    const passStable = passes.every(p => p === passes[0]);
    const dimStable = dims.every(d => d === dims[0]);
    const dispoStable = dispo.every(d => d === dispo[0]);
    if (passStable && dimStable && dispoStable) stability.stable++;
    else {
      stability.unstable++;
      stability.unstableIds.push(id);
      stability.details.push({ id: id, attempts: list.length, passes: passes, dimensions: dims, dispositions: dispo, passStable: passStable, dimensionStable: dimStable, dispositionStable: dispoStable });
    }
  }

  return {
    version: 'astra-readiness-observe-1',
    mode: ctx.mode || null,
    provenance: ctx.provenance || null,
    provider: ctx.provider || null,
    model: ctx.model || null,
    reasoningEffort: ctx.reasoningEffort || null,
    host: ctx.host || null,
    plan: ctx.plan || null,
    actualCalls: ctx.actualCalls || null,
    samples: rows.length,
    judge: judge,
    rewrite: rewrite,
    verify: verify,
    phases: { judge_only: combo(combos.judge_only), judge_rewrite: combo(combos.judge_rewrite), judge_rewrite_verify: combo(combos.judge_rewrite_verify), incomplete: combo(combos.incomplete) },
    tokens: tokens,
    latencyMs: percentiles(rows.map(r => r.execution.latencyMs)),
    comparison: comparison,
    stability: stability,
    errors: rows.filter(r => r.execution.error || r.judge.error || (r.rewrite.ok === false) || (r.verify.ok === false)).map(r => ({
      id: r.fixtureId, phase: r.judge.error ? 'judge' : (r.rewrite.ok === false ? 'rewrite' : (r.verify.ok === false ? 'verify' : 'transport')),
      error: r.judge.error || (r.rewrite.ok === false ? (r.rewrite.rejectReason || r.rewrite.error) : null) || (r.verify.ok === false ? r.verify.error : null) || r.execution.error || 'unknown'
    })),
    retries: rows.filter(r => Number(r.execution.retry) > 0).length,
    timeouts: rows.filter(r => r.execution.timeout === true).length,
    dispositions: rows.reduce((m, r) => { m[r.disposition || 'unknown'] = (m[r.disposition || 'unknown'] || 0) + 1; return m; }, {})
  };
}

/* ── 7 · 报告渲染（CLI 文本；所有未知一律 n/a，绝不写 0 冒充）────────── */
function n3(v) { return v == null ? 'n/a' : String(v); }
function pct(v) { return v == null ? 'n/a' : (Math.round(v * 10000) / 100).toFixed(2) + '%'; }
function dist(label, d) {
  if (!d) return '  ' + label + ': n/a';
  return '  ' + label + ': n=' + d.count + ' min=' + n3(d.min) + ' p10=' + n3(d.p10) + ' p25=' + n3(d.p25)
    + ' median=' + n3(d.median) + ' p75=' + n3(d.p75) + ' p90=' + n3(d.p90) + ' p95=' + n3(d.p95) + ' max=' + n3(d.max)
    + (d.mean != null ? ' mean=' + d.mean : '');
}
function usageLine(u, samples) {
  if (!u) return 'n/a (0 of ' + samples + ' call(s) returned usage)';
  return 'in=' + n3(u.inputTokens) + ' out=' + n3(u.outputTokens) + ' total=' + n3(u.totalTokens)
    + ' cached=' + n3(u.cachedTokens) + ' (over ' + samples + ' call(s) with usage)';
}
function renderReport(s) {
  const L = [];
  const line = (x) => L.push(x == null ? '' : x);
  line('Astra Readiness Phase 1 · Observation Report');
  line('mode=' + n3(s.mode) + '  provenance=' + n3(s.provenance) + '  host=' + n3(s.host));
  line('provider=' + n3(s.provider) + '  model=' + n3(s.model) + '  reasoningEffort=' + n3(s.reasoningEffort));
  if (s.plan) {
    line('');
    line('CALL BUDGET (declared before running)');
    line('  planned=' + s.plan.plannedCalls + '  budget=' + s.plan.budget + '  repeat=' + s.plan.repeat + '  ok=' + s.plan.ok + ' (' + s.plan.reason + ')');
    if (s.actualCalls) line('  actual: judge=' + n3(s.actualCalls.judge) + ' rewrite=' + n3(s.actualCalls.rewrite) + ' verify=' + n3(s.actualCalls.verify) + ' total=' + n3(s.actualCalls.total));
  }
  line('');
  line('SAMPLES: ' + s.samples + ' (judgement=' + s.judge.judgementSamples + ' contract=' + s.judge.contractSamples + ')');
  line('dispositions: ' + Object.keys(s.dispositions).map(k => k + '=' + s.dispositions[k]).join('  '));
  line('');
  line('JUDGE (only judgement-kind samples have a human label to agree with)');
  line('  decided=' + s.judge.decided + '  TP=' + s.judge.tp + '  TN=' + s.judge.tn + '  FP=' + s.judge.fp + '  FN=' + s.judge.fn);
  line('  agreement=' + pct(s.judge.agreement) + '  precision=' + pct(s.judge.precision) + '  recall=' + pct(s.judge.recall) + '  specificity=' + pct(s.judge.specificity));
  line('  errors=' + s.judge.errors + '  malformed=' + s.judge.malformed + '  notRun=' + s.judge.notRun);
  line(dist('latencyMs', s.judge.latencyMs));
  line('  usage: ' + usageLine(s.judge.usage, s.judge.usageSamples));
  line('');
  line('REWRITE (production gate + rewrite path)');
  line('  triggered=' + s.rewrite.triggered + '  ok=' + s.rewrite.ok + '  failed=' + s.rewrite.failed
    + '  changed=' + s.rewrite.changed + '  unchanged=' + s.rewrite.unchanged);
  if (Object.keys(s.rewrite.errorKinds).length) line('  failure kinds: ' + Object.keys(s.rewrite.errorKinds).map(k => k + '=' + s.rewrite.errorKinds[k]).join('  '));
  line(dist('lengthRatio', s.rewrite.lengthRatio));
  line('  contract-violating rewrites: ' + (s.rewrite.contractViolatingIds.length ? s.rewrite.contractViolatingIds.join(', ') : 'none'));
  line('  shortened (<0.5 of original): ' + (s.rewrite.shortenedIds.length ? s.rewrite.shortenedIds.join(', ') : 'none'));
  line(dist('latencyMs', s.rewrite.latencyMs));
  line('  usage: ' + usageLine(s.rewrite.usage, s.rewrite.usageSamples));
  line('');
  line('VERIFY (observation only; must never trigger a second rewrite)');
  line('  triggered=' + s.verify.triggered + '  ran=' + s.verify.ran + '  pass=' + s.verify.pass + '  fail=' + s.verify.fail + '  errors=' + s.verify.errors);
  line('  samples with >1 rewrite call: ' + s.verify.secondRewriteCount);
  line('  accepted a contract-violating rewrite: ' + (s.verify.acceptedBadRewriteIds.length ? s.verify.acceptedBadRewriteIds.join(', ') : 'none'));
  line('  rejected a contract-satisfying rewrite: ' + (s.verify.rejectedGoodRewriteIds.length ? s.verify.rejectedGoodRewriteIds.join(', ') : 'none'));
  line(dist('latencyMs', s.verify.latencyMs));
  line('  usage: ' + usageLine(s.verify.usage, s.verify.usageSamples));
  line('');
  line('COST / LATENCY BY PHASE COMBINATION (tokens only — no pricing metadata exists in this repo)');
  for (const k of ['judge_only', 'judge_rewrite', 'judge_rewrite_verify', 'incomplete']) {
    const c = s.phases[k];
    line('  ' + k.padEnd(22) + 'samples=' + String(c.samples).padEnd(5) + ' usage: ' + usageLine(c.usage, c.usageSamples));
    if (c.samples) line('  ' + ''.padEnd(22) + dist('latency', c.latencyMs).trim());
  }
  line('');
  line('TOKENS');
  line('  total: ' + usageLine(s.tokens.total, s.tokens.samplesWithUsage));
  line('  samples without usage: ' + s.tokens.samplesWithoutUsage);
  line('  candidates total chars=' + s.tokens.candidateChars + '  tokens per candidate char=' + n3(s.tokens.tokensPerCandidateChar));
  line('');
  line('EXPECTED vs OBSERVED');
  line('  FP candidates (expected pass, observed OOC): ' + (s.comparison.fpCandidates.length ? s.comparison.fpCandidates.map(x => x.id).join(', ') : 'none'));
  line('  FN candidates (expected OOC, observed pass): ' + (s.comparison.fnCandidates.length ? s.comparison.fnCandidates.map(x => x.id).join(', ') : 'none'));
  line('  ambiguous / insufficient-evidence samples: ' + s.comparison.ambiguous.length);
  if (s.comparison.contractViolations.length) {
    line('  CONTRACT VIOLATIONS:');
    for (const v of s.comparison.contractViolations) line('    ' + v.id + '  ' + JSON.stringify(v.violation));
  } else line('  contract violations: none');
  line('');
  line('REPEATABILITY');
  line('  fixtures=' + s.stability.fixtures + '  single-run=' + s.stability.singleRun + '  stable=' + s.stability.stable + '  unstable=' + s.stability.unstable);
  for (const d of s.stability.details) line('    ' + d.id + ' passes=' + JSON.stringify(d.passes) + ' dimsStable=' + d.dimensionStable + ' dispoStable=' + d.dispositionStable);
  line('');
  line('ERRORS / RETRIES / TIMEOUTS');
  line('  retries=' + s.retries + '  timeouts=' + s.timeouts);
  for (const e of s.errors) line('    ' + e.id + '  ' + e.phase + ': ' + String(e.error).slice(0, 120));
  return L.join('\n');
}

module.exports = {
  MAX_PLANNED_CALLS, MAX_REPEAT,
  planCalls, redact, leaksSecret, authPresence,
  percentiles, ratio,
  emptyObservation, usageOf, addUsage, compare, summarize, renderReport
};
