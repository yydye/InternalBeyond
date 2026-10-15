'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const route = require('../assets/js/work-mode-provider-route.js');
const consent = require('../assets/js/work-mode-consent-core.js');

test('consent identities use the same trimmed, URL-normalized route as execution', async () => {
  const source = { id: 'agent-1', provider: 'openai', model: 'model-1', endpoint: ' HTTPS://EXAMPLE.COM:443/v1/chat/completions ' };
  const selected = route.normalize(source);
  assert.deepEqual(selected, {
    providerRef: 'agent-1', provider: 'openai', model: 'model-1',
    endpoint: 'https://example.com/v1/chat/completions', credentialRef: 'agent-1'
  });
  const rawScope = await consent.providerScope('agent', selected.providerRef, source, crypto.webcrypto);
  const effectiveScope = await consent.providerScope('agent', selected.providerRef, selected, crypto.webcrypto);
  assert.equal(rawScope.routeHash, effectiveScope.routeHash);
});

test('invalid and overlength Provider routes fail closed without truncation', () => {
  assert.equal(route.normalize({ id: 'agent-1', provider: 'openai', model: 'm', endpoint: 'https://example.test/' + 'x'.repeat(2050) }), null);
  assert.equal(route.normalize({ id: 'agent-1', provider: 'openai', model: 'm', endpoint: 'https://u:p@example.test/v1' }), null);
  assert.equal(route.normalize({ id: 'agent-1', provider: 'openai', model: 'm', endpoint: 'file:///tmp/provider' }), null);
  assert.equal(route.normalize({ id: 'agent-1', provider: 'openai', model: 'm', endpoint: 'https://example.test/v1#fragment' }), null);
});
