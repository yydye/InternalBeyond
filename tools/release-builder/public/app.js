'use strict';

/*
 * InternalBeyond Release Builder · GUI client.
 *
 * Renders; it does not decide. Every rule it needs (which stages may run, which
 * statuses exist, what the installer is called, what the manifest must contain)
 * is enforced on the Node side, and this file only displays the result. It
 * holds one secret: the boot token, which the server requires on every call.
 *
 * Safety: all dynamic text goes through textContent or `textContent`-based
 * helpers. Nothing in the server's payload is ever parsed as HTML.
 */

(function () {
  var TOKEN = new URLSearchParams(location.search).get('token') || '';
  var HAD_TOKEN = !!TOKEN;
  if (TOKEN) {
    /* Keep the token out of the address bar without breaking a reload. */
    try { sessionStorage.setItem('ib-release-token', TOKEN); } catch (e) { /* ignore */ }
    history.replaceState(null, '', location.pathname);
  } else {
    try { TOKEN = sessionStorage.getItem('ib-release-token') || ''; } catch (e) { TOKEN = ''; }
  }

  var STATE = {
    snapshot: null,
    selected: 'CHECK',
    logSeq: 0,
    logLines: [],
    publishPlan: null,
    busy: false,
    dryPlan: null
  };

  var el = function (id) { return document.getElementById(id); };
  var stageNames = ['CHECK', 'BUILD', 'VERIFY', 'SEAL', 'PUBLISH'];
  var stageTitles = {
    CHECK: '检查环境', BUILD: '构建（canonical）', VERIFY: '校验',
    SEAL: '封装', PUBLISH: '发布（独立确认）'
  };
  var stageSubs = {
    CHECK: '真实检查，逐项给出期望值 / 实际值 / 证据',
    BUILD: '调用仓库唯一构建权威 scripts\\build-installer.ps1',
    VERIFY: '从最终产物字节重算四等式与 U1–U5',
    SEAL: '治理 dist、写发行日志、三方对账',
    PUBLISH: 'git / gh —— 默认不执行'
  };
  var statusGlyph = {
    pending: '○', running: '◐', ok: '●', warn: '▲', blocked: '■', skipped: '–', dry: '◇'
  };
  var statusLabel = {
    pending: '待运行', running: '运行中', ok: 'OK', warn: '需人工复核',
    blocked: 'BLOCKED', skipped: '跳过', dry: 'DRY'
  };

  /* ── API ───────────────────────────────────────────────────────────────── */

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

  /* ── rendering helpers ─────────────────────────────────────────────────── */

  function h(tag, className, text) {
    var n = document.createElement(tag);
    if (className) n.className = className;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }

  function badge(status) {
    return h('span', 'badge ' + (status || 'pending'), statusLabel[status] || status || 'pending');
  }

  function pre(text) {
    var p = h('pre', 'detail-pre');
    p.textContent = String(text == null ? '' : text);
    p.tabIndex = 0;
    return p;
  }

  function row(item) {
    var r = h('div', 'row');
    r.appendChild(badge(item.status));
    r.appendChild(h('div', 'title', item.title || item.key));
    if (item.expected !== undefined && item.expected !== null && item.expected !== '') {
      r.appendChild(h('div', 'exp', '期望：' + item.expected));
    }
    if (item.actual !== undefined && item.actual !== null && item.actual !== '') {
      r.appendChild(h('div', 'act', '实际：' + item.actual));
    }
    if (item.evidence) r.appendChild(h('div', 'ev', '证据：' + item.evidence));
    if (item.why) r.appendChild(h('div', 'why', item.why));
    if (item.detail) r.appendChild(pre(item.detail));
    return r;
  }

  function render() {
    var s = STATE.snapshot;
    if (!s) return;
    var d = s.describe || {};

    el('v-current').textContent = d.version || (d.versionOk === false ? '（VERSION 不可解析）' : '—');
    if (document.activeElement !== el('target') && !el('target').value && s.options && s.options.target) {
      el('target').value = s.options.target;
    }
    if (document.activeElement !== el('target') && !el('target').value && d.version) {
      el('target').value = nextPatch(d.version);
    }
    el('k-min').textContent = (s.options && s.options.minimumVersion) || '—';

    var repoLine = d.root ? (d.root + (d.commit ? '  @ ' + d.commit.slice(0, 10) : '') + (d.branch ? '  (' + d.branch + ')' : '')) : '未识别到仓库根目录';
    el('repo-line').textContent = repoLine;
    el('repo-line').title = repoLine;

    var top = s.status;
    if (s.running) top = 'RUNNING';
    document.body.dataset.status = top;
    el('status-text').textContent = s.running
      ? (stageTitles[s.running.stage] || s.running.stage) + ' 运行中…'
      : (top === 'READY' ? 'RELEASE READY（尚未发布）'
        : top === 'PUBLISHED' ? 'PUBLISHED'
          : top === 'BLOCKED' ? 'RELEASE BLOCKED' : '未开始');

    renderRail(s);
    renderSideKv(s);
    renderDetail(s);
    renderLog(s);
    renderPublishBox(s);
    el('btn-cancel').hidden = !s.running;
    el('btn-oneclick').disabled = !!s.running;
    el('btn-check').disabled = !!s.running;
    el('btn-dry').disabled = !!s.running;
    el('btn-reset').disabled = !!s.running;
  }

  function nextPatch(v) {
    var m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(v || ''));
    return m ? m[1] + '.' + m[2] + '.' + (Number(m[3]) + 1) : '';
  }

  function renderRail(s) {
    var rail = el('rail');
    rail.textContent = '';
    stageNames.forEach(function (name) {
      var st = (s.stages && s.stages[name]) || { status: 'pending' };
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'rail-item' + (STATE.selected === name ? ' is-sel' : '');
      b.dataset.s = st.status;
      b.dataset.stage = name;
      b.setAttribute('aria-current', STATE.selected === name ? 'true' : 'false');
      var g = h('span', 'glyph', statusGlyph[st.status] || '○');
      var wrap = document.createElement('span');
      wrap.appendChild(h('span', 'rname', name));
      wrap.appendChild(h('span', 'rsub', stageTitles[name] + (st.cascaded ? ' · 被上游阻断' : '')));
      b.appendChild(g);
      b.appendChild(wrap);
      b.addEventListener('click', function () { STATE.selected = name; render(); });
      rail.appendChild(b);
    });
  }

  function renderSideKv(s) {
    var opts = s.options || {};
    var t = opts.target || '';
    el('k-artifact').textContent = t ? 'InternalBeyond-Setup-' + t + '.exe' : '—';
    el('k-tag').textContent = t ? 'v' + t : '—';
    el('k-url').textContent = t ? 'releases/download/v' + t + '/InternalBeyond-Setup-' + t + '.exe' : '—';
    el('opt-archive').checked = opts.archiveOldReleases !== false;
    el('opt-probe').checked = !!opts.probeNetwork;
    el('opt-regen').checked = !!opts.regenerateManifest;
    el('opt-note').textContent = opts.regenerateManifest
      ? 'SEAL 会用 canonical 生成器重新生成清单，并再次 validate() 与三方对账；安装包字节不动。'
      : 'SEAL 默认保留 canonical 构建产出的清单（releasedAt 省略：构建时刻不是发布时刻）。';
  }

  function renderDetail(s) {
    var name = STATE.selected;
    var body = el('detail-body');
    var stage = (s.stages && s.stages[name]) || { status: 'pending' };
    body.textContent = '';
    el('detail-title').textContent = name + ' · ' + stageTitles[name];
    el('detail-sub').textContent = stageSubs[name] + '　状态：' + (statusLabel[stage.status] || stage.status);

    var items = (s.log.items || []).filter(function (i) { return i.stage === name; });
    var blockers = (s.log.blockers || []).filter(function (b) { return b.stage === name; });

    if (blockers.length) {
      var banner = h('div', 'blocked-banner');
      banner.appendChild(h('strong', null, 'RELEASE BLOCKED'));
      var ul = document.createElement('ul');
      blockers.forEach(function (b) {
        var li = document.createElement('li');
        li.textContent = (b.code ? '[' + b.code + '] ' : '') + (b.message || '');
        ul.appendChild(li);
      });
      banner.appendChild(ul);
      body.appendChild(banner);
    }

    if (!items.length) {
      if (name === 'PUBLISH') {
        body.appendChild(h('p', 'empty', 'PUBLISH 独立于 Build/Seal：先在右侧「查看 Publish 计划…」，看清将要执行的动作，再逐项确认。'));
      } else {
        body.appendChild(h('p', 'empty', '这个阶段还没有结果。'));
      }
      return;
    }

    var groups = {};
    var order = [];
    items.forEach(function (i) {
      var key = groupOf(name, i);
      if (!groups[key]) { groups[key] = []; order.push(key); }
      groups[key].push(i);
    });
    order.forEach(function (key) {
      var g = h('div', 'group');
      g.appendChild(h('h3', null, key));
      groups[key].forEach(function (i) { g.appendChild(row(i)); });
      body.appendChild(g);
    });

    if (name === 'BUILD' || name === 'SEAL') {
      var cmds = (s.log.commands || []).filter(function (c) { return c.stage === name; });
      if (cmds.length) {
        var g2 = h('div', 'group');
        g2.appendChild(h('h3', null, '真实执行的命令'));
        cmds.forEach(function (c) {
          g2.appendChild(pre(c.file + ' ' + (c.args || []).join(' ') +
            '\ncwd: ' + c.cwd + '\nexit: ' + c.exitCode + (c.ms != null ? '   (' + c.ms + ' ms)' : '')));
        });
        body.appendChild(g2);
      }
    }
  }

  function groupOf(stage, item) {
    var t = String(item.key || '');
    if (item.status === 'blocked') return '阻断项';
    if (item.status === 'warn') return '需要人工复核（不阻断）';
    if (stage === 'CHECK') {
      if (t.indexOf('tool-') === 0) return '工具链';
      if (t.indexOf('file:') === 0 || t.indexOf('test:') === 0 || t.indexOf('version-') === 0 || t === 'repo-root' || t === 'git-head') return '仓库与契约';
      if (t.indexOf('runtime') === 0) return '内置运行时';
      if (t.indexOf('plan') === 0 || t === 'target-version' || t === 'channel' || t === 'tag-name' || t === 'artifact-name' || t === 'manifest-url') return '版本规划';
      if (t.indexOf('git-') === 0 || t === 'tag-exists') return 'Git 状态';
      return '环境与产物';
    }
    if (stage === 'VERIFY') {
      if (t.charAt(0) === 'F') return '四等式（从磁盘字节重算）';
      if (t.charAt(0) === 'I') return 'U1–U5 不变量';
      if (t.charAt(0) === 'A' || t.charAt(0) === 'B' || t.charAt(0) === 'C' || t.charAt(0) === 'D') return '产物';
      if (t.charAt(0) === 'E' || t.charAt(0) === 'G') return '清单';
      return '其它核对';
    }
    if (stage === 'SEAL') {
      if (t.indexOf('three-way') === 0 || t.indexOf('reread') === 0) return '最终三方对账（重新从磁盘读取）';
      if (t.indexOf('archive') === 0 || t === 'layout-gate' || t === 'release-set') return 'dist 治理';
      return '封装';
    }
    return '结果';
  }

  function renderLog(s) {
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
    el('logbar-meta').textContent = STATE.logLines.length + ' 行 · 阶段日志 ' + ((s.log && s.log.seq) || 0);
    if (el('log-follow').checked && !el('logbar-body').hidden) view.scrollTop = view.scrollHeight;
    STATE.logSeq = (s.log && s.log.seq) || STATE.logSeq;
  }

  function formatLine(l) {
    var at = String(l.at || '').replace('T', ' ').replace('Z', '');
    var st = l.stage ? '[' + l.stage + '] ' : '';
    if (l.kind === 'item') {
      return at + '  ' + st + 'ITEM ' + (l.status || '') + '  ' + (l.title || l.key) +
        (l.actual ? '  → ' + l.actual : '');
    }
    if (l.kind === 'command') {
      return at + '  ' + st + 'EXEC ' + l.file + ' ' + (l.args || []).join(' ') + '  → exit ' + l.exitCode;
    }
    if (l.kind === 'blocked') return at + '  ' + st + 'BLOCKED ' + l.code + ' — ' + l.message;
    if (l.kind === 'warn') return at + '  ' + st + 'WARN ' + l.code + ' — ' + l.message;
    if (l.kind === 'stage') return at + '  ===== ' + l.stage + ' =====' + (l.dryRun ? '  (DRY RUN)' : '');
    return at + '  ' + st + (l.message || JSON.stringify(l));
  }

  /* ── publish panel ─────────────────────────────────────────────────────── */

  function renderPublishBox(s) {
    var box = el('publish-box');
    if (!STATE.publishPlan) { box.hidden = true; return; }
    var p = STATE.publishPlan;
    box.hidden = false;
    box.textContent = '';

    box.appendChild(h('p', 'note', 'tag ' + p.tag + ' · 产物 ' + bytes(p.artifact.bytes) + ' · sha256 ' + String(p.artifact.sha256).slice(0, 16) + '…'));
    if (p.blockers && p.blockers.length) {
      var ul = document.createElement('ul');
      ul.className = 'note';
      p.blockers.forEach(function (b) { ul.appendChild(h('li', null, b.code + ' — ' + (b.why || ''))); });
      box.appendChild(ul);
    }

    var list = document.createElement('ul');
    list.className = 'publish-actions';
    p.actions.forEach(function (a) {
      var li = document.createElement('li');
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.dataset.action = a.id;
      cb.checked = true;
      if (a.irreversible) cb.dataset.irreversible = '1';
      var label = document.createElement('label');
      label.appendChild(h('span', 'tagpill ' + (a.irreversible ? 'irr' : 'loc'), a.irreversible ? '不可逆' : '本地'));
      label.appendChild(document.createTextNode(a.label));
      label.appendChild(h('code', null, a.command));
      var wrap = document.createElement('div');
      wrap.appendChild(label);
      li.appendChild(cb);
      li.appendChild(wrap);
      list.appendChild(li);
    });
    box.appendChild(list);

    var row = h('div', 'confirm-row');
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn danger';
    btn.id = 'btn-do-publish';
    btn.textContent = '执行已勾选的动作';
    btn.addEventListener('click', doPublish);
    row.appendChild(btn);
    var close = document.createElement('button');
    close.type = 'button';
    close.className = 'btn tiny';
    close.textContent = '收起';
    close.addEventListener('click', function () { STATE.publishPlan = null; render(); });
    row.appendChild(close);
    box.appendChild(row);
    box.appendChild(h('p', 'note', p.ok ? '' : '前置条件未满足时不会执行任何动作。'));
  }

  function bytes(n) {
    if (typeof n !== 'number' || n < 0) return '—';
    return (n / 1048576).toFixed(1) + ' MiB (' + n + ' B)';
  }

  function doPublish() {
    var p = STATE.publishPlan;
    if (!p) return;
    var chosen = [];
    document.querySelectorAll('#publish-box input[data-action]').forEach(function (cb) {
      if (cb.checked) chosen.push(cb.dataset.action);
    });
    if (!chosen.length) { toast('没有勾选任何动作。', 'err'); return; }
    var hasIrr = chosen.some(function (id) {
      var a = p.actions.find(function (x) { return x.id === id; });
      return a && a.irreversible;
    });
    var msg = '即将执行 ' + chosen.length + ' 个动作' + (hasIrr ? '，其中包含不可逆的外部动作' : '') +
      '：\n\n' + chosen.join(', ') +
      '\n\n清单（update-stable.json）的上传是进入 Stable 通道的那一刻。确定继续？';
    if (!window.confirm(msg)) return;

    STATE.busy = true;
    var actions = [];
    p.actions.forEach(function (a) { if (chosen.indexOf(a.id) >= 0) actions.push(a.id); });
    api('/api/run', {
      method: 'POST',
      body: {
        stage: 'PUBLISH',
        actions: actions,
        fingerprint: p.fingerprint,
        confirmation: p.confirmation,
        options: {}
      }
    }).then(function (r) {
      applySnapshot(r.snapshot);
      var res = r.result || {};
      if (res.status === 'ok') toast('PUBLISH 完成。请按 RELEASE.md §6 在 Release 页面独立核对 asset digest。', 'ok');
      else toast('PUBLISH BLOCKED：' + ((res.blockers || []).map(function (b) { return b.code; }).join(', ') || '见日志'), 'err');
      STATE.publishPlan = null;
      refresh();
    }).catch(function (e) { toast(String(e.message || e), 'err'); })
      .then(function () { STATE.busy = false; });
  }

  function loadPublishPlan() {
    api('/api/publish-plan').then(function (r) {
      if (!r.ok && r.error === 'no-repo') { toast('还没有识别到仓库根目录。', 'err'); return; }
      STATE.publishPlan = r;
      STATE.selected = 'PUBLISH';
      render();
    }).catch(function (e) { toast(String(e.message || e), 'err'); });
  }

  /* ── actions ───────────────────────────────────────────────────────────── */

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
        archiveOldReleases: el('opt-archive').checked,
        probeNetwork: el('opt-probe').checked,
        regenerateManifest: el('opt-regen').checked
      }
    }).catch(function () { return null; });
  }

  function runStage(stage) {
    var t = el('target').value.trim();
    if (!/^\d+\.\d+\.\d+$/.test(t)) {
      el('target').classList.add('is-bad');
      toast('目标版本必须是 MAJOR.MINOR.PATCH，例如 1.0.6。', 'err');
      return Promise.resolve();
    }
    el('target').classList.remove('is-bad');
    STATE.busy = true;
    render();
    return pushOptions()
      .then(function () { return api('/api/run', { method: 'POST', body: { stage: stage } }); })
      .then(function (r) {
        if (r.snapshot) applySnapshot(r.snapshot);
        if (r.result && r.result.status === 'blocked') {
          toast(stage + ' BLOCKED：' + ((r.result.blockers || []).map(function (b) { return b.code || b.why; }).join(', ') || '见日志'), 'err');
          STATE.selected = stage;
        } else if (r.result) {
          toast(stage + ' ' + r.result.status.toUpperCase(), r.result.status === 'ok' ? 'ok' : '');
          if (!isLast(stage)) STATE.selected = nextStage(stage);
        }
        return refresh();
      })
      .catch(function (e) { toast(String(e.message || e), 'err'); })
      .then(function () { STATE.busy = false; render(); });
  }

  function isLast(stage) {
    if (stage === 'PUBLISH') return true;
    var idx = stageNames.indexOf(stage);
    if (idx < 0) return true;
    var st = STATE.snapshot && STATE.snapshot.stages;
    if (!st) return true;
    var next = stageNames[idx + 1];
    return next === 'PUBLISH' || st[next].status === 'blocked';
  }

  function nextStage(stage) {
    var idx = stageNames.indexOf(stage);
    return stageNames[Math.min(idx + 1, stageNames.length - 1)];
  }

  function oneClick() {
    var t = el('target').value.trim();
    if (!/^\d+\.\d+\.\d+$/.test(t)) {
      el('target').classList.add('is-bad');
      toast('目标版本必须是 MAJOR.MINOR.PATCH。', 'err');
      return;
    }
    var cur = (STATE.snapshot && STATE.snapshot.describe && STATE.snapshot.describe.version) || '?';
    var msg = '将执行：CHECK → BUILD → VERIFY → SEAL → 停止。\n\n' +
      cur + ' → ' + t + '\n\n' +
      '· 会修改 VERSION 与 README 的「当前版本」字面量（构建失败会自动回滚）\n' +
      '· 会运行 canonical 构建 scripts\\build-installer.ps1（约 30–60 秒）\n' +
      '· 不会 push、不会 tag、不会创建 release、不会上传任何东西\n\n继续？';
    if (!window.confirm(msg)) return;
    STATE.busy = true;
    STATE.selected = 'CHECK';
    render();
    pushOptions()
      .then(function () { return api('/api/run', { method: 'POST', body: { stage: 'ONECLICK' } }); })
      .then(function (r) {
        if (r.snapshot) applySnapshot(r.snapshot);
        var st = r.snapshot && r.snapshot.status;
        if (st === 'READY') { toast('RELEASE READY —— 尚未发布。可以查看 Publish 计划。', 'ok'); STATE.selected = 'PUBLISH'; }
        else toast('RELEASE BLOCKED —— 见各阶段详情。', 'err');
        return refresh();
      })
      .catch(function (e) { toast(String(e.message || e), 'err'); })
      .then(function () { STATE.busy = false; render(); });
  }

  function dryRun() {
    STATE.busy = true;
    render();
    pushOptions()
      .then(function () { return api('/api/run', { method: 'POST', body: { stage: 'DRY' } }); })
      .then(function (r) {
        if (r.snapshot) applySnapshot(r.snapshot);
        if (!r.dry) return refresh();
        STATE.dryPlan = r.dry.plan;
        var body = el('detail-body');
        body.textContent = '';
        STATE.selected = 'CHECK';
        el('detail-title').textContent = 'DRY RUN · 零副作用计划';
        el('detail-sub').textContent = r.dry.ok
          ? '未修改任何文件、未构建、未改清单、未移动 dist、未 tag、未 push、未 upload。'
          : 'CHECK 未通过，因此没有可执行的计划。';
        var g = h('div', 'group');
        g.appendChild(h('h3', null, '计划'));
        g.appendChild(pre(STATE.dryPlan ? STATE.dryPlan.text : '（无）'));
        body.appendChild(g);
        toast(r.dry.ok ? 'Dry Run 完成（零副作用）。' : 'Dry Run：CHECK 未通过。', r.dry.ok ? 'ok' : 'err');
        render();
        return null;
      })
      .catch(function (e) { toast(String(e.message || e), 'err'); })
      .then(function () { STATE.busy = false; });
  }

  function reset() {
    api('/api/run', { method: 'POST', body: { stage: 'RESET' } }).then(function (r) {
      STATE.logLines = [];
      STATE.logSeq = 0;
      STATE.dryPlan = null;
      STATE.publishPlan = null;
      applySnapshot(r.snapshot);
      toast('已重置。', 'ok');
    }).catch(function (e) { toast(String(e.message || e), 'err'); });
  }

  function cancel() {
    api('/api/cancel', { method: 'POST' }).then(function (r) {
      toast(r.ok ? '已请求取消。' : '当前没有正在运行的阶段。', r.ok ? 'ok' : 'err');
    });
  }

  /* ── wiring ────────────────────────────────────────────────────────────── */

  el('btn-check').addEventListener('click', function () { runStage('CHECK'); });
  el('btn-oneclick').addEventListener('click', oneClick);
  el('btn-dry').addEventListener('click', dryRun);
  el('btn-reset').addEventListener('click', reset);
  el('btn-cancel').addEventListener('click', cancel);
  el('btn-plan-publish').addEventListener('click', loadPublishPlan);

  el('target').addEventListener('input', function () {
    var ok = /^\d+\.\d+\.\d+$/.test(el('target').value.trim());
    el('target').classList.toggle('is-bad', el('target').value.length > 0 && !ok);
  });
  el('target').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); runStage('CHECK'); }
  });

  ['opt-archive', 'opt-probe', 'opt-regen'].forEach(function (id) {
    el(id).addEventListener('change', function () { pushOptions().then(refresh); });
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
    var text = el('log-view').textContent || '';
    if (!text) { toast('日志为空。', 'err'); return; }
    navigator.clipboard.writeText(text).then(function () { toast('已复制到剪贴板。', 'ok'); },
      function () { toast('复制失败：选中日志文本后手动复制。', 'err'); });
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      var focus = document.activeElement && document.activeElement.id;
      if (focus === 'target') return;
      oneClick();
    } else if (e.key === 'Escape') {
      if (STATE.snapshot && STATE.snapshot.running) cancel();
    } else if (e.key === 'l' && e.altKey) {
      e.preventDefault();
      el('logbar-head').click();
    }
  });

  /* Poll while a stage runs; otherwise refresh lazily on focus. */
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
