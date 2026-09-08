'use strict';

/* ====================================================================
   Runtime Convergence Phase 3 · Diary execute 迁移回归
   --------------------------------------------------------------------
   唯一被迁移的接缝：assets/js/active-diary/diary.js → _diaryModelCall
     generateDiaryEntry（触发/context/prompt/解析/去重/retry/落库/Memory 全部未改）
       → _diaryModelCall
            ├─ IB.runtime.instance.execute（默认）
            └─ callApiChat（回滚 / 接缝不可用）
   覆盖：三协议、请求契约逐字段对照（HTTP body + 执行器选项）、budget/identity/timeout/wantThinking、
        usage、gate/unavailable 回 direct、error 不双调用、abort 不 retry、invalid/empty 原 retry、
        落库与 Memory 只写一次、失败不写、visibility 不变、Phase1/2 consumer 仍在 Runtime、
        Chat/Group/Voice 计数 0。
   真实 localhost 页面 + 独立 profile + mock provider；不触达用户服务与真实 provider。
   运行：node test_runtime_convergence_diary.js
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

const captured = [];
const hits = {};
const DIARY_JSON = JSON.stringify({
  title: 'CONV_DIARY_TITLE', content: 'CONV_DIARY_CONTENT', mood: '平静', diaryType: 'daily', importance: 8,
  relatedMemoryIds: [], memoryCandidate: { content: 'CONV_DIARY_MEMORY', importance: 8, type: 'experience' }
});
const MOMENT_JSON = JSON.stringify({ publish: true, content: 'CONV_MOMENT_TEXT', visibility: 'all', motive: 'daily_life' });

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
          : url.startsWith('/oai-bad') ? 'bad'
            : url.startsWith('/oai-empty') ? 'empty' : 'oai';
  hits[key] = (hits[key] || 0) + 1;
  const entry = { url, body, headers: req.headers, key, n: hits[key] };
  captured.push(entry);

  if (key === 'fail') {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'convergence diary mock failure' } }));
    return;
  }
  if (key === 'slow') {
    await new Promise(r => setTimeout(r, 5000));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: DIARY_JSON }, finish_reason: 'stop' }] }));
    return;
  }
  /* 每个角色的 memoryCandidate 内容必须彼此差异足够大：_diaryWriteMemory 有跨记忆去重（相似度≥0.8 直接跳过），
     用同一句前缀会让第 2、3 个角色被去重掉。 */
  const MEM_TEXT = {
    cd_anth: '雨天的窗台上放着一只旧茶杯。',
    cd_gem: '昨晚梦见自己走在很长的走廊里。',
    cd_oai: '她说下次想一起去看海。',
    cd_gate: '楼下的桂花今年开得早。',
    cd_bad: '旧相机里还有一卷没洗的胶卷。',
    cd_empty: '厨房的灯坏了，一直没换。'
  };
  const diaryText = raw => {
    const m = String(raw).match(/CONV_IDENTITY_([A-Za-z0-9_]+)/);
    const who = m ? m[1] : 'x';
    return JSON.stringify({
      title: 'CONV_DIARY_TITLE', content: 'CONV_DIARY_CONTENT', mood: '平静', diaryType: 'daily', importance: 8,
      relatedMemoryIds: [], memoryCandidate: { content: MEM_TEXT[who] || ('日记里记下一件小事-' + who), importance: 8, type: 'experience' }
    });
  };
  let text;
  if (raw.includes('【本次主动消息目的】')) text = 'CONV_PROACTIVE_TEXT';
  else if (raw.includes('publishReply')) text = JSON.stringify({ publishReply: true, comment: 'CONV_REPLY_TEXT', replyTo: '' });
  else if (raw.includes('publishComment')) text = JSON.stringify({ publishComment: true, comment: 'CONV_COMMENT_TEXT' });
  else if (raw.includes('私人日记')) text = diaryText(raw);
  else text = MOMENT_JSON;
  if (key === 'bad') text = hits.bad === 1 ? '这不是 JSON' : diaryText(raw);
  if (key === 'empty') text = hits.empty === 1 ? '{}' : diaryText(raw);   /* 首次解析成功但无 title/content → 原校验失败 → 原 retry */
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
  const web = require('./internal-beyond-server.js').createWebServer({ root: __dirname, port: 0 });
  const webPort = await listen(web), webBase = 'http://127.0.0.1:' + webPort;
  const debugPort = await freePort();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-conv-diary-'));
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
  const telemetryOf = consumer => evaluate(cdp, `(function(){var all=IB.runtime.telemetry.recent(60);for(var i=all.length-1;i>=0;i--){if(all[i].consumer===${JSON.stringify(consumer)})return all[i]}return null})()`);

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
    assert.ok(await waitFor(cdp, "document.readyState==='complete' && typeof generateDiaryEntry==='function' && typeof _diaryModelCall==='function' && window.IB && IB.runtime && IB.runtime.instance && IB.runtime.telemetry && typeof loadApiConfigs==='function'", 20000), 'diary seam + runtime + telemetry mounted');

    const cfgs = [
      { id: 'cd_anth', provider: 'anthropic', endpoint: apiBase + '/anth/v1/messages', model: 'cd-anth-model', apiKey: 'k-anth', expectFormat: 'anthropic' },
      { id: 'cd_gem', provider: 'gemini', endpoint: apiBase + '/gem/{model}:generateContent', model: 'cd-gem-model', apiKey: 'k-gem', expectFormat: 'gemini' },
      { id: 'cd_oai', provider: 'custom', endpoint: apiBase + '/oai/v1/chat/completions', model: 'cd-oai-model', apiKey: '', expectFormat: 'openai' },
      { id: 'cd_fail', provider: 'custom', endpoint: apiBase + '/oai-fail/v1/chat/completions', model: 'cd-fail-model', apiKey: '', expectFormat: 'openai' },
      { id: 'cd_slow', provider: 'custom', endpoint: apiBase + '/oai-slow/v1/chat/completions', model: 'cd-slow-model', apiKey: '', expectFormat: 'openai' },
      { id: 'cd_bad', provider: 'custom', endpoint: apiBase + '/oai-bad/v1/chat/completions', model: 'cd-bad-model', apiKey: '', expectFormat: 'openai' },
      { id: 'cd_empty', provider: 'custom', endpoint: apiBase + '/oai-empty/v1/chat/completions', model: 'cd-empty-model', apiKey: '', expectFormat: 'openai' },
      { id: 'cd_gate', provider: 'custom', endpoint: apiBase + '/oai/v1/chat/completions', model: 'cd-gate-model', apiKey: '', expectFormat: 'openai' },
      { id: 'cd_unavail', provider: 'custom', endpoint: apiBase + '/oai/v1/chat/completions', model: 'cd-unavail-model', apiKey: '', expectFormat: 'openai' },
      { id: 'cd_chat', provider: 'custom', endpoint: apiBase + '/oai/v1/chat/completions', model: 'cd-chat-model', apiKey: '', expectFormat: 'openai' }
    ].map(c => ({ ...c, nickname: c.id, streaming: false, promptCache: false, systemPrompt: 'CONV_IDENTITY_' + c.id, relationship: '伙伴' }));
    await evaluate(cdp, `(async()=>{for(const c of ${JSON.stringify(cfgs)})await dbPut('apiConfigs',c);await loadApiConfigs();`
      + `try{_diaryPrefsSave({enabled:true,weeklyEnabled:false,dailyPlannerEnabled:false,eventEnabled:false})}catch(e){}`
      + `try{_momentsPrefsSave({enabled:true,autoPublish:true,frequency:'medium',aiComment:true,aiLike:false})}catch(e){}`
      + `try{if(window._activeTimer){clearInterval(window._activeTimer);window._activeTimer=null}}catch(e){}`
      + `window.runtimeDiaryExecuteEnabled=undefined;window.runtimeExecuteEnabled=true;return true})()`);

    /* ══ 4/5/6/7：请求契约逐字段对照（HTTP body + 执行器选项） ══ */
    for (const cfg of cfgs.slice(0, 3)) {
      await check('contract.' + cfg.expectFormat + '：runtime ↔ direct 请求体与执行器选项一致', async () => {
        const from = captured.length;
        const probe = await evaluate(cdp, `(async function(){
          var cfg=apiConfigs.find(function(a){return a.id===${JSON.stringify(cfg.id)}});
          var msgs=[{role:'system',content:'CONV_SYS'},{role:'user',content:'CONV_USER'}];
          var opts={maxTokens:2000,timeoutMs:120000,wantMeta:false,jsonMode:true,_noWebSearch:true,disableTools:true};
          var orig=window.callApiChat,seen=[];
          window.callApiChat=function(c,m,o){o=o||{};seen.push({maxTokens:o.maxTokens,timeoutMs:o.timeoutMs,wantThinking:!!o.wantThinking,disableTools:o.disableTools,jsonMode:o.jsonMode,noWebSearch:o._noWebSearch});return orig.apply(null,arguments)};
          try{
            window.runtimeDiaryExecuteEnabled=true;var a=await _diaryModelCall(cfg,msgs,opts);
            window.runtimeDiaryExecuteEnabled=false;var b=await _diaryModelCall(cfg,msgs,opts);
          }finally{window.callApiChat=orig;window.runtimeDiaryExecuteEnabled=undefined}
          return{runtime:a,direct:b,same:a===b,opts:seen};
        })()`);
        assert.equal(probe.same, true, '两条路径返回的原始文本必须一致');
        assert.equal(probe.opts.length, 2, '应各捕获一次执行器调用');
        assert.deepEqual(probe.opts[0], probe.opts[1], '执行器选项（budget/timeout/wantThinking/disableTools/jsonMode/_noWebSearch）必须一致');
        assert.deepEqual(probe.opts[0], { maxTokens: 2000, timeoutMs: 120000, wantThinking: false, disableTools: true, jsonMode: true, noWebSearch: true });
        const reqs = reqsFor(from, cfg.id === 'cd_anth' ? 'anth' : cfg.id === 'cd_gem' ? 'gem' : 'oai', 'CONV_SYS');
        assert.equal(reqs.length, 2, '应各捕获一次请求');
        assert.deepEqual(reqs[0].body, reqs[1].body, 'runtime 与 direct 的 HTTP 请求体必须逐字段一致');
        const body = reqs[0].body;
        if (cfg.expectFormat === 'openai') {
          assert.equal(body.response_format && body.response_format.type, 'json_object');
          assert.equal(body.max_tokens, 2000);
          assert.equal(body.messages[0].role, 'system');
          assert.equal(body.messages[0].content, 'CONV_SYS');
          assert.equal(body.messages[1].content, 'CONV_USER');
          assert.equal(body.model, cfg.model);
        } else if (cfg.expectFormat === 'gemini') {
          assert.equal(body.generationConfig.responseMimeType, 'application/json');
          assert.equal(body.generationConfig.maxOutputTokens, 2000);
          assert.equal(body.system_instruction.parts[0].text, 'CONV_SYS');
          assert.equal(body.contents[0].parts[0].text, 'CONV_USER');
          assert.ok(reqs[0].url.includes(cfg.model), 'gemini model 在 URL');
        } else {
          assert.equal(body.system, 'CONV_SYS');
          assert.ok(body.messages.every(m => m.role !== 'system'));
          assert.equal(body.messages[0].content, 'CONV_USER');
          assert.equal(body.max_tokens, 2000);
          assert.equal(body.model, cfg.model);
          assert.ok(!('response_format' in body), 'anthropic 无 response_format（与 direct 一致）');
        }
        assert.ok(!('tools' in body), 'disableTools → 不得出现 tools');
      });
    }

    /* ══ 1-3 / 8：三协议经 runtime 生成 + usage 回传 ══ */
    for (const cfg of cfgs.slice(0, 3)) {
      await check('diary.' + cfg.expectFormat + ' → runtime 生成成功且 usage 存在', async () => {
        const from = captured.length;
        const out = await evaluate(cdp, `(async function(){
          var puts=[],orig=window.dbPut;
          window.dbPut=function(s,d){puts.push({store:s,id:d&&d.id,source:d&&d.source});return orig.apply(null,arguments)};
          try{
            var r=await generateDiaryEntry(${JSON.stringify(cfg.id)},{trigger:'manual'});
            var all=IB.runtime.telemetry.recent(20);var tel=null;
            for(var i=all.length-1;i>=0;i--){if(all[i].consumer==='diary'){tel=all[i];break}}
            return{ok:r.ok,title:r.entry&&r.entry.title,mem:!!r.memory,tel:tel,puts:puts};
          }finally{window.dbPut=orig}
        })()`);
        assert.equal(out.ok, true, '日记生成失败');
        assert.equal(out.title, 'CONV_DIARY_TITLE');
        assert.equal(out.mem, true, 'memoryCandidate 应被写入');
        assert.equal(out.tel.executor, 'runtime');
        assert.equal(out.tel.format, cfg.expectFormat);
        assert.equal(out.tel.consumer, 'diary');
        assert.equal(out.tel.kind, 'generate');
        assert.equal(out.tel.usage, 'present', 'runtime 路径必须报告 usage 存在');
        assert.equal(out.tel.jsonMode, true);
        assert.ok(reqsFor(from, cfg.expectFormat === 'anthropic' ? 'anth' : cfg.expectFormat === 'gemini' ? 'gem' : 'oai').length >= 1);
      });
    }

    /* ══ 14/15/18：成功后只写一次 Diary / 一次 Memory；visibility 语义不变 ══ */
    await check('落库：Diary 一条、Memory 一条、visibility 不变', async () => {
      const out = await evaluate(cdp, `(async function(){
        var puts=[],orig=window.dbPut;
        window.dbPut=function(s,d){puts.push({store:s,id:d&&d.id,source:d&&d.source});return orig.apply(null,arguments)};
        var r;
        try{r=await generateDiaryEntry('cd_gate',{trigger:'manual'})}finally{window.dbPut=orig}
        var rows=await dbGetAll('diary_entries');var mine=rows.filter(function(x){return x.characterId==='cd_gate'});
        var mems=(await dbGetAll('memories')).filter(function(m){return m.source==='diary'&&m.characterId==='cd_gate'});
        var mem=mems[0];
        return{ok:r.ok,id:r.entry&&r.entry.id,diaryPuts:puts.filter(function(p){return p.store==='diary_entries'}).map(function(p){return p.id}),
          memPuts:puts.filter(function(p){return p.store==='memories'&&p.source==='diary'}).length,
          rows:mine.length,mems:mems.length,
          vis:mem&&mem.visibility,to:mem&&mem.visibleTo,
          visibleOwn:mem?isMemoryVisibleTo(mem,'cd_gate',false,false):null,
          visibleOther:mem?isMemoryVisibleTo(mem,'cd_anth',false,false):null};
      })()`);
      assert.equal(out.ok, true);
      assert.equal(out.rows, 1, '同一角色只应有一条日记');
      assert.equal(new Set(out.diaryPuts).size, 1, 'Diary 写入必须只针对同一个 id：' + JSON.stringify(out.diaryPuts));
      assert.ok(out.diaryPuts.every(id => id === out.id), '所有 Diary 写入都是本条日记（追加 memory id 的既有行为）');
      assert.equal(out.memPuts, 1, '_diaryWriteMemory 只写一次');
      assert.equal(out.mems, 1);
      assert.equal(out.vis, 'only');
      assert.deepEqual(out.to, ['cd_gate']);
      assert.equal(out.visibleOwn, true, '所属角色必须能召回');
      assert.equal(out.visibleOther, false, '不得对其他角色可见');
    });

    /* ══ 11：executor error → 不回落 direct、不双调用、不写 Diary/Memory ══ */
    await check('执行失败：1 次调用、不写 Diary/Memory、不回落 direct', async () => {
      const from = captured.length;
      const out = await evaluate(cdp, `(async function(){
        var t0=Date.now(),puts=[],orig=window.dbPut;
        window.dbPut=function(s,d){puts.push({store:s,id:d&&d.id,source:d&&d.source});return orig.apply(null,arguments)};
        var r;
        try{r=await generateDiaryEntry('cd_fail',{trigger:'manual'})}finally{window.dbPut=orig}
        var rows=(await dbGetAll('diary_entries')).filter(function(x){return x.characterId==='cd_fail'});
        var mems=(await dbGetAll('memories')).filter(function(m){return m.characterId==='cd_fail'});
        var recs=IB.runtime.telemetry.recent(60).filter(function(x){return x.at>=t0&&x.consumer==='diary'});
        return{ok:r.ok,err:r.error,rows:rows.length,mems:mems.length,puts:puts.length,
          recs:recs.map(function(x){return{executor:x.executor,ok:x.ok,fallbackReason:x.fallbackReason}})};
      })()`);
      assert.equal(out.ok, false, 'provider 500 → 生成失败');
      assert.ok(/convergence diary mock failure|500/.test(String(out.err || '')), '应保留 provider 错误：' + out.err);
      assert.equal(reqsFor(from, 'fail').length, 1, '同一 attempt 只能一次 provider 调用');
      assert.equal(out.rows, 0, '失败不得写 Diary');
      assert.equal(out.mems, 0, '失败不得写 Memory');
      assert.equal(out.puts, 0, '失败不得有任何 dbPut');
      assert.equal(out.recs.length, 1, '本次只应有一条 telemetry：' + JSON.stringify(out.recs));
      assert.equal(out.recs[0].executor, 'runtime');
      assert.equal(out.recs[0].fallbackReason, '', '不得回落 direct');
    });

    /* ══ 12：abort → 不 retry、不双调用 ══ */
    await check('abort 不 retry', async () => {
      const from = captured.length;
      const out = await evaluate(cdp, `(async function(){
        var ac=new AbortController();
        var p=generateDiaryEntry('cd_slow',{trigger:'manual',signal:ac.signal});
        setTimeout(function(){ac.abort()},250);
        var r=await p;
        var seam='';
        try{var ac2=new AbortController();ac2.abort();await _diaryModelCall(apiConfigs.find(function(a){return a.id==='cd_oai'}),[{role:'user',content:'X'}],{maxTokens:10,jsonMode:true,disableTools:true,signal:ac2.signal})}catch(e){seam=String(e&&e.name||'')}
        return{ok:r.ok,err:r.error,seam:seam};
      })()`);
      assert.equal(out.ok, false, '中止必须失败返回');
      assert.equal(out.seam, 'AbortError', '接缝在已中止 signal 上必须抛 AbortError');
      assert.equal(reqsFor(from, 'slow').length, 1, '中止后不得重试');
      await new Promise(r => setTimeout(r, 800));
      assert.equal(reqsFor(from, 'slow').length, 1, '等待期间也不得出现第二次请求');
      const tel = await telemetryOf('diary');
      assert.equal(tel.abortReason, 'abort');
      assert.equal(tel.executor, 'runtime');
    });

    /* ══ 13：invalid / empty 输出 → 原 retry 行为（提示词重写 + 第 2 次成功） ══ */
    for (const [role, key, label] of [['cd_bad', 'bad', 'invalid JSON'], ['cd_empty', 'empty', '空 JSON']]) {
      await check(label + ' → 原 retry 链（2 次请求 + 原提示词）', async () => {
        const from = captured.length;
        const out = await evaluate(cdp, `(async function(){var r=await generateDiaryEntry(${JSON.stringify(role)},{trigger:'manual'});`
          + `return{ok:r.ok,title:r.entry&&r.entry.title,err:r.error}})()`);
        assert.equal(out.ok, true, '第二次应成功：' + out.err);
        assert.equal(out.title, 'CONV_DIARY_TITLE');
        const reqs = reqsFor(from, key);
        assert.equal(reqs.length, 2, '原 retry 恰好 2 次请求');
        assert.ok(JSON.stringify(reqs[1].body).includes('【注意】上次输出不符合要求'), '第二次必须带原 retry 提示（prompt 构建未变）');
      });
    }

    /* ══ 9/10：gate=false / runtime 不可用 → direct ══ */
    await check('gate=false 回 direct（记录 fallbackReason）', async () => {
      const out = await evaluate(cdp, `(async function(){
        window.runtimeDiaryExecuteEnabled=false;
        try{var r=await generateDiaryEntry('cd_gate',{trigger:'manual'});return{ok:r.ok,tel:IB.runtime.telemetry.recent(1)[0]}}
        finally{window.runtimeDiaryExecuteEnabled=undefined}
      })()`);
      assert.equal(out.ok, true);
      assert.equal(out.tel.executor, 'direct');
      assert.equal(out.tel.fallbackReason, 'gate_disabled');
      assert.equal(out.tel.consumer, 'diary');
    });

    await check('runtime 不可用回 direct（runtime_unavailable）', async () => {
      const out = await evaluate(cdp, `(async function(){
        var R=IB.runtime.instance,orig=R.execute;R.execute=null;
        try{var r=await generateDiaryEntry('cd_unavail',{trigger:'manual'});return{ok:r.ok,tel:IB.runtime.telemetry.recent(1)[0]}}
        finally{R.execute=orig}
      })()`);
      assert.equal(out.ok, true);
      assert.equal(out.tel.executor, 'direct');
      assert.equal(out.tel.fallbackReason, 'runtime_unavailable');
    });

    /* ══ 19/20：Phase 1 / Phase 2 consumer 仍在 Runtime ══ */
    await check('proactive 与 Moments consumer 仍走 Runtime', async () => {
      const out = await evaluate(cdp, `(async function(){
        var cfg=apiConfigs.find(function(a){return a.id==='cd_oai'});
        var p=await generateProactiveMessage({character:cfg,user:{name:'用户'},recentMessages:[],memories:[],recentProactiveMessages:[],currentTime:new Date(),messageMode:'greeting',taskId:'conv_p3'});
        var m=await generateRoleMoment('cd_gem',{trigger:'manual'});
        var all=IB.runtime.telemetry.recent(40);var act=null,mom=null;
        for(var i=all.length-1;i>=0;i--){if(!act&&all[i].consumer==='active.proactive')act=all[i];if(!mom&&all[i].consumer==='moments')mom=all[i]}
        return{p:p.content,m:!!(m&&m.published),act:act,mom:mom};
      })()`);
      assert.equal(out.p, 'CONV_PROACTIVE_TEXT');
      assert.equal(out.m, true);
      assert.equal(out.act.executor, 'runtime');
      assert.equal(out.act.consumer, 'active.proactive');
      assert.equal(out.mom.executor, 'runtime');
      assert.equal(out.mom.consumer, 'moments');
    });

    /* ══ 21-23：Chat / Group / Voice 仍不经过 Runtime ══ */
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
        var R=IB.runtime.instance,or=R.run.bind(R),oe=R.execute.bind(R);window.__cdCalls={run:0,execute:0};
        R.run=function(){window.__cdCalls.run++;return or.apply(null,arguments)};
        R.execute=function(){
          window.__cdCalls.execute++;
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
          return{run:window.__cdCalls.run,execute:__calls.length,unclaimed:unclaimed,inflight:inflight,bad:bad};
        };
        try{
          activeFriendId='cd_chat';activeThreadId=null;openChatPanel();
          var i=document.getElementById(currentPage==='chat'?'chat-full-input':'chat-input');i.value='CONV_CHAT_MSG';await sendChatMessage();
          var all=await dbGetAll('chatMessages');var m=all.filter(function(x){return x.friendId==='cd_chat'&&x.role==='assistant'}).slice(-1)[0];
          var afterChat={run:window.__cdCalls.run,execute:window.__cdCalls.execute,reply:String(m&&m.content||'')};
          await dbPut('groups',{id:'cd_group',name:'Conv group',members:['cd_oai','cd_chat'],memoryEnabled:false});
          activeFriendId='cd_group';activeThreadId=null;openChatPanel();
          var gi=document.getElementById(currentPage==='chat'?'chat-full-input':'chat-input');gi.value='CONV_GROUP_MSG';await sendChatMessage();
          var afterGroup={run:window.__cdCalls.run,execute:window.__cdCalls.execute};
          activeFriendId='cd_chat';
          var vres=await sendChatMessage({voiceCall:true,transcript:'CONV_VOICE_MSG',roleId:'cd_chat',conversationId:'voice-1',turnId:'t1'});
          var afterVoice={run:window.__cdCalls.run,execute:window.__cdCalls.execute};
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
    await check('telemetry 复用统一结构且不含日记正文/prompt/apiKey', async () => {
      const rec = await evaluate(cdp, `(function(){var all=IB.runtime.telemetry.recent(80);return all.filter(function(r){return r.consumer==='diary'})})()`);
      assert.ok(rec.length >= 5, '应有 diary 记录：' + rec.length);
      const joined = JSON.stringify(rec);
      for (const secret of ['k-anth', 'k-gem']) assert.ok(!joined.includes(secret), 'telemetry 不得包含 apiKey');
      assert.ok(!/CONV_SYS|CONV_USER|CONV_IDENTITY_/.test(joined), 'telemetry 不得包含 prompt 正文');
      assert.ok(!/CONV_DIARY_TITLE|CONV_DIARY_CONTENT/.test(joined), 'telemetry 不得包含日记正文');
      assert.ok(!/窗台|走廊|看海|桂花|胶卷|厨房/.test(joined), 'telemetry 不得包含 Memory 正文');
      assert.ok(pageLogs.some(l => l.includes('[Diary] model executor')), '必须输出 [Diary] model executor 诊断');
    });

    console.log('\nRuntime convergence (diary): ' + failures + ' failed');
    process.exitCode = failures ? 1 : 0;
  } finally {
    if (cdp) cdp.close();
    browser.kill();
    api.closeAllConnections(); web.closeAllConnections();
    await Promise.all([new Promise(r => api.close(r)), new Promise(r => web.close(r))]);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_) {}
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
