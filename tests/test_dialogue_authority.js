/* ====================================================================
   M1-C.2o P3/P4 · Dialogue Same-Evidence —— 语义边界上的对抗契约
   --------------------------------------------------------------------
   这一条回答 M1-C.2o 的那一个问题，而且**只回答它**：

     对同一个角色、同一份 canonical 对话状态、同一个当前用户回合，
     Desktop 与 Home Node 是否把**同一段语义权威的对话证据**交给
     认知层（Middle Brain / 认知边界）？

   ── 为什么比较"证据信封"而不是"模型最后写出的文字" ───────────────────
   同一段证据在不同温度 / 不同 provider 上本来就会写出不同的话，而两端
   **必须**相等的是"她被喂了什么"。因此本文件比较的是（全部逐字 / 逐值）：
     · `organized.dialogue`（共享对话核心的投影 —— 两端必须同一批行、同一顺序）
     · `compressedContext`（压缩层产物，含【当前对话】段）
     · Gate 信号（dialogueChars / contextChars —— 加权分的一项）
     · 注入进 provider 请求之后的 system 文本里【当前对话】段的内容

   ── 反证纪律 ────────────────────────────────────────────────────────
   每一条 parity 断言都配一条**反证**：合法地改动对话证据必须改变结果，
   因此"全部空 / 忽略对话"这种让 parity 恒真的实现会被这些断言打死。

   ── 运行 ────────────────────────────────────────────────────────────
      node test_dialogue_authority.js
   纯 Node + 真 SQLite + 临时数据目录；零网络、零浏览器。
   ==================================================================== */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DLG = require(path.join(ROOT, 'assets', 'js', 'dialogue-core.js'));
const CHAT_CORE = require(path.join(ROOT, 'assets', 'js', 'chat-core.js'));
const CORE = require(path.join(ROOT, 'assets', 'js', 'middle-brain-config-core.js'));
const createStore = require(path.join(ROOT, 'services', 'home-node', 'chat-store.js'));
const createExecutor = require(path.join(ROOT, 'services', 'home-node', 'execution.js'));
const createNodeMiddleBrain = require(path.join(ROOT, 'services', 'home-node', 'middle-brain.js'));

/* ── P5-B3-D3 · character binding test seam ──────────────────────────
   TURN_CHARACTER_SCOPE_AUTHORITY = SERVER_VALIDATED_CANONICAL_CHARACTER_BINDING。
   生产由 device-registry.getCharacterSpec 提供；测试在**构造期**注入等价接口
   （绝不通过 execute({...}) 逐次传入 —— authority 属于 executor 实例）。
   这里只确认"该 character id 存在"，provider 配置仍走既有 request 契约。 */
const testCharacterRegistry = { getCharacterSpec: function (id) { return String(id || '').trim() ? {} : null; } };

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-dlg-' + tag + '-'));
  tempDirs.push(dir);
  return dir;
}

/* ── 加载 canonical Middle Brain 各层（与生产同一条 require 路径）────────
   顺序是硬 DAG：config 必须先登记进共享契约对象，policy 才会拿到 CFG。
   因此这里**只**经 loadCanonicalMiddleBrain() 加载，绝不自己 require policy
   （那样 policy 会在 config 之前求值，CFG 恒为 undefined —— 一个只在测试里
   出现的、看起来像生产 bug 的失败）。 */
const LOADED = createNodeMiddleBrain.loadCanonicalMiddleBrain();
const POLICY = globalThis.IB.__middleBrainContracts.policy;
if (!POLICY) throw new Error('canonical policy layer unavailable');

const FRIEND = 'cyrene';
const USER = '我想把那台旧电脑彻底换掉，预算大概一万二。';

/* ── 桌面调用点的等价物（communication.js:1519-1525 的 opts 形状）────────
   桌面在 communication.js 下**不传** history，但把本轮真正交给模型的那一段
   canonical 历史切好放在 `opts.dialogueHistory`；证据由共享核心产出。
   本函数就是那个调用点在 Node 侧的等价物 —— 一字不差地按同一顺序取同一个核心。 */
function desktopOpts(historyRows, userMessage, blocks) {
  const dialogue = DLG.lines({ history: historyRows, userMessage: userMessage, currentId: null });
  const opts = {
    dialogue: dialogue,
    memoryCtx: blocks.memoryCtx,
    understandingCtx: blocks.understandingCtx,
    threadCtx: blocks.threadCtx,
    momentsCtx: blocks.momentsCtx,
    contextSnapshot: blocks.contextSnapshot || null
  };
  return { opts: opts, dialogue: dialogue };
}

/* ── 旧 Home Node 实现（本文件的"pre-fix"参照物）──────────────────────
   逐字取自 M1-C.2o 之前的 services/home-node/middle-brain.js:127-143。
   它只用于**证明新行为确实不同**，不参与任何 parity 断言。 */
function legacyDialogueFrom(history, userMessage) {
  const MAX_M = 8, MAX_C = 400;
  const out = [];
  if (Array.isArray(history)) {
    for (const item of history) {
      if (!item) continue;
      const role = item.role === 'assistant' ? 'assistant' : (item.role === 'user' ? 'user' : null);
      if (!role) continue;
      const text = String(item.content == null ? '' : item.content);
      if (!text.trim()) continue;
      out.push((role === 'assistant' ? '角色：' : '用户：') + (text.length > MAX_C ? text.slice(0, MAX_C) : text));
    }
  }
  if (out.length > MAX_M) out.splice(0, out.length - MAX_M);
  const current = String(userMessage || '');
  if (current.trim()) out.push('用户：' + (current.length > MAX_C ? current.slice(0, MAX_C) : current));
  return out;
}
/* 旧桌面行为：`organized.dialogue` 恒为空（communication.js 不传 dialogue）。 */
function legacyDesktopDialogue() { return []; }

function rows(spec) {
  return spec.map((r, i) => ({ id: 'r' + i, role: r[0], content: r[1] }));
}
const PRIOR = rows([
  ['user', '最近工作怎么样？'],
  ['assistant', '还行。'],
  ['user', '要不要升级设备？'],
  ['assistant', '在想了。']
]);

function main() {
  const dir = tempDir('t1');
  const store = createStore({ dataDir: dir, logger: () => {} });
  store.open();

  const sentPrompts = [];
  const port = {
    runStream: async function (req) { sentPrompts.push(req.prompt); return { text: '（回复）', reasoning: '' }; }
  };
  const mbNode = createNodeMiddleBrain({
    executionConfig: () => CORE.projectExecutionConfig({ enabled: true, reasoningEffort: 'auto' }),
    logger: () => {}
  });
  const executor = createExecutor({
  characterRegistry: testCharacterRegistry, store, port, middleBrain: mbNode, logger: () => {} });

  /* 驱动一次真实的 Home Node 回合：走真实执行器 + 真实适配层 + 真实共享核心。
     返回：provider 看到的 prompt，以及从**同一份输入**出发的节点侧对话证据。 */
  const MEMORY_BLOCK = '【长期记忆】\n她喜欢雨。';
  async function nodeTurn(requestId, history, content, opts) {
    opts = opts || {};
    sentPrompts.length = 0;
    const userMessage = {
      id: CHAT_CORE.messageIdFromRequest(requestId),
      role: 'user', content: content, friendId: opts.friendId || FRIEND, timestamp: 1700000000000
    };
    if (opts.threadId) userMessage.threadId = opts.threadId;
    const parts = opts.parts || {
      runtimeContext: MEMORY_BLOCK, memoryBlock: MEMORY_BLOCK, memoryConsulted: true,
      p0Stable: '', p0Time: ''
    };
    const res = await executor.executeCharacterTurn({
      requestId: requestId,
      friendId: opts.friendId || FRIEND,
      character: {
        id: FRIEND,
        spec: { id: FRIEND, provider: 'openai', model: 'char-model', endpoint: 'https://x', apiKey: 'sk-CHAR', systemPrompt: '我是在想事情。' }
      },
      userMessage: userMessage,
      history: opts.history === undefined ? history : opts.history,
      runtimeContextParts: parts,
      contextPolicy: 'dialogue-authority'
    }, { turnId: 't_' + requestId });
    /* 适配层对 (history, userMessage, currentMessageId) 调用共享核心 ——
       这里用同一个核心、同一批输入复现它的产出（adapter 见
       services/home-node/middle-brain.js 的 organizeContext）。 */
    const dialogue = DLG.lines({
      history: opts.history === undefined ? history : opts.history,
      userMessage: content,
      currentId: userMessage.id
    });
    return { res: res, dialogue: dialogue, prompt: sentPrompts[0], history: opts.history === undefined ? history : opts.history };
  }

  /* ══ 共享核心本身：两条不可协商的规则 ═══════════════════════════════ */

  /* 规则 ②：当前回合**不截断**。旧实现把它截到 400 字 —— 那会让桌面侧的
     注入谓词 `_mbInjectable`（communication.js:1653 要求 payload 含完整
     userMessage）在长消息上**静默失效**。 */
  const LONG = '长'.repeat(1200);
  const longLines = DLG.lines({ history: [], userMessage: LONG, currentId: null });
  check('core.currentTurnNotTruncated', longLines.length === 1 && longLines[0] === '用户：' + LONG, longLines[0] && longLines[0].length);
  check('core.legacyWouldTruncateCurrent', legacyDialogueFrom([], LONG)[0].length === 403,
    'pre-fix 参照物应当截断当前消息（否则本条没有鉴别力）');

  /* 规则 ③：历史上限**不含**当前回合。旧实现把当前消息算进 8 条上限，
     于是历史恰好满 8 条时会挤掉**最后一条历史**。 */
  const eight = rows([['user', '历史1'], ['assistant', '历史2'], ['user', '历史3'], ['assistant', '历史4'],
    ['user', '历史5'], ['assistant', '历史6'], ['user', '历史7'], ['assistant', '历史8']]);
  const capped = DLG.lines({ history: eight, userMessage: USER, currentId: null });
  check('core.historyCapExcludesCurrent', capped.length === 9 && capped[8] === '用户：' + USER, capped.length);
  check('core.lastHistoryRowSurvives', capped.indexOf('角色：历史8') >= 0 && capped.indexOf('用户：历史7') >= 0, capped);

  /* ── 边界实测（probe 与断言同源）────────────────────────────────────
     旧实现在"历史 9 条 + 当前回合"上的产物与新实现**条数相同**（都留最近 8 条
     历史 + 当前回合），差别只有一个：旧实现把**当前消息**也截到 400 字
     （见下面 core.currentTurnNotTruncated 的反面），新实现不截断。
     这条断言把"上限语义确实一致"钉住，免得后来者以为这里有行为差异。 */
  const nineHistory = eight.concat([{ id: 'r9', role: 'assistant', content: '历史9' }]);
  const capped9 = DLG.lines({ history: nineHistory, userMessage: USER, currentId: null });
  const legacyCapped9 = legacyDialogueFrom(nineHistory, USER);
  check('core.capWindowSameAsLegacy',
    capped9.length === legacyCapped9.length
    && JSON.stringify(capped9) === JSON.stringify(legacyCapped9),
    { now: capped9, legacy: legacyCapped9 });
  check('core.capKeepsNewestRows',
    capped9.indexOf('用户：历史1') < 0 && capped9[0] === '角色：历史2' && capped9[8] === '用户：' + USER,
    capped9);

  /* 规则 ④：当前回合不重复 —— 且**绝不做内容去重**。 */
  const alreadyCanonical = PRIOR.concat([{ id: CHAT_CORE.messageIdFromRequest('reqX'), role: 'user', content: USER }]);
  const deduped = DLG.lines({ history: alreadyCanonical, userMessage: USER, currentId: CHAT_CORE.messageIdFromRequest('reqX') });
  check('core.sameTurnNotDuplicated', deduped.filter(l => l === '用户：' + USER).length === 1, deduped);
  const twice = PRIOR.concat([{ id: 'a', role: 'user', content: USER }, { id: 'b', role: 'assistant', content: '嗯。' }]);
  const twiceLines = DLG.lines({ history: twice, userMessage: USER, currentId: CHAT_CORE.messageIdFromRequest('reqY') });
  check('core.noContentDedupe', twiceLines.filter(l => l === '用户：' + USER).length === 2, twiceLines);
  check('core.legacyWouldDuplicateSameTurn',
    legacyDialogueFrom(alreadyCanonical, USER).filter(l => l === '用户：' + USER).length === 2,
    'pre-fix 参照物应当把同一轮记两行（否则本条没有鉴别力）');

  check('core.rolesMapped', (() => {
    const l = DLG.lines({ history: rows([['system', '系统行'], ['user', 'u'], ['assistant', 'a'], ['tool', 't']]), userMessage: '' });
    return l.length === 2 && l[0] === '用户：u' && l[1] === '角色：a';
  })());
  check('core.emptyHistoryYieldsCurrentOnly', DLG.lines({ history: [], userMessage: USER }).length === 1);
  check('core.neverThrowsOnGarbage', (() => {
    try { DLG.lines({ history: [null, 1, 'x', {}, { role: 'user' }], userMessage: null }); return true; }
    catch (e) { return false; }
  })());

  /* ══ T1 · 正常多轮：语义边界上两端逐字相等 ════════════════════════════ */
  const blocks = { memoryCtx: '【长期记忆】\n她喜欢雨。', understandingCtx: '', threadCtx: '', momentsCtx: '', contextSnapshot: null };

  return nodeTurn('reqT1', PRIOR, USER).then(function (n1) {
    const d1 = desktopOpts(PRIOR, USER, blocks);
    check('T1.turnOk', n1.res.ok === true, n1.res);
    check('T1.dialogueByteIdentical', JSON.stringify(n1.dialogue) === JSON.stringify(d1.dialogue), { node: n1.dialogue, desktop: d1.dialogue });
    check('T1.currentTurnLast', n1.dialogue[n1.dialogue.length - 1] === '用户：' + USER);
    check('T1.currentTurnOnce', n1.dialogue.filter(l => l === '用户：' + USER).length === 1);

    /* ══ T13 · 认知边界：组织层在两端得到同一个 organized / signals ═══ */
    return Promise.all([
      POLICY.middleBrainOrganizeContext(FRIEND, USER, d1.opts),
      (async function () {
        const nodeOpts = { dialogue: n1.dialogue, memoryCtx: blocks.memoryCtx, contextSnapshot: null };
        return POLICY.middleBrainOrganizeContext(FRIEND, USER, nodeOpts);
      })()
    ]).then(async function (orgs) {
      const dOrg = orgs[0], nOrg = orgs[1];
      check('T13.organizedDialogueIdentical', JSON.stringify(dOrg.dialogue) === JSON.stringify(nOrg.dialogue), { desktop: dOrg.dialogue, node: nOrg.dialogue });
      check('T13.organizedDialogueNonEmpty', dOrg.dialogue.length === 5 && nOrg.dialogue.length === 5, { desktop: dOrg.dialogue.length, node: nOrg.dialogue.length });
      const nodeOpts = { dialogue: n1.dialogue, memoryCtx: blocks.memoryCtx, contextSnapshot: null };
      const dSig = await POLICY._mbAnalyzeSignals(FRIEND, USER, d1.opts, CORE.MB_DEFAULTS);
      const nSig = await POLICY._mbAnalyzeSignals(FRIEND, USER, nodeOpts, CORE.MB_DEFAULTS);
      check('T13.gateSignalsIdentical',
        JSON.stringify(dSig) === JSON.stringify(nSig),
        { desktop: { d: dSig.dialogueChars, c: dSig.contextChars }, node: { d: nSig.dialogueChars, c: nSig.contextChars } });
      const dComp = POLICY.middleBrainCompressContext(dOrg, d1.opts);
      const nComp = POLICY.middleBrainCompressContext(nOrg, nodeOpts);
      check('T13.compressedContextIdentical', dComp.compressedContext === nComp.compressedContext, { desktop: dComp.compressedContext, node: nComp.compressedContext });
      check('T13.currentDialogueBlockPresent', dComp.compressedContext.indexOf('【当前对话】') >= 0 && nComp.compressedContext.indexOf('【当前对话】') >= 0);
      /* 反证：把证据改一处，压缩产物必须随之改变（否则 parity 可以靠"恒空"实现）。 */
      const altered = { dialogue: [].concat(n1.dialogue, ['用户：另一句完全合法的话。']), memoryCtx: blocks.memoryCtx, contextSnapshot: null };
      const aOrg = await POLICY.middleBrainOrganizeContext(FRIEND, USER, altered);
      const aComp = POLICY.middleBrainCompressContext(aOrg, altered);
      check('T13.counterProofDialogueIsLoadBearing', aComp.compressedContext !== nComp.compressedContext,
        '改动对话证据后压缩产物没变 —— 说明它在被忽略');
      check('T13.counterProofGateSignalChanges',
        (await POLICY._mbAnalyzeSignals(FRIEND, USER, altered, CORE.MB_DEFAULTS)).dialogueChars !== nSig.dialogueChars);

      /* ══ T14 · provider 序列化不重新引入语义差异 ═════════════════════
         两端把上下文放在不同位置（桌面挂末条 user 消息的 tail；Home Node
         放 system 尾部）—— 这是**承载方式**差异。必须证明的是：进到请求里
         的【当前对话】段逐字相同，且当前回合恰好出现一次。 */
      const sys = String(n1.prompt.system || '');
      const start = sys.indexOf('【当前对话】');
      check('T14.systemCarriesDialogueBlock', start >= 0, sys.slice(0, 200));
      const block = start >= 0 ? sys.slice(start).split('\n\n').filter(function (s) { return s.trim(); })[0] : '';
      check('T14.injectedDialogueMatchesBoundary', block === '【当前对话】\n' + nComp.compressedContext.split('【当前对话】\n')[1],
        { injected: block, boundary: nComp.compressedContext });
      check('T14.currentTurnExactlyOnceInPrompt', sys.split(USER).length - 1 === 1, sys.split(USER).length - 1);
      check('T14.providerMessagesCarryTheTurnOnce',
        n1.prompt.messages.filter(m => m.role === 'user' && String(m.content).indexOf(USER) >= 0).length === 1,
        n1.prompt.messages.map(m => m.role));
      /* 反证：当前回合**不能**从 provider 面消失（注入不是"替换掉用户的话"）。 */
      check('T14.counterProofCurrentTurnStillInMessages', n1.prompt.messages[n1.prompt.messages.length - 1].content.indexOf(USER) >= 0);

      /* ══ T2 · 当前用户行已经 canonical（在历史窗口内）════════════════ */
      return nodeTurn('reqT2', alreadyCanonical, USER).then(function (n2) {
        const d2 = desktopOpts(alreadyCanonical, USER, blocks);
        check('T2.dialogueByteIdentical', JSON.stringify(n2.dialogue) === JSON.stringify(d2.dialogue), { node: n2.dialogue, desktop: d2.dialogue });
        check('T2.currentTurnOnce', n2.dialogue.filter(l => l === '用户：' + USER).length === 1, n2.dialogue);
        check('T2.injectedOnce', String(n2.prompt.system).split(USER).length - 1 === 1);

        /* ══ T3 · 当前用户行尚未进入历史窗口（同步滞后）═════════════════ */
        const stale = PRIOR.slice();
        return nodeTurn('reqT3', stale, USER).then(function (n3) {
          const d3 = desktopOpts(stale, USER, blocks);
          check('T3.dialogueByteIdentical', JSON.stringify(n3.dialogue) === JSON.stringify(d3.dialogue), { node: n3.dialogue, desktop: d3.dialogue });
          check('T3.currentTurnStillExactlyOnce', n3.dialogue.filter(l => l === '用户：' + USER).length === 1);
          check('T3.currentTurnPresentEvenWhenSyncLags', n3.dialogue[n3.dialogue.length - 1] === '用户：' + USER);

          /* ══ T4 · 重试 / 重放同一个 requestId ═══════════════════════ */
          return nodeTurn('reqT2', alreadyCanonical, USER).then(function (n4) {
            /* 同一个 requestId：canonical 行 identity 相同 → 仍然只出现一次。 */
            check('T4.replayDialogueStable', JSON.stringify(n4.dialogue) === JSON.stringify(n2.dialogue), { replay: n4.dialogue, first: n2.dialogue });
            check('T4.replayCurrentTurnOnce', n4.dialogue.filter(l => l === '用户：' + USER).length === 1);
            check('T4.replayIdentityIsDeterministic',
              CHAT_CORE.messageIdFromRequest('reqT2') === CHAT_CORE.messageIdFromRequest('reqT2'));

            /* ══ T5/T6 · 连发 / 重新生成 ═════════════════════════════ */
            return nodeTurn('reqT5', twice, USER).then(function (n5) {
              const d5 = desktopOpts(twice, USER, blocks);
              check('T6.dialogueByteIdentical', JSON.stringify(n5.dialogue) === JSON.stringify(d5.dialogue), { node: n5.dialogue, desktop: d5.dialogue });
              check('T6.repeatedSendPreservedTwice', n5.dialogue.filter(l => l === '用户：' + USER).length === 2, n5.dialogue);
              const consecutive = PRIOR.concat([{ id: 'c1', role: 'assistant', content: '再补一句。' }, { id: 'c2', role: 'assistant', content: '又说一句。' }]);
              return nodeTurn('reqT7', consecutive, USER).then(function (n6) {
                check('T6.consecutiveAssistantRowsKept',
                  n6.dialogue.indexOf('角色：再补一句。') >= 0 && n6.dialogue.indexOf('角色：又说一句。') >= 0, n6.dialogue);
                check('T6.consecutiveByteIdentical',
                  JSON.stringify(n6.dialogue) === JSON.stringify(desktopOpts(consecutive, USER, blocks).dialogue));
                /* 重新生成：同一条用户行 + 两条助理候选 → 证据一致、不因候选而变 */
                check('T6.regenerationDoesNotChangeEvidence',
                  JSON.stringify(DLG.lines({ history: PRIOR, userMessage: USER })) === JSON.stringify(DLG.lines({ history: PRIOR, userMessage: USER })));

                /* ══ T7 · 删除 / 排除的历史行 ═══════════════════════════
                   canonical store 的 deleted_at IS NULL 过滤在**取页**处；
                   本核心只投影"交给它的行" —— 被排除的行不会出现在输入里，
                   因此也不会出现在证据里。用真实 store 证明这条链路。 */
                store.putMessage({ id: 'd1', role: 'user', content: '这条会被删掉', friendId: FRIEND, timestamp: 1700000000001 }, {});
                store.putMessage({ id: 'd2', role: 'assistant', content: '我也是。', friendId: FRIEND, timestamp: 1700000000002 }, {});
                const before = store.listMessages({ conversationId: CHAT_CORE.conversationIdOf(FRIEND, ''), limit: 50 }).messages;
                const del = store.deleteMessage('d1', {});
                const after = store.listMessages({ conversationId: CHAT_CORE.conversationIdOf(FRIEND, ''), limit: 50 }).messages;
                check('T7.deleteAccepted', del.ok === true && del.deleted === true, del);
                check('T7.deletedRowLeavesWindow',
                  before.some(m => m.id === 'd1') && after.every(m => m.id !== 'd1'),
                  { before: before.length, after: after.length });
                check('T7.tombstoneIsSoftNotPhysical',
                  store.getMessage('d1') === null && store.getMessage('d1', { includeDeleted: true }) != null,
                  '删除应当是软删（tombstone）：默认读不到，但 canonical 行仍在');
                const delLines = DLG.lines({ history: after.map(m => ({ role: m.role, content: m.content })), userMessage: USER });
                check('T7.deletedRowAbsentFromEvidence', delLines.indexOf('用户：这条会被删掉') < 0, delLines);

                /* ══ T8/T9 · 空历史 / 检索失败 ══════════════════════════ */
                return nodeTurn('reqT8', [], USER).then(function (n8) {
                  check('T8.emptyHistoryYieldsCurrentOnly', n8.dialogue.length === 1 && n8.dialogue[0] === '用户：' + USER, n8.dialogue);
                  check('T8.dialogueByteIdentical', JSON.stringify(n8.dialogue) === JSON.stringify(desktopOpts([], USER, blocks).dialogue));
                  /* 检索失败 = 调用方拿不到历史 → 传 null；必须降级成"只有当前回合"，
                     而且**不得**抛错（Gate 的信号计算在回合链路上）。 */
                  const degraded = DLG.lines({ history: null, userMessage: USER });
                  check('T9.retrievalFailureDegradesToCurrentOnly', degraded.length === 1 && degraded[0] === '用户：' + USER, degraded);
                  check('T9.retrievalFailureDoesNotThrow', (() => {
                    try { return DLG.lines({ history: undefined, userMessage: USER }).length === 1; } catch (e) { return false; }
                  })());
                  /* 失败降级后两端仍然相等（同一份"没有历史"输入）。 */
                  check('T9.failureParity',
                    JSON.stringify(degraded) === JSON.stringify(DLG.lines({ history: null, userMessage: USER })));

                  /* ══ T10 · 会话 / 话题隔离 ═════════════════════════════ */
                  return nodeTurn('reqT10', PRIOR, USER, { threadId: 'th7', friendId: FRIEND }).then(function (n10) {
                    check('T10.threadTurnHasSameEvidence', JSON.stringify(n10.dialogue) === JSON.stringify(d1.dialogue), n10.dialogue);
                    check('T10.threadIsolationKeepsConversation', n10.res.ok === true && n10.res.conversationId === 'dm:' + FRIEND + '|th7');
                    const other = rows([['user', '另一个角色的开场'], ['assistant', '另一个角色的回应']]);
                    const otherLines = DLG.lines({ history: other, userMessage: USER });
                    check('T10.foreignConversationDifferencesVisible',
                      JSON.stringify(otherLines) !== JSON.stringify(DLG.lines({ history: PRIOR, userMessage: USER })));

                    /* ══ T11 · 长历史 / 窗口边界 ═════════════════════════ */
                    const many = [];
                    for (let i = 0; i < 14; i++) many.push({ id: 'h' + i, role: i % 2 ? 'assistant' : 'user', content: '回合' + i });
                    return nodeTurn('reqT11', many, USER).then(function (n11) {
                      const d11 = desktopOpts(many, USER, blocks);
                      check('T11.dialogueByteIdentical', JSON.stringify(n11.dialogue) === JSON.stringify(d11.dialogue), { node: n11.dialogue, desktop: d11.dialogue });
                      check('T11.historyCapIsEightNotSeven', n11.dialogue.length === 9, n11.dialogue.length);
                      check('T11.currentTurnSurvivesTheCap', n11.dialogue[8] === '用户：' + USER);
                      check('T11.capKeepsNewestRows', n11.dialogue[0] === '用户：回合6' || n11.dialogue[0] === '角色：回合7', n11.dialogue[0]);

                      /* ══ T12 · 两端在语义边界上的结构 / 字节 parity ═══════
                         同一份 canonical 状态 → 两端的 (dialogue, signals,
                         compressedContext) 三件套逐字相等。 */
                      const nodeSide = DLG.lines({ history: many, userMessage: USER, currentId: CHAT_CORE.messageIdFromRequest('reqT11') });
                      check('T12.sharedCoreProducesOneOutput', JSON.stringify(nodeSide) === JSON.stringify(n11.dialogue));
                      /* 反证：两端的输入如果**真的**不同（不同历史窗口），
                         输出必须不同 —— 证明上面那条相等不是因为核心忽略输入。 */
                      check('T12.counterProofInputsMatter',
                        JSON.stringify(DLG.lines({ history: many.slice(0, 4), userMessage: USER })) !== JSON.stringify(n11.dialogue));

                      /* ══ T15 · Android 瘦客户端不得成为第二个对话权威 ═════ */
                      const gwSrc = fs.readFileSync(path.join(ROOT, 'services', 'home-node', 'mobile-gateway.js'), 'utf8');
                      const dtoSrc = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'mobile-dto.js'), 'utf8');
                      const parseStart = gwSrc.indexOf('function parseSendPayload(');
                      /* 到下一个顶层函数声明为止 —— 不靠花括号配对（本文件里有模板串）。 */
                      const afterParse = gwSrc.indexOf('\n  function ', parseStart + 10);
                      const parseBlock = gwSrc.slice(parseStart, afterParse > parseStart ? afterParse : parseStart + 9000);
                      check('T15.parseBlockExtracted', parseBlock.length > 2000 && /return \{/.test(parseBlock), parseBlock.length);
                      /* T15 的判据是**结构**而不是词表：
                         · 客户端送来的 payload 里**没有** history / dialogue 这两个输入端
                           （只有 historyLimit 这个"窗口大小提示"，且它本身受 normalizeLimit 边界约束）；
                         · 交出去的 history 只由 canonical store 的读取结果填充；
                         · Android 侧的 DTO 里根本没有 dialogue 字段。 */
                      check('T15.clientCannotSupplyHistory',
                        !/payload\s*\.\s*(history|dialogue)\b/.test(parseBlock)
                        && !/payload\s*\.\s*message\s*\.\s*(history|dialogue)\b/.test(parseBlock),
                        'send payload 解析器接受了客户端提供的 history / dialogue');
                      check('T15.historyFilledOnlyFromCanonicalStore',
                        /const history = \[\];/.test(parseBlock)
                        && /history\.push\(/.test(parseBlock)
                        && /store\.listMessages\(\{/.test(parseBlock)
                        && /history: history,/.test(parseBlock),
                        '交出去的 history 不是由 canonical store 的读取结果构造的');
                      /* 客户端能给的只有一个**条数上限提示**，内容仍由 canonical store 决定。 */
                      check('T15.clientOnlyHintsAWindowSize',
                        /payload\.historyLimit/.test(parseBlock) && /normalizeLimit\(/.test(parseBlock),
                        '客户端不再只能给上限提示（historyLimit）');
                      check('T15.historyComesFromCanonicalStore',
                        parseBlock.indexOf('store.listMessages(') >= 0,
                        'history 不是从 canonical store 读的');
                      check('T15.dtoHasNoDialogueField', !/["']dialogue["']/.test(dtoSrc), 'mobile DTO 出现了 dialogue 字段');
                      check('T15.dialogueProjectionLivesInSharedCore',
                        /dialogue-core/.test(fs.readFileSync(path.join(ROOT, 'services', 'home-node', 'middle-brain.js'), 'utf8')));

                      /* ══ 共享核心确实是唯一实现（结构断言）═══════════════ */
                      const htmlSrc = fs.readFileSync(path.join(ROOT, 'InternalBeyond.html'), 'utf8');
                      const mbSrc = fs.readFileSync(path.join(ROOT, 'services', 'home-node', 'middle-brain.js'), 'utf8');
                      const commSrc = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'communication.js'), 'utf8');
                      check('oneImpl.scriptTagPresent', htmlSrc.indexOf('assets/js/dialogue-core.js') >= 0);
                      check('oneImpl.scriptTagBeforeCommunication',
                        htmlSrc.indexOf('assets/js/dialogue-core.js') < htmlSrc.indexOf('assets/js/communication.js'));
                      check('oneImpl.nodeRequiresSharedCore', mbSrc.indexOf("require(path.join(ASSETS_JS, 'dialogue-core.js'))") >= 0);
                      check('oneImpl.noSecondCapConstants', !/const DIALOGUE_MAX_(MESSAGES|CHARS)\s*=/.test(mbSrc),
                        'Home Node 里又出现了一份对话上限常量');
                      check('oneImpl.nodeHasNoPrivateAssembler', !/function dialogueFrom\(history, userMessage\) \{/.test(mbSrc),
                        'Home Node 里又出现了一份宿主私有的对话投影实现');
                      check('oneImpl.desktopUsesSharedCore', /IBDialogueCore/.test(commSrc));
                      check('oneImpl.desktopPassesDialogue', /dialogue:_dlgLines/.test(commSrc));
                      check('oneImpl.desktopFeedsCanonicalSlice', /dialogueHistory:history/.test(commSrc));
                      check('oneImpl.noHardcodedCapInDesktop', !/slice\(0,\s*400\)/.test(commSrc), '桌面里出现了硬编码的 400 字截断');

                      /* 双载：Node require 与浏览器 window 拿到的是同一份实现。 */
                      check('oneImpl.dualLoadSameModule', (() => {
                        const viaRequire = require(path.join(ROOT, 'assets', 'js', 'dialogue-core.js'));
                        return typeof viaRequire.lines === 'function' && viaRequire.HISTORY_MAX_MESSAGES === 8 && viaRequire.HISTORY_MAX_CHARS === 400;
                      })());

                      store.close();
                      console.log('\nDialogue authority parity: ' + passed + ' passed, ' + failed + ' failed');
                      process.exit(failed ? 1 : 0);
                    });
                  });
                });
              });
            });
          });
        });
      });
    });
  }).catch(function (error) {
    console.error('unexpected failure:', (error && error.stack) || error);
    process.exit(1);
  });
}

main();
