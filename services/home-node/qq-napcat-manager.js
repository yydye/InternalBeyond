'use strict';

/* User-approved, account-isolated NapCat Windows Node package manager.
 * It downloads only the official release asset, verifies GitHub's SHA-256,
 * safely extracts ZIP32 entries, writes config only into a fresh IB-owned
 * account directory, and starts the bundled node.exe directly (never a .bat).
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const https = require('node:https');
const net = require('node:net');
const http = require('node:http');
const crypto = require('node:crypto');
const { execFile, spawn } = require('node:child_process');
const napcatZip = require('./qq-napcat-zip.js');

const RELEASE_API = 'https://api.github.com/repos/NapNeko/NapCatQQ/releases/latest';
const RELEASES_PAGE = 'https://github.com/NapNeko/NapCatQQ/releases';
const REPOSITORY = 'NapNeko/NapCatQQ';
const ASSET_NAME = 'NapCat.Shell.Windows.Node.zip';
const MAX_ASSET_BYTES = 256 * 1024 * 1024;
const DOWNLOAD_IDLE_TIMEOUT_MS = 120000;
const DEFAULT_STARTUP_STABILITY_MS = 12000;
const MAX_DIAGNOSTIC_LINES = 8;
const MAX_DIAGNOSTIC_CHARS = 1800;
/* browser_download_url stays on github.com, then GitHub serves the signed asset
 * from one of its own CDN/object hosts. Never forward to an arbitrary Location. */
const OFFICIAL_ASSET_HOSTS = Object.freeze(['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com']);
const MANIFEST_NAME = '.ib-qq-napcat-download.json';
const ACCOUNT_MANIFEST_NAME = '.ib-qq-napcat-account.json';
const ACCOUNT_ID_RE = /^\d{5,12}$/;
const REQUIRED_FILES = Object.freeze([
  'node.exe', 'index.js', 'wrapper.node', 'package.json', 'config.json', 'napcat/napcat.mjs'
]);

function safeTag(value) {
  const tag = String(value || '');
  return /^v\d{1,3}\.\d{1,3}\.\d{1,3}(?:[-.][A-Za-z0-9.-]{1,40})?$/.test(tag) ? tag : '';
}

function safeError(error) {
  const code = String(error && (error.code || error.message) || 'napcat-operation-failed');
  return code.replace(/[^A-Za-z0-9._:-]/g, '-').slice(0, 120) || 'napcat-operation-failed';
}

function sanitizeNapCatDiagnostic(value, accountId) {
  let text = String(value == null ? '' : value)
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/(https?:\/\/[^\s?]+)\?[^\s]+/gi, '$1?[redacted]')
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
    .replace(/((?:authorization|token|access[_-]?token|refresh[_-]?token|api[_-]?key|secret|password|cookie|qrsig|ticket|auth[_-]?key)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1[redacted]')
    .replace(/([?&](?:token|access_token|refresh_token|ticket|qrsig|auth|key|code)=)[^&#\s]+/gi, '$1[redacted]')
    .replace(/[\r\n]+/g, ' ');
  const qrGlyphCount = (text.match(/[█▀▄▌▐]/g) || []).length;
  if (qrGlyphCount >= 8 && qrGlyphCount / Math.max(1, text.length) > 0.2) return '[QR code omitted]';
  const id = String(accountId || '');
  if (id.length >= 5) text = text.split(id).join('[QQ]');
  return text.trim().slice(0, 500);
}

function napCatExitError(code, signal) {
  if (Number.isInteger(code)) return 'napcat-exit-' + String(code);
  return 'napcat-exit-' + safeError(signal || 'unknown');
}

function requestJson(url) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.hostname !== 'api.github.com' || parsed.port || parsed.username || parsed.password) {
      reject(new Error('release-host-rejected'));
      return;
    }
    const request = https.get(parsed, {
      headers: {
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'InternalBeyond-QQ-Onboarding',
        'X-GitHub-Api-Version': '2022-11-28'
      },
      timeout: 12000
    }, (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error('release-http-' + String(response.statusCode || 0)));
        return;
      }
      let size = 0;
      const chunks = [];
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size > 2 * 1024 * 1024) { request.destroy(new Error('release-response-too-large')); return; }
        chunks.push(chunk);
      });
      response.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch (_) { reject(new Error('release-response-invalid')); }
      });
      response.on('error', reject);
    });
    request.on('timeout', () => request.destroy(new Error('release-timeout')));
    request.on('error', reject);
  });
}

function strongEtag(value) {
  const etag = String(value || '').trim();
  return /^"[\x21\x23-\x7E]{1,256}"$/.test(etag) ? etag : '';
}

function isResumableTransferError(error, signal) {
  if (signal && signal.aborted) return true;
  const code = String(error && (error.code || error.message) || '');
  return code === 'download-cancelled' || code === 'asset-idle-timeout' || code === 'asset-connection-lost'
    || code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'EPIPE' || code === 'EAI_AGAIN';
}

function downloadToFile(url, filePath, expectedSize, onProgress, signal, redirectCount, requestClient, idleTimeoutMs, resumeInfo) {
  redirectCount = Number(redirectCount) || 0;
  requestClient = requestClient || https;
  idleTimeoutMs = Number(idleTimeoutMs) > 0 ? Number(idleTimeoutMs) : DOWNLOAD_IDLE_TIMEOUT_MS;
  const expected = Number(expectedSize) || 0;
  const resumeOffset = Number(resumeInfo && resumeInfo.bytes) || 0;
  const resumeEtag = strongEtag(resumeInfo && resumeInfo.etag);
  const canRequestResume = resumeOffset > 0 && expected > resumeOffset && resumeEtag;
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(url); } catch (_) { reject(new Error('asset-url-invalid')); return; }
    const allowedHost = OFFICIAL_ASSET_HOSTS.includes(parsed.hostname);
    if (parsed.protocol !== 'https:' || !allowedHost || (redirectCount === 0 && parsed.hostname !== 'github.com')
      || parsed.port || parsed.username || parsed.password) {
      reject(new Error('asset-host-rejected'));
      return;
    }
    let responseReceived = false;
    let requestTimedOut = false;
    let requestAbort = null;
    const headers = { 'User-Agent': 'InternalBeyond-QQ-Onboarding', 'Accept': 'application/octet-stream' };
    if (canRequestResume) {
      headers.Range = 'bytes=' + resumeOffset + '-';
      headers['If-Range'] = resumeEtag;
    }
    const request = requestClient.get(parsed, {
      headers,
      timeout: idleTimeoutMs
    }, (response) => {
      responseReceived = true;
      if (signal && requestAbort) signal.removeEventListener('abort', requestAbort);
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.on('error', reject);
        response.on('aborted', () => reject(new Error('asset-redirect-incomplete')));
        response.resume();
        if (redirectCount >= 4) { reject(new Error('asset-too-many-redirects')); return; }
        let next;
        try { next = new URL(response.headers.location, parsed); }
        catch (_) { reject(new Error('asset-redirect-invalid')); return; }
        const allowed = next.protocol === 'https:' && !next.port && !next.username && !next.password
          && OFFICIAL_ASSET_HOSTS.includes(next.hostname);
        if (!allowed) { reject(new Error('asset-redirect-rejected')); return; }
        downloadToFile(next.href, filePath, expectedSize, onProgress, signal, redirectCount + 1, requestClient, idleTimeoutMs, resumeInfo).then(resolve, reject);
        return;
      }
      if (response.statusCode !== 200 && response.statusCode !== 206) {
        response.on('error', reject);
        response.resume();
        const error = new Error(response.statusCode === 403 && canRequestResume
          ? 'asset-signed-url-expired' : 'asset-http-' + String(response.statusCode || 0));
        if (response.statusCode === 403 && canRequestResume) error.resumeInfo = { bytes: resumeOffset, etag: resumeEtag };
        reject(error);
        return;
      }
      const length = Number(response.headers['content-length'] || 0);
      const responseEtag = strongEtag(response.headers.etag);
      let fileOffset = 0;
      let append = false;
      let rangeTotal = 0;
      if (response.statusCode === 206) {
        const match = String(response.headers['content-range'] || '').match(/^bytes (\d+)-(\d+)\/(\d+)$/i);
        const start = match ? Number(match[1]) : -1;
        const end = match ? Number(match[2]) : -1;
        rangeTotal = match ? Number(match[3]) : 0;
        if (!canRequestResume || start !== resumeOffset || end < start || !rangeTotal
          || (expected > 0 && rangeTotal !== expected) || responseEtag !== resumeEtag) {
          response.on('error', reject);
          response.resume();
          reject(new Error('asset-resume-mismatch'));
          return;
        }
        fileOffset = resumeOffset;
        append = true;
      }
      const total = expected || rangeTotal || (length ? length + fileOffset : 0);
      const responseExpected = total > 0 ? total - fileOffset : 0;
      if (length && (length + fileOffset > MAX_ASSET_BYTES || (responseExpected > 0 && length !== responseExpected))) {
        response.destroy(new Error('asset-size-mismatch'));
        reject(new Error('asset-size-mismatch'));
        return;
      }
      if (total > MAX_ASSET_BYTES) {
        response.destroy(new Error('asset-size-mismatch'));
        reject(new Error('asset-size-mismatch'));
        return;
      }
      const output = fs.createWriteStream(filePath, { flags: append ? 'a' : (canRequestResume ? 'w' : 'wx'), mode: 0o600 });
      const hash = crypto.createHash('sha256');
      let received = 0;
      let settled = false;
      const fail = (error) => {
        if (settled) return;
        settled = true;
        response.unpipe(output);
        output.destroy();
        response.destroy();
        const totalReceived = fileOffset + received;
        const finishFailure = () => {
          let savedBytes = 0;
          try {
            const stat = fs.lstatSync(filePath);
            if (stat.isFile() && !stat.isSymbolicLink()) savedBytes = stat.size;
          } catch (_) { savedBytes = 0; }
          const resumable = isResumableTransferError(error, signal) && !!responseEtag && savedBytes > 0
            && savedBytes < total && savedBytes >= fileOffset && savedBytes <= totalReceived;
          if (resumable) error.resumeInfo = { bytes: savedBytes, etag: responseEtag };
          else { try { fs.rmSync(filePath, { force: true }); } catch (_) { /* manager-owned partial */ } }
          reject(error);
        };
        if (output.closed || output.fd === null) finishFailure();
        else output.once('close', finishFailure);
      };
      response.on('data', (chunk) => {
        if (settled) return;
        received += chunk.length;
        const totalReceived = fileOffset + received;
        if (totalReceived > MAX_ASSET_BYTES || (total > 0 && totalReceived > total)) { fail(new Error('asset-size-mismatch')); return; }
        hash.update(chunk);
        if (typeof onProgress === 'function') {
          try { onProgress(totalReceived, total, { etag: responseEtag, resumedBytes: fileOffset }); }
          catch (error) { fail(error); }
        }
      });
      response.on('error', fail);
      response.on('aborted', () => fail(new Error(requestTimedOut ? 'asset-idle-timeout' : 'asset-connection-lost')));
      response.on('close', () => {
        if (!response.complete) fail(new Error(requestTimedOut ? 'asset-idle-timeout' : 'asset-connection-lost'));
      });
      output.on('error', fail);
      output.on('finish', () => {
        if (settled) return;
        const totalReceived = fileOffset + received;
        if (total > 0 && totalReceived !== total) { fail(new Error('asset-size-mismatch')); return; }
        settled = true;
        resolve({ bytes: totalReceived, sha256: hash.digest('hex'), resumedBytes: fileOffset, etag: responseEtag });
      });
      response.pipe(output);
      if (signal) {
        if (signal.aborted) fail(new Error('download-cancelled'));
        else signal.addEventListener('abort', () => fail(new Error('download-cancelled')), { once: true });
      }
    });
    request.on('timeout', () => { requestTimedOut = true; request.destroy(new Error('asset-idle-timeout')); });
    request.on('error', (error) => {
      if (signal && requestAbort) signal.removeEventListener('abort', requestAbort);
      if (responseReceived) return;
      const requestError = signal && signal.aborted ? new Error('download-cancelled') : error;
      let keepPartial = false;
      if (canRequestResume && isResumableTransferError(requestError, signal)) {
        try {
          const stat = fs.lstatSync(filePath);
          keepPartial = stat.isFile() && !stat.isSymbolicLink() && stat.size === resumeOffset;
        } catch (_) { keepPartial = false; }
      }
      if (keepPartial) requestError.resumeInfo = { bytes: resumeOffset, etag: resumeEtag };
      else { try { fs.rmSync(filePath, { force: true }); } catch (_) { /* manager-owned partial */ } }
      reject(requestError);
    });
    if (signal) {
      if (signal.aborted) request.destroy(new Error('download-cancelled'));
      else {
        requestAbort = () => request.destroy(new Error('download-cancelled'));
        signal.addEventListener('abort', requestAbort, { once: true });
      }
    }
  });
}

function hashFile(filePath, fileSystem) {
  fileSystem = fileSystem || fs;
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    let bytes = 0;
    const input = fileSystem.createReadStream(filePath);
    input.on('data', chunk => { bytes += chunk.length; hash.update(chunk); });
    input.on('error', reject);
    input.on('end', () => resolve({ bytes, sha256: hash.digest('hex') }));
  });
}

function assertRegularPath(root, relative, fileSystem) {
  const base = path.resolve(root);
  const baseStat = fileSystem.lstatSync(base);
  if (!baseStat.isDirectory() || baseStat.isSymbolicLink()) throw new Error('managed-base-directory-invalid');
  const target = path.resolve(base, ...String(relative).split(/[\\/]+/));
  const rel = path.relative(base, target);
  if (!rel || rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) throw new Error('managed-path-escape');
  let current = base;
  const parts = rel.split(path.sep);
  for (let index = 0; index < parts.length; index++) {
    current = path.join(current, parts[index]);
    const stat = fileSystem.lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error('managed-reparse-point-blocked');
    if (index < parts.length - 1 && !stat.isDirectory()) throw new Error('managed-parent-not-directory');
    if (index === parts.length - 1 && !stat.isFile()) throw new Error('managed-file-not-regular');
  }
  return current;
}

function ensureDirectoryChain(targetPath, anchorPath, fileSystem) {
  let anchor = path.resolve(anchorPath);
  while (anchor) {
    try {
      const stat = fileSystem.lstatSync(anchor);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('managed-anchor-invalid');
      break;
    } catch (error) {
      if (!error || error.code !== 'ENOENT') throw error;
      const parent = path.dirname(anchor);
      if (parent === anchor) throw new Error('managed-anchor-unavailable');
      anchor = parent;
    }
  }
  const target = path.resolve(targetPath);
  if (target.toLowerCase() === anchor.toLowerCase()) return target;
  const rel = path.relative(anchor, target);
  if (!rel || rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) throw new Error('managed-directory-escape');
  const anchorStat = fileSystem.lstatSync(anchor);
  if (!anchorStat.isDirectory() || anchorStat.isSymbolicLink()) throw new Error('managed-anchor-invalid');
  let current = anchor;
  for (const segment of rel.split(path.sep)) {
    current = path.join(current, segment);
    try {
      const stat = fileSystem.lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('managed-reparse-point-blocked');
    } catch (error) {
      if (!error || error.code !== 'ENOENT') throw error;
      fileSystem.mkdirSync(current, { recursive: false });
    }
  }
  return target;
}

function validateNodeBundle(folder, fileSystem) {
  fileSystem = fileSystem || fs;
  for (const relative of REQUIRED_FILES) {
    const absolute = assertRegularPath(folder, relative, fileSystem);
    let stat;
    try { stat = fileSystem.lstatSync(absolute); } catch (_) { throw new Error('node-bundle-missing-' + relative.replace(/[^A-Za-z0-9]/g, '-')); }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1) throw new Error('node-bundle-file-invalid-' + relative.replace(/[^A-Za-z0-9]/g, '-'));
  }
  const nodePath = path.join(folder, 'node.exe');
  const fd = fileSystem.openSync(nodePath, 'r');
  try {
    const head = Buffer.alloc(4096);
    const read = fileSystem.readSync(fd, head, 0, head.length, 0);
    if (read < 0x40 || head.toString('ascii', 0, 2) !== 'MZ') throw new Error('node-bundle-node-header-invalid');
    const peOffset = head.readUInt32LE(0x3c);
    if (peOffset + 6 > read || head.readUInt32LE(peOffset) !== 0x00004550 || head.readUInt16LE(peOffset + 4) !== 0x8664) {
      throw new Error('node-bundle-node-architecture-invalid');
    }
  } finally { fileSystem.closeSync(fd); }
  return true;
}

function validateCallbackUrl(value, accountId) {
  let parsed;
  try { parsed = new URL(String(value || '')); } catch (_) { return false; }
  return parsed.protocol === 'http:' && parsed.hostname === '127.0.0.1' && !parsed.username && !parsed.password
    && parsed.port && parsed.pathname === '/qq/onebot/v11/' + accountId && !!parsed.searchParams.get('token')
    && !parsed.hash && Array.from(parsed.searchParams.keys()).every(key => key === 'token');
}

function callbackToken(value) {
  try { return new URL(String(value || '')).searchParams.get('token') || ''; }
  catch (_) { return ''; }
}

function reserveLoopbackPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address() && server.address().port;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

function createQQNapCatManager(options) {
  options = options || {};
  const fileSystem = options.fs || fs;
  const platform = options.platform || process.platform;
  const arch = options.arch || process.arch;
  const rootDir = path.resolve(String(options.rootDir || path.join(os.tmpdir(), 'InternalBeyond', 'components', 'qq-napcat-p1')));
  const allowedParent = path.resolve(String(options.allowedParent || path.dirname(rootDir)));
  const manifestPath = path.join(rootDir, MANIFEST_NAME);
  const accountsDir = path.join(rootDir, 'accounts');
  const requestJsonImpl = options.requestJson || requestJson;
  const downloadRequestClient = options.downloadRequestClient || https;
  const downloadIdleTimeoutMs = Number(options.downloadIdleTimeoutMs) > 0 ? Number(options.downloadIdleTimeoutMs) : DOWNLOAD_IDLE_TIMEOUT_MS;
  const downloadImpl = options.downloadToFile || ((url, filePath, size, onProgress, signal, resumeInfo) =>
    downloadToFile(url, filePath, size, onProgress, signal, 0, downloadRequestClient, downloadIdleTimeoutMs, resumeInfo));
  const extractImpl = options.extractZipArchive || napcatZip.extractZipArchive;
  const spawnImpl = options.spawnProcess || spawn;
  const allocatePortImpl = options.allocatePort || reserveLoopbackPort;
  const startupStabilityMs = Number.isFinite(Number(options.startupStabilityMs)) && Number(options.startupStabilityMs) >= 0
    ? Number(options.startupStabilityMs) : DEFAULT_STARTUP_STABILITY_MS;
  const logger = typeof options.logger === 'function' ? options.logger : () => {};
  const openFolderImpl = options.openFolder || ((folder) => new Promise((resolve, reject) => {
    if (platform !== 'win32') { reject(new Error('open-folder-unsupported')); return; }
    execFile('explorer.exe', [folder], { windowsHide: false }, error => error ? reject(error) : resolve(true));
  }));
  const openUrlImpl = options.openUrl || ((url) => new Promise((resolve, reject) => {
    if (platform !== 'win32') { reject(new Error('open-url-unsupported')); return; }
    execFile('explorer.exe', [url], { windowsHide: false }, error => error ? reject(error) : resolve(true));
  }));
  let downloadOperation = null;
  let downloadController = null;
  let presentedRelease = null;
  let downloadState = { state: 'idle', receivedBytes: 0, totalBytes: 0, speedBytesPerSecond: 0, etaSeconds: null, progressUpdatedAt: null, error: '' };
  const installOperations = new Map();
  const installControllers = new Map();
  const processByAccount = new Map();
  const accountRuntimeState = new Map();

  function diagnosticText(processInfo) {
    return (processInfo && Array.isArray(processInfo.diagnosticLines) ? processInfo.diagnosticLines : [])
      .slice(-MAX_DIAGNOSTIC_LINES).join('\n').slice(-MAX_DIAGNOSTIC_CHARS);
  }

  function runtimeLog(level, event, fields) {
    try { logger(level, event, fields || {}); } catch (_) { /* diagnostics never block NapCat lifecycle */ }
  }

  function recordNapCatOutput(processInfo, streamName, line) {
    const safe = sanitizeNapCatDiagnostic(line, processInfo && processInfo.accountId);
    if (!safe) return;
    processInfo.diagnosticLines.push('[' + streamName + '] ' + safe);
    if (processInfo.diagnosticLines.length > MAX_DIAGNOSTIC_LINES) {
      processInfo.diagnosticLines.splice(0, processInfo.diagnosticLines.length - MAX_DIAGNOSTIC_LINES);
    }
    if (processByAccount.get(processInfo.accountId) === processInfo) {
      const current = accountRuntimeState.get(processInfo.accountId) || {};
      accountRuntimeState.set(processInfo.accountId, Object.assign({}, current, { diagnostic: diagnosticText(processInfo) }));
    }
  }

  function captureNapCatOutput(processInfo, streamName) {
    const stream = processInfo.child && processInfo.child[streamName];
    if (!stream || typeof stream.on !== 'function') return;
    let pending = '';
    let flushed = false;
    const flush = () => {
      if (flushed || !pending) return;
      flushed = true;
      recordNapCatOutput(processInfo, streamName, pending);
      pending = '';
    };
    stream.on('data', chunk => {
      pending += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk || '');
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() || '';
      for (const line of lines) recordNapCatOutput(processInfo, streamName, line);
      if (pending.length > 4096) {
        recordNapCatOutput(processInfo, streamName, pending.slice(-4096) + ' [line truncated]');
        pending = '';
      }
    });
    stream.once('end', flush);
    stream.once('close', flush);
  }

  function readRootManifest() {
    try {
      let anchor = path.resolve(allowedParent);
      while (anchor && !fileSystem.existsSync(anchor)) {
        const parent = path.dirname(anchor);
        if (parent === anchor) return { exists: true, conflict: true, value: null };
        anchor = parent;
      }
      const anchorStat = fileSystem.lstatSync(anchor);
      if (!anchorStat.isDirectory() || anchorStat.isSymbolicLink()) return { exists: true, conflict: true, value: null };
      const rootRelative = path.relative(anchor, rootDir);
      if (!rootRelative || rootRelative === '..' || rootRelative.startsWith('..' + path.sep) || path.isAbsolute(rootRelative)) {
        return { exists: true, conflict: true, value: null };
      }
      let current = anchor;
      for (const segment of rootRelative.split(path.sep)) {
        current = path.join(current, segment);
        let stat;
        try { stat = fileSystem.lstatSync(current); }
        catch (error) { if (error && error.code === 'ENOENT') break; throw error; }
        if (stat.isSymbolicLink()) return { exists: true, conflict: true, value: null };
        if (current.toLowerCase() !== rootDir.toLowerCase() && !stat.isDirectory()) return { exists: true, conflict: true, value: null };
      }
    } catch (error) {
      if (!error || error.code !== 'ENOENT') return { exists: true, conflict: true, value: null };
    }
    try {
      const rootStat = fileSystem.lstatSync(rootDir);
      if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) return { exists: true, conflict: true, value: null };
    } catch (error) {
      if (error && error.code === 'ENOENT') return { exists: false, conflict: false, value: null };
      return { exists: true, conflict: true, value: null };
    }
    try {
      const stat = fileSystem.lstatSync(manifestPath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32 * 1024) return { exists: true, conflict: true, value: null };
      const value = JSON.parse(fileSystem.readFileSync(manifestPath, 'utf8'));
      if (!value || value.repository !== REPOSITORY || value.assetName !== ASSET_NAME) return { exists: true, conflict: true, value: null };
      return { exists: true, conflict: false, value };
    } catch (_) { return { exists: true, conflict: true, value: null }; }
  }

  function writeJsonAtomic(filePath, value) {
    const temporary = filePath + '.' + crypto.randomBytes(8).toString('hex') + '.tmp';
    fileSystem.writeFileSync(temporary, JSON.stringify(value, null, 2), { flag: 'wx', mode: 0o600 });
    fileSystem.renameSync(temporary, filePath);
  }

  async function renameFileWithRetry(source, destination) {
    const retryable = new Set(['EPERM', 'EACCES', 'EBUSY']);
    for (let attempt = 0; attempt < 8; attempt++) {
      try { fileSystem.renameSync(source, destination); return; }
      catch (error) {
        if (!retryable.has(String(error && error.code || '')) || attempt === 7) throw error;
        await new Promise(resolve => setTimeout(resolve, 25 * (attempt + 1)));
      }
    }
  }

  async function writeJsonAtomicWithRetry(filePath, value) {
    const temporary = filePath + '.' + crypto.randomBytes(8).toString('hex') + '.tmp';
    fileSystem.writeFileSync(temporary, JSON.stringify(value, null, 2), { flag: 'wx', mode: 0o600 });
    try { await renameFileWithRetry(temporary, filePath); }
    catch (error) {
      try { if (fileSystem.existsSync(temporary)) fileSystem.unlinkSync(temporary); } catch (_) { /* preserve the old manifest */ }
      throw error;
    }
  }

  function writeRootManifest(value) { writeJsonAtomic(manifestPath, value); }

  function regularArchive() {
    try {
      const stat = fileSystem.lstatSync(path.join(rootDir, ASSET_NAME));
      return stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size <= MAX_ASSET_BYTES ? stat : null;
    } catch (_) { return null; }
  }

  function resumablePart(manifest, release) {
    if (!manifest || manifest.state !== 'interrupted' || manifest.repository !== REPOSITORY
      || manifest.assetName !== ASSET_NAME || manifest.tag !== release.tag
      || String(manifest.sha256 || '').toLowerCase() !== release.sha256 || Number(manifest.size) !== release.size) return null;
    const fileName = String(manifest.temporaryFileName || '');
    const etag = strongEtag(manifest.etag);
    const bytes = Number(manifest.receivedBytes) || 0;
    if (!/^NapCat\.Shell\.Windows\.Node\.zip\.part-[a-f0-9]{16}$/.test(fileName)
      || !etag || bytes <= 0 || bytes >= release.size) return null;
    const filePath = path.join(rootDir, fileName);
    try {
      const stat = fileSystem.lstatSync(filePath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== bytes) return null;
      return { fileName, filePath, resumeInfo: { bytes, etag } };
    } catch (_) { return null; }
  }

  function accountIdValid(value) { return ACCOUNT_ID_RE.test(String(value || '')); }
  function accountDir(accountId) { return path.join(accountsDir, String(accountId)); }
  function accountManifestPath(accountId) { return path.join(accountDir(accountId), ACCOUNT_MANIFEST_NAME); }

  function readAccountManifest(accountId) {
    if (!accountIdValid(accountId)) return { exists: false, conflict: true, value: null };
    const dir = accountDir(accountId);
    try {
      const dirStat = fileSystem.lstatSync(dir);
      if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) return { exists: true, conflict: true, value: null };
    } catch (error) {
      if (error && error.code === 'ENOENT') return { exists: false, conflict: false, value: null };
      return { exists: true, conflict: true, value: null };
    }
    try {
      const marker = accountManifestPath(accountId);
      const stat = fileSystem.lstatSync(marker);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 128 * 1024) return { exists: true, conflict: true, value: null };
      const value = JSON.parse(fileSystem.readFileSync(marker, 'utf8'));
      if (!value || value.repository !== REPOSITORY || value.accountId !== String(accountId) || value.state !== 'installed') return { exists: true, conflict: true, value: null };
      return { exists: true, conflict: false, value };
    } catch (_) { return { exists: true, conflict: true, value: null }; }
  }

  function writeAccountManifest(accountId, value) { writeJsonAtomic(accountManifestPath(accountId), value); }

  function getEnvironment() {
    const owned = readRootManifest();
    const supported = platform === 'win32' && arch === 'x64';
    let writable = false;
    let writablePath = rootDir;
    while (writablePath && !fileSystem.existsSync(writablePath)) {
      const parent = path.dirname(writablePath);
      if (parent === writablePath) break;
      writablePath = parent;
    }
    try { fileSystem.accessSync(writablePath, fs.constants.W_OK); writable = true; } catch (_) { writable = false; }
    let availableBytes = null;
    if (typeof fileSystem.statfsSync === 'function') {
      try {
        const disk = fileSystem.statfsSync(writablePath);
        availableBytes = Number(disk.bavail) * Number(disk.bsize);
        if (!Number.isFinite(availableBytes) || availableBytes < 0) availableBytes = null;
      } catch (_) { availableBytes = null; }
    }
    let destination = 'available';
    if (owned.exists && owned.conflict) destination = 'occupied';
    else if (owned.value && owned.value.state === 'verified' && regularArchive()) destination = 'downloaded';
    else if (owned.value) destination = 'managed';
    return {
      ok: true,
      supported,
      canWrite: writable,
      availableBytes,
      platform: platform,
      architecture: arch,
      homeNode: true,
      destination: destination,
      installDirectory: rootDir,
      existingQQScanned: false,
      existingQQModified: false
    };
  }

  function normalizeRelease(release) {
    if (!release || release.draft === true || release.prerelease === true) throw new Error('release-not-stable');
    const tag = safeTag(release.tag_name);
    if (!tag) throw new Error('release-tag-invalid');
    const htmlUrl = String(release.html_url || '');
    if (htmlUrl !== 'https://github.com/' + REPOSITORY + '/releases/tag/' + tag) throw new Error('release-source-invalid');
    const assets = Array.isArray(release.assets) ? release.assets : [];
    const asset = assets.find(row => row && row.name === ASSET_NAME);
    if (!asset) throw new Error('windows-node-asset-unavailable');
    const sha = String(asset.digest || '').replace(/^sha256:/i, '').toLowerCase();
    const size = Number(asset.size || 0);
    const url = String(asset.browser_download_url || '');
    const expectedPath = '/NapNeko/NapCatQQ/releases/download/' + tag + '/' + ASSET_NAME;
    let parsed;
    try { parsed = new URL(url); } catch (_) { throw new Error('asset-url-invalid'); }
    if (!/^[a-f0-9]{64}$/.test(sha)) throw new Error('release-sha256-unavailable');
    if (!Number.isSafeInteger(size) || size < 1 || size > MAX_ASSET_BYTES) throw new Error('release-asset-size-invalid');
    if (parsed.protocol !== 'https:' || parsed.hostname !== 'github.com' || parsed.port || parsed.username || parsed.password || parsed.pathname !== expectedPath) {
      throw new Error('asset-source-invalid');
    }
    return { repository: REPOSITORY, tag, releaseUrl: htmlUrl, assetName: ASSET_NAME, downloadUrl: url, size, sha256: sha };
  }

  async function latestRelease() {
    if (platform !== 'win32' || arch !== 'x64') return { ok: false, error: 'windows-x64-required', releasesUrl: RELEASES_PAGE };
    try {
      const normalized = normalizeRelease(await requestJsonImpl(RELEASE_API));
      presentedRelease = normalized;
      return { ok: true, release: normalized };
    } catch (error) { return { ok: false, error: safeError(error), releasesUrl: RELEASES_PAGE }; }
  }

  async function runDownload(confirmation) {
    if (!confirmation || confirmation.confirmed !== true) throw new Error('download-confirmation-required');
    const environment = getEnvironment();
    if (!environment.supported) throw new Error('windows-x64-required');
    if (!environment.canWrite) throw new Error('managed-directory-not-writable');
    if (environment.destination === 'occupied') throw new Error('managed-directory-conflict');
    const releaseResult = await latestRelease();
    if (!releaseResult.ok) throw new Error(releaseResult.error);
    const release = releaseResult.release;
    if (environment.availableBytes != null && environment.availableBytes < release.size + 32 * 1024 * 1024) throw new Error('disk-space-insufficient');
    if (String(confirmation.tag || '') !== release.tag || String(confirmation.sha256 || '').toLowerCase() !== release.sha256) {
      throw new Error('release-changed-reconfirm');
    }
    const current = readRootManifest();
    if (current.conflict) throw new Error('managed-directory-conflict');
    const archivePath = path.join(rootDir, ASSET_NAME);
    if (current.value && current.value.state === 'verified' && current.value.tag === release.tag) {
      const stat = regularArchive();
      if (stat && stat.size === release.size) {
        const digest = await hashFile(archivePath, fileSystem);
        if (digest.sha256 === release.sha256) {
          downloadState = { state: 'verified', receivedBytes: release.size, totalBytes: release.size, speedBytesPerSecond: 0, etaSeconds: null, error: '', release };
          return;
        }
        throw new Error('existing-package-integrity-mismatch');
      }
    }
    if (fileSystem.existsSync(archivePath)) throw new Error('package-path-conflict');
    ensureDirectoryChain(path.dirname(rootDir), allowedParent, fileSystem);
    if (!fileSystem.existsSync(rootDir)) fileSystem.mkdirSync(rootDir, { recursive: false });
    else if (readRootManifest().conflict) throw new Error('managed-directory-conflict');
    const previous = readRootManifest();
    const resume = resumablePart(previous.value, release);
    if (!resume && previous.value && /^NapCat\.Shell\.Windows\.Node\.zip\.part-[a-f0-9]{16}$/.test(String(previous.value.temporaryFileName || ''))) {
      const oldPart = path.join(rootDir, previous.value.temporaryFileName);
      try { const stat = fileSystem.lstatSync(oldPart); if (stat.isFile() && !stat.isSymbolicLink() && stat.size <= MAX_ASSET_BYTES) fileSystem.unlinkSync(oldPart); }
      catch (_) { /* no previous manager-owned fragment */ }
    }
    const partName = resume ? resume.fileName : ASSET_NAME + '.part-' + crypto.randomBytes(8).toString('hex');
    const partPath = resume ? resume.filePath : path.join(rootDir, partName);
    const resumeOffset = resume ? resume.resumeInfo.bytes : 0;
    downloadController = new AbortController();
    downloadState = { state: 'downloading', receivedBytes: resumeOffset, totalBytes: release.size, speedBytesPerSecond: 0,
      etaSeconds: null, progressUpdatedAt: null, resumeAvailable: !!resume, error: '', release };
    writeRootManifest({ repository: REPOSITORY, tag: release.tag, assetName: ASSET_NAME, sha256: release.sha256, size: release.size,
      state: 'downloading', temporaryFileName: partName, receivedBytes: resumeOffset, etag: resume && resume.resumeInfo.etag || '',
      updatedAt: new Date().toISOString() });
    try {
      let previousAt = 0;
      let previousBytes = resumeOffset;
      let speed = 0;
      let activeResumeOffset = resumeOffset;
      const result = await downloadImpl(release.downloadUrl, partPath, release.size, (received, total, metadata) => {
        const now = Date.now();
        const bytes = Math.max(0, Number(received) || 0);
        const reportedResumeOffset = Math.max(0, Number(metadata && metadata.resumedBytes) || 0);
        if (reportedResumeOffset !== activeResumeOffset) {
          activeResumeOffset = reportedResumeOffset;
          previousAt = 0;
          previousBytes = reportedResumeOffset;
          speed = 0;
        }
        if (previousAt === 0) {
          previousAt = now;
          previousBytes = Math.max(previousBytes, reportedResumeOffset);
        } else {
          const elapsed = (now - previousAt) / 1000;
          if (elapsed >= 0.1 && bytes >= previousBytes) {
            const sample = (bytes - previousBytes) / elapsed;
            speed = speed > 0 ? speed * 0.65 + sample * 0.35 : sample;
            previousAt = now;
            previousBytes = bytes;
          }
        }
        const totalBytes = Math.max(0, Number(total) || Number(release.size) || 0);
        downloadState = Object.assign({}, downloadState, {
          receivedBytes: bytes,
          totalBytes,
          speedBytesPerSecond: Math.max(0, Math.round(speed)),
          progressUpdatedAt: now,
          resumeAvailable: activeResumeOffset > 0,
          etaSeconds: totalBytes > bytes && speed > 0 ? Math.max(0, Math.ceil((totalBytes - bytes) / speed)) : null
        });
      }, downloadController.signal, resume && resume.resumeInfo);
      if (downloadController.signal.aborted) throw new Error('download-cancelled');
      downloadState = Object.assign({}, downloadState, { state: 'verifying', receivedBytes: release.size, totalBytes: release.size,
        speedBytesPerSecond: 0, etaSeconds: null, progressUpdatedAt: null, resumeAvailable: false });
      writeRootManifest({ repository: REPOSITORY, tag: release.tag, assetName: ASSET_NAME, sha256: release.sha256, size: release.size,
        state: 'verifying', temporaryFileName: partName, updatedAt: new Date().toISOString() });
      const resumedBytes = Number(result && result.resumedBytes) || 0;
      if (!result || result.bytes !== release.size || (!resumedBytes && result.sha256 !== release.sha256)) throw new Error('asset-sha256-mismatch');
      const actual = await hashFile(partPath, fileSystem);
      if (downloadController.signal.aborted) throw new Error('download-cancelled');
      if (actual.bytes !== release.size) throw new Error('asset-size-mismatch');
      if (actual.sha256 !== release.sha256) throw new Error('asset-sha256-mismatch');
      fileSystem.renameSync(partPath, archivePath);
      writeRootManifest({ repository: REPOSITORY, tag: release.tag, assetName: ASSET_NAME, sha256: release.sha256, size: release.size,
        state: 'verified', updatedAt: new Date().toISOString() });
      downloadState = { state: 'verified', receivedBytes: release.size, totalBytes: release.size, speedBytesPerSecond: 0,
        etaSeconds: null, progressUpdatedAt: null, resumeAvailable: false, error: '', release };
    } catch (error) {
      let resumable = null;
      const info = error && error.resumeInfo;
      if (info && /^NapCat\.Shell\.Windows\.Node\.zip\.part-[a-f0-9]{16}$/.test(partName)
        && strongEtag(info.etag) && Number(info.bytes) > 0 && Number(info.bytes) < release.size) {
        try {
          const stat = fileSystem.lstatSync(partPath);
          if (stat.isFile() && !stat.isSymbolicLink() && stat.size === Number(info.bytes)) {
            resumable = { bytes: stat.size, etag: strongEtag(info.etag) };
          }
        } catch (_) { resumable = null; }
      }
      if (resumable) {
        error.resumeInfo = resumable;
        writeRootManifest({ repository: REPOSITORY, tag: release.tag, assetName: ASSET_NAME, sha256: release.sha256, size: release.size,
          state: 'interrupted', temporaryFileName: partName, receivedBytes: resumable.bytes, etag: resumable.etag, updatedAt: new Date().toISOString() });
      } else {
        try { const stat = fileSystem.lstatSync(partPath); if (stat.isFile() && !stat.isSymbolicLink()) fileSystem.unlinkSync(partPath); }
        catch (_) { /* manager-owned partial only */ }
      }
      throw error;
    }
  }

  function startDownload(input) {
    if (!input || input.confirmed !== true || !presentedRelease
      || String(input.tag || '') !== presentedRelease.tag
      || String(input.sha256 || '').toLowerCase() !== presentedRelease.sha256) return Promise.resolve({ ok: false, error: 'download-confirmation-required' });
    if (downloadOperation) return Promise.resolve({ ok: false, error: 'download-already-running' });
    const confirmation = { confirmed: true, tag: String(input.tag || ''), sha256: String(input.sha256 || '') };
    downloadOperation = runDownload(confirmation).catch(error => {
      const message = safeError(error);
      const resumeInfo = error && error.resumeInfo;
      downloadState = Object.assign({}, downloadState, {
        state: 'failed', error: message, resumeAvailable: !!resumeInfo,
        receivedBytes: resumeInfo ? Number(resumeInfo.bytes) || 0 : downloadState.receivedBytes
      });
      const owned = readRootManifest();
      if (owned.value) {
        const nextState = resumeInfo ? 'interrupted' : 'failed';
        const patch = { state: nextState, error: message, updatedAt: new Date().toISOString() };
        if (resumeInfo) {
          patch.receivedBytes = Number(resumeInfo.bytes) || 0;
          patch.etag = strongEtag(resumeInfo.etag);
        }
        try { writeRootManifest(Object.assign({}, owned.value, patch)); }
        catch (_) { /* state still reports the error */ }
      }
    }).finally(() => { downloadOperation = null; downloadController = null; });
    return Promise.resolve({ ok: true, started: true });
  }

  function getDownloadStatus() {
    const owned = readRootManifest();
    if (owned.conflict) return { ok: true, state: 'conflict', active: false, receivedBytes: 0, totalBytes: 0, error: 'managed-directory-conflict' };
    if (!downloadOperation && owned.value && owned.value.state === 'verified' && regularArchive()) {
      downloadState = Object.assign({}, downloadState, { state: 'verified', receivedBytes: Number(owned.value.size) || downloadState.receivedBytes,
        totalBytes: Number(owned.value.size) || downloadState.totalBytes, release: { tag: owned.value.tag, size: owned.value.size, sha256: owned.value.sha256 } });
    } else if (!downloadOperation && owned.value && owned.value.state === 'interrupted') {
      const release = { tag: String(owned.value.tag || ''), size: Number(owned.value.size) || 0, sha256: String(owned.value.sha256 || '') };
      const resume = resumablePart(owned.value, release);
      downloadState = Object.assign({}, downloadState, {
        state: 'failed', active: false, receivedBytes: resume ? resume.resumeInfo.bytes : 0,
        totalBytes: release.size, speedBytesPerSecond: 0, etaSeconds: null, progressUpdatedAt: null,
        resumeAvailable: !!resume, error: String(owned.value.error || 'download-interrupted'), release
      });
    } else if (!downloadOperation && owned.value && owned.value.state === 'failed') {
      downloadState = Object.assign({}, downloadState, { state: 'failed', error: String(owned.value.error || 'download-failed') });
    }
    return Object.assign({}, downloadState, { ok: true, active: !!downloadOperation });
  }

  function cancelDownload() {
    if (!downloadOperation || !downloadController || downloadState.state !== 'downloading') return { ok: false, error: 'no-download-running' };
    downloadController.abort();
    return { ok: true, cancelling: true };
  }

  async function readAccountManifest(accountId) {
    if (!accountIdValid(accountId)) return { exists: false, conflict: true, value: null };
    try {
      const parentStat = fileSystem.lstatSync(accountsDir);
      if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) return { exists: true, conflict: true, value: null };
    } catch (error) {
      if (error && error.code === 'ENOENT') return { exists: false, conflict: false, value: null };
      return { exists: true, conflict: true, value: null };
    }
    const dir = accountDir(accountId);
    try {
      const dirStat = fileSystem.lstatSync(dir);
      if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) return { exists: true, conflict: true, value: null };
    } catch (error) {
      if (error && error.code === 'ENOENT') return { exists: false, conflict: false, value: null };
      return { exists: true, conflict: true, value: null };
    }
    try {
      const marker = accountManifestPath(accountId);
      const stat = fileSystem.lstatSync(marker);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 128 * 1024) return { exists: true, conflict: true, value: null };
      const value = JSON.parse(fileSystem.readFileSync(marker, 'utf8'));
      if (!value || value.repository !== REPOSITORY || value.accountId !== accountId || value.state !== 'installed') return { exists: true, conflict: true, value: null };
      return { exists: true, conflict: false, value };
    } catch (_) { return { exists: true, conflict: true, value: null }; }
  }

  function accountStatus(accountId) {
    if (!accountIdValid(accountId)) return { ok: false, error: 'invalid-account-id' };
    const install = accountRuntimeState.get(accountId);
    const child = processByAccount.get(accountId);
    const owned = readAccountManifest(accountId);
    if (owned.conflict) return { ok: true, accountId, installed: false, running: false, state: 'conflict', error: 'account-directory-conflict' };
    const running = !!(child && child.exitCode == null && !child.killed);
    const state = install && install.state === 'installing' ? 'installing'
      : install && install.state === 'starting' && running ? 'starting'
        : running ? 'running'
          : install && install.state === 'failed' ? 'failed'
            : owned.value ? 'stopped' : 'not-installed';
    return {
      ok: true,
      accountId,
      installed: !!owned.value,
      running,
      state,
      phase: String(install && install.phase || ''),
      progressBytes: install && Number(install.progressBytes) || 0,
      totalBytes: install && Number(install.totalBytes) || 0,
      error: install && install.error || '',
      installDirectory: owned.value ? accountDir(accountId) : ''
    };
  }

  function updateInstallState(accountId, patch) {
    accountRuntimeState.set(accountId, Object.assign({}, accountRuntimeState.get(accountId) || {}, patch));
  }

  async function updateCallbackConfig(accountId, callbackUrl, accountManifest) {
    const profileDir = accountDir(accountId);
    const configPath = assertRegularPath(profileDir, 'napcat/config/onebot11_' + accountId + '.json', fileSystem);
    const currentHash = (await hashFile(configPath, fileSystem)).sha256;
    if (currentHash !== accountManifest.onebotConfigSha256) throw new Error('account-config-modified');
    const originalConfig = fileSystem.readFileSync(configPath, 'utf8');
    const previousCallbackUrlSha256 = accountManifest.callbackUrlSha256;
    const cfg = JSON.parse(originalConfig);
    const clients = cfg && cfg.network && Array.isArray(cfg.network.httpClients) ? cfg.network.httpClients : [];
    const client = clients.find(row => row && row.name === 'InternalBeyond');
    if (!client) throw new Error('account-config-shape-unsupported');
    const signatureToken = callbackToken(callbackUrl);
    if (!signatureToken) throw new Error('callback-token-required');
    const callbackUrlSha256 = crypto.createHash('sha256').update(callbackUrl).digest('hex');
    if (accountManifest.callbackUrlSha256 === callbackUrlSha256
      && client.url === callbackUrl && String(client.token || '') === signatureToken) return accountManifest;
    client.url = callbackUrl;
    /* NapCat's HTTP Client uses this token to emit OneBot 11 X-Signature
       (HMAC-SHA1 over the exact JSON request body). It is the same account-
       scoped capability carried in the local callback URL. */
    client.token = signatureToken;
    const temp = configPath + '.' + crypto.randomBytes(8).toString('hex') + '.tmp';
    fileSystem.writeFileSync(temp, JSON.stringify(cfg, null, 2), { flag: 'wx', mode: 0o600 });
    try { await renameFileWithRetry(temp, configPath); }
    catch (error) {
      try { if (fileSystem.existsSync(temp)) fileSystem.unlinkSync(temp); } catch (_) { /* retain the original config */ }
      throw new Error('callback-config-replace-' + safeError(error));
    }
    accountManifest.onebotConfigSha256 = (await hashFile(configPath, fileSystem)).sha256;
    accountManifest.callbackUrlSha256 = callbackUrlSha256;
    try { await writeJsonAtomicWithRetry(accountManifestPath(accountId), accountManifest); }
    catch (error) {
      accountManifest.onebotConfigSha256 = currentHash;
      accountManifest.callbackUrlSha256 = previousCallbackUrlSha256;
      const rollback = configPath + '.' + crypto.randomBytes(8).toString('hex') + '.tmp';
      try {
        fileSystem.writeFileSync(rollback, originalConfig, { flag: 'wx', mode: 0o600 });
        await renameFileWithRetry(rollback, configPath);
      } catch (_) { try { if (fileSystem.existsSync(rollback)) fileSystem.unlinkSync(rollback); } catch (_) { /* best effort */ } }
      throw new Error('callback-manifest-update-' + safeError(error));
    }
    return accountManifest;
  }

  async function hasValidCallbackSignatureConfig(accountId, accountManifest) {
    if (!accountManifest) return false;
    try {
      const configPath = assertRegularPath(accountDir(accountId), 'napcat/config/onebot11_' + accountId + '.json', fileSystem);
      if ((await hashFile(configPath, fileSystem)).sha256 !== accountManifest.onebotConfigSha256) return false;
      const cfg = JSON.parse(fileSystem.readFileSync(configPath, 'utf8'));
      const clients = cfg && cfg.network && Array.isArray(cfg.network.httpClients) ? cfg.network.httpClients : [];
      const client = clients.find(row => row && row.name === 'InternalBeyond' && row.enable === true);
      const token = String(client && client.token || '');
      return !!token && token === callbackToken(client && client.url)
        && accountManifest.callbackUrlSha256 === crypto.createHash('sha256').update(String(client.url || '')).digest('hex');
    } catch (_) { return false; }
  }

  async function createAccountInstall(accountId, callbackUrl, controller) {
    const existing = await readAccountManifest(accountId);
    if (existing.conflict) throw new Error('account-directory-conflict');
    if (existing.value) {
      const updated = await updateCallbackConfig(accountId, callbackUrl, existing.value);
      return { directory: accountDir(accountId), manifest: updated };
    }
    const rootManifest = readRootManifest();
    if (rootManifest.conflict || !rootManifest.value || rootManifest.value.state !== 'verified') throw new Error('verified-package-required');
    const archivePath = path.join(rootDir, ASSET_NAME);
    const archiveStat = regularArchive();
    if (!archiveStat || archiveStat.size !== Number(rootManifest.value.size)) throw new Error('package-path-conflict');
    const archiveHash = await hashFile(archivePath, fileSystem);
    if (archiveHash.sha256 !== rootManifest.value.sha256) throw new Error('package-integrity-mismatch');
    if (typeof fileSystem.statfsSync !== 'function') throw new Error('disk-space-check-unavailable');
    const archiveInfo = napcatZip.inspectZipArchive(archivePath, { fs: fileSystem });
    const disk = fileSystem.statfsSync(rootDir);
    const freeBytes = Number(disk.bavail) * Number(disk.bsize);
    if (!Number.isFinite(freeBytes) || freeBytes < archiveInfo.uncompressedBytes + 64 * 1024 * 1024) throw new Error('disk-space-insufficient');

    ensureDirectoryChain(accountsDir, rootDir, fileSystem);
    const accountPath = accountDir(accountId);
    if (fileSystem.existsSync(accountPath)) throw new Error('account-directory-conflict');
    const stagePath = path.join(accountsDir, '.stage-' + accountId + '-' + crypto.randomBytes(8).toString('hex'));
    const stageRelative = path.relative(rootDir, path.resolve(stagePath));
    if (stageRelative === '..' || stageRelative.startsWith('..' + path.sep) || path.isAbsolute(stageRelative)) throw new Error('account-stage-path-invalid');
    updateInstallState(accountId, { state: 'installing', phase: 'extracting', progressBytes: 0, totalBytes: archiveInfo.uncompressedBytes });
    try {
      const extracted = await extractImpl(archivePath, stagePath, {
        fs: fileSystem,
        signal: controller.signal,
        onProgress: (done, total) => updateInstallState(accountId, { state: 'installing', phase: 'extracting', progressBytes: Number(done) || 0, totalBytes: Number(total) || 0 }),
        validatePackage: folder => validateNodeBundle(folder, fileSystem),
        onFailure: failedPath => {
          const rel = path.relative(rootDir, path.resolve(failedPath));
          if (rel.startsWith('accounts' + path.sep + '.stage-' + accountId + '-') && !path.isAbsolute(rel) && fileSystem.existsSync(failedPath)) {
            fileSystem.rmSync(failedPath, { recursive: true, force: true });
          }
        }
      });
      updateInstallState(accountId, { state: 'installing', phase: 'configuring', progressBytes: archiveInfo.uncompressedBytes, totalBytes: archiveInfo.uncompressedBytes });
      validateNodeBundle(stagePath, fileSystem);
      const configDir = path.join(stagePath, 'napcat', 'config');
      fileSystem.mkdirSync(configDir, { recursive: true });
      const webUiPath = path.join(configDir, 'webui.json');
      let webUi = {};
      if (fileSystem.existsSync(webUiPath)) {
        const stat = fileSystem.lstatSync(webUiPath);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32 * 1024) throw new Error('webui-config-path-invalid');
        webUi = JSON.parse(fileSystem.readFileSync(webUiPath, 'utf8'));
      }
      const port = Number(await allocatePortImpl());
      if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('webui-port-allocation-failed');
      const webUiToken = crypto.randomBytes(32).toString('base64url');
      webUi = Object.assign({}, webUi, { host: '127.0.0.1', port, token: webUiToken, loginRate: 3 });
      writeJsonAtomic(webUiPath, webUi);
      const onebotPath = path.join(configDir, 'onebot11_' + accountId + '.json');
      if (fileSystem.existsSync(onebotPath)) throw new Error('account-config-path-conflict');
      const onebotConfig = {
        network: {
          httpServers: [],
          httpClients: [{ name: 'InternalBeyond', enable: true, url: callbackUrl, messagePostFormat: 'array', reportSelfMessage: false, token: callbackToken(callbackUrl), debug: false }],
          websocketServers: [],
          websocketClients: []
        },
        musicSignUrl: '',
        enableLocalFile2Url: false,
        parseMultMsg: false
      };
      fileSystem.writeFileSync(onebotPath, JSON.stringify(onebotConfig, null, 2), { flag: 'wx', mode: 0o600 });
      const extractedFiles = Object.create(null);
      (extracted && Array.isArray(extracted.files) ? extracted.files : []).forEach(item => { extractedFiles[item.name] = item.sha256; });
      const protectedFiles = {};
      for (const relative of REQUIRED_FILES) {
        const entry = extractedFiles[relative];
        if (!entry) throw new Error('node-bundle-manifest-missing-' + relative.replace(/[^A-Za-z0-9]/g, '-'));
        protectedFiles[relative] = entry;
      }
      const manifest = {
        repository: REPOSITORY,
        accountId,
        tag: rootManifest.value.tag,
        assetSha256: rootManifest.value.sha256,
        state: 'installed',
        files: protectedFiles,
        onebotConfigSha256: (await hashFile(onebotPath, fileSystem)).sha256,
        callbackUrlSha256: crypto.createHash('sha256').update(callbackUrl).digest('hex'),
        webUiConfigSha256: (await hashFile(webUiPath, fileSystem)).sha256,
        webUiPort: port,
        createdAt: new Date().toISOString()
      };
      writeJsonAtomic(path.join(stagePath, ACCOUNT_MANIFEST_NAME), manifest);
      if (fileSystem.existsSync(accountPath)) throw new Error('account-directory-conflict');
      fileSystem.renameSync(stagePath, accountPath);
      return { directory: accountPath, manifest };
    } catch (error) {
      try {
        if (fileSystem.existsSync(stagePath)) {
          const stat = fileSystem.lstatSync(stagePath);
          if (stat.isDirectory() && !stat.isSymbolicLink()) fileSystem.rmSync(stagePath, { recursive: true, force: true });
        }
      } catch (_) { /* preserve unknown files if safe cleanup fails */ }
      throw error;
    }
  }

  function accountEnvironment(accountId) {
    const profile = path.join(accountDir(accountId), 'qq-profile');
    const local = path.join(profile, 'AppData', 'Local');
    const roaming = path.join(profile, 'AppData', 'Roaming');
    const temp = path.join(profile, 'Temp');
    ensureDirectoryChain(local, accountDir(accountId), fileSystem);
    ensureDirectoryChain(roaming, accountDir(accountId), fileSystem);
    ensureDirectoryChain(temp, accountDir(accountId), fileSystem);
    const env = Object.assign({}, process.env);
    delete env.NODE_OPTIONS;
    delete env.NODE_PATH;
    env.USERPROFILE = profile;
    env.LOCALAPPDATA = local;
    env.APPDATA = roaming;
    env.TEMP = temp;
    env.TMP = temp;
    env.HOME = profile;
    const root = path.parse(profile).root;
    env.HOMEDRIVE = root.slice(0, 2);
    env.HOMEPATH = profile.slice(root.length - 1);
    return env;
  }

  async function verifyInstalledBundle(accountId, accountManifest) {
    const dir = accountDir(accountId);
    validateNodeBundle(dir, fileSystem);
    for (const relative of REQUIRED_FILES) {
      const expected = accountManifest.files && accountManifest.files[relative];
      if (!/^[a-f0-9]{64}$/.test(String(expected || ''))) throw new Error('account-package-manifest-invalid');
      const file = path.join(dir, ...relative.split('/'));
      const stat = fileSystem.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('account-package-file-invalid');
      if ((await hashFile(file, fileSystem)).sha256 !== expected) throw new Error('account-package-file-integrity-mismatch');
    }
    const configPath = path.join(dir, 'napcat', 'config', 'onebot11_' + accountId + '.json');
    if ((await hashFile(configPath, fileSystem)).sha256 !== accountManifest.onebotConfigSha256) throw new Error('account-config-modified');
  }

  function finishNapCatProcess(processInfo, code, signal, spawnError) {
    if (!processInfo || processInfo.finished) return;
    processInfo.finished = true;
    if (processInfo.startupTimer) clearTimeout(processInfo.startupTimer);
    processInfo.exitCode = Number.isInteger(code) ? code : null;
    processInfo.exitSignal = signal || null;
    if (spawnError) processInfo.spawnError = 'napcat-spawn-' + safeError(spawnError);
    const intentional = processInfo.stopRequested === true;
    const error = intentional ? '' : (processInfo.spawnError || napCatExitError(code, signal));
    const diagnostic = diagnosticText(processInfo);
    if (processByAccount.get(processInfo.accountId) === processInfo) processByAccount.delete(processInfo.accountId);
    accountRuntimeState.set(processInfo.accountId, {
      state: intentional ? 'stopped' : 'failed',
      phase: intentional ? 'stopped' : 'exited',
      error,
      diagnostic,
      progressBytes: 0,
      totalBytes: 0
    });
    runtimeLog(intentional ? 'info' : 'error', intentional ? 'qq-napcat-process-stopped' : 'qq-napcat-process-exited', {
      accountId: processInfo.accountId,
      pid: Number(processInfo.child && processInfo.child.pid) || 0,
      exitCode: processInfo.exitCode,
      signal: processInfo.exitSignal,
      requestedStop: intentional,
      error,
      diagnostic
    });
  }

  function markNapCatProcessExited(processInfo, code, signal) {
    if (!processInfo || processInfo.finished) return;
    processInfo.exitCode = Number.isInteger(code) ? code : null;
    processInfo.exitSignal = signal || null;
    const intentional = processInfo.stopRequested === true;
    const error = intentional ? '' : (processInfo.spawnError || napCatExitError(code, signal));
    accountRuntimeState.set(processInfo.accountId, {
      state: intentional ? 'stopping' : 'failed',
      phase: intentional ? 'stopping' : 'exited',
      error,
      diagnostic: diagnosticText(processInfo),
      progressBytes: 0,
      totalBytes: 0
    });
  }

  function startAccount(input) {
    input = input && typeof input === 'object' ? input : {};
    const accountId = String(input.accountId || '');
    const callbackUrl = String(input.callbackUrl || '');
    if (input.confirmed !== true) return Promise.resolve({ ok: false, error: 'start-confirmation-required' });
    if (!accountIdValid(accountId)) return Promise.resolve({ ok: false, error: 'invalid-account-id' });
    if (!validateCallbackUrl(callbackUrl, accountId)) return Promise.resolve({ ok: false, error: 'callback-url-invalid' });
    const running = processByAccount.get(accountId);
    if (running && running.child && running.child.exitCode == null && !running.child.killed) return Promise.resolve({ ok: true, alreadyRunning: true });
    if (installOperations.has(accountId)) return Promise.resolve({ ok: false, error: 'account-install-already-running' });
    if (installOperations.size) return Promise.resolve({ ok: false, error: 'another-account-install-running' });
    const controller = new AbortController();
    installControllers.set(accountId, controller);
    accountRuntimeState.set(accountId, { state: 'installing', phase: 'preparing', progressBytes: 0, totalBytes: 0, error: '' });
    const operation = createAccountInstall(accountId, callbackUrl, controller).then(async result => {
      accountRuntimeState.set(accountId, { state: 'installing', phase: 'verifying', progressBytes: 0, totalBytes: 0, error: '' });
      await verifyInstalledBundle(accountId, result.manifest);
      const nodePath = path.join(result.directory, 'node.exe');
      let child;
      try {
        child = spawnImpl(nodePath, ['index.js', '-q', accountId], {
          cwd: result.directory,
          env: accountEnvironment(accountId),
          windowsHide: true,
          detached: false,
          stdio: ['ignore', 'pipe', 'pipe']
        });
      } catch (error) {
        const diagnostic = sanitizeNapCatDiagnostic(error && (error.message || error.code) || error, accountId);
        accountRuntimeState.set(accountId, { state: 'failed', phase: 'spawn', progressBytes: 0, totalBytes: 0,
          error: 'napcat-spawn-' + safeError(error), diagnostic });
        runtimeLog('error', 'qq-napcat-spawn-failed', { accountId, executable: nodePath, cwd: result.directory,
          error: 'napcat-spawn-' + safeError(error), diagnostic });
        return;
      }
      const processInfo = { child, accountId, startedAt: new Date().toISOString(), startedAtMs: Date.now(),
        stopRequested: false, spawned: false, finished: false, exitCode: null, exitSignal: null,
        diagnosticLines: [], startupTimer: null };
      processByAccount.set(accountId, processInfo);
      accountRuntimeState.set(accountId, { state: 'starting', phase: 'launching', progressBytes: 0, totalBytes: 0, error: '', diagnostic: '' });
      captureNapCatOutput(processInfo, 'stdout');
      captureNapCatOutput(processInfo, 'stderr');
      runtimeLog('info', 'qq-napcat-process-starting', { accountId, pid: Number(child && child.pid) || 0,
        executable: nodePath, cwd: result.directory, args: ['index.js', '-q', '[QQ]'] });
      child.once('spawn', () => {
        const current = processByAccount.get(accountId);
        if (current && current === processInfo) {
          processInfo.spawned = true;
          accountRuntimeState.set(accountId, { state: 'starting', phase: 'checking-runtime', progressBytes: 0,
            totalBytes: 0, error: '', diagnostic: diagnosticText(processInfo) });
          processInfo.startupTimer = setTimeout(() => {
            if (processInfo.finished || processByAccount.get(accountId) !== processInfo
              || child.exitCode != null || child.signalCode != null || child.killed) return;
            accountRuntimeState.set(accountId, { state: 'running', phase: 'running', progressBytes: 0,
              totalBytes: 0, error: '', diagnostic: diagnosticText(processInfo) });
            runtimeLog('info', 'qq-napcat-process-ready', { accountId, pid: Number(child.pid) || 0,
              startupStabilityMs });
          }, startupStabilityMs);
        }
      });
      child.once('error', error => {
        processInfo.spawnError = 'napcat-spawn-' + safeError(error);
        recordNapCatOutput(processInfo, 'stderr', error && (error.message || error.code) || 'spawn failed');
        finishNapCatProcess(processInfo, null, null, error);
      });
      child.once('exit', (code, signal) => markNapCatProcessExited(processInfo, code, signal));
      child.once('close', (code, signal) => {
        finishNapCatProcess(processInfo, code, signal, null);
      });
    }).catch(error => {
      accountRuntimeState.set(accountId, { state: 'failed', progressBytes: 0, totalBytes: 0, error: safeError(error) });
    }).finally(() => {
      installOperations.delete(accountId);
      installControllers.delete(accountId);
    });
    installOperations.set(accountId, operation);
    return Promise.resolve({ ok: true, started: true });
  }

  function cancelAccountStart(accountIdValue) {
    const accountId = String(accountIdValue || '');
    const controller = installControllers.get(accountId);
    if (!accountIdValid(accountId) || !controller) return { ok: false, error: 'no-account-install-running' };
    controller.abort();
    return { ok: true, cancelling: true };
  }

  function stopAccount(accountIdValue) {
    const accountId = String(accountIdValue || '');
    const item = processByAccount.get(accountId);
    if (!accountIdValid(accountId) || !item || !item.child) return { ok: false, error: 'napcat-not-running' };
    const previousStopRequest = item.stopRequested;
    try {
      item.stopRequested = true;
      if (item.startupTimer) clearTimeout(item.startupTimer);
      const accepted = item.child.kill();
      if (accepted === false) {
        item.stopRequested = previousStopRequest === true;
        return { ok: false, error: 'napcat-stop-not-accepted' };
      }
      accountRuntimeState.set(accountId, { state: 'stopping', progressBytes: 0, totalBytes: 0, error: '', diagnostic: diagnosticText(item) });
      runtimeLog('info', 'qq-napcat-stop-requested', { accountId, pid: Number(item.child.pid) || 0 });
      return { ok: true, stopping: true };
    } catch (error) {
      item.stopRequested = previousStopRequest === true;
      const message = 'napcat-stop-' + safeError(error);
      accountRuntimeState.set(accountId, { state: 'failed', error: message, diagnostic: diagnosticText(item), progressBytes: 0, totalBytes: 0 });
      return { ok: false, error: message };
    }
  }

  async function openWebUi(accountIdValue) {
    const accountId = String(accountIdValue || '');
    const item = processByAccount.get(accountId);
    const owned = await readAccountManifest(accountId);
    if (!item || !item.child || item.child.exitCode != null || !owned.value) return { ok: false, error: 'napcat-not-running' };
    try {
      const configPath = assertRegularPath(accountDir(accountId), 'napcat/config/webui.json', fileSystem);
      const stat = fileSystem.lstatSync(configPath);
      if (stat.size > 32 * 1024) throw new Error('webui-config-invalid');
      const config = JSON.parse(fileSystem.readFileSync(configPath, 'utf8'));
      const port = Number(config.port);
      const token = String(config.token || '');
      if (config.host !== '127.0.0.1' || !Number.isInteger(port) || port < 1024 || port > 65535 || !/^[A-Za-z0-9_-]{32,128}$/.test(token)) {
        throw new Error('webui-config-invalid');
      }
      await openUrlImpl('http://127.0.0.1:' + port + '/webui?token=' + encodeURIComponent(token));
      return { ok: true, opened: true };
    } catch (error) { return { ok: false, error: safeError(error) }; }
  }

  async function statusAccount(accountIdValue) {
    const accountId = String(accountIdValue || '');
    const runtime = accountRuntimeState.get(accountId) || {};
    const owned = await readAccountManifest(accountId);
    if (!accountIdValid(accountId)) return { ok: false, error: 'invalid-account-id' };
    if (owned.conflict) return { ok: true, accountId, installed: false, running: false, state: 'conflict', error: 'account-directory-conflict' };
    const processInfo = processByAccount.get(accountId);
    const childAlive = !!(processInfo && processInfo.child && processInfo.child.exitCode == null
      && processInfo.child.signalCode == null && !processInfo.child.killed);
    const running = childAlive && runtime.state === 'running';
    const state = installOperations.has(accountId) && runtime.state === 'installing' ? 'installing'
      : runtime.state === 'failed' ? 'failed'
        : runtime.state === 'stopping' ? 'stopping'
          : childAlive && runtime.state === 'starting' ? 'starting'
            : running ? 'running'
              : (owned.value ? 'stopped' : 'not-installed');
    const callbackSignatureConfigured = await hasValidCallbackSignatureConfig(accountId, owned.value);
    return {
      ok: true,
      accountId,
      installed: !!owned.value,
      running,
      state,
      callbackSignatureConfigured,
      callbackRestartRequired: running && !callbackSignatureConfigured,
      phase: String(runtime.phase || ''),
      progressBytes: Number(runtime.progressBytes) || 0,
      totalBytes: Number(runtime.totalBytes) || 0,
      error: String(runtime.error || ''),
      diagnostic: String(runtime.diagnostic || diagnosticText(processInfo) || ''),
      installDirectory: owned.value ? accountDir(accountId) : ''
    };
  }

  async function openDownloadFolder() {
    if (getDownloadStatus().state !== 'verified') return { ok: false, error: 'verified-package-required' };
    try { await openFolderImpl(rootDir); return { ok: true, opened: true }; }
    catch (error) { return { ok: false, error: safeError(error) }; }
  }

  async function removeVerifiedArchive(input) {
    if (!input || input.confirmed !== true) return { ok: false, error: 'removal-confirmation-required' };
    const owned = readRootManifest();
    if (owned.conflict || !owned.value) return { ok: false, error: 'managed-directory-conflict' };
    const archivePath = path.join(rootDir, ASSET_NAME);
    try {
      if (fileSystem.existsSync(archivePath)) {
        const stat = fileSystem.lstatSync(archivePath);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== Number(owned.value.size) || stat.size > MAX_ASSET_BYTES) return { ok: false, error: 'package-path-conflict' };
        if ((await hashFile(archivePath, fileSystem)).sha256 !== String(owned.value.sha256 || '')) return { ok: false, error: 'package-integrity-mismatch' };
        fileSystem.unlinkSync(archivePath);
      }
      writeRootManifest(Object.assign({}, owned.value, { state: 'archive-removed', updatedAt: new Date().toISOString() }));
      downloadState = { state: 'archive-removed', receivedBytes: 0, totalBytes: 0, error: '' };
      return { ok: true, removed: ASSET_NAME, installedAccountsPreserved: true };
    } catch (error) { return { ok: false, error: safeError(error) }; }
  }

  function close() {
    if (downloadController) downloadController.abort();
    for (const controller of installControllers.values()) controller.abort();
    for (const [accountId, item] of processByAccount) {
      try {
        item.stopRequested = true;
        if (item.startupTimer) clearTimeout(item.startupTimer);
        item.child.kill();
      } catch (_) { /* service shutdown is best effort */ }
      accountRuntimeState.set(accountId, { state: 'stopping', progressBytes: 0, totalBytes: 0, error: '', diagnostic: diagnosticText(item) });
    }
  }

  return {
    environment: getEnvironment,
    latestRelease,
    startDownload,
    downloadStatus: getDownloadStatus,
    cancelDownload,
    openDownloadFolder,
    removeVerifiedArchive,
    startAccount,
    cancelAccountStart,
    stopAccount,
    openWebUi,
    statusAccount,
    close,
    rootDir
  };
}

module.exports = createQQNapCatManager;
module.exports.createQQNapCatManager = createQQNapCatManager;
module.exports.validateNodeBundle = validateNodeBundle;
module.exports.validateCallbackUrl = validateCallbackUrl;
module.exports.callbackToken = callbackToken;
module.exports.constants = Object.freeze({ RELEASE_API, RELEASES_PAGE, REPOSITORY, ASSET_NAME, MANIFEST_NAME, ACCOUNT_MANIFEST_NAME, MAX_ASSET_BYTES, REQUIRED_FILES });
