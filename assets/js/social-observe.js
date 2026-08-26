/* 社交行为观测（Social Observe）—— 观察期专用轻量本地统计，前后台可选共用。
   设计约束（必须遵守）：
   - 纯旁路：只记录统计与紧凑事件，绝不修改任何社交行为/Prompt/调度/冷却/亲和度；
   - 零模型调用：不发起任何请求；token 用量经现有 _tkRecord 记账通道旁路归因（无则退化为字符估算）；
   - 本地：浏览器存 localStorage（ib_social_obs_v1），companion 存 DATA_DIR/social-observe.json；禁止上传；
   - 有界：原始事件环形缓冲 + 按日聚合双轨；TTL 与容量见 LIMITS，写入时自动裁剪；
   - 可关闭：浏览器 IB.socialObserve.setEnabled(false) 或 Moments 设置开关；companion 设 IB_SOCIAL_OBSERVE=off。
   事件只含：时间戳、类型、角色 id、方向、计数、耗时、token 数——绝不含 prompt/Memory/模型输出正文。
   加载方式：
   - 浏览器：<script src="assets/js/social-observe.js">（在 moments.js 之前）；挂载 window._socialObserve / IB.socialObserve；
   - Node：const core=require('./assets/js/social-observe.js'); const obs=core.createWith({load,save});
     （依赖注入持久化，模块自身零 IO，与本项目工厂约定一致。） */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    const api = factory();
    root._socialObserve = api;
    root.IB = root.IB || {};
    root.IB.socialObserve = api;
  }
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';
  const ROOT = (typeof self !== 'undefined') ? self : globalThis; /* 全局对象（工厂无参，显式解析） */

  /* ══════════ 容量与保留（有界承诺） ══════════ */
  const LIMITS = {
    TTL_DAYS: 14,          /* 原始事件与聚合均保留 14 天 */
    MAX_EVENTS: 3000,      /* 原始事件环形上限（超出丢最旧） */
    MAX_DAYS: 30,          /* 按日聚合保留天数（聚合体积极小） */
    OPEN_WINDOW_MS: 48 * 3600000, /* 48h 内仍有评论的线程视为"进行中" */
    CALL_ATTRACT_WINDOW: 300000  /* token 归因：记账到达与调用开始的最大间隔 */
  };
  const STORAGE_KEY = 'ib_social_obs_v1';
  const USER = 'user';           /* 用户在矩阵中的哨兵 id */

  function dateKey(ms) {
    const d = new Date(Number(ms) || Date.now());
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  function emptyAgg() {
    return { e: 0, po: 0, up: 0, de: 0, cm: 0, uc: 0, rp: 0, lk: 0, lc: 0, tp: 0, to: 0, ec: 0,
      bc: 0, bf: 0, ba: 0, dd: 0, li: 0, gf: 0, hr: new Array(24).fill(0), act: {}, mx: {} };
  }
  function defaultState(now) {
    return { v: 1, enabled: true, startAt: Number(now) || Date.now(), agg: {}, events: [] };
  }

  /* ══════════ 实例工厂（浏览器单例 / Node createWith 共用同一套内核） ══════════ */
  function createInstance(persist) {
    const store = {
      load: typeof (persist && persist.load) === 'function' ? persist.load : function () { return null; },
      save: typeof (persist && persist.save) === 'function' ? persist.save : function () {}
    };
    let state = null, dirty = false, flushTimer = null;
    let activeCalls = [];       /* 进行中的社交模型调用（token 归因登记簿；运行时态，不持久化） */
    let tkHookInstalled = false;

    function loadState() {
      if (state) return state;
      let saved = null;
      try { saved = store.load(); } catch (e) { saved = null; }
      if (saved && saved.v === 1 && typeof saved === 'object') {
        state = {
          v: 1,
          enabled: saved.enabled !== false,
          startAt: Number(saved.startAt) || Date.now(),
          agg: (saved.agg && typeof saved.agg === 'object') ? saved.agg : {},
          events: Array.isArray(saved.events) ? saved.events.filter(ev => ev && ev.t) : []
        };
      } else state = defaultState();
      return state;
    }
    function prune(now) {
      now = Number(now) || Date.now();
      const s = loadState();
      const minTs = now - LIMITS.TTL_DAYS * 86400000;
      if (s.events.length > LIMITS.MAX_EVENTS || (s.events.length && s.events[0] && Number(s.events[0].ts) < minTs)) {
        s.events = s.events.filter(ev => Number(ev.ts) >= minTs);
        if (s.events.length > LIMITS.MAX_EVENTS) s.events.splice(0, s.events.length - LIMITS.MAX_EVENTS);
      }
      Object.keys(s.agg).forEach(k => {
        const t = Date.parse(k + 'T00:00:00');
        if (!Number.isFinite(t) || now - t > LIMITS.MAX_DAYS * 86400000) delete s.agg[k];
      });
    }
    function scheduleFlush() {
      if (flushTimer) return;
      flushTimer = setTimeout(function () { flushTimer = null; flush(); }, 15000);
      if (flushTimer && typeof flushTimer.unref === 'function') flushTimer.unref();
    }
    function flush() {
      if (!dirty) return;
      dirty = false;
      const s = loadState();
      try {
        prune();
        store.save(s);
      } catch (e) {
        /* 配额/IO 失败：丢一半旧事件重试一次；仍失败则静默放弃（绝不影响业务） */
        try { s.events.splice(0, Math.ceil(s.events.length / 2)); store.save(s); } catch (e2) {}
      }
    }

    /* ── 计数与方向矩阵（聚合是校准数据的主载体；事件环仅作明细抽查） ── */
    function bump(a, ev, hour) {
      const t = ev.t;
      if (hour >= 0 && hour <= 23 && ['post', 'comment', 'reply', 'like', 'user_post', 'user_comment'].indexOf(t) >= 0) a.hr[hour] += 1;
      switch (t) {
        case 'post': a.po += 1; break;
        case 'user_post': a.up += 1; break;
        case 'post_declined': a.de += 1; break;
        case 'comment': a.cm += 1; break;
        case 'user_comment': a.uc += 1; break;
        case 'reply': a.rp += 1; break;
        case 'like': a.lk += 1; break;
        case 'llm_call': a.lc += 1; if (ev.tk) { a.tp += ev.tk.p || 0; a.to += ev.tk.o || 0; } a.ec += ev.ec || 0; if (!ev.ok) a.gf += 1; break;
        case 'block':
          if (ev.reason === 'cooldown' || ev.reason === 'cooldown_prefilter' || ev.reason === 'cooldown_or_rate') a.bc += 1;
          else if (ev.reason === 'freq_hour' || ev.reason === 'freq_day') a.bf += 1;
          else if (ev.reason === 'already_commented') a.ba += 1;
          break;
        case 'dedupe': a.dd += 1; break;
        case 'lowinfo': a.li += 1; break;
        default: break;
      }
      /* 角色参与计数 */
      if (ev.actor && typeof ev.actor === 'string' && ['post', 'comment', 'reply', 'like'].indexOf(t) >= 0) {
        const slot = a.act[ev.actor] || (a.act[ev.actor] = { po: 0, cm: 0, rp: 0, lk: 0 });
        if (t === 'post') slot.po += 1; else if (t === 'comment') slot.cm += 1; else if (t === 'reply') slot.rp += 1; else slot.lk += 1;
      }
      /* 方向互动矩阵：actor 对 target 的内容发生了一次互动；方向严格保留（A›B ≠ B›A），用户以哨兵 id 入阵 */
      if (ev.actor && ev.target && ev.actor !== ev.target && ['comment', 'reply', 'like'].indexOf(t) >= 0) {
        const key = String(ev.actor) + '\u0001' + String(ev.target);
        a.mx[key] = (a.mx[key] || 0) + 1;
      }
    }
    function record(type, data) {
      try {
        const s = loadState();
        if (!s.enabled) return false;
        const now = Date.now();
        const ev = { ts: now, t: String(type || '') };
        if (data && typeof data === 'object') {
          for (const k in data) { const v = data[k]; if (v !== undefined && v !== null) ev[k] = v; }
        }
        const dk = dateKey(now);
        const a = s.agg[dk] || (s.agg[dk] = emptyAgg());
        a.e += 1;
        bump(a, ev, new Date(now).getHours());
        /* llm_call 只进聚合（高频且数字已入 agg）；其余类型进事件环供明细抽查 */
        if (ev.t !== 'llm_call') s.events.push(ev);
        dirty = true;
        scheduleFlush();
        return true;
      } catch (e) { return false; }
    }

    /* ── 模型调用登记（零请求改动：仅在三个生成器的既有调用点包一层计时/归因） ── */
    function charsOf(messages) {
      try {
        let n = 0;
        (Array.isArray(messages) ? messages : []).forEach(m => { n += String((m && m.content) || '').length; });
        return n;
      } catch (e) { return 0; }
    }
    function installTkHook() {
      if (tkHookInstalled || typeof ROOT === 'undefined') return;
      const cur = ROOT._tkRecord;
      if (typeof cur !== 'function' || cur.__ibObs) { tkHookInstalled = true; return; }
      const wrapped = function (cfg, u) {
        try {
          if (u && activeCalls.length) {
            const cid = String((cfg && cfg.id) || '');
            const now = Date.now();
            for (let i = 0; i < activeCalls.length; i++) {
              const h = activeCalls[i];
              if (h && !h.tk && h.cid === cid && (now - h.since) < LIMITS.CALL_ATTRACT_WINDOW) {
                h.tk = { p: ((u.i | 0) + (u.cr | 0) + (u.cw | 0)), o: (u.o | 0) };
                break;
              }
            }
          }
        } catch (e) {}
        return cur.apply(this, arguments);
      };
      wrapped.__ibObs = true;
      try { ROOT._tkRecord = wrapped; } catch (e) {}
      tkHookInstalled = true;
    }
    function callBegin(kind, cfg, messages) {
      try {
        const s = loadState();
        if (!s.enabled) return null;
        installTkHook(); /* 迟安装：确保包到最终实现（bridge/social 的包装链之后） */
        const h = { kind: String(kind || ''), cid: String((cfg && cfg.id) || ''), since: Date.now(), chars: charsOf(messages), tk: null };
        activeCalls.push(h);
        return h;
      } catch (e) { return null; }
    }
    function callEnd(h, ok, costMs, errStage) {
      try {
        if (h) { const ix = activeCalls.indexOf(h); if (ix >= 0) activeCalls.splice(ix, 1); }
        record('llm_call', {
          kind: h && h.kind || '', ok: !!ok, ms: Math.max(0, Number(costMs) || 0),
          tk: (h && h.tk) || null, ec: (h && !h.tk) ? (h.chars || 0) : 0,
          stage: errStage ? String(errStage).slice(0, 24) : ''
        });
      } catch (e) {}
    }

    /* ── 开关 ── */
    function isEnabled() { return !!loadState().enabled; }
    function setEnabled(v) {
      const s = loadState();
      s.enabled = !!v;
      dirty = true;
      flush();
      return s.enabled;
    }

    /* ── 报表：按日聚合 + 方向互动矩阵（附 pairAffinity 当前值便于相关性对照） ── */
    function report(opts) {
      opts = opts || {};
      const s = loadState();
      const days = Math.max(1, Math.min(LIMITS.MAX_DAYS, Number(opts.days) || 14));
      const now = Date.now();
      const dates = Object.keys(s.agg).sort().slice(-days);
      const daily = dates.map(dk => {
        const a = s.agg[dk];
        const gen = a.po + a.de;
        return {
          date: dk, posts: a.po, userPosts: a.up, declined: a.de,
          publishFalseRatio: gen > 0 ? +(a.de / gen).toFixed(3) : null,
          comments: a.cm, userComments: a.uc, replies: a.rp, likes: a.lk,
          llmCalls: a.lc, llmFailures: a.gf,
          promptTokens: a.tp, outputTokens: a.to,
          estInputCharsNoUsage: a.ec,
          blockCooldown: a.bc, blockFreq: a.bf, blockAlready: a.ba,
          dedupeHits: a.dd, lowInfoFiltered: a.li,
          hourHistogram: a.hr.slice(),
          actors: Object.assign({}, a.act)
        };
      });
      const mx = {};
      dates.forEach(dk => { const a = s.agg[dk]; for (const k in a.mx) mx[k] = (mx[k] || 0) + a.mx[k]; });
      const affFn = typeof opts.affinityFn === 'function' ? opts.affinityFn : null;
      const matrix = Object.keys(mx).map(k => {
        const parts = k.split('\u0001');
        const row = { from: parts[0], to: parts[1], count: mx[k] };
        if (affFn && parts[0] !== USER && parts[1] !== USER) row.affinity = affFn(parts[0], parts[1]);
        return row;
      }).sort((x, y) => y.count - x.count).slice(0, 200);
      const act = {};
      dates.forEach(dk => {
        const a = s.agg[dk];
        for (const id in a.act) {
          const slot = act[id] || (act[id] = { posts: 0, comments: 0, replies: 0, likes: 0 });
          slot.posts += a.act[id].po || 0; slot.comments += a.act[id].cm || 0;
          slot.replies += a.act[id].rp || 0; slot.likes += a.act[id].lk || 0;
        }
      });
      const sum = f => daily.reduce((v, d) => v + (f(d) || 0), 0);
      const posts = sum(d => d.posts), declined = sum(d => d.declined);
      const nightShare = (() => {
        let n = 0, tot = 0;
        daily.forEach(d => d.hourHistogram.forEach((c, h) => { tot += c; if (h >= 0 && h < 7) n += c; }));
        return tot > 0 ? +(n / tot).toFixed(3) : null;
      })();
      return {
        enabled: s.enabled, observingSince: s.startAt, generatedAt: now, rangeDays: days,
        totals: {
          posts, userPosts: sum(d => d.userPosts), declined,
          publishFalseRatio: (posts + declined) > 0 ? +(declined / (posts + declined)).toFixed(3) : null,
          comments: sum(d => d.comments), userComments: sum(d => d.userComments),
          replies: sum(d => d.replies), likes: sum(d => d.likes),
          llmCalls: sum(d => d.llmCalls), llmFailures: sum(d => d.llmFailures),
          promptTokens: sum(d => d.promptTokens), outputTokens: sum(d => d.outputTokens),
          estInputCharsNoUsage: sum(d => d.estInputCharsNoUsage),
          blockCooldown: sum(d => d.blockCooldown), blockFreq: sum(d => d.blockFreq),
          blockAlready: sum(d => d.blockAlready), dedupeHits: sum(d => d.dedupeHits),
          lowInfoFiltered: sum(d => d.lowInfoFiltered),
          nightActivityShare_0to6: nightShare
        },
        daily: daily, actors: act, interactionMatrix: matrix,
        rawEventsRetained: s.events.length
      };
    }
    function recentEvents(n) {
      const s = loadState();
      return s.events.slice(-Math.max(1, Number(n) || 100));
    }

    return {
      record, callBegin, callEnd, isEnabled, setEnabled,
      report, recentEvents, flush, prune: () => prune()
    };
  }

  /* ══════════ 线程统计（纯函数：从动态列表计算，不在运行时维护生命周期） ══════════ */
  /* 输入 moments：[{id,authorType,roleId,createdAt,comments:[{id,authorType,authorId,replyTo,createdAt}]}]
     输出：每线程 {参与者/评论数/最大深度/持续分钟/是否达 12 评论/是否达 3 轮/状态/结束原因} + 汇总。 */
  function computeThreadStats(moments, opts) {
    opts = opts || {};
    const now = Number(opts.nowMs) || Date.now();
    const openWindow = Number(opts.openWindowMs) || LIMITS.OPEN_WINDOW_MS;
    const roundsFn = typeof opts.roundsFn === 'function'
      ? opts.roundsFn
      : cs => (Array.isArray(cs) ? cs.filter(c => c && c.authorType === 'role' && String(c.replyTo || '').trim()).length : 0);
    const out = [];
    const list = Array.isArray(moments) ? moments : [];
    for (const m of list) {
      if (!m || !m.id) continue;
      const cs = (Array.isArray(m.comments) ? m.comments : []).filter(c => c && c.id);
      if (!cs.length) { out.push({ id: m.id, comments: 0, maxDepth: 0, rounds: 0, zeroCommentPost: true }); continue; }
      const sorted = cs.slice().sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
      const byId = {}; sorted.forEach(c => { byId[c.id] = c; });
      const depthMemo = {};
      const depthOf = c => {
        let d = 0, cur = c, guard = 0;
        while (cur && guard < 64) { d += 1; guard += 1; cur = (cur.replyTo && byId[cur.replyTo]) || null; }
        return d;
      };
      let maxDepth = 0;
      sorted.forEach(c => { const d = depthOf(c); if (d > maxDepth) maxDepth = d; });
      const participants = []; const seenP = {};
      let userInvolved = false;
      sorted.forEach(c => {
        if (c.authorType === 'user') { userInvolved = true; return; }
        const id = String(c.authorId || '');
        if (id && !seenP[id]) { seenP[id] = 1; participants.push(id); }
      });
      const first = Date.parse(sorted[0].createdAt || '') || 0;
      const lastC = sorted[sorted.length - 1];
      const last = Date.parse(lastC.createdAt || '') || first;
      const rounds = roundsFn(sorted);
      const hitComments12 = sorted.length >= 12;
      const hitRounds3 = rounds >= 3;
      const open = (now - last) < openWindow;
      out.push({
        id: m.id,
        authorType: m.authorType === 'user' ? 'user' : 'role',
        author: m.authorType === 'user' ? USER : String(m.roleId || ''),
        participants: participants, userInvolved: userInvolved,
        comments: sorted.length, maxDepth: maxDepth, rounds: rounds,
        durationMin: first && last >= first ? Math.round((last - first) / 60000) : 0,
        lastActivityAt: last,
        hitCommentsCap12: hitComments12, hitRoundsCap3: hitRounds3,
        status: open ? 'open' : 'ended',
        endReason: open ? 'open' : (hitComments12 ? 'cap_comments' : (hitRounds3 ? 'cap_rounds' : 'natural_or_stale'))
      });
    }
    const real = out.filter(t => !t.zeroCommentPost);
    const zeros = out.length - real.length;
    const ended = real.filter(t => t.status === 'ended');
    const natural = ended.filter(t => t.endReason === 'natural_or_stale');
    const avg = arr => arr.length ? +(arr.reduce((v, x) => v + x, 0) / arr.length).toFixed(2) : 0;
    return {
      threads: out,
      summary: {
        scannedMoments: out.length, threadsWithComments: real.length, zeroCommentPosts: zeros,
        avgComments: avg(real.map(t => t.comments)),
        avgMaxDepth: avg(real.map(t => t.maxDepth)),
        avgDurationMin: avg(real.map(t => t.durationMin)),
        endedCount: ended.length,
        naturalEndRatio_ofEnded: ended.length ? +(natural.length / ended.length).toFixed(3) : null,
        capRoundsRate_ofEnded: ended.length ? +((ended.length - natural.length - ended.filter(t => t.endReason === 'cap_comments').length) / ended.length).toFixed(3) : null,
        capCommentsRate_ofEnded: ended.length ? +((ended.filter(t => t.endReason === 'cap_comments').length) / ended.length).toFixed(3) : null,
        openCount: real.length - ended.length
      }
    };
  }

  /* ══════════ 亲和度快照（当前静态值的有序全对枚举；供"affinity vs 实际互动"对照） ══════════ */
  function pairAffinitySnapshot(roleIds, affinityFn, maxPairs) {
    const ids = (Array.isArray(roleIds) ? roleIds : []).map(String).filter(Boolean);
    const fn = typeof affinityFn === 'function' ? affinityFn : null;
    if (!fn) return [];
    const cap = Math.max(1, Number(maxPairs) || 4000);
    const rows = [];
    for (const a of ids) for (const b of ids) {
      if (a === b) continue;
      if (rows.length >= cap) return rows;
      rows.push({ from: a, to: b, affinity: fn(a, b) });
    }
    return rows;
  }

  /* ══════════ 浏览器默认实例（localStorage 持久化；Node 侧用 createWith 注入文件持久化） ══════════ */
  function lsLoad() {
    if (typeof localStorage === 'undefined') return null;
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
  }
  function lsSave(state) {
    if (typeof localStorage === 'undefined') throw new Error('no localStorage');
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }

  const api = createInstance(
    (typeof module === 'object' && module.exports)
      ? { load: () => null, save: () => {} }   /* Node 默认无持久化；companion 用 createWith 注入 */
      : { load: lsLoad, save: lsSave }
  );
  api.createWith = createInstance;
  api.computeThreadStats = computeThreadStats;
  api.pairAffinitySnapshot = pairAffinitySnapshot;
  api.LIMITS = LIMITS;
  api.USER = USER;

  return api;
});
