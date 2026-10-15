/* 全局「简短回合」会话风格策略 —— 浏览器与 Node 共用同一份实现，禁止在 Chat / Proactive /
   Voice 各处复制提示词文本。
   加载方式：
   - 浏览器：<script src="assets/js/brevity-policy.js">（在 communication.js 之前）；
     挂载 window._brevityPolicy / IB.brevity。
   - Node：require('./assets/js/brevity-policy.js')。
   本模块只产出「风格策略文本」与「是否明确要求详细」的判别；不限制 maxTokens（token 上限
   仍是安全边界，不替代行为）。任何改动同时影响前后台提示词与测试。 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    const core = factory();
    root._brevityPolicy = core;
    root.IB = root.IB || {};
    root.IB.brevity = core;
  }
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  /* 用户明确要求详细/展开/解释时，允许覆盖简短策略。 */
  const DETAIL_REQUEST_RE = /详细|展开|具体|全面|完整|逐条|逐项|分点|说明一下|解释一下|分析一下|为什么|怎么回事|怎么(做|办|实现|运作|回事)|列出|原理解释|请说明|讲清楚|多讲讲|再讲讲|深入|剖析|长文/i;

  function isDetailedRequest(text) {
    const t = String(text || '');
    if (DETAIL_REQUEST_RE.test(t)) return true;
    return /\b(explain|elaborate|detailed|in detail|expand|break down|walk me through)\b/i.test(t) ||
      /\b(why|how does|how do)\b/i.test(t);
  }

  /* Role DM is casual conversation, so a standalone why/how question is not by itself
     a request for a long explanation. Keep the general Chat classifier unchanged and
     recognize explicit requests to elaborate here. */
  function isRoleDmDetailedRequest(text) {
    const t = String(text || '');
    return /详细|展开|全面|完整|逐条|逐项|分点|说明一下|解释一下|分析一下|列出|原理解释|请说明|讲清楚|多讲讲|再讲讲|深入|剖析|长文|具体(?:说|讲|解释|分析)/i.test(t) ||
      /\b(explain|elaborate|detailed|in detail|expand|break down|walk me through)\b/i.test(t);
  }

  /* 角色级「简洁回复」约束文本（replyStyle === 'concise' 时注入）。
     这是「表达风格控制」而非文本长度限制：不为凑长度写出多余内容，但遇到确实需要
     详细解释的问题仍允许正常展开。不引入硬编码字符数，也不裁剪模型输出。 */
  function conciseGuidance() {
    return [
      '【简洁回复 · 表达风格】',
      '这个角色开启了「简洁回复」：普通聊天尽量短、直接，能把一句话说完就不要写三句。',
      '- 优先直接回答，尽量减少废话；',
      '- 不主动重复用户已经知道的信息；',
      '- 不为了显得完整而扩展无关内容；',
      '- 能一句话说清就不要写三句话；',
      '- 不主动追加“如果你愿意我还可以……”之类的尾巴；',
      '- 但遇到确实需要详细解释的问题，仍然允许正常展开。'
    ].join('\n');
  }

  /* 角色级「自然收尾」约束文本（naturalEnding === true 时注入，与 replyStyle 相互独立）。
     这是「表达风格控制」而非文本过滤器：只约束“结束方式”，不删除/过滤任何输出内容。
     用户明确要求详细（detailed）时不注入，避免误伤必要结构。 */
  function naturalEndingGuidance() {
    return [
      '【自然收尾 · 表达风格】',
      '这个角色开启了「自然收尾」：回复结束时自然停下，不要为了维持对话而机械追加问题、总结、邀请或帮助选项。',
      '- 不要每条消息都以问题结尾；',
      '- 用户没有要求时，不要强行提出新问题；',
      '- 不要机械添加“如果你愿意，我可以……”；',
      '- 不要机械添加“还有什么需要帮助的吗？”；',
      '- 不要重复总结已经说过的内容；',
      '- 一句话已经完整表达意思时，可以直接结束；',
      '- 普通闲聊允许自然地停住；',
      '- 需要询问关键信息时仍然应该询问；',
      '- 用户明确要求建议、下一步或继续讨论时，不要阻止正常展开；',
      '- 不要为了“自然收尾”而省略真正必要的问题。'
    ].join('\n');
  }

  /* 角色级「对话连贯」约束文本（conversationContinuity === true 时注入，与其余表达设置相互独立）。
     这是「表达风格控制」而非文本过滤器：只约束“承接方式”，不删除/重写任何输出内容。
     与详细请求并不冲突：即使用户要求详细展开，也应避免重复已经建立的上下文、重新介绍自己或
     重新解释已解释过的概念；但连续性不是盲目相信上下文——上下文不足时正常询问、不猜事实、不伪造记忆。 */
  function conversationContinuityGuidance() {
    return [
      '【对话连贯 · 表达风格】',
      '这个角色开启了「保持对话连贯」：把当前消息理解为正在进行的连续对话，而不是独立的新问题。',
      '- 优先承接上一轮已经建立的语境；',
      '- 不要重复已经明确说明过的信息；',
      '- 不要重新介绍自己；',
      '- 不要重新解释已经解释过的概念；',
      '- 用户使用“它/那个/这样/你刚才说的”等指代时，优先根据现有上下文理解；',
      '- 如果上一轮已经确定了某个事实，不要无意义地再次确认；',
      '- 对用户的简短回应进行自然承接；',
      '- 不要为了“完整”而重复前文；',
      '- 不要每轮都重新总结整个话题；',
      '- 不要把上一轮已经完成的内容重新生成一遍；',
      '- 但连续性不是盲目相信上下文：如果上下文确实不足以确定用户指什么，可以正常询问，不要猜测关键事实，不要伪造记忆。'
    ].join('\n');
  }

  /* Optional, pure wording strategy shared by user Chat and Role DM through separate
     adapters. It grants range without assigning a mood or keeping emotional state. */
  function chatEmotionalTextureGuidance() {
    return [
      '【聊天中的情绪自然变化】',
      '保持角色一贯的人设、说话习惯和与用户已经建立的关系；优先回应此刻这句话，不要自动套用万能安慰、认同、解释、总结或反问。',
      '- 按语境可以犹豫一下、开个玩笑、轻微抱怨、说不同意、暂时不知道怎么回应，或先把真实反应说出来；',
      '- 被指出问题后可以嘴硬一下、说明自己的看法，也可以承认没想到、改口或慢慢缓和；',
      '- 这些只是允许的表达方式，不是每轮都要选一种；情绪应来自当前对话、人设和既有关系，不随机切换，不凭空编造共同经历或冲突；',
      '- 玩笑归玩笑；对方确实受伤、遇到困难或需要事实帮助时，仍认真回应，不把“有毛边”演成冷漠或刻薄。'
    ].join('\n');
  }

  function roleDmEmotionalTextureGuidance() {
    return [
      '【角色之间的情绪自然变化】',
      '以当前发言角色自己的性格、价值观和习惯表达；结合对方刚说的话、已有的相处方式和最近对话，不要把两个角色都写成同一个温柔周全的助手。',
      '- 不必总是认同、解释、安慰或把话收成圆满结论；语境合适时可以犹豫、嘴硬、轻微抱怨、敷衍一句、反驳、不认同、突然联想，也可以改口或慢慢缓和；',
      '- 这些是表达空间，不是情绪任务：只在当前对话有依据时使用，不随机起伏、不强造争执、不把短暂反应写成稳定心情；',
      '- 陌生、熟悉、玩笑、失望、争执或和解的分寸由现有人设、关系投影和近期内容决定；没有依据时不升级亲密、不虚构共同经历；',
      '- 即使暂时不安慰，也要接住对方说的事；确实需要帮助时仍认真回应。'
    ].join('\n');
  }

  /* Role DM keeps the same canonical style policy, with a mode for character-to-character
     conversation. This is prompt text only: it does not schedule turns or call a model. */
  function roleDmGuidance() {
    return [
      '【角色私聊表达】',
      '这是两个角色之间的私人交谈，不必把每次发言写成完整、周全的答复。',
      '- 普通闲聊默认发一条短消息，通常一句、最多一两句；有语境的短回应也完整自然；',
      '- 一条消息先回应最近的一句话或一个情绪点，说到点上就停；不要把反应、背景、解释、总结和追问全塞进同一条；',
      '- 普通闲聊正文通常只写一小段，不换行；不要照着历史消息的长度或段落数来模仿。换行仍属于同一条消息，不会变成新的气泡；',
      '- 如果另一个想法确实适合单独发，当前消息只说第一件事，再用 continue_self 让下一次模型调用生成独立气泡；不要把两条都写完再用 speak，也不要按标点拆句或为了多发而硬拆；',
      '- 复杂问题、明确要求详细说明的内容或需要认真安慰的情境，仍可以充分展开，也可以自然分段；',
      '- 可以自然停顿、用口语片段或不完整句子承接；不必每条消息都总结、追问或把话题收成闭环；',
      '- 只根据当前对话和角色设定表达情绪，不要为了显得自然而故意错字、争吵或改变人设。'
    ].join('\n');
  }

  /* 各模式下的风格策略文本（短回合原则）。voice 明显短于 text。 */
  function guidanceFor(mode) {
    const m = String(mode || 'text').toLowerCase();
    if (m === 'voice') {
      return [
        '本轮是语音通话，说话要明显短于文字回复：一般用 1 至 2 个短句说完即止。',
        '说完就停下来等待对方开口，不要连续补充、解释或复述，不要给额外提醒。'
      ];
    }
    if (m === 'proactive') {
      return [
        '这是一条主动发起的消息，尽量简短：一般 1 至 2 个短句，自然开口，不凑字数。',
        '不要解释为什么发这条消息，不要铺垫，不要复述最近聊天。'
      ];
    }
    /* text / casual */
    return [
      '聊天尽量简短：一般 1 至 3 个短句，说到点子上就停，把对话交还给对方。',
      '不要无谓地解释、总结、复述对方的话，不要为了凑长度追加补充；对方明确要求详细时才展开。'
    ];
  }

  /* 拼出一条可注入 system/common 的风格策略文本块。
     concise=true（角色级「简洁回复」）时使用专门的简洁约束文本，覆盖全局短回合策略；
     detailed=true 时整体返回空（用户明确要求详细时不受风格约束）。 */
  function buildGuidance(opts) {
    const o = opts || {};
    if (o.detailed) return '';
    if (o.concise) return conciseGuidance();
    const mode = o.mode || 'text';
    return [
      '【表达风格】',
      '总原则：简短、直接、说完即止，把对话交还给对方。',
      '除非对方明确要求详细，否则遵循以下长度：'
    ].concat(guidanceFor(mode)).join('\n');
  }

  /* 追加到已有 system 文本末尾。
     主风格块：detailed='' / concise=简洁 / 其余=全局短回合。
     naturalEnding 与 concise/global 相互独立（detailed 时不注入，避免误伤必要结构）。
     conversationContinuity 与 detailed 不冲突：即使 detailed 也注入（但自然收尾/简洁仍豁免），
     因为“避免重复已建立上下文”在详细展开时同样成立。三个角色级设置可自由组合。 */
  function apply(systemPrompt, opts) {
    const o = opts || {};
    let guidance = buildGuidance(o); /* detailed='' / concise=简洁 / 其余=全局短回合 */
    if (o.naturalEnding && !o.detailed) {
      const ne = naturalEndingGuidance();
      guidance = guidance ? guidance + '\n\n' + ne : ne;
    }
    if (o.conversationContinuity) {
      const cc = conversationContinuityGuidance();
      guidance = guidance ? guidance + '\n\n' + cc : cc;
    }
    const base = String(systemPrompt || '');
    if (o.emotionalTexture === true) {
      const hasExistingStyle = base.indexOf('【表达风格】') !== -1 || base.indexOf('【简洁回复') !== -1 ||
        base.indexOf('【自然收尾') !== -1 || base.indexOf('【对话连贯') !== -1;
      const blocks = [];
      if (guidance && !hasExistingStyle) blocks.push(guidance);
      if (base.indexOf('【聊天中的情绪自然变化】') === -1) blocks.push(chatEmotionalTextureGuidance());
      return blocks.length ? base + (base ? '\n\n' : '') + blocks.join('\n\n') : base;
    }
    if (!guidance) return base;
    if (base.indexOf('【表达风格】') !== -1) return base;
    if (base.indexOf('【简洁回复') !== -1) return base;
    if (base.indexOf('【自然收尾') !== -1) return base;
    if (base.indexOf('【对话连贯') !== -1) return base;
    return base + (base ? '\n\n' : '') + guidance;
  }

  /* Role DM adapter: retain the normal concise/detailed/role-setting precedence, then add
     its own low-priority style block. Chat callers continue to use apply() unchanged. */
  function applyRoleDm(systemPrompt, opts) {
    const o = opts || {};
    let base = String(systemPrompt || '');
    const blocks = [];
    if (base.indexOf('【角色之间的情绪自然变化】') === -1) blocks.push(roleDmEmotionalTextureGuidance());
    if (!o.detailed) {
      if (o.concise && base.indexOf('【简洁回复') === -1) blocks.push(conciseGuidance());
      if (base.indexOf('【角色私聊表达】') === -1) blocks.push(roleDmGuidance());
      if (o.naturalEnding && base.indexOf('【自然收尾') === -1) blocks.push(naturalEndingGuidance());
    }
    if (o.conversationContinuity && base.indexOf('【对话连贯') === -1) blocks.push(conversationContinuityGuidance());
    if (!blocks.length) return base;
    return base + (base ? '\n\n' : '') + blocks.join('\n\n');
  }

  return {
    isDetailedRequest: isDetailedRequest,
    guidanceFor: guidanceFor,
    conciseGuidance: conciseGuidance,
    naturalEndingGuidance: naturalEndingGuidance,
    conversationContinuityGuidance: conversationContinuityGuidance,
    chatEmotionalTextureGuidance: chatEmotionalTextureGuidance,
    roleDmEmotionalTextureGuidance: roleDmEmotionalTextureGuidance,
    roleDmGuidance: roleDmGuidance,
    isRoleDmDetailedRequest: isRoleDmDetailedRequest,
    buildGuidance: buildGuidance,
    apply: apply,
    applyRoleDm: applyRoleDm,
    DETAIL_REQUEST_RE: DETAIL_REQUEST_RE
  };
});
