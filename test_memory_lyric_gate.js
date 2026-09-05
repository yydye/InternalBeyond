/* ====================================================================
   记忆硬拒："文学化自我感慨 / 无未来价值观察" gate · CDP 测试
   覆盖：文学感悟 create 拒 / 自我观察 create 拒 / 明确事实·偏好 create 放行 /
        未来价值 create 放行 / 用户手记(createdByUser) 不受误伤 /
        直接调用 _generateMemoryCore 的拒绝路径不写库。
   运行：node test_memory_lyric_gate.js
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
  const port=await freePort(), profile=fs.mkdtempSync(path.join(os.tmpdir(),'ib-lyric-'));
  const browser=spawn(chrome,['--headless=new','--disable-gpu','--no-sandbox','--no-first-run','--allow-file-access-from-files','--force-color-profile=srgb','--window-size=1100,760','--remote-debugging-address=127.0.0.1','--remote-debugging-port='+port,'--user-data-dir='+profile,'about:blank'],{stdio:'ignore'});
  let failures=0; const check=(n,c,d='')=>{if(c)console.log('  PASS  '+n);else{failures++;console.error('  FAIL  '+n+(d?'  -> '+d:''))}};
  let cdp; try{
    let ready=false;for(let i=0;i<120;i++){try{const r=await fetch('http://127.0.0.1:'+port+'/json/version');if(r.ok){ready=true;break}}catch(e){}await new Promise(r=>setTimeout(r,100))}
    check('browser.ready',ready); if(!ready)throw new Error('Chrome DevTools 未就绪');
    const tab=await (await fetch('http://127.0.0.1:'+port+'/json/new?'+encodeURIComponent(PAGE_URL),{method:'PUT'})).json();
    cdp=await Cdp.c(tab.webSocketDebuggerUrl); await cdp.send('Runtime.enable');
    check('page.ready',await wait(cdp,"typeof window._calibrateMemoryCandidate==='function'",20000));
    await ev(cdp,"window.confirm=function(){return true;}");
    /* ① 文学化自我感慨 → 拒 */
    let r=await ev(cdp,"(async function(){var cal=await _calibrateMemoryCandidate({content:'对平凡清晨与自然瞬间的珍惜，在静谧中确认了时光的珍贵。',operation:'create',targetStore:'memories',cfg:{id:'u1'},category:'情感'});return !!cal.rejected;})()");
    check('gate.lyricReject',r===true);
    /* ② 自我观察（"我仿佛看到了另一种人生"）→ 拒 */
    r=await ev(cdp,"(async function(){var cal=await _calibrateMemoryCandidate({content:'我突然觉得，也许自己看到了另一种人生的感悟。',operation:'create',targetStore:'memories',cfg:{id:'u1'},category:'情感'});return !!cal.rejected;})()");
    check('gate.selfReflectReject',r===true);
    /* ③ 明确事实/偏好（explicit）→ 放行 */
    r=await ev(cdp,"(async function(){var cal=await _calibrateMemoryCandidate({content:'她明确说过她偏好安静的工作环境。',operation:'create',targetStore:'memories',cfg:{id:'u1'},category:'日常'});return !cal.rejected;})()");
    check('gate.explicitKeep',r===true);
    /* ④ 未来价值（future）→ 放行 */
    r=await ev(cdp,"(async function(){var cal=await _calibrateMemoryCandidate({content:'她正在准备一次长途旅行，这会影响我们之后的交流节奏。',operation:'create',targetStore:'memories',cfg:{id:'u1'},category:'日常'});return !cal.rejected;})()");
    check('gate.futureKeep',r===true);
    /* ⑤ 用户手记（createdByUser）→ 不受文学硬拒误伤 */
    r=await ev(cdp,"(async function(){var cal=await _calibrateMemoryCandidate({content:'今晚的月亮让我想起故乡的童年。',operation:'create',targetStore:'memories',cfg:{id:'u1'},category:'情感',createdByUser:true});return !cal.rejected;})()");
    check('gate.userManualKeep',r===true);
    /* ⑥ 完整链路：_generateMemoryCore 走硬拒不写库（用 mock API 触发一次） */
    const mock={payload:'',server:null,port:0};
    mock.server=http.createServer((req,res)=>{const H={'Content-Type':'application/json','Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'Content-Type,Authorization'};if(req.method==='OPTIONS'){res.writeHead(204,H);res.end();return}if(req.method==='POST'&&req.url.includes('/chat/completions')){let ch=[];req.on('data',c=>ch.push(c));req.on('end',()=>{res.writeHead(200,H);res.end(JSON.stringify({choices:[{message:{role:'assistant',content:mock.payload},finish_reason:'stop'}]}))});return}res.writeHead(404,H);res.end('{}')}).listen(0,'127.0.0.1',()=>{mock.port=mock.server.address().port});
    const ep='http://127.0.0.1:'+mock.port+'/v1/chat/completions';
    await ev(cdp,"(async function(){await dbPut('apiConfigs',{id:'lc',nickname:'Lyri',model:'m',endpoint:'"+ep+"',apiKey:'',provider:'custom',relationship:'伙伴',systemPrompt:'角色。',temperature:1,streaming:false,showThinking:false,promptCache:false,created:Date.now()});await loadApiConfigs();})()");
    mock.payload='{"title":"对平凡清晨的珍惜","summary":"","content":"在静谧的夜空下，我忽然珍惜起平凡清晨的时光。","domain":"情感","tags":[],"valence":0.5,"arousal":0.3,"importance":5,"resolved":false,"visibility":"public","confidence":50,"reasons":[]}';
    await ev(cdp,"(async function(){try{var cfg=apiConfigs.find(a=>a.id==='lc');window.__lyrCount=(await dbGetAll('memories')).length;window.__lyrErr='';await _generateMemoryCore(cfg,'测试',{source:'chat',sourceId:'lc',createdBy:'lc',createdByName:'Lyri'});}catch(e){window.__lyrErr=String(e&&e.message||e)}})()");
    check('gate.coreRejectNoWrite',await ev(cdp,"(async function(){return (await dbGetAll('memories')).length===window.__lyrCount})()"),JSON.stringify(await ev(cdp,"window.__lyrErr")));
    try{mock.server.close()}catch(e){}
    /* ⑦ 存量审计：scanLyricalMemories 识别文学感慨但不删（并排除带事实/偏好者） */
    r=await ev(cdp,"(async function(){await dbPut('memories',{id:'lm1',createdBy:'AI',title:'对平凡清晨的珍惜',content:'在静谧中珍惜平凡清晨的珍贵。',kind:'episodic',created:Date.now(),lastActivated:Date.now(),visibility:'public'});await dbPut('memories',{id:'lm2',createdBy:'AI',title:'换设备',content:'她很明确说过偏好安静工作环境。',kind:'episodic',created:Date.now(),lastActivated:Date.now(),visibility:'public'});var c=await scanLyricalMemories();return {hit:!!c.find(function(x){return x.id==='lm1'}),excl:!c.find(function(x){return x.id==='lm2'}),count:c.length};})()");
    check('scan.findsLyrical',r.hit===true,JSON.stringify(r));
    check('scan.excludesFactMem',r.excl===true,JSON.stringify(r));
    check('scan.readOnlyKeepsMem',await ev(cdp,"(async function(){var all=await dbGetAll('memories');return all.some(function(m){return m.id==='lm1'})})()"),'scan 不应删除');
    /* ⑧ 清理 UI：openCleanLyricsModal → 扫出候选 lm1(排除 lm2) → 勾选删除 → 库减少 */
    await ev(cdp,"(async function(){await dbDelete('memories','lm2');await openCleanLyricsModal();})()");
    check('ui.listsCandidate',await ev(cdp,"(function(){var boxes=document.querySelectorAll('.mem-clean-cb');return boxes.length===1&&boxes[0].value==='lm1'})()"));
    check('ui.deleteBtnDisabled',await ev(cdp,"(function(){return document.getElementById('mem-clean-delete-btn').disabled===true})()"));
    await ev(cdp,"(function(){var cb=document.querySelector('.mem-clean-cb');cb.checked=true;updateCleanLyricsBtns();})()");
    check('ui.deleteBtnEnabled',await ev(cdp,"(function(){var b=document.getElementById('mem-clean-delete-btn');return b.disabled===false&&document.getElementById('mem-clean-count').textContent==='1'})()"));
    await ev(cdp,"(async function(){window.confirm=function(){return true};await deleteCheckedCleanLyrics();})()");
    check('ui.deletedCandidate',await ev(cdp,"(async function(){var all=await dbGetAll('memories');return !all.some(function(m){return m.id==='lm1'})})()"));
    check('ui.emptyAfterDelete',await ev(cdp,"(function(){var e=document.getElementById('mem-clean-empty');return e&&e.style.display==='block'})()"));
  } finally { if(cdp)cdp.close(); try{browser.kill()}catch(e){} }
  console.log(failures===0?'\nMemory lyric gate CDP passed ✔':'\nMemory lyric gate CDP FAILED ✘');
  process.exit(failures?1:0);
}
main().catch(e=>{console.error(e);process.exit(1)});
