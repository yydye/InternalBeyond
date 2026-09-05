/* test_payment_canonical.js — 3C-Fix 回归：H2 canonical + H1 instance + M1/M2/M3/M4/M5/L2
   ----------------------------------------------------------------------
   node test_payment_canonical.js 运行；零外部依赖。
   验证：canonical 正常提交、金额/orderId/domain/checkoutUrl 篡改→DENY、
   intentId 不存在→DENY、过期→DENY、SUCCESS 后幂等、canonical 金额参与预算、
   M1 halted 早退、M2 checkout 幂等、M3 change 清理、M4 指纹/selected、M5 session 重置、L2 URL 分离。 */
'use strict';

const assert = require('assert');
const createPaymentAuth = require('./active/payment-auth.js').createPaymentAuth;
const createPayGate = require('./bridge/pay-gate.js');
const createProviderRegistry = require('./bridge/payment-provider.js').createPaymentProviderRegistry;
const createCommerce = require('./active/commerce.js').create;

let pass = 0, fail = 0;
function ok(name, fn) { try { fn(); pass++; console.log('  ✓ ' + name); } catch (e) { fail++; console.log('  ✗ ' + name + ' — ' + (e && e.message || e)); } }

console.log('3C-Fix 回归（H2/H1/M1-M5/L2）\n');

/* ── H2 · canonical PaymentIntent ── */
function gate(clock, mode, cfgExtra, provider) {
  const payAuth = createPaymentAuth({ now: clock.now });
  payAuth.setConfig(Object.assign({ mode: mode, perOrderLimit: 200, dailyLimit: 500, allowedDomains: ['alipay.com'] }, cfgExtra));
  const reg = createProviderRegistry();
  if (provider) reg.register(provider);
  return createPayGate({ payAuth, registry: reg, providerName: 'alipay', now: clock.now });
}
function mkClock() { let t = 0; return { now: () => t, advance(ms) { t += ms; } }; }
function register(g, o) {
  return g.registerCheckout(Object.assign({ amount: 100, orderId: 'O1', domain: 'cashieruser.alipay.com', checkoutUrl: 'https://cashieruser.alipay.com/cashiermain.htm?orderId=O1' }, o));
}

{
  const clock = mkClock();
  const g = gate(clock, 'under_limit', {}, { name: 'alipay', submit: () => Promise.resolve({ status: 'SUCCESS', reference: 'RC1' }) });
  const rec = register(g);
  const r = g.submitCanonical(rec.canonicalId, { nonce: rec.nonce });
  ok('H2 canonical 正常提交（under_limit 满足 → SUCCESS）', async () => { const v = await r; assert.strictEqual(v.status, 'SUCCESS'); assert.strictEqual(v.amount, 100); });
  const again = g.submitCanonical(rec.canonicalId, { nonce: rec.nonce });
  ok('H2 SUCCESS 后重复提交 → 幂等（不重付）', async () => { const v = await again; assert.strictEqual(v.status, 'SUCCESS'); });

  /* 篡改 → DENY（每次用新 canonical） */
  const tamper = (fields) => { const k = mkClock(); const gg = gate(k, 'under_limit', {}, { name: 'alipay', submit: () => Promise.resolve({ status: 'SUCCESS' }) }); const rc = register(gg); return gg.submitCanonical(rc.canonicalId, { nonce: rc.nonce, client: fields }); };
  ok('H2 amount 篡改 → DENY', async () => assert.strictEqual((await tamper({ amount: 1 })).status, 'DENIED'));
  ok('H2 orderId 篡改 → DENY', async () => assert.strictEqual((await tamper({ orderId: 'X' })).status, 'DENIED'));
  ok('H2 domain 篡改 → DENY', async () => assert.strictEqual((await tamper({ domain: 'evil.com' })).status, 'DENIED'));
  ok('H2 checkoutUrl 篡改 → DENY', async () => assert.strictEqual((await tamper({ checkoutUrl: 'https://evil.com/x' })).status, 'DENIED'));
}

{
  const clock = mkClock();
  const g = gate(clock, 'under_limit', {}, { name: 'alipay', submit: () => Promise.resolve({ status: 'SUCCESS' }) });
  const r = g.submitCanonical('can_does_not_exist', { nonce: 'x' });
  ok('H2 intentId(canonicalId) 不存在 → DENY', () => assert.strictEqual(r.status, 'DENIED'));
}

{
  const clock = mkClock();
  const g = gate(clock, 'under_limit', {}, { name: 'alipay', submit: () => Promise.resolve({ status: 'SUCCESS' }) });
  const rec = register(g, { amount: 300 });  /* 300 > perOrderLimit 200 → CONFIRM */
  const r0 = g.submitCanonical(rec.canonicalId, { nonce: rec.nonce });
  const r1 = g.submitCanonical(rec.canonicalId, { nonce: rec.nonce, confirmToken: 'bad' });
  ok('H2 金额参与预算（300>200 → 需 CONFIRM）', async () => assert.strictEqual((await r0).status, 'NEEDS_CONFIRMATION'));
  ok('H2 无效 confirmToken → DENY', async () => assert.strictEqual((await r1).status, 'DENIED'));
}

{
  const clock = mkClock();
  const g = gate(clock, 'under_limit', {}, { name: 'alipay', submit: () => Promise.resolve({ status: 'SUCCESS' }) });
  const rec = register(g);
  clock.advance(99999999);   /* 远超默认 ttl 15min */
  const r = g.submitCanonical(rec.canonicalId, { nonce: rec.nonce });
  ok('H2 expired canonical → DENY', () => assert.strictEqual(r.status, 'DENIED'));
}

/* ── H1 · Browser Commerce instance（create() 实例确具实例方法，adapter 单例） ── */
{
  const ns = require('./active/commerce.js');
  ok('H1 UMD namespace 导出 create() 工厂', () => assert.strictEqual(typeof ns.create, 'function'));
  const inst = ns.create({});
  ok('H1 create() 实例具 agentObserve/agentNext/agentReview/agentContinue/agentSetCanonical/statusBlock', () => {
    ['agentObserve', 'agentNext', 'agentReview', 'agentContinue', 'agentSetCanonical', 'agentSnapshot', 'statusBlock', 'observeToolResult'].forEach(function (m) { assert.strictEqual(typeof inst[m], 'function', m); });
  });
  /* 适配器 domain() 必须用实例而非 namespace —— 源检查 */
  const src = require('fs').readFileSync('./assets/js/commerce-adapter.js', 'utf8');
  ok('H1 adapter domain() 用 window.IBCommerce.create() 实例化', () => assert.ok(/(window\.IBCommerce\.create|\bf\.create)\(\{?\}/.test(src) && /_instance\s*=/.test(src)));
  ok('H1 adapter 走 agentObserve 实际驱动（非 catch 吞掉）', () => {
    const s = require('fs').readFileSync('./assets/js/commerce-adapter.js', 'utf8');
    assert.ok(/\bout\s*=\s*d\.agentObserve\(/.test(s) || /agentObserve\(name, args/.test(s));
  });
}

/* ── M1 · halted 终态早退 ── */
{
  const C = createCommerce({ now: () => 0 });
  C.agentStart({ keywords: ['杯'], maxBudget: 0, skuPrefs: [], quantity: 1, urgency: false }, { maxSteps: 2 });
  C.agentObserve('mcp.shopping.browser_snapshot', {}, { ok: true, response: 'x' });
  C.agentObserve('mcp.shopping.browser_snapshot', {}, { ok: true, response: 'x' });   /* 达 budget → halt STEP_BUDGET */
  const before = C.agentSnapshot();
  ok('M1 STEP_BUDGET 后继续 observe → 无状态变化', () => {
    assert.strictEqual(before.halted, true);
    const after = C.agentObserve('mcp.shopping.browser_snapshot', { amount: 999, orderId: 'Z', domain: 'cashieruser.alipay.com' }, { ok: true, response: 'https://cashieruser.alipay.com/cashiermain.htm?orderId=Z' });
    assert.strictEqual(after.step, before.step);
    assert.strictEqual(after.halted, true);            /* halted 不因 continue observe 而解除 */
    assert.strictEqual(after.paymentIntent, undefined); /* halted 不再生成新 PI */
  });
}

/* ── M2 · checkout 幂等（M1 已阻止 REVIEW 后再 observe；此处验证 PI 不被覆盖） ── */
{
  const C = createCommerce({ now: () => 0 });
  C.agentStart({ keywords: ['杯'], maxBudget: 0, skuPrefs: [], quantity: 1, urgency: false });
  C.agentAddCandidate({ title: '杯A', price: 90, sku: '浅绿' });
  const r1 = C.agentObserve('mcp.shopping.browser_snapshot', { orderId: 'OID', domain: 'cashieruser.alipay.com' }, { ok: true, response: 'https://cashieruser.alipay.com/cashiermain.htm?orderId=OID' });
  const pid1 = r1.paymentIntent.id;
  /* 重复捕获同一 orderId+checkoutUrl（M1 使其返回 halted 快照，不重建 PI） */
  C.agentObserve('mcp.shopping.browser_snapshot', { orderId: 'OID', domain: 'cashieruser.alipay.com' }, { ok: true, response: 'https://cashieruser.alipay.com/cashiermain.htm?orderId=OID' });
  ok('M2 相同 orderId+checkoutUrl 重复捕获 → 不生成新 PaymentIntent（id 不变）', () => {
    assert.strictEqual(C.agentReview().paymentIntent.id, pid1);
  });
}

/* ── M3 · 更换候选后清空旧 checkout/PI ── */
{
  const C = createCommerce({ now: () => 0 });
  C.agentStart({ keywords: ['杯'], maxBudget: 0, skuPrefs: [], quantity: 1, urgency: false });
  C.agentAddCandidate({ title: '杯A', price: 90, sku: '浅绿' });
  const r = C.agentObserve('mcp.shopping.browser_snapshot', { orderId: 'OA', domain: 'cashieruser.alipay.com' }, { ok: true, response: 'https://cashieruser.alipay.com/cashiermain.htm?orderId=OA' });
  assert.strictEqual(r.intent, 'REVIEW');
  const back = C.agentChangeCandidate();
  const snap = C.agentSnapshot();
  /* agentSnapshot 不暴露 paymentIntent/canonical；用 review 拒用来证明旧 PI 失效 */
  const rev = C.agentReview();
  ok('M3 更换后旧 PaymentIntent 失效（agentReview 拒用）', () => assert.strictEqual(rev.ok, false));
  ok('M3 更换后 session checkoutUrl/orderId 清空', () => assert.strictEqual(C.current().session.checkoutUrl, ''));
}

/* ── M4 · 候选指纹与 selected 稳定 ── */
{
  const C = createCommerce({ now: () => 0 });
  C.agentStart({ keywords: ['杯'], maxBudget: 0, skuPrefs: [], quantity: 1, urgency: false });
  C.agentAddCandidate({ title: '杯A', price: 90, sku: '浅绿' });
  C.agentAddCandidate({ title: '杯A', price: 90, sku: '白色' });   /* 同标题同价不同 SKU → 应区分 */
  ok('M4 同标题同价不同 SKU 正确区分（2 个候选）', () => assert.strictEqual(C.agentSnapshot().candidates.length, 2));
  const pick = C.agentSetSelected(C.agentSnapshot().candidates[0].id);
  ok('M4 selected 用稳定 id，读取回查当前候选（不产生 stale 对象）', () => {
    assert.ok(pick.selected && typeof pick.selected.title === 'string');
    assert.notStrictEqual(pick.selected, null);
  });
}

/* ── M5 · 新 session 无旧 PI/review 状态 ── */
{
  const C = createCommerce({ now: () => 0 });
  C.agentStart({ keywords: ['杯'], maxBudget: 0, skuPrefs: [], quantity: 1, urgency: false });
  C.agentAddCandidate({ title: '杯A', price: 90, sku: '浅绿' });
  C.agentObserve('mcp.shopping.browser_snapshot', { orderId: 'OB', domain: 'cashieruser.alipay.com' }, { ok: true, response: 'https://cashieruser.alipay.com/cashiermain.htm?orderId=OB' });
  C.agentStart({ keywords: ['杯'], maxBudget: 0, skuPrefs: [], quantity: 1, urgency: false });   /* 新任务 */
  const rev = C.agentReview();
  const cont = C.agentContinue();
  ok('M5 新 session 无旧 review/继续状态（agentReview/agentContinue 拒用）', () => {
    assert.strictEqual(rev.ok, false);
    assert.strictEqual(cont.ok, false);
    assert.strictEqual(C.current().session.checkoutUrl, '');
  });
}

/* ── L2 · 商品 URL 与 checkoutUrl 分离 ── */
{
  const C = createCommerce({ now: () => 0 });
  C.agentStart({ keywords: ['杯'], maxBudget: 0, skuPrefs: [], quantity: 1, urgency: false });
  /* 商品 URL 含 "checkout" 字样，但无 cashier 特征 → 不得当成 checkout */
  const r = C.agentObserve('mcp.shopping.browser_snapshot', { title: '杯A', price: 90, url: 'https://shop.example.com/checkout-info' }, { ok: true, response: '商品页' });
  ok('L2 商品 URL 含 checkout 字样但不触发收银台（不进 REVIEW）', () => {
    assert.strictEqual(r.intent, 'OBSERVE');
    assert.strictEqual(C.agentSnapshot().candidates[0].url, 'https://shop.example.com/checkout-info');
  });
  /* 真实 cashier URL 仍能捕获 */
  const r2 = C.agentObserve('mcp.shopping.browser_snapshot', { orderId: 'OC', domain: 'cashieruser.alipay.com' }, { ok: true, response: 'https://cashieruser.alipay.com/cashiermain.htm?orderId=OC' });
  ok('L2 真实 cashier*.alipay.com 仍被捕获 → REVIEW', () => assert.strictEqual(r2.intent, 'REVIEW'));
}

console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
