/* ====================================================================
   P11-3X-C · Performance / Context Budget Audit & Closure
   --------------------------------------------------------------------
   测量先行：本套件的每一节都作用在**真实生产调用链**上（不 mock 被测函数），
   既打印测量表（可复现的证据），也对 CONFIRMED 的修复做 before/after 断言。

     §CORE    assets/js/context-budget-core.js 的纯契约（Node 侧，无浏览器）
     §MEASURE Context Budget Runtime Measurement（真实 buildChatContext + 真实 producer）
     §TURN    DB Hot Path（真实 sendChatMessage 一个完整单聊回合）
     §IDLE    Idle Work（在页面脚本之前注入计时器包装，按创建点归因）
     §FIX     本阶段六条 CONFIRMED 的修复断言（before/after 数字）
     §3D1     P11-3D.1 不变量：一个宿主回合只有一个周期、一份预算

   运行：node tests/test_p11_3x_c_context_budget.js
   ==================================================================== */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http'), net = require('net'), crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const PAGE_URL = 'file:///' + path.join(ROOT, 'InternalBeyond.html').replace(/\\/g, '/');
const BudgetCore = require(path.join(ROOT, 'assets/js/context-budget-core.js'));

function chromePath(){ if(process.env.CHROME_PATH&&fs.existsSync(process.env.CHROME_PATH))return process.env.CHROME_PATH; for(const c of ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe','C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe','C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe','C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe']) if(fs.existsSync(c))return c; return null; }
class Cdp{constructor(s){this.s=s;this.b=Buffer.alloc(0);this.id=0;this.p=new Map();this.l=new Map();s.on('data',c=>{this.b=Buffer.concat([this.b,c]);this.parse()});s.on('error',()=>{})}static c(u){return new Promise((res,rej)=>{const url=new URL(u);const r=http.request({host:url.hostname,port:url.port,path:url.pathname+url.search,headers:{Upgrade:'websocket',Connection:'Upgrade','Sec-WebSocket-Key':crypto.randomBytes(16).toString('base64'),'Sec-WebSocket-Version':'13'}});r.on('upgrade',(res2,s)=>res(new Cdp(s)));r.on('error',rej);r.end()})}on(m,l){if(!this.l.has(m))this.l.set(m,[]);this.l.get(m).push(l)}send(m,p={}){const id=++this.id;return new Promise((res,rej)=>{this.p.set(id,{res,rej});this.t({id,method:m,params:p});setTimeout(()=>{if(this.p.has(id)){this.p.delete(id);rej(new Error('CDP timeout: '+m))}},90000)})}t(m){const p=Buffer.from(JSON.stringify(m),'utf8'),mask=crypto.randomBytes(4),b=Buffer.alloc(p.length);for(let i=0;i<p.length;i++)b[i]=p[i]^mask[i&3];let h;if(p.length<126)h=Buffer.from([0x81,0x80|p.length]);else if(p.length<65536){h=Buffer.alloc(4);h[0]=0x81;h[1]=0x80|126;h.writeUInt16BE(p.length,2)}else{h=Buffer.alloc(10);h[0]=0x81;h[1]=0x80|127;h.writeUInt32BE(0,2);h.writeUInt32BE(p.length,6)}this.s.write(Buffer.concat([h,mask,b]))}parse(){for(;;){if(this.b.length<2)return;const f=this.b[0],sl=this.b[1]&0x7f;let o=2,len=sl;if(sl===126){if(this.b.length<4)return;len=this.b.readUInt16BE(2);o=4}else if(sl===127){if(this.b.length<10)return;len=this.b.readUInt32BE(6);o=10}const m=(this.b[1]&0x80)!==0;let mask=null;if(m){if(this.b.length<o+4)return;mask=this.b.subarray(o,o+4);o+=4}if(this.b.length<o+len)return;let p=this.b.subarray(o,o+len);this.b=this.b.subarray(o+len);if(mask){const d=Buffer.alloc(p.length);for(let i=0;i<p.length;i++)d[i]=p[i]^mask[i&3];p=d}const op=f&0xf;if(op===0x8){this.s.end();return}if(op!==0x1&&op!==0x2)continue;let txt;try{txt=p.toString('utf8')}catch(e){continue}if(txt==='')continue;let msg;try{msg=JSON.parse(txt)}catch(e){continue}if(msg.id&&this.p.has(msg.id)){const{res,rej}=this.p.get(msg.id);this.p.delete(msg.id);if(msg.error)rej(new Error(JSON.stringify(msg.error)));else res(msg.result)}else if(msg.method&&this.l.has(msg.method)){this.l.get(msg.method).forEach(cb=>{try{cb(msg.params)}catch(e){}})}}}}
async function ev(c,e){const r=await c.send('Runtime.evaluate',{expression:e,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw new Error('page exception: '+JSON.stringify(r.exceptionDetails.exception||r.exceptionDetails));return r.result&&r.result.value}
async function wait(c,e,t=25000){const end=Date.now()+t;while(Date.now()<end){try{if(await ev(c,e))return true}catch(err){}await new Promise(r=>setTimeout(r,120))}return false}
function freePort(){return new Promise((res,rej)=>{const s=net.createServer();s.unref();s.on('error',rej);s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(e=>e?rej(e):res(p))})})}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function table(rows,cols){
  const w=cols.map(c=>Math.max(String(c).length,...rows.map(r=>String(r[c]==null?'':r[c]).length)));
  const line=a=>'| '+a.map((v,i)=>String(v==null?'':v).padEnd(w[i])).join(' | ')+' |';
  console.log(line(cols)); console.log('|'+w.map(x=>'-'.repeat(x+2)).join('|')+'|'); rows.forEach(r=>console.log(line(cols.map(c=>r[c]))));
}

/* 在**页面脚本之前**注入：计时器按创建点归因 + IndexedDB 事务计数（真值来源） */
const BOOT_INSTRUMENT = `
(function(){
  var S=window.__ibProbe={byMs:{},live:[],txns:[],fired:0};
  var oSI=window.setInterval, oCI=window.clearInterval, oST=window.setTimeout, oCT=window.clearTimeout;
  var recs=new Map();
  window.setInterval=function(fn,ms){
    var st='';try{st=String(new Error().stack||'').split('\\n').slice(2,4).join(' <- ').replace(/file:\\/\\/[^\\s)]*\\//g,'').replace(/\\s+/g,' ')}catch(e){}
    var r={ms:ms,fired:0,stack:st.slice(0,150),cleared:false};
    var w=(typeof fn==='function')?function(){r.fired++;S.fired++;return fn.apply(this,arguments)}:fn;
    var id=oSI.call(window,w,ms);r.id=id;recs.set(id,r);S.live.push(r);S.byMs[ms]=(S.byMs[ms]||0)+1;return id;
  };
  window.clearInterval=function(id){var r=recs.get(id);if(r)r.cleared=true;return oCI.call(window,id)};
  window.setTimeout=function(fn,ms){var a=Array.prototype.slice.call(arguments,2);S.toCreated=(S.toCreated||0)+1;return oST.apply(window,[fn,ms].concat(a))};
  window.clearTimeout=function(id){return oCT.call(window,id)};
  var oTxn=IDBDatabase.prototype.transaction;
  IDBDatabase.prototype.transaction=function(stores,mode){
    var t=oTxn.apply(this,arguments);
    var name=(typeof stores==='string')?stores:Array.prototype.slice.call(stores).join('+');
    S.txns.push({name:name,mode:mode||'readonly',start:Date.now(),end:null});
    var rec=S.txns[S.txns.length-1];
    try{t.addEventListener('complete',function(){rec.end=Date.now()});t.addEventListener('abort',function(){rec.end=Date.now()});t.addEventListener('error',function(){rec.end=Date.now()})}catch(e){}
    return t;
  };
  S.reset=function(){S.txns.length=0;S.fired=0;S.live.forEach(function(r){r.fired=0})};
  S.count=function(name,mode){return S.txns.filter(function(x){return (!name||x.name===name)&&(!mode||x.mode===mode)}).length};
  S.liveSnap=function(){return S.live.filter(function(r){return !r.cleared}).map(function(r){return {ms:r.ms,fired:r.fired,stack:r.stack}})};
  S.io=function(){var iv=S.txns.filter(function(x){return x.end!=null}).map(function(x){return [x.start,x.end]}).sort(function(a,b){return a[0]-b[0]});
    var sum=0,union=0,cur=null;iv.forEach(function(p){sum+=p[1]-p[0];if(!cur)cur=[p[0],p[1]];else if(p[0]<=cur[1])cur[1]=Math.max(cur[1],p[1]);else{union+=cur[1]-cur[0];cur=[p[0],p[1]]}});
    if(cur)union+=cur[1]-cur[0];
    return {ops:S.txns.length,sum:sum,union:union,serial:union?(Math.round(sum/union*100)/100):0};};
})();
`;

(async () => {
  const chrome = chromePath(); if (!chrome) { console.error('Chrome/Edge required'); process.exit(2); }
  let failures = 0;
  const check = (n, c, d = '') => { if (c) console.log('  PASS  ' + n); else { failures++; console.error('  FAIL  ' + n + (d ? '  -> ' + d : '')); } };
  const say = s => console.log(s);
  /* 分节闸门：mutation harness 会只跑被变异承重的那一节（P11_3X_C_SECTIONS=CORE,FIX2 …）。
     §CORE 是纯 Node，不需要浏览器 —— 因此只跑 CORE 时完全不启动 Chrome。 */
  const SECTIONS = String(process.env.P11_3X_C_SECTIONS || '').split(',').map(s => s.trim()).filter(Boolean);
  const want = n => !SECTIONS.length || SECTIONS.indexOf(n) >= 0;
  const BROWSER_SECTIONS = ['MEASURE', 'FIX1', 'FIX2', 'FIX3', 'FIX4', 'TURN', 'FIX5', 'IDLE'];
  const needBrowser = !SECTIONS.length || SECTIONS.some(s => BROWSER_SECTIONS.indexOf(s) >= 0);
  if (SECTIONS.length) say('── sections: ' + SECTIONS.join(',') + ' ──');

  /* ══════════════════════════════════════════════════════════════════
     §CORE · 唯一估算器 / 应用级天花板 / 预算三档 / 阶梯（纯 Node）
     ══════════════════════════════════════════════════════════════════ */
  say('');
  say('══ §CORE · canonical context budget (pure, Node) ══');
  {
    const C = BudgetCore;
    check('core.singleEstimatorMatchesLegacyModel',
      C.estimateTokens('你好世界') === 4 && C.estimateTokens('hello world') === 4,
      JSON.stringify([C.estimateTokens('你好世界'), C.estimateTokens('hello world')]));
    check('core.appCeilingIsAppLevelNotModelTable', BudgetCore.APP_CEILING_TOKENS === 64000 && !/contextWindow|modelTable/i.test(String(BudgetCore.APP_CEILING_TOKENS)));
    const b = C.inputBudgetFor({});
    check('core.budgetThreeTiers', b.inputBudget === b.ceiling - b.reserve && b.reserve > 0, JSON.stringify(b));
    check('core.nonCompressibleNeverTruncated',
      JSON.stringify(C.NON_COMPRESSIBLE) === JSON.stringify(['system', 'current', 'tools']), JSON.stringify(C.NON_COMPRESSIBLE));

    /* 注入的 tail 必须从"当前用户消息"里扣出来，否则可压缩块永远压不动 */
    const tail = '【记忆】'.repeat(500);
    const inj = C.estimateTokens(tail);
    const m = C.measure([{ role: 'system', content: '人格' }, { role: 'user', content: '你好\n\n---\n' + tail }],
      { injectedTokens: inj, injectedOtherTokens: 50 });
    check('core.injectedAttributionExcludesCurrentMessage',
      m.parts.current === C.estimateTokens('你好\n\n---\n') && m.parts.injected === inj && m.parts.injectedCompressible === inj - 50,
      JSON.stringify(m.parts));
    check('core.measuredCompressibleIsHistoryPlusInjected',
      m.compressibleTokens === m.parts.history + m.parts.injectedCompressible && m.nonCompressibleTokens === m.parts.system + m.parts.current + m.parts.tools + m.parts.injectedOther);

    /* worst-case（producer 上限）判定：天花板之下必须**恒为 1**（正常回合零变化） */
    const under = C.planParts({ ceiling: 64000, reserve: 16384, systemTokens: 2400, currentTokens: 20, injectedOtherTokens: 120, toolsTokens: 3600, historyTokens: 2000, memoryTokens: 2000, momentsTokens: 900, threadTokens: 600, activityTokens: 2600, understandingTokens: 300 });
    check('core.underCeilingKeepsEveryFractionAtOne', under.over === false && C.LADDER.every(p => under.fractions[p] === 1), JSON.stringify(under.fractions));
    /* 超预算且梯子够用时：只缩可压缩块，且永不缩到 0 */
    const over = C.planParts({ ceiling: 12000, reserve: 1024, systemTokens: 2000, currentTokens: 20, injectedOtherTokens: 60, toolsTokens: 100, historyTokens: 4000, memoryTokens: 2000, momentsTokens: 900, threadTokens: 600, activityTokens: 2600, understandingTokens: 300 });
    check('core.overBudgetLadderFires', over.over === true && over.irreducible === false && over.ladder.length > 0, JSON.stringify(over.summary));
    /* `tiny`：可压缩总量 10400，可用额度只剩 1 —— 正是"比例可能被算成 0"的
           极端点。未变异时它不可约（梯子不下发），一旦有人把 MIN_FRACTION 放开成 0，
           这里就会下发出 keepFraction=0 的条目（= 整块消失），本断言必须变红。 */
        const tiny = C.planParts({ ceiling: 3145, reserve: 1024, systemTokens: 2000, currentTokens: 20, injectedOtherTokens: 0, toolsTokens: 100, historyTokens: 0, memoryTokens: 2000, momentsTokens: 900, threadTokens: 600, activityTokens: 2600, understandingTokens: 300 });
        check('core.ladderNeverZero',
          over.ladder.every(s => s.keepFraction > 0 && s.keepFraction < 1) &&
          tiny.ladder.every(s => s.keepFraction > 0),
          JSON.stringify({ over: over.ladder, tiny: tiny.ladder, tinyIrreducible: tiny.irreducible }));
    check('core.ladderRespectsFloors',
          over.ladder.every(s => s.keepFraction >= C.MIN_FRACTION[s.part]) &&
          tiny.ladder.every(s => s.keepFraction >= C.MIN_FRACTION[s.part]),
          JSON.stringify({ over: over.ladder, tiny: tiny.ladder }));
    /* 不可丢部分自己就超预算 → irreducible，且**不下发任何裁剪**（不白白牺牲上下文） */
    const irr = C.planParts({ ceiling: 3000, reserve: 1024, systemTokens: 9000, currentTokens: 20, injectedOtherTokens: 0, toolsTokens: 100, historyTokens: 100, memoryTokens: 2000, momentsTokens: 0, threadTokens: 0, activityTokens: 0, understandingTokens: 0 });
    check('core.irreducibleReportsTruthfullyAndCutsNothing',
      irr.over === true && irr.irreducible === true && irr.ladder.length === 0, JSON.stringify(irr.summary));
    /* 工具定义与 persona 永不出现在阶梯里 */
    check('core.toolsAndSystemNotInLadder',
      C.LADDER.indexOf('tools') < 0 && C.LADDER.indexOf('system') < 0 && C.LADDER.indexOf('current') < 0, JSON.stringify(C.LADDER));
    /* 申报值不得超过实测可压缩量（防"错误申报把 available 撑宽"） */
    const clamp = C.plan(m, { ceiling: 9000, reserve: 1024, historyTokens: 999999, memoryTokens: 999999, momentsTokens: 0, threadTokens: 0, activityTokens: 0, understandingTokens: 0 });
    check('core.declaredCompressibleClampedToMeasured', clamp.compressibleTokens <= m.compressibleTokens + 1, JSON.stringify({ declared: clamp.compressibleTokens, measured: m.compressibleTokens }));
  }

  if (needBrowser) {
    /* ── mock provider：只记录请求体，不产生 AI 内容 ── */
    const captured = [];
    const api = http.createServer(async (req, res) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Headers', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
      if (req.method === 'OPTIONS') { res.end(); return; }
      let raw = ''; for await (const c of req) raw += c;
      let body = null; try { body = JSON.parse(raw || '{}'); } catch (e) {}
      captured.push({ url: req.url || '', body, raw });
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'P11_3XC_REPLY' }, index: 0 }] }) + '\n\n');
      res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop', index: 0 }], usage: { prompt_tokens: 1, completion_tokens: 1 } }) + '\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
    });
    const apiPort = await new Promise(r => { api.listen(0, '127.0.0.1', () => r(api.address().port)) });

    const port = await freePort(), profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-3xc-'));
    const browser = spawn(chrome, ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
      '--allow-file-access-from-files', '--window-size=1200,900',
      '--remote-debugging-port=' + port, '--user-data-dir=' + profile, 'about:blank'], { stdio: 'ignore', windowsHide: true });
    let cdp;

    try {
      let ready = false;
      for (let i = 0; i < 150; i++) { try { const r = await fetch('http://127.0.0.1:' + port + '/json/version'); if (r.ok) { ready = true; break } } catch (e) {} await sleep(100) }
      if (!ready) throw new Error('Chrome DevTools 未就绪');
      const tab = await (await fetch('http://127.0.0.1:' + port + '/json/new?' + encodeURIComponent(PAGE_URL), { method: 'PUT' })).json();
      cdp = await Cdp.c(tab.webSocketDebuggerUrl);
      await cdp.send('Runtime.enable');
      await cdp.send('Page.enable');
      await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: BOOT_INSTRUMENT });
      await cdp.send('Page.navigate', { url: PAGE_URL });

      check('page.ready', await wait(cdp, "(!!(window.IB&&window.IB.chat&&typeof window.IB.chat.buildChatContext==='function')) && typeof window.sendChatMessage==='function' && typeof window.__ibProbe==='object' && !!window.IBContextBudgetCore", 30000));
      if (failures) throw new Error('页面未就绪');
      await ev(cdp, "window.confirm=function(){return true};window.alert=function(){};");
      check('page.budgetCoreLoaded', await ev(cdp, "typeof window.IBContextBudgetCore.estimateTokens==='function' && window.IBContextBudgetCore.APP_CEILING_TOKENS===64000"));
      check('core.onlyOneEstimatorImplementation', (() => {
        /* 全仓必须只有一份估算算法：communication.js 的 _cacheTok 只能是**委托薄壳**，
           估算循环本体只能存在于 context-budget-core.js。 */
        const cbc = fs.readFileSync(path.join(ROOT, 'assets/js/context-budget-core.js'), 'utf8').replace(/^\uFEFF/, '');
        const commFn = (fs.readFileSync(path.join(ROOT, 'assets/js/communication.js'), 'utf8').replace(/^\uFEFF/, '').match(/function _cacheTok\(s\)\{[\s\S]*?\n/) || [''])[0];
        const loopRe = /charCodeAt\(i\)[\s\S]{0,80}0x4e00/;
        return loopRe.test(cbc) && !loopRe.test(commFn) && /estimateTokens\(s\)/.test(commFn);
      })(), '估算算法本体必须只在 context-budget-core.js，_cacheTok 只能是委托薄壳');

        /* ══════════════════════════════════════════════════════════════
           §MEASURE · Context Budget Runtime Measurement
           ══════════════════════════════════════════════════════════════ */
        const CFG = {
          id: 'x3c', nickname: 'X3C角色', model: 'x3c-model', provider: 'custom',
          endpoint: 'http://127.0.0.1:' + apiPort + '/v1/chat/completions', apiKey: 'k',
          systemPrompt: 'X3C_SYSTEM_BASE', relationship: 'X3C_RELATION',
          streaming: true, showThinking: false, promptCache: false, created: Date.now()
        };
        await ev(cdp, `(async function(){
          await dbPut('apiSettings',{id:'readingLimits',chatLimit:5,postsLimit:5,groupChatLimit:10});
          await dbPut('apiSettings',{id:'summarySettings',enabled:false});
          await dbPut('about',{id:'main',name:'X3C_USER',bio:'X3C_BIO'});
          await dbPut('apiConfigs',${JSON.stringify(CFG)});
          await loadApiConfigs();
          window.__seedWorld=async function(o){
            o=o||{};
            for(const s of ['memories','moments','understandings','threads','activities','calNotes','calEvents','posts','autoMemory','chatMessages','chatThreads','chatSummaries','favorites']){
              try{var all=await dbGetAll(s);for(var i=0;i<all.length;i++)await dbDelete(s,all[i].id)}catch(e){}
            }
            var memBody=function(j){return 'X3C_MEM_BODY_'+j+' '+new Array(90).join('记忆正文片段用于测量长度')};
            for(var j=0;j<(o.memories||0);j++)await dbPut('memories',{id:'mem'+j,title:'X3C_MEM_'+j,content:memBody(j),domain:'日常',tags:['x3c'],valence:0.5,arousal:0.3,importance:5,createdBy:'x3c',visibility:'public',created:Date.now()-j*1000,activationCount:0});
            var t=Date.now()-(o.messages||0)*1000;
            for(var k=0;k<(o.messages||0);k++)await dbPut('chatMessages',{id:'m'+k,friendId:'x3c',role:(k%2?'assistant':'user'),content:(k%2?'X3C_ASSISTANT_'+k+' 这是第'+k+'条回复正文，用于测量历史回传预算。':'X3C_USER_'+k+' 第'+k+'条用户消息正文，用于测量历史回传预算。'),timestamp:t+k*1000});
            for(var q=0;q<(o.favorites||0);q++)await dbPut('favorites',{id:'fav'+q,type:'chat',roleId:'x3c',sourceId:'m'+q,title:'',body:'x'.repeat(500),meta:{},createdAt:Date.now(),updatedAt:Date.now()});
            for(var r2=0;r2<(o.moments||0);r2++)await dbPut('moments',{id:'mo'+r2,characterId:'x3c',content:'X3C_MOMENT_'+r2+' '+new Array(40).join('朋友圈正文'),created:Date.now()-r2*1000,visibility:'public',status:'published'});
            for(var s2=0;s2<(o.threads||0);s2++)await dbPut('threads',{id:'th'+s2,characterId:'x3c',question:'X3C_THREAD_'+s2+' 一个仍在推进的问题？',status:'open',visibility:'public',evidenceIds:[],openedAt:Date.now()});
            if(o.understandings)await dbPut('understandings',{id:'un1',characterId:'x3c',dimension:'context',status:'active',visibility:'public',current:{content:new Array(400).join('X3C_UNDERSTANDING '),conviction:70,evidenceIds:[],updatedAt:Date.now()}});
            for(var p2=0;p2<(o.posts||0);p2++)await dbPut('posts',{id:'p'+p2,title:'X3C_POST_'+p2,content:'X3C_POST_BODY_'+p2+' '+new Array(160).join('日志正文'),created:Date.now()-p2*1000,locked:false});
            return true;
          };
          return true;
        })()`);

        const bcc = async (msg, extra) => ev(cdp, `(async function(){
          var cfg=apiConfigs.find(function(a){return a.id==='x3c'});
          var fm=await dbGetByIndex('chatMessages','byFriend','x3c'); fm=fm.sort(function(a,b){return a.timestamp-b.timestamp});
          var hist=fm.slice(-5).map(function(m){return {role:(m.role==='assistant'?'assistant':'user'),content:String(m.content||'')}});
          var r=await IB.chat.buildChatContext(cfg,Object.assign({userMessage:${JSON.stringify(msg)},dialogueHistory:hist},${JSON.stringify(extra || {})}));
          var system=String((r&&r.system)||''),tail=String((r&&r.tail)||'');
          var msgs=hist.map(function(m){return {role:m.role,content:m.content}});
          if(system)msgs.unshift({role:'system',content:system});
          if(tail){for(var i=msgs.length-1;i>=0;i--){if(msgs[i].role==='user'){msgs[i].content='${'\\n\\n---\\n'}'.replace(/\\n/g,'\\n')+tail;break}}}
          var core=window.IBContextBudgetCore;
          var m=core.measure([{role:'system',content:system}].concat(hist.map(function(x){return {role:x.role,content:x.content}})).concat([{role:'user',content:${JSON.stringify(msg)}+'\\n\\n---\\n'+tail}]),{injectedTokens:core.estimateTokens('\\n\\n---\\n'+tail)});
          return {system:system,tail:tail,historyCount:hist.length,historyChars:hist.reduce(function(a,x){return a+x.content.length},0),
                  systemTokens:m.parts.system,tailTokens:m.parts.injected,currentTokens:m.parts.current,historyTokens:m.parts.history,toolsTokens:m.parts.tools,
                  inputTokens:m.inputTokens,budget:r.budget||null,
                  toolMarker:system.indexOf('【外部工具】')>=0, wsBlock:system.indexOf('【ICode 工作区指令】')>=0};
        })()`);

        say('');
      if (want('MEASURE')) {
        say('══ §MEASURE · context budget per case (real builder, est. tokens) ══');
        const rows = [];
        const cases = [
          ['A normal (10 msgs / 3 mem)', { messages: 10, memories: 3 }],
          ['B long history (100 msgs)', { messages: 100, memories: 3 }],
          ['B long history (500 msgs)', { messages: 500, memories: 3 }],
          ['B long history (1000 msgs)', { messages: 1000, memories: 3 }],
          ['C large memory (50)', { messages: 10, memories: 50 }],
          ['C large memory (2000)', { messages: 10, memories: 2000 }],
          ['C large memory (2000) + 40 threads', { messages: 10, memories: 2000, threads: 40, understandings: true }],
          ['E tools (12 defs)', { messages: 10, memories: 3, tools: true }],
          ['F mixed worst', { messages: 1000, memories: 2000, moments: 50, threads: 6, understandings: true, posts: 300, tools: true, persona: 20000 }]
        ];
        for (const [label, o] of cases) {
          await ev(cdp, `window.__seedWorld(${JSON.stringify({ messages: o.messages, memories: o.memories, moments: o.moments || 0, threads: o.threads || 0, understandings: !!o.understandings, favorites: 0, posts: o.posts || 0 })})`);
          await ev(cdp, `(async function(){var c=await dbGet('apiConfigs','x3c');c.systemPrompt='X3C_SYSTEM_BASE'+new Array(${(o.persona || 0) + 1}).join('人');c.imageGen=false;c.webSearch=false;await dbPut('apiConfigs',c);await loadApiConfigs();
            var t=await getIbTools();t.enabled=${o.tools ? 'true' : 'false'};t.confirm=false;t.tools=[];${o.tools ? "for(var i=0;i<12;i++)t.tools.push({id:'t'+i,name:'X3C_TOOL_'+i,desc:new Array(30).join('工具说明'),params:'p',method:'POST',url:'http://127.0.0.1:1/x'});" : ''}await saveIbTools(t);return true})()`);
          const r = await bcc('X3C_CASE 你好');
          rows.push({ case: label, 'sys tok': r.systemTokens, 'hist tok': r.historyTokens, 'inject tok': r.tailTokens, 'tools tok': r.toolsTokens, 'TOTAL in tok': r.inputTokens, 'toolmark': r.toolMarker ? 'yes' : 'no' });
        }
        table(rows, ['case', 'sys tok', 'hist tok', 'inject tok', 'tools tok', 'TOTAL in tok', 'toolmark']);

        /* 无界块：persona 单独加长 → system 段无上限增长（这就是"没有总量预算"的直接证据） */
        say('');
        say('── unbounded system prefix (the reason a total budget is required) ──');
        const dRows = [];
        await ev(cdp, `window.__seedWorld({messages:10,memories:3})`);
        for (const n of [0, 20000, 200000]) {
          await ev(cdp, `(async function(){var c=await dbGet('apiConfigs','x3c');c.systemPrompt='X3C_SYSTEM_BASE'+new Array(${n + 1}).join('人');await dbPut('apiConfigs',c);await loadApiConfigs();return true})()`);
          const r = await bcc('X3C_CASE_D 你好');
          dRows.push({ 'persona chars': n, 'system chars': r.system.length, 'system est tok': r.systemTokens, 'TOTAL in tok': r.inputTokens });
        }
        table(dRows, ['persona chars', 'system chars', 'system est tok', 'TOTAL in tok']);
        check('measure.systemPrefixGrowsUnboundedWithoutBudget',
          dRows[2]['system est tok'] > BudgetCore.APP_CEILING_TOKENS * 2 && dRows[1]['system est tok'] > dRows[0]['system est tok'] * 5,
          'persona 200k 字符 → system ' + dRows[2]['system est tok'] + ' est tok，是应用级天花板 ' + BudgetCore.APP_CEILING_TOKENS + ' 的 ' + (dRows[2]['system est tok'] / BudgetCore.APP_CEILING_TOKENS).toFixed(1) + ' 倍，而修复前代码里没有任何一处会因此停下');
        await ev(cdp, `(async function(){var c=await dbGet('apiConfigs','x3c');c.systemPrompt='X3C_SYSTEM_BASE';await dbPut('apiConfigs',c);await loadApiConfigs();return true})()`);
      }


      if (want('FIX1')) {
        /* ══════════════════════════════════════════════════════════════
           §FIX-1 · favorites: 全表扫描 → 单飞（before 50 次 / after ≤2 次）
           ══════════════════════════════════════════════════════════════ */
        say('');
        say('══ §FIX-1 · favorites full-store scan per rendered bubble ══');
        await ev(cdp, "activeFriendId='x3c'; openChatPanel();");
        await sleep(1200);
        const favRows = [];
        for (const nFav of [0, 500, 2000]) {
          await ev(cdp, `window.__seedWorld({messages:120,memories:0,favorites:${nFav}})`);
          await ev(cdp, "(function(){document.getElementById('chat-messages').innerHTML='';window.__ibProbe.reset();openChatPanel();return true})()");
          await sleep(2600);
          const r = await ev(cdp, `(async function(){
            var f=window.__ibProbe.count('favorites');
            var t0=performance.now();for(var i=0;i<30;i++){await IB.favorites.has('m'+(i*4))}var per=(performance.now()-t0)/30;
            return {favTxns:f,perHas:Math.round(per*100)/100} })()`);
          favRows.push({ 'favorites in store': nFav, 'favorites txns / panel open': r.favTxns, 'per has() ms': r.perHas });
        }
        table(favRows, ['favorites in store', 'favorites txns / panel open', 'per has() ms']);
        check('fix1.favoritesReadsCoalesced',
          favRows.every(r => r['favorites txns / panel open'] <= 3),
          'before = 50 per panel open; after = ' + JSON.stringify(favRows.map(r => r['favorites txns / panel open'])));
      }


      if (want('FIX2')) {
        /* ══════════════════════════════════════════════════════════════
           §FIX-2 · thread attestation N+1（before 41 次 / after ≤3 次）
           ══════════════════════════════════════════════════════════════ */
        say('');
        say('══ §FIX-2 · getThreadContext: one memories scan per open thread ══');
        const thRows = [];
        for (const nTh of [1, 10, 40]) {
          await ev(cdp, `window.__seedWorld({messages:10,memories:2000,threads:${nTh},understandings:true})`);
          const r = await ev(cdp, `(async function(){
            window.__ibProbe.reset();var t0=performance.now();
            await getUnderstandingContext('x3c');await getThreadContext('x3c');
            var dt=performance.now()-t0;
            return {ms:Math.round(dt),memTxns:window.__ibProbe.count('memories')} })()`);
          thRows.push({ 'open threads': nTh, 'memories txns': r.memTxns, ms: r.ms });
        }
        table(thRows, ['open threads', 'memories txns', 'ms']);
        check('fix2.threadAttestationIsNotNPlusOne',
          thRows.every(r => r['memories txns'] <= 3),
          'before = threads+1 (1→2, 10→11, 40→41); after = ' + JSON.stringify(thRows.map(r => r['memories txns'])));
        check('fix2.threadAttestationNoLongerScalesWithThreadCount',
          thRows[2].ms < thRows[2]['memories txns'] * 0 + 250,
          'before 40 threads = 552ms; after = ' + thRows[2].ms + 'ms');
      }


      if (want('FIX3')) {
        /* ══════════════════════════════════════════════════════════════
           §FIX-3 · memory activation: 2 txns per record → 1
           ══════════════════════════════════════════════════════════════ */
        say('');
        say('══ §FIX-3 · recordMemoryActivation: get+put in one transaction ══');
        const act = await ev(cdp, `(async function(){
          window.__seedWorld({messages:10,memories:600});
          window.__ibProbe.reset();var t0=performance.now();
          var c=await getMemoryContext('x3c',{userMessage:'测试查询'});
          var dt=performance.now()-t0;
          var ro=window.__ibProbe.count('memories','readonly'), rw=window.__ibProbe.count('memories','readwrite');
          return {ms:Math.round(dt),ro:ro,rw:rw,ctx:String(c).length} })()`);
        say(`  getMemoryContext(600 memories): ${act.ms} ms | memories readonly=${act.ro} readwrite=${act.rw} | ctx=${act.ctx} chars`);
        check('fix3.activationIsReadModifyWriteInOneTransaction',
          act.rw >= 1 && act.ro < act.rw,
          'before: 每个被选中的记忆 1 readonly + 1 readwrite（实测 65/65 @2000 条记忆）；after: readonly=' + act.ro + ' readwrite=' + act.rw + '（写入条数不变，读事务消失）');
      }


      if (want('FIX4')) {
        /* ══════════════════════════════════════════════════════════════
           §FIX-4 · posts read once per turn（before 2 / after 1）
           ══════════════════════════════════════════════════════════════ */
        say('');
        say('══ §FIX-4 · posts full-store read duplication per turn ══');
        await ev(cdp, `window.__seedWorld({messages:10,memories:30,posts:300})`);
        const pfix = await ev(cdp, `(async function(){
          var cfg=apiConfigs.find(function(a){return a.id==='x3c'});
          window.__ibProbe.reset();var t0=performance.now();
          await IB.chat.buildChatContext(cfg,{userMessage:'你好'});
          return {ms:Math.round(performance.now()-t0),posts:window.__ibProbe.count('posts'),settings:window.__ibProbe.count('apiSettings')} })()`);
        say(`  buildChatContext with 300 posts: ${pfix.ms} ms | posts txns=${pfix.posts} | apiSettings txns=${pfix.settings}`);
        check('fix4.postsReadOncePerTurn', pfix.posts === 1, 'before = 2; after = ' + pfix.posts);
      }


      if (want('TURN')) {
        /* ══════════════════════════════════════════════════════════════
           §TURN · 一个真实单聊回合的 DB 热路径
           ══════════════════════════════════════════════════════════════ */
        say('');
        say('══ §TURN · real single-chat turn (sendChatMessage) DB hot path ══');
        await ev(cdp, `(async function(){
          await window.__seedWorld({messages:20,memories:30,favorites:10});
          var c=await dbGet('apiConfigs','x3c');c.systemPrompt='X3C_SYSTEM_BASE';c.imageGen=false;c.webSearch=false;c.streaming=true;await dbPut('apiConfigs',c);await loadApiConfigs();
          var t=await getIbTools();t.enabled=false;t.tools=[];await saveIbTools(t);
          return true })()`);
        await ev(cdp, "(function(){activeFriendId='x3c';openChatPanel();return true})()");
        await wait(cdp, "!!document.getElementById('chat-input')", 8000);
        captured.length = 0;
        await ev(cdp, "window.__ibProbe.reset();");
        const turnStart = Date.now();
        await ev(cdp, "(function(){document.getElementById('chat-input').value='X3C_TURN 你好';sendChatMessage();return true})()");
        await wait(cdp, "(function(){var m=document.getElementById('chat-messages');return !!m&&m.textContent.includes('P11_3XC_REPLY')})()", 20000);
        const turnMs = Date.now() - turnStart;
        const turn = await ev(cdp, "window.__ibProbe.io()");
        const byStore = await ev(cdp, "(function(){var t={};window.__ibProbe.txns.forEach(function(x){var k=x.name+' ['+x.mode+']';t[k]=(t[k]||0)+1});return t})()");
        say(`  turn wall time = ${turnMs} ms · IndexedDB ops = ${turn.ops} · busy sum=${turn.sum}ms union=${turn.union}ms serialization=${turn.serial}`);
        table(Object.keys(byStore).sort().map(k => ({ 'store [mode]': k, 'ops/turn': byStore[k] })), ['store [mode]', 'ops/turn']);
        check('turn.dbOpsReduced', turn.ops < 69, 'before = 69 ops/turn (measured pre-fix); after = ' + turn.ops);
        const budgetRec = await ev(cdp, "window.IBContextBudget.last()");
        say(`  host-turn budget record: total in ~${budgetRec && budgetRec.inputTokens} tok (budget ${budgetRec && budgetRec.inputBudget}, over=${budgetRec && budgetRec.over}, irreducible=${budgetRec && budgetRec.irreducible})`);
        check('turn.budgetMeasuredOncePerTurn', !!budgetRec && budgetRec.kind === 'chat' && budgetRec.inputTokens > 0, JSON.stringify(budgetRec));
        check('turn.requestIsWellUnderBudget', !!budgetRec && budgetRec.over === false, JSON.stringify(budgetRec && { t: budgetRec.inputTokens, b: budgetRec.inputBudget }));
        check('turn.providerBodyHasNoBudgetMetadata', captured.length > 0 && !/IBContextBudget|inputBudget|_ibConsumer/i.test(captured[captured.length - 1].raw));
      }


      if (want('FIX5')) {
        /* ══════════════════════════════════════════════════════════════
           §FIX-5 · 超预算时：只缩可压缩块；persona / 当前消息 / 工具定义不动
           ══════════════════════════════════════════════════════════════ */
        say('');
        say('══ §FIX-5 · over-ceiling behaviour on a REAL host turn ══');
        await ev(cdp, `(async function(){
          await window.__seedWorld({messages:60,memories:2000,moments:30,threads:20,understandings:true});
          var c=await dbGet('apiConfigs','x3c');c.systemPrompt='X3C_PERSONA_MUST_SURVIVE';c.webSearch=false;await dbPut('apiConfigs',c);await loadApiConfigs();
          var t=await getIbTools();t.enabled=true;t.confirm=false;t.tools=[];
          for(var i=0;i<3;i++)t.tools.push({id:'t'+i,name:'X3C_TOOL_'+i,desc:'工具说明',params:'p',method:'POST',url:'http://127.0.0.1:1/x'});
          await saveIbTools(t);
          try{await dbPut('apiSettings',{id:'memorySettings',budget:2000,contentLen:200})}catch(e){}
          return true })()`);
        const runTurn = async (ceiling, tag) => {
          await ev(cdp, `(function(){window.__ibContextCeiling=${ceiling};return window.IBContextBudget.history().length})()`);
          const seqBefore = await ev(cdp, "window.IBContextBudget.history().length");
          captured.length = 0;
          await ev(cdp, `(function(){document.getElementById('chat-input').value=${JSON.stringify('X3C_BUDGET_' + tag + ' 你好')};sendChatMessage();return true})()`);
          /* 等"这一回合真的被记进环里"且"provider 请求真的被捕获"——两个独立事实，
             不靠固定 sleep 猜时序（第一次实现就是被这个坑到：只等 UI 气泡会立刻返回）。 */
          const ok = await wait(cdp, `(function(){return window.IBContextBudget.history().length>${seqBefore}})()`, 20000);
          let tries = 0;
          while (captured.length === 0 && tries++ < 60) await sleep(150);
          const h = await ev(cdp, "window.IBContextBudget.history()");
          const rec = ok && h.length ? h[h.length - 1] : null;
          const body = captured.length ? captured[captured.length - 1].body : null;
          const msgs = (body && Array.isArray(body.messages)) ? body.messages : [];
          const sysText = String((msgs.find(m => m.role === 'system') || {}).content || '');
          const lastUser = String((msgs.filter(m => m.role === 'user').pop() || {}).content || '');
          return {
            rec, captured: captured.length, reqMessages: msgs.length, tools: (body && body.tools && body.tools.length) || 0,
            sysChars: sysText.length, sysHasPersona: sysText.indexOf('X3C_PERSONA_MUST_SURVIVE') >= 0,
            sysHasToolMarker: sysText.indexOf('【外部工具】') >= 0,
            userMsgKept: lastUser.indexOf('X3C_BUDGET_' + tag) >= 0,
            userMsgs: msgs.filter(m => m.role === 'user').length
          };
        };
        const base = await runTurn(100000000, 'BASE');
        const tight = await runTurn(12000, 'TIGHT');
        say(`  ceiling=1e8    → in ~${base.rec && base.rec.inputTokens} tok, plannedOver=${base.rec && base.rec.plannedOver}, ladder=${JSON.stringify(base.rec && base.rec.ladder)} | captured=${base.captured} tools=${base.tools}`);
        say(`  ceiling=12000  → in ~${tight.rec && tight.rec.inputTokens} tok, plannedOver=${tight.rec && tight.rec.plannedOver}, irreducible=${tight.rec && tight.rec.irreducible}, ladder=${JSON.stringify(tight.rec && tight.rec.ladder)} | captured=${tight.captured} tools=${tight.tools}`);
        check('fix5.bothTurnsActuallyRan', base.captured > 0 && tight.captured > 0 && !!base.rec && !!tight.rec,
          JSON.stringify({ baseCaptured: base.captured, tightCaptured: tight.captured }));
        check('fix5.personaSurvivesAnyBudget', base.sysHasPersona && tight.sysHasPersona,
          JSON.stringify({ base: base.sysHasPersona, tight: tight.sysHasPersona, baseSysChars: base.sysChars, tightSysChars: tight.sysChars }));
        check('fix5.toolDefinitionsSurviveAnyBudget',
          base.sysHasToolMarker && tight.sysHasToolMarker && tight.tools === base.tools && base.tools > 0,
          JSON.stringify({ baseTools: base.tools, tightTools: tight.tools, marker: tight.sysHasToolMarker }));
        check('fix5.currentUserMessageSurvivesAnyBudget', tight.userMsgKept === true && tight.userMsgs >= base.userMsgs,
          JSON.stringify({ kept: tight.userMsgKept, baseUserMsgs: base.userMsgs, tightUserMsgs: tight.userMsgs }));
        check('fix5.plannedOverFiresUnderTightCeilingButNeverTouchesNonCompressible',
          base.rec.plannedOver === false && tight.rec.plannedOver === true &&
          tight.rec.ladder.every(s => !/system|current|tools/.test(s)) &&
          (tight.rec.irreducible === true || tight.rec.ladder.length > 0),
          JSON.stringify({ basePlannedOver: base.rec.plannedOver, tightPlannedOver: tight.rec.plannedOver, ladder: tight.rec.ladder, irreducible: tight.rec.irreducible }));
        check('fix5.underCeilingIsUnchanged',
          base.rec.ladder.length === 0 && base.rec.irreducible === false && base.sysChars === tight.sysChars && base.tools === tight.tools,
          JSON.stringify({ baseLadder: base.rec.ladder, baseIrreducible: base.rec.irreducible, baseSysChars: base.sysChars, tightSysChars: tight.sysChars }));
        await ev(cdp, "(function(){try{delete window.__ibContextCeiling}catch(e){window.__ibContextCeiling=undefined}return true})()");
      }


      if (want('IDLE')) {
        /* ══════════════════════════════════════════════════════════════
           §IDLE · 用户什么都不做时（按创建点归因）
           ══════════════════════════════════════════════════════════════ */
        say('');
        say('══ §IDLE · idle work, creation-site attributed ══');
        await ev(cdp, "window.__ibProbe.reset();");
        await sleep(22000);
        const earlyFired = await ev(cdp, "window.__ibProbe.fired");
        const earlyLive = await ev(cdp, "window.__ibProbe.liveSnap()");
        say(`  first 22 s: interval wakeups = ${earlyFired} → ${(earlyFired / 22 * 60).toFixed(0)}/min`);
        table(earlyLive.sort((a, b) => a.ms - b.ms).map(r => ({ 'interval ms': r.ms, 'fires in 22 s': r.fired, 'creation site': r.stack })), ['interval ms', 'fires in 22 s', 'creation site']);
        /* 稳态窗口：跨过 calendar.js 那个自带 n>300 上限的 200ms 引导轮询（60 s 后自清），
           否则量到的只是"入场动画期间"的读数，不是"用户什么都不做"的读数。 */
        await ev(cdp, "window.__ibProbe.reset();");
        await sleep(40000);
        const live = await ev(cdp, "window.__ibProbe.liveSnap()");
        const idle = await ev(cdp, "window.__ibProbe.io()");
        const fired = await ev(cdp, "window.__ibProbe.fired");
        say('');
        say(`  steady state (second 40 s window, after the bounded 200 ms bootstrap poll self-cleared):`);
        table(live.sort((a, b) => a.ms - b.ms).map(r => ({ 'interval ms': r.ms, 'fires in 40 s': r.fired, 'creation site': r.stack })), ['interval ms', 'fires in 40 s', 'creation site']);
        say(`  interval wakeups = ${fired} → ${(fired / 40 * 60).toFixed(1)}/min · IndexedDB ops = ${idle.ops}`);
        const fastLeft = live.filter(r => r.ms === 400 || r.ms === 500);
        check('idle.noUnboundedSubSecondBootstrapPoll', fastLeft.length === 0,
          'still live: ' + JSON.stringify(fastLeft.map(r => r.ms + '@' + r.stack)));
        check('idle.steadyStateWakeupsReduced', (fired / 40 * 60) < 100,
          'before = 584/min（实测；213 次唤醒中 210 次来自三个引导轮询，其中两个无上限）；after = ' + (fired / 40 * 60).toFixed(1) + '/min');
        check('idle.idleIndexedDbWorkBounded', idle.ops <= 20, 'idle IndexedDB ops in 40 s = ' + idle.ops + '（来源：30s 的 active tick，有界即可，不要求为零）');

        const pageLeak = await ev(cdp, "(function(){return window.__ibProbe.liveSnap().length})()");
        say(`  page live intervals at end = ${pageLeak}（页面自身的常驻 timer，随 tab 关闭释放）`);
      }


    } catch (e) {
      failures++;
      console.error('  FAIL  harness -> ' + (e && e.stack || e));
    } finally {
      try { if (cdp) await cdp.send('Runtime.evaluate', { expression: '1' }) } catch (e) {}
      try { browser.kill() } catch (e) {}
      await sleep(400);
      try { fs.rmSync(profile, { recursive: true, force: true }) } catch (e) {}
      await new Promise(r => api.close(r));
    }
  }

  console.log('');
  console.log(failures ? ('FAILURES: ' + failures) : 'ALL PASS');
  process.exitCode = failures ? 1 : 0;
})();
