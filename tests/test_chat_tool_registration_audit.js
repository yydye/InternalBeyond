'use strict';

/* Chat tool registry/dispatch audit.  Dynamic Webhook and MCP tool schemas remain
   owned by their configured peers; this test closes the host-side name/gate seam. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const BRIDGE_SRC = read('services/ib-bridge-service.js');
const BRIDGE_WS_SRC = read('bridge/ws.js');
const INTEGRATIONS_SRC = read('assets/js/integrations.js');
const WS_SRC = read('assets/js/workspace.js');
const SITE_SRC = read('assets/js/site-operations.js');
const COMM_SRC = read('assets/js/communication.js');
const MEMORY_ACTION_SRC = read('assets/js/chat-explicit-memory.js');
const HOME_EXEC_SRC = read('services/home-node/execution.js');
const HOME_HTTP_SRC = read('services/home-node/http.js');
const MOBILE_CLIENT_SRC = read('android/app/src/main/java/com/internalbeyond/mobile/data/api/HomeNodeClient.kt');

let passed = 0;
function check(name, condition, detail) {
  if (condition) { passed++; console.log('  PASS  ' + name); return; }
  console.error('  FAIL  ' + name + (detail ? '  -> ' + detail : ''));
  throw new Error(name + (detail ? ': ' + detail : ''));
}

function between(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  if (start < 0 || end < 0) throw new Error('source boundary missing: ' + startMarker);
  return source.slice(start, end);
}

const bridgeCatalogCode = between(BRIDGE_SRC, 'function toolSchema(extra) {', '/* ------------------------------------------------------------------ */\n/* WebSocket 服务');
const bridgeExecutorCode = between(BRIDGE_SRC, 'async function executeTool(name, args) {', '/* ------------------------------------------------------------------ */\n/* 工具目录');

function makeBridgeHarness(config) {
  const calls = [];
  const context = {
    config: config,
    calls: calls,
    listStickers: () => [{ name: 'smile' }],
    withListLock: async (_key, fn) => fn(),
    uid: prefix => String(prefix || 'id') + '_test',
    saveList: () => true,
    saveSessions: () => true,
    saveContext: () => true,
    whispers: [{ id: 'w1', text: 'hello', author: 'test' }],
    healthData: [],
    geoLatest: { city: 'Shanghai', address: 'Shanghai', lat: 31.2, lng: 121.5, ts: 1 },
    getWeather: async city => ({ ok: true, city: city || 'Shanghai', temp: 21, text: '晴', humidity: 40 }),
    searchMusic: async q => ({ ok: true, songs: [], q: q }),
    musicPlayUrl: async id => ({ ok: true, id: id, url: 'https://music.test/play' }),
    fetchJson: async () => ({ ok: true, status: 200, text: 'ok', json: { code: 200 } }),
    barkPush: async () => ({ ok: true, message: 'ok' }),
    ntfyPush: async () => ({ ok: true, message: 'ok' }),
    broadcast: message => calls.push(['broadcast', message]),
    recordPush: record => calls.push(['recordPush', record]),
    ttsNormalize: value => value,
    ttsSynthesize: async () => ({ ok: true, url: 'https://voice.test/a.mp3' }),
    letters: [],
    sessions: {},
    sessionGet: key => ({ ok: true, session: null, key: key }),
    sessionSave: (key, data) => ({ ok: true, updated: 1, key: key, data: data }),
    contextSummary: friend => ({ ok: true, friend: friend || '', recent: 0, budget: 10000, pct: 0 }),
    payGate: {
      registerCheckout: fields => ({ ok: true, canonicalId: 'canonical-test', nonce: 'nonce-test', fields: fields }),
      submitCanonical: async () => ({ status: 'SUCCESS', note: 'stubbed' }),
      requestConfirm: intent => ({ confirmToken: 'confirm-test', intentId: intent && intent.id })
    },
    payAuth: { ledger: () => ({ spent: 0, dailyLimit: 100 }) },
    payConfig: () => ({ mode: 'confirm', perOrderLimit: 100, dailyLimit: 100, allowedDomains: [] }),
    payConfigure: value => Object.assign({ mode: 'confirm' }, value || {})
  };
  vm.createContext(context);
  vm.runInContext(bridgeExecutorCode + '\n' + bridgeCatalogCode
    + '\nglobalThis.__allTools = ALL_TOOLS; globalThis.__tools = TOOLS; globalThis.__executeTool = executeTool;',
    context, { timeout: 5000 });
  return context;
}

const BRIDGE_DEFAULT = { webhooks: {}, bark: { enabled: false, url: '' }, ntfy: { enabled: false, topic: '' } };
const BRIDGE_FULL = {
  webhooks: {
    probe: { url: 'https://hook.example.test/ib' },
    invalidUrl: { url: 'file:///not-a-webhook' },
    invalidHeaders: { url: 'https://hook.example.test/bad', headers: '{bad json' }
  },
  bark: { enabled: true, url: 'https://api.day.app/test' },
  ntfy: { enabled: true, topic: 'ib-test' }
};

const allBridge = makeBridgeHarness(BRIDGE_FULL);
const visibleBridge = makeBridgeHarness(BRIDGE_DEFAULT);
const bridgeNames = allBridge.__allTools.map(tool => tool.name);
const visibleBridgeNames = visibleBridge.__tools.map(tool => tool.name);

function caseBlocks(source) {
  const start = source.indexOf('switch (toolName)');
  const cases = Array.from(source.slice(start).matchAll(/case '([^']+)':/g));
  const out = new Map();
  cases.forEach((match, i) => {
    const bodyStart = start + match.index + match[0].length;
    const bodyEnd = i + 1 < cases.length ? start + cases[i + 1].index : source.indexOf("default:", bodyStart);
    out.set(match[1], source.slice(bodyStart, bodyEnd));
  });
  return out;
}
const bridgeCases = caseBlocks(bridgeExecutorCode);

/* Bridge's static registration, schema fields, and switch dispatcher share one audited table. */
check('Bridge has unique model-visible tool names', new Set(bridgeNames).size === bridgeNames.length);
check('every Bridge registration has one dispatch case and no orphan case',
  bridgeNames.every(name => bridgeCases.has(name)
    && Array.from(bridgeCases.keys()).filter(x => x === name).length === 1)
    && Array.from(bridgeCases.keys()).every(name => bridgeNames.includes(name)),
  'registered=' + bridgeNames.filter(name => !bridgeCases.has(name)).join(',')
    + ' unregistered=' + Array.from(bridgeCases.keys()).filter(name => !bridgeNames.includes(name)).join(','));

const bridgeRequired = {
  whispers_write: ['text'], whispers_delete: ['id'], whispers_update: ['id'], music_url: ['id'],
  webhook: ['name'], bark_push: ['text'], ntfy_push: ['text'], tts_speak: ['text'],
  push_send: ['text'], letter_write: ['to', 'content'], session_get: ['key'], session_save: ['key'],
  pay_register_checkout: ['fields'], submit_payment: ['canonicalId', 'nonce'], pay_request_confirm: ['intent']
};
const requiredSchemaAligned = Object.keys(bridgeRequired).every(name => {
  const tool = allBridge.__allTools.find(x => x.name === name);
  return tool && bridgeRequired[name].every(key => (tool.inputSchema.required || []).includes(key));
});
check('Bridge required fields are present in every constrained input schema', requiredSchemaAligned);
check('Bridge conditional required fields match their handler rules',
  allBridge.__allTools.find(x => x.name === 'whispers_update').inputSchema.anyOf.some(x => x.required.includes('text'))
    && allBridge.__allTools.find(x => x.name === 'whispers_update').inputSchema.anyOf.some(x => x.required.includes('author'))
    && allBridge.__allTools.find(x => x.name === 'music_search').inputSchema.anyOf.some(x => x.required.includes('q'))
    && allBridge.__allTools.find(x => x.name === 'music_search').inputSchema.anyOf.some(x => x.required.includes('keyword')));

const schemaFieldCoverage = allBridge.__allTools.every(tool => {
  const block = bridgeCases.get(tool.name) || '';
  if (tool.name === 'tts_speak') return /ttsNormalize\(a\)/.test(block);
  return Object.keys((tool.inputSchema && tool.inputSchema.properties) || {})
    .every(key => new RegExp('\\ba\\.' + key + '\\b').test(block));
});
check('Bridge schema fields reach the matching handler argument (TTS uses the normalizer)', schemaFieldCoverage);
check('Bridge config-gated capabilities leave the model catalog when unconfigured',
  ['webhook', 'bark_push', 'ntfy_push'].every(name => !visibleBridgeNames.includes(name))
    && ['webhook', 'bark_push', 'ntfy_push'].every(name => bridgeNames.includes(name))
    && ['webhook', 'bark_push', 'ntfy_push'].every(name => allBridge.__tools.some(t => t.name === name)));
check('Webhook model schema only offers configured handler names',
  allBridge.__tools.find(t => t.name === 'webhook').inputSchema.properties.name.enum.join(',') === 'probe');
check('Bridge payment policy changes and confirmation-token issuance always require user confirmation',
  ['pay_request_confirm', 'pay_set_config'].every(name => allBridge.__allTools.find(t => t.name === name).alwaysConfirm === true));
check('alwaysConfirm survives the Bridge catalog wire and Desktop confirmation gate',
  /alwaysConfirm: x\.alwaysConfirm === true/.test(read('bridge/ws.js'))
    && /alwaysConfirm:\s*!!t\.alwaysConfirm/.test(INTEGRATIONS_SRC)
    && /c\.confirmTools !== false \|\| !!\(t && t\.alwaysConfirm\)/.test(INTEGRATIONS_SRC));

check('Bridge WebSocket withholds the catalog and rejects tool calls without a configured matching token',
  /this\.tokenAuthenticated = matchedToken/.test(BRIDGE_WS_SRC)
    && /tools: this\.tokenAuthenticated \? tools\.map/.test(BRIDGE_WS_SRC)
    && /if \(!this\.tokenAuthenticated\)[\s\S]{0,260}type: 'tool_result'[\s\S]{0,180}return;/.test(BRIDGE_WS_SRC)
    && /constantTimeTokenMatch\(token, expect\)/.test(BRIDGE_WS_SRC));

const xmlGuardCode = between(SITE_SRC, 'function _ibGuardAllow(g,op){', 'function _ibGuardSettle(g,op,r){');
const fcRoundCode = between(INTEGRATIONS_SRC, 'async runRound(ctx, pieceText, emit, calls){', 'ledgerGetByOp(op){');
check('XML tool execution fails closed when its host turn has no active guard',
  /no-active-cycle/.test(xmlGuardCode) && /if\(!_replay\)/.test(SITE_SRC));
check('native FC round also denies execution when no turn guard exists',
  /if\(!g\)\{[\s\S]{0,240}no-active-cycle/.test(fcRoundCode)
    && !/if\(!g\) return \{ allowed: true/.test(fcRoundCode));
check('XML-only host path creates its guard through the existing cycle owner',
  /cycleBegin\(\{active:true\},null,turn\)/.test(COMM_SRC));

/* Execute each registered Bridge handler with safe stubs; this proves dispatch reaches a handler,
   while the production smoke test below covers the real websocket dispatcher and service. */
const dispatchArgs = {
  echo: {}, sticker_list: {}, whispers_read: { limit: 1 }, whispers_write: { text: 'test' },
  whispers_delete: { id: 'w1' }, whispers_update: { id: 'w1', text: 'updated' }, health_read: {},
  geo_read: {}, weather: {}, music_search: { q: 'test' }, music_url: { id: 'song' }, webhook: { name: 'probe', data: {} },
  bark_push: { text: 'test' }, ntfy_push: { text: 'test' }, tts_speak: { text: 'test' }, push_send: { text: 'test' },
  letter_write: { to: 'user', content: 'test' }, letter_list: {}, session_get: { key: 'test' },
  session_save: { key: 'test', data: {} }, context_stats: {}, pay_register_checkout: { fields: {} },
  submit_payment: { canonicalId: 'canonical-test', nonce: 'nonce-test' },
  pay_request_confirm: { intent: { id: 'canonical-test' } }, pay_get_config: {}, pay_set_config: {}
};
(async function run() {
  let dispatched = 0;
  for (const tool of allBridge.__allTools) {
    allBridge.whispers = [{ id: 'w1', text: 'test', author: 'test' }];
    allBridge.letters = [];
    allBridge.sessions = {};
    const result = await allBridge.__executeTool(tool.name, dispatchArgs[tool.name] || {});
    check('Bridge dispatches ' + tool.name, !!result && !/^未知工具/.test(String(result.error || '')),
      JSON.stringify(result));
    dispatched++;
  }
  check('all registered Bridge tools were dispatched', dispatched === allBridge.__allTools.length);
  const beforeDelete = allBridge.whispers.length;
  const emptyDelete = await allBridge.__executeTool('whispers_delete', {});
  check('missing whispers_delete id fails closed without deleting records', emptyDelete.ok === false
    && allBridge.whispers.length === beforeDelete);
  const emptyUpdate = await allBridge.__executeTool('whispers_update', { id: 'w1' });
  check('whispers_update requires at least one update field', emptyUpdate.ok === false);
  const oldAlias = await allBridge.__executeTool('whispers_list', {});
  const unknown = await allBridge.__executeTool('unregistered_tool', {});
  check('unregistered aliases and unknown tool names fail closed', oldAlias.ok === false && unknown.ok === false
    && /未知工具/.test(String(oldAlias.error || '')) && /未知工具/.test(String(unknown.error || '')));
  const disabled = await visibleBridge.__executeTool('bark_push', { text: 'test' });
  check('a config-disabled Bridge capability is also rejected by the dispatcher', disabled.ok === false
    && /未启用或未配置/.test(String(disabled.error || '')));
  const invalidWebhook = await allBridge.__executeTool('webhook', { name: 'invalidUrl' });
  check('a Webhook excluded from its enum is also rejected by the handler', invalidWebhook.ok === false
    && /配置无效/.test(String(invalidWebhook.error || '')));

  /* Run the production MCP registry object against a deterministic Streamable HTTP peer. */
  const mcpStart = INTEGRATIONS_SRC.indexOf('const IBMCP = {');
  const mcpEnd = INTEGRATIONS_SRC.indexOf('/* ---------- 2. IBFC', mcpStart);
  if (mcpStart < 0 || mcpEnd < 0) throw new Error('IBMCP source boundary missing');
  const mcpCode = INTEGRATIONS_SRC.slice(mcpStart, mcpEnd).replace('const IBMCP =', 'globalThis.IBMCP =');
  const storage = Object.create(null);
  const rpcCalls = [];
  let remoteTools = [{ name: 'read', description: 'read', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } }];
  const mcpContext = {
    localStorage: {
      getItem: key => Object.prototype.hasOwnProperty.call(storage, key) ? storage[key] : null,
      setItem: (key, value) => { storage[key] = String(value); }
    },
    fetch: async (_url, options) => {
      const request = JSON.parse(options.body);
      rpcCalls.push(request);
      if (request.method.indexOf('notifications/') === 0) return { ok: true, status: 202, headers: { get: () => null } };
      let result = {};
      if (request.method === 'initialize') result = { serverInfo: { name: 'mock-mcp', version: '1' } };
      else if (request.method === 'tools/list') result = { tools: remoteTools, nextCursor: null };
      else if (request.method === 'tools/call') result = { content: [{ type: 'text', text: 'handled' }], isError: false };
      return {
        ok: true, status: 200,
        headers: { get: name => name.toLowerCase() === 'mcp-session-id' ? 'mock-session' : 'application/json' },
        json: async () => ({ jsonrpc: '2.0', id: request.id, result }),
        text: async () => ''
      };
    }
  };
  vm.createContext(mcpContext);
  vm.runInNewContext(mcpCode, mcpContext, { timeout: 5000 });
  const IBMCP = mcpContext.IBMCP;
  const mcpConfig = servers => ({ enabled: true, confirm: true, servers: servers });
  const saveMcpConfig = value => mcpContext.localStorage.setItem('ib_mcp_cfg', JSON.stringify(value));
  const readTool = { name: 'read', description: 'read', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }, enabled: true };
  const makeServer = overrides => Object.assign({ alias: 'shop', url: 'http://mcp.test', enabled: true, status: 'ok', tools: [readTool] }, overrides || {});
  saveMcpConfig(mcpConfig([makeServer()]));
  const discovered = IBMCP.enabledTools();
  check('MCP registered schema is the same schema shown in the model catalog', discovered.length === 1
    && discovered[0].alias === 'shop' && discovered[0].tool.inputSchema.required[0] === 'query');
  IBMCP._sessions.shop = { sid: 'mock-session' };
  const mcpResult = await IBMCP.call('mcp.shop.read', { query: 'birthday' });
  check('MCP dispatcher sends exact registered name and args to tools/call', mcpResult.ok === true && mcpResult.text === 'handled'
    && rpcCalls[rpcCalls.length - 1].method === 'tools/call'
    && rpcCalls[rpcCalls.length - 1].params.name === 'read'
    && rpcCalls[rpcCalls.length - 1].params.arguments.query === 'birthday');

  for (const scenario of [
    mcpConfig([makeServer({ enabled: false })]),
    mcpConfig([makeServer({ tools: [{ ...readTool, enabled: false }] })]),
    Object.assign(mcpConfig([makeServer()]), { enabled: false }),
    mcpConfig([makeServer({ alias: 'bad.alias' })]),
    mcpConfig([makeServer(), makeServer({ url: 'http://other.test' })])
  ]) {
    saveMcpConfig(scenario);
    const requestsBefore = rpcCalls.length;
    const denied = await IBMCP.execOp('mcp.shop.read', { query: 'x' });
    check('disabled, malformed, or duplicate MCP identity is absent and unresolvable',
      IBMCP.enabledTools().length === 0 && IBMCP.resolve('mcp.shop.read') === null
        && denied.ok === false && rpcCalls.length === requestsBefore);
  }
  saveMcpConfig(mcpConfig([makeServer()]));
  check('legacy bare MCP alias and unknown tool name are not dispatchable',
    IBMCP.resolve('read') === null && IBMCP.resolve('mcp.shop.missing') === null
      && IBMCP.resolve('mcp.shop.READ') === null);

  /* A reconnect refreshes tools/list and rejects a stale model-visible alias before tools/call. */
  saveMcpConfig(mcpConfig([makeServer()]));
  IBMCP._sessions = {};
  remoteTools = [{ name: 'replacement', description: 'new', inputSchema: { type: 'object', properties: {} } }];
  rpcCalls.length = 0;
  const staleResult = await IBMCP.execOp('mcp.shop.read', { query: 'x' });
  check('stale MCP schema/name is rejected after rediscovery without calling the removed handler',
    staleResult.ok === false && rpcCalls.some(r => r.method === 'tools/list')
      && !rpcCalls.some(r => r.method === 'tools/call')
      && IBMCP.enabledTools().some(t => t.tool.name === 'replacement'));
  saveMcpConfig(mcpConfig([makeServer()]));
  remoteTools = [
    { name: 'duplicate', description: 'first', inputSchema: { type: 'object', properties: {} } },
    { name: 'duplicate', description: 'second', inputSchema: { type: 'object', properties: { x: { type: 'string' } } } }
  ];
  IBMCP._sessions = {};
  await IBMCP.connect('shop');
  check('duplicate names from an MCP tools/list response collapse to one registration',
    IBMCP.cfg().servers[0].tools.filter(t => t.name === 'duplicate').length === 1
      && IBMCP.enabledTools().filter(t => t.tool.name === 'duplicate').length === 1);

  /* Bridge offline / disabled state gates the actual client catalog, not just its prompt prose. */
  const toolsMethod = /tools\(\)\{\s*if\(this\._status !== 'online' \|\| !this\.cfg\(\)\.toolsEnabled\) return \[\];\s*return this\._tools\.slice\(\);\s*\}/.exec(INTEGRATIONS_SRC);
  check('Bridge tool method has an online+toolsEnabled catalog gate', !!toolsMethod);
  if (toolsMethod) {
    const getBridgeTools = vm.runInNewContext('({' + toolsMethod[0] + '}).tools');
    const sample = [{ name: 'echo' }];
    check('Bridge offline tools are not model-visible', getBridgeTools.call({ _status: 'retry', cfg: () => ({ toolsEnabled: true }), _tools: sample }).length === 0);
    check('Bridge toolsEnabled=false removes tools from the catalog', getBridgeTools.call({ _status: 'online', cfg: () => ({ toolsEnabled: false }), _tools: sample }).length === 0);
    check('Bridge online and enabled returns a copy of its registered tools', getBridgeTools.call({ _status: 'online', cfg: () => ({ toolsEnabled: true }), _tools: sample }).length === 1);
  }
  const confirmMethod = INTEGRATIONS_SRC.slice(
    INTEGRATIONS_SRC.indexOf('  confirmRequired(fullName){'),
    INTEGRATIONS_SRC.indexOf('  resolveTool(fullName){', INTEGRATIONS_SRC.indexOf('  confirmRequired(fullName){'))
  ).trim().replace(/,$/, '');
  const confirmRequired = vm.runInNewContext('({' + confirmMethod + '}).confirmRequired');
  check('alwaysConfirm overrides the global Bridge confirmation toggle',
    confirmRequired.call({ cfg: () => ({ confirmTools: false }), resolveTool: () => ({ alwaysConfirm: true }) }, 'bridge.pay_request_confirm') === true
      && confirmRequired.call({ cfg: () => ({ confirmTools: false }), resolveTool: () => ({ alwaysConfirm: false }) }, 'bridge.echo') === false);
  check('Bridge and Webhook dispatch preserve exact registered casing',
    /resolveTool\(fullName\)[\s\S]{0,180}t\.name===n/.test(INTEGRATIONS_SRC)
      && !/t\.name\.toLowerCase\(\)===String\(name\)\.toLowerCase\(\)/.test(INTEGRATIONS_SRC)
      && !/t\.name\.toLowerCase\(\)===String\(op\.name\)\.toLowerCase\(\)/.test(SITE_SRC));

  /* Provider-native web search is a separate model tool surface, gated by the API config. */
  const ibwsStart = INTEGRATIONS_SRC.indexOf('const IBWS = {');
  const ibwsEnd = INTEGRATIONS_SRC.indexOf('/* ---------- 3. IBSandbox', ibwsStart);
  if (ibwsStart < 0 || ibwsEnd < 0) throw new Error('IBWS source boundary missing');
  const ibwsCode = INTEGRATIONS_SRC.slice(ibwsStart, ibwsEnd).replace('const IBWS =', 'globalThis.IBWS =');
  const ibwsContext = {};
  vm.createContext(ibwsContext);
  vm.runInNewContext(ibwsCode, ibwsContext, { timeout: 5000 });
  const searchBody = {};
  check('provider web_search is absent when the role capability is disabled',
    ibwsContext.IBWS.attach(searchBody, 'anthropic', { id: 'api-1', model: 'm', webSearch: false }, {}) === false
      && searchBody.tools === undefined);
  const enabledSearchBody = {};
  check('provider web_search is registered only for an enabled supported API capability',
    ibwsContext.IBWS.attach(enabledSearchBody, 'anthropic', { id: 'api-1', model: 'm', webSearch: true }, {}) === true
      && enabledSearchBody.tools.some(t => t.name === 'web_search'));

  /* Non-schema model-visible action grammars are separately checked against their parser/dispatcher. */
  const wsOpen = /var _WS_OPEN_RE=\/<ws_\(([^)]+)\)/.exec(COMM_SRC);
  const wsDispatcher = ['project', 'create', 'edit', 'read', 'read_image', 'run', 'tool', 'gen_image', 'edit_image', 'make_docx', 'make_pdf', 'make_xlsx'];
  check('all workspace XML tool tags have an execution branch', !!wsOpen
    && wsDispatcher.every(type => WS_SRC.includes("type==='" + type + "'")));
  check('Memory/Calendar/Blog/withdraw commands are host directives, not a model tool catalog',
    /<mem_(create|update|delete)/.test(read('assets/js/memory/auto-memory.js'))
      && /<cal_note/.test(read('assets/js/calendar.js'))
      && COMM_SRC.includes('_parseBlogReadOps') && COMM_SRC.includes('_extractWithdraw'));
  check('explicit Memory remains a separate Host Action, absent from external model tool definitions',
    MEMORY_ACTION_SRC.includes('function classify(') && MEMORY_ACTION_SRC.includes('async function route(')
      && !/memory_write|memory\.write/.test(INTEGRATIONS_SRC)
      && /window\.IBChatExplicitMemory\.route/.test(COMM_SRC));
  check('pending Webhook cards recheck the current enable switch before execution',
    SITE_SRC.includes('var cfg=await getIbTools();\n    if(!cfg.enabled)'));
  check('session_save remains Bridge session/runtime state, not canonical Memory',
    /name: 'session_save',[\s\S]{0,360}不得用于用户资料、生日、长期偏好或 canonical Memory/.test(BRIDGE_SRC)
      && /function sessionSave\(key, data\)[\s\S]{0,180}sessions\[k\]/.test(BRIDGE_SRC));

  /* Mobile has API verbs, not a model-side tool catalog or provider tools array. */
  check('Mobile Chat sends a server chat command, not model tool definitions',
    MOBILE_CLIENT_SRC.includes('.put("type", "chat.send")')
      && /doesNotExpose:\s*\[[^\]]*'tools'/.test(HOME_HTTP_SRC)
      && /const finalPrompt = \{ system: promptBuilt\.system, messages: promptBuilt\.messages \}/.test(HOME_EXEC_SRC)
      && !/finalPrompt\s*=\s*\{[^}]*tools\s*:/.test(HOME_EXEC_SRC));

  console.log('\n' + passed + ' assertions passed');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
