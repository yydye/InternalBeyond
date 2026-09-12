/* ====================================================================
   IB Home Node · Canonical Memory Store（M1-C.2d Wave 2）
   --------------------------------------------------------------------
   目的：让 Home Node 成为 `memories` 的 canonical authority —— 与
   chat-store.js 对 chatMessages 所做的事**同构**，因此权威/镜像/回退
   三态语义完全一致，只是换了一个 store。

   与 chat-store.js 的关系（刻意复用，不发明第二套架构）：
     · 同一个 SQLite 文件、同一套 PRAGMA、同一个 `meta` 表；
     · 同样的 deps 工厂 / `const SQL = {}` / withTransaction / intOf 归一 /
       requestId 幂等表 / 迁移水位标记 / online backup + 损坏隔离；
     · **但 revision 与 change_log 是独立的**：
         meta['memory_revision'] + memory_change_log
       理由与 device-registry.js:7-8 的既有决定相同：一个权威域一个版本键。
       若共用 chat 的 change_log，一次记忆写入会让**聊天**镜像游标失效，
       手机端会为了记忆改动去重同步聊天历史。

   本文件是**领域层**：不管 HTTP、不做鉴权、不认识 provider。

   设计约束（逐条对应 chat-store.js 的六条，语义相同）：
     1. memory id 保持浏览器 canonical id（mem_… / 测试 id），绝不重新编号。
     2. query-critical 字段独立成列（owner_id / class / visibility /
        visible_to / exclude_from / importance / pinned）；其余全部留
        payload_json，读回时原样还原 —— 未知字段必须能往返。
     3. 每次 **内容** mutation → revision++（单调、不复用、不压缩空洞）。
     4. 写入幂等：同一 id 的**内容相同**（忽略激活遥测）= 无操作，revision 不动。
     5. 未知字段能往返（读的是存下来的 payload，不是重新投影）。
     6. schema 版本化（meta['memory_schema']），比本 build 新则拒绝打开。

   ── 激活强化为什么单独一条路径（§7.6b）──────────────────────────────
   activationCount / lastActivated 每一轮对话都可能变。它们必须：
     · 能更新（否则排名提示丢失）；
     · **不**动 revision、**不**写 change_log、**不**改 updated_at。
   因此 recordActivation() 走一条极窄的 UPDATE，只碰两个提升列，
   连 payload_json 都不重写。把它和 putRecord 分开是**结构性**的保证：
   调用 recordActivation 在任何情况下都不可能推进 revision。
   ==================================================================== */
'use strict';

const path = require('path');
const fs = require('fs');

const MEMORY_CONTRACT = require('../../assets/js/memory-contract.js');

const MEMORY_SCHEMA_VERSION = 1;
const RECORDS_TABLE = 'memory_records';
const CHANGE_LOG_TABLE = 'memory_change_log';
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
const IDEMPOTENCY_MAX = 1000;
const DEFAULT_DB_FILENAME = 'home-node.db';

/* node:sqlite 是 Node 22.5+ 的内置模块（shipped runtime 已确认可用）。
   缺失时明确报错，绝不静默退化成另一套存储语义 —— 与 chat-store.js:43-50 同款：
   调用方据此把记忆权威判为 degraded，并让浏览器 fail closed。 */
function loadSqlite() {
  try { return require('node:sqlite'); }
  catch (error) {
    const err = new Error('node:sqlite is unavailable in this runtime: ' + (error && error.message || error));
    err.code = 'SQLITE_UNAVAILABLE';
    throw err;
  }
}

function createMemoryStore(deps) {
  deps = deps || {};
  const dataDir = deps.dataDir || process.cwd();
  const dbFile = deps.dbFile || path.join(dataDir, DEFAULT_DB_FILENAME);
  const clock = deps.clock || (() => Date.now());
  const logger = deps.logger || (() => {});
  const sqlite = deps.sqlite || loadSqlite();

  let db = null;
  let opened = false;
  let lastOpenedAt = 0;

  const SQL = {
    createRecords:
      'CREATE TABLE IF NOT EXISTS ' + RECORDS_TABLE + ' (' +
      ' record_id TEXT PRIMARY KEY,' +
      ' owner_id TEXT NOT NULL,' +
      ' class TEXT NOT NULL,' +
      ' visibility TEXT NOT NULL DEFAULT "",' +
      ' visible_to TEXT NOT NULL DEFAULT "[]",' +
      ' exclude_from TEXT NOT NULL DEFAULT "[]",' +
      ' importance INTEGER,' +
      ' pinned INTEGER NOT NULL DEFAULT 0,' +
      ' activation_count INTEGER NOT NULL DEFAULT 0,' +
      ' last_activated_at INTEGER,' +
      ' created_at INTEGER NOT NULL,' +
      ' updated_at INTEGER NOT NULL,' +
      ' revision INTEGER NOT NULL,' +
      ' created_rev INTEGER NOT NULL,' +
      ' deleted_at INTEGER,' +
      ' deleted_rev INTEGER,' +
      ' payload_json TEXT NOT NULL' +
      ')',
    createByOwner: 'CREATE INDEX IF NOT EXISTS idx_memory_owner ON ' + RECORDS_TABLE + ' (owner_id, class, created_at)',
    createByRevision: 'CREATE INDEX IF NOT EXISTS idx_memory_rev ON ' + RECORDS_TABLE + ' (revision)',
    createChangeLog:
      'CREATE TABLE IF NOT EXISTS ' + CHANGE_LOG_TABLE + ' (' +
      ' revision INTEGER PRIMARY KEY,' +
      ' kind TEXT NOT NULL,' +
      ' record_id TEXT NOT NULL,' +
      ' owner_id TEXT NOT NULL DEFAULT "",' +
      ' at INTEGER NOT NULL' +
      ')',
    createMeta: 'CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
    /* 幂等表与 chat store **共用**同一张表（同一个库、同一个语义），但必须由本模块
       也声明一次：CREATE TABLE IF NOT EXISTS 是幂等的，而"谁先打开"并不确定。
       这与 meta 表的既有做法逐字同款（chat-store.js:142 与 device-registry.js:170
       都各自声明它，理由就是"任一模块都可能先开库"）。
       如果只依赖 chat-store 先建表，那么单独打开 memory store 的调用方
       （测试、未来的独立迁移工具）会在第一次带 requestId 的写入时
       拿到 "no such table: idempotency" —— 实测踩到过。 */
    createIdempotency:
      'CREATE TABLE IF NOT EXISTS idempotency (' +
      ' key TEXT PRIMARY KEY,' +
      ' kind TEXT NOT NULL,' +
      ' message_id TEXT NOT NULL,' +
      ' at INTEGER NOT NULL' +
      ')',
    insertRecord:
      'INSERT INTO ' + RECORDS_TABLE + ' ' +
      '(record_id, owner_id, class, visibility, visible_to, exclude_from, importance, pinned, activation_count, last_activated_at, ' +
      'created_at, updated_at, revision, created_rev, deleted_at, deleted_rev, payload_json) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)',
    updateRecord:
      'UPDATE ' + RECORDS_TABLE + ' SET owner_id=?, class=?, visibility=?, visible_to=?, exclude_from=?, importance=?, pinned=?, ' +
      'created_at=?, updated_at=?, revision=?, deleted_at=NULL, deleted_rev=NULL, payload_json=? WHERE record_id=?',
    /* 激活：只碰两个提升列。刻意**不含** revision / updated_at / payload_json ——
       这是"强化不推动结构版本"这条契约的实现处。 */
    updateActivation:
      'UPDATE ' + RECORDS_TABLE + ' SET activation_count=?, last_activated_at=? WHERE record_id=? AND deleted_at IS NULL',
    selectActivation: 'SELECT activation_count FROM ' + RECORDS_TABLE + ' WHERE record_id=?',
    softDelete: 'UPDATE ' + RECORDS_TABLE + ' SET deleted_at=?, deleted_rev=?, revision=? WHERE record_id=? AND deleted_at IS NULL',
    selectRecord: 'SELECT * FROM ' + RECORDS_TABLE + ' WHERE record_id=?',
    selectLive: 'SELECT * FROM ' + RECORDS_TABLE + ' WHERE deleted_at IS NULL ORDER BY created_at ASC, record_id ASC LIMIT ?',
    selectLiveByOwner: 'SELECT * FROM ' + RECORDS_TABLE + ' WHERE deleted_at IS NULL AND owner_id=? ORDER BY created_at ASC, record_id ASC LIMIT ?',
    insertChange: 'INSERT INTO ' + CHANGE_LOG_TABLE + ' (revision, kind, record_id, owner_id, at) VALUES (?, ?, ?, ?, ?)',
    selectChanges: 'SELECT revision, kind, record_id, owner_id, at FROM ' + CHANGE_LOG_TABLE + ' WHERE revision > ? ORDER BY revision ASC LIMIT ?',
    maxChangeRevision: 'SELECT MAX(revision) AS m FROM ' + CHANGE_LOG_TABLE,
    countLive: 'SELECT COUNT(*) AS c FROM ' + RECORDS_TABLE + ' WHERE deleted_at IS NULL',
    countAll: 'SELECT COUNT(*) AS c FROM ' + RECORDS_TABLE,
    countOwners: 'SELECT COUNT(DISTINCT owner_id) AS c FROM ' + RECORDS_TABLE + ' WHERE deleted_at IS NULL',
    selectMeta: 'SELECT value FROM meta WHERE key=?',
    upsertMeta: 'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
    pruneIdempotency: 'DELETE FROM idempotency WHERE at < ?',
    countIdempotency: 'SELECT COUNT(*) AS c FROM idempotency',
    oldestIdempotency: 'SELECT key FROM idempotency ORDER BY at ASC LIMIT ?',
    deleteIdempotency: 'DELETE FROM idempotency WHERE key=?',
    selectIdempotency: 'SELECT kind, message_id FROM idempotency WHERE key=?',
    insertIdempotency: 'INSERT INTO idempotency (key, kind, message_id, at) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET kind=excluded.kind, message_id=excluded.message_id, at=excluded.at'
  };

  function open() {
    if (opened) return { ok: true, alreadyOpen: true, file: dbFile, schemaVersion: MEMORY_SCHEMA_VERSION };
    try { fs.mkdirSync(dataDir, { recursive: true }); } catch (_) { /* 目录已存在 */ }
    /* 数据库文件由 chat-store 负责损坏隔离（同一个文件、同一个 open 顺序）。
       本模块只做"schema 太新就拒绝打开"，绝不重复 quarantine 逻辑 ——
       两个模块各自 rename 同一个坏文件会互相踩。 */
    db = new sqlite.DatabaseSync(dbFile);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = FULL');
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('PRAGMA foreign_keys = ON');
    db.exec(SQL.createRecords);
    db.exec(SQL.createByOwner);
    db.exec(SQL.createByRevision);
    db.exec(SQL.createChangeLog);
    db.exec(SQL.createMeta);
    db.exec(SQL.createIdempotency);
    const stored = readMeta('memory_schema');
    if (stored == null) writeMeta('memory_schema', String(MEMORY_SCHEMA_VERSION));
    else if (Number(stored) > MEMORY_SCHEMA_VERSION) {
      const err = new Error('memory store schema is newer than this build (' + stored + ' > ' + MEMORY_SCHEMA_VERSION + ')');
      err.code = 'SCHEMA_TOO_NEW';
      try { db.close(); } catch (_) { /* 已关闭 */ }
      db = null;
      throw err;
    }
    opened = true;
    lastOpenedAt = clock();
    /* 观测：只报条数与版本，绝不打印任何记忆正文。 */
    logger('memory-opened', {
      file: dbFile,
      schemaVersion: MEMORY_SCHEMA_VERSION,
      records: countRecords(),
      allRecords: countAllRecords(),
      owners: countOwners()
    });
    return { ok: true, alreadyOpen: false, file: dbFile, schemaVersion: MEMORY_SCHEMA_VERSION };
  }

  function close() {
    if (!db) return { ok: true, alreadyClosed: true };
    try { db.close(); } catch (_) { /* 已关闭 */ }
    db = null;
    opened = false;
    return { ok: true };
  }
  function isOpen() { return opened && !!db; }
  function requireOpen() {
    if (!isOpen()) {
      const err = new Error('memory store is not open');
      err.code = 'STORE_CLOSED';
      throw err;
    }
  }

  /* ── 内部小工具 ──────────────────────────────────────────────────── */
  function readMeta(key) {
    const row = db.prepare(SQL.selectMeta).get(key);
    return row ? row.value : null;
  }
  function writeMeta(key, value) { db.prepare(SQL.upsertMeta).run(key, String(value)); }
  function withTransaction(fn) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      db.exec('COMMIT');
      return out;
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch (_) { /* 保留原始错误 */ }
      throw error;
    }
  }
  function getRevision() {
    const stored = Number(readMeta('memory_revision') || 0);
    const inLog = db.prepare(SQL.maxChangeRevision).get();
    const logged = (inLog && inLog.m) || 0;
    /* 双保险：meta 与 change_log 取大值，任何一侧被外部工具改写都不会让版本回退。 */
    return Math.max(stored, logged);
  }
  function allocateRevision() {
    const next = getRevision() + 1;
    writeMeta('memory_revision', String(next));
    return next;
  }

  /* ── 行 ↔ 记录 ─────────────────────────────────────────────────────
     payload_json 是**权威内容**：读回的就是当初存下去的那份对象，
     包括所有提升列（未知字段必须能往返，约束 5）。
     激活遥测从**提升列**回填 —— 因为 recordActivation 有意不重写 payload，
     若只读 payload，激活计数会看起来永远停在写入那一刻。 */
  function rowToRecord(row) {
    let parsed = null;
    try { parsed = JSON.parse(row.payload_json); }
    catch (error) {
      logger('memory-payload-parse-failed', { id: row.record_id, kind: 'malformed-payload' });
      parsed = { id: row.record_id, title: '', content: '', __malformedPayload: true };
    }
    if (!parsed || typeof parsed !== 'object') {
      parsed = { id: row.record_id, title: '', content: '', __malformedPayload: true };
    }
    if (parsed.id == null) parsed.id = row.record_id;
    parsed.activationCount = Number(row.activation_count || 0);
    if (row.last_activated_at == null) delete parsed.lastActivated;
    else parsed.lastActivated = Number(row.last_activated_at);
    return parsed;
  }
  function classOf(record) {
    /* class 是**语义类别**判别列（episodic / semantic / …），沿用既有 kind 字段。
       缺失时归 'episodic' —— 与 memory.js:898 的既有缺省一致。 */
    const kind = record && record.kind;
    const s = (kind == null ? '' : String(kind)).trim();
    return s || 'episodic';
  }
  function arrayJsonOf(value) {
    /* 提升列的 JSON 串**只用于诊断与索引**，读回一律以 payload 为准。
       非法/缺失一律落 '[]'，绝不因此拒绝写入（可见性语义由 payload + C1 决定）。 */
    try { return JSON.stringify(Array.isArray(value) ? value.map(String) : []); }
    catch (_) { return '[]'; }
  }
  function pinnedOf(record) { return record && record.pinned ? 1 : 0; }
  function importanceOf(record) {
    if (!record || record.importance == null) return null;
    const n = Number(record.importance);
    return isFinite(n) ? Math.trunc(n) : null;
  }

  /* ── 幂等表：与 chat-store 共用同一张表，但键前缀不同 ────────────────
     前缀 'mem:' 是必须的：requestId 命名空间若与聊天共用，一次记忆迁移
     的 requestId 可能撞上一条消息的 requestId，从而返回错误的记录 id。 */
  function rememberRequest(key, kind, value) {
    if (!key) return;
    const at = MEMORY_CONTRACT.intOf(clock());
    db.prepare(SQL.insertIdempotency).run(String(key), String(kind), String(value), at);
    db.prepare(SQL.pruneIdempotency).run(at - IDEMPOTENCY_TTL_MS);
    const count = db.prepare(SQL.countIdempotency).get().c;
    if (count > IDEMPOTENCY_MAX) {
      const excess = MEMORY_CONTRACT.intOf(count - IDEMPOTENCY_MAX);
      const victims = db.prepare(SQL.oldestIdempotency).all(excess);
      for (const victim of victims) db.prepare(SQL.deleteIdempotency).run(victim.key);
    }
  }
  function lookupRequest(key) {
    if (!key) return null;
    const row = db.prepare(SQL.selectIdempotency).get(String(key));
    if (!row) return null;
    return { key: String(key), kind: row.kind, value: row.message_id };
  }
  function requestKey(raw) { return raw ? 'mem:' + String(raw) : ''; }

  /* ── 写：三种结果（词表固定，供调用方与测试断言）─────────────────────
       created  新记录，revision 前进
       updated  同一 id **内容**变化，revision 前进
       skipped  同一 id 内容完全相同（或 skip 策略下已存在）—— revision 不动
     内容等价**忽略激活遥测**（memory-contract.contentIdentical）。 */
  function evaluateWrite(record) {
    const check = MEMORY_CONTRACT.validateRecord(record);
    if (!check.ok) return { ok: false, error: 'invalid-record', errors: check.errors };
    const id = String(record.id);
    const payloadJson = JSON.stringify(record);
    const fingerprint = MEMORY_CONTRACT.contentFingerprint(record);
    const existing = db.prepare(SQL.selectRecord).get(id);
    let existingFingerprint = null;
    if (existing) {
      try { existingFingerprint = MEMORY_CONTRACT.contentFingerprint(JSON.parse(existing.payload_json)); }
      catch (_) { existingFingerprint = null; }
    }
    return {
      ok: true,
      id: id,
      payloadJson: payloadJson,
      fingerprint: fingerprint,
      record: record,
      existing: existing || null,
      /* 内容等价必须两条都成立：payload 解析成功 **且** 指纹相同。
         payload 损坏时指纹为 null → 判定为"不同" → 走 updated 修复它。 */
      identical: !!(existing && existing.deleted_at == null && existingFingerprint != null && existingFingerprint === fingerprint),
      resurrect: !!(existing && existing.deleted_at != null)
    };
  }

  function writeOne(plan, options) {
    options = options || {};
    const record = plan.record;
    if (plan.identical) {
      return { ok: true, outcome: 'skipped', id: plan.id, revision: plan.existing.revision, reason: 'identical' };
    }
    if (plan.existing && options.existingPolicy === 'skip') {
      return { ok: true, outcome: 'skipped', id: plan.id, revision: plan.existing.revision, reason: 'exists-on-node' };
    }
    const revision = MEMORY_CONTRACT.intOf(allocateRevision());
    const at = MEMORY_CONTRACT.intOf(clock());
    const createdAt = MEMORY_CONTRACT.createdAtOf(record);
    const lastActivatedAt = MEMORY_CONTRACT.lastActivatedAtOf(record);
    /* 激活计数：内容写入时带上；重复写入（内容变化）时保留 Node 侧已有的更高计数
       —— 计数是 Node 自己的排名遥测，不该被一次内容编辑回退成旧快照值。 */
    const previousCount = plan.existing ? Number(plan.existing.activation_count || 0) : 0;
    const incomingCount = Math.max(0, MEMORY_CONTRACT.intOf(record.activationCount || 0));
    const activationCount = plan.existing ? Math.max(previousCount, incomingCount) : incomingCount;
    const ownerId = MEMORY_CONTRACT.ownerIdOf(record);
    const klass = classOf(record);
    const visibility = record.visibility == null ? '' : String(record.visibility);
    const visibleTo = arrayJsonOf(record.visibleTo);
    const excludeFrom = arrayJsonOf(record.excludeFrom);
    const importance = importanceOf(record);
    const pinned = pinnedOf(record);
    if (plan.existing) {
      /* 更新：**刻意不改** activation_count / last_activated_at —— 它们是 Node 自己的
         排名遥测（可能已经比 payload 里的快照新），一次内容编辑不该把它回退。
         时间戳也用 Node 已存的 created_at（`created` 是记录身份的一部分，编辑不改它）。 */
      db.prepare(SQL.updateRecord).run(
        ownerId, klass, visibility, visibleTo, excludeFrom, importance, pinned,
        MEMORY_CONTRACT.intOf(plan.existing.created_at), at, revision, plan.payloadJson, plan.id
      );
    } else {
      db.prepare(SQL.insertRecord).run(
        plan.id, ownerId, klass, visibility, visibleTo, excludeFrom, importance, pinned,
        activationCount, lastActivatedAt, createdAt, at, revision, revision, plan.payloadJson
      );
    }
    db.prepare(SQL.insertChange).run(revision, 'upsert', plan.id, ownerId, at);
    return {
      ok: true,
      outcome: plan.existing ? 'updated' : 'created',
      id: plan.id,
      revision: revision,
      ownerId: ownerId,
      resurrected: plan.resurrect,
      activationCount: activationCount
    };
  }

  function putRecord(record, options) {
    options = options || {};
    if (!isOpen()) return { ok: false, error: 'store-closed' };
    const requestId = requestKey(options.requestId);
    if (requestId && options.idempotent !== false) {
      const seen = lookupRequest(requestId);
      if (seen) {
        const stored = db.prepare(SQL.selectRecord).get(seen.value);
        return {
          ok: true,
          outcome: 'duplicate-request',
          id: seen.value,
          revision: getRevision(),
          record: stored ? rowToRecord(stored) : null
        };
      }
    }
    return withTransaction(() => {
      const plan = evaluateWrite(record);
      if (!plan.ok) return plan;
      const result = writeOne(plan, { existingPolicy: options.existingPolicy });
      if (requestId && options.idempotent !== false) rememberRequest(requestId, 'record', result.id);
      return result;
    });
  }

  /* 批量写（迁移专用）：一个事务内完成一批，任一记录非法 → 整批拒绝、零写入。 */
  function putRecords(records, options) {
    options = options || {};
    if (!isOpen()) return { ok: false, error: 'store-closed' };
    if (!Array.isArray(records)) return { ok: false, error: 'invalid-batch' };
    const requestId = requestKey(options.requestId);
    if (requestId && options.idempotent !== false) {
      const seen = lookupRequest(requestId);
      if (seen) {
        let parsed = null;
        try { parsed = JSON.parse(seen.value); } catch (_) { parsed = null; }
        return { ok: true, outcome: 'duplicate-request', results: parsed || [], revision: getRevision() };
      }
    }
    return withTransaction(() => {
      const plans = [];
      for (let i = 0; i < records.length; i++) {
        const plan = evaluateWrite(records[i]);
        if (!plan.ok) {
          return { ok: false, error: 'invalid-record', index: i, errors: plan.errors, id: (records[i] && records[i].id) || null };
        }
        plans.push(plan);
      }
      const results = plans.map(plan => writeOne(plan, { existingPolicy: options.existingPolicy }));
      if (requestId && options.idempotent !== false) rememberRequest(requestId, 'batch', JSON.stringify(results));
      const summary = { created: 0, updated: 0, skipped: 0 };
      for (const r of results) summary[r.outcome] = (summary[r.outcome] || 0) + 1;
      return { ok: true, outcome: 'batch', results: results, summary: summary, revision: getRevision(), count: results.length };
    });
  }

  /* ── 删除：soft delete（tombstone）────────────────────────────────
     与 chat-store 同款：变更日志需要能表达"这条 id 已不存在"给镜像，
     硬删除会让"删除"与"从未存在"无法区分。 */
  function deleteRecord(id, options) {
    options = options || {};
    if (!isOpen()) return { ok: false, error: 'store-closed' };
    const target = String(id == null ? '' : id);
    if (!target) return { ok: false, error: 'invalid-id' };
    const requestId = requestKey(options.requestId);
    return withTransaction(() => {
      const row = db.prepare(SQL.selectRecord).get(target);
      if (!row || row.deleted_at != null) {
        return { ok: true, outcome: 'not-present', id: target, revision: getRevision(), deleted: false };
      }
      const revision = MEMORY_CONTRACT.intOf(allocateRevision());
      const at = MEMORY_CONTRACT.intOf(clock());
      db.prepare(SQL.softDelete).run(at, revision, revision, target);
      db.prepare(SQL.insertChange).run(revision, 'delete', target, row.owner_id, at);
      if (requestId) rememberRequest(requestId, 'delete', target);
      return { ok: true, outcome: 'deleted', id: target, revision: revision, deleted: true, ownerId: row.owner_id };
    });
  }

  /* ── 激活强化：**唯一**允许在没有 revision 前进的情况下写入的方法 ────
     契约（§7.6b / §9）：
       · 不推进 revision；
       · 不写 change_log；
       · 不改 updated_at；
       · 不重写 payload_json。
     因此"每轮对话一次强化"不可能让任何镜像游标失效 —— 排名提示不产生
     同步流量。返回值里的 revisionTouched 永远是 false，供测试直接断言。

     幂等性按 (id, 已存计数) 处理：这里做的是 **累加**（activationCount+delta），
     而不是"设为某个绝对值"，因为强化语义本来就是"被用了一次"。
     调用方每轮只提交一次选中集合，因此不会重复累加。 */
  function recordActivation(ids, options) {
    options = options || {};
    if (!isOpen()) return { ok: false, error: 'store-closed' };
    const list = Array.isArray(ids) ? ids.map(String).filter(Boolean) : [];
    if (!list.length) return { ok: true, updated: 0, ids: [], at: null, revisionTouched: false };
    const deltaRaw = options.delta == null ? 1 : Number(options.delta);
    const delta = isFinite(deltaRaw) && deltaRaw > 0 ? Math.trunc(deltaRaw) : 1;
    let at = Number(options.at);
    if (!isFinite(at)) at = MEMORY_CONTRACT.intOf(clock());
    else at = Math.trunc(at);
    const revisionBefore = getRevision();
    const updated = withTransaction(() => {
      let n = 0;
      for (const id of list) {
        const row = db.prepare(SQL.selectActivation).get(id);
        if (!row) continue;
        const next = Number(row.activation_count || 0) + delta;
        const res = db.prepare(SQL.updateActivation).run(next, at, id);
        if (res && res.changes) n++;
      }
      return n;
    });
    return { ok: true, updated: updated, ids: list, at: at, revisionTouched: getRevision() !== revisionBefore, revision: getRevision() };
  }

  /* ── 读 ──────────────────────────────────────────────────────────── */
  function getRecord(id, options) {
    options = options || {};
    if (!isOpen()) return null;
    const row = db.prepare(SQL.selectRecord).get(String(id));
    if (!row) return null;
    if (row.deleted_at != null && !options.includeDeleted) return null;
    return rowToRecord(row);
  }

  /* listRecords({ownerId, limit})
     返回**全部存活记录**（默认上限很大）：召回需要完整候选集，
     截断候选集会改变 top-k 结果。ownerId 是可选的分区收窄。 */
  function listRecords(query) {
    query = query || {};
    if (!isOpen()) return { ok: false, error: 'store-closed' };
    const rawLimit = query.limit == null ? 100000 : Number(query.limit);
    const limit = isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.trunc(rawLimit), 1000000) : 100000;
    const ownerId = query.ownerId == null ? null : String(query.ownerId);
    const rows = ownerId
      ? db.prepare(SQL.selectLiveByOwner).all(ownerId, MEMORY_CONTRACT.intOf(limit))
      : db.prepare(SQL.selectLive).all(MEMORY_CONTRACT.intOf(limit));
    const records = rows.map(rowToRecord);
    return { ok: true, records: records, count: records.length, revision: getRevision(), truncated: rows.length >= limit };
  }

  function changesAfter(cursor, options) {
    options = options || {};
    if (!isOpen()) return { ok: false, error: 'store-closed' };
    const from = Number(cursor);
    if (!isFinite(from) || from < 0) return { ok: false, error: 'bad-cursor' };
    const rawLimit = options.limit == null ? 500 : Number(options.limit);
    const limit = isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.trunc(rawLimit), 10000) : 500;
    const rows = db.prepare(SQL.selectChanges).all(MEMORY_CONTRACT.intOf(from), MEMORY_CONTRACT.intOf(limit + 1));
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const upserts = [];
    const deletes = [];
    let next = MEMORY_CONTRACT.intOf(from);
    for (const row of page) {
      next = MEMORY_CONTRACT.intOf(row.revision);
      if (row.kind === 'delete') {
        deletes.push({ recordId: row.record_id, ownerId: row.owner_id, revision: row.revision });
      } else {
        const stored = db.prepare(SQL.selectRecord).get(row.record_id);
        if (stored && stored.deleted_at == null) upserts.push({ record: rowToRecord(stored), revision: row.revision });
      }
    }
    return { ok: true, cursor: next, serverTime: clock(), revision: getRevision(), upserts: upserts, deletes: deletes, hasMore: hasMore };
  }

  /* 供迁移/镜像重建使用的完整 id 集合（不含已删除）。 */
  function listRecordIds() {
    if (!isOpen()) return { ok: false, error: 'store-closed' };
    const rows = db.prepare('SELECT record_id FROM ' + RECORDS_TABLE + ' WHERE deleted_at IS NULL').all();
    return { ok: true, ids: rows.map(r => String(r.record_id)) };
  }

  function countRecords() { return db.prepare(SQL.countLive).get().c; }
  function countAllRecords() { return db.prepare(SQL.countAll).get().c; }
  function countOwners() { return db.prepare(SQL.countOwners).get().c; }

  /* ── 迁移标记（可重复运行 / 中断可续）────────────────────────────────
     与 chat-store 的 getMigrationState 同形，但键前缀不同（memory:），
     因此记忆迁移的水位与聊天迁移互不影响。 */
  function migrationKey(source) { return 'migration:memory:' + String(source || 'default'); }
  function getMigrationState(source) {
    const raw = readMeta(migrationKey(source));
    const empty = { ok: true, source: String(source || 'default'), version: 0, lastTimestamp: 0, records: 0, idSet: [] };
    if (!raw) return empty;
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch (_) { parsed = null; }
    if (!parsed || typeof parsed !== 'object') return empty;
    return {
      ok: true,
      source: String(source || 'default'),
      version: Number(parsed.version || 0),
      lastTimestamp: Number(parsed.lastTimestamp || 0),
      records: Number(parsed.records || 0),
      /* idSet 是 §11.3 要求的增量核对依据：memories 是**可编辑**的，
         因此"时间戳水位"不足以发现"旧记录被改了"（它的 created 没变）。 */
      idSet: Array.isArray(parsed.idSet) ? parsed.idSet.map(String) : [],
      at: parsed.at || null
    };
  }
  function setMigrationState(source, patch) {
    const current = getMigrationState(source);
    const next = {
      version: MEMORY_CONTRACT.intOf(Math.max(current.version, Number(patch && patch.version || 0))),
      lastTimestamp: MEMORY_CONTRACT.intOf(Math.max(current.lastTimestamp, Number(patch && patch.lastTimestamp || 0))),
      records: MEMORY_CONTRACT.intOf(patch && patch.records != null ? patch.records : current.records),
      idSet: (patch && Array.isArray(patch.idSet)) ? patch.idSet.map(String).slice(0, 200000) : current.idSet,
      at: MEMORY_CONTRACT.intOf(clock())
    };
    writeMeta(migrationKey(source), JSON.stringify(next));
    return { ok: true, source: String(source || 'default'), state: next };
  }

  /* ── 记忆设置（Node 侧缺省）─────────────────────────────────────────
     桌面把 apiSettings/memorySettings 的**预算与截断长度**发布过来。
     为什么必须发布：召回预算与 contentLen 直接决定"哪些记忆进入 prompt"。
     若 Node 用自己的缺省而桌面用用户的设置，两边就会在同一份 canonical 数据上
     给出不同的召回 —— 正是本波要消灭的那类漂移。
     存在 meta 表：它是节点级事实，不需要新 schema。 */
  const MEMORY_SETTINGS_KEY = 'memory:settings';
  function getMemorySettings() {
    const raw = readMeta(MEMORY_SETTINGS_KEY);
    if (!raw) return { ok: true, settings: null };
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch (_) { parsed = null; }
    if (!parsed || typeof parsed !== 'object') return { ok: true, settings: null };
    return {
      ok: true,
      settings: {
        budget: parsed.budget == null ? null : MEMORY_CONTRACT.intOf(parsed.budget),
        contentLen: parsed.contentLen == null ? null : MEMORY_CONTRACT.intOf(parsed.contentLen),
        at: parsed.at == null ? null : MEMORY_CONTRACT.intOf(parsed.at)
      }
    };
  }
  function setMemorySettings(settings) {
    const patch = settings && typeof settings === 'object' ? settings : {};
    /* 只接受正整数：0 / 负数 / NaN 一律**忽略**而不是落成 0。
       落成 0 会让预算变成"什么都装不下"，表现为"她突然什么都不记得" ——
       一个由配置解析失败引起的静默失忆，比拒绝该字段危险得多。 */
    const budget = Number(patch.budget);
    const contentLen = Number(patch.contentLen);
    const next = {
      budget: isFinite(budget) && budget > 0 ? Math.trunc(budget) : null,
      contentLen: isFinite(contentLen) && contentLen > 0 ? Math.trunc(contentLen) : null,
      at: MEMORY_CONTRACT.intOf(clock())
    };
    writeMeta(MEMORY_SETTINGS_KEY, JSON.stringify(next));
    return { ok: true, settings: next };
  }

  function meta() {
    return {
      schemaVersion: MEMORY_SCHEMA_VERSION,
      revision: isOpen() ? getRevision() : 0,
      records: isOpen() ? countRecords() : 0,
      allRecords: isOpen() ? countAllRecords() : 0,
      owners: isOpen() ? countOwners() : 0,
      lastOpenedAt: lastOpenedAt,
      file: dbFile
    };
  }

  function integrityCheck() {
    if (!isOpen()) return { ok: false, error: 'store-closed' };
    const row = db.prepare('PRAGMA quick_check').get();
    const value = row ? (row.quick_check || Object.values(row)[0]) : 'unknown';
    return { ok: String(value) === 'ok', result: String(value) };
  }

  function backup() {
    if (!isOpen()) return { ok: false, error: 'store-closed' };
    const base = dbFile.replace(/\.db$/i, '');
    const stamp = new Date(MEMORY_CONTRACT.intOf(clock())).toISOString().replace(/[:.]/g, '-');
    const file = base + '.mem-bak-' + stamp + '.db';
    try {
      db.prepare('VACUUM INTO ?').run(file);
    } catch (error) {
      return { ok: false, error: String((error && error.message) || error) };
    }
    let bytes = 0;
    try { bytes = fs.statSync(file).size; } catch (_) { bytes = 0; }
    return { ok: true, file: file, bytes: bytes, revision: getRevision() };
  }

  return {
    open: open,
    close: close,
    isOpen: isOpen,
    schemaVersion: MEMORY_SCHEMA_VERSION,
    /* 写 */
    putRecord: putRecord,
    putRecords: putRecords,
    deleteRecord: deleteRecord,
    recordActivation: recordActivation,
    /* 读 */
    getRecord: getRecord,
    listRecords: listRecords,
    listRecordIds: listRecordIds,
    changesAfter: changesAfter,
    /* 迁移 / 配置 */
    getMigrationState: getMigrationState,
    setMigrationState: setMigrationState,
    getMemorySettings: getMemorySettings,
    setMemorySettings: setMemorySettings,
    /* 观测 */
    getRevision: getRevision,
    countRecords: countRecords,
    countAllRecords: countAllRecords,
    countOwners: countOwners,
    meta: meta,
    integrityCheck: integrityCheck,
    backup: backup,
    file: dbFile
  };
}

module.exports = createMemoryStore;
module.exports.MEMORY_SCHEMA_VERSION = MEMORY_SCHEMA_VERSION;
