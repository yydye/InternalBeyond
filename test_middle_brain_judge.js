/* ====================================================================
   Middle Brain Phase 3 · Astra Context Judge · CDP 测试（mock Astra 端点）
   覆盖：compression success→Judge 调 1 次 / Gate NO→Judge 0 次 /
        fallback local→Judge 0 次 / Judge disabled→Judge 0 次 /
        Judge 正常 JSON 解析 / malformed→null / HTTP 500→null /
        timeout→null / contradiction·duplicate·stale·missing_context·
        current_turn_coverage 识别 / Judge 不修改 compressedContext /
        Judge 零写入 Memory·Understanding·Thread / Character Provider 不变 /
        Admission Gate 行为不变。
   只测 Middle Brain；不改生产代码。运行：node test_middle_brain_judge.js
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
  const mock={server:null,port:0,compCount:0,judgeCount:0,compMode:'ok',judgeMode:'ok',
    compPayload:JSON.stringify({keep:['x'],merge:[],drop:[],compressedContext:'已整理。\n【当前对话】用户问：我该换什么设备',currentKept:true}),
    judgePayload:JSON.stringify({relevance:0.92,contradiction:{detected:true,items:['记忆A说喜欢，后却说讨厌']},stale:['去年的计划'],duplicate:['两条重复记忆'],missing_context:['她的工作安排'],current_turn_coverage:1.0,compression_quality:0.88,overall:0.90,warnings:[]})};
  mock.server=http.createServer((req,res)=>{const H={'Content-Type':'application/json','Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,POST,OPTIONS','Access-Control-Allow-Headers':'Content-Type,Authorization'};if(req.method==='OPTIONS'){res.writeHead(204,H);res.end();return}if(req.method==='POST'&&req.url.includes('/responses')){let ch=[];req.on('data',c=>ch.push(c));req.on('end',()=>{const body=Buffer.concat(ch).toString('utf8');const isJudge=/context_quality_report/.test(body);if(isJudge){mock.judgeCount++;if(mock.judgeMode==='fail'){res.writeHead(500,H);res.end(JSON.stringify({error:'boom'}));return}if(mock.judgeMode==='slow'){setTimeout(()=>{res.writeHead(200,H);res.end(JSON.stringify({output:[{type:'message',content:[{type:'output_text',text:mock.judgePayload}]}],usage:{input_tokens:5,output_tokens:3,total_tokens:8}}))},3000);return}res.writeHead(200,H);res.end(JSON.stringify({output:[{type:'message',content:[{type:'output_text',text:mock.judgePayload}]}],usage:{input_tokens:5,output_tokens:3,total_tokens:8}}));return}mock.compCount++;if(mock.compMode==='fail'){res.writeHead(500,H);res.end(JSON.stringify({error:'boom'}));return}if(mock.compMode==='slow'){setTimeout(()=>{res.writeHead(200,H);res.end(JSON.stringify({output:[{type:'message',content:[{type:'output_text',text:mock.compPayload}]}],usage:{input_tokens:5,output_tokens:3,total_tokens:8}}))},3000);return}res.writeHead(200,H);res.end(JSON.stringify({output:[{type:'message',content:[{type:'output_text',text:mock.compPayload}]}],usage:{input_tokens:5,output_tokens:3,total_tokens:8}}))});return}res.writeHead(404,H);res.end(JSON.stringify({error:'nf'}))}).listen(0,'127.0.0.1',()=>{mock.port=mock.server.address().port});
  const port=await freePort(), profile=fs.mkdtempSync(path.join(os.tmpdir(),'ib-judge-'));
  const browser=spawn(chrome,['--headless=new','--disable-gpu','--no-sandbox','--no-first-run','--allow-file-access-from-files','--force-color-profile=srgb','--window-size=1100,760','--remote-debugging-address=127.0.0.1','--remote-debugging-port='+port,'--user-data-dir='+profile,'about:blank'],{stdio:'ignore'});
  let failures=0; const check=(n,c,d='')=>{if(c)console.log('  PASS  '+n);else{failures++;console.error('  FAIL  '+n+(d?'  -> '+d:''))}};
  let cdp; try{
    let ready=false;for(let i=0;i<120;i++){try{const r=await fetch('http://127.0.0.1:'+port+'/json/version');if(r.ok){ready=true;break}}catch(e){}await new Promise(r=>setTimeout(r,100))}
    check('browser.ready',ready); if(!ready)throw new Error('Chrome DevTools 未就绪');
    const tab=await (await fetch('http://127.0.0.1:'+port+'/json/new?'+encodeURIComponent(PAGE_URL),{method:'PUT'})).json();
    cdp=await Cdp.c(tab.webSocketDebuggerUrl); await cdp.send('Runtime.enable');
    check('page.ready',await wait(cdp,"typeof window.middleBrainCompressPipeline==='function' && typeof window.middleBrainAstraJudge==='function' && typeof window._mbParseJudgeJson==='function'",20000));
    await ev(cdp,"window.confirm=function(){return true;}");
    const ep='http://127.0.0.1:'+mock.port+'/v1/responses';
    /* 配置 Astra mock + 开启 Admission Gate + 开启 Judge */
    await ev(cdp,"(async function(){await saveMiddleBrainConfig({enabled:true,endpoint:'"+ep+"',model:'gpt-6-astra',apiKey:'sk-x',admissionEnabled:true,middleBrainJudgeEnabled:true});await middleBrainJudgeReset();})()");
    check('mb.configReady',await ev(cdp,"(async function(){return await middleBrainReady()===true})()"));

    /* ============ A. 调用条件（mock 计数） ============ */
    /* ① Astra compression success → Judge 调用 1 次 */
    mock.compCount=0; mock.judgeCount=0; mock.compMode='ok'; mock.judgeMode='ok';
    let r=await ev(cdp,"(async function(){var res=await middleBrainCompressPipeline('j1','用户问：我该换什么设备',{memoryCtx:'甲'.repeat(9000),dialogue:['用户问：我该换什么设备']});return {src:res.source,adm:res.admission,j:res.judge?{rel:res.judge.relevance,cd:res.judge.contradiction.detected,ov:res.judge.overall,ctc:res.judge.current_turn_coverage}:null,ctx:res.compressedContext};})()");
    check('judge.calledOnCompress',r.src==='astra'&&mock.compCount===1&&mock.judgeCount===1,JSON.stringify({src:r.src,comp:mock.compCount,judge:mock.judgeCount}));
    check('judge.parsed',!!r.j&&r.j.rel===0.92&&r.j.cd===true&&r.j.ov===0.90&&r.j.ctc===1.0,JSON.stringify(r.j));
    check('judge.contradictionDetected',!!r.j&&r.j.cd===true,JSON.stringify(r.j));
    check('judge.compressedContextIntact',String(r.ctx).indexOf('已整理')>=0&&String(r.ctx).indexOf('我该换什么设备')>=0,JSON.stringify(r.ctx));

    /* ② Admission Gate NO → Judge 调用 0 次（不触发压缩也不触发 Judge） */
    mock.compCount=0; mock.judgeCount=0;
    r=await ev(cdp,"(async function(){var res=await middleBrainCompressPipeline('j2','你好',{memoryCtx:''});return {src:res.source,j:res.judge||null};})()");
    check('judge.gateNoZero',r.src==='local'&&mock.compCount===0&&mock.judgeCount===0&&(r.j===null||r.j===undefined),JSON.stringify({src:r.src,comp:mock.compCount,judge:mock.judgeCount}));

    /* ③ Astra compression fallback local → Judge 调用 0 次 */
    mock.compMode='fail'; mock.judgeMode='ok'; mock.compCount=0; mock.judgeCount=0;
    r=await ev(cdp,"(async function(){var res=await middleBrainCompressPipeline('j3','用户问：午饭',{memoryCtx:'甲'.repeat(9000)});return {src:res.source,j:res.judge||null};})()");
    check('judge.fallbackLocalZero',r.src==='local'&&mock.compCount===1&&mock.judgeCount===0&&(r.j===null||r.j===undefined),JSON.stringify({src:r.src,comp:mock.compCount,judge:mock.judgeCount}));

    /* ④ Judge disabled → Judge 调用 0 次，Phase 2 行为不变 */
    await ev(cdp,"(async function(){await saveMiddleBrainConfig({middleBrainJudgeEnabled:false});})()");
    mock.compMode='ok'; mock.compCount=0; mock.judgeCount=0;
    r=await ev(cdp,"(async function(){var res=await middleBrainCompressPipeline('j4','用户问：我该换什么设备',{memoryCtx:'甲'.repeat(9000),dialogue:['用户问：我该换什么设备']});return {src:res.source,j:res.judge||null};})()");
    check('judge.disabledZero',r.src==='astra'&&mock.compCount===1&&mock.judgeCount===0&&(r.j===null||r.j===undefined),JSON.stringify({src:r.src,comp:mock.compCount,judge:mock.judgeCount}));
    await ev(cdp,"(async function(){await saveMiddleBrainConfig({middleBrainJudgeEnabled:true});})()");

    /* ⑤ Judge HTTP 500 → null，不影响 compression（source 仍 astra，compressedContext 保留） */
    mock.compMode='ok'; mock.judgeMode='fail'; mock.compCount=0; mock.judgeCount=0;
    r=await ev(cdp,"(async function(){var res=await middleBrainCompressPipeline('j5','用户问：我该换什么设备',{memoryCtx:'甲'.repeat(9000),dialogue:['用户问：我该换什么设备']});return {src:res.source,j:res.judge||null,ctx:res.compressedContext};})()");
    check('judge.http500Null',r.src==='astra'&&mock.compCount===1&&mock.judgeCount===1&&(r.j===null||r.j===undefined)&&String(r.ctx).indexOf('已整理')>=0,JSON.stringify({src:r.src,comp:mock.compCount,judge:mock.judgeCount,ctx:r.ctx}));

    /* ⑥ Judge timeout → null，不影响 compression */
    mock.judgeMode='slow'; mock.compCount=0; mock.judgeCount=0;
    r=await ev(cdp,"(async function(){var res=await middleBrainCompressPipeline('j6','用户问：我该换什么设备',{memoryCtx:'甲'.repeat(9000),dialogue:['用户问：我该换什么设备'],timeoutMs:400});return {src:res.source,j:res.judge||null};})()");
    check('judge.timeoutNull',r.src==='astra'&&mock.compCount===1&&mock.judgeCount===1&&(r.j===null||r.j===undefined),JSON.stringify({src:r.src,comp:mock.compCount,judge:mock.judgeCount}));

    /* ⑦ Judge malformed JSON → null，不影响 compression（未做第二次 Compression） */
    mock.judgeMode='ok'; mock.judgePayload='这不是JSON'; mock.compCount=0; mock.judgeCount=0;
    r=await ev(cdp,"(async function(){var res=await middleBrainCompressPipeline('j7','用户问：我该换什么设备',{memoryCtx:'甲'.repeat(9000),dialogue:['用户问：我该换什么设备']});return {src:res.source,j:res.judge||null,comp:res.structured?'ok':'ok'};})()");
    check('judge.malformedNull',r.src==='astra'&&mock.compCount===1&&mock.judgeCount===1&&(r.j===null||r.j===undefined),JSON.stringify({src:r.src,comp:mock.compCount,judge:mock.judgeCount}));
    mock.judgePayload=JSON.stringify({relevance:0.92,contradiction:{detected:true,items:['记忆A说喜欢，后却说讨厌']},stale:['去年的计划'],duplicate:['两条重复记忆'],missing_context:['她的工作安排'],current_turn_coverage:1.0,compression_quality:0.88,overall:0.90,warnings:[]});

    /* ⑧ Judge 不写入 Memory / Understanding / Thread / Moments（IndexedDB 零写入） */
    check('judge.zeroWrite',await ev(cdp,"(async function(){var mem=await dbGetAll('memories');var und=await dbGetAll('understandings');var th=await dbGetAll('threads');var mom=await dbGetAll('moments');return (mem||[]).length===0&&(und||[]).length===0&&(th||[]).length===0&&(mom||[]).length===0})()"));
    /* ⑨ Character Provider 不变 */
    check('judge.providerUntouched',await ev(cdp,"(async function(){var cfgs=apiConfigs||[];return cfgs.length===0})()"));
    /* ⑩ Admission Gate 行为不变（长 Context 仍 near_budget YES） */
    r=await ev(cdp,"(async function(){var g=await middleBrainAdmissionGate('jgate','用户问：x',{signals:{contextChars:8000,dialogueChars:300,memoryItems:1,understandingItems:1,threadItems:1,momentItems:0,localCompressionRatio:1,conflictSignal:false,multipleThreads:false,nearBudget:true},now:0});return {ua:g.useAstra,reason:g.reason};})()");
    check('judge.gateStillWorks',r.ua===true&&r.reason==='near_budget',JSON.stringify(r));

    /* ============ B. 解析/识别单元（_mbParseJudgeJson） ============ */
    check('judge.parse.normal',await ev(cdp,"(function(){var j=_mbParseJudgeJson(JSON.stringify({relevance:0.92,contradiction:{detected:true,items:['A与B矛盾']},stale:['旧计划'],duplicate:['重复'],missing_context:['缺工作'],current_turn_coverage:1.0,compression_quality:0.88,overall:0.90,warnings:['w']}));return !!j&&j.relevance===0.92&&j.contradiction.detected===true&&j.contradiction.items[0]==='A与B矛盾'&&j.stale[0]==='旧计划'&&j.duplicate[0]==='重复'&&j.missing_context[0]==='缺工作'&&j.current_turn_coverage===1.0&&j.warnings[0]==='w'})()"));
    check('judge.parse.malformedNull',await ev(cdp,"(function(){return _mbParseJudgeJson('垃圾文本，非JSON')===null&&_mbParseJudgeJson('{\"bad\"')===null&&_mbParseJudgeJson('')===null})()"));
    check('judge.parse.clamp',await ev(cdp,"(function(){var j=_mbParseJudgeJson(JSON.stringify({relevance:1.7,contradiction:{detected:false,items:[]},stale:[],duplicate:[],missing_context:[],current_turn_coverage:-0.5,compression_quality:2,overall:0.5,warnings:[]}));return j.relevance===1&&j.current_turn_coverage===0&&j.compression_quality===1&&j.overall===0.5})()"));
    check('judge.parse.staleDupMiss',await ev(cdp,"(function(){var j=_mbParseJudgeJson(JSON.stringify({relevance:0.5,contradiction:{detected:false,items:[]},stale:['s1','s2'],duplicate:['d1'],missing_context:['m1'],current_turn_coverage:0.8,compression_quality:0.6,overall:0.6,warnings:[]}));return j.stale.length===2&&j.duplicate.length===1&&j.missing_context.length===1})()"));
    /* telemetry 最小观测：attempted>=1、含 overall 等数值 */
    check('judge.telemetry',await ev(cdp,"(function(){var t=middleBrainJudgeTelemetry();return typeof t.attempted==='number'&&t.attempted>=1&&typeof t.success==='number'&&typeof t.totalLatencyMs==='number'&&typeof t.contradictionDetected==='number'&&typeof t.missingTotal==='number'&&typeof t.staleTotal==='number'&&typeof t.duplicateTotal==='number'&&typeof t.currentTurnCoverageSum==='number'&&t.last&&typeof t.last.overall==='number'})()"));
  } finally { if(cdp)cdp.close(); try{browser.kill()}catch(e){} try{mock.server&&mock.server.close()}catch(e){} }
  console.log(failures===0?'\nMiddle Brain Phase 3 Context Judge CDP passed ✔':'\nMiddle Brain Phase 3 Context Judge CDP FAILED ✘');
  process.exit(failures?1:0);
}
main().catch(e=>{console.error(e);process.exit(1)});
