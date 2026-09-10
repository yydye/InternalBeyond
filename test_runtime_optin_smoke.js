'use strict';

/* Opt-in Runtime 契约 smoke（P2-02）。
   真实 localhost 页面 + 独立浏览器 profile + mock provider；只驱动 IB.runtime.instance，
   不迁移任何生产入口（并在最后断言生产聊天链没有调用 runtime）。
   覆盖：三协议 format 解析 / loadContext+identity / budget / abort(native|abandon|pre) /
        usage 归一 / composeMessages / opt-in 未被生产消费者调用。 */

const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const http = require('node:http'), assert = require('node:assert/strict');
const { spawn } = require('node:child_process');

/* 复用现有 CDP harness（test_chat_smoke.js 的辅助函数段），不新写一套。 */
const harness = fs.readFileSync(path.join(__dirname, 'test_chat_smoke.js'), 'utf8');
const boundary = harness.indexOf('async function main() {');
assert.ok(boundary > 0, 'existing CDP harness boundary changed');
const { chromePath, Cdp, evaluate, waitFor, freePort } = new Function('require', '__dirname',
  harness.slice(0, boundary) + '\nreturn {chromePath,Cdp,evaluate,waitFor,freePort};')(require, __dirname);

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const captured = [];
const api = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') { res.end(); return; }
  let raw = ''; for await (const chunk of req) raw += chunk;
  let body = null; try { body = JSON.parse(raw || '{}'); } catch (_) {}
  const url = req.url || '';
  captured.push({ url, body });
  /* 慢响应：用于 abandon 模式的 abort（执行器不读 abortController，只能靠竞速结束） */
  if (url.startsWith('/oai-slow')) {
    await new Promise(r => setTimeout(r, 6000));
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: 'SLOW_REPLY' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
    return;
  }
  /* SSE：先给一个 delta，然后保持连接不关闭，用于 native abort */
  if (url.startsWith('/oai-stream')) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Access-Control-Allow-Origin': '*' });
    res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'PARTIAL_NATIVE' } }] }) + '\n\n');
    await new Promise(r => setTimeout(r, 8000));
    try { res.end('data: [DONE]\n\n'); } catch (_) {}
    return;
  }
  let payload;
  if (url.startsWith('/anth')) {
    payload = { content: [{ type: 'text', text: 'OPTIN_ANTH_REPLY' }], stop_reason: 'end_turn',
      usage: { input_tokens: 20, output_tokens: 4, cache_read_input_tokens: 3, cache_creation_input_tokens: 2 } };
  } else if (url.startsWith('/gem')) {
    payload = { candidates: [{ content: { parts: [{ text: 'OPTIN_GEM_REPLY' }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 4, cachedContentTokenCount: 3 } };
  } else {
    payload = { choices: [{ message: { content: 'OPTIN_OAI_REPLY' }, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 4 } };
  }
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(payload));
});

(async () => {
  const apiPort = await listen(api), apiBase = 'http://127.0.0.1:' + apiPort;
  const web = require('./services/internal-beyond-server.js').createWebServer({ root: __dirname, port: 0 });
  const webPort = await listen(web), webBase = 'http://127.0.0.1:' + webPort;
  const debugPort = await freePort();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-runtime-optin-'));
  const chrome = chromePath(); assert.ok(chrome, 'Chrome or Edge required');
  const browser = spawn(chrome, ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    '--remote-debugging-port=' + debugPort, '--user-data-dir=' + profile, 'about:blank'], { stdio: 'ignore', windowsHide: true });
  let cdp, failures = 0;
  async function check(name, fn) {
    try { await fn(); console.log('  PASS  ' + name); }
    catch (e) { failures++; console.error('  FAIL  ' + name + '  -> ' + (e && e.message || e)); }
  }
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
    /* 隔离：只允许访问 mock provider 与本地 web server，挡住用户服务与真实 provider */
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `const _of=window.fetch.bind(window);window.fetch=function(input,opts){const u=new URL(typeof input==='string'?input:input.url,location.href);`
        + `if(u.origin!==${JSON.stringify(apiBase)}&&u.origin!==${JSON.stringify(webBase)})return Promise.reject(new Error('optin smoke blocks external service'));return _of(input,opts);};window.confirm=()=>true;`
    });
    await cdp.send('Page.navigate', { url: webBase + '/InternalBeyond.html' });
    assert.ok(await waitFor(cdp, "document.readyState==='complete' && window.IB && IB.runtime && IB.runtime.instance && typeof IB.runtime.instance.execute==='function' && typeof loadApiConfigs==='function'", 20000), 'runtime mounted over localhost');

    /* 三个 provider 配置（全部非流式，指向 mock；streaming 由 spec 单独覆盖） */
    const cfgs = [
      { id: 'optin_anth', provider: 'anthropic', endpoint: apiBase + '/anth/v1/messages', model: 'claude-optin', apiKey: 'k-anth' },
      { id: 'optin_gem', provider: 'gemini', endpoint: apiBase + '/gem/{model}:generateContent', model: 'gemini-optin', apiKey: 'k-gem' },
      { id: 'optin_oai', provider: 'custom', endpoint: apiBase + '/oai/v1/chat/completions', model: 'oai-optin', apiKey: '' }
    ].map(c => ({ ...c, nickname: c.id, streaming: false, promptCache: false, systemPrompt: 'OPTIN_IDENTITY_' + c.id, maxTokens: 777 }));
    await evaluate(cdp, `(async()=>{for(const c of ${JSON.stringify(cfgs)})await dbPut('apiConfigs',c);await loadApiConfigs();})()`);

    await check('format: 三协议 + custom + 未知 provider 不再静默回落', async () => {
      const got = await evaluate(cdp, `(function(){var R=IB.runtime.instance;var f=function(p){return R.resolveModel({provider:p,model:'m'})};`
        + `return{a:f('anthropic'),g:f('gemini'),o:f('openai'),c:f('custom'),u:f('no-such-provider'),e:f('')}})()`);
      assert.equal(got.a.format, 'anthropic'); assert.equal(got.a.formatKnown, true);
      assert.equal(got.g.format, 'gemini'); assert.equal(got.g.formatKnown, true);
      assert.equal(got.o.format, 'openai'); assert.equal(got.o.formatKnown, true);
      assert.equal(got.c.format, 'openai'); assert.equal(got.c.formatKnown, true);
      assert.equal(got.u.format, 'openai'); assert.equal(got.u.formatKnown, false, '未知 provider 必须如实标记 formatKnown=false');
      assert.equal(got.u.formatSource, 'unknown-provider-default');
      assert.equal(got.e.formatKnown, false);
    });

    /* 各协议真实计量口径（来自执行器 _tkRecord 的字段映射，逐项核对后写死）：
         anthropic：input_tokens 原样（含缓存读），cache_read → cached_tokens；
         gemini   ：promptTokenCount - cachedContentTokenCount → input_tokens（非缓存输入），cachedContentTokenCount → cached_tokens；
         openai   ：prompt_tokens → input_tokens，无缓存明细时 cached_tokens=0。 */
    const expectedUsage = {
      anthropic: { input_tokens: 20, output_tokens: 4, total_tokens: 24, cached_tokens: 3 },
      gemini: { input_tokens: 17, output_tokens: 4, total_tokens: 21, cached_tokens: 3 },
      custom: { input_tokens: 20, output_tokens: 4, total_tokens: 24, cached_tokens: 0 }
    };

    for (const cfg of cfgs) {
      await check('execute: ' + cfg.provider + ' 走真实 wire 并归一 usage', async () => {
        const before = captured.length;
        const out = await evaluate(cdp, `(async()=>{var R=IB.runtime.instance;var cfg=apiConfigs.find(function(a){return a.id===${JSON.stringify(cfg.id)}});`
          + `var spec=R.resolveModel(cfg);var events=[];var r=await R.execute({spec:spec,messages:[{role:'system',content:spec.systemPrompt},{role:'user',content:'OPTIN_MSG'}],budget:1234},{onEvent:function(e){events.push(e)}});`
          + `return{r:r,events:events,spec:spec}})()`);
        assert.equal(out.r.aborted, false);
        assert.ok(/OPTIN_(ANTH|GEM|OAI)_REPLY/.test(out.r.text), 'reply text: ' + out.r.text);
        assert.equal(out.r.usageSource, 'executor', 'usage 必须来自执行器');
        assert.deepEqual(out.r.usage, expectedUsage[cfg.provider]);
        const done = out.events.filter(e => e.type === 'done');
        assert.equal(done.length, 1, '必须恰好一个 done 事件');
        assert.deepEqual(done[0].usage, out.r.usage);
        assert.equal(out.r.abortMode, 'none');
        const req = captured.slice(before).find(r => JSON.stringify(r.body).includes('OPTIN_MSG'));
        assert.ok(req, '请求必须到达 mock provider');
        if (cfg.provider === 'anthropic') {
          assert.equal(req.body.max_tokens, 1234, 'budget 必须进入 anthropic max_tokens');
          assert.ok(typeof req.body.system === 'string' && req.body.system.includes('OPTIN_IDENTITY_'), 'identity 必须在 anthropic system');
          assert.ok(req.body.messages.every(m => m.role !== 'system'));
        } else if (cfg.provider === 'gemini') {
          assert.equal(req.body.generationConfig.maxOutputTokens, 1234, 'budget 必须进入 gemini maxOutputTokens');
          assert.ok(req.body.system_instruction.parts[0].text.includes('OPTIN_IDENTITY_'), 'identity 必须在 system_instruction');
          assert.ok(Array.isArray(req.body.contents));
        } else {
          assert.equal(req.body.max_tokens, 1234, 'budget 必须进入 openai max_tokens');
          assert.ok(req.body.messages.some(m => m.role === 'system' && m.content.includes('OPTIN_IDENTITY_')), 'identity 必须在 messages');
        }
      });
    }

    await check('budget: input > cfg > executor-default 优先级', async () => {
      const got = await evaluate(cdp, `(function(){var R=IB.runtime.instance;var cfg=apiConfigs.find(function(a){return a.id==='optin_oai'});`
        + `var agent={id:cfg.id,cfg:cfg,identity:cfg.systemPrompt};`
        + `return{byCfg:R.resolveBudget(agent,{}),byInput:R.resolveBudget(agent,{maxTokens:99}),plain:R.resolveBudget({id:'x',cfg:{id:'x'}},{})}})()`);
      assert.deepEqual(got.byCfg, { maxTokens: 777, source: 'cfg' });
      assert.deepEqual(got.byInput, { maxTokens: 99, source: 'input' });
      assert.deepEqual(got.plain, { maxTokens: null, source: 'executor-default' });
    });

    await check('loadContext + composeMessages 契约', async () => {
      const got = await evaluate(cdp, `(async function(){var R=IB.runtime.instance;`
        + `var stub=async function(){return{chatSummary:'SUM_X',recentMessages:[{role:'user',content:'H1'},{role:'assistant',content:'H2'}]}};`
        + `var origW=window._momentsContext, origN=IB.moments&&IB.moments._momentsContext;`
        + `window._momentsContext=stub;if(IB.moments)IB.moments._momentsContext=stub;`
        + `var agent={id:'a',cfg:{id:'a',systemPrompt:'SYS_ID',relationship:'伙伴'},identity:'SYS_ID',relationship:'伙伴'};`
        + `var ctx=await R.loadContext(agent);`
        + `var composed=R.composeMessages(agent,ctx,{messages:[{role:'user',content:'NOW'}]});`
        + `window._momentsContext=origW;if(IB.moments&&origN)IB.moments._momentsContext=origN;`
        + `return{ctx:ctx,system:composed.system,roles:composed.messages.map(function(m){return m.role}),contents:composed.messages.map(function(m){return m.content})}})()`);
      /* 缺省字段必须补齐（契约形状稳定），委托结果必须保留 */
      assert.deepEqual(got.ctx.memories, []);
      assert.deepEqual(got.ctx.recentMoments, []);
      assert.deepEqual(got.ctx.roleLetterMemories, []);
      assert.equal(got.ctx.lastInteractionAt, 0);
      assert.equal(got.ctx.chatSummary, 'SUM_X');
      assert.equal(got.ctx.recentMessages.length, 2);
      assert.ok(got.system.includes('SYS_ID') && got.system.includes('伙伴') && got.system.includes('SUM_X'), 'system: ' + got.system);
      assert.deepEqual(got.roles, ['system', 'user', 'assistant', 'user']);
      assert.deepEqual(got.contents, [got.system, 'H1', 'H2', 'NOW']);
    });

    await check('run(): identity 进入请求，usage/abortMode/budget 结构化返回', async () => {
      const before = captured.length;
      const got = await evaluate(cdp, `(async function(){var R=IB.runtime.instance;var cfg=apiConfigs.find(function(a){return a.id==='optin_oai'});`
        + `var r=await R.run({cfg:cfg,messages:[{role:'user',content:'RUN_MSG'}]});`
        + `return{text:r.text,usage:r.usage,usageSource:r.usageSource,budget:r.budget,abortMode:r.abortMode,aborted:r.aborted,system:r.system,identity:r.agent.identity,format:r.model.format,events:r.events.length}})()`);
      assert.equal(got.text, 'OPTIN_OAI_REPLY');
      assert.equal(got.identity, 'OPTIN_IDENTITY_optin_oai');
      assert.ok(got.system.includes('OPTIN_IDENTITY_optin_oai'), 'run() 必须把 identity 编进 system');
      assert.deepEqual(got.budget, { maxTokens: 777, source: 'cfg' });
      assert.equal(got.format, 'openai');
      assert.deepEqual(got.usage, expectedUsage.custom);
      assert.equal(got.usageSource, 'executor');
      assert.equal(got.aborted, false);
      const req = captured.slice(before).find(r => JSON.stringify(r.body).includes('RUN_MSG'));
      assert.ok(req && req.body.max_tokens === 777, 'cfg.maxTokens 必须生效');
      assert.ok(req.body.messages.some(m => m.role === 'system' && m.content.includes('OPTIN_IDENTITY_')), 'identity 必须到达 provider');
    });

    await check('abort.native: 流式 signal 中断 → 及时结束且不冒充成功', async () => {
      const got = await evaluate(cdp, `(async function(){var R=IB.runtime.instance;`
        + `var cfg={id:'optin_stream',provider:'custom',model:'s',endpoint:${JSON.stringify(apiBase + '/oai-stream')},apiKey:'',streaming:true,promptCache:false,systemPrompt:'STREAM_ID'};`
        + `var spec=R.resolveModel(cfg);var ac=new AbortController();var t0=Date.now();`
        + `var p=R.execute({spec:spec,messages:[{role:'user',content:'ABORT_NATIVE'}]},{signal:ac.signal});`
        + `setTimeout(function(){ac.abort()},400);var r=await p;return{ms:Date.now()-t0,r:r}})()`);
      assert.equal(got.r.aborted, true, '必须标记 aborted');
      assert.equal(got.r.abortMode, 'native');
      assert.equal(got.r.text, '', '中止不得把部分文本当成成功结果');
      assert.equal(got.r.partialText, 'PARTIAL_NATIVE', '中止前的文本必须在 partialText 保留');
      assert.ok(got.r.error && got.r.error.kind === 'abort', '错误必须归类为 abort（不是 timeout）: ' + JSON.stringify(got.r.error));
      assert.ok(got.ms < 5000, '必须在 5s 内结束，实际 ' + got.ms + 'ms');
    });

    await check('abort.abandon: 非流式 signal 中断 → 竞速结束（不悬挂）', async () => {
      const got = await evaluate(cdp, `(async function(){var R=IB.runtime.instance;`
        + `var cfg={id:'optin_slow',provider:'custom',model:'s',endpoint:${JSON.stringify(apiBase + '/oai-slow')},apiKey:'',streaming:false,promptCache:false,systemPrompt:'SLOW_ID'};`
        + `var spec=R.resolveModel(cfg);var ac=new AbortController();var t0=Date.now();`
        + `var p=R.execute({spec:spec,messages:[{role:'user',content:'ABORT_ABANDON'}]},{signal:ac.signal});`
        + `setTimeout(function(){ac.abort()},300);var r=await p;return{ms:Date.now()-t0,r:r}})()`);
      assert.equal(got.r.aborted, true);
      assert.equal(got.r.abortMode, 'abandon');
      assert.ok(got.r.error && got.r.error.kind === 'abort', JSON.stringify(got.r.error));
      assert.ok(got.ms < 2500, 'abandon 模式也必须及时结束，实际 ' + got.ms + 'ms');
    });

    await check('abort.pre: 已中止的 signal 不再发起请求', async () => {
      const before = captured.length;
      const got = await evaluate(cdp, `(async function(){var R=IB.runtime.instance;var cfg=apiConfigs.find(function(a){return a.id==='optin_oai'});`
        + `var spec=R.resolveModel(cfg);var ac=new AbortController();ac.abort();`
        + `var r=await R.execute({spec:spec,messages:[{role:'user',content:'ABORT_PRE'}]},{signal:ac.signal});return r})()`);
      assert.equal(got.aborted, true);
      assert.ok(got.error && got.error.kind === 'abort');
      assert.equal(captured.slice(before).filter(r => JSON.stringify(r.body).includes('ABORT_PRE')).length, 0, '预中止不得发出请求');
    });

    await check('opt-in 未被生产入口调用（Chat 一轮后 runtime 计数为 0）', async () => {
      const got = await evaluate(cdp, `(async function(){var R=IB.runtime.instance;var runs=0,execs=0;`
        + `var orun=R.run.bind(R),oexec=R.execute.bind(R);`
        + `R.run=function(){runs++;return orun.apply(null,arguments)};R.execute=function(){execs++;return oexec.apply(null,arguments)};`
        + `activeFriendId='optin_oai';activeThreadId=null;openChatPanel();`
        + `document.getElementById(currentPage==='chat'?'chat-full-input':'chat-input').value='OPTIN_PROD_CHAT';`
        + `await sendChatMessage();R.run=orun;R.execute=oexec;`
        + `var stored=(await dbGetAll('chatMessages')).some(function(m){return m.friendId==='optin_oai'&&m.role==='assistant'&&m.content==='OPTIN_OAI_REPLY'});`
        + `return{runs:runs,execs:execs,stored:stored}})()`);
      assert.equal(got.runs, 0, '生产聊天不得调用 runtime.run');
      assert.equal(got.execs, 0, '生产聊天不得调用 runtime.execute');
      assert.equal(got.stored, true, '对照组：生产聊天链本身仍然可用');
    });

    console.log('\nRuntime opt-in smoke: ' + failures + ' failed');
    process.exitCode = failures ? 1 : 0;
  } finally {
    if (cdp) cdp.close();
    browser.kill();
    api.closeAllConnections(); web.closeAllConnections();
    await Promise.all([new Promise(r => api.close(r)), new Promise(r => web.close(r))]);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_) {}
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
