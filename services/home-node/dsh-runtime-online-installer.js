'use strict';

/* Online DSH Runtime delivery. Package verification and extraction reuse P35.1. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { randomUUID } = require('node:crypto');
const optionalRuntime = require('../../runtime/optional-dsh-runtime.js');
const releaseRuntime = require('../../runtime/dsh-runtime-release.js');

const LOCK_NAME = '.runtime-install.lock';
const INSTALL_METADATA = 'install-manifest.json';
const RELEASE_ATTESTATION = 'release-attestation.json';

function swapRuntimeDirectories(options) {
  const currentRoot = path.resolve(options.currentRoot);
  const payloadRoot = path.resolve(options.payloadRoot);
  const backupRoot = path.resolve(options.backupRoot);
  const renameSync = options.renameSync || fs.renameSync;
  const removeTree = options.removeTree || fs.rmSync;
  const exists = options.existsSync || fs.existsSync;
  let previousMoved = false;
  let candidateMoved = false;
  try {
    if (options.previousInstalled) {
      if (!exists(currentRoot)) throw new Error('runtime-extension-conflict-preserved');
      renameSync(currentRoot, backupRoot);
      previousMoved = true;
    } else if (exists(currentRoot)) {
      throw new Error('runtime-extension-conflict-preserved');
    }
    renameSync(payloadRoot, currentRoot);
    candidateMoved = true;
    return { previousMoved: previousMoved, candidateMoved: candidateMoved, backupRoot: backupRoot };
  } catch (error) {
    let restored = false;
    try {
      if (candidateMoved && exists(currentRoot)) removeTree(currentRoot, { recursive: true, force: true });
      if (previousMoved && exists(backupRoot) && !exists(currentRoot)) renameSync(backupRoot, currentRoot);
      restored = !previousMoved || exists(currentRoot);
    } catch (_) { error = new Error('runtime-upgrade-rollback-failed'); }
    try { error.runtimeSwapRolledBack = { previousMoved: previousMoved, candidateMoved: candidateMoved, restored: restored }; } catch (_) {}
    throw error;
  }
}

function createDshRuntimeOnlineInstaller(options) {
  options = options || {};
  const localAppDataInput = String(options.localAppData || process.env.LOCALAPPDATA || '');
  const localAppData = localAppDataInput ? path.resolve(localAppDataInput) : '';
  const extensionRoot = options.extensionRoot ? path.resolve(options.extensionRoot)
    : path.join(localAppData, 'InternalBeyond', 'extensions', 'dsh-runtime');
  const runtimeRoot = options.runtimeRoot ? path.resolve(options.runtimeRoot) : path.join(extensionRoot, 'current');
  const productVersion = String(options.productVersion || '');
  const nodeVersion = String(options.nodeVersion || process.version.replace(/^v/, ''));
  const runtimeInstaller = options.runtimeInstaller || null;
  const trustConfig = options.releaseTrustConfig ? releaseRuntime.parseTrustConfig(options.releaseTrustConfig) : null;
  const manifestUrl = options.manifestUrl;
  const fetchImpl = options.fetchImpl;
  const testOnlyAllowHttpLoopback = options.testOnlyAllowHttpLoopback === true;
  const testOnlyAllowSameVersionReplacement = options.testOnlyAllowSameVersionReplacement === true;
  const fileOps = options.testFileOps || {};
  const renameSync = typeof fileOps.renameSync === 'function' ? fileOps.renameSync : fs.renameSync;
  let active = null;
  let lastState = { phase: 'idle' };
  let lifecycle = options.upgradeLifecycle || null;

  function assertContained(anchor, target) {
    const base = path.resolve(anchor);
    const full = path.resolve(target);
    const relative = path.relative(base, full);
    if (!base || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
      throw new Error('runtime-extension-path-outside-local-app-data');
    }
    let current = base;
    for (const part of relative.split(path.sep).filter(Boolean)) {
      current = path.join(current, part);
      try {
        if (fs.lstatSync(current).isSymbolicLink()) throw new Error('runtime-extension-reparse-point-denied');
      } catch (error) { if (error && error.code !== 'ENOENT') throw error; }
    }
  }

  function installedState() {
    if (!runtimeInstaller || typeof runtimeInstaller.describe !== 'function') return { installed: false };
    const state = runtimeInstaller.describe();
    return { installed: state.installed === true, runtimeVersion: String(state.runtimeVersion || ''),
      archiveSha256: String(state.archiveSha256 || ''), source: String(state.source || '') };
  }

  function writeError(error, phase) {
    if (active && active.controller.signal.aborted) return 'runtime-download-cancelled';
    const message = String(error && error.message || '');
    if (/^[a-z0-9-]{1,96}$/.test(message)) return message;
    const causeCode = String(error && error.cause && error.cause.code || error && error.code || '').toLowerCase();
    if (/^(?:econn|enotfound|eai_again|etimedout|ehost|epipe|und_err|err_socket|econnreset)/.test(causeCode)) {
      return 'runtime-download-interrupted';
    }
    if (error && (error.name === 'AbortError' || error.name === 'TypeError')) {
      return phase === 'discovering' ? 'runtime-release-network-failed' : 'runtime-download-interrupted';
    }
    return 'runtime-online-install-failed';
  }

  function describe() {
    return {
      configured: !!trustConfig,
      phase: active ? active.publicState.phase : lastState.phase,
      install: Object.assign({}, active ? active.publicState : lastState),
      canCancel: !!(active && !['committing', 'health-check', 'complete', 'failed', 'cancelled']
        .includes(active.publicState.phase))
    };
  }

  async function discoverOnlineRuntimes() {
    if (!trustConfig) return { ok: false, error: 'runtime-release-trust-unavailable', releases: [] };
    if (!localAppData || !productVersion || !runtimeInstaller) {
      return { ok: false, error: 'runtime-install-environment-invalid', releases: [] };
    }
    try {
      const fetched = await releaseRuntime.fetchSignedIndex({ trustConfig, manifestUrl, productVersion, nodeVersion,
        fetchImpl, testOnlyAllowHttpLoopback });
      const installed = installedState();
      const releases = fetched.index.releases.filter(release => release.compatible
        && (!installed.installed || releaseRuntime.compareSemver(release.runtimeVersion, installed.runtimeVersion) > 0))
        .map(release => ({ runtimeVersion: release.runtimeVersion, target: release.target,
          archiveBytes: release.archive.bytes, sourceRevision: release.sourceRevision,
          publishedAt: release.publishedAt, notes: release.notes }));
      return { ok: true, channel: fetched.index.channel, keyId: fetched.verified.keyId,
        manifestSha256: fetched.verified.envelopeSha256, generatedAt: fetched.index.generatedAt,
        expiresAt: fetched.index.expiresAt, installedVersion: installed.runtimeVersion,
        releases: releases, upToDate: installed.installed && releases.length === 0 };
    } catch (error) {
      return { ok: false, error: writeError(error, 'discovering'), releases: [] };
    }
  }

  async function acquireLock() {
    fs.mkdirSync(extensionRoot, { recursive: true });
    assertContained(localAppData, extensionRoot);
    const lockPath = path.join(extensionRoot, LOCK_NAME);
    try {
      const fd = fs.openSync(lockPath, 'wx', 0o600);
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, at: Date.now(), source: 'online-runtime' }) + '\n');
      fs.closeSync(fd);
      return lockPath;
    } catch (error) {
      if (error && error.code === 'EEXIST') throw new Error('runtime-install-already-running');
      throw error;
    }
  }

  function createTransaction(version) {
    if (active || (runtimeInstaller && runtimeInstaller.installInProgress && runtimeInstaller.installInProgress())) {
      throw new Error('runtime-install-already-running');
    }
    const transaction = { id: randomUUID(), runtimeVersion: version, stageRoot: '', lockPath: '',
      controller: new AbortController(), publicState: { phase: 'discovering', percent: 0, runtimeVersion: version } };
    active = transaction;
    return transaction;
  }

  async function cleanup(transaction) {
    if (transaction.stageRoot && fs.existsSync(transaction.stageRoot)) {
      try { assertContained(extensionRoot, transaction.stageRoot); fs.rmSync(transaction.stageRoot, { recursive: true, force: true }); }
      catch (_) { /* cleanup only follows a transaction-owned, contained staging path */ }
    }
    if (transaction.lockPath) { try { fs.unlinkSync(transaction.lockPath); } catch (_) {} }
    lastState = Object.assign({}, transaction.publicState);
    if (active === transaction) active = null;
  }

  async function rollbackSwap(transaction, backupRoot, previousMoved, candidateMoved, upgradeBegun) {
    if (upgradeBegun && lifecycle && typeof lifecycle.rollbackUpgrade === 'function') {
      try { await lifecycle.rollbackUpgrade(); } catch (_) {}
    }
    try {
      if (candidateMoved && fs.existsSync(runtimeRoot)) {
        assertContained(extensionRoot, runtimeRoot);
        fs.rmSync(runtimeRoot, { recursive: true, force: true });
      }
      if (previousMoved && fs.existsSync(backupRoot) && !fs.existsSync(runtimeRoot)) {
        assertContained(extensionRoot, backupRoot);
        renameSync(backupRoot, runtimeRoot);
      }
      if (previousMoved && !fs.existsSync(runtimeRoot)) throw new Error('runtime-upgrade-rollback-failed');
    } catch (_) { throw new Error('runtime-upgrade-rollback-failed'); }
    if (upgradeBegun && lifecycle && typeof lifecycle.finishUpgrade === 'function') {
      await lifecycle.finishUpgrade({ restored: previousMoved });
    }
    transaction.publicState = Object.assign({}, transaction.publicState, { rolledBack: previousMoved });
  }

  async function commitRuntime(transaction, payloadRoot, priorInstalled) {
    const backupRoot = path.join(extensionRoot, '.previous-' + transaction.id);
    let upgradeBegun = false;
    let previousMoved = false;
    let candidateMoved = false;
    try {
      if (transaction.controller.signal.aborted) throw new Error('runtime-download-cancelled');
      assertContained(localAppData, extensionRoot);
      if (priorInstalled) {
        if (lifecycle && typeof lifecycle.beginUpgrade === 'function') {
          const begun = await lifecycle.beginUpgrade();
          if (!begun || begun.ok !== true) throw new Error(String(begun && begun.error || 'dsh-runtime-upgrade-busy'));
        }
        upgradeBegun = true;
      }
      if (transaction.controller.signal.aborted) throw new Error('runtime-download-cancelled');
      const swapped = swapRuntimeDirectories({ currentRoot: runtimeRoot, payloadRoot: payloadRoot,
        backupRoot: backupRoot, previousInstalled: priorInstalled, renameSync: renameSync });
      previousMoved = swapped.previousMoved;
      candidateMoved = swapped.candidateMoved;
      if (!runtimeInstaller.isInstalled()) throw new Error(runtimeInstaller.describe().installError || 'runtime-install-postcheck-failed');
      if (priorInstalled && lifecycle && typeof lifecycle.verifyUpgrade === 'function') {
        transaction.publicState = Object.assign({}, transaction.publicState, { phase: 'health-check', percent: 99 });
        const health = await lifecycle.verifyUpgrade();
        if (!health || health.ok !== true) throw new Error(String(health && health.error || 'runtime-upgrade-health-check-failed'));
      }
      if (priorInstalled && lifecycle && typeof lifecycle.finishUpgrade === 'function') {
        await lifecycle.finishUpgrade({ restored: false });
      }
      if (previousMoved && fs.existsSync(backupRoot)) {
        try { fs.rmSync(backupRoot, { recursive: true, force: true }); } catch (_) { /* an old private backup is harmless */ }
      }
      return runtimeInstaller.describe();
    } catch (error) {
      if (error && error.runtimeSwapRolledBack) {
        if (upgradeBegun && lifecycle && typeof lifecycle.finishUpgrade === 'function') {
          await lifecycle.finishUpgrade({ restored: error.runtimeSwapRolledBack.restored === true });
        }
        throw error;
      }
      await rollbackSwap(transaction, backupRoot, previousMoved, candidateMoved, upgradeBegun);
      throw error;
    }
  }

  async function runInstall(transaction, requestedVersion) {
    let phase = 'discovering';
    try {
      if (!trustConfig || !runtimeInstaller || !localAppData || !productVersion) {
        throw new Error('runtime-release-trust-unavailable');
      }
      const fetched = await releaseRuntime.fetchSignedIndex({ trustConfig, manifestUrl, productVersion, nodeVersion,
        fetchImpl, testOnlyAllowHttpLoopback, signal: transaction.controller.signal });
      const release = fetched.index.releases.find(item => item.runtimeVersion === requestedVersion);
      if (!release) throw new Error('runtime-release-version-not-found');
      if (!release.compatible) throw new Error(release.incompatibility);
      const installed = installedState();
      if (!installed.installed && fs.existsSync(runtimeRoot)) throw new Error('runtime-extension-conflict-preserved');
      if (installed.installed) {
        const relation = releaseRuntime.compareSemver(release.runtimeVersion, installed.runtimeVersion);
        if (relation === 0 && release.archive.sha256 === installed.archiveSha256
          && !testOnlyAllowSameVersionReplacement) {
          transaction.publicState = { phase: 'complete', percent: 100, runtimeVersion: installed.runtimeVersion, alreadyInstalled: true };
          return { ok: true, alreadyInstalled: true, runtimeVersion: installed.runtimeVersion,
            archiveSha256: installed.archiveSha256 };
        }
        if (relation == null || relation < 0) throw new Error('runtime-downgrade-denied');
        if (relation === 0 && !testOnlyAllowSameVersionReplacement) throw new Error('runtime-release-version-conflict');
      }
      transaction.publicState = { phase: 'preparing', percent: 0, runtimeVersion: release.runtimeVersion,
        archiveBytes: release.archive.bytes };
      transaction.lockPath = await acquireLock();
      transaction.stageRoot = path.join(extensionRoot, '.online-' + transaction.id);
      fs.mkdirSync(transaction.stageRoot, { recursive: false });
      assertContained(extensionRoot, transaction.stageRoot);
      const archivePath = path.join(transaction.stageRoot, 'download.zip');
      phase = 'downloading';
      transaction.publicState = { phase: phase, percent: 0, runtimeVersion: release.runtimeVersion,
        bytesDone: 0, bytesTotal: release.archive.bytes };
      await releaseRuntime.downloadArchive(release, archivePath, {
        trustConfig, fetchImpl, testOnlyAllowHttpLoopback, signal: transaction.controller.signal,
        onProgress(progress) {
          transaction.publicState = Object.assign({}, transaction.publicState, {
            phase: 'downloading', percent: progress.percent,
            bytesDone: progress.bytesDone, bytesTotal: progress.bytesTotal
          });
        }
      });
      if (transaction.controller.signal.aborted) throw new Error('runtime-download-cancelled');
      phase = 'verifying';
      transaction.publicState = Object.assign({}, transaction.publicState, { phase: phase, percent: 40,
        bytesDone: release.archive.bytes, bytesTotal: release.archive.bytes });
      const inspected = optionalRuntime.inspectOptionalRuntimeZip(archivePath, {
        productVersion, nodeVersion, expectedRelease: release
      });
      if (inspected.archiveSha256 !== release.archive.sha256) throw new Error('runtime-archive-sha256-mismatch');
      transaction.publicState = { phase: 'extracting', percent: 42, runtimeVersion: release.runtimeVersion,
        bytesDone: 0, bytesTotal: inspected.manifest.totalBytes,
        filesDone: 0, filesTotal: inspected.manifest.fileCount };
      const payloadRoot = path.join(transaction.stageRoot, 'runtime-root');
      const extracted = await optionalRuntime.extractOptionalRuntimeZip(archivePath, payloadRoot, {
        productVersion, nodeVersion, expectedRelease: release, signal: transaction.controller.signal,
        onProgress(progress) {
          const fraction = progress.bytesTotal > 0 ? progress.bytesDone / progress.bytesTotal : 0;
          transaction.publicState = Object.assign({}, transaction.publicState, {
            phase: 'extracting', percent: Math.min(94, 42 + Math.floor(fraction * 52)),
            bytesDone: progress.bytesDone, bytesTotal: progress.bytesTotal,
            filesDone: progress.filesDone, filesTotal: progress.filesTotal
          });
        }
      });
      if (transaction.controller.signal.aborted) throw new Error('runtime-download-cancelled');
      const attestation = {
        schema: 'internalbeyond.dsh-runtime-release-attestation', schemaVersion: 1,
        keyId: fetched.verified.keyId, manifestSha256: fetched.verified.envelopeSha256,
        runtimeVersion: release.runtimeVersion, archiveSha256: release.archive.sha256,
        envelope: fetched.verified.rawBytes.toString('base64')
      };
      fs.writeFileSync(path.join(payloadRoot, RELEASE_ATTESTATION), JSON.stringify(attestation, null, 2) + '\n', { flag: 'wx' });
      const installation = {
        schema: 'internalbeyond.dsh-runtime-install', source: 'online-install',
        runtimeVersion: release.runtimeVersion, sourceRevision: release.sourceRevision,
        productVersion: productVersion, nodeVersion: nodeVersion,
        archiveSha256: release.archive.sha256,
        packageManifestSha256: optionalRuntime.hashFile(path.join(payloadRoot, optionalRuntime.WRAPPER_NAME)),
        runtimeManifestSha256: optionalRuntime.hashFile(path.join(payloadRoot, 'runtime-manifest.json')),
        releaseManifestSha256: fetched.verified.envelopeSha256, releaseKeyId: fetched.verified.keyId,
        installedAt: Date.now()
      };
      fs.writeFileSync(path.join(payloadRoot, INSTALL_METADATA), JSON.stringify(installation, null, 2) + '\n', { flag: 'wx' });
      transaction.publicState = { phase: 'committing', percent: 97, runtimeVersion: release.runtimeVersion,
        filesDone: extracted.manifest.fileCount, filesTotal: extracted.manifest.fileCount,
        bytesDone: extracted.bytesWritten, bytesTotal: extracted.manifest.totalBytes };
      const replaced = await commitRuntime(transaction, payloadRoot, installed.installed === true);
      transaction.publicState = { phase: 'complete', percent: 100, runtimeVersion: release.runtimeVersion,
        archiveSha256: release.archive.sha256, filesDone: extracted.manifest.fileCount,
        filesTotal: extracted.manifest.fileCount, bytesDone: extracted.bytesWritten,
        bytesTotal: extracted.manifest.totalBytes };
      return { ok: true, installed: true, runtimeVersion: replaced.runtimeVersion,
        archiveSha256: release.archive.sha256, sourceRevision: release.sourceRevision,
        fileCount: extracted.manifest.fileCount, bytes: extracted.manifest.totalBytes };
    } catch (error) {
      const cancelled = transaction.controller.signal.aborted;
      transaction.publicState = {
        phase: cancelled ? 'cancelled' : 'failed', percent: 0,
        error: writeError(error, phase), failedPhase: String(transaction.publicState.phase || phase),
        runtimeVersion: requestedVersion, rolledBack: true,
        bytesDone: Number(transaction.publicState.bytesDone) || 0,
        filesDone: Number(transaction.publicState.filesDone) || 0
      };
      return { ok: false, error: transaction.publicState.error, cancelled: cancelled,
        rolledBack: true, failedPhase: transaction.publicState.failedPhase };
    } finally {
      if (transaction.stageRoot && fs.existsSync(transaction.stageRoot)) {
        try { assertContained(extensionRoot, transaction.stageRoot); fs.rmSync(transaction.stageRoot, { recursive: true, force: true }); } catch (_) {}
      }
      if (transaction.lockPath) { try { fs.unlinkSync(transaction.lockPath); } catch (_) {} }
      lastState = Object.assign({}, transaction.publicState);
      if (active === transaction) active = null;
    }
  }

  function startOnlineInstall(runtimeVersion) {
    if (!trustConfig) return { ok: false, error: 'runtime-release-trust-unavailable' };
    const version = String(runtimeVersion || '');
    if (!releaseRuntime.parseSemver(version)) return { ok: false, error: 'runtime-release-version-invalid' };
    let transaction;
    try { transaction = createTransaction(version); }
    catch (error) { return { ok: false, error: writeError(error) }; }
    transaction.task = runInstall(transaction, version);
    return { ok: true, started: true, installId: transaction.id, runtimeVersion: version };
  }

  function cancelOnlineInstall() {
    if (!active) return { ok: false, error: 'runtime-online-install-not-running' };
    if (['committing', 'health-check'].includes(active.publicState.phase)) {
      return { ok: false, error: 'runtime-install-cannot-cancel' };
    }
    active.controller.abort();
    return { ok: true, cancelled: true, installId: active.id };
  }

  function setUpgradeLifecycle(hooks) {
    if (active) return false;
    lifecycle = hooks && typeof hooks === 'object' ? hooks : null;
    return true;
  }

  if (localAppData) {
    try { fs.mkdirSync(extensionRoot, { recursive: true }); } catch (_) {}
  }
  return Object.freeze({
    extensionRoot, runtimeRoot, describe, discoverOnlineRuntimes,
    startOnlineInstall, cancelOnlineInstall, setUpgradeLifecycle
  });
}

module.exports = createDshRuntimeOnlineInstaller;
module.exports.createDshRuntimeOnlineInstaller = createDshRuntimeOnlineInstaller;
module.exports.LOCK_NAME = LOCK_NAME;
module.exports.swapRuntimeDirectories = swapRuntimeDirectories;
