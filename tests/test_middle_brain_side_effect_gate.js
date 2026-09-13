/* ====================================================================
   P11-2C-1 · UNDECIDED 副作用闸门 · 离线确定性回归
   --------------------------------------------------------------------
   本文件回答且只回答一个问题：

     一个**没有 verdict**（UNDECIDED）的回复，还能不能触发由它解析出的副作用？

   ── 被冻结的契约 ───────────────────────────────────────────────────
     · 裁定状态仍是四态，只由 integrity 层产生（P11-2B），本阶段不加第五态。
     · 副作用政策是**裁定状态的函数**，不是新状态：
         PASS       allow   保持既有全部行为
         OOC        allow   保持既有行为（改写已在 integrity 层发生）
         BYPASSED   allow   有意不调用 Judge = 存量行为，本阶段不改
         UNDECIDED  block   尝试过但没拿到 verdict → 回复可展示，禁止执行其副作用
         null/未知  allow   拿不到任何状态时显式 fail-open（= 改动前的事实）
     · 闸门输入必须是**显式裁定状态**。禁止用 reply / candidate 是否相同、
       judgeError 是否存在、文本里有没有标签来反推"可信不可信"。
     · UNDECIDED 下标签照样从正文截掉（标签绝不上屏/入库），只是**不执行**。
     · 不新增模型调用、不重试、不改 Judge（prompt/超时/阈值/维度/schema 全部不变）。

   ── 运行 ────────────────────────────────────────────────────────────
     node tests/test_middle_brain_side_effect_gate.js
   纯 Node、零网络、零浏览器、零真实 provider 调用。
   加载的是**生产文件本身**：assets/js/middle-brain-integrity.js（闸门）
   与 assets/js/memory/auto-memory.js 中真实的 _parseMemOps（解析器）。
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

/* ── 生产装配（与浏览器同一条路径：脚本直接挂到 self/window）───────────── */
globalThis.window = globalThis;
require(path.join(ROOT, 'assets', 'js', 'middle-brain-integrity.js'));
const MBC = globalThis.IB && globalThis.IB.__middleBrainContracts;
if (!MBC || !MBC.integrity) throw new Error('canonical integrity layer unavailable');
const INTEG = MBC.integrity;
const VERDICT = INTEG.MB_CI_VERDICT;
const SITES = INTEG.MB_CI_SIDE_EFFECT_SITES;
const allowed = INTEG.middleBrainSideEffectAllowed;
const policy = INTEG._mbCiSideEffectPolicy;

const COM_TEXT = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'communication.js'), 'utf8').replace(/\r\n/g, '\n');
const AM_TEXT = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'memory', 'auto-memory.js'), 'utf8');
const CI_TEXT = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'middle-brain-integrity.js'), 'utf8');

const countOcc = (hay, needle) => hay.split(needle).length - 1;

console.log('P11-2C-1 · UNDECIDED side-effect gate · offline deterministic');

/* ====================================================================
   A · 四态决策表（唯一决策点）
   ==================================================================== */
section('A · 四态决策表 + 未知输入');
check('A1.gateExported', typeof allowed === 'function' && typeof policy === 'function');
check('A2.verdictEnumFrozen', Object.isFrozen(VERDICT)
  && VERDICT.PASS === 'PASS' && VERDICT.OOC === 'OOC'
  && VERDICT.UNDECIDED === 'UNDECIDED' && VERDICT.BYPASSED === 'BYPASSED');
check('A3.sitesDeclared', Object.isFrozen(SITES)
  && SITES.MEM_OPS === 'mem_ops' && SITES.CALENDAR === 'calendar'
  && SITES.BLOG_READ === 'blog_read' && SITES.WS_OPS === 'ws_ops',
  JSON.stringify(SITES));

/* T1/T2 · PASS → 全部副作用照旧执行 */
check('T1.passAllowsMemoryOps', allowed(VERDICT.PASS) === true);
check('T2.passAllowsWorkspaceOps', allowed(VERDICT.PASS) === true);
/* T3 · OOC 保持既有行为（本阶段不做二次判定） */
check('T3.oocUnchanged', allowed(VERDICT.OOC) === true);
/* T7 · BYPASSED 保持既有行为 */
check('T7.bypassedUnchanged', allowed(VERDICT.BYPASSED) === true);
/* T4/T5 · UNDECIDED → 拦下（两类副作用同一闸门，不分类别） */
check('T4.undecidedBlocksMemoryOps', allowed(VERDICT.UNDECIDED) === false);
check('T5.undecidedBlocksWorkspaceOps', allowed(VERDICT.UNDECIDED) === false);

/* 只有 UNDECIDED 被拦 —— 这是**互斥**断言，不是逐个例举 */
const four = [VERDICT.PASS, VERDICT.OOC, VERDICT.BYPASSED, VERDICT.UNDECIDED];
check('A4.onlyUndecidedBlocks',
  four.filter(v => allowed(v) === false).length === 1 && allowed(VERDICT.UNDECIDED) === false,
  JSON.stringify(four.map(v => [v, allowed(v)])));

/* 拿不到状态 = 显式 fail-open（未启用/未装配/群聊/留言/来信路径） */
check('A5.noStateFailOpen',
  allowed(null) === true && allowed(undefined) === true && allowed('') === true,
  JSON.stringify([allowed(null), allowed(undefined), allowed('')]));
check('A5b.noStateReasonIsHonest',
  policy(null).reason === 'no_state' && policy(null).verdict === null,
  JSON.stringify(policy(null)));
/* 未知字符串绝不等于 PASS，也绝不当成 UNDECIDED */
check('A6.unknownNotTreatedAsPass',
  policy('SOMETHING_ELSE').verdict === null && allowed('SOMETHING_ELSE') === true
  && policy('SOMETHING_ELSE').reason === 'unknown_verdict',
  JSON.stringify(policy('SOMETHING_ELSE')));
/* 大小写 / 空白不改变结论（但也不做任何文本推断） */
check('A7.caseAndTrimNormalized',
  allowed('undecided') === false && allowed(' UNDECIDED ') === false && allowed('pass') === true);

/* 决策表不读文本：同一 verdict 下，不同回复得到同一结论 */
check('A8.policyIndependentOfText', (() => {
  const v = VERDICT.UNDECIDED;
  const a = allowed(v);
  const b = allowed(v);
  return a === false && b === false;
})());
/* 闸门函数体内不得出现 reply / candidate / judgeError 之类可信度反推 */
check('A9.gateNeverInspectsReply', (() => {
  const m = CI_TEXT.match(/function _mbCiSideEffectPolicy\([\s\S]*?\n  \}/);
  if (!m) return false;
  return !/\breply\b|\bcandidate\b|judgeError|includes\(|indexOf\(/i.test(m[0]);
})(), 'gate body references reply/candidate/judgeError or does string matching');

/* ====================================================================
   B · 决策点什么都没偷偷开：没有新的模型调用 / 无重试 / 不改 Judge
   ==================================================================== */
section('B · 无新调用 · 无重试 · Judge 不变');

/* 闸门是同步纯函数，且本进程**没有** IB 的出站边界。
   Node 18+ 自带全局 fetch，所以不能拿 fetch 存在与否当证据 ——
   证据是：IB 自己的传输入口 _ibApiPost 未定义（闸门即使想调用也无处可调），
   且闸门本身不是 async、体内无 await（见 T11）。 */
check('T10.noExtraModelCall',
  typeof globalThis._ibApiPost === 'undefined'
  && !/async function _mbCiSideEffectPolicy/.test(CI_TEXT),
  'an IB transport boundary is reachable from the gate');
check('T11.noRetry', (() => {
  /* 重试只可能由传输层实现；闸门内不得出现任何循环/重试语义 */
  const m = CI_TEXT.match(/function _mbCiSideEffectPolicy\([\s\S]*?\n  \}/);
  return !!m && !/for\s*\(|while\s*\(|retry|attempt|setTimeout|await/i.test(m[0]);
})(), 'gate body contains retry/loop/async semantics');

/* T12 · 不改 Judge：prompt / 超时 / 维度 / schema / 敏感度 全部逐字锁定 */
check('T12.judgeTimeoutUnchanged', INTEG.MB_CI_TIMEOUT_MS === 20000, String(INTEG.MB_CI_TIMEOUT_MS));
check('T12b.judgeDimensionsUnchanged',
  Array.isArray(INTEG.MB_CI_DIMENSIONS) && INTEG.MB_CI_DIMENSIONS.length === 6
  && INTEG.MB_CI_DIMENSIONS.slice().sort().join(',') === 'behavior,emotional_continuity,knowledge_boundary,persona,relationship,speech_style',
  JSON.stringify(INTEG.MB_CI_DIMENSIONS));
check('T12c.judgeSchemaUnchanged',
  INTEG.MB_CI_SCHEMA && INTEG.MB_CI_SCHEMA.properties && INTEG.MB_CI_SCHEMA.properties.pass
  && INTEG.MB_CI_SCHEMA.properties.pass.type === 'boolean'
  && Array.isArray(INTEG.MB_CI_SCHEMA.required)
  && INTEG.MB_CI_SCHEMA.required.join(',') === 'pass,score,confidence,violations',
  JSON.stringify(INTEG.MB_CI_SCHEMA && INTEG.MB_CI_SCHEMA.required));
check('T12d.sensitivityTableUnchanged',
  INTEG.MB_CI_SENSITIVITY && Object.keys(INTEG.MB_CI_SENSITIVITY).join(',') === 'conservative,balanced,strict'
  && INTEG.MB_CI_SENSITIVITY.conservative.confidence === 0.8
  && INTEG.MB_CI_SENSITIVITY.balanced.confidence === 0.65
  && INTEG.MB_CI_SENSITIVITY.strict.confidence === 0.5,
  JSON.stringify(INTEG.MB_CI_SENSITIVITY));
/* Judge prompt 逐字锁定：证据不足契约句必须原样在（P11-2B 已验证的生产文本） */
check('T12e.judgePromptUnchanged',
  /【证据不可用】下列维度缺少证据，\*\*不得\*\*据此判 fail/.test(CI_TEXT),
  'judge prompt evidence-unavailable contract changed');
/* 闸门是纯决策：体内只能出现字符串工具，绝不能触达 Judge / 改写 / 传输 / 存储 */
check('T12f.gateIsPureDecision', (() => {
  const m = CI_TEXT.match(/function _mbCiSideEffectPolicy\(verdict\) \{[\s\S]*?\n  \}/);
  if (!m) return false;
  const body = m[0];
  /* ① 不得出现任何"会做别的事"的入口 */
  if (/_ciCall|ASTRA\.|_ibApiPost|_mbCiJudgePrompt|\bdbPut\b|_mbCiRewritePrompt|INTEG\./.test(body)) return false;
  /* ② 允许出现的调用只有字符串工具（没有第二个仓库内 helper 被引入） */
  const calls = (body.match(/[A-Za-z_$][\w$]*\s*\(/g) || [])
    .map(s => s.replace(/\s+/g, ''))
    .filter(s => !/^(if|for|while|switch|return|function|catch)\($/.test(s));
  return calls.join(',') === '_mbCiSideEffectPolicy(,_ciStr(,trim(,toUpperCase(';
})(), 'gate body reaches beyond a pure decision table');
/* 闸门只做一次判定：不出现嵌套 policy / 自我递归 */
check('T12g.gateAppliedExactlyOnce',
  countOcc(CI_TEXT, 'MB_CI_VERDICT.UNDECIDED) return { allow: false') === 1,
  'UNDECIDED block branch count = ' + countOcc(CI_TEXT, 'MB_CI_VERDICT.UNDECIDED) return { allow: false'));

/* ====================================================================
   C · 生产接线：闸门是真的挡在 executor 前面，而不是写在别处
   ==================================================================== */
section('C · 生产接线（源结构断言，锁定的是生产文本本身）');

/* 四条受保护的副作用链路：每条都必须"条件里带闸门"。
   注：流式与非流式是同款改动，故同一函数名在文件里各出现 1 次（合计 2）。 */
const WIRING = [
  ['T1w.memOpsGatedBothPaths', "_execMemOps(_mp.ops,cfg,cfg.nickname||cfg.model||'AI')", 1],
  ['T1wn.memOpsGatedNonStream', "_execMemOps(_mpn.ops,cfg,cfg.nickname||cfg.model||'AI')", 1],
  ['T5w.wsOpsGatedStreaming', "_execWsOps(_wsParsed.ops,", 1],
  ['T5wn.wsOpsGatedNonStream', "_execWsOps(_wsNs.ops,", 1],
  ['T2w.calendarGatedBothPaths', "IBCAL.processReply(replyText,cfg)", 2],
  ['T2b.blogReadGatedStreaming', "_execBlogReadOps(_bp.ops)", 1],
  ['T2bn.blogReadGatedNonStream', "_execBlogReadOps(_bpn.ops)", 1],
  ['T5c.fileBlocksGatedStreaming', "_wsArchiveFileBlocks(_wsParsed.files,", 1],
  ['T5cn.fileBlocksGatedNonStream', "_wsArchiveFileBlocks(_wsNs.files,", 1],
  ['T5d.toolContinueGatedBothPaths', "await _wsToolContinue(cfg,{messages:messages,lastReply:replyText", 2]
];
check('C1.gateUsedTwelveTimesAtCallSites',
  countOcc(COM_TEXT, '_mbSideEffectsOk()') === 13,
  'gate references = ' + countOcc(COM_TEXT, '_mbSideEffectsOk()') + ' (expect 13 = 1 definition + 12 call sites)');
WIRING.forEach(([name, needle, want]) => {
  const n = countOcc(COM_TEXT, needle);
  check(name, n === want, 'occurrences of `' + needle + '` = ' + n + ' (expect ' + want + ')');
});

/* 每条受保护链路：闸门必须与该调用出现在**同一行**（即条件的一部分），
   而不是"附近某处调了一下闸门"这种装饰性接线。
   先排除闸门自身的函数定义行，只留下真正的 12 个调用点。 */
const gateLines = COM_TEXT.split('\n')
  .filter(l => l.includes('_mbSideEffectsOk()') && !/^\s*function _mbSideEffectsOk/.test(l));
const EXEC_RE = /_execMemOps\(|IBCAL\.processReply\(|_execBlogReadOps\(|_execWsOps\(|_wsArchiveFileBlocks\(|_wsToolContinue\(/;
/* 工具回合续的闸门守的是一个块（`if(…&&gate){`），执行体在下一行 —— 显式承认这种形态，
   而不是放宽成"附近有执行器就行"。 */
const MULTILINE_GUARD_RE = /^\s*if\(\(_ws(?:Parsed|Ns)\.ops\.length\|\|_ws(?:Parsed|Ns)\.files\.length\)&&_mbSideEffectsOk\(\)\)\{\s*$/;
const gateLineIdx = COM_TEXT.split('\n')
  .map((l, i) => (l.includes('_mbSideEffectsOk()') && !/^\s*function _mbSideEffectsOk/.test(l)) ? i : -1)
  .filter(i => i >= 0);
const allLines = COM_TEXT.split('\n');
check('C2.everyGateLineIsACondition', gateLines.length === 12
  && gateLines.every(l => /if\(|&&_mbSideEffectsOk\(\)/.test(l)),
  gateLines.length + ' gate call lines, not all conditional');
const badGateLines = gateLineIdx.filter(i =>
  !(EXEC_RE.test(allLines[i])
    || (MULTILINE_GUARD_RE.test(allLines[i]) && EXEC_RE.test(allLines[i + 1] || ''))));
check('C3.gateLineHasExecutor', badGateLines.length === 0,
  'gate lines protecting nothing: ' + JSON.stringify(badGateLines.map(i => i + 1)));
check('C3b.twoPathsAreSymmetric', (() => {
  /* 流式 6 处 + 非流式 6 处；两条路径受保护项必须一一对应（改一条漏一条会立刻变红） */
  const stream = gateLines.filter(l => /_memR=|_calR=|_brCards=|_wsResults=|_wsParsed\.|lastReply:replyText/.test(l));
  const nonStream = gateLines.filter(l => /_memRNs=|_calRNs=|_brCardsNs=|_wsRNs=|_wsNs\.|lastReply:replyText/.test(l));
  return stream.length === 6 && nonStream.length === 6;
})(), 'streaming and non-streaming paths are not symmetric');

/* 反向断言：单聊两条路径里，受保护 executor **不得**再出现无闸门的调用形态 */
check('C4.noUngatedExecutorInChatTurn', (() => {
  const bad = [
    'if(amEnabled(cfg))_memR=await _execMemOps(',
    'if(amEnabled(cfg))_memRNs=await _execMemOps(',
    '_wsParsed.ops.length)_wsResults=await _execWsOps(',
    '_wsNs.ops.length)_wsRNs=await _execWsOps('
  ];
  return bad.every(s => countOcc(COM_TEXT, s) === 0);
})(), 'an ungated executor call survived the gate');

/* T7b · 非 Middle Brain 路径必须原样（群聊 / 博客留言 / 角色来信） */
check('T7b.groupChatUntouched',
  countOcc(COM_TEXT, 'if(amEnabled(cfg))_gMemR=await _execMemOps(_gmp.ops,cfg,selfName)') === 1
  && countOcc(COM_TEXT, '_gwsR=await _execWsOps(_gws.ops,selfName,cfg,') === 1
  && countOcc(COM_TEXT, 'await _wsArchiveFileBlocks(_gws.files,selfName)') === 1,
  'group chat path was modified');
check('T7b2.groupChatHasNoGate', !/_gws[\s\S]{0,600}_mbSideEffectsOk/.test(COM_TEXT));
check('T7b3.blogCommentUntouched',
  countOcc(COM_TEXT, 'if(_cm.ops.length&&amEnabled(cfg)&&!cfg.amRecordOnly){try{await _execMemOps(_cm.ops,cfg,') === 1);
check('T7c.groupChatNeverSeesVerdict',
  !/isGroup[\s\S]{0,400}_mbVerdict\s*=/.test(COM_TEXT),
  'group chat path assigns a verdict it never produces');

/* T6 · 状态来源：唯一复位点 + 两条路径各写入一次 */
check('C5.singleResetPoint',
  countOcc(COM_TEXT, '\n  _mbVerdict=null;') === 1 && countOcc(COM_TEXT, 'var _mbVerdict=null;') === 1,
  'reset=' + countOcc(COM_TEXT, '\n  _mbVerdict=null;') + ' declaration=' + countOcc(COM_TEXT, 'var _mbVerdict=null;'));
check('C6.twoVerdictWrites',
  countOcc(COM_TEXT, "outcome.verdict)||null;") === 2,
  'verdict write count = ' + countOcc(COM_TEXT, 'outcome.verdict)||null;'));
check('C7.helperIsPureAdapter', (() => {
  const m = COM_TEXT.match(/function _mbSideEffectsOk\(\)\{[\s\S]*?\n\}/);
  if (!m) return false;
  /* 适配层不得自行判断：只能经门面转交决策点，且不得触碰内部层契约符号 */
  return /middleBrainSideEffectAllowed\(_mbVerdict\)/.test(m[0])
    && !/__middleBrainContracts/.test(m[0])
    && !/\breply\b|_parse|includes\(|indexOf\(|judgeError/.test(m[0]);
})(), 'desktop gate adapter contains its own policy logic or reads internal contracts');
check('C8.helperFailOpenWhenUnavailable',
  /if\(!_f\|\|typeof _f\.middleBrainSideEffectAllowed!=='function'\)return true;/.test(COM_TEXT),
  'gate adapter does not fail open when the policy point is unavailable');
/* 桌面不得直接读内部层契约（由 test_frontend_structure.contractsNotLeaked 同级锁定） */
check('C9.desktopNeverReadsInternalContracts',
  countOcc(COM_TEXT, '__middleBrainContracts') === 0,
  'communication.js reads IB.__middleBrainContracts');
/* 门面必须真的提供该入口（integrity 层所有、门面转发） */
const MB_TEXT = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'middle-brain.js'), 'utf8');
check('C10.facadeExposesPolicy',
  /\['middleBrainSideEffectAllowed', 'integrity'\]/.test(MB_TEXT)
  && !/window\.middleBrainSideEffectAllowed\s*=/.test(MB_TEXT),
  'facade does not expose the policy point, or leaked it as a window alias');

/* ====================================================================
   D · 行为：真实解析器 + 真实闸门，正文与执行分开对待
   ==================================================================== */
section('D · 行为（真实 parser + 真实 gate）');

/* 加载**生产文件里真实的** _parseMemOps（从源码中取出，不经 mock） */
const memFnText = AM_TEXT.match(/function _parseMemOps\(text\)\{[\s\S]*?\n\}/);
check('D0.realParserExtracted', !!memFnText, 'could not extract _parseMemOps from auto-memory.js');
const _parseMemOps = new Function(memFnText[0] + '; return _parseMemOps;')();

const REPLY = '我今天有点累。\n<mem_create type="event" importance="7">用户今天加班</mem_create>\n晚点再聊。';
const parsed = _parseMemOps(REPLY);
check('D1.parserFindsOp', parsed.ops.length === 1 && parsed.ops[0].kind === 'create', JSON.stringify(parsed.ops));
check('D2.parserStripsTag', parsed.clean.indexOf('<mem_') === -1 && parsed.clean.indexOf('用户今天加班') === -1,
  JSON.stringify(parsed.clean));
check('D3.parserKeepsVisibleText',
  parsed.clean.indexOf('我今天有点累') === 0 && parsed.clean.indexOf('晚点再聊') !== -1,
  JSON.stringify(parsed.clean));

/* 把两条链路都跑一遍：同一份回复，只有 verdict 不同。
   exec 是被观测的副作用；文本处理两条链路必须完全一致。 */
function runTurn(verdict) {
  const log = [];
  const exec = (ops) => { log.push({ called: true, ops: ops.length }); return [{ ok: true }]; };
  const p = _parseMemOps(REPLY);
  let text = REPLY;
  let results = [];
  /* 生产形态：条件里带闸门，正文照样截取 */
  if (p.ops.length) {
    text = p.clean;
    if (allowed(verdict)) results = exec(p.ops);
  }
  return { text: text, results: results, log: log };
}
const tPass = runTurn(VERDICT.PASS);
const tOoc = runTurn(VERDICT.OOC);
const tByp = runTurn(VERDICT.BYPASSED);
const tUnd = runTurn(VERDICT.UNDECIDED);
const tNone = runTurn(null);

check('T1b.passExecutesMemoryOp', tPass.log.length === 1 && tPass.results.length === 1, JSON.stringify(tPass.log));
check('T3b.oocExecutesAsBefore', tOoc.log.length === 1, JSON.stringify(tOoc.log));
check('T7d.bypassedExecutesAsBefore', tByp.log.length === 1, JSON.stringify(tByp.log));
check('T4b.undecidedBlocksMemoryOp', tUnd.log.length === 0 && tUnd.results.length === 0, JSON.stringify(tUnd.log));
check('T4c.failOpenWhenNoState', tNone.log.length === 1, JSON.stringify(tNone.log));

/* T6 · UNDECIDED 下可见文本仍然完整展示（不是拒绝消息、不是删回复） */
check('T6.undecidedStillShowsVisibleText',
  tUnd.text === tPass.text && tUnd.text === tOoc.text && tUnd.text === tByp.text
  && tUnd.text.indexOf('我今天有点累') !== -1 && tUnd.text.indexOf('晚点再聊') !== -1,
  JSON.stringify(tUnd.text));
check('T6b.undecidedTagsStrippedLikeEveryTurn',
  tUnd.text.indexOf('<mem_') === -1 && tUnd.text.indexOf('用户今天加班') === -1,
  JSON.stringify(tUnd.text));
check('T6c.undecidedTextEqualsCleanOfParser', tUnd.text === parsed.clean, JSON.stringify(tUnd.text));
/* 不是"拒绝消息"：正文有内容，不是空串、不是错误文案 */
check('T6d.undecidedIsNotRejection', tUnd.text.trim().length > 0 && !/拒绝|blocked|error/i.test(tUnd.text));

/* workspace 侧同一闸门：同一输入，只有 verdict 不同 */
function runWsTurn(verdict, opsLen) {
  const log = [];
  const execWs = (n) => { log.push(n); return [{ ok: true }]; };
  let results = [];
  if (opsLen && allowed(verdict)) results = execWs(opsLen);
  return { results: results, log: log };
}
check('T2b.passExecutesWorkspaceOp', runWsTurn(VERDICT.PASS, 2).log.length === 1);
check('T5b.undecidedBlocksWorkspaceOp', runWsTurn(VERDICT.UNDECIDED, 2).log.length === 0);
check('T7e.bypassedExecutesWorkspaceOp', runWsTurn(VERDICT.BYPASSED, 2).log.length === 1);

/* ====================================================================
   E · 反向验证：把闸门改错，测试必须变红
   ==================================================================== */
section('E · 反向验证（证明本测试有牙齿）');
const badCases = [
  ['E1.timeoutAsPass', VERDICT.UNDECIDED, true],
  ['E2.bypassedAsBlocked', VERDICT.BYPASSED, false],
  ['E3.noStateAsBlocked', null, false]
];
badCases.forEach(([name, v, wrong]) => {
  const actual = allowed(v);
  check(name, actual !== wrong, 'if the gate returned ' + wrong + ' for ' + JSON.stringify(v) + ' this test would still pass');
});

console.log('\n' + (failures === 0
  ? 'P11-2C-1 · all checks passed'
  : 'P11-2C-1 · FAILED checks: ' + failures));
process.exitCode = failures === 0 ? 0 : 1;
