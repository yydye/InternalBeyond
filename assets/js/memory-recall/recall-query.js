/* ====================================================================
   IB Memory Recall · Deterministic Recall Query Construction
   runtime-neutral 纯函数（UMD dual-load）
   --------------------------------------------------------------------
   - Browser: <script src="assets/js/memory-recall/recall-query.js">
              → window.IBMemoryRecallQuery
   - Node   : require('../assets/js/memory-recall/recall-query.js')
   - 规则：零 window / 零 DOM / 零 IndexedDB / 零 localStorage / 零 fetch /
           零副作用 / 零定时器 / 零随机 / 零时钟 / 零 LLM / 纯函数。

   ── 目标：raw message → deterministic structured recall query ──────────
     去噪，**不是**语义推理。

     允许：Unicode NFKC / trim / 折叠空白 / 去明确 recall boilerplate /
           去纯礼貌填充前缀 / 提取时间提示 / 提取显式 surface entities /
           lexical tokenize。
     禁止：LLM rewrite / 语义改写 / 模型补全 / embedding / 网络词典 / DB 查询。

     反例（写进代码以钉住这条边界）：输入
       "对了，你还记得去年我们说那个显卡的事情吗？"
     不得产出任何模型脑补出来的东西（例如 "本地部署 GPU 购买方案"）——
     原句没明确说，query 就不能有。

   ── lexicalTerms 复用既有唯一实现（契约 §9 纪律）──────────────────────
     lexicalTerms 由 **memory-retrieval-core.js 的 extractKeywords()** 产出，
     本模块不复制第二套中文 n-gram 逻辑。

     该 core 已经导出 extractKeywords（生产 UMD 的公开面），因此这里的做法是
     **依赖注入**：Node 侧顶层 require 该 core；Browser 侧读全局。若 core 不可用，
     lexicalTerms 返回 [] 而**不是**回落到一份本地 n-gram 实现 ——
     宁可少一个字段，也不制造第二套会漂移的长期实现。

   ── 与契约的关系 ──────────────────────────────────────────────────
     docs/contracts/memory/MEMORY_RECALL_CONTRACT.md §13：query 必须能表达
     lexicalTerms / entities / temporalHints / aliases 四类。本模块即其生产形状。
     §16：本模块不写死任何 Recall product budget；MAX_QUERY_INPUT_CHARS 是
     实现安全上限，不是产品语义。

   ── R2-B 的接线状态：implemented but unwired ────────────────────────
     本文件没有任何生产调用方；不加入 InternalBeyond.html；不被 memory.js /
     communication.js / home-node-bootstrap.js / memory-retrieval.js 引用。
   ==================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    /* Node：复用**同一份** shared core，不复制 n-gram 逻辑。 */
    var core = null;
    try { core = require('../memory-retrieval-core.js'); } catch (e) { core = null; }
    module.exports = factory(core);
  } else {
    root.IBMemoryRecallQuery = factory(root.IBMemoryRetrievalCore || null);
  }
})(typeof self !== 'undefined' ? self : this, function (CORE) {
  'use strict';

  /* ── 0. 实现安全上限（**不是** Recall product budget）────────────────
     Contract §16 只冻结形状，不冻结数值，因此这些常量不进 canonical contract。
     它们的作用是让 10MB 输入不会生成海量中间产物；截断是确定性的。 */
  var MAX_QUERY_INPUT_CHARS = 10000;
  var MAX_LEXICAL_INPUT_CHARS = 4000;
  var MAX_ENTITIES = 50;
  var MAX_TEMPORAL_HINTS = 50;
  var MAX_ALIAS_ENTRIES = 200;
  var MAX_ALIAS_CHARS = 100;
  var MAX_TEMPORAL_TOKEN_CHARS = 32;

  /* ── 1. 归一化 ────────────────────────────────────────────────────── */
  var ZERO_WIDTH_RE = /[\u200B-\u200D\u2060\uFEFF]/g;
  var CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

  function normalizeText(value) {
    if (value == null || typeof value !== 'string') return '';
    var text = value;
    try { text = text.normalize('NFKC'); } catch (e) { /* 旧引擎：保持原样 */ }
    text = text.replace(ZERO_WIDTH_RE, '').replace(CONTROL_RE, '');
    text = text.replace(/\s+/g, ' ').trim();
    if (text.length > MAX_QUERY_INPUT_CHARS) text = text.slice(0, MAX_QUERY_INPUT_CHARS);
    return text;
  }

  /* ── 2. 保护段（显式引用 / 字面 URL / 邮箱）──────────────────────────
     "你还记得《上次的战争》吗？" —— 书名号里的"上次"是**实体的一部分**，
     绝不能被 boilerplate stripping 破坏。因此先定位保护段，
     stripping 与 entity 提取都以它为边界。 */
  var PROTECTED_SPAN_RE = new RegExp([
    '《[^》]{1,500}》',
    '「[^」]{1,500}」',
    '『[^』]{1,500}』',
    '“[^”]{1,500}”',
    '‘[^’]{1,500}’',
    '"[^"\\n]{1,500}"',
    '\'[^\'\\n]{1,500}\'',
    '\\[[^\\]]{1,500}\\]',
    'https?://\\S+',
    '[A-Za-z0-9._%+\\-]+@[A-Za-z0-9.\\-]+\\.[A-Za-z]{2,}'
  ].join('|'), 'g');

  function findProtectedSpans(text) {
    var spans = [];
    PROTECTED_SPAN_RE.lastIndex = 0;
    var m;
    while ((m = PROTECTED_SPAN_RE.exec(text)) !== null) {
      spans.push({ start: m.index, end: m.index + m[0].length });
      if (spans.length >= 200) break;
      if (m[0].length === 0) PROTECTED_SPAN_RE.lastIndex++;
    }
    return spans;
  }

  function overlapsAny(spans, start, end) {
    for (var i = 0; i < spans.length; i++) {
      if (start < spans[i].end && end > spans[i].start) return true;
    }
    return false;
  }

  /* ── 3. Recall boilerplate stripping ────────────────────────────────
     只移除**明确无检索价值的 recall 话术与纯礼貌前缀**。
     保守优先：长模式先于短模式；落在保护段内的匹配一律跳过；
     孤立的时间词（去年 / 上次 …）**保留**在 lexicalText 里 ——
     它们承载检索价值（时间提示已单独结构化输出），不属于"话术"。 */
  var STRIP_PATTERNS = [
    /* 3.1 英文 recall 话术（大小写不敏感） */
    'do you remember', 'we talked about', 'talked about',
    'last time', 'previously', 'remember',
    /* 3.2 中文 recall 话术（长 → 短） */
    '你还记得吗', '你还记得', '你还记不记得',
    '还记得吗', '还记得',
    '你记得吗', '你记得',
    '我们不是说过', '你不是说过', '我不是说过',
    '之前我们说过', '之前我们聊过', '之前说过', '之前聊过',
    '以前我们说过', '以前说过',
    '当时我们说过', '当时我们',
    '我们说过的', '我们说过的那个', '我们说',
    /* 3.3 纯礼貌 / 填充前缀（只在**开头**剥离） */
    '哦对了', '对了', '话说', '说起来'
  ];
  var STRIP_RE = new RegExp(STRIP_PATTERNS.map(function (p) {
    return p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }).join('|'), 'gi');
  var LEADING_FILLER_RE = /^\s*(?:哦对了|对了|话说|说起来)\s*[，,、.。!！?？~～]?\s*/;
  /* boilerplate 删除后常留下孤立的连接标点（"对了，…" 去掉后剩一个逗号）。
     只清理**前导**标点与**重复**标点，不碰结尾问号 —— 后者属于原文语气，
     且不影响 lexical 提取。 */
  var LEADING_PUNCT_RE = /^[\s,，、.。;；:：]+/;
  var REPEATED_COMMA_RE = /[,，、]{2,}/g;      /* NFKC 之后半角/全角都可能出现 */
  var REPEATED_STOP_RE = /[.。]{2,}/g;

  function stripBoilerplate(text, spans) {
    var out = '';
    var last = 0;
    STRIP_RE.lastIndex = 0;
    var m;
    while ((m = STRIP_RE.exec(text)) !== null) {
      if (m[0].length === 0) { STRIP_RE.lastIndex++; continue; }
      var start = m.index, end = m.index + m[0].length;
      if (overlapsAny(spans, start, end)) continue;
      out += text.slice(last, start);
      last = end;
    }
    out += text.slice(last);
    /* 前缀填充词单独处理一遍：它需要吃掉尾随标点，而通用删除会留下孤立的 "，" */
    out = out.replace(LEADING_FILLER_RE, '');
    out = out.replace(REPEATED_COMMA_RE, '\uFF0C').replace(REPEATED_STOP_RE, '\u3002');
    out = out.replace(LEADING_PUNCT_RE, '');
    return out.replace(/\s+/g, ' ').trim();
  }

  /* ── 4. Entity 提取（**explicit surface entities**，不是 NER）─────────
     只提取高确定性表面形式。中文普通人名一律**不猜** —— "显卡" 不是 entity
     也没关系，它仍然会进入 lexicalTerms。 */
  /* 引号/书名号实体：CJK 书名号、角括号与弯引号 + ASCII 直引号与单引号。
     上限 500 而不是 120 —— 引号里的内容可能是整句话。
     注意：PROTECTED_SPAN_RE 也要覆盖同一批定界符，否则"保护了但不提取"
     会出现两边不一致。 */
  var CJK_BRACKET_ENTITY_RE = /《[^》]{1,500}》|「[^」]{1,500}」|『[^』]{1,500}』|“[^”]{1,500}”|‘[^’]{1,500}’|"[^"\n]{1,500}"|'[^'\n]{1,500}'/g;
  var HANDLE_RE = /[@#][A-Za-z0-9_\u4e00-\u9fff]{1,64}/g;
  /* identifier-like：必须满足下列**之一**才被接受（见 looksLikeIdentifier）：
       ① 含下划线 / 连字符                      → memory_records / P21-R2
       ② 数字与字母同现                          → GPT-5 / Qwen3 / v1
       ③ 整体大写缩写（≥2 字符）                 → RTX / GPU
       ④ 驼峰（≥2 个大写）                       → InternalBeyond
     刻意**不**做"通用英文单词"判定：普通小写词（understand）不是标识符。

     ── 版本点号（P21-R2-B.1）────────────────────────────────────────────
     dot 只在**连接数字段**时属于 identifier：
         \.\d+          版本点号，且点后必须是数字
         (?![A-Za-z0-9_])  其后不得再跟词字符（挡住 "v1.0.7x" 这类越界吞并）
     「数字 "." 数字」因此被支持（5.6 / 5.3 / 3.8 / 2.5 / 1.0.7），
     而域名与文件名被结构性排除 —— 它们的点**连接的是字母**：
         example.com → ".com" 不匹配 \.\d+，主匹配止于 "example"
         README.md   → ".md"  不匹配 \.\d+，主匹配止于 "README"
     然后再由 token 边界把 "example" / "README" 整体丢弃（它们是完整词，
     不是被截断的标识符片段）。这条规则是确定性的，没有域名/URL 解析器。 */
  var IDENTIFIER_RE = /[A-Za-z][A-Za-z0-9]*(?:[-_][A-Za-z0-9]+|\.\d+)*(?![A-Za-z0-9_])|[\u4e00-\u9fffA-Za-z0-9_]*_[A-Za-z0-9_]+/g;

  /* 硬件 / 型号 pattern（保守，**不是**通用 NER，也不是硬件词典）：
     全大写型号前缀 + 空白 + 数字型号 + 可选短后缀。
     目的：让 "RTX 5070 Ti" 作为一个稳定 surface entity 出现，
     而不是三个互不相关的碎片（RTX / 5070 / Ti）。
     刻意只认"全大写词 + 数字"，不做产品名识别。 */
  var HARDWARE_RE = /\b[A-Z][A-Z0-9]{1,9}\s+\d{2,5}(?:\s+[A-Z][A-Za-z0-9]{1,5})?\b/g;

  function looksLikeIdentifier(token) {
    if (!token || token.length < 2) return false;
    if (token.indexOf('_') >= 0) return true;
    if (token.indexOf('-') >= 0) return true;
    if (/\d/.test(token) && /[A-Za-z]/.test(token)) return true;
    if (/^\p{Lu}[\p{Lu}\p{Lt}]{1,}$/u.test(token)) return true;
    /* 驼峰：至少两个大写字母，且不在开头（InternalBeyond）。
       纯小写长单词（understand）不算 —— 那是普通英文词，不是标识符。 */
    var uppers = (token.match(/\p{Lu}/gu) || []).length;
    if (uppers >= 2) return true;
    return false;
  }

  function extractEntities(text) {
    var found = [];
    function push(kind, raw, index) {
      if (!raw) return;
      if (found.length >= MAX_ENTITIES * 4) return;
      found.push({ kind: kind, raw: raw, index: index });
    }
    var m;
    CJK_BRACKET_ENTITY_RE.lastIndex = 0;
    while ((m = CJK_BRACKET_ENTITY_RE.exec(text)) !== null) push('quoted', m[0], m.index);
    HANDLE_RE.lastIndex = 0;
    while ((m = HANDLE_RE.exec(text)) !== null) {
      /* '@' 只在**不是** email 局部部分时才算 mention：
         "user@example.com" 里的 '@' 前面是词字符 ⇒ 属于 email（同时它已被
         PROTECTED_SPAN_RE 覆盖），不得再冒出一个 "@example"。
         行首/空格前的 "@alice" 正常命中。
         '#' 不受此限制（"a#b" 不是常见的地址结构）。 */
      if (m[0].charAt(0) === '@' && isWordishChar(text.charAt(m.index - 1))) continue;
      push('handle', m[0], m.index);
    }
    /* 硬件型号先于通用 identifier 提取：这样 "RTX 5070 Ti" 是一个实体，
       而不是三个碎片。重叠消解（下方）保证同一片段不会被计两次。 */
    HARDWARE_RE.lastIndex = 0;
    while ((m = HARDWARE_RE.exec(text)) !== null) push('identifier', m[0], m.index);
    IDENTIFIER_RE.lastIndex = 0;
    while ((m = IDENTIFIER_RE.exec(text)) !== null) {
      if (!looksLikeIdentifier(m[0])) continue;
      /* token 边界：命中两侧不得再是词字符，且**右侧不得是点号**。
         右侧的点号检查是域名/文件名的最后一道闸：
           "README.md" → 主匹配止于 "README"，其后是 '.' ⇒ 整体丢弃
           "example.com" → 同理丢弃 "example"
           "GPT-5.6"   → 主匹配吸到 "GPT-5.6"（\.\d+ 消费了 ".6"）⇒ 通过
         没有这道闸，"README.md" 会留下一个被截断的 "README" 实体。 */
      if (isWordishChar(text.charAt(m.index - 1))) continue;
      if (isWordishChar(text.charAt(m.index + m[0].length))) continue;
      if (text.charAt(m.index + m[0].length) === '.') continue;
      if (/^\d+$/.test(m[0])) continue;           /* 纯数字交给 temporal，不做 entity */
      if (/\d{4}[-/]\d{1,2}[-/]\d{1,2}/.test(m[0])) continue; /* 日期不是 entity */
      push('identifier', m[0], m.index);
    }
    /* 排序：位置优先；同位置**长实体优先**（更具体者胜出）。 */
    found.sort(function (a, b) {
      if (a.index !== b.index) return a.index - b.index;
      return b.raw.length - a.raw.length;
    });
    /* 重叠消解：贪婪接受，丢弃**完全落在已接受实体之内**的匹配。
       没有这一步，"RTX 5070 Ti" 之后还会再冒出 "RTX" 与 "5070" 两个碎片 ——
       那不是三个实体，是一个实体被拆开计数。 */
    var accepted = [];
    var seen = {};
    for (var i = 0; i < found.length && accepted.length < MAX_ENTITIES; i++) {
      var cand = found[i];
      var key = cand.kind + '\u0000' + cand.raw;
      if (seen[key]) continue;
      var contained = false;
      for (var k = 0; k < accepted.length; k++) {
        if (cand.index >= accepted[k].index
          && cand.index + cand.raw.length <= accepted[k].index + accepted[k].raw.length) {
          contained = true; break;
        }
      }
      if (contained) continue;
      seen[key] = 1;
      accepted.push(cand);
    }
    accepted.sort(function (a, b) { return a.index - b.index; });
    return accepted.map(function (h) {
      return { kind: h.kind, raw: h.raw, index: h.index };
    });
  }

  /* ── 5. Temporal hint 提取 ──────────────────────────────────────────
     R2-B **只提取 hint**，不把"去年"解析成具体 timestamp range（契约 §12）。
     范围解析以后由 channel / query policy 决定。 */
  var ABSOLUTE_DATE_RES = [
    { re: /\d{4}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日/g, kind: 'absolute' },
    { re: /\d{4}\s*年\s*\d{1,2}\s*月/g, kind: 'absolute' },
    { re: /\d{4}[-/]\d{1,2}[-/]\d{1,2}/g, kind: 'absolute' },
    { re: /\d{4}\s*年/g, kind: 'absolute' },
    { re: /\d{1,2}\s*月\s*\d{1,2}\s*日/g, kind: 'absolute' }
  ];
  var RELATIVE_WORDS = [
    '今天', '昨天', '前天', '明天', '后天',
    '上周', '这周', '本周', '下周',
    '上个月', '这个月', '本月', '下个月',
    '去年', '今年', '明年', '前年',
    '刚才', '刚刚', '最近', '后来', '当初'
  ];
  var QUANTITY_RELATIVE_RE = /(?:[0-9]{1,3}|[一二两三四五六七八九十百]{1,3})\s*(?:秒|分钟|小时|天|日|周|星期|个?月|年)\s*(?:前|以前|之前)/g;
  var EVENT_CUES = ['上次', '那次', '当时'];

  function extractTemporalHints(text) {
    var found = [];
    function push(kind, raw, index) {
      if (!raw || raw.length > MAX_TEMPORAL_TOKEN_CHARS) return;
      found.push({ kind: kind, raw: raw, index: index });
    }
    var i, m;
    for (i = 0; i < ABSOLUTE_DATE_RES.length; i++) {
      var spec = ABSOLUTE_DATE_RES[i];
      spec.re.lastIndex = 0;
      while ((m = spec.re.exec(text)) !== null) push(spec.kind, m[0], m.index);
    }
    QUANTITY_RELATIVE_RE.lastIndex = 0;
    while ((m = QUANTITY_RELATIVE_RE.exec(text)) !== null) push('quantity-relative', m[0], m.index);
    for (i = 0; i < RELATIVE_WORDS.length; i++) {
      var w = RELATIVE_WORDS[i];
      var idx = text.indexOf(w);
      if (idx >= 0) push('relative', w, idx);
    }
    for (i = 0; i < EVENT_CUES.length; i++) {
      var c = EVENT_CUES[i];
      var ci = text.indexOf(c);
      if (ci >= 0) push('event', c, ci);
    }
    found.sort(function (a, b) {
      if (a.index !== b.index) return a.index - b.index;
      return b.raw.length - a.raw.length;   /* 同位置：长 token 优先（更具体） */
    });
    /* 包含过滤：贪婪地从左到右接受，丢弃**完全落在已接受 token 之内**的匹配。
       没有这一步，"2026年9月28日" 会同时产出自身与内部的 "9月28日" ——
       那不是两个时间提示，是一个提示被重复计数。
       排序保证了同位置的更长 token 先被接受。 */
    var accepted = [];
    var seen = {};
    for (i = 0; i < found.length; i++) {
      if (accepted.length >= MAX_TEMPORAL_HINTS) break;
      var cand = found[i];
      if (seen[cand.index]) continue;
      var contained = false;
      for (var k = 0; k < accepted.length; k++) {
        if (cand.index >= accepted[k].index
          && cand.index + cand.raw.length <= accepted[k].index + accepted[k].raw.length) {
          contained = true; break;
        }
      }
      if (contained) continue;
      seen[cand.index] = 1;
      accepted.push(cand);
    }
    accepted.sort(function (a, b) { return a.index - b.index; });
    return accepted.map(function (h) {
      return { kind: h.kind, raw: h.raw, index: h.index };
    });
  }

  /* ── 6. Aliases ─────────────────────────────────────────────────────
     R2-A 已冻结 aliases 概念，但**写入侧尚未定义**。因此 R2-B 明确：
       · 不查 DB、不修改 MemoryRecord、不新增 alias store、不猜 alias；
       · 只回答"当前文本是否命中了**调用方提供**的 alias"；
       · alias target **不注入** lexicalText —— 如何使用由后续 glossary channel 决定。
     入参为纯数据（字符串数组，或 {alias, target} 对象数组）。 */
  function normalizeAliasEntries(input) {
    if (!Array.isArray(input)) return [];
    var out = [];
    for (var i = 0; i < input.length && out.length < MAX_ALIAS_ENTRIES; i++) {
      var entry = input[i];
      var alias = '';
      var target = null;
      if (typeof entry === 'string') {
        alias = entry;
      } else if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
        if (typeof entry.alias === 'string') alias = entry.alias;
        if (typeof entry.target === 'string') target = entry.target;
      } else {
        continue;
      }
      alias = normalizeText(alias);
      if (!alias || alias.length > MAX_ALIAS_CHARS) continue;
      if (target != null && target.length > MAX_ALIAS_CHARS) target = target.slice(0, MAX_ALIAS_CHARS);
      out.push({ alias: alias, target: target });
    }
    return out;
  }

  function isWordishChar(ch) {
    if (!ch) return false;
    if (/[A-Za-z0-9_]/.test(ch)) return true;
    return /[^\u0000-\u007F]/.test(ch);   /* 非 ASCII（含 CJK）按"词内字符"保守处理 */
  }

  function matchAliases(normalized, entries, spans) {
    var protectedSpans = Array.isArray(spans) ? spans : [];
    var hits = [];
    var used = {};
    for (var i = 0; i < entries.length; i++) {
      var alias = entries[i].alias;
      var idx = normalized.indexOf(alias);
      if (idx < 0) continue;
      /* ASCII 边界：避免 "test" 命中 "testing"。
         CJK 无词边界，因此只对以 ASCII 词字符开头/结尾的 alias 施加边界检查。 */
      if (/^[A-Za-z0-9_]/.test(alias) && isWordishChar(normalized.charAt(idx - 1))) continue;
      var endPos = idx + alias.length;
      if (/[A-Za-z0-9_]$/.test(alias) && isWordishChar(normalized.charAt(endPos))) continue;
      if (used[alias]) continue;   /* 同一 alias 只返回首次出现 */
      used[alias] = 1;
      hits.push({
        alias: alias,
        target: entries[i].target,
        matched: true,
        matchedText: normalized.slice(idx, endPos),
        index: idx,
        /* quoted：命中落在保护段（书名号/引号/…）之内。
           这对 glossary channel 有实际价值 —— 显式引用与顺带提及不是同一件事。
           本模块只**如实标记**，不据此改变任何匹配结果。 */
        quoted: overlapsAny(protectedSpans, idx, endPos)
      });
      if (hits.length >= MAX_ALIAS_ENTRIES) break;
    }
    hits.sort(function (a, b) { return a.index - b.index; });
    return hits;
  }

  /* ── 7. 主入口 ────────────────────────────────────────────────────── */
  function buildRecallQuery(message, options) {
    var opts = (options && typeof options === 'object' && !Array.isArray(options)) ? options : {};
    var rawText = (typeof message === 'string') ? message : '';
    var normalized = normalizeText(rawText);

    var spans = findProtectedSpans(normalized);
    var lexicalRaw = stripBoilerplate(normalized, spans);
    var lexicalText = lexicalRaw.length > MAX_LEXICAL_INPUT_CHARS
      ? lexicalRaw.slice(0, MAX_LEXICAL_INPUT_CHARS).trim()
      : lexicalRaw;

    var lexicalTerms = [];
    if (CORE && typeof CORE.extractKeywords === 'function' && lexicalText) {
      try { lexicalTerms = CORE.extractKeywords(lexicalText); } catch (e) { lexicalTerms = []; }
    }

    return {
      rawText: rawText,
      normalizedText: normalized,
      lexicalText: lexicalText,
      lexicalTerms: lexicalTerms,
      entities: extractEntities(normalized),
      temporalHints: extractTemporalHints(normalized),
      aliases: matchAliases(normalized, normalizeAliasEntries(opts.aliases), spans)
    };
  }

  return {
    buildRecallQuery: buildRecallQuery,
    /* 单独导出，便于钉住 normalization / stripping / 提取规则本身 */
    normalizeText: normalizeText,
    stripBoilerplate: stripBoilerplate,
    findProtectedSpans: findProtectedSpans,
    extractEntities: extractEntities,
    extractTemporalHints: extractTemporalHints,
    matchAliases: matchAliases,
    normalizeAliasEntries: normalizeAliasEntries,
    MAX_QUERY_INPUT_CHARS: MAX_QUERY_INPUT_CHARS,
    MAX_LEXICAL_INPUT_CHARS: MAX_LEXICAL_INPUT_CHARS,
    MAX_ENTITIES: MAX_ENTITIES,
    MAX_TEMPORAL_HINTS: MAX_TEMPORAL_HINTS,
    MAX_ALIAS_ENTRIES: MAX_ALIAS_ENTRIES,
    /* coreAvailable 如实暴露"是否复用到唯一 lexical 实现"：
       false 时 lexicalTerms 恒为 []，测试据此判定是"复用成功"还是"降级"。 */
    coreAvailable: !!(CORE && typeof CORE.extractKeywords === 'function'),
    STRIP_PATTERNS: STRIP_PATTERNS.slice(),
    RELATIVE_WORDS: RELATIVE_WORDS.slice(),
    EVENT_CUES: EVENT_CUES.slice()
  };
});
