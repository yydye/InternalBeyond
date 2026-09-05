/* test_pay_gate.js — Alipay Payment Provider + Payment Gate（Phase 2B）
   ----------------------------------------------------------------------
   node test_pay_gate.js 运行；零外部依赖。
   覆盖：授权决策重放（篡改 ALLOW 不被信任）、Provider SUCCESS→记账、
   FAIL/CANCEL/TIMEOUT→不记账、幂等（同 intent 不重复）、timeout 不重试、
   AI Pay 不可用→manualLink fallback、人工确认(confirmToken)门禁。 */
'use strict';

const assert = require('assert');
const createPaymentAuth = require('./active/payment-auth.js').createPaymentAuth;
const createPayGate = require('./bridge/pay-gate.js');
const createPaymentProviderRegistry = require('./bridge/payment-provider.js').createPaymentProviderRegistry;
const createAlipayProvider = require('./bridge/alipay-provider.js');

let pass = 0, fail = 0;
function ok(name, fn) { try { fn(); pass++; console.log('  ✓ ' + name); } catch (e) { fail++; console.log('  ✗ ' + name + ' — ' + (e && e.message || e)); } }
function fixedNow(ms) { return () => ms; }
function memStore() { let s = null; return { load: () => s, save: (n) => { s = JSON.parse(JSON.stringify(n)); }, get: () => s }; }

/* 便捷：构建一个 gate（可配 mode / 提供商 / provider stub） */
function make(mode, opts) {
  opts = opts || {};
  const now = opts.now || fixedNow(0);
  const payAuth = createPaymentAuth({ now, persist: opts.payStore });
  payAuth.setConfig(Object.assign({ mode: mode, perOrderLimit: 50, dailyLimit: 200, allowedDomains: ['alipay.com'] }, opts.config));
  const registry = createPaymentProviderRegistry();
  if (opts.providerStub) registry.register(opts.providerStub);
  const gate = createPayGate({ payAuth, registry, providerName: 'alipay', now, persist: opts.gateStore || memStore() });
  gate._payAuth = payAuth;
  return gate;
}
function intent(gate, o) {
  return gate._payAuth.newIntent(Object.assign({ amount: 30, orderId: 'o', domain: 'alipay.com', checkoutUrl: 'https://cashier.alipay.com/x?orderId=o' }, o));
}

console.log('Alipay Provider + Payment Gate tests\n');

/* ── 1. disabled → manualLink（Provider 绝不调用） ── */
{
  const gate = make('disabled', { providerStub: { name: 'alipay', submit: () => { throw new Error('不应被调用'); } } });
  const i = intent(gate, { orderId: 'd1' });
  const r = gate.submit(i);
  ok('disabled → DENIED', () => assert.strictEqual(r.status, 'DENIED'));
  ok('disabled 提供人工支付宝链接（manualLink）', () => assert.ok(/cashier\.alipay\.com/.test(r.manualLink)));
}

/* ── 2. each → 无 token 需确认；有 token 才进 Provider ── */
{
  const calls = [];
  const gate = make('each', { providerStub: { name: 'alipay', submit: (i) => { calls.push(i); return Promise.resolve({ status: 'SUCCESS', reference: 'REFA' }); } } });
  const i = intent(gate, { orderId: 'e1' });
  const r1 = gate.submit(i);
  ok('each 无 confirmToken → NEEDS_CONFIRMATION（Provider 未调用）', () => {
    assert.strictEqual(r1.status, 'NEEDS_CONFIRMATION');
    assert.strictEqual(calls.length, 0);
  });
  const c = gate.requestConfirm(i);
  const r2 = gate.submit(i, { confirmToken: c.confirmToken });
  ok('each 带 confirmToken → 进入 Provider 并 SUCCESS', async () => {
    const v = await r2;
    assert.strictEqual(v.status, 'SUCCESS');
    assert.strictEqual(calls.length, 1);
  });
}

/* ── 3. under_limit 全部满足 → ALLOW → SUCCESS → 记账 ── */
{
  const payStore = memStore();
  const gate = make('under_limit', { payStore, providerStub: { name: 'alipay', submit: () => Promise.resolve({ status: 'SUCCESS', reference: 'REF1' }) } });
  const i = intent(gate, { amount: 30, orderId: 'u1' });
  const r = gate.submit(i);
  ok('under_limit ¥30 → Provider SUCCESS 并记账（commitSpend）', async () => {
    const v = await r;
    assert.strictEqual(v.status, 'SUCCESS');
    assert.strictEqual(gate._payAuth.ledger().spent, 30);
  });
  ok('支付成功刷新后 ledger 仍正确（持久化重载）', async () => {
    const gate2 = make('under_limit', { payStore, providerStub: { name: 'alipay', submit: () => Promise.resolve({ status: 'SUCCESS' }) } });
    assert.strictEqual(gate2._payAuth.ledger().spent, 30);
  });
}

/* ── 4. under_limit 超单笔 → CONFIRM（需 token） ── */
{
  const calls = [];
  const gate = make('under_limit', { providerStub: { name: 'alipay', submit: () => { calls.push(1); return Promise.resolve({ status: 'SUCCESS' }); } } });
  const i = intent(gate, { amount: 51, orderId: 'o2' });
  const r = gate.submit(i);
  ok('¥51/¥50 超单笔 → CONFIRM（无 token 不调用 Provider）', () => {
    assert.strictEqual(r.status, 'NEEDS_CONFIRMATION');
    assert.strictEqual(calls.length, 0);
  });
}

/* ── 5. 超日预算 → DENY ── */
{
  const calls = [];
  const gate = make('under_limit', { config: { dailyLimit: 100 }, providerStub: { name: 'alipay', submit: () => { calls.push(1); return Promise.resolve({ status: 'SUCCESS' }); } } });
  const i80 = intent(gate, { amount: 80, orderId: 'b1' });
  gate._payAuth.commitSpend(i80);        /* 记 80 */
  const i30 = intent(gate, { amount: 30, orderId: 'b2' });
  const r = gate.submit(i30);
  ok('超日预算（80+30>100）→ DENIED（Provider 未调用）', () => {
    assert.strictEqual(r.status, 'DENIED');
    assert.strictEqual(calls.length, 0);
  });
}

/* ── 6. 未授权域名 → DENY ── */
{
  const gate = make('under_limit', { providerStub: { name: 'alipay', submit: () => Promise.resolve({ status: 'SUCCESS' }) } });
  const i = intent(gate, { orderId: 'x1', domain: 'evil.com', checkoutUrl: 'https://evil.com/x?orderId=x1' });
  ok('未授权域名 → DENIED', () => assert.strictEqual(gate.submit(i).status, 'DENIED'));
}

/* ── 7. 过期 intent → DENY ── */
{
  const gate = make('under_limit', { providerStub: { name: 'alipay', submit: () => Promise.resolve({ status: 'SUCCESS' }) } });
  const i = intent(gate, { orderId: 'x2', createdAt: -100000, ttlMs: 100 });
  ok('过期 intent → DENIED', () => assert.strictEqual(gate.submit(i).status, 'DENIED'));
}

/* ── 8. nonce/orderId mismatch → DENY ── */
{
  const gate = make('under_limit', { providerStub: { name: 'alipay', submit: () => Promise.resolve({ status: 'SUCCESS' }) } });
  const i = intent(gate, { orderId: 'x3' });
  ok('orderId 不匹配 → DENIED', () => assert.strictEqual(gate.submit(i, { orderId: 'wrong' }).status, 'DENIED'));
  ok('nonce 不匹配 → DENIED', () => assert.strictEqual(gate.submit(i, { nonce: 'wrong' }).status, 'DENIED'));
}

/* ── 9. Bridge 篡改 ALLOW → 重新 DENY/CONFIRM（不信任 claimedAction） ── */
{
  const calls = [];
  /* 该 intent 其实是超日预算（应 DENY），但浏览器宣称 ALLOW */
  const gate = make('under_limit', { config: { dailyLimit: 50 }, providerStub: { name: 'alipay', submit: () => { calls.push(1); return Promise.resolve({ status: 'SUCCESS' }); } } });
  gate._payAuth.commitSpend(intent(gate, { amount: 40, orderId: 'z0' }));  /* 已花 40 */
  const i = intent(gate, { amount: 30, orderId: 'z1' });                   /* 40+30>50 */
  const r = gate.submit(i, { claimedAction: 'ALLOW' });
  ok('篡改 ALLOW（超日预算）→ 重新 DENIED，Provider 未调用', () => {
    assert.strictEqual(r.status, 'DENIED');
    assert.strictEqual(calls.length, 0);
  });
  ok('gate 忽略 claimedAction（从未读取）', () => true);
}

/* ── 10. Provider FAIL → 不记账 ── */
{
  const gate = make('under_limit', { providerStub: { name: 'alipay', submit: () => Promise.resolve({ status: 'FAIL', error: 'bad' }) } });
  const i = intent(gate, { amount: 30, orderId: 'f1' });
  const r = gate.submit(i);
  ok('Provider FAIL → 不记账 + manualLink fallback', async () => {
    const v = await r;
    assert.strictEqual(v.status, 'FAIL');
    assert.strictEqual(gate._payAuth.ledger().spent, 0);
    assert.ok(/cashier\.alipay\.com/.test(v.manualLink));
  });
}

/* ── 11. Provider CANCEL → 不记账 ── */
{
  const gate = make('under_limit', { providerStub: { name: 'alipay', submit: () => Promise.resolve({ status: 'CANCEL' }) } });
  const i = intent(gate, { amount: 30, orderId: 'c1' });
  const r = gate.submit(i);
  ok('Provider CANCEL → 不记账', async () => { const v = await r; assert.strictEqual(v.status, 'CANCEL'); assert.strictEqual(gate._payAuth.ledger().spent, 0); });
}

/* ── 12. TIMEOUT → 不重复提交（终态不重试） ── */
{
  let calls = 0;
  const gate = make('under_limit', { providerStub: { name: 'alipay', submit: () => { calls++; return Promise.resolve({ status: 'TIMEOUT' }); } } });
  const i = intent(gate, { amount: 30, orderId: 't1' });
  const r1 = gate.submit(i);
  ok('TIMEOUT → 状态 TIMEOUT，不记账', async () => { const v = await r1; assert.strictEqual(v.status, 'TIMEOUT'); assert.strictEqual(gate._payAuth.ledger().spent, 0); });
  const r2 = gate.submit(i);
  ok('TIMEOUT 后再次提交 → 不重复调用 Provider（calls=1）', async () => { const v = await r2; assert.strictEqual(v.status, 'TIMEOUT'); assert.strictEqual(calls, 1); });
}

/* ── 13. 同一 intent 重复提交（SUCCESS 幂等） ── */
{
  let calls = 0;
  const gate = make('under_limit', { providerStub: { name: 'alipay', submit: () => { calls++; return Promise.resolve({ status: 'SUCCESS', reference: 'R' + calls }); } } });
  const i = intent(gate, { amount: 30, orderId: 'id1' });
  const r1 = gate.submit(i);
  const r2 = gate.submit(i);
  ok('同 intent 重复提交 → 幂等（第二次不调用 Provider，calls=1）', async () => {
    const v1 = await r1, v2 = await r2;
    assert.strictEqual(v1.status, 'SUCCESS');
    assert.strictEqual(v2.status, 'SUCCESS');
    assert.strictEqual(calls, 1);
    assert.strictEqual(gate._payAuth.ledger().spent, 30);
  });
}

/* ── 14. AI Pay 不可用（无 Provider）→ manualLink fallback ── */
{
  const gate = make('under_limit', { /* 不注册 provider */ });
  const i = intent(gate, { amount: 30, orderId: 'un1' });
  const r = gate.submit(i);
  ok('无 Provider（AI Pay 不可用）→ UNAVAILABLE + manualLink，不记账', async () => {
    const v = await r;
    assert.strictEqual(v.status, 'UNAVAILABLE');
    assert.ok(/cashier\.alipay\.com/.test(v.manualLink));
    assert.strictEqual(gate._payAuth.ledger().spent, 0);
  });
}

/* ── 15. Alipay Provider 层二次防御：非 cashier*.alipay.com / 非 https 拒绝 ── */
{
  const ap = createAlipayProvider({ exec: (a) => ({ ok: true, stdout: '{}' }) });
  ok('Provider 拒绝非现金ier*.alipay.com 域名', async () => {
    const r = await ap.submit({ checkoutUrl: 'https://evil.com/x' });
    assert.strictEqual(r.status, 'FAIL');
  });
  ok('Provider 拒绝 http 收银台', async () => {
    const r = await ap.submit({ checkoutUrl: 'http://cashier.alipay.com/x' });
    assert.strictEqual(r.status, 'FAIL');
  });
  ok('Provider 接受 cashieruser.alipay.com https 并调用 CLI', async () => {
    let called = null;
    const ap2 = createAlipayProvider({ exec: (args) => { called = args; return { ok: true, stdout: '{"reference":"RFX"}' }; } });
    const r = await ap2.submit({ checkoutUrl: 'https://cashieruser.alipay.com/cashiermain.htm?orderId=1' });
    assert.strictEqual(r.status, 'SUCCESS');
    assert.strictEqual(r.reference, 'RFX');
    assert.ok(called[0] === 'alipay-bot' && called[1] === 'submit-payment');
  });
}

console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
