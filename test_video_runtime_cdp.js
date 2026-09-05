/* ====================================================================
   P2 Stage 1 · Video Runtime · CDP 端到端（需本机 Chrome / Edge）
   --------------------------------------------------------------------
   用 canvas.captureStream() 作 mock 相机源（headless 无真摄像头），
   喂给 <video>，验证 Video Runtime 的真实 captureFrame：
     - 返回原始帧 {dataUrl(data:image/jpeg), width, height, timestamp}
     - 帧不进入 chatMessages / memories（request-local）
     - free() 释放：摘流(srcObject=null)、清内存帧、tracks ended
   运行：node test_video_runtime_cdp.js
   ==================================================================== */
'use strict';

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
  for (const c of [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
  ]) if (fs.existsSync(c)) return c;
  return null;
}

class Cdp {
  constructor(socket) { this.socket = socket; this.buffer = Buffer.alloc(0); this.id = 0; this.pending = new Map(); this.listeners = new Map(); socket.on('data', c => { this.buffer = Buffer.concat([this.buffer, c]); this.parse(); }); socket.on('error', () => {}); }
  static connect(wsUrl) {
    return new Promise((resolve, reject) => {
      const url = new URL(wsUrl);
      const request = http.request({ host: url.hostname, port: url.port, path: url.pathname + url.search, headers: { Upgrade: 'websocket', Connection: 'Upgrade', 'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'), 'Sec-WebSocket-Version': '13' } });
      request.on('upgrade', (response, socket) => resolve(new Cdp(socket))); request.on('error', reject); request.end();
    });
  }
  on(method, l) { if (!this.listeners.has(method)) this.listeners.set(method, []); this.listeners.get(method).push(l); }
  send(method, params = {}) {
    const id = ++this.id; return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.sendText({ id, method, params }); setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('CDP timeout: ' + method)); } }, 15000); });
  }
  sendText(message) { const p = Buffer.from(JSON.stringify(message), 'utf8'); const mask = crypto.randomBytes(4); const b = Buffer.alloc(p.length); for (let i = 0; i < p.length; i++) b[i] = p[i] ^ mask[i & 3]; let h; if (p.length < 126) h = Buffer.from([0x81, 0x80 | p.length]); else { h = Buffer.alloc(4); h[0] = 0x81; h[1] = 0x80 | 126; h.writeUInt16BE(p.length, 2); } this.socket.write(Buffer.concat([h, mask, b])); }
  sendFrame(op, p) { const mask = crypto.randomBytes(4); const b = Buffer.alloc(p.length); for (let i = 0; i < p.length; i++) b[i] = p[i] ^ mask[i & 3]; let h; if (p.length < 126) h = Buffer.from([0x80 | op, 0x80 | p.length]); else { h = Buffer.alloc(4); h[0] = 0x80 | op; h[1] = 0x80 | 126; h.writeUInt16BE(p.length, 2); } this.socket.write(Buffer.concat([h, mask, b])); }
  parse() {
    for (;;) {
      if (this.buffer.length < 2) return;
      const first = this.buffer[0], shortLength = this.buffer[1] & 0x7f; let offset = 2, length = shortLength;
      if (shortLength === 126) { if (this.buffer.length < 4) return; length = this.buffer.readUInt16BE(2); offset = 4; }
      else if (shortLength === 127) { if (this.buffer.length < 10) return; length = this.buffer.readUInt32BE(6); offset = 10; }
      const masked = (this.buffer[1] & 0x80) !== 0; let mask = null;
      if (masked) { if (this.buffer.length < offset + 4) return; mask = this.buffer.subarray(offset, offset + 4); offset += 4; }
      if (this.buffer.length < offset + length) return;
      let payload = this.buffer.subarray(offset, offset + length); this.buffer = this.buffer.subarray(offset + length);
      if (mask) { const d = Buffer.alloc(payload.length); for (let i = 0; i < payload.length; i++) d[i] = payload[i] ^ mask[i & 3]; payload = d; }
      const opcode = first & 0x0f;
      if (opcode === 0x8) { try { this.socket.destroy(); } catch (e) {} return; }
      if (opcode === 0x9) { this.sendFrame(0xA, payload); continue; }
      if (opcode !== 0x1) continue;
      let message; try { message = JSON.parse(payload.toString('utf8')); } catch (e) { continue; }
      if (message.id && this.pending.has(message.id)) { const p = this.pending.get(message.id); this.pending.delete(message.id); if (message.error) p.reject(new Error(JSON.stringify(message.error))); else p.resolve(message.result || {}); }
      else if (message.method && this.listeners.has(message.method)) for (const l of this.listeners.get(message.method)) l(message.params || {});
    }
  }
  close() { try { this.socket.destroy(); } catch (e) { /* ignore */ } }
}

async function evaluate(cdp, expression) {
  const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error('page exception: ' + JSON.stringify(r.exceptionDetails.exception));
  return r.result && r.result.value;
}
async function waitFor(cdp, expression, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { try { if (await evaluate(cdp, expression)) return true; } catch (e) {} await new Promise(r => setTimeout(r, 120)); }
  return false;
}
function freePort() {
  return new Promise((resolve, reject) => { const server = net.createServer(); server.unref(); server.on('error', reject); server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(e => e ? reject(e) : resolve(port)); }); });
}

async function main() {
  const chrome = chromePath();
  if (!chrome) throw new Error('未找到 Chrome / Edge；可通过 CHROME_PATH 指定浏览器');
  const port = await freePort();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-video-'));
  const browser = spawn(chrome, ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', '--allow-file-access-from-files', '--force-color-profile=srgb', '--window-size=800,600', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=' + port, '--user-data-dir=' + profile, 'about:blank'], { stdio: 'ignore' });
  let failures = 0;
  const check = (name, cond, detail = '') => { if (cond) console.log('  PASS  ' + name); else { failures++; console.error('  FAIL  ' + name + (detail ? '  -> ' + detail : '')); } };
  let cdp;
  try {
    let ready = false;
    for (let i = 0; i < 120; i++) { try { const r = await fetch('http://127.0.0.1:' + port + '/json/version'); if (r.ok) { ready = true; break; } } catch (e) {} await new Promise(r => setTimeout(r, 100)); }
    check('browser.ready', ready);
    if (!ready) throw new Error('Chrome DevTools 未就绪');
    const tabResponse = await fetch('http://127.0.0.1:' + port + '/json/new?' + encodeURIComponent(PAGE_URL), { method: 'PUT' });
    const tab = await tabResponse.json();
    cdp = await Cdp.connect(tab.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable');
    const exceptions = [];
    cdp.on('Runtime.exceptionThrown', p => { const d = p.exceptionDetails || {}; exceptions.push(JSON.stringify(d.exception && d.exception.description || d.text || '')); });

    check('page.videoReady', await waitFor(cdp, "typeof window.IBVideoRuntime === 'object' && typeof window.IBVideoRuntime.createVideoRuntime === 'function' && typeof window.compressImage === 'function'", 20000));

    /* mock 相机：canvas.captureStream() → <video> → captureFrame */
    const r = await evaluate(cdp, "(async function(){"
      + "var canvas=document.createElement('canvas');canvas.width=320;canvas.height=240;"
      + "var cx=canvas.getContext('2d');cx.fillStyle='#0af';cx.fillRect(0,0,320,240);cx.fillStyle='#f00';cx.fillRect(40,40,80,80);"
      + "var stream=canvas.captureStream(15);"
      + "var vid=document.createElement('video');vid.muted=true;vid.playsInline=true;document.body.appendChild(vid);"
      + "var rt=window.IBVideoRuntime.createVideoRuntime({videoHost:vid,targetWidth:320});"
      + "vid.srcObject=stream;await vid.play().catch(function(){});"
      + "for(var i=0;i<40;i++){if(vid.videoWidth>0)break;await new Promise(function(r){setTimeout(r,50)});}"
      + "var dimOk=vid.videoWidth>0&&vid.videoHeight>0;"
      + "var frame=await rt.captureFrame({targetWidth:320});"
      + "var shape=!!frame&&typeof frame==='object'&&frame.dataUrl&&frame.dataUrl.indexOf('data:image/jpeg')===0&&typeof frame.width==='number'&&typeof frame.height==='number'&&typeof frame.timestamp==='number';"
      + "var lastBefore=rt.getLastFrame()===frame;"
      + "var all=await dbGetAll('chatMessages');var leakChat=all.some(function(m){return String(m.content||'').indexOf('data:image/jpeg')===0;});"
      + "var mem=await dbGetAll('memories');var leakMem=mem.some(function(m){return String((m.content||'')+(m.summary||'')).indexOf('data:image/jpeg')===0;});"
      + "var tracks=stream.getTracks().map(function(t){return t.readyState;});"
      + "rt.free();"
      + "var srcAfter=vid.srcObject;var lastAfter=rt.getLastFrame();var tracksAfter=stream.getTracks().map(function(t){return t.readyState;});"
      + "return {dimOk:dimOk,shape:shape,lastBefore:lastBefore,leakChat:leakChat,leakMem:leakMem,srcAfter:srcAfter,lastAfter:lastAfter,tracksAfter:tracksAfter,frame:!!frame?{w:frame.width,h:frame.height,ts:typeof frame.timestamp}:null};"
      + "})()");
    check('video.captureHasDimensions', r && r.dimOk === true);
    check('video.frameShape{dataUrl,width,height,timestamp}', r && r.shape === true, JSON.stringify(r && r.frame));
    check('video.frameReturnsWidthHeightTs', r && r.frame && typeof r.frame.w === 'number' && typeof r.frame.h === 'number' && r.frame.ts === 'number');
    check('video.getLastFrame同对象', r && r.lastBefore === true);
    check('video.不污染chatMessages', r && r.leakChat === false);
    check('video.不污染memories', r && r.leakMem === false);
    check('video.free摘流', r && r.srcAfter === null, String(r && r.srcAfter));
    check('video.free清内存帧', r && r.lastAfter === null);
    check('video.free后tracks已停', r && r.tracksAfter && r.tracksAfter.length > 0 && r.tracksAfter.every(function(s){return s === 'ended';}), JSON.stringify(r && r.tracksAfter));
    check('video.noExceptions', exceptions.length === 0, exceptions.slice(0, 2).join(' || ').slice(0, 400));
  } finally {
    if (cdp) cdp.close();
    try { browser.kill(); } catch (e) { /* ignore */ }
  }
  console.log(failures === 0 ? '\nVideo Runtime CDP passed ✔' : '\nVideo Runtime CDP FAILED ✘');
  process.exit(failures ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
