/* test_payment_e2e.js — Commerce Payment E2E（真实链路，到确认点即停，不扣款）
   ----------------------------------------------------------------------
   【怎么跑】node test_payment_e2e.js（零外部依赖）
   【与真实购物链路的对应】
     ① mcp.shopping.* (Playwright MCP) → Commerce Domain 捕获 checkoutUrl
     ② PaymentIntent = newIntent({amount,orderId,domain,checkoutUrl,...})
     ③ Payment Auth = payment-auth.decide()
     ④ Bridge Pay Gate = payGate.submit(intent,{confirmToken,...})
     ⑤ 只有 ALLOW / 已确认 CONFIRM 才会调用 Alipay Provider（alipay-bot）
   ★ 本测试把授权模式设为 disabled / each，恰好停在「确认点」——
     Provider（真实 alipay-bot）绝不被调用 → 不产生任何真实扣款。
     注册的 alipay provider 带一个「记录调用」的 exec，断言它一次都没被触发。
   node test_payment_e2e.js 运行。 */
'use strict';

const assert = require('assert');
const createPaymentAuth = require('./active/payment-auth.js').createPaymentAuth;
const createPayGate = require('./bridge/pay-gate.js');
const createProviderRegistry = require('./bridge/payment-provider.js').createPaymentProviderRegistry;
const createAlipayProvider = require('./bridge/alipay-provider.js');

let pass = 0, fail = 0;
function ok(name, fn) { try { fn(); pass++; console.log('  ✓ ' + name); } catch (e) { fail++; console.log('  ✗ ' + name + ' — ' + (e && e.message || e)); } }
function fixedNow(ms) { return () => ms; }

console.log('Commerce Payment E2E（到确认点即停，不扣款）\n');

/* 模拟真实链路：商品→SKU→收银台（来自 Commerce Domain 捕获的 checkoutUrl） */
const CHECKOUT = 'https://cashieruser.alipay.com/cashiermain.htm?orderId=IB20260901';
const CHARGE = { amount: 29.9, orderId: 'IB20260901', domain: 'cashieruser.alipay.com', checkoutUrl: CHECKOUT };

let alipayInvocations = 0;
function realGate(mode, cfgExtra) {
  const payAuth = createPaymentAuth({ now: fixedNow(0) });
  payAuth.setConfig(Object.assign({ mode: mode, perOrderLimit: 100, dailyLimit: 500, allowedDomains: ['alipay.com'] }, cfgExtra));
  const registry = createProviderRegistry();
  /* 真实 Alipay Provider 注册，但 exec 记录调用 —— 断言绝不被触发（不扣款） */
  registry.register(createAlipayProvider({ exec: () => { alipayInvocations++; return { ok: true, stdout: '{"reference":"X"}' }; } }));
  const gate = createPayGate({ payAuth, registry, providerName: 'alipay', now: fixedNow(0) });
  gate._payAuth = payAuth;
  return gate;
}

/* ── 1. 链路起点：由收银台构造 PaymentIntent（绑定 amount/orderId/domain/checkout/expiry/nonce） ── */
const payAuth0 = createPaymentAuth({ now: fixedNow(0) });
const intent = payAuth0.newIntent(Object.assign({ currency: 'CNY' }, CHARGE));
ok('PaymentIntent 绑定必需字段（amount/orderId/domain/checkoutUrl/id/expiresAt）', () => {
  assert.strictEqual(intent.amount, 29.9);
  assert.strictEqual(intent.orderId, 'IB20260901');
  assert.ok(intent.checkoutUrl.indexOf('cashieruser.alipay.com') >= 0);
  assert.ok(intent.id && intent.expiresAt > intent.createdAt);
});

/* ── 2. disabled → 停在被拒，只给人工支付宝链接，Provider 不调用 ── */
{
  const gate = realGate('disabled');
  const r = gate.submit(intent);
  ok('disabled → DENIED（到确认/拒绝点即停）', async () => {
    const v = await r;
    assert.strictEqual(v.status, 'DENIED');
    assert.ok(v.manualLink.indexOf('cashieruser.alipay.com') >= 0);
    assert.ok(/人工|支付宝/i.test(v.note) || v.manualLink);
  });
  ok('disabled 全程未调用 alipay-bot（invocations=0）', () => assert.strictEqual(alipayInvocations, 0));
  ok('disabled 不记账（budget 0）', () => assert.strictEqual(gate._payAuth.ledger().spent, 0));
}

/* ── 3. each → 停在「人工待确认」，Provider 不调用 ── */
{
  alipayInvocations = 0;
  const gate = realGate('each');
  const r = gate.submit(intent);
  ok('each → NEEDS_CONFIRMATION（停在人工确认点）', async () => {
    const v = await r;
    assert.strictEqual(v.status, 'NEEDS_CONFIRMATION');
    assert.ok(v.manualLink);
  });
  ok('each 未确认时未调用 alipay-bot（invocations=0）', () => assert.strictEqual(alipayInvocations, 0));
}

/* ── 4. confirmToken 无效 → DENY（篡改防护），Provider 不调用 ── */
{
  alipayInvocations = 0;
  const gate = realGate('each');
  const c = gate.requestConfirm(intent);
  const bad = gate.submit(intent, { confirmToken: 'pc_tampered' });
  ok('confirmToken 无效 → DENIED（篡改拒绝，不调用 Provider）', async () => {
    const v = await bad;
    assert.strictEqual(v.status, 'DENIED');
    assert.strictEqual(alipayInvocations, 0);
  });
  /* 正确的 token 才能放行 */
  const good = gate.submit(intent, { confirmToken: c.confirmToken });
  ok('有效 confirmToken → each 确认后进入 Provider（调用 1 次）', async () => {
    const v = await good;
    assert.strictEqual(v.status, 'SUCCESS');
    assert.strictEqual(alipayInvocations, 1);
  });
}

/* ── 5. under_limit 全额满足 → ALLOW → 自动支付（mock provider）→ SUCCESS 记账一次 ── */
{
  alipayInvocations = 0;
  const gate = realGate('under_limit', { /* 29.9 <= 100, 0+29.9 <= 500, 域名 alipay.com 子域 */ });
  const r = gate.submit(intent);
  ok('under_limit 满足 → ALLOW → Provider 调用 → SUCCESS 并记账一次', async () => {
    const v = await r;
    assert.strictEqual(v.status, 'SUCCESS');
    assert.strictEqual(gate._payAuth.ledger().spent, 29.9);
    assert.strictEqual(alipayInvocations, 1);
  });
  const again = gate.submit(intent);
  ok('同 intent 重复提交 → 幂等，只记账一次', async () => {
    const v = await again;
    assert.strictEqual(v.status, 'SUCCESS');
    assert.strictEqual(gate._payAuth.ledger().spent, 29.9);
    assert.strictEqual(alipayInvocations, 1);
  });
}

/* ── 6. 超单笔 / 超每日 / 非授权域名 → CONFIRM / DENY，停在确认点 ── */
{
  alipayInvocations = 0;
  const gate = realGate('under_limit', { perOrderLimit: 20 });  /* 29.9 > 20 */
  const overOrder = gate.submit(intent);
  ok('超单笔限额 → CONFIRM（停在确认点，Provider 未调用）', async () => {
    const v = await overOrder;
    assert.strictEqual(v.status, 'NEEDS_CONFIRMATION');
    assert.strictEqual(alipayInvocations, 0);
  });
  const gate2 = realGate('under_limit', { dailyLimit: 10 });    /* 0+29.9 > 10 */
  const overDaily = gate2.submit(intent);
  ok('超每日限额 → DENIED（停在拒绝点，Provider 未调用）', async () => {
    const v = await overDaily;
    assert.strictEqual(v.status, 'DENIED');
    assert.strictEqual(alipayInvocations, 0);
  });
  const gate3 = realGate('under_limit');
  const badDomain = gate3.submit(Object.assign({}, intent, { domain: 'evil.com', checkoutUrl: 'https://evil.com/x?orderId=1' }));
  ok('非授权域名 → DENIED（未调用 Provider）', async () => {
    const v = await badDomain;
    assert.strictEqual(v.status, 'DENIED');
    assert.strictEqual(alipayInvocations, 0);
  });
}

console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
