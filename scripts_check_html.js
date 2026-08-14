/* 检查 HTML 中的内联脚本和本地外部脚本（不执行）。 */
'use strict';
const fs = require('fs');
const { execFileSync } = require('child_process');
const os = require('os');
const path = require('path');

const html = fs.readFileSync(process.argv[2] || 'InternalBeyond.html', 'utf8');
const htmlPath = path.resolve(process.argv[2] || 'InternalBeyond.html');
const htmlDir = path.dirname(htmlPath);
const re = /<script(?<attrs>[^>]*)>(?<body>[\s\S]*?)<\/script>/gi;
let m, idx = 0, failed = 0, checked = 0, skippedRemote = 0;
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-syntax-'));
while ((m = re.exec(html)) !== null) {
  const attrs = m.groups.attrs || '';
  const srcMatch = attrs.match(/\bsrc\s*=\s*["']([^"']+)["']/i);
  let code = m.groups.body || '';
  let label = `inline script #${idx + 1}`;
  if (srcMatch) {
    const src = srcMatch[1];
    if (/^(?:https?:)?\/\//i.test(src)) {
      skippedRemote++;
      continue;
    }
    const file = path.resolve(htmlDir, src.replace(/[?#].*$/, ''));
    if (!fs.existsSync(file)) {
      failed++;
      console.error(`MISSING LOCAL SCRIPT: ${src}`);
      continue;
    }
    code = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    label = path.relative(process.cwd(), file);
  }
  if (!code.trim()) continue;
  idx++;
  const file = path.join(tmpDir, `script_${idx}.js`);
  fs.writeFileSync(file, code, 'utf8');
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
    checked++;
  } catch (e) {
    failed++;
    const out = String(e.stdout || '') + String(e.stderr || '');
    console.error(`${label} SYNTAX ERROR:\n${out.split('\n').slice(0, 15).join('\n')}`);
  }
}
fs.rmSync(tmpDir, { recursive: true, force: true });
console.log(`checked ${checked} local scripts, ${failed} failed, ${skippedRemote} remote skipped`);
process.exit(failed ? 1 : 0);
