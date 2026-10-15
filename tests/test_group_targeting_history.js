'use strict';

/* Internal Beyond · P24-M3.5.1B · Historical Targeting Compatibility & Replay Hardening 测试
   （browser：真实页面 + 真实 IndexedDB + 真实 import/export 媒介 + mock provider；
     运行：node tests/test_group_targeting_history.js）

   本阶段是 **hardening**：不新增功能，只把 structured targeting 的
   历史读取 / rename / membership change / corrupted metadata / roundtrip 语义
   变成明确、可测试、fail-closed 的契约。
   覆盖用户给定 H1–H30 与 replay-availability 的静态证明。 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const assert = require('assert/strict');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const Core = require(path.join(ROOT, 'assets', 'js', 'group-runtime-core.js'));

const harness = fs.readFileSync(path.join(__dirname, 'test_chat_smoke.js'), 'utf8');
const boundary = harness.indexOf('async function main() {');
assert.ok(boundary > 0, 'existing CDP harness boundary changed');
const { chromePath, Cdp, evaluate, waitFor, freePort } = new Function('require', '__dirname',
  harness.slice(0, boundary) + '\nreturn {chromePath,Cdp,evaluate,waitFor,freePort};')(require, __dirname);

const PAGE_URL = 'file:///' + path.join(ROOT, 'InternalBeyond.html').replace(/\\/g, '/');
const A_ID = 'friend_m351b_a';
const B_ID = 'friend_m351b_b';
const C_ID = 'friend_m351b_c';
const NAME_A = 'HistA';
const NAME_B = 'HistB';
const NAME_C = 'HistC';

let failures = 0;
let passes = 0;
function ok(name, cond, detail) {
  if (cond) { passes++; console.log('  PASS  ' + name); }
  else { failures++; console.error('  FAIL  ' + name + (detail !== undefined ? '  -> ' + JSON.stringify(detail).slice(0, 320) : '')); }
}
function rmWithRetry(dir, tries) {
  for (let i = 0; i < (tries || 5); i++) {
    try { fs.rmSync(dir, { recursive: true, force: true }); return true; } catch (e) { /* retry */ }
    const end = Date.now() + 200;
    while (Date.now() < end) { /* busy-wait 200ms */ }
  }
  return false;
}

/* ── 静态守卫：replay 可用性 + 纯度 + 冻结边界（无浏览器）───────────────── */
function sourceGuards() {
  const comm = read('assets/js/communication.js');
  const code = comm.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const core = read('assets/js/group-runtime-core.js');
  const count = (s, t) => s.split(t).length - 1;
  ok('R0.noProductionGroupTurnReplay', count(code, 'planParticipation(_gPlanInput)') === 1
    && count(code, 'resolveTargetSpeakerIds(') === 1
    && !/function .*replay/i.test(code));
  ok('R0b.futureReplayInvariantDocumented',
    read('docs/P24-M3.5-TARGETING-CONTRACT.md').indexOf('future replay MUST use persisted') >= 0);
  ok('R1.targetingWriterIsGroupUserPathOnly', count(code, 'targetSpeakerIds:') === 1
    && count(comm.slice(comm.indexOf('/* ===== NORMAL 1-ON-1 CHAT ===== */')), 'targetSpeakerIds') === 0);
  ok('R2.assistantAndP23ZeroTargeting',
    count(code, 'extraMetadata:{groupTurnId') === 1
    && ['delivery-planner', 'multimodal-delivery-policy', 'delivery-sequence-core', 'delivery-runtime', 'voice-message-core']
      .every(f => read('assets/js/' + f + '.js').indexOf('targetSpeakerIds') < 0));
  ok('R3.memoryMbSocialZeroTargeting',
    ['assets/js/memory.js', 'assets/js/middle-brain.js', 'assets/js/social.js']
      .every(f => read(f).indexOf('targetSpeakerIds') < 0));
  ok('R4.noSecondTargetingStoreOrBackfill',
    code.indexOf('targetingStore') < 0 && code.indexOf('targetSpeakerIdsCache') < 0
    && code.indexOf('backfill') < 0);
  ok('R5.readerAndProjectionArePure', (() => {
    const c = core.replace(/\/\*[\s\S]*?\*\//g, '');
    const i = c.indexOf('function resolveTargetSpeakerIds');
    const j = c.indexOf('return {');
    const region = c.slice(i, j);
    return ['dbPut', 'dbGet', 'indexedDB', 'localStorage', 'document', 'fetch(', 'Date.now', 'Math.random', 'setTimeout']
      .every(t => region.indexOf(t) < 0);
  })());
  ok('R6.projectionIgnoresStatusPolicyRecent', (() => {
    const c = core.replace(/\/\*[\s\S]*?\*\//g, '');
    const i = c.indexOf('function projectTargetedParticipants');
    const region = c.slice(i, i + 700);
    return region.indexOf('status') < 0 && region.indexOf('policy') < 0 && region.indexOf('recent') < 0
      && region.indexOf('memory') < 0;
  })());
  ok('R7.frozenContractsUnchanged',
    /PARTICIPATION_PLAN_VERSION = 3/.test(core) && /'group-rule-v1'/.test(core)
    && JSON.stringify(Core.PARTICIPATION_REASONS.SKIP) === JSON.stringify(['muted-not-mentioned', 'removed', 'budget-limit'])
    && require('./helpers/db-schema-authority.js').isVersion('InternalBeyondDB', 24));
  ok('R8.errorVocabularyClosed', JSON.stringify(Core.TARGETING_ERRORS)
    === JSON.stringify(['bad-target-list', 'bad-target-id', 'duplicate-target-id']));
}

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
      const model = String(body.model || '');
      requests.push({ model, messages: Array.isArray(body.messages) ? body.messages : [] });
      res.writeHead(200, headers);
      res.end(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'reply-from:' + model }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 9, completion_tokens: 4, total_tokens: 13 }
      }));
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, requests })));
}

const HOOK = "(function(){"
  + "window.__m351b={userWrites:0,chatWrites:0,parse:0,reader:0,project:0,plan:0};"
  + "if(!window.__m351bHooked){window.__m351bHooked=true;"
  + "window.__m351bOrig={put:window.dbPut,pm:window.IBGroupRuntime.resolveMentionTargets,"
  + "tr:window.IBGroupRuntime.resolveTargetSpeakerIds,pr:window.IBGroupRuntime.projectTargetedParticipants,"
  + "p:window.IBGroupRuntime.planParticipation};"
  + "window.dbPut=function(store,d){if(store==='chatMessages'){window.__m351b.chatWrites++;if(d&&d.role==='user')window.__m351b.userWrites++}return window.__m351bOrig.put.apply(this,arguments)};"
  + "window.IBGroupRuntime.resolveMentionTargets=function(){window.__m351b.parse++;return window.__m351bOrig.pm.apply(this,arguments)};"
  + "window.IBGroupRuntime.resolveTargetSpeakerIds=function(){window.__m351b.reader++;return window.__m351bOrig.tr.apply(this,arguments)};"
  + "window.IBGroupRuntime.projectTargetedParticipants=function(){window.__m351b.project++;return window.__m351bOrig.pr.apply(this,arguments)};"
  + "window.IBGroupRuntime.planParticipation=function(){window.__m351b.plan++;return window.__m351bOrig.p.apply(this,arguments)};"
  + "}return true})()";
const RESET = "(function(){window.__m351b.userWrites=0;window.__m351b.chatWrites=0;window.__m351b.parse=0;window.__m351b.reader=0;window.__m351b.project=0;window.__m351b.plan=0;return true})()";

async function browserIntegration() {
  const chrome = chromePath();
  ok('browser.binaryFound', !!chrome, chrome);
  if (!chrome) return;
  const mock = await startMock();
  const port = await freePort();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-m351b-'));
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
    ok('browser.ready', ready);
    const tab = await (await fetch('http://127.0.0.1:' + port + '/json/new?' + encodeURIComponent(PAGE_URL), { method: 'PUT' })).json();
    cdp = await Cdp.connect(tab.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable');
    const exceptions = [];
    cdp.on('Runtime.exceptionThrown', p => exceptions.push(String(
      (p.exceptionDetails && p.exceptionDetails.exception && p.exceptionDetails.exception.description)
      || (p.exceptionDetails && p.exceptionDetails.text) || '')));
    ok('page.chatReady', await waitFor(cdp, "typeof window.sendChatMessage==='function' && typeof window.importAll==='function' && !!(window.IBGroupRuntime&&window.IBGroupRuntime.resolveTargetSpeakerIds)", 25000));
    await evaluate(cdp, "window.confirm=function(){return true};");

    const ep = 'http://127.0.0.1:' + mock.port + '/v1/chat/completions';
    const mkCfg = (id, name, model) => "(function(){return dbPut('apiConfigs',{id:'" + id + "',nickname:'" + name + "',model:'" + model + "',endpoint:'" + ep + "',apiKey:'',provider:'custom',systemPrompt:'你是测试角色。',temperature:1,streaming:false,showThinking:false,promptCache:false,created:Date.now()})})()";
    await evaluate(cdp, mkCfg(A_ID, NAME_A, 'm351b-a'));
    await evaluate(cdp, mkCfg(B_ID, NAME_B, 'm351b-b'));
    await evaluate(cdp, mkCfg(C_ID, NAME_C, 'm351b-c'));
    await evaluate(cdp, "loadApiConfigs()");
    const G = {
      hist: 'group_1700000000390', corrupt: 'group_1700000000391', roundtrip: 'group_1700000000392',
      legacy: 'group_1700000000393', remove: 'group_1700000000394'
    };
    const allActive = "[{characterId:'" + A_ID + "',status:'active',joinedAt:1},{characterId:'" + B_ID + "',status:'active',joinedAt:1},{characterId:'" + C_ID + "',status:'active',joinedAt:1}]";
    const mkGroup = (gid, members) => "(function(){return dbPut('groups',{id:'" + gid + "',name:'M351B " + gid.slice(-3) + "',members:" + (members || allActive) + ",memoryEnabled:false,created:1})})()";
    for (const k of Object.keys(G)) await evaluate(cdp, mkGroup(G[k]));
    ok('fixtures.ready', await evaluate(cdp, "(async function(){var g=await dbGet('groups','" + G.hist + "');return !!g&&g.members.length===3})()"));
    await evaluate(cdp, HOOK);

    const put = row => evaluate(cdp, "(async function(){return await dbPut('chatMessages'," + JSON.stringify(row) + ")})()");
    const getRow = id => evaluate(cdp, "(async function(){return await dbGet('chatMessages'," + JSON.stringify(id) + ")})()");
    const rowCount = gid => evaluate(cdp, "(async function(){var all=await dbGetByIndex('chatMessages','byFriend','" + gid + "');return all.length})()");
    const readerInPage = msg => evaluate(cdp, "(function(){try{return window.IBGroupRuntime.resolveTargetSpeakerIds(" + JSON.stringify(msg) + ")}catch(e){return {threw:true,code:e.code,errors:e.errors}}})()");
    const botCount = gid => evaluate(cdp, "(async function(){var all=await dbGetByIndex('chatMessages','byFriend','" + gid + "');return all.filter(function(m){return m.role==='assistant'}).length})()");
    /* 注意：byFriend 索引按主键排序，手工写入的 id（msg_hist_*）会排在 'msg_<时间戳>_u' 之后，
       所以"最后一条 user 行"不可靠 —— 一律按 content 精确定位本轮写入的行。 */
    const userRowWithText = (gid, text) => evaluate(cdp, "(async function(){var all=await dbGetByIndex('chatMessages','byFriend','" + gid + "');"
      + "var hit=all.filter(function(m){return m.role==='user'&&String(m.content)===" + JSON.stringify(text) + "});return hit.length===1?hit[0]:null})()");
    const sendTo = async (gid, text) => {
      await evaluate(cdp, "(function(){activeFriendId='" + gid + "';activeThreadId=null;openChatPanel();return true})()");
      await evaluate(cdp, RESET);
      mock.requests.length = 0;
      await evaluate(cdp, "(function(){var i=document.getElementById('chat-input');i.value=" + JSON.stringify(text) + ";return sendChatMessage()})()");
    };
    const CAND = [{ id: A_ID, name: NAME_A }, { id: B_ID, name: NAME_B }, { id: C_ID, name: NAME_C }];
    const IDS = [A_ID, B_ID, C_ID];

    /* ── H1–H3 · 历史行的三种状态（真实持久化）───────────────────────────── */
    await put({ id: 'msg_hist_1', role: 'user', content: 'hi', friendId: G.hist, timestamp: 1, metadata: { targetSpeakerIds: [B_ID] } });
    await put({ id: 'msg_hist_2', role: 'user', content: 'hi', friendId: G.hist, timestamp: 2, metadata: { targetSpeakerIds: [] } });
    await put({ id: 'msg_hist_3', role: 'user', content: 'hi', friendId: G.hist, timestamp: 3 });
    const h1 = await readerInPage({ message: { id: 'msg_hist_1', role: 'user', metadata: { targetSpeakerIds: [B_ID] } }, text: 'hi', candidates: CAND, participantIds: IDS });
    ok('H1.structuredIdsSurviveRead', h1.source === 'structured' && JSON.stringify(h1.targetSpeakerIds) === JSON.stringify([B_ID]), h1);
    const h2 = await readerInPage({ message: { id: 'msg_hist_2', role: 'user', metadata: { targetSpeakerIds: [] } }, text: 'hi', candidates: CAND, participantIds: IDS });
    ok('H2.structuredEmptySurvivesRead', h2.source === 'structured' && h2.targetSpeakerIds.length === 0, h2);
    const h3 = await readerInPage({ message: { id: 'msg_hist_3', role: 'user' }, text: '@' + NAME_B, candidates: CAND, participantIds: IDS });
    ok('H3.missingStaysLegacy', h3.source === 'legacy' && JSON.stringify(h3.targetSpeakerIds) === JSON.stringify([B_ID]), h3);
    const persisted = await Promise.all([getRow('msg_hist_1'), getRow('msg_hist_2'), getRow('msg_hist_3')]);
    ok('H3b.persistenceKeepsThreeStatesDistinct',
      JSON.stringify(persisted[0].metadata) === JSON.stringify({ targetSpeakerIds: [B_ID] })
      && JSON.stringify(persisted[1].metadata) === JSON.stringify({ targetSpeakerIds: [] })
      && persisted[2].metadata === undefined, persisted.map(r => r.metadata));

    /* ── H12–H20 · corruption matrix（fail closed，绝不文本回退）──────────── */
    const CORRUPT = [
      ['H12', 'string', 'A'], ['H13', 'null', null], ['H14', 'object', {}],
      ['H15', 'numericElement', [1]], ['H16', 'emptyId', ['']],
      ['H17', 'duplicate', [B_ID, B_ID]], ['H18', 'secretLike', ['sk-abcdefgh12345678']],
      ['H19', 'controlChar', ['x\u0000y']]
    ];
    for (const [id, label, val] of CORRUPT) {
      const r = await readerInPage({ message: { role: 'user', metadata: { targetSpeakerIds: val } }, text: '@' + NAME_B, candidates: CAND, participantIds: IDS });
      ok(id + '.corrupt' + label + 'FailsClosed', r && r.threw === true && r.code === 'TARGETING_CONTRACT'
        && r.errors.every(e => Core.TARGETING_ERRORS.indexOf(e) >= 0), r);
    }
    const h20 = await readerInPage({ message: { role: 'user', metadata: { targetSpeakerIds: 'A' } }, text: '@' + NAME_B, candidates: CAND, participantIds: IDS });
    ok('H20.corruptStructuredNeverTextFallback', h20 && h20.threw === true && h20.code === 'TARGETING_CONTRACT');
    ok('H18b.errorMessageDoesNotEchoRawValue', (() => {
      try { Core.resolveTargetSpeakerIds({ message: { metadata: { targetSpeakerIds: ['sk-abcdefgh12345678'] } }, text: '@B', candidates: CAND, participantIds: IDS }); return false; }
      catch (e) { return e.message.indexOf('sk-') < 0 && e.errors.every(x => Core.TARGETING_ERRORS.indexOf(x) >= 0); }
    })());

    /* ── H4/H5 · rename stability + collision（真实持久化）────────────────── */
    await evaluate(cdp, "(function(){var c=apiConfigs.find(function(a){return a.id==='" + B_ID + "'});c.nickname='流萤';return dbPut('apiConfigs',c)})()");
    await evaluate(cdp, "loadApiConfigs()");
    await sendTo(G.hist, '@流萤 H4 rename probe');
    const h4row = await userRowWithText(G.hist, '@流萤 H4 rename probe');
    ok('H4.renameTargetStoredAsCanonicalId', !!h4row && !!h4row.metadata
      && JSON.stringify(h4row.metadata.targetSpeakerIds) === JSON.stringify([B_ID]), h4row && h4row.metadata);
    /* B 改名 → 萤，C 改名 → 流萤（碰撞） */
    await evaluate(cdp, "(function(){var b=apiConfigs.find(function(a){return a.id==='" + B_ID + "'});b.nickname='萤';var c=apiConfigs.find(function(a){return a.id==='" + C_ID + "'});c.nickname='流萤';"
      + "return dbPut('apiConfigs',b).then(function(){return dbPut('apiConfigs',c)})})()");
    await evaluate(cdp, "loadApiConfigs()");
    const h5row = await getRow(h4row.id);
    const h5res = await readerInPage({ message: h5row, text: h5row.content, candidates: [{ id: A_ID, name: NAME_A }, { id: B_ID, name: '萤' }, { id: C_ID, name: '流萤' }], participantIds: IDS });
    ok('H5.renameCollisionDoesNotRetarget', JSON.stringify(h5row.metadata.targetSpeakerIds) === JSON.stringify([B_ID])
      && JSON.stringify(h5res.targetSpeakerIds) === JSON.stringify([B_ID]) && h5res.source === 'structured', { row: h5row.metadata, res: h5res });

    /* ── H9/H10/H11 · legacy 限制（文档化行为）───────────────────────────── */
    const legacyRename = await readerInPage({ message: { id: 'legacy_1', role: 'user' }, text: '@流萤', candidates: [{ id: B_ID, name: '萤' }, { id: C_ID, name: '流萤' }, { id: A_ID, name: NAME_A }], participantIds: IDS });
    ok('H9.legacyRenameMayBecomeUnresolvedOrRetargetByText', legacyRename.source === 'legacy'
      && JSON.stringify(legacyRename.targetSpeakerIds) === JSON.stringify([C_ID]), legacyRename);
    const legacyDup = await readerInPage({ message: { role: 'user' }, text: '@流萤', candidates: [{ id: B_ID, name: '流萤' }, { id: C_ID, name: '流萤' }], participantIds: IDS });
    ok('H10.legacyDuplicateNameAmbiguous', legacyDup.source === 'legacy' && legacyDup.targetSpeakerIds.length === 0, legacyDup);
    const legacyUnknown = await readerInPage({ message: { role: 'user' }, text: '@Nobody', candidates: CAND, participantIds: IDS });
    ok('H11.legacyUnknownYieldsEmpty', legacyUnknown.source === 'legacy' && legacyUnknown.targetSpeakerIds.length === 0);

    /* ── H6–H8 · membership removal / rejoin ─────────────────────────────── */
    await evaluate(cdp, "(function(){var b=apiConfigs.find(function(a){return a.id==='" + B_ID + "'});b.nickname='" + NAME_B + "';return dbPut('apiConfigs',b)})()");
    await evaluate(cdp, "loadApiConfigs()");
    await sendTo(G.remove, '@' + NAME_B + ' H6 remove probe');
    const h6row = await userRowWithText(G.remove, '@' + NAME_B + ' H6 remove probe');
    ok('H6a.targetStoredBeforeRemoval', !!h6row && JSON.stringify(h6row.metadata.targetSpeakerIds) === JSON.stringify([B_ID]),
      h6row && h6row.metadata);
    await evaluate(cdp, "(async function(){await window.setGroupMemberStatus('" + G.remove + "','" + B_ID + "','removed');return true})()");
    const h6after = await getRow(h6row.id);
    ok('H6.removedPreservesHistoricalTargetId', JSON.stringify(h6after.metadata.targetSpeakerIds) === JSON.stringify([B_ID]), h6after.metadata);
    const projWithRemoved = await evaluate(cdp, "(function(){return window.IBGroupRuntime.projectTargetedParticipants(['" + B_ID + "'],[{id:'" + A_ID + "'},{id:'" + B_ID + "'},{id:'" + C_ID + "'}])})()");
    ok('H7b.removedStatusStillProjectsForPlanner', JSON.stringify(projWithRemoved) === JSON.stringify([B_ID]), projWithRemoved);
    const projAbsent = await evaluate(cdp, "(function(){return window.IBGroupRuntime.projectTargetedParticipants(['" + B_ID + "'],[{id:'" + A_ID + "'},{id:'" + C_ID + "'}])})()");
    ok('H7.removedAbsentProjectsNoActiveTarget', projAbsent.length === 0, projAbsent);
    await sendTo(G.remove, '@' + NAME_B + ' H8 hard deny probe');
    ok('H8.removedStatusHardDenied', await waitFor(cdp, "(async function(){var all=await dbGetByIndex('chatMessages','byFriend','" + G.remove + "');return all.filter(function(m){return m.role==='assistant'}).length>=2})()", 30000)
      && mock.requests.filter(r => JSON.stringify(r.messages).indexOf('H8 hard deny probe') >= 0).every(r => r.model !== 'm351b-b'),
      mock.requests.map(r => r.model));
    /* rejoin：恢复 active 后 identity 稳定（同一 id），且不会自动 replay 历史 GroupTurn */
    const botsBeforeRejoin = await botCount(G.remove);
    await evaluate(cdp, "(async function(){await window.addGroupMember('" + G.remove + "','" + B_ID + "');return true})()");
    const h6rejoin = await getRow(h6row.id);
    ok('H11b.rejoinKeepsHistoricalIdentityStable',
      JSON.stringify(h6rejoin.metadata.targetSpeakerIds) === JSON.stringify([B_ID])
      && await evaluate(cdp, "(async function(){var g=await dbGet('groups','" + G.remove + "');return g.members.filter(function(m){return m.characterId==='" + B_ID + "'})[0].status==='active'})()"));
    await new Promise(r => setTimeout(r, 800));
    ok('H11c.rejoinDoesNotReplayHistoricalTurn', (await botCount(G.remove)) === botsBeforeRejoin);

    /* ── H21–H24 · 历史读取 / rename / 成员变更：绝不对历史行写库 ──────────── */
    const beforeFingerprint = JSON.stringify(await getRow(h6row.id));
    await evaluate(cdp, RESET);
    await readerInPage({ message: h6rejoin, text: h6rejoin.content, candidates: CAND, participantIds: IDS });
    await readerInPage({ message: { role: 'user', metadata: { targetSpeakerIds: 'bad' } }, text: '@' + NAME_B, candidates: CAND, participantIds: IDS });
    ok('H21.historicalAndCorruptReadCauseZeroWrites',
      (await evaluate(cdp, "window.__m351b.chatWrites")) === 0
      && (await evaluate(cdp, "window.__m351b.userWrites")) === 0, await evaluate(cdp, "window.__m351b.chatWrites"));
    await evaluate(cdp, RESET);
    await readerInPage({ message: { id: 'legacy_only', role: 'user' }, text: '@' + NAME_B, candidates: CAND, participantIds: IDS });
    ok('H22.legacyFallbackCausesZeroWrites', (await evaluate(cdp, "window.__m351b.chatWrites")) === 0);
    await evaluate(cdp, RESET);
    await evaluate(cdp, "(function(){var b=apiConfigs.find(function(a){return a.id==='" + B_ID + "'});b.nickname='HistBRenamed';return dbPut('apiConfigs',b).then(function(){return loadApiConfigs()})})()");
    await evaluate(cdp, "loadApiConfigs()");
    ok('H23.renameCausesZeroTargetingWrites', (await evaluate(cdp, "window.__m351b.chatWrites")) === 0
      && (await evaluate(cdp, "window.__m351b.userWrites")) === 0);
    await evaluate(cdp, RESET);
    await evaluate(cdp, "(async function(){await window.setGroupMemberStatus('" + G.remove + "','" + B_ID + "','muted');await window.setGroupMemberStatus('" + G.remove + "','" + B_ID + "','active');return true})()");
    ok('H24.removeCausesZeroTargetingWrites', (await evaluate(cdp, "window.__m351b.chatWrites")) === 0
      && JSON.stringify(await getRow(h6row.id)) === beforeFingerprint);

    /* ── H25 · display survives corruption（显示 ≠ planning）─────────────── */
    await put({ id: 'msg_corrupt_1', role: 'user', content: 'CORRUPT-CONTENT-VISIBLE', friendId: G.corrupt, timestamp: 5, metadata: { targetSpeakerIds: 'broken' } });
    const display = await evaluate(cdp, "(async function(){activeFriendId='" + G.corrupt + "';activeThreadId=null;openChatPanel();await loadChatMessages();"
      + "var m=document.getElementById('chat-messages')||document.getElementById('chat-full-messages');"
      + "return {text:String(m.textContent||''),notice:String(m.textContent||'').indexOf('本轮参与计划不可用')>=0}})()");
    ok('H25.historyUiRendersCorruptMetadataContent',
      display.text.indexOf('CORRUPT-CONTENT-VISIBLE') >= 0 && display.notice === false, display);
    ok('H25b.corruptRowNotAutoRepaired',
      await evaluate(cdp, "(async function(){var m=await dbGet('chatMessages','msg_corrupt_1');return m.metadata.targetSpeakerIds==='broken'})()"));
    /* 显示层不消费 targeting ⇒ 损坏的历史行不妨碍后续回合（新回合写入自己的 targeting）。 */
    await sendTo(G.corrupt, 'H25c corrupt history round');
    ok('H25c.corruptHistoryDoesNotBlockFutureRound',
      await waitFor(cdp, "(async function(){var all=await dbGetByIndex('chatMessages','byFriend','" + G.corrupt + "');return all.filter(function(m){return m.role==='assistant'}).length>=3})()", 30000)
      && mock.requests.filter(r => JSON.stringify(r.messages).indexOf('H25c corrupt history round') >= 0).length === 3,
      mock.requests.map(r => r.model));

    /* ── H26 · provider history 无 targeting ─────────────────────────────── */
    await sendTo(G.hist, 'H26 provider leak probe');
    await waitFor(cdp, "(async function(){var all=await dbGetByIndex('chatMessages','byFriend','" + G.hist + "');return all.filter(function(m){return m.role==='assistant'}).length>=1})()", 30000);
    ok('H26.providerHistoryHasNoTargetIds',
      ['targetSpeakerIds', B_ID].every(t => JSON.stringify(mock.requests).indexOf(t) < 0),
      JSON.stringify(mock.requests).slice(0, 200));

    /* ── H27–H29 · roundtrip（IndexedDB + 真实 import 通道）────────────────── */
    await put({ id: 'msg_rt_1', role: 'user', content: 'rt1', friendId: G.roundtrip, timestamp: 11, metadata: { targetSpeakerIds: [A_ID] } });
    await put({ id: 'msg_rt_2', role: 'user', content: 'rt2', friendId: G.roundtrip, timestamp: 12, metadata: { targetSpeakerIds: [] } });
    await put({ id: 'msg_rt_3', role: 'user', content: 'rt3', friendId: G.roundtrip, timestamp: 13 });
    const rt = await Promise.all([getRow('msg_rt_1'), getRow('msg_rt_2'), getRow('msg_rt_3')]);
    ok('H27.indexedDbRoundtripPreservesIds', JSON.stringify(rt[0].metadata) === JSON.stringify({ targetSpeakerIds: [A_ID] }));
    ok('H28.indexedDbRoundtripPreservesEmpty', JSON.stringify(rt[1].metadata) === JSON.stringify({ targetSpeakerIds: [] }));
    ok('H29.indexedDbRoundtripKeepsMissingMissing', rt[2].metadata === undefined);
    /* 真实 importAll 通道（export 侧沿用 core.js 的 Object.assign 复制 → JSON 媒介） */
    const payload = { chatMessages: [
      { id: 'msg_imp_1', role: 'user', content: 'imp1', friendId: G.roundtrip, timestamp: 21, metadata: { targetSpeakerIds: [B_ID] } },
      { id: 'msg_imp_2', role: 'user', content: 'imp2', friendId: G.roundtrip, timestamp: 22, metadata: { targetSpeakerIds: [] } },
      { id: 'msg_imp_3', role: 'user', content: 'imp3', friendId: G.roundtrip, timestamp: 23 }
    ] };
    await evaluate(cdp, "(async function(){var ev={target:{files:[{text:async function(){return " + JSON.stringify(JSON.stringify(payload)) + "}}]}};await window.importAll(ev);return true})()");
    const imp = await Promise.all([getRow('msg_imp_1'), getRow('msg_imp_2'), getRow('msg_imp_3')]);
    ok('H27b.exportImportRoundtripPreservesIds', imp[0] && JSON.stringify(imp[0].metadata) === JSON.stringify({ targetSpeakerIds: [B_ID] }), imp[0] && imp[0].metadata);
    ok('H28b.exportImportRoundtripPreservesEmpty', imp[1] && JSON.stringify(imp[1].metadata) === JSON.stringify({ targetSpeakerIds: [] }));
    ok('H29b.exportImportKeepsMissingMissing', imp[2] && imp[2].metadata === undefined);

    /* ── H30 · 单聊不受影响 ─────────────────────────────────────────────── */
    await evaluate(cdp, RESET);
    await evaluate(cdp, "(function(){activeFriendId='" + A_ID + "';activeThreadId=null;openChatPanel();var i=document.getElementById('chat-input');i.value='H30 single';return sendChatMessage()})()");
    ok('H30.singleChatUnaffected', await waitFor(cdp, "(async function(){var all=await dbGetByIndex('chatMessages','byFriend','" + A_ID + "');return all.filter(function(m){return m.role==='assistant'}).length>=1})()", 25000)
      && await evaluate(cdp, "(async function(){var all=await dbGetByIndex('chatMessages','byFriend','" + A_ID + "');return all.filter(function(m){return m.role==='user'}).every(function(m){return !m.metadata||!Object.prototype.hasOwnProperty.call(m.metadata,'targetSpeakerIds')})})()"));

    ok('runtime.noUncaughtExceptions', exceptions.length === 0, exceptions.slice(0, 3));
  } finally {
    try { browser.kill(); } catch (e) { /* ignore */ }
    try { mock.server.close(); } catch (e) { /* ignore */ }
    rmWithRetry(profile, 5);
  }
}

async function main() {
  console.log('== P24-M3.5.1B · Historical Targeting Compatibility & Replay Hardening 测试 ==');
  sourceGuards();
  await browserIntegration();
  console.log(failures === 0 ? '\n全部通过 ✔  (' + passes + ')' : '\n失败 ' + failures + ' 项（通过 ' + passes + '）');
  process.exitCode = failures ? 1 : 0;
}

main().catch(e => { console.error('harness error: ' + (e && e.message)); process.exitCode = 2; });
