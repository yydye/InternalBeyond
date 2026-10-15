'use strict';

/* Offline signer for the canonical P35.2 DSH Runtime release-index payload. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const release = require('../runtime/dsh-runtime-release.js');

function arg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] || '') : fallback;
}

function fail(code) {
  process.stderr.write(code + '\n');
  process.exitCode = 1;
}

try {
  const root = path.resolve(__dirname, '..');
  const trust = release.parseTrustConfig(path.join(root, 'runtime', 'dsh-runtime-release-trust.json'));
  const keyId = arg('--key-id', trust.keys[0] && trust.keys[0].keyId || '');
  const trustedKey = trust.keys.find(item => item.keyId === keyId && item.algorithm === 'Ed25519');
  if (!trustedKey) throw new Error('runtime-release-signing-key-id-unknown');
  const defaultKey = path.join(process.env.LOCALAPPDATA || '', 'InternalBeyond', 'signing-keys',
    'p35-dsh-runtime-release-ed25519-private.pem');
  const keyFile = path.resolve(arg('--key-file', defaultKey));
  const input = path.resolve(arg('--input', ''));
  const output = path.resolve(arg('--output', ''));
  if (!input || !output || input === output || !fs.statSync(input).isFile()) throw new Error('runtime-release-signer-arguments-invalid');
  const privateKey = crypto.createPrivateKey(fs.readFileSync(keyFile));
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('runtime-release-private-key-invalid');
  const publicDer = crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
  if (publicDer.toString('base64') !== trustedKey.publicKeySpkiBase64) {
    throw new Error('runtime-release-private-key-does-not-match-pinned-key');
  }
  const payload = JSON.parse(fs.readFileSync(input, 'utf8'));
  const envelopeBytes = release.createSignedEnvelope(payload, keyId, privateKey);
  const checked = release.verifySignedEnvelope(envelopeBytes, trust);
  release.validateReleaseIndex(checked.payload, {
    productVersion: fs.readFileSync(path.join(root, 'VERSION'), 'utf8').trim(),
    nodeVersion: fs.readFileSync(path.join(root, 'runtime', 'node', 'VERSION'), 'utf8').trim(),
    artifactHosts: trust.artifactHosts
  });
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, envelopeBytes, { flag: 'wx' });
  process.stdout.write(JSON.stringify({ ok: true, output: output, keyId: keyId,
    envelopeSha256: crypto.createHash('sha256').update(envelopeBytes).digest('hex') }) + '\n');
} catch (error) {
  fail(String(error && error.message || 'runtime-release-signing-failed').slice(0, 120));
}
