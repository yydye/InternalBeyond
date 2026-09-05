'use strict';
/* API Key UI 状态审计 —— 区分「真实凭证缺失」与「UI 误报无密钥」。
   用真实 Chrome 同时检查：IndexedDB 记录、内存 apiConfigs、DOM 标签。
   绝不打印真实 key；只输出布尔 presence / length。 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');
const crypto = require('crypto');
const { pathToFileURL } = require('url');

const PAGE_URL = pathToFileURL(path.join(__dirname, 'InternalBeyond.html')).href;
const TEST_KEY = 'TEST_KEY_DO_NOT_USE_12345';

function chromePath() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  for (const c of ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe']) if (fs.existsSync(c)) return c;
  return null;
}
class Cdp {
  constructor(s) { this.socket = s; this.buffer = Buffer.alloc(0); this.id = 0; this.pending = new Map(); this.listeners = new Map(); s.on('data', c => { this.buffer = Buffer.concat([this.buffer, c]); this.parse(); }); s.on('error', () => {}); }
  static connect(u) { return new Promise((res, rej) => { const x = new URL(u); const r = http.request({ host: x.hostname, port: x.port, path: x.pathname + x.search, headers: { Upgrade: 'websocket', Connection: 'Upgrade', 'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'), 'Sec-WebSocket-Version': '13' } }); r.on('upgrade', (response, socket) => res(new Cdp(socket))); r.on('error', rej); r.end(); }); }
  on(m, l) { if (!this.listeners.has(m)) this.listeners.set(m, []); this.listeners.get(m).push(l); }
  send(method, params = {}) { const id = ++this.id; return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.sendText({ id, method, params }); setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('CDP timeout: ' + method)); } }, 20000); }); }
  sendText(msg) { const p = Buffer.from(JSON.stringify(msg), 'utf8'); const m = crypto.randomBytes(4); const b = Buffer.alloc(p.length); for (let i = 0; i < p.length; i++) b[i] = p[i] ^ m[i & 3]; let h; if (p.length < 126) h = Buffer.from([0x81, 0x80 | p.length]); else { h = Buffer.alloc(4); h[0] = 0x81; h[1] = 0x80 | 126; h.writeUInt16BE(p.length, 2); } this.socket.write(Buffer.concat([h, m, b])); }
  sendFrame(op, pl) { const m = crypto.randomBytes(4); const b = Buffer.alloc(pl.length); for (let i = 0; i < pl.length; i++) b[i] = pl[i] ^ m[i & 3]; let h; if (pl.length < 126) h = Buffer.from([0x80 | op, 0x80 | pl.length]); else { h = Buffer.alloc(4); h[0] = 0x80 | op; h[1] = 0x80 | 126; h.writeUInt16BE(pl.length, 2); } this.socket.write(Buffer.concat([h, m, b])); }
  parse() { for (;;) { if (this.buffer.length < 2) return; const f = this.buffer[0]; const sl = this.buffer[1] & 0x7f; let off = 2; let len = sl; if (sl === 126) { if (this.buffer.length < 4) return; len = this.buffer.readUInt16BE(2); off = 4; } else if (sl === 127) { if (this.buffer.length < 10) return; len = this.buffer.readUInt32BE(6); off = 10; } const mk = (this.buffer[1] & 0x80) !== 0; let mask = null; if (mk) { if (this.buffer.length < off + 4) return; mask = this.buffer.subarray(off, off + 4); off += 4; } if (this.buffer.length < off + len) return; let pl = this.buffer.subarray(off, off + len); this.buffer = this.buffer.subarray(off + len); if (mask) { const d = Buffer.alloc(pl.length); for (let i = 0; i < pl.length; i++) d[i] = pl[i] ^ mask[i & 3]; pl = d; } const op = f & 0x0f; if (op === 0x8) return this.close(); if (op === 0x9) { this.sendFrame(0xA, pl); continue; } if (op !== 0x1) continue; let msg; try { msg = JSON.parse(pl.toString('utf8')); } catch (e) { continue; } if (msg.id && this.pending.has(msg.id)) { const pd = this.pending.get(msg.id); this.pending.delete(msg.id); if (msg.error) pd.reject(new Error(JSON.stringify(msg.error))); else pd.resolve(msg.result || {}); } else if (msg.method && this.listeners.has(msg.method)) { for (const l of this.listeners.get(msg.method)) l(msg.params || {}); } } }
  close() { try { this.socket.destroy(); } catch (e) { /* ignore */ } }
}
async function evaluate(cdp, expression) { const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error('page exception: ' + JSON.stringify(r.exceptionDetails)); return r.result && r.result.value; }
async function waitFor(cdp, expression, timeoutMs = 15000) { const end = Date.now() + timeoutMs; while (Date.now() < end) { try { if (await evaluate(cdp, expression)) return true; } catch (e) {} await new Promise(r => setTimeout(r, 120)); } return false; }
function freePort() { return new Promise((resolve, reject) => { const s = net.createServer(); s.unref(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const port = s.address().port; s.close(e => e ? reject(e) : resolve(port)); }); }); }

async function main() {
  const chrome = chromePath();
  if (!chrome) { console.error('unavailable'); process.exit(2); }
  const port = await freePort();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-ui-status-'));
  const browser = spawn(chrome, ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', '--allow-file-access-from-files', '--force-color-profile=srgb', '--window-size=1440,900', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=' + port, '--user-data-dir=' + profile, 'about:blank'], { stdio: 'ignore' });

  let failures = 0;
  const check = (name, condition, detail = '') => { if (condition) console.log('  PASS  ' + name); else { failures++; console.error('  FAIL  ' + name + (detail ? '  -> ' + detail : '')); } };
  /* 全面检查：IndexedDB 记录、内存 apiConfigs、DOM 标签；只输出 presence/length */
  const inspect = (id) => "(function(){ var out={ id:'" + id + "' }; try{ out.idb = (function(){ var r=window.__lastGet; return r ? { found:!!r, hasKey: !!(r&&r.apiKey), keyLen: (r&&r.apiKey)?r.apiKey.length:0 } : null; })(); }catch(e){ out.idbErr=String(e&&e.message||e); } try{ out.mem = (function(){ var c=(window.apiConfigs||[]).find(function(x){return x.id==='"+id+"'}); return c ? { found:true, hasKey:!!c.apiKey, keyLen: c.apiKey?c.apiKey.length:0 } : {found:false}; })(); }catch(e){} try{ out.dom = (function(){ var el=[].slice.call(document.querySelectorAll('.api-item-name')).find(function(e){return e.textContent.indexOf('" + id + "')>-1 || true;}); return null; })(); }catch(e){} return out; })()";

  let cdp;
  try {
    let ready = false;
    for (let i = 0; i < 120; i++) { try { const r = await fetch('http://127.0.0.1:' + port + '/json/version'); if (r.ok) { ready = true; break; } } catch (e) {} await new Promise(r => setTimeout(r, 100)); }
    if (!ready) throw new Error('Chrome DevTools 未就绪');
    const tab = await (await fetch('http://127.0.0.1:' + port + '/json/new?' + encodeURIComponent(PAGE_URL), { method: 'PUT' })).json();
    cdp = await Cdp.connect(tab.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    await waitFor(cdp, "typeof window.IB === 'object' && typeof window.dbPut === 'function' && typeof window.renderApiList === 'function'", 25000);

    /* 场景1：常规保存（_persistApiConfig 写 IndexedDB + fallback）→ 渲染 → 检查 DOM 标签 */
    const idA = 'ui_A_' + Date.now();
    await evaluate(cdp, "(async function(){ var cfg={ id:'" + idA + "', provider:'openai', model:'m-u', endpoint:'https://e.example.com/v1', apiKey:'" + TEST_KEY + "', nickname:'UI状态甲-"+idA+"', systemPrompt:'x', created:Date.now() }; var res=await _persistApiConfig(cfg); window.__lastGet=await dbGet('apiConfigs','" + idA + "'); window.__saveRes=res; return true; })()");
    await evaluate(cdp, "loadApiConfigs(); renderApiList();");
    const domTextA = await evaluate(cdp, "(function(){ var el=[].slice.call(document.querySelectorAll('.api-item-name')).find(function(e){return e.textContent.indexOf('UI状态甲-"+idA+"')>-1;}); return el?el.textContent:''; })()");
    const idbA = await evaluate(cdp, "(function(){ var r=window.__lastGet; return { found:!!r, hasKey:!!(r&&r.apiKey), keyLen:(r&&r.apiKey)?String(r.apiKey).length:0 }; })()");
    const memA = await evaluate(cdp, "(function(){ var c=(window.apiConfigs||[]).find(function(x){return x.id==='"+idA+"'}); return c?{ found:true, hasKey:!!c.apiKey, keyLen:c.apiKey?String(c.apiKey).length:0 }:{found:false}; })()");
    check('S1.persistedHasKey', idbA && idbA.found && idbA.hasKey);
    check('S1.memHasKey', memA && memA.found && memA.hasKey);
    check('S1.domShowsHasKey', domTextA.indexOf('（无密钥）') === -1, JSON.stringify({ dom: domTextA }));
    check('S1.domShowsPositive', domTextA.indexOf('密钥') === -1 && domTextA.indexOf('免密钥') === -1, JSON.stringify({ dom: domTextA }));

    /* 场景2：构造「IndexedDB 有 key，但 localStorage fallback 为无 key 旧拷贝」→ loadApiConfigs 用 fallback 覆盖 */
    const idB = 'ui_B_' + Date.now();
    await evaluate(cdp, "(async function(){ var cfg={ id:'" + idB + "', provider:'deepseek', model:'m-u', endpoint:'https://e.example.com/v1', apiKey:'" + TEST_KEY + "', nickname:'UI状态乙-"+idB+"', systemPrompt:'x', created:Date.now() }; await _persistApiConfig(cfg); window.__lastGetB=await dbGet('apiConfigs','" + idB + "'); return true; })()");
    /* 现在把 localStorage fallback 里该角色覆盖为「无 key」版本（模拟旧/脱敏残留拷贝） */
    await evaluate(cdp, "(function(){ try{ var raw=localStorage.getItem(API_CONFIG_FALLBACK_KEY); var arr=JSON.parse(raw||'[]'); var i=arr.findIndex(function(x){return x.id==='"+idB+"'}); if(i>-1){ arr[i]=Object.assign({},arr[i],{apiKey:''}); localStorage.setItem(API_CONFIG_FALLBACK_KEY,JSON.stringify(arr)); } return true; }catch(e){ return String(e&&e.message||e); } })()");
    await evaluate(cdp, "loadApiConfigs(); renderApiList();");
    const idbB = await evaluate(cdp, "(function(){ var c=window.__lastGetB; return { found:!!c, hasKey:!!(c&&c.apiKey), keyLen:c&&c.apiKey?String(c.apiKey).length:0 }; })()");
    const memB = await evaluate(cdp, "(function(){ var c=(window.apiConfigs||[]).find(function(x){return x.id==='"+idB+"'}); return c?{ found:true, hasKey:!!c.apiKey, keyLen:c.apiKey?String(c.apiKey).length:0 }:{found:false}; })()");
    const domTextB = await evaluate(cdp, "(function(){ var el=[].slice.call(document.querySelectorAll('.api-item-name')).find(function(e){return e.textContent.indexOf('UI状态乙-"+idB+"')>-1;}); return el?el.textContent:''; })()");
    check('S2.persistedKeyIntact', idbB && idbB.found && idbB.hasKey, JSON.stringify(idbB));
    check('S2.memKeepsKeyAfterFix(IndexedDB authoritative)', memB && memB.found && memB.hasKey, JSON.stringify(memB));
    check('S2.domShowsHasKeyAfterFix', domTextB.indexOf('（无密钥）') === -1, JSON.stringify({ dom: domTextB }));

  } catch (e) {
    console.error('  ERROR  ' + (e && e.message || e));
    failures++;
  } finally {
    try { if (cdp) cdp.close(); } catch (e) {}
    try { browser.kill(); } catch (e) {}
  }
  process.exit(failures ? 1 : 0);
}
main();
