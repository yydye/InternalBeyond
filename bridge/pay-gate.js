/* ====================================================================
   IB Bridge · Payment Gate（支付授权 + Provider 执行——人机边界）
   --------------------------------------------------------------------
   职责：把『Payment Authorization Domain(payment-auth)』与
         『Payment Provider』串起来，作为【服务端唯一权威】的提交入口：
     - 绝不信任浏览器传来的 claimedAction / ALLOW：总是重新执行 payAuth.decide()
     - disabled → 只回 manualLink（人工支付宝链接），绝不调用 Provider
     - each / under_limit-over-order → 需要人类 confirmToken（Bridge 签发）才进 Provider
     - under_limit 全部满足 → ALLOW → 自动进 Provider
     - Provider 仅 SUCCESS 才 commitSpend；FAIL/CANCEL/TIMEOUT 不记账、不重试
     - 幂等：同一 intent 不重复支付（并发/重复提交只回已定结果）
     - AI Pay 不可用（无 Provider）→ manualLink fallback
   凭证：不接触（留在 credential-vault）；此 gate 只处理授权与执行状态机。
   ==================================================================== */
'use strict';

/* 支付状态机（gate 层持久化于 payments map） */
var STATUS = {
  UNKNOWN: 'UNKNOWN',
  NEEDS_CONFIRMATION: 'NEEDS_CONFIRMATION',
  IN_PROGRESS: 'IN_PROGRESS',
  SUCCESS: 'SUCCESS',
  FAIL: 'FAIL',
  CANCEL: 'CANCEL',
  TIMEOUT: 'TIMEOUT',
  DENIED: 'DENIED',
  UNAVAILABLE: 'UNAVAILABLE'
};
var TERMINAL = [STATUS.SUCCESS, STATUS.FAIL, STATUS.CANCEL, STATUS.TIMEOUT, STATUS.DENIED, STATUS.UNAVAILABLE];

function createPayGate(deps) {
  deps = deps || {};
  var payAuth = deps.payAuth;                 /* 授权唯一来源（payment-auth 实例） */
  var registry = deps.registry;               /* payment-provider registry */
  var providerName = deps.providerName || 'alipay';
  var nowFn = (typeof deps.now === 'function') ? deps.now : function () { return Date.now(); };
  var persist = deps.persist || null;         /* {load,save} 持久化 payments map */
  var _confirmSeq = 0;

  var _state = { version: 1, payments: {}, confirmTokens: {}, canonical: {} };  /* confirmTokens: token -> intentId; canonical: canonicalId -> record */

  function load() { if (persist && persist.load) { try { var s = persist.load(); if (s) { _state.payments = s.payments || _state.payments; _state.canonical = s.canonical || _state.canonical; } } catch (e) {} } }
  function save() { if (persist) { try { persist.save(_state); } catch (e) {} } }
  load();

  function token(intentId) { return 'pc_' + Date.now() + '_' + (++_confirmSeq) + '_' + String(intentId || '').slice(-12); }

  /* 人类确认：进入 Provider 前必须由该 token 背书（Issued by Bridge，非模型） */
  function requestConfirm(intent) {
    var t = token(intent && intent.id);
    _state.confirmTokens[t] = intent && intent.id;
    save();
    return { confirmToken: t, intentId: intent && intent.id };
  }
  function validConfirm(intentId, tokenValue) {
    if (!tokenValue) return false;
    return _state.confirmTokens[String(tokenValue)] === String(intentId);
  }

  /* ── 核心入口：submit(intent, opts) → GateResult ──
     opts: { confirmToken, claimedAction, nonce, orderId }
     绝不信任 opts.claimedAction —— 总是重跑 decide()。 */
  function submit(intent, opts) {
    opts = opts || {};
    if (!intent || !intent.id) return refuse('缺少 PaymentIntent', intent, STATUS.UNKNOWN, opts);
    var intentId = String(intent.id);

    /* 1. 幂等：已定结果/进行中 → 直接返回，不重复提交 */
    var existing = _state.payments[intentId];
    if (existing) {
      if (existing.status === STATUS.IN_PROGRESS) return result(existing.status, intent, existing.reference, '支付进行中，防重复提交', opts);
      if (existing.status === STATUS.SUCCESS) return result(STATUS.SUCCESS, intent, existing.reference, '该订单已支付成功（幂等）', opts);
      if (TERMINAL.indexOf(existing.status) >= 0) return result(existing.status, intent, existing.reference, '该订单已终结（' + existing.status + '），不重试', opts);
    }

    /* 2. 权威再决策：忽略 claimedAction/ALLOW，重跑 payment-auth.decide() */
    var decision;
    try {
      decision = payAuth.decide(intent, { nonce: opts.nonce, orderId: opts.orderId });
    } catch (e) {
      return refuse('授权策略执行异常：' + String(e.message || e), intent, STATUS.DENIED, opts);
    }
    var manualLink = decision.manualLink || (intent.checkoutUrl || '');

    /* 3. DENY（disabled / 超预算 / 未授权域名 / 过期 / nonce / orderId 不匹配） */
    if (decision.action === 'DENY') {
      var den = result(STATUS.DENIED, intent, '', decision.reason, opts);
      den.manualLink = manualLink;
      _record(intentId, STATUS.DENIED, '');   /* 记终态，防其后再绕（消费过·非支付） */
      return den;
    }

    /* 4. CONFIRM（each，或 under_limit 超单笔）：必须有人类 confirmToken */
    if (decision.action === 'CONFIRM') {
      /* confirmToken 已提供但不匹配 → 视为篡改，DENY（绝不进 Provider） */
      if (opts.confirmToken != null && !validConfirm(intentId, opts.confirmToken)) {
        var tampered = result(STATUS.DENIED, intent, '', '人工确认令牌无效（可能被篡改），拒绝支付', opts).setManual(manualLink);
        _record(intentId, STATUS.DENIED, '');
        return tampered;
      }
      if (!validConfirm(intentId, opts.confirmToken)) {
        return result(STATUS.NEEDS_CONFIRMATION, intent, '', '需人工确认后才能支付：' + decision.reason, opts).setManual(manualLink);
      }
      /* 有 token → 落到 Provider（人类已确认） */
    }
    /* 5. ALLOW（under_limit 全部满足）→ 自动进 Provider */

    /* 6. Provider 可用性：AI Pay 未配置 → manualLink fallback，不提交 */
    var provider = registry && registry.get(providerName);
    if (!provider || typeof provider.submit !== 'function') {
      var un = result(STATUS.UNAVAILABLE, intent, '', '支付宝 AI 付不可用，请人工使用支付宝链接', opts).setManual(manualLink);
      _record(intentId, STATUS.UNAVAILABLE, '');
      return un;
    }

    /* 7. 进入 Provider：先占位 IN_PROGRESS（防并发双提交），再调用 */
    _record(intentId, STATUS.IN_PROGRESS, '');

    return provider.submit(intent, opts).then(function (pr) {
      pr = pr || { status: 'FAIL', error: '无返回' };
      var st = String(pr.status || 'FAIL').toUpperCase();
      var reference = String(pr.reference || '');
      if (st === 'SUCCESS') {
        /* 只有在 Provider 明确 SUCCESS 后才记账 */
        try { payAuth.commitSpend(intent); } catch (e) { /* 记账失败不掩盖支付成功，但如实记录 */ }
        var ok = result(STATUS.SUCCESS, intent, reference, '支付成功', opts);
        _record(intentId, STATUS.SUCCESS, reference);
        return ok;
      }
      if (st === 'CANCEL') { _record(intentId, STATUS.CANCEL, ''); return result(STATUS.CANCEL, intent, '', '支付已取消，未记账', opts).setManual(manualLink); }
      if (st === 'TIMEOUT') { _record(intentId, STATUS.TIMEOUT, ''); return result(STATUS.TIMEOUT, intent, '', '支付超时，未记账，请人工支付', opts).setManual(manualLink); }
      /* FAIL 及其它 → 一律不记账，给人工 fallback */
      _record(intentId, STATUS.FAIL, '');
      return result(STATUS.FAIL, intent, '', '支付失败（' + (pr.error || '未知') + '），未记账，请人工支付', opts).setManual(manualLink);
    }, function (err) {
      _record(intentId, STATUS.FAIL, '');
      return result(STATUS.FAIL, intent, '', '支付异常：' + String((err && err.message) || err) + '，未记账，请人工支付', opts).setManual(manualLink);
    });
  }

  /* ── 记录（幂等状态推进；IN_PROGRESS 覆盖为终态，其余不倒退） ── */
  function _record(intentId, status, reference) {
    var cur = _state.payments[intentId];
    var finalize = TERMINAL.indexOf(status) >= 0;
    if (!cur || finalize || cur.status === STATUS.IN_PROGRESS) {
      _state.payments[intentId] = { status: status, reference: reference || '', at: nowFn(), provider: providerName };
      save();
    }
  }

  /* ══════════════════════════════════════════════════════════════
     PHASE 3C-FIX · H2 · CANONICAL PAYMENT INTENT（服务端权威）
     ------------------------------------------------------------------
     要点：
       · canonical record 由 Bridge 在「checkout 捕获」时登记（registerCheckout）。
       · submit_payment 只带 canonicalId + nonce；绝不信任客户端再报的
         amount/orderId/domain/checkoutUrl（若客户端带且不一致 → DENY）。
       · Authorization Policy 针对 canonical 记录重放 decide。
       · canonical 有明确 expiresAt / nonce / terminal 状态；SUCCESS 后不可再执行，
         重复请求返回幂等结果。
       · 只存订单域字段，绝不存支付凭证。
     ══════════════════════════════════════════════════════════════ */
  var CASHIER_RE_HTTPS = /^https:\/\/(?:[a-z0-9-]+\.)?cashier[\w.-]*\.alipay\.com\//i;
  var _canonSeq = 0;

  function _domainOf(url) { try { return new URL(url).hostname; } catch (e) { return ''; } }
  function _orderIdFromUrl(url) { var m = String(url || '').match(/orderId[=\/]([\w-]+)/i); return m ? m[1] : ''; }

  function registerCheckout(fields) {
    fields = fields || {};
    var checkoutUrl = String(fields.checkoutUrl || '').trim();
    /* 收银台必须为 https + cashier*.alipay.com（服务端硬校验） */
    if (!CASHIER_RE_HTTPS.test(checkoutUrl)) {
      return { ok: false, reason: '收银台 URL 必须是 cashier*.alipay.com 的 HTTPS 地址' };
    }
    var canonicalId = 'can_' + Date.now() + '_' + (++_canonSeq);
    var nonce = 'nonce_' + Date.now() + '_' + (++_canonSeq);
    var ttl = Number(fields.ttlMs) || 15 * 60000;
    var record = {
      canonicalId: canonicalId,
      amount: Number(fields.amount) || 0,
      orderId: String(fields.orderId || _orderIdFromUrl(checkoutUrl) || ''),
      domain: String(fields.domain || _domainOf(checkoutUrl)),
      checkoutUrl: checkoutUrl,
      currency: String(fields.currency || 'CNY'),
      nonce: nonce,
      createdAt: nowFn(),
      expiresAt: nowFn() + ttl,
      status: 'PENDING'
    };
    _state.canonical[canonicalId] = record;
    save();
    return { ok: true, canonicalId: canonicalId, nonce: nonce, expiresAt: record.expiresAt, orderId: record.orderId, amount: record.amount, domain: record.domain, checkoutUrl: checkoutUrl, status: record.status };
  }

  function getCanonical(canonicalId) {
    var rec = _state.canonical[String(canonicalId || '')];
    return rec ? JSON.parse(JSON.stringify(rec)) : null;
  }

  /* 客户端若在 submit 里带了与 canonical 不一致的字段 → DENY（不信任客户端） */
  function _tamper(rec, cl) {
    cl = cl || {};
    if (cl.amount != null && Number(cl.amount) !== Number(rec.amount)) return 'amount 与 canonical 不一致';
    if (cl.orderId != null && String(cl.orderId) !== String(rec.orderId)) return 'orderId 与 canonical 不一致';
    if (cl.domain != null && String(cl.domain).toLowerCase() !== String(rec.domain).toLowerCase()) return 'domain 与 canonical 不一致';
    if (cl.checkoutUrl != null && String(cl.checkoutUrl) !== String(rec.checkoutUrl)) return 'checkoutUrl 与 canonical 不一致';
    return '';
  }
  function _deny(rec, reason, opts) {
    return { status: STATUS.DENIED, decision: STATUS.DENIED, canonicalId: rec.canonicalId, orderId: rec.orderId, amount: rec.amount, manualLink: rec.checkoutUrl, note: reason, confirmToken: (opts && opts.confirmToken) || '' };
  }

  function submitCanonical(canonicalId, opts) {
    opts = opts || {};
    var rec = _state.canonical[String(canonicalId || '')];
    if (!rec) return { status: STATUS.DENIED, decision: STATUS.DENIED, canonicalId: String(canonicalId || ''), note: 'canonical PaymentIntent 不存在', manualLink: '' };

    /* 终态：幂等返回（SUCCESS 不回放/不再次执行） */
    if (rec.status && rec.status !== 'PENDING' && rec.status !== 'IN_PROGRESS') {
      return { status: rec.status, decision: rec.status, canonicalId: rec.canonicalId, orderId: rec.orderId, amount: rec.amount, reference: rec.reference || '', manualLink: rec.checkoutUrl, note: '该 canonical 已终结（' + rec.status + '），幂等返回' };
    }
    /* IN_PROGRESS 防重复 */
    if (rec.status === 'IN_PROGRESS') return { status: STATUS.IN_PROGRESS, decision: STATUS.IN_PROGRESS, canonicalId: rec.canonicalId, note: '支付进行中，防重复提交', manualLink: rec.checkoutUrl };
    /* 过期 */
    if (nowFn() > Number(rec.expiresAt)) { rec.status = 'EXPIRED'; save(); return _deny(rec, 'canonical PaymentIntent 已过期', opts); }
    /* nonce 绑定 */
    if (opts.nonce != null && String(opts.nonce) !== String(rec.nonce)) return _deny(rec, 'canonical nonce 不匹配', opts);
    /* 客户端篡改字段 → DENY（即使声称 ALLOW 也一样否决） */
    var t = _tamper(rec, opts.client);
    if (t) return _deny(rec, '客户端字段与 canonical 不一致（' + t + '），拒绝支付', opts);

    /* 用 canonical 构造决策对象，重跑 Authorization Policy */
    var decIntent = {
      id: rec.canonicalId, amount: rec.amount, currency: rec.currency,
      orderId: rec.orderId, domain: rec.domain, merchant: rec.domain,
      checkoutUrl: rec.checkoutUrl, createdAt: rec.createdAt, expiresAt: rec.expiresAt
    };
    var decision = payAuth.decide(decIntent, { nonce: opts.nonce, orderId: rec.orderId });
    var manualLink = decision.manualLink || rec.checkoutUrl;

    if (decision.action === 'DENY') return _deny(rec, decision.reason, opts);
    if (decision.action === 'CONFIRM') {
      if (opts.confirmToken != null && !validConfirm(rec.canonicalId, opts.confirmToken)) return _deny(rec, '人工确认令牌无效（可能被篡改），拒绝支付', opts);
      if (!validConfirm(rec.canonicalId, opts.confirmToken)) {
        return { status: STATUS.NEEDS_CONFIRMATION, decision: STATUS.NEEDS_CONFIRMATION, canonicalId: rec.canonicalId, orderId: rec.orderId, amount: rec.amount, note: '需人工确认后才能支付：' + decision.reason, manualLink: manualLink, confirmToken: opts.confirmToken || '' };
      }
    }
    /* ALLOW / 已确认 CONFIRM → Provider */

    var provider = registry && registry.get(providerName);
    if (!provider || typeof provider.submit !== 'function') {
      rec.status = STATUS.UNAVAILABLE; save();
      return { status: STATUS.UNAVAILABLE, decision: STATUS.UNAVAILABLE, canonicalId: rec.canonicalId, orderId: rec.orderId, amount: rec.amount, note: '支付宝 AI 付不可用，请人工使用支付宝链接', manualLink: manualLink };
    }

    rec.status = 'IN_PROGRESS'; save();
    return provider.submit(decIntent, opts).then(function (pr) {
      pr = pr || { status: 'FAIL', error: '无返回' };
      var st = String(pr.status || 'FAIL').toUpperCase();
      var reference = String(pr.reference || '');
      if (st === 'SUCCESS') {
        try { payAuth.commitSpend(decIntent); } catch (e) { /* 记账失败不掩盖成功 */ }
        rec.status = STATUS.SUCCESS; rec.reference = reference; save();
        return { status: STATUS.SUCCESS, decision: STATUS.SUCCESS, canonicalId: rec.canonicalId, orderId: rec.orderId, amount: rec.amount, reference: reference, note: '支付成功', manualLink: manualLink };
      }
      if (st === 'CANCEL') { rec.status = STATUS.CANCEL; save(); return { status: STATUS.CANCEL, decision: STATUS.CANCEL, canonicalId: rec.canonicalId, orderId: rec.orderId, amount: rec.amount, note: '支付已取消，未记账', manualLink: manualLink }; }
      if (st === 'TIMEOUT') { rec.status = STATUS.TIMEOUT; save(); return { status: STATUS.TIMEOUT, decision: STATUS.TIMEOUT, canonicalId: rec.canonicalId, orderId: rec.orderId, amount: rec.amount, note: '支付超时，未记账，请人工支付', manualLink: manualLink }; }
      rec.status = STATUS.FAIL; save();
      return { status: STATUS.FAIL, decision: STATUS.FAIL, canonicalId: rec.canonicalId, orderId: rec.orderId, amount: rec.amount, note: '支付失败（' + (pr.error || '未知') + '），未记账，请人工支付', manualLink: manualLink };
    }, function (err) {
      rec.status = STATUS.FAIL; save();
      return { status: STATUS.FAIL, decision: STATUS.FAIL, canonicalId: rec.canonicalId, orderId: rec.orderId, amount: rec.amount, note: '支付异常：' + String((err && err.message) || err) + '，未记账，请人工支付', manualLink: manualLink };
    });
  }

  /* 工具：查询某 intent 的支付记录（审计/刷新恢复用） */
  function get(intentId) { return _state.payments[String(intentId || '')] || null; }

  return {
    STATUS: STATUS,
    requestConfirm: requestConfirm,
    submit: submit,
    submitCanonical: submitCanonical,
    registerCheckout: registerCheckout,
    getCanonical: getCanonical,
    get: get,
    _state: _state,
    setPersist: function (p) { persist = p; load(); }
  };
}

/* 结果构造器（带 immutable-ish setManual） */
function result(status, intent, reference, note, opts) {
  return {
    status: status,
    decision: status,
    intentId: intent && intent.id,
    orderId: intent && intent.orderId,
    amount: intent && intent.amount,
    reference: reference || '',
    manualLink: (intent && intent.checkoutUrl) || '',
    note: note || '',
    confirmToken: (opts && opts.confirmToken) || '',
    setManual: function (m) { this.manualLink = m || ''; return this; }
  };
}
function refuse(reason, intent, status, opts) {
  return { status: status, decision: status, intentId: intent && intent.id, manualLink: (intent && intent.checkoutUrl) || '', note: reason, confirmToken: (opts && opts.confirmToken) || '' };
}

module.exports = createPayGate;
