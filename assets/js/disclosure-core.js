/* ====================================================================
   IB Disclosure Core — 「角色自我事实的披露分级契约」的唯一实现
   --------------------------------------------------------------------
   UMD 双载：
     - Browser: <script src="assets/js/disclosure-core.js"> → window.IBDisclosureCore
     - Node   : require('../assets/js/disclosure-core.js')
   规则（与 public-profile-core.js / role-dm-core.js / memory-visibility-core.js 同款）：
   **零 window / 零 DOM / 零 fetch / 零 IndexedDB / 零 localStorage / 零副作用**。

   ── 它解决的是什么（Phase 4B-0 只读审计结论，不是推测）──────────────
   Phase 4B-1 之前，IB 里**不存在**任何能表达下面这句话的数据类型：

       「这是 A 的一条事实。它不是公开资料，它有明确的披露等级，
         而且这个等级不是从 persona、模型猜测或 trust 数字里临时推出来的。」

   既有 ACL（memory-visibility-core.js 的 `public|only|except|private`
   + visibleTo/excludeFrom）回答的是**"哪些消费方可以读这条记录"**。
   它回答不了**"这条内容本身有多敏感"**：
   `visibility:'only', visibleTo:['A']` 完全不区分
     · 「A 习惯凌晨工作」（偏好，说出来无所谓）
     · 「A 有一段不愿随便谈的经历」（说出来有代价）
   两者今天的存储形态**逐字节同构**。

   同时，审计还证明了三件**不能**被当成披露权威的东西：
     · `publicProfile`（public-profile-core.js）是**构造式白名单** ——
       它本来就是"允许公开"的定义本身，不是可以被 gate 的私密事实；
     · `systemPrompt` 是**运行时身份权威**（persona），不是事实数据库；
     · thread `memorandum` / recent history 是 **A 与 B 共享**的经历，
       不是 A 单方面的自我秘密。

   ══ Phase 4B-1.1（writer authority）：source 与 authority 是**两个维度** ══
   Phase 4B-1 用 `source`（内容经过哪个通道）作为等级上限的唯一依据。4B-1.1 的
   只读 writer 审计证明这是**不够**的，而且不够的方式是具体的：

     用户显式写下  「设定：昔涟很怕打雷，这是她不愿告诉别人的事。」
     模型在 Role DM 里说 「我可能其实很怕打雷。」

   两者可以经过**同一个通道**（同一个 character 编辑器 / 同一张 Memory 表 /
   同一条对话）。若上限只看通道，这两句话在类型上就无法区分 —— 而它们恰恰是
   本契约存在的理由。因此：

     · `source`    = **provenance**：内容从哪条通道产生。**不再**单独决定等级上限。
     · `authority` = **写者权威**：谁对"这条事实是本角色的秘密"这件事负责。
     · `authoredBy`= 该权威的**身份**（human authoring 必须实名，不接受匿名断言）。

   并且两者必须**互相印证**（§4b `authorityConflictsWithSource`）：
     authored 通道 ⇔ human 权威；derived 通道 ⇔ derived 权威。
   一个 `role_dm_conversation` 通道带上 `human_authoring` 是**矛盾**，
   整体拒绝 —— 否则跨字段组合会造出一个比两者都强的伪造权威。

   ── 本模块只做两件事 ─────────────────────────────────────────────
   定义 canonical 数据类型 + 归一化 + 封闭枚举 + provenance + **writer authority**。
   **不做授权、不做过滤、不接 Role DM、不读 trust、不读关系、不写任何 store。**

       canonical self facts → [本模块: classification] → authorization(4B-2, DEFERRED)
                                                       → AUTHORIZED FACTS ONLY
                                                       → composeSide → prompt

   ── 四条必须靠**代码结构**保证的性质（不是注释纪律）────────────────
   ① **fail closed**：没有人类写者权威（`authority` 缺失/畸形 → `derived`）时，
      **在构造阶段**就被降级为 `UNDETERMINED`，即在类型层面**不可能**持有
      PERSONAL/PRIVATE/SECRET。"模型推测出来的东西"没有资格自动升级成角色的
      秘密 —— 这不需要下游再检查一次。
   ② **legacy 不自动成为秘密**：缺失/非法 level 一律归 `UNDETERMINED`，
      它 `isDisclosureFact() === false`、`isClassified() === false`，
      因此**旧数据不进入披露子系统**（而不是"默认成 PRIVATE 更安全"——
      那会把每条没有元数据的旧记录都变成秘密，是 fail-**open** 到荒诞）。
   ③ **通道 ≠ 权威**：`source` 不再单独决定上限；跨字段矛盾组合整体拒绝。
   ④ **authority 不认匿名**：human 权威必须由 `authoredBy` 实名，
      而 `authoredBy` 与 owner 同规则归一（空白/控制字符 → 拒绝）——
      不能被 `createdBy` / `visibleTo` / 昵称 / 当前说话人顶替。
   ==================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); }
  else { root.IBDisclosureCore = factory(); }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ══════════ 1. 枚举（封闭）══════════════ */

  /* 披露等级。**四档的语义差异由"谁该看到"证明，不是因为名字好听**：

       level       intended audience              Role DM peer 最终可见?   需额外授权?
       ---------   ----------------------------   ----------------------   ----------
       PUBLIC      任何消费方（等价于已有公开层） 是（但**不经过本契约**） 否
       PERSONAL    角色自己；亲近者可了解         是（4B-2 后，需授权）   未来：是
       PRIVATE     角色自己；极少数人             是（4B-2 后，需授权）   未来：是
       SECRET      仅角色自己（默认不传播）       否（默认，除非显式授权） 未来：是

     `PUBLIC` 的 audience 与其他三档**量级不同**，因此它的默认行为也不同：
     它是"这条事实的公开权威在别处"（public-profile-core 的白名单 / bio），
     **本契约不是它的权威**。见 §5 `publicProfileWouldDoubleOwn`。 */
  var LEVELS = ['PUBLIC', 'PERSONAL', 'PRIVATE', 'SECRET'];

  /* 「尚未进入披露契约」——**不是第五档敏感度**，而是"这条记录不参与披露系统"。
     它与四档并列存放，是因为 normalize 必须有一个合法的落点；
     但它 `isClassified() === false`，任何授权/过滤都必须先把它排除。
     命名刻意与 memory-visibility-core 的 'invalid' 家族区分：这里是
     **类型层的 OUT_OF_SCOPE**，不是"坏数据"。 */
  var LEVEL = {
    PUBLIC: 'PUBLIC',
    PERSONAL: 'PERSONAL',
    PRIVATE: 'PRIVATE',
    SECRET: 'SECRET',
    /* 未参与披露契约：缺字段 / 非法值 / 未知档位 / provenance 不足以断言敏感度 */
    UNDETERMINED: 'UNDETERMINED'
  };

  /* 可参与披露授权的档位（UNDETERMINED 刻意不在内）。 */
  var CLASSIFIED_LEVELS = LEVELS.slice();

  /* 敏感度序（越大越敏感）。UNDETERMINED **无序号** —— 它不属于这个序列，
     因此任何"按序比较"的代码都不可能意外把它当成最低档放行。 */
  var LEVEL_RANK = { PUBLIC: 0, PERSONAL: 1, PRIVATE: 2, SECRET: 3 };

  /* 需要授权才能进入 peer 上下文的档位（PUBLIC 不需要 —— 它本来就公开）。
     **仅供 4B-2 使用，本模块不做任何授权判定。** */
  var GATED_LEVELS = [LEVEL.PERSONAL, LEVEL.PRIVATE, LEVEL.SECRET];

  /* ── provenance：事实从哪来 ────────────────────────────────────────
     分类的**唯一**依据是"谁写的"，不是"内容看起来像不像秘密"。 */
  var SOURCE = {
    /* ── AUTHORED：人有意识地写下一条角色事实 ── */
    CHARACTER_AUTHORING: 'character_authoring',  /* 角色设定撰写（人类作者） */
    USER_AUTHORING: 'user_authoring',            /* 用户明确写下 */
    USER_CORRECTION: 'user_correction',          /* 用户对已有理解的更正 */
    /* ── DERIVED：系统/模型推断、抽取、生成 ── */
    MEMORY_EXTRACTION: 'memory_extraction',      /* 既有 Memory 抽取候选 */
    ROLE_DM_CONVERSATION: 'role_dm_conversation',/* 角色私信里出现的内容 */
    DIARY: 'diary',                              /* 主动日记 */
    CONSOLIDATION: 'consolidation',              /* 记忆归纳产物 */
    GENERATED_INFERENCE: 'generated_inference',  /* 模型推断（最弱） */
    /* ── 兜底 ── */
    UNKNOWN: 'unknown'
  };

  /* **只有 authored 来源**才有资格宣称 PERSONAL/PRIVATE/SECRET。
     这不是"建议"—— §4 `normalizeDisclosureFact` 会据此**强制**降级。 */
  var AUTHORED_SOURCES = [
    SOURCE.CHARACTER_AUTHORING,
    SOURCE.USER_AUTHORING,
    SOURCE.USER_CORRECTION
  ];

  var SOURCES = [
    SOURCE.CHARACTER_AUTHORING, SOURCE.USER_AUTHORING, SOURCE.USER_CORRECTION,
    SOURCE.MEMORY_EXTRACTION, SOURCE.ROLE_DM_CONVERSATION, SOURCE.DIARY,
    SOURCE.CONSOLIDATION, SOURCE.GENERATED_INFERENCE, SOURCE.UNKNOWN
  ];

  /* ── writer authority：**谁**对"这是本角色的秘密"负责 ─────────────────
     这是 Phase 4B-1.1 新增的**第二维**。它回答的不是"内容从哪来"，而是
     "哪个人明确授权 IB 把它当作该角色的敏感事实"。

     为什么不能只留 source：见文件头。同一个通道既能承载人类显式写下的设定，
     也能承载模型自己生成的一句话；若上限只看通道，两者在类型上不可区分。

     为什么是这三个值（**由仓库里真实存在的写者证明，不是设计想象**）：

       human_authoring     人类在明确知道 owner 是谁的上下文里写下这条事实。
                           今天的唯一合法形态是"角色编辑器正在编辑角色 A"；
                           **本轮没有任何生产 writer 使用它**（见 DECISIONS D29）。
       human_confirmation  人类**确认**了系统先产出的 candidate。
                           语义：candidate 是模型产物（derived），只有显式确认
                           这一步把责任转移给人。本轮只定义，不实现确认流程。
       derived             系统/模型抽取、推断、生成的一切，以及**一切畸形、
                           缺失、无法识别**的 authority（fail closed）。

     关键：`derived` 不是"低人一等"，而是"**没有人类对这个断言负责**"。
     因此它的等级上限是 PUBLIC —— 一条模型自己说的"我其实很怕打雷"最多
     只能是一条公开可说的观察，不能自动变成角色的秘密。 */
  var AUTHORITY = {
    HUMAN_AUTHORING: 'human_authoring',
    HUMAN_CONFIRMATION: 'human_confirmation',
    DERIVED: 'derived'
  };

  /* 只有这两者是人类权威（=需要实名 authoredBy）。 */
  var HUMAN_AUTHORITIES = [AUTHORITY.HUMAN_AUTHORING, AUTHORITY.HUMAN_CONFIRMATION];

  /* 封闭枚举：合法值原样通过，其余一切 → derived（fail closed）。
     与 level 不同，这里的 fail closed 落点是**最低权威**而不是"未分类"：
     因为 authority 描述的是"谁负责"，而"不知道谁负责"的正确答案就是
     "没有人负责"，不是"不参与披露契约" —— 一条记录仍然可以有 author。 */
  var AUTHORITIES = [AUTHORITY.HUMAN_AUTHORING, AUTHORITY.HUMAN_CONFIRMATION, AUTHORITY.DERIVED];

  /* 权威 → 允许声称的最高档位。**这是本契约唯一的等级上限来源。** */
  var MAX_LEVEL_FOR_AUTHORITY = {};
  MAX_LEVEL_FOR_AUTHORITY[AUTHORITY.HUMAN_AUTHORING] = 'SECRET';
  MAX_LEVEL_FOR_AUTHORITY[AUTHORITY.HUMAN_CONFIRMATION] = 'SECRET';
  MAX_LEVEL_FOR_AUTHORITY[AUTHORITY.DERIVED] = 'PUBLIC';

  /* ── 拒绝原因（诊断用；**不含正文**）── */
  var REJECT = {
    NOT_AN_OBJECT: 'not-an-object',
    MISSING_OWNER: 'missing-owner',
    MISSING_TEXT: 'missing-text',
    NOT_CLASSIFIED: 'not-classified',
    SELF_OWNED_PEER: 'owner-is-not-self',      /* 预留：调用方传错了方向 */
    TEXT_DENYLISTED: 'text-denylisted',
    /* Phase 4B-1.1 新增：通道与写者权威互相矛盾（整体拒绝，不静默改写任一维）。 */
    AUTHORITY_SOURCE_CONFLICT: 'authority-source-conflict',
    /* "没有人类对它负责"却带着一个写者身份 —— 自相矛盾，且会让下游误读成人类授权。 */
    DERIVED_WITH_PRINCIPAL: 'derived-authority-with-principal'
  };

  /* ── 结构性硬拒名单 ──────────────────────────────────────────────
     这些内容**永远**不能成为 disclosure fact，无论 level 写什么。
     理由不是"敏感度不够"，而是**它们根本不是角色事实**：

       · systemPrompt / persona —— 身份权威，不是事实数据库；
       · publicProfile —— 公开权威在别处（会制造第二权威）；
       · apiKey / endpoint / Authorization —— SYSTEM_PRIVATE，永不可 peer 可见；
       · memorandum / thread history —— A 与 B **共享**的经历，不是 A 的秘密。

     检查的是**字段名与显式标记**，不猜正文语义（"模型自行判断什么是 secret"
     在本轮被明确禁止）。 */
  var DENY_FIELDS = [
    'systemPrompt', 'system_prompt', 'persona',
    'publicProfile', 'publicIntro', 'occupation', 'traits', 'interests',
    'apiKey', 'api_key', 'endpoint', 'authorization', 'cookie',
    'memorandum', 'threadMemorandum', 'visibleTo', 'excludeFrom'
  ];
  var DENY_FLAG = 'isDisclosureFact';   /* 自引用/伪造标记 */
  var DENY_DOMAIN = ['SYSTEM_PRIVATE', 'PUBLIC_PROFILE', 'SELF_IDENTITY', 'SHARED_THREAD'];

  var TEXT_MAX = 500;

  /* ══════════ 2. 纯工具 ═══════════════ */
  function str(v) { return String(v == null ? '' : v); }

  function isPlainObject(v) {
    return !!v && typeof v === 'object' && !Array.isArray(v);
  }

  /* 文本归一化：**先**剥控制字符（含 NUL / ESC / 各类换行注入），再 trim、再截断。
     顺序不可颠倒 —— 先截断会把控制字符留在边界内。

     非字符串（数组 / 对象 / 布尔 / null）：一律当**没有正文**处理，**绝不**
     `String()` 之后塞进来 —— `String(['x']) === 'x'`，那会把一个畸形结构
     悄悄变成一条看起来完全正常的真实事实。 */
  function normalizeText(v) {
    if (typeof v !== 'string') return '';
    var s = v;
    /* C0/C1 控制字符：只保留 \t 与 \n（它们在 prompt 里是正常排版）。
       U+2028/2029 是 JS 行分隔符，一并剥掉。 */
    s = s.replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u2028\u2029]/g, '');
    s = s.replace(/\r\n/g, '\n').trim();
    return s.slice(0, TEXT_MAX);
  }

  function normalizeId(v) {
    var s = str(v).trim();
    /* 分隔符与空白一律拒绝：id 会被当作 ACL / 分区的键，注入分隔符会伪造归属。 */
    if (!s || s.length > 200) return '';
    if (/[\u0000-\u001F\u007F\s]/.test(s)) return '';
    return s;
  }

  function rand36(n) {
    var out = '';
    while (out.length < (n || 10)) out += Math.random().toString(36).slice(2);
    return out.slice(0, n || 10);
  }

  /* ══════════ 3. level 归一化（fail closed）══════════════ */

  /* 合法档位原样返回；**其余一切**（null / undefined / 数字 / 数组 / 对象 /
     未知字符串 / 大小写变体）返回 UNDETERMINED。

     刻意**不做** case-insensitive 匹配，也**不做** 'secret ' → SECRET 之类的
     宽松修正：宽松归一化的第一个后果就是"某天一个畸形值变成了 SECRET"或
     "一个畸形值变成了 PUBLIC"。**闭合枚举只认精确匹配。** */
  function normalizeDisclosureLevel(v) {
    if (typeof v !== 'string') return LEVEL.UNDETERMINED;
    return LEVELS.indexOf(v) >= 0 ? v : LEVEL.UNDETERMINED;
  }

  /* 这条记录是否**已经进入**披露契约（有明确档位）。
     UNDETERMINED → false ⇒ 它不在披露子系统内，必须被授权/过滤层排除。 */
  function isClassified(level) {
    return normalizeDisclosureLevel(level) !== LEVEL.UNDETERMINED;
  }

  /* 敏感度序。UNDETERMINED → **null**（不是 0，也不是 -1）：
     没有序号 ⇒ 调用方无法把它当成"最低档"放行，只能显式处理它。 */
  function levelRank(level) {
    var l = normalizeDisclosureLevel(level);
    if (l === LEVEL.UNDETERMINED) return null;
    return LEVEL_RANK[l];
  }

  function isGatedLevel(level) {
    return GATED_LEVELS.indexOf(normalizeDisclosureLevel(level)) >= 0;
  }

  /* ══════════ 4. source（通道）+ authority（写者权威）══════════════ */

  function normalizeDisclosureSource(v) {
    if (typeof v !== 'string') return SOURCE.UNKNOWN;
    return SOURCES.indexOf(v) >= 0 ? v : SOURCE.UNKNOWN;
  }

  /* 该通道是否是"人类显式撰写"类通道。**注意它不再单独决定任何等级上限** ——
     它现在的用途是**交叉校验**：人类权威必须走人类通道，反之亦然。
     保留函数名与行为以便既有调用方与测试逐字不变。 */
  function isAuthoredSource(source) {
    return AUTHORED_SOURCES.indexOf(normalizeDisclosureSource(source)) >= 0;
  }

  /* ══════════ 4b. writer authority 归一化 + 交叉校验 ══════════════ */

  function normalizeDisclosureAuthority(v) {
    if (typeof v !== 'string') return AUTHORITY.DERIVED;
    return AUTHORITIES.indexOf(v) >= 0 ? v : AUTHORITY.DERIVED;
  }

  /* 人类权威（需要 authoredBy 实名）。 */
  function isHumanAuthority(v) {
    return HUMAN_AUTHORITIES.indexOf(normalizeDisclosureAuthority(v)) >= 0;
  }

  /* 权威 → 等级上限。**唯一来源。** source 不参与。 */
  function maxLevelForAuthority(v) {
    return MAX_LEVEL_FOR_AUTHORITY[normalizeDisclosureAuthority(v)];
  }

  /* 通道与权威是否互相印证。返回 true = 矛盾（调用方必须整体拒绝）。

     两个方向都查，而且**两个方向的不对称是有意的**：

       · 非人类通道 + 人类权威 → 矛盾。
         `role_dm_conversation` + `human_authoring` 是用跨字段组合造出一个
         比任一字段单独都强的伪造权威 —— 模型自己说的话借人类的名义升级。

       · 人类通道 + 非人类权威 → **同样**矛盾，包括 `derived`。
         `user_authoring` / `character_authoring` / `user_correction` 是
         "只有人类写作路径能到达"的通道（writer 审计结论，见 D29）；
         一条走人类通道却声明"没有人对它负责"的记录是自相矛盾的，
         而且它比**只给通道**的记录更弱 —— 证据更多却结论更弱，说明调用方在猜。
         这是 fail closed 的方向：不静默把它当成人类权威继续用。

     返回值只用归一化后的枚举，不做任何近似匹配。 */
  function authorityConflictsWithSource(source, authority) {
    var s = normalizeDisclosureSource(source);
    var a = normalizeDisclosureAuthority(authority);
    return isAuthoredSource(s) !== isHumanAuthority(a);
  }

  /* ── 兼容用法：把"只给了 source、没给 authority"输入映射成等价 authority。
     规则：authored 来源 → `human_authoring`（语义即"由人类撰写"）；
           其余一切     → `derived`。

     **这是迁移适配器，不是等级权威**：它只在 authority 维度**没有**被显式给出
     时才使用（见 `normalizeDisclosureFact`）。一旦调用方显式给了 `authority`，
     通道不再参与上限计算，只参与上面的矛盾检查。
     保留它是因为 Phase 4B-1 冻结的 H 组行为必须逐字不变（`source` 单独出现时
     authored→SECRET、其余→PUBLIC），而 4B-1 的调用形状里没有 authority 字段。

     它同时保证归一化**幂等**：authored 通道推导出的 `human_authoring` 与
     非人类通道推导出的 `derived` 都经由 `authorityConflictsWithSource` 判断为
     自洽，因此 `normalize(normalize(x))` 与 `normalize(x)` 逐字节相同。 */
  function authorityForSource(source) {
    return isAuthoredSource(source) ? AUTHORITY.HUMAN_AUTHORING : AUTHORITY.DERIVED;
  }

  /* ══════════ 5. 结构性拒绝 ══════════════ */

  /* 输入对象是否携带**结构性禁用字段**（persona / publicProfile / SYSTEM_PRIVATE
     键 / 共享 thread 键 / 自引用标记 / 被保留为披露子系统的 domain 名）。 */
  function denylistHits(input) {
    var hits = [];
    if (!isPlainObject(input)) return hits;
    for (var i = 0; i < DENY_FIELDS.length; i++) {
      var k = DENY_FIELDS[i];
      if (Object.prototype.hasOwnProperty.call(input, k)) hits.push(k);
    }
    if (Object.prototype.hasOwnProperty.call(input, DENY_FLAG)) hits.push(DENY_FLAG);
    /* `domain` 只能声明**非披露**数据域。SYSTEM_PRIVATE / PUBLIC_PROFILE /
       SELF_IDENTITY / SHARED_THREAD 是"永远不可作为 Role DM 披露内容"或
       "公开权威在别处"的域，写进来即拒绝。 */
    if (DENY_DOMAIN.indexOf(str(input.domain)) >= 0) hits.push('domain:' + str(input.domain));
    /* text 显式声明自己属于哪个数据域时同理（`domain:` 前缀标记，
       供未来调用方标注；不解析自然语言）。 */
    var d = str(input.text).slice(0, 64);
    for (var j = 0; j < DENY_DOMAIN.length; j++) {
      if (d.indexOf('[domain:' + DENY_DOMAIN[j] + ']') >= 0) { hits.push('text-domain:' + DENY_DOMAIN[j]); break; }
    }
    return hits;
  }

  /* publicProfile 的公开权威**不在**本契约。若一条 disclosure fact 声称自己是
     PUBLIC 且内容与公开资料同构（携带公开资料键），它就是在制造第二份公开权威。
     返回 true = 调用方应当直接拒绝，而不是"归一化后照用"。 */
  function publicProfileWouldDoubleOwn(input) {
    if (!isPlainObject(input)) return false;
    if (normalizeDisclosureLevel(input.level) !== LEVEL.PUBLIC) return false;
    var keys = ['publicIntro', 'occupation', 'traits', 'interests', 'profile'];
    for (var i = 0; i < keys.length; i++) {
      if (Object.prototype.hasOwnProperty.call(input, keys[i])) return true;
    }
    return str(input.source) === 'public_profile' || str(input.domain) === 'PUBLIC_PROFILE';
  }

  /* ══════════ 6. canonical 记录 ══════════════ */

  /* 字段只有九个（Phase 4B-1 的七个 + 4B-1.1 的 authority / authoredBy）。
     **刻意不加** confidence / tags / visibility / audience / visibleTo ——
     每个都要证明它不可被既有权威表达：
       · confidence / tags      → 既有 Memory 已有，复制即第二权威；
       · visibility / visibleTo → memory-visibility-core 的 ACL，本契约不碰；
       · audience               → 由 level + owner 唯一决定，存下来就会分叉。

     为什么 authority 与 authoredBy 是**两个**字段而不是一个：
       `authoredBy` 是身份，`authority` 是这一次写入的**动作性质**。同一个人类
       在同一个编辑器里既可以"写下一条新事实"（human_authoring），也可以
       "确认一条系统候选"（human_confirmation）—— 这两者的语义不同（后者意味着
       存在一条被否定的 candidate 来源），而身份是同一个人。把两者压成一个字段
       就必须在身份字符串里编码动作，那正是"偷偷重载字段"。 */
  function buildDisclosureFact(opts) {
    var o = isPlainObject(opts) ? opts : {};
    var owner = normalizeId(o.ownerCharacterId);
    var source = normalizeDisclosureSource(o.source);
    /* authority 维度：显式给出则以它为准，否则由通道适配出等价权威。 */
    var explicit = normalizeDisclosureAuthority(o.authority);
    var authority = (o.authority != null) ? explicit : authorityForSource(source);
    var authoredBy = normalizeId(o.authoredBy);
    var requested = normalizeDisclosureLevel(o.level);
    /* 结构性降级：请求的档位若高于**写者权威**允许的上限 → 落到上限。
       （derived 请求 SECRET ⇒ 实际 PUBLIC，并记下 trimmed。见 §7） */
    var maxLevel = maxLevelForAuthority(authority);
    var granted = requested;
    if (requested !== LEVEL.UNDETERMINED && LEVEL_RANK[requested] > LEVEL_RANK[maxLevel]) granted = maxLevel;
    var now = Number(o.now);
    if (!isFinite(now) || now <= 0) now = Date.now();
    var subject = normalizeId(o.subjectCharacterId);
    return {
      factId: normalizeId(o.factId) || ('disc_' + Date.now().toString(36) + '_' + rand36(6)),
      ownerCharacterId: owner,
      level: granted,
      text: normalizeText(o.text),
      source: source,
      authority: authority,
      authoredBy: isHumanAuthority(authority) ? authoredBy : '',
      subjectCharacterId: subject,   /* '' = 无所谓对象（关于角色自己的事实） */
      updatedAt: Math.trunc(now)
    };
  }

  /* 归一化既有/外来记录。**绝不抛异常，绝不返回 null 之外的东西**。
     返回 null 的情形只有两种：不是普通对象，或无法确定 owner。
     ——"无法确定 owner"必须整体拒绝，因为 owner 正是未来方向性授权的依据：
       猜一个 owner（例如回落到 subject / 'user' / 第一个可见者）等于伪造归属。 */
  function normalizeDisclosureFact(input) {
    if (!isPlainObject(input)) return null;
    /* 结构性禁用字段：整体拒绝，不做"删掉再继续"—— 静默删字段会让调用方
       以为自己成功提交了一个 persona 派生事实。 */
    if (denylistHits(input).length) return null;
    if (publicProfileWouldDoubleOwn(input)) return null;
    var owner = normalizeId(input.ownerCharacterId);
    if (!owner) return null;
    /* owner 不接受从其它键推断：既不看 createdBy，也不看 visibleTo[0]。
       （memory-contract.js 早已警告过 owner_id 是**分区键**，不是 ACL；
        本契约更窄：owner 是**披露主体**，必须显式给出。） */
    var rawLevel = input.level;
    /* 非法/缺失 level ⇒ UNDETERMINED（**不是** PUBLIC，也不是 PRIVATE）。 */
    var level = normalizeDisclosureLevel(rawLevel);
    var source = normalizeDisclosureSource(input.source);
    /* authority：显式给出则以它为准（畸形值 → derived，见 normalizeDisclosureAuthority），
       否则由通道适配。authoredBy 与 owner 同规则归一 —— 空白/控制字符/超长一律
       视为**没有实名写者**，而不是"清洗后当成一个人"。 */
    var authority = (input.authority != null)
      ? normalizeDisclosureAuthority(input.authority)
      : authorityForSource(source);
    var authoredBy = normalizeId(input.authoredBy);
    /* ① 通道 ⇔ 权威 必须互相印证。 */
    if (authorityConflictsWithSource(source, authority)) return null;
    /* ② 非人类权威不得携带写者身份 —— 那是自相矛盾（"没人负责"却有负责人），
       而且会让下游把 derived 记录误读成人类授权。整体拒绝，不静默清空字段。 */
    if (!isHumanAuthority(authority) && authoredBy) return null;
    /* ③ 人类权威**不要求** authoredBy。这是一个刻意的、写下来的限制：

       人类权威来自**通道的结构性事实**（character_authoring / user_authoring /
       user_correction 在代码里只有人类写作路径能到达，见 §4b）。它不是由
       `authoredBy` 这个字符串建立的 —— 一个纯函数里，任何人都能写下
       `authoredBy:'user'`，所以"必须实名"在类型层拦不住想绕过它的人，
       它只会制造一道**看起来像门**的检查。

       如果这里拒绝空 authoredBy，就会同时拒绝掉 Phase 4B-1 冻结的调用形状
       `{owner, level, text, source}`，以及**本模块自己归一化出来的记录**
       （归一化输出的 authoredBy 恒为空）—— 即 normalize 不再幂等。
       一条"输出不是自己的合法输入"的契约是坏的契约，所以这里不设该检查。

       `authoredBy` 的值因此是**可选的旁证**（谁在场的记录），不是授权本身；
       真正的授权载体是 authority + 通道。docs/DECISIONS.md D29 如实记录了这一点。 */
    /* ③ 非人类权威不得携带写者身份（否则会在下游被误读成人类权威）。 */
    if (!isHumanAuthority(authority)) authoredBy = '';
    if (level !== LEVEL.UNDETERMINED) {
      var maxLevel = maxLevelForAuthority(authority);
      if (LEVEL_RANK[level] > LEVEL_RANK[maxLevel]) level = maxLevel;
    }
    var now = Number(input.updatedAt);
    if (!isFinite(now) || now <= 0) now = 0;   /* 缺失时间戳落 0：**绝不**写"现在"，
                                                  那会让损坏记录在排序里跳到最新 */
    return {
      factId: normalizeId(input.factId),
      ownerCharacterId: owner,
      level: level,
      text: normalizeText(input.text),
      source: source,
      authority: authority,
      authoredBy: authoredBy,
      subjectCharacterId: normalizeId(input.subjectCharacterId),
      updatedAt: Math.trunc(now)
    };
  }

  /* 一条记录是否**是一条可用的 disclosure fact**。四项全中才算：
     ① 归一出对象 ② 有 owner ③ 已分类（≠ UNDETERMINED）④ 有正文。

     注意 ③：**缺 level 不是"默认 PUBLIC"，是"不参与披露契约"**。
     这正是 legacy 安全性的实现点 —— 旧数据从不因为"没有元数据"而获得任何
     peer 可见路径（它连披露子系统都不进）。 */
  function isDisclosureFact(input) {
    var rec = normalizeDisclosureFact(input);
    if (!rec) return false;
    if (!rec.ownerCharacterId) return false;
    if (!isClassified(rec.level)) return false;
    if (!rec.text) return false;
    return true;
  }

  /* 诊断用（**不含正文**）：为什么这条被拒/被降级。

     Phase 4B-1.1：多一个**拒因消歧**步骤。`normalizeDisclosureFact` 返回 null
     有三种原因（无 owner / 通道与权威矛盾 / 人类权威缺实名），而 explain 必须
     如实说出是哪一种 —— 否则调用方会把"我伪造了权威"读成"我忘了写 owner"，
     于是去补 owner，再失败一次，永远学不到真正的拒绝理由。
     消歧用与 normalize 相同的判定函数，不复制逻辑。 */
  function explain(input) {
    var out = {
      ok: false, reason: '', level: '', ownerCharacterId: '', source: '',
      authority: '', authoredBy: '', trimmed: false, downgradedBy: ''
    };
    if (!isPlainObject(input)) { out.reason = REJECT.NOT_AN_OBJECT; return out; }
    var hits = denylistHits(input);
    if (hits.length) { out.reason = REJECT.TEXT_DENYLISTED; out.fields = hits.slice(); return out; }
    if (publicProfileWouldDoubleOwn(input)) { out.reason = REJECT.TEXT_DENYLISTED; out.fields = ['public-profile-double-authority']; return out; }
    /* 权威维度的拒因消歧（顺序与 normalizeDisclosureFact 内的检查顺序一致）。 */
    var src = normalizeDisclosureSource(input.source);
    var auth = (input.authority != null)
      ? normalizeDisclosureAuthority(input.authority)
      : authorityForSource(src);
    if (authorityConflictsWithSource(src, auth)) {
      out.reason = REJECT.AUTHORITY_SOURCE_CONFLICT;
      out.source = src; out.authority = auth;
      return out;
    }
    if (!isHumanAuthority(auth) && normalizeId(input.authoredBy)) {
      out.reason = REJECT.DERIVED_WITH_PRINCIPAL;
      out.source = src; out.authority = auth;
      return out;
    }
    var rec = normalizeDisclosureFact(input);
    if (!rec) { out.reason = REJECT.MISSING_OWNER; return out; }
    out.level = rec.level;
    out.ownerCharacterId = rec.ownerCharacterId;
    out.source = rec.source;
    out.authority = rec.authority;
    out.authoredBy = rec.authoredBy;
    var req = normalizeDisclosureLevel(input.level);
    out.trimmed = req !== LEVEL.UNDETERMINED && req !== rec.level;
    /* 降级是**谁的**责任：写者权威的上限。让诊断能区分"因为来源是模型"
       和"因为写者不是人" —— 在 4B-1.1 里这两件事不再是同一件事。 */
    if (out.trimmed) out.downgradedBy = 'authority:' + rec.authority;
    if (!rec.text) { out.reason = REJECT.MISSING_TEXT; return out; }
    if (!isClassified(rec.level)) { out.reason = REJECT.NOT_CLASSIFIED; return out; }
    out.ok = true;
    return out;
  }

  /* ══════════ 7. 方向性（**语义声明，不实现授权**）══════════════

     Phase 4B-2 未来读取的**唯一**合法形状：

         speakerId = A, peerId = B
         facts  = A-owned facts            （ownerCharacterId === A）
         rel    = relationGet(A, B)        （**有向**：A→B）

     明确排除（写在这里，免得未来"顺手"实现成对称的）：
       · B-owned facts            —— B 的秘密与"A 对 B 说什么"无关；
       · max(A→B, B→A) / 平均     —— 有向关系合成不是对称的；
       · owner ∋ visibleTo 之类    —— 那是 ACL，不是披露主体。

     本函数只回答"这条事实归属谁"，**不读 trust、不读关系、不返回可否披露**。
     它存在是为了让"方向搞反"这件事在测试里可以被直接钉住。 */
  function ownedBy(fact, speakerId) {
    var rec = normalizeDisclosureFact(fact);
    if (!rec) return false;
    var s = normalizeId(speakerId);
    if (!s || !rec.ownerCharacterId) return false;
    return rec.ownerCharacterId === s;
  }

  /* 方向性读取的 canonical 输入（仅数据整形，不含任何判定）。 */
  function disclosureScope(speakerId, peerId, facts) {
    var speaker = normalizeId(speakerId);
    var peer = normalizeId(peerId);
    var list = Array.isArray(facts) ? facts : [];
    var owned = [];
    for (var i = 0; i < list.length; i++) {
      if (ownedBy(list[i], speaker)) owned.push(normalizeDisclosureFact(list[i]));
    }
    return {
      speakerId: speaker,
      peerId: peer,
      /* 只有 speaker 自己拥有的事实才可能进入候选集。peer 拥有的一律不在内。 */
      candidates: owned,
      /* 未来授权的输入名（**本轮不读取**，只是把契约写死在这里）。 */
      relationKeyFrom: speaker,
      relationKeyTo: peer
    };
  }

  /* ══════════ 8. 序列化契约 ═══════════════ */

  /* 稳定字符串化：键序固定，便于幂等比较与镜像。**不含遥测剔除**（本记录
     没有遥测字段）；未知字段在 normalize 阶段已被丢弃，因此不存在
     "未知字段往返"问题 —— 这是与 memory-contract.js 的**刻意差异**：
     记忆是既有数据（必须能往返未知字段），disclosure fact 是新类型（必须封闭）。 */
  var FIELD_ORDER = ['factId', 'ownerCharacterId', 'level', 'text', 'source', 'authority', 'authoredBy', 'subjectCharacterId', 'updatedAt'];

  function serialize(fact) {
    var rec = normalizeDisclosureFact(fact);
    if (!rec) return '';
    var parts = [];
    for (var i = 0; i < FIELD_ORDER.length; i++) {
      var k = FIELD_ORDER[i];
      parts.push(JSON.stringify(k) + ':' + JSON.stringify(rec[k]));
    }
    return '{' + parts.join(',') + '}';
  }

  /* 两条记录内容是否相同（**不**看 factId / updatedAt —— 它们是身份与时间，
     不是内容）。authority / authoredBy **算**内容：同样的正文由人授权与由模型
     生成是两条不同的事实，把它们判成"内容相同"正是本阶段要禁止的混淆。 */
  function contentIdentical(a, b) {
    var x = normalizeDisclosureFact(a), y = normalizeDisclosureFact(b);
    if (!x || !y) return false;
    return x.ownerCharacterId === y.ownerCharacterId
      && x.level === y.level
      && x.text === y.text
      && x.source === y.source
      && x.authority === y.authority
      && x.authoredBy === y.authoredBy
      && x.subjectCharacterId === y.subjectCharacterId;
  }

  /* ══════════ 9. 导出 ═══════════════
     **没有** authorize() / filter() / canDisclose() —— 授权属 Phase 4B-2，
     在本轮被明确禁止实现。导出表里不存在这些名字，是刻意的：
     "未实现" 应当是**找不到函数**，而不是"有个函数永远返回 true"。 */
  return {
    LEVELS: LEVELS,
    LEVEL: LEVEL,
    CLASSIFIED_LEVELS: CLASSIFIED_LEVELS,
    LEVEL_RANK: LEVEL_RANK,
    GATED_LEVELS: GATED_LEVELS,
    SOURCE: SOURCE,
    SOURCES: SOURCES,
    AUTHORED_SOURCES: AUTHORED_SOURCES,
    AUTHORITY: AUTHORITY,
    AUTHORITIES: AUTHORITIES,
    HUMAN_AUTHORITIES: HUMAN_AUTHORITIES,
    MAX_LEVEL_FOR_AUTHORITY: MAX_LEVEL_FOR_AUTHORITY,
    REJECT: REJECT,
    DENY_FIELDS: DENY_FIELDS,
    DENY_DOMAIN: DENY_DOMAIN,
    TEXT_MAX: TEXT_MAX,
    FIELD_ORDER: FIELD_ORDER,

    normalizeDisclosureLevel: normalizeDisclosureLevel,
    normalizeDisclosureSource: normalizeDisclosureSource,
    normalizeDisclosureFact: normalizeDisclosureFact,
    normalizeText: normalizeText,
    isClassified: isClassified,
    isGatedLevel: isGatedLevel,
    levelRank: levelRank,
    isAuthoredSource: isAuthoredSource,
    normalizeDisclosureAuthority: normalizeDisclosureAuthority,
    isHumanAuthority: isHumanAuthority,
    maxLevelForAuthority: maxLevelForAuthority,
    authorityForSource: authorityForSource,
    authorityConflictsWithSource: authorityConflictsWithSource,
    denylistHits: denylistHits,
    publicProfileWouldDoubleOwn: publicProfileWouldDoubleOwn,
    buildDisclosureFact: buildDisclosureFact,
    isDisclosureFact: isDisclosureFact,
    explain: explain,
    ownedBy: ownedBy,
    disclosureScope: disclosureScope,
    serialize: serialize,
    contentIdentical: contentIdentical
  };
});
