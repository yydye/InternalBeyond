'use strict';

/*
 * Internal Beyond · update check runtime (U2).
 *
 * The ONE place the product asks "is there a newer version?". Everything the
 * update feature knows comes from here:
 *
 *   GET /__update-check  (services/internal-beyond-server.js, thin endpoint)
 *   U3 download/install  → consumes the manifest this module resolved
 *   U4 Diagnostics UI    → renders this module's result, implements nothing
 *
 * Per U-D4 the browser implements no transport, no manifest validation and no
 * version comparison of its own. Node is the single source of truth.
 *
 * ── What this module is NOT ────────────────────────────────────────────────
 *   It does not download the installer, does not spawn anything, does not touch
 *   the launcher. It reads a small JSON document and decides one of three
 *   things. It is never on the startup critical path: nothing in the launch
 *   chain requires this module, and no check ever runs at boot (see
 *   docs/ARCHITECTURE.md and the fail-open tests in tests/test_update_check.js).
 *
 * ── Fail-open, in one sentence ─────────────────────────────────────────────
 *   check() never throws and never returns a non-answer: every failure path
 *   resolves to status 'no-information', which the UI shows as "暂时无法检查更
 *  新" — never as an error dialog, never as a blocked start.
 *
 * ── Two routes, one truth (U-D1 Revised) ───────────────────────────────────
 *   primary  https://github.com/yydye/InternalBeyond/releases/latest/download/update-stable.json
 *   fallback GET https://api.github.com/repos/yydye/InternalBeyond/releases/latest
 *            → the asset named exactly `update-stable.json` → the asset API/CDN
 *
 *   The fallback exists because `github.com` is unreachable on some networks
 *   (measured — docs/RELEASE.md §8) while the API and the asset CDN are not.
 *   It is gated by a single, auditable rule:
 *
 *       fallbackAllowed(result) === (result.outcome === 'network')
 *
 *   i.e. ONLY when no complete HTTP response entity was obtained. Any response
 *   we did receive — 404, 403, rate-limited, unparseable, schema-invalid, hash
 *   invalid, identity mismatch, disallowed redirect host — is a HARD failure and
 *   degrades to 'no-information'. It is never retried down the other path: a
 *   second route must not be able to overrule a validation verdict.
 *
 *   Both routes end at the SAME Release asset. The API is a detour, not a
 *   second source of truth. No token, no login, no extra configuration.
 *
 * Zero dependencies beyond node stdlib + ./update-transport.js +
 * ./update-manifest.js + ./product-version.js. Pure-ish by design: transport,
 * clock, cache path and file system are all injectable, so the tests never touch
 * the network.
 *
 * U3 note: the HTTPS transport, the redirect-hop policy and the network error
 * vocabulary now live in runtime/update-transport.js, because the installer
 * download (U3) must share them and must not grow a second copy. This module no
 * longer owns a socket: `fetchText()` delegates to that one implementation.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const transport = require('./update-transport.js');
const updateManifest = require('./update-manifest.js');
const productVersion = require('./product-version.js');

/* ── Frozen thresholds ────────────────────────────────────────────────────── */

/* Auto-check cadence. A manual check always bypasses the cache (U2/U-D4). */
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/* One request's ceiling. Generous for a slow link, short enough that a dead
   network cannot leave a Diagnostics request hanging for a minute. */
const REQUEST_TIMEOUT_MS = transport.REQUEST_TIMEOUT_MS;

/* A redirect chain longer than this is refused as a protocol failure (a
   response WAS received — no fallback). */
const MAX_REDIRECTS = transport.MAX_REDIRECTS;

/* The manifest is ~1 KB; the API release payload is a few KB. 256 KB is far
   above both and far below anything that could exhaust memory. */
const MAX_BODY_BYTES = transport.MAX_BODY_BYTES;

const CACHE_SCHEMA = 'internalbeyond.update-cache';
const CACHE_SCHEMA_VERSION = 1;

/* ── Result vocabulary (owned by the shared transport) ────────────────────── */

const STATUS_UPDATE_AVAILABLE = 'update-available';
const STATUS_UP_TO_DATE = 'up-to-date';
const STATUS_NO_INFORMATION = 'no-information';

const TRANSPORT_DIRECT = transport.TRANSPORT_DIRECT;
const TRANSPORT_API = transport.TRANSPORT_API;

/* Transport outcomes. 'network' is the ONLY one that may fall back. */
const OUTCOME_RESPONSE = transport.OUTCOME_RESPONSE;
const OUTCOME_NETWORK = transport.OUTCOME_NETWORK;
const OUTCOME_PROTOCOL = transport.OUTCOME_PROTOCOL;

/* Network-level error kinds — "we never got a complete HTTP response entity". */
const NETWORK_KINDS = transport.NETWORK_KINDS;

/* ── Cache location ───────────────────────────────────────────────────────── */

/*
 * Outside {app} on purpose: the update payload must never be written into the
 * application directory (U-series invariant), and a cache that survives an
 * upgrade is more useful than one the installer deletes. Same directory as
 * boot-state.json for the same reason (%LOCALAPPDATA%\InternalBeyond).
 */
function updateDir() {
  if (process.env.IB_UPDATE_DIR) return path.resolve(String(process.env.IB_UPDATE_DIR));
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    return path.join(process.env.LOCALAPPDATA, 'InternalBeyond');
  }
  return path.join(os.homedir(), '.internal-beyond');
}

function cacheFile() {
  if (process.env.IB_UPDATE_CACHE_FILE) return path.resolve(String(process.env.IB_UPDATE_CACHE_FILE));
  return path.join(updateDir(), 'update-check.json');
}

/* ── Small helpers ────────────────────────────────────────────────────────── */

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isoUtc(ms) {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/* The transport, the redirect policy and the error vocabulary live in
   runtime/update-transport.js (one implementation, shared with the U3 payload
   download). These are thin references so this module's public surface — which
   tests and the server use — stays exactly what it was in U2. */
const classifyNetworkError = transport.classifyNetworkError;
const describeError = transport.describeError;
const hostAllowed = transport.hostAllowed;
const fallbackAllowed = transport.fallbackAllowed;

/* GET one small document as text, through the shared walker. Every redirect hop
   is checked against the allowlist inside that implementation. */
function fetchText(url, options) {
  const o = options || {};
  return transport.fetchTo(url, Object.assign({}, o, {
    sink: transport.textSink({ maxBytes: o.maxBytes })
  }));
}

/* An injected transport may reject instead of resolving; that is still an
   absence of a response, so it stays on the network path. */
function asNetworkFailure(err, url) {
  return transport.networkFailure(err, [
    { url: url, outcome: OUTCOME_NETWORK, status: null, kind: transport.classifyNetworkError(err) }
  ]);
}

/* ── Cache ────────────────────────────────────────────────────────────────── */

/*
 * The cache stores a manifest that already passed validate() plus the time the
 * answer was obtained. Read-back re-validates: a hand-edited or half-written
 * cache file can never become the update truth, it is simply ignored.
 * Failures are never cached — an outage must not stick for 24 h.
 */
function readCache(opts) {
  const o = opts || {};
  const file = o.cacheFile || cacheFile();
  const now = Number.isFinite(o.now) ? o.now : Date.now();
  const miss = function (why) { return { hit: false, why: why, file: file, at: null, transport: null, manifest: null }; };
  let raw = '';
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { return miss('no cache file (' + String((e && e.code) || e) + ')'); }
  let parsed = null;
  try { parsed = JSON.parse(String(raw).replace(/^\uFEFF/, '')); } catch (e) { return miss('cache is not valid JSON'); }
  if (!isPlainObject(parsed)) return miss('cache is not a JSON object');
  if (parsed.schema !== CACHE_SCHEMA) return miss('cache schema mismatch');
  if (parsed.schemaVersion !== CACHE_SCHEMA_VERSION) return miss('cache schemaVersion mismatch');
  if (parsed.channel !== updateManifest.CHANNEL_STABLE) return miss('cache is for another channel');
  const at = Date.parse(String(parsed.checkedAt));
  if (Number.isNaN(at)) return miss('cache checkedAt is not a timestamp');
  const age = now - at;
  if (age < 0) return miss('cache is dated in the future');
  if (age > CACHE_TTL_MS) return miss('cache is older than 24 h');
  const verdict = updateManifest.validate(parsed.manifest);
  /* A cached manifest that no longer validates is a miss, never an answer. */
  if (!verdict.ok) return miss('cached manifest no longer validates');
  return {
    hit: true,
    why: null,
    file: file,
    at: at,
    transport: parsed.transport === TRANSPORT_API ? TRANSPORT_API : TRANSPORT_DIRECT,
    manifest: parsed.manifest
  };
}

function writeCache(manifest, at, route, opts) {
  const o = opts || {};
  if (o.useCache === false) return { written: false, why: 'cache disabled' };
  const file = o.cacheFile || cacheFile();
  const payload = {
    schema: CACHE_SCHEMA,
    schemaVersion: CACHE_SCHEMA_VERSION,
    channel: updateManifest.CHANNEL_STABLE,
    checkedAt: isoUtc(at),
    transport: route,
    manifest: manifest
  };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(payload, null, 2) + '\n', 'utf8');
    return { written: true, why: null, file: file };
  } catch (e) {
    /* A cache we cannot write is a performance problem, never a correctness
       one: the check result is already in hand. */
    return { written: false, why: describeError(e), file: file };
  }
}

/* ── Manifest parsing ─────────────────────────────────────────────────────── */

function parseManifestBody(text) {
  let parsed = null;
  try { parsed = JSON.parse(String(text == null ? '' : text).replace(/^\uFEFF/, '')); }
  catch (e) { return { ok: false, why: 'manifest is not valid JSON: ' + describeError(e), manifest: null, warnings: [] }; }
  const verdict = updateManifest.validate(parsed);
  if (!verdict.ok) {
    return {
      ok: false,
      why: 'manifest failed validation: ' + verdict.errors.map(function (e) { return e.field + ' (' + e.why + ')'; }).join('; '),
      manifest: null,
      warnings: verdict.warnings
    };
  }
  return { ok: true, why: null, manifest: parsed, warnings: verdict.warnings };
}

/* ── The check ────────────────────────────────────────────────────────────── */

function noInformation(attempts, currentVersion, extra) {
  const e = extra || {};
  return Object.assign({
    ok: false,
    status: STATUS_NO_INFORMATION,
    updateAvailable: false,
    currentVersion: currentVersion,
    latestVersion: null,
    manifest: null,
    /* The route whose verdict this is — also set (as `error.transport`) when the
       verdict is a failure, so Diagnostics can say WHICH path said no. */
    transport: e.transport || null,
    fromCache: false,
    checkedAt: null,
    error: { kind: e.kind || 'unknown', message: e.message || 'no update information', transport: e.transport || null },
    attempts: attempts,
    warnings: []
  });
}

/*
 * Resolve "is there a newer version?".
 *
 * opts:
 *   currentVersion  the running version; defaults to VERSION (productVersion.get())
 *   transport       injectable fetchText-like function (tests never hit the net)
 *   now             injectable clock (ms)
 *   force           true = manual check, bypass the cache (still refreshes it)
 *   useCache        false = ignore and do not write the cache
 *   cacheFile       injectable cache path
 *   timeoutMs       per-request ceiling
 *   manifestUrl     injectable primary URL (tests)
 *   apiReleaseUrl   injectable API URL (tests)
 *
 * Never throws. Every failure path returns status 'no-information'.
 */
function check(options) {
  const o = options || {};
  const attempts = [];
  const fetchImpl = typeof o.transport === 'function' ? o.transport
    : function (url, opts) { return fetchText(url, Object.assign({ timeoutMs: o.timeoutMs }, opts || {})); };
  const now = Number.isFinite(o.now) ? o.now : Date.now();
  const current = String(o.currentVersion == null ? runningVersion() : o.currentVersion).trim();
  const force = o.force === true;
  const useCache = o.useCache !== false;
  const manifestUrl = String(o.manifestUrl || updateManifest.MANIFEST_URL);
  const apiReleaseUrl = String(o.apiReleaseUrl || updateManifest.API_LATEST_RELEASE);

  const currentParsed = productVersion.parse(current);
  if (!currentParsed) {
    /* Bad current version = our own broken installation, not a network issue.
       Still fail-open, still a promise: callers never branch on the shape. */
    return Promise.resolve(noInformation(attempts, current, {
      kind: 'bad-current-version',
      message: 'the running version is not MAJOR.MINOR.PATCH: ' + JSON.stringify(current)
    }));
  }

  return Promise.resolve().then(function () {
    /* ── 1. cache (skipped by a manual check) ─────────────────────────────── */
    if (!force && useCache) {
      const cached = readCache({ cacheFile: o.cacheFile, now: now });
      if (cached.hit) {
        return finish(cached.manifest, cached.transport, {
          fromCache: true, checkedAt: cached.at, attempts: attempts, current: currentParsed.version, warnings: []
        });
      }
    }

    /* ── 2. primary route: the frozen stable manifest URL ─────────────────── */
    return fetchImpl(manifestUrl, { accept: 'application/json' })
      .catch(function (err) {
        return asNetworkFailure(err, manifestUrl);
      })
      .then(function (primary) {
        attempts.push({
          transport: TRANSPORT_DIRECT, url: manifestUrl, outcome: primary.outcome,
          kind: primary.kind, status: primary.status, message: primary.message
        });

        if (primary.outcome === OUTCOME_RESPONSE) return judgeManifest(primary, TRANSPORT_DIRECT, primary.body);

        if (!fallbackAllowed(primary)) {
          /* protocol: a response we refused to accept. Never retried elsewhere. */
          return noInformation(attempts, current, {
            kind: primary.kind, message: primary.message, transport: TRANSPORT_DIRECT
          });
        }

        /* ── 3. fallback route: GitHub Releases API ─────────────────────────
           Reached ONLY for outcome === 'network'. */
        return fetchImpl(apiReleaseUrl, { accept: 'application/vnd.github+json' })
          .catch(function (err) {
            return asNetworkFailure(err, apiReleaseUrl);
          })
          .then(function (release) {
            attempts.push({
              transport: TRANSPORT_API, url: apiReleaseUrl, outcome: release.outcome,
              kind: release.kind, status: release.status, message: release.message
            });
            if (release.outcome !== OUTCOME_RESPONSE) {
              return noInformation(attempts, current, {
                kind: release.kind, message: release.message, transport: TRANSPORT_API
              });
            }
            let payload = null;
            try { payload = JSON.parse(release.body); } catch (e) { payload = null; }
            const picked = updateManifest.selectManifestAsset(payload);
            if (!picked.ok) {
              return noInformation(attempts, current, {
                kind: 'api-release-unusable', message: picked.why, transport: TRANSPORT_API
              });
            }
            const assetUrl = updateManifest.assetApiUrl(picked.assetId);
            return fetchImpl(assetUrl, { accept: 'application/octet-stream' })
              .catch(function (err) {
                return asNetworkFailure(err, assetUrl);
              })
              .then(function (asset) {
                attempts.push({
                  transport: TRANSPORT_API, url: assetUrl, outcome: asset.outcome,
                  kind: asset.kind, status: asset.status, message: asset.message
                });
                if (asset.outcome !== OUTCOME_RESPONSE) {
                  /* No second fallback and no retry: one detour only. */
                  return noInformation(attempts, current, {
                    kind: asset.kind, message: asset.message, transport: TRANSPORT_API
                  });
                }
                return judgeManifest(asset, TRANSPORT_API, asset.body, picked);
              });
          });
      });

    /* ── judge a 2xx body: schema → identity → version ──────────────────── */
    function judgeManifest(result, transport, body, picked) {
      const parsed = parseManifestBody(body);
      if (!parsed.ok) {
        /* HARD failure. A response was received and it did not honour the
           contract; the other route must not get a second opinion. */
        return noInformation(attempts, current, {
          kind: 'invalid-manifest', message: parsed.why, transport: transport
        });
      }
      const manifest = parsed.manifest;

      /* On the API route we independently learned the release tag. If the
         manifest's own version disagrees with the release it was attached to,
         the asset identity is inconsistent → hard failure. This is the fallback
         path's equivalent of the primary path's URL-is-version-pinned check. */
      if (picked && picked.version && manifest.version !== picked.version) {
        attempts.push({
          transport: transport, url: null, outcome: OUTCOME_PROTOCOL, kind: 'identity-mismatch',
          status: null, message: 'manifest version ' + manifest.version + ' != release tag ' + picked.tag
        });
        return noInformation(attempts, current, {
          kind: 'identity-mismatch',
          message: 'manifest version ' + manifest.version + ' does not match release tag ' + picked.tag,
          transport: transport
        });
      }

      return finish(manifest, transport, {
        fromCache: false, checkedAt: now, attempts: attempts,
        current: currentParsed.version, warnings: parsed.warnings
      });
    }

    /* ── compare, cache, return ─────────────────────────────────────────── */
    function finish(manifest, transport, ctx) {
      const latestParsed = productVersion.parse(manifest.version);
      const cmp = productVersion.compare(manifest.version, ctx.current);
      if (cmp === null || !latestParsed) {
        /* Unreachable after validate(), but stated rather than assumed: an
           uncomparable pair is "no information", never "up to date". */
        return noInformation(attempts, current, {
          kind: 'uncomparable-version',
          message: 'cannot compare ' + JSON.stringify(manifest.version) + ' with ' + JSON.stringify(ctx.current),
          transport: transport
        });
      }
      const newer = cmp > 0;
      const result = {
        ok: true,
        status: newer ? STATUS_UPDATE_AVAILABLE : STATUS_UP_TO_DATE,
        updateAvailable: newer,
        currentVersion: ctx.current,
        latestVersion: latestParsed.version,
        manifest: manifest,
        transport: transport,
        fromCache: !!ctx.fromCache,
        checkedAt: isoUtc(ctx.checkedAt),
        error: null,
        attempts: ctx.attempts,
        warnings: ctx.warnings || []
      };
      if (!ctx.fromCache) {
        const written = writeCache(manifest, ctx.checkedAt, transport, o);
        if (!written.written && written.why && written.why !== 'cache disabled') {
          result.warnings.push({ field: 'cache', why: 'could not write the update cache: ' + written.why });
        }
      }
      return result;
    }
  }).catch(function (err) {
    /* Belt and braces: no code path above is supposed to throw, but a caller
       must never have to defend itself against this module. */
    attempts.push({
      transport: null, url: null, outcome: 'internal', kind: 'internal-error',
      status: null, message: describeError(err)
    });
    return noInformation(attempts, current, { kind: 'internal-error', message: describeError(err) });
  });
}

function runningVersion() {
  const read = productVersion.get();
  return read && read.ok ? read.version : '';
}

/* ── Single flight ────────────────────────────────────────────────────────── */

/*
 * The static server is a long-lived process and Diagnostics can be reloaded
 * repeatedly. Two slots (auto / manual) so a manual check still performs a real
 * fresh check, while N simultaneous automatic checks share one network round
 * trip. A shared result is a cache-free result: it came from the network, so
 * `fromCache` stays honest.
 */
const inFlight = { auto: null, manual: null };

function checkShared(options) {
  const o = options || {};
  const key = o.force === true ? 'manual' : 'auto';
  if (inFlight[key]) return inFlight[key];
  const promise = check(o).then(function (result) {
    if (inFlight[key] === promise) inFlight[key] = null;
    return result;
  }, function (err) {
    if (inFlight[key] === promise) inFlight[key] = null;
    throw err;
  });
  inFlight[key] = promise;
  return promise;
}

function resetInFlight() { inFlight.auto = null; inFlight.manual = null; }

/* ── A bounded projection for the UI (U4 renders this, nothing more) ──────── */

/*
 * The browser gets exactly what the update card needs — never the raw manifest,
 * never an internal error object. `notes` is plain text and MUST be rendered
 * with textContent (never innerHTML); a manifest containing angle brackets is
 * reported by validate() as a warning for that reason.
 */
function summarize(result) {
  const r = result || {};
  const manifest = r.manifest || {};
  const installer = manifest.installer || {};
  return {
    ok: !!r.ok,
    status: r.status || STATUS_NO_INFORMATION,
    updateAvailable: !!r.updateAvailable,
    currentVersion: r.currentVersion || '',
    latestVersion: r.latestVersion || '',
    fromCache: !!r.fromCache,
    transport: r.transport || '',
    checkedAt: r.checkedAt || '',
    error: r.error ? { kind: r.error.kind, message: r.error.message } : null,
    update: r.updateAvailable && r.manifest ? {
      version: manifest.version || '',
      releasedAt: manifest.releasedAt || '',
      minimumVersion: manifest.minimumVersion || '',
      notes: typeof manifest.notes === 'string' ? manifest.notes : '',
      notesUrl: manifest.notesUrl || '',
      sizeBytes: installer.sizeBytes,
      sha256: installer.sha256 || ''
    } : null
  };
}

module.exports = {
  CACHE_TTL_MS: CACHE_TTL_MS,
  REQUEST_TIMEOUT_MS: REQUEST_TIMEOUT_MS,
  MAX_REDIRECTS: MAX_REDIRECTS,
  MAX_BODY_BYTES: MAX_BODY_BYTES,
  CACHE_SCHEMA: CACHE_SCHEMA,
  CACHE_SCHEMA_VERSION: CACHE_SCHEMA_VERSION,
  STATUS_UPDATE_AVAILABLE: STATUS_UPDATE_AVAILABLE,
  STATUS_UP_TO_DATE: STATUS_UP_TO_DATE,
  STATUS_NO_INFORMATION: STATUS_NO_INFORMATION,
  TRANSPORT_DIRECT: TRANSPORT_DIRECT,
  TRANSPORT_API: TRANSPORT_API,
  OUTCOME_RESPONSE: OUTCOME_RESPONSE,
  OUTCOME_NETWORK: OUTCOME_NETWORK,
  OUTCOME_PROTOCOL: OUTCOME_PROTOCOL,
  NETWORK_KINDS: NETWORK_KINDS,
  cacheFile: cacheFile,
  updateDir: updateDir,
  classifyNetworkError: classifyNetworkError,
  hostAllowed: hostAllowed,
  fallbackAllowed: fallbackAllowed,
  fetchText: fetchText,
  readCache: readCache,
  writeCache: writeCache,
  check: check,
  checkShared: checkShared,
  resetInFlight: resetInFlight,
  summarize: summarize
};
