'use strict';

/*
 * P6 · 教程截图管线（scripts/capture-guide-shots.js）
 *
 * 干什么：用真实浏览器打开真实 IB 页面，按 docs/guide/annotations.json 的清单
 *         逐张导航到指定状态，用稳定 viewport 截图，并在图上画出高亮框 + 说明箭头。
 *
 * 硬性约束（对应 P6 第 9–12 条）：
 *   · 全新临时浏览器配置目录 —— 开发者本机的真实数据永远不进画面；
 *   · 演示数据来自 scripts/guide-fixtures.js，写进产品自己的存储结构；
 *   · 文件名稳定（<id>.png），UI 改了重跑一次即可全部重生成；
 *   · 图片缺失不影响正文（正文在 assets/js/guide-beginner.js 里，与本管线解耦）；
 *   · 每张图都会回读页面文本做一次密钥 / 私人数据自检。
 *
 * 用法：
 *   node scripts/capture-guide-shots.js                 # 全部重生成
 *   node scripts/capture-guide-shots.js --only 07-chat  # 只生成某几张
 *   node scripts/capture-guide-shots.js --plain         # 不画标注
 *   node scripts/capture-guide-shots.js --keep-profile  # 保留临时浏览器配置（排错用）
 */

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const WEB = require(path.join(ROOT, 'internal-beyond-server.js'));
const bootState = require(path.join(ROOT, 'boot-state.js'));
const fixtures = require('./guide-fixtures.js');
const { ev, wait, sleep, freePort, httpJson, launchBrowser } = require('./cdp-lite.js');

const MANIFEST_PATH = path.join(ROOT, 'docs', 'guide', 'annotations.json');
const VIEWPORT = { width: 1440, height: 900, deviceScaleFactor: 1 };

/* ══ mock 服务：只提供「真实形状」的响应，不模拟业务逻辑 ═════════ */

function startMockProvider() {
  return new Promise(resolve => {
    const state = { calls: 0 };
    const server = http.createServer((req, res) => {
      const cors = {
        'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
        'Access-Control-Allow-Headers': '*', 'Content-Type': 'application/json'
      };
      if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
      if (req.method !== 'POST' || String(req.url).indexOf('/chat/completions') === -1) { res.writeHead(404, cors); res.end('{}'); return; }
      const chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => {
        state.calls++;
        res.writeHead(200, cors);
        res.end(JSON.stringify({
          choices: [{ message: { role: 'assistant', content: '你好，我在。' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 3, completion_tokens: 4 }
        }));
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, state }));
  });
}

function startJsonService(handler) {
  const state = { server: null, port: 0 };
  return {
    state,
    async up() {
      if (state.server) return state.port;
      state.port = await freePort();
      state.server = http.createServer(handler(state));
      await new Promise((res, rej) => { state.server.once('error', rej); state.server.listen(state.port, '127.0.0.1', res); });
      return state.port;
    },
    async down() {
      const s = state.server; state.server = null;
      if (!s) return;
      try { s.closeAllConnections && s.closeAllConnections(); } catch (e) { }
      await new Promise(r => { const t = setTimeout(r, 2000); s.close(() => { clearTimeout(t); r(); }); });
    }
  };
}

function bridgeHandler(state) {
  return (req, res) => {
    const cors = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
    const p = String(req.url || '').split('?')[0];
    if (p === '/health') {
      res.writeHead(200, cors);
      res.end(JSON.stringify({ ok: true, server: 'IB Bridge', version: '0.0.0-demo', uptime: 42, connections: 0, tools: [], lan: false, tokenRequired: false }));
      return;
    }
    if (p === '/status') {
      res.writeHead(200, cors);
      res.end(JSON.stringify({
        ok: true, server: 'IB Bridge', version: '0.0.0-demo', connections: 1,
        whispers: 0, health: 0, letters: 0, sessions: 1, contextFriends: 0, stickers: 0,
        tts: true, mimoTts: false, voiceAsr: false, bark: false, ntfy: false, proactive: true
      }));
      return;
    }
    if (p === '/api/diagnostics') {
      res.writeHead(200, cors);
      res.end(JSON.stringify({
        ok: true,
        service: { name: 'IB Bridge', version: '0.0.0-demo', uptimeSeconds: 42, host: '127.0.0.1', port: state.port, websocketConnections: 0 },
        data: { records: { whispers: 0, health: 0, letters: 0 }, files: [] },
        warnings: []
      }));
      return;
    }
    res.writeHead(404, cors);
    res.end(JSON.stringify({ ok: false }));
  };
}

function activeHandler() {
  return (req, res) => {
    const cors = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
    const p = String(req.url || '').split('?')[0];
    if (p === '/health') {
      res.writeHead(200, cors);
      res.end(JSON.stringify({ ok: true, service: 'internal-beyond-active-messages', version: 3, tasks: 0, plans: 0, moments: 0, reply_chains: 0, pending_events: 0, armed_users: 0, now: Date.now() }));
      return;
    }
    res.writeHead(404, cors);
    res.end(JSON.stringify({ ok: false }));
  };
}

function restartHandler() {
  return (req, res) => {
    const cors = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
    const p = String(req.url || '').split('?')[0];
    if (p === '/status') {
      res.writeHead(200, cors);
      res.end(JSON.stringify({ ok: true, service: 'InternalBeyond Restart', state: 'ready', error: '' }));
      return;
    }
    res.writeHead(404, cors);
    res.end(JSON.stringify({ ok: false }));
  };
}

/* ══ 启动快照：截图期间只需要「一份正常的启动记录」 ══════════════ */

function writeLaunchRecord(dir, webPort, ports) {
  const comps = {
    static: { required: true, affectsOverall: true, probed: true, healthy: true, state: 'healthy', host: '127.0.0.1', port: webPort, url: 'http://127.0.0.1:' + webPort, identity: 'InternalBeyond Web' },
    bridge: { required: false, affectsOverall: true, probed: true, healthy: true, state: 'healthy', port: ports.bridgePort },
    active: { required: false, affectsOverall: true, probed: true, healthy: true, state: 'healthy', port: ports.activePort },
    restart: { required: false, affectsOverall: false, probed: true, healthy: true, state: 'healthy', port: ports.restartPort },
    vision: { required: false, affectsOverall: false, probed: false, healthy: false, state: 'not-enabled', reason: { category: 'not-enabled', message: 'optional' } }
  };
  const st = bootState.buildBootState({
    bootId: bootState.newBootId(Date.now()),
    now: Date.now(),
    phase: 'complete',
    opened: true,
    launcher: {
      pid: process.pid, startedAt: Date.now() - 8000, finishedAt: Date.now(),
      root: ROOT, platform: process.platform, arch: process.arch,
      node: { path: process.execPath, version: process.version, source: 'bundled', bundled: true, requiredMajor: 18, ok: true },
      serviceManager: { state: 'up', wasRunning: true, started: false, error: null }
    },
    components: comps,
    warnings: []
  });
  return bootState.writeBootState(st, { dir });
}

/* ══ 页面内的标注绘制（真实 DOM 覆盖层，截图前画、截图后撤） ═════ */

const ANNO_CSS = [
  '#ib-shot-anno{position:fixed;left:0;top:0;right:0;bottom:0;z-index:2147483646;pointer-events:none;font-family:system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif}',
  '#ib-shot-anno .a-box{position:absolute;border:2px solid #ff5f7a;border-radius:10px;box-shadow:0 0 0 3px rgba(255,95,122,.16),0 0 24px rgba(255,95,122,.32);background:rgba(255,95,122,.06)}',
  '#ib-shot-anno .a-chip{position:absolute;padding:7px 12px;border-radius:8px;background:#ff5f7a;color:#fff;font-size:15px;font-weight:600;line-height:1.4;box-shadow:0 6px 18px rgba(0,0,0,.38);max-width:460px}',
  '#ib-shot-anno .a-stem{position:absolute;width:3px;background:#ff5f7a;border-radius:2px}',
  '#ib-shot-anno .a-head{position:absolute;width:0;height:0;border-left:7px solid transparent;border-right:7px solid transparent}',
  '#ib-shot-anno .a-head.down{border-top:11px solid #ff5f7a}',
  '#ib-shot-anno .a-head.up{border-bottom:11px solid #ff5f7a}'
].join('\n');

function drawScript(target, label) {
  return `(function(){
    var t=document.querySelector(${JSON.stringify(target)});
    if(!t)return null;
    var old=document.getElementById('ib-shot-anno');if(old)old.parentNode.removeChild(old);
    var oldStyle=document.getElementById('ib-shot-anno-style');if(oldStyle)oldStyle.parentNode.removeChild(oldStyle);
    var st=document.createElement('style');st.id='ib-shot-anno-style';st.textContent=${JSON.stringify(ANNO_CSS)};
    document.head.appendChild(st);
    var r=t.getBoundingClientRect();
    var pad=6;
    var bx=Math.max(2,r.left-pad);
    var by=Math.max(2,Math.min(r.top-pad, window.innerHeight-48));
    var bw=Math.max(40,Math.min(r.width+pad*2, window.innerWidth-bx-2));
    var bh=Math.max(40,Math.min(r.height+pad*2, window.innerHeight-by-2));
    var root=document.createElement('div');root.id='ib-shot-anno';
    var box=document.createElement('div');box.className='a-box';
    box.style.left=bx+'px';box.style.top=by+'px';box.style.width=bw+'px';box.style.height=bh+'px';
    root.appendChild(box);
    var chip=document.createElement('div');chip.className='a-chip';chip.textContent=${JSON.stringify(label)};
    root.appendChild(chip);
    document.body.appendChild(root);
    var cw=chip.offsetWidth, ch=chip.offsetHeight;
    var cx=bx+bw/2;
    var left=Math.max(12,Math.min(window.innerWidth-cw-12,cx-cw/2));
    chip.style.left=left+'px';
    var above=by>(ch+34);
    if(above){
      chip.style.top=(by-ch-16)+'px';
      var s1=document.createElement('div');s1.className='a-stem';
      s1.style.left=(cx-1.5)+'px';s1.style.top=(by-14)+'px';s1.style.height='14px';
      root.appendChild(s1);
      var h1=document.createElement('div');h1.className='a-head down';
      h1.style.left=(cx-7)+'px';h1.style.top=(by-11)+'px';
      root.appendChild(h1);
    }else{
      chip.style.top=(by+bh+16)+'px';
      var s2=document.createElement('div');s2.className='a-stem';
      s2.style.left=(cx-1.5)+'px';s2.style.top=(by+bh)+'px';s2.style.height='14px';
      root.appendChild(s2);
      var h2=document.createElement('div');h2.className='a-head up';
      h2.style.left=(cx-7)+'px';h2.style.top=(by+bh)+'px';
      root.appendChild(h2);
    }
    return {x:Math.round(bx),y:Math.round(by),w:Math.round(bw),h:Math.round(bh),side:above?'above':'below'};
  })()`;
}

function clearAnnotation(cdp) {
  return ev(cdp, "(function(){var n=document.getElementById('ib-shot-anno');if(n)n.parentNode.removeChild(n);var s=document.getElementById('ib-shot-anno-style');if(s)s.parentNode.removeChild(s);return true;})()");
}

/* ══ 页面控制小工具 ═══════════════════════════════════════════ */

const setVal = (id, value) => `(function(){var i=document.getElementById(${JSON.stringify(id)});if(!i)return false;i.value=${JSON.stringify(value)};i.dispatchEvent(new Event('input',{bubbles:true}));i.dispatchEvent(new Event('change',{bubbles:true}));return true;})()`;
const clickSel = sel => `(function(){var e=document.querySelector(${JSON.stringify(sel)});if(!e)return false;e.click();return true;})()`;

async function enterSite(cdp) {
  await wait(cdp, "document.readyState==='complete' && !!document.getElementById('splash')", 30000);
  await ev(cdp, "window.confirm=function(){return true;};window.alert=function(){};window.print=function(){};true");
  await ev(cdp, "(function(){var s=document.getElementById('splash-skip');if(s){s.click();return 'skip';}if(typeof enterSite==='function'){enterSite();return 'enter';}return 'none';})()");
  await wait(cdp, "!!document.getElementById('app') && document.getElementById('app').classList.contains('visible')", 30000);
  /* 欢迎层是带 backdrop-filter 的全屏遮罩，淡出约 4.8s；不等到它真正消失，
     后面每张图都会被它洗成一层蓝雾（这正是第一轮截图暴露出来的问题）。 */
  await wait(cdp, "(function(){var s=document.getElementById('splash');if(!s)return true;var cs=getComputedStyle(s);return cs.visibility==='hidden'||Number(cs.opacity)===0;})()", 20000);
  await sleep(250);
}

async function wizardStepTitle(cdp) {
  return ev(cdp, "(function(){var e=document.getElementById('ib-setup-step');return e?e.textContent:'';})()");
}

async function wizardNext(cdp, expectMs) {
  const before = await wizardStepTitle(cdp);
  await ev(cdp, clickSel('#ib-setup-next'));
  const ok = await wait(cdp, `(function(){var e=document.getElementById('ib-setup-step');return !!e && e.textContent!==${JSON.stringify(before)};})()`, expectMs || 20000);
  return ok;
}

/* ══ 截图管线主体 ═════════════════════════════════════════════ */

async function capture(opts) {
  const o = opts || {};
  const outDir = o.outDir || path.join(ROOT, 'docs', 'guide', 'shots');
  const plain = !!o.plain;
  const only = Array.isArray(o.only) && o.only.length ? new Set(o.only) : null;
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  const shots = manifest.shots.filter(s => !only || only.has(s.id));
  const result = { ok: false, outDir, shots: [], problems: [], manifest };

  const demoAudit = fixtures.auditDemo();
  if (!demoAudit.ok) { result.problems.push('演示数据自检失败：' + demoAudit.problems.join('；')); return result; }

  fs.mkdirSync(outDir, { recursive: true });

  const tmpStateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-guide-boot-'));
  process.env.IB_BOOT_STATE_DIR = tmpStateDir;

  const provider = await startMockProvider();
  const bridge = startJsonService(bridgeHandler);
  const active = startJsonService(activeHandler);
  const restart = startJsonService(restartHandler);
  const bridgePort = await bridge.up();
  const activePort = await active.up();
  const restartPort = await restart.up();

  const webSrv = WEB.createWebServer({ port: 0, root: ROOT });
  const webPort = await new Promise((res, rej) => { webSrv.once('error', rej); webSrv.listen(0, '127.0.0.1', () => res(webSrv.address().port)); });
  const pageUrl = 'http://127.0.0.1:' + webPort + '/InternalBeyond.html';
  writeLaunchRecord(tmpStateDir, webPort, { bridgePort, activePort, restartPort });

  let browser = null;
  let cdp = null;
  const pageText = new Map();

  try {
    browser = await launchBrowser({ width: VIEWPORT.width, height: VIEWPORT.height, keepProfile: !!o.keepProfile });
    cdp = await browser.open(pageUrl);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: VIEWPORT.width, height: VIEWPORT.height, deviceScaleFactor: VIEWPORT.deviceScaleFactor, mobile: false });

    const appErrors = [];
    cdp.on('Runtime.exceptionThrown', p => appErrors.push(String((p.exceptionDetails && p.exceptionDetails.text) || 'exception')));
    result.appErrors = appErrors;
    result.profile = browser.profile;

    /* ── 截图原语 ── */
    /* 把标注目标稳定地滚进视口：滚动条可能被异步渲染打断，所以量一次、不够就再滚一次。 */
    async function bringIntoView(target) {
      for (let i = 0; i < 6; i++) {
        const r = await ev(cdp, `(function(){var t=document.querySelector(${JSON.stringify(target)});if(!t)return null;var r=t.getBoundingClientRect();return {top:r.top,bottom:r.bottom,h:r.height};})()`);
        if (!r) return false;
        if (r.top >= 8 && r.bottom <= VIEWPORT.height - 8) return true;
        await ev(cdp, `(function(){var t=document.querySelector(${JSON.stringify(target)});if(!t)return false;try{t.scrollIntoView({block:'center',inline:'center'});}catch(e){t.scrollIntoView();}var r=t.getBoundingClientRect();if(r.top<8||r.bottom>${VIEWPORT.height}-8){window.scrollBy(0, r.top - Math.max(8, (${VIEWPORT.height} - r.height)/2));}return true;})()`);
        await sleep(280);
      }
      /* 目标本身比视口还高（例如整块列表）时不可能完全进入，交给绘制阶段夹取 */
      const last = await ev(cdp, `(function(){var t=document.querySelector(${JSON.stringify(target)});if(!t)return null;var r=t.getBoundingClientRect();return {top:r.top,bottom:r.bottom,h:r.height};})()`);
      return !!last && last.bottom > 8 && last.top < VIEWPORT.height - 8;
    }

    async function shoot(shot) {
      if (shot.target && shot.region !== 'none' && !plain) {
        const found = await bringIntoView(shot.target);
        if (!found) { result.problems.push(shot.id + '：标注目标滚不进视口 ' + shot.target); return null; }
        await sleep(200);
        const box = await ev(cdp, drawScript(shot.target, shot.label || ''));
        if (!box) { result.problems.push(shot.id + '：标注绘制失败 ' + shot.target); return null; }
        shot.__box = box;
      }
      await sleep(220);
      const text = await ev(cdp, "(document.body.innerText||'').slice(0,20000)");
      pageText.set(shot.id, String(text || ''));
      const shotData = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      await clearAnnotation(cdp);
      const buf = Buffer.from(shotData.data, 'base64');
      const file = path.join(outDir, shot.file);
      fs.writeFileSync(file, buf);
      const dim = pngSize(buf);
      const rec = {
        id: shot.id, file: shot.file, bytes: buf.length, width: dim.width, height: dim.height,
        sha1: require('crypto').createHash('sha1').update(buf).digest('hex').slice(0, 12),
        annotated: !!(shot.target && shot.region !== 'none' && !plain),
        caption: shot.caption, box: shot.__box || null
      };
      result.shots.push(rec);
      return rec;
    }

    const byId = id => {
      const s = shots.filter(x => x.id === id)[0];
      if (!s) throw new Error('清单里没有 ' + id);
      return s;
    };

    /* ── 各具名动作 ── */
    const PREPARE = {
      async splash() {
        /* 欢迎页：DOM 一就绪就拍（设置向导要 15s 后才会自动出现，必须抢在它之前）。 */
        await wait(cdp, "document.readyState!=='loading' && !!document.querySelector('.splash-buttons')", 30000);
        await ev(cdp, "window.confirm=function(){return true;};window.alert=function(){};true");
        await sleep(1200);
        if (await ev(cdp, "!!document.querySelector('#ib-setup.is-open')")) {
          throw new Error('欢迎页截图前设置向导已经出现，无法记录首启画面');
        }
      },
      async 'wizard-provider'() {
        /* 首次打开（没有任何角色）时向导会自动出现 —— 截图记录的正是这个真实行为 */
        await enterSite(cdp);
        const opened = await wait(cdp, "!!document.querySelector('#ib-setup.is-open')", 25000);
        if (!opened) throw new Error('设置向导没有自动出现');
        if (!(await wizardNext(cdp))) throw new Error('向导没有进入选择服务步骤');
        if (!(await wait(cdp, "!!document.querySelector('.ib-setup-provider')", 10000))) throw new Error('没有出现服务列表');
      },
      async 'wizard-key'() {
        await ev(cdp, clickSel('.ib-setup-provider[data-provider="openai"]'));
        if (!(await wizardNext(cdp))) throw new Error('向导没有进入填写密钥步骤');
        await wait(cdp, "!!document.getElementById('ib-setup-key')", 8000);
        await ev(cdp, setVal('ib-setup-key', fixtures.DEMO.role.apiKey));
      },
      async 'wizard-test-ok'() {
        if (!(await wizardNext(cdp))) throw new Error('向导没有进入模型步骤');
        await wait(cdp, "!!document.getElementById('ib-setup-model')", 8000);
        await ev(cdp, setVal('ib-setup-model', 'demo-model'));
        await ev(cdp, clickSel('.ib-setup-adv-btn'));
        await ev(cdp, setVal('ib-setup-endpoint', 'http://127.0.0.1:' + provider.port + '/v1/chat/completions'));
        if (!(await wizardNext(cdp))) throw new Error('向导没有进入测试连接步骤');
        await wait(cdp, "!!document.getElementById('ib-setup-run-test')", 8000);
        await ev(cdp, clickSel('#ib-setup-run-test'));
        if (!(await wait(cdp, "!!document.querySelector('#ib-setup-testbox .ib-setup-msg.is-ok')", 25000))) {
          throw new Error('测试连接没有成功（mock 服务被调用 ' + provider.state.calls + ' 次）');
        }
      },
      async 'wizard-role'() {
        if (!(await wizardNext(cdp))) throw new Error('向导没有进入创建角色步骤');
        await wait(cdp, "!!document.getElementById('ib-setup-name')", 8000);
        await ev(cdp, setVal('ib-setup-name', fixtures.DEMO.role.nickname));
        await ev(cdp, setVal('ib-setup-rel', fixtures.DEMO.role.relationship));
        await ev(cdp, setVal('ib-setup-desc', '说话简短、温和，会记得用户说过的小事。'));
      },
      async 'wizard-done'() {
        if (!(await wizardNext(cdp, 30000))) throw new Error('创建角色后没有进入完成步骤');
        await wait(cdp, "!!document.getElementById('ib-setup-next')", 8000);
      },
      async 'chat-demo'() {
        /* 收尾向导 → 把向导创建的真实角色改写成示例配置 → 用同一个角色 id 播种演示数据 → 刷新 */
        await ev(cdp, clickSel('#ib-setup-next'));
        await wait(cdp, "!document.querySelector('#ib-setup.is-open')", 20000);
        const styled = await ev(cdp, fixtures.restyleSource());
        if (!styled || !styled.ok) throw new Error('示例配置改写失败：' + JSON.stringify(styled));
        const roleId = styled.roleId;
        const seeded = await ev(cdp, fixtures.seedSource({ roleId: roleId }));
        if (!seeded || !seeded.ok) throw new Error('演示数据写入失败：' + JSON.stringify(seeded));
        result.roleId = roleId;
        await cdp.send('Page.reload', { ignoreCache: true });
        await enterSite(cdp);
        await wait(cdp, "typeof navTo==='function' && typeof selectFriend==='function'", 20000);
        await ev(cdp, "navTo('chat');true");
        await ev(cdp, `selectFriend(${JSON.stringify(roleId)});true`);
        await wait(cdp, "!!document.querySelector('#chat-full-messages .chat-msg')", 20000);
      },
      async 'api-page'() {
        await ev(cdp, "navTo('api');true");
        await wait(cdp, "document.getElementById('page-api').classList.contains('active') && !!document.querySelector('#api-add-actions button')", 20000);
      },
      async 'memory-page'() {
        await ev(cdp, "navTo('memory');true");
        await wait(cdp, "document.getElementById('page-memory').classList.contains('active') && document.querySelectorAll('#mem-list .mem-card').length > 0", 25000);
      },
      async 'active-page'() {
        await ev(cdp, "navTo('active');true");
        await wait(cdp, "document.getElementById('page-active').classList.contains('active') && !!document.querySelector('.active-switch-line')", 25000);
      },
      async 'moments-page'() {
        await ev(cdp, "navTo('moments');true");
        await wait(cdp, "document.getElementById('page-moments').classList.contains('active') && !!document.getElementById('mom-compose-text')", 25000);
        await wait(cdp, "document.querySelectorAll('#mom-feed .mom-card').length > 0", 25000);
      },
      async 'voice-entry'() {
        await ev(cdp, "navTo('chat');true");
        await ev(cdp, `selectFriend(${JSON.stringify(result.roleId || '')});true`);
        await wait(cdp, "!!document.getElementById('voice-call-launch-full')", 20000);
      },
      async 'diag-normal'() {
        await wireMocks(cdp, { bridgePort, activePort, restartPort });
        await ev(cdp, "navTo('diagnostics');true");
        await wait(cdp, "!!document.querySelector('#ib-diag-list .ib-diag-row') && !document.getElementById('ib-diag-recheck').disabled", 30000);
        await ev(cdp, "document.getElementById('ib-diag-recheck').click();true");
        await wait(cdp, "!document.getElementById('ib-diag-recheck').disabled", 30000);
        const headline = await ev(cdp, "(document.getElementById('ib-diag-headline')||{}).textContent||''");
        if (headline !== '系统运行正常') throw new Error('诊断页在正常状态下标题为「' + headline + '」');
      },
      async 'diag-degraded'() {
        await bridge.down();
        await ev(cdp, "document.getElementById('ib-diag-recheck').click();true");
        await wait(cdp, "!document.getElementById('ib-diag-recheck').disabled", 30000);
        const headline = await ev(cdp, "(document.getElementById('ib-diag-headline')||{}).textContent||''");
        if (headline === '系统运行正常') throw new Error('本地增强功能停掉后，诊断页仍显示「系统运行正常」');
      },
      async 'diag-repair'() {
        const ready = await wait(cdp, "!!document.getElementById('ib-diag-repair-btn')", 20000);
        if (!ready) throw new Error('可修复场景下没有出现「尝试修复」按钮');
      },
      async 'diag-export'() {
        await wait(cdp, "!!document.getElementById('ib-diag-export')", 15000);
      }
    };

    /* ── 按清单顺序执行 ── */
    for (const shot of shots) {
      const prep = PREPARE[shot.prepare];
      if (!prep) { result.problems.push(shot.id + '：未知动作 ' + shot.prepare); continue; }
      try {
        await prep();
        const rec = await shoot(shot);
        if (rec) console.log('  · ' + rec.id + ' → ' + rec.file + ' (' + rec.width + 'x' + rec.height + ', ' + Math.round(rec.bytes / 1024) + ' KB)');
      } catch (e) {
        result.problems.push(shot.id + '：' + String(e && e.message || e));
      }
    }

    /* ── 自检：图不空、图不重复、页面文本不含真实凭据 ── */
    const seen = new Map();
    for (const rec of result.shots) {
      if (rec.bytes < 6000) result.problems.push(rec.id + '：图片过小（' + rec.bytes + ' 字节），可能是空白页');
      if (rec.width !== VIEWPORT.width || rec.height !== VIEWPORT.height) {
        result.problems.push(rec.id + '：尺寸 ' + rec.width + 'x' + rec.height + '，与稳定 viewport 不一致');
      }
      if (seen.has(rec.sha1)) result.problems.push(rec.id + '：与 ' + seen.get(rec.sha1) + ' 完全相同');
      else seen.set(rec.sha1, rec.id);
    }
    const SECRET_RES = [
      { re: /sk-(?!demo-0{4})[A-Za-z0-9_-]{12,}/, why: '疑似真实密钥' },
      { re: /sk-ant-|sk-proj-|sk-or-v1-/, why: '疑似真实厂商密钥' },
      { re: /Bearer\s+[A-Za-z0-9._-]{12,}/, why: '疑似 Bearer 令牌' },
      { re: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./, why: '疑似 JWT' },
      { re: /[\w.+-]+@(?!example\.com|qq\.com)[\w-]+\.[A-Za-z]{2,}/, why: '疑似真实邮箱' }
    ];
    for (const [id, text] of pageText) {
      for (const s of SECRET_RES) {
        if (s.re.test(text)) result.problems.push(id + '：页面文本命中' + s.why);
      }
    }
    if (appErrors.length) result.problems.push('页面抛出异常：' + appErrors.slice(0, 3).join(' | '));

    result.ok = result.problems.length === 0 && result.shots.length === shots.length;
    result.pageText = {};
    for (const [id, text] of pageText) result.pageText[id] = text;
    return result;
  } finally {
    try { if (cdp) cdp.close(); } catch (e) { }
    try { if (browser) await browser.close(); } catch (e) { }
    if (result.profile) result.profileRemoved = !fs.existsSync(result.profile);
    try { await bridge.down(); } catch (e) { }
    try { await active.down(); } catch (e) { }
    try { await restart.down(); } catch (e) { }
    try { await new Promise(r => { const t = setTimeout(r, 1500); webSrv.close(() => { clearTimeout(t); r(); }); }); } catch (e) { }
    try { provider.server.close(); } catch (e) { }
    try { fs.rmSync(tmpStateDir, { recursive: true, force: true }); } catch (e) { }
  }
}

async function wireMocks(cdp, ports) {
  await ev(cdp, `(function(){
    try{ localStorage.setItem('ib_bridge_http','http://127.0.0.1:${ports.bridgePort}'); }catch(e){}
    window.IB_RESTART_PORT=${ports.restartPort};
    window._activeCompanionRequest=function(path,opts){
      var ac=new AbortController(),tm=setTimeout(function(){ac.abort();},(opts&&opts.timeout)||2500);
      return fetch('http://127.0.0.1:${ports.activePort}'+path,{cache:'no-store',signal:ac.signal})
        .then(function(r){return r.text().then(function(t){
          if(!r.ok){var e=new Error('后台服务 '+r.status);e.ibSource='local_service';e.ibComponent='active';e.status=r.status;throw e;}
          return t?JSON.parse(t):{};})})
        .finally(function(){clearTimeout(tm);});
    };
    return true;
  })()`);
}

function pngSize(buf) {
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) return { width: 0, height: 0 };
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function parseArgs(argv) {
  const o = { only: [], plain: false, keepProfile: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--plain') o.plain = true;
    else if (a === '--keep-profile') o.keepProfile = true;
    else if (a === '--out') o.outDir = path.resolve(argv[++i]);
    else if (a === '--only') {
      for (const part of String(argv[++i] || '').split(',')) {
        const id = part.trim();
        if (id) o.only.push(id);
      }
    }
  }
  return o;
}

module.exports = { capture, parseArgs, MANIFEST_PATH, VIEWPORT };

if (require.main === module) {
  const opts = parseArgs(process.argv.slice(2));
  capture(opts).then(res => {
    console.log('\n截图目录：' + res.outDir);
    console.log('生成 ' + res.shots.length + ' 张，问题 ' + res.problems.length + ' 项');
    if (res.problems.length) {
      for (const p of res.problems) console.error('  ✗ ' + p);
      process.exitCode = 1;
    } else {
      console.log('全部通过。');
    }
  }).catch(e => {
    console.error('管线异常：' + String(e && e.stack || e));
    process.exitCode = 1;
  });
}
