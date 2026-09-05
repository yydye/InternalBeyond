/*************************************************************
 * ====================================================================
 *   IB Active · Payment Authorization Domain（Phase 2A：AI 付权限系统）
 *   --------------------------------------------------------------------
 *   定位：只实现「授权策略」——判断一笔 PaymentIntent 是
 *         DENY / CONFIRM / ALLOW。不接真实支付宝执行（那是 Phase 2B Provider）。
 *   Pipeline：
 *     PaymentIntent → AuthorizationPolicy → DENY / CONFIRM / ALLOW → PaymentProvider(2B)
 *
 *   三种模式：
 *     disabled    AI 不得付款，只允许生成/返回人工支付宝付款链接（deny + manualLink）
 *     each        AI 可发起，但每笔必须进 pendingConfirm（confirm）
 *     under_limit 全部限制满足（perOrderLimit/dailyLimit/allowedDomains）→ allow；
 *                 否则 confirm（超单笔）或 deny（超日预算/域名/过期/nonce 不匹配/非法）
 *
 *   边界（铁律）：
 *     · 零 Harness / 零 ModelPort：不 require node-model-port / node-model-compat /
 *       ib-model-core / agent-runtime；纯逻辑，无 fetch/DOM。
 *     · 不引入支付凭证：wallet token / 应用凭证留在 active/credential-vault.js，
 *       本模块永不接触，绝不进 prompt。
 *     · 权威可重放：本模块是纯函数 + 注入持久化 —— Bridge 侧必须再次执行 decide，
 *       浏览器端只做展示投影，不是最终安全边界。
 *     · dailyLimit 基于持久化 ledger（注入 load/save），不是内存变量。
 *     · allowedDomains 严格 HTTPS 域名匹配（host 精确或 .allow 后缀，禁止字符串 contains）。
 *
 *   加载方式（UMD 双载，与 reply-chain-core/payment 同款）：
 *     - 浏览器：<script src="active/payment-auth.js"> → window.IBPaymentAuth
 *     - Node   ：require('../active/payment-auth.js') → createPaymentAuth（Bridge 权威执行）
 *   ====================================================================
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.IBPaymentAuth = factory();
    root.IB = root.IB || {};
    root.IB.payAuth = root.IBPaymentAuth;
  }
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  var MODES = ['disabled', 'each', 'under_limit'];
  var DEFAULT_TTL_MS = 15 * 60 * 1000;   /* intent 默认 15 分钟有效 */
  var DEFAULT_CURRENCY = 'CNY';
  var DEFAULT_LIMIT = 500;

  function nowOf(deps) { return (typeof deps.now === 'function') ? deps.now : function () { return Date.now(); }; }
  function todayKey(ms) {
    var d = new Date(Number(ms) || Date.now());
    return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
  }
  function num(v, fb) { var n = Number(v); return Number.isFinite(n) && n >= 0 ? n : fb; }

  /* ── 严格 HTTPS 域名匹配：host 精确 或 以 .allow 结尾（禁止字符串 contains） ──
     例如 allow='alipay.com'：cashieruser.alipay.com ✔、evil-alipay.com ✘、alipay.com.cn ✘。 */
  function matchDomain(rawUrl, allowed) {
    var u;
    try { u = new URL(String(rawUrl || '')); } catch (e) { return { ok: false, reason: 'URL 无效' }; }
    if (u.protocol !== 'https:') return { ok: false, reason: '仅允许 HTTPS（收到 ' + (u.protocol || '?') + '）' };
    var host = String(u.hostname || '').toLowerCase();
    if (!host) return { ok: false, reason: '缺少域名' };
    var list = (allowed || []).map(function (x) { return String(x || '').toLowerCase().trim(); }).filter(Boolean);
    for (var i = 0; i < list.length; i++) {
      var a = list[i];
      if (host === a || host.slice(-(a.length + 1)) === '.' + a) return { ok: true, host: host, allow: a };
    }
    return { ok: false, reason: '域名不在授权列表：' + host, host: host };
  }

  function createPaymentAuth(deps) {
    deps = deps || {};
    var _now = nowOf(deps);
    var _persist = deps.persist || null;   /* { load(): state, save(state) } */
    var _nonceSeq = 0;

    var _state = {
      version: 1,
      config: { mode: 'disabled', perOrderLimit: DEFAULT_LIMIT, dailyLimit: DEFAULT_LIMIT, allowedDomains: [], currency: DEFAULT_CURRENCY },
      ledger: {}        /* dayKey -> spent 金额（持久化） */
    };

    function save() { if (_persist) { try { _persist.save(_state); } catch (e) { /* 持久化失败不阻断决策 */ } } }
    function load() { if (_persist && _persist.load) { try { var s = _persist.load(); if (s) _state = Object.assign(_state, s); } catch (e) { /* 载入失败用默认 */ } } }

    /* 惰性：构造即载入一份已有 ledger（保证「持久化后重新加载仍正确」） */
    load();

    function dayKey() { return todayKey(_now()); }
    function spentToday() { return num(_state.ledger[dayKey()], 0); }

    /* ── 配置（授权配置与支付凭证分离：此处仅授权，无凭证） ── */
    function setConfig(cfg) {
      cfg = cfg || {};
      if (MODES.indexOf(cfg.mode) >= 0) _state.config.mode = cfg.mode;
      if (cfg.perOrderLimit != null) _state.config.perOrderLimit = num(cfg.perOrderLimit, DEFAULT_LIMIT);
      if (cfg.dailyLimit != null) _state.config.dailyLimit = num(cfg.dailyLimit, DEFAULT_LIMIT);
      if (cfg.currency) _state.config.currency = String(cfg.currency);
      if (Array.isArray(cfg.allowedDomains)) _state.config.allowedDomains = cfg.allowedDomains.map(function (d) { return String(d || '').trim(); }).filter(Boolean);
      if (cfg.ttlMs != null) _state.config.ttlMs = num(cfg.ttlMs, DEFAULT_TTL_MS);
      save();
      return getConfig();
    }
    function getConfig() {
      return {
        mode: _state.config.mode,
        perOrderLimit: _state.config.perOrderLimit,
        dailyLimit: _state.config.dailyLimit,
        allowedDomains: _state.config.allowedDomains.slice(),
        currency: _state.config.currency,
        ttlMs: _state.config.ttlMs || DEFAULT_TTL_MS
      };
    }

    /* ── PaymentIntent 工厂 ──
       必须绑定：amount/currency/orderId/merchant(domain)/checkoutUrl/createdAt/expiresAt/id(nonce)。 */
    function newIntent(fields) {
      fields = fields || {};
      var createdAt = Number(fields.createdAt) || _now();
      var ttl = Number(fields.ttlMs) || _state.config.ttlMs || DEFAULT_TTL_MS;
      return {
        id: String(fields.id || ('pi_' + Date.now() + '_' + (++_nonceSeq))),   /* intent nonce */
        amount: num(fields.amount, 0),
        currency: String(fields.currency || _state.config.currency || DEFAULT_CURRENCY),
        orderId: String(fields.orderId || ''),
        domain: String(fields.domain || fields.merchant || ''),
        merchant: String(fields.merchant || fields.domain || ''),
        checkoutUrl: String(fields.checkoutUrl || ''),
        createdAt: createdAt,
        expiresAt: createdAt + ttl
      };
    }

    /* ── 核心：decide(intent, attempt) → {action:'DENY'|'CONFIRM'|'ALLOW', ...} ──
       attempt（可空）：{ nonce, orderId, amount } —— nonce/orderId 不匹配直接 DENY。
       ★ 纯函数 + 只读持久化，Bridge 可重复执行出同一结论。 */
    function decide(intent, attempt) {
      attempt = attempt || {};
      var cfg = getConfig();
      var checks = [];
      var now = _now();
      var amount = num(intent && intent.amount, 0);
      var domain = String((intent && (intent.domain || intent.merchant)) || '');
      var checkout = String((intent && intent.checkoutUrl) || '');

      /* 1. 结构合法性 */
      if (!intent || !String(intent.orderId || '').trim()) return deny('缺少 orderId', checks, intent, cfg, true);
      if (!domain) return deny('缺少 merchant/domain', checks, intent, cfg, true);
      if (!checkout) return deny('缺少 checkoutUrl', checks, intent, cfg, true);
      if (amount <= 0) return deny('金额必须 > 0', checks, intent, cfg, true);

      /* 2. 过期 */
      if (Number(intent.expiresAt) && now > Number(intent.expiresAt)) {
        return deny('PaymentIntent 已过期', checks, intent, cfg, true);
      }

      /* 3. intent nonce / orderId 绑定（attempt 必须与 intent 一致） */
      if (attempt.nonce && String(attempt.nonce) !== String(intent.id || '')) {
        return deny('intent nonce 不匹配', checks, intent, cfg, true);
      }
      if (attempt.orderId && String(attempt.orderId) !== String(intent.orderId)) {
        return deny('orderId 不匹配', checks, intent, cfg, true);
      }

      /* 4. disabled：绝不 ALLOW；只返回人工支付链接 */
      if (cfg.mode === 'disabled') {
        checks.push({ name: 'mode', ok: true, value: 'disabled', note: 'AI 不得付款' });
        return {
          action: 'DENY', reason: '支付已禁用（disabled）：AI 不得付款，只提供人工链接',
          manualLink: checkout, needsConfirm: false, intent: intent, checks: checks
        };
      }

      /* 5. each：每笔都必须进 pendingConfirm */
      if (cfg.mode === 'each') {
        checks.push({ name: 'mode', ok: true, value: 'each', note: '每笔需人工确认' });
        return {
          action: 'CONFIRM', reason: 'each 模式：每笔需进入确认卡', manualLink: checkout,
          needsConfirm: true, intent: intent, checks: checks
        };
      }

      /* 6. under_limit：域名/单笔/日预算 */
      var dm = matchDomain(checkout, cfg.allowedDomains);
      checks.push({ name: 'domain', ok: dm.ok, value: dm.host || checkout, note: dm.reason });
      if (!dm.ok) return deny('未授权域名（' + dm.reason + '）', checks, intent, cfg, true);

      var orderOk = amount <= cfg.perOrderLimit;
      checks.push({ name: 'perOrderLimit', ok: orderOk, value: amount + '/' + cfg.perOrderLimit, note: orderOk ? '' : '超单笔上限' });

      var dailyOk = (spentToday() + amount) <= cfg.dailyLimit;
      checks.push({ name: 'dailyLimit', ok: dailyOk, value: (spentToday() + amount) + '/' + cfg.dailyLimit, note: dailyOk ? '' : '超日预算' });

      if (!dailyOk) return deny('超出单日预算（' + (spentToday() + amount) + '/' + cfg.dailyLimit + '）', checks, intent, cfg, true);
      if (!orderOk) {
        return {
          action: 'CONFIRM', reason: '超单笔上限（' + amount + '/' + cfg.perOrderLimit + '），需人工确认',
          manualLink: checkout, needsConfirm: true, intent: intent, checks: checks
        };
      }
      return { action: 'ALLOW', reason: '授权通过', manualLink: '', needsConfirm: false, intent: intent, checks: checks };
    }

    function deny(reason, checks, intent, cfg, include) {
      return { action: 'DENY', reason: reason, manualLink: (intent && intent.checkoutUrl) || '', needsConfirm: false, intent: intent, checks: checks };
    }

    /* ── Ledger（持久化日预算；Phase 2B Provider 成功后在此记账） ── */
    function ledger() {
      return { dayKey: dayKey(), spent: spentToday(), dailyLimit: _state.config.dailyLimit, remaining: Math.max(0, _state.config.dailyLimit - spentToday()) };
    }
    function commitSpend(intent) {
      var amt = num(intent && intent.amount, 0);
      var k = dayKey();
      _state.ledger[k] = num(_state.ledger[k], 0) + amt;
      save();
      return ledger();
    }
    function resetDaily() { _state.ledger[dayKey()] = 0; save(); return ledger(); }

    return {
      MODES: MODES,
      MATCH: matchDomain,
      setConfig: setConfig,
      getConfig: getConfig,
      newIntent: newIntent,
      decide: decide,
      ledger: ledger,
      commitSpend: commitSpend,
      resetDaily: resetDaily,
      now: _now
    };
  }

  return {
    MODES: MODES,
    matchDomain: matchDomain,
    createPaymentAuth: createPaymentAuth
  };
});
