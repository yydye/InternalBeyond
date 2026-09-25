'use strict';

/* Internal Beyond · P24-M3.3.1 · GroupTurn Lifecycle & Cancellation 测试
   （browser 组：真实页面 + 真实 sendChatMessage + 真实 IndexedDB + mock provider；
     运行：node tests/test_group_turn_cancellation.js）

   本阶段只交付 **runtime-only** 的 GroupTurn 生命周期与 cancel 信号：
     · created → planning → planned → executing → completed | cancelled
     · entry 边界检查：cancelled ⇒ 不启动 provider、不产生 assistant 消息、不改 groupOrder
     · 当前正在流式的成员仍由既有 `_chatCallStates[..].ac` 中止（同一 stop 入口，无第二套 abort）

   覆盖用户给定 A–F：
     A 正常完成（A,B,C 全执行）
     B cancel before 任何成员启动（计划后立刻 cancel）
     C cancel 在成员执行中（后续成员不启动；in-flight 成员已知限制）
     D 已完成的成员消息保留
     E 单聊不受影响
     F fail closed / empty plan 行为不变 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const assert = require('assert/strict');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

const harness = fs.readFileSync(path.join(__dirname, 'test_chat_smoke.js'), 'utf8');
const boundary = harness.indexOf('async function main() {');
assert.ok(boundary > 0, 'existing CDP harness boundary changed');
const { chromePath, Cdp, evaluate, waitFor, freePort } = new Function('require', '__dirname',
  harness.slice(0, boundary) + '\nreturn {chromePath,Cdp,evaluate,waitFor,freePort};')(require, __dirname);

const PAGE_URL = 'file:///' + path.join(ROOT, 'InternalBeyond.html').replace(/\\/g, '/');
const GROUP_ID = 'group_1700000000000';
const A_ID = 'friend_m331_a';
const B_ID = 'friend_m331_b';
const C_ID = 'friend_m331_c';
const MUTE_GROUP = 'group_1700000000077';

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
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ── 源码级护栏（无浏览器）────────────────────────────────────────────── */
function sourceGuards() {
  const comm = read('assets/js/communication.js');
  const code = comm.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  ok('src.lifecycleHelpersExist', /function _ibGroupTurnBegin\(/.test(code) && /function _ibGroupTurnEnd\(/.test(code)
    && /function _ibGroupTurnCancel\(/.test(code));
  ok('src.statusVocabularyClosed', ['created', 'planning', 'planned', 'executing', 'completed', 'cancelled']
    .every(s => code.indexOf("status='" + s + "'") >= 0 || code.indexOf("status:'" + s + "'") >= 0
      || code.indexOf('status="' + s + '"') >= 0 || code.indexOf("?'cancelled':'completed'") >= 0));
  /* P24-M3.5.2A 更新：成员循环改为 queue 驱动（for(;;) + runtime/static 双分支确认 entry），
     cancel checkpoint 在两个分支都必须在 entry 体启动之前 —— disabled 分支与旧语义逐字等价，
     enabled 分支由 nextDynamicRuntimeEntry 的 ctx.cancelled 承担。 */
  ok('src.entryBoundaryChecksCancel',
    /for\(;;\)\{[\s\S]{0,900}if\(_gTurn\.cancelled\)break;/.test(code)
    && /nextDynamicRuntimeEntry\(_gDynRt,\{cancelled:_gTurn\.cancelled\}\)/.test(code));
  ok('src.stopStreamingCarriesTheSignal', /try\{_ibGroupTurnCancel\(activeFriendId,'user_stop'\)\}catch\(e\)\{\}/.test(code));
  /* 禁止：新增第二套 abort / 把状态写进 metadata / 动 P23 与单聊 */
  ok('src.noNewAbortPrimitive', (comm.match(/new AbortController\(\)/g) || []).length === 6,
    (comm.match(/new AbortController\(\)/g) || []).length);
  ok('src.deliveryAbortCallsitesUnchanged', (code.match(/_ibDeliveryAbort\(/g) || []).length === 3,
    (code.match(/_ibDeliveryAbort\(/g) || []).length);/* 2 调用 + 定义 + 导出 */
  ok('src.turnStateNeverWrittenToMetadata', !/metadata\s*[:.]?\s*\{?[^}]*\b(cancelled|cancelReason|plannedCount|startedCount)\b/.test(code));
  ok('src.stateIsNotPersisted', !/dbPut\([^)]*(turnState|_gTurn)/.test(code));
}

function startMock() {
  const requests = [];
  const delays = { 'm331-b': 1500 };            /* 让 B 在飞行中，便于 cancel */
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
      requests.push({ model, messages: Array.isArray(body.messages) ? body.messages : [], at: Date.now() });
      const send = () => {
        res.writeHead(200, headers);
        res.end(JSON.stringify({
          choices: [{ message: { role: 'assistant', content: 'reply-from:' + model }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 9, completion_tokens: 4, total_tokens: 13 }
        }));
      };
      const d = delays[model] || 0;
      if (d) setTimeout(send, d); else send();
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, requests, delays })));
}
const reqsFor = (mock, tag) => mock.requests.filter(r => JSON.stringify(r.messages).indexOf(tag) >= 0);

async function main() {
  console.log('== P24-M3.3.1 · GroupTurn Lifecycle & Cancellation 测试 ==');
  sourceGuards();

  const chrome = chromePath();
  ok('browser.binaryFound', !!chrome, chrome);
  if (!chrome) return finish();
  const mock = await startMock();
  const port = await freePort();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-m331-'));
  const browser = spawn(chrome, ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    '--allow-file-access-from-files', '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=' + port, '--user-data-dir=' + profile, 'about:blank'], { stdio: 'ignore', windowsHide: true });
  let cdp;
  try {
    let ready = false;
    for (let i = 0; i < 120; i++) {
      try { const r = await fetch('http://127.0.0.1:' + port + '/json/version'); if (r.ok) { ready = true; break; } } catch (e) { /* starting */ }
      await sleep(100);
    }
    ok('browser.ready', ready);
    const tab = await (await fetch('http://127.0.0.1:' + port + '/json/new?' + encodeURIComponent(PAGE_URL), { method: 'PUT' })).json();
    cdp = await Cdp.connect(tab.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable');
    const exceptions = [];
    cdp.on('Runtime.exceptionThrown', p => exceptions.push(String(
      (p.exceptionDetails && p.exceptionDetails.exception && p.exceptionDetails.exception.description)
      || (p.exceptionDetails && p.exceptionDetails.text) || '')));
    ok('page.ready', await waitFor(cdp, "typeof window.sendChatMessage==='function' && typeof window.stopStreaming==='function' && !!(window.IBGroupRuntime&&window.IBGroupRuntime.planParticipation)", 25000));
    await evaluate(cdp, "window.confirm=function(){return true};");

    const ep = 'http://127.0.0.1:' + mock.port + '/v1/chat/completions';
    const mk = (id, model) => "(function(){return dbPut('apiConfigs',{id:'" + id + "',nickname:'" + id + "',model:'" + model + "',endpoint:'" + ep + "',apiKey:'',provider:'custom',systemPrompt:'x',temperature:1,streaming:false,showThinking:false,promptCache:false,created:Date.now()})})()";
    await evaluate(cdp, mk(A_ID, 'm331-a'));
    await evaluate(cdp, mk(B_ID, 'm331-b'));
    await evaluate(cdp, mk(C_ID, 'm331-c'));
    await evaluate(cdp, "(function(){return dbPut('groups',{id:'" + GROUP_ID + "',name:'M331',members:[{characterId:'" + A_ID + "',status:'active',joinedAt:1},{characterId:'" + B_ID + "',status:'active',joinedAt:1},{characterId:'" + C_ID + "',status:'active',joinedAt:1}],memoryEnabled:false,created:1})})()");
    await evaluate(cdp, "loadApiConfigs()");
    ok('fixtures.ready', await evaluate(cdp, "apiConfigs.filter(function(a){return /^friend_m331_/.test(a.id)}).length===3"));

    const send = t => "(function(){activeFriendId='" + GROUP_ID + "';activeThreadId=null;openChatPanel();var i=document.getElementById('chat-input');i.value=" + JSON.stringify(t) + ";return sendChatMessage()})()";
    /* 需要"回合进行中取消"的场景必须**不 await**：harness 的 evaluate 带 awaitPromise，
       等整个回合结束才返回，会把 cancel 变成"对已完成的回合打标记"。 */
    const sendNoAwait = t => "(function(){activeFriendId='" + GROUP_ID + "';activeThreadId=null;openChatPanel();var i=document.getElementById('chat-input');i.value=" + JSON.stringify(t) + ";sendChatMessage();return true})()";
    const bots = "(async function(){var all=await dbGetByIndex('chatMessages','byFriend','" + GROUP_ID + "');return all.filter(function(m){return m.role==='assistant'}).map(function(m){return {content:m.content,md:m.metadata||{}}})})()";
    const users = "(async function(){var all=await dbGetByIndex('chatMessages','byFriend','" + GROUP_ID + "');return all.filter(function(m){return m.role==='user'}).length})()";

    /* ── A · 正常完成（无 cancel）⇒ 三位成员全执行 ── */
    mock.requests.length = 0;
    await evaluate(cdp, send('M331 normal'));
    ok('A.allThreeMembersExecute', await waitFor(cdp, "(async function(){var all=await dbGetByIndex('chatMessages','byFriend','" + GROUP_ID + "');return all.filter(function(m){return m.role==='assistant'}).length>=3;})()", 30000));
    ok('A.threeProviderCalls', reqsFor(mock, 'M331 normal').length === 3, reqsFor(mock, 'M331 normal').map(r => r.model));
    const botsA = await evaluate(cdp, bots);
    ok('A.groupOrderPlanned0to2', botsA.map(b => b.md.groupOrder).sort().join(',') === '0,1,2', botsA.map(b => b.md.groupOrder));

    /* ── B · cancel before 任何成员启动（计划完成即 cancel）── */
    await evaluate(cdp, "(function(){window.__m331OrigPlan=window.IBGroupRuntime.planParticipation;window.IBGroupRuntime.planParticipation=function(input){var p=window.__m331OrigPlan(input);stopStreaming();return p};return true})()");
    const botsBeforeB = (await evaluate(cdp, bots)).length;
    mock.requests.length = 0;
    await evaluate(cdp, send('M331 cancel early'));
    await sleep(2500);
    ok('B.noProviderCallWhenCancelledBeforeExecuting', reqsFor(mock, 'M331 cancel early').length === 0, reqsFor(mock, 'M331 cancel early').map(r => r.model));
    ok('B.noAssistantRowWhenCancelledBeforeExecuting', (await evaluate(cdp, bots)).length === botsBeforeB);
    ok('B.userMessageStillPersisted', (await evaluate(cdp, users)) === 2);
    await evaluate(cdp, "(function(){window.IBGroupRuntime.planParticipation=window.__m331OrigPlan;return true})()");

    /* ── C · cancel 在成员执行中 ⇒ 后续成员不启动（B 为 slow 非流式，见已知限制）── */
    const botsBeforeC = (await evaluate(cdp, bots)).length;
    const cRowsBefore = (await evaluate(cdp, bots)).filter(b => b.md.speakerId === C_ID).length;
    mock.requests.length = 0;
    await evaluate(cdp, sendNoAwait('M331 cancel mid'));
    const sawB = await (async () => { for (let i = 0; i < 60; i++) { if (reqsFor(mock, 'M331 cancel mid').some(r => r.model === 'm331-b')) return true; await sleep(100); } return false; })();
    ok('C.secondMemberStarted', sawB, reqsFor(mock, 'M331 cancel mid').map(r => r.model));
    await evaluate(cdp, "stopStreaming()");
    await sleep(3000);                                   /* 让 in-flight 的非流式 B 收尾；C 不应启动 */
    const cReqs = reqsFor(mock, 'M331 cancel mid');
    ok('C.laterMemberNeverStarts', cReqs.every(r => r.model !== 'm331-c'), cReqs.map(r => r.model));
    const botsC = (await evaluate(cdp, bots));
    ok('C.completedMemberMessageRemains', botsC.length >= botsBeforeC + 1, { before: botsBeforeC, after: botsC.length });
    ok('C.laterMemberHasNoAssistantRow', botsC.filter(b => b.md.speakerId === C_ID).length === cRowsBefore,
      { before: cRowsBefore, after: botsC.filter(b => b.md.speakerId === C_ID).length });

    /* ── 对照组：同样 slow 的 B，但**不** cancel ⇒ C 一定会启动（证明 C 的不启动是 cancel 造成的）── */
    mock.requests.length = 0;
    await evaluate(cdp, send('M331 control'));
    ok('control.allThreeStartWithoutCancel', await waitFor(cdp, "(async function(){var all=await dbGetByIndex('chatMessages','byFriend','" + GROUP_ID + "');var n=all.filter(function(m){return m.role==='assistant'&&String(m.content).indexOf('m331-c')>=0}).length;return n>=1;})()", 30000));
    ok('control.thirdMemberWasCalled', reqsFor(mock, 'M331 control').some(r => r.model === 'm331-c'), reqsFor(mock, 'M331 control').map(r => r.model));

    /* ── D · 已完成消息保留（cancel 不改写历史）── */
    const allBots = await evaluate(cdp, bots);
    ok('D.completedMessagesUntouched', allBots.length >= botsA.length && botsA.every(a => allBots.some(b => b.content === a.content)));
    ok('D.noCancellationArtifactsInDb', await evaluate(cdp, "(async function(){var all=await dbGetByIndex('chatMessages','byFriend','" + GROUP_ID + "');return all.every(function(m){var md=m.metadata||{};return !('cancelled' in md)&&!('cancelReason' in md)&&!('groupTurnStatus' in md)})})()"));

    /* ── E · 单聊不受影响 ── */
    mock.requests.length = 0;
    await evaluate(cdp, "(function(){activeFriendId='" + A_ID + "';activeThreadId=null;openChatPanel();var i=document.getElementById('chat-input');i.value='M331 single';return sendChatMessage()})()");
    ok('E.singleChatStillWorks', await waitFor(cdp, "(async function(){var all=await dbGetByIndex('chatMessages','byFriend','" + A_ID + "');return all.filter(function(m){return m.role==='assistant'}).length>=1;})()", 25000));
    ok('E.singleChatHasNoGroupIdentity', await evaluate(cdp, "(async function(){var all=await dbGetByIndex('chatMessages','byFriend','" + A_ID + "');return all.filter(function(m){return m.role==='assistant'}).every(function(m){var md=m.metadata||{};return !('groupTurnId' in md)&&!('groupOrder' in md)})})()"));
    await evaluate(cdp, "(function(){stopStreaming();return true})()");   /* 单聊上调用 stop 不应产生群状态副作用 */
    ok('E.stopOnSingleChatKeepsWorking', await evaluate(cdp, "typeof window.IBGroupRuntime.planParticipation==='function'"));

    /* ── F · fail closed / empty plan 行为不变（且与 cancel 互不干扰）── */
    await evaluate(cdp, "(function(){window.__m331SavedValidate=window.IBGroupRuntime.validateParticipationInput;window.IBGroupRuntime.validateParticipationInput=function(){return {ok:false,errors:['injected']}};return true})()");
    const botsBeforeF1 = (await evaluate(cdp, bots)).length;
    mock.requests.length = 0;
    await evaluate(cdp, send('M331 failclosed'));
    ok('F.failClosedShowsNotice', await waitFor(cdp, "(function(){var m=document.getElementById('chat-messages')||document.getElementById('chat-full-messages');return !!m&&m.textContent.indexOf('本轮参与计划不可用')>=0;})()", 15000));
    await sleep(600);
    ok('F.failClosedZeroProviderCalls', reqsFor(mock, 'M331 failclosed').length === 0);
    ok('F.failClosedNoAssistantRow', (await evaluate(cdp, bots)).length === botsBeforeF1);
    await evaluate(cdp, "(function(){window.IBGroupRuntime.validateParticipationInput=window.__m331SavedValidate;return true})()");

    await evaluate(cdp, "(function(){return dbPut('groups',{id:'" + MUTE_GROUP + "',name:'M331 Mute',members:[{characterId:'" + A_ID + "',status:'muted',joinedAt:1}],memoryEnabled:false,created:1})})()");
    await evaluate(cdp, "(function(){activeFriendId='" + MUTE_GROUP + "';activeThreadId=null;openChatPanel();var i=document.getElementById('chat-input');i.value='M331 empty plan';return sendChatMessage()})()");
    ok('F.emptyPlanKeepsExistingPresentation', await waitFor(cdp, "(function(){var m=document.getElementById('chat-messages')||document.getElementById('chat-full-messages');return !!m&&m.textContent.indexOf('本轮无人回应')>=0;})()", 20000));
    ok('F.emptyPlanZeroProviderCalls', reqsFor(mock, 'M331 empty plan').length === 0);

    ok('runtime.noUncaughtExceptions', exceptions.length === 0, exceptions.slice(0, 3));
  } finally {
    try { browser.kill(); } catch (e) { /* ignore */ }
    try { mock.server.close(); } catch (e) { /* ignore */ }
    rmWithRetry(profile, 5);
  }
  return finish();
}

function finish() {
  console.log(failures === 0 ? '\n全部通过 ✔  (' + passes + ')' : '\n失败 ' + failures + ' 项（通过 ' + passes + '）');
  process.exitCode = failures ? 1 : 0;
}

main().catch(e => { console.error('harness error: ' + (e && e.message)); process.exitCode = 2; });
