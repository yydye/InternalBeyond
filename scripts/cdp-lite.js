'use strict';

/*
 * P6 · 极简 CDP 客户端（无第三方依赖）
 *
 * 与 test_setup_wizard_smoke.js / test_diagnostics_smoke.js 里那份是同一套最小子集，
 * 抽出来给截图管线与 guide smoke 共用，避免第三、第四份拷贝各自漂移。
 * 只实现本项目用到的：WebSocket 帧编解码、Runtime.evaluate、Page.captureScreenshot 等。
 */

const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');

const sleep = ms => new Promise(r => setTimeout(r, ms));

function chromePath() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  for (const c of [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
  ]) if (fs.existsSync(c)) return c;
  return null;
}

function freePort() {
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.unref();
    s.on('error', rej);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(e => e ? rej(e) : res(p)); });
  });
}

function httpJson(url, method, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request({
      host: u.hostname, port: u.port, path: u.pathname + u.search, method: method || 'GET',
      headers: { Connection: 'close', 'Content-Type': 'application/json' }
    }, res => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', c => { raw += c; });
      res.on('end', () => { let json = null; try { json = JSON.parse(raw); } catch (e) { } resolve({ ok: res.statusCode < 400, status: res.statusCode, json, raw }); });
    });
    req.on('error', reject);
    req.setTimeout(4000, () => { req.destroy(); reject(new Error('timeout ' + url)); });
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

class Cdp {
  constructor(s) {
    this.s = s; this.b = Buffer.alloc(0); this.id = 0; this.p = new Map(); this.l = new Map();
    s.on('data', c => { this.b = Buffer.concat([this.b, c]); this.parse(); });
    s.on('error', () => { });
  }
  static connect(url) {
    return new Promise((res, rej) => {
      const u = new URL(url);
      const r = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, headers: { Upgrade: 'websocket', Connection: 'Upgrade', 'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'), 'Sec-WebSocket-Version': '13' } });
      r.on('upgrade', (r2, s) => res(new Cdp(s)));
      r.on('error', rej);
      r.end();
    });
  }
  on(m, l) { if (!this.l.has(m)) this.l.set(m, []); this.l.get(m).push(l); }
  send(m, p = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      const timer = setTimeout(() => { if (this.p.has(id)) { this.p.delete(id); rej(new Error('timeout ' + m)); } }, 30000);
      this.p.set(id, { res: v => { clearTimeout(timer); res(v); }, rej: e => { clearTimeout(timer); rej(e); } });
      this.t({ id, method: m, params: p });
    });
  }
  t(m) {
    const p = Buffer.from(JSON.stringify(m), 'utf8'), mask = crypto.randomBytes(4), b = Buffer.alloc(p.length);
    for (let i = 0; i < p.length; i++) b[i] = p[i] ^ mask[i & 3];
    let h;
    if (p.length < 126) h = Buffer.from([0x81, 0x80 | p.length]);
    else { h = Buffer.alloc(4); h[0] = 0x81; h[1] = 0x80 | 126; h.writeUInt16BE(p.length, 2); }
    this.s.write(Buffer.concat([h, mask, b]));
  }
  parse() {
    for (;;) {
      if (this.b.length < 2) return;
      const f = this.b[0], sl = this.b[1] & 0x7f;
      let o = 2, len = sl;
      if (sl === 126) { if (this.b.length < 4) return; len = this.b.readUInt16BE(2); o = 4; }
      else if (sl === 127) { if (this.b.length < 10) return; len = this.b.readUInt32BE(6); o = 10; }
      const masked = (this.b[1] & 0x80) !== 0;
      let mask = null;
      if (masked) { if (this.b.length < o + 4) return; mask = this.b.subarray(o, o + 4); o += 4; }
      if (this.b.length < o + len) return;
      let p = this.b.subarray(o, o + len);
      this.b = this.b.subarray(o + len);
      if (mask) { const d = Buffer.alloc(p.length); for (let i = 0; i < p.length; i++) d[i] = p[i] ^ mask[i & 3]; p = d; }
      const op = f & 0xf;
      if (op === 0x8) { try { this.s.destroy(); } catch (e) { } return; }
      if (op === 0x9 || op !== 0x1) continue;
      let msg;
      try { msg = JSON.parse(p.toString('utf8')); } catch (e) { continue; }
      if (msg.id && this.p.has(msg.id)) {
        const q = this.p.get(msg.id); this.p.delete(msg.id);
        if (msg.error) q.rej(new Error(JSON.stringify(msg.error))); else q.res(msg.result || {});
      } else if (msg.method && this.l.has(msg.method)) {
        for (const l of this.l.get(msg.method)) l(msg.params || {});
      }
    }
  }
  close() { try { this.s.destroy(); } catch (e) { } }
}

async function ev(cdp, expr) {
  const r = await cdp.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error('page exception: ' + JSON.stringify(r.exceptionDetails.exception));
  return r.result && r.result.value;
}

async function wait(cdp, expr, ms) {
  const end = Date.now() + (ms || 15000);
  while (Date.now() < end) {
    try { if (await ev(cdp, expr)) return true; } catch (e) { }
    await sleep(150);
  }
  return false;
}

/* 启动一个真实浏览器（全新临时配置目录），返回句柄。 */
async function launchBrowser(opts) {
  const o = opts || {};
  const chrome = chromePath();
  if (!chrome) throw new Error('没有找到 Chrome / Edge，可用 CHROME_PATH 指定');
  const cdpPort = await freePort();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), o.profilePrefix || 'ib-guide-chrome-'));
  const args = [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--disable-background-networking', '--disable-sync', '--mute-audio',
    '--force-color-profile=srgb', '--hide-scrollbars',
    '--window-size=' + (o.width || 1440) + ',' + (o.height || 900),
    '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=' + cdpPort,
    '--user-data-dir=' + profile, 'about:blank'
  ];
  const child = spawn(chrome, args, { stdio: 'ignore' });
  let ready = false;
  for (let i = 0; i < 200; i++) {
    try { const r = await httpJson('http://127.0.0.1:' + cdpPort + '/json/version'); if (r.ok) { ready = true; break; } } catch (e) { }
    await sleep(100);
  }
  if (!ready) {
    try { child.kill(); } catch (e) { }
    throw new Error('浏览器调试端口没有就绪');
  }
  return {
    child, profile, cdpPort,
    async open(url) {
      const tab = (await httpJson('http://127.0.0.1:' + cdpPort + '/json/new?' + encodeURIComponent(url), 'PUT')).json;
      const cdp = await Cdp.connect(tab.webSocketDebuggerUrl);
      await cdp.send('Runtime.enable');
      await cdp.send('Page.enable');
      return cdp;
    },
    async close() {
      try { child.kill(); } catch (e) { }
      await sleep(300);
      if (!o.keepProfile) { try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { } }
    }
  };
}

module.exports = { Cdp, chromePath, ev, freePort, httpJson, launchBrowser, sleep, wait };
