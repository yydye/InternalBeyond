'use strict';

/* Internal Beyond · P30-5 · Blog Conversation Scope
   （browser 组：源码守卫 + 真实 producer/consumer 差分 probe；运行：
     node tests/test_blog_conversation_scope.js）

   P30-4 冻结契约：request-origin scope 捕获于 request 创建时 → `_blogReqReg[uid]` →
   Allow/Deny 继承 registry scope → 两个队列各自 scope filter（MATCH TAKE / MISMATCH KEEP）→
   legacy string 兼容；自动续答只在 origin 仍是活动会话时保留。

   覆盖 C1–C16。 */

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
const A = 'friend_p305_a', B = 'friend_p305_b';
const MA = 'p305-model-a', MB = 'p305-model-b';
const THX = 'thread_p305_x', THY = 'thread_p305_y';

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

/* ── 源码守卫（C8/C9/C15/C16 + 契约形状）────────────────────────────────────── */
function staticGuards() {
  const ws = read('assets/js/workspace.js');
  const wsCode = stripComments(ws);
  const comm = read('assets/js/communication.js');

  /* request-origin 捕获：producer 接收 scopeSrc 并把它写进 registry / feedback */
  ok('S.requestOriginSignature', /async function _execBlogReadOps\(ops,scopeSrc\)\{/.test(ws));
  ok('S.requestOriginNormalizedOnce', /var _bsc=_wsScopeFragment\(scopeSrc\);/.test(ws));
  ok('S.registryStoresScope', /_blogReqReg\[uid\]=Object\.assign\(\{state:'pending'/.test(ws) && /,_bsc\);/.test(ws));
  /* 三条 immediate feedback（from 越界 / 多篇 / 不存在）各自带 `,_bsc)` */
  ok('S.immediateFeedbackScoped', /超出范围'\},_bsc\)\);/.test(ws)
    && /重新申请'\},_bsc\)\);/.test(ws)
    && /确认名称'\},_bsc\)\);/.test(ws));

  /* allow/deny 从 registry 继承，不用 click-time active */
  ok('S.allowInheritsRegistry', /var _rsc=_wsScopeFragment\(req\);/.test(ws)
    && /_blogPendingReads\.push\(Object\.assign\(\{title:p\.title\|\|req\.title,content:seg,range:range,total:full\.length\},_rsc\)\)/.test(ws));
  ok('S.denyInheritsRegistry', /_blogReadFeedback\.push\(Object\.assign\(\{text:'用户拒绝了阅读/.test(ws) && /_wsScopeFragment\(req\)\)\);/.test(ws));
  ok('S.noClickTimeScopeAsOwnership', !/_blogPendingReads\.push\(\{[^}]*friendId:activeFriendId/.test(wsCode));

  /* consumer：scope filter + take/keep + legacy string */
  ok('S.injectionAcceptsFilter', /function _getBlogReadInjection\(scopeFilter\)\{/.test(ws));
  ok('S.injectionTakeKeep', /_blogPendingReads=_p\.keep;/.test(ws) && /_blogReadFeedback=_f\.keep;/.test(ws));
  /* 只允许声明处的 `var X=[];`；消费路径不得再出现无条件清空。 */
  ok('S.noUnconditionalClearAll', !(/(?<!var )_blogPendingReads=\[\];/.test(wsCode))
    && !(/(?<!var )_blogReadFeedback=\[\];/.test(wsCode)));
  ok('S.legacyStringRendered', /\(typeof f==='string'\)\?f:String\(\(f&&f\.text\)\|\|''\)/.test(ws));
  ok('S.consumerCallSitesFiltered',
    /_getBlogReadInjection\(_wsScopeMine\)/.test(comm) && /_getBlogReadInjection\(_scMine\)/.test(comm)
    && (comm.match(/_getBlogReadInjection\(\)/g) || []).length === 0);
  ok('S.producerCallSitesPassOrigin',
    (comm.match(/_execBlogReadOps\(_bp\.ops,\{friendId:_targetFriend,threadId:_targetThread\}\)/g) || []).length === 1
    && (comm.match(/_execBlogReadOps\(_bpn\.ops,\{friendId:_targetFriend,threadId:_targetThread\}\)/g) || []).length === 1);
  ok('S.autoContinuationUsesCanonicalCompare',
    /window\._ibWsScopeFilter\(activeFriendId,activeThreadId\)/.test(ws)
    && /if\(!_sameConv\)return;/.test(ws)
    && !/friendId===activeFriendId/.test(wsCode));

  ok('S.noNewArchitecture', ['BlogManager', 'ConversationManager', 'ScopeManager', 'QueueManager', 'EventBus']
    .every(n => wsCode.indexOf(n) < 0 && stripComments(comm).indexOf(n) < 0));
  ok('S.dbVer24', require('./helpers/db-schema-authority.js').isVersion('InternalBeyondDB', 24));
  ok('S.noSchemaTouch', !/createObjectStore/.test(wsCode));

  /* C16 · P24 未触碰 */
  const coreSrc = read('assets/js/group-runtime-core.js');
  ok('C16.p24Untouched', /PARTICIPATION_PLAN_VERSION = 3/.test(coreSrc)
    && /PARTICIPATION_PLANNER_ID = 'group-rule-v1'/.test(coreSrc)
    && coreSrc.indexOf('blog') < 0
    && Core.memberTurnIdFor('gturn_p305x', A, 0) === ('turn_' + ChatCore.stableToken('gturn_p305x:' + A + ':0')));
}

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
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'p305:' + body.model }, finish_reason: 'stop' }],
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
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-p305-'));
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
      "typeof window._execBlogReadOps==='function'&&typeof window._getBlogReadInjection==='function'"
      + "&&typeof window._brAllow==='function'&&typeof window._brDeny==='function'"
      + "&&typeof window.sendChatMessage==='function'&&typeof window._ibWsScopeFilter==='function'", 25000);
    ok('page.blogSeamsReady', pageReady);
    await evaluate(cdp, "window.confirm=function(){return true};");

    const ep = 'http://127.0.0.1:' + mock.port + '/v1/chat/completions';
    ok('fixtures.seeded', (await evaluate(cdp, "(async function(){"
      + "var mk=function(id,model,nick){return {id:id,nickname:nick,model:model,endpoint:'" + ep + "',apiKey:'',provider:'custom',vision:true,"
      + "systemPrompt:'x',temperature:1,streaming:false,showThinking:false,promptCache:false,created:Date.now()}};"
      + "await dbPut('apiConfigs',mk('" + A + "','" + MA + "','角色A'));await dbPut('apiConfigs',mk('" + B + "','" + MB + "','角色B'));"
      + "await dbPut('chatThreads',{id:'" + THX + "',friendId:'" + B + "',name:'X',created:1});"
      + "await dbPut('chatThreads',{id:'" + THY + "',friendId:'" + B + "',name:'Y',created:2});"
      + "await dbPut('posts',{id:'p305_u',title:'唯一标题',content:'P305-UNIQUE-CONTENT-0123456789',created:Date.now()});"
      + "await dbPut('posts',{id:'p305_d1',title:'重复标题',content:'D1',created:Date.now()});"
      + "await dbPut('posts',{id:'p305_d2',title:'重复标题',content:'D2',created:Date.now()});"
      + "return 'seeded'})()")) === 'seeded');
    await evaluate(cdp, 'loadApiConfigs()');
    await evaluate(cdp, "window._blogReqReg={};window._blogPendingReads=[];window._blogReadFeedback=[];");

    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const reqsFor = t => mock.requests.filter(r => JSON.stringify(r.messages).indexOf(t) >= 0);
    const turn = async (friend, text, thread, expectN) => {
      mock.requests.length = 0;
      for (let a = 0; a < 8 && reqsFor(text).length < expectN; a++) {
        await evaluate(cdp, "(function(){activeFriendId='" + friend + "';activeThreadId=" + (thread ? "'" + thread + "'" : 'null') + ";openChatPanel();"
          + "var i=document.getElementById('chat-input');i.value='" + text + "';sendChatMessage();return true})()");
        for (let w = 0; w < 20 && reqsFor(text).length < expectN; w++) await sleep(400);
      }
      return reqsFor(text);
    };
    const saw = (reqs, model, marker) => { const r = reqs.find(x => x.model === model); return !!r && JSON.stringify(r.messages).indexOf(marker) >= 0; };

    /* ── C6/C7/C8：immediate feedback 全部带 request-origin scope ── */
    const fb = await evaluate(cdp, "(async function(){"
      + "window._blogReqReg={};window._blogPendingReads=[];window._blogReadFeedback=[];"
      + "var scope={friendId:'" + A + "',threadId:null};"
      + "await _execBlogReadOps([{name:'不存在的日志'}],scope);"          /* F3 not found */
      + "var notfound=window._blogReadFeedback.shift();"
      + "await _execBlogReadOps([{name:'重复标题'}],scope);"              /* F4 multi */
      + "var multi=window._blogReadFeedback.shift();"
      + "await _execBlogReadOps([{name:'唯一标题',from:999,chars:0}],scope);" /* F5 invalid range */
      + "var range=window._blogReadFeedback.shift();"
      + "return {notfound:notfound,multi:multi,range:range}})()");
    ok('C7.notFoundFeedbackScoped', fb.notfound && fb.notfound.friendId === A && typeof fb.notfound.text === 'string', fb.notfound);
    ok('C6.multiMatchFeedbackScoped', fb.multi && fb.multi.friendId === A && /匹配到多篇/.test(fb.multi.text || ''), fb.multi);
    ok('C8.invalidRangeFeedbackScoped', fb.range && fb.range.friendId === A && /超出范围/.test(fb.range.text || ''), fb.range);
    ok('C3.allFeedbackObjectShape', [fb.notfound, fb.multi, fb.range].every(x => x && typeof x === 'object' && !Array.isArray(x) && 'text' in x));

    /* ── C1/C10：A request → 切 B → Allow ⇒ 归 A；origin 非活动 ⇒ 抑制自动续答 ── */
    const allowNotActive = await evaluate(cdp, "(async function(){"
      + "window._blogReqReg={};window._blogPendingReads=[];window._blogReadFeedback=[];"
      + "await _execBlogReadOps([{name:'唯一标题'}],{friendId:'" + A + "',threadId:null});"
      + "var uid=Object.keys(_blogReqReg)[0];"
      + "var regScope={friendId:_blogReqReg[uid].friendId,threadId:_blogReqReg[uid].threadId};"
      + "activeFriendId='" + B + "';activeThreadId=null;"                                  /* 切到 B */
      + "var calls=0;var _orig=window.sendChatMessage;window.sendChatMessage=function(){calls++};"
      + "await _brAllow(uid);"
      + "window.sendChatMessage=_orig;"
      + "return {regScope:regScope,calls:calls,pending:(window._blogPendingReads[0]||null)}})()");
    ok('C1.registryCapturedOriginScope', allowNotActive.regScope && allowNotActive.regScope.friendId === A, allowNotActive.regScope);
    ok('C1.pendingReadInheritsOriginScope', allowNotActive.pending && allowNotActive.pending.friendId === A, allowNotActive.pending);
    ok('C10.autoContinuationSuppressedWhenOriginNotActive', allowNotActive.calls === 0, allowNotActive.calls);
    ok('C1.queueHoldsScopedItem', (await evaluate(cdp, 'window._blogPendingReads.length')) === 1);

    let reqsA = await turn(B, 'p305 to B #1', null, 1);
    ok('C1.B_cannotSee', !saw(reqsA, MB, 'P305-UNIQUE-CONTENT-0123456789'), reqsA.map(r => r.model));
    ok('C4.wrongConsumerKeepsQueue', (await evaluate(cdp, 'window._blogPendingReads.length')) === 1, await evaluate(cdp, 'window._blogPendingReads.length'));
    await turn(B, 'p305 to B #2', null, 1);
    ok('C4.repeatedWrongConsumerKeepsQueue', (await evaluate(cdp, 'window._blogPendingReads.length')) === 1, await evaluate(cdp, 'window._blogPendingReads.length'));

    const reqsA2 = await turn(A, 'p305 to A', null, 1);
    ok('C5.ownerConversationSeesItem', saw(reqsA2, MA, 'P305-UNIQUE-CONTENT-0123456789'), reqsA2.map(r => r.model));
    ok('C5.ownerConsumptionRemovesItem', (await evaluate(cdp, 'window._blogPendingReads.length')) === 0);

    /* ── C2：A request → 切 B → Deny ⇒ feedback 归 A ── */
    const denyCase = await evaluate(cdp, "(async function(){"
      + "window._blogReqReg={};window._blogPendingReads=[];window._blogReadFeedback=[];"
      + "await _execBlogReadOps([{name:'唯一标题'}],{friendId:'" + A + "',threadId:null});"
      + "var uid=Object.keys(_blogReqReg)[0];"
      + "activeFriendId='" + B + "';activeThreadId=null;"
      + "_brDeny(uid);"
      + "var f=window._blogReadFeedback[0]||null;"
      + "return {scope:f&&f.friendId,text:f&&f.text}})()");
    ok('C2.denyFeedbackBelongsToOrigin', denyCase.scope === A && /拒绝了阅读/.test(denyCase.text || ''), denyCase);
    const reqsBdeny = await turn(B, 'p305 deny to B', null, 1);
    ok('C2.B_cannotSeeDenyFeedback', !saw(reqsBdeny, MB, '拒绝了阅读'), reqsBdeny.map(r => r.model));
    const reqsAdeny = await turn(A, 'p305 deny to A', null, 1);
    ok('C2.A_seesDenyFeedback', saw(reqsAdeny, MA, '拒绝了阅读'), reqsAdeny.map(r => r.model));

    /* ── C3：同 actor 不同 thread（B/X request → B/Y allow）── */
    const threadCase = await evaluate(cdp, "(async function(){"
      + "window._blogReqReg={};window._blogPendingReads=[];window._blogReadFeedback=[];"
      + "await _execBlogReadOps([{name:'唯一标题'}],{friendId:'" + B + "',threadId:'" + THX + "'});"
      + "var uid=Object.keys(_blogReqReg)[0];"
      + "activeFriendId='" + B + "';activeThreadId='" + THY + "';"          /* 切到同角色的另一个 thread */
      + "var calls=0;var _orig=window.sendChatMessage;window.sendChatMessage=function(){calls++};"
      + "await _brAllow(uid);window.sendChatMessage=_orig;"
      + "return {pending:(window._blogPendingReads[0]||null),calls:calls}})()");
    ok('C3.itemScopedToOriginThread', threadCase.pending && threadCase.pending.friendId === B && threadCase.pending.threadId === THX, threadCase.pending);
    ok('C3.autoContinuationSuppressedForOtherThread', threadCase.calls === 0, threadCase.calls);
    const reqsY = await turn(B, 'p305 to B/Y', THY, 1);
    ok('C3.otherThreadCannotSee', !saw(reqsY, MB, 'P305-UNIQUE-CONTENT-0123456789'), reqsY.map(r => r.model));
    ok('C3.otherThreadKeepsQueue', (await evaluate(cdp, 'window._blogPendingReads.length')) === 1);
    const reqsX = await turn(B, 'p305 to B/X', THX, 1);
    ok('C3.originThreadSees', saw(reqsX, MB, 'P305-UNIQUE-CONTENT-0123456789'), reqsX.map(r => r.model));
    ok('C3.originThreadConsumes', (await evaluate(cdp, 'window._blogPendingReads.length')) === 0);

    /* ── C9：legacy string feedback 兼容 ── */
    await evaluate(cdp, "window._blogPendingReads=[];window._blogReadFeedback=['P305-LEGACY-STRING']");
    const reqsLegacy = await turn(A, 'p305 legacy to A', null, 1);
    ok('C9.legacyStringConsumable', saw(reqsLegacy, MA, 'P305-LEGACY-STRING'), reqsLegacy.map(r => r.model));
    ok('C9.noObjectObject', !reqsLegacy.some(r => JSON.stringify(r.messages).indexOf('[object Object]') >= 0));
    ok('C9.legacyConsumed', (await evaluate(cdp, 'window._blogReadFeedback.length')) === 0);

    /* ── C10（后半）：origin 仍是活动会话 ⇒ 保留既有自动续答 ── */
    const allowActive = await evaluate(cdp, "(async function(){"
      + "window._blogReqReg={};window._blogPendingReads=[];window._blogReadFeedback=[];"
      + "activeFriendId='" + A + "';activeThreadId=null;"
      + "await _execBlogReadOps([{name:'唯一标题'}],{friendId:'" + A + "',threadId:null});"
      + "var uid=Object.keys(_blogReqReg)[0];"
      + "var calls=0;var _orig=window.sendChatMessage;window.sendChatMessage=function(){calls++};"
      + "await _brAllow(uid);window.sendChatMessage=_orig;"
      + "return {calls:calls,pending:window._blogPendingReads.length}})()");
    ok('C10.autoContinuationPreservedWhenOriginActive', allowActive.calls === 1, allowActive);

    /* ── C11：两队列独立过滤（A 的 read 命中不得清空 B 的 feedback）── */
    const indep = await evaluate(cdp, "(function(){"
      + "window._blogPendingReads=[{title:'t',content:'A-READ',range:null,total:6,friendId:'" + A + "',threadId:null}];"
      + "window._blogReadFeedback=[{text:'B-FEEDBACK',friendId:'" + B + "',threadId:null}];"
      + "var ctx=_getBlogReadInjection(_ibWsScopeFilter('" + A + "',null));"
      + "return {ctx:ctx,reads:window._blogPendingReads.length,feedback:window._blogReadFeedback.length}})()");
    ok('C11.queuesFilteredIndependently', /A-READ/.test(indep.ctx) && !/B-FEEDBACK/.test(indep.ctx)
      && indep.reads === 0 && indep.feedback === 1, indep);

    /* ── C12：FIFO（matching 与 nonmatching 相对顺序都不变）── */
    const fifo = await evaluate(cdp, "(function(){"
      + "window._blogPendingReads=["
      + "{title:'a1',content:'A1',range:null,total:2,friendId:'" + A + "',threadId:null},"
      + "{title:'b1',content:'B1',range:null,total:2,friendId:'" + B + "',threadId:null},"
      + "{title:'a2',content:'A2',range:null,total:2,friendId:'" + A + "',threadId:null}];"
      + "window._blogReadFeedback=[];"
      + "var ctx=_getBlogReadInjection(_ibWsScopeFilter('" + A + "',null));"
      + "return {ctx:ctx,kept:window._blogPendingReads.map(function(r){return r.content}),order:ctx.indexOf('A1')<ctx.indexOf('A2')}})()");
    ok('C12.fifoPreserved', fifo.order === true && JSON.stringify(fifo.kept) === JSON.stringify(['B1']), fifo);

    /* ── C15：DB_VER 运行期 ── */
    ok('C15.runtimeDbVer24', (await evaluate(cdp, "String(window.DB_VER||'')")) === '24');
    await evaluate(cdp, "window._blogReqReg={};window._blogPendingReads=[];window._blogReadFeedback=[];");
    ok('boundary.noUncaughtExceptions', exceptions.length === 0, exceptions.slice(0, 3));
  } finally {
    try { browser.kill(); } catch (e) { /* ignore */ }
    try { mock.server.close(); } catch (e) { /* ignore */ }
    rmWithRetry(profile, 5);
  }
}

async function main() {
  console.log('== P30-5 · Blog Conversation Scope 测试 ==');
  staticGuards();
  await browserE2E();
  console.log(failures === 0 ? '\n全部通过 ✔  (' + passes + ')'
    : '\n失败 ' + failures + ' 项');
  process.exitCode = failures ? 1 : 0;
}

main().catch(e => { console.error('harness error: ' + (e && e.stack || e)); process.exitCode = 2; });
