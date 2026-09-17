'use strict';

/*
 * InternalBeyond · Release Builder — presentation layer.
 *
 * RENDERS. It does not decide.
 *
 * Every rule this screen obeys already lives in Node: which stages may run
 * (lib/plan.js canRun), what each status means (lib/plan.js TRANSITIONS), what
 * the installer/checksum/manifest files are called (lib/canonical.js), and
 * whether a release may be published (lib/publish.js). Nothing here recomputes
 * a verdict, and nothing here can start a stage the backend would refuse.
 *
 * What R2 changed, and why:
 *   · the screen now answers, at a glance and in one sentence each, the eight
 *     questions a person actually has before a release: which version, which
 *     target, is the tree clean, are the notes written, and where CHECK / BUILD
 *     / VERIFY / SEAL stand;
 *   · every failure is translated into an instruction ("版本号没有增加") with the
 *     backend's raw evidence one click away, instead of being printed as a
 *     forty-line console;
 *   · the log, the item table and the fingerprints are still here, but behind
 *     「详细日志」 and the item's own disclosure — never in the way.
 *
 * Safety: all dynamic text goes through textContent or a textContent-based
 * helper. Nothing the backend sends is ever parsed as HTML.
 */

(function () {
  var TOKEN = new URLSearchParams(location.search).get('token') || '';
  if (TOKEN) {
    /* Keep the token out of the address bar without breaking a reload. */
    try { sessionStorage.setItem('ib-release-token', TOKEN); } catch (e) { /* ignore */ }
    history.replaceState(null, '', location.pathname);
  } else {
    try { TOKEN = sessionStorage.getItem('ib-release-token') || ''; } catch (e) { TOKEN = ''; }
  }

  var STAGE_ORDER = ['CHECK', 'BUILD', 'VERIFY', 'SEAL'];
  var STAGE_TITLE = { CHECK: '检查', BUILD: '构建', VERIFY: '验证', SEAL: '封装', PUBLISH: '发布' };
  var STAGE_PLAIN = {
    CHECK: '检查仓库能不能发',
    BUILD: '调用仓库唯一的构建权威',
    VERIFY: '从产物字节重算并与清单对账',
    SEAL: '治理 dist、写发行日志、三方对账'
  };
  var STATUS_WORD = {
    pending: '待运行', running: '进行中', ok: '已完成', warn: '已完成（有需知项）',
    blocked: '失败', skipped: '已跳过', dry: '仅预演'
  };

  var STATE = {
    snapshot: null,
    logSeq: 0,
    logLines: [],
    notes: null,
    notesBusy: false,
    publishPlan: null,
    dryPlan: null,
    problems: [],
    busy: false
  };

  var KIND = {
    blocked: { cls: '', mark: '!', label: '阻断' },
    warn: { cls: 'warn', mark: '!', label: '需知' }
  };

  function el(id) { return document.getElementById(id); }

  function h(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }

  /* ── formatting ────────────────────────────────────────────────────────── */

  function bytes(n) {
    var v = Number(n);
    if (!isFinite(v) || v <= 0) return '—';
    if (v < 1024) return v + ' B';
    if (v < 1048576) return (v / 1024).toFixed(1) + ' KB（' + v.toLocaleString('en-US') + ' 字节）';
    return (v / 1048576).toFixed(2) + ' MB（' + v.toLocaleString('en-US') + ' 字节）';
  }

  function seconds(ms) {
    var v = Number(ms);
    if (!isFinite(v) || v <= 0) return '';
    if (v < 1000) return v + ' 毫秒';
    if (v < 60000) return (v / 1000).toFixed(1) + ' 秒';
    var m = Math.floor(v / 60000);
    return m + ' 分 ' + Math.round((v % 60000) / 1000) + ' 秒';
  }

  function clockOf(iso) {
    var m = /T(\d{2}:\d{2}:\d{2})/.exec(String(iso || ''));
    return m ? m[1] : '';
  }

  function ago(iso) {
    var t = Date.parse(String(iso || ''));
    if (!isFinite(t)) return '';
    var d = Math.max(1, Math.round((Date.now() - t) / 1000));
    if (d < 60) return d + ' 秒前';
    if (d < 3600) return Math.round(d / 60) + ' 分钟前';
    if (d < 86400) return Math.round(d / 3600) + ' 小时前';
    return Math.round(d / 86400) + ' 天前';
  }

  /* ── reading the snapshot ──────────────────────────────────────────────── */

  function nextPatch(v) {
    var m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(v || ''));
    return m ? m[1] + '.' + m[2] + '.' + (Number(m[3]) + 1) : '';
  }

  function items(stage) {
    var s = STATE.snapshot;
    var all = (s && s.log && s.log.items) || [];
    return all.filter(function (i) { return !stage || i.stage === stage; });
  }

  /*
   * The backend scopes an item key by its stage (lib/log.js item(): `scopedKey =
   * stage + ':' + key`), and the snapshot hands the GUI that scoped form. Every
   * lookup here therefore takes a BARE key and the stage it belongs to, and this
   * is the one place that reconciles the two spellings — a map keyed
   * 'CHECK:release-notes' must not be searched with 'release-notes' in one place
   * and 'CHECK:release-notes' in another, which is exactly how a name lookup
   * silently degrades to raw backend text.
   */
  function bareKey(stage, key) {
    var k = String(key || '');
    if (stage && k.indexOf(stage + ':') === 0) return k.slice(stage.length + 1);
    var cut = k.indexOf(':');
    return cut > 0 ? k.slice(cut + 1) : k;
  }

  function itemAt(key, stage) {
    var want = String(key || '');
    var hit = null;
    items().forEach(function (i) {
      if (hit) return;
      if (i.key === want) { hit = i; return; }
      if (bareKey(i.stage, i.key) === bareKey(stage || '', want) && (!stage || i.stage === stage)) hit = i;
    });
    return hit;
  }

  function facts() { return (STATE.snapshot && STATE.snapshot.facts) || {}; }

  function stageStatus(name) {
    var s = STATE.snapshot;
    return (s && s.stages && s.stages[name] && s.stages[name].status) || 'pending';
  }

  function isGreen(name) {
    var st = stageStatus(name);
    return st === 'ok' || st === 'warn';
  }

  function anyAttempted() {
    var s = STATE.snapshot;
    if (!s) return false;
    var st = s.stages || {};
    return STAGE_ORDER.some(function (n) { return st[n] && st[n].status !== 'pending'; });
  }

  function target() {
    var s = STATE.snapshot;
    return String((s && s.options && s.options.target) || '').trim();
  }

  function currentVersion() {
    var s = STATE.snapshot;
    return (s && s.describe && s.describe.version) || '';
  }

  /* The version of the four-stage flow, in the words the user needs. */
  function displayStatus() {
    var s = STATE.snapshot;
    if (!s) return 'IDLE';
    if (s.running) return 'RUNNING';
    var top = s.status;
    if (top === 'PUBLISHED') return 'PUBLISHED';
    if (top === 'READY') return 'READY';
    if (!anyAttempted()) return 'IDLE';
    /* BLOCKED with nothing attempted is not a verdict, it is the absence of one;
       reporting "RELEASE BLOCKED" before anything ran would be a lie. */
    var hasBlocker = (s.log && s.log.blockers || []).length > 0;
    var hasWarn = (s.log && s.log.warnings || []).length > 0;
    if (!hasBlocker && hasWarn) return 'WARN';
    return 'BLOCKED';
  }

  /* ── plain-language failure translation ────────────────────────────────── */

  var PROBLEM = {
    'CHECK:plan-target-version': {
      title: '目标版本号不合法',
      why: '目标版本必须是 MAJOR.MINOR.PATCH，例如 1.0.6。',
      fix: '在顶部「目标版本」里改成三段式版本号。'
    },
    'CHECK:git-clean': {
      title: '工作区还有未提交的修改',
      why: '有已跟踪文件被改动，发行提交只带 VERSION 与 README，这些修改不会被带进去。',
      fix: '提交或撤销这些改动，然后重新「检查」。'
    },
    'CHECK:git-untracked': {
      title: '工作区有未跟踪文件',
      why: '未跟踪文件不会被提交，也不会被打进安装包；如果它们属于本次发行，需要先纳入。',
      fix: '确认这些文件是否属于本次发行；不属于可以忽略。'
    },
    'CHECK:release-notes': {
      title: '缺少 %TARGET% 的 Release Notes',
      why: 'docs/release-notes/%TARGET%.md 不存在，清单会省略 notes，用户更新卡片看不到更新说明。',
      fix: '点「编辑发行说明」直接写，保存后会创建这个文件。'
    },
    'CHECK:readme-claim': {
      title: 'README 的「当前版本」与 VERSION 不一致',
      why: 'canonical 构建第 4 步的 release-claim 闸门要求两者相同，且这一处必须由人改。',
      fix: '把 README 里的「当前版本 **x.y.z**」改成与 VERSION 一致。'
    },
    'CHECK:file:VERSION': {
      title: 'VERSION 不合规',
      why: '仓库的 VERSION 文件缺失或内容不是 MAJOR.MINOR.PATCH。',
      fix: '检查仓库根目录的 VERSION 文件。'
    },
    'CHECK:git-head': {
      title: '仓库 HEAD 不可用',
      why: '读不到当前提交，无法确认这次发行基于哪个版本。',
      fix: '确认这是一个 git 检出且 HEAD 正常。'
    },
    'CHECK:repo-root': {
      title: '没有找到 InternalBeyond 检出',
      why: '工具需要指向包含 VERSION 与 scripts/build-installer.ps1 的仓库根目录。',
      fix: '把工具放在 <仓库>\\tools\\ 下运行，或用 IB_RELEASE_ROOT 指定仓库根。'
    },
    'CHECK:tag-exists': {
      title: 'GitHub tag 已存在',
      why: 'tag %TAG% 已经存在（本地）。同一个版本号不能发布两次。',
      fix: '换一个目标版本，或先确认那个 tag 是否属于未完成的发布。'
    },
    'BUILD:canonical-command': {
      title: '安装包构建失败',
      why: 'canonical 构建（scripts\\build-installer.ps1）退出码非 0。构建是唯一构建权威，这一步失败就不再往下走。',
      fix: '展开原始输出看 ISCC / 脚本报错；修好后重新「构建 Release」。'
    },
    'BUILD:bump-version': {
      title: '版本号没有增加',
      why: '目标版本必须严格大于 VERSION 里的当前版本，否则会覆盖已发布产物或用降级版本喂给客户端。',
      fix: '把目标版本改成比当前版本更大的版本号。'
    },
    'BUILD:release-claim': {
      title: 'README 发行声明未通过闸门',
      why: 'canonical 构建要求 README 的「当前版本」与 VERSION 一致。',
      fix: '按上面的提示改 README，然后重新构建。'
    },
    'VERIFY:F-sha256': {
      title: 'SHA256 校验失败',
      why: '从最终产物字节重算的 sha256 与清单/SHA256SUMS 里的值不一致。',
      fix: '产物与清单不是同一次构建的结果。重置后重新完整构建一次。'
    },
    'VERIFY:F-size': {
      title: '产物大小与清单不一致',
      why: '磁盘上的安装包字节数与清单记录的 sizeBytes 不同。',
      fix: '重置后重新完整构建一次。'
    },
    'VERIFY:G-notes': {
      title: '清单里的更新说明与 Release Notes 文件不一致',
      why: '构建之后发行说明被改动过，清单仍然带着旧文案。',
      fix: '重置后重新运行「构建 Release」，让清单重新读取这份说明。'
    },
    'VERIFY:E-manifest': {
      title: '更新清单不合法',
      why: 'dist/update-stable.json 没有通过 canonical 校验。',
      fix: '重置后重新完整构建一次。'
    },
    'SEAL:three-way': {
      title: '封装三方对账失败',
      why: '安装包、SHA256SUMS、update-stable.json 三者互相对不上，不能宣布已封装。',
      fix: '重置后重新完整构建一次。'
    },
    'SEAL:layout-gate': {
      title: 'dist 布局不能安全治理',
      why: '有文件依赖 dist 的扁平布局，归档旧安装包会破坏它。',
      fix: '处理掉那些依赖后重试，或先关闭「归档旧版本安装包」。'
    },
    'SEAL:release-log': {
      title: '发行日志写入失败',
      why: '每次发行必须留下独立日志。',
      fix: '检查 dist 是否可写。'
    },
    'PUBLISH:tag-exists': {
      title: 'GitHub tag 已存在',
      why: 'tag %TAG% 已经被占用，发布会让身份冲突或静默替换。',
      fix: '换一个版本号，或先删除那个 tag（前提是它不属于已完成的发布）。'
    },
    'PUBLISH:notes-missing': {
      title: '缺少 Release Notes，无法创建 GitHub Release',
      why: '发布命令用 docs/release-notes/<版本>.md 作为 --notes-file。',
      fix: '点「编辑发行说明」写好后保存，再重新「检查」。'
    },
    'PUBLISH:artifact-missing': {
      title: '找不到要发布的安装包',
      why: 'dist 里没有本次版本的安装包。',
      fix: '先成功完成一次「构建 Release」。'
    },
    'PUBLISH:sums-missing': {
      title: '找不到 SHA256SUMS.txt',
      why: '发布需要把校验文件一起上传，它不在 dist 里。',
      fix: '先成功完成一次「构建 Release」。'
    },
    'PUBLISH:manifest-missing': {
      title: '找不到 update-stable.json',
      why: '进入 Stable 通道的那一刻就是上传这份清单；它不在 dist 里。',
      fix: '先成功完成一次「构建 Release」。'
    },
    'PUBLISH:remote-missing': {
      title: 'Git 远端不存在',
      why: '没有可以推送的 origin 远端。',
      fix: '先配置远端仓库。'
    },
    /* ── informational warnings: no action, but a human should see them ──── */
    'CHECK:tool-node': {
      title: 'Node 运行时不是仓库内置的那一份',
      why: '工具用了 PATH 上的 node，而不是 runtime\\node\\node.exe。构建仍然可行，但内置运行时才是被钉定并校验过的那一个。',
      fix: '一般可以忽略；要完全一致就设置 IB_NODE 指向内置运行时。'
    },
    'CHECK:tool-gh': {
      title: 'GitHub CLI 不可用',
      why: '只有「发布到 GitHub」需要它。构建、验证、封装都不需要。',
      fix: '本次只构建的话可以忽略；要发布就先安装并登录 gh。'
    },
    'CHECK:dist': {
      title: 'dist 目录还不存在',
      why: '构建第 3 步会创建它。',
      fix: '不需要处理。'
    },
    'CHECK:dist-artifact-exists': {
      title: 'dist 里已经有同名的安装包',
      why: '目标版本之前构建过。本次构建会覆盖那份字节，而「已发布的字节」不允许被重建产物替代。',
      fix: '确认那份字节没有被发布过；不确定就换一个更高的版本号。'
    },
    'CHECK:git-untracked': {
      title: '工作区有未跟踪文件',
      why: '未跟踪文件不会被提交，也不会被打进安装包。',
      fix: '确认它们是否属于本次发行；不属于可以忽略。'
    },
    'CHECK:git-behind': {
      title: '本地落后于远端',
      why: '远端有本地没有的提交，基于它发布的版本可能不是最新。',
      fix: '先拉取远端提交，再重新检查。'
    },
    'CHECK:git-ahead': {
      title: '本地领先于远端',
      why: '本地有还没推送的提交。这不是问题，发布流程最后会推送。',
      fix: '不需要处理。'
    },
    'CHECK:runtime-pin': {
      title: '内置运行时钉定值不可读',
      why: 'installer/runtime-pin.json 读不到版本。',
      fix: '检查这个文件。'
    },
    'CHECK:payload-whitelist': {
      title: '载荷白名单不可解析',
      why: '无法确认哪些文件会被打进安装包。',
      fix: '检查白名单解析脚本。'
    },
    'CHECK:minimum-version-policy': {
      title: '清单 minimumVersion 与策略不同',
      why: '清单记录的 minimumVersion 与 canonical 策略常量不一致。',
      fix: '除非你确实要改这项策略，否则按构建输出为准。'
    },
    'VERIFY:notes': {
      title: '清单的 notes 与发行说明不一致',
      why: '构建之后发行说明被改动过。',
      fix: '重置后重新运行「构建 Release」。'
    }
  };

  /* Warnings that carry no decision for a human. They stay in the item table and
     the log (the raw evidence is never hidden), but they do not become alerts:
     a list of things that need nothing is how a real warning gets ignored. */
  var QUIET_WARNINGS = new Set([
    'plan-warn', 'plan-ack', 'minimum-version-policy', 'release-log'
  ]);

  var CODE_ONLY = {
    'target-not-greater': 'BUILD:bump-version',
    'same-version-rebuild-unacknowledged': 'BUILD:bump-version',
    'notes-missing': 'PUBLISH:notes-missing',
    'tag-exists': 'PUBLISH:tag-exists',
    'artifact-missing': 'PUBLISH:artifact-missing',
    'sums-missing': 'PUBLISH:sums-missing',
    'manifest-missing': 'PUBLISH:manifest-missing',
    'stage-gate': null,
    'stage-exception': null,
    'no-repo': 'CHECK:repo-root',
    'busy': null,
    'current-version-invalid': 'CHECK:file:VERSION'
  };

  function lookupProblem(stage, key, code) {
    /* PROBLEM is keyed '<STAGE>:<bare item key>'; callers pass the scoped key the
       snapshot carries, so it is reduced to its bare form first. */
    var bare = bareKey(stage, key);
    if (bare && PROBLEM[stage + ':' + bare]) return PROBLEM[stage + ':' + bare];
    var hit = null;
    Object.keys(PROBLEM).forEach(function (k) {
      if (hit) return;
      var parts = k.split(':');
      if (parts[1] === bare && bare) hit = PROBLEM[k];
    });
    if (hit) return hit;
    if (code && CODE_ONLY[code] !== undefined && CODE_ONLY[code]) return PROBLEM[CODE_ONLY[code]];
    return null;
  }

  function fill(text, vars) {
    return String(text || '').replace(/%([A-Z]+)%/g, function (m, k) {
      return vars[k] !== undefined ? String(vars[k]) : m;
    });
  }

  /* ── alerts ────────────────────────────────────────────────────────────── */

  var ALERT_LIMIT = 4;

  function collectProblems() {
    var out = [];
    var seen = {};
    function add(entry) {
      if (!entry) return;
      var sig = entry.kind + '|' + entry.title;
      if (seen[sig]) return;
      seen[sig] = true;
      out.push(entry);
    }

    items().forEach(function (i) {
      if (i.status !== 'blocked' && i.status !== 'warn') return;
      var known = lookupProblem(i.stage, i.key, null);
      var kind = i.status === 'blocked' ? 'blocked' : 'warn';
      /* A warning nobody has to act on is not an alert. It stays visible in the
         item table and the log, which is where evidence belongs. */
      if (kind === 'warn' && QUIET_WARNINGS.has(bareKey(i.stage, i.key))) return;
      if (!known && kind === 'warn' && !i.title) return;
      add({
        kind: kind,
        title: known ? fill(known.title, vars()) : (i.title || i.key),
        why: known ? fill(known.why, vars()) : (i.actual || ''),
        fix: known ? fill(known.fix || '', vars()) : '',
        where: i.evidence || '',
        detail: i.detail || '',
        raw: [i.key, i.expected, i.actual].filter(Boolean).join('  ·  ')
      });
    });

    ((STATE.snapshot && STATE.snapshot.log && STATE.snapshot.log.blockers) || []).forEach(function (b) {
      var known = lookupProblem(b.stage, '', b.code);
      add({
        kind: 'blocked',
        title: known ? fill(known.title, vars()) : (b.code || '阻断'),
        why: known ? fill(known.why, vars()) : (b.message || ''),
        fix: known ? fill(known.fix || '', vars()) : '',
        where: '',
        detail: '',
        raw: (b.code || '') + '  ·  ' + (b.message || '')
      });
    });

    out.sort(function (a, b) { return (a.kind === 'blocked' ? 0 : 1) - (b.kind === 'blocked' ? 0 : 1); });
    return out;
  }

  function vars() {
    var v = currentVersion() || '?';
    var t = target() || '?';
    return { TARGET: t, CURRENT: v, TAG: 'v' + t };
  }

  /* ── render ────────────────────────────────────────────────────────────── */

  function render() {
    var s = STATE.snapshot;
    if (!s) return;
    var d = s.describe || {};
    var top = displayStatus();
    /* Collected once per render: the pipeline's summary line and the alerts list
       must be the same list, or the screen says "4 items" above an empty box. */
    STATE.problems = collectProblems();

    document.body.dataset.status = top;
    document.body.dataset.running = s.running ? 'true' : 'false';

    el('v-current').textContent = d.version || (d.versionOk === false ? 'VERSION 不可解析' : '—');

    var input = el('target');
    if (document.activeElement !== input) {
      if (s.options && s.options.target) input.value = s.options.target;
      else if (d.version) input.value = nextPatch(d.version);
    }

    var repo = d.root
      ? (d.rootName || d.root) + (d.commit ? '  @ ' + String(d.commit).slice(0, 8) : '') + (d.branch ? '  (' + d.branch + ')' : '')
      : '未识别到仓库根目录';
    el('repo-line').textContent = repo;
    el('repo-line').title = d.root || '';

    renderVerdict(top);
    renderPipeline();
    renderFacts();
    renderResult();
    renderAlerts();
    renderLog();
    wireEnabled(top);
  }

  function renderVerdict(top) {
    var s = STATE.snapshot;
    /* A switch, not an object literal: every value in a literal is evaluated
       before the key is selected, so `{ RUNNING: s.running.stage }` would throw
       on the far more common IDLE path where nothing is running at all. */
    var word = top;
    switch (top) {
      case 'IDLE': word = '未开始'; break;
      case 'RUNNING': {
        var r = s.running || {};
        word = (STAGE_TITLE[r.stage] || r.stage || '阶段') + '进行中…';
        break;
      }
      case 'READY': word = 'RELEASE READY · 尚未发布'; break;
      case 'PUBLISHED': word = '已发布到 GitHub'; break;
      case 'BLOCKED': word = 'RELEASE BLOCKED'; break;
      case 'WARN': word = '可以继续，但有需知项'; break;
      default: word = top;
    }
    el('status-text').textContent = word;
  }

  /* one short phrase per stage: the human summary, not the item dump */
  function stepDetail(name) {
    var s = STATE.snapshot;
    var st = (s.stages && s.stages[name]) || {};
    var status = st.status;
    var blocking = items(name).filter(function (i) { return i.status === 'blocked'; });
    var warning = items(name).filter(function (i) { return i.status === 'warn'; });

    if (status === 'running') {
      var base = STAGE_PLAIN[name];
      return st.at ? base + ' · 已 ' + seconds(Date.now() - Date.parse(st.at)) : base;
    }
    if (status === 'blocked') {
      var first = blocking[0];
      var known = first ? lookupProblem(name, first.key, null) : null;
      return known ? fill(known.title, vars()) : (first ? (first.title || first.key) : '失败');
    }
    if (status === 'warn') {
      var n = STATE.problems ? STATE.problems.length : warning.length;
      return n + ' 项需要知道的事（见下方）';
    }
    if (status === 'ok' || status === 'dry') {
      return noteFor(name);
    }
    if (status === 'skipped') return '已跳过';
    /* pending */
    if (name === 'BUILD' && st.cascaded) return '等上游通过';
    return STAGE_PLAIN[name];
  }

  /* What the human actually wants to know after a stage finished. */
  function noteFor(name) {
    var f = facts();
    if (name === 'CHECK') {
      var bits = [];
      bits.push('当前版本 ' + (currentVersion() || '?'));
      if (target()) bits.push('目标 ' + target());
      var dirty = (f.dirtyPaths || []).length;
      bits.push(dirty ? dirty + ' 个已跟踪文件有改动' : '工作区干净');
      return bits.join(' · ');
    }
    if (name === 'BUILD') {
      var art = f.artifact || null;
      var ms = buildMs();
      return art && art.exists
        ? art.name + (ms ? ' · ' + seconds(ms) : '')
        : (ms ? '构建完成 · ' + seconds(ms) : '构建完成');
    }
    if (name === 'VERIFY') {
      var verifyItems = items('VERIFY');
      var bad = verifyItems.filter(function (i) { return i.status === 'blocked'; }).length;
      return bad ? bad + ' 项校验不通过' : '四等式与 U1–U5 全部通过';
    }
    if (name === 'SEAL') {
      return facts().threeWayOk ? '三方对账一致，产物集已封存' : '封装完成';
    }
    return '';
  }

  function renderPipeline() {
    var host = el('flow-steps');
    host.textContent = '';
    var s = STATE.snapshot;
    STAGE_ORDER.forEach(function (name) {
      var st = (s.stages && s.stages[name]) || { status: 'pending' };
      var li = h('li', 'step');
      li.dataset.s = st.status;
      li.dataset.stage = name;
      var dot = h('span', 'step-dot');
      dot.textContent = st.status === 'ok' ? '✓'
        : st.status === 'warn' ? '!'
          : st.status === 'blocked' ? '×'
            : st.status === 'running' ? '•'
              : st.status === 'dry' ? '◇' : String(STAGE_ORDER.indexOf(name) + 1);
      var body = h('div', 'step-body');
      body.appendChild(h('div', 'step-name', STAGE_TITLE[name]));
      body.appendChild(h('div', 'step-detail', stepDetail(name)));
      li.appendChild(dot);
      li.appendChild(body);
      var t = st.at ? clockOf(st.at) : '';
      li.title = STATUS_WORD[st.status] + (t ? ' · ' + t : '') + '\n' + STAGE_PLAIN[name];
      host.appendChild(li);
    });

    var pub = el('btn-publish');
    var ready = s.status === 'READY' && isGreen('SEAL');
    var published = s.status === 'PUBLISHED';
    pub.classList.toggle('armed', ready && !published);
    pub.disabled = !!s.running || !ready;
    el('publish-hint').textContent = published ? '已发布'
      : ready ? '已就绪，等待你确认' : '先完成封装';
  }

  function renderFacts() {
    var s = STATE.snapshot;
    var f = facts();
    var host = el('facts');
    host.textContent = '';

    var gitState = gitSummary();
    var notesState = notesSummary();
    var top = displayStatus();
    var overall = {
      IDLE: ['未开始', 'quiet'],
      RUNNING: ['进行中', 'quiet'],
      READY: ['RELEASE READY（尚未发布）', 'good'],
      PUBLISHED: ['已发布', 'good'],
      BLOCKED: ['RELEASE BLOCKED', 'bad'],
      WARN: ['可以继续，有需知项', 'warn']
    }[top] || ['未开始', 'quiet'];

    var rows = [
      ['发行状态', tag(overall[0], overall[1])],
      ['当前版本', mono(s.describe && s.describe.version ? s.describe.version : '—')],
      ['目标版本', mono(target() || '—')],
      ['目标产物', mono(target() ? 'InternalBeyond-Setup-' + target() + '.exe' : '—')],
      ['Git 状态', gitState],
      ['工作区', workspaceSummary()],
      ['Release Notes', notesState.node],
      ['构建耗时', plain(f.buildMs ? seconds(f.buildMs) : '—')]
    ];

    rows.forEach(function (r) {
      host.appendChild(h('dt', null, r[0]));
      var dd = h('dd');
      dd.appendChild(r[1]);
      host.appendChild(dd);
    });

    /* the notes row gets its editor entry point */
    if (notesState.editable) {
      var link = h('button', 'linklike', notesState.exists ? '编辑发行说明' : '填写发行说明');
      link.type = 'button';
      link.id = 'btn-notes-inline';
      link.addEventListener('click', openNotes);
      host.lastChild.appendChild(link);
    }
    var openBtn = el('btn-notes');
    openBtn.disabled = !notesState.editable || !!s.running;
    openBtn.textContent = notesState.editable && notesState.exists ? '编辑发行说明' : '填写发行说明';
  }

  function plain(t) { return document.createTextNode(t); }
  function mono(t) { return h('span', 'mono', t); }
  function tag(text, kind) { return h('span', 'tag ' + (kind || 'quiet'), text); }

  function workspaceSummary() {
    var f = facts();
    var clean = itemAt('git-clean', 'CHECK');
    if (clean && clean.status === 'ok') return tag('干净', 'good');
    if (clean && clean.status !== 'ok') return tag(README_FALLBACK(clean), 'bad');
    if ((f.dirtyPaths || []).length) return tag((f.dirtyPaths || []).length + ' 个文件有改动', 'bad');
    return tag('尚未检查', 'quiet');
  }

  function README_FALLBACK(item) {
    return item.actual ? String(item.actual) : '有未提交修改';
  }

  function gitSummary() {
    var f = facts();
    var bits = [];
    var head = STATE.snapshot.describe && STATE.snapshot.describe.commit;
    if (head) bits.push(h('span', 'mono', String(head).slice(0, 10)));
    var untracked = itemAt('git-untracked', 'CHECK');
    if (untracked && untracked.status === 'warn') bits.push(tag('有未跟踪文件', 'warn'));
    var upstream = itemAt('git-behind', 'CHECK') || itemAt('git-ahead', 'CHECK');
    if (upstream && upstream.status === 'warn' && upstream.actual) bits.push(tag(String(upstream.actual).slice(0, 40), 'warn'));
    if (!bits.length) return plain('—');
    var wrap = h('span');
    bits.forEach(function (b) { wrap.appendChild(b); });
    return wrap;
  }

  function notesSummary() {
    var s = STATE.snapshot;
    var t = target();
    var rel = (s.notes && s.notes.path) || '';
    var item = itemAt('release-notes', 'CHECK');
    var exists = !!(item && item.status === 'ok');
    var pinned = isGreen('SEAL') || isGreen('VERIFY');
    /*
     * The canonical path is derived from the target version, and the server only
     * learns that version through /api/options. Requiring `t` here would make the
     * button dead until some other action happened to push the version — so the
     * version the human has TYPED counts as the target: openNotes commits it and
     * then reads the file. Only "nothing typed and nothing known" disables it.
     */
    var typed = el('target').value.trim();
    var wanted = t || (/^\d+\.\d+\.\d+$/.test(typed) ? typed : '');
    var editable = !!wanted && !s.running && !pinned && !STATE.notesBusy;

    var node = h('span');
    if (exists) node.appendChild(tag('已填写', 'good'));
    else if (item && item.status === 'warn') node.appendChild(tag('尚未填写发行说明', 'warn'));
    else if (wanted) node.appendChild(tag('尚未检查', 'quiet'));
    else node.appendChild(tag('先填目标版本', 'quiet'));
    if (rel) node.appendChild(h('span', 'mono', ' ' + rel));
    else if (wanted) node.appendChild(h('span', 'mono', ' docs/release-notes/' + wanted + '.md'));
    return { node: node, exists: exists, editable: editable, rel: rel, wanted: wanted };
  }

  /* ── the artifact / RELEASE READY block ────────────────────────────────── */

  function buildMs() {
    var f = facts();
    if (f.buildMs) return f.buildMs;
    var cmds = (STATE.snapshot.log && STATE.snapshot.log.commands) || [];
    var hit = null;
    cmds.forEach(function (c) { if (c.stage === 'BUILD' && c.ms) hit = c.ms; });
    return hit || 0;
  }

  function artifactInfo() {
    var f = facts();
    var reread = f.reread || null;
    var art = (reread && reread.artifact) || null;
    var sums = (reread && reread.sums) || null;
    var man = (reread && reread.manifest) || null;
    var planned = f.artifact || null;
    var d = STATE.snapshot.describe || {};
    var dist = art ? String(art.path).replace(/[\\/][^\\/]+$/, '') : (d.root ? d.root + '\\dist' : '');
    return {
      name: (art && art.name) || (planned && planned.name) || (target() ? 'InternalBeyond-Setup-' + target() + '.exe' : ''),
      bytes: (art && art.bytes) || (planned && planned.bytes) || 0,
      sha256: (art && art.sha256) || '',
      sums: sums,
      manifest: man,
      dist: dist,
      threeWayOk: f.threeWayOk === true,
      sealed: isGreen('SEAL'),
      hasArtifact: !!(art && art.sha256)
    };
  }

  function renderResult() {
    var card = el('card-result');
    var info = artifactInfo();
    var running = !!STATE.snapshot.running;
    var sealStatus = stageStatus('SEAL');

    var show = info.sealed || sealStatus === 'blocked' || sealStatus === 'running' || (info.hasArtifact && isGreen('VERIFY'));
    if (!show) {
      card.hidden = true;
      el('panels').classList.remove('stacked');
      return;
    }
    card.hidden = false;
    el('panels').classList.remove('single');
    el('panels').classList.add('stacked');

    card.classList.toggle('failed', sealStatus === 'blocked');
    card.classList.toggle('running', running);

    var title = el('result-title');
    var note = el('result-note');
    title.className = '';
    if (sealStatus === 'blocked') {
      title.textContent = '封装失败';
      title.className = 'failed';
      note.textContent = '产物可能已经写进 dist，但这次发行没有通过校验';
    } else if (running || sealStatus === 'running') {
      title.textContent = '正在封装…';
      note.textContent = '';
    } else if (info.sealed) {
      title.textContent = 'RELEASE READY';
      title.className = 'ready';
      note.textContent = '已封装，尚未发布';
    } else {
      title.textContent = '产物（已验证，尚未封装）';
      note.textContent = '';
    }

    var host = el('artifact');
    host.textContent = '';

    host.appendChild(h('div', 'artifact-name', info.name || '（还没生成产物）'));

    if (info.sha256) {
      var row = h('div', 'artifact-hash');
      row.appendChild(h('code', null, info.sha256));
      var copy = h('button', 'btn tiny', '复制 SHA256');
      copy.type = 'button';
      copy.id = 'btn-copy-sha';
      copy.addEventListener('click', function () { copyText(info.sha256, 'SHA256 已复制。'); });
      row.appendChild(copy);
      host.appendChild(row);
    }

    var meta = h('dl', 'artifact-meta');
    var addRow = function (k, v, cls) {
      meta.appendChild(h('dt', null, k));
      meta.appendChild(h('dd', cls || null, v));
    };
    addRow('文件大小', info.bytes ? bytes(info.bytes) : '—');
    addRow('update-stable.json', info.manifest
      ? ('version ' + (info.manifest.version || '?') + ' · sizeBytes ' + (info.manifest.sizeBytes || '?') + ' · 已通过 canonical 校验')
      : '—');
    addRow('SHA256SUMS.txt', info.sums
      ? ('记录值 ' + String(info.sums.sha256 || '').slice(0, 16) + '… · ' + (info.sums.sha256 && info.sha256 && info.sums.sha256 === info.sha256 ? '与安装包一致' : '与安装包不一致'))
      : '—');
    addRow('三方对账', info.sealed ? (info.threeWayOk ? '一致（安装包 = SHA256SUMS = 清单）' : '不一致') : '尚未封装');
    addRow('构建耗时', buildMs() ? seconds(buildMs()) : '—');
    addRow('产物目录', info.dist || '—', 'mono');
    host.appendChild(meta);

    var actions = h('div', 'modal-actions');
    var openDist = h('button', 'btn tiny', '打开 dist');
    openDist.type = 'button';
    openDist.id = 'btn-open-dist-inline';
    openDist.disabled = !info.dist;
    openDist.addEventListener('click', openDist);
    actions.appendChild(openDist);
    if (STATE.snapshot && STATE.snapshot.describe && STATE.snapshot.describe.root && target()) {
      var viewLog = h('button', 'btn tiny', '查看日志');
      viewLog.type = 'button';
      viewLog.id = 'btn-view-log';
      viewLog.addEventListener('click', viewLog);
      actions.appendChild(viewLog);
    }
    host.appendChild(actions);
  }

  function renderAlerts() {
    var host = el('alerts');
    var panels = el('panels');
    var problems = STATE.problems || [];
    host.textContent = '';
    if (!problems.length) {
      host.hidden = true;
      panels.classList.remove('paired');
      /* Nothing beside the status card: give it the full width rather than
         leaving a hole where an empty panel would have been. */
      if (!panels.classList.contains('stacked')) panels.classList.add('single');
      return;
    }
    host.hidden = false;
    /* Alerts take the second column, but never at the cost of pushing the
       artifact out of the way: the artifact IS the release. */
    if (!panels.classList.contains('stacked')) {
      panels.classList.remove('single');
      panels.classList.add('paired');
    }

    problems.slice(0, ALERT_LIMIT).forEach(function (p) {
      var k = KIND[p.kind] || KIND.blocked;
      var box = h('div', 'alert' + (k.cls ? ' ' + k.cls : ''));
      box.appendChild(h('span', 'alert-mark', k.mark));
      var body = h('div', 'alert-body');
      body.appendChild(h('div', 'alert-title', p.title));
      if (p.why) body.appendChild(h('p', 'alert-why', p.why));
      if (p.fix) body.appendChild(h('p', 'alert-why', '怎么办：' + p.fix));
      if (p.where) body.appendChild(h('p', 'alert-where', p.where));
      if (p.detail) {
        var btn = h('button', 'alert-more', '原始证据');
        btn.type = 'button';
        var det = h('pre', 'alert-detail', p.detail);
        det.hidden = true;
        btn.addEventListener('click', function () {
          det.hidden = !det.hidden;
          btn.textContent = det.hidden ? '原始证据' : '收起证据';
        });
        body.appendChild(btn);
        body.appendChild(det);
      } else if (p.raw) {
        body.appendChild(h('p', 'alert-where', p.raw));
      }
      box.appendChild(body);
      host.appendChild(box);
    });

    if (problems.length > ALERT_LIMIT) {
      var more = h('div', 'alert warn');
      more.appendChild(h('span', 'alert-mark', '…'));
      var b2 = h('div', 'alert-body');
      b2.appendChild(h('div', 'alert-title', '还有 ' + (problems.length - ALERT_LIMIT) + ' 项需要知道的事'));
      b2.appendChild(h('p', 'alert-why', '展开「详细日志」可以看到全部条目与原始证据。'));
      more.appendChild(b2);
      host.appendChild(more);
    }
  }

  function wireEnabled(top) {
    var s = STATE.snapshot;
    var running = !!s.running;
    el('btn-cancel').hidden = !running;
    el('btn-check').disabled = running;
    el('btn-build').disabled = running;
    el('btn-dry').disabled = running;
    el('btn-reset').disabled = running;
    el('btn-open-dist').disabled = running || !s.describe || !s.describe.root;

    var t = target();
    var ready = s.status === 'READY' && isGreen('SEAL');
    el('btn-build').textContent = top === 'RUNNING' ? '构建进行中…'
      : (isGreen('SEAL') && s.status === 'READY') ? '重新构建' : '构建 Release';
    el('dock-hint').textContent = running
      ? '正在运行，界面每 0.7 秒刷新一次'
      : ready ? '构建已完成。发布到 GitHub 需要单独确认。'
        : 'Ctrl+Enter 运行构建' + (t ? '' : '（先填目标版本）');
  }

  /* ── log ───────────────────────────────────────────────────────────────── */

  function renderLog() {
    var s = STATE.snapshot;
    var view = el('log-view');
    var verbose = el('log-verbose').checked;
    var incoming = (s.log && s.log.lines) || [];
    incoming.forEach(function (l) { STATE.logLines.push(l); });
    if (STATE.logLines.length > 6000) STATE.logLines = STATE.logLines.slice(-6000);

    var shown = STATE.logLines.filter(function (l) {
      if (verbose) return true;
      return l.kind !== 'event' && l.kind !== 'debug';
    });
    view.textContent = '';
    var frag = document.createDocumentFragment();
    shown.forEach(function (l) {
      var line = document.createElement('div');
      line.className = 'l-' + l.kind;
      line.textContent = formatLine(l);
      frag.appendChild(line);
    });
    view.appendChild(frag);
    el('logbar-meta').textContent = STATE.logLines.length + ' 行';
    if (el('log-follow').checked && !el('logbar-body').hidden) view.scrollTop = view.scrollHeight;
    STATE.logSeq = (s.log && s.log.seq) || STATE.logSeq;
  }

  function formatLine(l) {
    var at = String(l.at || '').replace('T', ' ').replace('Z', '');
    var st = l.stage ? '[' + l.stage + '] ' : '';
    if (l.kind === 'item') {
      return at + '  ' + st + (l.status || '').toUpperCase() + '  ' + (l.title || l.key) +
        (l.actual ? '  → ' + l.actual : '');
    }
    if (l.kind === 'command') {
      return at + '  ' + st + 'EXEC ' + l.file + ' ' + (l.args || []).join(' ') + '  → exit ' + l.exitCode +
        (l.ms ? ' (' + l.ms + ' ms)' : '');
    }
    if (l.kind === 'blocked') return at + '  ' + st + 'BLOCKED ' + l.code + ' — ' + l.message;
    if (l.kind === 'warn') return at + '  ' + st + 'WARN ' + l.code + ' — ' + l.message;
    if (l.kind === 'stage') return at + '  ===== ' + l.stage + ' =====' + (l.dryRun ? '  (DRY RUN)' : '');
    return at + '  ' + st + (l.message || JSON.stringify(l));
  }

  /* ── api ───────────────────────────────────────────────────────────────── */

  function api(path, opts) {
    var o = opts || {};
    return fetch(path, {
      method: o.method || 'GET',
      headers: Object.assign({ 'X-IB-Release-Token': TOKEN }, o.body ? { 'Content-Type': 'application/json' } : {}),
      body: o.body ? JSON.stringify(o.body) : undefined,
      cache: 'no-store'
    }).then(function (r) {
      if (r.status === 403) throw new Error('会话令牌无效或已过期：请重新打开 Release Builder。');
      return r.json();
    });
  }

  function toast(message, kind) {
    var t = el('toast');
    t.textContent = message;
    t.className = 'toast' + (kind ? ' ' + kind : '');
    t.hidden = false;
    window.clearTimeout(toast._t);
    toast._t = window.setTimeout(function () { t.hidden = true; }, kind === 'err' ? 9000 : 3600);
  }

  function copyText(text, okMessage) {
    if (!text) { toast('没有可复制的内容。', 'err'); return; }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(
        function () { toast(okMessage || '已复制到剪贴板。', 'ok'); },
        function () { toast('复制失败：请手动选中复制。', 'err'); }
      );
      return;
    }
    toast('复制失败：浏览器不允许访问剪贴板。', 'err');
  }

  function applySnapshot(snap) {
    if (!snap) return;
    STATE.snapshot = snap;
    render();
  }

  function refresh() {
    return api('/api/snapshot?since=' + STATE.logSeq).then(function (r) {
      if (r.ok) applySnapshot(r.snapshot);
      return r;
    }).catch(function (e) {
      toast(String(e.message || e), 'err');
      return null;
    });
  }

  function pushOptions() {
    return api('/api/options', {
      method: 'POST',
      body: {
        target: el('target').value.trim(),
        archiveOldReleases: true,
        regenerateManifest: false
      }
    }).catch(function () { return null; });
  }

  /* ── actions ───────────────────────────────────────────────────────────── */

  function validTarget() {
    var t = el('target').value.trim();
    var ok = /^\d+\.\d+\.\d+$/.test(t);
    el('target').classList.toggle('is-bad', !ok);
    if (!ok) toast('目标版本必须是 MAJOR.MINOR.PATCH，例如 1.0.6。', 'err');
    return ok;
  }

  function runCheck() {
    if (!validTarget()) return Promise.resolve();
    STATE.busy = true;
    return pushOptions()
      .then(function () { return api('/api/run', { method: 'POST', body: { stage: 'CHECK' } }); })
      .then(function (r) {
        if (r.snapshot) applySnapshot(r.snapshot);
        var status = r.result && r.result.status;
        if (status === 'blocked') toast('检查没有通过：见下方「需要处理」。', 'err');
        else if (status === 'warn') toast('检查通过，但有需要知道的项。');
        else toast('检查通过。', 'ok');
        return refresh();
      })
      .catch(function (e) { toast(String(e.message || e), 'err'); })
      .then(function () { STATE.busy = false; render(); });
  }

  function runBuild() {
    if (!validTarget()) return Promise.resolve();
    var t = el('target').value.trim();
    var cur = currentVersion() || '?';
    if (!window.confirm('将执行：检查 → 构建 → 验证 → 封装，然后停止。\n\n' + cur + ' → ' + t + '\n\n' +
      '· 会修改 VERSION 与 README 的「当前版本」字面量（构建失败会自动回滚）\n' +
      '· 会运行 scripts\\build-installer.ps1（约 30–60 秒）\n' +
      '· 不会 push、不会 tag、不会创建 release、不会上传任何东西')) return Promise.resolve();

    STATE.busy = true;
    STATE.logLines = [];
    STATE.logSeq = 0;
    render();
    return pushOptions()
      .then(function () { return api('/api/run', { method: 'POST', body: { stage: 'ONECLICK' } }); })
      .then(function (r) {
        if (r.snapshot) applySnapshot(r.snapshot);
        var st = r.snapshot && r.snapshot.status;
        if (st === 'READY') toast('构建完成，已封装（RELEASE READY）。尚未发布。', 'ok');
        else toast('构建没有通过：见下方「需要处理」。', 'err');
        return refresh();
      })
      .catch(function (e) { toast(String(e.message || e), 'err'); })
      .then(function () { STATE.busy = false; render(); });
  }

  function runDry() {
    STATE.busy = true;
    return pushOptions()
      .then(function () { return api('/api/run', { method: 'POST', body: { stage: 'DRY' } }); })
      .then(function (r) {
        if (r.snapshot) applySnapshot(r.snapshot);
        if (!r.dry) return refresh();
        STATE.dryPlan = r.dry.plan;
        openRawLog(r.dry.ok
          ? '预演完成（零副作用）：下面是这次发行将会做的事情。'
          : '预演停止：检查没有通过，因此没有可执行的计划。');
        toast(r.dry.ok ? '预演完成，没有写任何文件。' : '预演：检查没有通过。', r.dry.ok ? 'ok' : 'err');
        return null;
      })
      .catch(function (e) { toast(String(e.message || e), 'err'); })
      .then(function () { STATE.busy = false; render(); });
  }

  /* The dry-run plan is a document, so it goes into the log pane where long
     text belongs — not onto the main screen. */
  function openRawLog(message) {
    var body = el('logbar-body');
    var head = el('logbar-head');
    body.hidden = false;
    head.setAttribute('aria-expanded', 'true');
    var view = el('log-view');
    view.textContent = '';
    var box = h('pre', null, (message ? message + '\n\n' : '') + ((STATE.dryPlan && STATE.dryPlan.text) || '（没有计划）'));
    view.appendChild(box);
    view.scrollTop = 0;
  }

  function reset() {
    api('/api/run', { method: 'POST', body: { stage: 'RESET' } }).then(function (r) {
      STATE.logLines = [];
      STATE.logSeq = 0;
      STATE.dryPlan = null;
      STATE.publishPlan = null;
      STATE.notes = null;
      applySnapshot(r.snapshot);
      toast('已重置。', 'ok');
    }).catch(function (e) { toast(String(e.message || e), 'err'); });
  }

  function cancel() {
    api('/api/cancel', { method: 'POST' }).then(function (r) {
      toast(r.ok ? '已请求取消。' : '当前没有正在运行的阶段。', r.ok ? 'ok' : 'err');
    }).catch(function (e) { toast(String(e.message || e), 'err'); });
  }

  function openDist() {
    api('/api/reveal', { method: 'POST', body: { what: 'dist' } }).then(function (r) {
      if (!r.ok) toast(r.why || '无法打开 dist 目录。', 'err');
    }).catch(function (e) { toast(String(e.message || e), 'err'); });
  }

  function viewLog() {
    api('/api/reveal', { method: 'POST', body: { what: 'log' } }).then(function (r) {
      if (!r.ok) toast(r.why || '还没有本次发行的日志文件。', 'err');
    }).catch(function (e) { toast(String(e.message || e), 'err'); });
  }

  /* ── notes editor ──────────────────────────────────────────────────────── */

  /*
   * The canonical notes path is a function of the target version, and the
   * backend only learns the target through /api/options. A person who types a
   * version and clicks 编辑发行说明 has expressed what they want, so the typing
   * is committed instead of being refused with "先填目标版本" — the version that
   * appears in the box IS filled in.
   */
  function ensureOptions() {
    var typed = el('target').value.trim();
    var known = (STATE.snapshot && STATE.snapshot.options && STATE.snapshot.options.target) || '';
    if (typed === known) return Promise.resolve(false);
    return pushOptions().then(function () { return true; });
  }

  function openNotes() {
    var s = STATE.snapshot;
    if (!s || !s.describe || !s.describe.root) { toast('还没有识别到仓库根目录。', 'err'); return; }
    if (!validTarget()) return;
    STATE.notesBusy = true;
    render();
    ensureOptions().then(function () {
      return api('/api/notes');
    }).then(function (r) {
      STATE.notesBusy = false;
      if (!r.ok) { toast(r.why || '读不到发行说明。', 'err'); render(); return; }
      STATE.notes = r;
      var modal = el('notes-modal');
      el('notes-path').textContent = r.rel + (r.exists ? '' : '（尚未创建）');
      el('notes-note').textContent = r.exists
        ? '这是本次发行的 canonical 发行说明文件：构建会把它读进清单的 notes 字段。'
        : '这个版本还没有发行说明。保存会创建上面这个文件，并成为用户更新卡片上的说明文案。';
      var area = el('notes-text');
      area.value = r.content || ('# InternalBeyond ' + r.target + '\n\n');
      modal.hidden = false;
      area.focus();
      render();
    }).catch(function (e) {
      STATE.notesBusy = false;
      render();
      toast(String(e.message || e), 'err');
    });
  }

  function saveNotes() {
    var r = STATE.notes;
    if (!r) return;
    var text = el('notes-text').value;
    var btn = el('btn-notes-save');
    btn.disabled = true;
    api('/api/notes', { method: 'POST', body: { content: text } }).then(function (res) {
      btn.disabled = false;
      if (!res.ok) { toast(res.why || '保存失败。', 'err'); return; }
      toast((res.created ? '已创建 ' : '已保存 ') + res.rel, 'ok');
      el('notes-modal').hidden = true;
      STATE.notes = null;
      /* The tree changed, so the previous CHECK verdict is about a different
         tree: ask for a fresh one instead of showing a stale green. */
      return api('/api/run', { method: 'POST', body: { stage: 'CHECK' } })
        .then(function (c) { if (c.snapshot) applySnapshot(c.snapshot); return refresh(); });
    }).catch(function (e) {
      btn.disabled = false;
      toast(String(e.message || e), 'err');
    });
  }

  /* ── publish (separate, explicit, fingerprint-bound) ───────────────────── */

  function openPublish() {
    api('/api/publish-plan').then(function (r) {
      if (r.error === 'no-repo') { toast('还没有识别到仓库根目录。', 'err'); return; }
      STATE.publishPlan = r;
      renderPublishModal(r);
      el('publish-modal').hidden = false;
    }).catch(function (e) { toast(String(e.message || e), 'err'); });
  }

  function renderPublishModal(p) {
    el('publish-fingerprint').textContent = 'fingerprint ' + String(p.fingerprint || '').slice(0, 16) + '…';
    var art = p.artifact || {};
    el('publish-summary').textContent = (p.tag || '') + ' · ' + (art.name || '') + ' · ' +
      (art.bytes ? bytes(art.bytes) : '?') + ' · sha256 ' + String(art.sha256 || '').slice(0, 16) + '…';

    var blk = el('publish-blockers');
    blk.textContent = '';
    if ((p.blockers || []).length) {
      var box = h('div', 'alert');
      box.appendChild(h('span', 'alert-mark', '!'));
      var body = h('div', 'alert-body');
      body.appendChild(h('div', 'alert-title', '发布前置条件还没有满足'));
      (p.blockers || []).forEach(function (b) {
        var known = lookupProblem('PUBLISH', '', b.code);
        body.appendChild(h('p', 'alert-why', (known ? known.title : b.code) + (b.why ? ' — ' + b.why : '')));
      });
      box.appendChild(body);
      blk.appendChild(box);
    }

    var list = el('publish-actions');
    list.textContent = '';
    (p.actions || []).forEach(function (a) {
      var li = document.createElement('li');
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = true;
      cb.dataset.action = a.id;
      cb.addEventListener('change', syncPublishConfirm);
      var wrap = h('div');
      var label = h('label');
      label.appendChild(h('span', 'pill ' + (a.irreversible ? 'irr' : 'loc'), a.irreversible ? '不可逆' : '本地'));
      label.appendChild(document.createTextNode(a.label || a.id));
      wrap.appendChild(label);
      wrap.appendChild(h('code', null, a.command || ''));
      li.appendChild(cb);
      li.appendChild(wrap);
      list.appendChild(li);
    });

    el('publish-confirm').checked = false;
    syncPublishConfirm();
  }

  function syncPublishConfirm() {
    var p = STATE.publishPlan;
    if (!p) return;
    var any = false;
    document.querySelectorAll('#publish-actions input[data-action]').forEach(function (cb) { if (cb.checked) any = true; });
    el('btn-do-publish').disabled = !(el('publish-confirm').checked && any && (p.blockers || []).length === 0);
  }

  function doPublish() {
    var p = STATE.publishPlan;
    if (!p) return;
    var chosen = [];
    document.querySelectorAll('#publish-actions input[data-action]').forEach(function (cb) {
      if (cb.checked) chosen.push(cb.dataset.action);
    });
    if (!chosen.length) { toast('没有勾选任何动作。', 'err'); return; }
    var btn = el('btn-do-publish');
    btn.disabled = true;
    api('/api/run', {
      method: 'POST',
      body: {
        stage: 'PUBLISH',
        actions: chosen,
        fingerprint: p.fingerprint,
        confirmation: p.confirmation
      }
    }).then(function (r) {
      if (r.snapshot) applySnapshot(r.snapshot);
      var res = r.result || {};
      if (res.status === 'ok' || res.status === 'warn') {
        toast('发布动作已完成。请按 RELEASE.md §6 在 Release 页面独立核对 asset digest。', 'ok');
        el('publish-modal').hidden = true;
      } else {
        toast('发布没有通过：' + ((res.blockers || []).map(function (b) { return b.code || b.why; }).join('、') || '见详细日志'), 'err');
      }
      return refresh();
    }).catch(function (e) {
      btn.disabled = false;
      toast(String(e.message || e), 'err');
    });
  }

  /* ── wiring ────────────────────────────────────────────────────────────── */

  el('btn-check').addEventListener('click', runCheck);
  el('btn-build').addEventListener('click', runBuild);
  el('btn-dry').addEventListener('click', runDry);
  el('btn-reset').addEventListener('click', reset);
  el('btn-cancel').addEventListener('click', cancel);
  el('btn-open-dist').addEventListener('click', openDist);
  el('btn-notes').addEventListener('click', openNotes);
  el('btn-publish').addEventListener('click', openPublish);

  el('btn-notes-save').addEventListener('click', saveNotes);
  el('btn-notes-cancel').addEventListener('click', function () { el('notes-modal').hidden = true; STATE.notes = null; render(); });
  el('btn-publish-cancel').addEventListener('click', function () { el('publish-modal').hidden = true; STATE.publishPlan = null; });
  el('publish-confirm').addEventListener('change', syncPublishConfirm);
  el('btn-do-publish').addEventListener('click', doPublish);

  el('target').addEventListener('input', function () {
    var ok = /^\d+\.\d+\.\d+$/.test(el('target').value.trim());
    el('target').classList.toggle('is-bad', el('target').value.length > 0 && !ok);
  });
  el('target').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); runCheck(); }
  });

  el('logbar-head').addEventListener('click', function () {
    var open = el('logbar-body').hidden;
    el('logbar-body').hidden = !open;
    el('logbar-head').setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) { render(); el('log-view').scrollTop = el('log-view').scrollHeight; }
  });
  el('log-verbose').addEventListener('change', function () { render(); });
  el('btn-export').addEventListener('click', function () {
    window.location.href = '/api/export-log?token=' + encodeURIComponent(TOKEN);
  });
  el('btn-copy').addEventListener('click', function () {
    copyText(el('log-view').textContent || '', '日志已复制。');
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      if (!el('notes-modal').hidden) { el('notes-modal').hidden = true; STATE.notes = null; return; }
      if (!el('publish-modal').hidden) { el('publish-modal').hidden = true; STATE.publishPlan = null; return; }
      if (STATE.snapshot && STATE.snapshot.running) cancel();
    } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      if (el('notes-modal').hidden && el('publish-modal').hidden) runBuild();
    } else if (e.key === 'l' && e.altKey) {
      e.preventDefault();
      el('logbar-head').click();
    }
  });

  /* Poll while a stage runs — that is also what animates the elapsed time;
     otherwise refresh lazily on focus. */
  function poll() {
    var running = STATE.snapshot && STATE.snapshot.running;
    if (running) refresh().then(function () { window.setTimeout(poll, 700); });
    else window.setTimeout(poll, 2500);
  }

  window.addEventListener('focus', refresh);
  window.addEventListener('beforeunload', function (e) {
    if (STATE.busy || (STATE.snapshot && STATE.snapshot.running)) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  if (!TOKEN) {
    toast('缺少启动令牌：请通过 Release Builder 打开本页面（不要直接访问地址）。', 'err');
  }
  refresh().then(poll);
})();
