'use strict';

/*
 * Internal Beyond — canonical database failure classification (P11-3X-B)
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * Before this file, every SQLite failure in the Home Node reached the user as one
 * of two things: a generic thrown driver error, or — worse — the word "corrupt".
 * The two are not interchangeable, because they authorize opposite actions:
 *
 *   · corruption    MAY be isolated (rename the file aside, rebuild an empty one),
 *                   because the bytes on disk are already unusable;
 *   · everything else (read-only, permission, busy, disk full, cannot-open) must
 *                   NEVER be isolated. The database is intact and the problem is
 *                   outside it — quarantining it destroys the user's data for a
 *                   reason that was never about the data.
 *
 * The production bug this rule comes from is reproduced in
 * tests/test_p11_3x_b_runtime_db_reliability.js §DB-CLASSIFY: an intact 7-message
 * database whose WAL sidecar path was blocked was renamed aside as
 * `home-node.corrupt-<stamp>.db` and replaced with an empty one, and the service
 * then reported `open: true` / healthy. Data loss with a green light.
 *
 * WHAT IT IS NOT
 * --------------
 * It is not a second error taxonomy for the product. It is the ONE place the
 * driver's own vocabulary is translated into the reason ids the component model
 * already speaks (see runtime/component-registry.js REASON and runtime/boot-state.js
 * REASON — both carry this same set by value). It has no fs, no http, no process:
 * classification is pure, so it can be exhaustively asserted.
 *
 * EVIDENCE FOR THE MAPPING (measured on the shipped runtime, sqlite 3.50.4):
 *   new DatabaseSync(garbage).exec('SELECT …')  → code=ERR_SQLITE_ERROR errcode=26
 *                                                 errstr="file is not a database"
 *   write to an attrib +R database              → errcode=8  "attempt to write a readonly database"
 *   open inside a missing directory              → errcode=14 "unable to open database file"
 *   BEGIN IMMEDIATE while a writer holds it      → errcode=5  "database is locked"
 *   quick_check with the -wal path blocked       → errcode=526 errstr="unable to open database file"
 *
 * `errcode` is `sqlite3_errcode()`, which returns an EXTENDED result code when
 * one is available: 526 is SQLITE_CANTOPEN_ISDIR — primary 14 (SQLITE_CANTOPEN)
 * with extended flag 2. SQLite's own documented way back to the primary code is
 * `code & 0xFF`, so that mask is applied before the table lookup and the raw
 * extended value is kept for the log. Getting this wrong is how a
 * "your WAL sidecar path is blocked" failure would be read as an unknown class;
 * getting it right is why the reproduction in §DB-CLASSIFY is classified
 * `db-open-failed` and not `db-corrupt`.
 *
 * The message text is only a fallback: for errors that did not come from SQLite
 * (fs operations), for extended codes with no primary entry, and for a bare
 * string arriving from a log tail.
 */

/* The closed set. Adding a value here is a contract change: runtime/boot-state.js
   and runtime/component-registry.js must carry it too (a test asserts the three
   agree), and the reason must stay non-sensitive — it describes a state, never
   contents. Names follow the repository's kebab-case reason convention; the
   `db-` prefix keeps the database family unambiguous next to boot-state's
   existing `permission-denied` / `disk-full` / `write-failed`. */
const REASON = {
  /* The database opened but this process may not write it (SQLITE_READONLY,
     EROFS, a read-only volume). The file is fine; the mount is not. */
  READONLY: 'db-readonly',
  /* The OS refused access (EACCES / EPERM / SQLITE_AUTH). */
  PERMISSION_DENIED: 'db-permission-denied',
  /* Another connection holds the write lock (SQLITE_BUSY = 5). Retryable. */
  BUSY: 'db-busy',
  /* A table/index is locked inside the same connection (SQLITE_LOCKED = 6). */
  LOCKED: 'db-locked',
  /* SQLITE_FULL = 13, or ENOSPC from the filesystem. */
  DISK_FULL: 'db-disk-full',
  /* The bytes are not a usable database (SQLITE_NOTADB = 26, SQLITE_CORRUPT = 11)
     or `PRAGMA quick_check` said so. THE ONLY REASON THAT AUTHORIZES ISOLATION. */
  CORRUPT: 'db-corrupt',
  /* A schema written by a newer build; refusing to downgrade-write is correct. */
  SCHEMA_TOO_NEW: 'db-schema-too-new',
  /* The file could not be opened at all and no more specific cause is known
     (SQLITE_CANTOPEN = 14, ENOENT, a blocked sidecar path). Never isolation. */
  OPEN_FAILED: 'db-open-failed',
  /* node:sqlite itself is missing from the runtime. */
  UNAVAILABLE: 'db-unavailable'
};

const REASONS = Object.keys(REASON).map(k => REASON[k]);

/* SQLite primary result codes (sqlite3.h). Only codes that can describe an
   open/use failure are listed; anything else falls through to the text patterns
   and then to OPEN_FAILED, which is the honest "I know it failed, not why". */
const BY_SQLITE_CODE = {
  5: REASON.BUSY,
  6: REASON.LOCKED,
  8: REASON.READONLY,
  11: REASON.CORRUPT,
  13: REASON.DISK_FULL,
  14: REASON.OPEN_FAILED,
  23: REASON.PERMISSION_DENIED,
  26: REASON.CORRUPT
};

/* Node filesystem errno codes, for the fs calls around the driver. */
const BY_ERRNO = {
  EACCES: REASON.PERMISSION_DENIED,
  EPERM: REASON.PERMISSION_DENIED,
  EROFS: REASON.READONLY,
  EBUSY: REASON.BUSY,
  ENOSPC: REASON.DISK_FULL,
  ENOENT: REASON.OPEN_FAILED,
  ENOTDIR: REASON.OPEN_FAILED,
  EISDIR: REASON.OPEN_FAILED,
  EMFILE: REASON.OPEN_FAILED,
  ENFILE: REASON.OPEN_FAILED
};

/* Text patterns, in priority order. Corruption patterns come first on purpose:
   "malformed" is the only word that may authorize isolation, so it must not be
   shadowed by a broader pattern. */
const TEXT_PATTERNS = [
  [/\bmalformed\b|file is not a database|not a database/i, REASON.CORRUPT],
  [/readonly|read-only|read only/i, REASON.READONLY],
  [/permission denied|access is denied|operation not permitted|not authorized/i, REASON.PERMISSION_DENIED],
  [/database is locked|database table is locked|\blocked\b/i, REASON.BUSY],
  [/database or disk is full|no space left|disk full/i, REASON.DISK_FULL],
  [/unable to open database|unable to open|cannot open|no such file/i, REASON.OPEN_FAILED],
  [/disk i\/o error|i\/o error|input\/output error/i, REASON.OPEN_FAILED]
];

function isReason(value) {
  return typeof value === 'string' && REASONS.indexOf(value) >= 0;
}

/* Classify a thrown error. Always answers with a reason from the closed set, so a
   caller can never be handed an empty classification and quietly fall back to
   "corrupt" or "unknown". */
function classify(error) {
  const e = error || {};
  const detail = String((e.errstr || e.message || e) == null ? '' : (e.errstr || e.message || e)).slice(0, 300);
  const raw = rawSqliteCodeOf(e);

  /* A store may already have classified its own failure; never re-classify a
     decision that was made with more context than this function has. */
  if (isReason(e.dbReason)) return { reason: e.dbReason, detail: detail, sqliteCode: primaryCodeOf(raw), sqliteExtended: raw };

  /* Hand-set codes from the stores (see chat-store). Kept as explicit equality
     rather than a prefix match so a new code cannot be swept in by accident. */
  if (e.code === 'SCHEMA_TOO_NEW') return { reason: REASON.SCHEMA_TOO_NEW, detail: detail, sqliteCode: 0, sqliteExtended: 0 };
  if (e.code === 'SQLITE_UNAVAILABLE') return { reason: REASON.UNAVAILABLE, detail: detail, sqliteCode: 0, sqliteExtended: 0 };

  const primary = primaryCodeOf(raw);
  if (primary && Object.prototype.hasOwnProperty.call(BY_SQLITE_CODE, primary)) {
    return { reason: BY_SQLITE_CODE[primary], detail: detail, sqliteCode: primary, sqliteExtended: raw };
  }
  /* Node filesystem errno codes, for the fs calls around the driver. */
  if (typeof e.code === 'string' && Object.prototype.hasOwnProperty.call(BY_ERRNO, e.code)) {
    return { reason: BY_ERRNO[e.code], detail: detail, sqliteCode: primary, sqliteExtended: raw };
  }
  const fromText = classifyText(detail);
  return { reason: fromText || REASON.OPEN_FAILED, detail: detail, sqliteCode: primary, sqliteExtended: raw };
}

/* The raw value of `sqlite3_errcode()` — primary OR extended, or 0 when the error
   did not come from SQLite. */
function rawSqliteCodeOf(error) {
  const e = error || {};
  const n = Number(e.errcode !== undefined ? e.errcode : e.errCode);
  return Number.isInteger(n) && n > 0 ? n : 0;
}

/* SQLite's own documented reduction from an extended result code to its primary
   code (sqlite3.h: "the primary result code is the low 8 bits"). */
function primaryCodeOf(raw) {
  const n = Number(raw) || 0;
  return n > 0 ? (n & 0xff) : 0;
}

/* Classify free text (a child process's stderr tail, a log line). Returns null
   when nothing matches — absence must stay absence, so a caller can choose to
   keep its own wording instead of being handed a wrong class. */
function classifyText(text) {
  const t = String(text == null ? '' : text);
  if (!t) return null;
  /* The stores embed their own class in brackets, e.g. "[db-readonly] ...".
     Reading that first is what makes propagation deterministic rather than a
     guess over prose. */
  const tagged = t.match(/\[(db-[a-z-]+)\]/i);
  if (tagged && isReason(tagged[1].toLowerCase())) return tagged[1].toLowerCase();
  for (const pair of TEXT_PATTERNS) {
    if (pair[0].test(t)) return pair[1];
  }
  return null;
}

/* ── The isolation gate ────────────────────────────────────────────────────
 *
 * `PRAGMA quick_check` is the ONLY integrity authority. Its verdict is a value,
 * not an exception: SQLite returns a row whose first column is 'ok' when the
 * database is structurally sound, and the first problem it found otherwise.
 * Reading it this way is what separates "the database is broken" from "we could
 * not get to the database", which is the whole point of this module. */
function integrityVerdictOk(value) {
  return String(value == null ? '' : value) === 'ok';
}

/* May a THROWN error from the integrity probe authorize isolation?
   Only when the error says the file's contents are not a usable database.
   `db-busy`, `db-readonly`, `db-permission-denied`, `db-disk-full` and the
   generic `db-open-failed` are all explicitly NOT enough: in each of those cases
   the file is intact and the failure is environmental. */
function allowsQuarantine(error) {
  const c = classify(error);
  return c.reason === REASON.CORRUPT;
}

/* Is this a database failure at all? Only a database failure may be labelled with
   a database reason: a programming bug thrown inside a transaction must keep its
   own identity instead of being dressed up as `db-open-failed`, because a wrong
   class is worse than no class — it sends the operator to the disk. */
function isDatabaseError(error) {
  const e = error || {};
  if (isReason(e.dbReason)) return true;
  if (rawSqliteCodeOf(e) > 0) return true;
  if (typeof e.code === 'string') {
    if (e.code === 'ERR_SQLITE_ERROR') return true;
    if (Object.prototype.hasOwnProperty.call(BY_ERRNO, e.code)) return true;
    if (e.code === 'SCHEMA_TOO_NEW' || e.code === 'SQLITE_UNAVAILABLE') return true;
  }
  return false;
}

/* Turn any thrown thing into a classified, throwable Error. The stable fields are
   `dbReason` (the reason id) and `code` (the SCREAMING_CASE twin, so existing
   `error.code === '…'` consumers keep working); the human message keeps the
   driver's own words next to the class, because "why" and "what kind" are two
   different questions and losing either one is how the original bug hid.
 *
 * A caller may have already pinned the reason (a writability pre-flight knows more
 * than the errno does — see chat-store's writabilityFailure). That is honoured:
 * `classify` reads `dbReason` first. What is NOT skipped is normalisation — the
 * class is always written into `code` and into the message, so a downstream
 * classifier working on a log tail can read the verdict instead of guessing at
 * prose. */
function toError(error) {
  const c = classify(error);
  const err = new Error('[' + c.reason + '] ' + c.detail);
  err.dbReason = c.reason;
  err.code = ERROR_CODE[c.reason] || 'DB_FAILURE';
  err.sqliteCode = c.sqliteCode;
  err.sqliteExtended = c.sqliteExtended;
  /* Keep the original driver error reachable for a debugger without letting it
     leak into a response body. */
  if (error) err.cause = error;
  return err;
}

/* The twin code for each reason, so `error.code` stays a stable, greppable
   identifier for callers that only ever looked at `code`. */
const ERROR_CODE = {};
ERROR_CODE[REASON.READONLY] = 'DB_READONLY';
ERROR_CODE[REASON.PERMISSION_DENIED] = 'DB_PERMISSION_DENIED';
ERROR_CODE[REASON.BUSY] = 'DB_BUSY';
ERROR_CODE[REASON.LOCKED] = 'DB_LOCKED';
ERROR_CODE[REASON.DISK_FULL] = 'DB_DISK_FULL';
ERROR_CODE[REASON.CORRUPT] = 'DB_CORRUPT';
ERROR_CODE[REASON.SCHEMA_TOO_NEW] = 'SCHEMA_TOO_NEW';
ERROR_CODE[REASON.OPEN_FAILED] = 'DB_OPEN_FAILED';
ERROR_CODE[REASON.UNAVAILABLE] = 'SQLITE_UNAVAILABLE';

module.exports = {
  SCHEMA: 'internalbeyond.db-failure',
  VERSION: 1,
  REASON: REASON,
  REASONS: REASONS,
  isReason: isReason,
  classify: classify,
  classifyText: classifyText,
  isDatabaseError: isDatabaseError,
  toError: toError,
  allowsQuarantine: allowsQuarantine,
  integrityVerdictOk: integrityVerdictOk,
  primaryCodeOf: primaryCodeOf,
  rawSqliteCodeOf: rawSqliteCodeOf
};
