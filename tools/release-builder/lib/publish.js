'use strict';

/*
 * Release Builder · PUBLISH
 *
 * PUBLISH IS A SEPARATE AUTHORITY. It is never reachable from the one-click
 * path (CHECK → BUILD → VERIFY → SEAL → STOP), it is never triggered by a
 * build, and nothing in this file runs without an explicit confirmation token
 * produced by the GUI for the exact action list shown to the human.
 *
 * Everything here is irreversible in the audit's sense (audit §13): a push, a
 * tag, a GitHub Release, an uploaded asset, and — the one that actually reaches
 * users — the `update-stable.json` upload that puts the version on the Stable
 * channel. So:
 *
 *   · the plan is built and shown BEFORE anything runs;
 *   · each action is confirmed by name, and the confirmation carries the sha256
 *     of the artifact it was shown for, so a confirmation cannot be replayed
 *     against different bytes;
 *   · a failure keeps every sealed local artifact exactly as it is and STOPS —
 *     it never rebuilds, never re-verifies, never retries silently;
 *   · the manifest upload is last, always (docs/RELEASE.md §2: the order is a
 *     contract, not a preference).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const git = require('./git.js');
const plan = require('./plan.js');
const { STAGE_STATUS } = plan;

const ACTIONS = ['commit', 'push', 'tag', 'pushTag', 'releaseCreate', 'releaseUpload', 'manifestUpload'];

const ACTION_LABEL = {
  commit: '① git commit（发行提交：VERSION + README + 本次改动的发行文件）',
  push: '② git push <remote> <branch>（把提交推到远端）',
  tag: '③ git tag -a v<version>（本地创建 tag，指向该提交）',
  pushTag: '④ git push <remote> v<version>（推送 tag —— tag 是发布身份锚点）',
  releaseCreate: '⑤ gh release create v<version> <exe> <SHA256SUMS.txt>（创建 release 并上传前两个资产）',
  releaseUpload: '⑥ gh release upload v<version> update-stable.json（LAST —— 进入 Stable 通道）',
  manifestUpload: '⑥ gh release upload v<version> update-stable.json（LAST —— 进入 Stable 通道）'
};

const IRREVERSIBLE = {
  commit: false,
  push: true,
  tag: false,
  pushTag: true,
  releaseCreate: true,
  releaseUpload: true,
  manifestUpload: true
};

function sha256File(file) {
  const h = crypto.createHash('sha256');
  h.update(fs.readFileSync(file));
  return h.digest('hex');
}

function sizeOf(file) { try { return fs.statSync(file).size; } catch (e) { return -1; } }

/*
 * Build the plan. PURE with respect to the filesystem beyond reading it: it
 * records the exact command lines and the exact bytes each action would touch.
 *
 * Returns { ok, blockers, actions:[{ id, label, command, cwd, irreversible,
 *           preconditions:[{ok, why}], evidence }], artifact:{...}, manifest:{...} }
 */
function buildPlan(repo, o) {
  const root = repo.root;
  const target = String(o.target || '').trim();
  const dist = path.join(root, 'dist');
  const name = repo.assetName(target);
  const artifact = path.join(dist, name);
  const sums = path.join(dist, 'SHA256SUMS.txt');
  const manifest = path.join(dist, 'update-stable.json');
  const tag = repo.tagFor(target);
  const branch = git.branch(root) || 'master';
  const remote = o.remote || 'origin';
  const notesRel = 'docs/release-notes/' + target + '.md';
  const notesAbs = path.join(root, notesRel);

  const blockers = [];
  const actions = [];
  const artifactExists = fs.existsSync(artifact);
  const sumsExists = fs.existsSync(sums);
  const manifestExists = fs.existsSync(manifest);

  if (!artifactExists) blockers.push({ code: 'artifact-missing', why: artifact });
  if (!sumsExists) blockers.push({ code: 'sums-missing', why: sums });
  if (!manifestExists) blockers.push({ code: 'manifest-missing', why: manifest });

  const artifactSha = artifactExists ? sha256File(artifact) : '';
  const manifestSha = manifestExists ? sha256File(manifest) : '';
  const sumsSha = sumsExists ? sha256File(sums) : '';
  let manifestObj = null;
  try { manifestObj = JSON.parse(fs.readFileSync(manifest, 'utf8').replace(/^\uFEFF/, '')); } catch (e) { manifestObj = null; }
  if (manifestExists && !manifestObj) blockers.push({ code: 'manifest-unparseable', why: manifest });

  /* The release must not already exist. A tag that exists means the release
     identity is taken; reusing it would either fail or silently replace. */
  if (git.refExists(root, tag)) {
    blockers.push({
      code: 'tag-exists',
      why: 'tag ' + tag + ' already exists locally (points at ' + git.tagCommit(root, tag).slice(0, 12) + ')'
    });
  }
  if (!fs.existsSync(notesAbs)) {
    blockers.push({ code: 'notes-missing', why: notesAbs + ' — gh release create uses it as --notes-file' });
  }

  const head = git.head(root);
  const commitPaths = o.commitPaths && o.commitPaths.length ? o.commitPaths.slice() : ['VERSION', 'README.md'];

  actions.push({
    id: 'commit',
    label: ACTION_LABEL.commit,
    command: 'git add -- ' + commitPaths.join(' ') + ' && git commit -m ' + JSON.stringify(o.commitMessage || ('release: InternalBeyond ' + target)),
    cwd: root,
    irreversible: IRREVERSIBLE.commit,
    evidence: { paths: commitPaths, head: head.commit },
    preconditions: [
      { ok: commitPaths.length > 0, why: 'at least one path must be committed (explicit paths only; never `git add -A`)' }
    ]
  });
  actions.push({
    id: 'push',
    label: ACTION_LABEL.push,
    command: 'git push ' + remote + ' ' + branch,
    cwd: root,
    irreversible: IRREVERSIBLE.push,
    evidence: { remote: remote, branch: branch, remoteUrl: git.remoteUrl(root, remote), head: head.commit },
    preconditions: [{ ok: !!git.remoteUrl(root, remote), why: 'remote ' + remote + ' must exist' }]
  });
  actions.push({
    id: 'tag',
    label: ACTION_LABEL.tag,
    command: 'git tag -a ' + tag + ' -m ' + JSON.stringify('InternalBeyond ' + tag) + ' ' + head.commit.slice(0, 12),
    cwd: root,
    irreversible: IRREVERSIBLE.tag,
    evidence: { tag: tag, commit: head.commit },
    preconditions: [{ ok: !!head.commit, why: 'HEAD must resolve' }]
  });
  actions.push({
    id: 'pushTag',
    label: ACTION_LABEL.pushTag,
    command: 'git push ' + remote + ' ' + tag,
    cwd: root,
    irreversible: IRREVERSIBLE.pushTag,
    evidence: { tag: tag, remote: remote },
    preconditions: [{ ok: !!git.remoteUrl(root, remote), why: 'remote ' + remote + ' must exist' }]
  });
  actions.push({
    id: 'releaseCreate',
    label: ACTION_LABEL.releaseCreate,
    command: 'gh release create ' + tag + ' ' + JSON.stringify(path.relative(root, artifact).split(path.sep).join('/')) +
      ' ' + JSON.stringify(path.relative(root, sums).split(path.sep).join('/')) +
      ' --title ' + JSON.stringify('InternalBeyond ' + tag) + ' --notes-file ' + JSON.stringify(notesRel),
    cwd: root,
    irreversible: IRREVERSIBLE.releaseCreate,
    evidence: { artifact: artifact, artifactSha256: artifactSha, sums: sums, sumsSha256: sumsSha },
    preconditions: [
      { ok: artifactExists, why: 'the installer must exist' },
      { ok: sumsExists, why: 'SHA256SUMS.txt must exist' },
      { ok: fs.existsSync(notesAbs), why: 'the release-notes file must exist' },
      { ok: !!repo.manifest.validate(manifestObj || {}).ok, why: 'the manifest must already validate' }
    ]
  });
  actions.push({
    id: 'manifestUpload',
    label: ACTION_LABEL.manifestUpload,
    command: 'gh release upload ' + tag + ' ' + JSON.stringify(path.relative(root, manifest).split(path.sep).join('/')),
    cwd: root,
    irreversible: IRREVERSIBLE.manifestUpload,
    evidence: { manifest: manifest, manifestSha256: manifestSha, version: manifestObj && manifestObj.version, channel: manifestObj && manifestObj.channel },
    preconditions: [
      { ok: manifestExists, why: 'the manifest must exist' },
      { ok: !!manifestObj, why: 'the manifest must parse' },
      { ok: String(manifestObj && manifestObj.installer && manifestObj.installer.sha256).toLowerCase() === artifactSha,
        why: 'the manifest sha256 must equal the artifact bytes being uploaded' }
    ]
  });

  /* The publish fingerprint: a confirmation is bound to these bytes, so it
     cannot be replayed against a different artifact. */
  const fingerprint = crypto.createHash('sha256')
    .update([target, artifactSha, sumsSha, manifestSha].join('|'))
    .digest('hex');

  return {
    ok: blockers.length === 0,
    blockers: blockers,
    actions: actions,
    artifact: { path: artifact, name: name, bytes: sizeOf(artifact), sha256: artifactSha, exists: artifactExists },
    sums: { path: sums, sha256: sumsSha, exists: sumsExists },
    manifest: { path: manifest, sha256: manifestSha, exists: manifestExists, version: manifestObj && manifestObj.version, url: manifestObj && manifestObj.installer && manifestObj.installer.url },
    tag: tag,
    branch: branch,
    remote: remote,
    remoteUrl: git.remoteUrl(root, remote),
    fingerprint: fingerprint,
    notesFile: notesRel,
    commitPaths: commitPaths
  };
}

/*
 * The confirmation the GUI must echo back. It carries the fingerprint, so a
 * confirmation for one artifact cannot authorize uploading another.
 */
function confirmToken(fingerprint, actions) {
  return crypto.createHash('sha256')
    .update(fingerprint + '|' + (actions || []).join(','))
    .digest('hex');
}

/*
 * Execute the plan. `confirmation` must equal confirmToken(plan.fingerprint,
 * selectedActions) — anything else is refused without running a single command.
 *
 * Returns { status, results:[...], published:bool, blockers:[...] }.
 * A failure STOPS the sequence (order is a contract) and leaves every sealed
 * local artifact untouched.
 */
async function run(ctx) {
  const repo = ctx.repo;
  const log = ctx.log;
  const o = ctx.options || {};
  const stage = 'PUBLISH';
  const blockers = [];
  const facts = {};
  const target = String(o.target || '').trim();

  const item = function (key, status, title, expected, actual, evidence, why, detail) {
    log.item(key, { stage: stage, status: status, title: title, expected: expected, actual: actual, evidence: evidence, why: why, detail: detail });
    if (status === STAGE_STATUS.BLOCKED) blockers.push({ code: key, title: title, expected: expected, actual: actual, evidence: evidence, why: why });
  };

  /* ── 1. refuse unless SEAL genuinely succeeded for these exact bytes ───── */
  const sealStatus = (ctx.stageStatuses && ctx.stageStatuses.SEAL) || STAGE_STATUS.PENDING;
  if (sealStatus !== STAGE_STATUS.OK && sealStatus !== STAGE_STATUS.WARN) {
    item('publish-gate', STAGE_STATUS.BLOCKED, 'Publish 前置：SEAL 已成功', 'SEAL status = ok', 'SEAL status = ' + sealStatus,
      'Release Builder 状态机', 'Publish 与 Build/Seal 分权：没有已封装的本地产物就绝不 push/tag/release');
    return { status: STAGE_STATUS.BLOCKED, blockers: blockers, results: [], published: false, facts: facts };
  }

  const p = buildPlan(repo, o);
  facts.plan = {
    fingerprint: p.fingerprint, tag: p.tag, branch: p.branch, remote: p.remote,
    artifact: p.artifact, manifest: p.manifest, actions: p.actions.map(function (a) { return a.id; })
  };

  /* Show the whole plan before anything runs. */
  log.event('PUBLISH plan (' + p.actions.length + ' actions, fingerprint ' + p.fingerprint.slice(0, 16) + '…)');
  item('publish-plan', p.ok ? STAGE_STATUS.OK : STAGE_STATUS.BLOCKED, 'PUBLISH 计划（执行前展示）',
    '每一步都是不可逆的外部动作，需要逐条确认',
    p.actions.length + ' 步 · fingerprint ' + p.fingerprint.slice(0, 16) + '…',
    'lib/publish.js buildPlan()',
    '顺序即契约：exe → SHA256SUMS.txt → update-stable.json(LAST)',
    p.actions.map(function (a) { return (a.irreversible ? '[IRREVERSIBLE] ' : '[local] ') + a.id + ': ' + a.command; }).join('\n'));

  if (!p.ok) {
    for (const b of p.blockers) {
      item('publish-pre:' + b.code, STAGE_STATUS.BLOCKED, 'Publish 前置条件', '满足', b.code, b.why || '', '缺少前提时绝不执行任何发布动作');
    }
    return { status: STAGE_STATUS.BLOCKED, blockers: blockers, results: [], published: false, facts: facts, plan: p };
  }

  /* ── 2. the confirmation ──────────────────────────────────────────────── */
  const selected = (o.actions && o.actions.length ? o.actions : ACTIONS.filter(function (a) { return a !== 'releaseUpload'; }))
    .filter(function (a) { return ACTIONS.indexOf(a) >= 0; });
  const expectedToken = confirmToken(p.fingerprint, selected);
  const given = String(o.confirmation || '');
  if (given !== expectedToken) {
    item('publish-confirm', STAGE_STATUS.BLOCKED, 'Publish 显式确认', 'confirmation == ' + expectedToken.slice(0, 16) + '…',
      given ? given.slice(0, 16) + '…' : '(none)',
      'lib/publish.js confirmToken()',
      '确认串绑定在产物字节的指纹上：它不能被复用到另一批字节，也不能被默认执行。' +
      'PUBLISH 必须由人在 GUI 上点第二次、看到将要执行的动作之后才会执行');
    return { status: STAGE_STATUS.BLOCKED, blockers: blockers, results: [], published: false, facts: facts, plan: p };
  }

  /* ── 3. execute, in order, stopping at the first failure ──────────────── */
  const results = [];
  let published = false;
  let stopped = false;
  const head = git.head(repo.root);
  const commitMessage = o.commitMessage || ('release: InternalBeyond ' + target);

  for (const id of selected) {
    if (stopped) {
      results.push({ id: id, ok: false, skipped: true, why: 'stopped after an earlier failure' });
      continue;
    }
    const act = p.actions.find(function (a) { return a.id === id; });
    if (!act) { results.push({ id: id, ok: false, skipped: true, why: 'unknown action' }); continue; }
    const bad = (act.preconditions || []).filter(function (c) { return !c.ok; });
    if (bad.length) {
      item('publish:' + id, STAGE_STATUS.BLOCKED, '动作 ' + id + ' 前置条件', '满足',
        bad.map(function (b) { return b.why; }).join(' | '), act.cwd, '前置条件不满足即停止');
      results.push({ id: id, ok: false, why: bad.map(function (b) { return b.why; }).join(' | ') });
      stopped = true;
      continue;
    }

    let r = null;
    if (id === 'commit') r = git.addAndCommit(repo.root, p.commitPaths, commitMessage);
    else if (id === 'push') r = git.pushBranch(repo.root, p.remote, p.branch);
    else if (id === 'tag') r = git.createTag(repo.root, p.tag, 'InternalBeyond ' + p.tag, head.commit);
    else if (id === 'pushTag') r = git.pushTag(repo.root, p.remote, p.tag);
    else if (id === 'releaseCreate') r = await ghReleaseCreate(p, log);
    else if (id === 'manifestUpload' || id === 'releaseUpload') r = await ghReleaseUpload(p, log);

    const ok = !!(r && r.ok);
    log.command({
      stage: stage, label: id, file: (id.indexOf('git') === 0 ? 'git' : (id === 'commit' || id === 'push' || id === 'tag' || id === 'pushTag') ? 'git' : 'gh'),
      args: (r && r.args) || [], cwd: repo.root, shell: false, exitCode: ok ? 0 : 1, ms: r && r.ms
    });
    item('publish:' + id, ok ? STAGE_STATUS.OK : STAGE_STATUS.BLOCKED,
      '动作 ' + id + '（' + (act.irreversible ? '不可逆' : '本地') + '）',
      '成功', ok ? '成功' : ('失败：' + ((r && (r.stderr || r.why)) || 'unknown')),
      act.command, ok ? '' : '失败即停止：已 Seal 的本地产物原样保留，绝不因为上传失败重新 build',
      (r && r.stdout ? String(r.stdout).slice(-1500) : ''));
    results.push({ id: id, ok: ok, stdout: (r && r.stdout) || '', stderr: (r && r.stderr) || '', why: (r && r.why) || '' });
    if (!ok) { stopped = true; continue; }
    if (id === 'manifestUpload' || id === 'releaseUpload') published = true;
  }

  /* ── 4. post-publish cross-check (docs/RELEASE.md §6 hard rule) ───────── */
  if (published) {
    item('publish-postcheck', STAGE_STATUS.OK, '发布后交叉核对（必做）',
      'fixture: GitHub asset digest == manifest.installer.sha256 == 本地实测',
      '清单已上传（LAST）——版本自此进入 Stable 通道',
      'https://github.com/' + repo.manifest.REPO + '/releases/tag/' + p.tag,
      '请在 Release 页面/API 上独立核对三个资产的 digest 与 size；三条任一不成立时唯一正确的动作是删掉 release 重来，' +
      '不要就地改清单（docs/RELEASE.md §6）。本工具不会自动删除 release。');
  }

  const status = blockers.length ? STAGE_STATUS.BLOCKED : STAGE_STATUS.OK;
  return { status: status, blockers: blockers, results: results, published: published, facts: facts, plan: p };
}

/* ── gh invocation (fixed argument arrays, shell:false) ──────────────────── */

async function ghReleaseCreate(p, log) {
  const env = require('./env.js');
  const ghPath = env.gh();
  if (!ghPath) return { ok: false, why: 'gh.exe not found', args: [] };
  /* Repo-relative asset paths, executed with cwd = repo root, so the command
     shown to the human and the argument array executed are the same list. */
  const root = repoRootOf(p);
  const rel = function (abs) { return path.relative(root, abs).split(path.sep).join('/'); };
  const finalArgs = [
    'release', 'create', p.tag,
    rel(p.artifact.path),
    rel(p.sums.path),
    '--title', 'InternalBeyond ' + p.tag,
    '--notes-file', p.notesFile
  ];
  const r = await env.spawnStream(ghPath, finalArgs, {
    cwd: root,
    timeoutMs: 30 * 60 * 1000,
    onLine: function (line, stream) { log.event((stream === 'stderr' ? 'gh stderr: ' : 'gh: ') + line); }
  });
  return { ok: r.code === 0, stdout: r.lines.map(function (l) { return l.text; }).join('\n'), stderr: r.error || '', args: finalArgs, ms: r.ms };
}

async function ghReleaseUpload(p, log) {
  const env = require('./env.js');
  const ghPath = env.gh();
  if (!ghPath) return { ok: false, why: 'gh.exe not found', args: [] };
  const root = repoRootOf(p);
  const relManifest = path.relative(root, p.manifest.path).split(path.sep).join('/');
  const args = ['release', 'upload', p.tag, relManifest];
  const r = await env.spawnStream(ghPath, args, {
    cwd: root,
    timeoutMs: 30 * 60 * 1000,
    onLine: function (line, stream) { log.event((stream === 'stderr' ? 'gh stderr: ' : 'gh: ') + line); }
  });
  return { ok: r.code === 0, stdout: r.lines.map(function (l) { return l.text; }).join('\n'), stderr: r.error || '', args: args, ms: r.ms };
}

/* <repo>/dist/<file> → <repo>. Derived from the artifact path so a plan can
   never be executed against a different root than the one it was built for. */
function repoRootOf(p) {
  const marker = path.sep + 'dist' + path.sep;
  const idx = p.artifact.path.indexOf(marker);
  return idx >= 0 ? p.artifact.path.slice(0, idx) : path.dirname(path.dirname(p.artifact.path));
}

module.exports = { run, buildPlan, confirmToken, ACTIONS, ACTION_LABEL, IRREVERSIBLE };
