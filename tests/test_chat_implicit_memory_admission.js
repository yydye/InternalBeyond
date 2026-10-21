'use strict';

/* Ordinary Chat candidate -> runtime admission -> existing canonical writer. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const IMPLICIT = require(path.join(ROOT, 'assets', 'js', 'chat-implicit-memory.js'));
const REFERENCE = require(path.join(ROOT, 'assets', 'js', 'chat-reference-resolution.js'));
const MEMORY_AUTHORITY = require(path.join(ROOT, 'assets', 'js', 'memory-authority.js'));
const MEMORY_CORE = require(path.join(ROOT, 'assets', 'js', 'understanding-derivation-core.js'));
const createMemoryStore = require(path.join(ROOT, 'services', 'home-node', 'memory-store.js'));
const memorySource = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'memory.js'), 'utf8');
const autoMemorySource = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'memory', 'auto-memory.js'), 'utf8');
const communication = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'communication.js'), 'utf8');
const htmlSource = fs.readFileSync(path.join(ROOT, 'InternalBeyond.html'), 'utf8');
const implicitSource = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'chat-implicit-memory.js'), 'utf8');

let passed = 0;
function check(name, condition, detail) {
  if (condition) { passed++; console.log('  PASS  ' + name); return; }
  console.error('  FAIL  ' + name + (detail ? '  -> ' + detail : ''));
  throw new Error(name + (detail ? ': ' + detail : ''));
}

function extractQuickCreateMemory() {
  const start = memorySource.indexOf('async function quickCreateMemory(data){');
  const end = memorySource.indexOf('\n/* ====================== UNDERSTANDING + THREAD', start);
  if (start < 0 || end < 0) throw new Error('quickCreateMemory boundary missing');
  const sandbox = { window: { IB: { homeNode: { memory: { authority: null } } } } };
  vm.createContext(sandbox);
  vm.runInContext(memorySource.slice(start, end) + '\nglobalThis.__quickCreateMemory = quickCreateMemory;', sandbox, { timeout: 5000 });
  return sandbox;
}

function makeLocal() {
  const rows = new Map();
  const clone = value => JSON.parse(JSON.stringify(value));
  return {
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

function candidate(content, evidence, category, extra) {
  return Object.assign({
    content: content,
    evidence: evidence,
    category: category,
    durability: 'stable',
    userRelevance: 'high',
    futureValue: 0.9,
    uncertainty: 0.05,
    confidence: 94,
    reasons: ['用户明确表达，对未来互动有持续价值']
  }, extra || {});
}

function operation(body) {
  return { kind: 'create', attrs: { category: 'personal_context', priority: 'normal' }, body: JSON.stringify(body) };
}

async function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-chat-implicit-memory-'));
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
      return Promise.resolve({ ok: true, records: page.records, revision: page.revision, truncated: false });
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
  const deps = {
    authority: authority,
    referenceResolver: REFERENCE,
    quickCreateMemory: quickCreate.__quickCreateMemory,
    similarity: MEMORY_CORE.textSimilarity,
    calibrate: input => MEMORY_CORE.calibrate(input, {
      extractKeywords: () => [],
      lookupEntries: async () => []
    })
  };

  const initial = store.countRecords();
  const disabled = await IMPLICIT.admit({ userText: '我的生日是 3 月 25 日。',
    operations: [operation(candidate('用户生日是 3 月 25 日', '我的生日是 3 月 25 日', 'personal_fact'))],
    sourceMessageId: 'msg_disabled', conversationId: 'conversation:user:main', cfg: { id: 'friend-1', autoMem: false }
  }, deps);
  const recordOnly = await IMPLICIT.admit({ userText: '我的生日是 3 月 25 日。',
    operations: [operation(candidate('用户生日是 3 月 25 日', '我的生日是 3 月 25 日', 'personal_fact'))],
    sourceMessageId: 'msg_record_only', conversationId: 'conversation:user:main', cfg: { id: 'friend-1', autoMem: true, amRecordOnly: true }
  }, deps);
  check('Auto Memory off and record-only both prevent implicit admission',
    disabled.reason === 'implicit-memory-disabled' && recordOnly.reason === 'implicit-memory-disabled'
      && store.countRecords() === initial && remotePutCalls === 0);

  const moveText = '我下个月要搬到东京。';
  const move = await IMPLICIT.admit({
    userText: moveText,
    operations: [operation(candidate('用户计划下个月搬到东京', '我下个月要搬到东京', 'ongoing_plan'))],
    sourceMessageId: 'msg_implicit_move_u', conversationId: 'conversation:user:main',
    timestamp: 1700000000000, cfg: { id: 'friend-1', autoMem: true }
  }, deps);
  check('future move statement is admitted through canonical Memory',
    move.ok === true && move.admitted === true && store.countRecords() === initial + 1);
  check('Home Node receipt and user-message provenance are runtime-authored',
    move.receipt.authority === 'home-node' && move.receipt.id === move.id
      && store.getRecord(move.id).sourceId === 'msg_implicit_move_u'
      && store.getRecord(move.id).provenance.conversationId === 'conversation:user:main');

  const birthday = await IMPLICIT.admit({
    userText: '我的生日是 3 月 25 日。',
    operations: [operation(candidate('用户生日是 3 月 25 日', '我的生日是 3 月 25 日', 'personal_fact', {
      // Forged authority fields are ignored by the closed runtime projection.
      id: 'model-minted-id', memoryId: 'model-memory-id', revision: 999, authority: 'model'
    }))],
    sourceMessageId: 'msg_implicit_birthday_u', conversationId: 'conversation:user:main', timestamp: 1700000001000,
    cfg: { id: 'friend-1', autoMem: true }
  }, deps);
  check('stable birthday fact becomes a canonical record without model-minted identity',
    birthday.ok === true && birthday.admitted === true && store.countRecords() === initial + 2
      && birthday.id !== 'model-minted-id' && birthday.receipt.authority === 'home-node');
  const implicitUiRows = await authority.getAll();
  check('implicit Chat write is returned by the canonical reader used by Memory UI',
    implicitUiRows.authority === 'home-node'
      && implicitUiRows.some(row => row.id === birthday.id && row.content.includes('3 月 25 日')));

  const preference = await IMPLICIT.admit({
    userText: '以后回答尽量短一点。',
    operations: [operation(candidate('用户偏好简短回答', '以后回答尽量短一点', 'preference'))],
    sourceMessageId: 'msg_implicit_preference_u', conversationId: 'conversation:user:main', timestamp: 1700000002000,
    cfg: { id: 'friend-1', autoMem: true }
  }, deps);
  check('stable response preference becomes a canonical candidate',
    preference.ok === true && preference.admitted === true && store.countRecords() === initial + 3);

  const project = await IMPLICIT.admit({
    userText: '我最近主要在开发 The Lost Beyond。',
    operations: [operation(candidate('用户近期主要在开发 The Lost Beyond', '我最近主要在开发 The Lost Beyond', 'ongoing_project'))],
    sourceMessageId: 'msg_implicit_project_u', conversationId: 'conversation:user:main', timestamp: 1700000002500,
    cfg: { id: 'friend-1', autoMem: true }
  }, deps);
  check('ongoing project context becomes a canonical candidate',
    project.ok === true && project.admitted === true && store.countRecords() === initial + 4);

  const providerChange = await IMPLICIT.admit({
    userText: '我已经不用之前那个 API 供应商了。',
    operations: [operation(candidate('用户已更换 API 供应商', '我已经不用之前那个 API 供应商了', 'provider_change'))],
    sourceMessageId: 'msg_implicit_provider_u', conversationId: 'conversation:user:main', timestamp: 1700000002750,
    referenceResolution: {
      state: 'RESOLVED', mode: 'write', mention: '之前那个 API 供应商', referentType: 'other',
      referentRefs: ['msg_provider_antecedent'],
      referenceEvidence: [{ messageId: 'msg_provider_antecedent', quote: 'Example API 供应商', role: 'assistant', speaker: 'Smoke' }],
      normalizedMeaning: '用户已不再使用 Example API 供应商',
      groundedQuery: 'Example API 供应商 停止使用', confidence: 0.96
    },
    referenceContextMessages: [{ id: 'msg_provider_antecedent', friendId: 'friend-1', role: 'assistant', content: '之前讨论的供应商是 Example API 供应商。' }],
    friendId: 'friend-1', threadId: '',
    cfg: { id: 'friend-1', autoMem: true }
  }, deps);
  check('provider change becomes an ongoing user-context candidate',
    providerChange.ok === true && providerChange.admitted === true && store.countRecords() === initial + 5
      && store.getRecord(providerChange.id).content === '用户已不再使用 Example API 供应商'
      && store.getRecord(providerChange.id).provenance.referenceMessageIds[0] === 'msg_provider_antecedent');

  const duplicate = await IMPLICIT.admit({
    userText: '我的生日是 3 月 25 日。',
    operations: [operation(candidate('用户生日是 3 月 25 日', '我的生日是 3 月 25 日', 'personal_fact'))],
    sourceMessageId: 'msg_implicit_birthday_repeat_u', conversationId: 'conversation:user:main', timestamp: 1700000003000,
    cfg: { id: 'friend-1', autoMem: true }
  }, deps);
  check('repeated existing birthday is deduplicated before writer call',
    duplicate.ok === true && duplicate.admitted === false && duplicate.reason === 'duplicate'
      && store.countRecords() === initial + 5);

  const transientMessages = [
    ['我去倒杯水。', candidate('用户现在去倒水', '我去倒杯水', 'personal_fact', { durability: 'temporary' })],
    ['今天有点困。', candidate('用户今天有点困', '今天有点困', 'personal_fact', { durability: 'temporary', futureValue: 0.1 })],
    ['我喜欢蓝色。', candidate('用户喜欢蓝色', '我喜欢蓝色', 'preference', { confidence: 45 })],
    ['我最近在做一个项目。', candidate('用户近期在做一个项目', '我最近在做一个项目', 'ongoing_project', { uncertainty: 0.8 })],
    ['我住在东京。', candidate('用户住在东京', '我住在东京', 'personal_fact', { userRelevance: 'low' })],
    ['哈哈笑死。', null]
  ];
  let transientWrites = 0;
  for (let i = 0; i < transientMessages.length; i++) {
    const pair = transientMessages[i];
    const result = await IMPLICIT.admit({
      userText: pair[0], operations: pair[1] ? [operation(pair[1])] : [],
      sourceMessageId: 'msg_transient_' + i, conversationId: 'conversation:user:main', timestamp: 1700000004000 + i,
      cfg: { id: 'friend-1', autoMem: true }
    }, Object.assign({}, deps, { quickCreateMemory: async payload => { transientWrites++; return quickCreate.__quickCreateMemory(payload); } }));
    check('transient/banter is ignored: ' + pair[0], result.admitted === false);
  }
  check('transient conversation does not create canonical records',
    transientWrites === 0 && store.countRecords() === initial + 5);

  const noEvidence = await IMPLICIT.admit({
    userText: '我的新项目叫 The Lost Beyond。',
    operations: [operation(candidate('用户在开发 The Lost Beyond', '用户在开发另一个项目', 'ongoing_project'))],
    sourceMessageId: 'msg_bad_evidence', conversationId: 'conversation:user:main', timestamp: 1700000005000,
    cfg: { id: 'friend-1', autoMem: true }
  }, deps);
  check('candidate without verbatim user evidence is rejected',
    noEvidence.admitted === false && noEvidence.reason === 'evidence-not-grounded'
      && store.countRecords() === initial + 5);

  const admissionFailure = await IMPLICIT.admit({
    userText: '我正在把项目迁移到新服务器。',
    operations: [operation(candidate('用户正在把项目迁移到新服务器', '我正在把项目迁移到新服务器', 'ongoing_plan'))],
    sourceMessageId: 'msg_admission_failure', conversationId: 'conversation:user:main', timestamp: 1700000006000,
    cfg: { id: 'friend-1', autoMem: true }
  }, Object.assign({}, deps, { calibrate: async () => ({ confidence: 0, rejected: 'admission-core-unavailable' }) }));
  check('admission failure fails closed without a Memory write',
    admissionFailure.admitted === false && admissionFailure.reason === 'admission-rejected'
      && store.countRecords() === initial + 5);

  online = false;
  const putsBeforeOffline = remotePutCalls;
  const offline = await IMPLICIT.admit({
    userText: '我最近主要在开发 The Lost Beyond。',
    operations: [operation(candidate('用户主要在开发 The Lost Beyond', '我最近主要在开发 The Lost Beyond', 'ongoing_project'))],
    sourceMessageId: 'msg_implicit_offline', conversationId: 'conversation:user:main', timestamp: 1700000007000,
    cfg: { id: 'friend-1', autoMem: true }
  }, deps);
  check('Home Node offline fails closed with no canonical write',
    offline.admitted === false && offline.reason === 'home-node-offline'
      && store.countRecords() === initial + 5 && remotePutCalls === putsBeforeOffline);

  let releasePending;
  let scheduledFinished = false;
  const pendingWork = new Promise(resolve => { releasePending = resolve; });
  const scheduledReturn = IMPLICIT.schedule({ sourceMessageId: 'msg_background_failure' }, {
    process: () => pendingWork,
    onResult: () => { scheduledFinished = true; }
  });
  check('background admission scheduling returns immediately and cannot block Chat',
    scheduledReturn === undefined && scheduledFinished === false);
  releasePending(failForTest());
  await new Promise(resolve => setImmediate(resolve));
  check('background admission completion is detached from the Chat response path', scheduledFinished === true);

  let rejectedScheduleResult = null;
  IMPLICIT.schedule({ sourceMessageId: 'msg_background_exception' }, {
    process: () => Promise.reject(new Error('private failure detail')),
    onResult: result => { rejectedScheduleResult = result; }
  });
  await new Promise(resolve => setImmediate(resolve));
  check('unexpected background admission failure reports a closed reason without exception text',
    rejectedScheduleResult && rejectedScheduleResult.ok === false
      && rejectedScheduleResult.reason === 'admission-unavailable'
      && !JSON.stringify(rejectedScheduleResult).includes('private failure detail'));

  const tracedImplicitSchedules = (communication.match(/onResult:function\(_result\)\{_ibTraceImplicitMemoryResult\(_turnTraceId,_result\)\}/g) || []).length;
  check('streaming and non-streaming implicit Memory admission report outcomes through the existing Turn Trace',
    tracedImplicitSchedules === 2 && communication.includes("memoryAuthority:'implicit_extraction'")
      && communication.includes("memoryAuthority:'implicit_candidate'"));

  check('explicit Host Action still precedes provider execution',
    communication.includes('const _explicitMemoryIntent=')
      && communication.indexOf('window.IBChatExplicitMemory.route') < communication.indexOf('callApiChatStream(cfg,messages'));
  check('ordinary Chat prompt is opt-in and advertises the bounded advisory fields',
    /amBuildInject\(cfg,_ctxText,\{chatImplicit:true\}\)/.test(communication)
      && /durability/.test(autoMemorySource) && /userRelevance/.test(autoMemorySource)
      && /evidence/.test(autoMemorySource) && /runtime admission/.test(autoMemorySource));
  check('implicit admission module is loaded before Chat dispatch',
    htmlSource.indexOf('assets/js/chat-implicit-memory.js') >= 0
      && htmlSource.indexOf('assets/js/chat-implicit-memory.js') < htmlSource.indexOf('assets/js/communication.js'));
  check('implicit candidate path delegates to the existing canonical writer and adds no store',
    /quickCreateMemory/.test(implicitSource) && /canonicalReceipt: true/.test(implicitSource)
      && !/dbPut\(['"]autoMemory/.test(implicitSource) && !/createObjectStore|DB_VER/.test(implicitSource));

  online = true;
  const referenceText = '那个梗以后别老提了。';
  const referenceHistory = [{ id: 'msg_joke_antecedent', friendId: 'friend-1', role: 'assistant',
    senderName: 'Smoke', content: '之前我们开玩笑说八台 DGX Spark 太贵。' }];
  const referenceInput = {
    userMessage: referenceText, history: referenceHistory, currentMessageId: 'msg_reference_joke',
    conversationId: 'conversation:user:main', friendId: 'friend-1', threadId: '', mode: 'write'
  };
  const preparedReference = REFERENCE.prepare(referenceInput);
  const groundedReference = REFERENCE.parseResolution({
    state: 'RESOLVED', mention: '那个梗', referentType: 'joke',
    referents: [{ ref: 'R1', evidence: '八台 DGX Spark 太贵' }],
    normalizedMeaning: '用户不希望频繁重复提及“八台 DGX Spark 太贵”的玩笑',
    groundedQuery: '八台 DGX Spark 太贵的玩笑', confidence: 0.96
  }, preparedReference);
  const groundedWrite = await IMPLICIT.admit({
    userText: referenceText,
    operations: [operation(candidate('用户不希望频繁重复提及那个梗', referenceText, 'preference'))],
    sourceMessageId: 'msg_reference_joke', conversationId: referenceInput.conversationId,
    timestamp: 1700000008000, friendId: 'friend-1', threadId: '',
    referenceContextMessages: referenceHistory, referenceResolution: groundedReference,
    cfg: { id: 'friend-1', autoMem: true }
  }, deps);
  const groundedRecord = groundedWrite.ok ? store.getRecord(groundedWrite.id) : null;
  check('unique recent joke referent writes grounded meaning, not the dangling phrase',
    groundedReference.state === 'RESOLVED' && groundedWrite.admitted === true
      && groundedRecord.content === '用户不希望频繁重复提及“八台 DGX Spark 太贵”的玩笑'
      && !groundedRecord.content.includes('那个梗'));
  check('reference provenance preserves the original user message and antecedent message IDs',
    groundedRecord && groundedRecord.sourceId === 'msg_reference_joke'
      && groundedRecord.provenance.sourceMessageId === 'msg_reference_joke'
      && groundedRecord.provenance.referenceMessageIds[0] === 'msg_joke_antecedent');

  const ambiguousText = '那个梗以后别老提了。';
  const ambiguousHistory = referenceHistory.concat([{ id: 'msg_joke_antecedent_2', friendId: 'friend-1', role: 'assistant',
    senderName: 'Smoke', content: '另一个梗是蓝屏后重启三次。' }]);
  const ambiguousInput = Object.assign({}, referenceInput, { userMessage: ambiguousText, history: ambiguousHistory });
  const ambiguousResolution = REFERENCE.parseResolution({
    state: 'AMBIGUOUS', mention: '那个梗', referentType: 'joke',
    referents: [{ ref: 'R1', evidence: '八台 DGX Spark 太贵' }, { ref: 'R2', evidence: '蓝屏后重启三次' }],
    normalizedMeaning: '', groundedQuery: '', confidence: 0.4
  }, REFERENCE.prepare(ambiguousInput));
  const beforeAmbiguous = store.countRecords();
  const ambiguousWrite = await IMPLICIT.admit({
    userText: ambiguousText,
    operations: [operation(candidate('用户不喜欢那个梗', ambiguousText, 'preference'))],
    sourceMessageId: 'msg_ambiguous_joke', conversationId: referenceInput.conversationId,
    timestamp: 1700000009000, friendId: 'friend-1', threadId: '',
    referenceContextMessages: ambiguousHistory, referenceResolution: ambiguousResolution,
    cfg: { id: 'friend-1', autoMem: true }
  }, deps);
  check('ambiguous referents fail closed and create no canonical row',
    ambiguousResolution.state === 'AMBIGUOUS' && ambiguousWrite.admitted === false
      && ambiguousWrite.reason === 'reference-ambiguous' && store.countRecords() === beforeAmbiguous);

  const unresolvedReference = await REFERENCE.resolve({ userMessage: '新会话里那个还记得吧？', history: [],
    currentMessageId: 'msg_reference_unresolved', conversationId: 'conversation:user:new', mode: 'write' }, {
    resolveModel: async () => { throw new Error('no context should be read or guessed'); }
  });
  const beforeUnresolved = store.countRecords();
  const unresolvedWrite = await IMPLICIT.admit({
    userText: '新会话里那个还记得吧？',
    operations: [operation(candidate('用户还记得那个', '那个还记得吧', 'ongoing_plan'))],
    sourceMessageId: 'msg_reference_unresolved', conversationId: 'conversation:user:new',
    friendId: 'friend-1', threadId: '', referenceContextMessages: [], referenceResolution: unresolvedReference,
    cfg: { id: 'friend-1', autoMem: true }
  }, deps);
  check('unresolved reference never fabricates a referent or canonical Memory row',
    unresolvedReference.state === 'UNRESOLVED' && unresolvedWrite.admitted === false
      && unresolvedWrite.reason === 'reference-unresolved' && store.countRecords() === beforeUnresolved);

  const forgedResolution = Object.assign({}, groundedReference, { referentRefs: ['forged-memory-id'] });
  const beforeForged = store.countRecords();
  const forgedReferenceWrite = await IMPLICIT.admit({
    userText: referenceText,
    operations: [operation(candidate('用户不希望频繁重复提及那个梗', referenceText, 'preference'))],
    sourceMessageId: 'msg_forged_reference', conversationId: referenceInput.conversationId,
    timestamp: 1700000010000, friendId: 'friend-1', threadId: '',
    referenceContextMessages: referenceHistory, referenceResolution: forgedResolution,
    cfg: { id: 'friend-1', autoMem: true }
  }, deps);
  check('model-minted/non-conversation reference IDs are rejected',
    forgedReferenceWrite.admitted === false && store.countRecords() === beforeForged);

  store.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
  console.log('\n' + passed + ' assertions passed');
}

function failForTest() { return { ok: false, admitted: false, reason: 'simulated-failure' }; }

main().catch(error => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
