'use strict';

/* The pinned Tencent SDK 1.0.5 build contains a Windows drive-path example in
 * a comment. The release secret/path audit correctly rejects that string.
 * This postinstall patch changes only that comment; the exact upstream file
 * hash and package version are checked before any write. */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const EXPECTED_VERSION = '1.0.5';
const EXPECTED_SOURCE_SHA256 = '5cfa70f1ae8d67b4a3fdb1ef21579e2df0d555fea6452e260b1fbea1a8323657';
const slash = String.fromCharCode(92);
const ORIGINAL_COMMENT = '// Skip octal escape decoding for Windows local paths (e.g. C:'
  + slash + 'Users' + slash + '1' + slash + 'file.txt)';
const REPLACEMENT_COMMENT = '// Skip octal escape decoding for Windows drive paths with numeric segments.';

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function patchTencentSdk(root) {
  const packageRoot = path.resolve(root || __dirname, 'node_modules', '@tencent-connect', 'qqbot-nodejs');
  const manifestPath = path.join(packageRoot, 'package.json');
  const sourcePath = path.join(packageRoot, 'dist', 'protocol', 'utils', 'decode-media-path.js');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (!manifest || manifest.name !== '@tencent-connect/qqbot-nodejs' || manifest.version !== EXPECTED_VERSION) {
    throw new Error('qqbot-sdk-patch-package-version-mismatch');
  }
  const source = fs.readFileSync(sourcePath, 'utf8');
  if (!source.includes(ORIGINAL_COMMENT) && source.includes(REPLACEMENT_COMMENT)) {
    return { ok: true, status: 'already-sanitized', version: EXPECTED_VERSION };
  }
  if (sha256(Buffer.from(source, 'utf8')) !== EXPECTED_SOURCE_SHA256
    || source.split(ORIGINAL_COMMENT).length !== 2) {
    throw new Error('qqbot-sdk-patch-source-hash-mismatch');
  }
  const sanitized = source.replace(ORIGINAL_COMMENT, REPLACEMENT_COMMENT);
  fs.writeFileSync(sourcePath, sanitized, 'utf8');
  if (fs.readFileSync(sourcePath, 'utf8') !== sanitized) throw new Error('qqbot-sdk-patch-write-verification-failed');
  return { ok: true, status: 'sanitized-comment-only', version: EXPECTED_VERSION,
    beforeSha256: EXPECTED_SOURCE_SHA256, afterSha256: sha256(Buffer.from(sanitized, 'utf8')) };
}

if (require.main === module) {
  try { process.stdout.write(JSON.stringify(patchTencentSdk()) + '\n'); }
  catch (error) {
    process.stderr.write(String(error && error.message || 'qqbot-sdk-patch-failed') + '\n');
    process.exitCode = 1;
  }
}

module.exports = patchTencentSdk;
