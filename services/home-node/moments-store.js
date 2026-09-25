/* ====================================================================
   IB Home Node · Canonical Moments Store（M1-C.2n P4）
   --------------------------------------------------------------------
   目的：让 Home Node 成为 `moments`（朋友圈动态）的 canonical authority ——
   与 chat-store.js / memory-store.js / understanding-store.js **同构**
   （同一个 SQLite 文件、同一套 PRAGMA、同一个 meta / idempotency 表、
   同样的迁移水位与损坏隔离纪律），但写协议是**第四种**：

     chat            创建即不可变              existingPolicy:'skip'
     memory          可变映射（覆盖式）         revision 前进，无 CAS
     understanding   单活文档 + 修订链          每次重写带 expectedRevision（CAS）
     moments         可编辑的**多条**记录 + 嵌套子结构（comments / likes）
                                             每行一个 rev，写可带 expectedRev（CAS）

   为什么不能塞进 memory-store：不只是约束不同，**查询边界**也不同。
   Moments 的分页必须做到"隐藏行不占页槽"（§10），这要求过滤发生在
   分页游标**之前**；而 memory 的读路径是"全表 + 可见性前置过滤 + 打分"。
   把两种分页语义塞进一个 store，会让"这一页为什么是这几条"无法审计。

   ── revision 命名空间**独立**（§7 / §17-C6）─────────────────────────
   本 store 的全局单调版本存在 meta 键 `moments_revision` 上，与
   `memory_revision` / `understanding_revision` / chat 的版本**互不相干**。
   一次 Moment 写入不得推进任何其它权威的版本号，反之亦然。
   这不是约定，是可测的：`revisionIsolation()` 会把四类版本号一起读出来。

   ── ACL 不在 SQL 里，也不在 store 里"另写一份" ───────────────────────
   可见性判定委托给 `assets/js/moments-visibility-core.js`（浏览器与 Node
   共用同一份实现）。store 只负责"把候选行取出来 + 把 core 判为可见的行
   按游标切页"。**绝不在 store 里写第二套 ACL 条件**：
   一条 SQL 谓词 + 一份 core 谓词 = 两处可以漂移的语义，而漂移的后果
   正是本阶段要消灭的东西。

   ── 缺失 ACL 的行按最严处理 ─────────────────────────────────────────
   迁移期从浏览器搬过来的旧行可能完全没有 `visibility` 字段。
   core 的读侧把缺失归一为 'invalid' → 只有作者可读。因此旧数据不会因为
   "某个调用方忘了写字段"而变成公开，且这一性质不需要迁移期做任何猜测。
   ==================================================================== */
'use strict';

const path = require('path');
const fs = require('fs');

const MOMENT_VIS = require(path.join(__dirname, '..', '..', 'assets', 'js', 'moments-visibility-core.js'));

const MOMENTS_SCHEMA_VERSION = 1;
const RECORDS_TABLE = 'moment_records';
const CHANGE_LOG_TABLE = 'moment_change_log';

/* ── P11-3G · change-log 投递（delivery）与回收（retention）的常量 ─────────
   三个数字都是**上界**，不是"建议值"：
     · CONSUMER_MAX       一个 consumer id 的字节上界（它同时是 meta 键的一部分）
     · CHANGE_LOG_MAX     触发回收的日志水位（O(1) 的 MAX-MIN 跨度判断，不做 COUNT）
     · CHANGE_LOG_PRUNE   单次回收的行数上界（有界工作，不因为库大就卡住一次写入）
   刻意**不**新建表、不升 schema：投递水位是 store 自己拥有的元数据，
   与迁移水位 `migration:moments:*` 是同一类东西，因此落在同一个 meta 平面。 */
const DELIVERY_CONSUMER_MAX = 64;
const DELIVERY_KEY_PREFIX = 'delivery_watermark:moments:';
const CHANGE_LOG_MAX = 20000;
const CHANGE_LOG_PRUNE_BATCH = 5000;

const IDEMPOTENCY_MAX = 1000;
const DEFAULT_DB_FILENAME = 'home-node.db';
const ID_MAX = 128;
const OWNER_MAX = 128;
const CONTENT_MAX = 2000;
const VISIBLE_ROLES_MAX = 20;
const COMMENTS_MAX = 200;
const LIKES_MAX = 1000;
const PAGE_MAX = 200;
const IMAGE_DATAURL_MAX = 2.5e6;
const IMAGES_MAX = 9;

/* node:sqlite 是 Node 22.5+ 的内置模块（shipped runtime 已确认可用）。
   缺失时明确报错，绝不静默退化成另一套存储语义 —— 与兄弟 store 同款。 */
function loadSqlite() {
  try { return require('node:sqlite'); }
  catch (error) {
    const err = new Error('node:sqlite is unavailable in this runtime: ' + (error && error.message || error));
    err.code = 'SQLITE_UNAVAILABLE';
    throw err;
  }
}

function intOf(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}
function strOf(v, max) {
  const s = String(v == null ? '' : v).trim();
  return max && s.length > max ? s.slice(0, max) : s;
}
function idsOf(v, max) {
  const list = Array.isArray(v) ? v : (v == null ? [] : [v]);
  const out = [];
  const seen = new Set();
  for (const raw of list) {
    const id = strOf(raw, 128);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (max && out.length >= max) break;
  }
  return out;
}
/* createdAt 的权威形态：canonical 侧统一存**毫秒数**（排序与分页游标都靠它），
   同时把原字符串留在 payload 里往返。浏览器传来的 ISO 字符串在这里归一。 */
function timeMsOf(v, fallback) {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v);
  const s = String(v == null ? '' : v);
  if (s) {
    const t = Date.parse(s);
    if (Number.isFinite(t)) return t;
  }
  return intOf(fallback);
}
function imagesOf(v) {
  const list = Array.isArray(v) ? v : [];
  const out = [];
  for (const im of list) {
    if (!im || typeof im !== 'object') continue;
    const dataUrl = String(im.dataUrl || '');
    if (dataUrl.length > IMAGE_DATAURL_MAX) continue;
    out.push({
      dataUrl: dataUrl,
      mime: strOf(im.mime, 64),
      name: strOf(im.name, 200)
    });
    if (out.length >= IMAGES_MAX) break;
  }
  return out;
}

/* ── principal：与浏览器侧**同一形状**（{kind:'user'|'role', id}）。
   store 只做形状归一，不做语义判断（语义只有 core 一份）。 */
function principalOf(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const kind = raw.kind === 'user' ? 'user' : (raw.kind === 'role' ? 'role' : '');
  const id = strOf(raw.id, OWNER_MAX);
  if (!kind || !id) return null;
  return { kind: kind, id: id };
}

function createMomentsStore(deps) {
  deps = deps || {};
  const dataDir = deps.dataDir || process.cwd();
  const dbFile = deps.dbFile || path.join(dataDir, DEFAULT_DB_FILENAME);
  const clock = deps.clock || (() => Date.now());
  const logger = deps.logger || (() => {});
  const core = deps.core || MOMENT_VIS;
  const sqlite = deps.sqlite || loadSqlite();
  /* 回收阈值与批量同样是**注入接缝**（与 clock / dataDir / sqlite 同一类）：
     生产一律走常量，测试可以在小库上把真实的触发路径走一遍 ——
     否则"回收有没有按契约发生"就只能靠造两万条日志来问，那既慢又测不到边界。
     缺省值就是生产值，没有任何一条生产路径会传别的。 */
  const changeLogMax = Number.isFinite(Number(deps.changeLogMax)) && Number(deps.changeLogMax) > 0
    ? Math.trunc(Number(deps.changeLogMax)) : CHANGE_LOG_MAX;
  const changeLogPruneBatch = Number.isFinite(Number(deps.changeLogPruneBatch)) && Number(deps.changeLogPruneBatch) > 0
    ? Math.trunc(Number(deps.changeLogPruneBatch)) : CHANGE_LOG_PRUNE_BATCH;

  let db = null;
  let opened = false;
  let ownsDb = false;

  const SQL = {
    createRecords:
      'CREATE TABLE IF NOT EXISTS ' + RECORDS_TABLE + ' (' +
      ' record_id TEXT PRIMARY KEY,' +
      ' author_type TEXT NOT NULL DEFAULT "role",' +
      ' author_id TEXT NOT NULL DEFAULT "",' +
      ' owner_role_id TEXT NOT NULL DEFAULT "",' +
      ' content TEXT NOT NULL DEFAULT "",' +
      ' visibility TEXT NOT NULL DEFAULT "",' +
      ' visible_role_ids TEXT NOT NULL DEFAULT "",' +
      ' likes TEXT NOT NULL DEFAULT "",' +
      ' comment_count INTEGER NOT NULL DEFAULT 0,' +
      ' source TEXT NOT NULL DEFAULT "manual",' +
      ' created_at INTEGER NOT NULL,' +
      ' updated_at INTEGER NOT NULL,' +
      ' record_rev INTEGER NOT NULL DEFAULT 1,' +
      ' revision INTEGER NOT NULL,' +
      ' created_rev INTEGER NOT NULL,' +
      ' deleted_at INTEGER,' +
      ' deleted_rev INTEGER,' +
      ' payload_json TEXT NOT NULL' +
      ')',
    createByOwner: 'CREATE INDEX IF NOT EXISTS idx_moment_owner ON ' + RECORDS_TABLE + ' (owner_role_id, created_at)',
    createByAuthor: 'CREATE INDEX IF NOT EXISTS idx_moment_author ON ' + RECORDS_TABLE + ' (author_type, author_id)',
    createByCreated: 'CREATE INDEX IF NOT EXISTS idx_moment_created ON ' + RECORDS_TABLE + ' (created_at)',
    createByRevision: 'CREATE INDEX IF NOT EXISTS idx_moment_rev ON ' + RECORDS_TABLE + ' (revision)',
    createChangeLog:
      'CREATE TABLE IF NOT EXISTS ' + CHANGE_LOG_TABLE + ' (' +
      ' revision INTEGER PRIMARY KEY,' +
      ' kind TEXT NOT NULL,' +
      ' record_id TEXT NOT NULL,' +
      ' at INTEGER NOT NULL' +
      ')',
    createMeta: 'CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
    createIdempotency:
      'CREATE TABLE IF NOT EXISTS idempotency (' +
      ' key TEXT PRIMARY KEY,' +
      ' kind TEXT NOT NULL,' +
      ' message_id TEXT NOT NULL,' +
      ' at INTEGER NOT NULL' +
      ')',
    insertRecord:
      'INSERT INTO ' + RECORDS_TABLE + ' ' +
      '(record_id, author_type, author_id, owner_role_id, content, visibility, visible_role_ids, likes, comment_count, ' +
      ' source, created_at, updated_at, record_rev, revision, created_rev, deleted_at, deleted_rev, payload_json) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)',
    updateRecord:
      'UPDATE ' + RECORDS_TABLE + ' SET author_type=?, author_id=?, owner_role_id=?, content=?, visibility=?, ' +
      'visible_role_ids=?, likes=?, comment_count=?, source=?, created_at=?, updated_at=?, record_rev=?, revision=?, ' +
      'deleted_at=NULL, deleted_rev=NULL, payload_json=? WHERE record_id=?',
    softDelete: 'UPDATE ' + RECORDS_TABLE + ' SET deleted_at=?, deleted_rev=?, revision=?, updated_at=? WHERE record_id=? AND deleted_at IS NULL',
    selectRecord: 'SELECT * FROM ' + RECORDS_TABLE + ' WHERE record_id=? AND deleted_at IS NULL',
    selectRecordAny: 'SELECT * FROM ' + RECORDS_TABLE + ' WHERE record_id=?',
    selectLive: 'SELECT * FROM ' + RECORDS_TABLE + ' WHERE deleted_at IS NULL ORDER BY created_at DESC, record_id DESC LIMIT ?',
    selectByOwner: 'SELECT * FROM ' + RECORDS_TABLE + ' WHERE deleted_at IS NULL AND owner_role_id=? ORDER BY created_at DESC, record_id DESC LIMIT ?',
    /* 分页游标：严格早于 cursor（created_at, record_id 复合，避免同毫秒丢行/重行）。 */
    selectPage: 'SELECT * FROM ' + RECORDS_TABLE + ' WHERE deleted_at IS NULL AND (created_at < ? OR (created_at = ? AND record_id < ?)) ORDER BY created_at DESC, record_id DESC LIMIT ?',
    selectPageByOwner: 'SELECT * FROM ' + RECORDS_TABLE + ' WHERE deleted_at IS NULL AND owner_role_id=? AND (created_at < ? OR (created_at = ? AND record_id < ?)) ORDER BY created_at DESC, record_id DESC LIMIT ?',
    countLive: 'SELECT COUNT(*) AS c FROM ' + RECORDS_TABLE + ' WHERE deleted_at IS NULL',
    countAll: 'SELECT COUNT(*) AS c FROM ' + RECORDS_TABLE,
    countOwners: 'SELECT COUNT(DISTINCT owner_role_id) AS c FROM ' + RECORDS_TABLE + ' WHERE deleted_at IS NULL AND owner_role_id <> ""',
    countByVisibility: 'SELECT visibility, COUNT(*) AS c FROM ' + RECORDS_TABLE + ' WHERE deleted_at IS NULL GROUP BY visibility',
    insertChange: 'INSERT INTO ' + CHANGE_LOG_TABLE + ' (revision, kind, record_id, at) VALUES (?, ?, ?, ?)',
    selectChanges: 'SELECT revision, kind, record_id, at FROM ' + CHANGE_LOG_TABLE + ' WHERE revision > ? ORDER BY revision ASC LIMIT ?',
    maxChangeRevision: 'SELECT MAX(revision) AS m FROM ' + CHANGE_LOG_TABLE,
    changeLogRange: 'SELECT MIN(revision) AS lo, MAX(revision) AS hi FROM ' + CHANGE_LOG_TABLE,
    countChangeLog: 'SELECT COUNT(*) AS c FROM ' + CHANGE_LOG_TABLE,
    /* 前缀回收：只删**已确认投递**的那一段，且有界。 */
    deleteChangesUpTo:
      'DELETE FROM ' + CHANGE_LOG_TABLE + ' WHERE revision IN (' +
      'SELECT revision FROM ' + CHANGE_LOG_TABLE + ' WHERE revision <= ? ORDER BY revision ASC LIMIT ?)',
    selectDeliveryKeys: 'SELECT key, value FROM meta WHERE key LIKE ?',
    selectMeta: 'SELECT value FROM meta WHERE key=?',
    upsertMeta: 'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
    selectIdempotency: 'SELECT key, kind, message_id FROM idempotency WHERE key=?',
    insertIdempotency: 'INSERT INTO idempotency (key, kind, message_id, at) VALUES (?, ?, ?, ?)',
    pruneIdempotency: 'DELETE FROM idempotency WHERE at < ?',
    countIdempotency: 'SELECT COUNT(*) AS c FROM idempotency'
  };

  let SQL_READY = null;
  function sqliteExec(sql, params) { return db.prepare(sql).run(...(params || [])); }
  function sqliteGet(sql, params) { return db.prepare(sql).get(...(params || [])); }
  function sqliteAll(sql, params) { return db.prepare(sql).all(...(params || [])); }

  function open() {
    if (opened) return { ok: true, alreadyOpen: true, file: dbFile, schemaVersion: MOMENTS_SCHEMA_VERSION };
    if (!SQL_READY) {
      SQL_READY = true;
      try { fs.mkdirSync(path.dirname(dbFile), { recursive: true }); } catch (_) { /* 已存在 */ }
    }
    const { DatabaseSync } = sqlite;
    db = new DatabaseSync(dbFile);
    ownsDb = true;
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = NORMAL');
    db.exec('PRAGMA foreign_keys = ON');
    for (const key of ['createRecords', 'createByOwner', 'createByAuthor', 'createByCreated', 'createByRevision', 'createChangeLog', 'createMeta', 'createIdempotency']) {
      db.exec(SQL[key]);
    }
    const stored = readMeta('moments_schema');
    if (stored == null) writeMeta('moments_schema', String(MOMENTS_SCHEMA_VERSION));
    else if (Number(stored) > MOMENTS_SCHEMA_VERSION) {
      const err = new Error('moments store schema is newer than this build (' + stored + ' > ' + MOMENTS_SCHEMA_VERSION + ')');
      err.code = 'SCHEMA_TOO_NEW';
      try { db.close(); } catch (_) { /* ignore */ }
      db = null;
      throw err;
    }
    opened = true;
    logger('moments-store-open', { file: dbFile, schemaVersion: MOMENTS_SCHEMA_VERSION });
    return { ok: true, alreadyOpen: false, file: dbFile, schemaVersion: MOMENTS_SCHEMA_VERSION };
  }

  /* RecoveryOnly attachment to a query-only connection; this deliberately
     skips DDL, metadata initialization, and migration behavior in open(). */
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
      const schema = readMeta('moments_schema');
      if (schema == null || Number(schema) > MOMENTS_SCHEMA_VERSION) throw Object.assign(new Error('schema-version-invalid'), { code: 'SCHEMA_VERSION_INVALID' });
      opened = true;
      ownsDb = false;
      return { ok: true, readOnly: true, schemaVersion: MOMENTS_SCHEMA_VERSION };
    } catch (error) {
      db = null;
      opened = false;
      ownsDb = false;
      throw error;
    }
  }

  function close() {
    if (!db) return { ok: true, alreadyClosed: true };
    if (ownsDb) { try { db.close(); } catch (_) { /* ignore */ } }
    db = null;
    opened = false;
    ownsDb = false;
    return { ok: true };
  }
  function isOpen() { return opened && !!db; }

  function readMeta(key) {
    const row = sqliteGet(SQL.selectMeta, [key]);
    return row ? row.value : null;
  }
  function writeMeta(key, value) { sqliteExec(SQL.upsertMeta, [key, String(value)]); }
  /* mode='read' → DEFERRED（只读快照，不与写者抢写锁）；缺省 IMMEDIATE（写事务）。
     需要读模式的是镜像播种：它要在**同一个快照**里同时读到行集与版本号。 */
  function withTransaction(fn, mode) {
    db.exec(mode === 'read' ? 'BEGIN' : 'BEGIN IMMEDIATE');
    try {
      const out = fn();
      db.exec('COMMIT');
      return out;
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch (_) { /* 保留原始错误 */ }
      throw error;
    }
  }

  /* ── 本域**独立**的全局版本命名空间 ─────────────────────────────────
     刻意使用 `moments_revision` 而不是任何共享键：一次 Moment 写入
     不可能推进 memory / understanding / chat 的版本号。 */
  function getRevision() {
    const stored = Number(readMeta('moments_revision') || 0);
    const inLog = sqliteGet(SQL.maxChangeRevision);
    const logged = (inLog && inLog.m) || 0;
    return Math.max(stored, logged);
  }
  function allocateRevision() {
    const next = getRevision() + 1;
    writeMeta('moments_revision', String(next));
    return next;
  }
  /* 版本隔离自检：四类权威的版本号各读各的。任何一次 Moment 写入之后，
     非 moments 的键必须逐字节不变（见 tests/test_moments_authority.js）。 */
  function revisionIsolation() {
    if (!isOpen()) return { ok: false, error: 'store-closed' };
    return {
      ok: true,
      moments: getRevision(),
      metaKeys: {
        moments_revision: readMeta('moments_revision'),
        memory_revision: readMeta('memory_revision'),
        understanding_revision: readMeta('understanding_revision')
      }
    };
  }

  function rowToMoment(row) {
    let parsed = null;
    try { parsed = JSON.parse(row.payload_json); }
    catch (error) {
      logger('moments-payload-parse-failed', { id: row.record_id, kind: 'malformed-payload' });
      parsed = null;
    }
    if (!parsed || typeof parsed !== 'object') parsed = {};
    /* payload 是权威内容；提升列里"store 拥有的"字段在读回时以列为准
       （否则一条 payload 就能改掉自己的可见性列与版本号）。 */
    if (parsed.id == null) parsed.id = row.record_id;
    parsed.authorType = row.author_type === 'user' ? 'user' : 'role';
    parsed.authorId = row.author_id;
    parsed.roleId = row.owner_role_id;
    parsed.content = row.content;
    parsed.visibility = row.visibility;
    parsed.visibleRoleIds = row.visible_role_ids ? String(row.visible_role_ids).split(',').filter(Boolean) : [];
    parsed.likes = row.likes ? String(row.likes).split(',').filter(Boolean) : [];
    parsed.commentCount = Number(row.comment_count) || 0;
    if (!Array.isArray(parsed.comments)) parsed.comments = [];
    parsed.source = row.source;
    parsed.createdAt = row.created_at;
    parsed.storeRevision = Number(row.revision) || 0;
    parsed.rev = Number(row.record_rev) || 0;
    parsed.deletedAt = row.deleted_at == null ? null : Number(row.deleted_at);
    return parsed;
  }

  /* ── 候选归一：把不可信输入收敛成"store 拥有的字段" ─────────────────
     这里**不做**可见性语义判断（那是 core 的事），只做形状与档位归一。
     但"写入"与"迁移"的档位归一**必须分开**（这是本 store 最容易写错的一处）：

       · 写入（migrate=false）：缺失档位 → 'all'
         —— 这是一个**产品默认值**决策："模型/用户没标注 = 公开"。
       · 迁移（migrate=true）：缺失档位 → 原样留空
         —— 旧数据里"没有 visibility"是一个**事实**，不是"没标注"。
         读侧会把空归一为 'invalid' → 只有作者可读。
         若迁移期套用写入默认，旧数据会在搬家途中从"仅作者可见"变成公开 ——
         这正是 §9 明文禁止的 hidden→public 放宽，而且是静默发生的。
     非法但存在的档位（拼错）：两种模式都归一为 'invalid'（读侧永不可见，作者除外）。 */
  function normalizeCandidate(input, mode) {
    const raw = (input && typeof input === 'object') ? input : {};
    const migrating = !!(mode && mode.migrating);
    const id = strOf(raw.id, ID_MAX);
    const isUser = raw.authorType === 'user';
    const ownerRoleId = isUser ? '' : strOf(raw.roleId || raw.authorId, OWNER_MAX);
    const authorId = isUser ? strOf(raw.authorId || raw.userId, OWNER_MAX) : ownerRoleId;
    const absentVisibility = (raw.visibility == null || raw.visibility === '');
    const visibility = (migrating && absentVisibility)
      ? ''
      : core.writeVisibility(raw.visibility);
    const content = String(raw.content == null ? '' : raw.content).slice(0, CONTENT_MAX);
    const images = imagesOf(raw.images);
    return {
      id: id,
      authorType: isUser ? 'user' : 'role',
      authorId: authorId,
      roleId: ownerRoleId,
      content: content,
      images: images,
      visibility: visibility,
      visibleRoleIds: visibility === 'roles' ? idsOf(raw.visibleRoleIds, VISIBLE_ROLES_MAX) : [],
      likes: idsOf(raw.likes, LIKES_MAX),
      comments: Array.isArray(raw.comments) ? raw.comments.slice(0, COMMENTS_MAX).map(c => ({
        id: strOf(c && c.id, 96),
        authorType: c && c.authorType === 'role' ? 'role' : 'user',
        authorId: strOf(c && c.authorId, OWNER_MAX) || 'user',
        content: String((c && c.content) || '').slice(0, 600),
        replyTo: strOf(c && c.replyTo, 96),
        createdAt: timeMsOf(c && c.createdAt, clock()),
        withdrawn: !!(c && c.withdrawn)
      })).filter(c => !!c.id) : [],
      source: (raw.source === 'proactive' || raw.source === 'manual') ? raw.source : 'manual',
      motive: strOf(raw.motive, 32),
      repostOf: strOf(raw.repostOf, ID_MAX),
      repostText: String(raw.repostText == null ? '' : raw.repostText).slice(0, 200),
      createdAt: timeMsOf(raw.createdAt, clock())
    };
  }

  /* 内容等价判定（不含遥测）：用于让"重复写入同一份内容"返回 skipped 而不是
     白推一次版本号 —— 幂等创建/重试（R7）依赖它。 */
  function contentKeyOf(m) {
    return JSON.stringify({
      c: m.content, v: m.visibility, r: m.visibleRoleIds, i: (m.images || []).map(x => String(x.dataUrl || '').length),
      l: m.likes, k: (m.comments || []).map(c => c.id + ':' + c.content), s: m.source, m: m.motive,
      rp: m.repostOf, rt: m.repostText, ab: m.repostOf ? 1 : 0
    });
  }

  function requestKey(raw) { return raw ? 'mo:' + String(raw) : ''; }
  function rememberRequest(key, kind, value) {
    if (!key) return;
    try {
      sqliteExec(SQL.insertIdempotency, [key, kind, String(value == null ? '' : value), clock()]);
      const countRow = sqliteGet(SQL.countIdempotency);
      if (countRow && Number(countRow.c) > IDEMPOTENCY_MAX) {
        sqliteExec(SQL.pruneIdempotency, [clock() - 86400000]);
      }
    } catch (error) {
      logger('moments-idempotency-failed', { error: String((error && error.message) || error) });
    }
  }
  function lookupRequest(key) {
    if (!key) return null;
    try {
      const row = sqliteGet(SQL.selectIdempotency, [key]);
      if (!row) return null;
      return { key: String(key), kind: row.kind, recordId: row.message_id };
    } catch (error) { return null; }
  }

  function insertRow(moment, revision, recordRev) {
    sqliteExec(SQL.insertRecord, [
      moment.id, moment.authorType, moment.authorId, moment.roleId, moment.content, moment.visibility,
      moment.visibleRoleIds.join(','), moment.likes.join(','), moment.comments.length, moment.source,
      moment.createdAt, clock(), recordRev, revision, revision,
      JSON.stringify(moment)
    ]);
  }
  function updateRow(moment, revision, recordRev) {
    sqliteExec(SQL.updateRecord, [
      moment.authorType, moment.authorId, moment.roleId, moment.content, moment.visibility,
      moment.visibleRoleIds.join(','), moment.likes.join(','), moment.comments.length, moment.source,
      moment.createdAt, clock(), recordRev, revision, JSON.stringify(moment), moment.id
    ]);
  }
  function logChange(revision, kind, id) {
    sqliteExec(SQL.insertChange, [revision, kind, id, clock()]);
  }

  /* ── 写入：一次 Moment 的持久变更 ────────────────────────────────────
     options.expectedRev  —— CAS：必须等于当前 record_rev；不匹配 → revision-conflict，
                             **零变更**。迁移分支用 {migrate:true} 显式跳过 CAS。
     options.requestId    —— 幂等键：同一 key 重放不产生第二行（R7）。 */
  function put(input, options) {
    options = options || {};
    if (!isOpen()) return { ok: false, error: 'store-closed' };
    const candidate = normalizeCandidate(input);
    if (!candidate.id) return { ok: false, error: 'invalid-id', outcome: 'invalid' };
    /* 作者身份不可判定 → 拒收。
       一条既没有 roleId 又没有 authorId 的记录**不属于任何主体**：
       可见性谓语连"作者规则"都无从适用，于是它会静静地谁都读不到 ——
       看起来像安全，实际是一条永远无法被检索、也无法被审计的孤儿行。
       在写入侧拒绝，比让它落盘再变成"神秘不可见数据"诚实。 */
    if (!candidate.authorId) return { ok: false, error: 'unattributable', outcome: 'invalid', id: candidate.id };
    /* 全空白内容不是内容（否则会落一行"看起来有内容、实际是空白"的动态）。 */
    if (!candidate.content.trim() && !candidate.images.length && !candidate.repostOf) {
      return { ok: false, error: 'empty-content', outcome: 'invalid', id: candidate.id };
    }
    const key = requestKey(options.requestId);
    const seen = lookupRequest(key);
    if (seen) {
      /* 重放：只回执，不写第二次。 */
      return { ok: true, outcome: 'replayed', id: seen.recordId || candidate.id, revision: getRevision(), recorded: true };
    }
    try {
      return withTransaction(() => {
        const existing = sqliteGet(SQL.selectRecord, [candidate.id]);
        if (existing) {
          const current = rowToMoment(existing);
          const expected = options.expectedRev;
          if (!options.migrate && expected != null && Number(expected) !== Number(current.rev)) {
            return {
              ok: false, outcome: 'conflict', error: 'revision-conflict', id: candidate.id,
              expectedRev: Number(expected), actualRev: Number(current.rev)
            };
          }
          const unchanged = contentKeyOf(candidate) === contentKeyOf(current);
          if (unchanged) {
            return { ok: true, outcome: 'skipped', id: candidate.id, rev: Number(current.rev), revision: getRevision() };
          }
          const revision = allocateRevision();
          const recordRev = Number(current.rev) + 1;
          /* createdAt 是**不可变**的：编辑不得把一条动态搬到时间线顶部
             （那会让分页游标看到"同一行出现在两页"）。 */
          const merged = Object.assign({}, current, candidate, { createdAt: current.createdAt });
          updateRow(merged, revision, recordRev);
          logChange(revision, 'upsert', candidate.id);
          rememberRequest(key, 'put', candidate.id);
          return { ok: true, outcome: 'updated', id: candidate.id, rev: recordRev, revision: revision, moment: merged };
        }
        /* 新建 */
        const revision = allocateRevision();
        insertRow(candidate, revision, 1);
        logChange(revision, 'upsert', candidate.id);
        rememberRequest(key, 'put', candidate.id);
        return { ok: true, outcome: 'created', id: candidate.id, rev: 1, revision: revision, moment: candidate };
      });
    } catch (error) {
      logger('moments-put-failed', { id: candidate.id, error: String((error && error.message) || error) });
      return { ok: false, error: String((error && error.message) || error), id: candidate.id };
    }
  }

  /* 迁移专用：**永不**覆盖已存在的 canonical 行（R4：迁移与并发写入竞争时，
     权威侧赢得比赛，迁移只报告 skipped）。显式无 CAS。 */
  function writeMigrated(input, requestId) {
    if (!isOpen()) return { ok: false, error: 'store-closed' };
    const candidate = normalizeCandidate(input, { migrating: true });
    if (!candidate.id) return { ok: false, error: 'invalid-id', outcome: 'invalid' };
    /* 与 put 同款：不可归属的旧行**不落盘**，并如实报出来（迁移报告据此说明
       "哪些行没有被搬过来、为什么"）—— 而不是搬一条谁都读不到的孤儿行。 */
    if (!candidate.authorId) {
      return { ok: false, error: 'unattributable', outcome: 'invalid', id: candidate.id, reason: 'no-author-identity' };
    }
    const key = requestKey(requestId);
    const seen = lookupRequest(key);
    if (seen) return { ok: true, outcome: 'replayed', id: seen.recordId || candidate.id, revision: getRevision() };
    try {
      return withTransaction(() => {
        const existing = sqliteGet(SQL.selectRecord, [candidate.id]);
        if (existing) {
          /* 已存在 → 绝不改写（canonical 优先；迁移是补数据的，不是覆盖数据的）。 */
          rememberRequest(key, 'migrate', candidate.id);
          return { ok: true, outcome: 'skipped', reason: 'exists-on-node', id: candidate.id, revision: getRevision() };
        }
        const revision = allocateRevision();
        insertRow(candidate, revision, 1);
        logChange(revision, 'upsert', candidate.id);
        rememberRequest(key, 'migrate', candidate.id);
        return { ok: true, outcome: 'created', id: candidate.id, rev: 1, revision: revision, moment: candidate };
      });
    } catch (error) {
      return { ok: false, error: String((error && error.message) || error), id: candidate.id };
    }
  }

  function remove(id, options) {
    options = options || {};
    if (!isOpen()) return { ok: false, error: 'store-closed' };
    const target = strOf(id, ID_MAX);
    if (!target) return { ok: false, error: 'invalid-id' };
    try {
      return withTransaction(() => {
        const existing = sqliteGet(SQL.selectRecord, [target]);
        if (!existing) return { ok: true, outcome: 'not-present', id: target, revision: getRevision(), deleted: false };
        const expected = options.expectedRev;
        if (expected != null && Number(expected) !== Number(existing.record_rev)) {
          return { ok: false, outcome: 'conflict', error: 'revision-conflict', id: target, expectedRev: Number(expected), actualRev: Number(existing.record_rev) };
        }
        const revision = allocateRevision();
        /* 软删除 + 墓碑：镜像侧靠 change_log 的 kind='delete' 移除本地行。
           保留墓碑行是"迁移非破坏"的一部分 —— 删错时有据可查。 */
        sqliteExec(SQL.softDelete, [clock(), revision, revision, clock(), target]);
        logChange(revision, 'delete', target);
        return { ok: true, outcome: 'deleted', id: target, revision: revision, deleted: true };
      });
    } catch (error) {
      return { ok: false, error: String((error && error.message) || error) };
    }
  }

  function getRecord(id) {
    if (!isOpen()) return null;
    const row = sqliteGet(SQL.selectRecord, [strOf(id, ID_MAX)]);
    return row ? rowToMoment(row) : null;
  }
  function getRecordAny(id) {
    if (!isOpen()) return null;
    const row = sqliteGet(SQL.selectRecordAny, [strOf(id, ID_MAX)]);
    if (!row) return null;
    const moment = rowToMoment(row);
    moment.deleted = row.deleted_at != null;
    return moment;
  }

  /* ── 原始候选页（**不含** ACL；仅供迁移/诊断/可见性分页内部使用）────
     生产读路径必须是 listVisible：它保证"隐藏行不占页槽"。 */
  function candidatePage(options) {
    options = options || {};
    const limit = Math.max(1, Math.min(PAGE_MAX, intOf(options.limit) || 50));
    const cursor = options.cursor && typeof options.cursor === 'object' ? options.cursor : null;
    const at = cursor ? intOf(cursor.createdAt) : Number.MAX_SAFE_INTEGER;
    const id = cursor ? strOf(cursor.id, ID_MAX) : '\uffff';
    const owner = strOf(options.ownerRoleId, OWNER_MAX);
    const rows = owner
      ? sqliteAll(SQL.selectPageByOwner, [owner, at, at, id, limit])
      : sqliteAll(SQL.selectPage, [at, at, id, limit]);
    return { records: rows.map(rowToMoment), scanned: rows.length };
  }

  /* ── 镜像播种读口（listRecords）────────────────────────────────────
     生产上唯一的调用方是网关的 `/moments/list`；浏览器侧拿它做**破坏性**
     整表替换镜像，因此它的输出必须是"可判定的权威快照"，而不是"大概看看"。
     P11-3F 在此收紧两件事（都不改 schema、不新建协议）：

     ① **行集与版本号必须出自同一个读事务**。原先"先 SELECT 行、再另读
        moments_revision / change_log"是两次独立读：中间落进一次写入时，返回的
        revision 会比行集**更新**，客户端据此推进游标 —— 那条新行动态就再也
        不会通过增量补上（镜像永久缺一行，且所有标志都是绿的）。
     ② 增加 `truncated`（与 `memory-store.listRecords` 逐字同款）：`limit` 有上限，
        取满上限时**如实报告**"这一页可能是截断的"。截断的页
        **不允许**被当作完整快照 —— 那正是"远端少说了一半"变成"镜像少了一半"的路径。 */
  const MIRROR_SEED_MAX = 100000;
  function listRecords(options) {
    options = options || {};
    if (!isOpen()) return { ok: false, error: 'store-closed', records: [], truncated: false };
    const rawLimit = options.limit == null ? 200 : Number(options.limit);
    const limit = isFinite(rawLimit) && rawLimit > 0
      ? Math.min(Math.trunc(rawLimit), MIRROR_SEED_MAX)
      : 200;
    const owner = strOf(options.ownerRoleId, OWNER_MAX);
    let rows = [];
    let revision = 0;
    withTransaction(() => {
      rows = owner ? sqliteAll(SQL.selectByOwner, [owner, limit]) : sqliteAll(SQL.selectLive, [limit]);
      revision = getRevision();
    }, 'read');
    return {
      ok: true, records: rows.map(rowToMoment), count: rows.length,
      revision: revision, truncated: rows.length >= limit
    };
  }

  /* ── 可见分页（§10 的核心）──────────────────────────────────────────
     契约：
       · 返回的每一条都对 principal 可见（判定来自共享 core，唯一实现）
       · limit 有**上限**，但"取够 limit 条可见行"才算一页：
         隐藏行不消耗页槽
       · hasMore 表示"游标之后**还有可见行**"，
         而不是"原始扫描没到头" —— 否则 UI 会得出"没有更多可见行"的错误结论
         （§10 明确禁止的第四种失败）
       · 隐藏行不参与任何 ranking / top-k（过滤在排序序列的产出侧之前：
         游标本身就是"时间倒序"，过滤在这个线性序列上做，因此隐藏行不可能
         影响哪个可见行入选）

     实现上刻意**不做 SQL 侧 ACL**：一条 SQL 谓词 + 一份 core 谓词就是两处
     可以漂移的语义。这里用 core 过滤 + 按需继续扫描下一页候选，
     以有界扫描次数（MAX_SCAN_PAGES）作为性能闸门，并把 reachedScanLimit
     如实报出来（不假装"没有更多"）。 */
  const MAX_SCAN_PAGES = 20;
  function listVisible(principalArg, options) {
    options = options || {};
    if (!isOpen()) return { ok: false, error: 'store-closed', moments: [], hasMore: false };
    const principal = principalOf(principalArg);
    if (!principal) {
      /* 没有主体 → 没有可见内容。**不是**"返回全部"（fail closed）。 */
      return { ok: true, moments: [], count: 0, hasMore: false, reason: 'no-principal', revision: getRevision() };
    }
    const limit = Math.max(1, Math.min(PAGE_MAX, intOf(options.limit) || 30));
    const scanSize = Math.max(limit * 2, 50);
    const owner = strOf(options.ownerRoleId, OWNER_MAX);
    let cursor = options.cursor && typeof options.cursor === 'object' ? options.cursor : null;
    let pages = 0, scanned = 0;
    const picked = [];
    while (picked.length < limit && pages < MAX_SCAN_PAGES) {
      const page = candidatePage({ limit: scanSize, cursor: cursor, ownerRoleId: owner });
      pages += 1;
      scanned += page.scanned;
      if (!page.records.length) break;
      for (const moment of page.records) {
        if (picked.length >= limit) break;
        /* 先判可见，再考虑是否入选：判定与入选之间没有别的步骤，
           因此隐藏行不可能"顺带"影响可见行的选择，也不可能占用页槽。 */
        if (core.isMomentVisibleTo(moment, principal)) picked.push(moment);
        cursor = { createdAt: moment.createdAt, id: moment.id };
      }
      if (page.records.length < scanSize) break;   /* 原始候选已到头 */
    }
    const full = picked.length >= limit;
    /* hasMore 的判据是"游标之后**是否还有可见行**"，而不是"原始扫描有没有到头"。
       单独探一条：若隐藏行堆在末尾，这里会如实返回 false，
       UI 因此不会得出"还有更多"的错误结论（反之也不会提前说"没有更多"）。 */
    let hasMore = false;
    if (full) {
      const probe = listVisible(principal, { limit: 1, cursor: cursor, ownerRoleId: owner, __probe: true });
      hasMore = !!(probe && probe.ok && probe.moments && probe.moments.length);
    }
    return {
      ok: true,
      moments: picked,
      count: picked.length,
      hasMore: hasMore,
      cursor: full ? cursor : null,
      scanned: scanned,
      pages: pages,
      reachedScanLimit: pages >= MAX_SCAN_PAGES && !full,
      revision: getRevision()
    };
  }

  function listVisibleByOwner(roleId, principalArg, options) {
    const owner = strOf(roleId, OWNER_MAX);
    /* 作者本人视角：principal 缺省 = 该角色本人（作者恒可读自己的全部内容）。 */
    const principal = principalOf(principalArg) || { kind: 'role', id: owner };
    return listVisible(principal, Object.assign({}, options || {}, { ownerRoleId: owner }));
  }

  /* ── 增量投递读口（changesAfter）────────────────────────────────────
     这是 change_log 的**唯一**读口，也是"事件"这个词在本域的全部含义。

     ⚠ 它投递的**不是事件载荷**，而是"脏标记"：每条日志行只带
     `revision / kind / record_id`，行内容在读出时**重新取当前状态**。
     因此：
       · 一次重放不会投递过期内容，只会投递"该记录现在是什么"；
       · 记录已被软删除时，那条 upsert 日志会被**如实降级成 delete**
         （`getRecord` 对墓碑返回 null）；
       · 于是"按 id put / 按 id delete"这条应用语义天然幂等，
         重复投递不需要去重表。

     P11-3G 在此收紧两件事（都不改 schema、不新建协议）：

     ① **行集与游标出自同一个读事务**。原先"先 SELECT 日志行、再逐条
        `getRecord`"是一串独立读：中间落进一次写入时，同一页可能出现
        "日志行说 revision=5、内容却已经是 revision=9"的混合快照。
        它不会丢数据（重放会收敛），但会让"这一页对应哪一版"无法审计。
     ② 增加 `retainedFrom` —— 日志里**仍然存在的最小 revision**。
        因为 revision 在日志里是**稠密**的（每次 allocateRevision 都在
        同一个事务里恰好写一行日志），且回收只删前缀，所以消费者可以据此
        判定"我未确认的那一段有没有被回收掉"：
             retainedFrom > cursor + 1  → 有事件已被回收 → 必须回退到快照重建
        （P11-3F 的 hydrate 就是那个恢复权威，这里不新造恢复机制。） */
  function changesAfter(cursor, options) {
    options = options || {};
    if (!isOpen()) return { ok: false, error: 'store-closed' };
    const from = intOf(cursor);
    if (from < 0) return { ok: false, error: 'bad-cursor' };
    const limit = Math.max(1, Math.min(1000, intOf(options.limit) || 500));
    let payload = null;
    withTransaction(() => {
      const rows = sqliteAll(SQL.selectChanges, [from, limit + 1]);
      const hasMore = rows.length > limit;
      const use = hasMore ? rows.slice(0, limit) : rows;
      const upserts = [], deletes = [];
      let next = from;
      for (const row of use) {
        next = Math.max(next, Number(row.revision) || 0);
        if (row.kind === 'delete') { deletes.push({ id: row.record_id, revision: Number(row.revision) || 0 }); continue; }
        const moment = getRecord(row.record_id);
        if (moment) upserts.push(moment);
        else deletes.push({ id: row.record_id, revision: Number(row.revision) || 0 });
      }
      payload = {
        ok: true, cursor: next, serverTime: clock(), revision: getRevision(),
        upserts: upserts, deletes: deletes, hasMore: hasMore,
        retainedFrom: minChangeRevision()
      };
    }, 'read');
    return payload;
  }

  /* ── P11-3G · 投递水位（delivery watermark）───────────────────────────
     一次 ACK 证明的是**一件事**，而且是这一件：

         "consumer 对 revision ≤ W 的每一个 event 都已经得出**持久结论**"

     它**不**证明：HTTP 200、事件被读过、事件被尝试过。
     因此 `record` 侧只需要 W 一个数 —— 每个 event 的 PENDING / APPLIED /
     RETRYABLE / TERMINAL 是**消费者自己**的状态，服务端不需要知道，
     也刻意不去猜。服务端要 W 只有一个用途：**决定哪些日志行可以被回收**。

     W 的性质：
       · 单调 —— 永远取 max(已存, 本次)，任何一次失败处理都不可能让它倒退；
       · 有界 —— 夹在 [0, getRevision()]；消费者声称的未来版本一律夹回当前版本
         （否则一次客户端 bug 就能让回收吃掉还没投递的事件）；
       · 单一消费者时代的一条诚实约定 —— 回收用**全体已注册水位的 min**，
         因此多一个消费者只会让回收变保守，不会让谁丢数据；
         从未 ACK 过的消费者在契约里的含义是"它必须从快照开始"，不是"它会收到日志"。 */
  function deliveryKeyOf(consumer) {
    const id = strOf(consumer, DELIVERY_CONSUMER_MAX);
    /* 键名规则收窄到安全字符集：consumer id 会变成 meta 键，
       不允许它携带 `%`、空白或路径样式的内容去影响别的键。 */
    if (!/^[A-Za-z0-9._:-]+$/.test(id)) return '';
    return DELIVERY_KEY_PREFIX + id;
  }
  function listDelivery() {
    const rows = sqliteAll(SQL.selectDeliveryKeys, [DELIVERY_KEY_PREFIX + '%']) || [];
    const out = [];
    for (const row of rows) {
      out.push({
        consumer: String(row.key).slice(DELIVERY_KEY_PREFIX.length),
        watermark: intOf(row.value)
      });
    }
    return out;
  }
  function noteDelivery(consumer, watermark) {
    if (!isOpen()) return { ok: false, error: 'store-closed' };
    const key = deliveryKeyOf(consumer);
    if (!key) return { ok: false, error: 'invalid-consumer' };
    const raw = Number(watermark);
    if (!isFinite(raw)) return { ok: false, error: 'invalid-watermark' };
    const revision = getRevision();
    const claimed = Math.max(0, Math.trunc(raw));
    const clamped = Math.min(claimed, revision);
    let out = null;
    try {
      out = withTransaction(() => {
        const previous = intOf(readMeta(key));
        const next = Math.max(previous, clamped);
        writeMeta(key, String(next));
        return { previous: previous, watermark: next };
      });
    } catch (error) {
      return { ok: false, error: String((error && error.message) || error) };
    }
    /* 回收只在**水位真的前进**时尝试 —— 重复 ACK 不做任何工作。 */
    const retention = out.watermark > out.previous ? maybePrune() : { ok: true, pruned: 0, reason: 'watermark-unchanged' };
    return {
      ok: true, consumer: strOf(consumer, DELIVERY_CONSUMER_MAX),
      watermark: out.watermark, previous: out.previous,
      claimed: claimed, clamped: claimed !== clamped, revision: revision,
      retention: retention
    };
  }
  function getDeliveryState(consumer) {
    if (!isOpen()) return { ok: false, error: 'store-closed' };
    const all = listDelivery();
    let mine = null;
    const key = consumer == null ? '' : deliveryKeyOf(consumer);
    if (key) {
      for (const row of all) if (DELIVERY_KEY_PREFIX + row.consumer === key) mine = row;
    }
    return {
      ok: true, consumers: all, watermark: mine ? mine.watermark : null,
      minWatermark: all.length ? Math.min.apply(null, all.map(r => r.watermark)) : null,
      log: changeLogStats(), revision: getRevision()
    };
  }
  function minChangeRevision() {
    const row = sqliteGet(SQL.changeLogRange);
    return row && row.lo != null ? Number(row.lo) : null;
  }
  function changeLogStats() {
    const row = sqliteGet(SQL.changeLogRange) || {};
    const count = sqliteGet(SQL.countChangeLog) || {};
    return {
      rows: Number(count.c) || 0,
      min: row.lo == null ? null : Number(row.lo),
      max: row.hi == null ? null : Number(row.hi)
    };
  }
  /* ── 回收（retention）────────────────────────────────────────────────
     一个 change event 什么时候可以被安全删除？只有一个判据：

         它的 revision ≤ **全体已注册消费者的最小投递水位**

     不是 age > N days，也不是 revision < currentRevision —— 两者都会删掉
     "消费者还没得出持久结论"的事件，而那样的删除在客户端表现为
     **镜像永久少一条且所有标志都是绿的**。

     没有消费者 ACK 过 → **一行都不删**（fail-safe）。日志因此可以增长，
     这是诚实的代价：在不知道消费者走到哪里之前，删任何一行都是猜测。
     触发点刻意挂在 ACK 上而不是写入上：新容量**只可能**由消费者前进带来。 */
  function pruneChangeLog(options) {
    options = options || {};
    if (!isOpen()) return { ok: false, error: 'store-closed' };
    const consumers = listDelivery();
    if (!consumers.length) return { ok: true, pruned: 0, reason: 'no-consumer-watermark', upTo: null };
    const safe = Math.min.apply(null, consumers.map(r => r.watermark));
    if (!(safe > 0)) return { ok: true, pruned: 0, reason: 'watermark-zero', upTo: safe };
    const batch = Math.max(1, Math.min(changeLogPruneBatch, intOf(options.batch) || changeLogPruneBatch));
    let pruned = 0;
    try {
      pruned = withTransaction(() => {
        const res = sqliteExec(SQL.deleteChangesUpTo, [safe, batch]);
        return Number(res && res.changes) || 0;
      });
    } catch (error) {
      return { ok: false, error: String((error && error.message) || error), pruned: 0, upTo: safe };
    }
    if (pruned > 0) logger('moments-change-log-pruned', { pruned: pruned, upTo: safe, consumers: consumers.length });
    return { ok: true, pruned: pruned, upTo: safe, reason: pruned ? 'pruned' : 'nothing-to-prune', log: changeLogStats() };
  }
  /* 回收的**触发判据**必须便宜：用 MAX-MIN 跨度（两个 O(1) 的索引查找），
     而不是每次写入都 COUNT(*) 扫一遍日志。 */
  function maybePrune() {
    const stats = changeLogStats();
    if (stats.min == null) return { ok: true, pruned: 0, reason: 'log-empty' };
    const span = stats.max - stats.min + 1;
    if (span <= changeLogMax) return { ok: true, pruned: 0, reason: 'below-threshold', span: span };
    return pruneChangeLog({});
  }

  /* ── 迁移水位（幂等 / 可续跑）────────────────────────────────────── */
  function migrationKey(source) { return 'migration:moments:' + String(source || 'default'); }
  function getMigrationState(source) {
    if (!isOpen()) return { ok: false, error: 'store-closed', state: null };
    const raw = readMeta(migrationKey(source));
    if (!raw) return { ok: true, state: null, source: String(source || 'default') };
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch (_) { parsed = null; }
    return { ok: true, state: parsed, source: String(source || 'default') };
  }
  function setMigrationState(source, patch) {
    if (!isOpen()) return { ok: false, error: 'store-closed' };
    const current = getMigrationState(source).state || {};
    const next = Object.assign({}, current, patch || {}, { updatedAt: clock() });
    writeMeta(migrationKey(source), JSON.stringify(next));
    return { ok: true, source: String(source || 'default'), state: next };
  }

  function countLive() { return sqliteGet(SQL.countLive).c; }
  function countAllRecords() { return sqliteGet(SQL.countAll).c; }
  function countOwners() { return sqliteGet(SQL.countOwners).c; }
  function countByVisibility() {
    const rows = sqliteAll(SQL.countByVisibility) || [];
    const out = {};
    for (const row of rows) out[String(row.visibility)] = Number(row.c) || 0;
    return out;
  }

  return {
    open: open,
    attachReadOnlyConnection: attachReadOnlyConnection,
    close: close,
    isOpen: isOpen,
    file: dbFile,
    schemaVersion: MOMENTS_SCHEMA_VERSION,

    put: put,
    writeMigrated: writeMigrated,
    remove: remove,
    getRecord: getRecord,
    getRecordAny: getRecordAny,

    candidatePage: candidatePage,
    listRecords: listRecords,
    listVisible: listVisible,
    listVisibleByOwner: listVisibleByOwner,
    changesAfter: changesAfter,

    /* P11-3G · 投递与回收 */
    noteDelivery: noteDelivery,
    getDeliveryState: getDeliveryState,
    pruneChangeLog: pruneChangeLog,
    changeLogStats: changeLogStats,

    getRevision: getRevision,
    revisionIsolation: revisionIsolation,

    getMigrationState: getMigrationState,
    setMigrationState: setMigrationState,

    countLive: countLive,
    countAllRecords: countAllRecords,
    countOwners: countOwners,
    countByVisibility: countByVisibility,

    readMeta: readMeta,
    writeMeta: writeMeta,
    core: core
  };
}

module.exports = createMomentsStore;
module.exports.MOMENTS_SCHEMA_VERSION = MOMENTS_SCHEMA_VERSION;
module.exports.RECORDS_TABLE = RECORDS_TABLE;
module.exports.CHANGE_LOG_TABLE = CHANGE_LOG_TABLE;
module.exports.CHANGE_LOG_MAX = CHANGE_LOG_MAX;
module.exports.CHANGE_LOG_PRUNE_BATCH = CHANGE_LOG_PRUNE_BATCH;
module.exports.DELIVERY_KEY_PREFIX = DELIVERY_KEY_PREFIX;
