'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const createCredentialVault = require('../active/credential-vault');
const createHttp = require('../active/http');

async function getJson(url, origin) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, { headers: origin ? { Origin: origin } : {} }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        let body = {};
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (_) {}
        resolve({ status: response.statusCode, body, raw: Buffer.concat(chunks).toString('utf8') });
      });
    });
    request.on('error', reject);
  });
}

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-vault-metadata-'));
  const vault = createCredentialVault({ dataDir });
  vault.load();
  vault.upsert('role_alpha', {
    displayName: 'Alpha Chat', provider: 'openai', apiKey: 'synthetic-role-secret',
    endpoint: 'https://api.example.invalid:8443/v1/chat/completions', model: 'mock-chat'
  });
  vault.upsert('ib_vault_image_1', {
    displayName: 'Image Generation', userManaged: true, provider: 'gemini',
    apiKey: 'synthetic-image-secret', endpoint: 'https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent', model: 'mock-image'
  });
  vault.upsert('legacy_query_key', {
    provider: 'openai', apiKey: 'synthetic-query-secret', endpoint: 'https://api.example.invalid/v1?api_key=synthetic-query-secret', model: 'mock-legacy'
  });

  const allowedOrigin = 'http://127.0.0.1:42987';
  const layer = createHttp({
    HOST: '127.0.0.1', PORT: 0, maxBody: 1024 * 1024,
    getState: () => ({ credentialBindings: ['role_alpha', 'ib_vault_image_1'] }),
    credentialVault: vault,
    devIdentity: { mode: 'synthetic', instanceId: 'vault-test', webOrigin: allowedOrigin },
    authorizeRequestIdentity: () => true
  });
  const server = layer.server;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  try {
    const port = server.address().port;
    const result = await getJson('http://127.0.0.1:' + port + '/credentials', allowedOrigin);
    assert.strictEqual(result.status, 200);
    assert.strictEqual(result.body.ok, true);
    assert.strictEqual(result.body.credentials.length, 3);
    assert(result.body.credentials.some(row => row.credentialRef === 'ib_vault_image_1' && row.displayName === 'Image Generation' && row.userManaged));
    assert(result.body.credentials.some(row => row.credentialRef === 'role_alpha' && row.endpointHost === 'api.example.invalid:8443' && row.endpoint === 'https://api.example.invalid:8443/v1/chat/completions' && row.authorized === true));
    assert(result.body.credentials.some(row => row.credentialRef === 'legacy_query_key' && row.endpoint === '' && row.endpointHost === '' && row.authorized === false));
    assert.strictEqual(result.body.credentials.every(row => row.secretPresent === true), true);
    assert(!/synthetic-(role|image)-secret|apiKey|ciphertext|credential-vault\.json/i.test(result.raw));

    const denied = await getJson('http://127.0.0.1:' + port + '/credentials', 'https://untrusted.example');
    assert.strictEqual(denied.status, 403);
    console.log('Credential Vault metadata: 9 checks passed; no secret material returned.');
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error && error.stack || error); process.exitCode = 1; });
