'use strict';
/* Internal Beyond · P21-R2-E1a · ColdStart Conversation Signal（Node，真实 Home Node）
   运行：node tests/test_memory_recall_coldstart_signal.js

   ── 本文件冻结的语义（R2-E1a §8–§11 / §15）──────────────────────────
     · ColdStartSignal = { conversationId, isFirstTurn, source:'conversation-store' }
     · isFirstTurn 只能由**拥有会话存储的 Host**判定，不由 retrieval 猜
     · 探针必须在**当前 user message 落库之前**执行
     · 读失败 / store 不可用 / conversationId 非法 ⇒ isFirstTurn **false**（fail closed）
     · one-shot authority 是 Host 的 isFirstTurn，**不是** retrieval 的 seen-set
     · 本轮 **不**启用 coldStart：信号是 latent，orchestrator 不消费

   取证方式：真实 buildHomeNode + HTTP + **在 orchestrator 边界打 spy**，
   观察 beginTurn 实际算出的 turn 元数据（不是读源码推断）。
   ══════════════════════════════════════════════════════════════════════════ */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const ROOT = path.resolve(__dirname, '..');
const SERVICE = require(path.join(ROOT, 'services', 'home-node-service.js'));
const ORCH = require(path.join(ROOT, 'assets/js/memory-recall/memory-recall-orchestrator.js'));

let failures = 0, passed = 0;
const check = (name, cond, detail) => {
  if (cond) { passed++; console.log('  PASS  ' + name); return true; }
  failures++;
  console.error('  FAIL  ' + name + (detail !== undefined ? '  -> ' + detail : ''));
  return false;
};
const section = t => console.log('\n── ' + t + ' ──');

const FIXED_MS = 1750000000000;
const CID = 'role_e1a';
/* 源码断言一律**剥注释**：本轮的说明性注释里出现了 `channelHint:'coldStart'`、
   `filterSealed` 等字面量，直接扫原文会产生假阳性（把"禁止这样做"读成"这样做了"）。 */
function stripComments(src) {
  return String(src).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}
const NODE_SRC = stripComments(fs.readFileSync(path.join(ROOT, 'services/home-node/mobile-gateway.js'), 'utf8'));
const MEM_SRC = stripComments(fs.readFileSync(path.join(ROOT, 'services/home-node/memory-retrieval.js'), 'utf8'));
const COMM_SRC = stripComments(fs.readFileSync(path.join(ROOT, 'assets/js/communication.js'), 'utf8'));
const MEMJS_SRC = stripComments(fs.readFileSync(path.join(ROOT, 'assets/js/memory.js'), 'utf8'));
const ORCH_SRC = stripComments(fs.readFileSync(path.join(ROOT, 'assets/js/memory-recall/memory-recall-orchestrator.js'), 'utf8'));

/* ══════════════════════════════════════════════════════════════════════
   §A · 真实 Home Node 端到端
   ══════════════════════════════════════════════════════════════════════ */
async function main() {
  const captured = [];
  const realRecall = ORCH.recall;
  ORCH.recall = function (records, options) {
    captured.push(options && options.turn ? JSON.parse(JSON.stringify(options.turn)) : null);
    return realRecall(records, options);
  };

  /* mock provider：立即返回一个最小 SSE 完成，让回合迅速结束。 */
  const provider = http.createServer((rq, rs) => {
    let raw = '';
    rq.on('data', c => raw += c);
    rq.on('end', () => {
      rs.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      rs.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'E1A_REPLY' }, index: 0 }] }) + '\n\n');
      rs.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop', index: 0 }], usage: { prompt_tokens: 1, completion_tokens: 1 } }) + '\n\n');
      rs.write('data: [DONE]\n\n');
      rs.end();
    });
  });
  const providerPort = await new Promise(r => provider.listen(0, '127.0.0.1', () => r(provider.address().port)));
  const providerEndpoint = 'http://127.0.0.1:' + providerPort + '/v1/chat/completions';

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-e1a-'));
  const TOKEN = 'e1a-token';
  const SECRET = 'sk-e1a-synthetic';
  /* Provider secret 现在由 Vault 解析（P34.3-B）。没有它，回合会卡在 provider 调用上，
     于是一整个会话只留下第一条消息 —— 那是**测试装配问题**，不是被测语义问题。 */
  (function seedVault() {
    const createVault = require(path.join(ROOT, 'active', 'credential-vault.js'));
    const vault = createVault({ dataDir: dir });
    vault.load();
    vault.upsert(CID, { provider: 'custom', apiKey: SECRET });
    vault.save();
  })();
  const inst = SERVICE.buildHomeNode({ dataDir: dir, token: TOKEN, logger: () => {}, clock: () => FIXED_MS, random: () => 0.42 });
  inst.open();
  const server = inst.server;
  const port = await new Promise(r => server.listen(0, '127.0.0.1', () => r(server.address().port)));

  function req(method, p, body, headers) {
    return new Promise((resolve) => {
      const data = body ? JSON.stringify(body) : null;
      const h = Object.assign({ 'Content-Type': 'application/json' }, headers || {}, data ? { 'Content-Length': Buffer.byteLength(data) } : {});
      const r = http.request({ method, host: '127.0.0.1', port, path: p, headers: h }, res => {
        let out = ''; res.on('data', c => out += c); res.on('end', () => { let b = null; try { b = JSON.parse(out); } catch (e) {} resolve({ status: res.statusCode, body: b, raw: out }); });
      });
      r.on('error', e => resolve({ status: 0, raw: String(e.message) }));
      if (data) r.write(data);
      r.end();
    });
  }

  const admin = { 'X-IB-Home-Token': TOKEN };
  await req('POST', '/characters/publish', {
    merge: true, user: { name: 'U' },
    characters: [{ id: CID, nickname: 'E1A', model: 'm', provider: 'custom', endpoint: providerEndpoint, apiKey: SECRET, systemPrompt: 'x', relationship: '' }]
  }, admin);
  const sPair = await req('POST', '/pairing/session', { deviceName: 'P', deviceType: 'android' }, admin);
  const cPair = await req('POST', '/mobile/v1/pairing/complete', {
    v: 1, payload: { pairingId: sPair.body.payload.pairingId, secret: sPair.body.payload.secret, deviceName: 'P', deviceType: 'android' }
  });
  const auth = { Authorization: 'Bearer ' + cPair.body.payload.token };

  const send = (rid, content, extra) => req('POST', '/mobile/v1/chat/send',
    Object.assign({ v: 1, requestId: rid, payload: Object.assign({ characterId: CID, content }, extra || {}) }, {}), auth);
  const convCount = () => {
    const p = inst.store.listMessages({ conversationId: 'dm:' + CID, limit: 50 });
    return (p && p.messages) ? p.messages.length : -1;
  };

  try {
    /* ── 1 · 真正空的会话 ⇒ isFirstTurn=true ───────────────────────── */
    section('§A1 · genuinely empty conversation');
    check('S0.conversationStartsEmpty', convCount() === 0, 'count=' + convCount());
    captured.length = 0;
    check('S0.signalIsObservableEndToEnd', captured.length === 0, 'spy installed (no call yet)');
    const countBeforeFirstTurn = convCount();
    await send('a1', '显卡');
    await new Promise(r => setTimeout(r, 700));
    const t1 = captured[0];
    check('1.emptyConversationIsFirstTurn', !!t1 && t1.isFirstTurn === true, JSON.stringify(t1));
    check('1.conversationIdDerived', !!t1 && t1.conversationId === 'dm:' + CID, JSON.stringify(t1));
    check('1.signalAvailableTrue', !!t1 && t1.conversationSignalAvailable === true, JSON.stringify(t1));

    /* ── 6 · 探针发生在当前消息落库**之前** ───────────────────────── */
    section('§A6 · probe timing');
    check('6.currentUserMessageNotYetPersistedAtProbeTime',
      !!t1 && t1.isFirstTurn === true && countBeforeFirstTurn === 0 && convCount() > 0,
      'store was empty at probe time (0) and holds this turn afterwards (' + convCount() + ')'
      + ' — a probe placed AFTER persistence could never report isFirstTurn=true');
    check('6.probeRunsBeforeDbPut', (() => {
      /* 源码顺序证据：探针必须在 dbPut('chatMessages',userMsg) 之前 */
      const iProbe = NODE_SRC.indexOf('coldstart-signal-probe-failed');
      return iProbe > 0;
    })());

    /* ── 7 / 2 · 第二轮 ⇒ false ────────────────────────────────────── */
    section('§A2/§A7 · existing message / second turn');
    captured.length = 0;
    await send('a2', '显卡');
    await new Promise(r => setTimeout(r, 700));
    const t2 = captured[0];
    check('7.secondTurnIsNotFirst', !!t2 && t2.isFirstTurn === false, JSON.stringify(t2));
    check('2.existingMessageMeansNotFirst', !!t2 && t2.conversationId === 'dm:' + CID && convCount() >= 2,
      'count=' + convCount() + ' (a completed turn persists user+assistant)');
    check('15.signalIsDeterministicAcrossTurns', !!t1 && !!t2
      && t1.conversationId === t2.conversationId, 'same conversationId on both turns');

    /* ── 3 · 窗口上限不影响 zero/nonzero 判断 ──────────────────────── */
    section('§A3 · history window limit');
    for (let i = 0; i < 6; i++) await send('w' + i, '显卡');
    await new Promise(r => setTimeout(r, 900));
    captured.length = 0;
    await send('w-many', '显卡', { historyLimit: 20 });
    await new Promise(r => setTimeout(r, 700));
    const tW = captured[0];
    check('3.windowLimitDoesNotFlipFirstTurn', !!tW && tW.isFirstTurn === false,
      'a truncated history window must never be read as "no history": ' + JSON.stringify(tW));
    captured.length = 0;
    await send('w-max', '显卡', { historyLimit: 100 });
    await new Promise(r => setTimeout(r, 700));
    check('3.maxWindowAlsoNotFirst', !!captured[0] && captured[0].isFirstTurn === false,
      JSON.stringify(captured[0]));

    /* ── 4 · 读取失败 ⇒ false（fail closed）───────────────────────── */
    section('§A4 · read failure');
    const realList = inst.store.listMessages;
    /* 只让**探针那一次**调用失败。
       limit:1 并非探针独有（donePayloadFor 也用同一形状），所以用一次性开关；
       历史读取用 limit:20..100 因此不受影响，parseSendPayload 能正常走到探针。
       探针在 runTurn 之前执行 ⇒ 装上补丁后的第一次 limit:1 调用就是它。 */
    let armProbeFailure = true;
    inst.store.listMessages = function (q) {
      if (armProbeFailure && q && q.limit === 1) { armProbeFailure = false; throw new Error('simulated-store-failure'); }
      return realList(q);
    };
    captured.length = 0;
    await send('fail1', '显卡');
    await new Promise(r => setTimeout(r, 700));
    const tFail = captured[0];
    check('4.readFailureIsNotFirstTurn', !!tFail && tFail.isFirstTurn === false,
      'a read failure must NEVER be reported as a new conversation: ' + JSON.stringify(tFail));
    check('4.readFailureMarksSignalUnavailable', !!tFail && tFail.conversationSignalAvailable === false,
      JSON.stringify(tFail));

    /* ── 5 · ok:false ⇒ false ─────────────────────────────────────── */
    let armBadResult = true;
    inst.store.listMessages = function (q) {
      if (armBadResult && q && q.limit === 1) { armBadResult = false; return { ok: false, error: 'simulated-bad-result' }; }
      return realList(q);
    };
    captured.length = 0;
    await send('fail2', '显卡');
    await new Promise(r => setTimeout(r, 700));
    const tBad = captured[0];
    check('5.badResultIsNotFirstTurn', !!tBad && tBad.isFirstTurn === false, JSON.stringify(tBad));
    check('5.badResultMarksSignalUnavailable', !!tBad && tBad.conversationSignalAvailable === false, JSON.stringify(tBad));

    /* ── 5b · 非数组 messages ⇒ false ─────────────────────────────── */
    let armNullMessages = true;
    inst.store.listMessages = function (q) {
      if (armNullMessages && q && q.limit === 1) { armNullMessages = false; return { ok: true, messages: null }; }
      return realList(q);
    };
    captured.length = 0;
    await send('fail3', '显卡');
    await new Promise(r => setTimeout(r, 700));
    check('5b.nonArrayMessagesIsNotFirstTurn', !!captured[0] && captured[0].isFirstTurn === false,
      JSON.stringify(captured[0]));
    inst.store.listMessages = realList;

    /* ── 8 · 无 conversationId ⇒ 无信号（直接测 retrieval 边界）────── */
    section('§A8 · no conversationId');
    captured.length = 0;
    inst.memoryRetrieval.buildRuntimeContext({ characterId: CID, userMessage: '显卡' });
    const tNone = captured[0];
    check('8.missingConversationIdYieldsNoSignal', !!tNone
      && tNone.conversationId === null && tNone.isFirstTurn === false
      && tNone.conversationSignalAvailable === false,
      'without a conversationId the Host must not claim coldStart: ' + JSON.stringify(tNone));

    /* ── 19 · latent 证明：带/不带会话信号，召回结果必须逐字节相同 ───── */
    section('§A19 · latent parity (signal must not change the result)');
    (function latentParity() {
      const base = { characterId: CID, userMessage: '显卡', now: FIXED_MS, maxChars: 2000, contentLen: 200 };
      const withoutSignal = inst.memoryRetrieval.buildRuntimeContext(Object.assign({}, base));
      const withSignal = inst.memoryRetrieval.buildRuntimeContext(Object.assign({}, base, {
        conversationId: 'dm:' + CID, isFirstTurn: true, conversationSignalAvailable: true
      }));
      check('19.resultIdenticalWithAndWithoutSignal',
        JSON.stringify(withoutSignal.memoryBlock) === JSON.stringify(withSignal.memoryBlock)
        && JSON.stringify(withoutSignal.selectedIds) === JSON.stringify(withSignal.selectedIds)
        && withoutSignal.memoryCount === withSignal.memoryCount
        && withoutSignal.memoryReason === withSignal.memoryReason,
        JSON.stringify({
          noSignal: { n: (withoutSignal.selectedIds || []).length, r: withoutSignal.memoryReason },
          withSignal: { n: (withSignal.selectedIds || []).length, r: withSignal.memoryReason }
        }));
      check('19.signalDoesNotAlterRuntimeContext',
        withoutSignal.runtimeContext === withSignal.runtimeContext,
        'the latent signal must not leak into the assembled runtime context');
    })();

    /* ── 12 · 群聊不自动为 true ───────────────────────────────────── */
    section('§A12 · group');
    check('12.groupIsNeverAutoFirstTurn', (() => {
      /* 群聊路径**不**传 coldStart 会话信号 ⇒ 默认 false，绝不为 true。
         只看该调用点**紧邻**的窗口：更远处（单聊路径）出现 coldStart 是正常的。 */
      /* ⚠ PHASE TRANSITION（LIVE-3.4，有意更新，**不是放宽**）：LIVE-3.4 把群聊召回
         从 `getMemoryContext(...{isGroup:true,groupMemEnabled:true,...})` 换成服务端召回缝
         `ibRecallContextForTurn({...isGroup:true...})`，旧调用形状不复存在。
         判据本身不变（群聊路径**不得**携带 coldStart 会话信号），只是锚点跟着搬家。 */
      const groupCall = COMM_SRC.indexOf("isGroup:true,requestId:(opts&&opts.turnId)");
      if (groupCall < 0) return false;
      /* 精确判据：只看**这次调用自己的实参列表**（从调用名到配对的 `})`），
         不再用固定窗口 —— 调用点搬家后，固定窗口会把旁边的单聊路径算进来，
         那是"判据失效"，不是"性质被违反"。性质本身一字未改：群聊召回输入
         不得携带 coldStart 会话信号。 */
      const callStart = COMM_SRC.lastIndexOf("ibRecallContextForTurn(", groupCall);
      if (callStart < 0) return false;
      let depth = 0, callEnd = -1;
      for (let k = callStart; k < COMM_SRC.length; k++) {
        const ch = COMM_SRC[k];
        if (ch === "(") depth++;
        else if (ch === ")") { depth--; if (depth === 0) { callEnd = k; break; } }
      }
      if (callEnd < 0) return false;
      const callArgs = COMM_SRC.slice(callStart, callEnd + 1);
      return callArgs.indexOf("coldStart") < 0 && callArgs.indexOf("isFirstTurn") < 0;
    })(), 'the group call site must not carry a coldStart signal — group coldStart is deliberately unavailable');

    /* ── 9/10/11 · Browser ───────────────────────────────────────── */
    section('§A9-11 · Browser');
    check('9.browserProbeExistsAndPrecedesPersistence', (() => {
      const iProbe = COMM_SRC.indexOf('_ibProbeColdStartSignal(_targetFriend');
      /* 必须从探针**之后**找 dbPut —— 群聊路径在更早的位置也有一处同名写入，
         用 indexOf 取第一个会误判成"探针在落库之后"。 */
      const iPut = COMM_SRC.indexOf("await dbPut('chatMessages',userMsg)", iProbe);
      return iProbe > 0 && iPut > iProbe;
    })(), 'the Browser probe must run BEFORE the current user message is persisted');
    check('9.browserProbeUsesCanonicalConversationPredicate',
      /_ibConvId\(friendId,_tid\)/.test(COMM_SRC)
      && /_tid\?String\(m\.threadId\|\|''\)===_tid:!m\.threadId/.test(COMM_SRC),
      'the Browser probe must reuse _ibConvId (chat-core) and the repo-wide thread predicate');
    check('9.browserProbeDoesNotSealFilter', (() => {
      const i = COMM_SRC.indexOf('async function _ibProbeColdStartSignal');
      const j = COMM_SRC.indexOf('/* ── P30-2', i);
      const body = COMM_SRC.slice(i, j > i ? j : i + 1600);
      return body.indexOf('filterSealed') < 0 && body.indexOf('getChatSealTimestamp') < 0;
    })(), 'sealing would make a conversation with (sealed) history look empty ⇒ false coldStart');
    check('9.browserSignalReachesOrchestrator',
      /conversationId/.test(MEMJS_SRC) && /isFirstTurn/.test(MEMJS_SRC));
    check('10.browserUnknownPathFailsClosed', (() => {
      const i = COMM_SRC.indexOf('async function _ibProbeColdStartSignal');
      const body = COMM_SRC.slice(i, i + 1600);
      /* 默认值必须是 false/unavailable，且异常分支返回该默认值 */
      return /isFirstTurn:false/.test(body) && /conversationSignalAvailable:false/.test(body)
        && /catch\(e\)\{[\s\S]{0,200}?return out;/.test(body);
    })(), 'unknown ⇒ false, never true');
    check('11.pageRefreshCannotAutoClaimFirstTurn', (() => {
      /* 探针只依赖 store 计数 + 纯函数 conversationId；
         不得依赖任何"本次页面会话是否来过"的运行期标志（那会让刷新变成假 coldStart）。 */
      const i = COMM_SRC.indexOf('async function _ibProbeColdStartSignal');
      const body = COMM_SRC.slice(i, i + 1600);
      return body.indexOf('localStorage') < 0 && body.indexOf('sessionStorage') < 0
        && body.indexOf('Date.now') < 0;
    })(), 'the signal must derive from the store, not from a page-session marker');
    check('11.browserSignalIsLatentNotActivatingColdStart',
      COMM_SRC.indexOf("channelHint:'coldStart'") < 0
      && MEMJS_SRC.indexOf("channelHint:'coldStart'") < 0,
      'no Host may hint the coldStart channel in R2-E1a');

  } finally {
    ORCH.recall = realRecall;
    try { inst.close(); } catch (e) {}
    try { provider.close(); } catch (e) {}
  }

  /* ══════════════════════════════════════════════════════════════════
     §B · 负面不变量（13 / 14）
     ══════════════════════════════════════════════════════════════════ */
  section('§B · negative invariants');

  check('13.noSessionSeenSet', (() => {
    /* one-shot authority 是 Host 的 isFirstTurn，不是 retrieval 自己的 seen-set */
    const bad = /seenConversations|firedColdStart|coldStartFired|coldstart-state/.test(ORCH_SRC + NODE_SRC + COMM_SRC);
    return !bad;
  })(), 'retrieval must not keep its own coldStart seen-set');
  /* ⚠ PHASE TRANSITION（R2-E1a → R2-E1b）：coldstart-anchor.js 现在是**合法**
     的实现模块（anchor eligibility 的纯谓词）。R2-E1b 仍然禁止的是
     **durable/anchor 之外的状态模块** —— one-shot authority 仍是 Host 的
     isFirstTurn，不是 retrieval 自己的 seen-set。 */
  check('13.noColdstartStateModule',
    !fs.existsSync(path.join(ROOT, 'assets/js/memory-recall/coldstart-state.js')),
    'no durable coldStart state module may exist — one-shot authority stays with the Host');
  check('13.coldstartAnchorIsPurePredicate', (() => {
    const f = path.join(ROOT, 'assets/js/memory-recall/coldstart-anchor.js');
    if (!fs.existsSync(f)) return false;
    const bare = fs.readFileSync(f, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    return !/localStorage|sessionStorage|indexedDB|Date\.now|Math\.random|fetch\s*\(/.test(bare);
  })(), 'the anchor module must stay pure: no IO, no clock, no random');
  check('14.noSchemaChange', (() => {
    const schema = fs.readFileSync(path.join(ROOT, 'assets/js/webcore-db-schema.js'), 'utf8');
    const core = fs.readFileSync(path.join(ROOT, 'assets/js/chat-core.js'), 'utf8');
    return schema.indexOf('coldStart') < 0 && schema.indexOf('glossary') < 0
      && /DB_VER = 24/.test(core);
  })(), 'no new store, DB_VER unchanged (24)');
  check('14.noNewStoreNames', (() => {
    const schema = fs.readFileSync(path.join(ROOT, 'assets/js/webcore-db-schema.js'), 'utf8');
    return !/'(glossary|terms|aliases|coldstart)'/.test(schema);
  })());

  /* ══════════════════════════════════════════════════════════════════
     §C · §15 未来优先级契约（R2-E1b 才实现，本轮**冻结判据**）
     ══════════════════════════════════════════════════════════════════ */
  section('§C · frozen future precedence（explicit recall > automatic coldStart）');

  /* 冻结的裁决顺序（§2.4）：
     1 explicit host-forced non-coldStart channel
     2 explicit recall intent
     3 coldStart isFirstTurn
     4 surface
     5 early exit
     关键点：**自动**的 coldStart 生命周期信号**不得**覆盖**明确**的用户 recall 意图。 */
  const PRECEDENCE = ['host-forced-non-coldstart', 'explicit-recall', 'coldstart-first-turn', 'surface', 'early-exit'];

  function decide(intent) {
    if (intent.hostForcedChannel && intent.hostForcedChannel !== 'coldStart') return 'host-forced-non-coldstart';
    if (intent.explicitRecall === true) return 'explicit-recall';
    if (intent.isFirstTurn === true) return 'coldstart-first-turn';
    if (intent.hasSemanticPayload === true) return 'surface';
    return 'early-exit';
  }

  const cases = [
    ['A. firstTurn=true, "嗯"', { isFirstTurn: true, explicitRecall: false, hasSemanticPayload: false }, 'coldstart-first-turn'],
    ['B. firstTurn=true, "还记得上次吗"', { isFirstTurn: true, explicitRecall: true, hasSemanticPayload: true }, 'explicit-recall'],
    ['C. firstTurn=false, "嗯"', { isFirstTurn: false, explicitRecall: false, hasSemanticPayload: false }, 'early-exit'],
    ['D. firstTurn=false, "显卡"', { isFirstTurn: false, explicitRecall: false, hasSemanticPayload: true }, 'surface'],
    ['E. firstTurn=true + host forces glossary', { isFirstTurn: true, hostForcedChannel: 'glossary', explicitRecall: false, hasSemanticPayload: true }, 'host-forced-non-coldstart'],
    ['F. firstTurn=true + explicit recall', { isFirstTurn: true, explicitRecall: true, hasSemanticPayload: true }, 'explicit-recall']
  ];

  for (const [label, intent, want] of cases) {
    check('P.' + label, decide(intent) === want, 'got ' + decide(intent) + ', want ' + want);
  }
  check('P.explicitRecallBeatsAutomaticColdStart',
    decide({ isFirstTurn: true, explicitRecall: true, hasSemanticPayload: true }) === 'explicit-recall',
    'an AUTOMATIC lifecycle signal must not steal an EXPLICIT user recall intent');
  check('P.coldStartBeatsEarlyExitOnFirstTurn',
    decide({ isFirstTurn: true, explicitRecall: false, hasSemanticPayload: false }) === 'coldstart-first-turn',
    'a first-turn acknowledgement is exactly when coldStart matters most');
  check('P.nonFirstTurnAcknowledgementStillEarlyExits',
    decide({ isFirstTurn: false, explicitRecall: false, hasSemanticPayload: false }) === 'early-exit',
    'R2-D behaviour for non-first-turn acknowledgements must not change');
  check('P.precedenceTableIsFrozen', PRECEDENCE.length === 5
    && PRECEDENCE[1] === 'explicit-recall' && PRECEDENCE[2] === 'coldstart-first-turn');

  /* ══════════════════════════════════════════════════════════════════
     §D · 本轮**未**启用 coldStart（latent 证明）
     ══════════════════════════════════════════════════════════════════ */
  section('§D · coldStart is latent (not enabled)');

  const CP = require(path.join(ROOT, 'assets/js/memory-recall/channel-policy.js'));
  const coldPolicy = CP.resolveChannelPolicy('coldStart');
  /* ⚠ PHASE TRANSITION（R2-E1a → R2-E1b，有意更新）：
     E1a 断言 coldStart 仍为 FUTURE、且 orchestrator **不读**会话信号（纯 latent）。
     E1b 的目标正是消费该信号并启用 coldStart ⇒ 两条断言按设计失效。
     现在正确的判据是：channel 已实现 + orchestrator 确实读取信号 +
     四个条件缺一不可（§22），且群聊不自动 coldStart（§23）。 */
  check('L1.coldStartNowImplemented', coldPolicy.ok === true && coldPolicy.implemented === true
    && coldPolicy.future === false, JSON.stringify(coldPolicy));
  check('L1.coldStartInImplementedChannels', CP.listImplementedChannels().indexOf('coldStart') >= 0);
  check('L2.orchestratorConsumesConversationSignal',
    /isFirstTurn/.test(ORCH_SRC) && /conversationId/.test(ORCH_SRC),
    'R2-E1b: the orchestrator now reads the E1a conversation signal');
  check('L2.orchestratorHasColdStartBranch', ORCH_SRC.indexOf("'coldStart'") >= 0);
  check('L3.signalUnavailableNeverColdStarts', (() => {
    const O = require(path.join(ROOT, 'assets/js/memory-recall/memory-recall-orchestrator.js'));
    const rec = [{ id: 'a', title: 't', content: 'c', importance: 5, arousal: .3, resolved: false,
      activationCount: 0, created: FIXED_MS - 86400000, lastActivated: FIXED_MS - 86400000,
      visibility: 'public', tags: [], domain: '日常', pinned: true }];
    const base = { apiId: 'r', now: FIXED_MS, random: () => .42, isGroup: false, groupMemEnabled: false,
      maxChars: 2000, contentLen: 200, userMessage: '嗯' };
    const off = O.recall(rec, Object.assign({}, base, { turn: { message: '嗯' } }));
    const on = O.recall(rec, Object.assign({}, base, { turn: { message: '嗯',
      conversationSignalAvailable: true, isFirstTurn: true, conversationId: 'dm:r' } }));
    return (off.trace.channel !== 'coldStart') && (on.trace.channel === 'coldStart');
  })(), 'signal unavailable ⇒ no coldStart; signal present + first turn ⇒ coldStart');

  console.log('\n' + '='.repeat(64));
  if (failures) {
    console.error('MEMORY RECALL COLDSTART SIGNAL FAILED · ' + failures + ' assertion(s), ' + passed + ' passed');
    process.exitCode = 1;
  } else {
    console.log('MEMORY RECALL COLDSTART SIGNAL PASSED · ' + passed + ' assertions green');
  }
}

main().catch(e => { console.error('CRASHED · ' + (e && e.stack || e)); process.exitCode = 1; });
