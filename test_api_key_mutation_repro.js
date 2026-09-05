'use strict';
/* API Key 浏览器生命周期复现 —— 通过真实 UI 处理器驱动，逐步检查存储中的 apiKey。
   每个步骤后都从 IndexedDB 读回该角色的 apiKey，报告是否等于哨兵 key。
   绝不打印哨兵内容，只比较是否相等。 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');
const crypto = require('crypto');
const { pathToFileURL } = require('url');

const PAGE_URL = pathToFileURL(path.join(__dirname, 'InternalBeyond.html')).href;
const TEST_KEY = 'TEST_KEY_DO_NOT_USE_12345'; /* 合成哨兵：只比较相等性，不打印 */

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
  constructor(s) { this.socket = s; this.buffer = Buffer.alloc(0); this.id = 0; this.pending = new Map(); this.listeners = new Map(); s.on('data', c => { this.buffer = Buffer.concat([this.buffer, c]); this.parse(); }); s.on('error', () => {}); }
  static connect(wsUrl) { return new Promise((res, rej) => { const u = new URL(wsUrl); const r = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, headers: { Upgrade: 'websocket', Connection: 'Upgrade', 'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'), 'Sec-WebSocket-Version': '13' } }); r.on('upgrade', (response, socket) => res(new Cdp(socket))); r.on('error', rej); r.end(); }); }
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
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-apik-mut-'));
  const browser = spawn(chrome, ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', '--allow-file-access-from-files', '--force-color-profile=srgb', '--window-size=1440,900', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=' + port, '--user-data-dir=' + profile, 'about:blank'], { stdio: 'ignore' });

  let failures = 0;
  const check = (name, condition, detail = '') => { if (condition) console.log('  PASS  ' + name); else { failures++; console.error('  FAIL  ' + name + (detail ? '  -> ' + detail : '')); } };
  /* 从 IndexedDB 读回某角色 apiKey，只返回布尔（是否等于哨兵），不返回内容 */
  const keyTruth = (id) => "(async function(){ try{ var c=await dbGet('apiConfigs','" + id + "'); return { found: !!c, eq: !!(c && c.apiKey === '" + TEST_KEY + "') }; }catch(e){ return { found:false, eq:false }; } })()";

  let cdp;
  try {
    let ready = false;
    for (let i = 0; i < 120; i++) { try { const r = await fetch('http://127.0.0.1:' + port + '/json/version'); if (r.ok) { ready = true; break; } } catch (e) {} await new Promise(r => setTimeout(r, 100)); }
    if (!ready) throw new Error('Chrome DevTools 未就绪');
    const tabResponse = await fetch('http://127.0.0.1:' + port + '/json/new?' + encodeURIComponent(PAGE_URL), { method: 'PUT' });
    const tab = await tabResponse.json();
    cdp = await Cdp.connect(tab.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    await waitFor(cdp, "typeof window.IB === 'object' && typeof window.editApi === 'function' && typeof window.saveCurrentApi === 'function' && typeof window.onProviderChange === 'function'", 25000);
    await evaluate(cdp, "window.confirm = function(){ return true; };");

    /* 通过真实 UI：addNewApi → 填 key → saveCurrentApi 创建角色 A */
    const idA = 'mut_A_' + Date.now();
    await evaluate(cdp, "(function(){ addNewApi(); document.getElementById('api-ai-name').value='角色A'; document.getElementById('api-provider').value='openai'; onProviderChange(); document.getElementById('api-model').value='gpt-test'; document.getElementById('api-endpoint').value='https://a.example.com/v1/chat/completions'; document.getElementById('api-key').value='" + TEST_KEY + "'; return true; })()");
    await evaluate(cdp, "(async function(){ window.__editorId=null; /* 需要 editingApiId */ document.getElementById('api-ai-name').value='角色A'; return true; })()");
    /* addNewApi 已设 editingApiId；直接保存 */
    await evaluate(cdp, "window.__saveResult=null; saveCurrentApi(null).then(function(r){ window.__saveResult='ok'; }).catch(function(e){ window.__saveResult='err:'+String(e&&e.message||e); });");
    await waitFor(cdp, "window.__saveResult !== null", 15000);
    const createdA = await evaluate(cdp, "(function(){ try{ var arr=window.apiConfigs||[]; var c=arr.find(function(x){return x.nickname==='角色A'}); return c ? { id:c.id, saverr:window.__saveResult } : { id:null, saverr:window.__saveResult }; }catch(e){ return { id:null, saverr:window.__saveResult, err:String(e&&e.message||e) }; } })()");
    const idAUsed = createdA && createdA.id || idA;
    check('M0.createRoleA', createdA && !!createdA.id && createdA.saverr === 'ok', JSON.stringify(createdA));
    const t0 = await evaluate(cdp, keyTruth(idAUsed));
    check('M0.createRoleA.keyPresent', t0 && t0.found && t0.eq, JSON.stringify(t0));

    /* 步骤1：reload */
    await cdp.send('Page.reload', { ignoreCache: true });
    await waitFor(cdp, "typeof window.apiConfigs !== 'undefined' && typeof window.editApi === 'function'", 25000);
    await evaluate(cdp, "loadApiConfigs()");
    check('M1.reload.keyIntact', (await evaluate(cdp, keyTruth(idAUsed))).eq, JSON.stringify(await evaluate(cdp, keyTruth(idAUsed))));

    /* 步骤2：edit role → 不改 key → save */
    await evaluate(cdp, "(function(){ editApi('" + idAUsed + "'); return document.getElementById('api-key').value.length; })()");
    const fieldLen = 0;
    check('M2.editorPrefillsKey', await evaluate(cdp, "(document.getElementById('api-key').value === '" + TEST_KEY + "')"));
    await evaluate(cdp, "window.__saveResult=null; saveCurrentApi(null).then(function(){window.__saveResult='ok';}).catch(function(e){window.__saveResult='err:'+String(e&&e.message||e);});");
    await waitFor(cdp, "window.__saveResult !== null", 15000);
    check('M2.editSave.keyIntact', (await evaluate(cdp, keyTruth(idAUsed))).eq, JSON.stringify(await evaluate(cdp, keyTruth(idAUsed))));

    /* 步骤3：change model → save */
    await evaluate(cdp, "document.getElementById('api-model').value='gpt-changed'; window.__saveResult=null; saveCurrentApi(null).then(function(){window.__saveResult='ok';}).catch(function(e){window.__saveResult='err:'+String(e&&e.message||e);});");
    await waitFor(cdp, "window.__saveResult !== null", 15000);
    check('M3.changeModelSave.keyIntact', (await evaluate(cdp, keyTruth(idAUsed))).eq, JSON.stringify(await evaluate(cdp, keyTruth(idAUsed))));

    /* 步骤4：change provider（走真实 onProviderChange）→ save */
    await evaluate(cdp, "document.getElementById('api-provider').value='anthropic'; onProviderChange(); window.__saveResult=null; saveCurrentApi(null).then(function(){window.__saveResult='ok';}).catch(function(e){window.__saveResult='err:'+String(e&&e.message||e);});");
    await waitFor(cdp, "window.__saveResult !== null", 15000);
    check('M4.changeProviderSave.keyIntact', (await evaluate(cdp, keyTruth(idAUsed))).eq, JSON.stringify(await evaluate(cdp, keyTruth(idAUsed))));

    /* 步骤5：change endpoint → save */
    await evaluate(cdp, "document.getElementById('api-endpoint').value='https://a.example.com/v2/chat/completions'; window.__saveResult=null; saveCurrentApi(null).then(function(){window.__saveResult='ok';}).catch(function(e){window.__saveResult='err:'+String(e&&e.message||e);});");
    await waitFor(cdp, "window.__saveResult !== null", 15000);
    check('M5.changeEndpointSave.keyIntact', (await evaluate(cdp, keyTruth(idAUsed))).eq, JSON.stringify(await evaluate(cdp, keyTruth(idAUsed))));

    /* 步骤6：navigate Chat → back API */
    await evaluate(cdp, "try{ navTo('chat'); }catch(e){}");
    await new Promise(r => setTimeout(r, 400));
    await evaluate(cdp, "try{ navTo('api'); }catch(e){}");
    await new Promise(r => setTimeout(r, 400));
    check('M6.navigate.keyIntact', (await evaluate(cdp, keyTruth(idAUsed))).eq, JSON.stringify(await evaluate(cdp, keyTruth(idAUsed))));

    /* 步骤7：reload again */
    await cdp.send('Page.reload', { ignoreCache: true });
    await waitFor(cdp, "typeof window.apiConfigs !== 'undefined' && typeof window.editApi === 'function'", 25000);
    await evaluate(cdp, "loadApiConfigs()");
    check('M7.reloadAgain.keyIntact', (await evaluate(cdp, keyTruth(idAUsed))).eq, JSON.stringify(await evaluate(cdp, keyTruth(idAUsed))));

    /* 步骤8：创建角色 B（不同 key），不碰 A → 验证 B 保存不清 A */
    await evaluate(cdp, "(function(){ addNewApi(); document.getElementById('api-ai-name').value='角色B'; document.getElementById('api-provider').value='gemini'; onProviderChange(); document.getElementById('api-key').value='SECOND_KEY_BBBB'; return true; })()");
    await evaluate(cdp, "window.__saveResult=null; saveCurrentApi(null).then(function(){window.__saveResult='ok';}).catch(function(e){window.__saveResult='err:'+String(e&&e.message||e);});");
    await waitFor(cdp, "window.__saveResult !== null", 15000);
    check('M8.createRoleB.keyAIntact', (await evaluate(cdp, keyTruth(idAUsed))).eq, JSON.stringify(await evaluate(cdp, keyTruth(idAUsed))));
    const supB = await evaluate(cdp, "(async function(){ var b=(window.apiConfigs||[]).find(function(x){return x.nickname==='角色B'}); if(!b)return {found:false}; return { found:true, id:b.id, eq: b.apiKey==='SECOND_KEY_BBBB' }; })()");
    check('M8.roleB.independent', supB && supB.found && supB.eq, JSON.stringify(supB));

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
