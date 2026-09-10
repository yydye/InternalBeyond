'use strict';

/* Internal Beyond · Image Router 配置层 浏览器冒烟（Node 18+，零依赖，需 Chrome / Edge）
   --------------------------------------------------------------------
   验证"配置 UI → 真实请求体"的完整闭环（纯逻辑见 test_image_router_config.js）：
     ① Settings → API 里真实出现 Image Router 区块与两条路由卡片
     ② 「+ 新建」复用既有 API 编辑器（不是第二套表单）
     ③ 模型下拉来自唯一模型目录（含 Image 2.5 的**真实 id**），按能力过滤
     ④ 保存 → apiSettings['image_router'].routes → 刷新页面后配置仍在、UI 一致
     ⑤ Generation 路由绑定 API 配置 + 模型 → 真实 /images/generations 用该 Key 与模型
     ⑥ Editing 路由可以绑定**不同**模型 → 真实 /images/edits（multipart）用编辑路由的模型
     ⑦ 改模型后 request body 的 model 同步改变
     ⑧ 缺 Key / 路由关闭 / 绑定配置不存在 → 明确错误码 + 0 次 provider 请求
     ⑨ 备用通道：主通道 provider 失败后重试一次（备用配置的 Key + 模型）
     ⑩ telemetry 含路由来源，且不含 API Key / base64
   运行：node test_image_router_settings_smoke.js
   ==================================================================== */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

/* Repository root — this file lives in tests/, so the root is one level up. */
const ROOT = path.resolve(__dirname, '..');
const http = require('http');
const net = require('net');
const crypto = require('crypto');
const { pathToFileURL } = require('url');


const PAGE_URL = pathToFileURL(path.join(ROOT, 'InternalBeyond.html')).href;
const TINY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/AF/oS8AAAAASUVORK5CYII=';
const TINY_BUF = Buffer.from(TINY_PNG, 'base64');
const payload = (s) => Buffer.concat([TINY_BUF, Buffer.from(String(s), 'utf8')]).toString('base64');

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
  constructor(socket) {
    this.socket = socket; this.buffer = Buffer.alloc(0); this.id = 0;
    this.pending = new Map(); this.listeners = new Map();
    socket.on('data', chunk => { this.buffer = Buffer.concat([this.buffer, chunk]); this.parse(); });
    socket.on('error', () => {});
  }
  static connect(wsUrl) {
    return new Promise((resolve, reject) => {
      const url = new URL(wsUrl);
      const req = http.request({ host: url.hostname, port: url.port, path: url.pathname + url.search, headers: {
        Upgrade: 'websocket', Connection: 'Upgrade',
        'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'), 'Sec-WebSocket-Version': '13'
      }});
      req.on('upgrade', (res, socket) => resolve(new Cdp(socket)));
      req.on('error', reject); req.end();
    });
  }
  on(method, listener) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(listener);
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject }); this.sendText({ id, method, params });
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('CDP timeout: ' + method)); } }, 30000);
    });
  }
  sendText(message) {
    const buf = Buffer.from(JSON.stringify(message)); const mask = crypto.randomBytes(4);
    const body = Buffer.alloc(buf.length); for (let i = 0; i < buf.length; i++) body[i] = buf[i] ^ mask[i & 3];
    let header;
    if (buf.length < 126) header = Buffer.from([0x81, 0x80 | buf.length]);
    else { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 0x80 | 126; header.writeUInt16BE(buf.length, 2); }
    this.socket.write(Buffer.concat([header, mask, body]));
  }
  sendFrame(opcode, p) {
    const mask = crypto.randomBytes(4); const body = Buffer.alloc(p.length);
    for (let i = 0; i < p.length; i++) body[i] = p[i] ^ mask[i & 3];
    const header = p.length < 126 ? Buffer.from([0x80 | opcode, 0x80 | p.length]) : Buffer.alloc(4);
    if (p.length >= 126) { header[0] = 0x80 | opcode; header[1] = 0x80 | 126; header.writeUInt16BE(p.length, 2); }
    this.socket.write(Buffer.concat([header, mask, body]));
  }
  parse() {
    for (;;) {
      if (this.buffer.length < 2) return;
      const first = this.buffer[0], short = this.buffer[1] & 0x7f; let off = 2, len = short;
      if (short === 126) { if (this.buffer.length < 4) return; len = this.buffer.readUInt16BE(2); off = 4; }
      else if (short === 127) { if (this.buffer.length < 10) return; len = this.buffer.readUInt32BE(6); off = 10; }
      const masked = (this.buffer[1] & 0x80) !== 0; let mask = null;
      if (masked) { if (this.buffer.length < off + 4) return; mask = this.buffer.subarray(off, off + 4); off += 4; }
      if (this.buffer.length < off + len) return;
      let p = this.buffer.subarray(off, off + len); this.buffer = this.buffer.subarray(off + len);
      if (mask) { const out = Buffer.alloc(len); for (let i = 0; i < len; i++) out[i] = p[i] ^ mask[i & 3]; p = out; }
      const opcode = first & 0x0f;
      if (opcode === 0x8) return this.close();
      if (opcode === 0x9) { this.sendFrame(0xA, p); continue; }
      if (opcode !== 0x1) continue;
      let msg; try { msg = JSON.parse(p.toString()); } catch (error) { continue; }
      if (msg.id && this.pending.has(msg.id)) {
        const pr = this.pending.get(msg.id); this.pending.delete(msg.id);
        if (msg.error) pr.reject(new Error(JSON.stringify(msg.error))); else pr.resolve(msg.result || {});
      } else if (msg.method && this.listeners.has(msg.method)) {
        for (const listener of this.listeners.get(msg.method)) listener(msg.params || {});
      }
    }
  }
  close() { try { this.socket.destroy(); } catch (error) { /* ignore */ } }
}
async function evaluate(cdp, expression) {
  const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error('page exception: ' + JSON.stringify(r.exceptionDetails.exception));
  return r.result && r.result.value;
}
async function waitFor(cdp, expression, timeout = 25000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { try { if (await evaluate(cdp, expression)) return true; } catch (error) {} await new Promise(r => setTimeout(r, 120)); }
  return false;
}
function freePort() {
  return new Promise((resolve, reject) => { const s = net.createServer(); s.unref(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(e => e ? reject(e) : resolve(p)); }); });
}
function parseMultipart(buf, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(String(contentType || ''));
  if (!m) return null;
  const boundary = Buffer.from('--' + String(m[1] || m[2]).trim());
  const out = [];
  let idx = buf.indexOf(boundary);
  while (idx !== -1) {
    const start = idx + boundary.length;
    const next = buf.indexOf(boundary, start);
    if (next === -1) break;
    let seg = buf.subarray(start, next);
    if (seg.subarray(0, 2).toString() === '\r\n') seg = seg.subarray(2);
    if (seg.subarray(seg.length - 2).toString() === '\r\n') seg = seg.subarray(0, seg.length - 2);
    const headerEnd = seg.indexOf(Buffer.from('\r\n\r\n'));
    if (headerEnd !== -1) {
      const headers = seg.subarray(0, headerEnd).toString('utf8');
      const nameM = /name="([^"]+)"/i.exec(headers);
      out.push({ name: nameM ? nameM[1] : '', body: seg.subarray(headerEnd + 4) });
    }
    idx = next;
  }
  return out;
}
/* mock provider：generations(JSON) + edits(multipart)；failModels 命中的模型返回 500（测备用通道） */
function startMockApi() {
  const hits = [];
  let failModels = [];
  const server = http.createServer((req, res) => {
    const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-API-Key' };
    if (req.method === 'OPTIONS') { res.writeHead(204, headers); res.end(); return; }
    if (req.method === 'GET' && /\/stats/.test(req.url || '')) { res.writeHead(200, headers); res.end(JSON.stringify({ hits })); return; }
    if (req.method === 'POST' && /\/fail-models/.test(req.url || '')) {
      const chunks = []; req.on('data', c => chunks.push(c));
      req.on('end', () => { try { failModels = JSON.parse(Buffer.concat(chunks).toString() || '[]'); } catch (error) { failModels = []; } res.writeHead(200, headers); res.end('{"ok":true}'); });
      return;
    }
    const isEdit = req.method === 'POST' && /images\/edits/i.test(req.url || '');
    const isGen = req.method === 'POST' && /images\/generations/i.test(req.url || '');
    if (!isEdit && !isGen) { res.writeHead(404, headers); res.end('{}'); return; }
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      let model = '', prompt = '', quality = '', images = [], partNames = [];
      if (isEdit) {
        const parts = parseMultipart(raw, req.headers['content-type']) || [];
        partNames = parts.map(p => p.name);
        parts.forEach(p => {
          if (p.name === 'image' || p.name === 'image[]') images.push(p.body.toString('base64'));
          else if (p.name === 'model') model = p.body.toString('utf8');
          else if (p.name === 'prompt') prompt = p.body.toString('utf8');
          else if (p.name === 'quality') quality = p.body.toString('utf8');
        });
      } else {
        try { const j = JSON.parse(raw.toString('utf8') || '{}'); model = String(j.model || ''); prompt = String(j.prompt || ''); quality = String(j.quality || ''); } catch (error) { /* ignore */ }
      }
      const hit = { kind: isEdit ? 'edit' : 'gen', model, prompt, quality, images, partNames,
        contentType: String(req.headers['content-type'] || ''), auth: String(req.headers.authorization || '') };
      hits.push(hit);
      const fail = failModels.some(m => model.indexOf(m) >= 0);
      setTimeout(() => {
        if (fail) { res.writeHead(500, headers); res.end(JSON.stringify({ error: { message: 'mock provider failure' } })); return; }
        res.writeHead(200, headers);
        res.end(JSON.stringify({ data: [{ b64_json: payload((isEdit ? 'EDT' : 'GEN') + hits.length) }], usage: { prompt_tokens: 1, output_tokens: 1 } }));
      }, 30);
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, hits })));
}

(async () => {
  const chrome = chromePath();
  let failures = 0;
  const check = (name, ok, detail = '') => { if (ok) console.log('  PASS  ' + name); else { failures++; console.error('  FAIL  ' + name + (detail ? '  -> ' + detail : '')); } };
  if (!chrome) { console.error('  FAIL  browser.notFound  -> 未找到 Chrome/Edge'); process.exit(1); }
  const mock = await startMockApi();
  const BASE = 'http://127.0.0.1:' + mock.port;
  const EP = BASE + '/v1/chat/completions';
  const IMG_EP = BASE + '/v1';
  const stats = async () => (await (await fetch(BASE + '/stats')).json());
  const setFailModels = async (list) => { await fetch(BASE + '/fail-models', { method: 'POST', body: JSON.stringify(list) }); };
  const port = await freePort();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-ir-settings-'));
  const browser = spawn(chrome, ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    '--allow-file-access-from-files', '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=' + port, '--user-data-dir=' + profile, 'about:blank'], { stdio: 'ignore' });
  let cdp = null;
  try {
    let ready = false;
    for (let i = 0; i < 150; i++) { try { if ((await fetch('http://127.0.0.1:' + port + '/json/version')).ok) { ready = true; break; } } catch (error) {} await new Promise(r => setTimeout(r, 100)); }
    check('browser.ready', ready);
    if (!ready) throw new Error('CDP 未就绪');
    const tab = await (await fetch('http://127.0.0.1:' + port + '/json/new?' + encodeURIComponent(PAGE_URL), { method: 'PUT' })).json();
    cdp = await Cdp.connect(tab.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    const exceptions = [];
    cdp.on('Runtime.exceptionThrown', p => exceptions.push(JSON.stringify(p.exceptionDetails || {}).slice(0, 300)));

    check('page.modulesLoaded', await waitFor(cdp, "window.IBImageModelsCore&&window.IBImageRouterCore&&window.IB&&IB.imageModels&&IB.imageModels.available===true&&IB.imageRouterConfig&&IB.imageRouterSettings&&IB.imageRouter&&IB.imageRouter.available===true&&typeof _wsExecImageGen==='function'"));
    check('page.catalogIsImage25', await evaluate(cdp, "IB.imageModels.list({capability:'image-generation'}).some(function(m){return m.id==='gpt-image-2.5-flare'})&&IB.imageModels.list({capability:'image-editing'}).some(function(m){return m.id==='gpt-image-2.5-sunburst'})"));
    check('page.routerUsesCatalogIds', await evaluate(cdp, "IB.imageRouter.IMAGE_MODELS.flare==='gpt-image-2.5-flare'&&IB.imageRouter.IMAGE_MODELS.sunburst==='gpt-image-2.5-sunburst'"));

    /* ── ① 种子：两个图片 API 配置 + 一个"图片凭证为空"的角色 ── */
    await evaluate(cdp, "(async function(){"
      + "await dbPut('apiConfigs',{id:'ir_main',provider:'openai',model:'text-main',endpoint:'" + EP + "',apiKey:'sk-text-main',nickname:'主图片配置',imageGen:true,imageGenModel:'',imageGenEndpoint:'" + IMG_EP + "',imageGenApiKey:'sk-main-image'});"
      + "await dbPut('apiConfigs',{id:'ir_backup',provider:'openai',model:'text-backup',endpoint:'" + EP + "',apiKey:'sk-text-backup',nickname:'备用图片配置',imageGen:true,imageGenModel:'',imageGenEndpoint:'" + IMG_EP + "',imageGenApiKey:'sk-backup-image'});"
      + "await dbPut('apiConfigs',{id:'ir_nokey',provider:'openai',model:'text-nokey',endpoint:'https://api.openai.com/v1/chat/completions',apiKey:'',nickname:'没钥匙',imageGen:true,imageGenModel:'',imageGenEndpoint:'',imageGenApiKey:''});"
      + "await dbPut('apiConfigs',{id:'ir_local',provider:'openai',model:'text-local',endpoint:'" + EP + "',apiKey:'',nickname:'本地无Key',imageGen:true,imageGenModel:'',imageGenEndpoint:'" + IMG_EP + "',imageGenApiKey:''});"
      + "await dbPut('apiConfigs',{id:'ir_char',provider:'openai',model:'text-char',endpoint:'" + EP + "',apiKey:'sk-char-text',nickname:'角色',systemPrompt:'x',imageGen:true,imageGenModel:'',imageGenEndpoint:'',imageGenApiKey:''});"
      + "await loadApiConfigs();return true})()");
    /* 真实入口是 navTo('api') → loadApiSettingsUI() → loadImageRouterSettingsUI()：
       种子之后刷新一次，让绑定下拉看到刚写入的 API 配置 */
    await evaluate(cdp, "(async function(){await loadImageRouterSettingsUI();return true})()");
    check('ui.refreshPicksUpConfigs', await evaluate(cdp, "document.getElementById('ir-config-generation').options.length>=4"));

    /* ── ② UI 真实存在 ── */
    check('ui.sectionPresent', await evaluate(cdp, "!!document.getElementById('image-router-section')&&!!document.getElementById('ir-route-generation')&&!!document.getElementById('ir-route-editing')"));
    check('ui.twoRouteCardsRendered', await waitFor(cdp, "document.querySelectorAll('#image-router-section .ir-card').length===2"));
    check('ui.routeTitles', await evaluate(cdp, "[].map.call(document.querySelectorAll('#image-router-section .ir-card-title'),function(e){return e.textContent}).join('|')==='Image Generation|Image Editing'"));
    /* A1.5：不再有「+ 新建」。IB 没有独立的图片 API 配置实体，点它会打开角色 API 编辑器，
       所以这个入口被移除，文案改为如实描述（图片 API 来源 / 跟随当前角色）。 */
    check('ui.noCreateEntry', await evaluate(cdp, "(function(){return !document.querySelector('#image-router-section .ir-new')&&!document.querySelector('#ir-card-generation button[onclick]')&&!document.querySelector('#ir-card-editing button[onclick]')})()"));
    check('ui.sourceWordingAccurate', await evaluate(cdp, "(function(){var t=document.getElementById('image-router-section').textContent;return t.indexOf('图片 API 来源')>=0&&t.indexOf('跟随当前角色')>=0&&t.indexOf('API Config')<0})()"));
    check('ui.statesCredentialOrigin', await evaluate(cdp, "document.getElementById('image-router-section').textContent.indexOf('图片服务商 / 图片接口地址 / 图片 API Key')>=0"));
    /* 图片来源下拉里必须仍能看到具体配置：选项保持「昵称 · provider · model」 */
    check('ui.configOptionsFromApiConfigs', await evaluate(cdp, "(function(){var s=document.getElementById('ir-config-generation');var t=[].map.call(s.options,function(o){return o.textContent}).join('|');var first=s.options[0]?s.options[0].textContent:'';return s.options.length>=4&&t.indexOf('主图片配置')>=0&&first==='跟随当前角色'&&/主图片配置 · openai · /.test(t)})()"));
    check('ui.modelOptionsFilteredByCapability', await evaluate(cdp, "(function(){var g=[].map.call(document.getElementById('ir-model-generation').options,function(o){return o.value});var e=[].map.call(document.getElementById('ir-model-editing').options,function(o){return o.value});return g.indexOf('gpt-image-2.5-flare')>=0&&g.indexOf('dall-e-3')>=0&&e.indexOf('gpt-image-2.5-sunburst')>=0&&e.indexOf('dall-e-3')<0})()"));
    check('ui.modelOptionShowsRealId', await evaluate(cdp, "[].map.call(document.getElementById('ir-model-generation').options,function(o){return o.textContent}).join('|').indexOf('gpt-image-2.5-flare')>=0"));
    check('ui.datalistFromCatalog', await evaluate(cdp, "(function(){var d=document.getElementById('api-imagegen-model-list');return !!d&&[].map.call(d.options,function(o){return o.value}).indexOf('gpt-image-2.5-sunburst')>=0})()"));
    check('ui.routeLineVisible', await evaluate(cdp, "document.getElementById('ir-line-generation').textContent.indexOf('Image Generation')>=0&&document.getElementById('ir-line-generation').textContent.indexOf('→')>=0"));

    /* ── ②b A1.5 布局：API 页顶级卡片垂直节奏（结构性 contract，且与折叠状态无关） ──
       修复前：系统诊断入口是 JS 注入的顶级卡、不带 .api-section，于是与 Middle Brain
       之间是 0px。这里同时验证「四张顶级卡都是同一条 28px 节奏」与「折叠 / 展开
       Middle Brain、Image Router 后间距不变」（间距挂在外层卡上，不随内容高度变化）。 */
    await evaluate(cdp, "(async function(){try{navTo('api');}catch(e){}await loadImageRouterSettingsUI();return true})()");
    const measureSpacing = "(function(){"
      + "function mb(n){if(!n)return null;try{return getComputedStyle(n).marginBottom}catch(e){return null}}"
      + "function cls(n){var e=document.getElementById(n);return e?String(e.className):null}"
      + "var t=document.getElementById('api-mgmt-title');"
      + "var mgmt=(t&&t.closest)?t.closest('.api-section'):null;"
      + "return{diag:mb(document.getElementById('ib-diag-entry')),"
      + "middle:mb(document.getElementById('middle-brain-section')),"
      + "router:mb(document.getElementById('image-router-section')),mgmt:mb(mgmt),"
      + "mbBody:cls('mb-collapse-body'),irBody:cls('ir-collapse-body')}})()";
    const spTop = ['diag', 'middle', 'router', 'mgmt'];
    const spOpen = await evaluate(cdp, measureSpacing);
    check('spacing.fourTopLevelCardsShare28px', spOpen && spTop.every(k => spOpen[k] === '28px'), JSON.stringify(spOpen));
    /* 真实点击两个 header 折叠（不是直接改 class），再测一次 */
    await evaluate(cdp, "(function(){document.getElementById('mb-collapse-toggle').click();document.getElementById('ir-collapse-toggle').click();return true})()");
    const spClosed = await evaluate(cdp, measureSpacing);
    check('spacing.collapseActuallyTookEffect', !!(spClosed && /is-collapsed/.test(spClosed.mbBody) && /is-collapsed/.test(spClosed.irBody)), JSON.stringify(spClosed));
    check('spacing.unchangedWhenCollapsed', spClosed && spTop.every(k => spClosed[k] === '28px'), JSON.stringify(spClosed));
    await evaluate(cdp, "(function(){document.getElementById('mb-collapse-toggle').click();document.getElementById('ir-collapse-toggle').click();return true})()");
    const spBack = await evaluate(cdp, measureSpacing);
    check('spacing.unchangedWhenExpandedAgain', !!(spBack && spTop.every(k => spBack[k] === '28px') && !/is-collapsed/.test(spBack.mbBody) && !/is-collapsed/.test(spBack.irBody)), JSON.stringify(spBack));

    /* ── ③ 保存：Generation → 主配置 + Sunburst；Editing → 主配置 + Flare ── */
    const saved = await evaluate(cdp, "(async function(){"
      + "document.getElementById('ir-enabled-generation').checked=true;"
      + "document.getElementById('ir-config-generation').value='ir_main';"
      + "document.getElementById('ir-model-generation').value='gpt-image-2.5-sunburst';"
      + "document.getElementById('ir-enabled-editing').checked=true;"
      + "document.getElementById('ir-config-editing').value='ir_main';"
      + "document.getElementById('ir-model-editing').value='gpt-image-2.5-flare';"
      + "var ok=await saveImageRouterSettingsUI();"
      + "var c=await dbGet('apiSettings','image_router');"
      + "return{ok:ok,routes:c&&c.routes,status:document.getElementById('ir-save-status').textContent}})()");
    check('save.persistedRoutes', saved && saved.ok === true && saved.routes && saved.routes.generation.apiConfigId === 'ir_main'
      && saved.routes.generation.model === 'gpt-image-2.5-sunburst' && saved.routes.editing.model === 'gpt-image-2.5-flare', JSON.stringify(saved));
    check('save.statusShown', saved && saved.status.indexOf('已保存') >= 0, JSON.stringify(saved && saved.status));
    check('save.survivesReload', await (async () => {
      const loaded = new Promise(resolve => { const off = cdp.on; off.call(cdp, 'Page.loadEventFired', () => resolve(true)); setTimeout(() => resolve(false), 20000); });
      await cdp.send('Page.reload', { ignoreCache: true });
      await loaded;
      const ok = await waitFor(cdp, "typeof dbGet==='function'&&window.IB&&IB.imageRouterSettings&&document.querySelectorAll('#image-router-section .ir-card').length===2");
      if (!ok) return false;
      return evaluate(cdp, "(async function(){var c=await dbGet('apiSettings','image_router');var g=document.getElementById('ir-model-generation');return !!(c&&c.routes.generation.model==='gpt-image-2.5-sunburst'&&g&&g.value==='gpt-image-2.5-sunburst')})()");
    })());

    /* ── ④ 真实链路：生成走 Generation 路由（角色自己没有图片 Key） ── */
    mock.hits.length = 0;
    const gen1 = await evaluate(cdp, "(async function(){var cfg=apiConfigs.find(function(a){return a.id==='ir_char'});var ops=_parseWsOps('<ws_gen_image prompt=\"测试生成\" size=\"1024x1024\"/>').ops;var rs=await _execWsOps(ops,'角色',cfg,{source:'chat',friendId:'ir_char'});var r=rs[0]||{};return{ok:r.ok===true,code:r.code||'',reason:r.reason||'',model:r.model,op:r.op}})()");
    check('chain.generationUsesRouteModel', gen1 && gen1.ok === true && gen1.model === 'gpt-image-2.5-sunburst', JSON.stringify(gen1));
    const h1 = (await stats()).hits[0] || {};
    check('chain.generationUsesBoundKey', h1.auth === 'Bearer sk-main-image' && h1.kind === 'gen' && h1.model === 'gpt-image-2.5-sunburst', JSON.stringify({ auth: h1.auth, model: h1.model }));

    /* ── ⑤ 编辑走 Editing 路由：不同模型 + multipart + 源图字节 ── */
    await evaluate(cdp, "(async function(){await dbPut('chatMessages',{id:'ir_a1',role:'assistant',content:'画好了',friendId:'ir_char',timestamp:Date.now()-1000,images:[{dataUrl:'data:image/png;base64," + TINY_PNG + "',base64:'" + TINY_PNG + "',mime:'image/png',name:'A.png',imageId:'img_A',generationType:'generate',editDepth:0}]});return true})()");
    mock.hits.length = 0;
    const ed1 = await evaluate(cdp, "(async function(){var cfg=apiConfigs.find(function(a){return a.id==='ir_char'});var ops=_parseWsOps('<ws_edit_image>把背景换成晚上</ws_edit_image>').ops;var rs=await _execWsOps(ops,'角色',cfg,{source:'chat',friendId:'ir_char'});var r=rs[0]||{};return{ok:r.ok===true,code:r.code||'',reason:r.reason||'',model:r.model,op:r.op}})()");
    check('chain.editingUsesEditingRouteModel', ed1 && ed1.ok === true && ed1.model === 'gpt-image-2.5-flare', JSON.stringify(ed1));
    const h2 = (await stats()).hits[0] || {};
    check('chain.editingWireMultipart', h2.kind === 'edit' && /multipart\/form-data/i.test(h2.contentType || '') && h2.partNames.indexOf('image') >= 0, JSON.stringify({ kind: h2.kind, ct: h2.contentType, parts: h2.partNames }));
    check('chain.editingUsesEditingRouteKey', h2.auth === 'Bearer sk-main-image' && h2.model === 'gpt-image-2.5-flare', JSON.stringify({ auth: h2.auth, model: h2.model }));
    check('chain.editingInputIsSourceImage', (h2.images || [])[0] === TINY_PNG, 'provider 收到的字节必须就是被编辑的那张图');

    /* ── ⑥ 改模型 → request body 同步改变 ── */
    mock.hits.length = 0;
    const changed = await evaluate(cdp, "(async function(){"
      + "document.getElementById('ir-model-generation').value='gpt-image-1';"
      + "await saveImageRouterSettingsUI();"
      + "var cfg=apiConfigs.find(function(a){return a.id==='ir_char'});"
      + "var ops=_parseWsOps('<ws_gen_image prompt=\"再生成一张\"/>').ops;"
      + "var rs=await _execWsOps(ops,'角色',cfg,{source:'chat',friendId:'ir_char'});"
      + "var r=rs[0]||{};return{ok:r.ok===true,model:r.model}})()");
    const h3 = (await stats()).hits[0] || {};
    check('chain.modelChangeReachesRequestBody', changed && changed.ok === true && changed.model === 'gpt-image-1' && h3.model === 'gpt-image-1', JSON.stringify({ ui: changed, body: h3.model }));

    /* ── ⑦ 缺 Key → 明确错误码 + 0 次请求 ── */
    mock.hits.length = 0;
    const nokey = await evaluate(cdp, "(async function(){"
      + "document.getElementById('ir-config-generation').value='ir_nokey';"
      + "await saveImageRouterSettingsUI();"
      + "var shown=document.getElementById('ir-state-generation').textContent;"
      + "var cfg=apiConfigs.find(function(a){return a.id==='ir_char'});"
      + "var ops=_parseWsOps('<ws_gen_image prompt=\"缺钥匙\"/>').ops;"
      + "var rs=await _execWsOps(ops,'角色',cfg,{source:'chat',friendId:'ir_char'});"
      + "var r=rs[0]||{};return{shown:shown,ok:r.ok===true,code:r.code||'',reason:r.reason||''}})()");
    check('error.noKeyCode', nokey && nokey.ok === false && nokey.code === 'IMAGE_ROUTER_NO_KEY', JSON.stringify(nokey));
    check('error.noKeyNoRequest', (await stats()).hits.length === 0);
    check('error.noKeyUserText', nokey && nokey.reason.indexOf('API Key') >= 0 && nokey.reason.indexOf('Image Router') >= 0, JSON.stringify(nokey && nokey.reason));
    check('error.uiShowsSameProblem', nokey && nokey.shown.indexOf('API Key') >= 0, JSON.stringify(nokey && nokey.shown));

    /* ── ⑦b 本地端点不填 Key：允许（local-first / 自建代理常态），请求照常发出 ── */
    mock.hits.length = 0;
    const localOk = await evaluate(cdp, "(async function(){"
      + "document.getElementById('ir-config-generation').value='ir_local';"
      + "document.getElementById('ir-model-generation').value='gpt-image-2.5-flare';"
      + "await saveImageRouterSettingsUI();"
      + "var shown=document.getElementById('ir-state-generation').textContent;"
      + "var cfg=apiConfigs.find(function(a){return a.id==='ir_char'});"
      + "var ops=_parseWsOps('<ws_gen_image>本地无钥匙</ws_gen_image>').ops;"
      + "var rs=await _execWsOps(ops,'角色',cfg,{source:'chat',friendId:'ir_char'});"
      + "var r=rs[0]||{};return{shown:shown,ok:r.ok===true,model:r.model,code:r.code||''}})()");
    const hLocal = (await stats()).hits[0] || {};
    check('localKeyless.allowed', localOk && localOk.ok === true && hLocal.model === 'gpt-image-2.5-flare' && hLocal.auth === 'Bearer', JSON.stringify({ localOk, auth: hLocal.auth }));
    check('localKeyless.uiHint', localOk && localOk.shown.indexOf('未填 API Key') >= 0, JSON.stringify(localOk && localOk.shown));

    /* ── ⑧ 绑定不存在的配置 → 明确错误码 + 0 次请求 ── */
    mock.hits.length = 0;
    const ghost = await evaluate(cdp, "(async function(){"
      + "var c=await dbGet('apiSettings','image_router');c.routes.generation.apiConfigId='ghost_cfg';await dbPut('apiSettings',c);IB.imageRouter.reloadConfig();"
      + "var cfg=apiConfigs.find(function(a){return a.id==='ir_char'});"
      + "var ops=_parseWsOps('<ws_gen_image prompt=\"幽灵配置\"/>').ops;"
      + "var rs=await _execWsOps(ops,'角色',cfg,{source:'chat',friendId:'ir_char'});"
      + "var r=rs[0]||{};return{ok:r.ok===true,code:r.code||'',reason:r.reason||''}})()");
    check('error.missingConfigCode', ghost && ghost.ok === false && ghost.code === 'IMAGE_ROUTER_CONFIG_MISSING', JSON.stringify(ghost));
    check('error.missingConfigNoRequest', (await stats()).hits.length === 0);

    /* ── ⑨ 路由关闭 → 明确错误码 + 0 次请求 ── */
    mock.hits.length = 0;
    const off = await evaluate(cdp, "(async function(){"
      + "document.getElementById('ir-config-generation').value='ir_main';"
      + "document.getElementById('ir-enabled-generation').checked=false;"
      + "await saveImageRouterSettingsUI();"
      + "var cfg=apiConfigs.find(function(a){return a.id==='ir_char'});"
      + "var ops=_parseWsOps('<ws_gen_image prompt=\"关闭时\"/>').ops;"
      + "var rs=await _execWsOps(ops,'角色',cfg,{source:'chat',friendId:'ir_char'});"
      + "var r=rs[0]||{};return{ok:r.ok===true,code:r.code||'',reason:r.reason||''}})()");
    check('error.disabledCode', off && off.ok === false && off.code === 'IMAGE_ROUTER_DISABLED', JSON.stringify(off));
    check('error.disabledNoRequest', (await stats()).hits.length === 0);

    /* ── ⑩ 备用通道：主模型 500 → 重试一次备用配置 ── */
    mock.hits.length = 0;
    await setFailModels(['gpt-image-2.5-sunburst']);
    const fb = await evaluate(cdp, "(async function(){"
      + "document.getElementById('ir-enabled-generation').checked=true;"
      + "document.getElementById('ir-config-generation').value='ir_main';"
      + "document.getElementById('ir-model-generation').value='gpt-image-2.5-sunburst';"
      + "document.getElementById('ir-fbconfig-generation').value='ir_backup';"
      + "document.getElementById('ir-fbmodel-generation').value='gpt-image-1';"
      + "await saveImageRouterSettingsUI();"
      + "var cfg=apiConfigs.find(function(a){return a.id==='ir_char'});"
      + "var ops=_parseWsOps('<ws_gen_image prompt=\"备用通道\"/>').ops;"
      + "var rs=await _execWsOps(ops,'角色',cfg,{source:'chat',friendId:'ir_char'});"
      + "var r=rs[0]||{};"
      + "var tel=IB.imageRouter.telemetry().slice(-1)[0]||{};"
      + "return{ok:r.ok===true,model:r.model,fallbackUsed:!!r.fallbackUsed,tel:{apiConfigId:tel.apiConfigId,routeName:tel.routeName,modelSource:tel.modelSource,fallbackUsed:tel.fallbackUsed,policy:tel.policy},raw:JSON.stringify(tel)}})()");
    const hits = (await stats()).hits;
    check('fallback.retriedWithBackupConfig', fb && fb.ok === true && hits.length === 2 && hits[1].auth === 'Bearer sk-backup-image' && hits[1].model === 'gpt-image-1', JSON.stringify({ fb, hits: hits.map(h => ({ m: h.model, a: h.auth })) }));
    check('fallback.reportedInResult', fb && fb.fallbackUsed === true && fb.tel.fallbackUsed === true && fb.tel.apiConfigId === 'ir_main' && fb.tel.routeName === 'generation' && fb.tel.policy === 'route_model', JSON.stringify(fb && fb.tel));
    check('telemetry.noSecrets', fb && fb.raw.indexOf('sk-main-image') < 0 && fb.raw.indexOf('sk-backup-image') < 0 && fb.raw.indexOf('base64') < 0, fb && fb.raw);
    await setFailModels([]);

    /* ── ⑪ 页面无异常 ── */
    check('page.noExceptions', exceptions.length === 0, exceptions.slice(0, 2).join(' | '));
  } catch (error) {
    failures++;
    console.error('  FAIL  smoke.threw  -> ' + (error && error.stack || error));
  } finally {
    if (cdp) cdp.close();
    try { browser.kill(); } catch (error) {}
    try { mock.server.close(); } catch (error) {}
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (error) {}
  }
  console.log('');
  if (failures) { console.error('FAILED: ' + failures); process.exit(1); }
  console.log('Image Router settings smoke passed ✔');
})();
