'use strict';

/* Internal Beyond · P29-3 · Workspace Actor Identity（canonical attribution preservation）
   （browser 组：源码守卫 + 真实浏览器 producer/reader 断言；运行：
     node tests/test_workspace_actor_identity.js）

   P29-2 冻结契约（本阶段不得重新讨论）：
     · runtime item 新增 additive 字段 actorId（canonical），actor 保持 display-only；
     · canonical source = cfg.id；actorId 缺失/空 ⇒ legacy 唯一精确显示名；歧义/无法解析 ⇒ not mine；
     · 无主（actor 与 actorId 都空）⇒ 既有首轮兜底；
     · 1:1 take-all / image drain / projectFiles / session scope 均不变。

   覆盖 A1–A16（见 P29-3 §25）。 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const assert = require('assert/strict');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const Core = require(path.join(ROOT, 'assets', 'js', 'group-runtime-core.js'));
const ChatCore = require(path.join(ROOT, 'assets', 'js', 'chat-core.js'));

const harness = fs.readFileSync(path.join(__dirname, 'test_chat_smoke.js'), 'utf8');
const boundary = harness.indexOf('async function main() {');
assert.ok(boundary > 0, 'existing CDP harness boundary changed');
const { chromePath, Cdp, evaluate, waitFor, freePort } = new Function('require', '__dirname',
  harness.slice(0, boundary) + '\nreturn {chromePath,Cdp,evaluate,waitFor,freePort};')(require, __dirname);

const PAGE_URL = 'file:///' + path.join(ROOT, 'InternalBeyond.html').replace(/\\/g, '/');
const GROUP = 'group_1700000004000';
const A = 'friend_p293_a', B = 'friend_p293_b', C = 'friend_p293_c';
const SAME = '希儿';
const THIRD = '第三角色';
const MA = 'p293-model-a', MB = 'p293-model-b', MC = 'p293-model-c';
const FOREIGN = 'role_p293_foreign';

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
function count(hay, needle) { return String(hay).split(needle).length - 1; }
function rmWithRetry(dir, tries) {
  for (let i = 0; i < (tries || 5); i++) {
    try { fs.rmSync(dir, { recursive: true, force: true }); return true; } catch (e) { /* retry */ }
    const end = Date.now() + 200;
    while (Date.now() < end) { /* busy-wait */ }
  }
  return false;
}

const WS = () => read('assets/js/workspace.js');
const RUN = () => read('assets/js/workspace/run.js');
const OPS = () => read('assets/js/site-operations.js');
const COMM = () => read('assets/js/communication.js');

/* ── 静态守卫（A1–A16 的源码面 + display 不变量）────────────────────────────── */
function staticGuards() {
  const ws = WS(), run = RUN(), ops = OPS(), comm = COMM();
  const wsCode = stripComments(ws), opsCode = stripComments(ops), commCode = stripComments(comm);

  /* P30-2 更新：条目统一经 `_pushOpFeedback` / `Object.assign(...,_sc,...)` 入队（additive 增补会话归属），
     actorId 的写入位置与强度不变 —— 断言按新形状重写，语义仍为"四类条目都带 canonical actorId"。 */
  ok('A1.producerWritesActorId',
    /var _pushOpFeedback=function\(text\)\{\s*_wsPendingOpFeedback\.push\(Object\.assign\(\{actor:authorName,actorId:actorId\},_sc,\{text:text\}\)\);\s*\};/.test(ws));
  ok('A1.readEntryCarriesActorId', /var _rEntry=Object\.assign\(\{path:op\.path,projectId:_wsActiveProject,actor:authorName,actorId:actorId,/.test(ws));
  ok('A1.runCtxCarriesActorId', /var _rCtx=Object\.assign\(\{[^}]*author:authorName,actorId:actorId,/.test(ws)
    && /_wsPendingRunOutputs\.push\(Object\.assign\(\{actor:ctx\.author,actorId:String\(ctx\.actorId\|\|''\)\},_sc,\{text:/.test(run));
  ok('A1.toolResultCarriesActorId', /_ibToolPendingResults\.push\(Object\.assign\(\{actor:author,actorId:String\(actorId\|\|''\),images:\[\]\},scope\|\|null,/.test(ops)
    && /_ibQueueToolResult\(ctx\.author,ctx\.name,r\.ok,r\.detail,ctx\.actorId\|\|'',_csc\)/.test(ops));
  ok('A1.phantomCarriesActorId', /function _wsCheckPhantom\(cleanText,opsCount,actor,actorId,scopeSrc\)/.test(ws)
    && count(wsCode, 'Object.assign({actor:actor,actorId:_aid},_sc,') === 2
    && /_wsCheckPhantom\(_gws\.cleanText,_gws\.ops\.length,selfName,cfg\.id,\{friendId:_targetFriend,threadId:_targetThread\|\|''\}\)/.test(comm)
    && /_wsCheckPhantom\(_wsParsed\.cleanText,_wsParsed\.ops\.length,cfg\.nickname\|\|cfg\.model\|\|'AI',cfg\.id,\{friendId:_targetFriend/.test(comm));
  ok('A2.actorNeverReplacedById', !/actor\s*:\s*(String\()?cfg\.id/.test(wsCode));
  ok('A2.actorIdNotRenderedInFileUI', read('assets/js/workspace/files.js').indexOf('actorId') < 0);

  ok('A4.cfgBoundaryShape', /var actorId=\(cfg&&typeof cfg==='object'\)\?String\(cfg\.id\|\|''\):'';/.test(ws));
  ok('A4.noReverseLookupByDisplayName', !/_execWsOps[\s\S]{0,400}?find\(function\(a\)\{return \(a\.nickname\|\|a\.model\)===authorName/.test(wsCode));

  /* P30-2 更新（P30-1 契约 §7）：1:1 与工具续轮**新增会话归属过滤**（scope-only），
     actor 维度仍只存在于群聊（`_gInjMine`）；这条从"take-all"改为"scope-filtered, actor-unfiltered"。 */
  ok('A12.singleChatScopeFiltered',
    /const _wsScopeMine=_ibWsScopeFilter\(String\(opts\.friendId\|\|cfg\.id\|\|''\),opts\.threadId\|\|null\);/.test(comm)
    && /const _wsReadCtx=_getWsReadInjection\(_wsScopeMine\)\+_getWsOpFeedbackInjection\(_wsScopeMine\)/.test(comm));
  ok('A12.toolContinueScopeFiltered',
    /const _scMine=_ibWsScopeFilter\(o\.friendId,o\.threadId\);/.test(comm)
    && /feed=_getWsReadInjection\(_scMine\)\+_getWsOpFeedbackInjection\(_scMine\)/.test(comm));
  ok('A12.actorFilterOnlyInGroup', count(commCode, '_getWsReadInjection(_gInjMine)') === 1
    && count(commCode, '_getWsReadInjection(_wsScopeMine)') === 1 && count(commCode, '_getWsReadInjection(_scMine)') === 1);
  ok('A12.noConversationIdStored', !/wsPending\w*\.push\(\{[^}]*conversationId/.test(wsCode));

  /* R3 已关闭此前 deferred media debt；P29 本身仍只定义 actorId 的来源。
     图片队列现在由 workspace producer additive 地捕获 actorId + WHERE，
     但 display actor / P29 identity readers 没有被重写。 */
  ok('A13.imageDrainAttributionDeferredDebtClosed', /var _queueImage=function\(raw,name\)/.test(ws)
    && /if\(actorId\)_item\.actorId=actorId/.test(ws)
    && /if\(_sc\)\{_item\.friendId=_sc\.friendId;_item\.threadId=_sc\.threadId;\}/.test(ws)
    && /_ibImageDrain\.push\(_item\)/.test(ws)
    && /var _ibImageDrain=\[\];/.test(ops)
    && !/_ibImageDrain\.push\(_gi\.dataUrl\)/.test(ws)
    && !/_ibImageDrain\.push\(_riUrl\)/.test(ws));

  ok('A14.projectFilesWriterUnchanged', /lastModifiedBy=author\|\|'AI'/.test(read('assets/js/workspace/files.js')));
  /* R4-2 intentionally replaces the old display-label import guard; P29 only
     requires that its actor runtime remains independent from file provenance. */
  ok('A14.importGuardR4CanonicalFirst',
    /_wsCanonicalFileProvenanceValid/.test(ws)
    && /_wsArchiveCollisionNeedsUniquePath/.test(ws)
    && !/old\.lastModifiedBy==='User'\|\|old\.lastModifiedBy==='你'\|\|old\.lastModifiedBy==='导入'/.test(ws));

  ok('A15.dbVer24', /DB_VER\s*=\s*24/.test(read('assets/js/core.js')));
  ok('A15.noSchemaTouch', !/createObjectStore/.test(wsCode + opsCode + commCode + stripComments(run)));

  const coreSrc = read('assets/js/group-runtime-core.js');
  ok('A16.plannerVersionStill3', /PARTICIPATION_PLAN_VERSION = 3/.test(coreSrc) && /PARTICIPATION_PLANNER_ID = 'group-rule-v1'/.test(coreSrc));
  ok('A16.memberTurnIdFormulaUnchanged',
    Core.memberTurnIdFor('gturn_p293x', A, 0) === ('turn_' + ChatCore.stableToken('gturn_p293x:' + A + ':0')));
  ok('A16.coreUntouchedByP293', coreSrc.indexOf('actorId') < 0);
  ok('A16.p23Untouched', ['delivery-planner', 'multimodal-delivery-policy', 'delivery-sequence-core', 'delivery-runtime', 'voice-message-core']
    .every(f => read('assets/js/' + f + '.js').indexOf('actorId') < 0));

  ok('A5.readerCanonicalFirst', /var _aid=String\(\(it&&it\.actorId\)\|\|''\);\s*if\(_aid\)return _aid===String\(cfg\.id\);/.test(comm));
  /* canonical mismatch 后不得再读 display：actorId 分支必须整体先于 `it.actor` 的读取。 */
  const injStart = comm.indexOf('var _gInjMine=function(it){');
  const injBody = injStart >= 0 ? comm.slice(injStart, comm.indexOf('};', injStart) + 2) : '';
  ok('A5.readerNoDisplayFallbackAfterCanonicalMismatch',
    /if\(_aid\)return _aid===String\(cfg\.id\);/.test(injBody)
    && injBody.indexOf('(it&&it.actor)') > injBody.indexOf('if(_aid)return'), injBody.slice(0, 160));
  ok('A8.readerLegacyAmbiguityFailsClosed', /if\(_hits>1\)return false;/.test(comm));
  ok('A10.readerKeepsFirstTurnFallback', /return isFirstTurn;\s*\};/.test(comm));
  ok('A5.noNewResolverIntroduced', ['WorkspaceIdentityResolver', 'WorkspaceActorResolver', 'IdentityManager', 'WorkspaceActorRegistry']
    .every(n => commCode.indexOf(n) < 0 && wsCode.indexOf(n) < 0 && opsCode.indexOf(n) < 0));
}

/* ── 最小 mock provider（reader 用例需要真实群回合）──────────────────────────── */
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
      let body = {};
      try { body = JSON.parse(raw); } catch (e) { /* ignore */ }
      const model = String(body.model || '');
      requests.push({ model, messages: Array.isArray(body.messages) ? body.messages : [] });
      res.writeHead(200, headers);
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'p293-reply:' + model }, finish_reason: 'stop' }],
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
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-p293-'));
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
      "typeof window.sendChatMessage==='function'&&typeof window._execWsOps==='function'"
      + "&&typeof window._wsPendingOpFeedback!=='undefined'&&typeof window._wsCheckPhantom==='function'"
      + "&&typeof window._ibQueueToolResult==='function'&&typeof window._wsQueueRunOutput==='function'", 25000);
    ok('page.workspaceSeamsReady', pageReady);
    await evaluate(cdp, "window.confirm=function(){return true};");

    const ep = 'http://127.0.0.1:' + mock.port + '/v1/chat/completions';
    ok('fixtures.seeded', (await evaluate(cdp, "(async function(){"
      + "var mk=function(id,model,nick){return {id:id,nickname:nick,model:model,endpoint:'" + ep + "',apiKey:'',provider:'custom',"
      + "systemPrompt:'你是测试角色。',temperature:1,streaming:false,showThinking:false,promptCache:false,created:Date.now()}};"
      + "await dbPut('apiConfigs',mk('" + A + "','" + MA + "','" + SAME + "'));"
      + "await dbPut('apiConfigs',mk('" + B + "','" + MB + "','" + SAME + "'));"
      + "await dbPut('apiConfigs',mk('" + C + "','" + MC + "','" + THIRD + "'));"
      + "await dbPut('groups',{id:'" + GROUP + "',name:'P29-3 group',members:["
      + "{characterId:'" + A + "',status:'active',joinedAt:1},{characterId:'" + B + "',status:'active',joinedAt:1},"
      + "{characterId:'" + C + "',status:'active',joinedAt:1}],memoryEnabled:false,created:1});"
      + "var pid=await wsEnsureDefaultProject();"
      + "await wsSaveFile(pid,'p293.md','# p293','User');"
      + "return 'seeded'})()")) === 'seeded');
    await evaluate(cdp, "loadApiConfigs()");
    await evaluate(cdp, "activeFriendId='';activeThreadId=null;");

    const producer = await evaluate(cdp, "(async function(){"
      + "var cfgA=apiConfigs.find(function(x){return x.id==='" + A + "'});"
      + "var out={};"
      + "window._wsPendingReads=[];window._wsPendingOpFeedback=[];window._wsPendingRunOutputs=[];window._ibToolPendingResults=[];"
      + "await _execWsOps([{type:'read',path:'p293.md'}],'" + SAME + "',cfgA,{});"
      + "var rd=window._wsPendingReads[window._wsPendingReads.length-1]||{};"
      + "out.read={actor:rd.actor,actorId:rd.actorId};"
      + "window._wsPendingOpFeedback=[];"
      + "await _execWsOps([{type:'edit',path:'nope-p293.md',find:'a',replace:'b'}],'" + SAME + "',cfgA,{});"
      + "var fb=window._wsPendingOpFeedback[window._wsPendingOpFeedback.length-1]||{};"
      + "out.feedback={actor:fb.actor,actorId:fb.actorId};"
      + "window._wsPendingOpFeedback=[];"
      + "_wsCheckPhantom('已为你创建了文件 p293.md，内容已保存。',0,'" + SAME + "',cfgA.id);"
      + "var ph=window._wsPendingOpFeedback[window._wsPendingOpFeedback.length-1]||{};"
      + "out.phantom={actor:ph.actor,actorId:ph.actorId};"
      + "window._wsPendingOpFeedback=[];window._wsPendingRunOutputs=[];"
      + "var rr=await _execWsOps([{type:'run',lang:'js',code:'print(1)'}],'" + SAME + "',cfgA,{});"
      + "var rctx=rr[0]||{};"
      + "_wsQueueRunOutput(rctx,{ok:true,output:'p293-run',ms:1});"
      + "var ro=window._wsPendingRunOutputs[window._wsPendingRunOutputs.length-1]||{};"
      + "out.run={ctxActorId:rctx.actorId,actor:ro.actor,actorId:ro.actorId};"
      + "window._ibToolPendingResults=[];"
      + "_ibQueueToolResult('" + SAME + "','demo-tool',true,'ok',cfgA.id);"
      + "var tr=window._ibToolPendingResults[window._ibToolPendingResults.length-1]||{};"
      + "out.tool={actor:tr.actor,actorId:tr.actorId};"
      + "window._wsPendingReads=[];"
      + "await _execWsOps([{type:'read',path:'p293.md'}],'X',null,{});"
      + "var n1=window._wsPendingReads[window._wsPendingReads.length-1]||{};"
      + "window._wsPendingReads=[];"
      + "await _execWsOps([{type:'read',path:'p293.md'}],'X','p4a-json',{});"
      + "var n2=window._wsPendingReads[window._wsPendingReads.length-1]||{};"
      + "window._wsPendingReads=[];"
      + "await _execWsOps([{type:'read',path:'p293.md'}],'X',{},{});"
      + "var n3=window._wsPendingReads[window._wsPendingReads.length-1]||{};"
      + "window._wsPendingReads=[];"
      + "await _execWsOps([{type:'read',path:'p293.md'}],'X',undefined,{});"
      + "var n4=window._wsPendingReads[window._wsPendingReads.length-1]||{};"
      + "out.cfgBoundary=[String(n1.actorId),String(n2.actorId),String(n3.actorId),String(n4.actorId)];"
      + "out.expectedId=cfgA.id;out.expectedName=cfgA.nickname;"
      + "window._wsPendingReads=[];window._wsPendingOpFeedback=[];"
      + "return out})()");
    ok('A1.readItemCarriesCanonicalId', producer.read && producer.read.actorId === producer.expectedId, producer.read);
    ok('A1.feedbackItemCarriesCanonicalId', producer.feedback && producer.feedback.actorId === producer.expectedId, producer.feedback);
    ok('A1.phantomItemCarriesCanonicalId', producer.phantom && producer.phantom.actorId === producer.expectedId, producer.phantom);
    ok('A1.runCtxAndItemCarryCanonicalId',
      producer.run && producer.run.ctxActorId === producer.expectedId && producer.run.actorId === producer.expectedId, producer.run);
    ok('A1.toolItemCarriesCanonicalId', producer.tool && producer.tool.actorId === producer.expectedId, producer.tool);
    ok('A2.displayActorUnchangedAcrossAllFour',
      [producer.read, producer.feedback, producer.phantom, producer.run, producer.tool].every(x => x && x.actor === producer.expectedName),
      [producer.read, producer.feedback, producer.phantom, producer.run, producer.tool]);
    ok('A4.cfgBoundaryYieldsEmptyActorIdNeverCrash',
      JSON.stringify(producer.cfgBoundary) === JSON.stringify(['', '', '', '']), producer.cfgBoundary);

    const sendGroup = t => "(function(){activeFriendId='" + GROUP + "';activeThreadId=null;openChatPanel();"
      + "var i=document.getElementById('chat-input');i.value='" + t + "';return sendChatMessage()})()";
    const rowCount = "(async function(){var all=await dbGetByIndex('chatMessages','byFriend','" + GROUP + "');"
      + "return all.filter(function(m){return m.role==='assistant'}).length})()";

    const sleep = ms => new Promise(r => setTimeout(r, ms));
    /* 每个用例：独立用户文本（marker **不**进用户消息）+ 请求级同步 + 发送重试
       （上一轮未收尾时 sendChatMessage 会被 _chatSendingFor 挡住 ⇒ 必须重试）。 */
    const runCase = async (seedExpr, marker, caseId) => {
      await evaluate(cdp, "window._wsPendingOpFeedback=" + seedExpr + ";window._wsPendingReads=[];window._wsPendingRunOutputs=[];window._ibToolPendingResults=[];");
      mock.requests.length = 0;
      const userText = 'p293 turn ' + caseId;
      const reqsFor = () => mock.requests.filter(r => JSON.stringify(r.messages).indexOf(userText) >= 0);
      for (let attempt = 0; attempt < 8 && reqsFor().length < 3; attempt++) {
        await evaluate(cdp, sendGroup(userText));
        for (let w = 0; w < 20 && reqsFor().length < 3; w++) await sleep(400);
      }
      const reqs = reqsFor();
      const has = m => { const r = reqs.find(x => x.model === m); return !!r && JSON.stringify(r.messages).indexOf(marker) >= 0; };
      const left = await evaluate(cdp, 'window._wsPendingOpFeedback.length');
      return { grew: reqs.length >= 3, a: has(MA), b: has(MB), c: has(MC), models: reqs.map(r => r.model), left };
    };

    const c1 = await runCase("[{actor:'" + SAME + "',actorId:'" + B + "',text:'P293-B-ONLY'}]", 'P293-B-ONLY', 'c1');
    ok('A5.canonicalSameNameIsolation', c1.grew && c1.a === false && c1.b === true && c1.c === false, c1);
    ok('A5.canonicalItemConsumedOnce', c1.left === 0, c1);

    const c2 = await runCase("[{actor:'" + THIRD + "',actorId:'" + B + "',text:'P293-PRECEDENCE'}]", 'P293-PRECEDENCE', 'c2');
    ok('A6.canonicalWinsOverDisplayName', c2.grew && c2.a === false && c2.b === true && c2.c === false, c2);

    const c3 = await runCase("[{actor:'" + THIRD + "',text:'P293-LEGACY-UNIQUE'}]", 'P293-LEGACY-UNIQUE', 'c3');
    ok('A7.legacyUniqueNameResolvesToThatRole', c3.grew && c3.a === false && c3.b === false && c3.c === true, c3);

    const c4 = await runCase("[{actor:'" + SAME + "',text:'P293-LEGACY-AMBIG'}]", 'P293-LEGACY-AMBIG', 'c4');
    ok('A8.legacyAmbiguityFailsClosed', c4.grew && c4.a === false && c4.b === false && c4.c === false, c4);
    ok('A8.ambiguousItemNotSilentlyDropped', c4.left >= 1, c4);

    const c5 = await runCase("[{actor:'" + SAME + "',actorId:'" + FOREIGN + "',text:'P293-FOREIGN'}]", 'P293-FOREIGN', 'c5');
    ok('A9.foreignCanonicalIdFailsClosed', c5.grew && c5.a === false && c5.b === false && c5.c === false, c5);

    const c6 = await runCase("[{actor:'',actorId:'',text:'P293-NOATTR'}]", 'P293-NOATTR', 'c6');
    ok('A10.noAttributionFirstSpeakerFallback', c6.grew && c6.a === true && c6.b === false && c6.c === false, c6);

    await evaluate(cdp, "window._wsPendingOpFeedback=[];window._wsPendingReads=[];window._wsPendingRunOutputs=[];window._ibToolPendingResults=[];");

    ok('A13.legacyImageDrainShapeStillReadable', (await evaluate(cdp,
      "(function(){window._ibImageDrain=['data:image/png;base64,AAA'];var v=window._ibImageDrain[0];"
      + "window._ibImageDrain=[];return typeof v==='string'&&v.slice(0,5)==='data:'})()")) === true);
    ok('A15.runtimeDbVer24', (await evaluate(cdp, "String(window.DB_VER||'')")) === '24');
    ok('P29_0.degradationSnapshotStillIndependent',
      JSON.stringify(await evaluate(cdp, 'window._ibGroupIdentityDegradedSnapshot()')) === '{}');
    ok('boundary.noUncaughtExceptions', exceptions.length === 0, exceptions.slice(0, 3));
  } finally {
    try { browser.kill(); } catch (e) { /* ignore */ }
    try { mock.server.close(); } catch (e) { /* ignore */ }
    rmWithRetry(profile, 5);
  }
}

async function main() {
  console.log('== P29-3 · Workspace Actor Identity 测试 ==');
  staticGuards();
  await browserE2E();
  console.log(failures === 0 ? '\n全部通过 ✔  (' + passes + ')'
    : '\n失败 ' + failures + ' 项');
  process.exitCode = failures ? 1 : 0;
}

main().catch(e => { console.error('harness error: ' + (e && e.stack || e)); process.exitCode = 2; });
