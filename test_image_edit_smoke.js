'use strict';

/* Internal Beyond · Image Editing Runtime 浏览器冒烟（Node 18+，零依赖，需 Chrome / Edge）
   --------------------------------------------------------------------
   真实链路验证（其余纯逻辑见 test_image_edit.js）：
     ① Chat <ws_gen_image> → Flare → image A（aiMsg.images + lineage）
     ② <ws_edit_image> → Reference Resolver 解析 A → Router → Sunburst
        → 真实 multipart /v1/images/edits → image B（parentImageId=A, editDepth=1）
     ③ 再 <ws_edit_image> → 必须解析 B（不是 A）：校验 provider 收到的就是 B 的字节
     ④ 页面重载后仍能解析到 B/C（IndexedDB 持久化）
     ⑤ capability guard：不支持编辑的模型 → IMAGE_EDIT_UNSUPPORTED 且 0 次 provider 请求
     ⑥ 无图 → IMAGE_EDIT_NO_SOURCE 且 0 次 provider 请求
     ⑦ 显式选中图片 > 最近一张；选中态在附件栏显示，可取消
     ⑧ 参考图数量/体积限额（含复用 moments 压缩 helper 的缩放路径）
     ⑨ edit 仍受 Scheduler 约束：global ≤ 2、Sunburst ≤ 1
     ⑩ telemetry 含 operation/referenceCount/editDepth，且不含 base64 / API Key
   运行：node test_image_edit_smoke.js
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
/* 每次返回内容不同、但都是**合法 base64** 的图片：PNG 字节 + 标记字节后重新编码
   （直接拼接两个 base64 字符串会产生非法 padding，atob 会抛错——这正是 provider 侧的真实约束） */
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
/* multipart/form-data 解析（只取字段名 + 原始字节，用于证明 edit wire format） */
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
      const fileM = /filename="([^"]*)"/i.exec(headers);
      out.push({ name: nameM ? nameM[1] : '', filename: fileM ? fileM[1] : '', body: seg.subarray(headerEnd + 4) });
    }
    idx = next;
  }
  return out;
}
/* mock provider：generations(JSON) + edits(multipart)，统计并发峰值与收到的字段 */
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
    const isEdit = req.method === 'POST' && /images\/edits/i.test(req.url || '');
    const isGen = req.method === 'POST' && /images\/generations/i.test(req.url || '');
    if (!isEdit && !isGen) { res.writeHead(404, headers); res.end('{}'); return; }
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      let model = '', prompt = '', quality = '', size = '', images = [], partNames = [];
      if (isEdit) {
        const parts = parseMultipart(raw, req.headers['content-type']) || [];
        partNames = parts.map(p => p.name);
        parts.forEach(p => {
          if (p.name === 'image' || p.name === 'image[]') images.push(p.body.toString('base64'));
          else if (p.name === 'model') model = p.body.toString('utf8');
          else if (p.name === 'prompt') prompt = p.body.toString('utf8');
          else if (p.name === 'quality') quality = p.body.toString('utf8');
          else if (p.name === 'size') size = p.body.toString('utf8');
        });
      } else {
        try { const j = JSON.parse(raw.toString('utf8') || '{}'); model = String(j.model || ''); prompt = String(j.prompt || ''); quality = String(j.quality || ''); size = String(j.size || ''); } catch (error) { /* ignore */ }
      }
      const n = hits.length + 1;
      hits.push({ kind: isEdit ? 'edit' : 'gen', model, prompt, quality, size, images, partNames, contentType: String(req.headers['content-type'] || ''), auth: String(req.headers.authorization || '') });
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      if (/sunburst/.test(model)) { sun++; maxSun = Math.max(maxSun, sun); } else { flare++; maxFlare = Math.max(maxFlare, flare); }
      setTimeout(() => {
        inFlight--; if (/sunburst/.test(model)) sun--; else flare--;
        res.writeHead(200, headers);
        res.end(JSON.stringify({ data: [{ b64_json: payload((isEdit ? 'EDT' : 'GEN') + n) }], usage: { prompt_tokens: 1, output_tokens: 1 } }));
      }, delayMs);
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, hits })));
}

(async () => {
  const chrome = chromePath();
  let failures = 0;
  const check = (name, ok, detail = '') => { if (ok) console.log('  PASS  ' + name); else { failures++; console.error('  FAIL  ' + name + (detail ? '  -> ' + detail : '')); } };
  if (!chrome) { console.error('  FAIL  browser.notFound  -> 未找到 Chrome/Edge'); process.exit(1); }
  const mock = await startMockApi(120);
  const EP = 'http://127.0.0.1:' + mock.port + '/v1/chat/completions';
  const IMG_EP = 'http://127.0.0.1:' + mock.port + '/v1';
  const stats = async () => (await (await fetch('http://127.0.0.1:' + mock.port + '/stats')).json());
  const port = await freePort();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-img-edit-'));
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
    await cdp.send('Page.enable');
    const exceptions = [];
    cdp.on('Runtime.exceptionThrown', p => exceptions.push(JSON.stringify(p.exceptionDetails || {})));
    cdp.on('Runtime.consoleAPICalled', p => { if (p.type === 'error') consoleErrors.push(JSON.stringify(p.args || []).slice(0, 200)); });

    check('page.modulesLoaded', await waitFor(cdp, "window.IBImageEditCore&&window.IB&&IB.imageEdit&&IB.imageEdit.available===true&&IB.imageRouter&&IB.imageRouter.available===true&&typeof _wsExecImageGen==='function'&&typeof _wsExecImageEdit==='function'"));
    check('page.streamTagOrder', await evaluate(cdp, "IB.workspace._WS_STREAM_STARTS.indexOf('<ws_edit_image')>=0&&IB.workspace._WS_STREAM_STARTS.indexOf('<ws_edit_image')<IB.workspace._WS_STREAM_STARTS.indexOf('<ws_edit')"));

    /* ── 解析层：<ws_edit_image> 不影响既有 <ws_edit> ── */
    const parse = await evaluate(cdp, "(function(){var a=_parseWsOps('<ws_edit_image>把她的头发改长一点</ws_edit_image>').ops[0]||{};var b=_parseWsOps('<ws_edit_image path=\"改图.png\">背景换成晚上</ws_edit_image>').ops[0]||{};var c=_parseWsOps('<ws_edit_image prompt=\"只改衣服\"/>').ops[0]||{};var d=_parseWsOps('<ws_edit_image>没闭合').ops[0]||{};var e=_parseWsOps('<ws_edit path=\"a.txt\"><find>x</find><replace>y</replace></ws_edit>').ops[0]||{};return{aType:a.type,aPrompt:a.prompt,bPath:b.path,bPrompt:b.prompt,cPrompt:c.prompt,dTrunc:!!d.truncated,eType:e.type,eFind:e.find,eReplace:e.replace}})()");
    check('parse.editImageBody', parse && parse.aType === 'edit_image' && parse.aPrompt === '把她的头发改长一点', JSON.stringify(parse));
    check('parse.editImagePath', parse && parse.bPath === '改图.png' && parse.bPrompt === '背景换成晚上', JSON.stringify(parse));
    check('parse.editImageAttr', parse && parse.cPrompt === '只改衣服', JSON.stringify(parse));
    check('parse.editImageTruncated', parse && parse.dTrunc === true, JSON.stringify(parse));
    check('parse.existingEditUnbroken', parse && parse.eType === 'edit' && parse.eFind === 'x' && parse.eReplace === 'y', JSON.stringify(parse));
    const card = await evaluate(cdp, "(function(){var c=_buildWsOpCard({type:'gen_image',op:'edit',ok:true,dataUrl:'data:image/png;base64," + TINY_PNG + "',prompt:'把头发改长',model:'gpt-image-2.5-sunburst',path:'AI改图_1.png'});return{text:String(c.textContent||'')}})()");
    check('parse.cardLabelEdited', card && card.text.indexOf('已编辑图像') >= 0, JSON.stringify(card));

    /* 种子角色：gpt-image 家族 → 双模型策略管辖 */
    await evaluate(cdp, "(async function(){await dbPut('apiConfigs',{id:'ed1',provider:'openai',model:'ed-text',endpoint:'" + EP + "',apiKey:'sk-text',nickname:'昔涟',systemPrompt:'你是测试角色',imageGen:true,imageGenModel:'gpt-image-1',imageGenEndpoint:'" + IMG_EP + "',imageGenApiKey:'sk-image-secret'});await dbPut('apiConfigs',{id:'ed3',provider:'openai',model:'ed-text',endpoint:'" + EP + "',apiKey:'sk-text',nickname:'缇宝',systemPrompt:'x',imageGen:true,imageGenModel:'dall-e-3',imageGenEndpoint:'" + IMG_EP + "',imageGenApiKey:'sk-image-secret'});await loadApiConfigs();return true})()");

    /* ── ① 生成 A（Flare） ── */
    const gen = await evaluate(cdp, "(async function(){var cfg=apiConfigs.find(function(a){return a.id==='ed1'});var conv='ed1';var t=Date.now();await dbPut('chatMessages',{id:'u1',role:'user',content:'画昔涟坐在窗边',friendId:conv,timestamp:t});var ops=_parseWsOps('<ws_gen_image prompt=\"昔涟坐在窗边\" size=\"1024x1024\"/>').ops;var rs=await _execWsOps(ops,'昔涟',cfg,{source:'chat',friendId:conv});var r=rs[0]||{};var imgs=_wsCollectGenImages(rs);var aiMsg={id:'a1',role:'assistant',content:'画好了',friendId:conv,timestamp:t+1};if(imgs.length)aiMsg.images=imgs;await dbPut('chatMessages',aiMsg);return{ok:r.ok===true,model:r.model,op:r.op,imgId:imgs[0]&&imgs[0].imageId,depth:imgs[0]&&imgs[0].editDepth,gen:imgs[0]&&imgs[0].generationType,base64:imgs[0]&&imgs[0].base64}})()");
    check('chain.generateA', gen && gen.ok === true && gen.model === 'gpt-image-2.5-flare' && gen.op === 'generate', JSON.stringify(gen && { ok: gen.ok, model: gen.model, op: gen.op }));
    check('chain.lineageRootA', gen && gen.depth === 0 && gen.gen === 'generate' && /^img_/.test(gen.imgId || ''), JSON.stringify(gen && { depth: gen.depth, gen: gen.gen, imgId: gen.imgId }));
    const s1 = await stats();
    check('chain.providerSawGenerate', s1.hits.length === 1 && s1.hits[0].kind === 'gen' && s1.hits[0].model === 'gpt-image-2.5-flare', JSON.stringify(s1.hits));
    check('chain.generateImageKeyForwarded', s1.hits[0] && s1.hits[0].auth === 'Bearer sk-image-secret');

    /* ── ② 编辑 A → B（Sunburst + 真实 multipart /images/edits） ── */
    const ed = await evaluate(cdp, "(async function(){var cfg=apiConfigs.find(function(a){return a.id==='ed1'});var conv='ed1';var t=Date.now();await dbPut('chatMessages',{id:'u2',role:'user',content:'就这张，把头发改长一点',friendId:conv,timestamp:t});var ops=_parseWsOps('<ws_edit_image>把她的头发改长一点，其他地方保持不变</ws_edit_image>').ops;var rs=await _execWsOps(ops,'昔涟',cfg,{source:'chat',friendId:conv});var r=rs[0]||{};var imgs=_wsCollectGenImages(rs);var aiMsg={id:'a2',role:'assistant',content:'改好了',friendId:conv,timestamp:t+1};if(imgs.length)aiMsg.images=imgs;await dbPut('chatMessages',aiMsg);return{ok:r.ok===true,code:r.code||'',reason:r.reason||'',model:r.model,op:r.op,imgId:imgs[0]&&imgs[0].imageId,parent:imgs[0]&&imgs[0].parentImageId,depth:imgs[0]&&imgs[0].editDepth,gen:imgs[0]&&imgs[0].generationType,base64:imgs[0]&&imgs[0].base64,path:r.path||''}})()");
    check('chain.editB', ed && ed.ok === true && ed.op === 'edit' && ed.model === 'gpt-image-2.5-sunburst', JSON.stringify(ed && { ok: ed.ok, model: ed.model, op: ed.op, code: ed.code, reason: ed.reason }));
    check('chain.lineageB', ed && ed.depth === 1 && ed.gen === 'edit' && ed.parent === gen.imgId, JSON.stringify(ed && { depth: ed.depth, gen: ed.gen, parent: ed.parent }));
    check('chain.bArchivedToICode', ed && /^AI改图_/.test(ed.path || ''), JSON.stringify(ed && ed.path));
    const s2 = await stats();
    const hit2 = s2.hits[1] || {};
    check('wire.editEndpointMultipart', hit2.kind === 'edit' && /multipart\/form-data/i.test(hit2.contentType || ''), JSON.stringify(hit2.contentType));
    check('wire.editFields', hit2.model === 'gpt-image-2.5-sunburst' && hit2.prompt === '把她的头发改长一点，其他地方保持不变' && hit2.quality === 'high', JSON.stringify({ model: hit2.model, prompt: hit2.prompt, quality: hit2.quality }));
    check('wire.editImageFieldName', hit2.partNames && hit2.partNames.indexOf('image') >= 0, JSON.stringify(hit2.partNames));
    check('wire.editCarriedSourceA', hit2.images && hit2.images[0] === gen.base64, 'provider 收到的输入图必须是 A');

    /* ── ③ 再编辑 → 必须改 B（不是 A） ── */
    const ed2 = await evaluate(cdp, "(async function(){var cfg=apiConfigs.find(function(a){return a.id==='ed1'});var conv='ed1';var t=Date.now();await dbPut('chatMessages',{id:'u3',role:'user',content:'很好，再把窗外改成下雪',friendId:conv,timestamp:t});var ops=_parseWsOps('<ws_edit_image>再把窗外改成下雪</ws_edit_image>').ops;var rs=await _execWsOps(ops,'昔涟',cfg,{source:'chat',friendId:conv});var r=rs[0]||{};var imgs=_wsCollectGenImages(rs);var aiMsg={id:'a3',role:'assistant',content:'改好了',friendId:conv,timestamp:t+1};if(imgs.length)aiMsg.images=imgs;await dbPut('chatMessages',aiMsg);return{ok:r.ok===true,model:r.model,imgId:imgs[0]&&imgs[0].imageId,parent:imgs[0]&&imgs[0].parentImageId,depth:imgs[0]&&imgs[0].editDepth,base64:imgs[0]&&imgs[0].base64}})()");
    check('chain.editC', ed2 && ed2.ok === true && ed2.depth === 2 && ed2.parent === ed.imgId, JSON.stringify(ed2 && { ok: ed2.ok, depth: ed2.depth, parent: ed2.parent }));
    const s3 = await stats();
    const hit3 = s3.hits[2] || {};
    check('multiturn.thirdInputIsB', hit3.images && hit3.images[0] === ed.base64, '第三步必须以上一张结果 B 为输入');
    check('multiturn.thirdInputNotA', hit3.images && hit3.images[0] !== gen.base64);
    check('multiturn.chainA_B_C', gen.imgId !== ed.imgId && ed.imgId !== ed2.imgId && ed2.parent === ed.imgId && ed.parent === gen.imgId);

    /* ── ④ telemetry ── */
    const tel = await evaluate(cdp, "(function(){return IB.imageRouter.telemetry()})()");
    const editTel = (tel || []).filter(t => t.operation === 'edit');
    check('telemetry.editRecorded', editTel.length >= 2 && editTel.some(t => t.editDepth === 0) && editTel.some(t => t.editDepth === 1) && editTel.every(t => t.referenceCount === 0), JSON.stringify(editTel.map(t => ({ op: t.operation, depth: t.editDepth, refs: t.referenceCount, model: t.modelKind, reason: t.routeReason }))));
    check('telemetry.noSecretsOrImageData', JSON.stringify(tel).indexOf('sk-image-secret') < 0 && JSON.stringify(tel).indexOf('base64') < 0 && JSON.stringify(tel).indexOf(TINY_PNG.slice(0, 24)) < 0, 'telemetry 不得含 API Key / 图片数据');

    /* ── ⑤ 页面重载后仍能解析到最近一张可编辑图（C） ── */
    await cdp.send('Page.navigate', { url: PAGE_URL });
    check('reload.booted', await waitFor(cdp, "typeof apiConfigs!=='undefined'&&apiConfigs.length>0&&window.IB&&IB.imageEdit&&IB.imageEdit.available===true", 30000));
    const afterReload = await evaluate(cdp, "(async function(){var cfg=apiConfigs.find(function(a){return a.id==='ed1'});var r=await IB.imageEdit.resolveEditableImage({conversationId:'ed1'});return{ok:r.ok===true,imgId:r.image&&r.image.imageId,kind:r.sourceKind,depth:r.image&&r.image.editDepth}})()");
    check('reload.resolvesLatestC', afterReload && afterReload.ok === true && afterReload.imgId === ed2.imgId && afterReload.depth === 2, JSON.stringify(afterReload));
    const before = (await stats()).hits.length;
    const edAfterReload = await evaluate(cdp, "(async function(){var cfg=apiConfigs.find(function(a){return a.id==='ed1'});var ops=_parseWsOps('<ws_edit_image>继续改刚才那张，加一点暖光</ws_edit_image>').ops;var rs=await _execWsOps(ops,'昔涟',cfg,{source:'chat',friendId:'ed1'});var r=rs[0]||{};return{ok:r.ok===true,base64:r.base64||'',model:r.model}})()");
    const s4 = await stats();
    check('reload.editUsesPersistedImage', edAfterReload && edAfterReload.ok === true && s4.hits[before] && s4.hits[before].images[0] === ed2.base64, JSON.stringify({ ok: edAfterReload && edAfterReload.ok, got: s4.hits[before] && String(s4.hits[before].images[0]).slice(0, 20), want: String(ed2.base64).slice(0, 20) }));

    /* ── ⑥ capability guard：不支持编辑的模型 → 0 次 provider 请求，且不偷偷改成生成 ── */
    const n0 = (await stats()).hits.length;
    const unsup = await evaluate(cdp, "(async function(){var cfg=apiConfigs.find(function(a){return a.id==='ed3'});var t=Date.now();await dbPut('chatMessages',{id:'u9',role:'user',content:'x',friendId:'ed3',timestamp:t});await dbPut('chatMessages',{id:'a9',role:'assistant',content:'y',friendId:'ed3',timestamp:t+1,images:[{dataUrl:'data:image/png;base64," + TINY_PNG + "',base64:'" + TINY_PNG + "',mime:'image/png',name:'a.png'}]});var ops=_parseWsOps('<ws_edit_image>把背景换成晚上</ws_edit_image>').ops;var rs=await _execWsOps(ops,'缇宝',cfg,{source:'chat',friendId:'ed3'});var r=rs[0]||{};return{ok:r.ok,code:r.code||'',reason:r.reason||''}})()");
    check('guard.unsupportedEdit', unsup && unsup.ok === false && unsup.code === 'IMAGE_EDIT_UNSUPPORTED', JSON.stringify(unsup));
    check('guard.userTextShort', unsup && unsup.reason === '当前图片模型不支持编辑这张图片', JSON.stringify(unsup));
    check('guard.zeroProviderRequests', (await stats()).hits.length === n0, '不支持编辑时不得发出任何 provider 请求');
    const capFn = await evaluate(cdp, "(function(){return{unsup:_imgEditCapability({provider:'openai',imageGenModel:'dall-e-3'}).wire||'',gem:_imgEditCapability({provider:'gemini',imageGenModel:'gemini-2.5-flash-image'}).wire||'',gpt:_imgEditCapability({provider:'openai',imageGenModel:'gpt-image-2.5-flare'}).wire||'',deep:_imgEditCapability({provider:'deepseek',imageGenModel:''}).code||''}})()");
    check('guard.capabilityMatrix', capFn && capFn.unsup === '' && capFn.gem === 'gemini_inline' && capFn.gpt === 'openai_images_edits' && capFn.deep === 'IMAGE_EDIT_UNSUPPORTED', JSON.stringify(capFn));

    /* ── ⑦ 无图 → IMAGE_EDIT_NO_SOURCE 且 0 次请求 ── */
    const n1 = (await stats()).hits.length;
    const noSrc = await evaluate(cdp, "(async function(){var cfg=apiConfigs.find(function(a){return a.id==='ed1'});var ops=_parseWsOps('<ws_edit_image>把背景换成晚上</ws_edit_image>').ops;var rs=await _execWsOps(ops,'昔涟',cfg,{source:'chat',friendId:'empty_conv'});var r=rs[0]||{};return{ok:r.ok,code:r.code||'',reason:r.reason||''}})()");
    check('nosource.editNoSource', noSrc && noSrc.ok === false && noSrc.code === 'IMAGE_EDIT_NO_SOURCE', JSON.stringify(noSrc));
    check('nosource.zeroProviderRequests', (await stats()).hits.length === n1, JSON.stringify(noSrc));

    /* ── ⑧ 显式选中 > 最近一张；选中态可见可取消 ── */
    const sel = await evaluate(cdp, "(async function(){var msgs=await dbGetByIndex('chatMessages','byFriend','ed1');msgs.sort(function(a,b){return a.timestamp-b.timestamp});var A=msgs.find(function(m){return m.id==='a1'}).images[0];var r=IB.imageEdit.selectImage(A,{conversationId:'ed1'});var picked=await IB.imageEdit.resolveEditableImage({conversationId:'ed1'});var chips=document.querySelectorAll('[data-ib-edit-chip]').length;var bars=document.querySelectorAll('#chat-full-preview.has-items,#chat-mini-preview.has-items').length;IB.imageEdit.clearSelection();var after=await IB.imageEdit.resolveEditableImage({conversationId:'ed1'});return{selOk:r.ok===true,chip:chips,bars:bars,pickedId:picked.image&&picked.image.imageId,kind:picked.sourceKind,afterId:after.image&&after.image.imageId,afterKind:after.sourceKind,Aid:A.imageId}})()");
    check('select.explicitWins', sel && sel.pickedId === sel.Aid && sel.kind === 'explicit', JSON.stringify(sel));
    check('select.chipVisible', sel && sel.chip > 0 && sel.bars > 0, JSON.stringify(sel));
    check('select.clearedFallsBackToLatest', sel && sel.afterKind !== 'explicit' && sel.afterId !== sel.Aid, JSON.stringify(sel));
    const viewer = await evaluate(cdp, "(async function(){var msgs=await dbGetByIndex('chatMessages','byFriend','ed1');msgs.sort(function(a,b){return a.timestamp-b.timestamp});var A=msgs.find(function(m){return m.id==='a1'}).images[0];_viewImageFull(A.dataUrl,A);var btn=Array.from(document.querySelectorAll('.chat-bubble-img-full button')).find(function(b){return b.textContent==='编辑这张图'});if(!btn)return{btn:false};btn.click();var has=!!IB.imageEdit.getSelection();var chip=document.querySelectorAll('[data-ib-edit-chip]').length;IB.imageEdit.clearSelection();document.querySelectorAll('.chat-bubble-img-full').forEach(function(el){el.remove()});return{btn:true,has:has,chip:chip}})()");
    check('select.viewerButton', viewer && viewer.btn === true && viewer.has === true && viewer.chip > 0, JSON.stringify(viewer));

    /* ── ⑨ 参考图限额 + 复用 moments 压缩 helper 的缩放路径 ── */
    const refLimit = await evaluate(cdp, "(async function(){var msgs=await dbGetByIndex('chatMessages','byFriend','ed1');msgs.sort(function(a,b){return a.timestamp-b.timestamp});var A=msgs.find(function(m){return m.id==='a1'}).images[0];var mk=function(n){var b='" + TINY_PNG + "'+'A'.repeat(4*n);return{dataUrl:'data:image/png;base64,'+b,base64:b,mime:'image/png',name:'r'+n+'.png'}};var tooMany=await IB.imageEdit.buildEditRequest('x',{conversationId:'ed1',referenceImages:[mk(1),mk(2),mk(3),mk(4),mk(5)]});var badMime=await IB.imageEdit.buildEditRequest('x',{conversationId:'ed1',referenceImages:[{dataUrl:'data:image/gif;base64,'+btoa('x'.repeat(200)),mime:'image/gif'}]});return{limit:tooMany.ok===false&&tooMany.code==='IMAGE_REFERENCE_LIMIT',limitText:IB.imageEdit.editErrorText(tooMany),bad:badMime.ok===false&&badMime.code==='IMAGE_REFERENCE_INVALID',badText:IB.imageEdit.editErrorText(badMime)}})()");
    check('refs.countLimit', refLimit && refLimit.limit === true && refLimit.limitText === '参考图数量超出上限', JSON.stringify(refLimit));
    check('refs.invalidMime', refLimit && refLimit.bad === true && refLimit.badText.indexOf('无法用作编辑参考') >= 0, JSON.stringify(refLimit));
    const shrink = await evaluate(cdp, "(async function(){await dbPut('apiSettings',{id:'image_edit',maxReferenceBytes:1024*1024,maxTotalReferenceBytes:2*1024*1024,maxShrinkPx:512,shrinkQuality:0.8});IB.imageEdit.reloadLimits();var c=document.createElement('canvas');c.width=1024;c.height=1024;var ctx=c.getContext('2d');var data=ctx.createImageData(1024,1024);for(var i=0;i<data.data.length;i++)data.data[i]=Math.floor(Math.random()*256);ctx.putImageData(data,0,0);var big=c.toDataURL('image/png');var bigBytes=Math.floor(big.split(',')[1].length*0.75);var msgs=await dbGetByIndex('chatMessages','byFriend','ed1');msgs.sort(function(a,b){return a.timestamp-b.timestamp});var A=msgs.find(function(m){return m.id==='a1'}).images[0];var r=await IB.imageEdit.buildEditRequest('把这张改成晚上',{conversationId:'ed1',referenceImages:[{dataUrl:big,name:'big.png'}]});var refBytes=r.ok&&r.request.referenceImages[0]?Math.floor(r.request.referenceImages[0].base64.length*0.75):0;await dbDelete('apiSettings','image_edit');IB.imageEdit.reloadLimits();return{ok:r.ok===true,bigBytes:bigBytes,refBytes:refBytes,code:r.code||'',shrunk:refBytes>0&&refBytes<bigBytes&&refBytes<1024*1024}})()");
    check('refs.shrinkReusesMomentsHelper', shrink && shrink.ok === true && shrink.shrunk === true, JSON.stringify(shrink));
    const tooBig = await evaluate(cdp, "(async function(){await dbPut('apiSettings',{id:'image_edit',maxReferenceBytes:2048,maxTotalReferenceBytes:4096,maxShrinkPx:1024,shrinkQuality:0.9});IB.imageEdit.reloadLimits();var b='"+TINY_PNG+"'+'A'.repeat(4*20000);var r=await IB.imageEdit.buildEditRequest('x',{conversationId:'ed1',referenceImages:[{dataUrl:'data:image/png;base64,'+b,base64:b,mime:'image/png'}]});await dbDelete('apiSettings','image_edit');IB.imageEdit.reloadLimits();return{ok:r.ok,code:r.code||'',text:IB.imageEdit.editErrorText(r)}})()");
    check('refs.oversizeReported', tooBig && tooBig.ok === false && (tooBig.code === 'IMAGE_REFERENCE_TOO_LARGE' || tooBig.code === 'IMAGE_REFERENCE_INVALID'), JSON.stringify(tooBig));

    /* ── ⑩ edit 仍受 Scheduler 约束（global ≤ 2 / Sunburst ≤ 1） ── */
    const conc = await evaluate(cdp, "(async function(){var cfg=apiConfigs.find(function(a){return a.id==='ed1'});var msgs=await dbGetByIndex('chatMessages','byFriend','ed1');msgs.sort(function(a,b){return a.timestamp-b.timestamp});var A=msgs.find(function(m){return m.id==='a1'}).images[0];IB.imageRouter.reset();var mk=function(cid,op){return IB.imageRouter.routeImageRequest({source:'chat',characterId:cid,cfg:cfg,prompt:'并发'+cid+op,operation:op,previousImage:op==='edit'?A:null,userInitiated:true})};var rs=await Promise.all([mk('c1','edit'),mk('c2','edit'),mk('c3','generate')]);return rs.map(function(r){return r&&r.ok})})()");
    check('concurrency.allSucceeded', conc && conc.every(Boolean), JSON.stringify(conc));
    const s5 = await stats();
    check('concurrency.globalCap', s5.maxInFlight <= 2, 'maxInFlight=' + s5.maxInFlight);
    check('concurrency.sunburstCap', s5.maxSun <= 1, 'maxSun=' + s5.maxSun);
    check('concurrency.editsRoutedNotBypassed', s5.hits.filter(h => h.kind === 'edit').length >= 2, JSON.stringify(s5.hits.map(h => h.kind)));

    /* ── ⑪ 失败文案：不同 code 不同用户文案，不统一成"生成失败" ── */
    const texts = await evaluate(cdp, "(function(){var c=['IMAGE_EDIT_NO_SOURCE','IMAGE_EDIT_UNSUPPORTED','IMAGE_REFERENCE_INVALID','IMAGE_REFERENCE_TOO_LARGE','IMAGE_REFERENCE_LIMIT','IMAGE_EDIT_ABORTED','IMAGE_EDIT_TIMEOUT','IMAGE_PROVIDER_ERROR'];return c.map(function(x){return IB.imageRouter.imageRejectText({code:x})})})()");
    check('failure.distinctTexts', texts && new Set(texts).size === texts.length && texts.every(t => t && t !== '生成失败'), JSON.stringify(texts));

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
  console.log(failures === 0 ? '\nImage Editing Runtime browser smoke passed ✔' : '\nImage Editing Runtime browser smoke FAILED ✘');
  process.exit(failures ? 1 : 0);
})();
