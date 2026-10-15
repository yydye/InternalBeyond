'use strict';

/*
 * Internal Beyond · release payload manifest (P7)
 *
 * WHITELIST ONLY. The installer never packages the repository. This file is
 * the sole authority for source roots and deny/exclude rules; recursive roots
 * auto-discover reviewed production trees, and static local dependencies
 * referenced by those roots are closed transitively after path/type checks.
 * Unreferenced files elsewhere in the repository remain absent by construction.
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
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const DSH_RUNTIME_EXCLUDES = [
  'node_modules/@deepseek-ai/dsh-experimental-inspector/scripts/**',
  'node_modules/@deepseek-ai/dsh-experimental-inspector/lib/devtools/**',
  'node_modules/@deepseek-ai/dsh-sandbox-windows-acl/assets/diagnose-windows-sandbox-acl/scripts/**',
  'node_modules/@deepseek-ai/dsh-skill-office/assets/scripts/**',
  'node_modules/@deepseek-ai/dsh-subprocess-local/scripts/**',
  'node_modules/@deepseek-ai/libreoffice-kit-win32-x64/sources/scripts/**',
  'node_modules/@swc/helpers/scripts/**',
  'node_modules/**/README*.md',
  'node_modules/**/*.d.ts',
  'node_modules/**/*.pdb',
  'node_modules/node-pty/scripts/post-install.js',
  'node_modules/node-pty/scripts/prebuild.js',
  'node_modules/protobufjs/scripts/postinstall.js',
  'node_modules/undici/scripts/strip-comments.js',
  'node_modules/node-domexception/.history/**'
];

/* ── Whitelist ─────────────────────────────────────────────────────────── */

const ENTRIES = [
  /* Application document + front end.
     assets/ now also carries the theme backgrounds (assets/images) and the
     official icon (assets/icons); bg-canvas.png is a 6 MB optional background
     that must stay out of the payload, exactly as the deny rule states. */
  { from: 'InternalBeyond.html', why: '主文档（唯一 HTML 入口）' },
  { from: 'Recovery.html', why: 'Tauri RecoveryOnly source-validation / dry-run + one-use approved apply UI；不加载 normal Web Core / services，global apply 与 Active re-arm 默认关闭' },
  { from: 'assets', dir: true, exclude: ['images/bg-canvas.png', 'js/dev-runtime.js'],
    why: '全部生产前端脚本与样式；不含可选大背景及仅由 Dev Host 条件加载的 Snapshot 导入器' },
  { from: 'apps', dir: true, why: 'APP 目录（apps/catalog.json 由 app-store 运行时 fetch）' },
  { from: 'game', dir: true, exclude: ['portraits/portrait_[*].png'], why: '游戏模块与素材（个人头像 portrait_[昵称].png 属于用户数据，不入包）' },
  { from: 'Video/08e2b1dc2b734d4fafae30c3fb9f2f01 (1).mp4', why: 'Tauri 启动覆盖层播放的 MP4 素材' },

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
  { from: 'runtime/component-registry.js', why: '组件注册表唯一事实源（端口 / 身份探针 / 组件轴；boot-state 与 runner 都 require 它，缺失会让启动链直接崩）' },
  { from: 'runtime/component-supervisor.js', why: '有界崩溃恢复策略引擎（重启预算 / 退避 / 失败锁死；runner 启动期 require 它，缺失同样会让启动链直接崩）' },
  { from: 'runtime/dev-service-contract.js', why: '生产与 Dev 服务共享的端口及数据隔离契约；runner、Bridge、Active、Home Node 和静态服务均在启动期 require' },
  { from: 'runtime/dev-snapshot.js', why: 'Home Node Agent Memory 导入/备份边界使用的快照验证 helper；Home Node 启动时加载，不含 Synthetic Seed 或 Provider' },
  /* P11-3X-B：数据库失败的唯一分类来源。chat / memory / device 三个 store 与
     component-registry 都在启动期 require 它 —— 缺了它，Home Node 会以一个
     谁也读不出来的 require 错误起不来。manifest 是**逐文件白名单**（不是 glob），
     所以新增运行时模块必须在这里登记，否则开发机全绿、安装后必崩。 */
  { from: 'runtime/db-failure.js', why: '数据库失败分类器（只读 / 权限 / 忙 / 磁盘满 / 损坏 / schema 过新 / 打不开；store 与组件模型共用的唯一分类源）' },
  { from: 'runtime/launch-internal-beyond.js', why: '正式静默启动链（快捷方式最终执行）' },
  { from: 'runtime/local-services-runner.js', why: '本地服务管理进程（Bridge / Active / Home Node + 重启与停止控制面）' },
  { from: 'services/internal-beyond-server.js', why: '本地静态页面服务（AudioWorklet 必需）' },
  { from: 'services/project-knowledge.js', why: 'Browser Project Knowledge 只读 adapter（静态服务的 /__project-knowledge contract）' },
  { from: 'services/packaging-center-api.js', why: 'P35.6 同源 UI API adapter；仅在源码构建控制面可用时委托，安装包不包含 P35 Control Plane' },
  { from: 'services/ib-bridge-service.js', why: 'Bridge 后端' },
  { from: 'services/active-message-service.js', why: 'Active 后台主动消息服务' },
  /* P11-3B 收口既有缺口：runner 一直把 Home Node 当作已注册服务启动，但它从未
     入过发行包 —— 安装后的产品里那一步必然 spawn 一个不存在的脚本。注册表把
     Home Node 变成注册表里的正式组件之后，这个缺口必须在同一步补上。 */
  { from: 'services/home-node-service.js', why: 'Home Node 聊天权威服务（canonical chatMessages）' },
  { from: 'services/home-node', dir: true, why: 'Home Node 模块（chat store / memory / understanding / moments / 设备注册表 / mobile 网关 / HTTP）' },
  { from: 'bridge', dir: true, why: 'Bridge 模块' },
  { from: 'active', dir: true, why: 'Active 模块' },
  { from: '启动 InternalBeyond.vbs', why: '唯一用户启动入口的实现（快捷方式目标，用户只看到名字 InternalBeyond）' },
  { from: 'installer/tools/ib-stop.js', to: 'tools/ib-stop.js', why: '升级/卸载前优雅停止自身实例的助手（P11-3H：需要 runtime/component-registry.js 与 runtime/component-lifecycle.js，它从 --root 里解析它们）' },
  { from: 'runtime/service-control.js', why: '合作停止面（/__shutdown 的唯一准入规则与拆除梯子；四个服务都 require 它，缺失会让启动链直接崩）' },
  { from: 'runtime/host-origin.js', why: 'Tauri 2 bundled WebView origin predicate（Browser/Bridge/Active/Home Node/stop control 共用的纯 helper）' },
  { from: 'runtime/component-lifecycle.js', why: '组件停止状态机（唯一停止契约；runner 与 installer 的 ib-stop 都用它，缺失同样会让启动链直接崩）' },

  /* DSH remains an optional per-user extension. The small package verifier and
     the build-time pin stay in the main app; the ~600 MiB runtime is shipped as
     a separate, checksummed ZIP. */
  { from: 'runtime/optional-dsh-runtime.js', why: '校验可选 DSH Runtime ZIP、版本兼容性与独立扩展路径' },
  { from: 'runtime/dsh-runtime-release.js', why: '验证 Ed25519 签名 DSH Runtime 版本清单并限定 HTTPS 下载' },
  { from: 'runtime/dsh-runtime-release-trust.json', why: 'DSH Runtime 发布签名公钥与 HTTPS 主机白名单' },
  { from: 'runtime/dsh-runtime-package-pin.json', why: '可选 DSH Runtime ZIP 的发行 SHA-256 与兼容性钉定值' },
  /* Both installer modules are already included by the services/home-node
     directory entry above; listing them again duplicates manifest paths and
     makes the production Host reject its own payload count. */
  { from: 'runtime/dsh-native-work-ui', dir: true, why: '生产 DSH Work Mode UI 插件；直接 DSH 模型/工具能力 fail-closed，Run 由 Home Node 执行' },
  { from: 'runtime/dsh-startup-screen', dir: true, why: 'DSH 许可的启动与 Consent UI 适配器' },

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
  { test: /(^|[\\/])(?:credentials?|secrets?|private[-_]?key|id_rsa|id_ed25519|(?:access|auth|refresh)[-_]?token|api[-_]?key)(?:\.[^\\/]+)?$/i,
    why: '凭据、密钥或私钥文件' },
  { test: /\.(?:pem|key|p12|pfx|jks|keystore|sqlite|sqlite3|db)$/i,
    why: '密钥容器或用户/运行时数据库文件' },
  { test: /(^|[\\/])(?:user[-_]?data|userdata|local[-_]?data|user[-_]?profiles?|profile[-_]?data|indexeddb|webview2)([\\/]|$)/i,
    why: '用户数据、浏览器配置或本地持久化数据' },
  { test: /^game\/(?:save|saves|save-data|user-data)(?:\/|$)/i,
    why: 'Game 运行时存档/用户数据不进入发行包' },
  { test: /(^|[\\/])(?:tests?|__tests__|fixtures?|test-data|test-fixtures|__snapshots__|coverage|cache|caches|tmp|temp)([\\/]|$)/i,
    why: '测试夹具、缓存或临时目录' },
  { test: /(^|[\\/])(?:(?:test|spec)[._-][^\\/]*|[^\\/]+[._-](?:test|spec))\.(?:js|mjs|cjs|jsx|tsx|ts|css|html|json)$/i,
    why: '测试或规格文件' },
  { test: /^runtime\/dsh-runtime\/node_modules\/(?:.*\/)?(?:\.env(?:\.[^/]*)?|\.npmrc|\.netrc|[^/]*\.(?:pem|key|p12|pfx)|id_rsa|id_ed25519)(?:$|\/)/i,
    why: 'DSH runtime 中禁止凭据与私钥文件' },
  { test: /^runtime\/dsh-runtime\/node_modules\/(?:.*\/)?[^/]*(?:mock-server|fake-provider|synthetic-fake)[^/]*(?:\/|$)/i,
    why: '正式 DSH Runtime 不得包含 Synthetic/Fake Provider' },
  { test: /^runtime\/dsh-native-ui-p0(?:\.js|\/)/i, why: 'Synthetic-only DSH P0 host 不进入正式安装包' },
  { test: /^runtime\/dev-synthetic-seed\.js$/i, why: 'Synthetic seed / Fake Provider 不进入正式安装包' },
  { test: /(^|[\\/])\.[^\\/]+([\\/]|$)/, allowPrefixes: ['runtime/dsh-runtime/node_modules/'], why: '隐藏文件/目录（.git、.env、.dsh-*、.workbuddy-* …）' },
  { test: /(^|[\\/])dev-runtime\.js$/i, why: 'Dev Sandbox IndexedDB snapshot importer' },
  { test: /(^|[\\/])logs([\\/]|$)/i,
    allowPrefixes: ['runtime/dsh-runtime/node_modules/@opentelemetry/otlp-transformer/build/'],
    why: '本地日志目录' },
  { test: /(^|[\\/])browser-data([\\/]|$)/i, why: '浏览器 profile' },
  { test: /(^|[\\/])node_modules([\\/]|$)/i, allowPrefixes: ['runtime/dsh-runtime/node_modules/'], why: '依赖目录（仅固定 DSH Runtime 依赖树例外）' },
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

/* Existing directory entries intentionally discover new application assets at
   build time. Keep that behavior, but fail closed for a new file type whose
   release behavior has not been reviewed. Exact executable inputs (the Node
   runtime and generated Tauri Host) remain governed by their existing pins. */
const AUTO_DISCOVERY_EXT = new Set([
  '.html', '.htm', '.js', '.mjs', '.cjs', '.css', '.json', '.md', '.txt', '.yml', '.yaml',
  '.png', '.apng', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.bmp', '.svg', '.ico',
  '.mp3', '.m4a', '.aac', '.wav', '.ogg', '.mp4', '.webm', '.webmanifest',
  '.woff', '.woff2', '.ttf', '.otf', '.eot', '.wasm'
]);

const AUTO_DISCOVERY_EXTENSION_EXCEPTIONS = new Set([
  'runtime/node/node.exe', 'internalbeyond-host.exe',
  'version', 'license', 'runtime/dsh-startup-screen/license',
  'runtime/node/version', 'runtime/node/license', 'runtime/node/sha256sums',
  '启动 internalbeyond.vbs'
]);

/* ── Resolution ────────────────────────────────────────────────────────── */

function toPosix(p) { return String(p).split(path.sep).join('/'); }

function wildcardToRegExp(pattern) {
  const escaped = String(pattern).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp('^' + escaped + '$', 'i');
}

function walkDir(absDir, relPrefix, excludes, out, issues) {
  let names = [];
  try { names = fs.readdirSync(absDir); } catch (e) {
    if (issues) issues.push({ path: relPrefix || absDir, why: '目录无法读取，不能确认完整载荷' });
    return out;
  }
  names.sort();
  for (const name of names) {
    const abs = path.join(absDir, name);
    const rel = relPrefix ? relPrefix + '/' + name : name;
    let stat = null;
    try { stat = fs.lstatSync(abs); } catch (e) {
      if (issues) issues.push({ path: rel, why: '文件元数据无法读取，不能确认是否应打包' });
      continue;
    }
    if (stat.isSymbolicLink()) {
      if (issues) issues.push({ path: rel, why: '符号链接/目录联接无法安全判定目标，拒绝打包' });
      continue;
    }
    if (stat.isDirectory()) { walkDir(abs, rel, excludes, out, issues); continue; }
    if (!stat.isFile()) {
      if (issues) issues.push({ path: rel, why: '发现非普通文件，无法安全打包' });
      continue;
    }
    if (excludes.some(re => re.test(rel))) continue;
    out.push({ rel: rel, abs: abs, bytes: stat.size });
  }
  return out;
}

function isWithinRoot(root, absolutePath) {
  const relative = path.relative(path.resolve(root), path.resolve(absolutePath));
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function normalizedTarget(value) {
  return toPosix(value).replace(/^\.\//, '').toLowerCase();
}

function isManifestExcluded(relativePath, entries) {
  const normalized = toPosix(relativePath).toLowerCase();
  for (const entry of entries) {
    if (!entry.dir) continue;
    const prefix = toPosix(entry.from).replace(/\/$/, '').toLowerCase() + '/';
    if (!normalized.startsWith(prefix)) continue;
    const inside = toPosix(relativePath).slice(prefix.length);
    if ((entry.exclude || []).some(pattern => wildcardToRegExp(pattern).test(inside))) return true;
  }
  return false;
}

function hasReleaseExtension(relativePath) {
  const extension = path.extname(String(relativePath)).toLowerCase();
  return AUTO_DISCOVERY_EXT.has(extension)
    || AUTO_DISCOVERY_EXTENSION_EXCEPTIONS.has(toPosix(relativePath).toLowerCase());
}

function collectStaticReferences(file) {
  const ext = path.extname(file.to).toLowerCase();
  let source = '';
  try { source = fs.readFileSync(file.abs, 'utf8'); } catch (_) { return []; }
  const refs = [];
  const add = (kind, value) => {
    const ref = String(value || '').trim();
    if (!ref || /^(?:[a-z][a-z0-9+.-]*:|\/\/|#|data:|blob:|about:|mailto:|javascript:)/i.test(ref)) return;
    if (/[<>`{}$*]/.test(ref)) return; // template, glob, or unresolved runtime expression
    refs.push({ kind: kind, value: ref });
  };

  if (ext === '.js' || ext === '.mjs' || ext === '.cjs') {
    let match;
    const importerIsNode = /^(?:runtime|services|bridge|active|tools)\//i.test(toPosix(file.to));
    if (importerIsNode) {
      const requireRe = /\brequire\s*\(\s*(['"])(\.{1,2}\/[^'"]+)\1\s*\)/g;
      while ((match = requireRe.exec(source))) add('module', match[2]);
    }
    const importRe = /\bimport\s*(?:\(\s*)?(?:[^'";]*?\s+from\s*)?(['"])(\.{1,2}\/[^'"]+)\1\s*\)?/g;
    while ((match = importRe.exec(source))) add('module', match[2]);
    const urlRe = /\bnew\s+URL\s*\(\s*(['"])(\.{1,2}\/[^'"]+)\1\s*,\s*import\.meta\.url\s*\)/g;
    while ((match = urlRe.exec(source))) add('resource', match[2]);

    /* A computed local module path has no safe target to stage. Do not silently
       accept it just because the current resolver cannot infer its value. */
    const dynamicCallRe = /\b(?:require|import)\s*\(([^)]*)\)/g;
    while ((match = dynamicCallRe.exec(source))) {
      const expression = match[1].replace(/\/\*[\s\S]*?\*\//g, '').trim();
      if (!expression) continue;
      const quote = expression[0];
      let literal = false;
      if (quote === '"' || quote === "'") {
        let escaped = false;
        for (let i = 1; i < expression.length; i++) {
          if (escaped) { escaped = false; continue; }
          if (expression[i] === '\\') { escaped = true; continue; }
          if (expression[i] === quote) { literal = i === expression.length - 1; break; }
        }
      }
      const knownPathBuilder = /\b(?:path\.(?:join|resolve)|pathToFileURL)\s*\(/.test(expression);
      const directoryAutoIncluded = /^assets\//i.test(toPosix(file.to));
      /* The Inno upgrade helper selects these three already-pinned files under
         its explicit --root; its pre-copy extraction entries are checked in
         tests/test_installer.js and cannot be inferred from source-relative paths. */
      const stopHelperRootLookup = toPosix(file.to) === 'tools/ib-stop.js'
        && ['reg', 'life', 'lifeOnly'].includes(expression);
      if (!literal && !knownPathBuilder && !directoryAutoIncluded && !stopHelperRootLookup) {
        refs.push({ kind: 'unsafe', value: expression, why: '动态模块路径无法安全解析' });
      }
    }
  } else if (ext === '.html' || ext === '.htm') {
    let tagMatch;
    const tagRe = /<(?:script|link|img|source|video|audio|track|iframe|embed|object|input)\b[^>]*>/gi;
    while ((tagMatch = tagRe.exec(source))) {
      const tag = tagMatch[0];
      const attrRe = /\b(src|href|poster|data|srcset)\s*=\s*(['"])(.*?)\2/gi;
      let attrMatch;
      while ((attrMatch = attrRe.exec(tag))) {
        const attr = attrMatch[1].toLowerCase();
        if (attr === 'srcset') {
          for (const candidate of attrMatch[3].split(',')) add('resource', candidate.trim().split(/\s+/)[0]);
        } else add('resource', attrMatch[3]);
      }
    }
  } else if (ext === '.css') {
    let match;
    const urlRe = /url\(\s*(['"]?)(.*?)\1\s*\)/gi;
    while ((match = urlRe.exec(source))) add('resource', match[2]);
    const importRe = /@import\s+(?:url\(\s*)?(['"])(.*?)\1\s*\)?/gi;
    while ((match = importRe.exec(source))) add('resource', match[2]);
  }
  return refs;
}

function resolveReferenceFile(root, importer, reference, kind) {
  let decoded = String(reference || '');
  try { decoded = decodeURIComponent(decoded); } catch (_) {
    return { error: '引用路径包含无效百分号编码' };
  }
  decoded = decoded.split(/[?#]/, 1)[0].replace(/\\/g, '/');
  if (!decoded) return { ignored: true };
  const importerTarget = path.resolve(root, path.dirname(toPosix(importer.to)));
  const absolute = decoded.startsWith('/')
    ? path.resolve(root, decoded.replace(/^\/+/, ''))
    : path.resolve(importerTarget, decoded);
  if (!isWithinRoot(root, absolute)) return { error: '引用路径逃逸仓库根目录' };
  const candidates = [absolute];
  if (kind === 'module' && !path.extname(absolute)) {
    for (const extension of ['.js', '.mjs', '.cjs', '.json']) candidates.push(absolute + extension);
    candidates.push(path.join(absolute, 'index.js'), path.join(absolute, 'index.json'));
    const packageFile = path.join(absolute, 'package.json');
    try {
      const pkg = JSON.parse(fs.readFileSync(packageFile, 'utf8'));
      if (typeof pkg.main === 'string') {
        const main = path.resolve(absolute, pkg.main);
        if (isWithinRoot(root, main)) {
          candidates.push(main, main + '.js', main + '.json', path.join(main, 'index.js'));
        }
      }
    } catch (_) { /* directory without a readable package entry */ }
  }
  for (const candidate of candidates) {
    let stat = null;
    try { stat = fs.lstatSync(candidate); } catch (_) { continue; }
    if (stat.isSymbolicLink()) return { absolute: candidate, error: '引用目标是符号链接/目录联接，无法安全判定' };
    if (stat.isFile()) return { absolute: candidate, relative: toPosix(path.relative(root, candidate)), bytes: stat.size };
  }
  return { absolute: absolute, relative: toPosix(path.relative(root, absolute)), error: '引用目标文件不存在' };
}

function discoverReferencedFiles(root, files, entries, denied, unsafe, missingReferences) {
  const discovered = [];
  const byTarget = new Map(files.map(file => [normalizedTarget(file.to), file]));
  const scanned = new Set();
  const queue = files.slice();
  while (queue.length) {
    const importer = queue.shift();
    const importerTarget = normalizedTarget(importer.to);
    if (scanned.has(importerTarget)) continue;
    scanned.add(importerTarget);
    for (const ref of collectStaticReferences(importer)) {
      if (ref.kind === 'unsafe') {
        unsafe.push({ path: importer.to, from: importer.to, reference: ref.value, why: ref.why });
        continue;
      }
      const resolved = resolveReferenceFile(root, importer, ref.value, ref.kind);
      if (resolved.ignored) continue;
      const label = importer.to + ' -> ' + ref.value;
      if (resolved.error) {
        if (resolved.relative && isManifestExcluded(resolved.relative, entries)) continue;
        const finding = { path: resolved.relative || ref.value, from: importer.to, reference: ref.value, why: resolved.error };
        if (/不存在/.test(resolved.error)) missingReferences.push(finding);
        else unsafe.push(finding);
        continue;
      }
      const target = resolved.relative;
      const key = normalizedTarget(target);
      if (byTarget.has(key)) continue;
      for (const rule of DENY_PATH) {
        if (isDeniedPath(rule, target)) {
          denied.push({ path: target, from: importer.to, why: '被发布排除规则拒绝：' + rule.why });
          break;
        }
      }
      if (denied.some(item => normalizedTarget(item.path) === key)) continue;
      if (!hasReleaseExtension(target)) {
        unsafe.push({ path: target, from: importer.to, reference: ref.value, why: '静态引用文件类型尚无安全分发规则' });
        continue;
      }
      const discoveredFile = {
        from: target,
        to: target,
        abs: resolved.absolute,
        bytes: resolved.bytes,
        why: '由正式载荷静态引用自动发现（' + label + '）',
        discovered: true
      };
      files.push(discoveredFile);
      discovered.push(discoveredFile);
      byTarget.set(key, discoveredFile);
      queue.push(discoveredFile);
    }
  }
  return discovered;
}

function isDeniedPath(rule, relativePath) {
  if (!rule.test.test(relativePath)) return false;
  const normalized = toPosix(relativePath).toLowerCase();
  if (Array.isArray(rule.allowPrefixes)
    && rule.allowPrefixes.some(prefix => normalized.startsWith(String(prefix).toLowerCase()))) return false;
  return true;
}

function validatePinnedDshRuntime(root) {
  const violations = [];
  const runtimeRoot = path.join(root, 'runtime', 'dsh-runtime');
  const manifestPath = path.join(runtimeRoot, 'runtime-manifest.json');
  let manifest = null;
  try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); }
  catch (_) { return [{ path: 'runtime/dsh-runtime/runtime-manifest.json', why: 'DSH runtime manifest missing or invalid' }]; }
  if (manifest.schema !== 'internalbeyond.dsh-runtime'
    || manifest.sourceRevision !== 'd743267388641bc76f17c45ce8b4c231aed1d32c'
    || manifest.target !== 'windows-x64' || Number(manifest.protocolVersion) !== 1
    || manifest.entry !== 'apps/cli/src/bin.ts' || manifest.config !== 'config/cordis.yml') {
    violations.push({ path: 'runtime/dsh-runtime/runtime-manifest.json', why: 'DSH runtime pin or entry contract mismatch' });
  }
  const packages = [].concat(manifest.workspacePackages || [], manifest.externalPackages || [], manifest.compatibilityPackages || []);
  if (!packages.length || packages.some(item => /(?:mock-server|fake-provider|synthetic-provider)/i.test(String(item && item.name || '')))) {
    violations.push({ path: 'runtime/dsh-runtime/runtime-manifest.json', why: 'DSH package roster is empty or includes a mock provider' });
  }
  for (const item of packages) {
    const relative = String(item && item.runtimePath || '').replace(/\\/g, '/');
    if (!relative.startsWith('node_modules/') || relative.split('/').includes('..')) {
      violations.push({ path: 'runtime/dsh-runtime/runtime-manifest.json', why: 'DSH package path escapes the pinned runtime' });
      break;
    }
    let actual = null;
    try { actual = JSON.parse(fs.readFileSync(path.join(runtimeRoot, relative, 'package.json'), 'utf8')); }
    catch (_) { actual = null; }
    if (!actual || actual.name !== item.name || String(actual.version) !== String(item.version)) {
      violations.push({ path: 'runtime/dsh-runtime/' + relative + '/package.json', why: 'DSH package does not match its pinned roster entry' });
    }
  }
  const web = manifest.webFrontend;
  const webRelative = 'node_modules/@deepseek-ai/dsh-web-frontend/dist';
  if (!web || web.sourceRevision !== manifest.sourceRevision || web.runtimePath !== webRelative
    || !Number.isSafeInteger(web.artifactFiles) || web.artifactFiles < 1
    || !Number.isSafeInteger(web.artifactBytes) || web.artifactBytes < 1) {
    violations.push({ path: 'runtime/dsh-runtime/runtime-manifest.json', why: 'pinned DSH Web bundle metadata missing' });
  } else {
    const webDir = path.join(runtimeRoot, webRelative);
    const webFiles = walkDir(webDir, '', [], []);
    const indexFile = path.join(webDir, 'index.html');
    if (webFiles.length !== web.artifactFiles
      || webFiles.reduce((sum, file) => sum + file.bytes, 0) !== web.artifactBytes
      || !fs.existsSync(indexFile)) {
      violations.push({ path: 'runtime/dsh-runtime/' + webRelative, why: 'pinned DSH Web bundle size or file list mismatch' });
    } else {
      const hash = crypto.createHash('sha256').update(fs.readFileSync(indexFile)).digest('hex');
      if (hash !== String(web.indexSha256 || '').toLowerCase()) {
        violations.push({ path: 'runtime/dsh-runtime/' + webRelative + '/index.html', why: 'pinned DSH Web index hash mismatch' });
      }
    }
  }
  const runtimeFiles = walkDir(runtimeRoot, '', [], []);
  const expectedExcludes = DSH_RUNTIME_EXCLUDES.join('\n');
  if (!Array.isArray(manifest.productionExcludes)
    || manifest.productionExcludes.join('\n') !== expectedExcludes) {
    violations.push({ path: 'runtime/dsh-runtime/runtime-manifest.json', why: 'DSH production exclusion list differs from the release manifest' });
  }
  const productionFiles = walkDir(runtimeRoot, '', DSH_RUNTIME_EXCLUDES.map(wildcardToRegExp), []);
  if (productionFiles.length !== manifest.productionArtifactFiles
    || productionFiles.reduce((sum, file) => sum + file.bytes, 0) !== manifest.productionArtifactBytes) {
    violations.push({ path: 'runtime/dsh-runtime/runtime-manifest.json', why: 'DSH production artifact size or file list mismatch' });
  }
  if (runtimeFiles.length !== manifest.artifactFiles
    || runtimeFiles.reduce((sum, file) => sum + file.bytes, 0) !== manifest.artifactBytes) {
    violations.push({ path: 'runtime/dsh-runtime/runtime-manifest.json', why: 'DSH runtime artifact size or file list mismatch' });
  }
  return violations;
}

/*
 * Resolve the whitelist against a source tree.
 * opts.root        → source tree (defaults to the repo root)
 * returns { ok, root, files:[{from,to,abs,bytes,why}], totalBytes, missing,
 *           denied, unsafe, missingReferences, duplicatePaths, discovered }
 */
function resolve(opts) {
  const o = opts || {};
  const root = path.resolve(o.root || ROOT);
  const entries = Array.isArray(o.entries) ? o.entries : ENTRIES;
  const denyPath = Array.isArray(o.denyPath) ? o.denyPath : DENY_PATH;
  const files = [];
  const missing = [];
  const denied = [];
  const unsafe = [];
  const duplicatePaths = [];
  const missingReferences = [];

  for (const entry of entries) {
    const sourceName = toPosix(entry.from || '');
    if (!sourceName || sourceName.startsWith('/') || sourceName.split('/').includes('..')) {
      unsafe.push({ path: sourceName, why: '发布清单源路径为空、绝对路径或包含目录逃逸' });
      continue;
    }
    const abs = path.join(root, entry.from);
    let stat = null;
    try { stat = fs.lstatSync(abs); } catch (e) { stat = null; }
    if (!stat) { missing.push({ from: entry.from, why: entry.why }); continue; }
    if (stat.isSymbolicLink()) {
      unsafe.push({ path: sourceName, why: '发布清单入口是符号链接/目录联接，无法安全判定目标' });
      continue;
    }
    const to = entry.to || entry.from;
    const targetName = toPosix(to);
    if (targetName.startsWith('/') || targetName.split('/').includes('..')) {
      unsafe.push({ path: targetName, why: '发布清单目标路径是绝对路径或包含目录逃逸' });
      continue;
    }
    if (stat.isDirectory()) {
      const excludes = (entry.exclude || []).map(wildcardToRegExp);
      const found = walkDir(abs, '', excludes, [], unsafe);
      for (const f of found) {
        files.push({
          from: toPosix(entry.from) + '/' + f.rel,
          to: toPosix(to) + '/' + f.rel,
          abs: f.abs,
          bytes: f.bytes,
          why: entry.why
        });
      }
    } else if (stat.isFile()) {
      files.push({ from: toPosix(entry.from), to: toPosix(to), abs: abs, bytes: stat.size, why: entry.why });
    } else {
      unsafe.push({ path: sourceName, why: '发布清单入口不是普通文件或目录' });
    }
  }

  /* Unknown file types entering a recursive production directory are not
     silently guessed to be runtime payload. Existing deny and directory-exclude
     rules are applied first; known application source and static media are
     then resolved through the same manifest. */
  for (const file of files) {
    if (!hasReleaseExtension(file.to)) {
      unsafe.push({ path: file.to, why: '发现尚无安全分发规则的文件类型；请审核后显式处理' });
    }
  }

  const discovered = discoverReferencedFiles(root, files, entries, denied, unsafe, missingReferences);

  files.sort((a, b) => (a.to < b.to ? -1 : a.to > b.to ? 1 : 0));

  const seenTargets = new Map();
  for (const file of files) {
    const key = normalizedTarget(file.to);
    if (seenTargets.has(key)) {
      duplicatePaths.push({ path: file.to, conflictsWith: seenTargets.get(key), why: '目标路径重复或仅大小写不同（Windows 安装目录不区分大小写）' });
    } else seenTargets.set(key, file.to);
  }

  /* No payload path may match a deny rule. */
  for (const f of files) {
    for (const rule of denyPath) {
      if (isDeniedPath(rule, f.to)) { denied.push({ path: f.to, why: rule.why }); break; }
    }
  }

  const totalBytes = files.reduce((n, f) => n + f.bytes, 0);
  const directoryPrefixes = entries.filter(entry => entry.dir).map(entry => toPosix(entry.from).replace(/\/$/, '').toLowerCase() + '/');
  const autoIncluded = files.filter(file => file.discovered
    || directoryPrefixes.some(prefix => toPosix(file.from).toLowerCase().startsWith(prefix)))
    .map(file => ({ path: file.to, bytes: file.bytes, why: file.why }));
  return {
    ok: missing.length === 0 && denied.length === 0 && unsafe.length === 0
      && missingReferences.length === 0 && duplicatePaths.length === 0,
    root: root,
    entries: entries.length,
    files: files,
    count: files.length,
    totalBytes: totalBytes,
    missing: missing,
    denied: denied,
    unsafe: unsafe,
    missingReferences: missingReferences,
    duplicatePaths: duplicatePaths,
    discovered: discovered.map(file => ({ path: file.to, bytes: file.bytes, why: file.why })),
    autoIncluded: autoIncluded
  };
}

/* Audit an arbitrary directory (e.g. the staged payload) against the same deny
   rules. Used after staging so the guarantee is checked on real bytes. */
function auditDirectory(dir) {
  const abs = path.resolve(String(dir || ''));
  const found = [];
  const violations = [];
  const duplicatePaths = [];
  const unsafe = [];
  const seen = new Map();
  function walk(d, prefix) {
    let names = [];
    try { names = fs.readdirSync(d); } catch (e) {
      unsafe.push({ path: prefix || d, why: 'Stage 目录无法读取，无法验证完整性' });
      return;
    }
    names.sort();
    for (const name of names) {
      const full = path.join(d, name);
      const rel = prefix ? prefix + '/' + name : name;
      let stat = null;
      try { stat = fs.lstatSync(full); } catch (e) {
        unsafe.push({ path: rel, why: 'Stage 文件元数据无法读取' });
        continue;
      }
      if (stat.isSymbolicLink()) {
        unsafe.push({ path: rel, why: 'Stage 中出现符号链接/目录联接，无法安全判定目标' });
        continue;
      }
      if (stat.isDirectory()) { walk(full, rel); continue; }
      if (!stat.isFile()) {
        unsafe.push({ path: rel, why: 'Stage 包含非普通文件' });
        continue;
      }
      found.push({ path: rel, bytes: stat.size });
      const key = normalizedTarget(rel);
      if (seen.has(key)) duplicatePaths.push({ path: rel, conflictsWith: seen.get(key), why: 'Stage 路径重复或仅大小写不同' });
      else seen.set(key, rel);
      for (const rule of DENY_PATH) {
        if (isDeniedPath(rule, rel)) { violations.push({ path: rel, why: rule.why }); break; }
      }
    }
  }
  walk(abs, '');
  return {
    dir: abs,
    count: found.length,
    totalBytes: found.reduce((n, f) => n + f.bytes, 0),
    files: found,
    violations: violations,
    duplicatePaths: duplicatePaths,
    unsafe: unsafe
  };
}

function isTextFile(name) {
  return TEXT_EXT.has(path.extname(String(name)).toLowerCase());
}

/*
 * Materialise the whitelist into a staging directory.
 * opts.clean  → remove the target first (default true when the dir is inside
 *               the repo's dist/ tree; never removes the repo itself)
 * returns { ok, dir, staged, totalBytes, files, records, missing, denied }
 */
function stage(dir, opts) {
  const o = opts || {};
  const target = path.resolve(String(dir || path.join(ROOT, 'dist', 'staging')));
  const resolved = resolve(o);
  if (!resolved.ok) {
    return {
      ok: false, dir: target, staged: 0, totalBytes: 0, files: [], missing: resolved.missing,
      denied: resolved.denied, unsafe: resolved.unsafe,
      missingReferences: resolved.missingReferences, duplicatePaths: resolved.duplicatePaths,
      discovered: resolved.discovered, autoIncluded: resolved.autoIncluded
    };
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
  const records = resolved.files.map(f => {
    const dst = path.join(target, f.to);
    const stat = fs.statSync(dst);
    return { path: f.to, sizeBytes: stat.size, sha256: sha256File(dst) };
  });
  return {
    ok: true,
    dir: target,
    staged: resolved.files.length,
    totalBytes: resolved.totalBytes,
    files: resolved.files.map(f => f.to),
    records: records,
    missing: resolved.missing,
    denied: resolved.denied,
    unsafe: resolved.unsafe,
    missingReferences: resolved.missingReferences,
    duplicatePaths: resolved.duplicatePaths,
    discovered: resolved.discovered,
    autoIncluded: resolved.autoIncluded,
    error: null
  };
}

module.exports = {
  ROOT: ROOT,
  DSH_RUNTIME_EXCLUDES: DSH_RUNTIME_EXCLUDES,
  ENTRIES: ENTRIES,
  DENY_PATH: DENY_PATH,
  TEXT_EXT: TEXT_EXT,
  AUTO_DISCOVERY_EXT: AUTO_DISCOVERY_EXT,
  wildcardToRegExp: wildcardToRegExp,
  resolve: resolve,
  stage: stage,
  auditDirectory: auditDirectory,
  collectStaticReferences: collectStaticReferences,
  isTextFile: isTextFile,
  toPosix: toPosix
};

/* ── CLI ───────────────────────────────────────────────────────────────── */
if (require.main === module) {
  const argv = process.argv.slice(2);
  const get = function (name) { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : ''; };
  if (argv.indexOf('--stage') >= 0) {
    const result = stage(get('--stage'), { clean: argv.indexOf('--no-clean') < 0, allowAnyDir: argv.indexOf('--allow-any-dir') >= 0 });
    /* `files` is part of the CLI contract, not just of the in-process return:
       the build generates the install root's own payload manifest
       (ib-payload-manifest.json) from this list, and a caller that had to
       re-derive it by walking the staging directory would be building the record
       of what we own from a directory scan instead of from the whitelist. */
    process.stdout.write(JSON.stringify({
      ok: result.ok, dir: result.dir, staged: result.staged, totalBytes: result.totalBytes,
      files: result.files, records: result.records || [], missing: result.missing, denied: result.denied,
      unsafe: result.unsafe || [], missingReferences: result.missingReferences || [],
      duplicatePaths: result.duplicatePaths || [], discovered: result.discovered || [],
      autoIncludedCount: (result.autoIncluded || []).length, error: result.error || null
    }) + '\n');
    process.exitCode = result.ok ? 0 : 1;
  } else {
    const r = resolve({});
    process.stdout.write(JSON.stringify({
      ok: r.ok, entries: r.entries, count: r.count, totalBytes: r.totalBytes,
      missing: r.missing, denied: r.denied, unsafe: r.unsafe,
      missingReferences: r.missingReferences, duplicatePaths: r.duplicatePaths,
      discovered: r.discovered, autoIncludedCount: r.autoIncluded.length
    }, null, 2) + '\n');
    process.exitCode = r.ok ? 0 : 1;
  }
}
