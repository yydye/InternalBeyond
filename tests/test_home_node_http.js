'use strict';
/* Internal Beyond · Home Node HTTP 集成测试（service 组，随机端口 + 临时数据目录）
   运行：node tests/test_home_node_http.js
   真实 spawn services/home-node-service.js，只打真实 HTTP。
   验证：健康身份 / 单条与批量写 / 幂等 / 读取分页 / changes 游标 / 删除 /
         迁移标记可重复 / integrity / token 鉴权 / 体积与 schema 校验 /
         越界路由不存在 / 重启后历史仍在。 */
const { spawn } = require('child_process');
const http = require('http');
const os = require('os');
const path = require('path');
const fs = require('fs');
const homeNodeIdentity = require('../runtime/home-node-identity.js');

const ROOT = path.resolve(__dirname, '..');
const PORT = 24500 + Math.floor(Math.random() * 400);
const BASE = 'http://127.0.0.1:' + PORT;
const TOKEN = 'test-home-token-0123456789';
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-home-node-'));
let passed = 0, failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log('✔ ' + name); }
  else { failed++; console.error('✖ ' + name + (extra !== undefined ? ' — ' + JSON.stringify(extra) : '')); }
}

function req(method, urlPath, body, headers) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const r = http.request(BASE + urlPath, {
      method,
      headers: Object.assign(data ? { 'Content-Type': 'application/json' } : {}, headers || {})
    }, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        let parsed = null;
        try { parsed = raw ? JSON.parse(raw) : {}; } catch (_) { parsed = { raw }; }
        resolve({ status: res.statusCode, body: parsed, headers: res.headers });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

async function waitForHealth(timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const r = await req('GET', '/health');
      if (r.status === 200 && r.body.ok) return r.body;
    } catch (_) { /* 还没起来 */ }
    await new Promise(r => setTimeout(r, 150));
  }
  return null;
}

function spawnService() {
  const child = spawn(process.execPath, ['services/home-node-service.js'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      IB_HOME_NODE_PORT: String(PORT),
      IB_HOME_NODE_DATA_DIR: DATA_DIR,
      IB_HOME_NODE_TOKEN: TOKEN
    }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let out = '';
  child.stdout.on('data', c => out += c);
  child.stderr.on('data', c => out += c);
  return { child, output: () => out };
}

const msg = (id, over) => Object.assign({
  id: id, role: 'user', content: 'c-' + id, friendId: 'char_a', timestamp: 1000
}, over || {});
let _tsSeq = 1000;
const nextTs = () => ++_tsSeq;

(async () => {
  let svc = spawnService();
  try {
    const health = await waitForHealth(15000);
    check('http.health 服务启动并响应', !!health, svc.output().slice(-400));
    if (!health) { console.error(svc.output()); return; }
    check('http.health 身份正确（matchesHealth 契约）', health.service === 'internal-beyond-home-node', health.service);
    check('http.health 声明 canonical 角色', health.role === 'canonical-chat-authority', health.role);
    check('http.health 回报匹配的数据目录指纹与协议版本',
      health.protocolVersion === homeNodeIdentity.HOME_NODE_PROTOCOL_VERSION &&
        health.dataDirectoryId === homeNodeIdentity.dataDirectoryId(DATA_DIR),
      { protocolVersion: health.protocolVersion, dataDirectoryMatches: health.dataDirectoryId === homeNodeIdentity.dataDirectoryId(DATA_DIR) });
    check('http.health schemaVersion = 1', health.schemaVersion === 1, health.schemaVersion);
    check('http.health 无需 token（探针零数据）', health.messages === 0 && health.revision === 0);

    /* ── 鉴权 ── */
    const noAuth = await req('GET', '/meta');
    check('http.auth 无 token → 401 unauthenticated', noAuth.status === 401 && noAuth.body.error === 'unauthenticated', noAuth.body);
    const badAuth = await req('GET', '/meta', null, { 'X-IB-Home-Token': 'wrong' });
    check('http.auth 错误 token → 401', badAuth.status === 401);
    const bearer = await req('GET', '/meta', null, { Authorization: 'Bearer ' + TOKEN });
    check('http.auth Bearer 可用', bearer.status === 200 && bearer.body.ok);
    const AUTH = { 'X-IB-Home-Token': TOKEN };

    /* ── 单条写 + 幂等 ── */
    const put1 = await req('POST', '/messages', { message: msg('msg_1_u', { timestamp: nextTs() }) }, AUTH);
    check('http.put 单条创建 → created', put1.status === 200 && put1.body.outcome === 'created', put1.body);
    check('http.put 返回 revision=1', put1.body.revision === 1, put1.body.revision);
    check('http.put conversationId 派生正确', put1.body.conversationId === 'dm:char_a', put1.body.conversationId);
    const put1again = await req('POST', '/messages', { message: msg('msg_1_u', { timestamp: 1001 }) }, AUTH);
    check('http.put 相同内容重复写 → skipped 且 revision 不动',
      put1again.body.outcome === 'skipped' && put1again.body.revision === 1, put1again.body);
    const put1changed = await req('POST', '/messages', { message: msg('msg_1_u', { content: 'edited', timestamp: 1001 }) }, AUTH);
    check('http.put 同 id 内容变化 → updated 且 revision 前进',
      put1changed.body.outcome === 'updated' && put1changed.body.revision === 2, put1changed.body);

    const ridPut = await req('POST', '/messages', { message: msg('msg_req_u', { timestamp: nextTs() }), requestId: 'rid-1' }, AUTH);
    const ridPut2 = await req('POST', '/messages', { message: msg('msg_req_u2', { timestamp: nextTs() }), requestId: 'rid-1' }, AUTH);
    check('http.put requestId 幂等 → duplicate-request 且返回原 id',
      ridPut2.body.outcome === 'duplicate-request' && ridPut2.body.id === 'msg_req_u', ridPut2.body);
    check('http.put requestId 幂等：第二条消息未被写入',
      (await req('GET', '/message?id=msg_req_u2', null, AUTH)).status === 404);

    /* ── 批量 + 校验 ── */
    const batch = await req('POST', '/messages', {
      messages: [
        msg('msg_b1_u', { timestamp: 2003 }),
        msg('msg_b2_u', { role: 'assistant', content: 'r', timestamp: 2004 }),
        msg('msg_t_u', { threadId: 't1', timestamp: 2005 })
      ]
    }, AUTH);
    check('http.batch 批量创建 → batch 摘要',
      batch.body.outcome === 'batch' && batch.body.summary.created === 3, batch.body);
    const badBatch = await req('POST', '/messages', { messages: [msg('msg_good_u'), { id: 'x', role: 'user' }] }, AUTH);
    check('http.batch 任一条非法 → 整批 422 且不写入',
      badBatch.status === 422 && badBatch.body.error === 'invalid-message' && badBatch.body.index === 1, badBatch.body);
    check('http.batch 整批拒绝后第一条也未写入',
      (await req('GET', '/message?id=msg_good_u', null, AUTH)).status === 404);
    const tooBig = await req('POST', '/messages', { messages: new Array(501).fill(null).map((_, i) => msg('m' + i)) }, AUTH);
    check('http.batch 超批量上限 → 413', tooBig.status === 413 && tooBig.body.error === 'batch-too-large', tooBig.body);
    const badJson = await req('POST', '/messages', '{not json', AUTH);
    check('http.body 非法 JSON → 400 bad-json', badJson.status === 400 && badJson.body.error === 'bad-json', badJson.body);

    /* ── 读：单条 / 列表 / 分页 / 分线程 ── */
    const one = await req('GET', '/message?id=msg_b2_u', null, AUTH);
    check('http.get 单条读回', one.status === 200 && one.body.message.id === 'msg_b2_u' && one.body.message.content === 'r');
    check('http.get 未知 id → 404', (await req('GET', '/message?id=nope', null, AUTH)).status === 404);

    const list = await req('GET', '/list?conversationId=dm:char_a&limit=50', null, AUTH);
    check('http.list 只返回该会话（thread 不串）',
      list.body.messages.every(m => !m.threadId) && list.body.messages.length === 4, list.body.messages.map(m => m.id));
    const listThread = await req('GET', '/list?conversationId=dm:char_a%7Ct1', null, AUTH);
    check('http.list 按派生 conversationId 精确命中 thread',
      listThread.body.messages.length === 1 && listThread.body.messages[0].id === 'msg_t_u', listThread.body.messages);
    const listByFriend = await req('GET', '/list?friendId=char_a&limit=50', null, AUTH);
    check('http.list friendId 等价于主会话（与 byFriend 读路径同语义）',
      listByFriend.body.messages.length === 4, listByFriend.body.messages.length);

    /* 分页稳定性：默认取最新一页，再用 cursor=oldest 逐页向前，覆盖全部且不重不漏 */
    const pages = await req('GET', '/list?conversationId=dm:char_a&limit=2', null, AUTH);
    const seen = pages.body.messages.map(m => m.id).slice();
    check('http.pagination 默认取最新一页且 hasNewer=false', pages.body.hasNewer === false && pages.body.hasOlder === true, { hasNewer: pages.body.hasNewer, hasOlder: pages.body.hasOlder });
    let cursor = pages.body.oldest;
    for (let guard = 0; guard < 10; guard++) {
      if (!cursor) break;
      const page = await req('GET', '/list?conversationId=dm:char_a&limit=2&cursor=' + encodeURIComponent(cursor.id), null, AUTH);
      if (!page.body.messages.length) break;
      seen.unshift(...page.body.messages.map(m => m.id));
      if (!page.body.hasOlder) break;
      cursor = page.body.oldest;
    }
    check('http.pagination cursor=oldest 逐页向前不重不漏',
      new Set(seen).size === seen.length && seen.length === 4, seen);
    check('http.pagination 向前翻页得到完整时间升序序列（最新一页的末条 == 全量最后一条）',
      seen[seen.length - 1] === pages.body.messages[pages.body.messages.length - 1].id, seen);
    /* 同毫秒内用 insert_seq 做稳定次序（keyset 分页必须在这里也不重不漏）。 */
    const tieBatch = await req('POST', '/messages', {
      messages: [
        msg('msg_tie_a_u', { timestamp: 999000 }),
        msg('msg_tie_b_u', { timestamp: 999000 }),
        msg('msg_tie_c_u', { timestamp: 999000 })
      ]
    }, AUTH);
    check('http.pagination 同毫秒批量写入成功', tieBatch.body.summary.created === 3, tieBatch.body.summary);
    const tieSeen = [];
    let tieCursor = null;
    for (let guard = 0; guard < 12; guard++) {
      const q = '/list?conversationId=dm:char_a&limit=1';
      const page = await req('GET', tieCursor ? q + '&cursor=' + encodeURIComponent(tieCursor.id) : q, null, AUTH);
      if (!page.body.messages.length) break;
      tieSeen.unshift(...page.body.messages.map(m => m.id));
      if (!page.body.hasOlder) break;
      tieCursor = page.body.oldest;
    }
    check('http.pagination 同毫秒 (timestamp,insert_seq) keyset 稳定不重不漏',
      new Set(tieSeen).size === tieSeen.length && tieSeen.length === 7, tieSeen);
    check('http.pagination 同毫秒内保持写入次序（同毫秒三条按写入先后排列）',
      tieSeen.join(',').indexOf('msg_tie_a_u') < tieSeen.join(',').indexOf('msg_tie_b_u') &&
      tieSeen.join(',').indexOf('msg_tie_b_u') < tieSeen.join(',').indexOf('msg_tie_c_u'), tieSeen);
    const ascending = await req('GET', '/list?conversationId=dm:char_a&limit=50', null, AUTH);
    const ts = ascending.body.messages.map(m => m.timestamp);
    check('http.list 结果按 (timestamp, id) 升序稳定',
      ts.every((v, i) => i === 0 || ts[i - 1] <= v), ts);
    check('http.list 非法范围（before+after 同时给）→ 400',
      (await req('GET', '/list?conversationId=dm:char_a&before=1&after=2', null, AUTH)).body.error === 'ambiguous-range');
    check('http.list 未知 anchor → 400 unknown-anchor',
      (await req('GET', '/list?conversationId=dm:char_a&before=zzz', null, AUTH)).body.error === 'unknown-anchor');

    /* ── changes 游标 ── */
    const changes = await req('GET', '/changes?cursor=0', null, AUTH);
    check('http.changes 从 0 起返回全部 upsert', changes.body.upserts.length >= 6 && changes.body.deletes.length === 0, changes.body.upserts.length);
    check('http.changes cursor 单调且有界', typeof changes.body.cursor === 'number' && changes.body.cursor === changes.body.revision);
    const changesTail = await req('GET', '/changes?cursor=' + changes.body.cursor, null, AUTH);
    check('http.changes 游标到位后无新增', changesTail.body.upserts.length === 0 && changesTail.body.deletes.length === 0);
    check('http.changes 非法游标 → 400 bad-cursor',
      (await req('GET', '/changes?cursor=-5', null, AUTH)).body.error === 'bad-cursor');

    /* ── 删除 ── */
    const del = await req('DELETE', '/message?id=msg_b1_u', null, AUTH);
    check('http.delete 删除成功', del.body.outcome === 'deleted' && del.body.deleted === true, del.body);
    check('http.delete 删除后默认读不到', (await req('GET', '/message?id=msg_b1_u', null, AUTH)).status === 404);
    check('http.delete includeDeleted=1 能看到 tombstone',
      (await req('GET', '/message?id=msg_b1_u&includeDeleted=1', null, AUTH)).body.message.__malformedPayload === undefined);
    const del2 = await req('DELETE', '/message?id=msg_b1_u', null, AUTH);
    check('http.delete 重复删除 → not-present（幂等）', del2.body.outcome === 'not-present', del2.body);
    const changesDel = await req('GET', '/changes?cursor=' + (del.body.revision - 1), null, AUTH);
    check('http.changes 删除以 message.deleted 形式出现',
      changesDel.body.deletes.some(d => d.messageId === 'msg_b1_u'), changesDel.body.deletes);

    /* ── 迁移标记可重复运行 ── */
    const m1 = await req('POST', '/migrate', { source: 'browser:file', version: 1, lastTimestamp: 5000, messages: 12 }, AUTH);
    check('http.migrate 写入迁移标记', m1.body.state.version === 1 && m1.body.state.lastTimestamp === 5000, m1.body);
    const m2 = await req('POST', '/migrate', { source: 'browser:file', version: 2, lastTimestamp: 3000, messages: 12 }, AUTH);
    check('http.migrate 可重复运行且水位不回退',
      m2.body.state.version === 2 && m2.body.state.lastTimestamp === 5000, m2.body.state);
    const mRead = await req('GET', '/migration?source=browser:file', null, AUTH);
    check('http.migrate 标记可读回', mRead.body.state.version === 2 && mRead.body.state.lastTimestamp === 5000, mRead.body);

    /* ── integrity / 备份 / 安全面 ── */
    const verify = await req('GET', '/verify', null, AUTH);
    check('http.verify integrity_check = ok', verify.body.integrity.ok === true && verify.body.integrity.result === 'ok', verify.body.integrity);
    const backup = await req('GET', '/verify?backup=1', null, AUTH);
    check('http.backup 生成在线备份', backup.status === 200 && backup.body.backup && backup.body.backup.bytes > 0, backup.body.backup);
    check('http.backup 备份文件名落在数据目录且不泄露路径',
      /^home-node\.bak-.*\.db$/.test(String(backup.body.backup.file)), backup.body.backup && backup.body.backup.file);
    const backupFile = path.join(DATA_DIR, String(backup.body.backup.file));
    check('http.backup 备份文件真实存在且非空', fs.existsSync(backupFile) && fs.statSync(backupFile).size > 0);
    check('http.backup 备份是可读的 SQLite 库（历史可恢复）',
      (function () {
        try {
          const { DatabaseSync } = require('node:sqlite');
          const copy = new DatabaseSync(backupFile);
          const row = copy.prepare('SELECT COUNT(*) AS c FROM messages').get();
          copy.close();
          return !!row && row.c > 0;
        } catch (error) { return false; }
      })());
    const security = await req('GET', '/security', null, AUTH);
    check('http.security 明确声明 loopback-only 与 token 状态',
      security.body.loopbackOnly === true && security.body.tokenRequired === true, security.body);
    check('http.security 声明不暴露 llm-proxy / tools / payments',
      security.body.doesNotExpose.includes('llm-proxy') && security.body.doesNotExpose.includes('tools') && security.body.doesNotExpose.includes('payments'));
    const status = await req('GET', '/status', null, AUTH);
    check('http.status 暴露 revision / messages / 日志环', status.body.meta.revision > 0 && Array.isArray(status.body.log));
    check('http.status 日志环不含正文与密钥',
      !JSON.stringify(status.body.log).includes('edited') && !JSON.stringify(status.body.log).includes(TOKEN));

    /* ── 越界路由不存在（M1-A 的前置边界）── */
    for (const route of ['/api/llm-proxy', '/api/tools', '/api/ai/chat', '/pair']) {
      const r = await req('GET', route, null, AUTH);
      check('http.boundary ' + route + ' 不存在', r.status === 404 || r.status === 204, r.status);
    }
    check('http.boundary 不接受 Mobile Gateway 风格的 envelope',
      (await req('POST', '/', { v: 1, type: 'chat.send', payload: {} }, AUTH)).status === 404);
    /* M1-B：/devices 现在是**桌面管理面**的真实端点（设备列表），
       因此它不再属于"不存在的路由"。这里断言的新不变量更强：
       它存在，但未认证拿不到，且 DTO 里没有任何凭据。 */
    const devicesAnon = await req('GET', '/devices');
    check('http.admin /devices 未认证被拒（401）', devicesAnon.status === 401, devicesAnon.status);
    const devices = await req('GET', '/devices', null, AUTH);
    check('http.admin /devices 认证后可读且为空（尚无设备）',
      devices.status === 200 && devices.body.ok === true && Array.isArray(devices.body.payload.devices) &&
      devices.body.payload.devices.length === 0, devices.body);
    check('http.admin /devices 不回显任何凭据',
      !JSON.stringify(devices.body).match(/token|secret|apiKey/i), devices.body);
    /* /mobile/v1/* 是设备面：没有设备 token 一律拒绝，且不属于桌面 token 管辖。 */
    const mobileAnon = await req('GET', '/mobile/v1/character/list', null, AUTH);
    check('http.boundary /mobile/v1/* 用设备 token 鉴权（桌面 token 不够）',
      mobileAnon.status === 401 && mobileAnon.body.error.code === 'AUTH_REQUIRED', mobileAnon.body);

    /* ── CORS：不对任意 Origin 回显（与 D1 风险接受一致的最小收紧）── */
    const cors = await req('GET', '/health', null, { Origin: 'https://evil.example' });
    check('http.cors 未白名单 Origin 不回显 ACAO', !cors.headers['access-control-allow-origin'], cors.headers['access-control-allow-origin']);
  } finally {
    try { svc.child.kill(); } catch (_) { /* 已退出 */ }
    await new Promise(r => setTimeout(r, 350));
  }

  /* ── 重启持久化 ── */
  svc = spawnService();
  try {
    const health = await waitForHealth(15000);
    check('http.restart 服务可重启', !!health);
    const AUTH = { 'X-IB-Home-Token': TOKEN };
    const list = await req('GET', '/list?conversationId=dm:char_a', null, AUTH);
    check('http.restart 重启后历史仍在', list.body.messages.length === 6, list.body.messages.length);    check('http.restart revision 未回退', health.revision >= 10, health.revision);
    const mig = await req('GET', '/migration?source=browser:file', null, AUTH);
    check('http.restart 迁移标记持久', mig.body.state.version === 2);
    const dup = await req('POST', '/messages', { messages: [msg('msg_b2_u', { role: 'assistant', content: 'r', timestamp: 2004 })], forceBatch: true }, AUTH);
    check('http.restart 重启后重复迁移仍为 skipped（同内容不覆盖、不新增版本）',
      dup.body.summary.skipped === 1, dup.body.summary);
  } finally {
    try { svc.child.kill(); } catch (_) { /* 已退出 */ }
    await new Promise(r => setTimeout(r, 200));
  }

  /* ── SQLite 损坏：隔离保留坏文件 + 新库可用（Phase 16 失败语义）── */
  {
    const dbPath = path.join(DATA_DIR, 'home-node.db');
    const listQuarantined = () => fs.readdirSync(DATA_DIR).filter(f => /\.corrupt-.*\.db$/.test(f));
    const before = listQuarantined().length;
    /* 破坏 SQLite 文件头（前 16 字节 magic） */
    const buf = fs.readFileSync(dbPath);
    buf.write('THIS-IS-NOT-SQLI', 0, 'utf8');
    fs.writeFileSync(dbPath, buf);

    svc = spawnService();
    try {
      const health = await waitForHealth(15000);
      check('http.corrupt 损坏库不会卡住服务启动', !!health, svc.output().slice(-400));
      const quarantined = listQuarantined();
      check('http.corrupt 坏文件被改名保留（不删除）', quarantined.length === before + 1, fs.readdirSync(DATA_DIR));
      const kept = quarantined[quarantined.length - 1];
      check('http.corrupt 保留文件里还是原来的字节（未销毁）',
        !!kept && fs.readFileSync(path.join(DATA_DIR, kept)).slice(0, 16).toString('utf8') === 'THIS-IS-NOT-SQLI',
        kept ? fs.readFileSync(path.join(DATA_DIR, kept)).slice(0, 16).toString('utf8') : null);
      const AUTH = { 'X-IB-Home-Token': TOKEN };
      const after = await req('POST', '/messages', { message: msg('msg_after_corrupt_u', { timestamp: 900000 }) }, AUTH);
      check('http.corrupt 新库可正常写入', after.status === 200 && after.body.outcome === 'created', after.body);
      const verify = await req('GET', '/verify', null, AUTH);
      check('http.corrupt 新库 integrity = ok', verify.body.integrity.ok === true, verify.body.integrity);
      check('http.corrupt 服务日志明确报出隔离事件',
        /corrupt-quarantined|corrupt/i.test(svc.output()), svc.output().slice(-400));
    } finally {
      try { svc.child.kill(); } catch (_) { /* 已退出 */ }
      await new Promise(r => setTimeout(r, 200));
    }
  }

  console.log('');
  if (failed) { console.error('Home Node HTTP 测试失败：' + failed + ' 项 ✘（通过 ' + passed + '）'); process.exitCode = 1; }
  else console.log('Home Node HTTP tests passed ✔ (' + passed + ' 项)');
})().catch(error => {
  console.error(error && error.stack || error);
  try { svc.child.kill(); } catch (_) { /* 已退出 */ }
  process.exitCode = 1;
});
