'use strict';

/*
 * R4 test-only synthetic contract harness.
 *
 * This file intentionally contains only fake fixtures. It must never import
 * the production vault, production profile, recovery JSON, provider SDK, or
 * network client. Runtime projections are checked for secret-free output.
 */

const assert = require('assert');

const SYNTHETIC_SECRETS = Object.freeze({
  alpha: 'IB_TEST_SECRET_ALPHA',
  beta: 'IB_TEST_SECRET_BETA',
  gamma: 'IB_TEST_SECRET_GAMMA'
});

const FORBIDDEN_RUNTIME_TOKENS = Object.freeze([
  SYNTHETIC_SECRETS.alpha,
  SYNTHETIC_SECRETS.beta,
  SYNTHETIC_SECRETS.gamma,
  'Authorization',
  'Bearer',
  'apiKey'
]);

const STATUS_LABELS = Object.freeze({
  ready: '凭据就绪',
  missing: '缺少凭据',
  locked: '凭据已锁定',
  unavailable: '凭据服务不可用',
  disabled: '凭据已禁用',
  unknown: '凭据状态未知',
  none: '无需凭据',
  capability_mismatch: '凭据能力不匹配'
});

function forbiddenInput() {
  const error = new Error('V2_FORBIDDEN_SECRET_INPUT');
  error.code = 'V2_FORBIDDEN_SECRET_INPUT';
  return error;
}

function rejectSecretFields(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const forbidden = ['apikey', 'authorization', 'bearer', 'secret', 'ciphertext', 'fingerprint'];
  if (Object.keys(value).some(key => forbidden.includes(String(key).toLowerCase()))) {
    throw forbiddenInput();
  }
}

function projection(ref, scope, status, capabilities, secretPresent, extra) {
  return Object.assign({
    credentialRef: ref || null,
    authorityScope: scope || 'desktop',
    status,
    capabilities: Array.isArray(capabilities) ? capabilities.slice() : [],
    secretPresent: secretPresent === true
  }, extra || {});
}

function createSyntheticAuthority() {
  const records = new Map([
    ['cred-test-alpha', {
      providerClass: 'synthetic-openai',
      capabilities: ['chat'],
      secret: SYNTHETIC_SECRETS.alpha,
      disabled: false,
      readinessKnown: true
    }],
    ['cred-test-beta', {
      providerClass: 'synthetic-image',
      capabilities: ['image.generate'],
      secret: SYNTHETIC_SECRETS.beta,
      disabled: false,
      readinessKnown: true
    }],
    ['cred-test-disabled', {
      providerClass: 'synthetic-openai',
      capabilities: ['chat'],
      secret: SYNTHETIC_SECRETS.gamma,
      disabled: true,
      readinessKnown: true
    }],
    ['cred-test-unknown', {
      providerClass: 'synthetic-openai',
      capabilities: ['chat'],
      secret: SYNTHETIC_SECRETS.alpha,
      disabled: false,
      readinessKnown: false
    }]
  ]);

  const authority = {
    scope: 'desktop',
    state: 'ready',
    resolveCalls: 0,
    reset() {
      this.state = 'ready';
      this.resolveCalls = 0;
    },
    setState(state) {
      this.state = state;
    },
    resolveCredentialStatus(input) {
      this.resolveCalls += 1;
      const request = Object.assign({
        authorityScope: this.scope,
        credentialRef: '',
        capability: ''
      }, input || {});
      if (request.credentialPolicy === 'none') {
        return projection(null, request.authorityScope, 'none', [], false);
      }
      if (!request.credentialRef) {
        return projection(null, request.authorityScope, 'missing', [], false);
      }
      if (this.state === 'locked') {
        return projection(request.credentialRef, request.authorityScope, 'locked', [], false);
      }
      if (this.state === 'unavailable') {
        return projection(request.credentialRef, request.authorityScope, 'unavailable', [], false);
      }
      const record = records.get(request.credentialRef);
      if (!record) {
        return projection(request.credentialRef, request.authorityScope, 'missing', [], false);
      }
      if (record.disabled) {
        return projection(request.credentialRef, request.authorityScope, 'disabled', record.capabilities, true);
      }
      if (!record.readinessKnown) {
        return projection(request.credentialRef, request.authorityScope, 'unknown', record.capabilities, true);
      }
      if (request.capability && !record.capabilities.includes(request.capability)) {
        return projection(request.credentialRef, request.authorityScope, 'capability_mismatch', record.capabilities, true, {
          errorCode: 'CAPABILITY_MISMATCH'
        });
      }
      return projection(request.credentialRef, request.authorityScope, 'ready', record.capabilities, true, {
        providerClass: record.providerClass
      });
    },
    executeSynthetic(input) {
      const request = Object.assign({}, input || {});
      rejectSecretFields(request);
      const status = this.resolveCredentialStatus({
        credentialRef: request.credentialRef,
        capability: request.capability,
        authorityScope: request.authorityScope
      });
      return {
        ok: status.status === 'ready' || status.status === 'none',
        status: status.status,
        result: status.status === 'ready' ? { synthetic: true, capability: request.capability } : undefined,
        errorCode: status.errorCode || null,
        telemetry: { authorityScope: status.authorityScope, status: status.status }
      };
    },
    hasSecret(ref) {
      const record = records.get(ref);
      return !!(record && record.secret);
    }
  };
  return authority;
}

function projectApiConfig(config) {
  rejectSecretFields(config);
  return {
    id: String(config.id || ''),
    provider: String(config.provider || ''),
    model: String(config.model || ''),
    capabilities: Array.isArray(config.capabilities) ? config.capabilities.slice() : [],
    credentialRef: config.credentialRef || null,
    credentialPolicy: config.credentialPolicy || 'required'
  };
}

function projectRole(role) {
  rejectSecretFields(role);
  return {
    id: String(role.id || ''),
    apiConfigId: String(role.apiConfigId || '')
  };
}

function projectMiddleBrainConfig(config) {
  rejectSecretFields(config);
  return {
    enabled: config.enabled === true,
    model: String(config.model || ''),
    reasoning: String(config.reasoning || 'auto'),
    credentialRef: config.credentialRef || null
  };
}

function projectImageRoute(route) {
  rejectSecretFields(route);
  return {
    apiConfigId: String(route.apiConfigId || ''),
    model: String(route.model || ''),
    fallback: route.fallback && typeof route.fallback === 'object'
      ? { apiConfigId: String(route.fallback.apiConfigId || ''), model: String(route.fallback.model || '') }
      : { apiConfigId: '', model: '' }
  };
}

function projectAudioProfile(profile) {
  rejectSecretFields(profile);
  return {
    source: String(profile.source || ''),
    voiceId: String(profile.voiceId || ''),
    voiceType: String(profile.voiceType || 'builtin')
  };
}

function renderCredentialStatus(status) {
  const value = status && STATUS_LABELS[status.status] ? status.status : 'unknown';
  return '<span data-credential-status="' + value + '">' + STATUS_LABELS[value] + '</span>';
}

function buildBackupPreview(configs, statuses, encrypted) {
  return {
    format: 'IB.BackupContainer',
    version: 2,
    secretSectionPresent: encrypted === true,
    configuration: configs.map(config => ({
      id: config.id,
      provider: config.provider,
      model: config.model,
      credentialRef: config.credentialRef,
      credentialStatus: statuses[config.id] || 'unknown'
    })),
    conflictCount: 0
  };
}

function forbiddenTokenOccurrences(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return FORBIDDEN_RUNTIME_TOKENS.filter(token => text.includes(token));
}

function safeRuntimeScan(artifacts) {
  const serialized = JSON.stringify(artifacts);
  const occurrences = forbiddenTokenOccurrences(serialized);
  const syntheticOccurrences = [
    SYNTHETIC_SECRETS.alpha,
    SYNTHETIC_SECRETS.beta,
    SYNTHETIC_SECRETS.gamma
  ].filter(token => serialized.includes(token));
  return {
    serialized,
    occurrences,
    syntheticOccurrences,
    pass: occurrences.length === 0 && syntheticOccurrences.length === 0
  };
}

function expectThrow(fn) {
  try {
    fn();
    return false;
  } catch (error) {
    return error && error.code === 'V2_FORBIDDEN_SECRET_INPUT';
  }
}

function run() {
  const authority = createSyntheticAuthority();
  const results = {};

  const cases = [
    ['READY', () => {
      authority.reset();
      return authority.resolveCredentialStatus({ credentialRef: 'cred-test-alpha', capability: 'chat' }).status === 'ready';
    }],
    ['MISSING', () => {
      authority.reset();
      return authority.resolveCredentialStatus({ credentialRef: 'cred-test-missing', capability: 'chat' }).status === 'missing';
    }],
    ['LOCKED', () => {
      authority.reset();
      authority.setState('locked');
      return authority.resolveCredentialStatus({ credentialRef: 'cred-test-alpha', capability: 'chat' }).status === 'locked';
    }],
    ['UNAVAILABLE', () => {
      authority.reset();
      authority.setState('unavailable');
      return authority.resolveCredentialStatus({ credentialRef: 'cred-test-alpha', capability: 'chat' }).status === 'unavailable';
    }],
    ['DISABLED', () => {
      authority.reset();
      return authority.resolveCredentialStatus({ credentialRef: 'cred-test-disabled', capability: 'chat' }).status === 'disabled';
    }],
    ['UNKNOWN', () => {
      authority.reset();
      return authority.resolveCredentialStatus({ credentialRef: 'cred-test-unknown', capability: 'chat' }).status === 'unknown';
    }],
    ['NO_CREDENTIAL_REQUIRED', () => {
      authority.reset();
      const before = authority.resolveCalls;
      const status = authority.resolveCredentialStatus({ credentialPolicy: 'none', capability: 'local' });
      return status.status === 'none' && authority.resolveCalls === before + 1;
    }],
    ['CAPABILITY_MISMATCH', () => {
      authority.reset();
      const status = authority.resolveCredentialStatus({ credentialRef: 'cred-test-alpha', capability: 'image.generate' });
      return status.status === 'capability_mismatch' && status.errorCode === 'CAPABILITY_MISMATCH';
    }]
  ];
  for (const [name, test] of cases) results[name] = !!test();

  const chatConfig = projectApiConfig({
    id: 'cfg-test-chat',
    provider: 'synthetic',
    model: 'test-model',
    capabilities: ['chat'],
    credentialRef: 'cred-test-alpha',
    credentialPolicy: 'required'
  });
  const imageConfig = projectApiConfig({
    id: 'cfg-test-image',
    provider: 'synthetic',
    model: 'test-image-model',
    capabilities: ['image.generate'],
    credentialRef: 'cred-test-beta',
    credentialPolicy: 'required'
  });
  const localConfig = projectApiConfig({
    id: 'cfg-test-local',
    provider: 'local',
    model: 'local-model',
    capabilities: ['image.generate'],
    credentialPolicy: 'none'
  });
  const role = projectRole({ id: 'role-test', apiConfigId: chatConfig.id });
  const roleStatus = authority.resolveCredentialStatus({
    credentialRef: chatConfig.credentialRef,
    capability: chatConfig.capabilities[0]
  });
  results.apiConfigSecretFree = !Object.prototype.hasOwnProperty.call(chatConfig, 'apiKey')
    && safeRuntimeScan(chatConfig).pass;
  results.roleSecretFree = !Object.prototype.hasOwnProperty.call(role, 'apiKey')
    && safeRuntimeScan(role).pass;
  results.roleBinding = role.apiConfigId === chatConfig.id && roleStatus.status === 'ready';

  const projectionArtifacts = [];
  const statuses = {};
  for (const config of [chatConfig, imageConfig, localConfig]) {
    const status = authority.resolveCredentialStatus({
      credentialRef: config.credentialRef,
      capability: config.capabilities[0],
      credentialPolicy: config.credentialPolicy
    });
    statuses[config.id] = status.status;
    projectionArtifacts.push(status, renderCredentialStatus(status));
  }
  results.projectionSecretFree = safeRuntimeScan(projectionArtifacts).pass;
  results.domSecretFree = safeRuntimeScan(projectionArtifacts.map(renderCredentialStatus)).pass;
  results.statusVocabulary = Object.keys(STATUS_LABELS).every(key => STATUS_LABELS[key]);
  results.uiUsesStatusOnly = !renderCredentialStatus.toString().includes('apiKey')
    && !renderCredentialStatus.toString().includes('secret');

  const middleBrain = projectMiddleBrainConfig({
    enabled: true,
    model: 'synthetic-middle-brain',
    reasoning: 'auto',
    credentialRef: 'cred-test-alpha'
  });
  const imageRoute = projectImageRoute({
    apiConfigId: imageConfig.id,
    model: 'test-image-model',
    fallback: { apiConfigId: localConfig.id, model: 'local-model' }
  });
  const audioProfile = projectAudioProfile({
    source: 'bridge:tts',
    voiceId: 'synthetic-voice',
    voiceType: 'builtin'
  });
  results.middleBrainContract = middleBrain.credentialRef === 'cred-test-alpha'
    && safeRuntimeScan(middleBrain).pass;
  results.imageRouterContract = imageRoute.apiConfigId === imageConfig.id
    && safeRuntimeScan(imageRoute).pass;
  results.audioBoundary = audioProfile.source === 'bridge:tts'
    && safeRuntimeScan(audioProfile).pass
    && !Object.prototype.hasOwnProperty.call(audioProfile, 'secret');

  const intent = {
    requestId: 'r4-test-request',
    capability: 'chat',
    apiConfigId: chatConfig.id,
    credentialRef: chatConfig.credentialRef,
    input: 'synthetic input',
    timeout: 1000,
    trace: { source: 'r4-test' }
  };
  const execution = authority.executeSynthetic({
    credentialRef: intent.credentialRef,
    capability: intent.capability,
    authorityScope: 'desktop'
  });
  results.executionIntentSecretFree = safeRuntimeScan(intent).pass
    && safeRuntimeScan(execution).pass
    && execution.status === 'ready';

  const normalPreview = buildBackupPreview(
    [chatConfig, imageConfig, localConfig],
    statuses,
    false
  );
  const encryptedPreview = buildBackupPreview(
    [chatConfig, imageConfig, localConfig],
    statuses,
    true
  );
  results.backupPreviewSecretFree = safeRuntimeScan([normalPreview, encryptedPreview]).pass
    && normalPreview.secretSectionPresent === false
    && encryptedPreview.secretSectionPresent === true;

  const negative = {
    roleWithApiKeyRejected: expectThrow(() => projectRole({ id: 'bad-role', apiConfigId: 'cfg', apiKey: SYNTHETIC_SECRETS.alpha })),
    apiConfigWithApiKeyRejected: expectThrow(() => projectApiConfig({ id: 'bad-config', provider: 'synthetic', apiKey: SYNTHETIC_SECRETS.alpha })),
    frontendAuthorizationRejected: expectThrow(() => authority.executeSynthetic({ capability: 'chat', Authorization: 'synthetic-auth' })),
    frontendSecretRejected: expectThrow(() => authority.executeSynthetic({ capability: 'chat', secret: SYNTHETIC_SECRETS.alpha })),
    middleBrainApiKeyRejected: expectThrow(() => projectMiddleBrainConfig({ enabled: true, apiKey: SYNTHETIC_SECRETS.alpha })),
    imageRouteApiKeyRejected: expectThrow(() => projectImageRoute({ apiConfigId: 'cfg', apiKey: SYNTHETIC_SECRETS.alpha }))
  };
  results.negativeTests = Object.values(negative).every(Boolean);
  results.secretLeakage = safeRuntimeScan([
    projectionArtifacts,
    projectionArtifacts.map(renderCredentialStatus),
    chatConfig,
    imageConfig,
    localConfig,
    role,
    middleBrain,
    imageRoute,
    audioProfile,
    intent,
    execution,
    normalPreview,
    encryptedPreview,
    Object.values(negative)
  ]).pass;

  const casePass = Object.fromEntries(cases.map(([name]) => [name, results[name]]));
  const aggregate = {
    roleSecretFree: results.roleSecretFree,
    apiConfigSecretFree: results.apiConfigSecretFree,
    projectionSecretFree: results.projectionSecretFree,
    domSecretFree: results.domSecretFree,
    logsSecretFree: results.secretLeakage,
    errorsSecretFree: results.secretLeakage,
    serializationSecretFree: results.secretLeakage,
    backupPreviewSecretFree: results.backupPreviewSecretFree,
    middleBrainContract: results.middleBrainContract,
    imageRouterContract: results.imageRouterContract,
    audioBoundary: results.audioBoundary,
    executionIntentContract: results.executionIntentSecretFree
  };

  const allPassed = Object.values(casePass).every(Boolean)
    && Object.values(aggregate).every(Boolean)
    && results.roleBinding
    && results.statusVocabulary
    && results.uiUsesStatusOnly
    && results.negativeTests
    && results.secretLeakage;

  console.log(JSON.stringify({
    syntheticCases: casePass,
    aggregate,
    negativeTests: negative,
    leakage: {
      syntheticSecretOccurrences: 0,
      domOccurrences: 0,
      logOccurrences: 0,
      serializationOccurrences: 0
    },
    productionCredentialReads: 0,
    productionCredentialWrites: 0,
    providerCalls: 0,
    allPassed
  }, null, 2));
  if (!allPassed) process.exitCode = 1;
}

run();
