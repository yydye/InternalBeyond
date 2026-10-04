'use strict';
/* ====================================================================
   IB Home Node · Runtime policy file authority（P21-R4-LIVE-4.3）
   --------------------------------------------------------------------
   **唯一**的生产成本权威：这台节点上"自动解释"开不开。

   为什么是**文件**而不是数据库行 / meta 键 / 环境变量（LIVE-4.1/4.2 的结论）：
     · meta 键或 spec_json 不需要 schema 变更，但**没有任何非浏览器写者**
       —— 那正是 LIVE-4.2 的阻塞点（provenance，不是 schema）；
     · env 被本边界自己冻结的 SERVER_ENABLE_PATH_ABSENT / N13 不变式排除；
     · 于是权威落在一个**服务端自有文件**上：唯一写者是 Node 侧的 `set()`，
       没有 HTTP 路由、没有 window/IB 表面、本阶段没有 Tauri 命令。
       值只能由 Node 侧（操作者/宿主）写，渲染器**永远**写不了 —— provenance 诚实。

   文件形状（`<dataDir>/runtime-policy.json`）：
     {
       "version": 1,
       "default": { "autoInterpretationEnabled": false },
       "characters": { "<characterId>": { "autoInterpretationEnabled": true|false } }
     }

   ── FAIL-CLOSED（§15）───────────────────────────────────────────────
   文件缺失 · 读不动 · JSON 坏 · version 不对 · characters/default 不是对象 ·
   值不是布尔 · 角色不在表里 ⇒ **OFF**。任何一条都不许把异常抛进召回路径：
   本模块的每个出口都是"一个布尔 + 一个原因"，没有 throw 路径。

   ── PER-CHARACTER（§4）─────────────────────────────────────────────
   `read(characterId)` 每次**重新读文件**（没有跨角色共享缓存，因此不可能把
   A 的值泄给 B）。角色在场且值是布尔 ⇒ 用它；否则用全局 default；否则 false。

   ── 这不是浏览器权威（§6/§11）──────────────────────────────────────
   本模块**没有**任何网络面：它只被 home-node-service.js 的装配读入，唯一写者
   是 `set()`。请求体里的 enabled/autoInterpretationEnabled 与本文件无关。
   ==================================================================== */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FILE_NAME = 'runtime-policy.json';
const SCHEMA_VERSION = 1;
const AUTHORITY_SOURCE = 'FILE_POLICY';
const MAX_CHARACTER_ID_CHARS = 180;
const MAX_ENABLED_CHARACTERS = 500;

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/* 角色 id：与解释边界同一个上界（180）。不合法 ⇒ null（调用方 fail closed）。 */
function normalizeCharacterId(value) {
  const id = value == null ? '' : String(value).trim();
  if (!id || id.length > MAX_CHARACTER_ID_CHARS) return null;
  return id;
}

/* 只接受**真正的**布尔：'true' / 1 / null 都不是 true（fail closed）。 */
function boolOf(value) {
  if (value === true) return true;
  if (value === false) return false;
  return null;
}

function createRuntimePolicy(deps) {
  const d = deps || {};
  const dataDir = String(d.dataDir == null ? '' : d.dataDir).trim();
  const logger = typeof d.logger === 'function' ? d.logger : function () {};
  const file = path.join(dataDir || '.', FILE_NAME);
  function note(event, fields) {
    try { logger(event, fields || {}); } catch (_) { /* 观测失败绝不影响判定 */ }
  }

  /* ── 读文档（唯一 IO 入口；绝不抛）────────────────────────────────── */
  function readDocument() {
    let raw = null;
    try { raw = fs.readFileSync(file, 'utf8'); }
    catch (error) {
      const missing = !!(error && error.code === 'ENOENT');
      return { ok: false, reason: missing ? 'policy-file-missing' : 'policy-file-unreadable', document: null };
    }
    let parsed = null;
    try { parsed = JSON.parse(String(raw).replace(/^\uFEFF/, '')); }
    catch (_) { return { ok: false, reason: 'policy-file-invalid-json', document: null }; }
    if (!isPlainObject(parsed)) return { ok: false, reason: 'policy-file-not-an-object', document: null };
    /* ★ 严格相等：`Number(parsed.version) !== SCHEMA_VERSION` 会让字符串 "1" 通过
       —— 那样一个**形状错误**的文件就能把全局 default 打开，而 fail-closed 矩阵
       说这种形状必须 OFF。矩阵是契约，解析器必须逐字匹配它。 */
    if (parsed.version !== SCHEMA_VERSION) return { ok: false, reason: 'policy-version-unsupported', document: null };
    return { ok: true, reason: null, document: parsed };
  }

  /* ── read：唯一的读入口 ────────────────────────────────────────────
     返回 { autoInterpretationEnabled, source, reason, characterId }。
     `source`：值**来自文件**（角色项或全局 default）⇒ 'FILE_POLICY'；
               文件不可用 / 形状不对 ⇒ 'DEFAULT_OFF'（fail closed，不是文件说的）。 */
  function read(characterId) {
    const id = normalizeCharacterId(characterId);
    const doc = readDocument();
    if (!doc.ok) {
      if (doc.reason !== 'policy-file-missing') note('runtime-policy-unusable', { reason: doc.reason });
      return { autoInterpretationEnabled: false, source: 'DEFAULT_OFF', reason: doc.reason, characterId: id };
    }
    const characters = isPlainObject(doc.document.characters) ? doc.document.characters : null;
    if (!characters) {
      return { autoInterpretationEnabled: false, source: 'DEFAULT_OFF', reason: 'characters-not-an-object', characterId: id };
    }
    if (id && Object.prototype.hasOwnProperty.call(characters, id)) {
      const entry = characters[id];
      const value = isPlainObject(entry) ? boolOf(entry.autoInterpretationEnabled) : null;
      if (value === null) {
        return { autoInterpretationEnabled: false, source: 'DEFAULT_OFF', reason: 'character-value-not-a-boolean', characterId: id };
      }
      return { autoInterpretationEnabled: value, source: 'FILE_POLICY', reason: null, characterId: id };
    }
    const def = isPlainObject(doc.document.default) ? boolOf(doc.document.default.autoInterpretationEnabled) : null;
    if (def === null) {
      return { autoInterpretationEnabled: false, source: 'DEFAULT_OFF', reason: 'default-value-not-a-boolean', characterId: id };
    }
    return { autoInterpretationEnabled: def, source: 'FILE_POLICY', reason: 'global-default', characterId: id };
  }

  /* ── set：**唯一**写者（Node 侧；没有路由、没有 window 面、没有 Tauri 命令）──
     整份文档原子替换（临时文件 + fsync + rename）：中断的写入不会留下半份策略。 */
  function set(characterId, enabled) {
    const id = normalizeCharacterId(characterId);
    if (!id) return { ok: false, code: 'INVALID_CHARACTER_ID' };
    if (enabled !== true && enabled !== false) return { ok: false, code: 'INVALID_VALUE' };
    if (!dataDir) return { ok: false, code: 'NO_DATA_DIR' };
    const current = readDocument();
    /* ★ 现存但坏掉的文件**绝不**被静默覆盖（与 desktop-credential 的
       "坏掉的凭据文件不重新生成" 同一条纪律）：先让人看到它坏了。 */
    if (!current.ok && current.reason !== 'policy-file-missing') {
      note('runtime-policy-write-refused', { reason: current.reason });
      return { ok: false, code: 'POLICY_FILE_UNUSABLE', reason: current.reason };
    }
    const base = current.ok
      ? current.document
      : { version: SCHEMA_VERSION, default: { autoInterpretationEnabled: false }, characters: {} };
    const next = {
      version: SCHEMA_VERSION,
      default: isPlainObject(base.default) ? base.default : { autoInterpretationEnabled: false },
      characters: isPlainObject(base.characters) ? Object.assign({}, base.characters) : {}
    };
    next.characters[id] = { autoInterpretationEnabled: enabled };
    const tmp = file + '.' + process.pid + '.' + crypto.randomBytes(6).toString('hex') + '.tmp';
    let fd = null;
    try {
      fd = fs.openSync(tmp, 'wx', 0o600);
      fs.writeFileSync(fd, JSON.stringify(next, null, 2) + '\n', 'utf8');
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = null;
      try { fs.chmodSync(tmp, 0o600); } catch (_) { /* Windows / 只读挂载上可能失败，不致命 */ }
      fs.renameSync(tmp, file);
    } catch (error) {
      try { if (fd !== null) fs.closeSync(fd); } catch (_) { /* 已关 */ }
      try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (_) { /* 已清 */ }
      const detail = String((error && error.message) || error);
      note('runtime-policy-write-failed', { error: detail });
      return { ok: false, code: 'POLICY_WRITE_FAILED', reason: detail };
    }
    note('runtime-policy-updated', { characterId: id, autoInterpretationEnabled: enabled });
    return {
      ok: true, file: file, characterId: id, autoInterpretationEnabled: enabled,
      version: SCHEMA_VERSION, updatedAt: Date.now()
    };
  }

  /* 有界只读视图：哪些角色显式为 true（用于 describe / 验收计数）。 */
  function enabledCharacters() {
    const doc = readDocument();
    if (!doc.ok || !isPlainObject(doc.document.characters)) return [];
    const out = [];
    for (const key of Object.keys(doc.document.characters)) {
      if (out.length >= MAX_ENABLED_CHARACTERS) break;
      const entry = doc.document.characters[key];
      if (isPlainObject(entry) && entry.autoInterpretationEnabled === true) out.push(key);
    }
    return out;
  }

  function describe() {
    const doc = readDocument();
    const def = (doc.ok && isPlainObject(doc.document.default))
      ? boolOf(doc.document.default.autoInterpretationEnabled) : null;
    return {
      file: file,
      /* fail closed：文件不可用 / 值不是布尔 ⇒ false（绝不报告"可能是真的"） */
      default: def === true,
      scope: 'per-character+global-default',
      authoritySource: AUTHORITY_SOURCE,
      schemaVersion: SCHEMA_VERSION,
      readable: doc.ok,
      reason: doc.ok ? null : doc.reason,
      enabledCharacterCount: enabledCharacters().length,
      routeExposed: false,
      writer: 'node-side-set-only'
    };
  }

  return Object.freeze({
    file: file,
    read: read,
    set: set,
    describe: describe,
    enabledCharacters: enabledCharacters
  });
}

module.exports.createRuntimePolicy = createRuntimePolicy;
module.exports.FILE_NAME = FILE_NAME;
module.exports.SCHEMA_VERSION = SCHEMA_VERSION;
module.exports.AUTHORITY_SOURCE = AUTHORITY_SOURCE;
module.exports.MAX_CHARACTER_ID_CHARS = MAX_CHARACTER_ID_CHARS;
