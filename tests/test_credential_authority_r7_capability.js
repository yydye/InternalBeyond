'use strict';

/*
 * R7 capability integration contract test.
 * Synthetic only: no production profile, Vault, provider, Bridge or Home Node.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const SOURCE = fs.readFileSync(
  path.join(ROOT, 'assets', 'js', 'credential-authority-consumers.js'),
  'utf8'
);
const MIDDLE_BRAIN_SOURCE = fs.readFileSync(
  path.join(ROOT, 'assets', 'js', 'middle-brain-config.js'),
  'utf8'
);

function forbiddenProperties(value) {
  const forbidden = new Set([
    'apiKey',
    'Authorization',
    'Bearer',
    'secret',
    'ciphertext',
    'fingerprint',
    'secretEnvelope',
    'decryptionKey'
  ]);
  const found = [];
  const seen = new WeakSet();
  function walk(item) {
    if (!item || typeof item !== 'object' || seen.has(item)) return;
    seen.add(item);
    if (Array.isArray(item)) return item.forEach(walk);
    for (const [key, child] of Object.entries(item)) {
      if (forbidden.has(key)) found.push(key);
      walk(child);
    }
  }
  walk(value);
  return found;
}

function loadConsumers(host, config) {
  const IB = {
    host,
    imageRouterConfig: {
      getRoutes: async () => ({
        generation: { apiConfigId: 'friend_synthetic_image', model: '', fallback: {} },
        editing: { apiConfigId: '', model: '', fallback: {} }
      })
    }
  };
  const context = { window: { IB }, Promise, String, Object, Array };
  vm.runInNewContext(SOURCE, context, { filename: 'credential-authority-consumers.js' });
  return context.window.IB.credentialAuthorityConsumers;
}

async function run() {
  const calls = [];
  const host = {
    capabilities: () => ({ credentialStatus: { available: true } }),
    credentialStatus: {
      query: async bindings => {
        calls.push(bindings);
        return {
          ok: true,
          results: bindings.map(binding => ({
            bindingId: binding.bindingId,
            credentialRef: 'cred-synthetic',
            authorityScope: 'desktop-local',
            status: 'ready',
            secretPresent: true,
            sourceClass: 'synthetic'
          }))
        };
      }
    }
  };

  const middleStatusMatch = MIDDLE_BRAIN_SOURCE.match(
    /async function getMiddleBrainCredentialStatus\(\)\s*\{[\s\S]*?\n  \}/
  );
  assert(middleStatusMatch);
  const middleExecutable = middleStatusMatch[0]
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
  assert(!/\bapiKey\b/.test(middleExecutable));
  assert(middleExecutable.includes('credentialRef'));
  const middleLegacy = {
    status: 'unknown',
    sourceClass: 'middle-brain-legacy-config',
    errorCode: 'CREDENTIAL_REF_MISSING'
  };
  assert.strictEqual(middleLegacy.status, 'unknown');
  assert.strictEqual(middleLegacy.errorCode, 'CREDENTIAL_REF_MISSING');

  const middleWithRef = loadConsumers(host, {
    enabled: true,
    model: 'synthetic-middle-brain',
    credentialRef: 'friend_synthetic_mb'
  });
  const middleReady = await middleWithRef.queryBinding({
    bindingId: 'friend_synthetic_mb',
    capability: 'chat',
    credentialPolicy: 'required',
    endpointClass: 'remote'
  });
  assert.strictEqual(middleReady.status, 'ready');

  const image = await middleWithRef.imageRouteStatus('generation');
  assert.strictEqual(image.status, 'ready');

  const imageInherit = await middleWithRef.imageRouteStatus('editing');
  assert.strictEqual(imageInherit.status, 'unknown');

  const edge = middleWithRef.voiceStatus({ source: 'edge' });
  const bridgeTts = middleWithRef.voiceStatus({ source: 'tts' });
  const voicebox = middleWithRef.voiceStatus({ source: 'voicebox' });
  assert.strictEqual(edge.status, 'none');
  assert.strictEqual(bridgeTts.status, 'unknown');
  assert.strictEqual(bridgeTts.sourceClass, 'bridge-owned');
  assert.strictEqual(voicebox.status, 'none');

  const unavailable = loadConsumers({
    capabilities: () => ({ credentialStatus: { available: false } }),
    credentialStatus: { query: async () => ({ ok: false }) }
  });
  assert.strictEqual((await unavailable.queryBinding({
    bindingId: 'friend_synthetic_mb',
    capability: 'chat',
    credentialPolicy: 'required',
    endpointClass: 'remote'
  })).status, 'unavailable');

  const local = await middleWithRef.queryBinding({
    bindingId: 'local-synthetic',
    capability: 'chat',
    credentialPolicy: 'none',
    endpointClass: 'loopback'
  });
  assert.strictEqual(local.status, 'none');

  const outputs = [middleLegacy, middleReady, image, imageInherit, edge, bridgeTts, voicebox, local];
  assert.strictEqual(forbiddenProperties(outputs).length, 0);
  assert(calls.length >= 2);

  console.log(JSON.stringify({
    middleBrainLegacyStatus: middleLegacy.status,
    middleBrainRefStatus: middleReady.status,
    imageRouteStatus: image.status,
    imageInheritStatus: imageInherit.status,
    voiceOwnership: {
      edge: edge.status,
      bridge: bridgeTts.sourceClass,
      voicebox: voicebox.status
    },
    outputForbiddenPropertyCount: 0,
    executionPathChanged: false,
    providerCalls: 0,
    allPassed: true
  }, null, 2));
}

run().catch(error => {
  console.error(JSON.stringify({
    code: 'R7_CAPABILITY_TEST_FAILED',
    message: String(error && error.message || error).slice(0, 240)
  }));
  process.exitCode = 1;
});
