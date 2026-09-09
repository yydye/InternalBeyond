'use strict';

/*
 * Internal Beyond · release payload audit (P7)
 *
 * Two gates, both applied to the REAL staged bytes (not to the manifest):
 *
 *   1. content gate  — manifest.auditDirectory() re-checks every staged path
 *                      against the deny rules (.git / logs / browser-data /
 *                      test files / dev reports / …).
 *   2. secret gate   — credential, demo-secret, developer-path, email and phone
 *                      patterns over text files, plus a raw byte-marker scan
 *                      (ASCII and UTF-16LE) over every file including binaries
 *                      such as the bundled node.exe and the guide screenshots.
 *
 * Exit code 0 = clean, 1 = at least one `error` finding or content violation.
 * `warn` findings are printed and summarised but never fail the build; they are
 * reviewed by a human before publishing.
 *
 * Usage:
 *   node scripts/release-audit.js --dir dist/staging
 *   node scripts/release-audit.js --dir dist/staging --json
 *   node scripts/release-audit.js --list          # manifest payload listing
 */

const fs = require('fs');
const path = require('path');
const manifest = require('./release-manifest.js');

/* ── Secret / privacy rules ─────────────────────────────────────────────
   Keep this list aligned with the redaction rules already used at runtime
   (local-services-runner.js redact(), error-catalog.js). Do not invent a
   second vocabulary — extend this one. */

const SECRET_RULES = [
  { id: 'openai-key', severity: 'error', why: 'OpenAI 风格密钥', re: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
  { id: 'anthropic-key', severity: 'error', why: 'Anthropic 风格密钥', re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { id: 'google-key', severity: 'error', why: 'Google API 密钥', re: /\bAIza[0-9A-Za-z_-]{30,}\b/g },
  { id: 'aws-key', severity: 'error', why: 'AWS Access Key', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { id: 'github-token', severity: 'error', why: 'GitHub Token', re: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g },
  { id: 'slack-token', severity: 'error', why: 'Slack Token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { id: 'jwt', severity: 'error', why: 'JWT', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  { id: 'private-key', severity: 'error', why: '私钥文件内容', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  { id: 'bearer', severity: 'error', why: 'Bearer 凭据', re: /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/g },
  { id: 'assigned-secret', severity: 'error', why: '赋值形式的密钥', re: /\b(?:api[_-]?key|apikey|access[_-]?token|auth[_-]?token|client[_-]?secret|secret|password|passwd)\b\s*[:=]\s*["'`][^"'`\s]{12,}["'`]/gi },
  { id: 'demo-secret', severity: 'error', why: '演示占位密钥', re: /\bsk-demo-[A-Za-z0-9-]+/g },
  { id: 'dev-path-win', severity: 'error', why: '开发者 Windows 用户路径', re: /\b[A-Za-z]:\\Users\\[A-Za-z0-9._-]+/g },
  { id: 'dev-path-repo', severity: 'error', why: '开发者仓库路径', re: /[A-Za-z]:\\InternalBeyond-main\b/gi },
  { id: 'email', severity: 'warn', why: '邮箱地址', re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  { id: 'phone-cn', severity: 'warn', why: '中国大陆手机号', re: /\b1[3-9]\d{9}\b/g }
];

/* Raw byte markers, scanned in every file (text or binary) as ASCII and
   UTF-16LE, because screenshots / executables can embed strings that a text
   scan never sees. `requireValue` avoids failing on documentation that merely
   names a prefix (e.g. a README sentence about `sk-demo-…`). */
const BINARY_MARKERS = [
  { id: 'dev-path-win', severity: 'error', text: 'c:\\users\\', why: '开发者 Windows 用户路径' },
  { id: 'dev-path-repo', severity: 'error', text: 'e:\\internalbeyond-main', why: '开发者仓库路径' },
  { id: 'demo-secret', severity: 'error', text: 'sk-demo-', requireValue: 4, why: '演示占位密钥' },
  { id: 'private-key', severity: 'error', text: 'begin private key', why: '私钥文件内容' }
];

/* Files above this size are only scanned case-sensitively for the exact marker
   spellings (avoids materialising a 90 MB lowercase string for node.exe, which
   is verified by SHA-256 against nodejs.org instead). */
const BIG_FILE_BYTES = 16 * 1024 * 1024;

function mask(sample) {
  const s = String(sample);
  if (s.length <= 8) return '***';
  return s.slice(0, 4) + '***' + s.slice(-2);
}

function lineOf(text, index) {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

function scanText(rel, text, findings) {
  for (const rule of SECRET_RULES) {
    rule.re.lastIndex = 0;
    let m;
    while ((m = rule.re.exec(text)) !== null) {
      findings.push({
        path: rel, rule: rule.id, severity: rule.severity, why: rule.why,
        line: lineOf(text, m.index), excerpt: mask(m[0])
      });
      if (m.index === rule.re.lastIndex) rule.re.lastIndex++;
      if (findings.length > 500) return findings;
    }
  }
  return findings;
}

/* True when the bytes right after a marker look like an actual value (used so
   documentation that merely names a prefix is not reported as a secret). */
function markerHasValue(buf, index, marker, wide) {
  const need = Number(marker.requireValue) || 0;
  if (!need) return true;
  const step = wide ? 2 : 1;
  const start = index + marker.text.length * step;
  for (let i = 0; i < need; i++) {
    const b = buf[start + i * step];
    if (b == null) return false;
    const alnum = (b >= 48 && b <= 57) || (b >= 65 && b <= 90) || (b >= 97 && b <= 122) || b === 45 || b === 95;
    if (!alnum) return false;
    if (wide && buf[start + i * step + 1] !== 0) return false;
  }
  return true;
}

/* Case variants that matter for Windows paths / mixed-case tokens. */
function caseVariants(text) {
  const out = [text];
  const upper = text.toUpperCase();
  if (out.indexOf(upper) < 0) out.push(upper);
  const title = text.replace(/(^|[\\/\s])([a-z])/g, function (m, p, c) { return p + c.toUpperCase(); });
  if (out.indexOf(title) < 0) out.push(title);
  return out;
}

function scanMarkers(rel, buf, findings) {
  const big = buf.length > BIG_FILE_BYTES;
  const hay = big ? null : buf.toString('latin1').toLowerCase();
  for (const marker of BINARY_MARKERS) {
    let hit = false;
    const variants = caseVariants(marker.text);
    if (hay) {
      let at = hay.indexOf(marker.text);
      while (at >= 0 && !hit) {
        if (markerHasValue(buf, at, marker, false)) hit = true;
        at = hit ? -1 : hay.indexOf(marker.text, at + 1);
      }
    } else {
      /* Case-sensitive fallbacks for very large files. */
      for (const v of variants) {
        const at = buf.indexOf(Buffer.from(v, 'latin1'));
        if (at >= 0 && markerHasValue(buf, at, marker, false)) { hit = true; break; }
      }
    }
    if (!hit) {
      /* UTF-16LE spelling (common in Windows binaries / metadata). */
      for (const v of variants) {
        const wide = Buffer.from(v, 'utf16le');
        let at = buf.indexOf(wide);
        while (at >= 0 && !hit) {
          if (markerHasValue(buf, at, marker, true)) hit = true;
          at = hit ? -1 : buf.indexOf(wide, at + 2);
        }
        if (hit) break;
      }
    }
    if (hit) findings.push({ path: rel, rule: marker.id, severity: marker.severity, why: marker.why + '（二进制标记）', line: 0, excerpt: mask(marker.text) });
  }
  return findings;
}

/* ── Directory audit ─────────────────────────────────────────────────── */

function scanDirectory(dir, opts) {
  const o = opts || {};
  const root = path.resolve(String(dir || ''));
  const ignore = (o.ignore || []).map(function (re) { return re instanceof RegExp ? re : new RegExp(String(re)); });
  const content = manifest.auditDirectory(root);
  const findings = [];
  let scannedText = 0;
  let scannedBinary = 0;
  const files = content.files.filter(function (f) { return !ignore.some(function (re) { return re.test(f.path); }); });

  for (const f of files) {
    const abs = path.join(root, f.path);
    let buf = null;
    try { buf = fs.readFileSync(abs); } catch (e) {
      findings.push({ path: f.path, rule: 'unreadable', severity: 'error', why: '文件无法读取', line: 0, excerpt: String(e && e.code || e) });
      continue;
    }
    if (manifest.isTextFile(f.path)) {
      scanText(f.path, buf.toString('utf8'), findings);
      scannedText++;
    }
    scanMarkers(f.path, buf, findings);
    scannedBinary++;
  }

  const errors = findings.filter(x => x.severity === 'error');
  const warnings = findings.filter(x => x.severity === 'warn');
  return {
    ok: errors.length === 0 && content.violations.length === 0,
    dir: root,
    fileCount: content.count,
    totalBytes: content.totalBytes,
    scannedText: scannedText,
    scannedBinary: scannedBinary,
    ignored: content.files.length - files.length,
    violations: content.violations,
    findings: findings,
    errors: errors.length,
    warnings: warnings.length
  };
}

function formatReport(report) {
  const lines = [];
  lines.push('[release-audit] dir: ' + report.dir);
  lines.push('[release-audit] files: ' + report.fileCount + ' · bytes: ' + report.totalBytes +
    ' · text scanned: ' + report.scannedText + ' · all files marker-scanned: ' + report.scannedBinary);
  if (report.violations.length) {
    lines.push('[release-audit] CONTENT VIOLATIONS (' + report.violations.length + '):');
    report.violations.forEach(v => lines.push('  ✗ ' + v.path + ' — ' + v.why));
  }
  if (report.findings.length) {
    lines.push('[release-audit] FINDINGS (' + report.errors + ' error / ' + report.warnings + ' warn):');
    report.findings.slice(0, 80).forEach(f => {
      lines.push('  ' + (f.severity === 'error' ? '✗' : '!') + ' [' + f.rule + '] ' + f.path +
        (f.line ? ':' + f.line : '') + ' — ' + f.excerpt);
    });
  }
  lines.push('[release-audit] ' + (report.ok ? 'PASS' : 'FAIL'));
  return lines.join('\n');
}

module.exports = {
  SECRET_RULES: SECRET_RULES,
  BINARY_MARKERS: BINARY_MARKERS,
  scanText: scanText,
  scanMarkers: scanMarkers,
  scanDirectory: scanDirectory,
  formatReport: formatReport,
  mask: mask
};

if (require.main === module) {
  const argv = process.argv.slice(2);
  const get = function (name) { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : ''; };
  if (argv.indexOf('--list') >= 0) {
    const r = manifest.resolve({});
    r.files.forEach(f => process.stdout.write(String(f.bytes).padStart(10) + '  ' + f.to + '\n'));
    process.stdout.write('[release-audit] ' + r.count + ' files · ' + r.totalBytes + ' bytes\n');
    process.exitCode = r.ok ? 0 : 1;
  } else {
    const dir = get('--dir') || path.join(manifest.ROOT, 'dist', 'staging');
    const report = scanDirectory(dir);
    if (argv.indexOf('--json') >= 0) process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    else process.stdout.write(formatReport(report) + '\n');
    process.exitCode = report.ok ? 0 : 1;
  }
}
