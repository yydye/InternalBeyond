'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const createManager = require('../services/home-node/qq-napcat-manager.js');

const assetName = createManager.constants.ASSET_NAME;
const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let value = n;
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
    table[n] = value >>> 0;
  }
  return table;
})();

function crc32(input) {
  let value = 0xffffffff;
  for (const byte of input) value = crcTable[(value ^ byte) & 255] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function makeZip(entries) {
  const local = [], central = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data || '');
    const packed = zlib.deflateRawSync(data);
    const crc = crc32(data);
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x0800, 6);
    localHeader.writeUInt16LE(8, 8);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(packed.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(name.length, 26);
    const record = Buffer.concat([localHeader, name, packed]);
    local.push(record);
    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE((3 << 8) | 20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt16LE(8, 10);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(packed.length, 20);
    centralHeader.writeUInt32LE(data.length, 24);
    centralHeader.writeUInt16LE(name.length, 28);
    centralHeader.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([centralHeader, name]));
    offset += record.length;
  }
  const localBytes = Buffer.concat(local);
  const centralBytes = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(localBytes.length, 16);
  return Buffer.concat([localBytes, centralBytes, end]);
}

function makePeX64Stub() {
  const data = Buffer.alloc(512);
  data.write('MZ', 0, 'ascii');
  data.writeUInt32LE(0x80, 0x3c);
  data.writeUInt32LE(0x00004550, 0x80);
  data.writeUInt16LE(0x8664, 0x84);
  return data;
}

const zipFixture = makeZip([
  { name: 'node.exe', data: makePeX64Stub() },
  { name: 'index.js', data: 'require("./napcat/napcat.mjs");' },
  { name: 'wrapper.node', data: 'native-module-fixture' },
  { name: 'package.json', data: '{"name":"napcat-node-shell"}' },
  { name: 'config.json', data: '{}' },
  { name: 'napcat/napcat.mjs', data: 'export default true;' },
  { name: 'napcat/config/', data: '' }
]);
const fixtureSha = crypto.createHash('sha256').update(zipFixture).digest('hex');

function makeRelease(tag, digest, contentSize) {
  return {
    tag_name: tag,
    draft: false,
    prerelease: false,
    html_url: 'https://github.com/NapNeko/NapCatQQ/releases/tag/' + tag,
    assets: [{
      name: assetName,
      size: contentSize,
      digest: 'sha256:' + digest,
      browser_download_url: 'https://github.com/NapNeko/NapCatQQ/releases/download/' + tag + '/' + assetName
    }]
  };
}

async function waitFor(predicate, message) {
  for (let attempt = 0; attempt < 120; attempt++) {
    const value = await predicate();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error(message || 'condition-did-not-complete');
}

async function main() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-qq-napcat-manager-'));
  const componentRoot = path.join(tempRoot, 'components', 'qq-napcat-p1');
  let currentRelease = makeRelease('v4.18.38', fixtureSha, zipFixture.length);
  let downloadCount = 0;
  let spawnCount = 0;
  let openedUrl = '';
  const childProcesses = [];
  const managerLogs = [];
  const manager = createManager({
    rootDir: componentRoot,
    platform: 'win32',
    arch: 'x64',
    startupStabilityMs: 5,
    logger: (level, event, fields) => managerLogs.push({ level, event, fields }),
    requestJson: async () => currentRelease,
    downloadToFile: async (_url, destination, expectedSize, onProgress) => {
      downloadCount++;
      fs.writeFileSync(destination, zipFixture, { flag: 'wx' });
      onProgress(zipFixture.length, expectedSize);
      return { bytes: zipFixture.length, sha256: fixtureSha };
    },
    allocatePort: async () => 42000 + childProcesses.length,
    spawnProcess: (executable, args, options) => {
      spawnCount++;
      const child = new EventEmitter();
      child.pid = 30000 + spawnCount;
      child.exitCode = null;
      child.signalCode = null;
      child.killed = false;
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.finish = (code, signal) => {
        child.exitCode = Number.isInteger(code) ? code : null;
        child.signalCode = signal || null;
        child.stdout.end();
        child.stderr.end();
        child.emit('exit', code, signal || null);
        child.emit('close', code, signal || null);
      };
      child.kill = () => {
        child.killed = true;
        child.finish(0, null);
        return true;
      };
      childProcesses.push({ executable, args, options, child });
      setImmediate(() => child.emit('spawn'));
      return child;
    },
    openUrl: async url => { openedUrl = url; },
    openFolder: async () => {}
  });

  try {
    const environment = manager.environment();
    assert.equal(environment.supported, true);
    assert.equal(environment.canWrite, true);
    assert.equal(environment.existingQQScanned, false);
    assert.equal(environment.existingQQModified, false);
    assert.equal(environment.destination, 'available');
    assert.equal(fs.existsSync(componentRoot), false);

    const unconfirmed = await manager.startDownload({ confirmed: false });
    assert.equal(unconfirmed.ok, false);
    assert.equal(downloadCount, 0, 'download requires explicit confirmation');
    assert.equal(fs.existsSync(componentRoot), false, 'no destination is created before consent');
    const shown = await manager.latestRelease();
    assert.equal(shown.ok, true);
    assert.equal(shown.release.tag, 'v4.18.38');
    const confirmation = { confirmed: true, tag: shown.release.tag, sha256: shown.release.sha256 };
    assert.equal((await manager.startDownload(confirmation)).started, true);
    const firstDownload = await waitFor(() => { const current = manager.downloadStatus(); return current.active ? null : current; }, 'official package fixture download did not settle');
    assert.equal(firstDownload.state, 'verified', JSON.stringify(firstDownload));
    assert.equal(downloadCount, 1);
    assert.equal((await manager.startDownload(confirmation)).started, true);
    await waitFor(() => !manager.downloadStatus().active, 'repeated package setup did not settle');
    assert.equal(downloadCount, 1, 'repeated package setup reuses the verified archive');

    const badConsent = await manager.startAccount({ confirmed: false, accountId: '12345678', callbackUrl: 'http://127.0.0.1:23118/qq/onebot/v11/12345678?token=synthetic-token' });
    assert.equal(badConsent.ok, false, 'starting the bundled runtime requires a separate confirmation');
    const callbackA = 'http://127.0.0.1:23118/qq/onebot/v11/12345678?token=synthetic-token-a';
    const callbackB = 'http://127.0.0.1:23118/qq/onebot/v11/87654321?token=synthetic-token-b';
    await manager.startAccount({ confirmed: true, accountId: '12345678', callbackUrl: callbackA });
    const statusA = await waitFor(async () => {
      const result = await manager.statusAccount('12345678');
      return result.state === 'running' ? result : null;
    }, 'first isolated account did not start');
    assert.equal(statusA.installed, true);
    assert.equal(spawnCount, 1);
    assert.equal(path.basename(childProcesses[0].executable), 'node.exe');
    assert.deepEqual(childProcesses[0].args, ['index.js', '-q', '12345678']);
    assert.equal(childProcesses[0].options.shell, undefined, 'the installer batch file is not executed');
    assert.deepEqual(childProcesses[0].options.stdio, ['ignore', 'pipe', 'pipe'], 'NapCat stdout and stderr are captured for diagnostics');
    assert.notEqual(childProcesses[0].options.env.USERPROFILE, process.env.USERPROFILE, 'runtime user data is isolated');
    assert.equal(childProcesses[0].options.env.LOCALAPPDATA.includes('12345678'), true);
    const configAPath = path.join(componentRoot, 'accounts', '12345678', 'napcat', 'config', 'onebot11_12345678.json');
    const configA = JSON.parse(fs.readFileSync(configAPath, 'utf8'));
    assert.equal(configA.network.httpClients[0].url, callbackA);
    assert.equal(configA.network.httpClients[0].messagePostFormat, 'array');
    assert.equal(configA.network.httpClients[0].reportSelfMessage, false);
    assert.equal(configA.network.httpClients[0].token, 'synthetic-token-a', 'NapCat HTTP Client token enables OneBot HMAC event signatures');
    assert.equal(statusA.callbackSignatureConfigured, true);
    const webUiA = JSON.parse(fs.readFileSync(path.join(componentRoot, 'accounts', '12345678', 'napcat', 'config', 'webui.json'), 'utf8'));
    assert.equal(webUiA.host, '127.0.0.1', 'the account WebUI binds only to loopback');
    assert.equal((await manager.openWebUi('12345678')).ok, true);
    assert.match(openedUrl, /^http:\/\/127\.0\.0\.1:\d+\/webui\?token=/);

    await manager.startAccount({ confirmed: true, accountId: '87654321', callbackUrl: callbackB });
    const statusB = await waitFor(async () => {
      const result = await manager.statusAccount('87654321');
      return result.state === 'running' ? result : null;
    }, 'second isolated account did not start');
    assert.equal(statusB.installed, true);
    assert.equal(spawnCount, 2);
    assert.notEqual(childProcesses[0].options.cwd, childProcesses[1].options.cwd, 'each QQ account gets an isolated install tree');
    const configB = JSON.parse(fs.readFileSync(path.join(componentRoot, 'accounts', '87654321', 'napcat', 'config', 'onebot11_87654321.json'), 'utf8'));
    assert.equal(configB.network.httpClients[0].url, callbackB);
    assert.notEqual(configA.network.httpClients[0].url, configB.network.httpClients[0].url);

    const repeatStart = await manager.startAccount({ confirmed: true, accountId: '12345678', callbackUrl: callbackA });
    assert.equal(repeatStart.alreadyRunning, true, 'repeated start does not create another QQ process');
    assert.equal(spawnCount, 2);
    const accountManifestPath = path.join(componentRoot, 'accounts', '12345678', createManager.constants.ACCOUNT_MANIFEST_NAME);
    const accountManifest = JSON.parse(fs.readFileSync(accountManifestPath, 'utf8'));
    configA.network.httpClients[0].token = '';
    fs.writeFileSync(configAPath, JSON.stringify(configA, null, 2));
    accountManifest.onebotConfigSha256 = crypto.createHash('sha256').update(fs.readFileSync(configAPath)).digest('hex');
    fs.writeFileSync(accountManifestPath, JSON.stringify(accountManifest, null, 2));
    const legacyRunningStatus = await manager.statusAccount('12345678');
    assert.equal(legacyRunningStatus.callbackSignatureConfigured, false,
      'an existing P1 account with an empty HTTP Client token is identified as missing callback signatures');
    assert.equal(legacyRunningStatus.callbackRestartRequired, true,
      'the UI can tell a running legacy process needs a stop/start to load the signature config');
    assert.equal(manager.stopAccount('12345678').ok, true);
    assert.equal((await manager.statusAccount('12345678')).installed, true, 'stopping the process preserves the account install');
    await manager.startAccount({ confirmed: true, accountId: '12345678', callbackUrl: callbackA });
    const migratedStatus = await waitFor(async () => {
      const status = await manager.statusAccount('12345678');
      return status.state === 'running' || status.state === 'failed' ? status : null;
    }, 'legacy account signature migration did not settle');
    assert.equal(migratedStatus.state, 'running', JSON.stringify(migratedStatus));
    assert.equal(spawnCount, 3);
    const migratedConfigA = JSON.parse(fs.readFileSync(configAPath, 'utf8'));
    assert.equal(migratedConfigA.network.httpClients[0].url, callbackA, 'same URL still repairs a missing signature token');
    assert.equal(migratedConfigA.network.httpClients[0].token, 'synthetic-token-a');
    assert.equal((await manager.statusAccount('12345678')).callbackSignatureConfigured, true);
    assert.equal(manager.stopAccount('12345678').ok, true);
    const callbackA2 = 'http://127.0.0.1:23118/qq/onebot/v11/12345678?token=rotated-synthetic-token';
    await manager.startAccount({ confirmed: true, accountId: '12345678', callbackUrl: callbackA2 });
    const rotatedStatus = await waitFor(async () => {
      const status = await manager.statusAccount('12345678');
      return status.state === 'running' || status.state === 'failed' ? status : null;
    }, 'rotated account callback did not settle');
    assert.equal(rotatedStatus.state, 'running', JSON.stringify(rotatedStatus));
    assert.equal(spawnCount, 4);
    const updatedConfigA = JSON.parse(fs.readFileSync(path.join(componentRoot, 'accounts', '12345678', 'napcat', 'config', 'onebot11_12345678.json'), 'utf8'));
    assert.equal(updatedConfigA.network.httpClients[0].url, callbackA2, 'restart updates only the manager-owned callback field');
    assert.equal(updatedConfigA.network.httpClients[0].token, 'rotated-synthetic-token', 'rotating the callback capability also rotates the HMAC key');
    childProcesses[1].child.stderr.write('node.exe: bad option: --no-sandbox\n');
    childProcesses[1].child.stderr.write('Authorization: Bearer synthetic-secret-value\n');
    childProcesses[1].child.stdout.write('二维码解码URL: https://txz.qq.com/p?k=synthetic-qr-secret&f=1600001604\n');
    childProcesses[1].child.stdout.write('█▄▄▄▄██▄▄ █ ▄▄▀▄ ▄▀▄▄▀▀█ ▄▄▄ ▀▀ ██\n');
    childProcesses[1].child.finish(9, null);
    const failedNine = await manager.statusAccount('87654321');
    assert.equal(failedNine.state, 'failed', 'unexpected process exit is visible');
    assert.equal(failedNine.error, 'napcat-exit-9');
    assert.match(failedNine.diagnostic, /bad option: --no-sandbox/);
    assert.doesNotMatch(failedNine.diagnostic, /synthetic-secret-value/, 'captured diagnostics redact credentials');
    assert.doesNotMatch(failedNine.diagnostic, /synthetic-qr-secret/, 'QR URLs are redacted before display');
    assert.doesNotMatch(failedNine.diagnostic, /█▄▄▄▄/, 'QR terminal art is omitted from diagnostics');
    assert.ok(managerLogs.some(item => item.event === 'qq-napcat-process-exited' && item.level === 'error'), 'Home Node logs NapCat process exits');
    await manager.startAccount({ confirmed: true, accountId: '87654321', callbackUrl: callbackB });
    await waitFor(async () => (await manager.statusAccount('87654321')).state === 'running', 'failed account did not recover');
    assert.equal(spawnCount, 5);
    childProcesses[4].child.stderr.write('NapCat quick login ended before a worker became ready\n');
    childProcesses[4].child.finish(0, null);
    const failedCleanExit = await manager.statusAccount('87654321');
    assert.equal(failedCleanExit.state, 'failed', 'an unsolicited clean exit is not mistaken for a normal stop');
    assert.equal(failedCleanExit.error, 'napcat-exit-0');
    assert.match(failedCleanExit.diagnostic, /ended before a worker became ready/);
    await manager.startAccount({ confirmed: true, accountId: '87654321', callbackUrl: callbackB });
    await waitFor(async () => (await manager.statusAccount('87654321')).state === 'running', 'clean-exit failure did not recover');
    assert.equal(spawnCount, 6);
    assert.equal(manager.stopAccount('12345678').ok, true);
    manager.close();
    assert.equal(childProcesses[5].child.killed, true, 'Home Node shutdown stops the managed NapCat child');

    const simulatedLogin = path.join(componentRoot, 'accounts', '12345678', 'qq-profile', 'AppData', 'Roaming', 'QQ', 'session.test');
    fs.mkdirSync(path.dirname(simulatedLogin), { recursive: true });
    fs.writeFileSync(simulatedLogin, 'simulated-login-data');
    assert.equal((await manager.removeVerifiedArchive({ confirmed: false })).ok, false);
    const removed = await manager.removeVerifiedArchive({ confirmed: true });
    assert.equal(removed.ok, true);
    assert.equal(removed.installedAccountsPreserved, true);
    assert.equal(fs.existsSync(path.join(componentRoot, assetName)), false);
    assert.equal(fs.readFileSync(simulatedLogin, 'utf8'), 'simulated-login-data', 'archive cleanup keeps account data');
    const restartAfterArchiveRemoval = createManager({
      rootDir: componentRoot,
      platform: 'win32',
      arch: 'x64',
      startupStabilityMs: 5,
      spawnProcess: (_executable, _args, _options) => {
        const child = new EventEmitter();
        child.pid = 39999;
        child.exitCode = null;
        child.signalCode = null;
        child.killed = false;
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.kill = () => { child.killed = true; child.exitCode = 0; child.stdout.end(); child.stderr.end(); child.emit('exit', 0, null); child.emit('close', 0, null); return true; };
        setImmediate(() => child.emit('spawn'));
        return child;
      }
    });
    await restartAfterArchiveRemoval.startAccount({ confirmed: true, accountId: '12345678', callbackUrl: callbackA2 });
    await waitFor(async () => (await restartAfterArchiveRemoval.statusAccount('12345678')).state === 'running', 'runtime did not start without the downloaded ZIP');
    assert.equal(fs.readFileSync(simulatedLogin, 'utf8'), 'simulated-login-data');
    restartAfterArchiveRemoval.close();

    const conflictRoot = path.join(tempRoot, 'components', 'unowned-napcat-dir');
    fs.mkdirSync(conflictRoot, { recursive: true });
    const unowned = path.join(conflictRoot, 'do-not-touch.test');
    fs.writeFileSync(unowned, 'preserve');
    const conflict = createManager({ rootDir: conflictRoot, platform: 'win32', arch: 'x64', requestJson: async () => currentRelease });
    assert.equal(conflict.environment().destination, 'occupied');
    assert.equal(fs.readFileSync(unowned, 'utf8'), 'preserve');

    const badRoot = path.join(tempRoot, 'components', 'bad-napcat-dir');
    let wrongDigest = true;
    const recovery = createManager({
      rootDir: badRoot,
      platform: 'win32',
      arch: 'x64',
      requestJson: async () => currentRelease,
      downloadToFile: async (_url, destination, expected, onProgress) => {
        fs.writeFileSync(destination, zipFixture, { flag: 'wx' });
        onProgress(zipFixture.length, expected);
        return { bytes: zipFixture.length, sha256: wrongDigest ? '0'.repeat(64) : fixtureSha };
      }
    });
    const release = await recovery.latestRelease();
    await recovery.startDownload({ confirmed: true, tag: release.release.tag, sha256: release.release.sha256 });
    await waitFor(() => !recovery.downloadStatus().active && recovery.downloadStatus().state === 'failed', 'bad digest was not rejected');
    assert.equal(recovery.downloadStatus().error, 'asset-sha256-mismatch');
    assert.equal(fs.existsSync(path.join(badRoot, assetName)), false, 'unverified package never reaches install state');
    wrongDigest = false;
    const retryRelease = await recovery.latestRelease();
    await recovery.startDownload({ confirmed: true, tag: retryRelease.release.tag, sha256: retryRelease.release.sha256 });
    await waitFor(() => !recovery.downloadStatus().active && recovery.downloadStatus().state === 'verified', 'download retry did not recover');

    const cancelRoot = path.join(tempRoot, 'components', 'cancel-napcat-dir');
    const cancellable = createManager({
      rootDir: cancelRoot, platform: 'win32', arch: 'x64', requestJson: async () => currentRelease,
      downloadToFile: async (_url, destination, _expected, _progress, signal) => new Promise((_resolve, reject) => {
        fs.writeFileSync(destination, 'partial', { flag: 'wx' });
        signal.addEventListener('abort', () => reject(new Error('download-cancelled')), { once: true });
      })
    });
    const cancelRelease = await cancellable.latestRelease();
    await cancellable.startDownload({ confirmed: true, tag: cancelRelease.release.tag, sha256: cancelRelease.release.sha256 });
    await waitFor(() => cancellable.downloadStatus().state === 'downloading', 'download did not enter progress state');
    assert.equal(cancellable.cancelDownload().ok, true);
    await waitFor(() => !cancellable.downloadStatus().active && cancellable.downloadStatus().state === 'failed', 'cancel did not settle');
    assert.equal(cancellable.downloadStatus().error, 'download-cancelled');

    currentRelease = makeRelease('v4.18.39', fixtureSha, zipFixture.length);
    const changedRoot = path.join(tempRoot, 'components', 'changed-napcat-dir');
    const changed = createManager({ rootDir: changedRoot, platform: 'win32', arch: 'x64', requestJson: async () => currentRelease });
    currentRelease = makeRelease('v4.18.38', fixtureSha, zipFixture.length);
    const viewed = await changed.latestRelease();
    currentRelease = makeRelease('v4.18.39', fixtureSha, zipFixture.length);
    await changed.startDownload({ confirmed: true, tag: viewed.release.tag, sha256: viewed.release.sha256 });
    await waitFor(() => !changed.downloadStatus().active && changed.downloadStatus().state === 'failed', 'release change was not rejected');
    assert.equal(changed.downloadStatus().error, 'release-changed-reconfirm');
    assert.equal(fs.existsSync(changedRoot), false);

    let transferMode = 'unknown-length';
    let redirectHost = 'release-assets.githubusercontent.com';
    let transferDelayMs = 30;
    const requestedHosts = [];
    const requestedRanges = [];
    const receivedHttpRequests = [];
    const localClientErrors = [];
    const localDownloadServer = http.createServer((request, response) => {
      receivedHttpRequests.push({ url: request.url, range: request.headers.range || '', ifRange: request.headers['if-range'] || '' });
      if (request.url.startsWith('/NapNeko/NapCatQQ/releases/download/')) {
        response.writeHead(302, { Location: 'https://' + redirectHost + '/signed-asset.zip?signature=test-only' });
        response.end();
        return;
      }
      if (!request.url.startsWith('/signed-asset.zip')) { response.writeHead(404); response.end(); return; }
      const etag = '"napcat-fixture-strong-etag-v1"';
      const range = /^bytes=(\d+)-$/.exec(String(request.headers.range || ''));
      let transferData = zipFixture;
      if (range) {
        const offset = Number(range[1]);
        if (offset < 0 || offset >= zipFixture.length || request.headers['if-range'] !== etag) { response.writeHead(416); response.end(); return; }
        if (transferMode === 'expired') { response.writeHead(403); response.end(); return; }
        transferData = zipFixture.subarray(offset);
        response.writeHead(206, {
          'Content-Range': 'bytes ' + offset + '-' + (zipFixture.length - 1) + '/' + zipFixture.length,
          'Content-Length': transferData.length, 'Content-Type': 'application/zip', ETag: etag
        });
      } else {
        const headers = { 'Content-Type': 'application/zip', ETag: etag };
        if (transferMode !== 'unknown-length') headers['Content-Length'] = zipFixture.length;
        response.writeHead(200, headers);
      }
      if (transferMode === 'stall') return;
      if (transferMode === 'disconnect') {
        response.write(transferData.subarray(0, Math.max(1, Math.floor(transferData.length / 3))));
        setTimeout(() => response.destroy(), 30);
        return;
      }
      const chunks = 12;
      let index = 0;
      const sendChunk = () => {
        if (response.destroyed) return;
        if (index >= chunks) { response.end(); return; }
        const start = Math.floor(transferData.length * index / chunks);
        const end = Math.floor(transferData.length * (index + 1) / chunks);
        response.write(transferData.subarray(start, end));
        index++;
        setTimeout(sendChunk, transferDelayMs);
      };
      sendChunk();
    });
    await new Promise((resolve, reject) => {
      localDownloadServer.once('error', reject);
      localDownloadServer.listen(0, '127.0.0.1', resolve);
    });
    const localDownloadRequestClient = {
      get: (url, requestOptions, callback) => {
        const parsed = new URL(String(url));
        requestedHosts.push(parsed.hostname);
        requestedRanges.push({ host: parsed.hostname, range: requestOptions.headers.Range || '', ifRange: requestOptions.headers['If-Range'] || '' });
        const localRequest = http.get({
          hostname: '127.0.0.1', port: localDownloadServer.address().port,
          path: parsed.pathname + parsed.search,
          headers: requestOptions.headers, timeout: requestOptions.timeout
        }, callback);
        localRequest.on('error', error => localClientErrors.push(error && error.code || error && error.message || 'unknown'));
        return localRequest;
      }
    };
    try {
      const streamRoot = path.join(tempRoot, 'components', 'real-http-stream');
      const httpRelease = makeRelease('v4.18.38', fixtureSha, zipFixture.length);
      const streamed = createManager({
        rootDir: streamRoot, platform: 'win32', arch: 'x64', requestJson: async () => httpRelease,
        downloadRequestClient: localDownloadRequestClient
      });
      const streamRelease = await streamed.latestRelease();
      const observedProgress = [];
      const sampleTimer = setInterval(() => observedProgress.push(streamed.downloadStatus()), 10);
      await streamed.startDownload({ confirmed: true, tag: streamRelease.release.tag, sha256: streamRelease.release.sha256 });
      const streamResult = await waitFor(() => {
        const current = streamed.downloadStatus();
        return current.active ? null : current;
      }, 'redirected HTTP stream did not settle');
      clearInterval(sampleTimer);
      assert.equal(streamResult.state, 'verified', JSON.stringify(streamResult));
      assert.ok(requestedHosts.includes('github.com'));
      assert.ok(requestedHosts.includes('release-assets.githubusercontent.com'), 'the official GitHub asset CDN redirect is followed');
      assert.ok(observedProgress.some(status => status.totalBytes === zipFixture.length), 'GitHub release metadata supplies a determinate total when the HTTP response omits Content-Length');
      assert.ok(observedProgress.some(status => status.state === 'downloading' && status.receivedBytes > 0), 'stream byte progress is visible before completion');
      assert.ok(observedProgress.some(status => status.speedBytesPerSecond > 0), 'download speed is calculated from real stream progress');
      assert.equal(fs.readFileSync(path.join(streamRoot, assetName)).length, zipFixture.length);
      streamed.close();

      redirectHost = 'untrusted-download.example';
      const rejectedRedirectRoot = path.join(tempRoot, 'components', 'rejected-redirect');
      const rejectedRedirect = createManager({
        rootDir: rejectedRedirectRoot, platform: 'win32', arch: 'x64', requestJson: async () => httpRelease,
        downloadRequestClient: localDownloadRequestClient
      });
      const rejectedRelease = await rejectedRedirect.latestRelease();
      await rejectedRedirect.startDownload({ confirmed: true, tag: rejectedRelease.release.tag, sha256: rejectedRelease.release.sha256 });
      const rejectedRedirectStatus = await waitFor(() => {
        const current = rejectedRedirect.downloadStatus();
        return current.active ? null : current;
      }, 'untrusted redirect was not rejected');
      assert.equal(rejectedRedirectStatus.error, 'asset-redirect-rejected');
      assert.equal(requestedHosts.includes('untrusted-download.example'), false, 'the downloader never contacts an unapproved redirect host');
      assert.equal(fs.existsSync(path.join(rejectedRedirectRoot, assetName)), false);
      assert.equal(fs.readdirSync(rejectedRedirectRoot).some(name => name.includes('.part-')), false);
      rejectedRedirect.close();
      redirectHost = 'release-assets.githubusercontent.com';

      transferMode = 'disconnect';
      const interruptedRoot = path.join(tempRoot, 'components', 'real-http-disconnect');
      const interrupted = createManager({
        rootDir: interruptedRoot, platform: 'win32', arch: 'x64', requestJson: async () => httpRelease,
        downloadRequestClient: localDownloadRequestClient
      });
      const interruptedRelease = await interrupted.latestRelease();
      await interrupted.startDownload({ confirmed: true, tag: interruptedRelease.release.tag, sha256: interruptedRelease.release.sha256 });
      const interruptedStatus = await waitFor(() => {
        const current = interrupted.downloadStatus();
        return current.active ? null : current;
      }, 'interrupted HTTP stream did not settle');
      assert.equal(interruptedStatus.state, 'failed');
      assert.equal(interruptedStatus.error, 'asset-connection-lost');
      assert.equal(interruptedStatus.resumeAvailable, true, 'a strong ETag and matching partial size make this interrupted transfer resumable');
      assert.equal(fs.existsSync(path.join(interruptedRoot, assetName)), false, 'a dropped stream never becomes the verified archive');
      const interruptedPart = fs.readdirSync(interruptedRoot).find(name => name.includes('.part-'));
      assert.ok(interruptedPart, 'only a manager-owned .part file is retained for a safe retry');
      assert.ok(fs.statSync(path.join(interruptedRoot, interruptedPart)).size > 0);
      interrupted.close();

      transferMode = 'expired';
      const resumedManager = createManager({
        rootDir: interruptedRoot, platform: 'win32', arch: 'x64', requestJson: async () => httpRelease,
        downloadRequestClient: localDownloadRequestClient
      });
      assert.equal(resumedManager.downloadStatus().resumeAvailable, true, 'the exact-size partial and strong ETag survive a Home Node manager restart');
      const expiredLinkRelease = await resumedManager.latestRelease();
      await resumedManager.startDownload({ confirmed: true, tag: expiredLinkRelease.release.tag, sha256: expiredLinkRelease.release.sha256 });
      const expiredLinkStatus = await waitFor(() => {
        const current = resumedManager.downloadStatus();
        return current.active ? null : current;
      }, 'expired signed URL did not settle');
      assert.equal(expiredLinkStatus.error, 'asset-signed-url-expired');
      assert.equal(expiredLinkStatus.resumeAvailable, true, 'an expired signed URL retains the ETag-bound partial');

      transferMode = 'success';
      const retryHttpRelease = await resumedManager.latestRelease();
      const retryStart = await resumedManager.startDownload({ confirmed: true, tag: retryHttpRelease.release.tag, sha256: retryHttpRelease.release.sha256 });
      assert.equal(retryStart.started, true, JSON.stringify(retryStart));
      const resumedStatus = await waitFor(() => {
        const current = resumedManager.downloadStatus();
        return current.active ? null : current;
      }, 'HTTP range retry did not settle');
      assert.equal(resumedStatus.state, 'verified', JSON.stringify({ status: resumedStatus, ranges: requestedRanges, requests: receivedHttpRequests, clientErrors: localClientErrors }) + ' matching range/ETag resumes to a digest-verified archive');
      assert.ok(requestedRanges.some(item => item.host === 'release-assets.githubusercontent.com' && item.range === 'bytes=' + interruptedStatus.receivedBytes + '-' && item.ifRange === '"napcat-fixture-strong-etag-v1"'));
      assert.equal(fs.readFileSync(path.join(interruptedRoot, assetName)).length, zipFixture.length);
      resumedManager.close();

      transferMode = 'disconnect';
      const tamperRoot = path.join(tempRoot, 'components', 'resume-integrity');
      const tamperedResume = createManager({
        rootDir: tamperRoot, platform: 'win32', arch: 'x64', requestJson: async () => httpRelease,
        downloadRequestClient: localDownloadRequestClient
      });
      const tamperRelease = await tamperedResume.latestRelease();
      await tamperedResume.startDownload({ confirmed: true, tag: tamperRelease.release.tag, sha256: tamperRelease.release.sha256 });
      const partialStatus = await waitFor(() => {
        const current = tamperedResume.downloadStatus();
        return current.active ? null : current;
      }, 'tamper fixture did not interrupt');
      assert.equal(partialStatus.resumeAvailable, true);
      const partialName = fs.readdirSync(tamperRoot).find(name => name.includes('.part-'));
      const partialPath = path.join(tamperRoot, partialName);
      const partialFd = fs.openSync(partialPath, 'r+');
      try {
        const byte = Buffer.alloc(1);
        fs.readSync(partialFd, byte, 0, 1, 0);
        byte[0] ^= 0xff;
        fs.writeSync(partialFd, byte, 0, 1, 0);
      } finally { fs.closeSync(partialFd); }
      transferMode = 'success';
      const tamperRetryRelease = await tamperedResume.latestRelease();
      await tamperedResume.startDownload({ confirmed: true, tag: tamperRetryRelease.release.tag, sha256: tamperRetryRelease.release.sha256 });
      const tamperResult = await waitFor(() => {
        const current = tamperedResume.downloadStatus();
        return current.active ? null : current;
      }, 'tampered resume did not settle');
      assert.equal(tamperResult.error, 'asset-sha256-mismatch', 'the final full-file digest detects a modified resume prefix');
      assert.equal(fs.existsSync(path.join(tamperRoot, assetName)), false);
      assert.equal(fs.readdirSync(tamperRoot).some(name => name.includes('.part-')), false, 'a digest-mismatched resumed file is discarded');
      tamperedResume.close();

      transferMode = 'stall';
      const stalledRoot = path.join(tempRoot, 'components', 'real-http-stall');
      const stalled = createManager({
        rootDir: stalledRoot, platform: 'win32', arch: 'x64', requestJson: async () => httpRelease,
        downloadRequestClient: localDownloadRequestClient, downloadIdleTimeoutMs: 150
      });
      const stalledRelease = await stalled.latestRelease();
      await stalled.startDownload({ confirmed: true, tag: stalledRelease.release.tag, sha256: stalledRelease.release.sha256 });
      const stalledStatus = await waitFor(() => {
        const current = stalled.downloadStatus();
        return current.active ? null : current;
      }, 'idle HTTP timeout did not settle');
      assert.equal(stalledStatus.state, 'failed');
      assert.equal(stalledStatus.error, 'asset-idle-timeout');
      assert.equal(fs.existsSync(path.join(stalledRoot, assetName)), false, 'an idle timeout never exposes a partial archive');
      assert.equal(fs.readdirSync(stalledRoot).some(name => name.includes('.part-')), false, 'idle timeouts remove their manager-owned partial file');
      stalled.close();

      transferMode = 'slow';
      transferDelayMs = 80;
      const cancelRoot = path.join(tempRoot, 'components', 'real-http-cancel');
      const cancelHttp = createManager({
        rootDir: cancelRoot, platform: 'win32', arch: 'x64', requestJson: async () => httpRelease,
        downloadRequestClient: localDownloadRequestClient
      });
      const cancelHttpRelease = await cancelHttp.latestRelease();
      await cancelHttp.startDownload({ confirmed: true, tag: cancelHttpRelease.release.tag, sha256: cancelHttpRelease.release.sha256 });
      await waitFor(() => cancelHttp.downloadStatus().receivedBytes > 0, 'cancel test did not receive HTTP bytes');
      assert.equal(cancelHttp.cancelDownload().ok, true);
      const cancelledStatus = await waitFor(() => {
        const current = cancelHttp.downloadStatus();
        return current.active ? null : current;
      }, 'HTTP cancellation did not settle');
      assert.equal(cancelledStatus.error, 'download-cancelled');
      assert.equal(cancelledStatus.resumeAvailable, true, JSON.stringify(cancelledStatus) + ' cancel preserves only an ETag-validated temporary range');
      assert.equal(fs.existsSync(path.join(cancelRoot, assetName)), false, 'a cancelled stream never becomes the verified archive');
      assert.equal(fs.readdirSync(cancelRoot).filter(name => name.includes('.part-')).length, 1, 'cancel keeps a non-installable part for safe resume');

      transferMode = 'success';
      transferDelayMs = 5;
      const retryRelease = await cancelHttp.latestRelease();
      await cancelHttp.startDownload({ confirmed: true, tag: retryRelease.release.tag, sha256: retryRelease.release.sha256 });
      const retried = await waitFor(() => {
        const current = cancelHttp.downloadStatus();
        return current.active ? null : current;
      }, 'HTTP download retry did not settle');
      assert.equal(retried.state, 'verified', 'a clean retry can verify after an interrupted/cancelled transfer');
      interrupted.close();
      cancelHttp.close();
    } finally {
      await new Promise(resolve => localDownloadServer.close(resolve));
    }

    manager.close();
  } finally {
    const resolvedTemp = path.resolve(tempRoot);
    assert.equal(path.basename(resolvedTemp).startsWith('ib-qq-napcat-manager-'), true);
    assert.equal(resolvedTemp.startsWith(path.resolve(os.tmpdir()) + path.sep), true);
    fs.rmSync(resolvedTemp, { recursive: true, force: true });
  }
  console.log('QQ NapCat isolated manager checks passed');
}

main().catch(error => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
