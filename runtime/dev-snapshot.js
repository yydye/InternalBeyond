'use strict';

const fs = require('fs');
const path = require('path');

const MANUAL_EXPORT_VERSION = 9;
const MAX_MANUAL_EXPORT_BYTES = 192 * 1024 * 1024;
const SNAPSHOT_STORE_NAMES = Object.freeze([
  'posts', 'categories', 'about', 'apiSettings', 'apiConfigs', 'chatMessages',
  'letters', 'groups', 'blogComments', 'memories', 'chatThreads', 'chatSummaries',
  'blogAnnotations', 'autoMemory', 'calEvents', 'calNotes', 'calLedger',
  'diary_entries', 'moments', 'roleLetters', 'roleLetterMemories', 'activities',
  'favorites', 'understandings', 'threads', 'disclosureFacts'
]);
const MANUAL_EXPORT_REQUIRED_STORES = Object.freeze([
  'apiConfigs', 'chatMessages', 'memories', 'chatThreads', 'chatSummaries',
  'autoMemory', 'roleLetters', 'understandings', 'threads'
]);

async function backupHomeNodeDatabase(sourceFile, targetFile) {
  const source = path.resolve(sourceFile);
  const target = path.resolve(targetFile);
  let sourceStat;
  try { sourceStat = fs.lstatSync(source); } catch (_) { sourceStat = null; }
  if (!sourceStat || !sourceStat.isFile() || sourceStat.isSymbolicLink()) {
    throw new Error('production-home-node-database-unavailable');
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const staging = target + '.snapshot-' + process.pid + '.staging';
  try { fs.rmSync(staging, { force: true }); } catch (_) {}

  let sourceDb;
  try {
    const sqlite = require('node:sqlite');
    sourceDb = new sqlite.DatabaseSync(source, { readOnly: true });
    sourceDb.exec('PRAGMA query_only = ON');
    await sqlite.backup(sourceDb, staging);
  } catch (_) {
    if (sourceDb) { try { sourceDb.close(); } catch (_) {} }
    try { fs.rmSync(staging, { force: true }); } catch (_) {}
    throw new Error('production-home-node-snapshot-failed');
  }
  try { sourceDb.close(); } catch (_) {}

  let snapshotDb;
  try {
    if (!fs.existsSync(staging) || fs.statSync(staging).size < 512) throw new Error('snapshot-empty');
    const sqlite = require('node:sqlite');
    snapshotDb = new sqlite.DatabaseSync(staging, { readOnly: true });
    const check = snapshotDb.prepare('PRAGMA quick_check').get();
    if (!check || String(check.quick_check || '').toLowerCase() !== 'ok') throw new Error('snapshot-integrity-failed');
    const tables = snapshotDb.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()
      .map(row => String(row.name || '')).filter(Boolean);
    if (!tables.length) throw new Error('snapshot-has-no-tables');
  } catch (_) {
    if (snapshotDb) { try { snapshotDb.close(); } catch (_) {} }
    try { fs.rmSync(staging, { force: true }); } catch (_) {}
    throw new Error('home-node-snapshot-validation-failed');
  }
  try { snapshotDb.close(); } catch (_) {}

  try {
    fs.renameSync(staging, target);
  } catch (_) {
    try { fs.rmSync(target, { force: true }); } catch (_) {}
    try { fs.renameSync(staging, target); } catch (_) {
      try { fs.rmSync(staging, { force: true }); } catch (_) {}
      throw new Error('home-node-snapshot-commit-failed');
    }
  }
  return Object.freeze({ file: target, bytes: fs.statSync(target).size, method: 'sqlite-online-backup' });
}

function writeJsonAtomic(file, value) {
  const target = path.resolve(file);
  const dir = path.dirname(target);
  fs.mkdirSync(dir, { recursive: true });
  const temp = target + '.' + process.pid + '.tmp';
  const bytes = Buffer.from(JSON.stringify(value), 'utf8');
  try {
    fs.writeFileSync(temp, bytes, { flag: 'wx' });
    fs.renameSync(temp, target);
  } catch (error) {
    try { fs.rmSync(temp, { force: true }); } catch (_) {}
    throw error;
  } finally {
    bytes.fill(0);
  }
}

function sanitizeSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)
    || snapshot.schema !== 'internalbeyond.dev-snapshot' || snapshot.version !== 1
    || !snapshot.stores || typeof snapshot.stores !== 'object' || Array.isArray(snapshot.stores)) {
    throw new Error('indexeddb-snapshot-contract-invalid');
  }
  const allowed = new Set(SNAPSHOT_STORE_NAMES);
  const secrets = /^(?:api[_-]?(?:key|token|secret)|x-api-key|x-auth-token|authorization|proxy-authorization|access[_-]?(?:token|key)|refresh[_-]?token|auth[_-]?token|client[_-]?secret|consumer[_-]?secret|private[_-]?key|credential|token|key|secret|password|bearer)$/i;
  function cleanEndpoint(value) {
    return String(value)
      .replace(/([?&])(?:api[_-]?(?:key|token|secret)|authorization|proxy-authorization|access[_-]?token|refresh[_-]?token|auth[_-]?token|x-api-key|x-auth-token|token|key|secret|password|signature|sig|credential)=[^&#]*/gi, '$1')
      .replace(/(https?:\/\/)[^/@\s]+:[^/@\s]+@/gi, '$1[redacted]@');
  }
  function strip(value, depth) {
    if (depth > 24) throw new Error('snapshot-nesting-depth-invalid');
    if (value == null) return value;
    if (Array.isArray(value)) return value.map(item => strip(item, depth + 1));
    if (typeof value === 'string') return value;
    if (typeof value !== 'object') return value;
    const clean = {};
    for (const key of Object.keys(value)) {
      if (secrets.test(key)) continue;
      const item = value[key];
      clean[key] = /(?:url|endpoint)$/i.test(key) && typeof item === 'string'
        ? cleanEndpoint(item)
        : strip(item, depth + 1);
    }
    return clean;
  }
  const stores = {};
  for (const name of allowed) {
    if (!Object.prototype.hasOwnProperty.call(snapshot.stores, name)) continue;
    const rows = snapshot.stores[name];
    if (!Array.isArray(rows)) throw new Error('indexeddb-snapshot-store-invalid');
    stores[name] = strip(rows, 0);
  }
  const clean = {
    schema: 'internalbeyond.dev-snapshot',
    version: 1,
    capturedAt: String(snapshot.capturedAt || '').slice(0, 40),
    sourceOrigin: String(snapshot.sourceOrigin || '').slice(0, 120),
    sourceDatabase: snapshot.sourceDatabase && typeof snapshot.sourceDatabase === 'object'
      ? { name: String(snapshot.sourceDatabase.name || '').slice(0, 80), version: Number(snapshot.sourceDatabase.version) || 0 }
      : null,
    stores
  };
  if (clean.sourceDatabase && clean.sourceDatabase.name !== 'InternalBeyondDB') throw new Error('indexeddb-source-identity-invalid');
  return clean;
}

function normalizeManualExport(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.version !== MANUAL_EXPORT_VERSION
    || typeof value.exportDate !== 'string' || !Number.isFinite(Date.parse(value.exportDate))) {
    throw new Error('manual-export-contract-invalid');
  }
  const stores = {};
  for (const name of SNAPSHOT_STORE_NAMES) {
    if (!Object.prototype.hasOwnProperty.call(value, name)) continue;
    if (!Array.isArray(value[name])) throw new Error('manual-export-store-invalid');
    stores[name] = value[name];
  }
  for (const name of MANUAL_EXPORT_REQUIRED_STORES) {
    if (!Array.isArray(stores[name])) throw new Error('manual-export-store-missing');
  }
  if (stores.apiConfigs.length === 0) throw new Error('manual-export-roles-empty');

  const clean = sanitizeSnapshot({
    schema: 'internalbeyond.dev-snapshot',
    version: 1,
    capturedAt: value.exportDate,
    sourceOrigin: 'user-authorized-plain-json-export',
    sourceDatabase: null,
    stores
  });
  for (const [name, rows] of Object.entries(clean.stores)) {
    const keyPath = name === 'categories' ? 'name' : (name === 'disclosureFacts' ? 'factId' : 'id');
    const seen = new Set();
    for (const row of rows) {
      if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('manual-export-row-invalid');
      const key = row[keyPath];
      if ((typeof key !== 'string' && typeof key !== 'number') || String(key).trim() === '') {
        throw new Error('manual-export-row-key-missing');
      }
      const canonicalKey = typeof key + ':' + String(key);
      if (seen.has(canonicalKey)) throw new Error('manual-export-duplicate-row-key');
      seen.add(canonicalKey);
    }
  }
  return Object.freeze({
    snapshot: clean,
    sourceExport: Object.freeze({ version: MANUAL_EXPORT_VERSION, exportDate: value.exportDate.slice(0, 40) })
  });
}

function readManualExportFile(filePath) {
  const source = path.resolve(String(filePath || ''));
  if (path.extname(source).toLowerCase() !== '.json') throw new Error('manual-export-json-required');
  let stat;
  try { stat = fs.lstatSync(source); } catch (_) { stat = null; }
  if (!stat || !stat.isFile() || stat.isSymbolicLink()) throw new Error('manual-export-file-unavailable');
  if (stat.size <= 0 || stat.size > MAX_MANUAL_EXPORT_BYTES) throw new Error('manual-export-size-invalid');
  let bytes;
  try { bytes = fs.readFileSync(source); }
  catch (_) { throw new Error('manual-export-read-failed'); }
  try {
    let parsed;
    try { parsed = JSON.parse(bytes.toString('utf8')); }
    catch (_) { throw new Error('manual-export-json-invalid'); }
    return normalizeManualExport(parsed);
  } finally {
    bytes.fill(0);
  }
}

module.exports = Object.freeze({
  backupHomeNodeDatabase, writeJsonAtomic, sanitizeSnapshot,
  normalizeManualExport, readManualExportFile,
  MANUAL_EXPORT_VERSION, MAX_MANUAL_EXPORT_BYTES, SNAPSHOT_STORE_NAMES
});
