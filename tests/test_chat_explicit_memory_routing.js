'use strict';

/* Explicit Chat remember/save intent must write through the existing Home Node
   Memory authority and acknowledge only a verified canonical receipt. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const EXPLICIT = require(path.join(ROOT, 'assets', 'js', 'chat-explicit-memory.js'));
const REFERENCE = require(path.join(ROOT, 'assets', 'js', 'chat-reference-resolution.js'));
const MEMORY_AUTHORITY = require(path.join(ROOT, 'assets', 'js', 'memory-authority.js'));
const createMemoryStore = require(path.join(ROOT, 'services', 'home-node', 'memory-store.js'));
const createMemoryRetrieval = require(path.join(ROOT, 'services', 'home-node', 'memory-retrieval.js'));
const htmlSource = fs.readFileSync(path.join(ROOT, 'InternalBeyond.html'), 'utf8');
const communication = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'communication.js'), 'utf8');
const integrations = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'integrations.js'), 'utf8');
const memorySource = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'memory.js'), 'utf8');
const bridgeSource = fs.readFileSync(path.join(ROOT, 'services', 'ib-bridge-service.js'), 'utf8');

let passed = 0;
function check(name, condition, detail) {
  if (condition) { passed++; console.log('  PASS  ' + name); return; }
  console.error('  FAIL  ' + name + (detail ? '  -> ' + detail : ''));
  throw new Error(name + (detail ? ': ' + detail : ''));
}

function extractQuickCreateMemory(dbPut) {
  const start = memorySource.indexOf('async function quickCreateMemory(data){');
  const end = memorySource.indexOf('\n/* ====================== UNDERSTANDING + THREAD', start);
  if (start < 0 || end < 0) throw new Error('quickCreateMemory boundary missing');
  const source = memorySource.slice(start, end).trim();
  const sandbox = {
    window: { IB: { homeNode: { memory: { authority: null } } } },
    dbPut: dbPut || async function () { throw new Error('explicit action must use the canonical receipt path'); }
  };
  vm.createContext(sandbox);
  vm.runInContext(source + '\nglobalThis.__quickCreateMemory = quickCreateMemory;', sandbox, { timeout: 5000 });
  return sandbox;
}

function makeLocal() {
  const rows = new Map();
  const clone = value => JSON.parse(JSON.stringify(value));
  return {
    rows,
    get: id => Promise.resolve(rows.has(String(id)) ? clone(rows.get(String(id))) : null),
    getAll: () => Promise.resolve(Array.from(rows.values()).map(clone)),
    put: row => { rows.set(String(row.id), clone(row)); return Promise.resolve(true); },
    remove: id => { rows.delete(String(id)); return Promise.resolve(true); },
    replaceAll: list => { rows.clear(); (list || []).forEach(row => rows.set(String(row.id), clone(row))); return Promise.resolve(true); },
    applyUpserts: list => { (list || []).forEach(row => rows.set(String(row.id), clone(row))); return Promise.resolve(true); },
    applyDeletes: ids => { (ids || []).forEach(id => rows.delete(String(id))); return Promise.resolve(true); },
    bumpActivation: () => Promise.resolve(0)
  };
}

async function main() {
  const naturalBirthday = '你可以记住我的生日是 3 月 25 日吗？';
  const positiveMessages = [
    '记住我的生日是 3 月 25 日',
    '请记住我的生日是 3 月 25 日',
    '请你记住我的生日是 3 月 25 日',
    naturalBirthday,
    '你能记住我的生日是 3 月 25 日吗？',
    '能不能记住我的生日是 3 月 25 日？',
    '帮我记一下我的生日',
    '麻烦你把这个记下来',
    '以后要记得我喜欢喝咖啡',
    '别忘了我的生日是 3 月 25 日',
    '保存这件事：我住在苏州。',
    '把这个记下来：我喜欢蓝色。'
  ];
  check('bounded grammar recognizes the requested natural-language positive forms',
    positiveMessages.every(text => !!EXPLICIT.classify(text)));
  check('question-form birthday request extracts only the persistable fact',
    EXPLICIT.classify(naturalBirthday).fact === '我的生日是 3 月 25 日');
  const deictic = EXPLICIT.classify('麻烦你把这个记下来');
  check('deictic save request is intercepted and asks for content instead of saving a placeholder',
    !!deictic && deictic.needsContent === true);

  const negativeMessages = [
    '不要记住这个',
    '不用记',
    '别保存',
    '你能记住东西吗？',
    '我只是想问你能不能记住东西',
    '“记住我的生日”是什么意思？',
    '如果我说“记住 X”会发生什么？',
    '我的生日是 3 月 25 日。'
  ];
  check('negation, ability/meta questions, quotations, hypotheticals, and ordinary statements are excluded',
    negativeMessages.every(text => !EXPLICIT.classify(text)));
  check('ability-question false positive stays zero for the explicit example',
    EXPLICIT.classify('你能记住东西吗？') === null);

  let legacyPut = null;
  const legacyQuickCreate = extractQuickCreateMemory(async function (storeName, record) {
    legacyPut = { storeName: storeName, record: record };
  });
  const legacyId = await legacyQuickCreate.__quickCreateMemory({ title: '旧调用', content: '旧调用仍走 dbPut' });
  check('ordinary quickCreateMemory callers retain the existing ID return and dbPut route',
    typeof legacyId === 'string' && legacyId.indexOf('mem_') === 0
      && legacyPut && legacyPut.storeName === 'memories' && legacyPut.record.id === legacyId);

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-chat-explicit-memory-'));
  const store = createMemoryStore({ dataDir: tempDir, logger: () => {} });
  store.open();
  let online = true;
  let remotePutCalls = 0;
  const local = makeLocal();
  const remote = {
    health: () => Promise.resolve({ ok: online }),
    put: (record, options) => {
      remotePutCalls++;
      if (!online) return Promise.resolve({ ok: false, error: 'home-node-unreachable' });
      const result = store.putRecord(record, options || {});
      return Promise.resolve({ ok: true, outcome: result.outcome, id: result.id, revision: result.revision });
    },
    list: () => {
      const page = store.listRecords({});
      return Promise.resolve({ ok: true, records: page.records, revision: store.getRevision(), truncated: false });
    },
    changes: (cursor, options) => {
      const result = store.changesAfter(cursor, options || {});
      return Promise.resolve({ ok: true, cursor: result.cursor, upserts: result.upserts, deletes: result.deletes, hasMore: result.hasMore });
    },
    remove: id => Promise.resolve(store.deleteRecord(String(id), {})),
    activate: (ids, options) => Promise.resolve(store.recordActivation(ids, options || {})),
    migrationState: () => Promise.resolve({ ok: true, state: null }),
    markMigration: () => Promise.resolve({ ok: true }),
    putBatch: () => Promise.resolve({ ok: true }),
    putSettings: () => Promise.resolve({ ok: true })
  };
  const authority = MEMORY_AUTHORITY.createMemoryAuthority({
    mode: 'canonical', local: local, remote: remote, fileOrigin: false,
    clock: () => 1700000000000, logger: () => {}
  });
  const quickCreate = extractQuickCreateMemory();
  quickCreate.window.IB.homeNode.memory.authority = authority;

  const initialCount = store.countRecords();
  const message = {
    text: naturalBirthday,
    sourceMessageId: 'msg_chat_explicit_1_u',
    conversationId: 'conversation:friend-1:main',
    timestamp: 1700000000000
  };
  const route = () => EXPLICIT.route(message, { quickCreateMemory: quickCreate.__quickCreateMemory });
  check('natural question is classified for the Chat Host Action before writing',
    EXPLICIT.classify(message.text).kind === 'explicit-memory');
  const result = await route();
  check('explicit birthday write adds exactly one canonical memory_records row',
    result.ok === true && store.countRecords() === initialCount + 1);
  check('Chat success text requires the Home Node receipt',
    result.replyText === '记住了：我的生日是 3 月 25 日'
      && result.receipt && result.receipt.authority === 'home-node'
      && result.receipt.id === result.id && Number.isFinite(Number(result.receipt.revision)));

  const stored = store.getRecord(result.id);
  check('provenance points to the original user message and conversation',
    stored && stored.sourceId === message.sourceMessageId
      && stored.provenance.sourceMessageId === message.sourceMessageId
      && stored.provenance.conversationId === message.conversationId);
  const explicitUiRows = await authority.getAll();
  check('explicit Chat write is returned by the canonical reader used by Memory UI',
    explicitUiRows.authority === 'home-node'
      && explicitUiRows.some(row => row.id === result.id && row.content.includes('3 月 25 日')));
  check('the route never invokes bridge.session_save',
    !/session_save|IBNET|execOp/.test(EXPLICIT.route.toString())
      && !/session_save|IBNET|execOp/.test(memorySource.slice(memorySource.indexOf('async function quickCreateMemory(data){'),
        memorySource.indexOf('\n/* ====================== UNDERSTANDING + THREAD'))));
  check('session_save is explicitly scoped to Bridge session/runtime state',
    /name: 'session_save',[\s\S]{0,360}不得用于用户资料、生日、长期偏好或 canonical Memory/.test(bridgeSource));
  check('the canonical Memory action reuses quickCreateMemory and adds no second model writer',
    /quickCreateMemory/.test(EXPLICIT.route.toString())
      && !/memory_write|memory\.write/.test(integrations));

  const afterFirst = store.getRevision();
  const duplicate = await route();
  check('replaying the same source message follows writer idempotency without another row',
    duplicate.ok === true && store.countRecords() === initialCount + 1
      && Number(store.getRevision()) === Number(afterFirst)
      && duplicate.id === result.id);

  const retrieval = createMemoryRetrieval({ store: store, random: () => 0, logger: () => {} });
  const newConversationRecall = retrieval.retrieve('friend-1', {
    userMessage: '我的生日是哪天？', conversationId: 'conversation:friend-1:new-session',
    now: 1700000005000, maxChars: 2400
  });
  check('a new conversation can recall the canonical March 25 birthday',
    newConversationRecall.ok === true && newConversationRecall.text.includes('3 月 25 日')
      && newConversationRecall.selectedIds.includes(result.id), newConversationRecall.text);

  const sameFactNewMessage = await EXPLICIT.route({ text: message.text, sourceMessageId: 'msg_chat_explicit_2_u',
    conversationId: 'conversation:friend-1:new-session', timestamp: 1700000003000 }, {
    quickCreateMemory: quickCreate.__quickCreateMemory
  });
  check('the same fact from a distinct user message follows existing writer policy',
    sameFactNewMessage.ok === true && sameFactNewMessage.id !== result.id
      && store.countRecords() === initialCount + 2 && sameFactNewMessage.receipt.outcome === 'created');

  let ordinaryWriterCalls = 0;
  const ordinary = await EXPLICIT.route({ text: '我的生日是 3 月 25 日。', sourceMessageId: 'msg_ordinary',
    conversationId: 'conversation:friend-1:main', timestamp: 1700000001000 }, {
    quickCreateMemory: async () => { ordinaryWriterCalls++; return null; }
  });
  check('ordinary statements do not force a canonical write',
    ordinary.handled === false && ordinaryWriterCalls === 0 && store.countRecords() === initialCount + 2);

  let rejectedWriterCalls = 0;
  for (let i = 0; i < negativeMessages.length; i++) {
    const rejected = await EXPLICIT.route({ text: negativeMessages[i], sourceMessageId: 'msg_rejected_' + i,
      conversationId: 'conversation:friend-1:main', timestamp: 1700000001000 }, {
      quickCreateMemory: async () => { rejectedWriterCalls++; return null; }
    });
    check('excluded input does not invoke canonical writer: ' + negativeMessages[i],
      rejected.handled === false);
  }
  check('negative and non-request cases create no Memory rows',
    rejectedWriterCalls === 0 && store.countRecords() === initialCount + 2);

  let missingContentWriterCalls = 0;
  const missingContent = await EXPLICIT.route({ text: '麻烦你把这个记下来', sourceMessageId: 'msg_deictic_u',
    conversationId: 'conversation:friend-1:main', timestamp: 1700000001000 }, {
    quickCreateMemory: async () => { missingContentWriterCalls++; return null; }
  });
  check('unresolved deictic request is handled without a placeholder write or success claim',
    missingContent.handled === true && missingContent.ok === false
      && missingContent.error === 'memory-content-unavailable'
      && /具体内容/.test(missingContent.replyText) && missingContentWriterCalls === 0
      && store.countRecords() === initialCount + 2);

  online = false;
  const putsBeforeOffline = remotePutCalls;
  const offline = await EXPLICIT.route({ text: '以后记得我周五休息。', sourceMessageId: 'msg_offline_u',
    conversationId: 'conversation:friend-1:new-session', timestamp: 1700000002000 }, {
    quickCreateMemory: quickCreate.__quickCreateMemory
  });
  check('Home Node offline returns failure and creates no row or fake success',
    offline.ok === false && /未能保存|未保存/.test(offline.replyText)
      && !offline.replyText.includes('记住了') && store.countRecords() === initialCount + 2
      && remotePutCalls === putsBeforeOffline);

  online = true;
  const selectedMemoryRecord = { id: 'mem_reference_source_joke', title: '八台 DGX Spark 太贵的玩笑',
    summary: '之前聊过八台 DGX Spark 太贵的玩笑。', content: '用户和角色开玩笑说八台 DGX Spark 太贵。',
    rawSource: 'chat', sourceId: 'msg_reference_source', createdBy: 'user', created: 1700000007000,
    lastActivated: 1700000007000, visibility: 'public', visibleTo: [], excludeFrom: [],
    importance: 7, pinned: false, resolved: false, tags: ['玩笑'] };
  store.putRecord(selectedMemoryRecord);
  const memoryOnlyRef = { id: selectedMemoryRecord.id, title: selectedMemoryRecord.title,
    summary: selectedMemoryRecord.summary, content: selectedMemoryRecord.content };
  const memoryOnlyText = '请记住那个梗';
  const memoryOnlyResolution = REFERENCE.parseResolution({ state: 'RESOLVED', mention: '那个梗',
    referentType: 'joke', referents: [{ ref: 'M1', evidence: '八台 DGX Spark 太贵' }],
    normalizedMeaning: '用户明确要求保存此前关于八台 DGX Spark 太贵的玩笑',
    groundedQuery: '八台 DGX Spark 太贵的玩笑', confidence: 0.96 },
    REFERENCE.prepare({ userMessage: memoryOnlyText, history: [], memoryReferences: [memoryOnlyRef],
      currentMessageId: 'msg_explicit_memory_ref', conversationId: message.conversationId, mode: 'write' }));
  const explicitFromMemoryRef = await EXPLICIT.route({ text: memoryOnlyText,
    sourceMessageId: 'msg_explicit_memory_ref', conversationId: message.conversationId, timestamp: 1700000007500 }, {
    quickCreateMemory: quickCreate.__quickCreateMemory, referenceResolver: REFERENCE,
    referenceResolution: memoryOnlyResolution, referenceContextMessages: [], referenceMemoryReferences: [memoryOnlyRef]
  });
  const explicitFromMemoryRecord = store.getRecord(explicitFromMemoryRef.id);
  check('a bounded selected Memory ref grounds an explicit write through the canonical writer',
    explicitFromMemoryRef.ok === true && explicitFromMemoryRecord.content === memoryOnlyResolution.normalizedMeaning
      && explicitFromMemoryRecord.provenance.sourceMessageId === 'msg_explicit_memory_ref'
      && explicitFromMemoryRecord.provenance.referenceMemoryIds[0] === selectedMemoryRecord.id);

  const referentialText = '记住那个梗';
  const antecedent = [{ id: 'msg_explicit_joke_antecedent', friendId: 'friend-1', role: 'assistant',
    senderName: 'Smoke', content: '之前的玩笑是八台 DGX Spark 太贵。' }];
  const refRequest = REFERENCE.prepare({ userMessage: referentialText, history: antecedent,
    currentMessageId: 'msg_explicit_joke', friendId: 'friend-1', threadId: '',
    conversationId: message.conversationId, mode: 'write' });
  const refResolution = REFERENCE.parseResolution({
    state: 'RESOLVED', mention: '那个梗', referentType: 'joke',
    referents: [{ ref: 'R1', evidence: '八台 DGX Spark 太贵' }],
    normalizedMeaning: '用户明确要求保存此前关于八台 DGX Spark 太贵的玩笑',
    groundedQuery: '八台 DGX Spark 太贵的玩笑', confidence: 0.96
  }, refRequest);
  const groundedExplicit = await EXPLICIT.route({ text: referentialText, sourceMessageId: 'msg_explicit_joke',
    conversationId: message.conversationId, timestamp: 1700000008000 }, {
    quickCreateMemory: quickCreate.__quickCreateMemory,
    referenceResolver: REFERENCE, referenceResolution: refResolution, referenceContextMessages: antecedent,
    friendId: 'friend-1', threadId: ''
  });
  const groundedStored = store.getRecord(groundedExplicit.id);
  check('explicit Host Action stores the unique grounded meaning with a canonical receipt',
    groundedExplicit.handled === true && groundedExplicit.ok === true
      && groundedStored.content === '用户明确要求保存此前关于八台 DGX Spark 太贵的玩笑'
      && groundedExplicit.receipt.authority === 'home-node');
  check('explicit grounding provenance retains the original and antecedent message IDs',
    groundedStored.sourceId === 'msg_explicit_joke'
      && groundedStored.provenance.sourceMessageId === 'msg_explicit_joke'
      && groundedStored.provenance.referenceMessageIds[0] === 'msg_explicit_joke_antecedent');

  const ambiguousHistory = antecedent.concat([{ id: 'msg_explicit_joke_antecedent_2', friendId: 'friend-1',
    role: 'assistant', content: '另一个梗是蓝屏后重启三次。' }]);
  const ambiguousResolution = REFERENCE.parseResolution({
    state: 'AMBIGUOUS', mention: '那个梗', referentType: 'joke',
    referents: [{ ref: 'R1', evidence: '八台 DGX Spark 太贵' }, { ref: 'R2', evidence: '蓝屏后重启三次' }],
    normalizedMeaning: '', groundedQuery: '', confidence: 0.4
  }, REFERENCE.prepare({ userMessage: referentialText, history: ambiguousHistory,
    currentMessageId: 'msg_explicit_joke_ambiguous', friendId: 'friend-1', threadId: '',
    conversationId: message.conversationId, mode: 'write' }));
  const beforeAmbiguous = store.countRecords();
  const ambiguousExplicit = await EXPLICIT.route({ text: referentialText, sourceMessageId: 'msg_explicit_joke_ambiguous',
    conversationId: message.conversationId, timestamp: 1700000009000 }, {
    quickCreateMemory: quickCreate.__quickCreateMemory, referenceResolver: REFERENCE,
    referenceResolution: ambiguousResolution, referenceContextMessages: ambiguousHistory,
    friendId: 'friend-1', threadId: ''
  });
  check('ambiguous explicit reference falls back to normal Chat and performs no canonical write',
    ambiguousExplicit.handled === false && ambiguousExplicit.error === 'reference-ambiguous'
      && store.countRecords() === beforeAmbiguous);
  const unresolvedExplicitResolution = await REFERENCE.resolve({ userMessage: '记住那个梗', history: [],
    currentMessageId: 'msg_explicit_joke_unresolved', conversationId: message.conversationId, mode: 'write' }, {
    resolveModel: async () => { throw new Error('empty context must not fabricate'); }
  });
  let unresolvedExplicitWriterCalls = 0;
  const unresolvedExplicit = await EXPLICIT.route({ text: '记住那个梗', sourceMessageId: 'msg_explicit_joke_unresolved',
    conversationId: message.conversationId, timestamp: 1700000010000 }, {
    quickCreateMemory: async () => { unresolvedExplicitWriterCalls++; return null; },
    referenceResolver: REFERENCE, referenceResolution: unresolvedExplicitResolution,
    referenceContextMessages: [], friendId: 'friend-1', threadId: ''
  });
  check('unresolved explicit reference returns to normal Chat without invoking the writer',
    unresolvedExplicit.handled === false && unresolvedExplicit.error === 'reference-unresolved'
      && unresolvedExplicitWriterCalls === 0 && store.countRecords() === beforeAmbiguous);

  const singleStart = communication.indexOf('/* ===== NORMAL 1-ON-1 CHAT ===== */');
  const singlePath = communication.slice(singleStart);
  const singleRoute = singlePath.indexOf('window.IBChatExplicitMemory.route');
  const singleProvider = singlePath.indexOf('callApiChatStream(cfg,messages');
  const groupStart = communication.indexOf('if(isGroup){');
  const groupPath = communication.slice(groupStart, communication.indexOf('/* ===== NORMAL 1-ON-1 CHAT ===== */'));
  check('both Chat paths route explicit intent before provider/tool selection',
    singleStart >= 0 && singleRoute >= 0 && singleProvider > singleRoute
      && groupPath.indexOf('window.IBChatExplicitMemory.route') >= 0
      && /return \{ok:true,replyText:_memoryReply/.test(singlePath.slice(singleRoute, singleProvider)));
  const intentGateStart = communication.indexOf('const _explicitMemoryIntent=');
  const intentGateEnd = communication.indexOf('if(isGroup){', intentGateStart);
  const intentGate = communication.slice(intentGateStart, intentGateEnd);
  const classifierGateEnd = intentGate.indexOf('const _referenceCore=');
  const classifierGate = classifierGateEnd >= 0 ? intentGate.slice(0, classifierGateEnd) : intentGate;
  const intentGateClosed = intentGateStart >= 0 && intentGateEnd > intentGateStart
    && classifierGate.includes('_explicitMemoryApi.classify(text)')
    && !/(?:记住|记得|保存|记下来)/.test(classifierGate)
    && htmlSource.indexOf('assets/js/chat-explicit-memory.js') >= 0
    && htmlSource.indexOf('assets/js/chat-explicit-memory.js') < htmlSource.indexOf('assets/js/communication.js');
  check('single and group Chat share the one loaded grammar without a stale inline matcher',
    intentGateClosed,
    JSON.stringify({ start:intentGateStart,end:intentGateEnd,hasClassifier:classifierGate.includes('_explicitMemoryApi.classify(text)'),inlineMatcher:/(?:记住|记得|保存|记下来)/.test(classifierGate),explicitOrder:htmlSource.indexOf('assets/js/chat-explicit-memory.js'),communicationOrder:htmlSource.indexOf('assets/js/communication.js') }));
  check('the Chat fast path persists its host-authored receipt response without a model call',
    singlePath.slice(singleRoute, singleProvider).includes('chatAction:\'explicit-memory-write\'')
      && singlePath.slice(singleRoute, singleProvider).includes('memoryWriteOk:_memoryWrite.ok===true'));

  store.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
  console.log('\n' + passed + ' assertions passed');
}

main().catch(error => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
