'use strict';

/* ====================================================================
   Context Convergence C2 · Canonical Context Snapshot（step 1）回归
   --------------------------------------------------------------------
   本阶段只做一件事：把 C1 已经"每轮只读一次"的四个 producer 结果，落成一个
   **只读的 canonical 快照对象**，先让 _buildSingleChatContext 与 middle-brain.js 共用它。
   硬约束：不改注入顺序、不改任何 producer 算法、不新增读取、不改变 MB 输出。

   验证（Node 单元 + 真实 localhost 页面 + CDP）：
     A. 契约单元（无需浏览器）：present / empty / missing 三态、freeze、toOrganizeInput、
        blocks 顺序、summary 不含正文。
     B. 接线等价：单聊一轮只建一个快照；快照四字段与注入 prompt 的块逐字段对应；
        Middle Brain 收到同一个快照对象（identity），且 opts.*Ctx 与 toOrganizeInput 等价。
     C. organize 消费语义：present/empty → 直接采用且**不再 retrieval**；
        missing → 保持既有 retrieval 语义（等价于 C1 的 undefined）。
     D. 范围与隐私：群聊不建快照（step 1 只覆盖单聊）；summary() 不含任何正文；
        快照冻结后不可改。
   运行：node test_context_snapshot.js
   ==================================================================== */

const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const http = require('node:http'), assert = require('node:assert/strict');
const { spawn } = require('node:child_process');

const CS = require('./assets/js/context-snapshot.js');

let failures = 0;
const check = (name, cond, detail) => {
  if (cond) console.log('  PASS  ' + name);
  else { failures++; console.error('  FAIL  ' + name + (detail ? '  -> ' + detail : '')); }
};

/* ══════════════ A. 契约单元（纯 Node） ══════════════ */
console.log('\n[A] IBContextSnapshot 契约单元');

const fMem = CS.field('getMemoryContext', 'MEM_TEXT');
const fEmpty = CS.field('getUnderstandingContext', '');
const fMiss = CS.field('getThreadContext', '', { missing: true, gatedBy: 'thread.memoryEnabled' });
const fMom = CS.field('getMomentsContext', 'MOM_TEXT');
const snap = CS.create({ characterId: 'role_a', turnId: 'turn_1', fields: { memory: fMem, understanding: fEmpty, thread: fMiss, moments: fMom }, gates: { threadMemoryEnabled: false } });

check('A1.present', CS.state(snap, 'memory') === 'present' && CS.value(snap, 'memory') === 'MEM_TEXT');
check('A2.empty ≠ missing（empty 返回空串）', CS.state(snap, 'understanding') === 'empty' && CS.value(snap, 'understanding') === '');
check('A3.missing 返回 undefined', CS.state(snap, 'thread') === 'missing' && CS.value(snap, 'thread') === undefined);
check('A4.provided 只对 present/empty 为真', CS.provided(snap, 'memory') && CS.provided(snap, 'understanding') && !CS.provided(snap, 'thread'));
check('A5.gatedBy 标记', snap.fields.thread.gatedBy === 'thread.memoryEnabled' && snap.fields.memory.gatedBy === null);
check('A6.visibility 标记（producer 已过滤）', snap.fields.memory.visibility === 'filtered');
check('A7.冻结：快照 / fields / 字段条目', Object.isFrozen(snap) && Object.isFrozen(snap.fields) && Object.isFrozen(snap.fields.memory));
check('A8.冻结后写入无效', (() => { try { snap.fields.memory.state = 'missing'; } catch (e) { /* strict mode 抛错也可 */ } return snap.fields.memory.state === 'present' && snap.characterId === 'role_a'; })());
check('A9.toOrganizeInput 与 C1 opts 语义一致', (() => {
  const o = CS.toOrganizeInput(snap);
  return o.memoryCtx === 'MEM_TEXT' && o.understandingCtx === '' && o.threadCtx === undefined && o.momentsCtx === 'MOM_TEXT';
})());
check('A10.blocks 只含 present 且顺序 = memory→understanding→thread→moments', (() => {
  const b = CS.blocks(snap);
  return b.length === 2 && b[0].name === 'memory' && b[1].name === 'moments';
})());
check('A11.summary 只含状态/门控，不含正文', (() => {
  const s = JSON.stringify(CS.summary(snap));
  return s.includes('"memory":"present"') && !s.includes('MEM_TEXT') && !s.includes('MOM_TEXT');
})());
check('A12.字符串字段容错（等价于已读）', CS.state(CS.create({ fields: { memory: 'X' } }), 'memory') === 'present' && CS.state(CS.create({ fields: { memory: '' } }), 'memory') === 'empty');

/* ══════════════ B/C/D. 页面接线（CDP） ══════════════ */
const harness = fs.readFileSync(path.join(__dirname, 'test_chat_smoke.js'), 'utf8');
const boundary = harness.indexOf('async function main() {');
assert.ok(boundary > 0, 'existing CDP harness boundary changed');
const { chromePath, Cdp, evaluate, waitFor, freePort } = new Function('require', '__dirname',
  harness.slice(0, boundary) + '\nreturn {chromePath,Cdp,evaluate,waitFor,freePort};')(require, __dirname);

/* teardown 纪律：监听器 unref（与 test_chat_smoke.js harness 一致），并在 finally 显式
   close 两个 server；否则未关闭的 HTTP server handle 会让进程无法自然退出（不以 process.exit 兜底）。 */
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => { server.unref(); resolve(server.address().port); }));

const chatReqs = [];
const api = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') { res.end(); return; }
  let raw = ''; for await (const chunk of req) raw += chunk;
  let body = null; try { body = JSON.parse(raw || '{}'); } catch (_) {}
  if ((req.url || '').includes('/responses')) {
    const userMsg = (() => { try { return String(((body.input || []).find(i => i && i.role === 'user') || {}).content || ''); } catch (_) { return ''; } })();
    const payload = JSON.stringify({ keep: ['C2_MB_KEEP'], merge: [], drop: [], compressedContext: 'C2_MB_COMPRESSED ' + userMsg.slice(0, 80), currentKept: true });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ output: [{ type: 'message', content: [{ type: 'output_text', text: payload }] }], usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 } }));
    return;
  }
  chatReqs.push({ url: req.url, body });
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ choices: [{ message: { content: 'C2_REPLY' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2 } }));
});

(async () => {
  const apiPort = await listen(api), apiBase = 'http://127.0.0.1:' + apiPort;
  const web = require('./internal-beyond-server.js').createWebServer({ root: __dirname, port: 0 });
  const webPort = await listen(web), webBase = 'http://127.0.0.1:' + webPort;
  const debugPort = await freePort();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-c2-'));
  const chrome = chromePath(); assert.ok(chrome, 'Chrome or Edge required');
  const browser = spawn(chrome, ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    '--remote-debugging-port=' + debugPort, '--user-data-dir=' + profile, 'about:blank'], { stdio: 'ignore', windowsHide: true });
  let cdp;

  const resetSpy = () => evaluate(cdp, `(function(){window.__c2={snaps:[],opts:[],count:{}};return true})()`);
  const readSpy = () => evaluate(cdp, `(function(){return{snaps:window.__c2.snaps.length,opts:window.__c2.opts.length,count:window.__c2.count}})()`);
  const chatTurn = role => evaluate(cdp, `(async function(){
    activeFriendId=${JSON.stringify(role)};activeThreadId=null;openChatPanel();
    var i=document.getElementById(currentPage==='chat'?'chat-full-input':'chat-input');
    i.value='C2_USER_MESSAGE';await sendChatMessage();return true;
  })()`);
  const lastBody = () => (chatReqs.slice(-1)[0] || {}).body || {};
  const promptText = body => {
    const msgs = (body && body.messages) || [];
    return msgs.map(m => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content || ''))).join('\n');
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
      source: `const _of=window.fetch.bind(window);window.fetch=function(input,opts){const u=new URL(typeof input==='string'?input:input.url,location.href);`
        + `if(u.origin!==${JSON.stringify(apiBase)}&&u.origin!==${JSON.stringify(webBase)})return Promise.reject(new Error('c2 smoke blocks external service'));return _of(input,opts);};window.confirm=()=>true;`
    });
    await cdp.send('Page.navigate', { url: webBase + '/InternalBeyond.html' });
    assert.ok(await waitFor(cdp, "document.readyState==='complete' && typeof getMemoryContext==='function' && typeof IB.middleBrain.middleBrainExecute==='function' && typeof IBContextSnapshot==='object' && typeof IBContextSnapshot.create==='function'", 20000), 'page + snapshot module + producers mounted');

    /* 探针：记录每次 create 的快照、每次 pipeline 的 opts、每个 producer 的读取次数 */
    await evaluate(cdp, `(function(){
      if(window.__c2probe)return true;
      window.__c2={snaps:[],opts:[],count:{}};
      var oc=IBContextSnapshot.create;
      IBContextSnapshot.create=function(input){var s=oc(input);window.__c2.snaps.push(s);return s};
      /* P11-1C：production 走 canonical execution seam IB.middleBrain.middleBrainExecute。
         探针必须 patch 这个 canonical seam——patch window.middleBrainCompressPipeline 兼容别名
         已无法观测生产调用（两者是不同属性，别名不再是 canonical path）。 */
      var op=IB.middleBrain.middleBrainExecute;
      IB.middleBrain.middleBrainExecute=function(id,msg,opts){window.__c2.opts.push(opts||{});return op.apply(null,arguments)};
      ['getMemoryContext','getUnderstandingContext','getThreadContext','getMomentsContext'].forEach(function(n){
        var orig=window[n];if(typeof orig!=='function')return;
        window[n]=function(){window.__c2.count[n]=(window.__c2.count[n]||0)+1;return orig.apply(null,arguments)};
      });
      window.__c2probe=true;return true;
    })()`);

    const mkCfg = id => ({ id, provider: 'custom', endpoint: apiBase + '/v1/chat/completions', model: 'c2-model-' + id, apiKey: '', nickname: id, streaming: false, promptCache: false, systemPrompt: 'C2_IDENTITY_' + id, relationship: '伙伴' });
    await evaluate(cdp, `(async()=>{
      for(const c of ${JSON.stringify([mkCfg('c2_role'), mkCfg('c2_group_a')])})await dbPut('apiConfigs',c);
      await loadApiConfigs();
      await saveMiddleBrainConfig({enabled:true,endpoint:${JSON.stringify(apiBase + '/v1/responses')},model:'gpt-6-astra',apiKey:'sk-x',admissionEnabled:false});
      await dbPut('memories',{id:'c2_mem',kind:'episodic',createdBy:'c2_role',visibility:'public',visibleTo:[],excludeFrom:[],title:'C2_MEMORY_TITLE',content:'C2_MEMORY_MARKER',domain:'日常',tags:[],valence:0.5,arousal:0.3,importance:9,resolved:false,activationCount:0,created:Date.now(),lastActivated:0});
      await dbPut('memories',{id:'c2_priv',kind:'episodic',createdBy:'c2_role',visibility:'private',visibleTo:[],excludeFrom:[],title:'C2_PRIVATE_TITLE',content:'C2_PRIVATE_MARKER',domain:'日常',tags:[],valence:0.5,arousal:0.3,importance:9,resolved:false,activationCount:0,created:Date.now(),lastActivated:0});
      await unWrite('c2_role',{content:'C2_UNDERSTANDING_MARKER',conviction:80,basis:'user_stated',dimension:'context',evidenceIds:[]});
      await thOpen('c2_role','C2_THREAD_MARKER',[],'ai');
      await createMoment({roleId:'c2_role',content:'C2_MOMENT_MARKER',source:'manual',visibility:'all'});
      await dbPut('apiSettings',{id:'summarySettings',enabled:false,keepCount:6,welcomeEnabled:false,welcomeInterval:2,musicEnabled:false,summaryApiId:'',summaryWindow:60});
      return true})()`);

    /* ── B. 单聊一轮：一个快照 + 与 prompt 等价 + MB 收到同一对象 ──
       第一轮关闭 MB：原四块**原样注入**，用来验证"快照值 = 本轮注入的块"；
       第二轮开启 MB：验证 pipeline 收到同一个快照对象且 opts.*Ctx 等价。 */
    await evaluate(cdp, `(async function(){await saveMiddleBrainConfig({enabled:false});return true})()`);
    await resetSpy();
    await chatTurn('c2_role');
    const spy = await readSpy();
    const prompt = promptText(lastBody());

    await check('B1.单聊一轮只建一个快照', spy.snaps === 1, 'snaps=' + spy.snaps);
    await check('B2.快照覆盖四个 producer 且全部 present', await evaluate(cdp, `(function(){
      var s=window.__c2.snaps[0];var st=IBContextSnapshot.summary(s).states;
      return st.memory==='present'&&st.understanding==='present'&&st.thread==='present'&&st.moments==='present';
    })()`));
    await check('B3.producer 标记正确', await evaluate(cdp, `(function(){
      var f=window.__c2.snaps[0].fields;
      return f.memory.producer==='getMemoryContext'&&f.understanding.producer==='getUnderstandingContext'&&f.thread.producer==='getThreadContext'&&f.moments.producer==='getMomentsContext';
    })()`));
    await check('B4.快照值 = 本轮注入的块（prompt 含各块标记）',
      prompt.includes('C2_MEMORY_MARKER') && prompt.includes('C2_UNDERSTANDING_MARKER') && prompt.includes('C2_THREAD_MARKER') && prompt.includes('C2_MOMENT_MARKER'),
      'prompt 缺块');
    await check('B5.visibility 已过滤：private 记忆不进快照也不进 prompt',
      await evaluate(cdp, `(function(){var s=window.__c2.snaps[0];return IBContextSnapshot.value(s,'memory').indexOf('C2_PRIVATE_MARKER')<0})()`)
      && !prompt.includes('C2_PRIVATE_MARKER'));
    await check('B6.一个快照一次读取：四个 producer 各恰好一次',
      spy.count.getMemoryContext === 1 && spy.count.getUnderstandingContext === 1 && spy.count.getThreadContext === 1 && spy.count.getMomentsContext === 1,
      JSON.stringify(spy.count));

    await evaluate(cdp, `(async function(){await saveMiddleBrainConfig({enabled:true,endpoint:${JSON.stringify(apiBase + '/v1/responses')},model:'gpt-6-astra',apiKey:'sk-x',admissionEnabled:false});return true})()`);
    await resetSpy();
    await chatTurn('c2_role');
    const spy2 = await readSpy();
    await check('B7.Middle Brain 收到同一个快照对象（identity）',
      spy2.snaps === 1 && spy2.opts === 1
      && await evaluate(cdp, `(function(){return window.__c2.opts[0].contextSnapshot===window.__c2.snaps[0]})()`),
      JSON.stringify(spy2));
    await check('B8.opts.*Ctx 与 toOrganizeInput(snapshot) 逐字段等价',
      await evaluate(cdp, `(function(){
        var o=window.__c2.opts[0],s=window.__c2.snaps[0],m=IBContextSnapshot.toOrganizeInput(s);
        return o.memoryCtx===m.memoryCtx&&o.understandingCtx===m.understandingCtx&&o.threadCtx===m.threadCtx&&o.momentsCtx===m.momentsCtx;
      })()`));
    await check('B9.快照冻结（页面内）', await evaluate(cdp, `(function(){var s=window.__c2.snaps[0];return Object.isFrozen(s)&&Object.isFrozen(s.fields)&&Object.isFrozen(s.fields.memory)})()`));

    /* ── C. organize 消费语义：present/empty 不再 retrieval；missing 保持 retrieval ── */
    await check('C1.organize 用快照：present 直接采用且不再读取 producer', await evaluate(cdp, `(async function(){
      var before=window.__c2.count.getMemoryContext||0;
      var s=IBContextSnapshot.create({characterId:'c2_role',fields:{memory:IBContextSnapshot.field('getMemoryContext','SNAP_MEM')}});
      var o=await middleBrainOrganizeContext('c2_role','hi',{contextSnapshot:s});
      var after=window.__c2.count.getMemoryContext||0;
      return o.memory.length===1&&o.memory[0]==='SNAP_MEM'&&after===before;
    })()`));
    await check('C2.organize 用快照：empty 视为"已读为空"，不触发二次检索', await evaluate(cdp, `(async function(){
      var before=window.__c2.count.getMemoryContext||0;
      var s=IBContextSnapshot.create({characterId:'c2_role',fields:{memory:IBContextSnapshot.field('getMemoryContext','')}});
      var o=await middleBrainOrganizeContext('c2_role','hi',{contextSnapshot:s});
      var after=window.__c2.count.getMemoryContext||0;
      return o.memory.length===0&&after===before;
    })()`));
    await check('C3.organize 用快照：missing 保持既有 retrieval 语义（= undefined）', await evaluate(cdp, `(async function(){
      var before=window.__c2.count.getMemoryContext||0;
      var s=IBContextSnapshot.create({characterId:'c2_role',fields:{memory:IBContextSnapshot.field('getMemoryContext','',{missing:true,gatedBy:'thread.memoryEnabled'})}});
      var o=await middleBrainOrganizeContext('c2_role','hi',{contextSnapshot:s});
      var after=window.__c2.count.getMemoryContext||0;
      return o.memory.length===1&&after===before+1;
    })()`));
    await check('C4.无快照时 organize 行为不变（回落到 opts.*Ctx）', await evaluate(cdp, `(async function(){
      var o=await middleBrainOrganizeContext('c2_role','hi',{memoryCtx:'OPT_MEM',understandingCtx:'',threadCtx:'OPT_THREAD'});
      return o.memory[0]==='OPT_MEM'&&o.understanding.length===0&&o.threads[0]==='OPT_THREAD';
    })()`));

    /* ── D. 范围与隐私 ── */
    await check('D1.群聊不建快照（step 1 只覆盖单聊）', await (async () => {
      await evaluate(cdp, `(async function(){
        await dbPut('groups',{id:'c2_group',name:'C2 group',members:['c2_group_a','c2_role'],memoryEnabled:false});
        return true})()`);
      await resetSpy();
      await evaluate(cdp, `(async function(){
        activeFriendId='c2_group';activeThreadId=null;openChatPanel();
        var i=document.getElementById(currentPage==='chat'?'chat-full-input':'chat-input');
        i.value='C2_GROUP_MESSAGE';await sendChatMessage();return true;
      })()`);
      const s2 = await readSpy();
      return s2.snaps === 0;
    })());
    await check('D2.summary 不含正文（可安全写日志）', await evaluate(cdp, `(function(){
      var s=IBContextSnapshot.create({fields:{memory:IBContextSnapshot.field('getMemoryContext','C2_MEMORY_MARKER')}});
      var j=JSON.stringify(IBContextSnapshot.summary(s));
      return j.indexOf('C2_MEMORY_MARKER')<0 && j.indexOf('"memory":"present"')>=0;
    })()`));
    await check('D3.页面无异常', await evaluate(cdp, `(function(){return typeof IBContextSnapshot.value==='function'})()`));

    console.log('\nContext snapshot (C2 step 1): ' + failures + ' failed');
    process.exitCode = failures ? 1 : 0;
  } finally {
    if (cdp) cdp.close();
    try { browser.kill(); } catch (_) {}
    try { api.close(); } catch (_) {}
    try { web.close(); } catch (_) {}
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_) {}
  }
})();
