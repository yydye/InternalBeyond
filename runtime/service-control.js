'use strict';

/*
 * Internal Beyond · cooperative stop surface for one product component
 *
 * ── Why this exists (P11-3H) ──────────────────────────────────────────────
 *
 * Until P11-3H the only stop mechanism the product had was a signal, and on
 * Windows a signal is not a message. Measured (P11-3H Phase 1, real
 * `services/home-node-service.js`, private port, private data dir):
 *
 *     process.kill(child.pid, 'SIGTERM')  →  the process is gone in 0ms
 *     data directory                      →  home-node.db-wal still holds 440 KB
 *     stdout                              →  no `{"event":"shutdown"}` line
 *
 * `child.kill('SIGTERM')` in Node on Windows is TerminateProcess: the OS ends
 * the process and the service's own `process.on('SIGTERM')` handler NEVER runs.
 * The port is released and SQLite recovers from the WAL, so nothing is lost —
 * but the graceful close (gateway.stop → derivation.stop → understandingStore
 * → momentsStore → registry → memoryStore → chat store) is skipped entirely,
 * and "did this component stop cleanly?" stops being answerable.
 *
 * So there has to be a stop *message*, not a stop *signal*. It travels over the
 * component's own loopback HTTP port — the channel that already exists between
 * the runner, the installer's `tools/ib-stop.js` and every service. One new
 * endpoint, defined ONCE here, mounted by every component:
 *
 *     POST /__shutdown   →  202 { ok, stopping, service, pid }
 *
 * ── What this module is, and is not ───────────────────────────────────────
 *
 *   IS   the admission rule for that endpoint and the one ordered teardown
 *        ladder (`runStop`) that endpoint bodies are written with.
 *   IS NOT an authentication boundary, and does not pretend to be one. Like
 *        `services/internal-beyond-server.js` since P7, it guards against a
 *        BROWSER page on a foreign origin — which is what an `Origin` check can
 *        actually decide. The services are loopback-bound, so a local process
 *        that wants to stop one can already do so; that was true of
 *        `POST /__shutdown` before this phase, and this module does not quietly
 *        upgrade the claim. P11-3A's rule — credential MINTING requires a
 *        configured desktop token — is untouched: stopping a process mints
 *        nothing and reveals nothing.
 *   IS NOT a second control plane. No new server, no new port, no new
 *        protocol, no state that outlives the process being stopped.
 */

/* The path, as a value, so nothing has to spell it twice. */
const STOP_PATH = '/__shutdown';

/* Loopback origins, file:// pages and local callers (no Origin). The same rule
   as `services/internal-beyond-server.js` since P7 — deliberately the same, not
   re-derived: a browser page on a foreign origin must not be able to stop the
   product, and anything stricter would break the installer's own helper. */
function originAllowed(req) {
  const origin = String((req && req.headers && req.headers.origin) || '').trim();
  if (!origin) return true;
  if (origin === 'null') return true;
  try {
    const u = new URL(origin);
    if (u.protocol === 'file:') return true;
    if (u.protocol === 'http:' || u.protocol === 'https:') {
      const host = String(u.hostname).toLowerCase();
      if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]') return true;
    }
  } catch (e) { /* illegal origin → deny */ }
  return false;
}

/*
 * The one admission rule. Returns null when the request may stop this process,
 * or { status, error } when it may not.
 *
 *   method-not-allowed — a GET is a probe (or a link preview), not a stop
 *   origin-denied      — a page on another origin must not stop the product
 */
function refuseStop(req) {
  if (!req || String(req.method || '').toUpperCase() !== 'POST') {
    return { status: 405, error: 'method-not-allowed' };
  }
  if (!originAllowed(req)) return { status: 403, error: 'origin-denied' };
  return null;
}

/* The body a component sends BEFORE it starts tearing down. It carries the
   caller's last chance to notice it is talking to the wrong process: the
   service name it declares, and the pid that answered. */
function acceptedBody(service, extra) {
  return Object.assign({
    ok: true,
    stopping: true,
    phase: 'stopping',
    service: String(service || ''),
    pid: process.pid
  }, extra || {});
}

/*
 * The one ordered teardown ladder (the P11-3H stop contract).
 *
 * Every step is attempted, in this order, and every step is independently
 * guarded: a teardown that throws must not skip the steps after it. That is not
 * defensive decoration — the whole point of a cooperative stop is that the
 * durable stores get closed, and an exception in an earlier, less important
 * step is exactly how that would silently stop happening.
 *
 *   1. entering     — the component knows it is stopping (make it idempotent)
 *   2. stopWork     — stop accepting new work (drain / abort in-flight)
 *   3. closeHandles — close HTTP / WebSocket / sockets / child processes
 *   4. stopTimers   — clear intervals, timers, watchers, schedulers
 *   5. closeStores  — close the canonical SQLite stores
 *   6. report       — the caller's chance to record "stopped"
 *
 * Every step is optional; a component with nothing to do at a step omits it.
 * `steps` in the result says which ones actually ran, so a test can assert the
 * ladder instead of trusting a log line.
 *
 * Deliberately NOT here: no WAL checkpoint, no `PRAGMA` change, no sleep used
 * to "give the data time", and no change to durability settings. Measured
 * (P11-3H Phase 6): `db.close()` is already a clean SQLite close, the WAL is
 * folded back on the next open, and the data round-trips. A checkpoint would be
 * inventing durability work the wrapper does not need.
 */
async function runStop(name, steps) {
  const s = steps || {};
  const done = [];
  const errors = [];
  const attempt = async function (label, fn) {
    if (typeof fn !== 'function' || done.indexOf(label) >= 0) return;
    try {
      await fn();
      done.push(label);
    } catch (e) {
      errors.push({ step: label, error: String((e && e.message) || e).slice(0, 240) });
    }
  };
  await attempt('entering', s.entering);
  await attempt('stopWork', s.stopWork);
  await attempt('closeHandles', s.closeHandles);
  await attempt('stopTimers', s.stopTimers);
  await attempt('closeStores', s.closeStores);
  await attempt('report', s.report);
  return { name: String(name || ''), steps: done, errors: errors };
}

/*
 * ── Why the stop decision is NOT a second `'request'` listener ────────────
 *
 * The obvious way to add one path to a server whose handler was built inside
 * someone else's factory is `server.on('request', ...)`. It does not work, and
 * the failure is silent in the worst way. Measured (this phase, isolated probe):
 *
 *     http.createServer(handlerA);           // listener 1
 *     server.on('request', listenerB);       // listener 2
 *     POST /__shutdown
 *       → [A] runs, answers 404, headersSent=true
 *       → [B] runs, sees res.headersSent === true, stays silent
 *       → the component answers 404 to its own stop request
 *
 * Node emits 'request' to every listener synchronously in the same tick, in
 * registration order. A listener registered second therefore always runs AFTER
 * the first one has already answered; a `headersSent` guard does not make it
 * win, it only stops it from throwing ERR_HTTP_HEADERS_SENT. The earlier
 * version of this module did exactly that and the result on a real Bridge was
 * `404 {"error":"未找到接口：POST /__shutdown"}` followed by a fallback kill.
 *
 * So the decision has to happen INSIDE the component's own dispatch, before it
 * resolves the path. `createStopDispatch` is that hook: one function, called
 * first by each component's handler, in this module's own order of operations.
 *
 *   · 202 — accepted; the caller may stop it. NOT 204/200: this is "accepted",
 *     and the status is the caller's first confirmation that the process on the
 *     port is the one that will go away.
 *   · `fail(status, error, body)` — the caller answers the refusal. The component
 *     maps that onto its own response shape (`bad(res, 403, 'origin-denied')` for
 *     Home Node, `json(res, 405, {...})` for the companion server), so a refusal
 *     keeps the service's existing error contract instead of inventing one. The
 *     error code is also returned, for a component that answers it itself.
 *   · `true` — accepted (this module already sent the 202).
 *   · `'already-stopping'` — a repeated stop; answered 202 with `already:true`.
 *   · `'origin-denied'` / `'method-not-allowed'` — refused, the caller answers.
 *   · `undefined` — not the stop path at all; keep dispatching.
 *
 * `onAccepted` runs once, only on the first accepted request: the component's
 * chance to record the stop. A repeated request gets `already:true` and does
 * NOT run it again — stopping twice must be a no-op, not two teardowns.
 *
 * ── The response is sent BEFORE anything is torn down ────────────────────
 *
 * `stop` (and the bounded close+exit after it) is started only after the 202 is
 * on the wire, and it is deliberately NOT awaited by the caller's dispatch: a
 * component that closed its store first would answer into a socket the caller
 * has already given up on, and a component that blocked its own request
 * handler would never deliver the confirmation at all. This is the one place
 * where fire-and-forget is the correct shape.
 *
 * ── The exit is the COMPONENT's, not this module's ───────────────────────
 *
 * `createStopDispatch` never decides how a process ends. `server` and `exit`
 * are optional and go straight through to `finishBounded`; without them the
 * dispatch still answers and still tears down, and the process ends the way its
 * own code ends it. That matters for correctness, not just for tests: a
 * component whose teardown legitimately did not finish must be able to be the
 * thing that decides what to do about it, instead of having an exit imposed on
 * it from a transport helper.
 */
function createStopDispatch(opts) {
  const o = opts || {};
  const service = String(o.service || 'internal-beyond-service');
  const exposeBody = o.exposeBody !== false;
  let state = 'running';
  let acceptedAt = 0;

  const dispatchStop = function (req, res, fail) {
    const pathname = String((req && req.url) || '/').split('?')[0];
    if (pathname !== STOP_PATH) return undefined;
    const refusal = refuseStop(req);
    if (refusal) {
      /* The caller answers the refusal, so it keeps its own error contract. The
         code is returned as well, for a caller that wants to map it itself
         (`/__shutdown` has answered `405 method-not-allowed` /
         `403 origin-denied` since P7 and its callers depend on those names). */
      if (typeof fail === 'function') fail(refusal.status, refusal.error, { service: service });
      else {
        try {
          res.writeHead(refusal.status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
          res.end(JSON.stringify({ ok: false, error: refusal.error, service: service }));
        } catch (e) { /* the caller has gone away */ }
      }
      return refusal.error;
    }
    if (state === 'stopping') {
      try {
        res.writeHead(202, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(acceptedBody(service, { already: true, acceptedAt: acceptedAt })));
      } catch (e) { /* the caller has gone away */ }
      return 'already-stopping';
    }
    state = 'stopping';
    acceptedAt = Date.now();
    if (exposeBody) {
      try {
        res.writeHead(202, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(acceptedBody(service)));
      } catch (e) { /* the caller has gone away */ }
    }
    if (typeof o.onAccepted === 'function') {
      try { o.onAccepted({ service: service, pid: process.pid, at: acceptedAt }); } catch (e) { /* 诊断不得阻断停止 */ }
    }
    /* Now — and only now — the teardown. Not awaited: see the note above. */
    Promise.resolve()
      .then(function () { return typeof o.stop === 'function' ? o.stop({ signal: 'http', at: acceptedAt }) : null; })
      .then(function (result) {
        dispatchStop.teardown = result || null;
        if (typeof o.onStopped === 'function') {
          try { o.onStopped(result || null); } catch (e) { /* 诊断不得阻断停止 */ }
        }
      })
      .catch(function (e) {
        /* A teardown that threw is the one case worth recording loudly: the
           component is about to exit, and this line is what says why. */
        dispatchStop.teardownError = String((e && e.message) || e).slice(0, 300);
        try { console.error('[' + service + '] stop teardown failed: ' + dispatchStop.teardownError); } catch (e2) { /* ignore */ }
      })
      .then(function () { finishBounded(o.server, { drainMs: o.drainMs, exit: o.exit }); });
    return true;
  };
  dispatchStop.state = function () { return state; };
  dispatchStop.acceptedAt = function () { return acceptedAt; };
  dispatchStop.teardown = null;
  dispatchStop.teardownError = null;
  return dispatchStop;
}

/*
 * The end of a cooperative stop: close the listener, then exit — bounded, and
 * idempotent.
 *
 * `server.close()`'s callback only fires once every connection has ended, and a
 * keep-alive connection that nobody is going to close would hold a stopped
 * component open while the installer waits to replace its files. So the drain
 * is bounded by `drainMs`, and `exit` is called exactly once by whichever of
 * the two paths gets there first.
 *
 * This is the ONLY place a component exits, shared by its HTTP stop path and
 * its signal path, so "the process ended" means the same thing on both.
 */
function finishBounded(serverOrGetter, opts) {
  const o = opts || {};
  const drainMs = Number(o.drainMs) > 0 ? Number(o.drainMs) : 2000;
  /* The listener may be supplied directly or through a getter. A getter is not
     a convenience: a component's dispatch object can be constructed before its
     `server` binding is initialized (the http layer needs the dispatch at
     construction time), and asking for the listener only when a stop actually
     arrives is what keeps that ordering honest instead of turning it into a
     temporal-dead-zone crash at startup. */
  const server = typeof serverOrGetter === 'function' ? serverOrGetter() : serverOrGetter;
  /* No listener, no ending. A caller that supplies neither is saying "this
     teardown does not end the process" — which is what a stop path whose
     component owns its own lifetime means. Exiting here would make "did the
     teardown finish?" unobservable from the outside. */
  if (!server || typeof server.close !== 'function') return;
  const doExit = typeof o.exit === 'function' ? o.exit : function (code) { process.exit(code); };
  let exited = false;
  const exit = function (code) {
    if (exited) return;
    exited = true;
    try { doExit(code); } catch (e) { /* the caller refused to exit → do not retry */ }
  };
  try {
    server.close(function () { exit(0); });
  } catch (e) { exit(0); return; }
  /* A caller's idle keep-alive socket counts as an open connection, so
     `server.close()` would never call back and the process would sit there until
     a fallback kill. Bounded: after `lingerMs` the sockets are closed and the
     next tick exits, since the response has long since been delivered. */
  const lingerMs = Number(o.lingerMs) > 0 ? Number(o.lingerMs) : 300;
  const closeSockets = setTimeout(function () {
    try {
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    } catch (e) { /* nothing left to close */ }
    exit(0);
  }, lingerMs);
  if (typeof closeSockets.unref === 'function') closeSockets.unref();
  const guard = setTimeout(function () { exit(0); }, drainMs);
  if (typeof guard.unref === 'function') guard.unref();
}

/*
 * Close a listener as part of a cooperative stop: stop accepting, then bound how
 * long any already-open socket may keep the process alive.
 *
 * Without the second half a component is stopped but not gone. Measured on a
 * real Bridge during this phase: the stop was accepted (202), the teardown ran,
 * and `server.close()` still never called back — the caller's own idle
 * keep-alive socket counts as an open connection, so the process sat there
 * until the fallback kill arrived.
 *
 * `closeAllConnections` is only reached AFTER a short grace period, so the 202
 * this stop just sent has time to reach the caller; a true hard stop would risk
 * destroying the socket the confirmation is still travelling on.
 */
function closeListenerBounded(server, opts) {
  const o = opts || {};
  const graceMs = Number(o.graceMs) > 0 ? Number(o.graceMs) : 250;
  if (!server || typeof server.close !== 'function') return;
  try { server.close(); } catch (e) { /* already closed */ }
  const timer = setTimeout(function () {
    try {
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      else if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections();
    } catch (e) { /* nothing left to close */ }
  }, graceMs);
  if (typeof timer.unref === 'function') timer.unref();
}

module.exports = {
  STOP_PATH: STOP_PATH,
  originAllowed: originAllowed,
  refuseStop: refuseStop,
  acceptedBody: acceptedBody,
  runStop: runStop,
  createStopDispatch: createStopDispatch,
  closeListenerBounded: closeListenerBounded,
  finishBounded: finishBounded
};
