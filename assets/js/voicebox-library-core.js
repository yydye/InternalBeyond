/* Voice Library v2 wire formats and validation. No persistence or audio ownership. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.IBVoiceboxLibraryCore = factory();
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';

  var MANIFEST_SCHEMA = 'internalbeyond.voice-library-manifest';
  var PROFILE_SCHEMA = 'internalbeyond.voice-profile-package';
  var MANIFEST_URL = 'https://dl.chatvault.top/voice-library/voice-library-stable.json';
  var MAX_MANIFEST_BYTES = 128 * 1024;
  var MAX_PROFILE_BYTES = 64 * 1024;
  var MAX_RESOURCES = 100;
  var RESOURCE_ID_RE = /^[a-z0-9][a-z0-9._-]{1,79}$/;
  var ENGINE_RE = /^[a-z0-9][a-z0-9_]{1,39}$/;

  function plain(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    var proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
  }
  function onlyKeys(value, allowed) {
    return plain(value) && Object.keys(value).every(function (key) { return allowed.indexOf(key) >= 0; });
  }
  function clean(value, max) {
    var result = String(value == null ? '' : value).trim();
    return result.length <= max && !/[\u0000-\u001f\u007f]/.test(result) ? result : '';
  }
  function httpsUrl(value, optional) {
    if (optional && (value == null || value === '')) return '';
    try {
      var parsed = new URL(String(value || ''));
      if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash) return '';
      return parsed.href;
    } catch (e) { return ''; }
  }
  function metadata(value, kind) {
    var allowed = kind === 'source' ? ['name', 'url'] : ['id', 'name', 'url'];
    if (!onlyKeys(value, allowed)) return null;
    var name = clean(value.name, 160), url = httpsUrl(value.url, true);
    if (!name || (value.url && !url)) return null;
    var out = { name: name };
    if (kind === 'license' && value.id != null) {
      var id = clean(value.id, 80);
      if (!id) return null;
      out.id = id;
    }
    if (url) out.url = url;
    return out;
  }
  function validateResource(source) {
    var allowed = ['id', 'kind', 'title', 'description', 'provider', 'engine', 'presetVoiceId', 'language', 'source', 'license', 'path', 'sizeBytes', 'sha256'];
    if (!onlyKeys(source, allowed)) return null;
    var id = clean(source.id, 80), title = clean(source.title, 120);
    var description = clean(source.description || '', 500);
    var engine = clean(source.engine, 40).toLowerCase();
    var presetVoiceId = clean(source.presetVoiceId, 120);
    var language = clean(source.language, 20).toLowerCase();
    var path = clean(source.path, 128);
    var sha256 = clean(source.sha256, 64).toLowerCase();
    var sizeBytes = Number(source.sizeBytes);
    var sourceInfo = metadata(source.source, 'source'), license = metadata(source.license, 'license');
    if (!RESOURCE_ID_RE.test(id) || source.kind !== 'voicebox-preset-profile' || source.provider !== 'voicebox'
      || !title || !ENGINE_RE.test(engine) || !presetVoiceId || !language
      || path !== 'profiles/' + id + '.json'
      || !Number.isSafeInteger(sizeBytes) || sizeBytes <= 0 || sizeBytes > MAX_PROFILE_BYTES
      || !/^[a-f0-9]{64}$/.test(sha256) || !sourceInfo || !license) return null;
    return { id: id, kind: source.kind, title: title, description: description, provider: 'voicebox',
      engine: engine, presetVoiceId: presetVoiceId, language: language, source: sourceInfo,
      license: license, path: path, sizeBytes: sizeBytes, sha256: sha256 };
  }
  function validateManifest(value) {
    if (!onlyKeys(value, ['schema', 'schemaVersion', 'generatedAt', 'resources'])
      || value.schema !== MANIFEST_SCHEMA || value.schemaVersion !== 1
      || !Array.isArray(value.resources) || value.resources.length > MAX_RESOURCES) {
      return { ok: false, reason: 'manifest-schema-invalid' };
    }
    var generatedAt = clean(value.generatedAt || '', 40);
    if (generatedAt && !/^\d{4}-\d{2}-\d{2}T/.test(generatedAt)) return { ok: false, reason: 'manifest-date-invalid' };
    var ids = Object.create(null), resources = [];
    for (var i = 0; i < value.resources.length; i++) {
      var item = validateResource(value.resources[i]);
      if (!item || ids[item.id]) return { ok: false, reason: 'manifest-resource-invalid' };
      ids[item.id] = true;
      resources.push(item);
    }
    return { ok: true, manifest: { schema: MANIFEST_SCHEMA, schemaVersion: 1, generatedAt: generatedAt, resources: resources } };
  }
  function normalizeProfile(profile) {
    var allowed = ['provider', 'voiceType', 'name', 'description', 'language', 'engine', 'presetVoiceId'];
    if (!onlyKeys(profile, allowed)) return null;
    var provider = clean(profile.provider, 24).toLowerCase();
    var voiceType = clean(profile.voiceType, 20).toLowerCase();
    var name = clean(profile.name, 100);
    var description = clean(profile.description || '', 500);
    var language = clean(profile.language, 20).toLowerCase();
    var engine = clean(profile.engine, 40).toLowerCase();
    var presetVoiceId = clean(profile.presetVoiceId, 120);
    if (provider !== 'voicebox' || voiceType !== 'preset' || !name || !language
      || !ENGINE_RE.test(engine) || !presetVoiceId) return null;
    return { provider: provider, voiceType: voiceType, name: name, description: description,
      language: language, engine: engine, presetVoiceId: presetVoiceId };
  }
  function validateProfilePackage(value) {
    if (!onlyKeys(value, ['schema', 'schemaVersion', 'profile', 'source', 'license'])
      || value.schema !== PROFILE_SCHEMA || value.schemaVersion !== 1) return { ok: false, reason: 'profile-package-schema-invalid' };
    var profile = normalizeProfile(value.profile);
    if (!profile) return { ok: false, reason: 'profile-package-profile-invalid' };
    var source = value.source == null ? null : metadata(value.source, 'source');
    var license = value.license == null ? null : metadata(value.license, 'license');
    if ((value.source != null && !source) || (value.license != null && !license)) return { ok: false, reason: 'profile-package-metadata-invalid' };
    return { ok: true, package: { schema: PROFILE_SCHEMA, schemaVersion: 1, profile: profile,
      source: source, license: license } };
  }
  function packageFromProfile(profile, source, license) {
    var input = profile || {};
    var value = {
      schema: PROFILE_SCHEMA,
      schemaVersion: 1,
      profile: {
        provider: 'voicebox', voiceType: input.voiceType || 'preset',
        name: input.name, description: input.description || '', language: input.language,
        engine: input.presetEngine || input.defaultEngine || input.engine,
        presetVoiceId: input.presetVoiceId
      },
      source: source || { name: 'Voicebox 本地 Profile' },
      license: license || { id: 'not-declared', name: '未声明（Profile 未提供许可证信息）' }
    };
    return validateProfilePackage(value);
  }
  function profileCompatibility(profile, capabilities, presetVoices) {
    var p = normalizeProfile(profile);
    if (!p) return { ok: false, reason: 'profile-invalid' };
    if (!plain(capabilities) || !plain(capabilities.engines)) return { ok: false, pending: true, reason: 'provider-capabilities-unavailable' };
    var engine = capabilities.engines[p.engine];
    if (!engine || engine.preset !== true || !Array.isArray(engine.profileTypes) || engine.profileTypes.indexOf('preset') < 0) {
      return { ok: false, reason: 'provider-engine-unsupported' };
    }
    if (Array.isArray(engine.languages) && engine.languages.indexOf(p.language) < 0) return { ok: false, reason: 'provider-language-unsupported' };
    if (!Array.isArray(presetVoices)) return { ok: false, pending: true, reason: 'provider-preset-list-unavailable' };
    var found = presetVoices.some(function (voice) { return String(voice && voice.id || '') === p.presetVoiceId; });
    return found ? { ok: true, profile: p } : { ok: false, reason: 'provider-preset-unavailable' };
  }
  function packageMatchesResource(profilePackage, resource) {
    var checked = validateProfilePackage(profilePackage), item = resource && validateResource(resource);
    if (!checked.ok || !item) return false;
    var p = checked.package.profile;
    var packagedSource = checked.package.source, packagedLicense = checked.package.license;
    return p.provider === item.provider && p.voiceType === 'preset' && p.name === item.title && p.engine === item.engine
      && p.presetVoiceId === item.presetVoiceId && p.language === item.language
      && (!packagedSource || (packagedSource.name === item.source.name && (!packagedSource.url || packagedSource.url === item.source.url)))
      && (!packagedLicense || (packagedLicense.name === item.license.name && String(packagedLicense.id || '') === String(item.license.id || '')
        && (!packagedLicense.url || packagedLicense.url === item.license.url)));
  }
  function resourceUrl(resource, baseUrl) {
    var item = validateResource(resource);
    if (!item) return '';
    var base;
    try { base = new URL(baseUrl || MANIFEST_URL); } catch (e) { return ''; }
    if (base.protocol !== 'https:' || base.origin !== 'https://dl.chatvault.top') return '';
    var url = new URL(item.path, base.origin + '/voice-library/');
    if (url.origin !== base.origin || url.pathname !== '/voice-library/' + item.path || url.search || url.hash) return '';
    return url.href;
  }
  function sha256Hex(bytes, cryptoProvider) {
    var cryptoApi = cryptoProvider || (typeof crypto !== 'undefined' ? crypto : null);
    var subtle = cryptoApi && cryptoApi.subtle;
    if (!subtle || typeof subtle.digest !== 'function') return Promise.reject(new Error('sha256-unavailable'));
    var input = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
    return subtle.digest('SHA-256', input).then(function (digest) {
      return Array.prototype.map.call(new Uint8Array(digest), function (value) { return value.toString(16).padStart(2, '0'); }).join('');
    });
  }
  async function verifyResourceBytes(resource, bytes, cryptoProvider) {
    var item = validateResource(resource), data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
    if (!item) return { ok: false, reason: 'resource-invalid' };
    if (data.byteLength !== item.sizeBytes) return { ok: false, reason: 'resource-size-mismatch' };
    var digest;
    try { digest = await sha256Hex(data, cryptoProvider); }
    catch (e) { return { ok: false, reason: 'sha256-unavailable' }; }
    if (digest !== item.sha256) return { ok: false, reason: 'resource-sha256-mismatch' };
    return { ok: true, bytes: data, sha256: digest };
  }
  return Object.freeze({
    MANIFEST_SCHEMA: MANIFEST_SCHEMA,
    PROFILE_SCHEMA: PROFILE_SCHEMA,
    MANIFEST_URL: MANIFEST_URL,
    MAX_MANIFEST_BYTES: MAX_MANIFEST_BYTES,
    MAX_PROFILE_BYTES: MAX_PROFILE_BYTES,
    validateManifest: validateManifest,
    validateProfilePackage: validateProfilePackage,
    packageFromProfile: packageFromProfile,
    profileCompatibility: profileCompatibility,
    packageMatchesResource: packageMatchesResource,
    resourceUrl: resourceUrl,
    sha256Hex: sha256Hex,
    verifyResourceBytes: verifyResourceBytes
  });
});
