'use strict';

/*
 * Credential Write Path regression, synthetic-only.
 * Uses the real Active /credentials route, encrypted Vault, resolver CLI,
 * UI writer/persistence helpers, request-scoped runtime wrapper, and a local
 * mock provider. Keys are never printed or retained in provider observations.
 */
const assert = require('assert');
const childProcess = require('child_process');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const ACTIVE = path.join(ROOT, 'services', 'active-message-service.js');
const RESOLVER = path.join(ROOT, 'active', 'credential-resolver-cli.js');
const STATUS = path.join(ROOT, 'active', 'credential-authority-adapter-cli.js');
const SOCIAL = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'social.js'), 'utf8');
const CORE = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'core.js'), 'utf8');
const COMMUNICATION = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'communication.js'), 'utf8');
const VOICE = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'communication', 'voice.js'), 'utf8');
const MOBILE_DTO = require(path.join(ROOT, 'assets', 'js', 'mobile-dto.js'));

const KEY_A = 'SYNTHETIC_WRITE_PATH_KEY_A_91';
const KEY_B = 'SYNTHETIC_WRITE_PATH_KEY_B_82';
const KEY_OLD = 'SYNTHETIC_WRITE_PATH_KEY_OLD_73';
const KEY_LEGACY = 'SYNTHETIC_WRITE_PATH_KEY_LEGACY_64';
const KEY_SETTINGS = 'SYNTHETIC_WRITE_PATH_KEY_SETTINGS_56';
const KEY_INLINE = 'SYNTHETIC_WRITE_PATH_INLINE_MUST_NOT_WIN_55';

let passed = 0;
function check(name, condition) {
  assert.ok(condition, name);
  passed += 1;
  process.stdout.write('PASS ' + name + '\n');
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

function requestJson(port, method, pathname, body, headers) {
  return new Promise((resolve, reject) => {
    const raw = body == null ? '' : JSON.stringify(body);
    const request = http.request({
      host: '127.0.0.1',
      port,
      method,
      path: pathname,
      headers: Object.assign({}, headers || {}, raw ? {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(raw)
      } : {})
    }, response => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { text += chunk; });
      response.on('end', () => {
        let parsed = {};
        try { parsed = text ? JSON.parse(text) : {}; } catch (_) {}
        resolve({ status: response.statusCode, body: parsed });
      });
    });
    request.on('error', reject);
    request.end(raw || undefined);
  });
}

function makeProvider() {
  const observations = [];
  const server = http.createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      const authorization = String(request.headers.authorization || '');
      observations.push({
        hasAuthorization: /^Bearer\s+\S+$/.test(authorization),
        usedA: authorization === 'Bearer ' + KEY_A,
        usedB: authorization === 'Bearer ' + KEY_B,
        usedOld: authorization === 'Bearer ' + KEY_OLD,
        usedLegacy: authorization === 'Bearer ' + KEY_LEGACY,
        usedSettings: authorization === 'Bearer ' + KEY_SETTINGS,
        bodyContainsSecret: [KEY_A, KEY_B, KEY_OLD, KEY_LEGACY, KEY_SETTINGS, KEY_INLINE].some(key => body.includes(key))
      });
      response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify({ ok: true, text: 'mock-provider-ok' }));
    });
  });
  return { server, observations };
}

function spawnResolver(bindingId, localAppData, activeDataDir, credentialDataDir) {
  const result = childProcess.spawnSync(process.execPath, [RESOLVER], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      LOCALAPPDATA: localAppData,
      IB_ACTIVE_DATA_DIR: activeDataDir,
      IB_CREDENTIAL_DATA_DIR: credentialDataDir
    }),
    input: JSON.stringify({ bindingId: bindingId }),
    encoding: 'utf8',
    timeout: 15000,
    windowsHide: true
  });
  assert.strictEqual(result.status, 0, 'credential resolver CLI exits successfully');
  return JSON.parse(result.stdout || '{}');
}

function sourceBetween(source, startText, endText) {
  const start = source.indexOf(startText);
  const end = source.indexOf(endText, start);
  assert.ok(start >= 0 && end > start, 'source boundary: ' + startText);
  return source.slice(start, end);
}

async function main() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-credential-write-path-'));
  const dataDir = path.join(tempRoot, 'InternalBeyond');
  const credentialDataDir = path.join(tempRoot, 'CredentialVault');
  const apiConfigFile = path.join(tempRoot, 'api-configs.json');
  const apiSettingsFile = path.join(tempRoot, 'api-settings.json');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(credentialDataDir, { recursive: true });
  fs.writeFileSync(apiConfigFile, '[]', 'utf8');
  fs.writeFileSync(apiSettingsFile, '[]', 'utf8');

  let active = null;
  let activeLogs = '';
  let activePort = 0;
  let provider = null;
  let providerPort = 0;

  async function startActive() {
    activePort = await freePort();
    const child = childProcess.spawn(process.execPath, [ACTIVE], {
      cwd: ROOT,
      env: Object.assign({}, process.env, {
        LOCALAPPDATA: tempRoot,
        IB_ACTIVE_DATA_DIR: dataDir,
        IB_CREDENTIAL_DATA_DIR: credentialDataDir,
        IB_ACTIVE_PORT: String(activePort),
        IB_ACTIVE_START_DELAY_MS: '350'
      }),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });
    child.stdout.on('data', chunk => { activeLogs = (activeLogs + chunk.toString('utf8')).slice(-200000); });
    child.stderr.on('data', chunk => { activeLogs = (activeLogs + chunk.toString('utf8')).slice(-200000); });
    for (let i = 0; i < 120; i += 1) {
      if (child.exitCode != null) throw new Error('active service exited before health');
      try {
        const health = await requestJson(activePort, 'GET', '/health');
        if (health.status === 200) return child;
      } catch (_) {}
      await new Promise(resolve => setTimeout(resolve, 80));
    }
    child.kill();
    throw new Error('active service health timeout');
  }

  async function stopActive() {
    if (!active) return;
    const child = active;
    active = null;
    child.kill();
    await Promise.race([
      new Promise(resolve => child.once('exit', resolve)),
      new Promise(resolve => setTimeout(resolve, 2500))
    ]);
  }

  function configRows() {
    return JSON.parse(fs.readFileSync(apiConfigFile, 'utf8'));
  }
  function saveConfigRows(rows) {
    fs.writeFileSync(apiConfigFile, JSON.stringify(rows), 'utf8');
  }
  function settingRows() { return JSON.parse(fs.readFileSync(apiSettingsFile, 'utf8')); }
  function saveSettingRows(rows) { fs.writeFileSync(apiSettingsFile, JSON.stringify(rows), 'utf8'); }

  try {
    const mock = makeProvider();
    provider = mock.server;
    await new Promise((resolve, reject) => provider.listen(0, '127.0.0.1', error => error ? reject(error) : resolve()));
    providerPort = provider.address().port;
    active = await startActive();

    const writerStart = SOCIAL.indexOf('let _ibCredModalCtx=null;');
    const writerEnd = SOCIAL.indexOf('\nvar _dragApiIdx=null;', writerStart);
    assert.ok(writerStart >= 0 && writerEnd > writerStart, 'credential UI helper source exists');
    const credentialReferenceCounter = sourceBetween(SOCIAL, 'async function _ibCountCredentialReferences(ref,excludeChatConfigId,excludeConfigId,excludePresetConfigId){', '\nfunction _ibCredentialDisplayName');
    assert.ok(credentialReferenceCounter.includes('async function _ibCountCredentialReferences'), 'credential reference guard exists');
    const persistSource = sourceBetween(SOCIAL, 'async function _persistApiConfig(cfg){', '\n/* 保存提示语');
    const coreSanitizer = sourceBetween(CORE, 'function _ibEndpointHasInlineCredential(value){', '\nasync function dbPut(');

    const ctx = {
      URL,
      Promise,
      Date,
      Object,
      String,
      Array,
      Error,
      console: { warn: function () {}, error: function () {}, log: function () {} },
      window: {},
      document: { getElementById: function (id) { return dom[id] || null; } },
      apiConfigs: [],
      _activeCompanionRequest: async function (route, options) {
        const response = await requestJson(activePort, String(options && options.method || 'GET'), route, options && options.body);
        if (response.status < 200 || response.status >= 300) throw new Error('active-http-' + response.status);
        return response.body;
      },
      _ibMarkBusinessDataPresent: function () {},
      _apiFallbackPut: function (record) {
        const rows = configRows().filter(item => item.id !== record.id);
        rows.push(record);
        saveConfigRows(rows);
        return 'persistent';
      },
      _apiFallbackRead: configRows,
      dbPut: async function (store, record) {
        if (store === 'apiConfigs') {
          const clean = ctx._ibCredentialFreeApiConfig(record);
          const rows = configRows().filter(item => item.id !== clean.id);
          rows.push(clean);
          saveConfigRows(rows);
          return;
        }
        if (store === 'apiSettings') {
          const rows = settingRows().filter(item => item.id !== record.id);
          rows.push(record);
          saveSettingRows(rows);
          return;
        }
        throw new Error('unexpected-store');
      },
      dbGet: async function (store, id) {
        if (store === 'apiConfigs') return configRows().find(item => item.id === id) || null;
        if (store === 'apiSettings') return settingRows().find(item => item.id === id) || null;
        return null;
      },
      _ibApiConfigCredentialRef: function (cfg) {
        return cfg && Object.prototype.hasOwnProperty.call(cfg, 'credentialRef')
          ? String(cfg.credentialRef || '').trim()
          : String(cfg && cfg.id || '').trim();
      },
      _ibApiIdAllowed: function (value) { return /^[A-Za-z0-9_.:-]{1,180}$/.test(String(value == null ? '' : value)); },
      renderApiList: async function () {
        ctx.apiConfigs = configRows();
      },
      toast: function () {},
      windowConfirm: function () { return true; }
    };
    const dom = {
      'ib-cred-modal-backdrop': { hidden: true },
      'ib-cred-modal-title': { textContent: '' },
      'ib-cred-modal-provider': { textContent: '' },
      'ib-cred-modal-name': { textContent: '' },
      'ib-cred-modal-key': { value: '', focus: function () {} },
      'ib-cred-modal-save': { disabled: false },
      'ib-cred-modal-clear': { hidden: true, disabled: false }
    };
    ctx.toast = function () {};
    ctx.window.confirm = function () { return true; };
    ctx.window.setTimeout = function (callback) { if (typeof callback === 'function') callback(); return 0; };
    ctx.window._activeCompanionRequest = ctx._activeCompanionRequest;
    ctx.window._ibEndpointHasInlineCredential = value => /[?&](?:key|token|api[_-]?key)=/i.test(String(value || ''));
    vm.createContext(ctx);
    vm.runInContext(coreSanitizer, ctx, { filename: 'core-credential-sanitizer.js' });
    ctx.window._ibCredentialFreeApiConfig = ctx._ibCredentialFreeApiConfig;
    ctx._ibApiConfigStorageCopy = value => ctx._ibCredentialFreeApiConfig(value);
    vm.runInContext(persistSource + "\nconst API_PROFILE_PRESET_STORAGE_ID='api_profile_presets_v1';\n" + credentialReferenceCounter + '\n' + SOCIAL.slice(writerStart, writerEnd), ctx, { filename: 'credential-ui-write-seam.js' });

    const runtimeStart = COMMUNICATION.indexOf('function _ibCredentialUnavailable(){');
    const runtimeEnd = COMMUNICATION.indexOf('\nasync function callApi(cfg,userMsg,opts){', runtimeStart);
    assert.ok(runtimeStart >= 0 && runtimeEnd > runtimeStart, 'request-scoped runtime boundary exists');
    const host = {
      credentialResolver: {
        available: true,
        resolve: async function (bindingId) {
          const result = spawnResolver(bindingId, tempRoot, dataDir, credentialDataDir);
          if (result && result.ok === true) return result;
          return { ok: false, errorCode: 'CREDENTIAL_UNAVAILABLE' };
        }
      }
    };
    const runtimeWindow = { IB: { host: host } };
    const runtimeCtx = { window: runtimeWindow, URL: URL, Promise: Promise, Object: Object, String: String, Error: Error };
    vm.createContext(runtimeCtx);
    vm.runInContext(COMMUNICATION.slice(runtimeStart, runtimeEnd), runtimeCtx, { filename: 'communication-credential-runtime.js' });

    async function saveThroughKeyModal(configId, mode, key) {
      ctx.window._ibOpenApiKeyModal(configId, mode);
      dom['ib-cred-modal-key'].value = key;
      await ctx.window._ibSaveApiKey(null);
      return await ctx.dbGet('apiConfigs', configId);
    }

    async function callMock(config) {
      let runtimeConfig = null;
      const result = await runtimeWindow._ibWithRuntimeApiCredential(config, async function (scoped) {
        runtimeConfig = scoped;
        return requestJson(providerPort, 'POST', '/mock/chat', {}, {
          Authorization: 'Bearer ' + String(scoped.apiKey || '')
        });
      });
      return { result: result, secretCleared: !!runtimeConfig && runtimeConfig.apiKey === '' };
    }

    const apiConfigId = 'write_path_role_' + Date.now();
    await ctx._persistApiConfig({
      id: apiConfigId,
      provider: 'openai',
      model: 'mock-model',
      endpoint: 'https://mock-provider.invalid/v1/chat/completions',
      nickname: 'synthetic write path'
    });
    ctx.apiConfigs = configRows();
    check('create config + Key-A returns and persists credentialRef', (await saveThroughKeyModal(apiConfigId, 'add', KEY_A)).credentialRef === apiConfigId);

    let call = await callMock(await ctx.dbGet('apiConfigs', apiConfigId));
    check('provider mock receives Key-A', call.result.status === 200 && mock.observations[0].usedA && !mock.observations[0].bodyContainsSecret);
    check('request-scoped runtime clears Key-A after provider response', call.secretCleared);

    ctx.apiConfigs = configRows();
    check('update existing credential writes Key-B to the same ref', (await saveThroughKeyModal(apiConfigId, 'replace', KEY_B)).credentialRef === apiConfigId);
    call = await callMock(await ctx.dbGet('apiConfigs', apiConfigId));
    check('no-restart request uses Key-B', call.result.status === 200 && mock.observations[1].usedB);

    const activeStatus = await new Promise((resolve, reject) => {
      const child = childProcess.spawn(process.execPath, [STATUS], {
        cwd: ROOT,
        env: Object.assign({}, process.env, {
          LOCALAPPDATA: tempRoot,
          IB_ACTIVE_DATA_DIR: dataDir,
          IB_CREDENTIAL_DATA_DIR: credentialDataDir
        }),
        input: JSON.stringify({ bindings: [{ bindingId: apiConfigId, credentialPolicy: 'required', endpointClass: 'remote' }] }),
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true
      });
      let stdout = '';
      child.stdout.on('data', chunk => { stdout += chunk.toString('utf8'); });
      child.once('error', reject);
      child.once('close', code => {
        if (code !== 0) return reject(new Error('credential status CLI failed'));
        try { resolve(JSON.parse(stdout || '{}')); } catch (error) { reject(error); }
      });
      child.stdin.end(JSON.stringify({ bindings: [{ bindingId: apiConfigId, credentialPolicy: 'required', endpointClass: 'remote' }] }));
    });
    check('credential status becomes ready for a newly written ref', activeStatus.ok === true && activeStatus.results[0].status === 'ready');
    check('status projection has no plaintext secret fields', !Object.prototype.hasOwnProperty.call(activeStatus.results[0], 'apiKey')
      && !Object.prototype.hasOwnProperty.call(activeStatus.results[0], 'secret'));

    await stopActive();
    active = await startActive();
    ctx.apiConfigs = configRows();
    call = await callMock(await ctx.dbGet('apiConfigs', apiConfigId));
    check('restart preserves Key-B and resolver access', call.result.status === 200 && mock.observations[2].usedB && call.secretCleared);

    const staleRole = 'write_path_stale_role_' + Date.now();
    const oldRef = 'write_path_old_binding_' + Date.now();
    await ctx._persistApiConfig({
      id: staleRole,
      credentialRef: oldRef,
      provider: 'openai',
      model: 'mock-model',
      endpoint: 'https://mock-provider.invalid/v1/chat/completions'
    });
    ctx.apiConfigs = configRows();
    await ctx._ibWriteVaultCredential(oldRef, { provider: 'openai', endpoint: 'https://mock-provider.invalid/v1/chat/completions', model: 'mock-model' }, KEY_OLD);
    call = await callMock(Object.assign({}, await ctx.dbGet('apiConfigs', staleRole), { apiKey: KEY_INLINE }));
    check('stale credentialRef wins over inline apiKey', call.result.status === 200 && mock.observations[3].usedOld && call.secretCleared);
    ctx.apiConfigs = configRows();
    check('editing stale ref updates the referenced Vault binding', await ctx._ibSaveApiConfigCredential(staleRole, KEY_B) === oldRef);
    call = await callMock(Object.assign({}, await ctx.dbGet('apiConfigs', staleRole), { apiKey: KEY_INLINE }));
    check('updated stale ref immediately uses Key-B', call.result.status === 200 && mock.observations[4].usedB);

    const callsBeforeMissing = mock.observations.length;
    let missingRejected = false;
    try {
      await callMock({ id: 'missing_role', credentialRef: 'missing_binding', provider: 'openai', endpoint: 'https://mock-provider.invalid/v1/chat/completions', apiKey: KEY_INLINE });
    } catch (error) { missingRejected = error && error.code === 'CREDENTIAL_UNAVAILABLE'; }
    check('missing Vault credential fails closed despite inline apiKey', missingRejected && mock.observations.length === callsBeforeMissing);

    ctx.apiConfigs = configRows();
    await ctx._ibClearApiConfigCredential(staleRole, false);
    const cleared = await ctx.dbGet('apiConfigs', staleRole);
    let clearedRejected = false;
    try { await callMock(Object.assign({}, cleared, { apiKey: KEY_INLINE })); }
    catch (error) { clearedRejected = error && error.code === 'CREDENTIAL_UNAVAILABLE'; }
    check('cleared credential removes Vault secret and binding ref', clearedRejected && cleared.credentialRef === '');

    const legacyId = 'write_path_legacy_' + Date.now();
    await ctx._persistApiConfig({
      id: legacyId,
      provider: 'openai',
      model: 'mock-model',
      endpoint: 'https://mock-provider.invalid/v1/chat/completions',
      apiKey: KEY_LEGACY
    });
    const migrated = await ctx.dbGet('apiConfigs', legacyId);
    check('legacy inline apiKey import migrates to Vault and saves ref only', migrated.credentialRef === legacyId
      && !Object.prototype.hasOwnProperty.call(migrated, 'apiKey'));
    call = await callMock(migrated);
    check('migrated legacy credential resolves at request time', call.result.status === 200 && mock.observations[5].usedLegacy);

    await ctx._ibPersistImportedApiSetting({ id: 'middle_brain', provider: 'openai', endpoint: 'https://mock-provider.invalid/v1/responses', model: 'mock-mb', apiKey: KEY_SETTINGS });
    const importedSetting = await ctx.dbGet('apiSettings', 'middle_brain');
    check('legacy apiSettings apiKey import moves to Vault and saves only credentialRef', importedSetting.credentialRef === 'middle_brain'
      && !Object.prototype.hasOwnProperty.call(importedSetting, 'apiKey'));
    call = await callMock({ id: 'middle_brain', credentialRef: importedSetting.credentialRef, provider: 'openai', endpoint: importedSetting.endpoint, model: importedSetting.model });
    check('imported apiSettings credential resolves at request time', call.result.status === 200 && mock.observations[6].usedSettings);

    const mobileEntry = MOBILE_DTO.characterCatalogEntry(Object.assign({}, migrated, { apiKey: KEY_LEGACY }), { withSpec: true });
    check('mobile DTO excludes plaintext apiKey and carries ref', mobileEntry.spec.credentialRef === legacyId
      && !Object.prototype.hasOwnProperty.call(mobileEntry.spec, 'apiKey')
      && JSON.stringify(mobileEntry).indexOf(KEY_LEGACY) < 0);

    const storedConfigs = fs.readFileSync(apiConfigFile, 'utf8');
    const vaultFile = fs.readFileSync(path.join(credentialDataDir, 'credential-vault.json'), 'utf8');
    const activeState = fs.readFileSync(path.join(dataDir, 'active-message-service.json'), 'utf8');
    const storedSettings = fs.readFileSync(apiSettingsFile, 'utf8');
    check('apiConfigs and apiSettings persistence contain no plaintext secrets', ![KEY_A, KEY_B, KEY_OLD, KEY_LEGACY, KEY_SETTINGS, KEY_INLINE].some(key => storedConfigs.includes(key) || storedSettings.includes(key)));
    check('encrypted Vault and Active metadata contain no plaintext secrets', ![KEY_A, KEY_B, KEY_OLD, KEY_LEGACY, KEY_SETTINGS, KEY_INLINE].some(key => vaultFile.includes(key) || activeState.includes(key)));

    const mirrorBlock = sourceBetween(CORE, 'var pri=', 'if(!arr.length)continue');
    check('runtime mirror sanitizes apiConfigs and apiSettings', mirrorBlock.includes("if(st==='apiConfigs'||st==='apiSettings')arr=arr.map(_ibCredentialFreeApiConfig)"));
    check('API Key modal and setup wizard share the Vault writer', SOCIAL.includes('await _ibSaveApiConfigCredential(cfg.id,key)')
      && fs.readFileSync(path.join(ROOT, 'assets', 'js', 'setup-wizard.js'), 'utf8').includes('window._ibSaveApiConfigCredential(id, keyToSave)'));
    check('import path routes secret-bearing apiSettings through Credential Authority', CORE.includes('window._ibPersistImportedApiSetting(s)'));
    check('ASR Key saves through Vault and resolves per request without a module secret cache', VOICE.includes("window._ibWriteVaultCredential(s.credentialRef||'voice_transcription'")
      && VOICE.includes('window._ibWithRuntimeApiCredential') && !VOICE.includes('var _vtCfg=null'));
    check('no synthetic secret appears in Active service logs', ![KEY_A, KEY_B, KEY_OLD, KEY_LEGACY, KEY_SETTINGS, KEY_INLINE].some(key => activeLogs.includes(key)));

    const clearedAll = await ctx._ibDeleteAllVaultCredentials();
    const afterClearAll = spawnResolver(apiConfigId, tempRoot, dataDir, credentialDataDir);
    check('clear-all authority deletes orphan and referenced Vault credentials', clearedAll.removed >= 1 && afterClearAll.ok !== true);
  } finally {
    await stopActive();
    if (provider && provider.listening) await new Promise(resolve => provider.close(resolve));
    try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch (_) {}
  }

  process.stdout.write('CREDENTIAL_WRITE_PATH_PASS (' + passed + ')\n');
}

main().catch(error => {
  process.stderr.write('CREDENTIAL_WRITE_PATH_FAIL: ' + String(error && error.stack || error && error.message || 'unknown') + '\n');
  process.exitCode = 1;
});
