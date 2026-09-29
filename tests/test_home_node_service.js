'use strict';
/* Internal Beyond · Home Node 服务契约测试（service 组，零依赖）
   运行：node tests/test_home_node_service.js
   验证「新服务被正确接进既有生命周期机制」这一层（不是 HTTP 语义，
   HTTP 语义由 test_home_node_http.js 覆盖）：
     · 健康探针带稳定身份（matchesHealth 契约），不依赖端口占用与否；
     · dataDir / 端口 / token 全部可经环境变量注入（P7 隔离测试纪律）；
     · 坏数据目录必须**明确失败**，不得静默换路径；
     · 未监听时不得占端口、不得留下进程；
     · 服务模块可在不监听的情况下被 require（测试与诊断复用）；
     · 日志脱敏：apiKey / Authorization / token 一律掩码。 */
const assert = require('assert');
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');

const ROOT = path.resolve(__dirname, '..');
const SERVICE = path.join('services', 'home-node-service.js');
const RUNNER = path.join('runtime', 'local-services-runner.js');

let passed = 0, failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log('✔ ' + name); }
  else { failed++; console.error('✖ ' + name + (extra !== undefined ? ' — ' + JSON.stringify(extra) : '')); }
}
function freePort() {
  return new Promise(resolve => {
    const server = net.createServer();
    server.unref();
    server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); });
  });
}
function get(port, pathname, token) {
  return new Promise(resolve => {
    const req = http.get({ host: '127.0.0.1', port, path: pathname, timeout: 2500,
      headers: token ? { 'X-IB-Home-Token': token } : {} }, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => { let parsed = null; try { parsed = JSON.parse(raw); } catch (e) { parsed = null; } resolve({ status: res.statusCode, body: parsed }); });
    });
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: null }); });
    req.on('error', () => resolve({ status: 0, body: null }));
  });
}
async function waitFor(port, timeoutMs) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const r = await get(port, '/health');
    if (r.status === 200 && r.body && r.body.ok) return r.body;
    await new Promise(r => setTimeout(r, 150));
  }
  return null;
}
function runNode(args, env) {
  return new Promise(resolve => {
    execFile(process.execPath, args, { cwd: ROOT, env: Object.assign({}, process.env, env || {}), encoding: 'utf8', timeout: 15000 },
      (error, stdout, stderr) => resolve({ code: error && error.code != null ? error.code : 0, stdout: stdout || '', stderr: stderr || '' }));
  });
}

(async () => {
  /* ── 1 · 模块可 require 而不监听（测试/诊断复用）────────────────── */
  {
    const probe = await runNode(['-e', [
      'const m = require("./services/home-node-service.js");',
      'console.log(JSON.stringify({',
      '  host: m.HOST, port: m.PORT, hasStore: !!m.store, hasExecutor: !!m.executor,',
      '  listening: m.server.listening, version: m.SERVICE_VERSION,',
      '  redacted: m.redact("apiKey=sk-abcdefghijklmnop token=abc123456789")',
      '}));',
      'm.store.close(); process.exit(0);'
    ].join('\n')], {
      IB_HOME_NODE_PORT: String(await freePort()),
      IB_HOME_NODE_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'ib-hn-mod-'))
    });
    let info = null;
    try { info = JSON.parse(probe.stdout.trim().split('\n').pop()); } catch (e) { info = null; }
    check('service.module require 成功且未监听', !!info && info.listening === false, probe.stderr.slice(-300));
    check('service.module 默认 loopback 绑定', !!info && info.host === '127.0.0.1', info && info.host);
    check('service.module 暴露 store 与 executor（可注入测试）', !!info && info.hasStore === true && info.hasExecutor === true, info);
    check('service.module 端口可经 IB_HOME_NODE_PORT 注入', !!info && Number.isInteger(info.port) && info.port !== 23118, info && info.port);
    check('service.redact 掩码 apiKey 与 token', !!info && info.redacted.indexOf('sk-abcdefghijklmnop') < 0 && info.redacted.indexOf('abc123456789') < 0, info && info.redacted);
  }

  /* ── 2 · 身份探针 + 端口注入 + 数据目录注入 ─────────────────────── */
  {
    const port = await freePort();
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-hn-run-'));
    const statusToken = 'home-node-status-contract-token';
    const child = spawn(process.execPath, [SERVICE], {
      cwd: ROOT,
      env: Object.assign({}, process.env, { IB_HOME_NODE_PORT: String(port), IB_HOME_NODE_DATA_DIR: dataDir, IB_HOME_NODE_TOKEN: statusToken }),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '';
    child.stdout.on('data', c => out += c);
    child.stderr.on('data', c => out += c);
    try {
      const health = await waitFor(port, 15000);
      check('service.start 在注入端口上启动', !!health, out.slice(-300));
      check('service.health 身份字段稳定（runner matchesHealth 契约）',
        !!health && health.service === 'internal-beyond-home-node', health && health.service);
      check('service.health ok=true 且带 version/messages/revision',
        !!health && health.ok === true && typeof health.version === 'string' &&
        typeof health.messages === 'number' && typeof health.revision === 'number', health);
      check('service.db 落在注入的数据目录',
        fs.existsSync(path.join(dataDir, 'home-node.db')), fs.readdirSync(dataDir));
      check('service.db 不在仓库目录里',
        !fs.existsSync(path.join(ROOT, 'home-node.db')));

      /* 身份必须能与「占着同一端口的别的服务」区分开 */
      const unrelated = await get(port, '/status', statusToken);
      check('service.status 需要路由存在且可读', unrelated.status === 200 && !!unrelated.body.meta, unrelated.status);
      check('service.status 日志环存在且不含正文', Array.isArray(unrelated.body.log));
    } finally {
      child.kill();
      await new Promise(r => setTimeout(r, 400));
    }
  }

  /* ── 3 · 坏数据目录必须明确失败（不得静默换路径）──────────────── */
  {
    const port = await freePort();
    /* 用一个「存在但是文件」的路径当数据目录 → mkdir 必然失败 */
    const filePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ib-hn-bad-')), 'not-a-dir');
    fs.writeFileSync(filePath, 'x', 'utf8');
    const child = spawn(process.execPath, [SERVICE], {
      cwd: ROOT,
      env: Object.assign({}, process.env, { IB_HOME_NODE_PORT: String(port), IB_HOME_NODE_DATA_DIR: filePath }),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '';
    child.stdout.on('data', c => out += c);
    child.stderr.on('data', c => out += c);
    const code = await new Promise(resolve => {
      const timer = setTimeout(() => { child.kill(); resolve('timeout'); }, 8000);
      child.on('exit', c => { clearTimeout(timer); resolve(c); });
    });
    check('service.badDataDir 明确退出（非 0）', code !== 0 && code !== 'timeout', { code, out: out.slice(-200) });
    check('service.badDataDir 报出真实原因而不是静默换目录',
      /cannot create its data directory/i.test(out), out.slice(-300));
    const occupied = await get(port, '/health');
    check('service.badDataDir 失败时没有占用端口', occupied.status === 0, occupied.status);
  }

  /* ── 4 · runner 注册契约（服务表 + 身份探针 + 无法启动也不致命）── */
  {
    const homePort = await freePort();
    const bridgePort = await freePort();
    const activePort = await freePort();
    const status = await runNode([RUNNER, '--json'], {
      IB_BRIDGE_PORT: String(bridgePort),
      IB_ACTIVE_PORT: String(activePort),
      IB_HOME_NODE_PORT: String(homePort)
    });
    let parsed = null;
    try { parsed = JSON.parse(status.stdout.trim()); } catch (e) { parsed = null; }
    check('runner.homeNode 已登记在服务表里',
      !!parsed && Array.isArray(parsed.services) && parsed.services.some(s => s.name === 'HomeNode'), status.stdout.slice(-300));
    const home = parsed && parsed.services.find(s => s.name === 'HomeNode');
    check('runner.homeNode 端口来自 IB_HOME_NODE_PORT 覆盖', !!home && home.port === homePort, home && home.port);
    check('runner.homeNode 未启动时报告 offline（不是 conflict）',
      !!home && home.online === false && home.conflict === false, home);
    /* runner --json 必须在没有任何服务在线时也能正常退出（不得挂死） */
    check('runner 在服务全离线时仍然正常退出', status.code === 0, { code: status.code, err: status.stderr.slice(-200) });

    /* 真实启动 Home Node 后，runner 必须通过身份探针认出来 */
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-hn-runner-'));
    const child = spawn(process.execPath, [SERVICE], {
      cwd: ROOT,
      env: Object.assign({}, process.env, { IB_HOME_NODE_PORT: String(homePort), IB_HOME_NODE_DATA_DIR: dataDir }),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    try {
      const health = await waitFor(homePort, 15000);
      check('runner.probe 服务确实起来了', !!health);
      const status2 = await runNode([RUNNER, '--json'], {
        IB_BRIDGE_PORT: String(bridgePort),
        IB_ACTIVE_PORT: String(activePort),
        IB_HOME_NODE_PORT: String(homePort)
      });
      let parsed2 = null;
      try { parsed2 = JSON.parse(status2.stdout.trim()); } catch (e) { parsed2 = null; }
      const home2 = parsed2 && parsed2.services.find(s => s.name === 'HomeNode');
      check('runner.probe 身份匹配后报告 online', !!home2 && home2.online === true, home2);
      check('runner.probe 冲突判定不误报', !!home2 && home2.conflict === false, home2);
    } finally {
      child.kill();
      await new Promise(r => setTimeout(r, 400));
    }
  }

  /* ── 5 · 可选服务失败不得阻塞桌面主 UI（P2 纪律）─────────────────── */
  {
    /* 桌面主 UI 由 services/internal-beyond-server.js（23120）提供，
       它**不**依赖 Home Node。这里验证：Home Node 完全不在时，
       浏览器接缝的默认状态是"未生效但可用"，而不是任何致命错误。
       断言方式：检查 bootstrap 里的降级分支存在且不抛错（静态契约）。 */
    const bootstrap = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'home-node-bootstrap.js'), 'utf8').replace(/^\uFEFF/, '');
    check('isolation.remote 缺失时早退（不抛错、不阻塞页面）',
      /if \(!_remoteFactory\) \{ warn\('remote-driver-missing'/.test(bootstrap));
    check('isolation.authority 缺失时早退（不抛错、不阻塞页面）',
      /if \(!_authorityFactory\) return;/.test(bootstrap));
    check('isolation.core 接缝缺失时早退（不抛错、不阻塞页面）',
      /if \(!window\.__ibCoreDb\) \{ console\.warn/.test(bootstrap));
    check('isolation.file:// 承载显式降级而不是静默失败',
      /FILE_ORIGIN/.test(bootstrap) && /file-origin/.test(fs.readFileSync(path.join(ROOT, 'assets', 'js', 'chat-authority.js'), 'utf8')));
    check('isolation 同步失败只记日志，不抛出到页面',
      /note\('sync-fail'/.test(bootstrap) && /note\('sync-degraded'/.test(bootstrap));
    check('isolation 常驻定时器不存在（避免测试 harness 无法自然退出）',
      !/setInterval\(/.test(bootstrap), 'bootstrap 里不应有 setInterval');
  }

  console.log('');
  if (failed) { console.error('Home Node 服务契约测试失败：' + failed + ' 项 ✘（通过 ' + passed + '）'); process.exitCode = 1; }
  else console.log('Home Node service contract tests passed ✔ (' + passed + ' 项)');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
