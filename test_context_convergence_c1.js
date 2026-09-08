'use strict';

/* ====================================================================
   Context Convergence C1 · 单轮 context retrieval 去重回归（P2-03）
   --------------------------------------------------------------------
   验证：
     · 单聊一轮内 Memory / Understanding / Thread / Moments 各只读取一次
     · Middle Brain 消费上游已读结果（opts.*Ctx），不再自行 retrieval
     · 空结果（''）不触发 fallback 二次读取；缺失（undefined）才允许 fallback
     · Memory activation 一轮只 +1
     · Astra 成功 → 压缩块**替换**原四块（不双份注入）；passthrough 块不重复
     · 跨角色不泄漏 / private 不进入 / MB disabled 与失败时行为不变
     · Runtime execute 的 4 个 consumer 不受影响；Chat/Group/Voice 仍未迁
   真实 localhost 页面 + 独立 profile + mock（角色模型 + Middle Brain Responses）。
   运行：node test_context_convergence_c1.js
   ==================================================================== */

const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const http = require('node:http'), assert = require('node:assert/strict');
const { spawn } = require('node:child_process');

const harness = fs.readFileSync(path.join(__dirname, 'test_chat_smoke.js'), 'utf8');
const boundary = harness.indexOf('async function main() {');
assert.ok(boundary > 0, 'existing CDP harness boundary changed');
const { chromePath, Cdp, evaluate, waitFor, freePort } = new Function('require', '__dirname',
  harness.slice(0, boundary) + '\nreturn {chromePath,Cdp,evaluate,waitFor,freePort};')(require, __dirname);

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

const chatReqs = [];   /* 角色模型请求 */
const mbReqs = [];     /* Middle Brain 请求 */
let mbMode = 'ok';     /* ok | fail */

const api = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') { res.end(); return; }
  let raw = ''; for await (const chunk of req) raw += chunk;
  let body = null; try { body = JSON.parse(raw || '{}'); } catch (_) {}
  const url = req.url || '';
  if (url.includes('/responses')) {
    mbReqs.push({ url, body, raw });
    if (mbMode === 'fail') {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'mb down' } }));
      return;
    }
    const userMsg = (() => { try { return String(((body.input || []).find(i => i && i.role === 'user') || {}).content || ''); } catch (_) { return ''; } })();
    const payload = JSON.stringify({
      keep: ['C1_MB_KEEP'], merge: [], drop: [],
      compressedContext: 'C1_MB_COMPRESSED 当前对话：' + userMsg.slice(0, 120), currentKept: true
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ output: [{ type: 'message', content: [{ type: 'output_text', text: payload }] }], usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 } }));
    return;
  }
  chatReqs.push({ url, body });
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ choices: [{ message: { content: 'C1_REPLY' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2 } }));
});

(async () => {
  const apiPort = await listen(api), apiBase = 'http://127.0.0.1:' + apiPort;
  const web = require('./internal-beyond-server.js').createWebServer({ root: __dirname, port: 0 });
  const webPort = await listen(web), webBase = 'http://127.0.0.1:' + webPort;
  const debugPort = await freePort();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-c1-'));
  const chrome = chromePath(); assert.ok(chrome, 'Chrome or Edge required');
  const browser = spawn(chrome, ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    '--remote-debugging-port=' + debugPort, '--user-data-dir=' + profile, 'about:blank'], { stdio: 'ignore', windowsHide: true });
  let cdp, failures = 0;
  async function check(name, fn) {
    try { await fn(); console.log('  PASS  ' + name); }
    catch (e) { failures++; console.error('  FAIL  ' + name + '  -> ' + (e && e.message || e)); }
  }
  /* 捕获函数包裹：四个 producer 都挂在 window 上，communication 与 middle-brain 都从全局解析 */
  const wrapProducers = () => evaluate(cdp, `(function(){
    if(window.__c1wrap)return true;
    var names=['getMemoryContext','getUnderstandingContext','getThreadContext','getMomentsContext'];
    window.__c1count={};
    names.forEach(function(n){
      var orig=window[n];
      if(typeof orig!=='function')return;
      window[n]=function(){window.__c1count[n]=(window.__c1count[n]||0)+1;return orig.apply(null,arguments)};
    });
    window.__c1wrap=true;return true;
  })()`);
  const resetCounts = () => evaluate(cdp, `(function(){window.__c1count={};return true})()`);
  const readCounts = () => evaluate(cdp, `(function(){return window.__c1count||{}})()`);
  const chatTurn = role => evaluate(cdp, `(async function(){
    activeFriendId=${JSON.stringify(role)};activeThreadId=null;openChatPanel();
    var i=document.getElementById(currentPage==='chat'?'chat-full-input':'chat-input');
    i.value='C1_USER_MESSAGE';await sendChatMessage();return true;
  })()`);
  const lastChatBody = () => (chatReqs.slice(-1)[0] || {}).body;
  const normTime = obj => JSON.stringify(obj).replace(/当前时间：[^。]*。/g, '当前时间：<T>。');
  /* 只比较"系统注入的参考上下文"尾段：排除聊天历史条数随时间累积造成的差异 */
  const tailOf = body => {
    const msgs = (body && body.messages) || [];
    const last = msgs.slice().reverse().find(m => m && m.role === 'user');
    const c = String((last && last.content) || '');
    const i = c.indexOf('[以下为系统注入的参考上下文');
    return i >= 0 ? c.slice(i).replace(/当前时间：[^。]*。/g, '当前时间：<T>。') : '';
  };
  const allText = obj => JSON.stringify(obj || {});

  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try { ready = (await fetch('http://127.0.0.1:' + debugPort + '/json/version')).ok; } catch (_) {}
      if (ready) break;
      await new Promise(r => setTimeout(r, 100));
    }
    assert.ok(ready, 'CDP readiness');
    const tab = await (await fetch('http://127.0.0.1:' + debugPort + '/json/new?about:blank', { method: 'PUT' })).json();
    cdp = await Cdp.connect(tab.webSocketDebuggerUrl);
    await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `const _of=window.fetch.bind(window);window.fetch=function(input,opts){const u=new URL(typeof input==='string'?input:input.url,location.href);`
        + `if(u.origin!==${JSON.stringify(apiBase)}&&u.origin!==${JSON.stringify(webBase)})return Promise.reject(new Error('c1 smoke blocks external service'));return _of(input,opts);};window.confirm=()=>true;`
    });
    await cdp.send('Page.navigate', { url: webBase + '/InternalBeyond.html' });
    assert.ok(await waitFor(cdp, "document.readyState==='complete' && typeof getMemoryContext==='function' && typeof middleBrainCompressPipeline==='function' && typeof saveMiddleBrainConfig==='function' && typeof loadApiConfigs==='function'", 20000), 'page + producers + MB mounted');

    /* ── 数据与配置 ── */
    const mkCfg = id => ({ id, provider: 'custom', endpoint: apiBase + '/v1/chat/completions', model: 'c1-model-' + id, apiKey: '', nickname: id, streaming: false, promptCache: false, systemPrompt: 'CONV_IDENTITY_' + id, relationship: '伙伴' });
    await evaluate(cdp, `(async()=>{
      for(const c of ${JSON.stringify([mkCfg('c1_role'), mkCfg('c1_other'), mkCfg('c1_empty'), mkCfg('c1_group_a')])})await dbPut('apiConfigs',c);
      await loadApiConfigs();
      await saveMiddleBrainConfig({enabled:true,endpoint:${JSON.stringify(apiBase + '/v1/responses')},model:'gpt-6-astra',apiKey:'sk-x',admissionEnabled:false});
      /* c1_role：四个 producer 各有内容 */
      await dbPut('memories',{id:'c1_mem',kind:'episodic',createdBy:'c1_role',visibility:'public',visibleTo:[],excludeFrom:[],title:'C1_MEMORY_TITLE',content:'C1_MEMORY_MARKER',domain:'日常',tags:[],valence:0.5,arousal:0.3,importance:9,resolved:false,activationCount:0,created:Date.now(),lastActivated:0});
      await dbPut('memories',{id:'c1_priv',kind:'episodic',createdBy:'c1_role',visibility:'private',visibleTo:[],excludeFrom:[],title:'C1_PRIVATE_TITLE',content:'C1_PRIVATE_MARKER',domain:'日常',tags:[],valence:0.5,arousal:0.3,importance:9,resolved:false,activationCount:0,created:Date.now(),lastActivated:0});
      await dbPut('memories',{id:'c1_other_mem',kind:'episodic',createdBy:'c1_other',visibility:'only',visibleTo:['c1_other'],excludeFrom:[],title:'C1_OTHER_TITLE',content:'C1_OTHER_MARKER',domain:'日常',tags:[],valence:0.5,arousal:0.3,importance:9,resolved:false,activationCount:0,created:Date.now(),lastActivated:0});
      await unWrite('c1_role',{content:'C1_UNDERSTANDING_MARKER',conviction:80,basis:'user_stated',dimension:'context',evidenceIds:[]});
      await thOpen('c1_role','C1_THREAD_MARKER',[],'ai');
      await createMoment({roleId:'c1_role',content:'C1_MOMENT_MARKER',source:'manual',visibility:'all'});
      await dbPut('chatSummaries',{id:'sum_c1_role',summary:'C1_SUMMARY_MARKER'});
      await dbPut('apiSettings',{id:'summarySettings',enabled:true,keepCount:6,welcomeEnabled:false,welcomeInterval:2,musicEnabled:false,summaryApiId:'',summaryWindow:60});
      return true})()`);
    await wrapProducers();
    assert.equal(await evaluate(cdp, `(async function(){return await middleBrainReady()===true})()`), true, 'Middle Brain 必须就绪');

    /* ── 1-4 / 8 / 9 / 10：单轮只读一次 + activation 一次 + replace ── */
    await resetCounts();
    const mbBefore = mbReqs.length, chatBefore = chatReqs.length;
    await chatTurn('c1_role');
    await check('单轮四个 producer 各只读取一次', async () => {
      const c = await readCounts();
      assert.deepEqual(c, { getMemoryContext: 1, getUnderstandingContext: 1, getThreadContext: 1, getMomentsContext: 1 }, '实际计数：' + JSON.stringify(c));
    });
    await check('Memory activation 一轮只 +1', async () => {
      const row = await evaluate(cdp, `(async function(){return await dbGet('memories','c1_mem')})()`);
      assert.equal(row.activationCount, 1, 'activationCount=' + row.activationCount);
    });
    await check('Astra 只调用一次且收到上游已读 context', async () => {
      const reqs = mbReqs.slice(mbBefore);
      assert.equal(reqs.length, 1, 'Middle Brain 请求数：' + reqs.length);
      const text = JSON.stringify(reqs[0].body);
      assert.ok(text.includes('C1_MEMORY_MARKER'), 'MB 输入应含上游已读 Memory');
      assert.ok(text.includes('C1_UNDERSTANDING_MARKER'), 'MB 输入应含上游已读 Understanding');
      assert.ok(text.includes('C1_THREAD_MARKER'), 'MB 输入应含上游已读 Thread');
      assert.ok(text.includes('C1_MOMENT_MARKER'), 'MB 输入应含上游已读 Moments');
      assert.ok(!text.includes('C1_OTHER_MARKER') && !text.includes('C1_PRIVATE_MARKER'), 'MB 输入不得含跨角色/private 内容');
    });
    await check('Astra 压缩块替换原四块（不双份注入）', async () => {
      const body = allText(lastChatBody());
      assert.ok(body.includes('C1_MB_COMPRESSED'), '最终 prompt 必须含压缩块');
      for (const marker of ['C1_MEMORY_MARKER', 'C1_UNDERSTANDING_MARKER', 'C1_THREAD_MARKER', 'C1_MOMENT_MARKER']) {
        assert.ok(!body.includes(marker), '原块必须被替换而不是追加：' + marker);
      }
    });
    await check('passthrough 块（摘要）不重复', async () => {
      const body = allText(lastChatBody());
      const n = body.split('C1_SUMMARY_MARKER').length - 1;
      assert.equal(n, 1, '摘要应恰好出现一次，实际 ' + n);
    });
    await check('跨角色 / private 不进入最终 prompt', async () => {
      const body = allText(lastChatBody());
      assert.ok(!body.includes('C1_OTHER_MARKER'), '不得含其他角色记忆');
      assert.ok(!body.includes('C1_PRIVATE_MARKER'), '不得含 private 记忆');
    });

    /* ── 5-6：空结果不得触发 fallback 二次读取 ── */
    await check("空结果（''）不触发 fallback 二次读取", async () => {
      await resetCounts();
      const out = await evaluate(cdp, `(async function(){
        var r=await middleBrainCompressPipeline('c1_empty','C1_EMPTY_MSG',{memoryCtx:'',understandingCtx:'',threadCtx:'',momentsCtx:''});
        return{src:r.source,ctx:r.compressedContext,count:window.__c1count};
      })()`);
      assert.deepEqual(out.count, {}, '显式空结果不得再 retrieval：' + JSON.stringify(out.count));
      assert.equal(String(out.ctx || ''), '', '全空时不应产生压缩块');
    });

    /* ── 7：缺失 opts 时 fallback 仍工作 ── */
    await check('missing opts → Middle Brain fallback retrieval 仍工作', async () => {
      await resetCounts();
      await evaluate(cdp, `(async function(){return await middleBrainCompressPipeline('c1_role','C1_FALLBACK_MSG',{})})()`);
      const c = await readCounts();
      assert.deepEqual(c, { getMemoryContext: 1, getUnderstandingContext: 1, getThreadContext: 1, getMomentsContext: 1 }, '实际计数：' + JSON.stringify(c));
    });

    /* ── 14：Middle Brain disabled → 行为不变（原四块保留） ── */
    await check('MB disabled → 原四块保留、无压缩块', async () => {
      await evaluate(cdp, `(async function(){await saveMiddleBrainConfig({enabled:false});return true})()`);
      await resetCounts();
      await chatTurn('c1_role');
      const c = await readCounts();
      assert.deepEqual(c, { getMemoryContext: 1, getUnderstandingContext: 1, getThreadContext: 1, getMomentsContext: 1 }, '计数：' + JSON.stringify(c));
      const body = allText(lastChatBody());
      for (const marker of ['C1_MEMORY_MARKER', 'C1_UNDERSTANDING_MARKER', 'C1_THREAD_MARKER', 'C1_MOMENT_MARKER']) assert.ok(body.includes(marker), '缺原块：' + marker);
      assert.ok(!body.includes('C1_MB_COMPRESSED'), 'MB 关闭时不得出现压缩块');
      await evaluate(cdp, `(async function(){await saveMiddleBrainConfig({enabled:true});return true})()`);
    });

    /* ── 15 + 快照等价：Astra 失败 → local 回落，prompt 与 MB 关闭时等价 ── */
    await check('Astra 失败 → local 回落且 prompt 与 MB 关闭时等价', async () => {
      /* MB 关闭的基准尾段 */
      await evaluate(cdp, `(async function(){await saveMiddleBrainConfig({enabled:false});return true})()`);
      await chatTurn('c1_role');
      const baselineTail = tailOf(lastChatBody());
      assert.ok(baselineTail.includes('C1_MEMORY_MARKER'), '基准尾段应含原始 Memory 块');
      /* Astra 失败：enabled 但 500 → pipeline 回落 local → 不注入压缩块 */
      await evaluate(cdp, `(async function(){await saveMiddleBrainConfig({enabled:true});return true})()`);
      mbMode = 'fail';
      const before = mbReqs.length;
      await chatTurn('c1_role');
      mbMode = 'ok';
      assert.ok(mbReqs.length > before, 'Astra 失败路径必须真的请求过 MB 端点');
      const body = allText(lastChatBody());
      assert.ok(body.includes('C1_MEMORY_MARKER') && !body.includes('C1_MB_COMPRESSED'), '失败时保留原块且不注入压缩块');
      assert.equal(tailOf(lastChatBody()), baselineTail, 'MB 失败回落后尾段必须与 MB 关闭时逐字段等价');
    });

    /* ── 16-19：Runtime execute consumer 不受影响 ── */
    await check('Chat / Group / Voice 仍未迁 Runtime，proactive 仍在 Runtime', async () => {
      const out = await evaluate(cdp, `(async function(){
        /* 隔离：后台调度（_activeTimer / visibilitychange）本身就会经白名单 consumer 走
           runtime.execute，与"Chat/Group/Voice 是否迁移"无关。按 IB.runtime.telemetry.consumer
           做**调用级归因**：consumer 的 telemetry 记录紧跟在它自己那次 execute settle 之后，
           因此每条记录认领"最近一个已结束且未认领"的调用；已结束的 execute 必须全部被白名单
           consumer（active.proactive / moments / diary / memory_consolidation）认领，否则失败。
           仍在途的调用必然是后台 tick（Chat/Group/Voice 在上方已全部 await 完成），不计入失败。 */
        var __bg=['active.proactive','moments','diary','memory_consolidation'],__calls=[];
        var __tel=IB.runtime.telemetry,__rec=__tel.record.bind(__tel);
        __tel.record=function(consumer,data){
          var rec=__rec(consumer,data);
          for(var i=__calls.length-1;i>=0;i--){
            if(!__calls[i].claimed&&__calls[i].settled){__calls[i].claimed=true;__calls[i].consumer=String(consumer||'');break}
          }
          return rec;
        };
        var R=IB.runtime.instance,or=R.run.bind(R),oe=R.execute.bind(R);window.__c1rt={run:0,execute:0};
        R.run=function(){window.__c1rt.run++;return or.apply(null,arguments)};
        R.execute=function(){
          window.__c1rt.execute++;
          var c={settled:false,claimed:false,consumer:''};__calls.push(c);
          var p=oe.apply(null,arguments);
          return p.then(function(v){c.settled=true;return v},function(e){c.settled=true;throw e});
        };
        var __acc=async function(){
          var deadline=Date.now()+2000,unclaimed=0,bad=[];
          for(;;){
            unclaimed=0;bad=[];
            for(var i=0;i<__calls.length;i++){
              var c=__calls[i];
              if(c.settled&&!c.claimed)unclaimed++;
              if(c.claimed&&__bg.indexOf(c.consumer)<0)bad.push(c.consumer);
            }
            if(!unclaimed||Date.now()>deadline)break;
            await new Promise(function(r){setTimeout(r,50)});
          }
          var inflight=0;for(var j=0;j<__calls.length;j++){if(!__calls[j].settled)inflight++}
          __tel.record=__rec;R.run=or;R.execute=oe;
          return{run:window.__c1rt.run,execute:__calls.length,unclaimed:unclaimed,inflight:inflight,bad:bad};
        };
        var __cnt=function(){var all=IB.runtime.telemetry.recent(200),k=0;
          for(var i=0;i<all.length;i++){if(all[i].consumer==='active.proactive'&&all[i].executor==='runtime')k++}
          return k};
        try{
          activeFriendId='c1_role';activeThreadId=null;openChatPanel();
          var i=document.getElementById(currentPage==='chat'?'chat-full-input':'chat-input');i.value='C1_CHAT';await sendChatMessage();
          var afterChat={run:window.__c1rt.run,execute:window.__c1rt.execute};
          await dbPut('groups',{id:'c1_group',name:'C1 group',members:['c1_group_a','c1_role'],memoryEnabled:false});
          activeFriendId='c1_group';activeThreadId=null;openChatPanel();
          var gi=document.getElementById(currentPage==='chat'?'chat-full-input':'chat-input');gi.value='C1_GROUP';await sendChatMessage();
          var afterGroup={run:window.__c1rt.run,execute:window.__c1rt.execute};
          activeFriendId='c1_role';
          var vres=await sendChatMessage({voiceCall:true,transcript:'C1_VOICE',roleId:'c1_role',conversationId:'voice-1',turnId:'t1'});
          var afterVoice={run:window.__c1rt.run,execute:window.__c1rt.execute};
          var cfg=apiConfigs.find(function(a){return a.id==='c1_role'});
          var beforeProactive=__cnt();
          var p=await generateProactiveMessage({character:cfg,user:{name:'用户'},recentMessages:[],memories:[],recentProactiveMessages:[],currentTime:new Date(),messageMode:'greeting',taskId:'c1_task'});
          var proactiveDelta=__cnt()-beforeProactive;
          var afterProactive={run:window.__c1rt.run,execute:window.__c1rt.execute};
          var acc=await __acc();
          return{afterChat:afterChat,afterGroup:afterGroup,afterVoice:afterVoice,afterProactive:afterProactive,proactiveDelta:proactiveDelta,acc:acc,voiceOk:!!(vres&&vres.ok)};
        }finally{R.run=or;R.execute=oe;if(__tel&&__rec)__tel.record=__rec}
      })()`);
      assert.equal(out.afterChat.run, 0, 'Chat 不得调用 runtime.run');
      assert.equal(out.afterGroup.run, 0, 'Group 不得调用 runtime.run');
      assert.equal(out.afterVoice.run, 0, 'Voice 不得调用 runtime.run');
      assert.deepEqual(out.acc.bad, [], 'runtime.execute 只能由白名单 consumer 归因：' + JSON.stringify(out.acc.bad));
      assert.equal(out.acc.unclaimed, 0,
        '存在已结束但无法归因的 runtime.execute 调用：' + out.acc.unclaimed + '（在途后台调用 ' + out.acc.inflight + '）');
      assert.equal(out.voiceOk, true);
      assert.equal(out.proactiveDelta, 1, 'proactive 必须仍走 Runtime execute（对照组：恰好一条 active.proactive runtime 记录）');
    });

    /* ── 一轮内 producer 计数（含 MB 关闭/失败路径）的总结 ── */
    await check('多轮累计：每轮每个 producer 恰好一次（无隐藏二次读）', async () => {
      await evaluate(cdp, `(async function(){await saveMiddleBrainConfig({enabled:true});return true})()`);
      await resetCounts();
      await chatTurn('c1_role');
      await chatTurn('c1_role');
      const c = await readCounts();
      assert.deepEqual(c, { getMemoryContext: 2, getUnderstandingContext: 2, getThreadContext: 2, getMomentsContext: 2 }, '两轮应各 2 次：' + JSON.stringify(c));
    });

    console.log('\nContext convergence C1: ' + failures + ' failed');
    process.exitCode = failures ? 1 : 0;
  } finally {
    if (cdp) cdp.close();
    browser.kill();
    api.closeAllConnections(); web.closeAllConnections();
    await Promise.all([new Promise(r => api.close(r)), new Promise(r => web.close(r))]);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_) {}
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
