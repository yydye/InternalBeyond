'use strict';

/* Activity / Favorites / App Store 浏览器冒烟测试（Node 18+，零依赖，需 Chrome / Edge）。
   覆盖：v21 新 store、IB.activity 会话与上下文注入、跨模块收藏层、
   App Store manifest+loader、共读间书架/分页、双挂载与运行时零异常。 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');
const crypto = require('crypto');
const { pathToFileURL } = require('url');

const PAGE_URL = pathToFileURL(path.join(__dirname, 'InternalBeyond.html')).href;

function chromePath() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  return [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
  ].find(fs.existsSync) || null;
}

class Cdp {
  constructor(socket) { this.socket = socket; this.buffer = Buffer.alloc(0); this.id = 0; this.pending = new Map(); this.listeners = new Map(); socket.on('data', c => { this.buffer = Buffer.concat([this.buffer, c]); this.parse(); }); socket.on('error', () => {}); }
  static connect(wsUrl) { return new Promise((resolve, reject) => { const url = new URL(wsUrl); const req = http.request({ host: url.hostname, port: url.port, path: url.pathname + url.search, headers: { Upgrade: 'websocket', Connection: 'Upgrade', 'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'), 'Sec-WebSocket-Version': '13' } }); req.on('upgrade', (res, socket) => resolve(new Cdp(socket))); req.on('error', reject); req.end(); }); }
  on(method, listener) { if (!this.listeners.has(method)) this.listeners.set(method, []); this.listeners.get(method).push(listener); }
  send(method, params = {}) { const id = ++this.id; return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.sendText({ id, method, params }); setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('CDP timeout: ' + method)); } }, 15000); }); }
  sendText(m) { const p = Buffer.from(JSON.stringify(m)); const mask = crypto.randomBytes(4); const body = Buffer.alloc(p.length); for (let i = 0; i < p.length; i++) body[i] = p[i] ^ mask[i & 3]; let h; if (p.length < 126) h = Buffer.from([0x81, 0x80 | p.length]); else { h = Buffer.alloc(4); h[0] = 0x81; h[1] = 0x80 | 126; h.writeUInt16BE(p.length, 2); } this.socket.write(Buffer.concat([h, mask, body])); }
  sendFrame(op, payload) { const mask = crypto.randomBytes(4); const body = Buffer.alloc(payload.length); for (let i = 0; i < payload.length; i++) body[i] = payload[i] ^ mask[i & 3]; const h = payload.length < 126 ? Buffer.from([0x80 | op, 0x80 | payload.length]) : Buffer.alloc(4); if (payload.length >= 126) { h[0] = 0x80 | op; h[1] = 0x80 | 126; h.writeUInt16BE(payload.length, 2); } this.socket.write(Buffer.concat([h, mask, body])); }
  parse() { while (true) { if (this.buffer.length < 2) return; const op = this.buffer[0] & 0x0f; let len = this.buffer[1] & 0x7f; let off = 2; if (len === 126) { if (this.buffer.length < 4) return; len = this.buffer.readUInt16BE(2); off = 4; } else if (len === 127) { return; } if (this.buffer.length < off + len) return; const payload = this.buffer.slice(off, off + len); this.buffer = this.buffer.slice(off + len); if (op === 1) { try { const msg = JSON.parse(payload.toString('utf8')); if (this.pending.has(msg.id)) { const p = this.pending.get(msg.id); this.pending.delete(msg.id); if (msg.error) p.reject(new Error(msg.error.message)); else p.resolve(msg.result); } if (msg.method && this.listeners.has(msg.method)) for (const l of this.listeners.get(msg.method)) l(msg.params); } catch (e) { /* ignore */ } } } }
  close() { try { this.socket.end(); } catch (e) {} }
}

async function evaluate(cdp, expression) { const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error('page exception: ' + JSON.stringify(r.exceptionDetails.exception)); return r.result && r.result.value; }
async function waitFor(cdp, expression, timeout = 15000) { const end = Date.now() + timeout; while (Date.now() < end) { try { if (await evaluate(cdp, expression)) return true; } catch (e) {} await new Promise(r => setTimeout(r, 120)); } return false; }
function freePort() { return new Promise((resolve, reject) => { const s = net.createServer(); s.unref(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(e => e ? reject(e) : resolve(p)); }); }); }

async function main() {
  const chrome = chromePath(); if (!chrome) throw new Error('未找到 Chrome / Edge');
  const port = await freePort();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-activity-smoke-'));
  const browser = spawn(chrome, ['--headless=new','--disable-gpu','--no-sandbox','--no-first-run','--allow-file-access-from-files','--remote-debugging-address=127.0.0.1','--remote-debugging-port=' + port,'--user-data-dir=' + profile,'about:blank'], { stdio: 'ignore' });
  let failures = 0, cdp;
  const check = (n, ok, d = '') => { if (ok) console.log('  PASS  ' + n); else { failures++; console.error('  FAIL  ' + n + (d ? ' -> ' + d : '')); } };
  try {
    let ready = false; for (let i = 0; i < 120; i++) { try { if ((await fetch('http://127.0.0.1:' + port + '/json/version')).ok) { ready = true; break; } } catch (e) {} await new Promise(r => setTimeout(r, 100)); }
    check('browser.ready', ready); if (!ready) throw new Error('CDP 未就绪');
    const tab = await (await fetch('http://127.0.0.1:' + port + '/json/new?' + encodeURIComponent(PAGE_URL), { method: 'PUT' })).json();
    cdp = await Cdp.connect(tab.webSocketDebuggerUrl); await cdp.send('Runtime.enable');
    const exceptions = []; cdp.on('Runtime.exceptionThrown', p => exceptions.push(JSON.stringify(p.exceptionDetails || {})));
    await evaluate(cdp, "window.confirm=function(){return true;}");
    check('page.ready', await waitFor(cdp, "window.IB&&IB.activity&&typeof dbPut==='function'", 20000));

    /* v21 新 store + 双挂载 */
    check('db.stores', await evaluate(cdp, "(async function(){var d=await ensureDB();return DB_VER===21&&d.objectStoreNames.contains('activities')&&d.objectStoreNames.contains('favorites')})()"));
    check('dual.activity', await evaluate(cdp, "typeof window.IBActivity==='object'&&typeof IB.activity.createActivity==='function'"));
    check('dual.favorites', await evaluate(cdp, "typeof window.favAdd==='function'&&typeof IB.favorites.add==='function'"));
    check('dual.appstore', await evaluate(cdp, "typeof IB.apps==='object'&&typeof IB.apps.register==='function'&&typeof IBApps.boot==='function'"));

    const cfg = "{id:'act_a',provider:'openai',model:'m',endpoint:'http://127.0.0.1:1/v1',apiKey:'',nickname:'书友',systemPrompt:'你是测试角色'}";
    await evaluate(cdp, "(async function(){await dbPut('apiConfigs'," + cfg + ");await loadApiConfigs();await dbPut('posts',{id:'post_1',title:'夜航西飞',subtitle:'',content:'第一章 启程\\n\\n我们出发时，海面潋滟。\\n\\n第二章 归途\\n\\n彼时潮声未歇。',created:Date.now()});})()");

    /* Activity 会话 + 上下文注入 */
    const act = await evaluate(cdp, "IB.activity.createActivity({type:'coread',roleId:'act_a',resourceId:'post_1',resourceKey:'post_1',title:'夜航西飞',kind:'coread',name:'共读 · 夜航西飞',progress:{page:1,total:2,pct:50,pageText:'我们出发时，海面潋滟。'}}).then(function(a){return{id:a.id,roleId:a.roleId,threadId:a.threadId,type:a.type}})");
    check('activity.create', act && /^act_/.test(act.id) && act.roleId === 'act_a' && /^thread_/.test(act.threadId), JSON.stringify(act));
    const found = await evaluate(cdp, "IB.activity.findActivity('coread','act_a','post_1').then(function(a){return!!a})");
    check('activity.findActivity', found === true, String(found));

    /* 上下文：活动频道注入，普通频道不注入 */
    const ctx = await evaluate(cdp, "IB.activity.getActivityContext('act_a',{threadId:'" + (act ? act.threadId : 'none') + "'})");
    check('activity.contextInject', typeof ctx === 'string' && ctx.indexOf('共读') >= 0 && ctx.indexOf('夜航西飞') >= 0 && ctx.indexOf('海面潋滟') >= 0, String(ctx).slice(0, 160));
    const ctxNone = await evaluate(cdp, "IB.activity.getActivityContext('act_a',{threadId:'thread_none'})");
    check('activity.contextNone', ctxNone === '', String(ctxNone).slice(0, 120));

    /* 进度更新 */
    const prog = await evaluate(cdp, "IB.activity.setProgress('" + (act ? act.id : 'none') + "',{page:2,total:2,pct:100,pageText:'彼时潮声未歇。'}).then(function(a){return a&&a.progress&&a.progress.page})");
    check('activity.setProgress', prog === 2, String(prog));

    /* 收藏层（跨模块） */
    const fav = await evaluate(cdp, "IB.favorites.add({type:'blog',roleId:'',sourceId:'post_1',title:'夜航西飞',body:'书签一段'});IB.favorites.add({type:'chat',roleId:'act_a',sourceId:'msg_x',body:'一句值得留的话'}).then(function(){return IB.favorites.count()})");
    check('favorites.add', fav === 2, String(fav));
    check('favorites.has', await evaluate(cdp, "IB.favorites.has('post_1').then(function(h){return h===true})"));
    const favList = await evaluate(cdp, "IB.favorites.list({type:'blog'}).then(function(l){return l.length===1&&l[0].type==='blog'&&l[0].sourceId==='post_1'})");
    check('favorites.list', favList === true, String(favList));
    check('favorites.remove', await evaluate(cdp, "(async function(){var l=await IB.favorites.list({type:'blog'});await IB.favorites.remove(l[0].id);return (await IB.favorites.count())===1})()"));

    /* App Store：manifest + loader */
    check('appstore.catalog', await waitFor(cdp, "IB.apps&&IB.apps.catalog&&IB.apps.catalog().length>=2"));
    const cat = await evaluate(cdp, "IB.apps.catalog().map(function(a){return a.id+':'+(a.file||'inline')})");
    check('appstore.catalogShape', /coread:inline/.test(cat || '') && /cinema:ib-app-cinema\.js/.test(cat || ''), String(cat));
    check('appstore.install', await evaluate(cdp, "(function(){IB.apps.install('cinema');return IB.apps.isInstalled('cinema')})()"));
    check('appstore.registerGate', await evaluate(cdp, "IB.apps.register({id:'xx_bad--',name:'x',sdk:3,mount:function(){}})===false&&IB.apps.register({id:'good',name:'g',sdk:2,mount:function(){}})===true"));

    /* 共读间书架渲染 */
    await evaluate(cdp, "loadCoreadPage()");
    check('coread.shelf', await waitFor(cdp, "document.querySelectorAll('.cr-book').length>=1"));
    check('coread.open', await evaluate(cdp, "coreadOpen('post_1').then(function(){return document.getElementById('coread-read-view').style.display==='block'})"));

    /* 收藏页渲染 */
    await evaluate(cdp, "favOpenPage()");
    check('favorites.render', await waitFor(cdp, "document.querySelectorAll('.fav-paper').length>=1"));

    /* Proactive 联动：nudge 应写出一条活动感知的主动计划 */
    check('activity.nudge', await evaluate(cdp, "(async function(){await IB.activity.nudge({activityId:'" + (act ? act.id : 'none') + "'});var plans=await dbGetAll('active_message_plans');return plans.some(function(p){return p.characterId==='act_a'&&p.source==='ai_planned'&&p.intent&&p.intent.indexOf('共读')>=0})})()"));

    /* Favorites 复用控件：makeBtn / starCard / 跳回原内容 */
    check('fav.controls', await evaluate(cdp, "typeof IB.favorites.makeBtn==='function'&&typeof IB.favorites.starCard==='function'&&typeof window._favOpenItem==='function'"));
    check('fav.starCard', await evaluate(cdp, "(function(){var el=document.createElement('div');var b=IB.favorites.starCard(el,{type:'blog',sourceId:'post_1',title:'t',body:'b'});return el.contains(b)&&b.className.indexOf('fav-toggle-btn')>=0})()"));

    /* Cinema 流式接入：宿主 broadcast → 打开中的 App 经 ctx.on('message'|'turn') 收到 */
    const streamGot = await evaluate(cdp, "(async function(){var got=[];IB.apps.register({id:'mockapp',name:'mock',sdk:2,mount:async function(h,c){c.on('message',function(m){got.push('m:'+(m&&m.content))});c.on('turn',function(t){got.push('turn:'+(t&&t.state))})}});IB.apps.open('mockapp');IB.apps.broadcast('message',{role:'assistant',content:'弹幕内容'});IB.apps.broadcast('turn',{state:'end'});await new Promise(function(r){setTimeout(r,60)});return got.join(',')})()");
    check('appstream.emit', /m:弹幕内容/.test(streamGot || '') && /turn:end/.test(streamGot || ''), String(streamGot));

    await new Promise(r => setTimeout(r, 300));
    check('runtime.noExceptions', exceptions.length === 0, exceptions.join('\n').slice(0, 500));
    console.log(failures ? '\nActivity/Favorites/AppStore smoke failed: ' + failures : '\nActivity/Favorites/AppStore smoke passed ✔');
  } finally {
    if (cdp) cdp.close(); try { browser.kill(); } catch (e) {}
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {}
  }
  if (failures) process.exitCode = 1;
}
main();
