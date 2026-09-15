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

   ── 本模块只做一件事 ─────────────────────────────────────────────
   定义 canonical 数据类型 + 归一化 + 封闭枚举 + provenance 等级。
   **不做授权、不做过滤、不接 Role DM、不读 trust、不读关系。**

       canonical self facts → [本模块: classification] → authorization(4B-2, DEFERRED)
                                                       → AUTHORIZED FACTS ONLY
                                                       → composeSide → prompt

   ── 两条必须靠**代码结构**保证的性质（不是注释纪律）────────────────
   ① **fail closed**：任何 non-authored（generated/inferred）来源**在构造阶段**
      就被降级为 `UNDETERMINED`，即在类型层面**不可能**持有 PERSONAL/PRIVATE/SECRET。
      "模型推测出来的东西"没有资格自动升级成角色的秘密 —— 这不需要下游再检查一次。
   ② **legacy 不自动成为秘密**：缺失/非法 level 一律归 `UNDETERMINED`，
      它 `isDisclosureFact() === false`、`isClassified() === false`，
      因此**旧数据不进入披露子系统**（而不是"默认成 PRIVATE 更安全"——
      那会把每条没有元数据的旧记录都变成秘密，是 fail-**open** 到荒诞）。
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

  /* ── 拒绝原因（诊断用；**不含正文**）── */
  var REJECT = {
    NOT_AN_OBJECT: 'not-an-object',
    MISSING_OWNER: 'missing-owner',
    MISSING_TEXT: 'missing-text',
    NOT_CLASSIFIED: 'not-classified',
    SELF_OWNED_PEER: 'owner-is-not-self',      /* 预留：调用方传错了方向 */
    TEXT_DENYLISTED: 'text-denylisted'
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

  /* ══════════ 4. source 归一化 + 授权上限（结构性降级）══════════════ */

  function normalizeDisclosureSource(v) {
    if (typeof v !== 'string') return SOURCE.UNKNOWN;
    return SOURCES.indexOf(v) >= 0 ? v : SOURCE.UNKNOWN;
  }

  function isAuthoredSource(source) {
    return AUTHORED_SOURCES.indexOf(normalizeDisclosureSource(source)) >= 0;
  }

  /* 该来源**在类型上**被允许声称的最高档位。

     authored  → SECRET
     其余一切 → PUBLIC

     后半句是本契约最重要的一行：`memory_extraction` / `generated_inference` /
     `role_dm_conversation` / `diary` / `consolidation` **不可能**持有
     PERSONAL 以上档位。因此"模型推测出一条'角色害怕 X'，然后它变成 PRIVATE"
     在归一化阶段就已经被消灭，下游不需要再防。 */
  function maxLevelForSource(source) {
    return isAuthoredSource(source) ? LEVEL.SECRET : LEVEL.PUBLIC;
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

  /* 字段只有七个。**刻意不加** confidence / tags / visibility / audience /
     visibleTo —— 每个都要证明它不可被既有权威表达：
       · confidence / tags      → 既有 Memory 已有，复制即第二权威；
       · visibility / visibleTo → memory-visibility-core 的 ACL，本契约不碰；
       · audience               → 由 level + owner 唯一决定，存下来就会分叉。 */
  function buildDisclosureFact(opts) {
    var o = isPlainObject(opts) ? opts : {};
    var owner = normalizeId(o.ownerCharacterId);
    var source = normalizeDisclosureSource(o.source);
    var requested = normalizeDisclosureLevel(o.level);
    /* 结构性降级：请求的档位若高于来源在类型上允许的上限 → 落到上限。
       （non-authored 请求 SECRET ⇒ 实际 PUBLIC，并记下 trimmed。见 §7） */
    var maxLevel = maxLevelForSource(source);
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
    if (level !== LEVEL.UNDETERMINED) {
      var maxLevel = maxLevelForSource(source);
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

  /* 诊断用（**不含正文**）：为什么这条被拒/被降级。 */
  function explain(input) {
    var out = { ok: false, reason: '', level: '', ownerCharacterId: '', source: '', trimmed: false };
    if (!isPlainObject(input)) { out.reason = REJECT.NOT_AN_OBJECT; return out; }
    var hits = denylistHits(input);
    if (hits.length) { out.reason = REJECT.TEXT_DENYLISTED; out.fields = hits.slice(); return out; }
    if (publicProfileWouldDoubleOwn(input)) { out.reason = REJECT.TEXT_DENYLISTED; out.fields = ['public-profile-double-authority']; return out; }
    var rec = normalizeDisclosureFact(input);
    if (!rec) { out.reason = REJECT.MISSING_OWNER; return out; }
    out.level = rec.level;
    out.ownerCharacterId = rec.ownerCharacterId;
    out.source = rec.source;
    var req = normalizeDisclosureLevel(input.level);
    out.trimmed = req !== LEVEL.UNDETERMINED && req !== rec.level;
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
  var FIELD_ORDER = ['factId', 'ownerCharacterId', 'level', 'text', 'source', 'subjectCharacterId', 'updatedAt'];

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
     不是内容）。 */
  function contentIdentical(a, b) {
    var x = normalizeDisclosureFact(a), y = normalizeDisclosureFact(b);
    if (!x || !y) return false;
    return x.ownerCharacterId === y.ownerCharacterId
      && x.level === y.level
      && x.text === y.text
      && x.source === y.source
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
    maxLevelForSource: maxLevelForSource,
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
