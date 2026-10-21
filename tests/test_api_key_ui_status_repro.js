'use strict';
/* API 角色库 UI 冒烟：角色行信息、异常状态、详情入口、更多菜单与窄屏布局。 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

/* Repository root — this file lives in tests/, so the root is one level up. */
const ROOT = path.resolve(__dirname, '..');
const http = require('http');
const net = require('net');
const crypto = require('crypto');
const { pathToFileURL } = require('url');


const PAGE_URL = pathToFileURL(path.join(ROOT, 'InternalBeyond.html')).href;

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

    await evaluate(cdp, "navTo('api');true");
    await evaluate(cdp, "(function(){var host=IB.host;var caps=host.capabilities.bind(host);host.capabilities=function(){return Object.assign({},caps(),{credentialStatus:{available:true}})};host.credentialStatus.available=true;host.credentialStatus.query=function(bindings){return Promise.resolve({ok:true,results:(bindings||[]).map(function(b){return{bindingId:b.bindingId,status:b.bindingId==='ready-vault'?'ready':'missing',secretPresent:b.bindingId==='ready-vault'}})})};return true})()");
    await evaluate(cdp, "(async function(){await dbPut('apiConfigs',{id:'role-ready',provider:'openai',model:'gpt-4o-mini',endpoint:'https://api.example.invalid/v1/chat/completions',credentialRef:'ready-vault',nickname:'月桥',bio:'耐心地陪你整理复杂问题。',created:1});await dbPut('apiConfigs',{id:'role-missing',provider:'deepseek',model:'deepseek-chat',endpoint:'https://api.example.invalid/v1/chat/completions',credentialRef:'missing-vault',nickname:'雾灯',bio:'喜欢把想法慢慢说清楚。',created:2});await dbPut('apiConfigs',{id:'role-broken',provider:'openai',model:'',endpoint:'',credentialRef:'ready-vault',nickname:'未完成角色',created:3});await dbPut('apiConfigs',{id:'role-no-endpoint',provider:'openai',model:'gpt-4o-mini',endpoint:'',credentialRef:'ready-vault',nickname:'缺少接口',created:4});await dbPut('apiConfigs',{id:'role-archived',provider:'openai',model:'gpt-4o-mini',endpoint:'https://api.example.invalid/v1/chat/completions',credentialRef:'',nickname:'归档角色',bio:'旧简介',archived:true,archivedAt:5,created:5});await loadApiConfigs();await renderApiList();return true})()");

    const listState = await evaluate(cdp, "(function(){var list=document.getElementById('api-list-container');var rows=[].slice.call(list.querySelectorAll('.api-role-row'));var ready=list.querySelector('[data-api-id=\"role-ready\"]');var missing=list.querySelector('[data-api-id=\"role-missing\"]');var broken=list.querySelector('[data-api-id=\"role-broken\"]');var noEndpoint=list.querySelector('[data-api-id=\"role-no-endpoint\"]');return{count:rows.length,title:document.getElementById('api-mgmt-title').textContent,readyText:ready&&ready.textContent,missingText:missing&&missing.textContent,brokenText:broken&&broken.textContent,noEndpointText:noEndpoint&&noEndpoint.textContent,readyKeyButtons:ready&&ready.querySelectorAll('.ib-api-key-btn').length,readyExpressionButtons:ready&&ready.querySelectorAll('.ib-expression-manage').length,readyDeleteButtons:ready&&ready.querySelectorAll('.del-btn').length,more:ready&&ready.querySelector('.api-more-menu button')&&ready.querySelector('.api-more-menu button').textContent}})()");
    check('list.showsAvatarNameBioAndModel', listState && listState.count === 4 && listState.readyText.includes('月桥') && listState.readyText.includes('耐心地陪你整理复杂问题') && listState.readyText.includes('gpt-4o-mini'), JSON.stringify(listState));
    check('list.usesActualRoleCount', listState && listState.title.indexOf('4 个角色') >= 0 && listState.title.indexOf('数量不限') < 0, JSON.stringify(listState && listState.title));
    check('list.omitsReadyStateAndRepeatedActions', listState && listState.readyText.indexOf('API 已就绪') < 0 && listState.readyKeyButtons === 0 && listState.readyExpressionButtons === 0 && listState.readyDeleteButtons === 0 && listState.more.indexOf('归档') >= 0, JSON.stringify(listState));
    check('list.showsOnlyAccurateConfigurationIssues', listState && listState.missingText.indexOf('缺少 Credential Vault 凭据') >= 0 && listState.brokenText.indexOf('未配置模型') >= 0 && listState.noEndpointText.indexOf('未配置 Endpoint') >= 0 && listState.readyText.indexOf('Credential Vault') < 0, JSON.stringify(listState));
    await evaluate(cdp, "IBI18n.setLocale('en-US');true");
    check('locale.statusAndCountRefresh', await waitFor(cdp, "IBI18n.locale==='en-US'&&document.getElementById('api-mgmt-title').textContent.indexOf('4 roles')>=0&&document.querySelector('[data-api-id=\"role-missing\"]').textContent.indexOf('Credential Vault credential missing')>=0"));
    await evaluate(cdp, "IBI18n.setLocale('zh-CN');true");
    await waitFor(cdp, "IBI18n.locale==='zh-CN'&&document.getElementById('api-mgmt-title').textContent.indexOf('4 个角色')>=0");
    const desktop = await evaluate(cdp, "(function(){var list=document.getElementById('api-list-container');var row=list.querySelector('.api-role-row');var main=row.querySelector('.api-role-main').getBoundingClientRect();var menu=row.querySelector('.api-more-menu').getBoundingClientRect();return{width:innerWidth,documentWidth:document.documentElement.scrollWidth,listWidth:list.scrollWidth,listClient:list.clientWidth,mainRight:main.right,menuLeft:menu.left,rowRight:row.getBoundingClientRect().right}})()");
    check('layout.desktopRowFits', desktop && desktop.width >= 1280 && desktop.documentWidth <= desktop.width + 1 && desktop.listWidth <= desktop.listClient + 1 && desktop.mainRight < desktop.menuLeft && desktop.rowRight <= desktop.width + 1, JSON.stringify(desktop));
    await evaluate(cdp, "window.__apiTestHadInfernal=document.body.classList.contains('theme-infernal');document.body.classList.add('theme-infernal');true");
    const infernalDesktop = await evaluate(cdp, "(function(){var name=document.querySelector('#api-list-container .api-item-name');return{width:innerWidth,documentWidth:document.documentElement.scrollWidth,rows:document.querySelectorAll('#api-list-container .api-role-row').length,nameColor:name&&getComputedStyle(name).color}})()");
    check('layout.infernalDesktopReadable', infernalDesktop && infernalDesktop.rows === 4 && infernalDesktop.documentWidth <= infernalDesktop.width + 1 && !!infernalDesktop.nameColor, JSON.stringify(infernalDesktop));

    await evaluate(cdp, "document.querySelector('[data-api-id=\"role-ready\"] .api-role-main').click();true");
    const detail = await evaluate(cdp, "(function(){var editor=document.getElementById('api-editor');var key=document.getElementById('api-key-manage-btn');var packs=document.getElementById('api-expression-manage-btn');return{open:editor.style.display!=='none',keyLabel:key&&key.textContent,expressionVisible:packs&&!packs.hidden,expressionRole:packs&&packs.dataset.expressionRoleId}})()");
    check('detail.movesKeyAndExpressionManagement', detail && detail.open && detail.keyLabel === '更换 API Key' && detail.expressionVisible && detail.expressionRole === 'role-ready', JSON.stringify(detail));
    await evaluate(cdp, "document.querySelector('[data-api-id=\"role-missing\"] .api-role-main').click();true");
    check('detail.missingCredentialShowsAddAction', await evaluate(cdp, "document.getElementById('api-key-manage-btn').textContent==='添加 API Key'"));
    await evaluate(cdp, "document.getElementById('api-key-manage-btn').click();true");
    check('detail.addActionOpensExistingVaultModal', await evaluate(cdp, "!document.getElementById('ib-cred-modal-backdrop').hidden&&document.getElementById('ib-cred-modal-title').textContent==='添加 API Key'"));
    await evaluate(cdp, "_ibCloseApiKeyModal();document.querySelector('[data-api-id=\"role-ready\"] .api-role-main').click();true");
    await evaluate(cdp, "document.getElementById('api-key-manage-btn').click();true");
    check('detail.keyActionOpensExistingVaultModal', await evaluate(cdp, "!document.getElementById('ib-cred-modal-backdrop').hidden&&document.getElementById('ib-cred-modal-title').textContent==='更换 API Key'"));
    await evaluate(cdp, "_ibCloseApiKeyModal();document.getElementById('api-expression-manage-btn').click();true");
    check('detail.expressionActionOpensManager', await waitFor(cdp, "!!document.querySelector('.ib-expression-dialog.is-open')"));
    await evaluate(cdp, "var close=document.querySelector('.ib-expression-dialog .ib-expression-close');if(close)close.click();true");

    await evaluate(cdp, "var menu=document.querySelector('[data-api-id=\"role-ready\"] .api-more-menu');menu.querySelector('summary').click();menu.querySelector('button').click();true");
    check('list.moreMenuKeepsDeleteConfirmationChoices', await waitFor(cdp, "document.getElementById('api-del-overlay').classList.contains('show')&&document.getElementById('adl-opt-archive')&&document.getElementById('adl-opt-delete')"));
    await evaluate(cdp, "closeApiDelDialog(false);true");

    await evaluate(cdp, "toggleApiArchiveView();true");
    const archiveState = await evaluate(cdp, "(function(){var row=document.querySelector('.api-arch-item');return{count:document.getElementById('api-mgmt-title').textContent,hasMore:!!(row&&row.querySelector('.api-more-menu')),directDelete:!!(row&&row.querySelector('.del-btn'))}})()");
    check('archive.usesActualCountAndMoreMenu', archiveState && archiveState.count.indexOf('1 个归档角色') >= 0 && archiveState.hasMore && !archiveState.directDelete, JSON.stringify(archiveState));
    await evaluate(cdp, "var menu=document.querySelector('.api-arch-item .api-more-menu');menu.querySelector('summary').click();menu.querySelector('button').click();true");
    check('archive.permanentDeleteStillRequiresInlineConfirm', await waitFor(cdp, "!!document.querySelector('.api-arch-item .api-arch-confirm')&&document.querySelectorAll('.api-arch-item .am-mini').length===2"));
    await evaluate(cdp, "document.querySelector('.api-arch-item .am-mini:not(.am-mini-danger)').click();toggleApiArchiveView();true");

    await cdp.send('Emulation.setDeviceMetricsOverride',{width:375,height:812,deviceScaleFactor:1,mobile:true});
    const narrow = await evaluate(cdp, "(function(){var list=document.getElementById('api-list-container');var row=list.querySelector('.api-role-row');var main=row&&row.querySelector('.api-role-main');var menu=row&&row.querySelector('.api-more-menu');return{width:innerWidth,documentWidth:document.documentElement.scrollWidth,listWidth:list.scrollWidth,listClient:list.clientWidth,row:row&&row.getBoundingClientRect().right,main:main&&main.getBoundingClientRect().right,menu:menu&&menu.getBoundingClientRect().right}})()");
    check('layout.narrowViewportFits', narrow && narrow.width === 375 && narrow.documentWidth <= 376 && narrow.listWidth <= narrow.listClient + 1 && narrow.row <= 376 && narrow.main < narrow.menu, JSON.stringify(narrow));
    await evaluate(cdp, "document.body.classList.remove('theme-infernal');true");
    const narrowInternal = await evaluate(cdp, "(function(){var list=document.getElementById('api-list-container');var row=list.querySelector('.api-role-row');var menu=row&&row.querySelector('.api-more-menu');return{width:innerWidth,documentWidth:document.documentElement.scrollWidth,listWidth:list.scrollWidth,listClient:list.clientWidth,menuRight:menu&&menu.getBoundingClientRect().right}})()");
    check('layout.internalNarrowViewportFits', narrowInternal && narrowInternal.width === 375 && narrowInternal.documentWidth <= 376 && narrowInternal.listWidth <= narrowInternal.listClient + 1 && narrowInternal.menuRight <= 376, JSON.stringify(narrowInternal));
    if(await evaluate(cdp,"window.__apiTestHadInfernal"))await evaluate(cdp,"document.body.classList.add('theme-infernal');true");

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
