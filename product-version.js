'use strict';

/*
 * Internal Beyond · single release version source (P7).
 *
 * The product version lives in exactly ONE file: ./VERSION (repo root, and the
 * same file at the installed app root). Every other consumer derives from it:
 *
 *   installer/InternalBeyond.iss    → AppVersion / OutputBaseFilename / 卸载项
 *   scripts/build-installer.ps1     → InternalBeyond-Setup-<version>.exe
 *   launch-internal-beyond.js       → boot-state launcher.product.version
 *   internal-beyond-server.js       → GET /health .version
 *   assets/js/guide-beginner.js     → 指南版本标识（同源读取 VERSION）
 *   assets/js/diagnostics.js        → 诊断页「版本」与导出报告
 *
 * Never hand-write a version literal anywhere else: read it through this module
 * on the Node side, or through the VERSION file on the browser side.
 *
 * Zero dependencies; usable from the launcher, the static server, build
 * scripts and tests without changing anything about how they run.
 */

const fs = require('fs');
const path = require('path');

/* Repo root == app root in the installed layout, so a sibling VERSION file is
   always the right one (no cwd assumptions, no env lookups). */
const FILE = path.join(__dirname, 'VERSION');
const SEMVER_RE = /^\d+\.\d+\.\d+$/;
const FALLBACK = '0.0.0';

/* Parse "MAJOR.MINOR.PATCH" (whitespace tolerated). Returns null when invalid —
   callers must decide whether that is fatal (installer) or degrading (UI). */
function parse(text) {
  const raw = String(text == null ? '' : text).trim();
  if (!SEMVER_RE.test(raw)) return null;
  const parts = raw.split('.').map(function (n) { return Number(n); });
  return {
    version: raw,
    major: parts[0],
    minor: parts[1],
    patch: parts[2],
    /* Guide content version tracks MAJOR.MINOR, so the tutorial version and the
       product version can never drift into unrelated schemes. */
    guide: parts[0] + '.' + parts[1]
  };
}

function read(opts) {
  const o = opts || {};
  const file = o.file ? path.resolve(String(o.file)) : FILE;
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    return {
      ok: false, version: FALLBACK, guide: '0.0', source: 'fallback',
      error: 'VERSION unreadable (' + String((e && e.code) || (e && e.message) || e) + ')',
      path: file
    };
  }
  const parsed = parse(text);
  if (!parsed) {
    return {
      ok: false, version: FALLBACK, guide: '0.0', source: 'fallback',
      error: 'VERSION is not MAJOR.MINOR.PATCH: ' + JSON.stringify(text.trim().slice(0, 40)),
      path: file
    };
  }
  return {
    ok: true,
    version: parsed.version,
    major: parsed.major,
    minor: parsed.minor,
    patch: parsed.patch,
    guide: parsed.guide,
    source: 'VERSION',
    error: null,
    path: file
  };
}

/* Cached read for long-lived processes (server, launcher). Tests call reset(). */
let cached = null;
function get() {
  if (!cached) cached = read();
  return cached;
}
function reset() { cached = null; }

module.exports = {
  FILE: FILE,
  FALLBACK: FALLBACK,
  SEMVER_RE: SEMVER_RE,
  parse: parse,
  read: read,
  get: get,
  reset: reset
};
