'use strict';

/*
 * P11-3H · mutation / falsification
 *
 *   node tests/test_p11_3h_lifecycle_mutations.js            # all
 *   P11_3H_MUTATIONS=M9,M13 node tests/test_p11_3h_lifecycle_mutations.js
 *
 * Answers one question: are this phase's rules held by EXECUTION, or only by
 * comments? Each mutation is a deliberate behavioural break (never a syntax
 * error) applied to a private COPY of the tree; every one of them must make a
 * NAMED check in tests/test_p11_3h_lifecycle_gate.js fail.
 *
 * The original working tree is read, never written: the closure is copied to
 * `%TEMP%\ib-3h-mut-*`, the mutation is applied in the copy, the suite runs in
 * the copy, and the file is restored from the original after each mutation. A
 * SHA-256 re-check at the end proves zero byte drift in the original.
 *
 * An anchor that is missing or not unique is UNEXPECTED, never skipped: anchor
 * drift has to be visible.
 *
 * A suite that does not even LOAD (a mutation that produced invalid JavaScript)
 * is UNEXPECTED too, not ESCAPED. Measured in this phase: a mutation that
 * removed a brace turned the whole suite into a MODULE-level SyntaxError, which
 * crashed the runner before any check could be named — and the first version of
 * this file reported that as "the suite stayed green". It had not. A mutation
 * has to be a behavioural break that still parses; if it does not parse, it
 * proves nothing about the rules.
 *
 *   M1  the installer helper goes back to its own service list   → A4b
 *   M2  Home Node is dropped from the lifecycle target set        → A1
 *   M3  a first stop is reported as a duplicate (idempotence set
 *       too early, so the real teardown never runs)               → H6
 *   M4  the identity re-verification before the fallback kill is
 *       removed (a recycled pid gets killed)                      → D5
 *   M5  the cooperative wait runs to the absolute deadline instead
 *       of its own budget                                         → C4
 *   M6  the cooperative wait is clamped to nothing, so a healthy
 *       stop becomes a kill                                       → C8
 *   M7  the fallback kills without re-reading the identity         → C9
 *   M8  an unreadable command line is accepted as ownership proof  → D4
 *   M9  a held port with no answer is called NOT_RUNNING, because the
 *       bindability check that separates "nothing runs here" from
 *       "something holds this and is mute" is skipped             → E2b
 *   M10 the runner-child proof is refused unless the pid is known,
 *       so a recycled pid gets killed                             → D5
 *   M11 "stopped" no longer requires the pid to be gone            → C3
 *   M12 a partial-dead target stops the whole cycle                → E1
 *   M13 a second stop reports failure                              → H6
 *   M14 the installer no longer checks the helper's exit code       → I2
 *   M15 the report leaks a credential                              → H2
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const SUITE_REL = 'tests/test_p11_3h_lifecycle_gate.js';
const LIFECYCLE = 'runtime/component-lifecycle.js';
const CONTROL = 'runtime/service-control.js';
const REGISTRY = 'runtime/component-registry.js';
const STOP_HELPER = 'installer/tools/ib-stop.js';
const INSTALLER = 'installer/InternalBeyond.iss';
const sha = buf => crypto.createHash('sha256').update(buf).digest('hex');
const log = (...a) => console.log(a.join(' '));

const TMP_ROOT = os.tmpdir();
function fixtureDirs() {
  const out = new Set();
  let names = [];
  try { names = fs.readdirSync(TMP_ROOT); } catch (_) { return out; }
  for (const name of names) if (/^ib-3h-/.test(name)) out.add(name);
  return out;
}
function removeFixturesNotIn(before) {
  for (const name of fixtureDirs()) {
    if (before.has(name)) continue;
    try { fs.rmSync(path.join(TMP_ROOT, name), { recursive: true, force: true }); } catch (_) { /* 句柄未释放 */ }
  }
}
const FIXTURES_BEFORE = fixtureDirs();

/* Only the files this phase can mutate; the original tree is read-only here. */
const WATCHED = [LIFECYCLE, CONTROL, REGISTRY, STOP_HELPER, INSTALLER,
  'services/home-node-service.js', 'services/home-node/http.js',
  'services/internal-beyond-server.js', 'services/ib-bridge-service.js',
  'services/active-message-service.js', 'runtime/local-services-runner.js'];
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
  SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-3h-mut-'));
  const skip = p => /(^|[\\/])(node_modules|\.git|\.dsh-research)([\\/]|$)/.test(p);
  /* The suite and its helper are copied verbatim: the mutation must break the
     PRODUCT, and a test that was rewritten to accommodate it proves nothing. */
  cpDir('tests', p => !skip(p));
  for (const dir of ['runtime', 'services', 'assets', 'active', 'bridge', 'installer', 'scripts', 'docs']) {
    cpDir(dir, p => !skip(p));
  }
  for (const f of ['InternalBeyond.html', 'LICENSE', 'VERSION']) cpFile(f);
  return SANDBOX;
}

const runSuite = sections => {
  try {
    const out = execFileSync(process.execPath, [path.join(SANDBOX, SUITE_REL.split('/').join(path.sep))], {
      cwd: SANDBOX, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      env: Object.assign({}, process.env, { P11_3H_SECTIONS: sections || '' }),
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
    id: 'M1', file: STOP_HELPER, sections: 'A', expect: 'A4b',
    label: 'the installer helper goes back to its own hand-written service list',
    from: '    return { targets: mods.lifecycle.targets(source), source: \'registry\', from: mods.from, error: null, mods: mods };\n',
    to: '    return { targets: legacyTargets(source).map(function (t) { t.matchesHealth = legacyIdentity(t.id); return t; }), source: \'hand-written\', from: null, error: null, mods: mods };\n'
  },
  {
    id: 'M2', file: REGISTRY, sections: 'A', expect: 'A1',
    label: 'Home Node drops out of the lifecycle target set',
    from: '    stopPath: \'/__shutdown\',\n    matchesHealth: data => !!(data && data.service === \'internal-beyond-home-node\'),',
    to: '    matchesHealth: data => !!(data && data.service === \'internal-beyond-home-node\'),'
  },
  {
    id: 'M3', file: CONTROL, sections: 'H', expect: 'H6',
    label: 'a first stop is reported as a duplicate (idempotence set too early)',
    from: '  let state = \'running\';\n  let acceptedAt = 0;\n\n  const dispatchStop = function (req, res, fail) {\n',
    to: '  let state = \'stopping\';\n  let acceptedAt = 0;\n\n  const dispatchStop = function (req, res, fail) {\n'
  },
  {
    id: 'M4', file: LIFECYCLE, sections: 'D', expect: 'D5',
    label: 'the identity re-verification before the fallback kill is removed (a recycled pid gets killed)',
    from: '  if (!ownedByConstruction) {\n',
    to: '  if (false) {\n'
  },
  {
    id: 'M5', file: LIFECYCLE, sections: 'C', expect: 'C4',
    label: 'the cooperative wait is no longer bounded by its own budget (it runs to the absolute deadline instead)',
    from: '    const coopDeadline = Math.min(deadline, cooperativeRequestSentAt + (o.cooperativeMs || 6000));\n',
    to: '    const coopDeadline = Math.min(Number.MAX_SAFE_INTEGER, cooperativeRequestSentAt + (o.deadline - Date.now()) + 1);\n'
  },
  {
    id: 'M6', file: LIFECYCLE, sections: 'C', expect: 'C8',
    label: 'the cooperative wait is clamped to nothing, so a healthy stop becomes a kill',
    from: '    const released = await waitPortReleasedAndSilent(target, coopDeadline, o.stepMs);\n',
    to: '    const released = await waitPortReleasedAndSilent(target, Math.min(coopDeadline, Date.now() + 1), o.stepMs);\n'
  },
  {
    id: 'M7', file: LIFECYCLE, sections: 'C', expect: 'C9',
    label: 'the fallback kills without re-reading the identity',
    from: '  if (!stillTarget.reachable || !identifies(target, stillTarget.json)) {\n',
    to: '  if (false) {\n'
  },
  {
    id: 'M8', file: LIFECYCLE, sections: 'D', expect: 'D4',
    label: 'an unreadable command line is accepted as ownership proof',
    from: '      if (cmdline && o.ownsCommandLine(cmdline, o.root)) proof = \'command-line\';\n',
    to: '      proof = \'command-line\';\n'
  },
  {
    id: 'M9', file: LIFECYCLE, sections: 'E', expect: 'E2b',
    label: 'a listener that holds the port and answers nothing is called NOT_RUNNING',
    /* The anchor is the bindability short-circuit, not the report wording below
       it: the two UNKNOWN_OWNER reasons differ only in whether the OS listener
       list could be read, and E2b deliberately allows both (pidGone null OR
       false). Mutating the wording branch is therefore behaviourally equivalent
       in this fixture and can never go red — the rule this entry claims to test
       lives in `if (await portBindable(...))`, which is what must be removed
       for a mute port holder to be misreported as "nothing runs here". */
    from: '    if (await portBindable(target.port)) {\n',
    to: '    if (true) {\n'
  },
  {
    id: 'M10', file: LIFECYCLE, sections: 'D', expect: 'D5',
    label: 'the command-line proof is accepted before the candidate\'s command line is read (a recycled pid gets killed)',
    from: '    if (!cmdline || !o.ownsCommandLine(cmdline, o.root)) {\n',
    to: '    if (false) {\n'
  },
  {
    id: 'M11', file: LIFECYCLE, sections: 'C', expect: 'C3',
    label: '"stopped" no longer requires the pid to be gone',
    from: '    if (portFree && pidGone) {\n',
    to: '    if (portFree) {\n'
  },
  {
    id: 'M12', file: LIFECYCLE, sections: 'E', expect: 'E1',
    label: 'a partial-dead target stops the whole cycle',
    from: '  result.proof = proof;\n  if (!proof) {\n',
    to: '  if (o.provenOwn === true && !pid) { result.state = \'FAILED\'; result.reason = \'no pid\'; return result; }\n  result.proof = proof;\n  if (!proof) {\n'
  },
  {
    id: 'M13', file: CONTROL, sections: 'H', expect: 'H6',
    label: 'a second stop reports failure instead of already-stopping',
    from: '    if (state === \'stopping\') {\n',
    to: '    if (false) {\n'
  },
  {
    id: 'M14', file: INSTALLER, sections: 'I', expect: 'I2',
    label: 'the installer no longer checks the helper\'s exit code',
    from: '  if Code <> 0 then\n',
    to: '  if False then\n'
  },
  {
    id: 'M15', file: LIFECYCLE, sections: 'H', expect: 'H2',
    label: 'the stop report leaks a credential',
    from: '  const result = {\n    id: target.id,\n',
    to: '  const result = {\n    apiKey: \'sk-live-0123456789abcdef\',\n    id: target.id,\n'
  }
];

const sleepMs = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

(async function main() {
  log('P11-3H · mutation / falsification');
  log('原仓库（只读）: ' + ROOT);
  const ONLY = String(process.env.P11_3H_MUTATIONS || '').split(/[\s,]+/).filter(Boolean);
  const PLAN = ONLY.length ? MUTATIONS.filter(m => ONLY.indexOf(m.id) >= 0) : MUTATIONS;
  if (ONLY.length) log('只跑：' + PLAN.map(m => m.id).join(', '));
  buildSandbox();
  log('私有副本树: ' + SANDBOX + '\n');

  const baseline = runSuite('');
  const clean = baseline.code === 0 && /结果: \d+ \u901a\u8fc7, 0 \u5931\u8d25/.test(baseline.out);
  log((clean ? 'BASELINE GREEN' : 'BASELINE RED') + '  ' +
    ((baseline.out.match(/(\d+) \u901a\u8fc7, (\d+) \u5931\u8d25/) || []).join(' ')));
  if (!clean) {
    log('\nbaseline 不是绿的 —— 先修它，否则本文件无法证伪任何东西。');
    log(baseline.out.slice(-4000));
    process.exit(1);
  }
  log('');

  let caught = 0, escaped = 0, unexpected = 0;
  const results = [];

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
    /* A suite that crashed before it could name anything did not "stay green" —
       the mutation broke the file rather than the behaviour, and no rule was
       tested. That is UNEXPECTED. */
    const crashed = /SyntaxError|ReferenceError: Cannot access|MUTATION RUNNER CRASHED|UNEXPECTED FAILURE/.test(run.out) &&
      !/^  [\u2713\u2717]/m.test(run.out);
    if (crashed) {
      unexpected++;
      results.push({ id: m.id, status: 'UNEXPECTED', why: 'mutation produced a suite that does not load' });
      log('?? ' + m.id + '  UNEXPECTED（变异让套件根本加载不起来 —— 它不是行为破坏）  ' + m.label);
      log('    ' + (run.out.split('\n').find(l => /Error/.test(l)) || '').trim().slice(0, 200));
      restore(m.file);
      continue;
    }
    let red = run.code !== 0 || !/\u901a\u8fc7, 0 \u5931\u8d25/.test(run.out);
    let named = run.out.indexOf('\u2717 ' + m.expect) >= 0;
    let rerun = false;
    /* Judgement discipline (docs/INTERNALBEYOND_AI_RULES.md §15.3): "it went red
       but not for the named check" has two possible causes — the rule is not
       pinned, or this round was polluted by resources (this suite spawns dozens
       of real processes). Re-run WITH the mutation once before calling it
       ESCAPED. */
    if (red && !named) {
      rerun = true;
      sleepMs(1500);
      run = runSuite(m.sections);
      red = run.code !== 0 || !/\u901a\u8fc7, 0 \u5931\u8d25/.test(run.out);
      named = run.out.indexOf('\u2717 ' + m.expect) >= 0;
    }
    if (red && named) {
      caught++;
      results.push({ id: m.id, status: 'CAUGHT', by: m.expect, rerun: rerun });
      log('\u2714 ' + m.id + ' CAUGHT [' + m.expect + ']' + (rerun ? '（复跑；第一次被资源/环境污染）' : '') + '  ' + m.label);
    } else if (red) {
      escaped++;
      const failed = (run.out.match(/\u2717 [^\n]+/g) || []).slice(0, 4).join(' | ');
      results.push({ id: m.id, status: 'ESCAPED', why: 'red but not by ' + m.expect, failed: failed });
      log('\u2718 ' + m.id + ' ESCAPED（变红了，但不是由 ' + m.expect + ' 抓到的）  ' + m.label);
      log('    实际红项: ' + failed);
    } else {
      escaped++;
      results.push({ id: m.id, status: 'ESCAPED', why: 'suite stayed green' });
      log('\u2718 ' + m.id + ' ESCAPED（套件仍然全绿 —— 这条判据没有被执行钉住）  ' + m.label);
    }
    restore(m.file);
    sleepMs(400);
  }

  let drift = [];
  for (const rel of WATCHED) {
    const after = sha(fs.readFileSync(path.join(ROOT, rel.split('/').join(path.sep))));
    if (after !== watchBefore[rel]) drift.push(rel);
  }
  log('\n原仓库逐字节零漂移: ' + (drift.length === 0 ? 'YES' : 'NO -> ' + drift.join(', ')));

  try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch (_) { /* 句柄未释放 */ }
  removeFixturesNotIn(FIXTURES_BEFORE);

  log('\n结果：' + caught + ' CAUGHT / ' + escaped + ' ESCAPED / ' + unexpected + ' UNEXPECTED  （共 ' + PLAN.length + '）');
  if (escaped || unexpected) {
    log('明细：' + JSON.stringify(results.filter(r => r.status !== 'CAUGHT'), null, 2));
  }
  process.exit(caught === PLAN.length && drift.length === 0 ? 0 : 1);
})().catch(error => {
  console.error('MUTATION RUNNER CRASHED: ' + (error && error.stack || error));
  try { if (SANDBOX) fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch (_) { /* 句柄未释放 */ }
  removeFixturesNotIn(FIXTURES_BEFORE);
  setTimeout(() => process.exit(1), 200);
});
