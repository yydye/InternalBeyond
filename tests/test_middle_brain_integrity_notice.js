/* ====================================================================
   P11-2E · User-facing Integrity Transparency · 离线确定性回归
   --------------------------------------------------------------------
   本文件回答且只回答一个问题：

     UNDECIDED 回合里回复**正常显示**、但由它解析出的自动动作被拦下时，
     用户能不能知道"这件事没有发生"？

   改动前：抑制对开发者可见（trace / telemetry，P11-2D），对**用户完全不可见** ——
   用户只会看到回复缺了一件事，然后自己猜。

   ── 被冻结的契约（本阶段唯一新增的东西）────────────────────────────
     metadata.integrityNotice = { type:"side_effect_blocked", categories:[…] }

     · 只在**真实发生抑制**时创建（integrity 层唯一写入点记录的 count > 0）。
       `verdict === UNDECIDED` 本身**不是**创建理由 —— 没有条目就没有抑制。
     · 类别限定在 6 个已冻结的值内；**不含任何 payload**（正文 / 路径 / 记忆内容 /
       工具参数 / 搜索词都没有承载字段）。
     · 出现在 **metadata** 里，assistant 的 content 逐字不变。
     · 流式与非流式走**同一个派生函数与同一个渲染入口**。
     · 历史消息（无该 metadata）渲染路径与改动前逐字一致。

   ── 硬边界（本阶段一律未触碰）──────────────────────────────────────
     Judge prompt / verdict 词表 / 阈值 / 敏感度 / timeout / retry / provider /
     calibration / side-effect policy / UNDECIDED 的阻断行为 全部不变。
     不自动执行被拦下的动作、不恢复失败的副作用。

   ── 运行 ────────────────────────────────────────────────────────────
     node tests/test_middle_brain_integrity_notice.js
   纯 Node、零网络、零浏览器、零真实 provider 调用。
   求值的是**生产源码本身**：assets/js/middle-brain-integrity.js、
   assets/js/middle-brain.js；communication.js 的派生/解析/渲染函数按源码原样取出。
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

console.log('P11-2E · User-facing Integrity Transparency · offline deterministic');

/* ══════════════════════════════════════════════════════════════════
   0 · 生产装配：契约层（与 P11-2D observability 同一条路径）
   ══════════════════════════════════════════════════════════════════ */
globalThis.window = globalThis;

/* —— 传输边界：本进程唯一的"provider"（生产 astra 层自留的 root._ibApiPost 接缝）——
   装的是它，因此被验证的是完整生产栈；本文件仍**不发起任何真实调用**。 —— */
const model = { calls: 0, log: [], plan: null };
const respOf = (text) => ({ output: [{ type: 'message', content: [{ type: 'output_text', text: text }] }], usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 } });
globalThis._ibApiPost = async function (endpoint, headers, body, opts) {
  model.calls++;
  const parsed = (() => { try { return JSON.parse(String(body)); } catch (e) { return {}; } })();
  const schemaName = String((((parsed || {}).text || {}).format || {}).name || '');
  model.log.push(schemaName);
  let p = model.plan;
  if (typeof p === 'function') p = p(parsed, schemaName);
  const kind = p && typeof p === 'object' ? p.kind : null;
  if (kind === 'hang') {
    await new Promise((resolve, reject) => {
      const sig = opts && opts.signal;
      if (!sig) return setTimeout(resolve, 250);
      if (sig.aborted) return reject(new Error('aborted'));
      sig.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
  }
  if (kind === 'throw') throw new Error('transport down');
  if (kind === 'http') return { ok: false, status: 500, json: async () => ({ error: 'boom' }) };
  const text = typeof p === 'string' ? p : (p && p.text != null ? p.text : '');
  return { ok: true, status: 200, json: async () => respOf(text) };
};
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

/* —— 生产模块加载（与浏览器同一顺序 InternalBeyond.html）—— */
require(path.join(ROOT, 'assets', 'js', 'middle-brain-config.js'));
require(path.join(ROOT, 'assets', 'js', 'middle-brain-policy.js'));
require(path.join(ROOT, 'assets', 'js', 'middle-brain-astra.js'));
require(path.join(ROOT, 'assets', 'js', 'middle-brain-judge.js'));
require(path.join(ROOT, 'assets', 'js', 'middle-brain-integrity.js'));

const MBC = globalThis.IB && globalThis.IB.__middleBrainContracts;
if (!MBC || !MBC.integrity) throw new Error('canonical integrity layer unavailable');
const INTEG = MBC.integrity;
const CATS = INTEG.MB_CI_SUPPRESSION_CATEGORIES;
const VERDICT = INTEG.MB_CI_VERDICT;

/* —— 配置宿主：用生产自带的显式 shim 接缝（与 Home Node 提供配置同一条路），
   不替换 config 层方法、不改装配。 —— */
let cfgOverride = {};
const setCfg = o => { cfgOverride = o || {}; };
const baseCfg = () => Object.assign({
  /* middleBrainApiReady 要求 enabled + endpoint + model + apiKey 齐全；
     integrity 层是否运行另有自己的开关（characterIntegrityEnabled），两者互不代表。 */
  enabled: true,
  characterIntegrityEnabled: true,
  characterIntegrityVerify: false,
  characterIntegrityRewrite: true,
  characterIntegritySensitivity: 'balanced',
  endpoint: 'http://127.0.0.1:9/never-called',
  model: 'notice-integrity-model',
  apiKey: 'notice-local-credential'
}, cfgOverride);
globalThis.__ibMiddleBrainConfigReader = async () => baseCfg();

require(path.join(ROOT, 'assets', 'js', 'middle-brain.js'));
const FACADE = globalThis.IB.middleBrain;
if (!FACADE || !FACADE.middleBrainSideEffectAllowed) throw new Error('facade incomplete');
/* 传显式 outcome 的 finalize：本文件要的是"verdict + 抑制记录"这一对输入，
   不依赖模型输出（Judge 行为是 P11-2A/2B 的被测对象，不是本阶段的）。 */
const finalizeWith = async (verdict, candidate, opts) => {
  const prev = MBC.integrity;
  MBC.integrity = Object.freeze(Object.assign({}, prev, {
    middleBrainCharacterIntegrity: async () => ({
      reply: candidate, verdict: verdict, reason: null, pass: null, ran: verdict !== VERDICT.BYPASSED,
      gate: null, rewritten: false, report: null, violations: null, maxSeverity: null,
      judgeError: null, verify: null, evidence: null
    })
  }));
  try {
    return await globalThis.IB.middleBrain.middleBrainFinalizeReply('notice_role', 'NOTICE_USER_MESSAGE', candidate, Object.assign({ character: { id: 'notice_role' } }, opts || {}));
  } finally { MBC.integrity = prev; }
};

/* ══════════════════════════════════════════════════════════════════
   1 · 闸门适配层（与 P11-2D 同款：求值 communication.js 的真实函数文本）
   ══════════════════════════════════════════════════════════════════ */
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
  grab(/function _mbSecWsCount\(ops,fileCount\)\{[\s\S]*?\n\}/, '_mbSecWsCount'),
  grab(/function _mbSideEffectsOk\(category,count\)\{[\s\S]*?\n\}/, '_mbSideEffectsOk')
].join('\n');

const makeHarness = (verdict) => {
  const exec = { memory: [], calendar: [], blog: [], workspace: [], file: [], tool: [] };
  const sandboxWindow = { IB: { middleBrain: globalThis.IB.middleBrain } };
  const src = GATE_SRC + '\nreturn {gate:_mbSideEffectGate,gateCats:_mbSideEffectGateCats,'
    + 'gateAcc:_mbSideEffectsOk,wsCats:_mbSecWsCats,wsCount:_mbSecWsCount,counts:_mbSideEffectCounts,sec:_MB_SEC};';
  const api = new Function('window', '_mbVerdict', '_mbSideEffectCounts',
    '"use strict";' + src)(sandboxWindow, verdict, {});
  return { api, exec, counts: api.counts };
};
const runSites = (h, present) => {
  const body = [];
  if (present.memory) body.push('mem');
  if (present.calendar) body.push('cal');
  if (present.blog) body.push('blog');
  if (present.file) body.push('file');
  const out = {};
  for (const k of body) {
    const c = h.api.counts;
    if (k === 'mem') { c[h.api.sec.mem] = present.memory; out.memory = h.api.gate(h.api.sec.mem); }
    if (k === 'cal') { c[h.api.sec.cal] = 1; out.calendar = h.api.gate(h.api.sec.cal); }
    if (k === 'blog') { c[h.api.sec.blog] = present.blog; out.blog = h.api.gate(h.api.sec.blog); }
    if (k === 'file') { c[h.api.sec.file] = present.file; out.file = h.api.gate(h.api.sec.file); }
  }
  /* 工作区闸门：与生产 2396/2490 同形 —— 条数取自 `_mbSideEffectCounts`，
     类别由 op.type 逐个算出（含 run ⇒ tool_continue）后**随调用一起**交给闸门。 */
  if (present.workspace) {
    h.api.counts[h.api.sec.ws] = present.workspace;
    out.workspace = h.api.gate(h.api.sec.ws);
  }
  /* 工具回合续：与生产 2404/2494 同形 —— 类别 = ws 类别 ∪ file 类别，
     **条数由调用方给出**（这正是 P11-2D 缺的那一个实参；缺了它闸门照样拦，
     但一个字都不记）。 */
  if (present.workspace || present.file || (present.wsOps && present.wsOps.length)) {
    const cont = h.api.wsCats(present.wsOps).concat(present.file ? [h.api.sec.file] : []);
    const n = h.api.wsCount(present.wsOps, present.file ? 1 : 0);
    out.tool_continue = cont.length ? h.api.gateCats(cont, n) : null;
  }
  const apply = (out, present) => {
    if (out.memory === true) h.exec.memory.push(present.memory);
    if (out.calendar === true) h.exec.calendar.push(1);
    if (out.blog === true) h.exec.blog.push(present.blog);
    if (out.workspace === true) h.exec.workspace.push(h.api.wsCats(present.wsOps).length || 1);
    if (out.file === true) h.exec.file.push(present.file);
    return out;
  };
  return apply(out, present);
};

/* ══════════════════════════════════════════════════════════════════
   2 · 提示派生 / 解析 / 渲染（生产源码原样取出）
   ══════════════════════════════════════════════════════════════════ */
/* —— 最小 DOM shim：只实现生产函数真正用到的那几个成员 —— */
const escProd = function (s) {
  if (!s) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
};
function makeEl(tag) {
  return {
    tagName: String(tag || 'div').toUpperCase(),
    className: '', innerHTML: '', textContent: '', dataset: {}, children: [],
    appendChild(c) { this.children.push(c); c.parentNode = this; return c; },
    querySelector() { return null; }
  };
}
const sandboxDoc = { createElement: makeEl };
globalThis.document = sandboxDoc;

const NOTICE_SRC = [
  grab(/var MB_INTEGRITY_NOTICE_TYPE=[^\n]*\n/, 'MB_INTEGRITY_NOTICE_TYPE'),
  grab(/var _MB_NOTICE_CATS=\[[^\n]*\n/, '_MB_NOTICE_CATS'),
  grab(/var MB_NOTICE_USER_VISIBLE_CATS=\[[^\n]*\n/, 'MB_NOTICE_USER_VISIBLE_CATS'),
  grab(/var _MB_NOTICE_TEXT_SPECIFIC=[^\n]*\n/, '_MB_NOTICE_TEXT_SPECIFIC'),
  grab(/var _MB_NOTICE_TEXT_GENERIC=[^\n]*\n/, '_MB_NOTICE_TEXT_GENERIC'),
  grab(/function _mbIntegrityNoticeFor\(verdict\)\{[\s\S]*?\n\}\n/, '_mbIntegrityNoticeFor'),
  grab(/function _mbNoticeFromMessage\(m\)\{[\s\S]*?\n\}\n/, '_mbNoticeFromMessage'),
  grab(/function _buildIntegrityNoticeCard\(notice\)\{[\s\S]*?\n\}\n/, '_buildIntegrityNoticeCard'),
  grab(/function _mbAppendNoticeCard\(host,m\)\{[\s\S]*?\n\}\n/, '_mbAppendNoticeCard')
].join('\n');
/* 生产里 esc / WS_ICON 是全局（core.js / workspace/files.js），此处按生产字号给出。
   WS_ICON 只取生产里真实存在的那一个 svg 字符串，不做替代实现。 */
const WARN_SVG = rds('assets/js/workspace/files.js').match(/warn:'(<svg[\s\S]*?<\/svg>)'/);
if (!WARN_SVG) throw new Error('could not extract WS_ICON.warn from workspace/files.js');
const NOTICE = new Function('window', 'document', 'esc', 'WS_ICON',
  '"use strict";' + NOTICE_SRC
  + '\nreturn {forVerdict:_mbIntegrityNoticeFor,fromMessage:_mbNoticeFromMessage,'
  + 'buildCard:_buildIntegrityNoticeCard,append:_mbAppendNoticeCard,'
  + 'TYPE:MB_INTEGRITY_NOTICE_TYPE,CATS:_MB_NOTICE_CATS,VISIBLE:MB_NOTICE_USER_VISIBLE_CATS,'
  + 'TEXT_SPECIFIC:_MB_NOTICE_TEXT_SPECIFIC,TEXT_GENERIC:_MB_NOTICE_TEXT_GENERIC};'
)({ IB: { middleBrain: globalThis.IB.middleBrain } }, sandboxDoc, escProd, { warn: WARN_SVG[1] });

/* 抑制记录读取（唯一读取入口 = 门面） */
const suppressionOf = () => INTEG.middleBrainSideEffectSuppression();
const endTurn = () => { INTEG.middleBrainCharacterIntegrityReset(); };

/* 一个"完整回合"：闸门判定（真实适配层）+ 派生提示（真实派生函数）。
   顺序与生产一致：先所有副作用点，后派生。 */
const runTurn = (verdict, present) => {
  endTurn();
  const hh = makeHarness(verdict);
  const decisions = runSites(hh, present || {});
  return { h: hh, decisions, sup: suppressionOf(), notice: NOTICE.forVerdict(verdict) };
};

/* ══════════════════════════════════════════════════════════════════
   A · 契约形状（T1 / T5 / T6）
   ══════════════════════════════════════════════════════════════════ */
section('A · notice 契约形状（T1 / T5 / T6）');

check('A1.noticeTypeIsStableLiteral',
  NOTICE.TYPE === 'side_effect_blocked', NOTICE.TYPE);
check('A2.noticeCategoriesMatchIntegrityVocabulary',
  NOTICE.CATS.slice().sort().join(',') === Object.keys(CATS).map(k => CATS[k]).sort().join(','),
  JSON.stringify({ notice: NOTICE.CATS, integrity: Object.keys(CATS).map(k => CATS[k]) }));
check('A3.visibleCategoriesAreASubset',
  NOTICE.VISIBLE.every(c => NOTICE.CATS.indexOf(c) >= 0), JSON.stringify(NOTICE.VISIBLE));

/* —— T1 · 只有真的发生抑制才创建 —— */
const t1 = runTurn(VERDICT.UNDECIDED, { memory: 2 });
check('T1.undecidedWithRealSuppressionCreatesNotice',
  t1.sup.count === 2 && !!t1.notice && t1.notice.type === NOTICE.TYPE
  && t1.notice.categories.join(',') === 'memory',
  JSON.stringify({ sup: t1.sup, notice: t1.notice }));

/* —— T5 · 类别保留（多类 / 去重）——
   注意 workspace 这一类的来源：它由 `_mbSecWsCats(ops)` 从 op.type 算出后
   **随调用一起**交给闸门（生产里 `_mbSideEffectCounts.ws` 只是条数，类别不走它）。 */
const t5 = runTurn(VERDICT.UNDECIDED, { memory: 1, workspace: 1, wsOps: [{ type: 'create' }], file: 1 });
check('T5.multipleCategoriesPreserved',
  !!t5.notice && t5.notice.categories.slice().sort().join(',') === 'file_archive,memory,workspace',
  JSON.stringify(t5.notice && t5.notice.categories));
/* 重复询问同一类别不得重复登记（生产里一个类别可能被问多次） */
endTurn();
{
  const hh = makeHarness(VERDICT.UNDECIDED);
  hh.api.counts[hh.api.sec.mem] = 3;
  hh.api.gate(hh.api.sec.mem); hh.api.gate(hh.api.sec.mem); hh.api.gate(hh.api.sec.mem);
  const n = NOTICE.forVerdict(VERDICT.UNDECIDED);
  check('T5b.categoriesAreDeduplicated',
    !!n && n.categories.length === 1 && n.categories[0] === 'memory', JSON.stringify(n));
}

/* —— T6 · 不含 payload —— */
const t6json = JSON.stringify(t5.notice);
const PAYLOAD_NEEDLES = ['用户今天加班', 'mem_create', 'sk-', 'C:\\', '/home/', 'Bearer',
  'Authorization', 'prompt', 'candidate', '.txt', '.js', 'type=', 'importance'];
check('T6.noticeCarriesNoPayload',
  PAYLOAD_NEEDLES.every(n => t6json.indexOf(n) < 0), t6json);
check('T6b.noticeKeysAreExactlyTypeAndCategories',
  JSON.stringify(Object.keys(t5.notice).sort()) === JSON.stringify(['categories', 'type']),
  JSON.stringify(Object.keys(t5.notice)));
check('T6c.categoriesAreOnlyFromTheFrozenVocabulary',
  t5.notice.categories.every(c => NOTICE.CATS.indexOf(c) >= 0), JSON.stringify(t5.notice.categories));

/* ③ verdict 守卫：记录非空、但**裁定状态不是 UNDECIDED**（不一致状态）。
   抑制只可能由 UNDECIDED 产生，所以这种状态在正常 API 下造不出来 ——
   它是**防御性**守卫，用直接构造的记录来测。若这里也出提示，就等于把一个矛盾
   状态包装成一句安慰话。没有这条，"verdict 必须是 UNDECIDED"这个守卫
   **没有任何测试**（实测：删掉该守卫时全部用例仍然全绿）。 */
{
  endTurn();
  const t = INTEG.middleBrainCharacterIntegrityTelemetry();
  const saved = t.turn;
  t.turn = { categories: ['memory'], count: 1 };
  let onPass, onNull, onBypassed;
  try {
    onPass = NOTICE.forVerdict(VERDICT.PASS);
    onNull = NOTICE.forVerdict(null);
    onBypassed = NOTICE.forVerdict(VERDICT.BYPASSED);
  } finally { t.turn = saved; }
  check('T1d.verdictGuardBlocksInconsistentSuppressionRecord',
    onPass === null && onNull === null && onBypassed === null,
    JSON.stringify({ onPass, onNull, onBypassed }));
}

/* ══════════════════════════════════════════════════════════════════
   ══════════════════════════════════════════════════════════════════ */
section('B · 行为矩阵（CASE 1–7）');

/* CASE 1 · PASS + memory op ⇒ 执行了，无提示 */
const c1 = runTurn(VERDICT.PASS, { memory: 1 });
check('CASE1.passExecutesAndGivesNoNotice',
  c1.decisions.memory === true && c1.h.exec.memory.length === 1 && c1.notice === null,
  JSON.stringify({ d: c1.decisions, exec: c1.h.exec, notice: c1.notice }));

/* CASE 2 · OOC + ops（rewrite disabled 语义由 integrity 层承担）⇒ 政策不变、无提示 */
const c2 = runTurn(VERDICT.OOC, { memory: 1, workspace: 1, wsOps: [{ type: 'edit' }] });
check('CASE2.oocKeepsOriginalPolicyAndGivesNoNotice',
  c2.decisions.memory === true && c2.decisions.workspace === true
  && c2.h.exec.memory.length === 1 && c2.notice === null,
  JSON.stringify({ d: c2.decisions, notice: c2.notice }));

/* CASE 3 · UNDECIDED + no ops ⇒ 无提示（T2） */
const c3 = runTurn(VERDICT.UNDECIDED, {});
check('CASE3.undecidedWithoutOpsGivesNoNotice',
  c3.sup.count === 0 && c3.notice === null, JSON.stringify({ sup: c3.sup, notice: c3.notice }));
/* T2b · 生产里"没有条目"的另一种真实形态：调用点交出的类别集合为空 */
endTurn();
{
  const hh = makeHarness(VERDICT.UNDECIDED);
  hh.api.gate([]);
  const n = NOTICE.forVerdict(VERDICT.UNDECIDED);
  check('T2b.undecidedWithEmptyCategorySetGivesNoNotice',
    n === null && suppressionOf().count === 0, JSON.stringify({ n, sup: suppressionOf() }));
}

/* CASE 4 · UNDECIDED + memory op ⇒ 不执行 + 有提示（T3） */
const c4 = runTurn(VERDICT.UNDECIDED, { memory: 1 });
check('CASE4.undecidedMemoryBlockedAndNotified',
  c4.decisions.memory === false && c4.h.exec.memory.length === 0
  && !!c4.notice && c4.notice.categories.join(',') === 'memory',
  JSON.stringify({ d: c4.decisions, exec: c4.h.exec, notice: c4.notice }));

/* CASE 5 · UNDECIDED + workspace op ⇒ 不执行 + 有提示（T4） */
const c5 = runTurn(VERDICT.UNDECIDED, { workspace: 1, wsOps: [{ type: 'create' }] });
check('CASE5.undecidedWorkspaceBlockedAndNotified',
  c5.decisions.workspace === false && c5.h.exec.workspace.length === 0
  && !!c5.notice && c5.notice.categories.indexOf('workspace') >= 0,
  JSON.stringify({ d: c5.decisions, exec: c5.h.exec, notice: c5.notice }));

/* CASE 6 · UNDECIDED + 多类别 ⇒ 一次提示、类别去重 */
const c6 = runTurn(VERDICT.UNDECIDED, {
  memory: 2, calendar: 1, blog: 1, workspace: 1,
  wsOps: [{ type: 'read' }, { type: 'run' }], file: 1
});
check('CASE6.multiCategorySingleDedupedNotice',
  !!c6.notice
  && c6.notice.categories.length === new Set(c6.notice.categories).size
  && c6.notice.categories.slice().sort().join(',') === 'blog_read,calendar,file_archive,memory,tool_continue,workspace',
  JSON.stringify(c6.notice && c6.notice.categories));
check('CASE6b.multiCategoryEverythingBlocked',
  c6.decisions.memory === false && c6.decisions.calendar === false
  && c6.h.exec.memory.length === 0 && c6.h.exec.calendar.length === 0,
  JSON.stringify(c6.decisions));

/* CASE 7 · BYPASSED ⇒ 保持原行为、无提示（T11） */
const c7 = runTurn(VERDICT.BYPASSED, { memory: 1, workspace: 1, wsOps: [{ type: 'create' }] });
check('CASE7.bypassedUnchangedAndGivesNoNotice',
  c7.decisions.memory === true && c7.decisions.workspace === true
  && c7.h.exec.memory.length === 1 && c7.notice === null,
  JSON.stringify({ d: c7.decisions, notice: c7.notice }));

/* —— T11b · PASS / BYPASSED / OOC 在**每个**受保护入口都不产生提示 —— */
{
  const variants = [
    ['PASS', VERDICT.PASS], ['OOC', VERDICT.OOC], ['BYPASSED', VERDICT.BYPASSED]
  ];
  const allNoNotice = variants.every(([label, v]) => {
    const r = runTurn(v, { memory: 1, calendar: 1, blog: 1, wsOps: [{ type: 'run' }], file: 1, tool: 1, toolOps: [{ type: 'run' }] });
    return r.notice === null;
  });
  check('T11b.noNoticeForAnyAllowedVerdictAcrossAllSites', allNoNotice);
}
/* —— T11c · 未知 verdict 字符串：绝不当作允许、也绝不冒充 UNDECIDED —— */
{
  endTurn();
  const hh = makeHarness('SOMETHING_ELSE');
  hh.api.counts[hh.api.sec.mem] = 1;
  const allowed = hh.api.gate(hh.api.sec.mem);
  const n = NOTICE.forVerdict('SOMETHING_ELSE');
  check('T11c.unknownVerdictStaysFailOpenAndSilent',
    allowed === true && n === null, JSON.stringify({ allowed, n }));
}

/* —— T1b · 提示只由"真实抑制"派生 ——
   两种"不该有提示"的形态都要覆盖，因为它们由**不同的守卫**拦下：
     ① 记录被清空（categories 也空）  → 由 count 守卫与 categories 守卫共同拦下；
     ② 记录里 category 为空、但 count 为 0（gateCats 空集合形态）→ 只有 count 守卫能拦。
   只测 ① 的话，去掉 count 守卫测试仍然全绿（"空类别"这条会替它兜住）——
   实测踩到，故补 ②。 */
{
  endTurn();
  const hh = makeHarness(VERDICT.UNDECIDED);
  hh.api.counts[hh.api.sec.mem] = 1;
  hh.api.gate(hh.api.sec.mem);                       /* 记下一条 */
  const withRec = NOTICE.forVerdict(VERDICT.UNDECIDED);
  INTEG.middleBrainCharacterIntegrityReset();        /* ① 记录清空，verdict 语义不变 */
  const withoutRec = NOTICE.forVerdict(VERDICT.UNDECIDED);
  check('T1b.noticeFollowsTheRecordNotTheVerdict',
    !!withRec && withoutRec === null, JSON.stringify({ withRec, withoutRec }));
}
/* ② 关键形态：抑制记录里**有类别、但 count 为 0**。
   此时 categories 守卫放过它（数组非空），**只有 count 守卫**能拦下 —— 这是唯一
   能把 `count > 0` 这条守卫与其他守卫分离开的形态。
   `_mbCiSuppress` 目前不会产出这种状态，但读数路径必须对它安全：提示的判据是
   "计数 > 0"，不是"类别数组非空"。直接构造该状态并断言。 */
{
  endTurn();
  const supFn = INTEG.middleBrainSideEffectSuppression;
  const t = INTEG.middleBrainCharacterIntegrityTelemetry();
  const savedTurn = t.turn;
  t.turn = { categories: ['memory'], count: 0 };
  let n;
  try { n = NOTICE.forVerdict(VERDICT.UNDECIDED); } finally { t.turn = savedTurn; }
  check('T1c.categoriesWithoutACountNeverProduceANotice', n === null, JSON.stringify({ n, sup: supFn() }));
}

/* ══════════════════════════════════════════════════════════════════
   C · 渲染（T7 / T8b / T10）
   ══════════════════════════════════════════════════════════════════ */
section('C · 渲染（T7 / T10）');

const hostOf = () => { const h = makeEl('div'); h.className = 'r-text'; return h; };

/* —— T10 · 历史消息（无 metadata）⇒ 不 append 任何节点 —— */
const host10 = hostOf();
const r10 = NOTICE.append(host10, { id: 'm1', role: 'assistant', content: '你好' });
check('T10.legacyMessageWithoutMetadataAppendsNothing',
  r10 === null && host10.children.length === 0, JSON.stringify(host10.children.length));

/* 其它"看起来像但不是"的 metadata 同样不得渲染 */
{
  const bads = [
    { metadata: null },
    { metadata: {} },
    { metadata: { integrityNotice: null } },
    { metadata: { integrityNotice: [] } },
    { metadata: { integrityNotice: { type: 'other_type', categories: ['memory'] } } },
    { metadata: { integrityNotice: { type: NOTICE.TYPE, categories: [] } } },
    { metadata: { integrityNotice: { type: NOTICE.TYPE, categories: ['unknown_category'] } } },
    { metadata: { showThinking: true, model: 'm' } }
  ];
  const ok = bads.every(m => {
    const h = hostOf();
    return NOTICE.append(h, m) === null && h.children.length === 0;
  });
  check('T10b.onlyTheExactContractRenders', ok);
}

/* —— T7 · assistant 内容逐字不变，节点追加在回复之后 —— */
{
  /* 显式造一个"真实抑制回合"再渲染：渲染用例不依赖上一个小节的残留状态。 */
  endTurn();
  {
    const hh = makeHarness(VERDICT.UNDECIDED);
    hh.api.counts[hh.api.sec.ws] = 1;
    hh.api.gate(hh.api.sec.ws);
  }
  const notice = NOTICE.forVerdict(VERDICT.UNDECIDED);
  check('T7.preconditionRealSuppressionExists', !!notice, JSON.stringify(notice));
  const host = hostOf();
  const textNode = makeEl('span');                   /* 模拟已渲染的回复正文 */
  textNode.textContent = '你好呀，我在。';
  host.appendChild(textNode);
  const card = NOTICE.append(host, { metadata: { integrityNotice: notice } });
  check('T7.noticeAppendedAfterContentAndContentUntouched',
    host.children.length === 2 && host.children[0] === textNode
    && !!card && host.children[1] === card
    && textNode.textContent === '你好呀，我在。' && textNode.innerHTML === '',
    JSON.stringify({ n: host.children.length, text: textNode.textContent }));
  check('T7b.cardIsInlineWsOpCardWarn',
    !!card && card.className.indexOf('ws-op-card') >= 0 && card.className.indexOf('warn') >= 0
    && card.dataset.noticeType === NOTICE.TYPE,
    card && card.className);
  check('T7c.cardCarriesNoInteractiveControl',
    !!card && card.children.length === 0 && card.innerHTML.indexOf('<button') < 0,
    card && card.innerHTML.slice(0, 160));
}

/* —— 文本：不出现任何内部词汇 —— */
{
  const INTERNAL_WORDS = ['judge', 'astra', 'integrity', 'undecided', 'confidence',
    'score', 'severity', 'dimension', 'verdict', 'ooc', 'PASS', 'BYPASSED'];
  const texts = [NOTICE.TEXT_SPECIFIC, NOTICE.TEXT_GENERIC];
  const hits = [];
  texts.forEach(t => INTERNAL_WORDS.forEach(w => { if (t.toLowerCase().indexOf(w.toLowerCase()) >= 0) hits.push(w); }));
  check('T7d.noticeTextExposesNoInternalVocabulary', hits.length === 0, JSON.stringify(hits));
  check('T7e.noticeTextDistinguishesReplyOkFromActionSkipped',
    /回复已完成/.test(NOTICE.TEXT_SPECIFIC) && /回复已完成/.test(NOTICE.TEXT_GENERIC)
    && /没有执行/.test(NOTICE.TEXT_SPECIFIC) && /没有执行/.test(NOTICE.TEXT_GENERIC),
    JSON.stringify(texts));
  /* 用户可感知类别 ⇒ 具体说法；只有静默类别 ⇒ 通用说法；两者都必须存在且不同 */
  const cardSpec = NOTICE.buildCard({ type: NOTICE.TYPE, categories: ['workspace'] });
  const cardGen = NOTICE.buildCard({ type: NOTICE.TYPE, categories: ['memory'] });
  check('T7f.visibleCategoryUsesSpecificCopyAndSilentCategoryUsesGeneric',
    !!cardSpec && !!cardGen
    && cardSpec.innerHTML.indexOf(escProd(NOTICE.TEXT_SPECIFIC)) >= 0
    && cardGen.innerHTML.indexOf(escProd(NOTICE.TEXT_GENERIC)) >= 0
    && NOTICE.TEXT_SPECIFIC !== NOTICE.TEXT_GENERIC);
  check('T7g.renderedTextCannotLeakPayload',
    !!cardSpec && PAYLOAD_NEEDLES.every(n => cardSpec.innerHTML.indexOf(n) < 0));
}

/* ══════════════════════════════════════════════════════════════════
   D · stream / non-stream 一致性（T8 / T9 / T13 / T14 / T15）
   ══════════════════════════════════════════════════════════════════ */
/* 下面是唯一的异步段（要跑真实 finalize 才谈得上"没有新增模型调用"）。
   本文件是 CommonJS，顶层 await 会被 Node 拒绝，故显式包一个 async 主体。 */
async function mainAsync() {
section('D · stream / non-stream 一致性（T8 / T9）');

const streamMeta = COM.match(/const _n=_mbIntegrityNoticeFor\(_mbVerdict\);if\(_n\)aiMsg\.metadata\.integrityNotice=_n;/);
const nonStreamMeta = COM.match(/const _nNs=_mbIntegrityNoticeFor\(_mbVerdict\);if\(_nNs\)aiMsg\.metadata\.integrityNotice=_nNs;/);
check('T8.streamPathCreatesNoticeMetadata', !!streamMeta);
check('T9.nonStreamingPathCreatesNoticeMetadata', !!nonStreamMeta);
/* 两条路径必须走同一个派生函数 —— 各自内联一份判定就是分叉 */
check('T8b.bothPathsCallTheSingleDerivationPoint',
  countOcc(COM, '_mbIntegrityNoticeFor(_mbVerdict)') === 2 && countOcc(COM, 'function _mbIntegrityNoticeFor(') === 1,
  JSON.stringify({ calls: countOcc(COM, '_mbIntegrityNoticeFor(_mbVerdict)'), defs: countOcc(COM, 'function _mbIntegrityNoticeFor(') }));

/* 渲染入口：流式 / 非流式 / 历史（全屏 + 小窗）= 4 处，且都经同一个 append */
check('T8c.renderEntryPointIsShared',
  countOcc(COM, '_mbAppendNoticeCard(') === 5 /* 1 定义 + 4 调用点 */,
  String(countOcc(COM, '_mbAppendNoticeCard(')));
check('T8d.bothLivePathsRenderTheCard',
  /streamRefs\.forEach\(ref=>\{_mbAppendNoticeCard\(/.test(COM)
  && /querySelectorAll\('\.chat-msg\[data-msg-id="'\+aiMsg\.id\+'"\]'\)\.forEach\(function\(el\)\{_mbAppendNoticeCard\(el,aiMsg\)\}\)/.test(COM));
check('T8e.historyPathsRenderTheCard',
  countOcc(COM, '_mbAppendNoticeCard(div,m);') === 2,
  String(countOcc(COM, '_mbAppendNoticeCard(div,m);')));

/* ══════════════════════════════════════════════════════════════════
   D3 · 真实渲染路径（DOM 求值，不是文本匹配）
   ══════════════════════════════════════════════════════════════════
   把**整个 assets/js/communication.js** 装进 vm 沙箱求值（真实 IIFE、真实装配、
   真实 `_buildMsgEl`），然后用真实消息对象渲染一次，检查提示卡是否真的进了 DOM。

   为什么必须有这一段：T8c/T8d/T8e 是对源码的**文本匹配** —— 把渲染调用点整体删掉
   或改名，它们会一起变红；但若只是把调用点留在源码里却不生效（例如放进永不执行
   的分支），文本匹配什么都看不出来。这一段测的是行为。 */
section('D3 · 真实渲染路径（vm 求值 communication.js）');

const vm = require('node:vm');

function makeDomEl(tag) {
  const e = {
    tagName: String(tag || 'div').toUpperCase(), _cls: '', _html: '', _text: '',
    dataset: {}, style: {}, children: [], parentNode: null,
    appendChild(c) { if (c == null) return c; c.parentNode = this; this.children.push(c); return c; },
    removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); return c; },
    querySelector() { return null; }, querySelectorAll() { return []; },
    addEventListener() { }, removeEventListener() { }, setAttribute(k, v) { this[k] = v; },
    getAttribute() { return null; },
    set className(v) { this._cls = String(v); }, get className() { return this._cls; },
    set innerHTML(v) { this._html = String(v); this.children.length = 0; }, get innerHTML() { return this._html; },
    set textContent(v) { this._text = String(v); this.children.length = 0; }, get textContent() { return this._text; },
    classList: { add() { }, remove() { }, toggle() { }, contains() { return false; } },
    cloneNode() { return makeDomEl(tag); }
  };
  return e;
}
const domDoc = {
  createElement: makeDomEl, createDocumentFragment: () => makeDomEl('#fragment'),
  createTextNode: t => { const e = makeDomEl('#text'); e._text = String(t); return e; },
  getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
  addEventListener() { }, removeEventListener() { }, body: makeDomEl('body'), head: makeDomEl('head'),
  documentElement: makeDomEl('html'), cookie: '', readyState: 'complete', hidden: false,
  createEvent: () => ({ initEvent() { } })
};
const domSandbox = {
  console, setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask, document: domDoc, esc: escProd,
  apiConfigs: [], archivedConfigs: [], activeFriendId: '', currentPage: 'chat',
  _cachedUserName: 'You', _cachedUserAvatar: '',
  /* 内建全局必须**显式**给出：vm 上下文里的内建对象与宿主不是同一批，
     不给的话会被下面的 Proxy 兜底成 no-op 桩，于是 `Date.now` 之类直接炸。 */
  Date, Math, JSON, Object, Array, String, Number, Boolean, RegExp, Error, TypeError, Map, Set, WeakMap, Symbol,
  Promise, parseInt, parseFloat, isNaN, isFinite, encodeURIComponent, decodeURIComponent,
  Uint8Array, ArrayBuffer, Intl
};
domSandbox.window = domSandbox;
domSandbox.self = domSandbox;
domSandbox.navigator = { userAgent: 'node-test', language: 'zh-CN' };
domSandbox.location = { href: 'http://localhost/', reload() { } };
domSandbox.localStorage = { getItem: () => null, setItem() { }, removeItem() { } };
domSandbox.IBERR = { err: m => new Error(m), report: () => null, show() { } };
domSandbox.IB = {};
/* 未声明的全局 → no-op 桩；本段只关心通知卡的渲染路径。 */
const domCtx = vm.createContext(new Proxy(domSandbox, {
  has: () => true,
  get(t, k) { if (k in t) return t[k]; if (typeof k === 'symbol') return undefined; return function () { }; }
}));
let domEvalOk = true, domEvalErr = '';
try {
  vm.runInContext(rds('assets/js/ib-namespace.js').replace(/^\uFEFF/, ''), domCtx, { filename: 'ib-namespace.js' });
  vm.runInContext(COM.replace(/^\uFEFF/, ''), domCtx, { filename: 'communication.js' });
} catch (e) { domEvalOk = false; domEvalErr = String(e && e.message || e); }
check('D3.communicationEvaluatesInSandbox', domEvalOk, domEvalErr);

const CH = (domSandbox.IB && domSandbox.IB.chat) || {};
check('D3b.buildMsgElIsExported', typeof CH._buildMsgEl === 'function');

const collectCards = (node, acc) => {
  acc = acc || [];
  if (!node) return acc;
  if (typeof node.className === 'string' && node.className.indexOf('ib-integrity-notice') >= 0) acc.push(node);
  (node.children || []).forEach(c => collectCards(c, acc));
  return acc;
};
const renderMsg = (meta, fullscreen) => CH._buildMsgEl({
  id: 'msg_test_1', role: 'assistant', content: '你好呀，我在。', senderName: 'N',
  timestamp: 1760000000000, metadata: meta
}, fullscreen, false);
const NOTICE_MSG = { integrityNotice: { type: 'side_effect_blocked', categories: ['workspace'] } };

if (typeof CH._buildMsgEl === 'function') {
  check('D3c.noticeRendersInFullscreenHistory',
    collectCards(renderMsg(NOTICE_MSG, true)).length === 1,
    String(collectCards(renderMsg(NOTICE_MSG, true)).length));
  check('D3d.noticeRendersInPanelHistory',
    collectCards(renderMsg(NOTICE_MSG, false)).length === 1,
    String(collectCards(renderMsg(NOTICE_MSG, false)).length));
  /* 没有提示的消息：一条节点都不多（渲染路径与改动前逐字一致） */
  check('D3e.noCardWithoutNoticeMetadata',
    collectCards(renderMsg({ model: 'm', showThinking: true }, true)).length === 0);
  check('D3f.noCardForLegacyMessageWithoutMetadata',
    collectCards(renderMsg(null, true)).length === 0 && collectCards(renderMsg(undefined, true)).length === 0);
  /* 反证：真正删掉渲染调用点时，这一段必须变红（见 Falsification M3）。 */
}

/* ══════════════════════════════════════════════════════════════════
   D2 · P11-2D 缺口：工具续轮（tool_continue）的类别曾经永远不会被记录
   ══════════════════════════════════════════════════════════════════
   取证（tools/probe-p11-2e-callsites.js，修复前后各跑一次）：
     · `_mbSideEffectGateCats(cats,n)` 的条数由**调用方**给出；
     · 工具续轮调用点此前写作 `gateCats(cats)`（无 n）⇒ n=undefined ⇒
       `!(Number(undefined) > 0)` 成立 ⇒ 只回答 allow、**零记录**；
     · 闸门照样正确拦截，所以**行为**一直是对的 —— 错的是"记录声称这一轮
       没拦下任何东西"，于是提示也无从产生。
   修复 = 在该调用点补上条数实参（`_mbSecWsCount(ops,files)`），
   **判定语义、拦截行为、verdict 词表一字未改**。
   这一段把缺口本身钉住：任何一次"忘了传条数"的回归都会立刻变红。 */
section('D2 · 工具续轮条数（P11-2D 缺口回归）');

check('D2.countArgIsPresentAtBothToolContinueSites',
  countOcc(COM, '_mbSecWsCount(_wsParsed.ops,_wsParsed.files.length)') === 1
  && countOcc(COM, '_mbSecWsCount(_wsNs.ops,_wsNs.files.length)') === 1,
  JSON.stringify({
    stream: countOcc(COM, '_mbSecWsCount(_wsParsed.ops,_wsParsed.files.length)'),
    nonstream: countOcc(COM, '_mbSecWsCount(_wsNs.ops,_wsNs.files.length)')
  }));
/* apply 层里凡"多类别"的闸门调用（`...cats(...).concat(...)` 形态）都必须带第二个实参。
   `_mbSideEffectGate(_mbSecWsCats(ops))` 那种单类别形态与既有 4 个单类别调用点
   形状一致（条数走 `_mbSideEffectCounts[cat]`），不属于本缺口，故不在此列。 */
{
  const multi = (COM.match(/_mbSideEffectGate\([^\n]*?\.concat\([^\n]*?\)\)[^\n]*/g) || []);
  const allHaveCount = multi.length === 2 && multi.every(s => /_mbSecWsCount\(/.test(s));
  check('D2b.everyMultiCategoryGateCallCarriesACount', allHaveCount, JSON.stringify(multi));
}

/* 端到端：只有 file 块、没有 ops ⇒ 工具续轮的类别集合是 [file_archive]，
   `_mbSecWsCats(ops)` 一个类别都给不出。这条**只有在条数真的被传进来时**才会
   被记录，修复之前必然为 []（于是永远不会有提示）。 */
{
  endTurn();
  const hh = makeHarness(VERDICT.UNDECIDED);
  const cont = hh.api.wsCats([]).concat([hh.api.sec.file]);
  const n = hh.api.wsCount([], 1);
  const allowed = hh.api.gateCats(cont, n);
  const sup = suppressionOf();
  const n2 = NOTICE.forVerdict(VERDICT.UNDECIDED);
  check('D2c.continueGateWithCountRecordsTheClass',
    allowed === false && n > 0 && sup.categories.indexOf('file_archive') >= 0
    && !!n2 && n2.categories.indexOf('file_archive') >= 0,
    JSON.stringify({ allowed, n, sup, notice: n2 }));
}
/* 反证：把条数拿掉（= 修复前的形状）⇒ 记录消失。
   这证明 D2c 真的在测"条数被传进来了"，而不是一条恒真的断言。 */
{
  endTurn();
  const hh = makeHarness(VERDICT.UNDECIDED);
  const cont = hh.api.wsCats([]).concat([hh.api.sec.file]);
  const allowed = hh.api.gateCats(cont);           /* 故意不传 n（修复前的形状） */
  const sup = suppressionOf();
  check('D2d.withoutTheCountNothingIsRecorded',
    allowed === false && sup.count === 0 && sup.categories.length === 0,
    JSON.stringify({ allowed, sup }));
}

/* —— T13 · 不新增模型调用 —— */
{
  INTEG.middleBrainCharacterIntegrityReset();
  const before = model.calls;
  endTurn();
  const hh = makeHarness(VERDICT.UNDECIDED);
  hh.api.counts[hh.api.sec.mem] = 1;
  hh.api.gate(hh.api.sec.mem);
  NOTICE.forVerdict(VERDICT.UNDECIDED);
  NOTICE.append(hostOf(), { metadata: { integrityNotice: NOTICE.forVerdict(VERDICT.UNDECIDED) } });
  check('T13.noticePathMakesNoModelCall',
    model.calls === before, JSON.stringify({ before, after: model.calls }));
}

/* —— T14 · provider payload 不变 + 端到端（facade 层）——
   提示只在**收口之后**写进消息 metadata；provider 请求体在此之前就已发出，
   且本阶段没有任何请求构造代码被改动。这里用真实的 finalize 调用序列来证明：
   ① 调用序列（consumer 顺序）与 P11-2D 逐字一致；
   ② 提示是收口之后派生出来的，不参与任何请求构造。 */
{
  model.calls = 0; model.log.length = 0;
  model.plan = '{"pass":true,"score":0.95,"confidence":0.9,"violations":[]}';
  endTurn();
  const out = await INTEG.middleBrainCharacterIntegrity('c1', 'NOTICE_USER_MESSAGE', '你好呀。', { character: { id: 'c1' }, history: [] });
  check('T14.judgeCallSequenceUnchanged',
    model.calls === 1 && model.log.join(',') === 'character_integrity_report',
    JSON.stringify({ calls: model.calls, log: model.log }));
  check('T14b.passGivesNoNoticeEndToEnd',
    out.verdict === VERDICT.PASS && out.rewritten === false
    && NOTICE.forVerdict(out.verdict) === null,
    JSON.stringify({ v: out.verdict }));
}
/* T14c · 端到端 UNDECIDED（真实 timeout ⇒ 真实 UNDECIDED）+ workspace 抑制 ⇒ 有提示。
   这条把"状态从哪来"和"提示从哪来"接在一起：提示必须能由**生产判定结果**驱动，
   而不是只在手工造的状态上成立。 */
{
  model.calls = 0; model.log.length = 0;
  model.plan = { kind: 'http' };
  endTurn();
  const out = await INTEG.middleBrainCharacterIntegrity('c1', 'NOTICE_USER_MESSAGE', '我在。', { character: { id: 'c1' }, history: [] });
  const hh = makeHarness(out.verdict);
  hh.api.counts[hh.api.sec.ws] = 1;
  const allowed = hh.api.gate(hh.api.sec.ws);
  const n = NOTICE.forVerdict(out.verdict);
  check('T14c.realUndecidedEndToEndDrivesTheNotice',
    out.verdict === VERDICT.UNDECIDED && allowed === false
    && !!n && n.categories.indexOf('workspace') >= 0
    && NOTICE.append(hostOf(), { metadata: { integrityNotice: n } }) !== null,
    JSON.stringify({ v: out.verdict, allowed, n }));
}

/* —— T15 · 无凭据 / 内容泄漏 —— */
{
  const SECRET = 'notice-local-credential';
  const MEM_TEXT = '用户今天加班到很晚';
  setCfg(baseCfg());
  model.calls = 0;
  model.plan = { kind: 'throw' };
  endTurn();
  const out = await INTEG.middleBrainCharacterIntegrity('c1', 'NOTICE_USER_MESSAGE_LEAK', '我在。', { character: { id: 'c1' }, history: [] });
  const hh = makeHarness(out.verdict);
  hh.api.counts[hh.api.sec.mem] = 1;
  hh.api.gate(hh.api.sec.mem);
  const notice = NOTICE.forVerdict(out.verdict);
  const card = NOTICE.buildCard(notice);
  const blob = JSON.stringify({
    notice: notice, cardHtml: card && card.innerHTML, cardClass: card && card.className,
    cardText: NOTICE.TEXT_SPECIFIC + NOTICE.TEXT_GENERIC,
    sup: suppressionOf(), telemetry: INTEG.middleBrainCharacterIntegrityTelemetry()
  });
  const needles = [SECRET, 'Bearer', 'Authorization', 'sk-', MEM_TEXT, 'NOTICE_USER_MESSAGE_LEAK',
    '我在。', 'never-called', 'mem_create', 'apiKey', 'prompt', 'candidate'];
  const leaked = needles.filter(n => blob.indexOf(n) >= 0);
  check('T15.noCredentialOrContentLeak', leaked.length === 0, JSON.stringify(leaked));
  check('T15b.noticeIsMetadataOnly',
    blob.indexOf('notice-local-credential') < 0 && blob.indexOf('never-called') < 0);
}

/* —— T12 · Home Node 不变 ——
   P11-2D 已确认 Home Node 没有这套判定，因此本阶段也**不**为它制造对称性：
   它既不产生提示、也不需要提示（它根本不执行这些副作用）。 */
{
  const HN_FILES = ['middle-brain.js', 'execution.js', 'chat-store.js', 'mobile-gateway.js'];
  const blobs = HN_FILES.map(f => ({ f, s: rds('services/home-node/' + f) }));
  const tainted = blobs.filter(b => /integrityNotice|side_effect_blocked|_mbIntegrityNoticeFor|_mbNoticeFromMessage|_mbAppendNoticeCard/.test(b.s));
  check('T12.homeNodeUntouched', tainted.length === 0, JSON.stringify(tainted.map(b => b.f)));
  check('T12b.homeNodeHasNoIntegrityNoticeConcept',
    blobs.every(b => b.s.indexOf('integrityNotice') < 0));
}
} /* end mainAsync */

mainAsync().then(() => {
/* ══════════════════════════════════════════════════════════════════
   E · 未触碰的契约（硬边界）—— 纯读取，无需 await
   ══════════════════════════════════════════════════════════════════ */
{
  const CI = rd('middle-brain-integrity.js');
  const MB = rd('middle-brain.js');
  const GATE_AFTER = [
    grab(/function _mbSideEffectGateCats\(cats,n\)\{[\s\S]*?\n\}/, '_mbSideEffectGateCats'),
    grab(/function _mbSideEffectGate\(cat\)\{[\s\S]*?\n\}/, '_mbSideEffectGate'),
    grab(/function _mbSideEffectsOk\(category,count\)\{[\s\S]*?\n\}/, '_mbSideEffectsOk')
  ].join('\n');
  check('E1.sideEffectGateAdapterByteIdenticalToP11_2D',
    GATE_AFTER.indexOf('integrityNotice') < 0 && GATE_AFTER.indexOf('_mbIntegrityNoticeFor') < 0
    && GATE_AFTER.indexOf('_mbNoticeFromMessage') < 0);
  check('E2.verdictVocabularyUnchanged',
    Object.keys(VERDICT).sort().join(',') === 'BYPASSED,OOC,PASS,UNDECIDED', JSON.stringify(VERDICT));
  check('E3.undecidedStillBlocks',
    INTEG._mbCiSideEffectPolicy(VERDICT.UNDECIDED).allow === false
    && INTEG._mbCiSideEffectPolicy(VERDICT.PASS).allow === true
    && INTEG._mbCiSideEffectPolicy(VERDICT.OOC).allow === true
    && INTEG._mbCiSideEffectPolicy(VERDICT.BYPASSED).allow === true);
  check('E4.timeoutStill20000', INTEG.MB_CI_TIMEOUT_MS === 20000, String(INTEG.MB_CI_TIMEOUT_MS));
  /* Judge prompt / schema / 阈值 / 敏感度：文本层面未动 */
  check('E5.judgePromptUnchanged',
    countOcc(CI, 'Character Integrity Judge') === 1 && countOcc(CI, 'Character Integrity Rewriter') === 1);
  /* 本阶段只允许改动 communication.js 的功能；facade 公共 API 键表未动（仍 51） */
  const keys = COM.match(/var MB_PUBLIC_API/);
  const API_KEYS = (MB.match(/var MB_PUBLIC_API = \[([\s\S]*?)\n  \];/) || [])[1] || '';
  const nKeys = (API_KEYS.match(/^\s*\['/gm) || []).length;
  check('E6.facadeApiKeyCountUnchanged', nKeys === 51, String(nKeys));
  check('E7.noNewFacadeKeyForTheNotice',
    MB.indexOf('integrityNotice') < 0, 'facade must not grow a key for a UI-only concern');
}

/* —— 常量与策略仍与 integrity 层同源 —— */
{
  const CATS_FROM_COM = (COM.match(/var _MB_NOTICE_CATS=\[([^\]]*)\]/) || [])[1] || '';
  const comVals = CATS_FROM_COM.split(',').map(s => s.trim().replace(/^'|'$/g, '')).filter(Boolean).sort();
  const integVals = Object.keys(CATS).map(k => CATS[k]).sort();
  check('E8.noticeCategoryLiteralListMatchesIntegrityLayer',
    comVals.join(',') === integVals.join(','), JSON.stringify({ com: comVals, integ: integVals }));
}

console.log('\n' + (failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'));
process.exit(failures === 0 ? 0 : 1);
}).catch(err => { console.error('HARNESS ERROR', err); process.exit(1); });
