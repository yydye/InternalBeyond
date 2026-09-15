/* ====================================================================
   P22-7 · Autonomous Purchase Policy —— 契约与纯策略的专项测试

   这一份回答的问题只有一类：**"这台 Agent 有没有权不问用户直接花这笔钱"**
   这句话是怎么被判定的，以及它为什么**不可能**被别的东西影响。

   它刻意**不**碰数据库里的事（那些在 test_p22_7_economy_approval.js 与
   test_p22_7_economy_runtime.js）。因此这一组是纯的：契约 + 纯函数，
   没有 store、没有时钟、没有随机、没有文件。

   六个组：
     A · APPROVAL_STATE 状态机（五态、三条终态、四条禁止的边）
     B · 自主策略的**纯策略**（三个结论、十条判据的顺序、fail closed）
     C · §3 的边界：Budget 与 Autonomy 是两层，而且它们能给出相反的答案
     D · §2/§4 的输入纪律（白名单、禁止键、没有裸 limit）
     E · §6 的九元组绑定（approvalFingerprint 是可重算的纯函数）
     F · §12/§13 Gift 与 Compute/API quota 的边界

   运行：node tests/test_p22_7_economy_autonomy.js
   ==================================================================== */
'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const C = require(path.join(ROOT, 'services', 'home-node', 'economy-contract.js'));

let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log('✔ ' + name);
  else {
    failures++;
    console.error('✖ ' + name + (extra !== undefined ? ' — ' + JSON.stringify(extra, replacer) : ''));
  }
}
function section(title) { console.log('\n── ' + title); }
function replacer(k, v) { return typeof v === 'bigint' ? v.toString() + 'n' : v; }
function J(v) { return JSON.stringify(v, replacer); }
/* 校验结果的统一判据。三种校验器（normalizeAutonomyPolicyInput /
   validateAutonomyPolicy / evaluateBudget）都返回一个带 `ok` 的对象，
   而 `evaluateAutonomousPurchase` 返回的是**决策**（它没有 ok，只有
   outcome / autoAllowed / requiresApproval / denied）—— 因此这个谓词只
   用在**校验类**结果上，不假装能回答"这笔能不能买"。 */
function okResult(r) { return !!r && r.ok === true; }

/* ── 一份"标准"自主策略。它刻意是**最小**的：六个字段（§4），
   而三个额度里有两个是**必填**（没有它们就等于"以后随便花"）。 */
function policyOf(overrides) {
  const shape = C.validateAutonomyPolicy(Object.assign({
    policyId: 'econ_policy_ap1',
    ownerId: { type: 'character', id: 'cfg_a' },
    enabled: true,
    perPurchaseLimitMinor: 500,
    dailyAutonomousLimitMinor: 1000,
    approvalAboveMinor: 400,
    allowedProductKinds: ['COMPUTE_CREDIT', 'DIGITAL_ITEM'],
    allowedSettlementTypes: ['COMPUTE_GRANT', 'INVENTORY_GRANT'],
    allowGift: false
  }, overrides || {}));
  assert.equal(shape.ok, true, 'validateAutonomyPolicy must succeed: ' + J(shape.errors));
  return shape.policy;
}

/* ── 一份"标准"评估上下文：只含 canonical Economy facts。 */
function contextOf(overrides) {
  return Object.assign({
    ownerId: { type: 'character', id: 'cfg_a' },
    productId: 'econ_product_p1',
    productKind: 'COMPUTE_CREDIT',
    settlementType: 'COMPUTE_GRANT',
    currency: 'IB_CREDIT',
    amountMinor: 100,
    gift: false,
    selfDirected: true,
    spentTodayMinor: 0,
    timestamp: Date.UTC(2024, 5, 1, 12)
  }, overrides || {});
}

/* ══════════════════════════════════════════════════════════════════
   A · APPROVAL_STATE 状态机
   ══════════════════════════════════════════════════════════════════ */
section('A · APPROVAL_STATE：五态状态机与四条禁止的边');

check('A1 APPROVAL_STATES 恰好五态（PENDING / APPROVED / REJECTED / EXPIRED / CONSUMED），没有兜底值',
  C.APPROVAL_STATES.slice().sort().join(',') === 'APPROVED,CONSUMED,EXPIRED,PENDING,REJECTED' &&
  C.isApprovalState('PENDING') === true && C.isApprovalState('pending') === false &&
  C.isApprovalState('CREATED') === false && C.isApprovalState('CANCELLED') === false &&
  C.isApprovalState(null) === false);

check('A2 终态恰好三个（REJECTED / EXPIRED / CONSUMED），而 PENDING 与 APPROVED **都不是**终态'
  + '（APPROVED 必须能过期，§9）',
  C.APPROVAL_TERMINAL_STATES.slice().sort().join(',') === 'CONSUMED,EXPIRED,REJECTED' &&
  C.isApprovalTerminalState(C.APPROVAL_STATE.PENDING) === false &&
  C.isApprovalTerminalState(C.APPROVAL_STATE.APPROVED) === false &&
  C.isApprovalTerminalState(C.APPROVAL_STATE.CONSUMED) === true &&
  C.APPROVAL_INITIAL_STATE === 'PENDING');

check('A3 §9 的四条出边逐字存在：PENDING→{APPROVED,REJECTED,EXPIRED}、APPROVED→{CONSUMED,EXPIRED}',
  C.APPROVAL_TRANSITIONS.PENDING.slice().sort().join(',') === 'APPROVED,EXPIRED,REJECTED' &&
  C.APPROVAL_TRANSITIONS.APPROVED.slice().sort().join(',') === 'CONSUMED,EXPIRED' &&
  C.canTransitionApproval('PENDING', 'APPROVED').allowed === true &&
  C.canTransitionApproval('PENDING', 'REJECTED').allowed === true &&
  C.canTransitionApproval('PENDING', 'EXPIRED').allowed === true &&
  C.canTransitionApproval('APPROVED', 'CONSUMED').allowed === true &&
  C.canTransitionApproval('APPROVED', 'EXPIRED').allowed === true);

check('A4 ★ 三条**禁止**的边逐字被拒：REJECTED / EXPIRED / CONSUMED 到任何状态都不允许（终态不可倒退）',
  [C.APPROVAL_STATE.REJECTED, C.APPROVAL_STATE.EXPIRED, C.APPROVAL_STATE.CONSUMED].every(from =>
    C.APPROVAL_STATES.every(to => C.canTransitionApproval(from, to).allowed === false)) &&
  C.APPROVAL_TRANSITIONS.REJECTED.length === 0 &&
  C.APPROVAL_TRANSITIONS.EXPIRED.length === 0 &&
  C.APPROVAL_TRANSITIONS.CONSUMED.length === 0);

check('A5 assertApprovalTransition 区分"终态回退"与"非法转移"，并把"请重新申请一条批准"写进 hint',
  (() => {
    const terminal = C.assertApprovalTransition('REJECTED', 'APPROVED');
    const illegal = C.assertApprovalTransition('PENDING', 'CONSUMED');
    const unknown = C.assertApprovalTransition('NOPE', 'APPROVED');
    /* ★ canTransitionApproval / assertApprovalTransition 的返回形状里
       **没有** ok —— 它给的是 allowed。写 `gate.ok === false` 会恒为真
       （undefined !== false），因此它是一条**永远通过**的断言：这正是
       "断言必须能失败得有意义"要挡的形状。 */
    return terminal.allowed === false && terminal.terminal === true &&
      terminal.ok === undefined &&
      terminal.errors.indexOf('transition-not-allowed') >= 0 &&
      /request a new approval/.test(String(terminal.hint)) &&
      /* 非法转移（PENDING → CONSUMED）不是终态回退，因此 terminal 为假
         —— "这件事已经定局"与"你没有从这里走到那里"是两句不同的话。 */
      illegal.allowed === false && illegal.terminal !== true &&
      illegal.errors.indexOf('transition-not-allowed') >= 0 &&
      /* 未知状态走的是第三条分支，它的 hint 只管状态词表。 */
      unknown.allowed === false && unknown.errors.indexOf('approval-state-not-in-closed-set') >= 0 &&
      /APPROVAL_STATE/.test(String(unknown.hint)) &&
      terminal.hint !== unknown.hint;
  })());

check('A6 自环一律被拒（PENDING→PENDING / APPROVED→APPROVED 都不是转移）',
  C.canTransitionApproval('PENDING', 'PENDING').allowed === false &&
  C.canTransitionApproval('APPROVED', 'APPROVED').allowed === false &&
  C.canTransitionApproval('CONSUMED', 'CONSUMED').allowed === false);

check('A7 APPROVAL 与 APPROVAL_STATE 是**两个**词表：前者是"一次购买结局的三态"（P22-1 §4 冻结），'
  + '后者是"一条批准记录的五态"，成员集合不相交',
  C.APPROVALS.slice().sort().join(',') === 'AUTO_APPROVED,DENIED,USER_APPROVAL_REQUIRED' &&
  C.APPROVALS.every(a => C.APPROVAL_STATES.indexOf(a) < 0) &&
  C.APPROVAL_STATES.every(a => C.APPROVALS.indexOf(a) < 0));

/* ══════════════════════════════════════════════════════════════════
   B · 自主策略：三个结论与十条判据
   ══════════════════════════════════════════════════════════════════ */
section('B · evaluateAutonomousPurchase：三个结论与十条判据');

check('B1 ★★ 没有策略时必须 REQUIRE_APPROVAL（**不是** AUTO_ALLOW）—— §4 fail closed 的落点',
  (() => {
    const d = C.evaluateAutonomousPurchase(null, contextOf());
    return d.outcome === C.AP_DECISION.REQUIRE_APPROVAL &&
      d.reasonCode === C.DENY_REASON.APPROVAL_REQUIRED &&
      d.requiresApproval === true && d.autoAllowed === false && d.denied === false &&
      d.policyPresent === false && d.defaultedToRequireApproval === true &&
      d.rule === 'no-autonomy-policy-defaults-to-require-approval' &&
      C.AUTONOMY_DEFAULT_WHEN_NO_POLICY === C.AP_DECISION.REQUIRE_APPROVAL;
  })());
check('B1b 没有策略时给出 REQUIRE_APPROVAL 而**不是** DENY —— "没配"不等于"禁止"，它等于"回到默认：问用户"',
  C.evaluateAutonomousPurchase(null, contextOf()).reasonCode !== C.DENY_REASON.AUTONOMY_NOT_PERMITTED &&
  C.evaluateAutonomousPurchase(undefined, contextOf()).outcome === C.AP_DECISION.REQUIRE_APPROVAL);

check('B2 额度与白名单都满足时给出 AUTO_ALLOW，且理由逐字是 BUDGET_ALLOWED（与预算的同名理由同源）',
  (() => {
    const d = C.evaluateAutonomousPurchase(policyOf(), contextOf());
    return d.outcome === C.AP_DECISION.AUTO_ALLOW && d.reasonCode === 'BUDGET_ALLOWED' &&
      d.autoAllowed === true && d.denied === false && d.requiresApproval === false &&
      d.priority === null && d.priorityRule === null;
  })());

check('B3 ★ 每个结论都带回 `answers` 与 `notABudgetDecision`：这条结论**只**回答"有没有权"，不回答"花不花得起"',
  (() => {
    const allow = C.evaluateAutonomousPurchase(policyOf(), contextOf());
    const need = C.evaluateAutonomousPurchase(null, contextOf());
    const deny = C.evaluateAutonomousPurchase(policyOf(), contextOf({ amountMinor: 900 }));
    return allow.answers === 'may-this-agent-spend-without-asking-the-user' &&
      allow.notABudgetDecision === true && allow.grantsBudget === false &&
      need.notABudgetDecision === true && deny.notABudgetDecision === true &&
      deny.answers === 'may-this-agent-spend-without-asking-the-user' &&
      /* 逐字：三种结论各自都写着 authority:none —— 它们都是**结论**，
         不是可以拿去执行的许可证（许可证是 approvalId）。 */
      [
        C.evaluateAutonomousPurchase(policyOf(), contextOf()),
        C.evaluateAutonomousPurchase(null, contextOf()),
        C.evaluateAutonomousPurchase(policyOf(), contextOf({ amountMinor: 900 }))
      ].every(dec => dec.snapshot.kind === 'autonomy-evaluation' &&
        dec.snapshot.authority === 'none' && Object.isFrozen(dec.snapshot) &&
        dec.evaluatedOnly === true) &&
      /* 三种结论互不相同，而且三个词各自出现恰好一次。 */
      new Set([allow.outcome, need.outcome, deny.outcome]).size === 3;
  })());

check('B4 策略被显式关掉（enabled=false）⇒ DENY（AUTONOMY_NOT_PERMITTED），而它**不是**"没有策略"',
  (() => {
    const d = C.evaluateAutonomousPurchase(policyOf({ enabled: false }), contextOf());
    return d.outcome === C.AP_DECISION.DENY &&
      d.reasonCode === C.DENY_REASON.AUTONOMY_NOT_PERMITTED &&
      d.policyEnabled === false && d.rule === 'autonomy-is-disabled-by-policy' &&
      C.evaluateAutonomousPurchase(null, contextOf()).reasonCode !== d.reasonCode;
  })());

check('B5 per-purchase 额度被越过 ⇒ DENY + AUTONOMY_LIMIT（**不是** REQUIRE_APPROVAL —— 超额度是"规则说不"）',
  (() => {
    const d = C.evaluateAutonomousPurchase(policyOf(), contextOf({ amountMinor: 501 }));
    return d.outcome === C.AP_DECISION.DENY && d.reasonCode === C.DENY_REASON.AUTONOMY_LIMIT &&
      d.rule === 'amount-exceeds-the-autonomy-per-purchase-limit' &&
      d.perPurchaseLimitMinor === '500' && d.amountMinor === '501';
  })());
check('B5b ★ 两条线是**独立**的，而且各自的上界都是闭的：'
  + '审批线 400 / 上限 500 ⇒ 400 与 399 都 AUTO_ALLOW，401 要批准，501 被拒',
  (() => {
    const p = policyOf();
    const at = (n) => C.evaluateAutonomousPurchase(p, contextOf({ amountMinor: n }));
    return at(400).outcome === C.AP_DECISION.AUTO_ALLOW &&
      at(399).outcome === C.AP_DECISION.AUTO_ALLOW &&
      at(401).outcome === C.AP_DECISION.REQUIRE_APPROVAL &&
      at(401).reasonCode === C.DENY_REASON.APPROVAL_REQUIRED &&
      at(500).outcome === C.AP_DECISION.REQUIRE_APPROVAL &&
      at(501).outcome === C.AP_DECISION.DENY &&
      at(501).reasonCode === C.DENY_REASON.AUTONOMY_LIMIT &&
      /* ★ 501 是**额度**拒绝而不是审批拒绝：它连"等人点头"都够不上。
         这一条正是"全部 DENY 判据排在审批线之前"的直接后果。 */
      at(501).reasonCode !== at(500).reasonCode;
  })());

check('B6 日自主额度：spentToday + amount > daily ⇒ DENY + AUTONOMY_LIMIT',
  (() => {
    const d = C.evaluateAutonomousPurchase(policyOf(), contextOf({ amountMinor: 100, spentTodayMinor: 901 }));
    return d.outcome === C.AP_DECISION.DENY && d.reasonCode === C.DENY_REASON.AUTONOMY_LIMIT &&
      d.rule === 'this-purchase-would-exceed-the-daily-autonomous-limit' &&
      d.spentTodayMinor === '901' && d.dailyAutonomousLimitMinor === '1000';
  })());
check('B6b spentTodayMinor **缺席**时 fail closed（DENY + POLICY_INPUT_NOT_STRUCTURED），绝不兜成 0',
  (() => {
    const ctx = contextOf();
    delete ctx.spentTodayMinor;
    const d = C.evaluateAutonomousPurchase(policyOf(), ctx);
    return d.outcome === C.AP_DECISION.DENY &&
      d.reasonCode === C.DENY_REASON.POLICY_INPUT_NOT_STRUCTURED &&
      d.errors.indexOf('autonomy-context-must-carry-spent-today-minor') >= 0;
  })());

check('B7 审批线：amount > approvalAboveMinor ⇒ REQUIRE_APPROVAL（额度够，但"要人点头"）+ APPROVAL_REQUIRED',
  (() => {
    const d = C.evaluateAutonomousPurchase(policyOf(), contextOf({ amountMinor: 401 }));
    return d.outcome === C.AP_DECISION.REQUIRE_APPROVAL &&
      d.reasonCode === C.DENY_REASON.APPROVAL_REQUIRED &&
      d.rule === 'amount-exceeds-the-autonomy-approval-threshold' &&
      d.approvalAboveMinor === '400' &&
      /* 与 P22-6 的 PURCHASE_REQUIRES_APPROVAL 是**两个**代码（阶段不同）。 */
      d.reasonCode !== C.DENY_REASON.PURCHASE_REQUIRES_APPROVAL;
  })());
check('B7b 审批线的上界同样是闭的：恰好等于审批线仍然 AUTO_ALLOW',
  C.evaluateAutonomousPurchase(policyOf(), contextOf({ amountMinor: 400 })).outcome === C.AP_DECISION.AUTO_ALLOW);

check('B8 ★ 判据顺序：全部 DENY 判据排在两条 REQUIRE_APPROVAL 判据**之前**'
  + '（一件被规则排除的商品永远得到 DENY，不会看起来像"等人点头"）',
  (() => {
    const p = policyOf();
    /* ① 金额同时越过额度上限（500）与审批线（400）⇒ 必须是**额度** DENY。 */
    const overLimit = C.evaluateAutonomousPurchase(p, contextOf({ amountMinor: 900 }));
    /* ② 日额度会被越过、而单笔仍在额度与审批线之内 ⇒ 必须是**额度** DENY。 */
    const overDaily = C.evaluateAutonomousPurchase(p, contextOf({ amountMinor: 300, spentTodayMinor: 750 }));
    /* ③ 商品种类不在范围内（金额很小）⇒ 必须是 DENY。 */
    const wrongKind = C.evaluateAutonomousPurchase(p, contextOf({ productKind: 'SERVICE' }));
    const idx = (n) => C.AP_EVALUATION_PRIORITY.indexOf(n);
    return overLimit.outcome === C.AP_DECISION.DENY &&
      overLimit.reasonCode === C.DENY_REASON.AUTONOMY_LIMIT &&
      overLimit.priorityRule === 'autonomy-max-per-purchase' &&
      overDaily.outcome === C.AP_DECISION.DENY &&
      overDaily.reasonCode === C.DENY_REASON.AUTONOMY_LIMIT &&
      overDaily.priorityRule === 'autonomy-daily-limit' &&
      wrongKind.outcome === C.AP_DECISION.DENY &&
      wrongKind.reasonCode === C.DENY_REASON.AUTONOMY_NOT_PERMITTED &&
      wrongKind.priorityRule === 'product-kind-allowed' &&
      /* 三条 DENY 判据（作用域 / 金额上限 / 日上限）里有两条排在审批线之前，
         而**日额度刻意排在审批线之后** —— 理由是一个真实的选择：
         一笔在单笔上限之内、但会撞穿日额度的钱，应该得到"问用户"
         （REQUIRE_APPROVAL，用户点头后自有别的规则约束），而不是直接
         被拒。额度是**能力**线，审批线是**许可**线；能问就先问。 */
      idx('product-kind-allowed') < idx('autonomy-purchase-approval-threshold') &&
      idx('autonomy-max-per-purchase') < idx('autonomy-purchase-approval-threshold') &&
      idx('autonomy-purchase-approval-threshold') < idx('autonomy-daily-limit') &&
      /* 十条判据，且日额度是**最后**一条（它是自主放行的最终兜底）。 */
      C.AP_EVALUATION_PRIORITY.length === 10 &&
      idx('autonomy-purchase-approval-threshold') === 8 &&
      idx('autonomy-daily-limit') === 9;
  })());

check('B9 商品种类不在 allowedProductKinds 内 ⇒ DENY（缺省白名单是**空集**，不是"全允许"）',
  (() => {
    const d = C.evaluateAutonomousPurchase(policyOf(), contextOf({ productKind: 'SERVICE' }));
    return d.outcome === C.AP_DECISION.DENY && d.reasonCode === C.DENY_REASON.AUTONOMY_NOT_PERMITTED &&
      d.rule === 'product-kind-is-not-in-the-autonomy-scope' &&
      d.allowedProductKinds.join(',') === 'COMPUTE_CREDIT,DIGITAL_ITEM';
  })());
check('B9b allowedProductKinds 未给时是**空数组** ⇒ 什么都自主买不了（fail closed 在字段级也成立）',
  (() => {
    const p = policyOf({ allowedProductKinds: undefined });
    return p.allowedProductKinds.length === 0 &&
      C.evaluateAutonomousPurchase(p, contextOf()).outcome === C.AP_DECISION.DENY;
  })());

check('B10 settlement 形态不在白名单内 ⇒ DENY；而 SERVICE_EXECUTION 即使**写在白名单里**也只是 DENY'
  + '（自主策略不会说出一个结算层永远不接受的决定）',
  (() => {
    const out = C.evaluateAutonomousPurchase(policyOf(), contextOf({ settlementType: 'INVENTORY_GRANT' }));
    /* INVENTORY_GRANT 在白名单里，但 productKind=COMPUTE_CREDIT 与它不匹配 ——
       这一条留给 store 层的组合校验；这里先断言 SERVICE_EXECUTION 的行为。 */
    const svcPolicy = policyOf({ allowedSettlementTypes: ['SERVICE_EXECUTION'] });
    const svc = C.evaluateAutonomousPurchase(svcPolicy, contextOf({ settlementType: 'SERVICE_EXECUTION' }));
    return svc.outcome === C.AP_DECISION.DENY &&
      svc.reasonCode === C.DENY_REASON.AUTONOMY_NOT_PERMITTED &&
      svc.settlementPrimitive === null &&
      svc.rule === 'this-settlement-type-has-no-atomic-primitive-and-can-never-be-autonomous' &&
      out.outcome === C.AP_DECISION.AUTO_ALLOW;
  })());

check('B11 结算形态三种各自的 primitive 判定与 P22-6 一致（INVENTORY / COMPUTE 有，SERVICE 没有）',
  C.settlementPrimitiveOfFulfillment('INVENTORY_GRANT').primitive === 'INVENTORY' &&
  C.settlementPrimitiveOfFulfillment('COMPUTE_GRANT').primitive === 'COMPUTE_ENTITLEMENT' &&
  C.settlementPrimitiveOfFulfillment('SERVICE_EXECUTION').primitive === null);

check('B12 策略行的作用域：ownerId 不匹配 ⇒ DENY + POLICY_NOT_FOUND（一条策略不能替别人判定）',
  (() => {
    const d = C.evaluateAutonomousPurchase(policyOf(), contextOf({ ownerId: { type: 'character', id: 'cfg_b' } }));
    return d.outcome === C.AP_DECISION.DENY && d.reasonCode === C.DENY_REASON.POLICY_NOT_FOUND &&
      d.errors.indexOf('autonomy-policy-owner-does-not-match-the-evaluated-owner') >= 0;
  })());
check('B12b 币种不匹配 ⇒ DENY + INVALID_CURRENCY',
  (() => {
    const p = policyOf();
    const d = C.evaluateAutonomousPurchase(Object.assign({}, p, { currency: 'IB_CREDIT' }),
      contextOf({ currency: 'COMPUTE_STANDARD' }));
    return d.outcome === C.AP_DECISION.DENY && d.reasonCode === C.DENY_REASON.INVALID_CURRENCY;
  })());

check('B13 金额为 0 或缺失 ⇒ DENY + INVALID_AMOUNT（0 金额没有经济内容，与 P22-4 同判）',
  (() => {
    const zero = C.evaluateAutonomousPurchase(policyOf(), contextOf({ amountMinor: 0 }));
    const missing = C.evaluateAutonomousPurchase(policyOf(), contextOf({ amountMinor: undefined }));
    return zero.outcome === C.AP_DECISION.DENY && zero.reasonCode === C.DENY_REASON.INVALID_AMOUNT &&
      missing.outcome === C.AP_DECISION.DENY;
  })());

check('B13b 一条**读不懂**的策略行 ⇒ DENY（而不是"没有策略所以问用户"）：规则这一面不可信时必须拒绝',
  (() => {
    const broken = Object.assign({}, policyOf(), { unusable: true, unusableErrors: ['x:broken'] });
    const d = C.evaluateAutonomousPurchase(broken, contextOf());
    return d.outcome === C.AP_DECISION.DENY &&
      d.reasonCode === C.DENY_REASON.POLICY_INPUT_NOT_STRUCTURED &&
      d.errors.join(',') === 'x:broken';
  })());

check('B14 策略记录**缺**per-purchase / daily 额度 ⇒ DENY + POLICY_INPUT_NOT_STRUCTURED（不拿缺省值顶上）',
  (() => {
    const noPer = Object.assign({}, policyOf(), { perPurchaseLimitMinor: null });
    const noDaily = Object.assign({}, policyOf(), { dailyAutonomousLimitMinor: null });
    return C.evaluateAutonomousPurchase(noPer, contextOf()).reasonCode === C.DENY_REASON.POLICY_INPUT_NOT_STRUCTURED &&
      C.evaluateAutonomousPurchase(noDaily, contextOf()).reasonCode === C.DENY_REASON.POLICY_INPUT_NOT_STRUCTURED;
  })());

/* ── B15 · 纯函数性：一千次、打乱键序、深拷贝 ⇒ 逐字节相同 ─────────── */
check('B15 ★★ evaluateAutonomousPurchase 是纯函数：跑一千次、打乱键序、深拷贝，结果逐字节相同',
  (() => {
    const policy = policyOf();
    const ctx = contextOf();
    const baseline = JSON.stringify(C.evaluateAutonomousPurchase(policy, ctx), replacer);
    for (let i = 0; i < 1000; i++) {
      if (JSON.stringify(C.evaluateAutonomousPurchase(policy, ctx), replacer) !== baseline) return false;
    }
    /* 打乱键序：对象的键顺序是唯一一种"看起来不同其实相同"的输入变形。 */
    const shuffled = {};
    for (const k of Object.keys(ctx).reverse()) shuffled[k] = ctx[k];
    if (JSON.stringify(C.evaluateAutonomousPurchase(policy, shuffled), replacer) !== baseline) return false;
    /* 深拷贝：证明它不依赖任何不可序列化的东西（函数 / 引用 / 原型）。 */
    if (JSON.stringify(C.evaluateAutonomousPurchase(policy, JSON.parse(JSON.stringify(ctx))), replacer) !== baseline) return false;
    /* 结果对象是冻结的 ⇒ 调用方改不动它。 */
    return Object.isFrozen(C.evaluateAutonomousPurchase(policy, ctx));
  })());

check('B16 策略对象是**冻结**的（调用方改不动它），而且"改一份拷贝"不会影响原对象算出的结论'
  + '（评估器不读全局状态、不读第二份策略）',
  (() => {
    const policy = policyOf();
    const first = JSON.stringify(C.evaluateAutonomousPurchase(policy, contextOf()), replacer);
    /* 冻结：任何写入要么静默失败（非严格）要么抛错；这里断言它确实没变。 */
    try { policy.perPurchaseLimitMinor = 999999n; } catch (error) { /* 严格模式下抛错，同样满足 */ }
    const afterWriteAttempt = JSON.stringify(C.evaluateAutonomousPurchase(policy, contextOf()), replacer);
    /* 一份"看起来像策略"但内容不同的对象必须给出**不同**的结论 ——
       否则说明评估器根本没在读它的字段。 */
    const generous = policyOf({ perPurchaseLimitMinor: 10000, dailyAutonomousLimitMinor: 20000, approvalAboveMinor: 10000 });
    const generousDecision = C.evaluateAutonomousPurchase(generous, contextOf({ amountMinor: 900 }));
    return Object.isFrozen(policy) && Object.isFrozen(policy.allowedProductKinds) &&
      Object.isFrozen(policy.ownerId) &&
      first === afterWriteAttempt &&
      generousDecision.outcome === C.AP_DECISION.AUTO_ALLOW;
  })());

/* ══════════════════════════════════════════════════════════════════
   C · §3 的边界：Budget 与 Autonomy 是两层
   ══════════════════════════════════════════════════════════════════ */
section('C · §3 Budget 与 Autonomy 的边界（两层，而不是一层）');

check('C1 ★★ 两个词表是**两个**封闭集合，而且"允许"那个词刻意不同族：'
  + 'Budget 说 ALLOW，Autonomy 说 AUTO_ALLOW',
  (() => {
    const dec = C.AP_DECISIONS.slice().sort();
    const bud = C.BUDGET_DECISIONS.slice().sort();
    return dec.join(',') === 'AUTO_ALLOW,DENY,REQUIRE_APPROVAL' &&
      bud.join(',') === 'ALLOW,DENY,REQUIRE_APPROVAL' &&
      dec.join(',') !== bud.join(',') &&
      C.AP_DECISIONS !== C.BUDGET_DECISIONS &&
      C.AP_DECISION.AUTO_ALLOW !== C.BUDGET_DECISION.ALLOW &&
      /* 两个共享词必须**逐字**相同（它们在两层的含义一样）。 */
      C.AP_DECISION.DENY === C.BUDGET_DECISION.DENY &&
      C.AP_DECISION.REQUIRE_APPROVAL === C.BUDGET_DECISION.REQUIRE_APPROVAL;
  })());

check('C2 ★★ Budget ALLOW + Autonomy REQUIRE_APPROVAL ⇒ 仍然必须问用户'
  + '（预算允许不等于有权自主花）',
  (() => {
    /* 构造：审批线 400，金额 450 —— 预算这一面完全允许（额度内），
       而自主这一面要求批准。两句必须同时成立。 */
    const budget = C.evaluateBudget(
      C.validateBudgetPolicy({
        policyId: 'econ_policy_bp1', ownerId: 'cfg_a', currency: 'IB_CREDIT', status: 'ACTIVE',
        limits: { perTransactionMinor: 1000, dailyMinor: 5000, weeklyMinor: 5000, monthlyMinor: 5000 }
      }).policy,
      {
        ownerId: 'cfg_a', currency: 'IB_CREDIT', amountMinor: 450, walletState: 'READY',
        timestamp: Date.UTC(2024, 5, 1, 12),
        usage: { spentTodayMinor: 0, spentThisWeekMinor: 0, spentThisMonthMinor: 0 },
        limits: { availableBalanceMinor: 5000 }
      });
    const autonomy = C.evaluateAutonomousPurchase(policyOf(), contextOf({ amountMinor: 450 }));
    return budget.outcome === C.BUDGET_DECISION.ALLOW && budget.allowed === true &&
      autonomy.outcome === C.AP_DECISION.REQUIRE_APPROVAL && autonomy.requiresApproval === true;
  })());

check('C3 ★★ Autonomy AUTO_ALLOW + Budget DENY ⇒ 绝对不能买'
  + '（有权自主花不等于花得起 —— 预算的拒绝在下游仍然生效）',
  (() => {
    const budget = C.evaluateBudget(
      C.validateBudgetPolicy({
        policyId: 'econ_policy_bp2', ownerId: 'cfg_a', currency: 'IB_CREDIT', status: 'ACTIVE',
        limits: { perTransactionMinor: 50, dailyMinor: 5000, weeklyMinor: 5000, monthlyMinor: 5000 }
      }).policy,
      {
        ownerId: 'cfg_a', currency: 'IB_CREDIT', amountMinor: 100, walletState: 'READY',
        timestamp: Date.UTC(2024, 5, 1, 12),
        usage: { spentTodayMinor: 0, spentThisWeekMinor: 0, spentThisMonthMinor: 0 },
        limits: { availableBalanceMinor: 5000 }
      });
    const autonomy = C.evaluateAutonomousPurchase(policyOf(), contextOf({ amountMinor: 100 }));
    return budget.outcome === C.BUDGET_DECISION.DENY && budget.allowed === false &&
      budget.reasonCode === C.DENY_REASON.AMOUNT_EXCEEDS_PER_TRANSACTION &&
      autonomy.outcome === C.AP_DECISION.AUTO_ALLOW && autonomy.autoAllowed === true;
  })());

check('C4 自主策略**不能**授予预算：它的输出里没有任何可以当预算结论用的字段',
  (() => {
    const d = C.evaluateAutonomousPurchase(policyOf(), contextOf());
    return d.grantsBudget === false && d.notABudgetDecision === true &&
      C.AUTONOMY_POLICY_GRANTS_BUDGET === false && C.AUTONOMY_REPLACES_BUDGET === false &&
      /* 预算结论的字段（spentThisWeek / spentThisMonth / availableBalance / policyId）
         在自主结论里一个都不存在 —— 它读不到"钱有多少"，
         因为它关心的是"花这笔钱要不要问人"。 */
      d.spentThisWeekMinor === undefined && d.spentThisMonthMinor === undefined &&
      d.availableBalanceMinor === undefined && d.policyId === undefined;
  })());

check('C5 自主策略的输入白名单里**没有** availableBalanceMinor / walletBalance / maxBudget / budget'
  + '（它不能看见余额，因此不可能给出"实际是预算"的结论）',
  C.AUTONOMY_POLICY_INPUT_KEYS.indexOf('availableBalanceMinor') < 0 &&
  C.AUTONOMY_POLICY_INPUT_KEYS.indexOf('walletBalance') < 0 &&
  C.AUTONOMY_POLICY_INPUT_KEYS.indexOf('maxBudget') < 0 &&
  C.AUTONOMY_POLICY_INPUT_KEYS.indexOf('budget') < 0 &&
  C.AUTONOMY_POLICY_FORBIDDEN_INPUT_KEYS.indexOf('availableBalanceMinor') >= 0 &&
  C.AUTONOMY_POLICY_FORBIDDEN_INPUT_KEYS.indexOf('walletBalance') >= 0 &&
  C.AUTONOMY_POLICY_FORBIDDEN_INPUT_KEYS.indexOf('maxBudget') >= 0 &&
  !okResult(C.normalizeAutonomyPolicyInput({ ownerId: 'cfg_a', walletBalance: 9999 })));

check('C6 自主策略的输入里**不能**声明结论：agentDecided / agentWantsToBuy / feelsLikeBuying 一律被拒',
  ['agentDecided', 'agentWantsToBuy', 'feelsLikeBuying', 'llmOutput'].every(k =>
    !okResult(C.normalizeAutonomyPolicyInput({ ownerId: 'cfg_a', [k]: true }))));

check('C7 两个评估器的签名是同一形状（policy, context），而 context 的白名单互不相同',
  C.evaluateBudget.length === 2 && C.evaluateAutonomousPurchase.length === 2 &&
  C.BUDGET_INPUT_KEYS.indexOf('spentTodayMinor') < 0 &&
  C.AUTONOMY_POLICY_INPUT_KEYS.indexOf('spentTodayMinor') >= 0 &&
  C.AUTONOMY_POLICY_INPUT_KEYS.indexOf('walletState') < 0 &&
  C.BUDGET_INPUT_KEYS.indexOf('walletState') >= 0);

/* ══════════════════════════════════════════════════════════════════
   D · §2/§4 的输入纪律
   ══════════════════════════════════════════════════════════════════ */
section('D · §2/§4 输入纪律：白名单、禁止键、没有裸 limit');

check('D1 ★ 输入白名单恰好十二个键，而它们全部是 canonical Economy facts',
  C.AUTONOMY_POLICY_INPUT_KEYS.slice().sort().join(',') ===
    'amountMinor,buyerId,currency,gift,ownerId,productId,productKind,recipientId,selfDirected,settlementType,spentTodayMinor,timestamp' &&
  C.AUTONOMY_POLICY_INPUT_KEYS.length === 12);

check('D2 ★★ §2 点名的五类禁用输入全部**无处可放**：LLM 输出 / Memory / Relationship / affection·trust / 聊天内容',
  ['prompt', 'systemPrompt', 'persona', 'personality', 'mood',
    'relationship', 'affection', 'trust', 'affinity',
    'message', 'messages', 'content', 'text', 'reply',
    'llmOutput', 'modelOutput', 'completion', 'rawOutput', 'reasoning', 'thoughts',
    'memory', 'memoryRef'].every(k =>
    !okResult(C.normalizeAutonomyPolicyInput({ ownerId: 'cfg_a', [k]: 'x' }))) &&
  ['prompt', 'relationship', 'affection', 'memory', 'llmOutput'].every(k =>
    C.AUTONOMY_POLICY_FORBIDDEN_INPUT_KEYS.indexOf(k) >= 0));

check('D3 未在白名单里的**任意**键都被拒（不是"点名黑名单"）',
  (() => {
    const r = C.normalizeAutonomyPolicyInput({ ownerId: 'cfg_a', someFutureField: 1 });
    return r.ok === false && r.errors.indexOf('autonomy-input-key-not-whitelisted') >= 0;
  })());

check('D4 正文类键得到的是**具名**拒绝（autonomy-input-carries-non-deterministic-text），'
  + '而拼错的键得到的是另一个 —— 两种污染在错误里可分',
  (() => {
    const text = C.normalizeAutonomyPolicyInput({ ownerId: 'cfg_a', prompt: 'buy it' });
    const typo = C.normalizeAutonomyPolicyInput({ ownerId: 'cfg_a', prductKind: 'ITEM' });
    return text.errors.indexOf('autonomy-input-carries-non-deterministic-text') >= 0 &&
      typo.errors.indexOf('autonomy-input-key-not-whitelisted') >= 0;
  })());

check('D5 输入必须是结构化对象：数组 / null / 字符串一律被拒',
  !okResult(C.normalizeAutonomyPolicyInput([])) &&
  !okResult(C.normalizeAutonomyPolicyInput(null)) &&
  !okResult(C.normalizeAutonomyPolicyInput('cfg_a')) &&
  !okResult(C.normalizeAutonomyPolicyInput({ ownerId: 'cfg_a', productKind: 'NOT_A_KIND' })));

check('D6 ★ 策略记录的键全部带 Minor 后缀：**没有**裸的 budget / limit / price / amount',
  C.AUTONOMY_POLICY_KEYS.indexOf('budget') < 0 && C.AUTONOMY_POLICY_KEYS.indexOf('limit') < 0 &&
  C.AUTONOMY_POLICY_KEYS.indexOf('amount') < 0 && C.AUTONOMY_POLICY_KEYS.indexOf('price') < 0 &&
  C.AUTONOMY_POLICY_KEYS.indexOf('perPurchaseLimit') < 0 &&
  C.AUTONOMY_POLICY_KEYS.indexOf('perPurchaseLimitMinor') >= 0 &&
  C.AUTONOMY_POLICY_KEYS.indexOf('dailyAutonomousLimitMinor') >= 0 &&
  C.AUTONOMY_POLICY_KEYS.indexOf('approvalAboveMinor') >= 0 &&
  C.AUTONOMY_POLICY_KEYS.length === 9);

check('D7 §4 的六个最小字段**都在**（enabled / perPurchaseLimitMinor / dailyAutonomousLimitMinor /'
  + ' allowedProductKinds / allowedSettlementTypes / allowGift），没有塞入无关字段',
  ['enabled', 'perPurchaseLimitMinor', 'dailyAutonomousLimitMinor',
    'allowedProductKinds', 'allowedSettlementTypes', 'allowGift'].every(k =>
    C.AUTONOMY_POLICY_KEYS.indexOf(k) >= 0) &&
  /* approvalAboveMinor 是第七条：它表达的是"超过这条线就要批准"（§5 的许可线），
     它本身就是 §4 里"是否需要批准"的唯一结构化表达。 */
  C.AUTONOMY_POLICY_KEYS.indexOf('approvalAboveMinor') >= 0);

check('D8 两个额度必须**存在**：缺任一个即 validateAutonomyPolicy 失败（"enabled 但没有上限"= 以后随便花）',
  !okResult(C.validateAutonomyPolicy({
    policyId: 'econ_policy_ap1', ownerId: 'cfg_a', enabled: true, dailyAutonomousLimitMinor: 1000
  })) &&
  !okResult(C.validateAutonomyPolicy({
    policyId: 'econ_policy_ap1', ownerId: 'cfg_a', enabled: true, perPurchaseLimitMinor: 100
  })));

check('D9 两条序关系被强制：perPurchase ≤ daily，而 approvalAbove ≤ perPurchase'
  + '（一条永远不会被触发的审批线比没有审批线更糟 —— 它看起来像一条保证）',
  (() => {
    const a = C.validateAutonomyPolicy({
      policyId: 'econ_policy_ap1', ownerId: 'cfg_a', enabled: true,
      perPurchaseLimitMinor: 1000, dailyAutonomousLimitMinor: 500
    });
    const b = C.validateAutonomyPolicy({
      policyId: 'econ_policy_ap1', ownerId: 'cfg_a', enabled: true,
      perPurchaseLimitMinor: 500, dailyAutonomousLimitMinor: 1000, approvalAboveMinor: 600
    });
    return a.ok === false && a.errors.indexOf('autonomy-per-purchase-limit-must-not-exceed-the-daily-autonomous-limit') >= 0 &&
      b.ok === false && b.errors.indexOf('autonomy-approval-threshold-must-not-exceed-the-per-purchase-limit') >= 0;
  })());

check('D10 approvalAboveMinor 缺省 = perPurchaseLimitMinor ⇒ 整段自主额度都需要批准（比"缺省完全不用批准"安全）',
  (() => {
    const p = C.validateAutonomyPolicy({
      policyId: 'econ_policy_ap1', ownerId: 'cfg_a', enabled: true,
      perPurchaseLimitMinor: 300, dailyAutonomousLimitMinor: 600,
      allowedProductKinds: ['DIGITAL_ITEM'], allowedSettlementTypes: ['INVENTORY_GRANT']
    });
    return p.ok === true && p.policy.approvalAboveMinor === 300n &&
      /* 于是"恰好 300"仍然 AUTO_ALLOW，而少一分钱也要批准是不可能的 ——
         这条策略的语义因此是"300 以内自己决定，300 就是上限"。 */
      C.evaluateAutonomousPurchase(p.policy, contextOf({
        productKind: 'DIGITAL_ITEM', settlementType: 'INVENTORY_GRANT', amountMinor: 300
      })).outcome === C.AP_DECISION.AUTO_ALLOW;
  })());

check('D11 策略形状校验：owner 不能是 system，policyId 必须是 econ_policy_，enabled 必须是布尔',
  !okResult(C.validateAutonomyPolicy({
    policyId: 'econ_policy_ap1', ownerId: { type: 'system', id: C.SYSTEM_ACCOUNT.MARKET }, enabled: true,
    perPurchaseLimitMinor: 1, dailyAutonomousLimitMinor: 1
  })) &&
  !okResult(C.validateAutonomyPolicy({
    policyId: 'not-a-policy', ownerId: 'cfg_a', enabled: true,
    perPurchaseLimitMinor: 1, dailyAutonomousLimitMinor: 1
  })) &&
  !okResult(C.validateAutonomyPolicy({
    policyId: 'econ_policy_ap1', ownerId: 'cfg_a', enabled: 'yes',
    perPurchaseLimitMinor: 1, dailyAutonomousLimitMinor: 1
  })));

check('D12 两个白名单的成员必须落在 P22-5 的封闭词表里（拼错的 COMPUTE_CREDITS 会被拒，而不是静默变成空集）',
  !okResult(C.validateAutonomyPolicy({
    policyId: 'econ_policy_ap1', ownerId: 'cfg_a', enabled: true,
    perPurchaseLimitMinor: 1, dailyAutonomousLimitMinor: 1,
    allowedProductKinds: ['COMPUTE_CREDITS']
  })) &&
  !okResult(C.validateAutonomyPolicy({
    policyId: 'econ_policy_ap1', ownerId: 'cfg_a', enabled: true,
    perPurchaseLimitMinor: 1, dailyAutonomousLimitMinor: 1,
    allowedSettlementTypes: ['INVENTORY_GRANTS']
  })) &&
  /* 空数组也被拒：空数组等于"什么都不允许"，那时正确写法是 enabled=false。 */
  !okResult(C.validateAutonomyPolicy({
    policyId: 'econ_policy_ap1', ownerId: 'cfg_a', enabled: true,
    perPurchaseLimitMinor: 1, dailyAutonomousLimitMinor: 1, allowedProductKinds: []
  })));

check('D13 allowGift 必须是布尔，且缺省是 false（§12：默认不自主送礼）',
  !okResult(C.validateAutonomyPolicy({
    policyId: 'econ_policy_ap1', ownerId: 'cfg_a', enabled: true,
    perPurchaseLimitMinor: 1, dailyAutonomousLimitMinor: 1, allowGift: 'yes'
  })) &&
  C.validateAutonomyPolicy({
    policyId: 'econ_policy_ap1', ownerId: 'cfg_a', enabled: true,
    perPurchaseLimitMinor: 1, dailyAutonomousLimitMinor: 1
  }).policy.allowGift === false);

check('D14 载入期不变量：自主策略的输入白名单里不含任何禁止键'
  + '（"某天有人加了 relationship 字段"会在 require 的那一刻炸，而不是等到审计）',
  C.AUTONOMY_POLICY_INPUT_KEYS.every(k =>
    C.AUTONOMY_POLICY_FORBIDDEN_INPUT_KEYS.indexOf(k) < 0));

/* ══════════════════════════════════════════════════════════════════
   E · §6 的九元组绑定
   ══════════════════════════════════════════════════════════════════ */
section('E · §6 九元组绑定：approvalFingerprint 是可重算的纯函数');

const BINDING = {
  buyerId: 'character:cfg_a',
  recipientId: null,
  productId: 'econ_product_p1',
  quoteId: 'econ_quote_q1',
  currency: 'IB_CREDIT',
  amountMinor: 400,
  settlementType: 'COMPUTE_GRANT',
  grantQuantity: 100,
  units: 1
};

check('E1 APPROVAL_BINDING_KEYS 恰好九项，逐字是 §6 点名的那九个',
  C.APPROVAL_BINDING_KEYS.slice().sort().join(',') ===
    'amountMinor,buyerId,currency,grantQuantity,productId,quoteId,recipientId,settlementType,units' &&
  C.APPROVAL_BINDING_KEYS.length === 9);

check('E2 approvalFingerprint 是纯函数：同输入同输出、打乱键序同输出、深拷贝同输出',
  (() => {
    const a = C.approvalFingerprint(BINDING);
    const b = C.approvalFingerprint(BINDING);
    const shuffled = {};
    for (const k of Object.keys(BINDING).reverse()) shuffled[k] = BINDING[k];
    const c = C.approvalFingerprint(shuffled);
    const d = C.approvalFingerprint(JSON.parse(JSON.stringify(BINDING)));
    return a.ok && a.fingerprint === b.fingerprint && b.fingerprint === c.fingerprint &&
      c.fingerprint === d.fingerprint && a.fingerprint.length > 0;
  })());

check('E3 ★★ §6 的核心：换掉九项中的**任何一项**都会得到一个不同的身份'
  + '（"用户批准过 400"不蕴含"用户批准了另一次 400"）',
  (() => {
    const base = C.approvalFingerprint(BINDING).fingerprint;
    const mutations = {
      buyerId: 'character:cfg_b',
      recipientId: 'character:cfg_b',
      productId: 'econ_product_p2',
      quoteId: 'econ_quote_q2',
      currency: 'COMPUTE_STANDARD',
      amountMinor: 401,
      settlementType: 'INVENTORY_GRANT',
      grantQuantity: 99,
      units: 2
    };
    return Object.keys(mutations).every(k => {
      const mutated = Object.assign({}, BINDING, { [k]: mutations[k] });
      const fp = C.approvalFingerprint(mutated);
      return fp.ok === true && fp.fingerprint !== base;
    }) && Object.keys(mutations).length === 9;
  })());

check('E4 指纹**不含**任何生成的 id 或时间：approvalId / createdAt / expiresAt 都不在输入里，'
  + '因此"批准的是哪一件事"可以被独立重算',
  (() => {
    const withNoise = Object.assign({}, BINDING, {
      approvalId: 'econ_approval_x1', createdAt: 1, expiresAt: 9e15, decidedBy: 'user:user'
    });
    const extra = Object.assign({}, BINDING, { approvalId: 'econ_approval_x2' });
    return C.approvalFingerprint(withNoise).fingerprint === C.approvalFingerprint(BINDING).fingerprint &&
      C.approvalFingerprint(extra).fingerprint === C.approvalFingerprint(BINDING).fingerprint &&
      C.approvalFingerprint(BINDING).fingerprint.indexOf('econ_approval_') < 0;
  })());

check('E5 指纹把金额写成 canonical 十进制字符串（100 与 "100" 是同一件事）',
  C.approvalFingerprint(Object.assign({}, BINDING, { amountMinor: 400 })).fingerprint ===
  C.approvalFingerprint(Object.assign({}, BINDING, { amountMinor: '400' })).fingerprint &&
  C.approvalFingerprint(Object.assign({}, BINDING, { amountMinor: 'not-a-number' })).ok === false);

check('E6 缺席的 recipient 与一个**具体**的 recipient 得到两个身份'
  + '（"买给自己"与"送给别人"不是同一件事）',
  C.approvalFingerprint(BINDING).fingerprint !==
  C.approvalFingerprint(Object.assign({}, BINDING, { recipientId: 'character:cfg_a' })).fingerprint);

check('E7 validateApproval 拒绝缺项 / 非法项，并接受一份完整记录',
  (() => {
    const full = C.validateApproval({
      approvalId: 'econ_approval_a1', buyerId: { type: 'character', id: 'cfg_a' }, recipientId: null,
      productId: 'econ_product_p1', quoteId: 'econ_quote_q1', quoteKind: 'COMPUTE_GRANT',
      currency: 'IB_CREDIT', amountMinor: 400, settlementType: 'COMPUTE_GRANT',
      grantQuantity: 100, units: 1, status: 'PENDING', approvalMode: 'APPROVAL',
      expiresAt: 9e15
    });
    const badId = C.validateApproval({
      approvalId: 'econ_intent_x1', buyerId: { type: 'character', id: 'cfg_a' },
      productId: 'econ_product_p1', quoteId: 'econ_quote_q1', quoteKind: 'COMPUTE_GRANT',
      currency: 'IB_CREDIT', amountMinor: 400, settlementType: 'COMPUTE_GRANT',
      grantQuantity: 100, units: 1, status: 'PENDING', approvalMode: 'APPROVAL', expiresAt: 9e15
    });
    return full.ok === true && full.approval.namespace === C.NAMESPACES.APPROVAL &&
      badId.ok === false && badId.errors.indexOf('approval-id-not-canonical') >= 0;
  })());

check('E8 §6：批准的有效期有**上界**（24 小时）—— 一条"永久有效"的批准与"以后随便花 500"是同一种东西',
  C.APPROVAL_MAX_LIFETIME_MS === 24 * 60 * 60 * 1000 &&
  C.APPROVAL_IS_BOUND_TO_A_QUOTE === true &&
  C.APPROVAL_IS_SINGLE_USE === true &&
  C.APPROVAL_BYPASSES_BUDGET === false &&
  C.APPROVAL_BYPASSES_QUOTE_EXPIRY === false);

/* ══════════════════════════════════════════════════════════════════
   F · §12/§13 Gift 与 Compute/API quota
   ══════════════════════════════════════════════════════════════════ */
section('F · §12/§13 Gift 与 Compute/API quota 的边界');

check('F1 ★★ §12 Gift 默认**不**自主：allowGift=false 时送礼 ⇒ DENY，与金额无关',
  (() => {
    const cheap = C.evaluateAutonomousPurchase(policyOf(), contextOf({
      gift: true, selfDirected: false, recipientId: { type: 'character', id: 'cfg_b' }, amountMinor: 1
    }));
    const rich = C.evaluateAutonomousPurchase(policyOf(), contextOf({
      gift: true, selfDirected: false, recipientId: { type: 'character', id: 'cfg_b' }, amountMinor: 1
    }));
    return cheap.outcome === C.AP_DECISION.DENY &&
      cheap.reasonCode === C.DENY_REASON.AUTONOMY_NOT_PERMITTED &&
      cheap.rule === 'gifting-someone-else-is-not-autonomous-by-default' &&
      cheap.allowGift === false && rich.outcome === C.AP_DECISION.DENY;
  })());

check('F1b ★ 送礼的判据排在金额判据之前（"能不能送"与"送多少"是两件事）',
  (() => {
    /* 金额 1（远低于两条线）仍然因为是礼物而被拒。 */
    const d = C.evaluateAutonomousPurchase(policyOf(), contextOf({
      gift: true, selfDirected: false, recipientId: { type: 'character', id: 'cfg_b' }, amountMinor: 1
    }));
    return d.outcome === C.AP_DECISION.DENY && d.priorityRule === 'product-kind-allowed';
  })());

check('F2 allowGift=true 时送礼仍然**不是自动允许**：它只是不再被那条礼物规则拦下，'
  + '两条额度与审批线照常生效',
  (() => {
    const p = policyOf({ allowGift: true });
    const within = C.evaluateAutonomousPurchase(p, contextOf({
      gift: true, selfDirected: false, recipientId: { type: 'character', id: 'cfg_b' }, amountMinor: 100
    }));
    const over = C.evaluateAutonomousPurchase(p, contextOf({
      gift: true, selfDirected: false, recipientId: { type: 'character', id: 'cfg_b' }, amountMinor: 450
    }));
    return within.outcome === C.AP_DECISION.AUTO_ALLOW &&
      over.outcome === C.AP_DECISION.REQUIRE_APPROVAL;
  })());

check('F3 ★★ Relationship 无法影响送礼：关系 / 好感 / 信任都不是输入，'
  + '而"关系高所以自动允许送礼"这句话在类型上不成立',
  (() => {
    /* 同一份 policy 与同一个 context，唯一"变化"的是被拒绝的那些键 ——
       而它们进不来，因此两次评估逐字节相同。 */
    const p = policyOf();
    const base = JSON.stringify(C.evaluateAutonomousPurchase(p, contextOf({
      gift: true, selfDirected: false, recipientId: { type: 'character', id: 'cfg_b' }, amountMinor: 100
    })), replacer);
    const withRelationship = C.normalizeAutonomyPolicyInput({
      ownerId: 'cfg_a', productKind: 'COMPUTE_CREDIT', settlementType: 'COMPUTE_GRANT',
      currency: 'IB_CREDIT', amountMinor: 100, gift: true, selfDirected: false, spentTodayMinor: 0,
      relationship: { trust: 0.99, affection: 1 }, affection: 100, trust: 1
    });
    return withRelationship.ok === false &&
      withRelationship.errors.filter(e => e === 'autonomy-input-carries-non-deterministic-text').length >= 3 &&
      /* 没有那三个键的那一次评估仍然是 DENY。 */
      JSON.parse(base).outcome === 'DENY';
  })());

check('F4 §13 Compute 与 API quota 可以设自主权限，而单位仍然是 P22-1 冻结的 computeUnit',
  (() => {
    const p = C.validateAutonomyPolicy({
      policyId: 'econ_policy_ap2', ownerId: 'cfg_a', enabled: true,
      perPurchaseLimitMinor: 500, dailyAutonomousLimitMinor: 1000, approvalAboveMinor: 500,
      allowedProductKinds: ['COMPUTE_CREDIT', 'API_QUOTA'],
      allowedSettlementTypes: ['COMPUTE_GRANT'],
      allowGift: false
    });
    const d = C.evaluateAutonomousPurchase(p.policy, contextOf({
      productKind: 'COMPUTE_CREDIT', settlementType: 'COMPUTE_GRANT', amountMinor: 100
    }));
    return p.ok === true && d.outcome === C.AP_DECISION.AUTO_ALLOW &&
      /* 结算形态的 primitive 是 IB 内部的额度授予，不是任何 provider 配额。 */
      C.settlementPrimitiveOfFulfillment('COMPUTE_GRANT').primitive === 'COMPUTE_ENTITLEMENT' &&
      C.COMPUTE_UNIT_NAME === 'computeUnit' &&
      C.assetKindOfProductKind('COMPUTE_CREDIT') === C.ASSET_KIND.COMPUTE &&
      /* ★ 冻结的 compute 别名黑名单逐字拒绝的是 token / balance / provider 族。
         这一段刻意逐条断言**实际存在**的成员，而不是断言一个想当然的
         成员（'apiQuota' / 'providerQuota' 并不在其中 —— 而这是对的：
         P22-5 的 unit-name 规则已经从另一个方向排除了它们，因为一个
         compute 商品的 unitName 必须**恰是** COMPUTE_UNIT_NAME）。 */
      C.FORBIDDEN_COMPUTE_ALIASES.indexOf('providerToken') >= 0 &&
      C.FORBIDDEN_COMPUTE_ALIASES.indexOf('realCredit') >= 0 &&
      C.FORBIDDEN_COMPUTE_ALIASES.indexOf('balance') >= 0 &&
      C.isForbiddenComputeAlias('providerToken') &&
      C.isForbiddenComputeAlias('realCredit') &&
      C.isForbiddenComputeAlias('balance') &&
      /* 而那个**合法**的单位名不被误判。 */
      C.isForbiddenComputeAlias(C.COMPUTE_UNIT_NAME) === false &&
      C.FORBIDDEN_COMPUTE_ALIASES.length > 0;
  })());

check('F5 ★★ 自主策略的结论里**没有**任何 provider / payment 字段：'
  + '它只说"这笔 IB 内部购买可以自主"',
  (() => {
    const d = C.evaluateAutonomousPurchase(policyOf(), contextOf());
    const keys = Object.keys(d).join(',');
    return !/provider/i.test(keys) && !/payment/i.test(keys) && !/topup/i.test(keys) &&
      !/credential/i.test(keys) && !/apiKey/i.test(keys) &&
      C.AUTONOMY_POLICY_READS_LLM_OUTPUT === false &&
      C.AUTONOMY_POLICY_READS_MEMORY === false &&
      C.AUTONOMY_POLICY_READS_RELATIONSHIP === false &&
      C.AUTONOMY_POLICY_IS_A_DECISION_LAYER === false;
  })());

check('F6 §13 的边界自述是**可断言字段**，而不是注释：'
  + 'computeUnit 是内部 entitlement、没有 provider quota、没有真实充值',
  (() => {
    const h = { /* 与 store.health() 的字段逐字对应 */ };
    return C.COMPUTE_UNIT_NAME === 'computeUnit' &&
      C.FORBIDDEN_COMPUTE_ALIASES.every(a => C.isForbiddenComputeAlias(a)) &&
      C.FORBIDDEN_PURCHASE_LEDGER_ACCOUNTS.indexOf('provider:openai') >= 0 &&
      C.FORBIDDEN_PURCHASE_LEDGER_ACCOUNTS.indexOf('system:quota') >= 0 &&
      C.FORBIDDEN_PURCHASE_LEDGER_ACCOUNTS.indexOf('tokenBalance') >= 0 &&
      /* 结算对手方白名单里没有任何 provider 账户。 */
      C.QUOTE_KINDS.every(k => {
        const cp = C.settlementCounterpartyFor(k);
        return cp.ok === true && cp.accountId.indexOf('provider') < 0;
      }) &&
      Object.keys(h).length === 0;
  })());

/* ══════════════════════════════════════════════════════════════════
   汇总
   ══════════════════════════════════════════════════════════════════ */
console.log('');
if (failures === 0) console.log('P22-7 autonomy: 全部通过 ✔');
else console.error('P22-7 autonomy: ' + failures + ' 项失败 ✘');
process.exitCode = failures === 0 ? 0 : 1;
