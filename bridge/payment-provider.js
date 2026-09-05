/* ====================================================================
   IB Bridge · Payment Provider abstraction（Provider 接口 + 注册表）
   --------------------------------------------------------------------
   Provider 契约：
     { name: string,
       submit(intent, opts) -> Promise<ProviderResult> }
   ProviderResult:
     { status: 'SUCCESS' | 'FAIL' | 'CANCEL' | 'TIMEOUT',
       reference?: string,     // 上游订单/交易引用
       error?: string }        // 失败原因（供人工 fallback 展示）

   约定：
     - 只有 status==='SUCCESS' 才允许 payment-auth.commitSpend。
     - FAIL / CANCEL / TIMEOUT 一律不记账、不重试（由 gate 兜底 manualLink）。
     - Provider 不接触支付凭证；凭证由 credential-vault / 上游持有。
   ==================================================================== */
'use strict';

function createPaymentProviderRegistry() {
  const registry = Object.create(null);
  function register(provider) {
    if (!provider || !provider.name) throw new Error('PaymentProvider: provider.name 必填');
    if (typeof provider.submit !== 'function') throw new Error('PaymentProvider: ' + provider.name + ' 无 submit()');
    registry[provider.name] = provider;
    return provider;
  }
  function get(name) { return registry[String(name || '')] || null; }
  function list() { return Object.keys(registry); }
  function has(name) { return !!get(name); }
  return { register, get, list, has };
}

/* 归一 ProviderResult（防御未规范实现返回 undefined / 字符串等） */
function normalizeProviderResult(r, providerName) {
  if (!r || typeof r !== 'object') return { status: 'FAIL', provider: providerName, error: 'Provider 返回非对象' };
  const status = String(r.status || 'FAIL').toUpperCase();
  const allowed = ['SUCCESS', 'FAIL', 'CANCEL', 'TIMEOUT'];
  return {
    status: allowed.indexOf(status) >= 0 ? status : 'FAIL',
    provider: providerName,
    reference: r.reference || '',
    error: String(r.error || '').slice(0, 400)
  };
}

module.exports = { createPaymentProviderRegistry, normalizeProviderResult };
