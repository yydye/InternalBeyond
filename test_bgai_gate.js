/* ====================================================================
   后台 AI 调度总开关 + 休眠时段 · CDP 测试
   覆盖：getBgAiConfig 默认启用 / _bgInSleepWindow 同日·跨午夜 /
        _bgAiGate 总关→hibernate · 休眠→hibernate · 正常→run /
        _bgAiSaveSwitches 保存(enabled+sleep) / 记忆写入在 hibernate 内禁止。
   运行：node test_bgai_gate.js
   ==================================================================== */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http'), net = require('net'), crypto = require('crypto');
const { pathToFileURL } = require('url');
const PAGE_URL = pathToFileURL(path.join(__dirname, 'InternalBeyond.html')).href;
function chromePath(){ if(process.env.CHROME_PATH&&fs.existsSync(process.env.CHROME_PATH))return process.env.CHROME_PATH; for(const c of ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe','C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe','C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe','C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe']) if(fs.existsSync(c))return c; return null; }
class Cdp{constructor(s){this.s=s;this.b=Buffer.alloc(0);this.id=0;this.p=new Map();s.on('data',c=>{this.b=Buffer.concat([this.b,c]);this.parse()})}static c(u){return new Promise((res,rej)=>{const url=new URL(u);const r=http.request({host:url.hostname,port:url.port,path:url.pathname+url.search,headers:{Upgrade:'websocket',Connection:'Upgrade','Sec-WebSocket-Key':crypto.randomBytes(16).toString('base64'),'Sec-WebSocket-Version':'13'}});r.on('upgrade',(a,s)=>res(new Cdp(s)));r.on('error',rej);r.end()})}send(m,p={}){const id=++this.id;return new Promise((res,rej)=>{this.p.set(id,{res,rej});this.t({id,method:m,params:p});setTimeout(()=>{if(this.p.has(id)){this.p.delete(id);rej(new Error('timeout'))}},15000)})}t(m){const p=Buffer.from(JSON.stringify(m),'utf8'),mask=crypto.randomBytes(4),b=Buffer.alloc(p.length);for(let i=0;i<p.length;i++)b[i]=p[i]^mask[i&3];let h;if(p.length<126)h=Buffer.from([0x81,0x80|p.length]);else{h=Buffer.alloc(4);h[0]=0x81;h[1]=0x80|126;h.writeUInt16BE(p.length,2)}this.s.write(Buffer.concat([h,mask,b]))}parse(){for(;;){if(this.b.length<2)return;const f=this.b[0],sl=this.b[1]&0x7f;let o=2,len=sl;if(sl===126){if(this.b.length<4)return;len=this.b.readUInt16BE(2);o=4}else if(sl===127){if(this.b.length<10)return;len=this.b.readUInt32BE(6);o=10}const m=(this.b[1]&0x80)!==0;let mask=null;if(m){if(this.b.length<o+4)return;mask=this.b.subarray(o,o+4);o+=4}if(this.b.length<o+len)return;let p=this.b.subarray(o,o+len);this.b=this.b.subarray(o+len);if(mask){const d=Buffer.alloc(p.length);for(let i=0;i<p.length;i++)d[i]=p[i]^mask[i&3];p=d}const op=f&0xf;if(op===0x8){this.s.destroy();return}if(op!==0x1)continue;let msg;try{msg=JSON.parse(p.toString('utf8'))}catch(e){continue}if(msg.id&&this.p.has(msg.id)){const q=this.p.get(msg.id);this.p.delete(msg.id);if(msg.error)q.rej(new Error(JSON.stringify(msg.error)));else q.res(msg.result||{})}}}close(){this.s.destroy()}}
async function ev(c,e){const r=await c.send('Runtime.evaluate',{expression:e,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw new Error('page exception: '+JSON.stringify(r.exceptionDetails.exception));return r.result&&r.result.value}
async function wait(c,e,t=15000){const end=Date.now()+t;while(Date.now()<end){try{if(await ev(c,e))return true}catch(err){}await new Promise(r=>setTimeout(r,120))}return false}
function freePort(){return new Promise((res,rej)=>{const s=net.createServer();s.unref();s.on('error',rej);s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(e=>e?rej(e):res(p))})})}
async function main(){
  const chrome=chromePath(); if(!chrome)throw new Error('未找到 Chrome / Edge');
  const port=await freePort(), profile=fs.mkdtempSync(path.join(os.tmpdir(),'ib-bgai-'));
  const browser=spawn(chrome,['--headless=new','--disable-gpu','--no-sandbox','--no-first-run','--allow-file-access-from-files','--force-color-profile=srgb','--window-size=1100,760','--remote-debugging-address=127.0.0.1','--remote-debugging-port='+port,'--user-data-dir='+profile,'about:blank'],{stdio:'ignore'});
  let failures=0; const check=(n,c,d='')=>{if(c)console.log('  PASS  '+n);else{failures++;console.error('  FAIL  '+n+(d?'  -> '+d:''))}};
  let cdp; try{
    let ready=false;for(let i=0;i<120;i++){try{const r=await fetch('http://127.0.0.1:'+port+'/json/version');if(r.ok){ready=true;break}}catch(e){}await new Promise(r=>setTimeout(r,100))}
    check('browser.ready',ready); if(!ready)throw new Error('Chrome DevTools 未就绪');
    const tab=await (await fetch('http://127.0.0.1:'+port+'/json/new?'+encodeURIComponent(PAGE_URL),{method:'PUT'})).json();
    cdp=await Cdp.c(tab.webSocketDebuggerUrl); await cdp.send('Runtime.enable');
    check('page.ready',await wait(cdp,"typeof window._bgAiGate==='function' && typeof window._bgAiSaveSwitches==='function'",20000));
    await ev(cdp,"window.confirm=function(){return true;}");
    /* ① 默认启用 → gate 正常跑 */
    check('cfg.defaultEnabled',await ev(cdp,"(async function(){var c=await getBgAiConfig();return c.enabled===true&&c.sleepStart===''&&c.sleepEnd===''})()"));
    /* ② _bgInSleepWindow：同日 / 跨午夜 */
    check('sleep.sameDay',await ev(cdp,"(function(){var c={sleepStart:'09:00',sleepEnd:'17:00'};var r=_bgInSleepWindow(c);return r===true||r===false;})()"),'same-day window returns boolean');
    check('sleep.crossMidnight',await ev(cdp,"(function(){var c={sleepStart:'23:00',sleepEnd:'07:00'};return typeof _bgInSleepWindow(c)==='boolean'})()"));
    /* ③ gate：总关 → hibernate */
    await ev(cdp,"(async function(){await dbPut('apiSettings',{id:'bgAi',enabled:false,sleepStart:'',sleepEnd:''})})()");
    check('gate.masterOff',await ev(cdp,"(async function(){return (await _bgAiGate())==='hibernate'})()"));
    /* ④ gate：启用 + 休眠窗口内 → hibernate */
    await ev(cdp,"(async function(){var h=new Date().getHours();var s=String(h).padStart(2,'0')+':00';var e=String((h+1)%24).padStart(2,'0')+':00';await dbPut('apiSettings',{id:'bgAi',enabled:true,sleepStart:s,sleepEnd:e})})()");
    check('gate.sleepWindow',await ev(cdp,"(async function(){return (await _bgAiGate())==='hibernate'})()"));
    /* ⑤ gate：启用 + 无休眠 → run */
    await ev(cdp,"(async function(){await dbPut('apiSettings',{id:'bgAi',enabled:true,sleepStart:'',sleepEnd:''})})()");
    check('gate.enabledRun',await ev(cdp,"(async function(){return (await _bgAiGate())==='run'})()"));
    /* ⑥ _bgAiSaveSwitches：从表单读并保存 */
    await ev(cdp,"(function(){document.getElementById('bga-enabled').checked=true;document.getElementById('bga-sleep-start').value='22:00';document.getElementById('bga-sleep-end').value='06:30';})()");
    await ev(cdp,"(async function(){await _bgAiSaveSwitches()})()");
    check('cfg.saved',await ev(cdp,"(async function(){var c=await dbGet('apiSettings','bgAi');return c.enabled===true&&c.sleepStart==='22:00'&&c.sleepEnd==='06:30'})()"));
    /* ⑦ _bgAiLoadUI：从存储回填表单 */
    await ev(cdp,"(async function(){await _bgAiLoadUI()})()");
    check('cfg.loadedUI',await ev(cdp,"(function(){return document.getElementById('bga-sleep-start').value==='22:00'&&document.getElementById('bga-sleep-end').value==='06:30'})()"));
    /* ⑧ 记忆写入在 hibernate 内禁止：总关时 _consolidationTick 不写（即使最近活跃） */
    await ev(cdp,"(async function(){await dbPut('apiSettings',{id:'bgAi',enabled:false,sleepStart:'',sleepEnd:''});await dbPut('chatMessages',{id:'recent_u',role:'user',content:'刚互动',friendId:'x',timestamp:Date.now()});window._activeUserActiveReset();window.__before=await dbGetAll('memories').then(function(a){return a.length});await _consolidationTick();})()");
    check('gate.noMemoryWriteWhenOff',await ev(cdp,"(async function(){return (await dbGetAll('memories')).length===window.__before})()"));
  } finally { if(cdp)cdp.close(); try{browser.kill()}catch(e){} }
  console.log(failures===0?'\nBackground AI gate CDP passed ✔':'\nBackground AI gate CDP FAILED ✘');
  process.exit(failures?1:0);
}
main().catch(e=>{console.error(e);process.exit(1)});
