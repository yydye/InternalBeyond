/* ====================================================================
   Understanding + Thread v1 · Commit 3 · Generation
   覆盖：_understandingTick 独立生成的 understanding（mock LLM）→ 不建 semantic /
        _threadRuleTick 规则触发 thread（零 LLM）/
        semantic consolidation 主链保持原样（不含 understanding/thread 字段）/
        水位线节流 / fail-open。
   只测 domain；不改生产代码。运行：node test_understanding_generation.js
   ==================================================================== */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http'), net = require('net'), crypto = require('crypto');
const { pathToFileURL } = require('url');
const PAGE_URL = pathToFileURL(path.join(__dirname, 'InternalBeyond.html')).href;
function chromePath(){ if(process.env.CHROME_PATH&&fs.existsSync(process.env.CHROME_PATH))return process.env.CHROME_PATH; for(const c of ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe','C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe','C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe','C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe']) if(fs.existsSync(c))return c; return null; }
class Cdp{constructor(s){this.s=s;this.b=Buffer.alloc(0);this.id=0;this.p=new Map();this.l=new Map();s.on('data',c=>{this.b=Buffer.concat([this.b,c]);this.parse()});s.on('error',()=>{})}static c(u){return new Promise((res,rej)=>{const url=new URL(u);const r=http.request({host:url.hostname,port:url.port,path:url.pathname+url.search,headers:{Upgrade:'websocket',Connection:'Upgrade','Sec-WebSocket-Key':crypto.randomBytes(16).toString('base64'),'Sec-WebSocket-Version':'13'}});r.on('upgrade',(res2,s)=>res(new Cdp(s)));r.on('error',rej);r.end()})}on(m,l){if(!this.l.has(m))this.l.set(m,[]);this.l.get(m).push(l)}send(m,p={}){const id=++this.id;return new Promise((res,rej)=>{this.p.set(id,{res,rej});this.t({id,method:m,params:p});setTimeout(()=>{if(this.p.has(id)){this.p.delete(id);rej(new Error('timeout '+m))}},15000)})}t(m){const p=Buffer.from(JSON.stringify(m),'utf8'),mask=crypto.randomBytes(4),b=Buffer.alloc(p.length);for(let i=0;i<p.length;i++)b[i]=p[i]^mask[i&3];let h;if(p.length<126)h=Buffer.from([0x81,0x80|p.length]);else{h=Buffer.alloc(4);h[0]=0x81;h[1]=0x80|126;h.writeUInt16BE(p.length,2)}this.s.write(Buffer.concat([h,mask,b]))}f(o,p){const mask=crypto.randomBytes(4),b=Buffer.alloc(p.length);for(let i=0;i<p.length;i++)b[i]=p[i]^mask[i&3];let h;if(p.length<126)h=Buffer.from([0x80|o,0x80|p.length]);else{h=Buffer.alloc(4);h[0]=0x80|o;h[1]=0x80|126;h.writeUInt16BE(p.length,2)}this.s.write(Buffer.concat([h,mask,b]))}parse(){for(;;){if(this.b.length<2)return;const f=this.b[0],sl=this.b[1]&0x7f;let o=2,len=sl;if(sl===126){if(this.b.length<4)return;len=this.b.readUInt16BE(2);o=4}else if(sl===127){if(this.b.length<10)return;len=this.b.readUInt32BE(6);o=10}const m=(this.b[1]&0x80)!==0;let mask=null;if(m){if(this.b.length<o+4)return;mask=this.b.subarray(o,o+4);o+=4}if(this.b.length<o+len)return;let p=this.b.subarray(o,o+len);this.b=this.b.subarray(o+len);if(mask){const d=Buffer.alloc(p.length);for(let i=0;i<p.length;i++)d[i]=p[i]^mask[i&3];p=d}const op=f&0xf;if(op===0x8){this.s.destroy();return}if(op!==0x1)continue;let msg;try{msg=JSON.parse(p.toString('utf8'))}catch(e){continue}if(msg.id&&this.p.has(msg.id)){const q=this.p.get(msg.id);this.p.delete(msg.id);if(msg.error)q.rej(new Error(JSON.stringify(msg.error)));else q.res(msg.result||{})}}}close(){this.s.destroy()}}
async function ev(c,e){const r=await c.send('Runtime.evaluate',{expression:e,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw new Error('page exception: '+JSON.stringify(r.exceptionDetails.exception));return r.result&&r.result.value}
async function wait(c,e,t=15000){const end=Date.now()+t;while(Date.now()<end){try{if(await ev(c,e))return true}catch(err){}await new Promise(r=>setTimeout(r,120))}return false}
function freePort(){return new Promise((res,rej)=>{const s=net.createServer();s.unref();s.on('error',rej);s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(e=>e?rej(e):res(p))})})}
async function main(){
  const chrome=chromePath(); if(!chrome)throw new Error('未找到 Chrome / Edge');
  const mock={uPayload:'', server:null, port:0};
  mock.server=http.createServer((req,res)=>{const H={'Content-Type':'application/json','Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,POST,OPTIONS','Access-Control-Allow-Headers':'Content-Type,Authorization'};if(req.method==='OPTIONS'){res.writeHead(204,H);res.end();return}if(req.method==='POST'&&req.url.includes('/chat/completions')){let ch=[];req.on('data',c=>ch.push(c));req.on('end',()=>{res.writeHead(200,H);res.end(JSON.stringify({choices:[{message:{role:'assistant',content:mock.uPayload},finish_reason:'stop'}]}))});return}res.writeHead(404,H);res.end(JSON.stringify({error:'nf'}))}).listen(0,'127.0.0.1',()=>{mock.port=mock.server.address().port});
  const port=await freePort(), profile=fs.mkdtempSync(path.join(os.tmpdir(),'ib-gen-'));
  const browser=spawn(chrome,['--headless=new','--disable-gpu','--no-sandbox','--no-first-run','--allow-file-access-from-files','--force-color-profile=srgb','--window-size=800,600','--remote-debugging-address=127.0.0.1','--remote-debugging-port='+port,'--user-data-dir='+profile,'about:blank'],{stdio:'ignore'});
  let failures=0; const check=(n,c,d='')=>{if(c)console.log('  PASS  '+n);else{failures++;console.error('  FAIL  '+n+(d?'  -> '+d:''))}};
  let cdp; try{
    let ready=false;for(let i=0;i<120;i++){try{const r=await fetch('http://127.0.0.1:'+port+'/json/version');if(r.ok){ready=true;break}}catch(e){}await new Promise(r=>setTimeout(r,100))}
    check('browser.ready',ready); if(!ready)throw new Error('Chrome DevTools 未就绪');
    const tab=await (await fetch('http://127.0.0.1:'+port+'/json/new?'+encodeURIComponent(PAGE_URL),{method:'PUT'})).json();
    cdp=await Cdp.c(tab.webSocketDebuggerUrl); await cdp.send('Runtime.enable');
    check('page.ready',await wait(cdp,"typeof window._understandingTick==='function' && typeof window._threadRuleTick==='function' && typeof window._activeConsolidate==='function'",20000));
    await ev(cdp,"window.confirm=function(){return true;}");
    const ep='http://127.0.0.1:'+mock.port+'/v1/chat/completions';
    await ev(cdp,"(async function(){ await dbPut('apiConfigs',{id:'genc',nickname:'GenAI',model:'m',endpoint:'"+ep+"',apiKey:'',provider:'custom',relationship:'伙伴',systemPrompt:'你是角色。',temperature:1,streaming:false,showThinking:false,promptCache:false,created:Date.now()}); await loadApiConfigs(); })()");
    check('cfg.ready',await wait(cdp,"apiConfigs.some(a=>a.id==='genc'&&a.endpoint==='"+ep+"')",8000));
    const cfgExpr="apiConfigs.find(a=>a.id==='genc')";
    /* 准备两个碎片证据（供 understanding 引用） */
    await ev(cdp,"(async function(){ await dbPut('memories',{id:'g1',createdBy:'genc',createdByName:'GenAI',kind:'episodic',title:'想换电脑',content:'她提到想攒钱买一台新电脑来升级设备',domain:'日常',valence:0.5,arousal:0.4,importance:5,resolved:false,visibility:'public',created:Date.now(),lastActivated:Date.now()}); await dbPut('memories',{id:'g2',createdBy:'genc',createdByName:'GenAI',kind:'episodic',title:'准备换设备',content:'她的旧设备限制创作，计划升级',domain:'日常',valence:0.5,arousal:0.4,importance:5,resolved:false,visibility:'public',created:Date.now(),lastActivated:Date.now()}); })()");
    /* ① _understandingTick：mock 返回一则稳定理解（user_corroborated，证据 g1,g2） */
    mock.uPayload='{"shouldUpdate":true,"content":"她对设备瓶颈敏感，升级设备会明显提升创作信心。","basis":"user_corroborated","dimension":"context","evidenceIds":["g1","g2"],"conviction":75}';
    const tickRes=await ev(cdp,"(async function(){ var c=apiConfigs.find(a=>a.id==='genc'); try{ var res=await _understandingTick(c); return {res:res}; }catch(e){ return {err:String(e&&e.message||e)} } })()");
    check('uGen.created',!!(tickRes&&tickRes.res),JSON.stringify(tickRes));
    check('uGen.noSemantic',await ev(cdp,"(async function(){ var all=await dbGetAll('memories'); return !all.some(m=>m.kind==='semantic'&&m.createdBy==='genc'); })()"));
    check('uGen.wroteUnderstanding',await ev(cdp,"(async function(){ var u=await unGetActive('genc'); return !!(u&&u.current.content.indexOf('设备瓶颈')>=0&&u.current.evidenceIds.length===2&&u.current.basis==='user_corroborated'); })()"));
    /* ② _threadRuleTick（零 LLM）：规则命中开创 thread */
    check('thRule.created',await ev(cdp,"(async function(){ var n=await _threadRuleTick("+cfgExpr+"); return n>=1; })()"));
    check('thRule.openThread',await ev(cdp,"(async function(){ var open=await thGetOpen('genc'); return open.length>=1; })()"));
    /* ③ _understandingTick 再次：内容未变化 → 不重复改写 */
    const before=await ev(cdp,"(async function(){ var u=await unGetActive('genc'); return u.history.length; })()");
    await ev(cdp,"(async function(){ await _understandingTick("+cfgExpr+"); })()");
    check('uGen.noRepeatRewrite',await ev(cdp,"(async function(){ var u=await unGetActive('genc'); return u.history.length==="+before+"; })()"));
    /* ④ semantic 主链不含 understanding/thread 字段（保持原样） */
    mock.uPayload='{"shouldConsolidate":true,"title":"关系的支柱","summary":"共同经历","content":"在未来，这件共同经历会成为我们关系的支柱。","importance":7,"consolidatedFrom":["g1"]}';
    await ev(cdp,"(async function(){ await _activeConsolidate("+cfgExpr+"); })()");
    check('semantic.untouched',await ev(cdp,"(async function(){ var all=await dbGetAll('memories'); var s=all.find(m=>m.kind==='semantic'&&m.createdBy==='genc'); return !!(s&&!s.understanding&&!s.thread&&s.consolidatedFrom.includes('g1')); })()"));
    /* ⑤ 空闲门控：1h 内无用户消息 → consolidation/understanding tick 不写；有消息 → 正常 */
    await ev(cdp,"(async function(){ await dbDelete('chatMessages','gate_user'); await dbDelete('chatMessages','gate_old'); await dbPut('chatMessages',{id:'gate_old',role:'user',content:'很久以前',friendId:'genc',timestamp:Date.now()-4*3600000}); })()");
    check('gate.inactiveNoWrite',await ev(cdp,"(async function(){ window._activeUserActiveReset(); window.__before=await dbGetAll('memories').then(function(a){return a.length}); await _consolidationTick(); return (await dbGetAll('memories')).length===window.__before; })()"));
    await ev(cdp,"(async function(){ await dbPut('chatMessages',{id:'gate_user',role:'user',content:'刚发的',friendId:'genc',timestamp:Date.now()}); })()");
    check('gate.activeTrue',await ev(cdp,"(async function(){ window._activeUserActiveReset(); return await _activeUserRecentlyActive(3600000)===true; })()"));
    check('gate.inactiveFalse',await ev(cdp,"(async function(){ await dbDelete('chatMessages','gate_user'); window._activeUserActiveReset(); return await _activeUserRecentlyActive(3600000)===false; })()"));
  } finally { if(cdp)cdp.close(); try{browser.kill()}catch(e){} try{mock.server&&mock.server.close()}catch(e){} }
  console.log(failures===0?'\nUnderstanding generation CDP passed ✔':'\nUnderstanding generation CDP FAILED ✘');
  process.exit(failures?1:0);
}
main().catch(e=>{console.error(e);process.exit(1)});
