'use strict';

/*
 * Release Builder · git access (read + the explicit publish-side mutations).
 *
 * Everything here runs with `shell:false` and a fixed argument array. Nothing
 * in this file ever builds a command line as a string, so a path or a version
 * can never become a shell word.
 *
 * Read functions are used by CHECK. The four mutating functions (addAndCommit,
 * createTag, pushBranch, pushTag) are ONLY reachable from lib/publish.js, which
 * is only reachable from an explicitly confirmed PUBLISH action.
 */

const { execFileSync } = require('child_process');

function run(cwd, args, opts) {
  const o = opts || {};
  const res = { ok: false, stdout: '', stderr: '', exitCode: null, error: null };
  try {
    res.stdout = execFileSync('git', args, {
      cwd: cwd,
      encoding: 'utf8',
      windowsHide: true,
      shell: false,
      timeout: typeof o.timeout === 'number' ? o.timeout : 60000,
      maxBuffer: 8 * 1024 * 1024,
      input: o.input || undefined
    });
    res.exitCode = 0;
    res.ok = true;
  } catch (e) {
    res.exitCode = typeof e.status === 'number' ? e.status : 1;
    res.stdout = String(e.stdout || '');
    res.stderr = String(e.stderr || '');
    res.error = String((e && e.message) || e);
  }
  return res;
}

function available() {
  const r = run(process.cwd(), ['--version']);
  return { ok: r.ok, version: r.stdout.trim(), error: r.error };
}

function head(cwd) {
  const r = run(cwd, ['rev-parse', 'HEAD']);
  if (!r.ok) return { ok: false, commit: '', error: r.stderr.trim() || r.error };
  return { ok: true, commit: r.stdout.trim(), error: null };
}

function branch(cwd) {
  const r = run(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  return r.ok ? r.stdout.trim() : '';
}

function isRepo(cwd) {
  const r = run(cwd, ['rev-parse', '--is-inside-work-tree']);
  return r.ok && r.stdout.trim() === 'true';
}

/* Porcelain v1, trimmed, with an explicit parser so callers do not each invent
   their own reading of the XY codes. */
function status(cwd) {
  const r = run(cwd, ['status', '--porcelain', '--untracked-files=all']);
  if (!r.ok) return { ok: false, entries: [], error: r.stderr.trim() || r.error };
  const entries = r.stdout.split('\n').filter(Boolean).map(function (line) {
    return { code: line.slice(0, 2), path: line.slice(3) };
  });
  return { ok: true, entries: entries, error: null };
}

/* Does the repository track this path? (used to decide whether a revert may
   restore from git or must restore saved bytes) */
function isTracked(cwd, relPath) {
  const r = run(cwd, ['ls-files', '--error-unmatch', '--', relPath]);
  return r.ok;
}

function remoteUrl(cwd, name) {
  const r = run(cwd, ['remote', 'get-url', name || 'origin']);
  return r.ok ? r.stdout.trim() : '';
}

/* `git rev-list --left-right --count <upstream>...HEAD` → { behind, ahead } */
function aheadBehind(cwd, upstream) {
  const up = upstream || 'origin/master';
  const r = run(cwd, ['rev-list', '--left-right', '--count', up + '...HEAD']);
  if (!r.ok) return { ok: false, behind: null, ahead: null, upstream: up, error: r.stderr.trim() || r.error };
  const m = r.stdout.trim().split(/\s+/);
  return { ok: true, behind: Number(m[0]), ahead: Number(m[1]), upstream: up, error: null };
}

function refExists(cwd, ref) {
  const r = run(cwd, ['rev-parse', '--verify', '--quiet', ref + '^{commit}']);
  return r.ok;
}

/* The commit a tag points at, or '' when the tag does not exist. */
function tagCommit(cwd, tag) {
  const r = run(cwd, ['rev-list', '-n', '1', tag]);
  return r.ok ? r.stdout.trim() : '';
}

function commitSubject(cwd, commit) {
  const r = run(cwd, ['log', '-1', '--format=%s', commit]);
  return r.ok ? r.stdout.trim() : '';
}

function commitDate(cwd, commit) {
  const r = run(cwd, ['log', '-1', '--format=%ci', commit]);
  return r.ok ? r.stdout.trim() : '';
}

/* ── Mutations (publish side only) ─────────────────────────────────────────
   Every one of these returns a structured result; none of them throws, and
   none of them is reachable from a read-only stage. */

function addAndCommit(cwd, paths, message, opts) {
  const o = opts || {};
  const addArgs = ['add', '--'].concat(paths);
  const add = run(cwd, addArgs);
  if (!add.ok) return { ok: false, step: 'git add', stdout: add.stdout, stderr: add.stderr, commit: '' };

  /* Refuse an empty commit: if nothing staged, the release bump did not happen
     and a "successful" commit would be a lie. */
  const staged = run(cwd, ['diff', '--cached', '--name-only']);
  if (!staged.ok || !staged.stdout.trim()) {
    return { ok: false, step: 'git add', stdout: staged.stdout, stderr: 'nothing staged', commit: '' };
  }

  const args = ['commit', '-m', message];
  if (o.authorName) args.push('--author', o.authorName);
  const commit = run(cwd, args);
  if (!commit.ok) return { ok: false, step: 'git commit', stdout: commit.stdout, stderr: commit.stderr, commit: '' };
  const head = head(cwd);
  return { ok: true, step: 'git commit', stdout: commit.stdout, stderr: commit.stderr, commit: head.ok ? head.commit : '' };
}

function createTag(cwd, tag, message, commit) {
  const args = ['tag', '-a', tag, '-m', message];
  if (commit) args.push(commit);
  const r = run(cwd, args);
  return { ok: r.ok, step: 'git tag', stdout: r.stdout, stderr: r.stderr, tag: tag };
}

function pushBranch(cwd, remote, branchName) {
  const r = run(cwd, ['push', remote || 'origin', branchName], { timeout: 300000 });
  return { ok: r.ok, step: 'git push', stdout: r.stdout, stderr: r.stderr };
}

function pushTag(cwd, remote, tag) {
  const r = run(cwd, ['push', remote || 'origin', tag], { timeout: 300000 });
  return { ok: r.ok, step: 'git push <tag>', stdout: r.stdout, stderr: r.stderr };
}

module.exports = {
  run,
  available,
  head,
  branch,
  isRepo,
  status,
  isTracked,
  remoteUrl,
  aheadBehind,
  refExists,
  tagCommit,
  commitSubject,
  commitDate,
  addAndCommit,
  createTag,
  pushBranch,
  pushTag
};
