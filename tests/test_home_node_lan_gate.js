'use strict';
/* ====================================================================
   Internal Beyond · Home Node **LAN 门**（M1-C blocker 修复的证据）
   运行：node tests/test_home_node_lan_gate.js

   为什么必须单独一个文件、且必须用非 loopback 源地址：
     规则是"非 loopback 来源在被证明可信之前一律 403"。在 127.0.0.1 上打请求
     **永远走不到这条规则**（`isLoopback(req)` 为真，直接进正常路由），所以用
     loopback 客户端去验证它，测到的只是"门后面的东西没坏"。本文件所有"远端"
     请求都发往本机的**非 loopback 地址** —— 于是源地址也是非 loopback，服务端
     才会真正执行那条判定。

   四部分：
     A · 真实服务进程 + 显式非 loopback 绑定 + **已配置**桌面 token
         · 设备鉴权就绪 → LAN 上 pairing/complete 与 character.list 真的可用；
         · 未认证 / 伪造 device token → 仍然被拒；
         · 桌面管理面在 LAN 上仍然需要桌面 token（匿名一律 401）。
     B · 默认姿态（不覆盖 HOST → 127.0.0.1）→ 远端地址上根本连不上。
     C · 设备鉴权**未就绪**（真实故障：devices_schema 比本版新）→ 已经监听在
         0.0.0.0 的实例对远端一律 403 loopback-only，而 loopback 照常可用。
     D · LAN 绑定 + **未配置**桌面 token（默认安装的真实形态）→ 桌面面在 LAN 上
         整片 403（否则等于把签发配对凭据和撤销设备的能力送给整个局域网），
         而 /mobile/v1/* 仍然只认 device token —— 手机因此仍能配对成功。
         P11-3A 收紧：**本机 loopback 上，凭据铸造面也不再默认放行**。
         原先这里断言"loopback 无 token 照常创建配对会话"—— 那条断言描述的
         正是被修的缺陷本身（本机任意进程都能铸造 device token）。现在改为：
         无 token 时 loopback 上同样 403 desktop-token-required；配了 token 之后
         整条配对链（create → complete → 设备面可用）仍然完整可用。
   ==================================================================== */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SERVICE = require(path.join(ROOT, 'services', 'home-node-service.js'));

let passed = 0, failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log('OK   ' + name); }
  else { failed++; console.error('FAIL ' + name + (extra !== undefined ? ' — ' + JSON.stringify(extra) : '')); }
}

/* ── 资源账本：本 harness 不允许用 process.exit(0) 掩盖没释放的 child/socket，
      也不允许"跑完不退出"。结束时逐个关，最后核对一遍并如实报告。 ── */
const liveChildren = new Set();
const liveServers = new Set();

function request(host, port, method, urlPath, options) {
  options = options || {};
  return new Promise(resolve => {
    const data = options.body == null ? null
      : (typeof options.body === 'string' ? options.body : JSON.stringify(options.body));
    const headers = Object.assign({}, options.headers || {});
    if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
    const req = http.request({ host: host, port: port, path: urlPath, method: method, timeout: 8000, headers: headers }, res => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', c => raw += c);
      res.on('end', () => {
        let parsed = null;
        try { parsed = raw ? JSON.parse(raw) : {}; } catch (_) { parsed = { raw: raw }; }
        resolve({ status: res.statusCode, body: parsed, headers: res.headers, raw: raw, text: raw });
      });
      res.on('error', e => resolve({ status: 0, body: null, error: e.message }));
    });
    req.on('timeout', () => { try { req.destroy(); } catch (_) {} resolve({ status: 0, body: null, error: 'timeout' }); });
    req.on('error', e => resolve({ status: 0, body: null, error: e.code || e.message }));
    if (data) req.write(data);
    req.end();
  });
}

function freePort() {
  return new Promise(resolve => {
    const server = net.createServer();
    server.unref();
    server.listen(0, '127.0.0.1', () => { const p = server.address().port; server.close(() => resolve(p)); });
  });
}

/* 本机可用于"扮演远端"的地址：
   优先真实 LAN IPv4（最强证据：源地址就是局域网地址）；没有非 internal 地址的
   机器（CI 容器）退回 127.0.0.2 —— 它在 Windows/Linux 上都能绑定，而服务端的
   isLoopback() 只认 `127.0.0.1`，因此同样是非 loopback 来源。用哪一条会打在输出里。 */
async function pickRemoteAddress() {
  const candidates = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const entry of ifaces[name] || []) {
      const family = String(entry.family);
      if ((family === 'IPv4' || family === '4') && !entry.internal) candidates.push(entry.address);
    }
  }
  for (const address of candidates) {
    if (await canSelfConnect(address)) return { address: address, kind: 'lan' };
  }
  if (await canSelfConnect('127.0.0.2')) return { address: '127.0.0.2', kind: 'loopback-alias' };
  return null;
}

function canSelfConnect(address) {
  return new Promise(resolve => {
    const server = http.createServer((req, res) => { res.writeHead(200); res.end('ok'); });
    server.on('error', () => resolve(false));
    server.listen(0, address, () => {
      const port = server.address().port;
      let settled = false;
      const finish = value => { if (settled) return; settled = true; server.close(() => resolve(value)); };
      const req = http.request({ host: address, port: port, path: '/', timeout: 3000 }, res => {
        res.resume();
        res.on('end', () => finish(true));
      });
      req.on('error', () => finish(false));
      req.on('timeout', () => { req.destroy(); finish(false); });
      req.end();
    });
  });
}

function spawnService(env) {
  const child = spawn(process.execPath, [path.join('services', 'home-node-service.js')], {
    cwd: ROOT,
    env: Object.assign({}, process.env, env),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const state = { out: '', child: child, exited: false };
  child.stdout.on('data', c => state.out += c);
  child.stderr.on('data', c => state.out += c);
  state.done = new Promise(resolve => {
    child.on('exit', () => { state.exited = true; liveChildren.delete(state); resolve(); });
  });
  state.stop = () => { try { child.kill(); } catch (_) { /* 已退出 */ } };
  liveChildren.add(state);
  return state;
}

async function waitForHealth(port, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const r = await request('127.0.0.1', port, 'GET', '/health');
    if (r.status === 200 && r.body && r.body.ok) return r.body;
    await new Promise(r2 => setTimeout(r2, 200));
  }
  return null;
}

function listen(server, host) {
  return new Promise(resolve => server.listen(0, host, () => resolve(server.address().port)));
}

function dropDir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* Windows 上句柄可能还没放完 */ }
}

async function stopService(state) {
  state.stop();
  await Promise.race([state.done, new Promise(r => setTimeout(r, 3000))]);
}

function logLines(out, pattern) {
  return out.split('\n').filter(l => pattern.test(l)).join(' | ').slice(0, 600);
}

(async () => {
  const remote = await pickRemoteAddress();
  console.log('# 远端地址：' + (remote ? remote.address + ' (' + (remote.kind === 'lan' ? '真实 LAN IPv4' : '127.0.0.2 别名') + ')' : '不可用'));
  if (!remote) {
    console.error('FAIL 本机既没有可自连的 LAN IPv4，也无法绑定 127.0.0.2 —— 无法产生非 loopback 来源，LAN 门无法被证明。');
    process.exitCode = 1;
    return;
  }
  const REMOTE = remote.address;

  /* ══ A · 显式非 loopback 绑定 + 已配置桌面 token ═══════════════════ */
  {
    const aDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-langate-'));
    const ADMIN = 'langate-admin-token';
    const aPort = await freePort();
    const svc = spawnService({
      IB_HOME_NODE_HOST: '0.0.0.0',
      IB_HOME_NODE_PORT: String(aPort),
      IB_HOME_NODE_DATA_DIR: aDir,
      IB_HOME_NODE_TOKEN: ADMIN
    });
    const admin = { 'X-IB-Home-Token': ADMIN };
    try {
      const health = await waitForHealth(aPort, 15000);
      check('A1 LAN 绑定 + 设备鉴权就绪 → 服务启动（loopback 探针可用）',
        !!(health && health.service === 'internal-beyond-home-node'), svc.out.slice(-400));

      /* 启动日志必须自己说清"门为什么是开的"，否则这条安全决策不可审计。 */
      check('A2 启动日志登记 allowRemote 的判定与探针依据',
        /\blan-bind-enabled\b/.test(svc.out) && /"allowRemote":true/.test(svc.out) &&
        /"deviceAuthProbe":"device-auth-verified"/.test(svc.out),
        logLines(svc.out, /lan-bind-enabled|listening/));
      check('A2 启动日志如实声明远端需要 device token（不是笼统的"LAN 已启用"）',
        /"remoteClients":"device-token-required"/.test(svc.out) && /"loopbackOnly":false/.test(svc.out),
        logLines(svc.out, /listening/));

      /* ── A3：LAN 上未认证 → 必须被拒；而且拒绝来自**设备鉴权**而不是 loopback 门。
             `403 loopback-only` 与 `401 AUTH_REQUIRED` 的区别正是"门开了但没敞开"。 ── */
      const anon = await request(REMOTE, aPort, 'GET', '/mobile/v1/character/list');
      check('A3 LAN 上未认证 character.list → 401 AUTH_REQUIRED（不是 403 loopback-only，也不是 200）',
        anon.status === 401 && anon.body.error && anon.body.error.code === 'AUTH_REQUIRED',
        { status: anon.status, body: anon.body });

      const forged = await request(REMOTE, aPort, 'GET', '/mobile/v1/character/list',
        { headers: { Authorization: 'Bearer ibd1_' + 'z'.repeat(43) } });
      check('A3 LAN 上伪造 device token → 401 AUTH_INVALID',
        forged.status === 401 && forged.body.error && forged.body.error.code === 'AUTH_INVALID',
        { status: forged.status, body: forged.body });

      const anonPair = await request(REMOTE, aPort, 'POST', '/mobile/v1/pairing/complete',
        { body: { v: 1, payload: { pairingId: 'pair_x', secret: 'y' } } });
      check('A3 LAN 上伪造配对载荷 → 403（不得因为"来自 LAN"就放宽配对）',
        anonPair.status === 403, { status: anonPair.status, body: anonPair.body });

      /* ── A4：桌面管理面在 LAN 上仍然需要桌面 token ── */
      const remoteStatus = await request(REMOTE, aPort, 'GET', '/status');
      check('A4 LAN 上 /status 无桌面 token → 401 unauthenticated',
        remoteStatus.status === 401 && remoteStatus.body.error === 'unauthenticated',
        { status: remoteStatus.status, body: remoteStatus.body });
      const remotePairSession = await request(REMOTE, aPort, 'POST', '/pairing/session', { body: { deviceName: 'X', deviceType: 'android' } });
      check('A4 LAN 上不得匿名创建配对会话（否则等于把签发凭据的能力交出去）',
        remotePairSession.status === 401, { status: remotePairSession.status, body: remotePairSession.body });
      const remoteHealth = await request(REMOTE, aPort, 'GET', '/health');
      check('A4 LAN 上匿名 /health 被拒（它确实会泄漏 revision 与消息条数）',
        remoteHealth.status === 401, { status: remoteHealth.status, body: remoteHealth.body });
      const remoteDevices = await request(REMOTE, aPort, 'GET', '/devices');
      check('A4 LAN 上不得匿名列出设备', remoteDevices.status === 401, { status: remoteDevices.status, body: remoteDevices.body });
      const remoteStatusWithToken = await request(REMOTE, aPort, 'GET', '/status', { headers: admin });
      check('A4 LAN 上出示**正确**桌面 token 后管理面可用（配置了凭据就按凭据放行）',
        remoteStatusWithToken.status === 200 && remoteStatusWithToken.body.ok === true,
        { status: remoteStatusWithToken.status, body: remoteStatusWithToken.body && remoteStatusWithToken.body.ok });
      const remoteStatusWrongToken = await request(REMOTE, aPort, 'GET', '/status', { headers: { 'X-IB-Home-Token': 'not-the-token' } });
      check('A4 LAN 上错误的桌面 token → 401（不是"远端一律拒绝"也不是放行）',
        remoteStatusWrongToken.status === 401, { status: remoteStatusWrongToken.status, body: remoteStatusWrongToken.body });

      /* 桌面侧（loopback）完全不受影响：配对会话本来就是在桌面上发起的。 */
      const session = await request('127.0.0.1', aPort, 'POST', '/pairing/session', { headers: admin, body: { deviceName: 'LAN Phone', deviceType: 'android' } });
      const payload = session.body && session.body.payload;
      check('A5 loopback 上仍可创建配对会话，且载荷给出真实可达地址',
        session.status === 200 && payload && payload.lanReachable === true && !!payload.endpoints.mobile.host,
        payload && payload.endpoints);

      /* ── A6：头号目标（一）—— 从 LAN 上完成配对 ── */
      const complete = await request(REMOTE, aPort, 'POST', '/mobile/v1/pairing/complete', {
        body: { v: 1, payload: { pairingId: payload.pairingId, secret: payload.secret, deviceName: 'LAN Phone', deviceType: 'android' } }
      });
      const token = complete.body && complete.body.payload && complete.body.payload.token;
      const deviceId = complete.body && complete.body.payload && complete.body.payload.device.deviceId;
      check('A6 **LAN 上 pairing/complete 成功**并签发 device token',
        complete.status === 200 && !!token && !!deviceId,
        { status: complete.status, body: complete.body, out: svc.out.slice(-300) });

      const deviceAuth = { Authorization: 'Bearer ' + token };
      const handshake = await request(REMOTE, aPort, 'GET', '/mobile/v1/handshake', { headers: deviceAuth });
      check('A6 LAN 上 handshake 用同一份 device token 可用',
        handshake.status === 200 && handshake.body.ok === true, { status: handshake.status, body: handshake.body });

      /* ── A7：头号目标（二）—— 从 LAN 上读角色目录 ── */
      const published = await request('127.0.0.1', aPort, 'POST', '/characters/publish', {
        headers: admin,
        body: { characters: [{ id: 'langate_friend', name: 'LAN Friend', relationship: 'friend', bio: 'lan gate probe', model: 'deepseek-flash' }] }
      });
      check('A7 测试前提：桌面已发布一个角色', published.status === 200 && published.body.payload.count === 1, published.body);

      const lanList = await request(REMOTE, aPort, 'GET', '/mobile/v1/character/list', { headers: deviceAuth });
      const lanCharacters = lanList.body && lanList.body.payload && lanList.body.payload.characters;
      check('A7 **LAN 上 character.list 通过 device auth 成功**，且返回已发布的角色',
        lanList.status === 200 && Array.isArray(lanCharacters) && lanCharacters.some(c => c.id === 'langate_friend'),
        { status: lanList.status, body: lanList.body });
      check('A7 LAN 返回的角色 DTO 不含 spec / provider 配置',
        lanList.status === 200 && !/"(spec|systemPrompt|apiKey|endpoint)"/.test(lanList.raw), lanList.raw.slice(0, 300));

      const localList = await request('127.0.0.1', aPort, 'GET', '/mobile/v1/character/list', { headers: deviceAuth });
      check('A7 loopback 与 LAN 对同一 device token 行为一致',
        localList.status === 200 && localList.body.payload.characters.length === lanCharacters.length,
        { local: localList.status, lan: lanList.status });

      /* ── A8：撤销对 LAN 客户端立即生效 ── */
      const revoked = await request('127.0.0.1', aPort, 'POST', '/device/revoke', { headers: admin, body: { deviceId: deviceId } });
      check('A8 测试前提：桌面撤销成功', revoked.status === 200, revoked.body);
      const afterRevoke = await request(REMOTE, aPort, 'GET', '/mobile/v1/character/list', { headers: deviceAuth });
      check('A8 撤销后 LAN 上立即失效（403 + DEVICE_REVOKED，与 loopback 客户端同一词表）',
        afterRevoke.status === 403 && afterRevoke.body.error && afterRevoke.body.error.code === 'DEVICE_REVOKED',
        { status: afterRevoke.status, body: afterRevoke.body });
    } catch (error) {
      failed++;
      console.error('FAIL A 段异常终止 — ' + String((error && error.stack) || error));
    } finally {
      await stopService(svc);
      dropDir(aDir);
    }
  }

  /* ══ B · 默认姿态：不覆盖 HOST → 远端地址上连不上 ═══════════════════ */
  {
    const bDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-langate-default-'));
    const bPort = await freePort();
    const def = spawnService({ IB_HOME_NODE_PORT: String(bPort), IB_HOME_NODE_DATA_DIR: bDir });
    try {
      const health = await waitForHealth(bPort, 15000);
      check('B1 默认（不设 HOST）照常服务 loopback', !!(health && health.ok === true), def.out.slice(-300));
      check('B1 启动日志如实声明 loopback-only / 远端被拒',
        /"loopbackOnly":true/.test(def.out) && /"remoteClients":"refused \(loopback bind\)"/.test(def.out),
        logLines(def.out, /listening/));
      const fromRemote = await request(REMOTE, bPort, 'GET', '/health');
      check('B2 默认姿态下远端地址连不上（socket 层就拒绝，连 403 都到不了）',
        fromRemote.status === 0 && /ECONNREFUSED|EHOSTUNREACH|ETIMEDOUT|timeout|EADDRNOTAVAIL/.test(String(fromRemote.error)),
        { status: fromRemote.status, error: fromRemote.error });
    } catch (error) {
      failed++;
      console.error('FAIL B 段异常终止 — ' + String((error && error.stack) || error));
    } finally {
      await stopService(def);
      dropDir(bDir);
    }
  }

  /* ══ C · 设备鉴权未就绪 → 已监听的 0.0.0.0 实例对远端一律拒绝 ═══════
     这是 allowRemote 的**后半条**：绑定确实是显式的非 loopback，但鉴权子系统
     不可用。用真实故障注入（devices_schema 比本版新），不用 mock。
     预期：进程照常服务 loopback（本机用户不该因为设备层坏了就连不上自己的
     Home Node），但远端一律 403 loopback-only。 */
  {
    const cDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-langate-noauth-'));
    let inst = null;
    try {
      /* 先正常开一次把 schema 建出来（chat store 与设备表同库不同 key）。 */
      const primer = SERVICE.buildHomeNode({ dataDir: cDir, host: '0.0.0.0', logger: () => {} });
      primer.open();
      primer.close();

      const { DatabaseSync } = require('node:sqlite');
      const raw = new DatabaseSync(path.join(cDir, 'home-node.db'));
      raw.prepare("INSERT INTO meta (key, value) VALUES ('devices_schema', '99') " +
        'ON CONFLICT(key) DO UPDATE SET value = excluded.value').run();
      raw.close();

      inst = SERVICE.buildHomeNode({ dataDir: cDir, host: '0.0.0.0', logger: () => {} });
      let openError = null;
      try { inst.open(); } catch (error) { openError = error; }
      check('C1 测试前提：设备注册表因 schema 过新而打不开（真实故障，非 mock）',
        !!openError && openError.code === 'SCHEMA_TOO_NEW', openError && openError.code);

      const authState = SERVICE.deviceAuthReady(inst.registry);
      check('C1 deviceAuthReady 判定未就绪并给出理由',
        authState.ready === false && /not-open|STORE_CLOSED|probe/.test(authState.reason), authState);

      const cPort = await listen(inst.server, '0.0.0.0');
      liveServers.add(inst.server);
      const remoteList = await request(REMOTE, cPort, 'GET', '/mobile/v1/character/list');
      check('C2 LAN 上 mobile 请求被 loopback-only 挡住（门没开 → 什么都到不了）',
        remoteList.status === 403 && remoteList.body.error === 'loopback-only',
        { status: remoteList.status, body: remoteList.body });
      const remoteHealthC = await request(REMOTE, cPort, 'GET', '/health');
      check('C2 LAN 上 /health 同样被挡',
        remoteHealthC.status === 403 && remoteHealthC.body.error === 'loopback-only',
        { status: remoteHealthC.status, body: remoteHealthC.body });
      const localHealth = await request('127.0.0.1', cPort, 'GET', '/health');
      check('C3 本机 loopback 照常可用（设备层坏掉不该让本机用户连不上自己的 Home Node）',
        localHealth.status === 200 && localHealth.body.open === true, { status: localHealth.status, body: localHealth.body });
      const localSecurity = await request('127.0.0.1', cPort, 'GET', '/security');
      check('C3 /security 如实声明这台进程没有对远端开放',
        localSecurity.status === 200 && localSecurity.body.loopbackOnly === true && localSecurity.body.allowRemote === false,
        localSecurity.body);
    } catch (error) {
      failed++;
      console.error('FAIL C 段异常终止 — ' + String((error && error.stack) || error));
    } finally {
      if (inst) { try { inst.close(); } catch (_) { /* 已关闭 */ } liveServers.delete(inst.server); }
      dropDir(cDir);
    }
  }

  /* ══ D · LAN 绑定 + 未配置桌面 token（默认安装的真实形态）═══════════
     这一段的重点是那条"必要条件"：没有桌面 token 时，远端**不能**碰到任何桌面
     路径（否则局域网里任何人都能签发配对凭据、撤销设备）；而 /mobile/v1/*
     仍然只认 device token，所以手机照样能完成配对 —— 这正是 M1-C 需要的。 */
  {
    const dDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-langate-notoken-'));
    const dPort = await freePort();
    const dSvc = spawnService({
      IB_HOME_NODE_HOST: '0.0.0.0',
      IB_HOME_NODE_PORT: String(dPort),
      IB_HOME_NODE_DATA_DIR: dDir
    });
    try {
      const health = await waitForHealth(dPort, 15000);
      check('D1 未配置桌面 token 也能启动（loopback 探针可用）', !!(health && health.ok === true), dSvc.out.slice(-300));
      check('D1 启动日志：门已开，远端需要 device token',
        /"allowRemote":true/.test(dSvc.out) && /"remoteClients":"device-token-required"/.test(dSvc.out),
        logLines(dSvc.out, /lan-bind-enabled|listening/));

      const dStatus = await request(REMOTE, dPort, 'GET', '/status');
      check('D2 LAN 上 /status → 403 remote-admin-disabled（不是 401，也不存在能奏效的凭据）',
        dStatus.status === 403 && dStatus.body.error === 'remote-admin-disabled',
        { status: dStatus.status, body: dStatus.body });
      const dHealth = await request(REMOTE, dPort, 'GET', '/health');
      check('D2 LAN 上匿名 /health → 403 remote-admin-disabled',
        dHealth.status === 403 && dHealth.body.error === 'remote-admin-disabled',
        { status: dHealth.status, body: dHealth.body });
      const dDevices = await request(REMOTE, dPort, 'GET', '/devices');
      check('D2 LAN 上匿名列设备 → 403 remote-admin-disabled',
        dDevices.status === 403 && dDevices.body.error === 'remote-admin-disabled',
        { status: dDevices.status, body: dDevices.body });
      const dRevoke = await request(REMOTE, dPort, 'POST', '/device/revoke', { body: { deviceId: 'x' } });
      check('D2 LAN 上匿名撤销设备 → 403 remote-admin-disabled（这条是打开 allowRemote 的必要条件）',
        dRevoke.status === 403 && dRevoke.body.error === 'remote-admin-disabled',
        { status: dRevoke.status, body: dRevoke.body });
      const dPairSession = await request(REMOTE, dPort, 'POST', '/pairing/session', { body: { deviceName: 'X', deviceType: 'android' } });
      check('D2 LAN 上匿名创建配对会话 → 403 remote-admin-disabled',
        dPairSession.status === 403 && dPairSession.body.error === 'remote-admin-disabled',
        { status: dPairSession.status, body: dPairSession.body });
      const dPublish = await request(REMOTE, dPort, 'POST', '/characters/publish', { body: { characters: [{ id: 'x', name: 'x' }] } });
      check('D2 LAN 上匿名发布角色 → 403 remote-admin-disabled',
        dPublish.status === 403 && dPublish.body.error === 'remote-admin-disabled',
        { status: dPublish.status, body: dPublish.body });

      /* P11-3A：**本机 loopback 上也不再有豁免**。这一条是本测试里唯一
         能证明"凭据铸造面不靠 loopback 私密性"的断言；把它删掉，整份文件就
         只剩远端规则，而远端规则早在 P11-3A 之前就已经存在了。 */
      const dPairNoToken = await request('127.0.0.1', dPort, 'POST', '/pairing/session', { body: { deviceName: 'Phone', deviceType: 'android' } });
      check('D3 loopback 上未配置 token 时**不得**创建配对会话（否则本机任意进程都能铸造 device token）',
        dPairNoToken.status === 403 && dPairNoToken.body.error === 'desktop-token-required',
        { status: dPairNoToken.status, body: dPairNoToken.body });
      const dDevicesNoToken = await request('127.0.0.1', dPort, 'GET', '/devices');
      check('D3 loopback 上未配置 token 时不得列设备 / 撤销设备',
        dDevicesNoToken.status === 403 && dDevicesNoToken.body.error === 'desktop-token-required',
        { status: dDevicesNoToken.status, body: dDevicesNoToken.body });
      const dRevokeNoToken = await request('127.0.0.1', dPort, 'POST', '/device/revoke', { body: { deviceId: 'x' } });
      check('D3 loopback 上未配置 token 时不得撤销设备',
        dRevokeNoToken.status === 403 && dRevokeNoToken.body.error === 'desktop-token-required',
        { status: dRevokeNoToken.status, body: dRevokeNoToken.body });
      /* 读取类路径**有意保持** loopback 匿名可用（既有 D1 风险接受，P11-3A 不动它）。
         断言它是为了把"我们接受了什么"钉在测试里，而不是让它随时间漂移。 */
      const dStatusLoopback = await request('127.0.0.1', dPort, 'GET', '/status');
      check('D3（如实记录残留暴露）loopback 读取类路径在未配置 token 时仍匿名可用 —— 这是被有意接受的既有风险，不是本阶段的修复目标',
        dStatusLoopback.status === 200 && dStatusLoopback.body.ok === true,
        { status: dStatusLoopback.status });
      /* 目录**发布**是凭据以外的第二类特权：它决定手机能看见哪些角色。 */
      const dPublishLoopback = await request('127.0.0.1', dPort, 'POST', '/characters/publish', { body: { characters: [{ id: 'x', name: 'x' }] } });
      check('D3 loopback 上未配置 token 时不得发布角色目录（它决定手机能看见谁）',
        dPublishLoopback.status === 403 && dPublishLoopback.body.error === 'desktop-token-required',
        { status: dPublishLoopback.status, body: dPublishLoopback.body });
      const dSecurityD = await request('127.0.0.1', dPort, 'GET', '/security');
      check('D3 /security 如实报告凭据铸造面已关闭、且列出仍匿名可读的路径',
        dSecurityD.body && dSecurityD.body.credentialMintingPaths &&
        dSecurityD.body.credentialMintingPaths.enabled === false &&
        Array.isArray(dSecurityD.body.loopbackReadableWithoutToken),
        dSecurityD.body && dSecurityD.body.credentialMintingPaths);
    } catch (error) {
      failed++;
      console.error('FAIL D 段异常终止 — ' + String((error && error.stack) || error));
    } finally {
      await stopService(dSvc);
      dropDir(dDir);
    }
  }

  /* ══ E · P11-3A 的正向面：配了桌面 token 之后整条配对链仍然完整 ══════
     这一段的唯一目的是证明"修安全"没有"修坏功能"：create → complete →
     设备面可用，全部在**未绑定 LAN**（默认 loopback 绑定）的安装形态下完成。
     D 段证明门关着，E 段证明钥匙能开门 —— 缺任何一段，这次改动都不成立。 */
  {
    const eDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-langate-token-'));
    const ePort = await freePort();
    const EADMIN = 'p11-3a-desktop-token';
    const eSvc = spawnService({
      IB_HOME_NODE_PORT: String(ePort),
      IB_HOME_NODE_DATA_DIR: eDir,
      IB_HOME_NODE_TOKEN: EADMIN
    });
    const eAuth = { 'X-IB-Home-Token': EADMIN };
    try {
      const health = await waitForHealth(ePort, 15000);
      check('E1 配了桌面 token 的安装照常启动', !!(health && health.ok === true), eSvc.out.slice(-300));

      const session = await request('127.0.0.1', ePort, 'POST', '/pairing/session', { headers: eAuth, body: { deviceName: 'Phone', deviceType: 'android' } });
      const payload = session.body && session.body.payload;
      check('E2 带正确 token → loopback 上创建配对会话成功（P11-3A 之前的行为逐字保留）',
        session.status === 200 && !!payload && !!payload.pairingId, { status: session.status, body: session.body });

      const complete = await request('127.0.0.1', ePort, 'POST', '/mobile/v1/pairing/complete', {
        body: { v: 1, payload: { pairingId: payload.pairingId, secret: payload.secret, deviceName: 'Phone', deviceType: 'android' } }
      });
      const token = complete.body && complete.body.payload && complete.body.payload.token;
      check('E3 配对完成并签发 device token（Android 配对流程完整保留）',
        complete.status === 200 && !!token, { status: complete.status, body: complete.body });

      const handshake = await request('127.0.0.1', ePort, 'GET', '/mobile/v1/handshake', { headers: { Authorization: 'Bearer ' + token } });
      check('E4 签发的 device token 可用（设备面没被这次收紧波及）',
        handshake.status === 200 && handshake.body.ok === true, { status: handshake.status });

      const devices = await request('127.0.0.1', ePort, 'GET', '/devices', { headers: eAuth });
      const list = devices.body && devices.body.payload && devices.body.payload.devices;
      check('E5 带正确 token → 能列出刚配对的设备',
        devices.status === 200 && Array.isArray(list) && list.length === 1, { status: devices.status, body: devices.body });

      /* 反向：**错误**的 token 不得开启凭据铸造面（本阶段的核心不变式）。 */
      const wrong = await request('127.0.0.1', ePort, 'POST', '/pairing/session', { headers: { 'X-IB-Home-Token': 'not-the-token' }, body: { deviceName: 'X' } });
      check('E6 错误的桌面 token → 401（不是"有 token 就放行"）',
        wrong.status === 401 && wrong.body.error === 'unauthenticated', { status: wrong.status, body: wrong.body });
      const wrongRevoke = await request('127.0.0.1', ePort, 'POST', '/device/revoke', { headers: { 'X-IB-Home-Token': 'not-the-token' }, body: { deviceId: 'x' } });
      check('E6 错误的桌面 token 同样不得撤销设备',
        wrongRevoke.status === 401, { status: wrongRevoke.status });
      /* 无 token 也不得开启 —— 与 D3 同款，但这里 store 是好的、token 是配的，
         所以它证明的是"缺失凭据"而不是"系统坏了"。 */
      const none = await request('127.0.0.1', ePort, 'POST', '/pairing/session', { body: { deviceName: 'X' } });
      check('E6 不带桌面 token → 401（凭据已配置时没有豁免路径）',
        none.status === 401, { status: none.status, body: none.body });
    } catch (error) {
      failed++;
      console.error('FAIL E 段异常终止 — ' + String((error && error.stack) || error));
    } finally {
      await stopService(eSvc);
      dropDir(eDir);
    }
  }

  /* ── 泄漏核对：不允许"跑完不退出" ── */
  const stragglers = Array.from(liveChildren).filter(c => !c.exited);
  for (const child of stragglers) child.stop();
  if (stragglers.length) await Promise.race([Promise.all(stragglers.map(c => c.done)), new Promise(r => setTimeout(r, 3000))]);
  const stillAlive = Array.from(liveChildren).filter(c => !c.exited);
  const openServers = Array.from(liveServers).filter(s => s.listening);
  if (stillAlive.length || openServers.length) {
    failed++;
    console.error('FAIL 资源泄漏 — child=' + stillAlive.length + ' server=' + openServers.length);
    for (const s of openServers) { try { s.close(); } catch (_) { /* 已关闭 */ } }
  }

  if (failed) { console.error('Home Node LAN 门测试失败：' + failed + ' 项（通过 ' + passed + '）'); process.exitCode = 1; }
  else console.log('Home Node LAN 门测试通过 (' + passed + ' 项)');
})();
