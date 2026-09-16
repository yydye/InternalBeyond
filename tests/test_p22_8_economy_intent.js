'use strict';
/* ====================================================================
   P22-8 · Agent Purchase Intent（契约层：纯函数，零数据库）
   --------------------------------------------------------------------
   运行：node tests/test_p22_8_economy_intent.js

   本文件回答的是**形状与纪律**层面的问题，而它们全部可以在没有库的情况
   下被证伪：

     A 组 · 身份：Intent 有自己的第 16 种 id 前缀，而且它与「购买」的
            econ_intent_ 是**两个**字形（一次打算 ≠ 一笔购买）
     B 组 · 状态机：七态、四条终态、§8 的三条禁令、没有自环
     C 组 · §4 模型不得提供经济事实（大小写/分隔符都挡得住）
     D 组 · §3 reason 只是 telemetry（不进身份、不进判定、有上界）
     E 组 · §10/§11 意图指纹（不含 reason、不含 expiresAt、不含生成的 id）
     F 组 · 指纹算法与 store 的那一份**逐字相同**（同一个输入同一个值）
     G 组 · §5–§7 裁决表（三条路径 + 恢复 + fail closed）
     H 组 · 自述字段与载入期不变量
   ==================================================================== */

const assert = require('node:assert');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const C = require(path.join(ROOT, 'services', 'home-node', 'economy-contract.js'));
const createEconomyStore = require(path.join(ROOT, 'services', 'home-node', 'economy-store.js'));

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

const PRODUCT_ID = 'econ_product_p28a';

/* ══════════════════════════════════════════════════════════════════════
   A · 身份
   ══════════════════════════════════════════════════════════════════════ */
section('A · Intent 的身份（第 16 种前缀，与购买的两个字形）');

check('A1 十六种 id 种类各有唯一前缀（P22-8 加 AGENT_INTENT）',
  C.ID_KINDS.length === 16 && new Set(C.ID_KINDS.map(k => C.ID_PREFIX[k])).size === 16, C.ID_KINDS);

check('A2 AGENT_INTENT === econ_agentintent_，而它与 PURCHASE_INTENT 是**两个**前缀',
  C.ID_PREFIX.AGENT_INTENT === 'econ_agentintent_' &&
  C.ID_PREFIX.AGENT_INTENT !== C.ID_PREFIX.PURCHASE_INTENT &&
  C.ID_PREFIX.PURCHASE_INTENT === 'econ_intent_',
  { agentIntent: C.ID_PREFIX.AGENT_INTENT, purchaseIntent: C.ID_PREFIX.PURCHASE_INTENT });

check('A3 ★ 没有一个前缀是另一个的前缀（否则"这个 id 指向打算还是购买"永远要看第二个字段）',
  C.ID_KINDS.every(a => C.ID_KINDS.every(b =>
    a === b || C.ID_PREFIX[b].indexOf(C.ID_PREFIX[a]) !== 0)),
  C.ID_KINDS.map(k => C.ID_PREFIX[k]));

check('A4 isEconomyId 对两个字形各自只认自己：econ_intent_ 不是一条 intent id，反之亦然',
  C.isEconomyId('AGENT_INTENT', 'econ_agentintent_abc') === true &&
  C.isEconomyId('AGENT_INTENT', 'econ_intent_abc') === false &&
  C.isEconomyId('PURCHASE_INTENT', 'econ_intent_abc') === true &&
  C.isEconomyId('PURCHASE_INTENT', 'econ_agentintent_abc') === false);

check('A5 ★ purchaseIntentId 在审计记录里仍然指**购买**，而 agentIntentId 是**新加**的并列字段',
  (function () {
    const base = {
      economyEventId: 'econ_evt_a', timestamp: 1,
      actor: { type: 'character', id: 'cfg_a' }, operation: C.AUDIT_OPERATIONS[0]
    };
    const withPurchase = C.makeAuditRecord(Object.assign({}, base, { purchaseIntentId: 'econ_intent_x' }));
    const withAgent = C.makeAuditRecord(Object.assign({}, base, { agentIntentId: 'econ_agentintent_x' }));
    const crossed = C.makeAuditRecord(Object.assign({}, base, { agentIntentId: 'econ_intent_x' }));
    return withPurchase.ok === true && withPurchase.record.purchaseIntentId === 'econ_intent_x' &&
      withAgent.ok === true && withAgent.record.agentIntentId === 'econ_agentintent_x' &&
      withAgent.record.purchaseIntentId === null &&
      crossed.ok === false && crossed.errors.indexOf('audit-ref-not-canonical') >= 0;
  })());

check('A6 两个新的 operation scope 已登记，且它们与既有的 17 个互不相同',
  C.OPERATION_SCOPES.length === 19 &&
  C.isOperationScope('AGENT_INTENT_PROPOSE') && C.isOperationScope('AGENT_INTENT_EXECUTE') &&
  ['RESERVE', 'QUOTE', 'POLICY', 'PRODUCT', 'INVENTORY_GRANT', 'PURCHASE_PREPARE',
    'PURCHASE_SETTLE', 'APPROVAL_REQUEST', 'APPROVAL_DECIDE', 'APPROVAL_CONSUME',
    'AUTONOMY_POLICY'].every(s => C.isOperationScope(s)));

check('A7 三个新的 economy event 已登记，且 AGENT_INTENT_DETERMINED 与 PROPOSED 是两个词',
  ['AGENT_INTENT_PROPOSED', 'AGENT_INTENT_AWAITING_APPROVAL', 'AGENT_INTENT_DETERMINED']
    .every(t => C.isEconomyEventType(t)) &&
  C.EVENT_TYPE.AGENT_INTENT_PROPOSED !== C.EVENT_TYPE.AGENT_INTENT_DETERMINED &&
  /* 既有事件一个都没丢（加事件不等于换词表）。 */
  ['PURCHASE_COMPLETED', 'APPROVAL_REQUESTED', 'AUTONOMY_PURCHASE_AUTO_ALLOWED']
    .every(t => C.isEconomyEventType(t)));

/* ══════════════════════════════════════════════════════════════════════
   B · 状态机
   ══════════════════════════════════════════════════════════════════════ */
section('B · §8 Intent 状态机');

check('B1 七态恰好是 §8 点名的那七个（为了齐全硬加状态会让审计多出假的阶段）',
  JSON.stringify(C.PURCHASE_INTENT_STATES) ===
  JSON.stringify(['PROPOSED', 'WAITING_APPROVAL', 'EXECUTING', 'COMPLETED', 'DENIED', 'EXPIRED', 'FAILED']),
  C.PURCHASE_INTENT_STATES);

check('B2 四条终态，且它们的出边**全空**',
  C.PURCHASE_INTENT_TERMINAL_STATES.length === 4 &&
  JSON.stringify(C.PURCHASE_INTENT_TERMINAL_STATES.slice().sort()) ===
  JSON.stringify(['COMPLETED', 'DENIED', 'EXPIRED', 'FAILED']) &&
  C.PURCHASE_INTENT_TERMINAL_STATES.every(s => C.PURCHASE_INTENT_TRANSITIONS[s].length === 0));

check('B3 ★ §8 的三条禁令逐条可判定（COMPLETED 不可逆 / DENIED 不可复活 / EXPIRED 不可复活）',
  [['COMPLETED', 'EXECUTING'], ['COMPLETED', 'WAITING_APPROVAL'],
    ['DENIED', 'WAITING_APPROVAL'], ['DENIED', 'EXECUTING'],
    ['EXPIRED', 'WAITING_APPROVAL'], ['EXPIRED', 'EXECUTING']]
    .every(pair => {
      const r = C.canTransitionPurchaseIntent(pair[0], pair[1]);
      return r.allowed === false && r.terminal === true;
    }));

check('B4 FAILED 同样是终态（"再试一次"是一张**新** intent，不是把失败原因改成成功）',
  C.isPurchaseIntentTerminalState('FAILED') === true &&
  C.canTransitionPurchaseIntent('FAILED', 'EXECUTING').allowed === false);

check('B5 ★ 状态机里**一个自环都没有**（每个合法迁移都意味着真的动了）',
  C.PURCHASE_INTENT_STATES.every(s => C.PURCHASE_INTENT_TRANSITIONS[s].indexOf(s) < 0));

check('B6 ★ 没有任何状态能"走回"PROPOSED —— 入口状态只有一条入边（无）',
  C.PURCHASE_INTENT_STATES.every(s => C.PURCHASE_INTENT_TRANSITIONS[s].indexOf('PROPOSED') < 0) &&
  C.PURCHASE_INTENT_INITIAL_STATE === 'PROPOSED');

check('B7 合法迁移各自可判定（含 WAITING_APPROVAL → EXECUTING 这条恢复边）',
  [['PROPOSED', 'WAITING_APPROVAL'], ['PROPOSED', 'EXECUTING'], ['PROPOSED', 'DENIED'],
    ['PROPOSED', 'EXPIRED'], ['PROPOSED', 'FAILED'],
    ['WAITING_APPROVAL', 'EXECUTING'], ['WAITING_APPROVAL', 'DENIED'],
    ['WAITING_APPROVAL', 'EXPIRED'], ['WAITING_APPROVAL', 'FAILED'],
    ['EXECUTING', 'COMPLETED'], ['EXECUTING', 'EXPIRED'], ['EXECUTING', 'FAILED']]
    .every(pair => C.canTransitionPurchaseIntent(pair[0], pair[1]).allowed === true));

check('B8 ★ 刻意**没有** EXECUTING → WAITING_APPROVAL（执行到一半才想起要问用户 = 先 reserve 再问）',
  C.canTransitionPurchaseIntent('EXECUTING', 'WAITING_APPROVAL').allowed === false);

check('B9 封闭集合外的词被拒绝，而且报的是"不在封闭集合"而不是"非法迁移"',
  C.canTransitionPurchaseIntent('PROPOSED', 'APPROVED').errors.indexOf('purchase-intent-state-not-in-closed-set') >= 0 &&
  C.canTransitionPurchaseIntent('PENDING', 'PROPOSED').errors.indexOf('purchase-intent-state-not-in-closed-set') >= 0 &&
  C.canTransitionPurchaseIntent(null, null).allowed === false);

check('B10 assertPurchaseIntentTransition 对终态回退给出 terminal 提示（调用方一眼看出该不该重试）',
  C.assertPurchaseIntentTransition('COMPLETED', 'EXECUTING').hint.indexOf('terminal state cannot move again') >= 0);

/* ══════════════════════════════════════════════════════════════════════
   C · §4 模型不得提供经济事实
   ══════════════════════════════════════════════════════════════════════ */
section('C · §4 提议输入的边界');

check('C1 白名单恰好六个键（agentId / productId / recipientId / units / reason / expiresAt）',
  JSON.stringify(C.PURCHASE_INTENT_PROPOSAL_KEYS) ===
  JSON.stringify(['agentId', 'productId', 'recipientId', 'units', 'reason', 'expiresAt']),
  C.PURCHASE_INTENT_PROPOSAL_KEYS);

check('C2 ★ 白名单与"派生经济值"清单**不相交**（这是载入期不变量的断言对象）',
  C.PURCHASE_INTENT_PROPOSAL_KEYS.every(k => C.PURCHASE_INTENT_DERIVED_ECONOMIC_FACTS.indexOf(k) < 0) &&
  C.PURCHASE_INTENT_PROPOSAL_KEYS.every(k => C.isIntentEconomicFactKey(k) === false));

check('C3 ★ units 在（一个选择），grantQuantity 不在（一份实际发放多少是一个事实）',
  C.PURCHASE_INTENT_PROPOSAL_KEYS.indexOf('units') >= 0 &&
  C.PURCHASE_INTENT_PROPOSAL_KEYS.indexOf('grantQuantity') < 0 &&
  C.isIntentEconomicFactKey('grantQuantity') === true);

check('C4 ★ §4 逐字点名的那一批全部被认成经济事实',
  ['amountMinor', 'currency', 'price', 'discount', 'grantQuantity', 'settlementType',
    'walletBalance', 'budgetResult', 'autoAllow', 'approvalId', 'approved']
    .every(k => C.isIntentEconomicFactKey(k) === true));

check('C5 大小写与分隔符都挡得住（amount_minor / AmountMinor / amount-minor 是同一个企图）',
  ['amount_minor', 'AmountMinor', 'AMOUNT_MINOR', 'amount-minor', 'amount minor', 'amountMinor']
    .every(k => C.isIntentEconomicFactKey(k) === true) &&
  C.economicFactOfIntentKey('Amount_Minor') === 'amountMinor' &&
  C.canonicalizeIntentKey('Amount_Minor') === 'amountminor');

check('C6 ★ 用 canonical 名字报出"你到底递了哪一个"，而且答案按字母序（可断言）',
  (function () {
    const r = C.normalizePurchaseIntentProposal({
      agentId: 'cfg_a', productId: PRODUCT_ID, price: 1, approved: true, amount_minor: 5
    });
    return r.ok === false &&
      r.reasonCode === C.DENY_REASON.MODEL_SUPPLIED_ECONOMIC_FACT &&
      JSON.stringify(r.suppliedEconomicFacts) === JSON.stringify(['amountMinor', 'approved', 'price']);
  })());

check('C7 一条完全合法的提议：六个字段各自归位，selfDirected 由 recipientId 推出',
  (function () {
    const r = C.normalizePurchaseIntentProposal({
      agentId: 'cfg_a', productId: PRODUCT_ID, units: 2, reason: '  need compute  '
    });
    return r.ok === true && r.proposal.agentId === 'cfg_a' && r.proposal.productId === PRODUCT_ID &&
      r.proposal.recipientId === null && r.proposal.selfDirected === true &&
      r.proposal.units === 2 && r.proposal.reason === 'need compute' && r.proposal.expiresAt === null;
  })());

check('C8 ★ 未知键是**拒绝**而不是静默忽略（静默忽略会让幻觉的参数看起来像生效了）',
  (function () {
    const r = C.normalizePurchaseIntentProposal({ agentId: 'cfg_a', productId: PRODUCT_ID, mood: 'happy' });
    return r.ok === false && r.reasonCode === null &&
      r.errors.indexOf('intent-proposal-key-not-whitelisted:mood') >= 0 &&
      JSON.stringify(r.unknownKeys) === JSON.stringify(['mood']);
  })());

check('C9 ★ 经济事实的拒绝排在未知键**之前**（前者更严重，是信任边界违规而不是格式错误）',
  (function () {
    const r = C.normalizePurchaseIntentProposal({
      agentId: 'cfg_a', productId: PRODUCT_ID, nonsense: 1, currency: 'IB_CREDIT'
    });
    return r.ok === false && r.reasonCode === C.DENY_REASON.MODEL_SUPPLIED_ECONOMIC_FACT &&
      r.suppliedEconomicFacts.indexOf('currency') >= 0 && r.unknownKeys.indexOf('nonsense') >= 0;
  })());

check('C10 形状非法一律 fail closed（非对象 / 缺 agentId / 非 canonical productId / units 不是正整数）',
  C.normalizePurchaseIntentProposal(null).ok === false &&
  C.normalizePurchaseIntentProposal('buy it').ok === false &&
  C.normalizePurchaseIntentProposal([]).ok === false &&
  C.normalizePurchaseIntentProposal({ productId: PRODUCT_ID }).ok === false &&
  C.normalizePurchaseIntentProposal({ agentId: 'cfg_a', productId: 'nope' }).ok === false &&
  C.normalizePurchaseIntentProposal({ agentId: 'cfg_a', productId: PRODUCT_ID, units: 0 }).ok === false &&
  C.normalizePurchaseIntentProposal({ agentId: 'cfg_a', productId: PRODUCT_ID, units: 1.5 }).ok === false &&
  C.normalizePurchaseIntentProposal({ agentId: 'cfg_a', productId: PRODUCT_ID, units: -1 }).ok === false);

check('C11 normalizeIntentPartyId 是**语法**层（非空、无空格、有界），语义（角色还是用户）属于 store',
  C.normalizeIntentPartyId('cfg_a').ok === true &&
  C.normalizeIntentPartyId('user').ok === true &&
  C.normalizeIntentPartyId('').ok === false &&
  C.normalizeIntentPartyId('   ').ok === false &&
  C.normalizeIntentPartyId('a b').ok === false &&
  C.normalizeIntentPartyId('a/b').ok === false &&
  C.normalizeIntentPartyId(null).ok === false &&
  /* 数字与字符串都接受，并且**规范化成字符串** —— 与 normalizeIdempotencyKey
     同一条纪律：否则 42 与 '42' 会被判成两个不同的人。 */
  C.normalizeIntentPartyId(42).ok === true && C.normalizeIntentPartyId(42).id === '42' &&
  C.normalizeIntentPartyId('42').id === '42' &&
  /* ★ partyInput（P22-6）接受 'type:id' 形状，因此语法层也放行它；
     语义层（intentPartyOf）会把它当裸 id 交给 partyInput —— 那一层才是
     "这个 id 到底指向一个角色还是一个用户"的唯一答案。 */
  C.normalizeIntentPartyId('character:cfg_a').ok === true);

/* ══════════════════════════════════════════════════════════════════════
   D · reason 只是 telemetry
   ══════════════════════════════════════════════════════════════════════ */
section('D · §3 reason ≠ authority');

check('D1 ★ reason 的三种自述都是 false / true（写死在契约里，而不是文档里的句子）',
  C.PURCHASE_INTENT_REASON_IS_AUTHORITY === false &&
  C.PURCHASE_INTENT_REASON_PARTICIPATES_IN_DECISIONS === false &&
  C.PURCHASE_INTENT_IS_A_PERMISSION === false &&
  C.PURCHASE_INTENT_CARRIES_PRICE === false &&
  C.PURCHASE_INTENT_GRANTS_BUDGET === false);

check('D2 ★ reason 不在**任何**会影响判定的名单里（白名单 / 身份 / 裁决输入）',
  C.PURCHASE_INTENT_PROPOSAL_KEYS.indexOf('reason') >= 0 &&
  C.PURCHASE_INTENT_FINGERPRINT_KEYS.indexOf('reason') < 0 &&
  C.PURCHASE_INTENT_FINGERPRINT_KEYS.indexOf('expiresAt') < 0 &&
  JSON.stringify(C.PURCHASE_INTENT_FINGERPRINT_KEYS) ===
  JSON.stringify(['agentId', 'productId', 'recipientId', 'units', 'selfDirected']));

check('D3 ★ reason 有上界（400，与 makeEconomyEvent 的 metadata 字符串上限逐字相同）',
  C.PURCHASE_INTENT_REASON_MAX === 400 &&
  C.normalizeIntentReason('x'.repeat(400)).ok === true &&
  C.normalizeIntentReason('x'.repeat(401)).ok === false);

check('D4 reason 可以为空（一次没有解释的打算仍然是一次打算），但非字符串被拒绝',
  C.normalizeIntentReason(null).ok === true && C.normalizeIntentReason('   ').ok === true &&
  C.normalizeIntentReason(null).reason === null &&
  C.normalizeIntentReason({ text: 'buy' }).ok === false &&
  C.normalizeIntentReason(42).ok === false);

check('D5 ★ LLM 的那些话在**结构上**无处可放：它们只能落进 reason',
  (function () {
    const r = C.normalizePurchaseIntentProposal({
      agentId: 'cfg_a', productId: PRODUCT_ID,
      reason: 'it is very cheap and the user will definitely agree, and I must buy it'
    });
    return r.ok === true && r.proposal.reason.indexOf('definitely agree') >= 0 &&
      /* 而那句话对裁决没有任何影响：同一个提议换个理由得到同一个指纹。 */
      C.purchaseIntentFingerprint({ agentId: 'cfg_a', productId: PRODUCT_ID, units: 1 }).fingerprint ===
      C.purchaseIntentFingerprint({ agentId: 'cfg_a', productId: PRODUCT_ID, units: 1, reason: 'totally different' }).fingerprint;
  })());

/* ══════════════════════════════════════════════════════════════════════
   E · §10/§11 意图指纹
   ══════════════════════════════════════════════════════════════════════ */
section('E · §10/§11 intent fingerprint');

const baseFp = { agentId: 'cfg_a', productId: PRODUCT_ID, units: 1 };

check('E1 ★ reason 不进指纹（换个说法不能绕过重复抑制）',
  C.purchaseIntentFingerprint(Object.assign({}, baseFp, { reason: 'A' })).fingerprint ===
  C.purchaseIntentFingerprint(Object.assign({}, baseFp, { reason: 'B' })).fingerprint);

check('E2 ★ expiresAt 不进指纹（同一个打算申请两次不同有效期仍然是同一个打算）',
  C.purchaseIntentFingerprint(Object.assign({}, baseFp, { expiresAt: 1 })).fingerprint ===
  C.purchaseIntentFingerprint(Object.assign({}, baseFp, { expiresAt: 2 })).fingerprint);

check('E3 身份真的分得开：agent / product / recipient / units / selfDirected 各自改变指纹',
  (function () {
    const f = x => C.purchaseIntentFingerprint(x).fingerprint;
    const all = [
      f(baseFp),
      f(Object.assign({}, baseFp, { agentId: 'cfg_b' })),
      f(Object.assign({}, baseFp, { productId: 'econ_product_other' })),
      f(Object.assign({}, baseFp, { recipientId: 'cfg_b' })),
      f(Object.assign({}, baseFp, { units: 2 })),
      f(Object.assign({}, baseFp, { recipientId: 'cfg_a' }))
    ];
    return new Set(all).size === all.length;
  })());

check('E4 ★ 拼接不会撞值：字段边界被逐字界定（("a","b|c") 不等于 ("a|b","c")）',
  (function () {
    /* 这些 id 因为形状校验过不了，所以用**能过**的两个来证明边界：
       同一个 recipient 与不同的 units 组合不会被读成另一种组合。 */
    const x = C.purchaseIntentFingerprint({ agentId: 'a', productId: PRODUCT_ID, units: 12 }).fingerprint;
    const y = C.purchaseIntentFingerprint({ agentId: 'a1', productId: PRODUCT_ID, units: 2 }).fingerprint;
    return x !== y;
  })());

check('E5 指纹带 schema 标记，于是未来改变身份定义时旧指纹不会被误认',
  C.PURCHASE_INTENT_FINGERPRINT_SCHEMA === 'p22-8-intent-v1' &&
  C.purchaseIntentFingerprint(baseFp).fingerprint.indexOf('intent1_') === 0 &&
  C.purchaseIntentFingerprint(baseFp).canonical.indexOf('p22-8-intent-v1') >= 0);

check('E6 形状非法时不产出指纹（fail closed，而不是一个能碰撞的常量）',
  C.purchaseIntentFingerprint({ agentId: 'cfg_a', productId: 'nope' }).ok === false &&
  C.purchaseIntentFingerprint({ productId: PRODUCT_ID }).ok === false &&
  C.purchaseIntentFingerprint({ agentId: 'cfg_a', productId: PRODUCT_ID, units: 0 }).ok === false);

check('E7 ★ 指纹是**确定性**的（同一个输入永远同一个答案，与调用时刻无关）',
  C.purchaseIntentFingerprint(baseFp).fingerprint === C.purchaseIntentFingerprint(baseFp).fingerprint &&
  C.purchaseIntentFingerprint(baseFp).fingerprint.length === 'intent1_'.length + 32);

/* ══════════════════════════════════════════════════════════════════════
   F · 两份哈希实现必须逐字相同
   ══════════════════════════════════════════════════════════════════════ */
section('F · 算法只有一份定义（契约那份 === store 那份）');

check('F1 ★ 契约层的 fnv1a64Hex 与 store 导出的那一个对同一输入给出同一个值',
  (function () {
    const samples = ['', 'a', 'intent1_', '{"x":1}', '中文', 'x'.repeat(999), JSON.stringify([1, 2, 3])];
    return samples.every(s => C.fnv1a64Hex(s) === createEconomyStore.fnv1a64Hex(s));
  })());

check('F2 它不是恒等也不是常量（空串与单字符各自不同，且都是 32 个十六进制位）',
  C.fnv1a64Hex('') !== C.fnv1a64Hex('a') &&
  /^[0-9a-f]{32}$/.test(C.fnv1a64Hex('anything')));

/* ══════════════════════════════════════════════════════════════════════
   G · 裁决表
   ══════════════════════════════════════════════════════════════════════ */
section('G · §5–§7 裁决表（纯函数，无查询）');

const NOW = 1_800_000_000_000;
function ctx(over) {
  return Object.assign({
    now: NOW,
    intentStatus: 'PROPOSED',
    expiresAt: NOW + 60_000,
    productId: PRODUCT_ID,
    productStatus: 'ACTIVE',
    quoteState: 'OPEN',
    authority: { ok: true, decision: { outcome: 'AUTO_ALLOW', reasonCode: null }, autonomyPolicyId: 'econ_policy_x' },
    approvalStatus: null
  }, over || {});
}

check('G1 AUTO_ALLOW → EXECUTE_AUTO_ALLOW，而且 mayExecute 为真**同时**说 budgetStillRequired',
  (function () {
    const v = C.evaluatePurchaseIntentVerdict(ctx({}));
    return v.ok === true && v.outcome === C.INTENT_VERDICT.EXECUTE_AUTO_ALLOW &&
      v.mayExecute === true && v.budgetStillRequired === true &&
      v.reservesNothing === true && v.createsPurchase === false;
  })());

check('G2 REQUIRE_APPROVAL 且还没有批准记录 → WAIT_FOR_APPROVAL，且不 reserve / 不创建购买',
  (function () {
    const v = C.evaluatePurchaseIntentVerdict(ctx({
      authority: { ok: true, decision: { outcome: 'REQUIRE_APPROVAL', reasonCode: 'APPROVAL_REQUIRED' } }
    }));
    return v.outcome === C.INTENT_VERDICT.WAIT_FOR_APPROVAL && v.mayExecute === false &&
      v.reservesNothing === true && v.createsPurchase === false &&
      v.reasonCode === 'APPROVAL_REQUIRED';
  })());

check('G3 ★ 用户点头 → EXECUTE_APPROVED，而它**不是** AUTO_ALLOW（审计里必须读得出区别）',
  (function () {
    const v = C.evaluatePurchaseIntentVerdict(ctx({
      intentStatus: 'WAITING_APPROVAL',
      authority: { ok: true, decision: { outcome: 'REQUIRE_APPROVAL', reasonCode: 'APPROVAL_REQUIRED' } },
      approvalStatus: 'APPROVED'
    }));
    return v.outcome === C.INTENT_VERDICT.EXECUTE_APPROVED && v.mayExecute === true &&
      v.budgetStillRequired === true && v.approvedIsNotAnAutonomousAllow === true &&
      v.outcome !== C.INTENT_VERDICT.EXECUTE_AUTO_ALLOW;
  })());

check('G4 用户拒绝 → DENY（不是 FAIL：重试不会改变它）',
  (function () {
    const v = C.evaluatePurchaseIntentVerdict(ctx({
      intentStatus: 'WAITING_APPROVAL',
      authority: { ok: true, decision: { outcome: 'REQUIRE_APPROVAL', reasonCode: 'APPROVAL_REQUIRED' } },
      approvalStatus: 'REJECTED'
    }));
    return v.outcome === C.INTENT_VERDICT.DENY && v.rejectedByUser === true && v.mayExecute === false;
  })());

check('G5 批准过期 → FAIL / APPROVAL_EXPIRED',
  (function () {
    const v = C.evaluatePurchaseIntentVerdict(ctx({
      intentStatus: 'WAITING_APPROVAL',
      authority: { ok: true, decision: { outcome: 'REQUIRE_APPROVAL', reasonCode: 'APPROVAL_REQUIRED' } },
      approvalStatus: 'EXPIRED'
    }));
    return v.outcome === C.INTENT_VERDICT.FAIL && v.reasonCode === C.DENY_REASON.APPROVAL_EXPIRED;
  })());

check('G6 ★ 批准已被另一笔购买消费 → DENY（一次性消费在恢复路径上的表现）',
  (function () {
    const v = C.evaluatePurchaseIntentVerdict(ctx({
      intentStatus: 'WAITING_APPROVAL',
      authority: { ok: true, decision: { outcome: 'REQUIRE_APPROVAL', reasonCode: 'APPROVAL_REQUIRED' } },
      approvalStatus: 'CONSUMED'
    }));
    return v.outcome === C.INTENT_VERDICT.DENY && v.approvalAlreadySpent === true &&
      v.reasonCode === C.DENY_REASON.APPROVAL_NOT_CONSUMED;
  })());

check('G7 权威说 DENY → DENY，并带回它自己的 reasonCode',
  (function () {
    const v = C.evaluatePurchaseIntentVerdict(ctx({
      authority: { ok: true, decision: { outcome: 'DENY', reasonCode: 'AUTONOMY_LIMIT' } }
    }));
    return v.outcome === C.INTENT_VERDICT.DENY && v.reasonCode === 'AUTONOMY_LIMIT' && v.mayExecute === false;
  })());

check('G8 ★ 终态优先于一切权威判定（AUTO_ALLOW 救不了一条已经结束的 intent）',
  ['COMPLETED', 'DENIED', 'EXPIRED', 'FAILED'].every(s => {
    const v = C.evaluatePurchaseIntentVerdict(ctx({ intentStatus: s }));
    return v.outcome === C.INTENT_VERDICT.FAIL && v.terminal === true &&
      v.reasonCode === C.DENY_REASON.INTENT_NOT_EXECUTABLE;
  }));

check('G9 ★ 过期优先于 AUTO_ALLOW（报价死了，AUTO_ALLOW 也不能让它复活）',
  (function () {
    const v = C.evaluatePurchaseIntentVerdict(ctx({ expiresAt: NOW - 1 }));
    return v.outcome === C.INTENT_VERDICT.FAIL && v.reasonCode === C.DENY_REASON.INTENT_EXPIRED &&
      v.expiredQuoteIsNotRevivedByAuthority === true && v.mayExecute === false;
  })());

check('G10 报价已经过期（quoteExpired）同样是 INTENT_EXPIRED，且不复活',
  (function () {
    const v = C.evaluatePurchaseIntentVerdict(ctx({ quoteExpired: true }));
    return v.outcome === C.INTENT_VERDICT.FAIL && v.reasonCode === C.DENY_REASON.INTENT_EXPIRED;
  })());

check('G11 报价不是 OPEN（已被消费）→ QUOTE_MISMATCH，而**不是** INTENT_EXPIRED（原因不同，代码就必须不同）',
  (function () {
    const v = C.evaluatePurchaseIntentVerdict(ctx({ quoteState: 'CONSUMED' }));
    return v.outcome === C.INTENT_VERDICT.FAIL && v.reasonCode === C.DENY_REASON.QUOTE_MISMATCH &&
      v.reasonCode !== C.DENY_REASON.INTENT_EXPIRED;
  })());

check('G12 商品 DISABLED / RETIRED → DENY / PRODUCT_DISABLED（只依赖 P22-5 既有状态词）',
  C.evaluatePurchaseIntentVerdict(ctx({ productStatus: 'DISABLED' })).outcome === C.INTENT_VERDICT.DENY &&
  C.evaluatePurchaseIntentVerdict(ctx({ productStatus: 'RETIRED' })).reasonCode === 'PRODUCT_DISABLED' &&
  C.evaluatePurchaseIntentVerdict(ctx({ productStatus: 'RETIRED' })).productStatus === 'RETIRED');

check('G13 ★ 权威面读不出来 → FAIL / systemFailure（那是"规则不可信"，不是"需要点头"）',
  [null, {}, { ok: false }, { ok: true }, { ok: true, decision: { outcome: 'MAYBE' } }].every(a => {
    const v = C.evaluatePurchaseIntentVerdict(ctx({ authority: a }));
    return v.outcome === C.INTENT_VERDICT.FAIL && v.systemFailure === true &&
      v.authorityPresent === false && v.reasonCode === C.DENY_REASON.POLICY_INPUT_NOT_STRUCTURED;
  }));

check('G14 ★ 优先级是可断言的（priority 随"先被哪一条拦下"单调递增）',
  (function () {
    const p = o => C.evaluatePurchaseIntentVerdict(ctx(o)).priority;
    const order = [
      p({ intentStatus: 'nonsense' }),          /* ① 形状 */
      p({ intentStatus: 'COMPLETED' }),          /* ② 终态 */
      p({ expiresAt: NOW - 1 }),                 /* ③ 过期 */
      p({ productStatus: 'DISABLED' }),          /* ④ 商品 */
      p({ authority: null }),                    /* ⑤ 权威不在场 */
      p({})                                      /* ⑥ AUTO_ALLOW */
    ];
    return order.every((v, i) => i === 0 || v >= order[i - 1]) && order[0] === 1 && order[5] === 6;
  })());

check('G15 INTENT_VERDICT_PRIORITY 是七个具名判据（与 AP_EVALUATION_PRIORITY 同款，机器可断言）',
  C.INTENT_VERDICT_PRIORITY.length === 7 &&
  C.INTENT_VERDICT_PRIORITY[0] === 'input-structured' &&
  C.INTENT_VERDICT_PRIORITY.indexOf('approval-outcome-when-required') === 6);

check('G16 ★ 每个裁决都自带"这不是经济事实"的自述（§8）',
  C.evaluatePurchaseIntentVerdict(ctx({})).intentStateIsAnOrchestrationFact === true &&
  C.evaluatePurchaseIntentVerdict(ctx({ intentStatus: 'COMPLETED' })).intentStateIsAnOrchestrationFact === true);

check('G17 now 非安全整数时拒绝（而不是拿一个 NaN 去比较时间）',
  C.evaluatePurchaseIntentVerdict(ctx({ now: NaN })).ok === false &&
  C.evaluatePurchaseIntentVerdict(ctx({ now: -1 })).ok === false &&
  C.evaluatePurchaseIntentVerdict(ctx({ now: 1.5 })).ok === false);

check('G18 ★ 五个裁决词恰好是那五个，且"允许"那个词与 Budget 的 ALLOW 不同族',
  JSON.stringify(C.INTENT_VERDICTS) ===
  JSON.stringify(['EXECUTE_AUTO_ALLOW', 'EXECUTE_APPROVED', 'WAIT_FOR_APPROVAL', 'DENY', 'FAIL']) &&
  C.INTENT_VERDICTS.indexOf('ALLOW') < 0 &&
  C.INTENT_VERDICTS.indexOf('AUTO_ALLOW') < 0);

/* ══════════════════════════════════════════════════════════════════════
   H · 自述字段与载入期不变量
   ══════════════════════════════════════════════════════════════════════ */
section('H · 自述字段与载入期不变量');

check('H1 ★ 十五条自述字段逐条存在且取值正确（"Intent 不是权限"是这个系统自己说的话）',
  C.PURCHASE_INTENT_IS_A_PERMISSION === false &&
  C.PURCHASE_INTENT_CARRIES_PRICE === false &&
  C.PURCHASE_INTENT_REASON_IS_AUTHORITY === false &&
  C.PURCHASE_INTENT_REASON_PARTICIPATES_IN_DECISIONS === false &&
  C.PURCHASE_INTENT_GRANTS_BUDGET === false &&
  C.PURCHASE_INTENT_BYPASSES_AUTONOMY === false &&
  C.PURCHASE_INTENT_BYPASSES_BUDGET === false &&
  C.PURCHASE_INTENT_BYPASSES_QUOTE_EXPIRY === false &&
  C.PURCHASE_INTENT_DEDUPE_IS_NOT_A_BUDGET === true &&
  C.PURCHASE_INTENT_EVERY_INTENT_PASSES_THE_AUTHORITY_GATE === true &&
  C.PURCHASE_INTENT_AUTO_ALLOW_STILL_REQUIRES_BUDGET === true &&
  C.PURCHASE_INTENT_APPROVAL_PATH_RESERVES_NOTHING === true &&
  C.PURCHASE_INTENT_RESUME_REQUIRES_THE_ORIGINAL_QUOTE === true &&
  C.PURCHASE_INTENT_RESUME_ASKS_THE_MODEL_AGAIN === false &&
  C.PURCHASE_INTENT_EXPOSES_HTTP_MUTATION === false &&
  C.PURCHASE_INTENT_CAN_CALL_SETTLE_DIRECTLY === false &&
  C.PURCHASE_INTENT_TOUCHES_PROVIDER === false &&
  C.PURCHASE_INTENT_TOUCHES_PAYMENT === false &&
  C.PURCHASE_INTENT_TOUCHES_MEMORY === false &&
  C.PURCHASE_INTENT_TOUCHES_RELATIONSHIP === false);

check('H2 ★ 有效期：默认 15 分钟、上限 24 小时，而且与 APPROVAL_MAX_LIFETIME_MS **相等**',
  C.PURCHASE_INTENT_DEFAULT_LIFETIME_MS === 15 * 60 * 1000 &&
  C.PURCHASE_INTENT_MAX_LIFETIME_MS === C.APPROVAL_MAX_LIFETIME_MS &&
  C.PURCHASE_INTENT_DEFAULT_LIFETIME_MS < C.PURCHASE_INTENT_MAX_LIFETIME_MS);

check('H3 ★ 重复窗口是 60 秒量级（防模型复读，不是预算）',
  C.PURCHASE_INTENT_DEDUPE_WINDOW_MS === 60 * 1000);

check('H4 三条新的拒绝码各自可判定，且与既有的两个自主代码**不重复**',
  ['MODEL_SUPPLIED_ECONOMIC_FACT', 'INTENT_EXPIRED', 'INTENT_NOT_EXECUTABLE']
    .every(r => C.isDenyReasonCode(r)) &&
  C.DENY_REASONS.indexOf('MODEL_SUPPLIED_ECONOMIC_FACT') !== C.DENY_REASONS.indexOf('POLICY_INPUT_NOT_STRUCTURED') &&
  C.DENY_REASON.INTENT_EXPIRED !== C.DENY_REASON.QUOTE_EXPIRED &&
  C.DENY_REASON.INTENT_EXPIRED !== C.DENY_REASON.APPROVAL_EXPIRED);

check('H5 ★ 封闭集合从 47 变成 50（写死数字是刻意的：加一个代码必须有人手动改这一行）',
  C.DENY_REASONS.length === 50, C.DENY_REASONS.length);

check('H6 没有引入兜底值（OTHER / UNKNOWN / ERROR 仍然不在集合里）',
  ['OTHER', 'UNKNOWN', 'ERROR', 'PENDING', 'APPROVED'].every(r => C.isDenyReasonCode(r) === false) &&
  C.isDenyReasonCode('intent_expired') === false);

check('H7 §15 四条写形态的路径名被登记在契约里（http 声明与真实路由必须同时更新）',
  ['/economy/intent/propose', '/economy/intent/execute', '/economy/buy', '/economy/execute']
    .every(p => C.PURCHASE_INTENT_HTTP_MUTATION_ROUTES.indexOf(p) >= 0));

check('H8 读面白名单里 reason 与 reasonIsAuthority **并列**（读到理由的同时读到"它不是权限"）',
  C.PURCHASE_INTENT_SUMMARY_KEYS.indexOf('reason') >= 0 &&
  C.PURCHASE_INTENT_SUMMARY_KEYS.indexOf('reasonIsAuthority') >= 0 &&
  C.PURCHASE_INTENT_LIST_KEYS.indexOf('agentId') >= 0 &&
  C.PURCHASE_INTENT_LIST_KEYS.length === 4);

check('H9 ★ 既有的 P22-7 / P22-6 边界一个字都没动（加层不等于换词表）',
  C.APPROVAL_STATES.length === 5 && C.PURCHASE_STATES.length === 4 &&
  C.AP_DECISIONS.length === 3 &&
  C.AUTONOMY_DEFAULT_WHEN_NO_POLICY === 'REQUIRE_APPROVAL' &&
  C.PURCHASE_PREPARE_REQUIRES_BUDGET_ALLOW === true &&
  C.PURCHASE_SETTLE_REVALIDATES_BUDGET === true &&
  C.APPROVAL_BYPASSES_BUDGET === false &&
  C.APPROVAL_BYPASSES_QUOTE_EXPIRY === false);

check('H10 ★ 新增的十六种 id 里 P22-1 冻结的十四个形状一个都没改',
  C.ID_PREFIX.WALLET === 'econ_wallet_' && C.ID_PREFIX.ACCOUNT === 'econ_account_' &&
  C.ID_PREFIX.TRANSACTION === 'econ_tx_' && C.ID_PREFIX.LEDGER_ENTRY === 'econ_entry_' &&
  C.ID_PREFIX.RESERVATION === 'econ_res_' && C.ID_PREFIX.PURCHASE_INTENT === 'econ_intent_' &&
  C.ID_PREFIX.BUDGET_POLICY === 'econ_policy_' && C.ID_PREFIX.STORE === 'econ_store_' &&
  C.ID_PREFIX.PRODUCT === 'econ_product_' && C.ID_PREFIX.INVENTORY_ENTRY === 'econ_inv_' &&
  C.ID_PREFIX.QUOTE === 'econ_quote_' && C.ID_PREFIX.EXCHANGE_RATE === 'econ_rate_' &&
  C.ID_PREFIX.APPROVAL === 'econ_approval_' && C.ID_PREFIX.EVENT === 'econ_evt_');

check('H11 ★ §14：Economy 对既有 Action seam 的边仍然只有 ADAPTER_ONLY，而 Memory / Relationship 仍然是 FORBIDDEN_WRITE',
  (function () {
    const rows = C.DEPENDENCY_MATRIX.filter(r => r.from === 'Economy');
    const of = to => rows.filter(r => r.to === to);
    return of('ExistingAction').length > 0 &&
      of('ExistingAction').every(r => r.rule === 'ADAPTER_ONLY') &&
      of('Memory').every(r => r.rule === 'FORBIDDEN_WRITE') &&
      of('Relationship').every(r => r.rule === 'FORBIDDEN_WRITE') &&
      of('RealPayment').every(r => r.rule === 'FORBIDDEN') &&
      of('ProviderBilling').every(r => r.rule === 'FORBIDDEN');
  })());

check('H12 ★ §2/§14：契约里没有第二条"执行经济动作"的通用入口名（窄接口是唯一提议入口）',
  (function () {
    const exported = Object.keys(C);
    return ['executeEconomyAction', 'runEconomyAction', 'settleForAgent', 'buyNow',
      'approveForAgent', 'applyModelAction', 'executeModelAction', 'decidePurchase']
      .every(k => exported.indexOf(k) < 0) &&
      typeof C.evaluatePurchaseIntentVerdict === 'function' &&
      typeof C.normalizePurchaseIntentProposal === 'function';
  })());

console.log('\n' + (failures === 0 ? '通过 ✔ 0 失败' : '失败 ' + failures + ' 项') + ' · P22-8 intent 契约');
process.exit(failures === 0 ? 0 : 1);
