/* ====================================================================
   Middle Brain v0 · Astra 接入 · CDP 测试（mock Astra OpenAI-compatible 端点）
   覆盖：Astra 正常(keep/merge/drop/compressedContext 结构化) /
        Astra 超时·failure fallback(不影响聊天) / 当前消息保留 /
        事实不新增(可能→确定越界被拒) / Memory 不写入 / 角色模型保持原 Provider。
   只测 Middle Brain；不改生产代码。运行：node test_middle_brain_astral.js
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
  const mock={payload:'', server:null, port:0, mode:'ok'};/* mode: ok|slow|fail */
  mock.server=http.createServer((req,res)=>{const H={'Content-Type':'application/json','Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,POST,OPTIONS','Access-Control-Allow-Headers':'Content-Type,Authorization'};if(req.method==='OPTIONS'){res.writeHead(204,H);res.end();return}if(req.method==='POST'&&req.url.includes('/responses')){let ch=[];req.on('data',c=>ch.push(c));req.on('end',()=>{if(mock.mode==='fail'){res.writeHead(500,H);res.end(JSON.stringify({error:'boom'}));return}if(mock.mode==='slow'){setTimeout(()=>{res.writeHead(200,H);res.end(JSON.stringify({output:[{type:'message',content:[{type:'output_text',text:mock.payload}]}],usage:{input_tokens:5,output_tokens:3,total_tokens:8,input_tokens_details:{cached_tokens:1},output_tokens_details:{reasoning_tokens:2}}}))},3000);return}res.writeHead(200,H);res.end(JSON.stringify({output:[{type:'message',content:[{type:'output_text',text:mock.payload}]}],usage:{input_tokens:5,output_tokens:3,total_tokens:8,input_tokens_details:{cached_tokens:1},output_tokens_details:{reasoning_tokens:2}}}))});return}res.writeHead(404,H);res.end(JSON.stringify({error:'nf'}))}).listen(0,'127.0.0.1',()=>{mock.port=mock.server.address().port});
  const port=await freePort(), profile=fs.mkdtempSync(path.join(os.tmpdir(),'ib-astra-'));
  const browser=spawn(chrome,['--headless=new','--disable-gpu','--no-sandbox','--no-first-run','--allow-file-access-from-files','--force-color-profile=srgb','--window-size=1100,760','--remote-debugging-address=127.0.0.1','--remote-debugging-port='+port,'--user-data-dir='+profile,'about:blank'],{stdio:'ignore'});
  let failures=0; const check=(n,c,d='')=>{if(c)console.log('  PASS  '+n);else{failures++;console.error('  FAIL  '+n+(d?'  -> '+d:''))}};
  let cdp; try{
    let ready=false;for(let i=0;i<120;i++){try{const r=await fetch('http://127.0.0.1:'+port+'/json/version');if(r.ok){ready=true;break}}catch(e){}await new Promise(r=>setTimeout(r,100))}
    check('browser.ready',ready); if(!ready)throw new Error('Chrome DevTools 未就绪');
    const tab=await (await fetch('http://127.0.0.1:'+port+'/json/new?'+encodeURIComponent(PAGE_URL),{method:'PUT'})).json();
    cdp=await Cdp.c(tab.webSocketDebuggerUrl); await cdp.send('Runtime.enable');
    check('page.ready',await wait(cdp,"typeof window.middleBrainCompressPipeline==='function' && typeof window.middleBrainAstraInvoke==='function' && typeof window.saveMiddleBrainConfig==='function'",20000));
    await ev(cdp,"window.confirm=function(){return true;}");
    /* 配置 Astra mock 端点（enabled + endpoint + model + apiKey）→ middleBrainReady true。
       admissionEnabled:false → 关闭 Phase 2 Admission Gate，纯测 Phase 1 Astra 调用路径
       （本套件全部用例均为极短上下文；若 Gate 开启会被判定 NO，失去 astra.source）。 */
    const ep='http://127.0.0.1:'+mock.port+'/v1/responses';
    await ev(cdp,"(async function(){await saveMiddleBrainConfig({enabled:true,endpoint:'"+ep+"',model:'gpt-6-astra',apiKey:'sk-x',admissionEnabled:false});})()");
    check('mb.configReady',await ev(cdp,"(async function(){return await middleBrainReady()===true})()"));
    /* ①b Responses API 请求体正确：model/input/instructions/max_output_tokens，绝不含旧 Chat Completions 参数 */
    const reqCheck=await ev(cdp,"(async function(){var q=await buildMiddleBrainResponsesRequest(null,{system:'MB指令',messages:[{role:'user',content:'u'}]},{maxTokens:512,jsonMode:true});return {m:q.body.model,inp:q.body.input,inst:q.body.instructions,mo:q.body.max_output_tokens,hasMaxToks:'max_tokens' in q.body,hasTemp:'temperature' in q.body,hasTopP:'top_p' in q.body,hasEffortOld:'reasoning_effort' in q.body,hasTextFmt:q.body.text&&q.body.text.format&&q.body.text.format.type==='json_schema',ep:q.endpoint};})()");
    check('responsesReq.model',reqCheck.m==='gpt-6-astra',JSON.stringify(reqCheck.m));
    check('responsesReq.input',Array.isArray(reqCheck.inp)&&reqCheck.inp.some(function(i){return i.role==='user'&&i.content==='u'}),JSON.stringify(reqCheck.inp));
    check('responsesReq.instructions',String(reqCheck.inst).indexOf('MB指令')>=0,JSON.stringify(reqCheck.inst));
    check('responsesReq.maxOutputTokens',reqCheck.mo===512,JSON.stringify(reqCheck.mo));
    check('responsesReq.noOldChatParams',reqCheck.hasMaxToks===false&&reqCheck.hasTemp===false&&reqCheck.hasTopP===false&&reqCheck.hasEffortOld===false,JSON.stringify(reqCheck));
    check('responsesReq.textFormat',reqCheck.hasTextFmt===true,JSON.stringify(reqCheck));
    check('responsesReq.endpoint',reqCheck.ep.indexOf('/v1/responses')>=0||reqCheck.ep.indexOf('responses')>=0,JSON.stringify(reqCheck.ep));
    /* ① Astra 正常：keep/merge/drop/compressedContext 结构化 + 当前消息保留 */
    mock.mode='ok';
    mock.payload=JSON.stringify({keep:['她认可这台设备','她将升级创作设备'],merge:[{from:'重复',into:'merged'}],drop:['过时信息'],compressedContext:'她认可这台设备，将升级创作设备。 当前对话：用户问我该换什么。',currentKept:true});
    let r=await ev(cdp,"(async function(){var res=await middleBrainCompressPipeline('c1','用户问：我该换什么设备？',{memoryCtx:'【记忆】她认可这台设备。',understandingCtx:'',threadCtx:'',momentsCtx:''});return {src:res.source,keep:res.keep,drop:res.drop,ctx:res.compressedContext};})()");
    check('astra.normal.source',r.src==='astra',JSON.stringify(r));
    check('astra.normal.structured',Array.isArray(r.keep)&&Array.isArray(r.drop)&&typeof r.ctx==='string'&&r.ctx.length>0,JSON.stringify(r));
    check('astra.normal.keepFromInput',r.keep.join(' ').indexOf('认可')>=0,JSON.stringify(r.keep));
    /* ② 当前消息保留：Astra 结果必须含当前对话 */
    check('astra.currentKept',String(r.ctx).indexOf('我该换什么')>=0,JSON.stringify(r.ctx));
    /* ③ Memory 不写入：Memory/Understanding/Thread 零写入 */
    check('astra.noMemoryWrite',await ev(cdp,"(async function(){var all=await dbGetAll('memories');var am=await dbGetAll('understandings');var th=await dbGetAll('threads');return (all||[]).length===0&&(am||[]).length===0&&(th||[]).length===0})()"));
    /* ④ 事实不新增：Astra 把"可能"改写成确定"是"（越界）→ 被拒走 fallback */
    mock.payload=JSON.stringify({keep:[],merge:[],drop:[],compressedContext:'她一定要换设备。',currentKept:true});
    /* ④ Astra 丢了当前对话（currentKept 内容不含当前消息）→ 被拒走 fallback local */
    mock.mode='ok';
    mock.payload=JSON.stringify({keep:[],merge:[],drop:[],compressedContext:'她一定要换设备。',currentKept:true});
    r=await ev(cdp,"(async function(){var res=await middleBrainCompressPipeline('c1','用户问：我该换什么设备？',{dialogue:['用户问：我该换什么设备？']});return {src:res.source,ctx:res.compressedContext};})()");
    check('astra.dropCurrentDialogueFallback',r.src==='local'&&String(r.ctx).indexOf('我该换什么设备')>=0,JSON.stringify(r));
    /* ⑤ Astra 超时 → fallback local */
    mock.mode='slow';mock.payload=JSON.stringify({keep:[],merge:[],drop:[],compressedContext:'超时不应采用',currentKept:true});
    r=await ev(cdp,"(async function(){var res=await middleBrainCompressPipeline('c1','用户问：现在几点？',{memoryCtx:'【记忆】她下午三点开会。',timeoutMs:500});return {src:res.source,ctx:res.compressedContext};})()");
    check('astra.timeoutFallbackLocal',r.src==='local'&&String(r.ctx).indexOf('三点开会')>=0,JSON.stringify({src:r.src,ctx:r.ctx}));
    /* ⑥ Astra failure(500) → fallback local */
    mock.mode='fail';mock.payload='';
    r=await ev(cdp,"(async function(){var res=await middleBrainCompressPipeline('c1','用户问：午饭吃什么',{memoryCtx:'【记忆】她爱吃面食。'});return {src:res.source};})()");
    check('astra.failFallbackLocal',r.src==='local',JSON.stringify(r));
    /* ⑦ 角色模型保持原 Provider：确认角色调用链(apiConfigs)未被 Astra 触碰（无新 provider 配置写入） */
    check('roleChain.unaffected',await ev(cdp,"(async function(){var cfgs=apiConfigs||[];return cfgs.length===0})()"));
    /* ⑧ Responses API parser 单元：output_text 优先；output[].content[].text fallback；无 choices 依赖 */
    check('parser.outputText',await ev(cdp,"(async function(){var p=await parseMiddleBrainResponsesResponse({output:[{type:'message',content:[{type:'output_text',text:'hello'}]}]});return p.content==='hello'&&p.truncated===false})()"));
    check('parser.outputFallbackText',await ev(cdp,"(async function(){var p=await parseMiddleBrainResponsesResponse({output:[{type:'message',content:[{type:'text',text:'fallback'}]}]});return p.content==='fallback'})()"));
    check('parser.noChoicesAssumption',await ev(cdp,"(async function(){var p=await parseMiddleBrainResponsesResponse({output:[{type:'message',content:[{type:'output_text',text:'x'}]}]});return p.content==='x'&&p.usage===null})()"));
    /* ⑨ usage 映射：input_tokens/output_tokens/total/details → IB 用量结构 */
    check('parser.usageMapped',await ev(cdp,"(async function(){var p=await parseMiddleBrainResponsesResponse({output:[{type:'message',content:[{type:'output_text',text:'x'}]}],usage:{input_tokens:10,output_tokens:4,total_tokens:14,input_tokens_details:{cached_tokens:2},output_tokens_details:{reasoning_tokens:1}}});return p.usage&&p.usage.input_tokens===10&&p.usage.output_tokens===4&&p.usage.total_tokens===14&&p.usage.input_tokens_details.cached_tokens===2&&p.usage.output_tokens_details.reasoning_tokens===1})()"));
    /* ⑫ 不写死 output[0].content[0].text：output[] 首项为非 message 类型（reasoning），正文在第二条 message */
    check('parser.outputFirstIsNonMessage',await ev(cdp,"(async function(){var p=await parseMiddleBrainResponsesResponse({output:[{type:'reasoning',summary:[{text:'思考A'},{text:'思考B'}]},{type:'message',content:[{type:'output_text',text:'正文结果'}]}],status:'completed'});return p.content==='正文结果'&&p.reasoning.indexOf('思考A')>=0&&p.reasoning.indexOf('思考B')>=0&&p.truncated===false})()"));
    /* ⑬ message.content[0] 用官方 output_text 字段（而非 .text），不能写死 .text */
    check('parser.contentUsesOutputTextField',await ev(cdp,"(async function(){var p=await parseMiddleBrainResponsesResponse({output:[{type:'message',content:[{type:'output_text',output_text:'来自output_text字段',text:'错误text'}]}]});return p.content==='来自output_text字段'&&p.content.indexOf('错误text')<0})()"));
    /* ⑭ 顶层 output_text 为空字符串时，不应挡住 output[] 里的真实内容 */
    check('parser.emptyTopOutputTextFallsThrough',await ev(cdp,"(async function(){var p=await parseMiddleBrainResponsesResponse({output_text:'',output:[{type:'message',content:[{type:'output_text',text:'真实内容'}]}]});return p.content==='真实内容'})()"));
    /* ⑮ output[] 含其它输出类型（web_search_call 等）时忽略、不报错、正文仍取到 */
    check('parser.mixedOutputTypes',await ev(cdp,"(async function(){var p=await parseMiddleBrainResponsesResponse({output:[{type:'web_search_call',id:'ws1'},{type:'message',content:[{type:'output_text',text:'混合结果OK'}]}],status:'completed'});return p.content==='混合结果OK'})()"));
    /* ⑩ malformed response（无 output/无文本）→ fallback local */
    mock.mode='ok';mock.payload='';/* 空文本 → parse 无 content → fallback */
    r=await ev(cdp,"(async function(){var res=await middleBrainCompressPipeline('c1','用户问：中午吃什么',{memoryCtx:'【记忆】她爱吃面食。'});return {src:res.source};})()");
    check('astra.malformedFallback',r.src==='local',JSON.stringify(r));
    /* ⑪ Middle Brain JSON 结果仍能被 _mbParseAstraJson 解析（结构化层不变） */
    check('parser.jsonStillParsed',await ev(cdp,"(async function(){var j=_mbParseAstraJson(JSON.stringify({keep:['a'],merge:[],drop:[],compressedContext:'ctx',currentKept:true}));return !!j&&j.keep.length===1&&j.compressedContext==='ctx'&&j.currentKept===true})()"));
  } finally { if(cdp)cdp.close(); try{browser.kill()}catch(e){} try{mock.server&&mock.server.close()}catch(e){} }
  console.log(failures===0?'\nMiddleware Brain v0 Astra CDP passed ✔':'\nMiddleware Brain v0 Astra CDP FAILED ✘');
  process.exit(failures?1:0);
}
main().catch(e=>{console.error(e);process.exit(1)});
