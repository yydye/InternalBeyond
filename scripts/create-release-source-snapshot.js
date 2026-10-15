'use strict';

/*
 * Create a self-contained source snapshot for RC validation.
 *
 * Source files are copied as Buffers. Do not read/write source through text
 * APIs: that can rewrite LF/CRLF, BOMs, encodings, or binary assets on Windows.
 * The one ignored test-support tree below is intentionally included for P32
 * fixtures; build products under its target/ directory are always excluded.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const SNAPSHOT_SCHEMA = 'internalbeyond.release-source-snapshot';
const TEST_SUPPORT_ROOTS = ['tmp/p32-w5-r3b'];
const OMIT_DIR_NAMES = new Set(['.git', '.dsh-tmp', 'node_modules', 'target', '.cache']);
const TEST_SUPPORT_EXTENSIONS = new Set(['.js', '.json', '.lock', '.png', '.rs', '.toml']);
const DISCLOSURE_FROZEN_FILES = require(path.join(REPO_ROOT, 'tests', 'helpers', 'disclosure-frozen-baseline.js')).FILES;
const DEV_ONLY_PATHS = [
  'assets/js/dev-runtime.js',
  'runtime/dev-snapshot.js',
  'runtime/ib-dev-launcher.js',
  'scripts/windows/ib-dev-launcher.cmd'
];

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function gitBuffer(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'buffer', windowsHide: true });
}

function parseNulList(buffer) {
  return buffer.toString('utf8').split('\0').filter(Boolean).map(value => value.replace(/\\/g, '/'));
}

function parsePorcelainStatus(buffer) {
  const records = new Map();
  let start = 0;
  while (start < buffer.length) {
    let end = buffer.indexOf(0, start);
    if (end < 0) end = buffer.length;
    const record = buffer.subarray(start, end).toString('utf8');
    start = end + 1;
    if (record.length < 4) continue;
    const status = record.slice(0, 2);
    const rel = record.slice(3).replace(/\\/g, '/');
    records.set(rel, status);
    /* In -z porcelain, rename/copy records have a second NUL-delimited path. */
    if (status.indexOf('R') >= 0 || status.indexOf('C') >= 0) {
      const oldEnd = buffer.indexOf(0, start);
      start = oldEnd < 0 ? buffer.length : oldEnd + 1;
    }
  }
  return records;
}

function relativePath(value) {
  const rel = String(value || '').replace(/\\/g, '/');
  if (!rel || rel.startsWith('/') || /^[A-Za-z]:/.test(rel)
      || rel.split('/').some(part => part === '..' || part === '')) {
    throw new Error('unsafe snapshot-relative path: ' + rel);
  }
  return rel;
}

function underRoot(root, rel) {
  const absoluteRoot = path.resolve(root);
  const absolutePath = path.resolve(absoluteRoot, ...relativePath(rel).split('/'));
  const back = path.relative(absoluteRoot, absolutePath);
  if (!back || back === '.' || back.startsWith('..' + path.sep) || path.isAbsolute(back)) {
    if (back === '.' && rel === '') return absolutePath;
    throw new Error('snapshot path escaped its root: ' + rel);
  }
  return absolutePath;
}

function listGitFiles(root) {
  const tracked = parseNulList(gitBuffer(root, ['ls-files', '--cached', '-z']));
  const untracked = parseNulList(gitBuffer(root, ['ls-files', '--others', '--exclude-standard', '-z']));
  const status = parsePorcelainStatus(gitBuffer(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']));
  const originByPath = new Map();
  for (const rel of tracked) originByPath.set(rel, status.has(rel) ? 'tracked-modified' : 'tracked-clean');
  for (const rel of untracked) if (!originByPath.has(rel)) originByPath.set(rel, 'untracked');
  return originByPath;
}

function walkTestSupport(root, relRoot) {
  const out = [];
  const absRoot = underRoot(root, relRoot);
  if (!fs.existsSync(absRoot)) return out;
  function visit(absDir, relDir) {
    for (const entry of fs.readdirSync(absDir, { withFileTypes: true })) {
      if (entry.isDirectory() && OMIT_DIR_NAMES.has(entry.name)) continue;
      const rel = relativePath(relDir ? relDir + '/' + entry.name : entry.name);
      const abs = underRoot(root, rel);
      if (entry.isSymbolicLink()) throw new Error('test-support symlink is not allowed: ' + rel);
      if (entry.isDirectory()) {
        visit(abs, rel);
      } else if (entry.isFile() && TEST_SUPPORT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        out.push({ path: rel, origin: 'ignored-test-support', classification: 'test-support' });
      }
    }
  }
  visit(absRoot, relativePath(relRoot));
  return out;
}

function collectEntries(root) {
  const originByPath = listGitFiles(root);
  const entries = new Map();
  for (const [rel, origin] of originByPath) {
    const normalized = relativePath(rel);
    if (normalized.split('/').some(part => OMIT_DIR_NAMES.has(part))) continue;
    const abs = underRoot(root, normalized);
    let stat;
    try { stat = fs.lstatSync(abs); } catch (_) { continue; }
    if (stat.isSymbolicLink()) throw new Error('source symlink is not allowed: ' + normalized);
    if (!stat.isFile()) continue;
    entries.set(normalized, {
      path: normalized,
      origin: origin,
      classification: 'workspace-source-only'
    });
  }
  for (const supportRoot of TEST_SUPPORT_ROOTS) {
    for (const entry of walkTestSupport(root, supportRoot)) {
      if (!entries.has(entry.path)) entries.set(entry.path, entry);
    }
  }
  return Array.from(entries.values()).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

function copyRawFiles(sourceRoot, destinationRoot, entries) {
  const srcRoot = path.resolve(sourceRoot);
  const dstRoot = path.resolve(destinationRoot);
  const out = [];
  for (const entry of entries) {
    const rel = relativePath(entry.path);
    const src = underRoot(srcRoot, rel);
    const dst = underRoot(dstRoot, rel);
    const stat = fs.lstatSync(src);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('not a regular source file: ' + rel);
    const bytes = fs.readFileSync(src);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.writeFileSync(dst, bytes);
    const copied = fs.readFileSync(dst);
    const sourceHash = sha256(bytes);
    const snapshotHash = sha256(copied);
    if (bytes.length !== copied.length || !bytes.equals(copied) || sourceHash !== snapshotHash) {
      throw new Error('byte-preserving copy failed: ' + rel);
    }
    out.push({
      path: rel,
      bytes: bytes.length,
      sha256: sourceHash,
      origin: entry.origin,
      classification: entry.classification
    });
  }
  return out;
}

function verifyRawFiles(sourceRoot, destinationRoot, entries) {
  const mismatches = [];
  for (const entry of entries) {
    const rel = relativePath(entry.path);
    const src = underRoot(sourceRoot, rel);
    const dst = underRoot(destinationRoot, rel);
    if (!fs.existsSync(src) || !fs.existsSync(dst)) {
      mismatches.push({ path: rel, reason: 'missing' });
      continue;
    }
    const sourceBytes = fs.readFileSync(src);
    const copiedBytes = fs.readFileSync(dst);
    const expectedHash = entry.sha256 || sha256(sourceBytes);
    if (sourceBytes.length !== copiedBytes.length
        || !sourceBytes.equals(copiedBytes)
        || sha256(sourceBytes) !== expectedHash
        || sha256(copiedBytes) !== expectedHash) {
      mismatches.push({ path: rel, reason: 'byte-mismatch' });
    }
  }
  return mismatches;
}

function statusSnapshot(root) {
  const status = gitBuffer(root, ['status', '--short', '--untracked-files=all']);
  return {
    count: status.toString('utf8').split(/\r?\n/).filter(Boolean).length,
    sha256: sha256(status)
  };
}

function copyDisclosureFrozenBaseline(sourceRoot, evidenceRoot, head) {
  const files = DISCLOSURE_FROZEN_FILES.map(rel => {
    const bytes = gitBuffer(sourceRoot, ['show', 'HEAD:' + rel]);
    const evidencePath = 'test-baselines/disclosure/' + rel;
    const target = underRoot(evidenceRoot, evidencePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes);
    const copied = fs.readFileSync(target);
    if (!bytes.equals(copied)) throw new Error('frozen baseline evidence changed bytes: ' + rel);
    return { path: rel, evidencePath: evidencePath, bytes: bytes.length, sha256: sha256(bytes) };
  });
  return { head: head, files: files };
}

function releasePayload(workspaceRoot) {
  const manifestModule = require(path.join(workspaceRoot, 'scripts', 'release-manifest.js'));
  const resolved = manifestModule.resolve({ root: workspaceRoot });
  if (!resolved.ok) {
    throw new Error('release payload did not resolve: ' + JSON.stringify({
      missing: resolved.missing,
      denied: resolved.denied
    }));
  }
  const files = resolved.files.map(file => {
    const abs = underRoot(workspaceRoot, file.from);
    const bytes = fs.readFileSync(abs);
    if (bytes.length !== file.bytes) throw new Error('payload size changed during snapshot: ' + file.to);
    return { path: file.to, sourcePath: file.from, bytes: bytes.length, sha256: sha256(bytes), why: file.why };
  });
  const payloadPaths = new Set(files.map(file => file.path));
  const devOnlyPathsExcluded = DEV_ONLY_PATHS.filter(rel => fs.existsSync(underRoot(workspaceRoot, rel)) && !payloadPaths.has(rel));
  const devOnlyInPayload = DEV_ONLY_PATHS.filter(rel => payloadPaths.has(rel));
  if (devOnlyInPayload.length) throw new Error('Dev-only files entered release payload: ' + devOnlyInPayload.join(', '));
  return {
    fileCount: files.length,
    bytes: resolved.totalBytes,
    devOnlyPathsExcluded: devOnlyPathsExcluded,
    devOnlyInPayload: devOnlyInPayload,
    files: files
  };
}

function createSnapshot(options) {
  const opts = options || {};
  const sourceRoot = path.resolve(opts.sourceRoot || REPO_ROOT);
  const outputRoot = path.resolve(String(opts.outputRoot || ''));
  if (!opts.outputRoot) throw new Error('usage: --output <new absolute directory outside the source tree>');
  const sourceRelative = path.relative(sourceRoot, outputRoot);
  if (sourceRelative === '' || (!sourceRelative.startsWith('..' + path.sep) && sourceRelative !== '..' && !path.isAbsolute(sourceRelative))) {
    throw new Error('snapshot output must be outside the source tree');
  }
  if (fs.existsSync(outputRoot)) throw new Error('refusing to overwrite existing snapshot: ' + outputRoot);

  const entriesByPath = new Map(collectEntries(sourceRoot).map(entry => [entry.path, entry]));
  const inputStatus = statusSnapshot(sourceRoot);
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8', windowsHide: true }).trim();
  const trackedPayload = require(path.join(sourceRoot, 'scripts', 'release-manifest.js')).resolve({ root: sourceRoot });
  if (!trackedPayload.ok) throw new Error('source release payload is incomplete before snapshot creation');
  /* The production whitelist is authoritative for ignored runtime/source files
     that Git's normal source list intentionally omits (for example the bundled
     Node binary). Include those exact paths and bytes in the source snapshot. */
  for (const payloadFile of trackedPayload.files) {
    /* `from` is the repository source path; `to` may be a flattened install
       destination (for example docs/TROUBLESHOOTING.md → TROUBLESHOOTING.md). */
    const rel = relativePath(payloadFile.from);
    const entry = entriesByPath.get(rel);
    if (entry) {
      entry.classification = 'production-payload';
    } else {
      entriesByPath.set(rel, {
        path: rel,
        origin: 'ignored-production-dependency',
        classification: 'production-payload'
      });
    }
  }
  const entries = Array.from(entriesByPath.values()).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

  const workspaceRoot = path.join(outputRoot, 'workspace');
  const evidenceRoot = path.join(outputRoot, 'evidence');
  fs.mkdirSync(workspaceRoot, { recursive: true });
  fs.mkdirSync(evidenceRoot, { recursive: true });
  const disclosureBaseline = copyDisclosureFrozenBaseline(sourceRoot, evidenceRoot, head);
  const copiedFiles = copyRawFiles(sourceRoot, workspaceRoot, entries);
  const byteMismatches = verifyRawFiles(sourceRoot, workspaceRoot, copiedFiles);
  if (byteMismatches.length) throw new Error('snapshot byte verification failed: ' + JSON.stringify(byteMismatches.slice(0, 20)));

  const payload = releasePayload(workspaceRoot);
  const excluded = [
    { path: '.git', reason: 'repository metadata is not part of source payload' },
    { path: 'node_modules', reason: 'reproducible dependencies are restored by the project lockfiles' },
    { path: '.dsh-tmp', reason: 'test runtime scratch, created by tests when needed' },
    { path: 'tmp/p32-w5-r3b/**/target', reason: 'compiled test harness outputs; source and report fixtures are included' }
  ];
  const manifest = {
    schema: SNAPSHOT_SCHEMA,
    schemaVersion: 2,
    capturedAtUtc: new Date().toISOString(),
    head: head,
    originalStatusCount: inputStatus.count,
    originalStatusSha256: inputStatus.sha256,
    sourceFileCount: copiedFiles.length,
    sourceBytes: copiedFiles.reduce((sum, file) => sum + file.bytes, 0),
    bytePreservingCopy: true,
    sourceFiles: copiedFiles,
    testBaselines: { disclosureFrozenSurface: disclosureBaseline },
    excluded: excluded,
    releasePayload: payload
  };
  const manifestPath = path.join(evidenceRoot, 'release-source-snapshot.json');
  fs.writeFileSync(manifestPath, Buffer.from(JSON.stringify(manifest, null, 2) + '\n', 'utf8'));
  const writtenManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (writtenManifest.sourceFileCount !== copiedFiles.length) throw new Error('manifest readback mismatch');
  return { outputRoot: outputRoot, workspaceRoot: workspaceRoot, manifestPath: manifestPath, manifest: manifest };
}

function verifyManifest(manifestPath, sourceRoot) {
  const absManifest = path.resolve(manifestPath);
  const manifest = JSON.parse(fs.readFileSync(absManifest, 'utf8'));
  if (manifest.schema !== SNAPSHOT_SCHEMA || !Array.isArray(manifest.sourceFiles)) {
    throw new Error('unsupported source snapshot manifest');
  }
  const workspaceRoot = path.resolve(path.dirname(path.dirname(absManifest)), 'workspace');
  const evidenceRoot = path.dirname(absManifest);
  const root = path.resolve(sourceRoot || REPO_ROOT);
  const mismatches = verifyRawFiles(root, workspaceRoot, manifest.sourceFiles);
  const disclosure = manifest.testBaselines && manifest.testBaselines.disclosureFrozenSurface;
  if (disclosure && Array.isArray(disclosure.files)) {
    for (const entry of disclosure.files) {
      const baselinePath = underRoot(evidenceRoot, entry.evidencePath);
      if (!fs.existsSync(baselinePath)) {
        mismatches.push({ path: entry.path, reason: 'missing-frozen-baseline' });
        continue;
      }
      const bytes = fs.readFileSync(baselinePath);
      if (bytes.length !== entry.bytes || sha256(bytes) !== entry.sha256) {
        mismatches.push({ path: entry.path, reason: 'frozen-baseline-byte-mismatch' });
      }
    }
  }
  return { ok: mismatches.length === 0, workspaceRoot: workspaceRoot, fileCount: manifest.sourceFiles.length, mismatches: mismatches };
}

function main(argv) {
  const args = argv || process.argv.slice(2);
  const outputIndex = args.indexOf('--output');
  const verifyIndex = args.indexOf('--verify');
  if (verifyIndex >= 0) {
    const result = verifyManifest(args[verifyIndex + 1], option(args, '--root'));
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    if (!result.ok) process.exitCode = 1;
    return;
  }
  if (outputIndex < 0 || !args[outputIndex + 1]) {
    throw new Error('usage: node scripts/create-release-source-snapshot.js --output <new-absolute-directory>');
  }
  const result = createSnapshot({ outputRoot: args[outputIndex + 1], sourceRoot: option(args, '--root') || REPO_ROOT });
  process.stdout.write(JSON.stringify({
    outputRoot: result.outputRoot,
    workspaceRoot: result.workspaceRoot,
    manifestPath: result.manifestPath,
    sourceFileCount: result.manifest.sourceFileCount,
    sourceBytes: result.manifest.sourceBytes,
    releasePayloadFiles: result.manifest.releasePayload.fileCount,
    releasePayloadBytes: result.manifest.releasePayload.bytes
  }, null, 2) + '\n');
}

function option(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : '';
}

if (require.main === module) {
  try { main(process.argv.slice(2)); }
  catch (error) {
    console.error('release-source-snapshot failed: ' + String(error && error.message || error));
    process.exitCode = 1;
  }
}

module.exports = Object.freeze({
  sha256: sha256,
  copyRawFiles: copyRawFiles,
  verifyRawFiles: verifyRawFiles,
  collectEntries: collectEntries,
  createSnapshot: createSnapshot,
  verifyManifest: verifyManifest
});
