/* ====================================================================
   IB Context Budget Core — P11-3X-C · ONE HOST TURN → ONE CONTEXT BUDGET
   --------------------------------------------------------------------
   - Browser: <script src="assets/js/context-budget-core.js"> → window.IBContextBudgetCore
   - Node   : require('./assets/js/context-budget-core.js')
   - 规则：零 window / 零 DOM / 零 fetch / 纯函数；不读任何 producer，
     只对"已经组装好的请求"做计量与裁剪计划，因此可以在 Node 里直接做契约测试。

   为什么必须有这个模块（P11-3X-C 的实测依据，不是设计偏好）：
     修复前，全仓**没有任何一处知道一个请求有多大**：
       · 每个块各自 truncate（memory 2000 字符 / understanding 300 / moments 900 /
         history 5 条 / site ctx max(2000,8000-|wsBlock|) …），彼此互不知情；
       · 全仓 grep `contextWindow|maxInputTokens|tokenCount|estimateTokens` = 0 命中；
       · 唯一的"token"函数是 communication.js 的 `_cacheTok`，且只用于
         `[IB Cache Audit]` 的日志字符串，从不参与任何判定。
     实测后果（本阶段的 runtime 计量）：`cfg.systemPrompt` 与 `cfg.relationship`
     都是用户自由文本且**完全没有上限** —— 各注入 20,000 字符时，一个请求的
     system 段就是 40,499 字符 / 40,384 估算 token；各注入 200,000 字符时是
     400,499 字符 / 400,384 估算 token，而代码里没有任何一处会因此停下或报警。

   唯一的估算器（canonical estimator）：
     本模块的 `estimateTokens` 就是 `_cacheTok` 的算法本体（CJK 1 token/字、
     其余 0.33 token/字符）。全仓只允许存在这一份实现：communication.js
     的 `_cacheTok` 现在**委托**到这里，而不是各留一份。
     它是 **conservative estimator，不是 provider tokenizer**：不假装与任何
     厂商的分词一致，只用于"量级 + 上限判定"。

   预算单位与三档（P11-3X-C 冻结）：
     totalBudget          应用级天花板（见 APP_CEILING_TOKENS）
     reservedOutputBudget 预留给模型自己输出的额度
     inputBudget          = totalBudget − reservedOutputBudget（所有输入块共享）
   provider 专属的 context window / max input **不在本阶段引入**：那需要一张
   模型能力表，本阶段明确禁止手抄。`plan()` 接受 ceiling / reserve 作为参数，
   因此将来接上 provider-directory 的 capability 时只需换传入值，不必改本模块。

   谁能被压缩（不可丢 / 可压缩）：
     不可丢（本模块**永不**裁剪、永不丢弃）：system/persona 身份、当前用户消息、
     工具定义。它们只能被"计量并如实上报"，不能被静默改写。
     可压缩（按固定顺序逐级让位）：history → memory → moments → thread →
     activity → understanding。
   `plan()` 只产出"每个可压缩块保留多少比例"（0<fraction≤1），**不产出新的
   字符上限、也不重算任何 producer 的预算** —— 落地方式是对**已经被 producer
   限过一次的块**再按比例缩小，因此本模块永远只能让一个块更小，绝不会让它变大，
   也绝不会成为"第二套独立的截断器"（全仓仍然只有 producer 各自的 per-block 预算，
   本模块只拥有**总量**）。
   ==================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); }
  else { root.IBContextBudgetCore = factory(); }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var VERSION = 1;

  /* ── 应用级保守天花板（tokens，估算口径）────────────────────────────
     取值 64000 的理由（这是**应用级**决定，不是模型能力表）：
     它是当前主流托管 provider 里最小的常见输入窗口之一，因此"不超过它"
     对任何受支持模型都是安全的；而本阶段实测的全部现实组合都远低于它
     （normal 1,134 / 1000 条历史 1,142 / 2000 条记忆 2,125 / 最坏混合 23,791），
     所以这条天花板在正常使用中**不会触发**，只在病态配置（超长 persona /
     超长 summary / 无界注入器）下才起作用。
     provider 专属能力留作扩展点：改传入值即可，不改本模块。 */
  var APP_CEILING_TOKENS = 64000;
  var DEFAULT_OUTPUT_RESERVE_TOKENS = 8192;
  var MIN_OUTPUT_RESERVE_TOKENS = 1024;
  var MAX_OUTPUT_RESERVE_TOKENS = 16384;

  /* 不可丢的块：本模块对其只计量、不裁剪 */
  var NON_COMPRESSIBLE = ['system', 'current', 'tools'];
  /* 可压缩块的让位顺序（先让 history，最后才动 understanding）——这是
     "最小兼容策略"的落地顺序，作为本阶段冻结的默认策略，而不是产品结论。 */
  var LADDER = ['history', 'memory', 'moments', 'thread', 'activity', 'understanding'];
  /* 每一级最多缩到原量的多少（下限）：保证"压缩"不会退化成"整块消失"。
     history 的下限是"至少保留 1 条"（由调用方按条数取整保证）。 */
  var MIN_FRACTION = {
    history: 0.2, memory: 0.25, moments: 0.2, thread: 0.2, activity: 0.2, understanding: 0.2
  };

  function _num(v, d) {
    var n = Number(v);
    return isFinite(n) ? n : d;
  }

  /* ── 唯一的估算器（conservative）。等价于 communication.js 原 _cacheTok。 ── */
  function estimateTokens(text) {
    var s = (text == null) ? '' : String(text);
    var t = 0;
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      t += (c >= 0x4e00 && c <= 0x9fff) ? 1 : 0.33;
    }
    return Math.round(t);
  }

  /* 内容段的文本投影：与 _cacheSegText 同口径（图片/音频按占位符计，不按 base64 计）。
     这里刻意**不**把 base64 当真文本 —— 否则一张图会把预算算成几十万 token，
     得出"必须砍 persona"这种错误结论。图片体积是**另一个**边界（IMG_MAX_BYTES），
     不在本模块的输入 token 预算里。 */
  function contentText(c) {
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) {
      return c.map(function (p) {
        if (!p) return '';
        if (p.type === 'image' || p.type === 'image_url' || p.type === '_image') return '[img]';
        if (p.type === 'input_audio' || p.type === '_audio') return '[audio]';
        return p.text || '';
      }).join('');
    }
    return String(c == null ? '' : c);
  }

  /* 工具定义的文本投影：只算 name/description/parameters 的结构化文本 */
  function toolsText(tools) {
    if (!tools || !tools.length) return '';
    try { return JSON.stringify(tools); } catch (e) { return ''; }
  }

  /* ── 计量：一个已经组装好的请求 ──────────────────────────────────────
     messages 形如 [{role,content}]（与送 provider 的形状一致）。
     `currentIndex` 指向"当前用户消息"（不可丢）：缺省取最后一条 user。
     返回逐段 token 与总量；**只读，不改动入参**。 */
  function measure(messages, opts) {
    opts = opts || {};
    var list = Array.isArray(messages) ? messages : [];
    var tools = opts.tools || null;
    var currentIndex = (opts.currentIndex != null) ? Number(opts.currentIndex) : -1;
    if (currentIndex < 0) {
      for (var i = list.length - 1; i >= 0; i--) {
        if (list[i] && list[i].role === 'user') { currentIndex = i; break; }
      }
    }
    var parts = { system: 0, history: 0, injected: 0, current: 0, tools: 0 };
    var msgs = [];
    for (var j = 0; j < list.length; j++) {
      var m = list[j] || {};
      var tk = estimateTokens(contentText(m.content));
      var kind = (m.role === 'system') ? 'system' : (j === currentIndex ? 'current' : 'history');
      parts[kind] += tk;
      msgs.push({ index: j, role: String(m.role || ''), kind: kind, tokens: tk });
    }
    var inj = _num(opts.injectedTokens, 0);
    if (inj > 0) {
      /* 注入量不得多于当前消息本身（否则 current 会被算成负数）。
         本仓库的 tail（memory / moments / thread / understanding / activity /
         ws 注入）都拼在末条用户消息里；不单独扣出来的话，这些**可压缩**块会
         被算进"当前用户消息"这个**不可丢**的块，预算就永远压不动它们。 */
      inj = Math.min(inj, parts.current);
      parts.current -= inj;
      parts.injected = inj;
      /* 其中**梯子不得触碰**的部分（时间 / 日历 / 摘要 / Middle Brain 改写产物 /
         ws 注入）：它们仍算"不可丢"，只是不占用户自己那句话的额度。 */
      var other = _num(opts.injectedOtherTokens, 0);
      parts.injectedOther = Math.max(0, Math.min(other, inj));
      parts.injectedCompressible = inj - parts.injectedOther;
    }
    var toolsTokens = estimateTokens(toolsText(tools));
    parts.tools = toolsTokens;
    var inputTokens = parts.system + parts.history + parts.injected + parts.current + parts.tools;
    return {
      version: VERSION,
      inputTokens: inputTokens,
      parts: parts,
      messages: msgs,
      messageCount: list.length,
      currentIndex: currentIndex,
      toolsCount: (tools && tools.length) || 0,
      nonCompressibleTokens: parts.system + parts.current + parts.tools + parts.injectedOther,
      compressibleTokens: parts.history + parts.injectedCompressible
    };
  }

  function inputBudgetFor(opts) {
    opts = opts || {};
    var ceiling = _num(opts.ceiling, APP_CEILING_TOKENS);
    var reserve = _num(opts.reserve, DEFAULT_OUTPUT_RESERVE_TOKENS);
    if (reserve < MIN_OUTPUT_RESERVE_TOKENS) reserve = MIN_OUTPUT_RESERVE_TOKENS;
    if (reserve > MAX_OUTPUT_RESERVE_TOKENS) reserve = MAX_OUTPUT_RESERVE_TOKENS;
    return { ceiling: ceiling, reserve: reserve, inputBudget: Math.max(0, ceiling - reserve) };
  }

  /* ── 计划：超预算时每一级可压缩块保留多少比例 ─────────────────────────
     available = inputBudget − 不可丢部分的实测 token

     `irreducible` 的含义（**不是**"一点都压不动"，而是"本阶段认可的那套
     压缩梯子压不到预算之内"），两种成因：
       ① available <= 0：不可丢的部分（system/persona + 当前消息 + 工具定义）
          本身就已经超过 inputBudget。**只剩产品决策**（缩 persona / 减工具 /
          换模型）。
       ② 梯子各级都已经压到 MIN_FRACTION 下限，释放出的 maxSaving 仍小于 excess。
     两种成因下本模块**都不做任何裁剪**：既不动不可丢的块（规则不允许），
     也不为"仍然超标"的结果白白牺牲用户的可压缩上下文 —— 如实上报，让宿主
     把事实暴露出来，而不是把损失藏起来。
     能压到预算之内时，按 LADDER 顺序、各级等比缩放，系数 clamp 在
     MIN_FRACTION 之上，任何一级都不会被压到 0。 */

  /* 直接按"已知的块 token 数"规划 —— 宿主在 producer 运行**之前**也需要它：
     可压缩块的额度是 producer 自己的 per-block 上限（worst case），不是实测值。
     以 worst case 判定"不超预算"⟹ 真实情况必然不超，因此正常回合的
     keepFraction 恒为 1（见下方 sharedParts）。 */
  function planParts(input) {
    input = input || {};
    var b = inputBudgetFor(input);
    var system = _num(input.systemTokens, 0);
    var history = _num(input.historyTokens, 0);
    var current = _num(input.currentTokens, 0);
    var injectedOther = _num(input.injectedOtherTokens, 0);
    var tools = _num(input.toolsTokens, 0);
    var compressibleNow = {}, compressibleTotal = 0;
    for (var i = 0; i < LADDER.length; i++) {
      var name = LADDER[i];
      var v = _num(input[name + 'Tokens'], 0);
      compressibleNow[name] = v;
      compressibleTotal += v;
    }
    var nonCompressible = system + current + tools + injectedOther;
    var inputTokens = nonCompressible + history + compressibleTotal;
    var available = b.inputBudget - nonCompressible;
    var over = inputTokens > b.inputBudget;
    var reducible = Math.max(0, compressibleTotal);
    var maxSaving = 0;
    for (var k = 0; k < LADDER.length; k++) {
      maxSaving += compressibleNow[LADDER[k]] * (1 - MIN_FRACTION[LADDER[k]]);
    }
    var excess = over ? (inputTokens - b.inputBudget) : 0;
    var irreducible = over && (available <= 0 || maxSaving < excess);
    var ladder = [];
    if (over && !irreducible && reducible > 0) {
      /* 目标：把可压缩总量降到 max(0, available)；级间按现有占比等比缩放，
         但每一级不低于它的 MIN_FRACTION。 */
      var target = Math.max(0, Math.min(reducible, available));
      var scale = target / reducible;
      for (var q = 0; q < LADDER.length; q++) {
        var nm = LADDER[q];
        var now = compressibleNow[nm];
        if (now <= 0) continue;
        var f = Math.max(MIN_FRACTION[nm], Math.min(1, scale));
        if (f < 1) ladder.push({ part: nm, keepFraction: Math.round(f * 1000) / 1000, fromTokens: Math.round(now) });
      }
    }
    /* keepFraction 查表：未出现在 ladder 里的级恒为 1（= producer 原有额度） */
    var fractions = {};
    for (var r = 0; r < LADDER.length; r++) fractions[LADDER[r]] = 1;
    for (var s = 0; s < ladder.length; s++) fractions[ladder[s].part] = ladder[s].keepFraction;
    return {
      version: VERSION,
      ceiling: b.ceiling, reserve: b.reserve, inputBudget: b.inputBudget,
      inputTokens: Math.round(inputTokens),
      nonCompressibleTokens: nonCompressible,
      availableForCompressible: available,
      compressibleTokens: Math.round(compressibleTotal),
      over: over, excess: Math.round(excess),
      irreducible: irreducible,
      maxSavingTokens: Math.round(maxSaving),
      ladder: ladder,
      fractions: fractions,
      /* 只含计数与状态，绝不含正文（可安全写日志 / 遥测） */
      summary: {
        inputTokens: Math.round(inputTokens),
        inputBudget: b.inputBudget,
        over: over,
        irreducible: irreducible,
        parts: {
          system: system, history: history, current: current,
          injectedOther: injectedOther, tools: tools
        },
        compressible: compressibleNow,
        ladder: ladder.map(function (x) { return x.part + ':' + x.keepFraction; })
      }
    };
  }

  /* 实测版：从 measure() 的结果出发。opts.<part>Tokens 为该级的实测 token。 */
  function plan(m, opts) {
    opts = opts || {};
    var p = m && m.parts ? m.parts : {};
    var input = Object.assign({}, opts, {
      systemTokens: _num(p.system, 0),
      historyTokens: _num(p.history, 0),
      currentTokens: _num(p.current, 0),
      injectedOtherTokens: _num(p.injectedOther, 0),
      toolsTokens: _num(p.tools, 0)
    });
    /* 调用方申报的可压缩量不得超过**实测**的可压缩量：否则一个错误的申报就能
       把 available 算得比真实更宽，从而漏判超预算。超出时按比例回缩。 */
    var declared = 0;
    for (var i = 0; i < LADDER.length; i++) declared += _num(input[LADDER[i] + 'Tokens'], 0);
    var measuredCompressible = _num(m && m.compressibleTokens, 0);
    if (measuredCompressible >= 0 && declared > measuredCompressible && declared > 0) {
      var k = measuredCompressible / declared;
      for (var s = 0; s < LADDER.length; s++) {
        var nm = LADDER[s];
        input[nm + 'Tokens'] = _num(input[nm + 'Tokens'], 0) * k;
      }
    }
    return planParts(input);
  }

  /* 可压缩块名 → 该块在 tail 里的文本，供调用方按比例切片。
     只做"取前 N 分之一"：**不新增字符上限常量**，比例与文本长度相乘即可。 */
  function shrinkText(text, keepFraction) {
    var s = (text == null) ? '' : String(text);
    var f = _num(keepFraction, 1);
    if (!(f < 1)) return s;
    if (f <= 0) return '';
    var keep = Math.max(1, Math.floor(s.length * f));
    return s.slice(0, keep);
  }
  /* 历史：至少保留 1 条（当前用户消息不属于 history，不受此影响） */
  function keepMessageCount(count, keepFraction) {
    var n = Math.max(0, Math.floor(_num(count, 0)));
    var f = _num(keepFraction, 1);
    if (!(f < 1)) return n;
    return Math.max(1, Math.floor(n * f));
  }

  return {
    VERSION: VERSION,
    APP_CEILING_TOKENS: APP_CEILING_TOKENS,
    DEFAULT_OUTPUT_RESERVE_TOKENS: DEFAULT_OUTPUT_RESERVE_TOKENS,
    MIN_OUTPUT_RESERVE_TOKENS: MIN_OUTPUT_RESERVE_TOKENS,
    MAX_OUTPUT_RESERVE_TOKENS: MAX_OUTPUT_RESERVE_TOKENS,
    NON_COMPRESSIBLE: NON_COMPRESSIBLE,
    LADDER: LADDER,
    MIN_FRACTION: MIN_FRACTION,
    estimateTokens: estimateTokens,
    contentText: contentText,
    toolsText: toolsText,
    measure: measure,
    inputBudgetFor: inputBudgetFor,
    plan: plan,
    planParts: planParts,
    shrinkText: shrinkText,
    keepMessageCount: keepMessageCount
  };
});
