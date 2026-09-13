/* ====================================================================
   P11-2B · Character Integrity 系统裁定状态契约 · 离线确定性回归
   --------------------------------------------------------------------
   本文件回答且只回答一个问题：

     当 Judge 没有给出 verdict 时，IB 在 **contract 层**能不能明确表达出
     "没有拿到 verdict"，并且把它传播下去 —— 而不是像 P11-2B 之前那样
     被 middleBrainFinalizeReply 压平成一个与 PASS 无法区分的 bare string？

   ── 被冻结的契约 ───────────────────────────────────────────────────
     · 系统裁定状态是**四态**，且只由 integrity 层产生：
         PASS      Judge 合法 report 且 report.pass === true
         OOC       Judge 合法 report 且 report.pass === false（含被 gate 拦下的）
         UNDECIDED 尝试过 Judge，但没有拿到合法 verdict（timeout / 传输失败 /
                   malformed / 证据组装异常）
         BYPASSED  有意**不调用** Judge（未启用 / 语音面 / 无可见文本 / Astra 未就绪）
     · 前两态只能来自合法 parsed Judge report；schema 的 pass:boolean 不变。
     · UNDECIDED 与 BYPASSED 是两个不同事实，不得互相吞并：
       UNDECIDED 是可用性失败，BYPASSED 是有意跳过。
     · pass 只在有真实 verdict 时是 boolean；否则一律 null（绝不 coercion 成 false）。
     · null 不得被 coercion 成 [] 或 false（dimensions / violations / maxSeverity）。
     · 门面回 {reply, outcome}：reply 是文本适配器（旧契约逐字等价），
       outcome 是显式状态。文本是否变化与裁定状态是**两个独立维度**。

   ── 运行 ────────────────────────────────────────────────────────────
     node tests/test_middle_brain_integrity_state.js
   纯 Node、零网络（传输被换成确定性 stub）、零浏览器、零真实 provider 调用。
   加载的是**生产文件本身**（assets/js/middle-brain-integrity.js + 门面 +
   Home Node 适配层），不是副本。
   ==================================================================== */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');

let failures = 0;
const check = (name, cond, detail) => {
  if (cond) console.log('  PASS  ' + name);
  else { failures++; console.error('  FAIL  ' + name + (detail ? '  -> ' + detail : '')); }
};

/* ── 生产装配：与 Home Node / 桌面同一条 require 路径 ───────────────── */
const createNodeMiddleBrain = require(path.join(ROOT, 'services', 'home-node', 'middle-brain.js'));
const LOADED = createNodeMiddleBrain.loadCanonicalMiddleBrain();
if (!LOADED || !LOADED.facade || !LOADED.facade.middleBrainFinalizeReply) {
  throw new Error('canonical middle brain unavailable: ' + JSON.stringify(LOADED && Object.keys(LOADED)));
}
const MBC = globalThis.IB.__middleBrainContracts;
const INTEG = MBC.integrity;
const FACADE = globalThis.IB.middleBrain;
const VERDICT = INTEG.MB_CI_VERDICT;

const FRIEND = 'p11_2b_role';
const USER = 'CI_USER_MESSAGE';
const CANDIDATE = 'CANDIDATE_REPLY_原文';
const REWRITTEN = 'REWRITTEN_REPLY_已修正';
const OPTS = {
  character: { nickname: '泠', relationship: '熟悉的伙伴', systemPrompt: '你是冷淡、话少、偶尔毒舌的猫娘「泠」。' },
  history: [{ role: 'user', content: '今天好累' }, { role: 'assistant', content: '嗯。' }]
};
const STRONG_OOC = JSON.stringify({
  pass: false, score: 0.12, confidence: 0.95,
  violations: [{ dimension: 'persona', severity: 0.9, evidence: '我是AI助手', reason: '与角色人格实质冲突' }]
});
const SLIGHT = JSON.stringify({
  pass: false, score: 0.42, confidence: 0.70,
  violations: [{ dimension: 'speech_style', severity: 0.55, evidence: '嗯', reason: '措辞略有差异' }]
});

/* ── 确定性传输 stub：替换唯一的网络边界（ASTRA.middleBrainModelCall 走它）──
   记录每一次出站请求 → 直接支撑"无额外调用 / 无重试"这两条硬断言。 */
const net = { calls: [], judgeMode: 'ok', judgePayload: '{}', rewritePayload: JSON.stringify({ reply: REWRITTEN }) };
const resetNet = () => { net.calls = []; net.judgeMode = 'ok'; net.judgePayload = '{}'; net.rewritePayload = JSON.stringify({ reply: REWRITTEN }); };
const responsesBody = text => JSON.stringify({ output: [{ type: 'message', content: [{ type: 'output_text', text }] }], usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 } });
const okResp = text => ({ ok: true, status: 200, json: async () => JSON.parse(responsesBody(text)), text: async () => responsesBody(text) });
globalThis._ibApiPost = async (url, headers, body, o) => {
  const raw = String(body || '');
  const kind = /character_integrity_report/.test(raw) ? 'judge'
    : (/character_integrity_rewrite/.test(raw) ? 'rewrite' : 'other');
  net.calls.push({ kind: kind, url: String(url || '') });
  if (kind === 'judge' && net.judgeMode === 'slow') {
    /* 慢响应：谁先到谁赢 —— 生产 20s deadline 或测试传入的更短 deadline。
       只在 slow 模式下挂 abort 监听；正常路径必须立刻返回（否则会挂住）。 */
    const aborted = new Promise((resolve, reject) => {
      const sig = o && o.signal;
      if (!sig) return resolve('none');
      if (sig.aborted) return reject(new Error('aborted'));
      sig.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
    await Promise.race([aborted, new Promise(r => setTimeout(r, 5000))]);
    return okResp(net.judgePayload);
  }
  if (kind === 'judge') {
    if (net.judgeMode === 'fail') return { ok: false, status: 500, json: async () => ({}), text: async () => '' };
    return okResp(net.judgePayload);
  }
  if (kind === 'rewrite') return okResp(net.rewritePayload);
  return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
};

/* ── 配置注入：canonical config reader（桌面与 Home Node 同一契约）──── */
const cfgBase = () => ({ enabled: true, endpoint: 'https://stub.invalid/v1/responses', model: 'stub-model', apiKey: 'sk-stub' });
const setCfg = patch => { globalThis.__ibMiddleBrainConfigReader = () => Object.assign(cfgBase(), patch); };
const resetState = () => { resetNet(); INTEG.middleBrainCharacterIntegrityReset(); };
const netCalls = kind => net.calls.filter(c => c.kind === kind).length;

const finalize = (candidate, opts) => FACADE.middleBrainFinalizeReply(FRIEND, USER, candidate, Object.assign({}, OPTS, opts || {}));
const vOf = r => (r && r.outcome && r.outcome.verdict) || null;
const reasonOf = r => (r && r.outcome && r.outcome.reason) || null;

/* ══════════════════════════════════════════════════════════════════════ */
(async function main() {
  console.log('P11-2B · Character Integrity state contract\n');

  /* ── A. 契约形状本身 ─────────────────────────────────────────────── */
  check('A1.verdictEnumIsFourState', VERDICT && VERDICT.PASS === 'PASS' && VERDICT.OOC === 'OOC'
    && VERDICT.UNDECIDED === 'UNDECIDED' && VERDICT.BYPASSED === 'BYPASSED'
    && Object.keys(VERDICT).length === 4, JSON.stringify(VERDICT));
  check('A2.schemaPassStaysBoolean', MBC.integrity.MB_CI_SCHEMA.properties.pass.type === 'boolean'
    && MBC.integrity.MB_CI_SCHEMA.required.indexOf('pass') >= 0
    && Object.keys(MBC.integrity.MB_CI_SCHEMA.properties).length === 4,
    'Judge schema 被改动（本阶段禁止把系统状态塞进模型输出）');
  check('A3.timeoutConstantUnchanged', INTEG.MB_CI_TIMEOUT_MS === 20000, String(INTEG.MB_CI_TIMEOUT_MS));

  /* ── B. 四态本体 ─────────────────────────────────────────────────── */
  setCfg({ characterIntegrityEnabled: true, characterIntegrityRewrite: true, characterIntegritySensitivity: 'conservative' });

  /* B1 · PASS：合法 report + pass===true */
  resetState(); net.judgePayload = JSON.stringify({ pass: true, score: 0.93, confidence: 0.9, violations: [] });
  let r = await finalize(CANDIDATE);
  check('T1.passVerdict', vOf(r) === 'PASS', JSON.stringify(r.outcome));
  check('T1b.passFieldsHonest', r.outcome.pass === true && r.outcome.reason === null && r.outcome.ran === true
    && r.outcome.report && r.outcome.report.pass === true && r.outcome.violations.length === 0 && r.outcome.maxSeverity === 0,
    JSON.stringify(r.outcome));
  check('T6.passReplyUnchanged', r.reply === CANDIDATE && r.outcome.rewritten === false);
  check('T18a.passSingleCall', net.calls.length === 1 && netCalls('judge') === 1, JSON.stringify(net.calls));

  /* B2 · OOC + rewrite 成功 */
  resetState(); net.judgePayload = STRONG_OOC;
  r = await finalize(CANDIDATE);
  check('T2.oocVerdict', vOf(r) === 'OOC' && r.outcome.pass === false && r.reply === REWRITTEN
    && r.outcome.rewritten === true && r.outcome.reason === 'strong_ooc', JSON.stringify(r.outcome));
  check('T2b.oocCarriesViolations', Array.isArray(r.outcome.violations) && r.outcome.violations.length === 1
    && r.outcome.violations[0].dimension === 'persona' && r.outcome.maxSeverity === 0.9,
    JSON.stringify({ v: r.outcome.violations, s: r.outcome.maxSeverity }));
  check('T14.rewrittenIndependentOfVerdict', r.outcome.rewritten === true && vOf(r) === 'OOC'
    && (await (async () => { resetState(); net.judgePayload = SLIGHT; const x = await finalize(CANDIDATE); return x.outcome.rewritten === false && vOf(x) === 'OOC'; })()),
    'rewritten 与 verdict 不是独立维度');

  /* B3 · OOC + gate 拦下（真实 verdict，但文本未变） */
  resetState(); net.judgePayload = SLIGHT;
  r = await finalize(CANDIDATE);
  check('T15.gateBlockedOocDistinctFromPass', vOf(r) === 'OOC' && r.outcome.pass === false && r.outcome.rewritten === false
    && r.reply === CANDIDATE && r.outcome.gate && r.outcome.gate.rewrite === false && r.outcome.reason === r.outcome.gate.reason,
    JSON.stringify({ v: vOf(r), gate: r.outcome.gate }));

  /* ── C. UNDECIDED：尝试过但没有 verdict ──────────────────────────── */
  /* C1 · timeout */
  resetState(); net.judgeMode = 'slow';
  r = await finalize(CANDIDATE, { judgeTimeoutMs: 300 });
  check('T3.timeoutUndecided', vOf(r) === 'UNDECIDED' && reasonOf(r) === 'timeout', JSON.stringify(r.outcome));
  check('T7.timeoutIsNotPass', vOf(r) !== 'PASS' && r.outcome.pass !== true, JSON.stringify(r.outcome));
  check('T8.timeoutIsNotOoc', vOf(r) !== 'OOC' && r.outcome.pass !== false, JSON.stringify(r.outcome));
  check('T10.timeoutDoesNotBecomePassFalse', r.outcome.pass === null, 'pass=' + JSON.stringify(r.outcome.pass));
  check('T9.timeoutNullsStayNull', r.outcome.report === null && r.outcome.violations === null
    && r.outcome.maxSeverity === null && r.outcome.gate === null, JSON.stringify(r.outcome));
  check('T6b.timeoutReplyPassthrough', r.reply === CANDIDATE && r.outcome.rewritten === false && netCalls('rewrite') === 0);

  /* C2 · HTTP / 传输失败 */
  resetState(); net.judgeMode = 'fail';
  r = await finalize(CANDIDATE);
  check('T4.providerErrorUndecided', vOf(r) === 'UNDECIDED' && reasonOf(r) === 'http' && r.outcome.pass === null
    && r.reply === CANDIDATE, JSON.stringify(r.outcome));

  /* C3 · malformed */
  resetState(); net.judgePayload = '这不是 JSON';
  r = await finalize(CANDIDATE);
  check('T5.malformedUndecided', vOf(r) === 'UNDECIDED' && reasonOf(r) === 'malformed' && r.outcome.pass === null
    && r.outcome.report === null, JSON.stringify(r.outcome));

  /* C4 · 证据组装异常（未预期异常 → UNDECIDED，绝不假装正常） */
  resetState();
  const badChar = {}; Object.defineProperty(badChar, 'nickname', { get() { throw new Error('boom'); } });
  r = await finalize(CANDIDATE, { character: badChar, history: null });
  check('C4.guardErrorUndecided', vOf(r) === 'UNDECIDED' && reasonOf(r) === 'guard_error' && r.outcome.pass === null
    && r.reply === CANDIDATE, JSON.stringify(r.outcome));

  /* C5 · 每一个 Judge 失败码都不会被当成 PASS */
  setCfg({ characterIntegrityEnabled: true, characterIntegrityRewrite: true, apiKey: '' });
  resetState();
  r = await finalize(CANDIDATE);
  check('C5.notReadyIsBypassedNotUndecided', vOf(r) === 'BYPASSED' && reasonOf(r) === 'astra_not_ready'
    && r.outcome.ran === false && net.calls.length === 0, JSON.stringify(r.outcome));

  /* ── D. BYPASSED：有意不调用 Judge ───────────────────────────────── */
  setCfg({ characterIntegrityEnabled: false, characterIntegrityRewrite: false });
  resetState();
  r = await finalize(CANDIDATE);
  check('T17a.disabledIsBypassed', vOf(r) === 'BYPASSED' && reasonOf(r) === 'disabled' && r.outcome.pass === null
    && r.outcome.ran === false && net.calls.length === 0, JSON.stringify(r.outcome));

  setCfg({ characterIntegrityEnabled: true, characterIntegrityRewrite: true });
  resetState();
  r = await finalize(CANDIDATE, { voice: true });
  check('T17b.voiceSurfaceIsBypassed', vOf(r) === 'BYPASSED' && reasonOf(r) === 'voice_surface' && net.calls.length === 0,
    JSON.stringify(r.outcome));

  resetState();
  r = await finalize('   ');
  check('T17c.blankCandidateIsBypassed', vOf(r) === 'BYPASSED' && reasonOf(r) === 'empty_candidate' && net.calls.length === 0,
    JSON.stringify(r.outcome));

  resetState();
  r = await finalize('<withdraw/>');
  check('T17d.noVisibleTextIsBypassed', vOf(r) === 'BYPASSED' && reasonOf(r) === 'no_visible_text'
    && r.reply === '<withdraw/>' && net.calls.length === 0, JSON.stringify(r.outcome));

  /* ── E. 空 / 非法 candidate：不产生裁定状态，也不抛异常 ───────────── */
  resetState();
  check('E1.emptyCandidateNoOutcome', (await finalize('')).reply === '' && net.calls.length === 0);
  r = await finalize(null);
  check('E2.nullCandidateSafe', r && r.reply === null && r.outcome === null && net.calls.length === 0, JSON.stringify(r));
  r = await finalize(undefined);
  check('E3.undefinedCandidateSafe', r && r.reply === undefined && r.outcome === null, JSON.stringify(r));
  check('E4.emptyStringIsNotBypassed', typeof r.reply !== 'string', '没有可裁定对象时不应产生裁定状态');

  /* ── F. 门面不再压平：同文本、不同 verdict ───────────────────────── */
  resetState(); net.judgePayload = JSON.stringify({ pass: true, score: 0.93, confidence: 0.9, violations: [] });
  const passOut = await finalize(CANDIDATE);
  resetState(); net.judgeMode = 'slow';
  const tmoOut = await finalize(CANDIDATE, { judgeTimeoutMs: 300 });
  resetState(); net.judgePayload = SLIGHT;
  const gateOut = await finalize(CANDIDATE);
  check('F1.identicalTextThreeDistinctVerdicts',
    passOut.reply === CANDIDATE && tmoOut.reply === CANDIDATE && gateOut.reply === CANDIDATE
    && vOf(passOut) === 'PASS' && vOf(tmoOut) === 'UNDECIDED' && vOf(gateOut) === 'OOC',
    JSON.stringify({ p: vOf(passOut), t: vOf(tmoOut), o: vOf(gateOut) }));
  check('F2.passBooleanTriadIsDistinct',
    passOut.outcome.pass === true && tmoOut.outcome.pass === null && gateOut.outcome.pass === false,
    JSON.stringify({ p: passOut.outcome.pass, t: tmoOut.outcome.pass, g: gateOut.outcome.pass }));
  check('F3.outcomeCarriesItsOwnReply',
    typeof passOut.outcome.reply === 'string' && typeof gateOut.outcome.reply === 'string' && gateOut.outcome.reply === CANDIDATE,
    'outcome 必须自带本层解析出的文本，下游才不必回头比 replyText');

  /* ── G. 无额外调用 / 无重试 ─────────────────────────────────────── */
  resetState(); net.judgeMode = 'fail';
  await finalize(CANDIDATE);
  check('T18b.providerErrorNoExtraCall', net.calls.length === 1 && netCalls('judge') === 1, JSON.stringify(net.calls));
  resetState(); net.judgeMode = 'slow';
  await finalize(CANDIDATE, { judgeTimeoutMs: 300 });
  check('T19.timeoutNoRetry', net.calls.length === 1 && netCalls('judge') === 1 && netCalls('rewrite') === 0, JSON.stringify(net.calls));
  resetState(); net.judgePayload = STRONG_OOC;
  await finalize(CANDIDATE);
  check('T19b.rewriteAtMostOnce', netCalls('rewrite') <= 1 && netCalls('judge') === 1, JSON.stringify(net.calls));

  /* ── H. telemetry：状态分布 + UNDECIDED ≠ judgeError ─────────────── */
  setCfg({ characterIntegrityEnabled: true, characterIntegrityRewrite: true, characterIntegritySensitivity: 'conservative' });
  resetState();
  /* 用**快照差分**而不是绝对值：telemetry 是进程级累计量，绝对值会被前序小节
     （尤其是 slow / timeout 的竞速）污染，差分才只反映本小节实际发生的事。 */
  const snap = () => {
    const t = INTEG.middleBrainCharacterIntegrityTelemetry();
    return { pass: t.verdicts.PASS || 0, ooc: t.verdicts.OOC || 0,
      und: t.verdicts.UNDECIDED || 0, byp: t.verdicts.BYPASSED || 0,
      u: t.judgeUndecided, err: t.judgeError, mal: t.judgeMalformed, runs: t.judgeRuns };
  };
  const base = snap();
  net.judgePayload = JSON.stringify({ pass: true, score: 0.93, confidence: 0.9, violations: [] });
  await finalize(CANDIDATE);
  net.judgePayload = '垃圾';
  await finalize(CANDIDATE);
  setCfg({ characterIntegrityEnabled: false });
  await finalize(CANDIDATE);
  const after = snap();
  const d = k => after[k] - base[k];
  check('H1.verdictDistribution', d('pass') === 1 && d('und') === 1 && d('byp') === 1 && d('ooc') === 0,
    JSON.stringify({ base: base, after: after }));
  /* judgeUndecided 的口径比 judgeMalformed 更宽：它统计的是"尝试过但没有拿到 verdict"
     这个**系统事实**，malformed 与 transport error 都算进来（这里恰好只有 malformed）。 */
  check('H2.judgeUndecidedCoversNonTransportFailures', d('u') === 1 && d('mal') === 1 && d('err') === 0 && d('runs') === 2,
    JSON.stringify({ du: d('u'), dmal: d('mal'), derr: d('err'), druns: d('runs') }));

  /* ── I. Home Node 适配层：状态被传播，不再从文本推断 ─────────────── */
  const NODE = createNodeMiddleBrain({ executionConfig: () => ({}), logger: () => {} });
  setCfg({ characterIntegrityEnabled: true, characterIntegrityRewrite: true });

  resetState(); net.judgePayload = JSON.stringify({ pass: true, score: 0.93, confidence: 0.9, violations: [] });
  let n = await NODE.finalizeReply({ characterId: FRIEND, userMessage: USER, candidate: CANDIDATE, character: OPTS.character, history: OPTS.history });
  check('T13a.nodePassContract', n.reply === CANDIDATE && n.ran === true && n.rewritten === false && n.verdict === 'PASS',
    JSON.stringify(n));

  resetState(); net.judgeMode = 'fail';
  n = await NODE.finalizeReply({ characterId: FRIEND, userMessage: USER, candidate: CANDIDATE, character: OPTS.character, history: OPTS.history });
  /* 适配层转发门面的状态：判过但没有 verdict 时，verdict 必须是 UNDECIDED
     （此前只有 {ran, rewritten}，无法表达这件事）。 */
  check('T13b.nodePropagatesUndecided', n.reply === CANDIDATE && n.verdict === 'UNDECIDED' && n.reason === 'http'
    && n.rewritten === false, JSON.stringify(n));

  resetState(); net.judgePayload = STRONG_OOC;
  n = await NODE.finalizeReply({ characterId: FRIEND, userMessage: USER, candidate: CANDIDATE, character: OPTS.character, history: OPTS.history });
  check('T13c.nodeRewrittenFromOutcome', n.reply === REWRITTEN && n.rewritten === true && n.verdict === 'OOC', JSON.stringify(n));

  resetState(); net.judgePayload = SLIGHT;
  n = await NODE.finalizeReply({ characterId: FRIEND, userMessage: USER, candidate: CANDIDATE, character: OPTS.character, history: OPTS.history });
  check('T13d.nodeGateBlockedIsNotRewritten', n.reply === CANDIDATE && n.rewritten === false && n.verdict === 'OOC', JSON.stringify(n));

  resetState();
  n = await NODE.finalizeReply({ characterId: FRIEND, userMessage: USER, candidate: '', character: OPTS.character });
  check('T13e.nodeEmptyCandidateNoVerdict', n.reply === '' && n.rewritten === false && n.verdict === null, JSON.stringify(n));

  /* ── J. Home Node execution 的最小 provenance（静态：只标异常态）──── */
  const execSrc = fs.readFileSync(path.join(ROOT, 'services', 'home-node', 'execution.js'), 'utf8');
  check('T20a.execMarksUndecided', /finalized\.verdict === 'UNDECIDED'\)\s*mbPolicy \+= '\/integrity-undecided';/.test(execSrc));
  check('T20b.execNoBypassedMarker', !/integrity-bypassed/.test(execSrc), 'BYPASSED 是每轮常态，不得加标记');
  check('T20c.execStillMarksRewritten', /finalized\.rewritten === true\)\s*mbPolicy \+= '\/integrity-rewritten';/.test(execSrc));

  /* ── K. 桌面消费方：文本适配器 + 内部词汇锁未被破坏 ─────────────── */
  const comSrc = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'communication.js'), 'utf8');
  const hooks = [...comSrc.matchAll(/P11-2 · Middle Brain 生成后收口[\s\S]*?finalize failed'[^\n]*\n/g)].map(m => m[0]);
  check('T11a.twoDesktopHooks', hooks.length === 2, 'call sites=' + hooks.length);
  check('T11b.desktopReadsReplyAdapter', hooks.every(b => /_mbFinal\.reply/.test(b)), '桌面调用点没有取文本适配器');
  check('T12.desktopNoInternalVocabulary',
    hooks.every(b => !/ooc|integrity|violation|rewrite|threshold|judge|sensitivity|MB_CI|__middleBrainContracts/i.test(b)),
    '桌面调用点泄漏了内部概念');
  check('T12b.noWorldBeyondLegalConsumers',
    !fs.readdirSync(path.join(ROOT, 'assets', 'js')).filter(f => f.endsWith('.js'))
      .filter(f => !/^middle-brain/.test(f) && f !== 'communication.js')
      .some(f => /middleBrainFinalizeReply\s*\(/.test(fs.readFileSync(path.join(ROOT, 'assets', 'js', f), 'utf8'))));

  /* ── L. 结构性硬约束（本阶段禁止项）───────────────────────────────── */
  const integSrc = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'middle-brain-integrity.js'), 'utf8');
  const integCode = integSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  check('T20d.noRetryLoopInIntegrity', !/\bwhile\s*\(|\bfor\s*\(/.test(integCode.slice(integCode.indexOf('async function middleBrainCharacterIntegrity'))),
    'integrity 主入口出现循环（重试）');
  check('T20e.judgeCallCountIsOne', (integCode.match(/await _ciCall\(_mbCiJudgePrompt\(/g) || []).length === 2,
    'judge 调用点数变化（应为 1 次判定 + 1 次可选 verify）');
  check('T20f.timeoutLiteralUnchanged', /var MB_CI_TIMEOUT_MS = 20000;/.test(integSrc));

  console.log('\nP11-2B integrity state contract: ' + failures + ' failed');
  process.exitCode = failures ? 1 : 0;
})().catch(error => {
  console.error('harness error: ' + ((error && error.stack) || error));
  process.exitCode = 1;
});
