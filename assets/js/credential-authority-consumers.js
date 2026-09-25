/* R7 · capability consumers for the existing Desktop Local Authority seam.
   This module is a status-only wrapper. It never reads or returns apiKey,
   secret, fingerprint, ciphertext, or Bridge/Home Node credentials. */
(function (root) {
  'use strict';
  var IB = root.IB = root.IB || {};
  var STATUS = { ready: 1, missing: 1, unavailable: 1, unknown: 1, none: 1 };

  function projection(status, extra) {
    var s = status && typeof status === 'object' ? status : {};
    var out = {
      credentialRef: s.credentialRef || null,
      authorityScope: s.authorityScope || 'desktop-local',
      status: STATUS[s.status] ? s.status : 'unknown',
      secretPresent: s.secretPresent === true,
      sourceClass: s.sourceClass || 'unknown'
    };
    if (s.errorCode) out.errorCode = String(s.errorCode);
    return Object.assign(out, extra || {});
  }

  function none(sourceClass) {
    return Promise.resolve(projection({ status: 'none', sourceClass: sourceClass || 'local-policy' }));
  }

  function unavailable(sourceClass, errorCode) {
    return Promise.resolve(projection({
      status: 'unavailable',
      sourceClass: sourceClass || 'desktop-local',
      errorCode: errorCode || 'CREDENTIAL_STATUS_UNAVAILABLE'
    }));
  }

  function queryBinding(binding) {
    binding = binding && typeof binding === 'object' ? binding : {};
    var policy = String(binding.credentialPolicy || 'required').toLowerCase();
    var endpointClass = String(binding.endpointClass || 'remote').toLowerCase();
    if (policy === 'none' || endpointClass === 'loopback' || endpointClass === 'local') {
      return none('local-policy');
    }
    var host = IB.host;
    var capability = typeof host === 'object' && host && typeof host.capabilities === 'function'
      ? host.capabilities()
      : null;
    if (!host || !host.credentialStatus || typeof host.credentialStatus.query !== 'function'
      || (capability && capability.credentialStatus && capability.credentialStatus.available === false)) {
      return unavailable('desktop-local', 'CREDENTIAL_STATUS_UNAVAILABLE');
    }
    return host.credentialStatus.query([{
      bindingId: String(binding.bindingId || ''),
      capability: String(binding.capability || ''),
      credentialPolicy: policy,
      endpointClass: endpointClass
    }]).then(function (response) {
      var row = response && response.ok && Array.isArray(response.results) ? response.results[0] : null;
      if (!row) return projection({ status: 'unavailable', errorCode: 'CREDENTIAL_STATUS_UNAVAILABLE' });
      return projection(row);
    }, function () {
      return projection({ status: 'unavailable', errorCode: 'CREDENTIAL_STATUS_UNAVAILABLE' });
    });
  }

  async function imageRouteStatus(routeName) {
    var router = IB.imageRouterConfig;
    if (!router || typeof router.getRoutes !== 'function') {
      return unavailable('image-router', 'IMAGE_ROUTER_CONFIG_UNAVAILABLE');
    }
    var routes;
    try { routes = await router.getRoutes(); } catch (e) {
      return unavailable('image-router', 'IMAGE_ROUTER_CONFIG_UNAVAILABLE');
    }
    var name = String(routeName || 'generation');
    var route = routes && routes[name];
    if (!route) return projection({ status: 'unknown', sourceClass: 'image-router', errorCode: 'IMAGE_ROUTE_UNKNOWN' });
    if (!String(route.apiConfigId || '').trim()) {
      return projection({ status: 'unknown', sourceClass: 'image-router-inherit', errorCode: 'IMAGE_ROUTE_INHERIT_BINDING' });
    }
    return queryBinding({
      bindingId: String(route.apiConfigId),
      capability: 'image.generate',
      credentialPolicy: 'required',
      endpointClass: 'remote'
    });
  }

  function voiceStatus(profile) {
    var value = profile && typeof profile === 'object' ? profile : {};
    var source = String(value.source || value.provider || 'edge').toLowerCase();
    if (source === 'edge' || source === 'voicebox' || source === 'local-runtime') {
      return projection({ status: 'none', sourceClass: 'local-runtime' });
    }
    if (source === 'tts' || source === 'ttsmimo' || source === 'voiceasr' || source === 'voicetrans') {
      return projection({
        status: 'unknown',
        sourceClass: 'bridge-owned',
        errorCode: 'BRIDGE_AUTHORITY_SEPARATE'
      });
    }
    return projection({ status: 'unknown', sourceClass: 'voice-source-unknown', errorCode: 'VOICE_SOURCE_UNKNOWN' });
  }

  var consumers = IB.credentialAuthorityConsumers || {};
  consumers.queryBinding = queryBinding;
  consumers.imageRouteStatus = imageRouteStatus;
  consumers.voiceStatus = voiceStatus;
  IB.credentialAuthorityConsumers = Object.freeze(consumers);
})(window);
