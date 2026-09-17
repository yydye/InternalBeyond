'use strict';

/*
 * Release Builder · CHECK
 *
 * A check here is a measurement, not a green tick. Every result carries:
 *
 *    expected  what the release contract requires
 *    actual    what was measured, on this machine, now
 *    evidence  the file (or command) the measurement came from, so a human can
 *              go and look
 *
 * and only three shapes are possible: OK, WARN (a human must read this),
 * BLOCKED (fail closed — nothing downstream runs).
 *
 * The builder NEVER repairs what it finds. An unknown state is BLOCKED
 * (user requirement §2 and §7). The only writes CHECK performs are the ones a
 * probe genuinely needs (none, at present: it is read-only).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const env = require('./env.js');
const git = require('./git.js');
const plan = require('./plan.js');
const notes = require('./notes.js');

const { STAGE_STATUS } = plan;

const REQUIRED_CONTRACT_FILES = [
  { rel: 'runtime/product-version.js', why: 'the one version source reader' },
  { rel: 'runtime/update-manifest.js', why: 'U1: the one manifest schema / URL constructor / validator' },
  { rel: 'runtime/update-check.js', why: 'U2: the one update-check runtime' },
  { rel: 'runtime/update-transport.js', why: 'U2/U3: the one shared HTTPS transport and fallback gate' },
  { rel: 'runtime/update-install.js', why: 'U3: the one download / verify / install runtime' },
  { rel: 'runtime/pe-version.js', why: 'U3: the one PE version reader' },
  { rel: 'scripts/release-manifest.js', why: 'the payload whitelist' },
  { rel: 'scripts/release-audit.js', why: 'content / secret / release-claim audit' },
  { rel: 'scripts/build-installer.ps1', why: 'the canonical build' },
  { rel: 'installer/InternalBeyond.iss', why: 'the canonical installer definition' },
  { rel: 'installer/runtime-pin.json', why: 'the bundled Node runtime pin' },
  { rel: 'installer/languages/ChineseSimplified.isl', why: 'installer language file (canonical preflight requires it)' },
  { rel: 'installer/tools/ib-stop.js', why: 'installer stop helper (canonical preflight requires it)' },
  { rel: 'LICENSE', why: 'canonical preflight requires it' },
  { rel: 'LICENSES/THIRD-PARTY-NODE.md', why: 'canonical preflight requires it' },
  { rel: 'VERSION', why: 'the one release version source' },
  { rel: 'README.md', why: 'ships in the payload and carries the release claim gate' },
  { rel: 'docs/RELEASE.md', why: 'the release contract this tool implements' }
];

const REQUIRED_TESTS = [
  { rel: 'tests/test_update_manifest.js', why: 'U1 contract' },
  { rel: 'tests/test_update_check.js', why: 'U2 runtime' },
  { rel: 'tests/test_update_install.js', why: 'U3 runtime' },
  { rel: 'tests/test_pe_version.js', why: 'U3 PE reader' },
  { rel: 'tests/test_installer.js', why: 'installer / payload contract' }
];

function sha256File(file) {
  const h = crypto.createHash('sha256');
  h.update(fs.readFileSync(file));
  return h.digest('hex');
}

function sizeOf(file) {
  try { return fs.statSync(file).size; } catch (e) { return -1; }
}

function item(log, stage, key, fields) {
  return log.item(key, Object.assign({ stage: stage }, fields));
}

/*
 * run(ctx) → { status, blockers:[], checks:{...}, plan }
 *
 * ctx: { repo, log, options:{ target, channel, acknowledge, probeNetwork, minimumVersion } }
 */
async function run(ctx) {
  const repo = ctx.repo;
  const log = ctx.log;
  const o = ctx.options || {};
  const stage = 'CHECK';
  const blockers = [];
  const facts = {};

  const blocked = function (key, title, expected, actual, evidence, why) {
    item(log, stage, key, { status: STAGE_STATUS.BLOCKED, title: title, expected: expected, actual: actual, evidence: evidence, why: why });
    blockers.push({ code: key, title: title, expected: expected, actual: actual, evidence: evidence, why: why });
  };
  const ok = function (key, title, expected, actual, evidence, detail) {
    item(log, stage, key, { status: STAGE_STATUS.OK, title: title, expected: expected, actual: actual, evidence: evidence, detail: detail });
    facts[key] = actual;
  };
  const warn = function (key, title, expected, actual, evidence, why) {
    item(log, stage, key, { status: STAGE_STATUS.WARN, title: title, expected: expected, actual: actual, evidence: evidence, why: why });
    log.warn(key, title + ': ' + why, { stage: stage, expected: expected, actual: actual, evidence: evidence });
  };

  const root = repo.root;
  const dist = path.join(root, 'dist');

  /* ── 1. repo root ─────────────────────────────────────────────────────── */
  ok('repo-root', '仓库根目录', '包含 InternalBeyond 发布链的检出目录', root, 'tools/release-builder（自动探测）',
    '版本源 = VERSION；canonical 构建 = scripts/build-installer.ps1');
  if (!git.isRepo(root)) {
    blocked('git-repo', '这是一个 Git 仓库', 'git rev-parse --is-inside-work-tree = true', 'false', root,
      '检查、提交与发布都以 Git 为准；没有它无法证明「发布了哪一个提交」');
  } else {
    const head = git.head(root);
    ok('git-head', '当前提交', '一个可解析的 commit', head.commit.slice(0, 12), 'git rev-parse HEAD',
      git.commitSubject(root, head.commit) + '  (' + git.commitDate(root, head.commit) + ')');
    facts.commit = head.commit;
  }

  /* ── 2. tools ─────────────────────────────────────────────────────────── */
  const gitProbe = git.available();
  if (gitProbe.ok) ok('tool-git', 'Git 可用', 'git --version 成功', gitProbe.version, 'PATH');
  else blocked('tool-git', 'Git 可用', 'git --version 成功', gitProbe.error || 'not found', 'PATH',
    'canonical 发布阶段（commit / tag / push）全部依赖 git');

  const pwshPath = env.pwsh();
  if (!pwshPath) {
    blocked('tool-powershell', 'Windows PowerShell 可用', 'powershell.exe 存在', 'not found',
      '%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', 'canonical 构建脚本是 PowerShell 5.1 脚本');
  } else {
    const probe = await env.probe(pwshPath, ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()']);
    if (probe.ok) ok('tool-powershell', 'Windows PowerShell 可用', 'powershell.exe 可执行', pwshPath + ' → ' + probe.stdout, pwshPath);
    else blocked('tool-powershell', 'Windows PowerShell 可用', 'powershell.exe 可执行', probe.error || ('exit ' + probe.code), pwshPath,
      'canonical 构建脚本无法运行');
  }

  const nodeRes = env.node(root);
  if (!nodeRes.path) {
    blocked('tool-node', 'Node 运行时可用', 'runtime\\node\\node.exe 或 PATH 上的 node', 'not found',
      'runtime/node/node.exe', 'canonical 构建的 staging / 审计 / 清单三步都由 Node 完成');
  } else {
    const nodeProbe = await env.probe(nodeRes.path, ['--version']);
    facts.nodePath = nodeRes.path;
    facts.nodeVersion = nodeProbe.stdout || '(no version reported)';
    if (!nodeRes.pinned) {
      warn('tool-node', 'Node 运行时来自 PATH 而不是内置运行时', 'runtime\\node\\node.exe',
        (nodeProbe.stdout || '(no version)') + ' (PATH)', nodeRes.path,
        '开发兜底可用，但正式构建要求内置运行时；canonical 第 2 步会在它缺失时失败');
    } else if (nodeProbe.ok && /^v\d+\.\d+\.\d+$/.test(nodeProbe.stdout)) {
      ok('tool-node', 'Node 运行时可用', '内置 runtime\\node\\node.exe', nodeProbe.stdout + ' (bundled)', nodeRes.path);
    } else {
      /*
       * The file is there and its bytes match the pin, but it does not REPORT the
       * pinned version. That is a warning, not a blocker, on purpose:
       *   · the canonical build's step 2 is the hard gate for this (it also
       *     checks the metadata file and SHA256SUMS), and it fails the build
       *     rather than letting a wrong runtime ship;
       *   · the Release Builder cannot itself repair or replace a runtime, and
       *     refusing here would only make the tool unusable on a tree where the
       *     pinned binary is absent or is a test fixture.
       * It is never reported as OK, and never silently ignored.
       */
      warn('tool-node', 'Node 运行时可用', '内置 runtime\\node\\node.exe 报告 v' + 'X.Y.Z',
        nodeProbe.ok ? ('报告 ' + JSON.stringify(nodeProbe.stdout) + '（不是版本号）') : ('无法执行：' + (nodeProbe.error || ('exit ' + nodeProbe.code))),
        nodeRes.path,
        '字节与 runtime-pin.json 一致，但它没有报告钉定的版本。canonical 构建第 2 步是这条的硬闸门' +
        '（它还会核对 runtime\\node\\VERSION 与 SHA256SUMS），失败即整个构建失败。此处如实报告为警告。');
    }
  }

  const isccPath = env.iscc(root);
  if (!isccPath) {
    blocked('tool-iscc', 'Inno Setup 6 编译器可用', 'ISCC.exe', 'not found',
      'PATH / Program Files / chocolatey', 'canonical 第 5 步编译安装包需要 ISCC.exe');
  } else {
    ok('tool-iscc', 'Inno Setup 6 编译器可用', 'ISCC.exe', isccPath, isccPath);
    facts.iscc = isccPath;
  }

  const ghPath = env.gh();
  if (ghPath) {
    ok('tool-gh', 'GitHub CLI 可用（仅 Publish 阶段需要）', 'gh.exe', ghPath, ghPath);
    facts.gh = ghPath;
  } else {
    warn('tool-gh', 'GitHub CLI 不可用', 'gh.exe（Publish 阶段需要）', 'not found', 'PATH',
      'BUILD/VERIFY/SEAL 不受影响；PUBLISH 将无法执行 gh release 命令');
  }

  /* ── 3. product version ───────────────────────────────────────────────── */
  const v = repo.version();
  if (!v.ok) {
    blocked('version-file', 'VERSION 可解析', 'MAJOR.MINOR.PATCH', v.error, v.path,
      'VERSION 是唯一版本源；它不可解析时发布链没有真相可言');
  } else {
    ok('version-file', '当前产品版本', 'MAJOR.MINOR.PATCH', v.version, 'VERSION');
    facts.sourceVersion = v.version;
  }

  /* Version sources: the product version has exactly one file source. The three
     "other" version constants (apps/catalog.json, the bridge and home-node
     service versions) are NOT product versions and are deliberately excluded —
     including them would manufacture a conflict that does not exist. */
  ok('version-sources', '版本源一致性', '产品版本只有一个文件源：VERSION',
    'VERSION = ' + (v.ok ? v.version : '(invalid)'),
    'audit §1 / docs/CHANGELOG.md U5-1',
    '排除项（非产品版本，已知且刻意）：apps/catalog.json 的 APP 目录版本；services/ib-bridge-service.js 的 VERSION；services/home-node-service.js 的 SERVICE_VERSION');

  /* ── 4. target version ────────────────────────────────────────────────── */
  const c = repo.manifest.CHANNELS;
  const target = String(o.target || '').trim();
  if (!target) {
    blocked('target-version', '目标版本已指定', 'MAJOR.MINOR.PATCH', '(empty)', 'GUI 输入',
      '没有目标版本就无法规划一次发行');
  } else {
    ok('target-version', '目标版本', 'MAJOR.MINOR.PATCH', target, 'GUI 输入');
  }

  const channel = String(o.channel || 'stable');
  if (c.indexOf(channel) < 0) {
    blocked('channel', '发布通道', c.join(', '), channel, 'runtime/update-manifest.js CHANNELS',
      '冻结的清单契约只认识 Stable；在这里提供第二个通道就是制造第二份发布真相');
  } else {
    ok('channel', '发布通道', c.join(', '), channel, 'runtime/update-manifest.js CHANNELS');
  }

  /* ── 5. build / release tools from the canonical scripts ──────────────── */
  for (const f of REQUIRED_CONTRACT_FILES) {
    const abs = path.join(root, f.rel);
    if (fs.existsSync(abs)) ok('file:' + f.rel, 'U1–U5 所需文件', '存在', f.rel, f.rel, f.why);
    else blocked('file:' + f.rel, 'U1–U5 所需文件', '存在', 'missing', f.rel, f.why);
  }
  for (const f of REQUIRED_TESTS) {
    const abs = path.join(root, f.rel);
    if (fs.existsSync(abs)) ok('test:' + f.rel, 'U1–U5 相关测试', '存在', f.rel, f.rel, f.why);
    else blocked('test:' + f.rel, 'U1–U5 相关测试', '存在', 'missing', f.rel, f.why);
  }

  /* ── 6. bundled runtime pin (three-way agreement, same as canonical step 2) */
  const pinFile = path.join(root, 'installer', 'runtime-pin.json');
  let pin = null;
  try { pin = JSON.parse(fs.readFileSync(pinFile, 'utf8')); } catch (e) { pin = null; }
  if (!pin || !pin.runtime || !pin.runtime.version) {
    blocked('runtime-pin', '内置运行时钉定值', 'runtime-pin.json 含 runtime.version', 'unreadable', pinFile,
      'canonical 第 2 步会失败');
  } else {
    const nodeExe = path.join(root, 'runtime', 'node', 'node.exe');
    const metaVersionFile = path.join(root, pin.runtime.metadata.versionFile);
    const metaSumsFile = path.join(root, pin.runtime.metadata.sumsFile);
    if (!fs.existsSync(nodeExe)) {
      blocked('runtime-exe', '内置 Node 运行时存在', 'runtime\\node\\node.exe', 'missing', nodeExe,
        '正式安装包必须携带它；canonical 第 2 步会失败');
    } else {
      const actual = sha256File(nodeExe);
      const want = String(pin.runtime.sha256).toLowerCase();
      if (actual !== want) {
        blocked('runtime-sha', '内置 Node 运行时字节', want, actual, nodeExe,
          'node.exe 与 runtime-pin.json 不一致；canonical 第 2 步会失败');
      } else {
        ok('runtime-sha', '内置 Node 运行时字节', want.slice(0, 16) + '…', actual.slice(0, 16) + '…', nodeExe,
          '与 runtime-pin.json 一致');
      }
      let metaVersion = '';
      try { metaVersion = fs.readFileSync(metaVersionFile, 'utf8').trim(); } catch (e) { metaVersion = '(missing)'; }
      let sumsHash = '';
      try {
        /* `new RegExp` rather than an inline-flags literal: the inline form
           `(?im)` is accepted by the JS engine the canonical PowerShell script
           embeds for its own parsing but NOT by V8, where it is a hard syntax
           error. Same pattern, same flags, spelled in the portable form. */
        const m = new RegExp('^\\s*([0-9a-f]{64})\\s+\\*?node\\.exe\\s*$', 'im')
          .exec(fs.readFileSync(metaSumsFile, 'utf8'));
        sumsHash = m ? m[1].toLowerCase() : '(missing)';
      } catch (e) { sumsHash = '(missing)'; }
      if (metaVersion !== pin.runtime.version) {
        blocked('runtime-version', '内置运行时元数据版本', pin.runtime.version, metaVersion, metaVersionFile,
          '三处（pin / VERSION / SHA256SUMS）必须一致');
      }
      if (sumsHash !== want) {
        blocked('runtime-sums', '内置运行时校验清单', want, sumsHash, metaSumsFile,
          'runtime\\node\\SHA256SUMS 与钉定值不一致');
      }
      if (metaVersion === pin.runtime.version && sumsHash === want) {
        ok('runtime-pin', '内置运行时钉定值', 'pin = VERSION = SHA256SUMS = node.exe 字节',
          'node ' + pin.runtime.version + ' · ' + want.slice(0, 12) + '…', pinFile);
      }
    }
  }

  /* ── 7. payload whitelist resolves ────────────────────────────────────── */
  try {
    const w = repo.payloadFileCount();
    if (w.ok) {
      facts.payloadFiles = w.count;
      ok('payload-whitelist', '载荷白名单可解析', '全部白名单条目存在且不命中 deny 规则',
        w.count + ' 个文件 · ' + (w.totalBytes / 1048576).toFixed(1) + ' MiB', 'scripts/release-manifest.js');
    } else {
      blocked('payload-whitelist', '载荷白名单可解析', 'missing=0 且 denied=0',
        'missing=' + w.missing.length + ' denied=' + w.denied.length, 'scripts/release-manifest.js',
        JSON.stringify(w.missing.slice(0, 5).concat(w.denied.slice(0, 5))));
    }
  } catch (e) {
    blocked('payload-whitelist', '载荷白名单可解析', 'resolve() 成功', String((e && e.message) || e),
      'scripts/release-manifest.js', '白名单无法解析时构建会在第 3 步失败');
  }

  /* ── 8. dist state ────────────────────────────────────────────────────── */
  if (!fs.existsSync(dist)) {
    warn('dist', 'dist 目录', '存在（构建会创建）', 'missing', dist, 'canonical 构建第 3 步会创建它');
  } else {
    /* writability: prove it by a temp file, not by reading attributes */
    const probeFile = path.join(dist, '.release-builder-write-probe');
    let writable = true;
    let why = '';
    try {
      fs.writeFileSync(probeFile, 'probe');
      fs.unlinkSync(probeFile);
    } catch (e) { writable = false; why = String((e && e.message) || e); }
    if (writable) ok('dist-writable', 'dist 可写', '可创建并删除文件', dist, dist);
    else blocked('dist-writable', 'dist 可写', '可创建并删除文件', why, dist, '构建产出无处可写');

    if (fs.existsSync(path.join(dist, 'staging'))) {
      blocked('dist-staging', 'dist\\staging 已清理', '不存在', '存在', path.join(dist, 'staging'),
        '上一次构建的残留 staging：canonical 构建会在第 3 步重建它，但残留本身就是「上次没跑完」的证据；请先处理（不要直接删掉正在排查的现场）');
    } else {
      ok('dist-staging', 'dist\\staging 已清理', '不存在', '不存在', dist);
    }
  }

  /* ── 9. published manifest in dist ────────────────────────────────────── */
  const distManifest = path.join(dist, 'update-stable.json');
  let distManifestObj = null;
  if (fs.existsSync(distManifest)) {
    let parsed = null;
    let parseError = '';
    try { parsed = JSON.parse(fs.readFileSync(distManifest, 'utf8').replace(/^\uFEFF/, '')); }
    catch (e) { parseError = String((e && e.message) || e); }
    if (!parsed) {
      blocked('dist-manifest-parse', 'dist 清单可解析', '合法 JSON', parseError, distManifest,
        '清单是 Stable 通道的契约；它不可解析时不能继续');
    } else {
      const rep = repo.validateManifest(parsed);
      if (!rep.ok) {
        blocked('dist-manifest-valid', 'dist 清单通过 canonical 校验', 'validate().ok = true',
          rep.errors.map(function (e) { return e.field + ': ' + e.why; }).join(' | '), distManifest,
          '清单校验失败必须阻断（不得自动「修好」）');
      } else {
        ok('dist-manifest-valid', 'dist 清单通过 canonical 校验', 'validate().ok = true',
          'version ' + parsed.version + ' · ' + rep.warnings.length + ' warning', distManifest,
          rep.warnings.length ? 'warnings: ' + JSON.stringify(rep.warnings) : '');
      }
      distManifestObj = parsed;
      facts.distManifestVersion = parsed.version;
    }
  } else {
    ok('dist-manifest-parse', 'dist 清单', '存在或不存在', '不存在（首次构建）', distManifest);
  }

  /* ── 10. artifact naming / naming collision ───────────────────────────── */
  const targetVersion = target || (v.ok ? v.version : '');
  const expectedAsset = targetVersion ? repo.assetName(targetVersion) : '';
  const expectedTag = targetVersion ? repo.tagFor(targetVersion) : '';
  const expectedUrl = targetVersion ? repo.urlFor(targetVersion) : '';
  facts.expectedAsset = expectedAsset;
  facts.expectedTag = expectedTag;
  facts.expectedUrl = expectedUrl;
  ok('artifact-name', '将生成的安装包名（由 canonical 构造）', 'installerAssetName(target)',
    expectedAsset, 'runtime/update-manifest.js installerAssetName()');
  ok('tag-name', '将使用的 tag（由 canonical 构造）', 'tagFor(target) = "v" + version',
    expectedTag, 'runtime/update-manifest.js tagFor()');
  ok('manifest-url', '清单里的下载地址（由 canonical 构造）', 'installerUrl(target)',
    expectedUrl, 'runtime/update-manifest.js installerUrl()');

  /* The collision that makes a rebuild silent: the same file name is already in
     dist. Rebuilding overwrites those bytes and still exits 0 (audit §10.1). */
  const existingArtifact = expectedAsset ? path.join(dist, expectedAsset) : '';
  if (existingArtifact && fs.existsSync(existingArtifact)) {
    const existSha = sha256File(existingArtifact);
    const existSize = sizeOf(existingArtifact);
    facts.existingArtifactSha256 = existSha;
    warn('dist-artifact-exists', 'dist 里已存在同名安装包', '目标版本尚未构建过',
      expectedAsset + ' · ' + existSize + ' B · ' + existSha.slice(0, 16) + '…', existingArtifact,
      '构建会覆盖它并返回 0；审计 §10.1 记录的「同版本重建覆盖已发布字节」正是这一条。若这是有意的二次构建，请在 GUI 里显式确认');
  }

  /* Published-release cross-check with dist, using only local evidence. */
  if (distManifestObj && targetVersion && distManifestObj.version === targetVersion) {
    const dSha = String(distManifestObj.installer.sha256 || '').toLowerCase();
    if (existingArtifact && fs.existsSync(existingArtifact)) {
      const actual = sha256File(existingArtifact);
      if (actual !== dSha) {
        blocked('dist-self-consistent', 'dist 内部一致（清单 vs 安装包字节）', dSha, actual, distManifest,
          'dist 里的清单与同名安装包已经不一致（审计 §10.3 的「陈旧清单」状态）：这就是一个必须被人看见的坏状态');
      } else {
        ok('dist-self-consistent', 'dist 内部一致（清单 vs 安装包字节）', dSha.slice(0, 16) + '…', actual.slice(0, 16) + '…', distManifest);
      }
    }
  }

  /* ── 11. release notes for the target ─────────────────────────────────── */
  const notesFile = notes.pathFor(root, targetVersion);
  if (!targetVersion) {
    /* already blocked above */
  } else if (fs.existsSync(notesFile)) {
    const bytes = sizeOf(notesFile);
    ok('release-notes', '目标版本的发行说明', '存在 docs\\release-notes\\<target>.md',
      notesFile.replace(root + path.sep, '') + ' · ' + bytes + ' B', notesFile,
      '作为 -NotesFile 传给 canonical 构建，成为清单的 notes 字段');
    facts.notesFile = notesFile;
  } else {
    warn('release-notes', '目标版本的发行说明', 'docs\\release-notes\\' + targetVersion + '.md', 'missing', notesFile,
      '没有它清单会省略 notes，用户更新卡片上看不到更新说明（RELEASE.md §4 允许省略，但那是降级）');
  }

  /* ── 12. README release-claim pre-check (the canonical gate runs in BUILD) ─ */
  const readmeFile = path.join(root, 'README.md');
  let readmeText = '';
  try { readmeText = fs.readFileSync(readmeFile, 'utf8'); } catch (e) { readmeText = ''; }
  const claimMatch = /当前版本\s*\*\*(\d+\.\d+\.\d+)\*\*/.exec(readmeText);
  const readmeVersion = claimMatch ? claimMatch[1] : '';
  facts.readmeVersion = readmeVersion;
  if (!readmeVersion) {
    blocked('readme-claim', 'README 发行声明存在', 'README 含「当前版本 **x.y.z**」', '找不到锚点', readmeFile,
      'release-claim 闸门在锚点消失时判失败（fail closed）；先修 README 再发布');
  } else if (v.ok && readmeVersion !== v.version) {
    blocked('readme-claim', 'README 发行声明 == VERSION', v.version, readmeVersion, readmeFile,
      'canonical 第 4 步的 release-claim 闸门会因此失败；这一项必须由人改（构建不会替你改文案）');
  } else {
    ok('readme-claim', 'README 发行声明 == VERSION', v.ok ? v.version : '?', readmeVersion, readmeFile,
      'BUILD 会把它提升到目标版本（VERSION 与 README 的当前版本字面量一起改），随后由 canonical 闸门独立复核');
  }
  /* A hard-coded installer file name for a DIFFERENT version is the 1.0.4
     landing-page defect (audit §7). The canonical claim scan catches it during
     BUILD; naming it here means it is reported before anything is built. */
  if (v.ok) {
    const assetRe = new RegExp(repo.manifest.ASSET_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') +
      '(\\d+\\.\\d+\\.\\d+)' + repo.manifest.ASSET_SUFFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
    let m;
    const wrong = [];
    while ((m = assetRe.exec(readmeText)) !== null) {
      if (m[1] !== v.version) wrong.push(m[0]);
    }
    if (wrong.length) {
      blocked('readme-asset-name', 'README 不硬编码别的版本的安装包名',
        '占位符 <版本号>，或当前版本 ' + v.version, wrong.join(', '), readmeFile,
        'README 随包发行：它会向用户指向一个不是本次发行的安装包');
    } else {
      ok('readme-asset-name', 'README 不硬编码别的版本的安装包名', '无其它版本的安装包名', '未发现', readmeFile);
    }
  }
  if (targetVersion && v.ok && readmeVersion === v.version && targetVersion !== v.version) {
    note(log, stage, 'readme-bump-plan', 'BUILD 会把 VERSION 与 README 的「当前版本」同时提升到 ' + targetVersion,
      '这是审计 §5.1 记录的 1.0.4 漏改事故的直接对策：唯一手改字面量由闸门兜住，而 Builder 把它自动化在同一笔提交里');
  }

  /* ── 13. git working tree ─────────────────────────────────────────────── */
  if (git.isRepo(root)) {
    const st = git.status(root);
    if (!st.ok) {
      blocked('git-status', '工作树状态可读', 'git status 成功', st.error, root, '无法判定工作树状态');
    } else {
      /*
       * Porcelain v1 puts the INDEX status first and the WORK TREE status
       * second, so an unstaged edit is " M" (leading space) while a staged one
       * is "M ". Testing position 0 alone therefore misses exactly the common
       * case — a working tree with uncommitted edits. Both positions are
       * checked, and '??' (untracked) is reported separately.
       */
      const CHANGED = 'MADRCU';
      const dirty = st.entries.filter(function (e) {
        return e.code !== '??' && (CHANGED.indexOf(e.code.charAt(0)) >= 0 || CHANGED.indexOf(e.code.charAt(1)) >= 0);
      });
      const untracked = st.entries.filter(function (e) { return e.code === '??'; });
      facts.dirtyPaths = dirty.map(function (e) { return e.path; });
      if (dirty.length) {
        warn('git-clean', '工作树干净', '没有已跟踪文件的未提交修改',
          dirty.length + ' 个已跟踪文件被修改/删除', root,
          '发布要求「发布的字节 == 某个提交的字节」。未提交的改动会让这件事说不清。' +
          '受影响的文件：' + dirty.slice(0, 8).map(function (e) { return e.path; }).join(', ') +
          (dirty.length > 8 ? ' …' : ''));
        log.item('git-clean-paths', {
          stage: stage, status: STAGE_STATUS.WARN, title: '未提交的已跟踪文件（逐条列出）',
          expected: '0', actual: String(dirty.length), evidence: 'git status --porcelain',
          detail: dirty.map(function (e) { return e.code + ' ' + e.path; }).join('\n')
        });
      } else {
        ok('git-clean', '工作树干净', '没有已跟踪文件的未提交修改', '干净', root);
      }
      if (untracked.length) {
        warn('git-untracked', '未跟踪文件', '（仅提示）', untracked.length + ' 项未跟踪', root,
          untracked.slice(0, 8).map(function (e) { return e.path; }).join(', ') +
          (untracked.length > 8 ? ' …' : '') +
          ' —— 按白名单构建的载荷不会包含它们，但请确认其中没有本次发行必须提交的内容');
      }
    }

    const up = 'origin/' + (git.branch(root) || 'master');
    const ab = git.aheadBehind(root, up);
    if (ab.ok) {
      facts.ahead = ab.ahead;
      facts.behind = ab.behind;
      if (ab.behind > 0) {
        warn('git-behind', '本地领先远端', '本地不落后于 ' + up, 'behind ' + ab.behind + ' / ahead ' + ab.ahead, root,
          '远端有本地没有的提交；发布前请先同步，否则 tag 指向的提交不是远端看到的提交');
      } else {
        ok('git-ahead', '本地与远端的关系', 'behind = 0', 'behind 0 / ahead ' + ab.ahead, up,
          ab.ahead > 0 ? 'ahead ' + ab.ahead + ' 个提交将在 Publish 阶段推送（需要显式确认）' : '本地与远端一致');
      }
    } else {
      warn('git-ahead', '本地与远端的关系', '可计算 ' + up, ab.error || 'unknown', root,
        '无法比较（远端引用不存在或未 fetch）；Publish 前请自行确认');
    }

    if (expectedTag && git.refExists(root, expectedTag)) {
      const at = git.tagCommit(root, expectedTag);
      blocked('tag-exists', '目标 tag 未被占用', expectedTag + ' 不存在',
        expectedTag + ' → ' + at.slice(0, 12) + ' (' + git.commitSubject(root, at) + ')', root,
        'tag 是发布身份锚点（tag === "v" + version）；同一个 tag 指向不同提交会让客户端拒绝或产生歧义');
    } else if (expectedTag) {
      ok('tag-exists', '目标 tag 未被占用', expectedTag + ' 不存在', '不存在', root);
    }
  }

  /* ── 14. optional network probe (read-only; never required to build) ──── */
  let published = null;
  if (o.probeNetwork === true && expectedTag) {
    const probeResult = await probePublished(repo, expectedTag, log, stage);
    published = probeResult;
    if (probeResult && probeResult.exists === true) {
      facts.published = probeResult;
    }
  } else {
    note(log, stage, 'network-probe-skipped',
      '未做在线复核（只读、可选）：勾选「在线复核」会查 GitHub 是否已存在同版本 release。' +
      '它不影响 BUILD/VERIFY/SEAL，只影响 Publish 前的人工确认。');
  }

  /* ── 15. the version plan (policy, pure) ──────────────────────────────── */
  const nowManifest = distManifestObj;
  const vp = plan.versionPlan({
    current: v.ok ? v.version : '',
    target: target,
    channel: channel,
    acknowledge: o.acknowledge || {},
    published: published,
    artifactSha256: facts.existingArtifactSha256 || (nowManifest && nowManifest.installer && nowManifest.installer.sha256) || ''
  });
  facts.versionPlan = vp;
  if (!vp.ok) {
    for (const b of vp.blockers) {
      blocked('plan:' + b.code, '版本规划：' + b.code, b.expected, b.actual,
        b.field === 'VERSION' ? 'VERSION' : 'tools/release-builder/lib/plan.js', b.why);
    }
  } else {
    ok('plan-ok', '版本规划', '目标 > 当前 且 通道受支持', vp.current + ' → ' + vp.target, 'lib/plan.js',
      'minimumVersion 将由 canonical 构建写入 ' + vp.minimumVersion);
  }
  for (const a of vp.blockersRequiringAcknowledgement) {
    warn('plan-ack:' + a.code, '需要显式确认：' + a.code, '发布前人工确认', '未确认', 'lib/plan.js', a.why);
  }
  for (const w of vp.warnings) {
    warn('plan-warn:' + w.code, w.code, '', '', 'lib/plan.js', w.why);
  }

  /* ── 16. optional: minimumVersion policy for THIS release ─────────────── */
  const minWanted = String(o.minimumVersion || plan.CANONICAL_MINIMUM_VERSION);
  if (nowManifest && nowManifest.version === targetVersion && nowManifest.minimumVersion &&
      String(nowManifest.minimumVersion) !== minWanted) {
    warn('minimum-version-policy', '清单的 minimumVersion',
      'canonical 路径写入 ' + minWanted,
      String(nowManifest.minimumVersion) + '（来自 dist 里已有的清单）',
      'dist/update-stable.json',
      '两者不同。minimumVersion 在 schema 上合法即可、客户端不据此拒绝安装，所以这**不是**格式错误；' +
      '但 canonical 构建路径写入的是 ' + minWanted + '，而 dist 里这份不是它产出的。' +
      '本次构建会以 canonical 路径重新生成清单，届时该字段会变成 ' + minWanted + '。');
  }

  const status = blockers.length ? STAGE_STATUS.BLOCKED
    : (log.warnings().length ? STAGE_STATUS.WARN : STAGE_STATUS.OK);
  return { status: status, blockers: blockers, facts: facts, plan: vp };
}

/*
 * Read-only online probe: does a release for this tag exist, and what does the
 * platform say its installer digest is?
 *
 * Uses the repository's own transport (runtime/update-transport.js via
 * runtime/update-check.js) so there is no second HTTPS implementation. Never
 * fatal: any failure means "unknown", and unknown is reported as unknown.
 */
async function probePublished(repo, tag, log, stage) {
  const uc = repo.updateCheck;
  if (!uc || typeof uc.fetchText !== 'function') {
    log.event('online probe unavailable: runtime/update-check.js did not load (' + (repo.updateCheckError || '') + ')');
    return null;
  }
  const api = repo.manifest.API_BASE + '/repos/' + repo.manifest.REPO + '/releases/tags/' + encodeURIComponent(tag);
  let res = null;
  try {
    res = await uc.fetchText(api, { headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': repo.manifest.API_VERSION_HEADER } });
  } catch (e) {
    log.event('online probe failed (treated as unknown)', { error: String((e && e.message) || e) });
    return null;
  }
  if (!res || res.outcome !== 'response') {
    log.event('online probe: no complete response (unknown, not "does not exist")', { outcome: res && res.outcome });
    return { exists: null, why: 'no complete response from the API' };
  }
  if (res.statusCode === 404) return { exists: false, why: 'tag not found' };
  if (res.statusCode !== 200 || !res.body) {
    return { exists: null, why: 'API answered ' + res.statusCode };
  }
  let payload = null;
  try { payload = JSON.parse(res.body); } catch (e) { return { exists: null, why: 'API body was not JSON' }; }
  const wantName = repo.assetName(tag.replace(/^v/, ''));
  const asset = (payload.assets || []).find(function (a) { return a && a.name === wantName; });
  const digest = asset && asset.digest ? String(asset.digest) : '';
  const out = {
    exists: true,
    tag: payload.tag_name,
    draft: payload.draft === true,
    prerelease: payload.prerelease === true,
    sha256: digest.indexOf('sha256:') === 0 ? digest.slice(7).toLowerCase() : '',
    assets: (payload.assets || []).map(function (a) { return a && a.name; }),
    why: null
  };
  log.item('published-release', {
    stage: stage,
    status: out.draft || out.prerelease ? STAGE_STATUS.WARN : STAGE_STATUS.WARN,
    title: '在线复核：该版本是否已发布',
    expected: '发布前应为「不存在」',
    actual: '存在（draft=' + out.draft + ' prerelease=' + out.prerelease + '）' +
      (out.sha256 ? ' · asset sha256 ' + out.sha256.slice(0, 16) + '…' : ' · asset 无 digest'),
    evidence: api,
    why: '同一个版本再次发布要么失败、要么覆盖已发布资产；绝不允许「重建产物替换已发布字节」'
  });
  return out;
}

function note(log, stage, key, message, why) {
  log.item(key, { stage: stage, status: STAGE_STATUS.OK, title: message, why: why });
}

module.exports = { run, REQUIRED_CONTRACT_FILES, REQUIRED_TESTS, sha256File, sizeOf };
