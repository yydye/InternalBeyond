'use strict';

/* ====================================================================
   Cache Audit · baseline 身份隔离（真实请求路径回归）
   --------------------------------------------------------------------
   背景（用户观察到的现象）：在 Chat 页面聊天时后台 Diary 被触发，
   [IB Cache Audit] 把 Chat 的 system prompt 与 Diary 的 prompt 当成"上一轮 / 本轮"比较，
   报 System/History/Tools/Request structure 全 CHANGED。根因不是 prompt 被污染，
   而是审计基线只按 cfg.id + wire format 分槽 → 同角色的 Chat / Diary 共用一个槽。

   本测试用真实 localhost 页面 + 独立 profile + mock provider 验证：
     · chat → diary → chat：diary 自建基线、绝不与 chat 互比；chat(B) 仍与 chat(A) 比；
     · 真实行为链 sendChatMessage → _diaryMaybeEvent → generateDiaryEntry → runtime.execute
       → callApiChat → _ibCacheAudit 的 consumer 必须是 diary（不是 chat）；
     · 走同一 runtime 的 Moments / memory_consolidation / active.proactive 各自成档、不串；
     · 审计身份 metadata 不进 provider 请求体；带/不带该 metadata 的请求体逐字节一致；
     · 每个请求流自己的 prompt 原样（chat 无日记提示、diary 有日记提示）；
     · 日志一眼可辨：[IB Cache Audit] Consumer: chat|diary | Character | Provider | Model | Format。

   运行：node test_cache_audit_isolation.js
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

/* 身份标记：chat 与 diary 共用同一角色 systemPrompt（diary prompt 会把角色设定拼进 system），
   所以判别式是 diary 特有的那句，而不是角色 prompt 本身。 */
const CHAT_SYS = 'ISO_CHAT_SYSTEM_角色设定';
const DIARY_MARK = '正在写自己的私人日记';
const CHAT_TEXT = 'ISO_CHAT_REPLY';

const captured = [];
let diarySeq = 0;
const api = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') { res.end(); return; }
  let raw = ''; for await (const chunk of req) raw += chunk;
  let body = null; try { body = JSON.parse(raw || '{}'); } catch (_) {}
  const isDiary = raw.includes(DIARY_MARK);
  /* 每次日记内容都不同：避免 _diaryDuplicateCheck 触发重写（那会多出一次模型调用） */
  let text = CHAT_TEXT;
  if (isDiary) {
    diarySeq++;
    text = JSON.stringify({ title: 'ISO_DIARY_TITLE_' + diarySeq, content: 'ISO_DIARY_CONTENT_' + diarySeq,
      mood: '平静', diaryType: 'event', importance: 5, relatedMemoryIds: [], memoryCandidate: null });
  }
  captured.push({ url: req.url || '', body, raw, kind: isDiary ? 'diary' : 'chat' });
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ choices: [{ message: { content: text }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 20, completion_tokens: 4 } }));
});

/* 深扫请求体，确认没有任何审计身份键混入 wire format */
function auditKeysIn(value, trail, out) {
  trail = trail || ''; out = out || [];
  if (!value || typeof value !== 'object') return out;
  for (const k of Object.keys(value)) {
    if (/^(consumer|_ibConsumer|ibConsumer|auditKey|audit)$/i.test(k)) out.push(trail + '.' + k);
    if (typeof value[k] === 'object') auditKeysIn(value[k], trail + '.' + k, out);
  }
  return out;
}

(async () => {
  const apiPort = await listen(api), apiBase = 'http://127.0.0.1:' + apiPort;
  const web = require('./services/internal-beyond-server.js').createWebServer({ root: __dirname, port: 0 });
  const webPort = await listen(web), webBase = 'http://127.0.0.1:' + webPort;
  const debugPort = await freePort();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-cache-audit-'));
  const chrome = chromePath(); assert.ok(chrome, 'Chrome or Edge required');
  const browser = spawn(chrome, ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    '--remote-debugging-port=' + debugPort, '--user-data-dir=' + profile, 'about:blank'], { stdio: 'ignore', windowsHide: true });
  let cdp, failures = 0;
  const pageLogs = [];
  async function check(name, fn) {
    try { await fn(); console.log('  PASS  ' + name); }
    catch (e) { failures++; console.error('  FAIL  ' + name + '  -> ' + (e && e.message || e)); }
  }
  const bodies = () => captured.map(c => c.body);
  const chatBodies = () => captured.filter(c => c.kind === 'chat');
  const diaryBodies = () => captured.filter(c => c.kind === 'diary');

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
      try { pageLogs.push(String(p.type) + ': ' + (p.args || []).map(a => a.value !== undefined ? a.value : (a.description || a.type)).join(' ')); } catch (_) {}
    });
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `const _of=window.fetch.bind(window);window.fetch=function(input,opts){const u=new URL(typeof input==='string'?input:input.url,location.href);`
        + `if(u.origin!==${JSON.stringify(apiBase)}&&u.origin!==${JSON.stringify(webBase)})return Promise.reject(new Error('cache-audit smoke blocks external service'));return _of(input,opts);};window.confirm=()=>true;`
    });
    await cdp.send('Page.navigate', { url: webBase + '/InternalBeyond.html' });
    assert.ok(await waitFor(cdp, "document.readyState==='complete' && typeof sendChatMessage==='function' && typeof generateDiaryEntry==='function' && typeof _diaryModelCall==='function' && typeof _momentsModelCall==='function' && typeof _activeConsolidationModelCall==='function' && window._ibCacheAuditPrev && window.IB && IB.runtime && IB.runtime.instance", 25000), 'page + audit + seams mounted');

    /* ── 页面配置：同 provider / 同 model 的两个角色（用于 consumer 隔离 + 角色隔离） ── */
    const MODEL = 'iso-model';
    const cfgs = [
      { id: 'ca_iso', provider: 'custom', endpoint: apiBase + '/oai/v1/chat/completions', model: MODEL, apiKey: '', nickname: 'ca_iso', streaming: false, systemPrompt: CHAT_SYS, relationship: '伙伴' },
      { id: 'ca_other', provider: 'custom', endpoint: apiBase + '/oai/v1/chat/completions', model: MODEL, apiKey: '', nickname: 'ca_other', streaming: false, systemPrompt: 'ISO_OTHER_SYSTEM_角色设定', relationship: '伙伴' }
    ];
    await evaluate(cdp, `(async()=>{for(const c of ${JSON.stringify(cfgs)})await dbPut('apiConfigs',c);await loadApiConfigs();`
      + `try{_diaryPrefsSave({enabled:true,weeklyEnabled:false,dailyPlannerEnabled:false,eventEnabled:true})}catch(e){}`
      + `try{if(window._activeTimer){clearInterval(window._activeTimer);window._activeTimer=null}}catch(e){}`
      + `try{_momentsPrefsSave({enabled:false,autoPublish:false})}catch(e){}`
      + `window.runtimeExecuteEnabled=true;window._ibCacheAuditPrev={};return true})()`);

    const KEY = { chat: 'chat::ca_iso::custom::' + MODEL + '::openai', diary: 'diary::ca_iso::custom::' + MODEL + '::openai' };

    /* ══ 1. 真实行为链：chat A → 后台 diary A → chat B → diary B ══ */
    await check('真实链路 chat(A) → diary(A) → chat(B) → diary(B)：baseline 互不串槽', async () => {
      pageLogs.length = 0;
      const out = await evaluate(cdp, `(async function(){
        var input=document.getElementById('chat-input');
        activeFriendId='ca_iso';
        input.value='ISO_CHAT_TURN_1';var r1=await sendChatMessage();
        await new Promise(function(r){setTimeout(r,3000)});/* 等 _diaryMaybeEvent 的 800ms 定时器跑完 */
        var diaries=(await dbGetAll('diary_entries')).filter(function(d){return d.characterId==='ca_iso'});
        input.value='ISO_CHAT_TURN_2';var r2=await sendChatMessage();
        await new Promise(function(r){setTimeout(r,800)});
        var d2=await generateDiaryEntry('ca_iso',{trigger:'manual',diaryType:'daily',reason:'隔离回归第二轮'});
        await new Promise(function(r){setTimeout(r,800)});
        var prev=window._ibCacheAuditPrev||{};
        return {r1:!!(r1&&r1.ok!==false),r2:!!(r2&&r2.ok!==false),d2:!!(d2&&d2.ok),
          diaries:diaries.map(function(d){return{title:d.title,content:d.content}}),
          keys:Object.keys(prev),
          snap:Object.keys(prev).reduce(function(o,k){o[k]={system:prev[k].system,model:prev[k].model};return o},{})};
      })()`);
      assert.equal(out.r1, true, 'chat A 应发送成功');
      assert.equal(out.r2, true, 'chat B 应发送成功');
      assert.equal(out.d2, true, '手动第二轮日记应生成成功');
      assert.ok(out.diaries.length >= 1, 'chat 页面行为链应触发 diary 生成：' + JSON.stringify(out.diaries));
      assert.equal(out.diaries[0].title, 'ISO_DIARY_TITLE_1', 'chat 行为链触发的日记应走 diary 身份');
      /* chat / diary 两个请求流各有一槽，身份与内容互不污染 */
      assert.ok(out.keys.includes(KEY.chat), '缺少 chat 槽：' + JSON.stringify(out.keys));
      assert.ok(out.keys.includes(KEY.diary), '缺少 diary 槽：' + JSON.stringify(out.keys));
      assert.ok(out.snap[KEY.chat].system.indexOf(DIARY_MARK) < 0, 'chat 基线不得含日记提示');
      assert.ok(out.snap[KEY.diary].system.indexOf(DIARY_MARK) >= 0, 'diary 基线必须含日记提示');
      assert.equal(out.snap[KEY.chat].model, MODEL);
      assert.equal(out.snap[KEY.diary].model, MODEL);
      /* 关键回归 chat(B).previous === chat(A)：chat 槽在 chat A 后写入，diary 只写自己的 key，
         所以 chat 槽里始终是 chat 请求流的快照（绝无日记提示）——日志侧另证它确实与 chat A 比较。 */
      assert.ok(out.snap[KEY.chat].system.indexOf(CHAT_SYS) >= 0, 'chat 槽应是 chat 请求流自己的 system');
    });

    /* ══ 2. 日志：身份字段 + 不再把 chat / diary 当同一轮比较 ══ */
    await check('日志打印 Consumer/Character/Provider/Model/Format，且不再出现 chat↔diary 互比', async () => {
      const audit = pageLogs.filter(l => l.includes('[IB Cache Audit]'));
      assert.ok(audit.length >= 4, '应有审计日志：' + audit.length);
      const chatLine = audit.find(l => /Consumer: chat \| Character: ca_iso \| Provider: custom \| Model: iso-model \| Format: openai/.test(l));
      const diaryLine = audit.find(l => /Consumer: diary \| Character: ca_iso \| Provider: custom \| Model: iso-model \| Format: openai/.test(l));
      assert.ok(chatLine, '缺少 chat 身份行：' + JSON.stringify(audit.slice(0, 4)));
      assert.ok(diaryLine, '缺少 diary 身份行：' + JSON.stringify(audit.slice(0, 4)));
      /* 原始症状：一条 Changed section 里同时出现 Chat system prompt 与日记 prompt */
      const crossed = audit.filter(l => l.includes(DIARY_MARK) && /Consumer: chat/.test(l));
      assert.deepEqual(crossed, [], 'chat 的审计日志不得出现日记提示：' + JSON.stringify(crossed.slice(0, 2)));
      const mixed = audit.filter(l => /Changed section/.test(l) && l.includes(DIARY_MARK) && l.includes('ISO_CHAT_TURN'));
      assert.deepEqual(mixed, [], '不得把 chat 与 diary 放进同一次比较：' + JSON.stringify(mixed.slice(0, 2)));
      /* chat B 必须与 chat A 比（System: SAME + History: CHANGED），diary B 必须与 diary A 比 */
      const chatStable = audit.filter(l => /Consumer: chat/.test(l) && /System: SAME/.test(l) && /History: CHANGED/.test(l));
      const chatCrossed = audit.filter(l => /Consumer: chat/.test(l) && /System: CHANGED/.test(l));
      const diaryStable = audit.filter(l => /Consumer: diary/.test(l) && /System: SAME/.test(l));
      assert.ok(chatStable.length >= 1, 'chat(B) 应与 chat(A) 比较出 System: SAME + History: CHANGED：' + JSON.stringify(audit));
      assert.deepEqual(chatCrossed, [], 'chat 轮不得出现 System: CHANGED（说明它没跟 diary 比）：' + JSON.stringify(chatCrossed.slice(0, 2)));
      assert.ok(diaryStable.length >= 1, 'diary(B) 应与 diary(A) 比较出 System: SAME：' + JSON.stringify(audit));
      /* 后台消费者（memory_consolidation / understanding）也各有独立身份行 */
      for (const c of ['memory_consolidation', 'understanding']) {
        assert.ok(audit.some(l => new RegExp('Consumer: ' + c.replace('.', '\\.') + ' \\| Character: ca_iso').test(l)), '缺少 ' + c + ' 身份行');
      }
    });

    /* ══ 3. 真实请求体：各自 prompt 原样，且不含审计 metadata ══ */
    await check('provider 请求体：chat/diary 各自 prompt 原样，不含审计身份字段', async () => {
      const cb = chatBodies(), db = diaryBodies();
      assert.ok(cb.length >= 2, '应有 chat 请求：' + cb.length);
      assert.ok(db.length >= 1, '应有 diary 请求：' + db.length);
      for (const c of cb) {
        const sys = JSON.stringify(c.body.messages && c.body.messages[0] && c.body.messages[0].content);
        assert.ok(sys.includes(CHAT_SYS), 'chat 请求应含角色 systemPrompt');
        assert.ok(!sys.includes(DIARY_MARK), 'chat 请求不得含日记提示：' + sys.slice(0, 160));
      }
      for (const d of db) {
        const sys = JSON.stringify(d.body.messages && d.body.messages[0] && d.body.messages[0].content);
        assert.ok(sys.includes(DIARY_MARK), 'diary 请求应含日记提示');
        assert.ok(sys.includes(CHAT_SYS), 'diary 提示按设计内嵌角色设定');
      }
      for (const c of captured) {
        const bad = auditKeysIn(c.body);
        assert.deepEqual(bad, [], 'provider 请求体混入审计字段：' + JSON.stringify(bad) + ' in ' + JSON.stringify(c.body).slice(0, 200));
      }
      /* 缓存语义未被改动：OpenAI 形态仍带既有 prompt_cache_key */
      assert.equal(cb[0].body.prompt_cache_key, 'ib_ca_iso', 'prompt_cache_key 必须保持既有值');
      assert.ok(!('stream' in cb[0].body) || cb[0].body.stream === false, 'streaming:false 不得发 stream:true');
    });

    /* ══ 4. 审计 metadata 不影响请求体：带 / 不带 _ibConsumer 逐字节一致 ══ */
    await check('带 / 不带审计 metadata 的请求体逐字节一致（审计只做 bookkeeping）', async () => {
      const from = captured.length;
      const out = await evaluate(cdp, `(async function(){
        var cfg=apiConfigs.find(function(a){return a.id==='ca_iso'});
        var msgs=[{role:'system',content:'ISO_PROBE_SYS'},{role:'user',content:'ISO_PROBE_USER'}];
        var base={maxTokens:64,timeoutMs:30000,disableTools:true,_noWebSearch:true,wantMeta:false};
        var withMeta=Object.assign({_ibConsumer:'chat'},base);
        var a=await callApiChat(cfg,msgs,withMeta);
        var b=await callApiChat(cfg,msgs,base);
        return {a:a,b:b,same:a===b};
      })()`);
      assert.equal(out.same, true, '两次调用返回文本应一致');
      const probes = captured.slice(from).filter(c => c.raw.includes('ISO_PROBE_SYS'));
      assert.equal(probes.length, 2, '应捕获两次探测请求：' + probes.length);
      assert.equal(JSON.stringify(probes[0].body), JSON.stringify(probes[1].body), '带/不带审计 metadata 的请求体必须逐字节一致');
      assert.deepEqual(auditKeysIn(probes[0].body), [], '请求体不得出现审计字段');
    });

    /* ══ 5. 走同一 runtime 的 consumer 各自成档、不串（Moments / consolidation / proactive） ══ */
    await check('runtime consumer（moments / memory_consolidation / active.proactive）身份不串', async () => {
      const out = await evaluate(cdp, `(async function(){
        var cfg=apiConfigs.find(function(a){return a.id==='ca_iso'});
        var m=[{role:'system',content:'ISO_SEAM_SYS'},{role:'user',content:'ISO_SEAM_USER'}];
        var before=Object.keys(window._ibCacheAuditPrev||{});
        var mo=await _momentsModelCall('reply',cfg,m.slice(),{maxTokens:128,timeoutMs:30000,disableTools:true});
        var co=await _activeConsolidationModelCall(cfg,m.slice(),{maxTokens:128,timeoutMs:30000,disableTools:true});
        var pr=await _activeProactiveModelCall(cfg,m.slice(),{});
        var after=Object.keys(window._ibCacheAuditPrev||{});
        var tel={};
        IB.runtime.telemetry.recent(40).forEach(function(r){if(r.consumer)tel[r.consumer]=1});
        return {added:after.filter(function(k){return before.indexOf(k)<0}),all:after,
          ok:[!!mo,!!(co&&co.text),!!(pr&&pr.text)],tel:Object.keys(tel)};
      })()`);
      assert.deepEqual(out.ok, [true, true, true], '三个 seam 都应真实执行：' + JSON.stringify(out.ok));
      const expect = ['moments::ca_iso::custom::' + MODEL + '::openai',
        'memory_consolidation::ca_iso::custom::' + MODEL + '::openai',
        'active.proactive::ca_iso::custom::' + MODEL + '::openai'];
      for (const k of expect) assert.ok(out.all.includes(k), '缺少 consumer 独立槽 ' + k + '：' + JSON.stringify(out.all));
      /* 与 telemetry 的 consumer 字符串同源（同一份真实执行上下文）。
         active.proactive 的 telemetry 由 generateProactiveMessage 记录、不在这条 seam 内，
         因此这里只用审计槽证明它已到达执行器；moments / memory_consolidation 的 seam 自带 telemetry。 */
      for (const c of ['moments', 'memory_consolidation']) assert.ok(out.tel.includes(c), 'telemetry 应含 ' + c);
      /* 这些槽都不得与 chat / diary 槽混同 */
      assert.ok(!out.added.includes(KEY.chat) && !out.added.includes(KEY.diary), '不得复用 chat/diary 槽');
    });

    /* ══ 6. 不同角色：同 provider/model/consumer 也隔离 ══ */
    await check('不同角色（同 consumer/provider/model）→ 独立基线', async () => {
      const out = await evaluate(cdp, `(async function(){
        var input=document.getElementById('chat-input');
        activeFriendId='ca_other';
        input.value='ISO_OTHER_TURN';
        await sendChatMessage();
        var prev=window._ibCacheAuditPrev||{};
        return {keys:Object.keys(prev).filter(function(k){return k.indexOf('chat::')===0}),
          sys:(prev['chat::ca_other::custom::${MODEL}::openai']||{}).system||''};
      })()`);
      assert.ok(out.keys.includes('chat::ca_other::custom::' + MODEL + '::openai'), '另一个角色应有自己的 chat 槽：' + JSON.stringify(out.keys));
      assert.ok(out.sys.includes('ISO_OTHER_SYSTEM'), '另一角色槽内应是它自己的 system：' + out.sys.slice(0, 80));
      assert.equal(out.keys.length, 2, '两个角色各一槽：' + JSON.stringify(out.keys));
    });

    /* ══ 7. 日志不泄露 apiKey ══ */
    await check('审计日志不打印 apiKey', async () => {
      const joined = pageLogs.join('\n');
      assert.ok(!/sk-|Bearer /.test(joined), '审计日志不得出现 key 形态内容');
    });

    console.log('\nCache audit isolation: ' + failures + ' failed');
    process.exitCode = failures ? 1 : 0;
  } finally {
    if (cdp) cdp.close();
    browser.kill();
    api.closeAllConnections(); web.closeAllConnections();
    await Promise.all([new Promise(r => api.close(r)), new Promise(r => web.close(r))]);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_) {}
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
