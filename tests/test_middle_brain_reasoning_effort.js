/* ====================================================================
   P21 · Middle Brain 统一思考深度（reasoningEffort）· 真实请求链 CDP 测试
   --------------------------------------------------------------------
   断言对象是**最终 wire body**：页面把请求打到本地 mock 端点（与既有 Middle Brain
   测试同一套做法），测试在服务端记录 body —— 因此证明的是"真正发出去的参数"，
   而不是中间态或纯函数输出。

   A. 配置   ：默认 auto / 旧配置（无 v2 迁移标记）一次性迁移为 auto / 主动选择才落盘 /
               历史 xhigh 合并 high / 非法值回退 auto / UI 五档（自动低中高最大）
   B. 门控   ：Middle Brain 未启用 → 消费者读到 auto，请求体零注入
   C. auto   ：chat / diary 的请求体与「Middle Brain 关闭」时逐字节相等
   D. 映射   ：low/medium/high/max → 真实字段（OpenAI Chat；max 就近降级）；
               Middle Brain 自身 Astra 调用（Responses）同样按档位写 reasoning.effort
   E. 不污染 ：未取证 provider（deepseek / deepseek-flash）在 max 档下一个字段都不多
   F. parity ：chat 与 diary 两个 consumer 得到同一份 reasoning 参数
   G. 分离   ：Speed(service_tier) 与 Reasoning Effort 互不写入、互不覆盖
   H. 观测   ：requested → effective → wireParam → 实际 reasoning tokens 可在 trace 对比

   运行：node test_middle_brain_reasoning_effort.js
   ==================================================================== */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http'), net = require('net'), crypto = require('crypto');

/* Repository root — this file lives in tests/, so the root is one level up. */
const ROOT = path.resolve(__dirname, '..');
const { pathToFileURL } = require('url');

const PAGE_URL = pathToFileURL(path.join(ROOT, 'InternalBeyond.html')).href;
function chromePath(){ if(process.env.CHROME_PATH&&fs.existsSync(process.env.CHROME_PATH))return process.env.CHROME_PATH; for(const c of ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe','C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe','C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe','C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe']) if(fs.existsSync(c))return c; return null; }
class Cdp{constructor(s){this.s=s;this.b=Buffer.alloc(0);this.id=0;this.p=new Map();this.l=new Map();s.on('data',c=>{this.b=Buffer.concat([this.b,c]);this.parse()});s.on('error',()=>{})}static c(u){return new Promise((res,rej)=>{const url=new URL(u);const r=http.request({host:url.hostname,port:url.port,path:url.pathname+url.search,headers:{Upgrade:'websocket',Connection:'Upgrade','Sec-WebSocket-Key':crypto.randomBytes(16).toString('base64'),'Sec-WebSocket-Version':'13'}});r.on('upgrade',(res2,s)=>res(new Cdp(s)));r.on('error',rej);r.end()})}on(m,l){if(!this.l.has(m))this.l.set(m,[]);this.l.get(m).push(l)}send(m,p={}){const id=++this.id;return new Promise((res,rej)=>{this.p.set(id,{res,rej});this.t({id,method:m,params:p});setTimeout(()=>{if(this.p.has(id)){this.p.delete(id);rej(new Error('timeout '+m))}},15000)})}t(m){const p=Buffer.from(JSON.stringify(m),'utf8'),mask=crypto.randomBytes(4),b=Buffer.alloc(p.length);for(let i=0;i<p.length;i++)b[i]=p[i]^mask[i&3];let h;if(p.length<126)h=Buffer.from([0x81,0x80|p.length]);else{h=Buffer.alloc(4);h[0]=0x81;h[1]=0x80|126;h.writeUInt16BE(p.length,2)}this.s.write(Buffer.concat([h,mask,b]))}f(o,p){const mask=crypto.randomBytes(4),b=Buffer.alloc(p.length);for(let i=0;i<p.length;i++)b[i]=p[i]^mask[i&3];let h;if(p.length<126)h=Buffer.from([0x80|o,0x80|p.length]);else{h=Buffer.alloc(4);h[0]=0x80|o;h[1]=0x80|126;h.writeUInt16BE(p.length,2)}this.s.write(Buffer.concat([h,mask,b]))}parse(){for(;;){if(this.b.length<2)return;const f=this.b[0],sl=this.b[1]&0x7f;let o=2,len=sl;if(sl===126){if(this.b.length<4)return;len=this.b.readUInt16BE(2);o=4}else if(sl===127){if(this.b.length<10)return;len=this.b.readUInt32BE(6);o=10}const m=(this.b[1]&0x80)!==0;let mask=null;if(m){if(this.b.length<o+4)return;mask=this.b.subarray(o,o+4);o+=4}if(this.b.length<o+len)return;let p=this.b.subarray(o,o+len);this.b=this.b.subarray(o+len);if(mask){const d=Buffer.alloc(p.length);for(let i=0;i<p.length;i++)d[i]=p[i]^mask[i&3];p=d}const op=f&0xf;if(op===0x8){this.s.destroy();return}if(op!==0x1)continue;let msg;try{msg=JSON.parse(p.toString('utf8'))}catch(e){continue}if(msg.id&&this.p.has(msg.id)){const q=this.p.get(msg.id);this.p.delete(msg.id);if(msg.error)q.rej(new Error(JSON.stringify(msg.error)));else q.res(msg.result||{})}}}close(){this.s.destroy()}}
async function ev(c,e){const r=await c.send('Runtime.evaluate',{expression:e,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw new Error('page exception: '+JSON.stringify(r.exceptionDetails.exception));return r.result&&r.result.value}
async function wait(c,e,t=15000){const end=Date.now()+t;while(Date.now()<end){try{if(await ev(c,e))return true}catch(err){}await new Promise(r=>setTimeout(r,120))}return false}
function freePort(){return new Promise((res,rej)=>{const s=net.createServer();s.unref();s.on('error',rej);s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(e=>e?rej(e):res(p))})})}

/* ── 本地 mock 端点：记录每一次真实 wire body，并按形状回合法响应（含 usage / reasoning tokens） ── */
function startMock(){
  const mock = { server:null, port:0, bodies:[] };
  const H = { 'Content-Type':'application/json', 'Access-Control-Allow-Origin':'*', 'Access-Control-Allow-Methods':'GET,POST,OPTIONS', 'Access-Control-Allow-Headers':'Content-Type,Authorization,x-api-key,anthropic-version,anthropic-dangerous-direct-browser-access' };
  mock.server = http.createServer((req,res)=>{
    if(req.method==='OPTIONS'){res.writeHead(204,H);res.end();return}
    const ch=[];req.on('data',c=>ch.push(c));
    req.on('end',()=>{
      const raw=Buffer.concat(ch).toString('utf8');
      let body={};try{body=JSON.parse(raw)}catch(e){}
      mock.bodies.push({ url:req.url, body:body });
      if(/\/responses/.test(req.url||'')){
        res.writeHead(200,H);
        res.end(JSON.stringify({
          output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({keep:[],merge:[],drop:[],compressedContext:'甲'.repeat(200)+' 用户问：在吗',currentKept:true})}]}],
          usage:{input_tokens:5,output_tokens:30,total_tokens:35,output_tokens_details:{reasoning_tokens:1082}}
        }));
        return;
      }
      if(body && body.stream){
        res.writeHead(200,Object.assign({},H,{'Content-Type':'text/event-stream'}));
        res.write('data: '+JSON.stringify({choices:[{delta:{content:'ok'}}]})+'\n\n');
        res.write('data: '+JSON.stringify({choices:[{delta:{},finish_reason:'stop'}],usage:{prompt_tokens:11,completion_tokens:22,completion_tokens_details:{reasoning_tokens:125}}})+'\n\n');
        res.end();
        return;
      }
      res.writeHead(200,H);
      res.end(JSON.stringify({choices:[{message:{content:'ok'},finish_reason:'stop'}],usage:{prompt_tokens:5,completion_tokens:9,completion_tokens_details:{reasoning_tokens:125}}}));
    });
  });
  return new Promise((res)=>mock.server.listen(0,'127.0.0.1',()=>{mock.port=mock.server.address().port;res(mock)}));
}

async function main(){
  const chrome=chromePath(); if(!chrome)throw new Error('未找到 Chrome / Edge');
  const mock=await startMock();
  const port=await freePort(), profile=fs.mkdtempSync(path.join(os.tmpdir(),'ib-p21-'));
  const browser=spawn(chrome,['--headless=new','--disable-gpu','--no-sandbox','--no-first-run','--allow-file-access-from-files','--force-color-profile=srgb','--window-size=1100,760','--remote-debugging-address=127.0.0.1','--remote-debugging-port='+port,'--user-data-dir='+profile,'about:blank'],{stdio:'ignore'});
  let failures=0; const check=(n,c,d='')=>{if(c)console.log('  PASS  '+n);else{failures++;console.error('  FAIL  '+n+(d?'  -> '+d:''))}};
  let cdp; try{
    let ready=false;for(let i=0;i<120;i++){try{const r=await fetch('http://127.0.0.1:'+port+'/json/version');if(r.ok){ready=true;break}}catch(e){}await new Promise(r=>setTimeout(r,100))}
    check('browser.ready',ready); if(!ready)throw new Error('Chrome DevTools 未就绪');
    const tab=await (await fetch('http://127.0.0.1:'+port+'/json/new?'+encodeURIComponent(PAGE_URL),{method:'PUT'})).json();
    cdp=await Cdp.c(tab.webSocketDebuggerUrl); await cdp.send('Runtime.enable');
    check('page.ready',await wait(cdp,"typeof window.saveMiddleBrainConfig==='function' && !!(window.IB&&IB.middleBrain&&typeof IB.middleBrain.middleBrainReasoningEffort==='function') && typeof window.callApiChat==='function' && typeof window._diaryModelCall==='function' && typeof window.IBModelCore.applyReasoningEffort==='function'",20000));
    if(failures)throw new Error('页面依赖未就绪');
    await ev(cdp,"window.confirm=function(){return true;}");
    await ev(cdp,"window.runtimeDiaryExecuteEnabled=false;window.runtimeExecuteEnabled=false;");

    const EP='http://127.0.0.1:'+mock.port+'/v1/chat/completions';
    const RSP=EP.replace('/chat/completions','/responses');
    const cfgOpenAI="{id:'c1',provider:'openai',model:'gpt-5.6-luna',endpoint:'"+EP+"',apiKey:'k',promptCache:false}";
    /* 目录默认的 openai 模型（非推理型）：收到 reasoning_effort 会 400，必须一个字段都不发 */
    const cfgOpenAIDefault="{id:'c3',provider:'openai',model:'gpt-4o-mini',endpoint:'"+EP+"',apiKey:'k',promptCache:false}";
    const cfgDeepSeek="{id:'c2',provider:'deepseek',model:'deepseek-flash',endpoint:'"+EP+"',apiKey:'k',promptCache:false}";
    const mbCfg=(extra)=>"{enabled:true,provider:'astra',endpoint:'"+RSP+"',model:'gpt-6-astra',apiKey:'sk-test',admissionEnabled:false,middleBrainJudgeEnabled:false,"+extra+"}";
    /* 每次调用前清空记录；返回"最后一次真实 wire body"的 JSON 字符串 */
    const run=async(expr)=>await ev(cdp,'(async function(){'+expr+'})()');
    const runBody=async(expr)=>{ mock.bodies.length=0; await run(expr); return mock.bodies.length?JSON.stringify(mock.bodies[mock.bodies.length-1].body):''; };
    const chatCall=(cfg,marker,extra)=>'await callApiChat('+cfg+',[{role:\'user\',content:\''+marker+'\'}],Object.assign({_ibConsumer:\'chat\'},'+extra+'))';
    const diaryCall=(cfg,marker)=>'await _diaryModelCall('+cfg+',[{role:\'user\',content:\''+marker+'\'}],{maxTokens:120,timeoutMs:8000,jsonMode:true},{kind:\'generate\'})';

    /* ══════════ A. 配置 ══════════ */
    check('A1.defaultAuto',await ev(cdp,"(async function(){await saveMiddleBrainConfig({enabled:true,reasoningEffort:'auto'});var c=await getMiddleBrainConfig();return c.reasoningEffort==='auto'&&(await IB.middleBrain.middleBrainReasoningEffort())==='auto'})()"));
    check('A2.legacyMigratedToAuto',await ev(cdp,"(async function(){await dbPut('apiSettings',{id:'middle_brain',enabled:true,provider:'astra',endpoint:'"+RSP+"',model:'gpt-6-astra',apiKey:'sk-test',reasoningEffort:'medium'});var c=await getMiddleBrainConfig();return c.reasoningEffort==='medium'&&c.reasoningEffortV2===undefined&&(await IB.middleBrain.middleBrainReasoningEffort())==='auto'})()"));
    check('A3.explicitPickPersists',await ev(cdp,"(async function(){mbReasoningPick('high');var end=Date.now()+3000;for(;;){var c=await getMiddleBrainConfig();if(c.reasoningEffort==='high'&&c.reasoningEffortV2===true)return (await IB.middleBrain.middleBrainReasoningEffort())==='high';if(Date.now()>end)return false;await new Promise(function(r){setTimeout(r,30)})}})()"));
    check('A4.legacyXhighBecomesHigh',await ev(cdp,"(function(){return normalizeMiddleBrainReasoningEffort('xhigh')==='high'})()"));
    check('A5.invalidFallsBackAuto',await ev(cdp,"(function(){return normalizeMiddleBrainReasoningEffort('banana')==='auto'&&normalizeMiddleBrainReasoningEffort(null)==='auto'&&normalizeMiddleBrainReasoningEffort('MAX')==='max'})()"));
    check('A6.uiFiveTiers',await ev(cdp,"(function(){loadMiddleBrainConfigUI();var ticks=document.querySelectorAll('#mb-adv-reasoning .mb-tick');var labs=document.querySelectorAll('#mb-adv-reasoning .mb-lbl');var order=Array.prototype.map.call(ticks,function(t){return t.dataset.value});var text=Array.prototype.map.call(labs,function(l){return l.textContent});return JSON.stringify(order)===JSON.stringify(['auto','low','medium','high','max'])&&text.join('')==='自动低中高最大'})()"));
    check('A7.uiTickClickSelects',await ev(cdp,"(async function(){await saveMiddleBrainConfig({reasoningEffort:'auto',reasoningEffortV2:true});loadMiddleBrainConfigUI();document.querySelector('#mb-adv-reasoning .mb-tick[data-value=\"max\"]').click();var end=Date.now()+3000;for(;;){var c=await getMiddleBrainConfig();if(c.reasoningEffort==='max')return true;if(Date.now()>end)return false;await new Promise(function(r){setTimeout(r,30)})}})()"));
    check('A8.uiCollapsedBlockRetained',await ev(cdp,"(function(){return !!document.getElementById('mb-collapse-body')&&!!document.getElementById('mb-collapse-toggle')&&!!document.querySelector('#mb-adv-reasoning .mb-trk')})()"));

    /* ══════════ B. 门控 ══════════ */
    check('B1.disabledReadsAuto',await ev(cdp,"(async function(){await saveMiddleBrainConfig({enabled:false,reasoningEffort:'max',reasoningEffortV2:true});return (await IB.middleBrain.middleBrainReasoningEffort())==='auto'})()"));
    const b2=await runBody(chatCall(cfgOpenAI,'probe-B2'));
    check('B2.disabledNoInjection',!/reasoning_effort|reasoning|\"thinking\"/.test(b2),b2);

    /* ══════════ C. auto 与「关闭」逐字节相等 ══════════ */
    await ev(cdp,"(async function(){await saveMiddleBrainConfig("+mbCfg("reasoningEffort:'auto',reasoningEffortV2:true")+")})()");
    const autoChat=await runBody(chatCall(cfgOpenAI,'probe-C1'));
    const autoDiary=await runBody(diaryCall(cfgOpenAI,'probe-C2'));
    await ev(cdp,"(async function(){await saveMiddleBrainConfig("+mbCfg("enabled:false,reasoningEffort:'max',reasoningEffortV2:true")+")})()");
    const offChat=await runBody(chatCall(cfgOpenAI,'probe-C1'));
    const offDiary=await runBody(diaryCall(cfgOpenAI,'probe-C2'));
    check('C1.autoEqualsDisabledChat',autoChat===offChat&&autoChat!=='',autoChat+' vs '+offChat);
    check('C2.autoEqualsDisabledDiary',autoDiary===offDiary&&autoDiary!=='',autoDiary+' vs '+offDiary);
    check('C3.autoNoReasoningKeys',!/reasoning|thinking/.test(autoChat),autoChat);

    /* ══════════ D. 档位 → 真实 wire 参数 ══════════ */
    await ev(cdp,"(async function(){await saveMiddleBrainConfig("+mbCfg("reasoningEffort:'low',reasoningEffortV2:true")+")})()");
    const lowChat=await runBody(chatCall(cfgOpenAI,'probe-D1'));
    await ev(cdp,"(async function(){await saveMiddleBrainConfig("+mbCfg("reasoningEffort:'medium',reasoningEffortV2:true")+")})()");
    const medChat=await runBody(chatCall(cfgOpenAI,'probe-D2'));
    await ev(cdp,"(async function(){await saveMiddleBrainConfig("+mbCfg("reasoningEffort:'high',reasoningEffortV2:true")+")})()");
    const highChat=await runBody(chatCall(cfgOpenAI,'probe-D3'));
    const highStream=await runBody("await callApiChatStream("+cfgOpenAI+",[{role:'user',content:'probe-D3s'}],{_ibConsumer:'chat',disableTools:true,_noWebSearch:true})");
    await ev(cdp,"(async function(){await saveMiddleBrainConfig("+mbCfg("reasoningEffort:'max',reasoningEffortV2:true")+")})()");
    const maxChat=await runBody(chatCall(cfgOpenAI,'probe-D4'));
    check('D1.low',/"reasoning_effort":"low"/.test(lowChat),lowChat);
    check('D2.medium',/"reasoning_effort":"medium"/.test(medChat),medChat);
    check('D3.high',/"reasoning_effort":"high"/.test(highChat),highChat);
    check('D3s.streamHigh',/"reasoning_effort":"high"/.test(highStream),highStream);
    check('D4.maxDowngradedToHigh',/"reasoning_effort":"high"/.test(maxChat),maxChat);
    check('D5.selfCallAstraHigh',await ev(cdp,"(async function(){await saveMiddleBrainConfig("+mbCfg("reasoningEffort:'high',reasoningEffortV2:true")+");var q=await buildMiddleBrainResponsesRequest(null,[{role:'user',content:'x'}],{maxTokens:1600,jsonMode:true});return q.body.reasoning&&q.body.reasoning.effort==='high'})()"));
    check('D6.selfCallAutoSilent',await ev(cdp,"(async function(){await saveMiddleBrainConfig("+mbCfg("reasoningEffort:'auto',reasoningEffortV2:true")+");var q=await buildMiddleBrainResponsesRequest(null,[{role:'user',content:'x'}],{maxTokens:1600,jsonMode:true});return q.body.reasoning===undefined})()"));
    await ev(cdp,"(async function(){await saveMiddleBrainConfig("+mbCfg("reasoningEffort:'medium',reasoningEffortV2:true")+")})()");
    const selfWire=await runBody("await middleBrainCompressPipeline('p21','用户问：在吗',{memoryCtx:'【记忆】甲'.repeat(300),dialogue:['用户问：在吗']})");
    check('D7.selfCallWireMedium',/"reasoning":\{"effort":"medium"\}/.test(selfWire),selfWire);

    /* ══════════ E. 未取证 provider 不污染 ══════════ */
    await ev(cdp,"(async function(){await saveMiddleBrainConfig("+mbCfg("reasoningEffort:'max',reasoningEffortV2:true")+")})()");
    const dsChat=await runBody(chatCall(cfgDeepSeek,'probe-E1'));
    const dsDiary=await runBody(diaryCall(cfgDeepSeek,'probe-E2'));
    check('E1.deepseekChatUntouched',!/reasoning|thinking|service_tier/.test(dsChat),dsChat);
    check('E2.deepseekDiaryUntouched',!/reasoning|thinking|service_tier/.test(dsDiary),dsDiary);
    check('E3.deepseekModelIdIntact',/"model":"deepseek-flash"/.test(dsChat),dsChat);
    /* 非推理型 OpenAI 模型（目录默认）：即便用户选了 max 也不得发送 —— 否则每次聊天 400 */
    const oaDefault=await runBody(chatCall(cfgOpenAIDefault,'probe-E4'));
    check('E4.openaiNonReasoningModelUntouched',!/reasoning|thinking/.test(oaDefault),oaDefault);

    /* ══════════ F. chat / diary parity ══════════ */
    await ev(cdp,"(async function(){await saveMiddleBrainConfig("+mbCfg("reasoningEffort:'high',reasoningEffortV2:true")+")})()");
    const pChat=await runBody(chatCall(cfgOpenAI,'probe-F'));
    const pDiary=await runBody(diaryCall(cfgOpenAI,'probe-F'));
    check('F1.parityChatDiary',(function(){try{const a=JSON.parse(pChat),b=JSON.parse(pDiary);return a.reasoning_effort==='high'&&b.reasoning_effort==='high'}catch(e){return false}})(),pChat+' | '+pDiary);
    check('F2.paritySameReasoningWire',(function(){
      try{
        const a=JSON.parse(pChat),b=JSON.parse(pDiary);
        const keys=o=>Object.keys(o).filter(k=>/reasoning|thinking/.test(k)).sort();
        return JSON.stringify(keys(a))===JSON.stringify(keys(b))&&a.reasoning_effort===b.reasoning_effort&&keys(a).length===1;
      }catch(e){return false}
    })(),pChat+' | '+pDiary);

    /* ══════════ G. Speed / Effort 分离 ══════════ */
    check('G1.speedOnlyServiceTier',await ev(cdp,"(async function(){await saveMiddleBrainConfig("+mbCfg("reasoningEffort:'auto',reasoningEffortV2:true,speed:'fast'")+");var q=await buildMiddleBrainResponsesRequest(null,[{role:'user',content:'x'}],{maxTokens:1600,jsonMode:true});return q.body.service_tier==='fast'&&q.body.reasoning===undefined&&q.body.speed===undefined})()"));
    check('G2.effortNeverServiceTier',await ev(cdp,"(async function(){await saveMiddleBrainConfig("+mbCfg("reasoningEffort:'high',reasoningEffortV2:true,speed:'standard'")+");var q=await buildMiddleBrainResponsesRequest(null,[{role:'user',content:'x'}],{maxTokens:1600,jsonMode:true});return q.body.reasoning.effort==='high'&&!('service_tier' in q.body)})()"));
    await ev(cdp,"(async function(){await saveMiddleBrainConfig("+mbCfg("reasoningEffort:'high',reasoningEffortV2:true,speed:'fast'")+")})()");
    const bothChat=await runBody(chatCall(cfgOpenAI,'probe-G3'));
    check('G3.chatEffortOnlyNoTier',/"reasoning_effort":"high"/.test(bothChat)&&!/service_tier/.test(bothChat),bothChat);

    /* ══════════ H. 观测 ══════════ */
    const h1=await ev(cdp,"(async function(){IBModelCore.reasoningTraceReset();await saveMiddleBrainConfig("+mbCfg("reasoningEffort:'high',reasoningEffortV2:true")+");window.__p21chat=1;return true})()");
    check('H0.setup',h1===true);
    mock.bodies.length=0;
    await run(chatCall(cfgOpenAI,'probe-H1'));
    check('H1.tracePairing',await ev(cdp,"(function(){var r=IBModelCore.reasoningTrace(5).filter(function(x){return x.consumer==='chat'})[0];return !!r&&r.requestedReasoningEffort==='high'&&r.effectiveReasoningEffort==='high'&&r.reasoningWireParam==='reasoning_effort'&&r.reasoningFallbackReason===''&&r.reasoningTokens===125})()"),await ev(cdp,"JSON.stringify(IBModelCore.reasoningTrace(5))"));
    check('H2.traceDeepseekAbstain',await ev(cdp,"(async function(){IBModelCore.reasoningTraceReset();await saveMiddleBrainConfig("+mbCfg("reasoningEffort:'max',reasoningEffortV2:true")+");return true})()")===true);
    mock.bodies.length=0;
    await run(chatCall(cfgDeepSeek,'probe-H2'));
    check('H2b.deepseekTrace',await ev(cdp,"(function(){var r=IBModelCore.reasoningTrace(5).filter(function(x){return x.consumer==='chat'})[0];return !!r&&r.requestedReasoningEffort==='max'&&r.effectiveReasoningEffort==='auto'&&r.reasoningWireParam===''&&r.reasoningFallbackReason==='unverified_provider'&&r.reasoningTokens===125})()"),await ev(cdp,"JSON.stringify(IBModelCore.reasoningTrace(5))"));
    check('H3.traceNoSecrets',await ev(cdp,"(function(){var json=JSON.stringify(IBModelCore.reasoningTrace(20));return json.indexOf('sk-test')<0&&json.indexOf('Bearer')<0&&json.indexOf('probe-')<0})()"));
    check('H4.selfCallTrace',await ev(cdp,"(async function(){IBModelCore.reasoningTraceReset();await saveMiddleBrainConfig("+mbCfg("reasoningEffort:'high',reasoningEffortV2:true")+");return true})()")===true);
    mock.bodies.length=0;
    await run("await middleBrainCompressPipeline('p21b','用户问：在吗',{memoryCtx:'【记忆】甲'.repeat(300),dialogue:['用户问：在吗']})");
    check('H4b.mbSelfTrace',await ev(cdp,"(function(){var r=IBModelCore.reasoningTrace(5).filter(function(x){return x.consumer==='middle_brain.compression'})[0];return !!r&&r.requestedReasoningEffort==='high'&&r.effectiveReasoningEffort==='high'&&r.reasoningWireParam==='reasoning.effort'&&r.reasoningTokens===1082})()"),await ev(cdp,"JSON.stringify(IBModelCore.reasoningTrace(5))"));

    /* ══════════ I. 反回归 ══════════ */
    await ev(cdp,"(async function(){await saveMiddleBrainConfig("+mbCfg("enabled:false,reasoningEffort:'auto',reasoningEffortV2:true")+")})()");
    const clean=await runBody(chatCall(cfgOpenAI,'probe-I'));
    check('I1.otherFieldsStable',(function(){
      try{
        const b=JSON.parse(clean);
        return b.model==='gpt-5.6-luna'&&Array.isArray(b.messages)&&!('temperature' in b)&&!('service_tier' in b)
          &&!('reasoning' in b)&&!('reasoning_effort' in b)&&!('thinking' in b);
      }catch(e){return false}
    })(),clean);
    check('I2.mbSeamUntouched',await ev(cdp,"(async function(){var r=await IB.middleBrain.middleBrainExecute('c1','hi',{memoryCtx:'x'});return r===null||typeof r==='object'})()"));
  } finally {
    try{cdp&&cdp.close()}catch(e){}
    try{browser.kill()}catch(e){}
    try{mock.server.close()}catch(e){}
    try{fs.rmSync(profile,{recursive:true,force:true})}catch(e){}
  }
  console.log('\n' + (failures===0?'middle brain reasoning effort test passed ✔':'middle brain reasoning effort test FAILED ✘') + ' (' + failures + ' failed)');
  process.exitCode = failures===0?0:1;
}
main().catch(e=>{console.error('测试执行异常：',e&&e.stack||e);process.exitCode=1});
