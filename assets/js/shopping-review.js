/* ============================================================
 * IB Shopping Copilot / Human Review（Phase 3B）
 * --------------------------------------------------------------------
 * 在 agent 捕获收银台 (CHECKOUT_STOP) 后，渲染可人工接管的购物审核面板：
 *   展示 商品标题/价格/评分/配送/SKU/商家域名/checkout 状态 + AI 选择理由
 *   （理由来自实际 scorer/约束 scoreDetail，不编造）。
 *   动作：查看商品 / 更换候选 / 继续结算 / 停止购物。
 * 安全边界：本 UI 只「展示 + 触发入口」，真实支付授权由 Bridge pay-gate
 *   独立重算 decide（UI 不能声明 ALLOW）。不接触任何支付凭证。
 * 样式全用 social.css 的 .sr-* 类（零内联 style）。
 * ============================================================ */
(function (NS) {
  'use strict';

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

  function panel() {
    var el = document.getElementById('shopping-review-panel');
    if (!el) {
      el = document.createElement('div');
      el.id = 'shopping-review-panel';
      el.className = 'sr-panel';
      el.setAttribute('role', 'dialog');
      document.body.appendChild(el);
    }
    return el;
  }

  function render(rev) {
    if (!rev || !rev.ok) return;
    var p = rev.product || {};
    var co = rev.checkout || {};
    var reasons = (rev.selectionReason || []).map(function (r) { return '<div>' + esc(r) + '</div>'; }).join('');
    var box = panel();
    box.innerHTML =
      '<button type="button" class="sr-close" onclick="window.IBCm&&window.IBCm.Review&&window.IBCm.Review.hide()" title="关闭">✕</button>'
      + '<h4>购物审核 · 待确认支付</h4>'
      + '<div class="sr-kv"><span class="k">商品</span><span>' + esc(p.title || '—') + '</span></div>'
      + '<div class="sr-kv"><span class="k">价格</span><span>' + esc(p.price != null ? '¥' + p.price : '—') + '</span></div>'
      + '<div class="sr-kv"><span class="k">评分</span><span>' + esc(p.rating != null ? p.rating + ' / 5' : '—') + '</span></div>'
      + '<div class="sr-kv"><span class="k">配送</span><span>' + esc(p.deliveryDays != null ? p.deliveryDays + ' 天' : '—') + '</span></div>'
      + '<div class="sr-kv"><span class="k">SKU</span><span>' + esc(p.sku || '—') + '</span></div>'
      + '<div class="sr-kv"><span class="k">商家</span><span>' + esc(p.merchant || p.domain || '—') + '</span></div>'
      + '<div class="sr-kv"><span class="k">Checkout</span><span>' + esc(co.status || '—') + '<span class="sr-url">' + esc(co.url || '') + '</span></span></div>'
      + '<div class="sr-reason"><b>AI 选择理由</b>' + reasons + '</div>'
      + '<div class="sr-actions">'
      + '<button type="button" class="btn" onclick="window.IBCm&&window.IBCm.Review&&window.IBCm.Review.view()">查看商品</button>'
      + '<button type="button" class="btn" onclick="window.IBCm&&window.IBCm.Review&&window.IBCm.Review.change()">更换候选</button>'
      + '<button type="button" class="btn btn-primary" onclick="window.IBCm&&window.IBCm.Review&&window.IBCm.Review.continueNow()">继续结算</button>'
      + '<button type="button" class="btn" onclick="window.IBCm&&window.IBCm.Review&&window.IBCm.Review.stop()">停止购物</button>'
      + '</div>'
      + '<div id="shopping-review-msg" class="sr-msg"></div>';
  }

  function msg(t) { var m = document.getElementById('shopping-review-msg'); if (m) m.textContent = t; }

  function view() { var rev = current(); if (rev && rev.product && rev.product.url) window.open(rev.product.url, '_blank', 'noopener'); }
  function change() {
    var r = (window.IBCm && window.IBCm.Copilot && window.IBCm.Copilot.change) ? window.IBCm.Copilot.change() : null;
    msg(r && r.halted === false ? '已回到候选比较状态，可继续选择或重新观察。' : '更换失败。');
    hide();
  }
  function continueNow() {
    var r = (window.IBCm && window.IBCm.Copilot && window.IBCm.Copilot.continue) ? window.IBCm.Copilot.continue() : null;
    if (r && r.ok && r.paymentIntent) {
      msg('已将 PaymentIntent 提交给 Bridge Pay Gate 授权；真实支付仍由服务端重算，并需人工确认后才真正扣款。');
    } else {
      msg((r && r.reason) || '继续结算失败。');
    }
  }
  function stop() {
    var r = (window.IBCm && window.IBCm.Copilot && window.IBCm.Copilot.stop) ? window.IBCm.Copilot.stop() : null;
    msg(r && r.halted ? '已停止购物。' : '停止失败。');
    hide();
  }
  function hide() { var el = document.getElementById('shopping-review-panel'); if (el) el.remove(); }
  function current() { return (window.IBCm && window.IBCm.Copilot && window.IBCm.Copilot.review) ? window.IBCm.Copilot.review() : null; }

  window.addEventListener('ib-shopping-review', function (e) { render(e && e.detail); });

  window.IBCm = window.IBCm || {};
  window.IBCm.Review = { render: render, view: view, change: change, continueNow: continueNow, stop: stop, hide: hide };
  NS.expose('review', { render: render, view: view, change: change, continueNow: continueNow, stop: stop, hide: hide });
})(window.IB || (window.IB = {}));
