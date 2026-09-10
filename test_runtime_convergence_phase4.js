'use strict';

/* ====================================================================
   Runtime Convergence Phase 4 · Diary 域收敛 + Memory Consolidation 迁移回归
   --------------------------------------------------------------------
   A. Diary domain closure：_diaryDailyPlanner 改走 Phase 3 的 _diaryModelCall（kind='planner'），
      域内不再有生产 direct model call。
   B. consolidateCharacterMemory：模型执行接缝 → _activeConsolidationModelCall
      → IB.runtime.instance.execute（consumer='memory_consolidation'，kind='consolidate'）。
   覆盖：三协议、contract 逐字段对照（HTTP body + 执行器选项）、usage、gate/unavailable、
        error 不双调用、abort 不 retry / 不进入 generation、失败零副作用、成功只写一次、
        visibility/provenance/historical-repair 不变、Phase1-3 consumer 仍在 Runtime、
        Chat/Group/Voice 计数 0、telemetry 隐私。
   运行：node test_runtime_convergence_phase4.js
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
let diarySeq = 0;   /* 每次日记生成内容都不同，避免被既有去重逻辑（属预期行为）拒绝 */

const PLANNER_JSON = JSON.stringify({ shouldWrite: true, reason: 'CONV_PLAN_REASON', diaryType: 'daily', importance: 8 });
const SEMANTIC_JSON = JSON.stringify({
  shouldConsolidate: true, title: 'CONV_SEM_TITLE', summary: '',
  content: '用户偏好安静的沟通方式，这是长期习惯。', importance: 8,
  consolidatedFrom: ['ghost_source_id']   /* 伪造 id：业务链必须回退到真实来源 */
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
        : url.startsWith('/oai-slow') ? 'slow' : 'oai';
  hits[key] = (hits[key] || 0) + 1;
  const entry = { url, body, headers: req.headers, key, n: hits[key] };
  captured.push(entry);

  if (key === 'fail') {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'convergence phase4 mock failure' } }));
    return;
  }
  if (key === 'slow') {
    await new Promise(r => setTimeout(r, 5000));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: SEMANTIC_JSON }, finish_reason: 'stop' }] }));
    return;
  }
  const role = (String(raw).match(/CONV_IDENTITY_([A-Za-z0-9_]+)/) || [])[1] || 'x';
  let text;
  if (raw.includes('shouldConsolidate')) text = SEMANTIC_JSON;
  else if (raw.includes('判断今天是否值得写一篇私人日记')) text = PLANNER_JSON;
  else if (raw.includes('私人日记')) {
    diarySeq++;   /* 每次内容都不同：否则同一角色的第二次生成会被既有去重逻辑拒绝（属预期行为） */
    text = JSON.stringify({
      title: 'CONV_DIARY_TITLE_' + diarySeq, content: 'CONV_DIARY_CONTENT_' + diarySeq, mood: '平静', diaryType: 'daily', importance: 8,
      relatedMemoryIds: [], memoryCandidate: { content: '日记小事-' + role + '-' + diarySeq, importance: 8, type: 'experience' }
    });
  } else if (raw.includes('【本次主动消息目的】')) text = 'CONV_PROACTIVE_TEXT';
  else if (raw.includes('publishReply')) text = JSON.stringify({ publishReply: true, comment: 'CONV_REPLY_TEXT', replyTo: '' });
  else if (raw.includes('publishComment')) text = JSON.stringify({ publishComment: true, comment: 'CONV_COMMENT_TEXT' });
  else text = MOMENT_JSON;
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
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-conv-p4-'));
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
  const telemetryKind = kind => evaluate(cdp, `(function(){var all=IB.runtime.telemetry.recent(80);for(var i=all.length-1;i>=0;i--){if(all[i].kind===${JSON.stringify(kind)}&&all[i].consumer==='diary')return all[i]}return null})()`);
  const telemetryConsumer = consumer => evaluate(cdp, `(function(){var all=IB.runtime.telemetry.recent(80);for(var i=all.length-1;i>=0;i--){if(all[i].consumer===${JSON.stringify(consumer)})return all[i]}return null})()`);
  const mkCfg = (id, provider, endpoint, model) => ({
    id, provider, endpoint, model, nickname: id, apiKey: provider === 'anthropic' ? 'k-anth' : (provider === 'gemini' ? 'k-gem' : ''),
    streaming: false, promptCache: false, systemPrompt: 'CONV_IDENTITY_' + id, relationship: '伙伴'
  });

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
    assert.ok(await waitFor(cdp, "document.readyState==='complete' && typeof _diaryTick==='function' && typeof _diaryModelCall==='function' && typeof _activeConsolidationModelCall==='function' && window.IB && IB.runtime && IB.runtime.instance && IB.runtime.telemetry", 20000), 'phase4 seams + runtime mounted');

    /* ══════════ A. Diary domain closure ══════════ */
    const diaryCfgs = [
      mkCfg('cd_anth', 'anthropic', apiBase + '/anth/v1/messages', 'cd-anth-model'),
      mkCfg('cd_gem', 'gemini', apiBase + '/gem/{model}:generateContent', 'cd-gem-model'),
      mkCfg('cd_oai', 'custom', apiBase + '/oai/v1/chat/completions', 'cd-oai-model')
    ];
    await evaluate(cdp, `(async()=>{for(const c of ${JSON.stringify(diaryCfgs)})await dbPut('apiConfigs',c);await loadApiConfigs();`
      + `_diaryPrefsSave({enabled:true,weeklyEnabled:false,dailyPlannerEnabled:true,eventEnabled:false});`
      + `try{localStorage.removeItem('ib_diary_watermarks_v1')}catch(e){}`
      + `try{if(window._activeTimer){clearInterval(window._activeTimer);window._activeTimer=null}}catch(e){}`
      + `window.runtimeDiaryExecuteEnabled=undefined;window.runtimeExecuteEnabled=true;return true})()`);

    const fmtOf = { cd_anth: 'anthropic', cd_gem: 'gemini', cd_oai: 'openai' };
    for (const cfg of diaryCfgs) {
      await check('planner.' + fmtOf[cfg.id] + ' → runtime（tick 全链路）', async () => {
        const from = captured.length;
        const out = await evaluate(cdp, `(async function(){
          var mine=async function(){return (await dbGetAll('diary_entries')).filter(function(x){return x.characterId===${JSON.stringify(cfg.id)}}).length};
          var before=await mine();
          try{localStorage.removeItem('ib_diary_watermarks_v1')}catch(e){}
          await _diaryTick();
          /* _diaryTick 里的 generateDiaryEntry 是 fire-and-forget（既有行为）：轮询等待其落库 */
          var rows=before;
          for(var w=0;w<40&&rows===before;w++){await new Promise(function(r){setTimeout(r,100)});rows=await mine()}
          var all=IB.runtime.telemetry.recent(80);
          var plan=null,gen=null;
          for(var i=all.length-1;i>=0;i--){if(all[i].characterId===${JSON.stringify(cfg.id)}){if(!gen&&all[i].kind==='generate')gen=all[i];if(!plan&&all[i].kind==='planner')plan=all[i]}}
          return{added:rows-before,plan:plan,gen:gen};
        })()`);
        assert.equal(out.added, 1, 'planner 判定应写 → 恰好新增 1 条日记；plan=' + JSON.stringify(out.plan)
          + ' gen=' + JSON.stringify(out.gen)
          + ' reqs=' + JSON.stringify(reqsFor(from, cfg.id === 'cd_anth' ? 'anth' : cfg.id === 'cd_gem' ? 'gem' : 'oai').map(r => r.n + ':' + String(r.text || '').slice(0, 30))));
        assert.ok(out.plan, 'planner 必须写入 diary telemetry');
        assert.equal(out.plan.executor, 'runtime', 'planner 必须走 runtime');
        assert.equal(out.plan.kind, 'planner');
        assert.equal(out.plan.format, fmtOf[cfg.id]);
        assert.equal(out.plan.jsonMode, true);
        assert.equal(out.plan.usage, 'present');
        assert.ok(out.gen && out.gen.executor === 'runtime' && out.gen.kind === 'generate', 'generation 也必须走同一接缝');
        assert.ok(reqsFor(from, cfg.id === 'cd_anth' ? 'anth' : cfg.id === 'cd_gem' ? 'gem' : 'oai', 'CONV_IDENTITY_' + cfg.id).length >= 2, 'planner + generation 各一次请求');
      });
    }

    await check('planner/generation 共用 _diaryModelCall（kind 区分）', async () => {
      const recs = await evaluate(cdp, `(function(){var all=IB.runtime.telemetry.recent(80);return all.filter(function(r){return r.consumer==='diary'}).map(function(r){return r.kind})})()`);
      const uniq = [...new Set(recs)];
      assert.deepEqual(uniq.sort(), ['generate', 'planner'], '同一接缝承载两种 kind：' + JSON.stringify(uniq));
      assert.equal(await evaluate(cdp, `typeof window._diaryModelCall==='function' && IB.active.diary._diaryModelCall===window._diaryModelCall`), true, '接缝必须唯一（双挂载同一函数）');
    });

    await check('planner contract 与 direct 等价（body + 执行器选项）', async () => {
      const from = captured.length;
      const probe = await evaluate(cdp, `(async function(){
        var cfg=apiConfigs.find(function(a){return a.id==='cd_oai'});
        var msgs=[{role:'system',content:'CONV_SYS'},{role:'user',content:'CONV_PLAN_PROBE'}];
        var opts={maxTokens:300,timeoutMs:60000,wantMeta:false,jsonMode:true,_noWebSearch:true,disableTools:true};
        var orig=window.callApiChat,seen=[];
        window.callApiChat=function(c,m,o){o=o||{};seen.push({maxTokens:o.maxTokens,timeoutMs:o.timeoutMs,wantThinking:!!o.wantThinking,disableTools:o.disableTools,jsonMode:o.jsonMode,noWebSearch:o._noWebSearch});return orig.apply(null,arguments)};
        try{
          window.runtimeDiaryExecuteEnabled=true;var a=await _diaryModelCall(cfg,msgs,opts,{kind:'planner'});
          window.runtimeDiaryExecuteEnabled=false;var b=await _diaryModelCall(cfg,msgs,opts,{kind:'planner'});
        }finally{window.callApiChat=orig;window.runtimeDiaryExecuteEnabled=undefined}
        return{same:a===b,opts:seen};
      })()`);
      assert.equal(probe.same, true);
      assert.deepEqual(probe.opts[0], probe.opts[1], 'planner 执行器选项必须一致');
      assert.deepEqual(probe.opts[0], { maxTokens: 300, timeoutMs: 60000, wantThinking: false, disableTools: true, jsonMode: true, noWebSearch: true });
      const reqs = reqsFor(from, 'oai', 'CONV_PLAN_PROBE');
      assert.equal(reqs.length, 2);
      assert.deepEqual(reqs[0].body, reqs[1].body, 'planner 请求体必须逐字段一致');
      assert.equal(reqs[0].body.max_tokens, 300);
      assert.equal(reqs[0].body.response_format.type, 'json_object');
      assert.ok(!('tools' in reqs[0].body));
      assert.equal(reqs[0].body.messages[0].role, 'system');
      assert.equal(reqs[0].body.messages[0].content, 'CONV_SYS');
    });

    await check('abort 不进入 generation', async () => {
      const out = await evaluate(cdp, `(async function(){
        var before=(await dbGetAll('diary_entries')).length;
        var beforeTel=IB.runtime.telemetry.recent(80).filter(function(r){return r.consumer==='diary'&&r.kind==='planner'}).length;
        try{localStorage.removeItem('ib_diary_watermarks_v1')}catch(e){}
        var ac=new AbortController();ac.abort();
        await _diaryTick({signal:ac.signal});
        var rows=(await dbGetAll('diary_entries')).length;
        var afterTel=IB.runtime.telemetry.recent(80).filter(function(r){return r.consumer==='diary'&&r.kind==='planner'}).length;
        return{added:rows-before,newPlanner:afterTel-beforeTel};
      })()`);
      assert.equal(out.added, 0, '中止后不得产生新日记（不得进入 generation）');
      assert.equal(out.newPlanner, 0, '预中止的 signal 不得发起任何模型调用（因此没有 planner 记录）');
    });

    await check('Diary 域无剩余生产 direct model call', async () => {
      const src = fs.readFileSync(path.join(__dirname, 'assets/js/active-diary/diary.js'), 'utf8');
      const all = src.match(/callApiChat\s*\(/g) || [];
      assert.equal(all.length, 1, 'diary.js 只应保留 _diaryModelCall 内的 direct 回退，实际 ' + all.length);
      const seam = src.slice(src.indexOf('async function _diaryModelCall('), src.indexOf('/* 主生成管线'));
      /* P11-FIX：接缝内的 direct 回退在 opts 前追加诊断用 _ibConsumer（不进请求体），
         仍是唯一 direct 调用；此处锁死"只有这一处、且在接缝内"。 */
      assert.ok(seam.includes("callApiChat(cfg,messages,Object.assign({_ibConsumer:'diary'},opts))"), '唯一 direct 调用必须在接缝内');
      assert.ok(!/await callApiChat\(/.test(src.replace(seam, '')), '接缝之外不得再有 await callApiChat');
    });

    /* ══════════ B. Memory Consolidation ══════════ */
    const consCfgs = [
      mkCfg('cc_anth', 'anthropic', apiBase + '/anth/v1/messages', 'cc-anth-model'),
      mkCfg('cc_gem', 'gemini', apiBase + '/gem/{model}:generateContent', 'cc-gem-model'),
      mkCfg('cc_oai', 'custom', apiBase + '/oai/v1/chat/completions', 'cc-oai-model'),
      mkCfg('cc_only', 'custom', apiBase + '/oai/v1/chat/completions', 'cc-only-model'),
      mkCfg('cc_fail', 'custom', apiBase + '/oai-fail/v1/chat/completions', 'cc-fail-model'),
      mkCfg('cc_slow', 'custom', apiBase + '/oai-slow/v1/chat/completions', 'cc-slow-model'),
      mkCfg('cc_gate', 'custom', apiBase + '/oai/v1/chat/completions', 'cc-gate-model'),
      mkCfg('cc_unavail', 'custom', apiBase + '/oai/v1/chat/completions', 'cc-unavail-model'),
      mkCfg('cc_chat', 'custom', apiBase + '/oai/v1/chat/completions', 'cc-chat-model')
    ];
    await evaluate(cdp, `(async()=>{for(const c of ${JSON.stringify(consCfgs)})await dbPut('apiConfigs',c);await loadApiConfigs();return true})()`);
    const seedEpi = (role, visibility, idSuffix) => evaluate(cdp, `(async function(){`
      + `await dbPut('memories',{id:'epi_${idSuffix || role}',kind:'episodic',createdBy:'${role}',visibility:${JSON.stringify(visibility)},visibleTo:${visibility === 'only' ? `['${role}']` : '[]'},excludeFrom:[],`
      + `title:'片段',content:'CONV_EPI_${idSuffix || role}',domain:'日常',tags:[],valence:0.5,arousal:0.4,importance:5,resolved:false,activationCount:1,created:Date.now(),lastActivated:Date.now(),consolidatedFrom:[],lastConsolidatedAt:null});return true})()`);

    for (const cfg of consCfgs.slice(0, 3)) {
      await check('consolidate.' + fmtOf[cfg.id.replace('cc', 'cd')] + ' → runtime 生成 semantic', async () => {
        await seedEpi(cfg.id, 'public');
        const from = captured.length;
        const out = await evaluate(cdp, `(async function(){
          var cfg=apiConfigs.find(function(a){return a.id===${JSON.stringify(cfg.id)}});
          var r=await consolidateCharacterMemory(cfg);
          var mems=(await dbGetAll('memories')).filter(function(m){return m.kind==='semantic'&&m.createdBy===${JSON.stringify(cfg.id)}});
          var src=await dbGet('memories','epi_${cfg.id}');
          var all=IB.runtime.telemetry.recent(40);var tel=null;
          for(var i=all.length-1;i>=0;i--){if(all[i].consumer==='memory_consolidation'){tel=all[i];break}}
          return{ok:!!r,mems:mems.length,mem:mems[0],watermark:src&&src.lastConsolidatedAt,tel:tel};
        })()`);
        assert.equal(out.ok, true, 'consolidation 应成功');
        assert.equal(out.mems, 1, 'semantic 必须恰好一条');
        assert.ok(out.tel, '必须写入 memory_consolidation telemetry');
        assert.equal(out.tel.executor, 'runtime');
        assert.equal(out.tel.kind, 'consolidate');
        assert.equal(out.tel.format, fmtOf[cfg.id.replace('cc', 'cd')]);
        assert.equal(out.tel.jsonMode, true);
        assert.equal(out.tel.usage, 'present');
        assert.ok(out.watermark > 0, '成功后必须推进 watermark');
        assert.ok(reqsFor(from, cfg.id === 'cc_anth' ? 'anth' : cfg.id === 'cc_gem' ? 'gem' : 'oai', 'shouldConsolidate').length >= 1, '必须发出模型请求');
      });
    }

    await check('consolidate contract 与 direct 等价（body + 执行器选项）', async () => {
      const from = captured.length;
      const probe = await evaluate(cdp, `(async function(){
        var cfg=apiConfigs.find(function(a){return a.id==='cc_oai'});
        var msgs=[{role:'system',content:'CONV_SYS'},{role:'user',content:'CONV_CONS_PROBE'}];
        var opts={maxTokens:800,timeoutMs:120000,wantMeta:false,jsonMode:true,_noWebSearch:true,disableTools:true};
        var orig=window.callApiChat,seen=[];
        window.callApiChat=function(c,m,o){o=o||{};seen.push({maxTokens:o.maxTokens,timeoutMs:o.timeoutMs,wantThinking:!!o.wantThinking,disableTools:o.disableTools,jsonMode:o.jsonMode,noWebSearch:o._noWebSearch});return orig.apply(null,arguments)};
        try{
          window.runtimeConsolidationExecuteEnabled=true;var a=await _activeConsolidationModelCall(cfg,msgs,opts);
          window.runtimeConsolidationExecuteEnabled=false;var b=await _activeConsolidationModelCall(cfg,msgs,opts);
        }finally{window.callApiChat=orig;window.runtimeConsolidationExecuteEnabled=undefined}
        return{a:a.text,b:b.text,same:a.text===b.text,opts:seen};
      })()`);
      assert.equal(probe.same, true);
      assert.deepEqual(probe.opts[0], probe.opts[1], 'consolidation 执行器选项必须一致');
      assert.deepEqual(probe.opts[0], { maxTokens: 800, timeoutMs: 120000, wantThinking: false, disableTools: true, jsonMode: true, noWebSearch: true });
      const reqs = reqsFor(from, 'oai', 'CONV_CONS_PROBE');
      assert.equal(reqs.length, 2);
      assert.deepEqual(reqs[0].body, reqs[1].body, 'consolidation 请求体必须逐字段一致');
      assert.equal(reqs[0].body.max_tokens, 800);
      assert.equal(reqs[0].body.response_format.type, 'json_object');
      assert.ok(!('tools' in reqs[0].body));
      assert.equal(reqs[0].body.messages[0].content, 'CONV_SYS');
    });

    await check('visibility / provenance 规则不变', async () => {
      await seedEpi('cc_only', 'only');
      const out = await evaluate(cdp, `(async function(){
        var cfg=apiConfigs.find(function(a){return a.id==='cc_only'});
        var r=await consolidateCharacterMemory(cfg);
        var mems=(await dbGetAll('memories')).filter(function(m){return m.kind==='semantic'&&m.createdBy==='cc_only'});
        var m=mems[0];
        return{ok:!!r,count:mems.length,vis:m&&m.visibility,to:m&&m.visibleTo,refs:m&&m.consolidatedFrom,
          own:m?isMemoryVisibleTo(m,'cc_only',false,false):null,other:m?isMemoryVisibleTo(m,'cc_anth',false,false):null};
      })()`);
      assert.equal(out.ok, true);
      assert.equal(out.count, 1);
      assert.equal(out.vis, 'only', 'only 来源必须派生出 only（不得放宽）');
      assert.deepEqual(out.to, ['cc_only']);
      assert.equal(out.own, true);
      assert.equal(out.other, false);
      assert.deepEqual(out.refs, ['epi_cc_only'], 'provenance 必须回退到真实来源（拒绝伪造 id）');
    });

    await check('成功 semantic 只写一次', async () => {
      /* 铺一条新的 episodic 来源（旧来源已被水位标记），走 merge 路径：同一条 semantic 只应被写一次 */
      await seedEpi('cc_oai', 'public', 'oai2');
      const out = await evaluate(cdp, `(async function(){
        var puts=[],orig=window.dbPut;
        window.dbPut=function(s,d){if(s==='memories')puts.push({id:d&&d.id,kind:d&&d.kind});return orig.apply(null,arguments)};
        try{await consolidateCharacterMemory(apiConfigs.find(function(a){return a.id==='cc_oai'}))}finally{window.dbPut=orig}
        var mems=(await dbGetAll('memories')).filter(function(m){return m.kind==='semantic'&&m.createdBy==='cc_oai'});
        return{puts:puts,count:mems.length};
      })()`);
      assert.equal(out.count, 1, '同一角色只应有一条 semantic');
      const semanticPuts = out.puts.filter(p => p.kind === 'semantic');
      assert.equal(semanticPuts.length, 1, 'semantic 行只应写一次：' + JSON.stringify(out.puts));
      assert.ok(out.puts.filter(p => p.kind !== 'semantic').every(p => p.kind === 'episodic'),
        '除 semantic 外只允许来源水位回写：' + JSON.stringify(out.puts));
    });

    await check('provider error：1 次调用、零副作用、不回落 direct', async () => {
      await seedEpi('cc_fail', 'public');
      const from = captured.length;
      const out = await evaluate(cdp, `(async function(){
        var t0=Date.now(),puts=[],orig=window.dbPut;
        window.dbPut=function(s,d){puts.push({store:s,id:d&&d.id});return orig.apply(null,arguments)};
        var r;
        try{r=await consolidateCharacterMemory(apiConfigs.find(function(a){return a.id==='cc_fail'}))}finally{window.dbPut=orig}
        var mems=(await dbGetAll('memories')).filter(function(m){return m.kind==='semantic'&&m.createdBy==='cc_fail'});
        var src=await dbGet('memories','epi_cc_fail');
        var recs=IB.runtime.telemetry.recent(60).filter(function(x){return x.at>=t0&&x.consumer==='memory_consolidation'});
        return{ret:r,mems:mems.length,watermark:src&&src.lastConsolidatedAt,vis:src&&src.visibility,puts:puts.length,
          recs:recs.map(function(x){return{executor:x.executor,ok:x.ok,fallbackReason:x.fallbackReason}})};
      })()`);
      assert.equal(out.ret, null, 'provider error → 原语义返回 null');
      assert.equal(reqsFor(from, 'fail').length, 1, '同一 attempt 只能一次 provider 调用');
      assert.equal(out.mems, 0, '失败不得创建 semantic');
      assert.equal(out.watermark, null, '失败不得推进 watermark');
      assert.equal(out.vis, 'public', '失败不得改变 source visibility');
      assert.equal(out.puts, 0, '失败不得有任何 memories 写入');
      assert.equal(out.recs.length, 1);
      assert.equal(out.recs[0].executor, 'runtime');
      assert.equal(out.recs[0].fallbackReason, '', '不得回落 direct');
    });

    await check('abort：1 次调用、零副作用、无 retry', async () => {
      await seedEpi('cc_slow', 'public');
      const from = captured.length;
      const out = await evaluate(cdp, `(async function(){
        var ac=new AbortController();
        var p=consolidateCharacterMemory(apiConfigs.find(function(a){return a.id==='cc_slow'}),{signal:ac.signal});
        setTimeout(function(){ac.abort()},250);
        var r=await p;
        var mems=(await dbGetAll('memories')).filter(function(m){return m.kind==='semantic'&&m.createdBy==='cc_slow'});
        var src=await dbGet('memories','epi_cc_slow');
        var tel=null,all=IB.runtime.telemetry.recent(40);
        for(var i=all.length-1;i>=0;i--){if(all[i].consumer==='memory_consolidation'){tel=all[i];break}}
        return{ret:r,mems:mems.length,watermark:src&&src.lastConsolidatedAt,tel:tel};
      })()`);
      assert.equal(out.ret, null);
      assert.equal(out.mems, 0, '中止不得创建 semantic');
      assert.equal(out.watermark, null, '中止不得推进 watermark');
      assert.equal(out.tel.abortReason, 'abort');
      assert.equal(reqsFor(from, 'slow').length, 1, '中止后不得重试');
      await new Promise(r => setTimeout(r, 800));
      assert.equal(reqsFor(from, 'slow').length, 1, '等待期间也不得出现第二次请求');
    });

    await check('gate=false / runtime unavailable → direct（且业务照常）', async () => {
      await seedEpi('cc_gate', 'public');
      await seedEpi('cc_unavail', 'public');
      const out = await evaluate(cdp, `(async function(){
        window.runtimeConsolidationExecuteEnabled=false;
        var g;
        try{g=await consolidateCharacterMemory(apiConfigs.find(function(a){return a.id==='cc_gate'}))}finally{window.runtimeConsolidationExecuteEnabled=undefined}
        var gt=null,all1=IB.runtime.telemetry.recent(20);
        for(var i=all1.length-1;i>=0;i--){if(all1[i].consumer==='memory_consolidation'){gt=all1[i];break}}
        var R=IB.runtime.instance,orig=R.execute;R.execute=null;
        var u;
        try{u=await consolidateCharacterMemory(apiConfigs.find(function(a){return a.id==='cc_unavail'}))}finally{R.execute=orig}
        var ut=null,all2=IB.runtime.telemetry.recent(20);
        for(var j=all2.length-1;j>=0;j--){if(all2[j].consumer==='memory_consolidation'){ut=all2[j];break}}
        var gs=(await dbGetAll('memories')).filter(function(m){return m.kind==='semantic'&&m.createdBy==='cc_gate'});
        var us=(await dbGetAll('memories')).filter(function(m){return m.kind==='semantic'&&m.createdBy==='cc_unavail'});
        return{gate:!!g,unavail:!!u,gateSemantic:gs.length,unavailSemantic:us.length,gt:gt,ut:ut};
      })()`);
      assert.equal(out.gate, true);
      assert.equal(out.unavail, true);
      assert.equal(out.gateSemantic, 1, 'direct 路径业务照常');
      assert.equal(out.unavailSemantic, 1);
      assert.equal(out.gt.executor, 'direct');
      assert.equal(out.gt.fallbackReason, 'gate_disabled');
      assert.equal(out.ut.executor, 'direct');
      assert.equal(out.ut.fallbackReason, 'runtime_unavailable');
    });

    await check('historical repair 行为不变', async () => {
      const out = await evaluate(cdp, `(async function(){
        for(const m of await dbGetAll('memories')) await dbDelete('memories',m.id);
        await dbPut('memories',{id:'r_src',kind:'episodic',createdBy:'role-r',visibility:'only',visibleTo:['role-r'],excludeFrom:[],content:'SRC',created:1000});
        await dbPut('memories',{id:'r_broad',kind:'semantic',source:'consolidation',createdBy:'role-r',visibility:'public',visibleTo:[],excludeFrom:[],content:'BROAD',created:2000,consolidatedFrom:['r_src']});
        await dbPut('memories',{id:'r_diary',source:'diary',createdBy:'ai',characterId:'role-r',content:'DIARY',created:3000});
        var plan=await _memRepairPlan();
        var before=(await dbGet('memories','r_broad')).visibility;
        var applied=await _memRepairApply(plan);
        var after=(await dbGet('memories','r_broad')).visibility;
        var again=await _memRepairPlan();
        return{repairs:plan.repairs.map(function(r){return r['class']+':'+r.id}).sort(),before:before,after:after,
          applied:applied.applied,again:again.repairs.length};
      })()`);
      assert.deepEqual(out.repairs, ['diary-missing-visibility:r_diary', 'semantic-broadened:r_broad']);
      assert.equal(out.before, 'public');
      assert.equal(out.after, 'only', '历史修复仍只收窄');
      assert.equal(out.applied, 2);
      assert.equal(out.again, 0, '幂等');
    });

    /* ══════════ 既有 consumer 与主链路的锁 ══════════ */
    await check('proactive / Moments / Diary 仍走 Runtime', async () => {
      const out = await evaluate(cdp, `(async function(){
        var cfg=apiConfigs.find(function(a){return a.id==='cc_oai'});
        var p=await generateProactiveMessage({character:cfg,user:{name:'用户'},recentMessages:[],memories:[],recentProactiveMessages:[],currentTime:new Date(),messageMode:'greeting',taskId:'conv_p4'});
        var m=await generateRoleMoment('cd_gem',{trigger:'manual'});
        var all=IB.runtime.telemetry.recent(60),act=null,mom=null;
        for(var i=all.length-1;i>=0;i--){if(!act&&all[i].consumer==='active.proactive')act=all[i];if(!mom&&all[i].consumer==='moments')mom=all[i]}
        return{p:p.content,m:!!(m&&m.published),act:act,mom:mom};
      })()`);
      assert.equal(out.p, 'CONV_PROACTIVE_TEXT');
      assert.equal(out.m, true);
      assert.equal(out.act.executor, 'runtime');
      assert.equal(out.mom.executor, 'runtime');
    });

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
        var R=IB.runtime.instance,or=R.run.bind(R),oe=R.execute.bind(R);window.__p4Calls={run:0,execute:0};
        R.run=function(){window.__p4Calls.run++;return or.apply(null,arguments)};
        R.execute=function(){
          window.__p4Calls.execute++;
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
          return{run:window.__p4Calls.run,execute:__calls.length,unclaimed:unclaimed,inflight:inflight,bad:bad};
        };
        try{
          activeFriendId='cc_chat';activeThreadId=null;openChatPanel();
          var i=document.getElementById(currentPage==='chat'?'chat-full-input':'chat-input');i.value='CONV_CHAT_MSG';await sendChatMessage();
          var all=await dbGetAll('chatMessages');var m=all.filter(function(x){return x.friendId==='cc_chat'&&x.role==='assistant'}).slice(-1)[0];
          var afterChat={run:window.__p4Calls.run,execute:window.__p4Calls.execute,reply:String(m&&m.content||'')};
          await dbPut('groups',{id:'cc_group',name:'Conv group',members:['cc_oai','cc_chat'],memoryEnabled:false});
          activeFriendId='cc_group';activeThreadId=null;openChatPanel();
          var gi=document.getElementById(currentPage==='chat'?'chat-full-input':'chat-input');gi.value='CONV_GROUP_MSG';await sendChatMessage();
          var afterGroup={run:window.__p4Calls.run,execute:window.__p4Calls.execute};
          activeFriendId='cc_chat';
          var vres=await sendChatMessage({voiceCall:true,transcript:'CONV_VOICE_MSG',roleId:'cc_chat',conversationId:'voice-1',turnId:'t1'});
          var afterVoice={run:window.__p4Calls.run,execute:window.__p4Calls.execute};
          var acc=await __acc();
          return{afterChat:afterChat,afterGroup:afterGroup,afterVoice:afterVoice,acc:acc,voiceOk:!!(vres&&vres.ok)};
        }finally{R.run=or;R.execute=oe;if(__tel&&__rec)__tel.record=__rec}
      })()`);
      assert.ok(out.afterChat.reply.length > 0, '对照组：Chat 可用');
      assert.equal(out.afterChat.run, 0, 'Chat 不得调用 runtime.run');
      assert.equal(out.afterGroup.run, 0, 'Group 不得调用 runtime.run');
      assert.equal(out.afterVoice.run, 0, 'Voice 不得调用 runtime.run');
      assert.deepEqual(out.acc.bad, [], 'runtime.execute 只能由白名单 consumer 归因：' + JSON.stringify(out.acc.bad));
      assert.equal(out.acc.unclaimed, 0,
        '存在已结束但无法归因的 runtime.execute 调用：' + out.acc.unclaimed + '（在途后台调用 ' + out.acc.inflight + '）');
      assert.equal(out.voiceOk, true);
    });

    await check('telemetry 复用统一结构且不含正文/apiKey', async () => {
      const recs = await evaluate(cdp, `(function(){var all=IB.runtime.telemetry.recent(100);return all.filter(function(r){return r.consumer==='memory_consolidation'||r.consumer==='diary'})})()`);
      assert.ok(recs.length >= 6, '应有 diary / consolidation 记录：' + recs.length);
      const joined = JSON.stringify(recs);
      for (const secret of ['k-anth', 'k-gem']) assert.ok(!joined.includes(secret), '不得包含 apiKey');
      assert.ok(!/CONV_SYS|CONV_IDENTITY_|CONV_EPI_/.test(joined), '不得包含 prompt / source 正文');
      assert.ok(!/CONV_SEM_TITLE|用户偏好安静/.test(joined), '不得包含 semantic 正文');
      assert.ok(!/CONV_DIARY_TITLE|CONV_DIARY_CONTENT/.test(joined), '不得包含日记正文');
      assert.ok(pageLogs.some(l => l.includes('[Consolidation] model executor')), '必须输出 consolidation 诊断');
      assert.ok(pageLogs.some(l => l.includes('[Diary] model executor')), '必须输出 diary 诊断');
    });

    console.log('\nRuntime convergence (phase4): ' + failures + ' failed');
    process.exitCode = failures ? 1 : 0;
  } finally {
    if (cdp) cdp.close();
    browser.kill();
    api.closeAllConnections(); web.closeAllConnections();
    await Promise.all([new Promise(r => api.close(r)), new Promise(r => web.close(r))]);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_) {}
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
