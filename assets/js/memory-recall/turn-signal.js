/* ====================================================================
   IB Memory Recall · Turn Signal / Early Exit — runtime-neutral 纯函数（UMD dual-load）
   --------------------------------------------------------------------
   - Browser: <script src="assets/js/memory-recall/turn-signal.js">
              → window.IBMemoryRecallTurnSignal
   - Node   : require('../assets/js/memory-recall/turn-signal.js')
   - 规则：零 window / 零 DOM / 零 IndexedDB / 零 localStorage / 零 fetch /
           零副作用 / 零定时器 / 零随机 / 零时钟 / 纯函数。

   ── 这个模块回答什么（并且只回答这些）────────────────────────────────
     ① 这一轮是否值得启动**普通** Memory Recall？（shouldRecall）
     ② 这一轮是否应当**提前退出**（不启动 recall）？（earlyExit / earlyExitReason）
     ③ 是否存在明确的 recall intent 或 host-forced channel？（explicitRecall / hostForced）
     ④ 若已知，建议用哪个 channel？（suggestedChannel，仅建议，不执行）

   ── 它不负责（越界即违约）──────────────────────────────────────────
     搜索记忆 / Query 构造 / visibility / scoring / channel policy 数值 /
     cooldown / budget / DB / conversation history / LLM / Middle Brain。

   ── 与契约的关系 ──────────────────────────────────────────────────
     docs/contracts/memory/MEMORY_RECALL_CONTRACT.md
       §4  channel 词表（legacy / surface / recall / glossary / coldStart / reminisce）
       §5  Early Exit Contract：early-exit 不是 error / degraded / failure
       §6  Hard Gate（本模块**不**实现 gate；只决定"要不要启动 recall"）
       §11 reason 词表：本模块只产出 'early-exit'，且**只作为分析结果**，
           不写进任何 recall result（那是 R2-C 的事）

   ── R2-B 的接线状态：implemented but unwired ────────────────────────
     本文件**没有**任何生产调用方；不加入 InternalBeyond.html；不被 memory.js /
     communication.js / home-node-bootstrap.js / memory-retrieval.js 引用。
     因此现有 production recall output 在结构上不可能改变。

   ── 优先级（R2-B 正式冻结的行为，从高到低）──────────────────────────
     1. Host-forced recall channel（recall / glossary / coldStart / reminisce）
     2. Conversation cold start（isConversationOpen === true）
     3. Explicit recall intent
     4. Semantic payload（hasSemanticPayload === true）
     5. Early-exit classification（仅当前四项全部不成立时才可能成立）

     注意：surface 与 legacy **不属于**"强制越过 Early Exit"的 channel ——
     它们是默认/兼容姿态，不构成"Host 明确要求做 memory work"的证据。
   ==================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); }
  else { root.IBMemoryRecallTurnSignal = factory(); }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ── 0. 词表（冻结，与 Contract §4 / §11 逐字同源）────────────────── */

  var CHANNELS = ['legacy', 'surface', 'recall', 'glossary', 'coldStart', 'reminisce'];

  /* 只有这四个 channel 表达"Host 明确要求做 memory work"。
     surface / legacy 是**默认与兼容姿态**：它们不构成强制信号，
     因此 host 传 surface 时，early exit 仍然可以成立。
     这条区分是本模块最容易写错的地方，故显式列出而不是靠"非 surface 即强制"。 */
  var FORCE_CHANNELS = ['recall', 'glossary', 'coldStart', 'reminisce'];

  /* Early-exit 原因词表。前缀 'signal-' 表示"输入信号本身没有记忆价值"，
     与 Contract §11 的 recall **result** reason（'early-exit' 等）刻意分开：
     本模块产出的是**分类**，不是 recall result。 */
  var EARLY_EXIT_REASON = {
    emptyInput: 'signal-empty',
    punctuationOnly: 'signal-punctuation-only',
    emojiOnly: 'signal-emoji-only',
    acknowledgement: 'signal-acknowledgement'
  };

  /* decisionSource 词表：让"这一轮为什么这样判"可从结果倒推。
     没有它，下游只能靠 shouldRecall/earlyExit 的组合去猜优先级走的是哪一支。 */
  var DECISION_SOURCE = {
    hostForced: 'host-forced',
    coldStart: 'conversation-cold-start',
    explicitRecall: 'explicit-recall-intent',
    semanticPayload: 'semantic-payload',
    earlyExit: 'early-exit',
    surface: 'surface-default'
  };

  /* ── 1. 输入安全上限 ────────────────────────────────────────────────
     这是**实现安全限制**，不是 Recall product budget（Contract §16 只冻结形状，
     数值不进 canonical contract）。目的：让 10MB 输入不会生成海量中间产物。
     分类只看前缀，因此截断对分类结果没有额外语义影响；截断本身是确定性的。 */
  var MAX_SIGNAL_INPUT_CHARS = 10000;

  /* ── 2. 归一化 ──────────────────────────────────────────────────────
     Unicode NFKC + 去控制/零宽字符 + trim + 折叠空白。
     刻意**不**做语义改写、不做模糊匹配、不做词干化。 */
  var ZERO_WIDTH_RE = /[\u200B-\u200D\u2060\uFEFF]/g;
  var CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

  function normalizeText(value) {
    if (value == null) return '';
    if (typeof value !== 'string') return '';
    var text = value;
    try { text = text.normalize('NFKC'); } catch (e) { /* 旧引擎无 normalize：保持原样 */ }
    text = text.replace(ZERO_WIDTH_RE, '').replace(CONTROL_RE, '');
    text = text.replace(/\s+/g, ' ').trim();
    if (text.length > MAX_SIGNAL_INPUT_CHARS) text = text.slice(0, MAX_SIGNAL_INPUT_CHARS);
    return text;
  }

  /* ── 3. 无记忆价值表达的分类 ────────────────────────────────────────
     **禁止**按长度判断（message.length < N → early exit）。"北京" / "显卡" /
     "妈妈" / "地下室" 都可能只有 2~3 字但语义很强。
     Early exit 只认**确定性的无记忆价值表达集合**。

     标点集刻意用**码位区间**而不是 \p{P}：\p{P} 会把 '_'（Pc）算作标点，
     于是 "memory_records" 这类标识符有被误判为纯标点的风险。 */
  var PUNCT_ONLY_RE = new RegExp(
    '^['
    + '\\u0021-\\u002F'      /* ! " # $ % & ' ( ) * + , - . / */
    + '\\u003A-\\u0040'      /* : ; < = > ? @ */
    + '\\u005B-\\u0060'      /* [ \\ ] ^ _ ` —— 含下划线，但整体仍是"纯符号"语义 */
    + '\\u007B-\\u007E'      /* { | } ~ */
    + '\\u00A1-\\u00BF\\u00D7\\u00F7'
    + '\\u2000-\\u206F'      /* 通用标点（含 … ） */
    + '\\u3000-\\u303F'      /* CJK 标点 */
    + '\\uFF01-\\uFF0F\\uFF1A-\\uFF20\\uFF3B-\\uFF40\\uFF5B-\\uFF65'
    + ']+$'
  );

  /* emoji-only：允许 emoji / ZWJ / 变体选择符 / 肤色修饰符 + 空白。 */
  var EMOJI_ONLY_RE = /^(?:[\p{Extended_Pictographic}\u200D\uFE0F\u{1F3FB}-\u{1F3FF}\s])+$/u;

  /* 精确确认 / 填充词（normalized **exact** match，绝不做 substring 判断）。
     "好像上次我们说过这个" 绝不能因为包含"好"而被判 early exit —— 它不在表里，
     且列表匹配是整串相等。 */
  var ACKNOWLEDGEMENTS = [
    '嗯', '嗯嗯', '好', '好的', '好吧', '行', '可以', '知道了', '收到',
    '哈哈', '哈哈哈', '笑死', '继续', '接着',
    '哦', '噢', '啊', '诶'
  ];

  function classifyNonMemoryExpression(normalized) {
    if (!normalized) return EARLY_EXIT_REASON.emptyInput;
    if (PUNCT_ONLY_RE.test(normalized)) return EARLY_EXIT_REASON.punctuationOnly;
    /* emoji 检查放在标点之后："..." 已被标点吸收，"😂" 落到这里。 */
    try {
      if (EMOJI_ONLY_RE.test(normalized)) return EARLY_EXIT_REASON.emojiOnly;
    } catch (e) { /* 引擎不支持 \p{…}：退化为"不判 emoji-only"，宁可保守 */ }
    if (ACKNOWLEDGEMENTS.indexOf(normalized) >= 0) return EARLY_EXIT_REASON.acknowledgement;
    return null;
  }

  /* ── 4. Explicit recall cue 检测 ────────────────────────────────────
     只识别**强证据**；不是完整 NLP。

     刻意**不**把单独出现的 昨天 / 去年 / 以前 当作 explicit recall：
     它们是 temporal hint（见 recall-query.js）。"去年苹果发布了什么？"
     不一定是在问角色记忆。 */
  var RECALL_CUES_ZH = [
    '还记得', '记得吗', '你记得',
    '上次', '之前说过', '之前聊过', '以前说过',
    '那次', '那件事', '当时我们',
    '你不是说过', '我不是说过', '我们不是说过'
  ];
  var RECALL_CUES_EN = [
    'remember', 'do you remember', 'last time', 'previously', 'earlier', 'we talked about'
  ];

  /* 返回 { matched: [{cue, index, raw}], indices: {cue: index} }
     顺序 = 文本首次出现位置；同一位置多个 cue 时按词表顺序（确定性）。
     raw 取**原文**切片（保留大小写与书写形式），便于调用方展示与断言。 */
  function detectRecallCues(normalized) {
    var matched = [];
    var lower = normalized.toLowerCase();
    var i, idx;

    for (i = 0; i < RECALL_CUES_ZH.length; i++) {
      var cueZh = RECALL_CUES_ZH[i];
      idx = normalized.indexOf(cueZh);
      if (idx >= 0) matched.push({ cue: cueZh, index: idx, raw: normalized.slice(idx, idx + cueZh.length) });
    }
    for (i = 0; i < RECALL_CUES_EN.length; i++) {
      var cueEn = RECALL_CUES_EN[i];
      idx = lower.indexOf(cueEn);
      if (idx >= 0) matched.push({ cue: cueEn, index: idx, raw: normalized.slice(idx, idx + cueEn.length) });
    }
    /* 稳定排序：先按位置，再按词表登记顺序（用原始下标做次级键）。
       绝不依赖对象键枚举顺序。 */
    matched.sort(function (a, b) {
      if (a.index !== b.index) return a.index - b.index;
      return RECALL_CUES_ZH.concat(RECALL_CUES_EN).indexOf(a.cue)
        - RECALL_CUES_ZH.concat(RECALL_CUES_EN).indexOf(b.cue);
    });
    return matched;
  }

  /* ── 5. 主入口 ────────────────────────────────────────────────────── */
  function analyzeTurnSignal(input) {
    var opts = (input && typeof input === 'object' && !Array.isArray(input)) ? input : {};
    var normalized = normalizeText(opts.message);

    var hintRaw = (typeof opts.channelHint === 'string') ? opts.channelHint : '';
    var hint = (FORCE_CHANNELS.indexOf(hintRaw) >= 0) ? hintRaw : null;
    /* channelHintRecognized：这个字符串**是不是**契约 §4 的合法 channel 名。
       它回答"Host 说的话我们能听懂吗"，与"它是否构成强制信号"是两个问题 ——
       surface / legacy 是合法但不强制的；'bogus' 则根本不被识别。 */
    var hintIsKnownChannel = !!hintRaw && CHANNELS.indexOf(hintRaw) >= 0;

    /* ① Host-forced channel。Host 明确要求做 memory work ⇒ 不得 early exit，
          哪怕 message 是 "嗯" / "好" / 空串。 */
    if (hint) {
      return {
        shouldRecall: true,
        earlyExit: false,
        earlyExitReason: null,
        explicitRecall: false,
        recallCues: [],
        hostForced: true,
        isConversationOpen: opts.isConversationOpen === true,
        hasSemanticPayload: opts.hasSemanticPayload === true,
        channelHint: hintRaw,
        channelHintRecognized: true,
        suggestedChannel: hint,
        decisionSource: DECISION_SOURCE.hostForced,
        normalizedMessage: normalized
      };
    }

    var cues = detectRecallCues(normalized);
    var explicitRecall = cues.length > 0;
    var isConversationOpen = opts.isConversationOpen === true;
    var hasSemanticPayload = opts.hasSemanticPayload === true;

    function result(over) {
      var base = {
        shouldRecall: over.shouldRecall,
        earlyExit: over.earlyExit,
        earlyExitReason: over.earlyExitReason,
        explicitRecall: explicitRecall,
        recallCues: cues,
        hostForced: false,
        isConversationOpen: isConversationOpen,
        hasSemanticPayload: hasSemanticPayload,
        channelHint: hintRaw,
        channelHintRecognized: hintIsKnownChannel,
        suggestedChannel: over.suggestedChannel,
        decisionSource: over.decisionSource,
        normalizedMessage: normalized
      };
      return base;
    }

    /* ② Conversation cold start 优先于 Early Exit。
          R2-B **不实现** coldStart retrieval —— 这里只表达"不能提前跳过"。 */
    if (isConversationOpen) {
      return result({
        shouldRecall: true, earlyExit: false, earlyExitReason: null,
        suggestedChannel: 'coldStart', decisionSource: DECISION_SOURCE.coldStart
      });
    }

    /* ③ Explicit recall intent 优先于 Early Exit。
          "好，你还记得上次那件事吗" 以"好"开头，但含明确 cue ⇒ 不得因确认词退出。 */
    if (explicitRecall) {
      return result({
        shouldRecall: true, earlyExit: false, earlyExitReason: null,
        suggestedChannel: 'recall', decisionSource: DECISION_SOURCE.explicitRecall
      });
    }

    /* ④ Semantic payload：调用方声明本轮含非文本语义（图片 / 语音转写外信息 /
          宿主结构化语义）。R2-B 不解析附件本身，只尊重这个显式声明。 */
    if (hasSemanticPayload) {
      return result({
        shouldRecall: true, earlyExit: false, earlyExitReason: null,
        suggestedChannel: null, decisionSource: DECISION_SOURCE.semanticPayload
      });
    }

    /* ⑤ Early-exit classification：只有前四项全部不成立时才可能成立。 */
    var earlyReason = classifyNonMemoryExpression(normalized);
    if (earlyReason) {
      return result({
        shouldRecall: false, earlyExit: true, earlyExitReason: earlyReason,
        suggestedChannel: null, decisionSource: DECISION_SOURCE.earlyExit
      });
    }

    /* 既非强制、也非早退：普通浮现轮。suggestedChannel 保持 null ——
       本模块只回答"要不要做 memory work"，不替 channel policy 做选择
       （surface 的席位 / gate / budget 属 R2-D）。 */
    return result({
      shouldRecall: true, earlyExit: false, earlyExitReason: null,
      suggestedChannel: null, decisionSource: DECISION_SOURCE.surface
    });
  }

  return {
    analyzeTurnSignal: analyzeTurnSignal,
    /* 归一化与分类单独导出：让测试可以钉住 normalization 本身，
       而不必通过主入口间接断言。 */
    normalizeText: normalizeText,
    classifyNonMemoryExpression: classifyNonMemoryExpression,
    detectRecallCues: detectRecallCues,
    /* 词表与常量（供 contract test 与下游引用，避免各自复制一份） */
    CHANNELS: CHANNELS.slice(),
    FORCE_CHANNELS: FORCE_CHANNELS.slice(),
    EARLY_EXIT_REASON: {
      emptyInput: EARLY_EXIT_REASON.emptyInput,
      punctuationOnly: EARLY_EXIT_REASON.punctuationOnly,
      emojiOnly: EARLY_EXIT_REASON.emojiOnly,
      acknowledgement: EARLY_EXIT_REASON.acknowledgement
    },
    DECISION_SOURCE: {
      hostForced: DECISION_SOURCE.hostForced,
      coldStart: DECISION_SOURCE.coldStart,
      explicitRecall: DECISION_SOURCE.explicitRecall,
      semanticPayload: DECISION_SOURCE.semanticPayload,
      earlyExit: DECISION_SOURCE.earlyExit,
      surface: DECISION_SOURCE.surface
    },
    ACKNOWLEDGEMENTS: ACKNOWLEDGEMENTS.slice(),
    RECALL_CUES_ZH: RECALL_CUES_ZH.slice(),
    RECALL_CUES_EN: RECALL_CUES_EN.slice(),
    MAX_SIGNAL_INPUT_CHARS: MAX_SIGNAL_INPUT_CHARS
  };
});
