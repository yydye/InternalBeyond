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
 * Zero dependencies beyond node stdlib + ./update-manifest.js + ./product-version.js.
 * Pure-ish by design: transport, clock, cache path and file system are all
 * injectable, so the tests never touch the network.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const zlib = require('zlib');

const updateManifest = require('./update-manifest.js');
const productVersion = require('./product-version.js');

/* ── Frozen thresholds ────────────────────────────────────────────────────── */

/* Auto-check cadence. A manual check always bypasses the cache (U2/U-D4). */
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/* One request's ceiling. Generous for a slow link, short enough that a dead
   network cannot leave a Diagnostics request hanging for a minute. */
const REQUEST_TIMEOUT_MS = 8000;

/* A redirect chain longer than this is refused as a protocol failure (a
   response WAS received — no fallback). */
const MAX_REDIRECTS = 5;

/* The manifest is ~1 KB; the API release payload is a few KB. 256 KB is far
   above both and far below anything that could exhaust memory. */
const MAX_BODY_BYTES = 256 * 1024;

const USER_AGENT = 'InternalBeyond-Updater';
const CACHE_SCHEMA = 'internalbeyond.update-cache';
const CACHE_SCHEMA_VERSION = 1;

/* ── Result vocabulary ────────────────────────────────────────────────────── */

const STATUS_UPDATE_AVAILABLE = 'update-available';
const STATUS_UP_TO_DATE = 'up-to-date';
const STATUS_NO_INFORMATION = 'no-information';

const TRANSPORT_DIRECT = 'direct';
const TRANSPORT_API = 'api';

/* Transport outcomes. 'network' is the ONLY one that may fall back. */
const OUTCOME_RESPONSE = 'response';
const OUTCOME_NETWORK = 'network';
const OUTCOME_PROTOCOL = 'protocol';

/*
 * Network-level error kinds — "we never got a complete HTTP response entity".
 * Deliberately includes a generic 'socket' bucket: an unexpected transport error
 * is still an absence of a response, and the fallback itself re-validates
 * everything, so treating it as network-level cannot weaken a validation gate.
 */
const NETWORK_KINDS = ['dns', 'connect-timeout', 'reset', 'refused', 'unreachable', 'tls', 'socket'];

const CODE_TO_KIND = {
  ENOTFOUND: 'dns',
  EAI_AGAIN: 'dns',
  EAI_FAIL: 'dns',
  ENODATA: 'dns',
  ETIMEDOUT: 'connect-timeout',
  ESOCKETTIMEDOUT: 'connect-timeout',
  ERR_SOCKET_CONNECTION_TIMEOUT: 'connect-timeout',
  ECONNRESET: 'reset',
  EPIPE: 'reset',
  ECONNABORTED: 'reset',
  ECONNREFUSED: 'refused',
  EHOSTUNREACH: 'unreachable',
  ENETUNREACH: 'unreachable',
  ENETDOWN: 'unreachable',
  EADDRNOTAVAIL: 'unreachable',
  EPROTO: 'tls',
  ERR_SSL_WRONG_VERSION_NUMBER: 'tls',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'tls',
  DEPTH_ZERO_SELF_SIGNED_CERT: 'tls',
  SELF_SIGNED_CERT_IN_CHAIN: 'tls',
  CERT_HAS_EXPIRED: 'tls'
};

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

/* Translate a thrown socket/TLS error into one of NETWORK_KINDS. */
function classifyNetworkError(err) {
  const raw = String((err && (err.code || err.errno)) || '').toUpperCase();
  if (CODE_TO_KIND[raw]) return CODE_TO_KIND[raw];
  /* Certificates reject with a variety of CERT_* / ERR_TLS_* names. */
  if (/^(CERT_|ERR_TLS|ERR_SSL|UNABLE_TO_)/.test(raw)) return 'tls';
  if (err && err.__ibTimeout) return 'connect-timeout';
  return 'socket';
}

function describeError(err) {
  if (!err) return 'unknown transport error';
  const code = err.code || err.errno;
  const msg = String((err && err.message) || err);
  return (code ? code + ': ' : '') + msg;
}

function networkFailure(err, hops) {
  return {
    outcome: OUTCOME_NETWORK,
    kind: classifyNetworkError(err),
    message: describeError(err),
    status: null,
    headers: null,
    body: '',
    finalUrl: hops.length ? hops[hops.length - 1].url : null,
    hops: hops
  };
}

function protocolFailure(kind, message, hops, status) {
  return {
    outcome: OUTCOME_PROTOCOL,
    kind: kind,
    message: message,
    status: typeof status === 'number' ? status : null,
    headers: null,
    body: '',
    finalUrl: hops.length ? hops[hops.length - 1].url : null,
    hops: hops
  };
}

function responseResult(status, headers, body, finalUrl, hops) {
  return {
    outcome: OUTCOME_RESPONSE,
    kind: null,
    message: null,
    status: status,
    headers: headers || {},
    body: body,
    finalUrl: finalUrl,
    hops: hops
  };
}

/* Is this host one the updater may talk to? Checked for the initial URL and for
   every redirect hop, so a compromised or misconfigured redirect cannot walk us
   to an arbitrary origin. */
function hostAllowed(urlString) {
  let u = null;
  try { u = new URL(urlString); } catch (e) { return false; }
  if (u.protocol !== 'https:') return false;
  return updateManifest.TRANSPORT_HOSTS.indexOf(u.hostname.toLowerCase()) >= 0;
}

/* ── Transport ────────────────────────────────────────────────────────────── */

/*
 * One GET, manual redirects. Redirects are followed by hand (never by the HTTP
 * client) precisely so that every hop passes hostAllowed() — an automatic
 * follower would happily leave our allowlist.
 *
 * ALWAYS resolves; never rejects. The result's `outcome` is the single input to
 * the fallback decision, so that decision stays a one-line, auditable fact
 * rather than a judgement made in several catch blocks.
 */
function fetchText(url, options) {
  const o = options || {};
  const timeoutMs = Number.isInteger(o.timeoutMs) ? o.timeoutMs : REQUEST_TIMEOUT_MS;
  const maxRedirects = Number.isInteger(o.maxRedirects) ? o.maxRedirects : MAX_REDIRECTS;
  const maxBytes = Number.isInteger(o.maxBytes) ? o.maxBytes : MAX_BODY_BYTES;
  const accept = String(o.accept || 'application/json, text/plain;q=0.9, */*;q=0.5');
  const hops = [];

  return new Promise(function (resolve) {
    const visit = function (currentUrl, redirectsLeft) {
      if (!hostAllowed(currentUrl)) {
        resolve(protocolFailure('host-not-allowed',
          'refused a transport hop outside the allowlist: ' + currentUrl, hops));
        return;
      }
      let target = null;
      try { target = new URL(currentUrl); } catch (e) {
        resolve(protocolFailure('bad-url', 'not a valid URL: ' + currentUrl, hops));
        return;
      }

      const headers = {
        'User-Agent': USER_AGENT,
        'Accept': accept,
        'Accept-Encoding': 'gzip, deflate, br'
      };
      if (String(target.hostname).toLowerCase() === 'api.github.com') {
        headers['X-GitHub-Api-Version'] = updateManifest.API_VERSION_HEADER;
        /* Anonymous read-only. No token is ever sent — see U-D1 Revised item 7. */
      }

      let settled = false;
      const finish = function (result) { if (!settled) { settled = true; resolve(result); } };

      const req = https.request({
        protocol: 'https:',
        hostname: target.hostname,
        port: target.port || 443,
        path: target.pathname + target.search,
        method: 'GET',
        headers: headers,
        /* `rejectUnauthorized` stays at its secure default: a TLS failure is a
           network-level failure (no response), never a reason to weaken TLS. */
        agent: false
      });

      /* Hard deadline for the whole exchange, including body read. A socket
         timeout alone would not cover a peer that trickles bytes forever. */
      const deadline = setTimeout(function () {
        const err = new Error('no complete response within ' + timeoutMs + ' ms');
        err.code = 'ETIMEDOUT';
        err.__ibTimeout = true;
        try { req.destroy(err); } catch (e) { }
        settleAsNetwork(err);
      }, timeoutMs);
      if (typeof deadline.unref === 'function') deadline.unref();

      /* `settleAsNetwork` marks the hop as a transport failure so a redirect
         that dies mid-chain is reported as such rather than as the initial
         request's failure. */
      function settleAsNetwork(err) {
        clearTimeout(deadline);
        /* A leg that already handed over to a redirect (or was already settled)
           must not be able to resolve the outer promise afterwards: the socket
           error of a drained redirect response is not the request's outcome. */
        if (settled) return;
        hops.push({ url: currentUrl, outcome: OUTCOME_NETWORK, status: null, kind: classifyNetworkError(err) });
        finish(networkFailure(err, hops));
      }

      req.on('error', function (err) {
        clearTimeout(deadline);
        settleAsNetwork(err);
      });

      req.on('response', function (res) {
        const status = Number(res.statusCode) || 0;

        /* 3xx: follow by hand, under our own allowlist. */
        if (status >= 300 && status < 400 && res.headers.location) {
          clearTimeout(deadline);
          res.resume();
          hops.push({ url: currentUrl, outcome: OUTCOME_RESPONSE, status: status, kind: 'redirect' });
          if (redirectsLeft <= 0) {
            finish(protocolFailure('too-many-redirects',
              'more than ' + maxRedirects + ' redirects while fetching ' + url, hops, status));
            return;
          }
          let next = null;
          try { next = new URL(String(res.headers.location), currentUrl).toString(); } catch (e) { next = null; }
          if (!next) {
            finish(protocolFailure('bad-redirect',
              'unusable Location header: ' + JSON.stringify(res.headers.location), hops, status));
            return;
          }
          if (!hostAllowed(next)) {
            /* A security refusal, NOT a transport failure: a redirect aimed
               outside the allowlist must never become a reason to try the other
               route. Degrade to "no information". */
            finish(protocolFailure('redirect-host-not-allowed',
              'refused a redirect outside the allowlist: ' + next, hops, status));
            return;
          }
          /* This leg is done; the next hop owns the promise from here. */
          settled = true;
          visit(next, redirectsLeft - 1);
          return;
        }

        /* Everything else is a response we received and therefore must judge. */
        const chunks = [];
        let total = 0;
        let done = false;
        const bail = function (err) {
          if (done) return;
          done = true;
          clearTimeout(deadline);
          settleAsNetwork(err);
        };
        res.on('error', bail);
        res.on('data', function (chunk) {
          if (done) return;
          total += chunk.length;
          if (total > maxBytes) {
            done = true;
            clearTimeout(deadline);
            try { res.destroy(); } catch (e) { }
            hops.push({ url: currentUrl, outcome: OUTCOME_PROTOCOL, status: status, kind: 'body-too-large' });
            finish(protocolFailure('body-too-large',
              'response exceeded ' + maxBytes + ' bytes', hops, status));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', function () {
          if (done) return;
          done = true;
          clearTimeout(deadline);
          hops.push({ url: currentUrl, outcome: OUTCOME_RESPONSE, status: status, kind: null });
          if (status < 200 || status >= 300) {
            /* 4xx / 5xx including 403/429 rate limiting: a response, so it is a
               hard failure and the other route is NOT tried. */
            finish(protocolFailure(status === 403 || status === 429 ? 'rate-limited' : 'http-status',
              'HTTP ' + status + ' from ' + currentUrl, hops, status));
            return;
          }
          let text = '';
          try {
            text = decodeBody(Buffer.concat(chunks), res.headers['content-encoding']);
          } catch (e) {
            finish(protocolFailure('bad-encoding',
              'could not decode response body: ' + describeError(e), hops, status));
            return;
          }
          finish(responseResult(status, res.headers, text, currentUrl, hops));
        });
      });

      req.end();
    };

    visit(String(url), maxRedirects);
  });
}

function decodeBody(buffer, encoding) {
  const enc = String(encoding || '').trim().toLowerCase();
  const cap = { maxOutputLength: MAX_BODY_BYTES };
  if (enc === 'gzip' || enc === 'x-gzip') return zlib.gunzipSync(buffer, cap).toString('utf8');
  if (enc === 'deflate') return zlib.inflateSync(buffer, cap).toString('utf8');
  if (enc === 'br') return zlib.brotliDecompressSync(buffer, cap).toString('utf8');
  if (enc && enc !== 'identity') return buffer.toString('utf8'); /* unknown: best effort */
  return buffer.toString('utf8');
}

/* ── Fallback gate (the whole rule, in one place) ─────────────────────────── */

/*
 * May we try the API route? Only when the primary produced no complete HTTP
 * response entity. `protocol` results (HTTP status, bad schema upstream, a
 * refused redirect) and `response` results are both final verdicts.
 */
function fallbackAllowed(result) {
  return !!result && result.outcome === OUTCOME_NETWORK;
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

function writeCache(manifest, at, transport, opts) {
  const o = opts || {};
  if (o.useCache === false) return { written: false, why: 'cache disabled' };
  const file = o.cacheFile || cacheFile();
  const payload = {
    schema: CACHE_SCHEMA,
    schemaVersion: CACHE_SCHEMA_VERSION,
    channel: updateManifest.CHANNEL_STABLE,
    checkedAt: isoUtc(at),
    transport: transport,
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
        /* An injected transport may reject instead of resolving; that is still
           an absence of a response, so it stays on the network path. */
        return networkFailure(err, [{ url: manifestUrl, outcome: OUTCOME_NETWORK, status: null, kind: classifyNetworkError(err) }]);
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
            return networkFailure(err, [{ url: apiReleaseUrl, outcome: OUTCOME_NETWORK, status: null, kind: classifyNetworkError(err) }]);
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
                return networkFailure(err, [{ url: assetUrl, outcome: OUTCOME_NETWORK, status: null, kind: classifyNetworkError(err) }]);
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
