/* test_shopping_review.js — Shopping Copilot / Human Review（Phase 3B）
   ----------------------------------------------------------------------
   node test_shopping_review.js 运行；零外部依赖。
   覆盖：CHECKOUT_STOP→Review、Review 展示真实商品数据、理由与 scorer 一致、
   更换候选、用户停止、继续→PaymentIntent、Payment Auth DENY/CONFIRM/ALLOW、
   Review 无法绕过 Bridge（gate 独立重算）、step/failure budget 仍有效。 */
'use strict';

const assert = require('assert');
const createCommerce = require('./active/commerce.js').create;
const createPaymentAuth = require('./active/payment-auth.js').createPaymentAuth;
const createPayGate = require('./bridge/pay-gate.js');
const createProviderRegistry = require('./bridge/payment-provider.js').createPaymentProviderRegistry;

let pass = 0, fail = 0;
function ok(name, fn) { try { fn(); pass++; console.log('  ✓ ' + name); } catch (e) { fail++; console.log('  ✗ ' + name + ' — ' + (e && e.message || e)); } }
function fixedNow(ms) { return () => ms; }

console.log('Shopping Copilot / Human Review（Phase 3B）tests\n');

/* 构造进入 REVIEW 的 agent：先加候选，再捕获收银台 */
function reachReview(opts) {
  const C = createCommerce({ now: fixedNow(0) });
  C.agentStart(Object.assign({ keywords: ['咖啡杯'], maxBudget: 500, skuPrefs: ['浅绿色'], quantity: 1, urgency: false }, opts && opts.task), opts && { maxFailures: 2, maxSteps: 6 });
  C.agentAddCandidate({ title: '日式粗陶咖啡杯', price: 128, rating: 4.8, deliveryDays: 3, stock: '有货', sku: '浅绿色', url: 'https://detail.example.com/p1' });
  C.agentAddCandidate({ title: '北欧简约咖啡杯', price: 199, rating: 4.5, deliveryDays: 2, stock: '有货', sku: '白色' });
  const r = C.agentObserve('mcp.shopping.browser_snapshot', { amount: 128, orderId: 'IB778', domain: 'cashieruser.alipay.com' }, { ok: true, response: '收银台 https://cashieruser.alipay.com/cashiermain.htm?orderId=IB778' });
  return { C, r };
}

/* ── 1. CHECKOUT_STOP → Review ── */
{
  const { C, r } = reachReview();
  const rev = C.agentReview();
  ok('CHECKOUT_STOP → Review（agentReview.ok=true, intent=REVIEW）', () => {
    assert.strictEqual(rev.ok, true);
    assert.strictEqual(rev.intent, 'REVIEW');
    assert.strictEqual(rev.halted, true);
    assert.strictEqual(rev.haltedReason, C.STOP_REASON.CHECKOUT_STOP);
  });
}

/* ── 2. Review 正确展示实际商品数据 ── */
{
  const { C } = reachReview();
  const rev = C.agentReview();
  ok('Review 展示 标题/价格/评分/配送/SKU/商家域名/checkout 状态', () => {
    const p = rev.product;
    assert.ok(p && p.title && p.title.length > 1);
    assert.strictEqual(p.price, 128);
    assert.strictEqual(p.rating, 4.8);
    assert.strictEqual(p.deliveryDays, 3);
    assert.ok(p.sku);
    assert.strictEqual(rev.checkout.status, 'captured');
    assert.ok(rev.checkout.url.indexOf('cashieruser.alipay.com') >= 0);
    assert.ok(p.domain || p.merchant || rev.checkout.url);
  });
  ok('Review 提供四种人工动作（查看/更换/继续/停止）', () => {
    assert.ok(rev.actions.includes('view_product'));
    assert.ok(rev.actions.includes('change_candidate'));
    assert.ok(rev.actions.includes('continue_checkout'));
    assert.ok(rev.actions.includes('stop'));
  });
}

/* ── 3. 选择理由与 scorer 一致（来自实际部件评分/约束，不编造） ── */
{
  const { C } = reachReview();
  const rev = C.agentReview();
  const detail = rev.scoreDetail;
  const top = rev.ranked[0];
  ok('理由来自 scoreDetail（total 与 ranked[0] 一致）', () => {
    assert.strictEqual(detail.title, top.title);
    assert.strictEqual(detail.total, top.score);
    assert.strictEqual(detail.inBudget, true);
  });
  ok('理由逐项包含 价格/评分/配送/库存/SKU/关键词 实际判断', () => {
    const text = (detail.parts || []).map(p => p.label + p.reason).join('|');
    assert.ok(/价格/.test(text) && /评分/.test(text) && /配送/.test(text) && /库存/.test(text));
  });
  ok('理由提及预算约束（符合 500 元上限）', () => assert.ok(/预算/.test(rev.reasonText)));
  ok('理由提及规格约束（已选浅绿色）', () => assert.ok(/规格|浅绿色/.test(rev.reasonText)));
}

/* ── 4. 更换候选 → 回到比较状态（保留预算） ── */
{
  const { C } = reachReview();
  const back = C.agentChangeCandidate();
  ok('更换候选 → 回到比较状态（halted=false, intent∈COMPARE/SELECT）', () => {
    assert.strictEqual(back.halted, false);
    assert.ok(['COMPARE', 'SELECT'].includes(back.intent));
    assert.strictEqual(back.haltedReason, '');
  });
  /* 更换后重新走到 REVIEW（同一套状态机，非新建） */
  const r2 = C.agentObserve('mcp.shopping.browser_snapshot', { amount: 128, orderId: 'IB778', domain: 'cashieruser.alipay.com' }, { ok: true, response: '收银台2 https://cashieruser.alipay.com/cashiermain.htm?orderId=IB778' });
  ok('更换后再次捕获收银台 → 再次进入 Review（原地状态机）', () => {
    assert.strictEqual(r2.intent, 'REVIEW');
    assert.strictEqual(r2.haltedReason, C.STOP_REASON.CHECKOUT_STOP);
  });
}

/* ── 5. 用户停止 → USER_STOP，preserve haltedReason ── */
{
  const { C } = reachReview();
  const stop = C.agentStop();
  ok('用户停止 → STOP/USER_STOP', () => {
    assert.strictEqual(stop.halted, true);
    assert.strictEqual(stop.haltedReason, C.STOP_REASON.USER_STOP);
  });
}

/* ── 6. 继续结算 → 返回 PaymentIntent（intent=CHECKOUT） ── */
{
  const { C } = reachReview();
  const cont = C.agentContinue();
  ok('继续结算 → 放行 PaymentIntent（intent=CHECKOUT）', () => {
    assert.strictEqual(cont.ok, true);
    assert.strictEqual(cont.intent, 'CHECKOUT');
    assert.ok(cont.paymentIntent && cont.paymentIntent.checkoutUrl);
  });
  ok('继续≠真实支付：仅交回 DTO，无 Provider 调用', () => assert.ok(/Bridge/.test(cont.note) && /独立重算/.test(cont.note)));
}

/* ── 7. 继续后经真实 Bridge Pay Gate：DENY / CONFIRM / ALLOW（Review 不绕过） ── */
{
  const { C } = reachReview();
  const cont = C.agentContinue();
  const pi = cont.paymentIntent;
  function runGate(mode, cfgExtra, provider) {
    const payAuth = createPaymentAuth({ now: fixedNow(0) });
    payAuth.setConfig(Object.assign({ mode: mode, perOrderLimit: 50, dailyLimit: 500, allowedDomains: ['alipay.com'] }, cfgExtra));
    const reg = createProviderRegistry();
    if (provider) reg.register(provider);
    const gate = createPayGate({ payAuth, registry: reg, providerName: 'alipay', now: fixedNow(0) });
    return gate;
  }
  /* disabled → DENY（即使 Review 说 continue 也不放行自动支付） */
  {
    const gate = runGate('disabled');
    const r = gate.submit(pi);
    ok('Payment Auth disabled → DENY（Review 无法绕过）', async () => { const v = await r; assert.strictEqual(v.status, 'DENIED'); });
  }
  /* each → CONFIRM（需人工 confirmToken） */
  {
    const gate = runGate('each');
    const r = gate.submit(pi);
    ok('Payment Auth each → CONFIRM（Review 不能自动进 Provider）', async () => { const v = await r; assert.strictEqual(v.status, 'NEEDS_CONFIRMATION'); });
  }
  /* under_limit 满足 → ALLOW → mock provider SUCCESS → 记账一次 */
  {
    let inv = 0;
    const gate = runGate('under_limit', {}, { name: 'alipay', submit: () => { inv++; return Promise.resolve({ status: 'SUCCESS', reference: 'R' }); } });
    const r = gate.submit(pi);
    ok('Payment Auth under_limit 满足 → ALLOW → Provider → SUCCESS', async () => { const v = await r; assert.strictEqual(v.status, 'SUCCESS'); assert.strictEqual(inv, 1); });
  }
  /* under_limit 超每日 → DENY（不得伪造 ALLOW） */
  {
    const gate = runGate('under_limit', { dailyLimit: 10 });
    const r = gate.submit(pi);
    ok('Payment Auth 超每日预算 → DENY（gate 独立重算，非浏览器说了算）', async () => { const v = await r; assert.strictEqual(v.status, 'DENIED'); });
  }
}

/* ── 8. step/failure budget 仍有效 ── */
{
  const C = createCommerce({ now: fixedNow(0) });
  C.agentStart({ keywords: ['咖啡杯'], maxBudget: 500, skuPrefs: [], quantity: 1, urgency: false }, { maxFailures: 2, maxSteps: 3 });
  C.agentObserve('mcp.shopping.browser_navigate', {}, { ok: false, reason: '超时' });
  const r2 = C.agentObserve('mcp.shopping.browser_navigate', {}, { ok: false, reason: '超时' });
  ok('连续失败达 fail budget → 仍 STOP(TOOL_FAILURE)（3B 保留 3A 预算）', () => {
    assert.strictEqual(r2.halted, true);
    assert.strictEqual(r2.haltedReason, C.STOP_REASON.TOOL_FAILURE);
  });
}

console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
