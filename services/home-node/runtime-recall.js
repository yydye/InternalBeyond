/* ====================================================================
   IB Home Node · Runtime Recall Boundary（P21-R4-LIVE-3.3）
   --------------------------------------------------------------------
   职责：把"这一轮该想起什么"的**选择**变成一条服务端可调用、可审计、
   可被未来解释边界消费的**窄边界**。

        POST /internal/runtime/memory-recall
              ↓  闭集请求（8 键；24+ 个权威字段逐名拒绝）
              ↓  registry.getCharacterSpec(characterId)   ← 唯一的角色目录查询
              ↓  memoryRetrieval.retrieve(...)            ← **既有**召回实现（唯一）
              ↓  非持久信封：ids + 有界计数 + fingerprint

   ── 为什么这里没有第二套召回 ────────────────────────────────────────────
   本模块**不**判断可见性、**不**打分、**不**排序、**不**做预算、**不**选席位、
   **不**读 sqlite。所有这些仍然只有一份实现：
     · services/home-node/memory-retrieval.js（Node 侧 wrapper：取候选集、
       注入 server 时钟与随机源、把预算交给共享核心）；
     · assets/js/memory-retrieval-core.js + memory-recall/*（可见性与选择的
       唯一实现，浏览器与 Node 共用同一份文件）。
   本模块只做四件事：校验闭集、解析角色、把 **server 自有的** 选项交给既有
   wrapper、把结果压成**有界**信封。它没有任何一行能重新计算 selection。

   ── 权威（authority）───────────────────────────────────────────────────
   CALLER_INTENT != RECALL_AUTHORITY。调用方提供的是**这一轮是什么**：
   characterId / requestId / conversationId / message / 两个 turn 信号；
   它**不**提供"想起谁"：selectedIds / candidateRecords / records / scores /
   rank / ordering / topK / budget / maxChars / contentLen / seatPlan / seats /
   exploration / cooldown / cooldownFactor / sessionState / turnIndex / random /
   rng / now / timestamp / activation / activationPolicy / settings /
   normalizedQuery / tokens / query / glossary* 一律**逐名拒绝**，而且用的是
   一个**专用**码（caller-attempted-to-supply-recall-authority）——
   不是笼统的 "bad request"：审计要能一眼看出"调用方试图自己决定召回"。
   闭集之外的其他未知键则是 request-field-forbidden（同样逐名，绝不静默忽略）。

   ── 纯影子（PURE SHADOW）───────────────────────────────────────────────
   这条边界**只读**。它**不**写 exposure、**不**推进生产会话状态、**不**激活记忆、
   **不**调用任何 provider。具体到本仓库的动词，下面这些在**任何路径上**都
   不会被调用（也正因如此它们没有出现在本文件的任何一行里）：
     · store.putRecord / putRecords / deleteRecord / recordActivation /
       setMemorySettings / setMigrationState / open / close；
     · sessionState.beginBrowserTurn / beginHomeTurn / endHomeTurn /
       recordExposure / clear；
     · memoryRetrieval.reinforce（它才是激活通道的入口）。
   召回内部对 sessionState 的唯一动作是 **读**（cooldown 的 exposure 查询），
   那发生在既有实现里，不在这里，而且是读。
   ★ 这条性质不是靠注释成立的：装配层用**真实** store / 真实 session state
     做测量（写动词全部包一层计数器），"零副作用"是一条可断言的事实。

   ── 失败语义 ────────────────────────────────────────────────────────────
   与解释边界同一条纪律：run() **永不抛出**，任何失败都回一个带 status 的
   信封（形状与成功一致，ids 为空、计数为 0）。码是闭集（见 REASON），
   状态码只有一个来源（STATUS_BY_REASON）。绝不在失败信封里回半份 selection。
   ==================================================================== */
'use strict';

const crypto = require('crypto');
/* 身份助手：`stableToken` 是仓库**既有**的确定性令牌实现
   （assets/js/chat-core.js:162，requestId → userMessageId 用的同一个）。
   本边界不铸造新 id、不生成永久 id、不落任何东西 —— 它只是把
   (conversationId, requestId, message) 这三个**已经存在**的事实压成一个
   稳定令牌，因此同一轮永远得到同一个 turn 身份（§5.4）。 */
const CHAT_CORE = require('../../assets/js/chat-core.js');

/* 路径与操作名是**契约**：装配层、http 层、测试与未来的消费者都从这里取，
   不各写一份字面量（与 runtime-interpretation.js 同一条纪律）。 */
const PATH = '/internal/runtime/memory-recall';
const OPERATION = 'memory-recall';

/* ── 闭集请求（8 键）────────────────────────────────────────────────────
   `operation` 也在闭集里：它让"这条请求自称是哪条边界"成为可校验的事实，
   而不是由路径决定（路径决定路由，operation 决定语义，两者不一致时拒绝）。 */
const REQUEST_FIELDS = Object.freeze([
  'operation',
  'characterId',
  'requestId',
  'conversationId',
  'message',
  'isFirstTurn',
  'conversationSignalAvailable',
  'timeoutMs'
]);

/* ── P21-R4-LIVE-3.4 · 唯一的**可选能力键**：`mode` ─────────────────────
   ★ 为什么它**不**被并进 REQUEST_FIELDS：
     LIVE-3.3 的 request-authority 套件（committed，必须逐字通过）把
     `REQUEST_FIELDS.length === 8` 钉成一条断言。把 `mode` 追加进去会让那条
     断言变成 9 而失败 —— 而本阶段不许改那条套件。因此闭集校验同时查**两张
     名单**（必需形状的 8 个词 + 这一个可选能力词），describe() 也分开报告。
   `mode` 是**能力请求**，不是数据权威：它只决定这条边界是否推进回合生命周期，
   永远不决定召回看到什么（选择/可见性/预算仍全部服务端所有）。 */
const OPTIONAL_REQUEST_FIELDS = Object.freeze(['mode', 'isGroup']);
const MODES = Object.freeze(['shadow', 'authoritative']);
const DEFAULT_MODE = 'shadow';

/* 权威模式写入的四个生命周期动词（**唯一**实现仍在既有 machinery 里：
   recall-session-state 的 beginHomeTurn/recordExposure/endHomeTurn，
   memory-retrieval 的 reinforce → store.recordActivation）。 */
const AUTHORITATIVE_WRITES = Object.freeze(['beginHomeTurn', 'reinforce', 'recordExposure', 'endHomeTurn']);

/* 已结算回合的**进程内**备忘（有界）：同一 (requestId, conversationId, message)
   的重放必须"不重新探索、不推进 session、不二次曝光、不二次激活"，同时还要
   能回一份可用的信封 —— 这正是 mobile gateway 的 turnByRequest/liveTurns
   重复分支在做的事（见 mobile-gateway.js:626-637），这里只是把同一个模式
   实例化到本路由上。**不落盘、无 schema、重启即空**。 */
const MAX_SETTLED_TURNS = 64;

/* ── 逐名拒绝的**权威字段** ─────────────────────────────────────────────
   这张名单不是"顺手多写的几个词"：每一个都曾经是（或将会是）调用方试图
   替服务端做决定的那条路。名单必须跟着能力长 —— 新能力若落在名单之外，
   在实践中与"被允许"很难区分（P22 系列的既有教训）。 */
const REJECTED_AUTHORITY_FIELDS = Object.freeze([
  'selectedIds', 'candidateRecords', 'records', 'candidates', 'scores', 'rank',
  'ordering', 'topK', 'budget', 'maxChars', 'contentLen', 'seatPlan', 'seats',
  'exploration', 'allowExploration', 'cooldown', 'cooldownFactor', 'sessionState',
  'turnIndex', 'random', 'rng', 'now', 'timestamp', 'activation', 'activationPolicy',
  'settings', 'normalizedQuery', 'tokens', 'query', 'glossaryEntries',
  'glossaryProvider', 'getGlossaryEntries',
  /* ── P21-R4-LIVE-4.1B · §5 标签修正：同一个**类**必须给同一个码 ─────────
     这一组的共同点是"调用方试图提供权威"，只是作者用了另一条路径的名字：
       · `selectedMemoryIds` —— 解释边界的选词名，语义上就是上面那个
         `selectedIds`（同一条选择权威的别名）；
       · `credentialRef / provider / model / endpoint / systemPrompt / messages`
         —— 执行权威字段（与 runtime-interpretation.js#AUTHORITY_BEARING_FIELDS
         同一个类）：它们在这条边界上不存在，但一个把它们发过来的调用方
         仍然是在"替服务端决定"。
     为什么不是 request-field-forbidden：那个码的含义是"你写错了一个键名"
     （闭集之外的无害未知键），而这一组的含义是"你想自己掌权"。把两者混成
     一个码，审计者就无法从码本身区分攻击与笔误 —— 这正是 §5 要修的东西。
     ★ 同一个 400、同样带 `field`、零次 retrieve、零 provider 调用。
     ★ `ownerId` **刻意不在这里**：LIVE-3.3 的 request-authority 套件把
       "跨角色 payload"钉成 request-field-forbidden（§25.3），那是它的语义。 */
  'selectedMemoryIds', 'credentialRef', 'provider', 'model', 'endpoint',
  'systemPrompt', 'messages'
]);

const REASON = Object.freeze({
  requestShapeInvalid: 'request-shape-invalid',
  requestFieldForbidden: 'request-field-forbidden',
  callerSuppliedRecallAuthority: 'caller-attempted-to-supply-recall-authority',
  operationForbidden: 'operation-forbidden',
  runtimeSpecUnavailable: 'runtime-spec-unavailable',
  recallUnavailable: 'recall-unavailable',
  recallTimeout: 'recall-timeout'
});

/* HTTP 状态：唯一来源。http 层直接用信封里的 status，**不**重推。 */
const STATUS_BY_REASON = Object.freeze({
  'request-shape-invalid': 400,
  'request-field-forbidden': 400,
  'caller-attempted-to-supply-recall-authority': 400,
  'operation-forbidden': 403,
  'runtime-spec-unavailable': 404,
  'recall-unavailable': 503,
  'recall-timeout': 504
});

/* 超时：调用方的显式权威，可缺省（服务端默认），并且**一定**被上限夹住。
   召回到目前为止是"本地读 + 纯计算"，因此 2s 已经非常宽；上限 10s 存在
   只是为了让"调用方说 1 小时"不会变成一个没有意义的数字。 */
const DEFAULT_TIMEOUT_MS = 2000;
const MAX_TIMEOUT_MS = 10000;

const MAX_CHARACTER_ID_CHARS = 128;
const MAX_TURN_ID_CHARS = 200;
const MAX_MESSAGE_CHARS = 16000;
const MAX_OPERATION_ECHO_CHARS = 64;
const MAX_DETAIL_CHARS = 200;

/* fingerprint 的版本前缀：哈希一旦被未来消费者引用，就不能悄悄改输入元组。
   改元组 = 换版本号（换一个前缀），而不是让同一串 hex 有两种含义。 */
const FINGERPRINT_VERSION = 'sha256-v1';

/* 传输真值：本阶段**只有桌面**（与解释边界逐字一致）。 */
const TRANSPORT_SCOPE = 'DESKTOP_ONLY';

function isPlainObject(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
/* 一律**只读自有属性**：原型上的东西（含被污染的 __proto__）永远不参与校验。 */
function own(obj, key) {
  return obj && Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : undefined;
}
function text(v) { return v == null ? '' : String(v); }
function bounded(v, limit) { return text(v).slice(0, limit || MAX_DETAIL_CHARS); }
function statusFor(code) {
  return Object.prototype.hasOwnProperty.call(STATUS_BY_REASON, code) ? STATUS_BY_REASON[code] : 503;
}

function sha256Hex(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

/* ── turn 身份：**复用** mobile gateway 的同一个公式 ─────────────────────
   services/home-node/mobile-gateway.js:242-245 的 deriveStableTurnId 是仓库里
   canonical turn identity 的**唯一**权威（content-addressed：同一
   (requestId, conversationId) 恒等同一 logical turn）。本文件**不**发明第二份
   公式 —— 两份"看起来一样"的推导只会让同一轮在某条路径上拿到两个身份。 */
function deriveStableTurnId(requestId, conversationId) {
  return 'turn_' + CHAT_CORE.stableToken(String(requestId == null ? '' : requestId)
    + ':' + String(conversationId == null ? '' : conversationId));
}

function createRuntimeRecall(deps) {
  deps = deps || {};
  /* 依赖就是整条权威链：既有召回实现 → 角色目录。provider / Vault **不在**
     这条链上 —— 召回不花钱、不出网，因此本文件没有、也不该有 modelPort。 */
  const memoryRetrieval = deps.memoryRetrieval || null;
  const memoryStore = deps.memoryStore || null;
  const registry = deps.registry || null;
  /* sessionState 被接受，但**只**用于两件事：describe() 如实说
     `sessionStateOwned: false`，以及让装配层能把**同一个**实例同时交给
     wrapper 与本边界（identity 可核对）。本文件没有它的任何写动词。 */
  const sessionState = deps.sessionState || null;
  const clock = typeof deps.clock === 'function' ? deps.clock : Date.now;
  /* random 同样被接受，但**生效的**随机源是 createMemoryRetrieval 的构造依赖
     —— 那是探索窗口抽样的唯一权威。这里再抽一次会造出第二个随机权威，
     因此本层只如实报告 `randomInjected`，绝不把它转发出去。 */
  const random = typeof deps.random === 'function' ? deps.random : null;
  const logger = typeof deps.logger === 'function' ? deps.logger : function () {};
  /* 词汇表（glossary）通道的条目来源：**只**能由装配层注入。
     请求 schema 把 glossaryEntries / glossaryProvider / getGlossaryEntries
     三个键逐名拒绝，因此"浏览器提交 glossary 结果"这条路不存在；
     这里转发的两个依赖就是 wrapper 新增的那两个 seam（同一份 orchestrator
     工厂，绝不复制 glossary 算法）。 */
  const glossaryProvider = deps.glossaryProvider === undefined ? undefined : deps.glossaryProvider;
  const getGlossaryEntries = deps.getGlossaryEntries === undefined ? undefined : deps.getGlossaryEntries;
  /* ── P21-R4-LIVE-4 · post-recall hook 的解释服务（**可选**）───────────
     缺席 ⇒ 自动路径整体不存在（与今天逐字节相同）。在场时它只被这一个
     hook 使用：召回选择 + 会话/曝光/激活生命周期完成**之后**调度，
     fire-and-forget，绝不在召回响应路径上 await。 */
  const interpretation = deps.interpretation || null;
  /* P21-R4-LIVE-5 · L5 期望运行时（**兄弟**依赖：与 interpretation 各自独立，
     各自的权威、各自的持有者、各自的计数）。缺席 ⇒ 期望这条路径根本不存在。 */
  const expectation = deps.expectation || null;

  /* turn-local 结果持有者：**非持久**、有界（条数 + TTL）、按
     character+turn 作用域。绝不进 SQLite / memory_records / Understanding /
     chat DB / IndexedDB / localStorage / 文件。 */
  const MAX_TURN_INTERPRETATIONS = 64;
  const TURN_INTERPRETATION_TTL_MS = 10 * 60 * 1000;
  const turnInterpretations = new Map();   /* turnId → record（含正文，仅内部） */
  /* 自动路径的观测计数（**只**计数，没有正文）。enabled 由解释服务的
     autoPolicy 单独裁决（见 autoEnabled()）；这里不缓存它的值。 */
  const autoCounters = { started: 0, succeeded: 0, failed: 0, timedOut: 0, notNeeded: 0, notEnabled: 0, inFlight: 0 };
  let autoScheduled = 0;   /* 已调度、尚未结束的任务数（含尚未开跑的） */
  const autoWaiters = new Set();

  /* 装配事实核对：召回器必须绑在**同一个** store 上。
     绑到另一个能开、能查、永远返回空的实例上不会抛任何错，只会表现为
     "她突然什么都不记得" —— 那种 bug 无法从行为反推，必须在这里 fail closed
     （与 memory-retrieval.js 导出 store 的理由逐字相同）。 */
  const storeIdentity = (!memoryStore || !memoryRetrieval)
    ? 'UNVERIFIABLE'
    : (memoryRetrieval.store === memoryStore ? 'SAME' : 'MISMATCH');

  const counters = { calls: 0, ok: 0, refused: 0, timeouts: 0, unavailable: 0 };
  /* 权威模式的可观测计数（影子模式恒为 0 —— 这些数字会进 boundary 块，
     因此"审计面自述"与"实际行为"必须是同一个来源）。 */
  const authoritativeCounters = { exposureWrites: 0, activationWrites: 0, turnsBegun: 0, turnsEnded: 0, replaysServed: 0 };
  /* turnId → { messageHash, selectedIds, context, counts, channel, reason, chars,
     activationPolicy, fingerprint, activationIds }（有界，插入序淘汰最旧）。 */
  const settledTurns = new Map();

  function note(event, fields) {
    try { logger(event, fields || {}); } catch (_) { /* 观测失败不影响执行 */ }
  }

  /* 权威模式的空 context / 零 effects。失败与重放都用它们，形状与成功一致 ——
     调用方不需要按路径猜键。 */
  function emptyContext() { return { text: '', count: 0, chars: 0, includeHeader: true }; }
  function zeroEffects(over) {
    return Object.assign({
      turnBegun: false,
      activation: { updated: 0, duplicated: [], reason: null },
      exposure: { written: 0 },
      turnEnded: false
    }, over || {});
  }

  /* ── 信封：成功与失败**同一套顶层键** ──────────────────────────────────
     调用方不需要猜"失败时少了哪个键"。失败时 ids 为空、fingerprint 为 null、
     计数为 0 —— 半份 selection 在任何路径上都不会被回出去。

     P21-R4-LIVE-3.4：影子模式的 boundary 块**逐字节不变**（committed 套件
     钉住 pureShadow:true 且没有 `mode` 键）。权威模式多一个 `mode` 键、
     pureShadow 翻成 false，并且两个写计数取自本次请求的**实测值**。 */
  function boundaryBlock(attempts, authoritativeState) {
    if (authoritativeState) {
      return {
        mode: MODES[1],
        pureShadow: false,
        exposureWrites: Number(authoritativeState.exposureWrites) || 0,
        activationWrites: Number(authoritativeState.activationWrites) || 0,
        providerCalls: 0,
        sessionMutation: 'TURN_LIFECYCLE',
        transportScope: TRANSPORT_SCOPE,
        recallSelectionAuthority: 'CALLER_PROPOSED',
        attempts: attempts
      };
    }
    return {
      pureShadow: true,
      exposureWrites: 0,
      activationWrites: 0,
      providerCalls: 0,
      sessionMutation: 'NONE',
      transportScope: TRANSPORT_SCOPE,
      /* 这条边界**提议**选择（由既有召回实现算出），它不因此成为权威：
         真正的权威仍然是 canonical store + 共享可见性核。 */
      recallSelectionAuthority: 'CALLER_PROPOSED',
      attempts: attempts
    };
  }

  function failure(code, ctx) {
    const c = ctx || {};
    const attempts = Number(c.attempts) || 0;
    if (code === REASON.recallTimeout) counters.timeouts += 1;
    else if (code === REASON.recallUnavailable) counters.unavailable += 1;
    else counters.refused += 1;
    /* 权威模式：失败也回**同一套** 16 键（14 + context + effects），因此
       `mode:'authoritative'` 的信封形状不随成功/失败分叉。校验期失败没有
       可信的 mode（请求还没通过校验），因此仍是冻结的 14 键失败信封。 */
    const authoritative = c.mode === MODES[1];
    const out = {
      ok: false,
      durable: false,
      operation: OPERATION,
      characterId: c.characterId === undefined ? null : c.characterId,
      error: code,
      reasonCode: code,
      turnIdentity: null,
      selectedIds: [],
      activationPolicy: null,
      channel: null,
      reason: null,
      fingerprint: null,
      counts: { candidates: 0, eligible: 0, selected: 0 },
      chars: 0,
      boundary: boundaryBlock(attempts, authoritative ? (c.authoritativeState || {}) : null),
      status: statusFor(code)
    };
    if (c.detail !== undefined) out.detail = bounded(c.detail);
    if (c.field !== undefined) out.field = bounded(c.field, 80);
    if (c.requestedOperation !== undefined) out.requestedOperation = c.requestedOperation;
    if (authoritative) {
      out.context = isPlainObject(c.context) ? c.context : emptyContext();
      out.effects = isPlainObject(c.effects) ? c.effects : zeroEffects();
    }
    return out;
  }

  /* ── 请求闭集校验。返回 { ok:true, ... } 或 { ok:false, result } ─────── */
  function validateRequest(body) {
    if (!isPlainObject(body)) {
      return { ok: false, result: failure(REASON.requestShapeInvalid, { detail: 'body-not-an-object' }) };
    }
    /* ① 闭集：白名单之外的**自有**键一律拒绝（绝不 ignore）。
          JSON.parse('{"__proto__":{...}}') 会产生一个**自有**的 `__proto__`
          键，因此原型污染尝试也在这里被当成未知字段抓住。
          顺序：先认"权威字段"（专用码 + field），再认其他未知键 —— 两者都不
          静默，但审计要能区分"你想自己决定召回"与"你写错了一个键名"。 */
    for (const key of Object.keys(body)) {
      if (REQUEST_FIELDS.indexOf(key) >= 0) continue;
      /* P21-R4-LIVE-3.4：`mode` 是唯一的可选能力键。 */
      if (OPTIONAL_REQUEST_FIELDS.indexOf(key) >= 0) continue;
      if (REJECTED_AUTHORITY_FIELDS.indexOf(key) >= 0) {
        return {
          ok: false,
          result: failure(REASON.callerSuppliedRecallAuthority, {
            field: key,
            detail: 'recall authority is server-owned; the caller supplies the turn, not the selection'
          })
        };
      }
      return {
        ok: false,
        result: failure(REASON.requestFieldForbidden, {
          field: key,
          detail: 'request-is-a-closed-schema'
        })
      };
    }
    /* ② operation：必须是本边界那一个词。缺省/写错/非字符串都走同一个码 ——
          "这条请求自称不是 memory-recall"与"它自称的是一个不存在的操作"
          对调用方是同一件事：走错门了。 */
    const operationRaw = own(body, 'operation');
    if (typeof operationRaw !== 'string' || operationRaw.trim() !== OPERATION) {
      return {
        ok: false,
        result: failure(REASON.operationForbidden, {
          requestedOperation: typeof operationRaw === 'string'
            ? bounded(operationRaw, MAX_OPERATION_ECHO_CHARS) : null,
          detail: 'allowlist=' + OPERATION
        })
      };
    }
    /* ③ characterId：非空字符串、有界。 */
    const characterIdRaw = own(body, 'characterId');
    const characterId = typeof characterIdRaw === 'string' ? characterIdRaw.trim() : '';
    if (!characterId || characterId.length > MAX_CHARACTER_ID_CHARS) {
      return {
        ok: false,
        result: failure(REASON.requestShapeInvalid, {
          operation: OPERATION, detail: 'characterId-must-be-a-bounded-non-empty-string'
        })
      };
    }
    /* ④ requestId / conversationId：**turn 身份的两个来源**，两个都必填。
         它们不是"日志用的备注"：fingerprint 的一部分与 turnIdentity 的全部
         都由它们构成，缺一个就无法把一次召回绑定到具体的一轮对话上。 */
    const requestIdRaw = own(body, 'requestId');
    const requestId = typeof requestIdRaw === 'string' ? requestIdRaw.trim() : '';
    if (!requestId || requestId.length > MAX_TURN_ID_CHARS) {
      return {
        ok: false,
        result: failure(REASON.requestShapeInvalid, {
          operation: OPERATION, characterId: characterId,
          detail: 'requestId-must-be-a-bounded-non-empty-string'
        })
      };
    }
    const conversationIdRaw = own(body, 'conversationId');
    const conversationId = typeof conversationIdRaw === 'string' ? conversationIdRaw.trim() : '';
    if (!conversationId || conversationId.length > MAX_TURN_ID_CHARS) {
      return {
        ok: false,
        result: failure(REASON.requestShapeInvalid, {
          operation: OPERATION, characterId: characterId,
          detail: 'conversationId-must-be-a-bounded-non-empty-string'
        })
      };
    }
    /* ⑤ message：**本轮用户原文**。它只作为召回的查询信号被消费，
         绝不被回显（信封里只有长度与摘要），也绝不进日志。
         空串是允许的：那是"这一轮没有可用的查询信号"，由既有实现如实
         早退（返回空选择），而不是由这里编一个形状错误。 */
    const messageRaw = own(body, 'message');
    if (typeof messageRaw !== 'string') {
      return {
        ok: false,
        result: failure(REASON.requestShapeInvalid, {
          operation: OPERATION, characterId: characterId,
          detail: 'message-must-be-a-string'
        })
      };
    }
    if (messageRaw.length > MAX_MESSAGE_CHARS) {
      return {
        ok: false,
        result: failure(REASON.requestShapeInvalid, {
          operation: OPERATION, characterId: characterId,
          detail: 'message exceeds ' + MAX_MESSAGE_CHARS + ' characters'
        })
      };
    }
    /* ⑥ 两个 turn 信号：可选，但**出现就必须是布尔**。
         它们是调用方对"这一轮是什么"的如实陈述（首轮？会话信号可用？），
         不是召回策略：通道由既有 channel-policy 根据它们决定。 */
    const isFirstTurnRaw = own(body, 'isFirstTurn');
    if (isFirstTurnRaw !== undefined && typeof isFirstTurnRaw !== 'boolean') {
      return {
        ok: false,
        result: failure(REASON.requestShapeInvalid, {
          operation: OPERATION, characterId: characterId, detail: 'isFirstTurn-must-be-a-boolean'
        })
      };
    }
    const signalRaw = own(body, 'conversationSignalAvailable');
    if (signalRaw !== undefined && typeof signalRaw !== 'boolean') {
      return {
        ok: false,
        result: failure(REASON.requestShapeInvalid, {
          operation: OPERATION, characterId: characterId,
          detail: 'conversationSignalAvailable-must-be-a-boolean'
        })
      };
    }
    /* ⑦ timeoutMs：可选；出现就必须是**真正的** number（数字字符串不是权威，
         0/负数/NaN/Infinity 也不是）。缺省用服务端默认值，超过上限被夹住 ——
         夹住这件事会如实出现在 describe() 的 maxTimeoutMs 里。 */
    const timeoutRaw = own(body, 'timeoutMs');
    let effectiveTimeoutMs = DEFAULT_TIMEOUT_MS;
    if (timeoutRaw !== undefined) {
      if (typeof timeoutRaw !== 'number' || !isFinite(timeoutRaw) || !(timeoutRaw > 0)) {
        return {
          ok: false,
          result: failure(REASON.requestShapeInvalid, {
            operation: OPERATION, characterId: characterId,
            detail: 'timeoutMs-must-be-a-finite-number-greater-than-zero'
          })
        };
      }
      effectiveTimeoutMs = Math.min(timeoutRaw, MAX_TIMEOUT_MS);
    }
    /* ⑦ mode：**唯一**的可选能力键。缺省 / 'shadow' ⇒ 与今天逐字节相同；
          'authoritative' ⇒ 本边界接管这一轮的 Home turn 生命周期；
          其它任何值（含非字符串、大小写变体）⇒ request-shape-invalid。
          ★ mode 不是数据权威：它不改变召回看到什么，只改变谁推进回合。 */
    const modeRaw = own(body, 'mode');
    let mode = DEFAULT_MODE;
    if (modeRaw !== undefined) {
      if (typeof modeRaw !== 'string' || MODES.indexOf(modeRaw.trim()) < 0) {
        return {
          ok: false,
          result: failure(REASON.requestShapeInvalid, {
            operation: OPERATION, characterId: characterId, field: 'mode',
            detail: 'mode-must-be-one-of-' + MODES.join('|')
          })
        };
      }
      mode = modeRaw.trim();
    }
    /* ⑦b isGroup：**唯一**的群聊键（可选）。它是"这一轮是什么"的一部分，
          不是召回策略：它只切可见性分支（group ⇒ public-only），通道/排名/
          预算/选择仍全部由既有引擎决定。
          ★ 刻意**不**接受 groupMemEnabled 作为第二个 wire 键：一个键就是契约，
            服务端按 `isGroup === true` 同时驱动两者（见下面的 retrieve 调用），
            因此调用方不可能把两个语义拆开、让它们互相矛盾。
          ★ 缺席 ⇒ 与今天逐字节相同（false/false）。 */
    const isGroupRaw = own(body, 'isGroup');
    if (isGroupRaw !== undefined && typeof isGroupRaw !== 'boolean') {
      return {
        ok: false,
        result: failure(REASON.requestShapeInvalid, {
          operation: OPERATION, characterId: characterId, field: 'isGroup',
          detail: 'isGroup-must-be-a-boolean'
        })
      };
    }
    return {
      ok: true,
      mode: mode,
      isGroup: isGroupRaw === true,
      characterId: characterId,
      requestId: requestId,
      conversationId: conversationId,
      message: messageRaw,
      isFirstTurn: isFirstTurnRaw === true,
      conversationSignalAvailable: signalRaw === true,
      effectiveTimeoutMs: effectiveTimeoutMs
    };
  }

  /* ── 角色运行时 spec（**唯一**查询点）────────────────────────────────
     与解释边界**同一个** accessor：registry.getCharacterSpec(characterId)。
     本文件不发明第二套 character config lookup，也不读 sqlite。
     ★ 与解释边界的差别只有一处，而且是刻意的：这里**不**要求
       provider / model / endpoint / credentialRef 齐全 —— 召回既不调用
       provider 也不读 Vault，拿"缺少 provider 配置"去拒绝一次本地读，
       等于凭空造出一条依赖。这里只回答"这台节点上有没有这个运行时角色"。 */
  function resolveCharacterSpec(characterId) {
    if (!registry || typeof registry.getCharacterSpec !== 'function') {
      return { ok: false, reason: 'registry-unavailable' };
    }
    let spec = null;
    try { spec = registry.getCharacterSpec(characterId) || null; }
    catch (_) { spec = null; }
    if (!isPlainObject(spec)) return { ok: false, reason: 'spec-missing' };
    return { ok: true };
  }

  /* ── 有界诊断（**唯一**来源）─────────────────────────────────────────
     `channel` 与 counts（input/visible/gated/selected）**只**存在于既有
     orchestrator 的 trace 里（assets/js/memory-recall/recall-trace.js），
     而 wrapper 通过 `options.withTrace === true` 那个**显式 opt-in** 把它们
     有界地透传出来（diagnostics 键；默认关闭时返回对象逐字节不变）。
     本层**绝不**自己重算可见性、门或通道 —— 重算就是第二套召回引擎。
     读不到 `diagnostics` 时返回 null，而不是编一个看起来合理的数字。 */
  function boundedDiagnosticsOf(picked) {
    const t = picked && (picked.diagnostics || picked.trace);
    if (!isPlainObject(t)) return null;
    const counts = isPlainObject(t.counts) ? t.counts : null;
    return { channel: t.channel == null ? null : String(t.channel), counts: counts };
  }
  function metricOrNull(value) {
    if (value == null) return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  /* ── P21-R4-LIVE-4 · post-recall auto-interpretation hook ──────────────
     位置：authoritative 模式的**生命周期完成之后**（selection → exposure →
     activation → end 全部结束）。fire-and-forget：本文件从不 await 它，
     因此召回 HTTP 响应时间**不随**解释的模型延迟增长。
     三层"每回合一次"：
       ① 重放在 settledTurns 备忘录处就 return（根本走不到这里）；
       ② 这里按 turnId 只调度一次（`interpretation` 侧还有一层
          (characterId, turnIdentity) guard）。
     全部有界：结果持有者 64 条 + 10 分钟 TTL；任务数用 autoScheduled/inFlight
     计数，`awaitAutoIdle()` 是唯一的等待缝（测试用，不在生产路径上）。 */
  function autoEnabled() {
    if (!interpretation || typeof interpretation.describe !== 'function') return false;
    try {
      const d = interpretation.describe();
      return !!(d && d.autoPolicy && d.autoPolicy.autoInterpretationEnabled === true);
    } catch (_) { return false; }
  }
  /* 权威来源的只读透传（'FILE_POLICY' | 'TEST_INJECTION' | 'NONE_FAIL_CLOSED'）。 */
  function autoAuthoritySource() {
    if (!interpretation || typeof interpretation.describe !== 'function') return 'NONE_FAIL_CLOSED';
    try {
      const d = interpretation.describe();
      return (d && d.autoPolicy && d.autoPolicy.authoritySource) ? String(d.autoPolicy.authoritySource) : 'NONE_FAIL_CLOSED';
    } catch (_) { return 'NONE_FAIL_CLOSED'; }
  }
  function sweepTurnInterpretations() {
    const now = Number(clock());
    for (const [key, rec] of turnInterpretations) {
      const stamp = rec && (rec.completedAt || rec.startedAt);
      if (Number.isFinite(Number(stamp)) && (now - Number(stamp)) > TURN_INTERPRETATION_TTL_MS) {
        turnInterpretations.delete(key);
      }
    }
  }
  function settleAutoWaiters() {
    if (autoScheduled !== 0 || autoCounters.inFlight !== 0) return;
    for (const w of Array.from(autoWaiters)) { try { w.finish(); } catch (_) { /* 已结算 */ } }
    autoWaiters.clear();
  }
  function recordTurnInterpretation(rec) {
    if (!rec || !rec.turnId) return;
    sweepTurnInterpretations();
    turnInterpretations.set(String(rec.turnId), rec);
    while (turnInterpretations.size > MAX_TURN_INTERPRETATIONS) {
      const oldest = turnInterpretations.keys().next();
      if (oldest.done) break;
      turnInterpretations.delete(oldest.value);
    }
  }
  function scheduleAutoInterpretation(ctx) {
    if (!interpretation || typeof interpretation.runFromAuthoritativeRecall !== 'function') return;
    const characterId = String(ctx.characterId == null ? '' : ctx.characterId);
    const turnId = String(ctx.turnId == null ? '' : ctx.turnId);
    if (!turnId) return;
    const selectedIds = Array.isArray(ctx.selectedIds) ? ctx.selectedIds.slice() : [];
    const turnIdentity = ctx.turnIdentity || { turnId: turnId };
    const startedAt = Number(clock());
    /* 零选择 ⇒ **不调度 provider**，如实记 not-needed / no-memory（两个装配都如此）。 */
    if (!selectedIds.length) {
      autoCounters.notNeeded += 1;
      recordTurnInterpretation({ turnId, characterId, turnIdentity, status: 'not-needed', reason: 'no-memory', errorClass: null, startedAt, completedAt: startedAt, providerCalls: 0, interpretation: null });
      return;
    }
    /* 通道矩阵：只有 surface / recall 允许自动解释（见解释侧的矩阵常量）。 */
    const channel = ctx.channel == null ? null : String(ctx.channel);
    if (!interpretation.AUTO_INTERPRETATION_CHANNELS || interpretation.AUTO_INTERPRETATION_CHANNELS.indexOf(channel) < 0) {
      autoCounters.notNeeded += 1;
      recordTurnInterpretation({ turnId, characterId, turnIdentity, status: 'not-needed', reason: 'channel-not-eligible', errorClass: null, startedAt, completedAt: startedAt, providerCalls: 0, interpretation: null });
      return;
    }
    const binding = {
      characterId: characterId,
      turnId: turnId,
      turnIdentity: turnIdentity,
      selectedIds: selectedIds,
      /* 召回结果**已经持有**的 canonical 行（今天 wrapper 不返回它们 ⇒ 省略，
         解释侧因此走 SERVER_CANONICAL_REBIND；将来 wrapper 若暴露，就变成
         SERVER_CANONICAL_RECALL_RESULT —— 两条路都只接受服务端对象）。 */
      records: Array.isArray(ctx.records) ? ctx.records : undefined,
      currentState: isPlainObject(ctx.currentState) ? ctx.currentState : {},
      roleName: ctx.roleName == null ? '' : String(ctx.roleName),
      channel: channel,
      fingerprint: ctx.fingerprint == null ? null : String(ctx.fingerprint),
      canonicalRevision: ctx.canonicalRevision == null ? null : ctx.canonicalRevision
    };
    const runTask = async () => {
      autoCounters.inFlight += 1;
      /* `started` = 真的走到了解释入口的任务数（含 disabled / not-needed：
         它们确实到达了入口，只是没有花钱）。它**不是**失败数 ——
         P21-R4-LIVE-4.1B §7：disabled 曾经被记进 failed，那是标签撒谎。 */
      autoCounters.started += 1;
      let res = null;
      try {
        try { res = await interpretation.runFromAuthoritativeRecall(binding, {}); }
        catch (error) {
          res = { ok: false, status: 'failed', errorClass: 'auto-hook-threw', reason: bounded((error && error.message) || error), providerCalls: 0 };
        }
        const status = res && res.status ? String(res.status) : 'failed';
        /* ── P21-R4-LIVE-4.1B · §6/§7 状态分类（**只**改标签）────────────
           状态模型：succeeded · timed-out · disabled · not-needed ·
                     duplicate-turn · failed（execution failure only）
           · §7 —— `disabled`（auto policy OFF，`reason:'auto-policy-off'`）与
             `not-scheduled`/`not-enabled` 一律进 `notEnabled`：**关闭不是失败**。
             它与 `not-needed`（零记忆 / 通道不eligible / 重放）合起来构成
             "到达入口但没有执行"的那一类，两者都不含 provider 调用。
           · §6 —— `timed-out` 严格来自解释边界对"服务端自有超时"的分类
             （见 runtime-interpretation.js 的 serverOwnedTimeout）：
             自动路径没有调用方 signal，因此端口侧的 abort 也只可能是超时。
             它绝不与普通 provider 失败 (`failed`) 混计。 */
        if (status === 'succeeded') autoCounters.succeeded += 1;
        else if (status === 'timed-out') autoCounters.timedOut += 1;
        else if (status === 'disabled' || status === 'not-enabled' || status === 'not-scheduled') autoCounters.notEnabled += 1;
        else if (status === 'not-needed' || status === 'duplicate-turn') autoCounters.notNeeded += 1;
        else autoCounters.failed += 1;
        try {
          recordTurnInterpretation({
            turnId, characterId, turnIdentity,
            status: status,
            reason: res && (res.reason || res.reasonCode) ? String(res.reason || res.reasonCode) : null,
            errorClass: (res && res.ok !== true) ? String(res.errorClass || res.reasonCode || 'failed') : null,
            startedAt: startedAt, completedAt: Number(clock()),
            recordSource: res && res.recordSource ? String(res.recordSource) : null,
            providerCalls: Number(res && res.providerCalls) || 0,
            interpretation: (res && res.ok === true && res.interpretation) ? res.interpretation : null
          });
        } catch (_) { /* 结果持有者失败绝不影响任何东西 */ }
        /* ── P21-R4-LIVE-5 · 期望的兄弟调度（POST_INTERPRETATION_NONBLOCKING）──
           只在**已验证的 L3 成功**之后才调度；同样 fire-and-forget，绝不 await，
           因此召回响应与主聊天都不随期望的模型延迟增长。 */
        try { scheduleExpectationFromInterpretation(ctx, binding, res); }
        catch (_) { /* 调度失败绝不影响解释或召回 */ }
        note('runtime-recall-auto-interpretation', {
          characterId: characterId, turnId: turnId, status: status,
          providerCalls: Number(res && res.providerCalls) || 0,
          recordSource: res && res.recordSource ? String(res.recordSource) : null
        });
      } finally {
        autoCounters.inFlight -= 1;
        settleAutoWaiters();
      }
    };
    recordTurnInterpretation({ turnId, characterId, turnIdentity, status: 'pending', reason: null, errorClass: null, startedAt, completedAt: null, providerCalls: 0, interpretation: null });
    autoScheduled += 1;
    /* 下一 tick 才启动（明确的"不在响应路径上"）；unref 让定时器不吊住进程。 */
    if (typeof setTimeout === 'function') {
      const t = setTimeout(() => { autoScheduled -= 1; runTask(); }, 0);
      if (t && typeof t.unref === 'function') t.unref();
    } else {
      Promise.resolve().then(() => { autoScheduled -= 1; runTask(); });
    }
  }
  /* ══ P21-R4-LIVE-5 · L5 期望的兄弟调度（POST_INTERPRETATION_NONBLOCKING）══
     与 `scheduleAutoInterpretation` 同形，但**只在一次已验证的 L3 成功之后**才
     存在（OWNER RULING 1 的运行时纪律；协议层并不要求 L3 —— 两条声明分开报告）。
     非阻塞：召回响应与主聊天**都不等**它；失败绝不影响它们。
     有界：结果持有者在 runtime-expectation.js 里（64 条 / 10 分钟 TTL /
     characterId+conversationId+turnId），这里只有调度计数与等待缝。 */
  const expectationCounters = { scheduled: 0, started: 0, created: 0, notCreated: 0, failed: 0, skippedNoL3: 0 };
  let expectationScheduled = 0;
  const expectationWaiters = new Set();
  const expectationTurns = new Map();
  function settleExpectationWaiters() {
    if (expectationScheduled !== 0) return;
    for (const w of Array.from(expectationWaiters)) { try { w(); } catch (_) { /* 已结算 */ } }
    expectationWaiters.clear();
  }
  function recordExpectationTurn(rec) {
    if (!rec || !rec.turnId) return;
    expectationTurns.set(String(rec.turnId), rec);
    while (expectationTurns.size > 64) {
      const oldest = expectationTurns.keys().next();
      if (oldest.done) break;
      expectationTurns.delete(oldest.value);
    }
  }
  function expectationEnabled() {
    if (!expectation || typeof expectation.describe !== 'function') return false;
    try {
      const p = expectation.describe().policy;
      return !!(p && p.enabledCharacterCount > 0);
    } catch (_) { return false; }
  }
  function scheduleExpectationFromInterpretation(ctx, binding, interpretationRes) {
    if (!expectation || typeof expectation.runFromValidatedInterpretation !== 'function') return;
    const characterId = String(ctx.characterId == null ? '' : ctx.characterId);
    const turnId = String(binding && binding.turnId ? binding.turnId : '');
    if (!turnId) return;
    const completedAt = Number(clock());
    /* §调度纪律：没有"已验证的 L3 成功"就**不**调度（0 次创建）。 */
    if (!(interpretationRes && interpretationRes.ok === true && interpretationRes.interpretation)) {
      expectationCounters.skippedNoL3 += 1;
      recordExpectationTurn({ turnId, characterId, status: 'not-created', reason: 'l3-not-validated', providerCalls: 0, completedAt });
      return;
    }
    const payload = {
      characterId: characterId,
      /* conversationId 从**既有的** turnIdentity 里取（`run()` 在 :1144 就用
         shape.conversationId 建好了它）—— 不新增参数、不另造身份。 */
      conversationId: String(
        (ctx && ctx.conversationId != null ? ctx.conversationId : '')
        || (binding && binding.turnIdentity && binding.turnIdentity.conversationId != null ? binding.turnIdentity.conversationId : '')
      ),
      turnId: turnId,
      selectedIds: Array.isArray(binding.selectedIds) ? binding.selectedIds.slice() : [],
      records: Array.isArray(binding.records) ? binding.records : undefined,
      currentState: isPlainObject(binding.currentState) ? binding.currentState : {},
      /* 调度纪律的**显式**声明：这一次调用发生在一次已验证的 L3 成功之后。 */
      interpretationValidated: true,
      interpretation: interpretationRes.interpretation,
      independentObservationCount: Number(interpretationRes.independentObservationCount)
    };
    const runTask = async () => {
      expectationCounters.started += 1;
      let res = null;
      try {
        try { res = await expectation.runFromValidatedInterpretation(payload, {}); }
        catch (error) {
          res = { ok: false, status: 'failed', reason: 'expectation-hook-threw', providerCalls: 0, error: bounded((error && error.message) || error) };
        }
        const status = res && res.status ? String(res.status) : 'failed';
        if (status === 'created') expectationCounters.created += 1;
        else if (status === 'failed' || status === 'timed-out') expectationCounters.failed += 1;
        else expectationCounters.notCreated += 1;
        try {
          recordExpectationTurn({
            turnId: turnId, characterId: characterId, status: status,
            reason: res && (res.reason || res.reasonCode) ? String(res.reason || res.reasonCode) : null,
            providerCalls: Number(res && res.providerCalls) || 0,
            itemCount: Number(res && res.itemCount) || 0,
            completedAt: Number(clock())
          });
        } catch (_) { /* 记录失败绝不影响任何东西 */ }
        note('runtime-recall-expectation', {
          characterId: characterId, turnId: turnId, status: status,
          providerCalls: Number(res && res.providerCalls) || 0
        });
      } finally {
        settleExpectationWaiters();
      }
    };
    recordExpectationTurn({ turnId, characterId, status: 'pending', reason: null, providerCalls: 0, completedAt: null });
    expectationScheduled += 1;
    expectationCounters.scheduled += 1;
    if (typeof setTimeout === 'function') {
      const t = setTimeout(() => { expectationScheduled -= 1; runTask(); }, 0);
      if (t && typeof t.unref === 'function') t.unref();
    } else {
      Promise.resolve().then(() => { expectationScheduled -= 1; runTask(); });
    }
  }
  /* 测试用 settle 缝（不在生产路径上）。 */
  function awaitExpectationIdle(timeoutMs) {
    const cap = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0 ? Number(timeoutMs) : 10000;
    if (expectationScheduled === 0) return Promise.resolve({ idle: true, scheduled: 0 });
    return new Promise(function (resolve) {
      let done = false;
      const waiter = function () { if (done) return; done = true; resolve({ idle: true, scheduled: expectationScheduled }); };
      expectationWaiters.add(waiter);
      const t = setTimeout(function () {
        if (done) return; done = true; expectationWaiters.delete(waiter);
        resolve({ idle: false, scheduled: expectationScheduled });
      }, cap);
      if (t && typeof t.unref === 'function') t.unref();
    });
  }
  /* 测试用的 settle 缝：等到"已调度 + 在飞"都归零（或超时）。
     ★ 它**不在**召回响应路径上，也不改变任何生产行为。 */
  function awaitAutoIdle(timeoutMs) {
    const cap = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0 ? Number(timeoutMs) : 10000;
    if (autoScheduled === 0 && autoCounters.inFlight === 0) {
      return Promise.resolve({ idle: true, inFlight: 0, scheduled: 0 });
    }
    return new Promise((resolve) => {
      let done = false;
      const waiter = { finish: null };
      const finish = () => {
        if (done) return;
        done = true;
        autoWaiters.delete(waiter);
        try { clearTimeout(timer); } catch (_) { /* 已触发 */ }
        resolve({ idle: autoScheduled === 0 && autoCounters.inFlight === 0, inFlight: autoCounters.inFlight, scheduled: autoScheduled });
      };
      waiter.finish = finish;
      autoWaiters.add(waiter);
      /* ★ 这个定时器**不** unref：调用方正在 await 它，进程必须活到它有结论。
         （任务本身的调度定时器仍然 unref —— 后台解释不该吊住进程退出。） */
      const timer = setTimeout(finish, cap);
    });
  }
  /* 内部读取缝（**没有路由**）：只给同一进程里的调用方/测试看这一轮的
     turn-local 结果。它绝不进 HTTP 响应、window.IB、/security 或日志。 */
  function getTurnInterpretation(turnId) {
    const rec = turnInterpretations.get(String(turnId == null ? '' : turnId));
    return rec ? Object.assign({}, rec) : null;
  }
  function listTurnInterpretations() {
    sweepTurnInterpretations();
    return Array.from(turnInterpretations.values()).map((r) => ({
      turnId: r.turnId, characterId: r.characterId, status: r.status, reason: r.reason,
      errorClass: r.errorClass, startedAt: r.startedAt, completedAt: r.completedAt,
      recordSource: r.recordSource, providerCalls: r.providerCalls
    }));
  }

  /* 释放一个**已经 begin、但这一轮没能走完**的 Home turn 身份。
     与 mobile-gateway.js:1199-1203 releaseRecallTurn 同一职责：begin 一旦发生，
     任何早退都必须 end，否则 homeTurnIndex 会随失败请求线性增长（而且不报错）。 */
  function releaseTurn(active) {
    if (!active || !sessionState || typeof sessionState.endHomeTurn !== 'function') return false;
    try {
      const ended = sessionState.endHomeTurn({ turnId: active.turnId }) === true;
      if (ended) authoritativeCounters.turnsEnded += 1;
      return ended;
    } catch (_) { return false; }
  }

  /* ── 主入口：**永不抛出** ───────────────────────────────────────────── */
  async function run(body, options) {
    const opts = isPlainObject(options) ? options : {};
    const startedAt = Number(clock());
    try {
      const shape = validateRequest(body);
      if (!shape.ok) {
        note('runtime-recall-refused', {
          code: shape.result.error, field: shape.result.field || null,
          characterId: shape.result.characterId || null
        });
        return shape.result;
      }
      const characterId = shape.characterId;

      /* 已经取消的请求：连 store 都不读（零成本、零信息）。 */
      if (opts.signal && opts.signal.aborted === true) {
        note('runtime-recall-cancelled', { characterId: characterId });
        return failure(REASON.recallTimeout, {
          characterId: characterId, detail: 'caller-aborted-before-recall', attempts: 0
        });
      }

      /* 装配缺口：一个"看不见同一个 store"的召回器不能服务（fail closed）。 */
      if (storeIdentity === 'MISMATCH') {
        note('runtime-recall-store-mismatch', { characterId: characterId });
        return failure(REASON.recallUnavailable, {
          characterId: characterId, detail: 'retrieval-store-mismatch', attempts: 0
        });
      }
      if (!memoryRetrieval || typeof memoryRetrieval.retrieve !== 'function') {
        return failure(REASON.recallUnavailable, {
          characterId: characterId, detail: 'memory-retrieval-not-assembled', attempts: 0
        });
      }
      const specResult = resolveCharacterSpec(characterId);
      if (!specResult.ok) {
        note('runtime-recall-spec-unavailable', { characterId: characterId, reason: specResult.reason });
        return failure(REASON.runtimeSpecUnavailable, {
          characterId: characterId, detail: specResult.reason, attempts: 0
        });
      }

      counters.calls += 1;
      /* ── logical turn index：**只读**注入的 session state ─────────────────
         cooldown 需要"这是第几个逻辑回合"才能把最近曝光过的候选降权。没有它，
         服务端的 cooldown 是 **inert** 的 —— 实测口径：同一批候选、同一个集合，
         但顺序不同（被冷却的 pinned 候选不会被降位）。
         ★ 这里只调 `currentTurnIndex`（纯读：内部就是 turnCounters.get）。
           绝不 beginBrowserTurn / beginHomeTurn / endHomeTurn / recordExposure /
           clear —— 读一个计数不改变任何状态，因此纯影子逐字成立。
         ★ 诚实边界：今天这个计数器只由 Home Node **自己拥有的回合**推进
           （mobile 的 beginTurn/settle）；会话所有权**尚未**转移给本阶段。
           因此"桌面影子 vs 服务端边界"的顺序一致性只有在两侧喂**同一个**索引时
           才有意义（parity harness 正是两侧同 seed 地构造的），而不是"服务端
           已经能独立算出一轮"。 */
      /* ── P21-R4-LIVE-3.4 · 上面的"只读"只适用于**影子模式**（默认）───────
         权威模式（mode:'authoritative'）按下面的顺序接管这一轮的 Home turn：
         begin → retrieve → reinforce → recordExposure → end。
         顺序是**硬约束**（与 mobile-gateway.js:1178-1195 同款）：cooldown 的
         turn distance = currentTurnIndex − lastExposureTurn，若 retrieval 先
         发生，本轮 index 还不存在，所有候选都拿不到 penalty —— cooldown 会
         静默失效。turnId 用**既有**公式（deriveStableTurnId）从
         requestId+conversationId 推出，不铸造第二个身份。 */
      const messageHash = CHAT_CORE.stableToken(
        shape.conversationId + '\u0000' + shape.requestId + '\u0000' + shape.message);
      const turnId = deriveStableTurnId(shape.requestId, shape.conversationId);
      const authoritative = (shape.mode === MODES[1]);
      let lifecycle = null;
      let turnIndex = null;
      if (authoritative) {
        const prior = settledTurns.get(turnId);
        if (prior && prior.messageHash === messageHash) {
          /* 重放：同一 (requestId, conversationId, message) ⇒ **不** begin、
             **不** retrieve、**不** 强化、**不** 曝光、**不** end。
             直接回这一轮已经结算的信封；effects 如实报"本请求什么都没做"。 */
          authoritativeCounters.replaysServed += 1;
          counters.ok += 1;
          settledTurns.delete(turnId); settledTurns.set(turnId, prior); /* 刷新 LRU 序 */
          note('runtime-recall-replay', { characterId: characterId, turnId: turnId, selected: prior.selectedIds.length });
          return {
            ok: true,
            durable: false,
            operation: OPERATION,
            characterId: characterId,
            turnIdentity: prior.turnIdentity,
            selectedIds: prior.selectedIds.slice(),
            activationPolicy: prior.activationPolicy,
            channel: prior.channel,
            reason: prior.reason,
            fingerprint: prior.fingerprint,
            counts: Object.assign({}, prior.counts),
            chars: prior.chars,
            context: Object.assign({}, prior.context),
            effects: zeroEffects({
              activation: { updated: 0, duplicated: prior.activationIds.slice(), reason: 'turn-duplicate' }
            }),
            boundary: boundaryBlock(0, { exposureWrites: 0, activationWrites: 0 }),
            status: 200
          };
        }
        if (!sessionState || typeof sessionState.beginHomeTurn !== 'function') {
          return failure(REASON.recallUnavailable, {
            characterId: characterId, detail: 'session-state-not-assembled', attempts: 0,
            mode: shape.mode, context: emptyContext(), effects: zeroEffects()
          });
        }
        turnIndex = sessionState.beginHomeTurn({ characterId: characterId, turnId: turnId });
        if (turnIndex == null) {
          return failure(REASON.recallUnavailable, {
            characterId: characterId, detail: 'turn-identity-unavailable', attempts: 0,
            mode: shape.mode, context: emptyContext(), effects: zeroEffects()
          });
        }
        authoritativeCounters.turnsBegun += 1;
        lifecycle = { turnId: turnId, turnIndex: turnIndex };
      } else {
        turnIndex = (sessionState && typeof sessionState.currentTurnIndex === 'function')
          ? sessionState.currentTurnIndex({ characterId: characterId })
          : null;
      }
      /* ── 既有召回的**唯一**调用点 ─────────────────────────────────────
         传下去的每一个选项都是服务端自有的：
           · userMessage / conversationId / 两个 turn 信号 = 调用方对"这一轮
             是什么"的如实陈述（它们的形状已经在上面校验过）；
           · now = 服务端时钟（调用方的 now / timestamp 已被逐名拒绝）；
           · includeHeader: true = 复现**桌面 wrapper** 的选择预算语义
             （header 计入 maxChars，紧预算下会改变最终集合 —— 见
             memory-retrieval.js 的 §5 说明）。这不是"顺手打开的一个开关"：
             不传它，服务端与桌面就会在紧预算下选出不同的集合。
           · **不传** maxChars / contentLen / turnIndex / sessionState /
             random / glossary 条目：预算由 store 的已发布设置与共享缺省决定，
             随机源与 sessionState 是 wrapper 的**构造依赖**（唯一权威），
             而 glossary 条目只由装配层注入（见上面的两个 deps）。
           · withTrace: true = 要**有界**诊断（通道 + input/visible/gated/
             selected 计数）。它只让 wrapper 多回一个 diagnostics 键，
             默认关闭时 wrapper 的返回对象逐字节不变 —— 因此这不是
             "打开调试模式"，而是本边界如实回报"这一轮走了哪个通道、
             几个候选"的唯一来源。逐条分数（trace.candidates）**不**在其中。 */
      let picked = null;
      try {
        picked = memoryRetrieval.retrieve(characterId, {
          userMessage: shape.message,
          conversationId: shape.conversationId,
          isFirstTurn: shape.isFirstTurn,
          conversationSignalAvailable: shape.conversationSignalAvailable,
          now: Number(clock()),
          /* §cooldown：索引来自注入的 session state（纯读，见上面的说明）。
             缺席时是 null ⇒ wrapper 把 turnIndex 置 null ⇒ 与今天逐字同行为。 */
          turnIndex: turnIndex,
          includeHeader: true,
          /* P21-R4-LIVE-3.4 · §6：**一个** wire 键驱动两个 wrapper 选项。
             浏览器在群聊路径上本来就是成对传的（isGroup:true +
             groupMemEnabled:true）；服务端按同一个事实驱动两者，因此不存在
             "群聊但记忆开关是 1v1"这种自相矛盾的组合。缺席 ⇒ false/false，
             既有调用方逐字节不变。 */
          isGroup: shape.isGroup === true,
          groupMemEnabled: shape.isGroup === true,
          withTrace: true,
          glossaryProvider: glossaryProvider,
          getGlossaryEntries: getGlossaryEntries
        });
      } catch (error) {
        const released = releaseTurn(lifecycle);
        note('runtime-recall-threw', {
          characterId: characterId, error: bounded((error && error.message) || error)
        });
        return failure(REASON.recallUnavailable, {
          characterId: characterId, detail: 'retrieve-threw', attempts: 1,
          mode: shape.mode, context: emptyContext(),
          effects: zeroEffects({ turnBegun: !!lifecycle, turnEnded: released })
        });
      }
      const latencyMs = Math.max(0, Number(clock()) - startedAt);
      if (!picked || picked.ok !== true) {
        const released = releaseTurn(lifecycle);
        note('runtime-recall-unavailable', {
          characterId: characterId, reason: bounded(picked && (picked.error || picked.reason)) || 'retrieve-failed'
        });
        return failure(REASON.recallUnavailable, {
          characterId: characterId,
          detail: bounded(picked && (picked.error || picked.reason)) || 'retrieve-failed',
          attempts: 1,
          mode: shape.mode, context: emptyContext(),
          effects: zeroEffects({ turnBegun: !!lifecycle, turnEnded: released })
        });
      }
      /* 超时是**事后**判定：召回是本地同步调用，没有 provider 可以取消；
         一旦越过调用方给的窗口，结果就不该再被消费（它是窗口外的观测）。
         因为这条边界是纯影子，"丢弃结果"不会留下任何副作用。 */
      if (opts.signal && opts.signal.aborted === true) {
        const released = releaseTurn(lifecycle);
        note('runtime-recall-cancelled', { characterId: characterId, latencyMs: latencyMs });
        return failure(REASON.recallTimeout, {
          characterId: characterId, detail: 'caller-aborted-during-recall', attempts: 1,
          mode: shape.mode, context: emptyContext(),
          effects: zeroEffects({ turnBegun: !!lifecycle, turnEnded: released })
        });
      }
      if (latencyMs > shape.effectiveTimeoutMs) {
        const released = releaseTurn(lifecycle);
        note('runtime-recall-timeout', {
          characterId: characterId, latencyMs: latencyMs, timeoutMs: shape.effectiveTimeoutMs
        });
        return failure(REASON.recallTimeout, {
          characterId: characterId, detail: 'deadline-exceeded', attempts: 1,
          mode: shape.mode, context: emptyContext(),
          effects: zeroEffects({ turnBegun: !!lifecycle, turnEnded: released })
        });
      }

      /* ── 成功信封：ids + **有界**诊断 ────────────────────────────────
         ids 是**有序**的（既有实现的 selection 顺序，本层不重排）。
         绝不回：隐藏候选、逐条分数、canonical 整行、完整 trace、
         渲染后的正文（text）或 message 原文。 */
      const selectedIds = Array.isArray(picked.selectedIds) ? picked.selectedIds.slice() : [];
      const diagnostics = boundedDiagnosticsOf(picked);
      const diagCounts = diagnostics && diagnostics.counts ? diagnostics.counts : null;
      /* 冻结映射（与 wrapper 的 withTrace 契约逐条对应）：
           · channel    ← diagnostics.channel —— **可空**：早退轮确实没有通道，
                          这里如实透传，绝不替换成一个默认名（通道是被报告的，
                          不是被选择的）。
           · candidates ← diagnostics.counts.input —— 这一次读进来的候选行数。
           · eligible   ← diagnostics.counts.gated —— 过了 hard relevance gate
                          = 真正有资格进入选择的条数。
           · selected   ← selectedIds.length —— 注入事实，由本层自己数。
         trace 缺席时（orchestrator 不可用 ⇒ wrapper 直调 core）candidates 退回
         picked.candidates、eligible 退回 selected 这个**下界**（"被选中的一定
         曾经 eligible"是可证的事实）—— 不把未知伪装成一个精确数字。 */
      const traceInput = diagCounts ? metricOrNull(diagCounts.input) : null;
      const traceGated = diagCounts ? metricOrNull(diagCounts.gated) : null;
      const traceVisible = diagCounts ? metricOrNull(diagCounts.visible) : null;
      const counts = {
        candidates: traceInput != null ? traceInput : (Number(picked.candidates) || 0),
        eligible: traceGated != null ? traceGated : (traceVisible != null ? traceVisible : selectedIds.length),
        selected: selectedIds.length
      };
      const channel = diagnostics ? (diagnostics.channel == null ? null : String(diagnostics.channel)) : null;
      const activationPolicy = picked.activationPolicy === 'none' ? 'none' : 'normal';
      const reason = picked.reason == null ? null : String(picked.reason);
      const chars = Number(picked.chars) || 0;
      /* turnIdentity：两个**身份** + 消息长度 + 一个 **turn 摘要**。
         摘要的输入元组是这一轮的**全部**身份事实：
             conversationId ⧺ requestId ⧺ message
         因此它同时满足三条可断言的语义：
           · 重放同一轮（三者全同）⇒ 完全相同的摘要；
           · 换 requestId（同一句话的**另一轮**）⇒ 不同的摘要；
           · 换 message（同一轮的**另一句话**）⇒ 不同的摘要。
         只吃 message 会让"两次不同的回合"读起来像同一轮；把三者之外的东西
         （时钟、随机、结果）混进来又会让重放不再稳定 —— 这个元组就是边界。
         实现用仓库**既有**的确定性令牌 `CHAT_CORE.stableToken`（requestId →
         userMessageId 用的同一个）：不铸造新 id、不生成永久 id、不落任何东西；
         原文绝不回显（摘要不可逆，且长度固定）。 */
      const turnIdentity = {
        requestId: shape.requestId,
        conversationId: shape.conversationId,
        messageChars: shape.message.length,
        messageHash: CHAT_CORE.stableToken(
          shape.conversationId + '\u0000' + shape.requestId + '\u0000' + shape.message)
      };
      /* fingerprint：把"这次召回的完整事实"压成一个稳定摘要，供未来的解释
         边界证明"我解释的正是这一份召回"。输入元组是**冻结**的（见
         FINGERPRINT_VERSION 的说明）：同一份 turn + 同一份 canonical 数据
         ⇒ 同一个 fingerprint；任何一条 selectedIds 变化都会改变它。 */
      const fingerprint = FINGERPRINT_VERSION + ':' + sha256Hex(JSON.stringify([
        FINGERPRINT_VERSION, characterId, shape.requestId, shape.conversationId,
        turnIdentity.messageHash, selectedIds, activationPolicy, channel,
        counts.candidates, counts.eligible, counts.selected, chars, reason
      ]));

      /* ── P21-R4-LIVE-3.4 · 权威模式：写 ───────────────────────────────
         顺序与 mobile-gateway 的 settle 路径逐条对齐
         （reinforce → recordExposure → endHomeTurn），而且**只有**这一处会写。
         影子模式一个生命周期动词都不调用（committed 套件对此有硬断言）。 */
      let contextExtra = null;
      let effects = null;
      if (authoritative && lifecycle) {
        const ctx = {
          text: typeof picked.text === 'string' ? picked.text : '',
          count: Number(picked.count) || 0,
          chars: chars,
          includeHeader: true
        };
        /* ① 激活：走 canonical 通道（memoryRetrieval.reinforce →
           store.recordActivation），并把 turnId 传下去 —— 于是 LIVE-3.3 的
           turn-scoped guard 在同轮重放时如实回 updated:0 + duplicated +
           reason:'turn-duplicate'：宁可少记，绝不重复计数。
           用 reinforcementIds（coldStart ⇒ 空），与 mobile-gateway.js:2553-2555 同款。 */
        const reinforcementIds = Array.isArray(picked.reinforcementIds)
          ? picked.reinforcementIds.slice() : selectedIds.slice();
        let activation = { updated: 0, duplicated: [], reason: null };
        if (reinforcementIds.length) {
          try {
            const reinforced = (typeof memoryRetrieval.reinforce === 'function')
              ? memoryRetrieval.reinforce(reinforcementIds, { turnId: lifecycle.turnId })
              : null;
            if (reinforced && reinforced.ok === true) {
              activation = {
                updated: Number(reinforced.updated) || 0,
                duplicated: Array.isArray(reinforced.duplicated) ? reinforced.duplicated.slice() : [],
                reason: reinforced.reason == null ? null : String(reinforced.reason)
              };
              authoritativeCounters.activationWrites += activation.updated;
            } else {
              activation.reason = bounded((reinforced && (reinforced.error || reinforced.reason)) || 'activation-unavailable');
            }
          } catch (error) {
            activation.reason = 'activation-threw';
            note('runtime-recall-activation-failed', {
              characterId: characterId, error: bounded((error && error.message) || error)
            });
          }
        }
        /* ② 曝光：写**最终注入**的 ids（不是 reinforcementIds），与
           mobile-gateway.js:2580-2587 逐字同款；recordExposure 对
           (character, memory, turnIndex) 天然幂等。 */
        let exposureWritten = 0;
        if (selectedIds.length && sessionState && typeof sessionState.recordExposure === 'function') {
          try {
            exposureWritten = Number(sessionState.recordExposure({
              characterId: characterId, memoryIds: selectedIds, turnIndex: lifecycle.turnIndex
            })) || 0;
            authoritativeCounters.exposureWrites += exposureWritten;
          } catch (error) {
            note('runtime-recall-exposure-failed', {
              characterId: characterId, error: bounded((error && error.message) || error)
            });
          }
        }
        /* ③ end：释放 Home turn 身份（有界），与 mobile-gateway.js:2597 同款。 */
        const ended = releaseTurn(lifecycle);
        effects = {
          turnBegun: true,
          activation: activation,
          exposure: { written: exposureWritten },
          turnEnded: ended
        };
        contextExtra = ctx;
        /* ④ 结算备忘（有界、内存、重启即空）：同一
           (requestId, conversationId, message) 的下一次调用**不触碰任何状态**。 */
        settledTurns.set(turnId, {
          messageHash: messageHash,
          selectedIds: selectedIds.slice(),
          context: ctx,
          counts: Object.assign({}, counts),
          channel: channel, reason: reason, chars: chars,
          activationPolicy: activationPolicy, fingerprint: fingerprint,
          turnIdentity: turnIdentity,
          activationIds: reinforcementIds.slice()
        });
        while (settledTurns.size > MAX_SETTLED_TURNS) {
          const oldest = settledTurns.keys().next();
          if (oldest.done) break;
          settledTurns.delete(oldest.value);
        }
        /* ── P21-R4-LIVE-4 · post-recall hook（fire-and-forget）──────────
           位置就在这里：selection / exposure / activation / end **全部完成
           之后**，而且在返回信封**之前只是"调度"**——本文件从不 await 它，
           因此召回响应时间不随解释的模型延迟增长。
           ★ 它只在 authoritative 模式存在；影子模式与既有 mobile 路径
             一个字都没变（它们根本走不到这个分支）。 */
        scheduleAutoInterpretation({
          characterId: characterId,
          turnId: turnId,
          turnIdentity: turnIdentity,
          selectedIds: selectedIds,
          /* wrapper 今天不返回行 ⇒ undefined ⇒ 解释侧服务端重绑。 */
          records: Array.isArray(picked.records) ? picked.records : undefined,
          currentState: isPlainObject(shape.currentState) ? shape.currentState : {},
          roleName: shape.roleName,
          channel: channel,
          fingerprint: fingerprint,
          canonicalRevision: null
        });
      }

      counters.ok += 1;
      const out = {
        ok: true,
        durable: false,
        operation: OPERATION,
        characterId: characterId,
        turnIdentity: turnIdentity,
        selectedIds: selectedIds,
        activationPolicy: activationPolicy,
        channel: channel,
        reason: reason,
        fingerprint: fingerprint,
        counts: counts,
        chars: chars,
        boundary: boundaryBlock(1, (authoritative && effects)
          ? { exposureWrites: effects.exposure.written, activationWrites: effects.activation.updated }
          : null),
        status: 200
      };
      if (authoritative) {
        out.context = contextExtra || emptyContext();
        out.effects = effects || zeroEffects();
      }
      /* 审计只记**有界**字段：身份、结果、计数、通道、耗时。
         message 原文、selectedIds 之外的正文、任何秘密都不进来。
         ★ 影子模式的审计字段集合逐字不变（committed 套件可捕获日志）；
           `mode` 只在权威模式出现。 */
      const noteFields = {
        characterId: characterId,
        requestId: shape.requestId,
        outcome: 'ok',
        selected: counts.selected,
        candidates: counts.candidates,
        eligible: counts.eligible,
        channel: channel,
        chars: chars,
        latencyMs: latencyMs
      };
      if (authoritative) {
        noteFields.mode = shape.mode;
        noteFields.activationWrites = effects ? effects.activation.updated : 0;
        noteFields.exposureWrites = effects ? effects.exposure.written : 0;
      }
      note('runtime-recall', noteFields);
      return out;
    } catch (error) {
      /* 兜底：契约是"永不抛出"。任何未预料的编程错误都以稳定的码回答，
         而不是把 500 留给上一层去猜。 */
      note('runtime-recall-crashed', { error: bounded((error && error.message) || error) });
      return failure(REASON.recallUnavailable, { detail: 'unexpected-boundary-error', attempts: 0 });
    }
  }

  /* ── 自述：这条边界是什么、不是什么（机器可读）─────────────────────────
     与解释边界同一条纪律：每一个"没有"都必须是一条可断言的字段，
     而不是注释里的一句承诺。 */
  function describe() {
    return {
      path: PATH,
      operation: OPERATION,
      operations: [OPERATION],
      transport: 'POST',
      transportScope: TRANSPORT_SCOPE,
      /* 调用方在这条边界上的权威 = 只描述这一轮是什么 + （可选）请求接管回合。 */
      callerAuthority: 'NONE',
      /* ── P21-R4-LIVE-3.4 · mode ────────────────────────────────────────
         `pureShadow` 保持原义：**影子模式**是纯的（这也是默认模式）。
         `shadowPure` 是同一件事的显式别名；`sessionStateOwned:false` 仍然为真
         （实例由装配层拥有），新增的是"权威模式下本边界**推进**那个实例的
         回合生命周期"这一事实。 */
      pureShadow: true,
      shadowPure: true,
      defaultMode: DEFAULT_MODE,
      modes: MODES.slice(),
      authoritativeMode: 'TURN_LIFECYCLE_OWNED',
      authoritativeWrites: AUTHORITATIVE_WRITES.slice(),
      authoritativeRequiresSessionState: true,
      replayAuthority: 'IN_PROCESS_SETTLED_TURN_MEMO',
      replayMemoMaxTurns: MAX_SETTLED_TURNS,
      crossRestartExactlyOnce: 'NO',
      /* ★ 三个"零"是这条边界存在的全部理由，逐条可断言。 */
      exposureWrites: 0,
      activationWrites: 0,
      providerCalls: 0,
      providerReachable: false,
      sessionMutation: 'NONE',
      /* sessionState **不**由本边界拥有：它只被接受、被核对、被如实报告。
         任何推进都发生在别处（回合结算），不在这里。 */
      sessionStateOwned: false,
      sessionStateInjected: !!sessionState,
      /* cooldown 的 turn index 由本边界**只读**注入的 session state 得到：
         它不推进、不拥有那个计数器（见 run() 里的说明与诚实边界）。 */
      turnIndexAuthority: 'SERVER_SESSION_STATE_READ_ONLY',
      randomAuthority: 'memory-retrieval-constructor',
      randomInjected: !!random,
      clockAuthority: 'home-node-server',
      recallSelectionAuthority: 'CALLER_PROPOSED',
      retrievalAuthority: 'services/home-node/memory-retrieval.js',
      visibilityAuthority: 'assets/js/memory-retrieval-core.js',
      glossaryAuthority: 'assembly-only',
      storeIdentity: storeIdentity,
      maxAttempts: 1,
      autoRetry: 'NONE',
      defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
      maxTimeoutMs: MAX_TIMEOUT_MS,
      /* 接受与被拒**两张名单**：它们是同一份冻结常量（不是副本），
         因此 describe() 不可能与校验逻辑漂移。
         ★ `requestFields` 仍是那 8 个必需形状词（committed 套件钉住长度 8）；
           `mode` 是**唯一**的可选能力键，单独一张名单如实报告。 */
      requestFields: REQUEST_FIELDS,
      acceptedFields: REQUEST_FIELDS,
      optionalRequestFields: OPTIONAL_REQUEST_FIELDS,
      rejectedAuthorityFields: REJECTED_AUTHORITY_FIELDS,
      rejectedFields: REJECTED_AUTHORITY_FIELDS,
      reasonCodes: Object.keys(STATUS_BY_REASON),
      fingerprintVersion: FINGERPRINT_VERSION,
      counters: Object.assign({}, counters),
      authoritativeCounters: Object.assign({}, authoritativeCounters),
      /* ── P21-R4-LIVE-4 · 自动解释（READY-but-OFF）─────────────────────
         只报**有界状态与计数**，没有正文、没有 prompt、没有凭据。
         `enabled` 直接来自解释服务的 autoPolicy（唯一裁决者）。 */
      autoInterpretation: {
        enabled: autoEnabled(),
        /* ── P21-R4-LIVE-4.3 · 这一格说的是**全局 default 视图** ────────────
           per-character 权威（文件策略）不是一个布尔：A 开 / B 关各自成立，
           真正的每角色裁决发生在解释入口 `runFromAuthoritativeRecall` 里。
           因此这里如实标出作用域，并把权威来源透传出来（TEST_INJECTION
           只在装配层显式注入测试缝时出现）。 */
        enabledScope: 'GLOBAL_DEFAULT_ONLY',
        perCharacterAuthority: true,
        authoritySource: autoAuthoritySource(),
        hooked: !!interpretation,
        binding: 'DIRECT_SERVER_INTERNAL',
        trigger: 'POST_RECALL_NONBLOCKING',
        awaitedOnRecallPath: false,
        channels: (interpretation && Array.isArray(interpretation.AUTO_INTERPRETATION_CHANNELS))
          ? interpretation.AUTO_INTERPRETATION_CHANNELS.slice() : [],
        maxAdditionalModelCallsPerCharacterTurn: (interpretation && interpretation.MAX_ADDITIONAL_MODEL_CALLS_PER_CHARACTER_TURN) || 1,
        crossRestartInterpretationExactlyOnce: 'NO',
        resultHolder: {
          scope: 'character+turn',
          storage: 'IN_PROCESS_MEMORY_ONLY',
          maxEntries: MAX_TURN_INTERPRETATIONS,
          ttlMs: TURN_INTERPRETATION_TTL_MS,
          durable: false,
          routes: []
        },
        counters: Object.assign({}, autoCounters, { scheduled: autoScheduled, results: turnInterpretations.size }),
        /* ── P21-R4-LIVE-4.1B · §6/§7 · 状态模型与计数语义 ─────────────
           状态词表是**封闭**的；`failed` 只装真正的执行失败。 */
        states: ['succeeded', 'timed-out', 'disabled', 'not-enabled', 'not-scheduled', 'not-needed', 'duplicate-turn', 'failed'],
        counterSemantics: {
          started: 'tasks that reached the interpretation entry',
          succeeded: 'validated interpretation produced',
          timedOut: 'server-owned timeout (never counted as a provider failure)',
          disabled: 'auto policy OFF — counted in notEnabled, NOT a failure',
          notEnabled: 'disabled / not-enabled / not-scheduled (no execution attempted)',
          notNeeded: 'zero memory / channel not eligible / duplicate turn (no provider call)',
          failed: 'execution failure only',
          inFlight: 'scheduled + running tasks (released in a finally block)'
        }
      },
      /* ── P21-R4-LIVE-5 · L5 期望（兄弟子系统；只报告状态/计数，绝无正文）── */
      expectation: {
        hooked: !!expectation,
        binding: 'DIRECT_SERVER_INTERNAL',
        trigger: 'POST_INTERPRETATION_NONBLOCKING',
        awaitedOnRecallPath: false,
        schedulingRequiresL3Success: 'YES',
        protocolRequiresL3Interpretation: 'NO',
        executionKind: (expectation && expectation.EXECUTION_KIND) || 'MODEL',
        maxAdditionalExpectationModelCallsPerCharacterTurn: (expectation && expectation.MAX_ADDITIONAL_EXPECTATION_MODEL_CALLS_PER_CHARACTER_TURN) || 1,
        enabledCharacterCount: expectationEnabled() ? 1 : 0,
        crossRestartExpectationExactlyOnce: 'NO',
        predictionErrorLive: 'NO',
        durableWrites: 0,
        routes: [],
        counters: Object.assign({}, expectationCounters, { results: expectationTurns.size }),
        states: ['created', 'not-created', 'timed-out', 'failed', 'pending'],
        /* 正文永不出现在这里：只有状态/计数/原因。 */
        contentExposed: 'NO'
      }
    };
  }

  return Object.freeze({
    path: PATH,
    operations: [OPERATION],
    run: run,
    describe: describe,
    /* P21-R4-LIVE-4 · 内部缝（**没有路由**）：
       · awaitAutoIdle —— 测试用的 settle 钩子（等"已调度 + 在飞"归零）；
       · getTurnInterpretation / listTurnInterpretations —— turn-local 结果
         的只读视图（含正文，只给同进程调用方/测试；绝不进 HTTP 响应、
         window.IB、/security、日志或遥测）。 */
    awaitAutoIdle: awaitAutoIdle,
    getTurnInterpretation: getTurnInterpretation,
    listTurnInterpretations: listTurnInterpretations,
    /* P21-R4-LIVE-5 · 期望的 settle 缝（测试用）。
       ★ 这里**没有**任何返回期望正文的入口 —— 内容留在
         runtime-expectation.js 的持有者里，结构性不可消费。 */
    awaitExpectationIdle: awaitExpectationIdle,
    expectationTurnStatus: function (turnId) {
      const rec = expectationTurns.get(String(turnId == null ? '' : turnId));
      return rec ? { turnId: rec.turnId, status: rec.status, reason: rec.reason, providerCalls: rec.providerCalls, itemCount: rec.itemCount } : null;
    }
  });
}

module.exports = createRuntimeRecall;
module.exports.createRuntimeRecall = createRuntimeRecall;
module.exports.PATH = PATH;
module.exports.OPERATION = OPERATION;
module.exports.REQUEST_FIELDS = REQUEST_FIELDS;
module.exports.OPTIONAL_REQUEST_FIELDS = OPTIONAL_REQUEST_FIELDS;
module.exports.MODES = MODES;
module.exports.DEFAULT_MODE = DEFAULT_MODE;
module.exports.AUTHORITATIVE_WRITES = AUTHORITATIVE_WRITES;
module.exports.deriveStableTurnId = deriveStableTurnId;
module.exports.REJECTED_AUTHORITY_FIELDS = REJECTED_AUTHORITY_FIELDS;
module.exports.REASON = REASON;
module.exports.STATUS_BY_REASON = STATUS_BY_REASON;
module.exports.DEFAULT_TIMEOUT_MS = DEFAULT_TIMEOUT_MS;
module.exports.MAX_TIMEOUT_MS = MAX_TIMEOUT_MS;
module.exports.TRANSPORT_SCOPE = TRANSPORT_SCOPE;
