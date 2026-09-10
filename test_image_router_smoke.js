'use strict';

/* Internal Beyond · Image Router 浏览器最小冒烟（Node 18+，零依赖，需 Chrome / Edge）
   --------------------------------------------------------------------
   只验证"真实链路"三件事（其余由 test_image_router.js 纯 Node 专项覆盖）：
     1. Chat gen_image 真的经 Image Router → 现有 _wsExecImageGen → provider，
        且下发的模型是 gpt-image-2.5-flare（Auto 默认）；
     2. Middle Brain 高级设置里的 Fast ─ Auto ─ Precision 卡片能改策略，
        Precision 后同一条链路下发 gpt-image-2.5-sunburst；
     3. 并发保护在真实执行器上生效：global ≤ 2、Sunburst ≤ 1；
        并检查 telemetry 不含 API Key。
   运行：node test_image_router_smoke.js
   ==================================================================== */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');
const crypto = require('crypto');
const { pathToFileURL } = require('url');

const PAGE_URL = pathToFileURL(path.join(__dirname, 'InternalBeyond.html')).href;
const TINY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/AF/oS8AAAAASUVORK5CYII=';

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
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('CDP timeout: ' + method)); } }, 20000);
    });
  }
  sendText(message) {
    const payload = Buffer.from(JSON.stringify(message)); const mask = crypto.randomBytes(4);
    const body = Buffer.alloc(payload.length); for (let i = 0; i < payload.length; i++) body[i] = payload[i] ^ mask[i & 3];
    let header;
    if (payload.length < 126) header = Buffer.from([0x81, 0x80 | payload.length]);
    else { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 0x80 | 126; header.writeUInt16BE(payload.length, 2); }
    this.socket.write(Buffer.concat([header, mask, body]));
  }
  sendFrame(opcode, payload) {
    const mask = crypto.randomBytes(4); const body = Buffer.alloc(payload.length);
    for (let i = 0; i < payload.length; i++) body[i] = payload[i] ^ mask[i & 3];
    const header = payload.length < 126 ? Buffer.from([0x80 | opcode, 0x80 | payload.length]) : Buffer.alloc(4);
    if (payload.length >= 126) { header[0] = 0x80 | opcode; header[1] = 0x80 | 126; header.writeUInt16BE(payload.length, 2); }
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
      let payload = this.buffer.subarray(off, off + len); this.buffer = this.buffer.subarray(off + len);
      if (mask) { const out = Buffer.alloc(len); for (let i = 0; i < len; i++) out[i] = payload[i] ^ mask[i & 3]; payload = out; }
      const opcode = first & 0x0f;
      if (opcode === 0x8) return this.close();
      if (opcode === 0x9) { this.sendFrame(0xA, payload); continue; }
      if (opcode !== 0x1) continue;
      let msg; try { msg = JSON.parse(payload.toString()); } catch (error) { continue; }
      if (msg.id && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id); this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(JSON.stringify(msg.error))); else p.resolve(msg.result || {});
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
async function waitFor(cdp, expression, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { try { if (await evaluate(cdp, expression)) return true; } catch (error) {} await new Promise(r => setTimeout(r, 120)); }
  return false;
}
function freePort() {
  return new Promise((resolve, reject) => { const s = net.createServer(); s.unref(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(e => e ? reject(e) : resolve(p)); }); });
}
/* 生图 mock：统计并发峰值 + 记录 (model, prompt, auth)；可配置单次延迟 */
function startMockApi(delayMs) {
  const hits = [];
  let inFlight = 0, maxInFlight = 0, flare = 0, sun = 0, maxFlare = 0, maxSun = 0;
  const server = http.createServer((req, res) => {
    const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-API-Key' };
    if (req.method === 'OPTIONS') { res.writeHead(204, headers); res.end(); return; }
    if (req.method === 'GET' && /\/stats/.test(req.url || '')) {
      res.writeHead(200, headers);
      res.end(JSON.stringify({ hits, maxInFlight, maxFlare, maxSun, inFlight }));
      return;
    }
    if (req.method === 'POST' && /images\/generations/i.test(req.url || '')) {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        let model = '', prompt = '';
        try { const j = JSON.parse(body || '{}'); model = String(j.model || ''); prompt = String(j.prompt || ''); } catch (error) { /* ignore */ }
        hits.push({ model, prompt, auth: String(req.headers.authorization || '') });
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        if (/sunburst/.test(model)) { sun++; maxSun = Math.max(maxSun, sun); } else { flare++; maxFlare = Math.max(maxFlare, flare); }
        setTimeout(() => {
          inFlight--; if (/sunburst/.test(model)) sun--; else flare--;
          res.writeHead(200, headers);
          res.end(JSON.stringify({ data: [{ b64_json: TINY_PNG }], usage: { prompt_tokens: 1, output_tokens: 1 } }));
        }, delayMs);
      });
      return;
    }
    res.writeHead(404, headers); res.end('{}');
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, hits })));
}

(async () => {
  const chrome = chromePath();
  let failures = 0;
  const check = (name, ok, detail = '') => { if (ok) console.log('  PASS  ' + name); else { failures++; console.error('  FAIL  ' + name + (detail ? '  -> ' + detail : '')); } };
  if (!chrome) { console.error('  FAIL  browser.notFound  -> 未找到 Chrome/Edge'); process.exit(1); }
  const mock = await startMockApi(180);
  const EP = 'http://127.0.0.1:' + mock.port + '/v1/chat/completions';
  const IMG_EP = 'http://127.0.0.1:' + mock.port + '/v1';
  const port = await freePort();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-img-router-'));
  const browser = spawn(chrome, ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    '--allow-file-access-from-files', '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=' + port, '--user-data-dir=' + profile, 'about:blank'], { stdio: 'ignore' });
  let cdp = null;
  const consoleErrors = [];
  try {
    let ready = false;
    for (let i = 0; i < 120; i++) { try { if ((await fetch('http://127.0.0.1:' + port + '/json/version')).ok) { ready = true; break; } } catch (error) {} await new Promise(r => setTimeout(r, 100)); }
    check('browser.ready', ready);
    if (!ready) throw new Error('CDP 未就绪');
    const tab = await (await fetch('http://127.0.0.1:' + port + '/json/new?' + encodeURIComponent(PAGE_URL), { method: 'PUT' })).json();
    cdp = await Cdp.connect(tab.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable');
    const exceptions = [];
    cdp.on('Runtime.exceptionThrown', p => exceptions.push(JSON.stringify(p.exceptionDetails || {})));
    cdp.on('Runtime.consoleAPICalled', p => { if (p.type === 'error') consoleErrors.push(JSON.stringify(p.args || []).slice(0, 200)); });
    check('page.routerLoaded', await waitFor(cdp, "window.IBImageRouterCore&&window.IB&&IB.imageRouter&&IB.imageRouter.available===true&&typeof _wsExecImageGen==='function'"));
    check('page.executorIsExistingOne', await evaluate(cdp, "IB.imageRouter.IMAGE_MODELS.flare==='gpt-image-2.5-flare'&&IB.imageRouter.IMAGE_MODELS.sunburst==='gpt-image-2.5-sunburst'"));

    /* 种子角色：gpt-image 家族模型 → 双模型策略管辖 */
    await evaluate(cdp, "(async function(){await dbPut('apiConfigs',{id:'ir1',provider:'openai',model:'ir-text',endpoint:'" + EP + "',apiKey:'sk-text',nickname:'昔涟',systemPrompt:'你是测试角色',imageGen:true,imageGenModel:'gpt-image-1',imageGenEndpoint:'" + IMG_EP + "',imageGenApiKey:'sk-image-secret'});await loadApiConfigs();return true})()");

    /* ① UI：Fast ─ Auto ─ Precision 卡片存在、默认 Auto */
    const ui = await evaluate(cdp, "(function(){var host=document.getElementById('mb-adv-image');var ticks=host?host.querySelectorAll('.mb-tick'):[];var labels=host?Array.from(host.querySelectorAll('.mb-lbl')).map(function(x){return x.textContent}):[];var sum=document.getElementById('mb-image-summary');var hint=document.getElementById('mb-adv-image-hint');return{ticks:ticks.length,labels:labels,summary:sum?sum.textContent:'',hint:hint?hint.textContent:'',mode:(IB.middleBrain&&IB.middleBrain.middleBrainImageMode)?'has':'no'}})()");
    check('ui.imageCard', ui.ticks === 3 && ui.labels.join('/') === 'Fast/Auto/Precision', JSON.stringify(ui));
    check('ui.defaultAuto', ui.summary === 'Auto' && ui.hint === 'Let Middle Brain choose', JSON.stringify(ui));

    /* ② Chat gen_image → Router → 现有执行器 → provider（Auto → Flare） */
    const chat = await evaluate(cdp, "(async function(){var cfg=apiConfigs.find(function(a){return a.id==='ir1'});var ops=_parseWsOps('<ws_gen_image prompt=\"一只坐在窗边的猫\" size=\"1024x1024\"/>').ops;var rs=await _execWsOps(ops,'昔涟',cfg);var r=rs[0]||{};var resp=await _processWsResponse('<ws_gen_image prompt=\"另一只猫\"/>','昔涟',cfg);return{ok:r.ok===true,model:r.model,cards:(resp.cards||[]).length,cardLabel:resp.cards&&resp.cards[0]?String(resp.cards[0].textContent||'').slice(0,24):''}})()");
    check('chain.chatGenImageFlare', chat && chat.ok === true && chat.model === 'gpt-image-2.5-flare' && chat.cards === 1, JSON.stringify(chat));
    const stats1 = await (await fetch('http://127.0.0.1:' + mock.port + '/stats')).json();
    check('chain.providerSawFlare', stats1.hits.some(h => h.model === 'gpt-image-2.5-flare' && h.prompt.indexOf('窗边') >= 0), JSON.stringify(stats1.hits));
    check('chain.imageKeyForwarded', stats1.hits[0] && stats1.hits[0].auth === 'Bearer sk-image-secret', JSON.stringify(stats1.hits[0] || {}));

    /* ③ Moments 后台 → 同一 Router；优先级 P3 + 来源 ai_moments */
    const bg = await evaluate(cdp, "(async function(){IB.imageRouter.reset();var ev={id:'event_ir_bg',kind:'moment',moment:{id:'mom_ir_bg',roleId:'ir1',content:'楼下的猫又来了。',images:[],visibility:'all',visibleRoleIds:[],likes:[],comments:[],source:'proactive',createdAt:new Date().toISOString()},next_at:Date.now()+3600000,last_post_at:Date.now(),sent_at:Date.now(),want_image:true,image_prompt:'A cat by the window, casual photo'};var ok=await _momentsIngestEvent(ev,_activeUserId());var m=await getMoment('mom_ir_bg');var tel=IB.imageRouter.telemetry();return{ok:ok,images:m&&m.images.length,tel:tel}})()");
    check('chain.momentsBackgroundImage', bg && bg.ok === true && bg.images === 1, JSON.stringify(bg));
    const tel = (bg && bg.tel) || [];
    check('chain.telemetryPriorityP3', tel.some(t => t.source === 'ai_moments' && t.priorityName === 'P3' && t.selectedModel === 'gpt-image-2.5-flare'), JSON.stringify(tel));
    check('chain.telemetryNoSecrets', JSON.stringify(tel).indexOf('sk-image-secret') < 0 && JSON.stringify(tel).indexOf('base64') < 0, JSON.stringify(tel));

    /* ④ UI 切到 Precision → 同一条链路下发 Sunburst（用户显式选择，永不降级） */
    await evaluate(cdp, "(function(){var host=document.getElementById('mb-adv-image');var ticks=host.querySelectorAll('.mb-tick');ticks[2].dispatchEvent(new MouseEvent('click',{bubbles:true}));return true})()");
    check('ui.precisionPersisted', await waitFor(cdp, "(async function(){var c=await IB.middleBrain.getMiddleBrainConfig();return c.imageMode==='precision'})()"));
    const prec = await evaluate(cdp, "(async function(){var cfg=apiConfigs.find(function(a){return a.id==='ir1'});var ops=_parseWsOps('<ws_gen_image prompt=\"随便画一只猫\"/>').ops;var rs=await _execWsOps(ops,'昔涟',cfg);var r=rs[0]||{};return{ok:r.ok===true,model:r.model}})()");
    check('chain.precisionOverrideSunburst', prec && prec.ok === true && prec.model === 'gpt-image-2.5-sunburst', JSON.stringify(prec));

    /* ⑤ 并发保护：3 个用户生成同时排队 → global ≤ 2；2 个精修 → Sunburst ≤ 1 */
    const conc = await evaluate(cdp, "(async function(){var cfg=apiConfigs.find(function(a){return a.id==='ir1'});IB.imageRouter.reset();var base={source:'chat',cfg:cfg,prompt:'并发测试图',size:'1024x1024',userInitiated:true};var rs=await Promise.all([IB.imageRouter.routeImageRequest(Object.assign({},base,{characterId:'c1'})),IB.imageRouter.routeImageRequest(Object.assign({},base,{characterId:'c2'})),IB.imageRouter.routeImageRequest(Object.assign({},base,{characterId:'c3'}))]);return rs.map(function(r){return r&&r.ok})})()");
    check('concurrency.realExecutorGlobal2', conc && conc.every(Boolean), JSON.stringify(conc));
    const stats2 = await (await fetch('http://127.0.0.1:' + mock.port + '/stats')).json();
    check('concurrency.maxInFlight2', stats2.maxInFlight <= 2, 'maxInFlight=' + stats2.maxInFlight);
    check('concurrency.maxSunburst1', stats2.maxSun <= 1, 'maxSun=' + stats2.maxSun);

    check('page.noExceptions', exceptions.length === 0, exceptions.slice(0, 3).join(' | '));
    check('page.noConsoleErrors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
  } catch (error) {
    failures++;
    console.error('  FAIL  harness.error  -> ' + String(error && error.message || error));
  } finally {
    if (cdp) cdp.close();
    try { browser.kill(); } catch (error) { /* ignore */ }
    try { mock.server.close(); } catch (error) { /* ignore */ }
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (error) { /* ignore */ }
  }
  console.log(failures === 0 ? '\nImage Router browser smoke passed ✔' : '\nImage Router browser smoke FAILED ✘');
  process.exit(failures ? 1 : 0);
})();
