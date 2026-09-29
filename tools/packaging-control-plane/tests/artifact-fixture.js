'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const updateManifest = require('../../../runtime/update-manifest.js');
const verify = require('../../release-builder/lib/verify.js');

const VERSION = '1.2.3';
const REVISION = 'a'.repeat(40);
const PRODUCTION_ID = '78B427F6-A48F-4443-86D5-2F50DC899D07';
const TEST_ID = 'A4D9E7B3-1F86-4C2A-9D57-6B3E1C8F0A24';

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function createArtifactFixture(options) {
  const config = Object.assign({ mode: 'release' }, options || {});
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-p35-artifact-'));
  const outputRelative = config.mode === 'test' ? 'tmp/installer-smoke-build' : 'dist';
  const outputRoot = path.join(root, outputRelative);
  const stageRoot = path.join(outputRoot, 'staging');
  const iss = [
    '#define ProductionAppId "{{' + PRODUCTION_ID + '}"',
    '#define TestOnlyAppId "{{' + TEST_ID + '}"',
    '#define ProductionAppName "InternalBeyond"',
    '#define TestOnlyAppName "InternalBeyond Installer Smoke Test"',
    '#define ProductionInstallDirectoryName "InternalBeyond"',
    '#define TestOnlyInstallDirectoryName "InternalBeyond-Installer-Smoke-Test"',
    '#define ProductionOutputBaseName "InternalBeyond"',
    '#define TestOnlyOutputBaseName "InternalBeyond-Installer-Smoke-Test"',
    '[Setup]',
    'OutputBaseFilename={#OutputBaseName}-Setup-{#AppVersion}',
    ''
  ].join('\n');
  write(path.join(root, 'VERSION'), VERSION + '\n');
  write(path.join(root, 'installer', 'InternalBeyond.iss'), iss);
  write(path.join(root, 'scripts', 'build-installer.ps1'), [
    "$payloadFiles += 'internalbeyond-host.exe'",
    "$payloadFiles += 'ib-payload-manifest.json'",
    ''
  ].join('\n'));
  fs.mkdirSync(stageRoot, { recursive: true });

  let sourcePaths = [];
  function rebuildStage(extraFiles, readmeOverride) {
    fs.rmSync(stageRoot, { recursive: true, force: true });
    fs.mkdirSync(stageRoot, { recursive: true });
    const contents = {
      'README.md': readmeOverride || ('InternalBeyond 非官方二次开发版\n当前版本 **' + VERSION + '**\n\n## 关于本仓库 / About this fork\n\napiKey is a field name; no credential value is present.\n'),
      'VERSION': VERSION + '\n',
      'internalbeyond-host.exe': 'TEST_ONLY_FAKE_HOST_BINARY\n'
    };
    Object.assign(contents, extraFiles || {});
    sourcePaths = Object.keys(contents).sort();
    for (const relative of sourcePaths) write(path.join(stageRoot, relative), contents[relative]);
    const declared = sourcePaths.concat(['ib-payload-manifest.json']).sort();
    write(path.join(stageRoot, 'ib-payload-manifest.json'), JSON.stringify({
      schema: 'internalbeyond.payload-manifest',
      version: 1,
      product: VERSION,
      generated: 'scripts/build-installer.ps1',
      count: declared.length,
      files: declared
    }, null, 2) + '\n');
    const base = config.mode === 'test' ? 'InternalBeyond-Installer-Smoke-Test' : 'InternalBeyond';
    const expectedId = config.mode === 'test' ? TEST_ID : PRODUCTION_ID;
    const modeLabel = config.mode === 'test' ? 'InstallerTestMode=1' : 'InstallerTestMode absent';
    const compressed = declared.map((relative) => 'Compressing: ' + path.join(stageRoot, relative)).join('\n');
    write(path.join(outputRoot, 'build-compile.log'), [
      'compile identity: ' + modeLabel + '; resolved AppId = {' + expectedId + '}',
      'compile args: /DAppVersion=' + VERSION + (config.mode === 'test' ? ' /DInstallerTestMode=1' : ''),
      'Successful compile',
      compressed,
      ''
    ].join('\n'));
    return { sourcePaths: sourcePaths.slice(), outputBase: base };
  }

  const outputBase = config.mode === 'test' ? 'InternalBeyond-Installer-Smoke-Test' : 'InternalBeyond';
  const artifactName = outputBase + '-Setup-' + VERSION + '.exe';
  const artifactPath = path.join(outputRoot, artifactName);
  const artifactSize = updateManifest.MIN_PLAUSIBLE_INSTALLER_BYTES + 1024;
  const fd = fs.openSync(artifactPath, 'w');
  try { fs.ftruncateSync(fd, artifactSize); } finally { fs.closeSync(fd); }

  function writeMetadata() {
    const sha = verify.sha256File(artifactPath);
    const stat = fs.statSync(artifactPath);
    write(path.join(outputRoot, 'SHA256SUMS.txt'), '# synthetic fixture\n' + sha + ' *' + artifactName + '\n');
    if (config.mode === 'release') {
      const built = updateManifest.build({
        version: VERSION, channel: 'stable', sha256: sha,
        sizeBytes: stat.size, productVersion: VERSION
      });
      if (!updateManifest.validate(built).ok) throw new Error('could not make synthetic update manifest');
      write(path.join(outputRoot, 'update-stable.json'), updateManifest.serialize(built));
      write(path.join(outputRoot, 'release-' + VERSION + '.log'), [
        'InternalBeyond Release Builder · run log',
        'repo commit: ' + REVISION,
        'source ver : ' + VERSION,
        'target ver : ' + VERSION,
        'channel    : stable',
        'mode       : REAL',
        'status     : SEALED',
        ''
      ].join('\n'));
      const items = [
        { key: 'SEAL:reread-exists', expected: artifactName + ' · ' + stat.size + ' B', actual: sha },
        { key: 'SEAL:three-way:exe.sha256 == SHA256SUMS.sha256', expected: sha, actual: sha },
        { key: 'SEAL:three-way:exe.sha256 == manifest.installer.sha256', expected: sha, actual: sha },
        { key: 'SEAL:three-way:exe.bytes == manifest.installer.sizeBytes', expected: String(stat.size), actual: String(stat.size) },
        { key: 'SEAL:three-way:manifest.version == target', expected: VERSION, actual: VERSION },
        { key: 'SEAL:three-way:manifest.installer.productVersion == target', expected: VERSION, actual: VERSION },
        { key: 'CHECK:git-clean', expected: '0', actual: 'clean', status: 'ok' }
      ].map((item) => Object.assign({ seq: 1, at: '2026-09-28T00:00:00Z', kind: 'item', status: 'ok', stage: 'SEAL' }, item));
      write(path.join(outputRoot, 'release-' + VERSION + '.jsonl'), items.map((item) => JSON.stringify(item)).join('\n') + '\n');
    } else {
      write(path.join(outputRoot, 'installer-test-identity.json'), JSON.stringify({
        schema: 'internalbeyond.installer-test-identity',
        testOnly: true,
        appId: '{' + TEST_ID + '}',
        productionAppId: '{' + PRODUCTION_ID + '}',
        resolvedAppId: '{' + TEST_ID + '}',
        appName: 'InternalBeyond Installer Smoke Test',
        publisher: 'InternalBeyond (Test Only)',
        installDirectoryName: 'InternalBeyond-Installer-Smoke-Test',
        hostVersion: VERSION,
        hostBytes: 16,
        hostSha256: 'b'.repeat(64),
        outputBaseName: outputBase,
        artifact: artifactName,
        sha256: sha,
        compilerDefine: 'InstallerTestMode=1',
        compilerArgs: ['/DAppVersion=' + VERSION, '/DInstallerTestMode=1'],
        source: 'installer/InternalBeyond.iss'
      }, null, 2) + '\n');
    }
    return { sha: sha, size: stat.size };
  }

  rebuildStage();
  const adapters = {
    resolvePayload: function () {
      return { ok: true, files: [{ to: 'README.md' }, { to: 'VERSION' }] };
    },
    currentGitState: function () { return { ok: true, revision: REVISION, dirty: false }; },
    readPeVersion: function (_file, expected) {
      return { ok: true, read: { ok: true, productVersion: expected, productVersionFixed: expected + '.0', fileVersionFixed: expected + '.0' } };
    }
  };
  const metadata = writeMetadata();

  function request(overrides) {
    return Object.assign({
      job: {
        id: 'p35-validator-fixture', target: 'windows-installer', version: VERSION,
        channel: config.mode === 'test' ? 'local' : 'stable', mode: config.mode, options: {}
      },
      artifact: { path: outputRelative + '/' + artifactName },
      buildContext: { revision: REVISION, dirty: false }
    }, overrides || {});
  }

  return {
    root: root,
    outputRoot: outputRoot,
    outputRelative: outputRelative,
    stageRoot: stageRoot,
    artifactPath: artifactPath,
    artifactName: artifactName,
    artifactSize: artifactSize,
    artifactSha256: metadata.sha,
    version: VERSION,
    revision: REVISION,
    adapters: adapters,
    request: request,
    rebuildStage: rebuildStage,
    writeMetadata: writeMetadata,
    cleanup: function () { fs.rmSync(root, { recursive: true, force: true }); }
  };
}

module.exports = {
  createArtifactFixture: createArtifactFixture,
  PRODUCTION_ID: PRODUCTION_ID,
  TEST_ID: TEST_ID
};
