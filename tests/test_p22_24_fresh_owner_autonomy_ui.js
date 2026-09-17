'use strict';
/* ====================================================================
   P22-24 · fresh owner 的自主购买：**真实浏览器**端到端验收
   --------------------------------------------------------------------
   运行：node tests/test_p22_24_fresh_owner_autonomy_ui.js

   ★ 这个文件**不在** test-all.js 里，理由与 P22-15~23 那几条视觉/验收测试
     同款：它要开一个真实浏览器。

   ── 它要证明的那条链（§5）──────────────────────────────────────────
     fresh owner（这一个角色没有任何 Economy 记录）
       ↓  GET /economy/autonomy-policy
     404 + client absence token（**不是** canonical 裁决词）
       ↓  production economy-configuration-core
     state = absent
       ↓  production renderer
     自主购买表单**真的出现**（而不是"读不到自主规则 + POLICY_NOT_FOUND + 再试一次"）
       ↓  填表 → POST /internal/economy/configuration · PUT_AUTONOMY_POLICY
     权威侧真的落了一条规则
       ↓  重新读
     页面进入 present（显示刚写下的那一份）

   ── 它同时证明的对照面（§6）────────────────────────────────────────
     absence   → 表单，**没有**"再试一次"
     真故障     → "再试一次"，**没有**表单
   两者必须分离；把 absence 读成故障正是 P22-24 要修的那个产品缺陷。

   ★ 一个字节的网络都不假：真实 services/home-node-service.js（私有端口 +
     私有数据目录 + 环境里**没有** IB_HOME_NODE_TOKEN）、真实
     services/internal-beyond-server.js、页面经 http://127.0.0.1:<web>/
     InternalBeyond.html 载入（产品正常启动链的那个 origin）。
   ★ 截图只落 %TEMP%，不入仓库。 ★ 只开**一个**浏览器实例，复用到底。
   ==================================================================== */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const fx = require(path.join(__dirname, 'fixtures', 'p22-cdp-client.js'));
const ROOT = path.resolve(__dirname, '..');
const SHOT_DIR = path.join(os.tmpdir(), 'ib-p22-24-shots');

let passed = 0, failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log('  ✔ ' + name); }
  else { failed++; console.error('  ✖ ' + name + (extra !== undefined ? ' — ' + JSON.stringify(extra) : '')); }
}
function section(t) { console.log('\n' + t); }
const sleep = fx.sleep;

/* ── 页面内探针（只读）：读的是**渲染出来的东西**，不是源码字面量 ──────
   ★ `technicalText` 单独取 `.ecfg-technical` 里的字（折叠的「技术说明」），
     用来证明 canonical 裁决词没有作为一个"普通用户错误"出现。 */
const PROBE = `(function(){
  function textOf(n){ return n ? String(n.textContent || '') : ''; }
  function visible(n){
    if (!n) return false;
    var cs = getComputedStyle(n);
    if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    var r = n.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0)) return false;
    for (var p = n; p && p.nodeType === 1; p = p.parentNode) if (p.hidden === true) return false;
    return true;
  }
  var pane = document.getElementById('economy-config-autonomy');
  var all = pane ? textOf(pane) : '';
  var tech = pane ? [].slice.call(pane.querySelectorAll('.ecfg-technical')).map(textOf).join(' | ') : '';
  var inputs = pane ? [].slice.call(pane.querySelectorAll('input')) : [];
  var buttons = pane ? [].slice.call(pane.querySelectorAll('button')).map(function(b){ return String(b.textContent||'').trim(); }) : [];
  /* ★ 遮挡面：一张截图就能看出来的错误，文字断言是看不见的（P22-23 踩过：
     断言在欢迎页**下面**的隐藏 DOM 上照样成立）。因此把"有没有东西盖住
     这一屏"算成**数值**，而不是靠肉眼看图。 */
  function coverage(n){
    if (!n) return 0;
    var cs = getComputedStyle(n);
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.pointerEvents === 'none') return 0;
    var r = n.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0)) return 0;
    var vw = window.innerWidth, vh = window.innerHeight;
    var w = Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0));
    var h = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
    return Math.round((w * h) / (vw * vh) * 100);
  }
  var values = {};
  for (var i = 0; i < inputs.length; i++) values[String(inputs[i].name || ('#' + i))] = String(inputs[i].value == null ? '' : inputs[i].value);
  return {
    paneExists: !!pane,
    paneVisible: visible(pane),
    text: all,
    technicalText: tech,
    values: values,
    hasAbsentLine: all.indexOf('还没有自主规则') >= 0,
    hasReadFailed: all.indexOf('读不到自主规则') >= 0,
    hasRetry: buttons.indexOf('再试一次') >= 0,
    hasSave: buttons.indexOf('保存') >= 0 || buttons.indexOf('保存中…') >= 0,
    buttons: buttons,
    inputNames: inputs.map(function(x){ return String(x.name||''); }),
    enableChecked: (function(){ var c = pane && pane.querySelector('input[name="enabled"]'); return c ? c.checked === true : null; })(),
    theme: (document.body.className||''),
    onEconomyPage: (function(){ var p=document.getElementById('page-economy'); return p ? !p.hidden : null; })(),
    setupCoveragePct: coverage(document.getElementById('ib-setup')),
    setupOpen: (function(){ var o = document.getElementById('ib-setup'); return o ? o.classList.contains('is-open') : null; })(),
    splashCoveragePct: coverage(document.getElementById('splash')),
    wizardApiPresent: !!(window.IBSetup && typeof window.IBSetup.finish === 'function'),
    /* 诊断位：这一格显示的到底是**哪个 owner**、视图模型归到哪一支。 */
    selectedOwner: (function(){ var s = document.getElementById('economy-owner-select'); return s ? String(s.value) : null; })(),
    ownerOptions: (function(){ var s = document.getElementById('economy-owner-select'); return s ? [].slice.call(s.options).map(function(o){ return String(o.value); }) : []; })(),
    viewState: (function(){
      try {
        var snap = IB.economyConfigurationUI.snapshot();
        return { section: snap.section, ownerId: snap.ownerId, stage: snap.stage,
          autonomy: snap.view && snap.view.autonomy ? { state: snap.view.autonomy.state, code: snap.view.autonomy.code } : null,
          budget: snap.view && snap.view.budget ? snap.view.budget.state : null };
      } catch (e) { return 'err:' + e; }
    })()
  };
})()`;

(async function main() {
  const exe = fx.chromePath();
  if (!exe) { console.error('找不到 Chrome / Edge：设置 CHROME_PATH 或安装其中之一。'); process.exit(1); }
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  console.log('P22-24 · fresh owner 的自主购买真路径（真实浏览器）');

  const children = [];
  const dirs = [];
  const tmp = tag => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-p2224-' + tag + '-')); dirs.push(d); return d; };
  const spawnTracked = (cmd, args, opts) => { const c = spawn(cmd, args, opts); children.push(c); return c; };

  const nodeDir = tmp('home');
  const homePort = await fx.freePort();
  const webPort = await fx.freePort();
  const OWNER = 'p2224_agent';

  /* ① 真实 Home Node：环境里刻意**没有** IB_HOME_NODE_TOKEN（普通用户的
        启动环境；凭据由 P22-23 的 authority 自动创造）。 */
  const homeEnv = Object.assign({}, process.env, {
    IB_HOME_NODE_PORT: String(homePort), IB_HOME_NODE_DATA_DIR: nodeDir, IB_HOME_NODE_HOST: '127.0.0.1'
  });
  delete homeEnv.IB_HOME_NODE_TOKEN;
  delete homeEnv.IB_HOME_NODE_TOKEN_FILE;
  delete homeEnv.IB_HOME_NODE_TOKEN_AUTOPROVISION;
  const home = spawnTracked(process.execPath, [path.join('services', 'home-node-service.js')],
    { cwd: ROOT, env: homeEnv, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let homeOut = '';
  home.stdout.on('data', c => { homeOut += String(c); });
  home.stderr.on('data', c => { homeOut += String(c); });

  /* ② 真实静态层（产品正常启动链的那一个）。 */
  const web = spawnTracked(process.execPath, [path.join('services', 'internal-beyond-server.js')],
    { cwd: ROOT, env: Object.assign({}, process.env, { IB_WEB_PORT: String(webPort) }), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let webOut = '';
  web.stdout.on('data', c => { webOut += String(c); });
  web.stderr.on('data', c => { webOut += String(c); });

  const APP_URL = 'http://127.0.0.1:' + webPort + '/InternalBeyond.html';
  let launched = null;
  let token = null;

  const homeGet = (p) => fx.request(homePort, 'GET', p, null, token ? { 'X-IB-Home-Token': token } : {});

  try {
    let up = false;
    for (let i = 0; i < 80; i++) {
      const h = await fx.request(homePort, 'GET', '/health');
      const w = await fx.request(webPort, 'GET', '/health');
      if (h.status === 200 && h.body && h.body.ok && w.status === 200) { up = true; break; }
      await sleep(250);
    }
    section('0 · 正常启动（无 IB_HOME_NODE_TOKEN）');
    check('真实 Home Node 与真实静态层都在私有端口上活着', up, { home: homeOut.slice(-300), web: webOut.slice(-200) });
    if (!up) throw new Error('services did not start');

    /* 权威侧凭据：测试**自己**从数据目录读那一份（P22-23 的 authority 生成
       的），用来在权威侧对证 HTTP 与 store。页面走它自己的交付面。 */
    const credFile = path.join(nodeDir, 'desktop-credential.json');
    check('★ 凭据在首次启动时被自动创造（用户不需要设任何环境变量）',
      fs.existsSync(credFile), fs.readdirSync(nodeDir));
    if (!fs.existsSync(credFile)) throw new Error('no credential');
    token = JSON.parse(fs.readFileSync(credFile, 'utf8')).token;

    /* ── ① 权威侧：fresh owner 真的没有自主策略 ────────────────────── */
    section('1 · 权威侧：这个 owner 在 Economy 里是全新的');
    const policies0 = await homeGet('/economy/autonomy-policies?ownerId=' + OWNER);
    check('① 这个 owner 没有任何自主策略（count=0）',
      policies0.status === 200 && policies0.body.count === 0, policies0.body);
    const read0 = await homeGet('/economy/autonomy-policy?ownerId=' + OWNER);
    check('② GET /economy/autonomy-policy ⇒ 404 + 客户端缺席 token（不是裁决词）',
      read0.status === 404 && read0.body.error === 'autonomy-policy-not-found' &&
      read0.body.error !== 'POLICY_NOT_FOUND', read0.body);

    /* ── ③ 一个真实浏览器 ─────────────────────────────────────────── */
    const launchedChrome = await fx.launchChrome(exe, {});
    launched = launchedChrome;
    const cdp = launchedChrome.cdp;
    const evaluate = async (expression, awaitPromise) => {
      const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: awaitPromise === true });
      if (r.exceptionDetails) throw new Error('evaluate: ' + JSON.stringify(r.exceptionDetails.exception || r.exceptionDetails));
      return r.result.value;
    };
    const shot = async (name) => {
      const s = await cdp.send('Page.captureScreenshot', { format: 'png' });
      const file = path.join(SHOT_DIR, name + '.png');
      fs.writeFileSync(file, Buffer.from(s.data, 'base64'));
      console.log('    · 截图 ' + file);
    };
    const waitFor = async (expr, timeoutMs, label) => {
      const deadline = Date.now() + (timeoutMs || 15000);
      while (Date.now() < deadline) {
        let v = null;
        try { v = await evaluate(expr); } catch (_) { v = null; }
        if (v) return v;
        await sleep(300);
      }
      throw new Error('等待超时：' + (label || expr));
    };
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `try { localStorage.setItem('ib_home_node_http', ${JSON.stringify('http://127.0.0.1:' + homePort)}); localStorage.setItem('ib_home_node_mode','canonical'); localStorage.removeItem('ib_home_node_token'); } catch(e){}`
    });

    /* ── 页面准备：进站点、登记角色、走产品自己的路由进 Economy 设置 ── */
    let wizardDismissed = '未尝试';
    let lastBlockers = null;
    const preparePage = async () => {
      const done = new Promise(resolve => cdp.on('Page.loadEventFired', resolve));
      await cdp.send('Page.navigate', { url: APP_URL });
      await done;
      await sleep(500);
      await evaluate(`(function(){
        var cfg = { id: '${OWNER}', nickname: 'P22-24 角色', model: 'm', endpoint: 'http://127.0.0.1:1/v1',
          apiKey: 'test', provider: 'custom', relationship: '测试', systemPrompt: '', temperature: 1,
          streaming: false, showThinking: false, promptCache: false, created: Date.now() };
        return Promise.resolve(dbPut('apiConfigs', cfg))
          .then(function(){ return (typeof loadApiConfigs === 'function') ? loadApiConfigs() : null; })
          .catch(function(e){ return 'err:' + e; });
      })()`, true);
      /* ★ 首启向导是**产品真实行为**（一个全新 profile 的第一屏）。测试要看的
         是 Economy 那一屏，因此按**用户会走的路径**把它关掉：等它出现，然后
         点它自己的关闭按钮（`.ib-setup-overlay` 只有在有 `is-open` 时才
         `display:flex`，因此那次点击是**真的把它从画面上拿掉**）。
         ★ 为什么不预先写 `ibSetupV1Done`：向导的 boot 早已在 DOMContentLoaded
         时读过那一条记录，"事后写"改不了它的决定（实测：它随后照样 open()，
         把 is-open 加回来）。也不去 removeChild —— 那是把产品的一层撕掉，
         而不是走它的路径。
         ★ 不做这一条，截图拍到的是欢迎页 —— 而所有文字断言在被盖住的 DOM 上
         **照样成立**（P22-23 踩过同一个坑：断言全绿，图里是欢迎页）。 */
      const dismissWizard = `(function(){
        var ov = document.getElementById('ib-setup');
        if (ov && ov.classList.contains('is-open')) {
          var btn = document.getElementById('ib-setup-close');
          if (btn) { btn.click(); return 'clicked-close'; }
          if (window.IBSetup && typeof IBSetup.close === 'function') { IBSetup.close(); return 'api-close'; }
          return 'no-way-to-close';
        }
        return 'not-open';
      })()`;
      let wizardDismiss = 'not-open';
      let wizardSeenOpen = false;
      for (let i = 0; i < 50; i++) {
        const r = await evaluate(dismissWizard);
        if (r !== 'not-open') { wizardSeenOpen = true; wizardDismiss = r; }
        else if (wizardSeenOpen) break;
        await sleep(300);
      }
      console.log('    · 首启向导：' + wizardDismissed);
      /* 等两层遮挡都真的消失：向导（is-open 拿掉）与启动页（visibility 归位）。 */
      let blockersCleared = await evaluate(`(function(){
        var ov = document.getElementById('ib-setup');
        var sp = document.getElementById('splash');
        var cs = sp ? getComputedStyle(sp) : null;
        return {
          wizardOpen: !!(ov && ov.classList.contains('is-open')),
          splashVisible: cs ? !(cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) : false
        };
      })()`);
      for (let i = 0; i < 40 && (blockersCleared.wizardOpen || blockersCleared.splashVisible); i++) {
        await sleep(400);
        blockersCleared = await evaluate(`(function(){
          var ov = document.getElementById('ib-setup');
          var sp = document.getElementById('splash');
          var cs = sp ? getComputedStyle(sp) : null;
          return {
            wizardOpen: !!(ov && ov.classList.contains('is-open')),
            splashVisible: cs ? !(cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) : false
          };
        })()`);
      }
      wizardDismissed = wizardDismiss;
      lastBlockers = blockersCleared;
      await evaluate(`(function(){
        return fetch('http://127.0.0.1:${homePort}/internal/desktop-credential', { method:'POST', headers:{ 'X-IB-Protocol':'1', 'X-IB-Bootstrap':'1', 'Content-Type':'application/json' }, body:'{}' })
          .then(function(r){ return r.json(); })
          .then(function(d){
            return fetch('http://127.0.0.1:${homePort}/characters/publish', { method:'POST', headers:{ 'X-IB-Protocol':'1', 'X-IB-Home-Token': d.credential, 'Content-Type':'application/json' },
              body: JSON.stringify({ characters:[{ id:'${OWNER}', name:'P22-24 角色' }], merge:true }) });
          }).then(function(r){ return r.status; }).catch(function(e){ return 'err:' + e; });
      })()`, true);
      await sleep(400);
      /* 走产品自己的路由：先离开 splash，再 #economy。 */
      await evaluate(`(function(){ try { if (typeof enterSite === 'function') enterSite(); } catch(e){ return 'enterSite-err:' + e; } location.hash = '#economy'; return 'entered'; })()`);
      /* ★ 等启动页真的让位。它有自己的渐隐；判据用**实际遮挡**（computed
         visibility/opacity），而不是猜毫秒数 —— 一个盖住整屏的启动页会让
         截图拍到它，而所有文字断言在被盖住的 DOM 上照样成立。 */
      await waitFor(`(function(){
        var p = document.getElementById('page-economy');
        if (!p || p.hidden) return false;
        var r = p.getBoundingClientRect();
        if (!(r.width > 0 && r.height > 0)) return false;
        var sp = document.getElementById('splash');
        if (!sp) return true;
        var cs = getComputedStyle(sp);
        return (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0);
      })()`, 20000, 'Economy 页可见且启动页让位').catch(() => console.error('    ! 启动页没有让位或 Economy 页不可见'));
      /* 打开设置 → 自主购买那一格（这一格是**产品自己的页签**）。 */
      await evaluate(`(function(){
        if (window.IB && IB.economyShellUI) { IB.economyShellUI.render(); IB.economyShellUI.show('settings'); }
      })()`);
      await sleep(600);
      await evaluate(`(function(){
        var host = document.getElementById('economy-configuration');
        if (!host) return 'no-host';
        var tabs = [].slice.call(host.querySelectorAll('.ecfg-tab'));
        for (var i = 0; i < tabs.length; i++) {
          if (String(tabs[i].textContent||'').trim() === '自主购买') { tabs[i].click(); return 'clicked'; }
        }
        return 'no-tab';
      })()`);
      await sleep(900);
      /* ★ 这里**不**报遮挡读数：`enterSite()` 有自己的渐隐，真正的读数在
         probe 之前那一次取（见下面的 blockersNow）—— 报一个"动画进行中"的
         中间值会让人以为截图拍到了启动页。 */
    };
    /* 遮挡读数：在**断言与截图那一刻**取，而不是动画中间。 */
    const blockersExpr = `(function(){
      var ov = document.getElementById('ib-setup');
      var sp = document.getElementById('splash');
      var cs = sp ? getComputedStyle(sp) : null;
      return {
        wizardOpen: !!(ov && ov.classList.contains('is-open')),
        splashVisible: cs ? !(cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) : false
      };
    })()`;

    section('2 · 真实页面：fresh owner 的自主购买那一格');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await preparePage();

    let probe = await evaluate(PROBE);
    const blockersNow = await evaluate(blockersExpr);
    console.log('    · 首启向导：' + wizardDismissed + ' · 截图前的遮挡读数：' + JSON.stringify(blockersNow));
    check('③ 页面真的停在 Economy 页上（不是启动页盖住的 DOM）', probe.onEconomyPage === true, probe);
    check('④ 自主购买那一格**可见**', probe.paneVisible === true, probe);
    check('④b ★★★ 而且这一屏**没有被任何东西盖住**（首启向导关着、启动页已让位）',
      probe.setupCoveragePct === 0 && probe.splashCoveragePct === 0 &&
      probe.setupOpen === false && blockersNow.splashVisible === false &&
      probe.wizardApiPresent === true,
      { setup: probe.setupCoveragePct, splash: probe.splashCoveragePct, open: probe.setupOpen, blockers: blockersNow });
    check('⑤ ★★★★★ fresh owner 看到的是「还没有自主规则」这个**系统状态**',
      probe.hasAbsentLine === true, { text: probe.text.slice(0, 400) });
    check('⑥ ★★★★★ 而且**没有**出现「读不到自主规则」（absence ≠ 读失败）',
      probe.hasReadFailed === false, { text: probe.text.slice(0, 400) });
    check('⑦ ★★★★★ 那一格里有**真实的配置表单**（输入框 + 保存按钮），不是错误页',
      probe.inputNames.indexOf('perPurchaseLimitMinor') >= 0 &&
      probe.inputNames.indexOf('dailyAutonomousLimitMinor') >= 0 &&
      probe.inputNames.indexOf('enabled') >= 0 &&
      probe.hasSave === true,
      { inputs: probe.inputNames, buttons: probe.buttons });
    check('⑧ ★★★★★ 没有「再试一次」（absence 在骗人去重试一个不会变的状态）',
      probe.hasRetry === false, { buttons: probe.buttons });
    check('⑨ 页面上没有把 canonical 裁决词当成普通用户错误显示',
      probe.text.indexOf('POLICY_NOT_FOUND') < 0, { text: probe.text.slice(0, 400) });
    await shot('01-fresh-autonomy-internal-1280');

    /* ── ④ 纯 GUI 走完首次配置 ─────────────────────────────────────── */
    section('3 · 纯 GUI 完成第一次自主购买配置');
    const filled = await evaluate(`(function(){
      var pane = document.getElementById('economy-config-autonomy');
      if (!pane) return 'no-pane';
      function setInput(name, value){
        var n = pane.querySelector('input[name="' + name + '"]');
        if (!n) return 'missing:' + name;
        var proto = Object.getPrototypeOf(n);
        var desc = Object.getOwnPropertyDescriptor(proto, 'value');
        if (desc && desc.set) desc.set.call(n, String(value)); else n.value = String(value);
        n.dispatchEvent(new Event('input', { bubbles: true }));
        n.dispatchEvent(new Event('change', { bubbles: true }));
        return 'ok';
      }
      function setCheck(name, on){
        var n = pane.querySelector('input[name="' + name + '"]');
        if (!n) return 'missing:' + name;
        if (n.checked !== !!on) n.click();
        return String(n.checked);
      }
      var out = {};
      out.enabled = setCheck('enabled', true);
      out.per = setInput('perPurchaseLimitMinor', '300');
      out.daily = setInput('dailyAutonomousLimitMinor', '900');
      out.approval = setInput('approvalAboveMinor', '150');
      out.kind = setCheck('kind-COMPUTE_CREDIT', true);
      out.settle = setCheck('settle-COMPUTE_GRANT', true);
      return out;
    })()`);
    check('⑩ 表单被真实填写（开关 + 两个上限 + 审批线 + 两个范围）',
      filled && filled.enabled === 'true' && filled.per === 'ok' && filled.daily === 'ok' &&
      filled.approval === 'ok' && filled.kind === 'true' && filled.settle === 'true', filled);
    await shot('02-fresh-autonomy-filled-internal-1280');

    const clickedSave = await evaluate(`(function(){
      var pane = document.getElementById('economy-config-autonomy');
      if (!pane) return 'no-pane';
      var btns = [].slice.call(pane.querySelectorAll('button'));
      for (var i = 0; i < btns.length; i++) {
        var t = String(btns[i].textContent || '').trim();
        if (t === '保存' || t === '保存中…') { btns[i].click(); return t; }
      }
      return 'no-save';
    })()`);
    check('⑪ 点了真实的「保存」按钮（产品自己的写路径）', clickedSave === '保存', clickedSave);

    /* 权威侧：规则真的落了。 */
    let created = null;
    for (let i = 0; i < 40; i++) {
      const r = await homeGet('/economy/autonomy-policy?ownerId=' + OWNER);
      if (r.status === 200 && r.body && r.body.policy) { created = r.body.policy; break; }
      await sleep(400);
    }
    check('⑫ ★★★★★ 权威侧真的落了一条自主策略（页面这一次请求到达了 store）',
      !!created, created);
    if (created) {
      /* ★ 300 IB Credit 在 canonical 形状里是 **30000 minor**（IB_CREDIT 的
         scale = 100）。断言因此写 minor，而不是照抄输入框里的字面量 —— 那
         正是"金额只有一种形状"这条契约在起作用。 */
      check('⑬ 而且它就是表单里填的那一份（两个上限 + 审批线 + 范围 + enabled；300 → 30000 minor）',
        String(created.perPurchaseLimitMinor) === '30000' &&
        String(created.dailyAutonomousLimitMinor) === '90000' &&
        String(created.approvalAboveMinor) === '15000' &&
        created.enabled === true &&
        created.allowedProductKinds.join(',') === 'COMPUTE_CREDIT' &&
        created.allowedSettlementTypes.join(',') === 'COMPUTE_GRANT',
        created);
      check('⑭ 它仍然**不是**预算、不是决策层（逐字自述没变）',
        created.grantsBudget === false && created.isADecisionLayer === false, created);
    }
    const readAfter = await homeGet('/economy/autonomy-policy?ownerId=' + OWNER);
    check('⑮ 重新读 GET /economy/autonomy-policy ⇒ 200 + canonical rule',
      readAfter.status === 200 && !!readAfter.body.policy, readAfter.body);

    /* ── ⑤ 页面随后进入 present ────────────────────────────────────── */
    await sleep(1200);
    probe = await evaluate(PROBE);
    check('⑯ ★★★★★ 页面进入 configured 状态：显示刚写下的那一份（不再是"还没有自主规则"）',
      probe.hasAbsentLine === false && probe.hasReadFailed === false &&
      probe.values.perPurchaseLimitMinor === '300.00' &&
      probe.values.dailyAutonomousLimitMinor === '900.00' &&
      probe.values.approvalAboveMinor === '150.00',
      { values: probe.values, text: probe.text.slice(0, 200) });
    check('⑰ 开关现在反映权威值（enabled=true）', probe.enableChecked === true, probe);
    await shot('03-configured-autonomy-internal-1280');

    /* ── ⑥ 对照面：真故障仍然给「再试一次」，且不给表单 ────────────── */
    section('4 · 对照面：absence 与真故障必须分离');
    /* ★ 手法：把**真实** fetch 收起来，只让那一条读面失败（其余照旧），
       然后走产品自己的读面刷新。这是"真的网络故障"的最近似形态：
       不是改视图模型，是让传输真的抛。 */
    const broken = await evaluate(`(function(){
      IB.__p2224real = window.fetch;
      window.fetch = function(url, opts){
        if (String(url).indexOf('/economy/autonomy-policy') >= 0) return Promise.reject(new TypeError('Failed to fetch'));
        return IB.__p2224real.apply(window, arguments);
      };
      return Promise.resolve(IB.economyConfigurationUI.refresh())
        .then(function(){ return 'refreshed'; }).catch(function(e){ return 'err:' + e; });
    })()`, true);
    await sleep(1200);
    /* ★ 刷新会重画并回到默认那一格，因此再走一次产品自己的切格。 */
    await evaluate(`(function(){ return IB.economyConfigurationUI.show('autonomy'); })()`);
    await sleep(800);
    const brokenProbe = await evaluate(PROBE);
    check('⑱ 真 transport 故障 ⇒ 出现「再试一次」（' + broken + '）',
      brokenProbe.hasRetry === true, { buttons: brokenProbe.buttons, text: brokenProbe.text.slice(0, 300) });
    check('⑲ 而且此时**没有**保存表单（读不到权威就不给写入口）',
      brokenProbe.hasSave === false, { buttons: brokenProbe.buttons, inputs: brokenProbe.inputNames });
    await shot('04-transport-failure-internal-1280');
    await evaluate(`(function(){ if (IB.__p2224real) window.fetch = IB.__p2224real; return 'restored'; })()`);

    /* ── ⑦ Infernal Beyond：同一屏的第二种外观 ─────────────────────── */
    section('5 · Infernal Beyond（同一屏的第二种外观）');
    /* ★ 主题是内存里的（core.js 的 `currentTheme`），刷新页面会回到 Internal
       —— 因此把"这一轮页面处于 Infernal"做成**每次导航后自动生效**的夹具，
       判据用 root 的 class（外观唯一的事实源），而不是点击手势 + 计时。 */
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `(function(){
        var tries = 0;
        function apply(){
          try {
            var root = document.getElementById('root') || document.body;
            if (root && root.classList.contains('theme-infernal')) return;
            if (tries++ > 80) return;
            document.body.classList.add('theme-infernal');
            document.documentElement.classList.add('theme-infernal');
            var r2 = document.getElementById('root');
            if (r2) r2.classList.add('theme-infernal');
          } catch (e) {}
        }
        try { document.addEventListener('DOMContentLoaded', function(){ var t = setInterval(function(){ apply(); if (tries > 80) clearInterval(t); }, 150); }); } catch (e) {}
      })();`
    });
    /* 第二位角色：**同样 fresh**（在 Economy 里一条记录都没有），用来在
       Infernal 下再看一次 absence 表单 —— 两个外观各看一次同一屏。 */
    const OWNER_B = 'p2224_agent_b';
    await evaluate(`(function(){
      var cfg = { id: '${OWNER_B}', nickname: 'P22-24 角色 B', model: 'm', endpoint: 'http://127.0.0.1:1/v1',
        apiKey: 'test', provider: 'custom', relationship: '测试', systemPrompt: '', temperature: 1,
        streaming: false, showThinking: false, promptCache: false, created: Date.now() };
      return Promise.resolve(dbPut('apiConfigs', cfg)).then(function(){ return loadApiConfigs(); }).catch(function(e){ return 'err:' + e; });
    })()`, true);
    await evaluate(`(function(){
      return fetch('http://127.0.0.1:${homePort}/internal/desktop-credential', { method:'POST', headers:{ 'X-IB-Protocol':'1', 'X-IB-Bootstrap':'1', 'Content-Type':'application/json' }, body:'{}' })
        .then(function(r){ return r.json(); })
        .then(function(d){
          return fetch('http://127.0.0.1:${homePort}/characters/publish', { method:'POST', headers:{ 'X-IB-Protocol':'1', 'X-IB-Home-Token': d.credential, 'Content-Type':'application/json' },
            body: JSON.stringify({ characters:[{ id:'${OWNER_B}', name:'P22-24 角色 B' }], merge:true }) });
        }).then(function(r){ return r.status; }).catch(function(e){ return 'err:' + e; });
    })()`, true);

    /* 这一次导航之后，页面自动处于 Infernal。owner 由**产品自己的选择器**
       决定（它按 canonical owner 来源解析），因此测试显式切回 A —— 与用户在
       「配置对象」下拉里选谁同一条路径，而不是假设默认值。 */
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await preparePage();
    const switchTo = async (id) => evaluate(`(function(){
      var sel = document.getElementById('economy-owner-select');
      if (!sel) return 'no-select';
      var opt = null;
      for (var i = 0; i < sel.options.length; i++) if (sel.options[i].value === '${id}') opt = sel.options[i];
      if (!opt) return 'no-option:' + [].slice.call(sel.options).map(function(o){ return o.value; }).join(',');
      sel.value = '${id}';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      return 'switched';
    })()`);
    const backToA = await switchTo(OWNER);
    await sleep(1600);
    await evaluate(`(function(){ return IB.economyConfigurationUI.show('autonomy'); })()`);
    await sleep(900);
    const infernal = await evaluate(PROBE);
    console.log('    · Infernal 下的 owner：' + backToA + ' → ' + JSON.stringify({ selected: infernal.selectedOwner, view: infernal.viewState }));
    check('⑳ Infernal 下 owner A 这一格仍然显示 configured 状态（不是错误页）',
      /theme-infernal/.test(String(infernal.theme)) && backToA === 'switched' &&
      infernal.hasReadFailed === false && infernal.hasSave === true &&
      infernal.values.perPurchaseLimitMinor === '300.00',
      { theme: infernal.theme, switched: backToA, values: infernal.values, view: infernal.viewState, text: infernal.text.slice(0, 200) });
    await shot('05-configured-autonomy-infernal-1280');

    /* 换到第二位 fresh 角色：同一个 Infernal 外观下再看一次 absence 表单。 */
    const switched = await switchTo(OWNER_B);
    await sleep(1600);
    await evaluate(`(function(){ return IB.economyConfigurationUI.show('autonomy'); })()`);
    await sleep(900);
    const infernalFresh = await evaluate(PROBE);
    console.log('    · Infernal 下的 fresh owner：' + switched + ' → ' + JSON.stringify({ selected: infernalFresh.selectedOwner, view: infernalFresh.viewState }));
    check('㉑ ★★★★★ Infernal 下 fresh owner 同样看到 absence 表单（不是"读不到 + 再试一次"）',
      switched === 'switched' &&
      infernalFresh.hasAbsentLine === true && infernalFresh.hasReadFailed === false &&
      infernalFresh.hasRetry === false && infernalFresh.hasSave === true,
      { switched: switched, view: infernalFresh.viewState, text: infernalFresh.text.slice(0, 300), buttons: infernalFresh.buttons });
    await shot('06-fresh-autonomy-infernal-1280');

    /* 390 宽的窄屏看一眼（fresh 那一屏） */
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await sleep(900);
    const narrow = await evaluate(PROBE);
    check('㉒ 窄屏（390）下 fresh 那一格仍然可读、仍然有表单',
      narrow.paneVisible === true && narrow.hasSave === true && narrow.hasAbsentLine === true,
      { buttons: narrow.buttons, text: narrow.text.slice(0, 200) });
    await shot('07-fresh-autonomy-infernal-390');

    section('6 · 结果');
  } catch (error) {
    failed++;
    console.error('  ✖ 验收抛出异常 — ' + String((error && (error.stack || error.message)) || error));
  } finally {
    /* 顺序要紧：先关浏览器（连子进程树），再停服务，最后删目录。 */
    if (launched && typeof launched.close === 'function') { try { await launched.close(); } catch (_) { } }
    for (const c of children) { try { c.kill(); } catch (_) { } }
    await sleep(800);
    for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) { } }
    console.log('\n' + (failed === 0 ? '全部通过 ✔' : failed + ' 项失败 ✘') +
      '  (' + passed + ' 通过 / ' + failed + ' 失败)');
    console.log('截图目录：' + SHOT_DIR);
    /* ★ 显式退出：本文件持有 keep-alive 的 HTTP 句柄与一个 CDP socket，
       只靠"事件循环空了"退出在实测中不会发生（结果都打印完了还挂到超时）。
       这与"不制造孤儿进程"是同一条纪律的收尾。 */
    process.exitCode = failed === 0 ? 0 : 1;
    setTimeout(() => process.exit(failed === 0 ? 0 : 1), 200);
  }
})();
