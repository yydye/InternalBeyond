'use strict';

/* Build the pinned DSH CLI and full official plugin dependency graph into the Dev runtime. */

const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const RELEASE_MANIFEST = require('./release-manifest.js');
const REVISION = 'd743267388641bc76f17c45ce8b4c231aed1d32c';
const VERSION = '0.2.1-alpha.2';
const BUILD_ARGS = process.argv.slice(2);
const REPLACE_OUTPUT = BUILD_ARGS.includes('--replace');
const DSH_RUNTIME_EXCLUDES = RELEASE_MANIFEST.DSH_RUNTIME_EXCLUDES;
function wildcardToRegExp(pattern) {
  const escaped = String(pattern).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp('^' + escaped + '$', 'i');
}
const DSH_RUNTIME_EXCLUDE_REGEXES = DSH_RUNTIME_EXCLUDES.map(wildcardToRegExp);
const SOURCE_ROOT = path.resolve(BUILD_ARGS.find(argument => argument !== '--replace') || process.env.IB_DSH_SOURCE_ROOT
  || path.resolve(ROOT, '..', 'DeepSeek-Harness-Mock-PoC'));
const OUTPUT_ROOT = path.join(ROOT, 'runtime', 'dsh-runtime');
const ADAPTER_SOURCE_ROOT = path.join(ROOT, 'runtime', 'dsh-source');
const COMPAT_SOURCE_ROOT = path.join(ROOT, 'runtime', 'dsh-compat');
const CLI_SOURCE_FILES = [
  'bin.ts', 'args.ts', 'profile-boot.ts', 'process-shutdown.ts', 'startup-diagnostics.ts'
];
const REQUIRED_PROFILE_PACKAGES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-acp-app'];
const SOURCE_SKIP = new Set([
  '.agents', '.changeset', '.git', '.github', '.turbo', 'coverage', 'docs', 'examples',
  'node_modules', 'test', 'tests', '__tests__', 'website'
]);
const PLATFORM_TOKENS = ['darwin', 'linux', 'freebsd', 'openbsd', 'sunos', 'android', 'win32', 'arm64', 'x64', 'ia32', 'armv7', 'musl', 'gnu', 'msvc'];
const BUILTIN_MODULES = new Set(require('node:module').builtinModules.flatMap(name => [name, name.replace(/^node:/, '')]));
const externalInstalled = new Map();
const externalVisited = new Set();
const externalRecords = new Map();
const compatibilityRecords = new Map();
const compatibilityOverridesApplied = new Map();
const runtimeProductionPatches = [];
const LOCAL_PACKAGE_OVERRIDES = Object.freeze({
  buffers: Object.freeze({
    version: '1.0.0-ib.1',
    sourceDirectory: path.join(COMPAT_SOURCE_ROOT, 'buffers'),
    replaces: 'buffers@0.1.1'
  })
});

function assertPinnedSource() {
  const packageManifest = JSON.parse(fs.readFileSync(path.join(SOURCE_ROOT, 'package.json'), 'utf8'));
  const actual = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: SOURCE_ROOT, encoding: 'utf8' }).trim();
  if (actual !== REVISION || packageManifest.version !== VERSION) {
    throw new Error(`DSH source pin mismatch: expected ${REVISION} ${VERSION}, received ${actual} ${String(packageManifest.version)}`);
  }
}

function workspacePackageMap() {
  const packages = new Map();
  const roots = ['apps', 'native/system', 'packages', 'vendor'];
  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || SOURCE_SKIP.has(entry.name)) continue;
      const target = path.join(directory, entry.name);
      const manifest = path.join(target, 'package.json');
      if (fs.existsSync(manifest)) {
        try {
          const parsed = JSON.parse(fs.readFileSync(manifest, 'utf8'));
          if (typeof parsed.name === 'string' && parsed.name.startsWith('@deepseek-ai/')) {
            packages.set(parsed.name, { dir: target, manifest: parsed });
          }
        } catch (_) { /* non-package directory is not an installation candidate */ }
      }
      visit(target);
    }
  }
  for (const relative of roots) {
    const directory = path.join(SOURCE_ROOT, relative);
    if (fs.existsSync(directory)) visit(directory);
  }
  return packages;
}

function packageName(specifier) {
  if (!specifier || specifier.startsWith('.') || specifier.startsWith('#') || specifier.startsWith('node:')) return '';
  if (specifier.startsWith('@')) return specifier.split('/').slice(0, 2).join('/');
  return specifier.split('/')[0];
}

function sourceFiles(directory) {
  const files = [];
  if (!fs.existsSync(directory)) return files;
  function visit(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.isDirectory() && SOURCE_SKIP.has(entry.name)) continue;
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) visit(target);
      else if (/\.(?:[cm]?js|[cm]?ts)$/i.test(entry.name)) files.push(target);
    }
  }
  visit(directory);
  return files;
}

function importedSpecifiers(files, ts) {
  const found = new Set();
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    const kind = /\.m?[jt]sx?$/i.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
    const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind);
    function visit(node) {
      if (ts.isImportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
        const clause = node.importClause;
        const bindings = clause && clause.namedBindings && ts.isNamedImports(clause.namedBindings)
          ? clause.namedBindings.elements
          : [];
        const typeOnly = !!clause && (clause.isTypeOnly
          || (!clause.name && bindings.length > 0 && bindings.every(binding => binding.isTypeOnly)));
        if (!typeOnly) found.add(node.moduleSpecifier.text);
      } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
        if (!node.isTypeOnly) found.add(node.moduleSpecifier.text);
      } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
        && node.arguments.length === 1 && ts.isStringLiteralLike(node.arguments[0])) {
        found.add(node.arguments[0].text);
      } else if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'require'
        && node.arguments.length === 1 && ts.isStringLiteralLike(node.arguments[0])) {
        found.add(node.arguments[0].text);
      }
      ts.forEachChild(node, visit);
    }
    visit(parsed);
  }
  return [...found];
}

function resolveExternalPackage(name, importerDirectory) {
  const requireFromImporter = createRequire(path.join(importerDirectory, 'package.json'));
  let entry = null;
  try { entry = requireFromImporter.resolve(name); }
  catch (_) { /* some ESM-only packages intentionally expose no CommonJS main */ }
  if (!entry) {
    for (const lookupPath of requireFromImporter.resolve.paths(name) || []) {
      const candidate = path.join(lookupPath, ...name.split('/'));
      if (fs.existsSync(path.join(candidate, 'package.json'))) {
        entry = path.join(candidate, 'package.json');
        break;
      }
    }
  }
  if (!entry) throw new Error(`runtime dependency ${name} is unavailable from ${importerDirectory}`);
  let directory = path.dirname(entry);
  while (directory !== path.dirname(directory)) {
    const manifestFile = path.join(directory, 'package.json');
    if (fs.existsSync(manifestFile)) {
      try {
        const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
        if (manifest.name === name) return { dir: fs.realpathSync(directory), manifest };
      } catch (_) { /* continue to the owning package */ }
    }
    directory = path.dirname(directory);
  }
  throw new Error(`could not find package root for ${name}, resolved ${entry}`);
}

function outputPackagePath(name, parent) {
  const segments = name.split('/');
  return path.join(parent, ...segments);
}

function shouldCopyOptional(name) {
  const tagged = PLATFORM_TOKENS.some(token => name.toLowerCase().includes(token));
  if (!tagged) return true;
  const normalized = name.toLowerCase();
  return normalized.includes('win32') && normalized.includes('x64');
}

function resolveOptionalFromPnpmStore(name, version) {
  const store = path.join(SOURCE_ROOT, 'node_modules', '.pnpm');
  if (!fs.existsSync(store)) return null;
  const folderPrefix = name.replace('/', '+') + '@' + String(version || '');
  for (const entry of fs.readdirSync(store)) {
    if (entry !== folderPrefix && !entry.startsWith(folderPrefix + '_') && !entry.startsWith(folderPrefix + '(')) continue;
    const candidate = path.join(store, entry, 'node_modules', ...name.split('/'));
    const manifest = readManifest(candidate);
    if (manifest && manifest.name === name && String(manifest.version) === String(version)) {
      return { dir: candidate, manifest: manifest };
    }
  }
  return null;
}

function copyTree(source, destination, omitBuildDirs, preserveRuntimeLibs) {
  fs.mkdirSync(destination, { recursive: true });
  const filter = candidate => {
    const relative = path.relative(source, candidate);
    if (!relative) return true;
    const segments = relative.split(path.sep);
    if (segments.some(segment => segment === 'node_modules' || segment === '.git')) return false;
    if (omitBuildDirs && segments.some(segment => ['.turbo', 'coverage', 'dist', 'test', 'tests', '__tests__', 'docs', 'examples'].includes(segment)
      || (!preserveRuntimeLibs && segment === 'lib'))) return false;
    if (omitBuildDirs && /\.(?:tsbuildinfo|map)$/i.test(path.basename(candidate))) return false;
    return true;
  };
  fs.cpSync(source, destination, { recursive: true, dereference: true, filter: filter });
}

function copyWebFrontendDist() {
  const source = path.join(SOURCE_ROOT, 'apps', 'web', 'dist');
  const destination = path.join(OUTPUT_ROOT, 'node_modules', '@deepseek-ai', 'dsh-web-frontend', 'dist');
  const packageManifest = path.join(OUTPUT_ROOT, 'node_modules', '@deepseek-ai', 'dsh-web-frontend', 'package.json');
  const index = path.join(source, 'index.html');
  if (!fs.existsSync(index)) {
    throw new Error('pinned DSH Web frontend is not built; build apps/web for the pinned source before building the runtime');
  }
  if (!fs.existsSync(packageManifest)) {
    throw new Error('the pinned DSH runtime does not contain @deepseek-ai/dsh-web-frontend');
  }
  fs.mkdirSync(destination, { recursive: true });
  fs.cpSync(source, destination, { recursive: true, filter: candidate => {
    const relative = path.relative(source, candidate).split(path.sep).join('/');
    return !relative.split('/').some(segment => segment === 'preview')
      && relative !== 'preview.html';
  }});
  const files = [];
  function collect(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) collect(target);
      else if (entry.isFile()) files.push(target);
    }
  }
  collect(destination);
  const indexBytes = fs.readFileSync(path.join(destination, 'index.html'));
  return {
    sourceRevision: REVISION,
    runtimePath: path.relative(OUTPUT_ROOT, destination).split(path.sep).join('/'),
    artifactFiles: files.length,
    artifactBytes: files.reduce((total, file) => total + fs.statSync(file).size, 0),
    indexSha256: createHash('sha256').update(indexBytes).digest('hex')
  };
}

function readManifest(directory) {
  try { return JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8')); }
  catch (_) { return null; }
}

function installLocalCompatibilityPackage(name) {
  const replacement = LOCAL_PACKAGE_OVERRIDES[name];
  if (!replacement) return false;
  const source = replacement.sourceDirectory;
  const manifest = readManifest(source);
  if (!manifest || manifest.name !== name || manifest.version !== replacement.version || manifest.license !== 'MIT') {
    throw new Error(`invalid InternalBeyond compatibility package for ${name}`);
  }
  const destination = outputPackagePath(name, path.join(OUTPUT_ROOT, 'node_modules'));
  const existing = readManifest(destination);
  if (!existing) copyTree(source, destination, false);
  else if (existing.version !== replacement.version || existing.internalbeyond?.replaces !== replacement.replaces) {
    throw new Error(`runtime dependency collision for local compatibility package ${name}`);
  }
  compatibilityRecords.set(name, {
    name: name,
    version: manifest.version,
    license: manifest.license,
    replaces: replacement.replaces,
    runtimePath: path.relative(OUTPUT_ROOT, destination).split(path.sep).join('/'),
    implementation: 'InternalBeyond self-authored Node.js Buffer compatibility module'
  });
  return true;
}

function applyLocalDependencyOverrides(name, destination) {
  const manifestFile = path.join(destination, 'package.json');
  const manifest = readManifest(destination);
  if (!manifest) return;
  const applied = [];
  for (const section of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    const dependencies = manifest[section];
    if (!dependencies || typeof dependencies !== 'object') continue;
    for (const [dependency, replacement] of Object.entries(LOCAL_PACKAGE_OVERRIDES)) {
      if (!Object.prototype.hasOwnProperty.call(dependencies, dependency)) continue;
      const requested = dependencies[dependency];
      dependencies[dependency] = replacement.version;
      applied.push({ dependency, section, requested, replacement: replacement.version });
    }
  }
  if (applied.length) {
    fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + '\n');
    compatibilityOverridesApplied.set(name, applied);
  }
}

function packageLicense(manifest) {
  if (typeof manifest.license === 'string' && manifest.license.trim()) return manifest.license.trim();
  const legacy = Array.isArray(manifest.licenses)
    ? [...new Set(manifest.licenses.map(item => typeof item === 'string' ? item : item && item.type).filter(value => typeof value === 'string' && value.trim()))]
    : [];
  return legacy.length ? legacy.join(' OR ') : null;
}

function pathIsWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
}

function rewriteRuntimeTarget(target, packageDirectory) {
  if (typeof target !== 'string' || !target.startsWith('./lib/')) return target;
  if (target.includes('*')) return target.replace(/^\.\/lib\//, './src/');
  const candidates = [];
  const relative = target.slice('./lib/'.length).replace(/\.(?:c|m)?js$/, '.ts');
  if (relative.startsWith('types/')) {
    candidates.push(path.join(packageDirectory, 'src', relative.slice('types/'.length)));
  }
  candidates.push(path.join(packageDirectory, 'src', relative));
  const found = candidates.find(candidate => fs.existsSync(candidate));
  return found ? './' + path.relative(packageDirectory, found).split(path.sep).join('/') : target;
}

function rewriteRuntimeManifest(packageDirectory) {
  const manifestFile = path.join(packageDirectory, 'package.json');
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  const sourceEntry = path.join(packageDirectory, 'src', 'index.ts');
  if (fs.existsSync(sourceEntry)) {
    manifest.main = './src/index.ts';
    if (manifest.exports && typeof manifest.exports === 'object') {
      const rootExport = manifest.exports['.'];
      if (typeof rootExport === 'string') {
        manifest.exports['.'] = rewriteRuntimeTarget(rootExport, packageDirectory);
      } else if (rootExport && typeof rootExport === 'object') {
        for (const condition of ['default', 'import', 'node', 'require']) {
          if (typeof rootExport[condition] === 'string') {
            rootExport[condition] = rewriteRuntimeTarget(rootExport[condition], packageDirectory);
          }
        }
      }
    }
  }
  if (manifest.exports && typeof manifest.exports === 'object') {
    for (const [key, value] of Object.entries(manifest.exports)) {
      if (key === '.') continue;
      if (typeof value === 'string') manifest.exports[key] = rewriteRuntimeTarget(value, packageDirectory);
      else if (value && typeof value === 'object') {
        for (const condition of ['default', 'import', 'node', 'require']) {
          if (typeof value[condition] === 'string') {
            value[condition] = rewriteRuntimeTarget(value[condition], packageDirectory);
          }
        }
      }
    }
  }
  fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + '\n');
}

function assertRuntimeSubpathExports(packageName, packageDirectory) {
  const manifest = readManifest(packageDirectory);
  const exportsMap = manifest && manifest.exports;
  if (!exportsMap || typeof exportsMap !== 'object') return;
  for (const subpath of ['./typert', './client']) {
    const entry = exportsMap[subpath];
    if (!entry) continue;
    const target = typeof entry === 'string' ? entry
      : (entry.node || entry.import || entry.default || entry.require);
    if (typeof target !== 'string' || !target.startsWith('./') || target.includes('*')
      || !/\.(?:c|m)?js$/i.test(target)) continue;
    const resolved = path.resolve(packageDirectory, target);
    if (!pathIsWithin(packageDirectory, resolved) || !fs.existsSync(resolved)) {
      throw new Error(`missing DSH runtime ${subpath} export for ${packageName}: ${target}`);
    }
  }
}

function patchTauriEmbeddedCookiePolicy(packageName, packageDirectory) {
  if (packageName !== '@deepseek-ai/dsh-client-connection') return;
  const relativePath = 'src/browser-auth.ts';
  const sourcePath = path.join(packageDirectory, relativePath);
  let source = fs.readFileSync(sourcePath, 'utf8');
  const sameSiteAnchor = '; HttpOnly; SameSite=Strict`';
  const returnAnchor = '  return secure ? `${attributes}; Secure` : attributes';
  if ((source.match(/; HttpOnly; SameSite=Strict`/g) || []).length !== 1
    || (source.match(/  return secure \? `\$\{attributes\}; Secure` : attributes/g) || []).length !== 1) {
    throw new Error('pinned DSH BrowserAuth cookie policy changed; embedded Tauri patch refused');
  }
  source = source.replace(sameSiteAnchor,
    "; HttpOnly; SameSite=${process.env.IB_DSH_EMBEDDED_TAURI === '1' ? 'None' : 'Strict'}`");
  source = source.replace(returnAnchor,
    "  return (secure || process.env.IB_DSH_EMBEDDED_TAURI === '1') ? `${attributes}; Secure` : attributes");
  fs.writeFileSync(sourcePath, source, 'utf8');
  runtimeProductionPatches.push({
    packageName: packageName,
    path: relativePath,
    mode: 'IB_DSH_EMBEDDED_TAURI=1 uses SameSite=None; Secure for the authenticated Tauri iframe',
    upstreamRevision: REVISION
  });
}

function patchTauriEmbeddedWorkspaceScope(packageName, packageDirectory) {
  if (packageName !== '@deepseek-ai/dsh-api-workspace-controller') return;
  const relativePath = 'src/commands.ts';
  const sourcePath = path.join(packageDirectory, relativePath);
  let source = fs.readFileSync(sourcePath, 'utf8');
  const importAnchor = "import type { Context } from '@deepseek-ai/cordis'\n";
  const createAnchor = '  create(request: WorkspaceCreateRequest): Promise<WorkspaceCreateValue> {\n'
    + '    return this.enqueue(async () => {\n      try {\n';
  if ((source.match(/import type \{ Context \} from '@deepseek-ai\/cordis'/g) || []).length !== 1
    || (source.match(/  create\(request: WorkspaceCreateRequest\): Promise<WorkspaceCreateValue> \{\n    return this\.enqueue\(async \(\) => \{\n      try \{/g) || []).length !== 1) {
    throw new Error('pinned DSH WorkspaceController changed; private Work Mode scope patch refused');
  }
  source = source.replace(importAnchor,
    "import path from 'node:path'\nimport { realpath } from 'node:fs/promises'\n" + importAnchor);
  source = source.replace(createAnchor,
    '  create(request: WorkspaceCreateRequest): Promise<WorkspaceCreateValue> {\n'
    + '    return this.enqueue(async () => {\n'
    + "      if (process.env.IB_DSH_EMBEDDED_TAURI === '1') {\n"
    + "        const configuredRoot = String(process.env.IB_DSH_WORKSPACE_ROOT || '')\n"
    + "        if (!configuredRoot) throw new RemoteError('workspace/private-root-required',\n"
    + "          'Workspace registration requires the private Work Mode root', {})\n"
    + '        const requestedPath = String(request && request.path || \'\')\n'
    + '        const lexicalRoot = path.resolve(configuredRoot)\n'
    + '        const lexicalPath = path.resolve(requestedPath)\n'
    + '        const lexicalRelative = path.relative(lexicalRoot, lexicalPath)\n'
    + "        if (lexicalRelative === '..' || lexicalRelative.startsWith('..' + path.sep) || path.isAbsolute(lexicalRelative)) {\n"
    + "          throw new RemoteError('workspace/path-outside-private-work-mode',\n"
    + "            'Workspace must remain inside the private Work Mode root', {})\n"
    + '        }\n'
    + '        const [canonicalRoot, canonicalPath] = await Promise.all([realpath(lexicalRoot), realpath(lexicalPath)])\n'
    + '        const canonicalRelative = path.relative(canonicalRoot, canonicalPath)\n'
    + "        if (canonicalRelative === '..' || canonicalRelative.startsWith('..' + path.sep) || path.isAbsolute(canonicalRelative)) {\n"
    + "          throw new RemoteError('workspace/path-outside-private-work-mode',\n"
    + "            'Workspace must remain inside the private Work Mode root', {})\n"
    + '        }\n'
    + '      }\n'
    + '      try {\n');
  fs.writeFileSync(sourcePath, source, 'utf8');
  runtimeProductionPatches.push({
    packageName: packageName,
    path: relativePath,
    mode: 'IB_DSH_EMBEDDED_TAURI=1 permits Workspace registration only inside the private DSH Work Mode root',
    upstreamRevision: REVISION
  });
}

function runtimeAliasTarget(target, packageMap, selected) {
  if (typeof target !== 'string' || !target.startsWith('./')) return null;
  const slashTarget = target.replace(/\\/g, '/');
  const wildcard = slashTarget.indexOf('*');
  const sourcePrefix = wildcard < 0 ? slashTarget : slashTarget.slice(0, wildcard);
  const suffix = wildcard < 0 ? '' : slashTarget.slice(wildcard);
  const absolutePrefix = path.resolve(SOURCE_ROOT, sourcePrefix);
  const owners = [...selected].map(name => ({ name, entry: packageMap.get(name) }))
    .filter(item => item.entry && pathIsWithin(item.entry.dir, absolutePrefix))
    .sort((left, right) => right.entry.dir.length - left.entry.dir.length);
  if (owners.length) {
    const owner = owners[0];
    const relative = path.relative(owner.entry.dir, absolutePrefix).split(path.sep).join('/');
    const prefix = path.posix.join('./node_modules', owner.name, relative);
    const mapped = (prefix.endsWith('/') || !relative ? prefix : prefix + (wildcard < 0 ? '' : '/')) + suffix;
    const outputCandidate = path.resolve(OUTPUT_ROOT, mapped.replace(/^\.\//, '').replace(/\*.*$/, ''));
    if (wildcard >= 0 ? fs.existsSync(outputCandidate) : fs.existsSync(outputCandidate)) return mapped;
  }
  const cliSource = path.join(SOURCE_ROOT, 'apps', 'cli');
  if (pathIsWithin(cliSource, absolutePrefix)) {
    const relative = path.relative(cliSource, absolutePrefix).split(path.sep).join('/');
    const mapped = './apps/cli' + (relative ? '/' + relative : '') + suffix;
    const outputCandidate = path.resolve(OUTPUT_ROOT, mapped.replace(/^\.\//, '').replace(/\*.*$/, ''));
    if (fs.existsSync(outputCandidate)) return mapped;
  }
  return null;
}

function writeRuntimeTsconfig(ts, packageMap, selected) {
  const baseFile = path.join(SOURCE_ROOT, 'tsconfig.base.json');
  const parsed = ts.parseConfigFileTextToJson(baseFile, fs.readFileSync(baseFile, 'utf8'));
  if (parsed.error) throw new Error('could not parse DSH TypeScript aliases');
  const sourcePaths = parsed.config.compilerOptions && parsed.config.compilerOptions.paths || {};
  const paths = {};
  for (const [key, targets] of Object.entries(sourcePaths)) {
    const mapped = targets.map(target => runtimeAliasTarget(target, packageMap, selected)).filter(Boolean);
    if (mapped.length) paths[key] = mapped;
  }
  const config = {
    compilerOptions: {
      target: 'es2024',
      module: 'nodenext',
      moduleResolution: 'nodenext',
      baseUrl: '.',
      allowImportingTsExtensions: true,
      esModuleInterop: true,
      paths: paths
    },
    files: []
  };
  fs.writeFileSync(path.join(OUTPUT_ROOT, 'tsconfig.json'), JSON.stringify(config, null, 2) + '\n');
}

function copyExternalPackage(name, importerSource, importerOutput) {
  if (installLocalCompatibilityPackage(name)) return;
  const resolved = resolveExternalPackage(name, importerSource);
  const source = resolved.dir;
  const manifest = resolved.manifest;
  const versionKey = name + '@' + String(manifest.version || '');
  const rootDestination = outputPackagePath(name, path.join(OUTPUT_ROOT, 'node_modules'));
  let destination = rootDestination;
  const installedRoot = readManifest(rootDestination);
  if (installedRoot && installedRoot.version !== manifest.version) {
    destination = outputPackagePath(name, path.join(importerOutput, 'node_modules'));
  }
  const existing = readManifest(destination);
  if (!existing) copyTree(source, destination, false);
  else if (existing.version !== manifest.version) {
    throw new Error(`runtime dependency collision for ${name}: ${String(existing.version)} and ${String(manifest.version)}`);
  }
  applyLocalDependencyOverrides(name, destination);
  externalInstalled.set(versionKey, destination);
  externalRecords.set(versionKey, {
    name: name,
    version: String(manifest.version || ''),
    license: packageLicense(manifest),
    runtimePath: path.relative(OUTPUT_ROOT, destination).split(path.sep).join('/')
  });

  const visitKey = source + '=>' + destination;
  if (externalVisited.has(visitKey)) return;
  externalVisited.add(visitKey);
  for (const dependency of Object.keys(manifest.dependencies || {})) {
    if (BUILTIN_MODULES.has(dependency)) continue;
    copyExternalPackage(dependency, source, destination);
  }
  for (const dependency of Object.keys(manifest.optionalDependencies || {})) {
    if (BUILTIN_MODULES.has(dependency)) continue;
    if (!shouldCopyOptional(dependency)) continue;
    try { copyExternalPackage(dependency, source, destination); }
    catch (_) {
      const optional = resolveOptionalFromPnpmStore(dependency, manifest.optionalDependencies[dependency]);
      if (optional) copyExternalPackageFromResolved(dependency, optional, destination);
      else if (dependency.includes('win32-x64') || dependency === '@esbuild/win32-x64') {
        throw new Error(`required Windows x64 optional dependency ${dependency}@${manifest.optionalDependencies[dependency]} is unavailable`);
      }
      /* optional packages not installed for this build host are not runtime dependencies */
    }
  }
}

function copyExternalPackageFromResolved(name, resolved, importerOutput) {
  if (installLocalCompatibilityPackage(name)) return;
  const source = resolved.dir;
  const manifest = resolved.manifest;
  const versionKey = name + '@' + String(manifest.version || '');
  const rootDestination = outputPackagePath(name, path.join(OUTPUT_ROOT, 'node_modules'));
  let destination = rootDestination;
  const installedRoot = readManifest(rootDestination);
  if (installedRoot && installedRoot.version !== manifest.version) {
    destination = outputPackagePath(name, path.join(importerOutput, 'node_modules'));
  }
  const existing = readManifest(destination);
  if (!existing) copyTree(source, destination, false);
  else if (existing.version !== manifest.version) {
    throw new Error(`runtime dependency collision for ${name}: ${String(existing.version)} and ${String(manifest.version)}`);
  }
  applyLocalDependencyOverrides(name, destination);
  externalInstalled.set(versionKey, destination);
  externalRecords.set(versionKey, {
    name: name,
    version: String(manifest.version || ''),
    license: packageLicense(manifest),
    runtimePath: path.relative(OUTPUT_ROOT, destination).split(path.sep).join('/')
  });
  const visitKey = source + '=>' + destination;
  if (externalVisited.has(visitKey)) return;
  externalVisited.add(visitKey);
  for (const dependency of Object.keys(manifest.dependencies || {})) {
    if (BUILTIN_MODULES.has(dependency)) continue;
    copyExternalPackage(dependency, source, destination);
  }
  for (const dependency of Object.keys(manifest.optionalDependencies || {})) {
    if (BUILTIN_MODULES.has(dependency)) continue;
    if (!shouldCopyOptional(dependency)) continue;
    try { copyExternalPackage(dependency, source, destination); }
    catch (_) {
      const optional = resolveOptionalFromPnpmStore(dependency, manifest.optionalDependencies[dependency]);
      if (optional) copyExternalPackageFromResolved(dependency, optional, destination);
      else if (dependency.includes('win32-x64') || dependency === '@esbuild/win32-x64') {
        throw new Error(`required Windows x64 optional dependency ${dependency}@${manifest.optionalDependencies[dependency]} is unavailable`);
      }
    }
  }
}

function build() {
  if (process.platform !== 'win32' || process.arch !== 'x64') {
    throw new Error('DSH Dev Runtime distribution currently targets Windows x64 only');
  }
  if (fs.existsSync(OUTPUT_ROOT)) {
    if (!REPLACE_OUTPUT) throw new Error(`refusing to overwrite existing DSH runtime at ${OUTPUT_ROOT}; pass --replace for a verified pinned runtime`);
    let current = null;
    try { current = JSON.parse(fs.readFileSync(path.join(OUTPUT_ROOT, 'runtime-manifest.json'), 'utf8')); }
    catch (_) { current = null; }
    if (!current || current.schema !== 'internalbeyond.dsh-runtime' || current.sourceRevision !== REVISION) {
      throw new Error(`refusing to replace unowned or differently pinned DSH runtime at ${OUTPUT_ROOT}`);
    }
    const resolved = path.resolve(OUTPUT_ROOT);
    if (path.dirname(resolved) !== path.resolve(ROOT, 'runtime') || path.basename(resolved) !== 'dsh-runtime') {
      throw new Error('refusing to replace a DSH runtime outside the owned runtime directory');
    }
    fs.rmSync(resolved, { recursive: true, force: false });
  }
  assertPinnedSource();
  const sourceRequire = createRequire(path.join(SOURCE_ROOT, 'package.json'));
  const ts = require(sourceRequire.resolve('typescript'));
  const cliSource = path.join(SOURCE_ROOT, 'apps', 'cli');
  const cliManifest = JSON.parse(fs.readFileSync(path.join(cliSource, 'package.json'), 'utf8'));
  const packageMap = workspacePackageMap();
  const selected = new Set();
  const directDependencies = [...new Set([
    ...Object.keys(cliManifest.dependencies || {}),
    ...Object.keys(cliManifest.peerDependencies || {}),
    ...REQUIRED_PROFILE_PACKAGES
  ])];
  const externalEdges = [];
  const queue = directDependencies.filter(name => {
    if (packageMap.has(name)) return true;
    externalEdges.push({ name: name, importerDirectory: cliSource });
    return false;
  });

  function addSpecifier(specifier, importerDirectory) {
    const name = packageName(specifier);
    if (!name || require('node:module').builtinModules.includes(name)) return;
    if (packageMap.has(name)) {
      if (!selected.has(name)) { selected.add(name); queue.push(name); }
      return;
    }
    externalEdges.push({ name, importerDirectory });
  }

  for (const file of CLI_SOURCE_FILES) {
    const full = path.join(SOURCE_ROOT, 'apps', 'cli', 'src', file);
    if (!fs.existsSync(full)) throw new Error(`missing DSH CLI source ${full}`);
    for (const specifier of importedSpecifiers([full], ts)) addSpecifier(specifier, path.join(SOURCE_ROOT, 'apps', 'cli'));
  }
  for (const name of REQUIRED_PROFILE_PACKAGES) {
    if (!packageMap.has(name)) throw new Error(`missing required DSH workspace package ${name}`);
  }

  while (queue.length) {
    const name = queue.shift();
    selected.add(name);
    const entry = packageMap.get(name);
    if (!entry) continue;
    const directory = entry.dir;
    const manifest = entry.manifest;
    for (const dependency of Object.keys(manifest.dependencies || {}).concat(Object.keys(manifest.peerDependencies || {}))) {
      if (BUILTIN_MODULES.has(dependency)) continue;
      if (packageMap.has(dependency)) {
        if (!selected.has(dependency)) { selected.add(dependency); queue.push(dependency); }
      } else externalEdges.push({ name: dependency, importerDirectory: directory });
    }
    for (const specifier of importedSpecifiers(sourceFiles(path.join(directory, 'src')), ts)) addSpecifier(specifier, directory);
  }

  externalEdges.push({ name: 'tsx', importerDirectory: cliSource });
  for (const specifier of importedSpecifiers(CLI_SOURCE_FILES.map(file => path.join(cliSource, 'src', file)), ts)) {
    addSpecifier(specifier, cliSource);
  }
  for (const file of ['ib-work-mode-host.ts', 'memory-session-persistence.ts']) {
    const source = path.join(ADAPTER_SOURCE_ROOT, file);
    for (const specifier of importedSpecifiers([source], ts)) addSpecifier(specifier, ADAPTER_SOURCE_ROOT);
  }
  fs.mkdirSync(OUTPUT_ROOT, { recursive: true });
  let complete = false;
  try {
    for (const name of [...selected].sort()) {
      const entry = packageMap.get(name);
      if (!entry) throw new Error(`workspace package ${name} was selected but not found`);
      const destination = outputPackagePath(name, path.join(OUTPUT_ROOT, 'node_modules'));
      /* The production CLI's Typert loader and browser module registry resolve
         these declared subpath exports at runtime. Keep the pinned, generated
         lib artifacts alongside TS sources; source rewrites remain preferred
         where a concrete source counterpart exists. */
      copyTree(entry.dir, destination, true, true);
      rewriteRuntimeManifest(destination);
      patchTauriEmbeddedCookiePolicy(name, destination);
      patchTauriEmbeddedWorkspaceScope(name, destination);
      assertRuntimeSubpathExports(name, destination);
    }

    copyTree(cliSource, path.join(OUTPUT_ROOT, 'apps', 'cli'), true);
    copyTree(ADAPTER_SOURCE_ROOT, path.join(OUTPUT_ROOT, 'config'), true);
    writeRuntimeTsconfig(ts, packageMap, selected);
    fs.writeFileSync(path.join(OUTPUT_ROOT, 'package.json'), JSON.stringify({
      name: '@internalbeyond/dsh-runtime',
      version: VERSION,
      private: true,
      type: 'module'
    }, null, 2) + '\n');
    fs.copyFileSync(path.join(SOURCE_ROOT, 'LICENSE'), path.join(OUTPUT_ROOT, 'LICENSE'));
    fs.copyFileSync(path.join(SOURCE_ROOT, 'THIRD_PARTY_NOTICES.md'), path.join(OUTPUT_ROOT, 'THIRD_PARTY_NOTICES.md'));

    for (const edge of externalEdges) copyExternalPackage(edge.name, edge.importerDirectory, path.join(OUTPUT_ROOT, 'node_modules'));

    const webFrontend = copyWebFrontendDist();

    if (!compatibilityRecords.has('buffers')) throw new Error('the pinned binary dependency did not resolve to the local buffers compatibility package');
    const binaryOverrides = compatibilityOverridesApplied.get('binary') || [];
    if (!binaryOverrides.some(item => item.dependency === 'buffers' && item.requested === '~0.1.1')) {
      throw new Error('binary@0.3.0 no longer declares the expected buffers@~0.1.1 compatibility edge');
    }

    const workspaceRecords = [...selected].sort().map(name => ({
      name: name,
      version: String(packageMap.get(name).manifest.version || ''),
      license: packageLicense(packageMap.get(name).manifest),
      runtimePath: path.relative(OUTPUT_ROOT, outputPackagePath(name, path.join(OUTPUT_ROOT, 'node_modules'))).split(path.sep).join('/')
    }));
    const runtimeManifest = {
      schema: 'internalbeyond.dsh-runtime',
      runtimeVersion: VERSION,
      sourceRepository: 'https://github.com/deepseek-ai/deepseek-harness',
      sourceRevision: REVISION,
      nodeEngine: '^22.19.0 || >=24.0.0',
      protocolVersion: 1,
      target: 'windows-x64',
      entry: 'apps/cli/src/bin.ts',
      profile: 'acp',
      config: 'config/cordis.yml',
      license: 'MIT',
      webFrontend: webFrontend,
      productionExcludes: DSH_RUNTIME_EXCLUDES,
      workspacePackages: workspaceRecords,
      externalPackages: [...externalRecords.values()].sort((left, right) => left.name.localeCompare(right.name)),
      compatibilityPackages: [...compatibilityRecords.values()].sort((left, right) => left.name.localeCompare(right.name)),
      compatibilityOverrides: [...compatibilityOverridesApplied.entries()].flatMap(([consumer, overrides]) => overrides.map(item => ({ consumer, ...item }))),
      productionPatches: runtimeProductionPatches,
      artifactBytes: 0,
      artifactFiles: 0,
      productionArtifactBytes: 0,
      productionArtifactFiles: 0
    };
    const directLicenseManifest = {
      sourceRevision: REVISION,
      license: 'MIT',
      workspacePackages: workspaceRecords,
      externalPackages: runtimeManifest.externalPackages,
      compatibilityPackages: runtimeManifest.compatibilityPackages,
      compatibilityOverrides: runtimeManifest.compatibilityOverrides,
      productionPatches: runtimeProductionPatches
    };
    fs.writeFileSync(path.join(OUTPUT_ROOT, 'THIRD_PARTY_RUNTIME.json'), JSON.stringify(directLicenseManifest, null, 2) + '\n');
    function measureArtifact(excludePatterns) {
      let fileCount = 0;
      let totalBytes = 0;
      function countFiles(directory) {
        for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
          const target = path.join(directory, item.name);
          if (item.isDirectory()) countFiles(target);
          else {
            const relative = path.relative(OUTPUT_ROOT, target).split(path.sep).join('/');
            if (excludePatterns && excludePatterns.some(pattern => pattern.test(relative))) continue;
            fileCount += 1;
            totalBytes += fs.statSync(target).size;
          }
        }
      }
      countFiles(OUTPUT_ROOT);
      return { files: fileCount, bytes: totalBytes };
    }
    let artifact = null;
    for (let pass = 0; pass < 5; pass++) {
      fs.writeFileSync(path.join(OUTPUT_ROOT, 'runtime-manifest.json'), JSON.stringify(runtimeManifest, null, 2) + '\n');
      const measured = measureArtifact();
      const production = measureArtifact(DSH_RUNTIME_EXCLUDE_REGEXES);
      if (measured.bytes === runtimeManifest.artifactBytes && measured.files === runtimeManifest.artifactFiles
        && production.bytes === runtimeManifest.productionArtifactBytes
        && production.files === runtimeManifest.productionArtifactFiles) {
        artifact = measured;
        break;
      }
      runtimeManifest.artifactBytes = measured.bytes;
      runtimeManifest.artifactFiles = measured.files;
      runtimeManifest.productionArtifactBytes = production.bytes;
      runtimeManifest.productionArtifactFiles = production.files;
    }
    if (!artifact) throw new Error('runtime artifact size metadata did not converge');
    complete = true;
    console.log(`Built DSH ${VERSION} (${REVISION}): ${artifact.files} files, ${artifact.bytes} bytes (${(artifact.bytes / 1048576).toFixed(2)} MiB)`);
    console.log(`Workspace modules: ${workspaceRecords.length}; external modules: ${runtimeManifest.externalPackages.length}`);
  } finally {
    if (!complete) {
      const resolved = path.resolve(OUTPUT_ROOT);
      if (path.dirname(resolved) === path.resolve(ROOT, 'runtime') && path.basename(resolved) === 'dsh-runtime') {
        fs.rmSync(resolved, { recursive: true, force: true });
      }
    }
  }
}

try { build(); }
catch (error) {
  console.error('build-dsh-runtime: ' + String(error && error.stack || error));
  process.exitCode = 1;
}
