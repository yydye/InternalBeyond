/* ====================================================================
   Phase 1 · 可选上下文按需注入（lazy-inject optional chat capabilities）
   --------------------------------------------------------------------
   覆盖用户给定的 5 个用例：
     Case 1  新角色 +「你好呀」→ 不得出现 ICode 工作区指令 / posts 日志 /
             图像生成说明 / Blog 指令 / 联网搜索说明 / 日历指令 / 文件输出说明
     Case 2  明确请求修改 workspace 文件 → 必须出现 ICode/工作区指令
     Case 3  明确请求查看/讨论 Blog 日志  → 必须出现日志段 + Blog 阅读申请指令
     Case 4  明确图片生成请求 → 图像生成能力说明保留（能力本身不变，只减常驻说明）
     Case 5  first_chat diary → persona 只出现一次

   断言口径（不放宽）：
     · Case 1 用「逐字不存在」判定，并额外断言仍保留必要角色主体（systemPrompt/关系）；
     · 门控判定走真实生产链（buildChatContext → buildSiteContext → chat-context-signals），
       不 mock 被测函数；
     · 联网搜索说明的注入点在后端请求构建期（IBWS.SYS_NOTE），本测试直接调用其
       门控真源 IBWS.searchNoteNeeded 验证逐轮行为，并另外断言"搜索工具本身仍挂载"。

   运行：node test_chat_context_lazy_injection.js
   ==================================================================== */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http'), net = require('net'), crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');

const PAGE_URL = 'file:///' + path.join(ROOT, 'InternalBeyond.html').replace(/\\/g, '/');
function chromePath(){ if(process.env.CHROME_PATH&&fs.existsSync(process.env.CHROME_PATH))return process.env.CHROME_PATH; for(const c of ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe','C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe','C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe','C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe']) if(fs.existsSync(c))return c; return null; }
class Cdp{constructor(s){this.s=s;this.b=Buffer.alloc(0);this.id=0;this.p=new Map();this.l=new Map();s.on('data',c=>{this.b=Buffer.concat([this.b,c]);this.parse()});s.on('error',()=>{})}static c(u){return new Promise((res,rej)=>{const url=new URL(u);const r=http.request({host:url.hostname,port:url.port,path:url.pathname+url.search,headers:{Upgrade:'websocket',Connection:'Upgrade','Sec-WebSocket-Key':crypto.randomBytes(16).toString('base64'),'Sec-WebSocket-Version':'13'}});r.on('upgrade',(res2,s)=>res(new Cdp(s)));r.on('error',rej);r.end()})}on(m,l){if(!this.l.has(m))this.l.set(m,[]);this.l.get(m).push(l)}send(m,p={}){const id=++this.id;return new Promise((res,rej)=>{this.p.set(id,{res,rej});this.t({id,method:m,params:p});setTimeout(()=>{if(this.p.has(id)){this.p.delete(id);rej(new Error('timeout '+m))}},20000)})}t(m){const p=Buffer.from(JSON.stringify(m),'utf8'),mask=crypto.randomBytes(4),b=Buffer.alloc(p.length);for(let i=0;i<p.length;i++)b[i]=p[i]^mask[i&3];let h;if(p.length<126)h=Buffer.from([0x81,0x80|p.length]);else{h=Buffer.alloc(4);h[0]=0x81;h[1]=0x80|126;h.writeUInt16BE(p.length,2)}this.s.write(Buffer.concat([h,mask,b]))}f(o,p){const mask=crypto.randomBytes(4),b=Buffer.alloc(p.length);for(let i=0;i<p.length;i++)b[i]=p[i]^mask[i&3];let h;if(p.length<126)h=Buffer.from([0x80|o,0x80|p.length]);else{h=Buffer.alloc(4);h[0]=0x80|o;h[1]=0x80|126;h.writeUInt16BE(p.length,2)}this.s.write(Buffer.concat([h,mask,b]))}parse(){for(;;){if(this.b.length<2)return;const f=this.b[0],sl=this.b[1]&0x7f;let o=2,len=sl;if(sl===126){if(this.b.length<4)return;len=this.b.readUInt16BE(2);o=4}else if(sl===127){if(this.b.length<10)return;len=this.b.readUInt32BE(6);o=10}const m=(this.b[1]&0x80)!==0;let mask=null;if(m){if(this.b.length<o+4)return;mask=this.b.subarray(o,o+4);o+=4}if(this.b.length<o+len)return;let p=this.b.subarray(o,o+len);this.b=this.b.subarray(o+len);if(mask){const d=Buffer.alloc(p.length);for(let i=0;i<p.length;i++)d[i]=p[i]^mask[i&3];p=d}const op=f&0xf;if(op===0x8){this.s.end();return}if(op!==0x1&&op!==0x2)continue;let txt;try{txt=p.toString('utf8')}catch(e){continue}if(txt==='')continue;let msg;try{msg=JSON.parse(txt)}catch(e){continue}if(msg.id&&this.p.has(msg.id)){const{res,rej}=this.p.get(msg.id);this.p.delete(msg.id);if(msg.error)rej(new Error(JSON.stringify(msg.error)));else res(msg.result)}else if(msg.method&&this.l.has(msg.method)){this.l.get(msg.method).forEach(cb=>{try{cb(msg.params)}catch(e){}})}}}}
async function ev(c,e){const r=await c.send('Runtime.evaluate',{expression:e,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw new Error('page exception: '+JSON.stringify(r.exceptionDetails.exception));return r.result&&r.result.value}
async function wait(c,e,t=20000){const end=Date.now()+t;while(Date.now()<end){try{if(await ev(c,e))return true}catch(err){}await new Promise(r=>setTimeout(r,120))}return false}
function freePort(){return new Promise((res,rej)=>{const s=net.createServer();s.unref();s.on('error',rej);s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(e=>e?rej(e):res(p))})})}

/* ── Case 1 断言用：逐字不得出现的片段（各自取自生产常量/说明本体） ── */
const FORBIDDEN_PLAIN = {
  'ICode 工作区指令': '【ICode 工作区指令】',
  'posts/logs 日志段': '【用户最近写的日志】',
  'Blog 阅读申请指令': '【Blog 阅读申请】',
  '文件输出能力说明': '【文件输出能力】',
  '图像生成说明': '【图像生成】',
  '日历便笺指令': '【日历便笺',
  '外部工具说明': '【外部工具】'
};
/* 保留项（证明门控没有误伤必要内容）：全部取自生产角色配置，不放宽为"非空即可" */
const KEEP = {
  '角色 systemPrompt 主体': 'LAZY_PERSONA_主体不应被移除',
  '角色昵称身份': '你的身份/昵称是「测试角色」',
  '关系声明': '你和对方的关系是：测试关系',
  '个人资料段': '【对方的个人资料】',
  '个人资料昵称': 'LAZY_USER_NAME'
};

const CFG = {
  id: 'lazy1', nickname: '测试角色', model: 'lazy-model', provider: 'custom',
  endpoint: 'http://127.0.0.1:1/v1/chat/completions', apiKey: 'k',
  systemPrompt: 'LAZY_PERSONA_主体不应被移除', relationship: '测试关系',
  imageGen: true, webSearch: true, promptCache: false
};

(async () => {
  const chrome = chromePath(); if (!chrome) { console.error('Chrome/Edge required'); process.exit(2); }
  /* 假 provider：用于 Case 5 在**真实请求体**上核对 persona 只出现一次 */
  const captured = [];
  const api = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    if (req.method === 'OPTIONS') { res.end(); return; }
    let raw = ''; for await (const c of req) raw += c;
    let body = null; try { body = JSON.parse(raw || '{}'); } catch (e) {}
    captured.push({ url: req.url || '', body, raw });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ title: 'LAZY_DIARY_TITLE', content: 'LAZY_DIARY_BODY', mood: '平静', diaryType: 'event', importance: 5, relatedMemoryIds: [], memoryCandidate: null }) }, finish_reason: 'stop' }], usage: { prompt_tokens: 30, completion_tokens: 6 } }));
  });
  const apiPort = await new Promise(r => { api.listen(0, '127.0.0.1', () => r(api.address().port)) });
  const port = await freePort(), profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-lazy-'));
  const browser = spawn(chrome, ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    '--allow-file-access-from-files', '--window-size=900,700',
    '--remote-debugging-port=' + port, '--user-data-dir=' + profile, 'about:blank'], { stdio: 'ignore', windowsHide: true });
  let cdp, failures = 0;
  const check = (n, c, d = '') => { if (c) console.log('  PASS  ' + n); else { failures++; console.error('  FAIL  ' + n + (d ? '  -> ' + d : '')); } };

  try {
    let ready = false;
    for (let i = 0; i < 120; i++) { try { const r = await fetch('http://127.0.0.1:' + port + '/json/version'); if (r.ok) { ready = true; break } } catch (e) {} await new Promise(r => setTimeout(r, 100)) }
    check('browser.ready', ready); if (!ready) throw new Error('Chrome DevTools 未就绪');
    const tab = await (await fetch('http://127.0.0.1:' + port + '/json/new?' + encodeURIComponent(PAGE_URL), { method: 'PUT' })).json();
    cdp = await Cdp.c(tab.webSocketDebuggerUrl); await cdp.send('Runtime.enable');
    check('page.ready', await wait(cdp, "(!!(window.IB&&window.IB.chat&&typeof window.IB.chat.buildChatContext==='function')) && !!(window.IBContextSignals&&window.IBContextSignals.workspaceInstrNeeded) && typeof window.IBWS==='object' && typeof window.buildDiaryPrompt==='function' && typeof dbPut==='function'", 25000));
    await ev(cdp, "window.confirm=function(){return true;}");

    /* ── 世界状态：一个日志（Case 3 用）、一个工作区项目与文件（Case 2 兜底用）、用户资料 ── */
    await ev(cdp, `(async function(){
      await dbPut('apiSettings',{id:'readingLimits',chatLimit:5,postsLimit:5,groupChatLimit:10});
      await dbPut('about',{id:'main',name:'LAZY_USER_NAME',bio:'喜欢写日志与做小工具。'});
      await dbPut('posts',{id:'p_lazy_1',title:'LAZY_POST_TITLE_雨夜',content:'LAZY_POST_BODY_今晚的雨很轻，我写下了这段很长的正文，用于验证日志段是否被注入。',created:Date.now(),locked:false});
      await dbPut('projects',{id:'proj_lazy',name:'LAZYPROJ',created:Date.now()});
      await dbPut('projectFiles',{id:'pf_lazy',projectId:'proj_lazy',path:'LAZYPROJ/notes.txt',size:12,created:Date.now()});
      await dbPut('apiConfigs',${JSON.stringify(CFG)});
      await loadApiConfigs();
      return true;
    })()`);

    const bcc = async (msg, extra) => ev(cdp, `(async function(){
      var cfg=apiConfigs.find(function(a){return a.id==='lazy1'})||${JSON.stringify(CFG)};
      var r=await IB.chat.buildChatContext(cfg,Object.assign({userMessage:${JSON.stringify(msg)}},${JSON.stringify(extra || {})}));
      return {system:String((r&&r.system)||''),tail:String((r&&r.tail)||'')};
    })()`);

    /* ══════════ Case 1：新角色 +「你好呀」 ══════════ */
    for (const msg of ['你好呀', '今天怎么样', '晚安', '在吗']) {
      const out = await bcc(msg);
      const sys = out.system;
      for (const [label, frag] of Object.entries(FORBIDDEN_PLAIN)) {
        check('case1.plain[' + msg + '].absent.' + label, sys.indexOf(frag) < 0, '仍然注入了：' + frag);
      }
      /* 必要内容必须保留：门控不得误伤角色主体 */
      for (const [label, frag] of Object.entries(KEEP)) {
        check('case1.plain[' + msg + '].keep.' + label, sys.indexOf(frag) >= 0, '被误删：' + frag);
      }
    }
    /* 侧证：闲聊轮里的图像生成说明缺失是**门控**而非删除 —— 见下面 Case 4 的正向断言。 */

    /* ══════════ Case 2：明确请求修改 workspace 文件 ══════════ */
    {
      const out = await bcc('帮我把 LAZYPROJ 里的 notes.txt 里的第二段改短一点');
      check('case2.wsInstrByRealEntity', out.system.indexOf('【ICode 工作区指令】') >= 0,
        '指名真实项目/文件时必须注入工作区指令');
      check('case2.fileOutputInstrPresent', out.system.indexOf('【文件输出能力】') >= 0,
        '文件输出能力与工作区指令同生共死');
      check('case2.bsaWuAbsent', out.system.indexOf('【用户最近写的日志】') < 0,
        '没有谈到日志时不得注入日志段');
    }
    {
      /* 结构化信号优先于文本：ICode 悬浮窗处于打开状态 → 即使句子本身没有关键词也注入 */
      await ev(cdp, "(function(){var ov=document.getElementById('ws-overlay');if(ov)ov.style.display='flex';return true})()");
      const out = await bcc('接下来怎么做比较好');
      check('case2.wsInstrByICodeEntryState', out.system.indexOf('【ICode 工作区指令】') >= 0,
        'ICode 入口处于打开状态时必须注入工作区指令');
      await ev(cdp, "(function(){var ov=document.getElementById('ws-overlay');if(ov)ov.style.display='none';return true})()");
    }
    {
      /* 属性/结构化信号优先：上一轮回复里真实存在过工作区操作标签 */
      const out = await bcc('继续', { history: [{ role: 'assistant', content: '已经写好：<ws_create path="a.txt">x</ws_create>' }] });
      check('case2.wsInstrByRecentWsHistory', out.system.indexOf('【ICode 工作区指令】') >= 0,
        '历史里存在真实工作区操作时必须注入工作区指令');
    }
    {
      /* 待注入队列非空（上一轮 ws_read 结果尚未回传）= 工作区正在使用中 */
      await ev(cdp, "(function(){_wsPendingReads.push({path:'LAZYPROJ/notes.txt',projectId:'proj_lazy',actor:'',total:5,content:'hello'});return true})()");
      const out = await bcc('接着看');
      check('case2.wsInstrByPendingQueue', out.system.indexOf('【ICode 工作区指令】') >= 0,
        '存在待注入的工作区结果时必须注入工作区指令');
      await ev(cdp, "(function(){_wsPendingReads=[];return true})()");
    }
    {
      /* 末端兜底：没有结构化信号时的明确祈使式文件/代码请求（不明说真实实体名） */
      const out = await bcc('帮我写一个 Python 脚本，把两列数据合并导出成 CSV 文件');
      check('case2.wsInstrByExplicitRequest', out.system.indexOf('【ICode 工作区指令】') >= 0,
        '明确的文件/代码操作请求必须注入工作区指令');
    }

    /* ══════════ Case 3：明确请求查看/讨论 Blog 日志 ══════════ */
    {
      const out = await bcc('《LAZY_POST_TITLE_雨夜》那篇日志写得怎么样？');
      check('case3.logsPresent', out.system.indexOf('【用户最近写的日志】') >= 0, '谈到真实日志时必须注入日志段');
      check('case3.logsTitleMatched', out.system.indexOf('LAZY_POST_TITLE_雨夜') >= 0, '日志段必须包含该篇标题');
      check('case3.blogReadInstrPresent', out.system.indexOf('【Blog 阅读申请】') >= 0, '带日志列表时必须注入 Blog 阅读申请指令');
      check('case3.wsInstrAbsent', out.system.indexOf('【ICode 工作区指令】') < 0, '谈日志不是文件操作，不得携带工作区指令');
    }
    {
      /* 反向：没谈到日志时，Blog 阅读申请同样不得出现（它与日志段同生共死） */
      const out = await bcc('你好呀');
      check('case3.blogReadInstrAbsentOnPlain', out.system.indexOf('【Blog 阅读申请】') < 0, '闲聊轮不得携带 Blog 阅读申请指令');
    }

    /* ══════════ Case 4：明确图片生成请求 ══════════ */
    {
      const out = await bcc('帮我画一张傍晚海边的猫，要暖色调');
      check('case4.imageGenInstrPresent', out.system.indexOf('【图像生成】') >= 0, '开启生图能力的角色必须保留生图说明');
      check('case4.imageGenTagDocumented', out.system.indexOf('<ws_gen_image') >= 0, '生图说明必须给出实际标签用法');
      check('case4.editImageTagDocumented', out.system.indexOf('<ws_edit_image') >= 0, '生图说明必须给出改图标签用法');
    }

    /* ══════════ 联网搜索：能力不变，只有"使用说明"按轮注入 ══════════ */
    {
      const g = async (t) => ev(cdp, `(function(){return IBWS.searchNoteNeeded([{role:'user',content:${JSON.stringify(t)}}],apiConfigs.find(function(a){return a.id==='lazy1'}))})()`);
      check('searchNote.plainAbsent', (await g('你好呀')) === false, '闲聊轮不得注入搜索使用说明');
      check('searchNote.goodnightAbsent', (await g('晚安')) === false, '晚安不得注入搜索使用说明');
      check('searchNote.queryPresent', (await g('帮我看下最近的新闻')) === true, '信息类请求必须保留搜索使用说明');
      check('searchNote.questionPresent', (await g('明天天气怎么样？')) === true, '问句必须保留搜索使用说明');
      check('searchNote.fileTurnPresent', (await g('帮我写个脚本导出 CSV 文件')) === true, '文件任务必须保留搜索使用说明（含"文件任务禁止搜索"约束）');
      /* 能力本身不变：搜索工具照旧按 cfg.webSearch 挂到请求体上 */
      const attach = await ev(cdp, `(function(){var b={messages:[]};var on=IBWS.attach(b,'openai',apiConfigs.find(function(a){return a.id==='lazy1'}),{});return {on:on,tools:b.tools||null,wsOpts:b.web_search_options===undefined?'undef':String(b.web_search_options)}})()`);
      check('searchNote.toolStillAttached', attach.on === true && attach.wsOpts !== 'undef', JSON.stringify(attach));
    }

    /* ══════════ 日历便笺指令：只在当轮真的有事可提时注入 ══════════ */
    {
      const cal = await ev(cdp, `(function(){return {neededEmpty:IBContextSignals.calendarNoteNeeded(''),neededNull:IBContextSignals.calendarNoteNeeded(null),neededText:IBContextSignals.calendarNoteNeeded('【日历事项】\\n· 纪念日 — 今天')}})()`);
      check('calendar.emptyNotNeeded', cal.neededEmpty === false && cal.neededNull === false, JSON.stringify(cal));
      check('calendar.contentNeeded', cal.neededText === true, JSON.stringify(cal));
    }

    /* ══════════ Case 5：first_chat diary · persona 只出现一次 ══════════ */
    {
      /* 5a. 真实链路：走生产 generateDiaryEntry（内部 = _diaryContext → buildDiaryPrompt →
             _diaryModelCall → runtime.execute），在**实际发出的请求体**上核对。 */
      await ev(cdp, `(async function(){
        await dbPut('apiConfigs',Object.assign(${JSON.stringify(CFG)},{id:'lazy_diary',endpoint:${JSON.stringify('http://127.0.0.1:' + apiPort + '/v1/chat/completions')},model:'lazy-diary-model'}));
        await loadApiConfigs();
        try{window.runtimeDiaryExecuteEnabled=false}catch(e){}
        await generateDiaryEntry('lazy_diary',{trigger:'first_chat',diaryType:'event',reason:'首次聊天'});
        return true;
      })()`);
      const diaryReqs = captured.filter(c => c.raw.indexOf('写自己的私人日记') >= 0);
      check('case5.diaryRequestCaptured', diaryReqs.length >= 1, '捕获数=' + diaryReqs.length);
      if (diaryReqs.length) {
        const msgs = (diaryReqs[0].body && diaryReqs[0].body.messages) || [];
        const joined = msgs.map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).join('\n\u0000\n');
        const personaCount = joined.split(CFG.systemPrompt).length - 1;
        check('case5.wire.personaExactlyOnce', personaCount === 1, '出现次数=' + personaCount + ' roles=' + msgs.map(m => m.role).join(','));
        check('case5.wire.noPersonaSectionInUser',
          !msgs.some(m => m.role === 'user' && String(m.content).indexOf('【角色设定】') >= 0),
          '用户消息里仍带【角色设定】段');
        check('case5.wire.personaInSystem', msgs.some(m => m.role === 'system' && String(m.content).indexOf(CFG.systemPrompt) >= 0));
        check('case5.wire.taskStillIntact', msgs.some(m => m.role === 'user' && /【任务】|私人日记/.test(String(m.content))));
      }
    }
    {
      const d = await ev(cdp, `(function(){
        var built=buildDiaryPrompt({character:${JSON.stringify(CFG)},context:{user:{name:'LAZY_USER_NAME'},character:${JSON.stringify(CFG)},recentMessages:[{role:'user',content:'你好呀'}],memories:[]},diaryType:'event',reason:'首次聊天'});
        /* 只统计**实际发送的 messages**（messages[0] 就是那个 system）；不要另外再算一次 built.system，
           否则等于把同一条消息数两遍，测出来的"重复"是测试自己的 bug。 */
        var all=(built.messages||[]).map(function(m){return String(m.content||'')});
        var joined=all.join('\\n\\u0000\\n');
        var needle=${JSON.stringify(CFG.systemPrompt)};
        var count=0,idx=0;
        while((idx=joined.indexOf(needle,idx))>=0){count++;idx+=needle.length}
        return {count:count,systemHas:String(built.system||'').indexOf(needle)>=0,
          userHas:(built.messages||[]).some(function(m){return m.role==='user'&&String(m.content||'').indexOf(needle)>=0}),
          hasEmptyPersona:joined.indexOf('【角色设定】')>=0||joined.indexOf('（无）')>=0,
          taskPresent:joined.indexOf('【任务】')>=0,
          relationPresent:joined.indexOf('【角色与用户的关系】')>=0,
          memPresent:joined.indexOf('【相关长期记忆】')>=0,
          sysMsgCount:(built.messages||[]).filter(function(m){return m.role==='system'}).length,
          systemChars:String(built.system||'').length,
          allChars:all.reduce(function(a,b){return a+b.length},0),
          msgRoles:(built.messages||[]).map(function(m){return m.role}).join(',')};
      })()`);
      check('case5.personaExactlyOnce', d.count === 1, JSON.stringify(d));
      check('case5.personaInSystem', d.systemHas === true, JSON.stringify(d));
      check('case5.personaNotInUserPrompt', d.userHas === false, JSON.stringify(d));
      check('case5.noPersonaPlaceholder', d.hasEmptyPersona === false, JSON.stringify(d));
      check('case5.diaryStillHasToneSource', d.taskPresent && d.relationPresent && d.sysMsgCount === 1, JSON.stringify(d));
      check('case5.memoryContractIntact', d.memPresent === true, JSON.stringify(d));
    }
    /* 记录（不做断言）：每日 planner 的 persona 段是【摘要】而不是重复的 canonical 全文，
       且它自身的 system 段**不含**角色 persona（只有"日记规划者"这一句指令），
       因此 planner 侧不存在 first_chat 那种双份问题。这里用生产源码文本核对，避免凭空假设。 */
    {
      const plannerSrc = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'active-diary', 'diary.js'), 'utf8');
      const plannerBody = plannerSrc.slice(plannerSrc.indexOf('async function _diaryDailyPlanner'), plannerSrc.indexOf('/* 调度 tick'));
      const plannerSystem = (plannerBody.match(/const system='([^']*)'/) || [])[1] || '';
      check('case5.plannerSystemHasNoPersonaCopy', plannerSystem.indexOf('systemPrompt') < 0,
        'planner 的 system 段不应再复制一份 persona：' + plannerSystem.slice(0, 80));
      check('case5.plannerUsesAbstractNotCanonical', /【角色设定摘要】/.test(plannerBody) && !/【角色设定】/.test(plannerBody),
        'planner 只应使用【角色设定摘要】，不得再带一份【角色设定】全文');
    }
  } catch (e) {
    failures++; console.error('  FAIL  harness  -> ' + (e && e.stack || e));
  } finally {
    try { if (cdp) await cdp.send('Browser.close') } catch (e) {}
    try { browser.kill() } catch (e) {}
    try { api.close() } catch (e) {}
  }
  console.log('\nPhase 1 lazy injection: ' + failures + ' failed');
  process.exitCode = failures ? 1 : 0;
})();
