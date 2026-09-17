'use strict';

/*
 * InternalBeyond Release Builder · where a version's release notes live.
 *
 * docs/release-notes/<target>.md is a CANONICAL repository path, not a tool
 * convention: lib/publish.js hands it to `gh release create --notes-file`,
 * lib/check.js warns when it is absent, lib/seal.js folds its text into the
 * manifest, and lib/verify.js proves the manifest's `notes` still matches it.
 *
 * R2 adds a GUI editor for that file, which makes a fourth caller. Four
 * separately spelled paths drift the moment one of them is edited, and a GUI
 * that wrote one path while the build read another would look like it worked
 * and quietly ship a release with no notes. So the rule is named exactly once,
 * here, and every caller derives from it.
 *
 * This module decides nothing about CONTENT or about whether the notes are
 * good: it only answers "which file". The absence of the file stays a warning
 * (docs/RELEASE.md §4 permits omitting notes), never a blocker introduced here.
 */

const path = require('path');

const NOTES_DIR = ['docs', 'release-notes'];

/** Absolute path of the canonical release notes for `target`. '' when unusable. */
function pathFor(root, target) {
  const t = String(target || '').trim();
  if (!root || !t || !/^\d+\.\d+\.\d+$/.test(t)) return '';
  return path.join.apply(path, [root].concat(NOTES_DIR, [t + '.md']));
}

/** Repository-relative (forward-slash) path, for display and for `gh`. */
function relFor(root, target) {
  const abs = pathFor(root, target);
  return abs ? path.relative(root, abs).split(path.sep).join('/') : '';
}

module.exports = { NOTES_DIR, pathFor, relFor };
