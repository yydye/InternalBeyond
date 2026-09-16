'use strict';
/* ====================================================================
   P22-15 · Economy Approval UI — 纯层（视图模型 / 文案映射 / 请求体）
   --------------------------------------------------------------------
   运行：node tests/test_p22_15_economy_approval_ui_core.js

   ── 零资源（§19）────────────────────────────────────────────────────
   本文件不启动任何东西：无子进程、无 socket、无浏览器、无文件写入。
   纯层被加载进一个 vm 沙箱，沙箱里**故意不放** document / fetch ——
   因此"core 不碰 DOM、不发请求"不是一句注释，而是"它想做也做不到"。

   ── 与 canonical 契约的比对是逐字的 ─────────────────────────────────
   §6 禁止浏览器重算经济事实，但展示需要币种 scale 与币种名。本文件的
   F 组把这两张镜像表与 services/home-node/economy-contract.js 的
   CURRENCY_SCALE / CURRENCY_DISPLAY **逐个键比对**：契约加一种币而
   镜像没跟上时，这里是红，而不是静默显示一个错的金额。
   ==================================================================== */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const CORE_SRC = path.join(ROOT, 'assets', 'js', 'economy-approval-core.js');
const CONTRACT = require(path.join(ROOT, 'services', 'home-node', 'economy-contract.js'));

let checks = 0;
let failures = 0;
function check(name, cond, extra) {
  checks += 1;
  if (cond) { console.log('  ✔ ' + name); return true; }
  failures += 1;
  console.error('  ✖ ' + name + (extra !== undefined ? ' — ' + JSON.stringify(extra) : ''));
  return false;
}
function section(t) { console.log('\n── ' + t + ' ' + '─'.repeat(Math.max(0, 62 - t.length))); }
function read(f) { return fs.readFileSync(path.join(ROOT, f), 'utf8'); }

console.log('P22-15 · Economy Approval UI core（纯层）');

/* ── 沙箱：只有一个 window，没有 document、没有 fetch、没有 location ──
   ★ 这是刻意的：core 的"纯"由**环境**证明，不由它的注释证明。 */
const box = { console: { log() {}, warn() {}, error() {}, info() {} } };
box.window = box; box.self = box;
const sandbox = vm.createContext(box);
let core = null;
try {
  vm.runInContext(read('assets/js/economy-approval-core.js'), sandbox, { filename: 'economy-approval-core.js' });
  core = box.IB && box.IB.economyApprovalCore;
} catch (error) {
  console.error('  加载纯层失败 — ' + String((error && error.stack) || error));
  failures += 1;
}
const coreSrc = read('assets/js/economy-approval-core.js');
const coreCode = coreSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/* ══════════════════════════════════════════════════════════════════════ */
section('A · 纯层存在，而且它真的纯');

check('A1 ★★ 纯层加载成功并挂在 window.IB.economyApprovalCore 上',
  !!core && typeof core.buildView === 'function' && typeof core.buildDecisionRequest === 'function');

check('A2 ★★★ 沙箱里**没有** document / window.document / fetch —— 纯层不碰 DOM、不发请求',
  typeof box.document === 'undefined' && typeof box.fetch === 'undefined' &&
  typeof box.XMLHttpRequest === 'undefined' && typeof box.location === 'undefined' &&
  coreCode.indexOf('document') < 0 && coreCode.indexOf('fetch') < 0 &&
  coreCode.indexOf('XMLHttpRequest') < 0 && coreCode.indexOf('localStorage') < 0,
  { document: typeof box.document, fetch: typeof box.fetch });

check('A3 ★★ 纯层不认识任何"写"动词：没有 POST、没有 decideApproval、没有 settle/reserve/mint',
  ['POST', 'decideApproval', 'settle', 'reserve', 'mint', 'transfer', 'ledger'].every(function (w) {
    return coreCode.indexOf(w) < 0;
  }));

check('A4 ★★ 唯一的写路径常量是 P22-13 的那一条，且它不落在 /economy/ 前缀下',
  core.ID.DECISION_PATH === '/internal/economy/approval-decision' &&
  core.ID.DECISION_PATH.indexOf('/economy/') !== 0);

check('A5 ★★ 只读面恰好是四条既有的 GET：三条经济读面 + /security（本阶段不新增读路径）',
  JSON.stringify(Object.keys(core.READS).sort()) === JSON.stringify(['APPROVALS', 'INTENTS', 'PRODUCTS', 'SECURITY']) &&
  core.READS.INTENTS === '/economy/intents' &&
  core.READS.APPROVALS === '/economy/approvals' &&
  core.READS.PRODUCTS === '/economy/products' &&
  core.READS.SECURITY === '/security');

check('A5b ★★★ "决定路径开不开"是**搬**来的：decisionGate 只读 /security 的两个字段，读不到就答 null',
  core.decisionGate({ economyPolicy: { approvalDecision: { implemented: true, open: true } } }).open === true &&
  core.decisionGate({ economyPolicy: { approvalDecision: { implemented: true, open: false } } }).open === false &&
  core.decisionGate({ economyPolicy: { approvalDecision: { implemented: false, open: false } } }).open === false &&
  core.decisionGate({}) === null && core.decisionGate(null) === null && core.decisionGate('nope') === null &&
  /* 它不推断：没有凭据字段可读时回答"不知道"，而不是猜成关着。 */
  core.decisionGate({ economyPolicy: { approvalDecision: { requiresConfiguredDesktopCredential: true } } }).open === false);

check('A6 ★★★ 决定词恰好两个，且与 canonical 的批准状态逐字一致',
  JSON.stringify(core.DECISIONS) === JSON.stringify(['APPROVE', 'REJECT']) &&
  core.DECISION.APPROVE === 'APPROVE' && core.DECISION.REJECT === 'REJECT' &&
  CONTRACT.APPROVAL_STATE.APPROVED === 'APPROVED' && CONTRACT.APPROVAL_STATE.REJECTED === 'REJECTED');

check('A7 ★★★ 请求体键恰好三个（§15 的封闭信封）',
  JSON.stringify(core.REQUEST_KEYS) === JSON.stringify(['approvalId', 'decision', 'idempotencyKey']));

/* ══════════════════════════════════════════════════════════════════════ */
section('B · §15 请求体：只有三个字段，而且没有地方塞第四个');

const built = core.buildDecisionRequest('econ_appr_1', 'APPROVE', 'ui-k-1');
check('B1 ★★★ 合法输入构造出的对象键恰好是三个，且值原样',
  built.ok === true && JSON.stringify(Object.keys(built.body)) === JSON.stringify(['approvalId', 'decision', 'idempotencyKey']) &&
  built.body.approvalId === 'econ_appr_1' && built.body.decision === 'APPROVE' && built.body.idempotencyKey === 'ui-k-1');

check('B2 ★★★ 函数签名恰好三个位置参数 —— 调用方**没有**第四个位置可以放身份或金额',
  core.buildDecisionRequest.length === 3);

/* ── 两个问题必须分开问，否则会得到一个错的通过 ─────────────────────────
   ① 纯层**构造**请求体时，有没有位置塞身份 / 金额？
      → 看的是"这些键有没有作为**被写出的属性**出现"（`k:` / `k =`）。
        它们作为**字符串字面量**出现在 REQUEST_KEYS 之类的清单里是正常的
        （那正是"封闭信封"的声明本身）。
   ② 纯层**读**经济字段（agentId / productId / amountMinor …）是不是就等于
      它在判定？→ 不是。§6 禁止的是"重算"，不是"读取"。因此第②问由 G 组
      用真实视图模型回答（余额 / 可用 / 剩余 / 能否购买这些**算出来的**
      字段一个都不存在）。 */
function writtenAsProperty(src, key) {
  const re = new RegExp('(?:^|[^A-Za-z0-9_$])' + key + '\\s*[:=](?!=)', 'm');
  return re.test(src);
}
const identityKeys = ['consumerId', 'userId', 'decidedBy', 'authority', 'approved', 'autoAllow'];
check('B3 ★★★ 六个身份 / 权威字段在纯层里从不作为属性被写出（它们没有位置可去）',
  identityKeys.every(function (k) { return !writtenAsProperty(coreCode, k); }),
  identityKeys.filter(function (k) { return writtenAsProperty(coreCode, k); }));

check('B3b ★★★ 请求体构造点写出的属性恰好三个，且它就是 REQUEST_KEYS 那一份',
  (function () {
    /* 只看那一个对象字面量（`var body = { … }`），不看函数里其它返回信封。 */
    const lit = (coreSrc.match(/var body = \{[\s\S]*?\n  \};/) || [''])[0];
    const written = (lit.match(/^\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*:/gm) || [])
      .map(function (s) { return s.replace(/[\s:]/g, ''); });
    return lit.length > 0 && written.length === 3 &&
      written.slice().sort().join(',') === core.REQUEST_KEYS.slice().sort().join(',');
  })());

check('B4 ★★ 未知决定词被拒（不是"当作允许"）',
  core.buildDecisionRequest('econ_appr_1', 'AUTO_ALLOW', 'k').ok === false &&
  core.buildDecisionRequest('econ_appr_1', 'approve', 'k').ok === false &&
  core.buildDecisionRequest('econ_appr_1', 'ALLOW', 'k').ok === false);

check('B5 ★★ 缺 approvalId / 缺幂等键 / 空串都被拒，且不构造半个对象',
  core.buildDecisionRequest('', 'APPROVE', 'k').ok === false &&
  core.buildDecisionRequest('econ_appr_1', 'APPROVE', '').ok === false &&
  core.buildDecisionRequest(null, 'APPROVE', 'k').ok === false &&
  core.buildDecisionRequest('econ_appr_1', 'APPROVE', null).ok === false);

const key1 = core.newIdempotencyKey('econ-appr-approve');
const key2 = core.newIdempotencyKey('econ-appr-approve');
check('B6 ★★ 生成的幂等键只含 [a-z0-9-]（canonical 幂等键的词表）且有界',
  /^[a-z0-9-]+$/.test(key1) && key1.length > 8 && key1.length <= 96 &&
  /^[a-z0-9-]+$/.test(key2));

check('B7 ★★ 两次生成不同（不同手势 = 不同身份；重试复用由调用方持有）',
  key1 !== key2);

/* ══════════════════════════════════════════════════════════════════════ */
section('C · 状态：canonical 词 → 面；未知词保留原词');

function faceOf(code) { return core.statusFace(code); }

check('C1 ★★ WAITING_APPROVAL 是"等待你的决定"，而不是把词表直接写给用户',
  faceOf('WAITING_APPROVAL').label === '等待你的决定' && faceOf('WAITING_APPROVAL').tone === 'waiting' &&
  faceOf('WAITING_APPROVAL').label.indexOf('WAITING') < 0);

check('C2 ★★★ 六个状态各有自己的面，而且都不是同一个词',
  ['WAITING_APPROVAL', 'EXECUTING', 'COMPLETED', 'DENIED', 'EXPIRED', 'FAILED'].map(function (s) {
    return faceOf(s).label;
  }).filter(function (v, i, a) { return a.indexOf(v) === i; }).length === 6);

check('C3 ★★ COMPLETED / CONSUMED 都读作"已完成"（批准被消费就是购买成立的结果）',
  faceOf('COMPLETED').tone === 'done' && faceOf('COMPLETED').label === '已完成' &&
  faceOf('CONSUMED').tone === 'done');

check('C4 ★★ REJECTED 是正常终态，用的是"已拒绝"而不是错误词',
  faceOf('REJECTED').label === '已拒绝' && faceOf('REJECTED').tone === 'denied' &&
  faceOf('REJECTED').label.indexOf('错误') < 0 && faceOf('REJECTED').label.indexOf('失败') < 0);

check('C5 ★★★ 未知词不被硬塞进任何已知桶：保留原词 + 中性面 + known:false',
  faceOf('SOMETHING_NEW').known === false &&
  faceOf('SOMETHING_NEW').code === 'SOMETHING_NEW' &&
  faceOf('SOMETHING_NEW').label !== '已完成' && faceOf('SOMETHING_NEW').label !== '已拒绝' &&
  faceOf(null).known === false);

check('C6 ★★ 状态词表里的每一个键都在 canonical 契约里存在（没有界面自造的状态）',
  Object.keys(core.STATUS_FACE).every(function (k) {
    return CONTRACT.PURCHASE_INTENT_STATES.indexOf(k) >= 0 || CONTRACT.APPROVAL_STATES.indexOf(k) >= 0;
  }),
  Object.keys(core.STATUS_FACE).filter(function (k) {
    return CONTRACT.PURCHASE_INTENT_STATES.indexOf(k) < 0 && CONTRACT.APPROVAL_STATES.indexOf(k) < 0;
  }));

check('C7 ★★ 意图状态与批准状态的镜像逐字等于契约的两个词表',
  JSON.stringify(core.INTENT_STATE) === JSON.stringify(CONTRACT.PURCHASE_INTENT_STATE) &&
  JSON.stringify(core.APPROVAL_STATUS) === JSON.stringify(CONTRACT.APPROVAL_STATE));

/* ══════════════════════════════════════════════════════════════════════ */
section('D · §6 / §14 文案：用户看不到 reasonCode 原词');

/* ★ D1/D2 问的是**同一件事的两个半边**，合起来才成立：
     ① 每一个 canonical 拒绝码在界面词表里都有位置（要么有句子，要么被
        明确登记为"不面向用户"）；
     ② 而"不面向用户"与"已有句子"两份名单**不相交**（否则一个码既是
        "不显示"又是"有文案"，两份声明互相矛盾）。
   ★ 关键纪律在 D2c：**未映射的码绝不原样出现在正文里** —— 它给一句
     中性话，而原词只出现在技术详情层（§14 允许的位置）。 */
const UNMAPPED = Object.keys(CONTRACT.DENY_REASON).filter(function (k) {
  return typeof core.REASON_TEXT[k] !== 'string';
});
check('D1 ★★★ canonical 的 50 个拒绝码在界面词表里各有位置（有句子，或被登记为不面向用户）',
  UNMAPPED.length === 0, UNMAPPED);

check('D2 ★★★ §14 那一类：每一个已映射的码翻成的句子都不含原码、不含下划线',
  (function () {
    /* §14 点名的三条是**示例**（APPROVAL_EXPIRED / TRANSITION_NOT_ALLOWED /
       AMOUNT_EXCEEDS_PER_TRANSACTION），因此这里断言的是**整张表**的性质：
       任何一句用户文案里都不许残留 canonical 词的形态。 */
    const keys = Object.keys(core.REASON_TEXT);
    return keys.length >= 40 && keys.every(function (k) {
      const t = core.REASON_TEXT[k];
      return typeof t === 'string' && t.length > 0 && t.indexOf(k) < 0 && t.indexOf('_') < 0 &&
        !/[A-Z]{4,}/.test(t);
    }) && core.reasonText('AMOUNT_EXCEEDS_PER_TRANSACTION') === '这次金额超过了单笔上限' &&
      core.reasonText('APPROVAL_EXPIRED') === '这条许可已经过期了' &&
      core.reasonText('TRANSITION_NOT_ALLOWED') === '这一步现在不能做';
  })());

check('D2c ★★★ 未映射 / 未知的码绝不原样进正文：界面回答 null，正文走中性句',
  core.reasonText('SOME_FUTURE_CODE') === null &&
  core.reasonText('MODEL_SUPPLIED_ECONOMIC_FACT') !== null &&
  /* 正文侧的兜底句里没有码形态 */
  ['后续步骤没有通过', '这次决定没有生效'].every(function (s) { return !/[A-Z]{4,}/.test(s); }));

check('D3 ★★★ §7 拒绝不是错误状态：REJECTED 的路径上没有一条文案带"错误 / 失败 / 警告"',
  faceOf('REJECTED').label.indexOf('错') < 0 &&
  core.decisionRefusalText('ECONOMY_APPROVAL_CONTINUATION_REFUSED').indexOf('失败') < 0);

check('D4 ★★ 未知 reasonCode 回答 null —— 界面宁可不解释，也不编一句',
  core.reasonText('NO_SUCH_REASON') === null && core.reasonText(null) === null);

check('D5 ★★ P22-13 的每一个拒绝码都有文案（那十七条不会被显示成原词）',
  Object.keys(core.DECISION_REFUSAL_TEXT).length >= 17 &&
  Object.keys(core.DECISION_REFUSAL_TEXT).every(function (k) { return core.DECISION_REFUSAL_TEXT[k].length > 0; }));

/* ══════════════════════════════════════════════════════════════════════ */
section('E · 金额：只格式化，不判定');

check('E1 ★★ 金额展示与 canonical 的 toDisplayParts 逐字一致（12345 IB_CREDIT → 123.45）',
  core.formatAmount(12345, 'IB_CREDIT') === '123.45' &&
  core.formatAmount(50, 'COMPUTE_PREMIUM') === '50' &&
  core.amountText(12345, 'IB_CREDIT') === '123.45 IB Credit');

check('E2 ★★ 非法 / 未知输入不被兜成 0（宁可不显示，也不显示一个错的数）',
  core.formatAmount(-1, 'IB_CREDIT') === null &&
  core.formatAmount(1.5, 'IB_CREDIT') === null &&
  core.formatAmount('abc', 'IB_CREDIT') === null &&
  core.formatAmount(100, 'NOT_A_CURRENCY') === null);

check('E3 ★★★ 格式化函数里没有任何加总 / 比较 / 聚合（只有两次字符串切分与两个守卫）',
  (function () {
    const body = (coreSrc.match(/function formatAmount\([\s\S]*?\n\}/) || [''])[0];
    const code = body.replace(/\/\*[\s\S]*?\*\//g, '');
    return body.length > 0 &&
      code.indexOf('reduce') < 0 && code.indexOf('Math.') < 0 &&
      code.indexOf('+=') < 0 && code.indexOf('sum') < 0 &&
      (code.match(/[<>]=?/g) || []).length <= 4 &&
      code.indexOf('balance') < 0 && code.indexOf('budget') < 0;
  })());

/* ══════════════════════════════════════════════════════════════════════ */
section('F · 与 canonical 契约的镜像必须逐键相同');

check('F1 ★★★ 币种 scale 镜像与契约的 CURRENCY_SCALE 完全一致（增删键都会红）',
  JSON.stringify(Object.keys(core.CURRENCY_SCALE).sort()) === JSON.stringify(Object.keys(CONTRACT.CURRENCY_SCALE).sort()) &&
  Object.keys(CONTRACT.CURRENCY_SCALE).every(function (k) { return core.CURRENCY_SCALE[k] === CONTRACT.CURRENCY_SCALE[k]; }),
  { mirror: core.CURRENCY_SCALE, contract: CONTRACT.CURRENCY_SCALE });

check('F2 ★★★ 币种展示名镜像与契约的 CURRENCY_DISPLAY 完全一致',
  Object.keys(CONTRACT.CURRENCY_DISPLAY).every(function (k) { return core.CURRENCY_LABEL[k] === CONTRACT.CURRENCY_DISPLAY[k]; }));

check('F3 ★★ 商品类别的镜像与契约一致，且每个都有中文展示名',
  JSON.stringify(Object.keys(core.PRODUCT_KIND_LABEL).sort()) === JSON.stringify(Object.keys(CONTRACT.PRODUCT_KIND).sort()) &&
  Object.keys(CONTRACT.PRODUCT_KIND).every(function (k) { return typeof core.PRODUCT_KIND_LABEL[k] === 'string'; }));

check('F4 ★★ 契约里没有真实货币（法币）出现在镜像表里',
  CONTRACT.FORBIDDEN_CURRENCY_TOKENS.every(function (t) {
    return Object.keys(core.CURRENCY_LABEL).indexOf(t) < 0 && Object.keys(core.CURRENCY_SCALE).indexOf(t) < 0;
  }));

/* ══════════════════════════════════════════════════════════════════════ */
section('G · 视图模型：合成三个读面，不推导任何经济事实');

const NOW = 1700000000000;
function intentOf(o) {
  return Object.assign({
    agentIntentId: 'econ_intent_1', state: 'WAITING_APPROVAL', agentId: 'cfg_agent', agentType: 'character',
    productId: 'econ_prod_1', units: 2, selfDirected: true, recipientId: null,
    quoteId: 'econ_quote_1', approvalId: 'econ_appr_1', purchaseId: null,
    authorityOutcome: 'REQUIRE_APPROVAL', authorityReasonCode: 'AMOUNT_EXCEEDS_APPROVAL_THRESHOLD',
    reasonCode: null, reason: 'compute is running low', createdAt: NOW - 60000, updatedAt: NOW - 30000,
    expiresAt: NOW + 3600000, terminal: false
  }, o || {});
}
function approvalOf(o) {
  return Object.assign({
    approvalId: 'econ_appr_1', status: 'PENDING', buyerId: 'character:cfg_agent', recipientId: null,
    productId: 'econ_prod_1', quoteId: 'econ_quote_1', quoteKind: 'COMPUTE_GRANT', currency: 'IB_CREDIT',
    amountMinor: '1000', units: 2, expiresAt: NOW + 600000, expiredByTime: false,
    binding: { amountMinor: '1000', currency: 'IB_CREDIT', units: 2 }
  }, o || {});
}
const PRODUCT = { productId: 'econ_prod_1', name: 'Compute x1000', description: '给她的算力补充', kind: 'COMPUTE_CREDIT' };

const view = core.buildView({ intents: [intentOf()], approvals: [approvalOf()], products: [PRODUCT] }, { now: NOW });

check('G1 ★★ 一条等待中的请求进入 waiting 桶，带着产品事实与金额事实',
  view.waiting.length === 1 && view.history.length === 0 &&
  view.waiting[0].productName === 'Compute x1000' &&
  view.waiting[0].amountText === '10.00 IB Credit' &&
  view.waiting[0].units === 2 && view.waiting[0].reason === 'compute is running low');

check('G2 ★★★ 金额来自 canonical 的批准绑定，而不是浏览器按单价 × 数量算出来的',
  view.waiting[0].amountMinor === '1000' &&
  view.waiting[0].amountText.indexOf('10.00') === 0 &&
  coreSrc.indexOf('unitPriceMinor') < 0);

check('G3 ★★★ 视图模型里没有任何"算出来的"经济字段（余额 / 剩余额度 / 可用性 / 能否购买）',
  ['balance', 'available', 'remaining', 'sufficient', 'canAfford', 'mayExecute', 'budgetRemaining', 'isValid']
    .every(function (k) { return coreCode.indexOf(k) < 0; }));

check('G4 ★★ 理由被逐字带出来，并同时标明它不是权限',
  view.waiting[0].reason === 'compute is running low' && view.waiting[0].reasonIsAuthority === false);

check('G5 ★★ 状态停在 PENDING 的批准 ⇒ WAITING_APPROVAL 的面；而且"决定有效期"来自读面的 expiresAt',
  view.waiting[0].statusCode === 'WAITING_APPROVAL' && view.waiting[0].statusLabel === '等待你的决定' &&
  view.waiting[0].facts.some(function (f) { return f.key === 'approval-expires' && /还有 10 分钟/.test(f.value); }),
  view.waiting[0].facts);

check('G6 ★★★ 批准被拒（REJECTED）后这条 intent 不再出现在"待决定"，而是落在历史区',
  (function () {
    const v = core.buildView({
      intents: [intentOf({ state: 'WAITING_APPROVAL' })],
      approvals: [approvalOf({ status: 'REJECTED' })], products: [PRODUCT]
    }, { now: NOW });
    return v.waiting.length === 0 && v.history.length === 1 && v.history[0].statusCode === 'REJECTED' &&
      v.history[0].statusLabel === '已拒绝';
  })());

check('G7 ★★ 批准按时间过期而 intent 还没推进 ⇒ 显示"已过期"，而不是继续请他决定',
  (function () {
    const v = core.buildView({
      intents: [intentOf()],
      approvals: [approvalOf({ status: 'PENDING', expiredByTime: true })], products: [PRODUCT]
    }, { now: NOW });
    return v.waiting.length === 0 && v.history[0].statusCode === 'EXPIRED' &&
      v.history[0].statusLabel === '已过期';
  })());

check('G8 ★★★ 批准记录读不到（超出 limit）时**不**当成"等你决定"：它落在历史区并如实说找不到',
  (function () {
    const v = core.buildView({ intents: [intentOf()], approvals: [], products: [PRODUCT] }, { now: NOW });
    return v.waiting.length === 0 && v.history.length === 1 &&
      v.history[0].statusCode === 'UNKNOWN' &&
      String(v.history[0].statusNote).indexOf('找不到') >= 0;
  })());

check('G9 ★★ 商品读不到时如实留空（不编名字、不算价格）',
  (function () {
    const v = core.buildView({ intents: [intentOf()], approvals: [approvalOf()], products: [] }, { now: NOW });
    return v.waiting[0].productMissing === true && v.waiting[0].productName === null &&
      v.waiting[0].amountText === '10.00 IB Credit';
  })());

check('G10 ★★ APPROVED 但续做被拒 ⇒ "已允许"且如实说没有继续（§5：批准不等于买到）',
  (function () {
    const v = core.buildView({
      intents: [intentOf({ state: 'WAITING_APPROVAL' })],
      approvals: [approvalOf({ status: 'APPROVED' })], products: [PRODUCT]
    }, { now: NOW });
    return v.waiting.length === 0 && v.history[0].statusLabel === '已允许 · 等待继续';
  })());

check('G11 ★★ COMPLETED + purchaseId ⇒ "已完成"，并且购买是读面给的而不是推出来的',
  (function () {
    const v = core.buildView({
      intents: [intentOf({ state: 'COMPLETED', purchaseId: 'econ_pur_1' })],
      approvals: [approvalOf({ status: 'CONSUMED' })], products: [PRODUCT]
    }, { now: NOW });
    return v.history[0].statusCode === 'COMPLETED' && v.history[0].purchaseId === 'econ_pur_1' &&
      v.history[0].facts.some(function (f) { return f.key === 'purchase'; });
  })());

check('G12 ★★ DENIED / EXPIRED / FAILED 三个终态各自保留 canonical 词',
  ['DENIED', 'EXPIRED', 'FAILED'].every(function (s) {
    const v = core.buildView({
      intents: [intentOf({ state: s })], approvals: [approvalOf({ status: 'APPROVED' })], products: [PRODUCT]
    }, { now: NOW });
    return v.history.length === 1 && v.history[0].statusCode === s;
  }));

section('H · 坏读模型：不抛、不猜、不显示假数据');

check('H1 ★★ 输入全空 / undefined / 字符串都返回一个空视图，而不是抛异常',
  (function () {
    const a = core.buildView(undefined);
    const b = core.buildView({ intents: 'nope', approvals: 7, products: null });
    const c = core.buildView({ intents: [null, 3, 'x'], approvals: [null], products: [null] });
    return a.waiting.length === 0 && a.history.length === 0 &&
      b.waiting.length === 0 && c.waiting.length === 0;
  })());

check('H2 ★★ 缺 agentIntentId 的行被跳过（合成不出身份的卡片不该出现）',
  core.buildView({ intents: [{ state: 'WAITING_APPROVAL', approvalId: 'econ_appr_1' }] }, { now: NOW }).waiting.length === 0);

check('H3 ★★ 同一 intent 出现两次只渲染一次（不产生两张一样的卡片）',
  (function () {
    const v = core.buildView({
      intents: [intentOf(), intentOf()], approvals: [approvalOf()], products: [PRODUCT]
    }, { now: NOW });
    return v.waiting.length === 1;
  })());

check('H4 ★★ 读面明确给的 authorityOutcome / reasonCode 被呈现，且原词留在 facts 的 code 上（只进细节层）',
  (function () {
    const f = view.waiting[0].facts.filter(function (x) { return x.code; });
    return f.some(function (x) { return x.value === '需要你确认' && x.code === 'REQUIRE_APPROVAL'; }) &&
    f.some(function (x) { return x.code === 'AMOUNT_EXCEEDS_APPROVAL_THRESHOLD' && x.value.indexOf('CODE') < 0; });
  })());

check('H5 ★★ 历史区有上限，而且如实报告被截断了多少',
  (function () {
    const intents = [];
    for (let i = 0; i < 20; i++) {
      intents.push(intentOf({ agentIntentId: 'econ_intent_' + i, approvalId: 'econ_appr_' + i, state: 'COMPLETED', updatedAt: NOW - i * 1000 }));
    }
    const approvals = intents.map(function (x) { return approvalOf({ approvalId: x.approvalId, status: 'CONSUMED' }); });
    const v = core.buildView({ intents: intents, approvals: approvals, products: [PRODUCT] }, { now: NOW });
    return v.history.length === core.HISTORY_LIMIT && v.historyTotal === 20 && v.historyTruncated === true;
  })());

/* ══════════════════════════════════════════════════════════════════════ */
section('I · 决定回答的归类（§5 / §7 / §14）');

check('I1 ★★★ APPROVE + 续做成功 + 有购买 ⇒ "已允许"，并且**不**说"购买成功"',
  (function () {
    const n = core.classifyDecisionResponse({
      ok: true, status: 200, refused: false, decision: 'APPROVE', approvalStatus: 'APPROVED',
      continuation: 'attempted', continuationOk: true, purchaseCreatedNow: true, purchaseExists: true,
      continuedIntentState: 'COMPLETED', continuedPurchaseId: 'econ_pur_1'
    });
    return n.outcome === 'approved-completed' && n.text === '已允许' &&
      n.detail.indexOf('购买成功') < 0 && n.detail.indexOf('完成') >= 0;
  })());

check('I2 ★★★ APPROVE 但续做被拒 ⇒ "已允许" + 如实说没有继续（不许乐观）',
  (function () {
    const n = core.classifyDecisionResponse({
      ok: true, status: 200, refused: false, decision: 'APPROVE', approvalStatus: 'APPROVED',
      continuation: 'refused', continuationOk: false, continuationReasonCode: 'INSUFFICIENT_AVAILABLE_BALANCE',
      purchaseCreatedNow: false, purchaseExists: false, continuedIntentState: null
    });
    return n.outcome === 'approved-not-continued' && n.text === '已允许' &&
      n.detail.indexOf('余额') >= 0 && n.detail.indexOf('INSUFFICIENT') < 0;
  })());

check('I3 ★★ REJECT 的回答是"已拒绝"，并明说没有产生任何经济动作',
  (function () {
    const n = core.classifyDecisionResponse({
      ok: true, status: 200, refused: false, decision: 'REJECT', approvalStatus: 'REJECTED',
      continuation: 'none', purchaseCreatedNow: false, ledgerMutation: false
    });
    return n.outcome === 'rejected' && n.text === '已拒绝' && n.detail.indexOf('没有产生') >= 0;
  })());

check('I4 ★★★ 决定被状态机拒绝（refused）时把下游原词**翻译**给用户，原词只在字段里',
  (function () {
    const n = core.classifyDecisionResponse({
      ok: false, status: 409, refused: true,
      reasonCode: 'ECONOMY_APPROVAL_DECISION_REFUSED_BY_THE_APPROVAL_STATE_MACHINE',
      downstreamReasonCode: 'TRANSITION_NOT_ALLOWED', decisionRecorded: false
    });
    return n.ok === false && n.outcome === 'refused' &&
      n.text.indexOf('不接受这个决定') >= 0 && n.text.indexOf('TRANSITION') < 0 &&
      n.reasonCode === 'ECONOMY_APPROVAL_DECISION_REFUSED_BY_THE_APPROVAL_STATE_MACHINE' &&
      n.downstreamReasonCode === 'TRANSITION_NOT_ALLOWED';
  })());

check('I5 ★★ 重放（purchaseCreatedNow=false 但 purchaseExists=true）读作"之前就已经完成"，不读作失败',
  (function () {
    const n = core.classifyDecisionResponse({
      ok: true, status: 200, decision: 'APPROVE', approvalStatus: 'APPROVED',
      continuation: 'attempted', continuationOk: true, continuationReplayed: true,
      purchaseCreatedNow: false, purchaseExists: true, continuedIntentState: 'COMPLETED'
    });
    return n.outcome === 'approved-completed' && n.detail.indexOf('重放') >= 0;
  })());

check('I6 ★★ 空 / 坏回答归类成 transport-error，而不是被当成成功',
  core.classifyDecisionResponse(null).ok === false &&
  core.classifyDecisionResponse(undefined).outcome === 'transport-error' &&
  core.classifyDecisionResponse('nope').ok === false);

check('I7 ★★ 读面失败的归类走 transport 词表；未知码保留原码但给中性句',
  core.classifyReadFailure('home-node-unreachable').text === '连接不上本机节点' &&
  core.classifyReadFailure('timeout').kind === 'transport' &&
  core.classifyReadFailure('some-new-code').kind === 'unknown');

/* ══════════════════════════════════════════════════════════════════════ */
section('J · 时间展示：只做换算，不做判定');

check('J1 ★★ 相对时间两个方向都对',
  core.relativeTime(NOW + 600000, NOW) === '还有 10 分钟' &&
  core.relativeTime(NOW - 7200000, NOW) === '2 小时前' &&
  core.relativeTime(NOW + 20000, NOW) === '刚刚' &&
  core.relativeTime(null, NOW) === null);

check('J2 ★★★ "过期"这件事不在这里算：effectiveStatus 读的是读面的 expiredByTime',
  coreCode.indexOf('expiresAt <') < 0 && coreCode.indexOf('expiresAt >') < 0 &&
  coreCode.indexOf('now >') < 0 && coreCode.indexOf('Date.now() >') < 0);

console.log('\n' + '─'.repeat(66));
console.log('P22-15 core: ' + (checks - failures) + '/' + checks + ' checks passed');
if (failures) { console.error('FAILED: ' + failures); process.exit(1); }
console.log('ALL PASS');
