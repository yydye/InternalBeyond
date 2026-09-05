'use strict';

/* Media Adapter v1 冒烟测试（Node 18+，零依赖，需 Chrome/Edge）。
   覆盖：resolveMedia 直链/m3u8/YouTube/Bilibili/unknown/local、各 Adapter 创建与 destroy 不抛异常、
   unknown fallback 提示、Cinema Exit / 导航离开 / 连续开关 5 次 的零残留、运行时零异常。 */

const { spawn } = require('child_process');
const fs = require('fs'); const os = require('os'); const path = require('path');
const http = require('http'); const net = require('net'); const crypto = require('crypto');
const { pathToFileURL } = require('url');

const PAGE_URL = pathToFileURL(path.join(__dirname, 'InternalBeyond.html')).href;
function chromePath(){if(process.env.CHROME_PATH&&fs.existsSync(process.env.CHROME_PATH))return process.env.CHROME_PATH;return ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe','C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe','C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe','C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find(fs.existsSync)||null}

class Cdp {
  constructor(s){this.s=s;this.b=Buffer.alloc(0);this.id=0;this.p=new Map();this.l=new Map();s.on('data',c=>{this.b=Buffer.concat([this.b,c]);this.parse()});s.on('error',()=>{});}
  static connect(u){return new Promise((res,rej)=>{const x=new URL(u);const r=http.request({host:x.hostname,port:x.port,path:x.pathname+x.search,headers:{Upgrade:'websocket',Connection:'Upgrade','Sec-WebSocket-Key':crypto.randomBytes(16).toString('base64'),'Sec-WebSocket-Version':'13'}});r.on('upgrade',(q,s)=>res(new Cdp(s)));r.on('error',rej);r.end()})}
  on(m,f){if(!this.l.has(m))this.l.set(m,[]);this.l.get(m).push(f)}
  send(m,params={}){const id=++this.id;return new Promise((res,rej)=>{this.p.set(id,{res,rej});this.t({id,method:m,params});setTimeout(()=>{if(this.p.has(id)){this.p.delete(id);rej(new Error('CDP timeout '+m))}},15000)})}
  t(m){const p=Buffer.from(JSON.stringify(m));const mask=crypto.randomBytes(4);const b=Buffer.alloc(p.length);for(let i=0;i<p.length;i++)b[i]=p[i]^mask[i&3];let h;if(p.length<126)h=Buffer.from([0x81,0x80|p.length]);else{h=Buffer.alloc(4);h[0]=0x81;h[1]=0x80|126;h.writeUInt16BE(p.length,2)}this.s.write(Buffer.concat([h,mask,b]))}
  parse(){while(true){if(this.b.length<2)return;const op=this.b[0]&0x0f;let len=this.b[1]&0x7f,off=2;if(len===126){if(this.b.length<4)return;len=this.b.readUInt16BE(2);off=4}else if(len===127)return;if(this.b.length<off+len)return;const pl=this.b.slice(off,off+len);this.b=this.b.slice(off+len);if(op===1){try{const m=JSON.parse(pl.toString('utf8'));if(this.p.has(m.id)){const q=this.p.get(m.id);this.p.delete(m.id);m.error?q.rej(new Error(m.error.message)):q.res(m.result)}if(m.method&&this.l.has(m.method))for(const f of this.l.get(m.method))f(m.params)}catch(e){}}}}
  close(){try{this.s.end()}catch(e){}}
}

async function evaluate(cdp, expression){const r=await cdp.send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw new Error('page exception: '+JSON.stringify(r.exceptionDetails.exception));return (r.result&&r.result.value!==undefined)?r.result.value:undefined}
async function waitFor(cdp, expr, timeout=15000){const end=Date.now()+timeout;while(Date.now()<end){try{if(await evaluate(cdp,expr))return true}catch(e){}await new Promise(r=>setTimeout(r,120))}return false}
function freePort(){return new Promise((res,rej)=>{const s=net.createServer();s.unref();s.on('error',rej);s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(e=>e?rej(e):res(p))})})}

async function main(){
  const chrome=chromePath();if(!chrome)throw new Error('未找到 Chrome/Edge');
  const port=await freePort();const profile=fs.mkdtempSync(path.join(os.tmpdir(),'ib-media-'));
  const browser=spawn(chrome,['--headless=new','--disable-gpu','--no-sandbox','--no-first-run','--allow-file-access-from-files','--remote-debugging-address=127.0.0.1','--remote-debugging-port='+port,'--user-data-dir='+profile,'about:blank'],{stdio:'ignore'});
  let failures=0,cdp;
  const check=(n,ok,d='')=>{if(ok)console.log('  PASS  '+n);else{failures++;console.error('  FAIL  '+n+(d?' -> '+d:''))}};
  try{
    let ready=false;for(let i=0;i<120;i++){try{if((await fetch('http://127.0.0.1:'+port+'/json/version')).ok){ready=true;break}}catch(e){}await new Promise(r=>setTimeout(r,100))}
    check('browser.ready',ready);if(!ready)throw new Error('CDP 未就绪');
    const tab=await (await fetch('http://127.0.0.1:'+port+'/json/new?'+encodeURIComponent(PAGE_URL),{method:'PUT'})).json();
    cdp=await Cdp.connect(tab.webSocketDebuggerUrl);await cdp.send('Runtime.enable');await cdp.send('Log.enable');
    const exceptions=[];cdp.on('Runtime.exceptionThrown',p=>exceptions.push(JSON.stringify(p.exceptionDetails&&p.exceptionDetails.exception||p.exceptionDetails)));
    await evaluate(cdp,"window.confirm=function(){return true}");
    check('page.ready',await waitFor(cdp,"window.IB&&IB.activity&&typeof dbPut==='function'",20000));
    await evaluate(cdp,"(async function(){await dbPut('apiConfigs',{id:'r1',provider:'openai',model:'m',endpoint:'http://127.0.0.1:1/v1',apiKey:'',nickname:'书友',systemPrompt:'x'});await loadApiConfigs();})()");
    await evaluate(cdp,"IB.apps.install('cinema')");await new Promise(r=>setTimeout(r,150));
    await evaluate(cdp,"navTo('apps')");await new Promise(r=>setTimeout(r,200));
    await evaluate(cdp,"IB.apps.open('cinema')");await new Promise(r=>setTimeout(r,400));
    // IBMedia injected by cinema mount
    check('media.loaded',await waitFor(cdp,"typeof window.IBMedia!=='undefined'&&typeof IBMedia.resolveMedia==='function'"));

    /* Resolver */
    const r1=await evaluate(cdp,"IBMedia.resolveMedia('https://cdn.example.com/v/a.mp4')");
    check('media.resolveDirect',r1&&r1.type==='video'&&r1.provider==='direct'&&r1.caps.canFrame===true,JSON.stringify(r1));
    const r2=await evaluate(cdp,"IBMedia.resolveMedia('https://cdn.example.com/live/stream.m3u8?x=1')");
    check('media.resolveHls',r2&&r2.type==='hls'&&r2.provider==='hls'&&r2.caps.canFrame===true,JSON.stringify(r2));
    const r3=await evaluate(cdp,"IBMedia.resolveMedia('https://www.youtube.com/watch?v=dQw4w9WgXcQ')");
    check('media.resolveYoutube',r3&&r3.type==='remote'&&r3.provider==='youtube'&&r3.id==='dQw4w9WgXcQ'&&r3.caps.canFrame===false,JSON.stringify(r3));
    const r4=await evaluate(cdp,"IBMedia.resolveMedia('https://www.bilibili.com/video/BV1xx411c7mD')");
    check('media.resolveBilibili',r4&&r4.type==='remote'&&r4.provider==='bilibili'&&r4.id==='BV1xx411c7mD'&&r4.caps.canFrame===false,JSON.stringify(r4));
    const r5=await evaluate(cdp,"IBMedia.resolveMedia('https://example.com/photo.jpg')");
    check('media.resolveUnknown',r5&&r5.type==='unknown'&&r5.provider==='unknown'&&r5.caps.canFrame===false,JSON.stringify(r5));
    const r6=await evaluate(cdp,"IBMedia.resolveMedia({file:{name:'home_video.mp4'}})");
    check('media.resolveLocal',r6&&r6.type==='video'&&r6.provider==='local'&&r6.caps.canFrame===true,JSON.stringify(r6));

    /* Adapter create + unknown fallback + destroy 不抛异常 */
    const a1=await evaluate(cdp,"(function(){var host=document.createElement('div');var a=IBMedia.createAdapter({type:'unknown',provider:'unknown',url:'',caps:{canFrame:false,canSeek:false}},host);a.load();var msg=host.querySelector('.ci-no-source');return{hasMsg:!!msg,text:(msg&&msg.textContent||'').slice(0,12)}})()");
    check('media.unknownFallback',a1&&a1.hasMsg===true&&/暂不支持/.test(a1.text||''),JSON.stringify(a1));
    check('media.destroyNoThrow',await evaluate(cdp,"(function(){try{var h=document.createElement('div');IBMedia.createAdapter({type:'remote',provider:'direct',id:'x',url:'https://x/v.mp4',caps:{canFrame:true,canSeek:true}},h).destroy();IBMedia.createAdapter({type:'remote',provider:'hls',id:'x',url:'https://x/s.m3u8',caps:{}},h).destroy();IBMedia.createAdapter({type:'remote',provider:'youtube',id:'x',url:'https://youtu.be/aBcD',caps:{}},h).destroy();IBMedia.createAdapter({type:'remote',provider:'bilibili',id:'x',url:'https://b23.tv/BV1xx',caps:{}},h).destroy();return true}catch(e){return String(e&&e.message||e)}})()"));

    /* Cinema Exit（header 按钮）→ zero residue */
    await evaluate(cdp,"IBApps.open('cinema')");await new Promise(r=>setTimeout(r,200));
    check('cinema.open',await evaluate(cdp,"IBApps.isOpen()===true&&!!document.querySelector('#ci-exit')"));
    // 通过 URL 加载一段视频 → 必须真正创建 Cinema 活动（而不是「创建观影活动失败」）
    await evaluate(cdp,"(function(){var u=document.getElementById('ci-url');if(u)u.value='https://cdn.example.com/v/a.mp4';var b=document.getElementById('ci-url-btn');if(b)b.click();})()");
    await new Promise(r=>setTimeout(r,800));
    check('cinema.activityCreated',await evaluate(cdp,"IB.activity.listActivities({type:'cinema'}).then(function(l){return l.length>=1})"));
    await evaluate(cdp,"document.querySelector('#ci-exit').click()");await new Promise(r=>setTimeout(r,300));
    const resid1=await evaluate(cdp,"(function(){var ov=document.getElementById('ib-app-overlay');return JSON.stringify({overlay:!!ov,video:!!document.querySelector('#ib-app-overlay video'),iframe:!!document.querySelector('#ib-app-overlay iframe'),bodyOpen:(document.body.className.indexOf('ibapp-open')>=0)})})()");
    check('cinema.exitResidue',resid1&&resid1.indexOf('"overlay":false')>=0&&resid1.indexOf('"video":false')>=0&&resid1.indexOf('"bodyOpen":false')>=0,resid1);

    /* Cinema → Apps / Chat → zero residue */
    await evaluate(cdp,"IBApps.open('cinema')");await new Promise(r=>setTimeout(r,220));
    await evaluate(cdp,"document.querySelector('.nav-links a[data-page=\"chat\"]').click()");await new Promise(r=>setTimeout(r,300));
    const resid2=await evaluate(cdp,"JSON.stringify({overlay:!!document.getElementById('ib-app-overlay'),video:!!document.querySelector('#ib-app-overlay video'),bodyOpen:(document.body.className.indexOf('ibapp-open')>=0),chatActive:document.getElementById('page-chat').classList.contains('active')})");
    check('cinema.navChatResidue',resid2&&resid2.indexOf('"overlay":false')>=0&&resid2.indexOf('"video":false')>=0&&resid2.indexOf('"chatActive":true')>=0,resid2);

    /* 连续开关 5 次 → zero residue */
    for(let i=0;i<5;i++){await evaluate(cdp,"IBApps.open('cinema')");await new Promise(r=>setTimeout(r,120));await evaluate(cdp,"IBApps.close()");await new Promise(r=>setTimeout(r,120))}
    const resid3=await evaluate(cdp,"JSON.stringify({overlay:!!document.getElementById('ib-app-overlay'),video:!!document.querySelector('#ib-app-overlay video'),iframe:!!document.querySelector('#ib-app-overlay iframe'),bodyOpen:(document.body.className.indexOf('ibapp-open')>=0)})");
    check('cinema.toggle5x',resid3&&resid3.indexOf('"overlay":false')>=0&&resid3.indexOf('"video":false')>=0&&resid3.indexOf('"iframe":false')>=0&&resid3.indexOf('"bodyOpen":false')>=0,resid3);

    await new Promise(r=>setTimeout(r,300));
    check('runtime.noExceptions',exceptions.length===0,exceptions.join('\n').slice(0,400));
    console.log(failures?('\nMedia Adapter smoke failed: '+failures):'\nMedia Adapter smoke passed ✔');
  } finally {
    if(cdp)cdp.close();try{browser.kill()}catch(e){}try{fs.rmSync(profile,{recursive:true,force:true})}catch(e){}
  }
  if(failures)process.exitCode=1;
}
main();
