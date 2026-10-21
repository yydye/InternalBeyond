'use strict';

/* Synthetic-only Dev data for desktop acceptance. This module never reads the
 * formal app, production Vault, or production Workspace. */

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const createDeviceRegistry = require('../services/home-node/device-registry.js');
const createCredentialVault = require('../active/credential-vault.js');
const devSnapshot = require('./dev-snapshot.js');
const devServiceContract = require('./dev-service-contract.js');

const SYNTHETIC_AGENT_REF = 'dsh_synthetic_agent';
const SYNTHETIC_AGENT_ALT_REF = 'dsh_synthetic_agent_alt';
const SYNTHETIC_MIDDLE_REF = 'dsh_synthetic_middle';
const SYNTHETIC_PROJECT_REF = 'dsh_synthetic_workspace';
const SYNTHETIC_FILE_ID = 'dsh_synthetic_readme';
const SYNTHETIC_FILE_PATH = 'src/synthetic.js';
const SYNTHETIC_FILE_CONTENT = 'export const dshSyntheticFixture = "read-only fake workspace";\n';
const SYNTHETIC_MEMORY_SENTINEL = 'Synthetic P2 project Recall: this audit uses the bounded Home Node read-only Workspace.';
const SYNTHETIC_FAKE_KEY = 'ib-dsh-synthetic-fake-key-local-only';
const SYNTHETIC_PROVIDER_PORT = devServiceContract.DEV_PORTS.fakeProvider;
const MAX_PROVIDER_BODY = 1024 * 1024;

function providerEndpoint(value) {
  let parsed;
  try { parsed = new URL(String(value || '')); } catch (_) { throw new Error('synthetic-provider-endpoint-invalid'); }
  if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1'
    || parsed.username || parsed.password || parsed.search || parsed.hash
    || parsed.pathname !== '/v1/chat/completions'
    || !Number.isInteger(Number(parsed.port)) || Number(parsed.port) < 1 || Number(parsed.port) > 65535) {
    throw new Error('synthetic-provider-endpoint-invalid');
  }
  return parsed.href;
}

function syntheticProfiles(endpoint) {
  return [
    {
      id: SYNTHETIC_AGENT_REF, name: 'Synthetic Role Alpha', nickname: 'Synthetic Role Alpha', isRole: true,
      systemPrompt: 'IB_SYNTHETIC_PERSONA_ALPHA. You are the isolated Synthetic Role Alpha fixture. Keep a concise, methodical voice and identify verifiable implementation evidence.',
      provider: 'openai',
      model: 'ib-dsh-synthetic-agent', endpoint: endpoint, credentialRef: SYNTHETIC_AGENT_REF,
      created: 1, sortOrder: 0, streaming: false, vision: false
    },
    {
      id: SYNTHETIC_AGENT_ALT_REF, name: 'Synthetic Role Beta', nickname: 'Synthetic Role Beta', isRole: true,
      systemPrompt: 'IB_SYNTHETIC_PERSONA_BETA. You are the isolated Synthetic Role Beta fixture. Use a curious, explanatory voice and distinguish observed facts from guesses.',
      provider: 'openai',
      model: 'ib-dsh-synthetic-agent-alt', endpoint: endpoint, credentialRef: SYNTHETIC_AGENT_REF,
      created: 2, sortOrder: 1, streaming: false, vision: false
    },
    {
      id: SYNTHETIC_MIDDLE_REF, nickname: 'DSH Synthetic Middle Brain', roleSelectable: false, providerProfileOnly: true, provider: 'openai',
      model: 'ib-dsh-synthetic-middle', endpoint: endpoint, credentialRef: SYNTHETIC_MIDDLE_REF,
      created: 3, sortOrder: 2, streaming: false, vision: false
    }
  ];
}

function syntheticSnapshot(endpoint, clock) {
  const profiles = syntheticProfiles(providerEndpoint(endpoint));
  const now = typeof clock === 'function' ? clock() : Date.now();
  const snapshot = devSnapshot.sanitizeSnapshot({
    schema: 'internalbeyond.dev-snapshot',
    version: 1,
    capturedAt: new Date(now).toISOString(),
    sourceOrigin: 'synthetic://internalbeyond-dsh-acceptance',
    sourceDatabase: null,
    stores: {
      apiConfigs: profiles,
      apiSettings: [{
        id: 'middle_brain', enabled: true, providerConfigId: SYNTHETIC_MIDDLE_REF,
        credentialRef: 'middle_brain', provider: 'openai',
        model: 'ib-dsh-synthetic-middle', endpoint: endpoint
      }]
    }
  });
  /* The normal manual-export sanitizer intentionally excludes Workspace. The
   * separate synthetic-only field is consumed only by the Dev synthetic flag. */
  snapshot.syntheticWorkspace = {
    schema: 'internalbeyond.dev-synthetic-workspace',
    version: 1,
    projects: [{ id: SYNTHETIC_PROJECT_REF, name: 'DSH Synthetic Workspace', created: now }],
    projectFiles: [{
      id: SYNTHETIC_FILE_ID, projectId: SYNTHETIC_PROJECT_REF,
      path: SYNTHETIC_FILE_PATH, content: SYNTHETIC_FILE_CONTENT,
      size: Buffer.byteLength(SYNTHETIC_FILE_CONTENT, 'utf8'), updatedAt: now
    }]
  };
  return snapshot;
}

function assertSyntheticRoot(sandboxRoot, credentialDataDir, projectRoot) {
  const root = path.resolve(String(sandboxRoot || ''));
  const expectedVault = path.resolve(root, 'credential-vault');
  const parts = root.split(path.sep).filter(Boolean);
  try { devServiceContract.validateSandboxRoot(root, true, projectRoot || process.env.IB_DEV_PROJECT_ROOT); }
  catch (_) { throw new Error('synthetic-sandbox-path-invalid'); }
  if (path.resolve(String(credentialDataDir || '')) !== expectedVault) throw new Error('synthetic-sandbox-path-invalid');
  return { root, homeNodeDir: path.join(root, 'home-node'), vaultDir: expectedVault, parts };
}

function assertNotReparsePoint(directory) {
  try {
    if (fs.lstatSync(directory).isSymbolicLink()) throw new Error('synthetic-sandbox-reparse-point-blocked');
  } catch (error) {
    if (error && error.code !== 'ENOENT') throw error;
  }
}

function seedSyntheticSandbox(options) {
  options = options || {};
  const paths = assertSyntheticRoot(options.sandboxRoot, options.credentialDataDir, options.projectRoot);
  const endpoint = providerEndpoint(options.providerEndpoint);
  const clock = typeof options.clock === 'function' ? options.clock : Date.now;
  for (const directory of [paths.root, paths.homeNodeDir, paths.vaultDir]) {
    fs.mkdirSync(directory, { recursive: true });
    assertNotReparsePoint(directory);
  }

  const seedFile = path.join(paths.root, 'seed.json');
  const seedManifestFile = path.join(paths.root, 'snapshot-manifest.json');
  const existingManifest = readJson(seedManifestFile);
  if (fs.existsSync(seedFile)) {
    if (!existingManifest || existingManifest.mode !== 'synthetic') {
      throw new Error('synthetic-seed-existing-unowned-data');
    }
    const existing = readJson(seedFile);
    if (!existing || existing.schema !== 'internalbeyond.dev-snapshot'
      || JSON.stringify(existing.stores && existing.stores.apiConfigs || []).indexOf(endpoint) < 0) {
      throw new Error('synthetic-seed-provider-route-mismatch');
    }
    if (String(existing.sourceOrigin || '').startsWith('synthetic://')
      && existing.stores && Array.isArray(existing.stores.apiConfigs)) {
      const managedRefs = new Set([SYNTHETIC_AGENT_REF, SYNTHETIC_AGENT_ALT_REF, SYNTHETIC_MIDDLE_REF]);
      const preserved = existing.stores.apiConfigs.filter(profile => !profile || !managedRefs.has(String(profile.id || '')));
      const updated = Object.assign({}, existing, { stores: Object.assign({}, existing.stores, {
        apiConfigs: preserved.concat(syntheticProfiles(endpoint))
      }) });
      devSnapshot.writeJsonAtomic(seedFile, updated);
    }
  } else {
    const snapshot = syntheticSnapshot(endpoint, clock);
    devSnapshot.writeJsonAtomic(seedFile, snapshot);
    devSnapshot.writeJsonAtomic(seedManifestFile, {
      schema: 'internalbeyond.dev-snapshot-manifest', version: 1, mode: 'synthetic',
      capturedAt: snapshot.capturedAt, source: 'generated-local-fixture',
      credentials: { provider: 'fake-loopback', imported: false },
      workspace: { projectRef: SYNTHETIC_PROJECT_REF, fileCount: 1 }
    });
  }

  const registry = createDeviceRegistry({ dataDir: paths.homeNodeDir, logger: () => {} });
  registry.open();
  try {
    for (const profile of syntheticProfiles(endpoint)) {
      const result = registry.putCharacter(profile.id, {
        id: profile.id, name: profile.nickname, nickname: profile.nickname, model: profile.model
      }, {
        provider: profile.provider, model: profile.model, endpoint: endpoint,
        credentialRef: profile.credentialRef
      });
      if (!result || result.ok !== true) throw new Error('synthetic-device-registry-seed-failed');
    }
  } finally { registry.close(); }

  const vault = createCredentialVault({ dataDir: paths.vaultDir });
  vault.load();
  const profilesByCredential = new Map();
  for (const profile of syntheticProfiles(endpoint)) {
    if (!profilesByCredential.has(profile.credentialRef)) profilesByCredential.set(profile.credentialRef, profile);
  }
  for (const profile of profilesByCredential.values()) {
    if (vault.upsert(profile.credentialRef, {
      provider: profile.provider, model: profile.model, endpoint: endpoint, apiKey: SYNTHETIC_FAKE_KEY
    }) !== true) throw new Error('synthetic-vault-seed-failed');
  }
  if (vault.upsert('middle_brain', {
    provider: 'openai', model: SYNTHETIC_MIDDLE_REF, endpoint: endpoint, apiKey: SYNTHETIC_FAKE_KEY
  }) !== true) throw new Error('synthetic-middle-brain-vault-seed-failed');

  return Object.freeze({
    sandboxRoot: paths.root,
    homeNodeDir: paths.homeNodeDir,
    credentialDataDir: paths.vaultDir,
    seedFile: seedFile,
    providerEndpoint: endpoint,
    profileRefs: [SYNTHETIC_AGENT_REF, SYNTHETIC_AGENT_ALT_REF, SYNTHETIC_MIDDLE_REF],
    projectRef: SYNTHETIC_PROJECT_REF,
    fileId: SYNTHETIC_FILE_ID
  });
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
}

function writeJson(res, statusCode, value, options) {
  const o = options || {};
  const body = JSON.stringify(value);
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-IB-Dev-Session, X-IB-Dev-Instance'
  };
  if (o.originAllowed) {
    headers['Access-Control-Allow-Origin'] = o.origin || 'http://127.0.0.1:23130';
    headers.Vary = 'Origin';
  }
  res.writeHead(statusCode, headers);
  res.end(body);
}

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const parts = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(Object.assign(new Error('body-too-large'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      parts.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
    req.on('error', reject);
  });
}

function containsText(value, text) {
  if (typeof value === 'string') return value.indexOf(text) >= 0;
  if (Array.isArray(value)) return value.some(item => containsText(item, text));
  if (value && typeof value === 'object') return Object.keys(value).some(key => containsText(value[key], text));
  return false;
}

function textContent(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(textContent).join('\n');
  if (value && typeof value === 'object') return Object.keys(value).map(key => textContent(value[key])).join('\n');
  return '';
}

function syntheticAssociationPairs(messages) {
  if (!containsText(messages, 'You classify relationships between pairs of canonical memories.')) return null;
  const rows = Array.isArray(messages) ? messages : [];
  for (let index = rows.length - 1; index >= 0; index--) {
    const message = rows[index];
    if (!message || message.role !== 'user') continue;
    try {
      const payload = JSON.parse(textContent(message.content));
      return payload && Array.isArray(payload.pairs) ? payload.pairs : [];
    } catch (_) { return []; }
  }
  return [];
}

function syntheticAssociationRelation(pair) {
  const related = pair && pair.related && typeof pair.related === 'object' ? pair.related : {};
  const text = (String(related.title || '') + ' ' + String(related.content || '')).toLowerCase();
  return /\b(correct(?:ion|ed)?|updated|revised|actually)\b|纠正|更正|修正|改为|其实/.test(text)
    ? 'correction' : 'support';
}

function createSyntheticFakeProvider(options) {
  options = options || {};
  const requestedPort = Number.isInteger(options.port) ? options.port : SYNTHETIC_PROVIDER_PORT;
  const devIdentity = options.identity || null;
  const devEnvironment = options.environment || process.env;
  function respond(res, status, value, req) {
    const origin = String(req && req.headers && req.headers.origin || '').trim();
    const originAllowed = devIdentity
      ? (!origin || origin === devIdentity.webOrigin)
      : (!origin || origin === 'http://127.0.0.1:23130');
    writeJson(res, status, value, { originAllowed: originAllowed && !!origin, origin: origin });
  }
  function identityAllowed(req) {
    return !devIdentity || devServiceContract.authorizeRequestIdentity(req, devEnvironment, devIdentity.webOrigin);
  }
  const state = { calls: 0, models: Object.create(null), holdNext: false, holdNextModel: '', failNext: false, waiting: 0, cancelled: 0,
    memoryObserved: false, personaObserved: false, codingPresetObserved: false,
    codingObserved: false, projectWriteToolNames: [], personaMarkers: { alpha: false, beta: false },
    appBuilderObserved: false, appBuildRuns: 0, appDraftToolNames: [],
    puppetStudioAnalysisObserved: false, puppetStudioImageObserved: false, puppetStudioMotionObserved: false,
    mapTravelObserved: false, mapTripCalls: 0, mapNoteCalls: 0,
    associationObserved: false, associationCalls: 0, associationPairCount: 0,
    associationSchemaVersion: null };
  let scriptedCallsByModel = Object.create(null);
  const server = http.createServer(async (req, res) => {
    if (req.method === 'OPTIONS') {
      const origin = String(req.headers && req.headers.origin || '').trim();
      if (devIdentity && origin && origin !== devIdentity.webOrigin) { res.writeHead(403); res.end(); return; }
      res.writeHead(204, Object.assign({
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-IB-Dev-Session, X-IB-Dev-Instance'
      }, origin ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {}));
      res.end();
      return;
    }
    if ((req.url === '/__status' && req.method === 'GET') || (req.url === '/__control' && req.method === 'POST')) {
      if (!identityAllowed(req)) { respond(res, 403, { ok: false, error: 'environment-identity-mismatch' }, req); return; }
    }
    if (req.url === '/__status' && req.method === 'GET') { respond(res, 200, state, req); return; }
    if (req.url === '/__control' && req.method === 'POST') {
      try {
        const body = JSON.parse(await readBody(req, 4096) || '{}');
        if (body.reset === true) {
          if (state.waiting > 0) { respond(res, 409, { ok: false, error: 'provider-request-pending' }, req); return; }
          state.calls = 0;
          state.models = Object.create(null);
          state.cancelled = 0;
          state.memoryObserved = false;
          state.personaObserved = false;
          state.personaMarkers = { alpha: false, beta: false };
          state.codingPresetObserved = false;
          state.appBuilderObserved = false;
          state.appBuildRuns = 0;
          state.appDraftToolNames = [];
          state.puppetStudioAnalysisObserved = false;
          state.puppetStudioImageObserved = false;
          state.puppetStudioMotionObserved = false;
          state.mapTravelObserved = false;
          state.mapTripCalls = 0;
          state.mapNoteCalls = 0;
          state.associationObserved = false;
          state.associationCalls = 0;
          state.associationPairCount = 0;
          state.associationSchemaVersion = null;
          scriptedCallsByModel = Object.create(null);
          state.holdNext = false;
          state.holdNextModel = '';
          state.failNext = false;
          state.codingObserved = false;
          state.projectWriteToolNames = [];
        }
        if (body.holdNext === true) {
          state.holdNext = true;
          state.holdNextModel = typeof body.holdNextModel === 'string' ? body.holdNextModel : '';
        }
        if (body.failNext === true) state.failNext = true;
        if (body.holdNext === false) { state.holdNext = false; state.holdNextModel = ''; }
        respond(res, 200, { ok: true, calls: state.calls, holdNext: state.holdNext, holdNextModel: state.holdNextModel }, req);
      } catch (error) { respond(res, error.statusCode || 400, { ok: false, error: 'invalid-control' }, req); }
      return;
    }
    if (req.url !== '/v1/chat/completions' || req.method !== 'POST') {
      respond(res, 404, { error: 'not-found' }, req); return;
    }
    const syntheticRequestAuthenticated = !!(devIdentity && devIdentity.mode === 'synthetic' && identityAllowed(req));
    if (devIdentity && devIdentity.mode === 'synthetic' && !syntheticRequestAuthenticated) {
      respond(res, 403, { error: 'environment-identity-mismatch' }, req); return;
    }
    if (!syntheticRequestAuthenticated && req.headers.authorization !== 'Bearer ' + SYNTHETIC_FAKE_KEY) {
      respond(res, 401, { error: 'synthetic-provider-auth-required' }, req); return;
    }
    let request;
    try { request = JSON.parse(await readBody(req, MAX_PROVIDER_BODY) || '{}'); }
    catch (error) { respond(res, error.statusCode || 400, { error: 'invalid-request' }, req); return; }

    const model = String(request.model || '');
    const messages = Array.isArray(request.messages) ? request.messages : [];
    const associationPairs = model === 'ib-dsh-synthetic-middle' ? null : syntheticAssociationPairs(messages);
    state.calls += 1;
    state.models[model] = (state.models[model] || 0) + 1;
    const call = state.calls;
    /* Association classification is an independent one-shot capability. Keep
       it out of the tool/chat scripted turn ordinal so Recall cannot shift a
       later Synthetic chat response or Work preset fixture. */
    const modelCall = associationPairs !== null
      ? (scriptedCallsByModel[model] || 0)
      : (scriptedCallsByModel[model] = (scriptedCallsByModel[model] || 0) + 1);
    if (state.failNext && (!state.holdNextModel || state.holdNextModel === model)) {
      state.failNext = false;
      respond(res, 503, { error: 'synthetic-coding-provider-failure' }, req);
      return;
    }
    if (state.holdNext && (!state.holdNextModel || state.holdNextModel === model)) {
      state.holdNext = false;
      state.holdNextModel = '';
      state.waiting += 1;
      let settled = false;
      res.on('close', () => {
        if (settled) return;
        settled = true;
        state.waiting = Math.max(0, state.waiting - 1);
        if (!res.writableEnded) state.cancelled += 1;
      });
      return;
    }

    if (containsText(messages, SYNTHETIC_MEMORY_SENTINEL)) state.memoryObserved = true;
    if (containsText(messages, 'IB_SYNTHETIC_PERSONA_ALPHA')) state.personaMarkers.alpha = true;
    if (containsText(messages, 'IB_SYNTHETIC_PERSONA_BETA')) state.personaMarkers.beta = true;
    state.personaObserved = state.personaMarkers.alpha || state.personaMarkers.beta;
    if (containsText(messages, '【Agent 预设 · Coding】')) state.codingPresetObserved = true;
    const allMessageText = messages.map(message => textContent(message && message.content)).join('\n');
    const puppetStudioImage = messages.some(message => Array.isArray(message && message.content) && message.content.some(part => part && ['image_url', 'image', 'input_image'].includes(part.type)));
    let latestWorkPreset = 'general', latestPresetAt = -1, latestPresetMarker = '';
    for (const [name, marker] of [['coding', '【Agent 预设 · Coding】'], ['app-builder', '【Agent 预设 · App Builder】'],
      ['research', '【Agent 预设 · Research】'], ['general', '【Agent 预设 · General】']]) {
      const index = allMessageText.lastIndexOf(marker);
      if (index > latestPresetAt) { latestPresetAt = index; latestWorkPreset = name; latestPresetMarker = marker; }
    }
    let content, finishReason = 'stop';
    if (associationPairs !== null) {
      state.associationObserved = true;
      state.associationCalls += 1;
      state.associationPairCount += associationPairs.length;
      state.associationSchemaVersion = 'memory-association-v1';
      content = JSON.stringify({ items: associationPairs.map(pair => ({
        anchorMemoryId: String(pair && pair.anchor && pair.anchor.memoryId || ''),
        relatedMemoryId: String(pair && pair.related && pair.related.memoryId || ''),
        relation: syntheticAssociationRelation(pair)
      })) });
    } else if (model !== 'ib-dsh-synthetic-middle' && containsText(messages, 'IB_PUPPET_STUDIO_ANALYSIS')) {
      state.puppetStudioAnalysisObserved = true;
      state.puppetStudioImageObserved = state.puppetStudioImageObserved || puppetStudioImage;
      content = JSON.stringify({
        views: [
          { id: 'front', label: '正面视图', box: { x: 0.018, y: 0.012, width: 0.414, height: 0.603 }, confidence: 0.91, note: '三视图左侧正面角色；含全身立绘。' },
          { id: 'side', label: '侧面视图', box: { x: 0.438, y: 0.015, width: 0.292, height: 0.59 }, confidence: 0.87, note: '中间侧面作为轮廓参考。' },
          { id: 'back', label: '背面视图', box: { x: 0.731, y: 0.015, width: 0.257, height: 0.59 }, confidence: 0.89, note: '右侧背面可参考头发和蝴蝶结。' },
          { id: 'wink-detail', label: '闭眼表情细节', box: { x: 0.018, y: 0.632, width: 0.225, height: 0.126 }, confidence: 0.74, note: '底部表情格，可提取实际闭眼/微笑像素。' },
          { id: 'open-mouth-detail', label: '张嘴表情细节', box: { x: 0.244, y: 0.632, width: 0.24, height: 0.126 }, confidence: 0.71, note: '底部表情格，可提取实际张嘴像素。' }
        ],
        parts: [
          { id: 'front-hair', label: '正面头发', viewId: 'front', box: { x: 0.24, y: 0.02, width: 0.56, height: 0.24 }, boneId: 'head', anchorX: 0.5, anchorY: 0.82, zIndex: 30, confidence: 0.82, occlusion: '刘海与头饰交界需手工修边；后发不在正面完整可见。' },
          { id: 'front-face', label: '脸部', viewId: 'front', box: { x: 0.25, y: 0.11, width: 0.52, height: 0.20 }, boneId: 'head', anchorX: 0.5, anchorY: 0.5, zIndex: 20, confidence: 0.78, occlusion: '耳朵与侧发边缘需检查；眼睛、嘴部仍在同一原图图层。' },
          { id: 'front-torso', label: '上身服装', viewId: 'front', box: { x: 0.19, y: 0.25, width: 0.62, height: 0.38 }, boneId: 'body', anchorX: 0.5, anchorY: 0.12, zIndex: 10, confidence: 0.74, occlusion: '手臂与围裙有重叠；目前只裁取可见区域，不补画遮挡像素。' },
          { id: 'eyes-open', label: '睁眼局部', viewId: 'front', box: { x: 0.26, y: 0.15, width: 0.48, height: 0.09 }, boneId: 'head', anchorX: 0.5, anchorY: 0.5, zIndex: 42, confidence: 0.62, occlusion: '眼睛细节嵌在脸部原图中；裁切边缘需手工修正。' },
          { id: 'eyes-closed', label: '闭眼局部', viewId: 'wink-detail', box: { x: 0.2, y: 0.34, width: 0.62, height: 0.2 }, boneId: 'head', anchorX: 0.5, anchorY: 0.5, zIndex: 43, confidence: 0.58, occlusion: '来自设定图的眨眼表情细节，不保证与正脸尺寸一致。' },
          { id: 'mouth-closed', label: '闭嘴局部', viewId: 'front', box: { x: 0.4, y: 0.255, width: 0.2, height: 0.06 }, boneId: 'head', anchorX: 0.5, anchorY: 0.5, zIndex: 44, confidence: 0.57, occlusion: '嘴部裁切建议，需在画布中调整定位。' },
          { id: 'mouth-open', label: '张嘴局部', viewId: 'open-mouth-detail', box: { x: 0.34, y: 0.62, width: 0.32, height: 0.18 }, boneId: 'head', anchorX: 0.5, anchorY: 0.5, zIndex: 45, confidence: 0.57, occlusion: '来自张嘴表情参考格，大小与正脸比例需手工校准。' }
        ],
        bones: [
          { id: 'root', name: 'Root', parent: null, x: 0, y: 0, rotation: 0 },
          { id: 'body', name: '身体', parent: 'root', x: 285, y: 1100, rotation: 0 },
          { id: 'head', name: '头部', parent: 'body', x: 0, y: -680, rotation: 0 },
          { id: 'left-arm', name: '左臂', parent: 'body', x: -95, y: -340, rotation: 0 },
          { id: 'right-arm', name: '右臂', parent: 'body', x: 100, y: -340, rotation: 0 }
        ],
        notes: [state.puppetStudioImageObserved ? 'Synthetic Mock Provider 收到了图像输入。' : 'Synthetic Mock Provider 没有收到图像输入。', '建议先将正面图设为动画画布。', '设定图的表情、侧面与背面用于参考，不会自动成为动画图层。', '头发、围裙和手臂有遮挡，需用户手工修正或选择图片编辑路由补全。']
      });
    } else if (model !== 'ib-dsh-synthetic-middle' && containsText(messages, 'IB_PUPPET_STUDIO_MOTION')) {
      state.puppetStudioMotionObserved = true;
      const head = containsText(messages, 'head') ? 'head' : 'body';
      const arm = containsText(messages, 'left-arm') ? 'left-arm' : 'body';
      content = JSON.stringify({
        actions: [
          { id: 'nod', label: '点头', durationSeconds: 0.82, fadeInSeconds: 0.14, fadeOutSeconds: 0.18, keyframes: [
            { boneId: head, at: 0, rotation: 0, easing: 'smooth' }, { boneId: head, at: 0.22, rotation: -0.12, easing: 'easeOut' }, { boneId: head, at: 0.48, rotation: 0.075, easing: 'easeInOut' }, { boneId: head, at: 0.82, rotation: 0, easing: 'easeOut' }
          ] },
          { id: 'wave', label: '挥手', durationSeconds: 0.92, fadeInSeconds: 0.12, fadeOutSeconds: 0.18, keyframes: [
            { boneId: arm, at: 0, rotation: 0 }, { boneId: arm, at: 0.2, rotation: -0.72, easing: 'easeOut' }, { boneId: arm, at: 0.45, rotation: -0.2, easing: 'easeInOut' }, { boneId: arm, at: 0.7, rotation: -0.68, easing: 'easeInOut' }, { boneId: arm, at: 0.92, rotation: 0, easing: 'easeOut' }
          ] }
        ], notes: ['这是一份可编辑关键帧草稿；请在时间轴里检查幅度和节奏。']
      });
    } else if (model === 'ib-dsh-synthetic-middle') {
      content = containsText(messages, 'Read-only project audit')
        ? JSON.stringify({ steps: [{ fileId: SYNTHETIC_FILE_ID, focus: 'implementation' }] })
        : JSON.stringify({ decision: 'approve', issueCodes: [] });
    } else if (model !== 'ib-dsh-synthetic-middle' && containsText(messages, 'IB_SYNTHETIC_MAP_TRAVEL')) {
      /* Isolated end-to-end Map fixture: first call chooses a real named place;
         the automatic tool continuation writes one deterministic postcard. */
      state.mapTravelObserved = true;
      if (containsText(messages, '【工具执行结果】') && containsText(messages, '<ws_trip_note')) {
        state.mapNoteCalls += 1;
        content = '巴黎的风把旧书店门口的铜铃吹响了。我把一张小小的旧书票夹进了游记里。\n'
          + '<ws_trip_note title="巴黎旧书店" gift="旧书票" giftline="纸边留着时间的颜色" card="下次也一起走慢一点。">'
          + '午后的巴黎有细雨。我们沿着塞纳河走到一间旧书店，木门推开时，屋里有纸张和咖啡的味道。'
          + '我在靠窗的架子上挑了一本旧诗集，把夹在里面的书票带回来。出来时雨已经停了，河面映着浅浅的天光。</ws_trip_note>';
      } else {
        state.mapTripCalls += 1;
        content = '我想带你去巴黎塞纳河边的一间旧书店。\n'
          + '<ws_trip place="Paris" name="巴黎塞纳河旧书店" country="France" lat="48.8584" lon="2.2945" with="0">'
          + '想沿着河边慢慢走，再挑一本旧书带回来。</ws_trip>';
      }
    } else if (model !== 'ib-dsh-synthetic-middle' && latestWorkPreset === 'coding') {
      state.codingObserved = true;
      let codingStart = -1;
      for (let index = 0; index < messages.length; index++) {
        if (containsText([messages[index]], latestPresetMarker)) codingStart = index;
      }
      const codingMessages = codingStart >= 0 ? messages.slice(codingStart) : messages;
      const toolMessages = codingMessages.filter(message => message && message.role === 'tool').map(message => textContent(message.content));
      const taskText = codingMessages.map(message => textContent(message && message.content)).join('\n');
      const requestedFeaturePath = (taskText.match(/src\/coding-p3-[a-z0-9]+\.ts/) || [])[0] || 'src/feature.ts';
      const outputOf = status => toolMessages.some(text => {
        try { return String(JSON.parse(text).status || '') === status; } catch (_) { return false; }
      });
      if (modelCall === 1) {
        state.projectWriteToolNames.push('project.read_file');
        finishReason = 'tool_calls';
        content = JSON.stringify({ action: 'call_tool', name: 'project.read_file', arguments: { fileId: SYNTHETIC_FILE_ID } });
      } else if (modelCall === 2 && containsText(codingMessages, 'IB_SYNTHETIC_CODING_UNSELECTED_FILE')) {
        state.projectWriteToolNames.push('project.update_file');
        finishReason = 'tool_calls';
        content = JSON.stringify({ action: 'call_tool', name: 'project.update_file', arguments: {
          fileId: 'dsh_synthetic_unselected', content: 'export const unauthorized = true;\n'
        } });
      } else if (modelCall === 3 && (containsText(codingMessages, 'IB_SYNTHETIC_CODING_UNSELECTED_FILE') || outputOf('denied'))) {
        content = JSON.stringify({ schemaVersion: 1, summary: 'Home Node rejected a file outside the selected Workspace scope.', findings: [] });
      } else if (outputOf('denied')) {
        content = JSON.stringify({ schemaVersion: 1, summary: 'A Home Node Workspace write was denied; stop this Coding Run.', findings: [] });
      } else if (modelCall === 2) {
        state.projectWriteToolNames.push('project.update_file');
        if (containsText(codingMessages, 'IB_SYNTHETIC_CODING_FAIL_AFTER_WRITE')) state.failNext = true;
        if (containsText(codingMessages, 'IB_SYNTHETIC_CODING_HOLD_AFTER_WRITE')) {
          state.holdNext = true; state.holdNextModel = model;
        }
        finishReason = 'tool_calls';
        content = JSON.stringify({ action: 'call_tool', name: 'project.update_file', arguments: {
          fileId: SYNTHETIC_FILE_ID, content: 'export const dshSyntheticFixture = "updated by consented coding";\n'
        } });
      } else if (modelCall === 3) {
        state.projectWriteToolNames.push('project.create_file');
        finishReason = 'tool_calls';
        content = JSON.stringify({ action: 'call_tool', name: 'project.create_file', arguments: {
          anchorFileId: SYNTHETIC_FILE_ID, path: requestedFeaturePath, content: 'export const dshSyntheticFeature = true;\n'
        } });
      } else {
        content = JSON.stringify({ schemaVersion: 1,
          summary: 'Synthetic Coding created and modified consented Workspace files; the native Trace records the diff.', findings: [] });
      }
    } else if (model !== 'ib-dsh-synthetic-middle' && latestWorkPreset === 'app-builder') {
      state.appBuilderObserved = true;
      if (modelCall === 1) state.appBuildRuns += 1;
      const toolMessages = messages.filter(message => message && message.role === 'tool').map(message => String(message.content || ''));
      const hasExistingFiles = toolMessages.some(text => text.includes('index.html'));
      const hasReadJavascript = toolMessages.some(text => text.includes('app.js') && text.includes('AppStorage.get'));
      if (modelCall === 1) {
        const name = 'app_draft.list_files';
        state.appDraftToolNames.push(name);
        finishReason = 'tool_calls';
        content = JSON.stringify({ action: 'call_tool', name: name, arguments: {} });
      } else if (modelCall === 2 && hasExistingFiles) {
        const name = 'app_draft.read_file';
        state.appDraftToolNames.push(name);
        finishReason = 'tool_calls';
        content = JSON.stringify({ action: 'call_tool', name: name, arguments: { path: 'app.js' } });
      } else if (modelCall === 2) {
        const name = 'app_draft.create_file';
        state.appDraftToolNames.push(name);
        finishReason = 'tool_calls';
        content = JSON.stringify({ action: 'call_tool', name: name, arguments: { path: 'index.html', content:
          '<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>待办清单</title></head><body><main class="app-shell"><header><span class="eyebrow">TODAY</span><h1>今日待办</h1><p>把重要的事，一件一件完成。</p></header><section class="composer"><input id="todo-input" aria-label="新待办" placeholder="准备完成什么？"><button id="add-todo">添加</button></section><section id="filters" class="filters" hidden><button data-filter="all">全部</button><button data-filter="important">重要</button><button data-filter="done">已完成</button></section><section class="list-head"><span id="todo-count">0 项待办</span><button id="clear-done">清除已完成</button></section><ul id="todo-list"></ul><footer>数据仅保存在此 APP 的本地空间</footer></main></body></html>' } });
      } else if (modelCall === 3 && hasReadJavascript) {
        const name = 'app_draft.update_file';
        state.appDraftToolNames.push(name);
        finishReason = 'tool_calls';
        content = JSON.stringify({ action: 'call_tool', name: name, arguments: { path: 'app.js', content:
          'let todos=[];let activeFilter="all";const input=document.getElementById("todo-input");const list=document.getElementById("todo-list");const filters=document.getElementById("filters");filters.hidden=false;async function save(){await AppStorage.set("todos",todos)}function render(){list.replaceChildren();const visible=todos.filter(item=>activeFilter==="important"?item.important:activeFilter==="done"?item.done:true);visible.forEach(item=>{const li=document.createElement("li");li.dataset.done=String(item.done);const check=document.createElement("input");check.type="checkbox";check.checked=item.done;check.addEventListener("change",async()=>{item.done=check.checked;await save();render()});const text=document.createElement("span");text.textContent=item.text;const star=document.createElement("button");star.textContent=item.important?"★":"☆";star.setAttribute("aria-label","切换重要程度");star.addEventListener("click",async()=>{item.important=!item.important;await save();render()});const remove=document.createElement("button");remove.textContent="删除";remove.addEventListener("click",async()=>{todos=todos.filter(entry=>entry.id!==item.id);await save();render()});li.append(check,text,star,remove);list.appendChild(li)});document.getElementById("todo-count").textContent=todos.filter(item=>!item.done).length+" 项未完成"}document.querySelectorAll("[data-filter]").forEach(button=>button.addEventListener("click",()=>{activeFilter=button.dataset.filter;render()}));document.getElementById("add-todo").addEventListener("click",async()=>{const text=input.value.trim();if(!text)return;todos.push({id:Date.now()+Math.random(),text:text,done:false,important:false});input.value="";await save();render()});document.getElementById("clear-done").addEventListener("click",async()=>{todos=todos.filter(item=>!item.done);await save();render()});(async()=>{const saved=await AppStorage.get("todos");if(saved.ok&&Array.isArray(saved.value))todos=saved.value;render()})();' } });
      } else if (modelCall === 3) {
        const name = 'app_draft.create_file';
        state.appDraftToolNames.push(name);
        finishReason = 'tool_calls';
        content = JSON.stringify({ action: 'call_tool', name: name, arguments: { path: 'styles.css', content:
          ':root{font-family:Inter,"Segoe UI",sans-serif;color:#182c3a;background:#eef4f7}*{box-sizing:border-box}body{margin:0;padding:28px;min-height:100vh}.app-shell{max-width:620px;margin:0 auto;background:#ffffffdd;border:1px solid #d7e4eb;border-radius:24px;padding:30px;box-shadow:0 18px 48px #203f531a}.eyebrow{font-size:11px;letter-spacing:.22em;color:#6c97aa}h1{font-size:34px;margin:8px 0}header p{color:#66808e}.composer{display:flex;gap:10px;margin:28px 0 18px}.composer input{flex:1;min-width:0;padding:13px;border:1px solid #bfd1dc;border-radius:12px;font-size:15px}.composer button{border:0;border-radius:12px;background:#193d52;color:white;padding:0 20px}.list-head{display:flex;justify-content:space-between;color:#637e8d;font-size:13px}#clear-done,.filters button{border:0;background:transparent;color:#4e7d91;cursor:pointer}.filters{display:flex;gap:8px;margin:8px 0 18px}.filters[hidden]{display:none}.filters button{border:1px solid #d3e1e8;border-radius:999px;padding:7px 12px}ul{padding:0;list-style:none}li{display:flex;gap:12px;align-items:center;padding:13px 0;border-bottom:1px solid #e7eef2}li[data-done="true"] span{text-decoration:line-through;opacity:.55}li span{flex:1}li button{border:0;background:transparent;color:#728d9a;cursor:pointer}footer{margin-top:28px;color:#8aa0aa;font-size:12px;text-align:center}' } });
      } else if (modelCall === 4 && !hasReadJavascript) {
        const name = 'app_draft.create_file';
        state.appDraftToolNames.push(name);
        finishReason = 'tool_calls';
        content = JSON.stringify({ action: 'call_tool', name: name, arguments: { path: 'app.js', content:
          'let todos=[];const input=document.getElementById("todo-input");const list=document.getElementById("todo-list");async function save(){await AppStorage.set("todos",todos)}function render(){list.replaceChildren();todos.forEach(item=>{const li=document.createElement("li");li.dataset.done=String(item.done);const check=document.createElement("input");check.type="checkbox";check.checked=item.done;check.addEventListener("change",async()=>{item.done=check.checked;await save();render()});const text=document.createElement("span");text.textContent=item.text;const remove=document.createElement("button");remove.textContent="删除";remove.addEventListener("click",async()=>{todos=todos.filter(entry=>entry.id!==item.id);await save();render()});li.append(check,text,remove);list.appendChild(li)});document.getElementById("todo-count").textContent=todos.filter(item=>!item.done).length+" 项未完成"}document.getElementById("add-todo").addEventListener("click",async()=>{const text=input.value.trim();if(!text)return;todos.push({id:Date.now()+Math.random(),text:text,done:false});input.value="";await save();render()});document.getElementById("clear-done").addEventListener("click",async()=>{todos=todos.filter(item=>!item.done);await save();render()});(async()=>{const saved=await AppStorage.get("todos");if(saved.ok&&Array.isArray(saved.value))todos=saved.value;render()})();' } });
      } else {
        finishReason = 'stop';
        content = JSON.stringify({ schemaVersion: 1, summary: hasReadJavascript
          ? '已为待办清单增加重要程度标记和全部、重要、已完成筛选，并保留原有本地数据。'
          : '已生成包含新增、完成、删除和本地数据保存的 Todo App。' });
      }
      respond(res, 200, { id: 'chatcmpl-dsh-synthetic-' + call, object: 'chat.completion', created: Math.floor(Date.now() / 1000),
        model: model || 'ib-dsh-synthetic-agent', choices: [{ index: 0, message: { role: 'assistant', content: content }, finish_reason: finishReason }],
        usage: { prompt_tokens: 16, completion_tokens: 20, total_tokens: 36 } }, req);
      return;
    }
    else if (model !== 'ib-dsh-synthetic-middle' && modelCall === 1) {
      finishReason = 'tool_calls';
      content = JSON.stringify({ action: 'call_tool', name: 'project.read_file', arguments: { fileId: SYNTHETIC_FILE_ID } });
    } else {
      content = JSON.stringify({
          schemaVersion: 1,
          summary: 'DSH Synthetic Work UI acceptance completed with the authorized Workspace file.',
          findings: [{
            fileId: SYNTHETIC_FILE_ID, path: SYNTHETIC_FILE_PATH, line: 1,
            severity: 'info', title: 'Synthetic Workspace file was read',
            detail: containsText(messages, SYNTHETIC_FILE_CONTENT.trim())
              ? SYNTHETIC_FILE_CONTENT.trim() : 'authorized file content was not present in the model request'
          }]
        });
    }
    respond(res, 200, {
      id: 'chatcmpl-dsh-synthetic-' + call,
      object: 'chat.completion', created: Math.floor(Date.now() / 1000),
      model: model || 'ib-dsh-synthetic-agent',
      choices: [{ index: 0, message: { role: 'assistant', content: content }, finish_reason: finishReason }],
      usage: { prompt_tokens: 16, completion_tokens: 20, total_tokens: 36 }
    }, req);
  });

  return new Promise((resolve, reject) => {
    server.once('error', error => reject(error));
    server.listen(requestedPort, '127.0.0.1', () => {
      const address = server.address();
      const endpoint = 'http://127.0.0.1:' + address.port + '/v1/chat/completions';
      const close = () => new Promise(done => server.close(() => done()));
      resolve(Object.freeze({
        server: server,
        endpoint: endpoint,
        port: address.port,
        close: close,
        setHoldNext: value => { state.holdNext = value === true; state.holdNextModel = ''; },
        setFailNext: value => { state.failNext = value === true; },
        status: () => Object.assign({}, state, { models: Object.assign({}, state.models) })
      }));
    });
  });
}

module.exports = Object.freeze({
  SYNTHETIC_AGENT_REF, SYNTHETIC_AGENT_ALT_REF, SYNTHETIC_MIDDLE_REF, SYNTHETIC_PROJECT_REF,
  SYNTHETIC_FILE_ID, SYNTHETIC_FILE_PATH, SYNTHETIC_FILE_CONTENT, SYNTHETIC_MEMORY_SENTINEL,
  SYNTHETIC_FAKE_KEY, SYNTHETIC_PROVIDER_PORT,
  providerEndpoint, syntheticSnapshot, seedSyntheticSandbox, createSyntheticFakeProvider
});
