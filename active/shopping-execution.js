/*************************************************************
 * ====================================================================
 *   IB Active · Shopping Execution Strategy（Phase 3E）
 *   --------------------------------------------------------------------
 *   吸收原项目 Vael-KY/AI-Shopping-auto 的实战经验，固化为【执行策略】
 *   （纯确定性、零模型调用、零 Agent Runtime）：
 *     1. 淘宝 SPA SKU 点击的稳定性：商品页用「文本匹配式的 evaluate 点击」
 *        （动态 selector 不稳，`page.click` 经常定位不到）；不用在支付页。
 *     2. 商品页与 checkout URL 分离：商品详情 URL ≠ 收银台 URL。
 *     3. trust_login.do → cashiermain.htm?orderId 的中间跳转：必须等到
 *        cashiermain.htm（含 orderId）才算成功，trust_login.do 无 orderId 不可用。
 *     4. cashier URL 严格校验（https + cashier*.alipay.com）。
 *     5. headed Edge + 持久登录态（--browser msedge --user-data-dir <dir>）。
 *     6. 不在支付页使用 JS 合成点击（事件 isTrusted 校验）绕过支付确认。
 *   职责：这些只指导「动作」，真正的执行仍由【AI + 现有 IBMCP/Playwright】完成；
 *   Commerce 只负责状态/预算/事实/风险边界（不调用模型）。
 *   ====================================================================
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) { module.exports = factory(); }
  else { root.IBShopExec = factory(); root.IB = root.IB || {}; root.IB.shopExec = root.IBShopExec; }
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  /* cashier 严格校验：https + cashier*.alipay.com（与 pay-gate/alipay-provider 同一语义） */
  var CASHIER_RE = /^https:\/\/(?:[a-z0-9-]+\.)?cashier[\w.-]*\.alipay\.com\/[^\s"']*/i;
  var CASHIER_ORDER_ID_RE = /cashiermain\.htm\?[^\s"']*orderId=[\w-]+/i;
  /* 中间页（含 trust_login.do，无 orderId，不可作收银台） */
  var TRANSITION_RE = /(?:trust_login\.do|passport|login|identity|verify)[\w./-]*/i;
  /* 支付页（禁止 JS 合成点击） */
  var PAYMENT_PAGE_RE = /(?:cashier|pay|alipay\.com|confirm|sure)/i;

  /* 页面上的商品 SKU 操作建议：文本匹配式 evaluate 点击（SPA 稳定）；不在支付页用 */
  function skuClickStrategy() {
    return '商品页选 SKU/规格：优先用文本匹配 evaluate 点击（按唯一可见文字找元素再 .click()），'
      + '不要依赖易变的 CSS/位置选择器；商品页可用，但【支付/收银台页绝不用 JS 合成点击】（isTrusted 校验，会被忽略，也可能触发风控/绕过告警）。';
  }
  /* 收银台跳转序列提示（trust_login → cashiermain） */
  function checkoutTransitionHint() {
    return '点击“立即支付/去支付”后可能先经过 trust_login.do 等中间页（无 orderId）：'
      + '必须等跳转到 cashiermain.htm?orderId=… 才算真正收银台；'
      + '把 cashiermain.htm?orderId=… 的完整 URL 作为 checkoutUrl，中间页/登录页不可用。';
  }

  var INTENT_TOOL = {
    SEARCH: 'mcp.shopping.browser_navigate / browser_type(搜索框)',
    OBSERVE: 'mcp.shopping.browser_snapshot',
    FILTER: 'mcp.shopping.browser_snapshot',
    COMPARE: 'mcp.shopping.browser_snapshot',
    SELECT: 'mcp.shopping.browser_click(商品链接)',
    SKU: 'mcp.shopping.browser_evaluate(文本匹配) 或 browser_click(规格)',
    CHECKOUT: 'mcp.shopping.browser_navigate / browser_snapshot(取收银台)',
    REVIEW: '(人工审核，无工具)',
    STOP: '(停止，无工具)'
  };
  function recommendTool(intent) { return INTENT_TOOL[intent] || 'mcp.shopping.browser_snapshot'; }

  function validateCashierUrl(url) { return CASHIER_RE.test(String(url || '').trim()); }
  function hasCashierOrderId(url) { return CASHIER_ORDER_ID_RE.test(String(url || '').trim()); }
  function isTransitionPage(url) { return TRANSITION_RE.test(String(url || '').trim()); }
  function isPaymentPage(url) { return PAYMENT_PAGE_RE.test(String(url || '').trim()); }
  /* 严格提取收银台 URL（只认 #cashier*.alipay.com + cashiermain.htm?orderId），过渡页/登录页返回空 */
  function extractCashierUrl(textOrUrl) {
    var s = String(textOrUrl || '');
    /* 用无锚定匹配：允许 URL 嵌在中文文本中（如“跳转到 https://cashier… ”） */
    var m = s.match(/https?:\/\/(?:[a-z0-9-]+\.)?cashier[\w.-]*\.alipay\.com\/[^\s"']*/i);
    if (m && CASHIER_ORDER_ID_RE.test(m[0])) return m[0];
    var m2 = s.match(CASHIER_ORDER_ID_RE);
    return m2 ? m2[0] : '';
  }

  /* 注入给「执行购物动作的 AI」的提示块（贴合参考经验，一次注入） */
  function hintsBlock() {
    return '\n【淘宝操作经验】\n'
      + '-' + skuClickStrategy() + '\n'
      + '-' + checkoutTransitionHint() + '\n'
      + '- 商品详情页 URL 与收银台 URL 是两回事（详情页 ≠ checkoutUrl）。\n'
      + '- 收银台 URL 必须严格校验：https + cashier*.alipay.com + cashiermain.htm?orderId=。\n'
      + '- 用真实 headed Edge + 持久登录态（--browser msedge --user-data-dir <dir>）最低风控。\n'
      + '- 绝不执行任何真实支付；到 REVIEW 即止。';
  }

  return {
    CASHIER_RE: CASHIER_RE,
    CASHIER_ORDER_ID_RE: CASHIER_ORDER_ID_RE,
    TRANSITION_RE: TRANSITION_RE,
    PAYMENT_PAGE_RE: PAYMENT_PAGE_RE,
    skuClickStrategy: skuClickStrategy,
    checkoutTransitionHint: checkoutTransitionHint,
    recommendTool: recommendTool,
    validateCashierUrl: validateCashierUrl,
    hasCashierOrderId: hasCashierOrderId,
    isTransitionPage: isTransitionPage,
    isPaymentPage: isPaymentPage,
    extractCashierUrl: extractCashierUrl,
    hintsBlock: hintsBlock
  };
});
