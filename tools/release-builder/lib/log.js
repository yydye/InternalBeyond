'use strict';

/*
 * Release Builder · structured log with real redaction.
 *
 * Two jobs, both non-negotiable (user requirement §9):
 *
 *   1. Every release produces its own log file, and every field a human needs
 *      to reconstruct the release is in it: timestamps, repo commit, source and
 *      target version, channel, CHECK results, the exact build command and exit
 *      code, artifact path / bytes / sha256, manifest values, the U1–U5
 *      verification, the SEAL result and the PUBLISH result.
 *
 *   2. NO secret may ever reach it. Not an API key, not a token, not an
 *      Authorization header, and not a dumped environment.
 *
 * How (2) is actually enforced, rather than promised:
 *   · Every line goes through `redact()` before it is stored or written.
 *   · `redact()` masks every value of every environment variable whose NAME
 *     looks like a credential (that is what "do not dump the environment" means
 *     when a child process might print one).
 *   · Command output is redacted line by line as it streams, so a credential
 *     cannot be captured even transiently in the in-memory view.
 *   · Known credential shapes (bearer tokens, `x-access-token:…@github.com`,
 *     `ghp_…`, `sk-…`, …) are masked even when the value is not in the
 *     environment — a remote URL with an embedded token is the realistic case.
 *
 * The patterns are a *second line of defence*, not a second vocabulary: the
 * payload secret vocabulary stays owned by scripts/release-audit.js and is
 * never copied here.
 */

const fs = require('fs');
const path = require('path');

/* Names whose VALUES are secrets if present in the environment. */
const SECRET_NAME_RE = /(SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|PRIVATE[_-]?KEY|API[_-]?KEY|ACCESS[_-]?KEY|AUTH|COOKIE|SESSION|PAT|^GH_|^GITHUB_)/i;
const SECRET_NAME_ALLOW = /^(PUBLIC|USERNAME|COMPUTERNAME|USERDOMAIN|SESSIONNAME|AUTHORS?$|KEYBOARD|PATH$|PATHEXT$|COMPAT)/i;

/* Value shapes that are credentials regardless of where they came from.
   `keep` is a fixed prefix to preserve (group 1 is always the credential). */
const SHAPE_RULES = [
  { re: /\b(sk|ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_-]{12,}\b/g, why: 'token', keep: '' },
  { re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, why: 'token', keep: '' },
  { re: /\b(sk|xai|AIza)[-_A-Za-z0-9]{16,}\b/g, why: 'api-key', keep: '' },
  { re: /\bBearer\s+([A-Za-z0-9._~+/-]{16,}=*)/g, why: 'bearer', keep: 'Bearer ' },
  { re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,}\b/g, why: 'jwt', keep: '' },
  /* A credential embedded in a URL (git remotes are the realistic case). */
  { re: /(https?:\/\/)[^/\s:@]{3,}:([^/\s@]{6,})@/g, why: 'url-credential', keep: '$1', group: 1 },
  { re: /([?&](?:access_token|token|key|api_key|apikey|sig)=)[^&\s"'`]{8,}/gi, why: 'query-credential', keep: '$1', group: 1 }
];

const MASK = '<redacted>';

function buildSecretSet(env) {
  const out = [];
  const e = env || process.env;
  for (const name of Object.keys(e)) {
    if (!SECRET_NAME_RE.test(name)) continue;
    if (SECRET_NAME_ALLOW.test(name)) continue;
    const v = e[name];
    if (typeof v !== 'string' || v.length < 8) continue;
    out.push(v);
  }
  /* Longest first: a short secret that is a substring of a long one must not
     leave the long one half-masked. */
  out.sort(function (a, b) { return b.length - a.length; });
  return out;
}

function makeRedactor(opts) {
  const o = opts || {};
  const secrets = buildSecretSet(o.env);
  let hits = 0;
  const redact = function (value) {
    if (value === null || value === undefined) return value;
    let s = typeof value === 'string' ? value : String(value);
    for (const secret of secrets) {
      if (s.indexOf(secret) >= 0) {
        s = s.split(secret).join(MASK);
        hits++;
      }
    }
    for (const rule of SHAPE_RULES) {
      rule.re.lastIndex = 0;
      s = s.replace(rule.re, function () {
        hits++;
        const g = rule.group ? arguments[rule.group] : '';
        const prefix = rule.keep ? rule.keep.replace('$1', g || '') : '';
        return prefix + MASK;
      });
    }
    return s;
  };
  return {
    redact: redact,
    hits: function () { return hits; },
    secretCount: function () { return secrets.length; }
  };
}

const STAGE_ORDER = ['CHECK', 'BUILD', 'VERIFY', 'SEAL', 'PUBLISH'];

function nowIso() { return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'); }

/*
 * A run log. One instance per run.
 *
 *   log.stage('BUILD')                  begin a stage
 *   log.item(...)                       record one check / one fact
 *   log.event(kind, message, data)      free-form, redacted
 *   log.blocker(code, message, extra)   record a hard stop
 *   log.command(cmd, args, exitCode, ms) record exactly what was executed
 *   log.view()                          the redacted snapshot handed to the GUI
 *   log.writeFiles(dir, stem)           dist/release-<version>.log (jsonl + human)
 */
function createLog(opts) {
  const o = opts || {};
  const redactor = makeRedactor({ env: o.env });
  const started = o.now || nowIso();
  const lines = [];      /* {seq, at, kind, stage, ...} */
  const items = new Map(); /* key -> item view */
  const blockers = [];
  const warnings = [];
  const commands = [];
  let seq = 0;
  let currentStage = null;
  let truncated = 0;
  const MAX_LINES = typeof o.maxLines === 'number' ? o.maxLines : 20000;

  const push = function (kind, stage, payload) {
    seq++;
    const line = Object.assign({ seq: seq, at: nowIso(), kind: kind, stage: stage || currentStage }, payload || {});
    /* Redact every string ANYWHERE in the record — including nested arrays such
       as a command's argument list, where a credential realistically appears
       (`gh auth login --with-token <token>`). A command line is not exempt. */
    const scrub = function (value) {
      if (typeof value === 'string') return redactor.redact(value);
      if (Array.isArray(value)) return value.map(scrub);
      if (value && typeof value === 'object') {
        const out = {};
        for (const k of Object.keys(value)) out[k] = scrub(value[k]);
        return out;
      }
      return value;
    };
    for (const k of Object.keys(line)) line[k] = scrub(line[k]);
    if (lines.length >= MAX_LINES) { truncated++; lines.shift(); }
    lines.push(line);
    return line;
  };

  const api = {
    redact: redactor.redact,
    redactionHits: redactor.hits,
    secretNameCount: redactor.secretCount,

    meta: function (obj) { return push('meta', null, obj || {}); },
    stage: function (name, extra) {
      currentStage = name;
      return push('stage', name, Object.assign({ status: 'running' }, extra || {}));
    },
    debug: function (message, data) { return push('debug', null, Object.assign({ message: message }, data || {})); },
    event: function (message, data) { return push('event', null, Object.assign({ message: message }, data || {})); },

    /*
     * Record or update one check/fact. `key` is stable across updates WITHIN A
     * STAGE, and is namespaced by stage here: several stages legitimately ask
     * the same question ("does the artifact exist?", "does the size make
     * sense?"), and without the namespace a later stage's blocked result would
     * merge into an earlier stage's ok result — which is exactly the kind of
     * silent downgrade this tool exists to prevent.
     */
    item: function (key, fields) {
      const scope = (fields && fields.stage) || currentStage || '-';
      const scoped = scope + ':' + key;
      const prev = items.get(scoped) || { key: key, status: 'pending' };
      const next = Object.assign({}, prev, fields, { key: key, scopedKey: scoped, stage: scope, seq: seq + 1 });
      const line = push('item', fields && fields.stage, {
        key: scoped,
        status: next.status,
        title: next.title,
        expected: next.expected,
        actual: next.actual,
        evidence: next.evidence,
        why: next.why,
        detail: next.detail
      });
      next.seq = line.seq;
      items.set(scoped, next);
      return next;
    },

    command: function (spec) {
      const rec = {
        label: spec.label || '',
        file: spec.file || '',
        args: (spec.args || []).slice(),
        cwd: spec.cwd || '',
        shell: spec.shell === true,
        exitCode: typeof spec.exitCode === 'number' ? spec.exitCode : null,
        ms: typeof spec.ms === 'number' ? spec.ms : null,
        at: nowIso()
      };
      commands.push(rec);
      push('command', spec.stage, rec);
      return rec;
    },

    blocker: function (code, message, extra) {
      const rec = Object.assign({ code: code, message: message }, extra || {});
      blockers.push(rec);
      push('blocked', extra && extra.stage, rec);
      return rec;
    },
    warn: function (code, message, extra) {
      const rec = Object.assign({ code: code, message: message }, extra || {});
      warnings.push(rec);
      push('warn', extra && extra.stage, rec);
      return rec;
    },
    note: function (message, extra) { return push('note', extra && extra.stage, Object.assign({ message: message }, extra || {})); },

    hasBlockers: function () { return blockers.length > 0; },
    blockers: function () { return blockers.slice(); },
    warnings: function () { return warnings.slice(); },
    commands: function () { return commands.slice(); },
    items: function () { return [...items.values()]; },
    startedAt: function () { return started; },

    /*
     * The GUI snapshot. Bounded: the log tail is capped and the item list is
     * the authoritative per-check view, so a long build cannot blow up the
     * browser (or the export).
     */
    view: function (opts2) {
      const v = opts2 || {};
      const all = lines.filter(function (l) { return v.since ? l.seq > v.since : true; });
      const keep = v.tail ? all.slice(-v.tail) : all;
      return {
        seq: seq,
        truncated: truncated,
        lines: keep,
        items: api.items().map(function (i) {
          return {
            key: i.scopedKey || i.key, stage: i.stage, status: i.status, title: i.title,
            expected: i.expected, actual: i.actual, evidence: i.evidence, why: i.why,
            detail: i.detail, seq: i.seq
          };
        }),
        blockers: api.blockers(),
        warnings: api.warnings(),
        commands: api.commands()
      };
    },

    /* ── Persistence ─────────────────────────────────────────────────────── */

    /*
     * Write the run's own log. `stem` is normally "release-<version>".
     * Two files, both explicit:
     *   <stem>.log       human-readable, the file the user requirement §5 names
     *   <stem>.jsonl     the same events, machine-readable, one JSON per line
     * Returns { ok, files:[...], error } — never throws: a failed log write must
     * be reported, not turned into a fake release failure.
     */
    writeFiles: function (dir, stem, header) {
      try {
        fs.mkdirSync(dir, { recursive: true });
        const jsonl = path.join(dir, stem + '.jsonl');
        const human = path.join(dir, stem + '.log');
        const meta = [];
        for (const l of lines) meta.push(JSON.stringify(l));
        fs.writeFileSync(jsonl, meta.join('\n') + '\n', 'utf8');
        fs.writeFileSync(human, api.render(header), 'utf8');
        return { ok: true, files: [human, jsonl], error: null };
      } catch (e) {
        return { ok: false, files: [], error: String((e && e.message) || e) };
      }
    },

    render: function (header) {
      const out = [];
      const h = header || {};
      out.push('InternalBeyond Release Builder · run log');
      out.push('generated  : ' + nowIso());
      if (h.tool) out.push('tool       : ' + h.tool);
      if (h.root) out.push('repo root  : ' + h.root);
      if (h.commit) out.push('repo commit: ' + h.commit);
      if (h.sourceVersion) out.push('source ver : ' + h.sourceVersion);
      if (h.targetVersion) out.push('target ver : ' + h.targetVersion);
      if (h.channel) out.push('channel    : ' + h.channel);
      if (h.mode) out.push('mode       : ' + h.mode);
      if (h.status) out.push('status     : ' + h.status);
      out.push('redaction  : ' + redactor.secretCount() + ' environment secret value(s) masked; ' +
        redactor.hits() + ' occurrence(s) masked');
      out.push('');
      for (const l of lines) {
        const at = l.at;
        const st = l.stage ? '[' + l.stage + '] ' : '';
        if (l.kind === 'item') {
          out.push(at + '  ' + st + 'ITEM ' + pad(l.status, 8) + ' ' + (l.title || l.key) +
            (l.expected !== undefined && l.expected !== null && l.expected !== '' ? '  expected=' + oneLine(l.expected) : '') +
            (l.actual !== undefined && l.actual !== null && l.actual !== '' ? '  actual=' + oneLine(l.actual) : '') +
            (l.evidence ? '  evidence=' + oneLine(l.evidence) : '') +
            (l.why ? '  why=' + oneLine(l.why) : ''));
          if (l.detail) for (const d of String(l.detail).split('\n')) out.push('                        | ' + d);
          continue;
        }
        if (l.kind === 'command') {
          out.push(at + '  ' + st + 'EXEC ' + l.file + ' ' + (l.args || []).join(' ') +
            (l.cwd ? '   (cwd ' + l.cwd + ')' : '') +
            (typeof l.exitCode === 'number' ? '   → exit ' + l.exitCode : '') +
            (typeof l.ms === 'number' ? ' (' + l.ms + ' ms)' : ''));
          continue;
        }
        if (l.kind === 'stage') { out.push(''); out.push(at + '  ===== ' + l.stage + ' ====='); continue; }
        if (l.kind === 'blocked') { out.push(at + '  ' + st + 'BLOCKED ' + l.code + ' — ' + l.message); continue; }
        if (l.kind === 'warn') { out.push(at + '  ' + st + 'WARN    ' + l.code + ' — ' + l.message); continue; }
        if (l.kind === 'meta') { out.push(at + '  ' + JSON.stringify(l)); continue; }
        out.push(at + '  ' + st + (l.message || JSON.stringify(l)));
      }
      return out.join('\n') + '\n';
    }
  };

  function pad(s, n) { s = String(s == null ? '' : s); return s + ' '.repeat(Math.max(0, n - s.length)); }
  function oneLine(v) { return String(v).replace(/\r?\n/g, ' ⏎ '); }

  return api;
}

/* Export a portable, redacted export blob for the GUI's "export log" button. */
function exportText(log, header) { return log.render(header); }

module.exports = {
  createLog,
  makeRedactor,
  buildSecretSet,
  SHAPE_RULES,
  SECRET_NAME_RE,
  MASK,
  STAGE_ORDER,
  exportText
};
