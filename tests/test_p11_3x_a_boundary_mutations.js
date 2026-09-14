/* ====================================================================
   P11-3X-A · Mutation / falsification（Security / HTTP Boundary）
   --------------------------------------------------------------------
   本文件回答的问题：**上面那些边界是被判据钉住的，还是只是注释？**

   做法与 P11-3D / P11-3D.1 的 mutation 一致：对生产源码做一次**故意的行为破坏**
   （不是制造语法错误），然后跑真实测试；每个破坏都必须让某一条判据明确变红。

   变异目标是本阶段审计出的**承重边界**：
     · Origin 授权闸门（Bridge）
     · 匿名 token 线（Bridge 的 /status 与整条通用鉴权）
     · proxy 协议策略
     · memory viewer 的 fail closed（list 与 changes 两条）
     · 凭据铸造闸门（Home Node）
     · Active companion 的 Origin 闸门（debug/traces 面）
     · 错误响应脱敏

   跑不动的变异（锚点找不到 / 不唯一）一律 **UNEXPECTED**：锚点漂移必须被看见。

   ── 安全性质 ────────────────────────────────────────────────────────
   每个变异只在内存里改写文本、写回原文件，随后**按原始字节还原**并校验 SHA-256；
   工作树在结束时必须与开始时逐字节相同（含 BOM 与行尾）。任何退出路径都还原。
   ==================================================================== */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const FILES = {
  routes: 'bridge/routes.js',
  bridge: 'services/ib-bridge-service.js',
  gateway: 'services/home-node/mobile-gateway.js',
  hnhttp: 'services/home-node/http.js',
  activehttp: 'active/http.js'
};
const sha = buf => crypto.createHash('sha256').update(buf).digest('hex');
const orig = {};
for (const k in FILES) { const p = path.join(ROOT, FILES[k]); orig[k] = { p, bytes: fs.readFileSync(p) }; }

const SUITE = 'tests/test_p11_3x_a_security_http_boundary.js';
const runSuite = sections => {
  try {
    const out = execFileSync(process.execPath, [path.join(ROOT, SUITE)], {
      cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      env: Object.assign({}, process.env, { P11_3X_A_SECTIONS: sections }),
      timeout: 300000
    });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status == null ? -1 : e.status, out: String(e.stdout || '') + String(e.stderr || '') };
  }
};

const MUTATIONS = [
  { id: 'M1', file: 'routes', sections: 'A,C',
    label: 'Origin 授权闸门被摘掉（回到"照做但让你读不到"的 CORS-only 语义）',
    from: "    if (String(req.headers.origin || '').trim() && !res._reqOrigin) {",
    to: "    if (false) {" },

  { id: 'M2', file: 'routes', sections: 'A',
    label: '通用 token 线恒放行（/status 与全部业务端点在 LAN 模式下匿名可达）',
    from: "    if (!httpAuthorized(req, q)) { authRequiredResponse(res); return; }\n\n    if (req.method === 'GET' && pathname === '/status') {",
    to: "    if (false) { authRequiredResponse(res); return; }\n\n    if (req.method === 'GET' && pathname === '/status') {" },

  { id: 'M3', file: 'routes', sections: 'C',
    label: 'proxy 协议策略恒放行（file: / ftp: / gopher: 目标不再被拒）',
    from: "    if (tu.protocol !== 'https:' && tu.protocol !== 'http:') {",
    to: "    if (false) {" },

  { id: 'M4', file: 'gateway', sections: 'E',
    label: 'memory/list 的 viewer 存在性判定失效（`?viewer=` 退回完整镜像，含 private）',
    from: "      if (viewerPresent) {\n        page = memoryStore.listVisible(",
    to: "      if (false) {\n        page = memoryStore.listVisible(" },

  { id: 'M5', file: 'gateway', sections: 'E',
    label: 'memory/changes 的 viewer 存在性判定失效（`?viewer=` 退回含 private 的完整变更流）',
    from: "      const page = viewerPresent\n        ? memoryStore.changesVisibleAfter(",
    to: "      const page = false\n        ? memoryStore.changesVisibleAfter(" },

  { id: 'M6', file: 'hnhttp', sections: 'A',
    label: '凭据铸造闸门被摘掉（未配置桌面 token 时也能签发配对凭据）',
    from: "  function credentialMintingBlocked(path) {\n    if (token) return false;",
    to: "  function credentialMintingBlocked(path) {\n    if (true) return false;" },

  { id: 'M7', file: 'activehttp', sections: 'D',
    label: 'Active companion 的 Origin 闸门被摘掉（任意网站可读 proactive traces/debug）',
    from: "      if (!applyCors(request, response)) {",
    to: "      if (false) {" },

  { id: 'M8', file: 'bridge', sections: 'F',
    label: '错误脱敏被移除：顶层 500 把 e.stack 直接回给客户端',
    from: "    try { sendJsonRes(res, 500, { ok: false, error: String(e && e.message || e) }); } catch (e2) { /* 忽略 */ }",
    to: "    try { sendJsonRes(res, 500, { ok: false, error: String(e && e.stack || e) }); } catch (e2) { /* 忽略 */ }" },

  { id: 'M9', file: 'hnhttp', sections: 'A',
    label: 'Home Node 桌面面的 Origin 授权闸门被摘掉（外来 Origin 的简单请求又能盲写状态）',
    from: "    if (rawOrigin && rawOrigin !== 'null' && path.indexOf('/mobile/') !== 0 && !originAllowed(rawOrigin)) {",
    to: "    if (false) {" }
];

let unexpected = 0;
const restore = () => { for (const k in orig) fs.writeFileSync(orig[k].p, orig[k].bytes); };

try {
  console.log('\u2500\u2500 baseline（未变异时必须全绿）\u2500\u2500');
  const base = runSuite('');
  const green = base.code === 0;
  if (!green) unexpected++;
  console.log('  ' + (green ? 'GREEN' : 'RED  ') + '  ' + SUITE + (green ? '' : '  *** UNEXPECTED ***'));
  if (!green) console.log(base.out.split('\n').filter(l => /FAIL/.test(l)).slice(0, 6).join('\n'));

  console.log('\n\u2500\u2500 mutations（每个都必须被明确 FAIL 抓住）\u2500\u2500');
  for (const m of MUTATIONS) {
    const target = orig[m.file];
    const raw = target.bytes.toString('utf8');
    const eol = raw.indexOf('\r\n') >= 0 ? '\r\n' : '\n';
    const norm = raw.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
    const bom = raw.charCodeAt(0) === 0xFEFF;
    const from = m.from.replace(/\r\n/g, '\n');
    const to = m.to.replace(/\r\n/g, '\n');
    const hits = norm.split(from).length - 1;
    if (hits !== 1) {
      unexpected++;
      console.log('  ' + m.id + '  *** ANCHOR ' + (hits === 0 ? 'NOT FOUND' : 'AMBIGUOUS(' + hits + ')') + ' ***  ' + m.label);
      continue;
    }
    fs.writeFileSync(target.p, (bom ? '\uFEFF' : '') + norm.replace(from, to).replace(/\n/g, eol));
    let r;
    try { r = runSuite(m.sections); } finally { restore(); }
    const fails = (r.out.match(/\u2718 FAIL/g) || []).length;
    const syntaxError = /SyntaxError|Unexpected token|Unexpected end of input/.test(r.out);
    const harnessError = /HARNESS ERROR/.test(r.out);
    const caught = r.code !== 0 && fails > 0 && !syntaxError && !harnessError;
    if (!caught) unexpected++;
    console.log('  ' + m.id + '  ' + (caught ? 'CAUGHT  ' : '*** MISSED ***') + '  [' + m.sections + ']  ' + m.label);
    if (caught) {
      const first = (r.out.match(/\u2718 FAIL.*$/m) || [''])[0].trim();
      console.log('         ' + first.slice(0, 150));
    } else {
      console.log('         exit=' + r.code + ' fails=' + fails + ' syntaxError=' + syntaxError + ' harnessError=' + harnessError);
      console.log(r.out.split('\n').slice(-10).join('\n'));
    }
  }
} finally {
  restore();
}

const drift = Object.keys(FILES).filter(k => sha(fs.readFileSync(orig[k].p)) !== sha(orig[k].bytes));
if (drift.length) { unexpected++; console.log('\n*** WORKTREE DRIFT ***  ' + drift.join(',')); }

console.log('\n' + (unexpected ? 'UNEXPECTED: ' + unexpected : 'ALL MUTATIONS CAUGHT'));
process.exitCode = unexpected ? 1 : 0;
