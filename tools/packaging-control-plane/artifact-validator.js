'use strict';

/* P35.3 read-only verifier. This module never builds, repairs, installs,
   restages, signs, publishes, uploads, or writes an artifact manifest. */

const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const contract = require('./contract.js');
const updateManifest = require('../../runtime/update-manifest.js');
const productVersion = require('../../runtime/product-version.js');
const peVersion = require('../../runtime/pe-version.js');
const releaseManifest = require('../../scripts/release-manifest.js');
const releaseAudit = require('../../scripts/release-audit.js');
const releaseVerify = require('../release-builder/lib/verify.js');

const RESULT_SCHEMA = 'internalbeyond.artifact-validation-result';
const OUTPUT_ROOTS = Object.freeze({ release: 'dist', test: 'tmp/installer-smoke-build' });
const ISSUED_RESULTS = new WeakMap();
const USER_DATA_PATH_RULES = Object.freeze([
  /(^|\/)\.env(?:\.[^/]*)?$/i,
  /(^|\/)credential-vault\.(?:key|json)$/i,
  /\.(?:sqlite|sqlite3|db|ibvault)$/i,
  /(^|\/)(?:appdata|indexeddb|browser-data|user-data|chat-history|chat-export|memory-data|memory-export|home-node-data)(\/|$)/i,
  /(^|\/)(?:chat-history|chat-messages|chatmessages|conversation-history|memory-export|memory-records|apiConfigs)(?:[-_.].*)?\.(?:json|jsonl|csv)$/i
]);
const NON_PRODUCTION_PATH_RULES = Object.freeze([
  /(^|\/)tools\/packaging-control-plane(\/|$)/i,
  /(^|\/)tests(\/|$)/i,
  /(^|\/)(?:tmp|logs|reports)(\/|$)/i
]);
const REVISION_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

class ValidationRequestError extends Error {
  constructor(field) {
    super('invalid validation request');
    this.field = field || '';
  }
}

function addCheck(checks, id, status, code, message, evidence) {
  const value = { id: id, status: status, code: code || null, message: message };
  if (evidence) value.evidence = { pathKind: evidence.pathKind, matchCount: evidence.matchCount };
  checks.push(value);
}

function makeResult(context, artifact, checks) {
  const summary = { pass: 0, warn: 0, fail: 0 };
  for (const item of checks) {
    if (item.status === 'PASS') summary.pass++;
    else if (item.status === 'WARN') summary.warn++;
    else if (item.status === 'FAIL') summary.fail++;
  }
  const status = summary.fail > 0 ? 'FAIL' : (summary.warn > 0 ? 'PASS_WITH_WARNINGS' : 'PASS');
  const result = {
    schema: RESULT_SCHEMA,
    schemaVersion: 1,
    status: status,
    valid: status === 'PASS',
    artifact: artifact || { name: '', size: 0, sha256: '' },
    context: context || { target: 'windows-installer', version: '', mode: 'release', revision: 'unknown', dirty: null },
    checks: checks,
    summary: summary
  };
  /* A process-local, non-serialized issuance marker lets the later Manifest
     Writer distinguish this exact Validator object from caller-shaped JSON.
     The snapshot also detects mutation after validation. */
  ISSUED_RESULTS.set(result, JSON.stringify(result));
  return result;
}

function isIssuedValidationResult(value) {
  if (!value || typeof value !== 'object' || !ISSUED_RESULTS.has(value)) return false;
  try { return JSON.stringify(value) === ISSUED_RESULTS.get(value); }
  catch (_) { return false; }
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function onlyFields(value, allowed, field) {
  if (!isPlainObject(value)) throw new ValidationRequestError(field);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = typeof key === 'string' ? Object.getOwnPropertyDescriptor(value, key) : null;
    if (typeof key !== 'string' || !allowed.has(key) || !descriptor ||
        !Object.prototype.hasOwnProperty.call(descriptor, 'value') || !descriptor.enumerable) {
      throw new ValidationRequestError(field + '.' + String(key));
    }
  }
}

function validateRequest(request) {
  onlyFields(request, new Set(['job', 'artifact', 'buildContext']), 'request');
  if (!Object.prototype.hasOwnProperty.call(request, 'job') ||
      !Object.prototype.hasOwnProperty.call(request, 'artifact')) throw new ValidationRequestError('request');

  let job;
  try { job = contract.validatePackagingJob(request.job); }
  catch (_) { throw new ValidationRequestError('job'); }
  if (job.target !== 'windows-installer' || !['release', 'test'].includes(job.mode)) {
    throw new ValidationRequestError('job.target/mode');
  }
  onlyFields(request.artifact, new Set(['path']), 'artifact');
  if (typeof request.artifact.path !== 'string' || request.artifact.path.length === 0 || request.artifact.path.length > 512) {
    throw new ValidationRequestError('artifact.path');
  }

  let buildContext = { revision: 'unknown', dirty: null, supplied: false };
  if (request.buildContext !== undefined && request.buildContext !== null) {
    onlyFields(request.buildContext, new Set(['revision', 'dirty']), 'buildContext');
    const revision = request.buildContext.revision;
    const dirty = request.buildContext.dirty;
    if (revision !== undefined && revision !== '' &&
        (typeof revision !== 'string' || !REVISION_RE.test(revision))) throw new ValidationRequestError('buildContext.revision');
    if (dirty !== undefined && dirty !== null && typeof dirty !== 'boolean') throw new ValidationRequestError('buildContext.dirty');
    buildContext = {
      revision: typeof revision === 'string' && REVISION_RE.test(revision) ? revision.toLowerCase() : 'unknown',
      dirty: typeof dirty === 'boolean' ? dirty : null,
      supplied: typeof revision === 'string' && REVISION_RE.test(revision) && typeof dirty === 'boolean'
    };
  }
  return { job: job, artifactPath: request.artifact.path, buildContext: buildContext };
}

function within(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
}

function sameCanonicalPath(left, right) {
  const normalize = function (value) {
    let result = path.resolve(value).replace(/^\\\\\?\\/, '').replace(/[\\/]+$/, '');
    if (process.platform === 'win32') result = result.toLowerCase();
    return result;
  };
  return normalize(left) === normalize(right);
}

function validateRelativeArtifactPath(relative, outputRoot) {
  if (typeof relative !== 'string' || !relative || relative.indexOf('\0') >= 0 ||
      relative.indexOf('\\') >= 0 || relative.indexOf(':') >= 0 ||
      path.posix.isAbsolute(relative) || path.win32.isAbsolute(relative)) return { ok: false };
  const parts = relative.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..') || path.posix.normalize(relative) !== relative) {
    return { ok: false };
  }
  const rootParts = outputRoot.split('/');
  if (parts.length !== rootParts.length + 1 ||
      rootParts.some((part, index) => parts[index].toLowerCase() !== part.toLowerCase())) return { ok: false };
  return { ok: true, basename: parts[parts.length - 1] };
}

function resolveNoLinks(repoRoot, relative, finalType) {
  let rootReal;
  try { rootReal = fs.realpathSync.native ? fs.realpathSync.native(repoRoot) : fs.realpathSync(repoRoot); }
  catch (_) { return { ok: false, code: 'ARTIFACT_OUTSIDE_ALLOWED_ROOT', missing: false }; }
  let current = rootReal;
  const parts = relative.split('/');
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    let stat;
    try { stat = fs.lstatSync(current); }
    catch (e) {
      if (e && e.code === 'ENOENT') return { ok: false, code: 'ARTIFACT_NOT_FOUND', missing: true };
      return { ok: false, code: 'ARTIFACT_OUTSIDE_ALLOWED_ROOT', missing: false };
    }
    if (stat.isSymbolicLink() || (i === parts.length - 1 && stat.isFile() && stat.nlink > 1)) {
      return { ok: false, code: 'ARTIFACT_OUTSIDE_ALLOWED_ROOT', missing: false };
    }
    if (i < parts.length - 1 && !stat.isDirectory()) return { ok: false, code: 'ARTIFACT_OUTSIDE_ALLOWED_ROOT', missing: false };
    if (i === parts.length - 1 && finalType === 'file' && !stat.isFile()) {
      return { ok: false, code: 'ARTIFACT_NOT_REGULAR_FILE', missing: false };
    }
    if (i === parts.length - 1 && finalType === 'directory' && !stat.isDirectory()) {
      return { ok: false, code: 'PAYLOAD_VALIDATION_FAILED', missing: false };
    }
    let real;
    try { real = fs.realpathSync.native ? fs.realpathSync.native(current) : fs.realpathSync(current); }
    catch (_) { return { ok: false, code: 'ARTIFACT_OUTSIDE_ALLOWED_ROOT', missing: false };
    }
    if (!within(rootReal, real) || !sameCanonicalPath(current, real)) {
      return { ok: false, code: 'ARTIFACT_OUTSIDE_ALLOWED_ROOT', missing: false };
    }
  }
  return { ok: true, path: current, rootReal: rootReal, stat: fs.lstatSync(current) };
}

function safeReadRelative(directory, name) {
  if (typeof name !== 'string' || name.indexOf('/') >= 0 || name.indexOf('\\') >= 0 || name === '.' || name === '..') {
    return { ok: false, missing: false, unsafe: true };
  }
  let rootReal;
  try { rootReal = fs.realpathSync.native ? fs.realpathSync.native(directory) : fs.realpathSync(directory); }
  catch (_) { return { ok: false, missing: true }; }
  if (!sameCanonicalPath(directory, rootReal)) return { ok: false, missing: false, unsafe: true };
  const absolute = path.join(rootReal, name);
  let stat;
  try { stat = fs.lstatSync(absolute); }
  catch (e) { return { ok: false, missing: !!(e && e.code === 'ENOENT') }; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1) return { ok: false, missing: false, unsafe: true };
  try {
    const real = fs.realpathSync.native ? fs.realpathSync.native(absolute) : fs.realpathSync(absolute);
    if (!within(rootReal, real) || !sameCanonicalPath(absolute, real)) return { ok: false, missing: false, unsafe: true };
    return { ok: true, text: fs.readFileSync(real, 'utf8'), path: real };
  } catch (_) { return { ok: false, missing: false }; }
}

function readRepoText(root, relative) {
  const safe = resolveNoLinks(root, relative, 'file');
  if (!safe.ok) return null;
  try { return fs.readFileSync(safe.path, 'utf8'); } catch (_) { return null; }
}

function readDefine(source, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp('^\\s*#define\\s+' + escaped + '\\s+"([^"]+)"\\s*$', 'm').exec(source);
  return match ? match[1] : '';
}

function parseGuid(source, name) {
  const raw = readDefine(source, name);
  const match = /^\{\{([0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12})\}$/.exec(raw);
  return match ? match[1].toUpperCase() : '';
}

function readInstallerIdentity(source) {
  const output = /^\s*OutputBaseFilename\s*=\s*(.*?)\s*$/im.exec(source);
  return {
    ok: !!output,
    productionAppId: parseGuid(source, 'ProductionAppId'),
    testAppId: parseGuid(source, 'TestOnlyAppId'),
    productionName: readDefine(source, 'ProductionAppName'),
    testName: readDefine(source, 'TestOnlyAppName'),
    productionInstall: readDefine(source, 'ProductionInstallDirectoryName'),
    testInstall: readDefine(source, 'TestOnlyInstallDirectoryName'),
    productionBase: readDefine(source, 'ProductionOutputBaseName'),
    testBase: readDefine(source, 'TestOnlyOutputBaseName'),
    outputTemplate: output ? output[1] : ''
  };
}

function expectedInstallerName(root, mode, version, update) {
  const iss = readRepoText(root, 'installer/InternalBeyond.iss');
  if (!iss) return { ok: false, code: 'VERSION_METADATA_UNAVAILABLE' };
  const identity = readInstallerIdentity(iss);
  const baseName = mode === 'test' ? identity.testBase : identity.productionBase;
  if (!identity.ok || !baseName || !version) return { ok: false, code: 'VERSION_METADATA_UNAVAILABLE', identity: identity };
  const expanded = identity.outputTemplate
    .replace(/\{#OutputBaseName\}/g, baseName)
    .replace(/\{#AppVersion\}/g, version);
  if (/\{#[^}]+\}/.test(expanded) || /[\\/:]/.test(expanded)) {
    return { ok: false, code: 'VERSION_METADATA_UNAVAILABLE', identity: identity };
  }
  const compiledName = /\.exe$/i.test(expanded) ? expanded : expanded + '.exe';
  const expected = mode === 'release' ? update.installerAssetName(version) : compiledName;
  if (compiledName !== expected) return { ok: false, code: 'ARTIFACT_FILENAME_MISMATCH', identity: identity };
  return { ok: true, name: expected, identity: identity };
}

function expectedArtifactName(root, mode, version) {
  const naming = expectedInstallerName(root, mode, version, updateManifest);
  return naming.ok ? { ok: true, name: naming.name } : { ok: false, code: naming.code || 'VERSION_METADATA_UNAVAILABLE' };
}

/* Shared read-only identity measurement used by the Executor before and after
   validation. It returns only a canonical relative path and artifact identity. */
function measureArtifactIdentity(root, mode, version, adapters) {
  const outputRoot = OUTPUT_ROOTS[mode];
  const naming = expectedArtifactName(root, mode, version);
  if (!outputRoot || !naming.ok) return { ok: false, code: naming.code || 'ARTIFACT_FILENAME_MISMATCH' };
  const relativePath = outputRoot + '/' + naming.name;
  const safe = resolveNoLinks(root, relativePath, 'file');
  if (!safe.ok) return { ok: false, code: safe.code || 'ARTIFACT_NOT_FOUND' };
  if (safe.stat.size > updateManifest.MAX_PLAUSIBLE_INSTALLER_BYTES) {
    return { ok: false, code: 'ARTIFACT_SIZE_INVALID' };
  }
  const hashFile = adapters && typeof adapters.sha256File === 'function' ? adapters.sha256File : releaseVerify.sha256File;
  try {
    const sha256 = String(hashFile(safe.path)).toLowerCase();
    const after = fs.lstatSync(safe.path);
    if (after.isSymbolicLink() || after.size !== safe.stat.size || after.mtimeMs !== safe.stat.mtimeMs || after.nlink > 1 ||
        !/^[0-9a-f]{64}$/.test(sha256)) {
      return { ok: false, code: 'ARTIFACT_HASH_FAILED' };
    }
    return {
      ok: true,
      relativePath: relativePath,
      identity: { name: naming.name, size: safe.stat.size, sha256: sha256 }
    };
  } catch (_) { return { ok: false, code: 'ARTIFACT_HASH_FAILED' }; }
}

function safeInventory(directory) {
  const files = [];
  const rootReal = fs.realpathSync.native ? fs.realpathSync.native(directory) : fs.realpathSync(directory);
  function walk(current, relative) {
    const names = fs.readdirSync(current).sort();
    for (const name of names) {
      const absolute = path.join(current, name);
      const rel = relative ? relative + '/' + name : name;
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink > 1)) {
        const error = new Error('unsafe staging entry');
        error.code = 'ARTIFACT_OUTSIDE_ALLOWED_ROOT';
        throw error;
      }
      const real = fs.realpathSync.native ? fs.realpathSync.native(absolute) : fs.realpathSync(absolute);
      if (!within(rootReal, real) || !sameCanonicalPath(absolute, real)) {
        const error = new Error('staging reparse point');
        error.code = 'ARTIFACT_OUTSIDE_ALLOWED_ROOT';
        throw error;
      }
      if (stat.isDirectory()) walk(absolute, rel);
      else if (stat.isFile()) files.push({ path: rel, absolute: absolute, size: stat.size });
      else {
        const error = new Error('non-regular staging entry');
        error.code = 'PAYLOAD_VALIDATION_FAILED';
        throw error;
      }
    }
  }
  walk(directory, '');
  return files.sort((a, b) => a.path.toLowerCase().localeCompare(b.path.toLowerCase()));
}

function canonicalRelative(value) {
  if (typeof value !== 'string' || !value || value.indexOf('\\') >= 0 ||
      value.indexOf('\0') >= 0 || value.indexOf(':') >= 0 || value.startsWith('/')) return false;
  const parts = value.split('/');
  return parts.every((part) => part && part !== '.' && part !== '..') && path.posix.normalize(value) === value;
}

function stageUserDataMatches(relative) {
  return USER_DATA_PATH_RULES.some((pattern) => pattern.test(relative));
}

function compareSets(left, right) {
  const a = left.map((x) => String(x).toLowerCase()).sort();
  const b = right.map((x) => String(x).toLowerCase()).sort();
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

function parsePayloadManifest(files, version) {
  const entry = files.find((item) => item.path.toLowerCase() === 'ib-payload-manifest.json');
  if (!entry) return { ok: false, files: [] };
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(entry.absolute, 'utf8').replace(/^\uFEFF/, '')); }
  catch (_) { return { ok: false, files: [] }; }
  if (!manifest || manifest.schema !== 'internalbeyond.payload-manifest' || manifest.version !== 1 ||
      manifest.product !== version || manifest.generated !== 'scripts/build-installer.ps1' ||
      !Array.isArray(manifest.files) || manifest.count !== manifest.files.length ||
      !manifest.files.every(canonicalRelative) || !compareSets(manifest.files, files.map((item) => item.path))) {
    return { ok: false, files: [] };
  }
  return { ok: true, files: manifest.files, manifest: manifest };
}

function buildGeneratedFiles(root) {
  const script = readRepoText(root, 'scripts/build-installer.ps1');
  if (!script) return null;
  const names = Array.from(script.matchAll(/\$payloadFiles\s*\+=\s*'([^']+)'/g)).map((match) => match[1]);
  return names.length && names.every(canonicalRelative) ? names : null;
}

function scanSafeStaging(stageRoot, files) {
  const findings = [];
  const violations = [];
  let readme = null;
  let version = null;
  for (const file of files) {
    const stat = fs.lstatSync(file.absolute);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink > 1) {
      const error = new Error('staging changed during validation');
      error.code = 'ARTIFACT_OUTSIDE_ALLOWED_ROOT';
      throw error;
    }
    const real = fs.realpathSync.native ? fs.realpathSync.native(file.absolute) : fs.realpathSync(file.absolute);
    if (!sameCanonicalPath(file.absolute, real) || !within(stageRoot, real)) {
      const error = new Error('staging entry escaped its root');
      error.code = 'ARTIFACT_OUTSIDE_ALLOWED_ROOT';
      throw error;
    }
    const bytes = fs.readFileSync(real);
    const after = fs.lstatSync(file.absolute);
    if (after.isSymbolicLink() || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.nlink > 1) {
      const error = new Error('staging changed while being scanned');
      error.code = 'ARTIFACT_OUTSIDE_ALLOWED_ROOT';
      throw error;
    }
    /* VERSION is intentionally extensionless but remains canonical text input
       to release-audit's README/version claim gate. */
    if (releaseManifest.isTextFile(file.path) || file.path.toLowerCase() === 'version') {
      const text = bytes.toString('utf8');
      releaseAudit.scanText(file.path, text, findings);
      if (file.path === 'README.md') readme = text;
      if (file.path === 'VERSION') version = text.trim();
    }
    releaseAudit.scanMarkers(file.path, bytes, findings);
    for (const rule of releaseManifest.DENY_PATH) {
      rule.test.lastIndex = 0;
      if (rule.test.test(file.path)) {
        violations.push({ path: file.path, why: rule.why });
        break;
      }
    }
  }
  releaseAudit.scanReleaseClaimsText(readme, version, findings);
  const errors = findings.filter((item) => item.severity === 'error');
  const warnings = findings.filter((item) => item.severity === 'warn');
  return {
    ok: errors.length === 0 && violations.length === 0,
    files: files.length,
    findings: findings,
    violations: violations,
    errors: errors.length,
    warnings: warnings.length
  };
}

function currentGitState(root) {
  try {
    const env = {};
    for (const key of ['PATH', 'PATHEXT', 'SystemRoot', 'windir', 'TEMP', 'TMP', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH']) {
      if (Object.prototype.hasOwnProperty.call(process.env, key)) env[key] = process.env[key];
    }
    env.GIT_OPTIONAL_LOCKS = '0';
    const head = childProcess.spawnSync('git', ['-C', root, 'rev-parse', 'HEAD'], {
      cwd: root, env: env, encoding: 'utf8', windowsHide: true, timeout: 5000, maxBuffer: 1024 * 1024
    });
    const status = childProcess.spawnSync('git', ['-C', root, 'status', '--porcelain=v1', '--untracked-files=normal'], {
      cwd: root, env: env, encoding: 'utf8', windowsHide: true, timeout: 10000, maxBuffer: 4 * 1024 * 1024
    });
    const revision = String(head.stdout || '').trim().toLowerCase();
    if (head.status !== 0 || status.status !== 0 || !REVISION_RE.test(revision)) return { ok: false };
    return { ok: true, revision: revision, dirty: String(status.stdout || '').trim().length > 0 };
  } catch (_) { return { ok: false }; }
}

/* release-manifest.resolve() follows linked directories while enumerating
   whitelist roots. Refuse that provenance check before calling it so a link in
   a source tree can never make the Validator enumerate a user-data directory. */
function manifestInputsUnsafe(root) {
  let rootReal;
  try { rootReal = fs.realpathSync.native ? fs.realpathSync.native(root) : fs.realpathSync(root); }
  catch (_) { return true; }
  function checkDirectory(directory) {
    let names;
    try { names = fs.readdirSync(directory); } catch (_) { return true; }
    for (const name of names) {
      const child = path.join(directory, name);
      let stat;
      try { stat = fs.lstatSync(child); } catch (_) { return true; }
      if (stat.isSymbolicLink()) return true;
      let real;
      try { real = fs.realpathSync.native ? fs.realpathSync.native(child) : fs.realpathSync(child); }
      catch (_) { return true; }
      if (!within(rootReal, real) || !sameCanonicalPath(child, real)) return true;
      if (stat.isDirectory() && checkDirectory(child)) return true;
    }
    return false;
  }
  for (const entry of releaseManifest.ENTRIES || []) {
    const relative = String(entry.from || '').replace(/[\\/]+/g, path.sep);
    if (!relative || path.isAbsolute(relative) || relative.split(path.sep).some((part) => part === '..')) return true;
    let current = rootReal;
    let stat = null;
    for (const part of relative.split(path.sep)) {
      current = path.join(current, part);
      try { stat = fs.lstatSync(current); }
      catch (error) {
        if (error && error.code === 'ENOENT') { stat = null; break; }
        return true;
      }
      if (stat.isSymbolicLink()) return true;
      let real;
      try { real = fs.realpathSync.native ? fs.realpathSync.native(current) : fs.realpathSync(current); }
      catch (_) { return true; }
      if (!within(rootReal, real) || !sameCanonicalPath(current, real)) return true;
    }
    if (stat && stat.isDirectory() && checkDirectory(current)) return true;
  }
  return false;
}

function currentDeveloperPathMarkers(root, additional) {
  const values = [root, os.homedir(), os.tmpdir()];
  for (const key of ['USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP']) {
    if (process.env[key]) values.push(process.env[key]);
  }
  if (Array.isArray(additional)) values.push.apply(values, additional);
  const result = new Set();
  for (const value of values) {
    if (typeof value !== 'string' || value.length < 8) continue;
    const normalized = value.replace(/^\\\\\?\\/, '').replace(/[\\/]+$/, '');
    if (normalized.length < 8) continue;
    result.add(normalized.toLowerCase());
    result.add(normalized.replace(/\\/g, '/').toLowerCase());
    result.add(normalized.replace(/\//g, '\\').toLowerCase());
  }
  return Array.from(result);
}

function scanDynamicPaths(files, root, additionalPaths) {
  const markers = currentDeveloperPathMarkers(root, additionalPaths);
  let matches = 0;
  for (const file of files) {
    if (!releaseManifest.isTextFile(file.path)) continue;
    let body;
    try { body = fs.readFileSync(file.absolute, 'utf8').toLowerCase(); }
    catch (_) { matches++; continue; }
    if (markers.some((marker) => marker && body.indexOf(marker) >= 0)) matches++;
  }
  return matches;
}

function compileEvidence(text, stageRoot, stageFiles, mode, identity) {
  const source = String(text || '');
  const identityLine = source.split(/\r?\n/).find((line) => /^compile identity\s*:/i.test(line)) || '';
  const expectedAppId = mode === 'test' ? identity.testAppId : identity.productionAppId;
  const defineOk = mode === 'test' ? /InstallerTestMode\s*=\s*1/i.test(identityLine) : /InstallerTestMode absent/i.test(identityLine);
  const appIdOk = !!expectedAppId && identityLine.toUpperCase().includes('{' + expectedAppId + '}');
  const compressed = new Set();
  let sawLine = false;
  let outsideCount = 0;
  for (const line of source.split(/\r?\n/)) {
    const match = /^\s*Compressing:\s*(.*?)\s*$/i.exec(line);
    if (!match) continue;
    sawLine = true;
    const entry = match[1].replace(/^"|"$/g, '');
    let relative = '';
    if (path.isAbsolute(entry) || path.win32.isAbsolute(entry)) {
      const absolute = path.resolve(entry);
      if (within(path.resolve(stageRoot), absolute)) relative = path.relative(path.resolve(stageRoot), absolute).split(path.sep).join('/');
      else outsideCount++;
    } else {
      const normalized = entry.replace(/\\/g, '/');
      const marker = '/staging/';
      const at = normalized.toLowerCase().lastIndexOf(marker);
      if (at >= 0) relative = normalized.slice(at + marker.length);
      else if (normalized.toLowerCase().startsWith('staging/')) relative = normalized.slice('staging/'.length);
      else outsideCount++;
    }
    if (relative && canonicalRelative(relative)) compressed.add(relative.toLowerCase());
  }
  const expected = new Set(stageFiles.map((file) => file.path.toLowerCase()));
  const missingCount = Array.from(expected).filter((name) => !compressed.has(name)).length;
  outsideCount += Array.from(compressed).filter((name) => !expected.has(name)).length;
  return {
    identityFound: !!identityLine,
    identityMatches: !!identityLine && defineOk && appIdOk,
    compressionFound: sawLine,
    compressionMatches: sawLine && missingCount === 0 && outsideCount === 0,
    missingCount: missingCount,
    outsideCount: outsideCount
  };
}

function parseReleaseBuilderEvidence(evidenceFiles, version, artifactName, sha, size, buildContext) {
  const log = evidenceFiles.log;
  const jsonl = evidenceFiles.jsonl;
  if ((log && log.unsafe) || (jsonl && jsonl.unsafe)) {
    return { status: 'FAIL', code: 'ARTIFACT_OUTSIDE_ALLOWED_ROOT', message: 'Release Builder evidence is a link or outside the output root.' };
  }
  if (!log || !log.ok || !jsonl || !jsonl.ok) {
    return { status: 'WARN', code: 'PROVENANCE_INCOMPLETE', message: 'Release Builder SEAL log is unavailable; source revision is not bound to this artifact.' };
  }
  const field = function (label) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = new RegExp('^' + escaped + '\\s*:\\s*(.*?)\\s*$', 'mi').exec(log.text);
    return match ? match[1] : '';
  };
  let events;
  try { events = jsonl.text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line)); }
  catch (_) { return { status: 'FAIL', code: 'BUILD_METADATA_MISMATCH', message: 'Release Builder machine log is malformed.' };
  }
  const evidenceRevision = field('repo commit').toLowerCase();
  const contextRevision = buildContext && REVISION_RE.test(String(buildContext.revision || ''))
    ? String(buildContext.revision).toLowerCase() : '';
  if (!REVISION_RE.test(evidenceRevision) ||
      (contextRevision && evidenceRevision !== contextRevision) ||
      field('target ver') !== version || field('channel') !== 'stable' ||
      field('mode') !== 'REAL' || !['SEALED', 'PUBLISHED'].includes(field('status'))) {
    return { status: 'FAIL', code: 'BUILD_METADATA_MISMATCH', message: 'Release Builder log header disagrees with the requested build context.' };
  }
  const items = new Map(events.filter((item) => item && item.kind === 'item' && typeof item.key === 'string')
    .map((item) => [item.key, item]));
  const artifactItem = items.get('SEAL:reread-exists');
  const artifactBound = !!artifactItem && artifactItem.status === 'ok' &&
    String(artifactItem.actual).toLowerCase() === sha &&
    String(artifactItem.expected || '').startsWith(artifactName + ' · ' + size + ' B');
  const equations = [
    ['SEAL:three-way:exe.sha256 == SHA256SUMS.sha256', sha],
    ['SEAL:three-way:exe.sha256 == manifest.installer.sha256', sha],
    ['SEAL:three-way:exe.bytes == manifest.installer.sizeBytes', String(size)],
    ['SEAL:three-way:manifest.version == target', version],
    ['SEAL:three-way:manifest.installer.productVersion == target', version]
  ];
  const equationsBound = equations.every(([key, expected]) => {
    const item = items.get(key);
    return !!item && item.status === 'ok' && String(item.expected) === expected && String(item.actual) === expected;
  });
  if (!artifactBound || !equationsBound) {
    return { status: 'FAIL', code: 'BUILD_METADATA_MISMATCH', message: 'Release Builder SEAL log does not reconcile the artifact bytes and release metadata.' };
  }
  const tracked = items.get('CHECK:git-clean');
  const untracked = items.get('CHECK:git-untracked');
  if (!tracked || !['ok', 'warn'].includes(tracked.status)) {
    return { status: 'WARN', code: 'PROVENANCE_INCOMPLETE', message: 'SEAL evidence has no usable build-time tracked-worktree state.' };
  }
  const observedDirty = tracked.status === 'warn' || !!(untracked && untracked.status === 'warn');
  if (typeof (buildContext && buildContext.dirty) === 'boolean' && buildContext.dirty !== observedDirty) {
    return { status: 'FAIL', code: 'BUILD_METADATA_MISMATCH', message: 'Release Builder dirty-state evidence disagrees with buildContext.dirty.' };
  }
  if (observedDirty) {
    return { status: 'WARN', code: 'PROVENANCE_INCOMPLETE', message: 'Release Builder evidence binds this artifact to a dirty source snapshot.' };
  }
  if (!contextRevision || typeof (buildContext && buildContext.dirty) !== 'boolean') {
    return { status: 'WARN', code: 'PROVENANCE_INCOMPLETE', message: 'Release Builder evidence reconciles artifact bytes, but the caller supplied no complete build-time revision/dirty context.' };
  }
  return { status: 'PASS', code: null, message: 'Release Builder SEAL evidence binds revision, artifact hash/size and version equations.' };
}

function sidecarRead(adapters, root, outputRoot, name) {
  const directory = resolveNoLinks(root, outputRoot, 'directory');
  if (!directory.ok) return { ok: false, missing: directory.missing, unsafe: !directory.missing };
  return adapters.readOutputFile(directory.path, name);
}

function validateShaSums(text, name, sha) {
  if (typeof text !== 'string') return { status: 'WARN', code: 'BUILD_METADATA_UNAVAILABLE', message: 'SHA256SUMS.txt is unavailable.' };
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp('^([0-9a-fA-F]{64})\\s+\\*?' + escaped + '\\s*$');
  const line = text.split(/\r?\n/).find((item) => regex.test(item));
  if (!line) return { status: 'FAIL', code: 'ARTIFACT_HASH_FAILED', message: 'SHA256SUMS.txt has no digest line for this artifact.' };
  const sum = regex.exec(line)[1].toLowerCase();
  if (sum !== sha) return { status: 'FAIL', code: 'ARTIFACT_HASH_FAILED', message: 'SHA256SUMS.txt digest does not match the artifact bytes.' };
  return { status: 'PASS', code: null, message: 'SHA256SUMS.txt digest matches the artifact bytes.' };
}

function validatePeVersion(file, expectedVersion, adapters, checks) {
  if (!expectedVersion) {
    addCheck(checks, 'installer-pe-version', 'WARN', 'VERSION_METADATA_UNAVAILABLE', 'No expected version is available for PE comparison.');
    return;
  }
  let result;
  try { result = adapters.readPeVersion(file, expectedVersion); }
  catch (_) { result = null; }
  const read = result && result.read;
  if (!result || !read || read.ok !== true || !read.productVersion ||
      !read.productVersionFixed || !read.fileVersionFixed) {
    addCheck(checks, 'installer-pe-version', 'WARN', 'VERSION_METADATA_UNAVAILABLE', 'Installer PE version metadata could not be read completely; no version match is claimed.');
    return;
  }
  if (!result.ok) {
    addCheck(checks, 'installer-pe-version', 'FAIL', 'VERSION_MISMATCH', 'Installer ProductVersion or fixed PE version does not match PackagingJob.version.');
    return;
  }
  addCheck(checks, 'installer-pe-version', 'PASS', null, 'Installer ProductVersion and fixed PE version match the requested version.');
}

function validateBuildSidecars(root, outputRoot, job, version, artifact, identity, adapters, checks) {
  const sums = sidecarRead(adapters, root, outputRoot, 'SHA256SUMS.txt');
  if (sums && sums.unsafe) {
    addCheck(checks, 'sha256-sums', 'FAIL', 'ARTIFACT_OUTSIDE_ALLOWED_ROOT', 'SHA256SUMS.txt is a link or is outside the output root.');
  } else {
    const sumsResult = validateShaSums(sums && sums.ok ? sums.text : null, artifact.name, artifact.sha256);
    addCheck(checks, 'sha256-sums', sumsResult.status, sumsResult.code, sumsResult.message);
  }

  const compile = sidecarRead(adapters, root, outputRoot, 'build-compile.log');
  if (compile && compile.unsafe) {
    addCheck(checks, 'inno-compile-identity', 'FAIL', 'ARTIFACT_OUTSIDE_ALLOWED_ROOT', 'Compiler log is a link or is outside the output root.');
  } else if (!compile || !compile.ok) {
    addCheck(checks, 'inno-compile-identity', 'WARN', 'BUILD_METADATA_UNAVAILABLE', 'Canonical Inno compile log is unavailable; compiled AppId evidence is incomplete.');
  } else {
    const expectedId = job.mode === 'test' ? identity.testAppId : identity.productionAppId;
    const line = compile.text.split(/\r?\n/).find((item) => /^compile identity\s*:/i.test(item)) || '';
    const modeOk = job.mode === 'test' ? /InstallerTestMode\s*=\s*1/i.test(line) : /InstallerTestMode absent/i.test(line);
    const idOk = !!expectedId && line.toUpperCase().includes('{' + expectedId + '}');
    if (!line || !modeOk || !idOk) {
      addCheck(checks, 'inno-compile-identity', 'FAIL', 'BUILD_METADATA_MISMATCH', 'Compile log does not prove the expected Inno identity and build mode.');
    } else {
      addCheck(checks, 'inno-compile-identity', 'PASS', null, 'Compile log records the expected Inno identity and build mode.');
    }
  }

  if (job.mode === 'release') {
    const stable = sidecarRead(adapters, root, outputRoot, 'update-stable.json');
    if (stable && stable.unsafe) {
      addCheck(checks, 'canonical-update-metadata', 'FAIL', 'ARTIFACT_OUTSIDE_ALLOWED_ROOT', 'update-stable.json is a link or is outside the output root.');
      return;
    }
    if (!stable || !stable.ok) {
      addCheck(checks, 'canonical-update-metadata', 'WARN', 'VERSION_METADATA_UNAVAILABLE', 'update-stable.json is unavailable; installer metadata cannot be cross-checked.');
      return;
    }
    let manifest;
    try { manifest = JSON.parse(stable.text.replace(/^\uFEFF/, '')); }
    catch (_) {
      addCheck(checks, 'canonical-update-metadata', 'FAIL', 'BUILD_METADATA_MISMATCH', 'update-stable.json is not valid JSON.');
      return;
    }
    const report = updateManifest.validate(manifest);
    if (!report.ok) {
      addCheck(checks, 'canonical-update-metadata', 'FAIL', 'BUILD_METADATA_MISMATCH', 'update-stable.json fails the canonical update-manifest validator.');
      return;
    }
    const installer = manifest.installer || {};
    let mismatch = false;
    if (version && (manifest.version !== version || installer.productVersion !== version)) {
      addCheck(checks, 'build-metadata-version', 'FAIL', 'VERSION_MISMATCH', 'update-stable.json version fields disagree with PackagingJob.version.');
      mismatch = true;
    } else if (!version) {
      addCheck(checks, 'build-metadata-version', 'WARN', 'VERSION_METADATA_UNAVAILABLE', 'No canonical version is available to compare with update-stable.json.');
    } else if (version) {
      addCheck(checks, 'build-metadata-version', 'PASS', null, 'update-stable.json version fields match PackagingJob.version.');
    }
    if (String(installer.sha256 || '').toLowerCase() !== artifact.sha256) {
      addCheck(checks, 'build-metadata-sha256', 'FAIL', 'ARTIFACT_HASH_FAILED', 'update-stable.json SHA-256 does not match the final artifact bytes.');
      mismatch = true;
    } else {
      addCheck(checks, 'build-metadata-sha256', 'PASS', null, 'update-stable.json SHA-256 matches the final artifact bytes.');
    }
    if (Number(installer.sizeBytes) !== artifact.size) {
      addCheck(checks, 'build-metadata-size', 'FAIL', 'BUILD_METADATA_MISMATCH', 'update-stable.json sizeBytes does not match the final artifact.');
      mismatch = true;
    } else {
      addCheck(checks, 'build-metadata-size', 'PASS', null, 'update-stable.json sizeBytes matches the final artifact.');
    }
    const parsedUrl = updateManifest.parseInstallerUrl(installer.url);
    if (!parsedUrl.ok || parsedUrl.asset !== artifact.name) {
      addCheck(checks, 'build-metadata-filename', 'FAIL', 'ARTIFACT_FILENAME_MISMATCH', 'Canonical installer URL does not name this artifact.');
      mismatch = true;
    } else {
      addCheck(checks, 'build-metadata-filename', 'PASS', null, 'Canonical installer URL names this artifact.');
    }
    if (!mismatch) addCheck(checks, 'canonical-update-metadata', 'PASS', null, 'Canonical update metadata validates and matches the artifact.');
    return;
  }

  const stable = sidecarRead(adapters, root, outputRoot, 'update-stable.json');
  if (stable && stable.unsafe) {
    addCheck(checks, 'test-mode-stable-manifest', 'FAIL', 'ARTIFACT_OUTSIDE_ALLOWED_ROOT', 'Test output update-stable.json is a link or outside the output root.');
  } else if (stable && stable.ok) {
    addCheck(checks, 'test-mode-stable-manifest', 'FAIL', 'BUILD_METADATA_MISMATCH', 'Test-mode output must not contain update-stable.json.');
  } else {
    addCheck(checks, 'test-mode-stable-manifest', 'PASS', null, 'Test-mode output has no Stable update manifest.');
  }
  const testEvidence = sidecarRead(adapters, root, outputRoot, 'installer-test-identity.json');
  if (testEvidence && testEvidence.unsafe) {
    addCheck(checks, 'test-installer-identity', 'FAIL', 'ARTIFACT_OUTSIDE_ALLOWED_ROOT', 'Test identity evidence is a link or is outside the output root.');
    return;
  }
  if (!testEvidence || !testEvidence.ok) {
    addCheck(checks, 'test-installer-identity', 'FAIL', 'BUILD_METADATA_MISMATCH', 'Test-mode installer identity evidence is missing.');
    return;
  }
  let evidence;
  try { evidence = JSON.parse(testEvidence.text); }
  catch (_) { evidence = null; }
  const valid = !!evidence && evidence.testOnly === true &&
    evidence.appId === '{' + identity.testAppId + '}' &&
    evidence.productionAppId === '{' + identity.productionAppId + '}' &&
    evidence.resolvedAppId === '{' + identity.testAppId + '}' &&
    evidence.appName === identity.testName &&
    evidence.installDirectoryName === identity.testInstall &&
    evidence.hostVersion === version &&
    evidence.artifact === artifact.name &&
    String(evidence.sha256 || '').toLowerCase() === artifact.sha256 &&
    evidence.compilerDefine === 'InstallerTestMode=1' &&
    Array.isArray(evidence.compilerArgs) && evidence.compilerArgs.includes('/DInstallerTestMode=1') &&
    evidence.source === 'installer/InternalBeyond.iss';
  addCheck(checks, 'test-installer-identity', valid ? 'PASS' : 'FAIL',
    valid ? null : 'BUILD_METADATA_MISMATCH',
    valid ? 'Test-only identity sidecar binds the test AppId and artifact SHA-256.' : 'Test-only identity sidecar does not match the artifact or Inno test contract.');
}

function validatePayload(root, outputRoot, job, version, buildContext, adapters, checks) {
  const stageRelative = outputRoot + '/staging';
  const stage = resolveNoLinks(root, stageRelative, 'directory');
  if (!stage.ok) {
    const unavailable = stage.code === 'ARTIFACT_NOT_FOUND';
    const status = unavailable ? 'WARN' : 'FAIL';
    const code = unavailable ? 'STAGING_EVIDENCE_UNAVAILABLE' : (stage.code || 'PAYLOAD_VALIDATION_FAILED');
    const stageMessage = unavailable ? 'Canonical staging evidence is unavailable; payload closure is not claimed.' : 'Canonical staging path is unsafe or is not a directory.';
    addCheck(checks, 'staging-payload-manifest', status, code, stageMessage);
    addCheck(checks, 'staging-secret-scan', status, code, unavailable ? 'Secret scan requires retained staging evidence.' : 'Secret scan refused the unsafe staging path.');
    addCheck(checks, 'staging-payload-deny-rules', status, code, unavailable ? 'Canonical payload deny rules require retained staging evidence.' : 'Payload deny scan refused the unsafe staging path.');
    addCheck(checks, 'staging-content-audit', status, code, unavailable ? 'Canonical content and release-claim checks require retained staging evidence.' : 'Content audit refused the unsafe staging path.');
    addCheck(checks, 'staging-user-data-policy', status, code, unavailable ? 'User-data file exclusion cannot be verified without staging evidence.' : 'User-data scan refused the unsafe staging path.');
    addCheck(checks, 'staging-dynamic-path-scan', status, code, unavailable ? 'Dynamic developer-path scan cannot run without staging evidence.' : 'Path scan refused the unsafe staging path.');
    addCheck(checks, 'staging-static-path-scan', status, code, unavailable ? 'Static developer-path scan cannot run without staging evidence.' : 'Static path scan refused the unsafe staging path.');
    addCheck(checks, 'inno-payload-compression', unavailable ? 'WARN' : 'FAIL', code, unavailable ? 'Inno compressed payload cannot be reconciled without the staged file set.' : 'Compiler evidence points at an unsafe staging path.');
    addCheck(checks, 'canonical-source-closure', unavailable ? 'WARN' : 'FAIL', unavailable ? 'PROVENANCE_INCOMPLETE' : code, unavailable ? 'Canonical source closure cannot be matched to this artifact without build-time staging evidence.' : 'Canonical source closure refused the unsafe staging path.');
    return;
  }

  let files;
  try { files = safeInventory(stage.path); }
  catch (error) {
    const code = error && error.code === 'ARTIFACT_OUTSIDE_ALLOWED_ROOT' ? 'ARTIFACT_OUTSIDE_ALLOWED_ROOT' : 'PAYLOAD_VALIDATION_FAILED';
    addCheck(checks, 'staging-payload-manifest', 'FAIL', code, 'Staging contains a symlink, hard link, reparse point or non-regular entry.');
    addCheck(checks, 'staging-secret-scan', 'FAIL', code, 'Staging was not scanned because its tree boundary is unsafe.');
    addCheck(checks, 'staging-payload-deny-rules', 'FAIL', code, 'Staging was not checked because its tree boundary is unsafe.');
    addCheck(checks, 'staging-content-audit', 'FAIL', code, 'Staging was not audited because its tree boundary is unsafe.');
    addCheck(checks, 'staging-user-data-policy', 'FAIL', code, 'Staging tree boundary is unsafe.');
    addCheck(checks, 'staging-static-path-scan', 'FAIL', code, 'Staging tree boundary is unsafe.');
    addCheck(checks, 'staging-dynamic-path-scan', 'FAIL', code, 'Staging tree boundary is unsafe.');
    addCheck(checks, 'inno-payload-compression', 'WARN', 'PROVENANCE_INCOMPLETE', 'Compiler closure cannot be compared to an unsafe staging tree.');
    addCheck(checks, 'canonical-source-closure', 'WARN', 'PROVENANCE_INCOMPLETE', 'Canonical closure comparison is unavailable.');
    return;
  }

  const payload = parsePayloadManifest(files, version);
  addCheck(checks, 'staging-payload-manifest', payload.ok ? 'PASS' : 'FAIL',
    payload.ok ? null : 'PAYLOAD_VALIDATION_FAILED',
    payload.ok ? 'The staged payload manifest exactly lists the physical staging files.' : 'Staging payload manifest is missing, malformed or differs from staged files.');

  const userMatches = files.filter((file) => stageUserDataMatches(file.path));
  addCheck(checks, 'staging-user-data-policy', userMatches.length ? 'FAIL' : 'PASS',
    userMatches.length ? 'USER_DATA_DETECTED' : null,
    userMatches.length ? 'Staging contains forbidden user-data file names.' : 'No forbidden Vault, environment, database, chat or user-data paths were found.',
    userMatches.length ? { pathKind: 'user-data', matchCount: userMatches.length } : null);

  let audit = null;
  try { audit = scanSafeStaging(stage.path, files); } catch (_) { audit = null; }
  const auditFindings = audit && Array.isArray(audit.findings) ? audit.findings : [];
  const errors = auditFindings.filter((item) => item.severity === 'error');
  const warnings = auditFindings.filter((item) => item.severity === 'warn');
  const secretRules = new Set((releaseAudit.SECRET_RULES || [])
    .map((item) => item.id).filter((id) => !/^dev-path/.test(id)));
  const secretErrors = errors.filter((item) => secretRules.has(item.rule));
  const pathErrors = errors.filter((item) => /^dev-path/.test(String(item.rule || '')));
  const otherErrors = errors.filter((item) => !secretRules.has(item.rule) && !/^dev-path/.test(String(item.rule || '')));
  const violations = audit && Array.isArray(audit.violations) ? audit.violations : [];
  const auditOk = !!audit && audit.ok === true;
  if (secretErrors.length) {
    addCheck(checks, 'staging-secret-scan', 'FAIL', 'SECRET_DETECTED', 'Canonical release-audit found secret-like material; values are not included in this result.',
      { pathKind: 'secret-pattern', matchCount: secretErrors.length });
  } else if (!audit) {
    addCheck(checks, 'staging-secret-scan', 'FAIL', 'PAYLOAD_VALIDATION_FAILED', 'Canonical release-audit could not inspect the staging tree.');
  } else {
    addCheck(checks, 'staging-secret-scan', 'PASS', null, 'Canonical release-audit secret rules found no secret-like material.');
  }
  const denyData = violations.filter((item) => stageUserDataMatches(String(item.path || '')));
  const nonProductionMatches = files.filter((file) => NON_PRODUCTION_PATH_RULES.some((rule) => rule.test(file.path)));
  if (denyData.length) {
    addCheck(checks, 'staging-user-data-deny-rules', 'FAIL', 'USER_DATA_DETECTED', 'Canonical payload deny rules found forbidden user-data paths.',
      { pathKind: 'user-data', matchCount: denyData.length });
  } else if (violations.length || nonProductionMatches.length) {
    addCheck(checks, 'staging-payload-deny-rules', 'FAIL', 'PAYLOAD_VALIDATION_FAILED', 'Canonical or P35 non-production path rules found forbidden staging paths.',
      { pathKind: 'denied-payload', matchCount: violations.length + nonProductionMatches.length });
  } else if (!audit) {
    addCheck(checks, 'staging-payload-deny-rules', 'FAIL', 'PAYLOAD_VALIDATION_FAILED', 'Canonical payload deny rules could not be evaluated.');
  } else {
    addCheck(checks, 'staging-payload-deny-rules', 'PASS', null, 'Canonical payload deny rules found no forbidden paths.');
  }
  if (pathErrors.length) {
    addCheck(checks, 'staging-static-path-scan', 'FAIL', 'PATH_LEAK_DETECTED', 'Canonical release-audit found developer-path markers.',
      { pathKind: 'developer-path', matchCount: pathErrors.length });
  } else if (audit) {
    addCheck(checks, 'staging-static-path-scan', 'PASS', null, 'Canonical release-audit found no configured static developer-path markers.');
  }
  if (otherErrors.length) {
    addCheck(checks, 'staging-content-audit', 'FAIL', 'PAYLOAD_VALIDATION_FAILED', 'Canonical release-audit reported payload errors.',
      { pathKind: 'payload-audit', matchCount: otherErrors.length });
  } else if (warnings.length) {
    addCheck(checks, 'staging-content-audit', 'WARN', 'USER_DATA_DETECTED', 'Canonical release-audit reported PII-like warnings that need human review.',
      { pathKind: 'pii-warning', matchCount: warnings.length });
  } else if (auditOk) {
    addCheck(checks, 'staging-content-audit', 'PASS', null, 'Canonical release-audit content and release-claim checks passed.');
  }

  const dynamicMatches = scanDynamicPaths(files, root, adapters.dynamicPaths);
  addCheck(checks, 'staging-dynamic-path-scan', dynamicMatches ? 'FAIL' : 'PASS',
    dynamicMatches ? 'PATH_LEAK_DETECTED' : null,
    dynamicMatches ? 'Staged text contains a current repository, profile or temporary path marker.' : 'No current repository, profile or temporary path markers were found in staged text.',
    dynamicMatches ? { pathKind: 'current-developer-path', matchCount: dynamicMatches } : null);

  const compileResult = sidecarRead(adapters, root, outputRoot, 'build-compile.log');
  if (compileResult.unsafe) {
    addCheck(checks, 'inno-payload-compression', 'FAIL', 'ARTIFACT_OUTSIDE_ALLOWED_ROOT', 'Compiler log is a link or is outside the output root.');
  } else if (!compileResult.ok) {
    addCheck(checks, 'inno-payload-compression', 'WARN', 'PROVENANCE_INCOMPLETE', 'Inno compiler log is unavailable; staged files cannot be tied to the compiled installer.');
  } else {
    const issText = readRepoText(root, 'installer/InternalBeyond.iss') || '';
    const identity = readInstallerIdentity(issText);
    const evidence = compileEvidence(compileResult.text, stage.path, files, job.mode, identity);
    if (!evidence.identityFound || !evidence.identityMatches) {
      addCheck(checks, 'inno-payload-compression', 'FAIL', 'BUILD_METADATA_MISMATCH', 'Inno compile log does not match the expected mode identity.');
    } else if (!evidence.compressionFound) {
      addCheck(checks, 'inno-payload-compression', 'WARN', 'PROVENANCE_INCOMPLETE', 'Inno compile log has no readable Compressing entries.');
    } else if (!evidence.compressionMatches) {
      addCheck(checks, 'inno-payload-compression', 'FAIL', 'PAYLOAD_VALIDATION_FAILED', 'Inno compile log does not cover the staged payload file set.');
    } else {
      addCheck(checks, 'inno-payload-compression', 'PASS', null, 'Inno compile log records the staged payload file set and expected installer identity.');
    }
  }

  const context = buildContext || {};
  if (!payload.ok) {
    addCheck(checks, 'canonical-source-closure', 'FAIL', 'PAYLOAD_VALIDATION_FAILED', 'Canonical source closure cannot be checked against an invalid staging manifest.');
    return;
  }
  if (context.dirty !== false || !REVISION_RE.test(String(context.revision || ''))) {
    addCheck(checks, 'canonical-source-closure', 'WARN', 'PROVENANCE_INCOMPLETE', 'Build-time source was dirty or has no recorded revision; current source cannot stand in for that snapshot.');
    return;
  }
  if (manifestInputsUnsafe(root)) {
    addCheck(checks, 'canonical-source-closure', 'WARN', 'PROVENANCE_INCOMPLETE', 'A canonical source input could not be enumerated safely; Validator did not follow it while resolving source closure.');
    return;
  }
  const gitState = adapters.currentGitState(root);
  if (!gitState || gitState.ok !== true || gitState.dirty !== false || gitState.revision !== String(context.revision).toLowerCase()) {
    addCheck(checks, 'canonical-source-closure', 'WARN', 'PROVENANCE_INCOMPLETE', 'Current checkout does not prove the recorded clean build-time source revision.');
    return;
  }
  let resolved;
  try { resolved = adapters.resolvePayload(root); } catch (_) { resolved = null; }
  const generated = buildGeneratedFiles(root);
  if (!resolved || resolved.ok !== true || !Array.isArray(resolved.files) || !generated) {
    addCheck(checks, 'canonical-source-closure', 'FAIL', 'PAYLOAD_VALIDATION_FAILED', 'Canonical release-manifest/build sources could not reproduce the expected payload file set.');
    return;
  }
  const expected = resolved.files.map((item) => item.to).concat(generated);
  const exact = compareSets(expected, payload.files);
  addCheck(checks, 'canonical-source-closure', exact ? 'PASS' : 'FAIL',
    exact ? null : 'PAYLOAD_VALIDATION_FAILED',
    exact ? 'Staged payload manifest matches the canonical source whitelist plus generated build entries.' : 'Staged payload manifest differs from the canonical source whitelist.');
}

function validateBuildProvenance(root, outputRoot, job, version, artifact, buildContext, adapters, checks) {
  if (job.mode === 'test') {
    addCheck(checks, 'build-source-provenance', 'WARN', 'PROVENANCE_INCOMPLETE',
      'Test identity binds artifact bytes, but current test-build metadata does not snapshot the source revision and dirty state.');
    return;
  }
  const value = parseReleaseBuilderEvidence({
    log: sidecarRead(adapters, root, outputRoot, 'release-' + version + '.log'),
    jsonl: sidecarRead(adapters, root, outputRoot, 'release-' + version + '.jsonl')
  }, version, artifact.name, artifact.sha256, artifact.size, buildContext);
  addCheck(checks, 'build-source-provenance', value.status, value.code, value.message);
}

function defaultAdapters() {
  return {
    sha256File: releaseVerify.sha256File,
    resolvePayload: function (root) { return releaseManifest.resolve({ root: root }); },
    readPeVersion: function (file, expected) { return peVersion.matchesProductVersion(file, expected); },
    currentGitState: currentGitState,
    readOutputFile: function (directory, name) { return safeReadRelative(directory, name); },
    dynamicPaths: null
  };
}

function validateArtifact(request, options) {
  const o = options || {};
  const root = path.resolve(o.root || path.resolve(__dirname, '..', '..'));
  const adapters = Object.assign(defaultAdapters(), o.adapters || {});
  const checks = [];
  let normalized;
  try { normalized = validateRequest(request); }
  catch (_) {
    addCheck(checks, 'request-contract', 'FAIL', 'INVALID_REQUEST', 'Validation request fields or PackagingJob values are not accepted.');
    return makeResult(null, null, checks);
  }
  const job = normalized.job;
  const context = {
    target: 'windows-installer',
    version: job.version,
    mode: job.mode,
    revision: normalized.buildContext.revision,
    dirty: normalized.buildContext.dirty
  };
  const artifact = { name: '', size: 0, sha256: '' };
  addCheck(checks, 'request-contract', 'PASS', null, 'PackagingJob and validation request fields are valid.');

  const versionRead = productVersion.read({ file: path.join(root, 'VERSION') });
  if (!versionRead || !versionRead.ok) {
    addCheck(checks, 'root-version', 'WARN', 'VERSION_METADATA_UNAVAILABLE', 'Canonical root VERSION could not be read; no root-version match is claimed.');
  } else if (job.version && job.version !== versionRead.version) {
    addCheck(checks, 'root-version', 'FAIL', 'VERSION_MISMATCH', 'PackagingJob.version does not match the canonical root VERSION.');
  } else {
    if (!job.version) { context.version = versionRead.version; }
    addCheck(checks, 'root-version', 'PASS', null, 'PackagingJob version resolves to the canonical root VERSION.');
  }
  const expectedVersion = context.version || (versionRead && versionRead.ok ? versionRead.version : '');
  if (!expectedVersion) addCheck(checks, 'version-source', 'WARN', 'VERSION_METADATA_UNAVAILABLE', 'No version is available for PE comparison.');

  const outputRoot = OUTPUT_ROOTS[job.mode];
  const pathResult = validateRelativeArtifactPath(normalized.artifactPath, outputRoot);
  if (!pathResult.ok) {
    addCheck(checks, 'artifact-path-boundary', 'FAIL', 'ARTIFACT_OUTSIDE_ALLOWED_ROOT', 'Artifact path must be normalized, relative and inside the mode-specific output root.');
    return makeResult(context, artifact, checks);
  }
  if (path.posix.extname(pathResult.basename).toLowerCase() !== '.exe') {
    addCheck(checks, 'artifact-filename', 'FAIL', 'ARTIFACT_FILENAME_MISMATCH', 'Windows Installer artifact must have the .exe extension.');
    return makeResult(context, artifact, checks);
  }
  const naming = expectedInstallerName(root, job.mode, expectedVersion, updateManifest);
  if (!naming.ok) {
    addCheck(checks, 'artifact-filename', 'WARN', naming.code || 'VERSION_METADATA_UNAVAILABLE', 'Canonical installer filename metadata is unavailable; no filename match is claimed.');
  } else if (pathResult.basename !== naming.name) {
    addCheck(checks, 'artifact-filename', 'FAIL', 'ARTIFACT_FILENAME_MISMATCH', 'Artifact filename does not match the canonical target/version naming rule.');
    return makeResult(context, artifact, checks);
  } else {
    artifact.name = naming.name;
    addCheck(checks, 'artifact-filename', 'PASS', null, 'Artifact filename matches the canonical target/version naming rule.');
  }
  if (naming.ok && normalized.artifactPath !== outputRoot + '/' + naming.name) {
    addCheck(checks, 'artifact-path-boundary', 'FAIL', 'ARTIFACT_OUTSIDE_ALLOWED_ROOT', 'Artifact path does not resolve to the canonical output root.');
    return makeResult(context, artifact, checks);
  }
  if (!naming.ok) artifact.name = pathResult.basename;
  const finalRelative = outputRoot + '/' + artifact.name;
  const safe = resolveNoLinks(root, finalRelative, 'file');
  if (!safe.ok) {
    addCheck(checks, 'artifact-identity', 'FAIL', safe.code || 'ARTIFACT_NOT_FOUND',
      safe.code === 'ARTIFACT_NOT_FOUND' ? 'Expected installer artifact does not exist.' : 'Artifact is not a regular file under the allowed output root.');
    return makeResult(context, artifact, checks);
  }
  addCheck(checks, 'artifact-path-boundary', 'PASS', null, 'Artifact resolves under the canonical output root with no symlink/reparse or hard-link boundary.');
  artifact.size = safe.stat.size;
  const minSize = updateManifest.MIN_PLAUSIBLE_INSTALLER_BYTES;
  const maxSize = updateManifest.MAX_PLAUSIBLE_INSTALLER_BYTES;
  if (artifact.size < minSize || artifact.size > maxSize) {
    addCheck(checks, 'artifact-size', 'FAIL', 'ARTIFACT_SIZE_INVALID', 'Artifact size is outside canonical update-manifest sanity bounds.');
  } else {
    addCheck(checks, 'artifact-size', 'PASS', null, 'Artifact size is within canonical update-manifest sanity bounds.');
  }
  if (artifact.size > 0 && artifact.size <= maxSize) {
    try {
      artifact.sha256 = String(adapters.sha256File(safe.path)).toLowerCase();
      const after = fs.lstatSync(safe.path);
      if (after.isSymbolicLink() || after.size !== safe.stat.size || after.mtimeMs !== safe.stat.mtimeMs || after.nlink > 1) {
        throw new Error('artifact changed during validation');
      }
      if (!/^[0-9a-f]{64}$/.test(artifact.sha256)) throw new Error('invalid sha256');
      addCheck(checks, 'artifact-sha256', 'PASS', null, 'SHA-256 was recomputed from the final artifact bytes.');
    } catch (_) {
      artifact.sha256 = '';
      addCheck(checks, 'artifact-sha256', 'FAIL', 'ARTIFACT_HASH_FAILED', 'Artifact SHA-256 could not be measured consistently.');
    }
  } else {
    addCheck(checks, 'artifact-sha256', 'FAIL', 'ARTIFACT_HASH_FAILED', 'Artifact bytes were not hashed because size is invalid.');
  }

  const issText = naming.iss || readRepoText(root, 'installer/InternalBeyond.iss') || '';
  const identity = readInstallerIdentity(issText);
  if (!identity.ok || !identity.productionAppId || !identity.testAppId) {
    addCheck(checks, 'inno-identity-source', 'WARN', 'VERSION_METADATA_UNAVAILABLE', 'Canonical Inno identity macros could not be read.');
  } else {
    addCheck(checks, 'inno-identity-source', 'PASS', null, 'Production and test identities were read from the canonical Inno source.');
  }
  try {
    validatePeVersion(safe.path, expectedVersion, adapters, checks);
    validateBuildSidecars(root, outputRoot, job, expectedVersion, artifact, identity, adapters, checks);
    validatePayload(root, outputRoot, job, expectedVersion, normalized.buildContext, adapters, checks);
    validateBuildProvenance(root, outputRoot, job, expectedVersion, artifact, normalized.buildContext, adapters, checks);
  } catch (_) {
    addCheck(checks, 'validation-internal', 'FAIL', 'VALIDATION_INTERNAL_ERROR', 'Validator encountered an internal read/parse failure; no files were changed.');
  }
  return makeResult(context, artifact, checks);
}

module.exports = {
  RESULT_SCHEMA: RESULT_SCHEMA,
  OUTPUT_ROOTS: OUTPUT_ROOTS,
  USER_DATA_PATH_RULES: USER_DATA_PATH_RULES,
  NON_PRODUCTION_PATH_RULES: NON_PRODUCTION_PATH_RULES,
  isIssuedValidationResult: isIssuedValidationResult,
  expectedArtifactName: expectedArtifactName,
  measureArtifactIdentity: measureArtifactIdentity,
  validateArtifact: validateArtifact
};
