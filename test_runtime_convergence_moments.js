'use strict';

/* ====================================================================
   Runtime Convergence Phase 2 · Moments execute 迁移回归
   --------------------------------------------------------------------
   唯一被迁移的接缝：assets/js/moments.js → _obsCall
     三个上层 consumer（generateRoleMoment / generateRoleComment / generateRoleReply）
     不感知执行器差异：
       Prompt/Context（未改） → _obsCall → _momentsModelCall
                                           ├─ IB.runtime.instance.execute（默认）
                                           └─ callApiChat（回滚 / 接缝不可用）
   覆盖：三协议 JSON contract 逐字段对照、jsonMode/disableTools/budget/identity、usage、
        invalid JSON 原 retry、runtime error 不双调用、abort 不 retry、gate/unavailable 回 direct、
        三 consumer 共用接缝、proactive 仍走 Runtime、Chat/Group/Voice 计数 0。
   真实 localhost 页面 + 独立 profile + mock provider；不触达用户服务与真实 provider。
   运行：node test_runtime_convergence_moments.js
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

const captured = [];   /* {url, body, headers, kind, text} */
const hits = {};       /* path key → 次数 */

const MOMENT_JSON = JSON.stringify({ publish: true, content: 'CONV_MOMENT_TEXT', visibility: 'all', motive: 'daily_life' });
const COMMENT_JSON = JSON.stringify({ publishComment: true, comment: 'CONV_COMMENT_TEXT' });
const REPLY_JSON = JSON.stringify({ publishReply: true, comment: 'CONV_REPLY_TEXT', replyTo: '' });

const api = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') { res.end(); return; }
  let raw = ''; for await (const chunk of req) raw += chunk;
  let body = null; try { body = JSON.parse(raw || '{}'); } catch (_) {}
  const url = req.url || '';
  const key = url.startsWith('/anth') ? 'anth'
    : url.startsWith('/gem') ? 'gem'
      : url.startsWith('/oai-fail') ? 'fail'
        : url.startsWith('/oai-slow') ? 'slow'
          : url.startsWith('/oai-bad') ? 'bad' : 'oai';
  hits[key] = (hits[key] || 0) + 1;
  const entry = { url, body, headers: req.headers, key, n: hits[key] };
  captured.push(entry);

  if (key === 'fail') {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'convergence moments mock failure' } }));
    return;
  }
  if (key === 'slow') {
    await new Promise(r => setTimeout(r, 5000));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: MOMENT_JSON }, finish_reason: 'stop' }] }));
    return;
  }
  /* 主动消息（Phase 1 consumer）：返回纯文本，避免被当成 JSON 结构 */
  const isProactive = raw.includes('【本次主动消息目的】');
  let text;
  if (isProactive) text = 'CONV_PROACTIVE_TEXT';
  else if (raw.includes('publishReply')) text = REPLY_JSON;
  else if (raw.includes('publishComment')) text = COMMENT_JSON;
  else text = MOMENT_JSON;
  if (key === 'bad') text = hits.bad === 1 ? '这不是 JSON' : MOMENT_JSON;
  entry.text = text;

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
  const web = require('./services/internal-beyond-server.js').createWebServer({ root: __dirname, port: 0 });
  const webPort = await listen(web), webBase = 'http://127.0.0.1:' + webPort;
  const debugPort = await freePort();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-conv-moments-'));
  const chrome = chromePath(); assert.ok(chrome, 'Chrome or Edge required');
  const browser = spawn(chrome, ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    '--remote-debugging-port=' + debugPort, '--user-data-dir=' + profile, 'about:blank'], { stdio: 'ignore', windowsHide: true });
  let cdp, failures = 0;
  const pageLogs = [];
  async function check(name, fn) {
    try { await fn(); console.log('  PASS  ' + name); }
    catch (e) { failures++; console.error('  FAIL  ' + name + '  -> ' + (e && e.message || e)); }
  }
  const reqsFor = (from, key, marker) => captured.slice(from)
    .filter(r => r.key === key && (!marker || JSON.stringify(r.body || {}).includes(marker)));
  const lastBody = (from, key) => (captured.slice(from).filter(r => r.key === key).slice(-1)[0] || {}).body;

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
    cdp.on('Runtime.consoleAPICalled', p => {
      try { pageLogs.push(String(p.type) + ': ' + (p.args || []).map(a => a.value !== undefined ? a.value : (a.description || a.type)).join(' ').slice(0, 300)); } catch (_) {}
    });
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `const _of=window.fetch.bind(window);window.fetch=function(input,opts){const u=new URL(typeof input==='string'?input:input.url,location.href);`
        + `if(u.origin!==${JSON.stringify(apiBase)}&&u.origin!==${JSON.stringify(webBase)})return Promise.reject(new Error('convergence smoke blocks external service'));return _of(input,opts);};window.confirm=()=>true;`
    });
    await cdp.send('Page.navigate', { url: webBase + '/InternalBeyond.html' });
    assert.ok(await waitFor(cdp, "document.readyState==='complete' && typeof _obsCall==='function' && typeof generateRoleMoment==='function' && typeof generateRoleReply==='function' && window.IB && IB.runtime && IB.runtime.instance && IB.runtime.telemetry && typeof loadApiConfigs==='function'", 20000), 'moments seam + runtime + telemetry mounted');

    const cfgs = [
      { id: 'cm_anth', provider: 'anthropic', endpoint: apiBase + '/anth/v1/messages', model: 'cm-anth-model', apiKey: 'k-anth', expectFormat: 'anthropic' },
      { id: 'cm_gem', provider: 'gemini', endpoint: apiBase + '/gem/{model}:generateContent', model: 'cm-gem-model', apiKey: 'k-gem', expectFormat: 'gemini' },
      { id: 'cm_oai', provider: 'custom', endpoint: apiBase + '/oai/v1/chat/completions', model: 'cm-oai-model', apiKey: '', expectFormat: 'openai' },
      { id: 'cm_author', provider: 'custom', endpoint: apiBase + '/oai/v1/chat/completions', model: 'cm-author-model', apiKey: '', expectFormat: 'openai' },
      { id: 'cm_fail', provider: 'custom', endpoint: apiBase + '/oai-fail/v1/chat/completions', model: 'cm-fail-model', apiKey: '', expectFormat: 'openai' },
      { id: 'cm_slow', provider: 'custom', endpoint: apiBase + '/oai-slow/v1/chat/completions', model: 'cm-slow-model', apiKey: '', expectFormat: 'openai' },
      { id: 'cm_bad', provider: 'custom', endpoint: apiBase + '/oai-bad/v1/chat/completions', model: 'cm-bad-model', apiKey: '', expectFormat: 'openai' },
      { id: 'cm_shared', provider: 'custom', endpoint: apiBase + '/oai/v1/chat/completions', model: 'cm-shared-model', apiKey: '', expectFormat: 'openai' },
      { id: 'cm_gate', provider: 'custom', endpoint: apiBase + '/oai/v1/chat/completions', model: 'cm-gate-model', apiKey: '', expectFormat: 'openai' },
      { id: 'cm_unavail', provider: 'custom', endpoint: apiBase + '/oai/v1/chat/completions', model: 'cm-unavail-model', apiKey: '', expectFormat: 'openai' },
      { id: 'cm_chat', provider: 'custom', endpoint: apiBase + '/oai/v1/chat/completions', model: 'cm-chat-model', apiKey: '', expectFormat: 'openai' }
    ].map(c => ({ ...c, nickname: c.id, streaming: false, promptCache: false, systemPrompt: 'CONV_IDENTITY_' + c.id, relationship: '伙伴' }));
    await evaluate(cdp, `(async()=>{for(const c of ${JSON.stringify(cfgs)})await dbPut('apiConfigs',c);await loadApiConfigs();`
      + `_momentsPrefsSave({enabled:true,autoPublish:true,frequency:'medium',aiComment:true,aiLike:false});`
      + `try{_diaryPrefsSave({enabled:false,weeklyEnabled:false,dailyPlannerEnabled:false,eventEnabled:false})}catch(e){}`
      + `try{if(window._activeTimer){clearInterval(window._activeTimer);window._activeTimer=null}}catch(e){}`
      + `window.runtimeMomentsExecuteEnabled=undefined;window.runtimeExecuteEnabled=true;`
      + `return true})()`);

    const lastTelemetry = () => evaluate(cdp, `(function(){var r=IB.runtime.telemetry.recent(1);return r&&r[0]||null})()`);
    const telemetryFor = kind => evaluate(cdp, `(function(){var all=IB.runtime.telemetry.recent(50);for(var i=all.length-1;i>=0;i--){if(all[i].kind===${JSON.stringify(kind)}&&all[i].consumer==='moments')return all[i]}return null})()`);

    /* ══ 1-3 / 6-9：三协议 JSON contract 逐字段对照（runtime vs direct）+ 结构语义 ══ */
    for (const cfg of cfgs.slice(0, 3)) {
      await check('JSON contract.' + cfg.expectFormat + '：runtime ↔ direct 请求体逐字段一致', async () => {
        const from = captured.length;
        const probe = await evaluate(cdp, `(async function(){
          var cfg=apiConfigs.find(function(a){return a.id===${JSON.stringify(cfg.id)}});
          var msgs=[{role:'system',content:'CONV_SYS'},{role:'user',content:'CONV_USER'}];
          var opts={maxTokens:2000,timeoutMs:120000,wantMeta:false,jsonMode:true,_noWebSearch:true,disableTools:true};
          window.runtimeMomentsExecuteEnabled=true;
          var a=await _obsCall('moment',cfg,msgs,opts);
          window.runtimeMomentsExecuteEnabled=false;
          var b=await _obsCall('moment',cfg,msgs,opts);
          window.runtimeMomentsExecuteEnabled=undefined;
          return {runtime:a,direct:b,same:a===b};
        })()`);
        assert.equal(probe.same, true, '两条路径返回的原始文本必须一致');
        const reqs = reqsFor(from, cfg.id === 'cm_anth' ? 'anth' : cfg.id === 'cm_gem' ? 'gem' : 'oai', 'CONV_SYS');
        assert.equal(reqs.length, 2, '应各捕获一次请求');
        assert.deepEqual(reqs[0].body, reqs[1].body, 'runtime 与 direct 请求体必须逐字段一致');
        const body = reqs[0].body;
        /* jsonMode 语义 */
        if (cfg.expectFormat === 'openai') {
          assert.equal(body.response_format && body.response_format.type, 'json_object', 'openai jsonMode → response_format');
        } else if (cfg.expectFormat === 'gemini') {
          assert.equal(body.generationConfig.responseMimeType, 'application/json', 'gemini jsonMode → responseMimeType');
        } else {
          assert.ok(!('response_format' in body) && !('responseMimeType' in body), 'anthropic jsonMode 不新增字段（与 direct 一致）');
        }
        /* disableTools 语义：两种路径都不得带 tools */
        assert.ok(!('tools' in body), 'disableTools → 不得出现 tools');
        /* budget */
        if (cfg.expectFormat === 'gemini') assert.equal(body.generationConfig.maxOutputTokens, 2000);
        else assert.equal(body.max_tokens, 2000);
        /* identity / system 位置 */
        if (cfg.expectFormat === 'anthropic') {
          assert.equal(body.system, 'CONV_SYS');
          assert.ok(body.messages.every(m => m.role !== 'system'));
          assert.equal(body.messages[0].content, 'CONV_USER');
        } else if (cfg.expectFormat === 'gemini') {
          assert.equal(body.system_instruction.parts[0].text, 'CONV_SYS');
          assert.equal(body.contents[0].parts[0].text, 'CONV_USER');
        } else {
          assert.equal(body.messages[0].role, 'system');
          assert.equal(body.messages[0].content, 'CONV_SYS');
          assert.equal(body.messages[1].content, 'CONV_USER');
        }
        /* format / provider / model identity */
        if (cfg.expectFormat === 'gemini') assert.ok(reqs[0].url.includes(cfg.model), 'gemini model 在 URL');
        else assert.equal(body.model, cfg.model);
      });
    }

    /* ══ 1-3：三个 consumer 之一（发帖）经 Runtime 三协议 ══ */
    for (const cfg of cfgs.slice(0, 3)) {
      await check('moment.' + cfg.expectFormat + ' → runtime 发布成功', async () => {
        const from = captured.length;
        const out = await evaluate(cdp, `(async function(){var r=await generateRoleMoment(${JSON.stringify(cfg.id)},{trigger:'manual'});`
          + `return{ok:r.ok,published:r.published,content:r.moment&&r.moment.content,err:r.error}})()`);
        assert.equal(out.ok, true, 'generateRoleMoment 失败：' + out.err);
        assert.equal(out.published, true);
        assert.equal(out.content, 'CONV_MOMENT_TEXT');
        assert.ok(reqsFor(from, cfg.expectFormat === 'anthropic' ? 'anth' : cfg.expectFormat === 'gemini' ? 'gem' : 'oai').length >= 1, '应发出模型请求');
        const tel = await telemetryFor('moment');
        assert.equal(tel.executor, 'runtime');
        assert.equal(tel.format, cfg.expectFormat);
        assert.equal(tel.jsonMode, true, 'telemetry 必须记录 jsonMode');
        assert.equal(tel.consumer, 'moments');
      });
    }

    /* ══ 4：角色评论 → Runtime ══ */
    let authorMomentId = '';
    await check('comment → runtime 且 kind=comment', async () => {
      const created = await evaluate(cdp, `(async function(){var r=await createMoment({roleId:'cm_author',content:'CONV_AUTHOR_MOMENT',source:'manual',visibility:'all'});return r.moment&&r.moment.id})()`);
      assert.ok(created, '需要一条被评论的动态');
      authorMomentId = created;
      const from = captured.length;
      const out = await evaluate(cdp, `(async function(){var r=await generateRoleComment('cm_oai',${JSON.stringify(created)});return{ok:r.ok,published:r.published,c:r.comment&&r.comment.content,err:r.error}})()`);
      assert.equal(out.ok, true, '评论失败：' + out.err);
      assert.equal(out.published, true);
      assert.equal(out.c, 'CONV_COMMENT_TEXT');
      assert.equal(reqsFor(from, 'oai').length, 1);
      const tel = await telemetryFor('comment');
      assert.equal(tel.executor, 'runtime');
      assert.equal(tel.format, 'openai');
      assert.equal(tel.jsonMode, true);
    });

    /* ══ 5：回复链 → Runtime ══ */
    await check('reply → runtime 且 kind=reply', async () => {
      const from = captured.length;
      const out = await evaluate(cdp, `(async function(){var r=await generateRoleReply('cm_gem',${JSON.stringify(authorMomentId)},{force:true});return{ok:r.ok,published:r.published,c:r.comment&&r.comment.content,err:r.error}})()`);
      assert.equal(out.ok, true, '回复失败：' + out.err);
      assert.equal(out.published, true);
      assert.equal(out.c, 'CONV_REPLY_TEXT');
      assert.equal(reqsFor(from, 'gem').length, 1);
      const tel = await telemetryFor('reply');
      assert.equal(tel.executor, 'runtime');
      assert.equal(tel.format, 'gemini');
    });

    /* ══ 10：usage 回传（seam 必须把执行器计量写进 telemetry） ══ */
    await check('usage 回传（telemetry usage=present）', async () => {
      const tel = await telemetryFor('moment');
      assert.equal(tel.usage, 'present', 'runtime 路径必须报告 usage 存在');
      const records = await evaluate(cdp, `(function(){var all=IB.runtime.telemetry.recent(50);return all.filter(function(r){return r.consumer==='moments'&&r.executor==='runtime'}).map(function(r){return{kind:r.kind,usage:r.usage,format:r.format}})})()`);
      assert.ok(records.length >= 5, 'moments 记录数：' + records.length);
      assert.ok(records.every(r => r.usage === 'present'), '所有 runtime 记录都应报告 usage：' + JSON.stringify(records));
    });

    /* ══ 16：三个 consumer 共用同一接缝（同一次 runtime.execute 计数 = 3） ══ */
    await check('三个 consumer 共用 _obsCall 接缝', async () => {
      const out = await evaluate(cdp, `(async function(){
        var R=IB.runtime.instance,oe=R.execute.bind(R);var n=0;
        R.execute=function(){n++;return oe.apply(null,arguments)};
        try{
          var m=await createMoment({roleId:'cm_shared',content:'CONV_SHARED_SEAM',source:'manual',visibility:'all'});
          await generateRoleMoment('cm_shared',{trigger:'manual'});
          await generateRoleComment('cm_oai',m.moment.id);
          await generateRoleReply('cm_gem',m.moment.id,{force:true});
          return{n:n};
        }finally{R.execute=oe}
      })()`);
      assert.equal(out.n, 3, '发帖/评论/回复必须都经同一个 execute 接缝');
      assert.equal(await evaluate(cdp, `typeof window._obsCall==='function' && IB.moments && IB.moments._obsCall===window._obsCall`), true, '_obsCall 必须是唯一接缝（双挂载同一函数）');
    });

    /* ══ 11：invalid JSON → 原 retry（提示词重写 + 第 2 次成功） ══ */
    await check('invalid JSON 仍进入原 retry 链', async () => {
      const from = captured.length;
      const out = await evaluate(cdp, `(async function(){var r=await generateRoleMoment('cm_bad',{trigger:'manual'});`
        + `return{ok:r.ok,published:r.published,content:r.moment&&r.moment.content,err:r.error}})()`);
      assert.equal(out.ok, true, '第二次应成功：' + out.err);
      assert.equal(out.content, 'CONV_MOMENT_TEXT');
      const reqs = reqsFor(from, 'bad');
      assert.equal(reqs.length, 2, 'invalid JSON → 原 retry 恰好 2 次请求');
      assert.ok(JSON.stringify(reqs[1].body).includes('【注意】上次输出不符合要求'), '第二次必须带上原 retry 提示（prompt 构建未变）');
      assert.equal(reqs[0].text, '这不是 JSON');
    });

    /* ══ 12：runtime executor error → 不回落 direct、不双调用 ══ */
    await check('runtime executor error 不触发 direct 双调用', async () => {
      const from = captured.length;
      const out = await evaluate(cdp, `(async function(){
        var t0=Date.now();
        var r=await generateRoleMoment('cm_fail',{trigger:'manual'});
        var recs=IB.runtime.telemetry.recent(60).filter(function(x){return x.at>=t0&&x.consumer==='moments'});
        return{ok:r.ok,err:r.error,recs:recs.map(function(x){return{executor:x.executor,ok:x.ok,fallbackReason:x.fallbackReason}})};
      })()`);
      assert.equal(out.ok, false, 'provider 500 → 生成失败');
      assert.ok(/convergence moments mock failure|500/.test(String(out.err || '')), '应保留 provider 错误：' + out.err);
      assert.equal(reqsFor(from, 'fail').length, 1, '同一 attempt 只能一次 provider 调用');
      assert.equal(out.recs.length, 1, '本次调用只应产生一条 telemetry：' + JSON.stringify(out.recs));
      assert.equal(out.recs[0].executor, 'runtime');
      assert.equal(out.recs[0].ok, false);
      assert.equal(out.recs[0].fallbackReason, '', '不得回落到 direct（禁止双调用）：' + JSON.stringify(out.recs));
    });

    /* ══ 13：abort → 不 retry、不双调用 ══ */
    await check('abort 不 retry（consumer 与接缝两层）', async () => {
      const from = captured.length;
      const out = await evaluate(cdp, `(async function(){
        var ac=new AbortController();
        var p=generateRoleMoment('cm_slow',{trigger:'manual',signal:ac.signal});
        setTimeout(function(){ac.abort()},250);
        var r=await p;
        var seam='';
        try{var ac2=new AbortController();ac2.abort();await _obsCall('moment',apiConfigs.find(function(a){return a.id==='cm_oai'}),[{role:'user',content:'X'}],{maxTokens:10,jsonMode:true,disableTools:true,signal:ac2.signal})}catch(e){seam=String(e&&e.name||'')}
        return{ok:r.ok,err:r.error,seam:seam};
      })()`);
      assert.equal(out.ok, false, '中止必须失败返回');
      assert.equal(out.seam, 'AbortError', '接缝在已中止的 signal 上必须抛 AbortError');
      assert.equal(reqsFor(from, 'slow').length, 1, '中止后不得重试');
      await new Promise(r => setTimeout(r, 800));
      assert.equal(reqsFor(from, 'slow').length, 1, '等待期间也不得出现第二次请求');
      const tel = await telemetryFor('moment');
      assert.equal(tel.abortReason, 'abort', 'telemetry 必须记录 abort reason');
      assert.equal(tel.executor, 'runtime');
    });

    /* ══ 14：gate=false → direct ══ */
    await check('gate=false 回 direct（记录 fallbackReason）', async () => {
      const from = captured.length;
      const out = await evaluate(cdp, `(async function(){
        window.runtimeMomentsExecuteEnabled=false;
        try{var r=await generateRoleMoment('cm_gate',{trigger:'manual'});return{ok:r.ok,published:r.published,tel:IB.runtime.telemetry.recent(1)[0]}}
        finally{window.runtimeMomentsExecuteEnabled=undefined}
      })()`);
      assert.equal(out.ok, true);
      assert.equal(out.published, true);
      assert.equal(out.tel.executor, 'direct');
      assert.equal(out.tel.fallbackReason, 'gate_disabled');
      assert.equal(out.tel.consumer, 'moments');
      assert.equal(reqsFor(from, 'oai').length >= 1, true);
    });

    /* ══ 15：runtime 不可用 → direct ══ */
    await check('runtime 不可用回 direct（runtime_unavailable）', async () => {
      const out = await evaluate(cdp, `(async function(){
        var R=IB.runtime.instance,orig=R.execute;R.execute=null;
        try{var r=await generateRoleMoment('cm_unavail',{trigger:'manual'});return{ok:r.ok,published:r.published,tel:IB.runtime.telemetry.recent(1)[0]}}
        finally{R.execute=orig}
      })()`);
      assert.equal(out.ok, true);
      assert.equal(out.published, true);
      assert.equal(out.tel.executor, 'direct');
      assert.equal(out.tel.fallbackReason, 'runtime_unavailable');
    });

    /* ══ 17：Phase 1 的 proactive consumer 仍在 Runtime 上 ══ */
    await check('proactive consumer 仍使用 Runtime', async () => {
      const out = await evaluate(cdp, `(async function(){
        var cfg=apiConfigs.find(function(a){return a.id==='cm_oai'});
        var r=await generateProactiveMessage({character:cfg,user:{name:'用户'},recentMessages:[],memories:[],recentProactiveMessages:[],currentTime:new Date(),messageMode:'greeting',taskId:'conv_p2_proactive'});
        var tel=null,all=IB.runtime.telemetry.recent(30);
        for(var i=all.length-1;i>=0;i--){if(all[i].consumer==='active.proactive'){tel=all[i];break}}
        return{content:r.content,tel:tel};
      })()`);
      assert.equal(out.content, 'CONV_PROACTIVE_TEXT');
      assert.ok(out.tel, 'proactive 必须写入统一 telemetry');
      assert.equal(out.tel.executor, 'runtime');
      assert.equal(out.tel.consumer, 'active.proactive');
    });

    /* ══ 18-20：Chat / Group / Voice 仍不经过 Runtime ══ */
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
        var R=IB.runtime.instance,or=R.run.bind(R),oe=R.execute.bind(R);window.__cmCalls={run:0,execute:0};
        R.run=function(){window.__cmCalls.run++;return or.apply(null,arguments)};
        R.execute=function(){
          window.__cmCalls.execute++;
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
          return{run:window.__cmCalls.run,execute:__calls.length,unclaimed:unclaimed,inflight:inflight,bad:bad};
        };
        try{
          activeFriendId='cm_chat';activeThreadId=null;openChatPanel();
          var i=document.getElementById(currentPage==='chat'?'chat-full-input':'chat-input');i.value='CONV_CHAT_MSG';await sendChatMessage();
          var all=await dbGetAll('chatMessages');var m=all.filter(function(x){return x.friendId==='cm_chat'&&x.role==='assistant'}).slice(-1)[0];
          var afterChat={run:window.__cmCalls.run,execute:window.__cmCalls.execute,reply:String(m&&m.content||'')};
          await dbPut('groups',{id:'cm_group',name:'Conv group',members:['cm_oai','cm_chat'],memoryEnabled:false});
          activeFriendId='cm_group';activeThreadId=null;openChatPanel();
          var gi=document.getElementById(currentPage==='chat'?'chat-full-input':'chat-input');gi.value='CONV_GROUP_MSG';await sendChatMessage();
          var afterGroup={run:window.__cmCalls.run,execute:window.__cmCalls.execute};
          activeFriendId='cm_chat';
          var vres=await sendChatMessage({voiceCall:true,transcript:'CONV_VOICE_MSG',roleId:'cm_chat',conversationId:'voice-1',turnId:'t1'});
          var afterVoice={run:window.__cmCalls.run,execute:window.__cmCalls.execute};
          var acc=await __acc();
          return{afterChat:afterChat,afterGroup:afterGroup,afterVoice:afterVoice,acc:acc,voiceOk:!!(vres&&vres.ok)};
        }finally{R.run=or;R.execute=oe;if(__tel&&__rec)__tel.record=__rec}
      })()`);
      assert.ok(out.afterChat.reply.length > 0, '对照组：Chat 本身可用');
      assert.equal(out.afterChat.run, 0, 'Chat 不得调用 runtime.run');
      assert.equal(out.afterGroup.run, 0, 'Group 不得调用 runtime.run');
      assert.equal(out.afterVoice.run, 0, 'Voice 不得调用 runtime.run');
      assert.deepEqual(out.acc.bad, [], 'runtime.execute 只能由白名单 consumer 归因：' + JSON.stringify(out.acc.bad));
      assert.equal(out.acc.unclaimed, 0,
        '存在已结束但无法归因的 runtime.execute 调用：' + out.acc.unclaimed + '（在途后台调用 ' + out.acc.inflight + '）');
      assert.equal(out.voiceOk, true, '对照组：Voice 入口可用');
    });

    /* ══ telemetry 复用与隐私 ══ */
    await check('telemetry 复用统一结构且不含敏感信息', async () => {
      const rec = await evaluate(cdp, `(function(){var all=IB.runtime.telemetry.recent(50);return all.filter(function(r){return r.consumer==='moments'})})()`);
      assert.ok(rec.length >= 5, '应有 moments 记录');
      const keys = await evaluate(cdp, `IB.runtime.telemetry.fields`);
      assert.ok(Array.isArray(keys) && keys.includes('jsonMode') && keys.includes('fallbackReason'), '统一字段表应含 jsonMode/fallbackReason');
      const joined = JSON.stringify(rec);
      for (const secret of ['k-anth', 'k-gem']) assert.ok(!joined.includes(secret), 'telemetry 不得包含 apiKey');
      assert.ok(!/CONV_SYS|CONV_USER|CONV_IDENTITY_/.test(joined), 'telemetry 不得包含 prompt 正文');
      assert.ok(!/CONV_MOMENT_TEXT|CONV_COMMENT_TEXT|CONV_REPLY_TEXT/.test(joined), 'telemetry 不得包含模型正文');
      assert.ok(pageLogs.some(l => l.includes('[Moments] model executor')), '必须输出 [Moments] model executor 诊断');
    });

    console.log('\nRuntime convergence (moments): ' + failures + ' failed');
    process.exitCode = failures ? 1 : 0;
  } finally {
    if (cdp) cdp.close();
    browser.kill();
    api.closeAllConnections(); web.closeAllConnections();
    await Promise.all([new Promise(r => api.close(r)), new Promise(r => web.close(r))]);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_) {}
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
