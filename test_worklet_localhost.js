'use strict';

/* Verify the Voice Runtime's AudioWorklet loads over localhost.
   The static web server serves InternalBeyond at 127.0.0.1:PORT; this test
   1) loads the app over localhost (no exceptions),
   2) confirms IB.voiceCall is mounted,
   3) creates an AudioContext and calls audioWorklet.addModule('assets/js/voice-worklet.js')
      then constructs an AudioWorkletNode — proving the static worklet module loads and
      registers 'ib-voice-capture' over http:// localhost (unlike the blob/file:// path). */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');
const { spawn } = require('child_process');
const crypto = require('crypto');

const WEB = require('./internal-beyond-server.js');

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
      request.on('upgrade', (response, socket) => resolve(new Cdp(socket)));
      request.on('error', reject);
      request.end();
    });
  }
  on(m, l) { if (!this.listeners.has(m)) this.listeners.set(m, []); this.listeners.get(m).push(l); }
  send(method, params = {}) { const id = ++this.id; return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.sendText({ id, method, params }); setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('CDP timeout: ' + method)); } }, 15000); }); }
  sendText(message) { const payload = Buffer.from(JSON.stringify(message), 'utf8'); const mask = crypto.randomBytes(4); const body = Buffer.alloc(payload.length); for (let i = 0; i < payload.length; i++) body[i] = payload[i] ^ mask[i & 3]; let header; if (payload.length < 126) header = Buffer.from([0x81, 0x80 | payload.length]); else { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 0x80 | 126; header.writeUInt16BE(payload.length, 2); } this.socket.write(Buffer.concat([header, mask, body])); }
  sendFrame(opcode, payload) { const mask = crypto.randomBytes(4); const body = Buffer.alloc(payload.length); for (let i = 0; i < payload.length; i++) body[i] = payload[i] ^ mask[i & 3]; let header; if (payload.length < 126) header = Buffer.from([0x80 | opcode, 0x80 | payload.length]); else { header = Buffer.alloc(4); header[0] = 0x80 | opcode; header[1] = 0x80 | 126; header.writeUInt16BE(payload.length, 2); } this.socket.write(Buffer.concat([header, mask, body])); }
  parse() {
    for (;;) {
      if (this.buffer.length < 2) return;
      const first = this.buffer[0]; const shortLength = this.buffer[1] & 0x7f; let offset = 2; let length = shortLength;
      if (shortLength === 126) { if (this.buffer.length < 4) return; length = this.buffer.readUInt16BE(2); offset = 4; }
      else if (shortLength === 127) { if (this.buffer.length < 10) return; length = this.buffer.readUInt32BE(6); offset = 10; }
      const masked = (this.buffer[1] & 0x80) !== 0; let mask = null;
      if (masked) { if (this.buffer.length < offset + 4) return; mask = this.buffer.subarray(offset, offset + 4); offset += 4; }
      if (this.buffer.length < offset + length) return;
      let payload = this.buffer.subarray(offset, offset + length); this.buffer = this.buffer.subarray(offset + length);
      if (mask) { const decoded = Buffer.alloc(payload.length); for (let i = 0; i < payload.length; i++) decoded[i] = payload[i] ^ mask[i & 3]; payload = decoded; }
      const opcode = first & 0x0f;
      if (opcode === 0x8) return this.close();
      if (opcode === 0x9) { this.sendFrame(0xA, payload); continue; }
      if (opcode !== 0x1) continue;
      let message; try { message = JSON.parse(payload.toString('utf8')); } catch (e) { continue; }
      if (message.id && this.pending.has(message.id)) { const p = this.pending.get(message.id); this.pending.delete(message.id); if (message.error) p.reject(new Error(JSON.stringify(message.error))); else p.resolve(message.result || {}); }
      else if (message.method && this.listeners.has(message.method)) for (const l of this.listeners.get(message.method)) l(message.params || {});
    }
  }
  close() { try { this.socket.destroy(); } catch (e) { } }
}

async function evaluate(cdp, expression) {
  const response = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (response.exceptionDetails) throw new Error('page exception: ' + JSON.stringify(response.exceptionDetails.exception));
  return response.result && response.result.value;
}
async function waitFor(cdp, expression, timeoutMs = 15000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try { if (await evaluate(cdp, expression)) return true; } catch (e) { }
    await new Promise(r => setTimeout(r, 120));
  }
  return false;
}
function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer(); s.unref(); s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(e => e ? reject(e) : resolve(p)); });
  });
}
function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

(async () => {
  const chrome = chromePath();
  if (!chrome) { console.error('未找到 Chrome / Edge；可通过 CHROME_PATH 指定浏览器'); process.exit(1); }

  const web = WEB.createWebServer({ port: 0, root: __dirname });
  const webPort = await listen(web);
  const debPort = await freePort();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-worklet-'));
  const browser = spawn(chrome, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    '--allow-file-access-from-files', '--autoplay-policy=no-user-gesture-required',
    '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=' + debPort,
    '--user-data-dir=' + profile, 'about:blank'
  ], { stdio: 'ignore' });

  let pass = 0, fail = 0;
  const check = (name, ok, detail = '') => { if (ok) { pass++; console.log('  PASS  ' + name); } else { fail++; console.error('  FAIL  ' + name + (detail ? '  -> ' + detail : '')); } };
  let cdp;
  try {
    let ready = false;
    for (let i = 0; i < 120; i++) {
      try { if ((await fetch('http://127.0.0.1:' + debPort + '/json/version')).ok) { ready = true; break; } } catch (e) { }
      await new Promise(r => setTimeout(r, 100));
    }
    check('browser.ready', ready);
    if (!ready) throw new Error('Chrome DevTools 未就绪');

    const tabResponse = await fetch('http://127.0.0.1:' + debPort + '/json/new?' + encodeURIComponent('http://127.0.0.1:' + webPort + '/InternalBeyond.html'), { method: 'PUT' });
    const tab = await tabResponse.json();
    cdp = await Cdp.connect(tab.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable');
    const exceptions = [];
    cdp.on('Runtime.exceptionThrown', params => { const d = params.exceptionDetails || {}; exceptions.push(JSON.stringify(d.exception && d.exception.description || d.text || '')); });

    check('page loads over localhost', await waitFor(cdp, "typeof window.IB === 'object' && typeof window.activeFriendId !== 'undefined'", 20000));
    check('IB.voiceCall mounted', await evaluate(cdp, "window.IB && window.IB.voiceCall && typeof window.IB.voiceCall.start === 'function'"));

    const wl = await evaluate(cdp, "(async function(){ try{ var AC=window.AudioContext||window.webkitAudioContext; var ctx=new AC({latencyHint:'interactive'}); await ctx.audioWorklet.addModule('assets/js/voice-worklet.js'); var node=new AudioWorkletNode(ctx,'ib-voice-capture'); var ok=!!node; try{ctx.close()}catch(e){} return {ok:ok}; }catch(e){ return {ok:false, err:String(e&&e.message||e)}; } })()");
    check('AudioWorklet static module loads + registers over localhost', wl && wl.ok, wl && wl.err);

    await new Promise(r => setTimeout(r, 300));
    check('no runtime exceptions', exceptions.length === 0, exceptions.slice(0, 2).join(' | '));
  } finally {
    try { if (cdp) cdp.close(); } catch (e) { }
    browser.kill();
    await new Promise(r => setTimeout(r, 400));
    await close(web);
  }

  console.log('\n' + (fail === 0 ? 'Worklet-localhost test passed ✔' : 'Worklet-localhost test FAILED (' + fail + ')'));
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });

function close(server) { return new Promise(resolve => server.close(resolve)); }
