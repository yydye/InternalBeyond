'use strict';

const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const MINIMUM_BUILD_FREE_BYTES = 8 * 1024 * 1024 * 1024;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const REQUIRED_FILES = Object.freeze([
  'VERSION',
  'scripts/build-installer.ps1',
  'scripts/stage-tauri-host.ps1',
  'scripts/release-manifest.js',
  'scripts/release-audit.js',
  'src-tauri/Cargo.toml',
  'src-tauri/Cargo.lock',
  'src-tauri/build.rs',
  'src-tauri/tauri.conf.json',
  'installer/InternalBeyond.iss',
  'installer/languages/ChineseSimplified.isl',
  'installer/tools/ib-stop.js',
  'installer/runtime-pin.json',
  'LICENSE',
  'LICENSES/THIRD-PARTY-NODE.md',
  'runtime/update-manifest.js',
  'runtime/node/VERSION',
  'runtime/node/node.exe'
]);
const REQUIRED_DIRECTORIES = Object.freeze([
  'src-tauri/src',
  'src-tauri/icons',
  'src-tauri/capabilities'
]);
const CHILD_ENVIRONMENT_KEYS = Object.freeze([
  'PATH', 'PATHEXT', 'PSModulePath', 'SystemRoot', 'windir', 'SystemDrive', 'TEMP', 'TMP',
  'ProgramData', 'ProgramFiles', 'ProgramFiles(x86)', 'LOCALAPPDATA',
  'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'ComSpec', 'RUSTUP_HOME', 'CARGO_HOME'
]);

function createBuildEnvironment(source) {
  const input = source || process.env;
  const env = {};
  for (const key of CHILD_ENVIRONMENT_KEYS) {
    if (Object.prototype.hasOwnProperty.call(input, key)) env[key] = input[key];
  }
  env.GIT_OPTIONAL_LOCKS = '0';
  return env;
}

function check(name, status, message, required) {
  return Object.freeze({ name: name, status: status, message: message, required: required !== false });
}

function findExecutable(name, platform, env) {
  const pathValue = String(env.PATH || '');
  const directories = pathValue.split(path.delimiter).filter(Boolean);
  let extensions = [''];
  if (platform === 'win32') {
    const pathext = String(env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean);
    extensions = path.extname(name) ? [''] : [''].concat(pathext);
  }
  for (const directory of directories) {
    for (const extension of extensions) {
      const candidate = path.join(directory, name + extension);
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch (_) { /* A missing PATH entry is ordinary. */ }
    }
  }
  return null;
}

function findInnoExecutable(platform, env) {
  const onPath = findExecutable('ISCC.exe', platform, env) || findExecutable('ISCC', platform, env);
  if (onPath) return onPath;
  if (platform !== 'win32') return null;
  const roots = [
    env['ProgramFiles(x86)'],
    env.ProgramFiles,
    env.LOCALAPPDATA
  ].filter(Boolean);
  for (const root of roots) {
    const suffix = root === env.LOCALAPPDATA ? 'Programs' : '';
    const candidate = path.join(root, suffix, 'Inno Setup 6', 'ISCC.exe');
    try { if (fs.statSync(candidate).isFile()) return candidate; } catch (_) { /* Continue. */ }
  }
  return null;
}

function runCommand(file, args, cwd) {
  try {
    const env = createBuildEnvironment();
    const result = childProcess.spawnSync(file, args, {
      cwd: cwd,
      env: env,
      encoding: 'utf8',
      timeout: 5000,
      maxBuffer: 256 * 1024,
      windowsHide: true
    });
    return {
      status: result.status === null ? 1 : result.status,
      stdout: String(result.stdout || '').trim(),
      stderr: String(result.stderr || '').trim(),
      failedToStart: !!result.error
    };
  } catch (_) {
    return { status: 1, stdout: '', stderr: '', failedToStart: true };
  }
}

function defaultGitState(root, gitPath, adapters) {
  const revisionResult = adapters.runCommand(gitPath, ['-C', root, 'rev-parse', 'HEAD'], root);
  if (!revisionResult || revisionResult.status !== 0) return { ok: false, revision: null, dirty: null };
  const revision = String(revisionResult.stdout || '').trim();
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(revision)) {
    return { ok: false, revision: null, dirty: null };
  }
  const statusResult = adapters.runCommand(gitPath,
    ['-C', root, 'status', '--porcelain=v1', '--untracked-files=normal'], root);
  if (!statusResult || statusResult.status !== 0) return { ok: false, revision: revision, dirty: null };
  return { ok: true, revision: revision.toLowerCase(), dirty: String(statusResult.stdout || '').length > 0 };
}

function resolveCanonicalPayload(root) {
  const manifestPath = path.join(root, 'scripts', 'release-manifest.js');
  const manifest = require(manifestPath);
  if (!manifest || typeof manifest.resolve !== 'function') throw new Error('manifest resolver unavailable');
  return manifest.resolve({ root: root });
}

function defaultWebView2Installed(platform, env, adapters) {
  if (platform !== 'win32') return null;
  const reg = adapters.findExecutable('reg.exe');
  if (!reg) return null;
  const guid = '{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}';
  const keys = [
    'HKCU\\Software\\Microsoft\\EdgeUpdate\\Clients\\' + guid,
    'HKLM\\Software\\Microsoft\\EdgeUpdate\\Clients\\' + guid,
    'HKLM\\Software\\WOW6432Node\\Microsoft\\EdgeUpdate\\Clients\\' + guid
  ];
  for (const key of keys) {
    const result = adapters.runCommand(reg, ['query', key, '/v', 'pv'], process.cwd());
    if (result && result.status === 0) return true;
  }
  return false;
}

function existingAncestor(directory) {
  let current = path.resolve(directory);
  for (;;) {
    try {
      const stat = fs.statSync(current);
      if (stat.isDirectory()) return current;
      return null;
    } catch (_) {
      const parent = path.dirname(current);
      if (parent === current) return null;
      current = parent;
    }
  }
}

function makeDefaultAdapters(platform, env) {
  const adapters = {
    findExecutable: function (name) {
      if (name === 'ISCC.exe') return findInnoExecutable(platform, env);
      if (name === 'powershell.exe' && platform === 'win32') {
        const onPath = findExecutable(name, platform, env);
        if (onPath) return onPath;
        const windowsRoot = env.SystemRoot || env.windir || 'C:\\Windows';
        const candidate = path.join(windowsRoot, 'System32', 'WindowsPowerShell', 'v1.0', name);
        try { if (fs.statSync(candidate).isFile()) return candidate; } catch (_) { return null; }
        return null;
      }
      return findExecutable(name, platform, env);
    },
    runCommand: runCommand,
    getGitState: function (root, gitPath, api) { return defaultGitState(root, gitPath, api); },
    resolvePayload: resolveCanonicalPayload,
    isWritable: function (directory) {
      try { fs.accessSync(directory, fs.constants.W_OK); return true; } catch (_) { return false; }
    },
    getFreeBytes: function (directory) {
      if (typeof fs.statfsSync !== 'function') return null;
      try {
        const stat = fs.statfsSync(directory);
        return Number(stat.bavail) * Number(stat.bsize);
      } catch (_) { return null; }
    },
    isWebView2Installed: function () {
      return defaultWebView2Installed(platform, env, this);
    }
  };
  return adapters;
}

function inspectDirectory(directory, name, adapters) {
  const target = path.resolve(directory);
  let exists = false;
  try {
    const stat = fs.statSync(target);
    exists = true;
    if (!stat.isDirectory()) return check(name, 'FAIL', 'Expected a directory; no files were changed.', true);
  } catch (_) { /* It may be created by the canonical build later. */ }
  const probeDirectory = exists ? target : existingAncestor(target);
  if (!probeDirectory) return check(name, 'FAIL', 'No existing parent directory could be inspected.', true);
  const writable = adapters.isWritable(probeDirectory);
  if (!writable) return check(name, 'FAIL', 'The target directory or its nearest existing parent is not writable.', true);
  if (!exists) return check(name, 'WARN', 'The target directory does not exist yet; its existing parent appears writable. No write probe was created.', true);
  return check(name, 'PASS', 'The existing directory appears writable by metadata check; no write probe was created.', true);
}

function inspectDisk(directory, name, minimumBytes, adapters) {
  const probeDirectory = existingAncestor(directory);
  if (!probeDirectory) return check(name, 'WARN', 'Free space could not be measured for this target.', true);
  const bytes = adapters.getFreeBytes(probeDirectory);
  if (!Number.isFinite(bytes) || bytes < 0) {
    return check(name, 'WARN', 'Free space could not be measured for this target.', true);
  }
  if (bytes < minimumBytes) {
    return check(name, 'FAIL', 'Free space is below the configured build threshold (' + Math.floor(bytes / (1024 * 1024 * 1024)) + ' GiB available).', true);
  }
  return check(name, 'PASS', 'Free space meets the configured build threshold (' + Math.floor(bytes / (1024 * 1024 * 1024)) + ' GiB available).', true);
}

function inspectEnvironment(options) {
  const o = options || {};
  const root = path.resolve(o.root || path.resolve(__dirname, '..', '..'));
  const platform = o.platform || process.platform;
  const env = o.env || process.env;
  const target = o.target || 'windows-installer';
  const mode = o.mode || 'release';
  const minimumFreeBytes = Number.isFinite(o.minimumFreeBytes) && o.minimumFreeBytes >= 0
    ? o.minimumFreeBytes : MINIMUM_BUILD_FREE_BYTES;
  const adapters = Object.assign(makeDefaultAdapters(platform, env), o.adapters || {});
  const checks = [];
  let repository = { revision: null, dirty: null };

  if (target !== 'windows-installer') {
    checks.push(check('target', 'FAIL', 'Only windows-installer is enabled in this phase.', true));
    return { ready: false, target: target, repository: repository, checks: checks };
  }

  if (platform !== 'win32') {
    checks.push(check('operating-system', 'FAIL', 'The current installer pipeline is Windows-only.', true));
  } else {
    checks.push(check('operating-system', 'PASS', 'Windows host detected.', true));
  }

  const nodeProbe = adapters.runCommand(process.execPath, ['--version'], root);
  checks.push(nodeProbe && nodeProbe.status === 0
    ? check('node', 'PASS', 'Packaging Control Plane Node runtime ' + (nodeProbe.stdout || process.version).slice(0, 80) + '.', true)
    : check('node', 'FAIL', 'The Node runtime hosting the control plane did not pass its version probe.', true));

  const npmPath = adapters.findExecutable('npm');
  if (!npmPath) {
    checks.push(check('npm', 'WARN', 'npm was not found; the current canonical installer path has no root package.json and does not require npm.', false));
  } else {
    checks.push(check('npm', 'PASS', 'npm is available but optional for the current installer target; no npm command was run.', false));
  }

  for (const tool of [
    { id: 'rustc', executable: 'rustc', args: ['--version'], label: 'Rust compiler' },
    { id: 'cargo', executable: 'cargo', args: ['--version'], label: 'Cargo' }
  ]) {
    const executable = adapters.findExecutable(tool.executable);
    if (!executable) {
      checks.push(check(tool.id, 'FAIL', tool.label + ' is required for the canonical Tauri Host build.', true));
      continue;
    }
    const result = adapters.runCommand(executable, tool.args, root);
    checks.push(result && result.status === 0
      ? check(tool.id, 'PASS', tool.label + ' version probe passed.', true)
      : check(tool.id, 'FAIL', tool.label + ' was found but its version probe failed.', true));
  }

  const tauriCli = adapters.findExecutable('cargo-tauri');
  checks.push(tauriCli
    ? check('tauri-cli', 'PASS', 'Tauri CLI is present for separate acceptance builds; it is not required by the Inno production path.', false)
    : check('tauri-cli', 'WARN', 'Tauri CLI is not required by the Inno production path; Host staging uses locked Cargo directly.', false));

  const powershell = adapters.findExecutable('powershell.exe');
  if (!powershell) {
    checks.push(check('powershell', 'FAIL', 'Windows PowerShell is required by the canonical installer script.', true));
  } else {
    const psProbe = adapters.runCommand(powershell,
      ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()'], root);
    const psVersion = psProbe && /^(\d+)\.(\d+)/.exec(String(psProbe.stdout || '').trim());
    checks.push(psProbe && psProbe.status === 0 && psVersion &&
      (Number(psVersion[1]) > 5 || (Number(psVersion[1]) === 5 && Number(psVersion[2]) >= 1))
      ? check('powershell', 'PASS', 'Windows PowerShell 5.1 or later is available.', true)
      : check('powershell', 'FAIL', 'Windows PowerShell 5.1 or later is required.', true));
  }

  const iscc = adapters.findExecutable('ISCC.exe');
  checks.push(iscc
    ? check('inno-setup', 'PASS', 'Inno Setup ISCC.exe was found for the existing installer authority.', true)
    : check('inno-setup', 'FAIL', 'Inno Setup ISCC.exe is required by the canonical installer pipeline.', true));

  const webview = adapters.isWebView2Installed();
  checks.push(webview === true
    ? check('webview2', 'PASS', 'WebView2 is installed in this validation environment.', false)
    : check('webview2', 'WARN', webview === false
      ? 'WebView2 was not detected; the installer has its own bootstrap policy, so this does not block artifact compilation.'
      : 'WebView2 status could not be read; this does not block artifact compilation.', false));

  const missingFiles = [];
  for (const relative of REQUIRED_FILES) {
    try { if (!fs.statSync(path.join(root, relative)).isFile()) missingFiles.push(relative); }
    catch (_) { missingFiles.push(relative); }
  }
  for (const relative of REQUIRED_DIRECTORIES) {
    try { if (!fs.statSync(path.join(root, relative)).isDirectory()) missingFiles.push(relative); }
    catch (_) { missingFiles.push(relative); }
  }
  checks.push(missingFiles.length === 0
    ? check('required-files', 'PASS', 'All canonical build scripts, Host inputs, installer files and bundled Node metadata are present.', true)
    : check('required-files', 'FAIL', 'Required canonical build files are missing (' + missingFiles.length + ').', true));

  let version = '';
  let pin = null;
  let cargoVersion = '';
  let runtimeVersion = '';
  try { version = fs.readFileSync(path.join(root, 'VERSION'), 'utf8').trim(); } catch (_) { /* reported below */ }
  try { pin = JSON.parse(fs.readFileSync(path.join(root, 'installer', 'runtime-pin.json'), 'utf8')); } catch (_) { pin = null; }
  try { runtimeVersion = fs.readFileSync(path.join(root, 'runtime', 'node', 'VERSION'), 'utf8').trim(); } catch (_) { /* reported below */ }
  try {
    const cargoToml = fs.readFileSync(path.join(root, 'src-tauri', 'Cargo.toml'), 'utf8');
    const match = /^version\s*=\s*"([^"]+)"/m.exec(cargoToml);
    cargoVersion = match ? match[1] : '';
  } catch (_) { /* reported below */ }
  const pinnedRuntimeVersion = pin && pin.runtime && String(pin.runtime.version || '');
  const versionsValid = SEMVER.test(version) && cargoVersion === version &&
    runtimeVersion === pinnedRuntimeVersion && SEMVER.test(runtimeVersion);
  checks.push(versionsValid
    ? check('version-metadata', 'PASS', 'VERSION, Tauri Cargo metadata and bundled Node version pin are consistent.', true)
    : check('version-metadata', 'FAIL', 'VERSION, Tauri Cargo metadata or bundled Node version pin is missing or inconsistent.', true));

  let payload;
  try { payload = adapters.resolvePayload(root); } catch (_) { payload = null; }
  checks.push(payload && payload.ok === true
    ? check('payload-closure', 'PASS', 'The canonical release-manifest resolver found a complete, non-denied payload closure.', true)
    : check('payload-closure', 'FAIL', 'The canonical release-manifest resolver reported missing/denied inputs or could not run.', true));

  const gitPath = adapters.findExecutable('git');
  if (!gitPath) {
    checks.push(check('git-revision', 'FAIL', 'Git is required to identify the source revision.', true));
  } else {
    const git = adapters.getGitState(root, gitPath, adapters);
    if (!git || git.ok !== true || !git.revision) {
      checks.push(check('git-revision', 'FAIL', 'The current Git revision could not be read.', true));
      checks.push(check('git-cleanliness', 'WARN', 'Dirty state could not be determined.', false));
    } else {
      repository = { revision: git.revision, dirty: git.dirty === true };
      checks.push(check('git-revision', 'PASS', 'Source revision ' + git.revision + '.', true));
      checks.push(git.dirty
        ? check('git-cleanliness', 'WARN', 'The worktree has changes; they are recorded as dirty and do not by themselves fail preflight.', false)
        : check('git-cleanliness', 'PASS', 'The Git worktree is clean.', false));
    }
  }

  const outputDir = o.outputDir || path.join(root, 'dist');
  const temporaryDir = o.temporaryDir || os.tmpdir();
  const programData = env.ProgramData || path.dirname(root);
  const hostBuildDir = o.hostBuildDir || path.join(programData, 'InternalBeyond', 'host-build');
  const selectedOutput = mode === 'test'
    ? (o.testOutputDir || path.join(root, 'tmp', 'installer-smoke-build'))
    : outputDir;
  checks.push(inspectDirectory(selectedOutput, 'output-writable', adapters));
  checks.push(inspectDirectory(temporaryDir, 'temporary-writable', adapters));
  checks.push(inspectDirectory(hostBuildDir, 'host-build-writable', adapters));
  checks.push(inspectDisk(selectedOutput, 'output-disk-space', minimumFreeBytes, adapters));
  checks.push(inspectDisk(hostBuildDir, 'host-build-disk-space', minimumFreeBytes, adapters));
  checks.push(inspectDisk(temporaryDir, 'temporary-disk-space', minimumFreeBytes, adapters));

  const ready = checks.every((item) => item.required === false || item.status !== 'FAIL');
  return { ready: ready, target: target, mode: mode, repository: repository, checks: checks };
}

module.exports = {
  MINIMUM_BUILD_FREE_BYTES: MINIMUM_BUILD_FREE_BYTES,
  REQUIRED_FILES: REQUIRED_FILES,
  REQUIRED_DIRECTORIES: REQUIRED_DIRECTORIES,
  createBuildEnvironment: createBuildEnvironment,
  inspectEnvironment: inspectEnvironment
};
