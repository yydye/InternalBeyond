/* ============================================================================
   IBDiagnostics · P5 系统诊断（普通用户自助诊断中心）

   目标：普通用户遇到异常时，不需要打开 DevTools / PowerShell，也不需要知道
   Bridge、23115、Node.js 这些概念，就能知道「什么功能出了问题、是否影响聊天、
   能不能一键恢复」。

   铁律（本文件不得违反）：
     · 不建立第二套 boot state：启动快照只读 P2 的 GET /__boot-state。
     · 不建立第二套 error catalog：所有用户文案走 P3 的 window.IBERR
       （present / model / detailsText / redact / redactUrl）。
     · 不建立第二套组件词表：组件名沿用 P2 的 static / bridge / active /
       restart / vision。
     · 不建立第二套 provider metadata：AI 连接测试只取 apiConfigs，走既有
       callApiChat 链，不复制 endpoint / model / format。
     · 一键修复只调用已经存在并验证过的恢复动作（backend-restart.js →
       23116 restart control plane），不假装修好、不无限重试、不改用户配置、
       不删数据库、不清缓存、不换端口、不动 API Key。
     · 导出报告是白名单构造 + P3 二次脱敏；无法安全确定的内容一律不导出。

   启动快照 ≠ 当前状态：boot-state 只解释「本次启动发生了什么」，当前状态
   一律以本次实时 probe 为准。
   ============================================================================ */
(function (NS) {
  'use strict';

  var PAGE = 'diagnostics';
  var STYLE_ID = 'ib-diag-style';
  var STYLE_HREF = 'assets/css/diagnostics.css';
  var BOOT_URL = '/__boot-state';
  var PROBE_TIMEOUT_MS = 2500;
  var RESTART_WAIT_MS = 45000;
  var RESTART_POLL_MS = 700;
  var AI_TEST_TIMEOUT_MS = 30000;
  var MAX_ERRORS = 20;
  /* 视觉是否「已安装」的标记：与 scripts/windows/start-vision-service.cmd 建立的虚拟环境一致 */
  var VENV_MARKER = '.venv-vision/pyvenv.cfg';

  /* ── 状态词表（页面唯一来源；不新增第七种） ── */
  var ST = {
    OK: 'ok',
    ATTENTION: 'attention',
    DOWN: 'down',
    OPTIONAL: 'optional',
    CHECKING: 'checking',
    UNKNOWN: 'unknown'
  };
  var ST_TEXT = {
    ok: '正常',
    attention: '需要注意',
    down: '不可用',
    optional: '未安装（可选）',
    checking: '检查中',
    unknown: '状态未知'
  };
  var ST_RANK = { ok: 0, optional: 0, unknown: 1, attention: 2, down: 3, checking: 0 };

  /* ── 能力层（普通用户视角）：顺序即页面顺序 ── */
  var CAPS = [
    { id: 'base', label: '基础运行' },
    { id: 'chat', label: 'AI 聊天' },
    { id: 'bridge', label: '本地增强功能' },
    { id: 'active', label: '后台主动功能' },
    { id: 'voice', label: '语音功能', optional: true },
    { id: 'vision', label: '视觉功能', optional: true }
  ];

  var OVERALL_TEXT = {
    ok: '系统运行正常',
    attention: '部分功能需要注意',
    down: '部分功能暂时不可用',
    unknown: '暂时无法确认系统状态',
    checking: '正在检查…'
  };

  var S = {
    booted: false,
    host: null,
    boot: null,
    probes: {},
    rows: [],
    overall: 'unknown',
    headline: OVERALL_TEXT.unknown,
    sub: '',
    checking: false,
    inflight: null,
    repairing: false,
    aiBusy: false,
    aiTest: null,
    aiTargetId: '',
    detailsOpen: false,
    repairMsg: null,
    repairLog: [],
    errorLog: [],
    lastCheckAt: 0
  };

  /* ── 小工具 ────────────────────────────────────────────── */

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = String(text);
    return n;
  }
  function byId(id) { try { return document.getElementById(id); } catch (e) { return null; } }
  function clear(node) { while (node && node.firstChild) node.removeChild(node.firstChild); }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function clockText(ms) {
    if (!ms) return '';
    var d = new Date(ms);
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
  }
  function isoText(ms) {
    try { return new Date(ms || Date.now()).toISOString(); } catch (e) { return ''; }
  }
  function ageText(ms) {
    if (ms == null || !isFinite(ms)) return '';
    var s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return s + ' 秒前';
    if (s < 3600) return Math.round(s / 60) + ' 分钟前';
    return Math.round(s / 3600) + ' 小时前';
  }
  function safeVal(v) {
    var s = (v == null) ? '' : String(v);
    try {
      if (window.IBERR && typeof window.IBERR.redact === 'function') return window.IBERR.redact(s, 400);
    } catch (e) { /* 脱敏失败时退回截断，绝不原样输出 */ }
    return s.slice(0, 400);
  }
  function safeUrl(u) {
    try {
      if (window.IBERR && typeof window.IBERR.redactUrl === 'function') return window.IBERR.redactUrl(u);
    } catch (e) { /* 同上 */ }
    return safeVal(u);
  }
  function redact(text, maxLen) {
    try {
      if (window.IBERR && typeof window.IBERR.redact === 'function') return window.IBERR.redact(text, maxLen || 60000);
    } catch (e) { /* 同上 */ }
    return String(text || '').slice(0, maxLen || 60000);
  }
  function toastUser(msg) {
    try { if (typeof window.toast === 'function') { window.toast(msg); return; } } catch (e) { }
  }

  /* ── P3 错误码观察器（只记录 code / category / 时间，绝不记录正文）──
     复用既有 IBERR 调用点，不新增第二套错误分类。 */
  function hookErrors() {
    try {
      var e = window.IBERR;
      if (!e || e.__ibDiagHooked) return;
      ['show', 'report'].forEach(function (name) {
        var orig = e[name];
        if (typeof orig !== 'function') return;
        var wrapped = function () {
          try {
            var model = (name === 'report') ? arguments[1] : arguments[0];
            var m = (name === 'report' && model && model.model) ? model.model : model;
            if (m && m.code) recordError(String(m.code), String(m.category || ''));
          } catch (err) { /* 观察器绝不打断主流程 */ }
          return orig.apply(this, arguments);
        };
        wrapped.__ibDiagHooked = true;
        e[name] = wrapped;
      });
      e.__ibDiagHooked = true;
    } catch (err) { }
  }
  function recordError(code, category) {
    S.errorLog.unshift({ code: code, category: category, at: Date.now() });
    if (S.errorLog.length > MAX_ERRORS) S.errorLog.length = MAX_ERRORS;
  }

  /* ── 样式表（运行时注入，不占用 HTML 的样式表 / 内联样式预算）── */
  function injectStyles() {
    if (byId(STYLE_ID)) return;
    var link = document.createElement('link');
    link.id = STYLE_ID;
    link.rel = 'stylesheet';
    link.href = STYLE_HREF;
    document.head.appendChild(link);
  }

  /* ── 探测原语：单次请求 + 硬超时 + 绝不抛出 ── */
  function timedFetch(url, opts, timeoutMs) {
    var started = Date.now();
    var out = { endpoint: String(url || ''), ok: false, httpStatus: 0, json: null, latencyMs: 0, error: null, healthy: false, responding: false };
    if (typeof fetch !== 'function') { out.error = 'no-fetch'; out.unavailable = true; return Promise.resolve(out); }
    var ctl = null;
    try { if (typeof AbortController === 'function') ctl = new AbortController(); } catch (e) { }
    var timer = setTimeout(function () { try { if (ctl) ctl.abort(); } catch (e) { } }, timeoutMs);
    var init = {};
    for (var k in (opts || {})) if (Object.prototype.hasOwnProperty.call(opts, k)) init[k] = opts[k];
    init.cache = 'no-store';
    if (ctl) init.signal = ctl.signal;
    return Promise.resolve().then(function () {
      return fetch(url, init);
    }).then(function (res) {
      return res.text().then(function (text) {
        var json = null;
        try { json = JSON.parse(text); } catch (e) { }
        out.ok = !!res.ok;
        out.responding = true;
        out.httpStatus = res.status;
        out.json = json;
        out.latencyMs = Date.now() - started;
        return out;
      });
    }).catch(function (e) {
      out.latencyMs = Date.now() - started;
      out.error = (e && e.name === 'AbortError') ? 'timeout' : 'unreachable';
      return out;
    }).then(function (r) { clearTimeout(timer); return r; });
  }
  function unavailable(reason) {
    return { ok: false, healthy: false, responding: false, httpStatus: 0, json: null, latencyMs: 0, error: reason, unavailable: true, endpoint: '' };
  }

  /* ── 组件端口：唯一来源是 P2 boot-state（不在前端复制端口表）── */
  function bootComponent(name) {
    var b = S.boot && S.boot.present ? S.boot.state : null;
    return (b && b.components && b.components[name]) || null;
  }
  function portOf(name) {
    var c = bootComponent(name);
    var p = c && Number(c.port);
    return (p > 0 && p <= 65535) ? p : 0;
  }
  function endpointLabel(name, path) {
    var p = portOf(name);
    return p ? ('127.0.0.1:' + p + path) : ('(端口未知) ' + path);
  }

  /* ── 各组件 probe（全部复用现有客户端，不新建请求层）── */

  function probeStatic() {
    var origin = '';
    try { origin = String(location.origin || ''); } catch (e) { }
    if (!origin || origin === 'null') return Promise.resolve(unavailable('file-origin'));
    return timedFetch(origin + '/health', { method: 'GET' }, PROBE_TIMEOUT_MS).then(function (r) {
      r.endpoint = origin + '/health';
      r.identity = r.json ? String(r.json.server || '') : '';
      r.healthy = !!(r.ok && r.json && r.json.ok === true);
      return r;
    });
  }

  function probeBridge() {
    if (typeof window.ibBridgeBase !== 'function') return Promise.resolve(unavailable('bridge-client-missing'));
    var doFetch = (typeof window.ibBridgeFetch === 'function') ? window.ibBridgeFetch : (typeof fetch === 'function' ? fetch : null);
    if (!doFetch) return Promise.resolve(unavailable('no-fetch'));
    var url = window.ibBridgeBase() + '/health';
    return timedFetch(url, { method: 'GET' }, PROBE_TIMEOUT_MS).then(function (r) {
      r.endpoint = url;
      r.identity = r.json ? String(r.json.server || '') : '';
      /* 身份校验与 runtime/local-services-runner.js 的 matchesHealth 一致：端口被别的
         程序占用时不能算健康。 */
      r.healthy = !!(r.ok && r.json && r.json.ok === true && r.identity === 'IB Bridge');
      return r;
    });
  }

  function probeBridgeStatus() {
    if (typeof window.ibBridgeBase !== 'function') return Promise.resolve(unavailable('bridge-client-missing'));
    var doFetch = (typeof window.ibBridgeFetch === 'function') ? window.ibBridgeFetch : (typeof fetch === 'function' ? fetch : null);
    if (!doFetch) return Promise.resolve(unavailable('no-fetch'));
    var url = window.ibBridgeBase() + '/status';
    return timedFetch(url, { method: 'GET' }, PROBE_TIMEOUT_MS).then(function (r) {
      r.endpoint = url;
      r.healthy = !!(r.ok && r.json && r.json.ok === true);
      return r;
    });
  }

  function probeBridgeDiagnostics() {
    if (typeof window.ibBridgeBase !== 'function') return Promise.resolve(unavailable('bridge-client-missing'));
    var doFetch = (typeof window.ibBridgeFetch === 'function') ? window.ibBridgeFetch : (typeof fetch === 'function' ? fetch : null);
    if (!doFetch) return Promise.resolve(unavailable('no-fetch'));
    var url = window.ibBridgeBase() + '/api/diagnostics';
    return timedFetch(url, { method: 'GET' }, PROBE_TIMEOUT_MS).then(function (r) {
      r.endpoint = url;
      r.healthy = !!(r.ok && r.json && r.json.ok === true);
      return r;
    });
  }

  function probeActive() {
    if (typeof window._activeCompanionRequest !== 'function') return Promise.resolve(unavailable('active-client-missing'));
    var t0 = Date.now();
    var out = { endpoint: endpointLabel('active', '/health'), ok: false, healthy: false, responding: false, httpStatus: 0, json: null, latencyMs: 0, error: null };
    return window._activeCompanionRequest('/health', { timeout: PROBE_TIMEOUT_MS }).then(function (json) {
      out.ok = true;
      out.responding = true;
      out.httpStatus = 200;
      out.json = json || null;
      out.latencyMs = Date.now() - t0;
      out.healthy = !!(json && String(json.service || '') === 'internal-beyond-active-messages');
      return out;
    }).catch(function (e) {
      out.latencyMs = Date.now() - t0;
      out.httpStatus = Number(e && e.status) || 0;
      out.error = out.httpStatus ? 'http-' + out.httpStatus : 'unreachable';
      return out;
    });
  }

  function probeRestart() {
    if (!NS.backendRestart || typeof NS.backendRestart.getStatus !== 'function') return Promise.resolve(unavailable('restart-client-missing'));
    var t0 = Date.now();
    var out = { endpoint: endpointLabel('restart', '/status'), ok: false, healthy: false, responding: false, httpStatus: 0, json: null, latencyMs: 0, error: null };
    return NS.backendRestart.getStatus().then(function (json) {
      out.latencyMs = Date.now() - t0;
      if (!json) { out.error = 'unreachable'; return out; }
      out.ok = true;
      out.responding = true;
      out.httpStatus = 200;
      out.json = json;
      out.healthy = String(json.service || '') === 'InternalBeyond Restart';
      return out;
    }).catch(function () { out.latencyMs = Date.now() - t0; out.error = 'unreachable'; return out; });
  }

  function probeVision() {
    var port = portOf('vision');
    if (!port) return Promise.resolve(unavailable('port-unknown'));
    var url = 'http://127.0.0.1:' + port + '/health';
    return timedFetch(url, { method: 'GET' }, PROBE_TIMEOUT_MS).then(function (r) {
      r.endpoint = url;
      r.identity = r.json ? String(r.json.service || '') : '';
      r.healthy = !!(r.ok && r.json && r.json.ok === true && r.identity === 'internal-beyond-vision');
      return r;
    });
  }

  function probeVisionInstall() {
    var url = '';
    try { url = String(location.origin || '') + '/' + VENV_MARKER; } catch (e) { }
    if (!url || url.indexOf('null') === 0) return Promise.resolve(unavailable('file-origin'));
    return timedFetch(url, { method: 'HEAD' }, PROBE_TIMEOUT_MS).then(function (r) {
      r.endpoint = url;
      r.installed = !!r.ok;
      return r;
    });
  }

  var PROBES = {
    static: probeStatic,
    bridge: probeBridge,
    active: probeActive,
    restart: probeRestart,
    bridgeStatus: probeBridgeStatus,
    vision: probeVision,
    visionInstall: probeVisionInstall
  };

  /* ── 启动快照（P2 唯一来源）── */
  function readBootState() {
    if (typeof fetch !== 'function') { S.boot = { present: false, error: 'no-fetch', stale: true, staleReason: 'unavailable', state: null }; return Promise.resolve(S.boot); }
    return timedFetch(BOOT_URL, { method: 'GET' }, PROBE_TIMEOUT_MS).then(function (r) {
      if (r.ok && r.json && typeof r.json === 'object') {
        S.boot = {
          present: !!r.json.present,
          stale: !!r.json.stale,
          staleReason: String(r.json.staleReason || ''),
          ageMs: (typeof r.json.ageMs === 'number') ? r.json.ageMs : null,
          state: r.json.bootState || null,
          path: String(r.json.path || ''),
          schema: String(r.json.schema || ''),
          version: r.json.version,
          error: r.json.error || null
        };
      } else {
        S.boot = { present: false, error: r.error || 'unavailable', stale: true, staleReason: 'unavailable', state: null };
      }
      return S.boot;
    }).catch(function () {
      S.boot = { present: false, error: 'unavailable', stale: true, staleReason: 'unavailable', state: null };
      return S.boot;
    });
  }

  /* ── 角色 / AI 配置（唯一来源 window.apiConfigs，不新建角色表）── */
  /*
   * 角色列表唯一来源是既有 apiConfigs（social.js 的全局绑定；与
   * role-letters.js 使用同一种读取方式：先 window.apiConfigs，再裸标识符）。
   * 绝不新建第二份角色表。
   */
  function listRoles() {
    var all = null;
    try { if (typeof window !== 'undefined' && window.apiConfigs) all = window.apiConfigs; } catch (e) { all = null; }
    if (!all) {
      try { if (typeof apiConfigs !== 'undefined' && apiConfigs) all = apiConfigs; } catch (e) { all = null; }
    }
    if (!all || typeof all.length !== 'number') return [];
    var out = [];
    for (var i = 0; i < all.length; i++) {
      var c = all[i];
      if (c && c.id) out.push(c);
    }
    return out;
  }
  function describeRole(cfg) {
    var ready = true, reason = '';
    var check = (typeof window._ibApiReady === 'function') ? window._ibApiReady : null;
    if (check) {
      ready = !!check(cfg);
      if (!ready) {
        if (!String(cfg.endpoint || '').trim()) reason = '这个角色还没有填写接口地址。';
        else if (!String(cfg.model || '').trim()) reason = '这个角色还没有选择模型。';
        else reason = '这个角色的 API 密钥还没有填写。';
      }
    }
    return {
      id: String(cfg.id),
      label: String(cfg.nickname || cfg.model || '未命名角色'),
      model: String(cfg.model || ''),
      provider: String(cfg.provider || ''),
      ready: ready,
      reason: reason
    };
  }
  function currentRole(roles) {
    var id = '';
    try { if (typeof activeFriendId !== 'undefined' && activeFriendId) id = String(activeFriendId); } catch (e) { }
    var hit = null, i;
    for (i = 0; i < roles.length; i++) if (String(roles[i].id) === id) { hit = roles[i]; break; }
    return describeRole(hit || roles[0]);
  }

  /* ── 能力状态推导（纯函数：输入 boot + probes + ctx → 行 / 总览）── */
  function deriveCaps(boot, probes, ctx) {
    ctx = ctx || {};
    probes = probes || {};
    var bs = (boot && boot.present && !boot.stale) ? boot.state : null;
    function comp(name) { return (bs && bs.components && bs.components[name]) || null; }
    var rows = [];
    function row(spec) { rows.push(spec); return spec; }
    function find(id) { for (var i = 0; i < rows.length; i++) if (rows[i].id === id) return rows[i]; return null; }

    var bootStale = !!(boot && boot.present && boot.stale);
    var bootNote = bootStale ? '启动记录已过期，本次判断以当前检查为准。' : '';
    if (!boot || !boot.present) bootNote = '';

    /* 1. 基础运行（static：唯一致命依赖） */
    var ps = probes.static || null;
    if (!ps || ps.state === 'checking') {
      row({ id: 'base', label: '基础运行', status: ST.CHECKING, detail: '正在检查…', note: bootNote });
    } else if (ps.healthy) {
      row({ id: 'base', label: '基础运行', status: ST.OK, detail: '主界面和本地页面服务正常。', note: bootNote });
    } else if (ps.unavailable) {
      /* 例如直接以 file:// 打开：没有本地页面服务参与，但页面本身可用，不能报成故障 */
      row({ id: 'base', label: '基础运行', status: ST.OK, detail: '页面已直接打开，本地页面服务未参与。', note: bootNote });
    } else {
      var baseNote = bootNote;
      if (!baseNote && bs && bs.overall === 'fatal') baseNote = '上次启动时主界面服务没有正常启动。';
      row({
        id: 'base', label: '基础运行', status: ST.ATTENTION,
        detail: '本地页面服务响应异常，但页面仍然可以正常使用。',
        note: baseNote,
        hint: '此问题无法自动修复。如果页面出现异常，请关闭后重新打开 InternalBeyond。'
      });
    }

    /* 2. AI 聊天 */
    var roles = ctx.roles || [];
    var cur = ctx.currentRole || null;
    var test = ctx.aiTest || null;
    if (!roles.length) {
      row({
        id: 'chat', label: 'AI 聊天', status: ST.ATTENTION,
        detail: '还没有配置 AI 角色。',
        hint: '在「API 设置」里添加一个角色后就可以开始聊天。'
      });
    } else if (test && test.state === 'fail' && (!cur || test.roleId === cur.id)) {
      row({
        id: 'chat', label: 'AI 聊天', status: ST.ATTENTION,
        detail: String(test.title || '上次测试连接失败。'),
        note: test.suggestion ? String(test.suggestion) : '',
        hint: test.retryable ? '可以稍后重新测试连接。' : '此问题无法自动修复。请在「API 设置」里检查后重试。'
      });
    } else if (cur && !cur.ready) {
      row({
        id: 'chat', label: 'AI 聊天', status: ST.ATTENTION,
        detail: cur.reason || '这个角色的配置还不完整。',
        hint: '此问题无法自动修复。请在「API 设置」里补全后再试。'
      });
    } else if (test && test.state === 'ok') {
      row({ id: 'chat', label: 'AI 聊天', status: ST.OK, detail: '上次测试连接正常。' });
    } else {
      row({ id: 'chat', label: 'AI 聊天', status: ST.OK, detail: '已配置 ' + roles.length + ' 个角色，发送消息时会实时连接。' });
    }

    /* 3 / 4. 本地增强功能（bridge）与后台主动功能（active） */
    var restartOk = ctx.restartOk === true;
    function localRow(id, label, probe, compName, clientMissing) {
      var c = comp(compName);
      var note = '';
      var down = false;
      if (probe && probe.state !== 'checking') {
        if (probe.healthy && c && c.probed && c.healthy === false) note = '启动时这项功能曾经降级，现在已经恢复。';
        else if (!probe.healthy && c && c.healthy === true) note = '启动时正常，之后停止了。';
      }
      if (!probe || probe.state === 'checking') {
        return row({ id: id, label: label, status: ST.CHECKING, detail: '正在检查…', note: note });
      }
      if (probe.unavailable) {
        return row({ id: id, label: label, status: ST.UNKNOWN, detail: '暂时无法检查这项功能。', note: note });
      }
      if (probe.healthy) {
        return row({ id: id, label: label, status: ST.OK, detail: label + '正常。', note: note });
      }
      if (probe.responding) {
        return row({
          id: id, label: label, status: ST.ATTENTION,
          detail: '这项功能被另一个程序占用了。', note: note,
          hint: '此问题无法自动修复。请关闭占用它的程序后重新打开 InternalBeyond；具体是哪个程序可以展开「查看技术详情」。'
        });
      }
      down = true;
      var fixable = restartOk && !clientMissing;
      return row({
        id: id, label: label, status: ST.DOWN,
        detail: label + '暂时不可用。', note: note,
        fixable: fixable,
        hint: fixable ? '可以尝试自动修复。' : '此问题无法自动修复。请关闭并重新打开 InternalBeyond。'
      });
    }
    localRow('bridge', '本地增强功能', probes.bridge, 'bridge', ctx.clientMissing && ctx.clientMissing.bridge);
    localRow('active', '后台主动功能', probes.active, 'active', ctx.clientMissing && ctx.clientMissing.active);

    /* 5. 语音功能（Bridge 的 TTS 能力；未配置是可选状态，不是故障） */
    var bridgeRow = find('bridge');
    var bstat = probes.bridgeStatus || null;
    if (bridgeRow && bridgeRow.status === ST.DOWN) {
      row({
        id: 'voice', label: '语音功能', status: ST.DOWN, optional: true,
        detail: '本地增强功能不可用，语音功能暂时无法使用。',
        hint: bridgeRow.fixable ? '' : bridgeRow.hint
      });
    } else if (!bstat || bstat.state === 'checking') {
      row({ id: 'voice', label: '语音功能', status: ST.CHECKING, detail: '正在检查…', optional: true });
    } else if (bstat.json && (bstat.json.tts === true || bstat.json.mimoTts === true)) {
      row({ id: 'voice', label: '语音功能', status: ST.OK, detail: '语音服务已配置。', optional: true });
    } else if (bstat.ok) {
      row({ id: 'voice', label: '语音功能', status: ST.OPTIONAL, detail: '还没有配置语音服务，文字聊天不受影响。', optional: true });
    } else {
      row({ id: 'voice', label: '语音功能', status: ST.UNKNOWN, detail: '暂时无法确认语音服务状态。', optional: true });
    }

    /* 6. 视觉功能（高级可选：未安装不是错误，已安装但起不来也不影响聊天） */
    var pv = probes.vision || null;
    var pi = probes.visionInstall || null;
    var installed = !!(pi && pi.installed);
    if (!pv || pv.state === 'checking') {
      row({ id: 'vision', label: '视觉功能', status: ST.CHECKING, detail: '正在检查…', optional: true });
    } else if (pv.healthy) {
      row({ id: 'vision', label: '视觉功能', status: ST.OK, detail: '视觉功能可用。', optional: true });
    } else if (installed) {
      row({ id: 'vision', label: '视觉功能', status: ST.DOWN, detail: '视觉功能暂不可用。', note: '不影响聊天和其它功能。', optional: true });
    } else {
      row({ id: 'vision', label: '视觉功能', status: ST.OPTIONAL, detail: '视觉识别是可选扩展，当前没有安装。', optional: true });
    }

    /* 总览：只由「非可选」能力决定 */
    var core = rows.filter(function (r) { return !r.optional; });
    var checking = core.some(function (r) { return r.status === ST.CHECKING; });
    var worst = ST.OK;
    core.forEach(function (r) { if (ST_RANK[r.status] > ST_RANK[worst]) worst = r.status; });
    var overall;
    if (checking) overall = 'checking';
    else if (worst === ST.DOWN) overall = 'down';
    else if (worst === ST.ATTENTION) overall = 'attention';
    else if (worst === ST.UNKNOWN) overall = 'unknown';
    else overall = 'ok';

    var chatRow = find('chat');
    var sub = '';
    if (overall === 'ok') sub = '所有主要功能都正常。';
    else if (overall === 'down' || overall === 'attention') {
      if (chatRow && chatRow.status === ST.OK) sub = '你仍然可以正常聊天。';
    } else if (overall === 'unknown') sub = '请点「重新检查」再试一次。';

    return { rows: rows, overall: overall, headline: OVERALL_TEXT[overall], sub: sub };
  }

  /* ── 计算 + 渲染 ── */
  function liveContext() {
    var roles = listRoles();
    return {
      roles: roles.map(function (c) { return { id: String(c.id), label: String(c.nickname || c.model || '') }; }),
      currentRole: roles.length ? currentRole(roles) : null,
      aiTest: S.aiTest,
      restartOk: !!(S.probes.restart && S.probes.restart.healthy),
      clientMissing: {
        bridge: !!(S.probes.bridge && S.probes.bridge.unavailable),
        active: !!(S.probes.active && S.probes.active.unavailable)
      }
    };
  }
  function computeAndRender() {
    var d = deriveCaps(S.boot, S.probes, liveContext());
    S.rows = d.rows;
    S.overall = d.overall;
    S.headline = d.headline;
    S.sub = d.sub;
    render();
  }

  /* ── 一键检查 ── */
  function runChecks() {
    if (S.inflight) return S.inflight;
    S.checking = true;
    Object.keys(PROBES).forEach(function (k) { S.probes[k] = { state: 'checking', healthy: false }; });
    render();
    /* 先读启动快照，再并行探测：视觉等组件的端口来自 boot-state（不在前端复制端口表） */
    S.inflight = readBootState().then(function () {
      var jobs = Object.keys(PROBES).map(function (k) {
        return Promise.resolve().then(function () { return PROBES[k](); })
          /* 单个 probe 自身抛异常 → 只把这一行标成「状态未知」，绝不让整页检查崩掉 */
          .catch(function () { return { ok: false, healthy: false, responding: false, httpStatus: 0, json: null, latencyMs: 0, error: 'probe-error', unavailable: true, endpoint: '' }; })
          .then(function (r) { if (!r) r = { ok: false, healthy: false, error: 'probe-error', unavailable: true }; r.state = 'done'; S.probes[k] = r; });
      });
      return Promise.all(jobs);
    }).then(function () {
      S.checking = false;
      S.inflight = null;
      S.lastCheckAt = Date.now();
      computeAndRender();
      return S.rows;
    });
    return S.inflight;
  }

  /* ── 一键修复：只调用既有 backend-restart（23116 控制面）── */
  function repairableRows() {
    return S.rows.filter(function (r) { return r.fixable === true; });
  }
  function canRepair() {
    if (S.checking || S.repairing) return false;
    if (typeof window.ibRestartBackend !== 'function' && !(NS.backendRestart && typeof NS.backendRestart.trigger === 'function')) return false;
    return repairableRows().length > 0;
  }
  /*
   * 等待一次真实重启跑完。beforeState 是发起前观察到的状态：只有出现
   * 「restarting」或状态确实从发起前变化，才算这次重启的结果——绝不复用
   * 上一次遗留的 ready/failed。单次等待有硬上限，不无限重试。
   */
  function waitForRestart(beforeState) {
    var client = NS.backendRestart;
    if (!client || typeof client.state !== 'function') return Promise.resolve(false);
    var deadline = Date.now() + RESTART_WAIT_MS;
    var before = String(beforeState == null ? '' : beforeState);
    var sawRunning = false;
    return new Promise(function (resolve) {
      var tick = function () {
        var st = '';
        try { st = String(client.state() || ''); } catch (e) { st = ''; }
        if (st === 'restarting') sawRunning = true;
        if (st === 'ready' && (sawRunning || before !== 'ready')) { resolve(true); return; }
        if (st === 'failed' && (sawRunning || before !== 'failed')) { resolve(false); return; }
        if (Date.now() > deadline) { resolve(false); return; }
        setTimeout(tick, RESTART_POLL_MS);
      };
      tick();
    });
  }
  function runRepair() {
    if (S.repairing) return Promise.resolve(false);
    if (!repairableRows().length) return Promise.resolve(false);
    S.repairing = true;
    S.repairMsg = { state: 'running', text: '正在尝试恢复，请稍等…' };
    render();
    var entry = { at: Date.now(), action: 'restart-local-services', result: 'failed', detail: '' };
    var trigger = (typeof window.ibRestartBackend === 'function')
      ? window.ibRestartBackend
      : (NS.backendRestart && NS.backendRestart.trigger);
    var beforeState = '';
    try { beforeState = (NS.backendRestart && typeof NS.backendRestart.state === 'function') ? NS.backendRestart.state() : ''; } catch (e) { beforeState = ''; }
    return Promise.resolve().then(function () {
      if (typeof trigger !== 'function') throw new Error('restart-client-missing');
      trigger();
      return waitForRestart(beforeState);
    }).then(function (ok) {
      entry.result = ok ? 'ok' : 'failed';
      entry.detail = ok ? '' : 'restart-did-not-complete';
      S.repairMsg = ok
        ? { state: 'ok', text: '本地功能已经恢复。' }
        : { state: 'fail', text: '自动修复没有成功。你仍然可以继续使用可用功能。' };
      return ok;
    }).catch(function () {
      entry.detail = 'restart-client-error';
      S.repairMsg = { state: 'fail', text: '自动修复没有成功。你仍然可以继续使用可用功能。' };
      return false;
    }).then(function (ok) {
      S.repairLog.unshift(entry);
      if (S.repairLog.length > 10) S.repairLog.length = 10;
      S.repairing = false;
      /* 服务重启后重新 probe，再更新页面 */
      S.inflight = null;
      return runChecks().then(function () { return ok; });
    });
  }

  /* ── AI 连接测试（复用 P4/P3 已验收的同一条链）── */
  function aiTarget() {
    var roles = listRoles();
    if (!roles.length) return null;
    var want = S.aiTargetId;
    var cfg = null, i;
    for (i = 0; i < roles.length; i++) if (String(roles[i].id) === String(want)) { cfg = roles[i]; break; }
    if (!cfg) {
      var cur = currentRole(roles);
      for (i = 0; i < roles.length; i++) if (String(roles[i].id) === String(cur && cur.id)) { cfg = roles[i]; break; }
      if (!cfg) cfg = roles[0];
    }
    return { cfg: cfg, id: String(cfg.id), label: String(cfg.nickname || cfg.model || '未命名角色') };
  }
  function runAiTest() {
    if (S.aiBusy) return Promise.resolve(false);
    var target = aiTarget();
    if (!target) {
      S.aiTest = { state: 'fail', at: Date.now(), title: '还没有配置 AI 角色', message: '先添加一个角色再测试。', suggestion: '在「API 设置」里添加角色。', retryable: false, roleId: '' };
      render();
      return Promise.resolve(false);
    }
    if (typeof window.callApiChat !== 'function') {
      S.aiTest = { state: 'fail', at: Date.now(), title: '暂时无法测试连接', message: '页面还没有准备好，请刷新后再试。', suggestion: '', retryable: true, roleId: target.id };
      render();
      return Promise.resolve(false);
    }
    var cfg = target.cfg;
    /* 临时配置：与聊天同一条链，不落盘、不改用户配置 */
    var testCfg = {
      id: cfg.id,
      provider: String(cfg.provider || ''),
      apiKey: String(cfg.apiKey || ''),
      model: String(cfg.model || ''),
      endpoint: String(cfg.endpoint || ''),
      nickname: String(cfg.nickname || ''),
      relationship: String(cfg.relationship || ''),
      temperature: (typeof cfg.temperature === 'number') ? cfg.temperature : 1,
      streaming: false,
      showThinking: false,
      promptCache: false,
      vision: false
    };
    S.aiBusy = true;
    S.aiTest = { state: 'running', at: Date.now(), roleId: target.id, label: target.label };
    render();
    var t0 = Date.now();
    return window.callApiChat(testCfg, [{ role: 'user', content: '你好' }], {
      _ibConsumer: 'diagnostics',/* 诊断身份：testCfg.promptCache=false → 审计不运行，此键为身份完整性预留 */
      maxTokens: 16,
      timeoutMs: AI_TEST_TIMEOUT_MS,
      disableTools: true,
      _noWebSearch: true,
      wantMeta: false
    }).then(function () {
      S.aiTest = { state: 'ok', at: Date.now(), roleId: target.id, label: target.label, latencyMs: Date.now() - t0 };
      return true;
    }).catch(function (e) {
      var model = null;
      try {
        model = (window.IBERR && window.IBERR.present)
          ? window.IBERR.present(e, {
            stage: 'diagnostics_ai_test',
            cfg: { id: cfg.id, provider: cfg.provider, model: cfg.model, endpoint: cfg.endpoint },
            endpoint: cfg.endpoint, provider: cfg.provider, model: cfg.model
          })
          : null;
      } catch (e2) { model = null; }
      S.aiTest = {
        state: 'fail', at: Date.now(), roleId: target.id, label: target.label,
        latencyMs: Date.now() - t0,
        code: model ? model.code : 'IBERR.UNKNOWN.UNKNOWN',
        title: model ? model.title : '连接失败',
        message: model ? model.message : '没能连接到这个 AI 服务。',
        suggestion: model ? model.suggestion : '请检查配置后再试。',
        /* 与 IBERR.detailsText() 同一字段名，方便「查看详情」直接复用 */
        technicalDetails: model ? model.technicalDetails : {},
        retryable: !!(model && model.retryable)
      };
      /* 原始诊断只进开发者控制台，且经过 P3 脱敏（不含密钥 / 请求体） */
      try { console.warn('[IBDiagnostics] AI 连接测试失败：' + redact(String(e && e.message || e), 300)); } catch (e3) { }
      return false;
    }).then(function (ok) {
      S.aiBusy = false;
      computeAndRender();
      return ok;
    });
  }

  /* ── 技术详情（白名单字段 + P3 脱敏）── */
  function lines(label, value) {
    if (value === undefined || value === null || value === '') return '';
    return label + '：' + safeVal(value);
  }
  function componentLines(name) {
    var c = bootComponent(name);
    var out = [];
    if (!c) { out.push('  ' + name + '：（启动快照中没有记录）'); return out; }
    var bits = [];
    if (c.state) bits.push('state=' + c.state);
    if (c.healthy !== undefined) bits.push('healthy=' + c.healthy);
    if (c.probed !== undefined) bits.push('probed=' + c.probed);
    if (c.port) bits.push('port=' + c.port);
    if (c.identity) bits.push('identity=' + c.identity);
    if (c.version) bits.push('version=' + c.version);
    if (c.reused !== undefined) bits.push('reused=' + c.reused);
    if (c.controlState) bits.push('controlState=' + c.controlState);
    if (c.reason && c.reason.category) bits.push('reason.category=' + c.reason.category);
    out.push('  ' + name + '：' + (bits.length ? bits.join(' · ') : '无可用字段'));
    return out;
  }
  function probeLines() {
    var out = [];
    var order = ['static', 'bridge', 'active', 'restart', 'bridgeStatus', 'vision', 'visionInstall'];
    var names = {
      static: '基础页面服务', bridge: '本地增强服务', active: '后台主动服务',
      restart: '重启控制面', bridgeStatus: '本地增强服务状态', vision: '视觉服务', visionInstall: '视觉安装标记'
    };
    order.forEach(function (k) {
      var p = S.probes[k];
      if (!p) return;
      var bits = [];
      bits.push(safeUrl(p.endpoint || ''));
      if (p.state === 'checking') { bits.push('检查中'); out.push('  ' + names[k] + '：' + bits.join(' → ')); return; }
      if (p.httpStatus) bits.push('HTTP ' + p.httpStatus);
      if (p.error) bits.push('error=' + p.error);
      if (p.latencyMs) bits.push(p.latencyMs + 'ms');
      bits.push(p.healthy ? 'healthy=true' : 'healthy=false');
      if (p.identity) bits.push('identity=' + p.identity);
      out.push('  ' + names[k] + '：' + bits.join(' · '));
    });
    return out;
  }
  function bootLines() {
    var out = [];
    var b = S.boot;
    if (!b || !b.present) {
      out.push('  启动记录：不可用（' + safeVal((b && b.error) || 'missing') + '）');
      return out;
    }
    out.push(lines('  bootId', b.state && b.state.bootId));
    out.push(lines('  启动阶段', b.state && b.state.phase));
    out.push(lines('  启动结果', b.state && b.state.overall));
    out.push(lines('  记录时间', b.state && b.state.generatedAt));
    out.push(lines('  记录年龄', ageText(b.ageMs)));
    out.push('  是否过期：' + (b.stale ? ('是（' + safeVal(b.staleReason || '') + '）') : '否'));
    var ln = b.state && b.state.launcher && b.state.launcher.node;
    if (ln) {
      out.push(lines('  捆绑 Node 版本', ln.version));
      out.push(lines('  Node 来源', ln.source));
      out.push(lines('  Node 路径', ln.path));
      out.push('  Node 是否满足要求：' + (ln.ok === false ? '否' : '是') + '（要求主版本 >= ' + safeVal(ln.requiredMajor) + '）');
    }
    var lc = b.state && b.state.launcher;
    if (lc) {
      out.push(lines('  平台 / 架构', String(safeVal(lc.platform)) + ' / ' + safeVal(lc.arch)));
      out.push(lines('  应用目录', lc.root));
    }
    var mgr = lc && lc.serviceManager;
    if (mgr) out.push('  本地服务管理器：state=' + safeVal(mgr.state) + ' · wasRunning=' + (mgr.wasRunning === true) + ' · startedByLauncher=' + (mgr.startedByLauncher === true));
    var lp = lc && lc.product;
    if (lp && lp.version) out.push(lines('  产品版本', lp.version));
    return out;
  }
  function warningLines() {
    var b = S.boot;
    var w = (b && b.present && b.state && b.state.warnings) || [];
    if (!w.length) return [];
    var out = ['【启动警告（仅代码）】'];
    w.forEach(function (x) { out.push('  ' + safeVal(x && x.code)); });
    return out;
  }
  function healthLines() {
    var out = [];
    var st = S.probes.bridgeStatus;
    if (st && st.json) {
      var j = st.json;
      var bits = [];
      ['version', 'connections', 'whispers', 'health', 'letters', 'sessions', 'contextFriends', 'stickers', 'resident'].forEach(function (k) {
        if (j[k] !== undefined) bits.push(k + '=' + safeVal(j[k]));
      });
      ['tts', 'mimoTts', 'voiceAsr', 'bark', 'ntfy', 'proactive', 'hasGeo'].forEach(function (k) {
        if (j[k] !== undefined) bits.push(k + '=' + (j[k] === true));
      });
      if (bits.length) out.push('  /status：' + bits.join(' · '));
    }
    var dg = S.probes.bridgeDiagnostics;
    if (dg && dg.json) {
      var d = dg.json;
      var sv = d.service || {};
      var bits2 = [];
      ['name', 'version', 'uptimeSeconds', 'host', 'port', 'websocketConnections'].forEach(function (k) {
        if (sv[k] !== undefined) bits2.push(k + '=' + safeVal(sv[k]));
      });
      if (d.data && d.data.records) {
        Object.keys(d.data.records).forEach(function (k) { bits2.push('records.' + k + '=' + safeVal(d.data.records[k])); });
      }
      if (bits2.length) out.push('  /api/diagnostics：' + bits2.join(' · '));
    }
    return out;
  }
  function errorLines() {
    if (!S.errorLog.length) return [];
    var out = ['【最近错误码（P3 统一分类）】'];
    S.errorLog.slice(0, 10).forEach(function (e) {
      out.push('  ' + safeVal(e.code) + ' @ ' + isoText(e.at));
    });
    return out;
  }
  function repairLines() {
    if (!S.repairLog.length) return [];
    var out = ['【修复尝试】'];
    S.repairLog.slice(0, 5).forEach(function (r) {
      out.push('  ' + isoText(r.at) + ' · ' + safeVal(r.action) + ' → ' + safeVal(r.result) + (r.detail ? '（' + safeVal(r.detail) + '）' : ''));
    });
    return out;
  }

  /* 健康 / 诊断摘要是「按需」探测：只有展开技术详情或导出报告时才拉一次，
     不参与每次「重新检查」，避免请求风暴。 */
  function withDiagnostics(fn) {
    var p = S.probes.bridgeDiagnostics;
    if (p && p.state === 'done') { fn(); return Promise.resolve(true); }
    if (p && p.state === 'checking') return Promise.resolve(false);
    S.probes.bridgeDiagnostics = { state: 'checking', healthy: false };
    return Promise.resolve().then(function () { return probeBridgeDiagnostics(); })
      .catch(function () { return { ok: false, healthy: false, error: 'probe-error', unavailable: true, endpoint: '', json: null }; })
      .then(function (r) { r.state = 'done'; S.probes.bridgeDiagnostics = r; fn(); return true; });
  }

  function technicalText() {
    var L = [];
    L.push('【启动快照（只解释本次启动，不代表当前状态）】');
    L = L.concat(bootLines());
    L.push('');
    L.push('【组件（启动快照）】');
    ['static', 'bridge', 'active', 'restart', 'vision'].forEach(function (n) { L = L.concat(componentLines(n)); });
    L.push('');
    L.push('【当前探测】');
    L = L.concat(probeLines());
    var w = warningLines();
    if (w.length) { L.push(''); L = L.concat(w); }
    var h = healthLines();
    if (h.length) { L.push(''); L.push('【健康 / 诊断摘要】'); L = L.concat(h); }
    var e = errorLines();
    if (e.length) { L.push(''); L = L.concat(e); }
    var r = repairLines();
    if (r.length) { L.push(''); L = L.concat(r); }
    L = L.concat(aiTestLines());
    L.push('');
    L.push('【说明】技术详情已脱敏：不含 API Key / Authorization / Cookie / 提示词 / 聊天正文。');
    return redact(L.join('\n'), 20000);
  }

  /* AI 连接测试的技术详情（复用 P3 的 detailsText，不另建一套字段） */
  function aiTestLines() {
    var at = S.aiTest;
    if (!at) return [];
    var L = ['', '【AI 连接测试】'];
    L.push('  结果：' + (at.state === 'ok' ? '成功' : (at.state === 'running' ? '进行中' : '失败')));
    L.push(lines('  时间', isoText(at.at)));
    L.push(lines('  耗时', at.latencyMs ? at.latencyMs + 'ms' : ''));
    var det = '';
    try {
      det = (window.IBERR && typeof window.IBERR.detailsText === 'function') ? window.IBERR.detailsText(at) : '';
    } catch (e) { det = ''; }
    if (det) {
      det.split('\n').forEach(function (line) { L.push('  ' + line); });
    }
    return L;
  }

  /* ── 导出诊断报告（白名单构造 + 二次脱敏）── */
  function capabilitySummary() {
    return S.rows.map(function (r) {
      return '  ' + r.label + '：' + (ST_TEXT[r.status] || r.status) + (r.detail ? '（' + r.detail + '）' : '');
    });
  }
  function reportText() {
    var L = [];
    L.push('InternalBeyond 诊断报告');
    L.push('生成时间：' + isoText(Date.now()));
    L.push('');
    L.push('【基本信息】');
    L.push(lines('  IB 页面地址', (function () { try { return location.origin; } catch (e) { return ''; } })()));
    L.push(lines('  浏览器', (typeof navigator !== 'undefined' ? navigator.userAgent : '')));
    L.push(lines('  平台', (typeof navigator !== 'undefined' ? navigator.platform : '')));
    L.push(lines('  语言', (typeof navigator !== 'undefined' ? navigator.language : '')));
    L.push(lines('  屏幕', (typeof screen !== 'undefined' ? (screen.width + ' x ' + screen.height) : '')));
    L.push('');
    L.push('【启动快照（本次启动）】');
    L = L.concat(bootLines());
    L.push('');
    L.push('【当前功能状态】');
    L.push(lines('  总体', S.headline));
    L = L.concat(capabilitySummary());
    L.push('');
    L.push('【组件（启动快照）】');
    ['static', 'bridge', 'active', 'restart', 'vision'].forEach(function (n) { L = L.concat(componentLines(n)); });
    L.push('');
    L.push('【当前探测】');
    L = L.concat(probeLines());
    var w = warningLines();
    if (w.length) { L.push(''); L = L.concat(w); }
    var h = healthLines();
    if (h.length) { L.push(''); L.push('【健康 / 诊断摘要】'); L = L.concat(h); }
    var e = errorLines();
    if (e.length) { L.push(''); L = L.concat(e); }
    var r = repairLines();
    if (r.length) { L.push(''); L = L.concat(r); }
    L = L.concat(aiTestLines());
    L.push('');
    L.push('【说明】');
    L.push('  · 本报告不含 API Key / Authorization / Cookie / 提示词 / 聊天正文。');
    L.push('  · 未导出本地日志文件：无法确认其中是否含敏感内容，因此不导出。');
    L.push('  · 启动快照只说明本次启动时的情况；当前状态以「当前探测」为准。');
    return redact(L.join('\n'), 60000);
  }
  function exportReport() {
    var text = reportText();
    try {
      var blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = 'InternalBeyond-诊断报告-' + isoText(Date.now()).replace(/[:.]/g, '-') + '.txt';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () { try { URL.revokeObjectURL(url); } catch (e) { } }, 4000);
      return true;
    } catch (e) {
      toastUser('导出失败，请稍后再试。');
      return false;
    }
  }

  /* ── 扩展卡位（本页只负责页面骨架）──
     诊断页是这一页的宿主。其它模块（目前只有 U4 更新卡片）把自己的卡片挂进来，
     避免各自 appendChild 到 #page-diagnostics —— 本页每次 render() 都会清空宿主，
     外部塞进去的节点会被无声抹掉。注册即渲染，不建立第二套页面/状态。
     卡片不参与能力矩阵与总览，绝不影响上面的诊断结论。 */
  var CARDS = [];
  function registerCard(fn) {
    if (typeof fn !== 'function') return false;
    if (CARDS.indexOf(fn) >= 0) return false;
    CARDS.push(fn);
    render();
    return true;
  }

  /* ── 页面渲染 ── */
  function statusClass(st) { return 'is-' + String(st || ST.UNKNOWN); }

  /* ── 产品版本（单一版本源 VERSION）──
     优先启动快照（launcher.product.version，由 runtime/launch-internal-beyond.js 读 VERSION 写入），
     其次本地页面服务 /health 的 version 字段。取不到就不显示——绝不编造版本号。 */
  function productVersion() {
    try {
      var st = S.boot && S.boot.state;
      var v = st && st.launcher && st.launcher.product && st.launcher.product.version;
      if (v) return String(v);
    } catch (e) { /* ignore */ }
    try {
      var p = S.probes && S.probes.static;
      if (p && p.json && p.json.version) return String(p.json.version);
    } catch (e) { /* ignore */ }
    return '';
  }

  /*
   * 可等待的版本读取：供更新卡片在「新实例刚起来」的那一刻判定「装的是不是目标版本」。
   * 走的是同一条链（启动快照 → 本地页面服务 /health），不是第二份实现；
   * 只读，不改 S.probes，因此不会影响本页的能力矩阵。
   */
  function readProductVersion() {
    return readBootState().then(function () {
      var v = productVersion();
      if (v) return v;
      var origin = '';
      try { origin = String(location.origin || ''); } catch (e) { }
      if (!origin || origin === 'null') return '';
      return timedFetch(origin + '/health', { method: 'GET' }, PROBE_TIMEOUT_MS).then(function (r) {
        return (r && r.ok && r.json && r.json.version) ? String(r.json.version) : '';
      });
    }).catch(function () { return productVersion(); });
  }

  function renderHead(host) {
    var head = el('div', 'ib-diag-head');
    var line = el('div', 'ib-diag-headline ' + statusClass(S.overall), S.headline);
    line.id = 'ib-diag-headline';
    head.appendChild(line);
    if (S.sub) {
      var sub = el('div', 'ib-diag-sub', S.sub);
      sub.id = 'ib-diag-sub';
      head.appendChild(sub);
    }
    var meta = el('div', 'ib-diag-meta');
    meta.id = 'ib-diag-updated';
    var stamp = S.lastCheckAt ? ('最近检查：' + clockText(S.lastCheckAt)) : (S.checking ? '正在检查…' : '还没有检查');
    var pv = productVersion();
    meta.textContent = stamp + (pv ? (' · 版本 ' + pv) : '');
    head.appendChild(meta);
    host.appendChild(head);
  }

  function renderRows(host) {
    var list = el('ul', 'ib-diag-list');
    list.id = 'ib-diag-list';
    S.rows.forEach(function (r) {
      var li = el('li', 'ib-diag-row');
      li.dataset.cap = r.id;
      li.dataset.status = r.status;
      var top = el('div', 'ib-diag-row-top');
      top.appendChild(el('span', 'ib-diag-label', r.label));
      var pill = el('span', 'ib-diag-status ' + statusClass(r.status), ST_TEXT[r.status] || r.status);
      top.appendChild(pill);
      li.appendChild(top);
      if (r.detail) li.appendChild(el('p', 'ib-diag-detail', r.detail));
      if (r.note) li.appendChild(el('p', 'ib-diag-note', r.note));
      if (r.hint) li.appendChild(el('p', 'ib-diag-hint', r.hint));
      list.appendChild(li);
    });
    host.appendChild(list);
  }

  function renderRepair(host) {
    var box = el('div', 'ib-diag-repair');
    box.id = 'ib-diag-repair';
    var show = canRepair() || S.repairing || (S.repairMsg && S.repairMsg.state !== 'running');
    if (!show) return;
    if (S.repairMsg) {
      box.appendChild(el('p', 'ib-diag-repair-msg ' + (S.repairMsg.state === 'ok' ? 'is-ok' : (S.repairMsg.state === 'fail' ? 'is-fail' : '')), S.repairMsg.text));
    } else if (canRepair()) {
      box.appendChild(el('p', 'ib-diag-repair-msg', '检测到本地功能异常，可以尝试自动恢复。'));
    }
    if (canRepair()) {
      var btn = el('button', 'btn btn-primary', S.repairing ? '正在恢复…' : '尝试修复');
      btn.type = 'button';
      btn.id = 'ib-diag-repair-btn';
      btn.disabled = S.repairing;
      btn.onclick = function () { runRepair(); };
      box.appendChild(btn);
    }
    host.appendChild(box);
  }

  function renderAiTest(host) {
    var box = el('div', 'ib-diag-ai');
    box.id = 'ib-diag-ai';
    var roles = listRoles();
    var row = el('div', 'ib-diag-ai-row');
    if (roles.length > 1) {
      var lab = el('label', 'ib-diag-ai-label', '测试哪个角色');
      lab.setAttribute('for', 'ib-diag-ai-role');
      row.appendChild(lab);
      var sel = el('select', 'ib-diag-ai-select');
      sel.id = 'ib-diag-ai-role';
      var target = aiTarget();
      roles.forEach(function (c) {
        var opt = document.createElement('option');
        opt.value = String(c.id);
        opt.textContent = String(c.nickname || c.model || '未命名角色');
        if (target && String(target.id) === String(c.id)) opt.selected = true;
        sel.appendChild(opt);
      });
      sel.onchange = function () { S.aiTargetId = sel.value; render(); };
      row.appendChild(sel);
    }
    var btn = el('button', 'btn', S.aiBusy ? '正在测试…' : '测试 AI 连接');
    btn.type = 'button';
    btn.id = 'ib-diag-ai-btn';
    btn.disabled = S.aiBusy || !roles.length;
    btn.onclick = function () { runAiTest(); };
    row.appendChild(btn);
    box.appendChild(row);
    box.appendChild(el('p', 'ib-diag-ai-note', '测试会实际向 AI 服务发送一个很小的请求（可能产生少量费用）。'));
    var at = S.aiTest;
    if (at && at.state === 'running') {
      box.appendChild(el('p', 'ib-diag-ai-result', '正在测试…'));
    } else if (at && at.state === 'ok') {
      box.appendChild(el('p', 'ib-diag-ai-result is-ok', '连接正常' + (at.latencyMs ? '（' + Math.round(at.latencyMs / 100) / 10 + ' 秒）' : '') + '。'));
    } else if (at && at.state === 'fail') {
      var res = el('div', 'ib-diag-ai-result is-fail');
      res.appendChild(el('p', 'ib-diag-ai-title', String(at.title || '连接失败')));
      if (at.message) res.appendChild(el('p', 'ib-diag-ai-message', String(at.message)));
      if (at.suggestion) res.appendChild(el('p', 'ib-diag-ai-suggestion', String(at.suggestion)));
      res.appendChild(el('p', 'ib-diag-ai-message', '需要详细信息的话，展开下面的「查看技术详情」。'));
      box.appendChild(res);
    }
    host.appendChild(box);
  }

  function renderActions(host) {
    var bar = el('div', 'ib-diag-actions');
    var re = el('button', 'btn btn-primary', S.checking ? '正在检查…' : '重新检查');
    re.type = 'button';
    re.id = 'ib-diag-recheck';
    re.disabled = S.checking;
    re.onclick = function () { runChecks(); };
    bar.appendChild(re);

    var det = el('button', 'btn', S.detailsOpen ? '收起技术详情' : '查看技术详情');
    det.type = 'button';
    det.id = 'ib-diag-details';
    det.disabled = S.checking;
    det.onclick = function () {
      if (S.detailsOpen) { S.detailsOpen = false; render(); return; }
      /* 健康 / 诊断摘要在展开或导出时才拉取一次，避免每次检查都多打一个请求 */
      withDiagnostics(function () { S.detailsOpen = true; render(); });
    };
    bar.appendChild(det);

    var ex = el('button', 'btn', '导出诊断报告');
    ex.type = 'button';
    ex.id = 'ib-diag-export';
    ex.onclick = function () {
      withDiagnostics(function () {
        var ok = exportReport();
        toastUser(ok ? '诊断报告已导出，可以直接发给维护者。' : '导出失败，请稍后再试。');
        render();
      });
    };
    bar.appendChild(ex);
    host.appendChild(bar);

    if (S.detailsOpen) {
      var pre = el('pre', 'ib-diag-tech', technicalText());
      pre.id = 'ib-diag-tech';
      host.appendChild(pre);
    }
  }

  function render() {
    var host = S.host;
    if (!host || typeof document === 'undefined') return;
    clear(host);
    var intro = el('div', 'module-intro');
    var top = el('div', 'module-intro-top');
    top.appendChild(el('h2', '', '系统诊断'));
    top.appendChild(el('span', 'module-intro-sub', 'System check'));
    intro.appendChild(top);
    intro.appendChild(el('div', 'module-intro-rule'));
    intro.appendChild(el('div', 'module-intro-desc', '看看有哪些功能正常、哪些需要注意，以及可以怎么处理。\n不需要懂技术，也不用打开开发者工具。'));
    host.appendChild(intro);

    var card = el('div', 'glass-card ib-diag');
    card.id = 'ib-diag';
    renderHead(card);
    renderRows(card);
    renderRepair(card);
    renderAiTest(card);
    renderActions(card);
    host.appendChild(card);

    CARDS.forEach(function (fn) {
      /* 扩展卡片自己负责自己的失败：一张外部卡片渲染崩了，不能让整页白掉 */
      try { fn(host); } catch (e) { }
    });
  }

  /* ── 入口 ── */
  function mount() {
    if (typeof document === 'undefined' || !document.body) return;
    injectStyles();
    var host = byId('page-' + PAGE);
    if (!host) {
      var app = byId('app');
      if (!app) return;
      host = el('div', 'page');
      host.id = 'page-' + PAGE;
      app.appendChild(host);
    }
    S.host = host;
    render();
    mountSettingsEntry();
  }
  function mountSettingsEntry() {
    var pageApi = byId('page-api');
    if (!pageApi || byId('ib-diag-entry')) return;
    var card = el('div', 'glass-card ib-diag-entry');
    card.id = 'ib-diag-entry';
    card.appendChild(el('h3', '', '系统诊断'));
    card.appendChild(el('p', 'ib-diag-entry-desc', '如果某个功能不好用，可以在这里看看是哪一项出了问题，也可以导出诊断报告发给维护者。'));
    var btn = el('button', 'btn', '打开系统诊断');
    btn.type = 'button';
    btn.id = 'ib-diag-open';
    btn.onclick = function () { go(); };
    card.appendChild(btn);
    var first = pageApi.querySelector('.api-section');
    if (first) pageApi.insertBefore(card, first); else pageApi.appendChild(card);
  }
  function go() {
    try {
      if (typeof window.navTo === 'function') { window.navTo(PAGE); return; }
      /* 极端情况（core.js 尚未就绪）：用 hash 走既有的 hashchange 路由 */
      if (typeof location !== 'undefined') { location.hash = PAGE; return; }
    } catch (e) { }
    open();
  }
  function open() {
    if (!S.host) mount();
    if (!S.lastCheckAt && !S.inflight) { runChecks(); return; }
    render();
  }
  /*
   * 入口接线（不重排全局导航）：
   *   1) 直接监听导航链接 —— core.js 的点击处理器调用的是它内部的 navTo 绑定，
   *      只包装 window.navTo 抓不到导航点击。
   *   2) hashchange —— 覆盖浏览器前进/后退与 location.hash 跳转。
   *   3) 包装 window.navTo —— 覆盖 IBERR 错误卡片的 open_page 动作与本模块 go()。
   */
  function hookNav() {
    var link = document.querySelector('.nav-links a[data-page="' + PAGE + '"]');
    if (link && !link.__ibDiagBound) {
      link.__ibDiagBound = true;
      link.addEventListener('click', function () { open(); });
    }
    if (!window.__ibDiagHashHooked && typeof window.addEventListener === 'function') {
      window.__ibDiagHashHooked = true;
      window.addEventListener('hashchange', function () {
        try { if (String(location.hash || '') === '#' + PAGE) open(); } catch (e) { }
      });
    }
    var orig = window.navTo;
    if (typeof orig !== 'function' || orig.__ibDiagHooked) return;
    var wrapped = function (page) {
      var r = orig.apply(this, arguments);
      try {
        if (String(page) === PAGE) open();
        var a = document.querySelector('.nav-links a[data-page="' + PAGE + '"]');
        if (a && typeof a.scrollIntoView === 'function') a.scrollIntoView({ inline: 'nearest', block: 'nearest' });
      } catch (e) { }
      return r;
    };
    wrapped.__ibDiagHooked = true;
    wrapped.__ibDiagOrig = orig;
    window.navTo = wrapped;
  }

  function boot() {
    if (S.booted) return;
    S.booted = true;
    if (typeof document === 'undefined') return;
    hookErrors();
    var start = function () {
      mount();
      hookNav();
      try {
        if (String(location.hash || '') === '#' + PAGE) setTimeout(open, 60);
      } catch (e) { }
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
    else start();
  }

  var api = {
    open: open,
    go: go,
    refresh: function () { return runChecks(); },
    repair: function () { return runRepair(); },
    testAi: function () { return runAiTest(); },
    exportReport: exportReport,
    reportText: reportText,
    technicalText: technicalText,
    /* 扩展卡位：注册一个 fn(host) 渲染器，见 registerCard */
    registerCard: registerCard,
    /* 产品版本的唯一实现（VERSION 单一源 → boot-state → /health）。更新卡片
       判定「装的是不是目标版本」时读这里，不自己再解析一遍版本。 */
    productVersion: productVersion,
    readProductVersion: readProductVersion,
    status: function () {
      return {
        overall: S.overall, headline: S.headline, rows: S.rows.slice(0),
        checking: S.checking, repairing: S.repairing, aiBusy: S.aiBusy,
        lastCheckAt: S.lastCheckAt, boot: S.boot, repairLog: S.repairLog.slice(0)
      };
    },
    __test: {
      ST: ST, ST_TEXT: ST_TEXT, CAPS: CAPS, PROBES: PROBES,
      deriveCaps: deriveCaps,
      runChecks: runChecks,
      reportText: reportText,
      technicalText: technicalText,
      describeRole: describeRole,
      productVersion: productVersion,
      cards: CARDS,
      state: function () { return S; },
      setBoot: function (b) { S.boot = b; },
      setProbes: function (p) { S.probes = p || {}; },
      setAiTest: function (t) { S.aiTest = t; },
      setRows: function (r) { S.rows = r || []; },
      compute: function () { computeAndRender(); },
      render: render,
      withDiagnostics: withDiagnostics,
      recordError: recordError,
      clockText: clockText,
      ageText: ageText
    }
  };
  window.IBDiagnostics = api;
  NS.diagnostics = api;

  boot();
})(window.IB || (window.IB = {}));
