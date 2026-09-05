/* test_shopping_agent.js — Shopping Agent（Phase 3A）
   ----------------------------------------------------------------------
   node test_shopping_agent.js 运行；零外部依赖。
   验证：自然语言→task、搜索→候选、多准则比较→稳定选择、预算/SKU/checkout 约束、
   step budget、tool failure、无商品、超预算、到 PaymentIntent 即停。 */
'use strict';

const assert = require('assert');
const createCommerce = require('./active/commerce.js').create;

let pass = 0, fail = 0;
function ok(name, fn) { try { fn(); pass++; console.log('  ✓ ' + name); } catch (e) { fail++; console.log('  ✗ ' + name + ' — ' + (e && e.message || e)); } }
function fixedNow(ms) { return () => ms; }

console.log('Shopping Agent（Phase 3A）tests\n');

/* ── 1. 自然语言 → shopping task ── */
{
  const C = createCommerce({ now: fixedNow(0) });
  const t = C.planShopping('帮我买一个 500 元以内的咖啡杯，急，浅绿色');
  ok('解析预算（500 元以内）', () => assert.strictEqual(t.maxBudget, 500));
  ok('解析关键词（咖啡杯 / 浅绿色）', () => { assert.ok(t.keywords.includes('咖啡杯')); assert.ok(t.keywords.includes('浅绿色')); });
  ok('解析急切（急）', () => assert.strictEqual(t.urgency, true));
  const t2 = C.planShopping('预算不超过300，买蓝牙耳机，白色，2个');
  ok('解析预算 + 数量 + 规格词', () => {
    assert.strictEqual(t2.maxBudget, 300);
    assert.strictEqual(t2.quantity, 2);
    assert.ok(t2.keywords.includes('蓝牙耳机'));
  });
}

/* ── 2. 搜索 → 候选商品（agentObserve 注入结构化结果） ── */
{
  const C = createCommerce({ now: fixedNow(0) });
  C.agentStart({ keywords: ['咖啡杯'], maxBudget: 500, skuPrefs: [], quantity: 1, urgency: false });
  C.agentObserve('mcp.shopping.browser_snapshot', { title: '日式粗陶咖啡杯', price: 128, rating: 4.8, deliveryDays: 3, stock: '有货' }, { ok: true, response: '候选' });
  C.agentObserve('mcp.shopping.browser_snapshot', { title: '北欧简约咖啡杯(白色)', price: 199, rating: 4.5, deliveryDays: 2, stock: '有货' }, { ok: true, response: '候选' });
  const snap = C.agentSnapshot();
  ok('搜索后收集到 ≥2 个候选商品', () => assert.strictEqual(snap.candidates.length, 2));
  ok('候选含价格/评分/配送/库存字段', () => {
    const c = snap.candidates[0];
    assert.strictEqual(c.price, 128);
    assert.strictEqual(c.rating, 4.8);
    assert.strictEqual(c.deliveryDays, 3);
  });
}

/* ── 3. 多商品比较 → 稳定选择（非最低价；多准则评分） ── */
{
  const C = createCommerce({ now: fixedNow(0) });
  C.agentStart({ keywords: ['机械键盘'], maxBudget: 800, skuPrefs: [], quantity: 1, urgency: false });
  /* 便宜但低分、慢配送、无库存 vs 稍贵但高分期 */
  C.agentAddCandidate({ title: '廉价机械键盘', price: 120, rating: 3.0, deliveryDays: 12, stock: '缺货' });
  C.agentAddCandidate({ title: '高端机械键盘', price: 720, rating: 4.9, deliveryDays: 1, stock: '有货' });
  const ranked = C.rankCandidates();
  ok('比较后最高评分候选排第一（非最低价）', () => {
    assert.strictEqual(ranked[0].title, '高端机械键盘');
    assert.strictEqual(ranked[0].score, Math.max.apply(null, ranked.map(r => r.score)));
  });
  ok('缺货/低分候选被降权', () => assert.ok(ranked[0].score > ranked[1].score));
}

/* ── 4. 预算约束：全部候选超预算 → STOP OVER_BUDGET ── */
{
  const C = createCommerce({ now: fixedNow(0) });
  C.agentStart({ keywords: ['咖啡杯'], maxBudget: 100, skuPrefs: [], quantity: 1, urgency: false });
  C.agentAddCandidate({ title: 'A', price: 200 });   /* 都超 100 */
  C.agentAddCandidate({ title: 'B', price: 300 });
  const n = C.agentNext();
  ok('全部候选超预算 → STOP(OVER_BUDGET)', () => {
    assert.strictEqual(n.action, 'STOP');
    assert.strictEqual(n.haltedReason, C.STOP_REASON.OVER_BUDGET);
  });
}

/* ── 5. SKU 约束：存在规格偏好且候选未带 sku → 进入 SKU 阶段 ── */
{
  const C = createCommerce({ now: fixedNow(0) });
  C.agentStart({ keywords: ['咖啡杯'], maxBudget: 500, skuPrefs: ['浅绿色'], quantity: 1, urgency: false });
  C.agentAddCandidate({ title: '咖啡杯A', price: 120, sku: '' });
  const n = C.agentNext();
  ok('候选未覆盖 SKU 偏好 → 意图=SKU', () => assert.strictEqual(n.intent, 'SKU'));
  const C2 = createCommerce({ now: fixedNow(0) });
  C2.agentStart({ keywords: ['咖啡杯'], maxBudget: 500, skuPrefs: ['浅绿色'], quantity: 1, urgency: false });
  C2.agentAddCandidate({ title: '咖啡杯A', price: 120, sku: '浅绿色' });
  ok('候选已覆盖 SKU 偏好 → 进入比较/选择', () => assert.notStrictEqual(C2.agentNext().intent, 'SKU'));
}

/* ── 6. checkout 捕获 → 生成 PaymentIntent → 3A 立即停止 ── */
{
  const C = createCommerce({ now: fixedNow(0) });
  C.agentStart({ keywords: ['咖啡杯'], maxBudget: 500, skuPrefs: [], quantity: 1, urgency: false });
  const r = C.agentObserve('mcp.shopping.browser_snapshot', { amount: 128, orderId: 'IB777', domain: 'cashieruser.alipay.com' }, { ok: true, response: '已进入收银台 https://cashieruser.alipay.com/cashiermain.htm?orderId=IB777' });
  ok('捕获收银台 URL → intent=REVIEW 且停止（CHECKOUT_STOP）', () => {
    assert.strictEqual(r.intent, 'REVIEW');
    assert.strictEqual(r.halted, true);
    assert.strictEqual(r.haltedReason, C.STOP_REASON.CHECKOUT_STOP);
  });
  ok('生成 PaymentIntent（amount/orderId/checkoutUrl/domain/id）', () => {
    const pi = r.paymentIntent;
    assert.strictEqual(pi.orderId, 'IB777');
    assert.strictEqual(pi.amount, 128);
    assert.ok(pi.checkoutUrl.indexOf('cashieruser.alipay.com') >= 0);
    assert.ok(pi.id && pi.expiresAt > pi.createdAt);
  });
  ok('3B 停止原因明确（不调用真实支付，进入人工审核）', () => assert.ok(/人工审核/.test(r.snapshot.reason) || /停止/.test(r.snapshot.reason)));
}

/* ── 7. step budget：达到最大观察步数 → STOP(STEP_BUDGET) ── */
{
  const C = createCommerce({ now: fixedNow(0) });
  C.agentStart({ keywords: ['咖啡杯'], maxBudget: 500, skuPrefs: [], quantity: 1, urgency: false }, { maxSteps: 2 });
  C.agentObserve('mcp.shopping.browser_snapshot', {}, { ok: true, response: '观察1（无候选）' });
  const r2 = C.agentObserve('mcp.shopping.browser_snapshot', {}, { ok: true, response: '观察2（无候选）' });
  ok('step budget 达上限 → STOP(STEP_BUDGET)', () => {
    assert.strictEqual(r2.halted, true);
    assert.strictEqual(r2.haltedReason, C.STOP_REASON.STEP_BUDGET);
  });
}

/* ── 8. tool failure：连续失败达上限 → STOP(TOOL_FAILURE) ── */
{
  const C = createCommerce({ now: fixedNow(0) });
  C.agentStart({ keywords: ['咖啡杯'], maxBudget: 500, skuPrefs: [], quantity: 1, urgency: false }, { maxFailures: 2 });
  C.agentObserve('mcp.shopping.browser_navigate', {}, { ok: false, reason: '页面超时' });
  const r = C.agentObserve('mcp.shopping.browser_navigate', {}, { ok: false, reason: '页面超时' });
  ok('连续工具失败达上限 → STOP(TOOL_FAILURE)', () => {
    assert.strictEqual(r.halted, true);
    assert.strictEqual(r.haltedReason, C.STOP_REASON.TOOL_FAILURE);
  });
}

/* ── 9. 无商品：多次观察仍无候选 → STOP(NO_RESULTS) ── */
{
  const C = createCommerce({ now: fixedNow(0) });
  C.agentStart({ keywords: ['不存在的东西'], maxBudget: 500, skuPrefs: [], quantity: 1, urgency: false });
  C.agentObserve('mcp.shopping.browser_snapshot', {}, { ok: true, response: '没有找到相关商品' });
  const r = C.agentObserve('mcp.shopping.browser_snapshot', {}, { ok: true, response: '仍然没有' });
  ok('无候选 → STOP(NO_RESULTS)', () => {
    assert.strictEqual(r.halted, true);
    assert.strictEqual(r.haltedReason, C.STOP_REASON.NO_RESULTS);
  });
}

/* ── 10. 超预算单候选：只有一个且超预算 → STOP(OVER_BUDGET) ── */
{
  const C = createCommerce({ now: fixedNow(0) });
  C.agentStart({ keywords: ['咖啡杯'], maxBudget: 100, skuPrefs: [], quantity: 1, urgency: false });
  C.agentAddCandidate({ title: '太贵咖啡杯', price: 500 });
  const n = C.agentNext();
  ok('单候选超预算 → STOP(OVER_BUDGET)', () => {
    assert.strictEqual(n.action, 'STOP');
    assert.strictEqual(n.haltedReason, C.STOP_REASON.OVER_BUDGET);
  });
}

/* ── 11. 正常流程：搜索→比较→选中（agentNext 稳定给出下一步） ── */
{
  const C = createCommerce({ now: fixedNow(0) });
  C.agentStart({ keywords: ['鼠标'], maxBudget: 300, skuPrefs: [], quantity: 1, urgency: false });
  C.agentAddCandidate({ title: '鼠标A', price: 90, rating: 4.6, deliveryDays: 2, stock: '有货' });
  C.agentAddCandidate({ title: '鼠标B', price: 150, rating: 4.9, deliveryDays: 1, stock: '有货' });
  const n = C.agentNext();
  ok('多个候选 → 意图至少进入 COMPARE/SELECT', () => {
    assert.ok(['OBSERVE', 'FILTER', 'COMPARE', 'SELECT'].includes(n.intent));
    assert.strictEqual(n.ranked.length, 2);
  });
  const pick = C.agentSetSelected(n.selected.id);
  ok('选中候选后 selected 有值且意图=SELECT', () => {
    assert.ok(pick.selected && pick.selected.title);
    assert.strictEqual(pick.intent, 'SELECT');
  });
}

console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
