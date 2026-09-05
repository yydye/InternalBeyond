/* ====================================================================
   Understanding + Thread v1 · Commit 2 · Admission Policy + Context + Lifecycle
   覆盖：understanding 准入（basis/conviction cap）/
        人格定性 ai_inference+repeats<2 拒 · 心理类 ai_inference 拒(user_stated 放行) /
        evidence≥2 独立来源校验 / _buildSingleChatContext tail 注入（不进 system）/
        deleteMemory→reconcile(evidence 全失效→stale/orphan) / rejectUnderstanding→contested。
   只测 domain；不改生产代码。运行：node test_understanding_admission.js
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
  const port=await freePort(), profile=fs.mkdtempSync(path.join(os.tmpdir(),'ib-adm-'));
  const browser=spawn(chrome,['--headless=new','--disable-gpu','--no-sandbox','--no-first-run','--allow-file-access-from-files','--force-color-profile=srgb','--window-size=800,600','--remote-debugging-address=127.0.0.1','--remote-debugging-port='+port,'--user-data-dir='+profile,'about:blank'],{stdio:'ignore'});
  let failures=0; const check=(n,c,d='')=>{if(c)console.log('  PASS  '+n);else{failures++;console.error('  FAIL  '+n+(d?'  -> '+d:''))}};
  let cdp; try{
    let ready=false;for(let i=0;i<120;i++){try{const r=await fetch('http://127.0.0.1:'+port+'/json/version');if(r.ok){ready=true;break}}catch(e){}await new Promise(r=>setTimeout(r,100))}
    check('browser.ready',ready); if(!ready)throw new Error('Chrome DevTools 未就绪');
    const tab=await (await fetch('http://127.0.0.1:'+port+'/json/new?'+encodeURIComponent(PAGE_URL),{method:'PUT'})).json();
    cdp=await Cdp.c(tab.webSocketDebuggerUrl); await cdp.send('Runtime.enable');
    check('page.ready',await wait(cdp,"typeof window._calibrateMemoryCandidate==='function' && typeof window.unWrite==='function' && typeof window.rejectUnderstanding==='function' && (window.IB&&window.IB.chat&&typeof window.IB.chat.buildChatContext==='function')",20000));
    await ev(cdp,"window.confirm=function(){return true;}");
    await ev(cdp,"window.__bcc=function(cfg,o){ try{ if(typeof window.buildChatContext==='function')return window.buildChatContext(cfg,o); if(window.IB&&window.IB.chat&&typeof window.IB.chat.buildChatContext==='function')return window.IB.chat.buildChatContext(cfg,o); return null; }catch(e){ return {__err:String(e&&e.message||e)} } }");
    /* preload: 需要一条 semantic 相关记忆用于 repeatCount 判定 */
    await ev(cdp,"(async function(){ await dbPut('memories',{id:'ev_a',createdBy:'u2',title:'证据A',content:'旧电脑让她焦虑且影响创作流畅',kind:'episodic',created:Date.now(),lastActivated:Date.now()}); await dbPut('memories',{id:'ev_b',createdBy:'u2',title:'证据B',content:'她提到设备瓶颈限制创作',kind:'episodic',created:Date.now(),lastActivated:Date.now()}); })()");
    /* ① basis 判定 + conviction cap：ai_guess 顶格 40 */
    let r=await ev(cdp,"(async function(){ var cal=await _calibrateMemoryCandidate({content:'她可能对设备敏感',confidence:95,basis:'ai_guess',operation:'understanding',targetStore:'understandings',cfg:{id:'u2'},evidenceIds:['ev_a','ev_b'],category:'context'}); return cal.confidence; })()");
    check('admission.aiGuessCap40',r===40,'got '+r);
    /* ② user_stated 不被 ai_guess 的 40 上限封顶（可高于 ai_guess） */
    r=await ev(cdp,"(async function(){ var cal=await _calibrateMemoryCandidate({content:'she told me creation is a pressure outlet and old laptop frustrates her',confidence:95,basis:'user_stated',operation:'understanding',targetStore:'understandings',cfg:{id:'u2'},evidenceIds:['ev_a','ev_b'],category:'context'}); return cal.confidence>40; })()");
    check('admission.userStatedAboveGuessCap',r===true);
    /* ③ 人格定性 ai_inference + repeats<2 → 拒 */
    r=await ev(cdp,"(async function(){ var cal=await _calibrateMemoryCandidate({content:'她本质上是个焦虑型的人',confidence:80,basis:'ai_inference',operation:'understanding',targetStore:'understandings',cfg:{id:'u2'},evidenceIds:['ev_a'],category:'identity'}); return cal.rejected==='personality-inference'; })()");
    check('admission.personalityReject',r===true);
    /* ④ 心理类 ai_inference → 拒 */
    r=await ev(cdp,"(async function(){ var cal=await _calibrateMemoryCandidate({content:'她可能有抑郁症',confidence:80,basis:'ai_inference',operation:'understanding',targetStore:'understandings',cfg:{id:'u2'},evidenceIds:['ev_a','ev_b'],category:'context'}); return cal.rejected==='psych-inference'; })()");
    check('admission.psychReject',r===true);
    /* ⑤ 心理类 user_stated → 放行 */
    r=await ev(cdp,"(async function(){ var cal=await _calibrateMemoryCandidate({content:'她明确告诉我她最近在吃抗抑郁的药',confidence:85,basis:'user_stated',operation:'understanding',targetStore:'understandings',cfg:{id:'u2'},evidenceIds:['ev_a','ev_b'],category:'context'}); return !cal.rejected&&cal.confidence>0; })()");
    check('admission.psychUserStatedAllow',r===true);
    /* ⑥ 证据≥2（非 user_stated）→ 拒 */
    r=await ev(cdp,"(async function(){ var cal=await _calibrateMemoryCandidate({content:'她对设备瓶颈敏感',confidence:70,basis:'ai_inference',operation:'understanding',targetStore:'understandings',cfg:{id:'u2'},evidenceIds:['ev_a'],category:'context'}); return cal.rejected==='insufficient-evidence'; })()");
    check('admission.evidenceLt2Reject',r===true);
    /* ⑥b 证据独立性：两条近字面重复的 memory evidence → 不满足"2 independent evidence" */
    await ev(cdp,"(async function(){ await dbPut('memories',{id:'dup_1',createdBy:'u2',title:'A1',content:'她想攒钱买硬盘',kind:'episodic',created:Date.now(),lastActivated:Date.now()}); await dbPut('memories',{id:'dup_2',createdBy:'u2',title:'A2',content:'她想攒钱买一个硬盘',kind:'episodic',created:Date.now(),lastActivated:Date.now()}); })()");
    r=await ev(cdp,"(async function(){ var cal=await _calibrateMemoryCandidate({content:'她想攒钱买硬盘',confidence:70,basis:'ai_inference',operation:'understanding',targetStore:'understandings',cfg:{id:'u2'},evidenceIds:['dup_1','dup_2'],category:'context'}); return cal.rejected==='insufficient-evidence'&&cal.distinctEvidence===1; })()");
    check('admission.evidenceNearDupCount1',r===true,'got '+JSON.stringify(r));
    /* ⑥c 两条语义明显不同 memory → 可以满足（可放行） */
    await ev(cdp,"(async function(){ await dbPut('memories',{id:'diff_1',createdBy:'u2',title:'创作',content:'她最近专心写小说',kind:'episodic',created:Date.now(),lastActivated:Date.now()}); await dbPut('memories',{id:'diff_2',createdBy:'u2',title:'身体',content:'她上周去体检身体没什么问题',kind:'episodic',created:Date.now(),lastActivated:Date.now()}); })()");
    r=await ev(cdp,"(async function(){ var cal=await _calibrateMemoryCandidate({content:'她在创作上投入比较多',confidence:60,basis:'ai_inference',operation:'understanding',targetStore:'understandings',cfg:{id:'u2'},evidenceIds:['diff_1','diff_2'],category:'context'}); return !cal.rejected&&cal.distinctEvidence===2; })()");
    check('admission.evidenceDistinctCount2',r===true,'got '+JSON.stringify(r));
    /* ⑦ _buildSingleChatContext：Understanding/Thread 进 tail，不进 system */
    await ev(cdp,"(async function(){ await dbPut('apiConfigs',{id:'u2',nickname:'U2',model:'m',systemPrompt:'你的角色。',relationship:'伙伴',created:Date.now()}); await loadApiConfigs(); })()");
    await ev(cdp,"(async function(){ await unWrite('u2',{content:'她把创作当作压力出口',conviction:80,basis:'user_stated',dimension:'context',evidenceIds:['ev_a','ev_b']}); await thOpen('u2','攒钱买硬盘','ev_a'); })()");
    check('tail.uAndTInTail',await ev(cdp,"(async function(){ var bc=await window.__bcc(apiConfigs.find(a=>a.id==='u2'),{userMessage:'设备 焦虑'}); var tail=String(bc&&bc.tail||''); return tail.indexOf('压力出口')>=0&&tail.indexOf('攒钱买硬盘')>=0; })()"));
    check('tail.notInSystem',await ev(cdp,"(async function(){ var bc=await window.__bcc(apiConfigs.find(a=>a.id==='u2'),{userMessage:'设备 焦虑'}); var sys=String(bc&&bc.system||''); return sys.indexOf('压力出口')<0&&sys.indexOf('攒钱买硬盘')<0; })()"));
    /* ⑧ 生命周期：全证据失效 → understanding stale / thread orphan；deleteMemory 触发 reconcile */
    await ev(cdp,"(async function(){ await dbPut('memories',{id:'only_ev',createdBy:'u2',title:'E',content:'x',kind:'episodic',created:Date.now(),lastActivated:Date.now()}); })()");
    await ev(cdp,"(async function(){ await unWrite('u2',{content:'她只依赖这条证据',conviction:70,basis:'ai_inference',dimension:'context',evidenceIds:['only_ev']}); await thOpen('u2','单源测试','only_ev'); })()");
    await ev(cdp,"(async function(){ window.__delRes={}; try{ await deleteMemory('only_ev'); }catch(e){ window.__delRes.err=String(e&&e.message||e); } })()");
    check('lifecycle.deleteHooksReconcile',await ev(cdp,"(async function(){ var all=await dbGetAll('understandings'); var stale=all.some(u=>u.status==='stale'&&String((u.current&&u.current.evidenceIds)||[]).indexOf('only_ev')>=0); var ts=await dbGetAll('threads'); var orph=ts.some(t=>t.status==='orphan'&&(t.evidenceIds||[]).indexOf('only_ev')>=0); return stale||orph; })()"));
    /* ⑨ rejectUnderstanding → contested（先建一条全新的 active 理解再否决） */
    check('lifecycle.rejectContested',await ev(cdp,"(async function(){ var u=await unWrite('u2',{content:'fresh active understanding',conviction:70,basis:'user_stated',dimension:'context',evidenceIds:['ev_a','ev_b']}); if(!u||!u.id)return false; await rejectUnderstanding(u.id); return (await dbGet('understandings',u.id)).status==='contested'; })()"));
  } finally { if(cdp)cdp.close(); try{browser.kill()}catch(e){} }
  console.log(failures===0?'\nUnderstanding admission/lifecycle CDP passed ✔':'\nUnderstanding admission/lifecycle CDP FAILED ✘');
  process.exit(failures?1:0);
}
main().catch(e=>{console.error(e);process.exit(1)});
