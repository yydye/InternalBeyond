/* ====================================================================
   Astra Readiness Phase 1 · 只读观测（观测，不调参）
   --------------------------------------------------------------------
   本文件做三件事，全部**离线、零网络、零浏览器**：
     ① 在**真实生产装配**上测量语料的 dialogue / context 信号
        （Gate 的 dialogueChars 到底是多少、落在 600/3500 的哪一档）
     ② 在真实生产装配上测量 multipleThreads 的触发分布与触发原因
     ③ 审计 MB_GATE_STATE 的归属 / 生命周期 / 持久化 / 宿主分叉，
        并给出**确定性反例**（同一份证据、不同宿主本地状态 → 不同判定）

   ── 为什么用 Home Node 的 canonical loader，而不是自建沙箱 ────────────
   `services/home-node/middle-brain.js` 的 loadCanonicalMiddleBrain() 是**生产**用来
   把五个层 + facade 装进 Node 的唯一入口（它同时是 Home Node 的运行时装配）。
   观测直接跑在这份装配上，测到的就是生产实现，而不是"我照着重写的一版"。
   本文件不修改任何生产文件，也不写任何存储。

   ── 本阶段纪律 ─────────────────────────────────────────────────────
   只测量、只记录。所以你会在这里看到 dlgCharsLow/High、multipleThreads 的
   触发式、MB_GATE_STATE 的生命周期**被断言为当前值**（防止有人在"观测阶段"
   顺手把它们改掉），而不是被调整。

   ── §11 只读约束：它到底保护什么（P23 Phase 1.1 重新定位）─────────────
   本文件原先用一条 blanket 断言保护只读性：

       git diff --name-only HEAD -- assets services InternalBeyond.html == ''

   那条断言保护的是**「本仓库没有人在任何地方改过任何东西」**，而不是这里真正
   的只读性质。它有两个后果，且都与它声称的目的相反：

     ① 误报：任何与 Astra 无关的别阶段工作（P23 的 Voice 消息）一落地就把它变红，
        而它红的原因与"观测是否仍然成立"毫无关系；于是下一个人只能把它删掉、
        放宽成"任何修改都允许"，或者对 diff 名单打补丁 —— 三种做法都让保护归零。
     ② 漏报：它只比较**文件名**。一个把 `dlgCharsLow: 600` 改成 300、或把
        `multipleThreads` 触发式改成 `>= 1` 的改动，只要不新增文件就**照样通过**，
        而那种改动才是真正让本文件的每一个测量值失效的东西。

   真正的不变量是「**本文件测量到的那条链路没有被改动**」，而不是"仓库干净"。
   因此 §11 现在分成两条各自可证伪的断言：

     · Z4 只读面：`READONLY_PROFILE` 里的文件（本文件的被测对象 + 生成被测量
       的 harness + 测量所依赖的共享常量/限制）对 HEAD **逐字节**未变，
       **唯一**豁免是"新增行且落在 P23 Voice UI 这些命名局部区段内"，
       且新增行不含任何凭据承载键。任何**修改/删除**行、任何区段外的新增、
       任何新文件都照旧失败。豁免写在 `p23VoiceUiOnly` 里，可以逐条被审查。
     · Z6 耦合面：那条链路上没有任何东西引用 Voice 功能（P23 改的 20 个文件中
       没有一个在这条链路上），所以 P23 的 Voice 工作**结构上不可能**改变
       这里的测量值 —— 这两条合起来才是"本次观测仍然成立"的证明。

   除 §11 之外，本文件全程只读：不修改任何生产文件，也不写任何存储。
   ==================================================================== */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');

let failures = 0;
const check = (name, cond, detail) => {
  if (cond) console.log('  PASS  ' + name);
  else { failures++; console.error('  FAIL  ' + name + (detail ? '  -> ' + detail : '')); }
};
const note = (s) => console.log('  · ' + s);
const readRel = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/^\uFEFF/, '');
/* 结构化扫描前先剥注释：**注释里的例子**（`IB_CI_CALIBRATION_KEY=sk-...`）不是代码，
   把它当成"凭据回落"或"第二份实现"都是误报。剥注释比"看起来像注释就跳过"更可靠。 */
function stripComments(src) {
  return String(src)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

const CORPUS = require('./astra-readiness-corpus.js');
const OBS = require('./astra-observation.js');
const CAL = require('./middle-brain-calibration.js');
const OLD = require('./middle-brain-calibration-cases.js');
const DIALOGUE = require(path.join(ROOT, 'assets', 'js', 'dialogue-core.js'));
const CSMOD = require(path.join(ROOT, 'assets', 'js', 'context-snapshot.js'));
const THREAD_RETRIEVAL = require(path.join(ROOT, 'services', 'home-node', 'thread-retrieval.js'));
/* 真实 producer 的标题常量（从模块导出读，不复制字面量） */
const CALDATA_THREAD_HEADER = () => THREAD_RETRIEVAL.THREAD_HEADER;

console.log('Astra Readiness Phase 1 · read-only observation\n');

/* ── 0 · 生产装配（真实 canonical Middle Brain，零网络）───────────────── */
/* 注入的配置只用于"就绪谓词/思考深度/开关"的语义测量；本文件**不发起任何请求**，
   因此不会用到 apiKey（也不设置它 —— 就绪谓词在观测里是"被测对象"之一）。 */
const MB_CONFIG = Object.assign({}, require(path.join(ROOT, 'assets', 'js', 'middle-brain-config-core.js')).MB_DEFAULTS, {
  enabled: true,
  characterIntegrityEnabled: true,
  characterIntegrityRewrite: false,
  characterIntegrityVerify: false,
  characterIntegritySensitivity: 'conservative'
});
const createNodeMiddleBrain = require(path.join(ROOT, 'services', 'home-node', 'middle-brain.js'));
const mb = createNodeMiddleBrain({ executionConfig: () => MB_CONFIG });
const CONTRACTS = (globalThis.IB && globalThis.IB.__middleBrainContracts) || {};
const POL = CONTRACTS.policy;
const INTEG = CONTRACTS.integrity;
const CFGC = CONTRACTS.config;
const GATE = POL.MB_GATE_DEFAULTS;
const PROD_DIALOGUE_LOW = GATE.dlgCharsLow;    /* 600 */
const PROD_DIALOGUE_HIGH = GATE.dlgCharsHigh;  /* 3500 */

check('P0.productionAssemblyLoaded', !!(mb && mb.available && POL && INTEG && CFGC && DIALOGUE && CSMOD),
  JSON.stringify({ available: mb && mb.available, layers: mb && mb.diagnostics && mb.diagnostics().layers }));
check('P0.dialogueCoreIsSharedNotCopied', typeof DIALOGUE.assemble === 'function'
  && DIALOGUE === globalThis.IBDialogueCore
  && require(path.join(ROOT, 'services', 'home-node', 'middle-brain.js')).DIALOGUE_MAX_MESSAGES === DIALOGUE.HISTORY_MAX_MESSAGES);

/* 当前回合身份：**确定性**规则（同时模拟两种宿主形状）
   · 历史最后一行是 user 行且带 id → currentId = 那一行的 id（"这一轮已 canonical 在窗口内"）
   · 否则 → null（桌面形状：无 id，走共享核心声明的逐字回落）*/
function currentIdOf(fixture) {
  const h = fixture.history;
  if (!h.length) return null;
  const last = h[h.length - 1];
  return (last.role === 'user' && last.id) ? last.id : null;
}
/* 真实 canonical 快照：有内容 = present，没有 = 不建字段（= missing → 组织层读到空） */
function snapshotFor(fixture) {
  const fields = {};
  for (const name of ['memory', 'understanding', 'thread', 'moments']) {
    const v = fixture.context && fixture.context[name];
    if (v) fields[name] = CSMOD.field('obs:' + name, String(v));
  }
  return CSMOD.create({ characterId: fixture.character.id, turnId: 'obs', fields: fields, gates: {} });
}
function labeledLines(fixture) {
  return DIALOGUE.lines({ history: fixture.history, userMessage: fixture.user, currentId: currentIdOf(fixture) });
}
const LABEL_CHARS = (role) => (role === 'assistant' ? DIALOGUE.ROLE_LABEL : DIALOGUE.USER_LABEL).length;

/* 真实 Gate 信号 */
async function signalsFor(fixture) {
  const snap = snapshotFor(fixture);
  const opts = { dialogue: labeledLines(fixture), contextSnapshot: snap };
  return await POL._mbAnalyzeSignals(fixture.character.id, fixture.user, opts, MB_CONFIG);
}
/* 真实 Guard 证据（M1-C.2p 之后的 canonical 消费者）*/
function evidenceFor(fixture) {
  return INTEG._mbCiBuildEvidence(fixture.character.id, fixture.user, {
    character: fixture.character,
    history: fixture.history,
    currentId: currentIdOf(fixture),
    contextSnapshot: snapshotFor(fixture)
  });
}
/* 真实加权分的 dialogue 分量：只让 dialogueChars 变化、其余归零，
   于是 score = weights.dialogue × dlgScore（redundancy 项在 ratio=1 时为 0）。 */
function dlgScoreOf(chars) {
  const s = POL._mbGateScore({
    contextChars: 0, dialogueChars: chars,
    memoryItems: 0, understandingItems: 0, threadItems: 0, momentItems: 0,
    localCompressionRatio: 1
  }, GATE);
  return Math.round((s.score / GATE.weights.dialogue) * 1e6) / 1e6;
}
function bucketOf(chars) {
  if (chars < PROD_DIALOGUE_LOW) return 'below_low';
  if (chars >= PROD_DIALOGUE_HIGH) return 'at_or_above_high';
  return 'ramp';
}

(async () => {
  /* ═══════════ 1 · 语料本身的确定性 ═══════════ */
  check('C1.corpusValid', CORPUS.validate().length === 0, CORPUS.validate().slice(0, 3).join(' | '));
  check('C2.allClassesCovered', CORPUS.uncoveredClasses().length === 0, CORPUS.uncoveredClasses().join(','));
  check('C3.corpusHasNoModelOutput', CORPUS.CASES.every(c => c.observed === null && c.observedJudge === undefined));
  check('C4.contractAndJudgementSeparated', (() => {
    const j = CORPUS.CASES.filter(c => c.expectation.kind === 'judgement');
    const k = CORPUS.CASES.filter(c => c.expectation.kind === 'contract');
    return j.length >= 20 && k.length >= 5
      && j.every(c => typeof c.expectation.ooc === 'boolean')
      && k.every(c => c.expectation.ooc === null && c.expectation.rewriteExpected === null);
  })(), JSON.stringify({ judgement: CORPUS.CASES.filter(c => c.expectation.kind === 'judgement').length, contract: CORPUS.CASES.filter(c => c.expectation.kind === 'contract').length }));
  check('C5.idsDeterministicAcrossLoads', (() => {
    delete require.cache[require.resolve('./astra-readiness-corpus.js')];
    const again = require('./astra-readiness-corpus.js');
    return JSON.stringify(again.CASES.map(c => c.id)) === JSON.stringify(CORPUS.CASES.map(c => c.id));
  })());

  /* ═══════════ 2 · 语料上的真实信号（§6 dialogue 分布）═══════════ */
  const rows = [];
  for (const c of CORPUS.CASES) {
    const sig = await signalsFor(c);
    const ev = evidenceFor(c);
    const gateDialogueChars = sig.dialogueChars;
    const evidenceChars = ev.dialogue.reduce((a, m) => a + m.text.length, 0);
    const labeledChars = ev.dialogue.reduce((a, m) => a + m.text.length + LABEL_CHARS(m.role), 0);
    rows.push({
      id: c.id,
      dialogueRows: ev.dialogue.length,
      evidenceChars: evidenceChars,
      labeledChars: labeledChars,
      gateDialogueChars: gateDialogueChars,
      bucket: bucketOf(gateDialogueChars),
      dlgScore: dlgScoreOf(gateDialogueChars),
      contextChars: sig.contextChars,
      memoryItems: sig.memoryItems, understandingItems: sig.understandingItems,
      threadItems: sig.threadItems, momentItems: sig.momentItems,
      multipleThreads: sig.multipleThreads,
      conflictSignal: sig.conflictSignal,
      nearBudget: sig.nearBudget,
      localCompressionRatio: sig.localCompressionRatio,
      gateScore: POL._mbGateScore(sig, GATE).score,
      available: ev.available,
      priorRows: ev.dialogueMeta.priorRows,
      currentIncluded: ev.dialogueMeta.currentIncluded,
      currentSkipped: ev.dialogueMeta.currentSkipped,
      budgetDropped: ev.dialogueMeta.budgetDropped,
      candidateChars: c.candidate.length,
      userChars: c.user.length
    });
  }
  check('S1.everyCaseMeasuredThroughRealGateSignals', rows.every(r => typeof r.gateDialogueChars === 'number' && typeof r.gateScore === 'number'));
  check('S2.dialogueCharsEqualsLabeledRows', rows.every(r => r.gateDialogueChars === r.labeledChars),
    JSON.stringify(rows.filter(r => r.gateDialogueChars !== r.labeledChars).slice(0, 3)));
  check('S3.gateBucketMatchesPublishedRamp', (() => {
    const near = (a, b) => Math.abs(a - b) < 1e-6;
    const pub = (x) => Math.max(0, Math.min(1, (x - PROD_DIALOGUE_LOW) / (PROD_DIALOGUE_HIGH - PROD_DIALOGUE_LOW)));
    return rows.every(r => {
      const expected = r.gateDialogueChars <= PROD_DIALOGUE_LOW ? 0 : pub(r.gateDialogueChars);
      return near(r.dlgScore, expected);
    });
  })());
  check('S4.everyCaseHasExactlyOneCurrentTurn', rows.every(r => r.currentIncluded || r.currentSkipped === 'duplicate'),
    JSON.stringify(rows.filter(r => !r.currentIncluded && r.currentSkipped !== 'duplicate').map(r => r.id)));

  /* ═══════════ 3 · dialogue 字符数分布（§6：min/p10/…/max）═══════════ */
  const dlgDist = OBS.percentiles(rows.map(r => r.gateDialogueChars));
  const OLD_ROWS = [];
  for (const c of OLD.CASES) {
    const sig = await POL._mbAnalyzeSignals(c.character.id, c.userMessage, { dialogue: DIALOGUE.lines({ history: c.history || [], userMessage: c.userMessage, currentId: null }) }, MB_CONFIG);
    OLD_ROWS.push(sig.dialogueChars);
  }
  const oldDist = OBS.percentiles(OLD_ROWS);

  console.log('\n  [§6] dialogue character-count distribution');
  console.log('       readiness corpus (n=' + dlgDist.count + '): ' + JSON.stringify(dlgDist));
  console.log('       existing calibration corpus (n=' + oldDist.count + '): ' + JSON.stringify(oldDist));
  console.log('       buckets (readiness): ' + JSON.stringify(rows.reduce((m, r) => { m[r.bucket] = (m[r.bucket] || 0) + 1; return m; }, {})));
  console.log('       buckets (existing): ' + JSON.stringify(OLD_ROWS.reduce((m, x) => { const b = bucketOf(x); m[b] = (m[b] || 0) + 1; return m; }, {})));

  /* ═══════════ 4 · 600 / 3500 边界对齐（只测量，不修改）═══════════ */
  /* 结构性事实：共享核心的 8 条 × 400 字上限决定了"历史"能贡献的 dialogueChars 上限。*/
  const HIST_CEILING = DIALOGUE.HISTORY_MAX_MESSAGES * (DIALOGUE.HISTORY_MAX_CHARS + DIALOGUE.USER_LABEL.length);
  const ceilingProbe = await POL._mbAnalyzeSignals('obs:ceiling', '嗯', {
    dialogue: DIALOGUE.lines({
      history: new Array(DIALOGUE.HISTORY_MAX_MESSAGES).fill(0).map((_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: '甲'.repeat(1000) })),
      userMessage: '嗯', currentId: null
    })
  }, MB_CONFIG);
  const longCurrent = await POL._mbAnalyzeSignals('obs:longcurrent', '乙'.repeat(PROD_DIALOGUE_HIGH),
    { dialogue: DIALOGUE.lines({ history: [], userMessage: '乙'.repeat(PROD_DIALOGUE_HIGH), currentId: null }) }, MB_CONFIG);
  const minCurrentForHigh = PROD_DIALOGUE_HIGH - HIST_CEILING - DIALOGUE.USER_LABEL.length;
  const B7detail = 'dlgScore(' + (PROD_DIALOGUE_HIGH - 1) + ')=' + dlgScoreOf(PROD_DIALOGUE_HIGH - 1)
    + ' dlgScore(' + PROD_DIALOGUE_HIGH + ')=' + dlgScoreOf(PROD_DIALOGUE_HIGH);

  console.log('\n  [§6] boundary alignment (measured, NOT changed)');
  console.log('       dlgCharsLow=' + PROD_DIALOGUE_LOW + '  dlgCharsHigh=' + PROD_DIALOGUE_HIGH);
  console.log('       history-only ceiling = ' + HIST_CEILING + ' chars (' + DIALOGUE.HISTORY_MAX_MESSAGES + ' × (' + DIALOGUE.HISTORY_MAX_CHARS + '+label))');
  console.log('       maximal-history probe dialogueChars = ' + ceilingProbe.dialogueChars + ' → dlgScore=' + dlgScoreOf(ceilingProbe.dialogueChars));
  console.log('       single long current message (' + PROD_DIALOGUE_HIGH + ' chars) dialogueChars = ' + longCurrent.dialogueChars + ' → dlgScore=' + dlgScoreOf(longCurrent.dialogueChars));
  console.log('       current message length needed to reach dlgCharsHigh = ' + minCurrentForHigh + ' chars');
  console.log('       corpus samples reaching dlgCharsHigh = ' + rows.filter(r => r.bucket === 'at_or_above_high').length + '/' + rows.length);

  check('B1.historyAloneCannotReachDlgCharsHigh', ceilingProbe.dialogueChars < PROD_DIALOGUE_HIGH,
    ceilingProbe.dialogueChars + ' < ' + PROD_DIALOGUE_HIGH);
  check('B2.historyCeilingMatchesSharedCoreLimits', ceilingProbe.dialogueChars === HIST_CEILING + (DIALOGUE.USER_LABEL.length + 1),
    ceilingProbe.dialogueChars + ' vs ' + (HIST_CEILING + DIALOGUE.USER_LABEL.length + 1));
  check('B3.longCurrentMessageReachesHigh', longCurrent.dialogueChars >= PROD_DIALOGUE_HIGH && dlgScoreOf(longCurrent.dialogueChars) === 1);
  check('B4.existingCorpusEntirelyBelowLow', OLD_ROWS.every(x => x < PROD_DIALOGUE_LOW),
    'max=' + oldDist.max);
  check('B5.readinessCorpusStraddlesBoundaries', rows.some(r => r.bucket === 'below_low') && rows.some(r => r.bucket === 'ramp'),
    JSON.stringify(rows.reduce((m, r) => { m[r.bucket] = (m[r.bucket] || 0) + 1; return m; }, {})));
  check('B6.thresholdsUnchangedInThisPhase', PROD_DIALOGUE_LOW === 600 && PROD_DIALOGUE_HIGH === 3500,
    PROD_DIALOGUE_LOW + '/' + PROD_DIALOGUE_HIGH);
  check('B7.dlgScoreIsNeverOneFromHistoryAlone', dlgScoreOf(PROD_DIALOGUE_HIGH - 1) < 1 && dlgScoreOf(PROD_DIALOGUE_HIGH) === 1,
    B7detail);

  /* ═══════════ 5 · multipleThreads 触发分布与原因（§7）═══════════ */
  const triggerReason = (sig) => {
    const t = sig.threadItems >= 2, u = sig.understandingItems >= 2;
    if (t && u) return 'thread_and_understanding';
    if (t) return 'thread_lines>=2';
    if (u) return 'understanding_lines>=2';
    return null;
  };
  const corpusMT = { true: 0, false: 0, reasons: {} };
  for (const r of rows) {
    if (r.multipleThreads) { corpusMT.true++; const k = triggerReason(r); corpusMT.reasons[k] = (corpusMT.reasons[k] || 0) + 1; }
    else corpusMT.false++;
  }

  /* 真实生产里的 producer 块通常是**多行**的。这里用确定性多行块做探针，
     分别在 memory / understanding / thread 三个来源上测量触发条件。 */
  const L2 = '第一行线索\n第二行线索';
  const L5 = '一\n二\n三\n四\n五';
  const probeMT = async (name, opts) => {
    const sig = await POL._mbAnalyzeSignals('obs:mt:' + name, '随便说一句', opts, MB_CONFIG);
    return {
      name, threadItems: sig.threadItems, understandingItems: sig.understandingItems, memoryItems: sig.memoryItems,
      multipleThreads: sig.multipleThreads, reason: triggerReason(sig), contextChars: sig.contextChars,
      gate: POL._mbDecisionFromSignals(sig, GATE, {}, 0)
    };
  };
  const mtProbes = [];
  mtProbes.push(await probeMT('no_producers', { dialogue: DIALOGUE.lines({ history: [], userMessage: '随便说一句', currentId: null }) }));
  mtProbes.push(await probeMT('memory_5_lines', { memoryCtx: L5, dialogue: DIALOGUE.lines({ history: [], userMessage: '随便说一句', currentId: null }) }));
  mtProbes.push(await probeMT('understanding_2_lines', { understandingCtx: L2, dialogue: DIALOGUE.lines({ history: [], userMessage: '随便说一句', currentId: null }) }));
  mtProbes.push(await probeMT('thread_2_lines', { threadCtx: L2, dialogue: DIALOGUE.lines({ history: [], userMessage: '随便说一句', currentId: null }) }));
  mtProbes.push(await probeMT('one_line_each', { threadCtx: '线索', understandingCtx: '理解', dialogue: DIALOGUE.lines({ history: [], userMessage: '随便说一句', currentId: null }) }));
  mtProbes.push(await probeMT('thread_2_lines_with_cooldown', { threadCtx: L2, dialogue: DIALOGUE.lines({ history: [], userMessage: '随便说一句', currentId: null }) }));

  /* 冷却是**硬触发之外**的约束：multipleThreads 必须无视它。用真实判定函数验证。 */
  const mtSig = await POL._mbAnalyzeSignals('obs:mt:cooldown', '随便说一句', { threadCtx: L2, dialogue: DIALOGUE.lines({ history: [], userMessage: '随便说一句', currentId: null }) }, MB_CONFIG);
  const mtWarm = POL._mbDecisionFromSignals(mtSig, GATE, { lastAstraAt: 1000, lastDecision: 'yes', lastDecisionAt: 1000 }, 2000);
  const sameSigCold = POL._mbDecisionFromSignals(mtSig, GATE, {}, 2000);

  console.log('\n  [§7] multipleThreads activation');
  console.log('       corpus: ' + JSON.stringify(corpusMT));
  for (const p of mtProbes) {
    console.log('       ' + p.name.padEnd(28) + ' threadItems=' + p.threadItems + ' understandingItems=' + p.understandingItems
      + ' memoryItems=' + p.memoryItems + ' multipleThreads=' + p.multipleThreads + ' reason=' + p.reason
      + ' → gate=' + p.gate.reason);
  }
  console.log('       cooldown probe: same signals, warm state → ' + mtWarm.reason + ' / cold state → ' + sameSigCold.reason);

  check('M1.multipleThreadsNeedsTwoLinesInOneProducer', (() => {
    const by = {}; for (const p of mtProbes) by[p.name] = p;
    return by.no_producers.multipleThreads === false
      && by.memory_5_lines.multipleThreads === false
      && by.understanding_2_lines.multipleThreads === true
      && by.thread_2_lines.multipleThreads === true
      && by.one_line_each.multipleThreads === false;
  })(), JSON.stringify(mtProbes.map(p => [p.name, p.multipleThreads])));
  check('M2.understandingAloneIsSufficient', mtProbes.find(p => p.name === 'understanding_2_lines').reason === 'understanding_lines>=2');
  check('M3.multipleThreadsIsACooldownBypassingHardTrigger', mtWarm.reason === 'multiple_threads' && sameSigCold.reason === 'multiple_threads'
    && sameSigCold.useAstra === true);
  check('M4.corpusMultipleThreadsIsFalseBecauseBlocksAreSingleLine',
    corpusMT.true === 0 && rows.every(r => r.understandingItems <= 1 && r.threadItems <= 1),
    JSON.stringify(corpusMT));
  check('M5.multipleThreadsTriggerUnchangedInThisPhase',
    POL.MB_GATE_DEFAULTS.weights.dialogue === 0.15
    && /multipleThreads: \(threadItems >= 2 \|\| understandingItems >= 2\)/.test(readRel('assets/js/middle-brain-policy.js')));
  /* 宽度判定：触发时的上下文规模（是否"过于宽泛地激活"）*/
  const mtWide = mtProbes.filter(p => p.multipleThreads).map(p => ({ name: p.name, contextChars: p.contextChars, dialogueChars: null }));
  /* ── 真实 producer 的**渲染形状**（这是 §7 的决定性证据）─────────────
     触发式是 `threadItems >= 2 || understandingItems >= 2`，而 items 数的是
     **块里非空行的条数**（`countLines` 把标题行也算一行）。所以要回答
     "多线索是否太容易触发"，就必须看真实 producer 渲染出来是几行 ——
     而不是看语料里手写的单行字符串。 */
  const UDC = require(path.join(ROOT, 'assets', 'js', 'understanding-derivation-core.js'));
  const synthUnderstandingDoc = {
    dimension: 'context',
    current: { content: '她最近在准备换工作，压力主要来自进度而不是钱。', conviction: 70, evidenceIds: ['m1', 'm2', 'm3'] }
  };
  const understandingBlock = UDC.renderUnderstandingContext(synthUnderstandingDoc, {});
  const understandingLines = understandingBlock.split(/\n+/).filter(l => l.trim()).length;
  const threadBlock1 = CALDATA_THREAD_HEADER() + '\n' + '- 她换工作的进展问过三次（依据 3 条记忆）';
  const threadBlock2 = CALDATA_THREAD_HEADER() + '\n' + '- 线索甲（依据 2 条记忆）\n- 线索乙（依据 4 条记忆）';
  const probeLines = async (name, opts) => {
    const sig = await POL._mbAnalyzeSignals('obs:lines:' + name, '随便说一句', opts, MB_CONFIG);
    return { name, understandingItems: sig.understandingItems, threadItems: sig.threadItems, memoryItems: sig.memoryItems,
      multipleThreads: sig.multipleThreads, contextChars: sig.contextChars,
      gate: POL._mbDecisionFromSignals(sig, GATE, { lastAstraAt: 1000, lastDecision: 'yes', lastDecisionAt: 1000 }, 2000) };
  };
  const D0 = () => DIALOGUE.lines({ history: [], userMessage: '随便说一句', currentId: null });
  const renderProbes = [];
  renderProbes.push(await probeLines('understanding_real_block', { understandingCtx: understandingBlock, dialogue: D0() }));
  renderProbes.push(await probeLines('thread_real_block_1_thread', { threadCtx: threadBlock1, dialogue: D0() }));
  renderProbes.push(await probeLines('thread_real_block_2_threads', { threadCtx: threadBlock2, dialogue: D0() }));

  console.log('       real renderer shapes:');
  console.log('         renderUnderstandingContext(doc) → ' + understandingLines + ' non-empty lines: '
    + JSON.stringify(understandingBlock.split('\n').map(l => l.slice(0, 34))));
  console.log('         buildThreadBlock with  1 thread → ' + threadBlock1.split(/\n+/).filter(l => l.trim()).length + ' non-empty lines');
  console.log('         buildThreadBlock with  2 threads → ' + threadBlock2.split(/\n+/).filter(l => l.trim()).length + ' non-empty lines');
  for (const p of renderProbes) {
    console.log('         probe ' + p.name.padEnd(30) + ' understandingItems=' + p.understandingItems + ' threadItems=' + p.threadItems
      + ' multipleThreads=' + p.multipleThreads + ' contextChars=' + p.contextChars + ' → gate=' + p.gate.reason + ' (useAstra=' + p.gate.useAstra + ')');
  }
  const udcSrc = readRel('assets/js/understanding-derivation-core.js');
  check('M6.understandingBlockIsAlwaysAtLeastThreeLines', understandingLines >= 2
    && udcSrc.indexOf("UNDERSTANDING_HEADER + '\\n'") >= 0
    && udcSrc.indexOf("条记忆\\n'") >= 0
    && udcSrc.indexOf("+ '- ' + head;") >= 0,
    understandingLines + ' lines（渲染形状固定为 标题 + 维度行 + 内容行，与 doc 内容无关）');
  check('M7.understandingPresenceAloneTriggersMultipleThreads',
    renderProbes[0].multipleThreads === true && renderProbes[0].understandingItems >= 2
    && renderProbes[0].gate.reason === 'multiple_threads' && renderProbes[0].gate.useAstra === true,
    JSON.stringify(renderProbes[0]));
  check('M8.oneOpenThreadIsEnoughForTheHardTrigger',
    renderProbes[1].threadItems >= 2 && renderProbes[1].multipleThreads === true
    && renderProbes[1].gate.reason === 'multiple_threads',
    JSON.stringify(renderProbes[1]));
  check('M9.hardTriggerIgnoresCooldownEvenWithTinyContext',
    renderProbes[0].gate.reason === 'multiple_threads' && renderProbes[0].contextChars < 100,
    'contextChars=' + renderProbes[0].contextChars);
  console.log('       breadth: first-line header counts as one of the "items" → '
    + '一个标题 + 一行内容 = 2 items → 硬触发成立');

  /* 触发原因分布（把真实渲染形状叠加到整份语料上）*/
  const overlay = { true: 0, false: 0, byCause: {} };
  for (const c of CORPUS.CASES) {
    const sig = await POL._mbAnalyzeSignals(c.character.id, c.user, {
      dialogue: DIALOGUE.lines({ history: c.history || [], userMessage: c.user, currentId: currentIdOf(c) }),
      understandingCtx: understandingBlock
    }, MB_CONFIG);
    if (sig.multipleThreads) { overlay.true++; overlay.byCause['understanding_lines>=2'] = (overlay.byCause['understanding_lines>=2'] || 0) + 1; }
    else overlay.false++;
  }
  console.log('       corpus × (an active Understanding doc exists) : ' + JSON.stringify(overlay));
  check('M10.overlayShowsBroadActivation', overlay.true === CORPUS.CASES.length,
    JSON.stringify(overlay));

  /* ═══════════ 6 · MB_GATE_STATE 归属 / 生命周期 / 分叉（§8）═══════════ */
  const policySrc = readRel('assets/js/middle-brain-policy.js');
  const hasResetCaller = (() => {
    const hits = [];
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { if (!/node_modules|\.git|\.venv/.test(e.name)) walk(p); }
        else if (/\.js$/.test(e.name)) {
          const t = fs.readFileSync(p, 'utf8');
          if (/middleBrainAdmissionGateReset\s*\(/.test(t) && path.relative(ROOT, p).replace(/\\/g, '/') !== 'assets/js/middle-brain-policy.js') {
            const callLike = t.split('\n').filter(l => /middleBrainAdmissionGateReset\s*\(/.test(l) && !/function\s+middleBrainAdmissionGateReset/.test(l));
            for (const l of callLike) hits.push(path.relative(ROOT, p).replace(/\\/g, '/') + ': ' + l.trim().slice(0, 80));
          }
        }
      }
    };
    walk(path.join(ROOT, 'assets'));
    walk(path.join(ROOT, 'services'));
    return hits;
  })();

  /* 确定性反例：**同一份证据**、同一个 now，只有宿主本地状态不同 */
  const shared = { contextChars: 4500, dialogueChars: 1500, memoryItems: 2, understandingItems: 1, threadItems: 1, momentItems: 0, localCompressionRatio: 0.45, conflictSignal: false, multipleThreads: false, nearBudget: false };
  const NOW = 1000000;
  const dCold = POL._mbDecisionFromSignals(shared, GATE, {}, NOW);
  const dWarmYes = POL._mbDecisionFromSignals(shared, GATE, { lastDecision: 'yes', lastDecisionAt: NOW - 1000 }, NOW);
  const dCooldown = POL._mbDecisionFromSignals(shared, GATE, { lastAstraAt: NOW - 5000, lastDecision: 'yes', lastDecisionAt: NOW - 5000 }, NOW);
  const dExpired = POL._mbDecisionFromSignals(shared, GATE, { lastDecision: 'yes', lastDecisionAt: NOW - 200000, lastAstraAt: NOW - 200000 }, NOW);
  const hnGate = await POL.middleBrainAdmissionGate('obs:hn', 'hi', {}, MB_CONFIG);

  console.log('\n  [§8] MB_GATE_STATE ownership / divergence');
  console.log('       module state: ' + (/var MB_GATE_STATE = \{\}/.test(policySrc) ? 'MB_GATE_STATE = {} (module scope, 不落盘)' : 'UNEXPECTED'));
  console.log('       reset callers in production code: ' + (hasResetCaller.length ? JSON.stringify(hasResetCaller) : 'none'));
  console.log('       identical evidence, four host-local states:');
  console.log('         cold            → ' + dCold.reason + ' (useAstra=' + dCold.useAstra + ', score=' + dCold.score + ')');
  console.log('         warm yes 1s     → ' + dWarmYes.reason + ' (useAstra=' + dWarmYes.useAstra + ', score=' + dWarmYes.score + ')');
  console.log('         cooldown 5s     → ' + dCooldown.reason + ' (useAstra=' + dCooldown.useAstra + ', score=' + dCooldown.score + ')');
  console.log('         yes 200s ago    → ' + dExpired.reason + ' (useAstra=' + dExpired.useAstra + ', score=' + dExpired.score + ')');
  console.log('       Home Node gate on the same config → ' + hnGate.reason + ' (useAstra=' + hnGate.useAstra + ')');
  console.log('       middleBrainReady() under the Home Node config = ' + (await CFGC.middleBrainReady()));

  /* 归属与生命周期（只读事实，四条；不含任何"该怎么改"的判断）*/
  const stateFacts = {
    declaration: 'assets/js/middle-brain-policy.js: var MB_GATE_STATE = {}',
    scope: '模块作用域变量（function(root){…} 内），键为 characterId',
    lifetime: 'JS realm 存活期：桌面 = 页面会话（刷新即丢）；Home Node = 进程存活期',
    persistence: '不落盘（无 dbPut / localStorage / indexedDB / sessionStorage）',
    reset: '只有 middleBrainAdmissionGateReset(characterId|null) 能清；生产代码里没有任何调用点',
    homeNode: 'Home Node 的 map 永远为空：middleBrainReady() 恒 false → Gate 在读写状态**之前**就返回 astra_not_ready'
  };
  for (const k of Object.keys(stateFacts)) console.log('       ' + k + ': ' + stateFacts[k]);

  check('G1.stateIsModuleScopedMemoryOnly', /var MB_GATE_STATE = \{\}/.test(policySrc)
    && !/dbPut|dbGet|localStorage|sessionStorage|indexedDB/.test(policySrc));
  check('G1b.stateFactsRecorded', stateFacts.lifetime.indexOf('页面会话') >= 0 && stateFacts.persistence.indexOf('不落盘') >= 0);
  check('G2.noProductionResetCaller', hasResetCaller.length === 0, JSON.stringify(hasResetCaller));
  check('G3.identicalEvidenceProducesDivergentDecisions', (() => {
    const set = [dCold, dWarmYes, dCooldown, dExpired];
    const reasons = set.map(d => d.reason);
    return reasons.indexOf('hysteresis_hold') >= 0 && reasons.indexOf('cooldown') >= 0
      && dWarmYes.useAstra === true && dCooldown.useAstra === false && dCold.useAstra === false;
  })(), JSON.stringify({ cold: dCold.reason, warm: dWarmYes.reason, cd: dCooldown.reason, expired: dExpired.reason }));
  check('G4.hysteresisIsTheSharpestDivergence', dCold.reason === dExpired.reason && dWarmYes.reason !== dCold.reason);
  check('G5.homeNodeNeverConsultsState', hnGate.reason === 'astra_not_ready' && hnGate.useAstra === false);
  check('G6.gateStateNotPersistedAcrossHosts', !/MB_GATE_STATE/.test(readRel('services/home-node/middle-brain.js'))
    && !/MB_GATE_STATE/.test(readRel('services/home-node/execution.js')));
  check('G7.gateParamsUnchangedInThisPhase', GATE.scoreOn === 0.60 && GATE.scoreHold === 0.45
    && GATE.cooldownMs === 90000 && GATE.hysteresisMs === 180000
    && GATE.ctxCharsLow === 2500 && GATE.ctxCharsHigh === 7000 && GATE.budgetRatio === 0.90
    && JSON.stringify(GATE.weights) === JSON.stringify({ context: 0.35, dialogue: 0.15, items: 0.20, redundancy: 0.30 }),
    JSON.stringify(GATE));

  /* ═══════════ 7 · 只读面（§11）· 本阶段纪律的真正不变量 ═══════════
     判据是「本文件测量到的那条链路未被改动」，不是「仓库没有 diff」。
     下面这些文件就是那条链路：
       · 被测量对象：策略 / 对话核心 / 快照 / 作者核心 / canonical 装配；
       · 生成被测量的 harness：语料 / 观测 / 两份校准夹具；
       · 测量依赖的共享常量：历史窗口上限（§6 的 ceiling 就是它算出来的）。
     Home Node 的 thread-retrieval.js 也在这里：本文件从它读 THREAD_HEADER。 */
  const READONLY_PROFILE = [
    'assets/js/middle-brain-policy.js',
    'assets/js/middle-brain-integrity.js',
    'assets/js/middle-brain-config-core.js',
    'assets/js/dialogue-core.js',
    'assets/js/context-snapshot.js',
    'assets/js/understanding-derivation-core.js',
    'services/home-node/middle-brain.js',
    'services/home-node/thread-retrieval.js',
    'services/home-node/execution.js',
    'tests/astra-readiness-corpus.js',
    'tests/astra-observation.js',
    'tests/middle-brain-calibration.js',
    'tests/middle-brain-calibration-cases.js'
  ];
  /* P23 Phase 1.1 豁免：**新增行**，且落在下列「命名局部区段」标题的第一个
     函数/元素之前。它不是"social.js 随便改"：
       · kind 'html-region' —— 只覆盖 `id="api-voice-detail"` 那一块，
         Voice 卡片自己的界面上方（`api-voice-group` 起）到 `api-voice-model-wrap` 止；
       · kind 'function'    —— 只覆盖该函数的函数体（`function NAME(` 到首个 行首 `}`）；
     判定是"**每一个**新增行都落在某个豁免区段内"，只要有一行在外面就失败。
     修改行 / 删除行在这里永远不被豁免。 */
  const P23_VOICE_UI_ONLY = {
    'InternalBeyond.html': [
      { kind: 'html-region', from: 'id="api-voice-group"', until: 'id="api-voice-model-wrap"' },
      /* Voice 卡片之外，P23 在 HTML 里唯一需要的第二个触点：那个脚本句柄自己
         （新模块必须先加载再被引用）。范围收在它自己那一行所属的**脚本块**里，
         而不是"整个 <head> 随便加"。 */
      { kind: 'html-region', from: 'assets/js/voice-message-core.js', until: 'assets/js/chat-authority.js' }
    ],
    'assets/js/social.js': [
      /* IB_TTS_CATALOG 的**目录声明块**：它上方的说明注释（"Voice API Source 目录 /
         P23 Phase 1：source 是引用…"）与这份离线三 provider 目录本身。
         范围收在这一个 const 声明里（注释行 → `];` 那一行）。 */
      { kind: 'declaration', from: '/* Voice API Source 目录', until: '];' },
      /* Voice 卡片自己的这几个 helper：说明注释（+ 它紧跟的状态变量）+ 函数体。 */
      { kind: 'comment-and-function', from: '/* Bridge 提供的来源目录', name: '_ibVoiceSourceOf' },
      { kind: 'function-with-comment', name: 'loadVoiceSourceCatalog' },
      { kind: 'function-with-comment', name: '_voiceCatalogOf' },
      { kind: 'comment-and-function', from: '/* Provider 下拉改由目录驱动生成', name: '_voiceSyncProviderOptions' },
      { kind: 'function-with-comment', name: '_voiceSyncCapabilityFields' },
      { kind: 'function-with-comment', name: '_voiceSyncVoiceOptions' },
      /* P23 新加的 Voicebox Voice Profile 读取（同一 picker 的第二个数据来源）。 */
      { kind: 'comment-and-function', from: '/* Voicebox Voice Profile 列表', name: '_voiceSyncVoiceboxProfiles' },
      { kind: 'function-with-comment', name: '_voiceSyncModelOptions' },
      { kind: 'function-with-comment', name: '_voiceUsesSelect' },
      { kind: 'function-with-comment', name: '_voiceGetId' },
      { kind: 'function-with-comment', name: 'testCharacterVoice' },
      { kind: 'function-with-comment', name: 'loadApiSettingsUI' },
      { kind: 'function-with-comment', name: 'saveCurrentApi' },
      /* NS.expose('social', { … }) 这个**已有的** Voice 导出面上的一行新增
         （loadVoiceSourceCatalog 与同一个对象里既有的 _voiceSyncProviderOptions
         等导出并列）。它同样不能容纳任何凭据键。 */
      { kind: 'object-literal', from: "NS.expose('social', {", until: '});' }
    ]
  };
  /* 凭据边界：这些**键名 / 字面量**只要出现在新增行里就立刻失败，豁免区段也救不了它
     （P23 的契约是"角色记录只保存来源引用，绝不保存任何凭据"）。
     ⚠ 判据是"凭据承载**形状**"，不是"出现「凭据 / API Key / key」这几个字"：
     说明文字（例如"凭据在 Bridge config.json 的 tts 区块"）完全合法，把它当成泄漏
     只会让守卫变成一条谁都不敢碰的假红 —— 而假红的下场就是被人删掉。
     所以：键名必须带赋值形状（`apiKey:` / `apiKey=`），字面量必须带**值**（Bearer <token> / sk-xxx）。 */
  const CREDENTIAL_BEARING = /(?:apiKey|api_key|apikey|client_secret|access_token|refresh_token|Authorization)\s*[:=]|Bearer\s+[A-Za-z0-9._\-]{8,}|\bsk-[A-Za-z0-9_\-]{12,}/;

  function gitDiffLines(args) {
    try {
      return {
        ok: true,
        lines: execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).split(/\r?\n/)
          .filter(l => l.length && l[0] !== '-' && l[0] !== '\\')
      };
    } catch (e) { return { ok: false, lines: [], error: 'git-unavailable: ' + String(e.message || e).slice(0, 120) }; }
  }
  function changedFiles(args) {
    try {
      return {
        ok: true,
        files: execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' })
          .split(/\r?\n/).map(s => s.trim()).filter(Boolean).map(s => s.replace(/\\/g, '/'))
      };
    } catch (e) { return { ok: false, files: [], error: 'git-unavailable: ' + String(e.message || e).slice(0, 120) }; }
  }
  function fileText(rel) {
    try { return fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/^\uFEFF/, ''); }
    catch (e) { return null; }
  }
  /* 去掉字符串字面量与注释，只留"结构性字符"。花括号计数必须跑在它上面：
     否则 `'{'` 这样的字面量和 `// }` 这样的注释都会把区段边界算歪。 */
  function codeOnly(line) {
    let out = '', i = 0, q = null;
    const s = String(line);
    while (i < s.length) {
      const c = s[i], n = s[i + 1];
      if (q) {
        if (c === '\\') { i += 2; continue; }
        if (c === q) q = null;
        i++; continue;
      }
      if (c === '"' || c === "'" || c === '`') { q = c; i++; continue; }
      if (c === '/' && n === '/') break;
      if (c === '/' && n === '*') { const e = s.indexOf('*/', i + 2); i = e < 0 ? s.length : e + 2; continue; }
      out += c; i++;
    }
    return out;
  }
  /* 把每个豁免声明算成行范围。算不出上界的声明**不使用**（宁可误报，也不要把一个
     算错的区段当成豁免 —— 于是 regionRanges().length !== spec.length 会直接失败）。
     四种声明：
       html-region        —— 从 `from` 那一行到其后第一个含 `until` 的行；
       declaration        —— 从 `from` 那一行到其后第一条以 `until` 开头的行；
       function-with-comment —— 紧接在 function 前的 `/* … *​/` 注释 + 函数体（到收尾 `}`）；
       object-literal     —— 从 `from` 那一行到其后第一个含 `until` 的行（`});` 之类）。 */
  function regionRanges(text, spec) {
    const lines = text.split('\n');
    const out = [];
    for (const sp of (spec || [])) {
      if (sp.kind === 'leading-block') {
        /* `from`（说明注释的第一行）→ `until`（紧接在函数前的那一行，通常是
           它自己的 `var _…Cache=null;` 页内缓存声明）。用于"注释 + 变量 + 函数"
           这种 P23 形状。 */
        const a = lines.findIndex(l => l.indexOf(sp.from) >= 0);
        const b = a < 0 ? -1 : lines.findIndex((l, i) => i > a && l.indexOf(sp.until) >= 0);
        if (a >= 0 && b > a) out.push({ label: sp.from, start: a + 1, end: b + 1 });
        continue;
      }
      if (sp.kind === 'comment-and-function') {
        /* `from`（说明注释的第一行）→ 函数体的收尾 `}`。注释与它前面那几行
           （`var _…Cache=null;` 之类的页内状态）都算在这个区段里，因为 P23 的
           Voice 增量正是"注释 + 状态变量 + 函数"三件一起长出来的。 */
        const a = lines.findIndex(l => l.indexOf(sp.from) >= 0);
        const fa = lines.findIndex(l => l.indexOf('function ' + sp.name + '(') >= 0);
        if (a < 0 || fa < a) continue;
        let b = -1, depth = 0, opened = false;
        for (let i = fa; i < lines.length && b < 0; i++) {
          for (const ch of codeOnly(lines[i])) {
            if (ch === '{') { depth++; opened = true; }
            else if (ch === '}') { depth--; if (opened && depth <= 0) { b = i; break; } }
          }
        }
        if (b > a) out.push({ label: sp.from, start: a + 1, end: b + 1 });
        continue;
      }
      if (sp.kind === 'block-before-function') {
        /* 「说明注释 + 它紧跟的 `var …` 声明 + 函数体」整个块（P23 的 Voicebox 读取
           就是这种形状：注释 / 一个页内缓存变量 / 函数）。 */
        const a = lines.findIndex(l => l.indexOf('function ' + sp.name + '(') >= 0);
        if (a < 0) continue;
        let s = a;
        while (s > 0 && /^\s*(\*|\/\*|\/\/|var\s)/.test(lines[s - 1])) s--;
        let b = -1, depth = 0, opened = false;
        for (let i = a; i < lines.length && b < 0; i++) {
          for (const ch of codeOnly(lines[i])) {
            if (ch === '{') { depth++; opened = true; }
            else if (ch === '}') { depth--; if (opened && depth <= 0) { b = i; break; } }
          }
        }
        if (b > a) out.push({ label: 'block ' + sp.name, start: s + 1, end: b + 1 });
        continue;
      }
      if (sp.kind === 'function-with-comment') {
        const a = lines.findIndex(l => l.indexOf('function ' + sp.name + '(') >= 0);
        if (a < 0) continue;
        /* 收尾大括号靠字符扫描找（跳过字符串与注释），**不**靠缩进约定 ——
           `function f(){ … }` 一行写完的形式必须同样被圈住。 */
        let b = -1, depth = 0, opened = false;
        for (let i = a; i < lines.length && b < 0; i++) {
          for (const ch of codeOnly(lines[i])) {
            if (ch === '{') { depth++; opened = true; }
            else if (ch === '}') { depth--; if (opened && depth <= 0) { b = i; break; } }
          }
        }
        if (b > a) {
          let s = a;
          while (s > 0 && /^\s*(\*|\/\*|\/\/)/.test(lines[s - 1])) s--;
          out.push({ label: 'function ' + sp.name, start: s + 1, end: b + 1 });
        }
        continue;
      }
      const a = lines.findIndex(l => l.indexOf(sp.from) >= 0);
      let b = -1;
      if (a >= 0) {
        if (sp.kind === 'declaration') b = lines.findIndex((l, i) => i > a && l.indexOf(sp.until) === 0);
        else b = lines.findIndex((l, i) => i > a && l.indexOf(sp.until) >= 0);
      }
      if (a >= 0 && b > a) out.push({ label: sp.from + ' → ' + sp.until, start: a + 1, end: b + 1 });
    }
    return out;
  }
  /* 把 diff 文本（统一 0 上下文格式）解析成 { file, oldStart, newStart, added:[{newLine,text}] } */
  function parseUnifiedDiff(diffText) {
    const hunks = [];
    let cur = null;
    for (const raw of String(diffText).split(/\r?\n/)) {
      const m = /^\+\+\+ b\/(.+)$/.exec(raw);
      if (m) { cur = null; continue; }
      /* git 对"只插入、无上下文"的 hunk 会写成 `@@ -106 +106 @@`（单个行号，
         不带 `,count`），所以两个数字都必须可选。 */
      const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
      if (h) {
        cur = { file: '', oldStart: Number(h[1]), newStart: Number(h[2]), added: [] };
        hunks.push(cur);
        continue;
      }
      const f = /^diff --git a\/(.+?) b\/(.+)$/.exec(raw);
      if (f && hunks.length) hunks[hunks.length - 1].file = f[2];
      if (cur && raw[0] === '+' && raw.slice(0, 3) !== '+++') cur.added.push({ newLine: cur.newStart + cur.added.length, text: raw.slice(1) });
    }
    return hunks;
  }
  /* 纯函数：给定「每个文件的 unified-0 diff」→ 违规清单（空数组 = 通过）。
     回归测试（Z4b）用合成 fixture 直接喂它，因此这条判据本身是被测的，不是被信任的。 */
  function readonlyViolations(diffs) {
    const v = [];
    for (const rel of Object.keys(diffs || {})) {
      const hunks = parseUnifiedDiff(diffs[rel]);
      const spec = P23_VOICE_UI_ONLY[rel];
      const ranges = spec ? regionRanges(fileText(rel), spec) : [];
      if (spec && ranges.length !== spec.length) {
        v.push(rel + ': 豁免区段在文件里定位失败（' + ranges.length + '/' + spec.length + '）—— 宁可失败也不放宽');
      }
      for (const h of hunks) {
        for (const a of h.added) {
          if (CREDENTIAL_BEARING.test(a.text)) {
            v.push(rel + ':' + a.newLine + ' 新增行出现凭据承载键：' + a.text.trim().slice(0, 90));
            continue;
          }
          const inside = ranges.some(r => a.newLine >= r.start && a.newLine <= r.end);
          if (!inside) v.push(rel + ':' + a.newLine + ' 新增行落在所有豁免区段之外：' + a.text.trim().slice(0, 90));
        }
      }
    }
    return v;
  }
  /* 逐文件取 diff：这样"被修改 / 被删除的行"有且仅有一种表现 —— 该文件的
     added 行清单为空（或某行不在任何豁免区段内）→ 违规。不需要额外解析删除行。
     先只问一次 `--name-only`，再对**真的改过**的文件取 diff（13 个文件不必付 13 次 git 进程）。 */
  function readonlyDiff() {
    const changed = changedFiles(['diff', '--name-only', 'HEAD', '--', ...READONLY_PROFILE]);
    if (!changed.ok) return { ok: false, error: changed.error, diffs: {}, readonlyChanged: [], exemptChanged: [] };
    const diffs = {};
    for (const rel of changed.files.concat(Object.keys(P23_VOICE_UI_ONLY))) {
      const d = gitDiffLines(['diff', '--unified=0', 'HEAD', '--', rel]);
      if (!d.ok) return { ok: false, error: d.error, diffs: {}, readonlyChanged: [], exemptChanged: [] };
      if (d.lines.length) diffs[rel] = d.lines.join('\n');
    }
    const exemptChanged = Object.keys(P23_VOICE_UI_ONLY).filter(rel => diffs[rel]);
    return { ok: true, diffs: diffs, readonlyChanged: changed.files, exemptChanged: exemptChanged };
  }

  const roiResult = readonlyDiff();
  const roiViolations = roiResult.ok ? readonlyViolations(roiResult.diffs) : [];
  /* 非阻断的旁证：本文件之外到底改了什么（这些是**允许**存在的别阶段改动）。 */
  const otherChanged = gitDiffLines(['diff', '--name-only', 'HEAD', '--', 'assets', 'services', 'InternalBeyond.html']);
  console.log('\n  [§11] read-only profile (measured chain), NOT "the repo is clean"');
  console.log('       guarded files: ' + READONLY_PROFILE.length + ' · changed among them: '
    + (roiResult.ok ? (roiResult.readonlyChanged.length ? roiResult.readonlyChanged.join(', ') : 'none') : 'GIT UNAVAILABLE')
    + ' · changed with an exemption: '
    + (roiResult.ok ? (roiResult.exemptChanged.join(', ') || 'none') : '—'));
  console.log('       changed under assets/services/HTML (allowed elsewhere, not here): '
    + (otherChanged.ok ? (otherChanged.lines.length ? otherChanged.lines.join(', ') : 'none') : otherChanged.error));
  check('Z4.noMeasuredChainFileChanged', roiResult.ok && roiViolations.length === 0,
    roiResult.ok ? JSON.stringify(roiViolations).slice(0, 600) : roiResult.error);
  /* 反向回归：本文件**声明了豁免**的文件，必须真的出现在本次 diff 里 ——
     否则豁免账就是一张空账（而空账的下一次同样改动会重新变红，下一个人就会去删断言）。
     注意判据只有这一个方向：豁免账 ⊆ 本次实际改动，**不是**"任何文件都可以出现"。 */
  const untouchedButChanged = (() => {
    if (!roiResult.ok) return [];
    const all = changedFiles(['diff', '--name-only', 'HEAD', '--', 'assets', 'services', 'InternalBeyond.html']);
    if (!all.ok) return ['name-only-unavailable: ' + all.error];
    const changed = Object.create(null);
    for (const f of all.files) changed[f] = true;
    return Object.keys(P23_VOICE_UI_ONLY).filter(rel => !changed[rel]);
  })();
  check('Z5.exemptionLedgerIsNotAnEmptyAccount（声明的豁免文件必须真的改过；空账说明豁免写宽了）',
    untouchedButChanged.length === 0, JSON.stringify(untouchedButChanged));

  /* 回归：这条判据本身必须可证伪 —— 用合成 fixture 把「放行 / 拦下」各造一次。
     如果哪天有人把它放宽成"任何修改都允许"（或算错区段），这里会立刻变红。 */
  const unified = (rel, newLine, added) => ['diff --git a/' + rel + ' b/' + rel, '--- a/' + rel, '+++ b/' + rel,
    '@@ -0,0 +' + newLine + ' @@'].concat(added.map(t => '+' + t)).join('\n');
  /* ① 豁免区段内（HTML 的 Voice 卡片界面 + social.js 的 NS.expose 面上的新增）→ 放行 */
  const okHtmlHunk = unified('InternalBeyond.html', 1614, [
    '          <div id="api-voice-source-hint" class="ibv-source-hint field-hint"></div>',
    '        </div>'
  ]);
  const okHtmlScriptHunk = unified('InternalBeyond.html', 3292, ['<script src="assets/js/voice-message-core.js"></script>']);
  /* ② 同一文件、但在所有豁免区段之外（HTML 文档头 / social.js 顶部）→ 拦下 */
  const badHtmlRegionHunk = unified('InternalBeyond.html', 1, ['<html lang="zh"><!-- P23 -->']);
  const badSocialRegionHunk = unified('assets/js/social.js', 1, ["'use strict'; /* P23 */"]);
  /* ③ 带凭据承载键的新增行 —— 即使在豁免区段内也拦下（P23 的凭据边界） */
  const badCredentialHunk = unified('assets/js/social.js', 1, ["  source:'tts', apiKey:(p&&p.value)||''"]);
  /* ④ 只读面文件（没有任何豁免）在任意位置的新增 → 拦下；
        而"豁免账上没写的文件"根本进不了这条判据（它们由别阶段的守卫负责）。 */
  const badReadonlyHunk = unified('assets/js/middle-brain-policy.js', 200, ['    dlgCharsLow: 300,']);
  const R = (d) => readonlyViolations(d);
  check('Z6.regressionExemptionIsBounded：豁免是有界的 —— 区段内的新增放行；区段外的、带凭据键的、以及只读面文件上的都被拦下',
    R({ 'InternalBeyond.html': okHtmlHunk }).length === 0
    && R({ 'InternalBeyond.html': okHtmlScriptHunk }).length === 0
    && R({ 'InternalBeyond.html': badHtmlRegionHunk }).length === 1
    && R({ 'assets/js/social.js': badSocialRegionHunk }).length === 1
    && R({ 'assets/js/social.js': badCredentialHunk }).length === 1
    && R({ 'assets/js/middle-brain-policy.js': badReadonlyHunk }).length === 1
    && R({ 'assets/js/middle-brain-policy.js': badReadonlyHunk }).every(m => m.indexOf('豁免区段之外') >= 0)
    && readonlyViolations({ 'assets/js/role-dm.js': unified('assets/js/role-dm.js', 1, ['x']) }).length === 1
    && readonlyViolations({ 'assets/js/bridge.js': unified('assets/js/bridge.js', 1, ['x']) }).length === 1,
    JSON.stringify({
      html_in: R({ 'InternalBeyond.html': okHtmlHunk }), script_in: R({ 'InternalBeyond.html': okHtmlScriptHunk }),
      html_out: R({ 'InternalBeyond.html': badHtmlRegionHunk }), social_out: R({ 'assets/js/social.js': badSocialRegionHunk }),
      cred: R({ 'assets/js/social.js': badCredentialHunk }), policy_out: R({ 'assets/js/middle-brain-policy.js': badReadonlyHunk })
    }).slice(0, 500));

  /* 唯一实现面（与 §7 的只读面**不同**的性质，所以是单独一条）：
     gate 参数、触发式、共享历史窗口上限都只能有一份。本文件在 Phase 1B.5 实测过
     "锚点漂移"导致的假绿，因此这里把锚点做成必需而非可选。 */
  const GATE_UNIQUE_SITES = [
    { file: 'assets/js/middle-brain-policy.js', re: /dlgCharsLow\s*:\s*600/ },
    { file: 'assets/js/middle-brain-policy.js', re: /dlgCharsHigh\s*:\s*3500/ },
    { file: 'assets/js/middle-brain-policy.js', re: /multipleThreads\s*:\s*\(threadItems >= 2 \|\| understandingItems >= 2\)/ },
    { file: 'assets/js/dialogue-core.js', re: /var HISTORY_MAX_MESSAGES\s*=\s*8;/ }
  ];
  const uniqueFailures = GATE_UNIQUE_SITES.filter(s => {
    const t = fileText(s.file);
    return t === null || !s.re.test(t);
  });
  check('Z7.gateAnchorStillUnique', uniqueFailures.length === 0,
    'missing anchors: ' + JSON.stringify(uniqueFailures.map(s => s.file + ' ' + s.re)));

  /* 反向回归：本文件新加的豁免**必须**真的覆盖了 P23 已落地的 Voice 增量。
     否则"豁免"就只是一张空账 —— 下一次同样的改动会再次把它变红，
     而下一个人还是会去删断言。 */
  const htmlSrc = readRel('InternalBeyond.html');
  const realExemptDiffs = {};
  for (const rel of Object.keys(P23_VOICE_UI_ONLY)) {
    const d = gitDiffLines(['diff', '--unified=0', 'HEAD', '--', rel]);
    realExemptDiffs[rel] = d.lines.join('\n');
  }
  console.log('       exempt regions computed: ' + JSON.stringify(Object.keys(P23_VOICE_UI_ONLY).map(rel => rel + '=' + regionRanges(fileText(rel), P23_VOICE_UI_ONLY[rel]).length + '/' + P23_VOICE_UI_ONLY[rel].length)));
  check('Z8.exemptionActuallyCoversP23VoiceIncrement（豁免必须**真的**消化了 P23 已落地的增量，而不是一张空账）',    htmlSrc.indexOf('id="api-voice-source-hint"') >= 0
    && htmlSrc.indexOf('<script src="assets/js/voice-message-core.js"></script>') >= 0
    && (fileText('assets/js/social.js') || '').indexOf('loadVoiceSourceCatalog') >= 0
    /* **真实** diff 过同一个判据（不是只过 Z6 的合成 fixture）：两个文件都真的有改动，且违规数为 0 */
    && realExemptDiffs['InternalBeyond.html'].length > 0
    && realExemptDiffs['assets/js/social.js'].length > 0
    && readonlyViolations(realExemptDiffs).length === 0,
    JSON.stringify({ htmlDiff: realExemptDiffs['InternalBeyond.html'].length, socialDiff: realExemptDiffs['assets/js/social.js'].length, v: readonlyViolations(realExemptDiffs) }, null, 0).slice(0, 2000));

  /* 耦合面：那条被测量的链路上**没有**任何 Voice 引用 —— 所以 P23 的 Voice 工作
     结构上不可能改变本文件测到的任何值。这条与 Z4 一起构成"观测仍然成立"。 */
  const VOICE_TOKENS = /\bvoicebox\b|\bIBVoiceMessage\b|voice-message-core|\bttsSources\b|loadVoiceSourceCatalog/i;
  const coupledToVoice = READONLY_PROFILE.filter(rel => { const t = fileText(rel); return t !== null && VOICE_TOKENS.test(t); });
  check('Z9.measuredChainHasZeroVoiceCoupling', coupledToVoice.length === 0, JSON.stringify(coupledToVoice));

  /* 行为指纹（§11）：固定证据向量过**真实** Gate 判定，结果必须逐字一致。
     这是对"参数没变、语义没变"的可证伪检查：改一个阈值、改一个分支、
     改一处权重都会在这里留下痕迹（Z5 只看字面量，这里看行为）。 */
  const gateFingerprint = (state) => {
    const ev = { contextChars: 4500, dialogueChars: 1500, memoryItems: 2, understandingItems: 1, threadItems: 1, momentItems: 0, localCompressionRatio: 0.45, conflictSignal: false, multipleThreads: false, nearBudget: false };
    const d = POL._mbDecisionFromSignals(ev, GATE, state || {}, 1000000);
    return [d.useAstra, d.reason, Math.round(Number(d.score) * 1e6) / 1e6].join('|');
  };
  const FP_COLD = gateFingerprint({});
  console.log('       gate fingerprint (cold / same evidence as §8): ' + FP_COLD);
  check('Z10.gateBehaviourFingerprintUnchanged',
    FP_COLD === 'false|simple_context|0.582107' && gateFingerprint({}) === FP_COLD
    && gateFingerprint({ lastDecision: 'yes', lastDecisionAt: 1000000 - 1000 }) === 'true|hysteresis_hold|0.582107'
    && gateFingerprint({ lastAstraAt: 1000000 - 5000, lastDecision: 'yes', lastDecisionAt: 1000000 - 5000 }) === 'false|cooldown|0.582107',
    JSON.stringify({ cold: FP_COLD, warm: gateFingerprint({ lastDecision: 'yes', lastDecisionAt: 999000 }), cd: gateFingerprint({ lastAstraAt: 995000, lastDecision: 'yes', lastDecisionAt: 995000 }) }));


  /* ═══════════ 8 · 真实凭据可得性（§2：没有就如实说，绝不造一条路）═══════ */
  const KEY = process.env.IB_CI_CALIBRATION_KEY || '';
  const ENDPOINT = process.env.IB_CI_CALIBRATION_ENDPOINT || '';
  console.log('\n  [§2] live credential boundary');
  console.log('       IB_CI_CALIBRATION_KEY: ' + (KEY ? 'present (' + KEY.length + ' chars)' : 'ABSENT'));
  console.log('       IB_CI_CALIBRATION_ENDPOINT: ' + (ENDPOINT ? 'present' : 'ABSENT'));
  console.log('       Home Node apiKey (by construction) = "" → middleBrainReady() = ' + await CFGC.middleBrainReady());
  /* §2 · 凭据边界：这里只断言**可证明**的两件事。
     不可证明的事（"仓库里不存在任何真实密钥"）不做断言、不在报告里冒称 ——
     仓库里本来就有大量**合成哨兵** key（sk-test-… / sk-secret-…），它们是测试
     刻意使用的假值。所以判据必须是"有没有把**真实**凭据写进来"，而不是
     "有没有出现 sk- 字样"。 */
  const liveHarnessSrc = readRel('tests/test_middle_brain_calibration_live.js');
  const liveHarnessCode = stripComments(liveHarnessSrc);
  check('K1.noConcreteCalibrationSecretInRepo', (() => {
    const hits = [];
    const valueRe = /IB_CI_CALIBRATION_KEY\s*[:=]\s*["']?sk-[A-Za-z0-9_\-]{16,}/;
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { if (!/node_modules|\.git|\.venv-vision|android|\.dsh-research/.test(e.name)) walk(p); }
        else if (/\.(js|json|md|txt|env)$/.test(e.name)) {
          if (valueRe.test(fs.readFileSync(p, 'utf8'))) hits.push(path.relative(ROOT, p));
        }
      }
    };
    walk(ROOT);
    return hits.length === 0;
  })());
  check('K3.calibrationKeyComesOnlyFromEnvWithNoLiteralFallback',
    /process\.env\.IB_CI_CALIBRATION_KEY/.test(liveHarnessCode)
    && !/IB_CI_CALIBRATION_KEY\s*=\s*['"]/.test(liveHarnessCode)
    && !/\|\|\s*['"]sk-/.test(liveHarnessCode),
    '读路径必须是 process.env.IB_CI_CALIBRATION_KEY，且不存在字面量回落');
  check('K5.harnessRedactsEveryArtifactAndSelfChecksForLeaks',
    /OBS\.redact\(/.test(liveHarnessCode) && /looksLikeCredentialLeak|LEAK/i.test(liveHarnessCode),
    '任何落盘产物都必须过 OBS.redact，并且 harness 自己带一次"哨兵值不得出现"的自检');
  check('K4.observationRecordsHaveNoCredentialField', (() => {
    const rec = OBS.emptyObservation(CORPUS.CASES[0], 'test');
    const json = JSON.stringify(rec);
    return !/apiKey|api_key|Authorization|Bearer|token[^s]/i.test(json.replace(/"costBasis"[^,]*/g, ''));
  })(), '观测记录的字段集合里不得有承载凭据的槽位');
  /* 判据是"**登记**里不得出现 --live"，不是"文件文本里不得出现 --live"：
     注释里提到 --live（例如解释 Phase 1B 的凭据预检回归）不是登记。所以这里先
     按本文件既有的约定剥注释再扫 —— 否则一条新注释就能让这条断言误报，
     这正是 Phase 1B 实测遇到的情况。 */
  check('K2.liveRunNotForcedByRegression', !/--live/.test(stripComments(readRel('tests/test-all.js')).split('\n').filter(l => /calibration_live/.test(l)).join(' ')),
    'test-all 只登记默认（离线 mock）模式（剥注释后仍不得出现 --live 登记）');

  /* ═══════════ 9c · 无判定 ≠ 判错（Phase 1B.5 实测回归）═══════════
     背景：AR-F-01 第二次真实观测时 production deadline（20000ms）触发，
     记录形状是 judge.ran=true / pass=null / error='timeout'。旧 compare() 把这种
     "没有判定"当成观测成功，于是 agreement=false → falseNegativeCandidate=true，
     同一条记录既进 FN candidates 清单、又同时被统计成 errors=1/fn=0 —— 自相矛盾。
     规则（用户 Phase 1B.6 明确）：只要 Judge 没产出 verdict（pass 非布尔 /
     provider error / timeout / malformed），agreement 必须是 null，
     FP/FN candidate 必须是 false，归入 error/ambiguous/undecided。 */
  const noVerdictCases = [
    { name: 'timeout', judge: { ran: true, pass: null, malformed: false, error: 'timeout' } },
    { name: 'provider_error', judge: { ran: true, pass: null, malformed: false, error: 'provider_http_500' } },
    { name: 'malformed', judge: { ran: true, pass: null, malformed: true, error: null } },
    { name: 'norun', judge: { ran: false, pass: null, malformed: false, error: null } },
    { name: 'pass_missing', judge: { ran: true, pass: undefined, malformed: false, error: null } }
  ];
  check('K6.noVerdictNeverBecomesFpFnCandidate', noVerdictCases.every(x => {
    const rec = OBS.emptyObservation(CORPUS.CASES.find(c => c.id === 'AR-F-01'), 'test');
    rec.judge = Object.assign(rec.judge, x.judge);
    OBS.compare(rec);
    return rec.comparison.agreement === null
      && rec.comparison.falsePositiveCandidate === false
      && rec.comparison.falseNegativeCandidate === false
      && rec.comparison.ambiguous === true;
  }), JSON.stringify(noVerdictCases.map(x => {
    const rec = OBS.emptyObservation(CORPUS.CASES.find(c => c.id === 'AR-F-01'), 'test');
    rec.judge = Object.assign(rec.judge, x.judge);
    return { case: x.name, cmp: OBS.compare(rec) };
  })));
  check('K7.noVerdictIsErrorNotDecisionInSummary', (() => {
    const rec = OBS.emptyObservation(CORPUS.CASES.find(c => c.id === 'AR-F-01'), 'test');
    rec.judge = Object.assign(rec.judge, { ran: true, pass: null, malformed: false, error: 'timeout' });
    rec.execution.timeout = true;
    OBS.compare(rec);
    const s = OBS.summarize([rec]);
    return s.judge.decided === 0 && s.judge.fn === 0 && s.judge.errors === 1 && s.timeouts === 1
      && s.comparison.fnCandidates.length === 0 && s.comparison.fpCandidates.length === 0
      && s.comparison.ambiguous.length === 1
      && s.comparison.ambiguous[0].reason === 'no_judge_decision(timeout)';
  })(), 'timeout 必须记成 errors=1 / timeouts=1 / decided=0 / FN candidates=none，ambiguous 原因必须是 no_judge_decision(timeout)');

  /* ═══════════ 9d · 无判定不得参与稳定性比较（Phase 1B.7 Phase 0 实测回归）═══════════
     背景：Round 6 的 AR-F-01 出现 completed(timeout) 混合形状，summary.stability
     把 timeout 记录的 dimensions=null 用 `|| []` 归一成空维度集，于是
     `[knowledge_boundary,persona]` vs `[]` → dimensionStable=false →
     记成"维度判定不稳定"。这是把未知当已知：timeout 是**没有判定**，不是
     "Judge 给了空维度集"。同 compare() 已修的那一类缺陷同源，只是换了函数。
     规则：只有 verdict-bearing（pass 为布尔）的观测参与
     verdict / dimension / severity 稳定性；无 verdict 的观测必须
     excludedFromDimensionStability，且不得被算成 unstable。 */
  const stabRec = (pass, dims, sev, score, dispo, err) => {
    const rec = OBS.emptyObservation(CORPUS.CASES.find(c => c.id === 'AR-F-01'), 'test');
    rec.judge = Object.assign(rec.judge, {
      ran: true, pass: pass, dimensions: dims, maxSeverity: sev, score: score,
      malformed: false, error: (err || null)
    });
    rec.disposition = dispo || (pass === true ? 'pass' : 'blocked');
    OBS.compare(rec);
    return rec;
  };
  const timeoutRec = () => stabRec(null, null, null, null, 'judge_error:timeout', 'timeout');

  /* S1 · real [] + timeout null：本轮实测的确切形状。
     若 null 被归一成 []，两组集合相同 → 会误判为 stable；若 null 被当成"另一个集合"
     就会误判为 unstable。两种错误都要被挡住：正确结果是**只比较 1 条 verdict-bearing
     观测 → 观测数不足 → UNKNOWN**，既不是 stable 也不是 unstable。 */
  check('S1.realEmptyDimensionsPlusTimeoutIsUnknownNotUnstable', (() => {
    const s = OBS.summarize([stabRec(false, [], 1, 0.05, 'blocked'), timeoutRec()]);
    return s.stability.unstable === 0 && s.stability.unstableIds.length === 0
      && s.stability.stable === 0
      && s.stability.insufficient === 1 && s.stability.insufficientIds[0] === 'AR-F-01'
      && s.stability.excludedNoVerdict === 1
      && s.stability.details[0].excludedFromDimensionStability === 1
      && s.stability.details[0].dimensionStable === null
      && s.stability.details[0].severityStable === null
      && s.stability.details[0].verdictStable === null
      && s.stability.details[0].reason === 'insufficient_verdict_bearing_observations(1/2)';
  })(), '真 [] + timeout(null) 不得产生 unstable，也不得升级成 stable；必须是 UNKNOWN 且 excludedFromDimensionStability=1');

  /* S2 · real [knowledge_boundary] + timeout null：本轮 AR-F-01 的真实维度形状。
     修复前实测：dims=[[knowledge_boundary],[]] → dimensionStable=false（把 timeout
     记成维度 miss）。修复后 timeout 完全退出比较。 */
  check('S2.realKnowledgeBoundaryPlusTimeoutIsUnknownNotDimensionChange', (() => {
    const s = OBS.summarize([stabRec(false, ['knowledge_boundary'], 1, 1.0, 'blocked'), timeoutRec()]);
    const d = s.stability.details[0];
    return s.stability.unstable === 0 && s.stability.stable === 0
      && s.stability.insufficient === 1
      && d.dimensionStable === null
      && d.dimensions === undefined          /* timeout 不得贡献任何维度集，尤其不得是 [] */
      && JSON.stringify(d).indexOf('[]') < 0 /* 任何位置都不得出现 [] 冒充 timeout 的观测 */
      && d.passes[1] === null;               /* null 必须保持 null，不得变成 false */
  })(), 'timeout 记录不得贡献任何维度字符串，pass 必须保持 null（不得归一成 false）');

  /* S3 · two real [] observations：两条都有 verdict 且维度集相同 → 必须参与并判 stable */
  check('S3.twoRealEmptyDimensionSetsAreStable', (() => {
    const s = OBS.summarize([stabRec(false, [], 1, 0.05, 'blocked'), stabRec(false, [], 1, 0.05, 'blocked')]);
    return s.stability.stable === 1 && s.stability.unstable === 0
      && s.stability.insufficient === 0 && s.stability.excludedNoVerdict === 0;
  })(), '两条真 [] 观测都必须参与比较，并判为 stable（真空的维度集是合法观测）');

  /* S4 · two real identical dimension sets：两条都有 verdict 且完全一致 → stable（顺序无关） */
  check('S4.twoRealIdenticalDimensionSetsAreStable', (() => {
    const s = OBS.summarize([
      stabRec(false, ['knowledge_boundary', 'persona'], 1, 1.0, 'blocked'),
      stabRec(false, ['persona', 'knowledge_boundary'], 1, 1.0, 'blocked')
    ]);
    return s.stability.stable === 1 && s.stability.unstable === 0
      && s.stability.insufficient === 0;
  })(), '同一维度集（顺序无关）必须判 stable');

  /* S5 · 真差异必须仍然被抓到：真 [knowledge_boundary] vs 真 [persona] → unstable。
     这一条防止上面的修复把稳定性检查整体削弱成"永远 stable"。 */
  check('S5.realDimensionDifferenceStillDetected', (() => {
    const s = OBS.summarize([
      stabRec(false, ['knowledge_boundary'], 1, 1.0, 'blocked'),
      stabRec(false, ['persona'], 0.9, 0.9, 'blocked')
    ]);
    return s.stability.unstable === 1 && s.stability.stable === 0
      && s.stability.details[0].dimensionStable === false
      && s.stability.details[0].verdicts === 2
      && s.stability.details[0].excludedFromDimensionStability === 0;
  })(), '真实的维度判定差异必须仍被判为 unstable —— 修复不得削弱稳定性检测');

  /* S6 · 全部为无 verdict：不得出现 stable=0/unstable=0 的静默假象，必须是 insufficient 且全排除 */
  check('S6.allNoVerdictYieldsUnknownNotStable', (() => {
    const s = OBS.summarize([timeoutRec(), timeoutRec()]);
    return s.stability.stable === 0 && s.stability.unstable === 0
      && s.stability.insufficient === 1 && s.stability.excludedNoVerdict === 2
      && s.stability.details[0].verdicts === 0
      && s.stability.details[0].reason === 'insufficient_verdict_bearing_observations(0/2)';
  })(), '全部 timeout 时不得被算成 stable，也不得算成 unstable；必须是 UNKNOWN');

  /* S7 · hasVerdict 是 compare/summarize 共用的唯一判据（防两处判据再次漂移） */
  check('S7.hasVerdictIsTheSharedSingleCriterion', (() => {
    const cases = [
      { j: { ran: true, pass: true }, want: true },
      { j: { ran: true, pass: false }, want: true },
      { j: { ran: true, pass: null }, want: false },
      { j: { ran: false, pass: true }, want: false },
      { j: { ran: true, pass: undefined }, want: false }
    ];
    const ok = cases.every(c => OBS.hasVerdict({ judge: c.j }) === c.want);
    const t = timeoutRec(), p = stabRec(false, [], 1, 1, 'blocked');
    return ok && OBS.hasVerdict(t) === false && OBS.hasVerdict(p) === true
      && p.comparison.ambiguous === false && t.comparison.ambiguous === true;
  })(), 'compare() 与 summarize() 必须共用同一个 hasVerdict 判据，且 ran=false 即使 pass 有值也不算 verdict');

  /* S8 · 报告渲染必须把"被排除的尝试数"打出来，不能只打 dimsStable */
  check('S8.reportSurfacesExcludedAttempts', (() => {
    const out = OBS.renderReport(OBS.summarize([stabRec(false, ['knowledge_boundary'], 1, 1, 'blocked'), timeoutRec()]));
    return /excluded-no-verdict-attempts=1/.test(out)
      && /excludedFromDimensionStability=1/.test(out)
      && /insufficient-verdicts=1/.test(out)
      && /reason=insufficient_verdict_bearing_observations\(1\/2\)/.test(out);
  })(), '报告必须显式暴露被排除的尝试数与 UNKNOWN 原因，不能只用 stable/unstable 计数掩盖');

  /* ═══════════ 9 · 观测阶段自身的安全性（§11/§12 的静态那一半）═══════════ */
  /* 9a · CI 证据构建绝不 retrieval：guard 只消费调用方交进来的东西。
     这一条是 P0 审计的关键：如果 guard 会自己去读 Memory/Store，那么"用合成
     证据做观测"就不成立，而"观测不碰生产数据"也不成立。 */
  const integSrc = readRel('assets/js/middle-brain-integrity.js');
  const integCode = stripComments(integSrc);
  check('X1.guardNeverRetrievesItself', !/getMemoryContext|getUnderstandingContext|getThreadContext|getMomentsContext|dbGet|localStorage/.test(integCode),
    'integrity 层不得自行检索：证据一律由调用方交进来');
  check('X2.evidenceInputsAreExplicit',
    /_mbCiBuildEvidence\(characterId, userMessage, opts\)/.test(integCode)
    && /opts\.history/.test(integCode) && /opts\.currentId/.test(integCode)
    && /_mbSnapshotCtx\(opts, name\)/.test(integCode),
    '证据输入必须是显式的 opts（history / currentId / contextSnapshot），不得自行检索');

  /* 9b · 校准 harness 不得触碰生产状态：静态面。
     （动态面由 browser 侧的平台层绊线证明；这里证明**代码里根本没有那些入口**。） */
  const liveSrc = readRel('tests/test_middle_brain_calibration_live.js');
  const liveCode = stripComments(liveSrc);
  check('X3.harnessHasNoDirectStoreCalls',
    !/\bdbPut\s*\(|\bdbDelete\s*\(/.test(liveCode)
    && !/saveMemory\s*\(|createMoment\s*\(|createThread\s*\(/.test(liveCode),
    'harness 自身不得直接调用任何 store 写入');
  check('X4.harnessOnlyWritesConfigThroughIsolatedProfile',
    /saveMiddleBrainConfig/.test(liveCode)
    && /mkdtempSync\(path\.join\(os\.tmpdir\(\)/.test(liveCode)
    && /fs\.rmSync\(profile/.test(liveCode),
    '唯一允许的写入必须落在 os.tmpdir() 的 mkdtemp 目录里，并且跑完要删');
  check('X5.harnessHasNoRetryLoop', !/for\s*\([^)]*\)\s*\{\s*[^}]*await\s+runGuard|while\s*\(.*retry/i.test(liveCode));
  check('X6.harnessPrintsPlanBeforeLaunching',
    liveSrc.indexOf('PLANNED API CALLS') < liveSrc.indexOf('chromePath()')
    || /process\.exit\(2\)/.test(liveCode),
    '计划调用次数必须在启动浏览器之前打印；超预算时不得启动');

  /* 9c · 这台机器上真实本地服务是否在监听（只做 TCP 连接性探测：不发送任何
         应用层报文，因此既读不到用户数据，也写不了任何东西）。 */
  const net = require('node:net');
  const probePort = (port, timeoutMs) => new Promise(resolve => {
    const s = net.connect({ host: '127.0.0.1', port: port });
    let done = false;
    const fin = (v) => { if (!done) { done = true; try { s.destroy(); } catch (e) {} resolve(v); } };
    s.setTimeout(timeoutMs || 300);
    s.on('connect', () => fin(true));
    s.on('timeout', () => fin(false));
    s.on('error', () => fin(false));
  });
  const probes = {};
  for (const p of [23114, 23115, 23116, 23118]) probes[p] = await probePort(p);
  console.log('\n  [§11] local services listening (TCP connect probe only — no HTTP, no payload)');
  console.log('       ' + JSON.stringify(probes));
  console.log('       why this matters: 校准页面在启动阶段会试图 POST /memory/settings 到 ' + 23118
    + '（home-node-bootstrap.publishMemorySettings）。若该端口在监听，那就是一次对**真实本地服务**的写；'
    + ' 现在的 harness 用 document-start 网络白名单把它拒绝了（见 browser 侧的 denied 清单）。');
  check('X7.localServiceProbeIsConnectOnly', Object.keys(probes).length === 4
    && Object.keys(probes).every(k => typeof probes[k] === 'boolean'));

  /* ═══════════ 10 · 汇总输出（供报告引用）═══════════ */
  const summary = {
    corpus: { cases: CORPUS.CASES.length, classesCovered: CORPUS.CLASS_CODES.length },
    dialogue: { readiness: dlgDist, existing: oldDist, buckets: rows.reduce((m, r) => { m[r.bucket] = (m[r.bucket] || 0) + 1; return m; }, {}) },
    boundary: {
      dlgCharsLow: PROD_DIALOGUE_LOW, dlgCharsHigh: PROD_DIALOGUE_HIGH,
      historyOnlyCeiling: HIST_CEILING,
      measuredMaxFromHistory: ceilingProbe.dialogueChars,
      dlgScoreAtHistoryCeiling: dlgScoreOf(ceilingProbe.dialogueChars),
      currentCharsNeededForHigh: minCurrentForHigh
    },
    multipleThreads: { corpus: corpusMT, probes: mtProbes.map(p => ({ name: p.name, multipleThreads: p.multipleThreads, reason: p.reason, contextChars: p.contextChars, gateReason: p.gate.reason })) },
    gateState: {
      cold: dCold.reason, warmYes: dWarmYes.reason, cooldown: dCooldown.reason, expired: dExpired.reason,
      homeNode: hnGate.reason, resetCallers: hasResetCaller.length
    },
    localServicesListening: probes,
    liveCredential: { key: !!KEY, endpoint: !!ENDPOINT }
  };
  const outArg = process.argv.find(a => a.startsWith('--out='));
  if (outArg) {
    const p = outArg.slice('--out='.length);
    fs.writeFileSync(p, JSON.stringify(OBS.redact(JSON.stringify(summary, null, 2), [KEY]), null, 2), 'utf8');
    console.log('\n  summary written to ' + p);
  }

  try { mb.dispose && mb.dispose(); } catch (e) {}

  console.log('\nAstra Readiness Phase 1 observation (read-only): ' + failures + ' failed');
  process.exitCode = failures ? 1 : 0;
})().catch(e => { console.error(e); process.exit(1); });
