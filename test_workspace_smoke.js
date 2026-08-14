'use strict';

/* SUI'S ROOM — Workspace/ICode 冒烟测试（Node 18+，零依赖，需本机 Chrome / Edge）。
   覆盖：默认/User 项目初始化、项目增删改、文件创建与重名保护、导入、持久化重载、
   文本/HTML 预览与富文件分派助手、JS 沙箱成功/异常/超时、AI 工作区指令成功与失败反馈、
   window 与 IB.workspace.* 双挂载、全程未捕获异常收集。 */

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

async function main() {
  const chrome = chromePath();
  if (!chrome) throw new Error('未找到 Chrome / Edge；可通过 CHROME_PATH 指定浏览器');
  const port = await freePort();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-ws-smoke-'));
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

    check('page.wsReady', await waitFor(cdp, "typeof window.IB === 'object' && window.IB.workspace && typeof window.openWorkspace === 'function' && typeof window.wsCreateProject === 'function'", 20000));
    check('dual.basic', await evaluate(cdp, "typeof window.openWorkspace === 'function' && typeof window.IB.workspace.openWorkspace === 'function' && typeof window.wsSaveFile === 'function' && window.IB.workspace.files && typeof window.IB.workspace.files.wsSaveFile === 'function' && typeof window.IB.workspace.files.wsCreateProject === 'function'"));
    check('dual.run', await evaluate(cdp, "typeof window._wsRunJs === 'function' && window.IB.workspace.run && typeof window.IB.workspace.run._wsRunJs === 'function' && typeof window.IB.workspace.run._wsExecuteRun === 'function'"));
    check('dual.preview', await evaluate(cdp, "typeof window.wsTogglePreview === 'function' && window.IB.workspace.preview && typeof window.IB.workspace.preview.wsTogglePreview === 'function' && typeof window._icodeIsRich === 'function' && typeof window.IB.workspace.preview._icodeIsRich === 'function'"));

    /* 1. 默认/User 项目初始化 */
    await evaluate(cdp, "openWorkspace()");
    await evaluate(cdp, "wsEnsureDefaultProject(); wsEnsureUserProject();");
    check('proj.defaultUser', await evaluate(cdp, "(async function(){ var d = await dbGet('projects', WS_DEFAULT_PROJ_ID); var u = await dbGet('projects', WS_USER_PROJ_ID); return !!d && !!u; })()"));

    /* 2. 项目创建/重命名/删除 + 默认项目不可删 */
    const projId = await evaluate(cdp, "wsCreateProject('SmokeProj')");
    check('proj.create', typeof projId === 'string' && projId.length > 0);
    await evaluate(cdp, "wsRenameProject('" + projId + "', 'SmokeProj2')");
    check('proj.rename', await evaluate(cdp, "(async function(){ var p = await dbGet('projects', '" + projId + "'); return !!p && p.name === 'SmokeProj2'; })()"));
    await evaluate(cdp, "wsDeleteProject(WS_DEFAULT_PROJ_ID)");
    check('proj.defaultUndeletable', await evaluate(cdp, "(async function(){ return !!(await dbGet('projects', WS_DEFAULT_PROJ_ID)); })()"));
    await evaluate(cdp, "wsDeleteProject('" + projId + "')");
    check('proj.delete', await evaluate(cdp, "(async function(){ return !(await dbGet('projects', '" + projId + "')); })()"));

    /* 3. 文件创建 / 覆盖 / 重名保护 / 导入 / 持久化重载 */
    const fileId = await evaluate(cdp, "wsSaveFile(WS_DEFAULT_PROJ_ID, 'smoke.txt', 'hello world', 'smoke')");
    check('file.create', typeof fileId === 'string' && fileId.length > 0);
    const fileId2 = await evaluate(cdp, "wsSaveFile(WS_DEFAULT_PROJ_ID, 'smoke.txt', 'v2 content', 'smoke')");
    check('file.overwrite', fileId === fileId2, fileId + ' vs ' + fileId2);
    check('file.collision', await evaluate(cdp, "(async function(){ return (await _wsUniquePath(WS_DEFAULT_PROJ_ID, 'smoke.txt')) === 'smoke (2).txt'; })()"));
    await evaluate(cdp, "wsSaveFile(WS_DEFAULT_PROJ_ID, 'smoke (2).txt', 'collision copy', 'smoke')");
    check('file.reload', await evaluate(cdp, "(async function(){ var files = await wsGetFiles(WS_DEFAULT_PROJ_ID); var s = files.find(function(f){return f.path==='smoke.txt'}); var c = files.find(function(f){return f.path==='smoke (2).txt'}); return files.length >= 2 && s.content === 'v2 content' && c.content === 'collision copy'; })()"));
    await evaluate(cdp, "(async function(){ var out={list:[],total:0,stop:false},skip={bin:0,doc:0,big:0,dir:0,err:0,over:false}; await _icodeCollectFlatFiles([new File(['导入内容'], 'imported.txt')], out, skip); return _icodeDoImport({files:out.list,total:out.total,skip:skip,rootName:'',zipNoInflate:false}, WS_DEFAULT_PROJ_ID, 'import'); })()");
    check('file.import', await evaluate(cdp, "(async function(){ return !!(await wsGetFileByPath(WS_DEFAULT_PROJ_ID, 'imported.txt')); })()"));

    /* 4. 预览：文本 / HTML / 富文件分派助手 */
    const htmlFileId = await evaluate(cdp, "wsSaveFile(WS_DEFAULT_PROJ_ID, 'page.html', '<h1>Hi</h1>', 'smoke')");
    await evaluate(cdp, "renderWsFiles(WS_DEFAULT_PROJ_ID)");
    check('preview.rowRendered', await waitFor(cdp, "!!document.getElementById('wsf-" + fileId + "')", 8000));
    await evaluate(cdp, "wsTogglePreview('" + fileId + "')");
    check('preview.text', await waitFor(cdp, "(function(){ var p=document.getElementById('wsp-" + fileId + "'); return !!p && p.querySelector('.ws-preview-code') && p.querySelector('.ws-preview-code').textContent.indexOf('v2 content') >= 0; })()", 8000));
    await evaluate(cdp, "wsTogglePreview('" + fileId + "')");
    check('preview.textClose', await evaluate(cdp, "!document.getElementById('wsp-" + fileId + "')"));
    await evaluate(cdp, "wsTogglePreview('" + htmlFileId + "')");
    check('preview.htmlRenderBtn', await evaluate(cdp, "(function(){ var p=document.getElementById('wsp-" + htmlFileId + "'); return !!p && !!p.querySelector('[data-wsact=\"render\"]'); })()"));
    await evaluate(cdp, "wsTogglePreview('" + htmlFileId + "')");
    check('preview.dispatch', await evaluate(cdp, "_icodeIsText('a.txt') === true && _icodeIsRich('a.pdf') === true && _icodeIsRich('a.txt') === false && _wsRichKind('a.docx') === 'docx' && _wsRichMime('a.pdf') === 'application/pdf'"));
    check('preview.binarySniff', await evaluate(cdp, "(function(){ var bin = _icodeLooksBinary(new Uint8Array([0, 0, 1, 2])); var txt = _icodeLooksBinary(new TextEncoder().encode('plain text')); return bin === true && txt === false; })()"));

    /* 5. JS 沙箱：成功 / 异常 / 超时 */
    const runOk = await evaluate(cdp, "_wsRunJs('console.log(2+3)', '', [], 3000)");
    check('run.ok', runOk && runOk.ok === true && String(runOk.output).indexOf('5') >= 0, JSON.stringify(runOk).slice(0, 160));
    const runErr = await evaluate(cdp, "_wsRunJs(\"throw new Error('boom')\", '', [], 3000)");
    check('run.error', runErr && runErr.ok === false && String(runErr.errText).indexOf('boom') >= 0, JSON.stringify(runErr).slice(0, 160));
    const runTimeout = await evaluate(cdp, "_wsRunJs('while(true){}', '', [], 400)");
    check('run.timeout', runTimeout && runTimeout.ok === false && runTimeout.timedOut === true, JSON.stringify(runTimeout).slice(0, 160));

    /* 6. AI 工作区指令：成功创建 + 失败反馈闭环 */
    const ops = await evaluate(cdp, "(function(){ var r = _parseWsOps('<ws_create path=\"ai.txt\">AI内容</ws_create>'); return JSON.stringify(r && r.ops && r.ops.map(function(o){return o.type})); })()");
    check('ai.parse', ops.indexOf('create') >= 0, ops);
    await evaluate(cdp, "_execWsOps(_parseWsOps('<ws_create path=\"ai.txt\">AI内容</ws_create>').ops, 'SmokeAI', null)");
    check('ai.createSuccess', await evaluate(cdp, "(async function(){ var f = await wsGetFileByPath(WS_DEFAULT_PROJ_ID, 'ai.txt'); return !!f && f.content.indexOf('AI内容') >= 0; })()"));
    await evaluate(cdp, "_execWsOps(_parseWsOps('<ws_read path=\"missing-file.txt\"/>').ops, 'SmokeAI', null)");
    check('ai.failFeedback', await evaluate(cdp, "String(_getWsOpFeedbackInjection()).indexOf('missing-file.txt') >= 0"));

    /* 7. 全程无未捕获异常 */
    check('runtime.noExceptions', exceptions.length === 0, exceptions.slice(0, 2).join(' || ').slice(0, 400));
    console.log('  INFO  exceptions captured: ' + exceptions.length);
  } finally {
    if (cdp) cdp.close();
    try { browser.kill(); } catch (error) { /* ignore */ }
  }

  console.log(failures === 0 ? '\nWorkspace smoke test passed ✔' : '\nWorkspace smoke test FAILED ✘');
  process.exit(failures ? 1 : 0);
}

main().catch(error => { console.error(error); process.exit(1); });
