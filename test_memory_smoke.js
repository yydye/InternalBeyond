'use strict';

/* SUI'S ROOM — Memory 冒烟测试（Node 18+，零依赖，需本机 Chrome / Edge）。
   覆盖：记忆增删改与持久化重载、Auto Memory mock 模型生成/解析/去重/失败降级、
   记忆注入聊天上下文（getMemoryContext）、星座数据生成与重渲染（_memSkyConstellations）、
   空数据与损坏数据兼容、window 与 IB.memory.* 双挂载、跨模块状态同步（_cachedUserName）、
   全程未捕获异常收集。 */

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
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('CDP timeout: ' + method)); } }, 15000);
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
  const state = { mode: 'valid' };
  const server = http.createServer((req, res) => {
    const headers = {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-API-Key'
    };
    if (req.method === 'OPTIONS') { res.writeHead(204, headers); res.end(); return; }
    if (req.method === 'POST' && req.url.includes('/chat/completions')) {
      if (state.mode === 'error') { res.writeHead(500, headers); res.end(JSON.stringify({ error: 'mock failure' })); return; }
      if (state.mode === 'garbage') { res.writeHead(200, headers); res.end(JSON.stringify({ choices: [{ message: { content: '这不是记忆，只是一段废话文本。' } }] })); return; }
      res.writeHead(200, headers);
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ title: '喜欢下雨天', summary: '用户喜欢下雨天。', content: '从对话里记下：用户喜欢下雨天，雨声让人安心。', domain: '情感', tags: ['雨'], valence: 0.6, arousal: 0.4, importance: 6, resolved: false, visibility: 'public', confidence: 80, reasons: ['用户明确表达'] }) } }] }));
      return;
    }
    res.writeHead(404, headers);
    res.end(JSON.stringify({ error: 'not found' }));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, state, port: server.address().port }));
  });
}

async function main() {
  const chrome = chromePath();
  if (!chrome) throw new Error('未找到 Chrome / Edge；可通过 CHROME_PATH 指定浏览器');
  const mock = await startMockApi();
  const port = await freePort();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-mem-smoke-'));
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
    await evaluate(cdp, "window.confirm = function(){ return true; };");

    check('page.memReady', await waitFor(cdp, "typeof window.IB === 'object' && window.IB.memory && typeof window.getMemoryContext === 'function' && typeof window.quickCreateMemory === 'function'", 20000));
    check('dual.crud', await evaluate(cdp, "typeof window.getMemoryContext === 'function' && typeof window.IB.memory.getMemoryContext === 'function' && typeof window.quickCreateMemory === 'function' && typeof window.IB.memory.quickCreateMemory === 'function'"));
    check('dual.autoMem', await evaluate(cdp, "typeof window._parseMemOps === 'function' && typeof window.IB.memory.autoMem._parseMemOps === 'function' && typeof window._generateMemoryCore === 'function'"));
    check('dual.sky', await evaluate(cdp, "typeof window._memSkyConstellations === 'function' && typeof window.IB.memory.constellations._memSkyConstellations === 'function' && typeof window.buildMemorySky === 'function'"));

    /* 0. 空数据与损坏数据兼容 */
    await evaluate(cdp, "renderMemories()");
    check('empty.renderNoThrow', await evaluate(cdp, "true"));
    await evaluate(cdp, "dbPut('memories', { id:'mem_corrupt', title:null, content:123, valence:'bad', arousal:null })");
    check('corrupt.scoreSurvives', await evaluate(cdp, "(function(){ var s = getMemoryScore({ title:null, content:123 }); return typeof s === 'number'; })()"));
    await evaluate(cdp, "renderMemories()");
    await evaluate(cdp, "dbDelete('memories','mem_corrupt')");

    /* 1. 记忆增删改与持久化重载 */
    const memId = await evaluate(cdp, "quickCreateMemory({ title:'雨天的记忆', summary:'喜欢下雨天。', content:'用户说雨声让人安心。', domain:'日常', tags:['雨'], valence:0.6, arousal:0.3, importance:5, visibility:'public' })");
    check('crud.create', typeof memId === 'string' && memId.length > 0);
    check('crud.reload', await evaluate(cdp, "(async function(){ var m = await dbGet('memories', '" + memId + "'); return !!m && m.title === '雨天的记忆'; })()"));
    await evaluate(cdp, "toggleMemPin('" + memId + "')");
    check('crud.pin', await evaluate(cdp, "(async function(){ var m = await dbGet('memories', '" + memId + "'); return m.pinned === true; })()"));
    await evaluate(cdp, "toggleMemResolved('" + memId + "')");
    check('crud.resolve', await evaluate(cdp, "(async function(){ var m = await dbGet('memories', '" + memId + "'); return m.resolved === true; })()"));
    await evaluate(cdp, "deleteMemory('" + memId + "')");
    check('crud.delete', await evaluate(cdp, "(async function(){ return !(await dbGet('memories', '" + memId + "')); })()"));

    /* 2. 记忆注入聊天上下文 */
    const memId2 = await evaluate(cdp, "quickCreateMemory({ title:'上下文注入测试', summary:'注入摘要', content:'这是用于上下文注入测试的记忆内容。', domain:'日常', importance:8, visibility:'public' })");
    const ctx = await evaluate(cdp, "getMemoryContext('smoke_mem_friend', { maxChars: 2000 })");
    check('context.inject', typeof ctx === 'string' && ctx.indexOf('上下文注入测试') >= 0, String(ctx).slice(0, 120));
    await evaluate(cdp, "deleteMemory('" + memId2 + "')");

    /* 3. 星座数据生成与重渲染（与 memory-sky.js 画布星场区分：这里是 SVG 连线层） */
    await evaluate(cdp, "(function(){ var old=document.getElementById('mem-sky-lines'); if(old) old.remove(); var svg=document.createElementNS('http://www.w3.org/2000/svg','svg'); svg.id='mem-sky-lines'; document.body.appendChild(svg); })()");
    const linesNear = await evaluate(cdp, "(function(){ _memSkyConstellations([{x:10,y:10,d:'日常'},{x:14,y:11,d:'日常'},{x:18,y:12,d:'日常'},{x:60,y:60,d:'创作'}]); var svg=document.getElementById('mem-sky-lines'); return svg ? svg.querySelectorAll('line').length : -1; })()");
    check('sky.linesNear', linesNear >= 1, String(linesNear));
    const linesFar = await evaluate(cdp, "(function(){ _memSkyConstellations([{x:10,y:10,d:'日常'},{x:80,y:80,d:'日常'},{x:90,y:90,d:'创作'}]); var svg=document.getElementById('mem-sky-lines'); return svg ? svg.querySelectorAll('line').length : -1; })()");
    check('sky.rerender', linesFar === 0, String(linesFar));

    /* 4. 跨模块状态同步（_cachedUserName 属 communication，_amUserName 读它） */
    check('sync.cachedUserName', await evaluate(cdp, "(function(){ var n = _amUserName(); return typeof n === 'string' && n.length > 0; })()"));

    /* 5. Auto Memory：mock 模型生成 → 解析 → 审批 → 落库；去重；失败降级 */
    const mockEndpoint = 'http://127.0.0.1:' + mock.port + '/v1/chat/completions';
    await evaluate(cdp, "(async function(){ var cfg={ id:'smoke_mem_friend', nickname:'SmokeMem', model:'smoke-model', endpoint:'" + mockEndpoint + "', apiKey:'', provider:'custom', relationship:'测试', systemPrompt:'', temperature:1, streaming:false, autoMem:true }; await dbPut('apiConfigs', cfg); await loadApiConfigs(); })()");
    check('am.cfgReady', await evaluate(cdp, "apiConfigs.some(function(a){return a.id==='smoke_mem_friend'})"));
    check('am.parse', await evaluate(cdp, "(function(){ var p = parseMemoryCandidateResponse(JSON.stringify({title:'解析测试',summary:'s',content:'c',domain:'情感',tags:['t'],valence:0.5,arousal:0.3,importance:5,resolved:false,visibility:'public',confidence:70,reasons:['r']})); return p.title === '解析测试' && p.domain === '情感'; })()"));
    await evaluate(cdp, "(function(){ _generateMemoryCore(apiConfigs.find(function(a){return a.id==='smoke_mem_friend'}), '请记住用户喜欢下雨天', { source:'chat', createdBy:'smoke_mem_friend' }); return true; })()");
    check('am.queued', await waitFor(cdp, "_memoryApprovalQueue.length >= 1 || _memoryApprovalActive !== null", 10000));
    await evaluate(cdp, "_resolveMemoryApproval(true)");
    check('am.created', await waitFor(cdp, "(async function(){ var all = await dbGetAll('memories'); return all.some(function(m){return m.title === '喜欢下雨天' && m.createdBy === 'smoke_mem_friend'}); })()", 10000));
    const repeat = await evaluate(cdp, "(async function(){ return await _memoryRepeatCount('用户喜欢下雨天','memories', apiConfigs.find(function(a){return a.id==='smoke_mem_friend'})); })()");
    check('am.dedup', repeat >= 1, String(repeat));
    mock.state.mode = 'error';
    await evaluate(cdp, "(function(){ _generateMemoryCore(apiConfigs.find(function(a){return a.id==='smoke_mem_friend'}), '请记住另一个偏好', { source:'chat', createdBy:'smoke_mem_friend' }); return true; })()");
    await new Promise(resolve => setTimeout(resolve, 800));
    check('am.failNoThrow', await evaluate(cdp, "(async function(){ var all = await dbGetAll('memories'); return !all.some(function(m){return m.title === '喜欢下雨天' && m.summary === '' && m.content.indexOf('另一个偏好') >= 0}); })()"));

    /* 6. 全程无未捕获异常 */
    check('runtime.noExceptions', exceptions.length === 0, exceptions.slice(0, 2).join(' || ').slice(0, 400));
    console.log('  INFO  exceptions captured: ' + exceptions.length);
  } finally {
    if (cdp) cdp.close();
    mock.server.close();
    try { browser.kill(); } catch (error) { /* ignore */ }
  }

  console.log(failures === 0 ? '\nMemory smoke test passed ✔' : '\nMemory smoke test FAILED ✘');
  process.exit(failures ? 1 : 0);
}

main().catch(error => { console.error(error); process.exit(1); });
