/* ====================================================================
   IB 隐藏彩蛋 · Terminal · CDP 冒烟
   覆盖：页面暗语触发(敲 'beyond')打开叠加层 / IB.easterEgg.open /
        run('whoami') 输出 / run('secret') 输出 / run('exit') 关闭。
   只测彩蛋；不改生产代码。运行：node test_easteregg.js
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
  const port=await freePort(), profile=fs.mkdtempSync(path.join(os.tmpdir(),'ib-egg-'));
  const browser=spawn(chrome,['--headless=new','--disable-gpu','--no-sandbox','--no-first-run','--allow-file-access-from-files','--force-color-profile=srgb','--window-size=1100,760','--remote-debugging-address=127.0.0.1','--remote-debugging-port='+port,'--user-data-dir='+profile,'about:blank'],{stdio:'ignore'});
  let failures=0; const check=(n,c,d='')=>{if(c)console.log('  PASS  '+n);else{failures++;console.error('  FAIL  '+n+(d?'  -> '+d:''))}};
  let cdp; try{
    let ready=false;for(let i=0;i<120;i++){try{const r=await fetch('http://127.0.0.1:'+port+'/json/version');if(r.ok){ready=true;break}}catch(e){}await new Promise(r=>setTimeout(r,100))}
    check('browser.ready',ready); if(!ready)throw new Error('Chrome DevTools 未就绪');
    const tab=await (await fetch('http://127.0.0.1:'+port+'/json/new?'+encodeURIComponent(PAGE_URL),{method:'PUT'})).json();
    cdp=await Cdp.c(tab.webSocketDebuggerUrl); await cdp.send('Runtime.enable');
    check('page.ready',await wait(cdp,"typeof window.IB==='object' && typeof window.IB.easterEgg==='object' && typeof window.IB.easterEgg.open==='function'",20000));
    /* ① 页面暗语 'beyond' → 打开叠加层 */
    await ev(cdp,"['b','e','y','o','n','d'].forEach(function(k){document.dispatchEvent(new KeyboardEvent('keydown',{key:k}))})");
    check('egg.magicOpens',await wait(cdp,"(function(){var ov=document.getElementById('ibterm');return ov&&ov.classList.contains('ibterm-on')})()"));
    /* ② run('whoami') 输出 */
    await ev(cdp,"window.IB.easterEgg.run('whoami')");
    check('egg.whoami',await wait(cdp,"(function(){var b=document.getElementById('ibterm-body');return b&&b.textContent.indexOf('Xin')>=0})()"));
    /* ③ run('secret') 输出 SECRET 首行 */
    await ev(cdp,"window.IB.easterEgg.run('secret')");
    await new Promise(function(r){setTimeout(r,150)});
    check('egg.secret',await ev(cdp,"(function(){var b=document.getElementById('ibterm-body');return b&&b.textContent.indexOf('如果你能看到这里')>=0})()"));
    /* ④ run('exit') 关闭 */
    await ev(cdp,"window.IB.easterEgg.run('exit')");
    check('egg.exitCloses',await wait(cdp,"(function(){var ov=document.getElementById('ibterm');return ov&&!ov.classList.contains('ibterm-on')})()"));
    /* ⑤ open() 直接可开（DevTools 路径） */
    await ev(cdp,"window.IB.easterEgg.open()");
    check('egg.devOpen',await wait(cdp,"(function(){var ov=document.getElementById('ibterm');return ov&&ov.classList.contains('ibterm-on')})()"));
    await ev(cdp,"window.IB.easterEgg.close()");
    /* ⑥ URL hash 隐藏门：新标签带 #Beyond 打开 → 自动触发 */
    const tab2=await (await fetch('http://127.0.0.1:'+port+'/json/new?'+encodeURIComponent(PAGE_URL+'#Beyond'),{method:'PUT'})).json();
    const cdp2=await Cdp.c(tab2.webSocketDebuggerUrl); await cdp2.send('Runtime.enable');
    check('egg.hashOpens',await wait(cdp2,"(function(){var ov=document.getElementById('ibterm');return ov&&ov.classList.contains('ibterm-on')})()",20000));
    cdp2.close();
    /* ⑦ hashchange：同一标签从无 hash 切到 #beyond 也触发 */
    await ev(cdp,"(function(){location.hash='beyond'})()");
    check('egg.hashChange',await wait(cdp,"(function(){var ov=document.getElementById('ibterm');return ov&&ov.classList.contains('ibterm-on')})()"));
  } finally { if(cdp)cdp.close(); try{browser.kill()}catch(e){} }
  console.log(failures===0?'\nTerminal easter egg CDP passed ✔':'\nTerminal easter egg CDP FAILED ✘');
  process.exit(failures?1:0);
}
main().catch(e=>{console.error(e);process.exit(1)});
