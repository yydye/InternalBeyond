'use strict';

/*
 * Supplies the frozen Disclosure test with a trustworthy HEAD baseline when a
 * Release Source Snapshot intentionally omits .git. Snapshot creation records
 * the exact HEAD bytes as evidence; this helper builds an isolated temporary
 * Git index from those bytes so the existing diff judge remains unchanged.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const FILES = Object.freeze([
  'assets/js/disclosure-core.js',
  'assets/js/disclosure-authoring-core.js',
  'assets/js/role-dm.js',
  'assets/js/role-dm-core.js',
  'assets/js/disclosure-store.js',
  'assets/js/social.js'
]);

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function manifestFor(root) {
  const explicit = process.env.IB_DISCLOSURE_FROZEN_BASELINE_MANIFEST;
  const candidate = explicit || path.join(path.dirname(path.resolve(root)), 'evidence', 'release-source-snapshot.json');
  if (!fs.existsSync(candidate)) return null;
  try {
    const manifest = JSON.parse(fs.readFileSync(candidate, 'utf8'));
    if (!manifest || !manifest.testBaselines || !manifest.testBaselines.disclosureFrozenSurface) return null;
    return { path: candidate, manifest: manifest };
  } catch (_) {
    return null;
  }
}

function baselineEntry(root, rel) {
  const loaded = manifestFor(root);
  if (!loaded) return null;
  const baseline = loaded.manifest.testBaselines.disclosureFrozenSurface;
  const entry = Array.isArray(baseline.files) ? baseline.files.find(file => file.path === rel) : null;
  if (!entry || typeof entry.evidencePath !== 'string') return null;
  const evidenceRoot = path.dirname(path.resolve(loaded.path));
  const evidencePath = path.resolve(evidenceRoot, entry.evidencePath);
  const relative = path.relative(evidenceRoot, evidencePath);
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) return null;
  if (!fs.existsSync(evidencePath)) return null;
  const bytes = fs.readFileSync(evidencePath);
  if (bytes.length !== entry.bytes || sha256(bytes) !== entry.sha256) return null;
  return { bytes: bytes, head: baseline.head || loaded.manifest.head };
}

function readHeadFile(root, rel) {
  try {
    return execFileSync('git', ['show', 'HEAD:' + rel], { cwd: root, encoding: 'utf8', windowsHide: true });
  } catch (_) {
    const entry = baselineEntry(root, rel);
    return entry ? entry.bytes.toString('utf8') : null;
  }
}

function diffAgainstHead(root, files) {
  try {
    const top = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: root, encoding: 'utf8', windowsHide: true }).trim();
    if (path.resolve(top) !== path.resolve(root)) throw new Error('snapshot root is not a Git worktree');
    return {
      diffText: execFileSync('git', ['diff', '--unified=0', 'HEAD', '--', ...files], { cwd: root, encoding: 'utf8', windowsHide: true }),
      baseline: 'git-worktree'
    };
  } catch (gitError) {
    const entries = new Map();
    for (const rel of files) {
      const entry = baselineEntry(root, rel);
      if (!entry) throw new Error('frozen baseline unavailable for ' + rel + ': ' + String(gitError.message || gitError));
      entries.set(rel, entry.bytes.toString('utf8').replace(/\r\n/g, '\n'));
    }

    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-disclosure-frozen-'));
    try {
      execFileSync('git', ['init', '--quiet'], { cwd: tempRoot, windowsHide: true });
      execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: tempRoot, windowsHide: true });
      execFileSync('git', ['config', 'user.name', 'IB Snapshot Test'], { cwd: tempRoot, windowsHide: true });
      execFileSync('git', ['config', 'user.email', 'ib-snapshot-test@example.invalid'], { cwd: tempRoot, windowsHide: true });
      for (const rel of files) {
        const target = path.join(tempRoot, ...rel.split('/'));
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, Buffer.from(entries.get(rel), 'utf8'));
      }
      execFileSync('git', ['add', '--', ...files], { cwd: tempRoot, windowsHide: true });
      execFileSync('git', ['-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'frozen test baseline'], { cwd: tempRoot, windowsHide: true });
      for (const rel of files) {
        const current = fs.readFileSync(path.join(root, ...rel.split('/')), 'utf8').replace(/\r\n/g, '\n');
        fs.writeFileSync(path.join(tempRoot, ...rel.split('/')), Buffer.from(current, 'utf8'));
      }
      return {
        diffText: execFileSync('git', ['diff', '--unified=0', 'HEAD', '--', ...files], { cwd: tempRoot, encoding: 'utf8', windowsHide: true }),
        baseline: 'snapshot-evidence'
      };
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  }
}

module.exports = Object.freeze({ FILES: FILES, readHeadFile: readHeadFile, diffAgainstHead: diffAgainstHead });
