'use strict';
/* ====================================================================
   IB Home Node · Economy Command Channel（P22-11 · 23117 → 23118 的**唯一** command 面）
   --------------------------------------------------------------------
         Active Agent decision runtime（端口 23114）
                          ↓
              Economy Command Channel              ← 本文件
                          ↓
            P22-10 Economy Action Adapter
                          ↓
              P22-9 bound capability handle
                          ↓
                    P22-8 → P22-7 → P22-6

   ── §1 只读审计：这个仓库里已经有什么 transport，缺的到底是什么 ──────
   审计结论（全部来自读代码，没有一条来自提示词假设）：

     ① **已经有一份可复用的 transport**，而且它是既有事实、不是本阶段
        新造的：Home Node 的 HTTP seam（services/home-node/http.js）已经
        具备本阶段需要的每一条：
          · loopback 限制（isLoopback；非 loopback 来源整片拒绝）；
          · 桌面凭据（X-IB-Home-Token / Bearer / ?token，恒定时间比较）；
          · 请求信封（{ ok, protocolVersion, serverTime, … }）与
            错误信封（{ ok:false, error, … }）；
          · requestId / 幂等（/messages、/memory/records 等早已在用）；
          · 超时（客户端 AbortController）。
        ⇒ 本文件**不新造第二套 transport framework**（§1 逐字禁止）。
          它只在这条既有 transport 上增加**两个**窄东西：
            (a) 一条专用路径 + 一个 command handler（下面 §2/§5）；
            (b) 一个出站调用器（bounded timeout / bounded retry，§8）。

     ② **缺的**不是"能不能安全表达一条 command"，而是**来源绑定**。
        既有 transport 的凭据（桌面 token）回答的是"你有没有这台机器的
        桌面凭据"——它对 23114 与对任何本机进程是**同一个答案**。
        而 §3 要求身份由"authenticated transport + registered
        source/process/channel"确定，绝不由 payload 自报。
        ⇒ 本文件新增的唯一安全机制就是这份**来源登记**：
          · 每个来源有自己的 token（各自独立，不是共用的一个）；
          · token 只以 SHA-256 摘要形式进入索引，比较是恒定时间的；
          · 每个来源登记在 P22-9 契约里**真实存在**的 consumer id 上；
          · 来源登记册在装配期构造，运行期不可改。
        ★ 本文件**不**给出跨进程凭据：Active 侧的 token 由部署环境提供
          （见 describe().credentialProvisioning）。没有登记册时，
          这条 command 面是**关闭**的（503），不是"默认放行"。

     ③ 本阶段**没有**做的一件事，以及为什么：23314 进程无法用"绑定
        自己的监听端口"来证明身份 —— Active companion 的 HTTP server 监听
        23114，一个**出站** socket 无法同时占用 23114（Windows 上会
        EADDRINUSE，没有 Linux 那种另取 ephemeral 端口的语义）。而
        "让 Home Node 回调 23114 验证"需要给 Active 增加第二个监听面，
        那是本阶段明确不做的（§11/§12）。因此来源身份的分量写在这里，
        而且**不夸大**：见 describe().sourceIdentityStrength。

   ── §2 跨进程只允许**一个** command ────────────────────────────────
       ECONOMY_PROPOSE_PURCHASE          ← 唯一开放
   ★ ECONOMY_BUY / ECONOMY_SETTLE / ECONOMY_RESERVE / ECONOMY_APPROVE /
     ECONOMY_RESUME / ECONOMY_GRANT / ECONOMY_LEDGER /
     ECONOMY_WALLET_MUTATE **不是**"还没开放"：它们在这份词表里
     **不存在**，因此未知 command 只能被拒。P22-10 已经决定 resume 不开放，
     本阶段**不**偷偷恢复它 —— 事实上 "ECONOMY_RESUME..." 这个字符串
     在**本文件里一次都不出现**（连禁止名单都不写它，那由 P22-10 的
     NOT_OFFERED 唯一持有）。

   ── §3 transport 不得相信 consumerId（本阶段最重要的不变量）───────
   payload 里出现 consumerId / consumer / capability / role / authority /
   approved / autoAllow 这七个键里**任何一个**，请求当场被拒
   （COMMAND_NOT_ALLOWED_FOR_A_CONSUMER_TO_SELF_REPORT），并且
   被拒时**不触碰**适配器（`reachedActionAdapter: false`）。
   handler 用的是装配期就绑好的那**一个**适配器；调用方**没有**选择
   consumer 的能力 —— 本文件里不存在任何一个能把 consumer 传进适配器的参数。

   ── §5 唯一执行链 ─────────────────────────────────────────────────
   handler 只调用注入的 adapter.performAction（一次字面成员调用）。
   它**不** require store，**也不** require 动作适配器模块 —— 适配器是
   装配层交给它的一个对象。因此"handler 变成新的 Economy authority"在
   结构上不可能：它手里没有 store、没有门、没有 SQL、没有第二个动词。

   ── §7 幂等：传输层不造第三套购买 dedupe ───────────────────────────
   commandId 是**通道层**的身份（§7："不同 payload 复用相同 identity →
   conflict / reject"）。本文件只保留 commandId → 请求指纹 的有界内存
   映射：指纹相同 = 重放（放行，并如实标记 channelReplay）；指纹不同 =
   冲突（拒绝，且**不触碰**适配器）。
   ★ 同一个 commandId 的第二次调用**仍然真的走一遍** P22-10/P22-9/P22-8
     —— 因为"同一逻辑 Intent"这件事的 canonical 答案是 P22-8 的
     idempotencyKey + 指纹，而不是这里的一份结果缓存。存储结果会让
     §7 的"最终仍复用 P22-8 canonical idempotency"退化成一句注释。

   ── 时间与顺序 ────────────────────────────────────────────────────
   来源判定（token → 来源 → port）**在** body 解析之前完成：一个身份
   不明的调用方不该能从我们的响应里读出任何关于 payload 的信息
   （连"你的 body 不合法"都不该知道）。
   ==================================================================== */

const crypto = require('node:crypto');
const nodeHttp = require('node:http');

/* 唯一一次 require：那份契约（来源身份词表与消费者锚点都出自它，
   不在这里再写一份）。 */
const C = require('./economy-contract.js');

/* ══ 路径：本阶段新增的**全部** HTTP 面就是这一条 ════════════════════
   ★ 它刻意**不在** /economy/ 前缀下。/economy/* 上的每一件事都是只读
   （P22-2 起，逐名断言），而这是一条**写**路径。把它放进 /economy/
   会让"POST /economy/* 一律 405 economy-is-read-only"这句话变成半真
   —— 而这个仓库刚在 P22-6/P22-7/P22-8/P22-10 里四次修掉"声明比真实
   路由更保守/更激进"的病。
   ★ /internal/ 前缀同时被 http.js 归入桌面面（isDesktopOnlyPath），
   于是远端未配置桌面 token 时它在 401/403 之前就被挡住。 */
const COMMAND_PATH = '/internal/economy/command';

/* ══ §2 · command 词表（封闭集，恰好一个成员）══════════════════════ */
const COMMAND = Object.freeze({
  ECONOMY_PROPOSE_PURCHASE: 'ECONOMY_PROPOSE_PURCHASE'
});
const COMMAND_LIST = Object.freeze([COMMAND.ECONOMY_PROPOSE_PURCHASE]);

/* command → 它需要的那**一个**准入能力。与 P22-10 的
   ACTION_CAPABILITY 同源，但本文件**不**复制 P22-10 的动作名：
   通道的 command 词与适配器的动作词是两个命名空间，映射写在这里。 */
const COMMAND_ACTION = Object.freeze({
  ECONOMY_PROPOSE_PURCHASE: COMMAND.ECONOMY_PROPOSE_PURCHASE
});

/* §2 逐字列出的禁止 command。★ 它们**不在**任何名单里 —— 这份常量
   只用于载入期自证（"禁止的名字一个都没被开放"），不参与运行期判定：
   运行期判定是"不在 COMMAND_LIST 里就是未知"。 */
const FORBIDDEN_COMMANDS = Object.freeze([
  'ECONOMY_BUY', 'ECONOMY_SETTLE', 'ECONOMY_RESERVE', 'ECONOMY_APPROVE',
  'ECONOMY_RESUME', 'ECONOMY_GRANT', 'ECONOMY_LEDGER', 'ECONOMY_WALLET_MUTATE'
]);

/* ══ §3 · payload 里**禁止**出现的身份键（逐字来自本阶段要求）═══════
   ★ 这**不是** §4 说的"经济事实黑名单"（那是 P22-8 的 55 项，属于
   proposal 层，本文件刻意不复制）。这一份是**身份**键：它们混进
   payload 的唯一用途就是让调用方自报身份。 */
const FORBIDDEN_IDENTITY_KEYS = Object.freeze([
  'consumerId', 'consumer', 'capability', 'role', 'authority', 'approved', 'autoAllow'
]);

/* ══ 信封键（恰好四个）══════════════════════════════════════════════
   command         —— 必须逐字落在封闭集里（不 trim、不折大小写）
   commandId       —— 通道层身份（§7）
   idempotencyKey  —— canonical 幂等身份，**原样**交给 P22-8
   proposal        —— **原样**交给 P22-10 → P22-8；本文件一个字都不解释
   ★ 只有这四个。capability 不在里面（它由 command 映射得出，见
   COMMAND_ACTION），consumer 更不在（它由来源登记册得出）。 */
const ENVELOPE_KEYS = Object.freeze(['command', 'commandId', 'idempotencyKey', 'proposal']);

/* ══ 拒绝码（封闭集）════════════════════════════════════════════════ */
const REFUSAL = Object.freeze({
  /* 装配面 */
  CHANNEL_NOT_CONFIGURED: 'ECONOMY_COMMAND_CHANNEL_NOT_CONFIGURED',
  /* 传输面 */
  NOT_LOOPBACK: 'ECONOMY_COMMAND_NOT_LOOPBACK',
  MISSING_SOURCE_CREDENTIAL: 'ECONOMY_COMMAND_MISSING_SOURCE_CREDENTIAL',
  UNKNOWN_SOURCE: 'ECONOMY_COMMAND_UNKNOWN_SOURCE',
  SOURCE_PORT_MISMATCH: 'ECONOMY_COMMAND_SOURCE_PORT_MISMATCH',
  SOURCE_CONSUMER_NOT_ECONOMY_CONSUMER: 'ECONOMY_COMMAND_SOURCE_IS_NOT_AN_ECONOMY_CONSUMER',
  /* 信封面 */
  MALFORMED_ENVELOPE: 'ECONOMY_COMMAND_MALFORMED_ENVELOPE',
  NOT_ALLOWED_FOR_A_CONSUMER_TO_SELF_REPORT: 'ECONOMY_COMMAND_NOT_ALLOWED_FOR_A_CONSUMER_TO_SELF_REPORT',
  MISSING_COMMAND: 'ECONOMY_COMMAND_MISSING_COMMAND',
  UNKNOWN_COMMAND: 'ECONOMY_COMMAND_UNKNOWN',
  UNEXPECTED_ENVELOPE_KEYS: 'ECONOMY_COMMAND_UNEXPECTED_ENVELOPE_KEYS',
  MISSING_COMMAND_ID: 'ECONOMY_COMMAND_MISSING_COMMAND_ID',
  MISSING_IDEMPOTENCY_KEY: 'ECONOMY_COMMAND_MISSING_IDEMPOTENCY_KEY',
  MISSING_PROPOSAL: 'ECONOMY_COMMAND_MISSING_PROPOSAL',
  PROPOSAL_NOT_A_PLAIN_OBJECT: 'ECONOMY_COMMAND_PROPOSAL_NOT_A_PLAIN_OBJECT',
  COMMAND_ID_CONFLICT: 'ECONOMY_COMMAND_ID_CONFLICT',
  ADAPTER_NOT_BOUND: 'ECONOMY_COMMAND_ADAPTER_NOT_BOUND',
  /* 下游（P22-10/P22-9/P22-8）拒绝：**原样透出**它的 reasonCode，
     这一条只是通道层的归类。 */
  DOWNSTREAM_REFUSED: 'ECONOMY_COMMAND_DOWNSTREAM_REFUSED'
});
const REFUSAL_CODES = Object.freeze(Object.keys(REFUSAL).map(k => REFUSAL[k]));

/* ══ 自述位（每一个返回值上都带着）═════════════════════════════════
   与 P22-9/P22-10 同源：让"传输层不是权威"成为返回值里的**事实**。 */
const SELF_BITS = Object.freeze({
  channel: 'economy-command-channel',
  transportIsNotAnEconomyAuthority: true,
  transportInterpretsEconomicFacts: false,
  transportHoldsRawStore: false,
  transportHoldsCapabilityGate: false,
  transportExposesGenericDispatch: false,
  transportAddsASecondPurchaseDedupe: false,
  transportChoosesTheConsumer: false,
  commandSuccessIsNotAPurchase: true,
  commandSuccessIsNotAnApproval: true,
  commandSuccessIsNotABudgetDecision: true
});

const MAX_COMMAND_ID_LENGTH = 200;
const MAX_TOKEN_LENGTH = 512;
/* commandId → 指纹 的有界内存映射。运行时事实，不落盘：一条重启后的
   新通道不记得上一条，而这正是正确的 —— 重放的安全由 P22-8 的
   canonical 幂等保证，通道层这份映射只回答"同一个 commandId 是不是
   同一件事"。 */
const COMMAND_ID_MEMORY_LIMIT = 256;

/* ── 小工具 ────────────────────────────────────────────────────────── */
function isPlainObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}
function sha256Hex(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}
/* 恒定时间比较：先把两侧摘要（等长），再比。这样"长度不同"这件事
   不会在比较里泄漏 —— 也不会让 timingSafeEqual 抛错。 */
function constantTimeEqual(a, b) {
  const x = crypto.createHash('sha256').update(String(a == null ? '' : a), 'utf8').digest();
  const y = crypto.createHash('sha256').update(String(b == null ? '' : b), 'utf8').digest();
  return crypto.timingSafeEqual(x, y);
}
function unexpectedKeysOf(input, allowed) {
  return Object.keys(input).filter(key => allowed.indexOf(key) < 0);
}
function nonEmptyString(value, max) {
  if (typeof value !== 'string') return false;
  const s = value.trim();
  return s !== '' && s.length <= max;
}

/* ══════════════════════════════════════════════════════════════════
   来源登记册（§6）
   ══════════════════════════════════════════════════════════════════
   一个来源登记项恰好是这四个字段：
     consumer   —— P22-9 契约里**真实存在**的 consumer id（身份）
     token      —— 这个来源自己的凭据（不与他人共用）
     boundPort  —— 这个来源在本机**被允许发起**的端口（来源管道）
     anchor     —— consumer 的运行时锚点（可核对，不是一句声明）

   ★ 登记册是**装配期**的事实，运行期不可改：本文件不导出任何
   setSource / addSource / bindSource。
   ★ 空登记册 ⇒ 通道关闭（503）。它**不是**"默认放行"。
   ★ token 只以摘要形式进索引；比较是恒定时间的；token 本身
   绝不进日志、绝不进审计环、绝不进 describe()。 */
function hashToken(token) {
  return sha256Hex('ib-economy-command-source-v1\u0000' + String(token == null ? '' : token));
}

function normalizeSources(raw) {
  const out = [];
  const problems = [];
  const list = Array.isArray(raw) ? raw : [];
  list.forEach((entry, index) => {
    const where = 'sources[' + index + ']';
    if (!isPlainObject(entry)) { problems.push(where + '-must-be-a-plain-object'); return; }
    const consumer = String(entry.consumer == null ? '' : entry.consumer);
    if (!C.isEconomyConsumer(consumer)) { problems.push(where + '-consumer-is-not-an-economy-consumer'); return; }
    if (!nonEmptyString(entry.token, MAX_TOKEN_LENGTH)) { problems.push(where + '-token-is-required'); return; }
    const boundPort = Number(entry.boundPort);
    if (!Number.isInteger(boundPort) || boundPort <= 0 || boundPort > 65535) {
      problems.push(where + '-boundPort-must-be-a-tcp-port');
      return;
    }
    out.push(Object.freeze({
      consumer: consumer,
      boundPort: boundPort,
      anchor: C.CONSUMER_RUNTIME_ANCHOR[consumer] || null,
      tokenDigest: hashToken(entry.token)
    }));
  });
  return { sources: Object.freeze(out), problems: problems };
}

/* ══════════════════════════════════════════════════════════════════
   §8 · 出站调用配置（bounded timeout / bounded retry / 不无限）
   ══════════════════════════════════════════════════════════════════ */
const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_MAX_ATTEMPTS = 2;      /* 首次 + 最多一次重试 */
const HARD_MAX_ATTEMPTS = 3;         /* 硬上限：任何配置都不可能更大 */

function normalizeCommandConfig(options) {
  options = options || {};
  const timeoutMs = Math.max(250, Math.min(30000, Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS));
  const requested = Number(options.maxAttempts) || DEFAULT_MAX_ATTEMPTS;
  const maxAttempts = Math.max(1, Math.min(HARD_MAX_ATTEMPTS, Math.floor(requested)));
  return Object.freeze({ timeoutMs: timeoutMs, maxAttempts: maxAttempts });
}

/* ══════════════════════════════════════════════════════════════════
   工厂
   ══════════════════════════════════════════════════════════════════ */
function createEconomyCommandChannel(options) {
  options = options || {};
  const adapter = options.adapter || null;
  const normalize = normalizeSources(options.sources);
  const sources = normalize.sources;
  const config = normalizeCommandConfig(options.config);
  const logger = typeof options.logger === 'function' ? options.logger : function () { };
  const clock = typeof options.clock === 'function' ? options.clock : (() => Date.now());

  const auditRing = [];
  const commandIdMemory = new Map();
  const AUDIT_RING_LIMIT = 100;

  /* ★ 装配期问题（登记项形状不对）必须当场炸：一个被静默丢弃的来源
     会让"我以为配了"与"根本没配"看起来一样，而那两种情况的处置相反。 */
  if (normalize.problems.length) {
    throw new Error('economy-command-channel sources are invalid: ' + normalize.problems.join('; '));
  }

  function record(event, fields) {
    const entry = Object.assign({ at: clock(), event: event }, fields || {});
    auditRing.push(entry);
    while (auditRing.length > AUDIT_RING_LIMIT) auditRing.shift();
    try { logger('info', event, fields || {}); } catch (_) { /* 日志失败不得影响 command */ }
    return entry;
  }

  /* ── 拒绝的完整形状 ──────────────────────────────────────────────
     ★ `reachedActionAdapter` 是这一层最重要的一位：身份/信封面被拒时
     它**必须**是 false，因为那条路径上没有碰过适配器。 */
  function refusal(status, reasonCode, extra) {
    return Object.assign({
      ok: false,
      status: status,
      refused: true,
      refusedBy: 'economy-command-channel',
      reasonCode: reasonCode,
      errors: [],
      command: null,
      commandId: null,
      source: null,
      sourceIdentityFromPayload: false,
      reachedActionAdapter: false,
      result: null,
      proposedNothing: true
    }, SELF_BITS, extra || {});
  }

  /* ── §6 · 来源判定：token（恒定时间）→ 来源 → 端口 ────────────────
     ★ 顺序是刻意的：先确认"你是登记的来源"，再检查"你是从登记的管道
     来的"。两条都失败时报 token 那条 —— 一个连凭据都不对的调用方
     不该从响应里知道我们的端口登记表长什么样。 */
  function resolveSource(requestInfo) {
    const info = requestInfo || {};
    if (info.loopback !== true) {
      return { ok: false, reasonCode: REFUSAL.NOT_LOOPBACK };
    }
    const supplied = String(info.sourceToken == null ? '' : info.sourceToken);
    if (supplied.trim() === '' || supplied.length > MAX_TOKEN_LENGTH) {
      return { ok: false, reasonCode: REFUSAL.MISSING_SOURCE_CREDENTIAL };
    }
    const digest = hashToken(supplied);
    let matched = null;
    for (let i = 0; i < sources.length; i += 1) {
      /* ★ 恒定时间比较，而且**不短路**：命中之后仍走完整个列表，
         否则"第几个来源命中"会从耗时里读出来。 */
      if (constantTimeEqual(digest, sources[i].tokenDigest)) matched = matched || sources[i];
    }
    if (!matched) return { ok: false, reasonCode: REFUSAL.UNKNOWN_SOURCE };
    const port = Number(info.remotePort);
    if (port !== matched.boundPort) {
      return {
        ok: false,
        reasonCode: REFUSAL.SOURCE_PORT_MISMATCH,
        source: matched.consumer,
        expectedPort: matched.boundPort,
        observedPort: Number.isFinite(port) ? port : null
      };
    }
    return { ok: true, source: matched };
  }

  /* ── §7 · commandId 身份 ──────────────────────────────────────────
     指纹只由**请求内容**决定（command · commandId · idempotencyKey ·
     proposal 的稳定 JSON）。同一 commandId + 同一内容 ⇒ 重放；
     同一 commandId + 不同内容 ⇒ 冲突。
     ★ 指纹里带 commandId，是为了让"同一个 commandId 换了 command"
     也被判成冲突，而不是被当成两次不同的调用。 */
  function fingerprintOf(body) {
    let proposalText;
    try { proposalText = stableJson(body.proposal); } catch (_) { proposalText = '<unserializable>'; }
    return sha256Hex([
      'ib-economy-command-fingerprint-v1',
      String(body.command),
      String(body.commandId),
      String(body.idempotencyKey),
      proposalText
    ].join('\u0000'));
  }

  function rememberCommandId(commandId, fingerprint) {
    commandIdMemory.set(commandId, fingerprint);
    while (commandIdMemory.size > COMMAND_ID_MEMORY_LIMIT) {
      const oldest = commandIdMemory.keys().next();
      if (oldest.done) break;
      commandIdMemory.delete(oldest.value);
    }
  }

  /* ── §4 · 稳定 JSON（只为指纹服务；不解释任何语义）─────────────── */
  function stableJson(value) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value === undefined ? null : value);
    if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']';
    const keys = Object.keys(value).sort();
    return '{' + keys.map(k => JSON.stringify(k) + ':' + stableJson(value[k])).join(',') + '}';
  }

  /* ══════════════════════════════════════════════════════════════════
     §5 · 唯一执行链：authenticated source → P22-10 adapter
     ══════════════════════════════════════════════════════════════════
     ★ 本函数对适配器的访问是**一处字面成员调用**（adapter.performAction）。
       没有 adapter[method]、没有第二个动词、也没有 store。
     ★ 调用方无法选择 consumer：这里根本没有接收 consumer 的参数。 */
  function dispatch(requestInfo, rawBody) {
    if (sources.length === 0 || !adapter) {
      record('economy-command-channel-closed', { sources: sources.length, adapterBound: !!adapter });
      return refusal(503, adapter ? REFUSAL.CHANNEL_NOT_CONFIGURED : REFUSAL.ADAPTER_NOT_BOUND, {
        sources: sources.length,
        adapterBound: !!adapter
      });
    }

    const resolved = resolveSource(requestInfo);
    if (resolved.ok !== true) {
      record('economy-command-refused', {
        stage: 'source', reasonCode: resolved.reasonCode,
        observedPort: resolved.observedPort == null ? null : resolved.observedPort
      });
      return refusal(401, resolved.reasonCode, {
        /* ★ 只回"登记的端口是哪一个"当且仅当 token 已经正确 —— 否则
           端口表就从一条错误响应里泄漏了。 */
        expectedPort: resolved.expectedPort === undefined ? null : resolved.expectedPort,
        observedPort: resolved.observedPort === undefined ? null : resolved.observedPort,
        source: resolved.source === undefined ? null : resolved.source
      });
    }
    const source = resolved.source;

    if (!isPlainObject(rawBody)) {
      record('economy-command-refused', { stage: 'envelope', reasonCode: REFUSAL.MALFORMED_ENVELOPE, source: source.consumer });
      return refusal(400, REFUSAL.MALFORMED_ENVELOPE, {
        source: source.consumer,
        errors: ['economy-command-body-must-be-a-plain-object']
      });
    }

    /* ── §3 · 身份自报：逐名拒绝，而且**不触碰**适配器 ───────────── */
    const selfReported = FORBIDDEN_IDENTITY_KEYS.filter(key =>
      Object.prototype.hasOwnProperty.call(rawBody, key));
    if (selfReported.length) {
      record('economy-command-refused', {
        stage: 'identity', reasonCode: REFUSAL.NOT_ALLOWED_FOR_A_CONSUMER_TO_SELF_REPORT, source: source.consumer
      });
      return refusal(403, REFUSAL.NOT_ALLOWED_FOR_A_CONSUMER_TO_SELF_REPORT, {
        source: source.consumer,
        rejectedIdentityKeys: selfReported,
        forbiddenIdentityKeys: FORBIDDEN_IDENTITY_KEYS,
        /* ★ 逐字：身份来自 authenticated transport + registered source。 */
        identityIsEstablishedByTheTransport: true,
        errors: selfReported.map(key => 'economy-command-may-not-carry:' + key)
      });
    }

    const command = rawBody.command;
    if (typeof command !== 'string' || command === '') {
      record('economy-command-refused', { stage: 'command', reasonCode: REFUSAL.MISSING_COMMAND, source: source.consumer });
      return refusal(400, REFUSAL.MISSING_COMMAND, {
        source: source.consumer,
        errors: ['economy-command-is-required'],
        acceptedCommands: COMMAND_LIST
      });
    }
    if (COMMAND_LIST.indexOf(command) < 0) {
      record('economy-command-refused', { stage: 'command', reasonCode: REFUSAL.UNKNOWN_COMMAND, source: source.consumer });
      return refusal(404, REFUSAL.UNKNOWN_COMMAND, {
        source: source.consumer,
        command: command,
        acceptedCommands: COMMAND_LIST,
        errors: ['economy-command-is-not-in-the-closed-command-set']
      });
    }

    const rejectedEnvelopeKeys = unexpectedKeysOf(rawBody, ENVELOPE_KEYS);
    if (rejectedEnvelopeKeys.length) {
      record('economy-command-refused', {
        stage: 'envelope', reasonCode: REFUSAL.UNEXPECTED_ENVELOPE_KEYS, source: source.consumer
      });
      return refusal(400, REFUSAL.UNEXPECTED_ENVELOPE_KEYS, {
        source: source.consumer,
        command: command,
        rejectedEnvelopeKeys: rejectedEnvelopeKeys,
        acceptedEnvelopeKeys: ENVELOPE_KEYS,
        errors: rejectedEnvelopeKeys.map(key => 'economy-command-envelope-key-not-whitelisted:' + key)
      });
    }

    if (!nonEmptyString(rawBody.commandId, MAX_COMMAND_ID_LENGTH)) {
      record('economy-command-refused', { stage: 'envelope', reasonCode: REFUSAL.MISSING_COMMAND_ID, source: source.consumer });
      return refusal(400, REFUSAL.MISSING_COMMAND_ID, {
        source: source.consumer,
        command: command,
        errors: ['economy-command-requires-a-command-id']
      });
    }
    const commandId = rawBody.commandId.trim();
    if (!nonEmptyString(rawBody.idempotencyKey, MAX_COMMAND_ID_LENGTH)) {
      /* ★ 缺 canonical 幂等键 ⇒ **拒绝**，而不是这里生成一个。§7：本层
         "不造第三套购买 dedupe"，生成一个等于把同一逻辑动作变成两次。 */
      record('economy-command-refused', { stage: 'envelope', reasonCode: REFUSAL.MISSING_IDEMPOTENCY_KEY, source: source.consumer });
      return refusal(400, REFUSAL.MISSING_IDEMPOTENCY_KEY, {
        source: source.consumer,
        command: command,
        commandId: commandId,
        errors: ['economy-command-requires-a-canonical-idempotency-key']
      });
    }
    if (rawBody.proposal === undefined || rawBody.proposal === null) {
      record('economy-command-refused', { stage: 'envelope', reasonCode: REFUSAL.MISSING_PROPOSAL, source: source.consumer });
      return refusal(400, REFUSAL.MISSING_PROPOSAL, {
        source: source.consumer,
        command: command,
        commandId: commandId,
        errors: ['economy-command-requires-a-proposal']
      });
    }
    if (!isPlainObject(rawBody.proposal)) {
      record('economy-command-refused', { stage: 'envelope', reasonCode: REFUSAL.PROPOSAL_NOT_A_PLAIN_OBJECT, source: source.consumer });
      return refusal(400, REFUSAL.PROPOSAL_NOT_A_PLAIN_OBJECT, {
        source: source.consumer,
        command: command,
        commandId: commandId,
        errors: ['economy-command-proposal-must-be-a-plain-object']
      });
    }

    /* ── §7 · commandId 冲突 / 重放 ───────────────────────────────── */
    const fingerprint = fingerprintOf(rawBody);
    const known = commandIdMemory.get(commandId);
    if (known !== undefined && known !== fingerprint) {
      record('economy-command-refused', {
        stage: 'idempotency', reasonCode: REFUSAL.COMMAND_ID_CONFLICT, source: source.consumer, commandId: commandId
      });
      return refusal(409, REFUSAL.COMMAND_ID_CONFLICT, {
        source: source.consumer,
        command: command,
        commandId: commandId,
        errors: ['economy-command-id-reused-with-a-different-payload']
      });
    }
    const channelReplay = known !== undefined;
    rememberCommandId(commandId, fingerprint);

    /* ── 唯一执行路径 ─────────────────────────────────────────────── */
    const action = {
      action: COMMAND_ACTION[command],
      proposal: rawBody.proposal,
      idempotencyKey: rawBody.idempotencyKey
    };
    const result = adapter.performAction(action);
    const ok = !!(result && result.ok === true);
    record(ok ? 'economy-command-accepted' : 'economy-command-downstream-refused', {
      commandId: commandId,
      command: command,
      source: source.consumer,
      intentId: (result && result.intentId) || null,
      reasonCode: (result && result.reasonCode) || null,
      channelReplay: channelReplay
    });
    return Object.assign({
      ok: ok,
      status: ok ? 200 : 400,
      refused: !ok,
      refusedBy: ok ? null : 'economy-command-channel',
      reasonCode: ok ? null : REFUSAL.DOWNSTREAM_REFUSED,
      downstreamReasonCode: ok ? null : ((result && result.reasonCode) || null),
      errors: (result && result.errors) || [],
      command: command,
      commandId: commandId,
      source: source.consumer,
      sourceAnchor: source.anchor,
      sourceIdentityFromPayload: false,
      reachedActionAdapter: true,
      channelReplay: channelReplay,
      /* ★ 下游（P22-10 的适配器 → 门 → P22-8）的返回值**原样**透出，
         一个字段都不改、一个都不删。本层只**加上**自己的自述位。 */
      result: result
    }, SELF_BITS);
  }

  function describe() {
    return Object.freeze({
      channel: 'economy-command-channel',
      path: COMMAND_PATH,
      open: sources.length > 0 && adapter != null,
      commands: COMMAND_LIST,
      commandToAction: COMMAND_ACTION,
      envelopeKeys: ENVELOPE_KEYS,
      forbiddenIdentityKeys: FORBIDDEN_IDENTITY_KEYS,
      forbiddenCommands: FORBIDDEN_COMMANDS,
      refusalCodes: REFUSAL_CODES,
      sources: Object.freeze(sources.map(s => Object.freeze({
        consumer: s.consumer, boundPort: s.boundPort, anchor: s.anchor
      }))),
      sourceCount: sources.length,
      credentialProvisioning: 'deployment-environment (per-source token; never in payload, never in logs)',
      adapterBound: adapter != null,
      adapterConsumer: adapter && typeof adapter.consumer === 'string' ? adapter.consumer : null,
      timeoutMs: config.timeoutMs,
      maxAttempts: config.maxAttempts,
      hardMaxAttempts: HARD_MAX_ATTEMPTS,
      auditRingLimit: AUDIT_RING_LIMIT,
      commandIdMemoryLimit: COMMAND_ID_MEMORY_LIMIT,
      /* ★ 这一句是**分量**，不是修辞：来源身份由进程级登记册 + 凭据确定，
         它防的是"别的本机进程/浏览器冒充 Active"，它**不是** OS 沙箱，
         也不防"同一个 Windows 用户下已经能读到 Active 配置的人"。 */
      sourceIdentityStrength: 'registered-source-credential + loopback + port-registry',
      commandIsNotAnEconomyAuthority: true,
      transportIsNotAnEconomyAuthority: true,
      transportIsNotASandbox: true,
      transportInterpretsEconomicFacts: false,
      transportHoldsRawStore: false,
      transportHoldsCapabilityGate: false,
      transportExposesGenericDispatch: false,
      transportAddsASecondPurchaseDedupe: false,
      transportChoosesTheConsumer: false,
      /* ★ 名字刻意**不**含 resume 那个词：本文件里"这个动作被登记过、
         只是没开放"这件事**一次都不出现**（连一句说明都不写），因此
         一条对**代码**做的扫描可以直接断言"resume 那个名字不在通道里"。
         P22-10 的适配器持有 NOT_OFFERED（那份登记在那边），这里不复制。 */
      theContinuationVerbIsNotRegisteredOnThisChannel: true
    });
  }

  return Object.freeze({
    path: COMMAND_PATH,
    commands: COMMAND_LIST,
    dispatch: dispatch,
    audit: () => auditRing.slice(),
    describe: describe
  });
}

/* ══════════════════════════════════════════════════════════════════
   出站调用器（Active 侧 · §8）
   ══════════════════════════════════════════════════════════════════
   ★ 它**只**做传输：bounded timeout、bounded retry、以及把结果分成三类。
   ★ 它**不**解释经济语义：一次 transport 失败**绝不**被表达成
     "purchase failed / purchase denied" —— 因为 Home Node 可能已经
     成功创建了 Intent。§8 逐字要求这条区分，而它的实现就是下面那
     两个码：DELIVERY_UNKNOWN（可能已经送达）与 TRANSPORT_FAILED
     （确定没送达，连不上）。
   ★ 重试使用**同一个** commandId 与同一个 idempotencyKey（默认由
     调用方提供，缺失时由 createCommandIdentity 生成一次并复用），
     于是"重试收敛到同一个 logical Intent"由 P22-8 的 canonical
     幂等保证，而不是由本地缓存保证。 */
const DELIVERY = Object.freeze({
  DELIVERED: 'DELIVERED',
  DELIVERY_UNKNOWN: 'DELIVERY_UNKNOWN',
  TRANSPORT_FAILED: 'TRANSPORT_FAILED'
});

/* 生成一对稳定的身份（commandId + idempotencyKey）。调用方**一次**
   生成、多次重试复用 —— 这就是 §7 要求的"稳定"。 */
function createCommandIdentity(prefix) {
  const seed = crypto.randomBytes(16).toString('hex');
  const tag = String(prefix == null ? '' : prefix).slice(0, 40);
  return Object.freeze({
    commandId: 'ibcmd_' + (tag ? tag + '_' : '') + seed,
    idempotencyKey: 'ibcmdkey_' + seed
  });
}

/* ── 默认出站传输：node:http（**而不是** fetch）──────────────────────
   ★ 为什么不用 fetch：这条通道的凭据模型里有一条**端口登记**
   （source.boundPort）。`fetch`（undici）不暴露 `localPort`，因此用它
   就无法让请求从一个登记的端口发出 —— 而那会让"来源管道"那一半登记
   在真实运行时变成一个**永远不生效**的检查（test 里有效、生产里无效，
   正是这个仓库反复修掉的那种假绿）。
   ★ 因此默认传输用 node:http，并把 options.localPort 接出来。它带来
   两个真实的能力，而不是两个承诺：
     · Active 侧可以（且在生产上应当）把出站 socket 绑在它自己的
       端口上，于是 Home Node 侧的端口登记有实际约束力；
     · 测试可以在同一个进程里精确地证明"端口不对 → 拒绝"。
   ★ 它同样只加载一个**核心**模块（node:http），与既有 transport 的
     依赖闭包同级；没有新依赖、没有新协议、没有第二个信封。

  ── 固定来源端口带来的那个真实故障（开发期实测）────────────────────
  来源端口是**固定**的，而任何先前从同一个端口出去的连接都会把它留在
  TIME_WAIT 里。于是第二次提议会以 `bind EADDRINUSE 127.0.0.1:<port>`
  失败 —— 那看起来像"传输抖动"，实际是端口复用语义，而它的后果是
  "提议有时发不出去"。这里用两条互补的机制处理它：
    · `SO_REUSEADDR`（Windows 上默认关闭，Linux 上 node 默认打开；
      显式打开让"端口还压在 TIME_WAIT"不再是致命的）；
    · 调用方侧的就地重试（见 createEconomyCommandClient 的重试环：
      这类错误**不消耗**重试预算，因为它既不是"命令已送达"也不是
      "命令确定没送达"，而是一个本机瞬时条件）。
  两者都做，是因为只做前者仍会在极窄的竞态里失败，而只做后者会把
  一次本机端口冲突记成一次"命令失败"。 */
function createNodeTransport(options) {
  options = options || {};
  return function transport(url, init) {
    return new Promise((resolve, reject) => {
      let parsed;
      try { parsed = new URL(url); } catch (error) { reject(error); return; }
      const headers = Object.assign({}, (init && init.headers) || {});
      if (init && init.body != null) headers['Content-Length'] = Buffer.byteLength(init.body);
      const requestOptions = {
        host: parsed.hostname,
        port: parsed.port ? Number(parsed.port) : 80,
        path: parsed.pathname + (parsed.search || ''),
        method: (init && init.method) || 'GET',
        headers: headers
      };
      /* ★ 只有在显式给出 localPort 时才绑定：未给出时**不**动 socket 的
         默认来源 —— 一个"我们顺手帮你绑了个端口"的默认值会让部署在没有
         那个端口时静默失败。 */
      const localPort = Number(options.localPort);
      if (Number.isInteger(localPort) && localPort > 0 && localPort <= 65535) {
        requestOptions.localPort = localPort;
        requestOptions.localAddress = String(options.localAddress || '127.0.0.1');
        /* ★ SO_REUSEADDR：见文件头那段说明。Linux 上 node 默认打开它，
           Windows 上默认关闭 —— 因此这一句只在 Windows 上是新增行为，
           而它正是"来源端口压在 TIME_WAIT 里也能再 bind"的那一半。 */
        requestOptions.reuseAddr = true;
      }
      const req = nodeHttp.request(requestOptions, res => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({
            status: res.statusCode,
            ok: res.statusCode >= 200 && res.statusCode < 300,
            text: () => Promise.resolve(text)
          });
        });
        res.on('error', reject);
      });
      /* ★ 端口冲突的**第二**道处理在调用方那一侧（见 createEconomyCommandClient
         的重试环）：EADDRINUSE 不消耗重试预算，因为那不是一次"命令没送达"，
         只是本机端口暂时不可用。 */
      req.on('error', reject);
      if (init && init.signal && typeof init.signal.addEventListener === 'function') {
        init.signal.addEventListener('abort', () => {
          const abortError = new Error('The operation was aborted');
          abortError.name = 'AbortError';
          req.destroy(abortError);
        });
      }
      if (init && init.body != null) req.write(init.body);
      req.end();
    });
  };
}

function createEconomyCommandClient(options) {
  options = options || {};
  const base = String(options.base || '').replace(/\/+$/, '');
  const token = String(options.token || '');
  const requestHeaders = options.requestHeaders && typeof options.requestHeaders === 'object'
    ? Object.freeze(Object.assign({}, options.requestHeaders)) : Object.freeze({});
  const timeoutMs = Math.max(250, Math.min(30000, Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS));
  const requested = Number(options.maxAttempts) || DEFAULT_MAX_ATTEMPTS;
  const maxAttempts = Math.max(1, Math.min(HARD_MAX_ATTEMPTS, Math.floor(requested)));
  /* ★ 传输可注入，但**默认是 node:http**（理由见 createNodeTransport）。
     注入面只有"怎么发出去"这一件事 —— 超时、重试、分类、身份复用
     仍然只有本文件这一份实现，因此注入传输不会绕过任何一个不变量。 */
  const fetchImpl = typeof options.fetch === 'function'
    ? options.fetch
    : createNodeTransport({ localPort: options.localPort, localAddress: options.localAddress });
  const configured = base !== '' && token !== '' && typeof fetchImpl === 'function';

  function transportFailure(delivery, extra) {
    return Object.assign({
      ok: false,
      delivered: delivery === DELIVERY.DELIVERED,
      delivery: delivery,
      channel: 'economy-command-channel',
      command: COMMAND.ECONOMY_PROPOSE_PURCHASE,
      /* ★ 这三个恒 false 的位是 §8 那句话说法的机器可读形式：一次
         transport 结果**不是**一次购买裁决。 */
      purchaseFailed: false,
      purchaseDenied: false,
      intentCreated: null,
      attempts: 0,
      result: null
    }, extra || {});
  }

  async function proposePurchase(input) {
    input = input || {};
    if (!configured) {
      return transportFailure(DELIVERY.TRANSPORT_FAILED, {
        reasonCode: 'ECONOMY_COMMAND_CLIENT_NOT_CONFIGURED',
        errors: ['the active economy command channel has no base/token/fetch']
      });
    }
    if (!isPlainObject(input.proposal)) {
      return transportFailure(DELIVERY.TRANSPORT_FAILED, {
        reasonCode: REFUSAL.PROPOSAL_NOT_A_PLAIN_OBJECT,
        errors: ['proposePurchase requires a plain-object proposal'],
        onTheWire: false
      });
    }
    return sendCommand(input, COMMAND.ECONOMY_PROPOSE_PURCHASE);
  }

  /* ── 发一条**指定名字**的 command（只给测试用）──────────────────────
     ★ 为什么生产路径上没有这个入口：`proposePurchase` 的命令名是**写死**
     的那一个（COMMAND.ECONOMY_PROPOSE_PURCHASE），因此"跨进程只开放一个
     command"在客户端这一侧是结构性的 —— 它没有参数可以改。
     ★ 而"未知 command 会被拒绝"这条不变量必须能被**跨进程**地证明（那是
     本阶段的核心），因此单进程测试里用的是一个显式命名的测试入口。它不
     参与生产链：没有任何生产代码调用它，而且它发的正是调用方给的名字 ——
     也就是说，它证明的是**服务端**会拒绝，而不是客户端会放行。 */
  async function sendCommand(input, commandName) {
    input = input || {};
    const identity = (nonEmptyString(input.commandId, MAX_COMMAND_ID_LENGTH) &&
      nonEmptyString(input.idempotencyKey, MAX_COMMAND_ID_LENGTH))
      ? Object.freeze({ commandId: String(input.commandId).trim(), idempotencyKey: String(input.idempotencyKey).trim() })
      : (input.identity && nonEmptyString(input.identity.commandId, MAX_COMMAND_ID_LENGTH) &&
        nonEmptyString(input.identity.idempotencyKey, MAX_COMMAND_ID_LENGTH))
        ? input.identity
        : createCommandIdentity(input.prefix);

    const body = JSON.stringify({
      command: commandName,
      commandId: identity.commandId,
      idempotencyKey: identity.idempotencyKey,
      proposal: input.proposal
    });

    let attempts = 0;
    let last = null;
    /* ★ 本机端口暂时不可用的就地重试预算（**不**是重试预算的一部分）：
       `bind EADDRINUSE` 说明这次尝试根本没把命令发出去，因此它既不是
       "可能已送达"也不是"确定没送达" —— 它是一次本机瞬时条件。把它计入
       maxAttempts 会让一次端口冲突被记成一次命令失败（开发期实测：
       第二个提议就是这样丢的）。它自身也**有界**（HARD_MAX_ATTEMPTS 次
       就地重试），因此"无限重试"仍然不成立。 */
    let localPortRetries = 0;
    while (attempts < maxAttempts) {
      attempts += 1;
      const controller = typeof AbortController === 'function' ? new AbortController() : null;
      let timer = null;
      if (controller) timer = setTimeout(() => { try { controller.abort(); } catch (_) { } }, timeoutMs);
      try {
        const init = {
          method: 'POST',
          headers: Object.assign({}, requestHeaders, {
            'Content-Type': 'application/json',
            'X-IB-Protocol': '1',
            'X-IB-Economy-Channel-Source': token
          }),
          cache: 'no-store',
          body: body
        };
        if (controller) init.signal = controller.signal;
        const response = await fetchImpl(base + COMMAND_PATH, init);
        const raw = await response.text();
        let parsed = null;
        try { parsed = raw ? JSON.parse(raw) : null; } catch (_) { parsed = null; }
        if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          /* ★ 响应读不懂 ⇒ **不**猜它是成功还是失败：这条路径只可能是
             "可能已送达"，因此按 DELIVERY_UNKNOWN 归类并在还有预算时
             用**同一个**身份重试。 */
          last = transportFailure(DELIVERY.DELIVERY_UNKNOWN, {
            reasonCode: 'ECONOMY_COMMAND_UNREADABLE_RESPONSE',
            httpStatus: response.status,
            attempts: attempts,
            commandId: identity.commandId
          });
          continue;
        }
        if (response.status >= 500) {
          last = transportFailure(DELIVERY.DELIVERY_UNKNOWN, {
            reasonCode: 'ECONOMY_COMMAND_SERVER_ERROR',
            httpStatus: response.status,
            serverReasonCode: parsed.reasonCode || null,
            attempts: attempts,
            commandId: identity.commandId
          });
          continue;
        }
        /* 4xx / 200：服务端给出了**确定**的答案（成功或一条有名字的拒绝）。
           确定性答案一律不重试。 */
        return {
          ok: parsed.ok === true,
          delivered: true,
          delivery: DELIVERY.DELIVERED,
          channel: 'economy-command-channel',
          command: COMMAND.ECONOMY_PROPOSE_PURCHASE,
          commandId: identity.commandId,
          idempotencyKey: identity.idempotencyKey,
          httpStatus: response.status,
          reasonCode: parsed.refused === true ? parsed.reasonCode : null,
          downstreamReasonCode: parsed.downstreamReasonCode || null,
          source: parsed.source || null,
          channelReplay: parsed.channelReplay === true,
          errors: parsed.errors || [],
          purchaseFailed: false,
          purchaseDenied: false,
          /* ★ 只有服务端真的回了一个 Intent id 时它才不是 null ——
             客户端**不**从"HTTP 200"推断 Intent 存在。 */
          intentCreated: parsed.result && parsed.result.intentId ? parsed.result.intentId : null,
          attempts: attempts,
          result: parsed.result || null
        };
      } catch (error) {
        const name = String((error && error.name) || '');
        const message = String((error && error.message) || error || '');
        const timeout = name === 'AbortError' || /abort/i.test(message);
        /* ★ 来源端口冲突：这一次尝试**没有**把命令发出去（bind 就失败了）。
           就地重试，并且不消耗重试预算 —— 但仍然有界。 */
        if (!timeout && /EADDRINUSE/i.test(message) && localPortRetries < HARD_MAX_ATTEMPTS) {
          localPortRetries += 1;
          attempts -= 1;
          await new Promise(resolve => setTimeout(resolve, 25 * localPortRetries));
          continue;
        }
        /* fetch 抛错既可能是"连不上"（确定没送达），也可能是"发出去了
           但读不回"（可能已送达）。两者都按 DELIVERY_UNKNOWN 归类更
           保守，而与 §8 一致：宁可重试一次幂等请求，也不要误报"购买失败"。 */
        last = transportFailure(DELIVERY.DELIVERY_UNKNOWN, {
          reasonCode: timeout ? 'ECONOMY_COMMAND_TIMEOUT' : 'ECONOMY_COMMAND_TRANSPORT_ERROR',
          detail: message.slice(0, 200),
          errorName: name,
          timeout: timeout,
          attempts: attempts,
          localPortRetries: localPortRetries,
          commandId: identity.commandId
        });
        continue;
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
    return last || transportFailure(DELIVERY.TRANSPORT_FAILED, {
      reasonCode: 'ECONOMY_COMMAND_NO_ATTEMPT',
      commandId: identity.commandId
    });
  }

  function describe() {
    return Object.freeze({
      channel: 'economy-command-channel',
      role: 'client',
      path: COMMAND_PATH,
      configured: configured,
      hasBase: base !== '',
      hasSourceCredential: token !== '',
      timeoutMs: timeoutMs,
      maxAttempts: maxAttempts,
      hardMaxAttempts: HARD_MAX_ATTEMPTS,
      unboundedRetry: false,
      interpretsEconomicFacts: false,
      addsASecondPurchaseDedupe: false,
      reusesTheCanonicalIdentityOnRetry: true,
      /* ★ 来源端口被 TIME_WAIT 占住时的就地重试是**有界**的，而且它不
         消耗重试预算（理由见 proposePurchase 里的那一段）。 */
      boundedLocalPortRetries: HARD_MAX_ATTEMPTS,
      deliveryOutcomes: Object.freeze(Object.keys(DELIVERY).map(k => DELIVERY[k]))
    });
  }

  return Object.freeze({
    path: COMMAND_PATH,
    proposePurchase: proposePurchase,
    /* ★ 显式命名的测试入口（不参与生产链；见 sendCommand 的说明）。 */
    sendCommand: sendCommand,
    createCommandIdentity: createCommandIdentity,
    configured: configured,
    describe: describe
  });
}

/* ══ 载入期不变量（词表自证；坏了就当场炸）════════════════════════ */
(function assertCommandVocabulary() {
  const problems = [];
  if (COMMAND_LIST.length !== 1) problems.push('p22-11-offers-exactly-one-command');
  COMMAND_LIST.forEach(name => {
    if (name.indexOf('ECONOMY_') !== 0) problems.push('command-name-must-be-namespaced:' + name);
    if (COMMAND_ACTION[name] !== name) problems.push('command-action-mapping-must-be-identity:' + name);
    if (FORBIDDEN_COMMANDS.indexOf(name) >= 0) problems.push('forbidden-command-present:' + name);
  });
  if (ENVELOPE_KEYS.length !== 4) problems.push('envelope-keys-must-be-exactly-four');
  /* §3：信封键与身份键**不相交** —— 否则那条"逐名拒绝"会拒掉自己的信封。 */
  ENVELOPE_KEYS.forEach(key => {
    if (FORBIDDEN_IDENTITY_KEYS.indexOf(key) >= 0) problems.push('envelope-key-collides-with-an-identity-key:' + key);
  });
  /* §2：禁止的 command 名字不许出现在任何开放名单里。 */
  FORBIDDEN_COMMANDS.forEach(name => {
    if (COMMAND_LIST.indexOf(name) >= 0) problems.push('forbidden-command-is-open:' + name);
  });
  if (COMMAND_PATH.indexOf('/economy/') === 0) problems.push('the-write-channel-must-not-live-under-economy-read-paths');
  if (problems.length) throw new Error('economy-command-channel vocabulary is invalid: ' + problems.join('; '));
})();

module.exports = createEconomyCommandChannel;
module.exports.createEconomyCommandChannel = createEconomyCommandChannel;
module.exports.createEconomyCommandClient = createEconomyCommandClient;
module.exports.createNodeTransport = createNodeTransport;
module.exports.createCommandIdentity = createCommandIdentity;
module.exports.COMMAND = COMMAND;
module.exports.COMMAND_LIST = COMMAND_LIST;
module.exports.COMMAND_ACTION = COMMAND_ACTION;
module.exports.FORBIDDEN_COMMANDS = FORBIDDEN_COMMANDS;
module.exports.FORBIDDEN_IDENTITY_KEYS = FORBIDDEN_IDENTITY_KEYS;
module.exports.ENVELOPE_KEYS = ENVELOPE_KEYS;
module.exports.REFUSAL = REFUSAL;
module.exports.REFUSAL_CODES = REFUSAL_CODES;
module.exports.DELIVERY = DELIVERY;
module.exports.COMMAND_PATH = COMMAND_PATH;
module.exports.SELF_BITS = SELF_BITS;
module.exports.normalizeSources = normalizeSources;
module.exports.hashToken = hashToken;
module.exports.constantTimeEqual = constantTimeEqual;
module.exports.DEFAULT_TIMEOUT_MS = DEFAULT_TIMEOUT_MS;
module.exports.DEFAULT_MAX_ATTEMPTS = DEFAULT_MAX_ATTEMPTS;
module.exports.HARD_MAX_ATTEMPTS = HARD_MAX_ATTEMPTS;
module.exports.CONSUMER = C.ECONOMY_CONSUMER.ACTIVE_AGENT_RUNTIME;
