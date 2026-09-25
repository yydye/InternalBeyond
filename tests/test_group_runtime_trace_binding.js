'use strict';

/* Internal Beyond · P24-M1.1 · Group Runtime trace binding regression
   （browser 组：真实 Chrome/Edge + 真实页面 + 真实 sendChatMessage；先用纯文本断言做
     快速定位，再跑真实群聊。运行：node tests/test_group_runtime_trace_binding.js）

   这个回归存在的理由（真实缺陷，HEAD 即存在，此前没有任何测试抓到）：
     `sendChatMessage` 的群聊循环引用的是**裸标识符** `_mbTrace`，而函数里唯一的
     `var _mbTrace=(window.IB&&window.IB.__mbTrace)||null;` 声明在**单聊分支**
     （同一函数作用域 → var 提升 ⇒ 群聊侧是 undefined）→ `_mbTrace.begin('group',…)`
     必然抛 TypeError → 被成员级 catch 吞掉 ⇒ assistant message = 0，
     真实群聊一个成员回合都完不成。它没有被现有测试抓到，因为 p11_2f / p11_2h 是
     离线沙箱断言，永远不会执行真实群聊回合。

   覆盖（用户给定 A–F）：
     A IB.__mbTrace 存在        → 群聊成员回合可执行，回复落库
     B IB.__mbTrace 缺失/null   → 群聊仍然执行，不抛异常
     C 真实群聊至少产生 assistant canonical message
     D M1 identity metadata 存在（groupTurnId / speakerId / groupOrder / turnId / sequenceIndex）
     E 单聊路径无变化（单聊消息不带群身份；单聊 trace 调用点逐字不变）
     F trace 不是 chat authority：trace 缺席 / trace 自身抛错，都不能阻止 canonical 回复

   硬边界（本阶段不改）：不重构 sendChatMessage、不移动 trace 初始化、不改 Middle Brain
   trace core / `_mbGroupTraceContext`、不新增 trace key 或第二套 trace。 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const assert = require('assert/strict');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

/* 复用既有 CDP harness（与 test_context_convergence_c1.js 同一做法）：
   它提供 chromePath / Cdp / evaluate / waitFor / freePort，绝不复制第二套客户端。 */
const harness = fs.readFileSync(path.join(__dirname, 'test_chat_smoke.js'), 'utf8');
const boundary = harness.indexOf('async function main() {');
assert.ok(boundary > 0, 'existing CDP harness boundary changed');
const { chromePath, Cdp, evaluate, waitFor, freePort } = new Function('require', '__dirname',
  harness.slice(0, boundary) + '\nreturn {chromePath,Cdp,evaluate,waitFor,freePort};')(require, __dirname);

const PAGE_URL = 'file:///' + path.join(ROOT, 'InternalBeyond.html').replace(/\\/g, '/');
const GROUP_ID = 'group_1700000000000';
const FRIEND_1 = 'friend_m11_g1';
const FRIEND_2 = 'friend_m11_g2';
const MOCK_REPLY = 'trace binding mock reply';

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log('  PASS  ' + name);
  else { failures++; console.error('  FAIL  ' + name + (detail !== undefined ? '  -> ' + JSON.stringify(detail).slice(0, 320) : '')); }
}
function stripComments(src) {
  return String(src).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}
/* Windows 上 Chrome 退出后仍可能短暂持有 profile 文件 → 有限重试，避免把临时目录
   留在 %TEMP%（不是断言，只是卫生）。 */
function rmWithRetry(dir, tries) {
  for (let i = 0; i < (tries || 5); i++) {
    try { fs.rmSync(dir, { recursive: true, force: true }); return true; } catch (e) { /* retry */ }
    const end = Date.now() + 200;
    while (Date.now() < end) { /* busy-wait 200ms：本测试是 CLI 进程，保持简单 */ }
  }
  return false;
}

/* ── 快速定位层：可执行代码上的结构断言（无浏览器）──────────────────────── */
function sourceGuards() {
  const COM = read('assets/js/communication.js');
  const code = stripComments(COM);
  /* P24-M3.2：群聊循环已改为遍历 planner 的 plan.entries（参与权威迁移）。 */
  /* P24-M3.5.2A 更新：成员循环头改为 queue 驱动（for(;;) + runtime/static 双分支），
     循环起点以游标变量 `_gRtCursor` 为锚；trace begin/context 仍必须在其之后。 */
  const loopIdx = COM.indexOf('_gRtCursor');
  const beginIdx = COM.indexOf("_mbTrace.begin('group',cfg.id)");
  const ctxIdx = COM.indexOf('_mbGroupTraceContext(_targetFriend,cfg.id,memberCfgs,selfName)');
  check('src.groupBeginCallExists', beginIdx > 0);
  check('src.loopBeforeBeginBeforeContext', loopIdx > 0 && loopIdx < beginIdx && beginIdx < ctxIdx,
    { loopIdx, beginIdx, ctxIdx });

  /* 群聊分支：所有 `_mbTrace` 使用只能是 ①runtime binding ②null/throw-safe 的 begin */
  const groupSlice = stripComments(COM.slice(COM.indexOf('if(isGroup){'), COM.indexOf('/* ===== NORMAL 1-ON-1 CHAT ===== */')));
  const traceLines = groupSlice.split('\n').map(l => l.trim()).filter(l => /_mbTrace/.test(l));
  check('src.groupTraceUsesExactlyBindingAndGuardedBegin', traceLines.length === 2, traceLines);
  check('src.groupBindingIsSameVarIdiom',
    !!traceLines[0] && traceLines[0] === 'var _mbTrace=(window.IB&&window.IB.__mbTrace)||null;', traceLines[0]);
  check('src.groupBeginIsNullSafeAndThrowSafe',
    !!traceLines[1] && traceLines[1] === "if(_mbTrace){try{_mbTrace.begin('group',cfg.id)}catch(e){}}", traceLines[1]);
  check('src.groupBindingPrecedesFirstUse',
    groupSlice.indexOf('var _mbTrace=') >= 0 && groupSlice.indexOf('var _mbTrace=') < groupSlice.indexOf("_mbTrace.begin('group',cfg.id)"));

  /* 只有一个 trace sink 来源：所有 `_mbTrace` 声明都必须来自 IB.__mbTrace 的同一表达式 */
  const decls = (code.match(/(?:var|let|const)\s+_mbTrace\s*=\s*[^\n]*/g) || []).map(s => s.trim());
  check('src.allTraceBindingsUseSingleSink',
    decls.length >= 2 && decls.every(d => d === 'var _mbTrace=(window.IB&&window.IB.__mbTrace)||null;'), decls);

  /* 单聊路径逐字不变（binding + begin 两行都必须还在） */
  check('src.singleChatBindingUnchanged',
    COM.indexOf('var _mbTrace=(window.IB&&window.IB.__mbTrace)||null;', beginIdx) > beginIdx);
  check('src.singleChatBeginUnchanged', /if\(_mbTrace\)_mbTrace\.begin\('chat',cfg\.id\);/.test(COM));
}

/* ── 真实浏览器：群聊在三种 trace 条件下都必须产出 canonical 回复 ───────── */
function startMock() {
  const seen = { requests: 0 };
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
      seen.requests++;
      res.writeHead(200, headers);
      res.end(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: MOCK_REPLY }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 9, completion_tokens: 4, total_tokens: 13 }
      }));
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, seen })));
}

async function main() {
  console.log('== P24-M1.1 · Group Runtime trace binding regression ==');
  sourceGuards();

  const chrome = chromePath();
  check('browser.binaryFound', !!chrome, chrome);
  if (!chrome) { return finish(); }
  const mock = await startMock();
  const port = await freePort();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-m11-trace-'));
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
    check('page.chatReady', await waitFor(cdp, "typeof window.sendChatMessage==='function' && typeof window.apiConfigs!=='undefined'", 25000));
    /* middle-brain.js 在 communication.js 之后加载：这里必须等，不能只测一次（实测抖动）。 */
    check('page.traceSinkPresentByDefault', await waitFor(cdp, "!!(window.IB&&window.IB.__mbTrace&&typeof window.IB.__mbTrace.begin==='function')", 10000));
    await evaluate(cdp, "window.confirm=function(){return true};");

    const ep = 'http://127.0.0.1:' + mock.port + '/v1/chat/completions';
    await evaluate(cdp, "(function(){var mk=function(id,nick){return {id:id,nickname:nick,model:'m-'+id,endpoint:'" + ep + "',apiKey:'',provider:'custom',systemPrompt:'你是测试角色。',temperature:1,streaming:false,showThinking:false,promptCache:false,created:Date.now()}};dbPut('apiConfigs',mk('" + FRIEND_1 + "','M11-G1'));dbPut('apiConfigs',mk('" + FRIEND_2 + "','M11-G2'));return dbPut('groups',{id:'" + GROUP_ID + "',name:'M11 Group',members:[{characterId:'" + FRIEND_1 + "',status:'active',joinedAt:1},{characterId:'" + FRIEND_2 + "',status:'active',joinedAt:1}],memoryEnabled:false,created:1});})()");
    await evaluate(cdp, "loadApiConfigs()");
    check('fixtures.ready', await evaluate(cdp, "apiConfigs.length>=2 && apiConfigs.some(function(a){return a.id==='" + FRIEND_1 + "'})"));
    /* 成员级 catch 会把异常交给 IBERR.report —— 挂钩子把被吞掉的异常也抓出来 */
    await evaluate(cdp, "(function(){window.__m11Errs=[];var o=window.IBERR&&window.IBERR.report;if(o&&!window.__m11Hooked){window.__m11Hooked=true;window.IBERR.report=function(e){try{window.__m11Errs.push(String((e&&e.stack)||e))}catch(x){};return o.apply(this,arguments)}}})()");

    const groupSend = "(function(){activeFriendId='" + GROUP_ID + "';activeThreadId=null;openChatPanel();var i=document.getElementById('chat-input');i.value='M11 probe '+Date.now();return sendChatMessage()})()";
    const groupRowsExpr = "(async function(){var all=await dbGetByIndex('chatMessages','byFriend','" + GROUP_ID + "');return all.filter(function(m){return m.role==='assistant'}).map(function(m){return {id:m.id,content:m.content,md:m.metadata||{},senderName:m.senderName}})})()";

    /* ── A · sink 存在 ── */
    await evaluate(cdp, groupSend);
    check('A.groupRepliesWithSinkPresent', await waitFor(cdp, "(async function(){var all=await dbGetByIndex('chatMessages','byFriend','" + GROUP_ID + "');return all.filter(function(m){return m.role==='assistant'}).length>=2;})()", 25000));
    const aRows = await evaluate(cdp, groupRowsExpr);
    check('A.noTraceTypeError', !(await evaluate(cdp, 'window.__m11Errs||[]')).some(e => /reading 'begin'/.test(e)),
      (await evaluate(cdp, 'window.__m11Errs||[]')).slice(0, 2));

    /* ── D · M1 identity metadata ── */
    const aTurn = aRows.length ? aRows[aRows.length - 1].md.groupTurnId : null;
    const turnRows = aRows.filter(r => r.md.groupTurnId === aTurn);
    check('D.groupTurnIdPresent', !!aTurn && turnRows.length >= 2, { aTurn, n: turnRows.length });
    check('D.speakerIdIsApiConfigId',
      turnRows.length >= 2 && turnRows.every(r => r.md.speakerId === FRIEND_1 || r.md.speakerId === FRIEND_2),
      turnRows.map(r => r.md.speakerId));
    check('D.groupOrderZeroBased',
      turnRows.length >= 2 && turnRows.every(r => typeof r.md.groupOrder === 'number')
      && turnRows.map(r => r.md.groupOrder).sort().join(',') === turnRows.map((_, i) => i).join(','),
      turnRows.map(r => r.md.groupOrder));
    check('D.turnIdAndSequenceIndexPresent',
      turnRows.length >= 2 && turnRows.every(r => /^turn_/.test(String(r.md.turnId)) && r.md.sequenceIndex === 0),
      turnRows.map(r => [r.md.turnId, r.md.sequenceIndex]));
    check('D.turnIdsDistinctPerMember', new Set(turnRows.map(r => r.md.turnId)).size === turnRows.length);
    check('D.turnIdIsNotGroupTurnId', turnRows.every(r => r.md.turnId !== r.md.groupTurnId));

    /* ── A2 · sink 存在时 trace **仍然真的被使用**（修复不能把 trace 变成空转）── */
    await evaluate(cdp, "(function(){window.__m11Trace={begins:[],notes:0,finishes:0};window.IB.__mbTrace={on:function(){return true},begin:function(c,id){window.__m11Trace.begins.push(String(c)+':'+String(id))},note:function(){window.__m11Trace.notes++},finish:function(){window.__m11Trace.finishes++}};return true})()");
    const beforeA2 = (await evaluate(cdp, groupRowsExpr)).length;
    await evaluate(cdp, groupSend);
    check('A2.repliesLandedWithCountingSink', await waitFor(cdp, "(async function(){var all=await dbGetByIndex('chatMessages','byFriend','" + GROUP_ID + "');return all.filter(function(m){return m.role==='assistant'}).length>=" + (beforeA2 + 2) + ";})()", 25000));
    const traced = await evaluate(cdp, 'window.__m11Trace');
    check('A2.groupBeginCalledPerMember', (traced.begins || []).filter(x => x.indexOf('group:') === 0).length === 2, traced.begins);
    check('A2.groupFinishCalledPerMember', (traced.finishes || 0) >= 2, traced.finishes);
    check('A2.groupTraceFieldsWritten', (traced.notes || 0) >= 2, traced.notes);

    /* ── B/F · sink 缺失 ── */
    await evaluate(cdp, "(function(){window.__m11Saved=window.IB.__mbTrace;window.IB.__mbTrace=null;return window.IB.__mbTrace===null})()");
    const beforeB = (await evaluate(cdp, groupRowsExpr)).length;
    await evaluate(cdp, groupSend);
    check('B.groupRepliesWithSinkAbsent', await waitFor(cdp, "(async function(){var all=await dbGetByIndex('chatMessages','byFriend','" + GROUP_ID + "');return all.filter(function(m){return m.role==='assistant'}).length>=" + (beforeB + 2) + ";})()", 25000));
    check('F.sinkAbsenceDoesNotBlockIdentity', await evaluate(cdp, "(async function(){var all=await dbGetByIndex('chatMessages','byFriend','" + GROUP_ID + "');var bots=all.filter(function(m){return m.role==='assistant'&&m.metadata&&m.metadata.groupTurnId});var last=bots[bots.length-1];return !!last&&!!last.metadata.groupTurnId&&!!last.metadata.speakerId&&typeof last.metadata.groupOrder==='number';})()"));

    /* ── F · sink 自身抛错 ── */
    await evaluate(cdp, "(function(){window.IB.__mbTrace={on:function(){return true},begin:function(){throw new Error('trace-boom')},note:function(){throw new Error('trace-boom')},finish:function(){throw new Error('trace-boom')}};return true})()");
    const beforeF = (await evaluate(cdp, groupRowsExpr)).length;
    await evaluate(cdp, groupSend);
    check('F.throwingTraceDoesNotBlockReply', await waitFor(cdp, "(async function(){var all=await dbGetByIndex('chatMessages','byFriend','" + GROUP_ID + "');return all.filter(function(m){return m.role==='assistant'}).length>=" + (beforeF + 2) + ";})()", 25000));
    check('F.identityStillLandsWithThrowingTrace', await evaluate(cdp, "(async function(){var all=await dbGetByIndex('chatMessages','byFriend','" + GROUP_ID + "');var bots=all.filter(function(m){return m.role==='assistant'});var last=bots[bots.length-1];return !!last&&!!last.metadata&&/^gturn_/.test(String(last.metadata.groupTurnId))&&/^turn_/.test(String(last.metadata.turnId));})()"));
    await evaluate(cdp, "(function(){window.IB.__mbTrace=window.__m11Saved||null;return true})()");

    /* ── E · 单聊路径无变化 ── */
    await evaluate(cdp, "(function(){activeFriendId='" + FRIEND_1 + "';activeThreadId=null;openChatPanel();var i=document.getElementById('chat-input');i.value='M11 single probe';return sendChatMessage()})()");
    check('E.singleReplyLands', await waitFor(cdp, "(async function(){var all=await dbGetByIndex('chatMessages','byFriend','" + FRIEND_1 + "');return all.filter(function(m){return m.role==='assistant'}).length>=1;})()", 25000));
    const single = await evaluate(cdp, "(async function(){var all=await dbGetByIndex('chatMessages','byFriend','" + FRIEND_1 + "');return all.filter(function(m){return m.role==='assistant'}).map(function(m){return m.metadata||{}})})()");
    check('E.singleHasNoGroupIdentity', single.every(m => !('groupTurnId' in m) && !('groupOrder' in m) && !('speakerId' in m)), single);

    check('C.assistantCanonicalMessagesPersisted', (await evaluate(cdp, groupRowsExpr)).length >= 6);
    const swallowed = await evaluate(cdp, 'window.__m11Errs||[]');
    check('F.noSwallowedTraceTypeErrors', !swallowed.some(e => /reading 'begin'/.test(e)), swallowed.slice(0, 2));
    check('runtime.noUncaughtExceptions', exceptions.length === 0, exceptions.slice(0, 3));
  } finally {
    try { browser.kill(); } catch (e) { /* ignore */ }
    try { mock.server.close(); } catch (e) { /* ignore */ }
    rmWithRetry(profile, 5);
  }
  return finish();
}

function finish() {
  console.log(failures === 0 ? '\nGroup trace binding regression passed ✔' : '\nGroup trace binding regression FAILED: ' + failures);
  process.exitCode = failures ? 1 : 0;
}

main().catch(e => { console.error('harness error: ' + (e && e.message)); process.exitCode = 2; });
