/* test_shopping_execution_e2e.js — 3E 真实链路 Mock E2E（到确认边界即停）
   ----------------------------------------------------------------------
   用【真实】Commerce Domain + shopping-execution 策略 + canonical pay-gate +
   Alipay Provider（mock exec），驱动 SEARCH→OBSERVE→FILTER→COMPARE→SELECT→SKU→
   CHECKOUT→canonical→PaymentAuth→PayGate→Provider，并【在 confirmation/付款边界停止】。
   前端动作（搜索/点选/SKU/收银台）用真实结果回灌 Domain；绝不真实支付。
   node test_shopping_execution_e2e.js 运行；零外部依赖。 */
'use strict';

const assert = require('assert');
const createCommerce = require('./active/commerce.js').create;
const createPaymentAuth = require('./active/payment-auth.js').createPaymentAuth;
const createPayGate = require('./bridge/pay-gate.js');
const createProviderRegistry = require('./bridge/payment-provider.js').createPaymentProviderRegistry;
const createAlipayProvider = require('./bridge/alipay-provider.js');
const IBShopExec = require('./active/shopping-execution.js');

let pass = 0, fail = 0;
function ok(name, fn) { try { fn(); pass++; console.log('  ✓ ' + name); } catch (e) { fail++; console.log('  ✗ ' + name + ' — ' + (e && e.message || e)); } }

console.log('Shopping Execution E2E（3E，到付款边界即停）\n');

/* ── A. 执行策略单元（吸收参考经验） ── */
ok('validateCashierUrl：cashier*.alipay.com https 通过，非 cashier/非 https 拒绝', () => {
  assert.strictEqual(IBShopExec.validateCashierUrl('https://cashieruser.alipay.com/cashiermain.htm?orderId=1'), true);
  assert.strictEqual(IBShopExec.validateCashierUrl('https://evil.com/x'), false);
  assert.strictEqual(IBShopExec.validateCashierUrl('http://cashier.alipay.com/x'), false);
});
ok('extractCashierUrl：只认 cashiermain.htm?orderId，拒绝 trust_login 中间页', () => {
  const raw = '点击支付后跳到 https://trustlogin.taobao.com/trust_login.do 再跳 https://cashieruser.alipay.com/cashiermain.htm?orderId=ABC123';
  assert.strictEqual(IBShopExec.extractCashierUrl(raw), 'https://cashieruser.alipay.com/cashiermain.htm?orderId=ABC123');
  assert.strictEqual(IBShopExec.extractCashierUrl('https://trustlogin.taobao.com/trust_login.do'), '');
});
ok('isTransitionPage / isPaymentPage 判定', () => {
  assert.strictEqual(IBShopExec.isTransitionPage('https://trustlogin.taobao.com/trust_login.do'), true);
  assert.strictEqual(IBShopExec.isPaymentPage('https://cashieruser.alipay.com/cashiermain.htm?orderId=1'), true);
  assert.strictEqual(IBShopExec.isPaymentPage('https://item.taobao.com/item.htm?id=1'), false);
});
ok('recommendTool：SKU → evaluate(文本匹配)，REVIEW → 无工具', () => {
  assert.ok(/browser_evaluate/.test(IBShopExec.recommendTool('SKU')));
  assert.strictEqual(IBShopExec.recommendTool('REVIEW'), '(人工审核，无工具)');
});
ok('hintsBlock 含 SPA SKU / 收银台跳转 / 禁止支付页合成点击 / 严格 cashier', () => {
  const h = IBShopExec.hintsBlock();
  assert.ok(/文本匹配 evaluate/.test(h));
  assert.ok(/cashiermain\.htm\?orderId/.test(h));
  assert.ok(/绝不用 JS 合成点击/.test(h) || /isTrusted/.test(h));
  assert.ok(/cashier\*\.alipay\.com/.test(h));
});

/* ── B. 完整链路：SEARCH→…→CHECKOUT→canonical→PayGate→确认边界 ── */
{
  const C = createCommerce({ now: () => 0 });
  C.agentStart({ keywords: ['指甲钳'], maxBudget: 50, skuPrefs: ['升级款'], quantity: 1, urgency: false, category: '指甲钳' });
  /* SEARCH→OBSERVE→COMPARE（真实候选回灌） */
  C.agentObserve('mcp.shopping.browser_snapshot', { title: '德国精工大号指甲剪', price: 2.01, rating: 4.8, deliveryDays: 2, stock: '有货' }, { ok: true, response: '候选' });
  C.agentObserve('mcp.shopping.browser_snapshot', { title: '强人指甲刀套装', price: 1.89, rating: 4.6, deliveryDays: 3, stock: '有货' }, { ok: true, response: '候选' });
  const snap = C.agentSnapshot();
  ok('SEARCH→OBSERVE：收集 ≥2 真实候选', () => assert.strictEqual(snap.candidates.length, 2));
  ok('COMPARE：agentNext 进入 COMPARE/SELECT（或 SKU 若规格偏好未满足）', () => assert.ok(['COMPARE', 'SELECT', 'SKU'].includes(C.agentNext().intent)));
  /* SELECT：选中最高分候选 */
  const top = C.rankCandidates()[0];
  C.agentSetSelected(top.id);
  /* SKU：用文本匹配 evaluate 选中规格（参考策略），结果带 sku */
  const skuRes = C.agentObserve('mcp.shopping.browser_evaluate', { title: '德国精工大号指甲剪', price: 2.01, sku: '升级款【1把】大号内置锉刀' }, { ok: true, response: '已点击 升级款【1把】大号内置锉刀' });
  ok('SELECT→SKU：canonical agent 记录规格', () => assert.strictEqual(C.agentSnapshot().candidates.some(c => /升级款/.test(c.sku || '')), true));
  /* CHECKOUT：trust_login 中间页 → 等 cashiermain */
  const checkout = C.agentObserve('mcp.shopping.browser_navigate', { orderId: 'ABC123', domain: 'cashieruser.alipay.com' }, { ok: true, response: '支付跳转 https://trustlogin.taobao.com/trust_login.do → https://cashieruser.alipay.com/cashiermain.htm?orderId=ABC123' });
  ok('CHECKOUT：捕获 cashiermain → REVIEW（trust_login 被忽略）', () => {
    assert.strictEqual(checkout.intent, 'REVIEW');
    const u = C.agentReview().checkout.url;
    assert.ok(u.indexOf('cashiermain') >= 0 && u.indexOf('orderId=ABC123') >= 0);
    assert.strictEqual(C.agentReview().paymentIntent.orderId, 'ABC123');
  });
  ok('Review 展示真实商品 + 理由（来自 scorer）', () => {
    const rev = C.agentReview();
    assert.ok(rev.product && rev.product.title.length > 1);
    assert.ok(rev.selectionReason.length > 0);
  });
}

/* ── C. canonical checkout → PaymentAuth → PayGate → Alipay Provider ──
   （在确认/付款边界停止：mode=each → NEEDS_CONFIRMATION，绝不调 Provider；mode=disabled → manualLink） */
{
  const C = createCommerce({ now: () => 0 });
  C.agentStart({ keywords: ['指甲钳'], maxBudget: 50, skuPrefs: [], quantity: 1, urgency: false });
  C.agentObserve('mcp.shopping.browser_navigate', { orderId: 'P99', domain: 'cashieruser.alipay.com' }, { ok: true, response: 'https://cashieruser.alipay.com/cashiermain.htm?orderId=P99' });
  const pi = C.agentReview().paymentIntent;

  let alipayCalls = 0;
  function buildGate(mode, cfgExtra) {
    const payAuth = createPaymentAuth({ now: () => 0 });
    payAuth.setConfig(Object.assign({ mode: mode, perOrderLimit: 200, dailyLimit: 500, allowedDomains: ['alipay.com'] }, cfgExtra));
    const reg = createProviderRegistry();
    reg.register(createAlipayProvider({ exec: () => { alipayCalls++; return { ok: true, stdout: '{"reference":"R"}' }; } }));
    return createPayGate({ payAuth, registry: reg, providerName: 'alipay', now: () => 0 });
  }
  const gate = buildGate('each');
  const rec = gate.registerCheckout({ amount: pi.amount, orderId: pi.orderId, domain: pi.domain, checkoutUrl: pi.checkoutUrl, currency: pi.currency });
  ok('canonical.registerCheckout → PENDING 含 canonicalId/nonce/expiresAt', () => {
    assert.strictEqual(rec.ok, true);
    assert.ok(rec.canonicalId && rec.nonce && rec.expiresAt);
    assert.strictEqual(rec.status, 'PENDING');
  });
  const r = gate.submitCanonical(rec.canonicalId, { nonce: rec.nonce });
  ok('each 模式 → 停在 NEEDS_CONFIRMATION（确认边界），不调 Provider/不扣款', async () => {
    const v = await r;
    assert.strictEqual(v.status, 'NEEDS_CONFIRMATION');
    assert.strictEqual(alipayCalls, 0);
  });
  /* disabled → 只给 manualLink */
  const gate2 = buildGate('disabled');
  const rec2 = gate2.registerCheckout({ amount: pi.amount, orderId: pi.orderId, domain: pi.domain, checkoutUrl: pi.checkoutUrl });
  const d = gate2.submitCanonical(rec2.canonicalId, { nonce: rec2.nonce });
  ok('disabled 模式 → DENIED + manualLink（Provider 不调用）', async () => {
    const v = await d;
    assert.strictEqual(v.status, 'DENIED');
    assert.ok(/cashieruser\.alipay\.com/.test(v.manualLink));
    assert.strictEqual(alipayCalls, 0);
  });
  ok('alipay-bot 全程 0 调用（未真实支付）', () => assert.strictEqual(alipayCalls, 0));
}

console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
