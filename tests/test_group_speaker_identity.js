'use strict';

/* Internal Beyond · P24-M2 · Speaker Identity & Visibility Foundation 测试
   （browser 组：先跑纯契约断言，再跑真实浏览器群聊同名场景；运行：
     node tests/test_group_speaker_identity.js）

   本阶段冻结的是**身份读路径**：群聊历史里"这句话是谁说的"只能由 canonical
   `metadata.speakerId` 回答；`senderName` 只允许用于显示与 legacy 唯一精确匹配。

   覆盖用户给定 A–O：
     A canonical speakerId wins
     B senderName 与 speakerId 冲突时 speakerId wins
     C same-name canonical：A/B 正确区分
     D legacy unique exact-name：可以 resolve
     E legacy duplicate name：unresolved
     F legacy missing name：unresolved
     G invalid speakerId：unresolved
     H speakerId 不属于当前 group：unresolved
     I USER classification
     J tool continuation：同 speaker（且不依赖 sequenceIndex）
     K UNKNOWN never becomes SELF
     L no DB mutation（真 Home Node store：resolver 不写库、revision 不变）
     M no migration（读时解析；生产代码里没有回填/迁移路径）
     N single chat unchanged
     O senderName 剩余 identity reader = canonical 路径 0

   最后是本阶段最关键的真实 E2E（§18）：两个**同名**角色，验证真正进入模型请求的
   context 里，A 的发言在 B 眼里是 OTHER（user 行）而不是 SELF（assistant 行）。 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const assert = require('assert/strict');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const Core = require(path.join(ROOT, 'assets', 'js', 'group-runtime-core.js'));
const createChatStore = require(path.join(ROOT, 'services', 'home-node', 'chat-store.js'));

const harness = fs.readFileSync(path.join(__dirname, 'test_chat_smoke.js'), 'utf8');
const boundary = harness.indexOf('async function main() {');
assert.ok(boundary > 0, 'existing CDP harness boundary changed');
const { chromePath, Cdp, evaluate, waitFor, freePort } = new Function('require', '__dirname',
  harness.slice(0, boundary) + '\nreturn {chromePath,Cdp,evaluate,waitFor,freePort};')(require, __dirname);

const PAGE_URL = 'file:///' + path.join(ROOT, 'InternalBeyond.html').replace(/\\/g, '/');
const GROUP_ID = 'group_1700000000000';
const A_ID = 'friend_m2_a';
const B_ID = 'friend_m2_b';
const SAME_NAME = '初音未来';
const MODEL_A = 'm2-model-a';
const MODEL_B = 'm2-model-b';

let failures = 0;
let passes = 0;
function check(name, cond, detail) {
  if (cond) { passes++; console.log('  PASS  ' + name); }
  else { failures++; console.error('  FAIL  ' + name + (detail !== undefined ? '  -> ' + JSON.stringify(detail).slice(0, 320) : '')); }
}
function stripComments(src) {
  return String(src).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}
function rmWithRetry(dir, tries) {
  for (let i = 0; i < (tries || 5); i++) {
    try { fs.rmSync(dir, { recursive: true, force: true }); return true; } catch (e) { /* retry */ }
    const end = Date.now() + 200;
    while (Date.now() < end) { /* busy-wait 200ms */ }
  }
  return false;
}

/* ── 固定样本（同名双角色）────────────────────────────────────────────── */
const PARTS_SAME = [{ id: A_ID, name: SAME_NAME }, { id: B_ID, name: SAME_NAME }];
const PARTS_UNIQUE = [{ id: A_ID, name: SAME_NAME }];
const MSG_A = { role: 'assistant', content: 'A 说的话', senderName: SAME_NAME, metadata: { speakerId: A_ID, turnId: 'turn_a', sequenceIndex: 0 } };
const MSG_B = { role: 'assistant', content: 'B 说的话', senderName: SAME_NAME, metadata: { speakerId: B_ID, turnId: 'turn_b', sequenceIndex: 0 } };
const MSG_LEGACY = { role: 'assistant', content: '旧消息', senderName: SAME_NAME };

/* ── A–K · resolver / classifier 纯契约 ─────────────────────────────────── */
function pureContract() {
  const resolvedA = Core.resolveSpeakerId(MSG_A, { participants: PARTS_SAME });
  check('A.canonicalSpeakerIdWins', resolvedA.speakerId === A_ID && resolvedA.source === 'metadata' && resolvedA.confidence === 'canonical', resolvedA);
  /* senderName 与 speakerId 冲突（同名群：名字同时匹配 A 与 B）⇒ speakerId 胜出 */
  const conflict = Core.resolveSpeakerId({ role: 'assistant', content: 'x', senderName: SAME_NAME, metadata: { speakerId: B_ID } }, { participants: PARTS_SAME });
  check('B.speakerIdBeatsSenderName', conflict.speakerId === B_ID && conflict.confidence === 'canonical', conflict);

  check('C.sameName.canonical.aSeesSelfAndOther',
    Core.classifyMessageForSpeaker(MSG_A, A_ID, PARTS_SAME) === 'SELF'
    && Core.classifyMessageForSpeaker(MSG_B, A_ID, PARTS_SAME) === 'OTHER');
  check('C.sameName.canonical.bSeesSelfAndOther',
    Core.classifyMessageForSpeaker(MSG_B, B_ID, PARTS_SAME) === 'SELF'
    && Core.classifyMessageForSpeaker(MSG_A, B_ID, PARTS_SAME) === 'OTHER');
  check('C.sameName.distinguishedByIdNotName',
    Core.classifyMessageForSpeaker(MSG_A, A_ID, PARTS_SAME) !== Core.classifyMessageForSpeaker(MSG_A, B_ID, PARTS_SAME));

  const legacyUnique = Core.resolveSpeakerId(MSG_LEGACY, { participants: PARTS_UNIQUE });
  check('D.legacyUniqueExactNameResolves', legacyUnique.speakerId === A_ID && legacyUnique.source === 'legacy-exact-name' && legacyUnique.confidence === 'legacy', legacyUnique);
  const legacyDup = Core.resolveSpeakerId(MSG_LEGACY, { participants: PARTS_SAME });
  check('E.legacyDuplicateNameUnresolved', legacyDup.speakerId === '' && legacyDup.source === 'unresolved' && legacyDup.reason === 'legacy-ambiguous', legacyDup);
  const legacyNoName = Core.resolveSpeakerId({ role: 'assistant', content: 'x', metadata: { config_id: A_ID } }, { participants: PARTS_SAME });
  check('F.legacyMissingNameUnresolved', legacyNoName.speakerId === '' && legacyNoName.reason === 'no-name', legacyNoName);
  const invalid = Core.resolveSpeakerId({ role: 'assistant', metadata: { speakerId: 'group_9' } }, { participants: PARTS_SAME });
  check('G.invalidSpeakerIdUnresolved', invalid.speakerId === '' && invalid.reason === 'invalid-speaker-id', invalid);
  const outOfGroup = Core.resolveSpeakerId({ role: 'assistant', metadata: { speakerId: 'friend_zzz' } }, { participants: PARTS_SAME });
  check('H.speakerNotInGroupUnresolved', outOfGroup.speakerId === '' && outOfGroup.reason === 'speaker-not-a-participant', outOfGroup);
  check('I.userClassifiedAsUser',
    Core.classifyMessageForSpeaker({ role: 'user', content: 'hi' }, A_ID, PARTS_SAME) === 'USER'
    && Core.classifyMessageForSpeaker({ role: 'user', content: 'hi', senderName: SAME_NAME }, B_ID, PARTS_SAME) === 'USER'
    && Core.resolveSpeakerId({ role: 'user', content: 'hi', senderName: SAME_NAME }, { participants: PARTS_SAME }).reason === 'user-role');

  const contA = { role: 'assistant', content: 'A 的工具续轮', senderName: SAME_NAME, metadata: { speakerId: A_ID, turnId: 'turn_a', sequenceIndex: 1, groupTurnId: 'gturn_x', groupOrder: 0 } };
  check('J.toolContinuationSameSpeaker',
    Core.classifyMessageForSpeaker(contA, A_ID, PARTS_SAME) === 'SELF'
    && Core.classifyMessageForSpeaker(contA, B_ID, PARTS_SAME) === 'OTHER');
  check('J.speakerDoesNotDependOnSequenceIndex',
    Core.resolveSpeakerId(contA, { participants: PARTS_SAME }).speakerId
    === Core.resolveSpeakerId(Object.assign({}, contA, { metadata: Object.assign({}, contA.metadata, { sequenceIndex: 0 }) }), { participants: PARTS_SAME }).speakerId);

  const unresolvedSamples = [MSG_LEGACY];
  check('K.unknownNeverBecomesSelf',
    unresolvedSamples.every(m => Core.classifyMessageForSpeaker(m, A_ID, PARTS_SAME) === 'UNKNOWN'
      && Core.classifyMessageForSpeaker(m, B_ID, PARTS_SAME) === 'UNKNOWN')
    && Core.classifyMessageForSpeaker({ role: 'assistant', metadata: { speakerId: 'group_9' } }, A_ID, PARTS_SAME) === 'UNKNOWN'
    && Core.classifyMessageForSpeaker({ role: 'assistant', metadata: { speakerId: 'friend_zzz' } }, A_ID, PARTS_SAME) === 'UNKNOWN'
    && Core.classifyMessageForSpeaker({ role: 'assistant', content: 'x' }, A_ID, PARTS_SAME) === 'UNKNOWN'
    && Core.classifyMessageForSpeaker(MSG_A, '', PARTS_SAME) === 'UNKNOWN');
  /* 参与者名单缺失 ⇒ 一律 UNKNOWN（fail closed），绝不按名字猜 */
  check('K.noParticipantsFailsClosed',
    Core.classifyMessageForSpeaker(MSG_A, A_ID, []) === 'UNKNOWN'
    && Core.resolveSpeakerId(MSG_LEGACY, { participants: [] }).reason === 'no-participants');
  /* system 行不参与身份判定 */
  check('K.systemIsUnknown', Core.classifyMessageForSpeaker({ role: 'system', content: 'x' }, A_ID, PARTS_SAME) === 'UNKNOWN');
}

/* ── L/M · 不写库、不迁移（真 Home Node store）────────────────────────── */
function noMutationNoMigration() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-m2-id-'));
  const store = createChatStore({ dataDir: dir });
  store.open();
  const rows = [
    { id: 'msg_1700000000001_100', role: 'assistant', content: 'canonical A', friendId: GROUP_ID, senderName: SAME_NAME, timestamp: 1700000000001, metadata: { speakerId: A_ID, turnId: 'turn_a', sequenceIndex: 0 } },
    { id: 'msg_1700000000002_100', role: 'assistant', content: 'legacy', friendId: GROUP_ID, senderName: SAME_NAME, timestamp: 1700000000002, metadata: {} }
  ];
  const put = store.putMessages(rows);
  check('L.storeSeeded', put.ok === true && put.count === 2, JSON.stringify(put).slice(0, 160));
  const page = store.listMessages({ friendId: GROUP_ID });
  const before = JSON.stringify(page.messages.map(m => [m.id, m.content, m.metadata]));
  const revBefore = store.getRevision();
  /* 只读地跑 resolver / classifier（含 legacy 与 canonical 两种输入） */
  page.messages.forEach(m => {
    Core.resolveSpeakerId(m, { participants: PARTS_SAME });
    Core.resolveSpeakerId(m, { participants: PARTS_UNIQUE });
    Core.classifyMessageForSpeaker(m, A_ID, PARTS_SAME);
    Core.classifyMessageForSpeaker(m, B_ID, PARTS_SAME);
  });
  const after = JSON.stringify(store.listMessages({ friendId: GROUP_ID }).messages.map(m => [m.id, m.content, m.metadata]));
  check('L.resolverDoesNotMutateStore', before === after && store.getRevision() === revBefore,
    { changed: before !== after, revBefore, revAfter: store.getRevision() });
  check('L.legacyStaysWithoutSpeakerId',
    JSON.parse(after).every(r => r[0] !== 'msg_1700000000002_100' || !r[2] || !('speakerId' in r[2])));
  store.close();
  rmWithRetry(dir, 5);

  const code = stripComments(read('assets/js/group-runtime-core.js'));
  check('M.moduleHasNoPersistence', !/dbPut|chatMessages|localStorage|indexedDB|sqlite|INSERT|migration/i.test(code));
  const comm = read('assets/js/communication.js');
  check('M.noBackfillWriter', !/speakerId\s*[:=][^;\n]*senderName/.test(stripComments(comm)));
  check('M.noDbVersionBump', require('./helpers/db-schema-authority.js').isVersion('InternalBeyondDB', 24));
}

/* ── N/O · 单聊隔离 + senderName 剩余用途审计（源码级）────────────────── */
function sourceBoundaries() {
  const comm = read('assets/js/communication.js');
  const code = stripComments(comm);
  const oneToOne = comm.slice(comm.indexOf('/* ===== NORMAL 1-ON-1 CHAT ===== */'), comm.indexOf('function appendChatBubble('));
  check('N.singleChatHasNoGroupIdentityReader', !/resolveSpeakerId|_ibGroupClassifyMessage|_gParticipants/.test(stripComments(oneToOne)));
  check('O.groupContextUsesResolver', /if\(_ibGroupClassifyMessage\(m,cfg\.id,_gParticipants\)==='SELF'\)/.test(code));
  check('O.oldNameEqualityIsGone', !/\(m\.senderName\|\|''\)===selfName/.test(code));
  check('O.participantsFromCanonicalMemberSource', /const _gParticipants=_ibGroupParticipants\(getGroupMemberIds\(group\)\)/.test(code));
  check('O.messageApiConfigPrefersSpeakerId', /const speakerId=m\.metadata&&m\.metadata\.speakerId;/.test(code) && /if\(speakerId\)\{const bySpeaker=all\.find/.test(code));
  const ws = read('assets/js/workspace.js');
  check('O.continuationUsesResolver', /resolveSpeakerId\(m,\{participants:_cParts\}\)/.test(ws) && /_cHits\.length===1/.test(ws));
  /* M2 只改"谁说的"（sendChatMessage 的历史映射），不把 resolver 塞进 group context builder。 */
  const ctxFnSrc = comm.slice(comm.indexOf('async function _buildGroupChatContext('), comm.indexOf('async function buildChatContext('));
  check('O.resolverNotPushedIntoContextBuilder',
    !/classifyMessageForSpeaker|resolveSpeakerId|_ibGroupClassifyMessage/.test(ctxFnSrc) && /【群聊规则】/.test(ctxFnSrc));
  /* senderName 剩余用途审计：任何"由名字推导身份"的赋值都必须是 0 */
  check('O.noIdentityDerivedFromName',
    !/(^|[^\w.])speakerId\s*[:=]\s*[^;\n]*(senderName|nickname)/.test(code)
    && !/(^|[^\w.])turnId\s*[:=]\s*[^;\n]*(senderName|nickname)/.test(code));
  const mcfg = comm.slice(comm.indexOf('function _messageApiConfig('), comm.indexOf('function _messageShowThinking('));
  check('O.nameLookupIsLastResortInApiConfig',
    mcfg.indexOf('metadata.speakerId') >= 0 && mcfg.indexOf('metadata.speakerId') < mcfg.indexOf('m.senderName'));
  check('O.namePathsSurviveOnlyAsDisplayOrWithdrawNotice',
    /function _getApiAvatarByName\(senderName\)/.test(comm) && /'【'\+who\+'撤回了一条消息】'/.test(comm));
}

/* ── 真实浏览器同名 E2E（§18）────────────────────────────────────────── */
function startMock() {
  const requests = [];
  const server = http.createServer((req, res) => {
    const headers = {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-API-Key,anthropic-version,x-goog-api-key'
    };
    if (req.method === 'OPTIONS') { res.writeHead(204, headers); res.end(); return; }
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(raw); } catch (e) { /* ignore */ }
      requests.push({ model: String(body.model || ''), messages: Array.isArray(body.messages) ? body.messages : [] });
      res.writeHead(200, headers);
      res.end(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'reply-from:' + String(body.model || '?') }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 9, completion_tokens: 4, total_tokens: 13 }
      }));
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, requests })));
}
function rolesContaining(messages, needle) {
  const out = [];
  (messages || []).forEach(m => {
    const c = typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '');
    if (needle && c.indexOf(needle) >= 0) out.push(String(m.role));
  });
  return out;
}

async function browserE2E() {
  const chrome = chromePath();
  check('browser.binaryFound', !!chrome, chrome);
  if (!chrome) return;
  const mock = await startMock();
  const port = await freePort();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-m2-e2e-'));
  const browser = spawn(chrome, ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    '--allow-file-access-from-files', '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=' + port, '--user-data-dir=' + profile, 'about:blank'], { stdio: 'ignore', windowsHide: true });
  let cdp;
  try {
    let ready = false;
    for (let i = 0; i < 120; i++) {
      try { const r = await fetch('http://127.0.0.1:' + port + '/json/version'); if (r.ok) { ready = true; break; } } catch (e) { /* starting */ }
      await new Promise(r => setTimeout(r, 100));
    }
    check('browser.ready', ready);
    const tab = await (await fetch('http://127.0.0.1:' + port + '/json/new?' + encodeURIComponent(PAGE_URL), { method: 'PUT' })).json();
    cdp = await Cdp.connect(tab.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable');
    const exceptions = [];
    cdp.on('Runtime.exceptionThrown', p => exceptions.push(String(
      (p.exceptionDetails && p.exceptionDetails.exception && p.exceptionDetails.exception.description)
      || (p.exceptionDetails && p.exceptionDetails.text) || '')));
    check('page.chatReady', await waitFor(cdp, "typeof window.sendChatMessage==='function' && typeof window.apiConfigs!=='undefined' && !!(window.IBGroupRuntime&&window.IBGroupRuntime.resolveSpeakerId)", 25000));
    await evaluate(cdp, "window.confirm=function(){return true};");
    await evaluate(cdp, "(function(){window.__m2Errs=[];var o=window.IBERR&&window.IBERR.report;if(o&&!window.__m2Hooked){window.__m2Hooked=true;window.IBERR.report=function(e){try{window.__m2Errs.push(String((e&&e.stack)||e))}catch(x){};return o.apply(this,arguments)}}})()");

    const ep = 'http://127.0.0.1:' + mock.port + '/v1/chat/completions';
    await evaluate(cdp, "(function(){var mk=function(id,model){return {id:id,nickname:'" + SAME_NAME + "',model:model,endpoint:'" + ep + "',apiKey:'',provider:'custom',systemPrompt:'你是测试角色。',temperature:1,streaming:false,showThinking:false,promptCache:false,created:Date.now()}};dbPut('apiConfigs',mk('" + A_ID + "','" + MODEL_A + "'));dbPut('apiConfigs',mk('" + B_ID + "','" + MODEL_B + "'));return dbPut('groups',{id:'" + GROUP_ID + "',name:'M2 Same Name Group',members:[{characterId:'" + A_ID + "',status:'active',joinedAt:1},{characterId:'" + B_ID + "',status:'active',joinedAt:1}],memoryEnabled:false,created:1});})()");
    await evaluate(cdp, "loadApiConfigs()");
    check('fixtures.sameDisplayNameDifferentIds', await evaluate(cdp, "(function(){var a=apiConfigs.find(function(x){return x.id==='" + A_ID + "'}),b=apiConfigs.find(function(x){return x.id==='" + B_ID + "'});return !!a&&!!b&&(a.nickname||a.model)===(b.nickname||b.model)&&a.id!==b.id;})()"));

    const send = t => "(function(){activeFriendId='" + GROUP_ID + "';activeThreadId=null;openChatPanel();var i=document.getElementById('chat-input');i.value='" + t + "';return sendChatMessage()})()";
    const bots = "(async function(){var all=await dbGetByIndex('chatMessages','byFriend','" + GROUP_ID + "');return all.filter(function(m){return m.role==='assistant'}).map(function(m){return {content:m.content,md:m.metadata||{},senderName:m.senderName}})})()";

    /* 回合 1：A、B 各回一条（此刻历史里还没有彼此的回复） */
    await evaluate(cdp, send('M2 turn one'));
    check('e2e.turn1Replies', await waitFor(cdp, "(async function(){var all=await dbGetByIndex('chatMessages','byFriend','" + GROUP_ID + "');return all.filter(function(m){return m.role==='assistant'}).length>=2;})()", 25000));
    const turn1 = await evaluate(cdp, bots);
    const aText1 = (turn1.find(r => r.md.speakerId === A_ID) || {}).content || '';
    const bText1 = (turn1.find(r => r.md.speakerId === B_ID) || {}).content || '';
    check('e2e.turn1IdentityRecorded', !!aText1 && !!bText1 && aText1 !== bText1, { aText1, bText1 });
    check('e2e.turn1SameSenderNameOnBoth', turn1.slice(0, 2).every(r => r.senderName === SAME_NAME), turn1.map(r => r.senderName));

    /* 回合 2：A 先发言 → B 的请求里同时出现 A 的本轮回复（roundExtras）与上一轮回复 */
    mock.requests.length = 0;
    await evaluate(cdp, send('M2 turn two'));
    check('e2e.turn2Replies', await waitFor(cdp, "(async function(){var all=await dbGetByIndex('chatMessages','byFriend','" + GROUP_ID + "');return all.filter(function(m){return m.role==='assistant'}).length>=4;})()", 25000));

    /* 只取**群聊回合**的请求：同一页面上 diary / proactive 也会打到同一个 mock 端点，
       用本轮用户消息文本把它们排除掉。 */
    const chatReqs = mock.requests.filter(r => rolesContaining(r.messages, 'M2 turn two').length > 0);
    const reqA = chatReqs.find(r => r.model === MODEL_A);
    const reqB = chatReqs.find(r => r.model === MODEL_B);
    check('e2e.bothMembersCalledWithDistinctModels', !!reqA && !!reqB && reqA !== reqB && chatReqs.length === 2,
      { chatReqs: chatReqs.map(r => r.model), all: mock.requests.map(r => r.model) });
    if (failures > 0) {
      console.log('  INFO needles: ' + JSON.stringify({ aText1, bText1 }));
      console.log('  INFO reqModels: ' + JSON.stringify(mock.requests.map(r => r.model)));
      console.log('  INFO reqB roles: ' + JSON.stringify((reqB && reqB.messages || []).map(m => String(m.role))));
      console.log('  INFO reqB bodies: ' + JSON.stringify((reqB && reqB.messages || []).map(m => String(typeof m.content === 'string' ? m.content.slice(0, 120) : '[parts]'))).slice(0, 900));
    }

    /* B 的视角：A 的往轮回复必须是 user 行（OTHER），绝不能是 assistant 行（SELF） */
    const bSeesA = rolesContaining(reqB && reqB.messages, aText1);
    const bSeesB = rolesContaining(reqB && reqB.messages, bText1);
    check('e2e.B_sees_A_asOtherUserRole', bSeesA.length > 0 && bSeesA.every(r => r === 'user'), bSeesA);
    check('e2e.B_sees_own_asSelfAssistantRole', bSeesB.length > 0 && bSeesB.every(r => r === 'assistant'), bSeesB);
    /* A 的视角：自己的往轮回复是 assistant，B 的是 user */
    const aSeesA = rolesContaining(reqA && reqA.messages, aText1);
    const aSeesB = rolesContaining(reqA && reqA.messages, bText1);
    check('e2e.A_sees_own_asSelfAssistantRole', aSeesA.length > 0 && aSeesA.every(r => r === 'assistant'), aSeesA);
    check('e2e.A_sees_B_asOtherUserRole', aSeesB.length > 0 && aSeesB.every(r => r === 'user'), aSeesB);
    /* 同名标签仍在（显示层允许），但身份判定已不依赖它 */
    check('e2e.sameNameLabelStillDisplayedInTranscript',
      (reqB && reqB.messages || []).some(m => typeof m.content === 'string' && m.content.indexOf('[' + SAME_NAME + ']') >= 0));

    /* 单聊：同一页面，单聊回合不得出现群身份分类路径 */
    await evaluate(cdp, "(function(){activeFriendId='" + A_ID + "';activeThreadId=null;openChatPanel();var i=document.getElementById('chat-input');i.value='M2 single';return sendChatMessage()})()");
    check('e2e.singleChatStillWorks', await waitFor(cdp, "(async function(){var all=await dbGetByIndex('chatMessages','byFriend','" + A_ID + "');return all.filter(function(m){return m.role==='assistant'}).length>=1;})()", 25000));
    const singleRows = await evaluate(cdp, "(async function(){var all=await dbGetByIndex('chatMessages','byFriend','" + A_ID + "');return all.filter(function(m){return m.role==='assistant'}).map(function(m){return m.metadata||{}})})()");
    check('e2e.singleChatHasNoGroupIdentity', singleRows.every(m => !('groupTurnId' in m) && !('groupOrder' in m)));
    check('e2e.noSwallowedErrors', !(await evaluate(cdp, 'window.__m2Errs||[]')).some(e => /begin|undefined/.test(e)), (await evaluate(cdp, 'window.__m2Errs||[]')).slice(0, 2));
    check('e2e.noUncaughtExceptions', exceptions.length === 0, exceptions.slice(0, 3));
  } finally {
    try { browser.kill(); } catch (e) { /* ignore */ }
    try { mock.server.close(); } catch (e) { /* ignore */ }
    rmWithRetry(profile, 5);
  }
}

async function main() {
  console.log('== P24-M2 · Speaker Identity & Visibility Foundation 测试 ==');
  pureContract();
  noMutationNoMigration();
  sourceBoundaries();
  await browserE2E();
  console.log(failures === 0 ? '\n全部通过 ✔  (' + passes + ')'
    : '\n失败 ' + failures + ' 项');
  process.exitCode = failures ? 1 : 0;
}

main().catch(e => { console.error('harness error: ' + (e && e.message)); process.exitCode = 2; });
