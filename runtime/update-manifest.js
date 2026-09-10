'use strict';

/*
 * Internal Beyond · update manifest contract (U1)
 *
 * ONE definition of the release contract that the zero-touch updater reads.
 * The manifest itself is a GitHub Release asset named `update-stable.json`,
 * published LAST after the installer and its checksums (docs/RELEASE.md).
 *
 * Who uses this file:
 *   scripts/build-installer.ps1  → --write: assemble dist\update-stable.json
 *                                  from the bytes it just produced
 *   services/internal-beyond-server.js (U2) → validate / parseInstallerUrl
 *                                  on the fetched manifest (client side)
 *   tests/test_update_manifest.js → the contract itself
 *
 * Division of labour (deliberate, do not blur it):
 *   BUILD side   constructs the URL — installerUrl() is the only constructor,
 *                so no script and no human ever hand-writes a tag or asset name.
 *   CLIENT side  never constructs anything: it validates the manifest it got and
 *                parses the URL that the manifest declared. A client that built
 *                its own URL would be able to drift from the published contract.
 *
 * Honesty rules for `releasedAt` / `notes`:
 *   Neither has a reliable build-time source (the build may run days before the
 *   release, and release prose is written by a human). They are therefore
 *   OPTIONAL: the build passes them explicitly, and when it cannot, the field is
 *   OMITTED rather than fabricated. build() never invents a timestamp.
 *
 * Security boundary (must stay in the docs, see docs/RELEASE.md):
 *   The installer is NOT code signed. sha256 only proves that the bytes we
 *   downloaded are the bytes the manifest described. It proves nothing about
 *   who published them, and it cannot defend against a compromised repository or
 *   account. Never describe it as publisher identity verification.
 *
 * Zero dependencies. Pure functions only: no fs, no network, no state — so the
 * same code runs in the build, in the static server and in tests.
 */

const productVersion = require('./product-version.js');

/* ── Frozen distribution identity (single source for the whole product) ──── */

const SCHEMA = 'internalbeyond.update';
const SCHEMA_VERSION = 1;
const CHANNEL_STABLE = 'stable';
const CHANNELS = [CHANNEL_STABLE];

const REPO = 'yydye/InternalBeyond';
const RELEASES_BASE = 'https://github.com/' + REPO + '/releases';
const DOWNLOAD_BASE = RELEASES_BASE + '/download';
const TAG_PREFIX = 'v';
const ASSET_PREFIX = 'InternalBeyond-Setup-';
const ASSET_SUFFIX = '.exe';

/* The stable channel entry point. Frozen by U-D1: the manifest is the last
   asset of a release, so its presence is what puts a version on the channel. */
const MANIFEST_ASSET = 'update-stable.json';
const MANIFEST_URL = RELEASES_BASE + '/latest/download/' + MANIFEST_ASSET;

/* Hosts a manifest may point at. The redirect target (objects.githubusercontent
   .com / release-assets.githubusercontent.com) is a transport concern, not part
   of the declared contract, so it is not listed here. */
const ALLOWED_HOSTS = ['github.com'];

/* Sanity bounds for installer.sizeBytes. Not a security control — a guard
   against a truncated or nonsense manifest. The payload always carries the
   bundled Node runtime, so a real installer is ~48 MB; anything under 8 MiB is
   certainly not one. */
const MIN_PLAUSIBLE_INSTALLER_BYTES = 8 * 1024 * 1024;
const MAX_PLAUSIBLE_INSTALLER_BYTES = 512 * 1024 * 1024;

/* Release notes are rendered as plain text in Diagnostics. The cap only keeps a
   hostile or broken manifest from bloating the UI. */
const NOTES_MAX_CHARS = 4000;

const SHA256_RE = /^[0-9a-f]{64}$/;
const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

/* Fields build()/writeManifest() accept. Anything else is a caller typo and is
   rejected at the CLI boundary instead of silently producing a broken manifest. */
const BUILD_FIELDS = ['version', 'channel', 'sha256', 'sizeBytes', 'productVersion',
  'releasedAt', 'minimumVersion', 'notes', 'notesUrl'];

/* ── Construction (BUILD side) ───────────────────────────────────────────── */

function tagFor(version) { return TAG_PREFIX + String(version == null ? '' : version).trim(); }

function installerAssetName(version) {
  return ASSET_PREFIX + String(version == null ? '' : version).trim() + ASSET_SUFFIX;
}

/*
 * Complete, version-pinned URL for the installer of `version`.
 * The ONLY place a tag or asset name is ever spelled out. Changing the
 * distribution host means editing RELEASES_BASE + ALLOWED_HOSTS here; validate()
 * then fails loudly anywhere the two disagree.
 */
function installerUrl(version) {
  return DOWNLOAD_BASE + '/' + tagFor(version) + '/' + installerAssetName(version);
}

function normalizeSha256(value) {
  return String(value == null ? '' : value).trim().toLowerCase();
}

/*
 * Assemble a manifest from values the caller actually measured.
 * Required: version, sha256, sizeBytes, productVersion.
 * Optional (omitted when absent, never fabricated): releasedAt, notes, notesUrl,
 * minimumVersion. Key order is fixed so the published file is byte-stable.
 */
function build(fields) {
  const f = fields || {};
  const version = String(f.version == null ? '' : f.version).trim();
  const out = {
    schema: SCHEMA,
    schemaVersion: SCHEMA_VERSION,
    channel: String(f.channel || CHANNEL_STABLE),
    version: version,
    installer: {
      url: installerUrl(version),
      sha256: normalizeSha256(f.sha256),
      sizeBytes: f.sizeBytes,
      productVersion: String(f.productVersion == null ? '' : f.productVersion).trim()
    }
  };
  if (f.releasedAt) out.releasedAt = String(f.releasedAt).trim();
  if (f.minimumVersion) out.minimumVersion = String(f.minimumVersion).trim();
  if (f.notes) out.notes = String(f.notes).replace(/\r\n/g, '\n');
  if (f.notesUrl) out.notesUrl = String(f.notesUrl).trim();
  return out;
}

/* Deterministic JSON text for dist\update-stable.json (2-space, LF, trailing NL). */
function serialize(manifest) {
  return JSON.stringify(manifest, null, 2).replace(/\r\n/g, '\n') + '\n';
}

/* ── Parsing / validation (CLIENT side) ──────────────────────────────────── */

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/*
 * Parse an installer URL and prove it matches the frozen pattern:
 *   https://github.com/<owner>/<repo>/releases/download/<tag>/<asset>
 * with tag === 'v' + version and asset === installerAssetName(version).
 * Returns { ok, why, host, tag, version, asset }.
 */
function parseInstallerUrl(url) {
  const raw = String(url == null ? '' : url).trim();
  const fail = function (why) { return { ok: false, why: why, host: null, tag: null, version: null, asset: null }; };
  if (!raw) return fail('installer.url is empty');
  let u = null;
  try { u = new URL(raw); } catch (e) { return fail('installer.url is not a valid URL'); }
  if (u.protocol !== 'https:') return fail('installer.url must use https (got ' + u.protocol + ')');
  const host = u.hostname.toLowerCase();
  if (ALLOWED_HOSTS.indexOf(host) < 0) return fail('installer.url host is not allowed: ' + host);
  const parts = u.pathname.split('/').filter(Boolean);
  /* [owner, repo, 'releases', 'download', tag, asset] */
  if (parts.length !== 6 || parts[2] !== 'releases' || parts[3] !== 'download') {
    return fail('installer.url is not a release download URL: ' + u.pathname);
  }
  if (parts[0] + '/' + parts[1] !== REPO) return fail('installer.url points at another repository: ' + parts[0] + '/' + parts[1]);
  const tag = parts[4];
  const asset = parts[5];
  if (tag.indexOf(TAG_PREFIX) !== 0) return fail('installer.url tag must start with "' + TAG_PREFIX + '": ' + tag);
  const version = tag.slice(TAG_PREFIX.length);
  if (!productVersion.parse(version)) return fail('installer.url tag is not MAJOR.MINOR.PATCH: ' + tag);
  if (asset !== installerAssetName(version)) {
    return fail('installer.url asset name does not match its tag: ' + asset + ' (expected ' + installerAssetName(version) + ')');
  }
  return { ok: true, why: null, host: host, tag: tag, version: version, asset: asset };
}

/*
 * Validate a manifest object. Returns { ok, errors:[{field,why}], warnings:[] }.
 * Strict about what the updater depends on; tolerant about unknown extra fields
 * so a newer publisher can add keys without breaking older clients.
 */
function validate(manifest) {
  const errors = [];
  const warnings = [];
  const bad = function (field, why) { errors.push({ field: field, why: why }); };

  if (!isPlainObject(manifest)) {
    return { ok: false, errors: [{ field: '(root)', why: 'manifest is not a JSON object' }], warnings: warnings };
  }

  if (manifest.schema !== SCHEMA) bad('schema', 'expected "' + SCHEMA + '", got ' + JSON.stringify(manifest.schema));
  if (manifest.schemaVersion !== SCHEMA_VERSION) {
    bad('schemaVersion', 'unsupported schemaVersion ' + JSON.stringify(manifest.schemaVersion) + ' (this build understands ' + SCHEMA_VERSION + ')');
  }
  if (CHANNELS.indexOf(manifest.channel) < 0) {
    bad('channel', 'unknown channel ' + JSON.stringify(manifest.channel) + ' (known: ' + CHANNELS.join(', ') + ')');
  }

  const versionParsed = productVersion.parse(manifest.version);
  if (!versionParsed) bad('version', 'not MAJOR.MINOR.PATCH: ' + JSON.stringify(manifest.version));

  if ('releasedAt' in manifest && manifest.releasedAt !== null) {
    const t = String(manifest.releasedAt).trim();
    if (!ISO_UTC_RE.test(t)) {
      bad('releasedAt', 'must be an ISO-8601 UTC timestamp like 2026-09-10T06:00:00Z, got ' + JSON.stringify(manifest.releasedAt));
    } else if (Number.isNaN(Date.parse(t))) {
      bad('releasedAt', 'not a real date: ' + JSON.stringify(t));
    }
  }

  if ('minimumVersion' in manifest && manifest.minimumVersion !== null) {
    if (!productVersion.parse(manifest.minimumVersion)) {
      bad('minimumVersion', 'not MAJOR.MINOR.PATCH: ' + JSON.stringify(manifest.minimumVersion));
    }
  }

  const installer = manifest.installer;
  if (!isPlainObject(installer)) {
    bad('installer', 'missing or not an object');
  } else {
    const parsedUrl = parseInstallerUrl(installer.url);
    if (!parsedUrl.ok) {
      bad('installer.url', parsedUrl.why);
    } else if (versionParsed && parsedUrl.version !== versionParsed.version) {
      /* The URL must be pinned to the version the manifest announces. */
      bad('installer.url', 'url version ' + parsedUrl.version + ' does not match manifest version ' + versionParsed.version);
    }

    const sha = normalizeSha256(installer.sha256);
    if (!SHA256_RE.test(sha)) {
      bad('installer.sha256', 'must be 64 hex characters, got ' + JSON.stringify(installer.sha256));
    }

    const size = installer.sizeBytes;
    if (typeof size !== 'number' || !Number.isInteger(size)) {
      bad('installer.sizeBytes', 'must be an integer, got ' + JSON.stringify(size));
    } else if (size < MIN_PLAUSIBLE_INSTALLER_BYTES) {
      bad('installer.sizeBytes', 'implausibly small (' + size + ' bytes < ' + MIN_PLAUSIBLE_INSTALLER_BYTES + '); the payload always bundles the Node runtime');
    } else if (size > MAX_PLAUSIBLE_INSTALLER_BYTES) {
      bad('installer.sizeBytes', 'implausibly large (' + size + ' bytes > ' + MAX_PLAUSIBLE_INSTALLER_BYTES + ')');
    }

    const pv = productVersion.parse(installer.productVersion);
    if (!pv) {
      bad('installer.productVersion', 'not MAJOR.MINOR.PATCH: ' + JSON.stringify(installer.productVersion));
    } else if (versionParsed && pv.version !== versionParsed.version) {
      bad('installer.productVersion', 'productVersion ' + pv.version + ' does not match manifest version ' + versionParsed.version);
    }
  }

  if ('notes' in manifest && manifest.notes !== null) {
    if (typeof manifest.notes !== 'string') {
      bad('notes', 'must be a string');
    } else if (manifest.notes.length > NOTES_MAX_CHARS) {
      bad('notes', 'longer than ' + NOTES_MAX_CHARS + ' characters (' + manifest.notes.length + ')');
    } else if (/[<>]/.test(manifest.notes)) {
      /* Not an error: release prose may legitimately contain angle brackets.
         The UI must render notes with textContent, never innerHTML (U4). */
      warnings.push({ field: 'notes', why: 'contains < or > — must be rendered as plain text, never as HTML' });
    }
  }

  if ('notesUrl' in manifest && manifest.notesUrl !== null) {
    const nu = String(manifest.notesUrl).trim();
    let parsed = null;
    try { parsed = new URL(nu); } catch (e) { parsed = null; }
    if (!parsed || parsed.protocol !== 'https:') {
      bad('notesUrl', 'must be an https URL, got ' + JSON.stringify(manifest.notesUrl));
    } else if (ALLOWED_HOSTS.indexOf(parsed.hostname.toLowerCase()) < 0) {
      bad('notesUrl', 'host is not allowed: ' + parsed.hostname);
    }
  }

  const known = ['schema', 'schemaVersion', 'channel', 'version', 'releasedAt', 'minimumVersion',
    'installer', 'notes', 'notesUrl'];
  const extra = Object.keys(manifest).filter(function (k) { return known.indexOf(k) < 0; });
  if (extra.length) {
    warnings.push({ field: '(root)', why: 'unknown field(s) ignored: ' + extra.join(', ') });
  }

  return { ok: errors.length === 0, errors: errors, warnings: warnings };
}

/* ── Build-side write ────────────────────────────────────────────────────── */

/*
 * Assemble + self-validate + write dist\update-stable.json.
 * Returns { ok, path, manifest, errors, warnings, releasedAtSupplied, notesSupplied }.
 * A manifest that fails validation is NEVER written, so a broken release
 * contract cannot be published by a green-looking build.
 */
function writeManifest(opts) {
  const fs = require('fs');
  const path = require('path');
  const o = opts || {};
  const manifest = build({
    version: o.version,
    channel: o.channel,
    sha256: o.sha256,
    sizeBytes: o.sizeBytes,
    productVersion: o.productVersion,
    releasedAt: o.releasedAt,
    minimumVersion: o.minimumVersion,
    notes: o.notes,
    notesUrl: o.notesUrl
  });
  const report = validate(manifest);
  const result = {
    ok: report.ok,
    path: o.out ? path.resolve(String(o.out)) : null,
    manifest: manifest,
    errors: report.errors,
    warnings: report.warnings,
    releasedAtSupplied: Object.prototype.hasOwnProperty.call(manifest, 'releasedAt'),
    notesSupplied: Object.prototype.hasOwnProperty.call(manifest, 'notes')
  };
  if (!report.ok) return result;
  fs.mkdirSync(path.dirname(result.path), { recursive: true });
  fs.writeFileSync(result.path, serialize(manifest), 'utf8');
  return result;
}

module.exports = {
  SCHEMA: SCHEMA,
  SCHEMA_VERSION: SCHEMA_VERSION,
  CHANNEL_STABLE: CHANNEL_STABLE,
  CHANNELS: CHANNELS,
  REPO: REPO,
  RELEASES_BASE: RELEASES_BASE,
  DOWNLOAD_BASE: DOWNLOAD_BASE,
  TAG_PREFIX: TAG_PREFIX,
  MANIFEST_ASSET: MANIFEST_ASSET,
  MANIFEST_URL: MANIFEST_URL,
  ALLOWED_HOSTS: ALLOWED_HOSTS,
  NOTES_MAX_CHARS: NOTES_MAX_CHARS,
  BUILD_FIELDS: BUILD_FIELDS,
  MIN_PLAUSIBLE_INSTALLER_BYTES: MIN_PLAUSIBLE_INSTALLER_BYTES,
  MAX_PLAUSIBLE_INSTALLER_BYTES: MAX_PLAUSIBLE_INSTALLER_BYTES,
  tagFor: tagFor,
  installerAssetName: installerAssetName,
  installerUrl: installerUrl,
  build: build,
  serialize: serialize,
  validate: validate,
  parseInstallerUrl: parseInstallerUrl,
  writeManifest: writeManifest
};

/* ── CLI ───────────────────────────────────────────────────────────────── */

if (require.main === module) {
  const fs = require('fs');
  const argv = process.argv.slice(2);

  /* Minimal --key value / --flag parser. Unknown --keys are rejected: a typo in
     the build must fail, not silently drop a field from the contract. */
  const args = {};
  const unknown = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.indexOf('--') !== 0) { unknown.push(a); continue; }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.indexOf('--') === 0) { args[key] = true; }
    else { args[key] = next; i++; }
  }

  const emit = function (obj, code) {
    process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
    process.exitCode = code;
  };

  const ALLOWED_FLAGS = BUILD_FIELDS.concat(['write', 'validate', 'notesFile']);
  const badFlags = Object.keys(args).filter(function (k) { return ALLOWED_FLAGS.indexOf(k) < 0; }).concat(unknown);

  if (badFlags.length) {
    emit({ ok: false, errors: [{ field: '(cli)', why: 'unknown argument(s): ' + badFlags.join(', ') }] }, 1);
  } else if (args['write']) {
    let notes = '';
    let notesError = null;
    if (typeof args.notesFile === 'string' && args.notesFile) {
      try { notes = fs.readFileSync(args.notesFile, 'utf8').replace(/^\uFEFF/, '').trim(); }
      catch (e) { notesError = 'unreadable notes file: ' + args.notesFile + ' (' + String((e && e.code) || e) + ')'; }
    }
    if (notesError) { emit({ ok: false, errors: [{ field: 'notesFile', why: notesError }] }, 1); }
    else {
      const result = writeManifest({
        out: args.write,
        version: args.version,
        channel: typeof args.channel === 'string' ? args.channel : '',
        sha256: args.sha256,
        sizeBytes: args.sizeBytes === undefined ? NaN : Number(args.sizeBytes),
        productVersion: args.productVersion,
        releasedAt: typeof args.releasedAt === 'string' ? args.releasedAt : '',
        minimumVersion: typeof args.minimumVersion === 'string' ? args.minimumVersion : '',
        notes: notes,
        notesUrl: typeof args.notesUrl === 'string' ? args.notesUrl : ''
      });
      emit(result, result.ok ? 0 : 1);
    }
  } else if (args['validate']) {
    let manifest = null;
    let readError = null;
    try { manifest = JSON.parse(fs.readFileSync(String(args.validate), 'utf8').replace(/^\uFEFF/, '')); }
    catch (e) { readError = 'not readable JSON: ' + String((e && e.message) || e); }
    if (readError) { emit({ ok: false, errors: [{ field: '(root)', why: readError }] }, 1); }
    else {
      const result = validate(manifest);
      emit({ ok: result.ok, path: String(args.validate), errors: result.errors, warnings: result.warnings, manifest: manifest }, result.ok ? 0 : 1);
    }
  } else {
    emit({
      ok: false,
      usage: [
        'node runtime/update-manifest.js --write <out.json> --version V --sha256 H --sizeBytes N --productVersion P [--releasedAt ISO] [--minimumVersion V] [--notesFile F] [--notesUrl U]',
        'node runtime/update-manifest.js --validate <manifest.json>',
        'stable manifest URL: ' + MANIFEST_URL
      ]
    }, 1);
  }
}
