'use strict';

const assert = require('assert');
const crypto = require('node:crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const release = require('../scripts/release-manifest.js');
const discovery = require('../scripts/packaging-auto-discovery.js');

function put(root, relative, contents) {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
  return file;
}

function digest(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-packaging-discovery-'));
const root = path.join(temp, 'source');
const stageDir = path.join(temp, 'staging');
fs.mkdirSync(root, { recursive: true });

const entries = [
  { from: 'InternalBeyond.html', why: 'fixture document' },
  { from: 'assets', dir: true, why: 'existing production asset directory rule' },
  { from: 'services/app.js', why: 'fixture production service entry' }
];

try {
  put(root, 'InternalBeyond.html', '<html><head><link rel="stylesheet" href="assets/css/new-feature.css"></head><body><script src="assets/js/new-feature.js"></script></body></html>');
  put(root, 'assets/js/new-feature.js', 'window.newFeatureReady = true;\n');
  put(root, 'assets/css/new-feature.css', '.new-feature { background: url("../images/new-feature.svg"); }\n');
  put(root, 'assets/images/new-feature.svg', '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><path d="M0 0h1v1H0z"/></svg>');
  put(root, 'services/app.js', "'use strict';\nrequire('../runtime/new-module.js');\n");
  put(root, 'runtime/new-module.js', "module.exports = require('./nested-module.js');\n");
  put(root, 'runtime/nested-module.js', 'module.exports = { ready: true };\n');

  let report = discovery.summarize(root, { entries: entries });
  assert.strictEqual(report.ok, true, JSON.stringify(report.findings));
  const discoveredPaths = new Set(report.files.map(file => file.path));
  for (const relative of [
    'assets/js/new-feature.js', 'assets/css/new-feature.css', 'assets/images/new-feature.svg',
    'runtime/new-module.js', 'runtime/nested-module.js'
  ]) assert.ok(discoveredPaths.has(relative), 'check mode omitted newly created resource: ' + relative);
  assert.ok(report.automaticDirectoryFiles.some(file => file.path === 'assets/css/new-feature.css'),
    'recursive release directory rule did not identify the new CSS file');
  assert.ok(report.staticallyDiscoveredFiles.some(file => file.path === 'runtime/new-module.js'),
    'static module closure did not identify the new application module');
  assert.ok(report.staticallyDiscoveredFiles.some(file => file.path === 'runtime/nested-module.js'),
    'static module closure did not follow the new module transitively');

  let staged = release.stage(stageDir, { root: root, entries: entries, allowAnyDir: true });
  assert.strictEqual(staged.ok, true, JSON.stringify(staged));
  assert.ok(staged.files.includes('assets/js/new-feature.js'));
  assert.ok(staged.files.includes('assets/css/new-feature.css'));
  assert.ok(staged.files.includes('runtime/new-module.js'));
  assert.ok(staged.files.includes('runtime/nested-module.js'));
  assert.ok(staged.records.every(record => /^[a-f0-9]{64}$/.test(record.sha256) && record.sizeBytes >= 0));

  put(root, 'services/app.js', "'use strict';\nrequire('../runtime/moved-module.js');\n");
  fs.renameSync(path.join(root, 'runtime', 'new-module.js'), path.join(root, 'runtime', 'moved-module.js'));
  staged = release.stage(stageDir, { root: root, entries: entries, allowAnyDir: true });
  assert.strictEqual(staged.ok, true, JSON.stringify(staged));
  assert.ok(staged.files.includes('runtime/moved-module.js'));
  assert.ok(!staged.files.includes('runtime/new-module.js'), 'resolver kept a stale module path after a move');
  assert.strictEqual(fs.existsSync(path.join(stageDir, 'runtime', 'new-module.js')), false,
    'clean Stage retained the old path after a move');

  put(stageDir, 'internalbeyond-host.exe', 'fixture host bytes');
  const hostRecord = {
    path: 'internalbeyond-host.exe',
    sizeBytes: fs.statSync(path.join(stageDir, 'internalbeyond-host.exe')).size,
    sha256: digest(path.join(stageDir, 'internalbeyond-host.exe'))
  };
  const payloadFiles = [...staged.files, 'internalbeyond-host.exe', 'ib-payload-manifest.json'].sort();
  const artifacts = [...staged.records, hostRecord].sort((a, b) => a.path.localeCompare(b.path));
  const payloadManifest = {
    schema: 'internalbeyond.payload-manifest',
    version: 1,
    product: '1.2.3',
    count: payloadFiles.length,
    files: payloadFiles,
    artifactCount: artifacts.length,
    artifactTotalBytes: artifacts.reduce((sum, record) => sum + record.sizeBytes, 0),
    artifacts: artifacts
  };
  fs.writeFileSync(path.join(stageDir, 'ib-payload-manifest.json'), JSON.stringify(payloadManifest));
  let verified = discovery.verifyStage(stageDir, { root: root, entries: entries });
  assert.strictEqual(verified.ok, true, JSON.stringify(verified.failures));

  put(root, 'services/app.js', "'use strict';\nrequire(modulePath);\n");
  report = discovery.summarize(root, { entries: entries });
  assert.strictEqual(report.ok, false, 'computed module paths must stop packaging');
  assert.ok(report.findings.unsafeFilesOrReferences.some(item => /动态模块路径/.test(item.why)),
    'computed local module was not reported as unsafe');

  put(root, 'services/app.js', "'use strict';\nrequire('../runtime/moved-module.js');\n");
  fs.rmSync(path.join(root, 'runtime', 'moved-module.js'));
  report = discovery.summarize(root, { entries: entries });
  assert.strictEqual(report.ok, false, 'missing referenced module must stop packaging');
  assert.ok(report.findings.missingReferences.some(item => item.reference === '../runtime/moved-module.js'),
    'missing module report did not identify the stale reference');

  put(root, 'assets/credentials.pem', 'not a real key');
  report = discovery.summarize(root, { entries: entries });
  assert.strictEqual(report.ok, false, 'dangerous key files must stop packaging');
  assert.ok(report.findings.excludedOrDangerous.some(item => item.path === 'assets/credentials.pem'));
  fs.rmSync(path.join(root, 'assets', 'credentials.pem'));

  put(root, 'assets/user-data/profile.json', '{"private":true}');
  report = discovery.summarize(root, { entries: entries });
  assert.strictEqual(report.ok, false, 'user data directories must stop packaging');
  assert.ok(report.findings.excludedOrDangerous.some(item => item.path === 'assets/user-data/profile.json'));
  fs.rmSync(path.join(root, 'assets', 'user-data'), { recursive: true, force: true });

  put(root, 'assets/data/unclassified.bin', 'unknown type');
  report = discovery.summarize(root, { entries: entries });
  assert.strictEqual(report.ok, false, 'unclassified file types must stop packaging');
  assert.ok(report.findings.unsafeFilesOrReferences.some(item => item.path === 'assets/data/unclassified.bin'));
  fs.rmSync(path.join(root, 'assets', 'data', 'unclassified.bin'));

  report = release.resolve({ root: root, entries: entries.concat([
    { from: 'assets/js/new-feature.js', why: 'intentional duplicate fixture' }
  ]) });
  assert.strictEqual(report.ok, false, 'duplicate target paths must stop packaging');
  assert.ok(report.duplicatePaths.some(item => item.path === 'assets/js/new-feature.js'));

  process.stdout.write('Packaging auto-discovery: PASS (new JS/CSS/image, transitive and dynamic modules, move/delete, hash manifest, secret/user-data, unknown-type and duplicate checks)\n');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
