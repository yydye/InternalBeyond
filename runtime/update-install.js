'use strict';

/*
 * Internal Beyond · update install runtime (U3)
 *
 * The second half of the zero-touch update: turning a verified manifest into an
 * installed newer version. Per U-D5 this is a SHORT-LIVED helper:
 *
 *     download → size + sha256 + PE version verification → spawn the installer
 *     detached → EXIT
 *
 * Nothing here stops InternalBeyond and nothing here relaunches it. The
 * installer owns both (`ib-stop.js --root {app}` in PrepareToInstall, then
 * `/IBRELAUNCH=1` → `wscript 启动 InternalBeyond.vbs`), because only the
 * installer can know when the files are actually replaceable. The helper MUST be
 * gone before the installer starts replacing runtime\node\node.exe: it runs on
 * the bundled Node, and a live helper would turn the upgrade into
 * "DeleteFile failed; code 5".
 *
 * ── Where the truth comes from ─────────────────────────────────────────────
 *   The helper never accepts a URL, a hash or a path from anyone. It re-reads
 *   the SAME verified manifest the check runtime cached
 *   (%LOCALAPPDATA%\InternalBeyond\update-check.json), re-validates it through
 *   the SAME validator, and refuses if the version it was asked to install is not
 *   the version that manifest announces (U-D6 item 7).
 *
 * ── Two payload routes, one gate (U-D6) ────────────────────────────────────
 *   primary  manifest.installer.url  (the frozen github.com release asset)
 *   fallback the GitHub Releases API asset, reached ONLY when the primary
 *            produced no complete HTTP response entity — decided by the same
 *            shared predicate as U2: fallbackAllowed(result) ===
 *            (result.outcome === 'network'). Once a response HAS been received,
 *            every subsequent problem (HTTP status, wrong asset, wrong tag,
 *            bad Content-Length, size mismatch, sha256 mismatch, PE version
 *            mismatch, digest mismatch) is final and is NOT retried elsewhere.
 *
 *   The fallback is a transport substitution, never a second release source: the
 *   bytes it fetches must still match the sha256 the manifest published, which is
 *   recomputed locally from the file on disk.
 *
 * ── Never write into {app} ─────────────────────────────────────────────────
 *   The payload goes to %LOCALAPPDATA%\InternalBeyond\updates, which is outside
 *   the application directory by construction AND by an explicit guard: an
 *   IB_UPDATE_DIR that points into {app} is refused rather than obeyed
 *   (U-series invariant: 更新载荷绝不下载进 {app}).
 *
 * Zero dependencies beyond node stdlib + the shared update runtime modules.
 * Every side effect (transport, spawn, clock, directories) is injectable, so the
 * tests never touch the network and never install anything.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const transport = require('./update-transport.js');
const updateManifest = require('./update-manifest.js');
const updateCheck = require('./update-check.js');
const peVersion = require('./pe-version.js');

/* ── Frozen constants ─────────────────────────────────────────────────────── */

/* U-D3. The installer is not allowed to show a second wizard and is not allowed
   to decide about restarting the machine. /IBRELAUNCH=1 is the installer-side
   opt-in that relaunches InternalBeyond once the files are in place. */
const INSTALL_ARGS = ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/SP-', '/IBRELAUNCH=1'];

/* A 48 MB payload on a slow line is minutes, not seconds: the deadline is the
   whole exchange, and the stall deadline is what actually protects us from a
   peer that stops sending. */
const PAYLOAD_TIMEOUT_MS = 20 * 60 * 1000;
const PAYLOAD_STALL_MS = 90 * 1000;

/* Progress is reported to the state file at most this often, so a 48 MB download
   does not turn into thousands of disk writes. */
const PROGRESS_INTERVAL_MS = 750;

/* A run whose state has not moved for this long is treated as dead, so a crashed
   helper can never block the next attempt forever. */
const ACTIVE_GRACE_MS = 30 * 60 * 1000;

const STATE_SCHEMA = 'internalbeyond.update-install';
const STATE_SCHEMA_VERSION = 1;

/* Run states. 'downloading' → 'verifying' → 'launching' → 'launched'.
   Anything terminal means no helper is expected to be alive. */
const STATE_DOWNLOADING = 'downloading';
const STATE_VERIFYING = 'verifying';
const STATE_LAUNCHING = 'launching';
const STATE_LAUNCHED = 'launched';
const STATE_FAILED = 'failed';
const TERMINAL_STATES = [STATE_LAUNCHED, STATE_FAILED];

const HELPER_SCRIPT = path.join(__dirname, 'update-install.js');

/* The installed application root (== the served web root == {app}). Only used
   for the "never write the payload into {app}" guard. */
const APP_ROOT = path.resolve(__dirname, '..');

/* ── Paths ────────────────────────────────────────────────────────────────── */

function updatesDir(options) {
  const o = options || {};
  if (o.dir) return path.resolve(String(o.dir));
  /* Same directory family as the check cache and boot-state.json: outside
     {app}, survives an upgrade, per-user. */
  return path.join(updateCheck.updateDir(), 'updates');
}

function installerFileName(version) {
  return updateManifest.installerAssetName(version);
}

function partFileName(version) {
  return installerFileName(version) + '.part';
}

function stateFile(options) {
  const o = options || {};
  if (o.stateFile) return path.resolve(String(o.stateFile));
  return path.join(updatesDir(o), 'update-install-state.json');
}

/* Is `dir` inside the application directory? Compared after resolution and
   case-folded, because Windows paths are case-insensitive. */
function isInsideApp(dir) {
  const target = path.resolve(String(dir || '')).toLowerCase().replace(/[\\/]+$/, '');
  const root = APP_ROOT.toLowerCase();
  return target === root || target.indexOf(root + path.sep) === 0;
}

/* ── State file ───────────────────────────────────────────────────────────── */

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isoUtc(ms) {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function emptyState(why) {
  return {
    ok: true, present: false, state: 'idle', active: false, why: why || null,
    version: '', transport: '', bytes: 0, totalBytes: 0,
    startedAt: '', updatedAt: '', finishedAt: '', error: null, pid: null, path: null
  };
}

/*
 * Read the install state. Never throws; a corrupt or half-written file is
 * reported as absent, never as an answer. `active` is the only field the server
 * uses to decide whether a second install may start.
 */
function readState(options) {
  const o = options || {};
  const file = stateFile(o);
  let raw = '';
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { return emptyState('no state file'); }
  let parsed = null;
  try { parsed = JSON.parse(String(raw).replace(/^\uFEFF/, '')); } catch (e) { return emptyState('state file is not valid JSON'); }
  if (!isPlainObject(parsed) || parsed.schema !== STATE_SCHEMA || parsed.schemaVersion !== STATE_SCHEMA_VERSION) {
    return emptyState('state file has an unknown shape');
  }
  const state = String(parsed.state || '');
  const known = [STATE_DOWNLOADING, STATE_VERIFYING, STATE_LAUNCHING, STATE_LAUNCHED, STATE_FAILED];
  if (known.indexOf(state) < 0) return emptyState('state file has an unknown state');
  const updatedAt = Date.parse(String(parsed.updatedAt || ''));
  const pid = Number.isInteger(parsed.pid) && parsed.pid > 0 ? parsed.pid : null;
  const stale = !Number.isNaN(updatedAt) && (Date.now() - updatedAt) > ACTIVE_GRACE_MS;
  const active = TERMINAL_STATES.indexOf(state) < 0 && !stale && pidAlive(pid);
  return {
    ok: true,
    present: true,
    state: state,
    active: active,
    why: null,
    version: String(parsed.version || ''),
    transport: String(parsed.transport || ''),
    bytes: Number.isFinite(parsed.bytes) ? parsed.bytes : 0,
    totalBytes: Number.isFinite(parsed.totalBytes) ? parsed.totalBytes : 0,
    startedAt: String(parsed.startedAt || ''),
    updatedAt: String(parsed.updatedAt || ''),
    finishedAt: String(parsed.finishedAt || ''),
    error: isPlainObject(parsed.error) ? { kind: String(parsed.error.kind || ''), message: String(parsed.error.message || '') } : null,
    pid: pid,
    path: file
  };
}

/* Is a PID still alive? Signal 0 only asks the OS whether the process exists. */
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    /* EPERM means "exists, but not ours to signal" — that still counts. */
    return !!(e && e.code === 'EPERM');
  }
}

function writeState(patch, options) {
  const o = options || {};
  const now = Number.isFinite(o.now) ? o.now : Date.now();
  const previous = readState(o);
  const next = {
    schema: STATE_SCHEMA,
    schemaVersion: STATE_SCHEMA_VERSION,
    state: patch.state || previous.state || 'idle',
    version: patch.version !== undefined ? patch.version : previous.version,
    transport: patch.transport !== undefined ? patch.transport : previous.transport,
    bytes: patch.bytes !== undefined ? patch.bytes : previous.bytes,
    totalBytes: patch.totalBytes !== undefined ? patch.totalBytes : previous.totalBytes,
    startedAt: patch.startedAt !== undefined ? patch.startedAt : (previous.startedAt || isoUtc(now)),
    updatedAt: isoUtc(now),
    finishedAt: patch.finishedAt !== undefined ? patch.finishedAt : (TERMINAL_STATES.indexOf(patch.state || '') >= 0 ? isoUtc(now) : ''),
    error: patch.error !== undefined ? patch.error : null,
    pid: patch.pid !== undefined ? patch.pid : previous.pid
  };
  const file = stateFile(o);
  /* A state file we cannot write is never fatal: it only means the UI has less
     to show. The install itself continues. */
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, file);
    return { ok: true, state: next, file: file };
  } catch (e) {
    return { ok: false, why: 'could not write the install state: ' + String((e && e.message) || e), state: next, file: file };
  }
}

/* The projection the server hands to the UI (U4 renders this, nothing more). */
function summarizeState(read) {
  const r = read || emptyState();
  return {
    ok: true,
    state: r.state || 'idle',
    active: !!r.active,
    version: r.version || '',
    transport: r.transport || '',
    bytes: r.bytes || 0,
    totalBytes: r.totalBytes || 0,
    startedAt: r.startedAt || '',
    updatedAt: r.updatedAt || '',
    finishedAt: r.finishedAt || '',
    error: r.error ? { kind: r.error.kind, message: r.error.message } : null
  };
}

/* ── Payload sinks ────────────────────────────────────────────────────────── */

/*
 * The U3 sink: stream the payload to disk while hashing it.
 *
 * Content-Length is a SECURITY INPUT here, not a hint (U-D6 item 5): a response
 * that does not declare exactly the byte count the manifest published is refused
 * before a single body byte is written, and a transfer that ends at any other
 * size is refused too. Nothing is decompressed — a payload that arrives
 * Content-Encoding'd is a transport anomaly we do not paper over.
 *
 * Returns { kind:'file', maxBytes:null, ... }.
 */
function fileSink(options) {
  const o = options || {};
  const partFile = String(o.partFile || '');
  const expectedBytes = Number(o.expectedBytes);
  const expectedSha256 = String(o.expectedSha256 || '').toLowerCase();
  const onProgress = typeof o.onProgress === 'function' ? o.onProgress : null;
  const now = typeof o.now === 'function' ? o.now : Date.now;

  let fd = null;
  let bytes = 0;
  let lastReport = 0;
  let declared = null;
  const hash = crypto.createHash('sha256');

  const closeFd = function () {
    if (fd === null) return;
    try { fs.closeSync(fd); } catch (e) { }
    fd = null;
  };
  const removePart = function () {
    try { fs.rmSync(partFile, { force: true }); } catch (e) { }
  };

  return {
    kind: 'file',
    /* Unbounded on purpose: the cap is Content-Length + the manifest size, and
       an arbitrary byte ceiling would only turn a slow huge file into a
       mysterious failure. */
    maxBytes: null,
    partFile: partFile,

    onResponse: function (status, headers) {
      const raw = headers ? headers['content-length'] : undefined;
      if (raw === undefined || raw === null || String(raw).trim() === '') {
        return {
          kind: 'content-length-invalid',
          message: 'the response declares no Content-Length; refusing to install from an unmeasurable transfer'
        };
      }
      const declaredBytes = Number(String(raw).trim());
      if (!Number.isInteger(declaredBytes) || declaredBytes < 0) {
        return { kind: 'content-length-invalid', message: 'Content-Length is not a byte count: ' + JSON.stringify(raw) };
      }
      if (!Number.isInteger(expectedBytes) || expectedBytes <= 0) {
        return { kind: 'content-length-invalid', message: 'the manifest declares no usable installer size' };
      }
      if (declaredBytes !== expectedBytes) {
        return {
          kind: 'size-mismatch',
          message: 'Content-Length ' + declaredBytes + ' does not match the manifest size ' + expectedBytes
        };
      }
      declared = declaredBytes;
      try {
        fs.mkdirSync(path.dirname(partFile), { recursive: true });
        removePart();
        fd = fs.openSync(partFile, 'w');
      } catch (e) {
        return { kind: 'write-failed', message: 'could not open ' + partFile + ': ' + String((e && e.message) || e) };
      }
      return null;
    },

    onData: function (chunk) {
      if (fd === null) return { kind: 'write-failed', message: 'the payload file is not open' };
      try {
        fs.writeSync(fd, chunk);
      } catch (e) {
        return { kind: 'write-failed', message: 'could not write ' + partFile + ': ' + String((e && e.message) || e) };
      }
      hash.update(chunk);
      bytes += chunk.length;
      if (declared !== null && bytes > declared) {
        return { kind: 'size-mismatch', message: 'the transfer exceeded its declared Content-Length' };
      }
      if (onProgress) {
        const at = now();
        if (bytes === declared || at - lastReport >= PROGRESS_INTERVAL_MS) {
          lastReport = at;
          try { onProgress(bytes, declared); } catch (e) { }
        }
      }
      return null;
    },

    onEnd: function () {
      closeFd();
      if (bytes === 0) return { kind: 'size-mismatch', message: 'the response body was empty' };
      const digest = hash.digest('hex');
      return { value: { file: partFile, bytes: bytes, sha256: digest, expectedSha256: expectedSha256 } };
    },

    onAbort: function () {
      closeFd();
      /* A refused or interrupted transfer leaves nothing behind — including a
         mismatching file, which U-D6 item 8 requires us to delete. */
      removePart();
    }
  };
}

/* ── Downloading one payload ──────────────────────────────────────────────── */

/* A result shaped exactly like the shared transport's, so the ONE fallback
   predicate applies to it unchanged. */
function payloadResult(outcome, kind, message, extra) {
  return Object.assign({
    outcome: outcome,
    kind: kind || null,
    message: message || null,
    status: null,
    headers: null,
    body: null,
    finalUrl: null,
    hops: []
  }, extra || {});
}

/*
 * Stream one payload URL to `partFile`, then judge the bytes:
 *   actual size == Content-Length == manifest.installer.sizeBytes
 *   locally recomputed sha256 == manifest.installer.sha256
 *
 * Both verdicts are PROTOCOL verdicts: a response arrived and we judged it, so
 * the other route must not get a second opinion.
 */
function downloadOnce(url, ctx) {
  const sink = fileSink({
    partFile: ctx.partFile,
    expectedBytes: ctx.expectedBytes,
    expectedSha256: ctx.expectedSha256,
    onProgress: ctx.onProgress,
    now: ctx.now
  });
  return ctx.fetch(url, {
    accept: 'application/octet-stream',
    timeoutMs: ctx.timeoutMs,
    stallTimeoutMs: ctx.stallMs,
    sink: sink
  }).catch(function (err) {
    /* An injected transport may reject; that is still "no complete response". */
    return transport.networkFailure(err, [
      { url: url, outcome: transport.OUTCOME_NETWORK, status: null, kind: transport.classifyNetworkError(err) }
    ]);
  }).then(function (result) {
    if (!result || result.outcome !== transport.OUTCOME_RESPONSE) return result;
    const facts = result.body || {};
    /* From here on the bytes are on disk, so every refusal must ALSO delete them
       (U-D6 item 8). A file whose hash or size we just rejected must never be
       left behind for anything — or anyone — to install later. */
    const discard = function () {
      try { fs.rmSync(facts.file, { force: true }); } catch (e) { }
    };
    if (facts.bytes !== ctx.expectedBytes) {
      discard();
      return payloadResult(transport.OUTCOME_PROTOCOL, 'size-mismatch',
        'downloaded ' + facts.bytes + ' bytes, the manifest declares ' + ctx.expectedBytes,
        { status: result.status, finalUrl: result.finalUrl, hops: result.hops });
    }
    if (String(facts.sha256).toLowerCase() !== ctx.expectedSha256) {
      discard();
      return payloadResult(transport.OUTCOME_PROTOCOL, 'sha256-mismatch',
        'the downloaded payload does not match the manifest sha256',
        { status: result.status, finalUrl: result.finalUrl, hops: result.hops, body: { bytes: facts.bytes } });
    }
    return payloadResult(transport.OUTCOME_RESPONSE, null, null, {
      status: result.status,
      finalUrl: result.finalUrl,
      hops: result.hops,
      body: { file: facts.file, bytes: facts.bytes, sha256: facts.sha256 }
    });
  });
}

/*
 * Download + verify the installer for a validated manifest.
 *
 * options:
 *   manifest        the verified manifest (required)
 *   dir             payload directory (default: %LOCALAPPDATA%\InternalBeyond\updates)
 *   transport       injectable fetchText-like function (tests never hit the net)
 *   timeoutMs/stallMs   payload deadlines
 *   onProgress      (bytes, total) → void
 *   onTransport     (name) → void   which route is being used
 *
 * Returns { ok, why, kind, transport, file, bytes, sha256, attempts }.
 */
function downloadInstaller(options) {
  const o = options || {};
  const attempts = [];
  const fail = function (kind, why, transportName, extra) {
    return Object.assign({
      ok: false, why: why, kind: kind, transport: transportName || null,
      file: null, bytes: 0, sha256: '', attempts: attempts
    }, extra || {});
  };

  const manifest = o.manifest;
  const installer = manifest && manifest.installer ? manifest.installer : null;
  if (!installer) return Promise.resolve(fail('invalid-manifest', 'the manifest carries no installer block'));
  const version = String(manifest.version || '');
  const expectedBytes = installer.sizeBytes;
  const expectedSha256 = updateManifest.normalizeSha256(installer.sha256);

  /* Defense in depth: the URL is re-parsed with the contract's own parser, so a
     manifest that reached us from anywhere else cannot smuggle a different host,
     tag or asset name into a download. */
  const parsedUrl = updateManifest.parseInstallerUrl(installer.url);
  if (!parsedUrl.ok) return Promise.resolve(fail('invalid-installer-url', parsedUrl.why));
  if (parsedUrl.version !== version) {
    return Promise.resolve(fail('identity-mismatch',
      'installer.url version ' + parsedUrl.version + ' does not match manifest version ' + version));
  }

  const dir = updatesDir(o);
  /* U-series invariant, enforced rather than assumed. */
  if (isInsideApp(dir)) {
    return Promise.resolve(fail('payload-dir-inside-app',
      'refusing to download the update payload into the application directory: ' + dir));
  }

  const partFile = path.join(dir, partFileName(version));
  const finalFile = path.join(dir, installerFileName(version));
  const ctx = {
    partFile: partFile,
    expectedBytes: expectedBytes,
    expectedSha256: expectedSha256,
    fetch: typeof o.transport === 'function' ? o.transport : transport.fetchTo,
    timeoutMs: Number.isInteger(o.timeoutMs) ? o.timeoutMs : PAYLOAD_TIMEOUT_MS,
    stallMs: Number.isInteger(o.stallMs) ? o.stallMs : PAYLOAD_STALL_MS,
    onProgress: o.onProgress,
    now: o.now
  };

  const noteTransport = function (name) {
    if (typeof o.onTransport === 'function') { try { o.onTransport(name); } catch (e) { } }
  };

  noteTransport(transport.TRANSPORT_DIRECT);
  attempts.push({ transport: transport.TRANSPORT_DIRECT, url: installer.url, outcome: 'start', kind: null, status: null, message: null });

  return downloadOnce(installer.url, ctx).then(function (primary) {
    attempts.push({
      transport: transport.TRANSPORT_DIRECT, url: installer.url, outcome: primary.outcome,
      kind: primary.kind, status: primary.status, message: primary.message
    });
    if (primary.outcome === transport.OUTCOME_RESPONSE) {
      return finishDownload(primary, transport.TRANSPORT_DIRECT);
    }
    if (!transport.fallbackAllowed(primary)) {
      /* A response we refused to accept: final, and never retried elsewhere. */
      return fail(primary.kind, primary.message, transport.TRANSPORT_DIRECT);
    }

    /* ── U-D6 fallback: the API asset, only for "no complete response" ────── */
    noteTransport(transport.TRANSPORT_API);
    const apiReleaseUrl = String(o.apiReleaseUrl || updateManifest.API_LATEST_RELEASE);
    attempts.push({ transport: transport.TRANSPORT_API, url: apiReleaseUrl, outcome: 'start', kind: null, status: null, message: null });
    return ctx.fetch(apiReleaseUrl, { accept: 'application/vnd.github+json', timeoutMs: 15000 })
      .catch(function (err) {
        return transport.networkFailure(err, [
          { url: apiReleaseUrl, outcome: transport.OUTCOME_NETWORK, status: null, kind: transport.classifyNetworkError(err) }
        ]);
      })
      .then(function (release) {
        attempts.push({
          transport: transport.TRANSPORT_API, url: apiReleaseUrl, outcome: release.outcome,
          kind: release.kind, status: release.status, message: release.message
        });
        if (release.outcome !== transport.OUTCOME_RESPONSE) {
          return fail(release.kind, release.message, transport.TRANSPORT_API);
        }
        let payload = null;
        try { payload = JSON.parse(release.body); } catch (e) { payload = null; }
        const picked = updateManifest.selectInstallerAsset(payload, version, expectedSha256);
        if (!picked.ok) {
          /* wrong release / wrong tag / wrong asset / digest mismatch: all hard
             failures, none of them retried. */
          return fail('api-release-unusable', picked.why, transport.TRANSPORT_API);
        }
        const assetUrl = updateManifest.assetApiUrl(picked.assetId);
        attempts.push({ transport: transport.TRANSPORT_API, url: assetUrl, outcome: 'start', kind: null, status: null, message: null });
        return downloadOnce(assetUrl, ctx).then(function (second) {
          attempts.push({
            transport: transport.TRANSPORT_API, url: assetUrl, outcome: second.outcome,
            kind: second.kind, status: second.status, message: second.message
          });
          if (second.outcome !== transport.OUTCOME_RESPONSE) {
            /* One detour only: no second fallback, no retry. */
            return fail(second.kind, second.message, transport.TRANSPORT_API);
          }
          return finishDownload(second, transport.TRANSPORT_API);
        });
      });
  });

  /* ── the bytes are on disk: PE identity, then the atomic rename ────────── */
  function finishDownload(result, transportName) {
    const facts = result.body || {};
    /* U-D6 item 5: PE ProductVersion/FileVersion mismatch is a hard failure.
       Checked on the .part file, BEFORE it is allowed to take its final name. */
    const match = peVersion.matchesProductVersion(facts.file, installer.productVersion);
    if (!match.ok) {
      try { fs.rmSync(facts.file, { force: true }); } catch (e) { }
      return fail('pe-version-mismatch', match.why, transportName);
    }
    try {
      fs.renameSync(facts.file, finalFile);
    } catch (e) {
      try { fs.rmSync(facts.file, { force: true }); } catch (e2) { }
      return fail('write-failed',
        'could not move the verified payload into place: ' + String((e && e.message) || e), transportName);
    }
    return {
      ok: true,
      why: null,
      kind: null,
      transport: transportName,
      file: finalFile,
      bytes: facts.bytes,
      sha256: facts.sha256,
      peProductVersion: match.read.productVersion,
      attempts: attempts
    };
  }
}

/* ── Spawning the installer ───────────────────────────────────────────────── */

/*
 * Launch the verified installer, detached, with `shell:false` (U-series
 * invariant: no shell, so no argument can be reinterpreted) and the frozen U-D3
 * argument list. The child is unref'd so this process can exit immediately —
 * which is the whole point of U-D5.
 */
function spawnInstaller(exePath, options) {
  const o = options || {};
  const file = String(exePath || '');
  if (!file || !fs.existsSync(file)) {
    return { ok: false, why: 'the verified installer is not on disk: ' + file, pid: null };
  }
  const spawnImpl = typeof o.spawn === 'function' ? o.spawn : spawn;
  try {
    /* INSTALL_ARGS is frozen by U-D3 and is not an option: the only thing that
       may vary between callers is nothing at all. */
    const child = spawnImpl(file, INSTALL_ARGS, {
      detached: true,
      windowsHide: true,
      stdio: 'ignore',
      shell: false,
      cwd: path.dirname(file)
    });
    if (!child || !Number.isInteger(child.pid) || child.pid <= 0) {
      return { ok: false, why: 'the installer process could not be started', pid: null };
    }
    if (typeof child.unref === 'function') child.unref();
    return { ok: true, why: null, pid: child.pid, args: INSTALL_ARGS.slice() };
  } catch (e) {
    return { ok: false, why: 'could not start the installer: ' + String((e && e.message) || e), pid: null };
  }
}

/* ── One run at a time: an atomic lock file ───────────────────────────────── */

/*
 * The state file alone cannot serialise two starts: a second helper can be
 * spawned in the window before the first one has written anything, and two
 * helpers streaming into the same .part file would produce a file that fails its
 * own hash for no good reason. Worse, two spawned installers would race while
 * replacing the same files.
 *
 * So the lock is its own file, taken with O_EXCL (atomic on Windows and POSIX).
 * It is deliberately left behind after a successful spawn, re-owned by the
 * INSTALLER's pid: what must never overlap is not the download but the install,
 * and the installer is the process that does it. A lock whose owner is gone (or
 * whose state has not moved for ACTIVE_GRACE_MS) is taken over, so a crash can
 * never wedge the feature permanently.
 */
function lockFile(options) {
  const o = options || {};
  if (o.lockFile) return path.resolve(String(o.lockFile));
  return path.join(updatesDir(o), 'update-install.lock');
}

function readLock(options) {
  const file = lockFile(options);
  let parsed = null;
  try { parsed = JSON.parse(String(fs.readFileSync(file, 'utf8')).replace(/^\uFEFF/, '')); } catch (e) { return null; }
  if (!isPlainObject(parsed)) return null;
  const at = Date.parse(String(parsed.at || ''));
  return {
    pid: Number.isInteger(parsed.pid) && parsed.pid > 0 ? parsed.pid : null,
    at: Number.isNaN(at) ? null : at,
    role: String(parsed.role || 'helper'),
    stale: Number.isNaN(at) ? true : (Date.now() - at) > ACTIVE_GRACE_MS
  };
}

/*
 * Take the lock. Returns { ok, why, file, tookOver }.
 *
 * `why` is 'busy' when a live run holds it — that is a refusal the caller must
 * report WITHOUT touching the state file, because the state file belongs to the
 * run that is still going.
 */
function acquireLock(options) {
  const o = options || {};
  const file = lockFile(o);
  const now = Number.isFinite(o.now) ? o.now : Date.now();
  const payload = JSON.stringify({ pid: o.pid === undefined ? process.pid : o.pid, at: isoUtc(now), role: o.role || 'helper' }) + '\n';
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); } catch (e) {
    return { ok: false, why: 'could not create the payload directory: ' + String((e && e.message) || e), file: file, tookOver: false };
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(file, 'wx');
      fs.writeSync(fd, payload);
      fs.closeSync(fd);
      return { ok: true, why: null, file: file, tookOver: attempt > 0 };
    } catch (e) {
      if (!e || e.code !== 'EEXIST') {
        return { ok: false, why: 'could not take the update lock: ' + String((e && e.message) || e), file: file, tookOver: false };
      }
      const held = readLock(o);
      const live = !!held && held.pid !== null && !held.stale && pidAlive(held.pid);
      if (live) {
        return { ok: false, why: 'busy', file: file, tookOver: false, holder: held };
      }
      /* Nobody provably owns it: drop it and try once more. */
      try { fs.rmSync(file, { force: true }); } catch (e2) { }
    }
  }
  return { ok: false, why: 'could not take the update lock', file: file, tookOver: false };
}

/* Hand the lock to the process that now owns the install. */
function handLockTo(pid, options) {
  const o = options || {};
  const file = lockFile(o);
  try {
    fs.writeFileSync(file, JSON.stringify({
      pid: Number(pid), at: isoUtc(Number.isFinite(o.now) ? o.now : Date.now()), role: 'installer'
    }) + '\n', 'utf8');
    return { ok: true, file: file };
  } catch (e) {
    return { ok: false, why: 'could not hand the update lock to the installer: ' + String((e && e.message) || e), file: file };
  }
}

function releaseLock(options) {
  try { fs.rmSync(lockFile(options), { force: true }); return { ok: true }; }
  catch (e) { return { ok: false, why: String((e && e.message) || e) }; }
}

/*
 * Is an install in flight? True while the helper is downloading/verifying or
 * while the installer it started is still running.
 */
function isBusy(options) {
  const held = readLock(options);
  if (held && held.pid !== null && !held.stale && pidAlive(held.pid)) return true;
  const state = readState(options);
  return !!state.active;
}

/* ── Housekeeping ─────────────────────────────────────────────────────────── */

/*
 * Best-effort removal of payloads from previous versions and of abandoned
 * .part files. Never touches the version we are about to use, and never fails
 * the install: a 48 MB file we cannot delete is a disk-space nuisance, not a
 * correctness problem.
 */
function cleanupStale(options) {
  const o = options || {};
  const dir = updatesDir(o);
  const keep = installerFileName(String(o.keepVersion || ''));
  const removed = [];
  let names = [];
  try { names = fs.readdirSync(dir); } catch (e) { return { ok: true, removed: removed, why: 'no payload directory yet' }; }
  for (const name of names) {
    const ours = name.indexOf(updateManifest.ASSET_PREFIX) === 0;
    const isPayload = ours && /\.exe$/.test(name);
    const isPart = ours && /\.exe\.part$/.test(name);
    if (!isPayload && !isPart) continue;
    if (name === keep) continue;
    try {
      fs.rmSync(path.join(dir, name), { force: true });
      removed.push(name);
    } catch (e) {
      /* Locked by a running installer, or simply not ours to delete. */
    }
  }
  return { ok: true, removed: removed, why: null };
}

/* ── The manifest this install is allowed to use ──────────────────────────── */

/*
 * Resolve the manifest to install from the SAME verified cache the check runtime
 * writes. No network, no caller-supplied manifest, no second store: if the cache
 * is missing, expired or no longer validates, there is nothing to install and we
 * say so.
 */
function resolveManifest(options) {
  const o = options || {};
  const now = Number.isFinite(o.now) ? o.now : Date.now();
  const cached = updateCheck.readCache({ cacheFile: o.cacheFile, now: now });
  if (!cached.hit) {
    return { ok: false, kind: 'no-verified-manifest', why: 'no verified update information is cached (' + cached.why + ')' };
  }
  return { ok: true, kind: null, why: null, manifest: cached.manifest, fromCache: true, checkedAt: cached.at, route: cached.transport };
}

/* ── The whole helper flow ────────────────────────────────────────────────── */

/*
 * startInstall(): download → verify → spawn → finish.
 *
 * One run at a time: an in-flight run (state not terminal AND its pid alive AND
 * the state file still moving) blocks a second one. A dead run never does.
 */
function startInstall(options) {
  const o = options || {};
  const now = Number.isFinite(o.now) ? o.now : Date.now();
  const stateOpts = { dir: o.dir, stateFile: o.stateFile, lockFile: o.lockFile };

  const fail = function (kind, why, summary, keepState) {
    if (keepState !== false) {
      writeState({
        state: STATE_FAILED, error: { kind: kind, message: why },
        finishedAt: isoUtc(now)
      }, Object.assign({ now: now }, stateOpts));
    }
    releaseLock(stateOpts);
    return Object.assign({
      ok: false, kind: kind, why: why, state: STATE_FAILED,
      file: null, pid: null, version: '', transport: '', bytes: 0, attempts: []
    }, summary || {});
  };

  /* Take the lock FIRST: two helpers must never stream into the same .part file,
     and the refusal must not overwrite the state of the run that is still going
     (which is why this failure keeps its hands off the state file). */
  const lock = acquireLock(stateOpts);
  if (!lock.ok) {
    const busy = lock.why === 'busy';
    return Promise.resolve(fail(busy ? 'already-in-progress' : 'lock-failed',
      busy ? 'another update is already running' : lock.why, null, /* keepState */ false));
  }

  if (readState(stateOpts).active) {
    return Promise.resolve(fail('already-in-progress', 'another update download is already running'));
  }

  const resolved = resolveManifest(o);
  if (!resolved.ok) return Promise.resolve(fail(resolved.kind, resolved.why));

  const manifest = resolved.manifest;
  const version = String(manifest.version || '');
  const wanted = String(o.version == null ? '' : o.version).trim();
  if (wanted && wanted !== version) {
    /* The caller asked us to install a version the verified manifest does not
       announce. Refuse; never install "something else". */
    return Promise.resolve(fail('version-mismatch',
      'asked to install ' + JSON.stringify(wanted) + ' but the verified manifest announces ' + JSON.stringify(version)));
  }

  const payloadDir = updatesDir(o);
  if (isInsideApp(payloadDir)) {
    return Promise.resolve(fail('payload-dir-inside-app',
      'refusing to download the update payload into the application directory: ' + payloadDir));
  }

  writeState({
    state: STATE_DOWNLOADING, version: version, transport: '', bytes: 0,
    totalBytes: manifest.installer.sizeBytes, error: null, pid: process.pid,
    startedAt: isoUtc(now), finishedAt: ''
  }, Object.assign({ now: now }, stateOpts));

  cleanupStale({ dir: payloadDir, keepVersion: version });

  return downloadInstaller({
    manifest: manifest,
    dir: payloadDir,
    transport: o.transport,
    apiReleaseUrl: o.apiReleaseUrl,
    timeoutMs: o.timeoutMs,
    stallMs: o.stallMs,
    now: o.now,
    onTransport: function (name) {
      writeState({ state: STATE_DOWNLOADING, transport: name, version: version }, Object.assign({ now: Date.now() }, stateOpts));
    },
    onProgress: function (bytes, total) {
      writeState({ bytes: bytes, totalBytes: total, state: STATE_DOWNLOADING, version: version }, Object.assign({ now: Date.now() }, stateOpts));
    }
  }).then(function (download) {
    if (!download.ok) {
      return fail(download.kind, download.why, {
        version: version, transport: download.transport, attempts: download.attempts
      });
    }
    writeState({
      state: STATE_LAUNCHING, version: version, transport: download.transport,
      bytes: download.bytes, totalBytes: download.bytes
    }, Object.assign({ now: Date.now() }, stateOpts));

    const started = spawnInstaller(download.file, { spawn: o.spawn });
    if (!started.ok) {
      return fail('spawn-failed', started.why, {
        version: version, transport: download.transport, file: download.file,
        bytes: download.bytes, attempts: download.attempts
      });
    }

    /* The installer is on its own from here: this process must exit so the
       bundled node.exe can be replaced (U-D5). The lock is handed to the
       installer rather than released: what must not overlap is the install. */
    handLockTo(started.pid, Object.assign({ now: Date.now() }, stateOpts));
    writeState({
      state: STATE_LAUNCHED, version: version, transport: download.transport,
      bytes: download.bytes, totalBytes: download.bytes, error: null,
      finishedAt: isoUtc(Date.now())
    }, Object.assign({ now: Date.now() }, stateOpts));

    return {
      ok: true, kind: null, why: null, state: STATE_LAUNCHED,
      version: version, transport: download.transport, file: download.file,
      bytes: download.bytes, sha256: download.sha256, pid: started.pid,
      attempts: download.attempts
    };
  }).catch(function (err) {
    /* downloadInstaller is not supposed to throw; a caller must never have to
       defend itself against this module. */
    return fail('internal-error', String((err && err.message) || err));
  });
}

/* ── Starting the helper from the server ──────────────────────────────────── */

/*
 * Spawn the short-lived helper process. Detached and unref'd so it survives the
 * static server being stopped by the installer — and so `taskkill /T` on the
 * server cannot take the download with it.
 *
 * U-D6 item 7: the ONLY thing that crosses this boundary is the version the user
 * confirmed. No URL, no hash, no path — the helper resolves all of that from the
 * verified cache itself.
 */
function spawnHelper(options) {
  const o = options || {};
  const version = String(o.version == null ? '' : o.version).trim();
  if (!version) return { ok: false, why: 'a version confirmation is required to start an update', pid: null };
  const spawnImpl = typeof o.spawn === 'function' ? o.spawn : spawn;
  const execPath = String(o.execPath || process.execPath);
  try {
    const child = spawnImpl(execPath, [HELPER_SCRIPT, '--version', version], {
      detached: true,
      windowsHide: true,
      stdio: 'ignore',
      shell: false,
      windowsVerbatimArguments: false
    });
    if (!child || !Number.isInteger(child.pid) || child.pid <= 0) {
      return { ok: false, why: 'the update helper could not be started', pid: null };
    }
    if (typeof child.unref === 'function') child.unref();
    return { ok: true, why: null, pid: child.pid, version: version };
  } catch (e) {
    return { ok: false, why: 'could not start the update helper: ' + String((e && e.message) || e), pid: null };
  }
}

module.exports = {
  INSTALL_ARGS: INSTALL_ARGS,
  PAYLOAD_TIMEOUT_MS: PAYLOAD_TIMEOUT_MS,
  PAYLOAD_STALL_MS: PAYLOAD_STALL_MS,
  ACTIVE_GRACE_MS: ACTIVE_GRACE_MS,
  STATE_SCHEMA: STATE_SCHEMA,
  STATE_SCHEMA_VERSION: STATE_SCHEMA_VERSION,
  STATE_DOWNLOADING: STATE_DOWNLOADING,
  STATE_VERIFYING: STATE_VERIFYING,
  STATE_LAUNCHING: STATE_LAUNCHING,
  STATE_LAUNCHED: STATE_LAUNCHED,
  STATE_FAILED: STATE_FAILED,
  TERMINAL_STATES: TERMINAL_STATES,
  HELPER_SCRIPT: HELPER_SCRIPT,
  APP_ROOT: APP_ROOT,
  updatesDir: updatesDir,
  installerFileName: installerFileName,
  partFileName: partFileName,
  stateFile: stateFile,
  isInsideApp: isInsideApp,
  pidAlive: pidAlive,
  lockFile: lockFile,
  readLock: readLock,
  acquireLock: acquireLock,
  handLockTo: handLockTo,
  releaseLock: releaseLock,
  isBusy: isBusy,
  readState: readState,
  writeState: writeState,
  summarizeState: summarizeState,
  fileSink: fileSink,
  downloadOnce: downloadOnce,
  downloadInstaller: downloadInstaller,
  spawnInstaller: spawnInstaller,
  cleanupStale: cleanupStale,
  resolveManifest: resolveManifest,
  startInstall: startInstall,
  spawnHelper: spawnHelper
};

/* ── CLI: the helper process itself ───────────────────────────────────────── */

function parseArgs(argv) {
  const out = { version: '' };
  for (let i = 0; i < argv.length; i++) {
    const a = String(argv[i]);
    if (a === '--version') { out.version = String(argv[++i] || ''); continue; }
  }
  return out;
}

if (require.main === module) {
  const opts = parseArgs(process.argv.slice(2));
  startInstall({ version: opts.version }).then(function (result) {
    process.stdout.write('[ib-update] ' + JSON.stringify({
      ok: result.ok, state: result.state, version: result.version,
      transport: result.transport, bytes: result.bytes, kind: result.kind, why: result.why
    }) + '\n');
    process.exitCode = result.ok ? 0 : 1;
  }).catch(function (err) {
    process.stdout.write('[ib-update] failed: ' + String((err && err.stack) || err) + '\n');
    process.exitCode = 1;
  });
}
