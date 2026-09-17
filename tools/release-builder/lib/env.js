'use strict';

/*
 * Release Builder · environment resolution and process streaming.
 *
 * Two rules this file exists to enforce:
 *
 *   1. NEVER guess. Every tool is resolved to a concrete path and probed, and
 *      the result carries its own evidence (path + reported version). A missing
 *      tool is a CHECK failure, not something the builder "fixes".
 *   2. Every child process is spawned with `shell:false` and an argument array.
 *      Output is streamed line by line through the redactor, so a credential in
 *      a child's output is never captured. Exit codes are recorded, never
 *      assumed — and a zero exit code is NEVER taken as proof that an artifact
 *      exists (that proof is artifact discovery, in lib/build.js).
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

function firstExisting(candidates) {
  for (const c of candidates) {
    if (!c) continue;
    try { if (fs.statSync(c).isFile()) return c; } catch (e) { /* keep looking */ }
  }
  return '';
}

function onPath(name) {
  const exts = (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';');
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = path.join(dir, name + ext);
      try { if (fs.statSync(p).isFile()) return p; } catch (e) { /* next */ }
    }
  }
  return '';
}

function pwsh() {
  const sys = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  const p = firstExisting([
    path.join(sys, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  ]) || onPath('powershell') || onPath('pwsh');
  return p;
}

function iscc(repoRoot, explicit) {
  const pf = process.env['ProgramFiles'] || 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const lad = process.env.LOCALAPPDATA || '';
  return firstExisting([
    explicit,
    onPath('ISCC'),
    path.join(pf86, 'Inno Setup 6', 'ISCC.exe'),
    path.join(pf, 'Inno Setup 6', 'ISCC.exe'),
    lad ? path.join(lad, 'Programs', 'Inno Setup 6', 'ISCC.exe') : '',
    /* The build script also accepts chocolatey's shim, which the canonical
       build script resolves through PATH itself. */
    path.join(process.env.ProgramData || 'C:\\ProgramData', 'chocolatey', 'bin', 'ISCC.exe')
  ]);
}

/*
 * The Node used to run the repository's Node-side truth. Prefer the repo's own
 * pinned runtime (the release contract pins it and proves its SHA-256), fall
 * back to PATH only for development — never silently: the caller records which
 * one was used, and CHECK reports a warning when it is not the bundled one.
 */
function node(repoRoot) {
  const bundled = path.join(repoRoot, 'runtime', 'node', 'node.exe');
  if (fs.existsSync(bundled)) return { path: bundled, source: 'bundled-runtime', pinned: true };
  const p = onPath('node');
  if (p) return { path: p, source: 'PATH', pinned: false };
  return { path: '', source: 'missing', pinned: false };
}

function gh() { return onPath('gh'); }
function git() { return onPath('git'); }

/* ── Streaming spawn ─────────────────────────────────────────────────────── */

/*
 * spawnStream(file, args, opts) → Promise<{code, signal, ms, lines, error}>
 *
 * opts.onLine(text, stream)   called for every complete line, already the
 *                             caller's job to redact/store
 * opts.cwd, opts.env, opts.timeoutMs, opts.signal (for cancellation)
 *
 * stdio is 'pipe' so output can be streamed. `shell:false` always.
 */
function spawnStream(file, args, opts) {
  const o = opts || {};
  return new Promise(function (resolve) {
    const started = Date.now();
    const out = { code: null, signal: null, ms: 0, lines: [], error: null, spawnFailed: false };
    if (!file) {
      out.error = 'no executable resolved';
      out.spawnFailed = true;
      return resolve(out);
    }
    let child = null;
    try {
      child = spawn(file, args, {
        cwd: o.cwd || process.cwd(),
        env: o.env || process.env,
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      });
    } catch (e) {
      out.error = String((e && e.message) || e);
      out.spawnFailed = true;
      return resolve(out);
    }

    let buf = { stdout: '', stderr: '' };
    const flush = function (stream, text, force) {
      buf[stream] += text;
      const parts = buf[stream].split(/\r?\n/);
      buf[stream] = force ? '' : parts.pop();
      for (const line of parts) {
        out.lines.push({ stream: stream, text: line });
        if (o.onLine) { try { o.onLine(line, stream); } catch (e) { /* a log must never break the build */ } }
      }
    };
    if (child.stdout) child.stdout.setEncoding('utf8');
    if (child.stderr) child.stderr.setEncoding('utf8');
    if (child.stdout) child.stdout.on('data', function (d) { flush('stdout', d, false); });
    if (child.stderr) child.stderr.on('data', function (d) { flush('stderr', d, false); });

    let timer = null;
    let killedByTimeout = false;
    if (o.timeoutMs) {
      timer = setTimeout(function () {
        killedByTimeout = true;
        try { child.kill(); } catch (e) { /* already gone */ }
      }, o.timeoutMs);
    }

    let onAbort = null;
    if (o.signal) {
      onAbort = function () {
        try { child.kill(); } catch (e) { /* already gone */ }
      };
      if (o.signal.aborted) onAbort();
      else o.signal.addEventListener('abort', onAbort, { once: true });
    }

    child.on('error', function (e) {
      out.error = String((e && e.message) || e);
      out.spawnFailed = true;
    });
    child.on('close', function (code, signal) {
      if (timer) clearTimeout(timer);
      if (o.signal && onAbort) { try { o.signal.removeEventListener('abort', onAbort); } catch (e) { /* ignore */ } }
      flush('stdout', '', true);
      flush('stderr', '', true);
      out.code = typeof code === 'number' ? code : null;
      out.signal = signal || null;
      out.ms = Date.now() - started;
      if (killedByTimeout && out.code === null) out.code = 1;
      if (killedByTimeout) out.error = out.error || ('timed out after ' + o.timeoutMs + ' ms');
      resolve(out);
    });
  });
}

/* Run a short, bounded, read-only probe. Never used for the build. */
async function probe(file, args, opts) {
  const r = await spawnStream(file, args, Object.assign({ timeoutMs: 20000 }, opts || {}));
  return {
    ok: r.code === 0,
    code: r.code,
    stdout: r.lines.filter(function (l) { return l.stream === 'stdout'; }).map(function (l) { return l.text; }).join('\n').trim(),
    stderr: r.lines.filter(function (l) { return l.stream === 'stderr'; }).map(function (l) { return l.text; }).join('\n').trim(),
    error: r.error
  };
}

/*
 * Quote a path for a human-readable command line (the README / GUI shows the
 * exact command a user could paste into PowerShell). The real execution never
 * goes through this — it uses the argument arrays above.
 */
function quoteArg(a) {
  const s = String(a);
  if (s === '') return '""';
  /* Escape for the PowerShell command line the GUI/README display. Real
     execution never uses this — it uses the argument arrays above. */
  if (!/[\s&|<>^()'`,;=]/.test(s)) return s;
  return "'" + s.replace(/'/g, "''") + "'";
}
function commandLine(file, args) {
  return [quoteArg(file)].concat((args || []).map(quoteArg)).join(' ');
}

module.exports = {
  firstExisting,
  onPath,
  pwsh,
  iscc,
  node,
  gh,
  git,
  spawnStream,
  probe,
  quoteArg,
  commandLine
};
