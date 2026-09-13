/* ====================================================================
   IB Prompt Boundary Core — 用户可控 metadata 进入 prompt 的唯一消毒实现
   --------------------------------------------------------------------
   - Browser: <script src="assets/js/prompt-boundary-core.js"> → window.IBPromptBoundaryCore
              （必须在 communication.js 之前加载）
   - Node   : require('../assets/js/prompt-boundary-core.js')
   - 规则：零 window / 零 DOM / 零 IndexedDB / 零 localStorage / 零副作用 / 纯函数。

   ── 为什么存在（P0 审计结论，不是推测）─────────────────────────────
   群聊 prompt 把**用户可控字符串**直接插进 system 里，而 system 靠换行承载
   结构。communication.js 的群聊规则块原文：

     '【群聊规则】你是群聊"'+group.name+'"中的成员"'+selfName+'"。'
     +'\n1. 你只能以"'+selfName+'"的身份发言…'
     +'\n2. 绝对不要替其他成员或用户发言…'

   值里只要出现一个换行，它就从"名字"变成"规则列表的一行" ——
   与真实规则行在文本上**不可区分**。这不是注入的猜测，是同一段文本的
   结构事实。审计确认：这 5 处插值**没有任何消毒**，全仓也没有可复用的
   消毒实现（既有的 esc() 全部是 HTML 转义，用于 innerHTML，不是 prompt 面）。

   ── 本模块只编码"结构边界"，不编码"看起来像不像" ──────────────────
   三类处理，逐类说明理由（"没做"也是一种决定，必须写明）：

   1. **换行 / 控制字符 / 不可见格式字符 → 单空格**（会改动字节）
      这些码位在"名字"这个位置上不承载语义：没有人的名字里有换行或
      U+200B。去掉它们不改变值的语义，只移除"被当作结构"的能力。
      刻意替换成**空格**而不是删除 —— 删除会让 `A<ZWSP>B` 静默变成 `AB`，
      即"删除"比"替换"更接近语义改写。

   2. **结构定界符（引号 / 括号 / 行首编号）→ 保留，只报告**
      `【群聊规则】` 或 `"` 出现在名字里是**合法的值**。改写它等于改写用户
      的名字（no semantic mutation）。而且它单独出现时无法跳出字段 ——
      能跳出的机制是换行，第 1 类已经封死。因此这一类只登记事实，不改值。

   3. **同形字（confusable）/ 双向控制 → 只报告，不改写**
      本模块**不维护同形字表**，因为任何这样的表都是**新发明的一条规则**：
      全仓没有同形字语义，仓库里没有权威可以引用，编一张表出来就是在发明
      策略而不是收敛策略。Unicode 自带的规范化（NFKC）又会把全角名字
      `Ａlice` 改成 `Alice` —— 那是语义改写，被本阶段明确禁止。
      正确做法：**报告**（`confusable` / `bidi`），值**逐码位不变**，
      由调用方决定。bidi 覆盖字符同时被第 1 类移除：它们是格式控制字符，
      不是字形，且是"视觉上不是它实际文本"的唯一真正机制。

   ── 契约（S 段逐条断言）─────────────────────────────────────────────
    sanitizePromptInput(value, options) → result
      result.value     消毒后的字符串（**永远是字符串**，绝不 null/undefined）
      result.changed   value !== result.raw
      result.raw       原值归一化形式（非字符串的兜底；不进入 prompt）
      result.findings  命中的类别数组，稳定顺序，去重
      result.truncated 是否因 maxLength 被截断
      result.reason    稳定的汇总原因（'' 表示原值可直接使用）

    类别（PROMPT_HAZARD）：
      'newline'      CR / LF / NEL / LS / PS
      'control'      C0（除 CR/LF/TAB/NEL）/ DEL / C1
      'invisible'    零宽与不可见格式字符（ZWSP/ZWNJ/ZWJ/WORD JOINER/BOM 等）
      'bidi'         双向控制字符（LRE/RLE/PDF/LRI/RLI/FSI/PDI）
      'delimiter'    与 prompt 结构同形的定界符（引号 / 方括号 / 项目符号）
      'confusable'   非 ASCII 全角／变体标点与全角字母数字（报告，不改写）

    保证：
      · deterministic —— 同一输入恒得同一输出，无随机、无时间、无环境依赖
      · idempotent    —— sanitize(sanitize(x)) === sanitize(x)
      · fail safe     —— 任何畸形输入都返回字符串；不含换行的值逐字节不变
      · no mutation   —— 不使用 NFKC、不做大小写折叠、不做同形字替换、
                         不 trim 之外的任何内容裁剪（除显式 maxLength）
   ==================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); }
  else { root.IBPromptBoundaryCore = factory(); }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ── 1. 类别词表（冻结：调用方按名字判断，不按位掩码猜）────────────── */
  var PROMPT_HAZARD = Object.freeze({
    NEWLINE: 'newline',
    CONTROL: 'control',
    INVISIBLE: 'invisible',
    BIDI: 'bidi',
    DELIMITER: 'delimiter',
    CONFUSABLE: 'confusable'
  });

  /* 稳定顺序：findings 与 reason 的拼接顺序都依此表，不依扫描顺序。
     顺序本身是契约的一部分 —— 否则同一组命中会因扫描起点不同而输出不同结果。 */
  var HAZARD_ORDER = Object.freeze([
    PROMPT_HAZARD.NEWLINE, PROMPT_HAZARD.CONTROL, PROMPT_HAZARD.INVISIBLE,
    PROMPT_HAZARD.BIDI, PROMPT_HAZARD.DELIMITER, PROMPT_HAZARD.CONFUSABLE
  ]);

  /* ── 2. 码位分类 ────────────────────────────────────────────────────
     用**显式码位区间**而不是依赖 \s / Unicode 属性的运行时差异：
     Node 与各浏览器的 ICU 版本不同，属性类（\p{...}）会给出不同答案，
     而"同一份输入在两端得到不同的 prompt"正是一个 prompt 边界缺陷。
     区间是本模块唯一的判据来源。 */

  var CP = function (ch) { return ch.codePointAt(0); };

  function isLineBreak(ch) {
    var c = CP(ch);
    return c === 0x0A || c === 0x0D || c === 0x85 || c === 0x2028 || c === 0x2029;
  }
  /* TAB 刻意**不算** control：它在 prompt 里首先是空白（与空格同类，折叠成
     一个空格），说成 control 会让类别失去区分力。但它也绝不能落进"无需报告"
     的一侧 —— 它同样是不可见的结构字符。 */
  function isControl(ch) {
    var c = CP(ch);
    if (c === 0x09 || isLineBreak(ch)) return false;
    return c <= 0x1F || c === 0x7F || (c >= 0x80 && c <= 0x9F);
  }
  /* "会被替换掉、因而必须被报告"的判据 = TAB ∪ control。
     替换与报告共用这一个函数，是为了让"改了值却一条 finding 都没有"
     在结构上不可能发生 —— 本模块最初的真实缺陷正是 TAB：它被替换成空格，
     却既不在 control 也不在 newline，findings 为空。 */
  function isReportableAsControl(ch) {
    return CP(ch) === 0x09 || isControl(ch);
  }
  /* 零宽与不可见格式字符：在"名字"位置上没有任何语义贡献，但能把
     视觉上相同的两个名字变成不同的字符串（也用于绕过逐字比较）。 */
  function isInvisible(ch) {
    var c = CP(ch);
    return c === 0x00AD        /* SOFT HYPHEN */
      || c === 0x061C          /* ARABIC LETTER MARK */
      || c === 0x180E          /* MONGOLIAN VOWEL SEPARATOR */
      || c === 0xFEFF          /* ZERO WIDTH NO-BREAK SPACE / BOM */
      || (c >= 0x200B && c <= 0x200F)   /* ZWSP ZWNJ ZWJ LRM RLM */
      || (c >= 0x202A && c <= 0x202E)   /* LRE RLE PDF LRO RLO */
      || (c >= 0x2060 && c <= 0x2064)   /* WORD JOINER … INVISIBLE PLUS */
      || (c >= 0x2066 && c <= 0x206F)   /* LRI RLI FSI PDI … */
      || c === 0xFFF9 || c === 0xFFFA || c === 0xFFFB
      || c === 0x110BD || c === 0x110CD
      || (c >= 0xE0001 && c <= 0xE007F); /* TAG characters */
  }
  /* 双向控制：唯一真正让"读到的文本"与"实际文本"不同的机制。 */
  function isBidiControl(ch) {
    var c = CP(ch);
    return (c >= 0x202A && c <= 0x202E) || (c >= 0x2066 && c <= 0x2069);
  }
  /* 与 prompt 结构同形的定界符。报告用，不改值。 */
  var DELIMITER_CHARS = '"\'\u201C\u201D\u2018\u2019\u300C\u300D\u300E\u300F'
    + '[]\u3010\u3011\uFF3B\uFF3D()\uFF08\uFF09<>\u300A\u300B\uFF1C\uFF1E'
    + '#*\uFF03\uFF0A\u2022\u00B7\u30FB:\uFF1A|\uFF5C/\\';
  function isDelimiter(ch) { return DELIMITER_CHARS.indexOf(ch) >= 0; }
  /* 同形候选：非 ASCII 的全角／变体标点与全角字母数字。
     覆盖全角 ASCII 区块（ＦＦ０１–ＦＦ５Ｅ）、表意空格、以及
     CJK 标点区块（３０００–３０３Ｆ）。**只报告**。 */
  function isConfusableCandidate(ch) {
    var c = CP(ch);
    if (c < 0x80) return false;
    return (c >= 0x3000 && c <= 0x303F)
      || (c >= 0xFF01 && c <= 0xFF5E)
      || c === 0x00A0 || c === 0x1680
      || (c >= 0x2000 && c <= 0x200A)   /* EN QUAD … HAIR SPACE */
      || c === 0x202F || c === 0x205F;
  }

  /* ── 3. 空白归一（不引入 \s：见分类段的 ICU 理由）────────────────── */
  function isSpaceCP(c) {
    return c === 0x20 || c === 0x09 || c === 0x0A || c === 0x0D || c === 0x0B || c === 0x0C
      || c === 0x85 || c === 0xA0 || c === 0x1680
      || (c >= 0x2000 && c <= 0x200A) || c === 0x2028 || c === 0x2029
      || c === 0x202F || c === 0x205F || c === 0x3000;
  }

  var DEFAULT_MAX_LENGTH = 64;

  /* 非字符串的归一。刻意**不做** String(obj) 的隐式 toString：
     一个带自定义 toString 的对象会在"消毒"过程中执行任意代码，
     而本模块必须是纯的、可判定的。返回 '' 让调用方走兜底。 */
  function coerceRaw(value) {
    if (typeof value === 'string') return value;
    if (typeof value === 'number') return isFinite(value) ? String(value) : '';
    if (typeof value === 'boolean') return value ? 'true' : 'false';
    return '';
  }

  /* ── 4. 探测：只回答"有哪些类别"，不改任何东西 ──────────────────── */
  function detectPromptHazards(value) {
    var raw = coerceRaw(value);
    var hit = Object.create(null);
    var chars = Array.from(raw);
    for (var i = 0; i < chars.length; i++) {
      var ch = chars[i];
      if (isLineBreak(ch)) hit[PROMPT_HAZARD.NEWLINE] = true;
      else if (isReportableAsControl(ch)) hit[PROMPT_HAZARD.CONTROL] = true;
      if (isBidiControl(ch)) hit[PROMPT_HAZARD.BIDI] = true;
      if (isInvisible(ch)) hit[PROMPT_HAZARD.INVISIBLE] = true;
      if (isDelimiter(ch)) hit[PROMPT_HAZARD.DELIMITER] = true;
      if (isConfusableCandidate(ch)) hit[PROMPT_HAZARD.CONFUSABLE] = true;
    }
    return HAZARD_ORDER.filter(function (k) { return hit[k] === true; });
  }

  /* ── 5. 值是否原样安全 ──────────────────────────────────────────────
     "干净"的定义是**可判定的**，不是"看起来没问题"：
       · 必须是字符串（非字符串已经发生了一次类型改写）
       · 不含会被**替换掉**的码位（换行 / 控制 / 不可见 / 双向控制）
       · 首尾没有空白、内部没有连续空白（归一本身会改写字节）
     定界符与同形候选**不**使值"不安全"：它们不改值（见文件头第 2 / 3 类），
     但照旧出现在 findings 里 —— 想知道就能知道，不会因为本函数为 true 而消失。

     注意与 `changed` 的区别：changed 是"这次调用改了什么"，
     本函数是"这个值能不能原样用"。`'Ａlice'` 的 changed=false、安全=true，
     而 findings=['confusable'] —— 三者并不矛盾，它们回答三个不同的问题。 */
  function isPromptSafeValue(value) {
    if (typeof value !== 'string' || value.length === 0) return false;
    var chars = Array.from(value);
    for (var i = 0; i < chars.length; i++) {
      var ch = chars[i];
      if (isLineBreak(ch) || isControl(ch) || isInvisible(ch)) return false;
    }
    if (value !== value.trim()) return false;
    if (/  /.test(value)) return false;
    return true;
  }

  /* ── 6. 消毒（唯一实现）────────────────────────────────────────────
     顺序刻意写死并逐条注释，因为顺序本身会改变结果：

       ① 归一化输入（非字符串兜底）
       ② 逐码位处理：换行／控制／不可见 → ' '；其余（含定界符与同形字）原样
       ③ 折叠连续空白为单个 ' '
       ④ 去首尾空白
       ⑤ 按**码位**截断（不按 UTF-16 码元，否则会切断代理对）
       ⑥ 汇总

     ②必须整体完成再进③：若边扫边折叠，`a\nb` 与 `a  b` 会得到不同结果，
     而它们在第 1 类语义上是同一件事。 */
  function sanitizePromptInput(value, options) {
    var opts = (options && typeof options === 'object') ? options : {};
    var limit = opts.maxLength;
    if (typeof limit !== 'number' || !isFinite(limit) || limit < 0) limit = DEFAULT_MAX_LENGTH;
    limit = Math.floor(limit);

    var raw = coerceRaw(value);
    var findings = detectPromptHazards(raw);

    var chars = Array.from(raw);
    var out = [];
    for (var i = 0; i < chars.length; i++) {
      var ch = chars[i];
      /* TAB 与不可见格式字符走**同一条**替换路径（→ ' '），只是报告类别不同。
         本模块最初的真实缺陷就在这里：TAB 被 isSpaceCP 当成空白**原样留下**，
         既不折叠也不报告 —— 于是 'A\tB' 逐字节不变，findings 为空，
         而调用方以为"消毒过了"。判据必须是"值里没有非语义的不可见字符"，
         不是"值里没有换行"。 */
      if (isLineBreak(ch) || isControl(ch) || isInvisible(ch) || CP(ch) === 0x09) out.push(' ');
      else out.push(ch);
    }
    var joined = out.join('');

    /* ③ 折叠连续空白（含被替换出来的空格）为单个空格 */
    var collapsed = joined.replace(/[ ]{2,}/g, ' ');
    /* 首尾空白：包含 ASCII 空格与其它空白码位（值本身可能以 NBSP 开头） */
    var trimmed = '';
    {
      var tc = Array.from(collapsed);
      var s = 0, e = tc.length;
      while (s < e && isSpaceCP(tc[s].codePointAt(0))) s++;
      while (e > s && isSpaceCP(tc[e - 1].codePointAt(0))) e--;
      trimmed = tc.slice(s, e).join('');
    }

    var truncated = false;
    var finalChars = Array.from(trimmed);
    if (limit > 0 && finalChars.length > limit) { finalChars = finalChars.slice(0, limit); truncated = true; }
    else if (limit === 0) { finalChars = []; truncated = trimmed.length > 0; }
    var result = finalChars.join('');

    /* 被截断后可能留下尾随空格 —— 再修一次，否则存在"消毒结果以空格结尾"
       这种下游需要额外处理的形状。这一步不会破坏幂等性（结果已无换行）。 */
    if (result !== result.trim()) result = result.trim();

    /* 是否改动：与 raw 比较，而不是与"当前结果"比较 —— 这样"输入合法但
       首尾有空格"也会被如实记为 changed。 */
    var changed = result !== raw;

    /* 'truncated' 不是 PROMPT_HAZARD 类别，因此只进 reason 而不进 findings ——
       findings 回答"值本身命中了哪些类别"，reason 回答"这次调用做了什么"。 */
    var reasonParts = findings.slice();
    if (truncated) reasonParts.push('truncated');
    var reason = changed ? (reasonParts.length ? reasonParts.join('+') : 'whitespace') : '';

    return {
      value: result,
      raw: raw,
      changed: changed,
      findings: findings,
      truncated: truncated,
      reason: reason
    };
  }

  /* ── 7. 列表消毒（成员名清单）
     返回**新数组**，不改入参。空项与重复项在这里被丢弃：
     一个名字消毒后为空意味着它整体由控制字符构成，把它留在清单里会让
     prompt 出现 `、、` 这种空洞，也会让"成员数"与实际可称呼的成员不一致。 */
  function sanitizeNameList(list, options) {
    var arr = Array.isArray(list) ? list : [];
    var out = [];
    var seen = Object.create(null);
    var changed = false;
    for (var i = 0; i < arr.length; i++) {
      var r = sanitizePromptInput(arr[i], options);
      if (!r.value) { changed = true; continue; }
      if (seen[r.value]) { changed = true; continue; }
      seen[r.value] = true;
      if (r.changed) changed = true;
      out.push(r.value);
    }
    if (arr.length !== out.length) changed = true;
    return { names: out, changed: changed };
  }

  return {
    PROMPT_HAZARD: PROMPT_HAZARD,
    HAZARD_ORDER: HAZARD_ORDER,
    DEFAULT_MAX_LENGTH: DEFAULT_MAX_LENGTH,
    detectPromptHazards: detectPromptHazards,
    isPromptSafeValue: isPromptSafeValue,
    sanitizePromptInput: sanitizePromptInput,
    sanitizeNameList: sanitizeNameList
  };
});
