/* ====================================================================
   Memory Consolidation v1 + Admission Gate · CDP 测试（需本机 Chrome / Edge）
   Gate：importance≥6 不再是唯一准入；需 非单次临时 且 (explicit/future/跨来源重复)。
   覆盖：create / merge(noDuplicate) / 各 reject / repeats·explicit allow /
         被拒绝不污染已有 semantic / silent 回归。
   只测 consolidation；不改生产代码。运行：node test_memory_consolidation.js
   ==================================================================== */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http'), net = require('net'), crypto = require('crypto');
const { pathToFileURL } = require('url');
const PAGE_URL = pathToFileURL(path.join(__dirname, 'InternalBeyond.html')).href;
function chromePath(){ if(process.env.CHROME_PATH&&fs.existsSync(process.env.CHROME_PATH))return process.env.CHROME_PATH; for(const c of ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe','C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe','C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe','C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe']) if(fs.existsSync(c))return c; return null; }
class Cdp{constructor(s){this.s=s;this.b=Buffer.alloc(0);this.id=0;this.p=new Map();this.l=new Map();s.on('data',c=>{this.b=Buffer.concat([this.b,c]);this.parse()});s.on('error',()=>{})}static c(u){return new Promise((res,rej)=>{const url=new URL(u);const r=http.request({host:url.hostname,port:url.port,path:url.pathname+url.search,headers:{Upgrade:'websocket',Connection:'Upgrade','Sec-WebSocket-Key':crypto.randomBytes(16).toString('base64'),'Sec-WebSocket-Version':'13'}});r.on('upgrade',(res2,s)=>res(new Cdp(s)));r.on('error',rej);r.end()})}on(m,l){if(!this.l.has(m))this.l.set(m,[]);this.l.get(m).push(l)}send(m,p={}){const id=++this.id;return new Promise((res,rej)=>{this.p.set(id,{res,rej});this.t({id,method:m,params:p});setTimeout(()=>{if(this.p.has(id)){this.p.delete(id);rej(new Error('timeout '+m))}},15000)})}t(m){const p=Buffer.from(JSON.stringify(m),'utf8'),mask=crypto.randomBytes(4),b=Buffer.alloc(p.length);for(let i=0;i<p.length;i++)b[i]=p[i]^mask[i&3];let h;if(p.length<126)h=Buffer.from([0x81,0x80|p.length]);else{h=Buffer.alloc(4);h[0]=0x81;h[1]=0x80|126;h.writeUInt16BE(p.length,2)}this.s.write(Buffer.concat([h,mask,b]))}f(o,p){const mask=crypto.randomBytes(4),b=Buffer.alloc(p.length);for(let i=0;i<p.length;i++)b[i]=p[i]^mask[i&3];let h;if(p.length<126)h=Buffer.from([0x80|o,0x80|p.length]);else{h=Buffer.alloc(4);h[0]=0x80|o;h[1]=0x80|126;h.writeUInt16BE(p.length,2)}this.s.write(Buffer.concat([h,mask,b]))}parse(){for(;;){if(this.b.length<2)return;const f=this.b[0],sl=this.b[1]&0x7f;let o=2,len=sl;if(sl===126){if(this.b.length<4)return;len=this.b.readUInt16BE(2);o=4}else if(sl===127){if(this.b.length<10)return;len=this.b.readUInt32BE(6);o=10}const m=(this.b[1]&0x80)!==0;let mask=null;if(m){if(this.b.length<o+4)return;mask=this.b.subarray(o,o+4);o+=4}if(this.b.length<o+len)return;let p=this.b.subarray(o,o+len);this.b=this.b.subarray(o+len);if(mask){const d=Buffer.alloc(p.length);for(let i=0;i<p.length;i++)d[i]=p[i]^mask[i&3];p=d}const op=f&0xf;if(op===0x8){try{this.s.destroy()}catch(e){}return}if(op===0x9){this.f(0xA,p);continue}if(op!==0x1)continue;let msg;try{msg=JSON.parse(p.toString('utf8'))}catch(e){continue}if(msg.id&&this.p.has(msg.id)){const q=this.p.get(msg.id);this.p.delete(msg.id);if(msg.error)q.rej(new Error(JSON.stringify(msg.error)));else q.res(msg.result||{})}else if(msg.method&&this.l.has(msg.method))for(const l of this.l.get(msg.method))l(msg.params||{})}}close(){try{this.s.destroy()}catch(e){}}}
async function ev(c,e){const r=await c.send('Runtime.evaluate',{expression:e,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw new Error('page exception: '+JSON.stringify(r.exceptionDetails.exception));return r.result&&r.result.value}
async function wait(c,e,t=15000){const end=Date.now()+t;while(Date.now()<end){try{if(await ev(c,e))return true}catch(err){}await new Promise(r=>setTimeout(r,120))}return false}
function freePort(){return new Promise((res,rej)=>{const s=net.createServer();s.unref();s.on('error',rej);s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(e=>e?rej(e):res(p))})})}
async function main(){
  const chrome=chromePath(); if(!chrome)throw new Error('未找到 Chrome / Edge');
  const mock={consolPayload:'', server:null, port:0};
  mock.server=http.createServer((req,res)=>{const H={'Content-Type':'application/json','Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,POST,OPTIONS','Access-Control-Allow-Headers':'Content-Type,Authorization'};if(req.method==='OPTIONS'){res.writeHead(204,H);res.end();return}if(req.method==='POST'&&req.url.includes('/chat/completions')){let ch=[];req.on('data',c=>ch.push(c));req.on('end',()=>{res.writeHead(200,H);res.end(JSON.stringify({choices:[{message:{role:'assistant',content:mock.consolPayload},finish_reason:'stop'}]}))});return}res.writeHead(404,H);res.end(JSON.stringify({error:'nf'}))}).listen(0,'127.0.0.1',()=>{mock.port=mock.server.address().port});
  const port=await freePort(), profile=fs.mkdtempSync(path.join(os.tmpdir(),'ib-cons-'));
  const browser=spawn(chrome,['--headless=new','--disable-gpu','--no-sandbox','--no-first-run','--allow-file-access-from-files','--force-color-profile=srgb','--window-size=800,600','--remote-debugging-address=127.0.0.1','--remote-debugging-port='+port,'--user-data-dir='+profile,'about:blank'],{stdio:'ignore'});
  let failures=0; const check=(n,c,d='')=>{if(c)console.log('  PASS  '+n);else{failures++;console.error('  FAIL  '+n+(d?'  -> '+d:''))}};
  let cdp; try{
    let ready=false;for(let i=0;i<120;i++){try{const r=await fetch('http://127.0.0.1:'+port+'/json/version');if(r.ok){ready=true;break}}catch(e){}await new Promise(r=>setTimeout(r,100))}
    check('browser.ready',ready); if(!ready)throw new Error('Chrome DevTools 未就绪');
    const tab=await (await fetch('http://127.0.0.1:'+port+'/json/new?'+encodeURIComponent(PAGE_URL),{method:'PUT'})).json();
    cdp=await Cdp.c(tab.webSocketDebuggerUrl); await cdp.send('Runtime.enable');
    check('page.ready',await wait(cdp,"typeof window._activeConsolidate==='function' && typeof window._calibrateMemoryCandidate==='function' && typeof window.apiConfigs!=='undefined'",20000));
    await ev(cdp,"window.confirm=function(){return true;}");
    const ep='http://127.0.0.1:'+mock.port+'/v1/chat/completions';
    await ev(cdp,"(function(){dbPut('apiConfigs',{id:'consac',nickname:'ConsAI',model:'m',endpoint:'"+ep+"',apiKey:'',provider:'custom',relationship:'伙伴',systemPrompt:'你是从容的角色。',temperature:1,streaming:false,showThinking:false,promptCache:false,created:Date.now()});})()");
    await ev(cdp,"loadApiConfigs()");
    check('cfg.ready',await wait(cdp,"apiConfigs.some(a=>a.id==='consac'&&a.endpoint==='"+ep+"')",8000));
    const cfgExpr="apiConfigs.find(a=>a.id==='consac')";
    await ev(cdp,"(async function(){ await dbPut('memories',{id:'epi_1',createdBy:'consac',createdByName:'ConsAI',kind:'episodic',title:'零散片段',summary:'',content:'角色近期零散的经历片段',domain:'日常',tags:[],valence:0.5,arousal:0.4,importance:5,resolved:false,visibility:'public',visibleTo:[],excludeFrom:[],activationCount:1,created:Date.now(),lastActivated:Date.now(),consolidatedFrom:[],lastConsolidatedAt:null}); })()");
    const semCount=function(f){return "(async function(){ var all=await dbGetAll('memories'); return all.filter(m=>m.kind==='semantic'&&m.createdBy==='consac').length; })()"};
    /* ① create（future 证据） */
    mock.consolPayload='{"shouldConsolidate":true,"title":"关系的支柱","summary":"共同经历","content":"在未来，这件共同经历会成为我们关系的支柱。","importance":7,"consolidatedFrom":["src_1","src_2"]}';
    const a=await ev(cdp,"(async function(){ window.__r_a=await _activeConsolidate("+cfgExpr+"); return !!(window.__r_a&&window.__r_a.id||window.__r_a); })()");
    check('create.created',a===true);
    check('create.semantic1',await ev(cdp,semCount())===1);
    check('create.provenance',await ev(cdp,"(async function(){ var all=await dbGetAll('memories'); var s=all.find(m=>m.kind==='semantic'&&m.createdBy==='consac'); return !!(s&&Array.isArray(s.consolidatedFrom)&&s.consolidatedFrom.includes('src_1')); })()"));
    /* ② merge（相似 → 更新同一条，不重造） */
    mock.consolPayload='{"shouldConsolidate":true,"title":"关系的支柱2","summary":"共同经历2","content":"在未来，这件共同经历会成为我们关系的支柱。","importance":9,"consolidatedFrom":["src_3"]}';
    await ev(cdp,"(async function(){ window.__r_b=await _activeConsolidate("+cfgExpr+"); return !!window.__r_b; })()");
    check('merge.noDuplicate',await ev(cdp,semCount())===1);
    check('merge.bumpedImportance',await ev(cdp,"(async function(){ var all=await dbGetAll('memories'); var s=all.find(m=>m.kind==='semantic'&&m.createdBy==='consac'); return s&&s.importance===9; })()"));
    /* ③④⑤ 被 Gate 拒：文学化 / 今天临时 / 高 importance 无证据 → 都不建（count 恒 1） */
    mock.consolPayload='{"shouldConsolidate":true,"title":"雨夜","summary":"","content":"雨夜独行，霓虹在雨水中破碎，我的影子被拉扯成碎片。","importance":9,"consolidatedFrom":[]}';
    await ev(cdp,"(async function(){ window.__r_lit=await _activeConsolidate("+cfgExpr+"); return !!window.__r_lit; })()");
    check('reject.literaryNoSemantic',await ev(cdp,semCount())===1);
    mock.consolPayload='{"shouldConsolidate":true,"title":"今晚","summary":"","content":"今晚和漂泊者聊得很晚，我很开心。","importance":9,"consolidatedFrom":[]}';
    await ev(cdp,"(async function(){ window.__r_tod=await _activeConsolidate("+cfgExpr+"); return !!window.__r_tod; })()");
    check('reject.todayTemporaryNoSemantic',await ev(cdp,semCount())===1);
    mock.consolPayload='{"shouldConsolidate":true,"title":"高价值却无据","summary":"","content":"灯影摇曳，影子的边缘在雾里溶解成一片深蓝。","importance":10,"consolidatedFrom":[]}';
    await ev(cdp,"(async function(){ window.__r_hi=await _activeConsolidate("+cfgExpr+"); return !!window.__r_hi; })()");
    check('reject.highImportanceNoEvidence',await ev(cdp,semCount())===1);
    /* ⑥ allow：跨来源重复稳定模式（seeded 2 条同内容，无 explicit/future 关键词） */
    await ev(cdp,"(async function(){ await dbPut('memories',{id:'rep_1',createdBy:'consac',createdByName:'ConsAI',kind:'episodic',title:'',summary:'',content:'山丘花开时我们会重逢',domain:'日常',tags:[],valence:0.5,arousal:0.4,importance:5,resolved:false,visibility:'public',visibleTo:[],excludeFrom:[],activationCount:1,created:Date.now(),lastActivated:Date.now(),consolidatedFrom:[],lastConsolidatedAt:null}); await dbPut('memories',{id:'rep_2',createdBy:'consac',createdByName:'ConsAI',kind:'episodic',title:'',summary:'',content:'山丘花开时我们会重逢',domain:'日常',tags:[],valence:0.5,arousal:0.4,importance:5,resolved:false,visibility:'public',visibleTo:[],excludeFrom:[],activationCount:1,created:Date.now(),lastActivated:Date.now(),consolidatedFrom:[],lastConsolidatedAt:null}); })()");
    mock.consolPayload='{"shouldConsolidate":true,"title":"重逢","summary":"","content":"山丘花开时我们会重逢","importance":6,"consolidatedFrom":["rep_1","rep_2"]}';
    const f=await ev(cdp,"(async function(){ window.__r_rep=await _activeConsolidate("+cfgExpr+"); return !!(window.__r_rep&&window.__r_rep.id||window.__r_rep); })()");
    check('allow.repeatsPattern',f===true&&await ev(cdp,semCount())===2,'count='+await ev(cdp,semCount()));
    /* ⑦ allow：explicit/future 长期信息 */
    mock.consolPayload='{"shouldConsolidate":true,"title":"偏好","summary":"","content":"我偏好雨天出门，请你记住这个习惯。","importance":6,"consolidatedFrom":["src_x"]}';
    const g=await ev(cdp,"(async function(){ window.__r_exp=await _activeConsolidate("+cfgExpr+"); return !!(window.__r_exp&&window.__r_exp.id||window.__r_exp); })()");
    check('allow.explicitFuture',g===true&&await ev(cdp,semCount())===3,'count='+await ev(cdp,semCount()));
    /* ⑧ silent：JSON 解析失败 → 静默，不影响已有 */
    mock.consolPayload='这不是 JSON';
    const sil=await ev(cdp,"(async function(){ try{ window.__r_sil=await _activeConsolidate("+cfgExpr+"); return {ok:true,ret:window.__r_sil}; }catch(e){ return {ok:false,err:String(e&&e.message||e)}; } })()");
    check('silent.parseFailNoThrow',sil&&sil.ok===true&&sil.ret===null);
    check('silent.noNewOnParseFail',await ev(cdp,semCount())===3);
  } finally { if(cdp)cdp.close(); try{browser.kill()}catch(e){} try{mock.server.close()}catch(e){} }
  console.log(failures===0?'\nMemory Consolidation + Gate CDP passed ✔':'\nMemory Consolidation + Gate CDP FAILED ✘');
  process.exit(failures?1:0);
}
main().catch(e=>{console.error(e);process.exit(1)});
