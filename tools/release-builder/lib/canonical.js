'use strict';

/*
 * InternalBeyond Release Builder · canonical adapter
 *
 * THE ONLY FILE IN THIS TOOL THAT MAY REQUIRE A REPOSITORY SOURCE OF TRUTH.
 *
 * Everything the Release Builder knows about "what a release is" comes from
 * here, and everything here comes from the repository:
 *
 *   runtime/product-version.js   → the one version source + the one semver compare
 *   runtime/update-manifest.js   → the one manifest schema / URL constructor / validator
 *   runtime/pe-version.js        → the one PE version reader
 *   scripts/release-manifest.js  → the payload whitelist
 *   scripts/release-audit.js     → the content / secret / release-claim audit
 *   runtime/update-check.js      → the one update-check runtime (read-only reuse)
 *
 * There is deliberately NO second version source, NO second manifest builder,
 * NO second "four equations" definition, NO second semver compare and NO second
 * secret vocabulary in this tool. If you are about to add one, add it to the
 * repository module instead — the Release Builder is an orchestrator, not a
 * second release authority.
 *
 * `repo/open.js` proves the root really is an InternalBeyond checkout before
 * any module is loaded, so a wrong --root fails loudly instead of producing a
 * confident answer about the wrong tree.
 */

const fs = require('fs');
const path = require('path');

/* Files whose absence means "this is not an InternalBeyond release checkout".
   Kept deliberately short: every one of these is on the canonical path. */
const REQUIRED = [
  'VERSION',
  'installer/InternalBeyond.iss',
  'installer/runtime-pin.json',
  'runtime/product-version.js',
  'runtime/update-manifest.js',
  'runtime/pe-version.js',
  'scripts/build-installer.ps1',
  'scripts/release-manifest.js',
  'scripts/release-audit.js'
];

let active = null;

/*
 * Open a checkout. Returns a frozen adapter:
 *   { root, version, manifest, pe, whitelist, audit, updateCheck, productVersion,
 *     assetName(v), tagFor(v), urlFor(v), compare(a,b), parse(v),
 *     validate(obj), serialize(obj), resolveWhitelist(), readPeVersion(file) }
 *
 * Throws `NotAnInternalBeyondCheckout` with the list of missing files — a wrong
 * root must be a loud failure, never a confident answer about the wrong tree.
 */
function open(root) {
  const abs = path.resolve(String(root || ''));
  const missing = REQUIRED.filter(function (rel) {
    try { return !fs.statSync(path.join(abs, rel)).isFile(); } catch (e) { return true; }
  });
  if (missing.length) {
    const err = new Error('not an InternalBeyond checkout: ' + abs + ' (missing ' + missing.join(', ') + ')');
    err.code = 'NotAnInternalBeyondCheckout';
    err.missing = missing;
    err.root = abs;
    throw err;
  }

  /* Absolute require keeps this correct regardless of cwd. These are the
     repository's own modules, loaded in place — never copied into this tool. */
  const load = function (rel) { return require(path.join(abs, rel)); };

  const productVersion = load('runtime/product-version.js');
  const manifest = load('runtime/update-manifest.js');
  const pe = load('runtime/pe-version.js');
  const whitelist = load('scripts/release-manifest.js');
  const audit = load('scripts/release-audit.js');
  let updateCheck = null;
  let updateCheckError = null;
  try { updateCheck = load('runtime/update-check.js'); }
  catch (e) { updateCheckError = String((e && e.message) || e); }

  const adapter = {
    root: abs,

    /* The one version source. Read fresh every call: a version bump must be
       visible immediately, never served from a cache. */
    version: function version() { return productVersion.read(); },
    productVersion: productVersion,

    manifest: manifest,
    pe: pe,
    whitelist: whitelist,
    audit: audit,
    updateCheck: updateCheck,
    updateCheckError: updateCheckError,

    /* Thin passthroughs — so callers in this tool never reach for the spelling
       rules themselves. */
    assetName: function assetName(v) { return manifest.installerAssetName(v); },
    tagFor: function tagFor(v) { return manifest.tagFor(v); },
    urlFor: function urlFor(v) { return manifest.installerUrl(v); },
    compare: function compare(a, b) { return productVersion.compare(a, b); },
    parseVersion: function parseVersion(v) { return productVersion.parse(v); },
    validateManifest: function validateManifest(m) { return manifest.validate(m); },
    serializeManifest: function serializeManifest(m) { return manifest.serialize(m); },
    payloadManifestAsset: manifest.MANIFEST_ASSET,
    payloadFileCount: function payloadFileCount(opts) {
      const r = whitelist.resolve(opts || { root: abs });
      return { ok: r.ok, count: r.count, totalBytes: r.totalBytes, missing: r.missing, denied: r.denied };
    }
  };

  active = adapter;
  return Object.freeze(adapter);
}

/* The adapter opened by the server, for lib modules that need it without
   threading it through every call. `open()` sets it; tests set it explicitly. */
function current() { return active; }
function setCurrent(a) { active = a; return active; }

/*
 * Discover the checkout root.
 *
 * Order (deterministic, no guessing):
 *   1. an explicit root, if it IS a checkout
 *   2. --root=<path> in argv
 *   3. IB_RELEASE_ROOT
 *   4. walk up from __dirname: the tool normally lives at <repo>/tools/release-builder,
 *      but it must also work when the built EXE sits at <repo>/tools/
 *   5. walk up from cwd
 *
 * Returns { root, via } or { root:null, tried:[...] } — never a guess.
 */
function discover(startDir, explicit) {
  const tried = [];
  const isCheckout = function (dir) {
    if (!dir) return false;
    try {
      return REQUIRED.every(function (rel) { return fs.statSync(path.join(dir, rel)).isFile(); });
    } catch (e) { return false; }
  };
  const walkUp = function (dir, label) {
    let cur = path.resolve(String(dir || ''));
    for (let i = 0; i < 12; i++) {
      tried.push(label + ':' + cur);
      if (isCheckout(cur)) return cur;
      const parent = path.dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
    return null;
  };

  if (explicit) {
    tried.push('explicit:' + path.resolve(String(explicit)));
    if (isCheckout(path.resolve(String(explicit)))) return { root: path.resolve(String(explicit)), via: 'explicit' };
  }
  const argvRoot = (function () {
    const hit = (process.argv || []).find(function (a) { return a.indexOf('--root=') === 0; });
    return hit ? hit.slice('--root='.length) : '';
  })();
  if (argvRoot) {
    tried.push('argv:' + path.resolve(argvRoot));
    if (isCheckout(path.resolve(argvRoot))) return { root: path.resolve(argvRoot), via: 'argv' };
  }
  if (process.env.IB_RELEASE_ROOT) {
    tried.push('env:' + path.resolve(process.env.IB_RELEASE_ROOT));
    if (isCheckout(path.resolve(process.env.IB_RELEASE_ROOT))) {
      return { root: path.resolve(process.env.IB_RELEASE_ROOT), via: 'env' };
    }
  }
  const fromTool = walkUp(startDir || __dirname, 'tool');
  if (fromTool) return { root: fromTool, via: 'tool' };
  const fromCwd = walkUp(process.cwd(), 'cwd');
  if (fromCwd) return { root: fromCwd, via: 'cwd' };
  return { root: null, via: null, tried: tried };
}

module.exports = { open, current, setCurrent, discover, REQUIRED };
