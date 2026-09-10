/* ====================================================================
   P11-1C · Middle Brain Canonical Production Execution Seam · CDP 回归
   --------------------------------------------------------------------
   本阶段只做执行边界收口：production（single-chat）只经
   IB.middleBrain.middleBrainExecute 进入 Middle Brain。
   验证（真实 localhost 页面 + CDP + mock Astra 端点）：
     A. 执行缝本身：存在、无 window 兼容别名、键位与门面一致、不暴露层契约；
     B. 执行语义：未启用 → null（bypass：不注入）；Astra 不可用 → local（P11-3 起**注入**本地
        处理结果，替换原四块）；Astra 可用 → 注入 Astra 压缩块（行为与 1A/1B 一致）；
     C. 调用方边界：production 只调用执行缝一次，并透传 canonical context 快照；
     D. 反向证明：patch window 兼容别名不会拦截生产调用（兼容别名不是 canonical path）；
        facade 缺失 → 明确降级（不抛错、不注入）。
   运行：node test_middle_brain_seam.js
   ==================================================================== */
'use strict';

const fs = require('node:fs'), path = require('node:path'), os = require('node:os');

/* Repository root — this file lives in tests/, so the root is one level up. */
const ROOT = path.resolve(__dirname, '..');
const http = require('node:http'), assert = require('node:assert/strict');
const { spawn } = require('node:child_process');

let failures = 0;
const check = (name, cond, detail) => {
  if (cond) console.log('  PASS  ' + name);
  else { failures++; console.error('  FAIL  ' + name + (detail ? '  -> ' + detail : '')); }
};

const harness = fs.readFileSync(path.join(__dirname, 'test_chat_smoke.js'), 'utf8');
const boundary = harness.indexOf('async function main() {');
assert.ok(boundary > 0, 'existing CDP harness boundary changed');
const { chromePath, Cdp, evaluate, waitFor, freePort } = new Function('require', '__dirname',
  harness.slice(0, boundary) + '\nreturn {chromePath,Cdp,evaluate,waitFor,freePort};')(require, ROOT);

/* teardown 纪律：监听器 unref + finally 显式 close（不靠 process.exit 掩盖泄漏）。 */
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => { server.unref(); resolve(server.address().port); }));

const astraReqs = [];
const api = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') { res.end(); return; }
  let raw = ''; for await (const chunk of req) raw += chunk;
  astraReqs.push({ url: req.url, raw: raw.slice(0, 200) });
  const payload = JSON.stringify({ keep: ['SEAM_KEEP'], merge: [], drop: [], compressedContext: 'SEAM_MB_COMPRESSED', currentKept: true });
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ output: [{ type: 'message', content: [{ type: 'output_text', text: payload }] }], usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 } }));
});

(async () => {
  const apiPort = await listen(api), apiBase = 'http://127.0.0.1:' + apiPort;
  const web = require(path.join(ROOT, 'services', 'internal-beyond-server.js')).createWebServer({ root: ROOT, port: 0 });

  const webPort = await listen(web), webBase = 'http://127.0.0.1:' + webPort;
  const debugPort = await freePort();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-seam-'));
  const chrome = chromePath(); assert.ok(chrome, 'Chrome or Edge required');
  const browser = spawn(chrome, ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    '--remote-debugging-port=' + debugPort, '--user-data-dir=' + profile, 'about:blank'], { stdio: 'ignore', windowsHide: true });
  let cdp;

  const ep = apiBase + '/v1/responses';
  /* 生产入口：single-chat context builder（opts.isGroup 缺省 → _buildSingleChatContext）。 */
  const buildCtx = opts => evaluate(cdp, `(async function(){
    var f=(window.IB&&window.IB.chat&&window.IB.chat.buildChatContext)||window.buildChatContext;
    return await f({id:'seam_role',systemPrompt:'SEAM_IDENTITY',nickname:'',relationship:''},${JSON.stringify(opts)});
  })()`);
  const setMb = cfg => evaluate(cdp, `(async function(){await saveMiddleBrainConfig(${JSON.stringify(cfg)});return true})()`);
  const readSeam = () => evaluate(cdp, `(function(){return {calls:window.__seam.calls,src:window.__seam.last?window.__seam.last.source:null,hasSnapshot:!!(window.__seam.opts[0]&&window.__seam.opts[0].contextSnapshot)}})()`);
  const resetSeam = () => evaluate(cdp, `(function(){window.__seam={calls:0,opts:[],last:null};return true})()`);

  try {
    let ready = false;
    for (let i = 0; i < 120; i++) { try { if ((await fetch('http://127.0.0.1:' + debugPort + '/json/version')).ok) { ready = true; break; } } catch (_) {} await new Promise(r => setTimeout(r, 100)); }
    assert.ok(ready, 'CDP readiness');
    const tab = await (await fetch('http://127.0.0.1:' + debugPort + '/json/new?about:blank', { method: 'PUT' })).json();
    cdp = await Cdp.connect(tab.webSocketDebuggerUrl);
    await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
    await cdp.send('Page.navigate', { url: webBase + '/InternalBeyond.html' });
    assert.ok(await waitFor(cdp, "document.readyState==='complete' && !!(window.IB&&window.IB.middleBrain) && typeof IB.middleBrain.middleBrainExecute==='function'", 20000), 'page + facade + execution seam mounted');

    /* 探针：包住 canonical 执行缝（记录调用次数/opts/返回值），生产路径不改。 */
    await evaluate(cdp, `(function(){
      window.__seam={calls:0,opts:[],last:null};
      var op=IB.middleBrain.middleBrainExecute;
      IB.middleBrain.middleBrainExecute=function(id,msg,opts){
        window.__seam.calls++;window.__seam.opts.push(opts||{});
        var r=op.apply(null,arguments);
        if(r&&typeof r.then==='function')return r.then(function(v){window.__seam.last=v;return v});
        window.__seam.last=r;return r;
      };
      return true})()`);

    /* 种子数据：给 seam_role 一条可见记忆（否则 organize 结果为空 → Astra 层直接返回空结果，
       不会发起网络请求，无法覆盖 astra 注入路径）。 */
    await evaluate(cdp, `(async function(){
      await dbPut('memories',{id:'seam_mem',kind:'episodic',createdBy:'seam_role',visibility:'public',visibleTo:[],excludeFrom:[],title:'SEAM_MEMORY_TITLE',content:'SEAM_MEMORY_MARKER',domain:'日常',tags:[],valence:0.5,arousal:0.3,importance:9,resolved:false,activationCount:0,created:Date.now(),lastActivated:0});
      await dbPut('apiSettings',{id:'summarySettings',enabled:false,keepCount:6,welcomeEnabled:false,welcomeInterval:2,musicEnabled:false,summaryApiId:'',summaryWindow:60});
      return true})()`);

    /* ── A. 执行缝本身 ── */
    check('A1.canonicalIdentity', await evaluate(cdp, `(function(){return window._middleBrain===IB.middleBrain && typeof IB.middleBrain.middleBrainExecute==='function'})()`));
    check('A2.noWindowCompatAlias', await evaluate(cdp, `(function(){return typeof window.middleBrainExecute==='undefined'})()`));
    check('A3.keyShape', await evaluate(cdp, `(function(){
      var k=Object.keys(IB.middleBrain);
      /* 45 = P11-2 之后的门面 key 数；P12 追加 2 个 Image Router 决策键 → 47 */
      return k.length===47 && k[k.indexOf('middleBrainCompressPipeline')+1]==='middleBrainExecute'
        && typeof IB.middleBrain.middleBrainFinalizeReply==='function'
        && typeof IB.middleBrain.middleBrainImageMode==='function';
    })()`), await evaluate(cdp, `(function(){return Object.keys(IB.middleBrain).length})()`));
    check('A4.layerContractsNotOnFacade', await evaluate(cdp, `(function(){
      return !('config' in IB.middleBrain)&&!('policy' in IB.middleBrain)&&!('astra' in IB.middleBrain)&&!('judge' in IB.middleBrain)&&!('__middleBrainContracts' in IB.middleBrain);
    })()`));
    const comText = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'communication.js'), 'utf8');
    check('A5.consumerNoInternalContracts', !/__middleBrainContracts/.test(comText) && /IB\.middleBrain\)\|\|null/.test(comText));
    check('A6.compatSurfaceIntact', await evaluate(cdp, `(function(){
      return typeof window.middleBrainCompressPipeline==='function' && typeof window.saveMiddleBrainConfig==='function' && typeof window.middleBrainReady==='function';
    })()`));
    /* 门面 key 与同名 window 兼容符号必须同一对象（identity 不变）；没有 window 别名的只能是
       P11-1C 执行缝 + P11-2 生成后执行缝与 integrity 契约 + P12 Image Router 决策键
       + 2 个历史 facade-only 常量 ——多一个少一个都失败。 */
    check('A7.compatIdentityPreserved', await evaluate(cdp, `(function(){
      var bad=[],facadeOnly=[];Object.keys(IB.middleBrain).forEach(function(k){
        if(!(k in window)){facadeOnly.push(k);return;}
        if(window[k]!==IB.middleBrain[k])bad.push(k+':identity');
      });
      window.__seamIdentityBad=bad;window.__seamFacadeOnly=facadeOnly;return bad.length===0;
    })()`), await evaluate(cdp, `(function(){return JSON.stringify(window.__seamIdentityBad||[])})()`));
    check('A8.facadeOnlySetStable', await evaluate(cdp, `(function(){
      return JSON.stringify((window.__seamFacadeOnly||[]).slice().sort())===JSON.stringify(['MB_ASTRA_TIMEOUT_MS','MB_CI_SCHEMA','MB_CI_TIMEOUT_MS','MB_CTX_DEFAULT_BUDGET','_mbCiGate','_mbCiVisibleText','_mbParseCiJson','middleBrainCharacterIntegrity','middleBrainCharacterIntegrityReset','middleBrainCharacterIntegrityTelemetry','middleBrainExecute','middleBrainFinalizeReply','middleBrainImageMode','normalizeMiddleBrainImageMode','normalizeMiddleBrainIntegritySensitivity']);
    })()`), await evaluate(cdp, `(function(){return JSON.stringify(window.__seamFacadeOnly||[])})()`));

    /* ── B. 执行语义 ── */
    await setMb({ enabled: false }); await resetSeam();
    let ctx = await buildCtx({ userMessage: 'SEAM_USER_MESSAGE' });
    let seam = await readSeam();
    check('B1.disabledReturnsNull', seam.calls === 1 && seam.src === null, JSON.stringify(seam));
    check('B2.disabledNoInjection', !String(ctx.tail).includes('Middle Brain 压缩后的上下文') && !String(ctx.tail).includes('SEAM_MB_COMPRESSED'));

    await setMb({ enabled: true, endpoint: ep, model: 'gpt-6-astra', apiKey: '', admissionEnabled: false }); await resetSeam();
    ctx = await buildCtx({ userMessage: 'SEAM_USER_MESSAGE' });
    seam = await readSeam();
    check('B3.astraNotReadyFallsLocal', seam.calls === 1 && seam.src === 'local', JSON.stringify(seam));
    /* P11-3 · local 语义闭合：Astra 不可用（无 apiKey）时本地处理结果必须进入最终角色请求，
       并且是**替换**原四块（不是追加）。【记忆】是本地 pipeline 的分类段头（原块头是
       【记忆（系统参考，勿提及此段）】），它出现即证明 payload 来自本地处理结果。 */
    check('B4.localInjectedReplacing', String(ctx.tail).includes('Middle Brain 压缩后的上下文')
      && String(ctx.tail).includes('【记忆】') && String(ctx.tail).includes('SEAM_MEMORY_MARKER')
      && !String(ctx.tail).includes('SEAM_MB_COMPRESSED'), String(ctx.tail).slice(0, 200));

    await setMb({ enabled: true, endpoint: ep, model: 'gpt-6-astra', apiKey: 'sk-x', admissionEnabled: false }); await resetSeam();
    ctx = await buildCtx({ userMessage: 'SEAM_USER_MESSAGE' });
    seam = await readSeam();
    check('B5.astraInjected', seam.calls === 1 && seam.src === 'astra' && String(ctx.tail).includes('SEAM_MB_COMPRESSED'), JSON.stringify(seam));
    check('B6.astraRequestHit', astraReqs.some(r => r.url.includes('/v1/responses')), String(astraReqs.length));

    /* ── C. 调用方边界 ── */
    check('C1.seamCalledOncePerTurn', seam.calls === 1, 'calls=' + seam.calls);
    check('C2.snapshotPassedThrough', seam.hasSnapshot === true, 'canonical 快照未透传给执行缝');
    check('C3.optsShapePreserved', await evaluate(cdp, `(function(){
      var o=window.__seam.opts[0];
      return !!o && 'memoryCtx' in o && 'understandingCtx' in o && 'threadCtx' in o && 'momentsCtx' in o;
    })()`));
    check('C4.promptOrderUnchanged', String(ctx.tail).indexOf('SEAM_MB_COMPRESSED') >= 0 && String(ctx.tail).indexOf('当前时间：') >= 0);

    /* ── D. 反向证明：兼容别名不是 canonical path；facade 缺失明确降级 ── */
    await evaluate(cdp, `(function(){
      window.__aliasOrig=window.middleBrainCompressPipeline;
      window.middleBrainCompressPipeline=function(){throw new Error('compat alias must not be the canonical path')};
      return true})()`);
    await resetSeam();
    ctx = await buildCtx({ userMessage: 'SEAM_USER_MESSAGE' });
    seam = await readSeam();
    check('D1.compatAliasNotCanonical', seam.calls === 1 && seam.src === 'astra' && String(ctx.tail).includes('SEAM_MB_COMPRESSED'), JSON.stringify(seam));
    await evaluate(cdp, `(function(){window.middleBrainCompressPipeline=window.__aliasOrig;return true})()`);

    await evaluate(cdp, `(function(){window.__mbFacadeOrig=IB.middleBrain;IB.middleBrain=null;return true})()`);
    let degraded = { err: null };
    try { degraded = await buildCtx({ userMessage: 'SEAM_USER_MESSAGE' }); } catch (e) { degraded = { err: String(e && e.message || e) }; }
    check('D2.facadeMissingDegrades', !degraded.err && !String(degraded.tail || '').includes('SEAM_MB_COMPRESSED'), JSON.stringify(degraded).slice(0, 160));
    await evaluate(cdp, `(function(){IB.middleBrain=window.__mbFacadeOrig;return true})()`);
    check('D3.facadeRestored', await evaluate(cdp, `(function(){return window._middleBrain===IB.middleBrain && typeof IB.middleBrain.middleBrainExecute==='function'})()`));

    console.log('\nMiddle Brain canonical execution seam (P11-1C): ' + failures + ' failed');
    process.exitCode = failures ? 1 : 0;
  } finally {
    if (cdp) cdp.close();
    try { browser.kill(); } catch (_) {}
    try { api.close(); } catch (_) {}
    try { web.close(); } catch (_) {}
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_) {}
  }
})();
