/* ============================================================================
   IBUpdateCard · U4 · Diagnostics 更新体验（Zero-Touch Update 的用户面）

   这一层只做一件事：把后端已经确定的事实画出来，并把用户的三个动作
   （检查更新 / 稍后 / 下载并安装）翻译成对既有端点的调用。

   铁律（本文件不得违反）：
     · 不重新实现任何判定。清单校验、版本比较、传输与回退、内容摘要、
       安装包身份校验、安装器启动、安装状态机——全部属于 U1/U2/U3 的 Node 真源。
       这里只读 GET /__update-check 和 GET /__update/status，只写
       POST /__update/start，而且只提交 { version }。
     · 不在前端做第二套缓存：自动检查走后端 24h 缓存（不 force），
       只有用户手动点「检查更新」才 force——cache 与 force 语义只属于 U2。
     · 不显示假进度：进度只来自安装状态文件里的真实字节数；读不到就不显示百分比。
     · 进入安装阶段后，服务断开/轮询失败**不等于**失败——那是安装器在正常停止 IB。
     · 远端 notes 一律 textContent 渲染，永不 innerHTML。
     · 用户文案不出现底层术语（P6 文案契约）；原始 kind/message 只留在
       status() 里给诊断与日志用，不进 DOM。
     · 安装器被启动 ≠ 成功：只有这个版本真的变成「当前版本」才算成功，
       而且成功提示只消费一次（见 CONSUME 一节）。
   ============================================================================ */
(function (NS) {
  'use strict';

  var CHECK_URL = '/__update-check';
  var STATUS_URL = '/__update/status';
  var START_URL = '/__update/start';
  var CARD_ID = 'ib-update-card';
  var STYLE_ID = 'ib-update-style';
  var STYLE_HREF = 'assets/css/update-card.css';
  /* 通道名只是 UI 文案：真正的通道常量在 runtime/update-manifest.js。 */
  var CHANNEL_LABEL = 'Stable';

  var STATUS_TIMEOUT_MS = 2500;
  var START_TIMEOUT_MS = 8000;
  /* 检查的上限必须比服务端自己能花的时间更长：一次检查最多三段网络往返
     （primary + API 版本 + API 资产），每段 8 秒。UI 先放弃就会把「还在查」
     显示成「查不了」——那正是 U2 那边刻意避免的假失败。 */
  var CHECK_TIMEOUT_MS = 30000;
  var POLL_MS = 900;
  var POLL_MAX_MS = 4000;
  /* helper 从被 spawn 到写下第一行状态之间的窗口。超过这个时间还是「什么都没有」，
     就不是「还没开始」，而是没开始。 */
  var START_GRACE_MS = 60 * 1000;
  /* 与 runtime/update-install.js 的 ACTIVE_GRACE_MS 保持一致：超过 30 分钟没动的
     状态文件不算「还在跑」。 */
  var INSTALL_STALE_MS = 30 * 60 * 1000;

  var MARKER_KEY = 'ibUpdatePendingV1';
  var AUTO_KEY = 'ibUpdateAutoCheckV1';
  var MARKER_SCHEMA = 'internalbeyond.update-pending';

  /* ── 卡片阶段（页面唯一来源；data-state 就是这些值） ── */
  var PHASE = {
    IDLE: 'idle',
    CHECKING: 'checking',
    UP_TO_DATE: 'up-to-date',
    AVAILABLE: 'available',
    DOWNLOADING: 'downloading',
    VERIFYING: 'verifying',
    INSTALLING: 'installing',
    FAILED: 'failed',
    UPDATED: 'updated',
    INCOMPLETE: 'incomplete'
  };
  var PROGRESS_PHASES = [PHASE.DOWNLOADING, PHASE.VERIFYING];
  var BUSY_PHASES = [PHASE.CHECKING, PHASE.DOWNLOADING, PHASE.VERIFYING, PHASE.INSTALLING];

  /* ── 用户文案（唯一来源；测试逐条扫描，禁止底层术语） ── */
  var USER_TEXT = {
    install: {
      network: '网络连接不可用，暂时无法完成更新。请检查网络后重试。',
      corrupt: '更新文件没有通过安全校验，已取消这次更新。请稍后重试。',
      busy: '已有一个更新正在进行，请稍候。',
      stale: '更新信息已经变化，请重新检查更新。',
      server: '暂时无法完成更新，请稍后再试。',
      unknown: '更新没有完成，请稍后再试。'
    },
    check: {
      network: '网络连接不可用，暂时无法检查更新。',
      corrupt: '暂时无法检查更新，请稍后再试。',
      busy: '正在检查更新，请稍候。',
      stale: '暂时无法检查更新，请稍后再试。',
      server: '暂时无法检查更新，请稍后再试。',
      unknown: '暂时无法检查更新，请稍后再试。'
    }
  };
  var FIXED_TEXT = {
    checking: '正在检查更新…',
    preparing: '正在准备下载更新…',
    downloading: '正在下载更新…',
    verifying: '正在验证更新文件…',
    installing: '正在安装更新。InternalBeyond 会暂时关闭，并在完成后自动重新打开。',
    installHint: '如果没有自动重新打开，请稍后手动打开 InternalBeyond。',
    progressUnknown: '暂时读不到下载进度，正在重试…',
    upToDate: '已是最新版本',
    notes: '更新说明',
    size: '安装包约 ',
    autoOn: '开',
    autoOff: '关',
    neverChecked: '还没有检查过更新。',
    autoHint: '打开 InternalBeyond 时自动检查；每天最多联网一次，其余时间使用本地缓存。'
  };

  /* ── 失败分类：把内部 kind 收敛成稳定的用户可见类别 ──
     分类表覆盖 docs/ARCHITECTURE.md §13 里列出的全部 kind；表外一律 unknown。
     未列出的 kind 不会漏出去，只会得到最保守的一句「请稍后再试」。 */
  var CLASS = {
    NETWORK: 'network',
    CORRUPT: 'corrupt',
    BUSY: 'busy',
    STALE: 'stale',
    SERVER: 'server',
    UNKNOWN: 'unknown'
  };
  var KIND_CLASS = {
    /* 传输层：一次完整响应实体都没拿到 */
    'dns': CLASS.NETWORK,
    'connect-timeout': CLASS.NETWORK,
    'refused': CLASS.NETWORK,
    'reset': CLASS.NETWORK,
    'unreachable': CLASS.NETWORK,
    'tls': CLASS.NETWORK,
    'socket': CLASS.NETWORK,
    'network': CLASS.NETWORK,
    'host-not-allowed': CLASS.NETWORK,
    'redirect-host-not-allowed': CLASS.NETWORK,
    'bad-redirect': CLASS.NETWORK,
    'too-many-redirects': CLASS.NETWORK,
    'bad-url': CLASS.NETWORK,
    'sink-failed': CLASS.NETWORK,
    /* 载荷不可信：取消这次安装，不换路、不重试 */
    'invalid-manifest': CLASS.CORRUPT,
    'identity-mismatch': CLASS.CORRUPT,
    'content-length-invalid': CLASS.CORRUPT,
    'size-mismatch': CLASS.CORRUPT,
    'sha256-mismatch': CLASS.CORRUPT,
    'pe-version-mismatch': CLASS.CORRUPT,
    'api-release-unusable': CLASS.CORRUPT,
    'bad-encoding': CLASS.CORRUPT,
    'content-encoding': CLASS.CORRUPT,
    'body-too-large': CLASS.CORRUPT,
    /* 已经有一个安装在跑 */
    'already-in-progress': CLASS.BUSY,
    'install-in-progress': CLASS.BUSY,
    /* 手头的更新信息已经过期，重新检查即可 */
    'version-mismatch': CLASS.STALE,
    'no-verified-manifest': CLASS.STALE,
    'version-required': CLASS.STALE,
    /* 服务端/本机问题 */
    'update-module-unavailable': CLASS.SERVER,
    'start-failed': CLASS.SERVER,
    'spawn-failed': CLASS.SERVER,
    'write-failed': CLASS.SERVER,
    'payload-dir-inside-app': CLASS.SERVER,
    'internal-error': CLASS.SERVER,
    'http-status': CLASS.SERVER,
    'rate-limited': CLASS.SERVER,
    'method-not-allowed': CLASS.SERVER,
    'origin-denied': CLASS.SERVER,
    'bad-json': CLASS.SERVER,
    'bad-body': CLASS.SERVER,
    'browser-supplied-transport-fields': CLASS.SERVER,
    'bad-current-version': CLASS.SERVER,
    'uncomparable-version': CLASS.SERVER
  };

  function classify(kind, httpStatus) {
    var k = String(kind == null ? '' : kind).toLowerCase();
    if (KIND_CLASS[k]) return KIND_CLASS[k];
    /* 没有 kind 但有 HTTP 状态码：仍然是「服务端没有给出可用的更新信息」 */
    var s = Number(httpStatus);
    if (isFinite(s) && s > 0) return CLASS.SERVER;
    return CLASS.UNKNOWN;
  }
  function userText(where, kind, httpStatus) {
    var table = USER_TEXT[where] || USER_TEXT.install;
    return table[classify(kind, httpStatus)] || table.unknown;
  }

  /* ── 状态 ── */
  var S = {
    booted: false,
    host: null,
    card: null,
    nodes: null,
    phase: PHASE.IDLE,
    auto: true,
    current: '',
    latest: '',
    notes: '',
    sizeBytes: 0,
    bytes: 0,
    totalBytes: 0,
    fromCache: false,
    lastCheckAt: 0,
    updating: '',        /* UPDATED 阶段显示的版本 */
    incompleteAt: '',    /* INCOMPLETE 阶段：当前仍然是哪个版本 */
    deferred: '',        /* 「稍后」暂缓的版本（仅本次会话） */
    hint: '',
    busy: false,
    error: null,         /* { kind, httpStatus } —— 只给 status()/日志，不进 DOM */
    errorText: '',
    attempt: false,      /* 本次会话里用户点过「下载并安装」并已被接受 */
    attemptAt: 0,
    installing: false,   /* 一旦进入安装阶段就锁住：断开连接不再改判 */
    progressUnknown: false,
    registerRetried: false,
    marker: null,
    judged: false,
    verdict: '',         /* updated / incomplete / unknown（判定只做一次） */
    polling: false,
    pollTimer: null,
    pollFails: 0,
    checkInFlight: null
  };

  /* ── 小工具 ── */
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = String(text);
    return n;
  }
  function byId(id) { try { return document.getElementById(id); } catch (e) { return null; } }
  function num(v) { var n = Number(v); return isFinite(n) && n > 0 ? n : 0; }
  function str(v) { return v == null ? '' : String(v); }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function clockText(ms) {
    if (!ms) return '';
    var d = new Date(ms);
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
  }
  function parseTime(v) {
    var t = Date.parse(str(v));
    return isNaN(t) ? 0 : t;
  }
  /* 人类可读的大小：只在真有字节数时才调用（0 不出现在 UI 上）。 */
  function formatBytes(bytes) {
    var n = Number(bytes);
    if (!isFinite(n) || n < 0) return '';
    if (n < 1024) return Math.round(n) + ' B';
    if (n < 1024 * 1024) return Math.round(n / 1024) + ' KB';
    var mb = n / (1024 * 1024);
    if (mb < 1024) return mb.toFixed(mb >= 100 ? 0 : 1) + ' MB';
    return (mb / 1024).toFixed(2) + ' GB';
  }
  function percentOf(bytes, total) {
    var b = num(bytes), t = num(total);
    if (!t || !b) return 0;
    var p = Math.round((b / t) * 100);
    return p < 0 ? 0 : (p > 100 ? 100 : p);
  }

  /* ── 本地存储（只用两件事：自动检查开关 + 一次性成功标记） ──
     存储不可用（隐私模式等）时全部退化成「没有」：卡片照常工作，只是不记忆。 */
  function store() { try { return window.localStorage || null; } catch (e) { return null; } }
  function storeGet(k) { try { var s = store(); return s ? s.getItem(k) : null; } catch (e) { return null; } }
  function storeSet(k, v) { try { var s = store(); if (s) s.setItem(k, v); } catch (e) { } }
  function storeDel(k) { try { var s = store(); if (s) s.removeItem(k); } catch (e) { } }

  function autoPref() {
    var raw = storeGet(AUTO_KEY);
    /* 默认开：自动检查用的是后端 24h 缓存，不是每次开页面都联网。 */
    return raw === '0' ? false : true;
  }
  function readMarker() {
    var raw = storeGet(MARKER_KEY);
    if (!raw) return null;
    var parsed = null;
    try { parsed = JSON.parse(raw); } catch (e) { parsed = null; }
    if (!parsed || typeof parsed !== 'object' || parsed.schema !== MARKER_SCHEMA) {
      storeDel(MARKER_KEY);   /* 认不出来的标记一律丢掉，绝不拿它下结论 */
      return null;
    }
    var version = str(parsed.version).trim();
    if (!version) { storeDel(MARKER_KEY); return null; }
    var at = Number(parsed.at);
    return { schema: MARKER_SCHEMA, version: version, at: isFinite(at) && at > 0 ? at : 0 };
  }
  function writeMarker(version, at) {
    storeSet(MARKER_KEY, JSON.stringify({ schema: MARKER_SCHEMA, version: str(version), at: at || Date.now() }));
    S.marker = { schema: MARKER_SCHEMA, version: str(version), at: at || Date.now() };
  }
  function consumeMarker() { storeDel(MARKER_KEY); S.marker = null; }

  /* ── 样式（运行时注入；HTML 的样式表预算不动） ── */
  function injectStyles() {
    if (typeof document === 'undefined' || byId(STYLE_ID)) return;
    var link = document.createElement('link');
    link.id = STYLE_ID;
    link.rel = 'stylesheet';
    link.href = STYLE_HREF;
    if (document.head) document.head.appendChild(link);
  }

  /* ── 请求原语：单次、有硬超时、永不抛出 ── */
  function request(url, opts, timeoutMs) {
    var out = { ok: false, httpStatus: 0, json: null, error: null };
    if (typeof fetch !== 'function') { out.error = 'no-fetch'; return Promise.resolve(out); }
    var ctl = null;
    try { if (typeof AbortController === 'function') ctl = new AbortController(); } catch (e) { ctl = null; }
    var timer = setTimeout(function () { try { if (ctl) ctl.abort(); } catch (e) { } }, timeoutMs);
    var init = { cache: 'no-store' };
    var o = opts || {};
    for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) init[k] = o[k];
    if (ctl) init.signal = ctl.signal;
    return Promise.resolve().then(function () {
      return fetch(url, init);
    }).then(function (res) {
      return res.text().then(function (text) {
        var json = null;
        try { json = JSON.parse(text); } catch (e) { json = null; }
        out.ok = !!res.ok;
        out.httpStatus = Number(res.status) || 0;
        out.json = json;
        return out;
      });
    }).catch(function (e) {
      out.error = (e && e.name === 'AbortError') ? 'timeout' : 'unreachable';
      return out;
    }).then(function (r) { clearTimeout(timer); return r; });
  }
  function readStatus() {
    return request(STATUS_URL, { method: 'GET' }, STATUS_TIMEOUT_MS);
  }

  /* ── 后端状态 → 阶段（纯函数） ──
     返回 null 表示「这一次读不到」——调用方一律保持当前阶段，绝不因为读不到而改判。 */
  function statusPhase(status, now) {
    if (!status || typeof status !== 'object') return null;
    var st = str(status.state);
    if (st === 'downloading' || st === 'verifying') {
      /* 死掉的 helper 留下的状态文件不是「正在下载」（后端已经算好 active） */
      if (status.active !== true) return PHASE.IDLE;
      if (st === 'verifying') return PHASE.VERIFYING;
      var bytes = num(status.bytes), total = num(status.totalBytes);
      /* 字节已经到齐、状态还停在 downloading：文件收完了，现在在做四道校验 */
      if (total > 0 && bytes >= total) return PHASE.VERIFYING;
      return PHASE.DOWNLOADING;
    }
    if (st === 'launching' || st === 'launched') return PHASE.INSTALLING;
    if (st === 'failed') return PHASE.FAILED;
    if (st === 'idle') return PHASE.IDLE;
    return null;
  }

  /* ── 一次性判定（纯函数） ──
     输入：待消费的标记 + 当前版本 + 状态投影 + 现在。
     只有「版本真的变了」才算成功；「后端说安装器已经起来了」不算。 */

  /*
   * 状态文件里写着的是不是「我们这一次」的尝试？
   * 这份文件是跨启动留下来的：上一次失败的记录会一直躺在那里，直到新的 helper
   * 写下第一行。少了这道判断，用户在失败之后点「重试」，就会在 helper 还没开口
   * 的那 1~2 秒里读到上一次的失败，然后立刻误报「更新失败」。
   * 判据两条：版本要对得上；时间不能早于本次尝试（2 秒容差——同一台机器、同一个时钟）。
   */
  function statusIsOurs(status, version, since) {
    if (!status) return false;
    var want = str(version).trim();
    var got = str(status.version).trim();
    if (want && got && got !== want) return false;
    var t = parseTime(status.updatedAt) || parseTime(status.finishedAt);
    if (since && t && t < (since - 2000)) return false;
    return true;
  }

  function judgeStartup(marker, current, status, now) {
    if (!marker || !str(marker.version).trim()) return null;
    var want = str(marker.version).trim();
    var cur = str(current).trim();
    if (cur && cur === want) return { kind: 'updated', version: cur };
    var ph = statusPhase(status, now);
    /* 还在跑：不判定、不消费，继续等 */
    if (ph === PHASE.DOWNLOADING || ph === PHASE.VERIFYING || ph === PHASE.INSTALLING) return null;
    /* 只有「失败」和「安装器已经启动过」能下结论，而且必须是这一次的 */
    if (ph === PHASE.FAILED && statusIsOurs(status, want, marker.at)) return { kind: 'incomplete', current: cur };
    if (status && str(status.state) === 'launched' && str(status.version).trim() === want) {
      return { kind: 'incomplete', current: cur };
    }
    var age = marker.at ? (now - marker.at) : 0;
    /* helper 可能还没来得及写下第一行状态：先等，不下结论 */
    if (marker.at && age >= 0 && age < START_GRACE_MS) return null;
    /* 版本读不到 → 既不能报成功也不能报失败：静默消费，不打扰用户 */
    if (!cur) return { kind: 'unknown', current: '' };
    return { kind: 'incomplete', current: cur };
  }

  /* ── 阶段切换 ── */
  function setPhase(phase, extra) {
    S.phase = phase;
    if (extra) {
      if (extra.errorText !== undefined) S.errorText = extra.errorText;
      if (extra.error !== undefined) S.error = extra.error;
      if (extra.bytes !== undefined) S.bytes = extra.bytes;
      if (extra.totalBytes !== undefined) S.totalBytes = extra.totalBytes;
      if (extra.updating !== undefined) S.updating = extra.updating;
      if (extra.incompleteAt !== undefined) S.incompleteAt = extra.incompleteAt;
      if (extra.hint !== undefined) S.hint = extra.hint;
    }
    paint();
  }
  /* 当前版本：优先用后端检查结果里的 currentVersion（同一条版本链），
     其次问诊断页（唯一的版本实现，不在这里再解析一遍 VERSION）。 */
  function currentOf() {
    if (S.current) return S.current;
    try {
      var api = NS.diagnostics;
      if (api && typeof api.productVersion === 'function') {
        var v = api.productVersion();
        if (v) return str(v);
      }
    } catch (e) { }
    return '';
  }
  function readVersion() {
    try {
      var api = NS.diagnostics;
      if (api && typeof api.readProductVersion === 'function') {
        return Promise.resolve(api.readProductVersion()).catch(function () { return ''; });
      }
    } catch (e) { }
    return Promise.resolve(currentOf());
  }

  /* ── 轮询（只在真的有安装在进行时跑） ── */
  function clearPoll() {
    if (S.pollTimer) { clearTimeout(S.pollTimer); S.pollTimer = null; }
    S.polling = false;
  }
  function schedulePoll(ms) {
    clearPoll();
    S.polling = true;
    S.pollTimer = setTimeout(function () {
      S.pollTimer = null;
      pollOnce();
    }, ms);
  }
  function shouldPoll() {
    if (S.installing) return true;
    if (PROGRESS_PHASES.indexOf(S.phase) >= 0) return true;
    /* 已经确认接受了安装请求、但 helper 还没写下第一行状态 */
    if (S.attempt && (S.phase === PHASE.DOWNLOADING || S.phase === PHASE.CHECKING)) return true;
    return false;
  }
  function pollOnce() {
    return readStatus().then(function (r) {
      var status = (r && r.ok && r.json) ? r.json : null;
      var reachable = !!(r && r.ok && r.json);
      if (!reachable) {
        S.pollFails += 1;
        /* 读不到状态 ≠ 失败。安装阶段更是如此：安装器正在正常停止 IB。
           只有「用户点过安装、且连第一行状态都没等到」才可能在超时后收场。 */
        if (S.installing) S.progressUnknown = true;
        else if (PROGRESS_PHASES.indexOf(S.phase) >= 0) S.progressUnknown = true;
        /* 到这里一律保持阶段不变 */
        paint();
        if (shouldPoll()) schedulePoll(Math.min(POLL_MS * Math.pow(2, Math.min(S.pollFails, 3)), POLL_MAX_MS));
        return;
      }
      S.pollFails = 0;
      S.progressUnknown = false;
      /* 还在等判定的时候，顺路补一次判定（宽限期到了就该给结论） */
      var verdict = (S.marker && !S.judged) ? maybeJudge(status) : null;
      if (verdict && (verdict.kind === 'updated' || verdict.kind === 'incomplete')) return;
      applyStatus(status);
    });
  }
  function applyStatus(status) {
    /* 启动判定是终局：一旦判出「装完了 / 没装完」，后面的任何状态都不许把它顶掉。
       这一条挡住的是一个真实竞态——自动检查先拿到版本、判定出「已更新」，
       紧接着那次启动状态读取才回来（状态文件里还写着 launched），
       如果没有这道闸门，卡片会在成功提示之后又跳回「正在安装」。 */
    if (S.verdict === 'updated' || S.verdict === 'incomplete') return;
    var ph = statusPhase(status, Date.now());
    var bytes = num(status.bytes), total = num(status.totalBytes);
    if (ph === PHASE.DOWNLOADING || ph === PHASE.VERIFYING) {
      S.attempt = true;
      if (!S.installing) {
        setPhase(ph, { bytes: bytes, totalBytes: total, error: null, errorText: '' });
        return schedulePoll(POLL_MS);
      }
    }
    if (ph === PHASE.INSTALLING) {
      /* 安装阶段：锁住，之后任何读不到都不改判 */
      S.installing = true;
      S.attempt = true;
      setPhase(PHASE.INSTALLING, { bytes: bytes, totalBytes: total, error: null, errorText: '' });
      /* launching 之后还可能出现 launched（交棒成功）或 failed（安装器起不来），继续看；
         launched 是终局：helper 已经把接力棒交给安装器，本页问不出更多东西了。 */
      if (str(status.state) === 'launched') { clearPoll(); return; }
      return schedulePoll(POLL_MS);
    }
    if (ph === PHASE.FAILED) {
      /* 后端明确写下 failed——这是事实，不是「读不到」。
         但先确认这份失败属于这一次尝试：上一次的失败记录会一直躺在状态文件里，
         直到新的 helper 写下第一行（见 statusIsOurs）。 */
      if (S.attempt || S.marker) {
        var want = str(S.latest).trim() || str(S.marker && S.marker.version).trim();
        if (!statusIsOurs(status, want, S.attemptAt || (S.marker && S.marker.at) || 0)) {
          return schedulePoll(500);
        }
        S.attempt = false;
        clearPoll();
        var err = status.error && typeof status.error === 'object' ? status.error : {};
        setPhase(PHASE.FAILED, {
          error: { kind: str(err.kind), message: str(err.message) },
          errorText: userText('install', err.kind, 0)
        });
        return;
      }
      return;
    }
    /* 后端说没有安装在跑 */
    if (S.installing) return;   /* 锁住：不再改判 */
    if (S.attempt) {
      var age = S.attemptAt ? (Date.now() - S.attemptAt) : 0;
      /* 已经看到过真实进度：状态文件不见了也不改判，继续读（慢一点） */
      if (S.bytes > 0) return schedulePoll(POLL_MS * 2);
      if (age >= START_GRACE_MS) {
        S.attempt = false;
        clearPoll();
        setPhase(PHASE.FAILED, { error: { kind: '', message: '' }, errorText: userText('install', '', 0) });
        return;
      }
      return schedulePoll(500);
    }
    /* 既没有本次尝试也没有标记：这是历史残留，不动 UI */
    clearPoll();
  }

  /* ── 检查（唯一入口：自动走缓存，手动 force） ── */
  function canAdoptCheck() {
    /* 一次检查的结果可以覆盖的任何阶段：空闲、正在检查、上一次失败、上次的结论。
       不能覆盖的只有两件事——正在进行的安装，和已经在启动时下过的「装完了/没装完」的结论。 */
    if (S.attempt || S.installing) return false;
    if (S.verdict === 'updated' || S.verdict === 'incomplete') return false;
    return PROGRESS_PHASES.indexOf(S.phase) < 0 && S.phase !== PHASE.INSTALLING;
  }
  function adoptCurrent(json) {
    if (json && json.currentVersion) S.current = str(json.currentVersion);
  }
  function applyCheck(r) {
    var json = (r && r.ok && r.json) ? r.json : null;
    S.lastCheckAt = Date.now();
    if (!json) {
      if (canAdoptCheck()) {
        setPhase(PHASE.FAILED, { error: { kind: 'network', message: '' }, errorText: userText('check', 'network', 0) });
      }
      return false;
    }
    adoptCurrent(json);
    S.fromCache = !!json.fromCache;
    if (json.updateAvailable && json.update && json.update.version) {
      S.latest = str(json.update.version);
      S.notes = str(json.update.notes);
      S.sizeBytes = num(json.update.sizeBytes);
      if (!canAdoptCheck()) return true;
      if (S.deferred && S.deferred === S.latest) {
        setPhase(PHASE.IDLE, { hint: '新版本 ' + S.latest + ' 已暂缓，可随时点「检查更新」。' });
        return true;
      }
      setPhase(PHASE.AVAILABLE, { error: null, errorText: '', hint: '' });
      return true;
    }
    if (str(json.status) === 'up-to-date') {
      if (canAdoptCheck()) setPhase(PHASE.UP_TO_DATE, { error: null, errorText: '', hint: '' });
      return true;
    }
    /* no-information：不是错误弹窗，只是一句「暂时查不到」+ 重试 */
    var kind = (json.error && json.error.kind) ? json.error.kind : '';
    if (canAdoptCheck()) {
      setPhase(PHASE.FAILED, { error: { kind: str(kind), message: '' }, errorText: userText('check', kind, 0) });
    }
    return false;
  }
  function runCheck(force) {
    if (S.checkInFlight) return S.checkInFlight;
    if (force) {
      S.deferred = '';
      /* 用户明确要求再查一次：上一次的「装完了 / 没装完」结论到此为止
         （标记早已消费，所以结论不会因此重复出现）。 */
      S.verdict = '';
    }
    S.busy = true;
    if (canAdoptCheck()) setPhase(PHASE.CHECKING, { error: null, errorText: '', hint: '' });
    else paint();
    var url = CHECK_URL + (force ? '?force=1' : '');
    S.checkInFlight = request(url, { method: 'GET' }, CHECK_TIMEOUT_MS).then(function (r) {
      S.checkInFlight = null;
      S.busy = false;
      var ok = applyCheck(r);
      /* 版本可能刚刚才拿到：还没下过判定的话，现在补一次 */
      maybeJudge();
      return ok;
    }).catch(function () {
      S.checkInFlight = null;
      S.busy = false;
      applyCheck(null);
      return false;
    });
    return S.checkInFlight;
  }
  function autoCheck() {
    if (!S.auto) return Promise.resolve(false);
    return runCheck(false);
  }

  /* ── 下载并安装（只提交 version） ── */
  function startInstall() {
    var version = str(S.latest).trim();
    if (!version) return Promise.resolve(false);
    S.attempt = true;
    S.attemptAt = Date.now();
    S.bytes = 0;
    S.totalBytes = 0;
    S.progressUnknown = false;
    S.error = null;
    S.errorText = '';
    S.busy = true;
    setPhase(PHASE.DOWNLOADING, { hint: '' });
    var body = JSON.stringify({ version: version });
    return request(START_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body
    }, START_TIMEOUT_MS).then(function (r) {
      S.busy = false;
      var accepted = !!(r && r.ok && r.json && r.json.ok === true);
      if (!accepted) {
        S.attempt = false;
        var kind = '';
        var httpStatus = r ? r.httpStatus : 0;
        if (r && r.json && r.json.error) {
          kind = str(typeof r.json.error === 'string' ? r.json.error : r.json.error.kind);
        } else if (r && r.error) {
          kind = 'network';
        }
        S.error = { kind: kind, httpStatus: httpStatus };
        S.errorText = userText('install', kind, httpStatus);
        setPhase(PHASE.FAILED);
        return false;
      }
      /* 已经被接受了：从现在起用户看到的每一句话都必须是真的 */
      writeMarker(version, Date.now());
      schedulePoll(300);
      return true;
    });
  }
  function retry() {
    /* 先重新验证，再用「刚刚验证过的那个版本」重试：绝不用可能已经过期的版本直接开装。 */
    return runCheck(true).then(function () {
      if (S.phase === PHASE.AVAILABLE && str(S.latest).trim()) return startInstall();
      return false;
    });
  }
  function defer() {
    S.deferred = str(S.latest);
    setPhase(PHASE.IDLE, { hint: '新版本 ' + S.deferred + ' 已暂缓，可随时点「检查更新」。' });
  }

  /* ── 启动判定：一次性消费标记 ── */
  function maybeJudge(status) {
    if (S.judged || !S.marker) return null;
    var verdict = judgeStartup(S.marker, currentOf(), status || null, Date.now());
    if (!verdict) return null;
    S.judged = true;
    S.verdict = verdict.kind;
    consumeMarker();
    if (verdict.kind === 'updated') {
      clearPoll();
      setPhase(PHASE.UPDATED, { updating: verdict.version, error: null, errorText: '', hint: '' });
      return verdict;
    }
    if (verdict.kind === 'incomplete') {
      clearPoll();
      setPhase(PHASE.INCOMPLETE, { incompleteAt: verdict.current || currentOf(), error: null, errorText: '', hint: '' });
      return verdict;
    }
    /* unknown：版本读不到，什么都不显示（也绝不假装成功） */
    return verdict;
  }

  /* ── 渲染 ── */
  function row(labelText, valueId) {
    var r = el('div', 'ib-update-row');
    r.appendChild(el('span', 'ib-update-label', labelText));
    var v = el('span', 'ib-update-value', '—');
    v.id = valueId;
    r.appendChild(v);
    return r;
  }
  function button(id, cls, text, fn) {
    var b = el('button', 'btn' + (cls ? ' ' + cls : ''), text);
    b.type = 'button';
    b.id = id;
    b.onclick = fn;
    return b;
  }
  function buildCard() {
    var card = el('div', 'glass-card ib-update');
    card.id = CARD_ID;

    var head = el('div', 'ib-update-head');
    head.appendChild(el('h3', 'ib-update-title', '更新 InternalBeyond'));
    head.appendChild(el('span', 'ib-update-sub', 'Updates'));
    card.appendChild(head);

    var rows = el('div', 'ib-update-rows');
    rows.appendChild(row('当前版本', 'ib-update-current'));
    rows.appendChild(row('更新通道', 'ib-update-channel'));
    var autoRow = el('div', 'ib-update-row');
    var autoLabel = el('label', 'ib-update-label', '自动检查更新');
    autoLabel.setAttribute('for', 'ib-update-auto');
    autoRow.appendChild(autoLabel);
    var autoValue = el('div', 'ib-update-auto');
    var auto = el('input', 'ib-update-toggle');
    auto.id = 'ib-update-auto';
    auto.type = 'checkbox';
    auto.onchange = function () { setAuto(!!auto.checked); };
    autoValue.appendChild(auto);
    var autoText = el('span', 'ib-update-auto-text', FIXED_TEXT.autoOn);
    autoText.id = 'ib-update-auto-text';
    autoValue.appendChild(autoText);
    autoRow.appendChild(autoValue);
    rows.appendChild(autoRow);
    card.appendChild(rows);
    card.appendChild(el('p', 'ib-update-hint', FIXED_TEXT.autoHint));

    var state = el('div', 'ib-update-state');
    state.id = 'ib-update-state';
    var status = el('p', 'ib-update-status', '');
    status.id = 'ib-update-status';
    state.appendChild(status);
    var sub = el('p', 'ib-update-sub-status', '');
    sub.id = 'ib-update-sub-status';
    state.appendChild(sub);

    var progress = el('div', 'ib-update-progress');
    progress.id = 'ib-update-progress';
    var bar = el('div', 'ib-update-bar');
    bar.id = 'ib-update-bar';
    bar.setAttribute('role', 'progressbar');
    bar.setAttribute('aria-valuemin', '0');
    bar.setAttribute('aria-valuemax', '100');
    var fill = el('i', 'ib-update-bar-fill');
    fill.id = 'ib-update-bar-fill';
    bar.appendChild(fill);
    progress.appendChild(bar);
    var bytesText = el('span', 'ib-update-bytes', '');
    bytesText.id = 'ib-update-bytes';
    progress.appendChild(bytesText);
    state.appendChild(progress);

    var notesBox = el('div', 'ib-update-notes-box');
    notesBox.id = 'ib-update-notes-box';
    notesBox.appendChild(el('div', 'ib-update-notes-title', FIXED_TEXT.notes));
    var notes = el('div', 'ib-update-notes', '');
    notes.id = 'ib-update-notes';
    notesBox.appendChild(notes);
    state.appendChild(notesBox);

    var actions = el('div', 'ib-update-actions');
    actions.appendChild(button('ib-update-check', 'btn-primary', '检查更新', function () { runCheck(true); }));
    actions.appendChild(button('ib-update-later', '', '稍后', function () { defer(); }));
    actions.appendChild(button('ib-update-install', 'btn-primary', '下载并安装', function () { startInstall(); }));
    actions.appendChild(button('ib-update-retry', '', '重试', function () { retry(); }));
    state.appendChild(actions);
    card.appendChild(state);

    return card;
  }
  function show(node, on) {
    if (!node) return;
    if (on) node.classList.remove('is-hidden');
    else node.classList.add('is-hidden');
  }
  function statusLine() {
    switch (S.phase) {
      case PHASE.CHECKING: return FIXED_TEXT.checking;
      case PHASE.UP_TO_DATE: return FIXED_TEXT.upToDate;
      case PHASE.AVAILABLE: return '发现新版本 ' + S.latest;
      case PHASE.DOWNLOADING:
        return (S.bytes > 0 || S.totalBytes > 0) ? FIXED_TEXT.downloading : FIXED_TEXT.preparing;
      case PHASE.VERIFYING: return FIXED_TEXT.verifying;
      case PHASE.INSTALLING: return FIXED_TEXT.installing;
      case PHASE.FAILED: return S.errorText || USER_TEXT.install.unknown;
      case PHASE.UPDATED: return '已更新到 InternalBeyond ' + (S.updating || currentOf());
      case PHASE.INCOMPLETE: return '更新未完成，当前仍为 ' + (S.incompleteAt || currentOf());
      default:
        if (S.hint) return S.hint;
        return S.lastCheckAt ? ('上次检查：' + clockText(S.lastCheckAt)) : FIXED_TEXT.neverChecked;
    }
  }
  function subLine() {
    if (S.phase === PHASE.INSTALLING) return FIXED_TEXT.installHint;
    if (PROGRESS_PHASES.indexOf(S.phase) >= 0 && S.progressUnknown) return FIXED_TEXT.progressUnknown;
    if (S.phase === PHASE.AVAILABLE) {
      return (S.sizeBytes ? (FIXED_TEXT.size + formatBytes(S.sizeBytes)) : '') +
        (S.fromCache ? (S.sizeBytes ? ' · ' : '') + '来自本地缓存' : '');
    }
    if (S.phase === PHASE.UP_TO_DATE && S.lastCheckAt) return '检查时间：' + clockText(S.lastCheckAt);
    return '';
  }
  function paint() {
    var n = S.nodes;
    if (!n || typeof document === 'undefined') return;
    var current = currentOf();
    n.current.textContent = current || '—';
    n.channel.textContent = CHANNEL_LABEL;
    n.auto.checked = !!S.auto;
    n.autoText.textContent = S.auto ? FIXED_TEXT.autoOn : FIXED_TEXT.autoOff;

    n.state.dataset.state = S.phase;
    n.status.textContent = statusLine();
    var sub = subLine();
    n.sub.textContent = sub;
    show(n.sub, !!sub);

    /* notes：纯文本，只在这里出现（available 阶段） */
    var showNotes = (S.phase === PHASE.AVAILABLE && !!S.notes);
    show(n.notesBox, showNotes);
    if (showNotes) n.notes.textContent = S.notes;
    else n.notes.textContent = '';

    /* 进度：只在下载/校验阶段显示真实字节数；安装阶段一律不显示百分比 */
    var showProgress = PROGRESS_PHASES.indexOf(S.phase) >= 0 && (S.bytes > 0 || S.totalBytes > 0);
    show(n.progress, showProgress);
    if (showProgress) {
      var pct = S.totalBytes > 0 ? percentOf(S.bytes, S.totalBytes) : 0;
      var known = S.totalBytes > 0;
      n.fill.style.width = (known ? pct : 0) + '%';
      if (known) {
        n.bar.setAttribute('aria-valuenow', String(pct));
        n.bytes.textContent = formatBytes(S.bytes) + ' / ' + formatBytes(S.totalBytes) + ' · ' + pct + '%';
      } else {
        n.bar.setAttribute('aria-valuenow', '');
        n.bytes.textContent = formatBytes(S.bytes);
      }
    } else {
      n.bytes.textContent = '';
    }

    /* 按钮：四个按钮始终在结构里，按阶段决定可见性 */
    var busy = BUSY_PHASES.indexOf(S.phase) >= 0;
    show(n.check, !busy && S.phase !== PHASE.AVAILABLE);
    show(n.later, S.phase === PHASE.AVAILABLE);
    show(n.install, S.phase === PHASE.AVAILABLE);
    show(n.retry, S.phase === PHASE.FAILED || S.phase === PHASE.INCOMPLETE);
    n.check.disabled = busy;
    n.check.textContent = (S.phase === PHASE.CHECKING) ? '正在检查…' : '检查更新';
    n.install.disabled = busy || !str(S.latest).trim();
    n.retry.disabled = false;
    n.later.disabled = false;
  }
  function renderInto(host) {
    if (!host || typeof document === 'undefined') return;
    S.host = host;
    if (!S.card || S.card.parentNode !== host) {
      if (S.card && S.card.parentNode) {
        try { S.card.parentNode.removeChild(S.card); } catch (e) { }
      }
      S.card = buildCard();
      host.appendChild(S.card);
      S.nodes = {
        card: S.card,
        current: byId('ib-update-current'),
        channel: byId('ib-update-channel'),
        auto: byId('ib-update-auto'),
        autoText: byId('ib-update-auto-text'),
        state: byId('ib-update-state'),
        status: byId('ib-update-status'),
        sub: byId('ib-update-sub-status'),
        progress: byId('ib-update-progress'),
        bar: byId('ib-update-bar'),
        fill: byId('ib-update-bar-fill'),
        bytes: byId('ib-update-bytes'),
        notesBox: byId('ib-update-notes-box'),
        notes: byId('ib-update-notes'),
        check: byId('ib-update-check'),
        later: byId('ib-update-later'),
        install: byId('ib-update-install'),
        retry: byId('ib-update-retry')
      };
    }
    paint();
  }

  function setAuto(on) {
    S.auto = !!on;
    storeSet(AUTO_KEY, S.auto ? '1' : '0');
    paint();
    if (S.auto && !S.attempt && !S.installing && S.phase !== PHASE.AVAILABLE && S.phase !== PHASE.UP_TO_DATE) {
      autoCheck();
    }
  }

  /* ── 入口 ── */
  function register() {
    try {
      var api = NS.diagnostics;
      if (api && typeof api.registerCard === 'function') {
        api.registerCard(renderInto);
        return true;
      }
    } catch (e) { }
    /* 诊断页还没就绪（或不可用）：先自己挂到 #page-diagnostics，再补一次注册。
       少了这次补注册，诊断页的下一次渲染会把这张卡片无声抹掉——
       而「脚本顺序此刻恰好是对的」不该是卡片能不能活下来的前提。 */
    var host = byId('page-diagnostics');
    if (host) renderInto(host);
    if (!S.registerRetried) {
      S.registerRetried = true;
      setTimeout(function () { register(); }, 300);
    }
    return false;
  }
  function open() {
    var host = byId('page-diagnostics');
    if (host) renderInto(host);
  }

  function boot() {
    if (S.booted) return;
    S.booted = true;
    if (typeof document === 'undefined') return;
    injectStyles();
    S.auto = autoPref();
    S.marker = readMarker();
    var start = function () {
      register();
      readVersion().then(function (v) { if (v) S.current = str(v); paint(); });
      readStatus().then(function (r) {
        var status = (r && r.ok && r.json) ? r.json : null;
        var verdict = maybeJudge(status);
        if (verdict && (verdict.kind === 'updated' || verdict.kind === 'incomplete')) return;
        if (S.marker) {
          /* 还没判定出来：说明安装还在跑（或 helper 还没写下第一行） */
          S.attempt = true;
          S.attemptAt = S.marker.at || Date.now();
          /* 有真实状态就先画真实状态；什么都没读到才用「正在准备下载」兜底 */
          if (status) applyStatus(status);
          if (S.phase === PHASE.IDLE) setPhase(PHASE.DOWNLOADING, { hint: '' });
          return schedulePoll(500);
        }
        if (status) applyStatus(status);
      });
      if (S.auto) autoCheck();
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
    else start();
  }

  var api = {
    open: open,
    register: register,
    check: function () { return runCheck(true); },
    install: function () { return startInstall(); },
    retry: retry,
    defer: defer,
    setAuto: setAuto,
    status: function () {
      return {
        phase: S.phase, current: currentOf(), latest: S.latest, notes: S.notes,
        sizeBytes: S.sizeBytes, bytes: S.bytes, totalBytes: S.totalBytes,
        installing: S.installing, attempt: S.attempt, polling: S.polling,
        auto: S.auto, marker: S.marker, verdict: S.verdict, busy: S.busy,
        lastCheckAt: S.lastCheckAt, fromCache: S.fromCache,
        /* 原始错误只给诊断与日志，不进 DOM */
        error: S.error
      };
    },
    __test: {
      PHASE: PHASE, CLASS: CLASS, KIND_CLASS: KIND_CLASS, USER_TEXT: USER_TEXT, FIXED_TEXT: FIXED_TEXT,
      MARKER_KEY: MARKER_KEY, AUTO_KEY: AUTO_KEY, MARKER_SCHEMA: MARKER_SCHEMA,
      START_GRACE_MS: START_GRACE_MS, POLL_MS: POLL_MS, CHECK_TIMEOUT_MS: CHECK_TIMEOUT_MS,
      classify: classify,
      userText: userText,
      formatBytes: formatBytes,
      percentOf: percentOf,
      statusPhase: statusPhase,
      judgeStartup: judgeStartup,
      statusIsOurs: statusIsOurs,
      state: function () { return S; },
      reset: function () {
        clearPoll();
        var keep = { auto: S.auto, booted: S.booted, host: S.host, card: S.card, nodes: S.nodes };
        Object.keys(S).forEach(function (k) { delete S[k]; });
        for (var k in S_DEFAULTS) S[k] = S_DEFAULTS[k];
        S.auto = keep.auto;
        S.booted = keep.booted;
        S.host = keep.host;
        S.card = keep.card;
        S.nodes = keep.nodes;
      },
      render: function () { if (S.host) renderInto(S.host); },
      applyCheck: applyCheck,
      applyStatus: applyStatus,
      maybeJudge: maybeJudge,
      runCheck: runCheck,
      startInstall: startInstall,
      retry: retry,
      defer: defer,
      setAuto: setAuto,
      readMarker: readMarker,
      writeMarker: writeMarker,
      consumeMarker: consumeMarker,
      pollOnce: pollOnce
    }
  };
  /* reset() 用得到的初始值快照（浅拷贝即可：全是原始值与 null） */
  var S_DEFAULTS = {};
  for (var dk in S) if (Object.prototype.hasOwnProperty.call(S, dk)) S_DEFAULTS[dk] = S[dk];

  window.IBUpdateCard = api;
  NS.updateCard = api;

  boot();
})(window.IB || (window.IB = {}));
