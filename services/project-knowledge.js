'use strict';

/*
 * P32 · Project Knowledge resolver (Browser/Home Node adapter)
 *
 * This module is intentionally independent from Tauri. The browser adapter
 * reaches the same read-only contract through the existing static server; the
 * Tauri adapter implements the contract in Rust. Neither path accepts an
 * arbitrary filesystem path from the model or from the browser.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const AUTHORITY = Object.freeze({ CANONICAL: 3, CURRENT: 2, HISTORICAL: 1 });
const MAX_DOCS = 512;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_SEARCH_RESULTS = 8;
const MAX_SNIPPET_CHARS = 420;
const MAX_READ_CHARS = 32000;
const DENY_SEGMENTS = new Set([
  '.git', 'node_modules', '.venv', '.venv-vision', '__pycache__', 'credentials',
  '.env', 'logs', 'database', 'databases', 'backup', 'backups', 'user uploads',
  'uploads', 'browser-data', 'dist', 'target'
]);

function text(value, max) {
  const out = value == null ? '' : String(value);
  return max && out.length > max ? out.slice(0, max) : out;
}

function normalizeRelative(value) {
  return String(value == null ? '' : value)
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/\/+/g, '/');
}

function relativePath(root, file) {
  return normalizeRelative(path.relative(root, file));
}

function isInside(root, candidate) {
  const a = path.resolve(root);
  const b = path.resolve(candidate);
  return b === a || b.startsWith(a + path.sep);
}

function canonicalInside(root, candidate) {
  let real;
  try { real = fs.realpathSync(candidate); } catch (_) { return null; }
  return isInside(root, real) ? real : null;
}

function isDeniedRelative(rel) {
  const segments = normalizeRelative(rel).split('/').filter(Boolean);
  return segments.some(function (segment) {
    const lower = segment.toLowerCase();
    return segment === '.' || segment === '..' || segment.charAt(0) === '.' || DENY_SEGMENTS.has(lower);
  });
}

function isMarkdownLike(rel) {
  return /\.(?:md|markdown|txt)$/i.test(rel);
}

function isAllowlistedRelative(rel) {
  const normalized = normalizeRelative(rel);
  if (!normalized || isDeniedRelative(normalized) || !isMarkdownLike(normalized)) return false;
  if (/^docs\//i.test(normalized)) return true;
  if (normalized.indexOf('/') >= 0) return false;
  return /^(?:README|GUIDE)[^/]*\.(?:md|markdown|txt)$/i.test(normalized);
}

function slug(value) {
  return String(value == null ? '' : value)
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '') || 'section';
}

function authorityFor(rel) {
  const lower = normalizeRelative(rel).toLowerCase();
  /* Canonical is checked first so a contract or architecture document never
     becomes historical merely because its filename also contains a phase word. */
  if (/(^|\/)(contracts?|canonical)(\/|$)/.test(lower) ||
      /(?:contract|architecture)/.test(lower)) return 'CANONICAL';
  if (/(?:chronicle|changelog|historical|legacy|archive|closure|history)/.test(lower)) return 'HISTORICAL';
  return 'CURRENT';
}

function authorityRank(authority) {
  return AUTHORITY[authority] || 0;
}

function sha256(content) {
  return crypto.createHash('sha256').update(Buffer.from(content, 'utf8')).digest('hex');
}

function headingRows(content) {
  const lines = String(content || '').replace(/\r\n?/g, '\n').split('\n');
  const rows = [];
  lines.forEach(function (line, index) {
    const match = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (!match) return;
    const title = text(match[2].trim(), 240);
    if (!title) return;
    rows.push({ level: match[1].length, title: title, line: index + 1 });
  });
  return { lines: lines, rows: rows };
}

function buildSections(content) {
  const parsed = headingRows(content);
  const lines = parsed.lines;
  const rows = parsed.rows;
  const sections = [];
  if (rows.length && rows[0].line > 1) {
    sections.push({
      id: 'preamble', heading: '', level: 0, startLine: 1,
      endLine: rows[0].line - 1, text: lines.slice(0, rows[0].line - 1).join('\n').trim()
    });
  }
  if (!rows.length) {
    sections.push({ id: 'document', heading: '', level: 0, startLine: 1, endLine: lines.length, text: lines.join('\n').trim() });
    return sections;
  }
  rows.forEach(function (row, index) {
    let endLine = lines.length;
    for (let next = index + 1; next < rows.length; next++) {
      if (rows[next].level <= row.level) { endLine = rows[next].line - 1; break; }
    }
    sections.push({
      id: slug(row.title), heading: row.title, level: row.level,
      startLine: row.line, endLine: endLine,
      text: lines.slice(row.line, endLine).join('\n').trim()
    });
  });
  return sections;
}

function titleFor(rel, sections) {
  const h1 = sections.find(function (section) { return section.level === 1 && section.heading; });
  if (h1) return h1.heading;
  return path.basename(rel).replace(/\.[^.]+$/, '');
}

function compact(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

function termsOf(query) {
  const raw = compact(query).toLowerCase();
  if (!raw) return [];
  const terms = [];
  const add = function (value) {
    const term = String(value || '').trim();
    if (term && terms.indexOf(term) < 0) terms.push(term);
  };
  (raw.match(/[\p{L}\p{N}]{2,}/gu) || []).forEach(add);
  /* Chinese queries often arrive without spaces; include bounded n-grams so a
     heading such as “经济设计” is searchable without an embedding stack. */
  const cjk = raw.replace(/[^\p{Script=Han}]/gu, '');
  for (let i = 0; i < cjk.length; i++) {
    add(cjk.slice(i, i + 2));
    if (i < cjk.length - 2) add(cjk.slice(i, i + 3));
  }
  return terms.slice(0, 24);
}

function snippetFor(value, terms) {
  const normalized = compact(value);
  if (normalized.length <= MAX_SNIPPET_CHARS) return normalized;
  let start = 0;
  const lower = normalized.toLowerCase();
  for (let i = 0; i < terms.length; i++) {
    const at = lower.indexOf(terms[i].toLowerCase());
    if (at >= 0) { start = Math.max(0, at - 90); break; }
  }
  const prefix = start > 0 ? '…' : '';
  const body = normalized.slice(start, start + MAX_SNIPPET_CHARS - prefix.length);
  return prefix + body + (start + body.length < normalized.length ? '…' : '');
}

function scoreSection(doc, section, query, terms) {
  const haystack = compact([doc.title, section.heading, section.text].join(' ')).toLowerCase();
  const q = compact(query).toLowerCase();
  if (!haystack || !q) return 0;
  let score = haystack.indexOf(q) >= 0 ? 10 : 0;
  terms.forEach(function (term) {
    const at = haystack.indexOf(term.toLowerCase());
    if (at >= 0) {
      score += 1.6;
      if (section.heading && section.heading.toLowerCase().indexOf(term.toLowerCase()) >= 0) score += 3;
    }
  });
  return score + authorityRank(doc.authority) * 0.35;
}

function publicDoc(doc) {
  return {
    docId: doc.docId,
    relativePath: doc.relativePath,
    title: doc.title,
    headings: doc.sections.filter(function (section) { return !!section.heading; }).map(function (section) {
      return { id: section.id, title: section.heading, level: section.level, line: section.startLine };
    }),
    sections: doc.sections.map(function (section) {
      return { id: section.id, heading: section.heading, level: section.level, startLine: section.startLine, endLine: section.endLine };
    }),
    authority: doc.authority,
    updatedAt: doc.updatedAt,
    hash: doc.hash
  };
}

function createProjectKnowledge(options) {
  const opts = options || {};
  const root = path.resolve(String(opts.root || process.cwd()));
  const rootReal = canonicalInside(root, root) || root;
  let state = { docs: [], byId: new Map(), refreshedAt: null, error: null };

  function collectFiles(dir, relDir, out) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (error) { state.error = String(error && error.message || error); return; }
    entries.forEach(function (entry) {
      const rel = normalizeRelative(relDir ? relDir + '/' + entry.name : entry.name);
      if (isDeniedRelative(rel)) return;
      const absolute = path.join(dir, entry.name);
      /* Reject symlinks altogether. This is stricter than merely checking the
         target and prevents a later link swap from widening the allowlist. */
      if (entry.isSymbolicLink()) return;
      if (entry.isDirectory()) {
        if (/^docs$/i.test(rel) || /^docs\//i.test(rel)) collectFiles(absolute, rel, out);
        return;
      }
      if (!entry.isFile() || !isAllowlistedRelative(rel)) return;
      const canonical = canonicalInside(rootReal, absolute);
      if (!canonical) return;
      let stat;
      try { stat = fs.statSync(canonical); } catch (_) { return; }
      if (stat.size > MAX_FILE_BYTES) return;
      out.push({ absolute: canonical, relativePath: rel, stat: stat });
    });
  }

  function refresh() {
    state = { docs: [], byId: new Map(), refreshedAt: new Date().toISOString(), error: null };
    const files = [];
    collectFiles(rootReal, '', files);
    files.sort(function (a, b) { return a.relativePath.localeCompare(b.relativePath); });
    files.slice(0, MAX_DOCS).forEach(function (file) {
      let content;
      try { content = fs.readFileSync(file.absolute, 'utf8'); } catch (_) { return; }
      const sections = buildSections(content);
      const doc = {
        docId: 'project-doc:' + file.relativePath,
        relativePath: file.relativePath,
        title: titleFor(file.relativePath, sections),
        authority: authorityFor(file.relativePath),
        updatedAt: new Date(file.stat.mtimeMs).toISOString(),
        hash: sha256(content),
        absolute: file.absolute,
        sections: sections
      };
      state.docs.push(doc);
      state.byId.set(doc.docId, doc);
    });
    return status();
  }

  function status() {
    const counts = { CANONICAL: 0, CURRENT: 0, HISTORICAL: 0 };
    state.docs.forEach(function (doc) { counts[doc.authority] = (counts[doc.authority] || 0) + 1; });
    return {
      ok: !state.error,
      indexedDocs: state.docs.length,
      canonicalDocs: counts.CANONICAL,
      currentDocs: counts.CURRENT,
      historicalDocs: counts.HISTORICAL,
      lastIndexRefresh: state.refreshedAt,
      searchStatus: state.error ? 'error' : 'ready',
      error: state.error || null
    };
  }

  function listProjectDocs() {
    return Object.assign({ docs: state.docs.map(publicDoc) }, status());
  }

  function searchProjectDocs(query, options) {
    const q = compact(query).slice(0, 240);
    const terms = termsOf(q);
    const limit = Math.max(1, Math.min(MAX_SEARCH_RESULTS, Number(options && options.limit) || MAX_SEARCH_RESULTS));
    const authority = options && String(options.authority || '').toUpperCase();
    const candidates = [];
    state.docs.forEach(function (doc) {
      if (authority && doc.authority !== authority) return;
      doc.sections.forEach(function (section) {
        const score = scoreSection(doc, section, q, terms);
        if (!score) return;
        candidates.push({
          docId: doc.docId,
          relativePath: doc.relativePath,
          title: doc.title,
          section: section.heading || section.id,
          heading: section.heading,
          snippet: snippetFor(section.text || doc.title, terms),
          authority: doc.authority,
          updatedAt: doc.updatedAt,
          hash: doc.hash,
          score: score
        });
      });
    });
    candidates.sort(function (a, b) {
      if (b.score !== a.score) return b.score - a.score;
      const ar = authorityRank(b.authority) - authorityRank(a.authority);
      if (ar) return ar;
      if (b.updatedAt !== a.updatedAt) return b.updatedAt < a.updatedAt ? -1 : 1;
      return a.docId.localeCompare(b.docId) || String(a.section).localeCompare(String(b.section));
    });
    const results = [];
    const seen = new Set();
    candidates.forEach(function (result) {
      const key = result.docId + '|' + result.section;
      if (seen.has(key) || results.length >= limit) return;
      seen.add(key);
      results.push(result);
    });
    return Object.assign({
      query: q,
      results: results,
      stats: { candidateCount: candidates.length, returned: results.length, terms: terms }
    }, status());
  }

  function findSection(doc, requested) {
    if (!requested) return null;
    const wanted = String(requested).trim().toLowerCase();
    return doc.sections.find(function (section) {
      return section.id.toLowerCase() === wanted || section.heading.toLowerCase() === wanted || slug(section.heading) === wanted;
    }) || null;
  }

  function readProjectDoc(docId, section) {
    const key = String(docId == null ? '' : docId);
    const doc = state.byId.get(key);
    if (!doc) return { ok: false, error: 'doc-not-allowlisted' };
    const canonical = canonicalInside(rootReal, doc.absolute);
    if (!canonical || canonical !== doc.absolute) return { ok: false, error: 'path-boundary-rejected' };
    let content;
    try { content = fs.readFileSync(canonical, 'utf8'); } catch (_) { return { ok: false, error: 'doc-unreadable' }; }
    const currentHash = sha256(content);
    if (currentHash !== doc.hash) {
      refresh();
      return readProjectDoc(key, section);
    }
    const target = findSection(doc, section);
    if (section && !target) return { ok: false, error: 'section-not-found', docId: key };
    const body = target ? target.text : content;
    const bounded = text(body, MAX_READ_CHARS);
    return {
      ok: true,
      docId: doc.docId,
      relativePath: doc.relativePath,
      title: doc.title,
      section: target ? (target.heading || target.id) : null,
      authority: doc.authority,
      updatedAt: doc.updatedAt,
      hash: doc.hash,
      truncated: bounded.length < String(body || '').length,
      content: bounded
    };
  }

  refresh();
  return {
    root: rootReal,
    refresh: refresh,
    status: status,
    listProjectDocs: listProjectDocs,
    searchProjectDocs: searchProjectDocs,
    readProjectDoc: readProjectDoc,
    constants: Object.freeze({ MAX_DOCS, MAX_SEARCH_RESULTS, MAX_SNIPPET_CHARS, MAX_READ_CHARS })
  };
}

module.exports = {
  AUTHORITY,
  createProjectKnowledge,
  isAllowlistedRelative,
  authorityFor,
  slug
};
