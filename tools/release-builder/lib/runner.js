'use strict';

/*
 * InternalBeyond Release Builder · orchestration core.
 *
 * The state machine. One run at a time, five stages, three top-level states.
 *
 *   CHECK → BUILD → VERIFY → SEAL → [STOP: READY] → PUBLISH(separate) → PUBLISHED
 *
 * Hard rules enforced here (not in the GUI, so the GUI cannot lie about them):
 *   · a stage may only run when its predecessors are green (lib/plan.canRun);
 *   · BUILD never runs when CHECK is blocked, VERIFY/SEAL never run when BUILD
 *     is blocked, SEAL never runs when VERIFY is blocked;
 *   · PUBLISH requires a separate action list AND a confirmation bound to the
 *     artifact fingerprint (lib/publish.confirmToken);
 *   · DRY RUN performs no write at all — no version bump, no build, no manifest
 *     change, no dist move, no tag, no push, no upload.
 */

const path = require('path');

const canonical = require('./canonical.js');
const plan = require('./plan.js');
const notes = require('./notes.js');
const runLog = require('./log.js');
const checkStage = require('./check.js');
const buildStage = require('./build.js');
const verifyStage = require('./verify.js');
const sealStage = require('./seal.js');
const publishStage = require('./publish.js');
const git = require('./git.js');

const { STAGE_STATUS, STATUS } = plan;

/* The checksums record the canonical build writes beside the installer
   (docs/RELEASE.md §1). It is a record for humans; clients never read it. */
const SUMS_FILE = 'SHA256SUMS' + '.txt';

/*
 * The facts the presentation layer is allowed to see.
 *
 * This is a WHITELIST, not a projection of everything: `results[name].facts` is
 * an internal channel between stages, and only the named keys below are needed
 * to answer "what is the state of this release?" on screen. Everything here is
 * already computed by a stage — nothing in this list is recomputed, and no
 * status is derived from it (statuses come from the log roll-up, as always).
 */
const RELEASE_FACTS = [
  'artifact', 'threeWayOk', 'reread',
  'buildExitCode', 'buildMs', 'rolledBack',
  'dirtyPaths', 'notesFile', 'versionPlan', 'published', 'probeSkipped',
  'distManifestVersion', 'readmeVersion', 'sourceVersion', 'expectedAsset'
];

function emptyStages() {
  const out = {};
  for (const s of plan.STAGES) out[s] = { status: STAGE_STATUS.PENDING, at: null };
  return out;
}

class Runner {
  constructor(opts) {
    const o = opts || {};
    this.root = o.root || null;
    this.repo = null;
    this.openError = null;
    if (this.root) {
      try { this.repo = canonical.open(this.root); }
      catch (e) { this.openError = { message: String((e && e.message) || e), missing: e.missing || [], root: e.root || this.root }; }
    }
    this.log = runLog.createLog({ maxLines: 20000 });
    this.stages = emptyStages();
    this.options = {
      target: '',
      channel: 'stable',
      archiveOldReleases: true,
      regenerateManifest: false,
      releasedAt: '',
      minimumVersion: plan.CANONICAL_MINIMUM_VERSION,
      probeNetwork: false,
      acknowledge: {}
    };
    this.startedAt = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    this.running = null;      /* { stage, abort:AbortController } */
    this.results = {};        /* stage → { status, blockers, facts } */
    /* Whitelisted, accumulated, read-only release facts for the presentation
       layer. Never used to decide anything: statuses come from the log. */
    this.releaseFacts = { facts: {} };
    this.lastError = null;
    this.attempted = { BUILD: false, VERIFY: false, SEAL: false, PUBLISH: false };
    this.version = null;
    /* The version the repository was at when the current BUILD started. SEAL
       uses it to protect that version's artifact from the archive step. */
    this.versionAtBuildStart = null;
  }

  /** Re-open the checkout (used when the GUI changes the root). */
  describe() {
    const v = this.repo ? this.repo.version() : { ok: false, version: '', error: 'no checkout' };
    this.version = v;
    const head = this.repo ? git.head(this.repo.root) : { ok: false, commit: '' };
    return {
      ok: !!this.repo,
      openError: this.openError,
      root: this.root,
      version: v.ok ? v.version : '',
      versionOk: v.ok,
      versionError: v.error,
      commit: head.commit || '',
      branch: this.repo ? git.branch(this.repo.root) : '',
      upstream: this.repo ? ('origin/' + (git.branch(this.repo.root) || 'master')) : '',
      rootName: this.root ? path.basename(this.root) : '',
      channels: plan.CHANNELS,
      channelLabels: plan.CHANNEL_LABELS,
      minimumVersionPolicy: plan.CANONICAL_MINIMUM_VERSION,
      canonicalBuilder: this.repo ? path.join(this.repo.root, 'scripts', 'build-installer.ps1') : '',
      canonicalManifest: this.repo ? path.join(this.repo.root, 'runtime', 'update-manifest.js') : '',
      tool: {
        node: process.version,
        execPath: process.execPath,
        pid: process.pid
      }
    };
  }

  configured() {
    return !!(this.repo && this.options.target);
  }

  /**
   * Throw away everything a previous run produced and start clean, keeping the
   * open checkout. One method, so the server can never reset half the state:
   * a stale `releaseFacts` after a RESET would let the GUI show a SEAL result
   * from a run the user just discarded.
   */
  resetRun() {
    const fresh = new Runner({ root: this.root });
    this.stages = fresh.stages;
    this.results = {};
    this.releaseFacts = fresh.releaseFacts;
    this.attempted = fresh.attempted;
    this.log = fresh.log;
    this.running = null;
    this.lastError = null;
    this.versionAtBuildStart = null;
    return this;
  }

  setOptions(patch) {
    const p = patch || {};
    if (typeof p.target === 'string') this.options.target = p.target.trim();
    if (typeof p.channel === 'string') this.options.channel = p.channel;
    if (typeof p.archiveOldReleases === 'boolean') this.options.archiveOldReleases = p.archiveOldReleases;
    if (typeof p.regenerateManifest === 'boolean') this.options.regenerateManifest = p.regenerateManifest;
    if (typeof p.releasedAt === 'string') this.options.releasedAt = p.releasedAt.trim();
    if (typeof p.minimumVersion === 'string') this.options.minimumVersion = p.minimumVersion.trim();
    if (typeof p.probeNetwork === 'boolean') this.options.probeNetwork = p.probeNetwork;
    if (p.acknowledge && typeof p.acknowledge === 'object') this.options.acknowledge = p.acknowledge;
    /*
     * COUNTERPROOF-ONLY. `fault` injects a deliberate defect so the tests can
     * prove that a bad artifact really does turn READY into BLOCKED. It is
     * refused unless the process was started with
     * IB_RELEASE_BUILDER_ALLOW_FAULT=1, which only the test files set — so the
     * shipped tool has no reachable path that can inject a fault.
     */
    if (p.fault) {
      if (process.env.IB_RELEASE_BUILDER_ALLOW_FAULT === '1') this.options.fault = String(p.fault);
      else this.log.warn('fault-injection-refused', 'fault injection was requested without IB_RELEASE_BUILDER_ALLOW_FAULT=1 and was ignored', {});
    }
    if (p.fault === null) delete this.options.fault;
    return this.options;
  }

  /**
   * Run one stage. Never throws: a failure is a BLOCKED result.
   * Returns { ok, status, blockers }.
   */
  async runStage(name, extra) {
    if (!plan.STAGES.includes(name)) return { ok: false, status: STAGE_STATUS.BLOCKED, blockers: [{ code: 'unknown-stage', why: name }] };
    if (this.running) return { ok: false, status: STAGE_STATUS.BLOCKED, blockers: [{ code: 'busy', why: 'another stage is running: ' + this.running.stage }] };
    if (!this.repo) {
      this.log.item(name + ':no-repo', { stage: name, status: STAGE_STATUS.BLOCKED, title: '仓库根目录', expected: '一个 InternalBeyond 检出', actual: this.openError ? this.openError.message : 'no root', evidence: 'tools/release-builder', why: '先选定正确的仓库根目录' });
      this.stages[name] = { status: STAGE_STATUS.BLOCKED, at: new Date().toISOString() };
      return { ok: false, status: STAGE_STATUS.BLOCKED, blockers: [{ code: 'no-repo', why: 'no checkout open' }] };
    }

    const dryRun = extra && extra.dryRun === true;
    const statuses = {};
    for (const s of plan.STAGES) statuses[s] = this.stages[s].status;
    const gate = plan.canRun(name, statuses);
    if (!gate.ok && !dryRun) {
      this.log.item(name + ':gate', { stage: name, status: STAGE_STATUS.BLOCKED, title: '阶段前置', expected: '允许运行', actual: gate.why, evidence: 'lib/plan.js TRANSITIONS', why: 'Fail closed：前置阶段没有通过时，后续阶段一律不跑' });
      this.stages[name] = { status: STAGE_STATUS.BLOCKED, at: new Date().toISOString() };
      return { ok: false, status: STAGE_STATUS.BLOCKED, blockers: [{ code: 'stage-gate', why: gate.why }] };
    }

    const abort = new AbortController();
    this.running = { stage: name, abort: abort, dryRun: dryRun };
    this.stages[name] = { status: STAGE_STATUS.RUNNING, at: new Date().toISOString() };
    this.log.stage(name, { target: this.options.target, channel: this.options.channel, dryRun: dryRun });

    /* Remember the pre-build version: the artifact it names must survive SEAL's
       archive step, because it may be the published release's bytes. */
    if (name === 'BUILD') {
      const v0 = this.repo.version();
      this.versionAtBuildStart = v0.ok ? v0.version : null;
    }

    const ctx = {
      repo: this.repo,
      log: this.log,
      options: Object.assign({}, this.options, extra || {}),
      signal: abort.signal,
      commit: git.head(this.repo.root).commit || '',
      sourceVersion: this.repo.version().ok ? this.repo.version().version : '',
      stageStatuses: statuses
    };

    /* BUILD and VERIFY must agree on WHICH release-notes file this release
       declares, otherwise VERIFY would compare the manifest against a file the
       build never used and report a difference that is not one. The path is
       decided once, here, and carried in the context for both stages. */
    const notesTarget = String(this.options.target || '').trim();
    ctx.notesFile = notesTarget
      ? notes.pathFor(this.repo.root, notesTarget)
      : '';
    ctx.notesFileExists = ctx.notesFile ? require('fs').existsSync(ctx.notesFile) : false;

    let res = null;
    try {
      if (name === 'CHECK') res = await checkStage.run(ctx);
      else if (name === 'BUILD') res = await buildStage.run(ctx);
      else if (name === 'VERIFY') res = await verifyStage.run(ctx);
      else if (name === 'SEAL') res = await sealStage.run(ctx);
      else if (name === 'PUBLISH') res = await publishStage.run(ctx);
    } catch (e) {
      /* A stage that throws is a blocked stage: never a warning, never a
         success, and never a reason to continue. The message is kept verbatim
         (minus the stack) so the cause is visible rather than generic. */
      const msg = String((e && e.message) || e);
      const stack = String((e && e.stack) || '').split('\n').slice(0, 6).join('\n');
      this.log.item(name + ':exception', {
        stage: name, status: STAGE_STATUS.BLOCKED, title: '阶段内部异常', expected: '正常完成',
        actual: (e && e.constructor && e.constructor.name ? e.constructor.name + ': ' : '') + msg,
        evidence: 'lib/runner.js', why: '异常一律 fail closed（绝不当作警告或成功）', detail: stack
      });
      res = { status: STAGE_STATUS.BLOCKED, blockers: [{ code: 'stage-exception', why: msg }], facts: {} };
    } finally {
      this.running = null;
    }

    this.results[name] = res;
    /*
     * Facts are accumulated per stage but merged across stages: BUILD's exit
     * code must not be forgotten just because VERIFY ran afterwards. Only the
     * whitelisted keys (RELEASE_FACTS) ever leave this process, and only the
     * presentation layer reads them.
     */
    const prevFacts = (this.releaseFacts && this.releaseFacts.facts) || {};
    const merged = Object.assign({}, prevFacts);
    for (const k of RELEASE_FACTS) {
      if (!Object.prototype.hasOwnProperty.call(res.facts || {}, k)) continue;
      const v = res.facts[k];
      if (v !== undefined) merged[k] = v;
    }
    this.releaseFacts = { facts: merged };
    /*
     * A stage that produced WARNINGS still succeeded: it ran, it measured, and
     * it found nothing that invalidates the release — but a human has to read
     * the warning, so its status stays `warn` rather than `ok`. The next stage
     * may therefore proceed from `warn` (lib/plan.js TRANSITIONS); only a
     * BLOCKED stage stops the run.
     *
     * A stage that reports no items at all is never OK: it proved nothing.
     */
    const items = this.log.items().filter(function (i) { return i.stage === name; });
    let status = res.status;
    if (status !== STAGE_STATUS.BLOCKED) {
      if (!items.length) status = STAGE_STATUS.BLOCKED;
      else if (items.some(function (i) { return i.status === STAGE_STATUS.BLOCKED; })) status = STAGE_STATUS.BLOCKED;
      else if (items.some(function (i) { return i.status === STAGE_STATUS.WARN; })) status = STAGE_STATUS.WARN;
      else status = STAGE_STATUS.OK;
    }
    if (dryRun && status === STAGE_STATUS.OK) status = STAGE_STATUS.DRY;
    this.stages[name] = { status: status, at: new Date().toISOString(), blockers: (res.blockers || []).length };

    /* BLOCKED anywhere poisons the run: later stages must not proceed. */
    if (status === STAGE_STATUS.BLOCKED) {
      const idx = plan.STAGES.indexOf(name);
      for (let i = idx + 1; i < plan.STAGES.length; i++) {
        const later = plan.STAGES[i];
        if (this.stages[later].status === STAGE_STATUS.PENDING) {
          this.stages[later] = { status: STAGE_STATUS.BLOCKED, at: new Date().toISOString(), blockers: 0, cascaded: true };
          this.log.item(later + ':cascade', { stage: later, status: STAGE_STATUS.BLOCKED, title: '阶段被上游失败级联阻断', expected: '上游全绿', actual: name + ' = BLOCKED', evidence: 'lib/runner.js', why: 'Fail closed' });
        }
      }
    }

    return { ok: status === STAGE_STATUS.OK || status === STAGE_STATUS.WARN || status === STAGE_STATUS.DRY, status: status, blockers: res.blockers || [] };
  }

  /** The one-click path: CHECK → BUILD → VERIFY → SEAL → STOP. Never PUBLISH. */
  async runOneClick(extra) {
    const out = [];
    for (const s of plan.oneClickStages()) {
      const stageExtra = Object.assign({}, extra || {});
      if (s === 'SEAL') {
        stageExtra.protectedVersions = [this.versionAtBuildStart].filter(Boolean);
      }
      const r = await this.runStage(s, stageExtra);
      out.push({ stage: s, status: r.status });
      if (r.status === STAGE_STATUS.BLOCKED) break;
    }
    return out;
  }

  /** Dry run: CHECK + a complete plan, with zero side effects. */
  async runDryRun() {
    const steps = [];
    /* Capture the pre-build version BEFORE CHECK: a dry run makes no changes, so
       this is the version whose artifact the real SEAL would protect. */
    const v0 = this.repo ? this.repo.version() : { ok: false, version: '' };
    const protect = v0.ok ? [v0.version] : [];
    const r = await this.runStage('CHECK', { dryRun: true });
    steps.push({ stage: 'CHECK', status: r.status });
    if (r.status === STAGE_STATUS.BLOCKED) {
      return { ok: false, steps: steps, plan: null };
    }
    const planOut = this.dryRunPlan({ protectedVersions: protect });
    /*
     * A dry run produces NO sealed state. It therefore reports the two facts
     * that are true and nothing more:
     *   · BUILD ran in dry mode (stage status `dry`, never `ok`);
     *   · VERIFY / SEAL / PUBLISH were not executed at all and stay PENDING, so
     *     the top-level status can never become READY or PUBLISHED from a dry
     *     run — which is exactly the guarantee the user asked for.
     */
    this.stages.BUILD = { status: STAGE_STATUS.DRY, at: new Date().toISOString() };
    steps.push({ stage: 'BUILD', status: STAGE_STATUS.DRY });
    steps.push({ stage: 'VERIFY', status: STAGE_STATUS.PENDING });
    steps.push({ stage: 'SEAL', status: STAGE_STATUS.PENDING });
    steps.push({ stage: 'PUBLISH', status: STAGE_STATUS.PENDING });
    this.log.item('dry-run', {
      stage: 'CHECK', status: STAGE_STATUS.DRY, title: 'DRY RUN：零副作用计划',
      expected: '不写任何文件、不构建、不改清单、不移动 dist、不 tag、不 push、不 upload',
      actual: '仅生成计划；VERIFY / SEAL / PUBLISH 保持未运行', evidence: 'lib/runner.js runDryRun()',
      detail: planOut.text
    });
    return { ok: true, steps: steps, plan: planOut };
  }

  /**
   * The complete plan for a dry run. Pure projection of what the real run WOULD
   * do — computed from the current tree, with no I/O beyond reading it.
   * `opts.protectedVersions` are the versions the real SEAL would refuse to
   * archive (the bytes a published release may still need).
   */
  dryRunPlan(opts) {
    const planOpts = opts || {};
    const protectedVersions = new Set((planOpts.protectedVersions || []).filter(Boolean).map(String));
    const repo = this.repo;
    const o = this.options;
    const target = o.target;
    const v = repo.version();
    const current = v.ok ? v.version : '';
    const dist = path.join(repo.root, 'dist');

    const bump = buildStage.planBump(repo.root, current, target);
    const buildArgs = buildStage.canonicalBuildArgs(repo, {
      notesFile: notes.pathFor(repo.root, target),
      minimumVersion: o.minimumVersion
    });
    const envMod = require('./env.js');
    const buildCmd = envMod.commandLine(envMod.pwsh() || 'powershell.exe', buildArgs);

    /* What dist currently holds, and what SEAL's archive step would move. The
       recognition rule is the canonical one (seal.assetVersionOf), so no second
       asset-name spelling exists anywhere in this tool. */
    const sealMod = require('./seal.js');
    let existing = [];
    let keptProtected = [];
    try {
      for (const n of require('fs').readdirSync(dist)) {
        const found = sealMod.assetVersionOf(repo, n);
        if (!found || found === target) continue;
        if (protectedVersions.has(found)) keptProtected.push(n);
        else existing.push(n);
      }
    } catch (e) { existing = []; keptProtected = []; }

    const publishPlan = publishStage.buildPlan(repo, { target: target, remote: o.remote || 'origin' });

    const filesWritten = [];
    for (const f of bump.files) {
      filesWritten.push({
        path: path.relative(repo.root, f.file).split(path.sep).join('/'),
        change: f.kind === 'version' ? (f.from + ' → ' + f.to) : ('当前版本 **' + f.from + '** → 当前版本 **' + f.to + '**')
      });
    }
    filesWritten.push({ path: 'dist/' + repo.assetName(target), change: '新建（canonical ISCC 编译产物）' });
    filesWritten.push({ path: 'dist/' + SUMS_FILE, change: '重写（canonical 第 6 步）' });
    filesWritten.push({
      path: 'dist/' + repo.payloadManifestAsset,
      change: o.regenerateManifest ? '重新生成（canonical 生成器，含 releasedAt）' : '重写（canonical 第 7 步）'
    });
    filesWritten.push({ path: 'dist/build-compile.log', change: '重写（ISCC 输出）' });
    filesWritten.push({ path: 'dist/release-' + target + '.log (+ .jsonl)', change: '新建（本次发行日志，已脱敏）' });

    const lines = [];
    lines.push('=== DRY RUN · 零副作用计划 ===');
    lines.push('');
    lines.push('仓库根      : ' + repo.root);
    lines.push('当前版本    : ' + current);
    lines.push('目标版本    : ' + target + '   (通道 ' + (plan.CHANNEL_LABELS[o.channel] || o.channel) + ')');
    lines.push('将生成的产物: dist/' + repo.assetName(target));
    lines.push('将使用的 tag: ' + repo.tagFor(target));
    lines.push('清单 URL    : ' + repo.urlFor(target));
    lines.push('');
    lines.push('--- 版本计划 ---');
    if (bump.blockers.length) {
      for (const b of bump.blockers) lines.push('  BLOCKED ' + b.code + ' — ' + b.why);
    } else if (o.target === current) {
      lines.push('  目标版本 == 当前版本：不修改 VERSION / README');
    } else {
      lines.push('  VERSION: ' + current + ' → ' + target);
      lines.push('  README.md: 当前版本 **' + current + '** → 当前版本 **' + target + '**（唯一手改字面量）');
    }
    lines.push('');
    lines.push('--- 将调用的 canonical build path（唯一构建权威）---');
    lines.push('  ' + buildCmd);
    lines.push('  （不传 -ReleasedAt；不使用 -SkipAudit / -SkipInstallAudit）');
    lines.push('');
    lines.push('--- 将写入/覆盖的文件 ---');
    for (const f of filesWritten) lines.push('  ' + f.path + '   ' + f.change);
    lines.push('');
    lines.push('--- dist 归档（旧版本安装包）---');
    if (o.archiveOldReleases === false) lines.push('  已关闭：不移动任何文件');
    else if (!existing.length && !keptProtected.length) lines.push('  没有可归档的旧安装包');
    else {
      for (const n of existing) lines.push('  dist/' + n + ' → dist/archive/' + /(\d+\.\d+\.\d+)/.exec(n)[1] + '/' + n);
      for (const n of keptProtected) {
        lines.push('  dist/' + n + ' — 受保护，不归档（它可能是已发布版本的那一份字节；' +
          'docs/RELEASE.md §6 禁止用重建产物替代）');
      }
    }
    lines.push('');
    lines.push('--- VERIFY 将复核 ---');
    lines.push('  四等式（从最终产物字节重算）：sha256 / sizeBytes / PE ProductVersion / URL 资产名');
    lines.push('  canonical validate()；U1–U5 不变量；release-claim 闸门；载荷白名单');
    lines.push('');
    lines.push('--- PUBLISH 将执行的动作（默认不执行，需要单独确认）---');
    for (const a of publishPlan.actions) {
      lines.push('  ' + (a.irreversible ? '[不可逆] ' : '[本地]   ') + a.command);
    }
    lines.push('  fingerprint: ' + publishPlan.fingerprint);
    if (publishPlan.blockers.length) {
      lines.push('  当前不满足的前置条件：');
      for (const b of publishPlan.blockers) lines.push('    - ' + b.code + ' — ' + b.why);
    }
    lines.push('');
    lines.push('--- DRY RUN 保证 ---');
    lines.push('  未修改 VERSION / README；未启动构建；未改清单；未移动 dist 文件；未 tag；未 push；未 upload。');

    return {
      current: current,
      target: target,
      channel: o.channel,
      artifactName: repo.assetName(target),
      tag: repo.tagFor(target),
      manifestUrl: repo.urlFor(target),
      buildCommand: buildCmd,
      filesWritten: filesWritten,
      archive: existing.map(function (n) {
        return { from: 'dist/' + n, to: 'dist/archive/' + /(\d+\.\d+\.\d+)/.exec(n)[1] + '/' + n };
      }),
      archiveProtected: keptProtected.slice(),
      publishActions: publishPlan.actions.map(function (a) { return { id: a.id, command: a.command, irreversible: a.irreversible }; }),
      publishBlockers: publishPlan.blockers,
      publishFingerprint: publishPlan.fingerprint,
      notesFile: notes.relFor(repo.root, target),
      notesFileExists: require('fs').existsSync(notes.pathFor(repo.root, target)),
      text: lines.join('\n')
    };
  }

  /** The GUI snapshot. `logSince` pages the log; items are always complete. */
  snapshot(logSince) {
    const desc = this.describe();
    const logView = this.log.view({ since: typeof logSince === 'number' ? logSince : 0 });
    const statuses = {};
    for (const s of plan.STAGES) statuses[s] = this.stages[s];
    const stateForTop = { stages: statuses, blockers: this.log.blockers() };
    const target = String(this.options.target || '').trim();
    const notesAbs = notes.pathFor(this.root, target);
    return {
      tool: 'InternalBeyond Release Builder',
      toolVersion: 'R2',
      describe: desc,
      options: this.options,
      stages: statuses,
      status: plan.topStatus(stateForTop),
      running: this.running ? { stage: this.running.stage, dryRun: this.running.dryRun } : null,
      attempted: this.attempted,
      /* Read-only release facts. `notes` is what the GUI needs to offer an
         editor for the canonical file without inventing its own path rule. */
      facts: this.releaseFacts.facts,
      notes: {
        target: target,
        path: notesAbs ? path.relative(this.root, notesAbs).split(path.sep).join('/') : '',
        file: notesAbs,
        editing: false
      },
      log: logView,
      results: Object.keys(this.results).reduce((acc, k) => {
        const r = this.results[k];
        acc[k] = { status: r.status, blockers: (r.blockers || []).map(function (b) { return { code: b.code, why: b.why || b.title || '' }; }) };
        return acc;
      }, {}),
      startedAt: this.startedAt,
      now: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
    };
  }

  exportLog() {
    const desc = this.describe();
    const stateForTop = { stages: this.stages, blockers: this.log.blockers() };
    return this.log.render({
      tool: 'InternalBeyond Release Builder R1',
      root: this.root || '(none)',
      commit: desc.commit,
      sourceVersion: desc.version,
      targetVersion: this.options.target,
      channel: this.options.channel,
      mode: this.running && this.running.dryRun ? 'DRY RUN' : 'REAL',
      status: plan.topStatus(stateForTop)
    });
  }

  cancel() {
    if (this.running) {
      try { this.running.abort.abort(); } catch (e) { /* ignore */ }
      this.log.event('cancellation requested for ' + this.running.stage);
      return true;
    }
    return false;
  }
}

module.exports = { Runner, emptyStages };
