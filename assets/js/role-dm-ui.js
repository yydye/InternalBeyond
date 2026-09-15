/* ====================================================================
   IB Role DM UI — 角色私信（角色 ↔ 角色）的显示层
   --------------------------------------------------------------------
   边界（本文件**只**做显示与交互，不做任何判定）：
     · 唯一的执行入口是 IB.roleDm.start / IB.roleDm.clearThread /
       IB.roleDm.deleteThread —— 本文件绝不自己调用模型、绝不自己写存储。
     · 本文件不渲染用户输入框：用户不是角色私信的 participant。
       用户能做的三件事被明确做成三个独立按钮：让她们聊一会儿 / 停止 /
       给话题（可选，只作为本次 run 的 trigger context，绝不写进 persona）。
     · 本文件不订阅 DOM 事件之外的东西：scheduler 若以后要驱动 run，
       它调用 IB.roleDm.startAutonomous（canonical trigger API），
       **绝不**碰 DOM；本层只通过 IB.roleDmEmit 的轻量事件重绘。
   ==================================================================== */
(function (NS) {
  'use strict';

  var activeThreadId = null;
  var _currentAbort = null;
  var _busy = false;
  var _unsub = null;

  var RUN_STOP_TEXT = {
    'max-turns': '聊到本轮的轮数上限，自然停下来了。',
    'run-complete': '这一轮聊完了。',
    'duplicate-stall': '两边开始重复同一件事，已停下（没有把重复的话写进记录）。',
    'low-info-stall': '对话变得空洞重复，已停下。',
    'aborted': '已停止。',
    'provider-failed': '有一方没能回应（模型请求失败），本轮已安全停止；已经聊过的内容都保留着。',
    'provider-not-ready': '有一方的模型配置不完整，本轮无法开始。请到 API 页面补全。',
    'missing-character': '参与的一方已经不在站点里了，本轮无法继续。',
    'persist-failed': '消息没能保存下来，本轮已停止。',
    'pair-cooldown': '刚聊过，稍等一会儿再继续。',
    'role-daily-cap': '今天聊得够多了，明天再继续。',
    'thread-busy': '这段私聊正在聊，请等它结束。',
    'character-busy': '有一方正在别处回复，稍后再试。',
    'bad-message': '这一轮的内容没能通过校验，已停止。',
    'run-error': '本轮遇到意外错误，已安全停止。'
  };

  function el(id) { try { return document.getElementById(id); } catch (e) { return null; } }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (ch) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch];
    });
  }
  function rd() { try { return NS.roleDm || null; } catch (e) { return null; } }
  /* 自主社交层（Phase 3）。**可能不存在** —— 它是可选能力，本文件必须在
     它缺席时完整可用（手动角色私信不依赖自主调度）。
     注意本文件绝不 import 它：UI 只是它的一个消费者。 */
  function soc() { try { return NS.roleDmSocial || null; } catch (e) { return null; } }

  function timeLabel(ts) {
    var t = Number(ts) || 0;
    if (!t) return '';
    var d = new Date(t), now = new Date(), pad = function (n) { return String(n).padStart(2, '0'); };
    if (d.toDateString() === now.toDateString()) return pad(d.getHours()) + ':' + pad(d.getMinutes());
    var yest = new Date(now); yest.setDate(now.getDate() - 1);
    if (d.toDateString() === yest.toDateString()) return '昨天 ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
    var days = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
    if (now - d < 7 * 86400000) return days[d.getDay()] + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
    return (d.getMonth() + 1) + '月' + d.getDate() + '日';
  }

  /* ── 列表 ─────────────────────────────────────────────────────── */
  async function renderList() {
    var host = el('roledm-list');
    if (!host) return;
    var api = rd();
    if (!api) { host.innerHTML = '<div class="empty-state"><span>✉</span>角色私信模块未就绪。</div>'; return; }
    var threads = await api.listThreads();
    if (!threads.length) {
      host.innerHTML = '<div class="empty-state"><span>✉</span>还没有角色之间的私聊 — 点「+ 新建角色私信」开始。</div>';
      return;
    }
    host.innerHTML = threads.map(function (t) {
      var avatarA = avatarHtml(t.participants[0]);
      var avatarB = avatarHtml(t.participants[1]);
      var last = t.lastPreview ? esc(t.lastPreview) + (String(t.lastPreview).length >= 60 ? '…' : '') : '<span class="roledm-muted">（还没有消息）</span>';
      var badges = [];
      if (t.running) badges.push('<span class="roledm-badge running">正在聊</span>');
      if (t.state === 'archived') badges.push('<span class="roledm-badge archived">已归档</span>');
      var missing = t.participants.filter(function (p) { return p.missing; });
      if (missing.length) badges.push('<span class="roledm-badge warn">' + esc(missing.map(function (p) { return p.name; }).join('、')) + ' 已删除</span>');
      /* 「谁主动发起的」：来自 thread 上的 lastInitiatedBy（角色 id）。
         这是 autonomous 唯一的**事后**可见证据，且它是既成事实而不是推测
         —— 没有它，用户看到一次自主私聊时无法分辨那是不是自己点过。 */
      var initiator = String(t.lastInitiatedBy || '');
      if (initiator) {
        var iniName = '';
        for (var pi = 0; pi < t.participants.length; pi++) if (String(t.participants[pi].id) === initiator) iniName = t.participants[pi].name;
        if (iniName) badges.push('<span class="roledm-badge auto">' + esc(iniName) + ' 主动发起</span>');
      }
      return '<div class="roledm-item glass-card" data-thread="' + esc(t.threadId) + '">'
        + '<div class="roledm-item-top">'
        + '<span class="roledm-pair">' + avatarA + '<span class="roledm-name">' + esc(t.participants[0].name) + '</span>'
        + '<span class="roledm-arrow">↔</span>'
        + avatarB + '<span class="roledm-name">' + esc(t.participants[1].name) + '</span></span>'
        + '<span class="roledm-time">' + esc(timeLabel(t.lastMessageAt || t.createdAt)) + '</span>'
        + '</div>'
        + '<div class="roledm-preview">' + last + '</div>'
        + '<div class="roledm-item-foot"><span class="roledm-count">' + Number(t.messageCount || 0) + ' 条</span>' + badges.join('') + '</div>'
        + '</div>';
    }).join('');
    Array.prototype.forEach.call(host.querySelectorAll('.roledm-item'), function (node) {
      node.addEventListener('click', function () { openThread(node.getAttribute('data-thread')); });
    });
  }

  function avatarHtml(p) {
    var name = String((p && p.name) || 'AI');
    var ch = name.slice(0, 1) || 'A';
    var cls = p && p.missing ? ' roledm-avatar missing' : '';
    return '<span class="roledm-avatar' + cls + '" aria-hidden="true">' + esc(ch) + '</span>';
  }

  /* ── 详情 ─────────────────────────────────────────────────────── */
  async function openThread(threadId) {
    var api = rd();
    if (!api) return;
    activeThreadId = String(threadId);
    var listView = el('roledm-view-list'), detailView = el('roledm-view-detail');
    if (listView) listView.style.display = 'none';
    if (detailView) detailView.style.display = '';
    await renderDetail();
  }
  function backToList() {
    activeThreadId = null;
    var listView = el('roledm-view-list'), detailView = el('roledm-view-detail');
    if (detailView) detailView.style.display = 'none';
    if (listView) listView.style.display = '';
    renderList();
  }

  async function renderDetail() {
    var api = rd();
    if (!api || !activeThreadId) return;
    var d = await api.threadDetail(activeThreadId);
    var headEl = el('roledm-detail-head'), bodyEl = el('roledm-detail-body'), ctlEl = el('roledm-detail-controls'), noteEl = el('roledm-detail-note');
    if (!d) {
      if (headEl) headEl.innerHTML = '<div class="roledm-muted">这段私聊已经不存在了。</div>';
      if (bodyEl) bodyEl.innerHTML = '';
      if (ctlEl) ctlEl.innerHTML = '';
      return;
    }
    var a = d.participants[0], b = d.participants[1];
    if (headEl) {
      headEl.innerHTML = avatarHtml(a) + '<span class="roledm-name">' + esc(a.name) + '</span>'
        + '<span class="roledm-arrow">↔</span>' + avatarHtml(b) + '<span class="roledm-name">' + esc(b.name) + '</span>';
    }
    if (bodyEl) {
      if (!d.messages.length) {
        bodyEl.innerHTML = '<div class="roledm-empty">还没有消息。点下面的「让她们聊一会儿」开始。</div>';
      } else {
        bodyEl.innerHTML = d.messages.map(function (m) {
          var side = (m.senderId === a.id) ? 'left' : 'right';
          return '<div class="roledm-msg ' + side + '">'
            + '<div class="roledm-msg-meta">' + esc(m.senderName) + '<span class="roledm-msg-time">' + esc(timeLabel(m.timestamp)) + '</span></div>'
            + '<div class="roledm-bubble">' + esc(m.content) + '</div>'
            + '<div class="roledm-msg-model">' + esc([m.provider, m.model].filter(Boolean).join(' · ')) + '</div>'
            + '</div>';
        }).join('');
        bodyEl.scrollTop = bodyEl.scrollHeight;
      }
    }
    if (noteEl) {
      var notes = [];
      /* provider 不可用时**明确展示** degraded / error，而不是静默什么都不说。 */
      var bad = d.participants.filter(function (p) { return p.missing || !p.ready; });
      if (bad.length) {
        notes.push('<div class="roledm-note warn">' + esc(bad.map(function (p) { return p.name + (p.missing ? '（角色已删除）' : '（模型配置不完整）'); }).join('、'))
          + '：本轮无法开始。请到 API 页面处理后再来。</div>');
      }
      if (d.state === 'archived') notes.push('<div class="roledm-note">这段私聊已归档：历史保留，但不能继续聊。</div>');
      if (d.stopReason && RUN_STOP_TEXT[d.stopReason]) notes.push('<div class="roledm-note">' + esc(RUN_STOP_TEXT[d.stopReason]) + '</div>');
      noteEl.innerHTML = notes.join('');
    }
    if (ctlEl) {
      var disabled = (!a.ready || !b.ready || d.state === 'archived' || d.running) ? ' disabled' : '';
      ctlEl.innerHTML = '<button type="button" class="btn btn-primary" id="roledm-start-btn"' + disabled + '>让她们聊一会儿</button>'
        + '<button type="button" class="btn" id="roledm-stop-btn"' + (d.running ? '' : ' disabled') + '>停止</button>'
        + '<input class="btn roledm-topic" id="roledm-topic" type="text" maxlength="120" placeholder="给话题（可选，仅这一次）" autocomplete="off">'
        + '<span class="roledm-ctl-right">'
        + '<button type="button" class="btn" id="roledm-clear-btn">清空聊天记录</button>'
        + '<button type="button" class="btn" id="roledm-del-btn">删除这段私聊</button>'
        + '</span>';
      bindDetailControls();
    }
  }

  function bindDetailControls() {
    var startBtn = el('roledm-start-btn');
    if (startBtn) startBtn.addEventListener('click', onStart);
    var stopBtn = el('roledm-stop-btn');
    if (stopBtn) stopBtn.addEventListener('click', onStop);
    var clearBtn = el('roledm-clear-btn');
    if (clearBtn) clearBtn.addEventListener('click', onClear);
    var delBtn = el('roledm-del-btn');
    if (delBtn) delBtn.addEventListener('click', onDelete);
  }

  /* ── 交互 ─────────────────────────────────────────────────────── */
  async function onStart() {
    var api = rd();
    if (!api || !activeThreadId || _busy) return;
    _busy = true;
    var startBtn = el('roledm-start-btn');
    if (startBtn) { startBtn.disabled = true; startBtn.textContent = '正在聊…'; }
    var noteEl = el('roledm-detail-note');
    if (noteEl) noteEl.innerHTML = '<div class="roledm-note">正在让她们聊一会儿…</div>';
    var topicEl = el('roledm-topic');
    var topic = topicEl ? String(topicEl.value || '').trim() : '';
    var d = await api.threadDetail(activeThreadId);
    _currentAbort = (typeof AbortController === 'function') ? new AbortController() : null;
    var res = null;
    try {
      res = await api.start(d.participants[0].id, d.participants[1].id, {
        topic: topic,
        turns: 4,
        signal: _currentAbort ? _currentAbort.signal : null
      });
    } catch (e) {
      res = { ok: false, reason: 'run-error' };
    } finally {
      _busy = false;
      _currentAbort = null;
    }
    if (topicEl) topicEl.value = '';
    /* 如实回报停止原因；绝不假装聊过（res.turns === 0 时明说没有产生消息）。 */
    if (!res || !res.ok) {
      var why = (res && (RUN_STOP_TEXT[res.reason] || RUN_STOP_TEXT[res.stopReason])) || '本轮没有产生新的消息。';
      if (noteEl) noteEl.innerHTML = '<div class="roledm-note warn">' + esc(why) + '</div>';
    }
    await renderDetail();
    renderList();
  }

  function onStop() {
    if (_currentAbort) { try { _currentAbort.abort(); } catch (e) { } }
    var api = rd();
    if (api && activeThreadId && !api.isRunning(activeThreadId)) {
      /* 没有正在跑的 run：如实说明，而不是让按钮看起来"点了但没反应"。 */
      var noteEl = el('roledm-detail-note');
      if (noteEl) noteEl.innerHTML = '<div class="roledm-note">这会儿没有正在进行的对话。</div>';
    }
  }

  async function onClear() {
    var api = rd();
    if (!api || !activeThreadId) return;
    if (!confirm('清空这段私聊的聊天记录？\n\n两个角色之间的这段对话内容，以及由这段对话形成的「共同经历备忘」都会被删除。但「他们对彼此的看法」以及已经沉淀到长期记忆里的事不会被一起删掉 —— 本版本不做也无法做记忆级联删除。')) return;
    await api.clearThread(activeThreadId);
    await renderDetail();
    renderList();
  }

  async function onDelete() {
    var api = rd();
    if (!api || !activeThreadId) return;
    if (!confirm('删除整段私聊？\n\n聊天记录、由这段对话形成的「共同经历备忘」，以及这段私聊本身都会被删除；两个角色对彼此的关系状态会保留（关系不是聊天记录的附属品）。已经沉淀到长期记忆里的事同样不会被删除。')) return;
    await api.deleteThread(activeThreadId);
    backToList();
  }

  /* ── 新建 ─────────────────────────────────────────────────────── */
  function openCreate() {
    var ov = el('roledm-create-overlay');
    if (!ov) return;
    var api = rd();
    var chars = api ? api.listCharacters() : [];
    var selA = el('roledm-create-a'), selB = el('roledm-create-b');
    var opts = chars.map(function (c) {
      return '<option value="' + esc(c.id) + '">' + esc(c.name) + (c.ready ? '' : '（模型配置不完整）') + '</option>';
    }).join('');
    if (selA) selA.innerHTML = '<option value="">选择角色…</option>' + opts;
    if (selB) selB.innerHTML = '<option value="">选择角色…</option>' + opts;
    var msg = el('roledm-create-msg');
    if (msg) msg.textContent = chars.length < 2 ? '至少需要两个角色才能建立角色私信。' : '';
    ov.classList.add('show');
  }
  function closeCreate() {
    var ov = el('roledm-create-overlay');
    if (ov) ov.classList.remove('show');
  }
  async function confirmCreate() {
    var api = rd();
    if (!api) return;
    var a = el('roledm-create-a'), b = el('roledm-create-b'), msg = el('roledm-create-msg');
    var aid = a ? String(a.value || '') : '', bid = b ? String(b.value || '') : '';
    if (!aid || !bid) { if (msg) msg.textContent = '请选择两个角色。'; return; }
    if (aid === bid) { if (msg) msg.textContent = '两个角色不能是同一个人。'; return; }
    var res = await api.resolveThread(aid, bid);
    if (!res || !res.ok) { if (msg) msg.textContent = '无法建立这段私聊（' + esc((res && res.reason) || 'unknown') + '）。'; return; }
    closeCreate();
    /* 已存在则直接打开（不重复创建）。 */
    await openThread(res.thread.threadId);
    renderList();
  }

  /* ── 自主发起设置（Phase 3）───────────────────────────────────────
     设计原则：**默认全关**，而且"关"必须是一眼可见的（summary 上带状态字），
     不允许出现"看起来开着其实没开"的模糊状态。

     两个开关是**AND**关系，UI 必须如实呈现这一点 —— 只开总开关时，
     角色行仍然是关闭态，行尾状态字会说"未开启"，而不是假装它在工作。 */
  function initiativeLabel(v) {
    var n = Number(v) || 0;
    if (n < 0.2) return '很安静';
    if (n < 0.45) return '偏安静';
    if (n < 0.7) return '一般';
    if (n < 0.9) return '偏活跃';
    return '很活跃';
  }
  function renderAuto() {
    var host = el('roledm-auto-body');
    var stateEl = el('roledm-auto-state');
    if (!host) return;
    var api = rd(), s = soc();
    if (!api) { host.innerHTML = '<div class="roledm-note">角色私信模块未就绪。</div>'; return; }
    if (!s) {
      /* 能力缺席时如实说明，不隐藏这一块（隐藏会让用户以为功能被移除，
         而实际是脚本没加载）。 */
      host.innerHTML = '<div class="roledm-note warn">自主调度模块未加载，主动角色私信当前不可用。手动「让她们聊一会儿」不受影响。</div>';
      if (stateEl) stateEl.textContent = '不可用';
      return;
    }
    var g = s.prefs().global;
    var on = g.enabled === true;
    if (stateEl) stateEl.textContent = on ? '总开关已打开' : '未开启';
    var chars = api.listCharacters();
    var rows = chars.map(function (ch) {
      var p = s.characterPrefs(ch.id);
      var ready = ch.ready !== false;
      return '<div class="roledm-auto-row" data-char="' + esc(ch.id) + '">'
        + '<label class="roledm-auto-name"><input type="checkbox" data-role="enabled"' + (p.enabled ? ' checked' : '') + (ready ? '' : ' disabled') + '> '
        + esc(ch.name) + (ready ? '' : '<span class="roledm-muted">（模型配置不完整）</span>') + '</label>'
        + '<div class="roledm-auto-ctl">'
        + '<span class="roledm-auto-lab">主动程度</span>'
        + '<input type="range" min="0" max="1" step="0.05" value="' + esc(String(p.initiative)) + '" data-role="initiative">'
        + '<span class="roledm-auto-val" data-role="initiative-label">' + esc(initiativeLabel(p.initiative)) + '</span>'
        + '</div>'
        + '<div class="roledm-auto-ctl">'
        + '<span class="roledm-auto-lab">每日上限</span>'
        + '<input type="number" min="1" max="20" step="1" value="' + esc(String(p.dailyLimit)) + '" data-role="dailyLimit">'
        + '<label class="roledm-auto-sub"><input type="checkbox" data-role="allowStrangers"' + (p.allowStrangers ? ' checked' : '') + '> 允许主动联系还不熟悉的角色</label>'
        + '</div>'
        + '</div>';
    }).join('');
    host.innerHTML = '<div class="roledm-auto-master">'
      + '<label><input type="checkbox" id="roledm-auto-global"' + (on ? ' checked' : '') + '> 允许角色主动联系其他角色（总开关）</label>'
      + '<div class="roledm-muted">关掉后立刻不再产生新的主动私聊；正在进行的会自然聊完。默认关闭。</div>'
      + '</div>'
      + (rows || '<div class="roledm-note">还没有可用的角色。</div>')
      + '<div class="roledm-note">主动私聊是低频的：大多数时候角色不会联系任何人。它只会在有明确社会理由（聊过、久未联系、关系够近）时才发生，并且受每日上限与冷却限制。'
      + '角色自己找谁聊天**不会**改变她们对彼此的关系 —— 只有真正聊过之后才会。</div>';
    bindAutoControls();
  }
  function bindAutoControls() {
    var s = soc();
    if (!s) return;
    var gEl = el('roledm-auto-global');
    if (gEl) {
      gEl.addEventListener('change', function () {
        s.setGlobalEnabled(!!gEl.checked);
        renderAuto();
      });
    }
    var host = el('roledm-auto-body');
    if (!host) return;
    var rows = host.querySelectorAll('.roledm-auto-row');
    for (var i = 0; i < rows.length; i++) {
      (function (row) {
        var cid = String(row.getAttribute('data-char') || '');
        if (!cid) return;
        var pairs = [
          ['enabled', 'change'],
          ['initiative', 'input'],
          ['dailyLimit', 'change'],
          ['allowStrangers', 'change']
        ];
        for (var k = 0; k < pairs.length; k++) {
          var input = row.querySelector('[data-role="' + pairs[k][0] + '"]');
          if (!input) continue;
          (function (inp, role, evName) {
            inp.addEventListener(evName, function () {
              var patch = {};
              if (role === 'enabled') patch.enabled = !!inp.checked;
              else if (role === 'allowStrangers') patch.allowStrangers = !!inp.checked;
              else if (role === 'initiative') patch.initiative = Number(inp.value);
              else if (role === 'dailyLimit') patch.dailyLimit = parseInt(inp.value, 10);
              var next = s.setCharacterPrefs(cid, patch);
              /* 滑块的**值文字**必须跟着动，但不重绘整块 ——
                 重绘会在拖动过程中把 range 的焦点丢掉。 */
              if (role === 'initiative') {
                var lab = row.querySelector('[data-role="initiative-label"]');
                if (lab) lab.textContent = initiativeLabel(next.initiative);
              } else {
                renderAuto();
              }
            });
          })(input, pairs[k][0], pairs[k][1]);
        }
      })(rows[i]);
    }
  }

  /* ── 样式表（运行时注入，不占用 HTML 的样式表预算）──
     与 assets/js/diagnostics.js:175-183 同一做法：功能模块自己的 CSS 由模块注入，
     HTML 只保留既有那批 <link>（见 tests/test_setup_wizard.js 的
     「HTML 没有新增样式表」与 test_frontend_structure.js 的
     split.externalStyleCount —— 两处都锁着这个预算）。 */
  var STYLE_ID = 'ib-role-dm-style';
  var STYLE_HREF = 'assets/css/core/role-dm.css';
  function injectStyles() {
    try {
      if (document.getElementById(STYLE_ID)) return;
      var link = document.createElement('link');
      link.id = STYLE_ID;
      link.rel = 'stylesheet';
      link.href = STYLE_HREF;
      document.head.appendChild(link);
    } catch (e) { }
  }

  /* ── 挂载 ─────────────────────────────────────────────────────── */
  function render() {
    var api = rd();
    if (!api) return;
    injectStyles();
    renderList();
    renderAuto();
    if (activeThreadId) renderDetail();
  }
  /* 轻量事件：runtime 在 run 的每个回合与结束时各发一次，本层只重绘。
     （scheduler 因此**不需要**碰 DOM：它触发 run，本层通过事件自然刷新。） */
  NS.roleDmEmit = function (kind, payload) {
    try {
      if (kind === 'turn' && activeThreadId && payload && payload.threadId === activeThreadId) {
        renderDetail();
      } else if (kind === 'run') {
        render();
      }
    } catch (e) { }
  };
  NS.roleDmUI = {
    render: render,
    renderList: renderList,
    renderDetail: renderDetail,
    renderAuto: renderAuto,
    openThread: openThread,
    backToList: backToList,
    openCreate: openCreate,
    closeCreate: closeCreate,
    confirmCreate: confirmCreate,
    setActiveThread: function (id) { activeThreadId = id ? String(id) : null; },
    activeThreadId: function () { return activeThreadId; },
    runStopText: function (reason) { return RUN_STOP_TEXT[reason] || ''; }
  };
  NS.expose('roleDmUI', NS.roleDmUI);
  /* HTML 内联 onclick 用（与既有页面同款约定）。 */
  window.IBRoleDmUI = NS.roleDmUI;
  window.roleDmBack = backToList;
  window.roleDmOpenCreate = openCreate;
  window.roleDmCloseCreate = closeCreate;
  window.roleDmConfirmCreate = confirmCreate;
})(window.IB || (window.IB = {}));
