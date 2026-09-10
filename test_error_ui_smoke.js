'use strict';

/*
 * P3 · minimal browser smoke (headless Chrome / Edge, CDP).
 *
 * Deliberately small: P3 only adds the error card + wires existing error paths.
 * It proves, in a real browser on the real UI:
 *   1. the card renders title / message / suggestion for a real provider error
 *   2. the ordinary prompt leaks no status code / endpoint / port / secret
 *   3. 「查看详情」reveals developer info (HTTP status / endpoint / request id /
 *      masked raw message) and never the API key
 *   4. local-service (Bridge) errors are能力层面文案, and the ws:// URL only
 *      appears inside 查看详情
 *   5. 「重试」only fires the caller-provided retry callback
 *   6. 「打开设置」navigates to the API settings page
 *   7. no uncaught page exception
 *
 * Run: node test_error_ui_smoke.js
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');
const crypto = require('crypto');

const WEB = require('./services/internal-beyond-server.js');
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

/* Minimal CDP client (same protocol subset as test_boot_smoke.js). */
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
  else { fail++; console.log('  ✗ ' + name + (detail !== undefined ? ' — ' + JSON.stringify(detail) : '')); }
}
/* 普通提示里绝不允许出现的技术信息 */
const USER_LEAKS = ['127.0.0.1', 'ws://', 'http://', 'https://', 'ECONNREFUSED', 'fetch failed', 'stack', 'sk-', 'Bearer', '23115', '401', 'API key'];

(async () => {
  const watchdog = setTimeout(() => {
    console.error('\nWATCHDOG: browser smoke exceeded 90s — unreleased resources: ' +
      (process.getActiveResourcesInfo ? process.getActiveResourcesInfo().join(',') : 'n/a'));
    process.exit(1);
  }, 90000);
  watchdog.unref();

  console.log('P3 · minimal browser smoke（错误卡片 UI）\n');

  const chrome = chromePath();
  if (!chrome) {
    console.log('  ⊘ skipped: no Chrome / Edge found');
    clearTimeout(watchdog);
    process.exitCode = 0;
    return;
  }

  const SECRET = 'sk-live-ABCDEFGHIJKLMNOPQRSTUVWX';
  const webSrv = WEB.createWebServer({ port: 0, root: ROOT });
  const webPort = await new Promise((res, rej) => { webSrv.once('error', rej); webSrv.listen(0, '127.0.0.1', () => res(webSrv.address().port)); });

  const cdpPort = await freePort();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-p3-chrome-'));
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
    cdp.on('Runtime.exceptionThrown', p => pageErrors.push(String(p.exceptionDetails && p.exceptionDetails.text || 'exception')));

    check('1) 真实主 UI 打开 + IBERR 就绪', await wait(cdp, "document.readyState==='complete' && !!window.IBERR && typeof window.IBERR.show==='function'", 25000));

    /* ── A. 401 密钥无效：普通提示干净 ── */
    const A = await ev(cdp, `(()=>{
      window.IBERR.hideAll();
      const err=new Error('401: {"error":{"message":"Invalid API key ${SECRET}","request_id":"req_abc123456789"}}');
      const model=window.IBERR.present(err,{cfg:{provider:'openai',model:'gpt-4o',id:'c1',endpoint:'https://api.openai.com/v1/chat/completions',apiKey:'${SECRET}'},stage:'chat'});
      window.__p3=model;
      window.IBERR.show(model);
      const card=document.querySelector('#ib-err-stack .ib-err-card');
      if(!card)return {card:false};
      const det=card.querySelector('.ib-err-details');
      return {
        card:true, code:card.dataset.errCode,
        title:card.querySelector('.ib-err-title').textContent,
        message:card.querySelector('.ib-err-message').textContent,
        suggestion:card.querySelector('.ib-err-suggestion').textContent,
        detailsVisible:det.style.display!=='none',
        buttons:Array.prototype.map.call(card.querySelectorAll('.ib-err-btn'),b=>b.textContent)
      };
    })()`);
    check('2) 401 卡片已渲染', A && A.card === true && A.code === 'IBERR.AUTH.401', A);
    check('   普通提示含 title/message/suggestion', !!(A && A.title && A.message && A.suggestion), A);
    const aText = A ? (A.title + ' ' + A.message + ' ' + A.suggestion) : '';
    check('   普通提示不含状态码/地址/密钥', USER_LEAKS.every(x => aText.indexOf(x) === -1), aText);
    check('   技术详情默认收起', A && A.detailsVisible === false);
    check('   无「重试」按钮（auth 不可重试）', A && A.buttons.indexOf('重试') === -1, A && A.buttons);

    /* ── B. 查看详情：够用 + 脱敏 ── */
    const B = await ev(cdp, `(()=>{
      const card=document.querySelector('#ib-err-stack .ib-err-card');
      const toggle=card.querySelector('.ib-err-toggle');
      toggle.click();
      const det=card.querySelector('.ib-err-details');
      return {visible:det.style.display!=='none', text:det.textContent, label:toggle.textContent};
    })()`);
    check('3) 点击「查看详情」展开', B && B.visible === true && B.label === '收起详情', B && B.label);
    const bText = B ? B.text : '';
    check('   详情含 HTTP 状态 / 接口地址 / 模型', /HTTP 状态：401/.test(bText) && /接口地址：https:\/\/api\.openai\.com\/v1\/chat\/completions/.test(bText) && /模型：gpt-4o/.test(bText), bText.slice(0, 240));
    check('   详情含请求 ID / 原始信息 / 调用栈', /请求 ID：req_abc123456789/.test(bText) && /原始信息：/.test(bText) && /调用栈：/.test(bText));
    check('   详情不含 API Key', bText.indexOf(SECRET) === -1 && bText.indexOf('apiKey') === -1, bText.slice(0, 240));

    /* ── C. Bridge 不可用：能力文案 + URL 只在详情里 ── */
    const C = await ev(cdp, `(()=>{
      window.IBERR.hideAll();
      const err=new Error('WebSocket connection to ws://127.0.0.1:23115 failed');
      err.ibSource='local_service'; err.ibComponent='bridge';
      const model=window.IBERR.present(err,{source:'local_service',component:'bridge',stage:'bridge'});
      window.IBERR.show(model);
      const card=document.querySelector('#ib-err-stack .ib-err-card');
      card.querySelector('.ib-err-toggle').click();
      return {
        code:card.dataset.errCode,
        user:card.querySelector('.ib-err-title').textContent+' '+card.querySelector('.ib-err-message').textContent+' '+card.querySelector('.ib-err-suggestion').textContent,
        details:card.querySelector('.ib-err-details').textContent
      };
    })()`);
    check('4) Bridge 卡片 = 能力层面文案', C && C.code === 'IBERR.LOCAL_SERVICE.BRIDGE' && /部分本地功能暂时不可用/.test(C.user) && /仍然可以继续聊天/.test(C.user), C && C.user);
    check('   普通提示不含 ws:// 与端口', C && USER_LEAKS.every(x => C.user.indexOf(x) === -1), C && C.user);
    check('   详情保留原始连接信息（开发者可用）', C && /ws:\/\/127\.0\.0\.1:23115/.test(C.details), C && C.details.slice(0, 200));

    /* ── D. 重试按钮只触发调用方回调 ── */
    const D = await ev(cdp, `(()=>{
      window.IBERR.hideAll();
      window.__retried=0;
      window.IBERR.show(window.IBERR.model('local_service',{component:'active'}),{onRetry:function(){window.__retried++;}});
      const card=document.querySelector('#ib-err-stack .ib-err-card');
      const btn=card.querySelector('.ib-err-retry');
      if(!btn)return {found:false};
      btn.click();
      return {found:true,retried:window.__retried,cardGone:!document.querySelector('#ib-err-stack .ib-err-card')};
    })()`);
    check('5) 重试按钮触发回调并关闭卡片', D && D.found === true && D.retried === 1 && D.cardGone === true, D);

    /* ── E. 「打开设置」跳转 API 页 ── */
    const E = await ev(cdp, `(()=>{
      window.IBERR.hideAll();
      window.IBERR.show(window.IBERR.model('auth',{reason:'missing-key'}));
      const card=document.querySelector('#ib-err-stack .ib-err-card');
      const btn=card.querySelector('.ib-err-action');
      const label=btn?btn.textContent:'';
      if(btn)btn.click();
      return {label:label,page:(typeof currentPage!=='undefined'?currentPage:'')};
    })()`);
    check('6) 「打开设置」跳转到 API 设置页', E && E.label === '打开设置' && E.page === 'api', E);

    /* ── F. TTS 文案 ── */
    const F = await ev(cdp, `(()=>{
      window.IBERR.hideAll();
      window.IBERR.show(window.IBERR.model('tts',{}));
      const card=document.querySelector('#ib-err-stack .ib-err-card');
      return {code:card.dataset.errCode,user:card.querySelector('.ib-err-title').textContent+' '+card.querySelector('.ib-err-message').textContent+' '+card.querySelector('.ib-err-suggestion').textContent};
    })()`);
    check('7) TTS 文案 = 语音失败不影响文字', F && F.code === 'IBERR.TTS.FAILED' && /语音生成失败/.test(F.user) && /文字聊天不受影响/.test(F.user), F && F.user);
    check('   TTS 普通提示无技术信息', F && USER_LEAKS.every(x => F.user.indexOf(x) === -1), F && F.user);

    /* ── G. 同一错误去重 + 清理 ── */
    const G = await ev(cdp, `(()=>{
      window.IBERR.hideAll();
      const m=window.IBERR.model('unknown',{stage:'smoke_dedupe'});
      const first=!!window.IBERR.show(m);
      const second=window.IBERR.show(m);   /* 2.5s 内同 code → 不再弹 */
      const count=document.querySelectorAll('#ib-err-stack .ib-err-card').length;
      window.IBERR.hideAll();
      return {first:first,second:second,count:count,after:document.querySelectorAll('#ib-err-stack .ib-err-card').length};
    })()`);
    check('8) 同 code 2.5s 内去重；hideAll 可清理', G && G.first === true && G.second === null && G.count === 1 && G.after === 0, G);

    await new Promise(r => setTimeout(r, 500));
    check('9) 无未捕获页面异常', pageErrors.length === 0, pageErrors.join(' | '));
  } finally {
    if (cdp) cdp.close();
    try { browser.kill(); } catch (e) { }
    await new Promise(r => {
      if (!browser || browser.exitCode !== null || browser.signalCode) return r();
      const fallback = setTimeout(r, 5000);
      browser.once('exit', () => { clearTimeout(fallback); r(); });
    });
    await new Promise(r => { const fallback = setTimeout(r, 2000); webSrv.close(() => { clearTimeout(fallback); r(); }); });
    for (const dir of [profile]) {
      try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); }
      catch (e) { console.log('  (note) temp dir left behind (not a failure): ' + dir); }
    }
  }

  clearTimeout(watchdog);
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
