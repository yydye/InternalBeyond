/* ====================================================================
   P11-3X-B · Mutation / falsification（Runtime / DB Reliability）
   --------------------------------------------------------------------
   本文件回答的问题：**上面那些可靠性边界是被判据钉住的，还是只是注释？**

   做法与 P11-3D / P11-3D.1 / P11-3X-A 的 mutation 一致：对生产源码做一次**故意的
   行为破坏**（不是制造语法错误），然后跑真实测试；每个破坏都必须让某一条判据明确
   变红。变异目标是本阶段审计出的承重决策：

     · health 是否还看 store 状态（M1）
     · 组件模型是否还问"你能不能干活"（M2）
     · 隔离闸门是否只由完整性结论授权（M3）
     · READONLY 是否被当 corruption（M4）
     · 开库前是否真的检查过可写性（M5）
     · 死掉的 child 的根因是否被传播（M6）以及终态是否保留它（M7）
     · 控制面起不来时是否真的拒绝启动（M8）
     · 外部占用者是否被误判成自己人（M9）
     · 聚合是否还会把 errored 洗成 healthy（M10）
     · "库不能服务"是否又变回 400（M11）
     · 探针理由是否还会写错的端口（M12）

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
  hnhttp: 'services/home-node/http.js',
  registry: 'runtime/component-registry.js',
  dbfail: 'runtime/db-failure.js',
  chatstore: 'services/home-node/chat-store.js',
  runner: 'runtime/local-services-runner.js',
  supervisor: 'runtime/component-supervisor.js'
};
const sha = buf => crypto.createHash('sha256').update(buf).digest('hex');
const orig = {};
for (const k in FILES) { const p = path.join(ROOT, FILES[k]); orig[k] = { p, bytes: fs.readFileSync(p) }; }

const SUITE = 'tests/test_p11_3x_b_runtime_db_reliability.js';
const runSuite = sections => {
  try {
    const out = execFileSync(process.execPath, [path.join(ROOT, SUITE)], {
      cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      env: Object.assign({}, process.env, { P11_3X_B_SECTIONS: sections }),
      timeout: 600000
    });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status == null ? -1 : e.status, out: String(e.stdout || '') + String(e.stderr || '') };
  }
};

const MUTATIONS = [
  { id: 'M1', file: 'hnhttp', sections: 'HEALTH',
    label: 'health 不再看 store 状态（回到 ok 恒为 true：库关着也报健康）',
    from: "  function healthFailure() {\n    if (!store.isOpen()) {",
    to: "  function healthFailure() {\n    if (false) {" },

  { id: 'M2', file: 'registry', sections: 'HEALTH',
    label: '组件模型不再问"你能不能干活"（可达即 healthy，store-closed 被洗成健康）',
    from: "  if (!component.servingHealth || typeof component.servingHealth !== 'function') return null;",
    to: "  if (true) return null;" },

  { id: 'M3', file: 'dbfail', sections: 'DB',
    label: '隔离闸门被摘掉（任何探针失败都能改名搬走一个完好的库）',
    from: "  const c = classify(error);\n  return c.reason === REASON.CORRUPT;",
    to: "  return true;" },

  { id: 'M4', file: 'dbfail', sections: 'CLASSIFY',
    label: 'SQLITE_READONLY 被当作 corruption（只读库会被隔离/重建）',
    from: "  8: REASON.READONLY,",
    to: "  8: REASON.CORRUPT," },

  { id: 'M5', file: 'chatstore', sections: 'DB',
    label: '开库前的可写性预检被摘掉（只读库"打开成功"，每一条写入才失败）',
    from: "      const preflight = writabilityFailure(dbFile);\n      if (preflight) throw dbFailure.toError(preflight);",
    to: "      const preflight = null;\n      if (preflight) throw dbFailure.toError(preflight);" },

  { id: 'M6', file: 'runner', sections: 'RECOVERY',
    label: 'child 的 stderr 尾巴不再被读取（根因丢回 process-exit）',
    from: "function exitCause(service, entry) {\n  const tail = tailOf(entry);",
    to: "function exitCause(service, entry) {\n  const tail = '';" },

  { id: 'M7', file: 'supervisor', sections: 'RECOVERY',
    label: '终态重新用 lockout 理由覆盖 lastFailureReason（根因在最终状态里消失）',
    from: "    if (!rec.lastFailureReason) rec.lastFailureReason = rec.failedReason;",
    to: "    rec.lastFailureReason = rec.failedReason;" },

  { id: 'M8', file: 'runner', sections: 'PORT',
    label: '控制面起不来时不再拒绝启动（变成一个没有控制面的孤儿 runner）',
    from: "  const control = await ensureControlPlane();\n  if (!control.ok) {",
    to: "  const control = await ensureControlPlane();\n  if (control.ok && false) {" },

  { id: 'M9', file: 'runner', sections: 'PORT',
    label: '外部占用者被误判成"自己的僵尸实例"（于是去走停自己的路径，可它并不是我们的）',
    from: "      if (holder.owner === PORT_OWNER.OWNED_COMPONENT) {",
    to: "      if (true) {" },

  { id: 'M10', file: 'registry', sections: 'HEALTH',
    label: '聚合把 errored 当没发生（组件表里有 error，overall 却报 healthy）',
    from: "  const notUp = stopped.length + errored.length;",
    to: "  const notUp = stopped.length;" },

  { id: 'M11', file: 'hnhttp', sections: 'HEALTH',
    label: '"库不能服务"重新回答 400（把调用方引去修一个本来没问题的请求体）',
    from: "    if (UNAVAILABLE_STORE_ERRORS.indexOf(String(error)) >= 0) { bad(res, 503, error, extra, req); return; }",
    to: "    if (false) { bad(res, 503, error, extra, req); return; }" },

  { id: 'M12', file: 'registry', sections: 'HEALTH',
    label: '探针理由重新写 defaultPort（诊断把排查引到一个不是问题所在的端口）',
    from: "  const port = Number.isInteger(o.port) && o.port > 0 ? o.port\n    : (Number.isInteger(p.port) && p.port > 0 ? p.port : c.defaultPort);",
    to: "  const port = c.defaultPort;" }
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
