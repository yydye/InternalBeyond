'use strict';

/*
 * Internal Beyond · release payload manifest (P7)
 *
 * WHITELIST ONLY. The installer never packages the repository; it packages
 * exactly the entries listed here. Anything not listed is absent by
 * construction, so a new development file can never leak into a release just
 * because someone forgot an exclude rule.
 *
 * Used by:
 *   scripts/build-installer.ps1 → staging (copy) + pre-compile gate
 *   scripts/release-audit.js    → content / secret / path audit
 *   test_installer.js           → manifest contract (every entry exists, no
 *                                 denied path, payload covers the app closure)
 *
 * Rules for editing this file:
 *   1. Add a file only when the installed app actually loads it at runtime, or
 *      when it is a required legal / version / support document.
 *   2. Never add `dir: true` without checking what the directory will contain
 *      later (see `exclude` for per-entry carve-outs).
 *   3. Every entry needs a `why`; the build prints it in the audit summary.
 */

const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');

/* ── Whitelist ─────────────────────────────────────────────────────────── */

const ENTRIES = [
  /* Application document + front end.
     assets/ now also carries the theme backgrounds (assets/images) and the
     official icon (assets/icons); bg-canvas.png is a 6 MB optional background
     that must stay out of the payload, exactly as the deny rule states. */
  { from: 'InternalBeyond.html', why: '主文档（唯一 HTML 入口）' },
  { from: 'assets', dir: true, exclude: ['images/bg-canvas.png'],
    why: '全部前端脚本与样式（含 Guide / 诊断 / 设置向导 / 错误目录）+ 背景图与图标（assets/images、assets/icons；bg-canvas.png 为 6 MB 可选背景，不入包）' },
  { from: 'apps', dir: true, why: 'APP 目录（apps/catalog.json 由 app-store 运行时 fetch）' },
  { from: 'game', dir: true, exclude: ['portraits/portrait_[*].png'], why: '游戏模块与素材（个人头像 portrait_[昵称].png 属于用户数据，不入包）' },

  /* Node runtime entry points + local services.
     The payload mirrors the repository layout for these so the launcher /
     runner / static server keep identical relative resolution in dev and after
     install (the root is one level up from runtime/ and services/). */
  { from: 'VERSION', why: '单一发行版本源' },
  { from: 'runtime/product-version.js', why: '版本解析（launcher / 静态服务 / 构建脚本共用）' },
  { from: 'runtime/update-manifest.js', why: '更新清单契约（客户端校验 manifest / 解析 installer URL；构建期由 build-installer.ps1 生成清单）' },
  { from: 'runtime/update-check.js', why: '更新检查运行时（Node 侧唯一真源：传输 + 校验 + semver 比较 + 24h 缓存；/__update-check 端点使用）' },
  { from: 'runtime/update-transport.js', why: '更新共用 HTTPS 传输（回退门 / 跳转白名单 / 网络错误分类；检查与安装共用唯一实现）' },
  { from: 'runtime/update-install.js', why: '更新安装运行时（下载 → size/sha256/PE 校验 → detached 启动安装器 → 立即退出；/__update/start 与 /__update/status 使用）' },
  { from: 'runtime/pe-version.js', why: '安装包 PE 版本资源读取（ProductVersion/FileVersion 校验，防止「字节对但版本错」）' },
  { from: 'runtime/boot-state.js', why: '启动记录（P2 诊断唯一来源）' },
  { from: 'runtime/launch-internal-beyond.js', why: '正式静默启动链（快捷方式最终执行）' },
  { from: 'runtime/local-services-runner.js', why: '本地服务管理进程（Bridge / Active + 重启与停止控制面）' },
  { from: 'services/internal-beyond-server.js', why: '本地静态页面服务（AudioWorklet 必需）' },
  { from: 'services/ib-bridge-service.js', why: 'Bridge 后端' },
  { from: 'services/active-message-service.js', why: 'Active 后台主动消息服务' },
  { from: 'bridge', dir: true, why: 'Bridge 模块' },
  { from: 'active', dir: true, why: 'Active 模块' },
  { from: '启动 InternalBeyond.vbs', why: '唯一用户启动入口的实现（快捷方式目标，用户只看到名字 InternalBeyond）' },
  { from: 'installer/tools/ib-stop.js', to: 'tools/ib-stop.js', why: '升级/卸载前优雅停止自身实例的助手' },

  /* Bundled Node runtime (P1) */
  { from: 'runtime/node/node.exe', why: '内置 Node 运行时（用户无需安装 Node.js）' },
  { from: 'runtime/node/VERSION', why: '内置运行时精确版本' },
  { from: 'runtime/node/SHA256SUMS', why: '内置运行时校验清单' },
  { from: 'runtime/node/LICENSE', why: 'Node.js 上游许可原文' },
  { from: 'runtime/node/README.md', why: '内置运行时来源与解析顺序说明' },

  /* Legal + user documentation */
  { from: 'LICENSE', why: '项目许可（PolyForm Noncommercial 1.0.0）' },
  { from: 'LICENSES', dir: true, why: '第三方与素材许可声明（含 Node 再分发声明）' },
  { from: 'README.md', why: '用户安装与使用说明' },
  /* Source lives in docs/ but the installed layout keeps it at the app root. */
  { from: 'docs/TROUBLESHOOTING.md', to: 'TROUBLESHOOTING.md', why: '用户故障排查说明（安装到应用根目录）' },

  /* Guide assets (P6) */
  { from: 'docs/guide/annotations.json', why: '指南截图清单（正文引用的图片来源）' },
  { from: 'docs/guide/shots', dir: true, why: '指南截图（Guide 章节引用，必须实际可访问）' }
];

/* ── Deny rules (defense in depth) ────────────────────────────────────────
   The whitelist already excludes everything below. These rules exist so the
   build fails loudly if a future edit ever lets one of them in. */

const DENY_PATH = [
  { test: /(^|[\\/])\.[^\\/]+([\\/]|$)/, why: '隐藏文件/目录（.git、.env、.dsh-*、.workbuddy-* …）' },
  { test: /(^|[\\/])logs([\\/]|$)/i, why: '本地日志目录' },
  { test: /(^|[\\/])browser-data([\\/]|$)/i, why: '浏览器 profile' },
  { test: /(^|[\\/])node_modules([\\/]|$)/i, why: '依赖目录' },
  { test: /(^|[\\/])__pycache__([\\/]|$)/i, why: 'Python 缓存' },
  { test: /(^|[\\/])vision([\\/]|$)/i, why: 'Vision Python 环境（P7 不打包）' },
  { test: /(^|[\\/])scripts([\\/]|$)/i, why: '开发脚本（构建/截图/更新运行时）' },
  { test: /(^|[\\/])installer[\\/][^\\/]+\.iss$/i, why: 'Inno Setup 脚本本身' },
  { test: /(^|[\\/])test_[^\\/]*$/i, why: '测试文件' },
  { test: /(^|[\\/])tmp_ib_probe[^\\/]*$/i, why: '临时探针脚本' },
  { test: /(^|[\\/])scripts_check_html\.js$/i, why: '开发期 HTML 检查脚本' },
  { test: /(^|[\\/])test-all\.js$/i, why: '测试入口' },
  { test: /(^|[\\/])test-ui\.cmd$/i, why: '开发期测试入口' },
  { test: /(^|[\\/])start-[^\\/]*\.cmd$/i, why: '开发期服务启动脚本（用户入口只有 InternalBeyond）' },
  { test: /(^|[\\/])create-desktop-shortcut\.cmd$/i, why: '开发期快捷方式脚本（改由安装器负责）' },
  { test: /(^|[\\/])Start Internal Beyond\.cmd$/i, why: '开发期兼容入口（用户只看到 InternalBeyond）' },
  { test: /(^|[\\/])P\d+[-A-Z0-9]*-REPORT\.md$/i, why: '开发阶段报告' },
  { test: /\.results\.json$/i, why: '审计机器可读结果' },
  { test: /\.(log|bak|tmp|orig)$/i, why: '日志 / 备份 / 临时文件' },
  { test: /(^|[\\/])Gemini_Generated_Image_[^\\/]*$/i, why: '本机生成素材' },
  { test: /(^|[\\/])_icon_preview\.png$/i, why: '本机预览图' },
  { test: /(^|[\\/])bg-canvas\.png$/i, why: '6 MB 可选背景（缺失时静默，不进发行包）' },
  { test: /(^|[\\/])test_vision\.py$/i, why: 'Vision 测试脚本' }
];

/* File extensions that may be scanned as UTF-8 text. */
const TEXT_EXT = new Set([
  '.html', '.htm', '.js', '.mjs', '.cjs', '.css', '.json', '.md', '.txt', '.vbs', '.cmd', '.bat', '.yml', '.yaml', '.iss', '.ps1'
]);

/* ── Resolution ────────────────────────────────────────────────────────── */

function toPosix(p) { return String(p).split(path.sep).join('/'); }

function wildcardToRegExp(pattern) {
  const escaped = String(pattern).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp('^' + escaped + '$', 'i');
}

function walkDir(absDir, relPrefix, excludes, out) {
  let names = [];
  try { names = fs.readdirSync(absDir); } catch (e) { return out; }
  names.sort();
  for (const name of names) {
    const abs = path.join(absDir, name);
    const rel = relPrefix ? relPrefix + '/' + name : name;
    let stat = null;
    try { stat = fs.statSync(abs); } catch (e) { continue; }
    if (stat.isDirectory()) { walkDir(abs, rel, excludes, out); continue; }
    if (!stat.isFile()) continue;
    if (excludes.some(re => re.test(rel))) continue;
    out.push({ rel: rel, abs: abs, bytes: stat.size });
  }
  return out;
}

/*
 * Resolve the whitelist against a source tree.
 * opts.root        → source tree (defaults to the repo root)
 * returns { ok, root, files:[{from,to,abs,bytes,why}], totalBytes, missing, denied }
 */
function resolve(opts) {
  const o = opts || {};
  const root = path.resolve(o.root || ROOT);
  const files = [];
  const missing = [];
  const denied = [];

  for (const entry of ENTRIES) {
    const abs = path.join(root, entry.from);
    let stat = null;
    try { stat = fs.statSync(abs); } catch (e) { stat = null; }
    if (!stat) { missing.push({ from: entry.from, why: entry.why }); continue; }
    const to = entry.to || entry.from;
    if (stat.isDirectory()) {
      const excludes = (entry.exclude || []).map(wildcardToRegExp);
      const found = walkDir(abs, '', excludes, []);
      for (const f of found) {
        files.push({
          from: toPosix(entry.from) + '/' + f.rel,
          to: toPosix(to) + '/' + f.rel,
          abs: f.abs,
          bytes: f.bytes,
          why: entry.why
        });
      }
    } else {
      files.push({ from: toPosix(entry.from), to: toPosix(to), abs: abs, bytes: stat.size, why: entry.why });
    }
  }

  files.sort((a, b) => (a.to < b.to ? -1 : a.to > b.to ? 1 : 0));

  /* No payload path may match a deny rule. */
  for (const f of files) {
    for (const rule of DENY_PATH) {
      if (rule.test.test(f.to)) { denied.push({ path: f.to, why: rule.why }); break; }
    }
  }

  const totalBytes = files.reduce((n, f) => n + f.bytes, 0);
  return {
    ok: missing.length === 0 && denied.length === 0,
    root: root,
    entries: ENTRIES.length,
    files: files,
    count: files.length,
    totalBytes: totalBytes,
    missing: missing,
    denied: denied
  };
}

/* Audit an arbitrary directory (e.g. the staged payload) against the same deny
   rules. Used after staging so the guarantee is checked on real bytes. */
function auditDirectory(dir) {
  const abs = path.resolve(String(dir || ''));
  const found = [];
  const violations = [];
  function walk(d, prefix) {
    let names = [];
    try { names = fs.readdirSync(d); } catch (e) { return; }
    names.sort();
    for (const name of names) {
      const full = path.join(d, name);
      const rel = prefix ? prefix + '/' + name : name;
      let stat = null;
      try { stat = fs.statSync(full); } catch (e) { continue; }
      if (stat.isDirectory()) { walk(full, rel); continue; }
      found.push({ path: rel, bytes: stat.size });
      for (const rule of DENY_PATH) {
        if (rule.test.test(rel)) { violations.push({ path: rel, why: rule.why }); break; }
      }
    }
  }
  walk(abs, '');
  return { dir: abs, count: found.length, totalBytes: found.reduce((n, f) => n + f.bytes, 0), files: found, violations: violations };
}

function isTextFile(name) {
  return TEXT_EXT.has(path.extname(String(name)).toLowerCase());
}

/*
 * Materialise the whitelist into a staging directory.
 * opts.clean  → remove the target first (default true when the dir is inside
 *               the repo's dist/ tree; never removes the repo itself)
 * returns { ok, dir, staged, totalBytes, files, missing, denied }
 */
function stage(dir, opts) {
  const o = opts || {};
  const target = path.resolve(String(dir || path.join(ROOT, 'dist', 'staging')));
  const resolved = resolve(o);
  if (!resolved.ok) {
    return { ok: false, dir: target, staged: 0, totalBytes: 0, files: [], missing: resolved.missing, denied: resolved.denied };
  }
  /* Guard: never recursively delete something that is not a staging directory. */
  const looksLikeStaging = /(^|[\\/])(staging|stage|payload)([\\/]|$)/i.test(target) || o.allowAnyDir === true;
  if (!looksLikeStaging) {
    return { ok: false, dir: target, staged: 0, totalBytes: 0, files: [], missing: resolved.missing, denied: resolved.denied, error: 'refusing to clean a directory that does not look like a staging dir: ' + target };
  }
  if (o.clean !== false) fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(target, { recursive: true });
  for (const f of resolved.files) {
    const dst = path.join(target, f.to);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(f.abs, dst);
  }
  return {
    ok: true,
    dir: target,
    staged: resolved.files.length,
    totalBytes: resolved.totalBytes,
    files: resolved.files.map(f => f.to),
    missing: resolved.missing,
    denied: resolved.denied,
    error: null
  };
}

module.exports = {
  ROOT: ROOT,
  ENTRIES: ENTRIES,
  DENY_PATH: DENY_PATH,
  TEXT_EXT: TEXT_EXT,
  resolve: resolve,
  stage: stage,
  auditDirectory: auditDirectory,
  isTextFile: isTextFile,
  toPosix: toPosix
};

/* ── CLI ───────────────────────────────────────────────────────────────── */
if (require.main === module) {
  const argv = process.argv.slice(2);
  const get = function (name) { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : ''; };
  if (argv.indexOf('--stage') >= 0) {
    const result = stage(get('--stage'), { clean: argv.indexOf('--no-clean') < 0, allowAnyDir: argv.indexOf('--allow-any-dir') >= 0 });
    process.stdout.write(JSON.stringify({
      ok: result.ok, dir: result.dir, staged: result.staged, totalBytes: result.totalBytes,
      missing: result.missing, denied: result.denied, error: result.error || null
    }) + '\n');
    process.exitCode = result.ok ? 0 : 1;
  } else {
    const r = resolve({});
    process.stdout.write(JSON.stringify({
      ok: r.ok, entries: r.entries, count: r.count, totalBytes: r.totalBytes,
      missing: r.missing, denied: r.denied
    }, null, 2) + '\n');
    process.exitCode = r.ok ? 0 : 1;
  }
}
