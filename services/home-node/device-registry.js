/* ====================================================================
   IB Home Node · Device Registry + Pairing
   --------------------------------------------------------------------
   这是 Home Node 的**设备身份**子系统。它和 M1-A 的 chat authority 是
   两个不同的 authority 域，共用同一个 SQLite 文件但**互不污染**：

     · 设备表 / 配对表 / 设备事件表都在本文件里建，绝不写进 messages schema，
       也绝不占用 change_log 的 revision 序列（revision 只属于 chat）；
     · 本文件的 schema 版本号存在自己的 key（devices_schema），
       与 chat store 的 meta.schema_version 完全独立，各自演进；
     · 领域层：**不知道 HTTP、不认识 WebSocket、不认识 Origin**。
       传输层（services/home-node/mobile-gateway.js）只能调用这里的方法。

   ── 为什么 deviceId 不复用 ib_active_user_id ──────────────────────────
   user_id 是既有的「归属/分组标签」（Active 的任务、outbox 的过滤键），
   它由桌面写、可以随便改、不证明任何身份。deviceId 完全不同：
   它是**经过认证的客户端身份**，由 Home Node 在配对时签发，撤销后立即失效。
   两者语义不同，因此是两套东西，绝不互相赋值。

   ── 凭据模型（Phase 5）──────────────────────────────────────────────
     · 每个设备一份独立凭据 —— 设备 A 被攻破不需要设备 B 重新配对；
     · 服务端**只存 SHA-256(token)**，从不存 raw token（DB 泄漏不直接等价于
       凭据泄漏）；对同一 token 重复计算哈希是确定的，所以校验 = 定长比较；
     · token 里带一个版本段（`ibd<ver>_…`），rotation 时 +1，旧 token 立刻失效；
     · 撤销写 revoked_at 并**清空 token_hash**：撤销是不可逆的终态；
     · 校验用恒定时间比较，且所有失败路径返回同一个错误形状（不泄漏"设备存在
       但 token 错了"与"设备不存在"的区别）。

   ── 为什么不用 JWT ──────────────────────────────────────────────────
   本产品不需要无状态 token：设备表本来就要在本地查（要判撤销、要记 lastSeen），
   所以自包含 token 只增加解析面与算法选择面，不减少一次查询。
   一个不可读的随机 opaque token + 服务端哈希是更小、更可审计的模型。
   ==================================================================== */
'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
/* P11-3X-B：唯一的数据库失败分类来源。本层的 open() 失败会让 LAN 绑定被拒绝，
   因此那条拒绝必须能说出真正的类别（只读 / 权限 / 磁盘满 / 损坏 ……）。 */
const dbFailure = require('../../runtime/db-failure.js');
const createCharacterProjectionStore = require('./character-projection-store.js');

const SCHEMA_VERSION = 1;
const DEFAULT_DB_FILENAME = 'home-node.db';

/* 配对会话 TTL：5 分钟。够用户把二维码/载荷交给手机，短到"泄漏了也过期了"。 */
const PAIRING_TTL_MS = 5 * 60 * 1000;
/* 过期配对会话的保留时长（用于回答"这个 id 到底是什么状态"），之后可清理。 */
const PAIRING_RETENTION_MS = 24 * 60 * 60 * 1000;

/* token 前缀里的格式版本。改变 token 布局时 +1（不是协议版本）。 */
const TOKEN_PREFIX = 'ibd';
const TOKEN_FORMAT_VERSION = 1;
const TOKEN_BYTES = 32;                       /* 256 bit —— 不可爆破 */
const TOKEN_RE = /^ibd(\d+)_([A-Za-z0-9_-]{20,})$/;
const PAIRING_SECRET_BYTES = 32;
const PAIRING_ID_BYTES = 12;

const DEVICE_TYPES = ['android', 'ios', 'desktop', 'tablet', 'unknown'];
/* 设备能力：必须显式 allowlist，未知能力一律丢弃（不做"未知即全部允许"）。 */
const KNOWN_CAPABILITIES = ['chat', 'sync', 'notify', 'vision'];
const DEFAULT_CAPABILITIES = ['chat', 'sync', 'notify'];

const SPACE = ' \t\r\n';

/* M1-C.2i：Middle Brain 执行配置在 meta 表里的键（命名空间前缀与 devices_schema 同风格）。 */
const MB_CONFIG_META_KEY = 'middle_brain_execution_config';

/* node:sqlite 是 Node 22.5+ 内置模块（shipped runtime 24.18.0 已确认可用）。
   缺失时明确报错，绝不静默换一套存储语义。 */
function loadSqlite() {
  try { return require('node:sqlite'); }
  catch (error) {
    const err = new Error('node:sqlite is unavailable in this runtime: ' + (error && error.message || error));
    err.code = 'SQLITE_UNAVAILABLE';
    throw err;
  }
}

/* 所有进 SQL 的数值都必须是真整数：node:sqlite 把 JS number 绑定为 REAL，
   而 REAL 在任何比较里都大于 INTEGER（M1-A 已实测，见 chat-store.js:63-73）。
   设备层的时间戳比较同样受影响，因此同样必须归一。 */
function intOf(value) {
  const n = Number(value);
  if (!isFinite(n)) return 0;
  return Math.trunc(n);
}

/* 恒定时间比较。长度不同直接 false —— 长度本身不是秘密
   （哈希是定长 hex，token 的实际长度不构成可利用信息）。 */
function constantTimeEqual(a, b) {
  const x = Buffer.from(String(a == null ? '' : a));
  const y = Buffer.from(String(b == null ? '' : b));
  if (x.length !== y.length) return false;
  try { return crypto.timingSafeEqual(x, y); } catch (_) { return false; }
}

function randomToken(bytes) {
  return crypto.randomBytes(bytes).toString('base64url');
}
function sha256Hex(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}
function isBlank(value) {
  const text = String(value == null ? '' : value);
  for (let i = 0; i < text.length; i++) if (SPACE.indexOf(text.charAt(i)) < 0) return false;
  return true;
}
function trimmed(value, maxLen) {
  const text = String(value == null ? '' : value).trim();
  return maxLen && text.length > maxLen ? text.slice(0, maxLen) : text;
}
function deviceTypeOf(value) {
  const text = String(value == null ? '' : value).trim().toLowerCase();
  return DEVICE_TYPES.indexOf(text) >= 0 ? text : 'unknown';
}
/* 能力归一：只保留 allowlist 里的项，去重，顺序恒定为 KNOWN_CAPABILITIES 的顺序
   （顺序稳定 → 同一设备两次返回的 DTO 逐字节相同，便于 ETag 与测试）。 */
function normalizeCapabilities(input) {
  const wanted = Array.isArray(input) ? input.map(v => String(v == null ? '' : v).trim().toLowerCase()) : [];
  const out = [];
  for (const capability of KNOWN_CAPABILITIES) if (wanted.indexOf(capability) >= 0) out.push(capability);
  return out;
}

function createDeviceRegistry(deps) {
  deps = deps || {};
  const dataDir = deps.dataDir || process.cwd();
  const dbFile = deps.dbFile || path.join(dataDir, DEFAULT_DB_FILENAME);
  const clock = deps.clock || (() => Date.now());
  const logger = deps.logger || (() => {});
  const pairingTtlMs = Number(deps.pairingTtlMs) > 0 ? Number(deps.pairingTtlMs) : PAIRING_TTL_MS;
  const makeDeviceId = deps.makeDeviceId || (() => 'dev_' + randomToken(12));
  const makePairingId = deps.makePairingId || (() => 'pair_' + randomToken(PAIRING_ID_BYTES));
  /* 服务端身份指纹：给用户**肉眼核对**用（不是密钥、不参与鉴权）。
     目的是让"我配的是自己那台机器吗"有一个可回答的问题。 */
  const fingerprint = trimmed(deps.fingerprint, 64) || sha256Hex('internal-beyond-home-node').slice(0, 16);

  let sqlite = null;
  let db = null;
  let characterProjectionStore = null;
  let opened = false;
  let ownsDb = false;
  let lastOpenedAt = null;

  const SQL = {
    createDevices:
      'CREATE TABLE IF NOT EXISTS devices (' +
      ' device_id TEXT PRIMARY KEY,' +
      ' name TEXT NOT NULL DEFAULT "",' +
      ' type TEXT NOT NULL DEFAULT "unknown",' +
      ' created_at INTEGER NOT NULL,' +
      ' last_seen_at INTEGER NOT NULL,' +
      ' revoked_at INTEGER,' +
      ' capabilities TEXT NOT NULL DEFAULT "[]",' +
      ' token_version INTEGER NOT NULL DEFAULT 1,' +
      ' token_hash TEXT,' +
      ' token_issued_at INTEGER,' +
      ' app_foreground INTEGER NOT NULL DEFAULT 0)',
    createPairing:
      'CREATE TABLE IF NOT EXISTS pairing_sessions (' +
      ' pairing_id TEXT PRIMARY KEY,' +
      ' secret_hash TEXT NOT NULL,' +
      ' created_at INTEGER NOT NULL,' +
      ' expires_at INTEGER NOT NULL,' +
      ' consumed_at INTEGER,' +
      ' consumed_by TEXT,' +
      ' device_name TEXT,' +
      ' device_type TEXT)',
    createEvents:
      'CREATE TABLE IF NOT EXISTS device_events (' +
      ' at INTEGER NOT NULL, device_id TEXT NOT NULL, event TEXT NOT NULL, detail TEXT)',
    createEventIndex: 'CREATE INDEX IF NOT EXISTS idx_device_events_at ON device_events (at)',
    /* meta 表与 chat store 共用（同一个库、同一张 key-value 表），但键各自命名空间化：
       设备层只碰 devices_schema，chat store 只碰 schema_version / revision / insert_seq。
       用 IF NOT EXISTS 创建，因此**两个子系统谁先开都成立** —— 本层不假设
       chat store 已经建过这张表（测试里就是独立打开的）。 */
    createMeta: 'CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
    insertDevice:
      'INSERT INTO devices (device_id, name, type, created_at, last_seen_at, revoked_at, capabilities, token_version, token_hash, token_issued_at, app_foreground)' +
      ' VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, 0)',
    selectDevice: 'SELECT * FROM devices WHERE device_id=?',
    selectDeviceByToken: 'SELECT * FROM devices WHERE token_hash=?',
    listDevices: 'SELECT * FROM devices ORDER BY created_at ASC, device_id ASC',
    touchDevice: 'UPDATE devices SET last_seen_at=? WHERE device_id=?',
    setForeground: 'UPDATE devices SET app_foreground=?, last_seen_at=? WHERE device_id=?',
    renameDevice: 'UPDATE devices SET name=? WHERE device_id=?',
    /* 撤销：写入 revoked_at，但**保留** token_hash。
       保留 hash 有两个作用：
         · 已撤销的设备能拿到明确的 DEVICE_REVOKED（而不是混成 AUTH_INVALID）；
         · 校验路径不需要"按 device id 查一遍"的额外分支。
       鉴权层在哈希匹配之后立刻判 revoked_at，因此保留 hash 不放行任何东西：
       撤销是**不可逆**的终态（rotate/issue 都要求 revoked_at IS NULL）。 */
    revokeDevice: 'UPDATE devices SET revoked_at=?, app_foreground=0 WHERE device_id=? AND revoked_at IS NULL',
    rotateToken: 'UPDATE devices SET token_hash=?, token_version=?, token_issued_at=? WHERE device_id=? AND revoked_at IS NULL',
    insertPairing: 'INSERT INTO pairing_sessions (pairing_id, secret_hash, created_at, expires_at, consumed_at, consumed_by, device_name, device_type) VALUES (?, ?, ?, ?, NULL, NULL, ?, ?)',
    selectPairing: 'SELECT * FROM pairing_sessions WHERE pairing_id=?',
    /* 单次使用是**原子**的：UPDATE ... WHERE consumed_at IS NULL 是条件写，
       两路并发只有一个能把 consumed_at 从 NULL 改成非 NULL（SQLite 串行化写事务）。
       这不是"先查再写"的检查，因此不存在 TOCTOU 窗口。 */
    consumePairing: 'UPDATE pairing_sessions SET consumed_at=?, consumed_by=?, device_name=?, device_type=? WHERE pairing_id=? AND consumed_at IS NULL AND expires_at > ?',
    deleteOldPairing: 'DELETE FROM pairing_sessions WHERE expires_at < ? AND consumed_at IS NOT NULL',
    insertEvent: 'INSERT INTO device_events (at, device_id, event, detail) VALUES (?, ?, ?, ?)',
    countDevices: 'SELECT COUNT(*) AS c FROM devices WHERE revoked_at IS NULL',
    countAllDevices: 'SELECT COUNT(*) AS c FROM devices',
    countPairing: 'SELECT COUNT(*) AS c FROM pairing_sessions WHERE consumed_at IS NULL AND expires_at > ?',
    selectMeta: 'SELECT value FROM meta WHERE key=?',
    upsertMeta: 'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
    /* ── character catalog（Phase 11/12：mobile-safe DTO + server-side runtime spec）── */
    createCharacters:
      'CREATE TABLE IF NOT EXISTS characters (' +
      ' id TEXT PRIMARY KEY,' +
      ' dto_json TEXT NOT NULL,' +
      ' for_turn INTEGER NOT NULL DEFAULT 0,' +
      ' updated_at INTEGER NOT NULL)',
    createCharacterSecrets:
      'CREATE TABLE IF NOT EXISTS character_runtime_specs (' +
      ' character_id TEXT PRIMARY KEY,' +
      ' spec_json TEXT NOT NULL,' +
      ' updated_at INTEGER NOT NULL,' +
      ' FOREIGN KEY (character_id) REFERENCES characters (id) ON DELETE CASCADE)',
    upsertCharacter:
      'INSERT INTO characters (id, dto_json, for_turn, updated_at) VALUES (?, ?, ?, ?)' +
      ' ON CONFLICT(id) DO UPDATE SET dto_json=excluded.dto_json, for_turn=excluded.for_turn, updated_at=excluded.updated_at',
    upsertCharacterSpec:
      'INSERT INTO character_runtime_specs (character_id, spec_json, updated_at) VALUES (?, ?, ?)' +
      ' ON CONFLICT(character_id) DO UPDATE SET spec_json=excluded.spec_json, updated_at=excluded.updated_at',
    selectCharacter: 'SELECT * FROM characters WHERE id=?',
    selectCharacterSpec: 'SELECT * FROM character_runtime_specs WHERE character_id=?',
    listCharacters: 'SELECT * FROM characters ORDER BY id ASC',
    deleteCharacter: 'DELETE FROM characters WHERE id=?',
    deleteCharacterSpec: 'DELETE FROM character_runtime_specs WHERE character_id=?',
    maxCharacterUpdatedAt: 'SELECT MAX(updated_at) AS m FROM characters',
    countCharacters: 'SELECT COUNT(*) AS c FROM characters'
  };

  function open() {
    if (opened) return { ok: true, alreadyOpen: true, file: dbFile, schemaVersion: SCHEMA_VERSION };
    /* 故障注入（仅供测试）：验证"设备鉴权子系统不可用时，LAN 绑定必须被拒绝"
       这条安全规则。生产路径没有这个变量，默认行为不受影响。
       在这里注入而不是在 chat store 里，是因为这条规则要测的正是
       "订阅系统就绪、设备系统没就绪"这一种状态。 */
    if (process.env.IB_HOME_NODE_DEBUG_FAIL_OPEN === '1') {
      throw Object.assign(new Error('device registry open failed (injected for tests)'), { code: 'DEBUG_INJECTED' });
    }
    try { fs.mkdirSync(dataDir, { recursive: true }); } catch (_) { /* 目录已存在 */ }
    if (!sqlite) sqlite = loadSqlite();
    /* 本层**不**做 quick_check / 损坏隔离：那个职责属于 chat store（它先开、
       先隔离）。这里如果也做一遍，两个连接就会对"谁负责改名"产生竞态。
       本层的契约是：只有在调用方已经处理完损坏隔离之后才 open()。

       P11-3X-B：失败必须分类（见 runtime/db-failure.js）。设备表与 chat store
       是同一个文件上的两条连接，"只读/权限/磁盘满"在这里第一次被发现同样正常，
       而这条失败恰恰会让 LAN 绑定被拒绝 —— 那条拒绝必须能说出真正的类别。 */
    try {
      db = new sqlite.DatabaseSync(dbFile);
      ownsDb = true;
      db.exec('PRAGMA journal_mode = WAL');
      db.exec('PRAGMA synchronous = FULL');
      db.exec('PRAGMA busy_timeout = 5000');
      db.exec('PRAGMA foreign_keys = ON');
      db.exec(SQL.createDevices);
      db.exec(SQL.createPairing);
      db.exec(SQL.createEvents);
      db.exec(SQL.createEventIndex);
      db.exec(SQL.createCharacters);
      db.exec(SQL.createCharacterSecrets);
      db.exec(SQL.createMeta);
      characterProjectionStore = createCharacterProjectionStore(db);
      const stored = readMeta('devices_schema');
      if (stored == null) writeMeta('devices_schema', String(SCHEMA_VERSION));
      else if (Number(stored) > SCHEMA_VERSION) {
        const err = new Error('device registry schema is newer than this build (' + stored + ' > ' + SCHEMA_VERSION + ')');
        err.code = 'SCHEMA_TOO_NEW';
        throw err;
      }
    } catch (error) {
      try { if (db) db.close(); } catch (_) { /* 已关闭 */ }
      db = null;
      characterProjectionStore = null;
      opened = false;
      ownsDb = false;
      throw dbFailure.toError(error);
    }
    opened = true;
    lastOpenedAt = clock();
    logger('devices-opened', {
      file: dbFile,
      schemaVersion: SCHEMA_VERSION,
      devices: countDevices(),
      allDevices: countAllDevices(),
      characters: countCharacters()
    });
    return { ok: true, alreadyOpen: false, file: dbFile, schemaVersion: SCHEMA_VERSION };
  }

  /* RecoveryOnly binds this registry to a query-only SQLite handle and only
     uses its characters.id/dto_json projection methods. It never reads the
     character_runtime_specs table on this path. */
  function attachReadOnlyConnection(connection) {
    if (opened || db) throw Object.assign(new Error('store-already-open'), { code: 'STORE_ALREADY_OPEN' });
    if (!connection || typeof connection.prepare !== 'function' || typeof connection.exec !== 'function') {
      throw Object.assign(new Error('readonly-connection-required'), { code: 'READONLY_CONNECTION_REQUIRED' });
    }
    db = connection;
    try {
      db.exec('PRAGMA query_only=ON');
      const row = db.prepare('PRAGMA query_only').get();
      const value = row && (row.query_only == null ? Object.values(row)[0] : row.query_only);
      if (Number(value) !== 1) throw Object.assign(new Error('query-only-not-enabled'), { code: 'QUERY_ONLY_NOT_ENABLED' });
      const schema = readMeta('devices_schema');
      if (schema == null || Number(schema) > SCHEMA_VERSION) throw Object.assign(new Error('schema-version-invalid'), { code: 'SCHEMA_VERSION_INVALID' });
      characterProjectionStore = createCharacterProjectionStore(db, { readOnly: true });
      opened = true;
      ownsDb = false;
      return { ok: true, readOnly: true, schemaVersion: SCHEMA_VERSION };
    } catch (error) {
      db = null;
      characterProjectionStore = null;
      opened = false;
      ownsDb = false;
      throw error;
    }
  }

  function close() {
    if (!opened || !db) return { ok: true, alreadyClosed: true };
    if (ownsDb) { try { db.close(); } catch (_) { /* 已关闭 */ } }
    db = null;
    characterProjectionStore = null;
    opened = false;
    ownsDb = false;
    return { ok: true };
  }
  function isOpen() { return opened; }

  function readMeta(key) {
    const row = db.prepare(SQL.selectMeta).get(key);
    return row ? row.value : null;
  }
  function writeMeta(key, value) {
    db.prepare(SQL.upsertMeta).run(key, String(value));
  }

  /* ── 设备 DTO（**没有** token、没有 token_hash）────────────────────── */
  function deviceDto(row) {
    if (!row) return null;
    let capabilities = [];
    try { capabilities = JSON.parse(row.capabilities); } catch (_) { capabilities = []; }
    return {
      deviceId: String(row.device_id),
      name: String(row.name || ''),
      type: String(row.type || 'unknown'),
      createdAt: intOf(row.created_at),
      lastSeenAt: intOf(row.last_seen_at),
      revoked: row.revoked_at != null,
      revokedAt: row.revoked_at == null ? null : intOf(row.revoked_at),
      capabilities: Array.isArray(capabilities) ? capabilities : [],
      tokenVersion: intOf(row.token_version),
      online: !!row.__online,
      appForeground: !!row.app_foreground
    };
  }

  /* ── 配对会话 ──────────────────────────────────────────────────────── */
  /* 创建：返回给调用方的是**一次性**载荷。secret 只在这里出现一次（发给创建方），
     服务端只留哈希。 */
  function createPairingSession(options) {
    options = options || {};
    if (!opened) return { ok: false, code: 'STORE_CLOSED' };
    const now = intOf(clock());
    const pairingId = makePairingId();
    const secret = randomToken(PAIRING_SECRET_BYTES);
    const expiresAt = now + pairingTtlMs;
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare(SQL.insertPairing).run(pairingId, sha256Hex(secret), now, expiresAt,
        trimmed(options.deviceName, 64) || null, options.deviceType ? deviceTypeOf(options.deviceType) : null);
      db.prepare(SQL.deleteOldPairing).run(now - PAIRING_RETENTION_MS);
      db.exec('COMMIT');
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch (_) { /* 保留原始错误 */ }
      throw error;
    }
    logger('pairing-created', { pairingId: pairingId, expiresAt: expiresAt, ttlMs: pairingTtlMs });
    return {
      ok: true,
      pairingId: pairingId,
      secret: secret,
      createdAt: now,
      expiresAt: expiresAt,
      ttlMs: pairingTtlMs,
      fingerprint: fingerprint
    };
  }

  function pairingStatus(pairingId) {
    if (!opened) return { ok: false, code: 'STORE_CLOSED' };
    const row = db.prepare(SQL.selectPairing).get(String(pairingId || ''));
    if (!row) return { ok: false, code: 'PAIRING_NOT_FOUND' };
    const now = intOf(clock());
    return {
      ok: true,
      pairingId: String(row.pairing_id),
      createdAt: intOf(row.created_at),
      expiresAt: intOf(row.expires_at),
      consumedAt: row.consumed_at == null ? null : intOf(row.consumed_at),
      consumedBy: row.consumed_by || null,
      expired: intOf(row.expires_at) <= now,
      used: row.consumed_at != null
    };
  }

  /* 消费：single-use + TTL，且**原子**。
     失败原因分别可辨（PAIRING_NOT_FOUND / PAIRING_USED / PAIRING_EXPIRED），
     因为这三者对客户端是三种不同的处置（重新生成 / 重新生成 / 重新生成并检查时钟）。
     但对**错误的 secret** 一律返回 PAIRING_INVALID，不区分 id 是否存在。 */
  function consumePairingSession(options) {
    options = options || {};
    if (!opened) return { ok: false, code: 'STORE_CLOSED' };
    const pairingId = trimmed(options.pairingId, 128);
    const secret = String(options.secret == null ? '' : options.secret);
    if (!pairingId || isBlank(secret)) return { ok: false, code: 'PAIRING_INVALID' };
    const now = intOf(clock());
    const row = db.prepare(SQL.selectPairing).get(pairingId);
    if (!row) return { ok: false, code: 'PAIRING_INVALID' };
    const expectedHash = String(row.secret_hash || '');
    if (!constantTimeEqual(sha256Hex(secret), expectedHash)) {
      logger('pairing-secret-mismatch', { pairingId: pairingId });
      return { ok: false, code: 'PAIRING_INVALID' };
    }
    /* 顺序刻意如此：先验 secret（避免用状态码给爆破者做 oracle），
       再判断 used / expired。 */
    if (row.consumed_at != null) return { ok: false, code: 'PAIRING_USED' };
    if (intOf(row.expires_at) <= now) return { ok: false, code: 'PAIRING_EXPIRED' };

    const name = trimmed(options.deviceName, 64) || trimmed(row.device_name, 64) || 'Mobile device';
    const type = deviceTypeOf(options.deviceType || row.device_type);
    const capabilities = normalizeCapabilities(
      options.capabilities == null ? DEFAULT_CAPABILITIES : options.capabilities);

    /* 设备 id 在这里先生成，让"谁消费了这个会话"能在**同一次**条件 UPDATE 里
       一起写下去。早期实现先写 consumed_by='pending' 再回填真实 id —— 那条回填
       永远不会生效（第二次 UPDATE 的 WHERE consumed_at IS NULL 已经不成立），
       于是审计字段永久停在 'pending'。单次写、单次原子声明，才是正确形状。 */
    const deviceId = makeDeviceId();
    const claimed = db.prepare(SQL.consumePairing).run(now, deviceId, name, type, pairingId, now);
    const changed = claimed && (claimed.changes != null ? Number(claimed.changes) : 1);
    if (changed !== 1) {
      const after = db.prepare(SQL.selectPairing).get(pairingId);
      const code = after && after.consumed_at != null ? 'PAIRING_USED' : 'PAIRING_EXPIRED';
      logger('pairing-consume-lost-race', { pairingId: pairingId, code: code });
      return { ok: false, code: code };
    }

    const device = issueDevice({
      deviceId: deviceId, name: name, type: type, capabilities: capabilities, pairingId: pairingId
    });
    if (!device.ok) {
      /* 极端情况：声明成功但签发失败（例如 id 撞车）。会话已经被消费掉，
         这是**正确**的失败姿态 —— 一次性的东西不能被同一份载荷重试。 */
      logger('pairing-consume-issue-failed', { pairingId: pairingId, code: device.code });
      return device;
    }
    logger('pairing-consumed', { pairingId: pairingId, deviceId: device.device.deviceId, type: type });
    return device;
  }

  /* ── 设备签发 / 校验 ──────────────────────────────────────────────── */
  function issueDevice(options) {
    options = options || {};
    if (!opened) return { ok: false, code: 'STORE_CLOSED' };
    const now = intOf(clock());
    const deviceId = trimmed(options.deviceId, 64) || makeDeviceId();
    if (db.prepare(SQL.selectDevice).get(deviceId)) return { ok: false, code: 'DEVICE_EXISTS' };
    const capabilities = normalizeCapabilities(
      options.capabilities == null ? DEFAULT_CAPABILITIES : options.capabilities);
    const name = trimmed(options.name, 64) || 'Mobile device';
    const type = deviceTypeOf(options.type);
    const raw = TOKEN_PREFIX + TOKEN_FORMAT_VERSION + '_' + randomToken(TOKEN_BYTES);
    db.prepare(SQL.insertDevice).run(
      deviceId, name, type, now, now, JSON.stringify(capabilities),
      TOKEN_FORMAT_VERSION, sha256Hex(raw), now);
    recordEvent('device-issued', deviceId, { type: type, pairingId: options.pairingId || null });
    logger('device-issued', { deviceId: deviceId, type: type, capabilities: capabilities });
    const row = db.prepare(SQL.selectDevice).get(deviceId);
    return {
      ok: true,
      /* raw token **只在这里**出现一次；之后任何读取路径都拿不到它。 */
      token: raw,
      device: deviceDto(row)
    };
  }

  /* token → 设备。这是唯一的鉴权入口。
     失败词表刻意收窄：AUTH_INVALID（缺失/格式错/不匹配）、DEVICE_REVOKED
     （凭据曾经有效、但已被撤销）。 */
  function verifyDeviceToken(rawToken, options) {
    options = options || {};
    if (!opened) return { ok: false, code: 'STORE_CLOSED' };
    const raw = String(rawToken == null ? '' : rawToken).trim();
    if (!raw) return { ok: false, code: 'AUTH_REQUIRED' };
    const match = TOKEN_RE.exec(raw);
    if (!match) return { ok: false, code: 'AUTH_INVALID' };
    const formatVersion = Number(match[1]);
    if (formatVersion !== TOKEN_FORMAT_VERSION) {
      /* 格式版本不认识 → 让客户端重新配对，而不是猜。 */
      return { ok: false, code: 'AUTH_INVALID', detail: 'token-format-version' };
    }
    const hash = sha256Hex(raw);
    const row = db.prepare(SQL.selectDeviceByToken).get(hash);
    if (!row) return { ok: false, code: 'AUTH_INVALID' };
    if (!constantTimeEqual(hash, String(row.token_hash || ''))) return { ok: false, code: 'AUTH_INVALID' };
    /* 撤销判定在**哈希匹配之后**：撤销时保留 token_hash（只加 revoked_at），
       所以"曾经有效但已撤销"的设备能拿到一个明确的 DEVICE_REVOKED，
       而不是与"token 是伪造的"混成同一个 AUTH_INVALID。
       客户端据此可以正确分支：收到 DEVICE_REVOKED 就清掉本地凭据并提示重新配对，
       收到 AUTH_INVALID 则说明凭据本身不对（可能是另一种客户端 bug）。
       安全性没有被降低：要走到这一行，必须先出示那个正确的 token。 */
    if (row.revoked_at != null) {
      return { ok: false, code: 'DEVICE_REVOKED', deviceId: String(row.device_id), revokedAt: intOf(row.revoked_at) };
    }
    const device = deviceDto(row);
    if (options.touch !== false) touchDevice(device.deviceId, { appForeground: options.appForeground });
    return { ok: true, device: device, tokenVersion: intOf(row.token_version) };
  }

  function currentTokenHash(deviceId) {
    if (!opened) return null;
    const row = db.prepare(SQL.selectDevice).get(String(deviceId || ''));
    return row ? (row.token_hash || null) : null;
  }

  /* rotation：+1 版本并换哈希，旧 token 立刻失效（因为它对不上新哈希）。 */
  function rotateDeviceToken(deviceId) {
    if (!opened) return { ok: false, code: 'STORE_CLOSED' };
    const row = db.prepare(SQL.selectDevice).get(String(deviceId || ''));
    if (!row) return { ok: false, code: 'DEVICE_NOT_FOUND' };
    if (row.revoked_at != null) return { ok: false, code: 'DEVICE_REVOKED' };
    const now = intOf(clock());
    const nextVersion = intOf(row.token_version) + 1;
    const raw = TOKEN_PREFIX + TOKEN_FORMAT_VERSION + '_' + randomToken(TOKEN_BYTES);
    const changed = db.prepare(SQL.rotateToken).run(sha256Hex(raw), nextVersion, now, String(deviceId));
    if (!changed || Number(changed.changes) !== 1) return { ok: false, code: 'DEVICE_REVOKED' };
    recordEvent('device-token-rotated', String(deviceId), { tokenVersion: nextVersion });
    logger('device-token-rotated', { deviceId: String(deviceId), tokenVersion: nextVersion });
    const after = db.prepare(SQL.selectDevice).get(String(deviceId));
    return { ok: true, token: raw, device: deviceDto(after) };
  }

  function getDevice(deviceId) {
    if (!opened) return null;
    const row = db.prepare(SQL.selectDevice).get(String(deviceId || ''));
    return row ? deviceDto(row) : null;
  }

  function listDevices(options) {
    options = options || {};
    if (!opened) return [];
    const rows = db.prepare(SQL.listDevices).all();
    const out = [];
    for (const row of rows) {
      if (options.activeOnly && row.revoked_at != null) continue;
      out.push(deviceDto(row));
    }
    return out;
  }

  function touchDevice(deviceId, options) {
    options = options || {};
    if (!opened) return { ok: false, code: 'STORE_CLOSED' };
    const now = intOf(clock());
    if (options.appForeground === undefined) db.prepare(SQL.touchDevice).run(now, String(deviceId));
    else db.prepare(SQL.setForeground).run(options.appForeground ? 1 : 0, now, String(deviceId));
    return { ok: true, lastSeenAt: now };
  }

  function renameDevice(deviceId, name) {
    if (!opened) return { ok: false, code: 'STORE_CLOSED' };
    const row = db.prepare(SQL.selectDevice).get(String(deviceId || ''));
    if (!row) return { ok: false, code: 'DEVICE_NOT_FOUND' };
    const clean = trimmed(name, 64);
    if (!clean) return { ok: false, code: 'BAD_REQUEST' };
    db.prepare(SQL.renameDevice).run(clean, String(deviceId));
    return { ok: true, device: getDevice(deviceId) };
  }

  /* 撤销：立即生效（token_hash 被清空，任何后续校验都匹配不到）。
     幂等：重复撤销返回 alreadyRevoked，不报错（重试不应失败）。 */
  function revokeDevice(deviceId, options) {
    options = options || {};
    if (!opened) return { ok: false, code: 'STORE_CLOSED' };
    const id = String(deviceId || '');
    const row = db.prepare(SQL.selectDevice).get(id);
    if (!row) return { ok: false, code: 'DEVICE_NOT_FOUND' };
    if (row.revoked_at != null) {
      return { ok: true, alreadyRevoked: true, device: deviceDto(row) };
    }
    const now = intOf(clock());
    const changed = db.prepare(SQL.revokeDevice).run(now, id);
    if (!changed || Number(changed.changes) !== 1) {
      const after = db.prepare(SQL.selectDevice).get(id);
      return { ok: true, alreadyRevoked: true, device: deviceDto(after) };
    }
    recordEvent('device-revoked', id, { by: options.by || null });
    logger('device-revoked', { deviceId: id, by: options.by || null });
    return { ok: true, alreadyRevoked: false, device: getDevice(id) };
  }

  function recordEvent(event, deviceId, detail) {
    try {
      db.prepare(SQL.insertEvent).run(intOf(clock()), String(deviceId || ''), String(event), detail ? JSON.stringify(detail) : null);
    } catch (_) { /* 审计失败不得影响主流程 */ }
  }

  function countDevices() {
    if (!opened) return 0;
    return intOf(db.prepare(SQL.countDevices).get().c);
  }
  function countAllDevices() {
    if (!opened) return 0;
    return intOf(db.prepare(SQL.countAllDevices).get().c);
  }
  function countOpenPairingSessions() {
    if (!opened) return 0;
    return intOf(db.prepare(SQL.countPairing).get(intOf(clock())).c);
  }

  /* ── character catalog ────────────────────────────────────────────────
     两个表刻意分开（Phase 11/12/26/27）：
       · characters          —— mobile-safe DTO，**可以**发给任何已认证设备；
       · character_runtime_specs —— provider 凭据与运行参数，**永不**离开 Node。
     分开而不是"一个 JSON 里挑字段"，是因为"挑字段"的实现一旦漏了一个键就会
     泄漏；分表之后泄漏需要有人显式把 secrets 表 join 进 DTO 路径。 */
  function putCharacter(characterId, dto, runtimeSpec, options) {
    options = options || {};
    if (!opened) return { ok: false, code: 'STORE_CLOSED' };
    const id = trimmed(characterId, 128);
    if (!id) return { ok: false, code: 'BAD_REQUEST' };
    const now = intOf(clock());
    const dtoJson = JSON.stringify(dto || {});
    const specJson = runtimeSpec == null ? null : JSON.stringify(runtimeSpec);
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare(SQL.upsertCharacter).run(id, dtoJson, specJson ? 1 : 0, now);
      if (specJson) db.prepare(SQL.upsertCharacterSpec).run(id, specJson, now);
      else db.prepare(SQL.deleteCharacterSpec).run(id);
      db.exec('COMMIT');
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch (_) { /* 保留原始错误 */ }
      throw error;
    }
    return { ok: true, id: id, forTurn: !!specJson, updatedAt: now };
  }

  function putCharacters(entries, options) {
    options = options || {};
    if (!opened) return { ok: false, code: 'STORE_CLOSED' };
    if (!Array.isArray(entries)) return { ok: false, code: 'BAD_REQUEST' };
    if (!options.merge) {
      /* replace 模式：清掉不再存在的角色（否则手机上会一直显示已删除的角色）。 */
      const keep = new Set(entries.map(e => trimmed(e && e.id, 128)).filter(Boolean));
      for (const row of db.prepare(SQL.listCharacters).all()) {
        if (!keep.has(String(row.id))) {
          db.prepare(SQL.deleteCharacterSpec).run(String(row.id));
          db.prepare(SQL.deleteCharacter).run(String(row.id));
        }
      }
    }
    const results = [];
    let withSpec = 0;
    for (const entry of entries) {
      if (!entry) continue;
      const written = putCharacter(entry.id, entry.dto, entry.spec, options);
      if (written.ok && written.forTurn) withSpec += 1;
      results.push({ id: (entry && entry.id) || null, ok: !!written.ok, error: written.code || null });
    }
    logger('character-catalog-published', { count: results.length, withSpec: withSpec, merge: !!options.merge });
    return { ok: true, count: results.length, withSpec: withSpec, results: results };
  }

  /* 列表只读 characters 表 —— 结构上不可能带出 spec。 */
  function listCharacters() {
    if (!opened) return [];
    const out = [];
    for (const row of db.prepare(SQL.listCharacters).all()) {
      let dto = null;
      try { dto = JSON.parse(row.dto_json); } catch (_) { dto = null; }
      out.push({
        id: String(row.id),
        dto: dto && typeof dto === 'object' ? dto : { id: String(row.id) },
        forTurn: !!row.for_turn,
        updatedAt: intOf(row.updated_at)
      });
    }
    return out;
  }

  function getCharacter(characterId) {
    if (!opened) return null;
    const row = db.prepare(SQL.selectCharacter).get(String(characterId || ''));
    if (!row) return null;
    let dto = null;
    try { dto = JSON.parse(row.dto_json); } catch (_) { dto = null; }
    return {
      id: String(row.id),
      dto: dto && typeof dto === 'object' ? dto : { id: String(row.id) },
      forTurn: !!row.for_turn,
      updatedAt: intOf(row.updated_at)
    };
  }

  /* **仅供 Node 执行路径**：只有 executeCharacterTurn 需要它。
     任何 DTO / 任何 HTTP 响应都不得包含本函数的返回值。 */
  function getCharacterSpec(characterId) {
    if (!opened) return null;
    const row = db.prepare(SQL.selectCharacterSpec).get(String(characterId || ''));
    if (!row) return null;
    try { return JSON.parse(row.spec_json); } catch (_) { return null; }
  }

  /* C3.4 · DTO-only projection boundary.
     These methods touch characters.id/dto_json only. They deliberately do not
     call putCharacter(), whose normal publish contract also upserts/deletes the
     separate runtime binding. The C3 composite executor is the only intended
     caller; no HTTP route exposes this operation. */
  function readCharacterDtoProjections(characterIds) {
    if (!opened || !characterProjectionStore) return { ok: false, code: 'STORE_CLOSED' };
    try {
      return { ok: true, rows: characterProjectionStore.readCharacterDtoProjections(characterIds) };
    } catch (error) {
      return { ok: false, code: String(error && error.code || 'CHARACTER_PROJECTION_READ_FAILED') };
    }
  }

  function applyCharacterDtoProjectionBatch(updates) {
    if (!opened || !characterProjectionStore) return { ok: false, code: 'STORE_CLOSED' };
    try {
      return characterProjectionStore.applyCharacterDtoProjectionBatch(updates);
    } catch (error) {
      return { ok: false, code: String(error && error.code || 'CHARACTER_PROJECTION_UPDATE_FAILED'), transactionRolledBack: true };
    }
  }

  function characterCatalogUpdatedAt() {
    if (!opened) return 0;
    const row = db.prepare(SQL.maxCharacterUpdatedAt).get();
    return (row && row.m) ? intOf(row.m) : 0;
  }
  function countCharacters() {
    if (!opened) return 0;
    return intOf(db.prepare(SQL.countCharacters).get().c);
  }

  /* ── Middle Brain 执行配置（M1-C.2i）──────────────────────────────────
     存的是**执行策略**，不是凭据：桌面发布的投影里根本没有 endpoint / model / apiKey
     （见 assets/js/middle-brain-config-core.js 的 projectExecutionConfig）。
     因此它与 character_runtime_specs 归在同一张 meta 表里是安全的 ——
     投影层是构造式的，未知键没有机会进入，这里也不再做第二次挑字段。

     为什么与角色分表：这是**全局**策略（一台机器一份），不是角色属性。
     放进 character_runtime_specs 会让它看起来像"每个角色可以有不同的思考深度"，
     而 canonical 语义是全局的 —— 那就制造了一个看起来能用、实际会漂移的旋钮。 */
  function putMiddleBrainExecutionConfig(config) {
    if (!opened) return { ok: false, code: 'STORE_CLOSED' };
    if (!config || typeof config !== 'object' || Array.isArray(config)) return { ok: false, code: 'BAD_REQUEST' };
    writeMeta(MB_CONFIG_META_KEY, JSON.stringify(config));
    return { ok: true, updatedAt: intOf(clock()) };
  }
  /* 读不到 / 坏 JSON → null（调用方回落 canonical 默认值 = 未启用）。
     这里刻意**不**回一个空对象：那会让"没发布过"与"发布过但内容为空"看起来一样。 */
  function getMiddleBrainExecutionConfig() {
    if (!opened) return null;
    const raw = readMeta(MB_CONFIG_META_KEY);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : null;
    } catch (_) { return null; }
  }

  function meta() {
    return {
      ok: true,
      open: opened,
      file: dbFile,
      schemaVersion: SCHEMA_VERSION,
      storedSchemaVersion: opened ? Number(readMeta('devices_schema') || SCHEMA_VERSION) : SCHEMA_VERSION,
      devices: opened ? countDevices() : 0,
      allDevices: opened ? countAllDevices() : 0,
      openPairingSessions: opened ? countOpenPairingSessions() : 0,
      characters: opened ? countCharacters() : 0,
      lastOpenedAt: lastOpenedAt
    };
  }

  return {
    open: open,
    attachReadOnlyConnection: attachReadOnlyConnection,
    close: close,
    isOpen: isOpen,
    meta: meta,

    createPairingSession: createPairingSession,
    consumePairingSession: consumePairingSession,
    pairingStatus: pairingStatus,

    issueDevice: issueDevice,
    verifyDeviceToken: verifyDeviceToken,
    rotateDeviceToken: rotateDeviceToken,
    currentTokenHash: currentTokenHash,
    getDevice: getDevice,
    listDevices: listDevices,
    touchDevice: touchDevice,
    renameDevice: renameDevice,
    revokeDevice: revokeDevice,
    deviceDto: deviceDto,

    putCharacter: putCharacter,
    putCharacters: putCharacters,
    listCharacters: listCharacters,
    getCharacter: getCharacter,
    getCharacterSpec: getCharacterSpec,
    readCharacterDtoProjections: readCharacterDtoProjections,
    applyCharacterDtoProjectionBatch: applyCharacterDtoProjectionBatch,
    characterCatalogUpdatedAt: characterCatalogUpdatedAt,

    /* M1-C.2i · 全局执行策略（非凭据；见函数头注释） */
    putMiddleBrainExecutionConfig: putMiddleBrainExecutionConfig,
    getMiddleBrainExecutionConfig: getMiddleBrainExecutionConfig,
    MB_CONFIG_META_KEY: MB_CONFIG_META_KEY,

    fingerprint: fingerprint,
    file: dbFile,
    schemaVersion: SCHEMA_VERSION,

    /* 供测试与诊断（纯函数） */
    sha256Hex: sha256Hex,
    constantTimeEqual: constantTimeEqual,
    normalizeCapabilities: normalizeCapabilities,
    DEVICE_TYPES: DEVICE_TYPES,
    KNOWN_CAPABILITIES: KNOWN_CAPABILITIES,
    DEFAULT_CAPABILITIES: DEFAULT_CAPABILITIES,
    TOKEN_FORMAT_VERSION: TOKEN_FORMAT_VERSION
  };
}

module.exports = createDeviceRegistry;
module.exports.SCHEMA_VERSION = SCHEMA_VERSION;
module.exports.PAIRING_TTL_MS = PAIRING_TTL_MS;
module.exports.PAIRING_RETENTION_MS = PAIRING_RETENTION_MS;
module.exports.TOKEN_FORMAT_VERSION = TOKEN_FORMAT_VERSION;
module.exports.KNOWN_CAPABILITIES = KNOWN_CAPABILITIES;
module.exports.DEFAULT_CAPABILITIES = DEFAULT_CAPABILITIES;
module.exports.DEVICE_TYPES = DEVICE_TYPES;
