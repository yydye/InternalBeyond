'use strict';

/*
 * Internal Beyond · shared update transport (U2 + U3)
 *
 * ONE HTTPS transport, ONE redirect policy, ONE network-error vocabulary, shared
 * by both halves of the update feature:
 *
 *   U2  runtime/update-check.js   downloads ~1 KB JSON documents (manifest,
 *                                 release metadata)           → text sink
 *   U3  runtime/update-install.js downloads the ~48 MB installer payload
 *                                                               → file sink
 *
 * ── Why this file exists (the duplication boundary, proven) ────────────────
 *   U-D6 item 9 requires U3 to reuse U2's transport, error classification and
 *   host validation. The genuinely shared parts are exactly these:
 *
 *     · the host allowlist, enforced on the initial request AND on every
 *       redirect hop (an automatic follower would walk straight out of it)
 *     · the network/protocol/response outcome vocabulary, because
 *       `fallbackAllowed(result) === (result.outcome === 'network')` is the
 *       single gate that decides whether a second route may be tried
 *     · the frozen list of network error kinds
 *
 *   The parts that genuinely differ are only about the BODY:
 *
 *     text sink   256 KB cap, charset is utf-8, Content-Encoding is decompressed
 *     file sink   no cap, streamed to a .part file while hashing, Content-Length
 *                 is a security input, nothing is decompressed
 *
 *   So the extraction is: the hop walker stays, and the body handling becomes a
 *   sink. `fetchTo()` is the single implementation both callers use; neither
 *   caller may implement its own redirect walk or its own error classifier.
 *
 * ── Never throws ──────────────────────────────────────────────────────────
 *   fetchTo() ALWAYS resolves with a result whose `outcome` is one of
 *   'response' / 'network' / 'protocol'. The fallback decision is then a
 *   one-line fact instead of a judgement made inside several catch blocks:
 *   only 'network' — "we never obtained a complete HTTP response entity" —
 *   may be retried down the other route (U-D1 Revised, U-D6).
 */

const https = require('https');
const zlib = require('zlib');

const updateManifest = require('./update-manifest.js');

/* ── Frozen transport constants ───────────────────────────────────────────── */

/* One request's ceiling for small JSON documents. The installer payload
   overrides this: 48 MB over a slow link legitimately takes minutes. */
const REQUEST_TIMEOUT_MS = 8000;

/* A redirect chain longer than this is refused as a protocol failure (a
   response WAS received — no fallback). */
const MAX_REDIRECTS = 5;

/* The manifest is ~1 KB; the API release payload is a few KB. 256 KB is far
   above both and far below anything that could exhaust memory. */
const MAX_BODY_BYTES = 256 * 1024;

const USER_AGENT = 'InternalBeyond-Updater';

/* Transport identities, reported in results so the UI can say WHICH path
   answered. 'direct' = the frozen github.com asset URL; 'api' = the GitHub
   Releases API detour. */
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

/* ── Classification ───────────────────────────────────────────────────────── */

/* Translate a thrown socket/TLS error into one of NETWORK_KINDS. */
function classifyNetworkError(err) {
  const raw = String((err && (err.code || err.errno)) || '').toUpperCase();
  if (CODE_TO_KIND[raw]) return CODE_TO_KIND[raw];
  /* Certificates reject with a variety of CERT_* / ERR_TLS_* / ERR_SSL_* names. */
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

/* Is this host one the updater may talk to? Checked for the initial URL and for
   every redirect hop, so a compromised or misconfigured redirect cannot walk us
   to an arbitrary origin. */
function hostAllowed(urlString) {
  let u = null;
  try { u = new URL(urlString); } catch (e) { return false; }
  if (u.protocol !== 'https:') return false;
  return updateManifest.TRANSPORT_HOSTS.indexOf(u.hostname.toLowerCase()) >= 0;
}

/*
 * May we try the other route? Only when this attempt produced no complete HTTP
 * response entity. `protocol` results (HTTP status, refused redirect, a body the
 * sink rejected) and `response` results are both final verdicts.
 *
 * This is the WHOLE rule for both U2 (documents) and U3 (payload). There is no
 * second gate anywhere: a caller that wants to retry must ask this function.
 */
function fallbackAllowed(result) {
  return !!result && result.outcome === OUTCOME_NETWORK;
}

/* ── Result builders (internal) ───────────────────────────────────────────── */

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

/* ── Body sinks ───────────────────────────────────────────────────────────── */

/*
 * A sink owns everything about the body and nothing about the transport. The
 * walker calls, in order:
 *
 *   onResponse(status, headers)  once, for a 2xx response, before any body byte
 *                                is read — so a payload sink can refuse a bad
 *                                Content-Length without pulling 48 MB first
 *                                → null, or { kind, message } to refuse
 *   onData(chunk)                once per chunk
 *                                → null, or { kind, message } to refuse
 *   onEnd(status, headers)       once, after the last byte
 *                                → { value } on success, or { kind, message }
 *   onAbort()                    optional; called whenever a refusal or a
 *                                transport error ends the attempt, so a sink can
 *                                clean up a partially written file
 *
 * A sink is never consulted for a non-2xx response: `http-status` is the verdict
 * there, and an error page is drained rather than handed to a sink (or buffered).
 *
 * A refusal is a PROTOCOL failure: a response was received and we judged it, so
 * the other route must not get a second opinion (U-D1 Revised item 4).
 */

/*
 * The U2 sink: collect a small text document, decompressing if the server
 * compressed it. `maxBytes` caps the COMPRESSED size read off the wire; the
 * decompressed output is capped separately by zlib, so a compression bomb
 * cannot expand past the same budget.
 */
function textSink(options) {
  const o = options || {};
  const maxBytes = Number.isInteger(o.maxBytes) ? o.maxBytes : MAX_BODY_BYTES;
  const chunks = [];
  let total = 0;
  return {
    kind: 'text',
    maxBytes: maxBytes,
    onResponse: function () { return null; },
    onData: function (chunk) {
      total += chunk.length;
      if (total > maxBytes) {
        return { kind: 'body-too-large', message: 'response exceeded ' + maxBytes + ' bytes' };
      }
      chunks.push(chunk);
      return null;
    },
    onEnd: function (status, headers) {
      let text = '';
      try {
        text = decodeBody(Buffer.concat(chunks), headers && headers['content-encoding'], maxBytes);
      } catch (e) {
        return { kind: 'bad-encoding', message: 'could not decode response body: ' + describeError(e) };
      }
      return { value: text };
    }
  };
}

function decodeBody(buffer, encoding, maxOutputBytes) {
  const enc = String(encoding || '').trim().toLowerCase();
  const cap = { maxOutputLength: Number.isInteger(maxOutputBytes) ? maxOutputBytes : MAX_BODY_BYTES };
  if (enc === 'gzip' || enc === 'x-gzip') return zlib.gunzipSync(buffer, cap).toString('utf8');
  if (enc === 'deflate') return zlib.inflateSync(buffer, cap).toString('utf8');
  if (enc === 'br') return zlib.brotliDecompressSync(buffer, cap).toString('utf8');
  if (enc && enc !== 'identity') return buffer.toString('utf8'); /* unknown: best effort */
  return buffer.toString('utf8');
}

/* ── The hop walker ───────────────────────────────────────────────────────── */

/*
 * One GET, manual redirects. Redirects are followed by hand (never by the HTTP
 * client) precisely so that every hop passes hostAllowed().
 *
 * ALWAYS resolves; never rejects.
 *
 * options:
 *   timeoutMs     hard deadline for the whole exchange (default 8 s)
 *   maxRedirects  redirect budget (default 5)
 *   accept        Accept header
 *   sink          body sink (default: the 256 KB text sink)
 *   onHop         optional (hop) → void, for progress reporting (U3)
 */
function fetchTo(url, options) {
  const o = options || {};
  const timeoutMs = Number.isInteger(o.timeoutMs) ? o.timeoutMs : REQUEST_TIMEOUT_MS;
  const maxRedirects = Number.isInteger(o.maxRedirects) ? o.maxRedirects : MAX_REDIRECTS;
  const accept = String(o.accept || 'application/json, text/plain;q=0.9, */*;q=0.5');
  const sink = o.sink || textSink({});
  const onHop = typeof o.onHop === 'function' ? o.onHop : null;
  /* Optional SECOND deadline, for large bodies only: the whole exchange may take
     minutes (a 48 MB payload on a slow line), but a peer that stops sending must
     not be able to hold the helper open. Disabled unless a caller asks for it,
     so the U2 document path is unchanged. */
  const stallMs = Number.isInteger(o.stallTimeoutMs) && o.stallTimeoutMs > 0 ? o.stallTimeoutMs : null;
  const hops = [];

  const pushHop = function (hop) {
    hops.push(hop);
    if (onHop) { try { onHop(hop); } catch (e) { } }
  };

  const abort = function () {
    if (typeof sink.onAbort === 'function') { try { sink.onAbort(); } catch (e) { } }
  };

  return new Promise(function (resolve) {
    const visit = function (currentUrl, redirectsLeft) {
      if (!hostAllowed(currentUrl)) {
        const r = protocolFailure('host-not-allowed',
          'refused a transport hop outside the allowlist: ' + currentUrl, hops);
        abort();
        resolve(r);
        return;
      }
      let target = null;
      try { target = new URL(currentUrl); } catch (e) {
        const r = protocolFailure('bad-url', 'not a valid URL: ' + currentUrl, hops);
        abort();
        resolve(r);
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
      const finish = function (result) {
        if (settled) return;
        settled = true;
        if (result.outcome !== OUTCOME_RESPONSE) abort();
        resolve(result);
      };

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

      /* Optional stall deadline: reset by every body chunk, so a download that
         is still making progress is never killed by it. */
      let stallTimer = null;
      const clearStall = function () { if (stallTimer) { clearTimeout(stallTimer); stallTimer = null; } };
      const resetStall = function () {
        clearStall();
        if (!stallMs) return;
        stallTimer = setTimeout(function () {
          const err = new Error('no data for ' + stallMs + ' ms');
          err.code = 'ETIMEDOUT';
          err.__ibTimeout = true;
          err.__ibStall = true;
          try { req.destroy(err); } catch (e) { }
          settleAsNetwork(err);
        }, stallMs);
        if (typeof stallTimer.unref === 'function') stallTimer.unref();
      };
      resetStall();

      /* `settleAsNetwork` marks the hop as a transport failure so a redirect
         that dies mid-chain is reported as such rather than as the initial
         request's failure. */
      function settleAsNetwork(err) {
        clearTimeout(deadline);
        clearStall();
        /* A leg that already handed over to a redirect (or was already settled)
           must not be able to resolve the outer promise afterwards: the socket
           error of a drained redirect response is not the request's outcome. */
        if (settled) return;
        pushHop({ url: currentUrl, outcome: OUTCOME_NETWORK, status: null, kind: classifyNetworkError(err) });
        finish(networkFailure(err, hops));
      }

      req.on('error', function (err) {
        clearTimeout(deadline);
        clearStall();
        settleAsNetwork(err);
      });

      req.on('response', function (res) {
        const status = Number(res.statusCode) || 0;

        /* 3xx: follow by hand, under our own allowlist. */
        if (status >= 300 && status < 400 && res.headers.location) {
          clearTimeout(deadline);
          clearStall();
          res.resume();
          pushHop({ url: currentUrl, outcome: OUTCOME_RESPONSE, status: status, kind: 'redirect' });
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
        let done = false;
        const bail = function (err) {
          if (done) return;
          done = true;
          clearTimeout(deadline);
          clearStall();
          settleAsNetwork(err);
        };
        const refuse = function (verdict) {
          done = true;
          clearTimeout(deadline);
          clearStall();
          pushHop({ url: currentUrl, outcome: OUTCOME_PROTOCOL, status: status, kind: verdict.kind });
          try { res.destroy(); } catch (e) { }
          finish(protocolFailure(verdict.kind, verdict.message, hops, status));
        };

        res.on('error', bail);

        if (status < 200 || status >= 300) {
          /* 4xx / 5xx including 403/429 rate limiting: a response, so it is a
             hard failure and the other route is NOT tried. The error body is
             drained, never buffered — it is unused, and an error page must not
             be able to fill memory or a .part file. */
          res.on('data', function () { });
          res.on('end', function () {
            if (done) return;
            done = true;
            clearTimeout(deadline);
            clearStall();
            pushHop({ url: currentUrl, outcome: OUTCOME_RESPONSE, status: status, kind: null });
            finish(protocolFailure(status === 403 || status === 429 ? 'rate-limited' : 'http-status',
              'HTTP ' + status + ' from ' + currentUrl, hops, status));
          });
          return;
        }

        /* 2xx: the sink sees the head before any body byte. */
        const head = sink.onResponse ? sink.onResponse(status, res.headers) : null;
        if (head) { refuse(head); return; }

        res.on('data', function (chunk) {
          if (done) return;
          if (stallTimer) resetStall();
          const verdict = sink.onData(chunk);
          if (verdict) refuse(verdict);
        });
        res.on('end', function () {
          if (done) return;
          done = true;
          clearTimeout(deadline);
          clearStall();
          pushHop({ url: currentUrl, outcome: OUTCOME_RESPONSE, status: status, kind: null });
          const verdict = sink.onEnd(status, res.headers);
          if (!verdict || typeof verdict.kind === 'string') {
            finish(protocolFailure((verdict && verdict.kind) || 'sink-failed',
              (verdict && verdict.message) || 'the body sink refused the response', hops, status));
            return;
          }
          finish(responseResult(status, res.headers, verdict.value, currentUrl, hops));
        });
      });

      req.end();
    };

    visit(String(url), maxRedirects);
  });
}

/* Convenience wrapper used by the U2 document path and the U3 metadata fetch:
   GET a small document as text. */
function fetchText(url, options) {
  const o = options || {};
  return fetchTo(url, Object.assign({}, o, { sink: textSink({ maxBytes: o.maxBytes }) }));
}

module.exports = {
  REQUEST_TIMEOUT_MS: REQUEST_TIMEOUT_MS,
  MAX_REDIRECTS: MAX_REDIRECTS,
  MAX_BODY_BYTES: MAX_BODY_BYTES,
  USER_AGENT: USER_AGENT,
  TRANSPORT_DIRECT: TRANSPORT_DIRECT,
  TRANSPORT_API: TRANSPORT_API,
  OUTCOME_RESPONSE: OUTCOME_RESPONSE,
  OUTCOME_NETWORK: OUTCOME_NETWORK,
  OUTCOME_PROTOCOL: OUTCOME_PROTOCOL,
  NETWORK_KINDS: NETWORK_KINDS,
  CODE_TO_KIND: CODE_TO_KIND,
  classifyNetworkError: classifyNetworkError,
  describeError: describeError,
  hostAllowed: hostAllowed,
  fallbackAllowed: fallbackAllowed,
  networkFailure: networkFailure,
  protocolFailure: protocolFailure,
  responseResult: responseResult,
  textSink: textSink,
  decodeBody: decodeBody,
  fetchTo: fetchTo,
  fetchText: fetchText
};
