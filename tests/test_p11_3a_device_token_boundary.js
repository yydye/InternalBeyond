'use strict';
/* ====================================================================
   Internal Beyond · P11-3A 凭据铸造面边界（Device Token Boundary）
   运行：node tests/test_p11_3a_device_token_boundary.js

   这一份要证的不是"gate 存在"，而是"gate 是承重的"：
     A · 契约：未配置 token 时，凭据铸造面在 loopback 上也一律 403
         desktop-token-required；错误 token 401；正确 token 放行。
     B · 回归：未配置 token 时**读取类**路径仍然匿名可用（既有 D1 风险接受，
        本阶段刻意不动），且 /security 如实报告残余暴露。
     C · 失败用例：pairing 全生命周期（create → complete → 用 device token
         访问设备面 → revoke → 立即失效）。
     D · **变异测试**：把 gate 在**临时副本**里短路，同一请求必须变成 200。
         原仓库文件全程只读 —— 变异只发生在 %TEMP% 的副本里。

   为什么必须用真实进程 + 真实 HTTP：这条边界此前之所以漏掉，正是因为
   测试都在 buildHomeNode() 里跑，而生产入口是另一个装配路径。
   ==================================================================== */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const HTTP_JS = path.join('services', 'home-node', 'http.js');

let passed = 0, failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log('OK   ' + name); }
  else { failed++; console.error('FAIL ' + name + (extra !== undefined ? ' — ' + JSON.stringify(extra) : '')); }
}

const liveChildren = new Set();

function request(port, method, urlPath, options) {
  options = options || {};
  return new Promise(resolve => {
    const data = options.body == null ? null : JSON.stringify(options.body);
    const headers = Object.assign({}, options.headers || {});
    if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method, timeout: 8000, headers }, res => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', c => raw += c);
      res.on('end', () => {
        let parsed = null;
        try { parsed = raw ? JSON.parse(raw) : {}; } catch (_) { parsed = { raw: raw }; }
        resolve({ status: res.statusCode, body: parsed, raw: raw });
      });
      res.on('error', e => resolve({ status: 0, error: e.message }));
    });
    req.on('timeout', () => { try { req.destroy(); } catch (_) {} resolve({ status: 0, error: 'timeout' }); });
    req.on('error', e => resolve({ status: 0, error: e.code || e.message }));
    if (data) req.write(data);
    req.end();
  });
}

function freePort() {
  return new Promise(resolve => {
    const s = net.createServer();
    s.unref();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

/* cwd 决定服务脚本从哪个仓库副本加载 —— 变异测试就是靠这一点把副本隔离开的。 */
function spawnService(cwd, env) {
  const child = spawn(process.execPath, [path.join('services', 'home-node-service.js')], {
    cwd: cwd,
    env: Object.assign({}, process.env, env),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const st = { out: '', child: child, exited: false };
  child.stdout.on('data', c => st.out += c);
  child.stderr.on('data', c => st.out += c);
  st.done = new Promise(res => child.on('exit', () => { st.exited = true; liveChildren.delete(st); res(); }));
  st.stop = () => { try { child.kill(); } catch (_) { /* 已退出 */ } };
  liveChildren.add(st);
  return st;
}

async function waitForHealth(port, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const r = await request(port, 'GET', '/health');
    if (r.status === 200 && r.body && r.body.ok) return r.body;
    await new Promise(r2 => setTimeout(r2, 200));
  }
  return null;
}

async function stopService(st) {
  st.stop();
  await Promise.race([st.done, new Promise(r => setTimeout(r, 3000))]);
}
function dropDir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* Windows 句柄 */ }
}

/* 需要被 gate 的路径（凭据铸造 / 撤销 / 改变设备可见目录）。 */
const GATED = [
  { name: 'POST /pairing/session', method: 'POST', path: '/pairing/session', body: { deviceName: 'X', deviceType: 'android' } },
  { name: 'GET /devices', method: 'GET', path: '/devices' },
  { name: 'POST /device/revoke', method: 'POST', path: '/device/revoke', body: { deviceId: 'dev_none' } },
  { name: 'POST /characters/publish', method: 'POST', path: '/characters/publish', body: { characters: [{ id: 'x', name: 'x' }] } },
  { name: 'POST /mobile/v1/pairing/complete', method: 'POST', path: '/mobile/v1/pairing/complete', body: { v: 1, payload: { pairingId: 'pair_x', secret: 'y' } } }
];

/* 有意**不**被 gate 的路径：读取类，loopback 匿名可用（既有风险接受）。 */
const READ_PATHS = [
  { name: 'GET /status', path: '/status' },
  { name: 'GET /security', path: '/security' },
  { name: 'GET /list', path: '/list' }
];

(async () => {
  /* ══ A/B/C · 未配置 token 的安装（默认形态）══════════════════════════ */
  const noTokenDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-p113a-notoken-'));
  const noTokenPort = await freePort();
  const noTokenSvc = spawnService(ROOT, {
    IB_HOME_NODE_PORT: String(noTokenPort),
    IB_HOME_NODE_DATA_DIR: noTokenDir
  });
  try {
    const health = await waitForHealth(noTokenPort, 15000);
    check('A0 未配置 token 的安装照常启动并回答 loopback 探针', !!(health && health.ok === true), noTokenSvc.out.slice(-300));
    check('A0 启动日志如实说明凭据铸造面是关的（用户不必对着 403 猜）',
      /"credentialMinting":"disabled/.test(noTokenSvc.out), noTokenSvc.out.slice(-500));

    /* ── A · 门关着 ── */
    for (const g of GATED) {
      const r = await request(noTokenPort, g.method, g.path, { body: g.body });
      check('A1 无 token → ' + g.name + ' 被拒 403 desktop-token-required',
        r.status === 403 && r.body && r.body.error === 'desktop-token-required',
        { status: r.status, body: r.body });
    }
    /* 关键：拒绝必须给出可执行的下一步，且**不得**泄露 secret / device 数据。 */
    const gatedRes = await request(noTokenPort, 'POST', '/pairing/session', { body: { deviceName: 'X' } });
    check('A2 拒绝响应给出可执行的下一步（hint 指向 IB_HOME_NODE_TOKEN）',
      !!(gatedRes.body && /IB_HOME_NODE_TOKEN/.test(String(gatedRes.body.hint || ''))), gatedRes.body);
    check('A2 拒绝响应里**不含** pairingId / secret / token（拒绝不等于"带着一半数据失败"）',
      !/pairingId|secret|"token"/.test(gatedRes.raw), gatedRes.raw.slice(0, 240));

    /* 拒绝必须留痕：否则"为什么配对用不了"在生产里无法被审计。 */
    const status = await request(noTokenPort, 'GET', '/status');
    const log = (status.body && status.body.log) || [];
    const hasRecord = log.some(e => e && e.event === 'rejected-credential-minting');
    check('A3 拒绝写入可观测日志（event=rejected-credential-minting）', hasRecord,
      log.filter(e => e && /reject/.test(String(e.event))).slice(-3));

    /* ── B · 读取类有意保持可用，且 /security 如实报告 ── */
    for (const r0 of READ_PATHS) {
      const r = await request(noTokenPort, 'GET', r0.path);
      check('B1（如实记录残留暴露）无 token → ' + r0.name + ' 仍匿名可用',
        r.status === 200, { status: r.status, path: r0.path });
    }
    const sec = await request(noTokenPort, 'GET', '/security');
    check('B2 /security 报告凭据铸造面已关闭', !!(sec.body && sec.body.credentialMintingPaths && sec.body.credentialMintingPaths.enabled === false), sec.body && sec.body.credentialMintingPaths);
    check('B2 /security 列出未配置 token 时仍匿名可读的路径（残余暴露可审计）',
      !!(sec.body && Array.isArray(sec.body.loopbackReadableWithoutToken) && sec.body.loopbackReadableWithoutToken.length > 0),
      sec.body && sec.body.loopbackReadableWithoutToken);
    check('B2 /security 报告的凭据铸造路径与真实被拒的路径集合一致',
      !!(sec.body && sec.body.credentialMintingPaths &&
        GATED.every(g => sec.body.credentialMintingPaths.paths.indexOf(g.path) >= 0)),
      { reported: sec.body && sec.body.credentialMintingPaths && sec.body.credentialMintingPaths.paths, tested: GATED.map(g => g.path) });
  } catch (error) {
    failed++;
    console.error('FAIL A/B 段异常终止 — ' + String((error && error.stack) || error));
  } finally {
    await stopService(noTokenSvc);
    dropDir(noTokenDir);
  }

  /* ══ C · 配置了 token 的安装：全生命周期 ═══════════════════════════ */
  const tokDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-p113a-token-'));
  const tokPort = await freePort();
  const ADMIN = 'p11-3a-admin-token-9f3c';
  const tokSvc = spawnService(ROOT, {
    IB_HOME_NODE_PORT: String(tokPort),
    IB_HOME_NODE_DATA_DIR: tokDir,
    IB_HOME_NODE_TOKEN: ADMIN
  });
  const auth = { 'X-IB-Home-Token': ADMIN };
  try {
    const health = await waitForHealth(tokPort, 15000);
    check('C0 配置 token 的安装照常启动', !!(health && health.ok === true), tokSvc.out.slice(-300));
    check('C0 启动日志如实说明凭据铸造面已启用',
      /"credentialMinting":"enabled/.test(tokSvc.out), tokSvc.out.slice(-500));

    /* 无 token / 错误 token → 仍然被拒（配置了就"没有豁免路径"）。 */
    const noTok = await request(tokPort, 'POST', '/pairing/session', { body: { deviceName: 'X' } });
    check('C1 已配置 token 时，不带 token → 401（不是 403，也不是放行）',
      noTok.status === 401 && noTok.body.error === 'unauthenticated', { status: noTok.status, body: noTok.body });
    const wrongTok = await request(tokPort, 'POST', '/pairing/session', { headers: { 'X-IB-Home-Token': 'wrong' }, body: { deviceName: 'X' } });
    check('C1 错误 token → 401', wrongTok.status === 401, { status: wrongTok.status });
    /* 恒定时间比较要求长度不同也走 false，而不是抛错。 */
    const wrongLen = await request(tokPort, 'POST', '/pairing/session', { headers: { 'X-IB-Home-Token': 'x' }, body: { deviceName: 'X' } });
    check('C1 长度不同的错误 token → 401（不抛 500）', wrongLen.status === 401, { status: wrongLen.status });

    /* 正确 token → 放行，且配对链完整。 */
    const session = await request(tokPort, 'POST', '/pairing/session', { headers: auth, body: { deviceName: 'P11-3A Phone', deviceType: 'android' } });
    const payload = session.body && session.body.payload;
    check('C2 正确 token → 创建配对会话成功', session.status === 200 && !!payload && !!payload.secret, { status: session.status, body: session.body });

    const complete = await request(tokPort, 'POST', '/mobile/v1/pairing/complete', {
      body: { v: 1, payload: { pairingId: payload.pairingId, secret: payload.secret, deviceName: 'P11-3A Phone', deviceType: 'android' } }
    });
    const deviceToken = complete.body && complete.body.payload && complete.body.payload.token;
    const deviceId = complete.body && complete.body.payload && complete.body.payload.device.deviceId;
    check('C3 配对完成 → 签发 device token', complete.status === 200 && !!deviceToken && !!deviceId, { status: complete.status });

    /* 配对 secret 一次性：重放必须失败（生命周期不变式）。 */
    const replay = await request(tokPort, 'POST', '/mobile/v1/pairing/complete', {
      body: { v: 1, payload: { pairingId: payload.pairingId, secret: payload.secret, deviceName: 'again', deviceType: 'android' } }
    });
    check('C3 配对 secret 一次性：重放被拒（403/409/410 之一，且不签发第二个 token）',
      replay.status >= 400 && !(replay.body && replay.body.payload && replay.body.payload.token),
      { status: replay.status, body: replay.body });

    const handshake = await request(tokPort, 'GET', '/mobile/v1/handshake', { headers: { Authorization: 'Bearer ' + deviceToken } });
    check('C4 签发的 device token 在设备面可用（Android 流程未被收紧波及）',
      handshake.status === 200 && handshake.body.ok === true, { status: handshake.status });

    const devices = await request(tokPort, 'GET', '/devices', { headers: auth });
    const list = devices.body && devices.body.payload && devices.body.payload.devices;
    check('C5 桌面能列出设备，且**不**回显任何 device token',
      devices.status === 200 && Array.isArray(list) && list.length === 1 && !/ibd1_/.test(devices.raw),
      { status: devices.status, count: list && list.length });

    const revoked = await request(tokPort, 'POST', '/device/revoke', { headers: auth, body: { deviceId: deviceId } });
    check('C6 桌面撤销设备成功', revoked.status === 200, revoked.body);
    const after = await request(tokPort, 'GET', '/mobile/v1/handshake', { headers: { Authorization: 'Bearer ' + deviceToken } });
    check('C6 撤销**立即**生效（403 DEVICE_REVOKED）',
      after.status === 403 && after.body && after.body.error && after.body.error.code === 'DEVICE_REVOKED',
      { status: after.status, body: after.body });
  } catch (error) {
    failed++;
    console.error('FAIL C 段异常终止 — ' + String((error && error.stack) || error));
  } finally {
    await stopService(tokSvc);
    dropDir(tokDir);
  }

  /* ══ D · 变异测试：在**临时副本**里短路 gate ═════════════════════════
     目的：证明 A1 的 403 真的来自这段 gate，而不是别处的巧合。
     原仓库文件全程只读；副本放在 %TEMP%，跑完删除。 */
  const copyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-p113a-mut-'));
  const fakeRoot = path.join(copyRoot, 'fake-root');
  try {
    const target = path.join(fakeRoot, HTTP_JS);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const original = fs.readFileSync(path.join(ROOT, HTTP_JS), 'utf8');
    const needle = "    if (token) return false;\n    return isCredentialMintingPath(path);";
    check('D0 变异锚点在源码里恰好出现一次（否则这次变异是无效证据）',
      original.split(needle).length === 2, { occurrences: original.split(needle).length - 1 });

    /* 服务脚本跨三处 require：../services/home-node/*（根下 services/）、
       ../active/node-model-port.js（根下 active/）、../../assets/js/*（根下 assets/）。
       所以副本必须是**一棵完整的假仓库根**，否则副本根本跑不起来 —— 那样得到的
       "变异后仍被拒"会是假证据（进程压根没启动）。 */
    for (const rel of ['services', 'assets', 'active']) {
      fs.cpSync(path.join(ROOT, rel), path.join(fakeRoot, rel), { recursive: true });
    }
    /* P11-3X-B：服务侧现在也 require runtime/ 下的模块（数据库失败分类器）。
       这里**不**整体复制 runtime/ —— 它里面还有内置 Node 运行时（约 100 MB）。
       改为从副本里扫出对 runtime/ 的依赖再逐文件复制：写死文件名的话，下次多一个
       运行时依赖，这个副本又会以 "MODULE_NOT_FOUND" 的方式失效，而 D1 只会把它
       报成"变异副本跑不起来"，看起来像测试本身的问题而不是真的缺依赖。 */
    const runtimeDeps = new Set();
    const scanDeps = dir => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { scanDeps(full); continue; }
        if (!/\.js$/.test(entry.name)) continue;
        const src = fs.readFileSync(full, 'utf8');
        const re = /require\(\s*['"](?:\.\.\/)+runtime\/([^'"]+)['"]\s*\)/g;
        let m;
        while ((m = re.exec(src)) !== null) runtimeDeps.add(m[1]);
      }
    };
    for (const rel of ['services', 'active', 'assets']) scanDeps(path.join(fakeRoot, rel));
    for (const rel of runtimeDeps) {
      const from = path.join(ROOT, 'runtime', rel);
      const to = path.join(fakeRoot, 'runtime', rel);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.cpSync(from, to, { recursive: true });
    }
    check('D0b 变异副本补齐了服务侧对 runtime/ 的全部依赖（否则 D1 的失败会是假证据）',
      runtimeDeps.size > 0 && [...runtimeDeps].every(r => fs.existsSync(path.join(fakeRoot, 'runtime', r))),
      [...runtimeDeps]);
    fs.writeFileSync(target, original.replace(needle, "    return false;"), 'utf8');

    const mutDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-p113a-mutdata-'));
    const mutPort = await freePort();
    const mutSvc = spawnService(fakeRoot, {
      IB_HOME_NODE_PORT: String(mutPort),
      IB_HOME_NODE_DATA_DIR: mutDir
    });
    try {
      const health = await waitForHealth(mutPort, 15000);
      check('D1 变异副本照常启动（说明副本本身是完整可跑的）', !!(health && health.ok === true), mutSvc.out.slice(-700));

      const opened = await request(mutPort, 'POST', '/pairing/session', { body: { deviceName: 'mutant', deviceType: 'android' } });
      check('D2 **gate 短路后，同一个无 token 请求变成 200 并拿到 secret** —— 证明 A1 的 403 由这段 gate 承重',
        opened.status === 200 && !!(opened.body && opened.body.payload && opened.body.payload.secret),
        { status: opened.status, body: opened.body });
    } finally {
      await stopService(mutSvc);
      dropDir(mutDir);
    }

    /* 报告里必须能看出"原仓库没被动过"。 */
    check('D3 原仓库文件在变异测试前后逐字节一致（变异只发生在副本里）',
      fs.readFileSync(path.join(ROOT, HTTP_JS), 'utf8') === original);
  } catch (error) {
    failed++;
    console.error('FAIL D 段异常终止 — ' + String((error && error.stack) || error));
  } finally {
    dropDir(copyRoot);
  }

  /* ── 泄漏核对 ── */
  const stragglers = Array.from(liveChildren).filter(c => !c.exited);
  for (const child of stragglers) child.stop();
  if (stragglers.length) await Promise.race([Promise.all(stragglers.map(c => c.done)), new Promise(r => setTimeout(r, 3000))]);
  const stillAlive = Array.from(liveChildren).filter(c => !c.exited);
  if (stillAlive.length) {
    failed++;
    console.error('FAIL 资源泄漏 — 未退出的子进程 = ' + stillAlive.length);
  }

  if (failed) { console.error('P11-3A 凭据铸造面边界测试失败：' + failed + ' 项（通过 ' + passed + '）'); process.exitCode = 1; }
  else console.log('P11-3A 凭据铸造面边界测试通过 (' + passed + ' 项)');
})();
