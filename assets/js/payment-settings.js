/* ============================================================
 * IB Pay Authorization Settings UI（Phase 2C）
 * --------------------------------------------------------------------
 * 渲染「支付授权」设置卡（#pay-auth-settings）。只读写 Bridge 权威策略：
 *   - 读取：IBCm.Payment.config() → bridge.pay_get_config（模式/限额/剩余）
 *   - 写入：IBCm.Payment.setConfig(cfg) → bridge.pay_set_config
 * 安全边界说明：本 UI 只是「写策略」的入口；真正的 Authorization Policy
 * 由 23115 Bridge 的 pay-gate 独立重算（payment-auth.decide），
 * 页面提交的任何 claimedAction / ALLOW 都不会被 Bridge 信任。
 * 本文件不接触任何支付凭证/钱包绑定，不入 DOM 敏感值。
 * 样式仅用现有 API 设置类 + social.css 的 pay-auth-* 类（零内联 style）。
 * ============================================================ */
(function (NS) {
  'use strict';

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

  var MODES = [
    { value: 'disabled', label: '关闭 AI 付款', hint: 'AI 不得付款，只返回人工支付宝支付链接（manualLink）' },
    { value: 'each', label: '单笔授权', hint: 'AI 可发起，但每一笔都必须进入确认卡，人工确认后才支付' },
    { value: 'under_limit', label: '限额内免确认', hint: '全部限制满足时自动支付；超单笔→确认，超每日/域名→拒绝' }
  ];

  function el(id) { return document.getElementById(id); }
  function qs(root, sel) { return root ? root.querySelector(sel) : null; }

  function render() {
    var box = el('pay-auth-settings');
    if (!box) return;
    var api = (typeof window.IBCm !== 'undefined' && window.IBCm.Payment) ? window.IBCm.Payment : null;
    if (!api) { box.innerHTML = '<div class="field-note-inline">支付模块未加载（commerce-adapter 缺失）。</div>'; return; }

    box.innerHTML = '<div class="field-note-inline">正在读取 Bridge 授权策略…</div>';
    Promise.resolve(api.config()).then(function (r) {
      if (!r || !r.ok || !r.data) {
        box.innerHTML = '<div class="field-note-inline">无法读取（需先启用后端连接 &amp; 后端工具，并确认 23115 Bridge 在线）。</div>';
        return;
      }
      var cfg = r.data.config || {};
      var b = r.data.budget || {};
      var mode = cfg.mode || 'disabled';
      var rows = MODES.map(function (m) {
        var checked = m.value === mode ? ' checked' : '';
        return '<label class="ibtools-sw pay-auth-row">'
          + '<input type="radio" name="pay-auth-mode" value="' + m.value + '"' + checked + ' class="u-native-check" data-ibm="' + m.value + '">'
          + '<span><b>' + esc(m.label) + '</b><span class="mi-sub-hint">' + esc(m.hint) + '</span></span></label>';
      }).join('');

      box.innerHTML =
        '<div class="pay-auth-rows">' + rows + '</div>'
        + '<div class="api-form-group"><label>单笔上限（元）</label><input data-ibf="perOrderLimit" class="ib-num" type="number" min="0" value="' + esc(cfg.perOrderLimit != null ? cfg.perOrderLimit : '') + '"></div>'
        + '<div class="api-form-group"><label>每日上限（元）</label><input data-ibf="dailyLimit" class="ib-num" type="number" min="0" value="' + esc(cfg.dailyLimit != null ? cfg.dailyLimit : '') + '"></div>'
        + '<div class="api-form-group"><label>允许域名（逗号分隔，严格 HTTPS 域名匹配）</label><input data-ibf="allowedDomains" type="text" value="' + esc((cfg.allowedDomains || []).join(', ')) + '" placeholder="alipay.com, cashier.alipay.com"></div>'
        + '<div class="pay-auth-status">当前授权状态：<b>' + esc(mode === 'disabled' ? '关闭（仅人工链接）' : mode === 'each' ? '单笔授权（每笔确认）' : '限额内免确认') + '</b>'
        + ' · 今日已花 <b>' + esc(b.spent != null ? b.spent : 0) + '</b> / ' + esc(b.dailyLimit != null ? b.dailyLimit : '—')
        + ' · 剩余 <b>' + esc(b.remaining != null ? b.remaining : '—') + '</b></div>'
        + '<div class="api-actions"><button type="button" class="btn btn-primary" onclick="window.IBCm&&window.IBCm.PaySettings&&window.IBCm.PaySettings.save()">保存授权策略</button></div>'
        + '<div id="pay-auth-msg" class="field-note-inline"></div>';
    }).catch(function (e) {
      box.innerHTML = '<div class="field-note-inline">读取失败：' + esc((e && e.message) || e) + '</div>';
    });
  }

  function save() {
    var box = el('pay-auth-settings');
    var msg = el('pay-auth-msg');
    var api = (typeof window.IBCm !== 'undefined' && window.IBCm.Payment) ? window.IBCm.Payment : null;
    if (!api) return;
    var modeSel = box ? box.querySelector('input[name="pay-auth-mode"]:checked') : null;
    var cfg = {
      mode: modeSel ? modeSel.value : 'disabled',
      perOrderLimit: Number(qs(box, '[data-ibf="perOrderLimit"]') && qs(box, '[data-ibf="perOrderLimit"]').value) || undefined,
      dailyLimit: Number(qs(box, '[data-ibf="dailyLimit"]') && qs(box, '[data-ibf="dailyLimit"]').value) || undefined,
      allowedDomains: (qs(box, '[data-ibf="allowedDomains"]') && qs(box, '[data-ibf="allowedDomains"]').value || '').split(',')
        .map(function (s) { return s.trim(); }).filter(Boolean)
    };
    if (msg) { msg.textContent = '保存中…'; }
    Promise.resolve(api.setConfig(cfg)).then(function (r) {
      if (msg) msg.textContent = r && r.ok ? '✓ 已保存（模式=' + ((r.data && r.data.config && r.data.config.mode) || '') + '）' : ('保存失败：' + (r && (r.reason || r.error) || '未知'));
      render();
    }).catch(function (e) { if (msg) msg.textContent = '保存失败：' + ((e && e.message) || e); });
  }

  window.IBCm = window.IBCm || {};
  window.IBCm.PaySettings = { render: render, save: save };
  NS.expose('paySettings', { render: render, save: save });

  /* Boot：等 DOM + 后端工具就绪后首渲染 */
  if (document.readyState !== 'loading') render();
  else document.addEventListener('DOMContentLoaded', render);

  /* 监听后端连接状态：连接成功、工具目录就绪时自动重绘，
     避免“页面先启动、后端晚 1s+ 才连上 → 卡片永远停在‘无法读取’”的假象。
     仅监听 ib-net-tools（连接/重连/切换工具目录时派发），而非高频的消息/推送事件，
     以免在用户编辑表单时被面板重绘清掉输入。 */
  (function () {
    try {
      document.addEventListener('ib-net-tools', function () {
        var box = el('pay-auth-settings');
        if (!box) return;
        /* 已渲染出完整配置（非加载中/错误占位）则不打扰，避免重连时覆盖用户编辑 */
        if (box.querySelector('.pay-auth-rows')) return;
        try { render(); } catch (e) {}
      });
    } catch (e) {}
  })();
})(window.IB || (window.IB = {}));
