'use strict';

/* Internal Beyond · P24-M3.5.1A · Structured Target Identity Foundation 测试
   （static + browser：纯契约 T1–T23 / 真实群聊 I1–I24 / legacy L1–L4；
     运行：node tests/test_group_explicit_targeting.js）

   本阶段把 "text mention → runtime-only mentioned:boolean" 升级为
   "text mention → canonical targetSpeakerIds（user 消息 metadata）→ runtime projection → mentioned"。
   覆盖用户给定 T1–T23 / I1–I24 / L1–L4。 */

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
const A_ID = 'friend_m351_a';
const B_ID = 'friend_m351_b';
const C_ID = 'friend_m351_c';
const NAME_A = 'Alpha351';
const NAME_B = 'Beta351';
const NAME_C = 'Gamma351';

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

const P = [{ id: 'friend_a', name: 'A' }, { id: 'friend_b', name: 'B' }, { id: 'friend_c', name: 'C' }];
const IDS = ['friend_a', 'friend_b', 'friend_c'];
const V = Core.validateTargetSpeakerIds;
const CANON = Core.canonicalizeTargetSpeakerIds;
const RESOLVE = Core.resolveTargetSpeakerIds;
const PROJECT = Core.projectTargetedParticipants;
const throwsWith = (fn, code) => { try { fn(); return false; } catch (e) { return e && e.code === code; } };

/* ── T1–T23 · 纯契约 ──────────────────────────────────────────────────── */
function pureContract() {
  ok('T1.validatorEmptyArray', V([]).ok === true);
  ok('T2.validatorSingleId', V(['friend_a']).ok === true);
  ok('T3.validatorMultipleIds', V(['friend_a', 'friend_b']).ok === true);
  ok('T4.invalidNonArrayRejected', V('friend_a').ok === false && V('friend_a').errors.indexOf('bad-target-list') >= 0
    && V({}).ok === false && V({}).errors.indexOf('bad-target-list') >= 0);
  ok('T5.invalidNullRejected', V(null).ok === false && V(null).errors.indexOf('bad-target-list') >= 0);
  ok('T6.invalidNonStringRejected', V([1]).ok === false && V([1]).errors.indexOf('bad-target-id') >= 0
    && V([null]).errors.indexOf('bad-target-id') >= 0);
  ok('T7.invalidEmptyStringRejected', V(['']).ok === false && V(['']).errors.indexOf('bad-target-id') >= 0
    && V(['   ']).errors.indexOf('bad-target-id') >= 0);
  ok('T8.duplicateIdsRejected', V(['friend_a', 'friend_a']).ok === false
    && V(['friend_a', 'friend_a']).errors.indexOf('duplicate-target-id') >= 0);
  ok('T9.credentialLikeRejected', V(['sk-abcdefgh12345678']).ok === false
    && V(['sk-abcdefgh12345678']).errors.indexOf('bad-target-id') >= 0);
  ok('T9b.controlCharsAndWhitespaceRejected',
    V(['friend_a\nx']).ok === false && V([' friend_a ']).ok === false);
  ok('T10.canonicalizeTextOrderToParticipantOrder',
    JSON.stringify(CANON(['friend_b', 'friend_a'], IDS)) === JSON.stringify(['friend_a', 'friend_b']));
  ok('T11.canonicalizeDedupes',
    JSON.stringify(CANON(['friend_b', 'friend_b', 'friend_a'], IDS)) === JSON.stringify(['friend_a', 'friend_b']));
  ok('T12.canonicalizeIgnoresNonParticipant',
    JSON.stringify(CANON(['friend_zz', 'friend_a'], IDS)) === JSON.stringify(['friend_a']));
  ok('T13.structuredPresenceWins', (() => {
    const r = RESOLVE({ message: { metadata: { targetSpeakerIds: ['friend_a'] } }, text: '@B', candidates: P, participantIds: IDS });
    return r.source === 'structured' && JSON.stringify(r.targetSpeakerIds) === JSON.stringify(['friend_a']);
  })());
  ok('T14.structuredEmptyWins', (() => {
    const r = RESOLVE({ message: { metadata: { targetSpeakerIds: [] } }, text: '@B', candidates: P, participantIds: IDS });
    return r.source === 'structured' && r.targetSpeakerIds.length === 0;
  })());
  ok('T15.missingFieldFallsBackToText', (() => {
    const r = RESOLVE({ message: {}, text: '@B 你怎么看', candidates: P, participantIds: IDS });
    return r.source === 'legacy' && JSON.stringify(r.targetSpeakerIds) === JSON.stringify(['friend_b']);
  })());
  ok('T16.unknownMentionYieldsEmpty', (() => {
    const r = RESOLVE({ message: {}, text: '@Nobody hi', candidates: P, participantIds: IDS });
    return r.source === 'legacy' && r.targetSpeakerIds.length === 0;
  })());
  ok('T17.ambiguousMentionYieldsEmpty', (() => {
    const dup = [{ id: 'friend_a', name: 'X' }, { id: 'friend_b', name: 'X' }];
    const r = RESOLVE({ message: {}, text: '@X 你好', candidates: dup, participantIds: IDS });
    return r.targetSpeakerIds.length === 0;
  })());
  ok('T18.fullwidthAtWorks', JSON.stringify(RESOLVE({ message: {}, text: '＠B 你好', candidates: P, participantIds: IDS }).targetSpeakerIds)
    === JSON.stringify(['friend_b']));
  ok('T19.emailProtectionPreserved', RESOLVE({ message: {}, text: 'mail bob@B.com', candidates: P, participantIds: IDS }).targetSpeakerIds.length === 0);
  ok('T20.substringProtectionPreserved', RESOLVE({ message: {}, text: '@Bx', candidates: P, participantIds: IDS }).targetSpeakerIds.length === 0);
  ok('T21.cjkEmojiAndSpacedNames', (() => {
    const c = [{ id: 'id_cjk', name: '流萤' }, { id: 'id_emoji', name: '🌸樱' }, { id: 'id_space', name: 'Mr X' }];
    const ids = ['id_cjk', 'id_emoji', 'id_space'];
    return JSON.stringify(RESOLVE({ message: {}, text: '@流萤 @🌸樱 @Mr X', candidates: c, participantIds: ids }).targetSpeakerIds)
      === JSON.stringify(['id_cjk', 'id_emoji', 'id_space']);
  })());
  ok('T22.caseSensitiveBehaviourPreserved',
    RESOLVE({ message: {}, text: '@b', candidates: P, participantIds: IDS }).targetSpeakerIds.length === 0
    && RESOLVE({ message: {}, text: '@B', candidates: P, participantIds: IDS }).targetSpeakerIds.length === 1);
  ok('T23.projectionExact', JSON.stringify(PROJECT(['friend_c', 'friend_a'], P)) === JSON.stringify(['friend_a', 'friend_c'])
    && JSON.stringify(PROJECT(['friend_zz'], P)) === JSON.stringify([]));
  ok('T23b.invalidStructuredThrowsFailClosed', throwsWith(() => RESOLVE({ message: { metadata: { targetSpeakerIds: 'A' } }, text: '@B', candidates: P, participantIds: IDS }), 'TARGETING_CONTRACT')
    && throwsWith(() => RESOLVE({ message: { metadata: { targetSpeakerIds: [1] } }, text: '@B', candidates: P, participantIds: IDS }), 'TARGETING_CONTRACT')
    && throwsWith(() => RESOLVE({ message: { metadata: { targetSpeakerIds: ['friend_a', 'friend_a'] } }, text: '@B', candidates: P, participantIds: IDS }), 'TARGETING_CONTRACT'));
  ok('T23c.historicalNonParticipantIdIsNotCorruption', (() => {
    const r = RESOLVE({ message: { metadata: { targetSpeakerIds: ['friend_zz'] } }, text: '@B', candidates: P, participantIds: IDS });
    /* P24-M3.5.1B 精化：structured 读取**保留事实**（历史已退出成员的 id 仍在），
       成员映射交给 projection ⇒ 这里 resolved=[friend_zz]，projection=[]。 */
    return r.source === 'structured' && JSON.stringify(r.targetSpeakerIds) === JSON.stringify(['friend_zz'])
      && JSON.stringify(PROJECT(r.targetSpeakerIds, P)) === JSON.stringify([]);
  })());
  ok('T23d.errorVocabularyClosed',
    JSON.stringify(Core.TARGETING_ERRORS) === JSON.stringify(['bad-target-list', 'bad-target-id', 'duplicate-target-id'])
    && Core.TARGET_SPEAKER_FIELD === 'targetSpeakerIds');
}

/* ── source guards（无浏览器）─────────────────────────────────────────── */
function sourceGuards() {
  const comm = read('assets/js/communication.js');
  const code = comm.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const groupBranch = comm.slice(comm.indexOf('if(isGroup){'), comm.indexOf('/* ===== NORMAL 1-ON-1 CHAT ===== */'))
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const core = read('assets/js/group-runtime-core.js');
  const count = (s, t) => s.split(t).length - 1;
  ok('SG1.singleUserWriteInGroupBranch', count(groupBranch, "dbPut('chatMessages',userMsg)") === 1
    && count(groupBranch, 'metadata={targetSpeakerIds:') === 1);
  ok('SG2.singleChatHasNoTargeting',
    count(comm.slice(comm.indexOf('/* ===== NORMAL 1-ON-1 CHAT ===== */')), 'targetSpeakerIds') === 0);
  ok('SG3.assistantMetadataHasNoTargeting', count(code, 'extraMetadata:{groupTurnId') === 1
    && code.indexOf('targetSpeakerIds:_gMember') < 0);
  ok('SG4.targetingParseProjectionReaderOnce',
    count(code, 'resolveMentionTargets(') === 1 && count(code, 'resolveTargetSpeakerIds(') === 1
    && count(code, 'projectTargetedParticipants(') === 1);
  ok('SG5.noBackfillWrites', count(code, "dbPut('chatMessages',userMsg)") === 2   /* 群 + 单聊各一处，均非回填 */
    && count(code, 'targetSpeakerIds:') === 1                                     /* 只有唯一一处字段写入 */
    && code.indexOf('m.metadata.targetSpeakerIds=') < 0
    && code.indexOf('msg.metadata.targetSpeakerIds=') < 0);
  ok('SG6.p23ZeroTargetingRefs',
    ['delivery-planner', 'multimodal-delivery-policy', 'delivery-sequence-core', 'delivery-runtime', 'voice-message-core']
      .every(f => read('assets/js/' + f + '.js').indexOf('targetSpeakerIds') < 0));
  ok('SG7.memoryMbPolicyZeroTargetingRefs',
    ['assets/js/memory.js', 'assets/js/middle-brain.js', 'assets/js/social.js']
      .every(f => read(f).indexOf('targetSpeakerIds') < 0));
  ok('SG8.plannerHasNoTargetingRefs', (() => {
    const c2 = core.replace(/\/\*[\s\S]*?\*\//g, '');
    const i = c2.indexOf('function planParticipation(input)');
    const j = c2.indexOf('var PARTICIPATION_POLICY_FIELDS');
    return c2.slice(i, j).indexOf('targetSpeakerIds') < 0
      && /PARTICIPATION_PLAN_VERSION = 3/.test(core) && /'group-rule-v1'/.test(core);
  })());
  ok('SG9.noSecondTargetingStore', code.indexOf('targetingStore') < 0 && code.indexOf('targetSpeakerIdsCache') < 0);
  ok('SG10.mentionOnlyNotRevived', count(read('assets/js/social.js'), 'mentionOnly=') === 0
    && count(read('assets/js/social.js'), 'mentionOnly:') === 0);
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
  + "window.__m351={policy:[],derive:[],plan:[],seq:[],reads:[],userWrites:0,parse:0,reader:0,project:0};"
  + "if(!window.__m351Hooked){window.__m351Hooked=true;"
  + "window.__m351Orig={g:window.dbGetByIndex,put:window.dbPut,r:window.IBGroupRuntime.resolveParticipationPolicy,"
  + "d:window.IBGroupRuntime.deriveRecentSpeakerIds,p:window.IBGroupRuntime.planParticipation,"
  + "pm:window.IBGroupRuntime.resolveMentionTargets,tr:window.IBGroupRuntime.resolveTargetSpeakerIds,"
  + "pr:window.IBGroupRuntime.projectTargetedParticipants};"
  + "window.dbPut=function(store,d){if(store==='chatMessages'&&d&&d.role==='user')window.__m351.userWrites++;return window.__m351Orig.put.apply(this,arguments)};"
  + "window.dbGetByIndex=function(store,index,key){if(store==='chatMessages'&&index==='byFriend')window.__m351.reads.push(String(key));return window.__m351Orig.g.apply(this,arguments)};"
  + "window.IBGroupRuntime.resolveMentionTargets=function(){window.__m351.parse++;return window.__m351Orig.pm.apply(this,arguments)};"
  + "window.IBGroupRuntime.resolveTargetSpeakerIds=function(){window.__m351.reader++;var o=window.__m351Orig.tr.apply(this,arguments);"
  + "window.__m351.lastResolve={source:o&&o.source,ids:(o&&o.targetSpeakerIds)||[]};return o};"
  + "window.IBGroupRuntime.projectTargetedParticipants=function(){window.__m351.project++;return window.__m351Orig.pr.apply(this,arguments)};"
  + "window.IBGroupRuntime.resolveParticipationPolicy=function(){window.__m351.seq.push('policy');"
  + "var out=window.__m351Orig.r.apply(this,arguments);"
  + "window.__m351.policy.push({group:(arguments[0]===undefined?'undefined':JSON.parse(JSON.stringify(arguments[0])))});return out};"
  + "window.IBGroupRuntime.deriveRecentSpeakerIds=function(){window.__m351.seq.push('derive');"
  + "var out=window.__m351Orig.d.apply(this,arguments);"
  + "window.__m351.derive.push({win:(arguments[2]||{}).window,result:(out&&out.recentSpeakerIds)||[]});return out};"
  + "window.IBGroupRuntime.planParticipation=function(i){window.__m351.seq.push('plan');"
  + "var out=window.__m351Orig.p.apply(this,arguments);"
  + "window.__m351.plan.push({keys:Object.keys(i||{}),hasCap:Object.prototype.hasOwnProperty.call(i||{},'maxResponders'),"
  + "mentioned:(i&&i.participants||[]).filter(function(p){return p.mentioned}).map(function(p){return p.id}),"
  + "entries:((out&&out.entries)||[]).map(function(e){return e.speakerId+'#'+e.order}),"
  + "omitted:((out&&out.omitted)||[]).map(function(o2){return o2.speakerId+':'+o2.reason}),"
  + "plannerId:(out&&out.plannerId),planVersion:(out&&out.planVersion)});return out};"
  + "}return true})()";
const RESET = "(function(){window.__m351.policy=[];window.__m351.derive=[];window.__m351.plan=[];window.__m351.seq=[];window.__m351.reads=[];window.__m351.userWrites=0;window.__m351.parse=0;window.__m351.reader=0;window.__m351.project=0;return true})()";

async function browserIntegration() {
  const chrome = chromePath();
  ok('browser.binaryFound', !!chrome, chrome);
  if (!chrome) return;
  const mock = await startMock();
  const port = await freePort();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-m351-'));
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
    ok('page.chatReady', await waitFor(cdp, "typeof window.sendChatMessage==='function' && !!(window.IBGroupRuntime&&window.IBGroupRuntime.resolveTargetSpeakerIds)", 25000));
    await evaluate(cdp, "window.confirm=function(){return true};");

    const ep = 'http://127.0.0.1:' + mock.port + '/v1/chat/completions';
    const mkCfg = (id, name, model) => "(function(){return dbPut('apiConfigs',{id:'" + id + "',nickname:'" + name + "',model:'" + model + "',endpoint:'" + ep + "',apiKey:'',provider:'custom',systemPrompt:'你是测试角色。',temperature:1,streaming:false,showThinking:false,promptCache:false,created:Date.now()})})()";
    await evaluate(cdp, mkCfg(A_ID, NAME_A, 'm351-a'));
    await evaluate(cdp, mkCfg(B_ID, NAME_B, 'm351-b'));
    await evaluate(cdp, mkCfg(C_ID, NAME_C, 'm351-c'));
    await evaluate(cdp, "loadApiConfigs()");
    const G = {
      plain: 'group_1700000000380', cap1: 'group_1700000000381', cap2: 'group_1700000000382',
      cap0: 'group_1700000000383', muted: 'group_1700000000384', recent: 'group_1700000000385',
      removed: 'group_1700000000386'
    };
    const mkGroup = (gid, members) => "(function(){return dbPut('groups',{id:'" + gid + "',name:'M351 " + gid.slice(-3) + "',members:" + members + ",memoryEnabled:false,created:1})})()";
    const allActive = "[{characterId:'" + A_ID + "',status:'active',joinedAt:1},{characterId:'" + B_ID + "',status:'active',joinedAt:1},{characterId:'" + C_ID + "',status:'active',joinedAt:1}]";
    for (const k of ['plain', 'cap1', 'cap2', 'cap0', 'recent']) await evaluate(cdp, mkGroup(G[k], allActive));
    await evaluate(cdp, mkGroup(G.muted, "[{characterId:'" + A_ID + "',status:'active',joinedAt:1},{characterId:'" + B_ID + "',status:'muted',joinedAt:1},{characterId:'" + C_ID + "',status:'active',joinedAt:1}]"));
    await evaluate(cdp, mkGroup(G.removed, "[{characterId:'" + A_ID + "',status:'active',joinedAt:1},{characterId:'" + B_ID + "',status:'removed',joinedAt:1},{characterId:'" + C_ID + "',status:'active',joinedAt:1}]"));
    ok('fixtures.ready', await evaluate(cdp, "(async function(){var g=await dbGet('groups','" + G.plain + "');return !!g&&g.members.length===3})()"));
    await evaluate(cdp, HOOK);

    const requestsFor = tag => mock.requests.filter(r => JSON.stringify(r.messages).indexOf(tag) >= 0);
    const lastUserRow = gid => "(async function(){var all=await dbGetByIndex('chatMessages','byFriend','" + gid + "');var us=all.filter(function(m){return m.role==='user'});return us.length?us[us.length-1]:null})()";
    const botsAtLeast = (gid, min) => "(async function(){var all=await dbGetByIndex('chatMessages','byFriend','" + gid + "');return all.filter(function(m){return m.role==='assistant'}).length>=" + min + "})()";
    const sendTo = async (gid, text) => {
      await evaluate(cdp, "(function(){activeFriendId='" + gid + "';activeThreadId=null;openChatPanel();return true})()");
      await evaluate(cdp, RESET);
      mock.requests.length = 0;
      await evaluate(cdp, "(function(){var i=document.getElementById('chat-input');i.value=" + JSON.stringify(text) + ";return sendChatMessage()})()");
    };
    const setPolicy = (gid, frag) => evaluate(cdp, "(async function(){return await window.setGroupParticipationPolicy(" + JSON.stringify(gid) + "," + JSON.stringify(frag) + ")})()");

    /* ── I1–I6 · 新群用户消息的 canonical targeting 写入 ─────────────────── */
    await sendTo(G.plain, 'M351 no mention here');
    ok('I2.noMentionWritesEmptyArray', await waitFor(cdp, botsAtLeast(G.plain, 3), 30000)
      && JSON.stringify((await evaluate(cdp, lastUserRow(G.plain))).metadata) === JSON.stringify({ targetSpeakerIds: [] }),
      (await evaluate(cdp, lastUserRow(G.plain))).metadata);
    ok('I1.newGroupUserMessageWritesField', await evaluate(cdp, "(async function(){var m=await (async function(){var all=await dbGetByIndex('chatMessages','byFriend','" + G.plain + "');return all.filter(function(x){return x.role==='user'}).pop()})();"
      + "return !!m&&!!m.metadata&&Object.prototype.hasOwnProperty.call(m.metadata,'targetSpeakerIds')})()"));
    ok('I7.oneUserWritePerGroupTurn', (await evaluate(cdp, "window.__m351.userWrites")) === 1,
      await evaluate(cdp, "window.__m351.userWrites"));
    ok('I8.targetingParsedOncePerTurn', (await evaluate(cdp, "window.__m351.parse")) === 1);
    ok('I9.targetingProjectedOncePerTurn', (await evaluate(cdp, "window.__m351.project")) === 1
      && (await evaluate(cdp, "window.__m351.reader")) === 1);
    ok('I10.unlimitedNotExclusive', requestsFor('M351 no mention here').length === 3
      && (await evaluate(cdp, "window.__m351.plan.slice()"))[0].mentioned.length === 0);

    await sendTo(G.plain, '@' + NAME_B + ' M351 single target');
    ok('I3.singleTargetStored', await waitFor(cdp, botsAtLeast(G.plain, 6), 30000)
      && JSON.stringify((await evaluate(cdp, lastUserRow(G.plain))).metadata.targetSpeakerIds) === JSON.stringify([B_ID]),
      (await evaluate(cdp, lastUserRow(G.plain))).metadata);

    await sendTo(G.plain, '@' + NAME_B + ' @' + NAME_A + ' M351 multi target');
    ok('I4.multipleTargetsCanonicalParticipantOrder', await waitFor(cdp, botsAtLeast(G.plain, 9), 30000)
      && JSON.stringify((await evaluate(cdp, lastUserRow(G.plain))).metadata.targetSpeakerIds) === JSON.stringify([A_ID, B_ID]),
      (await evaluate(cdp, lastUserRow(G.plain))).metadata);

    await sendTo(G.plain, '@Nobody M351 unknown');
    ok('I5.unknownMentionStoredEmpty', await waitFor(cdp, botsAtLeast(G.plain, 12), 30000)
      && JSON.stringify((await evaluate(cdp, lastUserRow(G.plain))).metadata.targetSpeakerIds) === JSON.stringify([])
      && requestsFor('M351 unknown').length === 3, (await evaluate(cdp, lastUserRow(G.plain))).metadata);

    const DUP_GROUP = 'group_1700000000387';
    await evaluate(cdp, "(function(){return dbPut('apiConfigs',{id:'friend_m351_dup',nickname:'" + NAME_B + "',model:'m351-dup',endpoint:'" + ep + "',apiKey:'',provider:'custom',systemPrompt:'x',temperature:1,streaming:false,showThinking:false,promptCache:false,created:Date.now()})})()");
    await evaluate(cdp, "loadApiConfigs()");
    await evaluate(cdp, mkGroup(DUP_GROUP, "[{characterId:'" + B_ID + "',status:'active',joinedAt:1},{characterId:'friend_m351_dup',status:'active',joinedAt:1}]"));
    await sendTo(DUP_GROUP, '@' + NAME_B + ' M351 ambiguous');
    ok('I6.ambiguousMentionStoredEmpty', await waitFor(cdp, botsAtLeast(DUP_GROUP, 2), 30000)
      && JSON.stringify((await evaluate(cdp, lastUserRow(DUP_GROUP))).metadata.targetSpeakerIds) === JSON.stringify([]),
      (await evaluate(cdp, lastUserRow(DUP_GROUP))).metadata);

    /* ── I11–I16 · 参与语义（target 只是优先级）──────────────────────────── */
    await setPolicy(G.cap1, { maxResponders: 1 });
    await sendTo(G.cap1, '@' + NAME_B + ' M351 cap1');
    ok('I11.capOneTargetPriority', await waitFor(cdp, botsAtLeast(G.cap1, 1), 30000)
      && requestsFor('M351 cap1').length === 1 && requestsFor('M351 cap1')[0].model === 'm351-b',
      requestsFor('M351 cap1').map(r => r.model));
    await setPolicy(G.cap2, { maxResponders: 2 });
    await sendTo(G.cap2, '@' + NAME_B + ' M351 cap2');
    ok('I12.capTwoTargetPlusNextEligible', await waitFor(cdp, botsAtLeast(G.cap2, 2), 30000)
      && requestsFor('M351 cap2').map(r => r.model).sort().join(',') === 'm351-a,m351-b',
      requestsFor('M351 cap2').map(r => r.model));
    await setPolicy(G.cap0, { maxResponders: 0 });
    await sendTo(G.cap0, '@' + NAME_B + ' M351 cap0');
    ok('I13.capZeroNoCalls', await waitFor(cdp, "(function(){var m=document.getElementById('chat-messages')||document.getElementById('chat-full-messages');return !!m&&m.textContent.indexOf('本轮无人回应')>=0})()", 20000)
      && requestsFor('M351 cap0').length === 0, requestsFor('M351 cap0').length);
    await sendTo(G.muted, '@' + NAME_B + ' M351 muted target');
    ok('I14.mutedTargetSpeaks', await waitFor(cdp, botsAtLeast(G.muted, 3), 30000)
      && requestsFor('M351 muted target').length === 3
      && (await evaluate(cdp, "window.__m351.plan.slice()"))[0].mentioned.join(',') === B_ID,
      (await evaluate(cdp, "window.__m351.plan.slice()"))[0]);
    await setPolicy(G.recent, { maxResponders: 1 });
    await sendTo(G.recent, 'M351 seed');
    ok('I15a.seedRoundDone', await waitFor(cdp, botsAtLeast(G.recent, 1), 30000)
      && requestsFor('M351 seed').length === 1, requestsFor('M351 seed').map(r => r.model));
    await sendTo(G.recent, '@' + NAME_C + ' M351 recent target');
    ok('I15.recentTargetPriority', await waitFor(cdp, botsAtLeast(G.recent, 2), 30000)
      && requestsFor('M351 recent target').length === 1 && requestsFor('M351 recent target')[0].model === 'm351-c',
      requestsFor('M351 recent target').map(r => r.model));
    await sendTo(G.removed, '@' + NAME_B + ' M351 removed target');
    ok('I16.removedTargetHardDeny', await waitFor(cdp, botsAtLeast(G.removed, 2), 30000)
      && requestsFor('M351 removed target').every(r => r.model !== 'm351-b')
      && requestsFor('M351 removed target').length === 2,
      requestsFor('M351 removed target').map(r => r.model));
    ok('I16b.removedTargetStillRecordedAsFact',
      JSON.stringify((await evaluate(cdp, lastUserRow(G.removed))).metadata.targetSpeakerIds) === JSON.stringify([B_ID]));

    /* ── I17–I24 · precedence / 冻结边界 ─────────────────────────────────── */
    ok('I17.structuredPrecedenceOverText', await evaluate(cdp, "(function(){var r=window.IBGroupRuntime.resolveTargetSpeakerIds({message:{metadata:{targetSpeakerIds:['" + A_ID + "']}},text:'@" + NAME_B + "',candidates:[{id:'" + A_ID + "',name:'" + NAME_A + "'},{id:'" + B_ID + "',name:'" + NAME_B + "'}],participantIds:['" + A_ID + "','" + B_ID + "']});"
      + "return r.source==='structured'&&JSON.stringify(r.targetSpeakerIds)===JSON.stringify(['" + A_ID + "'])})()"));
    ok('I18.structuredEmptyPrecedence', await evaluate(cdp, "(function(){var r=window.IBGroupRuntime.resolveTargetSpeakerIds({message:{metadata:{targetSpeakerIds:[]}},text:'@" + NAME_B + "',candidates:[{id:'" + B_ID + "',name:'" + NAME_B + "'}],participantIds:['" + B_ID + "']});"
      + "return r.source==='structured'&&r.targetSpeakerIds.length===0})()"));
    ok('I19.plannerInputShapeUnchanged', (() => {
      return evaluate(cdp, "(function(){var p=window.__m351.plan.slice();if(!p.length)return false;var k=p[p.length-1].keys.slice().sort().join(',');"
        + "return k==='groupTurnId,participants,recentSpeakerIds,trigger'||k==='groupTurnId,maxResponders,participants,recentSpeakerIds,trigger'})()");
    })());
    const lastPlan = await evaluate(cdp, "window.__m351.plan.slice()");
    ok('I20.planVersionStillThree', !!lastPlan.length && lastPlan[lastPlan.length - 1].planVersion === 3
      && lastPlan[lastPlan.length - 1].plannerId === 'group-rule-v1');
    ok('I21.targetIdsNotInProviderPrompt',
      ['targetSpeakerIds', 'friend_m351_a', A_ID].every(t => JSON.stringify(mock.requests).indexOf(t) < 0),
      JSON.stringify(mock.requests).slice(0, 200));
    ok('I22.targetIdsNotCopiedToAssistantMetadata', await evaluate(cdp, "(async function(){var all=await dbGetByIndex('chatMessages','byFriend','" + G.plain + "');return all.filter(function(m){return m.role==='assistant'}).every(function(m){var k=Object.keys(m.metadata||{});return k.indexOf('targetSpeakerIds')<0})})()"));
    /* I23 · cancel 保留 targeting 事实 */
    await evaluate(cdp, "(function(){activeFriendId='" + G.plain + "';activeThreadId=null;openChatPanel();return true})()");
    await evaluate(cdp, RESET);
    await evaluate(cdp, "(function(){var i=document.getElementById('chat-input');i.value='@" + NAME_C + " M351 cancel probe';return sendChatMessage()})()");
    await evaluate(cdp, "(function(){try{stopStreaming()}catch(e){};return true})()");
    await new Promise(r => setTimeout(r, 1200));
    ok('I23.cancelPreservesUserTargeting',
      JSON.stringify((await evaluate(cdp, lastUserRow(G.plain))).metadata.targetSpeakerIds) === JSON.stringify([C_ID]),
      (await evaluate(cdp, lastUserRow(G.plain))).metadata);
    /* I24 · 单聊无 targeting 字段 */
    await evaluate(cdp, RESET);
    await evaluate(cdp, "(function(){activeFriendId='" + A_ID + "';activeThreadId=null;openChatPanel();var i=document.getElementById('chat-input');i.value='M351 single';return sendChatMessage()})()");
    ok('I24.singleChatHasNoTargetingMetadata', await waitFor(cdp, "(async function(){var all=await dbGetByIndex('chatMessages','byFriend','" + A_ID + "');return all.filter(function(m){return m.role==='user'}).length>=1})()", 25000)
      && await evaluate(cdp, "(async function(){var all=await dbGetByIndex('chatMessages','byFriend','" + A_ID + "');return all.filter(function(m){return m.role==='user'}).every(function(m){return !m.metadata||!Object.prototype.hasOwnProperty.call(m.metadata,'targetSpeakerIds')})})()"));

    /* ── L1–L4 · legacy 兼容 ─────────────────────────────────────────────── */
    const LEGACY = 'group_1700000000388';
    await evaluate(cdp, mkGroup(LEGACY, allActive));
    await evaluate(cdp, "(async function(){await dbPut('chatMessages',{id:'msg_1700000000999_u',role:'user',content:'@" + NAME_B + " legacy',friendId:'" + LEGACY + "',timestamp:Date.now()});return true})()");
    ok('L1.legacyMessageUsesParserFallback', await evaluate(cdp, "(function(){var r=window.IBGroupRuntime.resolveTargetSpeakerIds({message:{id:'msg_1700000000999_u',role:'user',metadata:undefined},text:'@" + NAME_B + " legacy',candidates:[{id:'" + A_ID + "',name:'" + NAME_A + "'},{id:'" + B_ID + "',name:'" + NAME_B + "'}],participantIds:['" + A_ID + "','" + B_ID + "']});"
      + "return r.source==='legacy'&&JSON.stringify(r.targetSpeakerIds)===JSON.stringify(['" + B_ID + "'])})()"));
    ok('L2.legacyRowNotBackfilled', await evaluate(cdp, "(async function(){var m=await dbGet('chatMessages','msg_1700000000999_u');return !m.metadata||!Object.prototype.hasOwnProperty.call(m.metadata,'targetSpeakerIds')})()"));
    await sendTo(LEGACY, 'M351 legacy group round');
    ok('L3.legacyTextBehaviourUnchanged', await waitFor(cdp, botsAtLeast(LEGACY, 3), 30000)
      && requestsFor('M351 legacy group round').length === 3, requestsFor('M351 legacy group round').map(r => r.model));
    ok('L4.mentionOnlyNotRevived', await evaluate(cdp, "(async function(){var g=await dbGet('groups','" + LEGACY + "');return !('mentionOnly' in g)})()"));

    ok('runtime.noUncaughtExceptions', exceptions.length === 0, exceptions.slice(0, 3));
  } finally {
    try { browser.kill(); } catch (e) { /* ignore */ }
    try { mock.server.close(); } catch (e) { /* ignore */ }
    rmWithRetry(profile, 5);
  }
}

async function main() {
  console.log('== P24-M3.5.1A · Structured Target Identity Foundation 测试 ==');
  pureContract();
  sourceGuards();
  await browserIntegration();
  console.log(failures === 0 ? '\n全部通过 ✔  (' + passes + ')' : '\n失败 ' + failures + ' 项（通过 ' + passes + '）');
  process.exitCode = failures ? 1 : 0;
}

main().catch(e => { console.error('harness error: ' + (e && e.message)); process.exitCode = 2; });
