/* P32-W.3 · Browser route bridge / hidden console CDP smoke.
   Browser mode uses real URL/hash triggers. The console adapter is exercised
   with the existing Host capability seam switched to a Tauri test double;
   no native command or provider is involved. */
'use strict';

const path = require('path');
const { pathToFileURL } = require('url');
const fx = require('./fixtures/p22-cdp-client.js');

const ROOT = path.resolve(__dirname, '..');
const PAGE_URL = pathToFileURL(path.join(ROOT, 'InternalBeyond.html')).href;

async function evaluate(cdp, expression) {
  const result = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error('page exception: ' + JSON.stringify(result.exceptionDetails));
  return result.result && result.result.value;
}

async function waitFor(cdp, expression, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try { if (await evaluate(cdp, expression)) return true; } catch (_) {}
    await fx.sleep(120);
  }
  return false;
}

function check(name, condition, detail) {
  if (condition) console.log('  PASS  ' + name);
  else { console.error('  FAIL  ' + name + (detail ? '  -> ' + detail : '')); failures++; }
}

let failures = 0;

async function main() {
  const chrome = fx.chromePath();
  if (!chrome) throw new Error('未找到 Chrome / Edge');
  const browser = await fx.launchChrome(chrome, { startUrl: PAGE_URL });
  const cdp = browser.cdp;
  try {
    await cdp.send('Runtime.enable');
    check('browser.normal.ready', await waitFor(cdp, "window.IB&&IB.secretRoutes&&typeof IB.secretRoutes.resolve==='function'"));
    check('browser.normal.no-secret-ui', await evaluate(cdp, "!document.getElementById('ibterm')&&!document.getElementById('ib-middle-brain-direct-root')&&!document.getElementById('ib-secret-route-console')"));

    await cdp.send('Page.navigate', { url: PAGE_URL + '?middlebrain=1#chat' });
    check('browser.middlebrain.query-1', await waitFor(cdp, "!!document.getElementById('ib-middle-brain-direct-root')"));
    check('browser.middlebrain.route-id', await evaluate(cdp, "IB.secretRoutes.resolve({search:location.search,hash:location.hash},{source:'browser-url'}).routeId==='middlebrain'"));
    check('browser.middlebrain.hash-preserved', await evaluate(cdp, "location.hash==='#chat'"));
    await evaluate(cdp, "IB.middleBrainDirect.close()");
    check('browser.middlebrain.close-query', await evaluate(cdp, "location.search===''&&!document.getElementById('ib-middle-brain-direct-root')"));
    check('browser.middlebrain.close-hash', await evaluate(cdp, "location.hash==='#chat'"));

    await cdp.send('Page.navigate', { url: PAGE_URL + '?middlebrain=true#chat' });
    check('browser.middlebrain.query-true', await waitFor(cdp, "!!document.getElementById('ib-middle-brain-direct-root')"));
    await cdp.send('Page.navigate', { url: PAGE_URL + '?middlebrain=0#chat' });
    check('browser.middlebrain.false-hidden', await fx.sleep(700).then(() => evaluate(cdp, "!document.getElementById('ib-middle-brain-direct-root')")));

    await cdp.send('Page.navigate', { url: PAGE_URL + '#Beyond' });
    check('browser.beyond.hash', await waitFor(cdp, "!!document.getElementById('ibterm')&&document.getElementById('ibterm').classList.contains('ibterm-on')"));
    check('browser.beyond.route-id', await evaluate(cdp, "IB.secretRoutes.resolve({search:location.search,hash:location.hash},{source:'browser-url'}).routeId==='beyond'"));
    await evaluate(cdp, "IB.easterEgg.close()");
    check('browser.beyond.close-preserves-hash', await evaluate(cdp, "location.hash==='#Beyond'&&!document.getElementById('ibterm').classList.contains('ibterm-on')"));

    await cdp.send('Page.navigate', { url: PAGE_URL + '#chat' });
    check('tauri.normal.browser-no-console', await waitFor(cdp, "!document.getElementById('ib-secret-route-console')"));
    await evaluate(cdp, "IB.host={platform:function(){return 'tauri';}};IB.secretRoutes.openConsole() ");
    check('tauri.console.opens', await waitFor(cdp, "IB.secretRoutes.isConsoleOpen()&&!!document.getElementById('ib-secret-route-console')"));
    await evaluate(cdp, "(function(){var i=document.querySelector('.ib-secret-route-input');i.value='javascript:alert(1)';document.querySelector('.ib-secret-route-form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));})() ");
    check('tauri.console.rejects-malicious', await evaluate(cdp, "document.querySelector('.ib-secret-route-status').textContent==='Unknown secret route.'&&IB.secretRoutes.isConsoleOpen()"));
    await evaluate(cdp, "(function(){var i=document.querySelector('.ib-secret-route-input');i.value='Beyond';document.querySelector('.ib-secret-route-form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));})() ");
    check('tauri.console.beyond-existing-handler', await waitFor(cdp, "!IB.secretRoutes.isConsoleOpen()&&document.getElementById('ibterm')&&document.getElementById('ibterm').classList.contains('ibterm-on')"));
    await evaluate(cdp, "IB.easterEgg.close();IB.secretRoutes.openConsole()");
    await evaluate(cdp, "(function(){var i=document.querySelector('.ib-secret-route-input');i.value='middlebrain';document.querySelector('.ib-secret-route-form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));})() ");
    check('tauri.console.middlebrain-existing-handler', await waitFor(cdp, "!IB.secretRoutes.isConsoleOpen()&&!!document.getElementById('ib-middle-brain-direct-root')"));
    await evaluate(cdp, "IB.middleBrainDirect.close()");
    check('tauri.middlebrain.close-preserves-page-hash', await evaluate(cdp, "location.search===''&&location.hash==='#chat'&&!document.getElementById('ib-middle-brain-direct-root')"));
  } finally {
    await browser.close();
  }
  console.log(failures === 0 ? '\nP32-W.3 Secret Route CDP passed ✔' : '\nP32-W.3 Secret Route CDP FAILED ✘');
  process.exitCode = failures ? 1 : 0;
}

main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
