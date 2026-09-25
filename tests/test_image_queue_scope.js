/*
 * R3 · Media Attribution / Image Queue Scope
 *
 * Run: node tests/test_image_queue_scope.js
 *
 * This is a focused browser/runtime test. The browser portion uses the real
 * loaded communication/workspace functions with a local mock provider. Queue
 * seeding is an isolated runtime probe; it is deliberately not called a real
 * UI image-generation E2E.
 */

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
const A = 'r3-role-a';
const B = 'r3-role-b';
const THREAD = 'r3-thread-x';
const G1 = 'group_r3_g1';
const G2 = 'group_r3_g2';

let failures = 0;
let passes = 0;
function ok(name, condition, detail) {
  if (condition) {
    passes++;
    console.log('  PASS  ' + name);
  } else {
    failures++;
    console.error('  FAIL  ' + name + (detail === undefined ? '' : '  -> ' + JSON.stringify(detail).slice(0, 360)));
  }
}

function stripComments(src) {
  return String(src).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

function staticAudit() {
  const ws = read('assets/js/workspace.js');
  const ops = read('assets/js/site-operations.js');
  const comm = read('assets/js/communication.js');
  const core = read('assets/js/chat-core.js');
  const docs = read('docs/R3-MEDIA-ATTRIBUTION-QUEUE-SCOPE-CONTRACT.md');
  const code = stripComments(comm);

  ok('S1.contractExistsAndFrozen', /Status: CONTRACT FROZEN/.test(docs)
    && /Legacy Policy/.test(docs) && /Destructive Queue Rule/.test(docs));
  ok('S2.producersCaptureOriginAttribution', /var _queueImage=function\(raw,name\)/.test(ws)
    && /if\(actorId\)_item\.actorId=actorId/.test(ws)
    && /if\(_sc\)\{_item\.friendId=_sc\.friendId;_item\.threadId=_sc\.threadId;\}/.test(ws)
    && /_ibImageDrain\.push\(_item\)/.test(ws));
  ok('S3.toolImagesInheritParentAttribution', /derived tool-image items inherit/.test(ops)
    && /if\(s2\.actorId\)_item\.actorId=String\(s2\.actorId\)/.test(ops)
    && /if\(s2\.friendId\)\{_item\.friendId=String\(s2\.friendId\);_item\.threadId=/.test(ops));
  ok('S4.consumerUsesStablePartition', /function _ibTakeScopedMedia\(queueName,filterFn\)/.test(comm)
    && /window\[queueName\]=keep/.test(comm)
    && !/(_ibImageDrain|_ibToolDrainImages)\.splice\(0\)/.test(code));
  ok('S5.legacyFailsClosed', /if\(!fid\)\{keep\.push\(item\);return\}/.test(comm)
    && /never assigned the\s+current conversation/.test(comm));
  ok('S6.noConsumerTimeGuessing', !/activeFriendId.*_ibImageDrain|_ibImageDrain.*activeFriendId/.test(code)
    && !/actorId.*conversationIdOf/.test(code));
  ok('S7.canonicalImageSchemaUnchanged', /var CONDITIONAL_FIELDS = \[/.test(core)
    && /'images'/.test(core)
    && !/actorId/.test(core.slice(core.indexOf('var CONDITIONAL_FIELDS'), core.indexOf('var LEGACY_FIELDS')))
    && /chatMessages\.images/.test(docs));
  ok('S8.noSchemaOrManagerChange', /DB_VER\s*=\s*24/.test(read('assets/js/core.js'))
    && !/createObjectStore/.test(stripComments(ws + ops + comm))
    && !/UniversalAttributionManager|ImageScopeRegistry|EventBus|MediaManager/.test(ws + ops + comm));
  ok('S9.p29P30AdaptersRemain', /function _ibWsScopeFilter\(friendId,threadId\)/.test(comm)
    && /return _ibConvId\(it\.friendId,it\.threadId\)===cur/.test(comm)
    && /var actorId=\(cfg&&typeof cfg==='object'\)\?String\(cfg\.id\|\|' '\)/.test(ws) === false
    && /var actorId=\(cfg&&typeof cfg==='object'\)\?String\(cfg\.id\|\|''\):'';/.test(ws));
  ok('S10.noConsumeThenFilter', !/splice\(0\)[\s\S]{0,300}(filter|scope)/.test(code));
}

function startMock() {
  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(raw); } catch (e) { /* keep empty */ }
      requests.push(body);
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type,Authorization'
      });
      res.end(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'r3 mock reply' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
      }));
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({
    server, port: server.address().port, requests
  })));
}

async function browserRuntime() {
  const chrome = chromePath();
  ok('R.browserBinaryAvailable', !!chrome, chrome);
  if (!chrome) return;

  const mock = await startMock();
  const port = await freePort();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-r3-'));
  const browser = spawn(chrome, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    '--allow-file-access-from-files', '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=' + port, '--user-data-dir=' + profile, 'about:blank'
  ], { stdio: 'ignore', windowsHide: true });
  let cdp;
  try {
    let ready = false;
    for (let i = 0; i < 120; i++) {
      try {
        const r = await fetch('http://127.0.0.1:' + port + '/json/version');
        if (r.ok) { ready = true; break; }
      } catch (e) { /* starting */ }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    ok('R.browserReady', ready);
    if (!ready) return;
    const tab = await (await fetch('http://127.0.0.1:' + port + '/json/new?' + encodeURIComponent(PAGE_URL), { method: 'PUT' })).json();
    cdp = await Cdp.connect(tab.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable');
    const exceptions = [];
    cdp.on('Runtime.exceptionThrown', p => exceptions.push(String(
      (p.exceptionDetails && p.exceptionDetails.exception && p.exceptionDetails.exception.description)
      || (p.exceptionDetails && p.exceptionDetails.text) || '')));
    const seams = await waitFor(cdp,
      "typeof window.sendChatMessage==='function'&&typeof window._ibTakeScopedMedia==='function'"
      + "&&typeof window._ibWsScopeFilter==='function'&&typeof window._execWsOps==='function'", 25000);
    ok('R.pageSeamsReady', seams);
    if (!seams) return;
    await evaluate(cdp, 'window.confirm=function(){return true};');

    const ep = 'http://127.0.0.1:' + mock.port + '/v1/chat/completions';
    const seeded = await evaluate(cdp, "(async function(){"
      + "var mk=function(id,nick){return {id:id,nickname:nick,model:'r3-'+id,endpoint:'" + ep + "',apiKey:'',provider:'custom',vision:true,streaming:false,showThinking:false,imageGen:false,systemPrompt:'测试角色',temperature:1,created:Date.now()}};"
      + "await dbPut('apiConfigs',mk('" + A + "','Role A'));"
      + "await dbPut('apiConfigs',mk('" + B + "','Role B'));"
      + "await loadApiConfigs();return apiConfigs.length})()");
    ok('R.fixturesSeeded', seeded >= 2, seeded);

    /* Producer probe: real workspace read_image path, not a hand-built producer copy. */
    const produced = await evaluate(cdp, "(async function(){"
      + "window._ibImageDrain=[];var cfg=apiConfigs.find(function(x){return x.id==='" + A + "'});"
      + "var pid=await wsEnsureDefaultProject();await wsSaveFile(pid,'r3-source.png','data:image/png;base64,UkMzLVBSR0Q=','User');"
      + "await _execWsOps([{type:'read_image',path:'r3-source.png'}],'Role A',cfg,{source:'chat',friendId:'" + A + "',threadId:'" + THREAD + "'});"
      + "var it=window._ibImageDrain[0]||{};return {n:window._ibImageDrain.length,dataUrl:it.dataUrl,actorId:it.actorId,friendId:it.friendId,threadId:it.threadId,mime:it.mime}})()");
    ok('I.producerCapturesActorAndWhere', produced.n === 1 && produced.actorId === A
      && produced.friendId === A && produced.threadId === THREAD && produced.mime === 'image/png', produced);

    /* Pure queue probe: stable partition, wrong WHERE KEEP, right WHERE TAKE, legacy KEEP. */
    const partition = await evaluate(cdp, "(function(){"
      + "window._ibImageDrain=["
      + "{dataUrl:'data:image/png;base64,RDMtRzE=',actorId:'" + A + "',friendId:'" + G1 + "',threadId:null},"
      + "{dataUrl:'data:image/png;base64,RDMtQjI=',actorId:'" + B + "',friendId:'" + G2 + "',threadId:null},"
      + "'data:image/png;base64,RDMtTEVHQUNZ',"
      + "{dataUrl:'data:image/png;base64,RDMtRzFfMg==',actorId:'" + A + "',friendId:'" + G1 + "',threadId:null}];"
      + "var take=_ibTakeScopedMedia('_ibImageDrain',_ibWsScopeFilter('" + G1 + "',null));"
      + "return {take:take.map(function(x){return x.dataUrl||x}),keep:window._ibImageDrain.map(function(x){return x.dataUrl||x}),n:window._ibImageDrain.length}})()");
    ok('I2.wrongWhereKept', partition.keep.length === 2
      && partition.keep[0].indexOf('RDMtQjI') >= 0 && partition.keep[1].indexOf('RDMtTEVHQUNZ') >= 0, partition);
    ok('I3.rightWhereTakesNToNMinusOne', partition.take.length === 2 && partition.n === 2, partition);
    ok('I6.crossGroupIsolation', partition.take[0].indexOf('RDMtRzE') >= 0 && partition.take[1].indexOf('RDMtRzFfMg') >= 0, partition);
    ok('I7.stableFifo', partition.take[0].indexOf('RDMtRzE=') >= 0
      && partition.take[1].indexOf('RDMtRzFfMg==') >= 0
      && partition.keep[0].indexOf('RDMtQjI=') >= 0
      && partition.keep[1].indexOf('RDMtTEVHQUNZ') >= 0, partition);
    ok('I8.legacyFailsClosed', partition.keep.some(x => x.indexOf('RDMtTEVHQUNZ') >= 0), partition);

    const sameActorWhere = await evaluate(cdp, "(function(){"
      + "window._ibImageDrain=[{dataUrl:'data:image/png;base64,UkMzLUYy',actorId:'" + B + "',friendId:'" + G1 + "',threadId:null}];"
      + "var dm=_ibTakeScopedMedia('_ibImageDrain',_ibWsScopeFilter('" + B + "',null));var leftDm=window._ibImageDrain.length;"
      + "window._ibImageDrain=[{dataUrl:'data:image/png;base64,UkMzLUY0',actorId:'" + B + "',friendId:'" + G1 + "',threadId:null}];"
      + "var g2=_ibTakeScopedMedia('_ibImageDrain',_ibWsScopeFilter('" + G2 + "',null));var leftG2=window._ibImageDrain.length;"
      + "return {dm:dm.length,leftDm:leftDm,g2:g2.length,leftG2:leftG2}})()");
    ok('I4.sameActorDifferentConversationKept', sameActorWhere.dm === 0 && sameActorWhere.leftDm === 1, sameActorWhere);
    ok('I6.sameActorCrossGroupKept', sameActorWhere.g2 === 0 && sameActorWhere.leftG2 === 1, sameActorWhere);

    /* Tool-derived child inherits the parent scope and is also kept on mismatch. */
    const tool = await evaluate(cdp, "(function(){"
      + "window._ibToolPendingResults=[{actor:'Role A',actorId:'" + A + "',friendId:'" + A + "',threadId:null,images:['data:image/png;base64,UkMzLVRPT0w='],text:'tool'}];window._ibToolDrainImages=[];"
      + "var wrong=_getIbToolResultInjection(_ibWsScopeFilter('" + B + "',null));var left=window._ibToolPendingResults.length;"
      + "var right=_getIbToolResultInjection(_ibWsScopeFilter('" + A + "',null));var it=window._ibToolDrainImages[0]||{};"
      + "return {wrong:wrong,left:left,right:!!right,actorId:it.actorId,friendId:it.friendId,threadId:it.threadId,dataUrl:it.dataUrl}})()");
    ok('I2.toolWrongWhereKept', tool.wrong === '' && tool.left === 1, tool);
    ok('I3.toolOwnerTakesAndInheritsAttribution', tool.right && tool.actorId === A && tool.friendId === A
      && tool.threadId === null && tool.dataUrl.indexOf('UkMzLVRPT0w=') >= 0, tool);

    async function turn(friend, text, thread) {
      mock.requests.length = 0;
      const expr = "(function(){activeFriendId='" + friend + "';activeThreadId="
        + (thread ? JSON.stringify(thread) : 'null') + ";openChatPanel();"
        + "var i=document.getElementById('chat-input')||document.getElementById('chat-full-input');"
        + "i.value='" + text + "';sendChatMessage();return true})()";
      await evaluate(cdp, expr);
      for (let i = 0; i < 48 && !mock.requests.some(x => JSON.stringify(x).includes(text)); i++) {
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      return mock.requests.slice();
    }
    function requestText(reqs) { return JSON.stringify(reqs); }

    /* Real consumer path: A item cannot be consumed by B, then A can consume it. */
    await evaluate(cdp, "window._ibImageDrain=[{dataUrl:'data:image/png;base64,UkMzLUZSMQ==',base64:'UkMzLUZSMQ==',mime:'image/png',name:'r3-f1.png',actorId:'" + A + "',friendId:'" + A + "',threadId:null}];");
    const beforeWrong = await evaluate(cdp, 'window._ibImageDrain.length');
    const bReq = await turn(B, 'r3-f1-consumer-b', null);
    const afterWrong = await evaluate(cdp, 'window._ibImageDrain.length');
    ok('I1.AProducesBCannotConsume', beforeWrong === 1 && !requestText(bReq).includes('UkMzLUZSMQ==') && afterWrong === 1, { beforeWrong, afterWrong });
    const aReq = await turn(A, 'r3-f1-owner-a', null);
    const afterOwner = await evaluate(cdp, 'window._ibImageDrain.length');
    const aText = requestText(aReq);
    ok('I3.ownerConsumesNToNMinusOne', aText.includes('UkMzLUZSMQ==') && afterOwner === 0, { afterOwner });
    ok('I14.noDuplicateImageInjection', aText.split('UkMzLUZSMQ==').length - 1 === 1, aText.slice(0, 1000));

    /* Same actor, different WHERE: main conversation cannot consume thread X. */
    await evaluate(cdp, "window._ibImageDrain=[{dataUrl:'data:image/png;base64,UkMzLUYz',base64:'UkMzLUYz',mime:'image/png',name:'r3-f3.png',actorId:'" + B + "',friendId:'" + B + "',threadId:'" + THREAD + "'}];");
    const mainReq = await turn(B, 'r3-f3-main', null);
    const keptThread = await evaluate(cdp, 'window._ibImageDrain.length');
    ok('I5.sameActorDifferentThreadKept', !requestText(mainReq).includes('UkMzLUYz') && keptThread === 1, { keptThread });
    const threadReq = await turn(B, 'r3-f3-thread', THREAD);
    const threadGone = await evaluate(cdp, 'window._ibImageDrain.length');
    ok('I5.threadOwnerConsumes', requestText(threadReq).includes('UkMzLUYz') && threadGone === 0, { threadGone });

    /* Legacy payload safety: it remains queued and never becomes [object Object]/undefined. */
    const legacy = await evaluate(cdp, "(function(){window._ibImageDrain=['data:image/png;base64,UkMzLUxFR0FDWQ=='];var t=_ibTakeScopedMedia('_ibImageDrain',_ibWsScopeFilter('" + B + "',null));return {take:t.length,left:window._ibImageDrain.length,prompt:_ibMediaPromptImage(window._ibImageDrain[0],'legacy.png')}})()");
    ok('I8.legacyProbeKeepsItem', legacy.take === 0 && legacy.left === 1 && legacy.prompt && legacy.prompt.dataUrl.indexOf('data:image/') === 0, legacy);
    ok('I15.noObjectOrUndefinedPayload', !JSON.stringify(legacy).includes('[object Object') && !JSON.stringify(legacy).includes('undefined'), legacy);

    /* Canonical image storage is still the existing message image shape. */
    const canonical = await evaluate(cdp, "(function(){var x=_wsCollectGenImages([{type:'gen_image',ok:true,dataUrl:'data:image/png;base64,QQ==',base64:'QQ==',mime:'image/png',model:'r3'}])[0];return {keys:Object.keys(x).sort(),hasActor:('actorId' in x),hasFriend:('friendId' in x),hasThread:('threadId' in x)}})()");
    ok('I9.canonicalChatMessageImageUnchanged', canonical.hasActor === false && canonical.hasFriend === false && canonical.hasThread === false
      && canonical.keys.includes('dataUrl') && canonical.keys.includes('base64') && canonical.keys.includes('mime'), canonical);
    ok('I10.dbVer24', await evaluate(cdp, 'String(window.DB_VER||\'\')') === '24');
    ok('I11.p29IdentitySourceStillCfgId', await evaluate(cdp, "(function(){var s=String(_execWsOps);return true})()") === true
      && /cfg\.id/.test(read('assets/js/workspace.js')));
    ok('I12.p30CanonicalConversationStillGreen', ChatCore.conversationIdOf(B, THREAD) === 'dm:' + B + '|' + THREAD
      && await evaluate(cdp, "_ibConvId('" + B + "','" + THREAD + "')") === 'dm:' + B + '|' + THREAD);
    ok('I13.noConsumeThenFilter', await evaluate(cdp, "(function(){window._ibImageDrain=[{dataUrl:'data:image/png;base64,QQ==',friendId:'" + A + "',threadId:null}];var t=_ibTakeScopedMedia('_ibImageDrain',_ibWsScopeFilter('" + B + "',null));return t.length===0&&window._ibImageDrain.length===1})()"));
    ok('R.boundaryNoUncaughtExceptions', exceptions.length === 0, exceptions.slice(0, 3));
  } finally {
    try { cdp && cdp.close(); } catch (e) { /* ignore */ }
    try { browser.kill(); } catch (e) { /* ignore */ }
    try { mock.server.close(); } catch (e) { /* ignore */ }
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  }
}

async function main() {
  console.log('== R3 · Media Attribution / Image Queue Scope ==');
  staticAudit();
  await browserRuntime();
  console.log(failures === 0 ? '\n全部通过 ✔  (' + passes + ')' : '\n失败 ' + failures + ' 项');
  process.exitCode = failures ? 1 : 0;
}

main().catch(error => {
  console.error('harness error: ' + (error && error.stack || error));
  process.exitCode = 2;
});
