/* ====================================================================
   IB Home Node · Canonical Understanding Store（M1-C.2m P1）
   --------------------------------------------------------------------
   目的：让 Home Node 成为 `understandings` 的 canonical authority —— 与
   chat-store.js / memory-store.js **同构**（同一个 SQLite 文件、同一套 PRAGMA、
   同一个 meta / idempotency 表、同样的迁移水位与损坏隔离纪律），
   但写协议是**第三种**：

     chat        创建即不可变          existingPolicy:'skip'
     memory      可变映射（覆盖式）     revision 前进，无 CAS
     understanding **单活文档 + 修订链**  一次只能有一份 active，重写必须
                                        带 expectedRevision（CAS），冲突即拒绝

   为什么不能塞进 memory-store：约束不同。memories 允许多行同 owner，
   understanding 要求 per character 的 active 计数 ∈ {0,1}，而且它的"旧版本"
   是**结构化的身份**（history + 修订号），不是一次覆盖。把两种不变量塞进
   一个 store，只会让"哪条约束在哪条路径上生效"变成无法审计的问题。
   （判据见 M1-C.2l §7：写协议相同才合并，不变量不同就加兄弟模块。）

   ── 单活不变量是**结构性**的，不是约定 ───────────────────────────────
   两条独立的强制点：
     ① `UNIQUE INDEX idx_understanding_active ON understanding_records
         (character_id) WHERE active = 1`
        —— 部分唯一索引。数据库自己拒绝第二个 active 行，**任何**写路径
        （包括未来某个忘了检查的调用方、或第二个进程）都无法绕过。
     ② 每条写路径都在 `BEGIN IMMEDIATE` 事务内先读当前 active 行再写。
        两个并发事务不可能同时通过 —— SQLite 的写锁把它们串行化，
        后到的那个看到的是先到者提交后的世界，于是 CAS 判定生效。
   两条都必须有：只有②，第二个进程/旁路写法仍能插入第二行；
   只有①，冲突会以"约束错误"而不是"revision 冲突"的形式冒出来，
   调用方无法区分"我拿到的是过期基版本"和"我写错了数据"。

   ── revision 的两层语义（刻意分开，不要合并）─────────────────────────
     doc_revision   每个角色的**理解修订号**（1,2,3…）：CAS 的比较对象，
                    也是 history 的版本号、用户更正的挂载点。
     revision       store 内的**全局**单调版本（= change_log 主键）：
                    浏览器镜像游标用它，与 memory/chat 各自独立一套。
   把两者合成一个数会让"别的角色改了一次理解"让本角色的镜像游标失效。

   ── 未知字段必须能往返 ───────────────────────────────────────────────
   payload_json 是权威内容：读回的就是当初存下去的那份对象。迁移期从浏览器
   搬过来的行可能带任何历史字段（updatedBy / closedReason / basis …），
   它们必须原样回来，否则"迁移无损"就是假的。

   ── 迁移期旧行是**不可存证**的 ───────────────────────────────────────
   浏览器里的旧行可能引用早已不存在的记忆。既有的读时存证
   （memory-visibility-core.attestDerivedArtifact）对这些证据判定
   hidden/missing → 拒绝注入，因此**不会**有任何文本泄漏。
   本 store 因此不需要"悄悄补一个假证据"，只需要如实记下 unattested 标记
   （供迁移报告与诊断使用），并把见证语义留给共享存证核心。
   ==================================================================== */
'use strict';

const path = require('path');
const fs = require('fs');

const UNDERSTANDING = require('../../assets/js/understanding-derivation-core.js');

const UNDERSTANDING_SCHEMA_VERSION = 1;
const RECORDS_TABLE = 'understanding_records';
const CORRECTIONS_TABLE = 'understanding_corrections';
const CHANGE_LOG_TABLE = 'understanding_change_log';
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
const IDEMPOTENCY_MAX = 1000;
const DEFAULT_DB_FILENAME = 'home-node.db';
const OWNER_MAX = 128;
const CONTENT_MAX = 500;
const EVIDENCE_MAX = 100;
const CORRECTION_MAX = 500;

/* node:sqlite 是 Node 22.5+ 的内置模块（shipped runtime 已确认可用）。
   缺失时明确报错，绝不静默退化成另一套存储语义 —— 与 memory-store.js:52-62 同款。 */
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
function stampOf(v) {
  /* 印章归一：缺失/非法 → null（调用方决定是否落 private）。
     这里不"修正"一个看起来合法的印章 —— 可见性语义只有
     memory-visibility-core 一份，store 不做 ACL 判断。 */
  if (!v || typeof v !== 'object') return null;
  const visibility = strOf(v.visibility, 16);
  if (['public', 'only', 'except', 'private'].indexOf(visibility) < 0) return null;
  return {
    visibility: visibility,
    visibleTo: (Array.isArray(v.visibleTo) ? v.visibleTo : []).map(x => strOf(x, 128)).filter(Boolean).slice(0, 64),
    excludeFrom: (Array.isArray(v.excludeFrom) ? v.excludeFrom : []).map(x => strOf(x, 128)).filter(Boolean).slice(0, 64)
  };
}

function createUnderstandingStore(deps) {
  deps = deps || {};
  const dataDir = deps.dataDir || process.cwd();
  const dbFile = deps.dbFile || path.join(dataDir, DEFAULT_DB_FILENAME);
  const clock = deps.clock || (() => Date.now());
  const logger = deps.logger || (() => {});
  const core = deps.core || UNDERSTANDING;
  const sqlite = deps.sqlite || loadSqlite();

  let db = null;
  let opened = false;

  const SQL = {
    createRecords:
      'CREATE TABLE IF NOT EXISTS ' + RECORDS_TABLE + ' (' +
      ' record_id TEXT PRIMARY KEY,' +
      ' character_id TEXT NOT NULL,' +
      ' active INTEGER NOT NULL DEFAULT 0,' +
      ' status TEXT NOT NULL DEFAULT "active",' +
      ' dimension TEXT NOT NULL DEFAULT "context",' +
      ' doc_revision INTEGER NOT NULL DEFAULT 0,' +
      ' conviction INTEGER,' +
      ' evidence_count INTEGER NOT NULL DEFAULT 0,' +
      ' unattested INTEGER NOT NULL DEFAULT 0,' +
      ' created_at INTEGER NOT NULL,' +
      ' updated_at INTEGER NOT NULL,' +
      ' revision INTEGER NOT NULL,' +
      ' created_rev INTEGER NOT NULL,' +
      ' deleted_at INTEGER,' +
      ' deleted_rev INTEGER,' +
      ' payload_json TEXT NOT NULL' +
      ')',
    /* ① 单活不变量的**结构性**强制点。部分唯一索引（SQLite 3.8.0+）。
       任何写路径、任何进程都无法为同一角色插入第二个 active 行。 */
    createActiveUnique:
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_understanding_active ON ' + RECORDS_TABLE +
      ' (character_id) WHERE active = 1',
    createByCharacter: 'CREATE INDEX IF NOT EXISTS idx_understanding_owner ON ' + RECORDS_TABLE + ' (character_id, created_at)',
    createByRevision: 'CREATE INDEX IF NOT EXISTS idx_understanding_rev ON ' + RECORDS_TABLE + ' (revision)',
    createCorrections:
      'CREATE TABLE IF NOT EXISTS ' + CORRECTIONS_TABLE + ' (' +
      ' correction_id TEXT PRIMARY KEY,' +
      ' character_id TEXT NOT NULL,' +
      ' understanding_id TEXT NOT NULL,' +
      ' revision INTEGER NOT NULL,' +
      ' basis TEXT NOT NULL DEFAULT "user_stated",' +
      ' text TEXT NOT NULL DEFAULT "",' +
      ' status TEXT NOT NULL DEFAULT "active",' +
      ' applied_revision INTEGER,' +
      ' created_at INTEGER NOT NULL,' +
      ' updated_at INTEGER NOT NULL,' +
      ' revision_at INTEGER NOT NULL,' +
      ' revision_global INTEGER NOT NULL,' +
      ' payload_json TEXT NOT NULL' +
      ')',
    createCorrectionsByCharacter:
      'CREATE INDEX IF NOT EXISTS idx_understanding_corr ON ' + CORRECTIONS_TABLE + ' (character_id, status)',
    createChangeLog:
      'CREATE TABLE IF NOT EXISTS ' + CHANGE_LOG_TABLE + ' (' +
      ' revision INTEGER PRIMARY KEY,' +
      ' kind TEXT NOT NULL,' +
      ' record_id TEXT NOT NULL,' +
      ' character_id TEXT NOT NULL DEFAULT "",' +
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
      '(record_id, character_id, active, status, dimension, doc_revision, conviction, evidence_count, unattested, ' +
      'created_at, updated_at, revision, created_rev, deleted_at, deleted_rev, payload_json) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)',
    updateRecord:
      'UPDATE ' + RECORDS_TABLE + ' SET character_id=?, active=?, status=?, dimension=?, doc_revision=?, conviction=?, ' +
      'evidence_count=?, unattested=?, created_at=?, updated_at=?, revision=?, deleted_at=NULL, deleted_rev=NULL, payload_json=? ' +
      'WHERE record_id=?',
    softDelete: 'UPDATE ' + RECORDS_TABLE + ' SET active=0, deleted_at=?, deleted_rev=?, revision=? WHERE record_id=? AND deleted_at IS NULL',
    selectRecord: 'SELECT * FROM ' + RECORDS_TABLE + ' WHERE record_id=?',
    selectActive: 'SELECT * FROM ' + RECORDS_TABLE + ' WHERE character_id=? AND active=1 AND deleted_at IS NULL LIMIT 1',
    countActive: 'SELECT COUNT(*) AS c FROM ' + RECORDS_TABLE + ' WHERE character_id=? AND active=1 AND deleted_at IS NULL',
    countActiveAll: 'SELECT COUNT(*) AS c FROM ' + RECORDS_TABLE + ' WHERE active=1 AND deleted_at IS NULL',
    selectLive: 'SELECT * FROM ' + RECORDS_TABLE + ' WHERE deleted_at IS NULL ORDER BY created_at ASC, record_id ASC LIMIT ?',
    selectLiveByCharacter: 'SELECT * FROM ' + RECORDS_TABLE + ' WHERE deleted_at IS NULL AND character_id=? ORDER BY created_at ASC, record_id ASC LIMIT ?',
    countLive: 'SELECT COUNT(*) AS c FROM ' + RECORDS_TABLE + ' WHERE deleted_at IS NULL',
    countAll: 'SELECT COUNT(*) AS c FROM ' + RECORDS_TABLE,
    countCharacters: 'SELECT COUNT(DISTINCT character_id) AS c FROM ' + RECORDS_TABLE + ' WHERE deleted_at IS NULL',
    insertChange: 'INSERT INTO ' + CHANGE_LOG_TABLE + ' (revision, kind, record_id, character_id, at) VALUES (?, ?, ?, ?, ?)',
    selectChanges: 'SELECT revision, kind, record_id, character_id, at FROM ' + CHANGE_LOG_TABLE + ' WHERE revision > ? ORDER BY revision ASC LIMIT ?',
    maxChangeRevision: 'SELECT MAX(revision) AS m FROM ' + CHANGE_LOG_TABLE,
    insertCorrection:
      'INSERT INTO ' + CORRECTIONS_TABLE + ' ' +
      '(correction_id, character_id, understanding_id, revision, basis, text, status, applied_revision, created_at, updated_at, revision_at, revision_global, payload_json) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)',
    selectCorrection: 'SELECT * FROM ' + CORRECTIONS_TABLE + ' WHERE correction_id=?',
    selectCorrectionsByCharacter: 'SELECT * FROM ' + CORRECTIONS_TABLE + ' WHERE character_id=? ORDER BY created_at ASC, correction_id ASC',
    selectActiveCorrections: 'SELECT * FROM ' + CORRECTIONS_TABLE + ' WHERE character_id=? AND status=? ORDER BY created_at ASC, correction_id ASC',
    updateCorrectionStatus: 'UPDATE ' + CORRECTIONS_TABLE + ' SET status=?, applied_revision=?, updated_at=?, revision_global=? WHERE correction_id=?',
    countCorrections: 'SELECT COUNT(*) AS c FROM ' + CORRECTIONS_TABLE,
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
    if (opened) return { ok: true, alreadyOpen: true, file: dbFile, schemaVersion: UNDERSTANDING_SCHEMA_VERSION };
    try { fs.mkdirSync(dataDir, { recursive: true }); } catch (_) { /* 目录已存在 */ }
    db = new sqlite.DatabaseSync(dbFile);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = FULL');
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('PRAGMA foreign_keys = ON');
    db.exec(SQL.createRecords);
    db.exec(SQL.createByCharacter);
    db.exec(SQL.createByRevision);
    db.exec(SQL.createMeta);
    db.exec(SQL.createIdempotency);
    db.exec(SQL.createCorrections);
    db.exec(SQL.createCorrectionsByCharacter);
    db.exec(SQL.createChangeLog);
    /* 单活索引在**既有数据**上创建时可能失败（老库若有重复 active 行）。
       这里必须如实报错并保持关闭：一个"索引建不上但照样用"的库，
       恰恰是"约定而非不变量"的状态，正是本阶段要消灭的东西。 */
    try {
      db.exec(SQL.createActiveUnique);
    } catch (error) {
      const err = new Error('understanding store cannot enforce the single-active invariant: ' + String((error && error.message) || error));
      err.code = 'ACTIVE_INVARIANT_UNENFORCEABLE';
      try { db.close(); } catch (_) { /* 已关闭 */ }
      db = null;
      throw err;
    }
    const stored = readMeta('understanding_schema');
    if (stored == null) writeMeta('understanding_schema', String(UNDERSTANDING_SCHEMA_VERSION));
    else if (Number(stored) > UNDERSTANDING_SCHEMA_VERSION) {
      const err = new Error('understanding store schema is newer than this build (' + stored + ' > ' + UNDERSTANDING_SCHEMA_VERSION + ')');
      err.code = 'SCHEMA_TOO_NEW';
      try { db.close(); } catch (_) { /* 已关闭 */ }
      db = null;
      throw err;
    }
    opened = true;
    /* 观测：只报条数与版本，**绝不**打印任何理解正文或更正正文。 */
    logger('understanding-opened', {
      file: dbFile,
      schemaVersion: UNDERSTANDING_SCHEMA_VERSION,
      records: countRecords(),
      allRecords: countAllRecords(),
      characters: countCharacters(),
      active: countActiveAll(),
      corrections: countCorrections()
    });
    return { ok: true, alreadyOpen: false, file: dbFile, schemaVersion: UNDERSTANDING_SCHEMA_VERSION };
  }

  function close() {
    if (!db) return { ok: true, alreadyClosed: true };
    try { db.close(); } catch (_) { /* 已关闭 */ }
    db = null;
    opened = false;
    return { ok: true };
  }
  function isOpen() { return opened && !!db; }

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
    const stored = Number(readMeta('understanding_revision') || 0);
    const inLog = db.prepare(SQL.maxChangeRevision).get();
    const logged = (inLog && inLog.m) || 0;
    return Math.max(stored, logged);
  }
  function allocateRevision() {
    const next = getRevision() + 1;
    writeMeta('understanding_revision', String(next));
    return next;
  }

  /* ── 行 ↔ 文档 ─────────────────────────────────────────────────────
     payload_json 是**权威内容**；提升列只用于查询与不变量。读回时把提升列
     里"权威的那一份"回填（active / doc_revision 由 store 拥有，不是 payload 的）。 */
  function rowToDoc(row) {
    let parsed = null;
    try { parsed = JSON.parse(row.payload_json); }
    catch (error) {
      logger('understanding-payload-parse-failed', { id: row.record_id, kind: 'malformed-payload' });
      parsed = { id: row.record_id, characterId: row.character_id, status: row.status, current: { content: '', conviction: 0, evidenceIds: [], basis: 'ai_guess' }, history: [], __malformedPayload: true };
    }
    if (!parsed || typeof parsed !== 'object') {
      parsed = { id: row.record_id, characterId: row.character_id, status: row.status, current: { content: '', conviction: 0, evidenceIds: [], basis: 'ai_guess' }, history: [], __malformedPayload: true };
    }
    if (parsed.id == null) parsed.id = row.record_id;
    if (parsed.characterId == null) parsed.characterId = row.character_id;
    if (!Array.isArray(parsed.history)) parsed.history = [];
    /* store 拥有这三个字段：payload 里写什么都不作数（否则一条 payload 就能
       声称自己是 active，绕过单活不变量）。 */
    parsed.active = Number(row.active) === 1;
    parsed.revision = intOf(row.doc_revision);
    parsed.storeRevision = intOf(row.revision);
    parsed.unattested = Number(row.unattested) === 1;
    return parsed;
  }

  /* ── 文档归一：把"候选理解"变成一份可持久化的 canonical 文档 ──────────
     刻意**不**做 ACL 判断，只做形状归一。旧版本（history）在重写时由
     rewrite() 负责追加 —— 候选里带 history 会被忽略，那是 store 的账本。 */
  function normalizeCurrent(next) {
    next = next || {};
    return {
      content: String(next.content || '').trim().slice(0, CONTENT_MAX),
      conviction: Math.max(0, Math.min(100, intOf(next.conviction))),
      evidenceIds: idsOf(next.evidenceIds, EVIDENCE_MAX),
      basis: core.basisOf(next.basis),
      updatedAt: intOf(next.updatedAt) || intOf(clock()),
      updatedBy: String(next.updatedBy || '').slice(0, 64)
    };
  }
  function historyEntryOf(current, at, revision) {
    /* history 条目 = 上一版 current + 它自己的版本号与时间。
       带上版本号是**必须**的：用户更正挂载在 doc_revision 上（见 corrections），
       没有版本号的 history 无法回答"更正针对的是哪一版"。 */
    return {
      content: current.content,
      conviction: current.conviction,
      evidenceIds: (current.evidenceIds || []).slice(),
      basis: current.basis,
      updatedAt: current.updatedAt,
      updatedBy: current.updatedBy || '',
      revision: intOf(revision),
      archivedAt: at
    };
  }

  /* 幂等表：与 chat/memory 共用同一张表，键前缀 'un:' 独立命名空间。 */
  function requestKey(raw) { return raw ? 'un:' + String(raw) : ''; }
  function rememberRequest(key, kind, value) {
    if (!key) return;
    const at = intOf(clock());
    db.prepare(SQL.insertIdempotency).run(String(key), String(kind), String(value), at);
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
    return { key: String(key), kind: row.kind, value: row.message_id };
  }

  function correctionRowToRecord(row) {
    let parsed = null;
    try { parsed = JSON.parse(row.payload_json); } catch (_) { parsed = null; }
    const out = (parsed && typeof parsed === 'object') ? parsed : {};
    out.id = row.correction_id;
    out.characterId = row.character_id;
    out.understandingId = row.understanding_id;
    out.revision = intOf(row.revision);
    out.basis = row.basis;
    out.text = row.text;
    out.status = row.status;
    out.appliedRevision = row.applied_revision == null ? null : intOf(row.applied_revision);
    out.createdAt = intOf(row.created_at);
    out.updatedAt = intOf(row.updated_at);
    out.storeRevision = intOf(row.revision_global);
    return out;
  }

  /* ── 写：rewrite（唯一的结构写入路径）───────────────────────────────
     options.expectedRevision
       0           → 期望"当前没有 active 文档"；已存在则 revision-conflict
       正整数 N     → 期望当前 active 文档的 doc_revision === N；否则 conflict
     options.allowUnattested
       true        → 允许证据无法解析（**仅迁移路径**）。理由：浏览器历史行可能
                     引用早已删除的记忆，而既有读时存证本来就会拒绝注入它们，
                     所以这不是放宽隐私边界，只是让"迁移无损"成立。
     返回值（词表固定，供调用方与测试断言）：
       created / updated / skipped(identical) / conflict / invalid / no-active
     "identical" 的判据只取**内容 + 证据集 + 印章**，不含 conviction：
     同一条结论被重新推导出来时 conviction 会因 basis 相同而相同，但即使不同，
     那也是"同一句话"，不该消耗一次修订号（R9：identical candidate 不churn）。 */
  function rewrite(characterId, next, options) {
    options = options || {};
    if (!isOpen()) return { ok: false, error: 'store-closed' };
    const owner = strOf(characterId, OWNER_MAX);
    if (!owner) return { ok: false, error: 'invalid-character' };
    const candidate = next || {};
    const requestId = requestKey(options.requestId);
    if (requestId && options.idempotent !== false) {
      const seen = lookupRequest(requestId);
      if (seen) {
        const row = db.prepare(SQL.selectRecord).get(seen.value);
        return {
          ok: true, outcome: 'duplicate-request', id: seen.value, characterId: owner,
          revision: getRevision(), document: row ? rowToDoc(row) : null
        };
      }
    }
    const expectedRaw = options.expectedRevision;
    const expected = expectedRaw == null ? null : intOf(expectedRaw);
    const migrating = options.migrate === true;
    return withTransaction(() => {
      const activeRow = db.prepare(SQL.selectActive).get(owner);
      const activeDoc = activeRow ? rowToDoc(activeRow) : null;

      /* ⓪ 迁移路径（仅 /understanding/records 的 migrate:true 走这里）
         语义与 rewrite 完全不同，因此必须是**显式**的一条分支：
           · 迁移不是"派生了一份新理解"，它没有 expectedRevision 语义；
           · 它要把浏览器遗留的 history 链**原样**搬过来（含旧版本号）；
           · 权威侧已有 active 文档时**不覆盖**（canonical 更新），只如实报 skipped。
         这正是 M1-C.2m §8 要求的"迁移不得与派生共用一条会互相踩的写路径"。 */
      if (migrating) {
        if (activeDoc) {
          return {
            ok: true, outcome: 'skipped', reason: 'exists-on-node', id: activeDoc.id,
            characterId: owner, revision: getRevision(), docRevision: intOf(activeDoc.revision),
            document: activeDoc
          };
        }
        return writeMigrated(owner, candidate, requestId, options);
      }

      /* ① CAS：基版本不符 → 无任何变更（不"尽力而为"地覆盖）。 */
      if (expected != null) {
        const currentDocRevision = activeDoc ? intOf(activeDoc.revision) : 0;
        if (expected !== currentDocRevision) {
          logger('understanding-rewrite-conflict', {
            characterId: owner,
            expectedRevision: expected,
            actualRevision: currentDocRevision,
            active: !!activeDoc,
            /* 结构化冲突原因：调用方（调度器）据此决定是"重新读一次再派生"
               还是"这一轮放弃"。刻意不把两种冲突混成一个词。 */
            reason: activeDoc ? 'stale-base' : (activeDoc === null && expected > 0 ? 'no-active-document' : 'stale-base')
          });
          return {
            ok: false, error: 'revision-conflict', outcome: 'conflict',
            expectedRevision: expected, actualRevision: currentDocRevision,
            characterId: owner, revision: getRevision(),
            activeId: activeDoc ? activeDoc.id : null,
            document: activeDoc
          };
        }
      }

      const now = intOf(clock());
      const stamp = stampOf(candidate.stamp) || { visibility: 'private', visibleTo: [], excludeFrom: [] };
      const evidenceIds = idsOf(candidate.evidenceIds, EVIDENCE_MAX);
      const content = String(candidate.content || '').trim().slice(0, CONTENT_MAX);
      if (!content) return { ok: false, error: 'invalid-content', outcome: 'invalid' };
      const unattested = candidate.unattested === true;

      /* ② 内容等价 → 不动 revision（幂等重跑、模型重复给出同一结论都走这里） */
      if (activeDoc && activeDoc.current) {
        const sameContent = String(activeDoc.current.content || '') === content;
        const sameEvidence = JSON.stringify(idsOf(activeDoc.current.evidenceIds, EVIDENCE_MAX)) === JSON.stringify(evidenceIds);
        const sameStamp = JSON.stringify(stampOf(activeDoc.visibility)) === JSON.stringify(stamp);
        if (sameContent && sameEvidence && sameStamp && !unattested) {
          return {
            ok: true, outcome: 'skipped', reason: 'identical', id: activeDoc.id,
            characterId: owner, revision: getRevision(), docRevision: intOf(activeDoc.revision),
            document: activeDoc
          };
        }
      }

      const storeRevision = intOf(allocateRevision());
      const current = normalizeCurrent(Object.assign({}, candidate, { content: content, evidenceIds: evidenceIds }));
      if (activeDoc) {
        const docRevision = intOf(activeDoc.revision) + 1;
        const history = (Array.isArray(activeDoc.history) ? activeDoc.history : []).slice();
        if (activeDoc.current && activeDoc.current.content) {
          history.push(historyEntryOf(activeDoc.current, now, activeDoc.revision));
        }
        while (history.length > core.U_HISTORY_CAP) history.shift();
        const doc = Object.assign({}, activeDoc, {
          id: activeDoc.id,
          characterId: owner,
          status: 'active',
          active: true,
          revision: docRevision,
          dimension: core.dimensionOf(candidate.dimension) || activeDoc.dimension || 'context',
          current: current,
          history: history,
          visibility: stamp,
          unattested: !!(unattested || activeDoc.unattested),
          lastUpdatedAt: now,
          storeRevision: storeRevision
        });
        db.prepare(SQL.updateRecord).run(
          owner, 1, 'active', doc.dimension, docRevision, current.conviction, evidenceIds.length,
          doc.unattested ? 1 : 0, intOf(activeDoc.createdAt) || now, now, storeRevision, JSON.stringify(doc), activeDoc.id
        );
        db.prepare(SQL.insertChange).run(storeRevision, 'rewrite', activeDoc.id, owner, now);
        /* 已被本次重写**越过**的更正 → applied（不删除：它是持久证据）。
           参数是 **newRevision**（刚写下的那一版），见函数头注释。 */
        markCorrectionsApplied(owner, docRevision, storeRevision, now);
        if (requestId && options.idempotent !== false) rememberRequest(requestId, 'rewrite', activeDoc.id);
        return {
          ok: true, outcome: 'updated', id: activeDoc.id, characterId: owner,
          revision: storeRevision, docRevision: docRevision, previousDocRevision: docRevision - 1,
          historyLength: history.length, unattested: doc.unattested, document: doc
        };
      }

      const id = strOf(candidate.id, 128) || ('un_' + now.toString(36) + '_' + Math.floor(Math.random() * 46656).toString(36));
      const existingRow = db.prepare(SQL.selectRecord).get(id);
      if (existingRow && existingRow.deleted_at == null && Number(existingRow.active) === 1) {
        /* id 已被占用且是另一份 active 文档：这是调用方 bug，不是 CAS 冲突。
           如实报错，绝不"顺手改成更新那一条" —— 那会把两条不同的理解合并。 */
        return { ok: false, error: 'id-in-use', outcome: 'invalid', id: id, characterId: owner };
      }
      const doc = {
        id: id,
        characterId: owner,
        status: 'active',
        active: true,
        kind: 'understanding',
        revision: 1,
        dimension: core.dimensionOf(candidate.dimension),
        current: current,
        history: [],
        visibility: stamp,
        unattested: unattested,
        createdAt: now,
        lastUpdatedAt: now,
        storeRevision: storeRevision
      };
      if (candidate.createdByUser === true) doc.createdByUser = true;
      try {
        db.prepare(SQL.insertRecord).run(
          id, owner, 1, 'active', doc.dimension, 1, current.conviction, evidenceIds.length,
          unattested ? 1 : 0, now, now, storeRevision, storeRevision, JSON.stringify(doc)
        );
      } catch (error) {
        /* 部分唯一索引在这里生效：同一角色已有 active 文档（例如另一个进程
           在本次事务之前刚插入）。把它**翻译成 CAS 冲突**，而不是把 raw
           SQLite 错误抛给调用方 —— 调用方需要的是"我的基版本过期了"。 */
        const message = String((error && error.message) || error);
        if (/UNIQUE|constraint/i.test(message)) {
          const now2 = db.prepare(SQL.selectActive).get(owner);
          const winner = now2 ? rowToDoc(now2) : null;
          logger('understanding-insert-conflict', { characterId: owner, reason: 'active-row-exists' });
          return {
            ok: false, error: 'revision-conflict', outcome: 'conflict',
            expectedRevision: expected == null ? 0 : expected,
            actualRevision: winner ? intOf(winner.revision) : 0,
            characterId: owner, revision: getRevision(),
            activeId: winner ? winner.id : null, document: winner
          };
        }
        throw error;
      }
      db.prepare(SQL.insertChange).run(storeRevision, 'create', id, owner, now);
      /* 新建首版：**不**标记任何更正为 applied。第一版还不存在时，不可能有
         任何更正"针对更早的版本" —— 反倒可能有更正已经挂在这个角色上
         （它在文档出现之前就被记下了）。那种更正必须继续约束这一版。 */
      if (requestId && options.idempotent !== false) rememberRequest(requestId, 'rewrite', id);
      return {
        ok: true, outcome: 'created', id: id, characterId: owner,
        revision: storeRevision, docRevision: 1, historyLength: 0, unattested: unattested, document: doc
      };
    });
  }

  /* ── 迁移写入（与派生写入**分属两条分支**，理由见 rewrite 的 ⓪）─────
     旧 history 的版本号：迁移过来的历史没有"绝对修订号"可言（浏览器从不
     分配它），因此这里按"最近 N 版"连续编号 1..N+1，并把绝对序号放在
     `legacyRevisions`（若有）里原样保留。绝不假装它是 canonical 的修订号 ——
     那会让 user correction 挂到一个从未存在过的版本上。 */
  function writeMigrated(owner, candidate, requestId, options) {
    const now = intOf(clock());
    const rawHistory = Array.isArray(candidate.legacyHistory) ? candidate.legacyHistory : [];
    const trimmed = rawHistory.slice(-core.U_HISTORY_CAP);
    const history = trimmed.map((h, index) => ({
      content: strOf(h && h.content, CONTENT_MAX),
      conviction: Math.max(0, Math.min(100, intOf(h && h.conviction))),
      evidenceIds: idsOf(h && h.evidenceIds, EVIDENCE_MAX),
      basis: core.basisOf(h && h.basis),
      updatedAt: intOf(h && h.updatedAt),
      updatedBy: strOf(h && h.updatedBy, 64),
      revision: index + 1,
      archivedAt: intOf(h && h.archivedAt) || now,
      legacyStatus: h && h.legacyStatus ? strOf(h.legacyStatus, 16) : undefined,
      migrated: true
    }));
    const docRevision = history.length + 1;
    const id = strOf(candidate.id, 128) || ('un_' + now.toString(36) + '_' + Math.floor(Math.random() * 46656).toString(36));
    const current = normalizeCurrent({
      content: candidate.content,
      conviction: candidate.conviction,
      evidenceIds: candidate.evidenceIds,
      basis: candidate.basis,
      updatedAt: candidate.updatedAt,
      updatedBy: candidate.updatedBy
    });
    if (!current.content) return { ok: false, error: 'invalid-content', outcome: 'invalid', characterId: owner };
    const stamp = stampOf(candidate.stamp) || { visibility: 'private', visibleTo: [], excludeFrom: [] };
    const storeRevision = intOf(allocateRevision());
    const doc = {
      id: id,
      characterId: owner,
      status: 'active',
      active: true,
      kind: 'understanding',
      revision: docRevision,
      dimension: core.dimensionOf(candidate.dimension),
      current: current,
      history: history,
      visibility: stamp,
      unattested: candidate.unattested === true,
      migratedFrom: 'browser-indexeddb',
      migratedAt: now,
      createdAt: intOf(candidate.createdAt) || now,
      lastUpdatedAt: now,
      storeRevision: storeRevision
    };
    const existingRow = db.prepare(SQL.selectRecord).get(id);
    try {
      if (existingRow && existingRow.deleted_at == null) {
        /* 同一 id 已被一条**非 active** 的历史行占用：更新它（迁移重跑）。 */
        db.prepare(SQL.updateRecord).run(
          owner, 1, 'active', doc.dimension, docRevision, current.conviction, current.evidenceIds.length,
          doc.unattested ? 1 : 0, doc.createdAt, now, storeRevision, JSON.stringify(doc), id
        );
      } else {
        db.prepare(SQL.insertRecord).run(
          id, owner, 1, 'active', doc.dimension, docRevision, current.conviction, current.evidenceIds.length,
          doc.unattested ? 1 : 0, doc.createdAt, now, storeRevision, storeRevision, JSON.stringify(doc)
        );
      }
    } catch (error) {
      const message = String((error && error.message) || error);
      if (/UNIQUE|constraint/i.test(message)) {
        const row = db.prepare(SQL.selectActive).get(owner);
        const winner = row ? rowToDoc(row) : null;
        return {
          ok: false, error: 'revision-conflict', outcome: 'conflict', characterId: owner,
          actualRevision: winner ? intOf(winner.revision) : 0, activeId: winner ? winner.id : null, document: winner
        };
      }
      throw error;
    }
    db.prepare(SQL.insertChange).run(storeRevision, 'migrate', id, owner, now);
    if (requestId && options.idempotent !== false) rememberRequest(requestId, 'migrate', id);
    logger('understanding-migrated', { characterId: owner, docRevision: docRevision, history: history.length, unattested: doc.unattested });
    return {
      ok: true, outcome: 'created', id: id, characterId: owner, revision: storeRevision,
      docRevision: docRevision, historyLength: history.length, unattested: doc.unattested,
      migrated: true, document: doc
    };
  }

  /* 与 rewrite() 同事务调用：把"针对刚被替换掉的那一版"的更正记为 applied。
     状态词表（**纯记账，不是约束开关**）：
       active     —— 刚被记下，还没有任何一版在它之后被写下；
       applied    —— 已经有一版在它之后被写下（"那次判断已经被它约束过一次"）；
       superseded —— 被更新的更正取代；retracted —— 用户撤回。

     判据：`correction.revision <= baseRevision`（baseRevision = newRevision - 1，
     即刚被替换掉的那一版）。

     ⚠️⚠️ 但**派生读的绝不是 status**。理由是一条真实时序：
       用户更正 L 落在"模型已生成、提交尚未发生"的窗口里 → 那次提交可能因
       CAS 冲突失败，而另一个写者从 L 之前的基版本提交成功。于是 L 从未进入过
       任何提示词，却因为"有一版在它之后写下"被标成了 applied。
       如果派生只读 active，L 就会**永久静默** —— 正是本阶段要消灭的缺陷。
       因此约束口径是 `constrainingCorrections()`（按版本关系算），
       status 只用于诊断与未来的 UI。 */
  function markCorrectionsApplied(characterId, newRevision, storeRevision, at) {
    const baseRevision = intOf(newRevision) - 1;
    const rows = db.prepare(SQL.selectActiveCorrections).all(characterId, 'active');
    let n = 0;
    for (const row of rows) {
      if (intOf(row.revision) > baseRevision) continue;
      const applied = db.prepare(SQL.updateCorrectionStatus).run('applied', baseRevision, at, storeRevision, row.correction_id);
      if (applied && applied.changes) n++;
    }
    return n;
  }

  /* ── 读 ──────────────────────────────────────────────────────────── */
  function getActive(characterId) {
    if (!isOpen()) return null;
    const owner = strOf(characterId, OWNER_MAX);
    if (!owner) return null;
    const row = db.prepare(SQL.selectActive).get(owner);
    return row ? rowToDoc(row) : null;
  }
  function getRecord(id, options) {
    options = options || {};
    if (!isOpen()) return null;
    const row = db.prepare(SQL.selectRecord).get(strOf(id, 128));
    if (!row) return null;
    if (row.deleted_at != null && !options.includeDeleted) return null;
    return rowToDoc(row);
  }
  function listRecords(query) {
    query = query || {};
    if (!isOpen()) return { ok: false, error: 'store-closed' };
    const rawLimit = query.limit == null ? 10000 : Number(query.limit);
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.trunc(rawLimit), 100000) : 10000;
    const owner = query.characterId == null ? null : strOf(query.characterId, OWNER_MAX);
    const rows = owner
      ? db.prepare(SQL.selectLiveByCharacter).all(owner, limit)
      : db.prepare(SQL.selectLive).all(limit);
    const records = rows.map(rowToDoc);
    return { ok: true, records: records, count: records.length, revision: getRevision(), truncated: rows.length >= limit };
  }
  function changesAfter(cursor, options) {
    options = options || {};
    if (!isOpen()) return { ok: false, error: 'store-closed' };
    const from = Number(cursor);
    if (!Number.isFinite(from) || from < 0) return { ok: false, error: 'bad-cursor' };
    const rawLimit = options.limit == null ? 500 : Number(options.limit);
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.trunc(rawLimit), 10000) : 500;
    const rows = db.prepare(SQL.selectChanges).all(intOf(from), intOf(limit + 1));
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const upserts = [];
    const deletes = [];
    let next = intOf(from);
    for (const row of page) {
      next = intOf(row.revision);
      if (row.kind === 'delete') {
        deletes.push({ recordId: row.record_id, characterId: row.character_id, revision: row.revision });
      } else {
        const stored = db.prepare(SQL.selectRecord).get(row.record_id);
        if (stored && stored.deleted_at == null) upserts.push({ record: rowToDoc(stored), revision: row.revision });
      }
    }
    return { ok: true, cursor: next, serverTime: clock(), revision: getRevision(), upserts: upserts, deletes: deletes, hasMore: hasMore };
  }

  /* 删除：默认**拒绝**。理解不是可以随手删掉的记录 —— 它是持久活文档，
     用户的"我不想让你这样理解我"必须走更正（correction），而不是让文档消失
     （消失之后下一轮会重新长出同一句话，正是 M1-C.2l 的原始缺陷）。
     只有显式 force（测试/管理路径）才软删。 */
  function remove(id, options) {
    options = options || {};
    if (!isOpen()) return { ok: false, error: 'store-closed' };
    const target = strOf(id, 128);
    if (!target) return { ok: false, error: 'invalid-id' };
    if (options.force !== true) return { ok: false, error: 'delete-refused', id: target, hint: 'use addCorrection to record a user correction instead' };
    return withTransaction(() => {
      const row = db.prepare(SQL.selectRecord).get(target);
      if (!row || row.deleted_at != null) {
        return { ok: true, outcome: 'not-present', id: target, revision: getRevision(), deleted: false };
      }
      const revision = intOf(allocateRevision());
      const at = intOf(clock());
      db.prepare(SQL.softDelete).run(at, revision, revision, target);
      db.prepare(SQL.insertChange).run(revision, 'delete', target, row.character_id, at);
      return { ok: true, outcome: 'deleted', id: target, revision: revision, deleted: true, characterId: row.character_id };
    });
  }

  /* ── 更正（correction）：durable evidence about the understanding itself ──
     M1-C.2m §1 冻结的语义：
       用户说"你对我这一点理解错了" = 一条**关于理解本身的持久证据**。
     它必须：
       · 记下被纠正的是**哪一版**（revision）与哪份文档（understandingId）；
       · 在之后的派生里被显式读到（buildPrompt 的更正段），
         因此**不可能**被下一个后台周期悄悄遗忘；
       · 不删文档、不清历史、不是"把行标成 contested 然后藏起来"。
     主键 = (characterId, understandingId, revision) 的确定性哈希：
     同一次更正重复提交是**幂等**的（返回同一条），不会堆出两条。
     返回 {ok, outcome: 'created'|'existing', correction} */
  function addCorrection(characterId, input) {
    input = input || {};
    if (!isOpen()) return { ok: false, error: 'store-closed' };
    const owner = strOf(characterId || input.characterId, OWNER_MAX);
    if (!owner) return { ok: false, error: 'invalid-character' };
    const text = strOf(input.text, CORRECTION_MAX);
    const row = db.prepare(SQL.selectActive).get(owner);
    const understandingId = strOf(input.understandingId, 128) || (row ? String(row.record_id) : '');
    if (!understandingId) {
      /* 没有 active 文档就没有"被纠正的理解" —— 拒绝而不是记一条悬空更正。
         （悬空更正会在下一次派生时约束一份它从未见过的文档。） */
      return { ok: false, error: 'no-active-document', characterId: owner };
    }
    const revision = input.revision == null ? (row ? intOf(row.doc_revision) : 0) : intOf(input.revision);
    if (!(revision > 0)) return { ok: false, error: 'invalid-revision', characterId: owner };
    const basis = ['user_stated', 'user_corroborated', 'ai_inference', 'ai_guess'].indexOf(String(input.basis)) >= 0
      ? String(input.basis) : 'user_stated';
    const key = core.stableToken(owner + '\u0001' + understandingId + '\u0001' + revision + '\u0001' + text);
    const id = 'unc_' + key;
    const existing = db.prepare(SQL.selectCorrection).get(id);
    if (existing) return { ok: true, outcome: 'existing', correction: correctionRowToRecord(existing), characterId: owner };

    return withTransaction(() => {
      const at = intOf(clock());
      const storeRevision = intOf(allocateRevision());
      /* 被纠正的那一版内容**冻结在更正记录里**：它是"她曾经相信 X"的原始证据。
         只存 revision 号是不够的 —— history 会被 cap 20 挤掉，而更正必须
         永远说得清自己否定的是什么。 */
      const target = db.prepare(SQL.selectRecord).get(understandingId);
      const targetDoc = target ? rowToDoc(target) : null;
      const corrected = (targetDoc && intOf(targetDoc.revision) === revision && targetDoc.current)
        ? String(targetDoc.current.content || '').slice(0, CORRECTION_MAX)
        : (targetDoc && Array.isArray(targetDoc.history)
          ? (targetDoc.history.filter(h => intOf(h.revision) === revision).map(h => String(h.content || '').slice(0, CORRECTION_MAX))[0] || '')
          : '');
      const record = {
        id: id,
        kind: 'understanding-correction',
        characterId: owner,
        understandingId: understandingId,
        revision: revision,
        basis: basis,
        text: text,
        correctedContent: corrected,
        status: 'active',
        source: strOf(input.source, 32) || 'user-veto',
        createdAt: at,
        updatedAt: at,
        storeRevision: storeRevision
      };
      if (input.legacy === true) record.legacy = true;
      db.prepare(SQL.insertCorrection).run(
        id, owner, understandingId, revision, basis, text, 'active', at, at, at, storeRevision, JSON.stringify(record)
      );
      db.prepare(SQL.insertChange).run(storeRevision, 'correct', id, owner, at);
      logger('understanding-correction-added', { characterId: owner, revision: revision, basis: basis, legacy: input.legacy === true });
      return { ok: true, outcome: 'created', correction: record, characterId: owner };
    });
  }

  function listCorrections(characterId, options) {
    options = options || {};
    if (!isOpen()) return { ok: false, error: 'store-closed', corrections: [] };
    const owner = strOf(characterId, OWNER_MAX);
    const status = options.status == null ? null : strOf(options.status, 16);
    const rows = status
      ? db.prepare(SQL.selectActiveCorrections).all(owner, status)
      : db.prepare(SQL.selectCorrectionsByCharacter).all(owner);
    return { ok: true, corrections: rows.map(correctionRowToRecord), characterId: owner };
  }
  /* 仍生效的更正 = 约束未来派生的那一组。这是派生路径唯一该读的口径。 */
  function activeCorrections(characterId) {
    return listCorrections(characterId, { status: 'active' }).corrections || [];
  }
  /* ── 约束未来派生的更正（派生路径**唯一**该读的口径）──────────────────
     一条更正约束"它针对的那一版及之后"的每一次派生，直到它被
     retracted / superseded。因此判据是**版本关系**，而不是 status：
       correction.revision <= 当前文档版本  → 它针对的判断已经写下（或更早），
                                              派生必须知道"它被挑战过"；
       correction.revision > 当前文档版本   → 它针对一版还没写下的判断
                                              （飞行途中记下的更正），
                                              那一版一旦写下，它立即生效。
     两个方向都要包含，因为"记下更正"与"派生提交"的时序无法预先确定。 */
  function constrainingCorrections(characterId) {
    const owner = strOf(characterId, OWNER_MAX);
    if (!isOpen() || !owner) return [];
    const doc = getActive(owner);
    const currentRevision = doc ? intOf(doc.revision) : 0;
    const rows = db.prepare(SQL.selectCorrectionsByCharacter).all(owner);
    return rows
      .map(correctionRowToRecord)
      .filter(c => c.status !== 'retracted' && c.status !== 'superseded')
      /* 悬空更正（没有任何版本可挂）不会约束派生 —— 它约束的是一份不存在的文档。 */
      .filter(c => currentRevision > 0)
      .sort((a, b) => (a.createdAt - b.createdAt) || String(a.id).localeCompare(String(b.id)));
  }
  function setCorrectionStatus(id, status, options) {
    options = options || {};
    if (!isOpen()) return { ok: false, error: 'store-closed' };
    const allowed = ['active', 'applied', 'superseded', 'retracted'];
    const next = strOf(status, 16);
    if (allowed.indexOf(next) < 0) return { ok: false, error: 'invalid-status' };
    const row = db.prepare(SQL.selectCorrection).get(strOf(id, 128));
    if (!row) return { ok: false, error: 'not-found' };
    return withTransaction(() => {
      const at = intOf(clock());
      const storeRevision = intOf(allocateRevision());
      db.prepare(SQL.updateCorrectionStatus).run(next, options.appliedRevision == null ? row.applied_revision : intOf(options.appliedRevision), at, storeRevision, row.correction_id);
      db.prepare(SQL.insertChange).run(storeRevision, 'correction-status', row.correction_id, row.character_id, at);
      const updated = db.prepare(SQL.selectCorrection).get(row.correction_id);
      return { ok: true, correction: correctionRowToRecord(updated), revision: storeRevision };
    });
  }

  /* ── 派生水位（durable）：成本护栏的**唯一**持久状态 ──────────────────
     为什么必须持久：M1-C.2l §Q5 证明旧写者的 6h 水位是**内存**里的，
     于是每开一次页面就等于"从没派生过" —— 桌面开开关关就会反复烧 token。
     而常驻 Home Node 的 tick 如果也把水位放内存，进程重启就会重新派生一次。
     字段（每个角色一条，存 meta 表，无需新 schema）：
       evidenceFingerprint  上次**成功**派生时的证据指纹（两端同一算法）
       lastDerivedAt        上次成功提交修订的时间
       lastAttemptAt        上次尝试时间（含失败/跳过），用于失败退避
       lastOutcome          上一次的结果词表（created/updated/skipped/conflict/…）
       lastAccepted          上一次是否真的改变了文档（false → 证据没动，别再来）
       skipReason           上一次的跳过原因（诊断用）
       attempts             连续失败次数（退避） */
  function watermarkKey(characterId) { return 'understanding:watermark:' + String(characterId || 'default'); }
  function getWatermark(characterId) {
    const raw = readMeta(watermarkKey(characterId));
    const empty = {
      characterId: String(characterId || ''), evidenceFingerprint: null, lastDerivedAt: 0,
      lastAttemptAt: 0, lastOutcome: null, lastAccepted: null, skipReason: 'never-derived', attempts: 0
    };
    if (!raw) return empty;
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch (_) { parsed = null; }
    if (!parsed || typeof parsed !== 'object') return empty;
    return Object.assign(empty, {
      evidenceFingerprint: parsed.evidenceFingerprint == null ? null : String(parsed.evidenceFingerprint),
      lastDerivedAt: intOf(parsed.lastDerivedAt),
      lastAttemptAt: intOf(parsed.lastAttemptAt),
      lastOutcome: parsed.lastOutcome == null ? null : String(parsed.lastOutcome),
      lastAccepted: parsed.lastAccepted == null ? null : !!parsed.lastAccepted,
      skipReason: parsed.skipReason == null ? null : String(parsed.skipReason),
      attempts: intOf(parsed.attempts)
    });
  }
  function setWatermark(characterId, patch) {
    if (!isOpen()) return { ok: false, error: 'store-closed' };
    const owner = strOf(characterId, OWNER_MAX);
    if (!owner) return { ok: false, error: 'invalid-character' };
    const current = getWatermark(owner);
    const next = Object.assign({}, current, patch || {}, { characterId: owner });
    writeMeta(watermarkKey(owner), JSON.stringify({
      evidenceFingerprint: next.evidenceFingerprint == null ? null : String(next.evidenceFingerprint),
      lastDerivedAt: intOf(next.lastDerivedAt),
      lastAttemptAt: intOf(next.lastAttemptAt),
      lastOutcome: next.lastOutcome == null ? null : String(next.lastOutcome),
      lastAccepted: next.lastAccepted == null ? null : !!next.lastAccepted,
      skipReason: next.skipReason == null ? null : String(next.skipReason),
      attempts: intOf(next.attempts)
    }));
    return { ok: true, watermark: getWatermark(owner) };
  }

  /* ── 迁移标记（可重复运行 / 中断可续）────────────────────────────────
     与 memory-store 同形，键前缀 understanding:。 */
  function migrationKey(source) { return 'migration:understanding:' + String(source || 'default'); }
  function getMigrationState(source) {
    const raw = readMeta(migrationKey(source));
    const empty = { ok: true, source: String(source || 'default'), version: 0, records: 0, idSet: [], at: null };
    if (!raw) return empty;
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch (_) { parsed = null; }
    if (!parsed || typeof parsed !== 'object') return empty;
    return {
      ok: true, source: String(source || 'default'),
      version: intOf(parsed.version), records: intOf(parsed.records),
      idSet: Array.isArray(parsed.idSet) ? parsed.idSet.map(String) : [],
      at: parsed.at || null
    };
  }
  function setMigrationState(source, patch) {
    const current = getMigrationState(source);
    const next = {
      version: intOf(Math.max(current.version, Number(patch && patch.version || 0))),
      records: intOf(patch && patch.records != null ? patch.records : current.records),
      idSet: (patch && Array.isArray(patch.idSet)) ? patch.idSet.map(String).slice(0, 200000) : current.idSet,
      at: intOf(clock())
    };
    writeMeta(migrationKey(source), JSON.stringify(next));
    return { ok: true, source: String(source || 'default'), state: next };
  }

  function countRecords() { return db.prepare(SQL.countLive).get().c; }
  function countAllRecords() { return db.prepare(SQL.countAll).get().c; }
  function countCharacters() { return db.prepare(SQL.countCharacters).get().c; }
  function countActiveAll() { return db.prepare(SQL.countActiveAll).get().c; }
  function countCorrections() { return db.prepare(SQL.countCorrections).get().c; }
  /* 不变量自检（供诊断与测试）：返回所有 active 计数 > 1 的角色。
     正常运行下**必须永远为空**；非空就说明有人绕过了 store（或索引没建上）。 */
  function invariantViolations() {
    if (!isOpen()) return { ok: false, error: 'store-closed', violations: [] };
    const rows = db.prepare(
      'SELECT character_id, COUNT(*) AS c FROM ' + RECORDS_TABLE +
      ' WHERE active=1 AND deleted_at IS NULL GROUP BY character_id HAVING c > 1'
    ).all();
    return { ok: true, violations: rows.map(r => ({ characterId: String(r.character_id), active: Number(r.c) })) };
  }
  function activeIdOf(characterId) {
    const doc = getActive(characterId);
    return doc ? doc.id : null;
  }

  return {
    open: open,
    close: close,
    isOpen: isOpen,
    getRevision: getRevision,
    rewrite: rewrite,
    getActive: getActive,
    getRecord: getRecord,
    listRecords: listRecords,
    changesAfter: changesAfter,
    remove: remove,
    addCorrection: addCorrection,
    listCorrections: listCorrections,
    activeCorrections: activeCorrections,
    constrainingCorrections: constrainingCorrections,
    setCorrectionStatus: setCorrectionStatus,
    getWatermark: getWatermark,
    setWatermark: setWatermark,
    getMigrationState: getMigrationState,
    setMigrationState: setMigrationState,
    invariantViolations: invariantViolations,
    activeIdOf: activeIdOf,
    countRecords: countRecords,
    countAllRecords: countAllRecords,
    countCharacters: countCharacters,
    countActiveAll: countActiveAll,
    countCorrections: countCorrections,
    core: core
  };
}

module.exports = createUnderstandingStore;
module.exports.UNDERSTANDING_SCHEMA_VERSION = UNDERSTANDING_SCHEMA_VERSION;
module.exports.RECORDS_TABLE = RECORDS_TABLE;
module.exports.CORRECTIONS_TABLE = CORRECTIONS_TABLE;
module.exports.CHANGE_LOG_TABLE = CHANGE_LOG_TABLE;
