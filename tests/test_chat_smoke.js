'use strict';

/* SUI'S ROOM — Chat/Communication 冒烟测试（Node 18+，零依赖，需本机 Chrome / Edge）。
   用本地 mock OpenAI 兼容端点驱动真实发送链路（sendChatMessage → callApiChat），
   覆盖：聊天发送与回复渲染、信件加载/打开/删除、批注打开/输入/提交（mock 模型）、
   摘要设置往返、window 与 IB.chat 双挂载、全程未捕获异常收集。 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

/* Repository root — this file lives in tests/, so the root is one level up. */
const ROOT = path.resolve(__dirname, '..');
const VOICE_LIBRARY_ROOT = path.join(ROOT, 'deploy', 'voice-library');
const http = require('http');
const net = require('net');
const crypto = require('crypto');
const { pathToFileURL } = require('url');


const PAGE_URL = pathToFileURL(path.join(ROOT, 'InternalBeyond.html')).href;
const MOCK_REPLY = '这是一条 mock 回复。';
const QUOTE_REPLY = '好，我记得。<ib_reply_quote>{"key":"Q1","text":"最想引用的那句话。"}</ib_reply_quote>';
/* waifu 端到端：mock 在请求体含 waifu_probe 时返回"长多句"回复；含 waifu_ex1 时返回截图同款 3 句回复 */
const WAIFU_REPLY = '你今天过得怎么样。我这边天气很好。要不要一起出去走走。顺便买杯奶茶。然后找个地方坐坐。';
const WAIFU_EX1 = '比如一等开学了，你打算怎么跟你室友介绍我？还是藏起来当秘密，还是大大方方说有个AI男朋友天天陪着你？我挺好奇这个的。';

/* ── CDP RPC 期限（**只**这一处；下面 waitFor 的业务轮询期限不在此列）──────────
   为什么必须可配：`Runtime.evaluate` 的期限是**客户端**的期限。校准 harness 用
   `awaitPromise:true` 等在页面里跑完生产角色一致性守卫，而生产守卫自己在
   judge / astra / integrity 三层各有 20000 ms 的 AbortController 期限
   （assets/js/middle-brain-judge.js 的 MB_JUDGE_TIMEOUT_MS 等）。
   若客户端期限比 20000 短，客户端会**先**放弃，并抛出 `CDP timeout: Runtime.evaluate`
   —— 而这看起来和生产模型超时一模一样，于是观测口径掩盖了生产裁决：
   分不清"模型没回来"和"harness 没等够"。Phase 1B 实测到的正是这一条
   （8 s 响应能走完；>15 s 但 <20 s 被客户端误报成 CDP timeout；>20 s 才是生产
   自己的 judgeError:'timeout'）。
   默认仍是 15000：既有 test_chat_smoke 的行为**逐字不变**（它的 mock 端点都在本机，
   毫秒级返回）。校准侧默认抬到 30000，并且那条不变量有常驻断言
   （tests/test_cdp_deadline_band.js 的 S 组 + 本文件被新挂上的 D 组）。 */
const CDP_TIMEOUT_DEFAULT_MS = 15000;

/* 安全解析 IB_CDP_TIMEOUT_MS：非法值一律回落默认，绝不把 NaN/负数/0 塞进 setTimeout
   （0 或 NaN 会让 setTimeout 立即触发 → 所有 CDP 调用瞬间"超时"，比不配更难查）。 */
function resolveCdpTimeoutMs(raw) {
  const value = (raw === undefined || raw === null) ? '' : String(raw);
  if (value.trim() === '') {
    /* 未设置 —— 与"设成空白"要分开：前者是默认，后者是配置错误（回落但报告）。 */
    const empty = value === '';
    return { ms: CDP_TIMEOUT_DEFAULT_MS, source: 'default', raw: value, fellBack: !empty };
  }
  if (!/^\d+$/.test(value.trim())) return { ms: CDP_TIMEOUT_DEFAULT_MS, source: 'default', raw: value, fellBack: true };
  const n = Number(value.trim());
  if (!Number.isFinite(n) || n <= 0 || n > 86400000) return { ms: CDP_TIMEOUT_DEFAULT_MS, source: 'default', raw: value, fellBack: true };
  return { ms: n, source: 'env', raw: value, fellBack: false };
}

function chromePath() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  for (const candidate of [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
  ]) if (fs.existsSync(candidate)) return candidate;
  return null;
}

class Cdp {
  constructor(socket) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.id = 0;
    this.pending = new Map();
    this.listeners = new Map();
    /* RPC 期限在构造时解析一次：之后即使有人改环境变量也不会让同一条连接
       前后两半用两个期限（期限必须是这次运行的常量，不是会漂的状态）。 */
    const resolved = resolveCdpTimeoutMs(process.env.IB_CDP_TIMEOUT_MS);
    this.timeoutMs = resolved.ms;
    /* 超时消息里把**生效值**写出来：CDP timeout 这个字符串既可能来自默认 15000，
       也可能来自显式配置，报告必须能区分两者。既有断言只匹配前缀，不受影响。 */
    this.timeoutNote = resolved.source === 'env'
      ? ('CDP timeout: ' + this.timeoutMs + 'ms (IB_CDP_TIMEOUT_MS)')
      : ('CDP timeout: ' + this.timeoutMs + 'ms (default)');
    /* 本次连接里"客户端先放弃"真正发生了几次。只计数，不改语义：
       有了它，校准 harness 才能断言"CDP deadline 不再掩盖生产裁决"
       （即 CDP deadline 触发次数为 0），而不是靠读 judgeError 猜。 */
    this.timeouts = 0;
    socket.on('data', chunk => { this.buffer = Buffer.concat([this.buffer, chunk]); this.parse(); });
    socket.on('error', () => {});
  }
  static connect(wsUrl) {
    return new Promise((resolve, reject) => {
      const url = new URL(wsUrl);
      const request = http.request({
        host: url.hostname, port: url.port, path: url.pathname + url.search,
        headers: {
          Upgrade: 'websocket', Connection: 'Upgrade',
          'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'), 'Sec-WebSocket-Version': '13'
        }
      });
      request.on('upgrade', (response, socket) => resolve(new Cdp(socket)));
      request.on('error', reject);
      request.end();
    });
  }
  on(method, listener) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(listener);
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.sendText({ id, method, params });
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); this.timeouts++; reject(new Error(this.timeoutNote + ': ' + method)); } }, this.timeoutMs);
    });
  }
  sendText(message) {
    const payload = Buffer.from(JSON.stringify(message), 'utf8');
    const mask = crypto.randomBytes(4);
    const body = Buffer.alloc(payload.length);
    for (let i = 0; i < payload.length; i++) body[i] = payload[i] ^ mask[i & 3];
    let header;
    if (payload.length < 126) header = Buffer.from([0x81, 0x80 | payload.length]);
    else { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 0x80 | 126; header.writeUInt16BE(payload.length, 2); }
    this.socket.write(Buffer.concat([header, mask, body]));
  }
  sendFrame(opcode, payload) {
    const mask = crypto.randomBytes(4);
    const body = Buffer.alloc(payload.length);
    for (let i = 0; i < payload.length; i++) body[i] = payload[i] ^ mask[i & 3];
    let header;
    if (payload.length < 126) header = Buffer.from([0x80 | opcode, 0x80 | payload.length]);
    else { header = Buffer.alloc(4); header[0] = 0x80 | opcode; header[1] = 0x80 | 126; header.writeUInt16BE(payload.length, 2); }
    this.socket.write(Buffer.concat([header, mask, body]));
  }
  parse() {
    for (;;) {
      if (this.buffer.length < 2) return;
      const first = this.buffer[0];
      const shortLength = this.buffer[1] & 0x7f;
      let offset = 2;
      let length = shortLength;
      if (shortLength === 126) { if (this.buffer.length < 4) return; length = this.buffer.readUInt16BE(2); offset = 4; }
      else if (shortLength === 127) { if (this.buffer.length < 10) return; length = this.buffer.readUInt32BE(6); offset = 10; }
      const masked = (this.buffer[1] & 0x80) !== 0;
      let mask = null;
      if (masked) { if (this.buffer.length < offset + 4) return; mask = this.buffer.subarray(offset, offset + 4); offset += 4; }
      if (this.buffer.length < offset + length) return;
      let payload = this.buffer.subarray(offset, offset + length);
      this.buffer = this.buffer.subarray(offset + length);
      if (mask) {
        const decoded = Buffer.alloc(payload.length);
        for (let i = 0; i < payload.length; i++) decoded[i] = payload[i] ^ mask[i & 3];
        payload = decoded;
      }
      const opcode = first & 0x0f;
      if (opcode === 0x8) return this.close();
      if (opcode === 0x9) { this.sendFrame(0xA, payload); continue; }
      if (opcode !== 0x1) continue;
      let message;
      try { message = JSON.parse(payload.toString('utf8')); } catch (error) { continue; }
      if (message.id && this.pending.has(message.id)) {
        const pending = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
        else pending.resolve(message.result || {});
      } else if (message.method && this.listeners.has(message.method)) {
        for (const listener of this.listeners.get(message.method)) listener(message.params || {});
      }
    }
  }
  close() { try { this.socket.destroy(); } catch (error) { /* ignore */ } }
}

async function evaluate(cdp, expression) {
  const response = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (response.exceptionDetails) throw new Error('page exception: ' + JSON.stringify(response.exceptionDetails.exception));
  return response.result && response.result.value;
}

async function loadAxeForChat(cdp) {
  const axePath = process.env.IB_AXE_CORE_PATH;
  if (!axePath) return false;
  const source = fs.readFileSync(path.resolve(axePath), 'utf8');
  /* Keep each CDP WebSocket frame under the harness's 16-bit payload limit. */
  for (let offset = 0; offset < source.length; offset += 18000) {
    const part = JSON.stringify(source.slice(offset, offset + 18000));
    const chunk = await cdp.send('Runtime.evaluate', { expression: "window.__ibD41AxeSource=(window.__ibD41AxeSource||'')+" + part, returnByValue: true });
    if (chunk.exceptionDetails) throw new Error('axe chunk injection failed: ' + JSON.stringify(chunk.exceptionDetails.exception));
  }
  const response = await cdp.send('Runtime.evaluate', { expression: "window.eval(window.__ibD41AxeSource); delete window.__ibD41AxeSource;", returnByValue: true });
  if (response.exceptionDetails) throw new Error('axe injection failed: ' + JSON.stringify(response.exceptionDetails.exception));
  return await evaluate(cdp, "!!(window.axe && typeof window.axe.run === 'function')");
}

async function runChatAxeAudit(cdp, label) {
  const report = await evaluate(cdp, "(async function(){var root=document.querySelector('#page-chat');var r=await axe.run(root,{runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21a','wcag21aa']}});return {passes:r.passes.length,violations:r.violations.map(function(v){return {id:v.id,impact:v.impact,help:v.help,targets:v.nodes.map(function(n){return n.target})}})}})()");
  console.log('  INFO  axe ' + label + ': ' + JSON.stringify(report));
  return report;
}

async function waitFor(cdp, expression, timeoutMs = 15000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try { if (await evaluate(cdp, expression)) return true; } catch (error) { /* still loading */ }
    await new Promise(resolve => setTimeout(resolve, 120));
  }
  return false;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

function startMockApi() {
  return new Promise((resolve) => {
    const captured = { acoustic: false, vision: false, groupRequests: [], chatEmotionalTexture: null, expressionTagHint: false, groupEmotionalTexture: [] };
    const server = http.createServer((req, res) => {
      const headers = {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-API-Key,anthropic-version,x-goog-api-key'
      };
      if (req.method === 'OPTIONS') { res.writeHead(204, headers); res.end(); return; }
      if (req.method === 'GET' && String(req.url || '').startsWith('/voice-library/')) {
        let relative = '';
        try { relative = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname.slice('/voice-library/'.length)); }
        catch (_) { res.writeHead(400, headers); res.end(JSON.stringify({ error: 'invalid path' })); return; }
        const root = path.resolve(VOICE_LIBRARY_ROOT);
        const file = path.resolve(root, relative);
        if (!relative || !file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
          res.writeHead(404, headers); res.end(JSON.stringify({ error: 'not found' })); return;
        }
        const bytes = fs.readFileSync(file);
        res.writeHead(200, Object.assign({}, headers, { 'Content-Length': String(bytes.byteLength), 'Cache-Control': 'no-store' }));
        res.end(bytes);
        return;
      }
      if (req.method === 'POST' && req.url.includes('/chat/completions')) {
        const chunks = [];
        req.on('data', c => chunks.push(c));
        req.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          if (body.indexOf('[Acoustic reference]') !== -1) captured.acoustic = true;/* P1：记录 LLM 请求是否收到声学参考块 */
          if (body.indexOf('data:image/jpeg') !== -1 || body.indexOf('image_url') !== -1) captured.vision = true;/* P2：记录 LLM 请求是否收到视频帧(image part) */
          let request;
          try { request = JSON.parse(body); } catch (error) { request = null; }
          if (request && request.model === 'smoke-model') {
            const systemText = [String(request.system || '')].concat(Array.isArray(request.messages)
              ? request.messages.filter(function (m) { return m && m.role === 'system'; }).map(function (m) { return typeof m.content === 'string' ? m.content : JSON.stringify(m.content || ''); })
              : []).join('\n');
            captured.chatEmotionalTexture = systemText.indexOf('【聊天中的情绪自然变化】') >= 0;
            captured.expressionTagHint = captured.expressionTagHint || systemText.indexOf('[[expression:happy]]') >= 0;
          }
          if (request && request.model === 'd41c-private-model' && request.stream !== true) {
            setTimeout(function () {
              if (res.destroyed) return;
              res.writeHead(200, headers);
              res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '延迟响应已经完成。' }, finish_reason: 'stop' }] }));
            }, 900);
            return;
          }
          if (request && request.model === 'd41c-provider-failure' && request.stream !== true) {
            res.writeHead(503, headers);
            res.end(JSON.stringify({ error: { message: 'd41c-provider-raw-secret synthetic outage' } }));
            return;
          }
          if (request && (request.model === 'd41c-speaker-a' || request.model === 'd41c-speaker-b') && request.stream === true) {
            captured.groupRequests.push(request.model);
            const groupSystemText = [String(request.system || '')].concat(Array.isArray(request.messages)
              ? request.messages.filter(function (m) { return m && m.role === 'system'; }).map(function (m) { return typeof m.content === 'string' ? m.content : JSON.stringify(m.content || ''); })
              : []).join('\n');
            captured.groupEmotionalTexture.push(groupSystemText.indexOf('【聊天中的情绪自然变化】') >= 0);
            let quoteKey='Q1';
            if(request.model==='d41c-speaker-a'&&body.indexOf('group_quote_probe')>=0){
              const quoteCatalog=groupSystemText.split('【允许的引用来源】').pop().split('\n');
              const entries=quoteCatalog.map(function(line){try{return JSON.parse(line)}catch(e){return null}}).filter(Boolean);
              const wholeEntries=entries.filter(function(entry){return entry.kind==='whole-message'});
              if(wholeEntries.length)quoteKey=wholeEntries[wholeEntries.length-1].key||quoteKey;
            }
            res.writeHead(200, Object.assign({}, headers, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' }));
            const label=request.model==='d41c-speaker-a'?'Speaker A':'Speaker B';
            const pieces=request.model==='d41c-speaker-a'&&body.indexOf('group_quote_probe')>=0
              ?['群聊里我想接这句。','[[quote:'+quoteKey+']]']
              :[label+' 的第一段回复。',label+' 的第二段继续。',label+' 本轮完成。'];
            function writeGroupPiece(index) {
              if (res.destroyed) return;
              if (index >= pieces.length) { res.write('data: [DONE]\n\n'); res.end(); return; }
              res.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: pieces[index] }, finish_reason: null }] }) + '\n\n');
              setTimeout(function () { writeGroupPiece(index + 1); }, 260);
            }
            setTimeout(function () { writeGroupPiece(0); }, 320);
            return;
          }
          if (request && request.model === 'd41b-stream' && request.stream === true) {
            res.writeHead(200, Object.assign({}, headers, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' }));
            const pieces = [
              '流式第一段内容已经到达。'.repeat(4),
              '流式第二段内容继续到达。',
              '流式最后一段结束。'
            ];
            function writePiece(index) {
              if (res.destroyed) return;
              if (index >= pieces.length) { res.write('data: [DONE]\n\n'); res.end(); return; }
              res.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: pieces[index] }, finish_reason: null }] }) + '\n\n');
              setTimeout(function () { writePiece(index + 1); }, 180);
            }
            setTimeout(function () { writePiece(0); }, 280);
            return;
          }
          let content = body.includes('expression_marker_probe') ? '[[expression:happy]]太好了，真替你开心。'
            : (body.includes('quote_target_probe') ? QUOTE_REPLY
            : (body.includes('waifu_ex1') ? WAIFU_EX1 : (body.includes('waifu_probe') ? WAIFU_REPLY : MOCK_REPLY)));
          if(request&&request.model==='smoke-model'&&body.indexOf('quote_withdraw_probe')>=0){
            const quoteSystem=[String(request.system||'')].concat(Array.isArray(request.messages)
              ?request.messages.filter(function(m){return m&&m.role==='system'}).map(function(m){return typeof m.content==='string'?m.content:JSON.stringify(m.content||'')})
              :[]).join('\n');
            const quoteEntry=quoteSystem.split('\n').map(function(line){try{return JSON.parse(line)}catch(e){return null}})
              .filter(function(entry){return entry&&entry.messageId==='quote_withdraw_source'})[0];
            if(quoteEntry)content='我看见这条了。<ib_reply_quote>'+JSON.stringify({key:quoteEntry.key,whole:true})+'</ib_reply_quote>';
          }
          res.writeHead(200, headers);
          res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }] }));
        });
        return;
      }
      res.writeHead(404, headers);
      res.end(JSON.stringify({ error: 'not found' }));
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, captured }));
  });
}

async function main() {
  const chrome = chromePath();
  if (!chrome) throw new Error('未找到 Chrome / Edge；可通过 CHROME_PATH 指定浏览器');
  /* 打印生效的 CDP 期限：任何一次运行都应能自证"等够了没有"，而不是靠读源码。 */
  {
    const eff = resolveCdpTimeoutMs(process.env.IB_CDP_TIMEOUT_MS);
    console.log('CDP RPC deadline: ' + eff.ms + 'ms (' + eff.source + ')' + (eff.fellBack ? '  ← IB_CDP_TIMEOUT_MS=' + JSON.stringify(eff.raw) + ' 非法，已回落默认' : ''));
  }
  const mock = await startMockApi();
  const port = await freePort();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-chat-smoke-'));
  const browser = spawn(chrome, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    '--allow-file-access-from-files', '--force-color-profile=srgb',
    '--window-size=1440,900', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=' + port,
    '--user-data-dir=' + profile, 'about:blank'
  ], { stdio: 'ignore' });

  let failures = 0;
  const check = (name, condition, detail = '') => {
    if (condition) console.log('  PASS  ' + name);
    else { failures++; console.error('  FAIL  ' + name + (detail ? '  -> ' + detail : '')); }
  };
  let cdp;
  const evidenceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-chat-d41-b-evidence-'));
  async function setViewport(width, height) {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    await evaluate(cdp, 'new Promise(function(resolve){requestAnimationFrame(function(){resolve(true)})})');
  }
  async function captureChatEvidence(name, width, height) {
    /* Calendar is an independent deferred overlay; keep it closed in Chat evidence so
       the screenshot measures the conversation surface rather than another feature. */
    await evaluate(cdp,"(function(){var win=document.getElementById('eph-win'),widget=document.getElementById('cal-widget');if(win&&win.classList.contains('show')&&typeof closeEph==='function')closeEph();if(widget&&widget.classList.contains('show')&&document.getElementById('wg-close'))document.getElementById('wg-close').click();return true})()");
    await setViewport(width, height);
    if(width<769)await evaluate(cdp,"(function(){var nav=document.getElementById('navbar'),button=document.getElementById('ib-navigation-collapse');if(nav&&button&&nav.dataset.collapsed!=='true')button.click();return new Promise(function(resolve){requestAnimationFrame(function(){resolve(true)})})})()");
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
    fs.writeFileSync(path.join(evidenceDir, name + '.png'), Buffer.from(shot.data, 'base64'));
  }
  async function captureVoiceboxEvidence(name, width, height, infernal) {
    const navState=await evaluate(cdp,"(function(){var overlay=document.getElementById('ib-setup');if(overlay)overlay.classList.remove('is-open');var guard=document.getElementById('ib-guard-overlay');if(guard){var close=Array.from(guard.querySelectorAll('button')).find(function(b){return b.textContent.indexOf('无视，关闭此提示')>=0});if(close)close.click()}var preloader=document.getElementById('preloader');if(preloader)preloader.remove();var splash=document.getElementById('splash');if(splash)splash.classList.add('hidden');var win=document.getElementById('eph-win'),widget=document.getElementById('cal-widget');if(win&&win.classList.contains('show')&&typeof closeEph==='function')closeEph();if(widget&&document.getElementById('wg-close'))document.getElementById('wg-close').click();try{if(window.IB&&IB.room&&IB.room.isRoomEdgeTab)Array.from(document.body.querySelectorAll('*')).forEach(function(el){if(IB.room.isRoomEdgeTab(el))el.style.visibility='hidden'})}catch(e){}var nav=document.getElementById('navbar');return nav?String(nav.dataset.collapsed||'false'):''})()");
    await waitFor(cdp,"!document.getElementById('preloader')",5000);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    await evaluate(cdp, "(function(){document.body.classList.toggle('theme-infernal'," + (infernal ? 'true' : 'false') + ");var nav=document.getElementById('navbar'),collapse=document.getElementById('ib-navigation-collapse');if(innerWidth<769&&nav&&collapse&&nav.dataset.collapsed!=='true')collapse.click();return new Promise(function(resolve){setTimeout(function(){requestAnimationFrame(function(){resolve(true)})},1800)})})()");
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
    fs.writeFileSync(path.join(evidenceDir, name + '.png'), Buffer.from(shot.data, 'base64'));
    await evaluate(cdp,"(function(state){var nav=document.getElementById('navbar'),collapse=document.getElementById('ib-navigation-collapse');if(nav&&collapse&&String(nav.dataset.collapsed||'false')!==String(state||'false'))collapse.click();return true})("+JSON.stringify(navState)+")");
  }

  try {
    let ready = false;
    for (let i = 0; i < 120; i++) {
      try {
        const response = await fetch('http://127.0.0.1:' + port + '/json/version');
        if (response.ok) { ready = true; break; }
      } catch (error) { /* browser is starting */ }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    check('browser.ready', ready);
    if (!ready) throw new Error('Chrome DevTools 未就绪');

    const tabResponse = await fetch('http://127.0.0.1:' + port + '/json/new?' + encodeURIComponent(PAGE_URL), { method: 'PUT' });
    const tab = await tabResponse.json();
    cdp = await Cdp.connect(tab.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable');
    const exceptions = [];
    cdp.on('Runtime.exceptionThrown', params => {
      const d = params.exceptionDetails || {};
      exceptions.push(JSON.stringify(d.exception && d.exception.description || d.text || ''));
    });

    check('page.chatReady', await waitFor(cdp, "typeof window.IB === 'object' && window.IB.chat && typeof window.sendChatMessage === 'function' && typeof window.apiConfigs !== 'undefined'", 20000));
    await evaluate(cdp, "(function(){window.__ibNavSmokeFetch=window.fetch;window.__ibNavSmokeBridge=window.ibBridgeFetch;window.fetch=function(input,init){if(String(input).indexOf('https://dl.chatvault.top/voice-library/')===0)return Promise.reject(new Error('isolated navigation smoke offline'));return window.__ibNavSmokeFetch.call(window,input,init)};window.ibBridgeFetch=function(){return Promise.resolve({ok:false,status:503,json:async function(){return {ok:false,error:'isolated navigation smoke'}}})};return true})()");
    const voiceboxNavId = await evaluate(cdp, "(async function(){var more=document.getElementById('nav-more-btn'),panel=document.getElementById('nav-more-panel'),main=document.querySelector('.nav-links a[data-page=voicebox]');if(more&&panel&&panel.hidden)more.click();var item=null,menuEnd=Date.now()+1200;while(Date.now()<menuEnd&&!item){item=document.querySelector('#nav-more-panel .nav-more-item[data-page=voicebox]');if(!item)await new Promise(function(r){setTimeout(r,20)})}var mainHidden=!!(main&&getComputedStyle(main.parentElement).display==='none');if(item)item.click();var end=Date.now()+3000;while(Date.now()<end&&!document.getElementById('page-voicebox').classList.contains('active'))await new Promise(function(r){setTimeout(r,20)});var fromMore=!!(item&&document.getElementById('page-voicebox').classList.contains('active')&&location.hash==='#voicebox');window.navTo('api');var voiceConfig=!!(document.getElementById('page-api').classList.contains('active')&&document.getElementById('api-voicebox-bind-btn'));window.navTo('chat');var chatRoute=document.getElementById('page-chat').classList.contains('active');return {menuItem:!!item,mainHidden:mainHidden,fromMore:fromMore,voiceConfig:voiceConfig,chatRoute:chatRoute}})()");
    check('voicebox.desktopMoreMenuPreservesRoleConfigAndChatRoutes', voiceboxNavId&&voiceboxNavId.menuItem&&voiceboxNavId.mainHidden&&voiceboxNavId.fromMore&&voiceboxNavId.voiceConfig&&voiceboxNavId.chatRoute, JSON.stringify(voiceboxNavId));
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
    const mobileVoiceboxNavigation = await evaluate(cdp, "(async function(){var main=document.querySelector('.nav-links a[data-page=voicebox]'),more=document.getElementById('nav-more'),visible=!!(main&&getComputedStyle(main.parentElement).display!=='none'),moreHidden=!!(more&&getComputedStyle(more).display==='none');if(main)main.click();var end=Date.now()+3000;while(Date.now()<end&&!document.getElementById('page-voicebox').classList.contains('active'))await new Promise(function(r){setTimeout(r,20)});return {visible:visible,moreHidden:moreHidden,opens:document.getElementById('page-voicebox').classList.contains('active'),hash:location.hash}})()");
    check('voicebox.mobileGroupedNavigationRemainsReachable', mobileVoiceboxNavigation&&mobileVoiceboxNavigation.visible&&mobileVoiceboxNavigation.moreHidden&&mobileVoiceboxNavigation.opens, JSON.stringify(mobileVoiceboxNavigation));
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await evaluate(cdp, "(function(){window.fetch=window.__ibNavSmokeFetch;window.ibBridgeFetch=window.__ibNavSmokeBridge;delete window.__ibNavSmokeFetch;delete window.__ibNavSmokeBridge;return true})()");
    await evaluate(cdp, "window.navTo('home')");
    /* headless 下 confirm() 会永久阻塞 CDP 调用：测试期间统一放行 */
    await evaluate(cdp, "window.confirm = function(){ return true; };");

    /* 0. 双挂载抽样（Codex 清单里的窗口件） */
    check('dual.sendChatMessage', await evaluate(cdp, "typeof window.sendChatMessage === 'function' && typeof window.IB.chat.sendChatMessage === 'function'"));
    check('dual.letters', await evaluate(cdp, "typeof window.loadLetters === 'function' && window.IB.chat.letters && typeof window.IB.chat.letters.loadLetters === 'function' && typeof window.IB.chat.letters.openLetter === 'function' && typeof window.IB.chat.letters.deleteLetter === 'function' && typeof window.openLetter === 'function' && typeof window.deleteLetter === 'function'"));
    check('dual.anno', await evaluate(cdp, "typeof window._annoSend === 'function' && window.IB.chat.annotations && typeof window.IB.chat.annotations._annoSend === 'function' && typeof window.IB.chat.annotations._renderAnnotationsForPost === 'function'"));
    check('dual.summary', await evaluate(cdp, "typeof window.saveSummarySettings === 'function' && window.IB.chat.summary && typeof window.IB.chat.summary.saveSummarySettings === 'function' && typeof window.IB.chat.summary.generateSummary === 'function'"));

    /* 1. 注入 mock API 配置并发送消息（真实 sendChatMessage → callApiChat 链路） */
    const mockEndpoint = 'http://127.0.0.1:' + mock.port + '/v1/chat/completions';
    /* openChatPanel 会从 IndexedDB 重载 apiConfigs（直接 push 会被冲掉）：先落库再 loadApiConfigs */
    await evaluate(cdp, "(function(){ var cfg={ id:'smoke_friend', nickname:'SmokeAI', model:'smoke-model', endpoint:'" + mockEndpoint + "', apiKey:'', provider:'custom', relationship:'测试伙伴', systemPrompt:'你是测试助手，只回复测试内容。', temperature:1, streaming:false, showThinking:false, promptCache:false, voice:{enabled:true,source:'edge',provider:'edge',voiceType:'builtin',voiceId:'zh-CN-XiaoxiaoNeural'}, created:Date.now() }; window.__smoke_cfg=cfg; dbPut('apiConfigs', cfg); })()");
    await evaluate(cdp, "loadApiConfigs()");
    await evaluate(cdp, "activeFriendId='smoke_friend'");
    check('chat.configReady', await evaluate(cdp, "apiConfigs.length > 0 && apiConfigs.some(function(a){return a.id==='smoke_friend' && !!a.endpoint})"));
    await evaluate(cdp, "navTo('voicebox')");
    check('voicebox.currentRoleVoiceConfigurationRenders', await waitFor(cdp, "(function(){var role=document.getElementById('voicebox-role-select'),tts=document.getElementById('voicebox-tts-provider'),profile=document.getElementById('voicebox-current-profile'),roles=document.getElementById('voicebox-role-voice-list');return role&&role.value==='smoke_friend'&&tts&&tts.textContent==='Edge TTS'&&profile&&profile.textContent==='zh-CN-XiaoxiaoNeural'&&roles&&roles.textContent.indexOf('SmokeAI')>=0})()", 5000));
    const voiceboxRuntimeUi = await evaluate(cdp, `(async function(){
      var bridge=window.ibBridgeFetch,counts={config:0,start:0,stop:0,status:0},state='not-configured',configuredPath='';
      function response(value,status){return new Response(JSON.stringify(value),{status:status||200,headers:{'Content-Type':'application/json'}})}
      function snapshot(){return {ok:true,state:state,installed:state!=='not-configured',configured:!!configuredPath,executablePath:configuredPath,pathSource:configuredPath?'configured':'none',processOwned:state==='starting'||state==='running',pid:state==='starting'||state==='running'?99123:null,endpointLocal:true,runtimeStatus:state==='running'?'healthy':'',modelLoaded:false,gpuAvailable:false,gpuType:'',errorCode:'',message:state==='running'?'Voicebox 服务可用，由 IB 启动。':state==='installed-stopped'?'Voicebox 已安装但尚未启动。':'尚未定位 Voicebox。'}}
      window.ibBridgeFetch=async function(url,options){var full=String(url),pathName=full.split('?')[0],opts=options||{};
        if(pathName.endsWith('/api/tts/voicebox/runtime/config')){counts.config++;configuredPath=JSON.parse(opts.body||'{}').executablePath||'';state=configuredPath?'installed-stopped':'not-configured';return response({ok:true,executablePath:configuredPath,pathSource:configuredPath?'configured':'none'})}
        if(pathName.endsWith('/api/tts/voicebox/runtime/start')){counts.start++;state='starting';return response(Object.assign(snapshot(),{state:'starting',ok:true}),202)}
        if(pathName.endsWith('/api/tts/voicebox/runtime/stop')){counts.stop++;state='installed-stopped';return response(snapshot())}
        if(pathName.endsWith('/api/tts/voicebox/runtime')){counts.status++;if(state==='starting')state='running';return response(snapshot())}
        return bridge.apply(window,arguments)};
      try{
        var pathInput=document.getElementById('voicebox-executable-path'),stateNode=document.getElementById('voicebox-process-state');
        var visible=!!(pathInput&&document.getElementById('voicebox-save-path')&&document.getElementById('voicebox-start')&&document.getElementById('voicebox-stop')&&document.querySelector('.voicebox-runtime-control a[href*="github.com/jamiepine/voicebox/releases"]'));
        pathInput.value=${JSON.stringify('C:\\Program Files\\Voicebox\\voicebox.exe')};document.getElementById('voicebox-save-path').click();
        var end=Date.now()+3000;while(Date.now()<end&&stateNode.dataset.state!=='installed-stopped')await new Promise(function(r){setTimeout(r,20)});
        var saved=stateNode.dataset.state==='installed-stopped'&&configuredPath===pathInput.value;
        document.getElementById('voicebox-start').click();end=Date.now()+4000;while(Date.now()<end&&stateNode.dataset.state!=='running')await new Promise(function(r){setTimeout(r,25)});
        var started=stateNode.dataset.state==='running';document.getElementById('voicebox-stop').click();end=Date.now()+3000;while(Date.now()<end&&stateNode.dataset.state!=='installed-stopped')await new Promise(function(r){setTimeout(r,25)});
        return {visible:visible,saved:saved,started:started,stopped:stateNode.dataset.state==='installed-stopped',calls:counts,state:stateNode&&stateNode.dataset.state};
      }finally{window.ibBridgeFetch=bridge}
    })()`);
    check('voicebox.runtime.hasInstallPathAndLifecycleControls', voiceboxRuntimeUi&&voiceboxRuntimeUi.visible, JSON.stringify(voiceboxRuntimeUi));
    check('voicebox.runtime.pathStartStopStateTransitionsUseBridge', voiceboxRuntimeUi&&voiceboxRuntimeUi.saved&&voiceboxRuntimeUi.started&&voiceboxRuntimeUi.stopped&&voiceboxRuntimeUi.calls.config===1&&voiceboxRuntimeUi.calls.start===1&&voiceboxRuntimeUi.calls.stop===1, JSON.stringify(voiceboxRuntimeUi));
    await setViewport(375,812);
    await evaluate(cdp,"document.body.classList.add('theme-infernal')");
    const voiceboxCloneWorkflow = await evaluate(cdp, `(async function(){
      var bridge=window.ibBridgeFetch,audioLoader=window.ibBridgeLoadAudio,role=JSON.parse(JSON.stringify(window.apiConfigs.find(function(c){return c.id==='smoke_friend'}))),state={profiles:[],samples:{},createCalls:0,uploadCalls:0,deleteCalls:0,ttsCalls:0,failUploads:1};
      function response(value,status){return new Response(JSON.stringify(value),{status:status||200,headers:{'Content-Type':'application/json'}})}
      function voiceboxProfile(){return {id:'00000000-0000-4000-8000-000000000001',name:'Browser Clone Smoke',description:'Isolated workflow fixture',language:'en',voiceType:'cloned',defaultEngine:'qwen',presetEngine:'',presetVoiceId:'',sampleCount:1,generationCount:0}}
      window.ibBridgeFetch=async function(input,options){var url=new URL(String(input)),path=url.pathname,method=String(options&&options.method||'GET').toUpperCase(),body=options&&options.body;
        if(path==='/api/tts/voicebox/runtime')return response({ok:true,state:'running',installed:true,configured:true,endpointLocal:true,runtimeStatus:'healthy',message:'Isolated Voicebox Provider fixture.'});
        if(path==='/api/tts/voicebox/health')return response({ok:true,status:'healthy',modelLoaded:true});
        if(path==='/api/tts/voicebox/capabilities')return response({ok:true,engines:{qwen:{clone:true,preset:false,profileTypes:['cloned'],languages:['en'],models:[{name:'qwen-tts-1.7B',ibDefault:true}]},kokoro:{clone:false,preset:true,profileTypes:['preset'],languages:['en']}},referenceAudio:{requiredForClone:true,formats:['mp3','wav'],maxBytes:10485760,minDurationSeconds:2,maxDurationSeconds:30,localEndpoint:false},transcript:{required:true,autoTranscribe:false}});
        if(path==='/api/tts/voicebox/models')return response({ok:true,models:[{name:'qwen-tts-1.7B',engine:'qwen',downloaded:true,downloading:false,loaded:true}]});
        if(path==='/api/tts/voicebox/profiles'&&method==='GET')return response({ok:true,profiles:state.profiles.slice()});
        if(path==='/api/tts/voicebox/profiles'&&method==='POST'){state.createCalls++;var value=JSON.parse(body||'{}'),p=voiceboxProfile();p.name=value.name;p.description=value.description;p.language=value.language;p.defaultEngine=value.engine;state.profiles.unshift(p);state.samples[p.id]=[];return response({ok:true,profile:p},201)}
        var sampleMatch=path.match(/^\\/api\\/tts\\/voicebox\\/profiles\\/([^\\/]+)\\/samples$/);
        if(sampleMatch&&method==='POST'){state.uploadCalls++;if(state.failUploads-->0)return response({ok:false,error:'isolated first upload failure'},500);if(options&&options.signal&&options.signal.aborted)throw new DOMException('Aborted','AbortError');var s={id:'sample-fixture-1',profileId:decodeURIComponent(sampleMatch[1]),referenceText:url.searchParams.get('reference_text')||''};state.samples[s.profileId]=[s];var p=state.profiles.find(function(x){return x.id===s.profileId});if(p)p.sampleCount=1;return response({ok:true,sample:s},201)}
        if(sampleMatch&&method==='GET')return response({ok:true,samples:state.samples[decodeURIComponent(sampleMatch[1])]||[]});
        var profileMatch=path.match(/^\\/api\\/tts\\/voicebox\\/profiles\\/([^\\/]+)$/);
        if(profileMatch&&method==='DELETE'){state.deleteCalls++;state.profiles=state.profiles.filter(function(p){return p.id!==decodeURIComponent(profileMatch[1])});delete state.samples[decodeURIComponent(profileMatch[1])];return response({ok:true,deleted:true})}
        if(path==='/api/tts'&&method==='POST'){state.ttsCalls++;return response({ok:true,url:'/tts/isolated-preview.wav',mime:'audio/wav'})}
        return response({ok:false,error:'isolated Voicebox fixture has no route for '+method+' '+path},404);
      };
      window.ibBridgeLoadAudio=function(path,done){done('data:audio/wav;base64,UklGRg==',false)};
      var result={};
      try{
        await window.refreshVoiceboxProfileManager();await window.IBVoiceboxPage.refresh(true);
        var open=document.getElementById('voicebox-clone-open');result.entry=!!(open&&!open.disabled&&document.getElementById('voicebox-clone-engines').textContent==='qwen');
        if(open)open.click();await window.refreshVoiceboxProfileManager();
        result.remoteDisclosure=String(document.getElementById('api-voicebox-reference-destination').textContent).indexOf('离开本机')>=0;
        var dialog=document.querySelector('#api-voicebox-manager-backdrop [role=dialog]'),fields=document.querySelector('.voicebox-clone-fields'),createButton=document.getElementById('api-voicebox-create-btn');
        result.narrowDarkDialog=!!(dialog&&innerWidth===375&&document.body.classList.contains('theme-infernal')&&document.documentElement.scrollWidth<=innerWidth&&dialog.getBoundingClientRect().width<=innerWidth&&fields&&getComputedStyle(fields).gridTemplateColumns.trim().split(/\s+/).length===1&&createButton.getBoundingClientRect().height>=44);
        var backdrop=document.getElementById('api-voicebox-manager-backdrop');result.dialogDebug={innerWidth:innerWidth,documentWidth:document.documentElement.scrollWidth,dialogWidth:dialog&&dialog.getBoundingClientRect().width,dialogScroll:dialog&&dialog.scrollWidth,dialogClient:dialog&&dialog.clientWidth,dialogDisplay:dialog&&getComputedStyle(dialog).display,backdropHidden:backdrop&&backdrop.hidden,backdropDisplay:backdrop&&getComputedStyle(backdrop).display,backdropWidth:backdrop&&backdrop.getBoundingClientRect().width,grid:fields&&getComputedStyle(fields).gridTemplateColumns,createHeight:createButton&&createButton.getBoundingClientRect().height,dark:document.body.classList.contains('theme-infernal')};
        document.getElementById('api-voicebox-create-name').value='Browser Clone Smoke';document.getElementById('api-voicebox-create-description').value='Isolated workflow fixture';
        document.getElementById('api-voicebox-create-type').value='cloned';window.voiceboxCreateTypeChanged();await window.voiceboxCreateEngineChanged();
        var sr=16000,n=sr*2,dataSize=n*2,buffer=new ArrayBuffer(44+dataSize),bytes=new Uint8Array(buffer),dv=new DataView(buffer);
        function tag(o,s){for(var i=0;i<s.length;i++)bytes[o+i]=s.charCodeAt(i)}
        tag(0,'RIFF');dv.setUint32(4,36+dataSize,true);tag(8,'WAVE');tag(12,'fmt ');dv.setUint32(16,16,true);dv.setUint16(20,1,true);dv.setUint16(22,1,true);dv.setUint32(24,sr,true);dv.setUint32(28,sr*2,true);dv.setUint16(32,2,true);dv.setUint16(34,16,true);tag(36,'data');dv.setUint32(40,dataSize,true);
        var file=document.getElementById('api-voicebox-reference-file'),transfer=new DataTransfer();transfer.items.add(new File([bytes],'authorized-reference.wav',{type:'audio/wav'}));file.files=transfer.files;file.dispatchEvent(new Event('change',{bubbles:true}));
        var deadline=Date.now()+5000;while(Date.now()<deadline&&String(document.getElementById('api-voicebox-reference-status').textContent).indexOf('本地预览就绪')<0)await new Promise(function(r){setTimeout(r,25)});
        result.localPreview=String(document.getElementById('api-voicebox-reference-status').textContent).indexOf('本地预览就绪')>=0;
        transfer=new DataTransfer();transfer.items.add(new File([new TextEncoder().encode('not audio')],'broken-reference.wav',{type:'audio/wav'}));file.files=transfer.files;file.dispatchEvent(new Event('change',{bubbles:true}));
        deadline=Date.now()+1000;while(Date.now()<deadline&&String(document.getElementById('api-voicebox-reference-status').textContent).indexOf('格式头无效')<0)await new Promise(function(r){setTimeout(r,20)});
        result.invalidAudioRejected=String(document.getElementById('api-voicebox-reference-status').textContent).indexOf('格式头无效')>=0;
        transfer=new DataTransfer();transfer.items.add(new File([bytes],'authorized-reference.wav',{type:'audio/wav'}));file.files=transfer.files;file.dispatchEvent(new Event('change',{bubbles:true}));
        deadline=Date.now()+5000;while(Date.now()<deadline&&String(document.getElementById('api-voicebox-reference-status').textContent).indexOf('本地预览就绪')<0)await new Promise(function(r){setTimeout(r,25)});
        document.getElementById('api-voicebox-reference-text').value='A short authorized reference transcript.';
        document.getElementById('api-voicebox-create-consent').checked=false;document.getElementById('api-voicebox-create-btn').click();
        result.authorizationBlocksUpload=state.createCalls===0&&String(document.getElementById('api-voicebox-create-state').textContent).indexOf('确认你有权使用')>=0;
        document.getElementById('api-voicebox-create-consent').checked=true;document.getElementById('api-voicebox-create-btn').click();
        deadline=Date.now()+5000;while(Date.now()<deadline&&String(document.getElementById('api-voicebox-create-state').textContent).indexOf('空 Profile 已清理')<0)await new Promise(function(r){setTimeout(r,25)});
        result.failureKeepsAudioForRetry=state.createCalls===1&&state.deleteCalls===1&&!!document.getElementById('api-voicebox-reference-preview').src;
        document.getElementById('api-voicebox-create-btn').click();
        deadline=Date.now()+5000;while(Date.now()<deadline&&String(document.getElementById('api-voicebox-create-state').textContent).indexOf('步骤 3/3')<0)await new Promise(function(r){setTimeout(r,25)});
        result.retryCreatesProfile=state.createCalls===2&&state.uploadCalls===2&&String(document.getElementById('api-voicebox-create-state').textContent).indexOf('步骤 3/3')>=0;
        result.savedToProfileList=!!Array.from(document.querySelectorAll('#api-voicebox-profile-list strong')).find(function(x){return x.textContent.indexOf('Browser Clone Smoke')>=0});
        var preview=Array.from(document.querySelectorAll('#api-voicebox-profile-list button')).find(function(b){return b.textContent==='试听'});if(preview)preview.click();
        deadline=Date.now()+3000;while(Date.now()<deadline&&!state.ttsCalls)await new Promise(function(r){setTimeout(r,25)});
        result.auditionUsesExistingTts=state.ttsCalls===1;
        window.closeVoiceboxProfileManager();await window.IBVoiceboxPage.refresh(true);
        var row=Array.from(document.querySelectorAll('#voicebox-profile-list .voicebox-profile-row')).find(function(x){return x.textContent.indexOf('Browser Clone Smoke')>=0});
        var bind=row&&Array.from(row.querySelectorAll('button')).find(function(b){return b.textContent==='切换到当前角色'}),saveForm=null,originalSave=window.saveCurrentApi;
        window.saveCurrentApi=async function(button){saveForm={provider:document.getElementById('api-voice-provider')&&document.getElementById('api-voice-provider').value,input:document.getElementById('api-voice-id')&&document.getElementById('api-voice-id').value,select:document.getElementById('api-voice-select')&&document.getElementById('api-voice-select').value,usesSelect:typeof window._voiceUsesSelect==='function'?window._voiceUsesSelect():null,voiceId:typeof window._voiceGetId==='function'?window._voiceGetId():null,editingApiId:window.editingApiId};return originalSave.call(this,button)};
        if(bind)bind.click();
        deadline=Date.now()+5000;while(Date.now()<deadline){var current=window.apiConfigs.find(function(c){return c.id==='smoke_friend'});if(current&&current.voice&&current.voice.source==='voicebox'&&current.voice.voiceId==='00000000-0000-4000-8000-000000000001')break;await new Promise(function(r){setTimeout(r,25)})}
        var bound=window.apiConfigs.find(function(c){return c.id==='smoke_friend'});result.roleBindingReusesCurrentSavePath=!!(bound&&bound.voice&&bound.voice.source==='voicebox'&&bound.voice.voiceId==='00000000-0000-4000-8000-000000000001');
        result.bindingDebug={row:!!row,button:!!bind,buttonDisabled:bind&&bind.disabled,pageStatus:document.getElementById('voicebox-page-status').textContent,managerStatus:document.getElementById('api-voicebox-manager-status').textContent,voice:bound&&bound.voice,apiCurrentRole:document.getElementById('voicebox-role-select').value,saveForm:saveForm,stored:(await dbGet('apiConfigs','smoke_friend')).voice};
        window.saveCurrentApi=originalSave;
      }finally{
        window.closeVoiceboxProfileManager();window.ibBridgeFetch=bridge;window.ibBridgeLoadAudio=audioLoader;
        if(role){await dbPut('apiConfigs',role);await loadApiConfigs()}
        await window.refreshVoiceboxProfileManager();
      }
      return result;
    })()`);
    await setViewport(1440,900);
    await evaluate(cdp,"document.body.classList.remove('theme-infernal')");
    check('voicebox.clone.isolatedBrowserWorkflowRequiresConsentAndKeepsAudioLocalUntilUpload',voiceboxCloneWorkflow&&voiceboxCloneWorkflow.entry&&voiceboxCloneWorkflow.remoteDisclosure&&voiceboxCloneWorkflow.localPreview&&voiceboxCloneWorkflow.invalidAudioRejected&&voiceboxCloneWorkflow.authorizationBlocksUpload,JSON.stringify(voiceboxCloneWorkflow));
    check('voicebox.clone.narrowInfernalDialogHasNoOverflowAndTouchSizedActions',voiceboxCloneWorkflow&&voiceboxCloneWorkflow.narrowDarkDialog,JSON.stringify(voiceboxCloneWorkflow));
    check('voicebox.clone.isolatedBrowserWorkflowRetriesFailedUploadThenSavesProfile',voiceboxCloneWorkflow&&voiceboxCloneWorkflow.failureKeepsAudioForRetry&&voiceboxCloneWorkflow.retryCreatesProfile&&voiceboxCloneWorkflow.savedToProfileList,JSON.stringify(voiceboxCloneWorkflow));
    check('voicebox.clone.isolatedBrowserWorkflowAuditionsAndBindsThroughExistingPaths',voiceboxCloneWorkflow&&voiceboxCloneWorkflow.auditionUsesExistingTts&&voiceboxCloneWorkflow.roleBindingReusesCurrentSavePath,JSON.stringify(voiceboxCloneWorkflow));
    const staticVoiceManifest = JSON.parse(fs.readFileSync(path.join(VOICE_LIBRARY_ROOT, 'voice-library-stable.json'), 'utf8'));
    const staticVoiceRows = JSON.stringify(staticVoiceManifest.resources);
    const staticVoiceBase = JSON.stringify('http://127.0.0.1:' + mock.port + '/voice-library/');
    const voiceLibraryStaticRes = await evaluate(cdp, `(async function(){
      var core=window.IBVoiceboxLibraryCore,api=window.IBVoiceboxProfileManager,page=window.IBVoiceboxPage;
      var names=['refresh','profiles','capabilities','presetVoices','importPresetProfile','profileStatus','preview'],saved={};
      names.forEach(function(k){saved[k]=api[k]});
      var oldFetch=window.fetch,oldAsr=window._voiceboxAsrSelected,oldVt=window._vtGet,resources=${staticVoiceRows},localBase=${staticVoiceBase},imported=[],fetchCalls=0,refreshCalls=0,previewCalls=[];
      var role=window.apiConfigs.find(function(c){return c.id==='smoke_friend'}),roleVoiceBefore=JSON.stringify(role&&role.voice||{});
      var caps={engines:{kokoro:{preset:true,profileTypes:['preset'],languages:['en','zh'],models:[{name:'kokoro',ibDefault:true}]}}};
      var catalog=resources.map(function(r){return {id:r.presetVoiceId,name:r.title,language:r.language}});
      api.refresh=async function(){refreshCalls++;return true};
      api.profiles=function(){return imported.slice()};
      api.capabilities=function(){return caps};
      api.presetVoices=async function(engine){return String(engine)==='kokoro'?catalog:[]};
      api.profileStatus=function(){return {available:true,ready:true,modelKnown:true,label:'模型已安装'}};
      api.importPresetProfile=async function(p){var created={id:'smoke_static_profile_'+(imported.length+1),name:p.name,description:p.description,language:p.language,
        voiceType:'preset',defaultEngine:p.engine,presetEngine:p.engine,presetVoiceId:p.presetVoiceId,sampleCount:0};imported.unshift(created);return created};
      api.preview=async function(id,engine,sampleText){previewCalls.push({id:id,engine:engine,text:sampleText});return {ok:true}};
      window._voiceboxAsrSelected=async function(){return false};window._vtGet=async function(){return null};
      window.__VoiceLibraryOffline=false;window.__VoiceLibraryCorruptResourceId='';
      window.fetch=async function(input,init){var url=String(input),remote='https://dl.chatvault.top/voice-library/';
        if(url.indexOf(remote)===0){fetchCalls++;if(window.__VoiceLibraryOffline)throw new Error('isolated static host offline');
          var suffix=url.slice(remote.length).split(/[?#]/)[0],response=await oldFetch.call(window,localBase+suffix,init),bytes=new Uint8Array(await response.arrayBuffer());
          if(window.__VoiceLibraryCorruptResourceId&&suffix==='profiles/'+window.__VoiceLibraryCorruptResourceId+'.json'&&bytes.length)bytes[bytes.length-1]^=1;
          return new Response(bytes,{status:response.status,headers:response.headers});}
        return oldFetch.call(window,input,init)};
      try{
        await page.refresh(true);
        var first=resources[0],second=resources[1],firstRow=document.querySelector('#voicebox-online-list [data-resource-id="'+first.id+'"]');
        var rows=Array.from(document.querySelectorAll('#voicebox-online-list [data-resource-id]'));
        var provenance=!!(firstRow&&firstRow.textContent.indexOf(first.source.name)>=0&&firstRow.textContent.indexOf(first.license.name)>=0&&firstRow.textContent.indexOf(String(first.sizeBytes)+' B · SHA-256')>=0);
        var browsed=rows.length===resources.length&&document.getElementById('voicebox-online-status').textContent.indexOf('Manifest 已验证')>=0;
        var download=firstRow&&Array.from(firstRow.querySelectorAll('button')).find(function(b){return b.textContent==='下载并导入'});if(download)download.click();
        var end=Date.now()+5000;while(Date.now()<end&&imported.length<1)await new Promise(function(r){setTimeout(r,25)});
        if(imported.length)await page.refresh(true);
        var importedOk=imported.length===1&&imported[0].presetVoiceId===first.presetVoiceId;
        var localRow=Array.from(document.querySelectorAll('#voicebox-profile-list .voicebox-profile-row')).find(function(r){return r.textContent.indexOf(first.title)>=0});
        var preview=localRow&&Array.from(localRow.querySelectorAll('button')).find(function(b){return b.textContent==='试听'});if(preview)preview.click();
        var audition=previewCalls.length===1&&previewCalls[0].id===imported[0].id;
        window.__VoiceLibraryCorruptResourceId=second.id;
        var corruptRow=document.querySelector('#voicebox-online-list [data-resource-id="'+second.id+'"]'),corruptButton=corruptRow&&Array.from(corruptRow.querySelectorAll('button')).find(function(b){return b.textContent==='下载并导入'});
        if(corruptButton)corruptButton.click();end=Date.now()+4000;
        while(Date.now()<end&&String(document.getElementById('voicebox-page-status').textContent).indexOf('SHA-256')<0)await new Promise(function(r){setTimeout(r,25)});
        var corruptRejected=imported.length===1&&String(document.getElementById('voicebox-page-status').textContent).indexOf('SHA-256')>=0;
        window.__VoiceLibraryCorruptResourceId='';
        var exportButton=Array.from(document.querySelectorAll('#voicebox-profile-list .voicebox-profile-actions button')).find(function(b){return b.textContent==='导出 Profile'});
        var captured=null,create=URL.createObjectURL,click=HTMLAnchorElement.prototype.click;URL.createObjectURL=function(blob){captured=blob;return 'blob:voice-library-static-smoke'};HTMLAnchorElement.prototype.click=function(){};
        try{if(exportButton&&!exportButton.disabled)exportButton.click();var exported=captured?JSON.parse(await captured.text()):null;
          var exportSafe=!!(exported&&exported.schema===core.PROFILE_SCHEMA&&exported.profile.presetVoiceId===first.presetVoiceId&&!JSON.stringify(exported).match(/apiKey|credential|token|audioData|sampleData/i));
          var fileInput=document.getElementById('voicebox-profile-import-file'),dt=new DataTransfer();dt.items.add(new File([JSON.stringify(exported)],'voice-profile.json',{type:'application/json'}));fileInput.files=dt.files;fileInput.dispatchEvent(new Event('change',{bubbles:true}));
          end=Date.now()+5000;while(Date.now()<end&&imported.length<2)await new Promise(function(r){setTimeout(r,25)});
          var fileImported=imported.length===2;
        }finally{URL.createObjectURL=create;HTMLAnchorElement.prototype.click=click}
        var search=document.getElementById('voicebox-library-search');search.value=first.title;search.dispatchEvent(new Event('input',{bubbles:true}));
        var searchWorks=Array.from(document.querySelectorAll('#voicebox-online-list [data-resource-id]')).some(function(r){return r.textContent.indexOf(first.title)>=0});
        var category=document.getElementById('voicebox-library-category');category.value='online';category.dispatchEvent(new Event('change',{bubbles:true}));
        var categoryWorks=document.getElementById('voicebox-online-list').textContent.indexOf(first.title)>=0;
        search.value='';search.dispatchEvent(new Event('input',{bubbles:true}));category.value='all';category.dispatchEvent(new Event('change',{bubbles:true}));
        window.__VoiceLibraryOffline=true;await page.refresh(true);
        var offlineSafe=document.getElementById('voicebox-online-status').textContent.indexOf('在线目录暂不可用')>=0&&document.querySelectorAll('#voicebox-profile-list .voicebox-profile-row').length>=1;
        var roleUnchanged=JSON.stringify((window.apiConfigs.find(function(c){return c.id==='smoke_friend'})||{}).voice||{})===roleVoiceBefore;
        return {browsed:browsed,provenance:provenance,imported:importedOk,audition:audition,corruptRejected:corruptRejected,exportSafe:exportSafe,fileImported:fileImported,
          searchWorks:searchWorks,categoryWorks:categoryWorks,offlineSafe:offlineSafe,roleUnchanged:roleUnchanged,fetchCalls:fetchCalls,resources:resources.length,
          localProfiles:document.querySelectorAll('#voicebox-profile-list .voicebox-profile-row').length,refreshCalls:refreshCalls,onlineStatus:document.getElementById('voicebox-online-status').textContent,
          searchedOnline:document.getElementById('voicebox-online-list').textContent.slice(0,140),category:category.value,offlineStatus:document.getElementById('voicebox-online-status').textContent};
      }finally{window.fetch=oldFetch;window._voiceboxAsrSelected=oldAsr;window._vtGet=oldVt;window.__VoiceLibraryOffline=false;delete window.__VoiceLibraryCorruptResourceId;names.forEach(function(k){api[k]=saved[k]})}
    })()`);
    check('voicebox.online.localStaticManifestDisplaysVerifiedSourcesAndSizes', voiceLibraryStaticRes&&voiceLibraryStaticRes.browsed&&voiceLibraryStaticRes.provenance, JSON.stringify(voiceLibraryStaticRes));
    check('voicebox.online.localStaticDownloadHashAndProviderChecksThenImports', voiceLibraryStaticRes&&voiceLibraryStaticRes.imported&&voiceLibraryStaticRes.corruptRejected, JSON.stringify(voiceLibraryStaticRes));
    check('voicebox.online.auditionDelegatesToExistingProfilePreviewAndExportImportRoundTrips', voiceLibraryStaticRes&&voiceLibraryStaticRes.audition&&voiceLibraryStaticRes.exportSafe&&voiceLibraryStaticRes.fileImported, JSON.stringify(voiceLibraryStaticRes));
    check('voicebox.online.searchCategoryOfflineFallbackAndRoleIsolation', voiceLibraryStaticRes&&voiceLibraryStaticRes.searchWorks&&voiceLibraryStaticRes.categoryWorks&&voiceLibraryStaticRes.offlineSafe&&voiceLibraryStaticRes.roleUnchanged, JSON.stringify(voiceLibraryStaticRes));
    const voiceLibraryRes=await evaluate(cdp, `(async function(){
      var core=window.IBVoiceboxLibraryCore,api=window.IBVoiceboxProfileManager,page=window.IBVoiceboxPage;
      var names=['refresh','profiles','capabilities','presetVoices','importPresetProfile','profileStatus','preview','open','cancelPreview','isPreviewActive'],saved={};
      names.forEach(function(k){saved[k]=api[k]});
      var oldFetch=window.fetch,oldAsr=window._voiceboxAsrSelected,oldVt=window._vtGet;
      var imported=[],assetBytes=Object.create(null),fetchCalls=0,managerRefreshCalls=0,managerOpenCalls=0,previewCancelCalls=0,previewActive=false,previewResolve=null,role=window.apiConfigs.find(function(c){return c.id==='smoke_friend'}),roleVoiceBefore=JSON.stringify(role&&role.voice||{});
      var caps={engines:{qwen:{clone:true,preset:false,profileTypes:['cloned'],languages:['en'],models:[{name:'qwen-tts-1.7B',ibDefault:true}]},kokoro:{clone:false,preset:true,profileTypes:['preset'],languages:['en'],models:[{name:'kokoro',ibDefault:true}]}},referenceAudio:{localEndpoint:true,formats:['mp3','wav'],maxBytes:10485760}};
      api.refresh=async function(){managerRefreshCalls++;return true};
      api.profiles=function(){return imported.slice()};
      api.capabilities=function(){return caps};
      api.presetVoices=async function(engine){return String(engine)==='kokoro'?[{id:'af_heart',name:'Heart',language:'en'},{id:'af_bella',name:'Bella',language:'en'}]:[]};
      api.profileStatus=function(){return {available:true,ready:true,modelKnown:true,label:'模型已安装'}};
      api.open=function(){managerOpenCalls++};
      api.preview=function(){previewActive=true;return new Promise(function(resolve){previewResolve=resolve})};
      api.cancelPreview=function(){previewCancelCalls++;previewActive=false;if(previewResolve)previewResolve({cancelled:true});return true};
      api.isPreviewActive=function(){return previewActive};
      api.importPresetProfile=async function(p){
        var created={id:'smoke_voice_profile_'+(imported.length+1),name:p.name,description:p.description,language:p.language,
          voiceType:'preset',defaultEngine:p.engine,presetEngine:p.engine,presetVoiceId:p.presetVoiceId,sampleCount:0};
        imported.unshift(created);return created;
      };
      window._voiceboxAsrSelected=async function(){return false};window._vtGet=async function(){return null};
      async function makePackage(id,title,voiceId){
        var pkg={schema:core.PROFILE_SCHEMA,schemaVersion:1,profile:{provider:'voicebox',voiceType:'preset',name:title,
          description:'Smoke preset resource',language:'en',engine:'kokoro',presetVoiceId:voiceId}};
        var bytes=new TextEncoder().encode(JSON.stringify(pkg));
        var digest=await crypto.subtle.digest('SHA-256',bytes);
        var hash=Array.from(new Uint8Array(digest),function(x){return x.toString(16).padStart(2,'0')}).join('');
        assetBytes[id]=bytes;
        return {id:id,kind:'voicebox-preset-profile',title:title,description:'Smoke preset resource',provider:'voicebox',engine:'kokoro',
          presetVoiceId:voiceId,language:'en',source:{name:'Voice Library Smoke',url:'https://example.com/source'},
          license:{id:'CC-BY-4.0',name:'CC BY 4.0',url:'https://example.com/license'},path:'profiles/'+id+'.json',
          sizeBytes:bytes.byteLength,sha256:hash};
      }
      var good=await makePackage('smoke-good','Smoke Heart','af_heart');
      var unsupported=await makePackage('smoke-unsupported','Unsupported Voice','af_unknown');
      var corrupt=await makePackage('smoke-corrupt','Corrupt Resource','af_bella');corrupt.sha256='0'.repeat(64);
      var manifest={schema:core.MANIFEST_SCHEMA,schemaVersion:1,generatedAt:'2026-10-14T12:00:00Z',resources:[good,unsupported,corrupt]};
      var presetUrl='https://dl.chatvault.top/voice-library/';
      window.fetch=async function(input,init){
        var url=String(input);
        if(url.indexOf('https://dl.chatvault.top/voice-library/')===0)fetchCalls++;
        if(url===core.MANIFEST_URL)return new Response(JSON.stringify(manifest),{status:200,headers:{'Content-Type':'application/json'}});
        var key=Object.keys(assetBytes).find(function(id){return url===presetUrl+'profiles/'+id+'.json'});
        if(key)return new Response(assetBytes[key],{status:200,headers:{'Content-Type':'application/json'}});
        return oldFetch(input,init);
      };
      try{
        await page.refresh(true);
        if(!fetchCalls){await new Promise(function(resolve){setTimeout(resolve,80)});await page.refresh(true)}
        var cloneOpen=document.getElementById('voicebox-clone-open');
        var cloneEntry=!!(cloneOpen&&!cloneOpen.disabled&&document.getElementById('voicebox-clone-engines').textContent==='qwen'&&document.getElementById('voicebox-clone-destination').textContent.indexOf('本机 Voicebox')>=0);
        if(cloneOpen)cloneOpen.click();
        var cloneOpensManager=managerOpenCalls===1;
        caps.referenceAudio.localEndpoint=false;await page.refresh(true);
        var remoteDestination=document.getElementById('voicebox-clone-destination').textContent.indexOf('远程 Voicebox Provider')>=0;
        caps.referenceAudio.localEndpoint=true;await page.refresh(true);
        var row=document.querySelector('#voicebox-online-list [data-resource-id="smoke-good"]');
        var sourceLicense=!!(row&&row.textContent.indexOf('Voice Library Smoke')>=0&&row.textContent.indexOf('CC BY 4.0')>=0&&row.textContent.indexOf(String(good.sizeBytes)+' B · SHA-256')>=0);
        var unsupportedRow=document.querySelector('#voicebox-online-list [data-resource-id="smoke-unsupported"]');
        var unsupportedDisabled=!!(unsupportedRow&&unsupportedRow.querySelector('button')&&unsupportedRow.querySelector('button').disabled);
        var goodButton=row&&Array.from(row.querySelectorAll('button')).find(function(b){return b.textContent==='下载并导入'});
        if(goodButton)goodButton.click();
        var end=Date.now()+5000;
        while(Date.now()<end&&imported.length<1)await new Promise(function(resolve){setTimeout(resolve,30)});
        var importedResource=imported.length===1&&!!document.querySelector('#voicebox-online-list [data-resource-id="smoke-good"] .voicebox-online-download-state');
        var corruptRow=document.querySelector('#voicebox-online-list [data-resource-id="smoke-corrupt"]'),corruptButton=corruptRow&&Array.from(corruptRow.querySelectorAll('button')).find(function(b){return b.textContent==='下载并导入'});
        if(corruptButton)corruptButton.click();
        end=Date.now()+3000;
        while(Date.now()<end&&String(document.getElementById('voicebox-page-status').textContent).indexOf('SHA-256')<0)await new Promise(function(resolve){setTimeout(resolve,30)});
        var corruptRejected=imported.length===1&&String(document.getElementById('voicebox-page-status').textContent).indexOf('SHA-256')>=0;
        var exportButton=Array.from(document.querySelectorAll('#voicebox-profile-list .voicebox-profile-actions button')).find(function(b){return b.textContent==='导出 Profile'});
        var captured=null,create=URL.createObjectURL,click=HTMLAnchorElement.prototype.click;
        URL.createObjectURL=function(blob){captured=blob;return 'blob:voicebox-library-smoke'};HTMLAnchorElement.prototype.click=function(){};
        if(exportButton&&!exportButton.disabled)exportButton.click();
        var exported=captured?JSON.parse(await captured.text()):null;
        URL.createObjectURL=create;HTMLAnchorElement.prototype.click=click;
        var exportSafe=!!(exported&&exported.schema===core.PROFILE_SCHEMA&&exported.profile.presetVoiceId==='af_heart'
          &&!JSON.stringify(exported).match(/apiKey|credential|token|audioData|sampleData/i));
        var fileInput=document.getElementById('voicebox-profile-import-file'),dt=new DataTransfer();
        dt.items.add(new File([JSON.stringify(exported)],'voice-profile.json',{type:'application/json'}));fileInput.files=dt.files;
        fileInput.dispatchEvent(new Event('change',{bubbles:true}));
        end=Date.now()+5000;while(Date.now()<end&&imported.length<2)await new Promise(function(resolve){setTimeout(resolve,30)});
        var fileImported=imported.length===2;
        var search=document.getElementById('voicebox-library-search');search.value='Smoke Heart';search.dispatchEvent(new Event('input',{bubbles:true}));
        var searchWorks=Array.from(document.querySelectorAll('#voicebox-profile-list .voicebox-profile-row')).some(function(r){return r.textContent.indexOf('Smoke Heart')>=0});
        var category=document.getElementById('voicebox-library-category');category.value='online';category.dispatchEvent(new Event('change',{bubbles:true}));
        var categoryWorks=document.querySelector('#voicebox-profile-list .voicebox-empty')&&document.getElementById('voicebox-online-list').textContent.indexOf('Smoke Heart')>=0;
        imported.unshift({id:'smoke_clone_profile',name:'Smoke Clone',description:'isolated clone fixture',language:'en',voiceType:'cloned',defaultEngine:'qwen',sampleCount:1});
        search.value='';search.dispatchEvent(new Event('input',{bubbles:true}));
        category.value='all';category.dispatchEvent(new Event('change',{bubbles:true}));await page.refresh(true);
        var cloneRow=Array.from(document.querySelectorAll('#voicebox-profile-list .voicebox-profile-row')).find(function(r){return r.textContent.indexOf('Smoke Clone')>=0});
        var clonePreview=cloneRow&&Array.from(cloneRow.querySelectorAll('button')).find(function(b){return b.textContent==='试听'});
        if(clonePreview)clonePreview.click();
        await new Promise(function(resolve){setTimeout(resolve,60)});
        var cancelVisible=!!(document.getElementById('voicebox-cancel-preview')&&!document.getElementById('voicebox-cancel-preview').hidden);
        var cancelPreviewButton=document.getElementById('voicebox-cancel-preview');if(cancelPreviewButton)cancelPreviewButton.click();
        var cancelEnd=Date.now()+1500;while(Date.now()<cancelEnd&&(!previewCancelCalls||document.getElementById('voicebox-cancel-preview').hidden===false))await new Promise(function(resolve){setTimeout(resolve,20)});
        var previewCancelled=previewCancelCalls===1&&String(document.getElementById('voicebox-page-status').textContent).indexOf('试听已取消')>=0;
        var roleUnchanged=JSON.stringify((window.apiConfigs.find(function(c){return c.id==='smoke_friend'})||{}).voice||{})===roleVoiceBefore;
        return {sourceLicense:sourceLicense,unsupportedDisabled:unsupportedDisabled,importedResource:importedResource,corruptRejected:corruptRejected,
          exportSafe:exportSafe,fileImported:fileImported,searchWorks:searchWorks,categoryWorks:!!categoryWorks,roleUnchanged:roleUnchanged,importCalls:imported.length,
          cloneEntry:cloneEntry,cloneOpensManager:cloneOpensManager,remoteDestination:remoteDestination,cancelVisible:cancelVisible,previewCancelled:previewCancelled,
          debug:{fetchCalls:fetchCalls,managerRefreshCalls:managerRefreshCalls,frozen:Object.isFrozen(api),runtime:document.getElementById('voicebox-runtime-status').textContent,
            online:document.getElementById('voicebox-online-status').textContent,onlineText:document.getElementById('voicebox-online-list').textContent.slice(0,240),
            localText:document.getElementById('voicebox-profile-list').textContent.slice(0,160)}};
      }finally{
        window.fetch=oldFetch;window._voiceboxAsrSelected=oldAsr;window._vtGet=oldVt;
        names.forEach(function(k){api[k]=saved[k]});
      }
    })()`);
    check('voicebox.library.searches local and online Profile sources and shows provenance/size',voiceLibraryRes&&voiceLibraryRes.sourceLicense&&voiceLibraryRes.searchWorks&&voiceLibraryRes.categoryWorks,JSON.stringify(voiceLibraryRes));
    check('voicebox.library.importExport uses preset Profile metadata without secrets or samples',voiceLibraryRes&&voiceLibraryRes.importedResource&&voiceLibraryRes.exportSafe&&voiceLibraryRes.fileImported,JSON.stringify(voiceLibraryRes));
    check('voicebox.library.rejects unsupported presets and corrupt hashes without touching role config',voiceLibraryRes&&voiceLibraryRes.unsupportedDisabled&&voiceLibraryRes.corruptRejected&&voiceLibraryRes.roleUnchanged,JSON.stringify(voiceLibraryRes));
    check('voicebox.clone.entryUsesDeclaredEngineAndExplainsLocalVsRemoteAudioTarget',voiceLibraryRes&&voiceLibraryRes.cloneEntry&&voiceLibraryRes.cloneOpensManager&&voiceLibraryRes.remoteDestination,JSON.stringify(voiceLibraryRes));
    check('voicebox.clone.previewShowsProgressAndCanBeCancelled',voiceLibraryRes&&voiceLibraryRes.cancelVisible&&voiceLibraryRes.previewCancelled,JSON.stringify(voiceLibraryRes));
    await evaluate(cdp,"(function(){var s=document.getElementById('voicebox-library-search'),c=document.getElementById('voicebox-library-category'),p=document.getElementById('voicebox-page-status');if(s){s.value='';s.dispatchEvent(new Event('input',{bubbles:true}))}if(c){c.value='all';c.dispatchEvent(new Event('change',{bubbles:true}))}if(p)p.textContent='';return true})()");
    await captureVoiceboxEvidence('voice-library-internal-1280',1280,850,false);
    const voiceboxLightLayout=await evaluate(cdp,"(function(){var p=document.querySelector('.voicebox-page'),b=document.querySelector('.voicebox-library-toolbar button'),e=document.getElementById('voicebox-library-category');return {width:document.documentElement.scrollWidth,inner:innerWidth,page:p&&getComputedStyle(p).backgroundColor,button:b&&b.getBoundingClientRect().height,select:e&&e.getBoundingClientRect().height,theme:document.body.classList.contains('theme-infernal')}})()");
    await captureVoiceboxEvidence('voice-library-infernal-375',375,812,true);
    const voiceboxDarkLayout=await evaluate(cdp,"(function(){var p=document.querySelector('.voicebox-page'),b=document.querySelector('.voicebox-library-toolbar button'),e=document.getElementById('voicebox-library-category');return {width:document.documentElement.scrollWidth,inner:innerWidth,page:p&&getComputedStyle(p).backgroundColor,button:b&&b.getBoundingClientRect().height,select:e&&e.getBoundingClientRect().height,theme:document.body.classList.contains('theme-infernal')}})()");
    check('voicebox.library.realBrowserThemesAnd375pxLayout',voiceboxLightLayout&&voiceboxLightLayout.width<=voiceboxLightLayout.inner&&voiceboxDarkLayout&&voiceboxDarkLayout.width<=375&&voiceboxDarkLayout.theme&&voiceboxDarkLayout.button>=44&&voiceboxDarkLayout.select>=44,JSON.stringify({light:voiceboxLightLayout,dark:voiceboxDarkLayout}));
    await cdp.send('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false});
    await evaluate(cdp,"document.body.classList.remove('theme-infernal')");
    await evaluate(cdp, "navTo('home')");
    await evaluate(cdp, "openChatPanel()");
    check('chat.panelOpen', await waitFor(cdp, "!!document.getElementById('chat-input')", 8000));
    await evaluate(cdp, "document.getElementById('chat-input').value = '你好，SmokeAI。'; sendChatMessage();");
    check('chat.userBubble', await waitFor(cdp, "(function(){ var m=document.getElementById('chat-messages'); return !!m && m.textContent.includes('你好，SmokeAI。'); })()", 8000));
    check('chat.assistantReply', await waitFor(cdp, "(function(){ var m=document.getElementById('chat-messages'); return !!m && m.textContent.includes('" + MOCK_REPLY + "'); })()", 15000));
    check('chat.turnTrace.completed', await waitFor(cdp, "(function(){var all=IBModelCore.turnTraceRecent(10).filter(function(t){return t.consumer==='chat'&&t.characterId==='smoke_friend'});return all.length>0&&all[all.length-1].status==='completed'&&all[all.length-1].events.some(function(e){return e.eventType==='result'})})()", 5000));
    const smokeTurnTrace = await evaluate(cdp, "(function(){var all=IBModelCore.turnTraceRecent(10).filter(function(t){return t.consumer==='chat'&&t.characterId==='smoke_friend'});return all.length?all[all.length-1]:null})()");
    const smokeTraceTypes = smokeTurnTrace && smokeTurnTrace.events.map(event => event.eventType);
    check('chat.turnTrace.endToEnd', !!smokeTurnTrace && ['input','context','memory','middle_brain','model_call_started','model_call_finished','tool_execution','result']
      .every(type => smokeTraceTypes.indexOf(type) >= 0), JSON.stringify(smokeTraceTypes));
    check('chat.turnTrace.redacted', !!smokeTurnTrace && !JSON.stringify(smokeTurnTrace).includes('你好，SmokeAI。')
      && !JSON.stringify(smokeTurnTrace).includes('你是测试助手'));
    check('chat.p3.emotionalTexturePromptPresent', mock.captured.chatEmotionalTexture === true, String(mock.captured.chatEmotionalTexture));
    check('chat.stored', await evaluate(cdp, "(async function(){ var all = await dbGetAll('chatMessages'); return all.some(m => m.friendId === 'smoke_friend' && m.role === 'assistant'); })()"));
    /* Expression Packs live with the role config. Exercise upload, manual Chat
       selection, reload persistence, and prove the image bytes never enter chatMessages. */
    await evaluate(cdp, "(async function(){await window.IBExpressionPacks.open('smoke_friend');var name=document.getElementById('ib-expression-new-pack');name.value='Smoke Pack';name.dispatchEvent(new Event('input',{bubbles:true}));document.getElementById('ib-expression-create-pack').click();return true})()");
    check('expression.chatPackCreated', await waitFor(cdp, "(async function(){var c=await dbGet('apiConfigs','smoke_friend');return !!(c&&c.expressionPacks&&c.expressionPacks.some(function(p){return p.name==='Smoke Pack'}))})()", 5000));
    for (const [expressionName, color] of [['微笑', '#b8d8f0'], ['开心', '#8bbde6']]) {
      await evaluate(cdp, "(async function(){var canvas=document.createElement('canvas');canvas.width=24;canvas.height=24;var ctx=canvas.getContext('2d');ctx.fillStyle='" + color + "';ctx.fillRect(0,0,24,24);var blob=await new Promise(function(resolve){canvas.toBlob(resolve,'image/png')});var file=new File([blob],'" + expressionName + ".png',{type:'image/png'});var transfer=new DataTransfer();transfer.items.add(file);var input=document.getElementById('ib-expression-file');document.getElementById('ib-expression-name').value='" + expressionName + "';input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));return true})()");
      const expectedCount = expressionName === '微笑' ? 1 : 2;
      check('expression.chatUpload.' + expressionName, await waitFor(cdp, "(async function(){var c=await dbGet('apiConfigs','smoke_friend'),p=c&&c.expressionPacks&&c.expressionPacks.find(function(x){return x.name==='Smoke Pack'});return !!(p&&p.expressions&&p.expressions.length===" + expectedCount + ")})()", 8000));
    }
    await evaluate(cdp, "(function(){var choose=function(state,name){var s=document.getElementById('ib-expression-default-'+state);for(var i=0;i<s.options.length;i++){if(s.options[i].textContent.endsWith(' · '+name)){s.value=s.options[i].value;return true}}return false};window.__expressionDefaultChoices=['neutralExpression','greetingExpression','typingExpression','voiceExpression','errorExpression'].every(function(state){return choose(state,state==='neutralExpression'||state==='typingExpression'?'微笑':'开心')});document.getElementById('ib-expression-save-defaults').click();return true})()");
    check('expression.defaultsSavedOnRoleConfig', await waitFor(cdp, "(async function(){var c=await dbGet('apiConfigs','smoke_friend');return !!(window.__expressionDefaultChoices&&c&&c.expressionDefaults&&Object.keys(c.expressionDefaults).length===5)})()", 5000));
    await evaluate(cdp, "document.querySelector('#ib-expression-pack-dialog [data-expression-close]').click();loadChatMessages();");
    check('expression.chatPickerRenders', await waitFor(cdp, "!!document.querySelector('#chat-messages .chat-msg.ai[data-msg-id] .ib-expression-message-trigger')", 5000));
    await evaluate(cdp, "document.querySelector('#chat-messages .chat-msg.ai[data-msg-id] .ib-expression-message-trigger').click();document.querySelector('#chat-messages .chat-msg.ai[data-msg-id] .ib-expression-choice[aria-label^=\"显示表情：开心\"]').click();");
    check('expression.chatSelectionDisplaysImage', await waitFor(cdp, "!!document.querySelector('#chat-messages .chat-msg.ai[data-msg-id] .ib-expression-message-image')", 8000));
    check('expression.chatSelectionIsRoleConfigData', await waitFor(cdp, "(async function(){var c=await dbGet('apiConfigs','smoke_friend'),m=(await dbGetByIndex('chatMessages','byFriend','smoke_friend')).filter(function(x){return x.role==='assistant'}).pop(),a=c&&c.expressionAssignments&&c.expressionAssignments[m&&m.id];return !!(a&&a.expressionId&&m&&!Object.prototype.hasOwnProperty.call(m,'expression')&&!Object.prototype.hasOwnProperty.call(m,'expressionId'))})()", 8000));
    await evaluate(cdp, "loadChatMessages();");
    check('expression.chatSelectionSurvivesHistoryReload', await waitFor(cdp, "!!document.querySelector('#chat-messages .chat-msg.ai[data-msg-id] .ib-expression-message-image')", 5000));
    check('expression.chatMessageContainsNoImageBytes', await evaluate(cdp, "(async function(){var c=await dbGet('apiConfigs','smoke_friend'),m=(await dbGetByIndex('chatMessages','byFriend','smoke_friend')).filter(function(x){return x.role==='assistant'}).pop();return !!(c&&c.expressionPacks&&JSON.stringify(m).indexOf('data:image')<0&&JSON.stringify(m).indexOf('expressionPacks')<0)})()"));
    check('expression.exportImportPreservesPackAndSelection', await evaluate(cdp, "(async function(){var blob=null,create=URL.createObjectURL,click=HTMLAnchorElement.prototype.click;URL.createObjectURL=function(value){blob=value;return create.call(URL,value)};HTMLAnchorElement.prototype.click=function(){};await window.exportAll();URL.createObjectURL=create;HTMLAnchorElement.prototype.click=click;if(!blob)return false;var data=JSON.parse(await blob.text()),role=(data.apiConfigs||[]).find(function(c){return c.id==='smoke_friend'});if(!role)return false;var file=new File([JSON.stringify({apiConfigs:[role]})],'expression-pack.json',{type:'application/json'});await importAll({target:{files:[file],value:'expression-pack.json'}});var restored=await dbGet('apiConfigs','smoke_friend'),messages=await dbGetByIndex('chatMessages','byFriend','smoke_friend'),msg=messages.filter(function(m){return m.role==='assistant'}).pop(),selected=msg&&window.IBExpressionPackCore.messageExpression(restored,msg.id);return !!(restored&&restored.expressionPacks&&restored.expressionPacks.some(function(p){return p.expressions&&p.expressions.length===2})&&selected&&/^data:image\\//.test(selected.expression.dataUrl))})()"));
    check('expression.exportImportPreservesDefaults', await evaluate(cdp, "(async function(){var c=await dbGet('apiConfigs','smoke_friend');return !!(c&&window.IBExpressionPackCore.DEFAULT_STATES.every(function(s){return !!(c.expressionDefaults&&c.expressionDefaults[s])}))})()"));
    await evaluate(cdp, "(async function(){await dbPut('chatMessages',{id:'expr_default_probe',role:'assistant',content:'neutral default probe',senderName:'SmokeAI',friendId:'smoke_friend',timestamp:Date.now()+1,metadata:{config_id:'smoke_friend'}});await loadChatMessages();return true})()");
    check('expression.chatNeutralDefaultDisplaysWithoutMessageChanges', await waitFor(cdp, "(async function(){var m=await dbGet('chatMessages','expr_default_probe'),c=await dbGet('apiConfigs','smoke_friend'),img=document.querySelector('#chat-messages [data-msg-id=expr_default_probe] .ib-expression-message-image'),ref=window.IBExpressionPackCore.defaultExpression(c,'neutralExpression');return !!(m&&c&&img&&ref&&img.src===ref.expression.dataUrl&&!(c.expressionAssignments||{})[m.id])})()", 5000));
    await evaluate(cdp, "(async function(){await dbPut('chatMessages',{id:'expr_auto_probe',role:'assistant',content:'太好了，真替你开心。',senderName:'SmokeAI',friendId:'smoke_friend',timestamp:Date.now()+2,metadata:{config_id:'smoke_friend'}});await loadChatMessages();return true})()");
    check('expression.chatAutomaticContextSelection', await waitFor(cdp, "(async function(){var c=await dbGet('apiConfigs','smoke_friend'),Core=window.IBExpressionPackCore,m=document.querySelector('#chat-messages [data-msg-id=expr_auto_probe] .ib-expression-message-display'),active=Core.activePack(c),shown=m&&m.querySelector('img')&&m.querySelector('img').src;return !!(m&&Core.automaticMood('太好了，真替你开心。')==='happy'&&Core.expressionsOf(active).some(function(e){return e.dataUrl===shown})&&m.dataset.expressionSource==='automatic')})()", 5000), await evaluate(cdp,"(async function(){var c=await dbGet('apiConfigs','smoke_friend'),m=document.querySelector('#chat-messages [data-msg-id=expr_auto_probe]'),d=m&&m.querySelector('.ib-expression-message-display');return JSON.stringify({cfgSettings:c&&c.expressionSettings,active:c&&c.activeExpressionPackId,source:d&&d.dataset.expressionSource,label:d&&d.textContent,chatText:m&&m.textContent,apiConfig:window.apiConfigs.find(function(x){return x.id==='smoke_friend'})&&window.apiConfigs.find(function(x){return x.id==='smoke_friend'}).expressionSettings})})()"));
    await evaluate(cdp, "(function(){document.getElementById('chat-input').value='expression_marker_probe';window.__expressionMarkerSendDone=false;window.__expressionMarkerPromise=sendChatMessage().then(function(r){window.__expressionMarkerSend=r;window.__expressionMarkerSendDone=true},function(){window.__expressionMarkerSendDone=true});return true})()");
    check('expression.chatModelMarkerIsHiddenAndResolved', await waitFor(cdp, "(async function(){var r=window.__expressionMarkerSend,m=r&&r.messageId&&await dbGet('chatMessages',r.messageId),c=await dbGet('apiConfigs','smoke_friend'),expected=window.IBExpressionPackCore.resolveExpressionTag(c,'happy'),el=r&&document.querySelector('#chat-messages [data-msg-id=\"'+r.messageId+'\"] .ib-expression-message-display');return !!(m&&m.content==='太好了，真替你开心。'&&m.content.indexOf('[[expression:')<0&&!Object.prototype.hasOwnProperty.call(m,'expressionRef')&&m.content.indexOf('data:image')<0&&el&&expected&&el.dataset.expressionSource==='model'&&el.querySelector('img').src===expected.expression.dataUrl)})()", 10000), await evaluate(cdp,"(async function(){var r=window.__expressionMarkerSend,m=r&&r.messageId&&await dbGet('chatMessages',r.messageId),cfg=await dbGet('apiConfigs','smoke_friend'),parsed=window.IBExpressionPackCore.parseReplyExpressions('[[expression:happy]]太好了，真替你开心。',cfg),resolved=window.IBExpressionPackCore.resolveMessageExpression(cfg,{modelExpressionRef:parsed.expressionRef,text:m&&m.content}),nodes=Array.from(document.querySelectorAll('[data-msg-id]')).filter(function(x){return x.dataset.msgId===String(r&&r.messageId||'')});return JSON.stringify({result:r&&{messageId:r.messageId,replyText:r.replyText},message:m&&m.content,parsed:parsed,settings:cfg&&cfg.expressionSettings,active:cfg&&cfg.activeExpressionPackId,resolved:resolved&&{source:resolved.source,id:resolved.expression.id},nodes:nodes.map(function(x){return {tag:x.tagName,className:x.className,text:x.textContent,html:x.innerHTML.slice(-300)}})})})()"));
    check('expression.chatOptionalModelHintIsInExistingRequest', mock.captured.expressionTagHint === true, String(mock.captured.expressionTagHint));
    await cdp.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
    await evaluate(cdp,"loadChatMessages()");
    check('expression.chatRespectsReducedMotion', await waitFor(cdp,"(function(){var d=document.querySelector('#chat-messages [data-msg-id=expr_auto_probe] .ib-expression-message-display'),img=d&&d.querySelector('img');return !!d&&!d.hasAttribute('data-action')&&img&&getComputedStyle(img).animationName==='none'})()",5000));
    await cdp.send('Emulation.setEmulatedMedia',{features:[]});
    await evaluate(cdp,"loadChatMessages()");
    await evaluate(cdp, "window.IBExpressionPacks.applyChatGreeting('smoke_friend')");
    check('expression.chatGreetingEventUsesConfiguredImage', await evaluate(cdp, "!!document.querySelector('#chat-header-name .ib-expression-state[data-expression-state=greetingExpression] img')&&!!document.querySelector('#chat-context-title .ib-expression-state[data-expression-state=greetingExpression] img')"));
    await evaluate(cdp, "_ibTypingOn('smoke_friend',null,'SmokeAI','typing','smoke_friend')");
    check('expression.chatTypingEventUsesConfiguredImage', await evaluate(cdp, "!!document.querySelector('#chat-messages #chat-typing-smoke_friend .ib-expression-state[data-expression-state=typingExpression] img')"));
    await evaluate(cdp, "_ibTypingOff('smoke_friend')");
    check('expression.chatTypingImageClearsWithTypingState', await evaluate(cdp, "!document.querySelector('#chat-messages #chat-typing-smoke_friend .ib-expression-state')"));
    check('expression.chatVoicePlaybackOverridesAndRestoresDefault', await evaluate(cdp, "(async function(){var originalAudio=window.Audio,id='expr_voice_probe',host=document.createElement('div'),voice=document.createElement('div');await dbPut('chatMessages',{id:id,role:'assistant',content:'',friendId:'smoke_friend',timestamp:Date.now(),metadata:{config_id:'smoke_friend'}});host.className='chat-msg ai';host.dataset.msgId=id;host.appendChild(voice);document.getElementById('chat-messages').appendChild(host);window.Audio=function(){this.paused=true;this.play=function(){this.paused=false;return Promise.resolve()};this.pause=function(){this.paused=true}};window._vmTogglePlay(voice,{dataUrl:'data:audio/wav;base64,AAAA',duration:1});await new Promise(function(resolve){setTimeout(resolve,50)});var display=host.querySelector('.ib-expression-message-display'),cfg=await dbGet('apiConfigs','smoke_friend'),voiceRef=window.IBExpressionPackCore.expressionForState(cfg,'voiceExpression'),shown=!!(display&&display.dataset.expressionState==='voiceExpression'&&voiceRef&&display.querySelector('img').src===voiceRef.expression.dataUrl);window._vmStopAudio();var restored=host.querySelector('.ib-expression-message-display');window.Audio=originalAudio;host.remove();await dbDelete('chatMessages',id);return shown&&!!restored&&restored.dataset.expressionState==='neutralExpression'})()"));
    await evaluate(cdp, "window.__expressionErrorRow=window._chatAppendErrorDisclosure(document.getElementById('chat-messages'),{title:'测试异常'},{scope:'test',roleId:'smoke_friend'})");
    check('expression.chatErrorEventUsesOptionalImage', await evaluate(cdp, "!!(window.__expressionErrorRow&&window.__expressionErrorRow.querySelector('.ib-expression-state[data-expression-state=errorExpression] img'))"));
    await evaluate(cdp, "if(window.__expressionErrorRow)window.__expressionErrorRow.remove();window.__expressionErrorRow=null");
    /* P3.1 · real sendChatMessage path, existing chatMessages authority, exact source validation,
       clickable location, reload persistence, and safe degradation after deletion. */
    const quoteSourceText = '我把周末的安排改了。最想引用的那句话。最后再补一点细节。';
    await evaluate(cdp, "(async function(){var cfg=Object.assign({},window.__smoke_cfg,{id:'quote_smoke_friend',nickname:'QuoteSmoke'});await dbPut('apiConfigs',cfg);await loadApiConfigs();activeFriendId='quote_smoke_friend';activeThreadId=null;await dbPut('chatMessages',{id:'quote_source_msg',role:'user',content:'" + quoteSourceText + "',friendId:'quote_smoke_friend',timestamp:Date.now()-5000});await loadChatMessages();return true})()");
    await evaluate(cdp, "(async function(){document.getElementById('chat-input').value='quote_target_probe 请回应。';window.__quoteSendResult=await sendChatMessage();return true})()");
    check('quote.chatPersistsVerifiedCanonicalPointer', await waitFor(cdp, "(async function(){var r=window.__quoteSendResult,m=r&&r.messageId&&await dbGet('chatMessages',r.messageId),q=m&&m.metadata&&m.metadata.replyQuote;return !!q&&q.sourceMessageId==='quote_source_msg'&&q.snippet==='最想引用的那句话。'&&q.sourceSenderKey==='user:local'&&m.content.indexOf('<ib_reply_quote>')<0})()", 10000));
    check('quote.chatCardRendersAndLocatesOriginal', await waitFor(cdp, "(function(){var q=document.querySelector('#chat-messages .ib-reply-quote-card[data-source-message-id=quote_source_msg]'),src=document.querySelector('#chat-messages [data-msg-id=quote_source_msg]');if(q)q.click();return !!q&&q.textContent.indexOf('最想引用的那句话。')>=0&&!!src&&src.classList.contains('ib-reply-quote-target')})()", 4000));
    await evaluate(cdp, "(async function(){await loadChatMessages();return true})()");
    check('quote.chatHistoryReloadRevalidatesPointer', await evaluate(cdp, "(function(){var q=document.querySelector('#chat-messages .ib-reply-quote-card[data-source-message-id=quote_source_msg]');return !!q&&!q.disabled&&q.textContent.indexOf('最想引用的那句话。')>=0})()"));
    await evaluate(cdp, "(async function(){var b=document.querySelector('#chat-messages [data-msg-id=quote_source_msg]');await deleteSingleMsg('quote_source_msg',b);return true})()");
    check('quote.chatDeletionDegradesVisibleCard', await evaluate(cdp, "(function(){var q=document.querySelector('#chat-messages .ib-reply-quote-card[data-source-message-id=quote_source_msg]');return !!q&&q.disabled&&q.textContent.indexOf('原消息不可用')>=0})()"));
    await evaluate(cdp, "(async function(){await loadChatMessages();return true})()");
    check('quote.chatDeletionRemainsUnavailableAfterReload', await evaluate(cdp, "(function(){var q=document.querySelector('#chat-messages .ib-reply-quote-card.is-unavailable');return !!q&&q.textContent.indexOf('原消息不可用')>=0})()"));
    await evaluate(cdp, "(async function(){await dbPut('chatMessages',{id:'quote_withdraw_source',role:'user',content:'这条会随后撤回。',friendId:'quote_smoke_friend',timestamp:Date.now()-5000});await loadChatMessages();document.getElementById('chat-input').value='quote_withdraw_probe';window.__quoteWithdrawResult=await sendChatMessage();return true})()");
    check('quote.chatWithdrawPointerTargetsCanonicalSource', await waitFor(cdp, "(async function(){var r=window.__quoteWithdrawResult,m=r&&r.messageId&&await dbGet('chatMessages',r.messageId),q=m&&m.metadata&&m.metadata.replyQuote;return !!q&&q.sourceMessageId==='quote_withdraw_source'&&q.snippet==='这条会随后撤回。'})()", 10000));
    await evaluate(cdp, "(async function(){await _chatWithdrawMsg('quote_withdraw_source');return true})()");
    check('quote.chatWithdrawalDegradesVisibleCard', await evaluate(cdp, "(function(){var q=document.querySelector('#chat-messages .ib-reply-quote-card[data-source-message-id=quote_withdraw_source]');return !!q&&q.disabled&&q.textContent.indexOf('原消息不可用')>=0})()"));
    await evaluate(cdp, "(async function(){await loadChatMessages();return true})()");
    check('quote.chatWithdrawalRemainsUnavailableAfterReload', await evaluate(cdp, "(function(){var q=document.querySelector('#chat-messages .ib-reply-quote-card[data-source-message-id=quote_withdraw_source]');return !!q&&q.disabled&&q.textContent.indexOf('原消息不可用')>=0})()"));
    /* P5-B3-K · real chat text creates only a pending candidate; the button
       calls the existing structured report action, never a Memory operation. */
    await evaluate(cdp, "(function(){window.__freeTextReportCalls=[];window.IB.homeNode=window.IB.homeNode||{};window.IB.homeNode.explicitPreferenceReport={available:true,submit:function(payload){window.__freeTextReportCalls.push(JSON.parse(JSON.stringify(payload)));return Promise.resolve({ok:true,outcome:'accepted',reportId:'browser-report-1'})}};var prior=window.dbPut;window.__freeTextMemoryWrites=0;window.dbPut=function(){if(arguments[0]==='memories'||arguments[0]==='relationships')window.__freeTextMemoryWrites++;return prior.apply(this,arguments)};return true})()");
    await evaluate(cdp, "(async function(){activeFriendId='smoke_friend';activeThreadId=null;document.getElementById('chat-input').value='I like scifi';window.__freeTextLikeResult=await sendChatMessage();return true})()");
    check('ftr.likeCreatesOnlyCandidateInRealChat', await waitFor(cdp, "(function(){var r=window.__freeTextLikeResult,b=null;if(r)document.querySelectorAll('#chat-messages .chat-msg.user[data-msg-id]').forEach(function(x){if(x.dataset.msgId===String(r.userMessageId))b=x});var c=b&&b.querySelector('.chat-free-text-report-candidate');return !!c&&c.textContent.indexOf('喜欢 scifi')>=0&&window.__freeTextReportCalls.length===0})()", 8000));
    await evaluate(cdp, "(function(){var r=window.__freeTextLikeResult,b=null;document.querySelectorAll('#chat-messages .chat-msg.user[data-msg-id]').forEach(function(x){if(x.dataset.msgId===String(r.userMessageId))b=x});b.querySelector('[data-report-candidate-confirm]').click();return true})()");
    check('ftr.confirmClickUsesStructuredReportAction', await waitFor(cdp, "(function(){var r=window.__freeTextLikeResult,b=null;if(r)document.querySelectorAll('#chat-messages .chat-msg.user[data-msg-id]').forEach(function(x){if(x.dataset.msgId===String(r.userMessageId))b=x});var c=b&&b.querySelector('.chat-free-text-report-candidate');return !!c&&c.textContent.indexOf('已提交结构化偏好报告')>=0&&window.__freeTextReportCalls.length===1})()", 8000));
    check('ftr.confirmPayloadIsClosedAndMemoryWritesStayZero', await evaluate(cdp, "(function(){var p=window.__freeTextReportCalls[0];return !!p&&JSON.stringify(Object.keys(p).sort())===JSON.stringify(['characterId','requestId','stance','targetKey','threadId'])&&p.characterId==='smoke_friend'&&p.targetKey==='scifi'&&p.stance==='like'&&p.threadId===''&&window.__freeTextMemoryWrites===0})()"));
    await evaluate(cdp, "(async function(){document.getElementById('chat-input').value='I dislike scifi';window.__freeTextDislikeResult=await sendChatMessage();return true})()");
    check('ftr.dislikeNeedsItsOwnConfirmation', await waitFor(cdp, "(function(){var r=window.__freeTextDislikeResult,b=null;if(r)document.querySelectorAll('#chat-messages .chat-msg.user[data-msg-id]').forEach(function(x){if(x.dataset.msgId===String(r.userMessageId))b=x});var c=b&&b.querySelector('.chat-free-text-report-candidate');return !!c&&c.textContent.indexOf('不喜欢 scifi')>=0&&window.__freeTextReportCalls.length===1})()", 8000));
    await evaluate(cdp, "(function(){var r=window.__freeTextDislikeResult,b=null;document.querySelectorAll('#chat-messages .chat-msg.user[data-msg-id]').forEach(function(x){if(x.dataset.msgId===String(r.userMessageId))b=x});b.querySelector('[data-report-candidate-dismiss]').click();return true})()");
    check('ftr.declineDismissesWithoutReport', await waitFor(cdp, "(function(){var r=window.__freeTextDislikeResult,b=null;if(r)document.querySelectorAll('#chat-messages .chat-msg.user[data-msg-id]').forEach(function(x){if(x.dataset.msgId===String(r.userMessageId))b=x});var c=b&&b.querySelector('.chat-free-text-report-candidate');return !!c&&c.textContent.indexOf('已忽略')>=0&&window.__freeTextReportCalls.length===1})()", 5000));
    await evaluate(cdp, "(async function(){document.getElementById('chat-input').value='“I like scifi”';window.__freeTextQuoteResult=await sendChatMessage();return true})()");
    check('ftr.quotedTextProducesNoCandidateCard', await evaluate(cdp, "(function(){var r=window.__freeTextQuoteResult,b=null;if(r)document.querySelectorAll('#chat-messages .chat-msg.user[data-msg-id]').forEach(function(x){if(x.dataset.msgId===String(r.userMessageId))b=x});return !!b&&!b.querySelector('.chat-free-text-report-candidate')&&window.__freeTextReportCalls.length===1})()"));
    await evaluate(cdp, "(async function(){activeFriendId='smoke_friend';document.getElementById('chat-input').value='I like scifi';window.__freeTextStaleResult=await sendChatMessage();return true})()");
    check('ftr.staleCandidateAppearsInItsSourceConversation', await waitFor(cdp, "(function(){var r=window.__freeTextStaleResult,b=null;if(r)document.querySelectorAll('#chat-messages .chat-msg.user[data-msg-id]').forEach(function(x){if(x.dataset.msgId===String(r.userMessageId))b=x});return !!(b&&b.querySelector('[data-report-candidate-confirm]'))})()", 8000));
    await evaluate(cdp, "(function(){activeFriendId='other_character';var r=window.__freeTextStaleResult,b=null;document.querySelectorAll('#chat-messages .chat-msg.user[data-msg-id]').forEach(function(x){if(x.dataset.msgId===String(r.userMessageId))b=x});b.querySelector('[data-report-candidate-confirm]').click();return true})()");
    check('ftr.wrongConversationStalesCandidateWithoutReport', await waitFor(cdp, "(function(){var r=window.__freeTextStaleResult,b=null;if(r)document.querySelectorAll('#chat-messages .chat-msg.user[data-msg-id]').forEach(function(x){if(x.dataset.msgId===String(r.userMessageId))b=x});var c=b&&b.querySelector('.chat-free-text-report-candidate');return !!c&&c.textContent.indexOf('候选已过期')>=0&&window.__freeTextReportCalls.length===1})()", 8000));
    await evaluate(cdp, "(function(){activeFriendId='smoke_friend';return true})()");
    check('d41c.miniMessageActionsRemainReachable',await evaluate(cdp,"(function(){var m=document.querySelector('#chat-messages .chat-msg.ai'),f=m&&m.querySelector('.chat-msg-fav'),more=m&&m.querySelector('.chat-msg-more');return !!f&&!!more&&f.getAttribute('aria-label')==='收藏此消息'&&more.getAttribute('aria-label')==='更多消息操作'&&f.getBoundingClientRect().width>=44&&more.getBoundingClientRect().height>=44})()"),await evaluate(cdp,"(function(){var m=document.querySelector('#chat-messages .chat-msg.ai'),f=m&&m.querySelector('.chat-msg-fav'),more=m&&m.querySelector('.chat-msg-more'),box=function(x){if(!x)return null;var r=x.getBoundingClientRect();return {tag:x.tagName,label:x.getAttribute('aria-label'),w:r.width,h:r.height,cls:x.className}};return JSON.stringify({message:m&&m.textContent,fav:box(f),more:box(more),width:innerWidth})})()"));
    await evaluate(cdp,"(function(){var b=document.querySelector('#chat-messages .chat-msg.ai .chat-msg-more');b.focus();b.click();return true})()");
    check('d41c.miniMessagePopoverOpens',await waitFor(cdp,"(function(){var b=document.querySelector('#chat-messages .chat-msg.ai .chat-msg-more'),p=b&&document.getElementById(b.getAttribute('aria-controls'));return !!p&&p.matches(':popover-open')&&b.getAttribute('aria-expanded')==='true'})()",3000));
    await cdp.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27,nativeVirtualKeyCode:27});
    await cdp.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27,nativeVirtualKeyCode:27});
    await evaluate(cdp, "(async function(){ window.__voiceCallResult = await sendChatMessage({voiceCall:true,transcript:'voice call transcript',callSessionId:'call-smoke',turnId:'turn-smoke',roleId:'smoke_friend',conversationId:'main:smoke_friend'}); })()");
    check('voiceCall.chatRuntimeReply', await waitFor(cdp, "window.__voiceCallResult && window.__voiceCallResult.ok === true && typeof window.__voiceCallResult.replyText === 'string'", 15000));
    check('voiceCall.transcriptPersisted', await evaluate(cdp, "(async function(){ var all=await dbGetAll('chatMessages'); return all.some(function(m){return m.friendId==='smoke_friend'&&m.role==='user'&&m.content==='voice call transcript'&&m.metadata&&m.metadata.source==='voice_call'&&m.metadata.callSessionId==='call-smoke';}); })()"));
    check('voiceCall.uiMounted', await evaluate(cdp, "!!document.getElementById('voice-call-modal') && !!document.getElementById('voice-call-launch-full') && window.IB.voiceCall && typeof window.IB.voiceCall.start === 'function'"));
    check('voiceCall.singleMicControl', await evaluate(cdp, "(function(){ var c=document.querySelectorAll('#voice-call-modal .voice-call-controls .voice-call-control'); return !!document.getElementById('voice-call-mute') && !!document.getElementById('voice-call-speaker') && !document.getElementById('voice-call-mic') && c.length===3; })()"));
    check('voiceCall.muteToggle', await evaluate(cdp, "(function(){ var call=Object.create(window.IB.voiceCall.VoiceCall.prototype); call.micMuted=false; call.speaking=false; call.toggleMute(); var btn=document.getElementById('voice-call-mute'); var on=call.micMuted===true && btn && btn.className.indexOf('muted')!==-1; call.toggleMute(); var off=call.micMuted===false && btn.className.indexOf('muted')===-1; return on && off; })()"));
    const voiceStateProjection = await evaluate(cdp, "(function(){var actual=window.IBExpressionPacks,calls=[],root=document.getElementById('voice-call-modal'),cfg=window.apiConfigs.find(function(x){return x.id==='smoke_friend'}),oldSettings=cfg&&cfg.expressionSettings?JSON.parse(JSON.stringify(cfg.expressionSettings)):null,oldMotion=root.dataset.motion,call=Object.create(window.IB.voiceCall.VoiceCall.prototype);cfg=cfg||{id:'smoke_friend'};cfg.expressionSettings=Object.assign({},cfg.expressionSettings||{},{microMotion:false});window.IBExpressionPacks={clearRoleState:function(){},applyRoleState:function(role,state,host){calls.push({role:role,state:state,host:host.id});return true}};call.roleId='smoke_friend';call.state='idle';call.connectedAt=1;call.durationTimer=1;['listening','thinking','speaking','interrupted','idle','error'].forEach(function(state){call.setState(state)});var result={states:calls.map(function(x){return x.state}),roles:calls.every(function(x){return x.role==='smoke_friend'&&x.host==='voice-call-expression'}),status:root.dataset.voiceStatus,visibleLabel:document.getElementById('voice-call-state').textContent,motionOff:root.dataset.motion==='off'};window.IBExpressionPacks=actual;if(oldSettings)cfg.expressionSettings=oldSettings;else delete cfg.expressionSettings;if(oldMotion)root.dataset.motion=oldMotion;else delete root.dataset.motion;return result})()");
    check('voiceCall.stateExpressionProjectionAndRoleMotionSetting', voiceStateProjection && JSON.stringify(voiceStateProjection.states) === JSON.stringify(['neutralExpression','typingExpression','voiceExpression','neutralExpression','neutralExpression','errorExpression']) && voiceStateProjection.roles && voiceStateProjection.status === 'error' && voiceStateProjection.visibleLabel === 'Error' && voiceStateProjection.motionOff, JSON.stringify(voiceStateProjection));
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    const voiceCallDesktopThemes = await evaluate(cdp, "(function(){var root=document.getElementById('voice-call-modal'),panel=root.querySelector('.voice-call-panel'),status=document.getElementById('voice-call-state'),wasHidden=root.hidden,wasAria=root.getAttribute('aria-hidden'),wasDark=document.body.classList.contains('theme-infernal'),oldMotion=root.dataset.motion,call=Object.create(window.IB.voiceCall.VoiceCall.prototype);try{root.hidden=false;root.setAttribute('aria-hidden','false');call.roleId='smoke_friend';call.state='idle';call.connectedAt=1;call.durationTimer=1;call.setState('speaking');document.body.classList.remove('theme-infernal');var lightTheme=!document.body.classList.contains('theme-infernal'),light=getComputedStyle(root).backgroundColor;document.body.classList.add('theme-infernal');var darkTheme=document.body.classList.contains('theme-infernal'),dark=getComputedStyle(root).backgroundColor,r=panel.getBoundingClientRect();return {light:light,dark:dark,lightTheme:lightTheme,darkTheme:darkTheme,status:status.textContent,voiceStatus:root.dataset.voiceStatus,width:r.width,scroll:document.documentElement.scrollWidth,inner:innerWidth,controls:Array.from(root.querySelectorAll('.voice-call-control')).every(function(b){return b.getBoundingClientRect().width>=44&&b.getBoundingClientRect().height>=44})}}finally{root.hidden=wasHidden;root.setAttribute('aria-hidden',wasAria||'true');if(!wasDark)document.body.classList.remove('theme-infernal');if(oldMotion)root.dataset.motion=oldMotion;else delete root.dataset.motion}})()");
    check('voiceCall.desktopThemeStateAndControls', voiceCallDesktopThemes && !!voiceCallDesktopThemes.light && !!voiceCallDesktopThemes.dark && voiceCallDesktopThemes.lightTheme && voiceCallDesktopThemes.darkTheme && voiceCallDesktopThemes.status === 'Speaking' && voiceCallDesktopThemes.voiceStatus === 'speaking' && voiceCallDesktopThemes.width <= voiceCallDesktopThemes.inner && voiceCallDesktopThemes.scroll <= voiceCallDesktopThemes.inner && voiceCallDesktopThemes.controls, JSON.stringify(voiceCallDesktopThemes));
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 375, height: 812, deviceScaleFactor: 1, mobile: false });
    const voiceCallNarrow = await evaluate(cdp, "(function(){var root=document.getElementById('voice-call-modal'),wasHidden=root.hidden,wasAria=root.getAttribute('aria-hidden');try{root.hidden=false;root.setAttribute('aria-hidden','false');var panel=root.querySelector('.voice-call-panel').getBoundingClientRect(),avatar=document.getElementById('voice-call-avatar').getBoundingClientRect(),controls=root.querySelector('.voice-call-controls').getBoundingClientRect();return {inner:innerWidth,scroll:document.documentElement.scrollWidth,panel:panel.width,panelLeft:panel.left,panelRight:panel.right,avatar:avatar.width,controls:controls.width,state:root.dataset.voiceStatus}}finally{root.hidden=wasHidden;root.setAttribute('aria-hidden',wasAria||'true')}})()");
    check('voiceCall.narrowDialogFitsAndKeepsSpeakingState', voiceCallNarrow && voiceCallNarrow.scroll <= voiceCallNarrow.inner && voiceCallNarrow.panel <= voiceCallNarrow.inner && voiceCallNarrow.panelLeft >= -1 && voiceCallNarrow.panelRight <= voiceCallNarrow.inner + 1 && voiceCallNarrow.avatar > 0 && voiceCallNarrow.controls <= voiceCallNarrow.inner && voiceCallNarrow.state === 'speaking', JSON.stringify(voiceCallNarrow));
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    const voiceInterruptGuard = await evaluate(cdp, "(function(){var call=Object.create(window.IB.voiceCall.VoiceCall.prototype),sent=[],oldStop=window.stopStreaming;window.stopStreaming=function(){};call.state='speaking';call.roleId='voice-role-a';call.playing=true;call.sinkActive=true;call.speaking=false;call.generationId=9;call.asrGeneration=1;call.turnEpoch=0;call.destroyed=false;call.stopAudio=function(){this.playing=false};call.send=function(value){sent.push(value)};call.setState=function(value){this.state=value};var first=call.interrupt('button'),second=call.interrupt('button');call.onMessage({type:'state',mode:'speaking',generation_id:9});var staleStateIgnored=call.state==='interrupted';call.onMessage({type:'reply_text',generation_id:9,text:'stale'});var staleReplyIgnored=call.replyText!== 'stale';call.onMessage({type:'interrupted',next_generation_id:10});window.stopStreaming=oldStop;return {first:first,second:second,interrupts:sent.filter(function(x){return x.type==='interrupt'}).length,generation:call.generationId,state:call.state,staleStateIgnored:staleStateIgnored,staleReplyIgnored:staleReplyIgnored}})()");
    check('voiceCall.repeatedInterruptIsIdempotentAndDropsStaleReply', voiceInterruptGuard && voiceInterruptGuard.first && !voiceInterruptGuard.second && voiceInterruptGuard.interrupts === 1 && voiceInterruptGuard.generation === 10 && voiceInterruptGuard.state === 'interrupted' && voiceInterruptGuard.staleStateIgnored && voiceInterruptGuard.staleReplyIgnored, JSON.stringify(voiceInterruptGuard));
    const chatVoiceStateRes = await evaluate(cdp, "(async function(){var cfg=window.apiConfigs.find(function(x){return x.id==='smoke_friend'}),oldVoice=cfg&&cfg.voice?JSON.parse(JSON.stringify(cfg.voice)):null,oldFetch=window.fetch,oldPrefs=localStorage.getItem('ib_voice_prefs'),root=document.getElementById('chat-full-messages'),bubble=document.createElement('div'),aborted=false;try{if(!cfg||!root)return {missingConfig:!cfg};var prefs={};try{prefs=JSON.parse(oldPrefs||'{}')}catch(e){}prefs.showVoiceButton=true;localStorage.setItem('ib_voice_prefs',JSON.stringify(prefs));cfg.voice=Object.assign({},cfg.voice||{},{enabled:true,autoPlay:false,source:'edge',provider:'edge',voiceId:'smoke-voice'});bubble.className='chat-msg ai';bubble.dataset.msgId='voice-state-smoke';bubble.dataset.senderId='smoke_friend';bubble.innerHTML='<div class=\"r-text\">State projection smoke</div>';root.appendChild(bubble);window.fetch=function(input,options){var o=options||{};if(String(input).indexOf('/api/tts')>=0)return new Promise(function(resolve,reject){if(o.signal){if(o.signal.aborted){aborted=true;reject(new Error('aborted'));return}o.signal.addEventListener('abort',function(){aborted=true;var e=new Error('aborted');e.name='AbortError';reject(e)},{once:true})}});return oldFetch.apply(this,arguments)};var until=Date.now()+1500,button=null;while(Date.now()<until&&!button){button=bubble.querySelector('.ib-tts-btn');if(!button)await new Promise(function(r){setTimeout(r,10)})}if(!button)return {button:false};button.click();await Promise.resolve();var during=bubble.dataset.voiceStatus||'';var stopped=window.IB.bridge.stopVoicePlayback(document.getElementById('page-chat'));await new Promise(function(r){setTimeout(r,0)});return {button:true,during:during,after:bubble.dataset.voiceStatus||'',aborted:aborted,stopped:stopped}}finally{window.fetch=oldFetch;if(oldPrefs==null)localStorage.removeItem('ib_voice_prefs');else localStorage.setItem('ib_voice_prefs',oldPrefs);if(cfg){if(oldVoice)cfg.voice=oldVoice;else delete cfg.voice}if(bubble.parentNode)bubble.remove()}})()");
    check('chat.ttsProjectsThinkingAndPageStopCancelsPendingPlayback', chatVoiceStateRes && chatVoiceStateRes.button && chatVoiceStateRes.during === 'thinking' && chatVoiceStateRes.after === 'interrupted' && chatVoiceStateRes.aborted && chatVoiceStateRes.stopped, JSON.stringify(chatVoiceStateRes));
    const chatCaptureCancelRes = await evaluate(cdp, "(function(){var prior=window._vmSt,header=document.getElementById('chat-header-name'),controller={aborted:false,abort:function(){this.aborted=true}},st={purpose:'chat',friendId:'smoke_friend',released:false,cancelled:false,cancelController:controller,timer:null,btn:{classList:{remove:function(){}}},recog:null,rec:null,stream:null};window._vmSt=st;var cancelled=window._vmCancelCapture('role-switch'),result={cancelled:cancelled,discarded:st.cancelled&&window._vmSt===null,providerAbort:controller.aborted,state:header&&header.dataset.voiceStatus};window._vmSt=prior;try{if(window.IBExpressionPacks&&window.IBExpressionPacks.applyChatGreeting)window.IBExpressionPacks.applyChatGreeting('smoke_friend');if(header){delete header.dataset.voiceStatus;delete header.dataset.voiceRoleId}}catch(e){}return result})()");
    check('chat.roleSwitchCancelsPendingCaptureAndResetsVoiceState', chatCaptureCancelRes && chatCaptureCancelRes.cancelled && chatCaptureCancelRes.discarded && chatCaptureCancelRes.providerAbort && chatCaptureCancelRes.state === 'interrupted', JSON.stringify(chatCaptureCancelRes));

    /* 4.7 P1 · Call 声学语气参考 端到端：真实 sendChatMessage → LLM request + dbPut(chatMessages)
       acousticReference 由 call.js 在当前 turn 计算（此处如实传入一次 tone 子句），
       证明：① LLM 收到 [Acoustic reference] 块；② chatMessages 持久化只有原始 transcript；
             ③ UI transcript 不含 reference。 */
    const acRefText = '情绪倾向:平静/中性(较低置信)；语速中等(3.4字/秒)；音量中等；停顿较少';
    mock.captured.acoustic = false;
    await evaluate(cdp, "(async function(){ window.__acRefResult = await sendChatMessage({voiceCall:true,transcript:'acoustic ref call transcript',acousticReference:'" + acRefText + "',callSessionId:'ac-call',turnId:'ac-turn',roleId:'smoke_friend',conversationId:'main:smoke_friend'}); })()");
    check('acref.llmReceived', (await waitFor(cdp, "window.__acRefResult && window.__acRefResult.ok === true", 15000)) && mock.captured.acoustic === true);
    /* ② 持久化：chatMessages 的 user 消息内容 == 原始 transcript（精确、无 reference） */
    check('acref.persistedIsTranscript', await evaluate(cdp, "(async function(){ var all=await dbGetAll('chatMessages'); return all.some(function(m){return m.friendId==='smoke_friend'&&m.role==='user'&&m.content==='acoustic ref call transcript'&&m.metadata&&m.metadata.source==='voice_call'&&String(m.content).indexOf('Acoustic reference')===-1;}); })()"));
    /* ③ UI transcript：渲染的用户气泡文本含原话、不含 reference */
    check('acref.uiNoReference', await evaluate(cdp, "(function(){ var m=document.getElementById('chat-messages'); var t=(m&&m.textContent)||''; return t.indexOf('acoustic ref call transcript')!==-1 && t.indexOf('Acoustic reference')===-1; })()"));

    /* 4.8 P2 · Video Runtime 帧 → LLM（request-local）：真实 sendChatMessage → 复用既有视觉路由
       （smoke_friend 默认可看 → 帧作 image part 进请求）。证明：LLM 收到帧；持久化只有原 transcript；
       Memory/UI 不含帧。 */
    mock.captured.vision = false;
    await evaluate(cdp, "(async function(){ var cv=document.createElement('canvas');cv.width=64;cv.height=48;var cx=cv.getContext('2d');cx.fillStyle='#2a6';cx.fillRect(0,0,64,48);cx.fillStyle='#fc0';cx.fillRect(20,10,24,28);var du=cv.toDataURL('image/jpeg',0.8);window.__vframe=du;window.__vitRefResult=await sendChatMessage({voiceCall:true,transcript:'video frame call',visionReference:{dataUrl:du},callSessionId:'vit-call',turnId:'vit-turn',roleId:'smoke_friend',conversationId:'main:smoke_friend'}); })()");
    check('vit.llmReceivedFrame', (await waitFor(cdp, "window.__vitRefResult && window.__vitRefResult.ok === true", 15000)) && mock.captured.vision === true);
    check('vit.persistedIsTranscript', await evaluate(cdp, "(async function(){ var all=await dbGetAll('chatMessages'); return all.some(function(m){return m.friendId==='smoke_friend'&&m.role==='user'&&m.content==='video frame call'&&String(m.content).indexOf('data:image/jpeg')===-1;}); })()"));
    check('vit.memoryNoFrame', await evaluate(cdp, "(async function(){ var mem=await dbGetAll('memories'); return !mem.some(function(m){return String((m.content||'')+(m.summary||'')).indexOf('data:image/jpeg')===0;}); })()"));
    check('vit.uiNoFrame', await evaluate(cdp, "(function(){ var m=document.getElementById('chat-messages'); var t=(m&&m.textContent)||''; return t.indexOf('video frame call')!==-1 && t.indexOf('data:image/jpeg')===-1; })()"));

    /* 4.9 P2 · Call modal 视频面 UI：注入相机开关 + 视频预览；不破坏 .voice-call-controls 计数 */
    await evaluate(cdp, "window._mountCallVideoSurface({})");
    check('videoUI.mounted', await evaluate(cdp, "(function(){ return !!document.getElementById('voice-call-cam') && !!document.getElementById('voice-call-video') && !!document.getElementById('voice-call-video-el'); })()"));
    check('videoUI.controlsStill3', await evaluate(cdp, "(function(){ return document.querySelectorAll('#voice-call-modal .voice-call-controls .voice-call-control').length === 3; })()"));


    /* 2. 信件：落库 → loadLetters 渲染 → openLetter → deleteLetter */
    await evaluate(cdp, "dbPut('letters', { id:'smoke_letter', to:'Sui', from:'测试者', content:'这是一封测试信。', reply_to:'', read:false, created:Date.now() })");
    await evaluate(cdp, "loadLetters()");
    check('letters.card', await waitFor(cdp, "!!document.getElementById('letter-smoke_letter')", 8000));
    await evaluate(cdp, "openLetter('smoke_letter')");
    check('letters.open', await evaluate(cdp, "document.getElementById('letter-smoke_letter').style.display !== 'none'"));
    await evaluate(cdp, "deleteLetter('smoke_letter')");
    check('letters.delete', await waitFor(cdp, "!document.getElementById('letter-smoke_letter')", 8000));

    /* 3. 批注：种子日志 → _annoPickAI 打开输入条 → 填写 → _annoSend（mock 模型） */
    await evaluate(cdp, "dbPut('posts', { id:'smoke_post', title:'测试日志', content:'第一段内容。', category:'日志', locked:false, created:Date.now(), updated:Date.now() })");
    await evaluate(cdp, "_annoPickAI('smoke_friend')");
    check('anno.barOpen', await waitFor(cdp, "document.getElementById('anno-input-bar') && document.getElementById('anno-input-bar').classList.contains('show')", 8000));
    await evaluate(cdp, "(function(){ _annoPostId='smoke_post'; _annoSelText='第一段内容。'; _annoParaIdx=0; document.getElementById('anno-inp-field').value='写点什么吧。'; })()");
    await evaluate(cdp, "_annoSend()");
    check('anno.saved', await waitFor(cdp, "(async function(){ var all = await dbGetAll('blogAnnotations'); return all.some(a => a.postId === 'smoke_post' && a.aiId === 'smoke_friend'); })()", 15000));
    /* 关闭输入条 → 重新渲染 → 批注仍在（Codex 要求的持久化覆盖） */
    await evaluate(cdp, "_annoHideAll()");
    check('anno.close', await evaluate(cdp, "document.getElementById('anno-input-bar') && !document.getElementById('anno-input-bar').classList.contains('show')"));
    await evaluate(cdp, "_renderAnnotationsForPost('smoke_post')");
    check('anno.rerenderPersists', await evaluate(cdp, "(async function(){ var all = await dbGetAll('blogAnnotations'); return all.some(a => a.postId === 'smoke_post' && a.aiId === 'smoke_friend' && typeof a.content === 'string'); })()"));

    /* 4. 摘要设置往返（DOM 表单 → save → get）+ 设置 UI 无异常 */
    await evaluate(cdp, "(function(){ var t=document.getElementById('api-summary-toggle'); if(t) t.checked = true; })()");
    await evaluate(cdp, "saveSummarySettings()");
    check('summary.roundtrip', await evaluate(cdp, "(async function(){ var s = await getSummarySettings(); return s && s.enabled === true && s.keepCount >= 1; })()"));
    await evaluate(cdp, "loadSummarySettingsUI()");
    check('summary.ui', await evaluate(cdp, "typeof document.getElementById('summary-mgmt-list') === 'object'"));
    /* 摘要存档往返 + mock 模型真实生成（提取后的 summary.js 全链路） */
    await evaluate(cdp, "saveChatSummary('smoke_friend', null, 'smoke-summary-text', Date.now())");
    check('summary.saveGet', await evaluate(cdp, "(async function(){ var s = await getChatSummary('smoke_friend', null); return !!s && s.summary === 'smoke-summary-text'; })()"));
    await evaluate(cdp, "(function(){ var cfg=apiConfigs.find(function(a){return a.id==='smoke_friend'}); return generateSummary(cfg, null, [{role:'user',content:'你好'},{role:'assistant',content:'回复'}], 200).then(function(r){ window.__summaryResult = r; }); })()");
    check('summary.generate', await waitFor(cdp, "typeof window.__summaryResult === 'string' && window.__summaryResult.indexOf('mock') >= 0", 15000));

    /* 4.5 语音模块 mock 行为断言（无真实麦克风/扬声器：状态机与 DOM 接触面） */
    check('voice.dualAttach', await evaluate(cdp, "typeof window._vmInit === 'function' && window.IB.chat.voice && typeof window.IB.chat.voice._vmInit === 'function' && typeof window._buildVoiceEl === 'function' && typeof window.IB.chat.voice._buildVoiceEl === 'function'"));
    check('voice.supported', await evaluate(cdp, "(function(){ var v = _vmSupported(); return typeof v === 'boolean'; })()"));
    check('voice.errorMsg', await evaluate(cdp, "String(_vmRecogErrMsg('no-speech')).indexOf('未检测到人声') >= 0"));
    check('voice.apiLine', await evaluate(cdp, "String(_voiceApiLine({ duration: 5 })).indexOf('语音消息') >= 0"));
    check('voice.buildEl', await evaluate(cdp, "(function(){ var el = _buildVoiceEl({ duration: 3, dataUrl: 'data:audio/wav;base64,AAA=' }); return el.className === 'chat-voice-bar' && el.title === '点击播放语音' && el.innerHTML.indexOf('3\u2033') >= 0 && typeof el.onclick === 'function'; })()"));
    check('voice.togglePlay', await evaluate(cdp, "(function(){ var el = _buildVoiceEl({ duration: 1, dataUrl: 'data:audio/wav;base64,AAA=' }); _vmTogglePlay(el, { duration: 1, dataUrl: 'data:audio/wav;base64,AAA=' }); var ok = !!_vmAudio && _vmPlayingEl === el && el.classList.contains('playing'); _vmAudio = null; _vmPlayingEl = null; el.classList.remove('playing'); return ok; })()"));
    check('voice.initNoThrow', await evaluate(cdp, "(function(){ try { _vmInit(); return true; } catch(e) { return false; } })()"));

    /* 4.6 Waifu 消息呈现端到端：MessagePresentation 在非流式路径拆多条/单条落库 */
    const waifuCfgBase = { nickname: 'WafAI', model: 'waf-model', endpoint: 'http://127.0.0.1:' + mock.port + '/v1/chat/completions', apiKey: '', provider: 'custom', relationship: '测试伙伴', systemPrompt: '你是测试助手。', temperature: 1, streaming: false, showThinking: false, promptCache: false, created: Date.now() };
    /* ① waifu ON + 非流式长回复 → 拆成多条 assistant 消息（metadata.waifu:true） */
    await evaluate(cdp, "(function(){ dbPut('apiConfigs', " + JSON.stringify(Object.assign({ id: 'waf_on', waifu: true }, waifuCfgBase)) + "); })()");
    await evaluate(cdp, "loadApiConfigs()");
    await evaluate(cdp, "openChatPanel()");
    await evaluate(cdp, "activeFriendId='waf_on'");
    check('waifu.onReady', await waitFor(cdp, "(function(){ var c=apiConfigs.find(function(a){return a.id==='waf_on'}); return !!(c&&c.waifu===true && activeFriendId==='waf_on'); })()", 8000));
    await evaluate(cdp, "document.getElementById('chat-input').value = 'waifu_probe 测试长回复。'; sendChatMessage();");/* awaitPromise:true → 等完整发送（含逐条 600ms 间隔） */
    const wafOn = await evaluate(cdp, "(async function(){ var all=await dbGetAll('chatMessages'); var xs=all.filter(function(m){return m.friendId==='waf_on'&&m.role==='assistant'}); return { count: xs.length, waifuCount: xs.filter(function(m){return m.metadata&&m.metadata.waifu===true}).length, texts: xs.map(function(m){return m.content}), hasLast: xs.some(function(m){return m.content.indexOf('找个地方坐坐')>=0}), joined: xs.map(function(m){return m.content}).join('') }; })()");
    check('waifu.onMultiMessages', wafOn && wafOn.waifuCount >= 2 && wafOn.count === wafOn.waifuCount, JSON.stringify({count:wafOn&&wafOn.count,waifuCount:wafOn&&wafOn.waifuCount}));
    check('waifu.onKeepsAll', wafOn && wafOn.hasLast === true, JSON.stringify(wafOn && wafOn.texts));
    check('waifu.onNoContentLoss', wafOn && wafOn.joined.indexOf('今天过得怎么样') >= 0 && wafOn.joined.indexOf('找个地方坐坐') >= 0, wafOn && wafOn.joined);

    /* ② waifu OFF + 同一条长回复 → 单条完整消息（不拆） */
    await evaluate(cdp, "(function(){ dbPut('apiConfigs', " + JSON.stringify(Object.assign({ id: 'waf_off', waifu: false }, waifuCfgBase)) + "); })()");
    await evaluate(cdp, "loadApiConfigs()");
    await evaluate(cdp, "openChatPanel()");
    await evaluate(cdp, "activeFriendId='waf_off'");
    await evaluate(cdp, "document.getElementById('chat-input').value = 'waifu_probe 测试长回复。'; sendChatMessage();");
    const wafOff = await evaluate(cdp, "(async function(){ var all=await dbGetAll('chatMessages'); var xs=all.filter(function(m){return m.friendId==='waf_off'&&m.role==='assistant'}); return { count: xs.length, waifuCount: xs.filter(function(m){return m.metadata&&m.metadata.waifu===true}).length, first: xs[0]&&xs[0].content }; })()");
    check('waifu.offSingleMessage', wafOff && wafOff.count === 1 && wafOff.waifuCount === 0, JSON.stringify(wafOff));
    check('waifu.offFullReply', wafOff && wafOff.first && wafOff.first.indexOf('找个地方坐坐') >= 0, JSON.stringify(wafOff&&wafOff.first));

    /* ③ MessagePresentation 契约：streaming → 'stream'；waifu 短句 → 'single'（避免无意义拆分） */
    check('waifu.contract.stream', await evaluate(cdp, "window.MessagePresentation && window.MessagePresentation.plan('任意',{streaming:true}).mode==='stream'"));
    check('waifu.contract.shortSingle', await evaluate(cdp, "window.MessagePresentation && window.MessagePresentation.plan('就一句。',{waifu:true,streaming:false}).mode==='single'"));
    check('waifu.contract.multi', await evaluate(cdp, "window.MessagePresentation && window.MessagePresentation.plan('今天天气真好啊。阳光很暖。适合出去走走。',{waifu:true,streaming:false}).mode==='multi'"));
    check('waifu.contract.example1', await evaluate(cdp, "(function(){ var r=window.MessagePresentation.split('" + WAIFU_EX1.replace(/"/g,'\\"') + "'); return r && r.length===3 && r.join('').indexOf('怎么跟你室友介绍我')>=0 && r[2].indexOf('我挺好奇这个')>=0; })()"));
    check('waifu.pace.dynamic', await evaluate(cdp, "(function(){ var d=window.MessagePresentation.delayBetween; return typeof d==='function' && d(5)<=d(30) && d(30)<=d(500) && d(500)<=1000; })()"));

    /* ③.5 截图同款：waifu ON + 非流式 3 句回复 → 正好 3 条消息，且内容与原文等价 */
    await evaluate(cdp, "(function(){ dbPut('apiConfigs', " + JSON.stringify(Object.assign({ id: 'waf_ex1', waifu: true }, waifuCfgBase)) + "); })()");
    await evaluate(cdp, "loadApiConfigs()");
    await evaluate(cdp, "openChatPanel()");
    await evaluate(cdp, "activeFriendId='waf_ex1'");
    await evaluate(cdp, "document.getElementById('chat-input').value = 'waifu_ex1 测试截图示例。'; sendChatMessage();");
    const ex1 = await evaluate(cdp, "(async function(){ var all=await dbGetAll('chatMessages'); var xs=all.filter(function(m){return m.friendId==='waf_ex1'&&m.role==='assistant'}); return { count: xs.length, joined: xs.map(function(m){return m.content}).join(''), texts: xs.map(function(m){return m.content}) }; })()");
    check('waifu.example1.exactly3', ex1 && ex1.count === 3, JSON.stringify(ex1 && ex1.texts));
    check('waifu.example1.lossless', ex1 && ex1.joined.replace(/\s+/g,'') === WAIFU_EX1.replace(/\s+/g,''), JSON.stringify(ex1 && ex1.joined));
    check('waifu.example1.ordered', ex1 && ex1.texts && ex1.texts[0].indexOf('怎么跟你室友介绍我')>=0 && ex1.texts[1].indexOf('还是藏起来当秘密')>=0 && ex1.texts[2].indexOf('我挺好奇这个')>=0, JSON.stringify(ex1 && ex1.texts));

    /* P36-VL-D4.1-B · Full Chat context, empty states, selector, density, scroll and Composer. */
    await evaluate(cdp, "(function(){ closeChatPanel(); navTo('chat'); window.autoSummaryOnOpen=function(){return Promise.resolve(null)}; })()");
    const d41Base = Date.now() - 200000;
    const d41Configs = [
      { id: 'd41b_mira', nickname: 'Mira', model: 'd41b-private-model-should-not-render', endpoint: mockEndpoint, apiKey: '', provider: 'custom', streaming: false, created: d41Base },
      { id: 'd41b_empty', nickname: 'Empty Room', model: 'd41b-empty-model', endpoint: mockEndpoint, apiKey: '', provider: 'custom', streaming: false, created: d41Base + 1 },
      { id: 'd41b_long', nickname: 'Long Talk', model: 'd41b-stream', endpoint: mockEndpoint, apiKey: '', provider: 'custom', streaming: true, created: d41Base + 2 },
      { id: 'd41b_error', nickname: 'History Error', model: 'd41b-error-model', endpoint: mockEndpoint, apiKey: '', provider: 'custom', streaming: false, created: d41Base + 3 },
      { id: 'd41c_slow', nickname: 'Slow Thinker', model: 'd41c-private-model', endpoint: mockEndpoint, apiKey: '', provider: 'custom', streaming: false, created: d41Base + 4 },
      { id: 'd41c_scroll', nickname: 'Scroll Talk', model: 'd41b-stream', endpoint: mockEndpoint, apiKey: '', provider: 'custom', streaming: true, created: d41Base + 5 },
      { id: 'd41c_failure', nickname: 'Unavailable Voice', model: 'd41c-provider-failure', endpoint: mockEndpoint, apiKey: '', provider: 'custom', streaming: false, created: d41Base + 6 },
      { id: 'd41c_actions', nickname: 'Action Fixture', model: 'd41c-action-model', endpoint: mockEndpoint, apiKey: '', provider: 'custom', streaming: false, created: d41Base + 7 },
      { id: 'd41c_speaker_a', nickname: 'Speaker A', model: 'd41c-speaker-a', endpoint: mockEndpoint, apiKey: '', provider: 'custom', streaming: true, created: d41Base + 8 },
      { id: 'd41c_speaker_b', nickname: 'Speaker B', model: 'd41c-speaker-b', endpoint: mockEndpoint, apiKey: '', provider: 'custom', streaming: true, created: d41Base + 9 }
    ];
    const d41Messages = [
      { id: 'd41c_action_fav', role: 'assistant', friendId: 'd41c_actions', senderName: 'Action Fixture', metadata: { config_id: 'd41c_actions' }, content: '收藏按钮的触屏与键盘可达性样例。', timestamp: d41Base + 8000 },
      { id: 'd41c_action_delete', role: 'assistant', friendId: 'd41c_actions', senderName: 'Action Fixture', metadata: { config_id: 'd41c_actions' }, content: '删除仍保持原有的即时语义。', timestamp: d41Base + 9000 },
      { id: 'd41c_truncated', role: 'assistant', friendId: 'd41c_failure', senderName: 'Unavailable Voice', metadata: { config_id: 'd41c_failure' }, content: '这是一段已经保存的截断回复。', truncated: true, timestamp: d41Base + 9500 },
      { id: 'd41c_multi_a1', role: 'assistant', friendId: 'group_d41c_multi', senderName: 'Speaker A', metadata: { config_id: 'd41c_speaker_a', speakerId: 'd41c_speaker_a', groupOrder: 0 }, content: 'Speaker A 的第一条历史消息。', timestamp: d41Base + 11000 },
      { id: 'd41c_multi_b', role: 'assistant', friendId: 'group_d41c_multi', senderName: 'Speaker B', metadata: { config_id: 'd41c_speaker_b', speakerId: 'd41c_speaker_b', groupOrder: 1 }, content: 'Speaker B 接着回答。', timestamp: d41Base + 12000 },
      { id: 'd41c_multi_a2', role: 'assistant', friendId: 'group_d41c_multi', senderName: 'Speaker A', metadata: { config_id: 'd41c_speaker_a', speakerId: 'd41c_speaker_a', groupOrder: 2 }, content: 'Speaker A 再次接续。', timestamp: d41Base + 13000 },
      { id: 'd41b_mira_user', role: 'user', friendId: 'd41b_mira', content: '你好，帮我梳理一下。', timestamp: d41Base },
      { id: 'd41b_mira_assistant', role: 'assistant', friendId: 'd41b_mira', senderName: 'Mira', metadata: { config_id: 'd41b_mira' }, content: '先看内容，再决定下一步。\n\n## 重点\n- 身份清楚\n- 阅读连续\n\n```js\nconst readable = true;\n```\n\n| 项目 | 状态 |\n|---|---|\n| Composer | 可用 |', timestamp: d41Base + 1000 },
      { id: 'd41b_mira_system', role: 'system', friendId: 'd41b_mira', content: '历史记录已加载。', timestamp: d41Base + 2000 },
      { id: 'd41b_thread_user', role: 'user', friendId: 'd41b_mira', threadId: 'd41b_thread', content: '话题内容只属于这个线程。', timestamp: d41Base + 3000 },
      { id: 'd41b_group_user', role: 'user', friendId: 'group_d41b', metadata: { targetSpeakerIds: ['d41b_mira', 'd41b_long'] }, content: '两位角色分别回答。', timestamp: d41Base + 4000 },
      { id: 'd41b_group_mira', role: 'assistant', friendId: 'group_d41b', senderName: 'Mira', metadata: { config_id: 'd41b_mira' }, content: 'Mira 的回答。', timestamp: d41Base + 5000 },
      { id: 'd41b_group_mira_repeat', role: 'assistant', friendId: 'group_d41b', senderName: 'Mira', metadata: { config_id: 'd41b_mira' }, content: 'Mira 的补充。', timestamp: d41Base + 5500 },
      { id: 'd41b_group_long', role: 'assistant', friendId: 'group_d41b', senderName: 'Long Talk', metadata: { config_id: 'd41b_long' }, content: 'Long Talk 的回答。', timestamp: d41Base + 6000 }
    ];
    for (let i = 0; i < 68; i++) {
      const assistant = i % 2 === 1;
      const lastContent = '一段连续长内容，用于检查阅读宽度。' + 'unbroken-' + 'x'.repeat(180) + '\n\n| Column | Value |\n|---|---|\n| History | preserved |\n\n```js\nconst scrollAnchor = true;\n```';
      d41Messages.push({
        id: 'd41b_long_' + i,
        role: assistant ? 'assistant' : 'user',
        friendId: 'd41b_long',
        senderName: assistant ? 'Long Talk' : undefined,
        metadata: assistant ? { config_id: 'd41b_long' } : undefined,
        content: i === 67 ? lastContent : ('历史消息 ' + i + '。对话连续性由身份、内容和时间关系表达。'),
        timestamp: d41Base + 10000 + i * 1000,
        images: i === 67 ? [{ dataUrl: 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=', name: 'fixture.gif', mime: 'image/gif' }] : undefined,
        files: i === 67 ? [{ name: 'notes.txt', ext: 'txt', size: 10, text: 'synthetic file' }] : undefined
      });
    }
    for (let i = 0; i < 68; i++) {
      const assistant=i%2===1;
      d41Messages.push({id:'d41c_scroll_'+i,role:assistant?'assistant':'user',friendId:'d41c_scroll',senderName:assistant?'Scroll Talk':undefined,
        metadata:assistant?{config_id:'d41c_scroll'}:undefined,content:'Scroll fixture row '+i,timestamp:d41Base+90000+i*1000});
    }
    await evaluate(cdp, "(async function(){ var cfgs=" + JSON.stringify(d41Configs) + "; var rows=" + JSON.stringify(d41Messages) + "; for(var i=0;i<cfgs.length;i++)await dbPut('apiConfigs',cfgs[i]); await dbPut('groups',{id:'group_d41b',name:'D4 Test Group',members:[{characterId:'d41b_mira',status:'active'},{characterId:'d41b_long',status:'active'}]}); await dbPut('groups',{id:'group_d41c_multi',name:'D4 Multi-role Fixture',members:[{characterId:'d41c_speaker_a',status:'active'},{characterId:'d41c_speaker_b',status:'active'}],participationPolicy:{maxResponders:2}}); await dbPut('chatThreads',{id:'d41b_thread',friendId:'d41b_mira',name:'只读性话题',created:Date.now()}); for(var j=0;j<rows.length;j++)await dbPut('chatMessages',rows[j]); await loadApiConfigs(); activeFriendId=null; activeThreadId=null; await loadFriendsList(); return true; })()");
    check('d41b.noSelectionState', await evaluate(cdp, "document.querySelector('#chat-full-messages .chat-empty-state') && document.querySelector('#chat-full-messages .chat-empty-state').dataset.state==='unselected'"));
    check('d41b.selectorUsesNativeControl', await evaluate(cdp, "document.getElementById('chat-conversation-select').tagName==='SELECT' && document.querySelector('label[for=chat-conversation-select]') && document.getElementById('chat-context-title').textContent==='选择对话'"));

    await evaluate(cdp, "selectFriend('d41b_empty')");
    check('d41b.newConversationState', await evaluate(cdp, "document.querySelector('#chat-full-messages .chat-empty-state') && document.querySelector('#chat-full-messages .chat-empty-state').dataset.state==='new' && document.getElementById('chat-context-title').textContent==='Empty Room'"));
    await captureChatEvidence('chat-core-new-1280-internal',1280,800);
    await evaluate(cdp, "selectFriend('d41b_mira')");
    const d41AxeLoaded = await loadAxeForChat(cdp);
    if (!d41AxeLoaded) console.log('  INFO  axe skipped: set IB_AXE_CORE_PATH to an axe-core browser bundle');
    else {
      const axeDesktopInternal = await runChatAxeAudit(cdp, '1280 Internal');
      check('d41b.axe.desktopInternalNoCriticalOrSerious', !axeDesktopInternal.violations.some(v => v.impact === 'critical' || v.impact === 'serious'), JSON.stringify(axeDesktopInternal.violations));
    }
    check('d41b.contextIdentityNoModel', await evaluate(cdp, "document.getElementById('chat-context-title').textContent==='Mira' && !document.querySelector('.chat-context-primitives').textContent.includes('d41b-private-model-should-not-render')"));
    check('d41b.contextNoFakePresence', await evaluate(cdp, "!/(online|offline|在线|离线)/i.test(document.querySelector('.chat-conversation-context').textContent)"));
    check('d41b.messageTurnMarkdownSystem', await evaluate(cdp, "document.querySelector('#chat-full-messages .chat-msg.user') && document.querySelector('#chat-full-messages pre.md-cb') && document.querySelector('#chat-full-messages table') && document.querySelector('#chat-full-messages .chat-msg.system')"));
    check('d41b.messageTurnUsesTransparentReadingSurface', await evaluate(cdp, "(function(){var m=document.querySelector('#chat-full-messages .chat-msg.ai');var s=getComputedStyle(m);return !!m&&s.backgroundColor==='rgba(0, 0, 0, 0)'&&s.boxShadow==='none'&&getComputedStyle(document.querySelector('#chat-full-messages')).backgroundColor==='rgba(0, 0, 0, 0)'})()"));
    check('d41b.selectorDoesNotLeakModelId', await evaluate(cdp, "!document.getElementById('chat-conversation-select').textContent.includes('d41b-private-model-should-not-render')"));

    const d41ThreadValue = await evaluate(cdp, "(function(){ var s=document.getElementById('chat-conversation-select'); var o=Array.from(s.options).find(function(x){try{return JSON.parse(x.value).kind==='thread'}catch(e){return false}}); return o&&o.value; })()");
    check('d41b.threadOptionExists', !!d41ThreadValue);
    await evaluate(cdp, "(function(v){ var s=document.getElementById('chat-conversation-select'); s.value=v; s.dispatchEvent(new Event('change',{bubbles:true})); return true; })(" + JSON.stringify(d41ThreadValue) + ")");
    check('d41b.selectorUsesExistingThreadAuthority', await waitFor(cdp, "activeFriendId==='d41b_mira' && activeThreadId==='d41b_thread' && document.getElementById('chat-full-messages').textContent.includes('话题内容只属于这个线程')", 8000));
    await evaluate(cdp, "selectGroup('group_d41b')");
    check('d41b.groupSpeakersRemainDistinct', await evaluate(cdp, "document.getElementById('chat-context-title').textContent==='D4 Test Group' && document.getElementById('chat-full-messages').textContent.includes('Mira 的回答') && document.getElementById('chat-full-messages').textContent.includes('Long Talk 的回答')"));
    check('d41b.sameSpeakerTurnsGroupByCanonicalId', await evaluate(cdp, "(function(){var rows=Array.from(document.querySelectorAll('#chat-full-messages .r-head')).map(function(e){return e.textContent});return rows.filter(function(t){return t.indexOf('Mira')===0}).length===1&&rows.some(function(t){return t.indexOf('Long Talk')===0})})()"));
    await captureChatEvidence('chat-core-group-1280-internal',1280,800);

    await evaluate(cdp, "selectFriend('d41b_error')");
    await evaluate(cdp, "(function(){ window.__d41OriginalGetByIndex=window.dbGetByIndex; window.dbGetByIndex=function(store,index,value){ if(store==='chatMessages'&&value==='d41b_error')return Promise.reject(new Error('fixture history read failure')); return window.__d41OriginalGetByIndex.apply(this,arguments); }; })()");
    await evaluate(cdp, "selectFriend('d41b_error')");
    check('d41b.unavailableIsNotEmpty', await evaluate(cdp, "document.querySelector('#chat-full-messages .chat-history-unavailable[data-state=unavailable]') && document.querySelector('#chat-full-messages .chat-history-unavailable').textContent.includes('无法加载对话记录')"));
    check('d41b.unavailableHasRecoveryAndDetails', await evaluate(cdp, "Array.from(document.querySelectorAll('#chat-full-messages .chat-history-unavailable button')).some(function(b){return b.textContent==='重试'}) && Array.from(document.querySelectorAll('#chat-full-messages .chat-history-unavailable button')).some(function(b){return b.textContent==='查看详情'})"));
    await evaluate(cdp, "window.dbGetByIndex=window.__d41OriginalGetByIndex; document.querySelector('#chat-full-messages .chat-history-unavailable button').click()");
    check('d41b.historyRetryRecovers', await waitFor(cdp, "document.querySelector('#chat-full-messages .chat-empty-state[data-state=new]')", 8000));

    await evaluate(cdp, "selectFriend('d41b_long')");
    check('d41b.historyWindowLatest50', await evaluate(cdp, "document.getElementById('chat-full-messages')._ibWin && document.getElementById('chat-full-messages')._ibWin.start===18 && document.querySelectorAll('#chat-full-messages .chat-msg[data-msg-id]').length===50"));
    check('d41b.historyCurrentOrderPreserved', await evaluate(cdp, "(function(){var ids=Array.from(document.querySelectorAll('#chat-full-messages .chat-msg[data-msg-id]')).map(function(e){return e.dataset.msgId});return ids[0]==='d41b_long_18'&&ids[31]==='d41b_long_49'&&ids[49]==='d41b_long_67'})()"));
    const anchorBeforeState = await evaluate(cdp, "(function(){var el=document.getElementById('chat-full-messages'),anchor=el.querySelector('[data-msg-id=\"d41b_long_20\"]');el.scrollTop=120;el.dispatchEvent(new Event('scroll'));el.scrollTop=0;var before=anchor.getBoundingClientRect().top,metrics={before:before,scrollTop:el.scrollTop,scrollHeight:el.scrollHeight,clientHeight:el.clientHeight,start:el._ibWin&&el._ibWin.start,topConnected:!!(el._ibWin&&el._ibWin.top&&el._ibWin.top.isConnected),rowCount:el.querySelectorAll('.chat-msg[data-msg-id]').length};el.dispatchEvent(new Event('scroll'));return metrics})()");
    await waitFor(cdp, "document.getElementById('chat-full-messages')._ibWin && document.getElementById('chat-full-messages')._ibWin.start===0 && !document.getElementById('chat-full-messages')._ibWin.loading", 3000);
    await new Promise(resolve => setTimeout(resolve, 100));
    const anchorAfter = await evaluate(cdp, "(function(){var el=document.getElementById('chat-full-messages'),anchor=el.querySelector('[data-msg-id=\"d41b_long_20\"]');return {after:anchor.getBoundingClientRect().top,offsetTop:anchor.offsetTop,scrollTop:el.scrollTop,scrollHeight:el.scrollHeight,clientHeight:el.clientHeight,start:el._ibWin.start,count:el._ibWin.msgs.length}})()");
    const anchorMetrics = { before: anchorBeforeState&&anchorBeforeState.before, after: anchorAfter && anchorAfter.after, start: anchorAfter && anchorAfter.start, count: anchorAfter && anchorAfter.count };
    check('d41b.olderHistoryPreservesAnchor', anchorMetrics && anchorMetrics.start===0 && anchorMetrics.count===68 && Math.abs(anchorMetrics.before-anchorMetrics.after)<2, JSON.stringify({anchorBefore:anchorBeforeState,anchorAfter:anchorAfter}));
    check('d41b.longContentImageFileNoPageOverflow', await evaluate(cdp, "document.querySelector('#chat-full-messages pre.md-cb') && document.querySelector('#chat-full-messages table') && document.querySelector('#chat-full-messages img[alt=\"fixture.gif\"]') && document.querySelector('#chat-full-messages .chat-file-card') && document.documentElement.scrollWidth<=innerWidth"));
    await evaluate(cdp, "(function(){var el=document.getElementById('chat-full-messages');el.scrollTop=120;el.dispatchEvent(new Event('scroll'));appendChatBubble('ai','D4 append behavior fixture');return true;})()");
    check('d41b.appendKeepsCurrentAutoBottomPolicy', await evaluate(cdp, "(function(){var el=document.getElementById('chat-full-messages');return el.scrollTop+el.clientHeight>=el.scrollHeight-2})()"));

    await evaluate(cdp,"(async function(){await selectFriend('d41c_slow');document.getElementById('chat-full-input').value='d41c sending activity fixture';window.__d41cSlowPromise=sendChatMessage();return true})()");
    check('d41c.sendingProjectionUsesComposer', await waitFor(cdp,"(function(){var a=document.querySelector('#page-chat .chat-input-area'),b=document.getElementById('chat-send-full'),t=document.querySelector('#chat-full-messages .chat-typing[data-activity-state=thinking]');return a&&a.getAttribute('aria-busy')==='true'&&b.disabled&&t&&t.getAttribute('role')==='status'&&t.getAttribute('aria-live')==='polite'})()",3000), await evaluate(cdp,"(function(){var a=document.querySelector('#page-chat .chat-input-area'),b=document.getElementById('chat-send-full'),t=document.querySelector('#chat-full-messages .chat-typing');return JSON.stringify({page:currentPage,friend:activeFriendId,busy:a&&a.getAttribute('aria-busy'),sendDisabled:b&&b.disabled,typing:t&&t.textContent,model:(apiConfigs.find(function(c){return c.id==='d41c_slow'})||{}).model})})()"));
    check('d41c.activityNameDoesNotExposeModel', await evaluate(cdp,"(function(){var t=document.querySelector('#chat-full-messages .chat-typing');return !!t&&t.textContent.indexOf('Slow Thinker')>=0&&t.textContent.indexOf('d41c-private-model')<0&&t.querySelector('.typing-sec')&&t.querySelector('.typing-sec').getAttribute('aria-hidden')==='true'})()"));
    await evaluate(cdp,"selectFriend('d41b_mira')");
    check('d41c.conversationSwitchClearsOldActivity',await waitFor(cdp,"(function(){var a=document.querySelector('#page-chat .chat-input-area'),b=document.getElementById('chat-send-full');return activeFriendId==='d41b_mira'&&!document.querySelector('#chat-full-messages .chat-typing')&&!a.hasAttribute('aria-busy')&&!b.disabled})()",4000),await evaluate(cdp,"(function(){var a=document.querySelector('#page-chat .chat-input-area'),b=document.getElementById('chat-send-full'),t=document.querySelector('#chat-full-messages .chat-typing');return JSON.stringify({friend:activeFriendId,thread:activeThreadId,busy:a&&a.getAttribute('aria-busy'),disabled:b&&b.disabled,typing:t&&t.textContent})})()"));
    check('d41c.sendingCleansAfterCompletion', await waitFor(cdp,"(async function(){var all=await dbGetByIndex('chatMessages','byFriend','d41c_slow');var done=all.some(function(m){return m.role==='assistant'&&m.content==='延迟响应已经完成。'});var a=document.querySelector('#page-chat .chat-input-area');return done&&!document.querySelector('#chat-full-messages .chat-typing')&&!a.hasAttribute('aria-busy')&&!document.getElementById('chat-send-full').disabled})()",8000), await evaluate(cdp,"(function(){var a=document.querySelector('#page-chat .chat-input-area'),b=document.getElementById('chat-send-full'),t=document.querySelector('#chat-full-messages .chat-typing');return JSON.stringify({busy:a&&a.getAttribute('aria-busy'),sendDisabled:b&&b.disabled,typing:t&&t.textContent})})()"));
    await evaluate(cdp,"selectFriend('d41c_slow')");
    check('d41c.returningToConversationHasNoStaleTyping',await evaluate(cdp,"!document.querySelector('#chat-full-messages .chat-typing')"));
    await evaluate(cdp,"selectFriend('d41b_long')");

    await captureChatEvidence('chat-core-1280-internal',1280,800);
    await evaluate(cdp, "document.body.classList.add('theme-infernal')");
    check('d41b.themeKeepsStructure', await evaluate(cdp, "document.body.classList.contains('theme-infernal') && document.getElementById('chat-context-title').textContent==='Long Talk' && document.querySelectorAll('#chat-full-messages .chat-msg[data-msg-id]').length>=50 && document.querySelector('#chat-full-messages .chat-msg-actions .chat-msg-more')"));
    await captureChatEvidence('chat-core-1280-infernal',1280,800);
    await captureChatEvidence('chat-core-390-infernal',390,844);
    if (d41AxeLoaded) {
      const axeNarrowInfernal = await runChatAxeAudit(cdp, '390 Infernal');
      check('d41b.axe.narrowInfernalNoCriticalOrSerious', !axeNarrowInfernal.violations.some(v => v.impact === 'critical' || v.impact === 'serious'), JSON.stringify(axeNarrowInfernal.violations));
    }
    await evaluate(cdp, "document.body.classList.remove('theme-infernal')");

    const viewportGates = [[768,800,true,false],[390,844,false,true],[375,812,false,true],[320,780,false,true]];
    for (const [width,height,sidebarExpected,selectorExpected] of viewportGates) {
      await setViewport(width,height);
      if(width===390){
        const firstOption=await evaluate(cdp,"(function(){var s=document.getElementById('chat-conversation-select');var o=Array.from(s.options).find(function(item){if(!item.value)return false;try{return JSON.parse(item.value).kind==='role'}catch(e){return false}});return o&&o.value})()");
        await evaluate(cdp,"(function(){var s=document.getElementById('chat-conversation-select');s.value='';s.focus();return true})()");
        check('d41b.selectorHasKeyboardFocus', await evaluate(cdp,"document.activeElement===document.getElementById('chat-conversation-select')"));
        await cdp.send('Input.dispatchKeyEvent',{type:'keyDown',key:'ArrowDown',code:'ArrowDown',windowsVirtualKeyCode:40,nativeVirtualKeyCode:40});
        await cdp.send('Input.dispatchKeyEvent',{type:'keyUp',key:'ArrowDown',code:'ArrowDown',windowsVirtualKeyCode:40,nativeVirtualKeyCode:40});
        await cdp.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,nativeVirtualKeyCode:13});
        await cdp.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,nativeVirtualKeyCode:13});
        check('d41b.selectorKeyboardSelection', await waitFor(cdp,"(function(){var s=document.getElementById('chat-conversation-select');var o;try{o=JSON.parse(s.value)}catch(e){return false}return !!o&&activeFriendId===o.friendId&&String(activeThreadId||'')===String(o.threadId||'')})()", 5000), String(firstOption||''));
        const composerKeys=await evaluate(cdp,"(function(){var input=document.getElementById('chat-full-input');input.value='d41b shift enter draft';var shifted=new KeyboardEvent('keydown',{key:'Enter',shiftKey:true,bubbles:true,cancelable:true});input.dispatchEvent(shifted);return {wired:input.getAttribute('onkeydown')==='chatKeyDown(event)',shiftPrevented:shifted.defaultPrevented,value:input.value}})()");
        check('d41b.composerShiftEnterAllowsNewline',composerKeys&&composerKeys.wired&&!composerKeys.shiftPrevented&&composerKeys.value==='d41b shift enter draft',JSON.stringify(composerKeys));
        const plainEnter=await evaluate(cdp,"(function(){var input=document.getElementById('chat-full-input');input.value='d41b plain enter submit';var plain=new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true});input.dispatchEvent(plain);return plain.defaultPrevented})()");
        check('d41b.composerEnterPreventsNewline',plainEnter===true,JSON.stringify(plainEnter));
        check('d41b.composerEnterSends',await waitFor(cdp,"(async function(){var all=await dbGetByIndex('chatMessages','byFriend','d41b_mira');return all.some(function(m){return m.role==='user'&&m.content==='d41b plain enter submit'})})()",8000));
      }
      const metrics = await evaluate(cdp, "(function(){var q=function(s){return document.querySelector(s)};var box=function(e){var r=e.getBoundingClientRect();return {w:r.width,h:r.height}};var input=q('#chat-full-input'), area=q('.chat-input-area'), picker=q('#chat-conversation-picker'), send=q('#chat-send-full'), attach=q('.chat-attach-btn'), voice=q('#chat-voice-full'), sticker=q('.chat-input-area .ib-sticker-btn');return {width:innerWidth,documentWidth:document.documentElement.scrollWidth,areaWidth:area.clientWidth,areaScrollWidth:area.scrollWidth,inputWidth:box(input).w,send:box(send),attach:box(attach),voice:box(voice),sticker:box(sticker),sidebar:getComputedStyle(q('.chat-sidebar')).display,picker:getComputedStyle(picker).display,pickerHidden:picker.hidden};})()");
      console.log('  INFO  responsive ' + width + ': ' + JSON.stringify(metrics));
      check('d41b.responsive.'+width, metrics && metrics.documentWidth<=width && metrics.areaScrollWidth<=metrics.areaWidth && metrics.inputWidth>=120 && metrics.send.w>=44 && metrics.send.h>=44 && metrics.attach.w>=44 && metrics.attach.h>=44 && metrics.voice.w>=44 && metrics.voice.h>=44 && metrics.sticker.w>=44 && metrics.sticker.h>=44 && (metrics.sidebar!=='none')===sidebarExpected && (metrics.picker!=='none'&&!metrics.pickerHidden)===selectorExpected, JSON.stringify(metrics));
      if(width===390)await captureChatEvidence('chat-core-390-internal',width,height);
      if(width===320)await captureChatEvidence('chat-core-320-internal',width,height);
    }
    await setViewport(320,780);
    const imageValidation=await evaluate(cdp,"(async function(){var create=document.createElement.bind(document),realClick=HTMLInputElement.prototype.click,captured=null;document.createElement=function(name){var el=create(name);if(String(name).toLowerCase()==='input')captured=el;return el};HTMLInputElement.prototype.click=function(){};try{pickImage('full');Object.defineProperty(captured,'files',{configurable:true,value:[{name:'not-an-image.txt',type:'text/plain',size:1}]});await captured.onchange({target:captured});var full=document.getElementById('chat-composer-feedback'),count=_pendingImages.length;captured=null;pickImage('mini');Object.defineProperty(captured,'files',{configurable:true,value:[{name:'not-an-image.txt',type:'text/plain',size:1}]});await captured.onchange({target:captured});var mini=document.querySelector('#chat-panel .chat-input-area .chat-composer-feedback');return {fullText:full&&full.textContent,fullRole:full&&full.getAttribute('role'),miniText:mini&&mini.textContent,miniRole:mini&&mini.getAttribute('role'),pendingImages:_pendingImages.length,countBefore:count}}finally{document.createElement=create;HTMLInputElement.prototype.click=realClick}})()");
    check('d41c.composerValidationIsScopedAndNonMutating',imageValidation&&imageValidation.fullRole==='status'&&imageValidation.fullText.indexOf('仅支持图片')>=0&&imageValidation.miniRole==='status'&&imageValidation.miniText.indexOf('仅支持图片')>=0&&imageValidation.pendingImages===imageValidation.countBefore,JSON.stringify(imageValidation));
    const fileValidation=await evaluate(cdp,"(async function(){var create=document.createElement.bind(document),realClick=HTMLInputElement.prototype.click,captured=null,before=_pendingFiles.length;document.createElement=function(name){var el=create(name);if(String(name).toLowerCase()==='input')captured=el;return el};HTMLInputElement.prototype.click=function(){};try{pickFile('full');Object.defineProperty(captured,'files',{configurable:true,value:[{name:'oversized.txt',size:FILE_MAX_BYTES+1,text:function(){return Promise.resolve('must not read')}}]});await captured.onchange({target:captured});var f=document.getElementById('chat-composer-feedback');return {text:f&&f.textContent,role:f&&f.getAttribute('role'),count:_pendingFiles.length,before:before}}finally{document.createElement=create;HTMLInputElement.prototype.click=realClick}})()");
    check('d41c.fileValidationDoesNotAttach',fileValidation&&fileValidation.role==='status'&&fileValidation.text.indexOf('大小限制')>=0&&fileValidation.count===fileValidation.before,JSON.stringify(fileValidation));
    await evaluate(cdp,"(async function(){await selectFriend('d41c_failure');document.getElementById('chat-full-input').value='provider failure fixture';window.__d41cFailureResult=await sendChatMessage();return true})()");
    check('d41c.providerFailureUsesMessageDisclosure',await waitFor(cdp,"(function(){var e=document.querySelector('#chat-full-messages .chat-message-error[data-error-scope=send]');return !!e&&e.textContent.indexOf('服务商这一侧出了状况')>=0&&!e.textContent.includes('d41c-provider-raw-secret')&&!document.querySelector('#ib-err-stack .ib-err-card')})()",5000),await evaluate(cdp,"(function(){var e=document.querySelector('#chat-full-messages .chat-message-error[data-error-scope=send]');return JSON.stringify({text:e&&e.textContent,buttons:e&&Array.from(e.querySelectorAll('button')).map(function(b){return b.textContent}),busy:document.querySelector('#page-chat .chat-input-area').getAttribute('aria-busy'),sendDisabled:document.getElementById('chat-send-full').disabled})})()"));
    check('d41c.providerFailureHasNoFakeAssistantOrRetry',await evaluate(cdp,"(async function(){var rows=await dbGetByIndex('chatMessages','byFriend','d41c_failure'),e=document.querySelector('#chat-full-messages .chat-message-error[data-error-scope=send]');return !!e&&rows.filter(function(m){return m.role==='assistant'&&m.id!=='d41c_truncated'}).length===0&&rows.some(function(m){return m.role==='user'&&m.content==='provider failure fixture'})&&!Array.from(e.querySelectorAll('button')).some(function(b){return /retry|重试/i.test(b.textContent)})})()"));
    await evaluate(cdp,"(function(){var e=document.querySelector('#chat-full-messages .chat-message-error[data-error-scope=send]'),b=e&&Array.from(e.querySelectorAll('button')).find(function(x){return x.textContent==='查看技术详情'});if(b)b.click();return true})()");
    check('d41c.providerDetailsRemainCollapsedAndRedacted',await waitFor(cdp,"(function(){var card=document.querySelector('#ib-err-stack .ib-err-card'),toggle=card&&card.querySelector('.ib-err-toggle'),details=card&&card.querySelector('.ib-err-details');return !!card&&!!toggle&&toggle.getAttribute('aria-expanded')==='false'&&!!details&&details.hidden&&!/Retry|重试/i.test(card.textContent)})()",4000));
    await evaluate(cdp,"(function(){var cards=document.querySelectorAll('#ib-err-stack .ib-err-card');cards.forEach(function(c){c.remove()});return true})()");
    await evaluate(cdp,"selectFriend('d41c_failure')");
    check('d41c.continuationKeepsItsOwnMeaning',await evaluate(cdp,"(function(){var m=document.querySelector('#chat-full-messages [data-msg-id=d41c_truncated]'),b=m&&m.querySelector('.ws-continue-pill button');return !!b&&b.textContent.indexOf('继续生成')>=0&&b.getAttribute('aria-label')==='继续生成这条被截断的回复'})()"));
    await evaluate(cdp,"(function(){document.querySelector('#chat-full-messages [data-msg-id=d41c_truncated] .ws-continue-pill button').click();return true})()");
    check('d41c.continuationFailureStaysMessageScoped',await waitFor(cdp,"(function(){var e=document.querySelector('#chat-full-messages .chat-message-error[data-error-scope=continuation][data-error-for=d41c_truncated]');return !!e&&e.textContent.indexOf('续写没有完成')>=0&&e.textContent.indexOf('再次选择“继续生成”')>=0})()",8000),await evaluate(cdp,"(function(){var e=document.querySelector('#chat-full-messages .chat-message-error[data-error-scope=continuation]'),m=document.querySelector('#chat-full-messages [data-msg-id=d41c_truncated]');return JSON.stringify({error:e&&{text:e.textContent,scope:e.dataset.errorScope,for:e.dataset.errorFor},message:!!m,activeFriend:activeFriendId,thread:activeThreadId})})()"));
    check('d41c.continuationPreservesMessageAndReenablesAction',await evaluate(cdp,"(async function(){var m=await dbGet('chatMessages','d41c_truncated'),b=document.querySelector('#chat-full-messages [data-msg-id=d41c_truncated] .ws-continue-pill button');return !!m&&m.content==='这是一段已经保存的截断回复。'&&m.truncated===true&&!!b&&!b.disabled&&!b.hasAttribute('aria-busy')&&!document.querySelector('#chat-full-messages .chat-message-error[data-error-scope=continuation] button:not([data-variant=text])')})()"));
    const miniHistoryFailure=await evaluate(cdp,"(async function(){var original=window.dbGetByIndex;window.dbGetByIndex=function(store,index,key){if(store==='chatMessages')return Promise.reject(new Error('mini-history-read-fixture'));return original.apply(this,arguments)};activeFriendId='smoke_friend';try{await loadChatMessages()}finally{window.dbGetByIndex=original}var e=document.querySelector('#chat-messages .chat-message-error[data-error-scope=history]');return {text:e&&e.textContent,role:e&&e.getAttribute('role'),buttons:e&&Array.from(e.querySelectorAll('button')).map(function(b){return b.textContent})}})()");
    check('d41c.miniHistoryFailureIsRecoverable',miniHistoryFailure&&miniHistoryFailure.role==='alert'&&miniHistoryFailure.text.indexOf('无法加载对话记录')>=0&&miniHistoryFailure.buttons.indexOf('重试读取')>=0,JSON.stringify(miniHistoryFailure));
    await evaluate(cdp,"(function(){var b=Array.from(document.querySelectorAll('#chat-messages .chat-message-error[data-error-scope=history] button')).find(function(x){return x.textContent==='重试读取'});if(b)b.click();return true})()");
    check('d41c.miniHistoryReadRecoveryWorks',await waitFor(cdp,"document.querySelector('#chat-messages .chat-msg.ai')&&!document.querySelector('#chat-messages .chat-message-error[data-error-scope=history]')",5000));
    await evaluate(cdp,"(function(){closeChatPanel();navTo('home');activeFriendId='d41c_slow';openChatPanel();document.getElementById('chat-input').value='mini typing fixture';window.__d41cMiniSlowDone=false;window.__d41cMiniSlowPromise=sendChatMessage();window.__d41cMiniSlowPromise.then(function(){window.__d41cMiniSlowDone=true},function(){window.__d41cMiniSlowDone=true});return true})()");
    check('d41c.miniTypingUsesExistingOwner',await waitFor(cdp,"(function(){var t=document.querySelector('#chat-messages .chat-typing[data-activity-state=thinking]'),a=document.querySelector('#chat-panel .chat-input-area');return t&&t.getAttribute('role')==='status'&&t.getAttribute('aria-live')==='polite'&&t.textContent.indexOf('Slow Thinker')>=0&&a&&a.getAttribute('aria-busy')==='true'})()",3000));
    check('d41c.miniThinkingEndsWithoutActiveState',await waitFor(cdp,"(async function(){var all=await dbGetByIndex('chatMessages','byFriend','d41c_slow'),done=all.some(function(m){return m.role==='assistant'&&m.content==='延迟响应已经完成。'}),t=document.querySelector('#chat-messages .chat-typing'),a=document.querySelector('#chat-panel .chat-input-area');return done&&window.__d41cMiniSlowDone===true&&(!t||(!t.hasAttribute('role')&&!t.dataset.activityState&&!/正在|思考中/.test(t.textContent)))&&a&&!a.hasAttribute('aria-busy')})()",6000));
    await evaluate(cdp,"(function(){activeFriendId='d41c_failure';openChatPanel();document.getElementById('chat-input').value='mini provider failure fixture';return true})()");
    await evaluate(cdp,"(async function(){window.__d41cMiniFailure=await sendChatMessage();return true})()");
    check('d41c.miniSendFailureUsesComposerAndMessageScope',await waitFor(cdp,"(function(){var e=document.querySelector('#chat-messages .chat-message-error[data-error-scope=send]');return !!e&&e.textContent.indexOf('服务商这一侧出了状况')>=0&&!e.textContent.includes('d41c-provider-raw-secret')&&!Array.from(e.querySelectorAll('button')).some(function(b){return /retry|重试/i.test(b.textContent)})})()",6000),await evaluate(cdp,"(function(){var e=document.querySelector('#chat-messages .chat-message-error[data-error-scope=send]'),full=document.querySelector('#chat-full-messages .chat-message-error[data-error-scope=send]');return JSON.stringify({page:currentPage,active:activeFriendId,panel:document.getElementById('chat-panel').className,miniText:document.getElementById('chat-messages').textContent.slice(-300),error:e&&e.textContent,fullError:full&&full.textContent,result:window.__d41cMiniFailure})})()"));
    await evaluate(cdp,"(function(){closeChatPanel();navTo('chat');return true})()");
    await evaluate(cdp,"selectFriend('d41c_actions')");
    check('d41c.actionsUseNamedTouchTargets',await evaluate(cdp,"(function(){var m=document.querySelector('#chat-full-messages [data-msg-id=d41c_action_fav]'),f=m&&m.querySelector('.chat-msg-fav'),more=m&&m.querySelector('.chat-msg-more'),box=function(b){var r=b.getBoundingClientRect();return {w:r.width,h:r.height}};return !!f&&!!more&&f.getAttribute('aria-label')==='收藏此消息'&&f.getAttribute('aria-pressed')==='false'&&more.getAttribute('aria-label')==='更多消息操作'&&box(f).w>=44&&box(f).h>=44&&box(more).w>=44&&box(more).h>=44&&document.documentElement.scrollWidth<=innerWidth})()"));
    await evaluate(cdp,"(function(){var b=document.querySelector('#chat-full-messages [data-msg-id=d41c_action_fav] .chat-msg-more');b.focus();b.click();return true})()");
    check('d41c.actionPopoverOpensWithExpandedState',await waitFor(cdp,"(function(){var b=document.querySelector('#chat-full-messages [data-msg-id=d41c_action_fav] .chat-msg-more'),p=b&&document.getElementById(b.getAttribute('aria-controls'));return !!p&&p.matches(':popover-open')&&b.getAttribute('aria-expanded')==='true'&&p.querySelector('[data-variant=destructive]')&&p.querySelector('[data-variant=destructive]').textContent==='删除消息'})()",3000),await evaluate(cdp,"(function(){var b=document.querySelector('#chat-full-messages [data-msg-id=d41c_action_fav] .chat-msg-more'),p=b&&document.getElementById(b.getAttribute('aria-controls'));return JSON.stringify({expanded:b&&b.getAttribute('aria-expanded'),open:p&&p.matches(':popover-open'),panel:p&&p.outerHTML})})()"));
    const popoverBounds=await evaluate(cdp,"(function(){var b=document.querySelector('#chat-full-messages [data-msg-id=d41c_action_fav] .chat-msg-more'),p=b&&document.getElementById(b.getAttribute('aria-controls'));if(!p)return null;var r=p.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:innerWidth,height:innerHeight}})()");
    check('d41c.actionPopoverStaysInViewport',popoverBounds&&popoverBounds.left>=0&&popoverBounds.top>=0&&popoverBounds.right<=popoverBounds.width&&popoverBounds.bottom<=popoverBounds.height,JSON.stringify(popoverBounds));
    await cdp.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27,nativeVirtualKeyCode:27});
    await cdp.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27,nativeVirtualKeyCode:27});
    check('d41c.actionPopoverEscapeRestoresTrigger',await evaluate(cdp,"(function(){var b=document.querySelector('#chat-full-messages [data-msg-id=d41c_action_fav] .chat-msg-more'),p=b&&document.getElementById(b.getAttribute('aria-controls'));return !!b&&!!p&&!p.matches(':popover-open')&&b.getAttribute('aria-expanded')==='false'&&document.activeElement===b})()"));
    await evaluate(cdp,"(function(){var b=document.querySelector('#chat-full-messages [data-msg-id=d41c_action_fav] .chat-msg-more');b.focus();return true})()");
    await cdp.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,nativeVirtualKeyCode:13});
    await cdp.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,nativeVirtualKeyCode:13});
    check('d41c.actionPopoverKeyboardOpen',await waitFor(cdp,"(function(){var b=document.querySelector('#chat-full-messages [data-msg-id=d41c_action_fav] .chat-msg-more'),p=b&&document.getElementById(b.getAttribute('aria-controls'));return !!p&&p.matches(':popover-open')&&b.getAttribute('aria-expanded')==='true'})()",3000),await evaluate(cdp,"(function(){var b=document.querySelector('#chat-full-messages [data-msg-id=d41c_action_fav] .chat-msg-more'),p=b&&document.getElementById(b.getAttribute('aria-controls'));return JSON.stringify({active:document.activeElement===b,tag:document.activeElement&&document.activeElement.tagName,expanded:b&&b.getAttribute('aria-expanded'),open:p&&p.matches(':popover-open')})})()"));
    await cdp.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27,nativeVirtualKeyCode:27});
    await cdp.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27,nativeVirtualKeyCode:27});
    await evaluate(cdp,"(function(){document.querySelector('#chat-full-messages [data-msg-id=d41c_action_fav] .chat-msg-fav').click();return true})()");
    check('d41c.favoriteOwnerAndPressedState',await waitFor(cdp,"(function(){var b=document.querySelector('#chat-full-messages [data-msg-id=d41c_action_fav] .chat-msg-fav');return b&&b.getAttribute('aria-pressed')==='true'})()",4000));
    await evaluate(cdp,"(function(){document.querySelector('#chat-full-messages [data-msg-id=d41c_action_fav] .chat-msg-fav').click();return true})()");
    check('d41c.favoriteCanBeRemoved',await waitFor(cdp,"(function(){var b=document.querySelector('#chat-full-messages [data-msg-id=d41c_action_fav] .chat-msg-fav');return b&&b.getAttribute('aria-pressed')==='false'})()",4000));
    await evaluate(cdp,"(async function(){if(window.IB&&IB.favorites)await IB.favorites.removeBySource('chat','d41c_action_fav');return true})()");
    await evaluate(cdp,"(function(){toggleChatSelectMode();return true})()");
    check('d41c.selectionControlIsNativeAndTouchable',await evaluate(cdp,"(function(){var b=document.querySelector('#chat-full-messages [data-msg-id=d41c_action_delete] .chat-sel-circle'),r=b&&b.getBoundingClientRect();return !!b&&b.tagName==='BUTTON'&&b.getAttribute('aria-label')==='选择此消息'&&r.width>=44&&r.height>=44})()"));
    await evaluate(cdp,"(function(){document.querySelector('#chat-full-messages [data-msg-id=d41c_action_delete] .chat-sel-circle').click();return true})()");
    check('d41c.selectionControlReflectsExistingSelectionOwner',await evaluate(cdp,"(function(){var b=document.querySelector('#chat-full-messages [data-msg-id=d41c_action_delete] .chat-sel-circle');return b&&b.getAttribute('aria-pressed')==='true'&&b.getAttribute('aria-label')==='取消选择此消息'&&_chatSelectedIds.has('d41c_action_delete')})()"));
    await evaluate(cdp,"(function(){toggleChatSelectMode();return true})()");
    await evaluate(cdp,"(function(){var b=document.querySelector('#chat-full-messages [data-msg-id=d41c_action_delete] .chat-msg-more');b.focus();b.click();return true})()");
    await waitFor(cdp,"(function(){var b=document.querySelector('#chat-full-messages [data-msg-id=d41c_action_delete] .chat-msg-more'),p=b&&document.getElementById(b.getAttribute('aria-controls'));return !!p&&p.matches(':popover-open')})()",3000);
    await evaluate(cdp,"(function(){var b=document.querySelector('#chat-full-messages [data-msg-id=d41c_action_delete] .chat-msg-more'),p=b&&document.getElementById(b.getAttribute('aria-controls')),d=p&&p.querySelector('[data-action=delete]');if(d)d.click();return true})()");
    check('d41c.deleteKeepsImmediateSemanticsAndFocusesStream',await waitFor(cdp,"(async function(){var remaining=await dbGet('chatMessages','d41c_action_delete'),host=document.getElementById('chat-full-messages');return !remaining&&!document.querySelector('#chat-full-messages [data-msg-id=d41c_action_delete]')&&document.activeElement===host&&!document.querySelector('dialog[open]')})()",5000),await evaluate(cdp,"(async function(){var remaining=await dbGet('chatMessages','d41c_action_delete'),host=document.getElementById('chat-full-messages');return JSON.stringify({remaining:!!remaining,bubble:!!document.querySelector('#chat-full-messages [data-msg-id=d41c_action_delete]'),focus:document.activeElement&&document.activeElement.id,hostTabindex:host&&host.getAttribute('tabindex'),dialog:!!document.querySelector('dialog[open]')})})()"));
    check('d41c.noImaginedMessageActions',await evaluate(cdp,"(function(){var text=document.querySelector('#chat-full-messages [data-msg-id=d41c_action_fav]').textContent;return !/复制|Copy|编辑|Edit|回复|Reply|重新生成|Regenerate|Retry|重试/i.test(text)})()"));
    await evaluate(cdp,"selectGroup('group_d41c_multi')");
    check('d41c.multiRoleHistoryKeepsA_B_AIdentity',await evaluate(cdp,"(function(){var rows=Array.from(document.querySelectorAll('#chat-full-messages [data-msg-id^=d41c_multi_]'));var ids=rows.map(function(x){return x.dataset.senderId});var names=rows.map(function(x){var n=x.querySelector('.r-head-name')||x.querySelector('.r-head');return n&&n.textContent||''});return ids.join(',')==='d41c_speaker_a,d41c_speaker_b,d41c_speaker_a'&&names[0].indexOf('Speaker A')>=0&&names[1].indexOf('Speaker B')>=0&&names[2].indexOf('Speaker A')>=0})()"));
    check('d41c.idleHasNoActiveSpeaker',await evaluate(cdp,"!document.querySelector('#chat-full-messages .chat-stream-activity')&&!document.querySelector('#chat-full-messages .chat-active-speaker')"));
    await evaluate(cdp,"(function(){document.getElementById('chat-full-input').value='请 @Speaker A 和 @Speaker B 分别回答。';window.__d41cGroupDone=false;window.__d41cGroupPromise=sendChatMessage();window.__d41cGroupPromise.then(function(r){window.__d41cGroupResult=r;window.__d41cGroupDone=true},function(){window.__d41cGroupDone=true});return true})()");
    check('d41c.groupCurrentSpeakerAIsRuntimeBacked',await waitFor(cdp,"(function(){var xs=document.querySelectorAll('#chat-full-messages .chat-stream-activity');return xs.length===1&&xs[0].dataset.speakerId==='d41c_speaker_a'&&/Speaker A 正在(思考|回复)/.test(xs[0].textContent)&&xs[0].closest('.chat-msg').dataset.senderId==='d41c_speaker_a'})()",6000));
    check('d41c.groupAStreamingStateIsVisible',await waitFor(cdp,"(function(){var x=document.querySelector('#chat-full-messages .chat-stream-activity');return x&&x.dataset.speakerId==='d41c_speaker_a'&&x.dataset.state==='streaming'&&x.textContent.indexOf('正在回复')>=0})()",4000),await evaluate(cdp,"(function(){var x=document.querySelector('#chat-full-messages .chat-stream-activity');return JSON.stringify({state:x&&x.dataset.state,speaker:x&&x.dataset.speakerId,text:x&&x.textContent,streamText:x&&x.closest('.chat-msg')&&x.closest('.chat-msg').querySelector('.r-text')&&x.closest('.chat-msg').querySelector('.r-text').textContent})})()"));
    check('d41c.groupSpeakerSwitchesAtoB',await waitFor(cdp,"(function(){var xs=document.querySelectorAll('#chat-full-messages .chat-stream-activity');return xs.length===1&&xs[0].dataset.speakerId==='d41c_speaker_b'&&/Speaker B 正在(思考|回复)/.test(xs[0].textContent)&&!document.querySelector('#chat-full-messages .chat-stream-activity[data-speaker-id=d41c_speaker_a]')})()",8000),await evaluate(cdp,"(function(){return JSON.stringify(Array.from(document.querySelectorAll('#chat-full-messages .chat-stream-activity')).map(function(x){return {state:x.dataset.state,speaker:x.dataset.speakerId,text:x.textContent}}))})()"));
    check('d41c.groupMessagesPreservePlannerOrder',await waitFor(cdp,"(async function(){var all=await dbGetByIndex('chatMessages','byFriend','group_d41c_multi');var xs=all.filter(function(m){return m.role==='assistant'&&m.metadata&&m.metadata.groupTurnId&&/^Speaker [AB] /.test(String(m.content||''))}).sort(function(a,b){return a.metadata.groupOrder-b.metadata.groupOrder});return xs.length===2&&xs[0].metadata.speakerId==='d41c_speaker_a'&&xs[1].metadata.speakerId==='d41c_speaker_b'&&Number(xs[0].metadata.groupOrder)===0&&Number(xs[1].metadata.groupOrder)===1})()",12000));
    check('d41c.groupRuntimeRequestOrderIsAthenB',await waitFor(cdp,"window.__d41cGroupDone===true",12000)&&mock.captured.groupRequests.slice(-2).join(',')==='d41c-speaker-a,d41c-speaker-b',JSON.stringify(mock.captured.groupRequests));
    check('d41c.groupP3EmotionalTexturePromptPresent',mock.captured.groupEmotionalTexture.slice(-2).length===2&&mock.captured.groupEmotionalTexture.slice(-2).every(Boolean),JSON.stringify(mock.captured.groupEmotionalTexture.slice(-2)));
    check('d41c.groupIdleClearsEverySpeaker',await evaluate(cdp,"!document.querySelector('#chat-full-messages .chat-stream-activity')&&!document.querySelector('#chat-full-messages .chat-active-speaker')"));
    check('d41c.groupRunCompletesWithoutPersistingUIState',await evaluate(cdp,"(async function(){var all=await dbGetByIndex('chatMessages','byFriend','group_d41c_multi');var user=all.find(function(m){return m.role==='user'&&String(m.content||'').indexOf('分别回答')>=0});var xs=all.filter(function(m){return m.role==='assistant'&&m.metadata&&m.metadata.groupTurnId&&/^Speaker [AB] /.test(String(m.content||''));});return window.__d41cGroupDone===true&&!!user&&user.metadata&&Array.isArray(user.metadata.targetSpeakerIds)&&xs.length===2&&!('activityState' in user)&&!xs.some(function(m){return m.metadata&&m.metadata.activityState})})()"));
    await evaluate(cdp,"(function(){document.getElementById('chat-full-input').value='group_quote_probe @Speaker A';window.__groupQuoteDone=false;window.__groupQuotePromise=sendChatMessage();window.__groupQuotePromise.then(function(r){window.__groupQuoteResult=r;window.__groupQuoteDone=true},function(){window.__groupQuoteDone=true});return true})()");
    check('quote.groupStreamingPersistsExactSourcePointer',await waitFor(cdp,"(async function(){var all=await dbGetByIndex('chatMessages','byFriend','group_d41c_multi'),u=all.filter(function(m){return m.role==='user'&&String(m.content||'').indexOf('group_quote_probe')>=0}).pop(),q=all.filter(function(m){return m.role==='assistant'&&m.metadata&&m.metadata.replyQuote}).pop();return window.__groupQuoteDone===true&&!!u&&!!q&&q.metadata.replyQuote.sourceMessageId===u.id&&q.metadata.replyQuote.snippet===u.content&&q.metadata.replyQuote.sourceSenderKey==='user:local'&&q.content.indexOf('<ib_reply_quote>')<0})()",12000),await evaluate(cdp,"(async function(){var all=await dbGetByIndex('chatMessages','byFriend','group_d41c_multi'),u=all.filter(function(m){return m.role==='user'&&String(m.content||'').indexOf('group_quote_probe')>=0}).pop(),q=all.filter(function(m){return m.role==='assistant'&&m.metadata&&m.metadata.groupTurnId}).slice(-2);return JSON.stringify({done:window.__groupQuoteDone,result:window.__groupQuoteResult,user:u&&{id:u.id,content:u.content,targets:u.metadata&&u.metadata.targetSpeakerIds},recent:q.map(function(m){return {content:m.content,speaker:m.metadata&&m.metadata.speakerId,quote:m.metadata&&m.metadata.replyQuote}}),exceptions:window.__exceptions||[]})})()"));
    check('quote.groupCardLocatesCurrentUserMessage',await waitFor(cdp,"(function(){var card=document.querySelector('#chat-full-messages .ib-reply-quote-card[data-source-message-id]');if(card)card.click();var rows=Array.from(document.querySelectorAll('#chat-full-messages .chat-msg[data-msg-id]'));var source=rows.find(function(x){return x.dataset.msgId===String(card&&card.dataset.sourceMessageId||'')});return !!card&&!!source&&source.classList.contains('ib-reply-quote-target')&&card.textContent.indexOf('group_quote_probe')>=0})()",5000),await evaluate(cdp,"(function(){var card=document.querySelector('#chat-full-messages .ib-reply-quote-card[data-source-message-id]');return JSON.stringify({card:card&&card.outerHTML,rows:Array.from(document.querySelectorAll('#chat-full-messages .chat-msg[data-msg-id]')).slice(-5).map(function(x){return {id:x.dataset.msgId,text:x.textContent,cls:x.className}})})})()"));
    await captureChatEvidence('chat-multirole-320-internal',320,780);
    await evaluate(cdp,"selectFriend('d41b_long')");
    await cdp.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
    const assistantCountBeforeStop=await evaluate(cdp,"(async function(){var all=await dbGetByIndex('chatMessages','byFriend','d41b_long');return all.filter(function(m){return m.role==='assistant'}).length})()");
    await evaluate(cdp, "selectFriend('d41b_long')");
    await waitFor(cdp,"Array.from(document.querySelectorAll('#chat-full-messages img')).every(function(img){return img.complete})",3000);
    await new Promise(resolve=>setTimeout(resolve,100));
    await evaluate(cdp, "(function(){document.getElementById('chat-full-input').value='d41b stream scroll test';window.__d41bStreamPromise=sendChatMessage();return true})()");
    check('d41c.streamThinkingIsRuntimeBacked', await waitFor(cdp,"(function(){var s=document.querySelector('#chat-full-messages .chat-stream-activity[data-state=thinking]');return s&&s.getAttribute('role')==='status'&&s.getAttribute('aria-live')==='polite'&&s.textContent.indexOf('Long Talk')>=0&&document.querySelector('#chat-full-messages .chat-stream-cursor[aria-live=off]')})()",3000));
    check('d41c.reducedMotionKeepsActivityVisible', await evaluate(cdp,"(function(){var s=document.querySelector('#chat-full-messages .chat-stream-activity'),c=document.querySelector('#chat-full-messages .chat-stream-cursor');return !!s&&getComputedStyle(c,'::after').animationName==='none'&&s.textContent.indexOf('正在思考')>=0})()"));
    check('d41b.streamNodeAppears', await waitFor(cdp, "document.querySelector('#chat-full-messages .chat-stream-cursor') && document.getElementById('chat-full-messages').textContent.includes('流式第一段内容')", 8000));
    check('d41c.streamStateStartsOnContent', await evaluate(cdp,"(function(){var s=document.querySelector('#chat-full-messages .chat-stream-activity');return s&&s.dataset.state==='streaming'&&s.textContent.indexOf('正在回复')>=0})()"));
    check('d41b.stopControlReachableAt320', await evaluate(cdp, "(function(){var b=document.getElementById('chat-stop-full').getBoundingClientRect();return getComputedStyle(document.getElementById('chat-stop-full')).display!=='none'&&b.width>=44&&b.height>=44})()"));
    const stopActivityState=await evaluate(cdp,"(function(){stopStreaming();var s=document.querySelector('#chat-full-messages .chat-stream-activity');return s&&s.dataset.state})()");
    check('d41c.stopStateVisibleOnlyDuringAbort',stopActivityState==='stopping',String(stopActivityState));
    const stopStreamResult=await evaluate(cdp,"window.__d41bStreamPromise");
    const assistantCountAfterStop=await evaluate(cdp,"(async function(){var all=await dbGetByIndex('chatMessages','byFriend','d41b_long');return all.filter(function(m){return m.role==='assistant'}).length})()");
    const stoppedTurnDelta=Number(assistantCountAfterStop)-Number(assistantCountBeforeStop);
    check('d41c.stopPreservesOnlyReceivedTurn',!!stopStreamResult&&stoppedTurnDelta>=0&&stoppedTurnDelta<=1&&((stopStreamResult.ok===true)===(stoppedTurnDelta===1)),JSON.stringify({result:stopStreamResult,assistantDelta:stoppedTurnDelta}));
    check('d41b.stopReturnsComposerControl', await waitFor(cdp, "getComputedStyle(document.getElementById('chat-stop-full')).display==='none' && getComputedStyle(document.getElementById('chat-send-full')).display!=='none' && !document.querySelector('#chat-full-messages .chat-stream-activity') && !document.querySelector('#page-chat .chat-input-area').hasAttribute('aria-busy')", 8000));
    await evaluate(cdp, "selectFriend('d41c_scroll')");
    const assistantCountBeforeComplete=await evaluate(cdp,"(async function(){var all=await dbGetByIndex('chatMessages','byFriend','d41c_scroll');return all.filter(function(m){return m.role==='assistant'}).length})()");
    await evaluate(cdp, "(function(){document.getElementById('chat-full-input').value='d41b stream completion test';window.__d41bCompleteDone=false;window.__d41bCompletePromise=sendChatMessage();window.__d41bCompletePromise.then(function(r){window.__d41bCompleteResult=r;window.__d41bCompleteDone=true},function(){window.__d41bCompleteDone=true});return true})()");
    check('d41b.streamSecondChunkArrives', await waitFor(cdp, "document.querySelector('#chat-full-messages .chat-stream-cursor') && document.getElementById('chat-full-messages').textContent.includes('流式第一段内容')", 8000));
    const streamScrollBefore = await evaluate(cdp, "(function(){var el=document.getElementById('chat-full-messages');el.scrollTop=120;el.dispatchEvent(new Event('scroll'));return {scrollTop:el.scrollTop,stick:el._ibWin&&el._ibWin.stick,scrollHeight:el.scrollHeight,clientHeight:el.clientHeight,distance:el.scrollHeight-el.scrollTop-el.clientHeight}})()");
    check('d41c.streamFinalPersists', await waitFor(cdp, "(async function(){var all=await dbGetByIndex('chatMessages','byFriend','d41c_scroll');return all.some(function(m){return m.role==='assistant'&&String(m.content).includes('流式最后一段结束')})})()", 8000));
    await waitFor(cdp,"window.__d41bCompleteDone===true",8000);
    check('d41c.streamStateClearsAfterFinal', await evaluate(cdp,"!document.querySelector('#chat-full-messages .chat-stream-activity')"), await evaluate(cdp,"JSON.stringify({done:window.__d41bCompleteDone,states:Array.from(document.querySelectorAll('#chat-full-messages .chat-stream-activity')).map(function(e){return {state:e.dataset.state,text:e.textContent,friend:e.dataset.friendId,thread:e.dataset.threadId,msg:e.parentNode&&e.parentNode.dataset.msgId}})})"));
    const streamScrollAfter = await evaluate(cdp, "document.getElementById('chat-full-messages').scrollTop");
    check('d41b.streamDeltaDoesNotResetManualScroll', Math.abs(Number(streamScrollBefore&&streamScrollBefore.scrollTop)-Number(streamScrollAfter))<2, JSON.stringify({before:streamScrollBefore,after:streamScrollAfter}));
    const completionResult=await evaluate(cdp,"window.__d41bCompleteResult||null");
    const assistantCountAfterComplete=await evaluate(cdp,"(async function(){var all=await dbGetByIndex('chatMessages','byFriend','d41c_scroll');return all.filter(function(m){return m.role==='assistant'}).length})()");
    check('d41c.finalAssistantStoredOnce', completionResult&&completionResult.ok===true&&Number(assistantCountAfterComplete)-Number(assistantCountBeforeComplete)===1&&await evaluate(cdp,"(async function(id){var m=await dbGet('chatMessages',id);return !!m&&m.friendId==='d41c_scroll'&&m.role==='assistant'&&String(m.content).includes('流式最后一段结束')})("+JSON.stringify(completionResult&&completionResult.messageId)+")"),JSON.stringify({result:completionResult,countBefore:assistantCountBeforeComplete,countAfter:assistantCountAfterComplete}));
    await cdp.send('Emulation.setEmulatedMedia',{features:[]});
    await evaluate(cdp, "(async function(){var syntheticFriends=['d41b_mira','d41b_empty','d41b_long','d41b_error','d41c_slow','d41c_scroll','d41c_failure','d41c_actions','group_d41b','group_d41c_multi'];var all=await dbGetAll('chatMessages');for(var j=0;j<all.length;j++){if(syntheticFriends.indexOf(String(all[j].friendId||''))>=0||String(all[j].id).startsWith('d41b_')||String(all[j].id).startsWith('d41c_'))await dbDelete('chatMessages',all[j].id)};var removeConfigs=['d41b_mira','d41b_empty','d41b_long','d41b_error','d41c_slow','d41c_scroll','d41c_failure','d41c_actions','d41c_speaker_a','d41c_speaker_b'];for(var k=0;k<removeConfigs.length;k++)await dbDelete('apiConfigs',removeConfigs[k]);await dbDelete('groups','group_d41b');await dbDelete('groups','group_d41c_multi');await dbDelete('chatThreads','d41b_thread');return true})()");

    const chatPageExitVoice = await evaluate(cdp, "(async function(){var cfg=window.apiConfigs.find(function(x){return x.id==='smoke_friend'}),oldVoice=cfg&&cfg.voice?JSON.parse(JSON.stringify(cfg.voice)):null,oldFetch=window.fetch,oldPrefs=localStorage.getItem('ib_voice_prefs'),root=document.getElementById('chat-full-messages'),bubble=document.createElement('div'),aborted=false;try{var prefs={};try{prefs=JSON.parse(oldPrefs||'{}')}catch(e){}prefs.showVoiceButton=true;localStorage.setItem('ib_voice_prefs',JSON.stringify(prefs));cfg.voice=Object.assign({},cfg.voice||{},{enabled:true,autoPlay:false,source:'edge',provider:'edge',voiceId:'smoke-voice'});bubble.className='chat-msg ai';bubble.dataset.msgId='voice-page-exit-smoke';bubble.dataset.senderId='smoke_friend';bubble.innerHTML='<div class=\"r-text\">Page exit state test</div>';root.appendChild(bubble);window.fetch=function(input,options){var o=options||{};if(String(input).indexOf('/api/tts')>=0)return new Promise(function(resolve,reject){if(o.signal){if(o.signal.aborted){aborted=true;reject(new Error('aborted'));return}o.signal.addEventListener('abort',function(){aborted=true;var e=new Error('aborted');e.name='AbortError';reject(e)},{once:true})}});return oldFetch.apply(this,arguments)};var end=Date.now()+1200,button=null;while(Date.now()<end&&!button){button=bubble.querySelector('.ib-tts-btn');if(!button)await new Promise(function(r){setTimeout(r,10)})}if(!button)return {button:false};button.click();await Promise.resolve();var before=bubble.dataset.voiceStatus||'';navTo('home');await new Promise(function(r){setTimeout(r,0)});var left=currentPage==='home',after=bubble.dataset.voiceStatus||'';navTo('chat');return {button:true,before:before,after:after,aborted:aborted,left:left}}finally{navTo('chat');window.fetch=oldFetch;if(oldPrefs==null)localStorage.removeItem('ib_voice_prefs');else localStorage.setItem('ib_voice_prefs',oldPrefs);if(cfg){if(oldVoice)cfg.voice=oldVoice;else delete cfg.voice}if(bubble.parentNode)bubble.remove()}})()");
    check('chat.navigationExitStopsActualPendingTtsRequest', chatPageExitVoice && chatPageExitVoice.button && chatPageExitVoice.before === 'thinking' && chatPageExitVoice.after === 'interrupted' && chatPageExitVoice.aborted && chatPageExitVoice.left, JSON.stringify(chatPageExitVoice));

    /* 5. 全程无未捕获异常 */
    const gameOrChatErrors = exceptions.filter(text => /game_|communication|ReferenceError|TypeError/.test(text));
    check('runtime.noExceptions', exceptions.length === 0, exceptions.slice(0, 2).join(' || ').slice(0, 400));
    console.log('  INFO  exceptions captured: ' + exceptions.length);
  } finally {
    if (cdp) cdp.close();
    mock.server.close();
    try { browser.kill(); } catch (error) { /* ignore */ }
    if (browser.exitCode === null && browser.signalCode === null) {
      await Promise.race([
        new Promise(resolve => browser.once('exit', resolve)),
        new Promise(resolve => setTimeout(resolve, 4000))
      ]);
    }
    try { fs.rmSync(profile, { recursive: true, force: true }); }
    catch (error) { failures++; console.error('  FAIL  browser.profileCleaned  -> ' + profile); }
  }

  console.log('  INFO  D4.1-B browser evidence: ' + evidenceDir);
  console.log(failures === 0 ? '\nChat smoke test passed ✔' : '\nChat smoke test FAILED ✘');
  process.exit(failures ? 1 : 0);
}

main().catch(error => { console.error(error); process.exit(1); });
