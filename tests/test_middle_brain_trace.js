/* ====================================================================
   Middle Brain Runtime Participation Audit · [MiddleBrain Trace] 最小验证
   --------------------------------------------------------------------
   目的：不是验证既有单测，而是用**一次真实普通单聊请求**回答：
     "Middle Brain 是否真的参与了最终发送给模型的请求"。
   做法（真实页面 + CDP + mock 端点，无任何生产代码 patch）：
     A. 默认态：全新 profile → runtime enabled 必须是 false；
     B. enabled + Astra 就绪 + 快照有内容 → trace 各层 true，且
        role 模型收到的请求体里必须真的出现 Astra 压缩块（MB_MARK）；
     C. 反向对照：enabled=false → trace 各层 false、source=bypass，请求体里绝不出现 MB 块；
     D. provider 默认流式路径（streaming=true → callApiChatStream）同一入口；
     E. P11-3 · local 回落：enabled 但 Astra 未就绪（无 API Key）→ source=local、
        零 Astra 请求、本地处理结果**替换**注入并进入请求体；
     F. provider 中立性：deepseek 与 openai 走同一条 seam（注入契约内不得有 provider 特判）。
   只断言 trace 的固定字段与"请求体是否含压缩块 / 本地块"，不断言任何 Prompt 正文。
   运行：node test_middle_brain_trace.js
   ==================================================================== */
'use strict';

const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), http = require('node:http');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');

let failures = 0;
const check = (name, cond, detail) => {
  if (cond) console.log('  PASS  ' + name);
  else { failures++; console.error('  FAIL  ' + name + (detail ? '  -> ' + detail : '')); }
};

/* 复用既有 CDP harness（与 test_middle_brain_seam.js 同一手法，零依赖）。 */
const harness = fs.readFileSync(path.join(__dirname, 'test_chat_smoke.js'), 'utf8');
const boundary = harness.indexOf('async function main() {');
assert.ok(boundary > 0, 'existing CDP harness boundary changed');
const { chromePath, Cdp, evaluate, waitFor, freePort } = new Function('require', '__dirname',
  harness.slice(0, boundary) + '\nreturn {chromePath,Cdp,evaluate,waitFor,freePort};')(require, ROOT);

/* teardown 纪律：监听器 unref + finally 显式 close（不靠 process.exit 掩盖泄漏）。 */
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => { server.unref(); resolve(server.address().port); }));

const MB_MARK = 'MB_TRACE_COMPRESSED';
const chatBodies = [];
const astraReqs = [];
const api = http.createServer(async (req, res) => {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-API-Key,anthropic-version,x-goog-api-key'
  };
  if (req.method === 'OPTIONS') { res.writeHead(204, headers); res.end(); return; }
  let raw = ''; for await (const chunk of req) raw += chunk;
  if (req.url.indexOf('/chat/completions') >= 0) {
    chatBodies.push(raw);
    /* DeepSeek 等 provider 默认 streaming=true → 走 callApiChatStream（SSE）。 */
    if (/"stream"\s*:\s*true/.test(raw)) {
      res.writeHead(200, Object.assign({}, headers, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' }));
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { role: 'assistant', content: 'TRACE_STREAM_REPLY' } }] }) + '\n\n');
      res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + '\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    res.writeHead(200, headers);
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'TRACE_MOCK_REPLY' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }));
    return;
  }
  if (req.url.indexOf('/responses') >= 0) {
    astraReqs.push(raw.slice(0, 120));
    const payload = JSON.stringify({ keep: ['TRACE_KEEP'], merge: [], drop: [], compressedContext: MB_MARK, currentKept: true });
    res.writeHead(200, headers);
    res.end(JSON.stringify({ output: [{ type: 'message', content: [{ type: 'output_text', text: payload }] }], usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 } }));
    return;
  }
  res.writeHead(404, headers); res.end(JSON.stringify({ error: 'not found' }));
});

(async () => {
  const apiPort = await listen(api), apiBase = 'http://127.0.0.1:' + apiPort;
  const astraEp = apiBase + '/v1/responses', chatEp = apiBase + '/v1/chat/completions';

  const web = require(path.join(ROOT, 'services', 'internal-beyond-server.js')).createWebServer({ root: ROOT, port: 0 });
  const webPort = await listen(web), webBase = 'http://127.0.0.1:' + webPort;
  const debugPort = await freePort();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-mb-trace-'));
  const chrome = chromePath(); assert.ok(chrome, 'Chrome or Edge required');
  const browser = spawn(chrome, ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    '--remote-debugging-port=' + debugPort, '--user-data-dir=' + profile, 'about:blank'], { stdio: 'ignore', windowsHide: true });

  let cdp;
  const traces = [];
  const traceText = p => (p.args || []).map(a => (a && a.value != null) ? String(a.value) : String((a && a.description) || '')).join(' ');
  const field = (trace, key) => {
    const m = String(trace).match(new RegExp('(?:^|\\n)' + key + ': ([^\\n]*)'));
    return m ? m[1] : null;
  };
  const sendTurn = async text => {
    const before = traces.length;
    await evaluate(cdp, '(async function(){ document.getElementById("chat-input").value=' + JSON.stringify(text) + '; return await sendChatMessage(); })()');
    for (let i = 0; i < 100 && traces.length <= before; i++) await new Promise(r => setTimeout(r, 100));
    return traces[traces.length - 1] || '';
  };

  try {
    let ready = false;
    for (let i = 0; i < 120; i++) { try { if ((await fetch('http://127.0.0.1:' + debugPort + '/json/version')).ok) { ready = true; break; } } catch (_) {} await new Promise(r => setTimeout(r, 100)); }
    assert.ok(ready, 'CDP readiness');
    const tab = await (await fetch('http://127.0.0.1:' + debugPort + '/json/new?about:blank', { method: 'PUT' })).json();
    cdp = await Cdp.connect(tab.webSocketDebuggerUrl);
    await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
    cdp.on('Runtime.consoleAPICalled', p => {
      const t = traceText(p);
      if (t.indexOf('[MiddleBrain Trace]') === 0) traces.push(t);
    });
    await cdp.send('Page.navigate', { url: webBase + '/InternalBeyond.html' });
    check('page.ready', await waitFor(cdp, "document.readyState==='complete' && !!(window.IB&&window.IB.middleBrain) && typeof window.sendChatMessage==='function' && !!(window.IB.__mbTrace)", 20000));

    /* 种子数据：一个可召回的 Memory（否则 Astra 无上下文可压缩 → 不会注入）+ 一个 mock 角色 API。 */
    await evaluate(cdp, `(async function(){
      await dbPut('apiSettings',{id:'summarySettings',enabled:false,keepCount:6,welcomeEnabled:false,welcomeInterval:2,musicEnabled:false,summaryApiId:'',summaryWindow:60});
      await dbPut('memories',{id:'trace_mem',kind:'episodic',createdBy:'trace_role',visibility:'public',visibleTo:[],excludeFrom:[],title:'TRACE_MEMORY_TITLE',content:'TRACE_MEMORY_MARKER',domain:'日常',tags:[],valence:0.5,arousal:0.3,importance:9,resolved:false,activationCount:0,created:Date.now(),lastActivated:0});
      await dbPut('apiConfigs',{id:'trace_role',nickname:'TraceAI',model:'trace-model',endpoint:${JSON.stringify(chatEp)},apiKey:'',provider:'custom',relationship:'审计对象',systemPrompt:'你是 trace 测试角色。',temperature:1,streaming:false,showThinking:false,promptCache:false,created:Date.now()});
      await loadApiConfigs();
      activeFriendId='trace_role';
      window.confirm=function(){return true};
      return true})()`);
    await evaluate(cdp, '(function(){ openChatPanel(); activeFriendId="trace_role"; return true })()');
    check('seed.ready', await evaluate(cdp, "apiConfigs.some(function(a){return a.id==='trace_role'&&!!a.endpoint})"));

    /* ── A. 默认态（全新 profile，未做任何设置）────────────────────────── */
    check('A1.traceSinkOn', await evaluate(cdp, '(function(){return window.IB.__mbTrace.on()===true})()'));
    check('A2.defaultRuntimeDisabled', (await evaluate(cdp, '(async function(){return await IB.middleBrain.isMiddleBrainEnabled()})()')) === false);

    /* ── B. enabled + Astra 就绪（正向：MB 真的改写了发给模型的请求）──── */
    await evaluate(cdp, `(async function(){await saveMiddleBrainConfig({enabled:true,endpoint:${JSON.stringify(astraEp)},model:'gpt-6-astra',apiKey:'sk-trace',admissionEnabled:false,characterIntegrityEnabled:false});return true})()`);
    const bodiesBeforeB = chatBodies.length;
    const tb = await sendTurn('TRACE_PROBE_ENABLED');
    const bReq = chatBodies.slice(bodiesBeforeB).join('\n');
    check('B1.traceEmitted', tb.indexOf('[MiddleBrain Trace]') === 0, tb.slice(0, 80));
    check('B2.consumerCharacter', field(tb, 'consumer') === 'chat' && field(tb, 'character') === 'trace_role', tb);
    check('B3.enabledSeamEntered', field(tb, 'enabled') === 'true' && field(tb, 'executeEntered') === 'true' && field(tb, 'configApplied') === 'true', tb);
    check('B4.policyAstraApplied', field(tb, 'policyApplied') === 'true' && field(tb, 'astraApplied') === 'true' && field(tb, 'source') === 'astra', tb);
    check('B5.judgeOocNotApplied', field(tb, 'judgeApplied') === 'false' && field(tb, 'oocGuardApplied') === 'false', tb);
    check('B6.messageCounts', Number(field(tb, 'inputMessages')) > 0 && Number(field(tb, 'outputMessages')) > 0, tb);
    check('B7.systemParamsUntouched', field(tb, 'systemChanged') === 'false' && field(tb, 'requestParamsChanged') === 'false', tb);
    check('B8.executorModel', field(tb, 'executor') === 'callApiChat' && field(tb, 'model') === 'trace-model', tb);
    check('B9.mbReachedModelRequest', bReq.indexOf(MB_MARK) >= 0, 'role 模型请求体里没有 Astra 压缩块');
    check('B10.messagesChanged', field(tb, 'messagesChanged') === 'true', tb);
    check('B11.replyDelivered', await evaluate(cdp, "(function(){var m=document.getElementById('chat-messages');return !!m&&m.textContent.indexOf('TRACE_MOCK_REPLY')>=0})()"));

    /* ── C. 反向对照：enabled=false（绝不注入）────────────────────────── */
    await evaluate(cdp, '(async function(){await saveMiddleBrainConfig({enabled:false});return true})()');
    const bodiesBeforeC = chatBodies.length;
    const tc = await sendTurn('TRACE_PROBE_DISABLED');
    const cReq = chatBodies.slice(bodiesBeforeC).join('\n');
    check('C1.traceEmitted', tc.indexOf('[MiddleBrain Trace]') === 0, tc.slice(0, 80));
    check('C2.disabledStillEnteredSeam', field(tc, 'enabled') === 'false' && field(tc, 'executeEntered') === 'true' && field(tc, 'configApplied') === 'true', tc);
    check('C3.noLayerParticipated', field(tc, 'policyApplied') === 'false' && field(tc, 'astraApplied') === 'false'
      && field(tc, 'judgeApplied') === 'false' && field(tc, 'oocGuardApplied') === 'false', tc);
    check('C4.nothingChanged', field(tc, 'systemChanged') === 'false' && field(tc, 'requestParamsChanged') === 'false' && field(tc, 'messagesChanged') === 'false', tc);
    check('C5.noMbBlockInRequest', cReq.indexOf(MB_MARK) < 0, '未启用却仍注入了 MB 压缩块');
    check('C6.noPromptLeak', traces.every(t => !/sk-trace|TRACE_MEMORY_MARKER|你是 trace 测试角色|TRACE_PROBE_ENABLED/.test(t)), 'trace 里出现了密钥/记忆/角色设定/用户正文');
    check('C7.sourceBypass', field(tc, 'source') === 'bypass' && cReq.indexOf('Middle Brain 压缩后的上下文') < 0,
      '未启用轮的三态来源必须是 bypass，且请求体里不得出现 MB 块: ' + field(tc, 'source'));

    /* ── D. provider 默认流式路径（streaming=true → callApiChatStream）同一入口 ── */
    await evaluate(cdp, `(async function(){
      await saveMiddleBrainConfig({enabled:true,endpoint:${JSON.stringify(astraEp)},model:'gpt-6-astra',apiKey:'sk-trace',admissionEnabled:false,characterIntegrityEnabled:false});
      var c=apiConfigs.find(function(a){return a.id==='trace_role'}); c.streaming=true; await dbPut('apiConfigs',c);
      await loadApiConfigs(); activeFriendId='trace_role'; return true})()`);
    const bodiesBeforeD = chatBodies.length;
    const td = await sendTurn('TRACE_PROBE_STREAM');
    const dReq = chatBodies.slice(bodiesBeforeD).join('\n');
    check('D1.traceEmitted', td.indexOf('[MiddleBrain Trace]') === 0, td.slice(0, 80));
    check('D2.streamExecutor', field(td, 'executor') === 'callApiChatStream' && field(td, 'astraApplied') === 'true' && field(td, 'messagesChanged') === 'true', td);
    check('D3.mbReachedStreamRequest', dReq.indexOf(MB_MARK) >= 0, '流式角色请求体里没有 Astra 压缩块');
    check('D4.paramsUntouched', field(td, 'systemChanged') === 'false' && field(td, 'requestParamsChanged') === 'false', td);

    /* ── E. P11-3 · local fallback 语义闭合（Gate NO / Astra 未就绪 → 本地结果同样进入请求）──
       enabled + 有 endpoint/model 但**没有 API Key** → Admission Gate 判定 astra_not_ready
       → 不发起任何 Astra 请求 → 本地 pipeline 产出 → 必须替换注入（不再"原样保留"）。
       验收点：trace source=local、messagesChanged=true；角色模型请求体里真的出现 local 处理结果。 */
    await evaluate(cdp, `(async function(){
      await saveMiddleBrainConfig({enabled:true,endpoint:${JSON.stringify(astraEp)},model:'gpt-6-astra',apiKey:'',admissionEnabled:true,characterIntegrityEnabled:false});
      var c=apiConfigs.find(function(a){return a.id==='trace_role'}); c.streaming=false; await dbPut('apiConfigs',c);
      await loadApiConfigs(); activeFriendId='trace_role'; return true})()`);
    const astraBeforeE = astraReqs.length;
    const bodiesBeforeE = chatBodies.length;
    const te = await sendTurn('TRACE_PROBE_LOCAL');
    const eReq = chatBodies.slice(bodiesBeforeE).join('\n');
    check('E1.traceEmitted', te.indexOf('[MiddleBrain Trace]') === 0, te.slice(0, 80));
    check('E2.localSourceNoAstra', field(te, 'enabled') === 'true' && field(te, 'executeEntered') === 'true'
      && field(te, 'policyApplied') === 'true' && field(te, 'astraApplied') === 'false' && field(te, 'source') === 'local', te);
    check('E3.noAstraRequest', astraReqs.length === astraBeforeE, 'Astra 未就绪却仍发起了 ' + (astraReqs.length - astraBeforeE) + ' 次请求');
    check('E4.messagesChanged', field(te, 'messagesChanged') === 'true' && field(te, 'systemChanged') === 'false'
      && field(te, 'requestParamsChanged') === 'false', te);
    check('E5.localReachedModelRequest', eReq.indexOf('Middle Brain 压缩后的上下文') >= 0 && eReq.indexOf('【记忆】') >= 0,
      'local 处理结果没有进入最终角色请求');
    check('E6.notAstraPayload', eReq.indexOf(MB_MARK) < 0, 'local 轮里出现了 Astra 压缩块');
    check('E7.replacedNotAppended', eReq.indexOf('Middle Brain 压缩后的上下文') < eReq.indexOf('【记忆（系统参考，勿提及此段）】'),
      'MB 块被追加到原块之后（应为就地替换）');
    check('E8.localKeepsMemory', eReq.indexOf('TRACE_MEMORY_MARKER') >= 0, 'local 压缩丢失了 Memory 内容');
    check('E9.executorModel', field(te, 'executor') === 'callApiChat' && field(te, 'model') === 'trace-model', te);

    /* provider 中立性：local 语义与 provider 无关（deepseek 与 openai 同一条 seam / executor）。 */
    await evaluate(cdp, `(async function(){
      var c=apiConfigs.find(function(a){return a.id==='trace_role'}); c.provider='deepseek'; await dbPut('apiConfigs',c);
      await loadApiConfigs(); activeFriendId='trace_role'; return c.model})()`);
    const bodiesBeforeF = chatBodies.length;
    const tf = await sendTurn('TRACE_PROBE_LOCAL_DEEPSEEK');
    const fReq = chatBodies.slice(bodiesBeforeF).join('\n');
    check('F1.deepseekSameSemantics', field(tf, 'source') === 'local' && field(tf, 'messagesChanged') === 'true'
      && field(tf, 'model') === 'trace-model', tf);
    check('F2.deepseekNoProviderSpecialCase', fReq.indexOf('Middle Brain 压缩后的上下文') >= 0 && fReq.indexOf('【记忆】') >= 0,
      'deepseek provider 下 local 结果未进入请求（出现 provider 特判？）');
    const dsh = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'communication.js'), 'utf8');
    check('F3.noProviderBranchInInject', (dsh.match(/function _mbInjectable\(res,userMessage\)\s*\{[\s\S]*?\n\}/) || [''])[0]
      .search(/provider|deepseek|openai|anthropic|gemini/i) < 0, '注入契约里出现 provider 特判');

    /* 原始 trace 文本（审计证据；C6 已断言其中不含密钥 / Memory / 角色设定 / 用户正文）。 */
    traces.forEach(t => console.log('\n' + t));

    console.log('\nMiddle Brain Trace (runtime participation): ' + failures + ' failed');
    process.exitCode = failures ? 1 : 0;
  } finally {
    if (cdp) cdp.close();
    try { browser.kill(); } catch (_) {}
    try { api.close(); } catch (_) {}
    try { web.close(); } catch (_) {}
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_) {}
  }
})();
