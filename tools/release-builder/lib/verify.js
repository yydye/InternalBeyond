'use strict';

/*
 * Release Builder · VERIFY
 *
 * Everything VERIFY reports is measured from the FINAL artifact's bytes on
 * disk, in this stage, right now. It never reads a previous stage's snapshot,
 * never trusts dist\SHA256SUMS.txt as a source of truth (that file is a record
 * for humans — clients never read it, audit §4/§10.3), and never accepts a
 * value the build printed.
 *
 * The four equations of U5-1 (docs/CHANGELOG.md) are recomputed here from
 * disk bytes, and the definitions they are checked against come from the
 * canonical adapter — this file contains no second copy of the URL rule, the
 * asset-name rule, the PE rule, the semver rule or the secret vocabulary.
 *
 *   1. manifest.installer.sha256        == sha256(the artifact's bytes)
 *   2. manifest.installer.sizeBytes     == the artifact's length
 *   3. manifest.installer.productVersion == the artifact's PE ProductVersion == VERSION
 *   4. manifest.installer.url's asset name == the real artifact file name
 *
 * plus the manifest's own canonical validation, the file-name = canonical name
 * rule, and the U1–U5 invariant file/test presence and behaviour checks.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const plan = require('./plan.js');
const { STAGE_STATUS } = plan;

function sha256File(file) {
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(4 * 1024 * 1024);
    let n;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n));
  } finally { fs.closeSync(fd); }
  return h.digest('hex');
}

/*
 * Write dist/update-stable.json through the canonical generator.
 * Used ONLY when the file is absent (nothing is being overwritten), or when the
 * caller explicitly asked to regenerate. The canonical module refuses to write
 * a manifest that fails its own validation, so a broken contract cannot be
 * produced here either.
 */
function generateManifest(repo, fields) {
  const result = repo.manifest.writeManifest({
    out: fields.out,
    version: fields.version,
    channel: fields.channel || 'stable',
    sha256: fields.sha256,
    sizeBytes: fields.sizeBytes,
    productVersion: fields.productVersion,
    releasedAt: fields.releasedAt || '',
    minimumVersion: fields.minimumVersion || '',
    notes: fields.notes || ''
  });
  return result;
}

async function run(ctx) {
  const repo = ctx.repo;
  const log = ctx.log;
  const o = ctx.options || {};
  const stage = 'VERIFY';
  const blockers = [];
  const facts = {};
  const target = String(o.target || '').trim();
  const dist = path.join(repo.root, 'dist');

  const item = function (key, status, title, expected, actual, evidence, why, detail) {
    log.item(key, { stage: stage, status: status, title: title, expected: expected, actual: actual, evidence: evidence, why: why, detail: detail });
    if (status === STAGE_STATUS.BLOCKED) blockers.push({ code: key, title: title, expected: expected, actual: actual, evidence: evidence, why: why });
  };

  /* ── A. the artifact, re-read from disk ───────────────────────────────── */
  const canonicalName = repo.assetName(target);
  const artifact = path.join(dist, canonicalName);
  if (!fs.existsSync(artifact)) {
    item('A-exists', STAGE_STATUS.BLOCKED, 'A. 安装包存在（重新从磁盘读取）', canonicalName, 'missing', artifact,
      'VERIFY 必须重新从磁盘读取最终产物；不存在就没有可验证的东西');
    return { status: STAGE_STATUS.BLOCKED, blockers: blockers, facts: facts };
  }
  const st = fs.statSync(artifact);
  facts.artifactPath = artifact;
  facts.artifactBytes = st.size;
  item('A-exists', STAGE_STATUS.OK, 'A. 安装包存在（重新从磁盘读取）', canonicalName,
    canonicalName + ' · ' + st.size + ' B', artifact);

  /* ── B. filename must be exactly the canonical name ───────────────────── */
  const baseName = path.basename(artifact);
  if (baseName !== canonicalName) {
    item('B-filename', STAGE_STATUS.BLOCKED, 'B. 文件名精确符合 canonical 命名', canonicalName, baseName, artifact,
      'installerAssetName() 是唯一的命名拼写来源；名字不符意味着清单会指向一个不存在的资产');
  } else {
    item('B-filename', STAGE_STATUS.OK, 'B. 文件名精确符合 canonical 命名', canonicalName, baseName,
      'runtime/update-manifest.js installerAssetName()');
  }

  const minBytes = repo.manifest.MIN_PLAUSIBLE_INSTALLER_BYTES;
  if (st.size < minBytes) {
    item('B-size', STAGE_STATUS.BLOCKED, 'B. 文件大小 > 合理下界', '≥ ' + minBytes, st.size, artifact,
      '载荷始终携带内置 Node 运行时（约 48 MB）');
  } else {
    item('B-size', STAGE_STATUS.OK, 'B. 文件大小 > 合理下界', '≥ ' + minBytes, st.size + ' B', artifact);
  }

  /* ── C. SHA-256 recomputed from the final artifact ────────────────────── */
  const actualSha = sha256File(artifact);
  facts.artifactSha256 = actualSha;
  item('C-sha256', STAGE_STATUS.OK, 'C. SHA-256（本次从最终产物重新计算）', '64 位小写十六进制',
    actualSha, artifact,
    '绝不信任旧的 SHA256SUMS.txt：客户端从不读那个文件，唯一权威是本地重算值（审计 §4/§10.3）');

  /* ── D. PE version, via the canonical reader ──────────────────────────── */
  const pe = repo.pe.readPeVersion(artifact);
  facts.pe = pe.ok ? { productVersion: pe.productVersion, fileVersion: pe.fileVersion, productVersionFixed: pe.productVersionFixed, fileVersionFixed: pe.fileVersionFixed } : null;
  if (!pe.ok) {
    item('D-pe', STAGE_STATUS.BLOCKED, 'D. PE 版本可读', 'readPeVersion().ok = true', pe.why, artifact,
      'U3 的「字节对但版本错」防线依赖它');
  } else {
    const canonicalMatch = repo.pe.matchesProductVersion(artifact, target);
    if (!canonicalMatch.ok) {
      item('D-pe', STAGE_STATUS.BLOCKED, 'D. PE 版本 == 目标版本（用 canonical 判定器）',
        'ProductVersion / FileVersion 前三段 = ' + target, canonicalMatch.why, artifact,
        '复用 runtime/pe-version.js 的 matchesProductVersion()，不在这里重写 PE 规则');
    } else {
      item('D-pe', STAGE_STATUS.OK, 'D. PE 版本 == 目标版本（用 canonical 判定器）',
        'ProductVersion = ' + target,
        'ProductVersion ' + pe.productVersion + ' · FileVersion ' + pe.fileVersion +
        ' · fixed ' + pe.productVersionFixed + ' / ' + pe.fileVersionFixed,
        artifact, 'canonical matchesProductVersion() 通过');
    }
  }

  const versionNow = repo.version();
  if (!versionNow.ok || versionNow.version !== target) {
    item('D-version-file', STAGE_STATUS.BLOCKED, 'D. VERSION == 目标版本',
      target, versionNow.ok ? versionNow.version : versionNow.error, versionNow.path,
      'VERSION 必须已经提升到目标版本（BUILD 在构建前完成这一笔）');
  } else {
    item('D-version-file', STAGE_STATUS.OK, 'D. VERSION == 目标版本', target, versionNow.version, 'VERSION');
  }

  /* ── E. the manifest ──────────────────────────────────────────────────── */
  const manifestPath = path.join(dist, repo.payloadManifestAsset);
  /*
   * The notes file is the one BUILD declared (ctx.notesFile), not whatever file
   * happens to exist for the target: comparing against a different file would
   * report a difference that is not one.
   */
  const notesFile = ctx.notesFile || path.join(repo.root, 'docs', 'release-notes', target + '.md');
  const notesDeclared = ctx.notesFileExists !== false;
  let notes = '';
  if (notesDeclared && fs.existsSync(notesFile)) {
    notes = fs.readFileSync(notesFile, 'utf8').replace(/^\uFEFF/, '').trim();
  }

  if (!fs.existsSync(manifestPath)) {
    /* Nothing to overwrite: generating it here is the canonical path, and the
       canonical writer refuses to emit an invalid manifest. */
    const gen = generateManifest(repo, {
      out: manifestPath,
      version: target,
      channel: o.channel || 'stable',
      sha256: actualSha,
      sizeBytes: st.size,
      productVersion: pe.ok ? pe.productVersion : target,
      minimumVersion: o.minimumVersion || plan.CANONICAL_MINIMUM_VERSION,
      notes: notes
    });
    if (!gen.ok) {
      item('E-generate', STAGE_STATUS.BLOCKED, 'E. 清单生成（canonical 生成器）', 'writeManifest().ok = true',
        gen.errors.map(function (e) { return e.field + ': ' + e.why; }).join(' | '), manifestPath,
        '清单不存在时由 canonical 生成器补出；生成失败即阻断');
    } else {
      item('E-generate', STAGE_STATUS.OK, 'E. 清单生成（canonical 生成器）',
        'dist 里没有清单 → 用 canonical 生成器写出', gen.path, 'runtime/update-manifest.js writeManifest()',
        '值全部实测自刚读的产物字节（sha256 / sizeBytes / PE productVersion）');
    }
  } else {
    item('E-generate', STAGE_STATUS.OK, 'E. 清单来源', 'dist 里已有清单 → 不覆盖',
      'runtime/update-manifest.js（由 BUILD 的第 7 步写出）', manifestPath,
      'VERIFY 不重写别人产出的清单；只有清单缺失、或用户显式要求重新生成时才会写');
  }

  let manifest = null;
  let parseErr = '';
  try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8').replace(/^\uFEFF/, '')); }
  catch (e) { parseErr = String((e && e.message) || e); }
  if (!manifest) {
    item('E-parse', STAGE_STATUS.BLOCKED, 'E. 清单可解析', '合法 JSON', parseErr, manifestPath, '清单是 Stable 通道的契约');
    return { status: STAGE_STATUS.BLOCKED, blockers: blockers, facts: facts };
  }
  facts.manifest = manifest;
  item('E-parse', STAGE_STATUS.OK, 'E. 清单可解析', '合法 JSON', manifestPath, manifestPath);

  /* ── F. the four equations (U5-1), recomputed here ────────────────────── */
  const eqSha = manifest.installer && manifest.installer.sha256;
  if (String(eqSha || '').toLowerCase() !== actualSha) {
    item('F1-sha', STAGE_STATUS.BLOCKED, '四等式 1：manifest.installer.sha256 == sha256(产物字节)',
      actualSha, String(eqSha), manifestPath, '等式不成立即阻断（不得写「基本成功」）');
  } else {
    item('F1-sha', STAGE_STATUS.OK, '四等式 1：manifest.installer.sha256 == sha256(产物字节)', actualSha, String(eqSha), manifestPath);
  }

  const eqSize = manifest.installer && manifest.installer.sizeBytes;
  if (Number(eqSize) !== st.size) {
    item('F2-size', STAGE_STATUS.BLOCKED, '四等式 2：manifest.installer.sizeBytes == 产物长度',
      String(st.size), String(eqSize), manifestPath, '等式不成立即阻断');
  } else {
    item('F2-size', STAGE_STATUS.OK, '四等式 2：manifest.installer.sizeBytes == 产物长度', String(st.size), String(eqSize), manifestPath);
  }

  const eqPv = manifest.installer && manifest.installer.productVersion;
  const peProduct = pe.ok ? pe.productVersion : '';
  if (String(eqPv || '') !== peProduct || String(eqPv || '') !== target) {
    item('F3-productVersion', STAGE_STATUS.BLOCKED,
      '四等式 3：manifest.installer.productVersion == PE ProductVersion == VERSION',
      target + ' == ' + target + ' == ' + target, String(eqPv) + ' == ' + peProduct + ' == ' + target,
      manifestPath, '等式不成立即阻断');
  } else {
    item('F3-productVersion', STAGE_STATUS.OK,
      '四等式 3：manifest.installer.productVersion == PE ProductVersion == VERSION',
      target, String(eqPv) + ' == ' + peProduct + ' == ' + target, manifestPath);
  }

  const parsedUrl = repo.manifest.parseInstallerUrl(manifest.installer && manifest.installer.url);
  const urlAsset = parsedUrl.ok ? parsedUrl.asset : ('(' + parsedUrl.why + ')');
  if (!parsedUrl.ok || urlAsset !== baseName) {
    item('F4-url-asset', STAGE_STATUS.BLOCKED, '四等式 4：installer.url 的资产名 == 真实产出文件名',
      baseName, urlAsset, manifestPath,
      'URL 由 canonical 构造器唯一生成；资产名与实际文件不符意味着清单指向一个不存在的资产');
  } else {
    item('F4-url-asset', STAGE_STATUS.OK, '四等式 4：installer.url 的资产名 == 真实产出文件名',
      baseName, urlAsset, 'runtime/update-manifest.js parseInstallerUrl()');
  }

  /* URL version must be pinned to the manifest version (canonical validate()
     also checks it; here it is stated separately so a failure is unambiguous). */
  if (parsedUrl.ok && parsedUrl.version !== manifest.version) {
    item('F4-url-version', STAGE_STATUS.BLOCKED, '四等式 4b：URL 版本 == manifest.version',
      String(manifest.version), parsedUrl.version, manifestPath, 'URL 必须钉死在被宣布的版本上');
  } else if (parsedUrl.ok) {
    item('F4-url-version', STAGE_STATUS.OK, '四等式 4b：URL 版本 == manifest.version',
      String(manifest.version), parsedUrl.version, manifestPath);
  }

  /* ── G. the manifest through the canonical validator ──────────────────── */
  const rep = repo.validateManifest(manifest);
  facts.manifestValidation = { ok: rep.ok, errors: rep.errors, warnings: rep.warnings };
  if (!rep.ok) {
    item('G-validate', STAGE_STATUS.BLOCKED, 'G. canonical 清单校验 validate().ok',
      'true', rep.errors.map(function (e) { return e.field + ': ' + e.why; }).join(' | '), manifestPath,
      '复用的是 runtime/update-manifest.js 的 validate()，不是本地重写的一套规则');
  } else {
    item('G-validate', STAGE_STATUS.OK, 'G. canonical 清单校验 validate().ok', 'true',
      'true（' + rep.warnings.length + ' warning）', manifestPath,
      rep.warnings.length ? 'warnings: ' + JSON.stringify(rep.warnings) : '');
  }

  /* manifest vs requested channel, and manifest.version vs target */
  if (manifest.version !== target) {
    item('G-version', STAGE_STATUS.BLOCKED, 'G. manifest.version == 目标版本', target, String(manifest.version), manifestPath, '版本不一致即阻断');
  } else {
    item('G-version', STAGE_STATUS.OK, 'G. manifest.version == 目标版本', target, String(manifest.version), manifestPath);
  }
  const wantChannel = String(o.channel || 'stable');
  if (manifest.channel !== wantChannel) {
    item('G-channel', STAGE_STATUS.BLOCKED, 'G. manifest.channel == 请求的通道', wantChannel, String(manifest.channel), manifestPath, '通道不符即阻断');
  } else {
    item('G-channel', STAGE_STATUS.OK, 'G. manifest.channel == 请求的通道', wantChannel, String(manifest.channel), 'runtime/update-manifest.js CHANNELS');
  }

  /* notes fidelity: recompute the string the canonical writer would produce */
  const hasNotes = Object.prototype.hasOwnProperty.call(manifest, 'notes');
  if (notes && !hasNotes) {
    item('G-notes', STAGE_STATUS.WARN, 'G. manifest.notes 与 release-notes 文件一致',
      'notes == docs\\release-notes\\' + target + '.md（去 BOM、trim）', '清单省略了 notes', notesFile,
      '省略是契约允许的（RELEASE.md §4），但用户更新卡片上就没有更新说明；请确认这是有意的');
  } else if (!notes && hasNotes) {
    item('G-notes', STAGE_STATUS.WARN, 'G. manifest.notes 与 release-notes 文件一致',
      '（没有 release-notes 文件）', '清单里却有 notes', manifestPath,
      '清单里的 notes 没有任何文件来源；请人工确认它的出处');
  } else if (notes && hasNotes) {
    const same = String(manifest.notes).replace(/\r\n/g, '\n') === notes.replace(/\r\n/g, '\n');
    item('G-notes', same ? STAGE_STATUS.OK : STAGE_STATUS.BLOCKED, 'G. manifest.notes 与 release-notes 文件一致',
      notes.slice(0, 40) + '…（' + notes.length + ' 字符）',
      same ? '逐字相同' : '不一致（清单 ' + String(manifest.notes).length + ' 字符）',
      notesFile, same ? '' : '清单的 notes 与发布说明文件不符：更新卡片会向用户展示与发布说明不一致的文案');
  } else {
    item('G-notes', STAGE_STATUS.OK, 'G. manifest.notes', '无文件、清单也省略', '一致（都缺席）', notesFile);
  }

  /* optional fields: report them, and report that they have no canonical default */
  const opt = [];
  for (const k of ['releasedAt', 'minimumVersion', 'notesUrl']) {
    if (Object.prototype.hasOwnProperty.call(manifest, k)) opt.push(k + ' = ' + JSON.stringify(manifest[k]));
  }
  item('G-optional-fields', STAGE_STATUS.OK, 'G. 清单的可选字段（透明列出）',
    'canonical 默认：releasedAt 省略、minimumVersion = ' + plan.CANONICAL_MINIMUM_VERSION + '、notesUrl 省略',
    opt.length ? opt.join(' · ') : '（全部省略）', manifestPath,
    '审计 §10.2 记录过：这两个可选字段在历史 dist 里出现过非 canonical 的值。这里只如实列出，不做修正。');

  /* ── H. SHA256SUMS.txt (a record for humans, cross-checked) ───────────── */
  const sumsPath = path.join(dist, 'SHA256SUMS.txt');
  if (!fs.existsSync(sumsPath)) {
    item('H-sums', STAGE_STATUS.WARN, 'H. SHA256SUMS.txt 与实际字节一致', '存在且与重算值一致',
      'missing', sumsPath, 'canonical 第 6 步会写出它；缺失说明这次产出不完整');
  } else {
    const text = fs.readFileSync(sumsPath, 'ascii');
    const line = text.split(/\r?\n/).find(function (l) { return l.indexOf('*' + baseName) >= 0; });
    const recordedSha = line ? line.trim().split(/\s+/)[0].toLowerCase() : '';
    if (!line || recordedSha !== actualSha) {
      item('H-sums', STAGE_STATUS.BLOCKED, 'H. SHA256SUMS.txt 与实际字节一致', actualSha, recordedSha || '(no line for this artifact)', sumsPath,
        '这是「陈旧 SHA256SUMS」的可见形式（审计 §10.3）：记录与实际字节不符。它不改变客户端行为，但会让本地说谎，必须修');
    } else {
      item('H-sums', STAGE_STATUS.OK, 'H. SHA256SUMS.txt 与实际字节一致', actualSha, recordedSha, sumsPath,
        '注意：该文件是给人看的记录，客户端从不读它；放行依据始终是本次重算的值');
    }
  }

  /* ── I. U1–U5 invariants ─────────────────────────────────────────────── */
  item('I-U1', STAGE_STATUS.OK, 'I. U1 唯一清单生成器 + 客户端解析/校验',
    'runtime/update-manifest.js 是唯一生成器与唯一校验器',
    'validate() 已调用 · parseInstallerUrl() 已调用 · installerUrl() 由该模块构造',
    'runtime/update-manifest.js', '本工具未复制任何一条清单业务定义');

  const transport = (function () {
    try { return require(path.join(repo.root, 'runtime', 'update-transport.js')); }
    catch (e) { return null; }
  })();
  if (transport && typeof transport.fallbackAllowed === 'function') {
    /* The one-line fallback equation, asserted against the module (U-D1 Revised). */
    const samples = [
      { outcome: transport.OUTCOME_RESPONSE }, { outcome: transport.OUTCOME_NETWORK }, { outcome: transport.OUTCOME_PROTOCOL }
    ];
    const agree = samples.every(function (s) { return transport.fallbackAllowed(s) === (s.outcome === transport.OUTCOME_NETWORK); });
    item('I-U2', agree ? STAGE_STATUS.OK : STAGE_STATUS.BLOCKED, 'I. U2 仅 network fallback（回退门等式）',
      'fallbackAllowed(r) === (r.outcome === "network")', agree ? '三个 outcome 采样一致' : '等式不成立',
      'runtime/update-transport.js', agree ? '复用仓库的唯一实现，未在此重写回退判定' : '回退门被改动，发布前必须处理');
  } else {
    item('I-U2', STAGE_STATUS.WARN, 'I. U2 回退门等式', '可加载 runtime/update-transport.js 并断言等式',
      'module unavailable', 'runtime/update-transport.js', '无法断言；请人工确认 U-D1 Revised 未被改动');
  }

  const u3digest = (function () {
    /* U3: tag = version, asset name exact match, digest rule — asserted through
       the canonical selector on a synthetic release payload. */
    const good = {
      draft: false, prerelease: false, tag_name: repo.tagFor(target),
      assets: [{ name: repo.assetName(target), id: 1, digest: 'sha256:' + actualSha }]
    };
    const sel = repo.manifest.selectInstallerAsset(good, target, actualSha);
    const badDraft = repo.manifest.selectInstallerAsset(Object.assign({}, good, { draft: true }), target, actualSha);
    const badName = repo.manifest.selectInstallerAsset(
      Object.assign({}, good, { assets: [{ name: 'InternalBeyond-Setup-0.0.1.exe', id: 1 }] }), target, actualSha);
    return { ok: sel.ok && !badDraft.ok && !badName.ok, why: sel.why };
  })();
  item('I-U3', u3digest.ok ? STAGE_STATUS.OK : STAGE_STATUS.BLOCKED,
    'I. U3 tag = version；资产名精确匹配；draft/prerelease 一律拒绝',
    'selectInstallerAsset() 接受正确 payload、拒绝 draft 与错资产名',
    u3digest.ok ? '接受 + 两个拒绝都成立' : ('selector 行为不符：' + u3digest.why),
    'runtime/update-manifest.js selectInstallerAsset()');

  const install = (function () {
    try { return require(path.join(repo.root, 'runtime', 'update-install.js')); }
    catch (e) { return null; }
  })();
  if (install && typeof install.STATE_SCHEMA === 'string') {
    item('I-U4', STAGE_STATUS.OK, 'I. U4 /__update/status 契约',
      '状态文件 schema = ' + install.STATE_SCHEMA, '模块可加载且导出状态契约', 'runtime/update-install.js',
      '路由字面量 /__update/status 由 tests/test_update_install.js 与 U4 卡片测试逐字钉住');
  } else if (install) {
    item('I-U4', STAGE_STATUS.OK, 'I. U4 /__update/status 契约', '模块可加载', '已加载（未导出 schema 常量）',
      'runtime/update-install.js', '端点与投影由仓库既有测试守着；本工具只做只读确认');
  } else {
    item('I-U4', STAGE_STATUS.WARN, 'I. U4 /__update/status 契约', '可加载 runtime/update-install.js',
      'module unavailable', 'runtime/update-install.js', '无法确认');
  }

  item('I-U5', STAGE_STATUS.OK, 'I. U5 四等式 / artifact / sha256 / manifest 对账',
    '四条等式全部独立于构建输出、从磁盘字节重算', '见 F1–F4 四项', artifact,
    '放行依据是本次重算的字节，不是构建打印的值');

  /* ── J. payload whitelist still resolves identically ──────────────────── */
  try {
    const w = repo.payloadFileCount();
    const stagedManifest = path.join(dist, 'staging', 'ib-payload-manifest.json');
    if (!w.ok) {
      item('J-payload', STAGE_STATUS.BLOCKED, 'J. 载荷白名单可解析', 'missing=0 denied=0',
        'missing=' + w.missing.length + ' denied=' + w.denied.length, 'scripts/release-manifest.js',
        JSON.stringify(w.missing.slice(0, 5)));
    } else {
      item('J-payload', STAGE_STATUS.OK, 'J. 载荷白名单可解析', 'missing=0 denied=0',
        w.count + ' 个文件 · ' + (w.totalBytes / 1048576).toFixed(1) + ' MiB', 'scripts/release-manifest.js');
      facts.payloadFiles = w.count;
    }
    if (fs.existsSync(stagedManifest)) {
      item('J-staging', STAGE_STATUS.WARN, 'J. dist\\staging 已清理', '不存在', '存在（构建以 -KeepStaging 运行？）',
        stagedManifest, 'staging 是构建中间态；SEAL 前应清理');
    } else {
      item('J-staging', STAGE_STATUS.OK, 'J. dist\\staging 已清理', '不存在', '不存在', dist);
    }
  } catch (e) {
    item('J-payload', STAGE_STATUS.BLOCKED, 'J. 载荷白名单可解析', 'resolve() 成功', String((e && e.message) || e), 'scripts/release-manifest.js');
  }

  /* ── K. release-claim gate, reused on the repository bytes ────────────── */
  try {
    const findings = repo.audit.scanReleaseClaims(repo.root, []);
    const errors = findings.filter(function (f) { return f.severity === 'error'; });
    if (errors.length) {
      item('K-release-claim', STAGE_STATUS.BLOCKED, 'K. 发行声明闸门（README vs VERSION）',
        '0 error', errors.length + ' error', 'README.md',
        errors.map(function (e) { return e.why; }).join(' | '));
    } else {
      item('K-release-claim', STAGE_STATUS.OK, 'K. 发行声明闸门（README vs VERSION）', '0 error',
        '0 error', 'README.md', '复用 scripts/release-audit.js 的 scanReleaseClaims()');
    }
  } catch (e) {
    item('K-release-claim', STAGE_STATUS.WARN, 'K. 发行声明闸门', '可复用 scanReleaseClaims()',
      String((e && e.message) || e), 'scripts/release-audit.js', '无法在此复核；canonical 第 4 步已跑过');
  }

  const status = blockers.length ? STAGE_STATUS.BLOCKED
    : (log.items().some(function (i) { return i.stage === stage && i.status === STAGE_STATUS.WARN; }) ? STAGE_STATUS.WARN : STAGE_STATUS.OK);
  return { status: status, blockers: blockers, facts: facts };
}

module.exports = { run, sha256File, generateManifest };
