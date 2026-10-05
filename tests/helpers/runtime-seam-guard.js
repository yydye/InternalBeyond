'use strict';
/* ====================================================================
   P21-R4-F · Runtime seam guard（**唯一**的 seam 位置权威）
   --------------------------------------------------------------------
   为什么要有这个文件：LIVE-4 的守卫写着"recall 边界里 `behaviorEffect`
   这个词不许出现"。R4-F 把 BehaviorEffect 的**交付通道**按设计放进了
   runtime-recall.js（第 17 键 + 确定性派生 seam）。于是"禁止这个词"这条
   旧守卫必然变红 —— 而它**不能**被删掉、也**不能**被简单放宽成正则白名单：
   一个"允许出现"的正则看不见"第二个 seam""在错误函数里读 holder"
   "在 selector 阶段派生""源回合直接消费"这四类真实缺陷。

   本模块把守卫从"词是否出现"升级为"**精确位置 + 调用关系**"：
     · 装配注入的那一行 dep 必须**恰好一次**，且本文件**不构造**它
       （没有 `createRuntimeBehaviorEffect(`、没有 require、没有读权威、
        没有持有者常量）；
     · `deriveAndHold` 全局**恰好一次**，且必须落在
       `scheduleExpectationFromInterpretation` 的 `runTask` 里，
       紧跟在 `status === 'created'` 之后，并携带
       `interpretationValidated: true` / `interpretation: payload.interpretation`
       / `expectationHeld: true` / `expectation: res`（L3 **且** L5）；
     · `consumeForTurn` 全局**恰好一次**，且必须落在
       `behaviorEffectForEnvelope` 里（交付缝）；
     · 其余 `behaviorEffect` 记号只允许落在 5 个**具名**位置：
       dep 行 · `behaviorEffectForEnvelope` · `failure` · `run` · `describe`；
       任何第 6 个位置都是第二个 seam ⇒ 红；
     · 选择阶段区域（`const messageHash` → `counters.ok += 1;`）与
       `scheduleAutoInterpretation` 体内：`behaviorEffect` 一个都不许有
       （那正是"在 selector 阶段派生 / 源回合直接消费"的形状）；
     · `counterfactual` / `prediction-error` **仍然全面禁止**；
     · 解释边界（runtime-interpretation.js）四个域**全部**仍然禁止。

   `forgeRecallSeam(src, kind)` 提供 §23 的五个**对抗样本**：守卫必须逐个
   抓住（`ok === false`）。只有正例通过是不够的 —— 那证明不了守卫在看什么。
   这些函数是**纯文本**函数：没有 fs、没有网络，输入是源码字符串。
   ==================================================================== */

const { stripJsComments } = require('./activation-wiring-probe.js');

/* 完全禁止的域（任何文件、任何理由）。behaviorEffect **不在这里** ——
   它是本相位获授权的交付通道，但只允许出现在下面那 5 个具名位置。 */
const FORBIDDEN_EVERYWHERE = Object.freeze(['counterfactual', 'prediction-error']);
const FORBIDDEN_IN_INTERPRETATION = Object.freeze(['expectation', 'behaviorEffect', 'counterfactual', 'prediction-error']);

const DEP_LINE_SIGNATURE = 'const behaviorEffect = deps.behaviorEffect || null;';

function regionOf(code, signature, from) {
  const start = code.indexOf(signature, from || 0);
  if (start < 0) return null;
  const open = code.indexOf('{', start + signature.length);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    const ch = code[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') { depth -= 1; if (depth === 0) return { start: start, end: i + 1, text: code.slice(start, i + 1) }; }
  }
  return null;
}
function contains(region, index) { return !!region && index >= region.start && index < region.end; }
function occurrences(haystack, needle) {
  const out = [];
  let at = haystack.indexOf(needle);
  while (at >= 0) { out.push(at); at = haystack.indexOf(needle, at + needle.length); }
  return out;
}
function lineOf(code, index) { return code.slice(0, index).split('\n').length; }

/* ── 对抗样本：把"另一种 seam"写进真实源码里 ─────────────────────────── */
function forgeRecallSeam(source, kind) {
  const src = String(source == null ? '' : source);
  const into = (signature, snippet) => {
    const at = src.indexOf(signature);
    if (at < 0) return null;
    const open = src.indexOf('{', at + signature.length);
    if (open < 0) return null;
    return src.slice(0, open + 1) + '\n  ' + snippet + '\n' + src.slice(open + 1);
  };
  switch (kind) {
    /* ① 第二个交付 seam：在另一个函数里再消费一次 */
    case 'second-consume-seam':
      return into('function settleAutoWaiters()', 'out.behaviorEffect = behaviorEffect.consumeForTurn({ characterId: characterId, conversationId: conversationId, turnId: turnId });');
    /* ② 在这里**构造** BehaviorEffect（而不是由装配注入） */
    case 'construct-in-recall':
      return into('function createRuntimeRecall(deps)', 'const rogueBehaviorEffect = createRuntimeBehaviorEffect({});');
    /* ③ 在错误的函数里读 holder */
    case 'holder-read-in-wrong-function':
      return into('function settleAutoWaiters()', 'const rogueHeld = behaviorEffect.heldCount(); if (rogueHeld < 0) return;');
    /* ④ 在 Recall selector 阶段派生 */
    case 'derive-in-selector-stage':
      return into('function scheduleAutoInterpretation(ctx)', 'behaviorEffect.deriveAndHold({ characterId: characterId, conversationId: conversationId, turnId: turnId, interpretationValidated: true, expectationHeld: true });');
    /* ⑤ 源回合直接消费自己的效果 */
    case 'consume-in-source-turn':
      return into('function scheduleAutoInterpretation(ctx)', 'behaviorEffect.consumeForTurn({ characterId: characterId, conversationId: conversationId, turnId: turnId });');
    default:
      return null;
  }
}
const FORGERY_KINDS = Object.freeze([
  'second-consume-seam', 'construct-in-recall', 'holder-read-in-wrong-function',
  'derive-in-selector-stage', 'consume-in-source-turn'
]);

/* ── recall 边界审计 ────────────────────────────────────────────────── */
function auditRecallSeam(rawSource) {
  const raw = String(rawSource == null ? '' : rawSource);
  const code = stripJsComments(raw);
  const reasons = [];
  const facts = { tokenSites: [], regions: {} };

  if (!/function createRuntimeRecall\(deps\)/.test(code)) reasons.push('not-the-recall-boundary');

  /* 1 · 全面禁止的域 */
  for (const token of FORBIDDEN_EVERYWHERE) {
    if (code.toLowerCase().indexOf(token) >= 0) reasons.push('forbidden-domain-in-recall:' + token);
  }
  /* 2 · 本文件不得**获得** BehaviorEffect 权威（只能装配注入） */
  if (/createRuntimeBehaviorEffect\s*\(/.test(code)) reasons.push('behavior-effect-constructed-in-recall');
  if (/require\([^)]*runtime-behavior-effect/.test(code)) reasons.push('behavior-effect-required-in-recall');
  if (/MAX_HELD_BEHAVIOR_EFFECTS|HOLDER_TTL_MS/.test(code)) reasons.push('recall-manages-behavior-holder-constants');
  if (/readBehaviorEffect|setBehaviorEffect/.test(code)) reasons.push('recall-reads-behavior-authority');
  if (/\brender(Line)?\s*\(/.test(code)) reasons.push('recall-renders-effect-line');

  /* 3 · dep 行恰好一次 */
  const depSites = occurrences(code, DEP_LINE_SIGNATURE);
  facts.depLineCount = depSites.length;
  if (depSites.length !== 1) reasons.push('behavior-effect-dep-line-count:' + depSites.length);
  const depSpan = depSites.length === 1
    ? { start: depSites[0], end: depSites[0] + DEP_LINE_SIGNATURE.length }
    : null;

  /* 4 · 预期 seam 区域 */
  const envRegion = regionOf(code, 'function behaviorEffectForEnvelope(ctx)');
  const failureRegion = regionOf(code, 'function failure(code, ctx)');
  const runRegion = regionOf(code, 'async function run(body, options)');
  const descRegion = regionOf(code, 'function describe()');
  const schedRegion = regionOf(code, 'function scheduleExpectationFromInterpretation(ctx, binding, interpretationRes)');
  const autoRegion = regionOf(code, 'function scheduleAutoInterpretation(ctx)');
  facts.regions = {
    behaviorEffectForEnvelope: !!envRegion, failure: !!failureRegion, run: !!runRegion,
    describe: !!descRegion, scheduleExpectationFromInterpretation: !!schedRegion,
    scheduleAutoInterpretation: !!autoRegion
  };
  if (!envRegion) reasons.push('missing-delivery-seam:behaviorEffectForEnvelope');
  if (!schedRegion) reasons.push('missing-expectation-seam:scheduleExpectationFromInterpretation');
  if (!runRegion) reasons.push('missing-run');
  if (!descRegion) reasons.push('missing-describe');
  if (!failureRegion) reasons.push('missing-failure');

  /* 5 · 期望 L3 中介的**既有**纪律（LIVE-5 保留项，逐字未放宽） */
  if (!new RegExp('const expectation = deps\\.expectation \\|\\| null;').test(code)) reasons.push('expectation-not-taken-from-assembly');
  if (/createRuntimeExpectation\s*\(/.test(code)) reasons.push('expectation-constructed-in-recall');
  if (/readExpectation|setExpectation/.test(code)) reasons.push('recall-reads-expectation-authority');
  /* ★ 这一条量的是**自动解释调度体内**与期望域的唯一交互（原 LIVE-5 守卫
     的语义），因此必须落在 `scheduleAutoInterpretation` 里 —— 用它自己的
     区域，而不是期望调度函数的区域（后者满篇都是"expectation"，那是它的
     本职，不是耦合证据）。 */
  const schedExpectationLines = autoRegion
    ? autoRegion.text.split('\n').map((s) => s.trim()).filter((s) => /expectation/i.test(s))
    : [];
  facts.schedulerExpectationLines = schedExpectationLines;
  if (!autoRegion || schedExpectationLines.length !== 1 || !/scheduleExpectationFromInterpretation\(/.test(schedExpectationLines[0])) {
    reasons.push('expectation-scheduler-interaction-count:' + schedExpectationLines.length);
  }

  /* 6 · 期望 runTask 区域（`const status = / const runTask =` 两处同名 ⇒ 取 sched 内那一处） */
  let expectationRunTask = null;
  if (schedRegion) {
    const local = regionOf(schedRegion.text, 'const runTask = async () =>');
    if (local) expectationRunTask = { start: schedRegion.start + local.start, end: schedRegion.start + local.end, text: local.text };
  }
  facts.regions.expectationRunTask = !!expectationRunTask;
  if (!expectationRunTask) reasons.push('missing-expectation-runTask');

  /* 7 · derive / consume 的**唯一**调用位置（带括号 = 调用；
     `typeof x.deriveAndHold === 'function'` 那一处探针不算第二次调用）。 */
  const deriveSites = occurrences(code, '.deriveAndHold(');
  const consumeSites = occurrences(code, '.consumeForTurn(');
  facts.deriveSites = deriveSites.map((i) => lineOf(code, i));
  facts.consumeSites = consumeSites.map((i) => lineOf(code, i));
  if (deriveSites.length !== 1) reasons.push('deriveAndHold-call-count:' + deriveSites.length);
  else if (!contains(expectationRunTask, deriveSites[0])) reasons.push('deriveAndHold-outside-expectation-runTask');
  if (consumeSites.length !== 1) reasons.push('consumeForTurn-call-count:' + consumeSites.length);
  else if (!contains(envRegion, consumeSites[0])) reasons.push('consumeForTurn-outside-delivery-seam');

  /* 8 · 派生调用点必须同时携带 L3 与 L5（且只在 status==='created' 之后） */
  if (expectationRunTask && deriveSites.length === 1) {
    const body = expectationRunTask.text;
    const statusAt = body.indexOf("status === 'created'");
    const deriveAt = body.indexOf('.deriveAndHold(');
    const required = [
      'interpretationValidated: true', 'interpretationResult: interpretationRes',
      'expectationHeld: true', 'expectation: res'
    ];
    for (const needle of required) {
      if (body.indexOf(needle) < 0) reasons.push('derive-call-missing:' + needle);
    }
    if (statusAt < 0 || deriveAt < 0 || statusAt > deriveAt) reasons.push('derive-not-guarded-by-created-status');
  }

  /* 9 · behaviorEffect 记号只允许落在 5 个具名位置 */
  for (const at of occurrences(code, 'behaviorEffect')) {
    const site = {
      line: lineOf(code, at),
      inDepLine: !!depSpan && at >= depSpan.start && at < depSpan.end,
      inEnvelopeSeam: contains(envRegion, at),
      inFailure: contains(failureRegion, at),
      inRun: contains(runRegion, at),
      inDescribe: contains(descRegion, at),
      inExpectationRunTask: contains(expectationRunTask, at)
    };
    facts.tokenSites.push(site);
    const allowed = site.inDepLine || site.inEnvelopeSeam || site.inFailure || site.inRun || site.inDescribe || site.inExpectationRunTask;
    if (!allowed) reasons.push('behaviorEffect-outside-authorized-seam:line-' + site.line);
  }

  /* 10 · 选择阶段与自动解释调度体内不得有 behaviorEffect */
  const selStart = code.indexOf('const messageHash');
  const selEnd = code.indexOf('counters.ok += 1;');
  if (selStart >= 0 && selEnd > selStart) {
    const selectionRegion = { start: selStart, end: selEnd };
    for (const at of occurrences(code, 'behaviorEffect')) {
      if (contains(selectionRegion, at)) reasons.push('behaviorEffect-in-selection-stage:line-' + lineOf(code, at));
    }
  } else {
    reasons.push('selection-region-not-found');
  }
  if (autoRegion) {
    for (const at of occurrences(code, 'behaviorEffect')) {
      if (contains(autoRegion, at)) reasons.push('behaviorEffect-in-auto-interpretation-scheduler:line-' + lineOf(code, at));
    }
  }

  /* 11 · describe() 不得消费 / 派生 */
  if (descRegion) {
    if (/consumeForTurn|deriveAndHold/.test(descRegion.text)) reasons.push('describe-consumes-or-derives');
  }

  return { ok: reasons.length === 0, reasons: reasons, facts: facts, codeLength: code.length };
}

/* ── 解释边界审计：四域全禁（措辞未放宽）───────────────────────────── */
function auditInterpretationSeam(rawSource) {
  const code = stripJsComments(String(rawSource == null ? '' : rawSource));
  const reasons = [];
  const hits = [];
  for (const token of FORBIDDEN_IN_INTERPRETATION) {
    if (code.toLowerCase().indexOf(token) >= 0) { reasons.push('forbidden-domain-in-interpretation:' + token); hits.push(token); }
  }
  return { ok: reasons.length === 0, reasons: reasons, facts: { forbiddenHits: hits } };
}

module.exports = {
  auditRecallSeam, auditInterpretationSeam,
  forgeRecallSeam, FORGERY_KINDS,
  FORBIDDEN_EVERYWHERE, FORBIDDEN_IN_INTERPRETATION,
  DEP_LINE_SIGNATURE, regionOf, contains, occurrences, lineOf
};
