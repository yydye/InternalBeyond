/* ====================================================================
   P11-3F · Mutation / falsification（Hydration / Mirror Safety）
   --------------------------------------------------------------------
   `node tests/test_p11_3f_hydration_mutations.js`

   本文件回答：P11-3F 的那些判据是被**执行钉住的**，还是只是注释？

   做法与 P11-3D / 3D.1 / 3X-A / 3X-B / 3X-C / 3E 的 mutation 一致：对生产源码
   做一次**故意的行为破坏**（不是制造语法错误），然后跑真实测试；每个破坏都必须
   让某一条**指名**判据明确变红。

   变异**不发生在原工作树上**：原仓库在本文件运行期间只被**读**。先把闭包复制到
   私有临时树（`%TEMP%\ib-3f-mut-*`），在副本里改写、在副本里跑测试，每个变异
   跑完立刻从原树把该文件复制回来。结束时仍用 SHA-256 复核"原仓库逐字节零漂移"。

   跑不动的变异（锚点找不到 / 不唯一）一律 **UNEXPECTED**：锚点漂移必须被看见。

   变异目标（与阶段要求 M1–M10 对齐）：
     M1  invalid/missing records 再次被兜底成 []（"缺字段"与"权威空集合"压成一个状态）
     M2  503 时仍然调用 replaceAll([])（不可用被当成空集合）
     M3  authoritative empty 被错误"保护"、不允许清空镜像
     M4  丢掉完整性闸门 → 第一批（截断的）结果就开始 mutate mirror
     M5  local replace 非原子（退回 getAll→逐条 del→逐条 put）
     M6  hydrate 失败后仍然把 hydrated 置真
     M7  degraded / lastError 在失败后被错误清空
     M8  旧 hydrate 可以覆盖新 hydrate（代次闸门被摘掉）
     M9  revision / cursor 在失败的 hydrate 后仍然前进
     M10 绕过 canonical authority，把本地镜像当作事实源
     M11 服务端不再如实声明完整性（truncated 恒为 false）
   ==================================================================== */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const SUITE_REL = 'tests/test_p11_3f_moments_hydration_safety.js';
const AUTHORITY = 'assets/js/moments-authority.js';
const sha = buf => crypto.createHash('sha256').update(buf).digest('hex');
const log = (...a) => console.log(a.join(' '));

const TMP_ROOT = os.tmpdir();
function tmpFixtureDirs() {
  const out = new Set();
  let names = [];
  try { names = fs.readdirSync(TMP_ROOT); } catch (_) { return out; }
  for (const name of names) if (/^ib-3f-|^ib3f-/.test(name)) out.add(name);
  return out;
}
function removeFixturesNotIn(before) {
  for (const name of tmpFixtureDirs()) {
    if (before.has(name)) continue;
    try { fs.rmSync(path.join(TMP_ROOT, name), { recursive: true, force: true }); } catch (_) { /* 句柄未释放 */ }
  }
}

/* 只登记本阶段会被变异的文件；原树从头到尾只被读。 */
const WATCHED = [
  AUTHORITY,
  'assets/js/core.js',
  'assets/js/home-node-bootstrap.js',
  'assets/js/home-node-client.js',
  'services/home-node/moments-store.js',
  'services/home-node/mobile-gateway.js',
  SUITE_REL
];
const watchBefore = {};
for (const rel of WATCHED) watchBefore[rel] = sha(fs.readFileSync(path.join(ROOT, rel.split('/').join(path.sep))));

let SANDBOX = '';
function cpDir(name, filter) {
  const src = path.join(ROOT, name);
  if (!fs.existsSync(src)) return;
  fs.cpSync(src, path.join(SANDBOX, name), { recursive: true, filter: filter || undefined });
}
function cpFile(rel) {
  const src = path.join(ROOT, rel.split('/').join(path.sep));
  if (!fs.existsSync(src)) return;
  const dest = path.join(SANDBOX, rel.split('/').join(path.sep));
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}
function buildSandbox() {
  SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-3f-mut-'));
  const skip = p => /(^|[\\/])(node_modules|\.git|\.dsh-research)([\\/]|$)/.test(p);
  cpDir('assets', p => !skip(p) && !/bg-canvas\.png$/i.test(p));
  cpDir('services', p => !skip(p));
  cpDir('scripts', p => !skip(p));
  cpDir('tests', p => !skip(p));
  /* active：services/home-node-service.js 直接 require ../active/node-model-port.js
     （内置 Node 的启动链闭包）。少了它副本里连 require 都过不去 ——
     那时每个变异都会"变红"，但红的原因是 MODULE_NOT_FOUND 而不是被测行为。 */
  cpDir('active', p => !skip(p));
  fs.mkdirSync(path.join(SANDBOX, 'runtime', 'node'), { recursive: true });
  for (const f of ['node.exe', 'VERSION', 'SHA256SUMS']) cpFile('runtime/node/' + f);
  cpDir('runtime', p => !skip(p) && !/[\\/]runtime[\\/]node[\\/]/.test(p));
  for (const f of ['InternalBeyond.html', 'LICENSE']) cpFile(f);
  return SANDBOX;
}

/* ── 在副本里跑真实测试（只用 Node 分节；I 的浏览器部分刻意不带 --browser）── */
const runSuite = sections => {
  try {
    const out = execFileSync(process.execPath, [path.join(SANDBOX, SUITE_REL.split('/').join(path.sep))], {
      cwd: SANDBOX, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      env: Object.assign({}, process.env, { P11_3F_SECTIONS: sections || '' }),
      timeout: 900000
    });
    return { code: 0, out: out };
  } catch (e) {
    return { code: e.status == null ? -1 : e.status, out: String(e.stdout || '') + String(e.stderr || '') };
  }
};

function patch(sandboxRel, from, to) {
  const p = path.join(SANDBOX, sandboxRel.split('/').join(path.sep));
  const raw = fs.readFileSync(p, 'utf8');
  const eol = raw.indexOf('\r\n') >= 0 ? '\r\n' : '\n';
  const bom = raw.charCodeAt(0) === 0xFEFF;
  const norm = raw.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const nFrom = from.replace(/\r\n/g, '\n');
  const hits = norm.split(nFrom).length - 1;
  if (hits !== 1) return { ok: false, hits: hits };
  fs.writeFileSync(p, (bom ? '\uFEFF' : '') + norm.replace(nFrom, to.replace(/\r\n/g, '\n')).replace(/\n/g, eol), 'utf8');
  return { ok: true, hits: 1 };
}

const MUTATIONS = [
  {
    id: 'M1', file: AUTHORITY, sections: 'G', expect: 'G5',
    label: 'invalid/missing records 再次被兜底成 []（"缺字段"与"权威空集合"压成同一个状态）',
    from: '      if (!Array.isArray(page.records)) {\n' +
      '        return { ok: false, error: \'invalid-response\', outcome: \'invalid-response\', status: page.status || null, detail: \'records-missing\' };\n' +
      '      }\n',
    to: '      if (!Array.isArray(page.records)) {\n' +
      '        return { ok: true, records: [], revision: typeof page.revision === \'number\' ? page.revision : 0 };\n' +
      '      }\n'
  },
  {
    id: 'M2', file: AUTHORITY, sections: 'C', expect: 'C5',
    label: '503 时仍然调用 replaceAll([])（不可用被当成"权威说没有"）',
    from: '    function noteSnapshotFailure(verdict) {\n      ctx.stats.failures++;\n',
    to: '    function noteSnapshotFailure(verdict) {\n      local.replaceAll([]);\n      ctx.stats.failures++;\n'
  },
  {
    id: 'M3', file: AUTHORITY, sections: 'B', expect: 'B3',
    label: 'authoritative empty 被错误"保护"、不允许清空镜像（另一个极端）',
    from: '          return local.replaceAll(verdict.records).then(function () {\n',
    to: '          if (verdict.records.length === 0) return { ok: false, error: \'incomplete-snapshot\', outcome: \'incomplete\' };\n' +
      '          return local.replaceAll(verdict.records).then(function () {\n'
  },
  {
    id: 'M4', file: AUTHORITY, sections: 'H', expect: 'H4',
    /* 本阶段的快照是**单页**的（"多页"由 truncated 如实报告，见报告 §7）。
       因此"第一批就开始 mutate mirror"的等价破坏是：**丢掉完整性闸门** ——
       于是取满上限的那一页被当成完整快照直接替换镜像。 */
    label: '丢掉完整性闸门 → 被截断的第一页立刻 mutate mirror',
    from: '      if (page.truncated !== false) {\n',
    to: '      if (false && page.truncated !== false) {\n'
  },
  {
    id: 'M5', file: 'assets/js/home-node-bootstrap.js', sections: 'I', expect: 'I4',
    label: 'local replace 退回非原子形状（getAll → 逐条 del → 逐条 put）',
    from: '    replaceAll: function (rows) {\n      return DB.replaceMomentsMirror(rows || []);\n    },\n',
    to: '    replaceAll: function (rows) {\n' +
      '      return DB.getAll(\'moments\').then(function (existing) {\n' +
      '        var keep = {};\n' +
      '        (rows || []).forEach(function (r) { if (r && r.id != null) keep[String(r.id)] = true; });\n' +
      '        var stale = (existing || []).map(function (r) { return r && r.id; })\n' +
      '          .filter(function (id) { return id != null && !keep[String(id)]; });\n' +
      '        var work = Promise.resolve();\n' +
      '        for (var i = 0; i < stale.length; i++) {\n' +
      '          work = work.then((function (id) { return function () { return DB.del(\'moments\', id); }; })(stale[i]));\n' +
      '        }\n' +
      '        return work.then(function () {\n' +
      '          var w2 = Promise.resolve();\n' +
      '          (rows || []).forEach(function (row) {\n' +
      '            if (!row || row.id == null) return;\n' +
      '            w2 = w2.then(function () { return DB.put(\'moments\', row); });\n' +
      '          });\n' +
      '          return w2;\n' +
      '        });\n' +
      '      });\n' +
      '    },\n'
  },
  {
    id: 'M6', file: AUTHORITY, sections: 'C', expect: 'C7',
    label: 'hydrate 失败后仍然把 hydrated 置真（假绿）',
    from: '      ctx.remoteOnline = false;\n      ctx.degradedReason = verdict.error;\n',
    to: '      ctx.hydrated = true;\n      ctx.remoteOnline = false;\n      ctx.degradedReason = verdict.error;\n'
  },
  {
    id: 'M7', file: AUTHORITY, sections: 'C', expect: 'C8',
    label: 'degraded / lastError 在失败后被错误清空（失败看起来像没事）',
    from: '      ctx.degradedReason = verdict.error;\n      ctx.lastError = verdict.detail ? verdict.error + \':\' + verdict.detail : verdict.error;\n',
    to: '      ctx.degradedReason = \'not-probed\';\n      ctx.lastError = null;\n'
  },
  {
    id: 'M8', file: AUTHORITY, sections: 'J', expect: 'J3',
    label: '旧 hydrate 可以覆盖新 hydrate（代次闸门被摘掉）',
    from: '          if (gen !== hydrateGen) {\n',
    to: '          if (false && gen !== hydrateGen) {\n'
  },
  {
    id: 'M9', file: AUTHORITY, sections: 'C', expect: 'C11',
    label: 'revision / cursor 在**失败的** hydrate 之后仍然前进',
    from: '    function noteSnapshotFailure(verdict) {\n      ctx.stats.failures++;\n',
    to: '    function noteSnapshotFailure(verdict) {\n      ctx.cursor = ctx.mirrorRevision = 999999;\n      ctx.stats.failures++;\n'
  },
  {
    id: 'M10', file: AUTHORITY, sections: 'A', expect: 'A4',
    /* 形状：hydrate 不再问权威，而是把本地镜像当成"权威快照"原样回灌。
       这正是"客户端镜像反向成为权威"这一条不变量被破坏的样子。 */
    label: '绕过 canonical authority，把本地镜像当作事实源',
    from: '      return remote.list({ limit: seedLimit }).then(function (page) {\n',
    to: '      return local.getAll().then(function (localRows) {\n' +
      '        return { ok: true, truncated: false, records: localRows, revision: ctx.mirrorRevision };\n' +
      '      }).then(function (page) {\n'
  },
  {
    id: 'M11', file: 'services/home-node/moments-store.js', sections: 'H', expect: 'H1',
    label: '服务端不再如实声明完整性（truncated 恒为 false）',
    from: '      revision: revision, truncated: rows.length >= limit\n',
    to: '      revision: revision, truncated: false\n'
  }
];

let unexpected = 0;
let caught = 0;
const fixturesBefore = tmpFixtureDirs();

try {
  log('── 建立私有副本树（原仓库只读）──');
  buildSandbox();
  log('  副本 = ' + SANDBOX);

  log('\n── baseline（副本未变异时必须全绿）──');
  const base = runSuite('');
  const green = base.code === 0;
  if (!green) unexpected++;
  log('  ' + (green ? 'GREEN' : 'RED  ') + '  ' + SUITE_REL + (green ? '' : '  *** UNEXPECTED ***'));
  if (!green) log(base.out.split('\n').filter(l => /\u2718/.test(l)).slice(0, 12).join('\n'));

  log('\n── mutations（每个都必须让**指名的**判据变红）──');
  for (const m of MUTATIONS) {
    const applied = [];
    let anchorProblem = null;
    for (const site of [{ file: m.file, from: m.from, to: m.to }].concat(m.extra || [])) {
      const r = patch(site.file, site.from, site.to);
      if (!r.ok) { anchorProblem = site.file + ' hits=' + r.hits; break; }
      applied.push(site.file);
    }
    if (anchorProblem) {
      unexpected++;
      log('  ' + m.id + '  *** ANCHOR ' + (anchorProblem.endsWith('hits=0') ? 'NOT FOUND' : 'AMBIGUOUS') + ' (' + anchorProblem + ') ***  ' + m.label);
      for (const f of applied) cpFile(f);
      continue;
    }
    let r;
    try { r = runSuite(m.sections); } finally { for (const f of applied) cpFile(f); }
    const escaped = m.expect.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    /* 判据名必须**整体**匹配：`C1` 不得靠 `C11` 变红蒙混过关。 */
    const expectedFail = new RegExp('\u2718\\s+' + escaped + '(?![0-9A-Za-z])').test(r.out);
    const failCount = (r.out.match(/\u2718 /g) || []).length;
    const syntaxError = /SyntaxError|Unexpected token|Unexpected end of input|ReferenceError: Cannot access/.test(r.out);
    const harnessError = /未捕获异常/.test(r.out);
    const isCaught = r.code !== 0 && expectedFail && !syntaxError && !harnessError;
    if (isCaught) caught++; else unexpected++;
    log('  ' + m.id.padEnd(4) + (isCaught ? 'CAUGHT  ' : '*** MISSED ***') + '  [' + m.sections + ']  ' + m.label);
    if (isCaught) log('        期望判据变红：' + m.expect + '（该节共 ' + failCount + ' 条 FAIL）');
    else {
      log('        exit=' + r.code + ' expectedFail=' + expectedFail + ' fails=' + failCount
        + ' syntaxError=' + syntaxError + ' harnessError=' + harnessError);
      log(r.out.split('\n').slice(-18).join('\n'));
    }
  }
} finally {
  try { if (SANDBOX) fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch (_) { /* 句柄未释放 */ }
  removeFixturesNotIn(fixturesBefore);
}

const drift = WATCHED.filter(rel => sha(fs.readFileSync(path.join(ROOT, rel.split('/').join(path.sep)))) !== watchBefore[rel]);
if (drift.length) { unexpected++; log('\n*** ORIGINAL WORKTREE DRIFT ***  ' + drift.join(',')); }
else log('\n原仓库逐字节无漂移（' + WATCHED.length + ' 个文件 SHA-256 全部一致；变异全部发生在私有副本里）');

log('\n' + (caught + ' / ' + MUTATIONS.length + ' CAUGHT' + (unexpected ? '  —  UNEXPECTED: ' + unexpected : '  —  0 escaped')));
process.exitCode = unexpected ? 1 : 0;
