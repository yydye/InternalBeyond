'use strict';

/*
 * Release Builder · BUILD
 *
 * BUILD is an orchestrator, not a second build authority. It does exactly one
 * external thing: it runs the repository's canonical build
 * (scripts/build-installer.ps1) once, streaming its output, and then looks on
 * disk for the artifact that run claims to have produced.
 *
 * What it never does:
 *   · it does not re-implement staging, auditing, ISCC invocation, hashing or
 *     manifest generation — all of that already exists in the canonical script;
 *   · it does not accept "the command returned 0" as proof that an installer
 *     exists (artifact discovery is a separate, real measurement);
 *   · it does not pass -SkipAudit / -SkipInstallAudit, which would silently
 *     downgrade the canonical gates (audit §10.4).
 *
 * The one write BUILD performs outside dist/ is the version bump: VERSION and
 * the single README version literal are moved to the target version BEFORE the
 * build, because the payload ships both and the release-claim gate (canonical
 * step 4) pins them to each other. That write is journalled and rolled back
 * byte-for-byte if anything fails — never with `git reset --hard`.
 */

const fs = require('fs');
const path = require('path');

const env = require('./env.js');
const plan = require('./plan.js');

const { STAGE_STATUS } = plan;

/* ── Journalled version bump ─────────────────────────────────────────────── */

function createTransaction(root) {
  const journal = [];
  const backups = new Map(); /* abs -> {existed, bytes} */
  const createdDirs = [];
  return {
    journal: journal,

    /* Record a file's current bytes before touching it. Idempotent per path. */
    willWrite: function (abs) {
      if (backups.has(abs)) return;
      let existed = false;
      let bytes = null;
      try {
        bytes = fs.readFileSync(abs);
        existed = true;
      } catch (e) { existed = false; }
      backups.set(abs, { existed: existed, bytes: bytes });
      journal.push({ path: abs, existed: existed, bytes: existed ? bytes.length : 0 });
    },

    trackedPaths: function () { return [...backups.keys()]; },

    /*
     * Restore every journalled file to its exact previous bytes, and remove
     * files that did not exist before. Reports each action; never throws.
     * This is the only rollback mechanism the builder has, and it cannot touch
     * anything that was not journalled first — so it can never destroy work the
     * user had in the tree.
     */
    rollback: function () {
      const actions = [];
      for (const [abs, prev] of backups) {
        try {
          if (prev.existed) {
            fs.writeFileSync(abs, prev.bytes);
            actions.push({ path: abs, action: 'restored', bytes: prev.bytes.length });
          } else if (fs.existsSync(abs)) {
            fs.unlinkSync(abs);
            actions.push({ path: abs, action: 'removed', bytes: 0 });
          } else {
            actions.push({ path: abs, action: 'absent', bytes: 0 });
          }
        } catch (e) {
          actions.push({ path: abs, action: 'failed: ' + String((e && e.message) || e), bytes: 0 });
        }
      }
      return actions;
    }
  };
}

function planBump(root, currentVersion, targetVersion) {
  const readmeFile = path.join(root, 'README.md');
  let readme = null;
  try { readme = fs.readFileSync(readmeFile, 'utf8'); } catch (e) { readme = null; }
  const out = { files: [], blockers: [], notes: [] };

  if (currentVersion === targetVersion) {
    out.notes.push('目标版本与 VERSION 相同：不修改 VERSION / README');
    return out;
  }

  out.files.push({
    file: path.join(root, 'VERSION'),
    rel: 'VERSION',
    kind: 'version',
    from: currentVersion,
    to: targetVersion
  });

  if (readme === null) {
    out.blockers.push({ code: 'readme-unreadable', why: 'README.md 无法读取，无法提升发行声明', evidence: readmeFile });
    return out;
  }
  const RE = /(当前版本\s*\*\*)(\d+\.\d+\.\d+)(\*\*)/;
  const m = RE.exec(readme);
  if (!m) {
    out.blockers.push({
      code: 'readme-claim-anchor-missing',
      why: 'README 里找不到「当前版本 **x.y.z**」锚点。release-claim 闸门在锚点消失时判失败（fail closed），' +
        '所以 BUILD 拒绝继续；请先把锚点恢复成文档里约定的那一行。',
      evidence: readmeFile
    });
    return out;
  }
  if (m[2] !== currentVersion) {
    out.blockers.push({
      code: 'readme-claim-mismatch',
      why: 'README 声明的当前版本 (' + m[2] + ') 与 VERSION (' + currentVersion + ') 不一致；' +
        'canonical 第 4 步会判失败，BUILD 先在这里停下，让人去改文案',
      evidence: readmeFile
    });
    return out;
  }
  out.files.push({
    file: readmeFile,
    rel: 'README.md',
    kind: 'readme-claim',
    from: m[2],
    to: targetVersion,
    /** pure transform, applied at commit time */
    apply: function (text) { return text.replace(RE, '$1' + targetVersion + '$3'); }
  });
  return out;
}

/* ── Artifact discovery ──────────────────────────────────────────────────── */

/*
 * Look for the installer the canonical build claims to have produced.
 * The name comes from the canonical adapter (never spelled here), and the
 * result carries the real bytes on disk — existence, size and PE version are
 * measured, not assumed.
 */
function discoverArtifact(repo, version, log, stage, fault) {
  const name = repo.assetName(version);
  const file = path.join(repo.root, 'dist', name);
  const rec = { name: name, path: file, exists: false, bytes: -1, sha256: '', pe: null, items: [] };
  const it = function (key, status, title, expected, actual, evidence, why, detail) {
    log.item(key, { stage: stage, status: status, title: title, expected: expected, actual: actual, evidence: evidence, why: why, detail: detail });
  };

  /*
   * COUNTERPROOF-ONLY fault injection. Inert unless the caller explicitly set
   * options.fault (tests/ only), so a real run can never take a branch that
   * exists to prove a branch works. See tests/test_release_builder_astages.js.
   */
  const effective = (function () {
    if (fault === 'wrong-artifact-name') return path.join(repo.root, 'dist', 'InternalBeyond-Setup-0.0.1.exe');
    return file;
  })();

  if (!fs.existsSync(effective)) {
    it('artifact-exists', STAGE_STATUS.BLOCKED, '构建产出存在', name, 'missing', effective,
      '构建命令返回之后**必须**在磁盘上找到产物；「命令返回 0 所以产物存在」是审计 §10.4 明确禁止的推定');
    return rec;
  }
  let st = null;
  try { st = fs.statSync(effective); } catch (e) { st = null; }
  if (!st || !st.isFile()) {
    it('artifact-exists', STAGE_STATUS.BLOCKED, '构建产出存在', '一个普通文件', 'not a file', effective,
      '产物路径不是一个文件');
    return rec;
  }
  rec.exists = true;
  rec.bytes = st.size;
  rec.path = effective;
  it('artifact-exists', STAGE_STATUS.OK, '构建产出存在', name, path.basename(effective) + ' · ' + st.size + ' B', effective);

  const min = repo.manifest.MIN_PLAUSIBLE_INSTALLER_BYTES;
  if (st.size < min || fault === 'tiny') {
    it('artifact-size', STAGE_STATUS.BLOCKED, '安装包大小合理', '≥ ' + min + ' B', st.size + ' B', effective,
      '载荷始终携带内置 Node 运行时（真实安装包约 48 MB）；低于下界说明这次产出不是安装包（截断/空文件）');
  } else {
    it('artifact-size', STAGE_STATUS.OK, '安装包大小合理', '≥ ' + min + ' B', st.size + ' B', effective);
  }

  const pe = repo.pe.readPeVersion(effective);
  rec.pe = pe;
  if (!pe.ok) {
    if (fault === 'pe-version') {
      it('artifact-pe', STAGE_STATUS.OK, '安装包 PE 版本可读', 'ProductVersion = ' + version,
        'ProductVersion ' + '0.0.1' + '（注入的对照故障）', effective, '对照证明用：假装 PE 版本是错的');
      rec.pe = { ok: true, productVersion: '0.0.1', fileVersion: '0.0.1.0', productVersionFixed: '0.0.1.0', fileVersionFixed: '0.0.1.0', why: null };
    } else {
      it('artifact-pe', STAGE_STATUS.BLOCKED, '安装包 PE 版本可读', 'readPeVersion().ok = true', pe.why, effective,
        '读不出 PE 版本就无法证明「字节对但版本错」没有发生');
    }
  } else {
    it('artifact-pe', STAGE_STATUS.OK, '安装包 PE 版本可读',
      'ProductVersion = ' + version, 'ProductVersion ' + pe.productVersion + ' · FileVersion ' + pe.fileVersion,
      effective, 'PE 版本由 canonical 第 7 步交叉核对过；VERIFY 会再独立核对一次');
  }
  return rec;
}

/* ── The canonical invocation ────────────────────────────────────────────── */

/*
 * The one canonical build command, assembled from the repository's own
 * documented invocation (docs/RELEASE.md §1):
 *
 *   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\build-installer.ps1 \
 *     -NotesFile docs\release-notes\<target>.md -MinimumVersion <policy>
 *
 * Notes:
 *   · -ReleasedAt is deliberately NOT passed: the build's clock is not the
 *     release moment (docs/RELEASE.md §4). SEAL decides that field.
 *   · No -SkipAudit, ever.
 *   · -InstallAudit is not passed: the P7 budget allows exactly one real install
 *     per built installer and that is an explicit, separate decision.
 */
function canonicalBuildArgs(repo, options) {
  const script = path.join(repo.root, 'scripts', 'build-installer.ps1');
  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script];
  const notesFile = options.notesFile;
  if (notesFile) args.push('-NotesFile', notesFile);
  if (options.minimumVersion) args.push('-MinimumVersion', String(options.minimumVersion));
  /* COUNTERPROOF-ONLY: the *stub* build script in the test fixture accepts this
     parameter. The real scripts/build-installer.ps1 has no -Fault parameter and
     would simply refuse the argument, so this cannot reach a real build. */
  if (options.fault) args.push('-Fault', String(options.fault));
  return args;
}

/*
 * run(ctx) → { status, blockers, artifact, facts }
 */
async function run(ctx) {
  const repo = ctx.repo;
  const log = ctx.log;
  const o = ctx.options || {};
  const stage = 'BUILD';
  const blockers = [];
  const facts = {};
  const target = String(o.target || '').trim();

  const v = repo.version();
  if (!v.ok) {
    log.item('build-precondition', { stage: stage, status: STAGE_STATUS.BLOCKED, title: 'VERSION 可解析', expected: 'MAJOR.MINOR.PATCH', actual: v.error, evidence: v.path, why: 'CHECK 应已阻断' });
    return { status: STAGE_STATUS.BLOCKED, blockers: [{ code: 'version-invalid', why: v.error }], artifact: null, facts: facts };
  }
  const currentVersion = v.version;

  /* 1. plan the version bump ------------------------------------------------- */
  const tx = createTransaction(repo.root);
  const bump = planBump(repo.root, currentVersion, target);
  facts.bump = { from: currentVersion, to: target, files: bump.files.map(function (f) { return f.rel; }) };
  if (bump.blockers.length) {
    for (const b of bump.blockers) {
      log.item('bump:' + b.code, { stage: stage, status: STAGE_STATUS.BLOCKED, title: '版本提升前置条件', expected: '满足', actual: b.code, evidence: b.evidence, why: b.why });
      blockers.push(b);
    }
    return { status: STAGE_STATUS.BLOCKED, blockers: blockers, artifact: null, facts: facts };
  }
  if (bump.notes.length) log.event(bump.notes.join('; '));

  /* 2. commit the bump (journalled) ------------------------------------------ */
  if (currentVersion !== target) {
    for (const f of bump.files) tx.willWrite(f.file);
    try {
      fs.writeFileSync(path.join(repo.root, 'VERSION'), target + '\n', 'utf8');
      for (const f of bump.files) {
        if (!f.apply) continue;
        const text = fs.readFileSync(f.file, 'utf8');
        const next = f.apply(text);
        if (next === text) throw new Error('README bump produced no change');
        fs.writeFileSync(f.file, next, 'utf8');
      }
    } catch (e) {
      const actions = tx.rollback();
      log.item('bump-write', {
        stage: stage, status: STAGE_STATUS.BLOCKED, title: '版本提升写入', expected: '写入成功',
        actual: String((e && e.message) || e), evidence: 'VERSION / README.md',
        why: '写入失败，已按日志回滚', detail: JSON.stringify(actions)
      });
      blockers.push({ code: 'bump-write-failed', why: String((e && e.message) || e) });
      return { status: STAGE_STATUS.BLOCKED, blockers: blockers, artifact: null, facts: facts };
    }
    log.item('bump-write', {
      stage: stage, status: STAGE_STATUS.OK, title: '版本提升已写入（可回滚）',
      expected: currentVersion + ' → ' + target,
      actual: bump.files.map(function (f) { return f.rel; }).join(' + '),
      evidence: 'VERSION / README.md',
      detail: bump.files.map(function (f) { return f.rel + ': ' + f.from + ' → ' + f.to; }).join('\n')
    });
  } else {
    log.item('bump-write', { stage: stage, status: STAGE_STATUS.OK, title: '版本提升', expected: '不变', actual: '目标版本 == VERSION，未修改任何文件', evidence: 'VERSION' });
  }

  /* 3. the canonical build --------------------------------------------------- */
  const pwshPath = env.pwsh();
  const nodeRes = env.node(repo.root);
  /*
   * The notes path comes from ctx.notesFile — the ONE place lib/runner.js decides
   * which file this release declares — and only falls back to an explicit option.
   * It is not taken from ctx.options: `options` is built for the stages as a copy
   * of the user's options and has never carried `notesFile`, so reading it there
   * silently dropped -NotesFile from the canonical command and produced a release
   * whose manifest omits `notes` (users then see an update card with no release
   * notes). Caught by running a real build and reading the manifest back.
   */
  const declared = ctx.notesFile || o.notesFile || '';
  const notesAbs = declared ? path.resolve(String(declared)) : '';
  const args = canonicalBuildArgs(repo, { notesFile: notesAbs, minimumVersion: o.minimumVersion, fault: o.fault });
  const cmdline = env.commandLine(pwshPath || 'powershell.exe', args);
  const started = Date.now();

  log.item('canonical-command', {
    stage: stage, status: STAGE_STATUS.OK, title: '将执行的 canonical 构建（唯一构建权威）',
    expected: 'scripts\\build-installer.ps1', actual: cmdline, evidence: 'docs/RELEASE.md §1',
    detail: [
      'cwd        : ' + repo.root,
      'node       : ' + (nodeRes.path || '(missing)') + '  [' + nodeRes.source + ']',
      'notesFile  : ' + (notesAbs || '(未提供 → 清单将省略 notes)'),
      'minimumVer : ' + (o.minimumVersion || plan.CANONICAL_MINIMUM_VERSION),
      'releasedAt : 不传（构建时刻不是发布时刻；docs/RELEASE.md §4）',
      '本脚本不使用 -SkipAudit / -SkipInstallAudit（绝不放宽 canonical 闸门）'
    ].join('\n')
  });

  let out = null;
  if (!pwshPath) {
    blockers.push({ code: 'no-powershell', why: 'powershell.exe 未解析到' });
    log.item('canonical-run', { stage: stage, status: STAGE_STATUS.BLOCKED, title: 'canonical 构建', expected: '执行', actual: 'no powershell.exe', evidence: 'lib/env.js', why: '无法执行 canonical 构建' });
  } else {
    out = await env.spawnStream(pwshPath, args, {
      cwd: repo.root,
      timeoutMs: typeof o.buildTimeoutMs === 'number' ? o.buildTimeoutMs : 60 * 60 * 1000,
      signal: ctx.signal,
      onLine: function (line, stream) {
        /* Streamed line by line. `log.redact` runs inside push(), so a
           credential in the canonical output never lands in the log. */
        log.event((stream === 'stderr' ? 'stderr: ' : '') + line);
      }
    });
    log.command({
      stage: stage, label: 'canonical build', file: pwshPath, args: args, cwd: repo.root,
      shell: false, exitCode: out.code, ms: out.ms
    });
    facts.buildExitCode = out.code;
    facts.buildMs = out.ms;
  }

  const buildOk = !!(out && out.code === 0 && !out.spawnFailed);
  if (!buildOk) {
    log.item('canonical-exit', {
      stage: stage, status: STAGE_STATUS.BLOCKED, title: 'canonical 构建退出码',
      expected: '0', actual: out ? ('exit ' + out.code + (out.spawnFailed ? ' (spawn failed)' : '') + (out.error ? ' — ' + out.error : '')) : 'not run',
      evidence: 'dist\\build-compile.log（若已生成）',
      why: '构建失败即停止：不进入 VERIFY，不进入 SEAL，绝不更新 stable manifest'
    });
    blockers.push({ code: 'build-failed', why: 'canonical build exited ' + (out && out.code) });

    /* Roll the version bump back: a failed build must not leave the repository
       announcing a version that does not exist. */
    const actions = tx.rollback();
    log.item('rollback', {
      stage: stage, status: STAGE_STATUS.OK, title: '版本提升已回滚（构建失败）',
      expected: 'VERSION / README 回到构建前的字节', actual: actions.map(function (a) { return a.action; }).join(', '),
      evidence: 'lib/build.js 事务日志',
      detail: actions.map(function (a) { return a.action + ' ' + a.rel + ' ' + path.relative(repo.root, a.path); }).join('\n') +
        '\n（不使用 git reset --hard；只还原本事务记录过的文件）'
    });
    facts.rolledBack = actions;
    return { status: STAGE_STATUS.BLOCKED, blockers: blockers, artifact: null, facts: facts, transaction: tx };
  }

  log.item('canonical-exit', {
    stage: stage, status: STAGE_STATUS.OK, title: 'canonical 构建退出码',
    expected: '0', actual: 'exit 0 · ' + Math.round((out.ms || 0) / 1000) + ' s', evidence: cmdline
  });

  /* 4. artifact discovery (measured, never assumed) -------------------------- */
  const artifact = discoverArtifact(repo, target, log, stage, ctx.options.fault);
  facts.artifact = { path: artifact.path, name: artifact.name, bytes: artifact.bytes, exists: artifact.exists };
  if (!artifact.exists) blockers.push({ code: 'artifact-exists', why: artifact.path });
  if (artifact.exists && path.basename(artifact.path) !== repo.assetName(target)) {
    blockers.push({
      code: 'artifact-exists',
      why: 'discovered ' + path.basename(artifact.path) + ' but the canonical name is ' + repo.assetName(target)
    });
  }
  if (artifact.exists && artifact.bytes >= 0 && artifact.bytes < repo.manifest.MIN_PLAUSIBLE_INSTALLER_BYTES) {
    blockers.push({ code: 'artifact-size', why: artifact.bytes + ' bytes is below the plausible floor' });
  }
  if (artifact.exists && artifact.pe && !artifact.pe.ok) {
    blockers.push({ code: 'artifact-pe', why: artifact.pe.why });
  }

  const status = blockers.length ? STAGE_STATUS.BLOCKED : STAGE_STATUS.OK;
  return { status: status, blockers: blockers, artifact: artifact, facts: facts, transaction: tx };
}

module.exports = { run, createTransaction, planBump, discoverArtifact, canonicalBuildArgs };
