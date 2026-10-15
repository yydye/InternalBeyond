/* ====================================================================
   P11-3D · Tool Execution Guard · 真实执行路径（浏览器 + mock provider）
   --------------------------------------------------------------------
   本文件回答的问题与契约文件不同：

     契约文件问"守卫自己算得对不对"；
     本文件问"**生产的 FC 循环**是否真的按守卫的裁定停止"。

   为什么必须在真实浏览器里跑：
     P11-3D 修的四条缺陷全部住在调用链里 —— `continue` 绕过 maxRounds、
     MCP-only 回合不自增轮次、同一 {name,args} 可重复执行、失败路径可立即
     重试。这四条**只有**让真实的 `callApiChat` / `callApiChatStream` 在
     真实的 provider 响应下跑一遍才能证伪。grep 只能证明字符串存在，
     证明不了"模型一直要工具时会停下来"。

   被测对象是生产代码本身：
     · 真实的 IBFC.prepare / runRound / takeCalls / buildTurns / ledger
     · 真实的 communication.js 循环（流式与非流式两条）
     · 真实的 webhook 执行器链路（_ibToolFetch → 本地 mock 工具端点）
   只有三样是假的：provider 端点、工具端点、以及**工具的业务动作**
   （一个返回固定文本的本地 HTTP 工具）。工具语义不是本阶段的目标，
   额度与熔断才是。

   ── 运行 ────────────────────────────────────────────────────────────
     node tests/test_p11_3d_tool_execution_guard.js
   需要 Chrome/Edge（本仓库既有的 CDP harness；CHROME_PATH 可指定）。
   零真实 provider、零真实 API Key、零开发目录实例、零 %LOCALAPPDATA% 写入。
   ==================================================================== */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');

/* 复用既有 CDP harness（test_chat_smoke.js 的辅助函数段），不新写一套。 */
const harness = fs.readFileSync(path.join(__dirname, 'test_chat_smoke.js'), 'utf8');
const boundary = harness.indexOf('async function main() {');
assert.ok(boundary > 0, 'existing CDP harness boundary changed');
const { chromePath, Cdp, evaluate, waitFor, freePort } = new Function('require', '__dirname',
  harness.slice(0, boundary) + '\nreturn {chromePath,Cdp,evaluate,waitFor,freePort};')(require, ROOT);

let failures = 0;
async function check(name, fn) {
  try { const r = await fn(); console.log('  PASS  ' + name + (r && r.note ? '  · ' + r.note : '')); }
  catch (e) { failures++; console.error('  FAIL  ' + name + '  -> ' + (e && e.message || e)); }
}
const section = t => console.log('\n── ' + t + ' ──');
const listen = server => new Promise(r => server.listen(0, '127.0.0.1', () => r(server.address().port)));

/* ====================================================================
   mock provider：按脚本逐次回答，能产出工具调用，也能产出截断续写。
   ==================================================================== */
const providerLog = [];
function startProvider() {
  return new Promise(resolve => {
    const server = http.createServer(async (req, res) => {
      const headers = {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
        'Access-Control-Allow-Headers': '*'
      };
      if (req.method === 'OPTIONS') { res.writeHead(204, headers); res.end(); return; }
      let raw = '';
      for await (const chunk of req) raw += chunk;
      let body = null; try { body = JSON.parse(raw || '{}'); } catch (_) {}
      providerLog.push({ url: req.url, body });
      const idx = providerLog.length - 1;
      /* 后台并发回合（X4）只回答纯文本。判据必须是**请求自身**（它有没有带 tools），
         不能用一个全局开关 —— 全局开关由 Node 侧的时间线翻转，抢跑一次就会让
         前台回合拿到后台的脚本（本次开发真实踩到：X4 一度因为抢跑而"没有工具"）。 */
      const plainTurn = !(body && Array.isArray(body.tools) && body.tools.length);
      const script = plainTurn ? [{ kind: 'text', text: '纯文本回合。' }] : SCRIPT;
      /* 脚本耗尽后重复**最后一步**：这样"模型一直索要工具"可以用单步脚本表达，
         不必靠省略一步来隐式兜底（省略会让"下一步是什么"取决于实现细节）。 */
      const step = script[Math.min(idx, script.length - 1)] || script[script.length - 1] || { kind: 'text', text: '好的。' };
      if (step.kind === 'delay-text') {
        await new Promise(resolveDelay => setTimeout(resolveDelay, Number(step.delayMs) || 0));
        if (res.destroyed) return;
        res.writeHead(200, headers);
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: step.text || '延迟后恢复。' }, finish_reason: 'stop' }] }));
        return;
      }
      if (step.kind === 'http-error') {
        const errorHeaders = Object.assign({}, headers);
        if (step.retryAfter) errorHeaders['Retry-After'] = String(step.retryAfter);
        res.writeHead(Number(step.status) || 500, errorHeaders);
        res.end(JSON.stringify({ error: { message: 'scripted transient failure' } }));
        return;
      }
      /* 真实的流式链路：客户端带 stream:true 时端点必须回 SSE，
         否则测的是"回落成非流式的假路径"而不是流式 FC。 */
      if (body && body.stream === true && step.kind !== 'stream-tool') {
        res.writeHead(200, Object.assign({}, headers, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' }));
        const payload = step.kind === 'tool'
          ? { choices: [{ delta: { role: 'assistant', tool_calls: step.calls.map((c, k) => ({ index: k, id: 'sc_' + idx + '_' + k, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } })) } }] }
          : { choices: [{ delta: { role: 'assistant', content: step.text || '好的。' } }] };
        res.write('data: ' + JSON.stringify(payload) + '\n\n');
        res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: step.kind === 'tool' ? 'tool_calls' : (step.kind === 'truncated-text' ? 'length' : 'stop') }] }) + '\n\n');
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
      if (step.kind === 'tool') {
        /* OpenAI 兼容：一条带 tool_calls 的 message（非流式） */
        res.writeHead(200, headers);
        res.end(JSON.stringify({
          choices: [{ message: { role: 'assistant', content: step.text || null, tool_calls: step.calls.map((c, k) => ({ id: 'call_' + idx + '_' + k, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } })) }, finish_reason: 'tool_calls' }],
          usage: { prompt_tokens: 10, completion_tokens: 5 }
        }));
        return;
      }
      if (step.kind === 'truncated-text') {
        res.writeHead(200, headers);
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: step.text || '续写起始内容。' }, finish_reason: 'length' }] }));
        return;
      }
      if (step.kind === 'stream-tool') {
        /* SSE：delta 分片拼出 tool_calls —— 走 feedOpenAI/takeCalls 的真实流式累加器 */
        res.writeHead(200, Object.assign({}, headers, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' }));
        const calls = step.calls.map((c, k) => ({ index: k, id: 'sc_' + idx + '_' + k, name: c.name, args: JSON.stringify(c.args) }));
        res.write('data: ' + JSON.stringify({ choices: [{ delta: { role: 'assistant', content: '' } }] }) + '\n\n');
        for (const c of calls) {
          res.write('data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: c.index, id: c.id, type: 'function', function: { name: c.name, arguments: '' } }] } }] }) + '\n\n');
          /* 参数按两片发出，逼真实累加器拼接 */
          const half = Math.ceil(c.args.length / 2);
          res.write('data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: c.index, function: { arguments: c.args.slice(0, half) } }] } }] }) + '\n\n');
          res.write('data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: c.index, function: { arguments: c.args.slice(half) } }] } }] }) + '\n\n');
        }
        res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }) + '\n\n');
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
      res.writeHead(200, headers);
      res.end(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: step.text || '好的。' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5 }
      }));
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

/* mock 工具端点：业务动作无关紧要，但**执行次数**是本案的核心证据。 */
let toolHits = 0;
let toolFail = false;
let toolDelayMs = 0;
function startToolServer() {
  return new Promise(resolve => {
    const server = http.createServer(async (req, res) => {
      toolHits += 1;
      if (toolDelayMs) await new Promise(r => setTimeout(r, toolDelayMs));
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Headers', '*');
      if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
      res.writeHead(toolFail ? 500 : 200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: !toolFail, hits: toolHits }));
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

/* 每次场景之前重写 provider 脚本 */
let SCRIPT = [{ kind: 'text', text: '好的。' }];

(async () => {
  const provider = await startProvider();
  const apiBase = 'http://127.0.0.1:' + provider.port;
  const toolSrv = await startToolServer();
  const toolBase = 'http://127.0.0.1:' + toolSrv.port;

  const web = require(path.join(ROOT, 'services', 'internal-beyond-server.js')).createWebServer({ root: ROOT, port: 0 });
  const webPort = await listen(web), webBase = 'http://127.0.0.1:' + webPort;

  const debugPort = await freePort();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-p113d-'));
  const chrome = chromePath();
  assert.ok(chrome, '需要 Chrome 或 Edge（CHROME_PATH 可指定）');
  const browser = spawn(chrome, ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    '--remote-debugging-port=' + debugPort, '--user-data-dir=' + profile, 'about:blank'],
    { stdio: 'ignore', windowsHide: true });

  let cdp = null;
  const cleanup = async () => {
    try { if (cdp) cdp.close(); } catch (_) {}
    try { browser.kill(); } catch (_) {}
    try { provider.server.close(); } catch (_) {}
    try { toolSrv.server.close(); } catch (_) {}
    try { web.close(); } catch (_) {}
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_) {}
  };

  try {
    let ready = false;
    for (let i = 0; i < 120; i++) {
      try { ready = (await fetch('http://127.0.0.1:' + debugPort + '/json/version')).ok; } catch (_) {}
      if (ready) break;
      await new Promise(r => setTimeout(r, 100));
    }
    assert.ok(ready, 'CDP readiness');
    const tab = await (await fetch('http://127.0.0.1:' + debugPort + '/json/new?about:blank', { method: 'PUT' })).json();
    cdp = await Cdp.connect(tab.webSocketDebuggerUrl);
    await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
    /* 隔离：只允许访问 mock provider / mock 工具 / 本地 web server，
       其余（真实 provider、用户服务）一律拒绝 —— 任何真实凭据都不可能被用到。 */
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `const _of=window.fetch.bind(window);window.fetch=function(input,opts){const u=new URL(typeof input==='string'?input:input.url,location.href);`
        + `if(u.origin!==${JSON.stringify(apiBase)}&&u.origin!==${JSON.stringify(toolBase)}&&u.origin!==${JSON.stringify(webBase)})return Promise.reject(new Error('p11-3d blocks external service'));return _of(input,opts);};`
        + `window.confirm=()=>true;`
    });
    await cdp.send('Page.navigate', { url: webBase + '/InternalBeyond.html' });
    assert.ok(await waitFor(cdp, "document.readyState==='complete' && window.IB && typeof IBFC!=='undefined' && typeof IBToolGuard!=='undefined' && typeof apiConfigs!=='undefined'", 30000),
      '页面加载完成且 guard 模块已挂载（脚本顺序正确）');

    /* ── 场景夹具：一个本地 webhook 工具 + 一个指向 mock provider 的配置 ──
       工具配置走**真实**保存路径（ibToolsSaveSwitches / saveIbTools），
       不手写缓存变量：被中断的缓存会在页面里留下"配置看起来对但执行器看不到"的假象。 */
    const setup = await evaluate(cdp, `(async function(){
      try{ localStorage.setItem('ib_fcMode','auto'); localStorage.setItem('ib_fcRounds','3'); }catch(e){}
      var cfg={id:'ibTools',enabled:true,confirm:false,tools:[{id:'t1',name:'check_status',desc:'查询状态',params:'key',method:'GET',url:${JSON.stringify(toolBase + '/status?key={{key}}')},headers:'',body:''},{id:'t2',name:'ping_host',desc:'探活',params:'host',method:'GET',url:${JSON.stringify(toolBase + '/ping?host={{host}}')},headers:'',body:''}]};
      await saveIbTools(cfg);
      var api={id:'p3d',provider:'custom',nickname:'测试',endpoint:${JSON.stringify(apiBase + '/v1/chat/completions')},model:'mock-3d',apiKey:'sk-local-mock-not-a-real-credential',temperature:0.2};
      apiConfigs=apiConfigs.filter(function(a){return a.id!=='p3d'});apiConfigs.push(api);
      await dbPut('apiConfigs',api);
      var saved=await getIbTools();
      return {tools:(saved.tools||[]).length, enabled:!!saved.enabled, confirm:!!saved.confirm, cfg:!!apiConfigs.find(function(a){return a.id==='p3d'})};
    })()`);
    assert.equal(setup.tools, 2, '工具配置落库');
    assert.equal(setup.enabled, true, '工具已启用');
    assert.equal(setup.confirm, false, '工具免确认（否则走 pendingConfirm 而非执行）');

    /* 两个系统提示：一个带工具块（激活 FC），一个不带（不激活）。 */
    const SYS_TOOLS = '你是测试角色。\n【外部工具】check_status / ping_host 可用。';
    const SYS_PLAIN = '你是测试角色，只聊天。';

    /* 每个场景：重置 guard、计数器、provider 脚本，然后跑一次真实 chat 调用。 */
    async function runScenario(opt) {
      SCRIPT = opt.script;
      toolHits = 0; toolFail = !!opt.toolFail; toolDelayMs = opt.toolDelayMs || 0;
      providerLog.length = 0;
      const traceId = await evaluate(cdp, `IBModelCore.turnTraceBegin({consumer:'test-p11-3d',threadId:'provider-retry-test'})`);
      /* 逐场景设定额度：**走生产读法**（localStorage → IBFC.guardPolicy → guard），
         并且在**同一个页面回合内**设定 + 执行 —— 分两次 Runtime.evaluate 会让
         "设定"与"执行"之间出现一个可被 _syncGuardPolicy 重建 guard 的窗口
         （本次开发真实踩到：场景设置看起来生效、实际跑的是上一个 guard）。 */
      return await evaluate(cdp, `(async function(){
        try{
          localStorage.setItem('ib_fcRounds',String(${opt.rounds === undefined ? 3 : opt.rounds}));
          ${opt.policy && opt.policy.toolCallTimeoutMs !== undefined
            ? `localStorage.setItem('ib_fcToolTimeoutMs',String(${opt.policy.toolCallTimeoutMs}));`
            : `localStorage.removeItem('ib_fcToolTimeoutMs');`}
        }catch(e){}
        IBFC._tdPolicyJson=null;   /* 按新的设置重建 guard（活动周期中不会被重建，见 _syncGuardPolicy） */
        IBFC._tdLast=null; IBFC._tdReason=''; IBFC._tdTrace=[];
        var originalFetch=window.fetch,networkPending=${opt.networkErrorOnce === true};
        if(networkPending)window.fetch=function(input,options){
          var requestUrl=String(typeof input==='string'?input:(input&&input.url)||input||'');
          if(networkPending&&requestUrl.indexOf(${JSON.stringify(apiBase)})===0){networkPending=false;return Promise.reject(new TypeError('Failed to fetch'));}
          return originalFetch.apply(this,arguments);
        };
        var cfg=apiConfigs.find(function(a){return a.id==='p3d'});
        var msgs=[{role:'system',content:${JSON.stringify(opt.system || SYS_TOOLS)}},{role:'user',content:'请帮我处理一下'}];
        var out='';
        var r;
        try{r=await callApiChat(cfg,msgs,{_ibConsumer:'test-p11-3d',_ibTraceId:${JSON.stringify(traceId)},wantMeta:true,maxTokens:512,timeoutMs:${opt.timeoutMs || 20000},
          autoContinue:${opt.autoContinue === true},maxContinues:${opt.maxContinues || 0},
          onChunk:function(t){out+=t;}})}finally{window.fetch=originalFetch;}
        var snap=IBFC._tdLast||null;
        var trace=IBModelCore.turnTraceFinish(${JSON.stringify(traceId)},'completed',{resultChars:String((r&&r.text)||'').length,assistantMessages:1});
        return {policy:(snap&&snap.policy)||null, text:(r&&r.text)||'', chunked:out, turnTrace:trace,
          breaker:IBFC.breakerReason(), snapshot:snap, trace:(IBFC._tdTrace||[])};
      })()`);
    }
    const roundTrips = () => providerLog.length;

    /* ================================================================ */
    section('N · 正常路径：不该被拦的一次都不拦');

    section('S · Provider 瞬态恢复：保持原 Provider 路由，退避后有限重试');

    await check('S1 HTTP 429 + Retry-After：等待后同路由恢复', async () => {
      const r = await runScenario({ script: [
        { kind: 'http-error', status: 429, retryAfter: '0.1' },
        { kind: 'text', text: '限流后恢复。' }
      ] });
      assert.equal(roundTrips(), 2, '429 只触发一次重试');
      assert.ok(r.text.indexOf('限流后恢复') >= 0, '成功响应返回');
      assert.ok(r.turnTrace.events.some(e => e.eventType === 'model_call_retry' && e.errorCategory === 'rate_limit' && e.httpStatus === 429), 'trace 记录 429 重试');
    });

    await check('S2 HTTP 503：同路由指数退避后恢复', async () => {
      const r = await runScenario({ script: [
        { kind: 'http-error', status: 503 },
        { kind: 'text', text: '服务恢复。' }
      ] });
      assert.equal(roundTrips(), 2, '503 只触发一次重试');
      assert.ok(r.text.indexOf('服务恢复') >= 0, '成功响应返回');
      assert.ok(r.turnTrace.events.some(e => e.eventType === 'model_call_retry' && e.errorCategory === 'provider' && e.httpStatus === 503), 'trace 记录 503 重试');
    });

    await check('S4 timeout：未收到响应时只重试一次', async () => {
      const r = await runScenario({ timeoutMs: 250, script: [
        { kind: 'delay-text', delayMs: 500, text: '超时后恢复。' },
        { kind: 'text', text: '超时后恢复。' }
      ] });
      assert.equal(roundTrips(), 2, 'timeout 只触发一次重试');
      assert.ok(r.text.indexOf('超时后恢复') >= 0, '第二次响应成功');
      assert.ok(r.turnTrace.events.some(e => e.eventType === 'model_call_retry' && e.errorCategory === 'timeout'), 'trace 记录 timeout retry');
    });

    await check('N1 无工具调用：回合正常结束，工具执行 0 次', async () => {
      const r = await runScenario({ script: [{ kind: 'text', text: '今天天气不错。' }] });
      assert.ok(r.text.indexOf('今天天气不错') >= 0, '拿到模型回复');
      assert.equal(toolHits, 0, '工具未被调用');
      assert.equal(roundTrips(), 1, 'provider 只被调用一次');
      assert.equal(r.breaker, '', '未熔断');
      assert.equal(r.snapshot.toolCalls, 0, '工具执行计数为 0');
    });

    await check('N2 单工具一次：执行 1 次、两轮 provider、回合结束', async () => {
      const r = await runScenario({
        script: [{ kind: 'tool', calls: [{ name: 'check_status', args: { key: 'alpha' } }] }, { kind: 'text', text: '状态正常。' }]
      });
      assert.equal(toolHits, 1, '工具真的被执行（走真实 webhook 执行器）');
      assert.equal(roundTrips(), 2, 'provider 第二轮用于消费工具结果');
      assert.equal(r.breaker, '', '未熔断');
      assert.equal(r.snapshot.toolCalls, 1, '工具执行计数为 1');
      assert.equal(r.snapshot.rounds, 1, '轮预算消耗 1');
      assert.ok(r.text.indexOf('状态正常') >= 0, '最终回复来自模型');
    });

    await check('N3 多个不同工具：各自执行一次、不互相顶替额度', async () => {
      await runScenario({
        script: [
          { kind: 'tool', calls: [{ name: 'check_status', args: { key: 'a' } }, { name: 'ping_host', args: { host: 'h1' } }] },
          { kind: 'text', text: '都好了。' }
        ]
      });
      assert.equal(toolHits, 2, '两个工具各执行一次');
    });

    await check('N4 same tool + different args：视为不同调用，各自放行', async () => {
      await runScenario({
        script: [
          { kind: 'tool', calls: [{ name: 'check_status', args: { key: 'a' } }] },
          { kind: 'tool', calls: [{ name: 'check_status', args: { key: 'b' } }] },
          { kind: 'text', text: '两个都查了。' }
        ]
      });
      assert.equal(toolHits, 2, '不同参数各执行一次');
      const r = await evaluate(cdp, `(function(){var s=IBFC._tdLast;return {dups:s.duplicates, tools:s.toolCalls, distinct:s.distinctCalls}})()`);
      assert.equal(r.tools, 2, '工具执行 2 次');
      assert.equal(r.dups, 0, '不同参数不计为重复');
    });

    await check('N5 键顺序不同的同一参数：指纹相同，因此被识别为重复（不是两次新调用）', async () => {
      await runScenario({
        script: [
          { kind: 'tool', calls: [{ name: 'ping_host', args: { host: 'h1', mode: 'fast' } }] },
          { kind: 'tool', calls: [{ name: 'ping_host', args: { mode: 'fast', host: 'h1' } }] },
          { kind: 'text', text: '好。' }
        ]
      });
      const r = await evaluate(cdp, `(function(){var s=IBFC._tdLast;return {dups:s.duplicates, tools:s.toolCalls, distinct:s.distinctCalls}})()`);
      assert.equal(r.distinct, 1, '两种键序归并为同一个指纹');
      assert.equal(r.dups, 1, '第二次被识别为重复');
      assert.equal(toolHits, 2, '第一次执行、第二次是成功后的重复（额度内允许）');
    });

    await check('N6 流式路径：SSE 分片拼出的工具调用同样被计数与放行', async () => {
      /* 流式与非流式是两条生产路径（callApiChatStream / callApiChat）：
         只测其中一条不能证明预算对两条都成立。 */
      SCRIPT = [{ kind: 'stream-tool', calls: [{ name: 'check_status', args: { key: 'stream' } }] }, { kind: 'text', text: '流式结果已收到。' }];
      toolHits = 0; toolFail = false; toolDelayMs = 0; providerLog.length = 0;
      const r = await evaluate(cdp, `(async function(){
        localStorage.setItem('ib_fcRounds','3'); localStorage.removeItem('ib_fcToolTimeoutMs');
        IBFC._tdPolicyJson=null; IBFC._tdLast=null; IBFC._tdReason=''; IBFC._tdTrace=[];
        var cfg=apiConfigs.find(function(a){return a.id==='p3d'});
        var msgs=[{role:'system',content:${JSON.stringify(SYS_TOOLS)}},{role:'user',content:'请帮我处理一下'}];
        var out='';
        var text=await callApiChatStream(cfg,msgs,{_ibConsumer:'test-p11-3d',onChunk:function(t){out+=t;}});
        return {text:String(text||''), chunked:out, breaker:IBFC.breakerReason(),
          snapshot:IBFC._tdLast||null, trace:(IBFC._tdTrace||[]).map(function(e){return e.t})};
      })()`);
      if (!r.snapshot) throw new Error('流式路径没有产生工具周期：' + JSON.stringify(r).slice(0, 200));
      assert.equal(toolHits, 1, '流式路径的工具真的执行了：' + toolHits);
      assert.equal(r.snapshot.toolCalls, 1, '流式路径计入同一份预算');
      assert.equal(r.breaker, '', '未熔断：' + r.breaker);
      return { note: 'rounds=' + r.snapshot.rounds };
    });

    /* ================================================================ */
    section('R · 轮预算：模型一直要工具，必须在固定轮次内停');

    /* 「模型一直索要工具」只有一个正确表达：每一轮都回答"继续调用工具"。
       若脚本中途换成空文本回答，循环就会因为"没有工具调用"自然结束 ——
       那样测到的是"模型停手了"，而不是"轮预算拦住了它"。
       因此本节每一步都必须是 tool 步（引擎按 maxRounds 决定何时必须停）。 */
    const alwaysTool = (calls) => Array.from({ length: 6 }, () => ({ kind: 'tool', calls }));

    await check('R1 模型无限索要工具 → 轮预算耗尽熔断，provider 调用次数有界', async () => {
      const r = await runScenario({
        rounds: 2,
        script: alwaysTool([{ name: 'check_status', args: { key: 'loop' } }])
      });
      assert.equal(r.breaker, 'round-budget-exhausted', '熔断原因是稳定值 ' + r.breaker);
      /* maxRounds=2 → 最多 2 次工具轮 → provider 至多 3 次（首轮 + 2 次续轮） */
      assert.ok(roundTrips() <= 3, 'provider 调用次数有界：' + roundTrips());
      assert.ok(toolHits <= 2, '工具执行次数受轮预算约束：' + toolHits);
      assert.equal(r.snapshot.tripped, true, '快照标记已熔断');
      return { note: 'provider=' + roundTrips() + ' tools=' + toolHits };
    });

    await check('R2 轮预算计入的是"provider→tool→provider"的轮，不是工具个数', async () => {
      /* 每轮换参数：本轮要证的是**轮**预算，不能同时被"重复"闸门抢先拦下
         （两个闸门各自独立，混在一起测就等于什么都没测）。 */
      const r = await runScenario({
        rounds: 3,
        script: [
          { kind: 'tool', calls: [{ name: 'check_status', args: { key: 'r1' } }] },
          { kind: 'tool', calls: [{ name: 'check_status', args: { key: 'r2' } }] },
          { kind: 'tool', calls: [{ name: 'check_status', args: { key: 'r3' } }] },
          { kind: 'tool', calls: [{ name: 'check_status', args: { key: 'r4' } }] }
        ]
      });
      assert.equal(r.breaker, 'round-budget-exhausted', '第 4 轮被拒；实际 breaker=' + r.breaker + ' trace=' + (r.trace || []).map(e => e.t).join(',') + ' tools=' + toolHits);
      assert.equal(toolHits, 3, '恰好执行 3 轮（每轮一个工具）');
      return { note: 'rounds=3 tools=' + toolHits };
    });
    await check('R3 熔断消息进入输出流，但不伪造模型回复', async () => {
      const r = await runScenario({
        rounds: 2,
        script: alwaysTool([{ name: 'check_status', args: { key: 'msg' } }, { name: 'ping_host', args: { host: 'msg' } }])
      });
      assert.equal(r.breaker, 'round-budget-exhausted', '前置：本轮必须是被轮预算拦下的：' + r.breaker);
      /* 非流式路径的输出是返回值（text）；chunked 是流式回调通道，此处天然为空。
         断言必须打在这条链真正产生输出的那个字段上。 */
      assert.ok(/\[工具执行已熔断/.test(r.text), '输出里出现熔断提示：' + JSON.stringify(r.text).slice(0, 300));
      assert.ok(r.text.indexOf('round-budget-exhausted') >= 0, '提示里带稳定 reason');
      /* 熔断后不得再执行工具，也不得伪造一条模型回复：输出里只有工具卡与熔断说明 */
      assert.ok(!/好的|完成了|已为您/.test(r.text), '输出里出现伪造的模型回复');
      return { note: 'tools=' + toolHits };
      return { note: 'chunked=' + r.chunked.length + 'B' };
    });

    await check('R4 熔断后**不再向 provider 索要**（回程必须真的改变）', async () => {
      /* 这条断言针对一个只测"最终 breaker 字符串"会漏掉的变异：
         熔断后若 runRound 仍返回 done:false，provider 循环就会继续要下一轮 ——
         breaker 看起来正常，只是白烧了一整轮 provider 调用。 */
      SCRIPT = alwaysTool([{ name: 'check_status', args: { key: 'after' } }]);
      toolHits = 0; toolFail = false; toolDelayMs = 0; providerLog.length = 0;
      const r = await evaluate(cdp, `(async function(){
        localStorage.setItem('ib_fcRounds','2'); localStorage.removeItem('ib_fcToolTimeoutMs');
        IBFC._tdPolicyJson=null; IBFC._tdLast=null; IBFC._tdReason=''; IBFC._tdTrace=[];
        var cfg=apiConfigs.find(function(a){return a.id==='p3d'});
        var msgs=[{role:'system',content:${JSON.stringify(SYS_TOOLS)}},{role:'user',content:'熔断后别再要'}];
        var out=await callApiChat(cfg,msgs,{_ibConsumer:'test-p11-3d',wantMeta:true,maxTokens:512,timeoutMs:20000});
        return {text:(out&&out.text)||'', breaker:IBFC.breakerReason(), snapshot:IBFC._tdLast||null,
          trace:(IBFC._tdTrace||[]).map(function(e){return e.t})};
      })()`);
      assert.equal(r.breaker, 'round-budget-exhausted', '熔断原因 ' + r.breaker);
      /* maxRounds=2：两轮续跑之后必须停 —— 第 3 次 provider 调用只可能来自"熔断后还要下一轮" */
      assert.ok(providerLog.length <= 3, '熔断后没有再向 provider 索要：provider 调用 ' + providerLog.length + ' 次');
      /* 熔断那一轮不得产生新的工具执行 */
      assert.ok(toolHits <= 2, '熔断后没有额外工具执行：' + toolHits);
      const snap = r.snapshot;
      assert.ok(snap && snap.tripped === true, '快照标记已熔断');
      /* 熔断必须是**终止事件**：trip 之后再出现 round / call，就说明熔断没有真正
         改变回程（只改了一个字符串）。这一条专门抓"熔断后照旧继续"的变异。 */
      const tr = r.trace || [];
      const ti = tr.indexOf('trip');
      if (!(ti >= 0)) throw new Error('trace 里没有 trip：' + tr.join(',') + ' provider=' + providerLog.length + ' hits=' + toolHits);
      if (tr.slice(ti + 1).some(e => e === 'round' || e === 'call')) {
        throw new Error('熔断后仍有轮次/调用：' + tr.join(',') + ' provider=' + providerLog.length + ' hits=' + toolHits);
      }
      if (providerLog.length > 3) throw new Error('熔断后仍向 provider 索要：provider=' + providerLog.length + ' trace=' + tr.join(','));
      return { note: 'provider=' + providerLog.length + ' tools=' + toolHits + ' trace=' + tr.join(',') };
    });

    await check('R5 流式路径同样在轮预算处停：熔断后不再发起 provider 调用', async () => {
      /* 前四条断言都只看"最终 breaker 字符串"，于是漏掉了一类变异：
         把熔断分支的 done 改成 false（熔断后照旧继续要下一轮）。
         流式路径的续跑不依赖 lastTrunc，因此"熔断是否真的改变了回程"
         在这里是可观测的：多一次 provider 调用就是多一轮。 */
      SCRIPT = alwaysTool([{ name: 'check_status', args: { key: 'stream-round' } }]);
      toolHits = 0; toolFail = false; toolDelayMs = 0; providerLog.length = 0;
      const r = await evaluate(cdp, `(async function(){
        localStorage.setItem('ib_fcRounds','1'); localStorage.removeItem('ib_fcToolTimeoutMs');
        IBFC._tdPolicyJson=null; IBFC._tdLast=null; IBFC._tdReason=''; IBFC._tdTrace=[];
        var cfg=apiConfigs.find(function(a){return a.id==='p3d'});
        var msgs=[{role:'system',content:${JSON.stringify(SYS_TOOLS)}},{role:'user',content:'流式轮预算'}];
        var out='';
        var text=await callApiChatStream(cfg,msgs,{_ibConsumer:'test-p11-3d',onChunk:function(t){out+=t;}});
        return {text:String(text||''), chunked:out, breaker:IBFC.breakerReason(), snapshot:IBFC._tdLast||null,
          trace:(IBFC._tdTrace||[]).map(function(e){return e.t})};
      })()`);
      assert.equal(r.breaker, 'round-budget-exhausted', '熔断原因 ' + r.breaker + ' trace=' + (r.trace || []).join(','));
      assert.ok(providerLog.length <= 2, '流式路径熔断后不再发起 provider 调用：' + providerLog.length + ' 次（maxRounds=1）');
      assert.ok(toolHits <= 1, '流式路径熔断后不再执行工具：' + toolHits);
      return { note: 'provider=' + providerLog.length + ' tools=' + toolHits };
    });

    await check('R6 轮预算在"上一轮没有工具调用"之后依然有效（不靠单轮循环兜底）', async () => {
      /* 关键反例：runRound 内部的轮次检查只在自己被调用时才跑。
         若模型的**下一次**回答不再要工具，循环就自行继续，此时唯一还在
         生效的闸门是循环顶部那一次询问。把它去掉，provider 就会被无限索要。 */
      SCRIPT = [
        { kind: 'tool', calls: [{ name: 'check_status', args: { key: 'r6a' } }] },
        { kind: 'text', text: '' },      /* 第二轮不要工具 —— runRound 不会再被调用 */
        { kind: 'stream-tool', calls: [{ name: 'ping_host', args: { host: 'r6b' } }] },
        { kind: 'text', text: '' }
      ];
      toolHits = 0; toolFail = false; toolDelayMs = 0; providerLog.length = 0;
      const r = await evaluate(cdp, `(async function(){
        localStorage.setItem('ib_fcRounds','3'); localStorage.removeItem('ib_fcToolTimeoutMs');
        IBFC._tdPolicyJson=null; IBFC._tdLast=null; IBFC._tdReason=''; IBFC._tdTrace=[];
        var cfg=apiConfigs.find(function(a){return a.id==='p3d'});
        var msgs=[{role:'system',content:${JSON.stringify(SYS_TOOLS)}},{role:'user',content:'空轮之后'}];
        var out='';
        var text=await callApiChatStream(cfg,msgs,{_ibConsumer:'test-p11-3d',onChunk:function(t){out+=t;}});
        return {text:String(text||''), breaker:IBFC.breakerReason(), snapshot:IBFC._tdLast||null,
          trace:(IBFC._tdTrace||[]).map(function(e){return e.t})};
      })()`);
      assert.ok(providerLog.length <= 4, '空轮之后仍受总轮预算约束：provider 调用 ' + providerLog.length + ' 次');
      assert.ok(toolHits <= 2, '工具执行仍受约束：' + toolHits);
      return { note: 'provider=' + providerLog.length + ' tools=' + toolHits + ' breaker=' + r.breaker };
    });

    /* ================================================================ */
    section('D · 重复熔断：连续相同调用达到阈值即停');

    await check('D1 连续完全相同的 tool+args：达到阈值后熔断', async () => {
      const r = await runScenario({
        rounds: 9,
        script: [{ kind: 'tool', calls: [{ name: 'ping_host', args: { host: 'same' } }] }]
      });
      assert.equal(r.breaker, 'duplicate-tool-call-consecutive', '熔断原因 ' + r.breaker);
      assert.equal(toolHits, 2, '连续重复只执行到阈值（含首次）：' + toolHits);
      return { note: 'tools=' + toolHits };
    });

    await check('D2 熔断后不再执行额外工具，也不再继续 provider 循环', async () => {
      const r = await runScenario({
        rounds: 9,
        script: [{ kind: 'tool', calls: [{ name: 'ping_host', args: { host: 'same' } }] }]
      });
      const after = toolHits;
      await new Promise(r2 => setTimeout(r2, 400));
      assert.equal(toolHits, after, '熔断后没有后台残余执行');
      assert.ok(roundTrips() <= 3, 'provider 循环已停止：' + roundTrips());
      assert.equal(r.snapshot.tripped, true, '熔断状态在快照里可见');
      assert.ok(/duplicate/.test(r.breaker), 'reason 稳定：' + r.breaker);
    });

    await check('D3 成功后的非连续重复：一次允许（状态型工具不被当成幂等工具一票否决）', async () => {
      const r = await runScenario({
        rounds: 9,
        script: [
          { kind: 'tool', calls: [{ name: 'ping_host', args: { host: 'h' } }] },
          { kind: 'tool', calls: [{ name: 'check_status', args: { key: 'k' } }] },
          { kind: 'tool', calls: [{ name: 'ping_host', args: { host: 'h' } }] },
          { kind: 'text', text: '完成。' }
        ]
      });
      assert.equal(r.breaker, '', '未被熔断：' + r.breaker);
      assert.equal(toolHits, 3, '三种调用各执行一次（含一次允许的重复）');
      const s = await evaluate(cdp, `(function(){var s=IBFC._tdLast;return {dups:s.duplicates,tools:s.toolCalls}})()`);
      assert.equal(s.dups, 1, '重复被计数但不被拒');
    });

    /* ================================================================ */
    section('F · 失败与重试：有限重试，不无限立即重试');

    await check('F1 工具持续失败 → 重试有限次后熔断', async () => {
      const r = await runScenario({
        rounds: 9, toolFail: true,
        script: [{ kind: 'tool', calls: [{ name: 'check_status', args: { key: 'fail' } }] }]
      });
      assert.equal(r.breaker, 'retry-budget-exhausted', '熔断原因 ' + r.breaker);
      assert.equal(toolHits, 3, '首次 + 2 次重试 = 3 次尝试（有限）：' + toolHits);
      assert.equal(r.snapshot.retries, 2, '重试计数与失败次数分开：' + r.snapshot.retries);
      assert.equal(r.snapshot.failures, 3, '失败计数如实记录');
      return { note: 'attempts=' + toolHits };
    });

    await check('F2 失败但未被限流时：单次失败只重试一次就继续（不熔断）', async () => {
      const r = await runScenario({
        rounds: 9, toolFail: false,
        script: [
          { kind: 'tool', calls: [{ name: 'ping_host', args: { host: 'x1' } }] },
          { kind: 'tool', calls: [{ name: 'ping_host', args: { host: 'x1' } }] },
          { kind: 'text', text: '恢复。' }
        ]
      });
      assert.equal(r.breaker, '', '两次不同指纹轮次的调用不触发熔断：' + r.breaker);
    });

    /* ================================================================ */
    section('T · 超时：工具不返回时有界退出');

    await check('T1 工具迟迟不返回 → 软截止到点即熔断，不再等待', async () => {
      const t0 = Date.now();
      const r = await runScenario({
        rounds: 9, toolDelayMs: 6000, policy: { toolCallTimeoutMs: 1000 },
        script: [{ kind: 'tool', calls: [{ name: 'check_status', args: { key: 'slow' } }] }]
      });
      const ms = Date.now() - t0;
      assert.equal(r.breaker, 'tool-cycle-timeout', '熔断原因 ' + r.breaker);
      assert.ok(ms < 5500, '没有等满工具端点的 6 秒：实际 ' + ms + 'ms');
      assert.ok(toolHits === 1, '只发出一请求（不重试一个不返回的工具）：' + toolHits);
      return { note: ms + 'ms' };
    });

    await check('T2 单个工具超时后，不会无限制等待第二个', async () => {
      const t0 = Date.now();
      const r = await runScenario({
        rounds: 9, toolDelayMs: 6000, policy: { toolCallTimeoutMs: 1000 },
        script: [{ kind: 'tool', calls: [{ name: 'ping_host', args: { host: 'slow2' } }, { name: 'check_status', args: { key: 'slow3' } }] }]
      });
      const ms = Date.now() - t0;
      assert.equal(r.breaker, 'tool-cycle-timeout', '熔断原因 ' + r.breaker);
      assert.ok(ms < 8000, '两个慢工具没有各等一遍：实际 ' + ms + 'ms');
      assert.equal(toolHits, 1, '超时熔断后同批的第二个工具没有被发出：' + toolHits);
      return { note: ms + 'ms tools=' + toolHits };
    });

    await check('T3 单个工具超时吃满额度后：同回合后续调用不再被授权', async () => {
      const r = await runScenario({
        rounds: 9, toolDelayMs: 6000, policy: { toolCallTimeoutMs: 1000 },
        script: [{ kind: 'tool', calls: [{ name: 'check_status', args: { key: 'slow4' } }] }, { kind: 'tool', calls: [{ name: 'ping_host', args: { host: 'later' } }] }]
      });
      assert.equal(r.breaker, 'tool-cycle-timeout', '熔断原因 ' + r.breaker);
      assert.equal(toolHits, 1, '熔断后第二次工具没有被发出：' + toolHits);
    });

    /* ================================================================ */
    section('O · 观测与脱敏');

    /* 边界说明（重要）：模型**必须**收到工具参数 —— 工具要按参数执行，
       卡片也要显示它们。因此"输出流里没有密钥"不是本阶段的命题，
       本阶段的命题是：**守卫自己的观测面**（snapshot / trace / 诊断行）
       绝不携带工具参数原值与敏感键。这两件事必须分开断言，否则会用一条
       错误的期望去修改工具的业务协议。 */

    await check('O1 计数与 elapsed 可读，且熔断原因可被诊断面取到', async () => {
      const r = await runScenario({
        rounds: 2,
        script: alwaysTool([{ name: 'check_status', args: { key: 'obs' } }])
      });
      const s = r.snapshot;
      ['rounds', 'toolCalls', 'duplicates', 'retries', 'elapsedMs', 'breakerReason', 'maxRounds', 'maxToolCalls', 'perCall', 'policy'].forEach(k => assert.ok(s[k] !== undefined, '缺字段 ' + k));
      assert.equal(s.maxRounds, 2, '额度来自用户可见设置（ib_fcRounds=2）');
      assert.equal(s.breakerReason, 'round-budget-exhausted', 'snapshot 里带稳定 reason');
      assert.ok(r.trace.length > 0, 'trace 非空');
    });

    await check('O2 观测面（snapshot / trace / 诊断行）不含工具参数原值与敏感键', async () => {
      const SECRET = 'sk-local-mock-not-a-real-credential';
      const r = await runScenario({
        rounds: 3,
        script: [
          { kind: 'tool', calls: [{ name: 'check_status', args: { key: SECRET, apiKey: SECRET, password: SECRET } }] },
          { kind: 'tool', calls: [{ name: 'ping_host', args: { host: 'h2' } }] },
          { kind: 'text', text: '好。' }
        ]
      });
      const blob = JSON.stringify({ snapshot: r.snapshot, trace: r.trace });
      if (blob.indexOf(SECRET) >= 0) throw new Error('观测面出现参数原值：' + blob.slice(Math.max(0, blob.indexOf(SECRET) - 120), blob.indexOf(SECRET) + 120));
      assert.ok(blob.indexOf('apiKey') < 0 && blob.indexOf('password') < 0, '观测面出现敏感键名');
      assert.ok(r.snapshot.perCall.every(p => p.fingerprint.length <= 16), '指纹是短前缀');
      assert.ok(r.trace.every(e => !e.args), 'trace 里没有 args 字段');
      /* 连工具名之外的任何参数痕迹都不应该有：trace 只允许 计数/指纹/工具名/原因 */
      const allowed = new Set(['t', 'fp', 'name', 'kind', 'n', 'ok', 'timedOut', 'reason', 'policy', 'round', 'maxRounds']);
      const stray = [];
      r.trace.forEach(e => Object.keys(e).forEach(k => { if (!allowed.has(k)) stray.push(k); }));
      assert.equal(stray.length, 0, 'trace 出现未登记字段：' + stray.join(','));
    });

    await check('O3 未激活 FC 的请求（无工具块）不占额度、不产生周期', async () => {
      const r = await runScenario({ system: SYS_PLAIN, script: [{ kind: 'text', text: '只是聊天。' }] });
      assert.equal(r.breaker, '', '未熔断');
      assert.equal(r.snapshot, null, '没有产生工具周期快照');
      assert.equal(toolHits, 0, '没有工具被执行');
    });

    /* ================================================================ */
    section('X · 边界外不变式');

    await check('X1 用户可见设置改动后立即生效（guard 策略不冻结在首次读取）', async () => {
      const r1 = await runScenario({ rounds: 1, script: [{ kind: 'tool', calls: [{ name: 'check_status', args: { key: 'p1' } }] }, { kind: 'text', text: '' }] });
      assert.equal(r1.snapshot.maxRounds, 1, '第一次：maxRounds=1');
      const r2 = await runScenario({ rounds: 5, script: [{ kind: 'text', text: 'ok' }] });
      assert.equal(r2.snapshot.maxRounds, 5, '改设置后：maxRounds=5');
    });

    await check('X2 熔断原因集合仍是封闭的（生产只产出已知 reason）', async () => {
      const known = await evaluate(cdp, `Object.keys(IBToolGuard.REASONS).map(function(k){return IBToolGuard.REASONS[k]})`);
      const r = await runScenario({ rounds: 9, script: [{ kind: 'tool', calls: [{ name: 'ping_host', args: { host: 'z' } }] }] });
      assert.ok(known.indexOf(r.breaker) >= 0, 'reason 未在封闭集合内：' + r.breaker);
    });

    await check('X3 工具业务语义未被改动：webhook 请求照发、结果照回给模型', async () => {
      const r = await runScenario({
        script: [{ kind: 'tool', calls: [{ name: 'check_status', args: { key: 'sem' } }] }, { kind: 'text', text: '结束。' }]
      });
      assert.equal(toolHits, 1, '工具端点被真实请求');
      const second = providerLog[1];
      const hasToolResult = JSON.stringify(second.body).indexOf('"role":"tool"') >= 0;
      assert.ok(hasToolResult, '工具结果按 OpenAI 协议回传给模型');
      assert.ok(JSON.stringify(second.body).indexOf('"tool_calls"') >= 0, 'assistant 的 tool_calls 被带回对话');
      assert.equal(r.breaker, '', '正常路径不熔断');
    });

    await check('X4 并发回合不得收掉别人正在跑的工具周期（本阶段真实踩到的缺陷）', async () => {
      /* 真实形态：后台回合（主动消息 / 群聊 / 摘要调用）与前台回合共享同一个 guard，
         而它们**都会**在请求入口调用 cycleBegin、在出口调用 cycleEnd。
         若结束逻辑不校验"这个周期是不是我开的"，一个不带工具块的并发回合就会
         把前台正在执行工具的周期收掉 —— 现象是"工具真的执行了，计数与熔断却
         什么都没发生"，且观测面显示 rounds=0。这条断言就是钉住那个缺口。 */
      SCRIPT = [{ kind: 'tool', calls: [{ name: 'ping_host', args: { host: 'conc' } }] }];
      toolHits = 0; toolFail = false; toolDelayMs = 1200; providerLog.length = 0;
      const r = await evaluate(cdp, `(async function(){
        localStorage.setItem('ib_fcRounds','3'); localStorage.setItem('ib_fcToolTimeoutMs','6000');
        IBFC._tdPolicyJson=null; IBFC._tdLast=null; IBFC._tdReason=''; IBFC._tdTrace=[];
        var cfg=apiConfigs.find(function(a){return a.id==='p3d'});
        var msgs=[{role:'system',content:${JSON.stringify(SYS_TOOLS)}},{role:'user',content:'并发检查'}];
        var main=callApiChat(cfg,msgs,{_ibConsumer:'test-p11-3d',wantMeta:true,maxTokens:512,timeoutMs:20000});
        /* 前台还在跑工具时，插入一个不带工具块的并发回合（模拟后台主动消息） */
        await new Promise(function(res){setTimeout(res,400)});
        var bgMsgs=[{role:'system',content:${JSON.stringify(SYS_PLAIN)}},{role:'user',content:'后台'}];
        try{ await callApiChat(cfg,bgMsgs,{_ibConsumer:'test-p11-3d-bg',wantMeta:true,maxTokens:128,timeoutMs:20000}); }catch(e){}
        var out=await main;
        return {text:(out&&out.text)||'', breaker:IBFC.breakerReason(), snapshot:IBFC._tdLast||null,
          trace:(IBFC._tdTrace||[]).map(function(e){return e.t})};
      })()`);
      assert.ok(r.snapshot, '前台回合产生了工具周期快照：' + JSON.stringify(r).slice(0, 300));
      /* 判据是"前台的周期里到底有没有次数"：若并发回合把周期收掉了，
         现象正是 rounds=0 / tools=0（本次开发真实踩到的形态）。 */
      assert.ok(r.snapshot.toolCalls >= 1, '前台的工具被计入（并发回合没有把它抹掉）：tools=' + r.snapshot.toolCalls + ' trace=' + (r.trace || []).join(','));
      assert.ok(r.snapshot.rounds >= 1, '轮计数落在前台回合自己的周期上：rounds=' + r.snapshot.rounds + ' trace=' + (r.trace || []).join(','));
      assert.ok((r.trace || []).indexOf('result') >= 0, '结算真的发生（trace 有 result）');
      /* 并发回合不得让前台多执行工具：工具端点命中数 == 前台周期里记的执行数 */
      assert.equal(toolHits, r.snapshot.toolCalls, '工具执行数与前台周期记录一致：hits=' + toolHits + ' tools=' + r.snapshot.toolCalls);
      assert.equal(r.snapshot.tripped, true, '前台回合由轮预算正常收口：' + r.snapshot.breakerReason);
      return { note: 'tools=' + r.snapshot.toolCalls + ' rounds=' + r.snapshot.rounds + ' hits=' + toolHits };
    });

    await check('S3 network error：连接失败后有限重试', async () => {
      const r = await runScenario({ networkErrorOnce: true, script: [
        { kind: 'text', text: '网络恢复。' }
      ] });
      assert.equal(roundTrips(), 1, '拒绝的 fetch 没有到达 provider；重试后成功发出一次请求');
      assert.ok(r.text.indexOf('网络恢复') >= 0, '成功响应返回');
      assert.ok(r.turnTrace.events.some(e => e.eventType === 'model_call_retry' && e.errorCategory === 'network'),
        'trace 记录 network retry: ' + JSON.stringify(r.turnTrace.events.filter(e => /^model_call_/.test(e.eventType))));
    });

    await check('S5 autoContinue 后续 round 的 503 也在该 round 内有限重试', async () => {
      const r = await runScenario({ autoContinue: true, maxContinues: 1, script: [
        { kind: 'truncated-text', text: '前一轮内容。' },
        { kind: 'http-error', status: 503 },
        { kind: 'text', text: '续写恢复。' }
      ] });
      assert.equal(roundTrips(), 3, '首轮 + 续写 503 + 一次续写重试');
      assert.ok(r.text.indexOf('前一轮内容') >= 0 && r.text.indexOf('续写恢复') >= 0, '保留前文并完成续写');
      assert.ok(r.turnTrace.events.some(e => e.eventType === 'model_call_retry' && e.errorCategory === 'provider' && e.httpStatus === 503), '记录续写 round 的 503 重试');
    });

  } finally {
    console.log('\n' + (failures ? 'FAILURES: ' + failures : 'ALL PASS'));
    await cleanup();
    process.exitCode = failures ? 1 : 0;
  }
})();
