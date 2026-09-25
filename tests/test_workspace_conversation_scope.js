'use strict';

/* Internal Beyond · P30-2 · Workspace Conversation Scope
   （browser 组：源码守卫 + 真实 producer/consumer 断言；运行：
     node tests/test_workspace_conversation_scope.js）

   P30-1 冻结契约：item additive 带 (friendId, threadId)；consumer 只消费同会话条目，
   不匹配项 KEEP；scope 缺失 ⇒ legacy / intentionally unscoped 保持旧行为；
   比较键只来自 chat-core.conversationIdOf。

   覆盖 C1–C8。 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const assert = require('assert/strict');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const ChatCore = require(path.join(ROOT, 'assets', 'js', 'chat-core.js'));

const harness = fs.readFileSync(path.join(__dirname, 'test_chat_smoke.js'), 'utf8');
const boundary = harness.indexOf('async function main() {');
assert.ok(boundary > 0, 'existing CDP harness boundary changed');
const { chromePath, Cdp, evaluate, waitFor, freePort } = new Function('require', '__dirname',
  harness.slice(0, boundary) + '\nreturn {chromePath,Cdp,evaluate,waitFor,freePort};')(require, __dirname);

const PAGE_URL = 'file:///' + path.join(ROOT, 'InternalBeyond.html').replace(/\\/g, '/');
const G1 = 'group_1700000007001';
const A = 'friend_p302_a', B = 'friend_p302_b', C = 'friend_p302_c';
const SAME = '希儿', THIRD = '第三角色';
const MA = 'p302-model-a', MB = 'p302-model-b', MC = 'p302-model-c';
const TH = 'thread_p302_b';            /* B 的话题频道（C4 用） */

let failures = 0, passes = 0;
function ok(name, cond, detail) {
  if (cond) { passes++; console.log('  PASS  ' + name); }
  else {
    failures++;
    console.error('  FAIL  ' + name + (detail !== undefined ? '  -> ' + JSON.stringify(detail).slice(0, 320) : ''));
  }
}
function stripComments(src) {
  return String(src).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}
function rmWithRetry(dir, tries) {
  for (let i = 0; i < (tries || 5); i++) {
    try { fs.rmSync(dir, { recursive: true, force: true }); return true; } catch (e) { /* retry */ }
    const end = Date.now() + 200;
    while (Date.now() < end) { /* busy-wait */ }
  }
  return false;
}

/* ── C8（纯层）：canonical 派生唯一来源 ─────────────────────────────────────── */
function canonicalFunction() {
  ok('C8.conversationIdOfIsCanonicalSource',
    ChatCore.conversationIdOf('friend_x') === 'dm:friend_x'
    && ChatCore.conversationIdOf('friend_x', 't1') === 'dm:friend_x|t1'
    && ChatCore.conversationIdOf('group_y') === 'group:group_y'
    && ChatCore.conversationIdOf('group_y', 't1') === 'group:group_y|t1');
  ok('C8.deterministic',
    ChatCore.conversationIdOf('friend_x', null) === ChatCore.conversationIdOf('friend_x', undefined)
    && ChatCore.conversationIdOf('friend_x', 't1') === ChatCore.conversationIdOf('friend_x', 't1'));
  ok('C8.roundTripWithParser',
    JSON.stringify(ChatCore.parseConversationId(ChatCore.conversationIdOf('friend_x', 't1')))
    === JSON.stringify({ conversationId: 'dm:friend_x|t1', kind: 'dm', friendId: 'friend_x', threadId: 't1', isGroup: false }));

  /* consumer 只经既有 adapter `_ibConvId`（→ chat-core）比较；不得自拼 conversationId */
  const comm = read('assets/js/communication.js');
  ok('C8.filterUsesExistingAdapter',
    /function _ibWsScopeFilter\(friendId,threadId\)\{\s*var cur=_ibConvId\(friendId,threadId\);/.test(comm)
    && /_ibConvId\(it\.friendId,it\.threadId\)===cur/.test(comm));
  ok('C8.noLocalDerivation', comm.indexOf("'dm:'+") >= 0   /* 只允许 _ibConvId 的兜底 */
    && (comm.match(/'dm:'\+/g) || []).length === 1 && (comm.match(/'group:'\+/g) || []).length === 0);

  /* producer 侧只搬字段，不派生 */
  ['assets/js/workspace.js', 'assets/js/workspace/run.js', 'assets/js/site-operations.js'].forEach(f => {
    const src = stripComments(read(f));
    ok('C8.noConversationIdInProducer:' + f.split('/').pop(),
      src.indexOf('conversationIdOf') < 0 && src.indexOf("'dm:'") < 0 && src.indexOf("'group:'") < 0);
  });
  ok('C8.noManagerIntroduced',
    ['ConversationManager', 'ScopeRegistry', 'QueueManager', 'EventBus', 'sessionId']
      .every(n => comm.indexOf(n) < 0 && read('assets/js/workspace.js').indexOf(n) < 0));
}

/* ── 最小 mock provider ─────────────────────────────────────────────────────── */
function startMock() {
  const requests = [];
  const server = http.createServer((req, res) => {
    const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-API-Key,anthropic-version,x-goog-api-key' };
    if (req.method === 'OPTIONS') { res.writeHead(204, headers); res.end(); return; }
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      let body = {}; try { body = JSON.parse(raw); } catch (e) { /* ignore */ }
      requests.push({ model: String(body.model || ''), messages: Array.isArray(body.messages) ? body.messages : [] });
      res.writeHead(200, headers);
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'p302-reply:' + body.model }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } }));
    });
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r({ server, port: server.address().port, requests })));
}

async function browserE2E() {
  const chrome = chromePath();
  ok('browser.binaryFound', !!chrome, chrome);
  if (!chrome) return;
  const mock = await startMock();
  const port = await freePort();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-p302-'));
  const browser = spawn(chrome, ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    '--allow-file-access-from-files', '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=' + port, '--user-data-dir=' + profile, 'about:blank'],
    { stdio: 'ignore', windowsHide: true });
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
    const pageReady = await waitFor(cdp,
      "typeof window._execWsOps==='function'&&typeof window.sendChatMessage==='function'"
      + "&&typeof window._ibConvId==='function'&&typeof window._ibWsScopeFilter==='function'"
      + "&&!!(window.IBChatCore&&window.IBChatCore.conversationIdOf)", 25000);
    ok('page.scopeSeamsReady', pageReady);
    await evaluate(cdp, "window.confirm=function(){return true};");

    const ep = 'http://127.0.0.1:' + mock.port + '/v1/chat/completions';
    ok('fixtures.seeded', (await evaluate(cdp, "(async function(){"
      + "var mk=function(id,model,nick){return {id:id,nickname:nick,model:model,endpoint:'" + ep + "',apiKey:'',provider:'custom',vision:true,"
      + "systemPrompt:'你是测试角色。',temperature:1,streaming:false,showThinking:false,promptCache:false,created:Date.now()}};"
      + "await dbPut('apiConfigs',mk('" + A + "','" + MA + "','" + SAME + "'));"
      + "await dbPut('apiConfigs',mk('" + B + "','" + MB + "','" + SAME + "'));"
      + "await dbPut('apiConfigs',mk('" + C + "','" + MC + "','" + THIRD + "'));"
      + "await dbPut('groups',{id:'" + G1 + "',name:'G1',members:[{characterId:'" + A + "',status:'active',joinedAt:1},"
      + "{characterId:'" + B + "',status:'active',joinedAt:1}],memoryEnabled:false,created:1});"
      + "await dbPut('chatThreads',{id:'" + TH + "',friendId:'" + B + "',name:'T1',created:1});"
      + "var pid=await wsEnsureDefaultProject();await wsSaveFile(pid,'p302.md','p302 seed','User');"
      + "return 'seeded'})()")) === 'seeded');
    await evaluate(cdp, 'loadApiConfigs()');

    const send = (friend, text, thread) => "(function(){activeFriendId='" + friend + "';activeThreadId=" + (thread ? "'" + thread + "'" : 'null') + ";openChatPanel();"
      + "var i=document.getElementById('chat-input');i.value='" + text + "';sendChatMessage();return true})()";
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const reqsFor = t => mock.requests.filter(r => JSON.stringify(r.messages).indexOf(t) >= 0);
    const turn = async (friend, text, thread, expect) => {
      mock.requests.length = 0;
      for (let a = 0; a < 8 && reqsFor(text).length < expect; a++) {
        await evaluate(cdp, send(friend, text, thread));
        for (let w = 0; w < 20 && reqsFor(text).length < expect; w++) await sleep(400);
      }
      return reqsFor(text);
    };
    const has = (reqs, model, marker) => {
      const r = reqs.find(x => x.model === model);
      return !!r && JSON.stringify(r.messages).indexOf(marker) >= 0;
    };
    const queue = () => evaluate(cdp, 'window._wsPendingReads.length+window._wsPendingOpFeedback.length');
    /* 真实 producer：在给定会话上下文里读文件（marker 写在文件内容里，随读取结果进入队列） */
    const produce = (marker, friendId, threadId) => evaluate(cdp, "(async function(){"
      + "var cfgB=apiConfigs.find(function(x){return x.id==='" + B + "'});"
      + "window._wsPendingReads=[];window._wsPendingOpFeedback=[];window._wsPendingRunOutputs=[];window._ibToolPendingResults=[];"
      + "var pid=await wsEnsureDefaultProject();await wsSaveFile(pid,'p302.md','" + marker + "','User');"
      + "await _execWsOps([{type:'read',path:'p302.md'}],'" + SAME + "',cfgB,{source:'chat',friendId:'" + friendId + "',threadId:'" + (threadId || '') + "'});"
      + "var it=window._wsPendingReads[0]||{};"
      + "return {friendId:it.friendId,threadId:it.threadId,actorId:it.actorId,queue:window._wsPendingReads.length}})()");

    /* ── 生产者形状（含 unscoped 反例）── */
    const pScoped = await produce('P302-PROD-SCOPED', G1, '');
    ok('P.scopedReadItemCarriesScope', pScoped.friendId === G1 && pScoped.threadId === null && pScoped.queue === 1, pScoped);
    const pUnscoped = await evaluate(cdp, "(async function(){var cfgB=apiConfigs.find(function(x){return x.id==='" + B + "'});"
      + "window._wsPendingReads=[];await _execWsOps([{type:'read',path:'p302.md'}],'" + SAME + "',cfgB,{});"
      + "var it=window._wsPendingReads[0]||{};return {hasFriendId:('friendId' in it),hasThreadId:('threadId' in it)}})()");
    ok('P.noIctxMeansUnscopedNoFields', pUnscoped.hasFriendId === false && pUnscoped.hasThreadId === false, pUnscoped);

    /* ── C1：G1 的条目 → 1:1 C 不可见，且**留在队列** ── */
    await produce('P302-C1', G1, '');
    let reqs = await turn(C, 'p302 c1 to C', null, 1);
    ok('C1.wrongConversationCannotSee', !has(reqs, MC, 'P302-C1'), reqs.map(r => r.model));
    ok('C1.itemKeptInQueue', (await queue()) === 1, await queue());

    /* ── C3：错误会话**重复**读取，队列长度不变 ── */
    await turn(C, 'p302 c3 to C (again)', null, 1);
    ok('C3.repeatedWrongConsumerKeepsQueue', (await queue()) === 1, await queue());

    /* ── C2：正确会话（G1）消费成功 → 队列移除 ── */
    reqs = await turn(G1, 'p302 c2 to G1', null, 2);
    ok('C2.ownerConversationSeesItem', has(reqs, MB, 'P302-C1'), reqs.map(r => r.model));
    ok('C2.ownerConsumptionRemovesItem', (await queue()) === 0, await queue());

    /* ── C4：同 actor / 不同 thread（B 的主对话 vs B 的话题频道）── */
    await produce('P302-C4', B, TH);
    reqs = await turn(B, 'p302 c4 to B main', null, 1);
    ok('C4.mainConversationCannotSeeThreadItem', !has(reqs, MB, 'P302-C4'), reqs.map(r => r.model));
    ok('C4.threadItemKept', (await queue()) === 1, await queue());
    reqs = await turn(B, 'p302 c4 to B thread', TH, 1);
    ok('C4.threadConversationSeesItem', has(reqs, MB, 'P302-C4'), reqs.map(r => r.model));
    ok('C4.threadConsumptionRemovesItem', (await queue()) === 0, await queue());

    /* ── C5：legacy（无 scope）保持旧行为 ── */
    await evaluate(cdp, "window._wsPendingReads=[];window._wsPendingOpFeedback=[];"
      + "window._wsPendingReads.push({path:'p302.md',projectId:'x',actor:'" + SAME + "',actorId:'" + B + "',content:'P302-C5-LEGACY',total:14});");
    reqs = await turn(C, 'p302 c5 legacy to C', null, 1);
    ok('C5.legacyUnscopedKeepsOldBehavior', has(reqs, MC, 'P302-C5-LEGACY'), reqs.map(r => r.model));
    ok('C5.legacyConsumedAndRemoved', (await queue()) === 0, await queue());

    /* ── C6：intentionally unscoped（guard breaker 形状）在群里保持 first-turn fallback ── */
    await evaluate(cdp, "window._wsPendingReads=[];window._wsPendingOpFeedback=[];"
      + "window._wsPendingOpFeedback.push({actor:'',text:'P302-C6-UNSCOPED'});");
    reqs = await turn(G1, 'p302 c6 unscoped to G1', null, 2);
    ok('C6.intentionallyUnscopedFirstTurnFallback', has(reqs, MA, 'P302-C6-UNSCOPED'), reqs.map(r => r.model));
    ok('C6.unscopedConsumed', (await queue()) === 0, await queue());

    /* ── 运行期 C8：派生键只来自 chat-core ── */
    ok('C8.runtimeAdapterMatchesChatCore',
      (await evaluate(cdp, "window._ibConvId('" + B + "','" + TH + "')")) === ChatCore.conversationIdOf(B, TH));
    ok('boundary.noUncaughtExceptions', exceptions.length === 0, exceptions.slice(0, 3));
  } finally {
    try { browser.kill(); } catch (e) { /* ignore */ }
    try { mock.server.close(); } catch (e) { /* ignore */ }
    rmWithRetry(profile, 5);
  }
}

async function main() {
  console.log('== P30-2 · Workspace Conversation Scope 测试 ==');
  canonicalFunction();
  await browserE2E();
  console.log(failures === 0 ? '\n全部通过 ✔  (' + passes + ')'
    : '\n失败 ' + failures + ' 项');
  process.exitCode = failures ? 1 : 0;
}

main().catch(e => { console.error('harness error: ' + (e && e.stack || e)); process.exitCode = 2; });
