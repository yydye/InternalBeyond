/* ====================================================================
   IB Public Profile Core — 「角色公开认知层」的**唯一契约实现**
   --------------------------------------------------------------------
   UMD 双载：
     - Browser: <script src="assets/js/public-profile-core.js"> → window.IBPublicProfileCore
     - Node   : require('../assets/js/public-profile-core.js')
   规则（与 chat-core.js / role-dm-core.js / mobile-dto.js 同款）：
   **零 window / 零 DOM / 零 fetch / 零 IndexedDB / 零 localStorage / 零副作用**。

   ── 它解决的是什么（P0 审计结论，不是推测）─────────────────────────
   Role DM 短时真实体验审计（16 个真实模型回合 / 4 个 pair）实测：
   人格分离 16/16 成立（0 次泄漏对方 persona），但 Peer Awareness 4/4 pair
   全部只有 1/3 —— **"我知道我是谁，但我几乎不知道你是谁。"**

   根因不是"信息太少"，而是**两类信息从来没有被正式区分过**：

       private / self authority          public / social identity
       ─────────────────────────         ─────────────────────────
       systemPrompt（人格原文）           公开简介 / 身份 / 公开特征 / 兴趣
       relationship（对用户的关系）        @账号 / 昵称
       private memory / Understanding
       Middle Brain private state
       apiKey / endpoint / 运行参数

   左侧是"角色脑子里"的东西，右侧是"别人可以知道"的东西。在此之前，
   Role DM 的 peerIntro 取的是 `cfg.bio || cfg.signature || cfg.handle`，
   而本机 14 个真实角色的持久化配置里**这三个键根本不存在**（字段统计：
   bio/signature/handle 非空 = 0/14；配置里出现过的键只有
   apiKey/created/endpoint/id/model/nickname/provider/relationship/
   systemPrompt/temperature/vision）。于是发言方对对方的全部认知退化成
   **一个名字**，而唯一的信息富矿（systemPrompt）恰恰是**明确禁止**外泄的。

   ── 为什么必须新开一份契约，而不是"从 persona 截一段" ──────────────
   最省事的实现是 `publicIntro = cfg.systemPrompt.split('\n')[0]`。它被本模块
   从结构上排除，理由是**它没有边界**：persona 的第一段今天是身份，明天可能
   是秘密设定、OOC 指令或用户不该被别的角色知道的关系。截取长度是任意选择，
   而"哪一段安全"根本无法判定 —— 这叫**没有边界**，不叫"暂时安全"。

   本模块因此只做一件事：把"允许公开"定义成一份**构造式白名单**。
   与 assets/js/mobile-dto.js 同一个手法 —— 输出对象由本文件的字面量逐字段
   搭建，输入里多出来的键**根本没有机会**进入输出（不是"记得在发送前删掉"）。
   于是即使未来 apiConfigs 增加了某个新的 private 字段（例如 customInstruction），
   这里也不会自动泄漏它：**新字段默认不可见**。

   ── 与既有契约的关系（复用，不并行）────────────────────────────────
   · 公开字段**复用既有真正公开的字段**，不新造第二份：`bio` / `signature`
     本来就是 AI 社交网络主页（social-network.js 的 _netRoleView）对**所有
     角色与用户**展示的东西，因此它们是合法的公开来源，作为 fallback 使用。
     mobile-dto.js 的 characterDto() 是同一批字段的另一个消费者。
   · 消毒**复用** assets/js/prompt-boundary-core.js 的 sanitizePromptInput
     （唯一实现），本模块不新写第二套 sanitizer（见 callSanitize）。
   · 关系**不属于这里**：关系是 A→B 有向且动态的（role-dm-core 的
     relationRecord），公开资料是"B 是谁"且相对稳定。两者刻意分开。
   ==================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); }
  else { root.IBPublicProfileCore = factory(); }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ══════════ 1. 契约（本能力的唯一真源）══════════════ */

  /* 公开资料的字段集合。**只有这四个**：第一版不做十几个字段 ——
     字段越多，"这条到底算不算公开"的判定就越容易出错。 */
  var FIELDS = ['publicIntro', 'occupation', 'traits', 'interests'];

  /* 有界上限。取值的理由：
     · publicIntro 240 —— 既有 role-dm-core 的简介行上限是 300 字符，240 留出
       「公开简介：」前缀与分隔符的余量；同时高于既有 bio 的 160（简介是
       1~3 句，比一句话的 bio 长）。
     · occupation 40 —— 一个身份/职业词，比 relationship 的 16 宽、比 bio 窄。
     · traits ≤5 × 12 / interests ≤5 × 16 —— 与群聊成员名清单同量级。
     最坏整块 ≈ 240+40+60+80 ≈ 420 字符，与 role-dm-core 既有的
     MEMORY_CHAR_CAP(900) / 简介行(300) 处在同一个预算量级，不改变量级。 */
  var LIMITS = {
    publicIntro: 240,
    occupation: 40,
    traits: 5,
    traitItem: 12,
    interests: 5,
    interestItem: 16
  };

  /* 列表字段的分隔符：用户用任意一种都行（UI 里是一个输入框）。 */
  var LIST_SEPARATORS = /[,，、;；\/|]+/;

  /* 公开来源（确定性判定，调用方可以据此做观测/UI 提示）。 */
  var SOURCE = {
    PROFILE: 'profile',       /* 显式 publicProfile 至少有一个字段 */
    LEGACY: 'legacy',         /* 回落到既有的真正公开字段（bio / signature） */
    NAME_ONLY: 'name-only'    /* 只有名字 —— 安全的最终兜底，绝不为了"丰富"去泄漏 persona */
  };

  /* ══════════ 2. 绝不允许进入 peer view 的东西 ══════════════
     这份清单是**数据**，供测试与结构性断言使用（"peer view 的键集合与
     这份清单的交集必须为空"）。它同时是一份文档：改动 FIELDS 之前先读它。 */
  var PRIVATE_FIELD_KEYS = [
    /* 人格 / 指令（Self-private authority） */
    'systemPrompt', 'persona', 'prompt', 'customInstruction', 'custom_instruction',
    'storyPersonalize', 'replyStyle', 'naturalEnding', 'conversationContinuity',
    /* 运行配置与凭据 */
    'apiKey', 'imageGenApiKey', 'endpoint', 'provider', 'temperature',
    'promptCache', 'cacheTtl1h', 'thinkingEnabled', 'showThinking',
    'imageGenModel', 'imageGenProvider', 'imageGenEndpoint',
    'voiceId', 'voiceType', 'voiceData', 'voiceStyle',
    /* 记忆与内部状态（不在 apiConfigs 上，但在同一个"绝不能跨角色"的语义里） */
    'memories', 'memory', 'understanding', 'understandings',
    'middleBrain', 'middleBrainState', 'relationship'
  ];

  /* 允许出现在 peer view 里的键 —— 与 FIELDS 一样是构造式白名单的一部分。 */
  var PEER_VIEW_KEYS = ['name', 'publicIntro', 'occupation', 'traits', 'interests', 'source'];

  /* ══════════ 3. 消毒（复用唯一实现，不新写第二套）══════════════
     canonical 核心（prompt-boundary-core.js）的签名是
       sanitizePromptInput(value, {maxLength}) → { value, changed, findings, ... }
     而 Role DM 运行时的包装函数返回**字符串**。两种形状都必须接受：
     只认其中一种，就会在另一个宿主里静默退回本地兜底（role-dm.js 实测
     踩过这个坑 —— `typeof out === 'string'` 在 canonical 对象上永远为 false，
     于是生产里 canonical 消毒**一次都没生效**过，只是测试注入了假实现才全绿）。
     返回 null = 消毒器未产出可用字符串 → 调用方走保守兜底。 */
  function callSanitize(fn, value, maxLength) {
    if (typeof fn !== 'function') return null;
    try {
      var out = fn(value, { maxLength: maxLength });
      if (typeof out === 'string') return out;                          /* 运行时包装（字符串形状） */
      if (out && typeof out.value === 'string') return out.value;       /* canonical（对象形状） */
    } catch (e) { /* 消毒器抛错 → 由调用方兜底，绝不把原始自由文本直接放行 */ }
    return null;
  }
  /* 保守兜底：与 role-dm.js 的本地兜底**同语义**（换行/控制/不可见/双向控制
     → 单空格，折叠空白，去首尾）。它不是第二套 sanitizer，而是"canonical
     不可用"这一个分支上的最小等价物 —— canonical 可用时永远走 canonical。 */
  function conservativeClean(value, maxLength) {
    var s = String(value == null ? '' : value)
      .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\ufeff]/g, ' ')
      .replace(/[ ]{2,}/g, ' ')
      .trim();
    var cp = Array.from(s);
    if (maxLength > 0 && cp.length > maxLength) s = cp.slice(0, maxLength).join('').trim();
    return s;
  }
  /* 唯一的对外消毒入口：① 调用方注入的消毒器（role-dm.js 传它自己的
     sanitizeInput 包装）→ ② 本宿主上的 canonical 核心（浏览器 <script>
     载入时挂在 root 上，因此任何消费者都自动拿到同一份实现）→ ③ 保守兜底。
     最后**按码位**再截一次：canonical 未收到 maxLength 时不会截断，
     这一步让有界性不依赖注入方是否守约。 */
  function sanitizeText(value, maxLength, sanitizer) {
    var fn = (typeof sanitizer === 'function') ? sanitizer : null;
    if (!fn) {
      try {
        var host = root && root.IBPromptBoundaryCore;
        if (host && typeof host.sanitizePromptInput === 'function') fn = host.sanitizePromptInput;
      } catch (e) { fn = null; }
    }
    var out = callSanitize(fn, value, maxLength);
    if (typeof out !== 'string') out = conservativeClean(value, maxLength);
    if (maxLength > 0) {
      var cp = Array.from(out);
      if (cp.length > maxLength) out = cp.slice(0, maxLength).join('').trim();
    }
    return out;
  }

  /* ══════════ 4. 归一化 ══════════════
     任何畸形输入都必须得到一个**形状正确**的对象（绝不抛错、绝不返回
     undefined 字段）：调用点分布在 prompt 组装路径上，那里抛错会变成
     一整轮 run-error，而不是"少了一条公开信息"。 */
  function isPlainObject(v) {
    return !!v && typeof v === 'object' && !Array.isArray(v);
  }

  /* 列表字段：接受数组，也接受用户在一个输入框里敲的 "冷静, 克制、好奇"。
     去空、去重（保序）、逐项截断、整体限量。 */
  function normalizeList(value, itemLimit, countLimit, sanitizer) {
    var raw = [];
    if (Array.isArray(value)) raw = value.slice();
    else if (typeof value === 'string') raw = value.split(LIST_SEPARATORS);
    else if (value != null) raw = [value];
    var out = [];
    var seen = Object.create(null);
    for (var i = 0; i < raw.length && out.length < countLimit; i++) {
      var item = sanitizeText(raw[i], itemLimit, sanitizer);
      if (!item) continue;
      var key = item.toLowerCase();
      if (seen[key]) continue;
      seen[key] = true;
      out.push(item);
    }
    return out;
  }

  /* 归一化一份公开资料。**非对象输入 → 全空**（不是"猜一个"）。 */
  function normalizePublicProfile(raw, options) {
    var opts = isPlainObject(options) ? options : {};
    var sanitizer = opts.sanitize;
    var src = isPlainObject(raw) ? raw : {};
    return {
      publicIntro: sanitizeText(src.publicIntro, LIMITS.publicIntro, sanitizer),
      occupation: sanitizeText(src.occupation, LIMITS.occupation, sanitizer),
      traits: normalizeList(src.traits, LIMITS.traitItem, LIMITS.traits, sanitizer),
      interests: normalizeList(src.interests, LIMITS.interestItem, LIMITS.interests, sanitizer)
    };
  }

  function publicProfileIsEmpty(profile) {
    var p = isPlainObject(profile) ? profile : {};
    return !p.publicIntro && !p.occupation &&
      !(Array.isArray(p.traits) && p.traits.length) &&
      !(Array.isArray(p.interests) && p.interests.length);
  }

  /* ══════════ 5. 投影：apiConfigs 条目 → peer-visible view ══════════════
     这是本模块的**唯一出口**。输出对象由下面的字面量逐字段搭建 ——
     输入里的 systemPrompt / apiKey / endpoint / 任何凭据都**没有机会**
     出现在输出里（不是过滤，是构造）。

     fallback 优先级（安全优先于信息量）：
       ① 显式 publicProfile（逐字段独立回落）
       ② 既有真正公开字段：bio → signature
       ③ 只有 displayName
     ②之所以合法：bio/signature 本来就是 AI 社交网络主页对所有角色与用户
     展示的字段（social-network.js _netRoleView / mobile-dto.js characterDto），
     语义上就是公开的。**绝不**回落到 systemPrompt / relationship / memory。 */
  function buildPeerView(cfg, options) {
    var opts = isPlainObject(options) ? options : {};
    var c = isPlainObject(cfg) ? cfg : {};
    var sanitizer = opts.sanitize;

    var profile = normalizePublicProfile(c.publicProfile, { sanitize: sanitizer });

    /* ① 显式公开资料 */
    var intro = profile.publicIntro;
    var occupation = profile.occupation;
    var traits = profile.traits;
    var interests = profile.interests;
    var explicit = !publicProfileIsEmpty(profile);

    /* ② 既有真正公开字段（只补 publicIntro：bio/signature 都是"一句话介绍"，
          没有身份/特征/兴趣的语义，不挪用）。 */
    var legacy = false;
    if (!intro) {
      var bio = sanitizeText(c.bio, LIMITS.publicIntro, sanitizer);
      var signature = sanitizeText(c.signature, LIMITS.publicIntro, sanitizer);
      var picked = bio || signature;
      if (picked) { intro = picked; legacy = true; }
    }

    /* ③ 名字：显式传入优先（调用方有 canonical 的 nameOf），否则按 displayName
          的三级回落（与 social.js 的 effName / mobile-dto.js 同名同序）。 */
    var name = sanitizeText(
      opts.name !== undefined ? opts.name
        : (c.nickname || c.name || c.model || ''),
      64, sanitizer
    );

    var hasAny = !!(intro || occupation || traits.length || interests.length);
    return {
      name: name,
      publicIntro: intro,
      occupation: occupation,
      traits: traits,
      interests: interests,
      source: explicit ? SOURCE.PROFILE : (legacy ? SOURCE.LEGACY : SOURCE.NAME_ONLY)
    };
  }

  /* ══════════ 6. 渲染：view → peer 段的行 ══════════════
     只输出**已知**的行；一行都不知道时返回空数组（调用方回落到
     "名字"这一条 —— 安全优先，绝不为"丰富"补 persona）。
     标签刻意用"公开 X"，与 private 的措辞在字面上就不可混淆。 */
  function formatPeerProfileLines(view, options) {
    var opts = isPlainObject(options) ? options : {};
    var v = isPlainObject(view) ? view : {};
    var lines = [];
    if (v.publicIntro) lines.push('公开简介：' + sanitizeText(v.publicIntro, LIMITS.publicIntro, opts.sanitize));
    if (v.occupation) lines.push('公开身份：' + sanitizeText(v.occupation, LIMITS.occupation, opts.sanitize));
    if (Array.isArray(v.traits) && v.traits.length) {
      lines.push('公开特征：' + normalizeList(v.traits, LIMITS.traitItem, LIMITS.traits, opts.sanitize).join('、'));
    }
    if (Array.isArray(v.interests) && v.interests.length) {
      lines.push('兴趣：' + normalizeList(v.interests, LIMITS.interestItem, LIMITS.interests, opts.sanitize).join('、'));
    }
    return lines.filter(function (l) { return l.length > 0; });
  }

  /* 结构性检查：一个 peer view 的键是否**恰好**是白名单。测试与
     "未来新增字段默认不可见"这条性质的守卫共用同一份实现。 */
  function peerViewKeysAreClosed(view) {
    if (!isPlainObject(view)) return false;
    var keys = Object.keys(view);
    for (var i = 0; i < keys.length; i++) if (PEER_VIEW_KEYS.indexOf(keys[i]) < 0) return false;
    return true;
  }

  return {
    FIELDS: FIELDS,
    LIMITS: LIMITS,
    SOURCE: SOURCE,
    PRIVATE_FIELD_KEYS: PRIVATE_FIELD_KEYS,
    PEER_VIEW_KEYS: PEER_VIEW_KEYS,
    LIST_SEPARATORS: LIST_SEPARATORS,
    sanitizeText: sanitizeText,
    normalizeList: normalizeList,
    normalizePublicProfile: normalizePublicProfile,
    publicProfileIsEmpty: publicProfileIsEmpty,
    buildPeerView: buildPeerView,
    formatPeerProfileLines: formatPeerProfileLines,
    peerViewKeysAreClosed: peerViewKeysAreClosed
  };
});
