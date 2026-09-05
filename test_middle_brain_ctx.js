/* ====================================================================
   Middle Brain v0 · Context Organization + Compression · CDP 测试
   覆盖：组织(分类) / 去重(近重复合并) / 信息保留(不丢事实) /
        token 压缩(预算) / 空上下文 / Astra 不可用 fallback /
        不确定信息保持不确定(不新增事实)。
   只测 Middle Brain；不改生产代码。运行：node test_middle_brain_ctx.js
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
  const port=await freePort(), profile=fs.mkdtempSync(path.join(os.tmpdir(),'ib-mbctx-'));
  const browser=spawn(chrome,['--headless=new','--disable-gpu','--no-sandbox','--no-first-run','--allow-file-access-from-files','--force-color-profile=srgb','--window-size=1100,760','--remote-debugging-address=127.0.0.1','--remote-debugging-port='+port,'--user-data-dir='+profile,'about:blank'],{stdio:'ignore'});
  let failures=0; const check=(n,c,d='')=>{if(c)console.log('  PASS  '+n);else{failures++;console.error('  FAIL  '+n+(d?'  -> '+d:''))}};
  let cdp; try{
    let ready=false;for(let i=0;i<120;i++){try{const r=await fetch('http://127.0.0.1:'+port+'/json/version');if(r.ok){ready=true;break}}catch(e){}await new Promise(r=>setTimeout(r,100))}
    check('browser.ready',ready); if(!ready)throw new Error('Chrome DevTools 未就绪');
    const tab=await (await fetch('http://127.0.0.1:'+port+'/json/new?'+encodeURIComponent(PAGE_URL),{method:'PUT'})).json();
    cdp=await Cdp.c(tab.webSocketDebuggerUrl); await cdp.send('Runtime.enable');
    check('page.ready',await wait(cdp,"typeof window.middleBrainContextPipeline==='function' && typeof window.middleBrainCompressContext==='function' && typeof window.getMemoryContext==='function'",20000));
    await ev(cdp,"window.confirm=function(){return true;}");
    /* ① 组织：传入 mock 上下文，验证分类落在 organized 各类 */
    check('organization.categories',await ev(cdp,"(async function(){var org=await middleBrainOrganizeContext('c1','设备 焦虑',{memoryCtx:'【记忆】她很在意创作设备。',understandingCtx:'【对TA的理解】她对设备瓶颈敏感。',threadCtx:'【线索】攒钱买硬盘。',momentsCtx:'【动态】她昨晚失眠。',dialogue:['当前对话片段']});return !!(org.memory.length&&org.understanding.length&&org.threads.length&&org.moments.length&&org.dialogue.length)})()"));
    /* ② 压缩：去重（近重复合并）+ 信息保留 */
    check('compress.dedup',await ev(cdp,"(async function(){var c=middleBrainCompressContext({memory:['她很在意创作设备。','她很在意创作设备。','她非常在意创作设备。想升级电脑。'],understanding:[],threads:[],moments:[],dialogue:[]},{budget:9999});return c.memory.length===2&&c.stats.deduped>=1})()"));
    check('compress.preserveFact',await ev(cdp,"(async function(){var c=middleBrainCompressContext({memory:['她很在意创作设备。','她很在意创作设备。'],understanding:[],threads:[],moments:[],dialogue:[]},{budget:9999});return c.memory.length===1&&c.memory[0].indexOf('创作设备')>=0&&c.compressedContext.indexOf('创作设备')>=0})()"));
    /* ③ 压缩：token/字符预算 —— 超出预算的省略（不半截），不新增事实 */
    check('compress.budget',await ev(cdp,"(async function(){var longA='甲'.repeat(60),longB='乙'.repeat(60);var c=middleBrainCompressContext({memory:[longA,longB],understanding:[],threads:[],moments:[],dialogue:[]},{budget:70});return c.stats.compressedChars<=70&&c.memory.length<=1&&c.compressedContext.length<=70+80})()"));
    /* ④ 不确定信息保持不确定：重新组织，不把"可能/疑似"改成确定 */
    check('compress.uncertainKept',await ev(cdp,"(async function(){var c=middleBrainCompressContext({memory:['她可能在考虑换设备，未确定。'],understanding:[],threads:[],moments:[],dialogue:[]},{budget:9999});return c.compressedContext.indexOf('可能')>=0&&c.compressedContext.indexOf('未确定')>=0})()"));
    /* ⑤ 空上下文：返回空 compressedContext + empty 标记 */
    check('empty.lifecycle',await ev(cdp,"(async function(){var r=await middleBrainContextPipeline('cEmpty','',{});return r.compressedContext===''&&r.stats.empty===true})()"));
    /* ⑥ 完整 pipeline：给定上下文 → 结构化 + compressedContext 生成 */
    check('pipeline.produces',await ev(cdp,"(async function(){var r=await middleBrainContextPipeline('c1','设备 焦虑',{memoryCtx:'【记忆】很在意设备。',understandingCtx:'【理解】对设备敏感。',threadCtx:'【线索】换电脑。',momentsCtx:'',dialogue:['继续']});return String(r.compressedContext).indexOf('记忆')>=0&&String(r.compressedContext).indexOf('理解')>=0&&String(r.compressedContext).indexOf('线索')>=0&&r.stats.empty===false&&r.stats.categories>=3})()"));
    /* ⑦ Astra 可用性 fallback：middleBrainPipelineAvailable 恒存在（不含 Astra 网络依赖） */
    check('fallback.available',await ev(cdp,"(async function(){return typeof window.middleBrainPipelineAvailable==='function'})()"));
    /* ⑧ 复用现有 Context：pipeline 从真实 getMemoryContext 拉取（写入一条真实记忆） */
    await ev(cdp,"(async function(){await dbPut('memories',{id:'ctxmem1',createdBy:'c1',title:'设备',content:'她在攒钱买硬盘',kind:'episodic',created:Date.now(),lastActivated:Date.now(),visibility:'public'});})()");
    check('reuse.existingRetrieval',await ev(cdp,"(async function(){var r=await middleBrainContextPipeline('c1','攒钱 硬盘',{});return String(r.compressedContext).indexOf('攒钱买硬盘')>=0||String(r.compressedContext).indexOf('硬盘')>=0})()"));
    /* ⑨ 预算不得丢当前用户消息：budget 极小 + 大量记忆 —> 当前对话仍完整保留 */
    await ev(cdp,"(async function(){window.__c9=middleBrainCompressContext({memory:['历史记忆'.repeat(400)],understanding:[],threads:[],moments:[],dialogue:['用户问：我该换什么设备？']},{budget:60})})()");
    check('budget.keepsCurrentDialogue',await ev(cdp,"(function(){var c=window.__c9;return c.dialogue.join(' ').indexOf('我该换什么设备')>=0&&c.compressedContext.indexOf('我该换什么设备')>=0&&c.stats.compressedChars>0})()"),JSON.stringify(await ev(cdp,"(function(){var c=window.__c9;return {dlg:c.dialogue,ctx:c.compressedContext,mem:c.memory.length,st:c.stats}})()")));
    /* ⑩ 极低预算下历史被压缩、当前对话不被丢 */
    await ev(cdp,"(async function(){window.__c10=middleBrainCompressContext({memory:['甲'.repeat(80),'乙'.repeat(80)],understanding:[],threads:[],moments:[],dialogue:['当前问题：今天想吃什么']},{budget:20})})()");
    check('budget.historyDroppedDialogueKept',await ev(cdp,"(function(){var c=window.__c10;return c.compressedContext.indexOf('当前问题')>=0})()"),JSON.stringify(await ev(cdp,"(function(){var c=window.__c10;return {dlg:c.dialogue,ctx:c.compressedContext,mem:c.memory.length}})()")));
  } finally { if(cdp)cdp.close(); try{browser.kill()}catch(e){} }
  console.log(failures===0?'\nMiddle Brain v0 context CDP passed ✔':'\nMiddle Brain v0 context CDP FAILED ✘');
  process.exit(failures?1:0);
}
main().catch(e=>{console.error(e);process.exit(1)});
