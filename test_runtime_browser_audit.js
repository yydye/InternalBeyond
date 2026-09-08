'use strict';

// Audit integration smoke: real localhost HTML, real Chat/context/provider code,
// isolated browser profile and a mock provider. Reuse the existing CDP harness.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const http = require('node:http'), assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const harness = fs.readFileSync(path.join(__dirname, 'test_chat_smoke.js'), 'utf8');
const boundary = harness.indexOf('async function main() {');
assert.ok(boundary > 0, 'existing CDP harness boundary changed');
const { chromePath, Cdp, evaluate, waitFor, freePort } = new Function('require', '__dirname',
  harness.slice(0, boundary) + '\nreturn {chromePath,Cdp,evaluate,waitFor,freePort};')(require, __dirname);
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const captured = [];
const api = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') { res.end(); return; }
  let raw = ''; for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw || '{}'); captured.push({ url: req.url, body });
  let payload;
  if (req.url.startsWith('/anth')) payload = { content: [{ type: 'text', text: 'AUDIT_ANTH_REPLY' }], stop_reason: 'end_turn', usage: { input_tokens: 20, output_tokens: 4, cache_read_input_tokens: 3, cache_creation_input_tokens: 2 } };
  else if (req.url.startsWith('/gem')) payload = { candidates: [{ content: { parts: [{ text: 'AUDIT_GEM_REPLY' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 4, cachedContentTokenCount: 3 } };
  else payload = { choices: [{ message: { content: 'AUDIT_OAI_REPLY' }, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 4 } };
  res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(payload));
});
(async () => {
  const apiPort = await listen(api), apiBase = 'http://127.0.0.1:' + apiPort;
  const web = require('./internal-beyond-server.js').createWebServer({ root: __dirname, port: 0 });
  const webPort = await listen(web), webBase = 'http://127.0.0.1:' + webPort;
  const debugPort = await freePort(), profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-runtime-browser-audit-'));
  const chrome = chromePath(); assert.ok(chrome, 'Chrome or Edge required');
  const browser = spawn(chrome, ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    '--remote-debugging-port=' + debugPort, '--user-data-dir=' + profile, 'about:blank'], { stdio: 'ignore', windowsHide: true });
  let cdp, failures = 0;
  async function check(name, fn) { try { await fn(); console.log('PASS ' + name); } catch (e) { failures++; console.error('FAIL ' + name + ': ' + e.message); } }
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) { try { ready = (await fetch('http://127.0.0.1:' + debugPort + '/json/version')).ok; } catch (_) {} if (ready) break; await new Promise(r => setTimeout(r, 100)); }
    assert.ok(ready, 'CDP readiness');
    const tab = await (await fetch('http://127.0.0.1:' + debugPort + '/json/new?about:blank', { method: 'PUT' })).json();
    cdp = await Cdp.connect(tab.webSocketDebuggerUrl); await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
    // Prevent the isolated page from reaching user services or real providers.
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `const originalFetch=window.fetch.bind(window);window.fetch=function(input,opts){const u=new URL(typeof input==='string'?input:input.url,location.href);if(u.origin!==${JSON.stringify(apiBase)}&&u.origin!==${JSON.stringify(webBase)})return Promise.reject(new Error('audit blocks external service'));return originalFetch(input,opts);};window.confirm=()=>true;` });
    const pageUrl = process.argv.includes('--file')
      ? require('node:url').pathToFileURL(path.join(__dirname, 'InternalBeyond.html')).href
      : webBase + '/InternalBeyond.html';
    await cdp.send('Page.navigate', { url: pageUrl });
    assert.ok(await waitFor(cdp, "document.readyState==='complete' && window.IB && IB.voiceCall && IB.chat && window.db && typeof loadApiConfigs==='function'", 20000), 'complete runtime mounted');
    const configs = [
      { id: 'audit-anth', provider: 'anthropic', endpoint: apiBase + '/anth', model: 'audit-anth', reply: 'AUDIT_ANTH_REPLY' },
      { id: 'audit-gem', provider: 'gemini', endpoint: apiBase + '/gem/{model}:generateContent', model: 'audit-gem', reply: 'AUDIT_GEM_REPLY' },
      { id: 'audit-oai', provider: 'custom', endpoint: apiBase + '/oai', model: 'audit-oai', reply: 'AUDIT_OAI_REPLY' }
    ].map(c => ({ ...c, nickname: c.id, apiKey: 'audit-only', streaming: false, promptCache: false, systemPrompt: 'AUDIT_IDENTITY_' + c.id }));
    await evaluate(cdp, `(async()=>{for(const c of ${JSON.stringify(configs)})await dbPut('apiConfigs',c);await loadApiConfigs();window.__runtimeAuditCalls=0;const r=IB.runtime.instance.run.bind(IB.runtime.instance);IB.runtime.instance.run=function(...args){window.__runtimeAuditCalls++;return r(...args)};})()`);
    for (const cfg of configs) {
      await check(cfg.provider + ' Chat → request → storage → UI + correct identity', async () => {
        const before = captured.length;
        await evaluate(cdp, `(async()=>{activeFriendId=${JSON.stringify(cfg.id)};activeThreadId=null;openChatPanel();const i=document.getElementById(currentPage==='chat'?'chat-full-input':'chat-input');i.value='AUDIT_MESSAGE';await sendChatMessage();})()`);
        assert.ok(await waitFor(cdp, `(async()=>{const all=await dbGetAll('chatMessages');return all.some(m=>m.friendId===${JSON.stringify(cfg.id)}&&m.role==='assistant'&&m.content.includes(${JSON.stringify(cfg.reply)}));})()`, 15000), 'assistant persisted');
        const req = captured.slice(before).find(r => JSON.stringify(r.body).includes('AUDIT_IDENTITY_' + cfg.id));
        assert.ok(req, 'configured identity in provider request');
        if (cfg.provider === 'gemini') assert.ok(req.body.contents && req.body.system_instruction && req.url.includes(cfg.model));
        else assert.equal(req.body.model, cfg.model);
        assert.ok(await evaluate(cdp, `document.getElementById(currentPage==='chat'?'chat-full-messages':'chat-messages').textContent.includes(${JSON.stringify(cfg.reply)})`), 'reply visible');
      });
    }
    await check('Mixed-provider group preserves each member model and identity', async () => {
      const before = captured.length;
      await evaluate(cdp, `(async()=>{await dbPut('groups',{id:'group_audit',name:'Audit group',members:['audit-anth','audit-gem','audit-oai'],memoryEnabled:false});activeFriendId='group_audit';activeThreadId=null;openChatPanel();document.getElementById(currentPage==='chat'?'chat-full-input':'chat-input').value='AUDIT_GROUP_MESSAGE';await sendChatMessage();})()`);
      const rows = await evaluate(cdp, "(async()=> (await dbGetAll('chatMessages')).filter(m=>m.friendId==='group_audit'&&m.role==='assistant'))()");
      assert.equal(rows.length, 3, 'one reply per active member');
      for (const cfg of configs) assert.ok(captured.slice(before).some(r => JSON.stringify(r.body).includes('AUDIT_IDENTITY_' + cfg.id)), cfg.id + ' identity reached provider');
    });
    await check('Anthropic/Gemini cache accounting survives real Chat', async () => {
      const stats = await evaluate(cdp, "_tkLoad()");
      assert.ok(stats.records.some(r => r.cid === 'audit-anth' && r.cr === 3 && r.cw === 2));
      assert.ok(stats.records.some(r => r.cid === 'audit-gem' && r.cr === 3));
    });
    console.log('Observed IB.runtime.instance.run calls: ' + await evaluate(cdp, 'window.__runtimeAuditCalls'));
    console.log('Runtime browser audit: ' + failures + ' failed'); process.exitCode = failures ? 1 : 0;
  } finally {
    if (cdp) cdp.close(); browser.kill();
    api.closeAllConnections(); web.closeAllConnections();
    await Promise.all([new Promise(r => api.close(r)), new Promise(r => web.close(r))]);
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
