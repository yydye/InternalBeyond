/* ====================================================================
   Middle Brain Phase 2 · Astra Admission Gate · CDP 测试（mock Astra 端点）
   覆盖：短/简单 Context→NO / 普通对话→NO / 超长→YES / 高复杂度→YES /
        多 Thread/Understanding→YES / 冲突信号→YES / cooldown / hysteresis /
        Gate disabled→恢复 Phase 1 / Gate NO→Astra fetch 不发生 /
        Gate YES→Astra 正常调用 / Astra 超时·500→Local fallback /
        当前 userMessage 与 recent dialogue 保留 / Memory·Understanding·
        Thread 零写入 / Character Provider 不变。
   只测 Middle Brain；不改生产代码。运行：node test_middle_brain_admission.js
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
  const mock={payload:'', server:null, port:0, mode:'ok', count:0};
  mock.server=http.createServer((req,res)=>{const H={'Content-Type':'application/json','Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,POST,OPTIONS','Access-Control-Allow-Headers':'Content-Type,Authorization'};if(req.method==='OPTIONS'){res.writeHead(204,H);res.end();return}if(req.method==='POST'&&req.url.includes('/responses')){mock.count++;let ch=[];req.on('data',c=>ch.push(c));req.on('end',()=>{if(mock.mode==='fail'){res.writeHead(500,H);res.end(JSON.stringify({error:'boom'}));return}if(mock.mode==='slow'){setTimeout(()=>{res.writeHead(200,H);res.end(JSON.stringify({output:[{type:'message',content:[{type:'output_text',text:mock.payload}]}],usage:{input_tokens:5,output_tokens:3,total_tokens:8}}))},3000);return}res.writeHead(200,H);res.end(JSON.stringify({output:[{type:'message',content:[{type:'output_text',text:mock.payload}]}],usage:{input_tokens:5,output_tokens:3,total_tokens:8}}))});return}res.writeHead(404,H);res.end(JSON.stringify({error:'nf'}))}).listen(0,'127.0.0.1',()=>{mock.port=mock.server.address().port});
  const port=await freePort(), profile=fs.mkdtempSync(path.join(os.tmpdir(),'ib-adm-'));
  const browser=spawn(chrome,['--headless=new','--disable-gpu','--no-sandbox','--no-first-run','--allow-file-access-from-files','--force-color-profile=srgb','--window-size=1100,760','--remote-debugging-address=127.0.0.1','--remote-debugging-port='+port,'--user-data-dir='+profile,'about:blank'],{stdio:'ignore'});
  let failures=0; const check=(n,c,d='')=>{if(c)console.log('  PASS  '+n);else{failures++;console.error('  FAIL  '+n+(d?'  -> '+d:''))}};
  let cdp; try{
    let ready=false;for(let i=0;i<120;i++){try{const r=await fetch('http://127.0.0.1:'+port+'/json/version');if(r.ok){ready=true;break}}catch(e){}await new Promise(r=>setTimeout(r,100))}
    check('browser.ready',ready); if(!ready)throw new Error('Chrome DevTools 未就绪');
    const tab=await (await fetch('http://127.0.0.1:'+port+'/json/new?'+encodeURIComponent(PAGE_URL),{method:'PUT'})).json();
    cdp=await Cdp.c(tab.webSocketDebuggerUrl); await cdp.send('Runtime.enable');
    check('page.ready',await wait(cdp,"typeof window.middleBrainCompressPipeline==='function' && typeof window.middleBrainAdmissionGate==='function' && typeof window._mbDecisionFromSignals==='function' && typeof window.MB_GATE_DEFAULTS==='object'",20000));
    await ev(cdp,"window.confirm=function(){return true;}");
    /* 配置 Astra mock 端点 + 开启 Admission Gate（默认开启） */
    const ep='http://127.0.0.1:'+mock.port+'/v1/responses';
    await ev(cdp,"(async function(){await saveMiddleBrainConfig({enabled:true,endpoint:'"+ep+"',model:'gpt-6-astra',apiKey:'sk-x',admissionEnabled:true});})()");
    check('mb.configReady',await ev(cdp,"(async function(){return await middleBrainReady()===true})()"));

    /* =====================================================
       A. 纯判定单元（注入 signals/state/now，确定性、无 LLM、无 DB）
       ===================================================== */
    const D='window._mbDecisionFromSignals';
    const base='{contextChars:300,dialogueChars:20,memoryItems:1,understandingItems:0,threadItems:0,momentItems:0,localCompressionRatio:1,duplicateRatio:0,conflictSignal:false,multipleThreads:false,nearBudget:false}';
    /* ① 短消息 + 简单 Context → NO */
    check('gate.short.no',await ev(cdp,"(function(){var d="+D+"("+base+",{gate:{}},{},0);return d.useAstra===false&&d.reason==='simple_context'})()"));
    /* ② 普通对话 → NO（中等但不达阈值） */
    check('gate.normal.no',await ev(cdp,"(function(){var d="+D+"({contextChars:1500,dialogueChars:400,memoryItems:2,understandingItems:1,threadItems:1,momentItems:0,localCompressionRatio:0.95,conflictSignal:false,multipleThreads:false,nearBudget:false},{gate:{}},{},0);return d.useAstra===false&&d.reason==='simple_context'})()"));
    /* ③ 超长 Context（接近预算）→ YES */
    check('gate.long.yes',await ev(cdp,"(function(){var d="+D+"({contextChars:8000,dialogueChars:300,memoryItems:1,understandingItems:1,threadItems:1,momentItems:0,localCompressionRatio:1,conflictSignal:false,multipleThreads:false,nearBudget:true},{gate:{}},{},0);return d.useAstra===true&&d.reason==='near_budget'})()"));
    /* ④ 高复杂度 Context（多条目+高冗余，非硬触发）→ context_complexity YES */
    check('gate.complex.yes',await ev(cdp,"(function(){var d="+D+"({contextChars:4000,dialogueChars:3000,memoryItems:8,understandingItems:1,threadItems:1,momentItems:1,localCompressionRatio:0.30,duplicateRatio:0.5,conflictSignal:false,multipleThreads:false,nearBudget:false},{gate:{}},{},0);return d.useAstra===true&&d.reason==='context_complexity'})()"));
    /* ⑤ 多 Thread / Understanding → YES */
    check('gate.multiThread.yes',await ev(cdp,"(function(){var d="+D+"({contextChars:1000,dialogueChars:100,memoryItems:1,understandingItems:2,threadItems:2,momentItems:0,localCompressionRatio:1,conflictSignal:false,multipleThreads:true,nearBudget:false},{gate:{}},{},0);return d.useAstra===true&&d.reason==='multiple_threads'})()"));
    /* ⑥ 明显冲突信号 → YES */
    check('gate.conflict.yes',await ev(cdp,"(function(){var d="+D+"({contextChars:1000,dialogueChars:100,memoryItems:1,understandingItems:0,threadItems:0,momentItems:0,localCompressionRatio:1,conflictSignal:true,multipleThreads:false,nearBudget:false},{gate:{}},{},0);return d.useAstra===true&&d.reason==='conflict_signal'})()"));
    /* ⑦ cooldown 生效：刚 YES 过（未到冷却间隔）→ NO 冷却（即使同样高复杂度） */
    const T=100000000;
    check('gate.cooldown.no',await ev(cdp,"(function(){var sig={contextChars:4000,dialogueChars:3000,memoryItems:8,understandingItems:1,threadItems:1,momentItems:1,localCompressionRatio:0.30,conflictSignal:false,multipleThreads:false,nearBudget:false};var d="+D+"(sig,{gate:{}},{lastAstraAt:"+(T-5000)+",lastDecision:'yes',lastDecisionAt:"+(T-5000)+"},"+T+");return d.useAstra===false&&d.reason==='cooldown'})()"));
    /* ⑧ hysteresis 生效：近期 YES 且分在 [scoreHold, scoreOn) 之间 → hysteresis_hold YES */
    check('gate.hysteresis.yes',await ev(cdp,"(function(){var sig={contextChars:4500,dialogueChars:1500,memoryItems:2,understandingItems:1,threadItems:1,momentItems:0,localCompressionRatio:0.45,conflictSignal:false,multipleThreads:false,nearBudget:false};var d="+D+"(sig,{gate:{}},{lastDecision:'yes',lastDecisionAt:"+(T-1000)+"},"+T+");return d.useAstra===true&&d.reason==='hysteresis_hold'})()"));
    /* ⑨ 相同信号但冷状态 → 回到 NO（证明迟滞是"保持"而非必然 YES） */
    check('gate.hysteresis.coldNo',await ev(cdp,"(function(){var sig={contextChars:4500,dialogueChars:1500,memoryItems:2,understandingItems:1,threadItems:1,momentItems:0,localCompressionRatio:0.45,conflictSignal:false,multipleThreads:false,nearBudget:false};var d="+D+"(sig,{gate:{}},{},0);return d.useAstra===false&&d.reason==='simple_context'})()"));
    /* ⑩ Gate disabled → 完全恢复 Phase 1（永远允许 Astra） */
    check('gate.disabled.bypass',await ev(cdp,"(async function(){await saveMiddleBrainConfig({admissionEnabled:false});var g=await middleBrainAdmissionGate('gd','hi',{signals:"+base+"});await saveMiddleBrainConfig({admissionEnabled:true});return g.useAstra===true&&g.reason==='gate_disabled'})()"));
    /* ⑪ 未配置/未启用 Astra → astra_not_ready NO */
    check('gate.notReady.no',await ev(cdp,"(async function(){var old=await getMiddleBrainConfig();await saveMiddleBrainConfig({enabled:false});var g=await middleBrainAdmissionGate('gnr','hi',{signals:"+base+"});await saveMiddleBrainConfig({enabled:old.enabled,endpoint:old.endpoint,model:old.model,apiKey:old.apiKey,admissionEnabled:true});return g.useAstra===false&&g.reason==='astra_not_ready'})()"));

    /* =====================================================
       B. 管线级（mock 请求计数）：Gate 决定是否真的走 Astra 网络
       ===================================================== */
    /* ⑫ Gate NO → 不产生任何 Astra 网络请求（mock.count 不增），走 local */
    mock.count=0; mock.mode='ok';
    let r=await ev(cdp,"(async function(){var res=await middleBrainCompressPipeline('gn1','你好',{memoryCtx:''});return {src:res.source,adm:res.admission,ctx:res.compressedContext};})()");
    let cnt=mock.count;
    check('gate.no.noFetch',r.src==='local'&&cnt===0,JSON.stringify({src:r.src,mock:cnt}));
    /* ⑬ Gate YES → Astra 正常调用（mock.count 增 1，source astra） */
    mock.payload=JSON.stringify({keep:['x'],merge:[],drop:[],compressedContext:'已整理。\n【当前对话】用户问：我该换什么设备',currentKept:true});
    mock.count=0;
    r=await ev(cdp,"(async function(){var res=await middleBrainCompressPipeline('gn2','用户问：我该换什么设备',{memoryCtx:'甲'.repeat(9000),dialogue:['用户问：我该换什么设备']});return {src:res.source,adm:res.admission,ctx:res.compressedContext};})()");
    cnt=mock.count;
    check('gate.yes.astraCalled',r.src==='astra'&&cnt===1,JSON.stringify({src:r.src,mock:cnt}));
    check('gate.yes.reason',r.adm&&r.adm.reason==='near_budget',JSON.stringify(r.adm));
    /* ⑭ Astra 超时 → local fallback（Gate 虽 YES，但调用失败安全回落） */
    mock.mode='slow'; mock.payload=JSON.stringify({keep:[],merge:[],drop:[],compressedContext:'超时不应采用',currentKept:true});
    mock.count=0;
    r=await ev(cdp,"(async function(){var res=await middleBrainCompressPipeline('gn3','用户问：现在几点',{memoryCtx:'乙'.repeat(9000),timeoutMs:500});return {src:res.source,mock:0,ctx:res.compressedContext};})()");
    cnt=mock.count;
    check('gate.yes.timeoutFallbackLocal',r.src==='local'&&cnt===1,JSON.stringify({src:r.src,mock:cnt}));
    /* ⑮ Astra 500 → local fallback */
    mock.mode='fail'; mock.payload=''; mock.count=0;
    r=await ev(cdp,"(async function(){var res=await middleBrainCompressPipeline('gn4','用户问：午饭',{memoryCtx:'丙'.repeat(9000)});return {src:res.source,mock:0,ctx:res.compressedContext};})()");
    cnt=mock.count;
    check('gate.yes.failFallbackLocal',r.src==='local'&&cnt===1,JSON.stringify({src:r.src,mock:cnt}));
    mock.mode='ok';

    /* ⑯ 当前 userMessage 与 recent dialogue 始终保留（Gate NO local 路径） */
    r=await ev(cdp,"(async function(){var res=await middleBrainCompressPipeline('gp','用户问：今天想吃什么',{memoryCtx:'【记忆】她爱吃面食。',dialogue:['近期：她说想安静。']});return {src:res.source,ctx:res.compressedContext};})()");
    check('gate.preserve.userMessage',String(r.ctx).indexOf('今天想吃什么')>=0,JSON.stringify(r.ctx));
    check('gate.preserve.recentDialogue',String(r.ctx).indexOf('想安静')>=0,JSON.stringify(r.ctx));

    /* ⑰ Memory / Understanding / Thread 零写入（Gate 与 Astra 只读） */
    check('gate.zeroWrite',await ev(cdp,"(async function(){var mem=await dbGetAll('memories');var und=await dbGetAll('understandings');var th=await dbGetAll('threads');var mom=await dbGetAll('moments');return (mem||[]).length===0&&(und||[]).length===0&&(th||[]).length===0&&(mom||[]).length===0})()"));
    /* ⑱ Character Provider 不变（apiConfigs 无新建 / 不触碰角色链） */
    check('gate.providerUntouched',await ev(cdp,"(async function(){var cfgs=apiConfigs||[];return cfgs.length===0})()"));

    /* ⑲ 信号分析 diagnostic 形状（含要求示例字段） */
    check('gate.signals.shape',await ev(cdp,"(async function(){var s=await window._middleBrain._mbAnalyzeSignals('gs','用户问：<x>',{memoryCtx:'甲'.repeat(120),understandingCtx:'乙',threadCtx:'丙'},{gate:{}});return typeof s.contextChars==='number'&&typeof s.dialogueChars==='number'&&typeof s.memoryItems==='number'&&typeof s.understandingItems==='number'&&typeof s.threadItems==='number'&&typeof s.localCompressionRatio==='number'&&typeof s.conflictSignal==='boolean'&&typeof s.multipleThreads==='boolean'&&typeof s.nearBudget==='boolean'})()"));
    /* ⑳ admission gate 返回可诊断结果 {useAstra, reason, signals} */
    check('gate.diagnostic.shape',await ev(cdp,"(async function(){var g=await middleBrainAdmissionGate('gdiag','用户问：<y>',{signals:{contextChars:4500,dialogueChars:1500,memoryItems:2,understandingItems:1,threadItems:1,momentItems:0,localCompressionRatio:0.45,conflictSignal:false,multipleThreads:false,nearBudget:false},now:0});return typeof g.useAstra==='boolean'&&typeof g.reason==='string'&&g.signals&&typeof g.signals.contextChars==='number'})()"));
  } finally { if(cdp)cdp.close(); try{browser.kill()}catch(e){} try{mock.server&&mock.server.close()}catch(e){} }
  console.log(failures===0?'\nMiddle Brain Phase 2 Admission Gate CDP passed ✔':'\nMiddle Brain Phase 2 Admission Gate CDP FAILED ✘');
  process.exit(failures?1:0);
}
main().catch(e=>{console.error(e);process.exit(1)});
