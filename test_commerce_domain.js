/* test_commerce_domain.js — Commerce Domain（active/commerce.js）单元测试
   ----------------------------------------------------------------------
   Phase 1 只读购物状态机验证：
     · 阶段推进（browsing → product_selected → sku_selected → checkout_captured）
     · observeToolResult 从 mcp.shopping.* 结果中捕获 商品/SKU/金额/收银台URL
     · 预算状态与 canSpend 金额门禁
     · 支付边界：submitPayment() 必须返回 PHASE1_DISABLED
     · 不污染 Harness：本文件仅 require active/commerce.js
   node test_commerce_domain.js 运行；零外部依赖。 */
'use strict';

const assert = require('assert');
const IBCommerce = require('./active/commerce.js');

let pass = 0, fail = 0;
function ok(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + ' — ' + (e && e.message || e)); }
}

/* 用固定时间点，保证预算日切换测试确定性 */
function fixedNow(ms) { const t = new Date(ms); return () => ms; }

const C = IBCommerce.create({ now: fixedNow(0) });

console.log('Commerce Domain tests\n');

/* ── 1. 默认阶段 = idle，且域不引用 Harness 依赖 ── */
ok('初始阶段为 idle', () => assert.strictEqual(C.current().session.stage, 'idle'));
ok('默认预算 capping 已配置', () => {
  const b = C.budget();
  assert.strictEqual(b.dailyCap, IBCommerce.LIMITS.DAILY_CAP);
  assert.strictEqual(b.orderCap, IBCommerce.LIMITS.ORDER_CAP);
});
ok('域模块零 Harness 依赖（仅纯逻辑）', () => {
  const src = require('fs').readFileSync('./active/commerce.js', 'utf8');
  /* 只匹配 require(...) 调用形式，避免自身注释里"不 require node-model-port"字样误报 */
  assert.ok(!/require\s*\(\s*['"][^'"]*(?:node-model-port|node-model-compat|ib-model-core|agent-runtime)/i.test(src));
});

/* ── 2. observeToolResult 推进状态机 + 捕获 商品/SKU/金额/收银台URL ── */
C.observeToolResult('mcp.shopping.browser_navigate', { url: 'https://s.taobao.com/search?q=茶具' }, { ok: true, response: '已打开淘宝搜索页' });
ok('出现 mcp.shopping.* 调用即激活会话（stage=browsing）', () => {
  const s = C.current().session;
  assert.strictEqual(s.active, true);
  assert.strictEqual(s.stage, 'browsing');
});

C.observeToolResult('mcp.shopping.browser_snapshot', {}, { ok: true, response: '当前页面：商品标题【日式粗陶茶具套装】 价格 128 元' });
ok('识别商品标题并推进到 product_selected', () => {
  const s = C.current().session;
  assert.strictEqual(s.productTitle.includes('日式粗陶茶具'), true);
  assert.strictEqual(s.stage, 'product_selected');
});

C.observeToolResult('mcp.shopping.browser_click', { spec: '日式粗陶 · 浅绿色 800ml' }, { ok: true, response: '已选择规格' });
ok('识别 SKU 并推进到 sku_selected', () => {
  const s = C.current().session;
  assert.strictEqual(s.sku, '日式粗陶 · 浅绿色 800ml');
  assert.strictEqual(s.stage, 'sku_selected');
});

C.observeToolResult('mcp.shopping.browser_snapshot', {}, { ok: true, response: '点击立即支付后跳转 https://cashieruser.alipay.com/cashiermain.htm?orderId=202609011234' });
ok('捕获收银台 URL 并推进到 checkout_captured', () => {
  const s = C.current().session;
  assert.strictEqual(s.stage, 'checkout_captured');
  assert.ok(s.checkoutUrl.indexOf('cashier') >= 0);
  assert.strictEqual(s.orderId, '202609011234');
});

/* ── 3. stage 单调推进（不能从 checkout_captured 回退） ── */
C.observeToolResult('mcp.shopping.browser_navigate', {}, { ok: true, response: '返回搜索' });
ok('stage 不回退（单调）', () => assert.strictEqual(C.current().session.stage, 'checkout_captured'));

/* ── 4. 预算与金额门禁 ── */
ok('canSpend 超过单笔上限被拒', () => {
  assert.strictEqual(C.canSpend(99999).ok, false);
});
ok('canSpend 单笔在上限内通过', () => {
  assert.strictEqual(C.canSpend(128).ok, true);
});
ok('amount 从工具结果被捕获', () => {
  assert.strictEqual(C.current().session.amount, 128);
});

/* ── 5. nextStep 编排建议 ── */
ok('checkout_captured 阶段下一步=stop（Phase1 只读）', () => {
  const n = C.nextStep();
  assert.strictEqual(n.action, 'stop');
  assert.ok(/禁止支付/i.test(n.hint));
});

/* ── 6. 状态文本注入 ── */
ok('statusBlock 包含阶段/金额/收银台URL/禁止支付提示', () => {
  const s = C.statusBlock();
  assert.ok(s.indexOf('checkout_captured') >= 0);
  assert.ok(s.indexOf('禁止支付') >= 0);
});

/* ── 7. 支付边界：绝不发出真实支付 ── */
ok('submitPayment 返回 PHASE1_DISABLED 边界', () => {
  const r = C.submitPayment({ paymentLink: 'https://cashier.alipay.com/x' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.boundary, IBCommerce.PAYMENT_BOUNDARY);
  assert.ok(/PHASE1_DISABLED/i.test(r.reason));
});

/* ── 8. reset/startSession 生命周期 ── */
C.reset();
ok('reset 后回 idle 且无收银台 URL', () => {
  const s = C.current().session;
  assert.strictEqual(s.active, false);
  assert.strictEqual(s.stage, 'idle');
  assert.strictEqual(s.checkoutUrl, '');
});
C.startSession({ query: '咖啡杯' });
ok('startSession 激活并进入 browsing', () => {
  const s = C.current().session;
  assert.strictEqual(s.active, true);
  assert.strictEqual(s.stage, 'browsing');
  assert.strictEqual(s.query, '咖啡杯');
});

console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
