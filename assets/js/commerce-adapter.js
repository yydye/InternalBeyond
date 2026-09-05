/* ============================================================
 * IB Commerce Adapter — Phase 1 只读购物接入（薄）
 * --------------------------------------------------------------------
 * 职责（只做两件事，其余全在 active/commerce.js Domain 与 IBMCP）：
 *   1. 注册本地 Playwright MCP 为 IBMCP 的一个 server（mcp.shopping.*）：
 *        IBCm.registerShoppingServer('http://127.0.0.1:8931')
 *   2. 包一层 window.IBMCP.execOp：任何 mcp.shopping.* 调用完成后，
 *      把结果喂给 IBCommerce.observeToolResult（推进状态机/预算/捕获收银台URL），
 *      并在返回文本末尾附一行【购物会话】状态，让模型经既有工具结果回注通道看到。
 *   本模块不做底层浏览器通信（那是 Playwright MCP），不做支付（Phase 1 禁用）。
 * ============================================================ */
(function (NS) {
  'use strict';

  var NS_ALIAS_DEFAULT = 'shopping';
  var _hintsInjected = false;

  /* H1：真实页面必须持有真正 create() 出来的 Commerce Domain 实例，
     而不是 UMD namespace（其只有 create/LIMITS/STAGES/PAYMENT_BOUNDARY，无实例方法）。 */
  var _instance = null;
  function domain() {
    if (_instance) return _instance;
    if (typeof window.IBCommerce === 'undefined') return null;
    var f = window.IBCommerce;
    if (typeof f.create === 'function') { _instance = f.create({}); }
    else if (typeof f === 'function') { _instance = f({}); }  /* 兼容：若导出本身是工厂函数 */
    return _instance || null;
  }

  /* ── 1. 注册 Playwright MCP 为 IBMCP server（纯配置，兼容现有 ib_mcp_cfg） ── */
  function registerShoppingServer(url, opts) {
    opts = opts || {};
    if (typeof window.IBMCP === 'undefined' || !window.IBMCP) {
      return { ok: false, reason: 'IBMCP 未加载（integrations.js 缺失）' };
    }
    var alias = opts.alias || NS_ALIAS_DEFAULT;
    var cfg = window.IBMCP.cfg();
    if (cfg.enabled === undefined) cfg.enabled = true;
    if (cfg.confirm === undefined) cfg.confirm = true;   /* 购物/外链动作默认要确认 */
    var existing = cfg.servers.find(function (s) { return s.alias === alias; });
    if (existing) {
      if (url) existing.url = url;
      existing.enabled = existing.enabled !== false;
    } else {
      cfg.servers.push({
        alias: alias,
        url: String(url || '').trim(),
        enabled: true,
        tools: [],
        maxRounds: opts.maxRounds || 5
      });
    }
    window.IBMCP.save(cfg);

    /* 尽力同步发现工具（失败不阻断注册：用户可在 MCP 设置页手动连接） */
    var discovered = 0, error = '';
    if (typeof window.IBMCP.connect === 'function' && url) {
      return window.IBMCP.connect(alias).then(function (n) {
        discovered = Number(n) || 0;
        return { ok: true, alias: alias, toolCount: discovered };
      }).catch(function (e) {
        error = String((e && e.message) || e);
        return { ok: false, alias: alias, reason: '注册成功但连接失败：' + error };
      });
    }
    return Promise.resolve({ ok: true, alias: alias, toolCount: 0 });
  }

  /* ── 2. 观察 mcp.shopping.* 调用结果 → 回灌 Domain + 附状态提示 ── */
  function wrapExecOp() {
    if (typeof window.IBMCP === 'undefined' || !window.IBMCP) return;
    if (window.IBMCP.__commerceWrapped) return;
    var proto = window.IBMCP;
    var orig = proto.execOp;
    if (typeof orig !== 'function') return;

    proto.execOp = function (name, args) {
      return Promise.resolve(orig.call(proto, name, args)).then(function (res) {
        res = res || { ok: false, reason: '空结果', response: '', images: [] };
        try {
          var d = domain();
          if (d && String(name || '').indexOf('mcp.') === 0) {
            /* 3A/3B：若 Shopping Agent 已启动，走 agentObserve（推进决策环，触发 REVIEW）；否则走旧观察管线 */
            var agentActive = false;
            try { if (typeof d.agentSnapshot === 'function') agentActive = !!(d.agentSnapshot() || {}).active; } catch (e) {}
            if (agentActive && typeof d.agentObserve === 'function') {
              var out = d.agentObserve(name, args || {}, res);
              maybeRenderReview(d, out);
            } else if (typeof d.observeToolResult === 'function') {
              d.observeToolResult(name, args || {}, res);
            }
            var hint = d.statusBlock ? d.statusBlock() : '';
            if (hint) {
              res.response = String(res.response || '') +
                (res.response ? '\n\n' : '') + '\n【购物会话】 ' + hint;
              /* 3E：购物模式下注入一次淘宝执行经验（SPA SKU/收银台跳转/禁支付页合成点击） */
              if (agentActive && typeof window.IBShopExec !== 'undefined' && window.IBShopExec.hintsBlock && !_hintsInjected) {
                _hintsInjected = true;
                res.response += '\n' + window.IBShopExec.hintsBlock();
              }
            }
          }
        } catch (e) { /* 观测失败绝不阻断工具本身 */ }
        return res;
      });
    };
    proto.__commerceWrapped = true;
  }

  /* ── 3B/3C：agent 到 REVIEW 后，把 checkout 登记为 Bridge canonical + 派发事件 ── */
  function maybeRenderReview(d, out) {
    try {
      if (d && typeof d.agentReview === 'function') {
        var rev = d.agentReview();
        /* 3C-H2：在 Bridge 登记 canonical PaymentIntent（订单域字段，无凭证），
           并把 canonicalId/nonce 回写 Domain，后续 submit 只凭 canonicalId。 */
        if (rev && rev.ok && rev.paymentIntent && window.IBCm && window.IBCm.Payment && window.IBCm.Payment.registerCheckout) {
          var pi = rev.paymentIntent;
          window.IBCm.Payment.registerCheckout({ amount: pi.amount, orderId: pi.orderId, domain: pi.domain || pi.merchant, checkoutUrl: pi.checkoutUrl, currency: pi.currency })
            .then(function (r) {
              if (r && r.ok && d.agentSetCanonical) { d.agentSetCanonical(r.canonicalId, r.nonce); }
            });
        }
        if (rev && rev.ok) window.dispatchEvent(new CustomEvent('ib-shopping-review', { detail: rev }));
      }
    } catch (e) { /* ignore */ }
  }

  /* ── 3. 状态查看（控制台/宿主） ── */
  function status() {
    var d = domain();
    return d ? d.current() : null;
  }
  function statusBlock() {
    var d = domain();
    return d ? d.statusBlock() : '';
  }

  /* ── 4. Payment helpers：构造 PaymentIntent 并调用 Bridge 工具 ──
     ★ 安全边界在 Bridge（pay-gate 独立重算 decide）。这些只是「客户端」便捷入口，
       bridge.submit_payment / pay_request_confirm / pay_*_config 都由 Bridge 权威执行。 */
  function intentAuthInstance() {
    try { return (typeof window.IBPaymentAuth !== 'undefined') ? window.IBPaymentAuth.createPaymentAuth() : null; }
    catch (e) { return null; }
  }
  /* 由商品/收银台信息构造 PaymentIntent（含 id/nonce/expiry；不含任何凭证） */
  function buildIntent(fields) {
    fields = fields || {};
    var inst = intentAuthInstance();
    var base = {
      amount: fields.amount,
      orderId: fields.orderId,
      domain: fields.domain || fields.merchant,
      merchant: fields.merchant,
      checkoutUrl: fields.checkoutUrl,
      currency: fields.currency
    };
    return inst ? inst.newIntent(base) : Object.assign({
      id: 'pi_' + Date.now(), amount: fields.amount, currency: fields.currency || 'CNY',
      orderId: fields.orderId || '', domain: fields.domain || '', merchant: fields.merchant || '',
      checkoutUrl: fields.checkoutUrl || '', createdAt: Date.now(), expiresAt: Date.now() + 15 * 60000
    }, base);
  }
  function netTool(name, args) {
    if (typeof window.IBNET === 'undefined' || !window.IBNET) return { ok: false, reason: 'Bridge 连接未启用' };
    return window.IBNET.execOp(name, args || {});
  }
  function submitPayment(canonicalId, opts) { return netTool('submit_payment', Object.assign({ canonicalId: canonicalId }, opts || {})); }
  function registerCheckout(fields) { return netTool('pay_register_checkout', { fields: fields || {} }); }
  function requestConfirm(intent) { return netTool('pay_request_confirm', { intent: intent }); }
  function getConfig() { return netTool('pay_get_config', {}); }
  function setConfig(cfg) { return netTool('pay_set_config', cfg || {}); }
  /* 客户端展示投影（信息性）：显示本地策略会给出什么，非安全依据 */
  function localDecision(intent) {
    var inst = intentAuthInstance();
    if (!inst) return null;
    try { return inst.decide(intent); } catch (e) { return null; }
  }

  /* ── 3B Copilot 便捷入口（读取/接管 Shopping Review） ── */
  function copilotReview() { var d = domain(); return (d && typeof d.agentReview === 'function') ? d.agentReview() : { ok: false, reason: '无 agent' }; }
  function copilotContinue() {
    var d = domain();
    var r = (d && typeof d.agentContinue === 'function') ? d.agentContinue() : { ok: false, reason: '无 agent' };
    /* 继续结算：只凭 canonicalId+nonce 交给 Bridge pay-gate（真实支付由 Bridge 依据 canonical 独立重算，UI 不能声明 ALLOW） */
    if (r && r.ok && r.canonicalId && window.IBCm && window.IBCm.Payment) {
      r.bridgeSubmit = window.IBCm.Payment.submit(r.canonicalId, { nonce: r.nonce || '' });
    }
    return r;
  }
  function copilotChange(id) { var d = domain(); return (d && typeof d.agentChangeCandidate === 'function') ? d.agentChangeCandidate(id) : null; }
  function copilotStop() { var d = domain(); return (d && typeof d.agentStop === 'function') ? d.agentStop() : null; }
  function copilotSnapshot() { var d = domain(); return (d && typeof d.agentSnapshot === 'function') ? d.agentSnapshot() : null; }

  function boot() {
    wrapExecOp();
  }

  /* 双挂载 + IB 命名空间 */
  window.IBCm = {
    registerShoppingServer: registerShoppingServer,
    status: status,
    statusBlock: statusBlock,
    domain: domain,
    Payment: {
      buildIntent: buildIntent,
      submit: submitPayment,
      registerCheckout: registerCheckout,
      requestConfirm: requestConfirm,
      config: getConfig,
      setConfig: setConfig,
      decide: localDecision
    },
    Copilot: {
      review: copilotReview,
      continue: copilotContinue,
      change: copilotChange,
      stop: copilotStop,
      snapshot: copilotSnapshot
    }
  };
  NS.expose('commerce', {
    registerShoppingServer: registerShoppingServer,
    status: status,
    statusBlock: statusBlock,
    domain: domain,
    Payment: {
      buildIntent: buildIntent,
      submit: submitPayment,
      requestConfirm: requestConfirm,
      config: getConfig,
      setConfig: setConfig,
      decide: localDecision
    }
  });
  boot();
})(window.IB || (window.IB = {}));
