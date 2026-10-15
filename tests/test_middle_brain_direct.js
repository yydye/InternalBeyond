/* P31 · Middle Brain Direct Channel contract / resolver tests.
   Pure Node: no browser, no IndexedDB, no network, no real provider. */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const direct = require(path.join(__dirname, '..', 'assets', 'js', 'middle-brain-direct.js'));
const configCore = require(path.join(__dirname, '..', 'assets', 'js', 'middle-brain-config-core.js'));
const modelCore = require(path.join(__dirname, '..', 'assets', 'js', 'ib-model-core.js'));
global.IBModelCore = modelCore;

class FakeStorage {
  constructor() { this.map = new Map(); }
  getItem(key) { return this.map.has(key) ? this.map.get(key) : null; }
  setItem(key, value) { this.map.set(key, String(value)); }
  removeItem(key) { this.map.delete(key); }
  keys() { return Array.from(this.map.keys()); }
}

function check(name, condition, detail) {
  if (!condition) throw new Error(name + (detail ? ': ' + detail : ''));
  console.log('✓ ' + name);
}

async function main() {
  check('route.hidden-by-default', !direct.isDirectRoute({ search: '' }));
  check('route.query-flag', direct.isDirectRoute({ search: '?middlebrain' }));
  check('route.false-flag-hidden', !direct.isDirectRoute({ search: '?middlebrain=0' }));
  check('route.close-preserves-hash', direct.withoutDirectRoute({
    href: 'http://127.0.0.1/InternalBeyond.html?middlebrain=1&x=2#chat',
    origin: 'http://127.0.0.1', pathname: '/InternalBeyond.html', search: '?middlebrain=1&x=2', hash: '#chat'
  }) === '/InternalBeyond.html?x=2#chat');

  check('prompt.runtime-contract-unchanged', typeof configCore.MB_SYSTEM_PROMPT === 'string' && configCore.MB_SYSTEM_PROMPT.length > 100);
  check('prompt.contracts-are-distinct', direct.getDirectChatSystemPrompt() !== configCore.MB_SYSTEM_PROMPT);
  check('prompt.direct-is-not-role', /不是任何角色/.test(direct.getDirectChatSystemPrompt()));
  check('prompt.direct-is-readonly', /不得创建、修改或删除/.test(direct.getDirectChatSystemPrompt()));
  check('prompt.provenance-boundary', /source \/ id \/ timestamp/.test(direct.buildDirectPrompt('q', [], { characters: [], text: '' }).messages[0].content));

  const storage = new FakeStorage();
  direct.clearTranscript({ storage });
  direct.appendTranscript({ role: 'user', content: '第一句', timestamp: 10 }, { storage });
  direct.appendTranscript({ role: 'assistant', content: '第二句', timestamp: 20 }, { storage });
  check('storage.independent-key', storage.keys().length === 1 && storage.keys()[0] === direct.STORAGE_KEY);
  check('storage.refresh-restore', direct.readTranscript({ storage }).map(row => row.content).join('|') === '第一句|第二句');
  for (let i = 0; i < 240; i++) direct.appendTranscript({ role: i % 2 ? 'assistant' : 'user', content: 'm' + i }, { storage });
  check('storage.bounded-history', direct.readTranscript({ storage }).length === direct.MAX_TRANSCRIPT_MESSAGES);
  check('storage.last-message-survives', direct.readTranscript({ storage }).at(-1).content === 'm239');

  const data = {
    chat: {
      alice: [
        { id: 'a-old', role: 'user', content: '海边散步以后我们谈到了离开', timestamp: 100 },
        { id: 'a-new', role: 'assistant', content: '我记得那次海风很大', timestamp: 300 }
      ],
      group_1: [
        { id: 'g-1', role: 'user', content: '群里讨论了海边搬家', timestamp: 250, senderName: '用户' },
        { id: 'g-2', role: 'assistant', content: '搬家计划暂时搁置', timestamp: 200, senderName: 'A' }
      ],
      roledm_x: [{ id: 'role-dm-1', role: 'assistant', content: '不应该进入 direct', timestamp: 999 }]
    },
    memories: [
      { id: 'mem-1', title: '海边', content: '用户在海边散过步', visibility: 'public', timestamp: 210 },
      { id: 'mem-hidden', title: '隐藏', content: '海边秘密', visibility: 'private', timestamp: 500 }
    ],
    diary_entries: [{ id: 'diary-1', characterId: 'alice', title: '今天', content: '今天想起海边', date: '2026-09-01' }],
    activities: [{ id: 'activity-1', roleId: 'alice', title: '共读海边章节', type: 'coread', status: 'active', updatedAt: 400 }],
    relationships: { 'alice\u0001bob': { id: 'relation-1', fromId: 'alice', toId: 'bob', kind: 'role_to_role', trust: 0.7, familiarity: 0.4, affinity: 0.6, updatedAt: 410 } },
    roleLetters: {
      byFrom: { alice: [{ id: 'letter-1', fromRoleId: 'alice', toRoleId: 'bob', subject: '海边', content: '写给朋友的信', createdAt: 350 }] },
      byTo: { alice: [] }
    }
  };
  let scanWrites = 0;
  const dependencies = {
    getCharacters: [{ id: 'alice', nickname: 'A', model: 'gpt-test', relationship: '长期朋友' }, { id: 'bob', nickname: 'B' }],
    getGroups: [{ id: '1', name: '观察小组' }],
    getRelationships: async () => data.relationships,
    getChatByFriend: async friendId => data.chat[friendId] || [],
    scan: async (store, visitor) => {
      const rows = data[store] || [];
      rows.slice().reverse().forEach((row, index) => visitor(row, index + 1));
      return { count: rows.length };
    },
    getByIndex: async (store, index, value) => ((data[store] && data[store][index] && data[store][index][value]) || []),
    getMoments: async () => [{ id: 'moment-1', roleId: 'alice', content: '今天的海边很安静', createdAt: 450 }],
    now: () => 1000
  };
  const context = await direct.resolveContext({ query: '海边' }, dependencies);
  const types = new Set(context.sources.map(source => source.sourceType));
  check('context.private-chat', types.has('private_chat'));
  check('context.group-chat', types.has('group_chat'));
  check('context.memory', types.has('memory'));
  check('context.diary', types.has('diary'));
  check('context.moment', types.has('moment'));
  check('context.role-letter', types.has('role_letter'));
  check('context.activity', types.has('activity'));
  const relationshipContext = await direct.resolveContext({ query: 'alice' }, dependencies);
  check('context.relationship-state', relationshipContext.sources.some(source => source.sourceId === 'relationship:role:alice->bob'));
  check('context.private-memory-hidden', !context.sources.some(source => source.sourceId === 'memory:mem-hidden'));
  check('context.role-dm-excluded', !context.sources.some(source => /role-dm/.test(source.sourceId)));
  check('context.provenance', context.sources.every(source => source.sourceType && source.sourceId && /source=/.test(direct._renderSourceLine(source))));
  check('context.budget-chars', context.stats.chars <= direct.MAX_CONTEXT_CHARS);
  check('context.budget-sources', context.sources.length <= direct.MAX_CONTEXT_SOURCES);
  check('context.character-metadata-no-secret', !JSON.stringify(context.characters).includes('apiKey'));
  check('context.read-only-deps', scanWrites === 0);

  const selected = direct._selectSources([
    { sourceType: 'private_chat', sourceId: '1', content: '同一条事实', timestamp: 10, score: 2 },
    { sourceType: 'memory', sourceId: '2', content: '同一条事实', timestamp: 20, score: 3 },
    { sourceType: 'private_chat', sourceId: '3', content: '更相关事实', timestamp: 30, score: 5 }
  ], '事实');
  check('context.dedup', selected.sources.length === 2);
  check('context.relevance-before-time', selected.sources[0].sourceId === '3');

  let capturedPrompt = null;
  let capturedOptions = null;
  const sendStorage = new FakeStorage();
  modelCore.turnTraceReset();
  let modelAttempts = 0;
  const result = await direct.send('请解释这段关系', {
    storage: sendStorage,
    dependencies,
    modelCall: async (prompt, options) => {
      capturedPrompt = prompt;
      capturedOptions = options;
      modelAttempts++;
      if (modelAttempts === 1) return { ok: false, error: 'http', status: 503 };
      return { ok: true, content: '这是一个只读观察。' };
    }
  });
  check('send.ok', result.ok === true);
  check('send.direct-system-prompt', capturedPrompt.system === direct.DIRECT_CHAT_SYSTEM_PROMPT);
  check('send.canonical-consumer', capturedOptions.consumer === 'middle_brain.direct');
  check('send.plain-text-mode', capturedOptions.jsonMode === false);
  check('send.transient-retry-same-route', modelAttempts === 2);
  check('send.history-independent', direct.readTranscript({ storage: sendStorage }).map(row => row.role).join(',') === 'user,assistant');
  check('send.no-world-write', storage.keys().length === 1 && scanWrites === 0);
  const directTrace = modelCore.turnTraceRecent(5).find(row => row.consumer === 'middle_brain.direct');
  check('send.trace-end-to-end', !!directTrace && directTrace.events.some(event => event.eventType === 'input')
    && directTrace.events.some(event => event.eventType === 'context')
    && directTrace.events.some(event => event.eventType === 'memory')
    && directTrace.events.some(event => event.eventType === 'model_call_retry')
    && directTrace.events.some(event => event.eventType === 'tool_execution')
    && directTrace.events.some(event => event.eventType === 'result'));
  check('send.trace-retry-status-safe', !!directTrace && directTrace.events.some(event => event.eventType === 'model_call_retry'
    && event.errorCategory === 'provider' && event.httpStatus === 503 && event.retryCount === 1));

  const html = fs.readFileSync(path.join(__dirname, '..', 'InternalBeyond.html'), 'utf8');
  check('route.script-mounted-after-bootstrap', html.indexOf('assets/js/home-node-bootstrap.js') < html.indexOf('assets/js/middle-brain-direct.js'));
  check('route.css-mounted', html.includes('assets/css/core/middle-brain-direct.css'));
  const source = fs.readFileSync(path.join(__dirname, '..', 'assets', 'js', 'middle-brain-direct.js'), 'utf8');
  const middleBrainSource = fs.readFileSync(path.join(__dirname, '..', 'assets', 'js', 'middle-brain.js'), 'utf8');
  check('permission.no-chat-writer-call', !/\b(?:dbPut|dbDelete|sendChatMessage)\s*\(/.test(source));
  check('permission.no-role-tick-call', !/\b(?:_roleLettersTick|generateDiaryEntry|createMoment)\s*\(/.test(source));
  check('context.chat-bounded-read-path', !/dbGetAll\s*\(\s*['"]chatMessages['"]/.test(source) && /MAX_SCAN_RECORDS/.test(source));
  check('provider.public-facade', /middleBrainDirectModelCall/.test(source) && /middleBrainDirectModelCall/.test(middleBrainSource) && /ASTRA\.middleBrainModelCall/.test(middleBrainSource));
  check('provider.no-internal-contract-import', !/__middleBrainContracts/.test(source));

  console.log('P31 Middle Brain Direct Channel: all checks passed');
}

main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
