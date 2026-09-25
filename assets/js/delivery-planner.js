/* ====================================================================
   IB Delivery Planner — 「模型一次生成的内容 → delivery sequence」的**唯一**规则型 planner
   (P23 Phase 2C · UMD dual-load)
   --------------------------------------------------------------------
   - Browser: <script src="assets/js/delivery-planner.js"> → window.IBDeliveryPlanner
   - Node   : require('../assets/js/delivery-planner.js')（测试用）
   - 规则：零 DOM / 零 fetch / 零 IndexedDB / 零 provider / 零 TTS / 零定时器 / 零时钟 /
     零 Math.random。**纯逻辑层**：给定文本，给出结构；不产生时间。

   ── 它负责什么 ─────────────────────────────────────────────────────
   把"一个完整 assistant turn 的文本"切成若干 delivery unit（内容结构），
   输出 Phase 2A 的 sequence 输入形状：
       { mode:'single'|'sequence',
         units:[{kind:'text', content:'…'}],
         segments:[…], policy:{…}, stats:{…} }
   单向依赖：Planner 输出 →（Phase 2A 契约构造）→（Phase 2B Delivery Runtime）。
   本文件**不认识** runtime、不认识 queue、不认识 cancel、不认识 typing。

   ── 它绝不负责什么（硬边界）────────────────────────────────────────
     · 时间 / 节奏 / delayBefore / sendAt —— 那是 Phase 2B Runtime 的（本文件不输出任何时间字段）
     · 拆完之后的落库与渲染 —— adapter 的
     · 调用 LLM 决定怎么拆（成本/不稳定/难复现，本阶段明令禁止）
     · 改写内容 —— 本文件是**无损**切分：所有 unit 拼起来 ⊇ 原文（仅空白归一）
     · 决定 kind（voice/image）—— 本阶段只产出 text（schema 已为未来留位，见 RESERVED）

   ── 与 MessagePresentation 的关系（P23 2C 的收敛）────────────────────
   拆句逻辑此前住在 communication.js 的 `window.MessagePresentation` 里（既管"怎么拆"
   又管"隔多久发"）。Phase 2C 把**结构**这一半搬进本文件（唯一实现），
   `MessagePresentation` 只留**呈现与节奏**（mode / delayBetween / plan），并转调本文件。
   拆分规则逐字沿用既有实现（它们被浏览器端到端测试钉住：waifu.splitRules /
   waifu.contract.* / waifu.example1.*），本阶段只**增加**三处显式策略：
     ① 过短 unit 并入邻居（避免「你」「好」各成一条）；
     ② 硬上界（避免 5000 字一个气泡）；
     ③ 策略常量集中暴露（policy()/stats），使"边界明确、可测"。
   ==================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); }
  else { root.IBDeliveryPlanner = factory(); }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ── 策略常量（唯一真源；测试断言的是这些数字，而不是散落的字面量）─────────
     取值沿用既有实现（SOFT_TARGET / HARD_LEN / SUB_MIN / BRACKET_INTACT 都是原值），
     不新发明数字；新增的只有"下限"与"样式提示的上界"。 */
  var POLICY = {
    version: 1,
    MIN_UNIT_CHARS: 4,        /* 低于它的 unit 并入邻居（新：避免单字消息） */
    MAX_UNIT_CHARS: 96,       /* 硬上界（= 既有 HARD_LEN） */
    SOFT_TARGET_CHARS: 44,    /* 一个"自然拍"的参考长度（既有 SOFT_TARGET） */
    SUB_MIN_CHARS: 14,        /* 长句次级切分的最小片段（既有 SUB_MIN） */
    BRACKET_INTACT_CHARS: 48, /* 成对结构整体保留的上限（既有 BRACKET_INTACT） */
    MAX_UNITS: 60,            /* 与 Phase 2A 的 MAX_UNITS 一致（硬上限） */
    DEFAULT_MAX_SEGMENTS: 30, /* 既有 split 的默认段数上限 */
    STYLE_MAX_CHARS: { short: 64, long: 160 }   /* 样式提示只能在这个范围内调整硬上界 */
  };
  /* 本阶段只产出 text；voice / image 的**登记**在 Phase 2A 的契约里（RESERVED_KINDS），
     本文件不发明任何新的 kind，也不建立第二套 voice/image schema。 */
  var EMITTED_KINDS = ['text'];

  /* ── 标点 / 结构（逐字沿用既有实现）── */
  var HARD_STOP = /[。！？!?]/;                       /* 真正句读：句号 / 感叹 / 问号 */
  var COMMA = /[，,、]/;                              /* 逗号类（"转折分句"与"长句次级断"） */
  /* 语义/叙事转折词：逗号后紧跟这类词 → 视为"新一拍"，即使同句也拆成独立消息。
     注意：把 然后/接着/随后/终于 这类"顺承"词排除，保证"她看了你一会儿，然后轻轻笑了一下。"仍旧一条。 */
  var SPLIT_CONNECTOR_RE = /^\s*(?:不过|但是|可是|然而|所以|因此|其实|对了|还有|而且|再说|就是说|换句话说|更重要的是|顺便|另外|况且|再者|总之|于是)\s*/;
  var FILLER_RE = /^\s*(?:嗯|哦|噢|啊|哈|哎|唉|呃|唔|呀|嗯嗯|哦哦|哈哈|嘿嘿|哎呀|emm|emmm)\s*[，,。！？!?]?\s*$/;
  var ONLY_STRUCT = /^[\s\-—–…\.。，、；;：:！!？?'"“”‘’()（）\[\]【】「」『』{}<>《》]+$/;
  /* 成对结构：recursive（叙事可再拆，括号附着内容） vs atomic（JSON/列表/强调，整块不拆） */
  var RECURSIVE_PAIRS = { '(': ')', '（': '）', '「': '」', '『': '』', '“': '”', '‘': '’', '"': '"' };
  var ATOMIC_PAIRS = { '[': ']', '{': '}', '【': '】' };
  /* 功能标签：这类回复**整条一条**（绝不拆）。
     P23 2C 在既有的 ws_/cal_/mem_/think/withdraw 之外补上 blog_read —— 不是新功能，
     而是补一个真实漏洞：`<blog_read …>` 由 _parseBlogReadOps 解析，若被从中间拆开，
     该指令会在两条消息里各坏一半（既有规则只覆盖前五个前缀）。 */
  var FUNCTIONAL_TAG_RE = /<\s*(?:ws_|cal_|mem_|think|withdraw|blog_read)/i;

  /* ═══ ① Structural Parsing：文本 → token 序列（atomic / bracket / prose）═══
     atomic：code fence / inline code / URL / Markdown link / 图片 / JSON / 列表 —— 绝不内部切分。
     bracket：成对结构（含嵌套），开括号附着首条内文、闭括号附着末条内文，绝不孤立。
     prose：普通自然语言，交给 ② utterance segmentation。 */
  function _tokenize(t) {
    var toks = []; var i = 0; var n = t.length;
    var proseStart = -1;
    var flushProse = function (end) { if (proseStart >= 0) { var p = t.slice(proseStart, end); if (p) toks.push({ kind: 'prose', text: p }); proseStart = -1; } };
    var atomAdd = function (s, e) { if (e > s) toks.push({ kind: 'atomic', text: t.slice(s, e) }); };
    while (i < n) {
      var ch = t[i];
      /* ── code fence（``` / ~~~）── */
      if (t.slice(i, i + 3) === '```' || t.slice(i, i + 3) === '~~~') {
        flushProse(i); var fence = t.slice(i, i + 3);
        var close = t.indexOf(fence, i + 3); var end = close === -1 ? n : close + 3;
        atomAdd(i, end); i = end; continue;
      }
      /* ── inline code（`）── */
      if (ch === '`') {
        flushProse(i); var ic = t.indexOf('`', i + 1); var iend = ic === -1 ? n : ic + 1;
        atomAdd(i, iend); i = iend; continue;
      }
      /* ── Markdown 强调 / 删除线（**…** / __…__ / ~~…~~）──
         P23 2C 补：这类标记必须**成对**留在同一条消息里，否则每条气泡都会渲染成
         "**你好。" 这种半截粗体（既有实现只保护了代码块与链接，没保护强调）。
         只在同一行内找闭合标记；找不到就当普通文本（绝不吞掉孤立符号）。 */
      if (ch === '*' || ch === '_' || ch === '~') {
        var mark = (t.slice(i, i + 2) === ch + ch) ? (ch + ch) : '';
        if (mark) {
          var mEnd = t.indexOf(mark, i + 2);
          var nlAt = t.indexOf('\n', i);
          if (mEnd > i + 1 && (nlAt === -1 || mEnd < nlAt)) {
            flushProse(i); atomAdd(i, mEnd + 2); i = mEnd + 2; continue;
          }
        }
      }
      /* ── Markdown 链接/图片 [文本](url) / ![alt](url) ── */
      if (ch === '[' || (ch === '!' && t[i + 1] === '[')) {
        var op = t.indexOf('](', i);
        if (op > i) {
          var cl = t.indexOf(')', op + 2); var lend = cl === -1 ? n : cl + 1;
          if (lend - i <= 2000 && t.slice(i, lend).indexOf('\n') === -1) { flushProse(i); atomAdd(i, lend); i = lend; continue; }
        }
      }
      /* ── URL ── */
      var u = t.slice(i).match(/^(?:https?:\/\/|www\.)[^\s`\u4e00-\u9fff，。；！？、；“”（）【】]+/i);
      if (u && u[0].length >= 4) { flushProse(i); atomAdd(i, i + u[0].length); i += u[0].length; continue; }
      /* ── 成对结构（嵌套感知；分清 recursive / atomic）── */
      if (RECURSIVE_PAIRS[ch] || ATOMIC_PAIRS[ch]) {
        var closeCh = RECURSIVE_PAIRS[ch] || ATOMIC_PAIRS[ch];
        var pend = _matchPaired(t, i, ch, closeCh);
        if (pend > i + 1) {
          flushProse(i);
          var isRecursive = !!RECURSIVE_PAIRS[ch];
          toks.push({ kind: 'bracket', open: ch, close: closeCh, recursive: isRecursive, text: t.slice(i, pend), inner: t.slice(i + 1, pend - 1) });
          i = pend; continue;
        }
      }
      if (proseStart < 0) proseStart = i;
      i++;
    }
    flushProse(n);
    return toks;
  }
  function _matchPaired(t, openIdx, openCh, closeCh) {
    if (openCh === closeCh) { var nx = t.indexOf(closeCh, openIdx + 1); return nx === -1 ? -1 : nx + 1; }
    var depth = 0;
    for (var i = openIdx; i < t.length; i++) {
      var c = t[i];
      if (c === openCh) depth++;
      else if (c === closeCh) { depth--; if (depth === 0) return i + 1; }
    }
    return -1;
  }

  /* ═══ ②③ 由 token 组装成"消息候选"（beats），并保证结构完整 ═══ */
  function _beatsFromTokens(toks, p) {
    var beats = [];
    for (var ti = 0; ti < toks.length; ti++) {
      var tk = toks[ti];
      if (tk.kind === 'atomic') { beats.push(tk.text); continue; }
      if (tk.kind === 'prose') { var ps = _segmentProse(tk.text, p); for (var pi = 0; pi < ps.length; pi++) beats.push(ps[pi]); continue; }
      /* bracket */
      var inner = tk.inner;
      var innerTrim = String(inner).replace(/\s+/g, ' ').trim();
      var hasPara = /\n[ \t]*\n/.test(inner);
      if (!tk.recursive || (innerTrim.length <= p.bracketIntact && !hasPara)) { beats.push(tk.text); continue; } /* 整块一条 */
      var innerBeats = _beatsFromTokens(_tokenize(inner), p).map(function (b) { return b.trim(); });
      if (innerBeats.length === 0) { beats.push(tk.text); continue; }
      if (innerBeats.length === 1) { beats.push(tk.open + innerBeats[0] + tk.close); continue; }
      var out = innerBeats.slice();
      out[0] = tk.open + out[0];
      out[out.length - 1] = out[out.length - 1] + tk.close;
      for (var bi = 0; bi < out.length; bi++) beats.push(out[bi]);
    }
    return beats;
  }

  /* ═══ ② Utterance Segmentation：仅对自然语言 ═══
     边界优先级：空行段落 > 句读（。！？）> 语义转折分句（逗号+转折词）> 过长在次级停顿处断。
     每条 utterance 近似"一个真人拍一次发送键"（WHAT is ONE message），不跨边界合并。 */
  function _segmentProse(text, p) {
    var paras = String(text).split(/\n[ \t]*\n/);
    var beats = [];
    for (var qi = 0; qi < paras.length; qi++) {
      var para = paras[qi];
      if (!String(para).replace(/\s/g, '')) continue;
      var ut = _utterances(para, p);
      var pending = null;
      for (var k = 0; k < ut.length; k++) {
        var u = String(ut[k]).replace(/\s+/g, ' ').trim();
        if (!u) continue;
        if (pending) { u = pending + u; pending = null; }
        if (FILLER_RE.test(u)) { pending = u; continue; }   /* 前导语气（嗯，）与下一条合并，不单独发 */
        beats.push(u);
      }
      if (pending) beats.push(pending);
    }
    return beats;
  }
  function _utterances(para, p) {
    var base = []; var buf = '';
    for (var i = 0; i < para.length; i++) {
      var ch = para[i];
      buf += ch;
      if (HARD_STOP.test(ch)) { base.push(buf); buf = ''; continue; }        /* 句读 → 一句话 */
      if (COMMA.test(ch) && SPLIT_CONNECTOR_RE.test(para.slice(i + 1))) {     /* 逗号+转折词 → 新拍 */
        base.push(buf); buf = '';
      }
    }
    if (buf.trim()) base.push(buf);
    var out = [];
    for (var si = 0; si < base.length; si++) {
      var s = base[si];
      if (s.length <= p.maxUnitChars) { out.push(s); }
      else { var pts = _splitLong(s, p); for (var pt = 0; pt < pts.length; pt++) out.push(pts[pt]); }
    }
    return out;
  }
  function _splitLong(s, p) {
    var parts = []; var buf = '';
    for (var i = 0; i < s.length; i++) {
      var ch = s[i];
      buf += ch;
      if (COMMA.test(ch) && buf.trim().length >= p.subMin) {
        var prevDigit = /[0-9]/.test(s[i - 1] || '');
        var nextDigit = /[0-9]/.test(s[i + 1] || '');
        if (!(ch === ',' && prevDigit && nextDigit)) { parts.push(buf); buf = ''; }
      }
    }
    if (buf.trim()) parts.push(buf);
    /* 尾部过短并入上一条，避免碎段（既有规则：阈值 = SUB_MIN） */
    if (parts.length > 1 && parts[parts.length - 1].trim().length < p.subMin) {
      parts[parts.length - 2] = parts[parts.length - 2] + parts[parts.length - 1];
      parts.pop();
    }
    return parts.length > 1 ? parts : [s];
  }

  /* ═══ anti-fragmentation（既有）：绝不输出只有 结构/标点 的消息，自动并入相邻 ═══ */
  function _antiFrag(beats) {
    var out = [];
    for (var i = 0; i < beats.length; i++) {
      var x = String(beats[i]).trim();
      if (!x) continue;
      if (ONLY_STRUCT.test(x)) { if (out.length) out[out.length - 1] = out[out.length - 1] + x; else out.push(x); continue; }
      out.push(x);
    }
    return out.filter(Boolean);
  }

  /* ═══ ④ min-unit policy（新）：过短的 unit 并入邻居（避免「你」「好」各成一条）═══
     规则（确定性、可测）：
       · 只处理 < MIN_UNIT_CHARS 的 unit；
       · 优先并入**前一条**（口语里短句通常是上一句的尾巴）；它是第一条时并入**后一条**；
       · 合并后若超过 maxUnitChars，则**保持原样**（宁可留一个短句，也不制造超长气泡），
         并在 stats 里记一次 out-of-policy（诚实上报，不静默）；
       · 只有一条 unit 时不合并（否则整段塌成一条，等于关掉多段呈现 —— 那由调用方决定）。 */
  function _mergeShort(segs, p, stats) {
    var out = segs.slice();
    if (!p.minUnitChars || p.minUnitChars <= 0 || out.length < 2) return out;
    var i = 0;
    while (i < out.length) {
      if (String(out[i]).trim().length >= p.minUnitChars || out.length < 2) { i++; continue; }
      var target = (i > 0) ? (i - 1) : 1;
      var merged = (i > 0) ? (out[target] + out[i]) : (out[i] + out[target]);
      if (merged.length > p.maxUnitChars) { stats.shortKept++; i++; continue; }
      out[target] = merged;
      out.splice(i, 1);
      stats.mergedShort++;
      if (i > 0) i--;                       /* 合并后可能让前一条也变短 → 重新判一次 */
    }
    return out;
  }

  /* ═══ ⑤ hard cap（新）：单条超过 maxUnitChars 时按"最近的边界"切，最后兜底按长度切 ═══
     为什么必须有：_splitLong 只在**逗号**处断，遇到 500 字不带逗号的段落会整块留下。
     边界优先级（全部确定性）：句读/逗号等标点 → 空白 → 直接按长度切（最后手段）。 */
  function _hardCap(segs, p, stats) {
    var out = [];
    for (var i = 0; i < segs.length; i++) {
      var s = segs[i];
      if (s.length <= p.maxUnitChars) { out.push(s); continue; }
      stats.hardCapped++;
      var rest = s;
      while (rest.length > p.maxUnitChars) {
        var win = rest.slice(0, p.maxUnitChars + 1);   /* 注意不要叫 window（会遮住全局，且破坏"纯模块"守卫） */
        var cut = -1;
        for (var k = win.length - 1; k >= Math.floor(p.maxUnitChars / 2); k--) {
          if (/[。！？!?；;，,、：:\s…]/.test(win[k])) { cut = k + 1; break; }
        }
        if (cut <= 0) cut = p.maxUnitChars;   /* 没有任何边界 → 按长度切（最后手段） */
        out.push(rest.slice(0, cut));
        rest = rest.slice(cut);
      }
      if (rest) out.push(rest);
    }
    return out;
  }

  /* ═══ ⑥ overflow：超出段数上限时，把尾巴**按长度上界**装箱（绝不丢内容）═══
     两个上界冲突时的优先级（明确且可测）：
       ① 长度上界（MAX_UNIT_CHARS）优先 —— 宁可多两条消息，也不要一个 255 字的气泡；
       ② 段数上限（maxSegments，既有 30）在 ① 之下让位，但总数不超过硬上限 MAX_UNITS(60)；
       ③ 连 60 条都装不下（800+ 句的极端输入）才是**唯一**允许超标的情形：
          剩下的全部并入最后一条，并记 stats.overflowForced（诚实上报，不静默）。 */
  function _mergeOverflow(segs, p, stats) {
    if (segs.length <= p.maxSegments) return segs;
    var head = segs.slice(0, p.maxSegments - 1);
    var restText = segs.slice(p.maxSegments - 1).join('');
    stats.overflowMerged = segs.length - (p.maxSegments - 1);
    var chunks = _hardCap([restText], p, stats);
    var out = head.concat(chunks);
    if (out.length > p.maxUnits) {
      stats.overflowForced = out.length - p.maxUnits;
      var tail = out.slice(p.maxUnits - 1).join('');
      out = out.slice(0, p.maxUnits - 1).concat([tail]);
    }
    return out;
  }

  function norm(s) { return String(s == null ? '' : s).replace(/\s+/g, ''); }

  /* ── hints（§7 persona / §12 Middle Brain 的**唯一** extension point）────────
     本阶段没有人给 hints（生产调用点不传），因此默认行为与既有实现完全一致。
     允许的 hint：
       style: 'short' | 'long'  —— 只影响**硬上界**（短句角色 → 更早断；长段角色 → 更晚断），
                                   绝不改写内容、绝不改变句读边界优先级。
       preferVoice: boolean     —— **接受但本阶段无效**（voice planner 不在 2C）。
     Middle Brain 未来若要给 hint，只能经这个对象；它永远不能直接控制写入。 */
  function normalizeHints(opts) {
    var o = (opts && typeof opts === 'object') ? opts : {};
    var h = (o.hints && typeof o.hints === 'object') ? o.hints : o;
    /* 只读一次原始取值，再用局部名比较 —— 既避免重复取值，也不给
       tests/test_frontend_structure.js 的 inline-style 预算计数器送假阳性：
       那条计数把 "style" 后面紧跟等号或恒等号的形式都算成一次内联样式。 */
    var raw = String(h.style || '').toLowerCase();
    var mode = (raw === 'short' || raw === 'long') ? raw : 'default';
    return { style: mode, preferVoice: h.preferVoice === true };
  }
  function policyFor(hints) {
    var h = hints || normalizeHints(null);
    var maxChars = POLICY.MAX_UNIT_CHARS;
    var mode = h.style;
    if (mode === 'short') maxChars = POLICY.STYLE_MAX_CHARS.short;
    else if (mode === 'long') maxChars = POLICY.STYLE_MAX_CHARS.long;
    return {
      version: POLICY.version,
      minUnitChars: POLICY.MIN_UNIT_CHARS,
      maxUnitChars: maxChars,
      softTargetChars: POLICY.SOFT_TARGET_CHARS,
      subMin: POLICY.SUB_MIN_CHARS,
      bracketIntact: POLICY.BRACKET_INTACT_CHARS,
      maxUnits: POLICY.MAX_UNITS,
      maxSegments: POLICY.DEFAULT_MAX_SEGMENTS,
      style: mode,
      preferVoice: h.preferVoice
    };
  }

  /* ── segment(text, opts) → string[] | null ───────────────────────────
     null 的语义与既有 `MessagePresentation.split` 逐字一致：
       · 空文本 / 只剩标点 → null
       · 含功能标签（ws_/cal_/mem_/think/withdraw/blog_read）→ null（整条原样呈现）
       · 拆不出多条（≤1）→ null
     非 null 时是**无损**的：所有片段拼起来（忽略空白）等于原文。 */
  function segment(text, opts) {
    var plan = planTurn(text, opts);
    return plan.mode === 'sequence' ? plan.segments.slice() : null;
  }

  /* ── planTurn(text, opts) → Delivery Plan（本阶段的对外契约）──────────
     opts: { maxSegments?, hints?|style?|preferVoice? }
     返回：
       {
         mode: 'single' | 'sequence',           // single = 一条消息（legacy / fast path）
         units: [{kind:'text', content}],       // Phase 2C 的 unit 形状（无时间字段）
         segments: [string],                    // 便于既有消费者按 string 处理
         policy: {…},                           // 生效的可测边界
         stats: { inputChars, unitCount, mergedShort, shortKept, hardCapped,
                  overflowMerged, lossless, functionalTags, reason }
       }
     绝不抛错：任何异常 → 退化成 single（绝不因为 planner 故障而丢回复）。 */
  function planTurn(text, opts) {
    var o = (opts && typeof opts === 'object') ? opts : {};
    var raw = String(text == null ? '' : text);
    var hints = normalizeHints(o);
    var policy = policyFor(hints);
    var stats = {
      inputChars: raw.length, unitCount: 0, mergedShort: 0, shortKept: 0,
      hardCapped: 0, overflowMerged: 0, overflowForced: 0, lossless: true, functionalTags: false, reason: ''
    };
    function single(reason) {
      stats.reason = reason;
      stats.unitCount = 1;
      var t = raw.trim();
      return {
        mode: 'single', units: t ? [{ kind: 'text', content: t }] : [],
        segments: t ? [t] : [], policy: policy, stats: stats, hints: hints
      };
    }
    var trimmed = raw.trim();
    if (!trimmed) return single('empty');
    if (FUNCTIONAL_TAG_RE.test(trimmed)) { stats.functionalTags = true; return single('functional-tags'); }
    try {
      var maxSegments = Math.max(2, Math.min(Number(o.maxSegments) || policy.maxSegments, POLICY.MAX_UNITS));
      var p = {
        maxUnitChars: policy.maxUnitChars, subMin: policy.subMin,
        bracketIntact: policy.bracketIntact, minUnitChars: policy.minUnitChars,
        maxSegments: maxSegments, maxUnits: policy.maxUnits
      };
      var segs = _antiFrag(_beatsFromTokens(_tokenize(trimmed), p));
      segs = _mergeShort(segs, p, stats);
      segs = _hardCap(segs, p, stats);
      segs = _mergeOverflow(segs, p, stats);
      if (segs.length <= 1) return single('not-multiple');
      stats.unitCount = segs.length;
      stats.lossless = norm(segs.join('')) === norm(trimmed);
      return {
        mode: 'sequence',
        units: segs.map(function (s) { return { kind: 'text', content: s }; }),
        segments: segs.slice(), policy: policy, stats: stats, hints: hints
      };
    } catch (e) {
      return single('planner-error');
    }
  }

  /* ── toSequenceInput(plan) → Phase 2A 的 sequence 输入形状 ──────────────
     Phase 2A 契约里 unit 的字段名是 `text`（content 是**消息**的权威字段）；
     Phase 2C 的 planner 输出用 `content`（本阶段契约的写法）。
     两种写法之间只允许有**这一个**转换点 —— 禁止在调用方各自映射。 */
  function toSequenceInput(plan) {
    var units = (plan && Array.isArray(plan.units)) ? plan.units : [];
    return {
      units: units.map(function (u) {
        return { kind: String(u.kind || 'text'), text: String(u.content == null ? '' : u.content) };
      })
    };
  }

  /* ── 只读观测（§14 trace 口径）──────────────────────────────────────
     只暴露**计数与策略**，绝不包含正文：turnId / unit count / state 由 runtime 记录，
     planner 只回"切了几条、用了哪版策略"。 */
  function summaryOf(plan) {
    if (!plan) return null;
    return {
      mode: plan.mode,
      unitCount: (plan.stats && plan.stats.unitCount) || 0,
      inputChars: (plan.stats && plan.stats.inputChars) || 0,
      policyVersion: (plan.policy && plan.policy.version) || POLICY.version,
      reason: (plan.stats && plan.stats.reason) || ''
    };
  }

  return Object.freeze({
    POLICY: POLICY,
    EMITTED_KINDS: EMITTED_KINDS,
    FUNCTIONAL_TAG_RE: FUNCTIONAL_TAG_RE,
    policyFor: policyFor,
    normalizeHints: normalizeHints,
    planTurn: planTurn,
    segment: segment,
    toSequenceInput: toSequenceInput,
    summaryOf: summaryOf
  });
});
