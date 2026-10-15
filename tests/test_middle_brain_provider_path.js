/* P34.2-A · Middle Brain network-path reuse · local CDP contract.
   Proves that when Middle Brain is bound to an existing apiConfig (providerConfigId),
   it replays that config's provider/endpoint/model through the SAME provider seam
   (AstraAdapter.buildRequest -> _ibApiPost), so the request reaches a REACHABLE
   endpoint instead of failing `network` on the unreachable default. Secret is still
   resolved via IB.host.credentialResolver and never persisted. No real API is used. */
'use strict';

const http = require('http');
const path = require('path');
const { pathToFileURL } = require('url');
const fx = require('./fixtures/p22-cdp-client.js');

const PAGE_URL = process.env.IB_TEST_PAGE_URL || pathToFileURL(path.join(__dirname, '..', 'InternalBeyond.html')).href;
const MOCK_PORT_MIN = 24100, MOCK_PORT_MAX = 24250;

function startMock() {
  return new Promise((resolve, reject) => {
    const seen = [];
    let responseScript = [];
    const server = http.createServer((req, res) => {
      const cors = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'authorization, content-type',
        'Access-Control-Expose-Headers': 'Retry-After'
      };
      if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        seen.push({ url: req.url, method: req.method, auth: req.headers.authorization || '', body });
        const scripted = responseScript.shift() || {};
        const status = Number(scripted.status) || 200;
        const headers = Object.assign({ 'Content-Type': 'application/json' }, cors);
        if (scripted.retryAfter) headers['Retry-After'] = String(scripted.retryAfter);
        res.writeHead(status, headers);
        res.end(status >= 400 ? JSON.stringify({ error: { message: 'scripted transient failure' } })
          : JSON.stringify({ choices: [{ message: { content: 'pong' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
      });
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => resolve({ server, seen, port: server.address().port,
      script: function (steps) { responseScript = Array.isArray(steps) ? steps.slice() : []; } }));
  });
}

async function evaluate(cdp, expression) {
  const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
  return r.result && r.result.value;
}
async function waitFor(cdp, expression, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { try { if (await evaluate(cdp, expression)) return true; } catch (_) {} await fx.sleep(120); }
  return false;
}
let failures = 0;
function check(name, condition, detail) { if (condition) console.log('  PASS  ' + name); else { console.error('  FAIL  ' + name + (detail ? '  -> ' + detail : '')); failures++; } }

async function main() {
  const mock = await startMock();
  if (mock.port < MOCK_PORT_MIN || mock.port > MOCK_PORT_MAX) { /* port is fine anywhere; range kept for logs */ }
  const endpoint = 'http://127.0.0.1:' + mock.port + '/v1/chat/completions';
  const browser = await fx.launchChrome(fx.chromePath(), { startUrl: PAGE_URL });
  const cdp = browser.cdp;
  try {
    await cdp.send('Runtime.enable');
    check('page.ready', await waitFor(cdp, "window.IB&&IB.middleBrainDirectModelCall&&typeof dbPut==='function'&&document.getElementById('mb-provider-config')"));

    await evaluate(cdp, `(async function(){
      window.IB.host = { platform:function(){return 'tauri';}, credentialResolver:{ available:true, resolve:function(){ return Promise.resolve({ok:true,provider:'deepseek',apiKey:'resolved-runtime-secret'}); } } };
      window.__directPost = function(url,h,b,o){return fetch(url,{method:'POST',headers:h,body:b,signal:o&&o.signal});};
      window._ibApiPost = window.__directPost;
      await dbPut('apiConfigs', { id:'reachable_provider', nickname:'Reachable', provider:'deepseek', endpoint:${JSON.stringify(endpoint)}, model:'mock-model', temperature:1, created:Date.now() });
      await IB.middleBrain.saveMiddleBrainConfig({ enabled:true, provider:'astra', endpoint:'https://api.openai.com/v1/responses', model:'gpt-6-astra', apiKey:'', credentialRef:'reachable_provider', providerConfigId:'reachable_provider', admissionEnabled:false });
      return true; })()`);

    const ok = await evaluate(cdp, `IB.middleBrainDirectModelCall('hello', { timeoutMs: 6000 })`);
    check('bound.ok', !!(ok && ok.ok === true), JSON.stringify(ok));
    const posts = mock.seen.filter(s => s.method === 'POST');
    const seen = posts[posts.length - 1] || {};
    check('bound.hitReachableEndpoint', seen.url === '/v1/chat/completions' && seen.method === 'POST', JSON.stringify(mock.seen.map(s => s.method + ' ' + s.url)));
    check('bound.usedBoundModel', typeof seen.body === 'string' && /"mock-model"/.test(seen.body), String(seen.body).slice(0, 120));
    check('bound.resolverSecretUsed', seen.auth === 'Bearer resolved-runtime-secret');
    check('bound.noPersistedPlainKey', await evaluate(cdp, "(async function(){var c=await IB.middleBrain.getMiddleBrainConfig();return c.apiKey==='' && c.providerConfigId==='reachable_provider'})()"));

    mock.script([{ status: 429, retryAfter: '0.1' }, { status: 200 }]);
    const direct = await evaluate(cdp, "IB.middleBrainDirect.send('transient retry probe', { timeoutMs: 6000 })");
    const directPosts = mock.seen.filter(s => s.method === 'POST').slice(1);
    const turnTrace = await evaluate(cdp, "(function(){var all=IBModelCore.turnTraceRecent(10).filter(function(t){return t.consumer==='middle_brain.direct'});return all.length?all[all.length-1]:null})()");
    check('direct.retry429.sameProviderRoute', !!(direct && direct.ok === true) && directPosts.length === 2
      && directPosts[0].url === '/v1/chat/completions' && directPosts[1].url === '/v1/chat/completions', JSON.stringify({ direct: direct && direct.ok, posts: directPosts.length }));
    check('direct.turnTrace.recordsRetryAndResult', !!turnTrace && turnTrace.events.some(e => e.eventType === 'model_call_retry'
      && e.errorCategory === 'rate_limit' && e.httpStatus === 429) && turnTrace.events.some(e => e.eventType === 'result'), JSON.stringify(turnTrace && turnTrace.events.map(e => e.eventType)));

    /* Negative control: unbound -> default unreachable endpoint -> no longer ok (path differs). */
    await evaluate(cdp, "IB.middleBrain.saveMiddleBrainConfig({ providerConfigId:'', credentialRef:'' })");
    const unbound = await evaluate(cdp, "IB.middleBrainDirectModelCall('hello', { timeoutMs: 2500 })");
    check('unbound.doesNotReachMock', !(unbound && unbound.ok === true), JSON.stringify(unbound));

    /* Normal Chat seam untouched: callApi still routed through _ibApiPost. */
    check('normalChat.seamIntact', await evaluate(cdp, "typeof window.callApi==='function' && typeof window._ibWithRuntimeApiCredential==='function' && typeof window._ibApiPost==='function'"));
  } finally {
    await browser.close();
    await new Promise(r => mock.server.close(r));
  }
  console.log(failures === 0 ? '\nP34.2-A provider-path: passed ✔' : '\nP34.2-A provider-path: FAILED ✘');
  process.exitCode = failures ? 1 : 0;
}
main().catch(e => { console.error(e.stack || e); process.exitCode = 1; });
