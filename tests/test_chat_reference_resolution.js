'use strict';

/* Bounded discourse grounding stays derived, fail-closed for Memory writes, and
   supplies only a grounded query to the existing canonical Recall selector. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const REFERENCE = require(path.join(ROOT, 'assets', 'js', 'chat-reference-resolution.js'));
const EXPLICIT = require(path.join(ROOT, 'assets', 'js', 'chat-explicit-memory.js'));
const MEMORY_RETRIEVAL = require(path.join(ROOT, 'services', 'home-node', 'memory-retrieval.js'));
const createRuntimeRecall = require(path.join(ROOT, 'services', 'home-node', 'runtime-recall.js'));
const createMemoryStore = require(path.join(ROOT, 'services', 'home-node', 'memory-store.js'));
const communication = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'communication.js'), 'utf8');
const explicitSource = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'chat-explicit-memory.js'), 'utf8');
const implicitSource = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'chat-implicit-memory.js'), 'utf8');
const homeNodeClientSource = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'home-node-client.js'), 'utf8');
const runtimeRecallSource = fs.readFileSync(path.join(ROOT, 'services', 'home-node', 'runtime-recall.js'), 'utf8');
const memorySource = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'memory.js'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'InternalBeyond.html'), 'utf8');

let passed = 0;
function check(name, condition, detail) {
  if (condition) { passed++; console.log('  PASS  ' + name); return; }
  console.error('  FAIL  ' + name + (detail ? '  -> ' + detail : ''));
  throw new Error(name + (detail ? ': ' + detail : ''));
}

async function main() {
  const jokeText = '那个梗以后别老提了。';
  const history = [
    { id: 'msg_old', friendId: 'friend-1', role: 'assistant', content: '早些时候我们还聊过一个无关的话题。' },
    { id: 'msg_joke', friendId: 'friend-1', role: 'assistant', senderName: 'Luna',
      content: '之前我们开玩笑说八台 DGX Spark 太贵。' }
  ];
  const request = REFERENCE.prepare({ userMessage: jokeText, history: history, currentMessageId: 'msg_current',
    friendId: 'friend-1', threadId: '', conversationId: 'conversation:friend-1:main', mode: 'write' });
  const unique = REFERENCE.parseResolution({
    state: 'RESOLVED', mention: '那个梗', referentType: 'joke',
    referents: [{ ref: 'R2', evidence: '八台 DGX Spark 太贵' }],
    normalizedMeaning: '用户不希望频繁重复提及“八台 DGX Spark 太贵”的玩笑',
    groundedQuery: '八台 DGX Spark 太贵的玩笑', confidence: 0.96,
    memoryId: 'forged', revision: 99, authority: 'model'
  }, request);
  check('unique recent antecedent is RESOLVED and model identity/authority fields are discarded',
    unique.state === 'RESOLVED' && unique.referentRefs[0] === 'msg_joke'
      && !Object.prototype.hasOwnProperty.call(unique, 'memoryId')
      && !Object.prototype.hasOwnProperty.call(unique, 'revision')
      && !Object.prototype.hasOwnProperty.call(unique, 'authority'));
  check('resolution keeps original referent evidence and a self-contained meaning',
    unique.referenceEvidence[0].quote === '八台 DGX Spark 太贵'
      && unique.normalizedMeaning.includes('八台 DGX Spark')
      && !unique.normalizedMeaning.includes('那个梗'));
  const currentLocalInput = { userMessage: '那个梗以后别提了，我指八台 DGX Spark 太贵的玩笑。',
    history: [], currentMessageId: 'msg_local_grounding', mode: 'write' };
  const currentLocal = REFERENCE.parseResolution({ state: 'RESOLVED', mention: '那个梗', referentType: 'joke',
    referents: [{ ref: 'C1', evidence: '八台 DGX Spark 太贵的玩笑' }],
    normalizedMeaning: '用户不希望频繁提及八台 DGX Spark 太贵的玩笑',
    groundedQuery: '八台 DGX Spark 太贵的玩笑', confidence: 0.97 }, REFERENCE.prepare(currentLocalInput));
  const currentDangling = REFERENCE.parseResolution({ state: 'RESOLVED', mention: '那个梗', referentType: 'joke',
    referents: [{ ref: 'C1', evidence: '那个梗以后别提了' }],
    normalizedMeaning: '用户不希望频繁提及八台 DGX Spark 太贵的玩笑',
    groundedQuery: '八台 DGX Spark 太贵的玩笑', confidence: 0.99 }, REFERENCE.prepare({
    userMessage: '那个梗以后别提了', history: [], currentMessageId: 'msg_current_dangling', mode: 'write' }));
  const resolvedCurrentLocal = await REFERENCE.resolve(currentLocalInput, { resolveModel: async () => ({
    state: 'RESOLVED', mention: '那个梗', referentType: 'joke',
    referents: [{ ref: 'C1', evidence: '八台 DGX Spark 太贵的玩笑' }],
    normalizedMeaning: '用户不希望频繁提及八台 DGX Spark 太贵的玩笑',
    groundedQuery: '八台 DGX Spark 太贵的玩笑', confidence: 0.97
  }) });
  check('current-message clarification can ground a reference, but repeating the dangling phrase cannot',
    currentLocal.state === 'RESOLVED' && currentLocal.referentRefs[0] === 'msg_local_grounding'
      && resolvedCurrentLocal.state === 'RESOLVED'
      && currentDangling.state === 'UNRESOLVED');

  const priorMemory = { id: 'mem_dgx_joke', title: '八台 DGX Spark 太贵的玩笑',
    summary: '之前聊过八台 DGX Spark 的价格玩笑。', content: '用户和 Luna 曾开玩笑说八台 DGX Spark 太贵。' };
  const memoryOnlyInput = { userMessage: '那个梗后来怎么说来着？', history: [], memoryReferences: [priorMemory],
    currentMessageId: 'msg_memory_ref', conversationId: 'conversation:friend-1:main', mode: 'recall' };
  const memoryOnlyRequest = REFERENCE.prepare(memoryOnlyInput);
  const memoryGrounded = REFERENCE.parseResolution({ state: 'RESOLVED', mention: '那个梗', referentType: 'joke',
    referents: [{ ref: 'M1', evidence: '八台 DGX Spark 太贵' }],
    normalizedMeaning: '八台 DGX Spark 太贵的玩笑', groundedQuery: '八台 DGX Spark 太贵的玩笑', confidence: 0.95,
    memoryId: 'forged-memory-id', revision: 8, authority: 'model' }, memoryOnlyRequest);
  const checkedMemoryGrounding = REFERENCE.validateForTurn(memoryGrounded, memoryOnlyInput);
  check('a selected, host-provided canonical Memory ref can ground a query without exposing its ID to the model',
    memoryOnlyRequest.references.length === 0 && memoryOnlyRequest.memoryReferences[0].ref === 'M1'
      && memoryGrounded.state === 'RESOLVED' && memoryGrounded.referentRefs.length === 0
      && memoryGrounded.referentMemoryIds[0] === 'mem_dgx_joke'
      && checkedMemoryGrounding.state === 'RESOLVED'
      && !Object.prototype.hasOwnProperty.call(memoryGrounded, 'memoryId'));
  let modelSawMemoryRefPayload = null;
  const resolvedFromSelectedMemory = await REFERENCE.resolve(memoryOnlyInput, { resolveModel: async messages => {
    modelSawMemoryRefPayload = JSON.parse(messages[1].content);
    return { state: 'RESOLVED', mention: '那个梗', referentType: 'joke',
      referents: [{ ref: 'M1', evidence: '八台 DGX Spark 太贵' }],
      normalizedMeaning: '八台 DGX Spark 太贵的玩笑', groundedQuery: '八台 DGX Spark 太贵的玩笑', confidence: 0.96 };
  } });
  check('read-side resolver can use only the previous selected ref in a new message context',
    resolvedFromSelectedMemory.state === 'RESOLVED'
      && modelSawMemoryRefPayload.recentMessages.length === 0
      && modelSawMemoryRefPayload.recentMemoryRefs[0].ref === 'M1'
      && !JSON.stringify(modelSawMemoryRefPayload).includes('mem_dgx_joke'));
  const forgedMemoryGrounding = REFERENCE.parseResolution({ state: 'RESOLVED', mention: '那个梗', referentType: 'joke',
    referents: [{ ref: 'M99', evidence: '八台 DGX Spark 太贵' }], normalizedMeaning: '八台 DGX Spark 太贵的玩笑',
    groundedQuery: '八台 DGX Spark 太贵的玩笑', confidence: 0.99 }, memoryOnlyRequest);
  check('model cannot mint or select an unavailable Memory reference', forgedMemoryGrounding.state === 'UNRESOLVED'
    && forgedMemoryGrounding.referentMemoryIds.length === 0);
  const boundedMemories = REFERENCE.prepare({ userMessage: '那个呢？', history: [], memoryReferences:
    Array.from({ length: 12 }, (_, i) => ({ id: 'mem_' + i, title: 'candidate ' + i, summary: 'bounded text ' + i })) });
  check('selected Memory context is capped by count and excerpt length',
    boundedMemories.memoryReferences.length <= REFERENCE.MAX_MEMORY_REFERENCES
      && boundedMemories.memoryReferences.every(ref => ref.text.length <= REFERENCE.MAX_MEMORY_REFERENCE_CHARS));
  const verifiedSelectedMemories = await REFERENCE.loadSelectedMemoryReferences(
    ['mem_live', 'mem_deleted', 'mem_hidden', 'mem_stale', 'mem_over_cap'], {
      getRecord: async id => {
        if (id === 'mem_deleted') return null;
        const row = { id: id, title: 'grounded ' + id, summary: 'bounded canonical Memory excerpt', content: '' };
        return { authority: 'home-node', readFrom: id === 'mem_stale' ? 'mirror-degraded' : 'mirror', ...row };
      },
      isVisible: row => row.id !== 'mem_hidden'
    });
  check('deleted, hidden, degraded, and over-limit selected refs are excluded before resolution',
    verifiedSelectedMemories.length === 1 && verifiedSelectedMemories[0].id === 'mem_live');

  let explicitMemoryPayload = null;
  const explicitMemoryWrite = await EXPLICIT.route({ text: '请记住那个梗', sourceMessageId: 'msg_explicit_memref',
    conversationId: 'conversation:friend-1:main', timestamp: 1700000000000 }, {
    referenceResolver: REFERENCE, referenceResolution: Object.assign({}, memoryGrounded, { mode: 'write' }),
    referenceContextMessages: [], referenceMemoryReferences: [priorMemory],
    quickCreateMemory: async payload => {
      explicitMemoryPayload = payload;
      return { ok: true, id: 'mem_explicit_memref', receipt: { ok: true, authority: 'home-node',
        id: 'mem_explicit_memref', revision: 1, outcome: 'created' } };
    }
  });
  check('canonical write input preserves the original message and selected Memory reference provenance',
    explicitMemoryWrite.ok === true && explicitMemoryPayload.content === '八台 DGX Spark 太贵的玩笑'
      && explicitMemoryPayload.provenance.sourceMessageId === 'msg_explicit_memref'
      && explicitMemoryPayload.provenance.referenceMemoryIds[0] === 'mem_dgx_joke');

  const ambiguousRequest = REFERENCE.prepare({ userMessage: '那个梗后来怎么说来着？',
    history: history.concat([{ id: 'msg_joke_2', friendId: 'friend-1', role: 'user', content: '蓝屏三次重启的那个梗也很好笑。' }]),
    currentMessageId: 'msg_current_ambiguous', friendId: 'friend-1', threadId: '', mode: 'recall' });
  const ambiguous = REFERENCE.parseResolution({
    state: 'AMBIGUOUS', mention: '那个梗', referentType: 'joke',
    referents: [{ ref: 'R2', evidence: '八台 DGX Spark 太贵' }, { ref: 'R3', evidence: '蓝屏三次重启的那个梗' }],
    normalizedMeaning: '', groundedQuery: '', confidence: 0.55
  }, ambiguousRequest);
  check('multiple plausible antecedents stay AMBIGUOUS with both bounded message refs',
    ambiguous.state === 'AMBIGUOUS' && ambiguous.referentRefs.includes('msg_joke')
      && ambiguous.referentRefs.includes('msg_joke_2') && ambiguous.normalizedMeaning === '');
  const conflictRequest = REFERENCE.prepare({ userMessage: '那个梗后来怎么说来着？',
    history: [{ id: 'msg_recent_joke', role: 'assistant', friendId: 'friend-1', content: '刚才说的是蓝屏后重启三次的玩笑。' }],
    memoryReferences: [priorMemory], currentMessageId: 'msg_conflict_current', friendId: 'friend-1', mode: 'recall' });
  const conflict = REFERENCE.parseResolution({ state: 'AMBIGUOUS', mention: '那个梗', referentType: 'joke',
    referents: [{ ref: 'R1', evidence: '蓝屏后重启三次的玩笑' }, { ref: 'M1', evidence: '八台 DGX Spark 太贵' }],
    normalizedMeaning: '', groundedQuery: '', confidence: 0.5 }, conflictRequest);
  check('recent dialogue versus selected historical Memory conflict stays AMBIGUOUS',
    conflict.state === 'AMBIGUOUS' && conflict.referentRefs[0] === 'msg_recent_joke'
      && conflict.referentMemoryIds[0] === 'mem_dgx_joke');
  const overclaimedResolution = REFERENCE.parseResolution({
    state: 'RESOLVED', mention: '那个梗', referentType: 'joke',
    referents: [{ ref: 'R2', evidence: '八台 DGX Spark 太贵' }, { ref: 'R3', evidence: '蓝屏三次重启的那个梗' }],
    normalizedMeaning: '用户不希望频繁重复提及一个梗', groundedQuery: '某个梗', confidence: 0.99
  }, ambiguousRequest);
  check('a RESOLVED claim with multiple antecedent refs is downgraded to AMBIGUOUS',
    overclaimedResolution.state === 'AMBIGUOUS' && overclaimedResolution.normalizedMeaning === '');

  const missingRequest = REFERENCE.prepare({ userMessage: '新会话里那个还记得吧？', history: [],
    conversationId: 'conversation:new', mode: 'recall' });
  const missing = await REFERENCE.resolve(missingRequest, { resolveModel: async () => { throw new Error('must not call without context'); } });
  check('no context yields UNRESOLVED without invoking a model or fabricating a referent',
    missing.state === 'UNRESOLVED' && missing.referentRefs.length === 0 && missing.normalizedMeaning === '');
  let danglingCurrentCalls = 0;
  const danglingCurrent = await REFERENCE.resolve({ userMessage: '那个还记得吧？', history: [],
    currentMessageId: 'msg_new_session', conversationId: 'conversation:new', mode: 'recall' }, {
    resolveModel: async () => {
      danglingCurrentCalls++;
      return { state: 'RESOLVED', mention: '那个', referentType: 'other',
        referents: [{ ref: 'C1', evidence: '那个还记得吧' }], normalizedMeaning: '八台 DGX Spark 太贵的玩笑',
        groundedQuery: '八台 DGX Spark 太贵的玩笑', confidence: 0.99 };
    }
  });
  check('a new-session deictic question cannot resolve from its own repeated mention',
    danglingCurrentCalls === 1 && danglingCurrent.state === 'UNRESOLVED' && danglingCurrent.referentRefs.length === 0);

  let failedResolverCalls = 0;
  const failed = await REFERENCE.resolve({ userMessage: '之前那个计划继续吧。', history: history,
    currentMessageId: 'msg_current_failure', mode: 'recall' }, {
    resolveModel: async () => { failedResolverCalls++; throw new Error('resolver offline'); }
  });
  check('resolver failure degrades to UNRESOLVED and never throws into Chat',
    failedResolverCalls === 1 && failed.state === 'UNRESOLVED' && failed.reason === 'resolver-failed');
  const timedOut = await REFERENCE.resolve({ userMessage: '之前那个计划继续吧。', history: history,
    currentMessageId: 'msg_current_timeout', mode: 'recall' }, {
    timeoutMs: 20, resolveModel: () => new Promise(() => {})
  });
  check('hanging resolver is bounded and degrades to UNRESOLVED',
    timedOut.state === 'UNRESOLVED' && timedOut.reason === 'resolver-timeout');
  check('clear statement does not trigger the extra resolution call',
    REFERENCE.needsResolution('我的生日是 3 月 25 日。') === false);
  check('bounded reference trigger covers the requested Chinese discourse forms',
    ['那个梗以后别老提了', '上次那件事', '她说的那个', '还是老地方', '之前那个计划',
      '你知道我说的是哪个', '之前说的 API 供应商不用了'].every(REFERENCE.needsResolution));
  const lowConfidence = REFERENCE.parseResolution({
    state: 'RESOLVED', mention: '那个梗', referentType: 'joke',
    referents: [{ ref: 'R2', evidence: '八台 DGX Spark 太贵' }],
    normalizedMeaning: '用户不希望频繁重复提及“八台 DGX Spark 太贵”的玩笑',
    groundedQuery: '八台 DGX Spark 太贵的玩笑', confidence: 0.42
  }, request);
  check('low model confidence is downgraded to UNRESOLVED', lowConfidence.state === 'UNRESOLVED');

  const boundedHistory = Array.from({ length: 30 }, (_, i) => ({
    id: 'msg_' + i, friendId: 'friend-1', role: i % 2 ? 'user' : 'assistant', content: 'message-' + i + ' x'.repeat(900)
  }));
  const bounded = REFERENCE.prepare({ userMessage: '上次那个计划呢？', history: boundedHistory,
    currentMessageId: 'msg_current_bounded', friendId: 'friend-1', threadId: '' });
  check('context projection is bounded by message count and total characters',
    bounded.references.length <= REFERENCE.MAX_CONTEXT_MESSAGES
      && bounded.references.reduce((n, item) => n + item.text.length, 0) <= REFERENCE.MAX_CONTEXT_CHARS
      && bounded.references.every(item => item.messageId !== 'msg_current_bounded'));
  const sharedBudget = REFERENCE.prepare({ userMessage: '那个呢？',
    history: Array.from({ length: 8 }, (_, i) => ({ id: 'msg_budget_' + i, role: 'assistant',
      content: 'x'.repeat(REFERENCE.MAX_MESSAGE_CHARS) })),
    memoryReferences: Array.from({ length: 4 }, (_, i) => ({ id: 'mem_budget_' + i, content: 'y'.repeat(REFERENCE.MAX_MEMORY_REFERENCE_CHARS) })) });
  check('recent messages take priority and share one bounded context budget with selected Memory refs',
    sharedBudget.references.reduce((n, item) => n + item.text.length, 0)
      + sharedBudget.memoryReferences.reduce((n, item) => n + item.text.length, 0) <= REFERENCE.MAX_CONTEXT_CHARS
      && sharedBudget.memoryReferences.length === 0);
  const oversizedCurrent = REFERENCE.prepare({ userMessage: '那个梗' + 'x'.repeat(5000),
    currentMessageId: 'msg_oversized_current', history: [] });
  check('the current turn sent to the auxiliary resolver is bounded independently of Chat history',
    oversizedCurrent.modelMessage.length === REFERENCE.MAX_CURRENT_MESSAGE_CHARS
      && oversizedCurrent.currentReference.text.length === REFERENCE.MAX_CURRENT_MESSAGE_CHARS);

  check('Chat wires derived resolution before Recall and into both Memory write paths',
    /_ibResolveChatMemoryReference\(cfg/.test(communication)
      && /groundedQuery:_groundedRecallQuery/.test(communication)
      && /referenceResolution:_bcc\.referenceResolution/.test(communication)
      && /referenceResolution:_referenceResolution/.test(communication)
      && /referenceMessageIds/.test(implicitSource)
      && /referenceMessageIds/.test(explicitSource)
      && /referenceMemoryIds/.test(implicitSource)
      && /referenceMemoryIds/.test(explicitSource)
      && /referenceMemoryIds/.test(memorySource)
      && /authority\.get\(id\)/.test(communication)
      && /isMemoryVisibleTo\(row/.test(communication)
      && /_ibRememberRecallSelection\(payload,out\.selectedIds\)/.test(communication)
      && /30\*60\*1000/.test(communication)
      && /assets\/js\/chat-reference-resolution\.js/.test(html));
  check('grounded query crosses the closed Recall wire as one bounded string, while raw message identity stays separate',
    /if \(_runtimeHasOwn\(src, 'groundedQuery'\)\) payload\.groundedQuery = src\.groundedQuery/.test(homeNodeClientSource)
      && /const groundedQueryRaw = own\(body, 'groundedQuery'\)/.test(runtimeRecallSource)
      && /messageHash = CHAT_CORE\.stableToken\([\s\S]{0,180}shape\.message/.test(runtimeRecallSource)
      && /userMessage: shape\.groundedQuery \|\| shape\.message/.test(runtimeRecallSource));
  check('ambiguous/unresolved references skip Memory Recall rather than search the dangling wording',
    /if\(!_refRequired\|\|\(_referenceResolution&&_referenceResolution\.state==='RESOLVED'\)\)/.test(communication)
      && /if\(!_gRefRequired\|\|\(_referenceResolution&&_referenceResolution\.state==='RESOLVED'\)\)/.test(communication));

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-grounded-recall-'));
  const store = createMemoryStore({ dataDir: tempDir, logger: () => {} });
  store.open();
  try {
    const now = 1700000000000;
    store.putRecord({ id: 'mem_dgx_joke', title: '八台 DGX Spark 太贵的玩笑',
      summary: '之前聊过八台 DGX Spark 的价格玩笑。',
      content: '用户和 Luna 曾开玩笑说八台 DGX Spark 太贵。', rawSource: 'chat', sourceId: 'msg_joke',
      createdBy: 'user', created: now, lastActivated: now, visibility: 'public', visibleTo: [],
      excludeFrom: [], importance: 8, pinned: false, resolved: false, tags: ['玩笑'] });
    const retrievalCore = MEMORY_RETRIEVAL({ store: store, clock: () => now, random: () => 0, logger: () => {} });
    let observedQuery = '';
    const retrieval = {
      store: retrievalCore.store,
      retrieve: (id, opts) => { observedQuery = opts.userMessage; return retrievalCore.retrieve(id, opts); },
      reinforce: (...args) => retrievalCore.reinforce(...args),
      buildMemoryBlock: (...args) => retrievalCore.buildMemoryBlock(...args),
      buildRuntimeContext: (...args) => retrievalCore.buildRuntimeContext(...args)
    };
    const recall = createRuntimeRecall({
      memoryRetrieval: retrieval, memoryStore: store,
      registry: { getCharacterSpec: id => String(id) === 'friend-1' ? { id: id } : null },
      clock: () => now, logger: () => {}
    });
    const groundedRecall = await recall.run({
      operation: 'memory-recall', mode: 'shadow', characterId: 'friend-1', requestId: 'turn-grounded-1',
      conversationId: 'conversation:friend-1:new', message: '那个梗后来怎么说来着？',
      groundedQuery: memoryGrounded.groundedQuery, timeoutMs: 4000
    });
    check('Recall runtime searches the grounded query while keeping original message identity',
      groundedRecall.ok === true && observedQuery === memoryGrounded.groundedQuery
        && memoryGrounded.referentMemoryIds.includes('mem_dgx_joke')
        && groundedRecall.selectedIds.includes('mem_dgx_joke')
        && groundedRecall.turnIdentity.messageChars === '那个梗后来怎么说来着？'.length);

    store.deleteRecord('mem_dgx_joke', {});
    const afterDelete = await recall.run({
      operation: 'memory-recall', mode: 'shadow', characterId: 'friend-1', requestId: 'turn-grounded-2',
      conversationId: 'conversation:friend-1:new', message: '那个梗后来怎么说来着？',
      groundedQuery: unique.groundedQuery, timeoutMs: 4000
    });
    check('deleted canonical referent is not resurrected by grounding',
      afterDelete.ok === true && !afterDelete.selectedIds.includes('mem_dgx_joke'));

    const invalidQuery = await recall.run({
      operation: 'memory-recall', mode: 'shadow', characterId: 'friend-1', requestId: 'turn-grounded-bad',
      conversationId: 'conversation:friend-1:new', message: '那个梗后来怎么说来着？',
      groundedQuery: { selectedIds: ['mem_dgx_joke'] }, timeoutMs: 4000
    });
    check('grounded query is a bounded string, never a caller-supplied selection',
      invalidQuery.ok === false && invalidQuery.error === 'request-shape-invalid'
        && invalidQuery.field === undefined && recall.describe().requestFields.length === 8
        && recall.describe().optionalRequestFields.includes('groundedQuery'));
  } finally {
    try { store.close(); } catch (_) {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  console.log('\nChat reference resolution passed (' + passed + ' assertions)');
}

main().catch(error => { console.error(error && error.stack || error); process.exit(1); });
