/* ====================================================================
   P11-3G · Mutation / falsification（Change-Log Delivery Closure）
   --------------------------------------------------------------------
   `node tests/test_p11_3g_delivery_mutations.js`

   本文件回答：P11-3G 的那些判据是被**执行钉住的**，还是只是注释？

   做法与 P11-3D / 3D.1 / 3X-A / 3X-B / 3X-C / 3E / 3F 的 mutation 一致：对生产
   源码做一次**故意的行为破坏**（不是制造语法错误），然后跑真实测试；每个破坏都
   必须让某一条**指名**判据明确变红。

   变异**不发生在原工作树上**：原仓库在本文件运行期间只被**读**。先把闭包复制到
   私有临时树（`%TEMP%\ib-3g-mut-*`），在副本里改写、在副本里跑测试，每个变异跑完
   立刻从原树把该文件复制回来。结束时用 SHA-256 复核"原仓库逐字节零漂移"。

   跑不动的变异（锚点找不到 / 不唯一）一律 **UNEXPECTED**：锚点漂移必须被看见。

   变异目标（与阶段要求 M1–M14 对齐）：
     M1  retry 永不耗尽（attempts 上界失效）                → E1
     M2  restart 后 attempts 归零（持久状态被忽略）          → H2
     M3  毒事件永久堵住窗口（终态不推进 cursor）             → C8
     M4  失败的 event 被直接当 applied                      → D1
     M5  确认早于应用（apply 之前推进 cursor）               → B3
     M6  成功之后不记录持久结论（状态不落盘）                → H2
     M7  "解析为 false"（没有写）被当成应用                  → G4
     M8  已经终态的 event 仍继续执行                         → E7
     M9  retention 删除 pending / retryable 的 event          → K3
     M10 retention 之后客户端静默接受空档（gap 判据失效）     → L6
     M11 投递水位不再单调（回退的 ACK 生效）                  → K5
     M12 终态之后停下本页（后续事件被推迟）                   → C9
     M13 tombstone 缺 id 的判据被摘掉                         → I8
     M14 诊断面泄漏 payload                                  → M4
   ==================================================================== */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const SUITE_REL = 'tests/test_p11_3g_change_delivery_closure.js';
const AUTHORITY = 'assets/js/moments-authority.js';
const STORE = 'services/home-node/moments-store.js';
const GATEWAY = 'services/home-node/mobile-gateway.js';
const sha = buf => crypto.createHash('sha256').update(buf).digest('hex');
const log = (...a) => console.log(a.join(' '));

const TMP_ROOT = os.tmpdir();
function tmpFixtureDirs() {
  const out = new Set();
  let names = [];
  try { names = fs.readdirSync(TMP_ROOT); } catch (_) { return out; }
  for (const name of names) if (/^ib-3g-|^ib3g-/.test(name)) out.add(name);
  return out;
}
function removeFixturesNotIn(before) {
  for (const name of tmpFixtureDirs()) {
    if (before.has(name)) continue;
    try { fs.rmSync(path.join(TMP_ROOT, name), { recursive: true, force: true }); } catch (_) { /* 句柄未释放 */ }
  }
}
const FIXTURES_BEFORE = tmpFixtureDirs();

/* 只登记本阶段会被变异的文件；原树从头到尾只被读。 */
const WATCHED = [
  AUTHORITY, STORE, GATEWAY,
  'assets/js/core.js',
  'assets/js/home-node-bootstrap.js',
  'assets/js/home-node-client.js'
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
  SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-3g-mut-'));
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

const runSuite = sections => {
  try {
    const out = execFileSync(process.execPath, [path.join(SANDBOX, SUITE_REL.split('/').join(path.sep))], {
      cwd: SANDBOX, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      env: Object.assign({}, process.env, { P11_3G_SECTIONS: sections || '' }),
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
function restore(sandboxRel) {
  const src = path.join(ROOT, sandboxRel.split('/').join(path.sep));
  const dest = path.join(SANDBOX, sandboxRel.split('/').join(path.sep));
  fs.copyFileSync(src, dest);
}

const MUTATIONS = [
  {
    id: 'M1', file: AUTHORITY, sections: 'E', expect: 'E1',
    label: 'retry 永不耗尽（attempts 上界失效 → 无限重试）',
    from: '      if (attempts >= DELIVERY_MAX_ATTEMPTS) {\n',
    to: '      if (false && attempts >= DELIVERY_MAX_ATTEMPTS) {\n'
  },
  {
    id: 'M2', file: AUTHORITY, sections: 'H', expect: 'H2',
    label: 'restart 后 attempts 归零（持久状态被忽略，预算重新数起）',
    from: '    var attempts = (raw.attempts && typeof raw.attempts === \'object\') ? raw.attempts : {};\n',
    to: '    var attempts = {};\n'
  },
  {
    id: 'M3', file: AUTHORITY, sections: 'C', expect: 'C8',
    label: '毒事件永久堵住窗口（终态不再推进 cursor）',
    from: '        recordTerminal(state, plan, event, failure, attempts, now);\n        advanceWatermark(state, plan, event.revision);\n',
    to: '        recordTerminal(state, plan, event, failure, attempts, now);\n'
  },
  {
    id: 'M4', file: AUTHORITY, sections: 'D', expect: 'D1',
    label: '失败的 event 被直接当 applied（不记失败就推进 cursor）',
    from: '      var failure = applyFailureOf(error);\n      var prev = state.attempts[String(event.revision)];\n',
    to: '      advanceWatermark(state, plan, event.revision);\n      plan.applied++;\n      return false;\n' +
      '      var failure = applyFailureOf(error);\n      var prev = state.attempts[String(event.revision)];\n'
  },
  {
    id: 'M5', file: AUTHORITY, sections: 'B', expect: 'B3',
    label: '确认早于应用（apply 之前就推进 cursor → 未落盘的 event 被永久越过）',
    from: '      return applyOne(event).then(function () {\n        delete state.attempts[String(event.revision)];\n        plan.applied++;\n        advanceWatermark(state, plan, event.revision);\n',
    to: '      advanceWatermark(state, plan, event.revision);\n      return applyOne(event).then(function () {\n        delete state.attempts[String(event.revision)];\n        plan.applied++;\n'
  },
  {
    id: 'M6', file: AUTHORITY, sections: 'H', expect: 'H2',
    label: '成功之后不记录持久结论（投递状态根本不落盘）',
    from: '      var write = deliverySeam(false);\n',
    to: '      var write = null;\n'
  },
  {
    id: 'M7', file: AUTHORITY, sections: 'G', expect: 'G4',
    label: '驱动解析为 false（**没有写**）被当成应用 → 静默丢失',
    from: '        if (written === false) return Promise.reject({ name: \'DataError\', message: \'mirror did not write\' });\n        return true;\n',
    to: '        return true;\n'
  },
  {
    id: 'M8', file: AUTHORITY, sections: 'E', expect: 'E7',
    label: '已经终态的 event 仍然继续执行（重复投递时重新尝试）',
    from: '      if (terminalRecord(state, event.revision)) {\n',
    to: '      if (false && terminalRecord(state, event.revision)) {\n'
  },
  {
    id: 'M9', file: STORE, sections: 'K', expect: 'K3',
    label: 'retention 删除 pending / retryable 的 event（回收边界不再受投递水位约束）',
    from: '    const safe = Math.min.apply(null, consumers.map(r => r.watermark));\n',
    to: '    const safe = getRevision();\n'
  },
  {
    id: 'M10', file: AUTHORITY, sections: 'L', expect: 'L6',
    label: 'retention 空档被静默接受（客户端不再察觉被回收掉的那一段）',
    from: '    function retentionGap(state, res) {\n',
    to: '    function retentionGap(state, res) {\n      return null;\n'
  },
  {
    id: 'M11', file: STORE, sections: 'K', expect: 'K5',
    label: '投递水位不再单调（回退的 ACK 生效 → 回收授权可以被一次乱序 ACK 改写）',
    from: '        const next = Math.max(previous, clamped);\n',
    to: '        const next = clamped;\n'
  },
  {
    id: 'M12', file: AUTHORITY, sections: 'C', expect: 'C9',
    label: '终态之后停下本页（不再继续应用后面的 event）',
    from: '        if (!becameTerminal) return Promise.resolve();\n        return runPage(list, index + 1, state, plan, now);\n',
    to: '        return Promise.resolve();\n'
  },
  {
    id: 'M13', file: AUTHORITY, sections: 'I', expect: 'I8',
    label: 'tombstone 缺 id 的判据被摘掉（一个没有目标的 delete 被当成已应用）',
    from: '    if (!event.row || event.row.id == null || String(event.row.id) === \'\') return \'record-id-missing\';\n',
    to: '    if (false) return \'record-id-missing\';\n'
  },
  {
    id: 'M14', file: AUTHORITY, sections: 'M', expect: 'M4',
    label: '诊断面泄漏 payload（把整条记录塞进投递记账）',
    from: '      state.attempts[String(event.revision)] = {\n        revision: event.revision, kind: event.kind, recordId: event.recordId,\n',
    to: '      state.attempts[String(event.revision)] = {\n        payload: event.row,\n        revision: event.revision, kind: event.kind, recordId: event.recordId,\n'
  }
];

(async function main() {
  log('P11-3G · mutation / falsification');
  log('原仓库（只读）: ' + ROOT);
  /* 可选：只跑指定变异（`P11_3G_MUTATIONS=M9,M13`）。用于单条复跑 ——
     逐条复跑是区分"判据没被钉住"与"环境/资源导致的红"的主要手段。 */
  const ONLY = String(process.env.P11_3G_MUTATIONS || '').split(/[\s,]+/).filter(Boolean);
  const PLAN = ONLY.length ? MUTATIONS.filter(m => ONLY.indexOf(m.id) >= 0) : MUTATIONS;
  if (ONLY.length) log('只跑：' + PLAN.map(m => m.id).join(', '));
  buildSandbox();
  log('私有副本树: ' + SANDBOX + '\n');

  /* baseline：未变异时必须全绿。否则"变异后变红"没有意义。 */
  const baseline = runSuite('');
  const baselineClean = baseline.code === 0 && /全部通过：\d+ passed, 0 failed/.test(baseline.out);
  log((baselineClean ? 'BASELINE GREEN' : 'BASELINE RED') + '  ' +
    ((baseline.out.match(/(\d+) passed, (\d+) failed/) || []).join(' ')));
  if (!baselineClean) {
    log('\nbaseline 不是绿的 —— 先修它，否则本文件无法证伪任何东西。');
    log(baseline.out.slice(-4000));
    process.exit(1);
  }
  log('');

  let caught = 0, escaped = 0, unexpected = 0;
  const results = [];

  const sleepMs = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

  for (const m of PLAN) {
    const applied = patch(m.file, m.from, m.to);
    if (!applied.ok) {
      unexpected++;
      results.push({ id: m.id, status: 'UNEXPECTED', why: 'anchor hits=' + applied.hits });
      log('?? ' + m.id + '  UNEXPECTED（锚点不唯一/找不到：hits=' + applied.hits + '）  ' + m.label);
      restore(m.file);
      continue;
    }
    let run = runSuite(m.sections);
    let red = run.code !== 0 || !/全部通过/.test(run.out);
    let named = run.out.indexOf('\u2718 ' + m.expect) >= 0;
    let rerun = false;
    /* ── 判定纪律（docs/INTERNALBEYOND_AI_RULES.md §14）──────────────────
       "变红了但不是由指名判据抓到"有两种可能：判据没被钉住，或者这一轮是被
       资源/环境弄红的（连续十几个真实 Home Node + 浏览器级套件之后，一次
       fetch 失败和一个真的缺陷在输出上长得一样）。
       两者的区别必须被显式判定，而不是靠猜：**带变异复跑一次**。
       复跑抓到 → CAUGHT（并如实记录第一次是被污染的）；复跑仍抓不到 → ESCAPED。 */
    if (red && !named) {
      rerun = true;
      sleepMs(1500);
      run = runSuite(m.sections);
      red = run.code !== 0 || !/全部通过/.test(run.out);
      named = run.out.indexOf('\u2718 ' + m.expect) >= 0;
    }
    if (red && named) {
      caught++;
      results.push({ id: m.id, status: 'CAUGHT', by: m.expect, rerun: rerun });
      log('\u2714 ' + m.id + ' CAUGHT [' + m.expect + ']' + (rerun ? '（复跑；第一次被资源/环境污染）' : '') + '  ' + m.label);
    } else if (red) {
      escaped++;
      const failedNames = (run.out.match(/\u2718 [^\n]+/g) || []).slice(0, 4).join(' | ');
      results.push({ id: m.id, status: 'ESCAPED', why: 'red but not by ' + m.expect, failed: failedNames });
      log('\u2718 ' + m.id + ' ESCAPED（变红了，但不是由 ' + m.expect + ' 抓到的）  ' + m.label);
      log('    实际红项: ' + failedNames);
    } else {
      escaped++;
      results.push({ id: m.id, status: 'ESCAPED', why: 'suite stayed green' });
      log('\u2718 ' + m.id + ' ESCAPED（套件仍然全绿 —— 这条判据没有被执行钉住）  ' + m.label);
    }
    restore(m.file);
    sleepMs(400);
  }

  /* 原仓库零漂移复核：变异全部发生在副本里，原树只被读过。 */
  let drift = [];
  for (const rel of WATCHED) {
    const after = sha(fs.readFileSync(path.join(ROOT, rel.split('/').join(path.sep))));
    if (after !== watchBefore[rel]) drift.push(rel);
  }
  log('\n原仓库逐字节零漂移: ' + (drift.length === 0 ? 'YES' : 'NO -> ' + drift.join(', ')));

  try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch (_) { /* 句柄未释放 */ }
  removeFixturesNotIn(FIXTURES_BEFORE);

  log('\n结果：' + caught + ' CAUGHT / ' + escaped + ' ESCAPED / ' + unexpected + ' UNEXPECTED  （共 ' + PLAN.length + '）');
  process.exit(caught === PLAN.length && drift.length === 0 ? 0 : 1);
})().catch(error => {
  console.error('MUTATION RUNNER CRASHED: ' + (error && error.stack || error));
  try { if (SANDBOX) fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch (_) { /* 句柄未释放 */ }
  removeFixturesNotIn(FIXTURES_BEFORE);
  setTimeout(() => process.exit(1), 200);
});
