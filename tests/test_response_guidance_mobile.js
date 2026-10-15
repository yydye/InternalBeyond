'use strict';

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const createChatStore = require('../services/home-node/chat-store.js');
const createExecutor = require('../services/home-node/execution.js');
const SERVICE = require('../services/home-node-service.js');
const responseGuidanceCore = require('../assets/js/response-guidance-core.js');
const behaviorEffectModule = require('../services/home-node/runtime-behavior-effect.js');
const serviceSource = fs.readFileSync(path.join(__dirname, '..', 'services', 'home-node-service.js'), 'utf8');
const mobileGatewaySource = fs.readFileSync(path.join(__dirname, '..', 'services', 'home-node', 'mobile-gateway.js'), 'utf8');

let passed = 0, failed = 0;
function check(name, ok, extra) {
  if (ok) { passed += 1; console.log('PASS ' + name); }
  else { failed += 1; console.error('FAIL ' + name + (extra === undefined ? '' : ' · ' + JSON.stringify(extra))); }
}

function markerEnvelope(identity, participationId) {
  return responseGuidanceCore.buildEnvelope(identity, [{
    entryId: participationId,
    sourceKind: 'memory_behavior_modulation',
    guidanceKind: 'test-marker-v1',
    payload: { marker: 'test-guidance' },
    provenance: { sourceTurn: identity.turnId, memoryRefs: [], interpretationRefs: [], narrativeRefs: [] },
    participationId: participationId
  }], { allowTestFixtures: true });
}

function userMessage(id) {
  return { id: id, role: 'user', friendId: 'char-m0', threadId: null, content: 'Tell me about today.', timestamp: 1000 };
}

function spec(systemPrompt) {
  return { provider: 'openai', model: 'mock', endpoint: 'http://provider.invalid/v1/chat/completions',
    apiKey: 'sk-test-only', systemPrompt: systemPrompt };
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}
function httpJson(port, method, urlPath, options) {
  const o = options || {};
  return new Promise((resolve) => {
    const raw = o.body == null ? null : JSON.stringify(o.body);
    const headers = Object.assign({}, o.headers || {});
    if (raw) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(raw); }
    const req = http.request({ host: '127.0.0.1', port: port, method: method, path: urlPath, timeout: 5000, headers: headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(body) }); } catch (_) { resolve({ status: res.statusCode, body: null }); } });
    });
    req.on('error', (error) => resolve({ status: 0, body: null, error: error.message }));
    if (raw) req.write(raw);
    req.end();
  });
}

function setup(options) {
  const opts = options || {};
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-response-guidance-mobile-'));
  const store = createChatStore({ dataDir: dataDir });
  store.open();
  const seen = [];
  const port = { runStream: async function (request) {
    seen.push(request);
    return { text: 'A normal answer.', reasoning: '', usage: null };
  } };
  const registry = { getCharacterSpec: function () {
    return Object.assign({ id: 'char-m0' }, spec(opts.systemPrompt === undefined ? 'Canonical persona.' : opts.systemPrompt));
  } };
  const executor = createExecutor({
    store: store,
    port: port,
    characterRegistry: registry,
    clock: function () { return 5000; },
    turnIdFactory: function () { return String(opts.turnId || 'turn-mobile-guidance'); },
    logger: function () {},
    responseGuidanceProvider: opts.responseGuidanceProvider || null,
    responseGuidanceAttribution: opts.responseGuidanceAttribution || null,
    allowTestResponseGuidanceFixtures: opts.allowTestResponseGuidanceFixtures === true
  });
  return { dataDir: dataDir, store: store, seen: seen, executor: executor, systemPrompt: opts.systemPrompt };
}

async function runTurn(setupValue, requestId, extra) {
  return setupValue.executor.executeCharacterTurn(Object.assign({
    requestId: requestId,
    character: { id: 'char-m0', spec: spec(setupValue.systemPrompt === undefined ? 'Canonical persona.' : setupValue.systemPrompt) },
    userMessage: userMessage('msg-' + requestId),
    history: [],
    runtimeContextParts: { runtimeContext: 'Current context.', memoryConsulted: false },
    contextPolicy: 'm0-mobile-response-guidance-test'
  }, extra || {}), { timeoutMs: 1000 });
}

(async function main() {
  const attr = behaviorEffectModule.createRuntimeBehaviorEffect({ clock: function () { return 5000; }, logger: function () {} });
  let participationId = '';
  let providerIdentity = null;
  const live = setup({
    turnId: 'turn-mobile-guidance',
    responseGuidanceAttribution: attr,
    allowTestResponseGuidanceFixtures: true,
    responseGuidanceProvider: function (identity) {
      providerIdentity = identity;
      const registered = attr.registerExternalInfluence({
        characterId: identity.characterId, conversationId: identity.conversationId,
        turnId: identity.turnId, sourceKind: 'memory_behavior_modulation'
      });
      participationId = registered.participation && registered.participation.participationId || '';
      const built = markerEnvelope(identity, participationId);
      return built.ok ? built.envelope : null;
    }
  });
  const result = await runTurn(live, 'm0-mobile-1');
  const wire = live.seen[0] && live.seen[0].prompt;
  const system = String(wire && wire.system || '');
  const snapshot = attr.snapshotBehaviorEffectAttribution({
    characterId: 'char-m0', conversationId: 'dm:char-m0',
    turnId: 'turn-mobile-guidance', at: 5000
  });
  const storedAssistant = result && result.assistantMessageId ? live.store.getMessage(result.assistantMessageId) : null;
  check('M0-M1.serverProviderMintsIdentityScopedEnvelopeAndPromptReceivesIt',
    result.ok === true && providerIdentity && providerIdentity.turnId === 'turn-mobile-guidance'
      && system.indexOf('Canonical persona.') >= 0
      && system.indexOf('Current context.') > system.indexOf('Canonical persona.')
      && system.indexOf('M0 测试夹具：response guidance 已进入 Mobile prompt') > system.indexOf('Current context.')
      && system.indexOf('M0 测试夹具：response guidance 已进入 Mobile prompt') === system.lastIndexOf('M0 测试夹具：response guidance 已进入 Mobile prompt'));
  check('M0-M1b.transientGuidanceIsNotPersistedInCanonicalChatContent',
    !!storedAssistant && storedAssistant.content.indexOf('M0 测试夹具：response guidance 已进入 Mobile prompt') < 0
      && JSON.stringify(storedAssistant.metadata || {}).indexOf('participationId') < 0);
  check('M0-M2.serverConsumerRecordsConsumedParticipationUnderTheSameAttributionOwner',
    snapshot.status === 'unknown' && snapshot.coverage === 'partial'
      && snapshot.externalInfluences.length === 1
      && snapshot.externalInfluences[0].participationId === participationId
      && snapshot.externalInfluences[0].state === 'CONSUMED'
      && snapshot.effects.length === 0,
    { status: snapshot.status, external: snapshot.externalInfluences });

  const forged = setup({ turnId: 'turn-mobile-forged', allowTestResponseGuidanceFixtures: true });
  const forgedResult = await runTurn(forged, 'm0-mobile-forged', {
    responseGuidance: markerEnvelope({ characterId: 'char-m0', conversationId: 'dm:char-m0', requestId: 'm0-mobile-forged', turnId: 'turn-mobile-forged' }, 'forged').envelope
  });
  check('M0-M3-callerSuppliedGuidanceIsIgnoredWithoutAnAssemblyProvider',
    forgedResult.ok === true && forged.seen.length === 1
      && !String(forged.seen[0].prompt.system || '').includes('M0 测试夹具：response guidance 已进入 Mobile prompt'));

  const noSystemAttr = behaviorEffectModule.createRuntimeBehaviorEffect({ clock: function () { return 5000; }, logger: function () {} });
  let noSystemParticipation = '';
  const noSystem = setup({
    turnId: 'turn-mobile-no-system', systemPrompt: '',
    responseGuidanceAttribution: noSystemAttr,
    allowTestResponseGuidanceFixtures: true,
    responseGuidanceProvider: function (identity) {
      const r = noSystemAttr.registerExternalInfluence({
        characterId: identity.characterId, conversationId: identity.conversationId,
        turnId: identity.turnId, sourceKind: 'memory_behavior_modulation'
      });
      noSystemParticipation = r.participation && r.participation.participationId || '';
      const built = markerEnvelope(identity, noSystemParticipation);
      return built.ok ? built.envelope : null;
    }
  });
  const noSystemResult = await runTurn(noSystem, 'm0-mobile-no-system');
  const noSystemSnapshot = noSystemAttr.snapshotBehaviorEffectAttribution({
    characterId: 'char-m0', conversationId: 'dm:char-m0',
    turnId: 'turn-mobile-no-system', at: 5000
  });
  check('M0-M4-noCanonicalSystemFallsBackAndMarksGuidanceNotConsumed',
    noSystemResult.ok === true && noSystem.seen.length === 1
      && !String(noSystem.seen[0].prompt.system || '').includes('M0 测试夹具：response guidance 已进入 Mobile prompt')
      && noSystemSnapshot.status === 'known-none'
      && noSystemSnapshot.externalInfluences.length === 0);

  check('M0-M5-mobileWireCannotSupplyTheInternalGuidanceProviderOrConsumptionFlag',
    !/responseGuidance\s*:\s*body\./.test(mobileGatewaySource)
      && !/externalInfluenceConsumed|consumed\s*:\s*true/.test(mobileGatewaySource));
  check('M0-M6.productionAndInstanceExecutorsDelegateToTheirSameRuntimeBehaviorEffectOwner',
    /responseGuidanceAttribution:\s*\{\s*consumeExternalInfluence:\s*input\s*=>\s*runtimeBehaviorEffect\.consumeExternalInfluence/.test(serviceSource)
      && /responseGuidanceAttribution:\s*\{\s*consumeExternalInfluence:\s*input\s*=>\s*instanceRuntimeBehaviorEffect\.consumeExternalInfluence/.test(serviceSource)
      && /executor\.executeCharacterTurn\(turn\.request/.test(mobileGatewaySource));

  const fixtures = [live, forged, noSystem];
  fixtures.forEach(function (x) { try { x.store.close(); } catch (_) {} });
  for (const x of fixtures) {
    const resolved = path.resolve(x.dataDir);
    if (!resolved.startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error('refusing to remove non-test temp path');
    fs.rmSync(resolved, { recursive: true, force: true });
  }

  /* Real Mobile Gateway route → production buildHomeNode executor → test-only
     internal provider. The HTTP client sends no guidance or consumption bit. */
  const gatewayDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-m0-guidance-gateway-'));
  const gatewayAttribution = behaviorEffectModule.createRuntimeBehaviorEffect({ logger: function () {} });
  const gatewayCalls = [];
  const gatewayProvider = function (identity) {
    const registered = gatewayAttribution.registerExternalInfluence({
      characterId: identity.characterId, conversationId: identity.conversationId,
      turnId: identity.turnId, sourceKind: 'memory_behavior_modulation'
    });
    const participationId = registered.participation && registered.participation.participationId || '';
    const built = markerEnvelope(identity, participationId);
    return built.ok ? built.envelope : null;
  };
  const homeNode = SERVICE.buildHomeNode({
    dataDir: gatewayDataDir,
    token: 'm0-guidance-admin-token',
    runtimeBehaviorEffect: gatewayAttribution,
    responseGuidanceProvider: gatewayProvider,
    allowTestResponseGuidanceFixtures: true,
    turnIdFactory: function () { return 'turn-mobile-gateway-guidance'; },
    port: { runStream: async function (request) {
      gatewayCalls.push(request);
      return { text: 'Mobile integration reply.', reasoning: '', usage: null };
    } },
    logger: function () {}
  });
  let gatewayPort = null;
  try {
    homeNode.open();
    homeNode.registry.putCharacter('char-m0', { id: 'char-m0', nickname: 'M0' }, spec('Mobile canonical persona.'));
    gatewayPort = await listen(homeNode.server);
    const admin = { 'X-IB-Home-Token': 'm0-guidance-admin-token' };
    const pairing = await httpJson(gatewayPort, 'POST', '/pairing/session', {
      headers: admin, body: { deviceName: 'M0 test device', deviceType: 'android' }
    });
    const pairPayload = pairing.body && pairing.body.payload;
    const completed = await httpJson(gatewayPort, 'POST', '/mobile/v1/pairing/complete', {
      body: { v: 1, payload: { pairingId: pairPayload && pairPayload.pairingId,
        secret: pairPayload && pairPayload.secret, deviceName: 'M0 test device', deviceType: 'android' } }
    });
    const token = completed.body && completed.body.payload && completed.body.payload.token;
    const sent = await httpJson(gatewayPort, 'POST', '/mobile/v1/chat/send', {
      headers: { Authorization: 'Bearer ' + String(token || '') },
      body: { v: 1, requestId: 'm0-mobile-guidance-http', payload: {
        characterId: 'char-m0', content: 'A normal mobile turn.',
        responseGuidance: { consumed: true }, externalInfluenceConsumed: true
      } }
    });
    for (let i = 0; i < 80 && gatewayCalls.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 25));
    const gatewayTurnSnapshot = gatewayAttribution.snapshotBehaviorEffectAttribution({
      characterId: 'char-m0', conversationId: 'dm:char-m0',
      turnId: 'turn-mobile-gateway-guidance', at: Date.now()
    });
    check('M0-M7.realMobileGatewayUsesServerProviderAndPromptConsumer',
      pairing.status === 200 && completed.status === 200 && [200, 202].indexOf(sent.status) >= 0
        && gatewayCalls.length === 1
        && String(gatewayCalls[0].prompt && gatewayCalls[0].prompt.system || '').includes('M0 测试夹具：response guidance 已进入 Mobile prompt'),
      { pairing: pairing.status, completed: completed.status, sent: sent.status, providerCalls: gatewayCalls.length });
    check('M0-M8.mobileClientCannotForgeConsumedStatusAndServerSnapshotIsNotKnownNone',
      gatewayTurnSnapshot.status === 'unknown'
        && gatewayTurnSnapshot.externalInfluences.some((entry) => entry.state === 'CONSUMED'),
      { status: gatewayTurnSnapshot.status, external: gatewayTurnSnapshot.externalInfluences });
  } catch (error) {
    check('M0-M7.realMobileGatewayUsesServerProviderAndPromptConsumer', false, { error: String(error && error.message || error) });
    check('M0-M8.mobileClientCannotForgeConsumedStatusAndServerSnapshotIsNotKnownNone', false, { error: String(error && error.message || error) });
  } finally {
    try { if (homeNode.server && homeNode.server.listening) await new Promise((resolve) => homeNode.server.close(resolve)); } catch (_) {}
    try { await homeNode.close(); } catch (_) {}
    const resolved = path.resolve(gatewayDataDir);
    if (!resolved.startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error('refusing to remove non-test Home Node dataDir');
    fs.rmSync(resolved, { recursive: true, force: true });
  }
  console.log('\nMOBILE RESPONSE GUIDANCE · ' + passed + ' passed, ' + failed + ' failed');
  if (failed) process.exit(1);
})().catch((error) => {
  console.error('MOBILE RESPONSE GUIDANCE CRASHED · ' + String((error && error.stack) || error));
  process.exit(1);
});
