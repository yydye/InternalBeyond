'use strict';

/* ====================================================================
   Runtime Convergence Phase 1 · 主动消息 execute 迁移回归
   --------------------------------------------------------------------
   验证的唯一 consumer：assets/js/active-diary.js → generateProactiveMessage
     Prompt/Context（未改） → _activeProactiveModelCall
                              ├─ IB.runtime.instance.execute（默认）
                              └─ callApiChat（回滚 / 接缝不可用）
   覆盖：三协议 format、usage、budget、identity、abort 单次、runtime error 的既有 fallback、
        proactive retry 原样、runtime↔direct 等价、Chat/Group/Voice 计数为 0。
   真实 localhost 页面 + 独立 profile + mock provider；不触达用户服务与真实 provider。
   运行：node test_runtime_convergence_proactive.js
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

const hits = {};          /* path → 次数 */
const captured = [];      /* {url, body, headers} */
const hit = key => (hits[key] = (hits[key] || 0) + 1);

const api = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') { res.end(); return; }
  let raw = ''; for await (const chunk of req) raw += chunk;
  let body = null; try { body = JSON.parse(raw || '{}'); } catch (_) {}
  const url = req.url || '';
  captured.push({ url, body, headers: req.headers });
  const key = url.startsWith('/anth') ? 'anth'
    : url.startsWith('/gem') ? 'gem'
      : url.startsWith('/oai-fail') ? 'fail'
        : url.startsWith('/oai-retry') ? 'retry'
          : url.startsWith('/oai-slow') ? 'slow' : 'oai';
  hit(key);

  if (key === 'fail') {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'convergence mock failure' } }));
    return;
  }
  if (key === 'slow') {
    await new Promise(r => setTimeout(r, 5000));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: 'SLOW_NEVER' }, finish_reason: 'stop' }] }));
    return;
  }
  let text = 'CONV_REPLY';
  if (key === 'retry') {
    /* 第 1 次：与"最近主动消息"完全一致 → 触发既有校验拒绝；第 2 次：合法新正文 */
    text = hits.retry === 1 ? '与最近主动消息完全相同的一句话。' : '这是一条全新的、与之前不同的主动消息正文。';
  }
  captured[captured.length - 1].mockText = text;
  let payload;
  if (key === 'anth') {
    payload = { content: [{ type: 'text', text }], stop_reason: 'end_turn',
      usage: { input_tokens: 20, output_tokens: 4, cache_read_input_tokens: 3, cache_creation_input_tokens: 2 } };
  } else if (key === 'gem') {
    payload = { candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 4, cachedContentTokenCount: 3 } };
  } else {
    payload = { choices: [{ message: { content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 4 } };
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
});

(async () => {
  const apiPort = await listen(api), apiBase = 'http://127.0.0.1:' + apiPort;
  const web = require('./internal-beyond-server.js').createWebServer({ root: __dirname, port: 0 });
  const webPort = await listen(web), webBase = 'http://127.0.0.1:' + webPort;
  const debugPort = await freePort();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-convergence-'));
  const chrome = chromePath(); assert.ok(chrome, 'Chrome or Edge required');
  const browser = spawn(chrome, ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    '--remote-debugging-port=' + debugPort, '--user-data-dir=' + profile, 'about:blank'], { stdio: 'ignore', windowsHide: true });
  let cdp, failures = 0;
  async function check(name, fn) {
    try { await fn(); console.log('  PASS  ' + name); }
    catch (e) { failures++; console.error('  FAIL  ' + name + '  -> ' + (e && e.message || e)); }
  }
  const hitsOf = key => hits[key] || 0;
  /* 只统计"本次用例"发出的请求：后台日记/计划等 tick 可能同时命中同一 mock 端点 */
  const reqsWith = (from, urlPrefix, marker) => captured.slice(from)
    .filter(r => String(r.url || '').startsWith(urlPrefix) && JSON.stringify(r.body || {}).includes(marker));
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
    const pageLogs = [];
    cdp.on('Runtime.consoleAPICalled', p => {
      try {
        const text = (p.args || []).map(a => a.value !== undefined ? a.value : (a.description || a.type)).join(' ');
        pageLogs.push(String(p.type) + ': ' + String(text).slice(0, 300));
      } catch (_) {}
    });
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `const _of=window.fetch.bind(window);window.fetch=function(input,opts){const u=new URL(typeof input==='string'?input:input.url,location.href);`
        + `if(u.origin!==${JSON.stringify(apiBase)}&&u.origin!==${JSON.stringify(webBase)})return Promise.reject(new Error('convergence smoke blocks external service'));return _of(input,opts);};window.confirm=()=>true;`
    });
    await cdp.send('Page.navigate', { url: webBase + '/InternalBeyond.html' });
    assert.ok(await waitFor(cdp, "document.readyState==='complete' && typeof generateProactiveMessage==='function' && typeof _activeProactiveModelCall==='function' && window.IB && IB.runtime && IB.runtime.instance && typeof loadApiConfigs==='function'", 20000), 'runtime + proactive seam mounted');

    /* ── 三个协议 + 失败/重试/慢速 角色（全部指向 mock，非流式，与既有 direct 路径一致） ── */
    const cfgs = [
      { id: 'conv_anth', provider: 'anthropic', endpoint: apiBase + '/anth/v1/messages', model: 'conv-anth-model', apiKey: 'k-anth', expectFormat: 'anthropic', expectReply: 'CONV_REPLY' },
      { id: 'conv_gem', provider: 'gemini', endpoint: apiBase + '/gem/{model}:generateContent', model: 'conv-gem-model', apiKey: 'k-gem', expectFormat: 'gemini', expectReply: 'CONV_REPLY' },
      { id: 'conv_oai', provider: 'custom', endpoint: apiBase + '/oai/v1/chat/completions', model: 'conv-oai-model', apiKey: '', expectFormat: 'openai', expectReply: 'CONV_REPLY' },
      { id: 'conv_fail', provider: 'custom', endpoint: apiBase + '/oai-fail/v1/chat/completions', model: 'conv-fail-model', apiKey: '', expectFormat: 'openai' },
      { id: 'conv_retry', provider: 'custom', endpoint: apiBase + '/oai-retry/v1/chat/completions', model: 'conv-retry-model', apiKey: '', expectFormat: 'openai' },
      { id: 'conv_slow', provider: 'custom', endpoint: apiBase + '/oai-slow/v1/chat/completions', model: 'conv-slow-model', apiKey: '', expectFormat: 'openai' },
      { id: 'conv_chat', provider: 'custom', endpoint: apiBase + '/oai/v1/chat/completions', model: 'conv-chat-model', apiKey: '', expectFormat: 'openai' }
    ].map(c => ({ ...c, nickname: c.id, streaming: false, promptCache: false, systemPrompt: 'CONV_IDENTITY_' + c.id, relationship: '伙伴' }));
    await evaluate(cdp, `(async()=>{for(const c of ${JSON.stringify(cfgs)})await dbPut('apiConfigs',c);await loadApiConfigs();`
      + `try{_diaryPrefsSave({enabled:false,weeklyEnabled:false,dailyPlannerEnabled:false,eventEnabled:false})}catch(e){}`
      + `try{_momentsPrefsSave({enabled:false,aiComment:false,aiLike:false})}catch(e){}`
      + `try{_activeAiPrefsSave({enabled:false})}catch(e){}})()`);

    const argsFor = (id, extra) => `Object.assign({character:apiConfigs.find(a=>a.id===${JSON.stringify(id)}),user:{id:'u',name:'用户'},`
      + `recentMessages:[],memories:[],recentProactiveMessages:[],currentTime:new Date(),messageMode:'greeting',taskId:'conv_task_${id}'}`
      + `,${extra || '{}'})`;

    /* 1-3. 三协议经 runtime 生成 */
    for (const cfg of cfgs.slice(0, 3)) {
      await check('format.' + cfg.expectFormat + ' → runtime 执行并返回正文', async () => {
        const before = captured.length;
        const out = await evaluate(cdp, `(async function(){var r=await generateProactiveMessage(${argsFor(cfg.id)});return{content:r.content,generatedByFallback:r.generatedByFallback,generationAttempts:r.generationAttempts,stats:_activeProactiveExecStatsSnapshot()}})()`);
        assert.equal(out.content, cfg.expectReply, '正文应与 mock 回复一致');
        assert.equal(out.generatedByFallback, false);
        assert.equal(out.generationAttempts, 1);
        assert.equal(out.stats.lastExecutor, 'runtime', '必须走 runtime execute');
        const req = captured.slice(before).find(r => JSON.stringify(r.body || {}).includes('CONV_IDENTITY_' + cfg.id));
        assert.ok(req, 'provider 必须收到本次请求');
        if (cfg.expectFormat === 'anthropic') {
          assert.equal(req.body.model, cfg.model, 'model 必须与 cfg 一致');
          assert.ok(typeof req.body.system === 'string' && req.body.system.includes('CONV_IDENTITY_'), 'anthropic system');
          assert.ok(req.body.messages.every(m => m.role !== 'system'));
          assert.equal(req.body.max_tokens, 512, 'budget 必须进入 max_tokens');
        } else if (cfg.expectFormat === 'gemini') {
          assert.ok(req.url.includes(cfg.model), 'gemini model 走 URL 路径');
          assert.ok(req.body.system_instruction.parts[0].text.includes('CONV_IDENTITY_'), 'gemini system_instruction');
          assert.ok(Array.isArray(req.body.contents));
          assert.equal(req.body.generationConfig.maxOutputTokens, 512, 'budget 必须进入 maxOutputTokens');
        } else {
          assert.equal(req.body.model, cfg.model, 'model 必须与 cfg 一致');
          assert.ok(req.body.messages.some(m => m.role === 'system' && m.content.includes('CONV_IDENTITY_')), 'openai system message');
          assert.equal(req.body.max_tokens, 512, 'budget 必须进入 max_tokens');
        }
      });
    }

    /* 4 + 5 + 6. usage / budget / identity 经接缝对象直接断言 */
    const expectedUsage = {
      conv_anth: { input_tokens: 20, output_tokens: 4, total_tokens: 24, cached_tokens: 3 },
      conv_gem: { input_tokens: 17, output_tokens: 4, total_tokens: 21, cached_tokens: 3 },
      conv_oai: { input_tokens: 20, output_tokens: 4, total_tokens: 24, cached_tokens: 0 }
    };
    for (const cfg of cfgs.slice(0, 3)) {
      await check('usage.budget.identity.' + cfg.expectFormat, async () => {
        const out = await evaluate(cdp, `(async function(){var cfg=apiConfigs.find(a=>a.id===${JSON.stringify(cfg.id)});`
          + `var r=await _activeProactiveModelCall(cfg,[{role:'system',content:cfg.systemPrompt},{role:'user',content:'CONV_PROBE'}],{});`
          + `return r})()`);
        assert.equal(out.executor, 'runtime');
        assert.equal(out.format, cfg.expectFormat, 'format 必须来自 provider-directory');
        assert.equal(out.usageSource, 'executor');
        assert.deepEqual(out.usage, expectedUsage[cfg.id]);
        assert.equal(out.aborted, false);
        assert.equal(out.fallbackReason, '');
      });
    }

    /* 7. abort：只调用一次，不重试、不回落 */
    await check('abort → 单次调用，不重试不回落', async () => {
      const before = captured.length;
      const out = await evaluate(cdp, `(async function(){var cfg=apiConfigs.find(a=>a.id==='conv_slow');`
        + `var ac=new AbortController();var t0=Date.now();`
        + `var p=_activeProactiveModelCall(cfg,[{role:'user',content:'CONV_ABORT'}],{signal:ac.signal});`
        + `setTimeout(function(){ac.abort()},300);var r=await p;return{ms:Date.now()-t0,r:r}})()`);
      assert.equal(out.r.aborted, true, '必须标记 aborted');
      assert.equal(out.r.abortMode, 'abandon');
      assert.equal(out.r.executor, 'runtime');
      assert.ok(out.ms < 2500, 'abandon 必须及时结束，实际 ' + out.ms + 'ms');
      assert.equal(reqsWith(before, '/oai-slow', 'CONV_ABORT').length, 1, '中止后不得再发第二次请求');
      await new Promise(r => setTimeout(r, 800));
      assert.equal(reqsWith(before, '/oai-slow', 'CONV_ABORT').length, 1, '等待期间也不得出现第二次请求');
      const stats = await evaluate(cdp, `(function(){return _activeProactiveExecStatsSnapshot()})()`);
      assert.equal(stats.abort >= 1, true, 'abort 计数应被记录');
      assert.equal(stats.lastAbortReason, 'abort');
    });

    /* 7b. 消费者层 abort：抛 AbortError 且不产出兜底文案 */
    await check('abort → generateProactiveMessage 抛出且不产生消息', async () => {
      const before = captured.length;
      const out = await evaluate(cdp, `(async function(){var cfg=apiConfigs.find(a=>a.id==='conv_slow');`
        + `var ac=new AbortController();setTimeout(function(){ac.abort()},250);`
        + `try{var r=await generateProactiveMessage(${argsFor('conv_slow', '{signal:ac.signal}')});return{threw:false,r:r}}catch(e){return{threw:true,name:String(e&&e.name||''),kind:String(e&&e.kind||''),msg:String(e&&e.message||'')}}})()`);
      assert.equal(out.threw, true, '中止必须抛出而不是返回兜底文案');
      assert.equal(out.name, 'AbortError');
      assert.equal(out.kind, 'abort');
      assert.equal(reqsWith(before, '/oai-slow', 'CONV_IDENTITY_conv_slow').length, 1, '中止不得触发第二次调用');
    });

    /* 8. runtime error → 既有 fallback 行为（3 次尝试 + 兜底文案） */
    await check('runtime error → 既有 retry + fallback 行为不变', async () => {
      const before = captured.length;
      const out = await evaluate(cdp, `(async function(){var r=await generateProactiveMessage(${argsFor('conv_fail')});`
        + `return{content:r.content,generatedByFallback:r.generatedByFallback,generationAttempts:r.generationAttempts,error:r.generationError,stats:_activeProactiveExecStatsSnapshot()}})()`);
      assert.equal(out.generatedByFallback, true, 'provider 全失败 → 兜底文案');
      assert.ok(String(out.content || '').trim().length > 0, '兜底文案必须非空');
      assert.equal(out.generationAttempts, 3, '必须保持 3 次尝试');
      assert.ok(/convergence mock failure|500/.test(String(out.error || '')), '应记录 provider 错误: ' + out.error);
      assert.equal(reqsWith(before, '/oai-fail', 'CONV_IDENTITY_conv_fail').length, 3, '必须恰好 3 次 provider 调用');
      assert.equal(out.stats.lastExecutor, 'runtime', 'provider 错误不改变执行器选择');
    });

    /* 9. proactive retry 逻辑原样：相似校验拒绝 → 带 retryInstruction 重生成 */
    await check('proactive retry 原样（相似拒绝后重生成）', async () => {
      const before = captured.length;
      const out = await evaluate(cdp, `(async function(){var r=await generateProactiveMessage(${argsFor('conv_retry', "{recentProactiveMessages:[{content:'与最近主动消息完全相同的一句话。'}]}")});`
        + `return{content:r.content,generatedByFallback:r.generatedByFallback,generationAttempts:r.generationAttempts}})()`);
      assert.equal(out.generationAttempts, 2, '第 1 次被相似校验拒绝 → 第 2 次成功');
      assert.equal(out.content, '这是一条全新的、与之前不同的主动消息正文。');
      assert.equal(out.generatedByFallback, false);
      const reqs = reqsWith(before, '/oai-retry', 'CONV_IDENTITY_conv_retry');
      assert.equal(reqs.length, 2, '恰好两次 provider 调用（第一次被既有校验拒绝）');
      assert.ok(JSON.stringify(reqs[1].body).includes('重新生成要求'), '重试必须带上 retryInstruction（prompt 构建未变）');
    });

    /* 10. runtime 与 direct 等价：同一 cfg、同一 mock，正文与请求体逐字段一致 */
    await check('runtime ↔ direct 等价（正文 + 请求体 + fallback 标志）', async () => {
      /* 固定 currentTime：prompt 里含日期时间文本，必须排除分钟跳变造成的假差异 */
      const fixedTime = "{taskId:'conv_equiv',currentTime:new Date('2026-09-08T12:00:00Z')}";
      const runtimeRun = await evaluate(cdp, `(async function(){window.runtimeExecuteEnabled=true;`
        + `var r=await generateProactiveMessage(${argsFor('conv_oai', fixedTime)});`
        + `return{content:r.content,generatedByFallback:r.generatedByFallback,attempts:r.generationAttempts,error:String(r.generationError||''),stats:_activeProactiveExecStatsSnapshot()}})()`);
      const directRun = await evaluate(cdp, `(async function(){window.runtimeExecuteEnabled=false;`
        + `var r=await generateProactiveMessage(${argsFor('conv_oai', fixedTime)});`
        + `window.runtimeExecuteEnabled=true;return{content:r.content,generatedByFallback:r.generatedByFallback,attempts:r.generationAttempts,error:String(r.generationError||''),stats:_activeProactiveExecStatsSnapshot()}})()`);
      assert.equal(runtimeRun.stats.lastExecutor, 'runtime');
      assert.equal(directRun.stats.lastExecutor, 'direct', '关闭开关必须回到 direct executor');
      assert.equal(runtimeRun.stats.lastFallbackReason, '', 'runtime 正常路径不应记录回落：' + runtimeRun.error + ' | logs=' + pageLogs.slice(-4).join(' || '));
      assert.equal(directRun.stats.lastFallbackReason, 'gate_disabled', '回滚必须记录原因');
      assert.equal(runtimeRun.content, directRun.content, '正文必须完全一致');
      assert.equal(runtimeRun.generatedByFallback, directRun.generatedByFallback);
      assert.equal(runtimeRun.attempts, directRun.attempts);
      const bodies = captured.filter(r => (r.url || '').startsWith('/oai/v1')).slice(-2).map(r => r.body);
      assert.equal(bodies.length, 2, '应各捕获一次请求');
      assert.deepEqual(bodies[0], bodies[1], '请求体（含 prompt/context/max_tokens/model）必须逐字段一致');
      assert.equal(bodies[0].max_tokens, 512);
    });

    /* 11-13. Chat / Group / Voice 仍不经过 Runtime */
    await check('Chat / Group / Voice 仍不经过 Runtime（telemetry consumer 归因）', async () => {
      const out = await evaluate(cdp, `(async function(){
        /* 隔离：后台调度（_activeTimer 每 30s 的 _activeTick、visibilitychange）本身就会经
           白名单 consumer 走 runtime.execute，与"Chat/Group/Voice 是否迁移"无关（曾随机 +2）。
           按 IB.runtime.telemetry.consumer 做**调用级归因**：consumer 的 telemetry 记录紧跟
           在它自己那次 execute settle 之后，因此每条记录认领"最近一个已结束且未认领"的调用。
           断言：已结束的 execute 必须全部被白名单 consumer
           （active.proactive / moments / diary / memory_consolidation）认领，否则失败。
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
        var R=IB.runtime.instance,or=R.run.bind(R),oe=R.execute.bind(R);window.__convCalls={run:0,execute:0};
        R.run=function(){window.__convCalls.run++;return or.apply(null,arguments)};
        R.execute=function(){
          window.__convCalls.execute++;
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
          return{run:window.__convCalls.run,execute:__calls.length,unclaimed:unclaimed,inflight:inflight,bad:bad};
        };
        var chatReply='';
        try{
          activeFriendId='conv_chat';activeThreadId=null;openChatPanel();
          var i=document.getElementById(currentPage==='chat'?'chat-full-input':'chat-input');i.value='CONV_CHAT_MSG';await sendChatMessage();
          var all=await dbGetAll('chatMessages');var m=all.filter(function(x){return x.friendId==='conv_chat'&&x.role==='assistant'}).slice(-1)[0];
          chatReply=String(m&&m.content||'');
          var afterChat={run:window.__convCalls.run,execute:window.__convCalls.execute};
          /* group */
          await dbPut('groups',{id:'conv_group',name:'Conv group',members:['conv_oai','conv_chat'],memoryEnabled:false});
          activeFriendId='conv_group';activeThreadId=null;openChatPanel();
          var gi=document.getElementById(currentPage==='chat'?'chat-full-input':'chat-input');gi.value='CONV_GROUP_MSG';await sendChatMessage();
          var afterGroup={run:window.__convCalls.run,execute:window.__convCalls.execute};
          /* voice：与 call.js onTranscript 同一条入口 */
          activeFriendId='conv_chat';
          var vres=await sendChatMessage({voiceCall:true,transcript:'CONV_VOICE_MSG',roleId:'conv_chat',conversationId:'voice-1',turnId:'t1'});
          var afterVoice={run:window.__convCalls.run,execute:window.__convCalls.execute};
          var acc=await __acc();
          return{chatReply:chatReply,afterChat:afterChat,afterGroup:afterGroup,afterVoice:afterVoice,acc:acc,voiceOk:!!(vres&&vres.ok)};
        }finally{R.run=or;R.execute=oe;if(__tel&&__rec)__tel.record=__rec}
      })()`);
      assert.ok(out.chatReply.length > 0, '对照组：Chat 本身必须正常产出回复');
      assert.equal(out.afterChat.run, 0, 'Chat 不得调用 runtime.run');
      assert.equal(out.afterGroup.run, 0, 'Group 不得调用 runtime.run');
      assert.equal(out.afterVoice.run, 0, 'Voice 不得调用 runtime.run');
      assert.deepEqual(out.acc.bad, [], 'runtime.execute 只能由白名单 consumer 归因：' + JSON.stringify(out.acc.bad));
      assert.equal(out.acc.unclaimed, 0,
        '存在已结束但无法归因的 runtime.execute 调用：' + out.acc.unclaimed + '（在途后台调用 ' + out.acc.inflight + '）');
      assert.equal(out.voiceOk, true, '对照组：Voice 入口本身可用');
    });

    /* 计数器自证：proactive 路径确实会让 runtime 计数增加。
       同样按 telemetry 归因计数（后台 tick 属于其它 consumer，不会污染本计数）。 */
    await check('proactive 路径确实计入 runtime（telemetry 归因自证）', async () => {
      const out = await evaluate(cdp, `(async function(){
        var cnt=function(){var all=IB.runtime.telemetry.recent(200),n=0;
          for(var i=0;i<all.length;i++){if(all[i].consumer==='active.proactive'&&all[i].executor==='runtime')n++}
          return n};
        var before=cnt();
        var r=await generateProactiveMessage(${argsFor('conv_oai', "{taskId:'conv_count_probe'}")});
        return{delta:cnt()-before,content:r.content}
      })()`);
      assert.equal(out.delta, 1, 'proactive 必须恰好产生一条 runtime telemetry 记录');
      assert.equal(out.content, 'CONV_REPLY');
    });

    /* 14. 迁移诊断（telemetry）已发出且不含敏感信息 */
    await check('迁移诊断已发出且不含 apiKey / prompt 正文', async () => {
      assert.ok(pageLogs.some(l => l.includes('model executor')), '必须发出 [ProactiveMessage] model executor 诊断');
      const joined = pageLogs.join('\n');
      for (const key of ['k-anth', 'k-gem']) assert.ok(!joined.includes(key), '诊断不得包含 apiKey：' + key);
      assert.ok(!/CONV_IDENTITY_/.test(joined), '诊断不得包含 prompt / 身份正文');
      assert.ok(!/与最近主动消息完全相同的一句话/.test(joined), '诊断不得包含消息正文');
    });

    console.log('\nRuntime convergence (proactive): ' + failures + ' failed');
    process.exitCode = failures ? 1 : 0;
  } finally {
    if (cdp) cdp.close();
    browser.kill();
    api.closeAllConnections(); web.closeAllConnections();
    await Promise.all([new Promise(r => api.close(r)), new Promise(r => web.close(r))]);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_) {}
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
