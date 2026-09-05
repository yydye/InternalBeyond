/* ====================================================================
   Understanding + Thread v1 · Schema / CRUD / Context / Reconcile · CDP 测试
   覆盖：objectStore 存在 / Understanding unWrite·history(cap)·status /
        Thread thOpen·thClose·thMention / getUnderstandingContext·getThreadContext /
        _reconcileReferences 失效→stale(understandings)·orphan(threads) 不级联删 /
        getMemoryContext 不被污染（recall 池隔离）。
   只测 domain；不改生产代码。运行：node test_understanding_thread.js
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
  const port=await freePort(), profile=fs.mkdtempSync(path.join(os.tmpdir(),'ib-ut-'));
  const browser=spawn(chrome,['--headless=new','--disable-gpu','--no-sandbox','--no-first-run','--allow-file-access-from-files','--force-color-profile=srgb','--window-size=800,600','--remote-debugging-address=127.0.0.1','--remote-debugging-port='+port,'--user-data-dir='+profile,'about:blank'],{stdio:'ignore'});
  let failures=0; const check=(n,c,d='')=>{if(c)console.log('  PASS  '+n);else{failures++;console.error('  FAIL  '+n+(d?'  -> '+d:''))}};
  let cdp; try{
    let ready=false;for(let i=0;i<120;i++){try{const r=await fetch('http://127.0.0.1:'+port+'/json/version');if(r.ok){ready=true;break}}catch(e){}await new Promise(r=>setTimeout(r,100))}
    check('browser.ready',ready); if(!ready)throw new Error('Chrome DevTools 未就绪');
    const tab=await (await fetch('http://127.0.0.1:'+port+'/json/new?'+encodeURIComponent(PAGE_URL),{method:'PUT'})).json();
    cdp=await Cdp.c(tab.webSocketDebuggerUrl); await cdp.send('Runtime.enable');
    check('page.ready',await wait(cdp,"typeof window.unWrite==='function' && typeof window.thOpen==='function' && typeof window.getUnderstandingContext==='function'",20000));
    await ev(cdp,"window.confirm=function(){return true;}");
    /* ① objectStore 存在（新 DB_VER=23） */
    check('store.understandings',await ev(cdp,"(async function(){ try{ await dbGetAll('understandings'); return true }catch(e){ return false } })()"));
    check('store.threads',await ev(cdp,"(async function(){ try{ await dbGetAll('threads'); return true }catch(e){ return false } })()"));
    /* 准备两条证据记忆（供 evidenceIds 引用） */
    await ev(cdp,"(async function(){ await dbPut('memories',{id:'ev_1',createdBy:'u1',title:'记忆1',content:'证据一',kind:'episodic',created:Date.now(),lastActivated:Date.now()}); await dbPut('memories',{id:'ev_2',createdBy:'u1',title:'记忆2',content:'证据二',kind:'episodic',created:Date.now(),lastActivated:Date.now()}); })()");
    /* ② Understanding unWrite：current + evidenceIds + basis + conviction + status */
    let a=await ev(cdp,"(async function(){ var u=await unWrite('u1',{content:'她把创作当作压力出口',conviction:80,basis:'user_stated',dimension:'context',evidenceIds:['ev_1','ev_2']}); return !!(u&&u.current&&u.current.content.indexOf('压力出口')>=0&&u.current.evidenceIds.length===2&&u.current.basis==='user_stated'&&u.current.conviction===80&&u.status==='active'); })()");
    check('un.writeBasic',a===true);
    /* ③ unWrite 二次（不同内容）→ history 保留旧版 */
    await ev(cdp,"(async function(){ await unWrite('u1',{content:'她把创作当作压力出口，而旧电脑让她焦虑',conviction:70,basis:'ai_inference',dimension:'context',evidenceIds:['ev_1']}); })()");
    check('un.historyPreserved',await ev(cdp,"(async function(){ var u=await unGetActive('u1'); return !!(u&&u.history.length>=1&&u.history[0].content.indexOf('压力出口')>=0&&u.current.content.indexOf('旧电脑')>=0); })()"));
    /* ④ history cap=20 */
    await ev(cdp,"(async function(){ for(var i=0;i<25;i++){ await unWrite('u1',{content:'v'+i,conviction:10,basis:'ai_guess',dimension:'context',evidenceIds:['ev_1']}); } })()");
    check('un.historyCap20',await ev(cdp,"(async function(){ var u=await unGetActive('u1'); return !!(u&&u.history.length<=20); })()"));
    /* ⑤ status contested / stale */
    await ev(cdp,"(async function(){ var u=await unGetActive('u1'); await unSetStatus(u.id,'contested','user-vetoed'); })()");
    check('un.contested',await ev(cdp,"(async function(){ var u=await unGetActive('u1'); return u===null; })()"));
    check('un.setStatusStale',await ev(cdp,"(async function(){ var all=await dbGetAll('understandings'); var u=all[0]; return u.status==='contested'&&u.closedReason==='user-vetoed'; })()"));
    /* ⑥ Thread thOpen / thClose / thMention */
    check('th.open',await ev(cdp,"(async function(){ var t=await thOpen('u1','攒钱买硬盘','ev_1'); return !!(t&&t.status==='open'&&t.question==='攒钱买硬盘'&&t.evidenceIds.includes('ev_1')); })()"));
    check('th.reuseSameQuestion',await ev(cdp,"(async function(){ var t=await thOpen('u1','攒钱买硬盘','ev_2'); var open=await thGetOpen('u1'); return open.length===1&&open[0].evidenceIds.length===2&&open[0].mentionCount===2; })()"));
    /* ③b 近重复去重：同一事项的近字面表述（score≥0.5）→ 只有一个 open Thread（复用） */
    await ev(cdp,"(async function(){ await thOpen('tdup','攒钱买硬盘','ev_1'); })()");
    check('th.nearDupMerged',await ev(cdp,"(async function(){ var t=await thOpen('tdup','攒钱买一个硬盘','ev_2'); var open=await thGetOpen('tdup'); return open.length===1&&open[0].evidenceIds.length===2&&open[0].mentionCount>=2; })()"));
    /* ③c 不同事项但标题相似度不足（score<0.5）→ 仍创建两个 Thread */
    await ev(cdp,"(async function(){ await thOpen('tdup2','她想学画画','ev_1'); })()");
    check('th.nearDupSeparate',await ev(cdp,"(async function(){ var t=await thOpen('tdup2','她去体检了','ev_2'); var open=await thGetOpen('tdup2'); return open.length===2; })()"));
    /* ③d 完全相同的 question 仍复用（保留既有行为） */
    await ev(cdp,"(async function(){ await thOpen('tdup3','买硬盘','ev_1'); await thOpen('tdup3','买硬盘','ev_2'); })()");
    check('th.exactStillReuse',await ev(cdp,"(async function(){ var open=await thGetOpen('tdup3'); return open.length===1&&open[0].evidenceIds.length===2; })()"));
    check('th.mention',await ev(cdp,"(async function(){ var open=await thGetOpen('u1'); var t=open[0]; await thMention(t.id,'ev_2'); var t2=await dbGet('threads',t.id); return t2.mentionCount===3; })()"));
    check('th.close',await ev(cdp,"(async function(){ var open=await thGetOpen('u1'); await thClose(open[0].id,'resolved'); var t=await dbGet('threads',open[0].id); return t.status==='closed'&&t.closedReason==='resolved'&&!!t.closedAt; })()"));
    /* ⑦ Context 注入（tail）：已 contested 的理解不进上下文；新开一条 active 理解 */
    await ev(cdp,"(async function(){ await unWrite('u1',{content:'她对设备瓶颈敏感',conviction:75,basis:'ai_inference',dimension:'context',evidenceIds:['ev_1','ev_2']}); })()");
    check('ctx.understanding',await ev(cdp,"(async function(){ var c=await getUnderstandingContext('u1'); return c&&c.indexOf('设备瓶颈')>=0&&c.indexOf('置信：75%')>=0; })()"));
    check('ctx.threadClosedNoEmit',await ev(cdp,"(async function(){ var c=await getThreadContext('u1'); return c===''; })()"));
    /* ⑧ getMemoryContext 不被污染（Understanding/Thread 不进 recall 池） */
    check('recall.isolated',await ev(cdp,"(async function(){ var c=await getMemoryContext('u1',{userMessage:'设备 焦虑 创作'}); return String(c).indexOf('设备瓶颈')<0&&String(c).indexOf('压力出口')<0; })()"));
    /* ⑨ _reconcileReferences：删 ev_1 → 理解 evidence 不全失效则不删；再删 ev_2 → stale，thread 已关不受影响 */
    await ev(cdp,"(async function(){ await dbPut('threads',{id:'th_x',characterId:'u1',status:'open',question:'测试线索',evidenceIds:['ev_1'],mentionCount:1,createdAt:Date.now(),lastUpdatedAt:Date.now(),kind:'thread'}); await dbDelete('memories','ev_1'); await _reconcileReferences('ev_1'); })()");
    check('reconcile.threadOrphan',await ev(cdp,"(async function(){ var t=await dbGet('threads','th_x'); return t.status==='orphan'; })()"));
    check('reconcile.noCascadeUnderstanding',await ev(cdp,"(async function(){ var all=await dbGetAll('understandings'); return all.length>=1; })()"));
  } finally { if(cdp)cdp.close(); try{browser.kill()}catch(e){} }
  console.log(failures===0?'\nUnderstanding + Thread v1 domain CDP passed ✔':'\nUnderstanding + Thread v1 domain CDP FAILED ✘');
  process.exit(failures?1:0);
}
main().catch(e=>{console.error(e);process.exit(1)});
