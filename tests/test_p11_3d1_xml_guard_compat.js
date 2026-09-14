/* ====================================================================
   P11-3D.1 · XML Continuation Guard Compatibility（宿主回合周期所有权）
   --------------------------------------------------------------------
   窄问题：一个**宿主 AI 回合**内，原生 FC 工具通道与旧 XML 工具通道
   （正文 <ws_tool> → _execWsOps → _ibExecToolOp → _wsToolContinue →
    递归 callApiChat）是否共用**同一个** canonical 工具执行周期与预算？

   本阶段冻结的不变量（Phase 5/6）：

       ONE HOST AI TURN = ONE TOOL EXECUTION CYCLE = ONE TOTAL BUDGET

   ── 被废弃的旧模型（不掩盖）──────────────────────────────────────────
   P11-3D 把周期开在 callApiChat* 内部（"一次 callApi 调用 = 一个周期"）。
   它不成立，两条实测理由：
     ① XML 批次（宿主解析回复正文 → _execWsOps）与工具续轮（_wsToolContinue）
        都发生在 callApiChatStream **返回之后**，那一刻周期已被它的 finally 收掉
        → 这条通道全程没有周期可问，四类预算（tool-count/duplicate/retry/
        elapsed）对它全部失效，执行也不入账（观测面 toolCalls=0 而工具真的跑了）；
     ② 续轮内部又调 callApiChat，于是它自己另开一个周期 → 一个 turn 两个预算，
        轮次计数还被重置。
   P11-3D.1 把 owner 上移为"宿主 turn"，并让 guard 沿 context 显式传播。

   ── 测试形状（本阶段的核心纪律）────────────────────────────────────
   · 驱动器调用**真实宿主入口** sendChatMessage()（不是 callApiChatStream）：
     周期由生产宿主自己开、自己收，XML 批次与续轮走生产代码路径；
   · 整个场景在同**一次** browser evaluate / 同一个真实 AI turn 内完成；
   · 不预先开周期、不手工保持一个已经结束的 guard、不伪造 active=true、
     不直接调 guard API 代替生产调用链、不为让测试变绿而延长生命周期；
   · provider 与工具端点全部是本地 mock（零真实 API Key、零外网）。

   ── 仪器纪律（前两轮踩到的三个真实陷阱）────────────────────────────
   ① guard 实例是 Object.freeze 的（tool-execution-guard.js 的返回）。
      在它上面挂计数器会**静默失败**（非严格模式赋值丢弃），读数恒 0 ——
      足以把"接线正确"误读成"接线不存在"。本文件因此用**包装对象**观测
      （IBFC._newGuard 钩子 + 同名方法转发），或用冻结对象自己给出的 snapshot。
   ② _toolCycleBegin / _ibExecToolOp 是 IIFE 私有的（只有 window._ibExecToolOp
      这一份别名），无法从页面全局重新绑定；对它们的"包装"不会生效。
   ③ 不能跨 evaluate 保持一个已结束的 guard：周期实例随 turn 走，
      turn 结束后它就不再活动 —— 这是设计，不是缺陷。

   ── 承载必须是 HTTP，不能是 file:// ────────────────────────────────
   file:// 下 home-node-bootstrap 的权威整体失效，与生产不符。

   ── 运行 ────────────────────────────────────────────────────────────
     node tests/test_p11_3d1_xml_guard_compat.js
   需要 Chrome/Edge（CHROME_PATH 可指定）。
   ==================================================================== */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');

const harness = fs.readFileSync(path.join(__dirname, 'test_chat_smoke.js'), 'utf8');
const boundary = harness.indexOf('async function main() {');
assert.ok(boundary > 0, 'existing CDP harness boundary changed');
const { chromePath, Cdp, evaluate, waitFor, freePort } = new Function('require', '__dirname',
  harness.slice(0, boundary) + '\nreturn {chromePath,Cdp,evaluate,waitFor,freePort};')(require, ROOT);

let failures = 0;
let lastDiag = null;   /* 最近一次场景的原始观测（DIAG=1 时在 check 失败时打印） */
function check(name, fn) {
  return (async () => {
    try { const r = await fn(); console.log('  PASS  ' + name + (r && r.note ? '  · ' + r.note : '')); }
    catch (e) { failures++; console.error('  FAIL  ' + name + '  -> ' + (e && e.message || e)); if (DIAG && lastDiag) diagLine('FAILED', lastDiag.r, lastDiag.extra); }
  })();
}
const section = t => console.log('\n── ' + t + ' ──');
const listen = server => new Promise(r => server.listen(0, '127.0.0.1', () => r(server.address().port)));

/* 诊断输出开关：DIAG=1 时把每个场景的原始观测打印出来（默认不打印）。 */
const DIAG = process.env.DIAG === '1';
function diagLine(tag, r, extra) {
  if (!DIAG || !r) return;
  try { console.log('     · DIAG ' + tag + ' ' + JSON.stringify(Object.assign({
    cycles: r.R.cycles, turns: r.R.turns, guards: r.guardPids, newGuardCalls: r.newGuardCalls,
    errors: r.R.errors, warns: (r.R.warns || []).slice(0, 4), calls: (r.R.calls || []).slice(0, 8),
    foreground: r.R.foreground, trace: r.trace, last: r.last, breaker: r.breaker, entry: r.R.entry,
    provider: providerLog, toolPaths: toolPaths
  }, extra || {}))); } catch (e) { console.log('     · DIAG ' + tag + ' <unserializable>'); }
}

/* ── mock provider ────────────────────────────────────────────────────
   步骤按**第几次 provider 调用**取。第 1 次必然是本 turn 的首次生成；
   之后每一次按顺序对应"XML 续轮"或"原生 FC 工具轮" —— 两者共用同一个
   provider 端点，这正是生产形状（工具的协议切换不换端点）。 */
const providerLog = [];
let SCRIPT = [{ kind: 'text', text: '好的。' }];
let BG_CONSUMER = '';   /* 非空时：带该 _ibConsumer 的请求按"后台纯文本回合"应答 */

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
      const isBg = !!BG_CONSUMER && raw.indexOf('test-bg') >= 0;
      const idx = providerLog.length;
      const sysText = (() => { try { return (body.messages || []).filter(m => m && m.role === 'system').map(m => String(m.content || '')).join('\n'); } catch (_) { return ''; } })();
      providerLog.push({ stream: !!(body && body.stream === true), isBg,
        toolsOffered: !!(body && Array.isArray(body.tools) && body.tools.length),
        toolBlock: sysText.indexOf('【外部工具】') >= 0, toolsParam: !!(body && body.tools),
        model: String((body && body.model) || ''), sysLen: sysText.length });
      const step = isBg ? { kind: 'text', text: '（后台）收到。' }
        : (SCRIPT[Math.min(idx, SCRIPT.length - 1)] || { kind: 'text', text: '好的。' });
      const toolCalls = (step.calls || []).map((c, k) => ({ id: 'call_' + idx + '_' + k, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } }));

      if (body && body.stream === true) {
        res.writeHead(200, Object.assign({}, headers, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' }));
        const delta = step.kind === 'fc'
          ? { role: 'assistant', tool_calls: toolCalls.map((c, k) => ({ index: k, id: c.id, type: 'function', function: c.function })) }
          : { role: 'assistant', content: step.text || '好的。' };
        res.write('data: ' + JSON.stringify({ choices: [{ delta: delta }] }) + '\n\n');
        res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: step.kind === 'fc' ? 'tool_calls' : 'stop' }] }) + '\n\n');
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
      res.writeHead(200, headers);
      res.end(JSON.stringify({
        choices: [{
          message: { role: 'assistant', content: step.text || '好的。', tool_calls: step.kind === 'fc' ? toolCalls : undefined },
          finish_reason: step.kind === 'fc' ? 'tool_calls' : 'stop'
        }],
        usage: { prompt_tokens: 10, completion_tokens: 5 }
      }));
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

/* mock 工具端点：业务动作无关紧要，**执行次数与路径**才是本案的核心证据。 */
let toolHits = 0;
let toolPaths = [];
function startToolServer() {
  return new Promise(resolve => {
    const server = http.createServer(async (req, res) => {
      toolHits += 1;
      toolPaths.push(req.url);
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Headers', '*');
      if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, hits: toolHits }));
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

const xmlTool = (name, args) => '<ws_tool name="' + name + '" args=\'' + JSON.stringify(args) + '\'/>';
const hitsOf = p => toolPaths.filter(u => String(u).indexOf(p) === 0).length;

(async () => {
  const provider = await startProvider();
  const apiBase = 'http://127.0.0.1:' + provider.port;
  const toolSrv = await startToolServer();
  const toolBase = 'http://127.0.0.1:' + toolSrv.port;

  const web = require(path.join(ROOT, 'services', 'internal-beyond-server.js')).createWebServer({ root: ROOT, port: 0 });
  const webPort = await listen(web), webBase = 'http://127.0.0.1:' + webPort;

  /* ── 真实的 Home Node（不是 mock）──────────────────────────────────────
     sendChatMessage 的第一步就是 dbPut('chatMessages')，而 chatMessages 是
     Home Node 的 canonical 域（home-node-bootstrap.js:226）：
     权威不可达时它**拒绝写入**（fail closed，不是静默降级）。因此要驱动真实
     宿主回合，就必须有真实的 Home Node 在跑 —— 这同时保证了本用例测的是
     生产承载，而不是一条被降级过的路径。 */
  const homePort = await freePort();
  const homeDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-p113d1-home-'));
  const homeNode = spawn(process.execPath, ['services/home-node-service.js'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { IB_HOME_NODE_PORT: String(homePort), IB_HOME_NODE_DATA_DIR: homeDataDir }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let homeOut = '';
  homeNode.stdout.on('data', c => homeOut += c);
  homeNode.stderr.on('data', c => homeOut += c);
  const homeBase = 'http://127.0.0.1:' + homePort;
  let homeReady = false;
  for (let i = 0; i < 200; i++) {
    try { const r = await fetch(homeBase + '/health'); if (r.ok) { homeReady = true; break; } } catch (_) {}
    await new Promise(r => setTimeout(r, 100));
  }
  assert.ok(homeReady, 'Home Node 未就绪（chatMessages 是它的 canonical 域，写被拒就无法驱动真实回合）：' + homeOut.slice(-400));

  const debugPort = await freePort();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-p113d1-'));
  const chrome = chromePath();
  assert.ok(chrome, '需要 Chrome 或 Edge（CHROME_PATH 可指定）');
  const browser = spawn(chrome, ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    '--remote-debugging-port=' + debugPort, '--user-data-dir=' + profile, 'about:blank'],
    { stdio: 'ignore', windowsHide: true });

  let cdp = null;
  const cleanup = async () => {
    try { if (cdp) cdp.close(); } catch (_) {}
    try { browser.kill(); } catch (_) {}
    try { homeNode.kill(); } catch (_) {}
    try { provider.server.close(); } catch (_) {}
    try { toolSrv.server.close(); } catch (_) {}
    try { web.close(); } catch (_) {}
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_) {}
    try { fs.rmSync(homeDataDir, { recursive: true, force: true }); } catch (_) {}
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
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `try{localStorage.setItem("ib_home_node_http",${JSON.stringify(homeBase)});localStorage.setItem("ib_home_node_mode","canonical");}catch(e){}`
        + `const _of=window.fetch.bind(window);window.fetch=function(input,opts){const u=new URL(typeof input==='string'?input:input.url,location.href);`
        + `if(u.origin!==${JSON.stringify(apiBase)}&&u.origin!==${JSON.stringify(toolBase)}&&u.origin!==${JSON.stringify(webBase)}&&u.origin!==${JSON.stringify(homeBase)})return Promise.reject(new Error('p11-3d1 blocks external service'));return _of(input,opts);};`
        + `window.confirm=()=>true;`
    });
    await cdp.send('Page.navigate', { url: webBase + '/InternalBeyond.html' });
    const pageReady = await waitFor(cdp, "document.readyState==='complete' && window.IB && typeof IBFC!=='undefined' && typeof IBToolGuard!=='undefined' && typeof apiConfigs!=='undefined' && typeof sendChatMessage==='function'", 30000);
    if (!pageReady) {
      const diag = await evaluate(cdp, `(function(){return {ready:document.readyState,hasIB:!!window.IB,ibfc:typeof IBFC,tg:typeof IBToolGuard,api:typeof apiConfigs,scm:typeof sendChatMessage,url:location.href};})()`).catch(e => ({ err: String(e && e.message || e) }));
      console.error('  页面加载诊断：' + JSON.stringify(diag));
    }
    assert.ok(pageReady, '页面加载完成且 guard 模块已挂载');
    const origin = await evaluate(cdp, `(function(){return location.protocol})()`);
    assert.equal(origin, 'http:', '必须跑在 HTTP 承载上（file:// 下权威整体失效）');

    /* ── 夹具自检 ────────────────────────────────────────────────── */
    const setup = await evaluate(cdp, `(async function(){
      try{ localStorage.setItem('ib_fcMode','auto'); localStorage.setItem('ib_fcRounds','3'); }catch(e){}
      var cfg={id:'ibTools',enabled:true,confirm:false,tools:[
        {id:'t1',name:'check_status',desc:'查询状态',params:'key',method:'GET',url:${JSON.stringify(toolBase + '/status?key={{key}}')},headers:'',body:''},
        {id:'t2',name:'ping_host',desc:'探活',params:'host',method:'GET',url:${JSON.stringify(toolBase + '/ping?host={{host}}')},headers:'',body:''}]};
      /* 两个 API 配置：主对话角色 + 后台回合的消费者（并发隔离场景要用到不同实例）。 */
      var api={id:'p3d1',provider:'custom',nickname:'测试',endpoint:${JSON.stringify(apiBase + '/v1/chat/completions')},model:'mock-3d1',apiKey:'sk-local-mock-not-a-real-credential',temperature:0.2};
      var apiBg={id:'p3d1bg',provider:'custom',nickname:'后台',endpoint:${JSON.stringify(apiBase + '/v1/chat/completions')},model:'mock-3d1bg',apiKey:'sk-local-mock-not-a-real-credential',temperature:0.2};
      /* 顺序有讲究：dbPut('apiConfigs') 会重载内存里的 apiConfigs（直接 push 会被冲掉），
         所以必须"先落库、后 push"，否则 callApiChat 拿到的 cfg 是 undefined。 */
      await dbPut('apiConfigs',api);
      await dbPut('apiConfigs',apiBg);
      apiConfigs=apiConfigs.filter(function(a){return a.id!=='p3d1'&&a.id!=='p3d1bg'});
      apiConfigs.push(api); apiConfigs.push(apiBg);
      await saveIbTools(cfg);
      var saved=await getIbTools();
      var cfgSeen=apiConfigs.find(function(a){return a.id==='p3d1'});
      /* DOM 夹具：sendChatMessage 需要输入框/发送按钮/消息容器（生产页面里由 HTML 提供）。 */
      function mk(tag,id,parent){var el=document.createElement(tag);if(id)el.id=id;(parent||document.body).appendChild(el);return el;}
      mk('textarea','chat-input'); mk('button','chat-send-btn');
      mk('div','chat-messages'); mk('div','chat-full-messages');
      var fc=null;
      try{
        var _msgs=[{role:'system',content:'你是测试角色。\\n【外部工具】check_status / ping_host 可用。'},{role:'user',content:'hi'}];
        var _c=IBFC.prepare(_msgs,'openai',{vision:false});
        fc={preparedActive:!!_c.active, toolsList:(_c.tools&&_c.tools.list)?_c.tools.list.length:-1};
      }catch(e){ fc={err:String(e&&e.message||e)}; }
      var guardFrozen=null; try{ var g=IBFC._syncGuardPolicy(); guardFrozen=Object.isFrozen(g); }catch(e){ guardFrozen='err'; }
      /* 宿主回合作用域的**能力探针**：_ibTurnScope/_ibTurnLc 是 IIFE 私有的
         （不挂 window），因此不能从页面全局重新绑定；而 bridge.js 会把
         window.sendChatMessage 再包一层（清 /continue 续写计时器）。
         因此这里只能断言一个**可观测的能力**：页面里确实存在一个会把调用
         委托给真入口的 sendChatMessage（真入口的接线由行为断言 A–H 证明）。 */
      var scmSrc=''; try{ scmSrc=Function.prototype.toString.call(sendChatMessage); }catch(e){}
      var delegates=scmSrc.indexOf('orig.apply')>=0||scmSrc.indexOf('function sendChatMessage')>=0;
      return {tools:(saved.tools||[]).length, enabled:!!saved.enabled, confirm:!!saved.confirm, fc:fc,
        cfgOk:!!(cfgSeen&&cfgSeen.endpoint&&cfgSeen.model), bgCfgOk:!!apiConfigs.find(function(a){return a.id==='p3d1bg'}),
        cfgCount:apiConfigs.length, guardFrozen:guardFrozen,
        execToolOpLen:window._ibExecToolOp?window._ibExecToolOp.length:-1,
        hostEntryDelegates:delegates, scmLen:scmSrc.length,
        contMax:(typeof window._WS_TOOL_CONT_MAX!=='undefined')?window._WS_TOOL_CONT_MAX:'undefined'};
    })()`);
    console.log('  · 夹具自检：FC 激活=' + JSON.stringify(setup.fc) + ' · guardFrozen=' + setup.guardFrozen
      + ' · _ibExecToolOp.length=' + setup.execToolOpLen + ' · apiConfigs=' + setup.cfgCount
      + ' · _WS_TOOL_CONT_MAX=' + setup.contMax + ' · sendChatMessage.src=' + setup.scmLen + 'B'
      + ' · 委托=' + setup.hostEntryDelegates);
    assert.equal(setup.tools, 2, '工具配置落库');
    assert.equal(setup.enabled, true, '工具已启用');
    assert.equal(setup.confirm, false, '工具免确认');
    assert.equal(setup.cfgOk, true, 'API 配置在内存里可被 callApiChat 取到（顺序：先 dbPut 后 push）');
    assert.equal(setup.bgCfgOk, true, '后台回合的第二个 API 配置就绪');
    assert.equal(setup.fc.preparedActive, true, 'FC 必须真的激活，否则周期不会被开启，测的就不是生产形状');
    assert.equal(setup.guardFrozen, true, 'guard 实例是冻结的（因此任何"在 guard 上挂计数器"的仪器都是无效仪器）');
    assert.equal(setup.execToolOpLen, 3, '_ibExecToolOp 已是三参签名（ictx 已接线）');
    assert.equal(setup.hostEntryDelegates, true, 'window.sendChatMessage 仍把调用委托给生产宿主入口（bridge 包装不吞调用）');


    /* ================================================================
       场景驱动器 —— 单次 evaluate 内跑完整个真实宿主回合
       ================================================================ */
    async function runTurn(opt) {
      SCRIPT = opt.script;
      BG_CONSUMER = opt.bgConsumer || '';
      toolHits = 0; toolPaths = [];
      providerLog.length = 0;
      return await evaluate(cdp, `(async function(){
        var R={steps:[],cycles:[],ends:[],calls:[],warns:[],guards:[],turns:[],contErr:'',bg:null,errors:[]};
        var _ow=console.warn;
        console.warn=function(){ try{ R.warns.push(Array.prototype.slice.call(arguments).map(String).join(' ').slice(0,240)); }catch(e){} return _ow.apply(console,arguments); };

        /* guard 策略按本场景重建（设置是唯一事实源；重建只发生在非活动期）。 */
        try{ localStorage.setItem('ib_fcRounds',String(${opt.rounds === undefined ? 3 : opt.rounds})); localStorage.removeItem('ib_fcToolTimeoutMs'); }catch(e){}
        try{
          if(${opt.maxToolCalls === undefined ? 'null' : opt.maxToolCalls}!=null)localStorage.setItem('ib_fcMaxToolCalls',String(${opt.maxToolCalls === undefined ? '0' : opt.maxToolCalls}));
          else localStorage.removeItem('ib_fcMaxToolCalls');
        }catch(e){}
        IBFC._tdGuard=null; IBFC._tdPolicyJson=null; IBFC._tdReason=''; IBFC._tdLast=null; IBFC._tdTrace=[];

        /* ── 仪器：只包**可达**的生产入口，且不改被测对象内部状态 ── */
        var _ong=IBFC._newGuard, _ob=IBFC.cycleBegin, _oe=IBFC.cycleEnd;
        var _owc=window._wsToolContinue;
        var guarded=function(g){
          if(!g)return g;
          try{
            /* 注意：guard 实例本身是 Object.freeze 的（tool-execution-guard.js），
               往它上面挂任何东西都会抛（严格模式下不可扩展对象的 defineProperty）。
               因此这里既不改它、也不包它 —— 而是**再冻结一层转发代理**：
               生产拿到的仍然是"一个 guard 形状的冻结对象"，方法逐一转发。
               这正是本阶段第三个真实仪器陷阱。 */
            var w={
              __ibPid:'G'+(R.guards.length+1),
              beforeCall:function(){ R.calls.push({kind:'before',name:String(arguments[0])}); return g.beforeCall.apply(g,arguments); },
              settleCall:function(){ R.calls.push({kind:'settle',name:String(arguments[0])}); return g.settleCall.apply(g,arguments); },
              snapshot:function(){ return g.snapshot(); },
              active:function(){ return g.active(); },
              tripped:function(){ return g.tripped(); },
              tripInfo:function(){ return g.tripInfo(); },
              policy:function(){ return g.policy(); },
              trace:function(){ return g.trace(); },
              startCycle:function(){ return g.startCycle.apply(g,arguments); },
              beforeRound:function(){ return g.beforeRound.apply(g,arguments); },
              afterRound:function(){ return g.afterRound.apply(g,arguments); },
              endCycle:function(){ return g.endCycle(); },
              noteElapsed:function(){ return g.noteElapsed(); },
              lastBreaker:function(){ return g.lastBreaker(); },
              breakerHistory:function(){ return g.breakerHistory(); },
              afterCall:function(){ return g.afterCall.apply(g,arguments); }
            };
            R.guards.push(w);
            return Object.freeze(w);
          }catch(e){ R.errors.push('wrap:'+String(e&&e.message||e)); return g; }
        };
        IBFC._newGuard=function(){ R.newGuardCalls=(R.newGuardCalls||0)+1; return guarded(_ong.apply(IBFC,arguments)); };
        var snapOf=function(g){ try{ if(!g)return null; var s=g.snapshot(); return {guard:g.__ibPid||'(foreign)',active:!!s.active,cycle:s.cycle,toolCalls:s.toolCalls,distinct:s.distinctCalls,
          duplicates:s.duplicates,retries:s.retries,rounds:s.rounds,maxRounds:s.maxRounds,maxToolCalls:s.maxToolCalls,tripped:!!s.tripped,breakerReason:s.breakerReason}; }catch(e){ return {err:String(e&&e.message||e)}; } };
        /* 全局指针 _tdGuard 在 P11-3D.1 之后只是"最近分配的那个"，而且周期结束后
           它的 snapshot 会返回 0（周期状态已清）。因此**本回合的账本**只能从
           turn 自己的实例上读 —— 且必须在周期仍活动时读。这里在 cycleEnd 探针里
           把那一份快照按 turn 存下来（这就是"这一次回合到底发生了什么"的终值）。 */
        var mark=function(tag){ R.steps.push({tag:tag,snap:snapOf(IBFC._tdGuard)}); };
        /* cycleBegin 探针：只记录**谁开了周期**（ctx 上带 turn 且 ownsCycle 的那个）。 */
        var _tid=0;
        var turnIdOf=function(t){ if(!t)return null; if(!t.__ibTid){ try{ Object.defineProperty(t,'__ibTid',{value:'T'+(++_tid),enumerable:false,configurable:true}); }catch(e){ return 'T?'; } } return t.__ibTid; };
        /* 第一个开了周期的 turn = 本场景的宿主回合（前台）。 */
        var foreTid=null;
        /* 注意：callApiChatStream / callApiChat 的**词法**引用无法从页面里替换
           （宿主闭包直接引用它们，window 上的同名属性不是同一个）。可替换的是
           它们内部调用的 _ibTurnOf / _ibTurnScope —— 这两个才是传播链的观察点。 */
        R.entry=[];
        /* _ibTurnOf / _ibTurnScope 是模块私有的：页面 eval 的后缀代码**不在**
           生产模块的作用域里，所以不能替换它们；对它们的观测只能靠行为断言。 */
        IBFC.cycleBegin=function(ctx,meta,turn){
          var owns=!!(turn&&turn.ownsCycle===true);
          var preGuard=(turn&&turn.guard)?(turn.guard.__ibPid||'(foreign)'):null;
          var r=_ob.call(IBFC,ctx,meta,turn);
          R.cycles.push({tid:turnIdOf(turn),turnLabel:(turn&&turn.label)||null,ownsCycle:owns,ctxIsTurn:(ctx===turn),
            preGuard:preGuard,guard:r?(r.__ibPid||'(foreign)'):null,cycle:(r&&r.snapshot)?r.snapshot().cycle:null,
            opened:!!(ctx&&ctx._guardCycle),ctxActive:!!(ctx&&ctx.active)});
          if(owns&&turn){ var _tguard=r?(r.__ibPid||'(foreign)'):null;
            R.turns.push({tid:turnIdOf(turn),label:turn.label,guard:_tguard}); R.__oldTurn=turn;
            /* 前台 = **第一个真正拿到周期实例**的那个 turn（第一次 cycleBegin 可能
               在 FC 未激活时返回 null，那不是它）。foreTid 只钉 turn 身份，
               guard 则一直补到拿到为止。 */
            if(foreTid===null)foreTid=turnIdOf(turn);
            if(!R.foregroundGuard&&_tguard){ R.foregroundGuard=_tguard; R.foreTid=foreTid; } }
          return r;
        };
        IBFC.cycleEnd=function(turn){ var tid=turnIdOf(turn);
          /* 先读"本回合的账本"（周期还活动），再交给生产收尾。 */
          if(tid===foreTid&&turn&&turn.guard)R.foreground=snapOf(turn.guard);
          var r=_oe.call(IBFC,turn);
          R.ends.push({tid:tid,ownsCycle:!!(turn&&turn.ownsCycle===true),before:R.foreground||null,after:snapOf(turn&&turn.guard)}); return r; };
        window._wsToolContinue=function(cfg,o){ var p=_owc.apply(null,arguments); return Promise.resolve(p); };

        var cfg=apiConfigs.find(function(a){return a.id==='p3d1'});
        var cfgBg=apiConfigs.find(function(a){return a.id==='p3d1bg'});
        activeFriendId='p3d1';

        /* ① 真实宿主回合：sendChatMessage 是生产入口，周期由它自己开、自己收。
              消息里必须带文件类关键词 —— 站点上下文据此注入【外部工具】块，
              FC 才会真的激活（否则测的是一条不激活工具的路径）。 */
        var input=document.getElementById('chat-input');
        input.value=${JSON.stringify(opt.userText || '请帮我处理一下这个文件')};
        var t0=Date.now();
        var sendRes=null, sendErr='';
        try{ sendRes=await sendChatMessage(); }catch(e){ sendErr=String(e&&e.message||e); }
        R.turnErr=sendErr;
        R.sendOk=!!(sendRes&&sendRes.ok!==false);
        R.turnMs=Date.now()-t0;
        /* 本回合的账本终值：由 cycleEnd 探针在周期仍活动时读下（见 foreTid）。 */
        R.final=null;
        R.turnOwnedCount=R.ends.filter(function(e){return e.ownsCycle;}).length;
        mark('after-host-turn');

        /* ② 后台回合（可选）：与前台**同时在飞**，而且自己也要激活工具块 ——
              否则它不会拥有任何预算，"隔离"也就无从谈起（没有实例就没有可被偷的东西）。
              做法：趁前台还挂着的时候先把它发出去（不 await），事件循环让出的每一次
              await 都是两回合交错的机会 —— 这正是"并发"在这个产品里的真实形状
              （单线程 + await 交错）。必须在仪器拆除**之前**完成。
              后台走的是**生产路径**（callApiChat → _toolCycleBegin → _ibTurnGuard），
              周期由生产按需开启，这里不手工开关。 */
        if(${opt.background ? 'true' : 'false'}){
          var bgOut='', bgErr='';
          var _bgTurn={__ibTurnScope:true,label:'background',ownsCycle:true,guard:null,_guardCycle:false,active:false,round:0,ledger:{},nameMap:{},calls:[],tools:null,_acc:null};
          /* 自己构造的消息必须显式带工具块 —— 工具块平时由 buildChatContext 注入，
             这里手搓 messages 就得自己给（否则 FC 不激活，后台回合没有任何预算，
             "隔离"也就无从观测）。 */
          var _bgMsgs=[{role:'system',content:'你是测试角色。\\n【外部工具】check_status / ping_host 可用。'},{role:'user',content:'(后台主动消息)'}];
          var _bgP=callApiChat(cfgBg,_bgMsgs,
            {_ibConsumer:'test-bg',autoContinue:false,disableTools:false,result:{},wantMeta:true,_ibTurn:_bgTurn});
          try{ var bgText=await _bgP; bgOut=(bgText&&bgText.text)||''; }
          catch(e){ bgErr=String(e&&e.message||e); }
          /* 后台回合自己的账本：它的周期**没有**被收（后台没有宿主 finally，
             这与"一个宿主回合"的语义一致：宿主不在，周期就留在那儿）。
             这里直接在页面里读它的快照并以**纯数据**返回 —— 不要跨 realm 去
             typeof / Object.isFrozen 去判别别的东西（CDP 的返回值是结构化克隆出来的，
             那类判据会给出误导性的答案，本阶段真实踩到过）。 */
          var _bgSnap=null; try{ _bgSnap=_bgTurn.guard?_bgTurn.guard.snapshot():null; }catch(e){}
          R.bg={text:String(bgOut).slice(0,40),err:bgErr,turnGuard:(_bgTurn.guard&&_bgTurn.guard.__ibPid)||'(no-guard)',
            snap:_bgSnap?{active:!!_bgSnap.active,cycle:_bgSnap.cycle,toolCalls:_bgSnap.toolCalls,distinct:_bgSnap.distinctCalls,
              rounds:_bgSnap.rounds,duplicates:_bgSnap.duplicates,retries:_bgSnap.retries,tripped:!!_bgSnap.tripped,
              breakerReason:_bgSnap.breakerReason,maxToolCalls:_bgSnap.maxToolCalls}:null,
            forePid:R.foregroundGuard,guards:R.guards.map(function(g){return g.__ibPid;}),cycles:R.cycles.length,ends:R.ends.length};
        }

        /* ③ 宿主回合结束后，用**同一个旧 turn** 再走一次 XML 通道：必须 fail closed。
              turn 对象在本轮里从 cycleBegin 探针捕获（ownsCycle 的那个），
              它不是"某个变量恰好还活着"，而是**生产自己用的那个引用**。 */
        var stale=null;
        if(${opt.staleTurn ? 'true' : 'false'}){
          var oldTurn=R.__oldTurn||null;
          var endedBefore=!!(oldTurn&&!oldTurn.guard);
          try{
            var sr=await window._wsToolContinue(cfg,{messages:[{role:'user',content:'x'}],
              lastReply:${JSON.stringify(opt.staleReply || xmlTool('ping_host', { host: 'h-stale' }))},
              friendId:'p3d1',chatKey:'p3d1',senderName:'测试',round:1,_ibTurn:oldTurn});
            stale={ok:true,ret:(sr===null?'null':'obj')};
          }catch(e){ stale={ok:false,err:String(e&&e.message||e)}; }
          R.staleOk=!!(stale&&stale.ok);
          R.staleEnded=endedBefore;
          R.staleRet=stale?stale.ret:'';
        }
        R.stale=null;

        var trace=[]; try{ var tr=IBFC._tdTrace||[]; for(var i=0;i<tr.length;i++){ var e=tr[i]; if(!e)continue;
          if(e.t==='call')trace.push('call:'+e.name); else if(e.t==='round')trace.push('round:'+e.n); else if(e.t==='trip')trace.push('trip:'+e.reason); } }catch(e){}

        IBFC._newGuard=_ong; IBFC.cycleBegin=_ob; IBFC.cycleEnd=_oe; window._wsToolContinue=_owc; console.warn=_ow;
        R.entry=[];
        R.entry=R.entry||[];
        return {R:R, tdx:(typeof _ibTurnOf==='function')?1:0, trace:trace, newGuardCalls:R.newGuardCalls||0,
          guardPids:R.guards.map(function(g){ return g.__ibPid; }),
          last:IBFC._tdLast?{cycle:IBFC._tdLast.cycle,toolCalls:IBFC._tdLast.toolCalls,distinct:IBFC._tdLast.distinctCalls,
            duplicates:IBFC._tdLast.duplicates,retries:IBFC._tdLast.retries,rounds:IBFC._tdLast.rounds,
            maxRounds:IBFC._tdLast.maxRounds,maxToolCalls:IBFC._tdLast.maxToolCalls,tripped:!!IBFC._tdLast.tripped,
            breakerReason:IBFC._tdLast.breakerReason}:null,
          breaker:IBFC.breakerReason()};
      })()`);
    }

    /* 场景驱动器 wrapper：**故意破坏生产源码**时，页面里的一整段逻辑可能直接抛
       （例如嵌套调用抢走了周期，后续 cycleBegin 拿到 null 又在探针里读它的 snapshot）。
       那种异常如果冒泡到顶层，整个文件会以 HARNESS ERROR 结束、一条 FAIL 都不打印，
       变异判定就无从区分"抓住"与"没抓住"。把它收敛成一条**明确的断言失败**：
       异常本身就是最直接的证据（该回合没能按不变量完成）。 */
    async function driveTurn(opt) {
      try { return await runTurn(opt); }
      catch (e) { throw new Error('宿主回合在场景中途异常终止（不变量被破坏）：' + String(e && e.message || e)); }
    }

    /* "周期数"只能数**真的开了新周期**的次数（opened）：继承者那几次 cycleBegin
       也是合法调用（它把 turn 上已有的实例绑到自己的 ctx 上），不该算作第二个预算。 */
    const cyclesOpened = r => r.R.cycles.filter(c => c.opened).length;
    const use = r => { lastDiag = { r: r }; return r; };
    const guardSnap = (r, pid) => { const w = r.R.guards.find(g => g.__ibPid === pid); return w ? (() => { const s = w.snapshot(); return { active: !!s.active, cycle: s.cycle, toolCalls: s.toolCalls, distinct: s.distinctCalls, rounds: s.rounds, maxRounds: s.maxRounds, maxToolCalls: s.maxToolCalls, tripped: !!s.tripped, breakerReason: s.breakerReason }; })() : null; };
    const settleCount = r => r.R.calls.filter(c => c.kind === 'settle').length;
    const beforeCount = r => r.R.calls.filter(c => c.kind === 'before').length;

    /* ================================================================
       A · FC only：一个宿主 turn，一个周期
       ================================================================ */
    section('A · FC only（原生通道）：一个宿主回合 = 一个周期');

    let A = null;
    await check('A1 FC 工具在宿主回合内执行，且计入本回合 canonical 账本', async () => {
      A = await driveTurn({
        rounds: 3,
        userText: '请帮我处理一下这个文件',
        script: [
          { kind: 'fc', calls: [{ name: 'check_status', args: { key: 'fc-only' } }] },
          { kind: 'text', text: '已经处理好了。' }
        ]
      });
      lastDiag = { r: A };
      assert.equal(A.R.turnErr, '', '宿主回合没有抛错，turnErr=' + JSON.stringify(A.R.turnErr));
      diagLine('A1', A);
      assert.equal(toolHits, 1, 'FC 工具真的被执行了一次（实际 ' + toolHits + ' · paths=' + JSON.stringify(toolPaths) + '）');
      assert.equal(A.R.turnOwnedCount, 1, '宿主回合的周期**收尾有效且恰好一次**（实际 ' + A.R.turnOwnedCount + '）');
      const fg = A.R.foreground;
      assert.ok(fg, '捕获到本回合的 guard 快照');
      assert.equal(fg.toolCalls, 1, 'canonical 账本 toolCalls=1（实际 ' + fg.toolCalls + '）');
      assert.equal(fg.distinct, 1, '指纹账本 distinct=1');
      return { note: 'toolHits=' + toolHits + ' toolCalls=' + fg.toolCalls + ' rounds=' + fg.rounds + '/' + fg.maxRounds
        + ' | newGuardCalls=' + A.newGuardCalls + ' pids=' + JSON.stringify(A.guardPids)
        + ' errors=' + JSON.stringify(A.R.errors) + ' forecast=' + JSON.stringify(A.R.foreground)
        + ' turns=' + JSON.stringify(A.R.turns) + ' provider=' + JSON.stringify(providerLog) };
    });

    await check('A2 FC-only 的周期数恰为 1（没有第二个预算）', async () => {
      assert.equal(cyclesOpened(A), 1, '本回合只**开了** 1 个周期（继承式的 cycleBegin 调用不算新预算），实际 ' + JSON.stringify(A.R.cycles));
      assert.equal(A.R.cycles.filter(c => c.ctxIsTurn).length, 1, '首次开周期时 ctx 就是那个 turn（owner 传入）');
      assert.equal(new Set(A.R.turns.map(t => t.tid)).size, 1, '只有一个 turn 实例拥有周期：' + JSON.stringify(A.R.turns));
      assert.equal(A.R.turns[A.R.turns.length - 1].guard, 'G1', '且该 turn 上的实例自始至终是同一个（G1）');
      assert.equal(A.R.turnOwnedCount, 1, '宿主只收尾一次（cycleEnd 有效一次）');
      assert.equal(A.trace.filter(t => t.indexOf('round:') === 0).length >= 1, true, '账本里有轮次记录：' + JSON.stringify(A.trace));
      return { note: 'cycles=' + JSON.stringify(A.R.cycles.map(c => c.tid + ':' + c.guard + ':' + c.cycle + (c.opened ? '(opened)' : '(inherit)'))) + ' ends=' + A.R.turnOwnedCount };
    });

    /* ================================================================
       B · XML only：XML 工具执行必须入账，四类预算生效
       ================================================================ */
    section('B · XML only（旧通道）：执行入账 + 四类预算生效');

    let B = null;
    await check('B1 XML 工具执行数 == canonical 账本 toolCalls（旧 P11-3D.1 目标断言，现已达成）', async () => {
      B = await driveTurn({
        rounds: 3,
        userText: '请帮我处理一下这个文件',
        xmlReply: true,
        script: [
          { kind: 'text', text: xmlTool('check_status', { key: 'xml-only' }) + '\n已经处理好了。' },
          { kind: 'text', text: '收尾完成。' }
        ]
      });
      assert.equal(B.R.turnErr, '', '宿主回合没有抛错，turnErr=' + JSON.stringify(B.R.turnErr));
      assert.equal(toolHits, 1, 'XML 工具真的被执行了一次（实际 ' + toolHits + ' · paths=' + JSON.stringify(toolPaths) + '）');
      assert.ok(B.R.turnOwnedCount >= 1, '宿主回合的周期收尾有效（实际 ' + B.R.turnOwnedCount + '）');
      const fg = B.R.foreground;
      assert.ok(fg, '捕获到本回合的 guard 快照');
      assert.equal(fg.toolCalls, toolHits, 'XML 执行数必须等于 canonical 账本 toolCalls（真实执行 ' + toolHits + ' · 账本 ' + fg.toolCalls + '）');
      return { note: 'toolHits=' + toolHits + ' toolCalls=' + fg.toolCalls + ' distinct=' + fg.distinct };
    });

    await check('B2 XML-only 也是 1 个周期，且 no-active-cycle 未出现（工具是被裁定的，不是被拒绝的）', async () => {
      assert.equal(cyclesOpened(B), 1, '本回合只开过 1 个周期，实际 ' + JSON.stringify(B.R.cycles));
      assert.equal(B.R.turnOwnedCount, 1, '宿主只收尾一次');
      assert.ok(B.R.calls.filter(c => c.kind === 'before' && c.name === 'check_status').length >= 1,
        'beforeCall 真的被调用过（授权点可达）：' + JSON.stringify(B.R.calls));
      assert.ok(B.R.calls.filter(c => c.kind === 'settle' && c.name === 'check_status').length === 1,
        'settleCall 恰好一次（一次执行只结算一次）：' + JSON.stringify(B.R.calls));
      assert.ok(B.R.warns.join(' ').indexOf('no-active-cycle') < 0, '全程没有 no-active-cycle，warns=' + JSON.stringify(B.R.warns));
      assert.equal(B.R.stale, null, '本场景未做 stale 探针');
      return { note: 'before=' + beforeCount(B) + ' settle=' + settleCount(B) + ' cycles=1' };
    });

    /* ================================================================
       C/D/E · 混合协议：XML→FC、FC→XML、递归混合 —— 全部只有一个周期
       ================================================================ */
    section('C/D/E · 混合协议：共享 cycle id / rounds / toolCalls / 去重与重试状态');

    let C = null, D = null, E = null;
    await check('C XML → FC：两条通道共用同一个周期实例与账本', async () => {
      C = await driveTurn({
        rounds: 5,
        userText: '请帮我处理一下这个文件',
        script: [
          { kind: 'text', text: xmlTool('check_status', { key: 'c-xml' }) + '\n先查了状态。' },      /* 首轮：XML 工具 */
          { kind: 'fc', calls: [{ name: 'ping_host', args: { host: 'c-fc' } }] },                    /* 续轮内：原生 FC 工具 */
          { kind: 'text', text: '两件事都完成了。' }
        ]
      });
      assert.equal(C.R.turnErr, '', '宿主回合没有抛错，turnErr=' + JSON.stringify(C.R.turnErr));
      assert.equal(toolHits, 2, '两条通道各执行一次（实际 ' + toolHits + ' · paths=' + JSON.stringify(toolPaths) + '）');
      assert.equal(hitsOf('/status'), 1, 'XML 通道的 check_status 被执行');
      assert.equal(hitsOf('/ping'), 1, 'FC 通道的 ping_host 被执行');
      const fg = C.R.foreground;
      assert.equal(fg.toolCalls, 2, '两条通道记在**同一个**账本上：toolCalls=2（实际 ' + fg.toolCalls + '）');
      assert.equal(fg.distinct, 2, '两种工具各占一个指纹：distinct=2');
      assert.equal(cyclesOpened(C), 1, 'XML→FC 依旧只有 1 个周期，实际 ' + JSON.stringify(C.R.cycles));
      assert.equal(C.R.turnOwnedCount, 1, '宿主回合只收尾一次（实际 ' + C.R.turnOwnedCount + '）');
      return { note: 'toolCalls=' + fg.toolCalls + ' rounds=' + fg.rounds + '/' + fg.maxRounds + ' distinct=' + fg.distinct };
    });

    await check('D FC → XML：顺序反过来同样共用同一周期与账本', async () => {
      D = await driveTurn({
        rounds: 5,
        userText: '请帮我处理一下这个文件',
        script: [
          { kind: 'fc', calls: [{ name: 'check_status', args: { key: 'd-fc' } }] },
          { kind: 'text', text: xmlTool('ping_host', { host: 'd-xml' }) + '\n顺便探活。' },
          { kind: 'text', text: '都完成了。' }
        ]
      });
      assert.equal(D.R.turnErr, '', '宿主回合没有抛错，turnErr=' + JSON.stringify(D.R.turnErr));
      assert.equal(toolHits, 2, '两条通道各执行一次（实际 ' + toolHits + ' · paths=' + JSON.stringify(toolPaths) + '）');
      const fg = D.R.foreground;
      assert.equal(fg.toolCalls, 2, 'FC→XML 共用账本：toolCalls=2（实际 ' + fg.toolCalls + '）');
      assert.equal(cyclesOpened(D), 1, 'FC→XML 依旧只有 1 个周期，实际 ' + JSON.stringify(D.R.cycles));
      return { note: 'toolCalls=' + fg.toolCalls + ' rounds=' + fg.rounds + '/' + fg.maxRounds };
    });

    await check('E XML → 递归 XML → FC：无论递归多少层，周期数始终 = 1', async () => {
      E = await driveTurn({
        rounds: 5,
        userText: '请帮我处理一下这个文件',
        script: [
          { kind: 'text', text: xmlTool('check_status', { key: 'e-1' }) + '\n第一步。' },
          { kind: 'text', text: xmlTool('ping_host', { host: 'e-2' }) + '\n第二步。' },
          { kind: 'fc', calls: [{ name: 'check_status', args: { key: 'e-3' } }] },
          { kind: 'text', text: '全部完成。' }
        ]
      });
      assert.equal(E.R.turnErr, '', '宿主回合没有抛错，turnErr=' + JSON.stringify(E.R.turnErr));
      assert.ok(toolHits >= 2, '多层递归续轮里工具真的被执行（实际 ' + toolHits + ' · paths=' + JSON.stringify(toolPaths) + '）');
      assert.equal(cyclesOpened(E), 1, '递归再多层也只有 1 个周期，实际 ' + JSON.stringify(E.R.cycles));
      const fg = E.R.foreground;
      assert.equal(fg.toolCalls, toolHits, '账本与真实执行一致（执行 ' + toolHits + ' · 账本 ' + fg.toolCalls + '）');
      return { note: 'toolHits=' + toolHits + ' toolCalls=' + fg.toolCalls + ' cycles=' + cyclesOpened(E) + ' rounds=' + fg.rounds };
    });

    /* ================================================================
       F · budget exhaustion：协议切换不得重置预算
       ================================================================ */
    section('F · 混合协议的真实执行次数上限（计数账本）');

    let F = null;
    await check('F1 FC→XML→FC→XML：协议切换不重置计数（账本 == 真实执行次数，且 <= maxToolCalls）', async () => {
      F = await driveTurn({
        rounds: 6,
        maxToolCalls: 3,
        userText: '请帮我处理一下这个文件',
        script: [
          { kind: 'fc', calls: [{ name: 'check_status', args: { key: 'f-1' } }] },
          { kind: 'text', text: xmlTool('ping_host', { host: 'f-2' }) + '\n继续。' },
          { kind: 'fc', calls: [{ name: 'check_status', args: { key: 'f-3' } }] },
          { kind: 'text', text: xmlTool('ping_host', { host: 'f-4' }) + '\n继续。' },
          { kind: 'text', text: '收尾。' }
        ]
      });
      assert.equal(F.R.turnErr, '', '宿主回合没有抛错，turnErr=' + JSON.stringify(F.R.turnErr));
      const fg = F.R.foreground;
      assert.ok(fg, '捕获到本回合的 guard 快照');
      assert.ok(fg.toolCalls <= fg.maxToolCalls, '账本不得超过 canonical 上限（' + fg.toolCalls + ' <= ' + fg.maxToolCalls + '）');
      assert.equal(fg.toolCalls, toolHits, '混合协议下账本仍等于真实执行次数（执行 ' + toolHits + ' · 账本 ' + fg.toolCalls + '）');
      /* 熔断必须**真的**把后续执行挡住（不只是记一个标记）：
         真实执行次数恰好等于 canonical 上限 —— 多跑一次就会多记一次。 */
      assert.equal(toolHits, fg.maxToolCalls, '熔断上限就是真实执行的次数上限（执行 ' + toolHits + ' · maxToolCalls ' + fg.maxToolCalls + '）');
      assert.equal(fg.tripped, true, '到达上限后熔断（reason=' + fg.breakerReason + '）');
      assert.equal(cyclesOpened(F), 1, '混合协议全程只有 1 个周期');
      return { note: 'toolHits=' + toolHits + ' toolCalls=' + fg.toolCalls + '/' + fg.maxToolCalls + ' tripped=' + fg.tripped + ' reason=' + fg.breakerReason };
    });

    /* ================================================================
       G · concurrent turn：前台与后台互不干涉
       ================================================================ */
    section('G · concurrent turn：前台与后台完全隔离');

    let G = null;
    await check('G1 前台（XML/FC 混合）与后台回合得到**不同**的 guard 实例，且互不累计/互不结束', async () => {
      G = await driveTurn({
        rounds: 3,
        background: true,
        bgConsumer: 'test-bg',
        userText: '请帮我处理一下这个文件',
        script: [
          { kind: 'text', text: xmlTool('check_status', { key: 'g-1' }) + '\n先查。' },
          { kind: 'text', text: '收尾。' }
        ]
      });
      assert.equal(G.R.turnErr, '', '宿主回合没有抛错，turnErr=' + JSON.stringify(G.R.turnErr));
      assert.equal(G.R.bg.err, '', '后台回合没有抛错，bgErr=' + JSON.stringify(G.R.bg.err));
      lastDiag = { r: G };
      assert.notEqual(G.R.bg.turnGuard, '(no-guard)', '后台回合拿到了**属于它自己**的 guard 实例');
      assert.ok(G.R.guards.length >= 2, '前台与后台各自分配了 guard 实例（实际 ' + JSON.stringify(G.R.bg.guards) + '）');
      const fg = G.R.foregroundGuard, bg = G.R.bg.turnGuard;
      assert.ok(fg, '前台拿到的是**它自己**的 guard 实例（fg=' + fg + '）');
      assert.notEqual(fg, bg, 'frontGuard !== backgroundGuard（' + fg + ' vs ' + bg + '）');
      const fs = G.R.foreground;
      assert.ok(fs, '前台账本快照可读（' + JSON.stringify(fs) + '）');
      const bs = G.R.bg.snap;
      assert.ok(bs, '后台回合自己的实例快照可读（bg=' + bg + ' guards=' + JSON.stringify(G.R.bg.guards) + '）');
      assert.equal(fs.toolCalls, toolHits, '前台账本只记自己的执行（执行 ' + toolHits + ' · 前台账本 ' + fs.toolCalls + '）');
      assert.equal(bs.toolCalls, 0, '后台在自己的实例上记 0（它没有执行任何工具，也没有借前台的账本）：' + bs.toolCalls);
      assert.equal(bs.tripped, false, '后台未熔断，也不影响前台');
      assert.equal(fs.tripped, false, '前台未被后台的收尾影响（front tripped=' + fs.tripped + '）');
      /* 前台周期收尾一次（它自己的），后台的收尾没有把前台收掉 —— 由 H1 的
         fail-closed 断言与这里 fs 的完整性共同保证。 */
      assert.equal(G.R.turnOwnedCount, 1, '前台收尾恰好一次，后台没有替它收（实际 ' + G.R.turnOwnedCount + '）');
      assert.equal(cyclesOpened(G), 2, '前台与后台**各**开了一个自己的周期（互不共享）：' + JSON.stringify(G.R.cycles.map(c => c.tid + ':' + c.guard + (c.opened ? '(opened)' : ''))));
      return { note: 'front=' + fg + '(tools=' + fs.toolCalls + ' · tripped=' + fs.tripped + ') bg=' + bg + '(tools=' + bs.toolCalls + ') 后台文本=' + G.R.bg.text };
    });

    /* ================================================================
       H · turn finish：收尾之后旧 turn 必须 fail closed
       ================================================================ */
    section('H · turn finish：周期收尾一次，其后旧引用 fail closed');

    let H = null;
    await check('H1 宿主回合结束后，用**同一个旧 turn** 再走 XML 通道：工具不执行、账本不变', async () => {
      H = await driveTurn({
        rounds: 3,
        staleTurn: true,
        userText: '请帮我处理一下这个文件',
        script: [
          { kind: 'text', text: xmlTool('check_status', { key: 'h-1' }) + '\n先查。' },
          { kind: 'text', text: '收尾。' },
          /* 若 stale 通道**真的**被放行，会立刻打到这里 —— 它就是"漏了"的证据。 */
          { kind: 'text', text: xmlTool('ping_host', { host: 'h-stale' }) + '\n（旧回合的回复）' }
        ]
      });
      assert.equal(H.R.turnErr, '', '宿主回合没有抛错');
      assert.equal(H.R.turnOwnedCount, 1, '宿主回合的周期收尾有效且恰好一次（实际 ' + H.R.turnOwnedCount + '）');
      assert.equal(H.R.staleOk, true, '旧 turn 的续轮调用本身没有抛错（宿主通道容错，返回 null）');
      assert.equal(H.R.staleEnded, true, '探针确认该 turn 的周期已经结束（无活动周期）');
      assert.equal(toolHits, 1, '旧 turn 之后工具**没有**被执行（实际 ' + toolHits + ' · paths=' + JSON.stringify(toolPaths) + '）');
      assert.equal(hitsOf('/ping'), 0, '旧 turn 路径上的 ping_host 一次都没执行');
      return { note: 'turnOwnedEnds=' + H.R.turnOwnedCount + ' toolHits=' + toolHits + ' staleEnded=' + H.R.staleEnded };
    });

    /* ================================================================
       D · 对照：裸调用面（没有宿主回合时）仍自成一个单周期回合
       ================================================================ */
    section('I · 对照：非宿主调用面（诊断/脚本直接 callApiChat）');

    await check('I1 直接 callApiChat（无宿主 turn）自己就是一个回合：1 个周期、账本一致、收尾后不活动', async () => {
      const r = await evaluate(cdp, `(async function(){
        try{ localStorage.setItem('ib_fcRounds','3'); localStorage.removeItem('ib_fcMaxToolCalls'); }catch(e){}
        IBFC._tdGuard=null; IBFC._tdPolicyJson=null; IBFC._tdReason=''; IBFC._tdLast=null; IBFC._tdTrace=[];
        var R={cycles:[],guards:[],finals:[]};
        var _ong=IBFC._newGuard,_ob=IBFC.cycleBegin,_oe=IBFC.cycleEnd;
        var guarded=function(g){ if(!g)return g; var w={__ibPid:'I'+(R.guards.length+1),beforeCall:function(){return g.beforeCall.apply(g,arguments)},
          settleCall:function(){return g.settleCall.apply(g,arguments)},snapshot:function(){return g.snapshot()},active:function(){return g.active()},
          tripped:function(){return g.tripped()},tripInfo:function(){return g.tripInfo()},policy:function(){return g.policy()},trace:function(){return g.trace()},
          startCycle:function(){return g.startCycle.apply(g,arguments)},beforeRound:function(){return g.beforeRound.apply(g,arguments)},afterRound:function(){return g.afterRound.apply(g,arguments)},
          endCycle:function(){return g.endCycle()},noteElapsed:function(){return g.noteElapsed()},lastBreaker:function(){return g.lastBreaker()},
          breakerHistory:function(){return g.breakerHistory()},afterCall:function(){return g.afterCall.apply(g,arguments)}}; R.guards.push(w); return w; };
        IBFC._newGuard=function(){ return guarded(_ong.apply(IBFC,arguments)); };
        IBFC.cycleBegin=function(ctx,meta,turn){ var r=_ob.call(IBFC,ctx,meta,turn);
          R.cycles.push({label:(turn&&turn.label)||null,ownsCycle:!!(turn&&turn.ownsCycle===true),guard:r?r.__ibPid:null}); return r; };
        IBFC.cycleEnd=function(turn){ try{ if(turn&&turn.guard){ var s=turn.guard.snapshot(); R.finals.push({pid:turn.guard.__ibPid,toolCalls:s.toolCalls,rounds:s.rounds,distinct:s.distinctCalls,tripped:!!s.tripped}); } }catch(e){}
          return _oe.call(IBFC,turn); };
        var cfg=apiConfigs.find(function(a){return a.id==='p3d1'});
        var msgs=[{role:'system',content:'你是测试角色。\\n【外部工具】check_status / ping_host 可用。'},{role:'user',content:'hi'}];
        var text='';
        await callApiChat(cfg,msgs,{_ibConsumer:'p11-3d1-control',wantMeta:true,autoContinue:false,disableTools:false,onChunk:function(t){text+=t;}});
        var snaps=R.guards.map(function(g){ var s=g.snapshot(); return {pid:g.__ibPid,active:!!s.active,toolCalls:s.toolCalls,rounds:s.rounds}; });
        /* 周期收尾后 guard 的 state 已清空，因此"这一回合的账本终值"要从
           cycleEnd 探针里读（同一口径与驱动器的 runTurn 一致）。 */
        var finals=R.finals||[];
        var last=IBFC._tdLast?{toolCalls:IBFC._tdLast.toolCalls,rounds:IBFC._tdLast.rounds}:null;
        IBFC._newGuard=_ong; IBFC.cycleBegin=_ob; IBFC.cycleEnd=_oe;
        return {cycles:R.cycles,snaps:snaps,last:last,finals:finals};
      })()`);
      assert.equal(r.cycles.length, 2, '隐式回合的 begin 与"工具块激活时的开周期"是两次调用，实际 ' + JSON.stringify(r.cycles));
      assert.equal(r.cycles.filter(c => c.guard).length, 1, '**只开了一个**周期（另一条路径在 FC 未激活时不开周期）');
      const opened = r.cycles.filter(c => c.guard)[0];
      assert.equal(opened.ownsCycle, true, '真正开周期的那次带着 ownsCycle 的 turn：' + JSON.stringify(opened));
      assert.ok(r.snaps.length >= 1 && r.snaps[r.snaps.length - 1].active === false, '调用返回后周期已收尾（不活动）：' + JSON.stringify(r.snaps));
      /* 账本终值在收尾时读：模型这轮没有工具调用，因此 rounds=0 是**预期**的 ——
         "有周期"不等于"消耗了轮次"。这里断言的是"确实有且仅有一个周期被开启过"。 */
      assert.ok(r.finals.length === 1, '收尾时读到的账本恰好一份：' + JSON.stringify(r.finals));
      assert.equal(r.finals[0].toolCalls, 0, '没有工具调用就没有工具计数：' + JSON.stringify(r.finals[0]));
      return { note: 'cycles=' + r.cycles.length + ' label=' + r.cycles[0].label + ' final=' + JSON.stringify(r.finals[0]) };
    });

  } finally {
    await cleanup();
  }

  console.log('\n' + (failures === 0 ? 'ALL PASS' : failures + ' FAILED'));
  if (failures) process.exitCode = 1;
})().catch(e => { console.error('HARNESS ERROR', e); process.exitCode = 1; });
