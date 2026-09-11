/* ====================================================================
   IB Home Node · Canonical Chat Store
   --------------------------------------------------------------------
   目的：让 Home Node（Node 侧）成为 chatMessages 的 canonical authority。
   本文件是**领域层**（domain layer）：
     · 只管记录与版本（revision）语义；
     · 不引入 HTTP、不做鉴权、不认识 provider、不 import bridge/routes.js；
     · 零 npm 依赖 —— 只用 shipped runtime 自带的 node:sqlite（v24.18.0 已验证）。

   设计约束（M1-A）：
     1. message id 必须保持现有 canonical id（assets/js/chat-core.js §3 五种形状），
        绝不为了 SQLite 重新编号。
     2. query-critical 字段独立成列；复杂附件（images/files/voice/metadata/
        reasoning_content 等）留在 payload_json，读回时原样还原。
     3. 每次 canonical mutation → revision++（单调、不复用、不压缩空洞）。
     4. 写入幂等：同一 id 的完全相同内容 = 无操作（revision 不动）。
     5. 未知字段必须能往返（读的是存下来的 payload，不是重新投影）。
     6. schema 版本化，允许后续 migration（user_version + meta 表双记录）。

   表结构：
     messages(id PK, conversation_id, friend_id, thread_id, role, content,
              timestamp, revision, deleted_at, payload_json, created_rev, deleted_rev)
     change_log(revision PK, kind, message_id, conversation_id, at)
     idempotency(key PK, kind, message_id, at)
     meta(key PK, value)
   ==================================================================== */
'use strict';

const path = require('path');
const fs = require('fs');

const CHAT_CORE = require('../../assets/js/chat-core.js');

const SCHEMA_VERSION = CHAT_CORE.SCHEMA_VERSION; /* 1 */
const MESSAGES_TABLE = CHAT_CORE.MESSAGE_STORE;  /* 'messages' */
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;  /* §9.5：1000 条 / 24h */
const IDEMPOTENCY_MAX = 1000;
const DEFAULT_DB_FILENAME = 'home-node.db';

/* node:sqlite 是 Node 22.5+ 的内置模块（shipped runtime 24.18.0 已确认可用）。
   缺失时明确报错，绝不静默退化成另一套存储语义 —— 调用方（HTTP 层）据此
   把 Home Node 判为 degraded，并让 browser 走兼容回退路径。 */
function loadSqlite() {
  try { return require('node:sqlite'); }
  catch (error) {
    const err = new Error('node:sqlite is unavailable in this runtime: ' + (error && error.message || error));
    err.code = 'SQLITE_UNAVAILABLE';
    throw err;
  }
}

/* 稳定序列化：用于「内容是否相同」的判定。
   只按插入顺序序列化对象键 —— 键顺序变化不应被当成内容变化。 */
function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const keys = Object.keys(value).sort();
  const parts = [];
  for (const key of keys) parts.push(JSON.stringify(key) + ':' + stableStringify(value[key]));
  return '{' + parts.join(',') + '}';
}

/* ── 整数绑定归一（**必须**）────────────────────────────────────────────
   node:sqlite 把 JS number 绑定为 REAL（实测 v24.9.0：typeof(?) === 'real'）。
   REAL 在任何比较里都大于 INTEGER，所以 `timestamp < ?`（列是 integer、参数是 real）
   会恒为真；而 `timestamp = ?` 在列本身由 REAL 写成时又可能恒为假。
   两种都会静默破坏 keyset 分页与 revision 比较 —— 因此**所有**进 SQL 的数值
   都必须先经过这里转成真正的整数。 */
function intOf(value) {
  const n = Number(value);
  if (!isFinite(n)) return 0;
  return Math.trunc(n);
}

/* ── 稳定排序：为什么不是"复合 TEXT 排序键"（实测结论，不要改回去）────────
   keyset 分页需要 (timestamp, id) 的严格全序。本实现最初的方案是构造一个
   TEXT 排序键（'<pad(ms)>|<id>'）再做 `sort_key < ?` —— **必须放弃**，因为
   node:sqlite 的绑定参数在比较里会被按**数值**解释（实测两个 shipped 运行时
   v24.9.0 / v24.18.0 一致）：

     db.prepare('SELECT ? < ?').get('z','a')                       → 0   （数值比较）
     db.prepare('SELECT ? < ?').get('~bbb','~ccc')                 → 1   （字典序）
     db.prepare('SELECT ? < ?').get('~0ru','~0rt')                 → 0   （按数值）
     '0ru' < '0rt'（字面量），以及 '~000…ru|msg_req_u' < '~000…rt|msg_1_u'
                                                                    → 0   （错误答案）
     同样的字符串用**列对列**比较（`a.s > b.s`）却是正确的。
   也就是说：只要字符串里含有可被当作数字解析的部分，绑定参数路径就可能给出
   错误的字典序，字面量路径也不可靠。因此**不能**把排序建在字符串比较上。

   ⇒ 最终方案：用两个 INTEGER 列做复合键 `(timestamp, insert_seq)` 与
     `(timestamp > ? OR (timestamp = ? AND insert_seq > ?))` 谓词。
     整数比较在实测中完全正确（含同毫秒多行、双向、逐页推进）。
     `insert_seq` 是**每个库单调递增的写入序号**，由 meta 表持久化 ——
     重启不回退，重复迁移不会重新编号，同一毫秒内的多条消息因此有确定次序。 */
function createChatStore(deps) {
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
    createMessages:
      'CREATE TABLE IF NOT EXISTS ' + MESSAGES_TABLE + ' (' +
      ' id TEXT PRIMARY KEY,' +
      ' conversation_id TEXT NOT NULL,' +
      ' friend_id TEXT NOT NULL,' +
      ' thread_id TEXT NOT NULL DEFAULT "",' +
      ' role TEXT NOT NULL,' +
      ' content TEXT NOT NULL DEFAULT "",' +
      ' timestamp INTEGER NOT NULL,' +
      ' insert_seq INTEGER NOT NULL,' +
      ' revision INTEGER NOT NULL,' +
      ' created_rev INTEGER NOT NULL,' +
      ' deleted_at INTEGER,' +
      ' deleted_rev INTEGER,' +
      ' payload_json TEXT NOT NULL' +
      ')',
    createByConversation: 'CREATE INDEX IF NOT EXISTS idx_messages_conv ON ' + MESSAGES_TABLE + ' (conversation_id, timestamp, insert_seq)',
    createByFriend: 'CREATE INDEX IF NOT EXISTS idx_messages_friend ON ' + MESSAGES_TABLE + ' (friend_id, thread_id, timestamp, insert_seq)',
    createByRevision: 'CREATE INDEX IF NOT EXISTS idx_messages_rev ON ' + MESSAGES_TABLE + ' (revision)',
    createChangeLog:
      'CREATE TABLE IF NOT EXISTS change_log (' +
      ' revision INTEGER PRIMARY KEY,' +
      ' kind TEXT NOT NULL,' +
      ' message_id TEXT NOT NULL,' +
      ' conversation_id TEXT NOT NULL DEFAULT "",' +
      ' at INTEGER NOT NULL' +
      ')',
    createIdempotency:
      'CREATE TABLE IF NOT EXISTS idempotency (' +
      ' key TEXT PRIMARY KEY,' +
      ' kind TEXT NOT NULL,' +
      ' message_id TEXT NOT NULL,' +
      ' at INTEGER NOT NULL' +
      ')',
    createMeta: 'CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
    insertMessage:
      'INSERT INTO ' + MESSAGES_TABLE + ' ' +
      '(id, conversation_id, friend_id, thread_id, role, content, timestamp, insert_seq, revision, created_rev, deleted_at, deleted_rev, payload_json) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)',
    updateMessage:
      'UPDATE ' + MESSAGES_TABLE + ' SET conversation_id=?, friend_id=?, thread_id=?, role=?, content=?, timestamp=?, insert_seq=?, ' +
      'revision=?, deleted_at=NULL, deleted_rev=NULL, payload_json=? WHERE id=?',
    softDelete: 'UPDATE ' + MESSAGES_TABLE + ' SET deleted_at=?, deleted_rev=?, revision=? WHERE id=? AND deleted_at IS NULL',
    selectMessage: 'SELECT * FROM ' + MESSAGES_TABLE + ' WHERE id=?',
    selectMessageWithDeleted: 'SELECT * FROM ' + MESSAGES_TABLE + ' WHERE id=?',
    insertChange: 'INSERT INTO change_log (revision, kind, message_id, conversation_id, at) VALUES (?, ?, ?, ?, ?)',
    selectChanges: 'SELECT revision, kind, message_id, conversation_id, at FROM change_log WHERE revision > ? ORDER BY revision ASC LIMIT ?',
    maxChangeRevision: 'SELECT MAX(revision) AS m FROM change_log',
    countMessages: 'SELECT COUNT(*) AS c FROM ' + MESSAGES_TABLE + ' WHERE deleted_at IS NULL',
    countAllMessages: 'SELECT COUNT(*) AS c FROM ' + MESSAGES_TABLE,
    countConversations: 'SELECT COUNT(DISTINCT conversation_id) AS c FROM ' + MESSAGES_TABLE + ' WHERE deleted_at IS NULL',
    selectConversations: 'SELECT conversation_id, COUNT(*) AS c, MAX(timestamp) AS t FROM ' + MESSAGES_TABLE + ' WHERE deleted_at IS NULL GROUP BY conversation_id ORDER BY t DESC',
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
    if (opened) return { ok: true, alreadyOpen: true, file: dbFile, schemaVersion: SCHEMA_VERSION };
    try { fs.mkdirSync(dataDir, { recursive: true }); } catch (_) { /* 目录已存在 */ }
    /* 启动完整性检查 + 损坏隔离（Phase 16）：
       打开之前先对**已存在的**库跑一次 quick_check。损坏时不静默继续，也不静默
       换一个空库假装没事 —— 把坏文件改名保留（home-node.corrupt-<时间戳>.db）、
       再建新库，并以 error 级别喊出来。这样：
         · 桌面不会被一个坏文件卡住；
         · 数据没有被销毁，用户/支持人员可以拿保留文件去恢复；
         · 行为是**可解释**的，而不是"历史突然没了"。
       WAL 侧车文件一并改名，否则新库会读到旧 WAL。 */
    let corruptBackup = null;
    let probeFailure = null;
    if (fs.existsSync(dbFile)) {
      let probe = null;
      try {
        probe = new sqlite.DatabaseSync(dbFile);
        const row = probe.prepare('PRAGMA quick_check').get();
        const value = row ? (row.quick_check || Object.values(row)[0]) : 'unknown';
        if (String(value) !== 'ok') probeFailure = new Error('quick_check: ' + String(value));
      } catch (error) {
        probeFailure = error;
      } finally {
        /* 必须先关掉探针连接：Windows 上打开的文件无法 rename（EBUSY）。
           损坏隔离就依赖这一步，所以它在 quarantine 之前，且不能被跳过。 */
        if (probe) { try { probe.close(); } catch (_) { /* 已关闭 */ } }
      }
      if (probeFailure) corruptBackup = quarantineCorruptFile(probeFailure);
    }
    db = new sqlite.DatabaseSync(dbFile);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = FULL');
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('PRAGMA foreign_keys = ON');
    db.exec(SQL.createMessages);
    db.exec(SQL.createByConversation);
    db.exec(SQL.createByFriend);
    db.exec(SQL.createByRevision);
    db.exec(SQL.createChangeLog);
    db.exec(SQL.createIdempotency);
    db.exec(SQL.createMeta);
    const stored = readMeta('schema_version');
    if (stored == null) writeMeta('schema_version', String(SCHEMA_VERSION));
    else if (Number(stored) > SCHEMA_VERSION) {
      /* 未来版本写的库：拒绝启动，绝不降级写入（会丢列）。 */
      const err = new Error('chat store schema is newer than this build (' + stored + ' > ' + SCHEMA_VERSION + ')');
      err.code = 'SCHEMA_TOO_NEW';
      try { db.close(); } catch (_) {}
      db = null;
      throw err;
    }
    opened = true;
    lastOpenedAt = clock();
    /* 观测：只报路径与容量，绝不打印任何消息正文。 */
    logger('opened', {
      file: dbFile,
      schemaVersion: SCHEMA_VERSION,
      messages: countMessages(),
      allMessages: countAllMessages(),
      recoveredFromCorrupt: corruptBackup || undefined
    });
    return { ok: true, alreadyOpen: false, file: dbFile, schemaVersion: SCHEMA_VERSION, recoveredFromCorrupt: corruptBackup || null };
  }

  /* 把损坏的库文件（含 WAL/SHM 侧车）改名保留，返回保留文件的 basename。
     绝不删除：数据是用户的，能不能救是人的判断，不是程序的判断。 */
  function quarantineCorruptFile(cause) {
    const stamp = new Date(intOf(clock())).toISOString().replace(/[:.]/g, '-');
    const base = dbFile.replace(/\.db$/i, '');
    const kept = base + '.corrupt-' + stamp + '.db';
    try {
      fs.renameSync(dbFile, kept);
      for (const sidecar of ['-wal', '-shm']) {
        if (fs.existsSync(dbFile + sidecar)) {
          try { fs.renameSync(dbFile + sidecar, base + '.corrupt-' + stamp + '.db' + sidecar); } catch (_) { /* 尽力而为 */ }
        }
      }
      logger('corrupt-quarantined', { kept: path.basename(kept), cause: String((cause && cause.message) || cause).slice(0, 200) });
      return kept;
    } catch (error) {
      /* 改名失败是致命情况：不能在一个坏库上继续写。明确报错，交给上层判定。 */
      const err = new Error('chat store is corrupt and could not be quarantined: ' + String((error && error.message) || error));
      err.code = 'CORRUPT_CANNOT_QUARANTINE';
      throw err;
    }
  }

  /* 在线备份：先用 node:sqlite 的 backup()，它在本运行时实测会生成 0 字节文件，
     因此**校验产物**并回退到 `VACUUM INTO`（SQLite 原生、单文件、含 WAL 已提交数据）。
     两条路径都只读源库、都不改变 canonical 数据。
     备份文件落在同目录 .bak-<时间戳>.db。 */
  function backup(targetFile) {
    if (!opened) return { ok: false, error: 'store-closed' };
    const stamp = new Date(intOf(clock())).toISOString().replace(/[:.]/g, '-');
    const target = targetFile || (dbFile.replace(/\.db$/i, '') + '.bak-' + stamp + '.db');
    const staging = target + '.staging';
    const attempt = [];
    let produced = 0;
    let targetActual = target;
    /* 两条路径都先写到**全新**的 staging 路径，再改名到最终目标：
       · 最终目标不存在（时间戳保证唯一）；
       · staging 也不存在 → 不依赖"能否删除一个被占用的空文件"（Windows 上删不掉）。
       目标目录与库同卷，rename 不会跨卷。 */
    try { if (fs.existsSync(staging)) fs.unlinkSync(staging); } catch (_) { /* 交给下方报错 */ }
    try {
      sqlite.backup(db, staging);
      produced = fs.existsSync(staging) ? fs.statSync(staging).size : 0;
      attempt.push('backup:' + produced);
    } catch (error) {
      attempt.push('backup-failed:' + String((error && error.message) || error).slice(0, 80));
    }
    if (produced <= 0) {
      const alt = dbFile.replace(/\.db$/i, '') + '.bak-' + stamp + '-' + Math.random().toString(36).slice(2, 6) + '.db';
      try {
        /* VACUUM INTO：SQLite 原生、单文件、含 WAL 已提交数据。
           路径用单引号转义后内联（路径来自本进程配置，不含用户输入）。 */
        db.exec("VACUUM INTO '" + String(alt).replace(/'/g, "''") + "'");
        produced = fs.existsSync(alt) ? fs.statSync(alt).size : 0;
        attempt.push('vacuum-into:' + produced);
        /* 实测：Windows 上 backup() 留下的空文件被 sqlite 句柄占用，删不掉也盖不掉，
           因此回退路径**不试着改名**，而是直接以 alt 为最终产物（返回真实路径）。
           备份的价值在于"有一个可打开的完整副本"，不在于文件名好看。 */
        if (produced > 0) {
          targetActual = alt;
        } else {
          try { if (fs.existsSync(alt)) fs.unlinkSync(alt); } catch (_) { /* 空文件 */ }
        }
      } catch (error) {
        attempt.push('vacuum-into-failed:' + String((error && error.message) || error).slice(0, 80));
        produced = 0;
      }
    } else {
      try { fs.renameSync(staging, target); }
      catch (error) { attempt.push('rename-failed:' + String((error && error.message) || error).slice(0, 80)); produced = 0; }
    }
    if (produced <= 0) {
      logger('backup-failed', { attempts: attempt.join(' | ') });
      return { ok: false, error: 'backup-failed', message: attempt.join(' | ') };
    }
    logger('backup', { target: path.basename(targetActual), bytes: produced, revision: getRevision() });
    return { ok: true, file: targetActual, bytes: produced, revision: getRevision(), method: attempt[attempt.length - 1] };
  }

  function close() {
    if (!opened || !db) return { ok: true, alreadyClosed: true };
    try { db.close(); } catch (_) { /* 已关闭 */ }
    db = null; opened = false;
    logger('closed', {});
    return { ok: true };
  }

  function isOpen() { return opened; }

  function meta() {
    return {
      ok: true,
      open: opened,
      file: dbFile,
      schemaVersion: SCHEMA_VERSION,
      storedSchemaVersion: Number(readMeta('schema_version') || SCHEMA_VERSION),
      revision: opened ? getRevision() : 0,
      insertSeq: opened ? intOf(readMeta('insert_seq') || 0) : 0,
      messages: opened ? countMessages() : 0,
      allMessages: opened ? countAllMessages() : 0,
      conversations: opened ? countConversations() : 0,
      lastOpenedAt: lastOpenedAt
    };
  }

  /* ── 内部小工具 ──────────────────────────────────────────────────── */
  function readMeta(key) {
    const row = db.prepare(SQL.selectMeta).get(key);
    return row ? row.value : null;
  }
  function writeMeta(key, value) {
    db.prepare(SQL.upsertMeta).run(key, String(value));
  }
  function withTransaction(fn) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      db.exec('COMMIT');
      return out;
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch (_) { /* rollback 失败时保留原始错误 */ }
      throw error;
    }
  }
  function allocateRevision() {
    const current = getRevision();
    const next = current + 1;
    writeMeta('revision', String(next));
    return next;
  }
  /* 每库单调递增的写入序号（持久化在 meta.insert_seq）。
     用途：同一毫秒内多条消息的确定次序；重启不回退；重复迁移不重新编号。 */
  function allocateInsertSeq() {
    const next = intOf(Number(readMeta('insert_seq') || 0) + 1);
    writeMeta('insert_seq', String(next));
    return next;
  }
  function rowToMessage(row) {
    let parsed = null;
    try { parsed = JSON.parse(row.payload_json); }
    catch (error) {
      /* malformed JSON 保护：绝不抛给调用方，也绝不静默返回坏对象。
         用可读的占位记录表示「这一行存在但内容不可解析」，并保留 schema 必需字段。 */
      logger('payload-parse-failed', { id: row.id, kind: 'malformed-payload' });
      parsed = {
        id: row.id,
        role: row.role,
        content: '',
        friendId: row.friend_id,
        timestamp: row.timestamp,
        __malformedPayload: true
      };
      if (row.thread_id) parsed.threadId = row.thread_id;
    }
    if (!parsed || typeof parsed !== 'object') {
      parsed = { id: row.id, role: row.role, content: '', friendId: row.friend_id, timestamp: row.timestamp, __malformedPayload: true };
    }
    /* payload 是权威内容；只有它能缺 id 时（不应发生）才回落到列。 */
    if (parsed.id == null) parsed.id = row.id;
    return parsed;
  }
  function publicRow(row) {
    return {
      id: row.id,
      conversationId: row.conversation_id,
      friendId: row.friend_id,
      threadId: row.thread_id || '',
      role: row.role,
      timestamp: row.timestamp,
      revision: row.revision,
      deleted: row.deleted_at != null,
      deletedAt: row.deleted_at == null ? null : row.deleted_at
    };
  }

  /* ── 幂等表（transport 级重试保护）───────────────────────────────
     与 message id 级的存在性守卫是**两层不同的保护**：
       · id 级：同一个 id 再来 = 内容相同则跳过（内容级幂等）；
       · requestId 级：同一个请求再来 = 直接返回原来的 messageId（传输级幂等）。 */
  function rememberRequest(key, kind, messageId) {
    if (!key) return;
    const at = intOf(clock());
    db.prepare(SQL.insertIdempotency).run(String(key), String(kind), String(messageId), at);
    db.prepare(SQL.pruneIdempotency).run(at - IDEMPOTENCY_TTL_MS);
    const count = db.prepare(SQL.countIdempotency).get().c;
    if (count > IDEMPOTENCY_MAX) {
      const excess = intOf(count - IDEMPOTENCY_MAX);
      const victims = db.prepare(SQL.oldestIdempotency).all(excess);
      for (const victim of victims) db.prepare(SQL.deleteIdempotency).run(victim.key);
    }
  }
  function lookupRequest(key) {
    if (!key) return null;
    const row = db.prepare(SQL.selectIdempotency).get(String(key));
    if (!row) return null;
    return { key: String(key), kind: row.kind, messageId: row.message_id };
  }

  /* ── revision / change log ───────────────────────────────────────── */
  function getRevision() {
    const stored = Number(readMeta('revision') || 0);
    const inLog = db.prepare(SQL.maxChangeRevision).get();
    const logged = (inLog && inLog.m) || 0;
    /* 双保险：meta 与 change_log 取大值，任何一侧被外部工具改写都不会让 revision 回退。 */
    return Math.max(stored, logged);
  }

  function changesAfter(cursor, options) {
    options = options || {};
    const from = Number(cursor);
    if (!isFinite(from) || from < 0) return { ok: false, error: 'bad-cursor' };
    const limit = CHAT_CORE.normalizeLimit(options.limit, CHAT_CORE.DEFAULT_CHANGES_LIMIT, CHAT_CORE.MAX_CHANGES_LIMIT);
    const rows = db.prepare(SQL.selectChanges).all(intOf(from), intOf(limit + 1));
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const upserts = [];
    const deletes = [];
    let next = intOf(from);
    for (const row of page) {
      next = intOf(row.revision);
      if (row.kind === 'delete') deletes.push({ messageId: row.message_id, conversationId: row.conversation_id, revision: row.revision });
      else {
        const stored = db.prepare(SQL.selectMessageWithDeleted).get(row.message_id);
        if (stored && stored.deleted_at == null) upserts.push({ message: rowToMessage(stored), revision: row.revision });
      }
    }
    return {
      ok: true,
      cursor: next,
      serverTime: clock(),
      revision: getRevision(),
      upserts: upserts,
      deletes: deletes,
      hasMore: hasMore
    };
  }

  /* ── 读 ──────────────────────────────────────────────────────────── */
  function getMessage(id, options) {
    options = options || {};
    const row = db.prepare(SQL.selectMessage).get(String(id));
    if (!row) return null;
    if (row.deleted_at != null && !options.includeDeleted) return null;
    return rowToMessage(row);
  }

  /* listMessages({conversationId|friendId, threadId, before, after, limit})
       · 排序恒为 sort_key 升序 = (timestamp ASC, id ASC)，同一毫秒内也稳定；
       · before：一个 message id（或毫秒时间戳）—— 返回严格早于它的最后一页（倒序取再反转）；
       · after ：同上，返回严格晚于它的第一页；
       · before 与 after 同时给出以 before 为准（拒绝歧义）。
     实现说明：所有范围比较都在**单个** TEXT 列 sort_key 上做，而不是
     `(timestamp < ? OR (timestamp = ? AND id < ?))` —— 后者要求 SQLite 在
     OR 两侧做混合比较，在参数被绑定为 REAL 时会静默返回错结果（见 intOf 注释）。 */
  function listMessages(query) {
    query = query || {};
    let conversationId = query.conversationId ? String(query.conversationId) : null;
    if (!conversationId && query.friendId != null) {
      conversationId = CHAT_CORE.conversationIdOf(query.friendId, query.threadId);
    }
    const limit = CHAT_CORE.normalizeLimit(query.limit, CHAT_CORE.DEFAULT_LIST_LIMIT, CHAT_CORE.MAX_LIST_LIMIT);
    if (query.before != null && query.after != null) return { ok: false, error: 'ambiguous-range' };
    if (query.cursor != null && (query.before != null || query.after != null)) return { ok: false, error: 'ambiguous-range' };

    const where = ['deleted_at IS NULL'];
    const params = [];
    if (conversationId) { where.push('conversation_id = ?'); params.push(conversationId); }

    /* 三种取页方式：
         （默认）cursor 省略 —— 取**最新一页**（时间升序返回）。这是
                   「打开会话先看到最近对话」的默认语义，与审计 §8.2 的
                   `chat.history` 一致；客户端随后用 cursor=oldest 逐页向前加载历史。
         cursor —— 游标翻页：cursor = 上一次响应里的 oldest，取严格早于它的前一页。
         before / after —— 以某条消息（或时间戳）为**排他**边界取页。
       注意 before/after 的排他性：以最旧一条为 before 会得到空页（它之前没有东西），
       这是正确语义，不是 bug —— 翻页请用 cursor。 */
    let order = 'DESC';   /* DESC + reverse = 最新一页，时间升序返回 */
    if (query.cursor != null) {
      const anchor = resolveAnchor(query.cursor);
      if (!anchor) return { ok: false, error: 'unknown-anchor' };
      where.push('(timestamp < ? OR (timestamp = ? AND insert_seq < ?))');
      params.push(intOf(anchor.timestamp), intOf(anchor.timestamp), intOf(anchor.insert_seq));
      order = 'DESC';
    } else if (query.before != null || query.after != null) {
      const useBefore = query.before != null;
      const anchor = resolveAnchor(useBefore ? query.before : query.after);
      if (!anchor) return { ok: false, error: 'unknown-anchor' };
      if (useBefore) {
        where.push('(timestamp < ? OR (timestamp = ? AND insert_seq < ?))');
        params.push(intOf(anchor.timestamp), intOf(anchor.timestamp), intOf(anchor.insert_seq));
        order = 'DESC';
      } else {
        where.push('(timestamp > ? OR (timestamp = ? AND insert_seq > ?))');
        params.push(intOf(anchor.timestamp), intOf(anchor.timestamp), intOf(anchor.insert_seq));
        order = 'ASC';
      }
    }
    const sql = 'SELECT * FROM ' + MESSAGES_TABLE + ' WHERE ' + where.join(' AND ') +
      ' ORDER BY timestamp ' + order + ', insert_seq ' + order + ' LIMIT ?';
    const rows = db.prepare(sql).all(...params, intOf(limit + 1));
    const hasMore = rows.length > limit;
    let page = hasMore ? rows.slice(0, limit) : rows;
    /* DESC 取页（cursor / before 都是一次「向前翻」）→ 反转成时间升序返回，
       调用方拿到的永远是「按时间从旧到新」的一页。 */
    if (order === 'DESC') page = page.slice().reverse();
    const newest = query.cursor == null && query.before == null && query.after == null;
    const messages = page.map(rowToMessage);
    const first = page.length ? page[0] : null;
    const last = page.length ? page[page.length - 1] : null;
    /* hasMore / hasOlder / hasNewer 的精确含义：
         hasOlder / hasMore —— 这一页**之前**还有更早的消息
                               （客户端用 cursor=oldest 继续向前加载历史）
         hasNewer           —— 这一页**之后**还有更新的消息
                               （默认取最新一页时为 false；用 before 显式取中间页时为 true）
       hasMore 保留「还有更早的」语义，因为「拉最新一页」是唯一常用形态。 */
    const hasOlder = !!first && !!db.prepare(
      'SELECT 1 AS x FROM ' + MESSAGES_TABLE +
      ' WHERE deleted_at IS NULL' + (conversationId ? ' AND conversation_id = ?' : '') +
      ' AND (timestamp < ? OR (timestamp = ? AND insert_seq < ?)) LIMIT 1'
    ).get(...(conversationId ? [conversationId] : []), intOf(first.timestamp), intOf(first.timestamp), intOf(first.insert_seq));
    let hasNewer = hasMore && !newest;
    if (!hasNewer && last) {
      hasNewer = !!db.prepare(
        'SELECT 1 AS x FROM ' + MESSAGES_TABLE +
        ' WHERE deleted_at IS NULL' + (conversationId ? ' AND conversation_id = ?' : '') +
        ' AND (timestamp > ? OR (timestamp = ? AND insert_seq > ?)) LIMIT 1'
      ).get(...(conversationId ? [conversationId] : []), intOf(last.timestamp), intOf(last.timestamp), intOf(last.insert_seq));
    }
    return {
      ok: true,
      conversationId: conversationId,
      messages: messages,
      hasOlder: hasOlder,
      hasNewer: !!hasNewer,
      hasMore: hasOlder,
      cursor: last ? { id: last.id, timestamp: intOf(last.timestamp) } : null,
      cursorSeq: last ? intOf(last.insert_seq) : null,
      oldest: first ? { id: first.id, timestamp: intOf(first.timestamp) } : null,
      oldestSeq: first ? intOf(first.insert_seq) : null,
      revision: getRevision()
    };
  }

  /* 锚点 → (timestamp, insert_seq)。接受三种形态：
       · 消息 id 字符串（最常用；不存在即 unknown-anchor）
       · {id} / {timestamp,insertSeq} / {timestamp,seq} 对象
       · 纯数字或数字字符串 = 毫秒时间戳，语义为「该毫秒的末尾」 */
  function resolveAnchor(raw) {
    if (raw == null || raw === '') return null;
    if (typeof raw === 'object') {
      const byId = raw.id ? resolveAnchor(String(raw.id)) : null;
      if (byId) return byId;
      const ts = Number(raw.timestamp);
      if (!isFinite(ts)) return null;
      const seq = raw.insertSeq != null ? raw.insertSeq : raw.seq;
      return { timestamp: intOf(ts), insert_seq: seq == null ? Number.MAX_SAFE_INTEGER : intOf(seq) };
    }
    const str = String(raw);
    if (/^\d+$/.test(str)) return { timestamp: intOf(str), insert_seq: Number.MAX_SAFE_INTEGER };
    const row = db.prepare(SQL.selectMessageWithDeleted).get(str);
    if (!row) return null;
    return { timestamp: intOf(row.timestamp), insert_seq: intOf(row.insert_seq) };
  }

  function countMessages() { return db.prepare(SQL.countMessages).get().c; }
  function countAllMessages() { return db.prepare(SQL.countAllMessages).get().c; }
  function countConversations() { return db.prepare(SQL.countConversations).get().c; }
  function listConversations() {
    return db.prepare(SQL.selectConversations).all().map(row => ({
      conversationId: row.conversation_id,
      messages: row.c,
      lastTimestamp: row.t
    }));
  }

  /* ── 写 ──────────────────────────────────────────────────────────────
     putMessage 的三种结果，词表固定，供调用方与测试断言：
       created  新记录，revision 前进
       updated  同一 id 内容变化，revision 前进
       skipped  同一 id 内容完全相同（或已 soft-delete 后被同一内容重复写入）
                 —— **revision 不前进**，这是「重复迁移不产生新版本」的保证。 */
  function evaluateWrite(message) {
    const check = CHAT_CORE.validateMessage(message);
    if (!check.ok) return { ok: false, error: 'invalid-message', errors: check.errors };
    const canonical = CHAT_CORE.canonicalize(message);
    const payloadJson = JSON.stringify(canonical.message);
    const conversationId = CHAT_CORE.conversationIdOfMessage(canonical.message);
    if (!conversationId) return { ok: false, error: 'invalid-message', errors: ['missing-friendId'] };
    const id = String(canonical.message.id);
    const existing = db.prepare(SQL.selectMessageWithDeleted).get(id);
    return {
      ok: true,
      id: id,
      conversationId: conversationId,
      payloadJson: payloadJson,
      canonical: canonical,
      existing: existing || null,
      identical: !!(existing && existing.payload_json === payloadJson && existing.deleted_at == null),
      resurrect: !!(existing && existing.deleted_at != null)
    };
  }

  /* 迁移专用：existingPolicy 决定「Home Node 里已有同 id 记录时怎么办」。
       'overwrite'（默认）—— 内容不同则更新（浏览器编辑、撤回、续写都靠它）
       'skip'             —— 绝不覆盖已有记录，只报告 skipped（一次性迁移用，
                             满足「不覆盖更新版本较新的 Node 数据」；
                             代价是迁移期间浏览器侧的离线编辑不会被带入，
                             因为它们本来就会在切到 Home Node 权威后重新写入）。
     无论哪种策略，identical 永远先被短路成 skipped（revision 不动）。 */
  function writeOne(plan, options) {
    options = options || {};
    const m = plan.canonical.message;
    const threadId = m.threadId ? String(m.threadId) : '';
    if (plan.identical) return { ok: true, outcome: 'skipped', id: plan.id, revision: plan.existing.revision, conversationId: plan.conversationId, reason: 'identical' };
    if (plan.existing && options.existingPolicy === 'skip') {
      return { ok: true, outcome: 'skipped', id: plan.id, revision: plan.existing.revision, conversationId: plan.conversationId, reason: 'exists-on-node' };
    }
    const revision = intOf(allocateRevision());
    const timestamp = intOf(m.timestamp);
    /* insert_seq：重复写入（同 id 内容变化）保留原序号 —— 序号表达的是"这一行在
       世界里的位置"，不是"这一行被碰过几次"，否则一次编辑就会改变历史顺序。 */
    const insertSeq = plan.existing ? intOf(plan.existing.insert_seq) : allocateInsertSeq();
    if (plan.existing) {
      db.prepare(SQL.updateMessage).run(
        plan.conversationId, String(m.friendId), threadId, String(m.role), String(m.content),
        timestamp, insertSeq, revision, plan.payloadJson, plan.id
      );
    } else {
      db.prepare(SQL.insertMessage).run(
        plan.id, plan.conversationId, String(m.friendId), threadId, String(m.role), String(m.content),
        timestamp, insertSeq, revision, revision, plan.payloadJson
      );
    }
    db.prepare(SQL.insertChange).run(revision, 'upsert', plan.id, plan.conversationId, intOf(clock()));
    return {
      ok: true,
      outcome: plan.existing ? 'updated' : 'created',
      id: plan.id,
      revision: revision,
      conversationId: plan.conversationId,
      insertSeq: insertSeq,
      resurrected: plan.resurrect,
      droppedFields: plan.canonical.dropped
    };
  }

  function putMessage(message, options) {
    options = options || {};
    if (!opened) return { ok: false, error: 'store-closed' };
    const requestId = options.requestId ? String(options.requestId) : '';
    /* 传输级幂等：同一个 requestId 直接返回原来的 messageId，不做任何写。 */
    if (requestId && options.idempotent !== false) {
      const seen = lookupRequest(requestId);
      if (seen) {
        const stored = db.prepare(SQL.selectMessage).get(seen.messageId);
        return {
          ok: true,
          outcome: 'duplicate-request',
          id: seen.messageId,
          revision: getRevision(),
          conversationId: stored ? stored.conversation_id : null,
          message: stored ? rowToMessage(stored) : null
        };
      }
    }
    return withTransaction(() => {
      const plan = evaluateWrite(message);
      if (!plan.ok) return plan;
      const result = writeOne(plan, { existingPolicy: options.existingPolicy });
      if (requestId && options.idempotent !== false) rememberRequest(requestId, 'message', result.id);
      return result;
    });
  }

  /* 批量写（迁移专用）：一个事务内完成一批，任一记录非法 → 整批拒绝并且不做任何写入。
     返回逐条 outcome，便于迁移报告统计 created/updated/skipped。 */
  function putMessages(messages, options) {
    options = options || {};
    if (!opened) return { ok: false, error: 'store-closed' };
    if (!Array.isArray(messages)) return { ok: false, error: 'invalid-batch' };
    const requestId = options.requestId ? String(options.requestId) : '';
    if (requestId && options.idempotent !== false) {
      const seen = lookupRequest(requestId);
      if (seen) {
        let parsed = null;
        try { parsed = JSON.parse(seen.messageId); } catch (_) { parsed = null; }
        return { ok: true, outcome: 'duplicate-request', results: parsed || [], revision: getRevision() };
      }
    }
    return withTransaction(() => {
      const plans = [];
      for (let i = 0; i < messages.length; i++) {
        const plan = evaluateWrite(messages[i]);
        if (!plan.ok) {
          return { ok: false, error: 'invalid-message', index: i, errors: plan.errors, id: (messages[i] && messages[i].id) || null };
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

  /* deleteMessage：M1-A 采用 soft delete（tombstone），因为：
       · 变更日志需要能表达「这条 id 已不存在」给未来的 mobile 客户端；
       · 一个已经同步过的客户端必须能收到 message.deleted；
       · 硬删除会让「删除」与「从未存在」无法区分。
     默认 includeDeleted=false 的读取路径与硬删除对 browser 完全等价。 */
  function deleteMessage(id, options) {
    options = options || {};
    if (!opened) return { ok: false, error: 'store-closed' };
    const target = String(id == null ? '' : id);
    if (!target) return { ok: false, error: 'invalid-id' };
    const requestId = options.requestId ? String(options.requestId) : '';
    if (requestId && options.idempotent !== false) {
      const seen = lookupRequest(requestId);
      if (seen) return { ok: true, outcome: 'duplicate-request', id: seen.messageId, revision: getRevision(), deleted: false };
    }
    return withTransaction(() => {
      const row = db.prepare(SQL.selectMessageWithDeleted).get(target);
      if (!row || row.deleted_at != null) {
        return { ok: true, outcome: 'not-present', id: target, revision: getRevision(), deleted: false };
      }
      const revision = intOf(allocateRevision());
      const at = intOf(clock());
      db.prepare(SQL.softDelete).run(at, revision, revision, target);
      db.prepare(SQL.insertChange).run(revision, 'delete', target, row.conversation_id, at);
      if (requestId && options.idempotent !== false) rememberRequest(requestId, 'delete', target);
      return { ok: true, outcome: 'deleted', id: target, revision: revision, deleted: true, conversationId: row.conversation_id };
    });
  }

  /* ── 迁移标记（Phase 6：可重复运行 / 中断可续）─────────────────────
     标记是 per-source 的，因为同一台机器可能有多份 browser 来源
     （不同 origin / 不同 profile），并且每一份都必须能独立重跑。 */
  function getMigrationState(source) {
    const key = 'migration:' + String(source || 'default');
    const raw = readMeta(key);
    if (!raw) return { ok: true, source: String(source || 'default'), version: 0, lastTimestamp: 0, messages: 0 };
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch (_) { parsed = null; }
    if (!parsed || typeof parsed !== 'object') return { ok: true, source: String(source || 'default'), version: 0, lastTimestamp: 0, messages: 0 };
    return {
      ok: true,
      source: String(source || 'default'),
      version: Number(parsed.version || 0),
      lastTimestamp: Number(parsed.lastTimestamp || 0),
      messages: Number(parsed.messages || 0),
      at: parsed.at || null
    };
  }
  function setMigrationState(source, patch) {
    const key = 'migration:' + String(source || 'default');
    const current = getMigrationState(source);
    const next = {
      version: intOf(Math.max(current.version, Number(patch && patch.version || 0))),
      lastTimestamp: intOf(Math.max(current.lastTimestamp, Number(patch && patch.lastTimestamp || 0))),
      messages: intOf(patch && patch.messages != null ? patch.messages : current.messages),
      at: intOf(clock())
    };
    writeMeta(key, JSON.stringify(next));
    return { ok: true, source: String(source || 'default'), state: next };
  }

  function integrityCheck() {
    if (!opened) return { ok: false, error: 'store-closed' };
    const row = db.prepare('PRAGMA integrity_check').get();
    const value = row ? (row.integrity_check || Object.values(row)[0]) : 'unknown';
    return { ok: value === 'ok', result: String(value) };
  }

  return {
    open: open,
    close: close,
    isOpen: isOpen,
    meta: meta,
    getMessage: getMessage,
    listMessages: listMessages,
    putMessage: putMessage,
    putMessages: putMessages,
    deleteMessage: deleteMessage,
    getRevision: getRevision,
    changesAfter: changesAfter,
    listConversations: listConversations,
    countMessages: countMessages,
    countAllMessages: countAllMessages,
    countConversations: countConversations,
    getMigrationState: getMigrationState,
    setMigrationState: setMigrationState,
    integrityCheck: integrityCheck,
    backup: backup,
    /* 暴露给测试/诊断（只读） */
    file: dbFile,
    schemaVersion: SCHEMA_VERSION,
    stableStringify: stableStringify
  };
}

module.exports = createChatStore;
