'use strict';

/* Optional, pinned DSH runtime package contract and bounded ZIP transport. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');

const SCHEMA = 'internalbeyond.optional-dsh-runtime';
const DSH_SCHEMA = 'internalbeyond.dsh-runtime';
const DSH_REVISION = 'd743267388641bc76f17c45ce8b4c231aed1d32c';
const DSH_RUNTIME_VERSION = '0.2.1-alpha.2';
const DSH_NODE_ENGINE = '^22.19.0 || >=24.0.0';
const TARGET = 'windows-x64';
const WRAPPER_NAME = 'optional-runtime-manifest.json';
const SUMS_NAME = 'SHA256SUMS.txt';
const MAX_ARCHIVE_BYTES = 1024 * 1024 * 1024;
const MAX_UNPACKED_BYTES = 900 * 1024 * 1024;
const MAX_FILE_BYTES = 256 * 1024 * 1024;
const MAX_FILES = 50000;
const ZIP_UTF8 = 0x0800;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let value = n;
    for (let bit = 0; bit < 8; bit++) value = (value & 1) ? ((value >>> 1) ^ 0xedb88320) : (value >>> 1);
    table[n] = value >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let value = 0xffffffff;
  for (let index = 0; index < bytes.length; index++) value = CRC_TABLE[(value ^ bytes[index]) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function compareVersion(left, right) {
  const a = String(left || '').match(/^(\d+)\.(\d+)\.(\d+)/);
  const b = String(right || '').match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!a || !b) return null;
  for (let index = 1; index <= 3; index++) {
    const difference = Number(a[index]) - Number(b[index]);
    if (difference) return difference < 0 ? -1 : 1;
  }
  return 0;
}

function dshNodeEngineSupports(value) {
  const match = String(value || '').replace(/^v/, '').match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  return (major === 22 && (minor > 19 || (minor === 19 && patch >= 0))) || major >= 24;
}

function pathInside(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
}

function safePackagePath(value) {
  const relative = String(value || '');
  if (!relative || relative.startsWith('/') || relative.includes('\\') || relative.includes('\0')
    || /^[A-Za-z]:/.test(relative) || relative.endsWith('/')) return false;
  const parts = relative.split('/');
  return parts.every(part => part && part !== '.' && part !== '..' && !part.includes(':'));
}

function readRuntimeManifest(runtimeRoot, options) {
  options = options || {};
  const file = path.join(runtimeRoot, 'runtime-manifest.json');
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  const expectedRuntimeVersion = String(options.expectedRuntimeVersion || DSH_RUNTIME_VERSION);
  if (!manifest || manifest.schema !== DSH_SCHEMA || manifest.runtimeVersion !== expectedRuntimeVersion
    || manifest.sourceRevision !== DSH_REVISION || manifest.target !== TARGET || Number(manifest.protocolVersion) !== 1
    || manifest.profile !== 'acp' || manifest.entry !== 'apps/cli/src/bin.ts' || manifest.config !== 'config/cordis.yml'
    || !Number.isSafeInteger(manifest.productionArtifactFiles) || manifest.productionArtifactFiles < 1
    || !Number.isSafeInteger(manifest.productionArtifactBytes) || manifest.productionArtifactBytes < 1
    || !Array.isArray(manifest.workspacePackages) || !Array.isArray(manifest.externalPackages)
    || !Array.isArray(manifest.productionExcludes) || !Array.isArray(manifest.productionPatches)) {
    throw new Error('runtime-manifest-invalid');
  }
  const packages = [].concat(manifest.workspacePackages, manifest.externalPackages, manifest.compatibilityPackages || []);
  if (!packages.length || packages.some(item => /(?:mock-server|fake-provider|synthetic-provider)/i.test(String(item && item.name || '')))) {
    throw new Error('runtime-provider-roster-invalid');
  }
  const requiredPatches = [
    ['@deepseek-ai/dsh-client-connection', 'src/browser-auth.ts'],
    ['@deepseek-ai/dsh-api-workspace-controller', 'src/commands.ts']
  ];
  if (options.requireProductionPatches !== false) {
    for (const [packageName, relative] of requiredPatches) {
      if (!manifest.productionPatches.some(item => item && item.packageName === packageName && item.path === relative
        && item.upstreamRevision === DSH_REVISION)) throw new Error('runtime-production-patch-missing');
    }
  }
  for (const relative of [manifest.entry, manifest.config,
    'node_modules/tsx/dist/esm/index.mjs',
    'node_modules/@deepseek-ai/dsh-client-connection/src/browser-auth.ts',
    'node_modules/@deepseek-ai/dsh-api-workspace-controller/src/commands.ts']) {
    if (!safePackagePath(relative) || !pathInside(runtimeRoot, path.join(runtimeRoot, relative))
      || !fs.statSync(path.join(runtimeRoot, relative), { throwIfNoEntry: false })?.isFile()) {
      throw new Error('runtime-required-file-missing');
    }
  }
  const web = manifest.webFrontend;
  const webRelative = 'node_modules/@deepseek-ai/dsh-web-frontend/dist';
  if (!web || web.sourceRevision !== DSH_REVISION || web.runtimePath !== webRelative
    || !Number.isSafeInteger(web.artifactFiles) || web.artifactFiles < 1
    || !Number.isSafeInteger(web.artifactBytes) || web.artifactBytes < 1
    || !/^[a-f0-9]{64}$/i.test(String(web.indexSha256 || ''))) throw new Error('runtime-web-manifest-invalid');
  const indexPath = path.join(runtimeRoot, webRelative, 'index.html');
  if (!fs.existsSync(indexPath) || sha256(fs.readFileSync(indexPath)) !== web.indexSha256.toLowerCase()) {
    throw new Error('runtime-web-index-hash-mismatch');
  }
  for (const item of packages) {
    const relative = String(item && item.runtimePath || '').replace(/\\/g, '/');
    if (!relative.startsWith('node_modules/') || !safePackagePath(relative)) throw new Error('runtime-package-path-invalid');
    let actual;
    try { actual = JSON.parse(fs.readFileSync(path.join(runtimeRoot, relative, 'package.json'), 'utf8')); }
    catch (_) { throw new Error('runtime-package-manifest-invalid'); }
    if (actual.name !== item.name || String(actual.version) !== String(item.version)) throw new Error('runtime-package-pin-mismatch');
    const packageRoot = path.join(runtimeRoot, relative);
    for (const subpath of ['./typert', './client']) {
      const exported = actual.exports && actual.exports[subpath];
      if (!exported) continue;
      const target = typeof exported === 'string' ? exported
        : exported.node || exported.import || exported.default || exported.require;
      if (typeof target !== 'string' || !target.startsWith('./') || target.includes('*')) continue;
      const resolved = path.resolve(packageRoot, target);
      if (!pathInside(packageRoot, resolved) || !fs.existsSync(resolved)) throw new Error('runtime-export-target-missing');
    }
  }
  return manifest;
}

function wildcardToRegExp(pattern) {
  const escaped = String(pattern).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp('^' + escaped + '$', 'i');
}

function productionFiles(runtimeRoot, runtimeManifest) {
  const excludes = runtimeManifest.productionExcludes.map(wildcardToRegExp);
  const files = [];
  function walk(directory, prefix) {
    const entries = fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      const relative = prefix ? prefix + '/' + entry.name : entry.name;
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) throw new Error('runtime-package-reparse-point-denied');
      if (stat.isDirectory()) { walk(absolute, relative); continue; }
      if (!stat.isFile()) throw new Error('runtime-package-special-file-denied');
      if (excludes.some(pattern => pattern.test(relative))) continue;
      files.push({ path: 'runtime/' + relative, source: absolute, bytes: stat.size, sha256: hashFile(absolute) });
    }
  }
  walk(runtimeRoot, '');
  files.sort((a, b) => a.path.localeCompare(b.path));
  return files;
}

function createOptionalRuntimeManifest(runtimeRoot, productVersion, nodeVersion) {
  const runtimeManifest = readRuntimeManifest(runtimeRoot);
  const files = productionFiles(runtimeRoot, runtimeManifest);
  const totalBytes = files.reduce((total, item) => total + item.bytes, 0);
  if (files.length !== runtimeManifest.productionArtifactFiles || totalBytes !== runtimeManifest.productionArtifactBytes) {
    throw new Error('runtime-production-artifact-size-mismatch');
  }
  const major = Number(String(productVersion || '').split('.')[0]);
  if (!Number.isSafeInteger(major) || major < 1) throw new Error('runtime-product-version-invalid');
  const manifest = {
    schema: SCHEMA,
    schemaVersion: 1,
    runtimeVersion: runtimeManifest.runtimeVersion,
    sourceRevision: runtimeManifest.sourceRevision,
    target: runtimeManifest.target,
    protocolVersion: runtimeManifest.protocolVersion,
    compatibility: {
      minimumProductVersion: String(productVersion),
      maximumProductVersionExclusive: (major + 1) + '.0.0',
      bundledNodeVersion: String(nodeVersion),
      dshNodeEngine: runtimeManifest.nodeEngine
    },
    productionArtifacts: {
      fileCount: runtimeManifest.productionArtifactFiles,
      bytes: runtimeManifest.productionArtifactBytes,
      webFrontendSha256: runtimeManifest.webFrontend.indexSha256
    },
    fileCount: files.length,
    totalBytes: totalBytes,
    files: files.map(({ path: filePath, bytes, sha256: digest }) => ({ path: filePath, bytes, sha256: digest }))
  };
  validateProductCompatibility(manifest, { productVersion, nodeVersion });
  const wrapperBytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  const sumsBytes = Buffer.from(files.map(item => `${item.sha256}  ${item.path}`)
    .concat(`${sha256(wrapperBytes)}  ${WRAPPER_NAME}`).join('\n') + '\n', 'utf8');
  return { manifest, files, wrapperBytes, sumsBytes, runtimeManifest };
}

function replaceExactlyOnce(source, anchor, replacement, code) {
  const index = source.indexOf(anchor);
  if (index < 0 || source.indexOf(anchor, index + anchor.length) >= 0) throw new Error(code);
  return source.slice(0, index) + replacement + source.slice(index + anchor.length);
}

function patchLegacyRuntimeSources(runtimeRoot, runtimeManifest) {
  const cookiePath = path.join(runtimeRoot, 'node_modules', '@deepseek-ai', 'dsh-client-connection', 'src', 'browser-auth.ts');
  let cookieSource = fs.readFileSync(cookiePath, 'utf8');
  const embeddedCookiePolicy = cookieSource.includes("SameSite=${process.env.IB_DSH_EMBEDDED_TAURI === '1' ? 'None' : 'Strict'}")
    && cookieSource.includes("return (secure || process.env.IB_DSH_EMBEDDED_TAURI === '1') ? `${attributes}; Secure` : attributes");
  if (!embeddedCookiePolicy) {
    cookieSource = replaceExactlyOnce(cookieSource, '; HttpOnly; SameSite=Strict`',
      "; HttpOnly; SameSite=${process.env.IB_DSH_EMBEDDED_TAURI === '1' ? 'None' : 'Strict'}`",
      'legacy-runtime-cookie-anchor-changed');
    cookieSource = replaceExactlyOnce(cookieSource, '  return secure ? `${attributes}; Secure` : attributes',
      "  return (secure || process.env.IB_DSH_EMBEDDED_TAURI === '1') ? `${attributes}; Secure` : attributes",
      'legacy-runtime-cookie-secure-anchor-changed');
    fs.writeFileSync(cookiePath, cookieSource, 'utf8');
  }
  const workspacePath = path.join(runtimeRoot, 'node_modules', '@deepseek-ai', 'dsh-api-workspace-controller', 'src', 'commands.ts');
  let workspaceSource = fs.readFileSync(workspacePath, 'utf8');
  const workspaceScopePolicy = workspaceSource.includes("if (process.env.IB_DSH_EMBEDDED_TAURI === '1') {")
    && workspaceSource.includes('await Promise.all([realpath(lexicalRoot), realpath(lexicalPath)])')
    && workspaceSource.includes('workspace/path-outside-private-work-mode');
  if (!workspaceScopePolicy) {
    if (workspaceSource.includes('workspace/path-outside-private-work-mode')
      || workspaceSource.includes("if (process.env.IB_DSH_EMBEDDED_TAURI === '1') {")) {
      throw new Error('legacy-runtime-workspace-policy-incomplete');
    }
    const importAnchor = "import type { Context } from '@deepseek-ai/cordis'\n";
    workspaceSource = replaceExactlyOnce(workspaceSource, importAnchor,
      "import path from 'node:path'\nimport { realpath } from 'node:fs/promises'\n" + importAnchor,
      'legacy-runtime-workspace-import-anchor-changed');
    const createAnchor = '  create(request: WorkspaceCreateRequest): Promise<WorkspaceCreateValue> {\n'
      + '    return this.enqueue(async () => {\n      try {\n';
    const guard = '  create(request: WorkspaceCreateRequest): Promise<WorkspaceCreateValue> {\n'
      + '    return this.enqueue(async () => {\n'
      + "      if (process.env.IB_DSH_EMBEDDED_TAURI === '1') {\n"
      + "        const configuredRoot = String(process.env.IB_DSH_WORKSPACE_ROOT || '')\n"
      + "        if (!configuredRoot) throw new RemoteError('workspace/private-root-required',\n"
      + "          'Workspace registration requires the private Work Mode root', {})\n"
      + "        const requestedPath = String(request && request.path || '')\n"
      + '        const lexicalRoot = path.resolve(configuredRoot)\n'
      + '        const lexicalPath = path.resolve(requestedPath)\n'
      + '        const lexicalRelative = path.relative(lexicalRoot, lexicalPath)\n'
      + "        if (lexicalRelative === '..' || lexicalRelative.startsWith('..' + path.sep) || path.isAbsolute(lexicalRelative)) {\n"
      + "          throw new RemoteError('workspace/path-outside-private-work-mode',\n"
      + "            'Workspace must remain inside the private Work Mode root', {})\n"
      + '        }\n'
      + '        const [canonicalRoot, canonicalPath] = await Promise.all([realpath(lexicalRoot), realpath(lexicalPath)])\n'
      + '        const canonicalRelative = path.relative(canonicalRoot, canonicalPath)\n'
      + "        if (canonicalRelative === '..' || canonicalRelative.startsWith('..' + path.sep) || path.isAbsolute(canonicalRelative)) {\n"
      + "          throw new RemoteError('workspace/path-outside-private-work-mode',\n"
      + "            'Workspace must remain inside the private Work Mode root', {})\n"
      + '        }\n'
      + '      }\n'
      + '      try {\n';
    workspaceSource = replaceExactlyOnce(workspaceSource, createAnchor, guard,
      'legacy-runtime-workspace-create-anchor-changed');
    fs.writeFileSync(workspacePath, workspaceSource, 'utf8');
  }
  const productionPatches = Array.isArray(runtimeManifest.productionPatches) ? runtimeManifest.productionPatches.slice() : [];
  const patchRows = [
    { packageName: '@deepseek-ai/dsh-client-connection', path: 'src/browser-auth.ts',
      mode: "IB_DSH_EMBEDDED_TAURI=1 uses SameSite=None; Secure for the authenticated Tauri iframe" },
    { packageName: '@deepseek-ai/dsh-api-workspace-controller', path: 'src/commands.ts',
      mode: 'IB_DSH_EMBEDDED_TAURI=1 permits Workspace registration only inside the private DSH Work Mode root' }
  ];
  for (const row of patchRows) {
    if (!productionPatches.some(item => item && item.packageName === row.packageName && item.path === row.path)) {
      productionPatches.push(Object.assign({ upstreamRevision: DSH_REVISION }, row));
    }
  }
  runtimeManifest.productionPatches = productionPatches;
  fs.writeFileSync(path.join(runtimeRoot, 'runtime-manifest.json'), JSON.stringify(runtimeManifest, null, 2) + '\n', 'utf8');
  const thirdPartyPath = path.join(runtimeRoot, 'THIRD_PARTY_RUNTIME.json');
  if (fs.existsSync(thirdPartyPath)) {
    let thirdParty = JSON.parse(fs.readFileSync(thirdPartyPath, 'utf8'));
    thirdParty.productionPatches = productionPatches;
    fs.writeFileSync(thirdPartyPath, JSON.stringify(thirdParty, null, 2) + '\n', 'utf8');
  }
  refreshProductionArtifactStats(runtimeRoot, runtimeManifest);
  return runtimeManifest;
}

function refreshProductionArtifactStats(runtimeRoot, runtimeManifest) {
  for (let pass = 0; pass < 6; pass++) {
    const files = productionFiles(runtimeRoot, runtimeManifest);
    const bytes = files.reduce((total, item) => total + item.bytes, 0);
    const countChanged = runtimeManifest.productionArtifactFiles !== files.length;
    const bytesChanged = runtimeManifest.productionArtifactBytes !== bytes;
    if (!countChanged && !bytesChanged) return runtimeManifest;
    runtimeManifest.productionArtifactFiles = files.length;
    runtimeManifest.productionArtifactBytes = bytes;
    fs.writeFileSync(path.join(runtimeRoot, 'runtime-manifest.json'), JSON.stringify(runtimeManifest, null, 2) + '\n', 'utf8');
  }
  const finalFiles = productionFiles(runtimeRoot, runtimeManifest);
  if (finalFiles.length !== runtimeManifest.productionArtifactFiles
    || finalFiles.reduce((total, item) => total + item.bytes, 0) !== runtimeManifest.productionArtifactBytes) {
    throw new Error('legacy-runtime-artifact-metadata-did-not-converge');
  }
  return runtimeManifest;
}

function migrateLegacyRuntimeFolder(sourceRoot, targetRoot, options) {
  options = options || {};
  const source = path.resolve(String(sourceRoot || ''));
  const target = path.resolve(String(targetRoot || ''));
  const parent = path.dirname(target);
  if (!source || !target || !pathInside(parent, target) || !fs.statSync(source, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error('legacy-runtime-migration-path-invalid');
  }
  const existing = fs.statSync(target, { throwIfNoEntry: false });
  if (existing) {
    try {
      const validation = validateInstalledDshRuntime(target, options);
      return { migrated: false, alreadyInstalled: true, runtimeVersion: validation.runtimeVersion };
    } catch (_) { throw new Error('existing-dsh-runtime-extension-conflict'); }
  }
  if (!Array.isArray(options.allowedFiles) || options.allowedFiles.length < 1 || options.allowedFiles.length > MAX_FILES) {
    throw new Error('legacy-runtime-payload-manifest-required');
  }
  assertNoReparsePath(source, source);
  fs.mkdirSync(parent, { recursive: true });
  const stageRoot = target + '.migrate-' + crypto.randomUUID();
  try {
    fs.mkdirSync(stageRoot, { recursive: false });
    const allowed = new Set();
    for (const entry of options.allowedFiles) {
      const manifestPath = String(entry || '').replace(/\\/g, '/');
      if (!manifestPath.startsWith('runtime/dsh-runtime/')) throw new Error('legacy-runtime-payload-path-invalid');
      const relative = manifestPath.slice('runtime/dsh-runtime/'.length);
      if (!safePackagePath('runtime/' + relative) || allowed.has(relative.toLowerCase())) {
        throw new Error('legacy-runtime-payload-path-invalid');
      }
      allowed.add(relative.toLowerCase());
      const from = path.resolve(source, ...relative.split('/'));
      const to = path.resolve(stageRoot, ...relative.split('/'));
      if (!pathInside(source, from) || !pathInside(stageRoot, to)) throw new Error('legacy-runtime-payload-path-invalid');
      assertNoReparsePath(source, from);
      const sourceStat = fs.lstatSync(from);
      if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) throw new Error('legacy-runtime-payload-file-invalid');
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
    }
    for (const required of ['runtime-manifest.json', 'apps/cli/src/bin.ts', 'config/cordis.yml',
      'node_modules/@deepseek-ai/dsh-web-frontend/dist/index.html']) {
      if (!allowed.has(required.toLowerCase())) throw new Error('legacy-runtime-payload-incomplete');
    }
    assertTreeHasNoReparsePoints(stageRoot);
    let manifest = readRuntimeManifest(stageRoot, { requireProductionPatches: false });
    if (manifest.sourceRevision !== DSH_REVISION || manifest.target !== TARGET) throw new Error('legacy-runtime-pin-mismatch');
    patchLegacyRuntimeSources(stageRoot, manifest);
    manifest = readRuntimeManifest(stageRoot);
    const productVersion = String(options.productVersion || '');
    const nodeVersion = String(options.nodeVersion || '');
    const packaged = createOptionalRuntimeManifest(stageRoot, productVersion, nodeVersion);
    fs.writeFileSync(path.join(stageRoot, WRAPPER_NAME), packaged.wrapperBytes, { flag: 'wx' });
    fs.writeFileSync(path.join(stageRoot, SUMS_NAME), packaged.sumsBytes, { flag: 'wx' });
    const installRecord = {
      schema: 'internalbeyond.dsh-runtime-install',
      source: 'legacy-migration',
      runtimeVersion: packaged.manifest.runtimeVersion,
      sourceRevision: packaged.manifest.sourceRevision,
      productVersion: productVersion,
      nodeVersion: nodeVersion,
      archiveSha256: '',
      packageManifestSha256: sha256(packaged.wrapperBytes),
      runtimeManifestSha256: hashFile(path.join(stageRoot, 'runtime-manifest.json')),
      installedAt: Date.now()
    };
    fs.writeFileSync(path.join(stageRoot, 'install-manifest.json'), JSON.stringify(installRecord, null, 2) + '\n', { flag: 'wx' });
    if (fs.existsSync(target)) throw new Error('existing-dsh-runtime-extension-conflict');
    fs.renameSync(stageRoot, target);
    return { migrated: true, runtimeVersion: packaged.manifest.runtimeVersion };
  } catch (error) {
    try { assertTreeHasNoReparsePoints(stageRoot); fs.rmSync(stageRoot, { recursive: true, force: true }); } catch (_) {}
    throw error;
  }
}

function assertTreeHasNoReparsePoints(root) {
  const stack = [path.resolve(root)];
  while (stack.length) {
    const current = stack.pop();
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error('runtime-package-reparse-point-denied');
    if (!stat.isDirectory()) continue;
    for (const name of fs.readdirSync(current)) stack.push(path.join(current, name));
  }
}

function assertNoReparsePath(root, candidate) {
  const base = path.resolve(root);
  const full = path.resolve(candidate);
  if (!pathInside(base, full)) throw new Error('legacy-runtime-path-outside-root');
  const relative = path.relative(base, full);
  let current = base;
  const paths = [base];
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    paths.push(current);
  }
  for (const item of paths) {
    const stat = fs.lstatSync(item);
    if (stat.isSymbolicLink()) throw new Error('runtime-package-reparse-point-denied');
  }
}

function validateInstalledDshRuntime(runtimeRoot, options) {
  options = options || {};
  const runtimeManifest = readRuntimeManifest(runtimeRoot, options);
  const wrapperPath = path.join(runtimeRoot, WRAPPER_NAME);
  const installPath = path.join(runtimeRoot, 'install-manifest.json');
  const wrapperBytes = fs.readFileSync(wrapperPath);
  const wrapper = JSON.parse(wrapperBytes.toString('utf8'));
  validateProductCompatibility(wrapper, options);
  const install = JSON.parse(fs.readFileSync(installPath, 'utf8'));
  if (!install || install.schema !== 'internalbeyond.dsh-runtime-install'
    || install.runtimeVersion !== runtimeManifest.runtimeVersion || install.sourceRevision !== runtimeManifest.sourceRevision
    || install.packageManifestSha256 !== sha256(wrapperBytes)
    || install.runtimeManifestSha256 !== hashFile(path.join(runtimeRoot, 'runtime-manifest.json'))
    || wrapper.productionArtifacts.fileCount !== runtimeManifest.productionArtifactFiles
    || wrapper.productionArtifacts.bytes !== runtimeManifest.productionArtifactBytes) {
    throw new Error('installed-runtime-metadata-mismatch');
  }
  return { runtimeVersion: runtimeManifest.runtimeVersion, sourceRevision: runtimeManifest.sourceRevision,
    install: install, manifest: runtimeManifest, packageManifest: wrapper };
}

function validateProductCompatibility(manifest, options) {
  options = options || {};
  const expectedRuntimeVersion = String(options.expectedRuntimeVersion
    || options.expectedRelease && options.expectedRelease.runtimeVersion || DSH_RUNTIME_VERSION);
  if (!manifest || manifest.schema !== SCHEMA || manifest.schemaVersion !== 1
    || manifest.runtimeVersion !== expectedRuntimeVersion || manifest.sourceRevision !== DSH_REVISION
    || manifest.target !== TARGET || Number(manifest.protocolVersion) !== 1
    || !manifest.compatibility || !manifest.productionArtifacts) throw new Error('package-compatibility-invalid');
  if (options.expectedRelease) {
    const release = options.expectedRelease;
    if (release.runtimeVersion !== manifest.runtimeVersion || release.sourceRevision !== manifest.sourceRevision
      || release.target !== manifest.target || release.protocolVersion !== Number(manifest.protocolVersion)
      || release.compatibility.minimumProductVersion !== manifest.compatibility.minimumProductVersion
      || release.compatibility.maximumProductVersionExclusive !== manifest.compatibility.maximumProductVersionExclusive
      || release.compatibility.bundledNodeVersion !== manifest.compatibility.bundledNodeVersion
      || release.compatibility.dshNodeEngine !== manifest.compatibility.dshNodeEngine
      || release.productionArtifacts.fileCount !== manifest.productionArtifacts.fileCount
      || release.productionArtifacts.bytes !== manifest.productionArtifacts.bytes
      || release.productionArtifacts.webFrontendSha256 !== manifest.productionArtifacts.webFrontendSha256) {
      throw new Error('runtime-release-package-mismatch');
    }
  }
  const productVersion = String(options.productVersion || '');
  const min = compareVersion(productVersion, manifest.compatibility && manifest.compatibility.minimumProductVersion);
  const max = compareVersion(productVersion, manifest.compatibility && manifest.compatibility.maximumProductVersionExclusive);
  if (min == null || max == null || min < 0 || max >= 0) throw new Error('package-product-version-incompatible');
  const bundledNodeVersion = String(options.nodeVersion || '');
  if (!bundledNodeVersion || !dshNodeEngineSupports(bundledNodeVersion)
    || manifest.compatibility.dshNodeEngine !== DSH_NODE_ENGINE
    || !dshNodeEngineSupports(manifest.compatibility.bundledNodeVersion)) {
    throw new Error('package-node-version-incompatible');
  }
  if (!Array.isArray(manifest.files) || manifest.files.length < 1 || manifest.files.length > MAX_FILES
    || !Number.isSafeInteger(manifest.totalBytes) || manifest.totalBytes < 1 || manifest.totalBytes > MAX_UNPACKED_BYTES) {
    throw new Error('package-file-manifest-invalid');
  }
  let totalBytes = 0;
  const names = new Set();
  for (const item of manifest.files) {
    if (!item || !safePackagePath(item.path) || !item.path.startsWith('runtime/')
      || !Number.isSafeInteger(item.bytes) || item.bytes < 0 || item.bytes > MAX_FILE_BYTES
      || !/^[a-f0-9]{64}$/i.test(String(item.sha256 || ''))) throw new Error('package-file-record-invalid');
    const key = item.path.toLowerCase();
    if (names.has(key)) throw new Error('package-file-path-duplicate');
    names.add(key);
    totalBytes += item.bytes;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_UNPACKED_BYTES) throw new Error('package-size-limit-exceeded');
  }
  if (totalBytes !== manifest.totalBytes || manifest.files.length !== manifest.fileCount) throw new Error('package-file-total-mismatch');
}

function readAt(fd, position, length) {
  if (!Number.isSafeInteger(position) || !Number.isSafeInteger(length) || position < 0 || length < 0) throw new Error('zip-offset-invalid');
  const buffer = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const read = fs.readSync(fd, buffer, offset, length - offset, position + offset);
    if (!read) throw new Error('zip-truncated');
    offset += read;
  }
  return buffer;
}

function decodeZipName(bytes, flags) {
  if ((flags & ZIP_UTF8) === 0 || (flags & ~ZIP_UTF8) !== 0) throw new Error('zip-flags-unsupported');
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const name = decoder.decode(bytes);
  if (!safePackagePath(name)) throw new Error('zip-path-unsafe');
  return name;
}

function readZipDirectory(archivePath) {
  const stat = fs.statSync(archivePath);
  if (!stat.isFile() || stat.size < 22 || stat.size > MAX_ARCHIVE_BYTES) throw new Error('zip-archive-size-invalid');
  const fd = fs.openSync(archivePath, 'r');
  try {
    const tailLength = Math.min(stat.size, 22 + 0xffff);
    const tailStart = stat.size - tailLength;
    const tail = readAt(fd, tailStart, tailLength);
    let eocd = -1;
    for (let cursor = tail.length - 22; cursor >= 0; cursor--) {
      if (tail.readUInt32LE(cursor) !== 0x06054b50) continue;
      const commentLength = tail.readUInt16LE(cursor + 20);
      if (cursor + 22 + commentLength === tail.length) { eocd = cursor; break; }
    }
    if (eocd < 0) throw new Error('zip-end-record-missing');
    const disk = tail.readUInt16LE(eocd + 4);
    const centralDisk = tail.readUInt16LE(eocd + 6);
    const diskEntries = tail.readUInt16LE(eocd + 8);
    const entryCount = tail.readUInt16LE(eocd + 10);
    const centralSize = tail.readUInt32LE(eocd + 12);
    const centralOffset = tail.readUInt32LE(eocd + 16);
    if (disk !== 0 || centralDisk !== 0 || diskEntries !== entryCount || entryCount < 1 || entryCount > MAX_FILES + 2
      || entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff
      || centralOffset + centralSize !== tailStart + eocd) throw new Error('zip-layout-unsupported');
    const central = readAt(fd, centralOffset, centralSize);
    const entries = [];
    let cursor = 0;
    let totalUnpacked = 0;
    const names = new Set();
    for (let index = 0; index < entryCount; index++) {
      if (cursor + 46 > central.length || central.readUInt32LE(cursor) !== 0x02014b50) throw new Error('zip-directory-invalid');
      const creator = central.readUInt16LE(cursor + 4) >>> 8;
      const flags = central.readUInt16LE(cursor + 8);
      const method = central.readUInt16LE(cursor + 10);
      const crc = central.readUInt32LE(cursor + 16);
      const compressedBytes = central.readUInt32LE(cursor + 20);
      const bytes = central.readUInt32LE(cursor + 24);
      const nameLength = central.readUInt16LE(cursor + 28);
      const extraLength = central.readUInt16LE(cursor + 30);
      const commentLength = central.readUInt16LE(cursor + 32);
      const startDisk = central.readUInt16LE(cursor + 34);
      const attributes = central.readUInt32LE(cursor + 38);
      const localOffset = central.readUInt32LE(cursor + 42);
      const next = cursor + 46 + nameLength + extraLength + commentLength;
      if (next > central.length || startDisk !== 0 || (method !== 0 && method !== 8)
        || compressedBytes === 0xffffffff || bytes === 0xffffffff || bytes > MAX_FILE_BYTES) throw new Error('zip-entry-unsupported');
      const name = decodeZipName(central.subarray(cursor + 46, cursor + 46 + nameLength), flags);
      const key = name.toLowerCase();
      if (names.has(key)) throw new Error('zip-entry-duplicate');
      names.add(key);
      if (creator === 3) {
        const fileType = (attributes >>> 16) & 0xf000;
        if (fileType !== 0 && fileType !== 0x8000) throw new Error('zip-link-or-special-file-denied');
      }
      totalUnpacked += bytes;
      if (!Number.isSafeInteger(totalUnpacked) || totalUnpacked > MAX_UNPACKED_BYTES) throw new Error('zip-unpacked-size-limit-exceeded');
      entries.push({ name, flags, method, crc, compressedBytes, bytes, localOffset, centralOffset });
      cursor = next;
    }
    if (cursor !== central.length) throw new Error('zip-directory-trailing-data');
    return { fd, size: stat.size, entries, totalUnpacked };
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}

function inflateEntryBuffer(fd, entry) {
  const local = readAt(fd, entry.localOffset, 30);
  if (local.readUInt32LE(0) !== 0x04034b50 || local.readUInt16LE(6) !== entry.flags
    || local.readUInt16LE(8) !== entry.method) throw new Error('zip-local-header-mismatch');
  if (local.readUInt16LE(6) & 0x0008) throw new Error('zip-data-descriptor-unsupported');
  const nameLength = local.readUInt16LE(26);
  const extraLength = local.readUInt16LE(28);
  const localName = decodeZipName(readAt(fd, entry.localOffset + 30, nameLength), entry.flags);
  if (localName !== entry.name) throw new Error('zip-local-name-mismatch');
  if (local.readUInt32LE(14) !== entry.crc || local.readUInt32LE(18) !== entry.compressedBytes
    || local.readUInt32LE(22) !== entry.bytes) throw new Error('zip-local-size-mismatch');
  const dataOffset = entry.localOffset + 30 + nameLength + extraLength;
  if (dataOffset + entry.compressedBytes > entry.centralOffset) throw new Error('zip-entry-overlaps-directory');
  const compressed = readAt(fd, dataOffset, entry.compressedBytes);
  const output = entry.method === 0 ? compressed : zlib.inflateRawSync(compressed, { maxOutputLength: entry.bytes + 1 });
  if (output.length !== entry.bytes || crc32(output) !== entry.crc) throw new Error('zip-entry-integrity-failed');
  return output;
}

function verifySumsText(text, manifest, wrapperBytes) {
  const expected = new Map(manifest.files.map(file => [file.path, String(file.sha256).toLowerCase()]));
  expected.set(WRAPPER_NAME, sha256(wrapperBytes));
  const lines = String(text || '').split(/\r?\n/).filter(Boolean);
  if (lines.length !== expected.size) throw new Error('package-checksum-list-invalid');
  const seen = new Set();
  for (const line of lines) {
    const match = line.match(/^([a-f0-9]{64})\s+\*?(.+)$/i);
    if (!match || !expected.has(match[2]) || expected.get(match[2]) !== match[1].toLowerCase() || seen.has(match[2])) {
      throw new Error('package-checksum-list-invalid');
    }
    seen.add(match[2]);
  }
}

function inspectOptionalRuntimeZip(archivePath, options) {
  const zip = readZipDirectory(archivePath);
  try {
    const byName = new Map(zip.entries.map(entry => [entry.name, entry]));
    const wrapperEntry = byName.get(WRAPPER_NAME);
    const sumsEntry = byName.get(SUMS_NAME);
    if (!wrapperEntry || !sumsEntry) throw new Error('package-manifest-missing');
    const wrapperBytes = inflateEntryBuffer(zip.fd, wrapperEntry);
    const manifest = JSON.parse(wrapperBytes.toString('utf8'));
    validateProductCompatibility(manifest, options);
    if (manifest.totalBytes !== zip.totalUnpacked - wrapperEntry.bytes - sumsEntry.bytes) throw new Error('package-archive-size-mismatch');
    const expectedPaths = new Set(manifest.files.map(file => file.path));
    for (const entry of zip.entries) {
      if (entry.name === WRAPPER_NAME || entry.name === SUMS_NAME) continue;
      if (!expectedPaths.delete(entry.name)) throw new Error('package-extra-or-missing-file');
      const record = manifest.files.find(file => file.path === entry.name);
      if (!record || record.bytes !== entry.bytes) throw new Error('package-file-size-mismatch');
    }
    if (expectedPaths.size) throw new Error('package-extra-or-missing-file');
    const sumsBytes = inflateEntryBuffer(zip.fd, sumsEntry);
    verifySumsText(sumsBytes.toString('utf8'), manifest, wrapperBytes);
    return { manifest, wrapperBytes, entries: zip.entries, archiveBytes: zip.size, archiveSha256: hashFile(archivePath) };
  } finally { fs.closeSync(zip.fd); }
}

async function extractOptionalRuntimeZip(archivePath, stagingRoot, options) {
  options = options || {};
  const inspected = inspectOptionalRuntimeZip(archivePath, options);
  const zip = readZipDirectory(archivePath);
  const byName = new Map(zip.entries.map(entry => [entry.name, entry]));
  const fileRecords = new Map(inspected.manifest.files.map(file => [file.path, file]));
  const files = inspected.manifest.files;
  let bytesWritten = 0;
  let zipStage = 'create-runtime-root';
  try {
    fs.mkdirSync(stagingRoot, { recursive: false });
    for (let index = 0; index < files.length; index++) {
      if (options.signal && options.signal.aborted) throw new Error('runtime-install-cancelled');
      zipStage = 'extract-runtime-file';
      const file = files[index];
      const entry = byName.get(file.path);
      if (!entry || !fileRecords.has(entry.name)) throw new Error('package-entry-missing');
      const data = inflateEntryBuffer(zip.fd, entry);
      if (sha256(data) !== file.sha256.toLowerCase()) throw new Error('package-file-hash-mismatch');
      const relative = file.path.slice('runtime/'.length);
      if (!file.path.startsWith('runtime/') || !safePackagePath(relative)) throw new Error('package-runtime-path-invalid');
      const target = path.resolve(stagingRoot, ...relative.split('/'));
      if (!pathInside(stagingRoot, target)) throw new Error('package-runtime-path-escapes-root');
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, data, { flag: 'wx' });
      bytesWritten += data.length;
      if (options && typeof options.onProgress === 'function') {
        options.onProgress({ phase: 'extracting', filesDone: index + 1, filesTotal: files.length,
          bytesDone: bytesWritten, bytesTotal: inspected.manifest.totalBytes });
      }
      if ((index & 31) === 31) await new Promise(resolve => setImmediate(resolve));
    }
    if (options.signal && options.signal.aborted) throw new Error('runtime-install-cancelled');
    zipStage = 'write-package-manifest';
    const wrapper = Buffer.from(inspected.wrapperBytes);
    fs.writeFileSync(path.join(stagingRoot, WRAPPER_NAME), wrapper, { flag: 'wx' });
    zipStage = 'write-package-checksums';
    const sums = inflateEntryBuffer(zip.fd, byName.get(SUMS_NAME));
    fs.writeFileSync(path.join(stagingRoot, SUMS_NAME), sums, { flag: 'wx' });
    zipStage = 'validate-extracted-runtime';
    const runtimeManifest = readRuntimeManifest(stagingRoot, { expectedRuntimeVersion: inspected.manifest.runtimeVersion });
    if (runtimeManifest.sourceRevision !== inspected.manifest.sourceRevision
      || Number(runtimeManifest.protocolVersion) !== inspected.manifest.protocolVersion
      || runtimeManifest.productionArtifactFiles !== inspected.manifest.productionArtifacts.fileCount
      || runtimeManifest.productionArtifactBytes !== inspected.manifest.productionArtifacts.bytes) {
      throw new Error('runtime-compatibility-mismatch');
    }
    return { manifest: inspected.manifest, runtimeManifest, archiveSha256: inspected.archiveSha256,
      archiveBytes: inspected.archiveBytes, bytesWritten };
  } catch (error) {
    try { error.optionalRuntimeStage = zipStage; } catch (_) {}
    try { fs.closeSync(zip.fd); } catch (_) {}
    throw error;
  } finally {
    try { fs.closeSync(zip.fd); } catch (_) {}
  }
}

function hashFile(filePath) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let bytes;
    while ((bytes = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, bytes));
  } finally { fs.closeSync(fd); }
  return hash.digest('hex');
}

module.exports = {
  SCHEMA, DSH_SCHEMA, DSH_REVISION, DSH_RUNTIME_VERSION, DSH_NODE_ENGINE, TARGET, WRAPPER_NAME, SUMS_NAME,
  MAX_ARCHIVE_BYTES, MAX_UNPACKED_BYTES, MAX_FILE_BYTES, MAX_FILES,
  crc32, sha256, compareVersion, pathInside, safePackagePath, readRuntimeManifest,
  validateProductCompatibility, productionFiles, createOptionalRuntimeManifest,
  patchLegacyRuntimeSources, refreshProductionArtifactStats, migrateLegacyRuntimeFolder,
  validateInstalledDshRuntime, inspectOptionalRuntimeZip, extractOptionalRuntimeZip, hashFile
};

if (require.main === module && process.argv.includes('--migrate-legacy')) {
  const args = process.argv.slice(2);
  function value(name) { const index = args.indexOf(name); return index >= 0 ? String(args[index + 1] || '') : ''; }
  try {
    const previousManifestPath = value('--previous-manifest');
    if (!previousManifestPath) throw new Error('legacy-runtime-payload-manifest-required');
    const previousManifest = JSON.parse(fs.readFileSync(previousManifestPath, 'utf8'));
    if (!previousManifest || previousManifest.schema !== 'internalbeyond.payload-manifest'
      || Number(previousManifest.version) !== 1 || !Array.isArray(previousManifest.files)
      || Number(previousManifest.count) !== previousManifest.files.length) {
      throw new Error('legacy-runtime-payload-manifest-invalid');
    }
    const allowedFiles = previousManifest.files.filter(file => String(file || '').replace(/\\/g, '/')
      .startsWith('runtime/dsh-runtime/'));
    const result = migrateLegacyRuntimeFolder(value('--source'), value('--target'), {
      productVersion: value('--product-version'), nodeVersion: value('--node-version') || process.version.replace(/^v/, ''),
      allowedFiles: allowedFiles
    });
    process.stdout.write(JSON.stringify({ ok: true, result: result }) + '\n');
  } catch (error) {
    process.stderr.write('legacy-dsh-runtime-migration-failed:' + String(error && error.message || 'unknown').slice(0, 160) + '\n');
    process.exitCode = 1;
  }
}
