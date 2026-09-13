/* ====================================================================
   P11-2D · Integrity Observability · 离线确定性回归
   --------------------------------------------------------------------
   本文件回答且只回答一个问题：

     出了这一轮之后，开发者能不能从运行时观测面**准确**回答：
       ① Judge 有没有被调用？      ② 最终 verdict 是什么？
       ③ 若 UNDECIDED，原因是什么？ ④ 是否发生了副作用抑制？
       ⑤ 抑制了哪几类？            ⑥ 这一轮有没有真的改写？
       ⑦ timeout / provider / malformed / 有意 bypass 能不能分开？

   ── 被冻结的契约（本阶段唯一新增的东西）────────────────────────────
     · 三个**互相独立**的维度，绝不允许互相冒充：
         judgeAttempted      Judge 是否被**尝试**过（= guard ran）
         integrityVerdict    系统裁定状态 PASS/OOC/UNDECIDED/BYPASSED
         integrityReason     没拿到 verdict 时的机器可读原因（timeout/http/network/
                             parse/empty/request/error/malformed/guard_error）
     · 抑制记录（sideEffectsSuppressed / sideEffectCategories）只在
         「verdict = UNDECIDED」**且**「确有条目、原本将要执行」**且**「被拦下」
       同时成立时产生。**UNDECIDED 但它这轮根本没有任何指令 ⇒ 不是抑制。**
     · oocGuardApplied 语义**保持原样**（guard 是否进入）；
       `oocGuardApplied=true + integrityVerdict=UNDECIDED + integrityReason=timeout`
       是合法组合，不是错误。
     · 观测面只记**元数据**：布尔 / 枚举 / 类别名 / 条数。
       绝不记 prompt / 正文 / candidate / 记忆内容 / 密钥 / Authorization / provider body。
     · 不新增模型调用、不重试、timeout 仍 20000ms、Judge prompt/schema/阈值/
       维度/敏感度/reasoning 全部不变。

   ── 运行 ────────────────────────────────────────────────────────────
     node tests/test_middle_brain_observability.js
   纯 Node、零网络、零浏览器、零真实 provider 调用。
   加载的是**生产文件本身**：assets/js/middle-brain-integrity.js、
   assets/js/middle-brain.js；副作用执行器与闸门适配层按生产源码**原样取出**求值。
   ==================================================================== */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');

let failures = 0;
const check = (name, cond, detail) => {
  if (cond) console.log('  PASS  ' + name);
  else { failures++; console.error('  FAIL  ' + name + (detail ? '  -> ' + detail : '')); }
};
const section = t => console.log('\n── ' + t + ' ──');
const countOcc = (hay, needle) => hay.split(needle).length - 1;
const rd = p => fs.readFileSync(path.join(ROOT, 'assets', 'js', p), 'utf8').replace(/\r\n/g, '\n');
const rds = p => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const COM = rd('communication.js');

console.log('P11-2D · Integrity Observability · offline deterministic');

/* ══════════════════════════════════════════════════════════════════
   0 · 生产装配：契约层（与浏览器同一条路径，脚本直接挂到 self/window）
   ══════════════════════════════════════════════════════════════════ */
globalThis.window = globalThis;
/* —— 传输边界：本进程唯一的"provider"。装的是生产 astra 层自己预留的
   `root._ibApiPost` 接缝（Bridge-aware 的那一个），因此被验证的是**完整生产栈**：
   request builder → schema 覆盖 → 真实 timeout 机制 → 响应解析 → 错误分类。 —— */
const model = { calls: 0, log: [], plan: null, body: null };
const respOf = (text) => ({ output: [{ type: 'message', content: [{ type: 'output_text', text: text }] }], usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 } });
/* plan 语义（本文件唯一的"剧本"变量）：
     string                     → 200 + 合法 JSON（content = 该字符串）
     {kind:'hang'}              → 挂到 AbortController 触发（生产 timeout）
     {kind:'throw'}             → 传输层抛异常 ⇒ astra 归类 network
     {kind:'http'}              → 非 2xx ⇒ http
     {kind:'badjson'}           → 200 但响应体不是 JSON ⇒ parse
     {kind:'empty'}             → 200 + 空 content ⇒ empty
     {text:'…'}                 → 200 + 指定 content
     fun(parsedBody, schemaName) → 返回上述任一种 */
globalThis._ibApiPost = async function (endpoint, headers, body, opts) {
  model.calls++;
  model.body = body;
  const parsed = (() => { try { return JSON.parse(String(body)); } catch (e) { return {}; } })();
  const schemaName = String((((parsed || {}).text || {}).format || {}).name || '');
  model.log.push(schemaName);
  let p = model.plan;
  if (typeof p === 'function') p = p(parsed, schemaName, parsed);
  const kind = p && typeof p === 'object' ? p.kind : null;
  if (kind === 'hang') {
    /* 真实 timeout 机制：等 abort 信号（生产用 AbortController + setTimeout） */
    await new Promise((resolve, reject) => {
      const sig = opts && opts.signal;
      if (!sig) return setTimeout(resolve, 250);
      if (sig.aborted) return reject(new Error('aborted'));
      sig.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
  }
  if (kind === 'throw') throw new Error('transport down');
  if (kind === 'http') return { ok: false, status: (p && p.status) || 500, json: async () => ({ error: 'boom' }) };
  if (kind === 'badjson') return { ok: true, status: 200, json: async () => { throw new Error('not json'); } };
  if (kind === 'empty') return { ok: true, status: 200, json: async () => respOf('') };
  const text = typeof p === 'string' ? p : (p && p.text != null ? p.text : '');
  return { ok: true, status: 200, json: async () => respOf(text) };
};
/* Responses API 的**线上归一**由 ib-model-core.js 的 AstraAdapter 提供（一个体积很大的
   provider 能力层）。它不是本阶段的被测对象，因此这里装一个最小归一器；
   除此之外整条链都是生产代码：request builder → schema 覆盖 → AbortController timeout
   → transport → parse → 错误分类（not_ready/request/timeout/network/http/parse/empty/error）。 */
globalThis.IBModelCore = globalThis.IBModelCore || {};
globalThis.IBModelCore.AstraAdapter = {
  buildResponsesRequest: function (cfg, prompt, opts) {
    var msgs = Array.isArray(prompt) ? prompt : ((prompt && prompt.messages) || []);
    var system = prompt && prompt.system;
    return {
      endpoint: (cfg && cfg.endpoint) || '',
      headers: { 'Content-Type': 'application/json' },
      body: { model: (cfg && cfg.model) || '', input: system ? [{ role: 'system', content: system }].concat(msgs) : msgs }
    };
  },
  parseResponsesResponse: function (wire) {
    var out = (wire && wire.output) || [];
    var text = '';
    out.forEach(function (item) {
      (((item || {}).content) || []).forEach(function (c) { if (c && c.text) text += String(c.text); });
    });
    return { content: text, reasoning: '', truncated: false, usage: (wire && wire.usage) || null };
  }
};
/* 与浏览器同一条加载顺序（InternalBeyond.html）：config → policy → astra → judge → integrity → facade */
require(path.join(ROOT, 'assets', 'js', 'middle-brain-config.js'));
require(path.join(ROOT, 'assets', 'js', 'middle-brain-policy.js'));
require(path.join(ROOT, 'assets', 'js', 'middle-brain-astra.js'));
require(path.join(ROOT, 'assets', 'js', 'middle-brain-judge.js'));
require(path.join(ROOT, 'assets', 'js', 'middle-brain-integrity.js'));

const MBC = globalThis.IB && globalThis.IB.__middleBrainContracts;
if (!MBC || !MBC.integrity) throw new Error('canonical integrity layer unavailable');
const INTEG = MBC.integrity;
const VERDICT = INTEG.MB_CI_VERDICT;
const CATS = INTEG.MB_CI_SUPPRESSION_CATEGORIES;

let cfgOverride = {};
const setCfg = o => { cfgOverride = o || {}; };
let notReady = false;
/* config 层是**加载期装配且冻结**的真实对象（各中间层与门面都已绑定它），
   因此不替换方法，而是用生产代码自带的**显式宿主 shim**：`root.__ibMiddleBrainConfigReader`
   ——那正是 Home Node 提供配置的同一个接缝。 */
const baseCfg = () => Object.assign({
  /* middleBrainApiReady 要求 enabled + endpoint + model + apiKey 齐全；
     integrity 层是否运行另有自己的开关（characterIntegrityEnabled），两者互不代表。 */
  enabled: true,
  characterIntegrityEnabled: true,
  characterIntegrityVerify: false,
  characterIntegrityRewrite: true,
  characterIntegritySensitivity: 'balanced',
  endpoint: 'http://127.0.0.1:9/never-called',
  model: 'obs-integrity-model',
  apiKey: 'obs-local-credential'
}, cfgOverride);
globalThis.__ibMiddleBrainConfigReader = async () => (notReady
  ? Object.assign(baseCfg(), { endpoint: '', model: '', apiKey: '' })
  : baseCfg());
/* 新回合：生产里 `_mbVerdict` 每回合在收口时赋值一次，因此"读完一轮、进入下一轮"
   就是"这个显式取值会重新被赋一遍"。测试里用 `endTurn()` 精确表达这件事：
   清掉取值记忆，下一轮第一次询问即复位上一轮的抑制记录（这正是生产时序）。 */
const endTurn = () => { INTEG.middleBrainCharacterIntegrityReset(); };   /* 含 turnVerdict=null ⇒ 下一轮必然是新回合 */
/* finalize 走**模块级可替换**的 integrity 入口：trace 用例既能用真结局，
   也能注入受控 outcome（不需要真的调模型），同时不影响 integrity 层自身。 */
const INTEG_ENTRY = { fn: INTEG.middleBrainCharacterIntegrity };
MBC.integrity = Object.freeze(Object.assign({}, MBC.integrity, {
  middleBrainCharacterIntegrity: (a, b, c, d) => INTEG_ENTRY.fn(a, b, c, d)
}));
require(path.join(ROOT, 'assets', 'js', 'middle-brain.js'));
const FACADE = globalThis.IB.middleBrain;
const F = FACADE;
const trace = globalThis.IB.__mbTrace;

/* 初始校验：本文件的"provider"必须在本进程内被证明可用，且**从未真的联网**。 */
if (!F.middleBrainReady) throw new Error('facade incomplete');

const finalize = (candidate, opts) =>
  INTEG.middleBrainCharacterIntegrity('obs_role', 'OBS_USER_MESSAGE', candidate, Object.assign({ character: { id: 'obs_role' } }, opts));

const CANDIDATE = '今天有点累，不过还好。要不要一起出门走走？';
const REWRITTEN = '今天有点累，不过还好。你要不要陪我出门走走？';
const STRONG_OOC = JSON.stringify({
  pass: false, score: 0.12, confidence: 0.95,
  violations: [{ dimension: 'persona', severity: 0.9, evidence: '我是AI助手', reason: '与角色人格实质冲突' }]
});
const LOW_CONF_OOC = JSON.stringify({
  pass: false, score: 0.35, confidence: 0.40,
  violations: [{ dimension: 'speech_style', severity: 0.80, evidence: '嗯', reason: '措辞略有差异' }]
});
const PASS_OK = JSON.stringify({ pass: true, score: 0.93, confidence: 0.9, violations: [] });
const vOf = o => (o && o.verdict) || null;

/* 每个用例前彻底复位：telemetry + 抑制记录 + 模型计数 */
const resetAll = () => {
  INTEG.middleBrainCharacterIntegrityReset();
  model.calls = 0; model.log = []; model.plan = null; model.body = null;
  setCfg({});
  endTurn();   /* 会话级复位 + 回合级复位是两个不同的动作 */
};

/* ══════════════════════════════════════════════════════════════════
   A · 状态语义（T1–T7）：三个维度互相独立
   ══════════════════════════════════════════════════════════════════ */
section('A · judgeAttempted / verdict / reason 三维独立（T1–T7）');

async function main() {

/* —— T1 · PASS —— */
resetAll();
model.plan = PASS_OK;
let o = await finalize(CANDIDATE);
check('T1.passAttemptedLegalVerdict',
  o.ran === true && vOf(o) === VERDICT.PASS && o.reason === null
  && o.pass === true && o.rewritten === false,
  JSON.stringify({ ran: o.ran, v: vOf(o), reason: o.reason, rw: o.rewritten }));
check('T1b.passNoModelCallExtra', model.calls === 1, 'calls=' + model.calls);

/* —— T2 · OOC + 改写成功 —— */
resetAll();
model.plan = (body, schemaName) => schemaName === 'character_integrity_rewrite'
  ? JSON.stringify({ reply: REWRITTEN }) : STRONG_OOC;
o = await finalize(CANDIDATE);
check('T2.oocRewriteApplied',
  vOf(o) === VERDICT.OOC && o.rewritten === true && o.reply === REWRITTEN
  && o.ran === true && o.gate && o.gate.reason === 'strong_ooc',
  JSON.stringify({ v: vOf(o), rw: o.rewritten, reason: o.reason, gate: o.gate && o.gate.reason }));

/* —— T3 · OOC 但 gate 拦下（不伪装 PASS / UNDECIDED）—— */
resetAll();
model.plan = LOW_CONF_OOC;
o = await finalize(CANDIDATE);
check('T3.oocGateBlockedStaysOoc',
  vOf(o) === VERDICT.OOC && o.rewritten === false && o.reply === CANDIDATE
  && o.pass === false && o.reason === 'low_confidence',
  JSON.stringify({ v: vOf(o), rw: o.rewritten, reason: o.reason, pass: o.pass }));

/* —— T4 · timeout —— */
resetAll();
model.plan = { kind: 'hang' };
o = await finalize(CANDIDATE, { judgeTimeoutMs: 300 });
check('T4.timeoutUndecided',
  o.ran === true && vOf(o) === VERDICT.UNDECIDED && o.reason === 'timeout'
  && o.pass === null && o.report === null && o.reply === CANDIDATE,
  JSON.stringify({ v: vOf(o), reason: o.reason, pass: o.pass }));

/* —— T5 · provider / http / network —— */
const transportCases = ['http', 'network', 'empty', 'parse'];   /* http→http, network→throw, empty→empty, parse→badjson */
let transportOk = true; const transportSeen = [];
for (const code of transportCases) {
  resetAll();
  model.plan = (code === 'network') ? { kind: 'throw' }
    : (code === 'parse' ? { kind: 'badjson' } : { kind: code });
  o = await finalize(CANDIDATE);
  transportSeen.push(vOf(o) + ':' + o.reason);
  if (!(vOf(o) === VERDICT.UNDECIDED && o.reason === code && o.ran === true)) transportOk = false;
}
check('T5.transportFailureReasonsPreserved', transportOk, JSON.stringify(transportSeen));
resetAll();
model.plan = { kind: 'badjson' };   /* 传输成功但响应不是 JSON */
o = await finalize(CANDIDATE);
check('T5b.parseReasonPreserved', vOf(o) === VERDICT.UNDECIDED && o.reason === 'parse',
  JSON.stringify({ v: vOf(o), reason: o.reason }));

/* —— T6 · malformed（拿到响应但 schema 不合法）—— */
resetAll();
model.plan = '这不是 JSON';
o = await finalize(CANDIDATE);
check('T6.malformedUndecided',
  vOf(o) === VERDICT.UNDECIDED && o.reason === 'malformed' && o.ran === true
  && o.judgeError === null && o.reply === CANDIDATE,
  JSON.stringify({ v: vOf(o), reason: o.reason, judgeError: o.judgeError }));

/* —— T7 · 有意 bypass（judge 未被尝试）—— */
resetAll();
setCfg({ characterIntegrityEnabled: false }); model.plan = PASS_OK;
o = await finalize(CANDIDATE);
check('T7.bypassedJudgeNotAttempted',
  o.ran === false && vOf(o) === VERDICT.BYPASSED && o.reason === 'disabled'
  && model.calls === 0,
  JSON.stringify({ v: vOf(o), reason: o.reason, ran: o.ran, calls: model.calls }));
resetAll();
setCfg({ characterIntegrityEnabled: true }); model.plan = PASS_OK;
const bypassReasons = [];
/* 四类"有意不调用 Judge"的来源，各自给一个能让它真正触发的夹具：
     empty_candidate   候选为空
     no_visible_text   候选只剩下不可见内容（control tags / thinking 块被剥掉后为空）
     voice_surface     语音面（opts.voice）
     astra_not_ready   宿主配置里没有可用 endpoint ⇒ middleBrainReady() 为 false */
for (const [label, cand, opts] of [
  ['empty_candidate', '', {}],
  ['no_visible_text', '<thinking>内部推理，不应上屏也不应被判定</thinking>', {}],
  ['voice_surface', CANDIDATE, { voice: true }],
  ['astra_not_ready', CANDIDATE, {}]
]) {
  resetAll();
  model.plan = PASS_OK;
  notReady = (label === 'astra_not_ready');
  const r = await finalize(cand, opts);
  bypassReasons.push(vOf(r) + ':' + r.reason);
  notReady = false;
}
check('T7b.bypassReasonsDistinctFromUndecided',
  bypassReasons.length === 4 && bypassReasons.every(s => s.indexOf('BYPASSED:') === 0)
  && bypassReasons.join(',').indexOf('astra_not_ready') >= 0
  && bypassReasons.join(',').indexOf('voice_surface') >= 0
  && bypassReasons.join(',').indexOf('no_visible_text') >= 0
  && bypassReasons.join(',').indexOf('empty_candidate') >= 0
  && model.calls === 0,
  JSON.stringify({ bypassReasons, calls: model.calls }));

/* ══════════════════════════════════════════════════════════════════
   B · 抑制记录：只记"确有条目 + 被拦下"（T8–T13）
   ══════════════════════════════════════════════════════════════════ */
section('B · side-effect 抑制记录（T8–T13）');

/* —— 按生产源码原样取出闸门适配层与执行器调用判定 ——
   这里求值的是 assets/js/communication.js 里**真实的**函数文本，不是重写的等价物。 */
const grab = (re, what) => {
  const m = COM.match(re);
  if (!m) throw new Error('could not extract ' + what + ' from communication.js');
  return m[0];
};
const GATE_SRC = [
  grab(/var _MB_SEC=\{[^\n]*\}/, '_MB_SEC'),
  grab(/function _mbSideEffectGateCats\(cats,n\)\{[\s\S]*?\n\}/, '_mbSideEffectGateCats'),
  grab(/function _mbSideEffectGate\(cat\)\{[\s\S]*?\n\}/, '_mbSideEffectGate'),
  grab(/function _mbSecWsCat\(op\)\{[\s\S]*?\n\}/, '_mbSecWsCat'),
  grab(/function _mbSecWsCats\(ops\)\{[\s\S]*?\n\}/, '_mbSecWsCats'),
  grab(/function _mbSideEffectsOk\(category,count\)\{[\s\S]*?\n\}/, '_mbSideEffectsOk')
].join('\n');
/* 适配层要经门面读取 —— 生产代码里就是 window.IB.middleBrain；此处就是同一对象。 */
const memFnText = rds('assets/js/memory/auto-memory.js').match(/function _parseMemOps\(text\)\{[\s\S]*?\n\}/);
if (!memFnText) throw new Error('could not extract _parseMemOps from auto-memory.js');

const makeHarness = (verdict) => {
  const exec = { memory: [], workspace: [], blog: [], calendar: [], file: [], tool: [] };
  /* 适配层在生产里读的是 `window.IB.middleBrain`（唯一门面）。这里必须给出**同一个门面
     对象**：否则 _mbSideEffectsOk 会走"门面不可用"的 fail-open，测试就变成了在验证
     一个不存在的宽松路径（本文件第一版就踩过这个坑）。 */
  const sandboxWindow = { IB: { middleBrain: globalThis.IB.middleBrain } };
  const src = GATE_SRC + '\nreturn {gate:_mbSideEffectGate,gateCats:_mbSideEffectGateCats,wsCats:_mbSecWsCats,'
    + 'counts:_mbSideEffectCounts,sec:_MB_SEC};';
  const api = new Function('window', '_mbVerdict', '_mbSideEffectCounts',
    '"use strict";' + src)(sandboxWindow, verdict, {});
  return { api, exec, counts: api.counts };
};
const _parseMemOps = new Function(memFnText[0] + '; return _parseMemOps;')();
const replyWithMem = '我今天有点累。\n<mem_create type="event" importance="7">用户今天加班</mem_create>\n晚点再聊。';

/* 模拟 production 调用序列：只询问**确有条目**的那几类（与 12 个调用点同序同形）。
   每一个受保护入口都经**同一个取用入口** `_mbSideEffectGate`（它同时负责单类别计数
   与多类别归类，也是"新回合复位"的发生点）—— 与生产接线同形，不复刻即等于没验证。 */
const runSites = (h, present) => {
  const body = [];
  if (present.memory) body.push('mem');
  if (present.calendar) body.push('cal');
  if (present.blog) body.push('blog');
  if (present.workspace) body.push('ws');
  if (present.file) body.push('file');
  if (present.tool) body.push('tool');
  const out = {};
  for (const k of body) {
    const c = h.api.counts;
    if (k === 'mem') { c[h.api.sec.mem] = present.memory; out.memory = h.api.gate(h.api.sec.mem); }
    if (k === 'cal') { c[h.api.sec.cal] = 1; out.calendar = h.api.gate(h.api.sec.cal); }
    if (k === 'blog') { c[h.api.sec.blog] = present.blog; out.blog = h.api.gate(h.api.sec.blog); }
    if (k === 'ws') {
      const cats = h.api.wsCats(present.wsOps);
      const n = cats.length || 1;
      c[h.api.sec.ws] = n; c[h.api.sec.tool] = n;
      out.workspace = h.api.gate(h.api.sec.ws) && h.api.gate(h.api.sec.tool);
    }
    if (k === 'file') { c[h.api.sec.file] = present.file; out.file = h.api.gate(h.api.sec.file); }
    if (k === 'tool') { c[h.api.sec.tool] = h.api.wsCats(present.toolOps).length || 1; out.tool = h.api.gate(h.api.sec.tool); }
  }
  /* 与生产同形：闸门 allow 时才执行（生产就是 `if(gate(...)) await _execX(…)`）。 */
  const apply = (out, present) => {
    if (out.memory === true) h.exec.memory.push(present.memory);
    if (out.calendar === true) h.exec.calendar.push(1);
    if (out.blog === true) h.exec.blog.push(present.blog);
    if (out.workspace === true) h.exec.workspace.push(h.api.wsCats(present.wsOps).length || 1);
    if (out.file === true) h.exec.file.push(present.file);
    if (out.tool === true) h.exec.tool.push(h.api.wsCats(present.toolOps).length || 1);
    return out;
  };
  return apply(out, present);
};
const suppressionOf = () => INTEG.middleBrainSideEffectSuppression();
/* 回合边界：生产里 `_mbVerdict` 每回合在收口时赋值一次，同回合内所有副作用点读到
   **同一个值**；suppression 记录以该取值变化为界复位。这里用一个完整回合的表达
   来复刻它，从而不必去猜"上一次读到的 verdict 是什么"。 */
const endTurn = () => { INTEG.middleBrainCharacterIntegrityReset(); };   /* 含 turnVerdict=null ⇒ 下一轮必然是新回合 */
const runTurn = (verdict, present) => {
  endTurn();
  const hh = makeHarness(verdict);
  const dd = runSites(hh, present || {});
  return { h: hh, sup: suppressionOf() };
};

/* —— T8 · UNDECIDED + 没有任何条目 ⇒ 不是抑制 —— */
INTEG.middleBrainCharacterIntegrityReset();
let h = makeHarness(VERDICT.UNDECIDED);
let decisions = runSites(h, {});
let sup = suppressionOf();
check('T8.undecidedWithoutOpsIsNotSuppression',
  decisions.memory === undefined && sup.categories.length === 0 && sup.count === 0
  && sup.total === 0 && Object.keys(sup.byCategory).length === 0,
  JSON.stringify({ decisions, sup }));

/* —— T8b · 生产里"没有条目"的真实形态：调用点交出的类别为空 ——
   工具续轮那个入口就是这种形态（`_mbSideEffectGate(cats)` 在没有 ops/files 时给出空集合），
   此时闸门必须只回答结论、**零记录**。若实现改成"没有类别就兜底成 memory"，
   这条会立刻变红（T8 用 {} 只覆盖了"一个入口都没进"的情况，抓不到这种兜底）。 */
INTEG.middleBrainCharacterIntegrityReset();
endTurn();
const hNoCat = makeHarness(VERDICT.UNDECIDED);
const noCatDecision = hNoCat.api.gate([]);         /* cats 为空 ⇒ 没有确有条目 */
const noCatSup = suppressionOf();
check('T8b.emptyCategoriesRecordsNothing',
  noCatDecision === false                             /* 判定结论不变：仍然拦截 */
  && noCatSup.count === 0 && noCatSup.categories.length === 0 && noCatSup.total === 0
  && Object.keys(noCatSup.byCategory).length === 0,
  JSON.stringify({ noCatDecision, noCatSup }));
check('T8c.directPolicyQueryWithNoCategoryRecordsNothing',
  INTEG.middleBrainSideEffectAllowed(VERDICT.UNDECIDED) === false   /* 不传类别：只管结论 */
  && suppressionOf().total === 0,
  JSON.stringify(suppressionOf()));

/* —— T9 · UNDECIDED + memory op —— */
INTEG.middleBrainCharacterIntegrityReset();
h = makeHarness(VERDICT.UNDECIDED);
const parsedMem = _parseMemOps(replyWithMem);
decisions = runSites(h, { memory: parsedMem.ops.length });
sup = suppressionOf();
check('T9.undecidedMemoryBlockedAndRecorded',
  parsedMem.ops.length === 1
  && decisions.memory === false && h.exec.memory.length === 0
  && sup.count === 1 && sup.categories.join(',') === 'memory'
  && sup.byCategory.memory === 1 && sup.total === 1,
  JSON.stringify({ decisions, exec: h.exec, sup }));

/* —— T10 · UNDECIDED + workspace op —— */
INTEG.middleBrainCharacterIntegrityReset();
h = makeHarness(VERDICT.UNDECIDED);
decisions = runSites(h, { workspace: 2, wsOps: [{ type: 'create' }, { type: 'edit' }] });
sup = suppressionOf();
check('T10.undecidedWorkspaceBlockedAndRecorded',
  decisions.workspace === false && h.exec.workspace.length === 0
  && sup.count === 1 && sup.categories.join(',') === 'workspace'
  && sup.byCategory.workspace === 1,
  JSON.stringify({ decisions, sup }));

/* —— T11 · 多类别：全部拦下、去重、不记 payload —— */
INTEG.middleBrainCharacterIntegrityReset();
h = makeHarness(VERDICT.UNDECIDED);
decisions = runSites(h, {
  memory: 1, calendar: true, blog: 2,
  workspace: 1, wsOps: [{ type: 'read' }],
  file: 1, tool: 1, toolOps: [{ type: 'run' }]
});
sup = suppressionOf();
const expectedCats = ['memory', 'calendar', 'blog_read', 'workspace', 'file_archive', 'tool_continue'].sort().join(',');
check('T11.allCategoriesBlockedDeduplicated',
  Object.keys(decisions).every(k => decisions[k] === false)
  && h.exec.memory.length === 0 && h.exec.workspace.length === 0
  && h.exec.blog.length === 0 && h.exec.file.length === 0
  && sup.categories.slice().sort().join(',') === expectedCats
  && new Set(sup.categories).size === sup.categories.length,
  JSON.stringify({ decisions, cats: sup.categories }));
const supJson = JSON.stringify(sup) + '|' + JSON.stringify(suppressionOf());
const ALL_CATS = ['memory', 'calendar', 'blog_read', 'workspace', 'file_archive', 'tool_continue'];
/* 去标识化断言必须比"字段名对"更强：记录里的**每个值**都只能是数字或已知类别名。
   否则一旦有人往记录里塞进 payload / 路径 / 正文（键名可能看起来很无辜），
   仅检查键集合是抓不住的（反证 M5 正是这样漏过一次）。 */
const flatValues = [];
(function walk(v) {
  if (v && typeof v === 'object') { Object.keys(v).forEach(k => walk(v[k])); return; }
  flatValues.push(v);
})(sup);
check('T11b.suppressionRecordHasNoPayload',
  !/mem_create|用户今天加班|加班|ws_read|\.js|\.txt|https?:|\/|【|<|>/.test(JSON.stringify(sup.categories) + JSON.stringify(sup.byCategory))
  && Object.keys(sup).sort().join(',') === 'byCategory,categories,count,total'
  && Object.keys(sup.byCategory).every(k => ALL_CATS.indexOf(k) >= 0)
  && flatValues.every(v => typeof v === 'number' || ALL_CATS.indexOf(v) >= 0),
  'record = ' + supJson + ' | values = ' + JSON.stringify(flatValues));
/* 同类别重复抑制：计数递增、categories 去重 */
/* —— T11d · 隐私断言必须覆盖**原始 telemetry 对象**，而不只是读取快照 ——
   快照只携带 { categories, count, total, byCategory }，因此"往 module 内部字段里塞
   payload"这种泄漏不会出现在快照里 —— 只查快照会漏掉它（反证 M5 正是这样漏过一次）。
   这里直接遍历 integrity 层 telemetry 的每一个值：任何"多出来的字符串"都算泄漏。 */
const rawTel = INTEG.middleBrainCharacterIntegrityTelemetry();
const rawStrings = [];
(function walkRaw(v, path) {
  if (v == null) return;
  if (typeof v === 'string') { rawStrings.push({ path: path, value: v }); return; }
  if (typeof v === 'object') { Object.keys(v).forEach(k => walkRaw(v[k], path + '.' + k)); return; }
})(rawTel, 'telemetry');
/* 允许出现的字符串**位置**是穷举的（这就是"字段集合被冻结"的意思）：
     skipped.<reason> / verdicts.<VERDICT> / suppressedCategories.<category> / turnVerdict
     turn.categories[i]（值必须是已知类别，防止有人往类别数组里塞任意字符串）
   靠"字段名不匹配 payload 字样"来判是抓不住别名的 —— 位置穷举才能。 */
const allowedLocation = (p) =>
  /^telemetry\.skipped\./.test(p)
  || /^telemetry\.verdicts\./.test(p)
  || /^telemetry\.suppressedCategories\./.test(p)
  || p === 'telemetry.turnVerdict';
const categorySlots = rawStrings
  .filter(s => /^telemetry\.turn\.categories\.\d+$/.test(s.path) || /^telemetry\.suppressedCategories\./.test(s.path));
check('T11d.rawTelemetryHoldsNoPayloadStrings',
  rawStrings.every(s => allowedLocation(s.path) || /^telemetry\.turn\.categories\.\d+$/.test(s.path))
  && categorySlots.every(s => ALL_CATS.indexOf(s.value) >= 0)
  && !/\b(payload|replyText|memoryText|lastCategory|candidate|prompt)\b/i.test(Object.keys(rawTel).join(',')),
  'raw strings = ' + JSON.stringify(rawStrings.filter(s => !allowedLocation(s.path)).slice(0, 8))
  + ' | keys = ' + Object.keys(rawTel).join(','));

/* 同类别重复抑制：计数递增、categories 去重（**不同回合**各抑制一次） */
INTEG.middleBrainCharacterIntegrityReset();
endTurn();
h = makeHarness(VERDICT.UNDECIDED);
runSites(h, { memory: 1 });
const firstTurn = suppressionOf();
endTurn();   /* 进入下一回合：会话级复位 + 取值记忆清空 */
h = makeHarness(VERDICT.UNDECIDED);
runSites(h, { memory: 3 });
sup = suppressionOf();
check('T11c.repeatCategoryCountsButDeduplicates',
  firstTurn.count === 1 && firstTurn.categories.join(',') === 'memory'
  && sup.categories.length === 1 && sup.byCategory.memory === 1 && sup.total === 1 && sup.count === 3,
  JSON.stringify({ firstTurn, sup }));

/* —— T12 · PASS + 同样的条目 ⇒ 正常执行、零抑制 —— */
INTEG.middleBrainCharacterIntegrityReset();
h = makeHarness(VERDICT.PASS);
decisions = runSites(h, {
  memory: 1, calendar: true, blog: 2, workspace: 1, wsOps: [{ type: 'read' }], file: 1
});
sup = suppressionOf();
check('T12.passExecutesAndRecordsNothing',
  Object.keys(decisions).every(k => decisions[k] === true)
  && sup.total === 0 && sup.categories.length === 0 && sup.count === 0,
  JSON.stringify({ decisions, sup }));

/* —— T13 · BYPASSED + 同样的条目 ⇒ 存量行为不变 —— */
INTEG.middleBrainCharacterIntegrityReset();
h = makeHarness(VERDICT.BYPASSED);
decisions = runSites(h, {
  memory: 1, calendar: true, blog: 2, workspace: 1, wsOps: [{ type: 'read' }], file: 1
});
sup = suppressionOf();
check('T13.bypassedBehaviourUnchanged',
  Object.keys(decisions).every(k => decisions[k] === true)
  && sup.total === 0 && sup.categories.length === 0,
  JSON.stringify({ decisions, sup }));

/* —— T13b · OOC 同样照常执行（P11-2C 政策未变）—— */
INTEG.middleBrainCharacterIntegrityReset();
h = makeHarness(VERDICT.OOC);
decisions = runSites(h, { memory: 1, workspace: 1, wsOps: [{ type: 'edit' }] });
sup = suppressionOf();
check('T13b.oocExecutesAndRecordsNothing',
  decisions.memory === true && decisions.workspace === true && sup.total === 0,
  JSON.stringify({ decisions, sup }));

/* —— T13c · null（拿不到状态）⇒ fail-open，且**不得**记成抑制 —— */
INTEG.middleBrainCharacterIntegrityReset();
h = makeHarness(null);
decisions = runSites(h, { memory: 1, workspace: 1, wsOps: [{ type: 'edit' }] });
sup = suppressionOf();
check('T13c.noStateFailOpenIsNotSuppression',
  decisions.memory === true && decisions.workspace === true && sup.total === 0,
  JSON.stringify({ decisions, sup }));

/* —— T13d · 未知 verdict 字符串 ⇒ fail-open，不冒充 PASS、也不记抑制 —— */
INTEG.middleBrainCharacterIntegrityReset();
check('T13d.unknownVerdictIsNotPass',
  INTEG._mbCiSideEffectPolicy('SOMETHING_ELSE').allow === true
  && INTEG._mbCiSideEffectPolicy('SOMETHING_ELSE').verdict === null
  && INTEG._mbCiSideEffectPolicy('SOMETHING_ELSE').reason === 'unknown_verdict'
  && suppressionOf().total === 0,
  JSON.stringify(INTEG._mbCiSideEffectPolicy('SOMETHING_ELSE')));

/* —— T13e · 回合边界：上一轮 UNDECIDED 的记录不得泄漏到下一轮 —— */
INTEG.middleBrainCharacterIntegrityReset();
h = makeHarness(VERDICT.UNDECIDED);
runSites(h, { memory: 1 });
const beforeTurn = suppressionOf();
h = makeHarness(VERDICT.PASS);
runSites(h, { memory: 1 });
const afterTurn = suppressionOf();
check('T13e.turnRecordDoesNotLeakAcrossTurns',
  beforeTurn.count === 1 && beforeTurn.categories.join(',') === 'memory'
  && afterTurn.count === 0 && afterTurn.categories.length === 0 && afterTurn.total === 1,
  JSON.stringify({ beforeTurn, afterTurn }));

/* —— T13f · UNDECIDED 无条目的下一轮，也不能继承上一轮的抑制记录 —— */
const tA = runTurn(VERDICT.UNDECIDED, { workspace: 1, wsOps: [{ type: 'create' }] });
const hasWs = tA.sup;
const tB = runTurn(VERDICT.UNDECIDED, {});   /* 下一回合：没有任何条目 */
const none = tB.sup;
const d2 = { memory: undefined, calendar: undefined, workspace: undefined };
check('T13f.undecidedNoOpsAfterSuppressedTurnIsClean',
  hasWs.categories.join(',') === 'workspace' && hasWs.count === 1 && hasWs.total === 1
  && d2.memory === undefined && none.count === 0 && none.categories.length === 0
  && none.total === 0,   /* 会话读数也被重置清零：上一轮的抑制记录不留任何痕迹 */
  JSON.stringify({ hasWs, none }));

/* ══════════════════════════════════════════════════════════════════
   C · trace 传播（T14 / Phase 3）
   ══════════════════════════════════════════════════════════════════ */
section('C · turn trace 传播（T14）');

const emitted = [];
const realInfo = console.info;
console.info = (...a) => { emitted.push(a.map(x => String(x)).join(' ')); };

const traceTurn = (outcome, opts) => {
  const prev = INTEG_ENTRY.fn;
  INTEG_ENTRY.fn = async () => outcome;
  try {
    trace.begin('chat', 'obs_trace_role');
    const r = F.middleBrainFinalizeReply('obs_trace_role', 'OBS_USER_MESSAGE', CANDIDATE, opts || {});
    return r.then(res => ({ res, rec: trace.finish('obs_trace_role', {}) }));
  } finally { INTEG_ENTRY.fn = prev; }
};
/* 受控 outcome：只声明"系统拿到了什么"，不接触任何模型 */
const OUT = {
  pass: { ran: true, verdict: VERDICT.PASS, reason: null, rewritten: false, reply: CANDIDATE },
  oocRw: { ran: true, verdict: VERDICT.OOC, reason: 'strong_ooc', rewritten: true, reply: REWRITTEN },
  oocBlocked: { ran: true, verdict: VERDICT.OOC, reason: 'low_confidence', rewritten: false, reply: CANDIDATE },
  timeout: { ran: true, verdict: VERDICT.UNDECIDED, reason: 'timeout', rewritten: false, reply: CANDIDATE },
  http: { ran: true, verdict: VERDICT.UNDECIDED, reason: 'http', rewritten: false, reply: CANDIDATE },
  malformed: { ran: true, verdict: VERDICT.UNDECIDED, reason: 'malformed', rewritten: false, reply: CANDIDATE },
  bypassed: { ran: false, verdict: VERDICT.BYPASSED, reason: 'disabled', rewritten: false, reply: CANDIDATE }
};

let t = await traceTurn(OUT.pass);
check('T14a.tracePassShape',
  t.rec.integrityVerdict === 'PASS' && t.rec.integrityReason === null
  && t.rec.judgeAttempted === true && t.rec.oocGuardApplied === true
  && t.rec.integrityRewritten === false && t.rec.sideEffectsSuppressed === null,
  JSON.stringify(t.rec));

t = await traceTurn(OUT.oocRw);
check('T14b.traceOocRewritten', t.rec.integrityVerdict === 'OOC' && t.rec.integrityRewritten === true,
  JSON.stringify({ v: t.rec.integrityVerdict, rw: t.rec.integrityRewritten }));
t = await traceTurn(OUT.oocBlocked);
check('T14c.traceOocNotRewritten', t.rec.integrityVerdict === 'OOC' && t.rec.integrityRewritten === false,
  JSON.stringify({ v: t.rec.integrityVerdict, rw: t.rec.integrityRewritten }));

t = await traceTurn(OUT.timeout);
check('T14d.traceTimeoutNotAdjudicated',
  t.rec.oocGuardApplied === true && t.rec.judgeAttempted === true
  && t.rec.integrityVerdict === 'UNDECIDED' && t.rec.integrityReason === 'timeout',
  JSON.stringify(t.rec));
t = await traceTurn(OUT.malformed);
check('T14e.traceMalformedReason', t.rec.integrityReason === 'malformed' && t.rec.integrityVerdict === 'UNDECIDED',
  JSON.stringify({ v: t.rec.integrityVerdict, r: t.rec.integrityReason }));
t = await traceTurn(OUT.bypassed);
check('T14f.traceBypassedJudgeNotAttempted',
  t.rec.integrityVerdict === 'BYPASSED' && t.rec.judgeAttempted === false
  && t.rec.oocGuardApplied === false && t.rec.integrityReason === 'disabled',
  JSON.stringify(t.rec));

/* —— 关键合法组合：guard 进入 + UNDECIDED + timeout —— */
t = await traceTurn(OUT.timeout);
check('T14g.guardEnteredWithUndecidedIsLegal',
  t.rec.oocGuardApplied === true && t.rec.integrityVerdict === 'UNDECIDED' && t.rec.integrityReason === 'timeout',
  JSON.stringify(t.rec));
/* —— BYPASSED + judge not attempted 必须可表达 —— */
t = await traceTurn(OUT.bypassed);
check('T14h.bypassedWithJudgeNotAttemptedExpressible',
  t.rec.integrityVerdict === 'BYPASSED' && t.rec.judgeAttempted === false,
  JSON.stringify(t.rec));

/* —— 字段声明 + 渲染（此前的渲染缺陷：文本字段被兜底成 false）—— */
check('T14i.traceFieldsDeclared',
  trace.fields.length === 23
  && ['judgeAttempted', 'integrityRewritten', 'sideEffectsSuppressed', 'sideEffectCategories']
    .every(k => trace.fields.indexOf(k) >= 0),
  JSON.stringify(trace.fields));
t = await new Promise(async resolve => {
  const prev = INTEG_ENTRY.fn;
  INTEG_ENTRY.fn = async () => OUT.timeout;
  trace.begin('chat', 'obs_render_role');
  await F.middleBrainFinalizeReply('obs_render_role', 'OBS_USER_MESSAGE', CANDIDATE, {});
  emitted.length = 0;
  trace.finish('obs_render_role', {});
  INTEG_ENTRY.fn = prev;
  setTimeout(() => resolve(emitted[emitted.length - 1] || ''), 10);
});
check('T14j.traceTextRendersRealValues',
  /integrityVerdict: UNDECIDED/.test(t) && /integrityReason: timeout/.test(t)
  && /judgeAttempted: true/.test(t) && !/integrityVerdict: false/.test(t),
  (t || '').split('\n').slice(0, 16).join(' | '));

/* —— turn 级抑制记录进入 trace（用真实 integrity 入口 + 受控抑制记录）——
   时序与生产逐字一致：① 收口产出 verdict → ② 副作用在闸门下执行（此处产生抑制记录）
   → ③ trace 收口时把记录复制进本轮 trace。 */
const supTrace = await (async () => {
  INTEG.middleBrainCharacterIntegrityReset();
  endTurn();
  const prev = INTEG_ENTRY.fn;
  INTEG_ENTRY.fn = async () => OUT.timeout;
  trace.begin('chat', 'obs_sup_role');
  await F.middleBrainFinalizeReply('obs_sup_role', 'OBS_USER_MESSAGE', CANDIDATE, {});
  INTEG_ENTRY.fn = prev;

  /* ② 副作用阶段：真实闸门 + 本轮 verdict=UNDECIDED ⇒ 记忆与工作区两类被拦下。
     注意顺序：生产里"取到 verdict"发生在副作用之前，故这里也先建立本回合的取值，
     再跑副作用；否则副作用阶段读到的是上一回合残留的取值（记录会被复位）。 */
  const sideEffects = runTurn(VERDICT.UNDECIDED, { memory: 1, workspace: 1, wsOps: [{ type: 'edit' }] });
  const s = sideEffects.sup;
  /* ③ 生产里由 _mbSecTraceFinish 从门面读同一份记录 */
  const viaFacade = F.middleBrainSideEffectSuppression();
  if (process.env.IB_DBG_T14K) console.log('    DBG s=' + JSON.stringify(s) + ' viaFacade=' + JSON.stringify(viaFacade) + ' noteArg=' + JSON.stringify(!(viaFacade.count > 0)));
  trace.note('obs_sup_role', 'sideEffectsSuppressed', !(viaFacade.count > 0));
  trace.note('obs_sup_role', 'sideEffectCategories', viaFacade.categories.slice());
  const rec = trace.finish('obs_sup_role', {});
  return { s, viaFacade, rec };
})();
/* 字段语义固定：sideEffectsSuppressed === false 表示**本轮确实存在抑制记录**
   （该字段回答"有没有"，与相邻的"抑制了哪些类"并列）。 */
check('T14k.traceCarriesSuppressionRecord',
  supTrace.rec.sideEffectsSuppressed === false
  && supTrace.rec.sideEffectCategories.slice().sort().join(',') === 'memory,workspace'
  /* 两个受保护入口各被拦下一次 ⇒ 本回合抑制条数 = 2（不是"是否抑制"的布尔在计数） */
  && supTrace.s.count === 2
  && supTrace.viaFacade.count === 2
  && supTrace.viaFacade.categories.slice().sort().join(',') === 'memory,workspace',
  JSON.stringify({ rec: supTrace.rec.sideEffectsSuppressed, cats: supTrace.rec.sideEffectCategories, count: supTrace.s.count }));

/* —— 缓存门面读取入口存在且只读 —— */
check('T14l.traceReaderExposesRing',
  typeof trace.recent === 'function' && trace.recent(2).length >= 1
  && typeof F.middleBrainSideEffectSuppression === 'function'
  && typeof F.MB_CI_SUPPRESSION_CATEGORIES === 'object',
  JSON.stringify(Object.keys(F).filter(k => /Suppression|CATEGORIES/.test(k))));

/* ══════════════════════════════════════════════════════════════════
   D · 隐私 / 凭据安全（T16）与硬约束（T17–T20）
   ══════════════════════════════════════════════════════════════════ */
section('D · privacy / 硬约束（T16–T20）');

console.info = realInfo;

const SECRET = 'sk-observability-secret';
const MEM_TEXT = '用户今天加班到很晚';
/* 凭据只经**配置层自带的宿主 shim**注入（config 契约是冻结的，不得就地改写：
   那正是"哪个宿主在跑"变成隐式全局状态的那类污染）。 */
setCfg({
  characterIntegrityEnabled: true, characterIntegrityVerify: false,
  characterIntegritySensitivity: 'balanced', apiKey: SECRET, authorization: 'Bearer ' + SECRET
});

const leakTest = await (async () => {
  const prev = INTEG_ENTRY.fn;
  const leakReply = '我是AI助手，可以调用工具。<mem_create type="event">' + MEM_TEXT + '</mem_create>\n密钥 ' + SECRET;
  INTEG_ENTRY.fn = async () => ({ ran: true, verdict: VERDICT.UNDECIDED, reason: 'timeout', rewritten: false, reply: leakReply });
  trace.begin('chat', 'obs_leak_role');
  await F.middleBrainFinalizeReply('obs_leak_role', 'OBS_USER_MESSAGE_LEAK', leakReply, {});
  INTEG_ENTRY.fn = prev;
  const hh = makeHarness(VERDICT.UNDECIDED);
  runSites(hh, { memory: 1 });
  const rec = trace.finish('obs_leak_role', {});
  return rec;
})();
const recJson = JSON.stringify(leakTest);
const leakNeedles = [SECRET, 'Bearer', MEM_TEXT, 'OBS_USER_MESSAGE_LEAK', '我是AI助手', 'mem_create', 'apiKey', 'Authorization', 'prompt', 'candidate'];
check('T16.telemetryIsMetadataOnly',
  leakNeedles.every(n => recJson.indexOf(n) < 0)
  && Object.keys(leakTest).every(k => ['string', 'boolean', 'number', 'object'].indexOf(typeof leakTest[k]) >= 0)
  && leakTest.judgeAttempted === true && leakTest.integrityVerdict === 'UNDECIDED',
  'leaked: ' + leakNeedles.filter(n => recJson.indexOf(n) >= 0).join(',') + ' | rec=' + recJson.slice(0, 200));

/* —— T17 · trace 面不引入任何模型调用；T18 · 无重试 —— */
resetAll();
model.plan = PASS_OK;
INTEG_ENTRY.fn = INTEG.middleBrainCharacterIntegrity;
trace.begin('chat', 'obs_count_role');
await F.middleBrainFinalizeReply('obs_count_role', 'OBS_USER_MESSAGE', CANDIDATE, {});
trace.finish('obs_count_role', {});
const afterTraceCalls = model.calls;   /* trace/finalize 面自己造成的调用数 */
const countOutcome = await finalize(CANDIDATE);
check('T17.noNewModelCallFromObservability',
  countOutcome.ran === true && vOf(countOutcome) === VERDICT.PASS,
  JSON.stringify({ v: vOf(countOutcome) }));
check('T18.noRetryOnJudgeFailure', (() => {
  /* 重试只可能来自传输层或 integrity 循环：源码里两种形态都不得出现 */
  const ci = rd('middle-brain-integrity.js');
  const callBlock = ci.slice(ci.indexOf('async function _ciCall'), ci.indexOf('function _mbCiSanitizeRewrite'));
  /* afterTraceCalls=1 证明"经过收口 + trace 收口"这一整段只花了一次调用（无隐藏重试）；
     model.calls=2 是再加上下面那次独立 finalize —— 每次都恰好一次。 */
  return !/for\s*\(|while\s*\(|retry|attempt/i.test(callBlock)
    && afterTraceCalls === 1 && model.calls === 2;
})(), 'afterTrace=' + afterTraceCalls + ' total=' + model.calls);

/* —— T19 · 生产 timeout 仍 20000；T20 · Judge 逐字不变 —— */
check('T19.productionTimeoutUnchanged', INTEG.MB_CI_TIMEOUT_MS === 20000, String(INTEG.MB_CI_TIMEOUT_MS));
check('T20a.judgeSchemaUnchanged',
  INTEG.MB_CI_SCHEMA.required.join(',') === 'pass,score,confidence,violations'
  && INTEG.MB_CI_SCHEMA.properties.pass.type === 'boolean',
  JSON.stringify(INTEG.MB_CI_SCHEMA.required));
check('T20b.judgeDimensionsUnchanged',
  INTEG.MB_CI_DIMENSIONS.slice().sort().join(',') === 'behavior,emotional_continuity,knowledge_boundary,persona,relationship,speech_style',
  JSON.stringify(INTEG.MB_CI_DIMENSIONS));
check('T20c.sensitivityUnchanged',
  Object.keys(INTEG.MB_CI_SENSITIVITY).join(',') === 'conservative,balanced,strict',
  JSON.stringify(Object.keys(INTEG.MB_CI_SENSITIVITY)));
check('T20d.judgePromptUnchanged',
  /当前上下文中的明确变化证据 > 静态人设刻板印象/.test(rd('middle-brain-integrity.js'))
  && /【证据不可用】下列维度缺少证据，\*\*不得\*\*据此判 fail/.test(rd('middle-brain-integrity.js')),
  'judge prompt contract text changed');

/* ══════════════════════════════════════════════════════════════════
   E · 类别词表与 executor 清单一致（防止"记了一个不存在的类别"）
   ══════════════════════════════════════════════════════════════════ */
section('E · 类别词表 vs 真实执行器清单');

const siteValues = Object.keys(INTEG.MB_CI_SIDE_EFFECT_SITES).map(k => INTEG.MB_CI_SIDE_EFFECT_SITES[k]);
const catValues = Object.keys(CATS).map(k => CATS[k]);
check('E1.categoriesFrozenAndDistinct',
  Object.isFrozen(CATS) && new Set(catValues).size === catValues.length
  && catValues.slice().sort().join(',') === 'blog_read,calendar,file_archive,memory,tool_continue,workspace',
  JSON.stringify(catValues));
/* 闸门轴（4 个决策点）与类别轴（6 类）是**多对一**：不得用集合相等偷懒，
   而要检查一张显式的映射表，并证明两个方向都可达（每个 site 至少落一类、
   每个类别至少来自一个 site）—— 否则"纸面类别"或"无类别 site"都会溜过去。 */
const SITE_CATS = {
  mem_ops: ['memory'],
  calendar: ['calendar'],
  blog_read: ['blog_read'],
  ws_ops: ['workspace', 'file_archive', 'tool_continue']
};
const mappedCats = [].concat.apply([], Object.keys(SITE_CATS).map(k => SITE_CATS[k]));
check('E2.categoriesCoverEverySite',
  siteValues.slice().sort().join(',') === Object.keys(SITE_CATS).sort().join(',')
  && Object.keys(SITE_CATS).every(k => SITE_CATS[k].length > 0
    && SITE_CATS[k].every(c => catValues.indexOf(c) >= 0))
  && catValues.slice().sort().join(',') === mappedCats.slice().sort().join(','),
  'sites=' + JSON.stringify(siteValues) + ' cats=' + JSON.stringify(catValues) + ' map=' + JSON.stringify(SITE_CATS));
check('E3.sitesUnchangedFromP11c',
  Object.isFrozen(INTEG.MB_CI_SIDE_EFFECT_SITES)
  && INTEG.MB_CI_SIDE_EFFECT_SITES.MEM_OPS === 'mem_ops'
  && INTEG.MB_CI_SIDE_EFFECT_SITES.CALENDAR === 'calendar'
  && INTEG.MB_CI_SIDE_EFFECT_SITES.BLOG_READ === 'blog_read'
  && INTEG.MB_CI_SIDE_EFFECT_SITES.WS_OPS === 'ws_ops',
  JSON.stringify(INTEG.MB_CI_SIDE_EFFECT_SITES));
/* 六个类别每个都必须有一条真实生产接线（类别不是纸面词表） */
const WIRING = [
  ['memory', /_mbSideEffectGate\(_MB_SEC\.mem\)/g, 2],
  ['calendar', /_mbSideEffectGate\(_MB_SEC\.cal\)/g, 2],
  ['blog_read', /(_mbSideEffectsOk\(_MB_SEC\.blog|_mbSideEffectGate\(\[_MB_SEC\.blog\]\))/g, 2],
  ['workspace', /_mbSecWsCats\(_ws(?:Parsed|Ns)\.ops\)/g, 3],
  ['file_archive', /_MB_SEC\.file/g, 4],
  ['tool_continue', /_MB_SEC\.tool\b/g, 1]
];
let wiringOk = true; const wiringSeen = [];
for (const [cat, re, want] of WIRING) {
  const n = (COM.match(re) || []).length;
  wiringSeen.push(cat + '=' + n + '/' + want);
  if (n < want) wiringOk = false;
}
check('E4.everyCategoryIsActuallyWired', wiringOk, JSON.stringify(wiringSeen));
check('E5.suppressionWriterIsSingle',
  countOcc(rd('middle-brain-integrity.js'), '_mbCiTelemetry.sideEffectsSuppressed++') === 1
  && countOcc(rd('middle-brain-integrity.js'), 'function _mbCiSuppress(') === 1
  && countOcc(rd('middle-brain-integrity.js'), '_mbCiTurnIdentity(v);') === 1
  && countOcc(rd('middle-brain-integrity.js'), '_mbCiTelemetry.turn = null') === 2,
  'writer/reset cardinality changed');
}

/* ══════════════════════════════════════════════════════════════════
   F · 静态结构：可观测面不越界
   ══════════════════════════════════════════════════════════════════ */
section('F · 静态结构守卫');
const MB = rd('middle-brain.js');
const CI = rd('middle-brain-integrity.js');
check('F1.facadeReadsAreAddOnly',
  /\['middleBrainSideEffectSuppression', 'integrity'\]/.test(MB)
  && /\['MB_CI_SUPPRESSION_CATEGORIES', 'integrity'\]/.test(MB)
  && !/window\.middleBrainSideEffectSuppression\s*=/.test(MB)
  && !/window\.MB_CI_SUPPRESSION_CATEGORIES\s*=/.test(MB),
  'observability keys missing from the facade or leaked as window aliases');
check('F2.desktopStillAvoidsInternalContracts',
  countOcc(COM, '__middleBrainContracts') === 0,
  'communication.js reads IB.__middleBrainContracts');
check('F3.suppressionModuleNeverTouchesTransport',
  (() => {
    const block = CI.slice(CI.indexOf('function _mbCiSuppress('), CI.indexOf('function _ciSkip('));
    return !/_ciCall|ASTRA\.|_ibApiPost|dbPut|fetch\(/.test(block);
  })(), 'suppression recorder reaches a transport or storage boundary');
check('F4.noToastOrUiSurfaceAdded',
  !/sideEffectsSuppressed/.test(rds('assets/js/communication.js').split('\n').filter(l => /toast|appendChatBubble|createElement/.test(l)).join('\n')),
  'suppression state leaked into a user-visible surface');

/* ══════════════════════════════════════════════════════════════════
   E/F 由 main() 驱动（上面那些用例是异步的，必须全部 settle 之后才能收口）
   ══════════════════════════════════════════════════════════════════ */
main().then(() => {
  console.log('\nP11-2D · Integrity Observability: ' + (failures ? failures + ' failed' : 'all checks passed'));
  process.exit(failures ? 1 : 0);
}).catch(err => {
  console.error('harness error: ' + (err && err.stack || err));
  process.exit(1);
});
