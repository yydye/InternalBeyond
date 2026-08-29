'use strict';

/* Moments 第四阶段：独立图片生成能力冒烟测试（Node 18+，零依赖，需 Chrome / Edge）。
   核心原则：文字模型与图片模型彻底解耦——
   - 文字模型只负责 publish/wantImage/imagePrompt（建议配图 + 画面描述），不要求支持生图；
   - 真正的图片由独立 Image Provider（cfg.imageGen + imageGenModel，复用 _wsExecImageGen 链路）生成；
   - 图片失败/不可用/概率门未过 → 纯文字 Moment 照常发布（图片是增强，不是硬依赖）；
   - Companion 只输出 wantImage/imagePrompt，浏览器 ingest 时用图片 Provider 补图（单次落库，原子）；
   - imagePrompt 是内部生成参数，不写入公开 Moment 数据；图片与 Moment 共用同一 visibility。
   覆盖（对应需求 A–J）：
   A 文字模型不支持图片生成 → 仍能调用独立 Image Provider
   B 换不同文字模型 → 图片能力均来自 Image Provider
   C wantImage=false → 不调用图片 Provider
   D wantImage=true + 图片成功 → 图文 Moment（content!=空 && image!=null）
   E wantImage=true + 图片失败 → 纯文字 Moment 正常发布 + image_generation_failed 观测
   F publish=false → 无论 wantImage 都不调用图片 Provider
   G Companion 事件 wantImage/imagePrompt → 浏览器正确接收并生成图片（成功/降级/幂等）
   H 图片与 Moment 完全一致的 visibility/visibleRoleIds（同一条记录，无独立图片可见性）
   I 重复内容不因图片绕过文本去重
   J 公开 Moment 不含 imagePrompt/内部机制词 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');
const crypto = require('crypto');
const { pathToFileURL } = require('url');

const PAGE_URL = pathToFileURL(path.join(__dirname, 'InternalBeyond.html')).href;
const TINY_JPEG = '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD3+iiigD//2Q==';

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
    if (payload.length >= 126) { header[0] = 0x80 | opcode; header[1] = 0x80 | 126; header.writeUInt32BE(payload.length, 2); }
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
async function waitFor(cdp, expression, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { try { if (await evaluate(cdp, expression)) return true; } catch (error) {} await new Promise(r => setTimeout(r, 120)); }
  return false;
}
function freePort() {
  return new Promise((resolve, reject) => { const s = net.createServer(); s.unref(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(e => e ? reject(e) : resolve(p)); }); });
}
function startMockApi() {
  const chatByModel = {};
  const chatImgParts = {};   /* 每次 chat 请求中的 image_url parts 数（图片注入验证） */
  const chatToolRounds = {}; /* 工具回合续轮次数（bodyText 含「工具执行结果」） */
  const chatMentionHits = {};/* @ 点名强制评论次数（bodyText 含「指名回应」） */
  const imageHits = [];   /* OpenAI 兼容生图命中：{model,prompt,auth} */
  const geminiHits = [];  /* Gemini 生图命中：{url}（Key 在 query 上） */
  const server = http.createServer((req, res) => {
    const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-API-Key' };
    if (req.method === 'OPTIONS') { res.writeHead(204, headers); res.end(); return; }
    if (req.method === 'POST' && /images\/generations/i.test(req.url || '')) {
      /* ── 独立 Image Provider 端点（与文字 chat 端点同服务器但独立路由/模型） ── */
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        let model = '', prompt = '';
        try { const j = JSON.parse(body || '{}'); model = String(j.model || ''); prompt = String(j.prompt || ''); } catch (error) { /* ignore */ }
        imageHits.push({ model, prompt, auth: String(req.headers.authorization || '') });
        if (model === 'p4-noim') { res.writeHead(500, headers); res.end(JSON.stringify({ error: { message: 'image engine down' } })); return; }
        res.writeHead(200, headers);
        res.end(JSON.stringify({ data: [{ b64_json: TINY_JPEG }], usage: { prompt_tokens: 10, output_tokens: 20 } }));
      });
      return;
    }
    if (req.method === 'POST' && /:generateContent/i.test(req.url || '')) {
      /* ── Gemini 生图端点（responseModalities 路径；Key 走 query） ── */
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        geminiHits.push({ url: String(req.url || '') });
        res.writeHead(200, headers);
        res.end(JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { data: TINY_JPEG, mimeType: 'image/jpeg' } }] } }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3 } }));
      });
      return;
    }
    if (req.method === 'POST') {
      /* ── 文字模型端点：只输出 Moment JSON（含 wantImage/imagePrompt 建议），本身无任何图片能力 ── */
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        let model = '', bodyText = '', imgParts = 0;
        try {
          const j = JSON.parse(body || '{}');
          model = String(j.model || '');
          (j.messages || []).forEach(m => {
            if (Array.isArray(m.content)) m.content.forEach(p => { if (p && p.type === 'image_url') imgParts += 1; else if (p && p.type === 'text') bodyText += String(p.text || ''); });
            else if (typeof m.content === 'string') bodyText += m.content;
          });
          if (imgParts) chatImgParts[model] = (chatImgParts[model] || 0) + imgParts;
          if (bodyText.indexOf('指名回应') >= 0) chatMentionHits[model] = (chatMentionHits[model] || 0) + 1;
          if (bodyText.indexOf('工具执行结果') >= 0) chatToolRounds[model] = (chatToolRounds[model] || 0) + 1;
        } catch (error) { /* ignore */ }
        chatByModel[model] = (chatByModel[model] || 0) + 1;
        let content;
        if (model === 'p4-tex' && bodyText.indexOf('publishReply') >= 0) content = JSON.stringify({ publishReply: true, comment: '评论里回应你。', replyTo: '' });
        else if (model === 'p4-noimg' && bodyText.indexOf('publishReply') >= 0) content = JSON.stringify({ publishReply: true, comment: '被点名回一句。', replyTo: '' });
        else if (model === 'p4-img' && bodyText.indexOf('工具执行结果') >= 0) content = '图片已经生成好了，快看看是不是你想要的。';
        else if (model === 'p4-img' && bodyText.indexOf('publishComment') >= 0) content = JSON.stringify({ publishComment: true, comment: '图里的猫真好看。' });
        else if (model === 'p4-img') content = JSON.stringify({ publish: true, content: '在街角看见一只晒太阳的猫，留个照片。', visibility: 'all', wantImage: true, imagePrompt: 'A stray cat napping in warm afternoon light on an old street corner, casual smartphone photo, natural light' });
        else if (model === 'p4-noimg') content = JSON.stringify({ publish: true, content: '今天下班路上的天空颜色很特别。', visibility: 'all', wantImage: true, imagePrompt: 'Unusual pink and orange sky over city rooftops at dusk, casual phone snapshot' });
        else if (model === 'p4-imgd') content = JSON.stringify({ publish: true, content: '楼下小店的灯还亮着，暖黄色的。', visibility: 'all', wantImage: true, imagePrompt: 'A small shop with warm yellow light still on at night, casual phone photo' });
        else if (model === 'p4-tex') content = JSON.stringify({ publish: true, content: '夜里突然想到一件很久以前的事。', visibility: 'all', wantImage: false });
        else if (model === 'p4-dec') content = JSON.stringify({ publish: false, reason: '今天确实没什么好发的', wantImage: true, imagePrompt: 'a moon' });
        else if (model === 'p4-dup') content = JSON.stringify({ publish: true, content: '今天去了咖啡店。', visibility: 'all', wantImage: true, imagePrompt: 'A cup of coffee on a wooden table by the window' });
        else if (model === 'p4-ds') content = JSON.stringify({ publish: true, content: '独立图片账号测试。', visibility: 'all', wantImage: true, imagePrompt: 'A test image generated by a separate image account' });
        else if (model === 'p4-dsimtext') content = JSON.stringify({ publish: true, content: 'DeepSeek 文字+生图模型自动推断。', visibility: 'all', wantImage: true, imagePrompt: 'A test image for inferred provider' });
        else if (model === 'p4-dsrej2') content = JSON.stringify({ publish: true, content: 'DeepSeek 无生图模型边界。', visibility: 'all', wantImage: true, imagePrompt: 'Should never be called' });
        else if (model === 'p4-dsg') content = JSON.stringify({ publish: true, content: '独立 Gemini 图片账号测试。', visibility: 'all', wantImage: true, imagePrompt: 'A test image generated via a separate Gemini image account' });
        else if (model === 'p4-dsrej') content = JSON.stringify({ publish: true, content: '该角色文字是 DeepSeek 未单独配图。', visibility: 'all', wantImage: true, imagePrompt: 'Should never be called' });
        else if (model === 'p4-img2') content = JSON.stringify({ publish: true, content: '窗外的云真好看。', visibility: 'all', wantImage: false });
        else content = JSON.stringify({ publish: true, content: '默认内容 ' + model, visibility: 'all' });
        res.writeHead(200, headers);
        res.end(JSON.stringify({ choices: [{ message: { content } }] }));
      });
      return;
    }
    res.writeHead(404, headers); res.end(JSON.stringify({ error: 'not found' }));
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, chatByModel, chatImgParts, chatToolRounds, chatMentionHits, imageHits, geminiHits })));
}

async function main() {
  const chrome = chromePath(); if (!chrome) throw new Error('未找到 Chrome / Edge');
  const mock = await startMockApi(); const port = await freePort();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-moments-p4-'));
  const browser = spawn(chrome, ['--headless=new','--disable-gpu','--no-sandbox','--no-first-run','--allow-file-access-from-files','--remote-debugging-address=127.0.0.1','--remote-debugging-port=' + port,'--user-data-dir=' + profile,'about:blank'], { stdio: 'ignore' });
  let failures = 0, cdp;
  const check = (name, ok, detail = '') => { if (ok) console.log('  PASS  ' + name); else { failures++; console.error('  FAIL  ' + name + (detail ? '  -> ' + detail : '')); } };
  try {
    let ready = false;
    for (let i = 0; i < 120; i++) { try { if ((await fetch('http://127.0.0.1:' + port + '/json/version')).ok) { ready = true; break; } } catch (error) {} await new Promise(r => setTimeout(r, 100)); }
    check('browser.ready', ready); if (!ready) throw new Error('CDP 未就绪');
    const tab = await (await fetch('http://127.0.0.1:' + port + '/json/new?' + encodeURIComponent(PAGE_URL), { method: 'PUT' })).json();
    cdp = await Cdp.connect(tab.webSocketDebuggerUrl); await cdp.send('Runtime.enable');
    const exceptions = []; cdp.on('Runtime.exceptionThrown', p => exceptions.push(JSON.stringify(p.exceptionDetails || {})));
    await evaluate(cdp, "window.confirm=function(){return true;}");
    check('page.ready', await waitFor(cdp, "window.IB&&IB.moments&&typeof _momentsMakeImage==='function'&&typeof _momentsIngestEvent==='function'&&typeof generateRoleMoment==='function'", 20000));
    check('dual.p4', await evaluate(cdp, "typeof _momentsMakeImage==='function'&&typeof IB.moments._momentsMakeImage==='function'&&typeof IB.moments._momentsIngestEvent==='function'"));
    /* 固定 companion 为离线，走纯浏览器路径（ingest 直接调用，不依赖服务在线） */
    await evaluate(cdp, "(function(){Object.defineProperty(window,'_activeCompanionOnline',{value:false,writable:true,configurable:true});return true})()");
    await evaluate(cdp, "_momentsPrefsSave({aiComment:false,aiLike:false,frequency:'low'})");

    const cfg = (id, model, extra) => "{id:'" + id + "',provider:'openai',model:'" + model + "',endpoint:'http://127.0.0.1:" + mock.port + "/v1/chat/completions',apiKey:'',nickname:'" + id + "',systemPrompt:'你是测试角色'" + (extra || '') + "}";
    const EP = 'http://127.0.0.1:' + mock.port + '/v1/chat/completions';
    const GEP = 'http://127.0.0.1:' + mock.port + '/v1beta/models/{model}:generateContent';
    await evaluate(cdp, "(async function(){await dbPut('apiConfigs'," + cfg('p4a','p4-img',",imageGen:true,imageGenModel:'p4-img-gen',vision:true") + ");await dbPut('apiConfigs'," + cfg('p4b','p4-noimg',",imageGen:true,imageGenModel:'p4-img-gen',vision:true") + ");await dbPut('apiConfigs'," + cfg('p4c','p4-tex',",imageGen:true,imageGenModel:'p4-img-gen'") + ");await dbPut('apiConfigs'," + cfg('p4d','p4-imgd',",imageGen:true,imageGenModel:'p4-noim'") + ");await dbPut('apiConfigs'," + cfg('p4f','p4-dec',",imageGen:true,imageGenModel:'p4-img-gen'") + ");await dbPut('apiConfigs'," + cfg('p4dup','p4-dup',",imageGen:true,imageGenModel:'p4-img-gen'") + ");await dbPut('apiConfigs'," + cfg('p4g','p4-img',",imageGen:false,imageGenModel:'p4-img-gen'") + ");" +
      /* 凭证级解耦：文字 DeepSeek + 图片独立账号（OpenAI 兼容 / Gemini 各一） */
      "await dbPut('apiConfigs',{id:'p4ind',provider:'deepseek',model:'p4-ds',endpoint:'" + EP + "',apiKey:'',nickname:'p4ind',systemPrompt:'你是测试角色',imageGen:true,imageGenProvider:'openai',imageGenEndpoint:'" + EP + "',imageGenApiKey:'sk-image-separate',imageGenModel:'p4-img-gen'});" +
      "await dbPut('apiConfigs',{id:'p4gemi',provider:'deepseek',model:'p4-dsg',endpoint:'" + EP + "',apiKey:'',nickname:'p4gemi',systemPrompt:'你是测试角色',imageGen:true,imageGenProvider:'gemini',imageGenEndpoint:'" + GEP + "',imageGenApiKey:'sk-gemini-sep',imageGenModel:'gemini-2.5-flash-image'});" +
      "await dbPut('apiConfigs',{id:'p4rej',provider:'deepseek',model:'p4-dsrej',endpoint:'" + EP + "',apiKey:'',nickname:'p4rej',systemPrompt:'你是测试角色',imageGen:true,imageGenModel:'p4-img-gen'});" +
      /* 图片注入验证（v5）：p4a/p4b 声明视觉；p4v2 纯文字模型（无生图）+ 视觉——验证"朋友带图动态 → 生成时看图" */
      "await dbPut('apiConfigs',{id:'p4v2',provider:'openai',model:'p4-img2',endpoint:'" + EP + "',apiKey:'',nickname:'p4v2',systemPrompt:'你是测试角色',vision:true});" +
      /* 服务商自动推断（v7.3）：DeepSeek 文字 + 显式生图模型（未设 imageGenProvider）→ 按模型名推断图片服务商 */
      "await dbPut('apiConfigs',{id:'p4dsim',provider:'deepseek',model:'p4-dsimtext',endpoint:'" + EP + "',apiKey:'',nickname:'p4dsim',systemPrompt:'你是测试角色',imageGen:true,imageGenModel:'p4-img-gen'});" +
      /* 真正边界：DeepSeek 文字 + 无生图模型（也未设 imageGenProvider）→ 保持拒绝 */
      "await dbPut('apiConfigs',{id:'p4rej2',provider:'deepseek',model:'p4-dsrej2',endpoint:'" + EP + "',apiKey:'',nickname:'p4rej2',systemPrompt:'你是测试角色',imageGen:true});" +
      "await loadApiConfigs();return true})()");

    /* ══ A + D：文字模型（p4-img，纯文字端点）输出 wantImage:true → 独立 Image Provider（p4-img-gen）出图 ══ */
    const a = await evaluate(cdp, "generateRoleMoment('p4a',{trigger:'manual',forceImage:true})");
    check('A/D.wantImagePublishesWithImage', a && a.ok === true && a.published === true && a.wantImage === true && a.moment && a.moment.images.length === 1 && String(a.moment.images[0].dataUrl || '').indexOf('data:image/jpeg') === 0, JSON.stringify(a && { ok: a.ok, published: a.published, wantImage: a.wantImage, images: a.moment && a.moment.images.length }));
    check('A.decoupledImageModel', mock.imageHits.some(h => h.model === 'p4-img-gen') && (mock.chatByModel['p4-img'] || 0) >= 1, JSON.stringify({ chat: mock.chatByModel['p4-img'], img: mock.imageHits }));
    check('A.imagePromptUsed', mock.imageHits.some(h => h.prompt.indexOf('stray cat') >= 0), JSON.stringify(mock.imageHits[0] || {}));
    const obs1 = await evaluate(cdp, "(function(){var api=_socialObserveApi();return api?api.recentEvents(300):[]})()");
    check('A/D.obsRecords', Array.isArray(obs1) && obs1.some(e => e.t === 'image_attempt' && e.actor === 'p4a') && obs1.some(e => e.t === 'image_ok' && e.actor === 'p4a') && obs1.some(e => e.t === 'post' && e.actor === 'p4a' && e.wantImage === true && e.imageGenerated === true), JSON.stringify((obs1 || []).filter(e => /image|post/.test(e.t)).slice(-6)));

    /* ══ B：换不同文字模型（p4-noimg）→ 图片能力仍来自 Image Provider ══ */
    const imgHitsAfterA = mock.imageHits.length;
    const b = await evaluate(cdp, "generateRoleMoment('p4b',{trigger:'manual',forceImage:true})");
    check('B.differentTextModelSameImageProvider', b && b.ok === true && b.published === true && b.moment && b.moment.images.length === 1 && mock.imageHits.length === imgHitsAfterA + 1 && (mock.chatByModel['p4-noimg'] || 0) >= 1, JSON.stringify(b && { ok: b.ok, images: b.moment && b.moment.images.length, imgHits: mock.imageHits.length }));

    /* ══ C：wantImage=false → 不调用图片 Provider ══ */
    const imgHitsAfterB = mock.imageHits.length;
    const c = await evaluate(cdp, "generateRoleMoment('p4c',{trigger:'manual',forceImage:true})");
    check('C.wantImageFalseNoImageCall', c && c.ok === true && c.published === true && c.wantImage === false && c.moment && c.moment.images.length === 0 && mock.imageHits.length === imgHitsAfterB, JSON.stringify(c && { ok: c.ok, wantImage: c.wantImage, images: c.moment && c.moment.images.length, imgHits: mock.imageHits.length }));

    /* ══ E：wantImage=true + 图片 Provider 失败 → 纯文字 Moment 正常发布 + image_generation_failed ══ */
    const imgHitsAfterC = mock.imageHits.length;
    const e = await evaluate(cdp, "(async function(){var r=await generateRoleMoment('p4d',{trigger:'manual',forceImage:true});var m=r.moment&&r.moment.id?await getMoment(r.moment.id):null;return{ok:r.ok,published:r.published,images:m&&m.images.length,content:m&&m.content}})()");
    check('E.imageFailKeepsText', e && e.ok === true && e.published === true && e.images === 0 && e.content === '楼下小店的灯还亮着，暖黄色的。' && mock.imageHits.length === imgHitsAfterC + 1 && (mock.imageHits[imgHitsAfterC] || {}).model === 'p4-noim', JSON.stringify(e) + ' imgHits=' + mock.imageHits.length);
    const obsE = await evaluate(cdp, "(function(){var api=_socialObserveApi();return api?api.recentEvents(300):[]})()");
    check('E.obsImageGenerationFailed', Array.isArray(obsE) && obsE.some(x => x.t === 'image_generation_failed' && x.actor === 'p4d' && /500|失败|down/.test(String(x.reason_class || ''))), JSON.stringify((obsE || []).filter(x => x.t === 'image_generation_failed').map(x => ({ a: x.actor, r: x.reason_class })).slice(-3)));
    check('E.postStillRecorded', Array.isArray(obsE) && obsE.some(x => x.t === 'post' && x.actor === 'p4d' && x.imageGenerated === false), '');

    /* ══ F：publish=false（即便 wantImage:true）→ 不调用图片 Provider、不发布 ══ */
    const imgHitsAfterE = mock.imageHits.length;
    const f = await evaluate(cdp, "(async function(){var r=await generateRoleMoment('p4f',{trigger:'manual',forceImage:true});return{ok:r.ok,published:r.published,wantImage:r.wantImage,count:(await getRoleMoments('p4f')).length}})()");
    check('F.publishFalseNoImageNoPost', f && f.ok === true && f.published === false && f.count === 0 && mock.imageHits.length === imgHitsAfterE, JSON.stringify(f) + ' imgHits=' + mock.imageHits.length);

    /* ══ I：图片不能绕过文本去重（同内容二次 → 拒发且不调用图片 Provider） ══ */
    await evaluate(cdp, "(async function(){await createMoment({roleId:'p4dup',content:'今天去了咖啡店。',source:'manual',visibility:'all'});return true})()");
    const imgHitsAfterF = mock.imageHits.length;
    const i = await evaluate(cdp, "(async function(){var r=await generateRoleMoment('p4dup',{trigger:'manual',forceImage:true});var own=await getRoleMoments('p4dup');return{ok:r.ok,err:r.error,count:own.filter(function(m){return m.content==='今天去了咖啡店。'}).length}})()");
    check('I.dedupeNotBypassedByImage', i && i.ok === false && /相似/.test(i.err || '') && i.count === 1 && mock.imageHits.length === imgHitsAfterF, JSON.stringify(i) + ' imgHits=' + mock.imageHits.length);

    /* ══ G + H + J：Companion 事件（want_image/image_prompt）→ 浏览器 Image Provider → 图文 Moment ══ */
    const imgHitsAfterI = mock.imageHits.length;
    const g = await evaluate(cdp, "(async function(){" +
      "var ev={id:'event_mom_p4g',kind:'moment',moment:{id:'mom_p4g_comp',roleId:'p4a',content:'后台也想分享窗边的一只猫。',images:[],visibility:'all',visibleRoleIds:[],likes:[],comments:[],source:'proactive',createdAt:new Date().toISOString()},next_at:Date.now()+3600000,last_post_at:Date.now(),sent_at:Date.now(),want_image:true,image_prompt:'A cat by the window in warm evening light, casual photo'};" +
      "var first=await _momentsIngestEvent(ev,_activeUserId());var second=await _momentsIngestEvent(ev,_activeUserId());var m=await getMoment('mom_p4g_comp');" +
      "return{first:first,second:second,exists:!!m,images:m&&m.images.length,hasImagePrompt:!!(m&&('imagePrompt'in m||'wantImage'in m||'includeImage'in m||'image_prompt'in m||'want_image'in m)),content:m&&m.content}})()");
    check('G.companionEventBrowserImage', g && g.first === true && g.second === false && g.exists === true && g.images === 1 && mock.imageHits.length === imgHitsAfterI + 1, JSON.stringify(g));
    /* 幂等：重复事件不再补图 */
    const g2 = await evaluate(cdp, "(async function(){var m=await getMoment('mom_p4g_comp');return{images:m&&m.images.length}})()");
    check('G.idempotentNoRegenerate', g2 && g2.images === 1 && mock.imageHits.length === imgHitsAfterI + 1, JSON.stringify(g2) + ' imgHits=' + mock.imageHits.length);
    /* J：公开 Moment 不含内部参数（imagePrompt 不落库、正文无内部机制词） */
    check('J.noInternalPromptStored', g && g.hasImagePrompt === false && String(g.content || '').indexOf('casual photo') < 0, JSON.stringify(g));
    /* H：图片与 Moment 共用同一 visibility/visibleRoleIds（同一条记录；内容按概率门 hash 校准以稳定出图） */
    const h = await evaluate(cdp, "(async function(){" +
      "var ev={id:'event_mom_p4h',kind:'moment',moment:{id:'mom_p4h_comp',roleId:'p4b',content:'只想给部分朋友看的一张照片，阳光很好。',images:[],visibility:'roles',visibleRoleIds:['p4a'],likes:[],comments:[],source:'proactive',createdAt:new Date().toISOString()},next_at:Date.now()+3600000,last_post_at:Date.now(),sent_at:Date.now(),want_image:true,image_prompt:'A shared photo of a quiet street at noon'};" +
      "var ok=await _momentsIngestEvent(ev,_activeUserId());var m=await getMoment('mom_p4h_comp');" +
      "return{ok:ok,vis:m&&m.visibility,ids:m&&m.visibleRoleIds,images:m&&m.images.length,total:(await dbGetAll(MOMENT_STORE)).filter(function(x){return x.id==='mom_p4h_comp'}).length}})()");
    check('H.visibilitySharedWithImage', h && h.ok === true && h.vis === 'roles' && Array.isArray(h.ids) && h.ids[0] === 'p4a' && h.images === 1 && h.total === 1, JSON.stringify(h));

    /* ══ 凭证级解耦：文字模型（DeepSeek，无生图能力）+ 独立图片账号（OpenAI 兼容：ImageGenProvider/Endpoint/ApiKey） ══ */
    const imgHitsBeforeSep = mock.imageHits.length;
    const k = await evaluate(cdp, "(async function(){var r=await generateRoleMoment('p4ind',{trigger:'manual',forceImage:true});var m=r.moment&&r.moment.id?await getMoment(r.moment.id):null;return{ok:r.ok,published:r.published,images:m&&m.images.length,content:m&&m.content}})()");
    const sepHit = mock.imageHits[imgHitsBeforeSep] || null;
    check('sep.openaiIndependentCredential', k && k.ok === true && k.published === true && k.images === 1 && mock.imageHits.length === imgHitsBeforeSep + 1 && sepHit && sepHit.auth === 'Bearer sk-image-separate' && sepHit.model === 'p4-img-gen', JSON.stringify(k) + ' hit=' + JSON.stringify(sepHit));
    check('sep.wantImageFromDeepSeekText', (mock.chatByModel['p4-ds'] || 0) >= 1, JSON.stringify(mock.chatByModel));

    /* ══ Gemini 独立图片账号（独立 Key/端点，responseModalities 路径） ══ */
    const k2 = await evaluate(cdp, "(async function(){var r=await generateRoleMoment('p4gemi',{trigger:'manual',forceImage:true});var m=r.moment&&r.moment.id?await getMoment(r.moment.id):null;return{ok:r.ok,published:r.published,images:m&&m.images.length}})()");
    const gh = mock.geminiHits[mock.geminiHits.length - 1] || null;
    check('sep.geminiIndependentCredential', k2 && k2.ok === true && k2.published === true && k2.images === 1 && gh && gh.url.indexOf('models/gemini-2.5-flash-image:generateContent') >= 0 && gh.url.indexOf('key=sk-gemini-sep') >= 0 && mock.imageHits.length === imgHitsBeforeSep + 1, JSON.stringify(k2) + ' geminiHits=' + mock.geminiHits.length + ' url=' + String(gh && gh.url).slice(0, 120));

    /* ══ 能力边界保持：文字 DeepSeek 且未单独指定图片服务商 → 仍拒绝生图（不调用图片端点） ══ */
    const imgHitsBeforeRej = mock.imageHits.length;
    const kr = await evaluate(cdp, "(async function(){var r=await generateRoleMoment('p4rej',{trigger:'manual',forceImage:true});var m=r.moment&&r.moment.id?await getMoment(r.moment.id):null;return{ok:r.ok,published:r.published,images:m&&m.images.length}})()");
    /* 服务商自动推断（v7.3）：DeepSeek 文字 + 显式生图模型 → 推断出图 */
    const imgHitsBeforeInfer = mock.imageHits.length;
    const kInf = await evaluate(cdp, "(async function(){var r=await generateRoleMoment('p4dsim',{trigger:'manual',forceImage:true});var m=r.moment&&r.moment.id?await getMoment(r.moment.id):null;var prov=window._imgResolveProvider?window._imgResolveProvider(apiConfigs.find(function(a){return a.id==='p4dsim'})):'';return{ok:r.ok,published:r.published,images:m&&m.images.length,prov:prov}})()");
    const infHit = mock.imageHits[mock.imageHits.length - 1] || null;
    check('infer.deepSeekTextInfersProvider', kInf && kInf.ok === true && kInf.published === true && kInf.images === 1 && kInf.prov === 'openai' && mock.imageHits.length === imgHitsBeforeInfer + 1, JSON.stringify(kInf) + ' hit=' + JSON.stringify(infHit));
    /* p4rej（DeepSeek + 生图模型）现在也推断出图——旧"仍拒绝"语义被新需求取代 */
    await evaluate(cdp, "(async function(){var own=await getRoleMoments('p4rej');for(var i=0;i<own.length;i++)await dbDelete(MOMENT_STORE,own[i].id);return true})()");
    const imgHitsBeforeP4rej = mock.imageHits.length;
    const krNew = await evaluate(cdp, "(async function(){var r=await generateRoleMoment('p4rej',{trigger:'manual',forceImage:true});var m=r.moment&&r.moment.id?await getMoment(r.moment.id):null;return{ok:r.ok,published:r.published,images:m&&m.images.length}})()");
    check('infer.p4rejNowInfersAndGenerates', krNew && krNew.ok === true && krNew.published === true && krNew.images === 1 && mock.imageHits.length === imgHitsBeforeP4rej + 1, JSON.stringify(krNew) + ' imgHits=' + mock.imageHits.length);
    /* 真边界：DeepSeek 文字 + 无生图模型 → 仍拒绝（images=0，无图片请求） */
    const imgHitsBeforeRej2 = mock.imageHits.length;
    const kr2 = await evaluate(cdp, "(async function(){var r=await generateRoleMoment('p4rej2',{trigger:'manual',forceImage:true});var m=r.moment&&r.moment.id?await getMoment(r.moment.id):null;return{ok:r.ok,published:r.published,images:m&&m.images.length}})()");
    check('infer.trueBoundaryNoModelStillRejected', kr2 && kr2.ok === true && kr2.published === true && kr2.images === 0 && mock.imageHits.length === imgHitsBeforeRej2, JSON.stringify(kr2) + ' imgHits=' + mock.imageHits.length);

    /* ══ 图片注入（v5）：朋友圈图片作为 image part 发给支持视觉的角色（DeepSeek 文本模型不注入） ══ */
    /* 评论看图：p4b 发带图动态 → p4a（vision:true）评论时请求含 image_url */
    await evaluate(cdp, "_momentsPrefsSave({aiComment:true})");
    const injA = await evaluate(cdp, "(async function(){var t=await createMoment({roleId:'p4b',content:'p4b 发的一张测试图动态。',images:[{dataUrl:'data:image/jpeg;base64," + TINY_JPEG + "',base64:'" + TINY_JPEG + "',mime:'image/jpeg',name:'t.jpg'}],visibility:'all'});var r=await generateRoleComment('p4a',t.moment.id);return{ok:r.ok,published:r.published,comment:r.comment,err:r.error}})()");
    await evaluate(cdp, "_momentsPrefsSave({aiComment:false})");
    check('inject.commentSeesImage', injA && injA.ok === true && injA.published === true && (mock.chatImgParts['p4-img'] || 0) >= 1, JSON.stringify(injA) + ' imgParts=' + (mock.chatImgParts['p4-img'] || 0));
    /* 生成看图：p4v2（vision:true，纯文字模型）生成时朋友带图动态 → 请求含 image_url */
    const injB = await evaluate(cdp, "(async function(){var r=await generateRoleMoment('p4v2',{trigger:'manual'});return{ok:r.ok,published:r.published,wantImage:r.wantImage}})()");
    check('inject.generateSeesOthersImage', injB && injB.ok === true && injB.published === true && (mock.chatImgParts['p4-img2'] || 0) >= 1, JSON.stringify(injB) + ' imgParts=' + (mock.chatImgParts['p4-img2'] || 0));
    check('inject.textModelNoImagePart', !((mock.chatImgParts['p4-dsrej'] || 0) > 0), 'imgParts(p4-dsrej)=' + (mock.chatImgParts['p4-dsrej'] || 0));
    check('inject.obsImageInject', await evaluate(cdp, "(function(){var api=_socialObserveApi();return api?api.recentEvents(300).some(function(e){return e.t==='image_inject'&&e.actor==='p4a'}):false})()"), '');
    /* ICode 图片读取：ws_read_image → 回注队列 */
    const injD = await evaluate(cdp, "(async function(){var pid=await wsEnsureDefaultProject();await wsSaveFile(pid,'p4_readme_img.png','data:image/jpeg;base64," + TINY_JPEG + "','User');window._wsActiveProject=pid;var before=(window._ibImageDrain||[]).length;var r=await _processWsResponse('<ws_read_image path=\"p4_readme_img.png\"/>','测试','p4a-json');var exists=!!(await wsGetFileByPath(pid,'p4_readme_img.png'));return{nCards:(r.cards||[]).length,queued:(window._ibImageDrain||[]).length-before,exists:exists}})()");
    check('inject.icodeReadImageQueued', injD && injD.exists === true && injD.nCards === 1 && injD.queued >= 1, JSON.stringify(injD));
    /* read_image 容错：误拼为 ws_gen_image 前缀的 path 自动规范化后可读取 */
    const injD2 = await evaluate(cdp, "(async function(){var before=(window._ibImageDrain||[]).length;var r=await _processWsResponse('<ws_read_image path=\"ws_gen_imagep4_readme_img.png\"/>','测试','p4a-json');return{nCards:(r.cards||[]).length,queued:(window._ibImageDrain||[]).length-before}})()");
    check('inject.icodeReadImagePathTolerant', injD2 && injD2.queued >= 1 && injD2.nCards === 1, JSON.stringify(injD2));
    /* vision 判定：默认放行（多模态普遍）；显式关闭才拒绝；DeepSeek 文本走本地描述 */
    const visChk = await evaluate(cdp, "(function(){var a=_momentsVisionKind({id:'x',provider:'custom',model:'m'})==='native';var b=_momentsVisionKind({id:'x',provider:'custom',model:'m',vision:false})===null;var c=_momentsVisionKind({id:'x',provider:'openai',model:'m',vision:true})==='native';var d=_momentsVisionKind({id:'x',provider:'deepseek',model:'deepseek-chat'})==='deepseek_local';return{a:a,b:b,c:c,d:d}})()");
    check('vision.defaultAllowExplicitOff', visChk && visChk.a === true && visChk.b === true && visChk.c === true && visChk.d === true, JSON.stringify(visChk));
    /* 数组 content（带图消息）+ 尾部上下文注入：text 追加到 text part，图片 part 保留（mimo 等"看不见图片"根因回归） */
    const tailChk = await evaluate(cdp, "(function(){var msg={role:'user',content:[{type:'text',text:'看看这张图'},{type:'_image',base64:'QUJD',mime:'image/jpeg'}]};_appendMsgText(msg,'\\n\\n---\\n[尾部上下文] 这是一条注入');return{arr:Array.isArray(msg.content),n:msg.content.length,imgKept:msg.content.some(function(p){return p.type==='_image'&&p.base64==='QUJD'}),textOk:msg.content[0].text.indexOf('尾部上下文')>=0,noGarbage:msg.content.every(function(p){return typeof p!=='string'||p.indexOf('[object')<0})}})()");
    check('tail.injectKeepsImageParts', tailChk && tailChk.arr === true && tailChk.n === 2 && tailChk.imgKept === true && tailChk.textOk === true && tailChk.noGarbage === true, JSON.stringify(tailChk));
    /* 朋友圈 @ 点名（v7）：正文 @昵称 解析 + 2 分钟必回冷却 + 被 @ 角色强制评论 */
    const mpChk = await evaluate(cdp, "(function(){" +
      "var a=_momentsParseMentions('@p4b 你觉得呢 @p4z 也在吗','p4a');" +
      "var b=_momentsParseMentions('普通的夜晚，＠p4c 你说呢','p4a');" +
      "var c=_momentsParseMentions('没有@任何人的一句话','p4a');" +
      "var f1=_momentsMentionCanForce('p4a');var f2=_momentsMentionCanForce('p4a');" +
      "var lg=JSON.parse(localStorage.getItem('ib_moments_mention_v1')||'{}');lg['p4a']=Date.now()-180000;localStorage.setItem('ib_moments_mention_v1',JSON.stringify(lg));" +
      "var f3=_momentsMentionCanForce('p4a');" +
      "return{aHasP4b:a.indexOf('p4b')>=0,aNoGhost:a.indexOf('p4z')<0,aNoAuthor:a.indexOf('p4a')<0,bHasP4c:b.indexOf('p4c')>=0,cEmpty:c.length===0,first:f1===true,cooldown:f1===true&&f2===false,recovered:f3===true};})()");
    check('mention.parseMentions', mpChk && mpChk.aHasP4b === true && mpChk.aNoGhost === true && mpChk.aNoAuthor === true && mpChk.bHasP4c === true && mpChk.cEmpty === true, JSON.stringify(mpChk));
    check('mention.cooldown2min', mpChk && mpChk.first === true && mpChk.cooldown === true && mpChk.recovered === true, JSON.stringify(mpChk));
    /* 强制评论：p4v2 发帖 @p4b → 被 @ 者豁免冷却自动评论，且请求带「指名回应」强约束（@ 独立于 AI 评论总开关） */
    const mentionBefore = (mock.chatMentionHits['p4-noimg'] || 0);
    const midMention = await evaluate(cdp, "(async function(){var r=await createMoment({roleId:'p4v2',content:'@p4b 你觉得凌晨三点的暖色是什么感觉？',visibility:'all'});return r.moment.id})()");
    const mentionDone = await waitFor(cdp, "(async function(){var m=await getMoment('" + midMention + "');return !!(m&&(m.comments||[]).some(function(c){return c.authorType==='role'&&c.authorId==='p4b'}))})()", 9000);
    const mentionInfo = await evaluate(cdp, "(async function(){var m=await getMoment('" + midMention + "');var c=(m.comments||[]).find(function(x){return x.authorType==='role'&&x.authorId==='p4b'});return{commented:!!c,text:c?c.content:''}})()");
    check('mention.forceReplyMustAnswer', mentionDone === true && mentionInfo.commented === true && mentionInfo.text === '被点名回一句。' && (mock.chatMentionHits['p4-noimg'] || 0) > mentionBefore, JSON.stringify(mentionInfo) + ' hits=' + (mock.chatMentionHits['p4-noimg'] || 0) + '/' + mentionBefore);
    /* 冷却内重复 @ 不再强制（p4b 2 分钟内被 @ 第二次 → 无第二次必回请求） */
    const beforeCooldownHits = (mock.chatMentionHits['p4-noimg'] || 0);
    await evaluate(cdp, "(async function(){var r=await createMoment({roleId:'p4v2',content:'@p4b 再问你一次呢？',visibility:'all'});return true})()");
    await new Promise(r => setTimeout(r, 4500));
    check('mention.cooldownSkipsSecond', (mock.chatMentionHits['p4-noimg'] || 0) === beforeCooldownHits, 'hits=' + (mock.chatMentionHits['p4-noimg'] || 0) + '/' + beforeCooldownHits);
    /* 评论区 @ 触发（v7.2）：用户评论里 @p4c → 被 @ 者必回该评论 */
    const cmBefore=(mock.chatMentionHits['p4-tex']||0);
    const cmId=await evaluate(cdp, "(async function(){var r=await createMoment({roleId:'p4v2',content:'评论区@测试动态。',visibility:'all'});await addMomentComment(r.moment.id,{authorType:'user',authorId:'user',content:'@p4c 你怎么看？'});return r.moment.id})()");
    const cmOk=await waitFor(cdp, "(async function(){var m=await getMoment('" + cmId + "');return !!(m&&(m.comments||[]).some(function(c){return c.authorType==='role'&&c.authorId==='p4c'&&c.content==='评论里回应你。'}))})()", 9000);
    check('cmtw.commentMentionForced', cmOk === true && (mock.chatMentionHits['p4-tex'] || 0) > cmBefore, 'hits=' + (mock.chatMentionHits['p4-tex'] || 0) + '/' + cmBefore);
    await evaluate(cdp, "_momentsPrefsSave({aiComment:false})");
    /* @ 补全面板（v7）：输入 @ 弹角色候选，点击项插入昵称 */
    await evaluate(cdp, "_momComposeMentionInit()");
    const menUi = await evaluate(cdp, "(function(){var ta=document.getElementById('mom-compose-text');var b=document.getElementById('mom-compose-mention');ta.value='@p4';ta.focus();ta.selectionStart=ta.selectionEnd=ta.value.length;ta.dispatchEvent(new Event('input',{bubbles:true}));var items=b.querySelectorAll('.mom-mention-item');var hasP4b=Array.prototype.some.call(items,function(i){return i.textContent==='@p4b'});return{visible:!b.hidden,count:items.length,hasP4b:hasP4b}})()");
    check('mention.ui.panelShowsCandidates', menUi && menUi.visible === true && menUi.count >= 1 && menUi.hasP4b === true, JSON.stringify(menUi));
    const menUi2 = await evaluate(cdp, "(function(){var ta=document.getElementById('mom-compose-text');var b=document.getElementById('mom-compose-mention');var it=Array.prototype.find.call(b.querySelectorAll('.mom-mention-item'),function(i){return i.textContent==='@p4b'});if(it)it.dispatchEvent(new MouseEvent('mousedown',{bubbles:true}));return{val:ta.value,hidden:b.hidden,pos:ta.selectionStart}})()");
    check('mention.ui.insertName', menUi2 && menUi2.val.indexOf('@p4b') >= 0 && menUi2.hidden === true, JSON.stringify(menUi2));
    /* waifu 模式（v7）：长回复按中文句读拆成多条短消息；含功能标签/太短/单句不拆 */
    const wfChk = await evaluate(cdp, "(function(){" +
      "var a=_waifuSplit('今天天气真好啊。阳光很暖。适合出去走走。')!=null;" +
      "var b=_waifuSplit('就一句。')===null;" +
      "var c=_waifuSplit('<ws_create path=\\\"a.txt\\\">x</ws_create>继续')===null;" +
      "var d=_waifuSplit('嗯哼？然后呢？真的假的？不是吧。')!=null;" +
      "var s=_waifuSplit('第一句。第二句。第三句。第四句。第五句。第六句。');" +
      "return{a:a,b:b,c:c,d:d,n:s?s.length:0,allShort:s?s.every(function(x){return x.length<=96}):false};})()");
    check('waifu.splitRules', wfChk && wfChk.a === true && wfChk.b === true && wfChk.c === true && wfChk.d === true && wfChk.n > 1 && wfChk.allShort === true, JSON.stringify(wfChk));
    /* 微信式小动作（v7）：撤回判定（@自己/@幽灵） + 撤回动作改写为撤回文案 */
    const wdChk = await evaluate(cdp, "(function(){" +
      "var ghost=_chatShouldWithdraw('@p4z 在吗？');" +
      "var real=_chatShouldWithdraw('@p4b 你觉得呢');" +
      "var none=_chatShouldWithdraw('今天天气不错。');" +
      "return{ghost:ghost,real:real,none:none};})()");
    check('withdraw.judgeGhostMention', wdChk && wdChk.ghost === true && wdChk.real === false && wdChk.none === false, JSON.stringify(wdChk));
    const wdAct = await evaluate(cdp, "(async function(){await dbPut('chatMessages',{id:'wm_test1',role:'assistant',content:'这话说错了',senderName:'洪伟湟',friendId:'f_wm',metadata:{model:'m',config_id:'p4a'},timestamp:Date.now()});var ok=await _chatWithdrawMsg('wm_test1');var m=await dbGet('chatMessages','wm_test1');return{ok:ok,text:m.content,withdrawn:m.withdrawn}})()");
    check('withdraw.rewriteToNotice', wdAct && wdAct.ok === true && wdAct.withdrawn === true && wdAct.text.indexOf('撤回了一条消息') >= 0 && wdAct.text.indexOf('洪伟湟') >= 0, JSON.stringify(wdAct));
    /* 模型自主撤回（v7.1）：<withdraw/> 提取 + 撤回自己上一条 */
    const wdAuto = await evaluate(cdp, "(function(){var a=_extractWithdraw('我刚刚说错了 <withdraw/>');var b=_extractWithdraw('正常回复');return{aClean:a.clean,aW:a.withdraw,bClean:b.clean,bW:b.withdraw}})()");
    check('withdraw.autoExtractTag', wdAuto && wdAuto.aW === true && wdAuto.aClean.indexOf('withdraw') < 0 && wdAuto.bW === false, JSON.stringify(wdAuto));
    const wdSelf = await evaluate(cdp, "(async function(){var f='f_wd2';await dbPut('chatMessages',{id:'wm_old',role:'assistant',content:'刚才那句话我说错了',senderName:'初音未来',friendId:f,metadata:{model:'m',config_id:'p4a'},timestamp:Date.now()});var cfg=apiConfigs.find(function(a){return a.id==='p4a'});var ok=await _chatWithdrawSelf(cfg,'f_wd2','初音未来');var old=await dbGet('chatMessages','wm_old');return{ok:ok,oldWithdrawn:old&&old.withdrawn,oldText:old&&old.content}})()");
    check('withdraw.autoWithdrawSelf', wdSelf && wdSelf.ok === true && wdSelf.oldWithdrawn === true && wdSelf.oldText.indexOf('撤回了一条消息') >= 0, JSON.stringify(wdSelf));
    /* 朋友圈评论区撤回（v7.1）：AI 评论 @ 错人 → 改写为"撤回了一条评论"占位；正常评论不撤 */
    const cmdShould = await evaluate(cdp, "(function(){var m={comments:[{id:'c1',authorType:'role',authorId:'p4b',content:'@p4z 在吗'},{id:'c2',authorType:'role',authorId:'p4c',content:'正常评论'}]};return{ghost:_momentsCommentShouldWithdraw(m.comments[0],m),normal:_momentsCommentShouldWithdraw(m.comments[1],m),user:_momentsCommentShouldWithdraw({authorType:'user',content:'@p4z hi'},m)}})()");
    check('cmtw.judge', cmdShould && cmdShould.ghost === true && cmdShould.normal === false && cmdShould.user === false, JSON.stringify(cmdShould));
    const cmtw = await evaluate(cdp, "(async function(){var r=await createMoment({roleId:'p4v2',content:'一条评论区撤回测试动态。',visibility:'all'});var c1=await addMomentComment(r.moment.id,{authorType:'role',authorId:'p4b',content:'@p4z 在吗' });var c2=await addMomentComment(r.moment.id,{authorType:'role',authorId:'p4c',content:'这条没问题。'});var m=await getMoment(r.moment.id);var a=(m.comments||[]).find(function(x){return x.id===c1.comment.id});var b=(m.comments||[]).find(function(x){return x.id===c2.comment.id});return{g:a&&a.withdrawn,gText:a&&a.content,n:b&&b.withdrawn,nText:b&&b.content}})()");
    check('cmtw.rewriteToNotice', cmtw && cmtw.g === true && cmtw.gText.indexOf('撤回了一条评论') >= 0 && cmtw.n !== true && cmtw.nText === '这条没问题。', JSON.stringify(cmtw));
    /* 评论删除权限（v7.4）：楼主可删任何评论；角色动态下用户只能删自己的 */
    const delR = await evaluate(cdp, "(async function(){var mid=null;var um=await createMoment({authorType:'user',authorId:_activeUserId(),content:'楼主评论管理动态。',visibility:'all'});var rc=await addMomentComment(um.moment.id,{authorType:'role',authorId:'p4b',content:'楼主动态下的角色评论。'});var d1=await deleteMomentComment(um.moment.id,rc.comment.id);var rm=await createMoment({roleId:'p4v2',content:'角色动态评论权限。',visibility:'all'});var oc=await addMomentComment(rm.moment.id,{authorType:'role',authorId:'p4b',content:'角色动态下别人的评论。'});var d2=await deleteMomentComment(rm.moment.id,oc.comment.id);var uc=await addMomentComment(rm.moment.id,{authorType:'user',authorId:_activeUserId(),content:'角色动态下我自己的评论。'});var d3=await deleteMomentComment(rm.moment.id,uc.comment.id);return{ownerDeletesAny:d1&&d1.ok===true,notOwnerCantDelete:d2&&d2.ok===false&&/发布者/.test(d2.error),selfDeletesOwn:d3&&d3.ok===true}})()");
    check('cmtw.deletePermission', delR && delR.ownerDeletesAny === true && delR.notOwnerCantDelete === true && delR.selfDeletesOwn === true, JSON.stringify(delR));
    /* AI 楼主自主删评（v7.5）：动态作者角色可删自己动态下的"别人"评论（delComments），且只删别人 */
    const authorDel = await evaluate(cdp, `(async function(){
      var m=await createMoment({roleId:'p4v2',content:'AI 楼主删评动态。',visibility:'all'});
      var c1=await addMomentComment(m.moment.id,{authorType:'role',authorId:'p4b',content:'冒犯评论。'});
      var c2=await addMomentComment(m.moment.id,{authorType:'role',authorId:'p4c',content:'正常评论。'});
      var raw=JSON.stringify({publishReply:true,comment:'x',delComments:[c1.comment.id]});
      var d=await _momentsApplyDelComments(await getMoment(m.moment.id),m.moment.id,'p4v2',raw);
      var fresh=await getMoment(m.moment.id);
      var c1left=(fresh.comments||[]).some(function(x){return String(x.id)===String(c1.comment.id)});
      var c2left=(fresh.comments||[]).some(function(x){return String(x.id)===String(c2.comment.id)});
      return{d:d,c1left:c1left,c2left:c2left,authorCan:_momentsAuthorCanDelete(fresh,{id:'x',authorId:'p4b'},'p4v2'),nonAuthor:_momentsAuthorCanDelete(fresh,{id:'x',authorId:'p4b'},'p4a')};
    })()`);
    check('cmtw.authorDeletesOwnMomentOthers', authorDel && authorDel.d === true && authorDel.c1left === false && authorDel.c2left === true && authorDel.authorCan === true && authorDel.nonAuthor === false, JSON.stringify(authorDel));
    /* 聊天生图回传：gen_image 成功 → 回注队列 */
    const injE = await evaluate(cdp, "(async function(){var cfg=apiConfigs.find(function(a){return a.id==='p4a'});var before=(window._ibImageDrain||[]).length;var r=await _processWsResponse('<ws_gen_image prompt=\"一张测试照片\" size=\"1024x1024\"/>','测试',cfg);return{nCards:(r.cards||[]).length,queued:(window._ibImageDrain||[]).length-before}})()");
    check('inject.chatGenImageQueued', injE && injE.nCards >= 1 && injE.queued >= 1, JSON.stringify(injE));
    /* 工具回合续（v6）：生图执行 → 结果自动回喂模型再生成一轮（用户无需再说一句），且续轮携带图片 */
    const contBefore = (mock.chatByModel['p4-img'] || 0);
    const contRes = await evaluate(cdp, "(async function(){" +
      "var cfg=apiConfigs.find(function(a){return a.id==='p4a'});" +
      "await _processWsResponse('<ws_gen_image prompt=\"一张测试照片\" size=\"1024x1024\"/>','测试',cfg);" +/* 执行生图：feedback + _ibImageDrain 入队 */
      "var r=await _wsToolContinue(cfg,{messages:[{role:'user',content:'帮我生成一张测试图'}],lastReply:'好的，正在生成图片 <ws_gen_image prompt=\"一张测试照片\" size=\"1024x1024\"/>',friendId:'friend_x',round:1,senderName:'测试'});" +
      "return r?{ok:true,text:r.text,round:r.round}:{ok:false};})()");
    check('toolround.autoContinues', contRes && contRes.ok === true && contRes.round === 2 && (mock.chatToolRounds['p4-img'] || 0) >= 1 && (mock.chatByModel['p4-img'] || 0) === contBefore + 1, JSON.stringify(contRes) + ' rounds=' + (mock.chatToolRounds['p4-img'] || 0) + ' chats=' + (mock.chatByModel['p4-img'] || 0) + '/' + contBefore);
    check('toolround.continuesWithImage', (mock.chatImgParts['p4-img'] || 0) >= 1 && (mock.chatToolRounds['p4-img'] || 1) >= 1, 'imgParts=' + (mock.chatImgParts['p4-img'] || 0));
    /* 无工具反馈时不续轮（保持原有"等待用户下一条消息"行为） */
    const contNone = await evaluate(cdp, "(async function(){var r=await _wsToolContinue(apiConfigs.find(function(a){return a.id==='p4c'}),{messages:[{role:'user',content:'hi'}],lastReply:'好的，没问题。',friendId:'friend_x',round:1,senderName:'测试'});return r===null})()");
    check('toolround.noFeedSkips', contNone === true, String(contNone));
    /* 快照预算（已放宽）：companion 快照每条携带前 3 张 images + 保留 image 兼容字段；全局有界 */
    const snapCheck = await evaluate(cdp, "(async function(){" +
      "await createMoment({roleId:'p4b',content:'多图测试动态。',images:[{dataUrl:'data:image/jpeg;base64," + TINY_JPEG + "A',base64:'" + TINY_JPEG + "A',mime:'image/jpeg',name:'a.jpg'},{dataUrl:'data:image/jpeg;base64," + TINY_JPEG + "B',base64:'" + TINY_JPEG + "B',mime:'image/jpeg',name:'b.jpg'},{dataUrl:'data:image/jpeg;base64," + TINY_JPEG + "C',base64:'" + TINY_JPEG + "C',mime:'image/jpeg',name:'c.jpg'}],visibility:'all'});" +
      "var cb=apiConfigs.find(function(a){return a.id==='p4v2'});var s=await _momentsCompanionSnapshot(cb);var multi=(s.other_role_moments||[]).find(function(m){return m.content==='多图测试动态。'});return{multiImgs:multi?multi.images.length:0,firstIsImage:multi?multi.image===multi.images[0]:false,maxPerEntry:(s.other_role_moments||[]).reduce(function(v,m){return Math.max(v,(m.images||[]).length)},0)}})()");
    check('snap.budgetRelaxedMultiImage', snapCheck && snapCheck.multiImgs === 3 && snapCheck.firstIsImage === true && snapCheck.maxPerEntry <= 3, JSON.stringify(snapCheck));

    /* ══ 降级：companion 事件携带 want_image 但图片 Provider 未开启 / 报错 → 纯文字 Moment 照常发布 ══ */
    const imgHitsBeforeDeg = mock.imageHits.length;
    const dg = await evaluate(cdp, "(async function(){" +
      "var evG={id:'event_mom_p4g2',kind:'moment',moment:{id:'mom_p4g2_comp',roleId:'p4g',content:'图片未开启时的后台动态。',images:[],visibility:'all',visibleRoleIds:[],likes:[],comments:[],source:'proactive',createdAt:new Date().toISOString()},next_at:Date.now()+3600000,last_post_at:Date.now(),sent_at:Date.now(),want_image:true,image_prompt:'A moon over the sea'};" +
      "var evD={id:'event_mom_p4d2',kind:'moment',moment:{id:'mom_p4d2_comp',roleId:'p4d',content:'后台发的一条动态，配图失败没关系。',images:[],visibility:'all',visibleRoleIds:[],likes:[],comments:[],source:'proactive',createdAt:new Date().toISOString()},next_at:Date.now()+3600000,last_post_at:Date.now(),sent_at:Date.now(),want_image:true,image_prompt:'A tiny shop at night'};" +
      "var a=await _momentsIngestEvent(evG,_activeUserId());var b=await _momentsIngestEvent(evD,_activeUserId());var mg=await getMoment('mom_p4g2_comp');var md=await getMoment('mom_p4d2_comp');" +
      "return{a:a,b:b,mg:mg&&{content:mg.content,images:mg.images.length},md:md&&{content:md.content,images:md.images.length}}})()");
    check('degrade.imageDisabledKeepsText', dg && dg.a === true && dg.mg && dg.mg.images === 0 && dg.mg.content === '图片未开启时的后台动态。', JSON.stringify(dg));
    check('degrade.imageErrorKeepsText', dg && dg.b === true && dg.md && dg.md.images === 0 && dg.md.content === '后台发的一条动态，配图失败没关系。', JSON.stringify(dg));
    check('degrade.attemptedOnlyWhenEnabled', mock.imageHits.length === imgHitsBeforeDeg + 1, 'imgHits=' + mock.imageHits.length + ' before=' + imgHitsBeforeDeg);

    /* ══ Prompt 契约：包含 wantImage/imagePrompt 引导；正文与提示词无内部机制词泄漏 ══ */
    const p4prompt = await evaluate(cdp, "(function(){var b=buildMomentPrompt({character:{id:'x',nickname:'N',systemPrompt:''},context:{},trigger:'schedule'});return{u:b.messages[1].content,s:b.messages[0].content}})()");
    check('J.promptHasImageJudgement', /wantImage/.test(p4prompt.u) && /imagePrompt/.test(p4prompt.u) && /不会自然想配一张照片|自然适合配一张图/.test(p4prompt.u) && /不要为了配图而配图/.test(p4prompt.u), p4prompt.u.slice(-320));
    check('J.promptNoInternalMechanismWords', !/任务|定时|调度|API|模型|prompt|scheduler|timer|task|cron|autonomous|token/i.test((p4prompt.u + '\n' + p4prompt.s).replace(/imagePrompt/g, '')), (p4prompt.s + '\n' + p4prompt.u).slice(0, 400));
    /* 解析契约：wantImage 归一 + 旧字段 includeImage 兼容 + publish:false 无图片意图 */
    const pmtx = await evaluate(cdp, "(function(){var P=_momentsParseOutput;var r1=P(JSON.stringify({publish:true,content:'x',wantImage:true,imagePrompt:'desc'}));var r2=P(JSON.stringify({publish:true,content:'y',includeImage:true,imagePrompt:'desc'}));var r3=P(JSON.stringify({publish:false,reason:'z',wantImage:true}));return{a:r1&&r1.wantImage===true&&r1.imagePrompt==='desc',b:r2&&r2.wantImage===true,c:r3&&r3.publish===false&&r3.wantImage===undefined}})()");
    check('parse.wantImageNormalized', pmtx && pmtx.a === true && pmtx.b === true && pmtx.c === true, JSON.stringify(pmtx));

    await new Promise(r => setTimeout(r, 300));
    check('runtime.noExceptions', exceptions.length === 0, exceptions.join('\n').slice(0, 500));
    console.log(failures ? '\nMoments Phase4 smoke failed: ' + failures : '\nMoments Phase4 smoke test passed ✔');
  } finally {
    if (cdp) cdp.close(); try { browser.kill(); } catch (error) {}
    await new Promise(r => mock.server.close(r));
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (error) {}
  }
  if (failures) process.exitCode = 1;
}

main().catch(error => { console.error(error && error.stack || error); process.exitCode = 1; });
