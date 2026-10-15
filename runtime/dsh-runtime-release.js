'use strict';

/* Signed DSH Runtime release discovery and bounded HTTPS transfer. */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { once } = require('node:events');
const optionalRuntime = require('./optional-dsh-runtime.js');

const ENVELOPE_SCHEMA = 'internalbeyond.signed-dsh-runtime-release-index';
const INDEX_SCHEMA = 'internalbeyond.dsh-runtime-release-index';
const TRUST_SCHEMA = 'internalbeyond.dsh-runtime-release-trust';
const SIGNING_DOMAIN = Buffer.from('InternalBeyond DSH Runtime Release Index\0v1\0', 'utf8');
const MAX_INDEX_BYTES = 1024 * 1024;
const MAX_RELEASES = 32;
const MAX_MANIFEST_AGE_MS = 60 * 24 * 60 * 60 * 1000;
const LOOPBACK_TEST_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

function sha256(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }

function canonicalJson(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('runtime-release-json-number-invalid');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error('runtime-release-json-value-invalid');
  }
  const keys = Object.keys(value).sort();
  return '{' + keys.map(key => JSON.stringify(key) + ':' + canonicalJson(value[key])).join(',') + '}';
}

function signatureMessage(keyId, payloadBytes) {
  return Buffer.concat([SIGNING_DOMAIN, Buffer.from(String(keyId) + '\n', 'utf8'), payloadBytes]);
}

function parseTrustConfig(value) {
  const config = typeof value === 'string' ? JSON.parse(fs.readFileSync(value, 'utf8')) : value;
  if (!config || config.schema !== TRUST_SCHEMA || Number(config.schemaVersion) !== 1
    || !Array.isArray(config.keys) || config.keys.length < 1 || config.keys.length > 8
    || !Array.isArray(config.manifestHosts) || !Array.isArray(config.artifactHosts)) {
    throw new Error('runtime-release-trust-config-invalid');
  }
  const keyIds = new Set();
  for (const key of config.keys) {
    if (!key || key.algorithm !== 'Ed25519' || !/^[a-z0-9][a-z0-9._-]{2,95}$/i.test(String(key.keyId || ''))
      || keyIds.has(String(key.keyId)) || !/^[A-Za-z0-9+/]{59}=$/.test(String(key.publicKeySpkiBase64 || ''))) {
      throw new Error('runtime-release-trust-key-invalid');
    }
    keyIds.add(String(key.keyId));
    const der = Buffer.from(key.publicKeySpkiBase64, 'base64');
    if (der.toString('base64') !== key.publicKeySpkiBase64 || der.length !== 44) {
      throw new Error('runtime-release-trust-key-invalid');
    }
    try {
      const publicKey = crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
      if (publicKey.asymmetricKeyType !== 'ed25519') throw new Error('key-type');
    }
    catch (_) { throw new Error('runtime-release-trust-key-invalid'); }
  }
  if (!/^https:\/\//i.test(String(config.manifestUrl || ''))) throw new Error('runtime-release-manifest-url-invalid');
  return config;
}

function decodeCanonicalBase64(value, expectedBytes, errorCode) {
  const text = String(value || '');
  const bytes = Buffer.from(text, 'base64');
  if (!text || bytes.toString('base64') !== text || (expectedBytes != null && bytes.length !== expectedBytes)) {
    throw new Error(errorCode);
  }
  return bytes;
}

function verifySignedEnvelope(input, trustConfig) {
  const raw = Buffer.isBuffer(input) ? input : Buffer.from(JSON.stringify(input || {}), 'utf8');
  if (!raw.length || raw.length > MAX_INDEX_BYTES) throw new Error('runtime-release-index-size-invalid');
  let envelope;
  try { envelope = JSON.parse(raw.toString('utf8')); }
  catch (_) { throw new Error('runtime-release-index-json-invalid'); }
  if (!envelope || envelope.schema !== ENVELOPE_SCHEMA || Number(envelope.schemaVersion) !== 1
    || Object.keys(envelope).sort().join(',') !== 'keyId,payload,schema,schemaVersion,signature') {
    throw new Error('runtime-release-envelope-invalid');
  }
  const keyId = String(envelope.keyId || '');
  const keyRecord = trustConfig.keys.find(key => key.keyId === keyId && key.algorithm === 'Ed25519');
  if (!keyRecord) throw new Error('runtime-release-signing-key-untrusted');
  const payloadBytes = decodeCanonicalBase64(envelope.payload, null, 'runtime-release-payload-encoding-invalid');
  if (!payloadBytes.length || payloadBytes.length > MAX_INDEX_BYTES - 1024) throw new Error('runtime-release-index-size-invalid');
  let payload;
  try { payload = JSON.parse(payloadBytes.toString('utf8')); }
  catch (_) { throw new Error('runtime-release-payload-json-invalid'); }
  let canonical;
  try { canonical = Buffer.from(canonicalJson(payload), 'utf8'); }
  catch (error) { throw error; }
  if (!canonical.equals(payloadBytes)) throw new Error('runtime-release-payload-not-canonical');
  const signature = decodeCanonicalBase64(envelope.signature, 64, 'runtime-release-signature-invalid');
  const publicKey = crypto.createPublicKey({
    key: Buffer.from(keyRecord.publicKeySpkiBase64, 'base64'), format: 'der', type: 'spki'
  });
  if (!crypto.verify(null, signatureMessage(keyId, payloadBytes), publicKey, signature)) {
    throw new Error('runtime-release-signature-verification-failed');
  }
  return {
    envelope: envelope,
    payload: payload,
    keyId: keyId,
    envelopeSha256: sha256(raw),
    payloadSha256: sha256(payloadBytes),
    rawBytes: raw
  };
}

function parseSemver(value) {
  const match = String(value || '').match(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/);
  if (!match) return null;
  const core = match.slice(1, 4).map(Number);
  if (core.some(item => !Number.isSafeInteger(item))) return null;
  return { core: core, prerelease: match[4] ? match[4].split('.') : [] };
}

function compareSemver(left, right) {
  const a = parseSemver(left);
  const b = parseSemver(right);
  if (!a || !b) return null;
  for (let index = 0; index < 3; index++) {
    if (a.core[index] !== b.core[index]) return a.core[index] < b.core[index] ? -1 : 1;
  }
  if (!a.prerelease.length && !b.prerelease.length) return 0;
  if (!a.prerelease.length) return 1;
  if (!b.prerelease.length) return -1;
  const count = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < count; index++) {
    const x = a.prerelease[index];
    const y = b.prerelease[index];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const xNumeric = /^\d+$/.test(x);
    const yNumeric = /^\d+$/.test(y);
    if (xNumeric && yNumeric) return BigInt(x) < BigInt(y) ? -1 : 1;
    if (xNumeric !== yNumeric) return xNumeric ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

function nodeVersionSupported(version, engine) {
  if (engine !== optionalRuntime.DSH_NODE_ENGINE) return false;
  const match = String(version || '').replace(/^v/, '').match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  return (major === 22 && (minor > 19 || (minor === 19 && patch >= 0))) || major >= 24;
}

function releaseIncompatibility(release, options) {
  const productVersion = String(options.productVersion || '');
  const min = compareSemver(productVersion, release.compatibility.minimumProductVersion);
  const max = compareSemver(productVersion, release.compatibility.maximumProductVersionExclusive);
  if (min == null || max == null || min < 0 || max >= 0) return 'package-product-version-incompatible';
  if (!nodeVersionSupported(options.nodeVersion, release.compatibility.dshNodeEngine)
    || !nodeVersionSupported(release.compatibility.bundledNodeVersion, release.compatibility.dshNodeEngine)) {
    return 'package-node-version-incompatible';
  }
  return '';
}

function validateReleaseIndex(payload, options) {
  options = options || {};
  if (!payload || payload.schema !== INDEX_SCHEMA || Number(payload.schemaVersion) !== 1
    || payload.channel !== 'stable' || !Array.isArray(payload.releases)
    || payload.releases.length < 1 || payload.releases.length > MAX_RELEASES) {
    throw new Error('runtime-release-index-contract-invalid');
  }
  const now = Number(options.now) || Date.now();
  const generatedAt = Date.parse(payload.generatedAt);
  const expiresAt = Date.parse(payload.expiresAt);
  if (!Number.isFinite(generatedAt) || !Number.isFinite(expiresAt)
    || generatedAt > now + 5 * 60 * 1000 || (!options.allowExpired && expiresAt <= now)
    || expiresAt <= generatedAt || expiresAt - generatedAt > MAX_MANIFEST_AGE_MS) {
    throw new Error('runtime-release-index-expired-or-invalid');
  }
  const versions = new Set();
  const releases = payload.releases.map(raw => {
    if (!raw || !parseSemver(raw.runtimeVersion) || raw.sourceRevision !== optionalRuntime.DSH_REVISION
      || raw.target !== optionalRuntime.TARGET || Number(raw.protocolVersion) !== 1) {
      throw new Error('runtime-release-record-invalid');
    }
    const version = String(raw.runtimeVersion);
    if (versions.has(version)) throw new Error('runtime-release-version-duplicate');
    versions.add(version);
    const compatibility = raw.compatibility;
    if (!compatibility || !parseSemver(compatibility.minimumProductVersion)
      || !parseSemver(compatibility.maximumProductVersionExclusive)
      || compareSemver(compatibility.minimumProductVersion, compatibility.maximumProductVersionExclusive) >= 0
      || !parseSemver(compatibility.bundledNodeVersion)
      || compatibility.dshNodeEngine !== optionalRuntime.DSH_NODE_ENGINE) {
      throw new Error('runtime-release-compatibility-invalid');
    }
    const artifacts = raw.productionArtifacts;
    if (!artifacts || !Number.isSafeInteger(artifacts.fileCount) || artifacts.fileCount < 1
      || artifacts.fileCount > optionalRuntime.MAX_FILES || !Number.isSafeInteger(artifacts.bytes)
      || artifacts.bytes < 1 || artifacts.bytes > optionalRuntime.MAX_UNPACKED_BYTES
      || !/^[a-f0-9]{64}$/i.test(String(artifacts.webFrontendSha256 || ''))) {
      throw new Error('runtime-release-artifacts-invalid');
    }
    const archive = raw.archive;
    if (!archive || !Number.isSafeInteger(archive.bytes) || archive.bytes < 22
      || archive.bytes > optionalRuntime.MAX_ARCHIVE_BYTES
      || !/^[a-f0-9]{64}$/i.test(String(archive.sha256 || ''))) {
      throw new Error('runtime-release-archive-invalid');
    }
    try { validateUrl(archive.url, options.artifactHosts || [], {
      testOnlyAllowHttpLoopback: options.testOnlyAllowHttpLoopback === true
    }); } catch (_) { throw new Error('runtime-release-archive-invalid'); }
    const incompatibility = releaseIncompatibility(raw, options);
    return {
      runtimeVersion: version,
      sourceRevision: raw.sourceRevision,
      target: raw.target,
      protocolVersion: Number(raw.protocolVersion),
      compatibility: {
        minimumProductVersion: String(compatibility.minimumProductVersion),
        maximumProductVersionExclusive: String(compatibility.maximumProductVersionExclusive),
        bundledNodeVersion: String(compatibility.bundledNodeVersion),
        dshNodeEngine: String(compatibility.dshNodeEngine)
      },
      productionArtifacts: {
        fileCount: artifacts.fileCount,
        bytes: artifacts.bytes,
        webFrontendSha256: String(artifacts.webFrontendSha256).toLowerCase()
      },
      archive: {
        url: String(archive.url),
        bytes: archive.bytes,
        sha256: String(archive.sha256).toLowerCase()
      },
      publishedAt: String(raw.publishedAt || payload.generatedAt),
      notes: String(raw.notes || '').slice(0, 1000),
      compatible: !incompatibility,
      incompatibility: incompatibility
    };
  });
  releases.sort((left, right) => compareSemver(right.runtimeVersion, left.runtimeVersion));
  return { channel: payload.channel, generatedAt: payload.generatedAt, expiresAt: payload.expiresAt, releases: releases };
}

function validateUrl(raw, hosts, options) {
  options = options || {};
  let url;
  try { url = new URL(String(raw)); }
  catch (_) { throw new Error('runtime-download-url-invalid'); }
  if (url.username || url.password || url.hash) throw new Error('runtime-download-url-invalid');
  if (url.protocol === 'https:' && (!hosts.includes(url.hostname.toLowerCase()) || (url.port && url.port !== '443'))) {
    throw new Error('runtime-download-host-denied');
  }
  if (url.protocol === 'http:' && options.testOnlyAllowHttpLoopback === true
    && LOOPBACK_TEST_HOSTS.has(url.hostname.toLowerCase()) && !!url.port) return url;
  if (url.protocol !== 'https:' || !hosts.includes(url.hostname.toLowerCase()) || (url.port && url.port !== '443')) {
    throw new Error('runtime-download-https-required');
  }
  return url;
}

async function fetchResponse(url, options) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('runtime-download-fetch-unavailable');
  const allowedHosts = options.allowedHosts || [];
  let current = validateUrl(url, allowedHosts, options);
  for (let redirect = 0; redirect <= 4; redirect++) {
    const response = await fetchImpl(current.href, {
      method: 'GET', redirect: 'manual', cache: 'no-store', signal: options.signal,
      headers: { accept: options.accept || '*/*', 'user-agent': 'TheLostBeyond-DSH-Runtime/1' }
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      if (redirect === 4) throw new Error('runtime-download-redirect-limit');
      const location = response.headers.get('location');
      if (response.body && typeof response.body.cancel === 'function') await response.body.cancel().catch(() => {});
      if (!location) throw new Error('runtime-download-redirect-invalid');
      current = validateUrl(new URL(location, current).href, allowedHosts, options);
      continue;
    }
    return response;
  }
  throw new Error('runtime-download-redirect-limit');
}

async function readBoundedResponse(response, maxBytes, errorPrefix) {
  if (!response || response.status !== 200 || !response.body) throw new Error(errorPrefix + '-http-status');
  const contentLengthText = response.headers.get('content-length');
  const contentLength = contentLengthText == null ? 0 : Number(contentLengthText);
  if (contentLengthText != null && (!Number.isSafeInteger(contentLength) || contentLength <= 0 || contentLength > maxBytes)) {
    throw new Error(errorPrefix + '-size-invalid');
  }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > maxBytes) {
      try { await response.body.cancel(); } catch (_) {}
      throw new Error(errorPrefix + '-size-limit-exceeded');
    }
    chunks.push(Buffer.from(chunk));
  }
  if (!bytes || (contentLength && bytes !== contentLength)) throw new Error(errorPrefix + '-length-mismatch');
  return Buffer.concat(chunks, bytes);
}

async function fetchSignedIndex(options) {
  options = options || {};
  const trust = parseTrustConfig(options.trustConfig);
  const url = options.manifestUrl || trust.manifestUrl;
  const response = await fetchResponse(url, {
    signal: options.signal,
    fetchImpl: options.fetchImpl,
    allowedHosts: trust.manifestHosts,
    testOnlyAllowHttpLoopback: options.testOnlyAllowHttpLoopback === true,
    accept: 'application/json'
  });
  const raw = await readBoundedResponse(response, MAX_INDEX_BYTES, 'runtime-release-index');
  const verified = verifySignedEnvelope(raw, trust);
  const index = validateReleaseIndex(verified.payload, {
    productVersion: options.productVersion,
    nodeVersion: options.nodeVersion,
    now: options.now,
    allowExpired: options.allowExpired === true,
    artifactHosts: trust.artifactHosts,
    testOnlyAllowHttpLoopback: options.testOnlyAllowHttpLoopback === true
  });
  return { trust: trust, verified: verified, index: index };
}

async function downloadArchive(release, filePath, options) {
  options = options || {};
  const trust = parseTrustConfig(options.trustConfig);
  const url = validateUrl(release && release.archive && release.archive.url,
    trust.artifactHosts, { testOnlyAllowHttpLoopback: options.testOnlyAllowHttpLoopback === true });
  const response = await fetchResponse(url.href, {
    signal: options.signal,
    fetchImpl: options.fetchImpl,
    allowedHosts: trust.artifactHosts,
    testOnlyAllowHttpLoopback: options.testOnlyAllowHttpLoopback === true,
    accept: 'application/zip, application/octet-stream'
  });
  if (!response || response.status !== 200 || !response.body) throw new Error('runtime-download-http-status');
  const contentLengthText = response.headers.get('content-length');
  const contentLength = contentLengthText == null ? 0 : Number(contentLengthText);
  if (contentLengthText != null && (!Number.isSafeInteger(contentLength) || contentLength !== release.archive.bytes)) {
    throw new Error('runtime-download-length-mismatch');
  }
  const output = fs.createWriteStream(filePath, { flags: 'wx', mode: 0o600 });
  const hash = crypto.createHash('sha256');
  let bytesDone = 0;
  try {
    for await (const chunkValue of response.body) {
      if (options.signal && options.signal.aborted) throw new Error('runtime-download-cancelled');
      const chunk = Buffer.from(chunkValue);
      bytesDone += chunk.length;
      if (bytesDone > release.archive.bytes || bytesDone > optionalRuntime.MAX_ARCHIVE_BYTES) {
        throw new Error('runtime-download-size-limit-exceeded');
      }
      hash.update(chunk);
      if (!output.write(chunk)) await once(output, 'drain');
      if (typeof options.onProgress === 'function') options.onProgress({
        bytesDone: bytesDone,
        bytesTotal: release.archive.bytes,
        percent: Math.min(39, Math.floor((bytesDone / release.archive.bytes) * 39))
      });
    }
    output.end();
    await new Promise((resolve, reject) => {
      output.once('finish', resolve);
      output.once('error', reject);
    });
    if (bytesDone !== release.archive.bytes) throw new Error('runtime-download-length-mismatch');
    const archiveSha256 = hash.digest('hex');
    if (archiveSha256 !== release.archive.sha256) throw new Error('runtime-archive-sha256-mismatch');
    return { bytes: bytesDone, sha256: archiveSha256 };
  } catch (error) {
    output.destroy();
    try { fs.unlinkSync(filePath); } catch (_) {}
    if (options.signal && options.signal.aborted) throw new Error('runtime-download-cancelled');
    if (error && (error.name === 'AbortError' || error.name === 'TypeError')) {
      throw new Error('runtime-download-interrupted');
    }
    throw error;
  }
}

function assertReleaseMatchesPackage(release, packageManifest) {
  if (!release || !packageManifest || release.runtimeVersion !== packageManifest.runtimeVersion
    || release.sourceRevision !== packageManifest.sourceRevision || release.target !== packageManifest.target
    || release.protocolVersion !== Number(packageManifest.protocolVersion)
    || release.compatibility.minimumProductVersion !== packageManifest.compatibility.minimumProductVersion
    || release.compatibility.maximumProductVersionExclusive !== packageManifest.compatibility.maximumProductVersionExclusive
    || release.compatibility.bundledNodeVersion !== packageManifest.compatibility.bundledNodeVersion
    || release.compatibility.dshNodeEngine !== packageManifest.compatibility.dshNodeEngine
    || release.productionArtifacts.fileCount !== packageManifest.productionArtifacts.fileCount
    || release.productionArtifacts.bytes !== packageManifest.productionArtifacts.bytes
    || release.productionArtifacts.webFrontendSha256 !== packageManifest.productionArtifacts.webFrontendSha256
    || release.archive.bytes <= 0 || !/^[a-f0-9]{64}$/.test(release.archive.sha256)) {
    throw new Error('runtime-release-package-mismatch');
  }
}

function verifyInstallAttestation(attestation, trustConfig, options) {
  if (!attestation || attestation.schema !== 'internalbeyond.dsh-runtime-release-attestation'
    || Number(attestation.schemaVersion) !== 1 || typeof attestation.envelope !== 'string') {
    throw new Error('runtime-release-attestation-invalid');
  }
  const envelopeBytes = Buffer.from(attestation.envelope, 'base64');
  if (envelopeBytes.toString('base64') !== attestation.envelope) throw new Error('runtime-release-attestation-invalid');
  const trust = parseTrustConfig(trustConfig);
  const verified = verifySignedEnvelope(envelopeBytes, trust);
  const index = validateReleaseIndex(verified.payload, Object.assign({}, options || {}, {
    artifactHosts: trust.artifactHosts
  }));
  const release = index.releases.find(item => item.runtimeVersion === attestation.runtimeVersion);
  if (!release || !release.compatible || release.archive.sha256 !== attestation.archiveSha256
    || verified.keyId !== attestation.keyId || verified.envelopeSha256 !== attestation.manifestSha256) {
    throw new Error('runtime-release-attestation-mismatch');
  }
  return { release: release, verified: verified };
}

function createSignedEnvelope(payload, keyId, privateKey) {
  const payloadBytes = Buffer.from(canonicalJson(payload), 'utf8');
  const signature = crypto.sign(null, signatureMessage(keyId, payloadBytes), privateKey);
  return Buffer.from(JSON.stringify({
    schema: ENVELOPE_SCHEMA,
    schemaVersion: 1,
    keyId: String(keyId),
    payload: payloadBytes.toString('base64'),
    signature: signature.toString('base64')
  }, null, 2) + '\n', 'utf8');
}

module.exports = {
  ENVELOPE_SCHEMA, INDEX_SCHEMA, TRUST_SCHEMA, MAX_INDEX_BYTES,
  canonicalJson, parseTrustConfig, verifySignedEnvelope, parseSemver, compareSemver,
  validateReleaseIndex, fetchSignedIndex, downloadArchive, assertReleaseMatchesPackage,
  verifyInstallAttestation, createSignedEnvelope
};
