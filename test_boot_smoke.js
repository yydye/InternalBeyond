'use strict';

/*
 * P2 · minimal browser smoke (headless Chrome / Edge, CDP).
 *
 * Deliberately small — P2 changes no frontend feature code. It proves the three
 * things P2 must not break:
 *   1. the real static server serves the real main UI over http://127.0.0.1
 *   2. the page still opens and renders when the launch is DEGRADED
 *      (no startup block, no uncaught page exception)
 *   3. the page can consume the boot-state contract same-origin (P5 interface)
 *
 * Run: node test_boot_smoke.js
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');
const crypto = require('crypto');

const WEB = require('./services/internal-beyond-server.js');
const BOOT = require('./runtime/boot-state.js');
const ROOT = __dirname;

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
function freePort() {
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.unref();
    s.on('error', rej);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(e => e ? rej(e) : res(p)); });
  });
}

/* Small HTTP JSON helper (no global fetch: undici keep-alive sockets would keep
   the event loop alive after the suite finishes). */
function httpJson(url, method) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method: method || 'GET', headers: { Connection: 'close' } }, res => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', c => { raw += c; });
      res.on('end', () => { let json = null; try { json = JSON.parse(raw); } catch (e) { } resolve({ ok: res.statusCode < 400, status: res.statusCode, json: json }); });
    });
    req.on('error', reject);
    req.setTimeout(3000, () => { req.destroy(); reject(new Error('timeout ' + url)); });
    req.end();
  });
}

/* Minimal CDP client (same protocol subset as test_basement_cdp.js). */
class Cdp {
  constructor(s) { this.s = s; this.b = Buffer.alloc(0); this.id = 0; this.p = new Map(); this.l = new Map(); s.on('data', c => { this.b = Buffer.concat([this.b, c]); this.parse(); }); s.on('error', () => { }); }
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
      /* The reply timer must be cleared, otherwise every send leaves a live
         handle behind and the process cannot exit on its own. */
      const timer = setTimeout(() => { if (this.p.has(id)) { this.p.delete(id); rej(new Error('timeout ' + m)); } }, 20000);
      this.p.set(id, {
        res: v => { clearTimeout(timer); res(v); },
        rej: e => { clearTimeout(timer); rej(e); }
      });
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
      if (op === 0x9) continue;
      if (op !== 0x1) continue;
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
    await new Promise(r => setTimeout(r, 120));
  }
  return false;
}

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}

(async () => {
  const watchdog = setTimeout(() => {
    console.error('\nWATCHDOG: browser smoke exceeded 90s — unreleased resources: ' +
      (process.getActiveResourcesInfo ? process.getActiveResourcesInfo().join(',') : 'n/a'));
    process.exit(1);
  }, 90000);
  watchdog.unref();

  console.log('P2 · minimal browser smoke\n');

  const chrome = chromePath();
  if (!chrome) {
    console.log('  ⊘ skipped: no Chrome / Edge found');
    clearTimeout(watchdog);
    process.exitCode = 0;
    return;
  }

  /* Degraded launch record, served by a real static server from a temp state dir. */
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-p2-smoke-'));
  const webSrv = WEB.createWebServer({ port: 0, root: ROOT });
  const webPort = await new Promise((res, rej) => { webSrv.once('error', rej); webSrv.listen(0, '127.0.0.1', () => res(webSrv.address().port)); });
  const savedDir = process.env.IB_BOOT_STATE_DIR;
  process.env.IB_BOOT_STATE_DIR = stateDir;
  BOOT.writeBootState(BOOT.buildBootState({
    phase: 'complete',
    components: {
      static: { required: true, healthy: true, state: 'healthy', port: webPort, host: '127.0.0.1', url: 'http://127.0.0.1:' + webPort + '/InternalBeyond.html', identity: 'InternalBeyond Web' },
      bridge: { healthy: false, state: 'offline', reason: { category: 'offline', message: 'smoke: bridge down' } },
      active: { healthy: false, state: 'offline', reason: { category: 'offline', message: 'smoke: active down' } }
    }
  }), { dir: stateDir });

  const cdpPort = await freePort();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-p2-chrome-'));
  const browser = spawn(chrome, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    '--force-color-profile=srgb', '--window-size=1200,800',
    '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=' + cdpPort,
    '--user-data-dir=' + profile, 'about:blank'
  ], { stdio: 'ignore' });

  let cdp = null;
  const pageErrors = [];
  try {
    let ready = false;
    for (let i = 0; i < 150; i++) {
      try { const r = await httpJson('http://127.0.0.1:' + cdpPort + '/json/version'); if (r.ok) { ready = true; break; } } catch (e) { }
      await new Promise(r => setTimeout(r, 100));
    }
    check('browser ready', ready);
    if (!ready) throw new Error('Chrome DevTools did not become ready');

    const url = 'http://127.0.0.1:' + webPort + '/InternalBeyond.html';
    const tab = (await httpJson('http://127.0.0.1:' + cdpPort + '/json/new?' + encodeURIComponent(url), 'PUT')).json;
    cdp = await Cdp.connect(tab.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable');
    await cdp.send('Log.enable');
    cdp.on('Runtime.exceptionThrown', p => pageErrors.push(String(p.exceptionDetails && p.exceptionDetails.text || 'exception')));

    check('1) static server serves the real main UI', await wait(cdp, "document.readyState==='complete' && !!document.getElementById('app')", 25000));
    check('   app shell rendered (#app + #page-chat)', await ev(cdp, "!!document.getElementById('app') && !!document.getElementById('page-chat')"));
    check('   front-end modules loaded (IBNET / PROVIDERS)', await ev(cdp, "typeof window.IBNET==='object' && typeof window.PROVIDERS==='object'"));
    check('   all page scripts executed', await ev(cdp, "document.querySelectorAll('script').length > 40"), 'script count=' + await ev(cdp, "document.querySelectorAll('script').length"));

    /* 2) degraded must not block the page */
    check('2) degraded page is usable (no startup block)', await ev(cdp, "document.body.innerText.trim().length > 100 && !/启动失败|无法启动/.test(document.body.innerText.slice(0,4000))"));

    /* 3) the page can consume the contract same-origin (P5 interface) */
    const contract = await ev(cdp, "(async()=>{const r=await fetch('/__boot-state');const j=await r.json();return {status:r.status, present:j.present, stale:j.stale, overall:j.bootState&&j.bootState.overall, bridge:j.bootState&&j.bootState.components&&j.bootState.components.bridge.state};})()");
    check('3) page can read /__boot-state same-origin', contract && contract.status === 200 && contract.present === true, JSON.stringify(contract));
    check('   page sees overall=degraded', contract && contract.overall === 'degraded', JSON.stringify(contract));
    check('   page sees Bridge unavailable', contract && contract.bridge === 'offline', JSON.stringify(contract));
    check('   record is fresh, not stale', contract && contract.stale === false, JSON.stringify(contract));

    /* no uncaught page exception during boot */
    await new Promise(r => setTimeout(r, 800));
    check('no uncaught page exception', pageErrors.length === 0, pageErrors.join(' | '));
  } finally {
    if (cdp) cdp.close();
    try { browser.kill(); } catch (e) { }
    /* Wait for Chrome to release its user-data-dir before removing it. */
    await new Promise(r => {
      if (!browser || browser.exitCode !== null || browser.signalCode) return r();
      const fallback = setTimeout(r, 5000);
      browser.once('exit', () => { clearTimeout(fallback); r(); });
    });
    await new Promise(r => { const fallback = setTimeout(r, 2000); webSrv.close(() => { clearTimeout(fallback); r(); }); });
    if (savedDir === undefined) delete process.env.IB_BOOT_STATE_DIR; else process.env.IB_BOOT_STATE_DIR = savedDir;
    for (const dir of [stateDir, profile]) {
      try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); }
      catch (e) { console.log('  (note) temp dir left behind (not a failure): ' + dir); }
    }
  }

  console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
  process.exitCode = fail ? 1 : 0;
  setTimeout(() => {
    console.error('\nLEAK: event loop still alive 5s after the smoke finished — unreleased resources: ' +
      (process.getActiveResourcesInfo ? process.getActiveResourcesInfo().join(',') : 'n/a'));
    process.exit(2);
  }, 5000).unref();
})().catch(e => {
  console.error('UNEXPECTED FAILURE: ' + (e && e.stack || e));
  process.exitCode = 1;
});
