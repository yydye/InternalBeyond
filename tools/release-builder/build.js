'use strict';

/*
 * Release Builder · build the tool itself.
 *
 * Produces:
 *   tools/IB-Release-Builder.exe          the double-clickable launcher
 *   tools/release-builder-runtime/        a self-contained copy of the tool
 *                                         (server.js + lib/ + public/)
 *
 * How the EXE is produced, and why this way:
 *   · the launcher is C# compiled by the .NET Framework compiler that ships with
 *     Windows (csc.exe). No Electron, no Tauri, no WebView2, no pkg, no postject,
 *     no npm — the tool adds ZERO runtime dependencies to the repository.
 *   · it starts the repository's OWN pinned Node runtime and the local server,
 *     then opens the system default browser. That is the same architecture the
 *     product itself uses ("Node owns the truth, the browser only renders").
 *   · there is no circular dependency: this project is built by build.js, and it
 *     is never required in order to build InternalBeyond. It only ORCHESTRATES
 *     the existing canonical build.
 *
 * Usage:
 *   node tools/release-builder/build.js            build the EXE + runtime copy
 *   node tools/release-builder/build.js --check    verify it can be built (no writes)
 *
 * The build is idempotent: running it again replaces the EXE and the runtime copy.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const TOOL = path.resolve(__dirname);
const REPO = path.resolve(TOOL, '..', '..');
const OUT_EXE = path.join(REPO, 'tools', 'IB-Release-Builder.exe');
const OUT_RUNTIME = path.join(REPO, 'tools', 'release-builder-runtime');
const SOURCE = path.join(TOOL, 'launcher', 'IB-Release-Builder.cs');

function csc() {
  const win = process.env.WINDIR || process.env.SystemRoot || 'C:\\Windows';
  const candidates = [
    path.join(win, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
    path.join(win, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe')
  ];
  for (const c of candidates) { try { if (fs.statSync(c).isFile()) return c; } catch (e) { /* next */ } }
  return '';
}

function copyRuntime() {
  const targets = [
    { from: path.join(TOOL, 'server.js'), to: path.join(OUT_RUNTIME, 'server.js') },
    { from: path.join(TOOL, 'lib'), to: path.join(OUT_RUNTIME, 'lib') },
    { from: path.join(TOOL, 'public'), to: path.join(OUT_RUNTIME, 'public') }
  ];
  fs.rmSync(OUT_RUNTIME, { recursive: true, force: true });
  for (const t of targets) {
    const st = fs.statSync(t.from);
    if (st.isDirectory()) fs.cpSync(t.from, t.to, { recursive: true });
    else { fs.mkdirSync(path.dirname(t.to), { recursive: true }); fs.copyFileSync(t.from, t.to); }
  }
  return OUT_RUNTIME;
}

function buildLauncher() {
  const compiler = csc();
  if (!compiler) {
    const err = new Error('no .NET Framework C# compiler found (csc.exe)');
    err.code = 'NoCsc';
    throw err;
  }
  fs.mkdirSync(path.dirname(OUT_EXE), { recursive: true });
  const out = execFileSync(compiler, [
    '/nologo', '/target:exe', '/platform:anycpu', '/optimize+',
    '/out:' + OUT_EXE, SOURCE
  ], { encoding: 'utf8', windowsHide: true, timeout: 180000 });
  return { compiler: compiler, output: String(out || '').trim() };
}

function main() {
  const checkOnly = process.argv.indexOf('--check') >= 0;
  console.log('InternalBeyond Release Builder · building the tool');
  console.log('  repo root : ' + REPO);
  console.log('  launcher  : ' + SOURCE);
  console.log('  exe       : ' + OUT_EXE);
  console.log('  runtime   : ' + OUT_RUNTIME);
  console.log('');

  const compiler = csc();
  if (!compiler) {
    console.error('FAIL: csc.exe not found. It ships with the .NET Framework, which Windows 10+ has.');
    console.error('      Looked in %WINDIR%\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe');
    process.exitCode = 1;
    return;
  }
  console.log('  csc       : ' + compiler);

  if (checkOnly) {
    console.log('');
    console.log('  --check: compiler found, nothing was written.');
    process.exitCode = 0;
    return;
  }

  copyRuntime();
  console.log('  runtime copy written');
  const r = buildLauncher();
  const bytes = fs.statSync(OUT_EXE).size;
  console.log('  exe built: ' + bytes + ' bytes');
  console.log('');
  console.log('双击这个文件即可运行：' + OUT_EXE);
  console.log('（它会用仓库内置的 runtime\\node\\node.exe 启动本地服务，并打开系统默认浏览器）');
  process.exitCode = 0;
}

if (require.main === module) main();

module.exports = { buildLauncher, copyRuntime, csc, OUT_EXE, OUT_RUNTIME, SOURCE };
