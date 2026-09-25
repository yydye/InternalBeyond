'use strict';

/* P32-W.4B · disposable provider discovery/planning only. No installer spawn. */

const assert = require('assert');
const path = require('path');
const provider = require('./p32-w4b-disposable-acceptance-provider.js');

const ROOT = path.resolve(__dirname, '..');
const installer = path.join(ROOT, 'dist', 'InternalBeyond-Setup-1.0.6.exe');

const plan = provider.prepare({
  installerPath: installer,
  forbiddenRoots: [
    'E:\\IB-C\\InternalBeyond',
    'E:\\IB-E2E-1.0.1\\InternalBeyond',
    path.join(process.env.LOCALAPPDATA || 'C:\\Users\\unknown\\AppData\\Local', 'InternalBeyond')
  ]
});

assert.ok(plan.artifact.ok, 'canonical installer artifact must be readable');
assert.ok(/^[0-9a-f]{64}$/.test(plan.artifact.sha256), 'artifact SHA256 must be structural');
assert.ok(plan.transfer && plan.transfer.mode === 'read-only-input');
assert.ok(plan.isolation && plan.isolation.registry.includes('provider-owned'));
assert.ok(['READY_FOR_PROVIDER', 'BLOCKED_ENVIRONMENT'].includes(plan.status));

const execution = provider.execute({ installerPath: installer });
assert.strictEqual(execution.execution, 'not-started');
assert.ok(['NOT_EXECUTED', 'BLOCKED_ENVIRONMENT'].includes(execution.status));

console.log(JSON.stringify({
  providerStatus: plan.discovery.status,
  selectedProvider: plan.discovery.provider && plan.discovery.provider.id,
  artifactBytes: plan.artifact.size,
  artifactSha256: plan.artifact.sha256,
  execution: execution.execution
}, null, 2));
console.log('P32-W.4B disposable acceptance provider: discovery/planning passed; installer not started');
