/* P28-WM-P3A · pure provider/file consent identity helpers. */
﻿(function (root, factory) {
  'use strict';

  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.IBWorkModeConsentCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var TERMS_VERSION = 'work-mode-egress-result-memory-derived-coding-v6';
  var RESULT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
  var RESULT_SCHEMA_VERSION = 1;

  function normalizeFileIds(values, allowEmpty) {
    if (!Array.isArray(values) || (!allowEmpty && !values.length) || values.length > 200) return null;
    var seen = Object.create(null), ids = [];
    for (var i = 0; i < values.length; i++) {
      var value = values[i];
      if (typeof value !== 'string' || !/^[A-Za-z0-9_.:-]{1,180}$/.test(value) || seen[value]) return null;
      seen[value] = true;
      ids.push(value);
    }
    return ids.sort();
  }

  function normalizeProviderScope(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    var keys = Object.keys(value).sort();
    if (keys.join(',') !== 'destination,model,provider,providerRef,routeHash') return null;
    if (value.destination !== 'agent' && value.destination !== 'middle_brain') return null;
    if (typeof value.providerRef !== 'string' || !/^[A-Za-z0-9_.:-]{1,180}$/.test(value.providerRef)
      || typeof value.provider !== 'string' || !/^[A-Za-z0-9_.:-]{1,80}$/.test(value.provider)
      || typeof value.model !== 'string' || !/^[A-Za-z0-9_.:+/-]{1,120}$/.test(value.model)
      || typeof value.routeHash !== 'string' || !/^[a-f0-9]{64}$/i.test(value.routeHash)) return null;
    return {
      destination: value.destination,
      providerRef: value.providerRef,
      provider: value.provider,
      model: value.model,
      routeHash: value.routeHash.toLowerCase()
    };
  }

  function normalizeMemoryDerivedScope(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    if (Object.keys(value).sort().join(',') !== 'contextHash,projectRef,result,review') return null;
    if (typeof value.projectRef !== 'string' || !/^[A-Za-z0-9_.:-]{1,180}$/.test(value.projectRef)
      || typeof value.contextHash !== 'string' || !/^[a-f0-9]{64}$/i.test(value.contextHash)) return null;
    var review = value.review;
    if (!review || typeof review !== 'object' || Array.isArray(review)
      || Object.keys(review).sort().join(',') !== 'confirmed,providerScope'
      || review.confirmed !== true) return null;
    var reviewProviderScope = normalizeProviderScope(review.providerScope);
    if (!reviewProviderScope || reviewProviderScope.destination !== 'middle_brain') return null;
    var result = value.result;
    if (!result || typeof result !== 'object' || Array.isArray(result)
      || Object.keys(result).sort().join(',') !== 'confirmed,destination,retentionMs,schemaVersion,storage'
      || result.confirmed !== true || result.destination !== 'work_result'
      || result.schemaVersion !== RESULT_SCHEMA_VERSION
      || result.storage !== 'plaintext_home_node_sqlite'
      || result.retentionMs !== RESULT_RETENTION_MS) return null;
    return {
      projectRef: value.projectRef,
      contextHash: value.contextHash.toLowerCase(),
      review: { confirmed: true, providerScope: reviewProviderScope },
      result: {
        confirmed: true,
        destination: 'work_result',
        schemaVersion: RESULT_SCHEMA_VERSION,
        storage: 'plaintext_home_node_sqlite',
        retentionMs: RESULT_RETENTION_MS
      }
    };
  }

  async function providerScope(destination, providerRef, route, cryptoApi) {
    route = route || {};
    providerRef = String(providerRef || '');
    var routeCore = (typeof module === 'object' && module.exports)
      ? require('./work-mode-provider-route.js')
      : (typeof globalThis !== 'undefined' && globalThis.IBWorkModeProviderRoute);
    var canonical = routeCore && routeCore.normalize(Object.assign({}, route, {
      id: providerRef, credentialRef: route.credentialRef || providerRef
    }));
    var provider = canonical && canonical.provider || '', model = canonical && canonical.model || '', endpoint = canonical && canonical.endpoint || '';
    if ((destination !== 'agent' && destination !== 'middle_brain')
      || !/^[A-Za-z0-9_.:-]{1,180}$/.test(providerRef)
      || !/^[A-Za-z0-9_.:-]{1,80}$/.test(provider)
      || !/^[A-Za-z0-9_.:+/-]{1,120}$/.test(model)
      || !endpoint || endpoint.length > 2048 || /[\u0000-\u001F\u007F]/.test(endpoint)) return null;
    cryptoApi = cryptoApi || (typeof crypto !== 'undefined' ? crypto : null);
    if (!cryptoApi || !cryptoApi.subtle || typeof cryptoApi.subtle.digest !== 'function' || typeof TextEncoder !== 'function') return null;
    try {
      var input = new TextEncoder().encode([providerRef, provider, model, endpoint, canonical.credentialRef].join('\n'));
      var digest = await cryptoApi.subtle.digest('SHA-256', input);
      var routeHash = Array.from(new Uint8Array(digest)).map(function (value) {
        return value.toString(16).padStart(2, '0');
      }).join('');
      return normalizeProviderScope({
        destination: destination,
        providerRef: providerRef,
        provider: provider,
        model: model,
        routeHash: routeHash
      });
    } catch (_) { return null; }
  }

  function sameProviderScopes(left, right) {
    if (!Array.isArray(left) || !Array.isArray(right)) return false;
    function canonical(items) {
      return items.map(normalizeProviderScope).filter(Boolean).sort(function (a, b) {
        return a.destination.localeCompare(b.destination);
      });
    }
    return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
  }

  return Object.freeze({
    TERMS_VERSION: TERMS_VERSION,
    RESULT_RETENTION_MS: RESULT_RETENTION_MS,
    RESULT_SCHEMA_VERSION: RESULT_SCHEMA_VERSION,
    normalizeFileIds: normalizeFileIds,
    normalizeProviderScope: normalizeProviderScope,
    normalizeMemoryDerivedScope: normalizeMemoryDerivedScope,
    providerScope: providerScope,
    sameProviderScopes: sameProviderScopes
  });
});
