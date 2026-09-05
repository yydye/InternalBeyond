/* ====================================================================
   Middle Brain (GPT-6 Astra) 全局配置 · CDP 测试
   覆盖：角色 Provider 不提供 Astra / Middle Brain 配置默认值 +
        saveMiddleBrainConfigUI 保存持久化(apiSettings['middle_brain']) /
        isMiddleBrainEnabled · middleBrainReady 就绪逻辑 /
        buildMiddleBrainRequest · parseMiddleBrainResponse 归一(复用 AstraAdapter)。
   只测 Middle Brain；不改生产代码。运行：node test_middle_brain.js
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
  const port=await freePort(), profile=fs.mkdtempSync(path.join(os.tmpdir(),'ib-mb-'));
  const browser=spawn(chrome,['--headless=new','--disable-gpu','--no-sandbox','--no-first-run','--allow-file-access-from-files','--force-color-profile=srgb','--window-size=1100,760','--remote-debugging-address=127.0.0.1','--remote-debugging-port='+port,'--user-data-dir='+profile,'about:blank'],{stdio:'ignore'});
  let failures=0; const check=(n,c,d='')=>{if(c)console.log('  PASS  '+n);else{failures++;console.error('  FAIL  '+n+(d?'  -> '+d:''))}};
  let cdp; try{
    let ready=false;for(let i=0;i<120;i++){try{const r=await fetch('http://127.0.0.1:'+port+'/json/version');if(r.ok){ready=true;break}}catch(e){}await new Promise(r=>setTimeout(r,100))}
    check('browser.ready',ready); if(!ready)throw new Error('Chrome DevTools 未就绪');
    const tab=await (await fetch('http://127.0.0.1:'+port+'/json/new?'+encodeURIComponent(PAGE_URL),{method:'PUT'})).json();
    cdp=await Cdp.c(tab.webSocketDebuggerUrl); await cdp.send('Runtime.enable');
    check('page.ready',await wait(cdp,"typeof window._middleBrain==='object' && typeof window.getMiddleBrainConfig==='function' && typeof window.PROVIDERS==='object'",20000));
    await ev(cdp,"window.confirm=function(){return true;}");
    /* ① 角色 Provider 不提供 Astra */
    check('roleProvider.noAstra',await ev(cdp,"!(function(){var s=document.getElementById('api-provider');for(var i=0;i<s.options.length;i++){if(s.options[i].value==='astra'||/astra/i.test(s.options[i].text))return true}return false})()"));
    check('roleRegistry.noAstra',await ev(cdp,"!window.PROVIDERS.astra"));
    /* ② 默认配置 */
    check('mb.defaults',await ev(cdp,"(async function(){var c=await getMiddleBrainConfig();return c&&c.enabled===false&&c.provider==='astra'&&String(c.endpoint).indexOf('/v1/responses')>=0&&c.model==='gpt-6-astra'})()"));
    /* ③ 保存并持久化（表单 → saveMiddleBrainConfigUI → apiSettings['middle_brain']） */
    await ev(cdp,"(function(){document.getElementById('mb-enabled-toggle').checked=true;document.getElementById('mb-endpoint').value='https://api.astra.example.com/v1/chat/completions';document.getElementById('mb-model').value='gpt-6-astra';document.getElementById('mb-apikey').value='sk-test-123';})()");
    await ev(cdp,"saveMiddleBrainConfigUI()");
    check('mb.persisted',await wait(cdp,"(async function(){var c=await dbGet('apiSettings','middle_brain');return !!(c&&c.enabled===true&&c.apiKey==='sk-test-123'&&c.endpoint.indexOf('astra')>=0)})()",6000));
    /* ④ 就绪判定 */
    check('mb.readyEnabled',await ev(cdp,"(async function(){return await isMiddleBrainEnabled()===true && await middleBrainReady()===true})()"));
    check('mb.readyMissingKey',await ev(cdp,"(async function(){var c=await getMiddleBrainConfig();c.apiKey='';await saveMiddleBrainConfig(c);return await middleBrainReady()===false})()"));
    /* ⑤ 归一（复用 AstraAdapter / 内置回落） */
    check('mb.buildRequest',await ev(cdp,"(async function(){var r=await buildMiddleBrainRequest({endpoint:'https://x/v1/chat/completions',model:'gpt-6-astra'},{system:'S',messages:[{role:'user',content:'u'}]},{maxTokens:128});return r.body.messages[0].role==='system'&&r.body.messages[1].content==='u'&&r.body.model==='gpt-6-astra'})()"));
    check('mb.parseResponse',await ev(cdp,"(async function(){var r=await parseMiddleBrainResponse({choices:[{message:{content:'你好',reasoning_content:'想'},finish_reason:'length'}],usage:{prompt_tokens:1,completion_tokens:2}},{});return r.content==='你好'&&r.reasoning==='想'&&r.truncated===true})()"));
    /* ⑥ Middle Brain 系统提示词：前端只读常量，用户不可修改，且不随配置持久化 */
    check('mb.sysPromptExists',await ev(cdp,"(async function(){var p=getMiddleBrainSystemPrompt();return typeof p==='string'&&p.length>200&&p.indexOf('Middle Brain')>=0&&p.indexOf('OOC')>=0})()"));
    check('mb.sysPromptReadOnly',await ev(cdp,"(async function(){var before=getMiddleBrainSystemPrompt();try{getMiddleBrainSystemPrompt=function(){return 'hijacked'}}catch(e){}var after=window._middleBrain.getMiddleBrainSystemPrompt();return after===before&&after.indexOf('InternalBeyond')>=0})()"));
    check('mb.sysPromptNotPersisted',await ev(cdp,"(async function(){var c=await getMiddleBrainConfig();return c&&typeof c.systemPrompt==='undefined'})()"));
    check('mb.buildInjectsSysPrompt',await ev(cdp,"(async function(){var r=await buildMiddleBrainRequest({endpoint:'https://x/v1/chat/completions',model:'gpt-6-astra'},{messages:[{role:'user',content:'u'}]},{maxTokens:64});return String(r.body.messages[0].content).indexOf('Middle Brain')>=0&&r.body.messages[0].role==='system'})()"));
    check('mb.buildRespectsExplicitSys',await ev(cdp,"(async function(){var r=await buildMiddleBrainRequest({endpoint:'https://x/v1/chat/completions',model:'gpt-6-astra'},{system:'显式系统',messages:[{role:'user',content:'u'}]},{maxTokens:64});return r.body.messages[0].content==='显式系统'})()"));
  } finally { if(cdp)cdp.close(); try{browser.kill()}catch(e){} }
  console.log(failures===0?'\nMiddleware Brain config CDP passed ✔':'\nMiddleware Brain config CDP FAILED ✘');
  process.exit(failures?1:0);
}
main().catch(e=>{console.error(e);process.exit(1)});
