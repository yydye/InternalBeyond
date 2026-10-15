'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const core = require('../assets/js/voicebox-library-core.js');
const voicebox = require('../bridge/voicebox.js');

const ROOT = path.resolve(__dirname, '..');
const STATIC_ROOT = path.join(ROOT, 'deploy', 'voice-library');
const manifestBytes = fs.readFileSync(path.join(STATIC_ROOT, 'voice-library-stable.json'));
const manifest = JSON.parse(manifestBytes.toString('utf8'));
const checked = core.validateManifest(manifest);
assert.strictEqual(checked.ok, true, 'prepared static manifest follows Voice Library v1');
assert.strictEqual(checked.manifest.resources.length, 4, 'curated batch contains four verified preset references');
const localCapabilities = voicebox({ config: {} }).profileCapabilities();
assert.strictEqual(localCapabilities.engines.kokoro.preset, true, 'IB Voicebox bridge advertises Kokoro preset Profiles');

const officialVoiceboxKokoroIds = new Set(['af_heart', 'af_bella', 'am_michael', 'zf_xiaobei']);
const seen = new Set();
for (const resource of checked.manifest.resources) {
  assert.ok(!seen.has(resource.id), 'unique resource id: ' + resource.id);
  seen.add(resource.id);
  assert.strictEqual(resource.engine, 'kokoro');
  assert.ok(officialVoiceboxKokoroIds.has(resource.presetVoiceId), 'ID is in the audited Voicebox Kokoro catalogue: ' + resource.presetVoiceId);
  assert.strictEqual(resource.license.id, 'Apache-2.0');
  assert.strictEqual(resource.license.url, 'https://huggingface.co/hexgrad/Kokoro-82M');
  const target = path.resolve(STATIC_ROOT, resource.path);
  assert.ok(target.startsWith(path.resolve(STATIC_ROOT, 'profiles') + path.sep), 'profile path remains beneath static profiles directory');
  const bytes = fs.readFileSync(target);
  assert.strictEqual(bytes.byteLength, resource.sizeBytes, resource.id + ' byte count');
  assert.strictEqual(crypto.createHash('sha256').update(bytes).digest('hex'), resource.sha256, resource.id + ' SHA-256');
  const profilePackage = JSON.parse(bytes.toString('utf8'));
  assert.strictEqual(core.packageMatchesResource(profilePackage, resource), true, resource.id + ' descriptor matches Manifest');
}

console.log('PASS test_voice_library_catalog (4 resources; source IDs, provider class, license pointer, byte sizes and hashes verified)');
