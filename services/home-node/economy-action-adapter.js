'use strict';
/* ====================================================================
   IB Home Node · Economy Action Adapter（P22-10 · Agent/Action → 门 的**唯一**界面）
   --------------------------------------------------------------------
   位置：**所有** Agent / Action runtime 与整个经济域之间。

       Agent / Action runtime（模型输出的一个结构化动作）
                          ↓
                 Economy Action Adapter            ← 本文件
                          ↓
             P22-9 bound capability handle
                          ↓
               P22-8 Agent Purchase Intent
                          ↓
        P22-7 Autonomy / Approval → P22-6 Atomic Purchase

   ── 这一层为什么存在 ────────────────────────────────────────────────
   P22-9 造了一把门，并且证明"没有旁路"。而 P22-8 在 http.js 上把调用方
   写成了一句话：`proposeAgentPurchaseIntent` 的调用方是 **Decision Bridge**
   （未来的 Decision/Action seam），**不是**一个 HTTP 请求。
   本文件就是那个 seam 的**经济面**：它把"Agent 的一个动作"翻译成一句
   "经过门的一句话"，并且除此之外什么都不会。

   ── §1 只读审计：这个仓库里真正的 Action seam 是什么 ────────────────
   审计结论（无一条来自提示词假设）：

     ① **没有通用 Action dispatcher**。全仓库（生产代码）搜不到
        executeAction / dispatchAction / runAction / actionWhitelist。
        因此本阶段**不新造**一个 —— 这是 §1 逐字要求。
     ② 唯一的"模型输出 → 结构 → 封闭动作集 → 执行"链条是 IB Active：
          · 浏览器侧 assets/js/active-diary/active-plans.js 的
            `_activeValidatePlanResult`，封闭动作集 ['schedule','none',
            'cancel_existing']（**不是**本文件要碰的东西）；
          · Node 侧 active/scheduler.js 的 `evaluatePlan`，封闭动作集
            ['send','reschedule','cancel']；
          · 两者共用的形状权威是 active/plan-domain.js 的 `sanitizeAiPlan`。
     ③ Active 的**决定**跑在浏览器与 Active companion（端口 23114）两个
        进程里，而 canonical Economy store 只在 Home Node（端口 23118）
        进程里被装配（B4.2 逐字断言：装配层是它唯一的 require 点）。
        两个进程之间**没有**经济通道，而 HTTP 上的经济写面从 P22-2 起
        就是 0，P22-9 §8 又明说这扇门连读面都没有。
        ⇒ 因此跨进程"送一条动作过去"这件事本阶段**不做**，也不可能做
        （造通道就是造一条新的写面）。门的句柄只能长在它所绑定的那个
        进程里，而装配层就是那**唯一**一处。
     ④ Middle Brain（services/home-node/middle-brain.js）**不在**这条链
        上：它是 Home Node 角色回合的上下文/认知层，没有动作集、没有
        dispatcher、没有工具回合。§11 因此对它**零改动**。

   ── §3 依赖方向：只持有 bound handle，永不持有 store ───────────────
   正确：
       createEconomyActionAdapter( economyCapabilityHandle )
   错误（而且**构造期就会抛**）：
       createEconomyActionAdapter( economyStore )

   下面 `LOW_LEVEL_ECONOMY_VERBS` 是后者的机器可读定义：一个对象只要
   露出其中任何一个名字，它就是一个 store，而不是一个 capability
   handle，构造直接失败。这不是"不推荐"，是"传不进去"。

   ── §2 动作只有**一个** ────────────────────────────────────────────
       ECONOMY_PROPOSE_PURCHASE          ← 唯一开放的动作
   ★ `ECONOMY_BUY` / `ECONOMY_SETTLE` / `ECONOMY_RESERVE` /
     `ECONOMY_GRANT` / `ECONOMY_APPROVE` / `ECONOMY_LEDGER` **不是**
     "还没开放"，它们在这份词表里**不存在**，因此未知动作只能被拒。
   ★ 更没有万能入口：本文件里**没有** economy(method,args)，
     **也没有** executeEconomyAction(method,args)。这一点由一条结构性
     事实保证 —— 对句柄的访问是**字面成员名**，全文没有一处
     `handle[...]` 形式的计算型分派。

   ── §9 为什么**只**开放 propose，连"保守的 resume"都不开 ─────────────
   审计：store 的 `decideApproval`（"用户点头/摇头"）在**生产代码里
   一个调用方都没有** —— 唯一调用它的是 tests/*。而 http.js 自己把
   "用户点批准"的入口逐字标成"留给未来的 UI / Action authority 阶段"。
   ⇒ 今天这个仓库里**不存在**一条可靠的"用户已批准"触发 seam。
     因此 `ECONOMY_RESUME_APPROVED_PURCHASE` 被登记在
     `NOT_OFFERED` 里：它的拒绝理由是 `NO_APPROVAL_TRIGGER_SEAM`，
     而不是"忘了写"。§9 逐字要求："如果当前真实 runtime 没有可靠的
     用户已批准触发 seam，本阶段不要接 resume。宁可只做 propose。"

   ── §5 Action ≠ Authority ─────────────────────────────────────────
   一次成功的 `ECONOMY_PROPOSE_PURCHASE` 只代表"Agent 请求提出购买
   意图"。它**不**代表 Purchase allowed / Budget allowed / AUTO_ALLOW /
   Approval granted / Settlement allowed。这句话在**返回值里**成立：
   每一个返回值（成功与拒绝）都带着同一组恒 false 的位。
   ==================================================================== */

const C = require('./economy-contract.js');

/* ══ §2 · 动作词表（封闭集，恰好一个成员）══════════════════════════ */
const ACTION = Object.freeze({
  ECONOMY_PROPOSE_PURCHASE: 'ECONOMY_PROPOSE_PURCHASE'
});
const ACTION_LIST = Object.freeze([ACTION.ECONOMY_PROPOSE_PURCHASE]);

/* 每个动作映射到它需要的那**一个**准入能力。这张表让"动作 ↔ 能力"
   是一份可核对的映射，而不是两处各自写死、日后漂移的字符串。
   ★ 字形刻意不同（ECONOMY_ 前缀）：与 P22-9 让准入决定叫
   CAPABILITY_GRANTED 而不是 DENY 是同一条纪律 —— 一句话在审计里只能
   有一个意思。载入期不变量断言这两个集合不相交。 */
const ACTION_CAPABILITY = Object.freeze({
  ECONOMY_PROPOSE_PURCHASE: C.CAPABILITY.PROPOSE_PURCHASE
});

/* ══ §9 · 已知但**不开放**的动作（这是拒绝名单，不是第二个词表）════ */
const NOT_OFFERED = Object.freeze([
  Object.freeze({
    action: 'ECONOMY_RESUME_APPROVED_PURCHASE',
    capability: C.CAPABILITY.RESUME_APPROVED_PURCHASE,
    /* 门**已经**把这个能力授予 active_agent_runtime（P22-9 的矩阵）。
       本阶段不开它，与"门授不授予"无关 —— 门管的是"你有没有资格问"，
       而这里管的是"这个动作有没有一个真实的发起者"。 */
    reasonCode: 'NO_APPROVAL_TRIGGER_SEAM',
    why: '把一条已批准的 intent 继续做完需要一个真实的「用户点了批准」发起者；'
      + '这个仓库今天没有它，因此 Agent 不能自己发起 resume。',
    evidence: 'services/home-node/economy-store.js#decideApproval 的生产调用方数 = 0'
      + '（唯一调用方是 tests/*），且 services/home-node/http.js 把「用户点批准」'
      + '的入口逐字标为留给未来的 UI / Action authority 阶段'
  })
]);
const NOT_OFFERED_ACTIONS = Object.freeze(NOT_OFFERED.map(row => row.action));

/* ══ §4 · 动作的输入键：白名单，三个 ════════════════════════════════
      action          —— 必须逐字落在封闭集里（不 trim、不折大小写、不容错）
      proposal        —— **原样**交给 P22-8；本文件一个字都不解释它
      idempotencyKey  —— 只做"有且是字符串"的形状检查，规范化仍由 P22-8 做

   ★ proposal **里面**的键**不**在这里检查。这是刻意的：
     经济事实（price / amountMinor / currency / budget / approval /
     autoAllow / settlementType / wallet / ledger …）的拒绝是 P22-8 的
     `MODEL_SUPPLIED_ECONOMIC_FACT`，它的答案比这里能给的更准
     （它会**列名**），而且 §4 逐字要求"P22-8 validation 必须继续是
     authority"。本文件对 proposal 的判定只有一句："它是一个普通对象"。 */
const ACTION_INPUT_KEYS = Object.freeze(['action', 'proposal', 'idempotencyKey']);

/* ══ 拒绝码（封闭集）════════════════════════════════════════════════ */
const ACTION_REFUSAL = Object.freeze({
  NOT_A_PLAIN_OBJECT: 'ACTION_NOT_A_PLAIN_OBJECT',
  MISSING_ACTION: 'MISSING_ACTION',
  UNKNOWN_ACTION: 'UNKNOWN_ECONOMY_ACTION',
  NOT_OFFERED: 'ACTION_NOT_OFFERED',
  UNEXPECTED_ACTION_KEYS: 'UNEXPECTED_ACTION_KEYS',
  MISSING_PROPOSAL: 'MISSING_PROPOSAL',
  PROPOSAL_NOT_A_PLAIN_OBJECT: 'PROPOSAL_NOT_A_PLAIN_OBJECT',
  MISSING_IDEMPOTENCY_KEY: 'MISSING_IDEMPOTENCY_KEY',
  /* 句柄缺席 ⇒ 什么都批不了（与 P22-9 "未装配 store 仍然是拒绝" 同款）。 */
  ADAPTER_NOT_BOUND: 'ECONOMY_ACTION_ADAPTER_NOT_BOUND'
});
const ACTION_REFUSAL_REASONS = Object.freeze(Object.keys(ACTION_REFUSAL).map(k => ACTION_REFUSAL[k]));

/* ══ §5 · 恒 false 的位（每一个返回值上都带着）══════════════════════
   与 P22-9 的 refusalOf 同源：让"动作不是权限"成为返回值里的**事实**，
   而不是读者需要去读文档的一句话。 */
const SELF_FALSE_BITS = Object.freeze({
  isAnEconomyAuthority: false,
  isABudgetDecision: false,
  isAnAutonomyDecision: false,
  isAnApproval: false,
  isAPurchasePermission: false,
  authorizesSpending: false,
  grantsBudget: false,
  grantsApproval: false,
  grantsSettlement: false,
  permitsSettlement: false,
  isAutoAllow: false,
  bypassesAutonomy: false,
  bypassesBudget: false,
  bypassesQuoteExpiry: false
});

/* ══ 结构性自述（同样在每一个返回值上）═════════════════════════════
   ★ `holdsBoundCapabilityHandle` **刻意不在这里**：一个还没被绑定的
   适配器（或一次连句柄都没走到就被净化器拒掉的动作）如果也自述"我持有
   句柄"，那就是一句假话。它在每个出口上被**显式**写下：净化器拒绝 → false；
   未绑定 → false；真的走到了句柄 → true。 */
const SELF_STRUCTURE_BITS = Object.freeze({
  adapter: 'economy-action-adapter',
  actionIsNotAuthority: true,
  interpretsEconomicFacts: false,
  holdsRawStore: false,
  exposesGenericDispatch: false,
  exposesLowLevelEconomyWrites: false,
  addsASecondDedupe: false,
  actionSuccessIsNotAPurchase: true
});

/* ══ §3 · 一个 store 长什么样（用来在构造期把它挡在外面）═════════════
   这些名字全部是 canonical store 自己的成员。一个 capability handle
   只暴露 consumer / anchor / capabilities / proposePurchaseIntent /
   resumeApprovedPurchase，因此这份名单里没有任何一个会命中它。 */
const LOW_LEVEL_ECONOMY_VERBS = Object.freeze([
  'proposeAgentPurchaseIntent', 'resumeAgentPurchaseIntent',
  'getPurchaseIntent', 'listPurchaseIntents', 'serializePurchaseIntent', 'countPurchaseIntentStates',
  'settlePurchase', 'preparePurchase', 'reserveFunds', 'commitReservation',
  'releaseReservation', 'expireReservation', 'failReservation',
  'expireDueReservations', 'rebuildReservedBalance', 'reconcileReservations',
  'mutateInventory', 'grantInventory', 'consumeInventory',
  'commitLedgerTransaction', 'mintForSystem', 'burnForSystem', 'openWallet',
  'transferBetweenWallets', 'createQuote', 'expireQuote', 'createProductQuote',
  'decideApproval', 'createApprovalRequest', 'expireApproval', 'expireDueApprovals',
  'putAutonomyPolicy', 'authorizePurchaseIntent', 'appendCapabilityAudit',
  'putStore', 'putProduct', 'putBudgetPolicy'
]);

/* 实例的键恰好是这七个。测试与边界断言逐字读它。 */
const ADAPTER_KEYS = Object.freeze([
  'consumer', 'capabilities', 'actions', 'notOfferedActions',
  'sanitizeAction', 'performAction', 'describe'
]);

/* ── 小工具 ────────────────────────────────────────────────────────── */
function isPlainObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function unexpectedKeysOf(input, allowed) {
  return Object.keys(input).filter(key => allowed.indexOf(key) < 0);
}

/* 一个对象是不是"看起来像 store"（而不是 capability handle）。 */
function storeLikeMembersOf(value) {
  if (value == null || typeof value !== 'object') return [];
  return LOW_LEVEL_ECONOMY_VERBS.filter(name => typeof value[name] === 'function');
}

/* ── §5 · 拒绝的完整形状 ─────────────────────────────────────────────
   ★ 它在**每一个**拒绝分支里都一模一样：调用方不需要靠 undefined 去猜
   自己撞上的是"动作不认识"还是"proposal 不是对象"。 */
function refusal(reasonCode, extra) {
  return Object.assign({
    ok: false,
    refused: true,
    refusedBy: 'economy-action-adapter',
    reasonCode: reasonCode,
    errors: [],
    action: null,
    /* 逐字：这条路径**没有**碰句柄，也没有碰 store。 */
    proposedNothing: true,
    reachedCapabilityGate: false,
    holdsBoundCapabilityHandle: false,
    gateDecision: null,
    intentId: null,
    quoteId: null,
    approvalId: null,
    purchaseId: null,
    ledgerMutation: false,
    inventoryMutation: false,
    providerMutation: false,
    paymentMutation: false,
    memoryMutation: false,
    relationshipMutation: false,
    capabilityIsNotEconomyAuthority: true,
    economyDecisionStillPending: true
  }, SELF_STRUCTURE_BITS, SELF_FALSE_BITS, extra || {});
}

/* ══════════════════════════════════════════════════════════════════
   §7 · 动作净化器（纯函数 · 零句柄接触 · 零 IO · 零时钟）
   ══════════════════════════════════════════════════════════════════
   它就是 §7 要求的那条既有封闭链上的**一环**：
       模型输出 → 解析 → **本净化器（封闭动作集）** → performAction
   它只做三件事，而顺序是刻意的：
     ① 动作必须在封闭集里（不在 ⇒ 拒绝；已知但不开放 ⇒ 用**另一个**
        理由码拒绝，并且把名单带回去）；
     ② 动作对象上不能有白名单之外的键（偷渡 price/amountMinor/budget/
        approval/autoAllow/settlementType/wallet/ledger 在这里就被挡，
        而且是**列名**拒绝）；
     ③ 留下 action / proposal / idempotencyKey 三个键，proposal **原样**。

   ★ 它**不**猜测修复：动作串不做 trim、不做大小写折叠 —— `'economy_
   propose_purchase'` 与 `'ECONOMY_PROPOSE_PURCHASE '` 都是未知动作。
   一条"帮你修好"的净化器会让"模型胡说了什么"变成一次看不见的失误。
   ★ 它也**不**往 proposal 里补任何字段：缺 agentId 就由 P22-8 说不，
   而不是这里替模型填一个。 */
function createSanitizer() {
  function refuse(reasonCode, extra) {
    return Object.assign({ ok: false, sanitized: null, reasonCode: reasonCode }, extra || {});
  }

  function sanitizeAction(raw) {
    if (!isPlainObject(raw)) {
      return refuse(ACTION_REFUSAL.NOT_A_PLAIN_OBJECT, {
        errors: ['economy-action-must-be-a-plain-object'],
        rejectedActionKeys: isPlainObject(raw) ? Object.keys(raw) : []
      });
    }
    const rejectedActionKeys = unexpectedKeysOf(raw, ACTION_INPUT_KEYS);
    const rawAction = raw.action;
    if (typeof rawAction !== 'string' || rawAction === '') {
      return refuse(ACTION_REFUSAL.MISSING_ACTION, {
        errors: ['economy-action-is-required'],
        rejectedActionKeys: rejectedActionKeys
      });
    }
    if (ACTION_LIST.indexOf(rawAction) < 0) {
      /* ★ 已知但不开放 与 完全未知 是**两件**不同的事，因此是两个理由码。
         把它们并成一个会让"我们故意没开 resume"看起来像"模型胡说了"，
         而 §9 要求这件事被读准。 */
      if (NOT_OFFERED_ACTIONS.indexOf(rawAction) >= 0) {
        return refuse(ACTION_REFUSAL.NOT_OFFERED, {
          errors: ['economy-action-is-known-but-not-offered-by-the-agent-runtime'],
          action: rawAction,
          notOfferedActions: NOT_OFFERED_ACTIONS,
          notOfferedReasons: NOT_OFFERED,
          rejectedActionKeys: rejectedActionKeys
        });
      }
      return refuse(ACTION_REFUSAL.UNKNOWN_ACTION, {
        errors: ['economy-action-is-not-in-the-closed-action-set'],
        action: rawAction,
        acceptedActions: ACTION_LIST,
        rejectedActionKeys: rejectedActionKeys
      });
    }
    if (rejectedActionKeys.length) {
      return refuse(ACTION_REFUSAL.UNEXPECTED_ACTION_KEYS, {
        errors: rejectedActionKeys.map(key => 'economy-action-key-not-whitelisted:' + key),
        action: rawAction,
        rejectedActionKeys: rejectedActionKeys,
        acceptedActionKeys: ACTION_INPUT_KEYS
      });
    }
    if (raw.proposal === undefined || raw.proposal === null) {
      return refuse(ACTION_REFUSAL.MISSING_PROPOSAL, {
        errors: ['economy-action-requires-a-proposal'],
        action: rawAction
      });
    }
    if (!isPlainObject(raw.proposal)) {
      return refuse(ACTION_REFUSAL.PROPOSAL_NOT_A_PLAIN_OBJECT, {
        errors: ['economy-proposal-must-be-a-plain-object'],
        action: rawAction
      });
    }
    if (typeof raw.idempotencyKey !== 'string' || raw.idempotencyKey.trim() === '') {
      /* ★ 缺幂等键 ⇒ **拒绝**，而不是这里生成一个。§8：本层"只负责稳定传递
         canonical idempotency identity"，生成一个等于把"同一动作重复两次
         变成两次不同提议"—— 那就是自己造了一套 dedupe 的反面。
         规范化（长度、字符集）仍由 P22-8 的 normalizeIdempotencyKey 做。 */
      return refuse(ACTION_REFUSAL.MISSING_IDEMPOTENCY_KEY, {
        errors: ['economy-action-requires-an-idempotency-key'],
        action: rawAction
      });
    }
    return {
      ok: true,
      sanitized: Object.freeze({
        action: rawAction,
        capability: ACTION_CAPABILITY[rawAction],
        /* ★ 原样引用，不复制、不裁剪、不改写：P22-8 是它的 authority。 */
        proposal: raw.proposal,
        idempotencyKey: raw.idempotencyKey
      }),
      action: rawAction,
      reasonCode: null,
      rejectedActionKeys: [],
      errors: []
    };
  }

  return Object.freeze({ sanitizeAction: sanitizeAction });
}

/* ══════════════════════════════════════════════════════════════════
   §3 · createEconomyActionAdapter(economyCapabilityHandle)
   ══════════════════════════════════════════════════════════════════
   ★ 句柄**缺席**时构造仍然成功，而每一个 perform 都拒绝
   （`ADAPTER_NOT_BOUND`）—— 与 P22-9 "未装配 store 的门是拒绝而不是
   null" 同款：fail closed 的责任不推给调用方。
   ★ 但**传了一个 store** 是另一回事：那是装配期的一个编程错误，必须
   当场炸掉，而不是留到第一次购买时表现成一句奇怪的拒绝。 */
function createEconomyActionAdapter(handle) {
  if (handle !== undefined && handle !== null) {
    if (!isPlainObject(handle)) {
      throw new Error('createEconomyActionAdapter: 需要一个 P22-9 capability handle，收到 ' + typeof handle);
    }
    const storeLike = storeLikeMembersOf(handle);
    if (storeLike.length) {
      throw new Error('createEconomyActionAdapter: 这是 economy **store**，不是 capability handle'
        + '（命中的底层动词: ' + storeLike.join(', ') + '）。'
        + '正确依赖方向是 createEconomyActionAdapter(gate.bind(consumer))。');
    }
    if (typeof handle.proposePurchaseIntent !== 'function') {
      throw new Error('createEconomyActionAdapter: 这个对象没有 proposePurchaseIntent —— 它不是一个 capability handle');
    }
  }

  const boundHandle = handle || null;
  const consumer = boundHandle && typeof boundHandle.consumer === 'string' ? boundHandle.consumer : null;
  const capabilities = boundHandle && Array.isArray(boundHandle.capabilities)
    ? Object.freeze(boundHandle.capabilities.slice())
    : Object.freeze([]);
  const sanitizer = createSanitizer();

  /* ★ 全文件对句柄的**唯一**一次访问。字面成员名，没有计算型分派。 */
  function callBoundHandle(proposal, idempotencyKey) {
    return boundHandle.proposePurchaseIntent({
      proposal: proposal,
      idempotencyKey: idempotencyKey
    });
  }

  function sanitizeAction(raw) {
    return sanitizer.sanitizeAction(raw);
  }

  /* ── §5/§7 · 唯一一条执行路径 ────────────────────────────────────
     净化 → 句柄 → 门 → P22-8。三个都是**串联**的，没有短路。 */
  function performAction(raw) {
    const sanitized = sanitizer.sanitizeAction(raw);
    if (sanitized.ok !== true) {
      return refusal(sanitized.reasonCode, {
        action: sanitized.action === undefined ? null : sanitized.action,
        errors: sanitized.errors || [],
        rejectedActionKeys: sanitized.rejectedActionKeys || [],
        acceptedActions: sanitized.acceptedActions || ACTION_LIST,
        notOfferedActions: sanitized.notOfferedActions || NOT_OFFERED_ACTIONS,
        notOfferedReasons: sanitized.notOfferedReasons || NOT_OFFERED,
        acceptedActionKeys: ACTION_INPUT_KEYS
      });
    }
    if (!boundHandle) {
      return refusal(ACTION_REFUSAL.ADAPTER_NOT_BOUND, {
        action: sanitized.action,
        /* ★ 未绑定：这条层**没有**句柄可持有，因此它不自述持有。 */
        holdsBoundCapabilityHandle: false,
        errors: ['economy-action-adapter-has-no-bound-capability-handle']
      });
    }
    const action = sanitized.sanitized;
    const result = callBoundHandle(action.proposal, action.idempotencyKey);
    /* ★ 门/ P22-8 的返回值**原样**透出（`ok`、`intentId`、`reasonCode`、
       `authorityOutcome`、`replayed`、`suppressed` …全部保留），本层只
       **加上**自己的自述位，一个都不改、一个都不删。
       —— 一个手写返回对象会把"多了一层"变成"少了一个字段"。 */
    return Object.assign({}, result, {
      action: action.action,
      capability: action.capability,
      reachedCapabilityGate: true,
      /* ★ 只有真的走到句柄的出口才自述持有它（见 SELF_STRUCTURE_BITS 的说明）。 */
      holdsBoundCapabilityHandle: true
    }, SELF_STRUCTURE_BITS, SELF_FALSE_BITS);
  }

  function describe() {
    return Object.freeze({
      adapter: 'economy-action-adapter',
      consumer: consumer,
      anchor: boundHandle && boundHandle.anchor ? boundHandle.anchor : null,
      boundCapabilities: capabilities,
      actions: ACTION_LIST,
      actionCapability: ACTION_CAPABILITY,
      notOfferedActions: NOT_OFFERED_ACTIONS,
      notOfferedReasons: NOT_OFFERED,
      acceptedActionKeys: ACTION_INPUT_KEYS,
      refusalReasons: ACTION_REFUSAL_REASONS,
      /* §2/§3 的机器可读形式。 */
      holdsRawStore: false,
      holdsBoundCapabilityHandle: boundHandle != null,
      exposesGenericDispatch: false,
      exposesLowLevelEconomyWrites: false,
      acceptsAMethodName: false,
      interpretsEconomicFacts: false,
      addsASecondDedupe: false,
      actionIsNotAuthority: true,
      actionSuccessIsNotAPurchase: true,
      resumeIsNotOffered: true,
      noApprovalTriggerSeamExists: true
    });
  }

  return Object.freeze({
    consumer: consumer,
    capabilities: capabilities,
    actions: ACTION_LIST,
    notOfferedActions: NOT_OFFERED_ACTIONS,
    sanitizeAction: sanitizeAction,
    performAction: performAction,
    describe: describe
  });
}

/* ══════════════════════════════════════════════════════════════════
   装配助手：全仓库**唯一**一次 `gate.bind(consumer)`
   ══════════════════════════════════════════════════════════════════
   它为什么在这里，而不是在装配层：consumer 的身份是 P22-10 的一句话
   （"这个适配器服务的是哪一个 runtime 消费者"），把它写在适配器旁边，
   "谁被绑定了"就只有一个答案。装配层只负责调用它。
   ★ 只绑定**一个**消费者：active_agent_runtime。Chat / Group / Voice /
   Diary / desktop_bridge / home_node_authority / MCP 一个都不绑
   （P22-9 已经证明它们作为 Node 运行时消费者**不存在**，本阶段不凭空
   创建）。 */
function bindActiveAgentEconomyAdapter(gate) {
  if (!gate || typeof gate.bind !== 'function') {
    throw new Error('bindActiveAgentEconomyAdapter: 需要一个 P22-9 capability gate（有 bind()）');
  }
  return createEconomyActionAdapter(gate.bind(C.ECONOMY_CONSUMER.ACTIVE_AGENT_RUNTIME));
}

/* ══ 载入期不变量（词表自证；坏了就当场炸，而不是运行到一半）══════ */
(function assertActionVocabulary() {
  const offered = ACTION_LIST.slice();
  const problems = [];
  offered.forEach(name => {
    if (name.indexOf('ECONOMY_') !== 0) problems.push('action-name-must-be-namespaced:' + name);
    const capability = ACTION_CAPABILITY[name];
    if (C.CAPABILITIES.indexOf(capability) < 0) problems.push('action-maps-to-an-unknown-capability:' + name);
    /* 动作词与能力词**字形不同**：一句话在审计里只能有一个意思。 */
    if (C.CAPABILITIES.indexOf(name) >= 0) problems.push('action-name-collides-with-a-capability:' + name);
  });
  if (offered.length !== 1) problems.push('p22-10-offers-exactly-one-action');
  NOT_OFFERED.forEach(row => {
    if (offered.indexOf(row.action) >= 0) problems.push('an-action-cannot-be-both-offered-and-not:' + row.action);
    if (C.CAPABILITIES.indexOf(row.capability) < 0) problems.push('not-offered-maps-to-an-unknown-capability:' + row.action);
  });
  /* §2 禁止的动作名必须**不在**任何一份名单里。 */
  ['ECONOMY_BUY', 'ECONOMY_SETTLE', 'ECONOMY_RESERVE', 'ECONOMY_GRANT', 'ECONOMY_APPROVE', 'ECONOMY_LEDGER']
    .forEach(forbidden => {
      if (offered.indexOf(forbidden) >= 0 || NOT_OFFERED_ACTIONS.indexOf(forbidden) >= 0) {
        problems.push('forbidden-action-present:' + forbidden);
      }
    });
  if (ACTION_INPUT_KEYS.length !== 3) problems.push('action-input-keys-must-be-exactly-three');
  if (problems.length) {
    throw new Error('economy-action-adapter vocabulary is invalid: ' + problems.join('; '));
  }
})();

module.exports = createEconomyActionAdapter;
module.exports.createEconomyActionAdapter = createEconomyActionAdapter;
module.exports.bindActiveAgentEconomyAdapter = bindActiveAgentEconomyAdapter;
module.exports.ACTION = ACTION;
module.exports.ACTION_LIST = ACTION_LIST;
module.exports.ACTION_CAPABILITY = ACTION_CAPABILITY;
module.exports.NOT_OFFERED = NOT_OFFERED;
module.exports.NOT_OFFERED_ACTIONS = NOT_OFFERED_ACTIONS;
module.exports.ACTION_INPUT_KEYS = ACTION_INPUT_KEYS;
module.exports.ACTION_REFUSAL = ACTION_REFUSAL;
module.exports.ACTION_REFUSAL_REASONS = ACTION_REFUSAL_REASONS;
module.exports.ADAPTER_KEYS = ADAPTER_KEYS;
module.exports.LOW_LEVEL_ECONOMY_VERBS = LOW_LEVEL_ECONOMY_VERBS;
module.exports.SELF_FALSE_BITS = SELF_FALSE_BITS;
module.exports.CONSUMER = C.ECONOMY_CONSUMER.ACTIVE_AGENT_RUNTIME;
