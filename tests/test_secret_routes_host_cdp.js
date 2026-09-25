/* P32-W.3 · Packaged Host Secret Route acceptance.
   Opt-in only: starts the existing P7 real smoke with WebView2's documented
   additional-debugging-arguments seam, then drives the installed Host page.
   It never changes the Host binary, installer, registry identity, or payload. */
'use strict';

const path = require('path');
const { spawn } = require('child_process');
const fx = require('./fixtures/p22-cdp-client.js');

const ROOT = path.resolve(__dirname, '..');
const EXE = process.argv[process.argv.indexOf('--exe') + 1] || path.join(ROOT, 'tmp', 'installer-smoke-build', 'InternalBeyond-Installer-Smoke-Test-Setup-1.0.6.exe');

async function jsonAt(port, pathName) {
  try {
    const response = await fetch('http://127.0.0.1:' + port + pathName);
    if (!response.ok) return null;
    return await response.json();
  } catch (_) { return null; }
}

async function waitTarget(port, timeout = 110000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const list = await jsonAt(port, '/json/list');
    const target = Array.isArray(list) && list.find(row => row && row.type === 'page' && row.webSocketDebuggerUrl);
    if (target) return target;
    await fx.sleep(250);
  }
  return null;
}

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

let failures = 0;
function check(name, condition, detail) {
  if (condition) console.log('  PASS  ' + name);
  else { failures++; console.error('  FAIL  ' + name + (detail ? '  -> ' + detail : '')); }
}

async function main() {
  if (!require('fs').existsSync(EXE)) throw new Error('test-only installer not found: ' + EXE);
  const debugPort = await fx.freePort();
  const smoke = spawn(process.execPath, [
    path.join(ROOT, 'tests', 'test_installer_smoke.js'), '--real-install-smoke', '--allow-rerun', '--exe', EXE
  ], {
    cwd: ROOT,
    windowsHide: true,
    env: Object.assign({}, process.env, {
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=' + debugPort
    }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  smoke.stdout.on('data', chunk => process.stdout.write(String(chunk)));
  smoke.stderr.on('data', chunk => process.stderr.write(String(chunk)));
  let cdp = null;
  try {
    const target = await waitTarget(debugPort);
    check('packaged.host.webview-debug-target', !!target);
    if (target) {
      cdp = await fx.Cdp.connect(target.webSocketDebuggerUrl);
      await cdp.send('Runtime.enable');
      check('packaged.host.secret-routes-loaded', await waitFor(cdp, "IB&&IB.secretRoutes&&IB.host&&IB.host.platform() === 'tauri'"));
      check('packaged.host.normal-console-hidden', await evaluate(cdp, "!IB.secretRoutes.isConsoleOpen()&&!document.getElementById('ib-secret-route-console')"));
      check('packaged.host.partial-gesture-hidden', await evaluate(cdp, "(function(){for(var i=0;i<6;i++)document.getElementById('nav-home').click();return !IB.secretRoutes.isConsoleOpen()})()"));
      await evaluate(cdp, "document.getElementById('nav-home').click()");
      check('packaged.host.gesture-opens-console', await waitFor(cdp, "IB.secretRoutes.isConsoleOpen()"));
      await evaluate(cdp, "(function(){var i=document.querySelector('.ib-secret-route-input');i.value='javascript:alert(1)';document.querySelector('.ib-secret-route-form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));})() ");
      check('packaged.host.malicious-rejected', await evaluate(cdp, "IB.secretRoutes.isConsoleOpen()&&document.querySelector('.ib-secret-route-status').textContent==='Unknown secret route.'"));
      await evaluate(cdp, "(function(){var i=document.querySelector('.ib-secret-route-input');i.value='Beyond';document.querySelector('.ib-secret-route-form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));})() ");
      check('packaged.host.beyond-reuses-existing-handler', await waitFor(cdp, "!IB.secretRoutes.isConsoleOpen()&&document.getElementById('ibterm').classList.contains('ibterm-on')"));
      await evaluate(cdp, "IB.easterEgg.close();document.getElementById('nav-home').click();document.getElementById('nav-home').click();document.getElementById('nav-home').click();document.getElementById('nav-home').click();document.getElementById('nav-home').click();document.getElementById('nav-home').click();document.getElementById('nav-home').click()");
      check('packaged.host.console-reopens', await waitFor(cdp, "IB.secretRoutes.isConsoleOpen()"));
      await evaluate(cdp, "(function(){var i=document.querySelector('.ib-secret-route-input');i.value='middlebrain';document.querySelector('.ib-secret-route-form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));})() ");
      check('packaged.host.middlebrain-reuses-p31', await waitFor(cdp, "!IB.secretRoutes.isConsoleOpen()&&!!document.getElementById('ib-middle-brain-direct-root')"));
      await evaluate(cdp, "IB.middleBrainDirect.close()");
      check('packaged.host.p31-close-return', await evaluate(cdp, "location.search===''&&!document.getElementById('ib-middle-brain-direct-root')"));
    }
  } finally {
    if (cdp) cdp.socket.destroy();
    const exit = await new Promise(resolve => {
      if (smoke.exitCode != null) return resolve(smoke.exitCode);
      smoke.once('exit', code => resolve(code == null ? 1 : code));
    });
    if (exit !== 0) failures++;
  }
  console.log(failures === 0 ? '\nP32-W.3 packaged Host Secret Route acceptance passed ✔' : '\nP32-W.3 packaged Host Secret Route acceptance FAILED ✘');
  process.exitCode = failures ? 1 : 0;
}

main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
