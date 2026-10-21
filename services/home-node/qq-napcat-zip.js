'use strict';

/* Minimal ZIP32 extractor for the optional, user-approved NapCat bundle.
 * It rejects traversal, links, duplicate Windows paths, ZIP64, encryption,
 * unsupported compression and oversized entries before writing anything. */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { Transform } = require('node:stream');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;
const MAX_ENTRIES = 12000;
const MAX_ENTRY_BYTES = 512 * 1024 * 1024;
const MAX_TOTAL_BYTES = 1536 * 1024 * 1024;
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();

function zipError(code) { const error = new Error(code); error.code = code; return error; }

function safeEntryName(rawName, isDirectory) {
  let name = String(rawName || '');
  if (!name || name.includes('\\') || name.startsWith('/') || /^[A-Za-z]:/.test(name)) throw zipError('zip-path-rejected');
  if (isDirectory && name.endsWith('/')) name = name.slice(0, -1);
  if (isDirectory && name === '.') return '';
  while (name.startsWith('./')) name = name.slice(2);
  if (isDirectory && name === '.') return '';
  if (!name && isDirectory) return '';
  if (!name || name.length > 1024 || /[\u0000-\u001f\u007f]/.test(name)) throw zipError('zip-path-rejected');
  name = name.normalize('NFC');
  const parts = name.split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || /[<>:"|?*]/.test(part) || /[. ]$/.test(part))) {
    throw zipError('zip-path-rejected');
  }
  for (const part of parts) {
    const base = part.split('.')[0].toUpperCase();
    if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(base)) throw zipError('zip-reserved-path');
  }
  return parts.join('/');
}

function parseZip32(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22 || buffer.length > MAX_ARCHIVE_BYTES) throw zipError('zip-size-invalid');
  const lower = Math.max(0, buffer.length - 22 - 0xffff);
  let eocd = -1;
  for (let i = buffer.length - 22; i >= lower; i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0 || eocd + 22 > buffer.length) throw zipError('zip-eocd-missing');
  const disk = buffer.readUInt16LE(eocd + 4);
  const centralDisk = buffer.readUInt16LE(eocd + 6);
  const entriesOnDisk = buffer.readUInt16LE(eocd + 8);
  const entriesTotal = buffer.readUInt16LE(eocd + 10);
  const centralSize = buffer.readUInt32LE(eocd + 12);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  const commentLength = buffer.readUInt16LE(eocd + 20);
  if (disk || centralDisk || entriesOnDisk !== entriesTotal || entriesTotal === 0xffff
    || centralSize === 0xffffffff || centralOffset === 0xffffffff) throw zipError('zip-multidisk-or-zip64');
  if (entriesTotal > MAX_ENTRIES || eocd + 22 + commentLength !== buffer.length
    || centralOffset + centralSize > eocd) throw zipError('zip-central-directory-invalid');

  const entries = [];
  const byPath = new Map();
  let offset = centralOffset;
  let totalUncompressed = 0;
  for (let index = 0; index < entriesTotal; index++) {
    if (offset + 46 > centralOffset + centralSize || buffer.readUInt32LE(offset) !== 0x02014b50) throw zipError('zip-central-entry-invalid');
    const madeBy = buffer.readUInt16LE(offset + 4);
    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const crc32 = buffer.readUInt32LE(offset + 16);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const entryCommentLength = buffer.readUInt16LE(offset + 32);
    const entryDisk = buffer.readUInt16LE(offset + 34);
    const externalAttributes = buffer.readUInt32LE(offset + 38);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const recordEnd = offset + 46 + nameLength + extraLength + entryCommentLength;
    if (recordEnd > centralOffset + centralSize || entryDisk || compressedSize === 0xffffffff
      || uncompressedSize === 0xffffffff || localOffset === 0xffffffff) throw zipError('zip-central-entry-invalid');
    if ((flags & 1) || (flags & ~0x080e) || ![0, 8].includes(method)) throw zipError('zip-feature-unsupported');
    if (uncompressedSize > MAX_ENTRY_BYTES) throw zipError('zip-entry-too-large');
    totalUncompressed += uncompressedSize;
    if (totalUncompressed > MAX_TOTAL_BYTES) throw zipError('zip-total-too-large');
    if (compressedSize === 0 && uncompressedSize > 0) throw zipError('zip-compression-invalid');
    if (compressedSize > 0 && uncompressedSize / compressedSize > 250) throw zipError('zip-ratio-too-large');
    const nameBuffer = buffer.subarray(offset + 46, offset + 46 + nameLength);
    if (!(flags & 0x0800) && [...nameBuffer].some(byte => byte > 0x7f)) throw zipError('zip-filename-encoding-unsupported');
    const decoded = nameBuffer.toString(flags & 0x0800 ? 'utf8' : 'ascii');
    const directory = decoded.endsWith('/');
    const name = safeEntryName(decoded, directory);
    if (!name && directory) { offset = recordEnd; continue; }
    const key = name.toLowerCase();
    const prior = byPath.get(key);
    if (prior) throw zipError('zip-duplicate-path');
    const host = madeBy >>> 8;
    const unixMode = externalAttributes >>> 16;
    const fileType = unixMode & 0xf000;
    const dosAttributes = externalAttributes & 0xffff;
    if (dosAttributes & 0x0400) throw zipError('zip-link-or-special-file');
    if (host === 3 && fileType && fileType !== 0x8000 && fileType !== 0x4000) throw zipError('zip-link-or-special-file');
    if (directory && fileType && fileType !== 0x4000) throw zipError('zip-entry-type-invalid');
    if (!directory && fileType === 0x4000) throw zipError('zip-entry-type-invalid');
    for (let slash = key.indexOf('/'); slash >= 0; slash = key.indexOf('/', slash + 1)) {
      const prefix = key.slice(0, slash);
      if (byPath.get(prefix) === 'file') throw zipError('zip-parent-path-conflict');
    }
    if (!directory && Array.from(byPath.keys()).some(existing => existing.startsWith(key + '/'))) throw zipError('zip-child-path-conflict');
    byPath.set(key, directory ? 'directory' : 'file');

    if (!directory) {
      if (localOffset + 30 > centralOffset || buffer.readUInt32LE(localOffset) !== 0x04034b50) throw zipError('zip-local-entry-invalid');
      const localNameLength = buffer.readUInt16LE(localOffset + 26);
      const localExtraLength = buffer.readUInt16LE(localOffset + 28);
      const localName = buffer.subarray(localOffset + 30, localOffset + 30 + localNameLength);
      if (!localName.equals(nameBuffer)) throw zipError('zip-local-name-mismatch');
      const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
      const dataEnd = dataOffset + compressedSize;
      if (dataOffset < localOffset || dataEnd > centralOffset) throw zipError('zip-data-range-invalid');
      entries.push({ name, directory: false, method, crc32, compressedSize, uncompressedSize, dataOffset, dataEnd });
    } else {
      entries.push({ name, directory: true });
    }
    offset = recordEnd;
  }
  if (offset !== centralOffset + centralSize) throw zipError('zip-central-size-mismatch');
  return { entries, totalUncompressed };
}

function createVerifier(expectedCrc, expectedSize, onProgress, progressBase, progressTotal) {
  let crc = 0xffffffff;
  let size = 0;
  let digest = '';
  const hash = crypto.createHash('sha256');
  const stream = new Transform({
    transform(chunk, _encoding, callback) {
      size += chunk.length;
      if (size > expectedSize) { callback(zipError('zip-entry-size-mismatch')); return; }
      for (const byte of chunk) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
      hash.update(chunk);
      if (typeof onProgress === 'function') onProgress(progressBase + size, progressTotal);
      callback(null, chunk);
    },
    flush(callback) {
      if (size !== expectedSize || ((crc ^ 0xffffffff) >>> 0) !== expectedCrc) callback(zipError('zip-crc-or-size-mismatch'));
      else { digest = hash.digest('hex'); callback(); }
    }
  });
  return { stream, size: () => size, sha256: () => digest };
}

function ensureSafeDirectories(root, relativeDirectory, fileSystem) {
  const rootPath = path.resolve(root);
  const rootStat = fileSystem.lstatSync(rootPath);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw zipError('zip-destination-invalid');
  let current = rootPath;
  const parts = relativeDirectory ? relativeDirectory.split('/') : [];
  for (const part of parts) {
    current = path.join(current, part);
    try {
      const stat = fileSystem.lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw zipError('zip-reparse-point-blocked');
    } catch (error) {
      if (!error || error.code !== 'ENOENT') throw error;
      fileSystem.mkdirSync(current, { recursive: false });
    }
  }
  return current;
}

async function extractZipArchive(archivePath, destination, options) {
  options = options || {};
  const fileSystem = options.fs || fs;
  const archiveStat = fileSystem.lstatSync(archivePath);
  if (!archiveStat.isFile() || archiveStat.isSymbolicLink() || archiveStat.size > MAX_ARCHIVE_BYTES) throw zipError('zip-archive-path-invalid');
  const archiveBuffer = fileSystem.readFileSync(archivePath);
  const parsed = parseZip32(archiveBuffer);
  const absoluteDestination = path.resolve(destination);
  if (fileSystem.existsSync(absoluteDestination)) throw zipError('zip-destination-exists');
  fileSystem.mkdirSync(absoluteDestination, { recursive: false });
  let progress = 0;
  const files = [];
  try {
    for (const entry of parsed.entries) {
      const target = path.resolve(absoluteDestination, ...entry.name.split('/'));
      const relative = path.relative(absoluteDestination, target);
      if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw zipError('zip-path-escape');
      if (entry.directory) {
        ensureSafeDirectories(absoluteDestination, entry.name, fileSystem);
        continue;
      }
      const relativeParent = entry.name.split('/').slice(0, -1).join('/');
      ensureSafeDirectories(absoluteDestination, relativeParent, fileSystem);
      const output = fileSystem.createWriteStream(target, { flags: 'wx', mode: 0o600 });
      const source = entry.compressedSize === 0
        ? Readable.from([])
        : fileSystem.createReadStream(archivePath, { start: entry.dataOffset, end: entry.dataEnd - 1 });
      const verifier = createVerifier(entry.crc32, entry.uncompressedSize, options.onProgress, progress, parsed.totalUncompressed);
      const steps = entry.method === 8 ? [source, zlib.createInflateRaw(), verifier.stream, output] : [source, verifier.stream, output];
      if (options.signal) await pipeline(...steps, { signal: options.signal });
      else await pipeline(...steps);
      progress += entry.uncompressedSize;
      files.push({ name: entry.name, size: verifier.size(), sha256: verifier.sha256() });
    }
    if (typeof options.validatePackage === 'function') await options.validatePackage(absoluteDestination);
    return { ok: true, entryCount: files.length, totalBytes: parsed.totalUncompressed, files: files };
  } catch (error) {
    if (typeof options.onFailure === 'function') {
      try { options.onFailure(absoluteDestination); } catch (_) { /* cleanup is best effort */ }
    }
    throw error;
  }
}

function inspectZipArchive(archivePath, options) {
  options = options || {};
  const fileSystem = options.fs || fs;
  const stat = fileSystem.lstatSync(archivePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_ARCHIVE_BYTES) throw zipError('zip-archive-path-invalid');
  const parsed = parseZip32(fileSystem.readFileSync(archivePath));
  return {
    archiveBytes: stat.size,
    entryCount: parsed.entries.filter(entry => !entry.directory).length,
    uncompressedBytes: parsed.totalUncompressed
  };
}

module.exports = {
  extractZipArchive,
  inspectZipArchive,
  parseZip32,
  safeEntryName,
  constants: Object.freeze({ MAX_ARCHIVE_BYTES, MAX_ENTRIES, MAX_ENTRY_BYTES, MAX_TOTAL_BYTES })
};
