'use strict';
/* Internal Beyond — U4 更新卡片最小浏览器 smoke（真实 Chrome/Edge + 真实静态服务）
   运行：node test_update_card_smoke.js

   覆盖（全部走真实页面、真实端点、真实状态文件；不安装任何东西）：
     A. 卡片真的出现在诊断页里（当前版本 / 更新通道 / 自动检查 / 检查更新）
     B. 自动检查命中真实 24h 缓存 → 发现新版本；远端 notes 以纯文本渲染（注入不执行）
     C. [下载并安装] 只提交 { version }（在页面里替换 fetch 拦截，绝不碰真实安装器）
     D. 真实进度：状态文件里的字节数 → 人类可读 MB 与真实比例
     E. 进入安装阶段后停止显示百分比；**服务被停掉不误报失败**
     F. 环境没有被污染：没有载荷文件、状态文件没有被真实 helper 改写

   预算：不下载、不安装、不打开系统浏览器（headless）；只监听一个随机回环端口；
   IB_UPDATE_DIR 与 IB_BOOT_STATE_DIR 全部指向临时目录，绝不碰 %LOCALAPPDATA%。 */

const fs = require('fs');
const os = require('os');
const path = require('path');

/* Repository root — this file lives in tests/, so the root is one level up. */
const ROOT = path.resolve(__dirname, '..');

/* 环境必须在 require 更新运行时之前就位（两个目录都不许落到真实用户目录）。 */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-u4-smoke-'));
const UPDATE_HOME = path.join(TMP, 'IBHome');
const STATE_DIR = path.join(TMP, 'boot');
fs.mkdirSync(path.join(UPDATE_HOME, 'updates'), { recursive: true });
fs.mkdirSync(STATE_DIR, { recursive: true });
process.env.IB_UPDATE_DIR = UPDATE_HOME;
process.env.IB_BOOT_STATE_DIR = STATE_DIR;

const WEB = require(path.join(ROOT, 'services', 'internal-beyond-server.js'));
const bootState = require(path.join(ROOT, 'runtime', 'boot-state.js'));
const um = require(path.join(ROOT, 'runtime', 'update-manifest.js'));
const uc = require(path.join(ROOT, 'runtime', 'update-check.js'));
const ui = require(path.join(ROOT, 'runtime', 'update-install.js'));
const { ev, wait, sleep, launchBrowser } = require(path.join(ROOT, 'scripts', 'cdp-lite.js'));

const CURRENT = fs.readFileSync(path.join(ROOT, 'VERSION'), 'utf8').trim();
const TARGET = '1.9.9';
const TOTAL_BYTES = 52638515;              /* 50.2 MB */
const HALF_BYTES = 13631488;               /* 13.0 MB → 26% */
const NOTES = '修复了若干问题。\n<img src=x onerror="window.__ibXss=1">';

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.error('  ✗ ' + name + (detail !== undefined ? ' — ' + JSON.stringify(detail) : '')); }
}
function section(t) { console.log('\n── ' + t + ' ──'); }

function writeLaunchRecord(webPort) {
  const st = bootState.buildBootState({
    bootId: bootState.newBootId(Date.now()),
    now: Date.now(),
    phase: 'complete',
    opened: true,
    launcher: {
      pid: process.pid, startedAt: Date.now() - 4000, finishedAt: Date.now(),
      root: ROOT, platform: process.platform, arch: process.arch,
      product: { version: CURRENT },
      node: { path: process.execPath, version: process.version, source: 'bundled', bundled: true, requiredMajor: 18, ok: true },
      serviceManager: { state: 'up', wasRunning: false, started: false, error: null }
    },
    components: {
      static: { required: true, affectsOverall: true, probed: true, healthy: true, state: 'healthy', port: webPort },
      bridge: { required: false, affectsOverall: true, probed: true, healthy: false, state: 'offline' },
      active: { required: false, affectsOverall: true, probed: true, healthy: false, state: 'offline' },
      restart: { required: false, affectsOverall: false, probed: true, healthy: false, state: 'offline' },
      vision: { required: false, affectsOverall: false, probed: false, healthy: false, state: 'not-enabled' }
    },
    warnings: []
  });
  bootState.writeBootState(st, { dir: STATE_DIR });
}

/* 真实缓存文件：自动检查（不带 force）会命中它，因此整个 smoke 不需要联网。 */
function seedCache() {
  const manifest = um.build({
    version: TARGET, sha256: 'c'.repeat(64), sizeBytes: TOTAL_BYTES,
    productVersion: TARGET, releasedAt: '2026-09-10T06:00:00Z', notes: NOTES
  });
  const verdict = um.validate(manifest);
  if (!verdict.ok) throw new Error('smoke fixture manifest is invalid: ' + verdict.why);
  const file = path.join(UPDATE_HOME, 'update-check.json');
  fs.writeFileSync(file, JSON.stringify({
    schema: uc.CACHE_SCHEMA, schemaVersion: uc.CACHE_SCHEMA_VERSION,
    channel: um.CHANNEL_STABLE, checkedAt: new Date().toISOString(),
    transport: 'direct', manifest: manifest
  }, null, 2) + '\n', 'utf8');
  return file;
}

/* 状态文件用 U3 自己的写入口（和 helper 完全同一条路径），pid 用本测试进程
   ——这样后端的 active 判定（pid 还活着 + 状态还在动）就是真的。 */
function writeInstallState(patch) {
  const r = ui.writeState(Object.assign({ pid: process.pid }, patch), {});
  if (!r.ok) throw new Error('could not write install state: ' + r.why);
  return r.file;
}

const stateFilePath = () => path.join(UPDATE_HOME, 'updates', 'update-install-state.json');
const cardText = "document.getElementById('ib-update-card').textContent";
const phaseExpr = "document.getElementById('ib-update-state').dataset.state";
const shown = (id) => "getComputedStyle(document.getElementById('" + id + "')).display !== 'none'";

(async () => {
  seedCache();
  const webSrv = WEB.createWebServer({ port: 0, root: ROOT });
  const webPort = await new Promise((res, rej) => { webSrv.once('error', rej); webSrv.listen(0, '127.0.0.1', () => res(webSrv.address().port)); });
  writeLaunchRecord(webPort);
  const pageUrl = 'http://127.0.0.1:' + webPort + '/InternalBeyond.html#diagnostics';

  let browser = null, cdp = null;
  const moduleErrors = [];
  try {
    browser = await launchBrowser({ width: 1200, height: 900 });
    cdp = await browser.open(pageUrl);
    cdp.on('Runtime.exceptionThrown', p => {
      const d = p.exceptionDetails || {};
      const text = String(d.text || '') + ' ' + String((d.exception && (d.exception.description || d.exception.value)) || '');
      if (text.indexOf('update-card') >= 0) moduleErrors.push(text);
    });

    section('A. 卡片真的在诊断页里');
    check('A1) 页面就绪', await wait(cdp, "document.readyState!=='loading'", 30000));
    check('A2) 更新卡片已挂载到诊断页', await wait(cdp, "!!document.getElementById('ib-update-card') && !!document.getElementById('page-diagnostics').contains(document.getElementById('ib-update-card'))", 20000));
    const ids = await ev(cdp, "['ib-update-current','ib-update-channel','ib-update-auto','ib-update-auto-text','ib-update-state','ib-update-status','ib-update-check','ib-update-later','ib-update-install','ib-update-retry','ib-update-notes','ib-update-progress'].every(function(i){return !!document.getElementById(i);})");
    check('A3) 结构 id 齐全', ids === true, ids);
    check('A4) 当前版本是真实版本号', (await ev(cdp, "document.getElementById('ib-update-current').textContent")) === CURRENT, await ev(cdp, "document.getElementById('ib-update-current').textContent"));
    check('A5) 更新通道显示 Stable', (await ev(cdp, "document.getElementById('ib-update-channel').textContent")) === 'Stable');
    check('A6) 自动检查开关默认开', (await ev(cdp, "document.getElementById('ib-update-auto').checked")) === true);
    check('A7) 样式表已注入（HTML 未新增 link）', (await ev(cdp, "!!document.getElementById('ib-update-style')")) === true);

    section('B. 自动检查（命中真实缓存，不联网）→ 发现新版本');
    check('B1) 进入 available', await wait(cdp, phaseExpr + "==='available'", 20000), await ev(cdp, phaseExpr));
    check('B2) 文案带目标版本', (await ev(cdp, "document.getElementById('ib-update-status').textContent")) === ('发现新版本 ' + TARGET), await ev(cdp, "document.getElementById('ib-update-status').textContent"));
    const notesText = await ev(cdp, "document.getElementById('ib-update-notes').textContent");
    check('B3) notes 原文可见（换行与尖括号都在）', notesText === NOTES, notesText);
    check('B4) notes 没有生成任何子元素（注入不执行）', (await ev(cdp, "document.getElementById('ib-update-notes').children.length")) === 0);
    check('B5) 页面没有执行 notes 里的脚本', (await ev(cdp, "typeof window.__ibXss")) === 'undefined');
    check('B6) [稍后] 与 [下载并安装] 可见', (await ev(cdp, shown('ib-update-later'))) === true && (await ev(cdp, shown('ib-update-install'))) === true);
    check('B7) 展示真实安装包大小', /安装包约 50\.2 MB/.test(await ev(cdp, "document.getElementById('ib-update-sub-status').textContent")), await ev(cdp, "document.getElementById('ib-update-sub-status').textContent"));

    section('C. 只提交 { version }（页面内拦截，不碰真实安装器）');
    await ev(cdp, `(function(){
      window.__ibPost = null;
      var orig = window.fetch;
      window.fetch = function(url, init){
        if (String(url).indexOf('/__update/start') === 0) {
          var body = String((init && init.body) || '');
          var keys = null; try { keys = Object.keys(JSON.parse(body)); } catch (e) { keys = null; }
          window.__ibPost = { url: String(url), method: String((init && init.method) || ''), body: body, keys: keys };
          return Promise.resolve({ ok: true, status: 202, text: function(){ return Promise.resolve(JSON.stringify({ ok: true, accepted: true, version: '${TARGET}', state: 'starting' })); } });
        }
        return orig.apply(window, arguments);
      };
      return true;
    })()`);
    await ev(cdp, "document.getElementById('ib-update-install').click(); true");
    check('C1) 发出了安装请求', await wait(cdp, "!!window.__ibPost", 10000));
    const post = await ev(cdp, "window.__ibPost");
    check('C2) 请求目标是既有端点 /__update/start', post && post.url === '/__update/start', post && post.url);
    check('C3) 方法是 POST', post && post.method === 'POST', post && post.method);
    check('C4) 请求体只有 version 一个字段', post && JSON.stringify(post.keys) === '["version"]', post && post.keys);
    check('C5) 请求体不含 url/hash/path/asset/command', post && ['url', 'hash', 'path', 'asset', 'command'].every(w => post.body.toLowerCase().indexOf(w) < 0), post && post.body);
    check('C6) 提交的版本是后端检查结果里的版本', post && JSON.parse(post.body).version === TARGET);
    check('C7) 点完之后进入准备阶段（还没拿到真实字节就不给数字）', await wait(cdp, phaseExpr + "==='downloading'", 10000), await ev(cdp, phaseExpr));
    check('C8) 准备阶段不显示进度条', (await ev(cdp, shown('ib-update-progress'))) === false);

    section('D. 真实进度（读真实状态文件）');
    writeInstallState({ state: 'downloading', version: TARGET, bytes: HALF_BYTES, totalBytes: TOTAL_BYTES, startedAt: new Date().toISOString() });
    check('D1) 出现真实字节数', await wait(cdp, "document.getElementById('ib-update-bytes').textContent.indexOf('MB')>0", 15000), await ev(cdp, "document.getElementById('ib-update-bytes').textContent"));
    const bytesText = await ev(cdp, "document.getElementById('ib-update-bytes').textContent");
    check('D2) 字节换算成人类可读 MB 与真实比例', bytesText === '13.0 MB / 50.2 MB · 26%', bytesText);
    const width = await ev(cdp, "document.getElementById('ib-update-bar-fill').style.width");
    check('D3) 进度条宽度就是真实比例', width === '26%', width);
    check('D4) 文案是「正在下载更新…」', (await ev(cdp, "document.getElementById('ib-update-status').textContent")) === '正在下载更新…');
    writeInstallState({ state: 'downloading', version: TARGET, bytes: TOTAL_BYTES, totalBytes: TOTAL_BYTES });
    check('D5) 字节到齐 → 正在验证更新文件…', await wait(cdp, "document.getElementById('ib-update-status').textContent==='正在验证更新文件…'", 15000), await ev(cdp, "document.getElementById('ib-update-status').textContent"));

    section('E. 安装阶段：固定说明、无百分比、服务消失不误报');
    writeInstallState({ state: 'launching', version: TARGET, bytes: TOTAL_BYTES, totalBytes: TOTAL_BYTES });
    check('E1) 进入安装阶段', await wait(cdp, phaseExpr + "==='installing'", 15000), await ev(cdp, phaseExpr));
    check('E2) 安装说明是固定文案', (await ev(cdp, "document.getElementById('ib-update-status').textContent")) === '正在安装更新。InternalBeyond 会暂时关闭，并在完成后自动重新打开。');
    check('E3) 安装阶段不再显示百分比', (await ev(cdp, shown('ib-update-progress'))) === false && (await ev(cdp, "document.getElementById('ib-update-bytes').textContent")) === '');
    check('E4) 安装阶段不显示任何动作按钮', (await ev(cdp, shown('ib-update-install'))) === false && (await ev(cdp, shown('ib-update-later'))) === false && (await ev(cdp, shown('ib-update-retry'))) === false);
    /* 安装器就是这样正常停止 IB 的：服务消失不能变成「更新失败」 */
    await new Promise(res => { try { webSrv.closeAllConnections(); } catch (e) { } webSrv.close(() => res()); });
    await sleep(4000);
    const afterDown = {
      phase: await ev(cdp, phaseExpr),
      text: await ev(cdp, "document.getElementById('ib-update-status').textContent"),
      retry: await ev(cdp, shown('ib-update-retry')),
      card: await ev(cdp, cardText)
    };
    check('E5) 服务停掉之后仍然是安装中', afterDown.phase === 'installing', afterDown.phase);
    check('E6) 仍然是同一句安装说明（没有变成失败）', afterDown.text === '正在安装更新。InternalBeyond 会暂时关闭，并在完成后自动重新打开。', afterDown.text);
    check('E7) 没有出现重试按钮', afterDown.retry === false);
    check('E8) 卡片上没有「更新失败」这类误报', afterDown.card.indexOf('更新失败') < 0);

    section('F. 没有污染环境');
    const payloads = fs.readdirSync(path.join(UPDATE_HOME, 'updates')).filter(n => /\.(exe|part)$/i.test(n));
    check('F1) 没有下载任何载荷（没跑真实安装器）', payloads.length === 0, payloads);
    const stateOnDisk = JSON.parse(fs.readFileSync(stateFilePath(), 'utf8'));
    check('F2) 状态文件仍然是我们写的那一份（没有 helper 接手）', stateOnDisk.state === 'launching' && stateOnDisk.pid === process.pid, stateOnDisk.state);
    check('F3) 没有未捕获的模块异常', moduleErrors.length === 0, moduleErrors);
  } finally {
    if (browser) await browser.close();
    try { webSrv.closeAllConnections(); } catch (e) { }
    try { webSrv.close(); } catch (e) { }
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { }
  }

  console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})().catch(e => {
  console.error('smoke 失败: ' + ((e && e.stack) || e));
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (err) { }
  process.exit(1);
});
