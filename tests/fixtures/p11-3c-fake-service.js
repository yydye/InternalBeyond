'use strict';

/*
 * P11-3C test fixture: a scriptable stand-in service.
 *
 * A real service cannot be asked to die on cue, and a crash-recovery test that
 * depends on a real service's own timing is a test of the service, not of the
 * supervisor. This script is spawned by the REAL runner through its own spawn
 * path — same process, same exit event, same port, same identity probe — and only
 * its liveness is scripted.
 *
 * It is deliberately NOT a service: it never touches product data, it binds only
 * the port handed to it, and it exits only when told to.
 *
 * Every setting is read from the variable suffixed with THIS instance's name, so
 * ONE environment can drive all three recoverable components at once. The instance
 * is taken from the script's own filename (see COMPONENT below): the runner copies
 * this file to `fakes/<componentId>.js` and spawns that copy.
 *
 * The variable names carry the P11-3C prefix on purpose: they are test-fixture
 * inputs and must never look like product settings.
 *
 * Per component C in {BRIDGE, ACTIVE, HOMENODE}:
 *   IB_P113C_PORT_C        port to bind                    (required)
 *   IB_P113C_HEALTH_C      JSON body served by /health; must carry the identity
 *                          field the registry expects, or the runner would
 *                          (correctly) call the port a conflict instead of healthy
 *   IB_P113C_MARKER_C      path whose existence records "I ran before"
 *   IB_P113C_CRASH_FIRST_C exit non-zero on the first launch only, then serve
 *   IB_P113C_CRASH_EVERY_C exit non-zero on every launch
 *   IB_P113C_CRASH_CODE_C  exit code (default 7; < 128 so the code survives
 *                          Windows process-termination semantics)
 *   IB_P113C_CRASH_AFTER_MS_C  delay before the crash, so the child can own the
 *                          port and look alive first
 *   IB_P113C_NEVER_HEALTHY_C   bind the port and never answer /health
 *   IB_P113C_NEVER_HEALTHY_FIRST_C  wedge only the first launch (so the recovery
 *                          replacement is healthy and the recovery is provable)
 *   IB_P113C_NEVER_LISTEN_C    never bind; stay alive and silent
 *   IB_P113C_LISTEN_AFTER_MS_C bind only after this delay (a live process whose
 *                          port stays silent, i.e. a wedged child)
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

/* Which instance this is. The file's OWN NAME is the selector.
 *
 * All instances share one environment, so nothing in the environment can identify
 * a process: with a shared `IB_P113C_COMPONENT` every instance read the first
 * component's name and two of the three then bound the wrong port while serving
 * the wrong identity. The runner copies this script to one file per component
 * (`fakes/bridge.js`, `fakes/active.js`, …) and spawns that copy, so the name the
 * OS already knows is the identity — and every other setting can then be read from
 * exactly one suffixed variable with no lookup order to get wrong. */
const COMPONENT = path.basename(process.argv[1] || '', '.js').toUpperCase();

/** The value of `name` for THIS instance, or undefined. */
function setting(name) {
  if (!COMPONENT) return undefined;
  const value = process.env['IB_P113C_' + name + '_' + COMPONENT];
  return value === undefined || value === '' ? undefined : value;
}

const port = Number(setting('PORT'));
const marker = setting('MARKER') || '';
const crashCode = Number(setting('CRASH_CODE') || 7);
const crashAfter = Number(setting('CRASH_AFTER_MS') || 0);
const health = setting('HEALTH') || '{}';
const first = marker && !fs.existsSync(marker);
if (marker) {
  try { fs.writeFileSync(marker, String(Date.now())); } catch (e) { /* the test will notice */ }
}

if (setting('NEVER_LISTEN') === '1') {
  setInterval(function () { }, 1000);
} else {
  /* "Wedged on the FIRST launch only": bind the port, accept the connection and
     never answer. That is the failure mode no exit event can report, and the one
     a recovery must be able to fix — so the replacement process has to come back
     HEALTHY, or the test would only ever prove that recovery fires, not that it
     works. */
  const wedged = setting('NEVER_HEALTHY') === '1' ||
    (setting('NEVER_HEALTHY_FIRST') === '1' && first);
  const server = http.createServer(function (req, res) {
    if (wedged) return;
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(health);
      return;
    }
    res.writeHead(404);
    res.end('{}');
  });
  /* A fake service must never die for a reason the test did not script: an
     unhandled EADDRINUSE would be indistinguishable from the crash under test. */
  server.on('error', function () { setInterval(function () { }, 1000); });
  /* Binding later than a real service does is how a "wedged child" is simulated:
     the process is alive from the start while the port stays silent, which is the
     one failure mode no exit event can ever report. */
  const listenAfter = Number(setting('LISTEN_AFTER_MS') || 0);
  if (listenAfter > 0) setTimeout(function () { server.listen(port, '127.0.0.1'); }, listenAfter);
  else server.listen(port, '127.0.0.1');
}

const shouldCrash = setting('CRASH_EVERY') === '1' ||
  (setting('CRASH_FIRST') === '1' && first);
if (shouldCrash) {
  if (crashAfter > 0) setTimeout(function () { process.exit(crashCode); }, crashAfter);
  else process.exit(crashCode);
}
