'use strict';

/* Installs one verified optional DSH Runtime ZIP without touching Work Mode data. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { randomUUID } = require('node:crypto');
const { once } = require('node:events');
const { finished } = require('node:stream/promises');
const optionalRuntime = require('../../runtime/optional-dsh-runtime.js');
const releaseRuntime = require('../../runtime/dsh-runtime-release.js');

const LOCK_NAME = '.runtime-install.lock';
const INSTALL_METADATA = 'install-manifest.json';
const RELEASE_ATTESTATION = 'release-attestation.json';

function createDshRuntimeInstaller(options) {
  options = options || {};
  const localAppData = path.resolve(String(options.localAppData || process.env.LOCALAPPDATA || ''));
  const productVersion = String(options.productVersion || '');
  const nodeVersion = String(options.nodeVersion || process.version.replace(/^v/, ''));
  const expectedArchiveSha256 = String(options.expectedArchiveSha256 || '').toLowerCase();
  const releaseTrustConfig = options.releaseTrustConfig ? releaseRuntime.parseTrustConfig(options.releaseTrustConfig) : null;
  const testOnlyAllowHttpLoopback = options.testOnlyAllowHttpLoopback === true;
  const extensionRoot = path.join(localAppData, 'InternalBeyond', 'extensions', 'dsh-runtime');
  const runtimeRoot = path.join(extensionRoot, 'current');
  let activeTransaction = null;
  let cachedInstalled = null;

  function assertContained(anchor, target) {
    const base = path.resolve(anchor);
    const full = path.resolve(target);
    const relative = path.relative(base, full);
    if (!base || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
      throw new Error('runtime-extension-path-outside-local-app-data');
    }
    let current = base;
    const candidates = [base];
    for (const part of relative.split(path.sep).filter(Boolean)) {
      current = path.join(current, part);
      candidates.push(current);
    }
    for (const candidate of candidates) {
      try {
        const stat = fs.lstatSync(candidate);
        if (stat.isSymbolicLink()) throw new Error('runtime-extension-reparse-point-denied');
      } catch (error) {
        if (error && error.code !== 'ENOENT') throw error;
      }
    }
  }

  function cacheStamp() {
    try {
      const runtimeStat = fs.statSync(path.join(runtimeRoot, 'runtime-manifest.json'));
      const installStat = fs.statSync(path.join(runtimeRoot, INSTALL_METADATA));
      const packageStat = fs.statSync(path.join(runtimeRoot, optionalRuntime.WRAPPER_NAME));
      let attestationStat = null;
      try { attestationStat = fs.statSync(path.join(runtimeRoot, RELEASE_ATTESTATION)); } catch (_) {}
      return `${runtimeStat.size}:${runtimeStat.mtimeMs}:${installStat.size}:${installStat.mtimeMs}:${packageStat.size}:${packageStat.mtimeMs}:${attestationStat ? attestationStat.size + ':' + attestationStat.mtimeMs : ''}`;
    } catch (_) { return ''; }
  }

  function inspectInstalled(force) {
    if (!localAppData || process.platform !== 'win32' || process.arch !== 'x64') return { installed: false, error: 'unsupported-platform' };
    const stamp = cacheStamp();
    if (!stamp) { cachedInstalled = null; return { installed: false, error: 'runtime-not-installed' }; }
    if (!force && cachedInstalled && cachedInstalled.stamp === stamp) return cachedInstalled.result;
    try {
      assertContained(localAppData, extensionRoot);
      assertContained(extensionRoot, runtimeRoot);
      const installation = JSON.parse(fs.readFileSync(path.join(runtimeRoot, INSTALL_METADATA), 'utf8'));
      const packageManifest = JSON.parse(fs.readFileSync(path.join(runtimeRoot, optionalRuntime.WRAPPER_NAME), 'utf8'));
      let expectedRelease = null;
      let verifiedAttestation = null;
      if (installation && installation.source === 'online-install') {
        if (!releaseTrustConfig) throw new Error('runtime-release-trust-unavailable');
        const attestation = JSON.parse(fs.readFileSync(path.join(runtimeRoot, RELEASE_ATTESTATION), 'utf8'));
        verifiedAttestation = releaseRuntime.verifyInstallAttestation(attestation, releaseTrustConfig, {
          productVersion, nodeVersion, allowExpired: true, testOnlyAllowHttpLoopback: testOnlyAllowHttpLoopback
        });
        expectedRelease = verifiedAttestation.release;
        releaseRuntime.assertReleaseMatchesPackage(expectedRelease, packageManifest);
      }
      optionalRuntime.validateProductCompatibility(packageManifest, {
        productVersion, nodeVersion, expectedRelease: expectedRelease || undefined
      });
      const runtimeManifest = optionalRuntime.readRuntimeManifest(runtimeRoot, {
        expectedRuntimeVersion: installation && installation.runtimeVersion || optionalRuntime.DSH_RUNTIME_VERSION
      });
      const manifestPath = path.join(runtimeRoot, 'runtime-manifest.json');
      const runtimeManifestSha256 = optionalRuntime.hashFile(manifestPath);
      if (!installation || installation.schema !== 'internalbeyond.dsh-runtime-install'
        || !['zip-install', 'legacy-migration', 'online-install'].includes(installation.source)
        || (installation.source !== 'online-install' && installation.runtimeVersion !== optionalRuntime.DSH_RUNTIME_VERSION)
        || installation.sourceRevision !== optionalRuntime.DSH_REVISION
        || installation.runtimeManifestSha256 !== runtimeManifestSha256
        || installation.packageManifestSha256 !== optionalRuntime.sha256(Buffer.from(JSON.stringify(packageManifest, null, 2) + '\n'))
        || (installation.source === 'zip-install' && installation.archiveSha256 !== expectedArchiveSha256)
        || (installation.source === 'online-install' && (!verifiedAttestation
          || installation.archiveSha256 !== expectedRelease.archive.sha256
          || installation.releaseManifestSha256 !== verifiedAttestation.verified.envelopeSha256
          || installation.releaseKeyId !== verifiedAttestation.verified.keyId))
        || runtimeManifest.sourceRevision !== installation.sourceRevision) {
        throw new Error('installed-runtime-metadata-mismatch');
      }
      const result = {
        installed: true,
        runtimeVersion: installation.runtimeVersion,
        sourceRevision: installation.sourceRevision,
        archiveSha256: String(installation.archiveSha256 || ''),
        source: installation.source,
        installedAt: Number(installation.installedAt) || 0
      };
      cachedInstalled = { stamp, result };
      return result;
    } catch (error) {
      const result = { installed: false, error: String(error && error.message || 'runtime-validation-failed').slice(0, 80) };
      cachedInstalled = { stamp, result };
      return result;
    }
  }

  function describe() {
    const installed = inspectInstalled(false);
    return {
      installed: installed.installed === true,
      runtimeVersion: installed.runtimeVersion || optionalRuntime.DSH_RUNTIME_VERSION,
      sourceRevision: optionalRuntime.DSH_REVISION,
      source: installed.source || '',
      install: activeTransaction ? Object.assign({}, activeTransaction.publicState) : { phase: 'idle' },
      ...(installed.installed !== true && installed.error && installed.error !== 'runtime-not-installed'
        ? { installError: installed.error } : {})
    };
  }

  function writeError(error) {
    const code = String(error && error.message || 'runtime-install-failed');
    if (/^[a-z0-9-]{1,96}$/.test(code)) return code;
    const systemCode = String(error && error.code || '').toLowerCase();
    if (/^[a-z0-9_-]{1,32}$/.test(systemCode)) return 'io-' + systemCode.replace(/_/g, '-');
    const errorName = String(error && error.name || '').toLowerCase();
    return /^[a-z0-9-]{1,32}$/.test(errorName) && errorName !== 'error'
      ? 'runtime-' + errorName : 'runtime-install-failed';
  }

  async function acquireLock() {
    fs.mkdirSync(extensionRoot, { recursive: true });
    assertContained(localAppData, extensionRoot);
    const lockPath = path.join(extensionRoot, LOCK_NAME);
    try {
      const fd = fs.openSync(lockPath, 'wx', 0o600);
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }) + '\n');
      fs.closeSync(fd);
      return lockPath;
    } catch (error) {
      if (error && error.code === 'EEXIST') throw new Error('runtime-install-already-running');
      throw error;
    }
  }

  async function writeUpload(request, filePath, transaction) {
    const contentType = String(request.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (contentType !== 'application/zip') throw new Error('runtime-upload-content-type-invalid');
    const expected = Number(request.headers['content-length']);
    if (Number.isFinite(expected) && (expected <= 0 || expected > optionalRuntime.MAX_ARCHIVE_BYTES)) {
      throw new Error('runtime-upload-size-limit-exceeded');
    }
    const output = fs.createWriteStream(filePath, { flags: 'wx', mode: 0o600 });
    let bytes = 0;
    transaction.publicState = { phase: 'uploading', percent: 0, bytesDone: 0,
      bytesTotal: Number.isSafeInteger(expected) && expected > 0 ? expected : 0 };
    try {
      for await (const chunk of request) {
        bytes += chunk.length;
        if (bytes > optionalRuntime.MAX_ARCHIVE_BYTES) throw new Error('runtime-upload-size-limit-exceeded');
        if (!output.write(chunk)) await once(output, 'drain');
        transaction.publicState.bytesDone = bytes;
        if (transaction.publicState.bytesTotal > 0) {
          transaction.publicState.percent = Math.min(39, Math.floor((bytes / transaction.publicState.bytesTotal) * 39));
        }
      }
      output.end();
      await finished(output);
      if (bytes <= 0) throw new Error('runtime-upload-empty');
      if (transaction.publicState.bytesTotal && bytes !== transaction.publicState.bytesTotal) throw new Error('runtime-upload-length-mismatch');
      return bytes;
    } catch (error) {
      output.destroy();
      throw error;
    }
  }

  async function installFromRequest(request) {
    if (!localAppData || !productVersion) return { ok: false, error: 'runtime-install-environment-invalid' };
    if (!/^[a-f0-9]{64}$/i.test(expectedArchiveSha256)) return { ok: false, error: 'runtime-package-pin-unavailable' };
    const current = inspectInstalled(true);
    if (current.installed) return { ok: true, alreadyInstalled: true, runtimeVersion: current.runtimeVersion,
      archiveSha256: current.archiveSha256 };
    if (fs.existsSync(runtimeRoot)) return { ok: false, error: 'runtime-extension-conflict-preserved' };
    if (activeTransaction) return { ok: false, error: 'runtime-install-already-running' };

    const transaction = { id: randomUUID(), stageRoot: '', lockPath: '', publicState: { phase: 'preparing', percent: 0 } };
    activeTransaction = transaction;
    let committed = false;
    let finalizingStage = '';
    try {
      transaction.lockPath = await acquireLock();
      transaction.stageRoot = path.join(extensionRoot, '.install-' + transaction.id);
      fs.mkdirSync(transaction.stageRoot, { recursive: false });
      assertContained(extensionRoot, transaction.stageRoot);
      const archivePath = path.join(transaction.stageRoot, 'upload.zip');
      const uploadedBytes = await writeUpload(request, archivePath, transaction);
      transaction.publicState = { phase: 'verifying', percent: 40, bytesDone: uploadedBytes,
        bytesTotal: uploadedBytes, filesDone: 0, filesTotal: 0 };
      const inspected = optionalRuntime.inspectOptionalRuntimeZip(archivePath, { productVersion, nodeVersion });
      if (inspected.archiveSha256 !== expectedArchiveSha256) throw new Error('runtime-archive-sha256-mismatch');
      transaction.publicState = { phase: 'extracting', percent: 42, bytesDone: 0,
        bytesTotal: inspected.manifest.totalBytes, filesDone: 0, filesTotal: inspected.manifest.fileCount };
      const payloadRoot = path.join(transaction.stageRoot, 'runtime-root');
      const extracted = await optionalRuntime.extractOptionalRuntimeZip(archivePath, payloadRoot, {
        productVersion,
        nodeVersion,
        onProgress(progress) {
          const fraction = progress.bytesTotal > 0 ? progress.bytesDone / progress.bytesTotal : 0;
          transaction.publicState = {
            phase: 'extracting', percent: Math.min(94, 42 + Math.floor(fraction * 52)),
            bytesDone: progress.bytesDone, bytesTotal: progress.bytesTotal,
            filesDone: progress.filesDone, filesTotal: progress.filesTotal
          };
        }
      });
      transaction.publicState = { phase: 'finalizing', percent: 95, filesDone: extracted.manifest.fileCount,
        filesTotal: extracted.manifest.fileCount, bytesDone: extracted.bytesWritten, bytesTotal: extracted.manifest.totalBytes };
      finalizingStage = 'runtime-manifest-path';
      const runtimeManifestPath = path.join(payloadRoot, 'runtime-manifest.json');
      finalizingStage = 'runtime-manifest-hash';
      const runtimeManifestSha256 = optionalRuntime.hashFile(runtimeManifestPath);
      finalizingStage = 'install-marker-content';
      const installation = {
        schema: 'internalbeyond.dsh-runtime-install',
        source: 'zip-install',
        runtimeVersion: extracted.manifest.runtimeVersion,
        sourceRevision: extracted.manifest.sourceRevision,
        productVersion: productVersion,
        nodeVersion: nodeVersion,
        archiveSha256: extracted.archiveSha256,
        packageManifestSha256: optionalRuntime.hashFile(path.join(payloadRoot, optionalRuntime.WRAPPER_NAME)),
        runtimeManifestSha256: runtimeManifestSha256,
        installedAt: Date.now()
      };
      finalizingStage = 'write-install-marker';
      fs.writeFileSync(path.join(payloadRoot, INSTALL_METADATA), JSON.stringify(installation, null, 2) + '\n', { flag: 'wx' });
      finalizingStage = 'extension-root-check';
      transaction.publicState = { phase: 'committing', percent: 97, filesDone: extracted.manifest.fileCount,
        filesTotal: extracted.manifest.fileCount, bytesDone: extracted.bytesWritten, bytesTotal: extracted.manifest.totalBytes };
      assertContained(localAppData, extensionRoot);
      if (fs.existsSync(runtimeRoot)) throw new Error('runtime-extension-conflict-preserved');
      finalizingStage = 'atomic-runtime-rename';
      fs.renameSync(payloadRoot, runtimeRoot);
      committed = true;
      cachedInstalled = null;
      finalizingStage = 'post-install-verification';
      const verified = inspectInstalled(true);
      if (!verified.installed) {
        try { fs.rmSync(runtimeRoot, { recursive: true, force: true }); } catch (_) {}
        committed = false;
        cachedInstalled = null;
        throw new Error(verified.error || 'runtime-install-postcheck-failed');
      }
      transaction.publicState = { phase: 'complete', percent: 100,
        filesDone: extracted.manifest.fileCount, filesTotal: extracted.manifest.fileCount,
        bytesDone: extracted.bytesWritten, bytesTotal: extracted.manifest.totalBytes };
      return { ok: true, installed: true, runtimeVersion: verified.runtimeVersion,
        sourceRevision: verified.sourceRevision, archiveSha256: verified.archiveSha256,
        fileCount: extracted.manifest.fileCount, bytes: extracted.manifest.totalBytes };
    } catch (error) {
      const failurePhase = String(transaction.publicState && transaction.publicState.phase || 'unknown');
      const failureFilesDone = Number(transaction.publicState && transaction.publicState.filesDone) || 0;
      const failureBytesDone = Number(transaction.publicState && transaction.publicState.bytesDone) || 0;
      const errorCode = writeError(error);
      const substage = String(error && error.optionalRuntimeStage || finalizingStage || '');
      transaction.publicState = { phase: 'failed', percent: 0, error: errorCode,
        failedPhase: failurePhase, substage: substage,
        filesDone: failureFilesDone, bytesDone: failureBytesDone };
      return { ok: false, error: errorCode, failedPhase: failurePhase,
        substage: substage,
        filesDone: failureFilesDone, bytesDone: failureBytesDone, rolledBack: committed === false };
    } finally {
      if (transaction.stageRoot && fs.existsSync(transaction.stageRoot)) {
        try {
          assertContained(extensionRoot, transaction.stageRoot);
          fs.rmSync(transaction.stageRoot, { recursive: true, force: true });
        } catch (_) { /* failed transaction is reported; unrelated extension paths are never traversed */ }
      }
      if (transaction.lockPath) { try { fs.unlinkSync(transaction.lockPath); } catch (_) {} }
      const finish = activeTransaction;
      setTimeout(() => { if (activeTransaction === finish) activeTransaction = null; }, 15000).unref();
    }
  }

  function installInProgress() { return !!activeTransaction; }

  if (localAppData) {
    try { fs.mkdirSync(extensionRoot, { recursive: true }); } catch (_) {}
  }
  return Object.freeze({
    extensionRoot,
    runtimeRoot,
    describe,
    isInstalled: () => inspectInstalled(false).installed === true,
    installInProgress,
    installFromRequest
  });
}

module.exports = createDshRuntimeInstaller;
module.exports.createDshRuntimeInstaller = createDshRuntimeInstaller;
module.exports.INSTALL_METADATA = INSTALL_METADATA;
