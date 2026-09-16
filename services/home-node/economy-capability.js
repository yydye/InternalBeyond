'use strict';
/* ====================================================================
   IB Home Node · Agent Economy Capability Gate（P22-9 · 唯一的准入门）
   --------------------------------------------------------------------
   位置：**所有** runtime consumer 与 P22-8 的 Agent Purchase Intent 之间。

       Chat / Active Agent / Group / Voice / Diary / …（consumer）
                          ↓
                 Economy Capability Gate          ← 本文件
                          ↓
              proposeAgentPurchaseIntent()         ← P22-8（本文件是它唯一的调用方）
                          ↓
                    P22-8 / P22-7 / P22-6

   ── 这一层为什么**不是** P22-8 的一部分 ────────────────────────────────
   如果门长在 store 里，那么"这次提议有没有过门"就变成 store 内部的一件事，
   而 P22-8 的 canonical ownership（"proposeAgentPurchaseIntent 是唯一的提议
   入口，它自己不做准入"）会被改写。本阶段的纪律是：**P22-6 ~ P22-8 一行
   都不动**，门是它们**上面**的一层。因此：

     · economy-store.js 里没有任何 consumer / capability 的判定；
     · economy-contract.js 里没有第二份权限表；
     · 权限表只有一份（契约的 CONSUMER_CAPABILITY_MATRIX），判定只有一个
       纯函数（契约的 checkEconomyCapability），而**执行**只有一个地方
       （本文件）。

   ── 为什么 consumer 与 capability 都**不是**调用参数 ───────────────────
   §3 的最后一条禁令是"权限不得来自 LLM output / prompt / Memory /
   Relationship / reason / 聊天文本 / Middle Brain 自行判断"。把 consumer
   做成一个参数，等于把这句话降级成"记得不要传模型给的那个值" —— 而那是
   一条纪律，不是一个结构。

   因此本文件公开的是 **bind(consumer)**：consumer 在**构造期**绑定，
   能力在**方法名**里绑定。消费者拿到的句柄长这样：

       handle.proposePurchaseIntent({ proposal, idempotencyKey })
       handle.resumeApprovedPurchase({ agentIntentId, approvalId, idempotencyKey })

   ★ 这两个方法**没有** consumer 参数，也**没有** capability 参数。一个
   模型无论输出什么，都只能填 proposal 的内容（而 proposal 自己的六键白名单
   在 P22-8 里），它连"我是谁"和"我要什么能力"这两个位置都不存在。
   这与会话治理的既有做法同源：不是"校验身份"，而是"没有那个输入位"。

   ── 句柄上**没有**的东西（§6）─────────────────────────────────────────
   句柄是冻结的，键恰好是五个：consumer / anchor / capabilities /
   proposePurchaseIntent / resumeApprovedPurchase。它不持有 store，也不
   转发任何底层动词：

     settlePurchase · preparePurchase · reserveFunds · commitReservation ·
     mutateInventory · 任何 Ledger 写 · approve / reject Approval

   ★ 并且**刻意没有** executeEconomyAction(method, args) 这种万能入口：
   本文件里对 store 的访问全部是**字面成员名**（见下面的两处调用），
   没有任何 `store[name]` 形式的计算型分派。因此"用一个字符串换任意底层
   能力"在这段代码里不存在，而不是"不推荐"。
   ==================================================================== */

const C = require('./economy-contract.js');

/* 句柄的键恰好是这五个。测试与边界断言逐字读它。 */
const HANDLE_KEYS = Object.freeze([
  'consumer', 'anchor', 'capabilities', 'proposePurchaseIntent', 'resumeApprovedPurchase'
]);

/* 两个句柄方法的输入键。与 §6 的 store 方法同款：**白名单**。
   ★ 多出来的键不会被偷偷转发，而是被**列出来**（ignoredInputKeys）——
   静默丢键会让一次"我以为我传了 consumerId"变成一次看不见的失误。 */
const PROPOSE_INPUT_KEYS = Object.freeze(['proposal', 'idempotencyKey']);
const RESUME_INPUT_KEYS = Object.freeze(['agentIntentId', 'approvalId', 'idempotencyKey']);

function ignoredKeysOf(input, allowed) {
  const o = input || {};
  return Object.keys(o).filter(k => allowed.indexOf(k) < 0);
}

/* 一条准入拒绝的完整形状。
   ★ 它在每一个拒绝分支里都**一模一样**：调用方不需要靠 `undefined` 去猜
   自己撞上的是"未知消费者"还是"没有这个能力"。这与 P22-8 的
   `suppliedEconomicFacts` / `proposedNothing` 是同一条纪律。 */
function refusalOf(decision, extra) {
  return Object.assign({
    ok: false,
    denied: true,
    refusedBy: 'economy-capability-gate',
    consumer: decision.consumer,
    capability: decision.capability,
    gateDecision: decision.decision,
    reasonCode: decision.reasonCode,
    errors: decision.errors.slice(),
    capabilities: decision.capabilities,
    /* §5：一次准入拒绝**从不**回答经济问题。七位恒 false。 */
    isEconomyAuthority: false,
    isBudgetDecision: false,
    isAutonomyDecision: false,
    isApproval: false,
    isPurchasePermission: false,
    authorizesSpending: false,
    bypassesBudget: false,
    /* 逐字：这条路径**没有**碰 store。 */
    proposedNothing: true,
    intentId: null,
    quoteId: null,
    approvalId: null,
    purchaseId: null,
    ledgerMutation: false,
    inventoryMutation: false,
    providerMutation: false,
    paymentMutation: false,
    memoryMutation: false,
    relationshipMutation: false
  }, extra || {});
}

function createEconomyCapabilityGate(deps) {
  const d = deps || {};
  const store = d.store || null;
  const logger = typeof d.logger === 'function' ? d.logger : null;

  /* 配置在**构造期**归一化一次。一个损坏的配置不是"这次调用失败"，而是
     "这个门整体不可信"，因此它的后果是 **fail closed 到全部拒绝**，
     而不是逐次报错。 */
  const config = C.normalizeCapabilityConfig(d.config);
  const configurationCorrupt = config.ok !== true;
  const revoked = configurationCorrupt ? C.CAPABILITIES.slice() : config.revoked;

  const canRecordAudit = !!store && typeof store.appendCapabilityAudit === 'function';

  /* ── 唯一的准入判定 ─────────────────────────────────────────────────
     它把**本门自己的配置**（而不是调用方给的）交给契约的纯函数。因此
     调用方无法通过传一个 config 来给自己开权限。 */
  function checkEconomyCapability(input) {
    const o = input || {};
    const decision = C.checkEconomyCapability({
      consumer: o.consumer,
      capability: o.capability,
      config: configurationCorrupt ? null : { revokedCapabilities: revoked }
    });
    if (configurationCorrupt) {
      return Object.assign({}, decision, {
        decision: C.CAPABILITY_DECISION.CAPABILITY_DENIED,
        granted: false,
        reasonCode: C.CAPABILITY_DENY_REASON.CONFIGURATION_CORRUPT,
        errors: config.errors
      });
    }
    return decision;
  }

  /* ── §7 · 准入审计 ───────────────────────────────────────────────────
     ★ 纯检查**不写任何东西**：checkEconomyCapability 可以被调用一千次而
     change log 一行都不长。写下来的只有两种**有业务意义**的事：

       · 一次被拒的提议（它本来会发生一次经济动作，却停在了门口）；
       · 一次被授权、并且**真的走到了一条 intent** 的提议（它把 consumer
         与那条 Agent Intent 连起来 —— §7 第四问的答案）。

     重放 / 去重窗口内的重复提议**不写**：它们没有产生新事实，而
     "同一个模型输出重复 20 次产生 20 行审计"正是 §7 明确不要的东西。
     P22-8 自己的幂等与 §10 去重让这两类情形可被认出（replayed /
     suppressed）。 */
  function recordCapabilityAudit(consumer, capability, decision, reasonCode, agentIntentId) {
    if (!canRecordAudit) {
      return { recorded: false, failure: 'store-cannot-record-capability-audit' };
    }
    try {
      const written = store.appendCapabilityAudit({
        consumerId: consumer,
        capability: capability,
        decision: decision,
        reasonCode: reasonCode == null ? null : String(reasonCode),
        agentIntentId: agentIntentId == null ? null : String(agentIntentId)
      });
      if (written && written.ok === true) {
        return { recorded: true, revision: written.revision == null ? null : written.revision };
      }
      return { recorded: false, failure: 'capability-audit-rejected' };
    } catch (error) {
      /* 审计是**关于**一次已经发生的决定的记录。它失败不该把一次拒绝变成
         一次崩溃，也不该把一次成功的提议报成失败 —— 但它**必须**留下痕迹：
         `auditFailure` 会被放进返回值，而不是被吞掉。 */
      return { recorded: false, failure: String((error && error.message) || error) };
    }
  }

  function auditFields(audit) {
    return {
      auditRecorded: audit.recorded === true,
      auditRevision: audit.revision == null ? null : audit.revision,
      auditFailure: audit.recorded === true ? null : (audit.failure || null)
    };
  }

  function report(consumer, capability, decision, extra) {
    if (!logger) return;
    try { logger('info', 'econ.capability.decided', { consumer: consumer, capability: capability, decision: decision, reasonCode: (extra && extra.reasonCode) || null }); } catch (_) { /* 日志不是事实 */ }
  }

  /* 一次被拒的提议：写一行 DENIED，然后**不碰 store**。
     ★ "不碰 store"不是这句话的效果，而是这段代码里没有那个调用。 */
  function refuse(consumer, capability, decision, extra) {
    const audit = recordCapabilityAudit(consumer, capability, C.CAPABILITY_DECISION.CAPABILITY_DENIED, decision.reasonCode, null);
    report(consumer, capability, C.CAPABILITY_DECISION.CAPABILITY_DENIED, { reasonCode: decision.reasonCode });
    return refusalOf(decision, Object.assign({}, auditFields(audit), extra || {}));
  }

  /* ── 两条被门控的提议路径 ────────────────────────────────────────────
     它们是本仓库里**唯一**两处调用 P22-8 写入口的代码。字面成员名，
     没有分派表。 */
  function proposeFor(consumer, decision, input) {
    const ignored = ignoredKeysOf(input, PROPOSE_INPUT_KEYS);
    const o = input || {};
    /* ★ 这里构造 store 的输入：**只有**两个键，而且都来自白名单。
       调用方多传的任何东西（例如 consumerId / capability / approved /
       autoAllow / meta）都不会被转发。 */
    const result = store.proposeAgentPurchaseIntent({
      proposal: o.proposal,
      idempotencyKey: o.idempotencyKey
    });
    const intentId = result && result.intentId != null ? String(result.intentId) : null;
    const alreadyKnown = !!result && (result.replayed === true || result.suppressed === true);
    const audit = (intentId != null && !alreadyKnown)
      ? recordCapabilityAudit(consumer, decision.capability, C.CAPABILITY_DECISION.CAPABILITY_GRANTED, null, intentId)
      : { recorded: false, revision: null, failure: null, skipped: true };
    report(consumer, decision.capability, C.CAPABILITY_DECISION.CAPABILITY_GRANTED, {});
    return Object.assign({}, result, {
      consumer: consumer,
      capability: decision.capability,
      gateDecision: C.CAPABILITY_DECISION.CAPABILITY_GRANTED,
      ignoredInputKeys: ignored,
      /* §5：门**没有**替经济做决定 —— 这句话在返回值里，因此一个读到
         ok:true 的调用方同时读到"这不是一笔购买被批准了"。 */
      capabilityIsNotEconomyAuthority: true,
      economyDecisionStillPending: true,
      auditRecorded: audit.recorded === true,
      auditRevision: audit.revision == null ? null : audit.revision,
      auditFailure: audit.recorded === true || audit.skipped === true ? null : (audit.failure || null)
    });
  }

  function resumeFor(consumer, decision, input) {
    const ignored = ignoredKeysOf(input, RESUME_INPUT_KEYS);
    const o = input || {};
    const result = store.resumeAgentPurchaseIntent({
      agentIntentId: o.agentIntentId,
      approvalId: o.approvalId,
      idempotencyKey: o.idempotencyKey
    });
    const nested = result && result.result && typeof result.result === 'object' ? result.result : null;
    const intentId = result && result.intentId != null ? String(result.intentId)
      : (nested && nested.intentId != null ? String(nested.intentId)
        : (result && result.intent && result.intent.agentIntentId != null ? String(result.intent.agentIntentId) : null));
    const alreadyKnown = !!result && result.replayed === true;
    const audit = (intentId != null && !alreadyKnown)
      ? recordCapabilityAudit(consumer, decision.capability, C.CAPABILITY_DECISION.CAPABILITY_GRANTED, null, intentId)
      : { recorded: false, revision: null, failure: null, skipped: true };
    report(consumer, decision.capability, C.CAPABILITY_DECISION.CAPABILITY_GRANTED, {});
    return Object.assign({}, result, {
      consumer: consumer,
      capability: decision.capability,
      gateDecision: C.CAPABILITY_DECISION.CAPABILITY_GRANTED,
      ignoredInputKeys: ignored,
      capabilityIsNotEconomyAuthority: true,
      economyDecisionStillPending: true,
      auditRecorded: audit.recorded === true,
      auditRevision: audit.revision == null ? null : audit.revision,
      auditFailure: audit.recorded === true || audit.skipped === true ? null : (audit.failure || null)
    });
  }

  /* ── bind(consumer)：唯一公开的身份绑定 ──────────────────────────────
     ★ 未知 / 缺失 consumer **不返回 null**，而是返回一个"每个方法都拒绝"
     的句柄。两个理由：
       · null 会把 fail closed 的责任推给调用方 —— 而一个 `if (!handle)`
         写漏了就是一次崩溃或一次绕过；
       · 一个拒绝句柄的返回值与一次正常的门拒绝**形状完全相同**，因此
         调用方只有一条代码路径。 */
  function bind(consumerId) {
    const normalized = C.normalizeEconomyConsumerId(consumerId);
    const consumer = normalized.ok === true ? normalized.consumer : null;
    const capabilities = consumer == null
      ? Object.freeze([])
      : C.grantedCapabilitiesOf(consumer, revoked);

    function decide(capability) {
      if (configurationCorrupt) {
        return {
          consumer: consumer, capability: capability,
          decision: C.CAPABILITY_DECISION.CAPABILITY_DENIED,
          granted: false, reasonCode: C.CAPABILITY_DENY_REASON.CONFIGURATION_CORRUPT,
          errors: config.errors.slice(), capabilities: capabilities
        };
      }
      const raw = C.checkEconomyCapability({ consumer: consumerId, capability: capability, config: { revokedCapabilities: revoked } });
      /* ★ 一个绑不上的 consumer：`consumerId` 原样交给判定器，于是它会给出
         MISSING_CONSUMER / UNKNOWN_CONSUMER —— 而不是被这里悄悄替换成某个
         真实身份。 */
      return raw;
    }

    function proposePurchaseIntent(input) {
      const decision = decide(C.CAPABILITY.PROPOSE_PURCHASE);
      if (decision.granted !== true) return refuse(consumer, C.CAPABILITY.PROPOSE_PURCHASE, decision, { ignoredInputKeys: ignoredKeysOf(input, PROPOSE_INPUT_KEYS) });
      /* ★ 未装配 store 时仍然是拒绝 —— 一个没有 store 的门不是"不管了"，
         而是"什么都批不了"。 */
      if (!store) {
        return refuse(consumer, C.CAPABILITY.PROPOSE_PURCHASE, Object.assign({}, decision, {
          granted: false, decision: C.CAPABILITY_DECISION.CAPABILITY_DENIED,
          reasonCode: C.CAPABILITY_DENY_REASON.CONFIGURATION_CORRUPT,
          errors: ['economy-store-not-assembled']
        }), { ignoredInputKeys: ignoredKeysOf(input, PROPOSE_INPUT_KEYS) });
      }
      return proposeFor(consumer, decision, input);
    }

    function resumeApprovedPurchase(input) {
      const decision = decide(C.CAPABILITY.RESUME_APPROVED_PURCHASE);
      if (decision.granted !== true) return refuse(consumer, C.CAPABILITY.RESUME_APPROVED_PURCHASE, decision, { ignoredInputKeys: ignoredKeysOf(input, RESUME_INPUT_KEYS) });
      if (!store) {
        return refuse(consumer, C.CAPABILITY.RESUME_APPROVED_PURCHASE, Object.assign({}, decision, {
          granted: false, decision: C.CAPABILITY_DECISION.CAPABILITY_DENIED,
          reasonCode: C.CAPABILITY_DENY_REASON.CONFIGURATION_CORRUPT,
          errors: ['economy-store-not-assembled']
        }), { ignoredInputKeys: ignoredKeysOf(input, RESUME_INPUT_KEYS) });
      }
      return resumeFor(consumer, decision, input);
    }

    return Object.freeze({
      consumer: consumer,
      anchor: C.runtimeAnchorOfConsumer(consumer),
      capabilities: Object.freeze(capabilities.slice()),
      proposePurchaseIntent: proposePurchaseIntent,
      resumeApprovedPurchase: resumeApprovedPurchase
    });
  }

  /* 读面：让 /security 与运维能读到"这台节点此刻的准入表"，而不必读代码。
     它是纯数据，不含任何写能力。 */
  function describe() {
    const rows = C.ECONOMY_CONSUMERS.map(function (consumer) {
      return {
        consumer: consumer,
        anchor: C.CONSUMER_RUNTIME_ANCHOR[consumer],
        capabilities: C.grantedCapabilitiesOf(consumer, revoked),
        declaredCapabilities: C.capabilitiesOfConsumer(consumer)
      };
    });
    return Object.freeze({
      domain: C.DOMAIN,
      gate: 'economy-capability-gate',
      capabilities: C.CAPABILITIES,
      capabilitiesAreNotEconomyAuthority: true,
      consumers: Object.freeze(rows),
      absentSurfaces: C.CAPABILITY_SURFACES_NOT_PRESENT,
      revokedCapabilities: revoked,
      configurationCorrupt: configurationCorrupt,
      configurationErrors: configurationCorrupt ? config.errors.slice() : [],
      storeAssembled: !!store,
      canRecordCapabilityAudit: canRecordAudit,
      /* §6：这一层**不**提供任何底层动词。 */
      exposesLowLevelEconomyWrites: false,
      exposesGenericDispatch: false
    });
  }

  return Object.freeze({
    checkEconomyCapability: checkEconomyCapability,
    bind: bind,
    describe: describe,
    HANDLE_KEYS: HANDLE_KEYS,
    PROPOSE_INPUT_KEYS: PROPOSE_INPUT_KEYS,
    RESUME_INPUT_KEYS: RESUME_INPUT_KEYS
  });
}

module.exports = createEconomyCapabilityGate;
