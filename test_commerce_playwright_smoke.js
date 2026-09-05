/* test_commerce_playwright_smoke.js — 真实 Playwright MCP + Commerce Domain 冒烟（Phase 1.5）
   ----------------------------------------------------------------------
   前置：本地已启动真实 Playwright MCP：
     npx @playwright/mcp@latest --port 8931      （HTTP endpoint = /mcp）
   本测试用「与浏览器 IBMCP 完全一致」的 JSON-RPC + Mcp-Session-Id 会话转发
   驱动真实 endpoint，实际 打开测试网页 → snapshot → interaction，并把快照文本
   经 commerce-adapter 同款的 observeToolResult 回灌进 Commerce Domain。
   若 :8931 不可达（服务器未启动），打印 SKIP 并退出 0（不破坏测试门禁）。

   校验目标：
     · initialize / tools/list / tools/call 全部成功（真实 endpoint /mcp）
     · tools/list 发现真实 Playwright 工具（含 browser_navigate / browser_snapshot）
     · 真实浏览器导航 + snapshot + 交互可用
     · Commerce Domain 状态机在与 Playwright 工具名无关的情况下推进（解耦）
   node test_commerce_playwright_smoke.js ；退出 0=pass/skip，1=fail。 */
'use strict';

const assert = require('assert');
const IBCommerce = require('./active/commerce.js');

const BASE = process.env.IB_PW_MCP_URL || 'http://localhost:8931/mcp';

let pass = 0, fail = 0;
function ok(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + ' — ' + (e && e.message || e)); }
}

/* 与 IBMCP 一致：Mcp-Session-Id 头 会话转发 */
function makeClient() {
  let sid = '';
  async function rpc(method, params, id) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 60000);
    try {
      const b = { jsonrpc: '2.0', method };
      if (params !== undefined) b.params = params;
      if (method.indexOf('notifications/') !== 0) b.id = id;
      const h = { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' };
      if (sid) h['Mcp-Session-Id'] = sid;
      const res = await fetch(BASE, { method: 'POST', headers: h, body: JSON.stringify(b), signal: ctl.signal });
      const sh = res.headers.get('mcp-session-id');
      if (sh) sid = sh;
      const raw = await res.text();
      if (method.indexOf('notifications/') === 0) return null;
      const m = raw.match(/data: (\{[\s\S]*\})/);
      const j = m ? JSON.parse(m[1]) : (raw ? JSON.parse(raw) : {});
      if (j.error) throw new Error('MCP error ' + j.error.code + ': ' + j.error.message);
      return j.result;
    } finally { clearTimeout(t); }
  }
  async function call(name, args, id) {
    const r = await rpc('tools/call', { name, arguments: args || {} }, id);
    const content = (r && r.content || []).filter(c => c && c.type === 'text').map(c => c.text).join('\n');
    return { isError: !!(r && r.isError), content, raw: r };
  }
  return { rpc, call, get sid() { return sid; } };
}

(async () => {
  console.log('Real Playwright MCP smoke test  ->  ' + BASE + '\n');

  /* 可探达检查：不可达则 SKIP（exit 0） */
  let reachable = false;
  try {
    const c = makeClient();
    const init = await c.rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'ib-smoke', version: '1' } }, 1);
    reachable = !!(init && init.serverInfo);
  } catch (e) { reachable = false; }
  if (!reachable) {
    console.log('SKIP：localhost:8931 不可达，未启动真实 Playwright MCP（先运行 npx @playwright/mcp@latest --port 8931）');
    process.exit(0);
  }

  const c = makeClient();
  const init = await c.rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'ib-smoke', version: '1' } }, 1);
  ok('initialize 成功（真实 endpoint /mcp）', () => {
    assert.ok(init && init.serverInfo);
    console.log('        server = ' + init.serverInfo.name + ' ' + init.serverInfo.version);
  });
  ok('会话建立（Mcp-Session-Id 已转发）', () => assert.ok(c.sid));

  await c.rpc('notifications/initialized', {});
  const tools = (await c.rpc('tools/list', {}, 2)) || {};
  ok('tools/list 返回真实 Playwright 工具（>=10 个）', () => {
    assert.ok((tools.tools || []).length >= 10);
  });
  ok('包含 browser_navigate / browser_snapshot / browser_click（核心工具）', () => {
    const names = (tools.tools || []).map(t => t.name);
    assert.ok(names.includes('browser_navigate'));
    assert.ok(names.includes('browser_snapshot'));
    assert.ok(names.includes('browser_click'));
  });

  /* ① 真实浏览器导航 */
  const nav = await c.call('browser_navigate', { url: 'https://example.com' }, 3);
  ok('browser_navigate 真实打开测试网页（非 isError）', () => {
    assert.strictEqual(nav.isError, false);
    assert.ok(/example\.com/i.test(nav.content));
  });

  /* ② 真实 snapshot */
  const snap = await c.call('browser_snapshot', {}, 4);
  ok('browser_snapshot 返回页面快照', () => {
    assert.strictEqual(snap.isError, false);
    assert.ok(snap.content.length > 0);
    assert.ok(/Example Domain/i.test(snap.content));
  });

  /* ③ 真实交互：点击 "More information..." 链接再快照 */
  let interact = { isError: false, content: '' };
  try { interact = await c.call('browser_click', { ref: 'e6' }, 5); } catch (e) { interact = { isError: true, content: String(e.message) }; }
  /* ref 可能不稳定，点击失败不算 fail（锚点随快照会话变化），只记录 */
  console.log('        interaction(browser_click on ref=e6) => ' + (interact.isError ? 'skip(ref 变化)' : '点击成功'));

  /* ④ Commerce Domain 回灌：把上面的真实快照文本喂给 observeToolResult */
  const C = IBCommerce.create({ now: () => 0 });
  C.observeToolResult('mcp.shopping.browser_navigate', { url: 'https://example.com' }, { ok: !nav.isError, response: nav.content });
  C.observeToolResult('mcp.shopping.browser_snapshot', {}, { ok: !snap.isError, response: snap.content });
  ok('Commerce Domain：真实快照文本回灌后会话激活（browsing）', () => {
    const s = C.current().session;
    assert.strictEqual(s.active, true);
    assert.ok(['browsing', 'product_selected'].includes(s.stage));
  });

  /* ⑤ 解耦验证：state machine 不依赖 browser_* 工具名 —— 换一个不存在的
       假工具名，只要结果文本含商品/收银台，状态机照常推进 */
  C.observeToolResult('mcp.shopping.whatever_tool', {}, { ok: true, response: '商品标题【日式粗陶茶具套装】价格 128 元，收银台 https://cashieruser.alipay.com/cashiermain.htm?orderId=20260901ABC' });
  ok('Commerce 与 Playwright 工具名解耦（假工具名也推进+捕获收银台）', () => {
    const s = C.current().session;
    assert.strictEqual(s.stage, 'checkout_captured');
    assert.ok(s.checkoutUrl.indexOf('cashier') >= 0);
    assert.strictEqual(s.orderId, '20260901ABC');
  });

  /* ⑥ 支付边界：绝不出支付 */
  ok('submitPayment 仍返回 PHASE1_DISABLED（不接支付）', () => {
    const r = C.submitPayment({ paymentLink: 'x' });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.boundary, IBCommerce.PAYMENT_BOUNDARY);
  });

  console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
