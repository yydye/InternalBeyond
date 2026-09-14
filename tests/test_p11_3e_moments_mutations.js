/* ====================================================================
   P11-3E · Mutation / falsification（Moments canonical store closure）
   --------------------------------------------------------------------
   `node tests/test_p11_3e_moments_mutations.js`

   本文件回答：P11-3E 的那些判据是被**执行钉住的**，还是只是注释？

   做法与 P11-3D / P11-3D.1 / P11-3X-A / P11-3X-B / P11-3X-C 的 mutation 一致：
   对生产源码做一次**故意的行为破坏**（不是制造语法错误），然后跑真实测试；
   每个破坏都必须让某一条指名判据明确变红。

   ── 与前面几轮不同的一点（本阶段的要求）────────────────────────────────
   变异**不发生在原工作树上**。原仓库在本文件运行期间只被**读**：
   先把随包闭包复制到私有临时树（`%TEMP%\ib-3e-mut-*`），在副本里改写、在副本里
   跑测试。因此"原仓库逐字节零漂移"不是靠 finally 还原保证的，而是结构上不可能
   被写坏；本文件仍在结束时用 SHA-256 复核这一点。

   副本内容 = 发行闭包的那几个目录（不含 runtime/node 之外的二进制、不含 88 MB
   的内置运行时全量、不含指南截图与游戏立绘）。**内置 Node 会被复制**，因为真实
   spawn 用的就是它 —— 让副本里的生产子进程仍然跑在生产解释器上。

   跑不动的变异（锚点找不到 / 不唯一）一律 **UNEXPECTED**：锚点漂移必须被看见。

   变异目标：
     M1  production openAll() 再次漏掉 momentsStore
     M2  health 忽略 momentsStore readiness
     M3  closed store 被当成空集合（200 而不是失败）
     M4  mobile/网关路径改读另一份 authority
     M5  close/shutdown 漏 momentsStore
     M6  restart 后改成新临时 DB（数据不连续）
     M7  write 不进入 canonical store
     M8  delete/tombstone 不持久化
     M9  DB failure 被洗成普通 400/空数据
     M10 release manifest 漏掉 production dependency
   ==================================================================== */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const SUITE_REL = 'tests/test_p11_3e_moments_canonical_closure.js';
const SUITE_SRC = path.join(ROOT, SUITE_REL);
const sha = buf => crypto.createHash('sha256').update(buf).digest('hex');
const log = (...a) => console.log(a.join(' '));

/* ── 临时夹具清理 ───────────────────────────────────────────────────────
   本文件会在系统临时目录里留下两类东西：私有副本树，以及**被变异的 store
   自己开的库目录**（M6 的变异故意给每次打开分配一个新 mkdtemp 目录）。
   它们都带一个稳定的命名族前缀，所以运行前后各拍一次快照、按差集清理 ——
   只有"本次运行新出现的"才会被删，绝不碰别人的目录。 */
const TMP_ROOT = os.tmpdir();
function tmpFixtureDirs() {
  const out = new Set();
  let names = [];
  try { names = fs.readdirSync(TMP_ROOT); } catch (_) { return out; }
  for (const name of names) {
    if (!/^ib-3e-|^ib3e-/.test(name)) continue;
    out.add(name);
  }
  return out;
}
function removeFixturesNotIn(before) {
  for (const name of tmpFixtureDirs()) {
    if (before.has(name)) continue;
    try { fs.rmSync(path.join(TMP_ROOT, name), { recursive: true, force: true }); } catch (_) { /* 句柄未释放 */ }
  }
}

/* ── 原仓库的"读数基线"：整轮结束时必须逐字节一致 ─────────────────────
   只登记本阶段会被变异的文件（副本里的那些），因为原树从头到尾只被读。 */
const WATCHED = [
  'services/home-node-service.js',
  'services/home-node/mobile-gateway.js',
  'services/home-node/http.js',
  'services/home-node/moments-store.js',
  'runtime/component-registry.js',
  'scripts/release-manifest.js',
  SUITE_REL
];
const watchBefore = {};
for (const rel of WATCHED) watchBefore[rel] = sha(fs.readFileSync(path.join(ROOT, rel.split('/').join(path.sep))));

/* ── 私有副本 ─────────────────────────────────────────────────────────── */
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

let SANDBOX = '';
function buildSandbox() {
  SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-3e-mut-'));
  const skip = p => /(^|[\\/])(node_modules|\.git|\.dsh-research)([\\/]|$)/.test(p);
  cpDir('assets', p => !skip(p) && !/bg-canvas\.png$/i.test(p));
  cpDir('apps', p => !skip(p));
  cpDir('game', p => !skip(p) && !/[\\/]portraits[\\/]/i.test(p) && !/portrait_\[/i.test(path.basename(p)));
  cpDir('services', p => !skip(p));
  cpDir('bridge', p => !skip(p));
  cpDir('active', p => !skip(p));
  cpDir('scripts', p => !skip(p));
  cpDir('tests', p => !skip(p));
  /* runtime：内置 Node 必须在内（真实 spawn 用的是它），其余按需带上。 */
  fs.mkdirSync(path.join(SANDBOX, 'runtime', 'node'), { recursive: true });
  for (const f of ['node.exe', 'VERSION', 'SHA256SUMS', 'LICENSE', 'README.md']) {
    cpFile('runtime/node/' + f);
  }
  cpDir('runtime', p => !skip(p) && !/[\\/]runtime[\\/]node[\\/]/.test(p));
  for (const f of ['LICENSE', 'VERSION', 'README.md']) cpFile(f);
  fs.mkdirSync(path.join(SANDBOX, 'LICENSES'), { recursive: true });
  cpFile('LICENSES/THIRD-PARTY.md');
  /* docs：发行清单只点名 guide/annotations.json（截图 7 MB 不复制）。 */
  fs.mkdirSync(path.join(SANDBOX, 'docs', 'guide'), { recursive: true });
  cpFile('docs/guide/annotations.json');
  return SANDBOX;
}

/* ── 在副本里跑真实测试 ───────────────────────────────────────────────── */
const runSuite = sections => {
  try {
    const out = execFileSync(process.execPath, [path.join(SANDBOX, SUITE_REL.split('/').join(path.sep))], {
      cwd: SANDBOX, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      env: Object.assign({}, process.env, { P11_3E_SECTIONS: sections || '' }),
      timeout: 900000
    });
    return { code: 0, out: out };
  } catch (e) {
    return { code: e.status == null ? -1 : e.status, out: String(e.stdout || '') + String(e.stderr || '') };
  }
};

/* ── 在副本里做一次"行为破坏"（不是语法破坏）─────────────────────────── */
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
    id: 'M1', file: 'services/home-node-service.js', sections: 'B C',
    expect: 'C1', label: 'production openAll() 再次漏掉 momentsStore（本阶段关闭的那个缺口）',
    from: '  openMomentStore(moments.momentsStore, momentStoreFailureProbe);\n',
    to: '  /* mutated: moments store is never opened on the production path */\n'
  },
  {
    id: 'M2', file: 'services/home-node-service.js', sections: 'D C',
    expect: 'D6', label: 'health 不认识 momentsStore readiness（无法说出哪个域不能服务）',
    /* 两条装配路径各有一份 canonical store 清单（生产进程级 / buildHomeNode），
       它们必须**都**被摘掉才算"health 不看 Moments" —— 只摘一条会让另一条把
       事实兜回来，于是变异根本不改变被测行为（第一版就是这样，MISSED）。
       这正是"sections 必须真的打到目标行为"这条纪律在抓测试作者。

       期望判据刻意选 D6/D7 而不是 D2：把 moments 条目改名成另一个
       `canonical-chat-authority` 之后，`serving` **仍然**正确地是 false（那条
       条目自己也是一个关着的 store），所以 D2 不该红。真正被破坏的是
       "**哪个域**不能服务" —— 响应里出现的是 chat-mirror 而不是 moments，
       诊断面因此指错方向。改名而不是删除，就是为了把这个差别留在变异里。 */
    from: '    { store: moments.momentsStore, name: \'moments\', role: \'canonical-moments-authority\', probe: momentStoreFailureProbe }\n',
    to: '',
    extra: [{
      file: 'services/home-node-service.js',
      from: '        store: instanceMoments.momentsStore, name: \'moments\', role: \'canonical-moments-authority\',\n        probe: instanceMomentProbe\n',
      to: '        store: instanceMoments.momentsStore, name: \'chat-mirror\', role: \'canonical-chat-authority\'\n'
    }]
  },
  {
    id: 'M3', file: 'services/home-node/mobile-gateway.js', sections: 'G H',
    expect: 'G1', label: 'closed store 被当成空集合（200 而不是失败）',
    from: "  function failStore(res, report, req, extra) {\n    const resolved = resolveStoreFailure ? resolveStoreFailure(report) : null;",
    to: "  function failStore(res, report, req, extra) {\n    return sendJson(res, 200, { ok: true, payload: { records: [], moments: [], count: 0 } });\n    const resolved = resolveStoreFailure ? resolveStoreFailure(report) : null;"
  },
  {
    id: 'M4', file: 'services/home-node/mobile-gateway.js', sections: 'B E G',
    expect: 'E10', label: '网关路径改读另一份 authority（第二个 store 实例 = 第二个权威）',
    /* 故意在网关内部把三个写口指向**第二个** store 实例：它自己开库、能查、永远
       看不到 canonical 的行。这是 M1-C.2i 那次"召回器漂移"的同形破坏 ——
       不抛任何错，只让"写进去了却读不出来"。 */
    from: '  const momentsStore = deps.momentsStore || null;',
    to: '  const momentsStore = (function () {\n' +
      '    const create = require(\'./moments-store.js\');\n' +
      '    const s = create({ dataDir: require(\'os\').tmpdir(), logger: () => {} });\n' +
      '    try { s.open(); } catch (_) { /* 打不开就永远为空 */ }\n' +
      '    return s;\n' +
      '  })();'
  },
  {
    id: 'M5', file: 'services/home-node-service.js', sections: 'C',
    expect: 'C2', label: '生产停止路径（shutdown）漏掉 momentsStore.close()',
    from: '    try { moments.momentsStore.close(); } catch (_) { /* 已关闭 */ }\n',
    to: '    /* mutated: the shutdown path never closes the moments store */\n'
  },
  {
    id: 'M6', file: 'services/home-node/moments-store.js', sections: 'E',
    expect: 'E4', label: 'restart 后改成新临时 DB（数据不连续）',
    from: "  const dbFile = deps.dbFile || path.join(dataDir, DEFAULT_DB_FILENAME);",
    to: "  const dbFile = (function () {\n    const fs2 = require('fs');\n    const os2 = require('os');\n    if (!dbFile_mutated_cache) { dbFile_mutated_cache = path.join(fs2.mkdtempSync(path.join(os2.tmpdir(), 'ib-3e-mut-db-')), DEFAULT_DB_FILENAME); }\n    return dbFile_mutated_cache;\n  })();\n  var dbFile_mutated_cache = null;"
  },
  {
    id: 'M7', file: 'services/home-node/moments-store.js', sections: 'B E',
    expect: 'B4', label: 'write 不进入 canonical store（写路径被摘掉）',
    /* put() 的新建分支：直接回一个"成功"而不落盘。锚点必须带上 put 特有的
       上下文 —— 冷启动时 `sqliteGet(SQL.selectRecord, [candidate.id])` 这一行
       在 put() 与 writeMigrated() 里各出现一次，裸行会 AMBIGUOUS（第一版就是）。 */
    from: '    try {\n      return withTransaction(() => {\n        const existing = sqliteGet(SQL.selectRecord, [candidate.id]);\n        if (existing) {\n          const current = rowToMoment(existing);',
    to: '    try {\n      return { ok: true, outcome: \'created\', id: candidate.id, rev: 1, revision: getRevision(), moment: candidate };\n      return withTransaction(() => {\n        const existing = sqliteGet(SQL.selectRecord, [candidate.id]);\n        if (existing) {\n          const current = rowToMoment(existing);'
  },
  {
    id: 'M8', file: 'services/home-node/moments-store.js', sections: 'E',
    expect: 'E12', label: 'delete / tombstone 不持久化（UI 看不见就算删了）',
    from: '        sqliteExec(SQL.softDelete, [clock(), revision, revision, clock(), target]);\n        logChange(revision, \'delete\', target);',
    to: '        sqliteExec(\'SELECT 1\');\n        /* mutated: no tombstone row, no delete change-log entry */'
  },
  {
    id: 'M9', file: 'services/home-node/mobile-gateway.js', sections: 'H',
    expect: 'H6', label: 'DB failure 被洗成普通 400（终态故障被当作请求问题）',
    /* 关键的一处细节：库打不开时，**store 自己的方法**回答的是 `store-closed`
       （它只知道"我没开"），把 `db-schema-too-new` 还原出来的是装配层探针。
       所以"洗成 400"的正确变异是让 `store-closed` 不再被认作 store 层失败 ——
       而不是让 db-* 不被认。第一版写反了方向，于是变异压根没碰到被测路径。 */
    from: '  function isStoreLevelError(error) {\n    return STORE_LEVEL_ERRORS.indexOf(String(error)) >= 0;\n  }',
    to: '  function isStoreLevelError(error) {\n    return String(error).indexOf(\'db-\') === 0;\n  }'
  },
  {
    id: 'M9b', file: 'services/home-node/http.js', sections: 'H',
    expect: 'H5', label: '开库失败的类别被吞掉（db-schema-too-new 退化成 store-closed）',
    /* 目标是最新的一处"唯一实现"：分类发生在 http.js 的
       `createStoreFailureProbe`（装配层的探针只是把最后那次开库事故交给它）。 */
    from: '    if (error && isDbError && isDbError(error) && classifyFailure) {',
    to: '    if (false && error && isDbError && isDbError(error) && classifyFailure) {'
  },
  {
    id: 'M10', file: 'scripts/release-manifest.js', sections: 'J',
    expect: 'J2', label: 'release manifest 漏掉 production dependency（db-failure 不进包）',
    from: '  { from: \'runtime/db-failure.js\', why: \'数据库失败分类器',
    to: '  { from: \'runtime/db-failure-DISABLED.js\', why: \'数据库失败分类器'
  }
];

let unexpected = 0;
let caught = 0;
const fixturesBefore = tmpFixtureDirs();

function restoreFile(sandboxRel) {
  cpFile(sandboxRel);
}

try {
  log('── 建立私有副本树（原仓库只读）──');
  buildSandbox();
  log('  副本 = ' + SANDBOX);

  log('\n── baseline（副本未变异时必须全绿）──');
  const base = runSuite('');
  const green = base.code === 0;
  if (!green) unexpected++;
  log('  ' + (green ? 'GREEN' : 'RED  ') + '  ' + SUITE_REL + (green ? '' : '  *** UNEXPECTED ***'));
  if (!green) log(base.out.split('\n').filter(l => /✘/.test(l)).slice(0, 10).join('\n'));

  log('\n── mutations（每个都必须让**指名的**判据变红）──');
  for (const m of MUTATIONS) {
    /* `extra` 是同一行为的第二处定义点（例如两条装配路径各有一份 store 清单）：
       只改一处，另一处会把事实兜回来，变异就等于没发生。 */
    const sites = [{ file: m.file, from: m.from, to: m.to }].concat(m.extra || []);
    const applied = [];
    let anchorProblem = null;
    for (const site of sites) {
      const r = patch(site.file, site.from, site.to);
      if (!r.ok) { anchorProblem = site.file + ' hits=' + r.hits; break; }
      applied.push(site.file);
    }
    if (anchorProblem) {
      unexpected++;
      log('  ' + m.id + '  *** ANCHOR ' + (anchorProblem.endsWith('hits=0') ? 'NOT FOUND' : 'AMBIGUOUS') + ' (' + anchorProblem + ') ***  ' + m.label);
      for (const f of applied) restoreFile(f);
      continue;
    }
    let r;
    try { r = runSuite(m.sections); } finally { for (const f of applied) restoreFile(f); }
    const escaped = m.expect.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    /* 判据名必须**整体**匹配：`D6` 不得靠 `D7` 变红蒙混过关。 */
    const expectedFail = new RegExp('✘\\s+' + escaped + '(?![0-9A-Za-z])').test(r.out);
    const failCount = (r.out.match(/✘ /g) || []).length;
    const syntaxError = /SyntaxError|Unexpected token|Unexpected end of input|ReferenceError: Cannot access/.test(r.out);
    const harnessError = /HARNESS ERROR/.test(r.out);
    const isCaught = r.code !== 0 && expectedFail && !syntaxError && !harnessError;
    if (isCaught) caught++; else unexpected++;
    log('  ' + m.id.padEnd(4) + (isCaught ? 'CAUGHT  ' : '*** MISSED ***') + '  [' + m.sections + ']  ' + m.label);
    if (isCaught) {
      log('        期望判据变红：' + m.expect + '（该节共 ' + failCount + ' 条 FAIL）');
    } else {
      log('        exit=' + r.code + ' expectedFail=' + expectedFail + ' fails=' + failCount
        + ' syntaxError=' + syntaxError + ' harnessError=' + harnessError);
      log(r.out.split('\n').slice(-16).join('\n'));
    }
  }
} finally {
  /* 副本整个删掉；原树从未被写过，这里只是把临时目录清干净。 */
  try { if (SANDBOX) fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch (_) { /* 句柄未释放 */ }
  /* 被变异的 store 自己开的库目录同样清掉（只删本次新出现的）。 */
  removeFixturesNotIn(fixturesBefore);
}

const drift = WATCHED.filter(rel => sha(fs.readFileSync(path.join(ROOT, rel.split('/').join(path.sep)))) !== watchBefore[rel]);
if (drift.length) { unexpected++; log('\n*** ORIGINAL WORKTREE DRIFT ***  ' + drift.join(',')); }
else log('\n原仓库逐字节无漂移（' + WATCHED.length + ' 个文件 SHA-256 全部一致；变异全部发生在私有副本里）');

log('\n' + (caught + ' / ' + MUTATIONS.length + ' CAUGHT' + (unexpected ? '  —  UNEXPECTED: ' + unexpected : '  —  0 escaped')));
process.exitCode = unexpected ? 1 : 0;
