'use strict';

/* Package the already-built, production-filtered DSH runtime as a standalone ZIP. */
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { ROOT, DSH_RUNTIME_EXCLUDES, wildcardToRegExp } = require('./release-manifest.js');
const optional = require('../runtime/optional-dsh-runtime.js');
const TARGET = optional.TARGET;

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] || '') : fallback;
}
const replaceExisting = process.argv.includes('--replace');
const runtimeRoot = path.resolve(argument('--runtime-root', path.join(ROOT, 'runtime', 'dsh-runtime')));
const version = fs.readFileSync(path.join(ROOT, 'VERSION'), 'utf8').trim();
const nodeVersion = fs.readFileSync(path.join(ROOT, 'runtime', 'node', 'VERSION'), 'utf8').trim();
const runtimeManifest = optional.readRuntimeManifest(runtimeRoot);
const packagePin = JSON.parse(fs.readFileSync(path.join(ROOT, 'runtime', 'dsh-runtime-package-pin.json'), 'utf8'));
const minimumProductVersion = String(packagePin.minimumProductVersion || '');
const maximumProductVersionExclusive = String(packagePin.maximumProductVersionExclusive || '');
const archiveName = `InternalBeyond-DSH-Runtime-${runtimeManifest.runtimeVersion}-${TARGET}.zip`;
const currentToMinimum = optional.compareVersion(version, minimumProductVersion);
const currentToMaximum = optional.compareVersion(version, maximumProductVersionExclusive);
if (!packagePin || packagePin.schema !== 'internalbeyond.optional-dsh-runtime-pin'
  || Number(packagePin.schemaVersion) !== 1 || packagePin.runtimeVersion !== runtimeManifest.runtimeVersion
  || packagePin.sourceRevision !== runtimeManifest.sourceRevision || packagePin.target !== TARGET
  || packagePin.archiveFile !== archiveName || !/^[a-f0-9]{64}$/i.test(String(packagePin.archiveSha256 || ''))
  || currentToMinimum == null || currentToMaximum == null || currentToMinimum < 0 || currentToMaximum >= 0) {
  throw new Error('dsh-package-pin-or-product-compatibility-invalid');
}
const excluded = DSH_RUNTIME_EXCLUDES.map(wildcardToRegExp);
const files = [];

function walk(directory, relative) {
  const entries = fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    const child = relative ? relative + '/' + entry.name : entry.name;
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) throw new Error('dsh-runtime-reparse-point-denied');
    if (stat.isDirectory()) { walk(absolute, child); continue; }
    if (!stat.isFile()) throw new Error('dsh-runtime-special-file-denied');
    if (excluded.some(pattern => pattern.test(child))) continue;
    files.push({ path: 'runtime/' + child, source: absolute, bytes: stat.size });
  }
}
walk(runtimeRoot, '');
files.sort((a, b) => a.path.localeCompare(b.path));
const payloadBytes = files.reduce((total, file) => total + file.bytes, 0);
if (files.length !== runtimeManifest.productionArtifactFiles || payloadBytes !== runtimeManifest.productionArtifactBytes) {
  throw new Error('dsh-production-runtime-artifact-count-or-size-mismatch');
}
if (files.length > optional.MAX_FILES || payloadBytes > optional.MAX_UNPACKED_BYTES) {
  throw new Error('dsh-production-runtime-package-limit-exceeded');
}

const fileRecords = files.map(file => ({ path: file.path, bytes: file.bytes, sha256: optional.hashFile(file.source) }));
const packageManifest = {
  schema: optional.SCHEMA,
  schemaVersion: 1,
  runtimeVersion: runtimeManifest.runtimeVersion,
  sourceRevision: runtimeManifest.sourceRevision,
  target: runtimeManifest.target,
  protocolVersion: runtimeManifest.protocolVersion,
  compatibility: {
    minimumProductVersion,
    maximumProductVersionExclusive,
    bundledNodeVersion: nodeVersion,
    dshNodeEngine: runtimeManifest.nodeEngine
  },
  productionArtifacts: {
    fileCount: runtimeManifest.productionArtifactFiles,
    bytes: runtimeManifest.productionArtifactBytes,
    webFrontendSha256: runtimeManifest.webFrontend.indexSha256
  },
  fileCount: fileRecords.length,
  totalBytes: payloadBytes,
  files: fileRecords
};
const packageBytes = Buffer.from(JSON.stringify(packageManifest, null, 2) + '\n', 'utf8');
const sumsBytes = Buffer.from(fileRecords.map(file => `${file.sha256}  ${file.path}`)
  .concat(`${optional.sha256(packageBytes)}  ${optional.WRAPPER_NAME}`)
  .join('\n') + '\n', 'utf8');
const zipEntries = files.map(file => ({ name: file.path, source: file.source }))
  .concat([{ name: optional.WRAPPER_NAME, bytes: packageBytes }, { name: optional.SUMS_NAME, bytes: sumsBytes }])
  .sort((a, b) => a.name.localeCompare(b.name));

function dosDateTime() { return { date: 0x0021, time: 0 }; }
function writeAll(fd, buffer, position) {
  let offset = 0;
  while (offset < buffer.length) {
    const written = fs.writeSync(fd, buffer, offset, buffer.length - offset, position + offset);
    if (!written) throw new Error('zip-output-write-failed');
    offset += written;
  }
  return position + buffer.length;
}
function localHeader(nameBytes, method, crc, compressedBytes, bytes) {
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(0x0800, 6);
  header.writeUInt16LE(method, 8);
  const dt = dosDateTime();
  header.writeUInt16LE(dt.time, 10);
  header.writeUInt16LE(dt.date, 12);
  header.writeUInt32LE(crc, 14);
  header.writeUInt32LE(compressedBytes, 18);
  header.writeUInt32LE(bytes, 22);
  header.writeUInt16LE(nameBytes.length, 26);
  header.writeUInt16LE(0, 28);
  return header;
}
function centralHeader(record) {
  const header = Buffer.alloc(46);
  header.writeUInt32LE(0x02014b50, 0);
  header.writeUInt16LE(0x0314, 4);
  header.writeUInt16LE(20, 6);
  header.writeUInt16LE(0x0800, 8);
  header.writeUInt16LE(record.method, 10);
  const dt = dosDateTime();
  header.writeUInt16LE(dt.time, 12);
  header.writeUInt16LE(dt.date, 14);
  header.writeUInt32LE(record.crc, 16);
  header.writeUInt32LE(record.compressedBytes, 20);
  header.writeUInt32LE(record.bytes, 24);
  header.writeUInt16LE(record.nameBytes.length, 28);
  header.writeUInt16LE(0, 30);
  header.writeUInt16LE(0, 32);
  header.writeUInt16LE(0, 34);
  header.writeUInt16LE(0, 36);
  header.writeUInt32LE((0o100644 << 16) >>> 0, 38);
  header.writeUInt32LE(record.localOffset, 42);
  return header;
}
function writeZip(outputPath) {
  if (fs.existsSync(outputPath) && !replaceExisting) throw new Error('optional-runtime-zip-already-exists-use---replace');
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const temporaryPath = outputPath + '.tmp-' + process.pid;
  const fd = fs.openSync(temporaryPath, 'wx');
  const central = [];
  let position = 0;
  try {
    for (const entry of zipEntries) {
      const data = entry.bytes || fs.readFileSync(entry.source);
      const compressed = zlib.deflateRawSync(data, { level: 6 });
      const useDeflate = compressed.length < data.length;
      const payload = useDeflate ? compressed : data;
      const nameBytes = Buffer.from(entry.name, 'utf8');
      if (nameBytes.length > 0xffff || data.length > 0xffffffff || payload.length > 0xffffffff
        || position > 0xffffffff) throw new Error('zip64-not-supported');
      const record = {
        nameBytes, method: useDeflate ? 8 : 0, crc: optional.crc32(data),
        compressedBytes: payload.length, bytes: data.length, localOffset: position
      };
      position = writeAll(fd, localHeader(nameBytes, record.method, record.crc, record.compressedBytes, record.bytes), position);
      position = writeAll(fd, nameBytes, position);
      position = writeAll(fd, payload, position);
      central.push(Object.assign({ name: entry.name }, record));
    }
    const centralOffset = position;
    for (const record of central) {
      position = writeAll(fd, centralHeader(record), position);
      position = writeAll(fd, record.nameBytes, position);
    }
    const centralBytes = position - centralOffset;
    if (central.length > 0xffff || centralBytes > 0xffffffff || position > 0xffffffff) throw new Error('zip64-not-supported');
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(0, 4);
    end.writeUInt16LE(0, 6);
    end.writeUInt16LE(central.length, 8);
    end.writeUInt16LE(central.length, 10);
    end.writeUInt32LE(centralBytes, 12);
    end.writeUInt32LE(centralOffset, 16);
    end.writeUInt16LE(0, 20);
    writeAll(fd, end, position);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
    fs.renameSync(temporaryPath, outputPath);
  } catch (error) {
    try { fs.closeSync(fd); } catch (_) {}
    try { fs.unlinkSync(temporaryPath); } catch (_) {}
    throw error;
  }
}

const defaultName = `InternalBeyond-DSH-Runtime-${runtimeManifest.runtimeVersion}-${TARGET}.zip`;
const outputPath = path.resolve(argument('--output', path.join(ROOT, 'dist', defaultName)));
writeZip(outputPath);
const archiveBytes = fs.statSync(outputPath).size;
if (archiveBytes > optional.MAX_ARCHIVE_BYTES) throw new Error('optional-runtime-zip-too-large');
const archiveSha256 = optional.hashFile(outputPath);
fs.writeFileSync(outputPath + '.sha256', `${archiveSha256} *${path.basename(outputPath)}\n`, 'utf8');
process.stdout.write(JSON.stringify({
  ok: true,
  output: outputPath,
  runtimeVersion: runtimeManifest.runtimeVersion,
  sourceRevision: runtimeManifest.sourceRevision,
  target: TARGET,
  fileCount: files.length,
  uncompressedBytes: payloadBytes,
  archiveBytes,
  archiveSha256,
  compatibility: packageManifest.compatibility
}) + '\n');
