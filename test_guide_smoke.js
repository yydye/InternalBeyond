'use strict';
/* Internal Beyond — P6 零基础使用指南浏览器 smoke（真实 Chrome/Edge + 真实静态服务）
   运行：node test_guide_smoke.js

   覆盖：
     A. 从欢迎页「查看说明」进入 Guide；零基础指南在页面最前面
     B. 12 章真实渲染、每章有目标与步骤、目录锚点可用、版本标识可见
     C. 16 张截图真实加载（naturalWidth 1440）——不是占位图
     D. 图片加载失败时正文照旧可读（回退占位）
     E. 真实渲染文本里没有任何底层术语 / 网址 / 端口
     F. 深链按钮跳到真实存在的页面；指南样式不污染其它页面
     G. 无未捕获异常 */

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const ROOT = __dirname;
const WEB = require('./internal-beyond-server.js');
const bootState = require('./boot-state.js');
const { ev, wait, sleep, httpJson, launchBrowser } = require('./scripts/cdp-lite.js');

const VIEWPORT = { width: 1440, height: 900 };
const MANIFEST = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs', 'guide', 'annotations.json'), 'utf8'));

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.error('  ✗ ' + name + (detail !== undefined ? ' — ' + JSON.stringify(detail) : '')); }
}
function section(t) { console.log('\n── ' + t + ' ──'); }

function writeLaunchRecord(dir, webPort) {
  const st = bootState.buildBootState({
    bootId: bootState.newBootId(Date.now()),
    now: Date.now(),
    phase: 'complete',
    opened: true,
    launcher: {
      pid: process.pid, startedAt: Date.now() - 4000, finishedAt: Date.now(),
      root: ROOT, platform: process.platform, arch: process.arch,
      node: { path: process.execPath, version: process.version, source: 'bundled', bundled: true, requiredMajor: 18, ok: true },
      serviceManager: { state: 'up', wasRunning: false, started: false, error: null }
    },
    components: {
      static: { required: true, affectsOverall: true, probed: true, healthy: true, state: 'healthy', port: webPort },
      bridge: { required: false, affectsOverall: true, probed: true, healthy: false, state: 'offline', reason: { category: 'offline', message: 'smoke' } },
      active: { required: false, affectsOverall: true, probed: true, healthy: false, state: 'offline', reason: { category: 'offline', message: 'smoke' } },
      restart: { required: false, affectsOverall: false, probed: true, healthy: false, state: 'offline' },
      vision: { required: false, affectsOverall: false, probed: false, healthy: false, state: 'not-enabled' }
    },
    warnings: []
  });
  bootState.writeBootState(st, { dir });
}

(async () => {
  const tmpStateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-guide-smoke-boot-'));
  process.env.IB_BOOT_STATE_DIR = tmpStateDir;
  const webSrv = WEB.createWebServer({ port: 0, root: ROOT });
  const webPort = await new Promise((res, rej) => { webSrv.once('error', rej); webSrv.listen(0, '127.0.0.1', () => res(webSrv.address().port)); });
  const pageUrl = 'http://127.0.0.1:' + webPort + '/InternalBeyond.html';
  writeLaunchRecord(tmpStateDir, webPort);

  let browser = null, cdp = null;
  try {
    browser = await launchBrowser({ width: VIEWPORT.width, height: VIEWPORT.height });
    cdp = await browser.open(pageUrl);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: VIEWPORT.width, height: VIEWPORT.height, deviceScaleFactor: 1, mobile: false });

    const pageErrors = [];
    const consoleErrors = [];
    cdp.on('Runtime.exceptionThrown', p => pageErrors.push(String((p.exceptionDetails && p.exceptionDetails.text) || 'exception')));
    cdp.on('Runtime.consoleAPICalled', p => {
      if (p.type === 'error') consoleErrors.push((p.args || []).map(a => String(a.value !== undefined ? a.value : a.description || '')).join(' '));
    });

    /* ── A. 从欢迎页进入 Guide ── */
    section('A. 进入方式');
    await wait(cdp, "document.readyState!=='loading' && !!document.querySelector('.splash-buttons')", 30000);
    const splashBtn = await ev(cdp, "Array.prototype.map.call(document.querySelectorAll('.splash-action-btn'),b=>b.textContent)");
    check('A1) 欢迎页有「查看说明」按钮', Array.isArray(splashBtn) && splashBtn.indexOf('查看说明') !== -1, splashBtn);
    await ev(cdp, "(function(){var b=Array.prototype.filter.call(document.querySelectorAll('.splash-action-btn'),x=>x.textContent==='查看说明')[0];if(b)b.click();return true;})()");
    await wait(cdp, "!!document.getElementById('app') && document.getElementById('app').classList.contains('visible')", 30000);
    await wait(cdp, "(function(){var s=document.getElementById('splash');if(!s)return true;var cs=getComputedStyle(s);return cs.visibility==='hidden'||Number(cs.opacity)===0;})()", 20000);
    check('A2) 点「查看说明」进入 Guide 页', await wait(cdp, "document.getElementById('page-guide').classList.contains('active')", 15000));
    /* 首启向导会在页面就绪后自动弹出（首次运行的真实行为），跳过它；
       顺带按真实用户路径关掉空库保护提示。两者都可能晚到，所以轮询等到指南真的可见。 */
    async function dismissOverlays() {
      if (await ev(cdp, "!!document.querySelector('#ib-setup.is-open')")) {
        await ev(cdp, "(function(){try{window.IBSetup.skip();}catch(e){}return true;})()");
      }
      if (await ev(cdp, "!!document.getElementById('ib-guard-overlay')")) {
        await ev(cdp, "(function(){var b=Array.prototype.filter.call(document.querySelectorAll('#ib-guard-overlay button'),x=>x.textContent.indexOf('无视')!==-1)[0];if(b)b.click();else document.getElementById('ib-guard-overlay').remove();return true;})()");
      }
    }
    const TITLE_VISIBLE = `(function(){
      var t=document.querySelector('#guide-beginner .gb-title');
      if(!t)return false;
      var r=t.getBoundingClientRect();
      if(r.width<10||r.height<10)return false;
      var top=document.elementFromPoint(r.left+r.width/2, r.top+r.height/2);
      return !!top && (top===t || t.contains(top));
    })()`;
    let titleVisible = false;
    for (let i = 0; i < 60 && !titleVisible; i++) {
      await dismissOverlays();
      titleVisible = await ev(cdp, TITLE_VISIBLE);
      if (!titleVisible) await sleep(400);
    }
    check('A3) 指南模块已挂载', await wait(cdp, "!!window.IBGuide && !!document.getElementById('guide-beginner')", 15000));
    check('A4) 指南标题真实可见、未被遮罩覆盖', titleVisible);

    section('B. 渲染结构');
    const mount = await ev(cdp, `(function(){
      var host=document.getElementById('guide-beginner');
      var page=document.getElementById('page-guide');
      var firstSection=page.querySelector('.guide-section');
      return {
        isFirst: firstSection===host,
        offsetTop: host.getBoundingClientRect().top,
        pageTop: page.getBoundingClientRect().top,
        chapters: document.querySelectorAll('#guide-beginner .gb-chapter').length,
        goals: document.querySelectorAll('#guide-beginner .gb-goal').length,
        steps: document.querySelectorAll('#guide-beginner .gb-steps li').length,
        index: document.querySelectorAll('#guide-beginner .gb-index-link').length,
        figures: document.querySelectorAll('#guide-beginner .gb-figure').length,
        faq: document.querySelectorAll('#guide-beginner .gb-faq-q').length,
        tech: !!document.querySelector('#guide-beginner details.gb-tech'),
        techOpen: !!(document.querySelector('#guide-beginner details.gb-tech')||{}).open,
        actions: document.querySelectorAll('#guide-beginner .gb-action').length,
        version: (document.querySelector('#guide-beginner .gb-meta-version')||{}).textContent||'',
        chaptersArr: window.IBGuide.chapters().length,
        shotsArr: window.IBGuide.shots().length
      };
    })()`);
    check('B1) 指南在 Guide 页最前面', mount && mount.isFirst === true, mount && { isFirst: mount.isFirst });
    check('B2) 渲染出 12 章', mount && mount.chapters === 12, mount && mount.chapters);
    check('B3) 每章都有一句目标', mount && mount.goals === 12, mount && mount.goals);
    check('B4) 章节里有操作步骤', mount && mount.steps >= 40, mount && mount.steps);
    check('B5) 章节目录 12 项', mount && mount.index === 12, mount && mount.index);
    check('B6) 截图数量与清单一致', mount && mount.figures === MANIFEST.shots.length, mount && { figures: mount.figures, want: MANIFEST.shots.length });
    check('B7) 常见问题 10 条', mount && mount.faq >= 10, mount && mount.faq);
    check('B8) 有技术说明折叠区且默认收起', mount && mount.tech === true && mount.techOpen === false, mount && { tech: mount.tech, open: mount.techOpen });
    check('B9) 有深链按钮', mount && mount.actions >= 6, mount && mount.actions);
    check('B10) 版本标识可见', mount && /适用于 InternalBeyond/.test(mount.version) && mount.version.indexOf(MANIFEST.guideVersion) !== -1, mount && mount.version);
    check('B11) 对外接口与清单一致', mount && mount.chaptersArr === 12 && mount.shotsArr === MANIFEST.shots.length, mount && { chapters: mount.chaptersArr, shots: mount.shotsArr });

    const toc = await ev(cdp, `(function(){
      var a=document.querySelector('#guide-toc a[href="#guide-beginner"]');
      if(!a)return {found:false};
      var toc=document.getElementById('guide-toc');
      var before=window.scrollY;
      a.click();
      return {found:true, visible:getComputedStyle(toc).visibility, text:a.textContent, before:before};
    })()`);
    check('B12) 目录里有「零基础使用指南」锚点', toc && toc.found === true && toc.text === '零基础使用指南', toc);
    check('B13) 点目录锚点后指南进入视口', await wait(cdp, "(function(){var r=document.getElementById('guide-beginner').getBoundingClientRect();return r.top<window.innerHeight&&r.bottom>0;})()", 8000));

    /* ── C. 截图真实加载 ── */
    section('C. 截图真实加载');
    /* 图片是 lazy 的：逐张滚进视口，确认它们真的能从本地页面服务解码出来 */
    const shotCount = await ev(cdp, "document.querySelectorAll('#guide-beginner img.gb-shot').length");
    for (let i = 0; i < shotCount; i++) {
      await ev(cdp, `(function(){var f=document.querySelectorAll('#guide-beginner .gb-figure')[${i}];if(f)f.scrollIntoView({block:'center'});return true;})()`);
      await wait(cdp, `(function(){var f=document.querySelectorAll('#guide-beginner .gb-figure')[${i}];var im=f&&f.querySelector('img.gb-shot');return !!im&&im.complete;})()`, 8000);
    }
    await sleep(300);
    const loaded = await ev(cdp, `(function(){
      var imgs=[].slice.call(document.querySelectorAll('#guide-beginner img.gb-shot'));
      return imgs.map(function(i){return {src:i.getAttribute('src'), complete:i.complete, w:i.naturalWidth, h:i.naturalHeight, hidden:i.hidden};});
    })()`);
    check('C1) 页面里有 16 张截图', Array.isArray(loaded) && loaded.length === MANIFEST.shots.length, loaded && loaded.length);
    check('C2) 每张图都真实解码成功（1440x900）', loaded.every(i => i.complete && i.w === VIEWPORT.width && i.h === VIEWPORT.height),
      loaded.filter(i => !(i.complete && i.w === VIEWPORT.width && i.h === VIEWPORT.height)).map(i => i.src + ':' + i.w + 'x' + i.h));
    check('C3) 没有图片落进失败占位', await ev(cdp, "document.querySelectorAll('#guide-beginner .gb-figure.is-missing').length") === 0);
    const httpProbe = await httpJson('http://127.0.0.1:' + webPort + '/docs/guide/shots/' + MANIFEST.shots[0].file);
    check('C4) 截图通过真实 HTTP 提供（200 + PNG）', httpProbe.status === 200 && httpProbe.raw.length > 6000, { status: httpProbe.status, bytes: httpProbe.raw.length });
    check('C5) 每张图都有说明文字', await ev(cdp, "(function(){var f=[].slice.call(document.querySelectorAll('#guide-beginner .gb-figure'));return f.every(function(x){var c=x.querySelector('.gb-caption');return !!c && c.textContent.trim().length>4;});})()"));

    /* ── D. 图片失败回退 ── */
    section('D. 图片失败时正文照旧可读');
    const fallback = await ev(cdp, `(function(){
      var img=document.querySelector('#guide-beginner img.gb-shot');
      img.src='docs/guide/shots/__does_not_exist__.png';
      return true;
    })()`);
    check('D1) 触发了图片加载失败', fallback === true);
    const fallbackState = await wait(cdp, `(function(){
      var fig=document.querySelector('#guide-beginner .gb-figure');
      var miss=fig.querySelector('.gb-shot-missing');
      var img=fig.querySelector('img.gb-shot');
      return !!miss && miss.hidden===false && img.hidden===true && fig.classList.contains('is-missing');
    })()`, 12000);
    check('D2) 失败后显示文字占位、隐藏破图', fallbackState);
    const textStillThere = await ev(cdp, `(function(){
      var ch=document.getElementById('gb-welcome');
      return {steps:ch.querySelectorAll('.gb-steps li').length, goal:(ch.querySelector('.gb-goal')||{}).textContent||''};
    })()`);
    check('D3) 该章步骤与目标仍在', textStillThere && textStillThere.steps >= 1 && textStillThere.goal.length > 4, textStillThere);
    await ev(cdp, "(function(){var i=document.querySelector('#guide-beginner img.gb-shot');i.src='docs/guide/shots/" + MANIFEST.shots[0].file + "';return true;})()");

    /* ── E. 真实渲染文本纪律 ── */
    section('E. 真实渲染文本纪律');
    const guideText = await ev(cdp, "(document.getElementById('guide-beginner').innerText||'')");
    const FORBIDDEN = ['Node.js', 'npm', 'PowerShell', 'localhost', '23115', '23114', '23116', 'WebSocket', 'ws://', 'IndexedDB', 'daemon', '127.0.0.1', '端口'];
    const hits = FORBIDDEN.filter(t => guideText.indexOf(t) !== -1);
    check('E1) 指南正文不含底层术语 / 端口', hits.length === 0, hits);
    check('E2) 指南正文不含裸网址', !/https?:\/\//.test(guideText));
    check('E3) 不要求用户打开终端 / 命令行', !/终端|命令行|cmd\.exe/.test(guideText));
    check('E4) 正文明确「不需要命令窗口 / 开发者工具」', /不需要打开任何命令窗口/.test(guideText));
    check('E5) API Key 安全提示存在', /不要发给别人/.test(guideText) && /截图/.test(guideText));
    check('E6) 诊断路径与 P5 一致', /重新检查/.test(guideText) && /尝试修复/.test(guideText) && /导出诊断报告/.test(guideText));
    check('E7) 正文引用了 P3 文案', /API 密钥无法使用/.test(guideText) && /AI 服务暂时拒绝了请求/.test(guideText));

    /* ── F. 深链与样式隔离 ── */
    section('F. 深链与样式隔离');
    const nav = await ev(cdp, `(function(){
      var btns=[].slice.call(document.querySelectorAll('#guide-beginner .gb-action'));
      var mem=btns.filter(function(b){return b.textContent.indexOf('Memory')!==-1})[0];
      if(!mem)return {ok:false};
      mem.click();
      return {ok:true};
    })()`);
    check('F1) 找到并点击「打开 Memory」深链', nav && nav.ok === true);
    check('F2) 深链跳到真实页面', await wait(cdp, "document.getElementById('page-memory').classList.contains('active')", 12000));
    const leak = await ev(cdp, `(function(){
      var g=document.getElementById('guide-beginner');
      var cs=getComputedStyle(g);
      var chat=document.getElementById('page-chat');
      return {guideVisible: cs.display!=='none', memoryWidth: document.getElementById('page-memory').getBoundingClientRect().width};
    })()`);
    check('F3) 其它页面布局未被指南样式影响', leak && leak.memoryWidth > 200, leak);
    await ev(cdp, "navTo('guide');true");
    check('F4) 可以回到 Guide', await wait(cdp, "document.getElementById('page-guide').classList.contains('active')", 8000));

    /* ── G. 无异常 ── */
    section('G. 运行健康');
    check('G1) 没有未捕获页面异常', pageErrors.length === 0, pageErrors.slice(0, 3));
    const guideConsoleErrors = consoleErrors.filter(t => !/favicon|404|Failed to load resource/i.test(t));
    check('G2) 没有控制台错误（忽略 favicon/资源 404 噪音）', guideConsoleErrors.length === 0, guideConsoleErrors.slice(0, 3));

    console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
  } catch (e) {
    fail++;
    console.error('  ✗ smoke 异常：' + String(e && e.stack || e));
    console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
  } finally {
    try { if (cdp) cdp.close(); } catch (e) { }
    try { if (browser) await browser.close(); } catch (e) { }
    try { await new Promise(r => { const t = setTimeout(r, 1500); webSrv.close(() => { clearTimeout(t); r(); }); }); } catch (e) { }
    try { fs.rmSync(tmpStateDir, { recursive: true, force: true }); } catch (e) { }
  }
  process.exitCode = fail ? 1 : 0;
})();
