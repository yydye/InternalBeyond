/* test_payment_auth.js — Payment Authorization Domain（active/payment-auth.js）
   ----------------------------------------------------------------------
   Phase 2A：只测授权策略（DENY/CONFIRM/ALLOW），不接真实支付。
   node test_payment_auth.js 运行；零外部依赖。 */
'use strict';

const assert = require('assert');
const PA = require('./active/payment-auth.js');

let pass = 0, fail = 0;
function ok(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + ' — ' + (e && e.message || e)); }
}

/* 固定时钟：控制 createdAt/expiresAt 确定性 */
function fixedNow(ms) { return () => ms; }

/* 内存持久化 store（模拟 Bridge 侧/文件） */
function memStore(initial) {
  let s = initial || null;
  return { load: () => s, save: (next) => { s = JSON.parse(JSON.stringify(next)); }, get: () => s };
}

console.log('Payment Authorization Domain tests\n');

/* ── A. 基础：disabled → DENY + manual link ── */
{
  const auth = PA.createPaymentAuth({ now: fixedNow(0) });
  auth.setConfig({ mode: 'disabled', allowedDomains: ['alipay.com'] });
  const intent = auth.newIntent({ amount: 30, orderId: 'o1', domain: 'alipay.com', checkoutUrl: 'https://cashier.alipay.com/a?orderId=o1' });
  const r = auth.decide(intent);
  ok('disabled → DENY', () => assert.strictEqual(r.action, 'DENY'));
  ok('disabled 返回人工支付链接（manualLink）', () => assert.ok(r.manualLink.indexOf('cashier.alipay.com') >= 0));
  ok('disabled 永不 ALLOW（needsConfirm=false）', () => assert.strictEqual(r.needsConfirm, false));
}

/* ── B. each → CONFIRM（每笔都需确认） ── */
{
  const auth = PA.createPaymentAuth({ now: fixedNow(0) });
  auth.setConfig({ mode: 'each', allowedDomains: ['alipay.com'] });
  const intent = auth.newIntent({ amount: 30, orderId: 'o2', domain: 'alipay.com', checkoutUrl: 'https://cashier.alipay.com/b?orderId=o2' });
  const r = auth.decide(intent);
  ok('each → CONFIRM', () => assert.strictEqual(r.action, 'CONFIRM'));
  ok('each needsConfirm=true', () => assert.strictEqual(r.needsConfirm, true));
}

/* ── C. under_limit：¥30/¥50 → ALLOW；¥51/¥50 → CONFIRM ── */
{
  const auth = PA.createPaymentAuth({ now: fixedNow(0) });
  auth.setConfig({ mode: 'under_limit', perOrderLimit: 50, dailyLimit: 200, allowedDomains: ['alipay.com'] });
  const i30 = auth.newIntent({ amount: 30, orderId: 'o3', domain: 'alipay.com', checkoutUrl: 'https://cashier.alipay.com/c?orderId=o3' });
  const a30 = auth.decide(i30);
  ok('under_limit ¥30/¥50 → ALLOW', () => assert.strictEqual(a30.action, 'ALLOW'));
  ok('ALLOW needsConfirm=false', () => assert.strictEqual(a30.needsConfirm, false));

  const i51 = auth.newIntent({ amount: 51, orderId: 'o4', domain: 'alipay.com', checkoutUrl: 'https://cashier.alipay.com/d?orderId=o4' });
  const a51 = auth.decide(i51);
  ok('under_limit ¥51/¥50 → CONFIRM', () => assert.strictEqual(a51.action, 'CONFIRM'));
  ok('CONFIRM needsConfirm=true', () => assert.strictEqual(a51.needsConfirm, true));
}

/* ── D. daily 预算超限 → DENY ── */
{
  const auth = PA.createPaymentAuth({ now: fixedNow(0) });
  auth.setConfig({ mode: 'under_limit', perOrderLimit: 50, dailyLimit: 100, allowedDomains: ['alipay.com'] });
  /* 先记一笔 80，再尝试 30 → 110 > 100 → DENY */
  const i80 = auth.newIntent({ amount: 80, orderId: 'o5', domain: 'alipay.com', checkoutUrl: 'https://cashier.alipay.com/e?orderId=o5' });
  auth.decide(i80);              /* 88<100，未记 */
  auth.commitSpend(i80);         /* 记 80 */
  const i30 = auth.newIntent({ amount: 30, orderId: 'o6', domain: 'alipay.com', checkoutUrl: 'https://cashier.alipay.com/f?orderId=o6' });
  const r = auth.decide(i30);
  ok('daily 超限（80+30>100）→ DENY', () => assert.strictEqual(r.action, 'DENY'));
  ok('DENY reason 提及日预算', () => assert.ok(/日预算/i.test(r.reason)));
}

/* ── E. 未授权域名 → DENY；http / 恶意相似域名 → DENY ── */
{
  const auth = PA.createPaymentAuth({ now: fixedNow(0) });
  auth.setConfig({ mode: 'under_limit', perOrderLimit: 50, dailyLimit: 200, allowedDomains: ['alipay.com'] });

  const badDomain = auth.newIntent({ amount: 30, orderId: 'o7', domain: 'evil.com', checkoutUrl: 'https://evil.com/x?orderId=o7' });
  ok('未授权域名 → DENY', () => assert.strictEqual(auth.decide(badDomain).action, 'DENY'));

  const httpUrl = auth.newIntent({ amount: 30, orderId: 'o8', domain: 'alipay.com', checkoutUrl: 'http://cashier.alipay.com/x?orderId=o8' });
  ok('http（非 https）→ DENY', () => assert.strictEqual(auth.decide(httpUrl).action, 'DENY'));

  const evilLike = auth.newIntent({ amount: 30, orderId: 'o9', domain: 'evil-alipay.com', checkoutUrl: 'https://evil-alipay.com/x?orderId=o9' });
  ok('恶意相似域名 evil-alipay.com → DENY（严格域名，非 contains）', () => assert.strictEqual(auth.decide(evilLike).action, 'DENY'));

  /* 对照：真实 alipay 子域应通过域名检查 */
  const cashierSub = auth.newIntent({ amount: 30, orderId: 'o10', domain: 'cashieruser.alipay.com', checkoutUrl: 'https://cashieruser.alipay.com/cashiermain.htm?orderId=o10' });
  const rs = auth.decide(cashierSub);
  ok('合法 alipay 子域名（cashieruser.alipay.com）域名检查通过', () => {
    const d = (rs.checks || []).find(c => c.name === 'domain');
    assert.ok(d && d.ok === true);
  });
}

/* ── F. 过期 PaymentIntent → DENY ── */
{
  const now = fixedNow(1000);
  const auth = PA.createPaymentAuth({ now });
  auth.setConfig({ mode: 'under_limit', perOrderLimit: 200, dailyLimit: 500, allowedDomains: ['alipay.com'] });
  /* createdAt 为过去（-100000ms），ttl 短 → expiresAt 已过 */
  const intent = auth.newIntent({ amount: 30, orderId: 'o11', domain: 'alipay.com', checkoutUrl: 'https://cashier.alipay.com/g?orderId=o11', createdAt: -100000, ttlMs: 100 });
  ok('PaymentIntent 已过期 → DENY', () => assert.strictEqual(auth.decide(intent).action, 'DENY'));
}

/* ── G. orderId / intent nonce 不匹配 → DENY ── */
{
  const auth = PA.createPaymentAuth({ now: fixedNow(0) });
  auth.setConfig({ mode: 'under_limit', perOrderLimit: 200, dailyLimit: 500, allowedDomains: ['alipay.com'] });
  const intent = auth.newIntent({ amount: 30, orderId: 'o12', domain: 'alipay.com', checkoutUrl: 'https://cashier.alipay.com/h?orderId=o12' });
  ok('orderId 不匹配 → DENY', () => assert.strictEqual(auth.decide(intent, { orderId: 'o_wrong', nonce: intent.id }).action, 'DENY'));
  ok('intent nonce 不匹配 → DENY', () => assert.strictEqual(auth.decide(intent, { orderId: 'o12', nonce: 'pi_wrong' }).action, 'DENY'));
  ok('orderId+nonce 匹配 → 不被误拒（进入策略判定）', () => {
    const r = auth.decide(intent, { orderId: 'o12', nonce: intent.id });
    assert.notStrictEqual(r.reason, 'orderId 不匹配');
  });
}

/* ── H. ledger 持久化后重新加载仍正确 ── */
{
  const store = memStore();
  const authA = PA.createPaymentAuth({ now: fixedNow(0), persist: store });
  authA.setConfig({ mode: 'under_limit', perOrderLimit: 100, dailyLimit: 500, allowedDomains: ['alipay.com'] });
  const i = authA.newIntent({ amount: 120, orderId: 'o13', domain: 'alipay.com', checkoutUrl: 'https://cashier.alipay.com/i?orderId=o13' });
  authA.decide(i);          /* 120>100 → CONFIRM，未记 */
  authA.commitSpend(i);     /* 记 120 */

  /* 新实例（Bridge 重启后）同一 store 重新载入 */
  const authB = PA.createPaymentAuth({ now: fixedNow(0), persist: store });
  const led = authB.ledger();
  ok('ledger 持久化后重新加载仍正确（spent=120）', () => assert.strictEqual(led.spent, 120));
  const i2 = authB.newIntent({ amount: 390, orderId: 'o14', domain: 'alipay.com', checkoutUrl: 'https://cashier.alipay.com/j?orderId=o14' });
  ok('重新加载后日预算判断仍准确（120+390 > 500 → DENY）', () => assert.strictEqual(authB.decide(i2).action, 'DENY'));
}

/* ── I. 域模块零 Harness 依赖 + 纯逻辑 ── */
ok('payment-auth 模块零 Harness 依赖（无 require 到核心/无 fetch/DOM）', () => {
  let src = require('fs').readFileSync('./active/payment-auth.js', 'utf8');
  /* 剥掉注释再检查，避免自身注释里的"无 fetch/无 window"字样误报 */
  src = src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
  assert.ok(!/require\s*\(\s*['"][^'"]*(?:node-model-port|node-model-compat|ib-model-core|agent-runtime)/i.test(src));
  assert.ok(!/\bfetch\s*\(|\bwindow\b|\bdocument\b/.test(src));
});

/* ── J. matchDomain 严格性单元验证 ── */
ok('matchDomain：精确 host 匹配 + .allow 后缀，杜绝 contains', () => {
  const m = PA.matchDomain;
  assert.strictEqual(m('https://cashier.alipay.com/a', ['alipay.com']).ok, true);
  assert.strictEqual(m('https://cashieruser.alipay.com/x', ['alipay.com']).ok, true);
  assert.strictEqual(m('https://evil-alipay.com/x', ['alipay.com']).ok, false);
  assert.strictEqual(m('https://alipay.com.evil.com/x', ['alipay.com']).ok, false);
  assert.strictEqual(m('http://alipay.com/x', ['alipay.com']).ok, false);   /* 非 https */
  assert.strictEqual(m('https://example.cn/x', ['alipay.com']).ok, false);
});

console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
