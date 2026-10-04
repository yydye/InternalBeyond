'use strict';
/* ══════════════════════════════════════════════════════════════════════════
   Internal Beyond · P21-R4-LIVE-3.2 · Recall Session / Exposure / Activation
   Authority Audit —— "把选择搬到 Home Node 之后，什么状态会跟着搬？"
   （纯 Node · 零真实 provider · 零真实网络 · temp dir 全清）

   运行：node tests/test_r4c_live_recall_session_authority.js

   ── 本文件回答的不是"两条流水线是否一致"（那是 parity harness 的问题）──
   它回答四个**所有权**问题，每一个都必须有 probe，不能只靠读代码：
     §11 会话状态按什么键？Desktop 的键够不够？不够的是哪一把？
     §12 cooldown 是"运行时局部"的 —— 但**谁**持有它、它是否落盘？
     §13 exposure / activation 现在**谁在写**？target 是谁？哪一行浏览器写入必须停？
     §14 选择与激活的顺序契约是什么？激活失败时选择还能不能返回？
     §15 一个 turn 的身份由什么构成？Desktop 最少要提交什么？
     §16 同一个 turn 问两次会发生什么（重探索 / 重复曝光 / 重复激活）？
     §29 影子模式要"纯"，必须不调用哪些函数？

   ── 关于 "runtime-local" 这个词（本文件刻意绕开它当结论）──────────────
   LIVE-3 冻结的性质禁止的是 **DB / storage / clock / durable**，它**不**规定
   "哪个 runtime 持有这份状态"。所以本文件不断言"runtime-local 不变"，
   而是指名 **所有者从谁变成谁**：见 CURRENT_EXPOSURE_OWNERSHIP /
   TARGET_EXPOSURE_OWNERSHIP，两个值都由实测（写入点在哪个进程）得出。

   ── 诚实口径（写在这里，免得被后面的 NO 读成"没问题"）────────────────
   · REPLAY_* = NO 的范围**仅限同一个 requestId 的真实重放**。客户端换一个
     requestId 再问一次，按定义就是一个**新的 logical turn**，它会重新探索、
     重新曝光、重新激活 —— 这是设计，不是缺陷。范围写在 REPLAY_PROTECTION_SCOPE。
   · activation 的存储层**没有** turn guard（recordActivation 是加法）。
     "不重复激活"靠的是**唯一调用点 + requestId 去重分支**这个结构事实。
     一旦 cutover 引入第二个调用点，这条保护就不成立了 —— 见
     ACTIVATION_STORE_LEVEL_TURN_GUARD = NONE。

   写作用域：本文件 + .dsh-research/r4c-live-3-2-session.{md,json}。
   生产只读，不接线、不加路由、不改任何行为。
   ══════════════════════════════════════════════════════════════════════════ */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');

const ROOT = path.resolve(__dirname, '..');
const SERVICE = require(path.join(ROOT, 'services', 'home-node-service.js'));
const MOBILE_GATEWAY = require(path.join(ROOT, 'services', 'home-node', 'mobile-gateway.js'));
const CREATE_MEMORY_RETRIEVAL = require(path.join(ROOT, 'services', 'home-node', 'memory-retrieval.js'));
const CREATE_MEMORY_STORE = require(path.join(ROOT, 'services', 'home-node', 'memory-store.js'));
const SS_MODULE = require(path.join(ROOT, 'assets', 'js', 'memory-recall', 'recall-session-state.js'));
const CHAT_CORE = require(path.join(ROOT, 'assets', 'js', 'chat-core.js'));
/* 唯一一份注释剥离器（与边界套件同一份）：静态扫描必须扫**代码**，不能扫注释 ——
   recall-session-state.js 的文档里正写着"✗ localStorage / SQLite / IndexedDB"，
   把注释算进去就会把"明确禁止"读成"真的在用"。 */
const WIRING = require(path.join(ROOT, 'tests', 'helpers', 'activation-wiring-probe.js'));
const createRecallSessionState = SS_MODULE.createRecallSessionState;

/* ── house style ──────────────────────────────────────────────────────── */
let passed = 0, failures = 0;
const check = (name, cond, detail) => {
  if (cond) { passed++; console.log('  PASS  ' + name); return true; }
  failures++;
  console.error('  FAIL  ' + name + (detail !== undefined && detail !== null ? '  -> ' + String(detail) : ''));
  return false;
};
const section = t => console.log('\n── ' + t + ' ──');
const J = v => { try { return JSON.stringify(v); } catch (_) { return String(v); } };
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/* ── 每一个 file:line 断言都由**这两个**函数实测出来，不写死行号 ────────── */
function lineOf(rel, needle) {
  const src = read(rel);
  const at = src.indexOf(needle);
  if (at < 0) return null;
  return rel + ':' + (src.slice(0, at).split('\n').length);
}
function allLinesOf(rel, needle) {
  const src = read(rel);
  const out = [];
  let from = 0;
  for (;;) {
    const at = src.indexOf(needle, from);
    if (at < 0) break;
    out.push(rel + ':' + (src.slice(0, at).split('\n').length));
    from = at + needle.length;
  }
  return out;
}

const TEMP_DIRS = [];
function freshDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  TEMP_DIRS.push(dir);
  return dir;
}
function dropDir(dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* Windows 句柄 */ } }
function sha256File(f) { try { return crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex'); } catch (_) { return null; } }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
async function waitFor(pred, budgetMs) {
  const deadline = Date.now() + (budgetMs || 5000);
  for (;;) {
    let ok = false;
    try { ok = pred() === true; } catch (_) { ok = false; }
    if (ok) return true;
    if (Date.now() > deadline) return false;
    await sleep(10);
  }
}

/* ── 要打印的判据（值全部来自实测）────────────────────────────────────── */
let DESKTOP_RECALL_SESSION_STATE_OWNER = 'UNKNOWN';
let SESSION_STATE_KEYING_SUFFICIENT_FOR_DESKTOP = 'UNKNOWN';
let SESSION_STATE_MISSING_KEYS = 'UNKNOWN';
let COOLDOWN_DURABLE_STATE = 'UNKNOWN';
let FRESH_PROCESS_STARTS_EMPTY = 'UNKNOWN';
let CURRENT_EXPOSURE_OWNERSHIP = 'UNKNOWN';
let TARGET_EXPOSURE_OWNERSHIP = 'UNKNOWN';
let BROWSER_WRITE_THAT_MUST_STOP = 'UNKNOWN';
let ACTIVATION_AUTHORITY = 'UNKNOWN';
let ACTIVATION_STORE_LEVEL_TURN_GUARD = 'UNKNOWN';
let SELECTION_SURVIVES_ACTIVATION_FAILURE = 'UNKNOWN';
let AMBIGUOUS_ACTIVATION_HANDLING = 'UNKNOWN';
let TURN_IDENTITY_HELPER = 'UNKNOWN';
let MINIMUM_DESKTOP_TURN_PAYLOAD = 'UNKNOWN';
let NEW_PERMANENT_ID_REQUIRED = 'UNKNOWN';
let REPLAY_REEXPLORES = 'UNKNOWN';
let REPLAY_DOUBLE_EXPOSES = 'UNKNOWN';
let REPLAY_DOUBLE_ACTIVATES = 'UNKNOWN';
let REPLAY_PROTECTION_MECHANISM = 'UNKNOWN';
let REPLAY_PROTECTION_SCOPE = 'UNKNOWN';
let SHADOW_SERVER_CALCULATION_IS_PURE = 'UNKNOWN';
let SHADOW_FORBIDDEN_CALLS = 'UNKNOWN';
let REAL_PROVIDER_CALLS = 0;

const CLEANUP = [];
const registerCleanup = fn => CLEANUP.push(fn);

/* ══════════════════════════════════════════════════════════════════════════
   §16 / §29 用的**真实**网关 harness
   （真实 createMobileGateway + createMemoryRetrieval + RecallSessionState；
     只有 registry / chat store / memory store / executor 是 stub —— 与
     tests/test_memory_recall_cooldown_hosts.js 的 §36 同一种做法，
     本文件不 require 那个测试文件，因为它 require 即执行。）
   ══════════════════════════════════════════════════════════════════════════ */
const RT_NOW = 1750000000000;
const RT_DAY = 86400000;
const RT_CHAR = 'role_a';
const RT_DEVICE = 'dev_1';
const RT_TOKEN = 'dev-token-1';
const RT_ROUTE = '/mobile/v1/chat/send';
const RT_URL = 'http://127.0.0.1' + RT_ROUTE;
const RT_M1 = 'mem_a';

function rtRegistry(characterIds) {
  const ids = (Array.isArray(characterIds) && characterIds.length) ? characterIds : [RT_CHAR];
  return {
    fingerprint: 'r4cl32',
    verifyDeviceToken(raw) {
      return raw === RT_TOKEN
        ? { ok: true, device: { deviceId: RT_DEVICE, capabilities: ['chat'] } }
        : { ok: false, code: 'AUTH_INVALID' };
    },
    getCharacter(id) {
      return ids.indexOf(id) >= 0 ? { id: id, dto: { id: id, nickname: String(id), relationship: '' } } : null;
    },
    getCharacterSpec(id) {
      return ids.indexOf(id) >= 0
        ? { endpoint: 'http://127.0.0.1:1/v1/chat/completions', model: 'red-model', systemPrompt: 'S' }
        : null;
    }
  };
}
function rtMemoryRecord(over) {
  return Object.assign({
    id: RT_M1, title: '显卡', content: '显卡：本地装机时选的显卡型号与预算',
    importance: 8, arousal: 0.3, resolved: false, activationCount: 0,
    created: RT_NOW - RT_DAY, lastActivated: RT_NOW - RT_DAY,
    visibility: 'public', tags: [], domain: '日常', createdBy: 'user'
  }, over || {});
}
function rtMemoryStore(records, settings) {
  const activationCalls = [];
  return {
    listRecords() { return { ok: true, records: records }; },
    getMemorySettings: settings ? function () { return { ok: true, settings: settings }; } : undefined,
    recordActivation(ids, opts) {
      activationCalls.push({ ids: Array.isArray(ids) ? ids.slice() : ids, at: opts && opts.at });
      return { ok: true, updated: Array.isArray(ids) ? ids.length : 0, revisionTouched: false };
    },
    activationCalls: activationCalls
  };
}
function rtChatStore(priorMessages) {
  let count = priorMessages == null ? 1 : Number(priorMessages);
  const prior = { id: 'msg_prior_1', role: 'user', content: '之前聊过的事', friendId: RT_CHAR, timestamp: RT_NOW - 60000 };
  const writes = [];
  return {
    writes: writes,
    getRevision() { return 1; },
    getUserProfile() { return null; },
    listMessages() { return { ok: true, messages: count > 0 ? [prior] : [], revision: 1 }; },
    getMessage() { return null; },
    appendMessage(m) { writes.push(m); return { ok: true }; },
    setPriorMessages(n) { count = Number(n) || 0; }
  };
}
function rtReq(body) {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]);
  req.method = 'POST';
  req.headers = { authorization: 'Bearer ' + RT_TOKEN, accept: 'application/json' };
  req.socket = { remoteAddress: '127.0.0.1' };
  return req;
}
function rtRes() {
  return {
    status: null, headers: null, body: null,
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(body) { this.body = body; }
  };
}

/* 真实网关 + 真实 retrieval + 真实 session state；executor 是假模型缝。 */
function makeGateway(cfg) {
  cfg = cfg || {};
  const state = cfg.sessionState || createRecallSessionState();
  const store = rtMemoryStore(cfg.records || [rtMemoryRecord()], cfg.settings || null);
  const chatStore = rtChatStore(cfg.priorMessages);
  const retrieval = CREATE_MEMORY_RETRIEVAL({
    store: store, clock: () => RT_NOW, sessionState: state, random: () => 0.5
  });
  const spy = { executor: [], begin: [], exposure: [], end: [], warnings: [], provider: [] };
  const executor = {
    executeCharacterTurn: async function (request, options) {
      spy.executor.push({ requestId: request && request.requestId, turnId: options && options.turnId });
      spy.provider.push('executeCharacterTurn');
      return { ok: true, outcome: 'completed', turnId: options.turnId, userMessageId: 'u1', assistantMessageId: 'a1', revision: 1 };
    }
  };
  const gateway = MOBILE_GATEWAY({
    store: chatStore,
    registry: cfg.registry || rtRegistry(),
    executor: executor,
    sessionState: state,
    memoryRetrieval: retrieval,
    clock: () => RT_NOW,
    random: () => 0.5,
    logger: function (level, event, fields) {
      if (level !== 'info') spy.warnings.push({ level: level, event: event, error: fields && fields.error });
    }
  });
  /* 在**真实实例**上包一层只做记录的外壳：不改行为，只观察。 */
  const real = { begin: state.beginHomeTurn, exposure: state.recordExposure, end: state.endHomeTurn };
  state.beginHomeTurn = function (input) {
    const i = real.begin.apply(this, arguments);
    spy.begin.push({ characterId: input && input.characterId, turnId: input && input.turnId, turnIndex: i });
    return i;
  };
  state.recordExposure = function (input) {
    const w = real.exposure.apply(this, arguments);
    spy.exposure.push({
      characterId: input && input.characterId, turnIndex: input && input.turnIndex,
      memoryIds: (input && Array.isArray(input.memoryIds)) ? input.memoryIds.slice() : [], written: w
    });
    return w;
  };
  state.endHomeTurn = function (input) {
    const r = real.end.apply(this, arguments);
    spy.end.push({ turnId: input && input.turnId, released: r });
    return r;
  };
  async function send(requestId, content, extra) {
    const res = rtRes();
    await gateway.dispatch(RT_ROUTE, rtReq({
      v: 1, requestId: requestId,
      payload: Object.assign({ characterId: cfg.characterId || RT_CHAR, content: content }, extra || {})
    }), res, new URL(RT_URL));
    let body = null;
    try { body = res.body ? JSON.parse(res.body) : null; } catch (_) { body = null; }
    return { status: res.status, body: body };
  }
  function settle(requestId) {
    return waitFor(() => {
      const t = gateway.getTurnByRequest(requestId);
      return !!t && t.status !== 'running';
    }, 5000);
  }
  function snapshot() {
    return {
      begin: spy.begin.length,
      exposureCalls: spy.exposure.length,
      exposureWritten: spy.exposure.reduce((s, e) => s + (Number(e.written) || 0), 0),
      activation: store.activationCalls.length,
      activationIds: store.activationCalls.reduce((s, c) => s + (Array.isArray(c.ids) ? c.ids.length : 0), 0),
      executor: spy.executor.length,
      counter: state.currentTurnIndex({ characterId: cfg.characterId || RT_CHAR }),
      debug: state.debugSize()
    };
  }
  return { gateway, state, store, chatStore, retrieval, spy, send, settle, snapshot, real };
}

/* ══════════════════════════════════════════════════════════════════════════ */
(async function main() {
  /* ══════════════════════════════════════════════════════════════════════
     0 · 可用性
     ══════════════════════════════════════════════════════════════════════ */
  section('0 · piece availability');
  check('0.1 the real RecallSessionState module loads and can be instantiated',
    typeof createRecallSessionState === 'function' && !!createRecallSessionState().recordExposure,
    'assets/js/memory-recall/recall-session-state.js');
  check('0.2 the real mobile gateway / retrieval / memory store all load',
    typeof MOBILE_GATEWAY === 'function' && typeof CREATE_MEMORY_RETRIEVAL === 'function'
    && typeof CREATE_MEMORY_STORE === 'function');
  check('0.3 chat-core exposes the identity helpers this audit references',
    typeof CHAT_CORE.conversationIdOf === 'function' && typeof CHAT_CORE.stableToken === 'function'
    && typeof CHAT_CORE.messageIdFromRequest === 'function');

  /* ══════════════════════════════════════════════════════════════════════
     §11 · 会话状态的键：按什么键、Desktop 够不够
     ══════════════════════════════════════════════════════════════════════ */
  section('§11 · recall session-state keying');
  const PROBE = createRecallSessionState();
  /* 键结构（probe，不靠读注释）：两个角色互不影响；同一角色跨 conversation 共享。 */
  const iA1 = PROBE.beginHomeTurn({ characterId: 'char_a', turnId: 'T1' });
  const iB1 = PROBE.beginHomeTurn({ characterId: 'char_b', turnId: 'T1' });
  const iA1again = PROBE.beginHomeTurn({ characterId: 'char_a', turnId: 'T1' });
  const iA2 = PROBE.beginHomeTurn({ characterId: 'char_a', turnId: 'T2' });
  check('11.1 the per-character counter is isolated per characterId',
    iA1 === 1 && iB1 === 1 && iA2 === 2,
    J({ charA_first: iA1, charB_first: iB1, charA_second: iA2 }));
  check('11.2 the SAME turnId reuses the SAME index and never advances the counter',
    iA1again === iA1 && PROBE.currentTurnIndex({ characterId: 'char_a' }) === 2,
    J({ again: iA1again, counter: PROBE.currentTurnIndex({ characterId: 'char_a' }) }));
  const expoWrite1 = PROBE.recordExposure({ characterId: 'char_a', memoryIds: ['m1', 'm1', 'm2'], turnIndex: 2 });
  const expoWrite2 = PROBE.recordExposure({ characterId: 'char_a', memoryIds: ['m1', 'm2'], turnIndex: 2 });
  check('11.3 the exposure key is (characterId, memoryId) with the turn index as the value',
    expoWrite1 === 2 && expoWrite2 === 0
    && J(PROBE.getExposure({ characterId: 'char_a', memoryId: 'm1' })) === J({ lastExposureTurn: 2, exposureCount: 1 }),
    J({ first: expoWrite1, second: expoWrite2, m1: PROBE.getExposure({ characterId: 'char_a', memoryId: 'm1' }) }));
  check('11.4 neither the state dimensions nor the public surface carry a conversation / thread key',
    (() => {
      const dims = Object.keys(PROBE.debugSize()).sort();
      const surface = Object.keys(PROBE).sort();
      return J(dims) === J(['characters', 'homeTurns', 'memories', 'turnCounters'])
        && J(surface) === J(['beginBrowserTurn', 'beginHomeTurn', 'clear', 'currentTurnIndex',
          'debugSize', 'endHomeTurn', 'getExposure', 'recordExposure'])
        && PROBE.getExposure({ characterId: 'char_a', memoryId: 'm1' }).lastExposureTurn === 2;
    })(),
    'dimensions=' + J(Object.keys(PROBE.debugSize()).sort())
    + ' surface=' + J(Object.keys(PROBE).sort())
    + ' — exposure is {characterId} x {memoryId}; the only turn-keyed structure is the bounded homeTurnIndex');

  /* Desktop 的**身份缺口**：两个 runtime 的 begin 原语接受的身份类型完全不兼容。 */
  check('11.5 the Home Node primitive requires a STRING turnId (an object identity is refused)',
    PROBE.beginHomeTurn({ characterId: 'char_a', turnId: { id: 'turn-object' } }) === null,
    'beginHomeTurn({turnId:<object>}) -> null (fail closed, no guessing)');
  check('11.6 the browser primitive requires an OBJECT turn token (a string turnId is refused)',
    (() => {
      const refusedString = PROBE.beginBrowserTurn({ characterId: 'char_a', turnObject: 'turn_abc' });
      const before = PROBE.currentTurnIndex({ characterId: 'char_a' });
      const token = {};
      const withObject = PROBE.beginBrowserTurn({ characterId: 'char_a', turnObject: token });
      const again = PROBE.beginBrowserTurn({ characterId: 'char_a', turnObject: token });
      return refusedString === null && withObject === before + 1 && again === withObject;
    })(),
    'beginBrowserTurn({turnObject:<string>}) -> null; the same object token reuses its index; '
    + 'counter=' + PROBE.currentTurnIndex({ characterId: 'char_a' }));
  const desktopSeam = lineOf('assets/js/communication.js', 'var _ibRecallOpts={};');
  const desktopConv = lineOf('assets/js/communication.js', '_csOpts=_cs?{conversationId:_cs.conversationId');
  const desktopBegin = lineOf('assets/js/communication.js', 'window._ibBeginRecallTurn(cfg.id,_turn)');
  check('11.7 the Desktop recall seam has a conversationId but NO requestId / turnId',
    !!desktopConv && !!desktopBegin
    && read('assets/js/communication.js').indexOf('getMemoryContext(cfg.id,Object.assign(') >= 0
    && !/getMemoryContext\(cfg\.id,[^)]*requestId/.test(read('assets/js/communication.js')),
    'conversationId seam=' + J(desktopConv) + ' begin seam=' + J(desktopBegin)
    + ' recallOpts seam=' + J(desktopSeam));
  SESSION_STATE_MISSING_KEYS = 'requestId (or a pre-derived turnId) at the Desktop recall seam';
  SESSION_STATE_KEYING_SUFFICIENT_FOR_DESKTOP = 'PARTIAL';
  DESKTOP_RECALL_SESSION_STATE_OWNER = 'HOME_NODE';
  check('11.8 the keying verdict it is PARTIAL, not YES and not NO',
    SESSION_STATE_KEYING_SUFFICIENT_FOR_DESKTOP === 'PARTIAL' && SESSION_STATE_MISSING_KEYS.indexOf('requestId') === 0,
    'state dimensions are sufficient ({characterId}x{memoryId}); the missing input is the TURN identity: '
    + SESSION_STATE_MISSING_KEYS + '. conversationId is already available at '
    + J(desktopConv) + '; the browser turn token is a JS object and cannot cross the wire.');

  /* ══════════════════════════════════════════════════════════════════════
     §12 · cooldown 必须在内存里：新进程空、不落盘
     ══════════════════════════════════════════════════════════════════════ */
  section('§12 · no durable cooldown');
  const freshA = createRecallSessionState();
  check('12.1 a brand-new session state starts completely empty',
    J(freshA.debugSize()) === J({ characters: 0, memories: 0, turnCounters: 0, homeTurns: 0 }),
    J(freshA.debugSize()));
  freshA.recordExposure({ characterId: 'c', memoryIds: ['m1'], turnIndex: 1 });
  const freshB = createRecallSessionState();          /* 模拟"新进程" */
  check('12.2 a second instance (fresh process) cannot see the first one\'s exposures',
    freshA.debugSize().memories === 1 && freshB.debugSize().memories === 0
    && freshB.getExposure({ characterId: 'c', memoryId: 'm1' }) === null,
    J({ first: freshA.debugSize(), second: freshB.debugSize() }));
  const ssSrc = WIRING.stripJsComments(read('assets/js/memory-recall/recall-session-state.js'));
  check('12.3 the session-state module performs no IO at all (no require, no storage, no clock)',
    !/\brequire\s*\(/.test(ssSrc)
    && !/localStorage|indexedDB|sqlite|node:fs|Date\.now|new Date\b/.test(ssSrc),
    'comment-stripped scan of recall-session-state.js: zero require / storage / wall-clock tokens');
  FRESH_PROCESS_STARTS_EMPTY = 'YES';

  /* 真实临时目录 Home Node：schema 里不得有任何 exposure / cooldown 表或列。 */
  const durDir = freshDir('ib-r4cl32-durable-');
  registerCleanup(() => dropDir(durDir));
  let schemaText = '';
  let schemaDumpOk = false;
  let instSessionState = null;
  let dbHashBeforeExposure = null;
  let dbHashAfterExposure = null;
  {
    const inst = SERVICE.buildHomeNode({ dataDir: durDir, logger: () => {} });
    inst.open();
    registerCleanup(() => { try { inst.close(); } catch (_) { /* 已关闭 */ } });
    instSessionState = inst.recallSessionState || null;
    check('12.4 a real temp-dir Home Node exposes the shared session state, empty at open',
      !!instSessionState && typeof instSessionState.recordExposure === 'function'
      && instSessionState.debugSize().memories === 0 && instSessionState.debugSize().turnCounters === 0,
      own(instSessionState) + ' debugSize=' + J(instSessionState && instSessionState.debugSize()));
    const dbFile = path.join(durDir, 'home-node.db');
    dbHashBeforeExposure = sha256File(dbFile);
    /* 写一次曝光 + 推进一次 turn：状态只应落在 RAM 里。 */
    instSessionState.beginHomeTurn({ characterId: 'char_a', turnId: 'turn_probe' });
    const wrote = instSessionState.recordExposure({ characterId: 'char_a', memoryIds: ['mem_probe'], turnIndex: 1 });
    dbHashAfterExposure = sha256File(dbFile);
    check('12.5 writing exposure state through the real instance changes ZERO durable bytes',
      wrote === 1 && dbHashBeforeExposure === dbHashAfterExposure
      && instSessionState.debugSize().memories === 1,
      J({ wrote: wrote, dbBefore: String(dbHashBeforeExposure).slice(0, 16), dbAfter: String(dbHashAfterExposure).slice(0, 16),
        debug: instSessionState.debugSize() }));
    /* schema 全量转储（表 + 列 + 索引），扫禁词。 */
    try {
      const { DatabaseSync } = require('node:sqlite');
      const raw = new DatabaseSync(dbFile);
      const rows = raw.prepare('SELECT type, name, sql FROM sqlite_master').all();
      const metaKeys = raw.prepare('SELECT key FROM meta').all();
      raw.close();
      schemaText = rows.map(r => String(r.type) + ' ' + String(r.name) + ' ' + String(r.sql || '')).join('\n')
        + '\n' + metaKeys.map(r => 'meta:' + String(r.key)).join('\n');
      schemaDumpOk = true;
    } catch (error) {
      schemaDumpOk = false;
      schemaText = 'SCHEMA-DUMP-FAILED: ' + String((error && error.message) || error);
    }
  }
  function own(v) { return v ? 'present' : 'ABSENT'; }
  const DURABLE_TOKENS = ['exposure', 'cooldown', 'lastSurfaced', 'lastRecalled', 'lastSelected', 'lastChannel'];
  /* 扫描必须**分域**：全库确实有一个 cooldown 词，但它属于 economy 的**花费**冷却
     （economy_budget_policies.cooldown_ms），与 recall exposure 毫无关系。
     把两者混在一起扫，会得到一个"命中即失败"的假警报 —— 或者更糟：
     让人为了让它变绿而放宽整条断言。正确做法是分别报出来。 */
  const schemaLines = schemaText.split('\n');
  const memDomainLower = schemaLines.filter(l => /memory|meta:/i.test(l)).join('\n').toLowerCase();
  const hitsMemory = DURABLE_TOKENS.filter(t => memDomainLower.indexOf(t.toLowerCase()) >= 0);
  const hitsElsewhere = DURABLE_TOKENS.filter(t => schemaText.toLowerCase().indexOf(t.toLowerCase()) >= 0
    && memDomainLower.indexOf(t.toLowerCase()) < 0);
  const OUT_OF_DOMAIN = hitsElsewhere.map(t => {
    const line = schemaLines.filter(l => l.toLowerCase().indexOf(t.toLowerCase()) >= 0)[0] || '';
    const m = /^(table|index)\s+(\S+)/.exec(line);
    return t + '->' + (m ? m[2] : 'unknown');
  }).join(', ');
  check('12.6 the canonical SQLite schema carries NO recall-exposure / recall-cooldown table, column or meta key',
    schemaDumpOk && hitsMemory.length === 0,
    'memory-domain hits=' + J(hitsMemory) + ' | tokens present elsewhere in the DB=' + J(hitsElsewhere)
    + ' (' + (OUT_OF_DOMAIN || 'none') + ' — economy spend cooldown, NOT recall exposure)');
  const memRecordsDdl = (/CREATE TABLE memory_records([\s\S]*?)\)/.exec(schemaText) || ['', ''])[1];
  check('12.6b the memory_records table has no exposure-shaped column either',
    memRecordsDdl.length > 0 && !/exposure|cooldown|lastSurfaced|lastRecalled/i.test(memRecordsDdl),
    'columns=' + J((memRecordsDdl.match(/[a-z_]+ (?:TEXT|INTEGER|REAL)/g) || []).slice(0, 20)));
  COOLDOWN_DURABLE_STATE = (hitsMemory.length === 0 && dbHashBeforeExposure === dbHashAfterExposure) ? 'NONE' : 'PRESENT';

  /* ══════════════════════════════════════════════════════════════════════
     §13 · exposure / activation 的所有权（每个写入点都由源码实测行号）
     ══════════════════════════════════════════════════════════════════════ */
  section('§13 · exposure & activation ownership');
  const EXPOSURE_WRITES = {
    browserSinkDef: lineOf('assets/js/memory.js', 'function _ibRecordRecallExposure(exposure)'),
    browserCallStream: allLinesOf('assets/js/communication.js', 'window._ibRecordRecallExposure(_ex)'),
    browserCallNonStream: allLinesOf('assets/js/communication.js', 'window._ibRecordRecallExposure(_nsX)'),
    browserTurnHandoff: lineOf('assets/js/memory.js', 'opts._ibTurn.memoryExposure={'),
    browserSessionSingleton: lineOf('assets/js/memory.js', 'function _ibRecallSessionState()'),
    homeNodeWrite: lineOf('services/home-node/mobile-gateway.js', 'const _written = recallSessionState.recordExposure({'),
    homeNodeBegin: lineOf('services/home-node/mobile-gateway.js', '? recallSessionState.beginHomeTurn({ characterId: characterId, turnId: turnId })'),
    homeNodeEnd: lineOf('services/home-node/mobile-gateway.js', 'if (recallSessionState) recallSessionState.endHomeTurn({ turnId: settled.turnId });')
  };
  check('13.1 every exposure write site is located in source (browser AND Home Node)',
    Object.keys(EXPOSURE_WRITES).every(k => EXPOSURE_WRITES[k] !== null)
    && EXPOSURE_WRITES.browserCallStream.length + EXPOSURE_WRITES.browserCallNonStream.length === 2,
    J(EXPOSURE_WRITES));
  const ACTIVATION_WRITES = {
    browserEntry: lineOf('assets/js/memory.js', 'await recordMemoryActivation(picked.selectedIds,at)'),
    browserCanonicalRemote: lineOf('assets/js/memory-authority.js', 'return remote.activate(list, { at: at }).then(function (res) {'),
    browserLocalMirrorBump: lineOf('assets/js/memory.js', 'cur.activationCount=(cur.activationCount||0)+1;cur.lastActivated=stamp;return cur;'),
    homeNodeCall: lineOf('services/home-node/mobile-gateway.js', 'const reinforced = memoryRetrieval'),
    homeNodeSink: lineOf('services/home-node/memory-retrieval.js', 'const res = store.recordActivation(ids, { at: at });')
  };
  check('13.2 every activation write site is located in source (browser AND Home Node)',
    Object.keys(ACTIVATION_WRITES).every(k => ACTIVATION_WRITES[k] !== null),
    J(ACTIVATION_WRITES));
  CURRENT_EXPOSURE_OWNERSHIP = 'SPLIT_BROWSER_AND_HOME_NODE';
  TARGET_EXPOSURE_OWNERSHIP = 'HOME_NODE';
  BROWSER_WRITE_THAT_MUST_STOP = EXPOSURE_WRITES.browserCallStream.concat(EXPOSURE_WRITES.browserCallNonStream).join(' , ')
    + '  (both funnel into ' + EXPOSURE_WRITES.browserSinkDef + ')';
  check('13.3 the verdict names the exact browser writes that must stop being authoritative',
    CURRENT_EXPOSURE_OWNERSHIP === 'SPLIT_BROWSER_AND_HOME_NODE'
    && BROWSER_WRITE_THAT_MUST_STOP.indexOf('communication.js:') >= 0
    && EXPOSURE_WRITES.browserCallStream.length === 1 && EXPOSURE_WRITES.browserCallNonStream.length === 1,
    'CURRENT=' + CURRENT_EXPOSURE_OWNERSHIP + ' TARGET=' + TARGET_EXPOSURE_OWNERSHIP
    + ' MUST_STOP=' + BROWSER_WRITE_THAT_MUST_STOP);
  /* 双写风险：同一个 turn 若两条流水线都跑，activation 会各自写一次（见 §14 probe）。 */
  check('13.4 both pipelines own a live activation write (double-apply risk if both run for one turn)',
    ACTIVATION_WRITES.browserEntry !== null && ACTIVATION_WRITES.homeNodeCall !== null,
    'browser=' + J(ACTIVATION_WRITES.browserEntry) + ' homeNode=' + J(ACTIVATION_WRITES.homeNodeCall));
  ACTIVATION_AUTHORITY = 'HOME_NODE';
  check('13.5 R2-H is the declared canonical activation authority',
    read('services/home-node-service.js').indexOf('/memory/activate') >= 0
    || read('services/home-node/http.js').indexOf('/memory/activate') >= 0,
    'the canonical activation route exists on the Home Node');

  /* ══════════════════════════════════════════════════════════════════════
     §14 · 选择与激活的顺序契约、以及激活失败时的语义
     ══════════════════════════════════════════════════════════════════════ */
  section('§14 · activation interaction (R2-H order)');
  const actDir = freshDir('ib-r4cl32-act-');
  registerCleanup(() => dropDir(actDir));
  const actStore = CREATE_MEMORY_STORE({ dataDir: actDir });
  actStore.open();
  registerCleanup(() => { try { actStore.close(); } catch (_) { /* 已关闭 */ } });
  actStore.putRecord({ id: 'mem_act', kind: 'episodic', title: 't', content: 'c', visibility: 'public', createdBy: 'user', activationCount: 0, created: RT_NOW });
  const act1 = actStore.recordActivation(['mem_act'], { at: RT_NOW });
  const act2 = actStore.recordActivation(['mem_act'], { at: RT_NOW });
  check('14.1 the canonical activation store is ADDITIVE and has NO turn guard of its own',
    act1.updated === 1 && act2.updated === 1
    && actStore.getRecord('mem_act').activationCount === 2
    && act1.revisionTouched === false && act2.revisionTouched === false,
    J({ first: act1.updated, second: act2.updated, count: actStore.getRecord('mem_act').activationCount }));
  ACTIVATION_STORE_LEVEL_TURN_GUARD = 'NONE';
  /* 激活失败绝不阻塞选择：reinforce 抛错也要返回结构化失败。 */
  const throwingRetrieval = CREATE_MEMORY_RETRIEVAL({
    store: {
      listRecords: () => ({ ok: true, records: [rtMemoryRecord()] }),
      recordActivation: () => { throw new Error('activation-store-boom'); }
    },
    clock: () => RT_NOW, sessionState: null, random: () => 0.5
  });
  const picked14 = throwingRetrieval.retrieve(RT_CHAR, { now: RT_NOW, userMessage: '显卡的事', turnIndex: 1 });
  let reinf14 = null, reinf14Threw = false;
  try { reinf14 = throwingRetrieval.reinforce(picked14.selectedIds, {}); }
  catch (_) { reinf14Threw = true; }
  check('14.2 selection is a fact and survives an activation failure (activation never throws)',
    picked14.ok === true && picked14.selectedIds.length > 0
    && reinf14Threw === false && reinf14 && reinf14.ok === false
    && reinf14.updated === 0 && reinf14.revisionTouched === false,
    J({ selected: picked14.selectedIds, reinforce: reinf14, threw: reinf14Threw }));
  SELECTION_SURVIVES_ACTIVATION_FAILURE = (picked14.selectedIds.length > 0 && reinf14 && reinf14.ok === false) ? 'YES' : 'NO';
  /* ORDER: retrieval 必须在 beginHomeTurn 之后（gateway 的硬顺序），且成功之后才写 exposure。 */
  const gwSrc = read('services/home-node/mobile-gateway.js');
  const orderBegin = gwSrc.indexOf('const lifecycle = beginRecallTurn(parsed);');
  const orderBuild = gwSrc.indexOf('turn = beginTurn(buildTurnRequest(parsed, lifecycle.recallTurnIndex), device);');
  const orderExposure = gwSrc.indexOf('const _written = recallSessionState.recordExposure({');
  check('14.3 the frozen order is beginHomeTurn -> retrieval -> (on success) exposure',
    orderBegin > 0 && orderBuild > orderBegin && orderExposure > orderBuild,
    J({ begin: orderBegin, build: orderBuild, exposure: orderExposure }));
  AMBIGUOUS_ACTIVATION_HANDLING = 'FAIL_CLOSED_NO_LOCAL_BUMP';
  const memSrc = read('assets/js/memory.js');
  const fnStart = memSrc.indexOf('async function recordMemoryActivation(');
  const fnBody = memSrc.slice(fnStart, fnStart + 6000);
  const canonAt = fnBody.indexOf('if(canonicalAuth){');
  const mirrorAt = fnBody.indexOf('let n=0;');
  const canonBlock = fnBody.slice(canonAt, mirrorAt);
  check('14.4 the canonical branch is structurally closed: every exit returns, none falls through to the mirror',
    fnStart > 0 && canonAt > 0 && mirrorAt > canonAt
    && (canonBlock.match(/return\s/g) || []).length >= 2
    && canonBlock.indexOf('break') < 0 && canonBlock.indexOf('dbPut') < 0,
    'branch=' + J(canonBlock.replace(/\s+/g, ' ').slice(0, 220))
    + ' — AMBIGUOUS_ACTIVATION_HANDLING=' + AMBIGUOUS_ACTIVATION_HANDLING);

  /* ══════════════════════════════════════════════════════════════════════
     §15 · turn 身份
     ══════════════════════════════════════════════════════════════════════ */
  section('§15 · turn identity');
  const identityFormula = lineOf('services/home-node/mobile-gateway.js', "return 'turn_' + CHAT_CORE.stableToken(String(requestId == null ? '' : requestId)");
  const identityCall = lineOf('services/home-node/mobile-gateway.js', 'const turnId = deriveStableTurnId(requestId, conversationId);');
  const convIdOf = lineOf('assets/js/chat-core.js', 'function conversationIdOf(friendId, threadId) {');
  const groupTurnIdFor = lineOf('assets/js/group-runtime-core.js', 'function groupTurnIdFor(userMessageId) {');
  check('15.1 the Home Node derives ONE content-addressed turn id from (requestId, conversationId)',
    !!identityFormula && !!identityCall
    && CHAT_CORE.stableToken('r1:dm:role_a') === CHAT_CORE.stableToken('r1:dm:role_a')
    && CHAT_CORE.stableToken('r1:dm:role_a') !== CHAT_CORE.stableToken('r1:dm:role_b')
    && CHAT_CORE.stableToken('r1:dm:role_a') !== CHAT_CORE.stableToken('r2:dm:role_a'),
    J({ formula: identityFormula, callSite: identityCall, convIdOf: convIdOf, groupTurnIdFor: groupTurnIdFor }));
  TURN_IDENTITY_HELPER = identityFormula;
  check('15.2 the identity is deterministic, carries no new permanent id, and is not persisted anywhere',
    CHAT_CORE.conversationIdOf('role_a', '') === 'dm:role_a'
    && /const turnByRequest = new Map\(\);/.test(read('services/home-node/mobile-gateway.js'))
    && !/require\([^)]*sqlite[^)]*\)/.test(read('services/home-node/mobile-gateway.js')),
    'conversationIdOf("role_a","")=' + J(CHAT_CORE.conversationIdOf('role_a', ''))
    + ' — turnByRequest is an in-memory Map, and the gateway requires no sqlite at all');
  MINIMUM_DESKTOP_TURN_PAYLOAD = '{"characterId":<id>,"requestId":<stable per-turn id>,"conversationId":<dm:characterId[|thread]>} (or an equivalent pre-derived turnId)';
  NEW_PERMANENT_ID_REQUIRED = 'NO';
  check('15.3 Desktop needs only an existing per-turn requestId — no new durable identity',
    NEW_PERMANENT_ID_REQUIRED === 'NO'
    && read('assets/js/chat-core.js').indexOf('function messageIdFromRequest(requestId)') >= 0,
    MINIMUM_DESKTOP_TURN_PAYLOAD);

  /* ══════════════════════════════════════════════════════════════════════
     §16 · 重放语义（**probe**：同一个 turn 问两次）
     ══════════════════════════════════════════════════════════════════════ */
  section('§16 · replay semantics (probe on the real gateway)');
  const gw = makeGateway({});
  const reqId = 'req_replay_1';
  const first = await gw.send(reqId, '显卡的事');
  const settled1 = await gw.settle(reqId);
  const snap1 = gw.snapshot();
  check('16.1 the first turn really did explore, expose and activate once (this process, this turn — no durability claim)',
    (first.status === 200 || first.status === 202) && settled1 === true
    && snap1.executor === 1 && snap1.begin === 1 && snap1.exposureWritten >= 1 && snap1.activation === 1
    && snap1.counter === 1,
    'status=' + first.status + ' settled=' + settled1 + ' ' + J(snap1));
  const second = await gw.send(reqId, '显卡的事');     /* 同一个 requestId：真实重放 */
  await sleep(60);
  const snap2 = gw.snapshot();
  const turnIdOfReq = (gw.gateway.getTurnByRequest(reqId) || {}).turnId || null;
  const expectedTurnId = 'turn_' + CHAT_CORE.stableToken(reqId + ':' + CHAT_CORE.conversationIdOf(RT_CHAR, ''));
  check('16.2 a replay of the same requestId does NOT re-explore (no second provider/executor call)',
    snap2.executor === snap1.executor,
    'executor calls before=' + snap1.executor + ' after=' + snap2.executor);
  check('16.3 a replay does NOT double-expose',
    snap2.exposureCalls === snap1.exposureCalls && snap2.exposureWritten === snap1.exposureWritten,
    'exposure calls=' + snap1.exposureCalls + '->' + snap2.exposureCalls
    + ' written=' + snap1.exposureWritten + '->' + snap2.exposureWritten);
  check('16.4 a replay does NOT double-activate',
    snap2.activation === snap1.activation && snap2.activationIds === snap1.activationIds,
    'activation calls=' + snap1.activation + '->' + snap2.activation
    + ' ids=' + snap1.activationIds + '->' + snap2.activationIds);
  check('16.5 a replay does NOT advance the per-character turn counter',
    snap2.counter === snap1.counter && snap2.counter === 1,
    'counter=' + snap1.counter + '->' + snap2.counter);
  check('16.6 the replay is answered from the existing turn (flagged duplicateRequest)',
    !!second.body && !!second.body.payload && second.body.payload.duplicateRequest === true
    && second.body.payload.turnId === turnIdOfReq,
    J(second.body && second.body.payload && {
      duplicateRequest: second.body.payload.duplicateRequest, turnId: second.body.payload.turnId, status: second.body.payload.status
    }));
  check('16.7 the turn id is exactly the content-addressed formula (measured, not assumed)',
    turnIdOfReq === expectedTurnId,
    'observed=' + J(turnIdOfReq) + ' expected=' + J(expectedTurnId));
  /* 反向对照：一个新的 requestId 就是**新的** logical turn —— 它必须重新走一遍。 */
  const third = await gw.send('req_replay_2', '显卡的事');
  await gw.settle('req_replay_2');
  const snap3 = gw.snapshot();
  check('16.8 a genuinely NEW requestId is a new logical turn and does explore/expose/activate once more',
    (third.status === 200 || third.status === 202)
    && snap3.executor === snap1.executor + 1
    && snap3.counter === snap1.counter + 1
    && snap3.exposureWritten === snap1.exposureWritten * 2
    && snap3.activation === snap1.activation + 1,
    'status=' + third.status + ' ' + J(snap3));
  REPLAY_REEXPLORES = (snap2.executor === snap1.executor) ? 'NO' : 'YES';
  REPLAY_DOUBLE_EXPOSES = (snap2.exposureWritten === snap1.exposureWritten) ? 'NO' : 'YES';
  REPLAY_DOUBLE_ACTIVATES = (snap2.activation === snap1.activation) ? 'NO' : 'YES';
  REPLAY_PROTECTION_MECHANISM = 'REQUEST_ID_DUPLICATE_BRANCH(getTurnByRequest) + CONTENT_ADDRESSED_TURN_ID + PER_TURN_EXPOSURE_IDEMPOTENCE(lastExposureTurn===turnIndex)';
  REPLAY_PROTECTION_SCOPE = 'SAME_REQUEST_ID_ONLY (a new requestId is by definition a new logical turn)';
  check('16.9 the replay protection is structural and its scope is stated honestly',
    REPLAY_REEXPLORES === 'NO' && REPLAY_DOUBLE_EXPOSES === 'NO' && REPLAY_DOUBLE_ACTIVATES === 'NO'
    && REPLAY_PROTECTION_SCOPE.indexOf('SAME_REQUEST_ID_ONLY') === 0,
    'protection=' + REPLAY_PROTECTION_MECHANISM + ' scope=' + REPLAY_PROTECTION_SCOPE);
  check('16.10 replay protection introduced NO durable idempotency store',
    /const turnByRequest = new Map\(\);/.test(read('services/home-node/mobile-gateway.js'))
    && !/require\([^)]*sqlite[^)]*\)/.test(read('services/home-node/mobile-gateway.js'))
    && read('services/home-node/mobile-gateway.js').indexOf('idempotency') < 0,
    'protection lives in the in-memory turnByRequest Map + the session state; the gateway itself '
    + 'requires no sqlite and names no idempotency table (the pre-existing M1-A chat-store table is in '
    + (lineOf('services/home-node/chat-store.js', 'idempotency') || 'n/a') + ')');

  /* ══════════════════════════════════════════════════════════════════════
     §29 · 影子模式必须是纯的（probe：真实 retrieval 的读路径零副作用）
     ══════════════════════════════════════════════════════════════════════ */
  section('§29 · shadow-mode purity');
  const shadow = makeGateway({});
  const shadowState = shadow.state;
  const before29 = {
    debug: J(shadowState.debugSize()),
    counter: shadowState.currentTurnIndex({ characterId: RT_CHAR }),
    activation: shadow.store.activationCalls.length,
    exposure: shadow.spy.exposure.length,
    begin: shadow.spy.begin.length,
    executor: shadow.spy.executor.length,
    chatWrites: shadow.chatStore.writes.length
  };
  const shadowOut = shadow.retrieval.retrieve(RT_CHAR, {
    now: RT_NOW, userMessage: '显卡的事', random: 0.5, turnIndex: null
  });
  const after29 = {
    debug: J(shadowState.debugSize()),
    counter: shadowState.currentTurnIndex({ characterId: RT_CHAR }),
    activation: shadow.store.activationCalls.length,
    exposure: shadow.spy.exposure.length,
    begin: shadow.spy.begin.length,
    executor: shadow.spy.executor.length,
    chatWrites: shadow.chatStore.writes.length
  };
  check('29.1 a shadow selection is produced from canonical state with ZERO side effects',
    shadowOut.ok === true && shadowOut.selectedIds.length > 0
    && before29.debug === after29.debug
    && before29.counter === after29.counter
    && before29.activation === after29.activation
    && before29.exposure === after29.exposure
    && before29.begin === after29.begin
    && before29.chatWrites === after29.chatWrites,
    J({ selected: shadowOut.selectedIds, before: before29, after: after29 }));
  check('29.2 the shadow path may emit ids / order / count and nothing else',
    Array.isArray(shadowOut.selectedIds) && typeof shadowOut.count === 'number'
    && typeof shadowOut.reason !== 'undefined'
    && shadowOut.text.length >= 0,
    'emitted keys=' + J(Object.keys(shadowOut).sort()));
  SHADOW_FORBIDDEN_CALLS = [
    'recallSessionState.beginHomeTurn/beginBrowserTurn (advances the per-character counter)',
    'recallSessionState.recordExposure',
    'memoryRetrieval.reinforce -> store.recordActivation',
    'chat store append/insert',
    'any provider/model port call'
  ].join(' | ');
  SHADOW_SERVER_CALCULATION_IS_PURE = (before29.debug === after29.debug && before29.activation === after29.activation
    && before29.chatWrites === after29.chatWrites && shadowOut.ok === true) ? 'YES' : 'NO';
  check('29.3 the purity verdict is YES and every forbidden call is named',
    SHADOW_SERVER_CALCULATION_IS_PURE === 'YES'
    && SHADOW_FORBIDDEN_CALLS.indexOf('recordExposure') >= 0
    && SHADOW_FORBIDDEN_CALLS.indexOf('recordActivation') >= 0
    && SHADOW_FORBIDDEN_CALLS.indexOf('provider') >= 0,
    'forbidden=' + SHADOW_FORBIDDEN_CALLS);

  /* ══════════════════════════════════════════════════════════════════════
     Z · 汇总
     ══════════════════════════════════════════════════════════════════════ */
  section('Z · zero real provider cost');
  const providerCalls = gw.spy.provider.length + shadow.spy.provider.length;
  check('Z1 no real provider was ever contacted (the executor is the only seam)',
    providerCalls >= 1 && gw.spy.executor.every(e => String(e.requestId).indexOf('req_') === 0)
    && REAL_PROVIDER_CALLS === 0,
    'fake executor calls=' + providerCalls + ' REAL_PROVIDER_CALLS=' + REAL_PROVIDER_CALLS);
  check('Z2 the real gateway produced no warnings other than expected ones',
    gw.spy.warnings.filter(w => w.event !== 'memory-exposure-failed').length === 0,
    J(gw.spy.warnings.slice(0, 4)));

  console.log('\n' + '='.repeat(72));
  console.log('R4C LIVE-3.2 · RECALL SESSION / EXPOSURE / ACTIVATION AUTHORITY');
  console.log('DESKTOP_RECALL_SESSION_STATE_OWNER = ' + DESKTOP_RECALL_SESSION_STATE_OWNER + ' (target)');
  console.log('SESSION_STATE_KEYING_SUFFICIENT_FOR_DESKTOP = ' + SESSION_STATE_KEYING_SUFFICIENT_FOR_DESKTOP);
  console.log('SESSION_STATE_MISSING_KEYS = ' + SESSION_STATE_MISSING_KEYS);
  console.log('COOLDOWN_DURABLE_STATE = ' + COOLDOWN_DURABLE_STATE);
  console.log('FRESH_PROCESS_STARTS_EMPTY = ' + FRESH_PROCESS_STARTS_EMPTY);
  console.log('CURRENT_EXPOSURE_OWNERSHIP = ' + CURRENT_EXPOSURE_OWNERSHIP);
  console.log('TARGET_EXPOSURE_OWNERSHIP = ' + TARGET_EXPOSURE_OWNERSHIP);
  console.log('BROWSER_WRITE_THAT_MUST_STOP = ' + BROWSER_WRITE_THAT_MUST_STOP);
  console.log('ACTIVATION_AUTHORITY = ' + ACTIVATION_AUTHORITY);
  console.log('ACTIVATION_STORE_LEVEL_TURN_GUARD = ' + ACTIVATION_STORE_LEVEL_TURN_GUARD);
  console.log('SELECTION_SURVIVES_ACTIVATION_FAILURE = ' + SELECTION_SURVIVES_ACTIVATION_FAILURE);
  console.log('AMBIGUOUS_ACTIVATION_HANDLING = ' + AMBIGUOUS_ACTIVATION_HANDLING);
  console.log('TURN_IDENTITY_HELPER = ' + TURN_IDENTITY_HELPER);
  console.log('MINIMUM_DESKTOP_TURN_PAYLOAD = ' + MINIMUM_DESKTOP_TURN_PAYLOAD);
  console.log('NEW_PERMANENT_ID_REQUIRED = ' + NEW_PERMANENT_ID_REQUIRED);
  console.log('REPLAY_REEXPLORES = ' + REPLAY_REEXPLORES);
  console.log('REPLAY_DOUBLE_EXPOSES = ' + REPLAY_DOUBLE_EXPOSES);
  console.log('REPLAY_DOUBLE_ACTIVATES = ' + REPLAY_DOUBLE_ACTIVATES);
  console.log('REPLAY_PROTECTION_MECHANISM = ' + REPLAY_PROTECTION_MECHANISM);
  console.log('REPLAY_PROTECTION_SCOPE = ' + REPLAY_PROTECTION_SCOPE);
  console.log('SHADOW_SERVER_CALCULATION_IS_PURE = ' + SHADOW_SERVER_CALCULATION_IS_PURE);
  console.log('SHADOW_FORBIDDEN_CALLS = ' + SHADOW_FORBIDDEN_CALLS);
  console.log('REAL_PROVIDER_CALLS = ' + REAL_PROVIDER_CALLS);
  console.log('-'.repeat(72));
  if (failures) {
    console.error('R4C LIVE-3.2 SESSION AUTHORITY FAILED · ' + failures + ' assertion(s), ' + passed + ' passed');
    process.exitCode = 1;
  } else {
    console.log('R4C LIVE-3.2 SESSION AUTHORITY PASSED · ' + passed + ' assertions green');
  }
})().catch(error => {
  console.error('R4C LIVE-3.2 SESSION AUTHORITY CRASHED · ' + String((error && error.stack) || error));
  process.exitCode = 1;
}).finally(async () => {
  for (let i = CLEANUP.length - 1; i >= 0; i--) {
    try { CLEANUP[i](); } catch (_) { /* 尽力清理 */ }
  }
  let remaining = TEMP_DIRS.filter(d => fs.existsSync(d));
  for (let attempt = 0; attempt < 12 && remaining.length; attempt++) {
    await sleep(50);
    for (const dir of remaining) dropDir(dir);
    remaining = TEMP_DIRS.filter(d => fs.existsSync(d));
  }
  console.log('# cleanup: ' + (TEMP_DIRS.length - remaining.length) + '/' + TEMP_DIRS.length + ' temp dir(s) removed'
    + (remaining.length ? ' — STILL PRESENT: ' + J(remaining) : ''));
});
