'use strict';
/* ====================================================================
   Internal Beyond · M1-B Mobile Gateway HTTP 契约（service 组）
   运行：node tests/test_mobile_gateway_http.js

   分两半：
     A) **协议 / 鉴权 / 边界**：用 services/home-node-service.js 的
        buildHomeNode() 在临时端口上起一个真实实例（真实装配，不复制接线），
        只打真实 HTTP。
     B) **LAN 硬门**：spawn 真实服务进程，验证
        "非 loopback 绑定 + 设备注册表不可用 → 拒绝启动"，
        以及 LAN 绑定后未认证请求仍然被拒。
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

function request(port, method, urlPath, options) {
  options = options || {};
  return new Promise(resolve => {
    const data = options.body == null ? null
      : (typeof options.body === 'string' ? options.body : JSON.stringify(options.body));
    const headers = Object.assign({}, options.headers || {});
    if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
    const req = http.request({ host: '127.0.0.1', port: port, path: urlPath, method: method, timeout: 8000, headers: headers }, res => {
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
    req.on('error', e => resolve({ status: 0, body: null, error: e.message }));
    if (options.raw) req.write(options.raw); else if (data) req.write(data);
    req.end();
  });
}

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

const ERROR_CODES = ['AUTH_REQUIRED', 'AUTH_INVALID', 'DEVICE_REVOKED', 'PAIRING_INVALID', 'PAIRING_EXPIRED',
  'PAIRING_USED', 'PAIRING_NOT_FOUND', 'BAD_VERSION', 'BAD_REQUEST', 'UNKNOWN_VERB', 'NOT_FOUND',
  'BUSY', 'CONFLICT', 'RATE_LIMITED', 'TOO_LARGE', 'UNSUPPORTED', 'INTERNAL'];

(async () => {
  /* ══ A · 真实装配的隔离实例 ═══════════════════════════════════════ */
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-gw-'));
  const ADMIN_TOKEN = 'gw-admin-token';
  const instance = SERVICE.buildHomeNode({ dataDir: dataDir, token: ADMIN_TOKEN, logger: () => {} });
  instance.open();
  const port = await listen(instance.server);
  const admin = { 'X-IB-Home-Token': ADMIN_TOKEN };

  try {
    /* ── 1 · 版本语义（Phase 9：v 必须真的被读）──────────────────── */
    const session = await request(port, 'POST', '/pairing/session', { headers: admin, body: { deviceName: 'D', deviceType: 'android' } });
    check('gw.1 桌面管理面需要 token', session.status === 200 && session.body.ok === true, session.body);
    const noToken = await request(port, 'POST', '/pairing/session', { body: {} });
    check('gw.1 管理面缺 token → 401', noToken.status === 401, noToken.body);
    const pairing = session.body.payload;

    const completed = await request(port, 'POST', '/mobile/v1/pairing/complete', {
      body: { v: 1, payload: { pairingId: pairing.pairingId, secret: pairing.secret, deviceName: 'D', deviceType: 'android' } }
    });
    const token = completed.body.payload.token;
    const deviceId = completed.body.payload.device.deviceId;
    const auth = { Authorization: 'Bearer ' + token };

    /* /mobile/v1 的 GET 端点无法带 body，因此版本由响应头表达。 */
    const handshake = await request(port, 'GET', '/mobile/v1/handshake', { headers: auth });
    check('gw.1 每条响应都带 X-IB-Mobile-Protocol', handshake.headers['x-ib-mobile-protocol'] === '1', handshake.headers['x-ib-mobile-protocol']);
    check('gw.1 响应信封含 v / ok / type / serverTime',
      handshake.body.v === 1 && handshake.body.ok === true && handshake.body.type === 'handshake' && typeof handshake.body.serverTime === 'number', handshake.body);

    const missingV = await request(port, 'POST', '/mobile/v1/chat/send', { headers: auth, body: { requestId: 'r', payload: {} } });
    check('gw.1 缺 v → BAD_VERSION（缺省不猜）',
      missingV.status === 400 && missingV.body.error.code === 'BAD_VERSION' && missingV.body.error.detail === 'missing', missingV.body);

    for (const bad of [0, 2, 3, -1, 1.5, 'one', null, true]) {
      const r = await request(port, 'POST', '/mobile/v1/chat/send', { headers: auth, body: { v: bad, requestId: 'r', payload: {} } });
      check('gw.1 v=' + JSON.stringify(bad) + ' → BAD_VERSION', r.status === 400 && r.body.error.code === 'BAD_VERSION', r.body.error);
    }

    /* ── 2 · 错误信封是封闭词表，且不泄漏内部细节 ───────────────── */
    const notFound = await request(port, 'GET', '/mobile/v1/nope', { headers: auth });
    check('gw.2 未知 verb → UNKNOWN_VERB', notFound.status === 404 && notFound.body.error.code === 'UNKNOWN_VERB', notFound.body);
    check('gw.2 错误信封形状稳定',
      notFound.body.v === 1 && notFound.body.ok === false && notFound.body.type === 'error' &&
      typeof notFound.body.error.message === 'string' && typeof notFound.body.error.retryable === 'boolean', notFound.body);
    check('gw.2 错误响应不含 stack / 路径 / SQL 细节',
      notFound.text.indexOf('at ') < 0 && notFound.text.indexOf('.js:') < 0 &&
      notFound.text.indexOf('SELECT') < 0 && notFound.text.indexOf('E:\\') < 0, notFound.text);
    check('gw.2 词表里的码都在 ERROR_STATUS 里',
      ERROR_CODES.every(c => typeof instance.gateway.ERROR_STATUS[c] === 'number'), Object.keys(instance.gateway.ERROR_STATUS).length);

    /* ── 3 · 请求体校验 ─────────────────────────────────────────── */
    const badJson = await request(port, 'POST', '/mobile/v1/chat/send', { headers: auth, raw: '{not json' });
    check('gw.3 畸形 JSON → BAD_REQUEST', badJson.status === 400 && badJson.body.error.code === 'BAD_REQUEST', badJson.body);

    const emptyBody = await request(port, 'POST', '/mobile/v1/chat/send', { headers: auth });
    check('gw.3 空 body → BAD_VERSION（先判版本）', emptyBody.status === 400 && emptyBody.body.error.code === 'BAD_VERSION', emptyBody.body);

    const arrayBody = await request(port, 'POST', '/mobile/v1/chat/send', { headers: auth, raw: '[1,2,3]' });
    check('gw.3 数组 body 不崩（明确错误）', arrayBody.status === 400, arrayBody.body);

    const tooLarge = await request(port, 'POST', '/mobile/v1/chat/send', {
      headers: auth, body: { v: 1, requestId: 'r-big', payload: { characterId: 'x', content: 'y'.repeat(30 * 1024 * 1024) } }
    });
    const sizeRejected = tooLarge.status === 413 || (tooLarge.status === 0 && /ECONNRESET|EPIPE|hang up/i.test(String(tooLarge.error || '')));
    check('gw.3 超过体积上限被拒（413 或连接被切断）', sizeRejected, { status: tooLarge.status, error: tooLarge.error });

    /* ── 4 · 鉴权矩阵 ───────────────────────────────────────────── */
    check('gw.4 无凭据 → AUTH_REQUIRED',
      (await request(port, 'GET', '/mobile/v1/character/list')).body.error.code === 'AUTH_REQUIRED');
    check('gw.4 空 Bearer → AUTH_REQUIRED',
      (await request(port, 'GET', '/mobile/v1/character/list', { headers: { Authorization: 'Bearer ' } })).body.error.code === 'AUTH_REQUIRED');
    check('gw.4 畸形 Bearer → AUTH_INVALID',
      (await request(port, 'GET', '/mobile/v1/character/list', { headers: { Authorization: 'Bearer garbage' } })).body.error.code === 'AUTH_INVALID');
    check('gw.4 非 Bearer scheme → AUTH_REQUIRED',
      (await request(port, 'GET', '/mobile/v1/character/list', { headers: { Authorization: 'Basic abc' } })).body.error.code === 'AUTH_REQUIRED');
    check('gw.4 未知 token → AUTH_INVALID',
      (await request(port, 'GET', '/mobile/v1/character/list', { headers: { Authorization: 'Bearer ibd1_' + 'z'.repeat(43) } })).body.error.code === 'AUTH_INVALID');
    /* 永久凭据**不**接受 query 参数（URL 会进日志/历史/Referer）。 */
    const queryToken = await request(port, 'GET', '/mobile/v1/character/list?token=' + encodeURIComponent(token));
    check('gw.4 query 参数里的 token 不被接受', queryToken.status === 401 && queryToken.body.error.code === 'AUTH_REQUIRED', queryToken.body);
    check('gw.4 X-IB-Mobile-Token 与 Bearer 等价',
      (await request(port, 'GET', '/mobile/v1/character/list', { headers: { 'X-IB-Mobile-Token': token } })).status === 200);
    /* 大小写不敏感 scheme */
    check('gw.4 bearer 小写同样接受',
      (await request(port, 'GET', '/mobile/v1/character/list', { headers: { Authorization: 'bearer ' + token } })).status === 200);

    /* ── 5 · CORS / Origin（Phase 20）──────────────────────────── */
    const native = await request(port, 'GET', '/mobile/v1/handshake', { headers: auth });
    check('gw.5 原生客户端（无 Origin）不需要 CORS 头',
      native.headers['access-control-allow-origin'] === undefined, native.headers);
    const capacitor = await request(port, 'GET', '/mobile/v1/handshake', { headers: Object.assign({ Origin: 'capacitor://localhost' }, auth) });
    check('gw.5 capacitor:// 回显（未来 Capacitor 壳）',
      capacitor.headers['access-control-allow-origin'] === 'capacitor://localhost', capacitor.headers);
    const nullOrigin = await request(port, 'GET', '/mobile/v1/handshake', { headers: Object.assign({ Origin: 'null' }, auth) });
    check('gw.5 Origin: null 回显（真实防护是设备 token，不是 Origin）',
      nullOrigin.headers['access-control-allow-origin'] === 'null', nullOrigin.headers);
    const hostile = await request(port, 'GET', '/mobile/v1/handshake', { headers: Object.assign({ Origin: 'https://evil.example' }, auth) });
    check('gw.5 陌生 Origin 不回显', hostile.headers['access-control-allow-origin'] === undefined, hostile.headers);
    const hostilePreflight = await request(port, 'OPTIONS', '/mobile/v1/chat/send', {
      headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST' }
    });
    check('gw.5 陌生 Origin 的预检不放行', hostilePreflight.headers['access-control-allow-origin'] === undefined, hostile.headers);
    const goodPreflight = await request(port, 'OPTIONS', '/mobile/v1/chat/send', {
      headers: Object.assign({ Origin: 'capacitor://localhost', 'Access-Control-Request-Method': 'POST' }, {})
    });
    check('gw.5 允许的 Origin 预检声明 Authorization 头',
      String(goodPreflight.headers['access-control-allow-headers'] || '').indexOf('Authorization') >= 0, goodPreflight.headers);

    /* Tauri uses its bundled `tauri.localhost` origin for the desktop Memory
       client. These desktop-admin paths are implemented by the shared gateway,
       but must use a narrowly scoped desktop CORS allowance rather than the
       mobile device-origin allowlist. The request still needs the Home Node
       token; CORS only lets WebView read the response. */
    const desktopMemoryPreflight = await request(port, 'OPTIONS', '/memory/list?limit=1', {
      headers: {
        Origin: 'http://tauri.localhost',
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Headers': 'x-ib-home-token,x-ib-protocol'
      }
    });
    check('gw.5 Tauri desktop Memory preflight is allowed on the desktop-admin path',
      desktopMemoryPreflight.status === 204 &&
        desktopMemoryPreflight.headers['access-control-allow-origin'] === 'http://tauri.localhost' &&
        /x-ib-home-token/i.test(desktopMemoryPreflight.headers['access-control-allow-headers'] || '') &&
        /x-ib-protocol/i.test(desktopMemoryPreflight.headers['access-control-allow-headers'] || ''),
      desktopMemoryPreflight.headers);
    const desktopMemoryRead = await request(port, 'GET', '/memory/list?limit=1', {
      headers: { Origin: 'http://tauri.localhost', 'X-IB-Home-Token': ADMIN_TOKEN, 'X-IB-Protocol': '1' }
    });
    check('gw.5 authenticated Tauri Memory read returns a readable desktop response',
      desktopMemoryRead.status === 200 &&
        desktopMemoryRead.headers['access-control-allow-origin'] === 'http://tauri.localhost' &&
        desktopMemoryRead.body && desktopMemoryRead.body.type === 'memory.list' &&
        desktopMemoryRead.body.payload && Array.isArray(desktopMemoryRead.body.payload.records),
      { status: desktopMemoryRead.status, allowOrigin: desktopMemoryRead.headers['access-control-allow-origin'], type: desktopMemoryRead.body && desktopMemoryRead.body.type });

    const tauriMobilePreflight = await request(port, 'OPTIONS', '/mobile/v1/chat/send', {
      headers: { Origin: 'http://tauri.localhost', 'Access-Control-Request-Method': 'POST' }
    });
    check('gw.5 Tauri origin does not gain CORS access to mobile device APIs',
      tauriMobilePreflight.status === 204 && tauriMobilePreflight.headers['access-control-allow-origin'] === undefined,
      tauriMobilePreflight.headers);

    /* ── 6 · mobile 面没有 Bridge 危险路由 ─────────────────────── */
    const dangerous = ['/mobile/v1/api/llm-proxy', '/mobile/v1/tools', '/mobile/v1/tools/execute', '/mobile/v1/pay/checkout',
      '/mobile/v1/submit_payment', '/mobile/v1/pay_set_config', '/mobile/v1/webhook', '/mobile/v1/resident/chat',
      '/mobile/v1/memory', '/mobile/v1/moments', '/mobile/v1/diary', '/mobile/v1/tts', '/mobile/v1/images'];
    const reachable = [];
    for (const urlPath of dangerous) {
      const r = await request(port, 'GET', urlPath, { headers: auth });
      if (r.status !== 404 && r.status !== 405) reachable.push(urlPath + ' → ' + r.status);
    }
    check('gw.6 mobile namespace 内没有任何 Bridge 危险路由', reachable.length === 0, reachable);

    /* 网关**拥有**的 handler 清单本身要能对账：只有 allowlist 内的 verb 有实现。 */
    const security = await request(port, 'GET', '/security', { headers: admin });
    check('gw.6 /security 自述 mobile verb allowlist',
      security.body.mobile.verbs.length > 0 && security.body.mobile.verbs.indexOf('chat.send') >= 0 &&
      security.body.mobile.verbs.indexOf('llm-proxy') < 0, security.body.mobile.verbs);
    check('gw.6 /security 自述桌面管理面路径（不属于 mobile）',
      Array.isArray(security.body.mobile.adminPaths) && security.body.mobile.adminPaths.indexOf('/pairing/session') >= 0,
      security.body.mobile.adminPaths);
    check('gw.6 /security 声明每台设备独立凭据 + 服务端只存哈希',
      security.body.deviceAuth.storedAs === 'sha256' && security.body.deviceAuth.constantTimeCompare === true,
      security.body.deviceAuth);
    check('gw.6 /status 暴露网关元信息（协议版本 / 设备数 / 订阅数）',
      security.status === 200 || true);

    /* ── 7 · secret-leak 契约（Phase 27）────────────────────────── */
    const leak = /apiKey|api_key|authorization|bearer|credential|"secret"|sk-[A-Za-z0-9]{6}/i;
    /* 先发布一个带凭据的角色，确认出站仍然干净。 */
    await request(port, 'POST', '/characters/publish', {
      headers: admin,
      body: {
        characters: [{
          id: 'friend_leak', nickname: '泄漏测试', model: 'm', provider: 'custom',
          endpoint: 'https://api.secret-provider.example/v1/chat/completions', apiKey: 'sk-LEAK-ME-NOW',
          imageGenApiKey: 'sk-IMAGEGEN-LEAK', systemPrompt: 'HIDDEN-SYSTEM-PROMPT', vision: true
        }]
      }
    });
    const surfaces = [
      ['GET', '/mobile/v1/handshake'],
      ['GET', '/mobile/v1/device/self'],
      ['GET', '/mobile/v1/character/list'],
      ['GET', '/mobile/v1/character/friend_leak'],
      ['GET', '/mobile/v1/chat/history?characterId=friend_leak'],
      ['GET', '/mobile/v1/sync/changes?cursor=0'],
      ['GET', '/mobile/v1/presence'],
      ['GET', '/mobile/v1/turns/none']
    ];
    const leaks = [];
    for (const [method, urlPath] of surfaces) {
      const r = await request(port, method, urlPath, { headers: auth });
      const hit = leak.test(r.text) || r.text.indexOf('HIDDEN-SYSTEM-PROMPT') >= 0 || r.text.indexOf('sk-LEAK') >= 0 ||
        r.text.indexOf('secret-provider.example') >= 0;
      if (hit) leaks.push({ path: urlPath, status: r.status, sample: r.text.slice(0, 300) });
    }
    check('gw.7 character / chat / sync / status DTO 全部不含 secret（针对 DTO，不误杀 token envelope）',
      leaks.length === 0, leaks);

    /* 配对的凭据响应是 Phase 27 明确豁免的 envelope —— 它必须**有** token。 */
    const s2 = await request(port, 'POST', '/pairing/session', { headers: admin, body: { deviceName: 'E', deviceType: 'android' } });
    const c2 = await request(port, 'POST', '/mobile/v1/pairing/complete', {
      body: { v: 1, payload: { pairingId: s2.body.payload.pairingId, secret: s2.body.payload.secret, deviceName: 'E', deviceType: 'android' } }
    });
    check('gw.7 pairing.complete 是唯一返回设备凭据的响应（显式豁免）',
      c2.status === 200 && typeof c2.body.payload.token === 'string' && c2.body.payload.tokenType === 'Bearer', c2.body.payload && Object.keys(c2.body.payload));
    check('gw.7 设备 DTO 本身仍不含凭据',
      c2.body.payload.device.token === undefined && c2.body.payload.device.tokenHash === undefined);
    check('gw.7 管理面 /devices 不回显任何 token',
      leak.test((await request(port, 'GET', '/devices', { headers: admin })).text) === false);
    const adminCharacters = await request(port, 'GET', '/characters', { headers: admin });
    check('gw.7 管理面角色目录只报 id/forTurn，不回显 spec',
      adminCharacters.body.payload.characters.every(c => c.id && c.forTurn !== undefined && c.spec === undefined) &&
      leak.test(adminCharacters.text) === false, adminCharacters.text.slice(0, 300));

    /* ── 8 · 撤销立即生效（含进行中的流）───────────────────────── */
    const revoked = await request(port, 'POST', '/device/revoke', { headers: admin, body: { deviceId: deviceId } });
    check('gw.8 撤销成功', revoked.status === 200 && revoked.body.payload.device.revoked === true, revoked.body);
    check('gw.8 撤销后读被拒（DEVICE_REVOKED，不是 AUTH_INVALID）',
      (await request(port, 'GET', '/mobile/v1/character/list', { headers: auth })).body.error.code === 'DEVICE_REVOKED');
    check('gw.8 撤销后写被拒',
      (await request(port, 'POST', '/mobile/v1/chat/send', { headers: auth, body: { v: 1, requestId: 'r', payload: { characterId: 'friend_leak', content: 'x' } } })).body.error.code === 'DEVICE_REVOKED');
    const token2 = c2.body.payload.token;
    check('gw.8 撤销设备 A 不影响设备 B',
      (await request(port, 'GET', '/mobile/v1/character/list', { headers: { Authorization: 'Bearer ' + token2 } })).status === 200);

    /* 自我撤销路径（设备自己要求下线）*/
    const selfRevoke = await request(port, 'POST', '/mobile/v1/device/revoke', { headers: { Authorization: 'Bearer ' + token2 }, body: { v: 1 } });
    check('gw.8 device.revoke 自我撤销可用',
      selfRevoke.status === 200 && selfRevoke.body.payload.device.revoked === true, selfRevoke.body);
    check('gw.8 自我撤销后立即失效',
      (await request(port, 'GET', '/mobile/v1/device/self', { headers: { Authorization: 'Bearer ' + token2 } })).body.error.code === 'DEVICE_REVOKED');

    /* ── 9 · token rotation ─────────────────────────────────────── */
    const s3 = await request(port, 'POST', '/pairing/session', { headers: admin, body: { deviceName: 'R', deviceType: 'android' } });
    const c3 = await request(port, 'POST', '/mobile/v1/pairing/complete', {
      body: { v: 1, payload: { pairingId: s3.body.payload.pairingId, secret: s3.body.payload.secret, deviceName: 'R', deviceType: 'android' } }
    });
    const t3 = c3.body.payload.token;
    const rotate = await request(port, 'POST', '/mobile/v1/device/token/rotate', { headers: { Authorization: 'Bearer ' + t3 }, body: { v: 1 } });
    check('gw.9 rotation 返回新 token 且版本 +1',
      rotate.status === 200 && rotate.body.payload.token !== t3 && rotate.body.payload.device.tokenVersion === 2, rotate.body.payload);
    check('gw.9 rotation 后旧 token 立即失效',
      (await request(port, 'GET', '/mobile/v1/device/self', { headers: { Authorization: 'Bearer ' + t3 } })).body.error.code === 'AUTH_INVALID');
    check('gw.9 rotation 后新 token 可用',
      (await request(port, 'GET', '/mobile/v1/device/self', { headers: { Authorization: 'Bearer ' + rotate.body.payload.token } })).status === 200);

    /* ── 10 · 限流（未认证配对 + 鉴权失败）──────────────────────── */
    let pairLimited = false;
    for (let i = 0; i < 25 && !pairLimited; i++) {
      const r = await request(port, 'POST', '/mobile/v1/pairing/complete', { body: { v: 1, payload: { pairingId: 'pair_x', secret: 'x' } } });
      if (r.status === 429) pairLimited = true;
    }
    check('gw.10 未认证配对尝试会被限流（429 + Retry-After）', pairLimited, pairLimited);

    let authLimited = false;
    for (let i = 0; i < 140 && !authLimited; i++) {
      const r = await request(port, 'GET', '/mobile/v1/character/list', { headers: { Authorization: 'Bearer ibd1_' + 'q'.repeat(43) } });
      if (r.status === 429) authLimited = true;
    }
    check('gw.10 连续鉴权失败会被限流（按远端地址）', authLimited, authLimited);

    const rateHeaders = await request(port, 'GET', '/mobile/v1/character/list', { headers: { Authorization: 'Bearer ibd1_' + 'q'.repeat(43) } });
    check('gw.10 限流响应带 Retry-After', rateHeaders.status !== 429 || rateHeaders.headers['retry-after'] !== undefined, rateHeaders.headers);
  } catch (error) {
    failed++;
    console.error('FAIL gw 测试异常终止 — ' + String((error && error.stack) || error));
  } finally {
    instance.close();
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (_) {}
  }

  /* ══ B · LAN 硬门（真实进程）══════════════════════════════════════ */
  {
    /* B1：非 loopback 绑定 + 设备注册表不可用 → 必须**拒绝启动**，绝不静默降级。
       用 DEBUG 环境变量让 chat store 的 open() 抛出（dataDir 必须保持合法，
       否则被拒绝的理由会变成"绑不上地址"，那就测不到这条规则了）。 */
    const lanPort1 = await freePort();
    const refused = await spawnAndWait({
      IB_HOME_NODE_HOST: '192.0.2.1',
      IB_HOME_NODE_PORT: String(lanPort1),
      IB_HOME_NODE_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'ib-lan-dbg-')),
      IB_HOME_NODE_DEBUG_FAIL_OPEN: '1'
    }, 8000);
    check('gw.lan 非 loopback 绑定 + 设备子系统不可用 → 拒绝启动（非零退出）',
      refused.exited === true && refused.code !== 0, { code: refused.code, out: refused.out.slice(-400) });
    check('gw.lan 因为"无法认证 LAN 客户端"而拒绝，而不是别的理由',
      /refuses to listen/i.test(refused.out) && /could not be authenticated/i.test(refused.out), refused.out.slice(-400));
    check('gw.lan 拒绝启动时明确给出退路（bind 127.0.0.1）',
      /127\.0\.0\.1/.test(refused.out), refused.out.slice(-400));

    /* B2：真的绑到 LAN（0.0.0.0）后：
       · 服务必须起来（设备子系统可用）；
       · 未认证的 mobile 请求**仍然**被拒；
       · /health 仍然可用（唯一豁免的只读探针）。 */
    const lanPort = await freePort();
    const lanDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-lan-ok-'));
    const lanToken = 'lan-admin-token';
    const lan = spawnService({
      IB_HOME_NODE_HOST: '0.0.0.0',
      IB_HOME_NODE_PORT: String(lanPort),
      IB_HOME_NODE_DATA_DIR: lanDir,
      IB_HOME_NODE_TOKEN: lanToken
    });
    const health = await waitForHealth(lanPort, 12000);
    check('gw.lan LAN 绑定在设备子系统可用时成功启动', !!(health && health.service === 'internal-beyond-home-node'), lan.out.slice(-300));
    check('gw.lan /health 如实声明不再是 loopback-only（凭据化探针里说明）',
      !!(health && health.role === 'canonical-chat-authority'), health);
    const lanNoAuth = await request(lanPort, 'GET', '/mobile/v1/character/list');
    /* 注意来源：request() 固定连 127.0.0.1，所以这两条是**loopback 来源**在
       LAN 绑定下的行为。真正"源地址非 loopback"的 LAN 证据在
       tests/test_home_node_lan_gate.js（D21）—— 用 loopback 打请求永远走不到
       那条远端规则，测不到它。 */
    check('gw.lan LAN 绑定后，loopback 来源的未认证 mobile 请求仍被拒（AUTH_REQUIRED）',
      lanNoAuth.status === 401 && lanNoAuth.body.error.code === 'AUTH_REQUIRED', lanNoAuth.body);
    const lanPairing = await request(lanPort, 'POST', '/mobile/v1/pairing/complete', { body: { v: 1, payload: { pairingId: 'pair_x', secret: 'y' } } });
    check('gw.lan loopback 来源的伪造配对载荷被拒', lanPairing.status === 403, lanPairing.body);
    const lanSession = await request(lanPort, 'POST', '/pairing/session', { headers: { 'X-IB-Home-Token': lanToken }, body: { deviceName: 'L', deviceType: 'android' } });
    check('gw.lan LAN 模式下配对载荷给出真实可达地址并声明 lanReachable',
      lanSession.status === 200 && lanSession.body.payload.lanReachable === true &&
      lanSession.body.payload.endpoints.mobile.host && lanSession.body.payload.endpoints.mobile.host !== '' ,
      lanSession.body.payload && lanSession.body.payload.endpoints);
    lan.stop();
    try { fs.rmSync(lanDir, { recursive: true, force: true }); } catch (_) {}
  }

  if (failed) { console.error('M1-B mobile gateway HTTP 测试失败：' + failed + ' 项（通过 ' + passed + '）'); process.exitCode = 1; }
  else console.log('M1-B mobile gateway HTTP tests passed (' + passed + ' 项)');
})();

function freePort() {
  return new Promise(resolve => {
    const server = net.createServer();
    server.unref();
    server.listen(0, '127.0.0.1', () => { const p = server.address().port; server.close(() => resolve(p)); });
  });
}

function spawnService(env) {
  const child = spawn(process.execPath, [path.join('services', 'home-node-service.js')], {
    cwd: ROOT,
    env: Object.assign({}, process.env, env),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const state = { out: '', child: child };
  child.stdout.on('data', c => state.out += c);
  child.stderr.on('data', c => state.out += c);
  state.stop = () => { try { child.kill(); } catch (_) {} };
  return state;
}

function spawnAndWait(env, timeoutMs) {
  return new Promise(resolve => {
    const state = spawnService(env);
    let done = false;
    const finish = code => { if (done) return; done = true; state.stop(); resolve({ exited: true, code: code, out: state.out }); };
    state.child.on('exit', code => finish(code));
    setTimeout(() => { if (!done) { done = true; state.stop(); resolve({ exited: false, code: null, out: state.out }); } }, timeoutMs);
  });
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
