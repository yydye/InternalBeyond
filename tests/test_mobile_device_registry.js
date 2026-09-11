'use strict';
/* ====================================================================
   Internal Beyond · M1-B Device Registry + Pairing（static 组，零依赖）
   运行：node tests/test_mobile_device_registry.js

   直接测领域层（services/home-node/device-registry.js），不经过 HTTP：
     · 设备签发 / 校验 / rotation / 撤销的语义；
     · **服务端从不保存 raw token**（只存 SHA-256）；
     · 配对会话：短时、单次、原子消费、并发双消费只有一个成功；
     · 重启后仍然有效（凭据在 SQLite，不在内存）；
     · 两台设备彼此独立（撤销一台不影响另一台）；
     · character catalog 的 DTO 与 runtime spec 在同库里但结构上分离。
   ==================================================================== */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const createDeviceRegistry = require('../services/home-node/device-registry.js');
const MOBILE_DTO = require('../assets/js/mobile-dto.js');

let passed = 0, failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log('OK   ' + name); }
  else { failed++; console.error('FAIL ' + name + (extra !== undefined ? ' — ' + JSON.stringify(extra) : '')); }
}

let fakeNow = 1700000000000;
const clock = () => fakeNow;

function newRegistry(overrides) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-devreg-'));
  const registry = createDeviceRegistry(Object.assign({
    dataDir: dir, clock: clock, logger: () => {}
  }, overrides || {}));
  registry.open();
  return { registry: registry, dir: dir };
}

(async () => {
  /* ── 1 · 未打开时的行为：明确失败，不静默 success ─────────────────── */
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-devreg-closed-'));
    const closed = createDeviceRegistry({ dataDir: dir, clock: clock });
    check('reg.closed.isOpen false', closed.isOpen() === false);
    check('reg.closed.createPairingSession 明确失败',
      closed.createPairingSession({}).ok === false && closed.createPairingSession({}).code === 'STORE_CLOSED');
    check('reg.closed.verifyDeviceToken 明确失败', closed.verifyDeviceToken('ibd1_x').code === 'STORE_CLOSED');
    check('reg.closed.listDevices 返回空数组', Array.isArray(closed.listDevices()) && closed.listDevices().length === 0);
  }

  /* ── 2 · open 幂等 + schema 版本独立于 chat store ─────────────────── */
  {
    const env = newRegistry();
    const again = env.registry.open();
    check('reg.open 幂等（alreadyOpen）', again.ok === true && again.alreadyOpen === true, again);
    const meta = env.registry.meta();
    check('reg.meta 自述 schema 与计数', meta.ok === true && meta.schemaVersion === 1 && meta.devices === 0 && meta.characters === 0, meta);
    /* 设备层用自己的 meta key，与 chat store 的 meta.schema_version 不冲突。 */
    const sqlite = require('node:sqlite');
    const db = new sqlite.DatabaseSync(path.join(env.dir, 'home-node.db'));
    const keys = db.prepare('SELECT key FROM meta ORDER BY key').all().map(r => r.key);
    db.close();
    check('reg.schema key 与 chat store 的 schema_version 分离',
      keys.indexOf('devices_schema') >= 0 && keys.indexOf('schema_version') < 0, keys);
  }

  /* ── 3 · 配对会话：高熵、TTL、单次、原子 ─────────────────────────── */
  {
    const env = newRegistry();
    const registry = env.registry;
    const session = registry.createPairingSession({ deviceName: 'Phone', deviceType: 'android' });
    check('pair.create 成功', session.ok === true, session);
    check('pair.secret 是 32 字节 base64url（≥40 字符）',
      typeof session.secret === 'string' && session.secret.length >= 40 && /^[A-Za-z0-9_-]+$/.test(session.secret), session.secret && session.secret.length);
    check('pair.pairingId 是随机 id（不是短数字码）',
      /^pair_[A-Za-z0-9_-]{10,}$/.test(session.pairingId), session.pairingId);
    check('pair.expiresAt = createdAt + ttl', session.expiresAt === session.createdAt + session.ttlMs, session);
    check('pair.fingerprint 存在且非空', typeof session.fingerprint === 'string' && session.fingerprint.length >= 8, session.fingerprint);
    /* 两次创建必须得到**不同**的 secret/id（随机性） */
    const s2 = registry.createPairingSession({});
    check('pair.两次创建互不相同', s2.secret !== session.secret && s2.pairingId !== session.pairingId);

    /* 状态查询 */
    const status = registry.pairingStatus(session.pairingId);
    check('pair.status 反映未使用未过期', status.ok && status.used === false && status.expired === false, status);
    check('pair.status 未知 id 明确失败', registry.pairingStatus('pair_nope').code === 'PAIRING_NOT_FOUND');

    /* 错误 secret */
    const bad = registry.consumePairingSession({ pairingId: session.pairingId, secret: 'wrong' });
    check('pair.错误 secret → PAIRING_INVALID（且不泄漏 id 是否存在）',
      bad.ok === false && bad.code === 'PAIRING_INVALID', bad);
    check('pair.错误 secret 不会消费掉会话', registry.pairingStatus(session.pairingId).used === false);

    /* 正确消费 */
    const ok = registry.consumePairingSession({ pairingId: session.pairingId, secret: session.secret, deviceName: 'My Phone', deviceType: 'android' });
    check('pair.正确 secret → 签发设备', ok.ok === true && ok.device && /^dev_/.test(ok.device.deviceId), ok.ok && ok.device);
    check('pair.签发的 token 不可读且带格式版本', /^ibd1_[A-Za-z0-9_-]{40,}$/.test(ok.token), ok.token && ok.token.slice(0, 10));
    check('pair.设备默认能力是显式 allowlist',
      JSON.stringify(ok.device.capabilities) === JSON.stringify(['chat', 'sync', 'notify']), ok.device.capabilities);

    /* 单次使用 */
    const reuse = registry.consumePairingSession({ pairingId: session.pairingId, secret: session.secret });
    check('pair.同一会话第二次消费 → PAIRING_USED', reuse.ok === false && reuse.code === 'PAIRING_USED', reuse);
    check('pair.第二次没有签发新设备', registry.meta().devices === 1, registry.meta().devices);
  }

  /* ── 4 · 过期 ─────────────────────────────────────────────────────── */
  {
    const env = newRegistry({ pairingTtlMs: 60000 });
    const registry = env.registry;
    const session = registry.createPairingSession({});
    fakeNow += 60001;
    const expired = registry.consumePairingSession({ pairingId: session.pairingId, secret: session.secret });
    check('pair.过期后消费 → PAIRING_EXPIRED', expired.ok === false && expired.code === 'PAIRING_EXPIRED', expired);
    check('pair.过期会话不签发设备', registry.meta().devices === 0);
    check('pair.status 如实报告 expired', registry.pairingStatus(session.pairingId).expired === true);
  }

  /* ── 5 · 并发双消费：只有一个成功（这是"单次使用"的真正执行点）───── */
  {
    const env = newRegistry();
    const registry = env.registry;
    const session = registry.createPairingSession({});
    /* consumePairingSession 是同步的（node:sqlite 同步 API），因此两次调用
       天然串行 —— 但仍然要断言"条件 UPDATE"确实生效：第二次必须拿到
       PAIRING_USED，而不是又签发一台设备。 */
    const first = registry.consumePairingSession({ pairingId: session.pairingId, secret: session.secret, deviceName: 'A' });
    const second = registry.consumePairingSession({ pairingId: session.pairingId, secret: session.secret, deviceName: 'B' });
    check('pair.并发/连续双消费只有一个成功',
      first.ok === true && second.ok === false && second.code === 'PAIRING_USED', { first: first.ok, second: second.code });
    check('pair.双消费只签发一台设备', registry.listDevices({}).length === 1, registry.listDevices({}).length);
    check('pair.会话记录了被哪台设备用掉',
      registry.pairingStatus(session.pairingId).consumedBy === first.device.deviceId,
      registry.pairingStatus(session.pairingId));
  }

  /* ── 6 · 缺参 / 畸形输入 ─────────────────────────────────────────── */
  {
    const env = newRegistry();
    const registry = env.registry;
    check('pair.缺 pairingId → PAIRING_INVALID', registry.consumePairingSession({ secret: 'x' }).code === 'PAIRING_INVALID');
    check('pair.缺 secret → PAIRING_INVALID', registry.consumePairingSession({ pairingId: 'pair_x' }).code === 'PAIRING_INVALID');
    check('pair.空白 secret → PAIRING_INVALID', registry.consumePairingSession({ pairingId: 'pair_x', secret: '   ' }).code === 'PAIRING_INVALID');
  }

  /* ── 7 · token 校验 ──────────────────────────────────────────────── */
  {
    const env = newRegistry();
    const registry = env.registry;
    const issued = registry.issueDevice({ name: 'Tablet', type: 'tablet' });
    check('dev.issue 成功', issued.ok === true && issued.device.name === 'Tablet' && issued.device.type === 'tablet', issued.device);

    const verified = registry.verifyDeviceToken(issued.token);
    check('dev.verify 正确 token → 设备', verified.ok === true && verified.device.deviceId === issued.device.deviceId, verified.ok);

    check('dev.verify 空 token → AUTH_REQUIRED', registry.verifyDeviceToken('').code === 'AUTH_REQUIRED');
    check('dev.verify 畸形 token → AUTH_INVALID', registry.verifyDeviceToken('not-a-token').code === 'AUTH_INVALID');
    check('dev.verify 未知格式版本 → AUTH_INVALID',
      registry.verifyDeviceToken('ibd9_' + 'a'.repeat(43)).code === 'AUTH_INVALID');
    check('dev.verify 伪造 token → AUTH_INVALID',
      registry.verifyDeviceToken('ibd1_' + 'A'.repeat(43)).code === 'AUTH_INVALID');

    /* 篡改一个字符也必须失败 */
    const tampered = issued.token.slice(0, -1) + (issued.token.slice(-1) === 'A' ? 'B' : 'A');
    check('dev.verify 单字符篡改 → AUTH_INVALID', registry.verifyDeviceToken(tampered).code === 'AUTH_INVALID');

    /* 设备 DTO 绝不含凭据 */
    const dto = registry.getDevice(issued.device.deviceId);
    check('dev.DTO 不含 token / token_hash',
      dto.token === undefined && dto.tokenHash === undefined && dto.token_hash === undefined, Object.keys(dto));
    check('dev.DTO 字段齐备',
      typeof dto.deviceId === 'string' && typeof dto.createdAt === 'number' && typeof dto.lastSeenAt === 'number' &&
      dto.revoked === false && dto.revokedAt === null && Array.isArray(dto.capabilities) &&
      typeof dto.tokenVersion === 'number' && dto.tokenVersion === 1, dto);
  }

  /* ── 8 · 服务端从不保存 raw token（只存哈希）────────────────────── */
  {
    const env = newRegistry();
    const registry = env.registry;
    const issued = registry.issueDevice({ name: 'X', type: 'android' });
    const sqlite = require('node:sqlite');
    const db = new sqlite.DatabaseSync(path.join(env.dir, 'home-node.db'));
    const row = db.prepare('SELECT * FROM devices WHERE device_id=?').get(issued.device.deviceId);
    db.close();
    const dump = JSON.stringify(row);
    check('sec.DB 里没有 raw token', dump.indexOf(issued.token) < 0, dump.slice(0, 200));
    check('sec.DB 里存的是 64 位 hex 哈希',
      typeof row.token_hash === 'string' && /^[0-9a-f]{64}$/.test(row.token_hash), row.token_hash);
    check('sec.哈希 = sha256(raw token)（确定性校验的前提）',
      row.token_hash === registry.sha256Hex(issued.token));
    /* 整个数据库文件里也不该出现 raw token。 */
    const bytes = fs.readFileSync(path.join(env.dir, 'home-node.db'));
    check('sec.库文件里没有 raw token 字节', bytes.indexOf(Buffer.from(issued.token, 'utf8')) < 0);
  }

  /* ── 9 · rotation：旧 token 立刻失效 ────────────────────────────── */
  {
    const env = newRegistry();
    const registry = env.registry;
    const issued = registry.issueDevice({});
    const rotated = registry.rotateDeviceToken(issued.device.deviceId);
    check('rot.返回新 token 且版本 +1',
      rotated.ok === true && rotated.token !== issued.token && rotated.device.tokenVersion === 2, rotated.device);
    check('rot.旧 token 立即失效', registry.verifyDeviceToken(issued.token).ok === false);
    check('rot.新 token 有效', registry.verifyDeviceToken(rotated.token).ok === true);
    check('rot.未知设备 → DEVICE_NOT_FOUND', registry.rotateDeviceToken('dev_nope').code === 'DEVICE_NOT_FOUND');
  }

  /* ── 10 · 撤销：立即生效、幂等、不可逆 ──────────────────────────── */
  {
    const env = newRegistry();
    const registry = env.registry;
    const a = registry.issueDevice({ name: 'A', type: 'android' });
    const b = registry.issueDevice({ name: 'B', type: 'android' });

    const revoked = registry.revokeDevice(a.device.deviceId, { by: 'desktop' });
    check('revoke.成功且记录时间', revoked.ok === true && revoked.alreadyRevoked === false && revoked.device.revoked === true, revoked.device);
    check('revoke.撤销后立即拒绝（DEVICE_REVOKED）',
      registry.verifyDeviceToken(a.token).code === 'DEVICE_REVOKED', registry.verifyDeviceToken(a.token));

    const again = registry.revokeDevice(a.device.deviceId);
    check('revoke.重复撤销幂等（alreadyRevoked，不报错）', again.ok === true && again.alreadyRevoked === true, again);

    check('revoke.设备 B 完全不受影响（per-device 凭据）',
      registry.verifyDeviceToken(b.token).ok === true, registry.verifyDeviceToken(b.token).code);
    check('revoke.撤销是不可逆的（不能 rotate 复活）',
      registry.rotateDeviceToken(a.device.deviceId).code === 'DEVICE_REVOKED');
    check('revoke.已撤销设备不能再被重新签发同 id',
      registry.issueDevice({ deviceId: a.device.deviceId, name: 'A2' }).code === 'DEVICE_EXISTS');
    check('revoke.未知设备 → DEVICE_NOT_FOUND', registry.revokeDevice('dev_nope').code === 'DEVICE_NOT_FOUND');
    check('revoke.listDevices(activeOnly) 排除已撤销',
      registry.listDevices({ activeOnly: true }).length === 1 && registry.listDevices({}).length === 2);
  }

  /* ── 11 · lastSeen / rename / 能力归一 ──────────────────────────── */
  {
    const env = newRegistry();
    const registry = env.registry;
    const issued = registry.issueDevice({ name: 'Phone', type: 'android' });
    const before = registry.getDevice(issued.device.deviceId).lastSeenAt;
    fakeNow += 5000;
    registry.touchDevice(issued.device.deviceId, {});
    check('dev.touch 推进 lastSeenAt', registry.getDevice(issued.device.deviceId).lastSeenAt === before + 5000);
    registry.touchDevice(issued.device.deviceId, { appForeground: true });
    check('dev.touch(appForeground) 持久化', registry.getDevice(issued.device.deviceId).appForeground === true);

    const renamed = registry.renameDevice(issued.device.deviceId, '客厅平板');
    check('dev.rename 生效', renamed.ok === true && renamed.device.name === '客厅平板', renamed.device && renamed.device.name);
    check('dev.rename 空名 → BAD_REQUEST', registry.renameDevice(issued.device.deviceId, '   ').code === 'BAD_REQUEST');
    check('dev.rename 未知设备 → DEVICE_NOT_FOUND', registry.renameDevice('dev_nope', 'x').code === 'DEVICE_NOT_FOUND');

    /* 未知能力必须被丢弃（不做"未知即允许"）。 */
    const custom = registry.issueDevice({ capabilities: ['chat', 'gps', 'battery', 'notify', 'chat'] });
    check('dev.能力是 allowlist 且去重排序稳定',
      JSON.stringify(custom.device.capabilities) === JSON.stringify(['chat', 'notify']), custom.device.capabilities);
  }

  /* ── 12 · 重启持久化 ───────────────────────────────────────────── ─ */
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-devreg-restart-'));
    const first = createDeviceRegistry({ dataDir: dir, clock: clock, logger: () => {} });
    first.open();
    const session = first.createPairingSession({ deviceName: 'Persist', deviceType: 'android' });
    const paired = first.consumePairingSession({ pairingId: session.pairingId, secret: session.secret });
    const other = first.issueDevice({ name: 'Other', type: 'tablet' });
    first.revokeDevice(other.device.deviceId);
    const deviceCount = first.meta().devices;
    first.close();

    const second = createDeviceRegistry({ dataDir: dir, clock: clock, logger: () => {} });
    const reopened = second.open();
    check('restart.重开后 schema 不被重写', reopened.alreadyOpen === false && reopened.schemaVersion === 1);
    check('restart.设备仍在且数量一致', second.meta().devices === deviceCount && deviceCount === 1, second.meta());
    check('restart.token 校验跨进程重启仍然有效', second.verifyDeviceToken(paired.token).ok === true);
    check('restart.已撤销设备重启后仍然被拒',
      second.listDevices({}).find(d => d.name === 'Other').revoked === true);
    check('restart.配对会话的"已使用"状态也持久化',
      second.consumePairingSession({ pairingId: session.pairingId, secret: session.secret }).code === 'PAIRING_USED');
    second.close();
  }

  /* ── 13 · character catalog：DTO 与 runtime spec 结构上分离 ─────── */
  {
    const env = newRegistry();
    const registry = env.registry;
    const raw = {
      id: 'friend_a', nickname: '小满', avatar: 'data:image/png;base64,AAAA', relationship: '同桌',
      handle: 'xiaoman', signature: 'S', bio: 'B', banner: 'N', model: 'mock-model', provider: 'custom',
      endpoint: 'https://api.example.com/v1/chat/completions', apiKey: 'sk-SECRET-LEAK',
      imageGenApiKey: 'sk-IMAGEGEN-LEAK', systemPrompt: 'HIDDEN-PROMPT', temperature: 0.7,
      vision: true, streaming: true, webSearch: true, imageGen: true
    };
    const entry = MOBILE_DTO.characterCatalogEntry(raw);
    const written = registry.putCharacters([entry], {});
    check('catalog.发布成功', written.ok === true && written.count === 1 && written.withSpec === 1, written);

    const listed = registry.listCharacters();
    check('catalog.list 只返回 dto 与元信息', listed.length === 1 && listed[0].id === 'friend_a' && typeof listed[0].updatedAt === 'number', listed);
    const dtoJson = JSON.stringify(listed[0].dto);
    check('catalog.DTO 不含任何凭据/端点/隐藏提示词',
      dtoJson.indexOf('sk-') < 0 && dtoJson.indexOf('apiKey') < 0 && dtoJson.indexOf('endpoint') < 0 &&
      dtoJson.indexOf('HIDDEN-PROMPT') < 0 && dtoJson.indexOf('api.example.com') < 0, dtoJson);
    check('catalog.DTO 保留展示身份与能力位',
      listed[0].dto.name === '小满' && listed[0].dto.relationship === '同桌' &&
      listed[0].dto.capabilities.vision === true && listed[0].dto.capabilities.imageGen === true, listed[0].dto);

    /* spec 表里有凭据 —— 但它只供 Node 执行路径读取，形状与 DTO 完全不同。 */
    const spec = registry.getCharacterSpec('friend_a');
    check('catalog.spec 可被 Node 执行路径读取',
      spec && spec.apiKey === 'sk-SECRET-LEAK' && spec.endpoint === raw.endpoint && spec.systemPrompt === 'HIDDEN-PROMPT', spec && Object.keys(spec));
    check('catalog.spec 不含与文本回合无关的凭据（imageGenApiKey 被投影掉）',
      spec.imageGenApiKey === undefined, Object.keys(spec));
    check('catalog.getCharacter 不带 spec',
      JSON.stringify(registry.getCharacter('friend_a')).indexOf('sk-') < 0);
    check('catalog.两次投影不漂移（幂等）',
      JSON.stringify(MOBILE_DTO.characterDto(Object.assign({ id: 'friend_a' }, listed[0].dto))) === dtoJson,
      MOBILE_DTO.characterDto(Object.assign({ id: 'friend_a' }, listed[0].dto)));

    /* replace 模式：被删掉的角色不能留在目录里 */
    const second = MOBILE_DTO.characterCatalogEntry({ id: 'friend_b', nickname: '阿遥', model: 'm', provider: 'custom', endpoint: 'https://x/y', apiKey: 'k' });
    registry.putCharacters([second], {});
    check('catalog.replace 清掉不再存在的角色',
      registry.listCharacters().length === 1 && registry.listCharacters()[0].id === 'friend_b', registry.listCharacters().map(c => c.id));
    check('catalog.replace 同时删掉它的 spec 行', registry.getCharacterSpec('friend_a') === null);
    check('catalog.merge 模式保留其它角色',
      registry.putCharacters([MOBILE_DTO.characterCatalogEntry({ id: 'friend_c', nickname: 'C', model: 'm', provider: 'custom', endpoint: 'https://x/y', apiKey: 'k' })], { merge: true }).ok === true &&
      registry.listCharacters().length === 2);
    check('catalog.没有可运行配置的角色 forTurn=false',
      registry.putCharacter('friend_d', { id: 'friend_d', name: 'D' }, null, {}).ok === true &&
      registry.getCharacter('friend_d').forTurn === false && registry.getCharacterSpec('friend_d') === null);
    check('catalog.characterCatalogUpdatedAt 单调非零', registry.characterCatalogUpdatedAt() > 0);
  }

  /* ── 14 · 恒定时间比较工具本身 ─────────────────────────────────── */
  {
    const env = newRegistry();
    const registry = env.registry;
    check('util.constantTimeEqual 相同为真', registry.constantTimeEqual('abc', 'abc') === true);
    check('util.constantTimeEqual 不同为假', registry.constantTimeEqual('abc', 'abd') === false);
    check('util.constantTimeEqual 长度不同为假', registry.constantTimeEqual('abc', 'abcd') === false);
    check('util.constantTimeEqual null 安全', registry.constantTimeEqual(null, '') === true && registry.constantTimeEqual(null, 'x') === false);
    check('util.normalizeCapabilities 只保留 allowlist',
      JSON.stringify(registry.normalizeCapabilities(['gps', 'CHAT', 'vision', 'chat'])) === JSON.stringify(['chat', 'vision']));
  }

  if (failed) { console.error('M1-B device registry 测试失败：' + failed + ' 项（通过 ' + passed + '）'); process.exitCode = 1; }
  else console.log('M1-B device registry tests passed (' + passed + ' 项)');
})();
