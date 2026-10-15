'use strict';

const assert = require('assert');
const crypto = require('crypto').webcrypto;
const Core = require('../assets/js/voicebox-library-core.js');

let passed = 0;
function check(name, value) { assert.ok(value, name); passed++; console.log('✔ ' + name); }
function profile(overrides) {
  return Object.assign({ provider: 'voicebox', voiceType: 'preset', name: 'Kokoro Heart', description: 'Preset profile',
    language: 'en', engine: 'kokoro', presetVoiceId: 'af_heart' }, overrides || {});
}
function resource(overrides) {
  return Object.assign({ id: 'kokoro-heart', kind: 'voicebox-preset-profile', title: 'Kokoro Heart', description: 'Preset voice',
    provider: 'voicebox', engine: 'kokoro', presetVoiceId: 'af_heart', language: 'en',
    source: { name: 'Voice Library', url: 'https://example.com/voices' },
    license: { id: 'CC-BY-4.0', name: 'CC BY 4.0', url: 'https://example.com/license' },
    path: 'profiles/kokoro-heart.json', sizeBytes: 100, sha256: 'a'.repeat(64) }, overrides || {});
}
const caps = { engines: { kokoro: { profileTypes: ['preset'], preset: true, languages: ['en', 'zh'] } } };

const manifest = { schema: Core.MANIFEST_SCHEMA, schemaVersion: 1, generatedAt: '2026-10-14T12:00:00Z', resources: [resource()] };
check('accepts the versioned manifest with an HTTPS source and license', Core.validateManifest(manifest).ok === true);
check('rejects unknown manifest schemas and versions', !Core.validateManifest(Object.assign({}, manifest, { schemaVersion: 2 })).ok);
check('rejects duplicate resource identities', !Core.validateManifest(Object.assign({}, manifest, { resources: [resource(), resource()] })).ok);
check('rejects path traversal and arbitrary remote URLs', !Core.validateManifest(Object.assign({}, manifest, { resources: [resource({ path: '../outside.json' })] })).ok
  && Core.resourceUrl(resource({ path: '../outside.json' })) === '');
check('pins resource downloads to the HTTPS Voice Library path', Core.resourceUrl(resource()) === 'https://dl.chatvault.top/voice-library/profiles/kokoro-heart.json');
check('rejects non-HTTPS source and license links', !Core.validateManifest(Object.assign({}, manifest, { resources: [resource({ source: { name: 'bad', url: 'http://example.com' } })] })).ok
  && !Core.validateManifest(Object.assign({}, manifest, { resources: [resource({ license: { name: 'bad', url: 'javascript:alert(1)' } })] })).ok);
check('rejects zero, oversized, or malformed digest metadata', !Core.validateManifest(Object.assign({}, manifest, { resources: [resource({ sizeBytes: 0 })] })).ok
  && !Core.validateManifest(Object.assign({}, manifest, { resources: [resource({ sizeBytes: Core.MAX_PROFILE_BYTES + 1 })] })).ok
  && !Core.validateManifest(Object.assign({}, manifest, { resources: [resource({ sha256: 'not-a-digest' })] })).ok);

const exported = Core.packageFromProfile(Object.assign(profile(), { id: 'private-voicebox-id', sampleCount: 2, audio: 'MUST_NOT_EXPORT' }),
  { name: 'Voice Library', url: 'https://example.com/voices' }, { id: 'CC-BY-4.0', name: 'CC BY 4.0' });
check('exports only portable preset metadata, never runtime IDs, samples, or audio', exported.ok
  && exported.package.profile.presetVoiceId === 'af_heart'
  && !JSON.stringify(exported.package).includes('private-voicebox-id')
  && !JSON.stringify(exported.package).includes('MUST_NOT_EXPORT')
  && !JSON.stringify(exported.package).match(/apiKey|credential|token|audio|sample/i));
check('round-trips a supported preset package with source and license metadata', Core.validateProfilePackage(exported.package).ok
  && Core.validateProfilePackage(exported.package).package.license.id === 'CC-BY-4.0');
check('rejects unsupported Voicebox cloned profiles and credential-bearing package fields', !Core.packageFromProfile(profile({ voiceType: 'cloned' })).ok
  && !Core.validateProfilePackage({ schema: Core.PROFILE_SCHEMA, schemaVersion: 1, profile: profile(), apiKey: 'SECRET' }).ok);
check('rejects unsupported provider and unknown profile fields', !Core.validateProfilePackage({ schema: Core.PROFILE_SCHEMA, schemaVersion: 1,
  profile: profile({ provider: 'unknown-provider' }) }).ok
  && !Core.validateProfilePackage({ schema: Core.PROFILE_SCHEMA, schemaVersion: 1, profile: Object.assign(profile(), { audioData: 'AAAA' }) }).ok);

check('requires a provider that advertises preset Profile compatibility and the exact preset ID',
  Core.profileCompatibility(profile(), caps, [{ id: 'af_heart', name: 'Heart', language: 'en' }]).ok
    && !Core.profileCompatibility(profile(), { engines: { kokoro: { profileTypes: ['cloned'], preset: false, languages: ['en'] } } }, [{ id: 'af_heart' }]).ok
    && !Core.profileCompatibility(profile(), caps, [{ id: 'af_bella' }]).ok
    && !Core.profileCompatibility(profile({ language: 'de' }), caps, [{ id: 'af_heart' }]).ok);
check('marks missing local Provider capabilities as pending rather than available',
  Core.profileCompatibility(profile(), null, []).pending === true);
check('requires the downloaded package to match the Manifest Profile identity',
  Core.packageMatchesResource(exported.package, resource())
    && !Core.packageMatchesResource(Core.packageFromProfile(profile({ presetVoiceId: 'af_bella' })).package, resource()));

const bytes = new TextEncoder().encode(JSON.stringify(exported.package));
crypto.subtle.digest('SHA-256', bytes).then(function (value) {
  const hex = Array.from(new Uint8Array(value), function (part) { return part.toString(16).padStart(2, '0'); }).join('');
  const validResource = resource({ sizeBytes: bytes.byteLength, sha256: hex });
  return Promise.all([
    Core.verifyResourceBytes(validResource, bytes, crypto),
    Core.verifyResourceBytes(validResource, bytes.slice(1), crypto),
    Core.verifyResourceBytes(resource({ sizeBytes: bytes.byteLength, sha256: '0'.repeat(64) }), bytes, crypto)
  ]).then(function (results) {
    check('verifies exact byte count and SHA-256 before import', results[0].ok && results[1].reason === 'resource-size-mismatch'
      && results[2].reason === 'resource-sha256-mismatch');
    console.log('\nVoice Library core tests passed ✔ (' + passed + ' checks)');
  });
}).catch(function (error) { console.error(error); process.exitCode = 1; });
