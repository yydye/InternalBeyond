'use strict';
/* ====================================================================
   IB Home Node · Economy Approval Decision Seam（P22-13 · 用户决定的唯一生产入口）
   --------------------------------------------------------------------
        authenticated desktop user（浏览器 UI / 桌面诊断面）
                          ↓  POST /internal/economy/approval-decision
                Approval Decision Seam                ← 本文件
                          ↓
              P22-7 store.decideApproval（点头 / 摇头）
                          ↓
              P22-9 bound capability handle（consumer = user_decision_seam）
                          ↓
              P22-8 resumeAgentPurchaseIntent（**只有** APPROVE 才走）
                          ↓
                     P22-6 → P22-3（既有权威链）

   ── §1 只读审计：这个仓库里已经有的 seam，以及缺的到底是哪一段 ──────
   审计结论（全部来自读代码，没有一条来自提示词假设）：

     ① **已经有一份可复用的 transport**，而且它就是 P22-11 已经用过的那
        一条：Home Node 的 HTTP seam（services/home-node/http.js）。它已经
        具备本阶段需要的每一条：
          · loopback 限制（isLoopback；非 loopback 来源整片拒绝）；
          · 桌面凭据（X-IB-Home-Token / Bearer / ?token，恒定时间比较）；
          · `/internal/` 前缀已被归入**桌面面**（isDesktopOnlyPath），因此
            远端未配置桌面 token 时它在通道判定之前就被 403；
          · 请求信封与错误信封（ok / error / reasonCode）；
          · 有界 body（readBody + MAX_BODY_BYTES）。
        ⇒ 本文件**不新造第二套 transport，也不新造通用 Admin RPC /
          Action framework**（§1 逐字禁止）。它只在这条既有 transport 上
          增加**一条窄路径**：三个白名单键、两个决定词、一条既有执行链。

     ② **缺的**不是"能不能表达一次点头"，而是**可达性**：P22-12C 的审计
        （docs/P22-12C-ECONOMY-INTEGRATION-CLOSURE.md §10.2 B1）逐字证明
        `decideApproval` / `resumeAgentPurchaseIntent` /
        `resumeApprovedPurchase` 三者在**生产代码里**的调用方都是 0，HTTP
        写面是 0，跨进程 command 面也是 0。于是默认部署
        （AUTONOMY_DEFAULT_WHEN_NO_POLICY = REQUIRE_APPROVAL）下，每一条
        Agent Intent 都停在 WAITING_APPROVAL 且**没有任何生产路径**能把它
        推到终态。本文件补的就是这一段。

     ③ **身份必须分离**（§2）：Agent 是 proposer，用户是 approval
        authority。本文件不"校验"这件事，而是让它**没有那个输入位**：
          · decidedBy **不是一个参数** —— 它在这段代码里是一个字面量
            ({ type: 'user', id: 'user' })，而 payload 里出现任何身份键
            （decidedBy / consumer / consumerId / capability / approved /
            autoAllow / authority / role / userId）都被**逐名拒绝**；
          · 决定只能落在两个词上（APPROVE / REJECT），没有第三个；
          · APPROVE 的续做**不**由本文件做经济判断：它只是把同一条 intent
            交回 P22-8 的恢复路径，而那条路径自己会重新过预算 / 报价 /
            商品三道权威（§8：Approval ≠ guaranteed purchase）。

   ── §4 APPROVE 为什么**不能**直接 settle ─────────────────────────────
   本文件里**没有** store 这个对象。它拿到的是一份从 P22-9 门里 bind 出来
   的句柄，而那个句柄的键恰好是五个（consumer / anchor / capabilities /
   proposePurchaseIntent / resumeApprovedPurchase）—— settle / prepare /
   reserve / commit / grant / decideApproval 一个都不在上面。
   因此"批准 → settlePurchase()"在这段代码里不是"不推荐"，而是**写不出来**：
   本文件连 store 的名字都没有，也没有任何 `store[...]` 形式的分派。
   ★ 唯一一处 store 调用是本文件第一行真正执行的那次
     `store.decideApproval(...)`（**唯一**的 store 触碰点），它由装配层
     注入；见下面 deps 的说明与 §11 的自述位。

   ── §6 为什么本文件**不**再造一套 Approval 状态机 ────────────────────
   状态、single-use、过期、终态不可复活全部由 P22-7 持有（
   assertApprovalTransition / consumeApprovalForPurchaseInTx / expires_at
   写锁内复查）。本文件一个状态都不判断、一个 status 都不写 —— 它把
   decision 原样交给 decideApproval，并把它的答案原样透出。

   ── §7 幂等：两个身份，一层一个 ──────────────────────────────────────
     · `idempotencyKey`（请求给）—— 用户这一次"决定"的逻辑身份。它进
       P22-7 的 APPROVAL_DECIDE scope。重放 ⇒ 同一个结果；
       同一个 key 先 APPROVE 再 REJECT ⇒ **冲突**（store 的指纹包含
       decision，因此这是 store 层判定的，不是这里"记得"的）。
     · 续做那一步用**派生**出来的 key（'decision-resume:' + key，见
       resumeKeyOf）—— 它进 P22-8 的 AGENT_INTENT_EXECUTE scope。
       ★ 为什么派生而不是复用：那是两次 canonical mutation，各自有自己的
       scope；把同一个值同时当两个 scope 的 key，会让"这个 key 代表什么"
       在一个可被 DBA 读到的列里变成两个答案。
     · 一个**进程内**的 requestId 记忆（有界 256）只为回答"同一个请求
       身份换了决定词吗"，而这一条 store 的指纹也会回答 —— 两者同向，
       且都不缓存结果（§7：本层不造第三套购买 dedupe）。

   ── 时间与顺序 ──────────────────────────────────────────────────────
   凭据判定**在** body 解析之前完成（与 P22-11 逐字同源）：一个身份不明的
   调用方不该能从我们的响应里学到任何关于 payload 的事。
   ==================================================================== */

const crypto = require('node:crypto');

/* 唯一一次 require：那份契约（决定词、当事人词表、幂等键规范化全部出自它，
   不在这里再写一份）。 */
const C = require('./economy-contract.js');

/* ══ 路径：本阶段新增的**全部** HTTP 面就是这一条 ═════════════════════
   ★ 它刻意**不在** /economy/ 前缀下 —— 原因与 P22-11 的 command 路径逐字
   相同：/economy/* 上的每一件事都是只读（P22-2 起逐名断言），而这是一条
   **写**路径。把它放进 /economy/ 会让"POST /economy/* 一律 405
   economy-is-read-only"这句话变成半真。
   ★ 它**不是** /internal/economy/command。一条代表 Agent WANT
   （ECONOMY_PROPOSE_PURCHASE），一条代表 User APPROVAL DECISION；
   两条路径各有自己的准入、自己的身份、自己的凭据要求，而它们
   **不共用 consumer**（见 describe().differsFromTheCommandChannel）。 */
const DECISION_PATH = '/internal/economy/approval-decision';

/* ══ §3 · 决定词表（封闭集，恰好两个）═══════════════════════════════
   ★ 这里**没有** BUY / SETTLE / RESERVE / GRANT / REFUND / LEDGER /
   AUTO_ALLOW / FORCE_APPROVE，而且它们不是"被过滤掉的"：它们在这份词表里
   不存在，因此只能落到 UNKNOWN_DECISION。P22-7 的状态机词
   （APPROVAL_STATE.APPROVED / REJECTED）是唯一的真源 —— 本文件不复制它们，
   而是**逐字引用**。 */
const DECISION = Object.freeze({
  APPROVE: C.APPROVAL_STATE.APPROVED,
  REJECT: C.APPROVAL_STATE.REJECTED
});
const DECISION_LIST = Object.freeze([DECISION.APPROVE, DECISION.REJECT]);

/* 请求方可以用的**同义**输入词 → canonical 决定词。
   ★ 为什么需要它：UI 与人类说的是 "APPROVE" / "approve"，而状态机说的是
   "APPROVED"。允许一次显式的、封闭的映射，比让每个调用方各自决定
   "我该写哪个词"要好 —— 但那必须是一个**没有歧义**的映射：
   多一个词就是一个新决定，因此这里恰好四个键。 */
const DECISION_ALIASES = Object.freeze({
  APPROVE: DECISION.APPROVE,
  APPROVED: DECISION.APPROVE,
  REJECT: DECISION.REJECT,
  REJECTED: DECISION.REJECT
});

/* ══ §3 · 信封（恰好三个键）═════════════════════════════════════════
   approvalId      —— 用户决定的那一条批准（canonical id）
   decision        —— APPROVE / REJECT（上面的封闭集）
   idempotencyKey  —— 这一次决定的 canonical 幂等身份
   ★ 只有这三个。价格 / 金额 / 币种 / 预算 / 钱包 / 商品事实 / 结算方式 /
   发放数量 / consumerId / capability **都不在**这封信封里，因此它们连
   "被忽略"的机会都没有 —— 出现即拒（UNEXPECTED_ENVELOPE_KEYS）。 */
const ENVELOPE_KEYS = Object.freeze(['approvalId', 'decision', 'idempotencyKey']);

/* ══ §2 · payload 里**禁止**出现的身份键（逐字来自本阶段要求）═══════
   Agent 不得自报身份，用户身份也不得由调用方填写：它由装配层注入的
   decider 唯一决定（见 createEconomyApprovalDecisionSeam 的 decider）。 */
const FORBIDDEN_IDENTITY_KEYS = Object.freeze([
  'decidedBy', 'decidedById', 'by', 'decider',
  'consumer', 'consumerId', 'capability', 'role', 'authority',
  'approved', 'autoAllow', 'userId', 'user', 'agentId', 'party'
]);

/* ══ 拒绝码（封闭集）════════════════════════════════════════════════ */
const REFUSAL = Object.freeze({
  /* 装配面 */
  SEAM_NOT_CONFIGURED: 'ECONOMY_APPROVAL_DECISION_NOT_CONFIGURED',
  CREDENTIAL_NOT_CONFIGURED: 'ECONOMY_APPROVAL_DECISION_DESKTOP_TOKEN_NOT_CONFIGURED',
  /* 传输面 */
  NOT_LOOPBACK: 'ECONOMY_APPROVAL_DECISION_NOT_LOOPBACK',
  MISSING_USER_CREDENTIAL: 'ECONOMY_APPROVAL_DECISION_MISSING_DESKTOP_CREDENTIAL',
  WRONG_USER_CREDENTIAL: 'ECONOMY_APPROVAL_DECISION_WRONG_DESKTOP_CREDENTIAL',
  /* 信封面 */
  MALFORMED_ENVELOPE: 'ECONOMY_APPROVAL_DECISION_MALFORMED_ENVELOPE',
  NOT_ALLOWED_FOR_A_CALLER_TO_SELF_REPORT: 'ECONOMY_APPROVAL_DECISION_NOT_ALLOWED_FOR_A_CALLER_TO_SELF_REPORT',
  MISSING_APPROVAL_ID: 'ECONOMY_APPROVAL_DECISION_MISSING_APPROVAL_ID',
  APPROVAL_ID_NOT_CANONICAL: 'ECONOMY_APPROVAL_DECISION_APPROVAL_ID_NOT_CANONICAL',
  UNEXPECTED_ENVELOPE_KEYS: 'ECONOMY_APPROVAL_DECISION_UNEXPECTED_ENVELOPE_KEYS',
  MISSING_DECISION: 'ECONOMY_APPROVAL_DECISION_MISSING_DECISION',
  UNKNOWN_DECISION: 'ECONOMY_APPROVAL_DECISION_UNKNOWN',
  MISSING_IDEMPOTENCY_KEY: 'ECONOMY_APPROVAL_DECISION_MISSING_IDEMPOTENCY_KEY',
  REQUEST_ID_CONFLICT: 'ECONOMY_APPROVAL_DECISION_REQUEST_ID_CONFLICT',
  RESUME_HANDLE_NOT_BOUND: 'ECONOMY_APPROVAL_DECISION_RESUME_HANDLE_NOT_BOUND',
  /* 下游（P22-7 / P22-9 / P22-8）拒绝：**原样透出**它的 reasonCode，
     这一条只是本层的归类。 */
  DECISION_REFUSED: 'ECONOMY_APPROVAL_DECISION_REFUSED_BY_THE_APPROVAL_STATE_MACHINE',
  RESUME_REFUSED: 'ECONOMY_APPROVAL_CONTINUATION_REFUSED'
});
const REFUSAL_CODES = Object.freeze(Object.keys(REFUSAL).map(k => REFUSAL[k]));

/* ══ 自述位（每一个返回值上都带着）═════════════════════════════════ */
const SELF_BITS = Object.freeze({
  seam: 'economy-approval-decision-seam',
  seamIsNotAnEconomyAuthority: true,
  seamInterpretsEconomicFacts: false,
  seamHoldsRawStore: false,
  seamHoldsCapabilityGate: false,
  seamExposesGenericDispatch: false,
  seamAddsASecondApprovalStateMachine: false,
  seamAddsASecondPurchaseDedupe: false,
  seamChoosesTheConsumer: false,
  seamChoosesTheDecider: false,
  decisionIsNotAPurchase: true,
  decisionIsNotAPurchaseGuarantee: true,
  approvalIsNotAGuaranteedPurchase: true,
  transportIsNotAnEconomyAuthority: true,
  identityComesFromTheTransportNotThePayload: true
});

const MAX_ID_LENGTH = 200;

/* ══ 小工具（与 P22-11 同款，逐字同源）═════════════════════════════ */
function isPlainObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}
function sha256Hex(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}
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
/* 续做那一步的 canonical 幂等身份。★ 见文件头 §7：派生而不是复用。 */
function resumeKeyOf(decisionKey) {
  return 'decision-resume:' + String(decisionKey);
}

/* ══════════════════════════════════════════════════════════════════
   工厂
   ══════════════════════════════════════════════════════════════════
   deps:
     · store              —— **唯一**的 store 触碰点（只用于 decideApproval）。
                             不给它任何底层的写动词，也不把它交给别人。
     · resumeHandle       —— 装配层从 P22-9 门 bind 出来的句柄
                             （consumer = user_decision_seam）。本文件只调它的
                             resumeApprovedPurchase 一个成员。
     · desktopCredential  —— 已配置的桌面 token。**空串 ⇒ 本面整体关闭**
                             （fail closed，403 且明说缺什么），与 P22-11 的
                             "未配置凭据 ⇒ 通道关闭"逐字同源。
     · decider            —— 当事人。默认 { type: 'user', id: 'user' }。
                             它**不是**请求参数，因此调用方无法自报身份。 */
function createEconomyApprovalDecisionSeam(options) {
  options = options || {};
  const store = options.store || null;
  const resumeHandle = options.resumeHandle || null;
  const desktopCredential = String(options.desktopCredential == null ? '' : options.desktopCredential);
  const decider = Object.freeze({
    type: C.PARTY_TYPE.USER,
    id: C.USER_PARTY_ID
  });
  const logger = typeof options.logger === 'function' ? options.logger : function () { };
  const clock = typeof options.clock === 'function' ? options.clock : (() => Date.now());

  const auditRing = [];
  const requestMemory = new Map();
  const AUDIT_RING_LIMIT = 100;
  const REQUEST_ID_MEMORY_LIMIT = 256;

  const credentialConfigured = desktopCredential.trim() !== '';
  const storeCanDecide = !!store && typeof store.decideApproval === 'function';
  const resumeBound = !!resumeHandle && typeof resumeHandle.resumeApprovedPurchase === 'function';
  const open = credentialConfigured && storeCanDecide && resumeBound;

  function record(event, fields) {
    const entry = Object.assign({ at: clock(), event: event }, fields || {});
    auditRing.push(entry);
    while (auditRing.length > AUDIT_RING_LIMIT) auditRing.shift();
    try { logger('info', event, fields || {}); } catch (_) { /* 日志失败不得影响决定 */ }
    return entry;
  }

  /* ── 拒绝的完整形状 ────────────────────────────────────────────────
     ★ `reachedStore` / `reachedResumeHandle` 是这一层最重要的两位：
     身份 / 信封面被拒时它们**必须**是 false，因为那条路径上什么都没碰过。 */
  function refusal(status, reasonCode, extra) {
    return Object.assign({
      ok: false,
      status: status,
      refused: true,
      refusedBy: 'economy-approval-decision-seam',
      reasonCode: reasonCode,
      errors: [],
      approvalId: null,
      decision: null,
      decider: null,
      callerIdentityFromPayload: false,
      reachedStore: false,
      reachedResumeHandle: false,
      decisionRecorded: false,
      resumeAttempted: false,
      result: null,
      continuation: null,
      decidedNothing: true,
      purchasedNothing: true,
      ledgerMutation: false,
      inventoryMutation: false
    }, SELF_BITS, extra || {});
  }

  /* ── §2 · 用户身份判定：桌面凭据（恒定时间）─────────────────────────
     ★ 未配置凭据时这里**不是**"放行"（P11-3A 的桌面 token 模型对 /economy/*
     的只读面仍然成立，但那是**读**面）：一个写路径在"这台机器上任何用户态
     进程都能连上 loopback"的前提下等于把用户权威交给每一个本机进程。
     因此本面要求**已配置的桌面凭据**，这与 P22-11 的来源登记册同源 ——
     缺凭据就明说缺什么（403），而不是给一个永远失败的入口。 */
  function resolveUser(requestInfo) {
    const info = requestInfo || {};
    if (info.loopback !== true) {
      return { ok: false, reasonCode: REFUSAL.NOT_LOOPBACK };
    }
    if (!credentialConfigured) {
      return { ok: false, reasonCode: REFUSAL.CREDENTIAL_NOT_CONFIGURED };
    }
    const supplied = String(info.desktopCredential == null ? '' : info.desktopCredential);
    if (supplied.trim() === '' || supplied.length > 512) {
      return { ok: false, reasonCode: REFUSAL.MISSING_USER_CREDENTIAL };
    }
    if (!constantTimeEqual(supplied, desktopCredential)) {
      return { ok: false, reasonCode: REFUSAL.WRONG_USER_CREDENTIAL };
    }
    return { ok: true, decider: decider };
  }

  function rememberRequest(requestId, decisionWord) {
    const known = requestMemory.get(requestId);
    requestMemory.set(requestId, decisionWord);
    while (requestMemory.size > REQUEST_ID_MEMORY_LIMIT) {
      const oldest = requestMemory.keys().next();
      if (oldest.done) break;
      requestMemory.delete(oldest.value);
    }
    return known;
  }

  /* ══════════════════════════════════════════════════════════════════
     唯一执行链：authenticated desktop user → P22-7 决定 → P22-9 句柄 → P22-8
     ══════════════════════════════════════════════════════════════════
     ★ 本函数对 store 的访问是**一处字面成员调用**（store.decideApproval），
       对句柄的访问也是**一处字面成员调用**
       （resumeHandle.resumeApprovedPurchase）。没有 `store[name]`、
       没有 `handle[name]`、没有第二个动词。 */
  function dispatch(requestInfo, rawBody) {
    if (!open) {
      record('economy-approval-decision-closed', {
        credentialConfigured: credentialConfigured,
        storeCanDecide: storeCanDecide,
        resumeBound: resumeBound
      });
      return refusal(503, credentialConfigured ? REFUSAL.SEAM_NOT_CONFIGURED : REFUSAL.CREDENTIAL_NOT_CONFIGURED, {
        credentialConfigured: credentialConfigured,
        storeCanDecide: storeCanDecide,
        resumeBound: resumeBound,
        /* ★ 关闭也是一种**可执行的指路**，而不是一句"被拒"：这条面在生产上
           默认是关的（未配置桌面凭据），而"为什么关、怎么打开"必须写在
           回答里 —— 与 P11-3A 的 credentialMintingPaths 同源。 */
        identityIsEstablishedByTheTransport: true,
        hint: !credentialConfigured
          ? 'set IB_HOME_NODE_TOKEN to enable the approval decision path'
          : 'the approval decision seam is not fully assembled'
      });
    }

    const user = resolveUser(requestInfo);
    if (user.ok !== true) {
      record('economy-approval-decision-refused', { stage: 'identity', reasonCode: user.reasonCode });
      return refusal(user.reasonCode === REFUSAL.NOT_LOOPBACK ? 401 : 403, user.reasonCode, {
        /* ★ 逐字：这条路径上的用户身份由**已认证的桌面传输**确定，
           而不是由调用方自称。 */
        identityIsEstablishedByTheTransport: true,
        acceptedCredentialHeaders: ['X-IB-Home-Token', 'Authorization: Bearer …'],
        /** 缺凭据时的处置是一个可执行的指路，而不是一句"被拒"。 */
        hint: user.reasonCode === REFUSAL.CREDENTIAL_NOT_CONFIGURED
          ? 'set IB_HOME_NODE_TOKEN to enable the approval decision path'
          : 'send the configured desktop credential'
      });
    }

    if (!isPlainObject(rawBody)) {
      record('economy-approval-decision-refused', { stage: 'envelope', reasonCode: REFUSAL.MALFORMED_ENVELOPE });
      return refusal(400, REFUSAL.MALFORMED_ENVELOPE, {
        errors: ['approval-decision-body-must-be-a-plain-object']
      });
    }

    /* ── §2 · 身份自报：逐名拒绝，而且**不触碰** store ──────────────── */
    const selfReported = FORBIDDEN_IDENTITY_KEYS.filter(key =>
      Object.prototype.hasOwnProperty.call(rawBody, key));
    if (selfReported.length) {
      record('economy-approval-decision-refused', {
        stage: 'identity', reasonCode: REFUSAL.NOT_ALLOWED_FOR_A_CALLER_TO_SELF_REPORT
      });
      return refusal(403, REFUSAL.NOT_ALLOWED_FOR_A_CALLER_TO_SELF_REPORT, {
        rejectedIdentityKeys: selfReported,
        forbiddenIdentityKeys: FORBIDDEN_IDENTITY_KEYS,
        identityIsEstablishedByTheTransport: true,
        errors: selfReported.map(key => 'approval-decision-may-not-carry:' + key)
      });
    }

    const rejectedEnvelopeKeys = unexpectedKeysOf(rawBody, ENVELOPE_KEYS);
    if (rejectedEnvelopeKeys.length) {
      record('economy-approval-decision-refused', { stage: 'envelope', reasonCode: REFUSAL.UNEXPECTED_ENVELOPE_KEYS });
      return refusal(400, REFUSAL.UNEXPECTED_ENVELOPE_KEYS, {
        rejectedEnvelopeKeys: rejectedEnvelopeKeys,
        acceptedEnvelopeKeys: ENVELOPE_KEYS,
        errors: rejectedEnvelopeKeys.map(key => 'approval-decision-envelope-key-not-whitelisted:' + key)
      });
    }

    const approvalId = typeof rawBody.approvalId === 'string' ? rawBody.approvalId.trim() : '';
    if (approvalId === '') {
      record('economy-approval-decision-refused', { stage: 'envelope', reasonCode: REFUSAL.MISSING_APPROVAL_ID });
      return refusal(400, REFUSAL.MISSING_APPROVAL_ID, {
        errors: ['approval-decision-requires-an-approval-id']
      });
    }
    if (!C.isEconomyId('APPROVAL', approvalId)) {
      record('economy-approval-decision-refused', { stage: 'envelope', reasonCode: REFUSAL.APPROVAL_ID_NOT_CANONICAL });
      return refusal(400, REFUSAL.APPROVAL_ID_NOT_CANONICAL, {
        approvalId: approvalId,
        errors: ['approval-id-is-not-a-canonical-economy-id']
      });
    }

    const rawDecision = typeof rawBody.decision === 'string' ? rawBody.decision.trim() : '';
    if (rawDecision === '') {
      record('economy-approval-decision-refused', { stage: 'decision', reasonCode: REFUSAL.MISSING_DECISION });
      return refusal(400, REFUSAL.MISSING_DECISION, {
        approvalId: approvalId,
        errors: ['approval-decision-requires-a-decision'],
        acceptedDecisions: DECISION_LIST
      });
    }
    /* ★ 只折**大小写**，不折别的：'approve ' 与 'APPROVE' 是同一个决定，
       而 'AUTO_ALLOW' 不在映射里，因此只能落到 UNKNOWN_DECISION。 */
    const decision = DECISION_ALIASES[rawDecision.toUpperCase()] || null;
    if (decision == null) {
      record('economy-approval-decision-refused', { stage: 'decision', reasonCode: REFUSAL.UNKNOWN_DECISION });
      return refusal(404, REFUSAL.UNKNOWN_DECISION, {
        approvalId: approvalId,
        decision: rawDecision,
        acceptedDecisions: DECISION_LIST,
        errors: ['the-only-decisions-are-approve-and-reject']
      });
    }

    if (!nonEmptyString(rawBody.idempotencyKey, MAX_ID_LENGTH)) {
      /* ★ 缺 canonical 幂等键 ⇒ **拒绝**，而不是这里生成一个。生成一个等于
         把同一次点击变成两次逻辑动作，而这正是"UI retry"要收敛掉的东西。 */
      record('economy-approval-decision-refused', { stage: 'envelope', reasonCode: REFUSAL.MISSING_IDEMPOTENCY_KEY });
      return refusal(400, REFUSAL.MISSING_IDEMPOTENCY_KEY, {
        approvalId: approvalId,
        decision: decision,
        errors: ['approval-decision-requires-a-canonical-idempotency-key']
      });
    }
    const idempotencyKey = rawBody.idempotencyKey.trim();
    const keyCheck = C.normalizeIdempotencyKey(idempotencyKey);
    if (keyCheck.ok !== true) {
      record('economy-approval-decision-refused', { stage: 'envelope', reasonCode: REFUSAL.MISSING_IDEMPOTENCY_KEY });
      return refusal(400, REFUSAL.MISSING_IDEMPOTENCY_KEY, {
        approvalId: approvalId,
        decision: decision,
        errors: keyCheck.errors
      });
    }

    /* ── §7 · 请求身份：同一个 idempotencyKey 换了决定词 ⇒ 冲突 ───────
       ★ store 的指纹（含 decision）也会判这件事，这一层只让它在**触碰
       store 之前**就被回答，并且不缓存任何结果。 */
    const knownDecision = rememberRequest(keyCheck.key, decision);
    if (knownDecision !== undefined && knownDecision !== decision) {
      record('economy-approval-decision-refused', {
        stage: 'idempotency', reasonCode: REFUSAL.REQUEST_ID_CONFLICT, approvalId: approvalId
      });
      return refusal(409, REFUSAL.REQUEST_ID_CONFLICT, {
        approvalId: approvalId,
        decision: decision,
        previouslyDecided: knownDecision,
        errors: ['the-same-decision-identity-was-used-for-a-different-decision']
      });
    }

    /* ── ① 用户决定（P22-7 的状态机是唯一真源）─────────────────────────
       ★ decider 来自**装配层注入的字面量**，不是 rawBody 里的任何东西。 */
    const decided = store.decideApproval({
      approvalId: approvalId,
      decision: decision,
      decidedBy: { type: user.decider.type, id: user.decider.id },
      idempotencyKey: keyCheck.key
    });
    const decisionOk = !!(decided && decided.ok === true);

    if (!decisionOk) {
      record('economy-approval-decision-refused', {
        stage: 'decision', approvalId: approvalId, decision: decision,
        reasonCode: (decided && decided.reasonCode) || null
      });
      /* ★ 被状态机拒绝时**不触碰**续做句柄：REJECT / APPROVED / EXPIRED /
         CONSUMED 上的任何决定都停在这里，而它没有产生任何经济动作。 */
      return refusal(decided && decided.denied === true ? 409 : 400, REFUSAL.DECISION_REFUSED, {
        approvalId: approvalId,
        decision: decision,
        decider: user.decider.type + ':' + user.decider.id,
        reachedStore: true,
        decisionRecorded: false,
        downstreamReasonCode: (decided && decided.reasonCode) || null,
        errors: (decided && decided.errors) || [],
        result: decided
      });
    }

    const decidedStatus = decided.result && decided.result.status != null
      ? String(decided.result.status) : decision;

    /* ══ ② §5 · REJECT：**终止**，零经济动作 ══════════════════════════
       ★ 这一段里**没有**任何续做调用。拒绝不是"再检查一遍然后不做"，
       而是这条路径到此结束 —— 它连 resume 那个成员名都不会被求值。 */
    if (decision === DECISION.REJECT) {
      record('economy-approval-decision-decided', {
        approvalId: approvalId, decision: decision, continuation: 'none'
      });
      return Object.assign({
        ok: true,
        status: 200,
        refused: false,
        refusedBy: null,
        reasonCode: null,
        errors: [],
        approvalId: approvalId,
        decision: decision,
        approvalStatus: decidedStatus,
        decider: user.decider.type + ':' + user.decider.id,
        idempotencyKey: keyCheck.key,
        replayed: decided.replayed === true,
        callerIdentityFromPayload: false,
        reachedStore: true,
        reachedResumeHandle: false,
        decisionRecorded: true,
        resumeAttempted: false,
        continuation: 'none',
        continuationRefusedBecause: 'the-user-rejected-this-intent',
        /* §5 逐字：拒绝之后这些位**恒** false，而且它们是真的 —— 这条路径
           上没有第二步。 */
        purchaseCreated: false,
        purchaseCreatedNow: false,
        purchaseExists: false,
        continuationReplayed: false,
        continuedIntentId: null,
        continuedIntentState: null,
        continuedPurchaseId: null,
        ledgerMutation: false,
        inventoryMutation: false,
        reservationMutation: false,
        settlementAttempted: false,
        result: decided
      }, SELF_BITS);
    }

    /* ══ ③ §4 · APPROVE：**只能**走既有 resume 链 ═════════════════════
       ★ 句柄是 P22-9 门 bind 出来的那一份，它的成员恰好五个，而 resume
       只有一个名字。本文件连 store 的第二条写法都没有，因此
       "APPROVE → settlePurchase()"不是被禁止，而是**写不出来**。 */
    /* ★ 入参是 P22-9 句柄的白名单里的三个键，而且都来自 canonical 事实：
       批准 id（请求给的、已被 isEconomyId 校验过）、那条 intent 的 id
       （来自 P22-7 写下的批准行）、以及派生出来的续做幂等键。
       ★ `agentIntentId` **不是**调用方给的：它来自 `decideApproval` 的
       返回值 —— 也就是 store 自己写下的那一行。调用方没有那个输入位，
       因此"批准 A、续做 B"在这条路径上没有可被填错的参数。

       ★ 续做的两个 canonical 身份要从**每一个**可能的落点读出来：P22-8 在
       "第一次执行"时把它们放在顶层，而在"重放当初的结局"时它给的是
       那条 canonical 幂等记录（`result` 里是 `{intentId, state}`）。
       于是一个重放**必须**把 agentIntentId 显式带上 —— 否则 seam 拿到的
       答案只说"这件事已经定论了"，而说不出"这条 intent 现在有没有购买"。

       ★ 关于 purchaseExists 的诚实边界（开发期实测踩到的一个真实缺陷）：
       在重放那条路上 seam 手里**只有** (intentId, state)。它因此从
       `state === COMPLETED` 推"有购买" —— 而那条推论是**可靠的**，因为
       每条 intent 的购买在结算事务里与 COMPLETED 同一次写入（P22-6），
       且 COMPLETED 是终态。但它是一个推论，所以它写在注释里，而不是
       伪装成一次读。 */
    const resumeInput = {
      approvalId: approvalId,
      agentIntentId: decided.result && decided.result.agentIntentId != null
        ? String(decided.result.agentIntentId) : null,
      idempotencyKey: resumeKeyOf(keyCheck.key)
    };
    if (resumeInput.agentIntentId == null) delete resumeInput.agentIntentId;
    const resumed = resumeHandle.resumeApprovedPurchase(resumeInput);
    const resumeOk = !!(resumed && resumed.ok === true);
    const resumeNested = resumed && resumed.result && typeof resumed.result === 'object' ? resumed.result : null;
    const continuedIntentId = (resumed && resumed.intentId != null) ? String(resumed.intentId)
      : (resumeNested && resumeNested.intentId != null) ? String(resumeNested.intentId)
        : (resumed && resumed.intent && resumed.intent.agentIntentId != null ? String(resumed.intent.agentIntentId) : null);
    const continuedPurchaseId = (resumed && resumed.purchaseId != null) ? String(resumed.purchaseId)
      : (resumeNested && resumeNested.purchaseId != null) ? String(resumeNested.purchaseId) : null;
    const continuationReplayed = !!(resumed && (resumed.replayed === true || resumed.alreadyCompleted === true));
    const continuedIntentState = (resumed && resumed.intent && resumed.intent.state != null)
      ? String(resumed.intent.state)
      : (resumeNested && resumeNested.state != null) ? String(resumeNested.state) : null;
    const purchaseExists = continuedPurchaseId != null ||
      (continuationReplayed && continuedIntentState === C.PURCHASE_INTENT_STATE.COMPLETED);

    record(resumeOk ? 'economy-approval-decision-continued' : 'economy-approval-continuation-refused', {
      approvalId: approvalId,
      decision: decision,
      intentId: (resumed && resumed.intentId) || null,
      reasonCode: (resumed && resumed.reasonCode) || null,
      budgetIsStillAuthoritative: true
    });

    /* ══ §8 · APPROVED 只表示"用户允许这条 intent **继续尝试**" ═══════
       ★ 因此这里**不**把续做的结局折进决定里：决定成功了就是 ok:true
       （它真的写进了一条 canonical 批准），而续做的结局原样放在
       `continuation` 里。一次 `APPROVED → resume → DENIED / FAILED`
       因此读起来是"用户点头了，但预算/报价没让它过" —— 正是它该有的样子。 */
    return Object.assign({
      ok: true,
      status: 200,
      refused: false,
      refusedBy: null,
      reasonCode: null,
      errors: [],
      approvalId: approvalId,
      decision: decision,
      approvalStatus: decidedStatus,
      decider: user.decider.type + ':' + user.decider.id,
      idempotencyKey: keyCheck.key,
      resumeIdempotencyKey: resumeKeyOf(keyCheck.key),
      replayed: decided.replayed === true,
      callerIdentityFromPayload: false,
      reachedStore: true,
      reachedResumeHandle: true,
      decisionRecorded: true,
      resumeAttempted: true,
      continuation: resumeOk ? 'attempted' : 'refused',
      continuationOk: resumeOk,
      continuationReasonCode: (resumed && resumed.reasonCode) || null,
      continuationErrors: (resumed && resumed.errors) || [],
      /* ★ 续做拒绝了**不等于**这次决定失败：决定已经落库，而它之后的每一道
         权威（预算 / 报价 / 商品 / 预留 / 结算）都还在原地，没有被绕过。 */
      approvalDoesNotGuaranteeAPurchase: true,
      budgetWasNotBypassed: true,
      quoteValidityWasNotBypassed: true,
      /* ★ 两个**不同**的问题，两个不同的位（开发期实测踩到的一个真实缺陷：
         这里一度只有 purchaseCreated，而它在重放时是 undefined —— 于是
         "一次成功的购买"与"一次重放"在这个字段上看起来一样）：
           · purchaseCreatedNow —— **这一次调用**有没有真的建出一笔购买？
             重放时为 false，因为这一刻钱没有动。
           · purchaseExists —— 这条 intent 现在**有没有**一笔购买？
             重放时有（它当初建过）。
         把两者合成一个位，就会让"重试"与"没买成"读起来一样。 */
      continuedIntentId: continuedIntentId,
      continuedIntentState: continuedIntentState,
      continuedPurchaseId: continuedPurchaseId,
      purchaseCreatedNow: !!(resumeOk && continuationReplayed !== true && continuedPurchaseId != null),
      purchaseExists: purchaseExists,
      purchaseCreated: purchaseExists,
      continuationReplayed: continuationReplayed,
      result: decided,
      continuationResult: resumed,
      resumeInput: resumeInput
    }, SELF_BITS);
  }

  function describe() {
    return Object.freeze({
      seam: 'economy-approval-decision-seam',
      path: DECISION_PATH,
      open: open,
      implemented: true,
      /* 关闭的三种原因**分开报**：运维要能区分"没有凭据"与"没装配好"。 */
      openRequires: Object.freeze({
        desktopCredentialConfigured: credentialConfigured,
        storeCanDecide: storeCanDecide,
        resumeHandleBound: resumeBound
      }),
      decisions: DECISION_LIST,
      decisionAliases: Object.freeze(Object.keys(DECISION_ALIASES)),
      envelopeKeys: ENVELOPE_KEYS,
      forbiddenIdentityKeys: FORBIDDEN_IDENTITY_KEYS,
      refusalCodes: REFUSAL_CODES,
      decider: decider.type + ':' + decider.id,
      deciderComesFromTheAssemblyNotThePayload: true,
      credential: 'desktop-token (X-IB-Home-Token / Authorization: Bearer; constant-time compare)',
      credentialProvisioning: 'deployment-environment (never in payload, never in logs, never in this description)',
      /* ★ 这一句是**分量**，不是修辞：桌面凭据回答的是"你有没有这台机器的
         桌面凭据"，它**不是** OS 沙箱，也不防"同一个 Windows 用户下已经
         能读到那份配置的人"。 */
      userIdentityStrength: 'authenticated-desktop-credential + loopback',
      differsFromTheCommandChannel: Object.freeze({
        commandPath: '/internal/economy/command',
        commandMeans: 'Agent WANT (ECONOMY_PROPOSE_PURCHASE)',
        decisionMeans: 'User APPROVAL DECISION (APPROVE / REJECT)',
        sharesAConsumerWithTheCommandChannel: false,
        sharesACredentialWithTheCommandChannel: false
      }),
      capabilityConsumer: resumeHandle && typeof resumeHandle.consumer === 'string' ? resumeHandle.consumer : null,
      capabilityAnchor: resumeHandle && typeof resumeHandle.anchor === 'string' ? resumeHandle.anchor : null,
      capability: C.CAPABILITY.RESUME_APPROVED_PURCHASE,
      canProposeAPurchase: false,
      resumeOnlyAfterTheDecisionLanded: true,
      rejectHasNoContinuation: true,
      approvalDoesNotGuaranteeAPurchase: true,
      auditRingLimit: AUDIT_RING_LIMIT,
      requestIdMemoryLimit: REQUEST_ID_MEMORY_LIMIT
    });
  }

  function audit() {
    return Object.freeze(auditRing.slice());
  }

  return Object.freeze({
    path: DECISION_PATH,
    CONSUMER: C.ECONOMY_CONSUMER.USER_DECISION_SEAM,
    DECISION: DECISION,
    DECISION_LIST: DECISION_LIST,
    ENVELOPE_KEYS: ENVELOPE_KEYS,
    FORBIDDEN_IDENTITY_KEYS: FORBIDDEN_IDENTITY_KEYS,
    REFUSAL: REFUSAL,
    dispatch: dispatch,
    describe: describe,
    audit: audit,
    resumeKeyOf: resumeKeyOf
  });
}

module.exports = createEconomyApprovalDecisionSeam;
module.exports.DECISION_PATH = DECISION_PATH;
module.exports.CONSUMER = C.ECONOMY_CONSUMER.USER_DECISION_SEAM;
module.exports.DECISION = DECISION;
module.exports.DECISION_LIST = DECISION_LIST;
module.exports.ENVELOPE_KEYS = ENVELOPE_KEYS;
module.exports.FORBIDDEN_IDENTITY_KEYS = FORBIDDEN_IDENTITY_KEYS;
module.exports.REFUSAL = REFUSAL;
