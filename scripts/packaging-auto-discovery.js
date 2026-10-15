'use strict';

/*
 * Packaging discovery/check entry point.
 *
 * This is intentionally a consumer of release-manifest.js, not a second
 * release list: the existing entries, directory exclusions and deny rules
 * decide what may ship. The resolver adds statically referenced local runtime
 * modules and verifies the resulting closure before the installer is built.
 *
 *   node scripts/packaging-auto-discovery.js --check
 *   node scripts/packaging-auto-discovery.js --check --json
 *   node scripts/packaging-auto-discovery.js --verify-stage <dist/staging>
 */

const fs = require('fs');
const path = require('path');
const crypto = require('node:crypto');
const release = require('./release-manifest.js');

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function normalized(value) {
  return release.toPosix(value).replace(/^\.\//, '').toLowerCase();
}

function summarize(root, options) {
  const resolved = release.resolve({ root: root, entries: options && options.entries });
  const frontEnd = resolved.files.filter(file => /^(?:assets|apps|game)\//i.test(file.to)
    && /\.(?:js|mjs|cjs|css|html?|json|png|apng|jpe?g|gif|webp|avif|bmp|svg|ico|woff2?|ttf|otf|eot|mp3|m4a|aac|wav|ogg|mp4|webm|webmanifest)$/i.test(file.to));
  return {
    root: resolved.root,
    ok: resolved.ok,
    count: resolved.count,
    totalBytes: resolved.totalBytes,
    automaticDirectoryFiles: resolved.autoIncluded,
    staticallyDiscoveredFiles: resolved.discovered,
    frontEndResourceCount: frontEnd.length,
    files: resolved.files.map(file => ({ path: file.to, sizeBytes: file.bytes, discovered: file.discovered === true })),
    findings: {
      missingEntries: resolved.missing,
      excludedOrDangerous: resolved.denied,
      unsafeFilesOrReferences: resolved.unsafe,
      missingReferences: resolved.missingReferences,
      duplicatePaths: resolved.duplicatePaths
    }
  };
}

function verifyStage(stageDir, options) {
  const o = options || {};
  const root = path.resolve(o.root || release.ROOT);
  const stage = path.resolve(stageDir || '');
  const report = summarize(root, o);
  const sourceResolution = release.resolve({ root: root, entries: o.entries });
  const failures = [];
  if (!report.ok) failures.push('source resolution reported packaging findings');
  if (!fs.existsSync(stage) || !fs.statSync(stage).isDirectory()) {
    failures.push('Stage directory is missing');
    return { ok: false, stage: stage, failures: failures, report: report };
  }

  const audit = release.auditDirectory(stage);
  const expected = new Map(report.files.map(file => [normalized(file.path), file.path]));
  const generated = (o.generated || ['internalbeyond-host.exe']).map(value => release.toPosix(value));
  for (const relative of generated) expected.set(normalized(relative), relative);
  expected.set(normalized('ib-payload-manifest.json'), 'ib-payload-manifest.json');
  const actual = new Map(audit.files.map(file => [normalized(file.path), file]));

  for (const [key, relative] of expected) {
    if (!actual.has(key)) failures.push('Stage is missing: ' + relative);
  }
  for (const [key, file] of actual) {
    if (!expected.has(key)) failures.push('Stage contains an undeclared stale/extra path: ' + file.path);
  }
  for (const finding of audit.violations) failures.push('Stage deny rule: ' + finding.path + ' — ' + finding.why);
  for (const finding of audit.unsafe) failures.push('Unsafe Stage entry: ' + finding.path + ' — ' + finding.why);
  for (const finding of audit.duplicatePaths) failures.push('Duplicate Stage path: ' + finding.path + ' conflicts with ' + finding.conflictsWith);

  for (const file of sourceResolution.files) {
    const key = normalized(file.to);
    const physical = actual.get(key);
    if (!physical) continue;
    const stagedPath = path.join(stage, file.to);
    const source = file.abs;
    if (physical.bytes !== file.bytes || sha256File(stagedPath) !== sha256File(source)) {
      failures.push('Stage bytes differ from the current source: ' + file.to);
    }
  }

  const manifestPath = path.join(stage, 'ib-payload-manifest.json');
  let payload = null;
  try { payload = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); }
  catch (_) { failures.push('ib-payload-manifest.json is missing or invalid JSON'); }
  if (payload) {
    if (payload.schema !== 'internalbeyond.payload-manifest' || payload.version !== 1) {
      failures.push('payload manifest schema/version is unsupported');
    }
    if (!Array.isArray(payload.files) || payload.count !== payload.files.length) {
      failures.push('payload manifest count does not match its file list');
    } else {
      const declared = new Map();
      for (const relative of payload.files) {
        const key = normalized(relative);
        if (declared.has(key)) failures.push('payload manifest has duplicate path: ' + relative);
        else declared.set(key, relative);
      }
      for (const key of expected.keys()) {
        if (!declared.has(key)) failures.push('payload manifest is missing Stage path: ' + expected.get(key));
      }
      for (const [key, relative] of declared) {
        if (!actual.has(key)) failures.push('payload manifest declares absent Stage path: ' + relative);
      }
    }
    if (!Array.isArray(payload.artifacts)) {
      failures.push('payload manifest is missing artifact size/SHA-256 records');
    } else {
      if (payload.artifactCount !== payload.artifacts.length) failures.push('payload manifest artifactCount disagrees with its records');
      const declaredArtifactBytes = payload.artifacts.reduce((sum, record) =>
        sum + (record && Number.isSafeInteger(record.sizeBytes) ? record.sizeBytes : 0), 0);
      if (payload.artifactTotalBytes !== declaredArtifactBytes) failures.push('payload manifest artifactTotalBytes disagrees with its records');
      const records = new Map();
      for (const record of payload.artifacts) {
        if (!record || typeof record.path !== 'string' || !Number.isSafeInteger(record.sizeBytes)
          || !/^[a-f0-9]{64}$/i.test(String(record.sha256 || ''))) {
          failures.push('payload manifest contains an invalid artifact record');
          continue;
        }
        const key = normalized(record.path);
        if (records.has(key)) failures.push('payload manifest has duplicate artifact record: ' + record.path);
        else records.set(key, record);
        const physical = actual.get(key);
        if (!physical) failures.push('artifact record has no Stage file: ' + record.path);
        else {
          const stagedPath = path.join(stage, physical.path);
          if (physical.bytes !== record.sizeBytes || sha256File(stagedPath) !== String(record.sha256).toLowerCase()) {
            failures.push('artifact size/SHA-256 differs from Stage bytes: ' + record.path);
          }
        }
      }
      const selfKey = normalized('ib-payload-manifest.json');
      for (const key of actual.keys()) {
        if (key === selfKey) continue; // self-hashing is circular; the manifest still owns itself in `files`.
        if (!records.has(key)) failures.push('Stage file has no size/SHA-256 record: ' + actual.get(key).path);
      }
      for (const key of records.keys()) {
        if (key === selfKey) failures.push('payload manifest must not claim a self SHA-256');
      }
    }
  }

  return {
    ok: failures.length === 0,
    stage: stage,
    fileCount: audit.count,
    totalBytes: audit.totalBytes,
    failures: failures,
    report: report
  };
}

function printText(report, verified, verbose) {
  if (verified) {
    if (verified.ok) {
      process.stdout.write('Stage verification PASS · ' + verified.fileCount + ' files · '
        + (verified.totalBytes / (1024 * 1024)).toFixed(1) + ' MiB · Inno source is the verified Stage\n');
    } else {
      process.stderr.write('Stage verification FAILED\n');
      for (const failure of verified.failures) process.stderr.write('  - ' + failure + '\n');
    }
    return;
  }
  process.stdout.write('Packaging auto-discovery ' + (report.ok ? 'PASS' : 'FAILED') + '\n');
  process.stdout.write('  resolved payload: ' + report.count + ' files · '
    + (report.totalBytes / (1024 * 1024)).toFixed(1) + ' MiB\n');
  process.stdout.write('  recursive auto-discovery: ' + report.automaticDirectoryFiles.length
    + ' files · front-end resources: ' + report.frontEndResourceCount + '\n');
  process.stdout.write('  referenced modules added: ' + report.staticallyDiscoveredFiles.length + '\n');
  const findings = report.findings;
  for (const [kind, list] of Object.entries(findings)) {
    for (const item of list) {
      const detail = item.path || item.from || '<unknown>';
      process.stderr.write('  - ' + kind + ': ' + detail + ' — ' + (item.why || item.reference || '') + '\n');
    }
  }
  if (verbose) {
    for (const file of report.staticallyDiscoveredFiles) {
      process.stdout.write('  + ' + file.path + ' (' + file.bytes + ' bytes) · ' + file.why + '\n');
    }
  }
}

function main(argv) {
  const args = argv.slice();
  const rootIndex = args.indexOf('--root');
  const root = rootIndex >= 0 ? path.resolve(args[rootIndex + 1] || '') : release.ROOT;
  const verifyIndex = args.indexOf('--verify-stage');
  const json = args.includes('--json');
  const verbose = args.includes('--verbose');
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write('Usage: node scripts/packaging-auto-discovery.js --check [--json] [--verbose]\n'
      + '       node scripts/packaging-auto-discovery.js --verify-stage <stage-dir> [--root <repo>]\n');
    return 0;
  }
  if (verifyIndex >= 0) {
    const stage = args[verifyIndex + 1];
    if (!stage) { process.stderr.write('--verify-stage requires a Stage directory\n'); return 2; }
    const verified = verifyStage(stage, { root: root });
    if (json) process.stdout.write(JSON.stringify(verified, null, 2) + '\n');
    else printText(null, verified, verbose);
    return verified.ok ? 0 : 1;
  }
  const report = summarize(root);
  if (json) process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  else printText(report, null, verbose);
  return report.ok ? 0 : 1;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { summarize: summarize, verifyStage: verifyStage, main: main };
