'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const inspector = require('../environment-inspector.js');

function writeFile(root, relative, content) {
  const destination = path.join(root, relative);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, content);
}

function createFixture(overrides) {
  const settings = Object.assign({ dirty: true, freeBytes: 12 * 1024 * 1024 * 1024, writable: true, payloadOk: true, webview2: false }, overrides || {});
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-p35-control-plane-'));
  const programData = path.join(root, 'program-data');
  const temporaryDir = path.join(root, 'temporary');
  const testOutputDir = path.join(root, 'tmp', 'installer-smoke-build');
  for (const directory of [path.join(root, 'dist'), path.join(root, 'tmp'), programData, temporaryDir]) {
    fs.mkdirSync(directory, { recursive: true });
  }

  for (const relative of inspector.REQUIRED_FILES) {
    let contents = 'fixture\n';
    if (relative === 'VERSION') contents = '1.2.3\n';
    if (relative === 'src-tauri/Cargo.toml') contents = '[package]\nname = "fixture-host"\nversion = "1.2.3"\n';
    if (relative === 'runtime/node/VERSION') contents = '24.18.0\n';
    if (relative === 'installer/runtime-pin.json') contents = JSON.stringify({ runtime: { version: '24.18.0' } });
    writeFile(root, relative, contents);
  }
  for (const relative of inspector.REQUIRED_DIRECTORIES) {
    fs.mkdirSync(path.join(root, relative), { recursive: true });
  }

  const toolPaths = {
    rustc: path.join(root, 'mock-tools', 'rustc.exe'),
    cargo: path.join(root, 'mock-tools', 'cargo.exe'),
    'powershell.exe': path.join(root, 'mock-tools', 'powershell.exe'),
    'ISCC.exe': path.join(root, 'mock-tools', 'ISCC.exe'),
    git: path.join(root, 'mock-tools', 'git.exe')
  };
  const missingTools = new Set(settings.missingTools || []);
  const adapters = {
    findExecutable: function (name) {
      if (missingTools.has(name)) return null;
      return Object.prototype.hasOwnProperty.call(toolPaths, name) ? toolPaths[name] : null;
    },
    runCommand: function (file) {
      if (file === process.execPath) return { status: 0, stdout: process.version };
      const entry = Object.keys(toolPaths).find((key) => toolPaths[key] === file);
      const versions = {
        rustc: 'rustc 1.88.0',
        cargo: 'cargo 1.88.0',
        'powershell.exe': '5.1.22621.2506'
      };
      return { status: entry && versions[entry] ? 0 : 0, stdout: (entry && versions[entry]) || '' };
    },
    getGitState: function () { return { ok: true, revision: 'a'.repeat(40), dirty: settings.dirty }; },
    resolvePayload: function () {
      return { ok: settings.payloadOk, count: settings.payloadOk ? 100 : 0, missing: settings.payloadOk ? [] : [{ from: 'assets/example.js' }], denied: [] };
    },
    isWritable: function () { return settings.writable; },
    getFreeBytes: function () { return settings.freeBytes; },
    isWebView2Installed: function () { return settings.webview2; }
  };

  function inspect(mode, extra) {
    return inspector.inspectEnvironment(Object.assign({
      root: root,
      platform: 'win32',
      target: 'windows-installer',
      mode: mode || 'release',
      env: { ProgramData: programData },
      outputDir: path.join(root, 'dist'),
      temporaryDir: temporaryDir,
      testOutputDir: testOutputDir,
      minimumFreeBytes: 8 * 1024 * 1024 * 1024,
      adapters: adapters
    }, extra || {}));
  }

  return {
    root: root,
    programData: programData,
    temporaryDir: temporaryDir,
    testOutputDir: testOutputDir,
    adapters: adapters,
    inspect: inspect,
    cleanup: function () { fs.rmSync(root, { recursive: true, force: true }); }
  };
}

module.exports = { createFixture: createFixture };
