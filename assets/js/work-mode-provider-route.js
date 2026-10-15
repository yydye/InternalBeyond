/* Canonical non-secret Provider route shared by consent, Home Node projections, and send guards. */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.IBWorkModeProviderRoute = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  function value(input, max) {
    if (typeof input !== 'string') return '';
    var result = input.trim();
    return result && result.length <= max && !/[\u0000-\u001f\u007f]/.test(result) ? result : '';
  }
  function normalize(input) {
    input = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
    var provider = value(input.provider, 80);
    var model = value(input.model, 120);
    var providerRef = value(input.providerRef == null ? input.id : input.providerRef, 180);
    var credentialRef = value(input.credentialRef == null ? providerRef : input.credentialRef, 180);
    var endpointInput = value(input.endpoint, 2048);
    if (!provider || !/^[A-Za-z0-9_.:-]{1,80}$/.test(provider)
      || !model || !/^[A-Za-z0-9_.:+/-]{1,120}$/.test(model)
      || !providerRef || !/^[A-Za-z0-9_.:-]{1,180}$/.test(providerRef)
      || !credentialRef || !/^[A-Za-z0-9_.:-]{1,180}$/.test(credentialRef)
      || !endpointInput) return null;
    var endpoint;
    try {
      var parsed = new URL(endpointInput);
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.hash) return null;
      endpoint = parsed.href;
    } catch (_) { return null; }
    if (endpoint.length > 2048) return null;
    return Object.freeze({ providerRef: providerRef, provider: provider, model: model, endpoint: endpoint, credentialRef: credentialRef });
  }
  return Object.freeze({ normalize: normalize });
});
