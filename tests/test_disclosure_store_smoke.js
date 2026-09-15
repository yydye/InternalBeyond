'use strict';

/* 披露事实写入路径的**真实浏览器**冒烟（Node 18+，零依赖，需 Chrome / Edge）。
   --------------------------------------------------------------------
   为什么必须有这一条（而不是只留 Node 侧的 mock 测试）：
   `tests/test_disclosure_authoring.js` 用一个内存 mock 顶替 IndexedDB，
   因此它证明不了三件**只存在于浏览器**的事：
     · DB_VER 23 → 24 的 `onupgradeneeded` 真的把 `disclosureFacts` 建出来了；
     · 它的 keyPath 真的是 `factId`（`id` 与 `factId` 搞混会让每条事实都写不进去，
       而 mock 的 keyPath 是我们自己写的，测不到这个）；
     · 页面里真实的 `getMemoryContext` 读不到它。
   本文件在真实 Chrome + 真实 file:// 页面上跑真实 IndexedDB 与真实生产函数，
   用完的 profile 是临时目录，不触碰任何真实用户数据。

   覆盖：v24 store 与 keyPath、真实 create/list/update/delete、A/B 分区、
   四条拒绝路径（PUBLIC / 伪造 owner / 改归属 / 跨 owner 删除）、
   memories 零写入、真实 getMemoryContext 看不到它、UI 小节只暴露三档。 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');
const crypto = require('crypto');
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..');
const PAGE_URL = pathToFileURL(path.join(ROOT, 'InternalBeyond.html')).href;

function chromePath() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  return [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
  ].find(fs.existsSync) || null;
}

class Cdp {
  constructor(socket) { this.socket = socket; this.buffer = Buffer.alloc(0); this.id = 0; this.pending = new Map(); this.listeners = new Map(); socket.on('data', c => { this.buffer = Buffer.concat([this.buffer, c]); this.parse(); }); socket.on('error', () => {}); }
  static connect(wsUrl) { return new Promise((resolve, reject) => { const url = new URL(wsUrl); const req = http.request({ host: url.hostname, port: url.port, path: url.pathname + url.search, headers: { Upgrade: 'websocket', Connection: 'Upgrade', 'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'), 'Sec-WebSocket-Version': '13' } }); req.on('upgrade', (res, socket) => resolve(new Cdp(socket))); req.on('error', reject); req.end(); }); }
  on(method, listener) { if (!this.listeners.has(method)) this.listeners.set(method, []); this.listeners.get(method).push(listener); }
  send(method, params = {}) { const id = ++this.id; return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.sendText({ id, method, params }); setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('CDP timeout: ' + method)); } }, 30000); }); }
  sendText(m) { const p = Buffer.from(JSON.stringify(m)); const mask = crypto.randomBytes(4); const body = Buffer.alloc(p.length); for (let i = 0; i < p.length; i++) body[i] = p[i] ^ mask[i & 3]; let h; if (p.length < 126) h = Buffer.from([0x81, 0x80 | p.length]); else { h = Buffer.alloc(4); h[0] = 0x81; h[1] = 0x80 | 126; h.writeUInt16BE(p.length, 2); } this.socket.write(Buffer.concat([h, mask, body])); }
  parse() { while (true) { if (this.buffer.length < 2) return; const op = this.buffer[0] & 0x0f; let len = this.buffer[1] & 0x7f; let off = 2; if (len === 126) { if (this.buffer.length < 4) return; len = this.buffer.readUInt16BE(2); off = 4; } else if (len === 127) { return; } if (this.buffer.length < off + len) return; const payload = this.buffer.slice(off, off + len); this.buffer = this.buffer.slice(off + len); if (op === 1) { try { const msg = JSON.parse(payload.toString('utf8')); if (this.pending.has(msg.id)) { const p = this.pending.get(msg.id); this.pending.delete(msg.id); if (msg.error) p.reject(new Error(msg.error.message)); else p.resolve(msg.result); } if (msg.method && this.listeners.has(msg.method)) for (const l of this.listeners.get(msg.method)) l(msg.params); } catch (e) { /* ignore */ } } } }
  close() { try { this.socket.end(); } catch (e) {} }
}

async function evaluate(cdp, expression) { const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error('page exception: ' + JSON.stringify(r.exceptionDetails.exception)); return r.result && r.result.value; }
async function waitFor(cdp, expression, timeout = 20000) { const end = Date.now() + timeout; while (Date.now() < end) { try { if (await evaluate(cdp, expression)) return true; } catch (e) {} await new Promise(r => setTimeout(r, 120)); } return false; }
function freePort() { return new Promise((resolve, reject) => { const s = net.createServer(); s.unref(); s.on('error', reject); s.listen('0', '127.0.0.1', () => { const p = s.address().port; s.close(e => e ? reject(e) : resolve(p)); }); }); }

const OWNER_A = 'friend_smoke_a';
const OWNER_B = 'friend_smoke_b';
/* 正文用 ASCII 之外的字符：控制字符剥离、截断、prompt 注入这些性质在
   真实 store 里同样要成立，而不只是在纯函数里成立。 */
const SECRET_TEXT = '冒烟秘密：她害怕雷声。';

async function main() {
  const chrome = chromePath();
  if (!chrome) { console.log('SKIP 未找到 Chrome / Edge'); process.exit(0); }
  const port = await freePort();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-dsc-smoke-'));
  const browser = spawn(chrome, ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    '--allow-file-access-from-files', '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=' + port, '--user-data-dir=' + profile, 'about:blank'], { stdio: 'ignore' });

  let failures = 0, cdp;
  const check = (n, ok, d = '') => { if (ok) console.log('  PASS  ' + n); else { failures++; console.error('  FAIL  ' + n + (d ? ' -> ' + d : '')); } };

  try {
    let ready = false;
    for (let i = 0; i < 150; i++) { try { if ((await fetch('http://127.0.0.1:' + port + '/json/version')).ok) { ready = true; break; } } catch (e) {} await new Promise(r => setTimeout(r, 100)); }
    check('browser.ready', ready); if (!ready) throw new Error('CDP 未就绪');

    const tab = await (await fetch('http://127.0.0.1:' + port + '/json/new?' + encodeURIComponent(PAGE_URL), { method: 'PUT' })).json();
    cdp = await Cdp.connect(tab.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable');
    const pageErrors = [];
    cdp.on('Runtime.exceptionThrown', (p) => pageErrors.push((p && p.exceptionDetails && p.exceptionDetails.text) || 'exception'));

    check('page.storeLoaded', await waitFor(cdp, "window.IBDisclosureStore&&typeof IBDisclosureStore.createFact==='function'&&typeof ensureDB==='function'"));
    check('page.coreLoaded', await evaluate(cdp, "window.IBDisclosureCore&&window.IBDisclosureAuthoringCore&&typeof IBDisclosureCore.normalizeDisclosureFact==='function'"));

    /* ── v24 迁移：store 真的被建出来，且 keyPath 是 factId ── */
    check('db.version24', await evaluate(cdp, "(async function(){await ensureDB();return DB_VER===24})()"));
    check('db.storeExists', await evaluate(cdp, "(async function(){var d=await ensureDB();return d.objectStoreNames.contains('disclosureFacts')})()"));
    check('db.keyPathIsFactId', await evaluate(cdp, "(async function(){await ensureDB();return db.transaction('disclosureFacts').objectStore('disclosureFacts').keyPath==='factId'})()"));
    check('db.memoryStoresIntact', await evaluate(cdp, "(async function(){var d=await ensureDB();return ['memories','understandings','threads','roleLetterMemories'].every(function(s){return d.objectStoreNames.contains(s)})})()"));

    /* ── 真实 create / list / A-B 分区 ── */
    const created = await evaluate(cdp, "(async function(){return await IBDisclosureStore.createFact({ownerCharacterId:'" + OWNER_A + "'},{level:'SECRET',text:" + JSON.stringify(SECRET_TEXT) + "})})()");
    check('create.SECRET', !!(created && created.ok) && created.fact.level === 'SECRET' && created.fact.ownerCharacterId === OWNER_A, JSON.stringify(created && created.reason));
    check('create.sourceAndAuthorityFixed', !!(created && created.ok) && created.fact.source === 'character_authoring' && created.fact.authority === 'human_authoring');
    const fid = created && created.fact && created.fact.factId;

    check('rawRowKeyedByFactId', await evaluate(cdp, "(async function(){var r=await dbGet('disclosureFacts'," + JSON.stringify(fid) + ");return !!r&&r.level==='SECRET'})()"));
    check('rawRowHasNoExtraKeys', await evaluate(cdp, "(async function(){var r=await dbGet('disclosureFacts'," + JSON.stringify(fid) + ");return Object.keys(r).length===9&&!('id' in r)&&!('visibility' in r)})()"));

    const listA = await evaluate(cdp, "(async function(){return await IBDisclosureStore.listFacts('" + OWNER_A + "')})()");
    const listB = await evaluate(cdp, "(async function(){return await IBDisclosureStore.listFacts('" + OWNER_B + "')})()");
    check('list.partitioned', !!(listA && listA.ok) && listA.facts.length === 1 && !!(listB && listB.ok) && listB.facts.length === 0,
      JSON.stringify([listA && listA.facts && listA.facts.length, listB && listB.facts && listB.facts.length]));

    /* ── 真实 update（正文 + 等级），且归属不变 ── */
    const upd = await evaluate(cdp, "(async function(){return await IBDisclosureStore.updateFact({ownerCharacterId:'" + OWNER_A + "'}," + JSON.stringify(fid) + ",{text:'改过的正文',level:'PRIVATE'})})()");
    check('update.textAndLevel', !!(upd && upd.ok) && upd.fact.text === '改过的正文' && upd.fact.level === 'PRIVATE' && upd.fact.ownerCharacterId === OWNER_A);
    check('update.persisted', await evaluate(cdp, "(async function(){var r=await dbGet('disclosureFacts'," + JSON.stringify(fid) + ");return r.text==='改过的正文'&&r.level==='PRIVATE'})()"));

    /* ── 四条拒绝路径（真实 store，不是纯函数） ── */
    check('reject.public', await evaluate(cdp, "(async function(){return await IBDisclosureStore.createFact({ownerCharacterId:'" + OWNER_A + "'},{level:'PUBLIC',text:'x'})})()")
      .then(r => !!(r && !r.ok) && r.reason === 'public-not-creatable-by-explicit-writer'));
    check('reject.forgedOwnerInForm', await evaluate(cdp, "(async function(){return await IBDisclosureStore.createFact({ownerCharacterId:'" + OWNER_A + "'},{level:'SECRET',text:'x',ownerCharacterId:'" + OWNER_B + "'})})()")
      .then(r => !!(r && !r.ok) && r.reason === 'caller-supplied-metadata'));
    check('reject.updateOwner', await evaluate(cdp, "(async function(){return await IBDisclosureStore.updateFact({ownerCharacterId:'" + OWNER_A + "'}," + JSON.stringify(fid) + ",{ownerCharacterId:'" + OWNER_B + "'})})()")
      .then(r => !!(r && !r.ok) && r.reason === 'immutable-field'));
    check('reject.crossOwnerDelete', await evaluate(cdp, "(async function(){var r=await IBDisclosureStore.deleteFact({ownerCharacterId:'" + OWNER_B + "'}," + JSON.stringify(fid) + ");var still=await dbGet('disclosureFacts'," + JSON.stringify(fid) + ");return {r:r,still:!!still}})()")
      .then(o => !!(o && o.r && !o.r.ok) && o.r.reason === 'owner-mismatch' && o.still === true));

    /* ── 模型侧看不到它：memories 零写入 + 真实 getMemoryContext ── */
    check('memories.untouched', await evaluate(cdp, "(async function(){var all=await dbGetAll('memories');return {n:all.length,leak:all.filter(function(m){return String(m.content||'').indexOf('雷声')>=0}).length}})()")
      .then(o => !!(o && o.leak === 0)));
    check('memoryContext.blind', await evaluate(cdp, "(async function(){var t=await getMemoryContext('" + OWNER_A + "',{});return String(t||'').indexOf('雷声')<0})()"));
    check('roleDmBlindToStore', await evaluate(cdp, "(function(){return typeof IB.roleDm==='object'&&JSON.stringify(Object.keys(IB.roleDm)).indexOf('disclosure')<0})()"));

    /* ── UI 小节：存在、只暴露三档、没有 owner 输入框 ── */
    check('ui.sectionExists', await evaluate(cdp, "!!document.getElementById('api-dsc-block')"))
    check('ui.threeLevelsOnly', await evaluate(cdp, "(function(){var s=document.getElementById('api-dsc-level');if(!s)return false;var v=[].map.call(s.options,function(o){return o.value});return v.length===3&&v.indexOf('PUBLIC')<0&&v.join(',')==='PERSONAL,PRIVATE,SECRET'})()"));
    check('ui.noOwnerField', await evaluate(cdp, "!document.getElementById('api-dsc-owner')&&!document.getElementById('api-dsc-visibleTo')"));

    /* ── 真实 delete：物理删除 ── */
    const del = await evaluate(cdp, "(async function(){var r=await IBDisclosureStore.deleteFact({ownerCharacterId:'" + OWNER_A + "'}," + JSON.stringify(fid) + ");var after=await dbGet('disclosureFacts'," + JSON.stringify(fid) + ");return {r:r,gone:!after}})()");
    check('delete.physical', !!(del && del.r && del.r.ok) && del.gone === true);

    check('noUncaughtPageException', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
  } finally {
    if (cdp) cdp.close();
    try { browser.kill(); } catch (e) {}
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {}
  }

  console.log('');
  console.log(failures === 0 ? 'Disclosure store smoke passed ✔' : 'Disclosure store smoke failed: ' + failures);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(e => { console.error('HARNESS ERROR', e); process.exit(1); });
