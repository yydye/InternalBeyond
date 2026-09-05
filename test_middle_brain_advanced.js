/* ====================================================================
   Middle Brain Phase 4 · Astra Advanced Settings · CDP 测试
   覆盖：默认 reasoningEffort/speed / 全档保存恢复 / 非法回退默认 /
        老配置无字段 → 默认 / Responses 映射逐档 reasoning.effort /
        speed→service_tier 官方映射（fast 发送、standard 省略）/
        不出现 temperature·top_p·logprobs·reasoning_effort·伪造 speed /
        Compression 与 Judge 均继承当前 reasoning/speed /
        Admission Gate 不变 / Memory / Character Provider 不变。
   只测 Middle Brain；不改生产代码。运行：node test_middle_brain_advanced.js
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
  const mock={server:null,port:0,bodies:[],compCount:0,judgeCount:0,
    compPayload:JSON.stringify({keep:['x'],merge:[],drop:[],compressedContext:'已整理。\n【当前对话】用户问：我该换什么设备',currentKept:true}),
    judgePayload:JSON.stringify({relevance:0.92,contradiction:{detected:false,items:[]},stale:[],duplicate:[],missing_context:[],current_turn_coverage:1.0,compression_quality:0.88,overall:0.90,warnings:[]})};
  mock.server=http.createServer((req,res)=>{const H={'Content-Type':'application/json','Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,POST,OPTIONS','Access-Control-Allow-Headers':'Content-Type,Authorization'};if(req.method==='OPTIONS'){res.writeHead(204,H);res.end();return}if(req.method==='POST'&&req.url.includes('/responses')){let ch=[];req.on('data',c=>ch.push(c));req.on('end',()=>{const bodyStr=Buffer.concat(ch).toString('utf8');let body={};try{body=JSON.parse(bodyStr)}catch(e){}mock.bodies.push(body);const isJudge=/context_quality_report/.test(bodyStr);if(isJudge){mock.judgeCount++;}else{mock.compCount++;}const payload=isJudge?mock.judgePayload:mock.compPayload;res.writeHead(200,H);res.end(JSON.stringify({output:[{type:'message',content:[{type:'output_text',text:payload}]}],usage:{input_tokens:5,output_tokens:3,total_tokens:8}}));});return}res.writeHead(404,H);res.end(JSON.stringify({error:'nf'}))}).listen(0,'127.0.0.1',()=>{mock.port=mock.server.address().port});
  const port=await freePort(), profile=fs.mkdtempSync(path.join(os.tmpdir(),'ib-adv-'));
  const browser=spawn(chrome,['--headless=new','--disable-gpu','--no-sandbox','--no-first-run','--allow-file-access-from-files','--force-color-profile=srgb','--window-size=1100,760','--remote-debugging-address=127.0.0.1','--remote-debugging-port='+port,'--user-data-dir='+profile,'about:blank'],{stdio:'ignore'});
  let failures=0; const check=(n,c,d='')=>{if(c)console.log('  PASS  '+n);else{failures++;console.error('  FAIL  '+n+(d?'  -> '+d:''))}};
  let cdp; try{
    let ready=false;for(let i=0;i<120;i++){try{const r=await fetch('http://127.0.0.1:'+port+'/json/version');if(r.ok){ready=true;break}}catch(e){}await new Promise(r=>setTimeout(r,100))}
    check('browser.ready',ready); if(!ready)throw new Error('Chrome DevTools 未就绪');
    const tab=await (await fetch('http://127.0.0.1:'+port+'/json/new?'+encodeURIComponent(PAGE_URL),{method:'PUT'})).json();
    cdp=await Cdp.c(tab.webSocketDebuggerUrl); await cdp.send('Runtime.enable');
    check('page.ready',await wait(cdp,"typeof window.buildMiddleBrainResponsesRequest==='function' && typeof window.normalizeMiddleBrainReasoningEffort==='function'",20000));
    await ev(cdp,"window.confirm=function(){return true;}");
    const ep='http://127.0.0.1:'+mock.port+'/v1/responses';
    await ev(cdp,"(async function(){await saveMiddleBrainConfig({enabled:true,endpoint:'"+ep+"',model:'gpt-6-astra',apiKey:'sk-x',admissionEnabled:true,middleBrainJudgeEnabled:true});})()");

    /* ============ A. 配置：默认 / 保存恢复 / 非法回退 / 老配置 ============ */
    /* ① 默认 reasoningEffort=medium, speed=standard */
    check('cfg.defaults',await ev(cdp,"(async function(){var c=await getMiddleBrainConfig();return c.reasoningEffort==='medium'&&c.speed==='standard'})()"));
    /* ② 全档 reasoning 保存恢复 */
    check('cfg.reasoning.all',await ev(cdp,"(async function(){var ok=true;var a=['low','medium','high','xhigh','max'];for(var i=0;i<a.length;i++){await saveMiddleBrainConfig({reasoningEffort:a[i]});var c=await getMiddleBrainConfig();if(c.reasoningEffort!==a[i])ok=false}return ok})()"));
    /* ③ speed 两档保存恢复（顺序 await） */
    check('cfg.speed.all',await ev(cdp,"(async function(){var ok=true;for(var i=0;i<2;i++){var s=['standard','fast'][i];await saveMiddleBrainConfig({speed:s});var c=await getMiddleBrainConfig();if(c.speed!==s)ok=false}return ok})()"));
    /* ④ 非法 reasoning → 请求层回退 medium */
    check('normalize.reasoning.invalid',await ev(cdp,"(function(){return normalizeMiddleBrainReasoningEffort('banana')==='medium'&&normalizeMiddleBrainReasoningEffort('HIGH')==='high'&&normalizeMiddleBrainReasoningEffort(null)==='medium'})()"));
    /* ⑤ 非法 speed → standard */
    check('normalize.speed.invalid',await ev(cdp,"(function(){return normalizeMiddleBrainSpeed('turbo')==='standard'&&normalizeMiddleBrainSpeed('FAST')==='fast'&&normalizeMiddleBrainSpeed(null)==='standard'})()"));
    /* ⑥ 老配置无字段 → 正常工作（默认 medium/standard 注入请求）。
       用 dbPut 直写一份旧格式（无 reasoningEffort/speed），getMiddleBrainConfig 合并默认 -> medium/standard。 */
    check('cfg.legacyNoFields',await ev(cdp,"(async function(){await dbPut('apiSettings',{id:'middle_brain',enabled:true,endpoint:'"+ep+"',model:'gpt-6-astra',apiKey:'sk-x'});var c=await getMiddleBrainConfig();var q=await buildMiddleBrainResponsesRequest(null,[{role:'user',content:'x'}],{});return c.reasoningEffort==='medium'&&c.speed==='standard'&&q.body.reasoning && q.body.reasoning.effort==='medium'&&!('service_tier' in q.body)})()"));

    /* ============ B. Responses 映射逐档 ============ */
    check('map.low',await ev(cdp,"(async function(){var q=await buildMiddleBrainResponsesRequest(null,[{role:'user',content:'x'}],{reasoningEffort:'low'});return q.body.reasoning.effort==='low'})()"));
    check('map.medium',await ev(cdp,"(async function(){var q=await buildMiddleBrainResponsesRequest(null,[{role:'user',content:'x'}],{reasoningEffort:'medium'});return q.body.reasoning.effort==='medium'})()"));
    check('map.high',await ev(cdp,"(async function(){var q=await buildMiddleBrainResponsesRequest(null,[{role:'user',content:'x'}],{reasoningEffort:'high'});return q.body.reasoning.effort==='high'})()"));
    check('map.xhigh',await ev(cdp,"(async function(){var q=await buildMiddleBrainResponsesRequest(null,[{role:'user',content:'x'}],{reasoningEffort:'xhigh'});return q.body.reasoning.effort==='xhigh'})()"));
    check('map.max',await ev(cdp,"(async function(){var q=await buildMiddleBrainResponsesRequest(null,[{role:'user',content:'x'}],{reasoningEffort:'max'});return q.body.reasoning.effort==='max'})()"));
    /* speed 映射 */
    check('map.speed.standard',await ev(cdp,"(async function(){var q=await buildMiddleBrainResponsesRequest(null,[{role:'user',content:'x'}],{speed:'standard'});return !('service_tier' in q.body)&&!('speed' in q.body)})()"));
    check('map.speed.fast',await ev(cdp,"(async function(){var q=await buildMiddleBrainResponsesRequest(null,[{role:'user',content:'x'}],{speed:'fast'});return q.body.service_tier==='fast'&&!('speed' in q.body)})()"));
    /* 不出现旧参数 / 伪造字段 / 默认档无 service_tier */
    check('map.noOldOrFake',await ev(cdp,"(async function(){var q=await buildMiddleBrainResponsesRequest(null,[{role:'user',content:'x'}],{reasoningEffort:'high',speed:'fast'});return !('temperature' in q.body)&&!('top_p' in q.body)&&!('logprobs' in q.body)&&!('reasoning_effort' in q.body)&&!('speed' in q.body)&&q.body.reasoning.effort==='high'&&q.body.service_tier==='fast'})()"));
    /* 显式 options 覆盖配置 */
    check('map.overrideConfig',await ev(cdp,"(async function(){await saveMiddleBrainConfig({reasoningEffort:'low',speed:'standard'});var q=await buildMiddleBrainResponsesRequest(null,[{role:'user',content:'x'}],{reasoningEffort:'max',speed:'fast'});return q.body.reasoning.effort==='max'&&q.body.service_tier==='fast'})()"));

    /* ============ C. Pipeline：Compression 与 Judge 均继承当前 reasoning/speed ============ */
    /* 恢复 admission + judge 开启，设 high+fast（确认 Judge 也继承速度/强度配置） */
    await ev(cdp,"(async function(){await saveMiddleBrainConfig({admissionEnabled:true,middleBrainJudgeEnabled:true,reasoningEffort:'high',speed:'fast'});})()");
    mock.bodies=[]; mock.compCount=0; mock.judgeCount=0;
    let r=await ev(cdp,"(async function(){var res=await middleBrainCompressPipeline('pa','用户问：我该换什么设备',{memoryCtx:'甲'.repeat(9000),dialogue:['用户问：我该换什么设备']});return {src:res.source,j:res.judge?{rel:res.judge.relevance}:null};})()");
    check('pipeline.inheritHighFast',(function(){const all=mock.bodies;return mock.compCount===1&&mock.judgeCount===1&&all.length===2&&all.every(function(b){return b.reasoning&&b.reasoning.effort==='high'&&b.service_tier==='fast'})})(),JSON.stringify({comp:mock.compCount,judge:mock.judgeCount,bodies:mock.bodies.map(function(b){return {e:b.reasoning&&b.reasoning.effort,st:b.service_tier}}) }));
    check('pipeline.judgeSameConfig',r.j&&r.j.rel===0.92&&r.src==='astra',JSON.stringify(r));
    /* 默认档（standard）不发送 service_tier，压缩与 judge 均无 */
    await ev(cdp,"(async function(){await saveMiddleBrainConfig({reasoningEffort:'medium',speed:'standard'});})()");
    mock.bodies=[]; mock.compCount=0; mock.judgeCount=0;
    r=await ev(cdp,"(async function(){var res=await middleBrainCompressPipeline('pb','用户问：我该换什么设备',{memoryCtx:'甲'.repeat(9000),dialogue:['用户问：我该换什么设备']});return {src:res.source};})()");
    check('pipeline.standardOmitsTier',(function(){const all=mock.bodies;return all.length===2&&all.every(function(b){return !('service_tier' in b)&&b.reasoning&&b.reasoning.effort==='medium'})})(),JSON.stringify({comp:mock.compCount,judge:mock.judgeCount}));

    /* ============ D. Regression：Admission Gate / Memory / Character Provider ============ */
    check('regress.admissionGate',await ev(cdp,"(async function(){var g=await middleBrainAdmissionGate('preg','x',{signals:{contextChars:8000,dialogueChars:300,memoryItems:1,understandingItems:1,threadItems:1,momentItems:0,localCompressionRatio:1,conflictSignal:false,multipleThreads:false,nearBudget:true},now:0});return g.useAstra===true&&g.reason==='near_budget'})()"));
    check('regress.zeroWrite',await ev(cdp,"(async function(){var mem=await dbGetAll('memories');var und=await dbGetAll('understandings');var th=await dbGetAll('threads');var mom=await dbGetAll('moments');return (mem||[]).length===0&&(und||[]).length===0&&(th||[]).length===0&&(mom||[]).length===0})()"));
    check('regress.providerUntouched',await ev(cdp,"(async function(){var cfgs=apiConfigs||[];return cfgs.length===0})()"));
    /* ⑤ UI：loadMiddleBrainConfigUI 后 active 状态与配置同步 */
    await ev(cdp,"(async function(){await saveMiddleBrainConfig({reasoningEffort:'high',speed:'fast'});loadMiddleBrainConfigUI();})()");
    check('ui.summarySynced',await ev(cdp,"(function(){var s=document.getElementById('mb-adv-summary');return s&&/High · Fast/.test(s.textContent)})()"));
    /* ⑥ UI（Codex 风格滑动选择）：slider 渲染 / 档位 active / 模型 swiper / 点击与切换 */
    await ev(cdp,"(async function(){await saveMiddleBrainConfig({enabled:true,endpoint:'"+ep+"',model:'gpt-6-astra',apiKey:'sk-x',admissionEnabled:true,middleBrainJudgeEnabled:true,reasoningEffort:'high',speed:'fast'});loadMiddleBrainConfigUI();})()");
    check('ui.sliderBuilt',await ev(cdp,"(function(){return !!document.getElementById('mb-adv-reasoning')&&document.querySelectorAll('#mb-adv-reasoning .mb-tick').length===5&&!!document.querySelector('#mb-adv-speed .mb-speed-btn')&&!!document.querySelector('#mb-adv-reasoning .mb-thumb')})()"));
    check('ui.reasoningActiveHigh',await ev(cdp,"(function(){var a=document.querySelector('#mb-adv-reasoning .mb-tick.mb-tick-active');return a&&a.getAttribute('data-value')==='high'})()"));
    check('ui.speedActiveFast',await ev(cdp,"(function(){var b=document.getElementById('mb-speed-btn');var l=document.getElementById('mb-speed-label');return b&&b.classList.contains('mb-speed-on')&&l&&l.textContent==='Fast'})()"));
    check('ui.modelNameCurrent',await ev(cdp,"(function(){var n=document.getElementById('mb-model-name');return n&&n.textContent==='gpt-6-astra'})()"));
    check('ui.modelCellsRendered',await ev(cdp,"(function(){var cells=document.querySelectorAll('.mb-model-cell');return cells.length===2&&Array.prototype.every.call(cells,function(c){return c.textContent==='gpt-6-astra'||c.textContent==='gpt-5.6-sol'})&&!!document.querySelector('.mb-model-arrow')})()"));
    /* 思考强度 = 拖动滑块（dragOnly）：档位点不可点击跳转、手柄可抓取（拖动手势） */
    check('ui.reasoningTickNotClickable',await ev(cdp,"(async function(){await saveMiddleBrainConfig({reasoningEffort:'medium',speed:'standard'});loadMiddleBrainConfigUI();document.querySelector('#mb-adv-reasoning .mb-tick[data-value=\"max\"]').click();var c=await getMiddleBrainConfig();return c.reasoningEffort==='medium'})()"));
    check('ui.reasoningDragMode',await ev(cdp,"(function(){var rt=document.querySelector('#mb-adv-reasoning .mb-thumb');return rt&&rt.classList.contains('mb-thumb-grab')})()"));
    /* 拖动/切换提交路径 = mbReasoningPick：同步刷新 active 档位 + 当前值标签（持久化已由 cfg.* 异步 await 测试证实） */
    check('ui.reasoningCommitWiring',await ev(cdp,"(function(){mbReasoningPick('high');var a=document.querySelector('#mb-adv-reasoning .mb-tick.mb-tick-active');var v=document.querySelector('#mb-adv-reasoning .mb-adv-slider-value');return a&&a.getAttribute('data-value')==='high'&&v&&v.textContent==='High'})()"));
    /* Speed = ⚡ 闪电按钮：点击切快速模式（紫色激活态），再点回标准；同步刷新 label/<mb-speed-on> */
    await ev(cdp,"(async function(){await saveMiddleBrainConfig({speed:'standard'});loadMiddleBrainConfigUI();})()");
    check('ui.speedBtnToggle',await ev(cdp,"(function(){var b=document.getElementById('mb-speed-btn');var l=document.getElementById('mb-speed-label');b.click();var on=b.classList.contains('mb-speed-on')&&l.textContent==='Fast';b.click();var off=!b.classList.contains('mb-speed-on')&&l.textContent==='Standard';return on&&off})()"));
    /* 模型切换：mbModelPick → 持久化 + 中心标签 + 作用于请求 */
    await ev(cdp,"(async function(){mbModelPick('gpt-5.6-sol')})()");
    check('ui.modelPickPersist',await ev(cdp,"(async function(){var c=await getMiddleBrainConfig();return c.model==='gpt-5.6-sol'})()"));
    check('ui.modelPickCenter',await ev(cdp,"(function(){var n=document.getElementById('mb-model-name');return n&&n.textContent==='gpt-5.6-sol'})()"));
    check('ui.modelPickRequest',await ev(cdp,"(async function(){var q=await buildMiddleBrainResponsesRequest(null,[{role:'user',content:'x'}],{});return q.body.model==='gpt-5.6-sol'})()"));
    /* mbModelStep 切换（从 gpt-6-astra 步进 1 档） */
    await ev(cdp,"(async function(){mbModelPick('gpt-6-astra');mbModelStep(1)})()");
    check('ui.modelStep',await ev(cdp,"(async function(){var c=await getMiddleBrainConfig();return c.model==='gpt-5.6-sol'})()"));
  } finally { if(cdp)cdp.close(); try{browser.kill()}catch(e){} try{mock.server&&mock.server.close()}catch(e){} }
  console.log(failures===0?'\nMiddle Brain Phase 4 Advanced Settings CDP passed ✔':'\nMiddle Brain Phase 4 Advanced Settings CDP FAILED ✘');
  process.exit(failures?1:0);
}
main().catch(e=>{console.error(e);process.exit(1)});
