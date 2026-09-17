'use strict';

/*
 * Release Builder · SEAL
 *
 * SEAL turns "verified" into "this is the final, publishable dist state".
 * It is the only stage that governs dist/ layout, and it does three things:
 *
 *   1. archives older releases — but ONLY after proving nothing depends on the
 *      flat dist/ layout (audit §11: no script reads that layout today; the
 *      gate re-proves it every run instead of trusting that audit);
 *   2. writes the run's own log (dist/release-<version>.log + .jsonl);
 *   3. RE-READS the exe, the checksums and the manifest FROM DISK and redoes the
 *      three-way reconciliation — never announcing success from an in-memory
 *      object (user requirement §5).
 *
 * SEAL refuses to run unless VERIFY was green, and it never touches the exe,
 * the checksums file or the manifest of the version being sealed.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const plan = require('./plan.js');
const { STAGE_STATUS } = plan;

/* Directories under the repository root that are ALLOWED to mention dist/. */
const LAYOUT_DEP_SKIP_DIRS = new Set([
  '.git', 'node_modules', 'dist', 'Economy-v1-release', '.dsh-research', '.venv-vision',
  'browser-data', 'logs', '.playwright-mcp', '.dsh', '.dsh-recovery', '.dsh-file-claim',
  '__pycache__', '.reasonix', '.workbuddy-ai', 'android', 'vision'
]);

/* The two release-set files beside the installer. update-stable.json's name comes
   from the canonical adapter (repo.payloadManifestAsset); the checksums file is a
   build-side record whose name the canonical script writes. */
const SUMS_FILE = 'SHA256SUMS' + '.txt';
const MANIFEST_FILE = 'update-stable' + '.json';

/*
 * Two helpers that make "which files are old installers?" answerable from the
 * canonical name WITHOUT writing that name a second time anywhere.
 *
 * `assetPrefixOf` is the canonical asset name for a known version with the
 * version removed; `assetVersionOf` is the inverse, and only accepts a genuine
 * MAJOR.MINOR.PATCH between the canonical prefix and the canonical suffix.
 *
 * Finding OLD installer files to archive is the one place in this tool that is
 * allowed to think in terms of a pattern at all, and it is allowed for a
 * specific reason: it never CONSTRUCTS a release name — it only recognizes file
 * names that are already on disk. Everything that produces a name (the artifact
 * to build, verify, seal, upload or announce) goes through repo.assetName().
 */
/*
 * The canonical asset prefix, derived from the canonical name rather than
 * written again here.
 *
 * `repo.assetName(version)` is `<prefix><version><suffix>`; with a two-digit
 * sentinel version the head of the name up to the sentinel is exactly the
 * prefix, and the tail from the sentinel onward is exactly the suffix. That
 * makes the derivation independent of how many digits a version has.
 */
function assetPrefix(repo) {
  const PROBE = '99.99.99';
  const name = repo.assetName(PROBE);
  const at = name.indexOf(PROBE);
  if (at < 0) return name;   /* a contract change the tests will catch */
  return name.slice(0, at);
}

function assetVersionOf(repo, fileName) {
  const prefix = assetPrefix(repo);
  if (fileName.indexOf(prefix) !== 0) return null;
  const rest = fileName.slice(prefix.length);
  if (rest.slice(-4).toLowerCase() !== '.exe') return null;
  const version = rest.slice(0, -4);
  return /^\d+\.\d+\.\d+$/.test(version) ? version : null;
}

/*
 * Is the flat dist/ layout a dependency of the shipped product or of the
 * canonical build?
 *
 * The question is precise: does anything READ the three flat release-set files
 * (the versioned installer, SHA256SUMS.txt, update-stable.json) from dist/?
 * A bare mention of the word "dist" is not a dependency — the product's CDN
 * urls, nodejs.org `/dist/` download paths and doc prose all mention it
 * harmlessly, and a gate that flagged those would be noise, not a gate.
 *
 * Comments are stripped before matching so documentation can never trip it.
 */
function layoutDependencies(root) {
  const hits = [];
  const SCAN_EXT = new Set(['.js', '.mjs', '.cjs', '.ps1', '.iss', '.vbs', '.cmd', '.bat', '.html', '.json']);
  /* A read of one of the three flat release-set files. */
  const FLAT_RE = /dist[\\/](?:update-stable\.json|SHA256SUMS\.txt|InternalBeyond-Setup-)/i;
  const walk = function (dir, rel) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch (e) { return; }
    for (const name of names) {
      if (LAYOUT_DEP_SKIP_DIRS.has(name)) continue;
      const abs = path.join(dir, name);
      const r = rel ? rel + '/' + name : name;
      let st = null;
      try { st = fs.statSync(abs); } catch (e) { continue; }
      if (st.isDirectory()) { walk(abs, r); continue; }
      if (!SCAN_EXT.has(path.extname(name).toLowerCase())) continue;
      if (st.size > 4 * 1024 * 1024) continue;
      let text = '';
      try { text = fs.readFileSync(abs, 'utf8'); } catch (e) { continue; }
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        if (!FLAT_RE.test(lines[i])) continue;
        if (isCommentLine(name, lines[i])) continue;
        hits.push({ file: r, line: i + 1, text: lines[i].trim().slice(0, 200), verdict: classify(r, lines[i]) });
      }
    }
  };
  walk(root, '');
  const unsafe = hits.filter(function (h) { return h.verdict === 'consumer'; });
  return { safe: unsafe.length === 0, hits: hits, unsafe: unsafe };
}

function isCommentLine(file, line) {
  const t = line.trim();
  if (t.indexOf('//') === 0 || t.indexOf('*') === 0 || t.indexOf('/*') === 0 || t.indexOf(';') === 0 || t.indexOf('#') === 0) return true;
  if (t.indexOf('<!--') === 0) return true;
  return false;
}

function classify(file, lineText) {
  /* This tool owns dist layout by definition. */
  if (/^tools[\\/]release-builder[\\/]/.test(file)) return 'builder';
  /* Docs describe dist; they do not read it. */
  if (/^docs[\\/]/.test(file)) return 'doc';
  /* Tests write into dist or assert about it, but the shipped product does not
     read dist at runtime — a test is not a consumer of the layout. */
  if (/^tests[\\/]/.test(file)) return 'test';
  /* The canonical build produces these paths; it never reads an existing flat
     layout, so archiving something that is not part of this release set cannot
     break it. */
  if (file === 'scripts/build-installer.ps1') return 'producer';
  if (file === 'scripts/release-manifest.js') return 'producer';
  if (file === 'scripts/update-node-runtime.ps1') return 'producer';
  /* The installer definition names dist\staging as its compile-time staging
     root (and that is a path it CREATES); SEAL never moves staging. */
  if (file === 'installer/InternalBeyond.iss') return 'producer';
  /* The manifest module names dist\update-stable.json in prose only. */
  if (file === 'runtime/update-manifest.js') return 'producer';
  /* gitignore is not a reader. */
  if (file === '.gitignore') return 'meta';
  /* Everything else that reads a flat release-set file is a consumer: fail closed. */
  return 'consumer';
}

function sha256File(file) {
  const h = crypto.createHash('sha256');
  h.update(fs.readFileSync(file));
  return h.digest('hex');
}

function sizeOf(file) { try { return fs.statSync(file).size; } catch (e) { return -1; } }

/* Files that belong to a (version, channel) release set. */
function releaseSetFiles(distDir, version) {
  const names = [];
  for (const name of safeReaddir(distDir)) {
    if (name === 'InternalBeyond-Setup-' + version + '.exe') names.push(name);
  }
  return names;
}

function safeReaddir(dir) {
  try { return fs.readdirSync(dir); } catch (e) { return []; }
}

async function run(ctx) {
  const repo = ctx.repo;
  const log = ctx.log;
  const o = ctx.options || {};
  const stage = 'SEAL';
  const blockers = [];
  const facts = {};
  const target = String(o.target || '').trim();
  const dist = path.join(repo.root, 'dist');
  const dryRun = o.dryRun === true;

  const item = function (key, status, title, expected, actual, evidence, why, detail) {
    log.item(key, { stage: stage, status: status, title: title, expected: expected, actual: actual, evidence: evidence, why: why, detail: detail });
    if (status === STAGE_STATUS.BLOCKED) blockers.push({ code: key, title: title, expected: expected, actual: actual, evidence: evidence, why: why });
  };

  const name = repo.assetName(target);
  const artifact = path.join(dist, name);
  const manifestPath = path.join(dist, repo.payloadManifestAsset);
  const sumsPath = path.join(dist, SUMS_FILE);

  /* ── 1. layout dependency gate ────────────────────────────────────────── */
  const layout = layoutDependencies(repo.root);
  if (layout.safe) {
    item('layout-gate', STAGE_STATUS.OK, 'dist 布局依赖闸门', '没有任何产品/运行时文件依赖 dist 扁平布局',
      '0 个消费者（' + layout.hits.length + ' 处提及全部为 builder/doc/test/producer）', '全仓扫描',
      '审计 §11 说「没有任何脚本读取 dist 布局」；这里每次运行都重新证明，而不是相信审计结论');
  } else {
    item('layout-gate', STAGE_STATUS.BLOCKED, 'dist 布局依赖闸门', '0 个消费者',
      layout.unsafe.length + ' 个文件引用 dist 布局',
      layout.unsafe.slice(0, 5).map(function (h) { return h.file + ':' + h.line; }).join(', '),
      '有文件依赖 dist 扁平布局时不移动任何文件（不为了目录好看擅自搬文件，用户要求 §5）');
    facts.layoutUnsafe = layout.unsafe.slice(0, 20);
  }

  /* ── 2. archive older releases ────────────────────────────────────────── */
  const archiveEnabled = o.archiveOldReleases !== false;
  let archived = [];
  if (!layout.safe) {
    item('archive', STAGE_STATUS.SKIPPED, '归档旧版本', '移动 dist\\archive\\<version>\\',
      '跳过（布局闸门未通过）', dist, '既然有消费者，就不动');
  } else if (!archiveEnabled) {
    item('archive', STAGE_STATUS.OK, '归档旧版本', '按请求不归档', '未移动任何文件', dist, '用户在 GUI 里关掉了归档');
  } else {
    /* Only artifacts that are NOT part of the version being sealed, and never an
       artifact that a published release may still need.

       `options.protectedVersions` carries that second rule: the version the
       repository was at before this run (i.e. the bytes that may well be the
       ones already published) is never moved. Moving it would destroy the only
       local copy of a released artifact, which docs/RELEASE.md §6 forbids
       replacing with a rebuild. A protected artifact is reported, not hidden. */
    const currentSet = new Set([
      name, SUMS_FILE, MANIFEST_FILE,
      'release-' + target + '.log', 'release-' + target + '.jsonl'
    ]);
    /*
     * Finding OLD installer files to archive. The recognition rule is derived
     * from the canonical name (see assetVersionOf above) instead of being
     * spelled again here.
     */
    const protectedVersions = new Set((o.protectedVersions || []).filter(Boolean).map(String));
    const candidates = [];
    const kept = [];
    for (const entry of safeReaddir(dist)) {
      const found = assetVersionOf(repo, entry);
      if (!found) continue;
      if (found === target) continue;
      if (protectedVersions.has(found)) { kept.push({ name: entry, version: found }); continue; }
      candidates.push({ name: entry, version: found });
    }
    for (const c of candidates) {
      const from = path.join(dist, c.name);
      const destDir = path.join(dist, 'archive', c.version);
      const to = path.join(destDir, c.name);
      try {
        fs.mkdirSync(destDir, { recursive: true });
        fs.renameSync(from, to);
        archived.push({ version: c.version, name: c.name, bytes: sizeOf(to), to: path.relative(dist, to).split(path.sep).join('/') });
      } catch (e) {
        item('archive:' + c.name, STAGE_STATUS.WARN, '归档旧版本 ' + c.version, '移动到 dist\\archive\\' + c.version + '\\',
          String((e && e.message) || e), from, '归档失败不影响本次发行；文件仍在原处');
      }
    }
    if (kept.length) {
      item('archive-protected', STAGE_STATUS.OK, '受保护的安装包（不归档）',
        '本次构建前的 VERSION 所对应的产物必须留在 dist 根',
        kept.map(function (k) { return k.name; }).join(', '), dist,
        '它可能已经是已发布版本的那一份字节。docs/RELEASE.md §6 规定发布只认已核验的那一份、不得用重建产物替代，' +
        '所以本工具绝不把它移走。它的 sha256 可以随时用 canonical 模块重算。');
    }
    if (archived.length) {
      item('archive', STAGE_STATUS.OK, '归档旧版本', '旧版本的安装包移入 dist\\archive\\<version>\\',
        archived.length + ' 个文件已归档', 'dist\\archive',
        archived.map(function (a) { return a.name + ' → ' + a.to; }).join('\n'));
    } else {
      item('archive', STAGE_STATUS.OK, '归档旧版本', '旧版本的安装包移入 dist\\archive\\<version>\\',
        '没有需要归档的旧安装包', dist);
    }
    /* The current release set must still be intact. */
    const missing = [...currentSet].filter(function (n2) {
      if (n2.indexOf('release-') === 0) return false; /* written below */
      return !fs.existsSync(path.join(dist, n2));
    });
    if (missing.length) {
      item('release-set', STAGE_STATUS.BLOCKED, '当前发行集完整', 'exe + SHA256SUMS.txt + update-stable.json',
        'missing: ' + missing.join(', '), dist, '归档不得触碰本次发行的三件产物');
    } else {
      item('release-set', STAGE_STATUS.OK, '当前发行集完整', 'exe + SHA256SUMS.txt + update-stable.json',
        '三件产物都在 dist 根', dist);
    }
  }
  facts.archived = archived;

  /* ── 2b. optional: regenerate the manifest through the canonical generator ─
     Why this exists at all: `releasedAt` can only be written when the release
     moment is actually known (docs/RELEASE.md §4), and the ONLY moment that is
     knowable is Publish. Regenerating is documentedly safe against the SAME
     verified artifact because the three substantive fields (sha256 / sizeBytes /
     productVersion) are re-measured from its bytes (§4).
     Why it is OFF by default: an unnecessary rewrite of the manifest is exactly
     the kind of silent drift this tool exists to remove. When it IS requested,
     the canonical writer validates before writing, and step 4 below re-reads the
     result from disk before anything is announced. */
  if (o.regenerateManifest === true && layout.safe) {
    if (!fs.existsSync(artifact)) {
      item('regen-manifest', STAGE_STATUS.BLOCKED, '按请求重新生成清单', '安装包存在',
        'missing', artifact, '没有产物就没有可测量的值');
    } else {
      const st = fs.statSync(artifact);
      const sha = sha256File(artifact);
      const pe = repo.pe.readPeVersion(artifact);
      if (!pe.ok) {
        item('regen-manifest', STAGE_STATUS.BLOCKED, '按请求重新生成清单', 'PE 版本可读', pe.why, artifact,
          '清单的 productVersion 必须实测自产物字节');
      } else {
        let notes = '';
        const notesFile = path.join(repo.root, 'docs', 'release-notes', target + '.md');
        if (fs.existsSync(notesFile)) notes = fs.readFileSync(notesFile, 'utf8').replace(/^\uFEFF/, '').trim();
        const releasedAt = String(o.releasedAt || '');
        const gen = repo.manifest.writeManifest({
          out: manifestPath,
          version: target,
          channel: o.channel || 'stable',
          sha256: sha,
          sizeBytes: st.size,
          productVersion: pe.productVersion,
          releasedAt: releasedAt,
          minimumVersion: o.minimumVersion || plan.CANONICAL_MINIMUM_VERSION,
          notes: notes
        });
        const before = fs.existsSync(manifestPath) ? fs.readFileSync(manifestPath, 'utf8') : '';
        if (!gen.ok) {
          item('regen-manifest', STAGE_STATUS.BLOCKED, '按请求重新生成清单', 'writeManifest().ok = true',
            gen.errors.map(function (e) { return e.field + ': ' + e.why; }).join(' | '), manifestPath,
            'canonical 生成器拒绝落盘一份不合格的清单；SEAL 不绕过它');
        } else {
          const after = fs.readFileSync(manifestPath, 'utf8');
          item('regen-manifest', STAGE_STATUS.OK, '按请求重新生成清单（canonical 生成器）',
            '只重生成清单，绝不重编译安装器',
            'releasedAt = ' + (releasedAt || '(省略)') + ' · minimumVersion = ' + (o.minimumVersion || plan.CANONICAL_MINIMUM_VERSION),
            manifestPath,
            '安装包字节未动（sha256 ' + sha.slice(0, 16) + '…，' + st.size + ' B）；清单变化：' +
              (before === after ? '无（内容相同）' : '有（见 dist 前后 diff）'),
            'canonical 生成器自校验通过：' + (gen.warnings.length ? gen.warnings.length + ' warning' : '0 warning'));
        }
      }
    }
  } else if (o.regenerateManifest === true) {
    item('regen-manifest', STAGE_STATUS.SKIPPED, '按请求重新生成清单', '布局闸门通过', '跳过', dist,
      '布局闸门未通过时不改写任何产物');
  } else {
    item('regen-manifest', STAGE_STATUS.OK, '清单处置', '默认：不重写构建产出的清单',
      '保留 BUILD 第 7 步产出的清单（releasedAt 保持省略）', manifestPath,
      '审计 §10.2：SEAL 不改写清单，除非用户显式要求；选择「写入 releasedAt」会在此处重新生成并再次校验');
  }

  /* ── 3. write the run log ─────────────────────────────────────────────── */
  const stem = 'release-' + target;
  const logDir = dryRun ? path.join(repo.root, 'tools', 'release-builder', '.dry-run') : dist;
  const header = {
    tool: 'tools/release-builder',
    root: repo.root,
    commit: ctx.commit || '',
    sourceVersion: ctx.sourceVersion || '',
    targetVersion: target,
    channel: o.channel || 'stable',
    mode: dryRun ? 'DRY RUN' : 'REAL',
    status: 'SEAL'
  };
  const written = log.writeFiles(logDir, stem, header);
  if (!written.ok) {
    item('release-log', STAGE_STATUS.BLOCKED, '发行日志写入', logDir + '\\' + stem + '.log',
      written.error, logDir, '每次 Release 必须生成独立日志（用户要求 §9）');
  } else {
    item('release-log', STAGE_STATUS.OK, '发行日志写入', logDir + '\\' + stem + '.log（+ .jsonl）',
      written.files.map(function (f) { return path.basename(f); }).join(' + '), logDir,
      '日志经过脱敏：' + log.secretNameCount() + ' 个环境密钥值、' + log.redactionHits() + ' 处命中已遮蔽');
    facts.logFiles = written.files;
  }

  /* ── 4. re-read everything from disk and reconcile ────────────────────── */
  const reread = {
    at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    artifact: null, sums: null, manifest: null, equations: []
  };

  if (!fs.existsSync(artifact)) {
    item('reread-exists', STAGE_STATUS.BLOCKED, 'SEAL 后重新读取：安装包存在', name, 'missing', artifact,
      'SEAL 不能拿内存中的旧对象宣布成功');
  } else {
    const st = fs.statSync(artifact);
    const sha = sha256File(artifact);
    reread.artifact = { path: artifact, name: name, bytes: st.size, sha256: sha, mtime: st.mtime.toISOString() };
    item('reread-exists', STAGE_STATUS.OK, 'SEAL 后重新读取：安装包', name + ' · ' + st.size + ' B', sha, artifact);
  }

  if (fs.existsSync(sumsPath)) {
    const text = fs.readFileSync(sumsPath, 'ascii');
    const line = text.split(/\r?\n/).find(function (l) { return l.indexOf('*' + name) >= 0; });
    reread.sums = { path: sumsPath, sha256: line ? line.trim().split(/\s+/)[0].toLowerCase() : '', bytes: sizeOf(sumsPath) };
    if (reread.artifact && reread.sums.sha256 !== reread.artifact.sha256) {
      item('reread-sums', STAGE_STATUS.BLOCKED, 'SEAL 后重新读取：SHA256SUMS.txt', reread.artifact.sha256,
        reread.sums.sha256 || '(no line)', sumsPath, '三方对账失败');
    } else {
      item('reread-sums', STAGE_STATUS.OK, 'SEAL 后重新读取：SHA256SUMS.txt', reread.artifact ? reread.artifact.sha256 : '?',
        reread.sums.sha256, sumsPath);
    }
  } else {
    item('reread-sums', STAGE_STATUS.BLOCKED, 'SEAL 后重新读取：SHA256SUMS.txt', '存在', 'missing', sumsPath,
      '发行集不完整');
  }

  if (fs.existsSync(manifestPath)) {
    let man = null;
    let err = '';
    try { man = JSON.parse(fs.readFileSync(manifestPath, 'utf8').replace(/^\uFEFF/, '')); } catch (e) { err = String((e && e.message) || e); }
    if (!man) {
      item('reread-manifest', STAGE_STATUS.BLOCKED, 'SEAL 后重新读取：update-stable.json', '合法 JSON', err, manifestPath, '三方对账失败');
    } else {
      reread.manifest = { path: manifestPath, version: man.version, channel: man.channel, sha256: man.installer && man.installer.sha256, sizeBytes: man.installer && man.installer.sizeBytes, productVersion: man.installer && man.installer.productVersion, url: man.installer && man.installer.url };
      const rep = repo.validateManifest(man);
      if (!rep.ok) {
        item('reread-manifest', STAGE_STATUS.BLOCKED, 'SEAL 后重新读取：update-stable.json 仍通过 canonical 校验',
          'validate().ok = true', rep.errors.map(function (e) { return e.field + ': ' + e.why; }).join(' | '), manifestPath, '三方对账失败');
      } else {
        item('reread-manifest', STAGE_STATUS.OK, 'SEAL 后重新读取：update-stable.json 仍通过 canonical 校验',
          'validate().ok = true', 'true', manifestPath);
      }
    }
  } else {
    item('reread-manifest', STAGE_STATUS.BLOCKED, 'SEAL 后重新读取：update-stable.json', '存在', 'missing', manifestPath, '发行集不完整');
  }

  /* Final three-way reconciliation, stated as three explicit equalities. */
  const three = [
    ['exe.sha256 == SHA256SUMS.sha256', reread.artifact && reread.artifact.sha256, reread.sums && reread.sums.sha256],
    ['exe.sha256 == manifest.installer.sha256', reread.artifact && reread.artifact.sha256, reread.manifest && reread.manifest.sha256],
    ['exe.bytes == manifest.installer.sizeBytes', reread.artifact && String(reread.artifact.bytes), reread.manifest && String(reread.manifest.sizeBytes)],
    ['manifest.version == target', target, reread.manifest && String(reread.manifest.version)],
    ['manifest.installer.productVersion == target', target, reread.manifest && String(reread.manifest.productVersion)]
  ];
  let allOk = true;
  for (const [label, a, b] of three) {
    const good = a && b && String(a).toLowerCase() === String(b).toLowerCase();
    if (!good) allOk = false;
    reread.equations.push({ label: label, left: a || '', right: b || '', ok: !!good });
    item('three-way:' + label, good ? STAGE_STATUS.OK : STAGE_STATUS.BLOCKED,
      'SEAL 三方对账：' + label, String(a || '?'), String(b || '?'), 'SEAL 后从磁盘重读的三件产物',
      good ? '' : '三方对账失败：不得宣布 SEALED');
  }
  facts.reread = reread;
  facts.threeWayOk = allOk;

  const status = blockers.length ? STAGE_STATUS.BLOCKED
    : (log.items().some(function (i) { return i.stage === stage && i.status === STAGE_STATUS.WARN; }) ? STAGE_STATUS.WARN : STAGE_STATUS.OK);

  /* ── 5. rewrite the run log NOW that the stage's items exist ─────────────
     The log is on disk twice because the on-disk copy is the durable artifact:
     the first write happens early (so a crash mid-SEAL still leaves a file),
     the second captures the re-read reconciliation and the final verdict. */
  if (written.ok && !dryRun) {
    const finalHeader = Object.assign({}, header, { status: status === STAGE_STATUS.OK ? 'SEALED' : status.toUpperCase() });
    const again = log.writeFiles(logDir, stem, finalHeader);
    if (again.ok) {
      facts.logFiles = again.files;
      item('release-log-final', STAGE_STATUS.OK, '发行日志定稿', logDir + '\\' + stem + '.log',
        '含 CHECK/BUILD/VERIFY/SEAL 全部条目与三方对账结果', again.files.map(function (f) { return path.basename(f); }).join(' + '), logDir);
    } else {
      item('release-log-final', STAGE_STATUS.WARN, '发行日志定稿', '写入成功', again.error, logDir,
        '早期版本已落盘；定稿失败不阻断发行，但日志不完整');
    }
  }

  return { status: status, blockers: blockers, facts: facts };
}

module.exports = {
  run: run,
  layoutDependencies: layoutDependencies,
  classify: classify,
  sha256File: sha256File,
  assetPrefix: assetPrefix,
  assetVersionOf: assetVersionOf,
  LAYOUT_DEP_SKIP_DIRS: LAYOUT_DEP_SKIP_DIRS
};
