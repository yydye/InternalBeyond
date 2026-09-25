'use strict';

/* Synthetic-only contract checks. No production Vault, provider, or storage is used. */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function check(value, message) {
  if (!value) throw new Error(message);
}

async function main() {
  const communication = fs.readFileSync(path.join(__dirname, '..', 'assets', 'js', 'communication.js'), 'utf8');
  const helperStart = communication.indexOf('function _ibCredentialUnavailable(){');
  const helperEnd = communication.indexOf('\nasync function callApi(cfg,userMsg,opts){', helperStart);
  check(helperStart >= 0 && helperEnd > helperStart, 'request-credential-helper-boundary');
  check(communication.includes('_callApiWithRuntimeCredential(runtimeCfg,userMsg,opts)'), 'legacy-callApi-wraps-runtime-resolver');
  check(communication.includes('_callApiChatStreamOnceWithRuntimeCredential(runtimeCfg,messages,opts)'), 'stream-provider-entry-wraps-runtime-resolver');
  check(communication.includes('_callApiChatOnceWithRuntimeCredential(runtimeCfg,messages,opts)'), 'nonstream-provider-entry-wraps-runtime-resolver');
  check(!communication.includes("String(cfg.apiKey).slice(0,6)"), 'request-debug-does-not-log-key-prefix');

  let resolveCalls = 0;
  const syntheticResolver = {
    available: true,
    resolve: async function (bindingId) {
      resolveCalls++;
      if (bindingId === 'synthetic-missing') throw new Error('synthetic secret detail must be hidden');
      return { ok: true, provider: bindingId === 'synthetic-provider-mismatch' ? 'anthropic' : 'openai', apiKey: 'synthetic-only-credential' };
    }
  };
  const window = { IB: { host: { credentialResolver: syntheticResolver } } };
  const context = { window: window, URL: URL };
  vm.runInNewContext(communication.slice(helperStart, helperEnd), context, { filename: 'communication-credential-helper.js' });

  const sourceConfig = {
    id: 'synthetic-config', provider: 'openai', endpoint: 'https://provider.invalid/v1/chat/completions',
    apiKey: 'synthetic-legacy-value', imageGenApiKey: 'synthetic-secondary-value'
  };
  let capturedRuntimeConfig = null;
  const result = await window._ibWithRuntimeApiCredential(sourceConfig, async function (runtimeConfig) {
    capturedRuntimeConfig = runtimeConfig;
    check(runtimeConfig.apiKey === 'synthetic-only-credential', 'resolver-value-injected');
    check(!Object.prototype.hasOwnProperty.call(runtimeConfig, 'imageGenApiKey'), 'secondary-secret-not-copied');
    return 'request-builder-complete';
  });
  check(result === 'request-builder-complete', 'request-callback-result');
  check(sourceConfig.apiKey === 'synthetic-legacy-value', 'source-config-not-mutated');
  check(capturedRuntimeConfig.apiKey === '', 'request-secret-cleared-after-lifecycle');

  let calledAfterFailure = false;
  try {
    await window._ibWithRuntimeApiCredential({
      id: 'synthetic-missing', provider: 'openai', endpoint: 'https://provider.invalid', apiKey: 'synthetic-legacy-value'
    }, async function () { calledAfterFailure = true; });
    throw new Error('resolver-failure-did-not-reject');
  } catch (error) {
    check(error.code === 'CREDENTIAL_UNAVAILABLE' && error.message === 'CREDENTIAL_UNAVAILABLE', 'fixed-fail-closed-error');
  }
  check(!calledAfterFailure, 'failed-resolver-never-enters-provider-builder');

  let calledAfterProviderMismatch = false;
  try {
    await window._ibWithRuntimeApiCredential({
      id: 'synthetic-provider-mismatch', provider: 'openai', endpoint: 'https://provider.invalid', apiKey: 'synthetic-legacy-value'
    }, async function () { calledAfterProviderMismatch = true; });
    throw new Error('provider-mismatch-did-not-reject');
  } catch (error) {
    check(error.code === 'CREDENTIAL_UNAVAILABLE', 'provider-binding-mismatch-fails-closed');
  }
  check(!calledAfterProviderMismatch, 'provider-mismatch-never-enters-provider-builder');

  let calledForCredentialEndpoint = false;
  try {
    await window._ibWithRuntimeApiCredential({
      id: 'synthetic-config', provider: 'openai', endpoint: 'https://provider.invalid/v1?token=synthetic-inline-secret'
    }, async function () { calledForCredentialEndpoint = true; });
    throw new Error('credential-bearing-endpoint-did-not-reject');
  } catch (error) {
    check(error.code === 'CREDENTIAL_UNAVAILABLE', 'credential-bearing-endpoint-rejected');
  }
  check(!calledForCredentialEndpoint, 'unsafe-endpoint-never-reaches-provider-builder');

  let localResolverCalls = resolveCalls;
  const localConfig = { id: 'synthetic-local', provider: 'custom', endpoint: 'http://127.0.0.1:1234/v1', apiKey: 'synthetic-legacy-value' };
  const localResult = await window._ibWithRuntimeApiCredential(localConfig, async function (runtimeConfig) {
    check(runtimeConfig.apiKey === '', 'local-route-never-copies-legacy-secret');
    return 'local-request-builder-complete';
  });
  check(localResult === 'local-request-builder-complete' && resolveCalls === localResolverCalls, 'local-route-skips-vault');

  let imageSecretRejected = false;
  try {
    await window._ibWithRuntimeApiCredential(sourceConfig, async function () {}, { rejectImageGenSecret: true });
  } catch (error) {
    imageSecretRejected = error.code === 'CREDENTIAL_UNAVAILABLE';
  }
  check(imageSecretRejected, 'separate-image-secret-fails-closed');

  const core = fs.readFileSync(path.join(__dirname, '..', 'assets', 'js', 'core.js'), 'utf8');
  check(core.includes("s==='apiConfigs'?_ibCredentialFreeApiConfig(d):d"), 'indexeddb-api-config-writes-sanitized');
  check(core.includes("if(st==='apiConfigs')arr=arr.map(_ibCredentialFreeApiConfig)"), 'emergency-mirror-api-configs-sanitized');
  const sanitizeStart = core.indexOf('function _ibEndpointHasInlineCredential(value){');
  const sanitizeEnd = core.indexOf('\nasync function dbPut(', sanitizeStart);
  check(sanitizeStart >= 0 && sanitizeEnd > sanitizeStart, 'storage-sanitizer-boundary');
  const sanitizeContext = {};
  vm.runInNewContext(core.slice(sanitizeStart, sanitizeEnd), sanitizeContext, { filename: 'core-api-config-sanitizer.js' });
  const sanitized = sanitizeContext._ibCredentialFreeApiConfig({
    id: 'synthetic-config', provider: 'openai', apiKey: 'synthetic-only-credential',
    endpoint: 'https://provider.invalid/v1?token=synthetic-inline-secret',
    nested: { imageGenApiKey: 'synthetic-secondary-value', bearer: 'synthetic-bearer', safeOption: true }
  });
  check(!Object.prototype.hasOwnProperty.call(sanitized, 'apiKey'), 'api-key-not-persistable');
  check(!Object.prototype.hasOwnProperty.call(sanitized, 'endpoint'), 'credential-bearing-endpoint-not-persistable');
  check(!Object.prototype.hasOwnProperty.call(sanitized.nested, 'imageGenApiKey'), 'image-key-not-persistable');
  check(!Object.prototype.hasOwnProperty.call(sanitized.nested, 'bearer'), 'bearer-not-persistable');
  check(sanitized.nested.safeOption === true, 'non-secret-option-preserved');

  const hostModule = require(path.join(__dirname, '..', 'assets', 'js', 'host-capability.js'));
  let nativeCallCount = 0;
  const tauriHost = hostModule.createHost({
    __TAURI__: { core: { invoke: async function (name, args) {
      nativeCallCount++;
      check(name === 'credential_resolve', 'native-resolver-command-name');
      check(args && args.bindingId === 'synthetic-config', 'native-resolver-id-binding');
      return { ok: true, provider: 'openai', apiKey: 'synthetic-only-credential' };
    } } },
    location: { protocol: 'http:', origin: 'http://tauri.localhost', search: '' },
    navigator: {}
  });
  const nativeCredential = await tauriHost.credentialResolver.resolve('synthetic-config');
  check(nativeCallCount === 1 && nativeCredential.ok === true && nativeCredential.provider === 'openai', 'tauri-host-resolver');
  nativeCredential.apiKey = '';

  const recoveryHost = hostModule.createHost({
    __TAURI__: { core: { invoke: async function () { throw new Error('not available in RecoveryOnly'); } } },
    __IB_RECOVERY_ONLY__: true,
    location: { protocol: 'http:', origin: 'http://tauri.localhost', search: '' },
    navigator: {}
  });
  check(recoveryHost.capabilities().credentialResolver.available === false, 'recoveryonly-does-not-expose-resolver');

  const workspace = fs.readFileSync(path.join(__dirname, '..', 'assets', 'js', 'workspace.js'), 'utf8');
  const imageStart = workspace.indexOf('async function _wsExecImageGen(cfg,prompt,size,opts){');
  const imageEnd = workspace.indexOf('\nasync function _wsExecImageGenWithRuntimeCredential(', imageStart);
  check(imageStart >= 0 && imageEnd > imageStart, 'image-request-bridge-boundary');
  let imageProviderBuilderCalls = 0;
  const imageWindow = {
    _ibWithRuntimeApiCredential: async function (cfg, run, options) {
      check(options && options.rejectImageGenSecret === true, 'image-bridge-rejects-separate-secret');
      const runtime = Object.assign({}, cfg, { apiKey: 'synthetic-only-credential' });
      delete runtime.imageGenApiKey;
      try { return await run(runtime); } finally { runtime.apiKey = ''; }
    }
  };
  const imageContext = {
    window: imageWindow,
    _imgResolveProvider: function () { return 'openai'; },
    _wsExecImageGenWithRuntimeCredential: async function (runtime) {
      imageProviderBuilderCalls++;
      check(runtime.apiKey === 'synthetic-only-credential', 'image-builder-receives-runtime-secret');
      check(!Object.prototype.hasOwnProperty.call(runtime, 'imageGenApiKey'), 'image-builder-has-no-persisted-image-secret');
      return { ok: true, dryRun: true };
    }
  };
  vm.runInNewContext(workspace.slice(imageStart, imageEnd), imageContext, { filename: 'workspace-image-credential-wrapper.js' });
  const imageResult = await imageContext._wsExecImageGen({ id: 'synthetic-config', provider: 'openai', imageGenProvider: 'openai' }, 'synthetic prompt', '1024x1024', {});
  check(imageResult && imageResult.ok === true && imageProviderBuilderCalls === 1, 'image-request-bridge-reaches-builder-without-network');

  const imageFailureContext = {
    window: { _ibWithRuntimeApiCredential: async function () { const error = new Error('CREDENTIAL_UNAVAILABLE'); error.code = 'CREDENTIAL_UNAVAILABLE'; throw error; } },
    _imgResolveProvider: function () { return 'openai'; },
    _wsExecImageGenWithRuntimeCredential: async function () { throw new Error('must-not-reach-provider-builder'); }
  };
  vm.runInNewContext(workspace.slice(imageStart, imageEnd), imageFailureContext, { filename: 'workspace-image-credential-failure.js' });
  const imageFailure = await imageFailureContext._wsExecImageGen({ id: 'synthetic-missing', provider: 'openai' }, 'synthetic prompt', '1024x1024', {});
  check(imageFailure && imageFailure.code === 'CREDENTIAL_UNAVAILABLE', 'image-resolver-failure-code');

  process.stdout.write('CREDENTIAL_BRIDGE_R1_SYNTHETIC_PASS\n');
}

main().catch(function (error) {
  process.stderr.write('CREDENTIAL_BRIDGE_R1_SYNTHETIC_FAIL:' + String(error && error.message || 'unknown') + '\n');
  process.exitCode = 1;
});
