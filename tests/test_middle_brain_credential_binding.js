/* P34.1 · Middle Brain credential binding · local CDP contract.
   Proves the transport resolves the runtime secret through the existing
   IB.host.credentialResolver when credentialRef is bound, never falls back to
   a persisted plaintext apiKey, and that the settings UI does not persist a
   typed key once a binding is set. No real provider/network/API is used. */
'use strict';

const path = require('path');
const { pathToFileURL } = require('url');
const fx = require('./fixtures/p22-cdp-client.js');

const ROOT = path.resolve(__dirname, '..');
const PAGE_URL = process.env.IB_TEST_PAGE_URL || pathToFileURL(path.join(ROOT, 'InternalBeyond.html')).href;

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
  else { console.error('  FAIL  ' + name + (detail ? '  -> ' + detail : '')); failures++; }
}

async function main() {
  const chrome = fx.chromePath();
  if (!chrome) throw new Error('未找到 Chrome / Edge');
  const browser = await fx.launchChrome(chrome, { startUrl: PAGE_URL });
  const cdp = browser.cdp;
  try {
    await cdp.send('Runtime.enable');
    check('page.ready', await waitFor(cdp, "window.IB&&IB.middleBrain&&IB.middleBrainDirectModelCall&&document.getElementById('mb-credential-ref')"));

    /* ① 就地配置：enabled + endpoint + model + credentialRef，apiKey 为空。
       同时把运行时凭据解析器换成 stub（模拟 Tauri Vault），并截获传输。 */
    await evaluate(cdp, `(function(){
      window.__p34 = { headers: [], calls: 0, credentialWrites: [] };
      window._ibWriteVaultCredential = async function(id, cfg, key){ window.__p34.credentialWrites.push({id:id,hasKey:!!key}); return id; };
      window._ibDeleteVaultCredential = async function(id){ return {credentialRef:id,removed:1}; };
      window.IB.host = { platform: function(){return 'tauri';}, credentialResolver: { available: true, resolve: function(id){
        return Promise.resolve({ ok:true, provider:'openai', apiKey:'VAULT-SECRET-'+id });
      } } };
      window._ibApiPost = function(url, headers, body){
        window.__p34.calls++; window.__p34.headers.push(JSON.parse(JSON.stringify(headers||{})));
        return Promise.resolve({ ok:true, json: function(){ return Promise.resolve({ output_text:'pong' }); } });
      };
      return true;
    })()`);
    await evaluate(cdp, `IB.middleBrain.saveMiddleBrainConfig({ enabled:true, endpoint:'https://vault.example.com/v1/responses', model:'gpt-6-astra', apiKey:'', credentialRef:'role_cred_1', admissionEnabled:false })`);

    check('ready.viaCredentialRefNoPlainKey', await evaluate(cdp, "(async function(){var c=await IB.middleBrain.getMiddleBrainConfig();return c.apiKey===''&&c.credentialRef==='role_cred_1'&&(await IB.middleBrain.middleBrainReady())===true})()"));

    /* ② Direct Channel 调用 → 传输使用 Vault 解析出的 secret，而非空 apiKey。 */
    const direct = await evaluate(cdp, "IB.middleBrainDirectModelCall('hello', {})");
    check('transport.usedVaultSecret', await evaluate(cdp, "window.__p34.calls===1 && window.__p34.headers[0] && window.__p34.headers[0].Authorization==='Bearer VAULT-SECRET-role_cred_1'"), JSON.stringify(await evaluate(cdp, 'window.__p34.headers')));
    check('transport.notEmptyBearer', await evaluate(cdp, "window.__p34.headers[0].Authorization!=='Bearer '"));
    check('direct.ok', !!(direct && direct.ok === true));

    /* ③ 负例：绑定存在但 resolver 失败 → fail-safe，且不发起请求。 */
    await evaluate(cdp, "window.__p34.calls=0; IB.host.credentialResolver.resolve=function(){return Promise.resolve({ok:false});}");
    const denied = await evaluate(cdp, "IB.middleBrainDirectModelCall('hello', {})");
    check('transport.resolverFailClosed', !!(denied && denied.ok === false) && (await evaluate(cdp, 'window.__p34.calls===0')), JSON.stringify(denied));

    /* ④ UI 保存：设了 credentialRef 后，明文 apiKey 不写入 apiSettings。 */
    await evaluate(cdp, "(function(){document.getElementById('mb-credential-ref').value='role_cred_1';document.getElementById('mb-apikey').value='SHOULD-NOT-PERSIST';})()");
    await evaluate(cdp, "IB.middleBrain.saveMiddleBrainConfigUI()");
    check('ui.newKeyMigratesToVault', await evaluate(cdp, "(async function(){var c=await dbGet('apiSettings','middle_brain');return c.credentialRef==='role_cred_1'&&c.apiKey===''&&window.__p34.credentialWrites[0].id==='role_cred_1'})()"));
    check('ui.legacyKeyMigratesToVault', await evaluate(cdp, "(async function(){document.getElementById('mb-credential-ref').value='';document.getElementById('mb-provider-config').value='';document.getElementById('mb-apikey').value='SYNTHETIC_LEGACY_KEY';await IB.middleBrain.saveMiddleBrainConfigUI();var c=await dbGet('apiSettings','middle_brain');var w=window.__p34.credentialWrites[window.__p34.credentialWrites.length-1];return c.credentialRef==='middle_brain'&&c.apiKey===''&&w.id==='middle_brain'&&w.hasKey})()"));

    /* ⑤ 普通 Chat 未受影响：character apiConfig 路径仍可用（结构冒烟）。 */
    check('normalChat.untouched', await evaluate(cdp, "typeof window.callApi==='function'||typeof window._ibWithRuntimeApiCredential==='function'"));
  } finally {
    await browser.close();
  }
  console.log(failures === 0 ? '\nP34.1 Middle Brain credential binding: passed ✔' : '\nP34.1 Middle Brain credential binding: FAILED ✘');
  process.exitCode = failures ? 1 : 0;
}
main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
