/* ====================================================================
   P11-3D · Tool Execution Guard（canonical 调用指纹 + 单回合执行边界）
   --------------------------------------------------------------------
   本文件回答且只回答一个问题：

     一个 AI 回合内，"还能不能再执行一次工具" 由谁裁定？

   在此之前，这个问题的答案是"没有谁"：
     · 额度散落在三处且互不相干 —— ib_fcRounds（只数外部工具轮）、
       servers[].maxRounds（只数单服务器轮）、_WS_TOOL_CONT_MAX（只数
       XML 续轮）；纯 MCP 回合一轮都不计（roundLocal 不自增）；
     · 每个 provider→tool→provider 循环用 `continue` 续跑，轮次检查
       写在循环体后段，于是**到不了**；
     · 同一个 {toolName,args} 可以无限重复执行（台账只用于渲染回查）；
     · 失败的工具可以立即无限重试；
     · 没有"整个工具周期"的时间上限，只有单次 HTTP 超时。

   本文件不重构工具系统，也不改变任何工具的业务语义：
   它只提供**执行前的裁定**。工具本体、参数、返回形状、确认流程、
   卡片渲染全部原样不动。

   ── 纯函数/纯状态，零 DOM、零网络、零 storage ──────────────────────
   额度来源由宿主注入（见 integrations.js 的 IBFC.policyFromHost），
   本文件不读 localStorage、不读 IndexedDB、不读环境变量。
   浏览器与 Node 共用同一份实现（同一脚本双挂载 + CommonJS 导出）。

   ── 可注入时钟 ─────────────────────────────────────────────────────
   now() 默认 Date.now；测试注入假时钟即可确定性地驱动 elapsed 预算，
   不需要 sleep、不需要真实等待。
   ==================================================================== */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.IBToolGuard = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : null), function () {
  'use strict';

  /* ── Phase 4：熔断原因是**封闭集合** ──────────────────────────────
     新增原因必须同时出现在这里、REASON_OF 与测试的期望里；
     没有"其它/未知"这个兜底值 —— 兜底值会让静默 break 重新变得可能。 */
  var REASONS = Object.freeze({
    ROUND_BUDGET_EXHAUSTED: 'round-budget-exhausted',
    TOOL_BUDGET_EXHAUSTED: 'tool-budget-exhausted',
    DUPLICATE_TOOL_CALL: 'duplicate-tool-call',
    DUPLICATE_TOOL_CALL_CONSECUTIVE: 'duplicate-tool-call-consecutive',
    RETRY_BUDGET_EXHAUSTED: 'retry-budget-exhausted',
    TOOL_CYCLE_TIMEOUT: 'tool-cycle-timeout',
    CYCLE_ALREADY_TRIPPED: 'cycle-already-tripped',
    NO_ACTIVE_CYCLE: 'no-active-cycle'
  });

  /* 内部触发码 → 对外稳定 reason。两者分开是因为：
     "连续重复"与"同回合重复超量"对用户是同一件事（重复），
     但排查时需要知道是哪一种 —— 于是 reason 共用，trigger 保留区分度。 */
  var REASON_OF = Object.freeze({
    'round-budget': REASONS.ROUND_BUDGET_EXHAUSTED,
    'tool-budget': REASONS.TOOL_BUDGET_EXHAUSTED,
    'duplicate-consecutive': REASONS.DUPLICATE_TOOL_CALL_CONSECUTIVE,
    'duplicate-repeat': REASONS.DUPLICATE_TOOL_CALL,
    'retry-budget': REASONS.RETRY_BUDGET_EXHAUSTED,
    'cycle-timeout': REASONS.TOOL_CYCLE_TIMEOUT,
    'already-tripped': REASONS.CYCLE_ALREADY_TRIPPED,
    'no-active-cycle': REASONS.NO_ACTIVE_CYCLE
  });

  var DEFAULT_POLICY = Object.freeze({
    maxRounds: 5,                 /* provider→tool→provider 总轮次（本回合硬上限） */
    maxToolCalls: 16,             /* 单回合工具执行总次数（一轮可含多个调用） */
    maxRetriesPerCall: 2,         /* 同一失败调用的**重试**次数（首次执行不计入） */
    successRepeatLimit: 2,        /* 同一调用**成功**后，同一回合内允许再出现的次数 */
    duplicateConsecutiveLimit: 2, /* 完全相同的调用连续出现几次即熔断 */
    maxCycleMs: 120000,           /* 整个工具执行周期的墙钟上限 */
    toolCallTimeoutMs: 60000,     /* 单个工具等待上限（软截止：不中断已发出的请求） */
    maxTimestamps: 256
  });

  /* ── 关键字段名：命中即视为敏感值，指纹层面就不带明文 ──────────────
     指纹本身只是 sha256 十六进制摘要，不含原文；这张表真正拦的是
     trace/diagnostic 里的 canonical 载荷（fingerprintDebug）。 */
  var SENSITIVE_KEY_RE = /^(api[-_]?key|apikey|authorization|auth|token|secret|password|passwd|pwd|credential|credentials|cookie|session|sessionid|access[-_]?token|refresh[-_]?token|private[-_]?key|client[-_]?secret)$/i;

  /* ── 同构的同步摘要：SHA-256，纯 JS 实现，Node 与浏览器**同一个结果** ──
     为什么不用 node:crypto / crypto.subtle：
       · crypto.subtle 是异步的，而指纹必须在执行前同步产生；
       · 于是浏览器只能退化为另一套哈希 ⇒ 同一个调用在 Node 与浏览器里得到
         不同的指纹，"canonical 指纹"这件事就不再是全局唯一的（跨端排查、
         跨端去重都失去可比性）。本次开发真实踩到过：契约测试的跨实例断言
         直接把这条不一致抓了出来。
     代价是一段自实现的 SHA-256（约 40 行）。它只用于**标识**一次调用，
     不承担任何密码学安全职责；自实现的风险由测试用 node:crypto 交叉验证
     （tests/test_p11_3d_tool_guard_contract.js 的 D 组）。 */
  var _K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ];
  function utf8Bytes(str) {
    var s = String(str), out = [];
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
      else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
        var c2 = s.charCodeAt(++i);
        var cp = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00);
        out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
      } else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    return out;
  }
  function digest(text) {
    var bytes = utf8Bytes(text);
    var bitLen = bytes.length * 8;
    bytes = bytes.concat([0x80]);
    while (bytes.length % 64 !== 56) bytes.push(0);
    /* 长度用 64 位大端表示（高位恒为 0：指纹载荷远小于 2^32 字节） */
    bytes.push(0, 0, 0, 0, (bitLen >>> 24) & 255, (bitLen >>> 16) & 255, (bitLen >>> 8) & 255, bitLen & 255);
    var h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    var w = new Array(64);
    var rotr = function (x, n) { return ((x >>> n) | (x << (32 - n))) >>> 0; };
    for (var off = 0; off < bytes.length; off += 64) {
      for (var i = 0; i < 16; i++) {
        w[i] = ((bytes[off + i * 4] << 24) | (bytes[off + i * 4 + 1] << 16) | (bytes[off + i * 4 + 2] << 8) | bytes[off + i * 4 + 3]) >>> 0;
      }
      for (i = 16; i < 64; i++) {
        var s0 = (rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3)) >>> 0;
        var s1 = (rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10)) >>> 0;
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
      }
      var a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
      for (i = 0; i < 64; i++) {
        var S1 = (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) >>> 0;
        var ch = ((e & f) ^ (~e & g)) >>> 0;
        var t1 = (hh + S1 + ch + _K[i] + w[i]) >>> 0;
        var S0 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) >>> 0;
        var mj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
        var t2 = (S0 + mj) >>> 0;
        hh = g; g = f; f = e; e = (d + t1) >>> 0;
        d = c; c = b; b = a; a = (t1 + t2) >>> 0;
      }
      h[0] = (h[0] + a) >>> 0; h[1] = (h[1] + b) >>> 0; h[2] = (h[2] + c) >>> 0; h[3] = (h[3] + d) >>> 0;
      h[4] = (h[4] + e) >>> 0; h[5] = (h[5] + f) >>> 0; h[6] = (h[6] + g) >>> 0; h[7] = (h[7] + hh) >>> 0;
    }
    var out = '';
    for (i = 0; i < 8; i++) out += ('00000000' + h[i].toString(16)).slice(-8);
    return out;
  }

  /* ── Phase 1：canonical 序列化 ─────────────────────────────────────
     · 对象键排序 → {a:1,b:2} 与 {b:2,a:1} 产出同一字符串
     · undefined 值的键被丢弃 → {a:1} 与 {a:1,b:undefined} 视为同一次调用
     · 数组顺序**保留**（顺序是参数语义的一部分）
     · 循环引用 → 稳定哨兵，不抛、不递归爆栈 */
  function stableSerialize(value) {
    var seen = new WeakSet();
    function walk(v) {
      if (v === null) return 'null';
      var t = typeof v;
      if (t === 'number') return isFinite(v) ? String(v) : 'null';
      if (t === 'boolean') return v ? 'true' : 'false';
      if (t === 'string') return JSON.stringify(v);
      if (t === 'bigint') return JSON.stringify(String(v));
      if (t === 'function' || t === 'symbol') return '"[unserializable:' + t + ']"';
      if (t === 'undefined') return '"[undefined]"';
      if (seen.has(v)) return '"[circular]"';
      seen.add(v);
      try {
        if (Array.isArray(v)) return '[' + v.map(walk).join(',') + ']';
        var keys = Object.keys(v).sort();
        var parts = [];
        for (var i = 0; i < keys.length; i++) {
          var k = keys[i];
          if (v[k] === undefined) continue;   /* 键序与"显式 undefined"都不影响语义 */
          parts.push(JSON.stringify(k) + ':' + walk(v[k]));
        }
        return '{' + parts.join(',') + '}';
      } finally {
        seen.delete(v);                        /* 同一对象在不同分支出现不算循环 */
      }
    }
    return walk(value);
  }

  /* 敏感键的值在 canonical 载荷里替换为长度标签：既不带明文，
     也保留"这里有个值/值的量级"这一点排查信息。 */
  function redactSensitive(value) {
    var seen = new WeakSet();
    function walk(v, keyName) {
      if (keyName && SENSITIVE_KEY_RE.test(String(keyName).replace(/[\s_-]/g, ''))) {
        return '[redacted:' + (v == null ? 0 : String(v).length) + ']';
      }
      if (v === null || typeof v !== 'object') return v;
      if (seen.has(v)) return '[circular]';
      seen.add(v);
      try {
        if (Array.isArray(v)) return v.map(function (x) { return walk(x, ''); });
        var out = {};
        Object.keys(v).forEach(function (k) { out[k] = walk(v[k], k); });
        return out;
      } finally { seen.delete(v); }
    }
    return walk(value, '');
  }

  /* 指纹 = digest(canonical(toolName) + '|' + canonical(args))
     · 不含 tool-call id（模型每次给的 id 都可能不同）
     · 不含 UI 文本、不含时间戳、不含顺序号
     · 不读 localStorage —— 因此"上一次运行"与"这一次运行"之间可比
     · 定长十六进制摘要：观测面与 trace 永远拿不到参数原文 */
  function fingerprint(toolName, args) {
    var payload = JSON.stringify(String(toolName == null ? '' : toolName)) + '|' +
      stableSerialize(args === undefined ? {} : args);
    return digest(payload);
  }
  /* 仅供断言与本地排查：返回**已脱敏**的 canonical 载荷，绝不返回原文。 */
  function fingerprintPayload(toolName, args) {
    var payload = JSON.stringify(String(toolName == null ? '' : toolName)) + '|' +
      stableSerialize(redactSensitive(args === undefined ? {} : args));
    return payload;
  }
  function preview(full) {
    var s = String(full == null ? '' : full);
    return s.length <= 16 ? s : s.slice(0, 16);
  }

  function clampInt(v, dflt, min, max) {
    var n = typeof v === 'number' ? v : parseInt(v, 10);
    if (!isFinite(n)) return dflt;
    n = Math.floor(n);
    if (n < min) return dflt;         /* 低于下限视为非法 → 回落默认，而不是夹到下限 */
    if (max != null && n > max) return max;
    return n;
  }

  /* 预算只允许被"调紧"：宿主给 99 也好、Infinity 也好、负数也好，
     最终都要落回有限值 —— 有限性是**构造性**的，不依赖调用方自觉。 */
  function normalizePolicy(input) {
    var p = Object.assign({}, DEFAULT_POLICY, input || {});
    var out = {
      maxRounds: clampInt(p.maxRounds, DEFAULT_POLICY.maxRounds, 1, 64),
      maxToolCalls: clampInt(p.maxToolCalls, DEFAULT_POLICY.maxToolCalls, 1, 256),
      maxRetriesPerCall: clampInt(p.maxRetriesPerCall, DEFAULT_POLICY.maxRetriesPerCall, 0, 16),
      successRepeatLimit: clampInt(p.successRepeatLimit, DEFAULT_POLICY.successRepeatLimit, 1, 64),
      duplicateConsecutiveLimit: clampInt(p.duplicateConsecutiveLimit, DEFAULT_POLICY.duplicateConsecutiveLimit, 1, 16),
      maxCycleMs: clampInt(p.maxCycleMs, DEFAULT_POLICY.maxCycleMs, 1000, 60 * 60 * 1000),
      toolCallTimeoutMs: clampInt(p.toolCallTimeoutMs, DEFAULT_POLICY.toolCallTimeoutMs, 1000, 15 * 60 * 1000),
      maxTimestamps: clampInt(p.maxTimestamps, DEFAULT_POLICY.maxTimestamps, 8, 4096)
    };
    /* 派生不变量：成功重复上限永远不能超过单回合工具总预算 ——
       否则"重复"这条闸门就成了唯一没被总预算覆盖的漏洞。 */
    if (out.successRepeatLimit > out.maxToolCalls) out.successRepeatLimit = out.maxToolCalls;
    return Object.freeze(out);
  }

  /* ── 判定结果：允许时返回 {allowed:true}，拒绝时返回带 reason 的裁定 ──
     调用方**必须**按 allowed 决定是否执行；没有任何"默认放行"的取值。 */
  function deny(code, detail) {
    return Object.freeze({ allowed: false, reason: code, detail: detail || {} });
  }

  function createGuard(options) {
    options = options || {};
    var policy = normalizePolicy(options.policy);
    var now = typeof options.now === 'function' ? options.now : function () { return Date.now(); };
    var maxTrace = clampInt(options.maxTrace, 64, 1, 512);

    var cycles = 0;
    var breakerHistory = [];        /* 只保留原因/计数/时间 —— 没有参数 */
    var last = null;
    var st = null;

    function mins(ms) { return Math.round((Number(ms) || 0) / 1000); }

    function pushTrace(entry) {
      if (!st) return;
      st.trace.push(entry);
      if (st.trace.length > maxTrace) st.trace.splice(0, st.trace.length - maxTrace);
    }

    function trip(trigger, extra) {
      if (st.tripped) return st.trip;
      var code = REASON_OF[trigger];
      if (!code) throw new Error('tool-guard: unknown breaker trigger ' + trigger);
      var detail = Object.assign({ trigger: trigger }, extra || {});
      st.tripped = true;
      st.trip = Object.freeze({ reason: code, trigger: trigger, detail: Object.freeze(detail), atRound: st.rounds + 1 });
      pushTrace({ t: 'trip', reason: code, trigger: trigger, atRound: st.trip.atRound });
      last = { reason: code, trigger: trigger, detail: st.trip.detail };
      breakerHistory.push({ reason: code, trigger: trigger, cycle: cycles, elapsedMs: now() - st.startedAt });
      if (breakerHistory.length > 16) breakerHistory.splice(0, breakerHistory.length - 16);
      return st.trip;
    }

    function windowTrim() {
      var cutoff = now() - policy.maxCycleMs;
      while (st.tsCursor < st.ts.length && st.ts[st.tsCursor] < cutoff) st.tsCursor++;
      if (st.tsCursor > 64) { st.ts = st.ts.slice(st.tsCursor); st.tsCursor = 0; }
    }

    function statFor(fp) {
      var s = st.byFp[fp];
      if (!s) s = st.byFp[fp] = { fp: fp, name: '', total: 0, consecutive: 0, okCount: 0, failCount: 0, retries: 0, lastOk: null, timedOut: 0 };
      return s;
    }

    /* 分类：这是第几次、之前那次成功了没有、是不是紧接着同一个调用。
       分类结果决定它吃哪一个额度 —— 这是"不要把状态型工具当成幂等工具"
       在实现层面的落点：额度是**分开**的，不是一句"重复即拒绝"。 */
    function classify(fp, stat) {
      var consecutive = st.tail === fp;
      stat.consecutive = consecutive ? (stat.consecutive || 0) + 1 : 1;
      stat.total += 1;
      if (consecutive && stat.total > 1) {
        /* 连续重复：前一次失败 → 这是重试；前一次成功 → 这是成功后的重复 */
        if (stat.lastOk === false) return 'retry';
        return 'duplicate-consecutive';
      }
      if (stat.total > 1 && stat.lastOk === false) return 'retry';
      if (stat.total > 1) return 'duplicate-repeat';
      return 'new';
    }

    function beforeCall(toolName, args, meta) {
      meta = meta || {};
      if (!st || st.closed) {
        return deny(REASONS.NO_ACTIVE_CYCLE, { note: 'no-active-cycle' });
      }
      if (st.tripped) return deny(st.trip.reason, { trigger: st.trip.trigger, note: 'cycle-already-tripped' });
      if (meta.kind === 'round') {
        /* 宿主在发起 provider 调用前询问（第 2 轮起） */
        if (st.rounds + 1 > policy.maxRounds) {
          trip('round-budget', { rounds: st.rounds, maxRounds: policy.maxRounds });
          return deny(st.trip.reason, { trigger: st.trip.trigger, rounds: st.rounds, maxRounds: policy.maxRounds });
        }
        return Object.freeze({ allowed: true, kind: 'round' });
      }
      var elapsed = now() - st.startedAt;
      if (elapsed > policy.maxCycleMs) {
        trip('cycle-timeout', { elapsedMs: elapsed, maxCycleMs: policy.maxCycleMs });
        return deny(st.trip.reason, { elapsedMs: elapsed, maxCycleMs: policy.maxCycleMs });
      }
      windowTrim();
      if (st.ts.length - st.tsCursor >= policy.maxToolCalls) {
        trip('tool-budget', { used: st.ts.length - st.tsCursor, maxToolCalls: policy.maxToolCalls });
        return deny(st.trip.reason, { used: st.ts.length - st.tsCursor, maxToolCalls: policy.maxToolCalls });
      }
      var fp = fingerprint(toolName, args);
      var stat = statFor(fp);
      if (!stat.name) stat.name = String(toolName == null ? '' : toolName);
      var kind = classify(fp, stat);
      var limit, reasonOnTrip;
      if (kind === 'retry') {
        limit = policy.maxRetriesPerCall;
        reasonOnTrip = 'retry-budget';
      } else if (kind === 'duplicate-consecutive') {
        limit = policy.duplicateConsecutiveLimit;
        reasonOnTrip = 'duplicate-consecutive';
      } else if (kind === 'duplicate-repeat') {
        limit = policy.successRepeatLimit;
        reasonOnTrip = 'duplicate-repeat';
      } else {
        limit = null;
      }
      /* 判定口径：计数**含本次**。new 永远是第 1 次，永远不会被这条挡住。 */
      if (limit != null) {
        var consumed = kind === 'retry' ? stat.retries + 1 : stat.total;
        if (consumed > limit) {
          trip(reasonOnTrip, { fp: preview(fp), name: stat.name, kind: kind, consumed: consumed, limit: limit });
          return deny(st.trip.reason, { trigger: st.trip.trigger, kind: kind, consumed: consumed, limit: limit, fingerprint: fp });
        }
      }
      st.ts.push(now());
      st.tools += 1;
      st.tail = fp;
      st.pending.push({ fp: fp, kind: kind });
      pushTrace({ t: 'call', fp: preview(fp), name: stat.name, kind: kind, n: st.tools });
      return Object.freeze({ allowed: true, kind: kind, classification: kind, fingerprint: fp, name: stat.name });
    }

    function afterCall(toolName, args, outcome) {
      if (!st) return null;
      var fp = fingerprint(toolName, args);
      var stat = st.byFp[fp];
      if (!stat) stat = statFor(fp);
      outcome = outcome || {};
      var ok = outcome.ok === true;
      var timedOut = outcome.timedOut === true;
      /* 配对最近一次未结算的预约；找不到也不抛（宿主可能只记结果） */
      for (var i = st.pending.length - 1; i >= 0; i--) {
        if (st.pending[i].fp === fp) { st.pending.splice(i, 1); break; }
      }
      stat.lastOk = ok;
      if (ok) stat.okCount += 1; else stat.failCount += 1;
      if (timedOut) stat.timedOut += 1;
      var isRetry = (!ok && stat.consecutive > 1 && stat.total > 1);
      if (isRetry) stat.retries += 1;
      st.failures += ok ? 0 : 1;
      st.retries += isRetry ? 1 : 0;
      pushTrace({ t: 'result', fp: preview(fp), name: stat.name, ok: ok, timedOut: timedOut, reason: ok ? '' : String(outcome.reason || '').slice(0, 120) });
      /* 最后一次允许的重试也失败了 → **就在此刻**熔断，而不是等模型再试一次。
         理由：不能把"有限重试"的兑现挂在模型下一条消息上 ——
         模型不再调用时，边界看着没被越过，但它其实从未起作用。
         超时单独一因：软截止到点即断，不消耗重试额度（重试也救不回一个不返回的工具）。 */
      if (!ok && st.tripped === false) {
        if (timedOut) trip('cycle-timeout', { fp: preview(fp), name: stat.name, note: 'tool-call-timeout' });
        else if (stat.total > 1 && stat.retries >= policy.maxRetriesPerCall) trip('retry-budget', { fp: preview(fp), name: stat.name, retries: stat.retries, limit: policy.maxRetriesPerCall });
      }
      return { fp: fp, ok: ok, timedOut: timedOut, tripped: !!(st && st.tripped) };
    }

    /* ── 结算**唯一入口**：宿主在执行一次工具之后只调用这一个方法 ──────────
       它同时完成 ①结构化 verdict 的判定与入账 ②失败/超时/重试耗尽带来的熔断。
       为什么要收成一个入口：如果把 verdict 判定留在宿主、结算留在引擎，宿主只要
       把判定放在结算之后（或在中间插入任何一步），就会出现"工具真的执行了、
       计数与熔断却什么都没发生"的回合 —— 观测面显示的是一次没有发生的执行。
       这个 bug 在本次开发里真实出现过，因此边界在这里收成不可分的一步。 */
    function settleCall(toolName, args, result) {
      var r = result || {};
      var ok = r.ok === true;
      var verdict = ok ? (r.pendingConfirm ? 'pending-confirm' : 'ok') : 'failed';
      var out = afterCall(toolName, args, { ok: ok, reason: r.reason, timedOut: r.guardTimedOut === true });
      return {
        verdict: verdict,
        settled: !!out,
        timedOut: !!(out && out.timedOut),
        tripped: !!(out && out.tripped)
      };
    }

    function beforeRound() {
      if (!st) return deny(REASONS.NO_ACTIVE_CYCLE, { note: 'no-active-cycle' });
      if (st.tripped) return deny(st.trip.reason, { trigger: st.trip.trigger, note: 'cycle-already-tripped' });
      var elapsed = now() - st.startedAt;
      if (elapsed > policy.maxCycleMs) {
        trip('cycle-timeout', { elapsedMs: elapsed, maxCycleMs: policy.maxCycleMs });
        return deny(st.trip.reason, { elapsedMs: elapsed, maxCycleMs: policy.maxCycleMs });
      }
      if (st.rounds + 1 > policy.maxRounds) {
        trip('round-budget', { rounds: st.rounds, maxRounds: policy.maxRounds });
        return deny(st.trip.reason, { trigger: st.trip.trigger, rounds: st.rounds, maxRounds: policy.maxRounds });
      }
      return Object.freeze({ allowed: true, round: st.rounds + 1, maxRounds: policy.maxRounds });
    }
    function afterRound() {
      if (!st) return null;
      st.rounds += 1;
      pushTrace({ t: 'round', n: st.rounds, maxRounds: policy.maxRounds });
      return st.rounds;
    }

    function noteElapsed() {
      if (!st || st.tripped) return false;
      var elapsed = now() - st.startedAt;
      if (elapsed > policy.maxCycleMs) {
        trip('cycle-timeout', { elapsedMs: elapsed, maxCycleMs: policy.maxCycleMs });
        return true;
      }
      return false;
    }

    function startCycle(meta) {
      cycles += 1;
      st = {
        id: cycles,
        startedAt: now(),
        auth: !!(meta && meta.authorized),
        dbg: !!(meta && meta.debug),
        rounds: 0,
        tools: 0,
        failures: 0,
        retries: 0,
        byFp: {},
        tail: '',
        ts: [],
        tsCursor: 0,
        pending: [],
        trace: [],
        tripped: false,
        trip: null,
        closed: false
      };
      pushTrace({ t: 'start', policy: policySummary() });
      return st.id;
    }

    /* 幂等：没有活动周期时返回 null，而不是伪造一份快照。
       调用方（宿主 finally）因此可以无条件收尾。 */
    function endCycle() {
      if (!st) return null;
      st.closed = true;
      var s = snapshot();
      st = null;
      return s;
    }

    function policySummary() {
      return {
        maxRounds: policy.maxRounds,
        maxToolCalls: policy.maxToolCalls,
        maxRetriesPerCall: policy.maxRetriesPerCall,
        successRepeatLimit: policy.successRepeatLimit,
        duplicateConsecutiveLimit: policy.duplicateConsecutiveLimit,
        maxCycleMs: policy.maxCycleMs,
        toolCallTimeoutMs: policy.toolCallTimeoutMs
      };
    }

    /* ── Phase 5：观测快照 ────────────────────────────────────────────
       只含计数、指纹短前缀、工具名与原因；**不含任何工具参数**。 */
    function snapshot() {
      var elapsed = st ? (now() - st.startedAt) : 0;
      var perCall = [];
      if (st) {
        Object.keys(st.byFp).forEach(function (fp) {
          var s = st.byFp[fp];
          perCall.push({ fingerprint: preview(fp), name: s.name, total: s.total, ok: s.okCount, failed: s.failCount, retries: s.retries, timedOut: s.timedOut });
        });
      }
      return Object.freeze({
        active: !!st,
        authorized: !!(st && st.auth),
        cycle: st ? st.id : cycles,
        rounds: st ? st.rounds : 0,
        maxRounds: policy.maxRounds,
        toolCalls: st ? st.tools : 0,
        maxToolCalls: policy.maxToolCalls,
        duplicates: st ? Object.keys(st.byFp).reduce(function (n, fp) { return n + Math.max(0, st.byFp[fp].total - 1) - st.byFp[fp].retries; }, 0) : 0,
        retries: st ? st.retries : 0,
        failures: st ? st.failures : 0,
        distinctCalls: st ? Object.keys(st.byFp).length : 0,
        elapsedMs: elapsed,
        elapsedSec: mins(elapsed),
        maxCycleMs: policy.maxCycleMs,
        breakerReason: st && st.trip ? st.trip.reason : '',
        tripped: !!(st && st.tripped),
        perCall: perCall,
        policy: policySummary()
      });
    }

    function trace() { return st ? st.trace.slice() : []; }
    function lastBreaker() { return last ? Object.assign({}, last, { detail: Object.assign({}, last.detail) }) : null; }
    function breakerHistoryView() { return breakerHistory.map(function (x) { return Object.assign({}, x); }); }
    function active() { return !!st; }
    function tripped() { return !!(st && st.tripped); }
    function tripInfo() { return st && st.trip ? { reason: st.trip.reason, trigger: st.trip.trigger, detail: Object.assign({}, st.trip.detail) } : null; }
    function policyView() { return policy; }

    /* 调用面就是这些 —— 没有任何清空计数、重置熔断、强制放行的入口。
       熔断后唯一的出路是**新回合**（startCycle），而不是本回合的某个开关。 */
    return Object.freeze({
      policy: policyView,
      startCycle: startCycle,
      endCycle: endCycle,
      active: active,
      beforeCall: beforeCall,
      afterCall: afterCall,
      settleCall: settleCall,
      beforeRound: beforeRound,
      afterRound: afterRound,
      noteElapsed: noteElapsed,
      snapshot: snapshot,
      trace: trace,
      tripped: tripped,
      tripInfo: tripInfo,
      lastBreaker: lastBreaker,
      breakerHistory: breakerHistoryView
    });
  }

  return Object.freeze({
    REASONS: REASONS,
    DEFAULT_POLICY: DEFAULT_POLICY,
    normalizePolicy: normalizePolicy,
    stableSerialize: stableSerialize,
    redactSensitive: redactSensitive,
    fingerprint: fingerprint,
    fingerprintPayload: fingerprintPayload,
    createGuard: createGuard
  });
});
