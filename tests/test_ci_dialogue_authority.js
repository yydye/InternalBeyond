/* ====================================================================
   M1-C.2p · Character Integrity Dialogue Convergence
   --------------------------------------------------------------------
   这一条回答且只回答 M1-C.2p 的那一个问题：

     对同一个角色、同一份 canonical 对话状态、同一个当前用户回合，
     Character Integrity（OOC Guard）与 Middle Brain 是否消费**同一段语义权威
     的对话证据**？

   ── 被消灭的东西 ────────────────────────────────────────────────────
   本文件顶部逐字保留 pre-fix 的 `legacyCiHistory()`（M1-C.2p 之前
   assets/js/middle-brain-integrity.js:103-126 的 `_ciHistory`）。它是"第二个
   conversation projection"的**可执行定义**，只用于三件事：
     ① 证明现在的实现确实与它不同（不是把同一件事写了两遍）；
     ② 提供反证（同一批收敛断言在旧投影下必须 RED）；
     ③ 行为保持矩阵（before/after）的 before 一列。
   它不参与任何 parity 断言。

   ── 比较的边界（§6）──────────────────────────────────────────────────
   比较的是 canonical semantic boundary，不是最终字符串：
     · 同一批有序对话行（条数 / 顺序 / 角色 / 正文）
     · 同一个当前回合归属（原位 / 追加 / 不存在），且恰好一次
     · 同一条去重规则（身份优先，缺身份才用逐字原文回落）
     · 同一份 thread 隔离（只投影交给它的那些行）
   guard 的渲染（【最近对话】段 / 当前用户消息字段）与总量预算属于**消费策略**，
   允许不同，但必须发生在投影之后 —— 本文件对这条边界也有断言。

   ── 运行 ────────────────────────────────────────────────────────────
     node tests/test_ci_dialogue_authority.js
        主套件：结构唯一性 + 对抗用例 T1–T20 + 双宿主 parity + 行为保持矩阵
        + 对照证明（把旧投影装回临时副本，同一批断言必须变红）。
     node tests/test_ci_dialogue_authority.js --probe --root <dir>
        子模式：从 <dir> 加载生产文件，只跑收敛断言并打印 CI_CONVERGENCE=PASS|FAIL。
        主套件用它在"未变异副本（必须 PASS）"与"装回旧投影的副本（必须 FAIL）"
        上各跑一次 —— 同一批断言、同一份代码，差别只在那一处投影。
   纯 Node、零网络、零浏览器；只在系统临时目录里做副本，绝不改工作区。
   ==================================================================== */
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

let passed = 0, failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log('\u2714 ' + name); }
  else { failed++; console.error('\u2718 ' + name + (extra !== undefined ? ' \u2014 ' + JSON.stringify(extra) : '')); }
}
const tempDirs = [];
process.on('exit', () => {
  for (const dir of tempDirs) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* 句柄未释放 */ } }
});
function tempDir(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-ci2p-' + tag + '-'));
  tempDirs.push(dir);
  return dir;
}

/* ════════════════════════════════════════════════════════════════════
   pre-fix 参照物：逐字取自 M1-C.2p 之前的 assets/js/middle-brain-integrity.js
   （`_ciTextOf` + `_ciHistory`，行 103-126）。它就是"第二份对话投影"本身：
   自己的窗口（最近 8 条）、自己的单条上限（400 字）、自己的总量预算（2400 字）、
   自己的角色映射、自己的排序与截断，而且**完全不知道当前回合的存在**。
   ════════════════════════════════════════════════════════════════════ */
function legacyCiTextOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(function (p) { return p && typeof p.text === 'string' ? p.text : ''; }).filter(Boolean).join(' ');
  }
  return '';
}
function legacyCiHistory(history) {
  var out = [];
  if (!Array.isArray(history)) return out;
  for (var i = history.length - 1; i >= 0 && out.length < 8; i--) {
    var m = history[i]; if (!m || typeof m !== 'object') continue;
    var role = (m.role === 'assistant') ? 'assistant' : (m.role === 'user' ? 'user' : null);
    if (!role) continue;
    var text = legacyCiTextOf(m.content);
    if (!text || !text.trim()) continue;
    out.unshift({ role: role, text: text.length > 400 ? text.slice(0, 400) : text });
  }
  var total = 0;
  for (var j = 0; j < out.length; j++) total += out[j].text.length;
  while (out.length > 1 && total > 2400) { total -= out[0].text.length; out.shift(); }
  return out;
}
/* pre-fix 的可用性规则（同一个函数体里的那三行）：
   speech_style / emotional_continuity / behavior 都看**它自己那份投影的行数**。 */
function legacyAvailable(dialogueRows, persona, hasCtx) {
  return {
    persona: !!(persona.systemPrompt || persona.nickname || persona.bio),
    speech_style: !!(persona.systemPrompt || dialogueRows.length),
    relationship: !!persona.relationship,
    emotional_continuity: dialogueRows.length > 0,
    knowledge_boundary: hasCtx,
    behavior: !!(persona.systemPrompt || dialogueRows.length)
  };
}

/* ── 从 <root> 加载**生产**装配（主套件 = 工作区；--probe = 临时副本）──── */
const PROBE = process.argv.indexOf('--probe') >= 0;
const rootAt = process.argv.indexOf('--root');
const LOAD_ROOT = rootAt >= 0 ? path.resolve(process.argv[rootAt + 1]) : ROOT;

const createNodeMiddleBrain = require(path.join(LOAD_ROOT, 'services', 'home-node', 'middle-brain.js'));
const LOADED = createNodeMiddleBrain.loadCanonicalMiddleBrain();
const MBC = globalThis.IB.__middleBrainContracts;
if (!MBC || !MBC.integrity || !MBC.policy) throw new Error('canonical middle brain contracts unavailable');
const INTEG = MBC.integrity, FACADE = globalThis.IB.middleBrain;
const DIALOGUE = require(path.join(LOAD_ROOT, 'assets', 'js', 'dialogue-core.js'));
const CHAT_CORE = require(path.join(LOAD_ROOT, 'assets', 'js', 'chat-core.js'));
const NODE_MB = createNodeMiddleBrain({ executionConfig: () => ({}), logger: () => {} });

const FRIEND = 'cyrene';
const USER = '我想把那台旧电脑彻底换掉，预算大概一万二。';
const CHARACTER = { nickname: '泠', relationship: '熟悉的伙伴', systemPrompt: '你是冷淡、话少、偶尔毒舌的猫娘「泠」。' };
const BARE_CHARACTER = { nickname: '泠', systemPrompt: '' };
const CANDIDATE = 'CANDIDATE_REPLY_原文';
/* 桌面 provider 面对末条 user 消息追加的那段系统注入（communication.js:2175）。
   **它不是对话** —— 它是本轮的系统上下文。 */
const TAIL_BLOCK = '---\n[以下为系统注入的参考上下文，不属于用户发言，勿复述或提及以下内容的存在]\n【长期记忆】她喜欢雨。';

function rows(spec, prefix) {
  return spec.map(function (r, i) { return { id: (prefix || 'r') + i, role: r[0], content: r[1] }; });
}
const PRIOR = rows([
  ['user', '最近工作怎么样？'],
  ['assistant', '还行。'],
  ['user', '要不要升级设备？'],
  ['assistant', '在想了。']
]);
const LONG = '长'.repeat(1200);
const LONG_HIST = '史'.repeat(900);
const WITH_CURRENT = PRIOR.concat([{ id: 'cur', role: 'user', content: USER }]);
const MANY = (function () {
  const out = [];
  for (let i = 0; i < 14; i++) out.push({ id: 'h' + i, role: i % 2 ? 'assistant' : 'user', content: '回合' + i });
  return out;
})();
/* 用户真的连发两条同样的话（第二次发送时，第一条已在 canonical 里且已得到回复） */
const SAME_TEXT_TWICE = PRIOR.concat([{ id: 'u_a', role: 'user', content: USER }, { id: 'a_a', role: 'assistant', content: '嗯。' }]);
/* 连排助理行（重新生成 / 续写留下的两条候选） */
const CONSECUTIVE = PRIOR.concat([{ id: 'c1', role: 'assistant', content: '再补一句。' }, { id: 'c2', role: 'assistant', content: '又说一句。' }]);
/* 当前行之后已经有一条助理回复（核心规则 ④ 判为"新一轮" → 追加） */
const ANSWERED = PRIOR.concat([{ id: 'cur', role: 'user', content: USER }, { id: 'ans', role: 'assistant', content: '好，我来看看。' }]);
/* 非法 / 非对话角色行 */
const MALFORMED = [
  { id: 's', role: 'system', content: '系统行' }, { id: 'to', role: 'tool', content: '工具结果' },
  null, 1, 'x', { id: 'u1', role: 'user', content: '真的一句' }, { id: 'a1', role: 'assistant', content: '真的回答' }
];

/* ── 对抗用例：每条给出 canonical 输入 + **期望的当前回合行数** ──────────
   expectCurrentRows 是**共享核心的规则**（M1-C.2o 冻结），两个消费者都必须
   照着它走；CI 自己多一行 / 少一行都是本阶段要抓的回归。 */
function makeCases() {
  return [
    { id: 'T1', name: 'normal multi-turn（当前行已在窗口内）', history: WITH_CURRENT, userMessage: USER, currentId: 'cur', requestId: 'reqT1', ownership: 'in-window', expectCurrentRows: 1 },
    { id: 'T3', name: 'sync lag（当前行尚未进入窗口）', history: PRIOR.slice(), userMessage: USER, currentId: CHAT_CORE.messageIdFromRequest('reqT3'), requestId: 'reqT3', ownership: 'appended', expectCurrentRows: 1 },
    { id: 'T2', name: 'empty history + current', history: [], userMessage: USER, currentId: null, ownership: 'appended', expectCurrentRows: 1 },
    { id: 'T5', name: 'retry / replay same request（按身份识别）', history: WITH_CURRENT, userMessage: USER, currentId: 'cur', requestId: 'reqT5', ownership: 'in-window', expectCurrentRows: 1 },
    { id: 'T6', name: 'same text sent twice as two real turns', history: SAME_TEXT_TWICE, userMessage: USER, currentId: 'u_next', ownership: 'appended', expectCurrentRows: 2 },
    { id: 'T7', name: 'very long current message', history: WITH_CURRENT.slice(0, 4).concat([{ id: 'cur', role: 'user', content: LONG }]), userMessage: LONG, currentId: 'cur', ownership: 'in-window', expectCurrentRows: 1 },
    { id: 'T8', name: 'very long historical message', history: PRIOR.concat([{ id: 'big', role: 'assistant', content: LONG_HIST }]), userMessage: USER, currentId: null, ownership: 'appended', expectCurrentRows: 1 },
    { id: 'T9', name: 'history retrieval failure (null)', history: null, userMessage: USER, currentId: null, ownership: 'appended', expectCurrentRows: 1 },
    { id: 'T12', name: 'regenerated / consecutive assistant rows', history: CONSECUTIVE, userMessage: USER, currentId: null, ownership: 'appended', expectCurrentRows: 1 },
    { id: 'T13', name: 'malformed / non-chat roles', history: MALFORMED, userMessage: USER, currentId: null, ownership: 'appended', expectCurrentRows: 1 },
    { id: 'T11', name: 'long window boundary', history: MANY, userMessage: USER, currentId: CHAT_CORE.messageIdFromRequest('reqT11'), requestId: 'reqT11', ownership: 'appended', expectCurrentRows: 1 },
    { id: 'T12b', name: 'current row already answered（核心规则 ④ 判为新一轮）', history: ANSWERED, userMessage: USER, currentId: 'cur', ownership: 'appended', expectCurrentRows: 2 },
    { id: 'T14', name: 'no relationship configured（persona 极简）', history: PRIOR.slice(), userMessage: USER, currentId: null, ownership: 'appended', expectCurrentRows: 1, barePersona: true }
  ];
}

/* ── 两个宿主的**真实调用形状**（不是"看起来差不多"）──────────────────
   桌面（communication.js:2359 / :2438）：
     history = _cacheStableSlice(friendMsgs, keepCount) ← canonical 行，**带 id**
     currentId = userMsg.id                             ← 就地生成的 canonical 行 id
   Home Node（services/home-node/middle-brain.js finalizeReply）：
     history = request.history  ← canonical store 分页读取，**只保留 role+content**
     currentId = requestId 确定性推导出的 messageId（行里没有 id → 走逐字回落）
   MB 侧（communication.js:1485 / 适配层 organizeContext）：
     桌面 currentId = null；Home Node 用同一个推导 id。 */
function inputFor(host, def) {
  /* 非法行原样交给核心（它自己的谓词负责丢弃）—— 形状映射只负责字段投影。 */
  const shape = function (r) {
    if (!r || typeof r !== 'object') return r;
    return host === 'desktop'
      ? { id: r.id, role: r.role, content: r.content }
      : { role: r.role, content: r.content };
  };
  return {
    history: (def.history || []).map(shape),
    userMessage: def.userMessage,
    currentId: host === 'desktop'
      ? (def.currentId === undefined ? null : def.currentId)
      : (def.requestId ? CHAT_CORE.messageIdFromRequest(def.requestId) : null)
  };
}
function toLines(rowsArr) {
  return rowsArr.map(function (r) { return (r.role === 'assistant' ? DIALOGUE.ROLE_LABEL : DIALOGUE.USER_LABEL) + r.text; });
}
/* 带标签行 → 结构化行（共享核心 labelFor 的逆运算，与生产 _ciRowOfLine 同一语义）。
   测试侧需要它，是为了让"当前回合占几行"的判据在 MB 侧与 CI 侧**用同一个谓词**。 */
function toRows(lines) {
  return lines.map(function (l) {
    const s = String(l);
    if (s.indexOf(DIALOGUE.USER_LABEL) === 0) return { role: 'user', text: s.slice(DIALOGUE.USER_LABEL.length) };
    if (s.indexOf(DIALOGUE.ROLE_LABEL) === 0) return { role: 'assistant', text: s.slice(DIALOGUE.ROLE_LABEL.length) };
    return null;
  }).filter(Boolean);
}
/* MB 侧：两个宿主各自真正传给共享核心的那一行代码。 */
function mbLines(host, def) {
  const inp = inputFor(host, def);
  if (host === 'desktop') return DIALOGUE.lines({ history: inp.history, userMessage: inp.userMessage, currentId: null });
  return NODE_MB.dialogueFrom(inp.history, inp.userMessage, inp.currentId);
}
/* CI 侧：两个宿主各自真正传给 _mbCiBuildEvidence 的 opts。 */
function ciEvidence(host, def, character) {
  const inp = inputFor(host, def);
  return INTEG._mbCiBuildEvidence(FRIEND, inp.userMessage, {
    character: character || (def.barePersona ? BARE_CHARACTER : CHARACTER),
    history: inp.history, currentId: inp.currentId, contextSnapshot: null
  });
}
/* 当前回合在证据里占了几行。判据按**共享核心的投影形态**：窗口内的当前行沿用
   单条上限（M1-C.2o 冻结：只有被追加的那一行不截断），长消息因此以截断形态出现 ——
   这不是 CI 的截断规则，而是 canonical 投影的形态。 */
function currentRowCount(rowsArr, userMessage) {
  const full = String(userMessage == null ? '' : userMessage);
  return rowsArr.filter(function (r) {
    if (r.role !== 'user') return false;
    if (r.text === full) return true;
    return full.length > r.text.length && r.text.length === DIALOGUE.HISTORY_MAX_CHARS
      && full.slice(0, r.text.length) === r.text;
  }).length;
}

/* ── 收敛断言：probe 子模式与主套件**共用同一批**（这是反证成立的前提）── */
function convergenceResults() {
  const out = [];
  const push = (name, ok, detail) => out.push({ name: name, ok: !!ok, detail: detail });
  for (const host of ['desktop', 'node']) {
    for (const def of makeCases()) {
      const mb = mbLines(host, def);
      const ev = ciEvidence(host, def);
      const ci = toLines(ev.dialogue);
      const tag = def.id + '.' + host;
      const here = currentRowCount(ev.dialogue, def.userMessage);
      const mbHere = currentRowCount(toRows(mb), def.userMessage);
      /* P1 同一批有序行 / 同一角色 / 同一正文（canonical semantic boundary） */
      push(tag + '.sameRows', JSON.stringify(ci) === JSON.stringify(mb), { ci: ci, mb: mb });
      /* P2 当前回合归属：行数与 MB 完全一致，且等于共享核心规则的期望值 */
      push(tag + '.currentOwnershipMatchesMb', here === mbHere, { ci: here, mb: mbHere });
      push(tag + '.currentTurnRowsAsCoreRules', here === def.expectCurrentRows, { got: here, want: def.expectCurrentRows });
      push(tag + '.currentTurnPresent', here >= 1, here);
      /* P3 角色白名单：证据里只有 user / assistant */
      push(tag + '.rolesAreChatOnly', ev.dialogue.every(r => r.role === 'user' || r.role === 'assistant'), ev.dialogue.map(r => r.role));
      /* P4 归属元信息与行数自洽（当前回合要么原位、要么追加，没有第三种） */
      push(tag + '.metaConsistent',
        ev.dialogue.length === ev.dialogueMeta.historyCount + (ev.dialogueMeta.currentIncluded ? 1 : 0)
        && (ev.dialogueMeta.currentIncluded !== (ev.dialogueMeta.currentSkipped === 'duplicate')),
        { rows: ev.dialogue.length, meta: ev.dialogueMeta });
      /* P5 窗口不变式：历史上限 8（不含追加的当前回合） */
      push(tag + '.windowInvariant',
        ev.dialogueMeta.historyCount <= DIALOGUE.HISTORY_MAX_MESSAGES
        && ev.dialogue.length <= DIALOGUE.HISTORY_MAX_MESSAGES + 1,
        { rows: ev.dialogue.length, meta: ev.dialogueMeta });
      /* P6 投影必须真的来自共享核心（不是"恰好也长这样"） */
      push(tag + '.projectionFromSharedCore', ev.dialogueMeta.source === 'dialogue-core', ev.dialogueMeta.source);
      /* P7 单条历史行上限来自共享核心（guard 不再持有第二套常量） */
      push(tag + '.historyRowCapFromCore',
        ev.dialogue.filter(r => currentRowCount([r], def.userMessage) === 0)
          .every(r => r.text.length <= DIALOGUE.HISTORY_MAX_CHARS),
        ev.dialogue.map(r => r.text.length));
      /* P8 同一份 canonical 行 → 两个宿主给出同一份证据（T19） */
      const other = host === 'desktop' ? 'node' : 'desktop';
      push(tag + '.crossHostIdentical',
        JSON.stringify(ev.dialogue) === JSON.stringify(ciEvidence(other, def).dialogue),
        { host: host, other: other });
    }
  }
  return out;
}
function printResults(results) {
  for (const r of results) {
    if (!r.ok) console.error('\u2718 ' + r.name + (r.detail !== undefined ? ' \u2014 ' + JSON.stringify(r.detail) : ''));
  }
}

/* ════════════════════════════════════════════════════════════════════
   probe 子模式
   ════════════════════════════════════════════════════════════════════ */
if (PROBE) {
  const results = convergenceResults();
  printResults(results);
  const bad = results.filter(r => !r.ok);
  console.log('probe root: ' + LOAD_ROOT);
  console.log('CI_CONVERGENCE=' + (bad.length ? 'FAIL' : 'PASS') + ' (' + (results.length - bad.length) + '/' + results.length + ')');
  process.exitCode = 0;
} else {
  main();
}

/* ════════════════════════════════════════════════════════════════════ */
function main() {
  console.log('M1-C.2p · Character Integrity Dialogue Convergence\n');

  const ciSrc = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'middle-brain-integrity.js'), 'utf8');
  const comSrc = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'communication.js'), 'utf8');
  const nodeSrc = fs.readFileSync(path.join(ROOT, 'services', 'home-node', 'middle-brain.js'), 'utf8');
  const coreSrc = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'dialogue-core.js'), 'utf8');
  const htmlSrc = fs.readFileSync(path.join(ROOT, 'InternalBeyond.html'), 'utf8');

  /* ══ A. pre-fix path / 唯一实现（结构）═══════════════════════════════ */
  check('A1.noPrivateProjectionInCi', !/function _ciHistory\s*\(/.test(ciSrc) && !/_ciTextOf\s*\(/.test(ciSrc),
    'Character Integrity 里仍存在宿主私有的对话投影');
  check('A2.ciConsumesSharedCore', /IBDialogueCore/.test(ciSrc) && /core\.assemble\(\{\s*history/.test(ciSrc));
  check('A3.noSecondCapConstantsInCi',
    !/var\s+\w*(HISTORY_MAX|MAX_MESSAGES|MAX_CHARS)/.test(ciSrc)
    && (ciSrc.match(/CI_DIALOGUE_TOTAL_CHARS\s*=\s*(\d+)/) || [])[1] === '2400',
    'Character Integrity 里出现了第二套窗口/单条上限常量');
  check('A4.noHardcodedRowCapInCi', !/slice\(0,\s*400\)/.test(ciSrc), 'Character Integrity 里仍有硬编码的 400 字截断');
  check('A5.desktopPassesCanonicalSlice', (comSrc.match(/history:history,currentId:userMsg\.id/g) || []).length === 2,
    '桌面两个收口调用点没有同时交 canonical 对话切片 + 当前回合身份');
  /* A6 只看**生成后收口块**（P11-2 的两处调用点）：群聊路径里的
     `history:messages` 是 buildChatContext 的入参，不属于本阶段边界。 */
  const hookBlocks = (comSrc.match(/P11-2 · Middle Brain 生成后收口[\s\S]*?finalize failed'[^\n]*\n/g) || []);
  check('A6.desktopNoLongerPassesProviderArray', hookBlocks.length === 2
    && hookBlocks.every(b => b.indexOf('history:messages') < 0 && /history:history,currentId:userMsg\.id/.test(b)),
    '桌面仍在把 provider 请求数组当成对话证据交给 guard: blocks=' + hookBlocks.length);
  check('A7.homeNodeForwardsCanonicalInput',
    /history: Array\.isArray\(turn\.history\) \? turn\.history : \[\]/.test(nodeSrc)
    && /currentId: \(turn\.currentMessageId == null/.test(nodeSrc),
    'Home Node 适配层没有如实转交 canonical 历史 + 当前回合身份');
  check('A8.homeNodeRegistersSharedCoreGlobal',
    /globalThis\.IBDialogueCore = DIALOGUE/.test(nodeSrc) && !/globalThis\.IBDialogueCore = require\(/.test(nodeSrc),
    'Node 侧没有把共享核心登记成 guard 能读到的全局别名（会静默降级成无对话证据）');
  check('A9.scriptOrderCoreBeforeIntegrity',
    htmlSrc.indexOf('assets/js/dialogue-core.js') >= 0
    && htmlSrc.indexOf('assets/js/dialogue-core.js') < htmlSrc.indexOf('assets/js/middle-brain-integrity.js'),
    '浏览器侧共享核心没有在 guard 之前加载');
  check('A10.shimIsSameInstanceNotSecondImpl', globalThis.IBDialogueCore === DIALOGUE,
    '适配层登记的全局别名不是同一份模块实例（等于第二份实现）');
  check('A11.singleSourceOfWindowConstants',
    DIALOGUE.HISTORY_MAX_MESSAGES === 8 && DIALOGUE.HISTORY_MAX_CHARS === 400
    && !/=\s*8\s*;/.test(coreSrc.slice(0, coreSrc.indexOf('HISTORY_MAX_MESSAGES')) + 'x'),
    { m: DIALOGUE.HISTORY_MAX_MESSAGES, c: DIALOGUE.HISTORY_MAX_CHARS });

  /* ══ B. 全仓搜索：还有没有第二/第三个对话投影？═══════════════════════
     判据是结构而不是词表：把注释剥离之后，**带引号的行标签**（"用户：" / "角色："）
     与 `_ciHistory` 只允许出现在两个文件里 —— 共享核心（标签与上限的唯一定义）
     和 guard 的渲染器；上限常量的**声明**只允许在共享核心。 */
  const scan = scanProduction();
  check('B1.dialogueLabelsOnlyInCoreAndGuard',
    JSON.stringify(scan.labels) === JSON.stringify(['assets/js/dialogue-core.js', 'assets/js/middle-brain-integrity.js']),
    scan.labels);
  check('B2.noLegacyProjectionAnywhere', scan.legacy.length === 0, scan.legacy);
  check('B3.capConstantsDeclaredOnlyInCore', JSON.stringify(scan.capDecls) === JSON.stringify(['assets/js/dialogue-core.js']), scan.capDecls);
  check('B4.otherSubsystemsNotRewiredToCore',
    scan.coreRefs.every(rel => /^assets\/js\/(dialogue-core|middle-brain)/.test(rel) || rel === 'services/home-node/middle-brain.js'),
    scan.coreRefs);

  /* ══ C. 收敛断言（与 probe 子模式同一批）═══════════════════════════ */
  const results = convergenceResults();
  printResults(results);
  const groupPass = results.filter(r => r.ok).length;
  check('C.convergenceAllGreen', groupPass === results.length, { pass: groupPass, total: results.length });
  const perCase = {};
  for (const r of results) { const k = r.name.split('.')[0]; perCase[k] = (perCase[k] || 0) + (r.ok ? 1 : 0); }
  console.log('  cases green: ' + Object.keys(perCase).sort().map(k => k + '=' + perCase[k]).join(' ') +
    '  (assertions=' + results.length + ')');

  /* ══ D. 当前回合归属 / 去重 / 重放（逐条显式）═══════════════════════ */
  const dOwn = ciEvidence('desktop', { history: WITH_CURRENT, userMessage: USER, currentId: 'cur' });
  check('D1.identityDedupeInWindow',
    dOwn.dialogueMeta.currentSkipped === 'duplicate' && dOwn.dialogueMeta.currentIncluded === false
    && currentRowCount(dOwn.dialogue, USER) === 1, dOwn.dialogueMeta);
  const dLag = ciEvidence('desktop', { history: PRIOR.slice(), userMessage: USER, currentId: 'not-there' });
  check('D2.appendsWhenNotInWindow',
    dLag.dialogueMeta.currentIncluded === true && dLag.dialogueMeta.currentSkipped === null
    && dLag.dialogue[dLag.dialogue.length - 1].text === USER, dLag.dialogueMeta);
  /* 身份优先：同一份输入给出 id 时按身份判定（缺身份才走逐字原文回落） */
  const dNoId = ciEvidence('node', { history: WITH_CURRENT, userMessage: USER, requestId: 'reqX' });
  const dWithId = ciEvidence('desktop', { history: WITH_CURRENT, userMessage: USER, currentId: 'cur' });
  check('D3.identityAndTextFallbackAgreeOnTheSameRow',
    dNoId.dialogueMeta.currentSkipped === 'duplicate' && dWithId.dialogueMeta.currentSkipped === 'duplicate'
    && JSON.stringify(dNoId.dialogue) === JSON.stringify(dWithId.dialogue), { node: dNoId.dialogueMeta, desktop: dWithId.dialogueMeta });
  /* 当前消息为空（语音消息落盘的 content 是空串）：不得凭空造出一条用户发言 */
  const dEmpty = ciEvidence('desktop', { history: PRIOR.slice(), userMessage: '', currentId: 'x' });
  check('D4.blankCurrentTurnNotSynthesised',
    dEmpty.dialogueMeta.currentIncluded === false && dEmpty.dialogueMeta.currentSkipped === null
    && dEmpty.dialogue.length === PRIOR.length, dEmpty.dialogueMeta);
  const replayA = ciEvidence('node', { history: WITH_CURRENT, userMessage: USER, requestId: 'reqX' });
  const replayB = ciEvidence('node', { history: WITH_CURRENT, userMessage: USER, requestId: 'reqX' });
  check('D5.replayStable', JSON.stringify(replayA.dialogue) === JSON.stringify(replayB.dialogue));
  const dTwice = ciEvidence('desktop', { history: SAME_TEXT_TWICE, userMessage: USER, currentId: 'u_next' });
  check('D6.sameTextTwiceBothKept', currentRowCount(dTwice.dialogue, USER) === 2
    && toLines(dTwice.dialogue).filter(l => l === DIALOGUE.USER_LABEL + USER).length === 2, dTwice.dialogue);
  /* thread 隔离：证据只可能来自交给它的那一批行 */
  const otherThread = rows([['user', '另一个会话的开场'], ['assistant', '另一个会话的回应']], 'ot');
  const dThread = ciEvidence('desktop', { history: PRIOR.slice(), userMessage: USER, currentId: null });
  check('D7.threadIsolationOnlyProjectsGivenRows',
    dThread.dialogue.every(r => r.text.indexOf('另一个会话') < 0)
    && toLines(ciEvidence('desktop', { history: otherThread, userMessage: USER, currentId: null }).dialogue)
      .every(l => l.indexOf('另一个会话') >= 0 || l === DIALOGUE.USER_LABEL + USER),
    dThread.dialogue);

  /* ══ E. guard 消费预算发生在投影之后（不是 evidence selection）══════ */
  const fat = [];
  for (let i = 0; i < 8; i++) fat.push({ id: 'f' + i, role: i % 2 ? 'assistant' : 'user', content: ('很长的历史行' + i).repeat(60) });
  const fatCurrent = fat.concat([{ id: 'cur', role: 'user', content: '这一句是当前回合' }]);
  const dFat = ciEvidence('desktop', { history: fatCurrent, userMessage: '这一句是当前回合', currentId: 'cur' });
  const coreFat = DIALOGUE.assemble({ history: fatCurrent, userMessage: '这一句是当前回合', currentId: 'cur' });
  check('E1.budgetDropsOldestNotCurrent',
    dFat.dialogueMeta.budgetDropped > 0 && dFat.dialogue[dFat.dialogue.length - 1].text === '这一句是当前回合'
    && dFat.dialogueMeta.historyCount + dFat.dialogueMeta.budgetDropped === coreFat.historyCount,
    { meta: dFat.dialogueMeta, core: coreFat.historyCount });
  check('E2.budgetIsGuardPolicyAfterProjection',
    /CI_DIALOGUE_TOTAL_CHARS/.test(ciSrc) && !/CI_DIALOGUE_TOTAL_CHARS/.test(coreSrc),
    'guard 预算不是 guard 侧策略（或污染了共享核心）');
  check('E3.coreSeesUnbudgetedRows',
    coreFat.lines.length === dFat.dialogue.length + dFat.dialogueMeta.budgetDropped,
    { core: coreFat.lines.length, guard: dFat.dialogue.length, dropped: dFat.dialogueMeta.budgetDropped });

  /* ══ F. 渲染边界：guard 的【最近对话】段 = canonical 行 ══════════════ */
  const evR = ciEvidence('desktop', { history: WITH_CURRENT, userMessage: USER, currentId: 'cur' });
  const rendered = toLines(evR.dialogue).join('\n');
  const prompt = INTEG._mbCiJudgePrompt(evR, CANDIDATE);
  check('F1.dialogueBlockIsCanonicalRows',
    prompt.indexOf('【最近对话】\n' + rendered) >= 0,
    prompt.slice(prompt.indexOf('【最近对话】'), prompt.indexOf('【最近对话】') + 160));
  check('F2.currentUserMessageFieldKept',
    prompt.indexOf('【当前用户消息】\n' + USER) >= 0 && prompt.indexOf(CANDIDATE) > prompt.indexOf('【当前用户消息】'));

  /* ══ G. T20 · 旧投影的反例（真实生产形状）══════════════════════════
     桌面把 provider 请求数组交给 guard 时，末条 user 行带着**系统注入的上下文块**。
     旧投影原样投影它 → guard 的【最近对话】里出现"用户说了那段系统上下文"。
     这是被修掉的 bug（分类 A），不是记法差异。 */
  const providerShaped = [{ role: 'system', content: '系统提示词' }];
  for (const r of WITH_CURRENT) providerShaped.push({ role: r.role, content: r.content });
  providerShaped[providerShaped.length - 1] = { role: 'user', content: USER + '\n\n' + TAIL_BLOCK };
  const legacyEv = legacyCiHistory(providerShaped);
  const legacyPrompt = INTEG._mbCiJudgePrompt({
    persona: evR.persona, userMessage: evR.userMessage, dialogue: legacyEv, context: evR.context, available: evR.available
  }, CANDIDATE);
  check('G1.legacyLeaksInjectedContextAsUserSpeech',
    legacyEv.some(r => r.text.indexOf('[以下为系统注入的参考上下文') >= 0), legacyEv.map(r => r.text.slice(0, 40)));
  check('G2.convergedPromptHasNoInjectedContext',
    prompt.indexOf('[以下为系统注入的参考上下文') < 0 && prompt.indexOf('【长期记忆】她喜欢雨。') < 0,
    '收敛后的 guard 仍能看到被注入的系统上下文');
  check('G3.legacyPromptLeaksItIntoJudgeBlock', legacyPrompt.indexOf('[以下为系统注入的参考上下文') >= 0,
    'pre-fix 参照物没有复现泄漏（本条没有鉴别力）');
  /* 分类 A 的第二面：旧投影对**它输入里的**当前回合按 400 字截断。
     共享核心在这条语义上的规则是逐条明确的（M1-C.2o 冻结，两端逐字相同）：
       · 当前回合由它**追加**（不在窗口里）→ 绝不截断（规则 ②）；
       · 当前回合**已在窗口里** → 按历史行的单条上限截断（规则 ③ 的统一 cap）。
     CI 必须逐字继承这两条，而不是自己再定一套。 */
  check('G4.legacyTruncatedCurrentTurnAndCoreRulesInherited', (() => {
    const legacyLong = legacyCiHistory([{ role: 'system', content: 's' }, { role: 'user', content: LONG }]);
    const coreAppended = DIALOGUE.lines({ history: [], userMessage: LONG, currentId: null });
    const coreInWindow = DIALOGUE.lines({ history: [{ id: 'cur', role: 'user', content: LONG }], userMessage: LONG, currentId: 'cur' });
    const ciAppended = toLines(ciEvidence('desktop', { history: [], userMessage: LONG, currentId: null }).dialogue);
    return legacyLong[0].text.length === 400
      && coreAppended[0] === DIALOGUE.USER_LABEL + LONG
      && coreInWindow[0] === DIALOGUE.USER_LABEL + LONG.slice(0, DIALOGUE.HISTORY_MAX_CHARS)
      && ciAppended[0] === DIALOGUE.USER_LABEL + LONG;
  })(), 'CI 没有逐字继承共享核心对当前回合的截断规则');
  check('G5.legacyOmitsCurrentTurnWhenSyncLags',
    legacyCiHistory(PRIOR.map(function (r) { return { role: r.role, content: r.content }; })).length === PRIOR.length
    && currentRowCount(ciEvidence('desktop', { history: PRIOR.slice(), userMessage: USER, currentId: 'x' }).dialogue, USER) === 1);

  /* ══ H. 行为保持矩阵（before / after + 分类）════════════════════════
     逐行对比 pre-fix 与 converged 在同一份 canonical 状态上的证据与可用性。
     允许继续的只有：A = 旧投影 bug 被修复后的正确变化，B = 测试 mock 不忠实。
     C（真回归）必须修，D（有意的策略差异）必须停下来单独决策。 */
  const matrix = [];
  for (const def of makeCases()) {
    const inp = inputFor('desktop', def);
    const beforeRows = legacyCiHistory(providerShapedFrom(inp, def));
    const persona = def.barePersona ? BARE_CHARACTER : CHARACTER;
    const beforeAvail = legacyAvailable(beforeRows, {
      nickname: persona.nickname || '', relationship: persona.relationship || '', bio: '', systemPrompt: persona.systemPrompt || ''
    }, false);
    const after = ciEvidence('desktop', def);
    const afterAvail = after.available;
    const dialogueChanged = JSON.stringify(beforeRows.map(r => r.text)) !== JSON.stringify(after.dialogue.map(r => r.text));
    const availabilityChanged = beforeAvail.emotional_continuity !== afterAvail.emotional_continuity
      || beforeAvail.speech_style !== afterAvail.speech_style || beforeAvail.behavior !== afterAvail.behavior;
    matrix.push({
      id: def.id, dialogueChanged: dialogueChanged,
      beforeRowsLength: beforeRows.length, afterPriorRows: after.dialogueMeta.priorRows,
      beforeEmotional: beforeAvail.emotional_continuity, afterEmotional: afterAvail.emotional_continuity,
      beforeSpeech: beforeAvail.speech_style, afterSpeech: afterAvail.speech_style,
      beforeBehavior: beforeAvail.behavior, afterBehavior: afterAvail.behavior,
      beforePersona: beforeAvail.persona, afterPersona: afterAvail.persona,
      beforeRelationship: beforeAvail.relationship, afterRelationship: afterAvail.relationship,
      beforeKnowledge: beforeAvail.knowledge_boundary, afterKnowledge: afterAvail.knowledge_boundary,
      cls: (!dialogueChanged && !availabilityChanged) ? 'same' : 'A'
    });
  }
  check('H1.personaAvailabilityUnchanged', matrix.every(m => m.beforePersona === m.afterPersona));
  check('H2.relationshipAvailabilityUnchanged', matrix.every(m => m.beforeRelationship === m.afterRelationship));
  check('H3.knowledgeAvailabilityUnchanged', matrix.every(m => m.beforeKnowledge === m.afterKnowledge));
  check('H4.contextPathUntouched', /POL\._mbSnapshotCtx\(opts, name\)/.test(ciSrc)
    && /\['memory', 'understanding', 'thread', 'moments'\]\.forEach/.test(ciSrc));
  const loosened = matrix.filter(m => !m.beforeEmotional && m.afterEmotional);
  const tightened = matrix.filter(m => m.beforeEmotional && !m.afterEmotional);
  check('H5.noDimensionLoosened', loosened.length === 0, loosened.map(m => m.id));
  /* 收紧**只**允许出现在"旧投影的行里只有当前回合"这一种情形 —— 那正是旧投影
     把用户刚说的话当成前序对话（她自己的说话样本 / 情感连续性证据）的 bug。 */
  check('H6.tighteningOnlyWhereLegacyCountedCurrentTurnAlone',
    tightened.length > 0 && tightened.every(m => m.beforeRowsLength === 1 && m.afterPriorRows === 0),
    tightened.map(m => ({ id: m.id, before: m.beforeRowsLength, afterPrior: m.afterPriorRows })));
  console.log('  matrix dialogueChanged: ' + (matrix.filter(m => m.dialogueChanged).map(m => m.id).join(', ') || '(none)'));
  console.log('  matrix tightened: ' + (tightened.map(m => m.id).join(', ') || '(none)') +
    ' | loosened: ' + (loosened.map(m => m.id).join(', ') || '(none)'));
  for (const m of matrix) {
    console.log('    ' + m.id.padEnd(5) + ' dialogue:' + (m.dialogueChanged ? 'CHANGED' : 'same   ') +
      '  emotional_continuity:' + (m.beforeEmotional ? 'T' : 'F') + '->' + (m.afterEmotional ? 'T' : 'F') +
      '  speech_style:' + (m.beforeSpeech ? 'T' : 'F') + '->' + (m.afterSpeech ? 'T' : 'F') +
      '  behavior:' + (m.beforeBehavior ? 'T' : 'F') + '->' + (m.afterBehavior ? 'T' : 'F') +
      '  class=' + m.cls);
  }

  /* ══ I. 阈值 / gate / 维度 / prompt 契约未被本阶段改动 ═════════════ */
  check('I1.thresholdsFrozen', /conservative: \{ confidence: 0\.80, score: 0\.35, severity: 0\.85, failBelow: 0\.50 \}/.test(ciSrc)
    && /balanced: \{ confidence: 0\.65, score: 0\.45, severity: 0\.70, failBelow: 0\.60 \}/.test(ciSrc)
    && /strict: \{ confidence: 0\.50, score: 0\.55, severity: 0\.60, failBelow: 0\.70 \}/.test(ciSrc));
  check('I2.dimensionsFrozen', /var MB_CI_DIMENSIONS = \['persona', 'speech_style', 'relationship', 'emotional_continuity', 'knowledge_boundary', 'behavior'\]/.test(ciSrc));
  check('I3.gateOrderFrozen', (() => {
    const g = ciSrc.slice(ciSrc.indexOf('function _mbCiGate'), ciSrc.indexOf('/* —— Prompt 构建 —— */'));
    const order = ['no_report', 'judge_pass', 'rewrite_disabled', 'rewrite_already_used',
      'control_tags_present', 'low_confidence', 'score_above_threshold', 'severity_below_threshold', 'strong_ooc'];
    let pos = -1;
    return order.every(k => { const i = g.indexOf("'" + k + "'"); if (i < 0 || i < pos) return false; pos = i; return true; });
  })());
  check('I4.judgePromptFrozen', /当前上下文中的明确变化证据 > 静态人设刻板印象/.test(ciSrc)
    && /下列维度缺少证据，\*\*不得\*\*据此判 fail/.test(ciSrc) && /不要 chain-of-thought/.test(ciSrc));
  check('I5.rewritePromptFrozen', /必须保留：原意、信息量、事实内容、对用户请求的完成度、当前对话任务/.test(ciSrc)
    && /若无法在不改变原意的前提下修正，则原样返回原回复/.test(ciSrc));
  check('I6.integrityStillReadOnly', !/dbPut|dbDelete|localStorage|sessionStorage/.test(
    ciSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')));
  check('I7.integrityStillNoTransport', !/\bfetch\s*\(|_ibApiPost/.test(ciSrc) && /ASTRA\.middleBrainModelCall\(/.test(ciSrc));
  check('I8.disabledPathStillShortCircuits', (() => {
    const seg = ciSrc.slice(ciSrc.indexOf('async function middleBrainCharacterIntegrity'));
    return seg.indexOf("_ciSkip('disabled')") < seg.indexOf('_mbCiBuildEvidence(');
  })());

  /* ══ J. 开关语义：CI 的证据与 MB 的开关状态无关（T16–T18）══════════ */
  const readerSaved = globalThis.__ibMiddleBrainConfigReader;
  return Promise.resolve().then(async function () {
    globalThis.__ibMiddleBrainConfigReader = () => ({ enabled: true, endpoint: 'https://x', model: 'm', apiKey: 'sk-test', characterIntegrityEnabled: false, characterIntegrityRewrite: false });
    INTEG.middleBrainCharacterIntegrityReset();
    const off = await FACADE.middleBrainFinalizeReply(FRIEND, USER, CANDIDATE, { character: CHARACTER, history: WITH_CURRENT });
    const offTel = INTEG.middleBrainCharacterIntegrityTelemetry();
    check('J1.ciDisabledReturnsCandidateZeroEvidence', off === CANDIDATE && offTel.checked === 0 && (offTel.skipped.disabled || 0) === 1, offTel.skipped);
    globalThis.__ibMiddleBrainConfigReader = () => ({ enabled: false, characterIntegrityEnabled: false });
    INTEG.middleBrainCharacterIntegrityReset();
    const off2 = await FACADE.middleBrainFinalizeReply(FRIEND, USER, CANDIDATE, { character: CHARACTER, history: WITH_CURRENT });
    check('J2.ciDisabledIndependentOfMbSwitch', off2 === CANDIDATE && INTEG.middleBrainCharacterIntegrityTelemetry().checked === 0);
    const bypass = await FACADE.middleBrainExecute(FRIEND, USER, { dialogue: DIALOGUE.lines({ history: WITH_CURRENT, userMessage: USER, currentId: null }) });
    const evNoMb = ciEvidence('desktop', { history: WITH_CURRENT, userMessage: USER, currentId: 'cur' });
    check('J3.mbDisabledStillYieldsFullCanonicalEvidence',
      bypass === null && evNoMb.dialogue.length === WITH_CURRENT.length && evNoMb.dialogueMeta.source === 'dialogue-core',
      { bypass: bypass, rows: evNoMb.dialogue.length });
    globalThis.__ibMiddleBrainConfigReader = () => ({ enabled: true, characterIntegrityEnabled: true, characterIntegrityRewrite: true, apiKey: '' });
    INTEG.middleBrainCharacterIntegrityReset();
    const notReady = await FACADE.middleBrainFinalizeReply(FRIEND, USER, CANDIDATE, { character: CHARACTER, history: WITH_CURRENT });
    check('J4.ciEnabledButAstraNotReadyNoCall', notReady === CANDIDATE
      && (INTEG.middleBrainCharacterIntegrityTelemetry().skipped.astra_not_ready || 0) === 1);
    check('J5.evidenceIsConfigIndependent',
      JSON.stringify(ciEvidence('desktop', { history: WITH_CURRENT, userMessage: USER, currentId: 'cur' }).dialogue)
      === JSON.stringify(evNoMb.dialogue));
    globalThis.__ibMiddleBrainConfigReader = readerSaved;
  }).then(function () {

    /* ══ K. 对照证明：把旧投影装回临时副本，同一批断言必须 RED ═══════ */
    const baselineDir = mirrorWorkspace('baseline');
    const baseline = runProbe(baselineDir);
    check('K1.baselineCopyIsGreen', baseline.marker === 'PASS', baseline);

    const mutatedDir = mirrorWorkspace('legacy');
    let mutated = true;
    try { installLegacyProjection(mutatedDir); }
    catch (error) { mutated = false; check('K2.mutationApplied', false, String(error && error.message || error)); }
    if (mutated) {
      const red = runProbe(mutatedDir);
      check('K2.legacyProjectionTurnsConvergenceRed', red.marker === 'FAIL' && red.failed.length > 0, red);
      check('K3.redAreTheParityAndOwnershipAssertions',
        red.failed.some(n => /\.sameRows$/.test(n)) && red.failed.some(n => /\.currentTurn(RowsAsCoreRules|Present)$/.test(n)),
        red.failed.slice(0, 10));
      console.log('  counter-proof: pristine=' + baseline.marker + ' legacy-projection=' + red.marker +
        ' (' + red.failed.length + ' red, e.g. ' + red.failed.slice(0, 4).join(', ') + ')');
    }

    /* ══ L. 共享核心缺席时的 fail-safe ═══════════════════════════════ */
    const coreSaved = globalThis.IBDialogueCore;
    try {
      delete globalThis.IBDialogueCore;
      const degraded = INTEG._mbCiBuildEvidence(FRIEND, USER, { character: CHARACTER, history: WITH_CURRENT, currentId: 'cur' });
      check('L1.missingCoreDegradesToNoEvidence',
        degraded.dialogue.length === 0 && degraded.dialogueMeta.source === 'unavailable'
        && degraded.available.emotional_continuity === false, degraded.dialogueMeta);
      check('L2.missingCoreNeverThrows', true);
    } finally {
      globalThis.IBDialogueCore = coreSaved;
    }
    const restored = ciEvidence('desktop', { history: WITH_CURRENT, userMessage: USER, currentId: 'cur' });
    check('L3.coreRestored', restored.dialogueMeta.source === 'dialogue-core' && restored.dialogue.length === WITH_CURRENT.length);

    console.log('\nM1-C.2p CI dialogue authority: ' + passed + ' passed, ' + failed + ' failed');
    process.exitCode = failed ? 1 : 0;
  }).catch(function (error) {
    console.error('unexpected failure:', (error && error.stack) || error);
    process.exitCode = 1;
  });
}

/* ════════════════════════════════════════════════════════════════════
   支撑函数
   ════════════════════════════════════════════════════════════════════ */

/* 桌面 provider 请求数组的忠实构造（communication.js:2153-2175 的形状）：
   history.map(...) → unshift(system) → 把系统注入块追加到**末条 user 消息**。
   只建模与对话语义有关的三件事（system 行 / 尾部注入 / 当前回合在不在里面）；
   语音行、文件块、ws 存根是同一类 transport 变形，收敛之后 guard 根本读不到它们。 */
function providerShapedFrom(inp, def) {
  const msgs = [{ role: 'system', content: '系统提示词' }];
  for (const r of inp.history) {
    if (!r || (r.role !== 'user' && r.role !== 'assistant')) continue;
    msgs.push({ role: r.role, content: String(r.content == null ? '' : r.content) });
  }
  if (String(inp.userMessage || '').trim()) {
    const last = msgs.length - 1;
    if (msgs[last] && msgs[last].role === 'user' && msgs[last].content === inp.userMessage) {
      msgs[last] = { role: 'user', content: inp.userMessage + '\n\n' + TAIL_BLOCK };
    } else {
      msgs.push({ role: 'user', content: inp.userMessage + '\n\n' + TAIL_BLOCK });
    }
  }
  return msgs;
}

/* 全仓扫描：生产代码里还有没有第二份对话投影？（剥离注释后再判，避免注释里的
   中文短语误命中） */
function scanProduction() {
  const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const labels = [], legacy = [], capDecls = [], coreRefs = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(ROOT, full).replace(/\\/g, '/');
      if (entry.isDirectory()) { if (entry.name !== 'node_modules') walk(full); continue; }
      if (!entry.name.endsWith('.js')) continue;
      const text = strip(fs.readFileSync(full, 'utf8'));
      if (/['"]\u7528\u6237\uff1a/.test(text) || /['"]\u89d2\u8272\uff1a/.test(text)) labels.push(rel);
      if (/_ciHistory/.test(text)) legacy.push(rel);
      if (/var\s+HISTORY_MAX_(MESSAGES|CHARS)\s*=/.test(text)) capDecls.push(rel);
      if (/dialogue-core/.test(text)) coreRefs.push(rel);
    }
  }
  walk(path.join(ROOT, 'assets', 'js'));
  walk(path.join(ROOT, 'services'));
  return { labels: labels.sort(), legacy: legacy.sort(), capDecls: capDecls.sort(), coreRefs: coreRefs.sort() };
}

/* ── 临时副本：只复制加载规范化 Middle Brain 装配所需的那几个文件 ────── */
const COPY_FILES = [
  'assets/js/dialogue-core.js',
  'assets/js/chat-core.js',
  'assets/js/context-snapshot.js',
  'assets/js/ib-model-core.js',
  'assets/js/provider-directory.js',
  'assets/js/middle-brain-config-core.js',
  'assets/js/middle-brain-config.js',
  'assets/js/middle-brain-policy.js',
  'assets/js/middle-brain-astra.js',
  'assets/js/middle-brain-judge.js',
  'assets/js/middle-brain-integrity.js',
  'assets/js/middle-brain.js',
  'services/home-node/middle-brain.js'
];
function mirrorWorkspace(tag) {
  const dir = tempDir(tag);
  for (const rel of COPY_FILES) {
    const src = path.join(ROOT, rel);
    const dst = path.join(dir, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
  }
  return dir;
}
/* 单向弱化：把 guard 的对话来源换回 pre-fix 的 _ciHistory 投影（同一处 seam）。
   这不是"删掉测试"，而是**真实的漂移形态**：guard 又有了一份自己的对话投影。 */
function installLegacyProjection(dir) {
  const file = path.join(dir, 'assets', 'js', 'middle-brain-integrity.js');
  const from = "    try { res = core.assemble({ history: history, userMessage: userMessage, currentId: currentId }); }\n"
    + "    catch (e) { return none; }\n"
    + "    if (!res || !Array.isArray(res.lines)) return none;";
  const to = "    /* COUNTER-PROOF: 装回 pre-fix 的 _ciHistory 投影（第二份对话定义） */\n"
    + "    var _lr = [], _lh = Array.isArray(history) ? history : [];\n"
    + "    for (var _li = _lh.length - 1; _li >= 0 && _lr.length < 8; _li--) {\n"
    + "      var _lm = _lh[_li]; if (!_lm || typeof _lm !== 'object') continue;\n"
    + "      var _lrole = (_lm.role === 'assistant') ? 'assistant' : (_lm.role === 'user' ? 'user' : null);\n"
    + "      if (!_lrole) continue;\n"
    + "      var _lt = (typeof _lm.content === 'string') ? _lm.content : '';\n"
    + "      if (!_lt || !_lt.trim()) continue;\n"
    + "      _lr.unshift((_lrole === 'assistant' ? '\u89d2\u8272\uff1a' : '\u7528\u6237\uff1a') + _lt.slice(0, 400));\n"
    + "    }\n"
    + "    res = { lines: _lr, historyCount: _lr.length, currentIncluded: false, currentSkipped: null, truncatedHistory: 0 };\n"
    + "    void core;";
  const raw = fs.readFileSync(file, 'utf8');
  /* 仓库里的文件可能是 CRLF —— 先把换行归一再做锚点替换，写回时还原原风格。 */
  const crlf = raw.indexOf('\r\n') >= 0;
  const normalized = raw.replace(/\r\n/g, '\n');
  if (normalized.indexOf(from) < 0) throw new Error('mutation anchor not found in middle-brain-integrity.js');
  const mutatedText = normalized.replace(from, to);
  fs.writeFileSync(file, crlf ? mutatedText.replace(/\n/g, '\r\n') : mutatedText, 'utf8');
}
/* 在副本上跑同一批收敛断言（自调用 --probe 子模式），解析标记行与失败名。
   用 spawnSync 而不是 execFileSync：probe 把失败名打到 stderr（与主套件同一格式），
   而 execFileSync 只返回 stdout —— 那样"变红了"会看不见是**哪几条**断言。 */
function runProbe(dir) {
  const r = spawnSync(process.execPath, [__filename, '--probe', '--root', dir], {
    cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000
  });
  const output = String(r.stdout || '') + String(r.stderr || '');
  const marker = (output.match(/CI_CONVERGENCE=(PASS|FAIL)/) || [])[1] || '(none)';
  const failedNames = (output.match(/\u2718\s+([A-Za-z0-9_.]+)/g) || []).map(s => s.replace(/^\u2718\s+/, '').trim());
  return { marker: marker, failed: failedNames, tail: output.split('\n').filter(Boolean).slice(-3).join(' | ') };
}
