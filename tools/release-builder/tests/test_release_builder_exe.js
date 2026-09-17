/*
  Release Tooling R1 — EXE smoke test (bounded, headless).

  Proves the self-built launcher (tools/IB-Release-Builder.exe) really works
  end to end, without opening a browser and without leaving a child behind:

    1. the EXE is present and is a real PE image
    2. it finds the BUNDLED repository runtime (runtime\node\node.exe), not PATH
    3. it starts the local server, which reports its own address
    4. IB_RELEASE_NO_BROWSER=1 keeps it a pure server host (browserOpens === 0,
       and the log does not claim otherwise)
    5. the GUI page is served, and the API reports the REAL product version
    6. an /api/* request with no token is refused
    7. killing the EXE leaves no surviving node child (Windows Job Object)

  The suite is offline, installs nothing, runs no release stage, never touches
  dist/, and every wait in it is bounded. Nothing here writes to the repository.
  Our own processes are excluded from the "nothing else is running" check by PID,
  because this suite's command line necessarily contains the tool's path.

  Usage: node tools/release-builder/tests/test_release_builder_exe.js
         node tools/release-builder/tests/test_release_builder_exe.js --allow-running
*/

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..', '..');
const EXE = path.join(REPO, 'tools', 'IB-Release-Builder.exe');
const BUNDLED_NODE = path.join(REPO, 'runtime', 'node', 'node.exe');
const ALLOW_RUNNING = process.argv.indexOf('--allow-running') >= 0;

const EMPTY_TOKEN = '0000000000000000000000000000000000000000000000000000000000000000';

const results = [];
function ok(name, detail) {
  results.push({ name, ok: true, detail });
  console.log('  ok  ' + name + (detail ? '  [' + detail + ']' : ''));
}
function check(name, fn) {
  try {
    fn();
    ok(name);
  } catch (err) {
    results.push({ name, ok: false, detail: err.message });
    console.log('  FAIL ' + name + ' :: ' + err.message);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* Every node.exe whose command line mentions this tool, minus the processes that
   make up THIS test (the driver and the PowerShell probes it spawns). */
function builderNodeCount() {
  const ps = [
    '-NoProfile', '-Command',
    "$me = @($PID) + @(Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | " +
    "Where-Object { $_.CommandLine -like '*test_release_builder_exe*' }).ProcessId; " +
    "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | " +
    "Where-Object { $_.CommandLine -match 'release-builder' -and $me -notcontains $_.ProcessId } | " +
    "ForEach-Object { $_.ProcessId }"
  ];
  const out = spawnSync('powershell.exe', ps, { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  return String(out.stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}

/* curl.exe instead of a Node HTTP client: it is bounded by --max-time, so a
   request can never hang this suite, and it needs no socket teardown care. */
function http(url) {
  const out = spawnSync('curl.exe', [
    '-s', '--max-time', '15', '-o', '-', '-w', '\n%{http_code}', url
  ], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  const text = String(out.stdout || '');
  const cut = text.lastIndexOf('\n');
  const status = Number(text.slice(cut + 1).trim()) || 0;
  return { status, body: text.slice(0, cut) };
}

function readVersion() {
  // The real authority; this test never re-derives a version by itself.
  return require(path.join(REPO, 'runtime', 'product-version.js')).read().version;
}

async function main() {
  console.log('Release Builder — EXE smoke test');
  console.log('  repo: ' + REPO);
  console.log('');

  console.log('[1] the EXE itself');
  if (!fs.existsSync(EXE)) {
    console.log('  --  tools/IB-Release-Builder.exe is not built; run: node tools/release-builder/build.js');
    console.log('');
    console.log('结果: 0 通过, 0 失败 (skipped: launcher not built)');
    return 0;
  }
  const exeBytes = fs.statSync(EXE).size;
  check('the launcher EXE exists and looks like a PE image', () => {
    const head = Buffer.alloc(2);
    const fd = fs.openSync(EXE, 'r');
    fs.readSync(fd, head, 0, 2, 0);
    fs.closeSync(fd);
    assert.strictEqual(head.toString('ascii'), 'MZ', 'missing the MZ signature');
    assert.ok(exeBytes > 4096 && exeBytes < 4 * 1024 * 1024, 'suspicious size: ' + exeBytes + ' bytes');
  });
  check('the bundled repository runtime is present (the EXE must not need system Node)', () => {
    assert.ok(fs.existsSync(BUNDLED_NODE), 'missing ' + BUNDLED_NODE);
  });

  const port = 4390 + Math.floor(Math.random() * 60);
  const before = builderNodeCount();
  check('no other release-builder server is running', () => {
    if (before.length === 0) return;
    assert.ok(ALLOW_RUNNING,
      'found ' + before.length + ' already running (PID ' + before.join(', ') +
      '); pass --allow-running only if you know they are yours');
  });

  console.log('');
  console.log('[2] starting the EXE headless (IB_RELEASE_NO_BROWSER=1, port ' + port + ')');
  const child = spawn(EXE, [], {
    cwd: REPO,
    windowsHide: true,
    env: Object.assign({}, process.env, {
      IB_RELEASE_NO_BROWSER: '1',
      IB_RELEASE_PORT: String(port)
    })
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d.toString('utf8'); });
  child.stderr.on('data', (d) => { stderr += d.toString('utf8'); });
  const exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)));

  let url = null;
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline && url === null) {
    const m = /RELEASE-BUILDER-URL\s+(\S+)/.exec(stdout);
    if (m) { url = m[1]; break; }
    await sleep(200);
  }
  /* The launcher prints the browser line AFTER the URL line, so give the two
     remaining lines a bounded moment to arrive before asserting on them. */
  const quiet = Date.now() + 3000;
  while (Date.now() < quiet && stdout.indexOf('IB_RELEASE_NO_BROWSER=1') === -1) await sleep(100);

  check('the EXE found the bundled runtime, not a PATH node', () => {
    assert.ok(/runtime[\\/]node[\\/]node\.exe/i.test(stdout),
      'the EXE did not report the bundled runtime.\n' + stdout.slice(0, 900));
  });

  check('the local server reported its own address within 25s', () => {
    assert.ok(url, 'no RELEASE-BUILDER-URL line.\nstdout:\n' + stdout.slice(-900) +
      '\nstderr:\n' + stderr.slice(-900));
    assert.ok(/^http:\/\/127\.0\.0\.1:\d+\/\?token=[0-9a-f]{64}$/.test(url),
      'unexpected address shape: ' + url);
    assert.strictEqual(Number(new URL(url).port), port, 'the EXE ignored IB_RELEASE_PORT');
  });

  check('IB_RELEASE_NO_BROWSER=1 kept the EXE a pure server host (browserOpens === 0)', () => {
    assert.ok(stdout.indexOf('[IB_RELEASE_NO_BROWSER=1] 未打开浏览器') !== -1,
      'the headless guard did not fire.\n' + stdout.slice(-500));
    assert.ok(stdout.indexOf('[已用系统默认浏览器打开]') === -1,
      'the EXE claims it opened a browser while headless');
    assert.ok(stdout.indexOf('请在浏览器中打开下面这个地址') !== -1,
      'a headless run must still tell the operator where the tool is');
  });

  check('the EXE never spawned a browser helper', () => {
    /* Only browser processes are listed. The probe's own powershell.exe/cmd.exe
       are deliberately not in this list: counting them would make the suite
       detect itself and report a browser open that never happened. */
    const ps = spawnSync('powershell.exe', [
      '-NoProfile', '-Command',
      "Get-Process chrome,msedge,firefox,iexplore,brave,opera,launcher -ErrorAction SilentlyContinue | " +
      "Where-Object { $_.StartTime -gt (Get-Date).AddSeconds(-90) } | " +
      "ForEach-Object { $_.ProcessName }"
    ], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
    const names = String(ps.stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    assert.strictEqual(names.length, 0,
      'a browser process started during the run: ' + names.join(', '));
  });

  if (url) {
    /* url is 'http://127.0.0.1:PORT/?token=...' — strip the trailing slash as
       well as the query, or every API path below becomes '//api/...' and the
       server would honestly 404 it as a static path. */
    const base = url.replace(/\?.*$/, '').replace(/\/$/, '');
    const token = new URL(url).searchParams.get('token');

    console.log('');
    console.log('[3] talking to the running tool over loopback');
    const page = http(url);
    check('the GUI page is served', () => {
      assert.strictEqual(page.status, 200, 'HTTP ' + page.status);
      assert.ok(/Release Builder/i.test(page.body), 'page did not look like the builder UI');
    });

    check('the GUI page loads its script from an external file and withholds the token', () => {
      assert.ok(/<script[^>]+src="(?:\.\/)?app\.js"/.test(page.body),
        'expected an external app.js script tag');
      assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/i.test(page.body),
        'the page carries an inline script; the boot token must never be inlined into markup');
      assert.ok(page.body.indexOf(token) === -1,
        'the boot token appears in the served markup');

      const js = http(base + '/app.js?token=' + token);
      assert.strictEqual(js.status, 200, 'app.js was not served: HTTP ' + js.status);
      assert.ok(/URLSearchParams\(location\.search\)/.test(js.body),
        'app.js is expected to read the token from its own URL, not from the markup');
    });

    const snap = http(base + '/api/snapshot?token=' + token);
    check('the API answers and reports the REAL product version', () => {
      assert.strictEqual(snap.status, 200, 'HTTP ' + snap.status);
      const json = JSON.parse(snap.body);
      const real = readVersion();
      assert.ok(JSON.stringify(json).indexOf(real) !== -1,
        'the snapshot does not mention the real version ' + real + ': ' + snap.body.slice(0, 400));
    });

    const untokened = http(base + '/api/snapshot');
    check('an /api/* request with no token is refused', () => {
      assert.strictEqual(untokened.status, 403, 'expected 403, got ' + untokened.status);
      assert.ok(!/"version"/.test(untokened.body), 'the refusal leaked the snapshot');
    });

    const wrongToken = http(base + '/api/snapshot?token=' + EMPTY_TOKEN);
    check('a wrong token is refused exactly like a missing one', () => {
      assert.strictEqual(wrongToken.status, 403, 'expected 403, got ' + wrongToken.status);
    });

    const traversal = http(base + '/../VERSION?token=' + token);
    check('the file host cannot escape public/ (no path traversal)', () => {
      assert.ok(traversal.status === 400 || traversal.status === 404 ||
        traversal.body.indexOf('VERSION') === -1,
        'a traversal attempt returned HTTP ' + traversal.status + ': ' + traversal.body.slice(0, 120));
    });
  }

  console.log('');
  console.log('[4] shutdown hygiene');
  child.kill();
  const code = await Promise.race([exited, sleep(10000).then(() => 'timeout')]);
  check('the EXE exits when asked', () => {
    assert.notStrictEqual(code, 'timeout', 'the EXE did not exit within 10s');
  });

  let survivors = [];
  for (let i = 0; i < 20; i++) {
    await sleep(500);
    survivors = builderNodeCount();
    if (survivors.length === 0) break;
  }
  check('no node child survives the EXE (Windows Job Object)', () => {
    assert.strictEqual(survivors.length, 0,
      survivors.length + ' release-builder node process(es) still alive: ' + survivors.join(', '));
  });

  const failed = results.filter((r) => !r.ok);
  console.log('');
  console.log('结果: ' + (results.length - failed.length) + ' 通过, ' + failed.length + ' 失败');
  if (failed.length) {
    for (const f of failed) console.log('  - ' + f.name + ' :: ' + f.detail);
    return 1;
  }
  return 0;
}

main().then((code) => process.exit(code)).catch((err) => {
  console.error('harness error: ' + ((err && err.stack) || err));
  process.exit(1);
});
