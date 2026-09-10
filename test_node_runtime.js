'use strict';

/* P1 · Bundled Node Runtime regression (Node, zero browser, zero deps).
   Covers:
     - runtime/node metadata: VERSION / SHA256SUMS / LICENSE / README
     - bundled node.exe (when present) is byte-exact per SHA256SUMS and runs at the pinned version
     - LICENSES/THIRD-PARTY-NODE.md records provenance + hash
     - scripts/update-node-runtime.ps1 pins a version and verifies the official checksum
     - 启动 InternalBeyond.vbs resolves IB_NODE -> bundled -> PATH and stays GBK/LF/no-BOM
     - Start Internal Beyond.cmd prefers bundled over PATH
     - no-regression guards: P1 must NOT refactor the process.execPath spawn mechanism
       in local-services-runner.js, and launcher child spawns must stay hidden

   node.exe is gitignored (88 MiB binary), so a fresh clone legitimately lacks it;
   the binary-dependent checks then report SKIP instead of failing. */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ROOT = __dirname;
const RUNTIME = path.join(ROOT, 'runtime', 'node');
const NODE_EXE = path.join(RUNTIME, 'node.exe');
const VERSION_FILE = path.join(RUNTIME, 'VERSION');
const SUMS_FILE = path.join(RUNTIME, 'SHA256SUMS');
const LICENSE_FILE = path.join(RUNTIME, 'LICENSE');
const README_FILE = path.join(RUNTIME, 'README.md');
const THIRD_PARTY = path.join(ROOT, 'LICENSES', 'THIRD-PARTY-NODE.md');
const UPDATE_PS1 = path.join(ROOT, 'scripts', 'update-node-runtime.ps1');
const VBS = path.join(ROOT, '启动 InternalBeyond.vbs');
const CMD = path.join(ROOT, 'scripts', 'windows', 'Start Internal Beyond.cmd');
const RUNNER = path.join(ROOT, 'runtime', 'local-services-runner.js');
const LAUNCHER = path.join(ROOT, 'runtime', 'launch-internal-beyond.js');

let pass = 0, fail = 0, skip = 0;
function check(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + ' — ' + (e && e.message || e)); }
}
function skipped(name, why) { skip++; console.log('  – ' + name + ' (SKIP: ' + why + ')'); }
function read(file) { return fs.readFileSync(file, 'utf8'); }
function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

console.log('Bundled Node Runtime regression (P1)\n');

/* ── 1. 元数据文件 ── */
console.log('[1] runtime/node metadata');

check('VERSION exists and is a precise 24.x patch', () => {
  assert.ok(fs.existsSync(VERSION_FILE), 'runtime/node/VERSION missing');
  const v = read(VERSION_FILE).trim();
  assert.match(v, /^\d+\.\d+\.\d+$/, 'VERSION must be exact x.y.z, got: ' + JSON.stringify(v));
  assert.ok(v.startsWith('24.'), 'P1 pins Node 24 LTS, got ' + v);
  assert.strictEqual(read(VERSION_FILE), v, 'VERSION must be a single line with no trailing newline');
});

check('SHA256SUMS exists, is sha256sum-parseable and covers node.exe', () => {
  assert.ok(fs.existsSync(SUMS_FILE), 'runtime/node/SHA256SUMS missing');
  const line = read(SUMS_FILE).trim();
  const m = line.match(/^([0-9a-f]{64})\s+\*?(node\.exe)$/i);
  assert.ok(m, 'SHA256SUMS must be "<64 hex> *node.exe", got: ' + JSON.stringify(line));
});

check('LICENSE present and is the upstream Node license', () => {
  assert.ok(fs.existsSync(LICENSE_FILE), 'runtime/node/LICENSE missing');
  const lic = read(LICENSE_FILE);
  assert.ok(lic.length > 5000, 'license looks truncated: ' + lic.length + ' bytes');
  assert.ok(/Node\.js is licensed for use as follows/i.test(lic), 'missing upstream license header');
  assert.ok(/MIT/i.test(lic) || /Permission is hereby granted/i.test(lic), 'missing MIT grant text');
});

check('runtime README documents provenance and update flow', () => {
  assert.ok(fs.existsSync(README_FILE), 'runtime/node/README.md missing');
  const md = read(README_FILE);
  const v = read(VERSION_FILE).trim();
  assert.ok(md.includes(v), 'README must state the pinned version ' + v);
  assert.ok(/nodejs\.org\/dist\/v/.test(md), 'README must record the upstream URL');
  assert.ok(/IB_NODE/.test(md) && /PATH/.test(md), 'README must document resolution order');
  assert.ok(/scripts\/update-node-runtime\.ps1/.test(md), 'README must document the update script');
});

check('LICENSES/THIRD-PARTY-NODE.md records version + hash', () => {
  assert.ok(fs.existsSync(THIRD_PARTY), 'LICENSES/THIRD-PARTY-NODE.md missing');
  const md = read(THIRD_PARTY);
  const v = read(VERSION_FILE).trim();
  const hash = read(SUMS_FILE).trim().split(/\s+/)[0].toLowerCase();
  assert.ok(md.includes(v), 'third-party notice must state version ' + v);
  assert.ok(md.toLowerCase().includes(hash), 'third-party notice must record SHA-256 ' + hash);
  assert.ok(/MIT/.test(md), 'third-party notice must state the license');
});

check('update script pins version and verifies official checksum', () => {
  assert.ok(fs.existsSync(UPDATE_PS1), 'scripts/update-node-runtime.ps1 missing');
  const ps = read(UPDATE_PS1);
  assert.ok(/SHASUMS256\.txt/.test(ps), 'must download the official SHASUMS256.txt');
  assert.ok(/Get-FileHash[\s\S]*SHA256/i.test(ps), 'must compute SHA-256');
  assert.ok(/Fail /.test(ps), 'must fail loudly');
  assert.ok(/runtime\\node|RuntimeDir/.test(ps), 'must target runtime/node');
  assert.ok(/Tls12/.test(ps), 'must force TLS 1.2 for Windows PowerShell 5.1');
});

/* ── 2. 内置 node.exe（可选：gitignore，全新克隆可缺）── */
console.log('\n[2] bundled node.exe');

if (!fs.existsSync(NODE_EXE)) {
  skipped('node.exe hash matches SHA256SUMS', 'node.exe not present (gitignored; run scripts/update-node-runtime.ps1)');
  skipped('node.exe runs at pinned version', 'node.exe not present');
} else {
  check('node.exe hash matches SHA256SUMS', () => {
    const expected = read(SUMS_FILE).trim().split(/\s+/)[0].toLowerCase();
    const actual = sha256(NODE_EXE).toLowerCase();
    assert.strictEqual(actual, expected, 'SHA-256 mismatch — runtime was replaced or corrupted');
  });

  check('node.exe runs and reports the pinned version', () => {
    const out = execFileSync(NODE_EXE, ['--version'], { encoding: 'utf8', timeout: 30000 }).trim();
    assert.strictEqual(out, 'v' + read(VERSION_FILE).trim());
  });

  check('node.exe provides fetch (Node 18+ contract)', () => {
    const out = execFileSync(NODE_EXE, ['-e', 'process.stdout.write(typeof fetch)'], { encoding: 'utf8', timeout: 30000 }).trim();
    assert.strictEqual(out, 'function');
  });
}

/* ── 3. 启动入口解析顺序 ── */
console.log('\n[3] launcher entry points');

check('启动 InternalBeyond.vbs is GBK/ANSI with LF endings and no BOM', () => {
  assert.ok(fs.existsSync(VBS), '启动 InternalBeyond.vbs missing');
  const b = fs.readFileSync(VBS);
  assert.ok(!(b[0] === 0xEF && b[1] === 0xBB && b[2] === 0xBF), 'must not have a UTF-8 BOM (VBScript reads ANSI)');
  assert.ok(b.includes(0x0A), 'must contain LF');
  assert.strictEqual(b.toString('latin1').split('\n').filter(l => l.endsWith('\r')).length, 0, 'must not use CRLF');
  assert.ok(b.some(byte => byte > 0x7F), 'Chinese text must be encoded (GBK), not stripped');
  const isValidUtf8 = Buffer.from(b.toString('utf8'), 'utf8').equals(b);
  assert.ok(!isValidUtf8, 'must be ANSI/GBK, not UTF-8 — VBScript would misread UTF-8 Chinese');
});

check('vbs resolves IB_NODE -> bundled runtime -> PATH in that order', () => {
  const vbs = fs.readFileSync(VBS, 'latin1');
  /* 用只出现在代码分支里的赋值标记，避免命中文件头注释。 */
  const iIbNode = vbs.indexOf('nodeSrc = "IB_NODE"');
  const iBundled = vbs.indexOf('nodeSrc = "bundled"');
  const iPath = vbs.indexOf('nodeSrc = "PATH"');
  assert.ok(iIbNode > -1, 'IB_NODE resolution branch missing');
  assert.ok(iBundled > -1, 'bundled runtime resolution branch missing');
  assert.ok(iPath > -1, 'PATH fallback branch missing');
  assert.ok(iIbNode < iBundled, 'IB_NODE must be tried before bundled runtime');
  assert.ok(iBundled < iPath, 'bundled runtime must be tried before PATH fallback');
  assert.ok(/where node\.exe/.test(vbs), 'PATH fallback must probe node.exe');
});

check('vbs validates version and fails loudly instead of falling back', () => {
  const vbs = fs.readFileSync(VBS, 'latin1');
  assert.ok(/MajorOf\(ByVal ver\)/.test(vbs), 'MajorOf must take ByVal (VBScript args default ByRef)');
  assert.ok(/nodeMajor < 18/.test(vbs), 'must enforce the Node 18 floor');
  assert.ok(/bundled node\.exe failed to run/.test(vbs), 'must detect a corrupt bundled runtime');
  assert.ok(/NodeVersion/.test(vbs), 'must probe the runtime by running it');
  /* 损坏的内置运行时必须直接报错，绝不能回落到 PATH。 */
  const step4 = vbs.slice(vbs.indexOf('nodeVer = NodeVersion(nodeExe)'), vbs.indexOf('winStyle = 0'));
  assert.ok(/bundled node\.exe failed to run/.test(step4), 'step 4 must still catch a bundled runtime that will not run');
  assert.ok(!/where node\.exe/.test(step4), 'corrupt bundled runtime must not fall back to PATH');
});

check('vbs preflights the runtime binary before Windows ever loads it', () => {
  const vbs = fs.readFileSync(VBS, 'latin1');
  /* 把损坏的 node.exe 交给系统加载器，Windows 会自己弹出「不支持的 16 位应用
     程序」系统错误框——普通用户看不懂，也没法自助恢复。必须在执行前自检。 */
  assert.ok(/Function RuntimeLooksValid\(exePath, ByRef why\)/.test(vbs), 'binary preflight helper missing');
  assert.ok(/sz < 1048576/.test(vbs), 'must reject a truncated runtime by size');
  assert.ok(/head = "MZ"/.test(vbs), 'must check the PE header of the runtime');
  assert.ok(/If Not RuntimeLooksValid\(nodeExe, preflightWhy\) Then/.test(vbs), 'preflight must run on the resolved runtime');
  const iPreflight = vbs.indexOf('If Not RuntimeLooksValid(nodeExe, preflightWhy) Then');
  const iRun = vbs.indexOf('nodeVer = NodeVersion(nodeExe)');
  assert.ok(iPreflight > -1 && iRun > -1 && iPreflight < iRun, 'preflight must happen BEFORE the runtime is executed');
  /* 预检分支本身绝不能回落到 PATH。 */
  const preflightBranch = vbs.slice(iPreflight, iRun);
  assert.ok(!/where node\.exe/.test(preflightBranch), 'a runtime rejected by preflight must not fall back to PATH');
  assert.ok(/Function WhereNodeExe\(\)/.test(vbs), 'PATH fallback must resolve an absolute path so it can be preflighted');
});

check('vbs keeps hidden window launch and passes --debug through', () => {
  const vbs = fs.readFileSync(VBS, 'latin1');
  assert.ok(/winStyle = 0/.test(vbs), 'must default to a hidden window');
  assert.ok(/--debug/.test(vbs), 'must keep the --debug visible mode');
  assert.ok(/launch-internal-beyond\.js/.test(vbs), 'must delegate to launch-internal-beyond.js');
});

check('Start Internal Beyond.cmd prefers bundled runtime over PATH', () => {
  const cmd = read(CMD);
  const iBundled = cmd.indexOf('runtime\\node\\node.exe');
  const iWhere = cmd.indexOf('where node.exe');
  assert.ok(iBundled > -1, 'cmd must resolve the bundled runtime');
  assert.ok(iWhere > -1, 'cmd must keep the PATH fallback');
  assert.ok(iBundled < iWhere, 'cmd must try the bundled runtime before PATH');
  assert.ok(/IB_NODE/.test(cmd), 'cmd must honour IB_NODE');
});

/* ── 4. 无回归护栏：P1 不得重构 spawn 机制 ── */
console.log('\n[4] no-regression guards');

check('runner still spawns services via process.execPath (not refactored)', () => {
  const src = read(RUNNER);
  assert.ok(/command:\s*process\.execPath/.test(src),
    'SERVICES[].command must remain process.execPath so children inherit the bundled runtime');
  assert.ok(/windowsHide:\s*true/.test(src), 'runner child spawns must stay hidden');
  assert.ok(/stdio:\s*\['ignore',\s*'pipe',\s*'pipe'\]/.test(src), 'runner stdio contract must be unchanged');
});

check('launcher still spawns children hidden via process.execPath', () => {
  const src = read(LAUNCHER);
  assert.ok(/spawn\(process\.execPath/.test(src), 'launcher must keep spawning with process.execPath');
  assert.ok(/windowsHide:\s*true/.test(src), 'launcher child spawns must stay hidden');
});

check('.gitignore excludes the 88 MiB runtime binary but not its metadata', () => {
  const gi = fs.readFileSync(path.join(ROOT, '.gitignore'), 'latin1');
  assert.ok(/^runtime\/node\/node\.exe\s*$/m.test(gi), 'node.exe must be gitignored');
  assert.ok(!/^runtime\/node\/?\s*$/m.test(gi), 'runtime/node metadata must stay tracked');
});

console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败, ' + skip + ' 跳过');
process.exit(fail ? 1 : 0);
