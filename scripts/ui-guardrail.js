'use strict';

/*
 * UI guardrail — visual KPI + structure-test baseline for the IB visual migration (P0).
 *
 * Usage:
 *   node scripts/ui-guardrail.js check    # fail if any metric regresses or a new structure failure appears
 *   node scripts/ui-guardrail.js update   # re-freeze the baseline (run only after accepted, reviewed changes)
 *
 * The baseline whitelist exists because the repository already carries historical failures
 * (see docs/reports/UI-VISUAL-MIGRATION-AUDIT.md §8.2). New failures must stay at zero;
 * resolved failures show up as improvements.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const BASELINE_FILE = path.join(__dirname, 'ui-guardrail-baseline.json');

const VIOLET = /#a855f7|#8b5cf6|#7c3aed|#6366f1|#667eea|#764ba2|#4f46e5|#818cf8|rgba\(120,\s*140,\s*255|rgba\(168,\s*85,\s*247/gi;

const METRICS = {
  gradient: /gradient/g,
  backdropFilter: /backdrop-filter:/g,
  bgRgba: /background:\s*rgba\(/g,
  bgHex: /background:\s*#/g,
  smallFont: /font-size:\s*(?:0?\.(?:[0-6]\d?|7[0-3]?)rem|(?:\d(?:\.\d+)?|1[01](?:\.\d+)?)px)/g,
  bigRadius: /border-radius:\s*(?:2[0-9]|[3-9]\d|\d{3,})px/g,
  important: /!important/g,
  rawHex: /#[0-9a-fA-F]{3,8}\b/g,
  violet: VIOLET
};

function listFiles(dir, ext) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full, ext));
    else if (entry.name.endsWith(ext)) out.push(full);
  }
  return out;
}

function count(text, re) {
  return (text.match(re) || []).length;
}

function scanCss() {
  const files = {};
  const totals = {};
  for (const key of Object.keys(METRICS)) totals[key] = 0;
  for (const file of listFiles(path.join(ROOT, 'assets', 'css'), '.css')) {
    const text = fs.readFileSync(file, 'utf8');
    const rel = path.relative(ROOT, file).split(path.sep).join('/');
    const row = {};
    for (const [key, re] of Object.entries(METRICS)) {
      const value = count(text, re);
      row[key] = value;
      totals[key] += value;
    }
    files[rel] = row;
  }
  return { files, totals };
}

function countStyleAttrs(text) {
  return count(text, /\bstyle\s*=/g);
}

function scanInline() {
  const html = fs.readFileSync(path.join(ROOT, 'InternalBeyond.html'), 'utf8');
  const staticStyles = countStyleAttrs(html);
  let total = staticStyles;
  for (const dir of ['assets/js', 'game']) {
    for (const file of listFiles(path.join(ROOT, dir), '.js')) {
      total += countStyleAttrs(fs.readFileSync(file, 'utf8'));
    }
  }
  return { static: staticStyles, total };
}

function runStructure() {
  const result = spawnSync(process.execPath, ['tests/test_frontend_structure.js'], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024
  });
  const output = (result.stdout || '') + (result.stderr || '');
  const fails = [];
  for (const match of output.matchAll(/^\s+FAIL\s+(\S+)/gm)) fails.push(match[1]);
  return { exitCode: result.status, fails: Array.from(new Set(fails)).sort() };
}

function compute() {
  return {
    structure: runStructure(),
    kpi: scanCss(),
    inline: scanInline()
  };
}

function loadBaseline() {
  if (!fs.existsSync(BASELINE_FILE)) return null;
  return JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8'));
}

function fmtDelta(current, base) {
  return current > base ? '+' + (current - base) : String(current - base);
}

function check() {
  const baseline = loadBaseline();
  if (!baseline) {
    console.error('No baseline found. Run: node scripts/ui-guardrail.js update');
    process.exit(1);
  }
  const current = compute();
  const regressions = [];
  const improvements = [];

  const known = new Set(baseline.structure.knownFailures);
  for (const name of current.structure.fails) {
    if (!known.has(name)) regressions.push('structure NEW FAIL: ' + name);
  }
  for (const name of baseline.structure.knownFailures) {
    if (!current.structure.fails.includes(name)) improvements.push('structure resolved: ' + name);
  }

  const baseFileNames = new Set(Object.keys(baseline.kpi.files));
  for (const [file, row] of Object.entries(current.kpi.files)) {
    if (!baseFileNames.has(file)) {
      for (const [key, value] of Object.entries(row)) {
        if (value > 0) regressions.push('kpi NEW FILE ' + file + ' ' + key + '=' + value);
      }
      continue;
    }
    const baseRow = baseline.kpi.files[file];
    for (const [key, value] of Object.entries(row)) {
      const baseValue = baseRow[key] || 0;
      if (value > baseValue) regressions.push('kpi ' + file + ' ' + key + ' ' + baseValue + ' -> ' + value);
      else if (value < baseValue) improvements.push('kpi ' + file + ' ' + key + ' ' + baseValue + ' -> ' + value);
    }
  }

  for (const [key, value] of Object.entries(current.kpi.totals)) {
    const baseValue = baseline.kpi.totals[key] || 0;
    if (value > baseValue) regressions.push('kpi TOTAL ' + key + ' ' + baseValue + ' -> ' + value);
    else if (value < baseValue) improvements.push('kpi TOTAL ' + key + ' ' + baseValue + ' -> ' + value);
  }
  for (const key of ['static', 'total']) {
    if (current.inline[key] > baseline.inline[key]) {
      regressions.push('inline.' + key + ' ' + baseline.inline[key] + ' -> ' + current.inline[key]);
    } else if (current.inline[key] < baseline.inline[key]) {
      improvements.push('inline.' + key + ' ' + baseline.inline[key] + ' -> ' + current.inline[key]);
    }
  }

  console.log('UI guardrail check');
  console.log('  structure: ' + current.structure.fails.length + ' known failure(s), baseline ' + baseline.structure.knownFailures.length);
  console.log('  inline styles: static ' + current.inline.static + ' / total ' + current.inline.total);
  console.log('  css totals: ' + Object.entries(current.kpi.totals).map(([k, v]) => k + '=' + v).join(' '));
  if (improvements.length) {
    console.log('  improvements vs baseline:');
    for (const line of improvements) console.log('    - ' + line);
  }
  if (regressions.length) {
    console.error('  REGRESSIONS (' + regressions.length + '):');
    for (const line of regressions) console.error('    ! ' + line);
    console.error('UI guardrail FAILED');
    process.exit(1);
  }
  console.log('UI guardrail OK (no regressions)');
}

function update() {
  const current = compute();
  const baseline = {
    generatedAt: new Date().toISOString(),
    note: 'Frozen by scripts/ui-guardrail.js update. Known failures are historical debt (UI-VISUAL-MIGRATION-AUDIT.md §8.2); never add new ones.',
    structure: { knownFailures: current.structure.fails },
    kpi: current.kpi,
    inline: current.inline
  };
  const sortedFiles = {};
  for (const key of Object.keys(baseline.kpi.files).sort()) sortedFiles[key] = baseline.kpi.files[key];
  baseline.kpi.files = sortedFiles;
  fs.writeFileSync(BASELINE_FILE, JSON.stringify(baseline, null, 2) + '\n', 'utf8');
  console.log('Baseline updated:', path.relative(ROOT, BASELINE_FILE));
  console.log('  structure failures frozen: ' + current.structure.fails.length);
  console.log('  inline styles: static ' + current.inline.static + ' / total ' + current.inline.total);
  console.log('  css totals: ' + Object.entries(current.kpi.totals).map(([k, v]) => k + '=' + v).join(' '));
}

const command = process.argv[2] || 'check';
if (command === 'update') update();
else if (command === 'check') check();
else {
  console.error('Usage: node scripts/ui-guardrail.js [check|update]');
  process.exit(2);
}
