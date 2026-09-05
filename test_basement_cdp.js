/* ====================================================================
   IB 隐藏彩蛋 · The Basement / INFERNAL BEYOND · CDP 测试（需本机 Chrome / Edge）
   覆盖：书柜交互点 / 密码锁(错→锁死，对→阶梯) / 状态持久化(刷新不丢) / Mode 切换与恢复。
   只测彩蛋；不改现有系统。运行：node test_basement_cdp.js
   ==================================================================== */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http'), net = require('net'), crypto = require('crypto');
const { pathToFileURL } = require('url');
const PAGE_URL = pathToFileURL(path.join(__dirname, 'InternalBeyond.html')).href;
function chromePath(){ if(process.env.CHROME_PATH&&fs.existsSync(process.env.CHROME_PATH))return process.env.CHROME_PATH; for(const c of ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe','C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe','C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe','C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe']) if(fs.existsSync(c))return c; return null; }
class Cdp{constructor(s){this.s=s;this.b=Buffer.alloc(0);this.id=0;this.p=new Map();this.l=new Map();s.on('data',c=>{this.b=Buffer.concat([this.b,c]);this.parse()});s.on('error',()=>{})}static c(u){return new Promise((res,rej)=>{const url=new URL(u);const r=http.request({host:url.hostname,port:url.port,path:url.pathname+url.search,headers:{Upgrade:'websocket',Connection:'Upgrade','Sec-WebSocket-Key':crypto.randomBytes(16).toString('base64'),'Sec-WebSocket-Version':'13'}});r.on('upgrade',(r2,s)=>res(new Cdp(s)));r.on('error',rej);r.end()})}on(m,l){if(!this.l.has(m))this.l.set(m,[]);this.l.get(m).push(l)}send(m,p={}){const id=++this.id;return new Promise((res,rej)=>{this.p.set(id,{res,rej});this.t({id,method:m,params:p});setTimeout(()=>{if(this.p.has(id)){this.p.delete(id);rej(new Error('timeout '+m))}},20000)})}t(m){const p=Buffer.from(JSON.stringify(m),'utf8'),mask=crypto.randomBytes(4),b=Buffer.alloc(p.length);for(let i=0;i<p.length;i++)b[i]=p[i]^mask[i&3];let h;if(p.length<126)h=Buffer.from([0x81,0x80|p.length]);else{h=Buffer.alloc(4);h[0]=0x81;h[1]=0x80|126;h.writeUInt16BE(p.length,2)}this.s.write(Buffer.concat([h,mask,b]))}f(o,p){const mask=crypto.randomBytes(4),b=Buffer.alloc(p.length);for(let i=0;i<p.length;i++)b[i]=p[i]^mask[i&3];let h;if(p.length<126)h=Buffer.from([0x80|o,0x80|p.length]);else{h=Buffer.alloc(4);h[0]=0x80|o;h[1]=0x80|126;h.writeUInt16BE(p.length,2)}this.s.write(Buffer.concat([h,mask,b]))}parse(){for(;;){if(this.b.length<2)return;const f=this.b[0],sl=this.b[1]&0x7f;let o=2,len=sl;if(sl===126){if(this.b.length<4)return;len=this.b.readUInt16BE(2);o=4}else if(sl===127){if(this.b.length<10)return;len=this.b.readUInt32BE(6);o=10}const m=(this.b[1]&0x80)!==0;let mask=null;if(m){if(this.b.length<o+4)return;mask=this.b.subarray(o,o+4);o+=4}if(this.b.length<o+len)return;let p=this.b.subarray(o,o+len);this.b=this.b.subarray(o+len);if(mask){const d=Buffer.alloc(p.length);for(let i=0;i<p.length;i++)d[i]=p[i]^mask[i&3];p=d}const op=f&0xf;if(op===0x8){try{this.s.destroy()}catch(e){}return}if(op===0x9){this.f(0xA,p);continue}if(op!==0x1)continue;let msg;try{msg=JSON.parse(p.toString('utf8'))}catch(e){continue}if(msg.id&&this.p.has(msg.id)){const q=this.p.get(msg.id);this.p.delete(msg.id);if(msg.error)q.rej(new Error(JSON.stringify(msg.error)));else q.res(msg.result||{})}else if(msg.method&&this.l.has(msg.method))for(const l of this.l.get(msg.method))l(msg.params||{})}}close(){try{this.s.destroy()}catch(e){}}}
async function ev(c,e){const r=await c.send('Runtime.evaluate',{expression:e,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw new Error('page exception: '+JSON.stringify(r.exceptionDetails.exception));return r.result&&r.result.value}
async function wait(c,e,t=15000){const end=Date.now()+t;while(Date.now()<end){try{if(await ev(c,e))return true}catch(err){}await new Promise(r=>setTimeout(r,120))}return false}
function freePort(){return new Promise((res,rej)=>{const s=net.createServer();s.unref();s.on('error',rej);s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(e=>e?rej(e):res(p))})})}
async function main(){
  const chrome=chromePath(); if(!chrome)throw new Error('未找到 Chrome / Edge');
  const port=await freePort(), profile=fs.mkdtempSync(path.join(os.tmpdir(),'ib-base-'));
  const browser=spawn(chrome,['--headless=new','--disable-gpu','--no-sandbox','--no-first-run','--allow-file-access-from-files','--force-color-profile=srgb','--window-size=1100,760','--remote-debugging-address=127.0.0.1','--remote-debugging-port='+port,'--user-data-dir='+profile,'about:blank'],{stdio:'ignore'});
  let failures=0; const check=(n,c,d='')=>{if(c)console.log('  PASS  '+n);else{failures++;console.error('  FAIL  '+n+(d?'  -> '+d:''))}};
  let cdp; try{
    let ready=false;for(let i=0;i<120;i++){try{const r=await fetch('http://127.0.0.1:'+port+'/json/version');if(r.ok){ready=true;break}}catch(e){}await new Promise(r=>setTimeout(r,100))}
    check('browser.ready',ready); if(!ready)throw new Error('Chrome DevTools 未就绪');
    const tab=await (await fetch('http://127.0.0.1:'+port+'/json/new?'+encodeURIComponent(PAGE_URL),{method:'PUT'})).json();
    cdp=await Cdp.c(tab.webSocketDebuggerUrl); await cdp.send('Runtime.enable');
    check('page.ready',await wait(cdp,"typeof window._ibBasement==='object' && typeof window.G!=='undefined'",20000));
    await ev(cdp,"window.confirm=function(){return true;}");
    /* 打开房间，等 G.viewport 就绪 + 角色渲染 */
    await ev(cdp,"(function(){ try{ if(typeof enterSite==='function')enterSite(); }catch(e){} })()");
    await ev(cdp,"(function(){ try{ if(typeof openGamePanel==='function')openGamePanel(); else if(typeof navTo==='function')navTo('game'); }catch(e){} })()");
    check('room.ready',await wait(cdp,"window.G && G.viewport && G.viewport.querySelector && G.viewport.querySelector('.game-bg-day')",15000));
    await new Promise(r=>setTimeout(r,1000));
    await wait(cdp,"window.G && G.initialized && !!window.G.viewport.querySelector('#game-char-img') && window.G.viewport.querySelector('#game-char-img').naturalWidth>0",15000);
    /* ① 书柜交互点出现 */
    check('book.marker',await wait(cdp,"!!document.getElementById('ib-bookshelf')",5000));
    /* ② 点击书柜 → 密码锁弹开 */
    await ev(cdp,"document.getElementById('ib-bookshelf').click()");
    check('lock.open',await wait(cdp,"var el=document.getElementById('ib-lock'); !!el && el.hidden===false",4000));
    /* ③ 输错密码 → 不触发、仍锁定 */
    await ev(cdp,"(function(){ window._ibBasement.pressDigit(1); window._ibBasement.pressDigit(2); window._ibBasement.pressDigit(3); })()");
    await new Promise(r=>setTimeout(r,300));
    check('lock.wrongNoOpen',await ev(cdp,"JSON.parse(localStorage.getItem('ib_basement_v2')||'{}').crack!==true"));
    check('lock.stillVisible',await ev(cdp,"var el=document.getElementById('ib-lock'); !!el && el.hidden===false"));
    /* ④ 输对密码 '666' → 阶梯浮现 + crack 持久化 */
    await ev(cdp,"(function(){ window._ibBasement.pressDigit(6); window._ibBasement.pressDigit(6); window._ibBasement.pressDigit(6); })()");
    check('lock.solvedStair',await wait(cdp,"!!document.getElementById('ib-stairs')",4000));
    check('trigger.persisted',await ev(cdp,"JSON.parse(localStorage.getItem('ib_basement_v2')||'{}').crack===true"));
    /* ⑤ 点击阶梯 → 地下室打开 */
    await ev(cdp,"document.getElementById('ib-stairs').click()");
    check('basement.open',await wait(cdp,"var el=document.getElementById('ib-basement'); !!el && el.hidden===false",4000));
    /* ⑥ 状态持久化：刷新后 crack 仍为 true，且阶梯恢复 */
    await ev(cdp,"location.reload()");
    check('persist.afterReload',await wait(cdp,"window._ibBasement && JSON.parse(localStorage.getItem('ib_basement_v2')||'{}').crack===true",15000));
    /* 刷新后房间是关闭的：重开游戏面板并等视口重建，确认阶梯随 crack 恢复 */
    await ev(cdp,"(function(){ try{ if(typeof enterSite==='function')enterSite(); }catch(e){} if(typeof openGamePanel==='function')openGamePanel(); })()");
    await wait(cdp,"window.G && G.viewport && G.viewport.getBoundingClientRect().width>100",15000);
    await new Promise(r=>setTimeout(r,1200));
    check('persist.stairRestored',await wait(cdp,"!!document.getElementById('ib-stairs')",6000));
    /* ⑦ Mode 切换 + 恢复（走真实地下室链路） */
    await ev(cdp,"(function(){ window._ibBasement.open(); })()");
    check('basement.open2',await wait(cdp,"var el=document.getElementById('ib-basement'); !!el && el.hidden===false",4000));
    await ev(cdp,"document.getElementById('ib-basement-core').click()");
    check('mode.switched',await wait(cdp,"document.body.classList.contains('infernal-beyond') && !!document.getElementById('ib-basement-blind')",3000));
    check('mode.textPresent',await ev(cdp,"(document.getElementById('ib-basement-blind')||{textContent:''}).textContent.indexOf('INFERNAL BEYOND 已觉醒')>=0"));
    check('mode.persistFlag',await ev(cdp,"JSON.parse(localStorage.getItem('ib_basement_v2')||'{}').mode===true"));
    await new Promise(r=>setTimeout(r,1800)); /* 等黑屏淡入结束(1600ms) */
    await ev(cdp,"window._ibBasement.returnToSurface()");
    check('mode.restored',await ev(cdp,"!document.body.classList.contains('infernal-beyond') && JSON.parse(localStorage.getItem('ib_basement_v2')||'{}').mode===false"));
  } finally { if(cdp)cdp.close(); try{browser.kill()}catch(e){} }
  console.log(failures===0?'\nThe Basement / INFERNAL BEYOND CDP passed ✔':'\nThe Basement / INFERNAL BEYOND CDP FAILED ✘');
  process.exit(failures?1:0);
}
main().catch(e=>{console.error(e);process.exit(1)});
