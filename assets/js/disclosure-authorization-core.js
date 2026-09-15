/* ====================================================================
   IB Disclosure Authorization Core — 「角色 A 的事实能否披露给角色 B」的唯一判定
   --------------------------------------------------------------------
   UMD 双载：
     - Browser: <script src="assets/js/disclosure-authorization-core.js"> → window.IBDisclosureAuthorizationCore
     - Node   : require('../assets/js/disclosure-authorization-core.js')
   规则（与 disclosure-core.js / disclosure-authoring-core.js / public-profile-core.js 同款）：
   **零 window / 零 DOM / 零 fetch / 零 IndexedDB / 零 localStorage / 零副作用**。

   ── 它回答的是第三个问题，不是第一个也不是第四个 ──────────────────────
   仓库里现在有四个**不同**的问题，D31 把它们的边界写死了：

     ① 这条事实是真的吗？          → 事实内容（本模块**不看** text）
     ② 谁对这条事实负责？          → writer authority（disclosure-core §4b，已冻结）
     ③ 谁**被允许**知道这条事实？  → **本模块**
     ④ 模型这一次**应该**看到它吗？→ prompt 装配（**本模块不做**）

   本模块只回答 ③。它**不**把任何东西送进 prompt，也**不**被任何模型上下文
   构建器引用；输出是一个纯粹的判定对象，不是一份可以喂给模型的内容。

   ── 前置：4B-2A 是 hard boundary 的「门锁逻辑」，不是「把门接到模型房间」──
   即使 authorize() 返回 allowed:true，今天真实 Role DM 的 composeSide 仍然
   看不到那一条事实 —— 测试 §I 用**真实的** role-dm.js 证明这一点，
   并且用一个**结构性**断言把两侧焊死：真实 Role DM 全链路不含本模块字样。

   ══ 授权维度：owner / recipient / level / explicit grant ══
   四个维度缺一不可，且**没有一个是关系分数**：

     ownerCharacterId        这条事实属于谁（来自 canonical 记录，不从别处推断）
     recipientCharacterId    这一次要告诉谁（由调用方显式给出）
     level                   PERSONAL / PRIVATE / SECRET 三档都 gated
     grants                  人类**显式**为这一对 (factId, recipient) 写下的许可

   **刻意不算授权维度的三个东西**（它们回答"这条事实从哪来 / 谁负责"）：
     source / authority / authoredBy —— 一条人类亲手写下的事实**照样**需要
     一条 recipient grant 才能告诉别人。把写者权威当成"可以告诉谁"，
     等于让"这确实是我的秘密"直接变成"所有人都可以知道"。

   ══ DEFAULT DENY：为什么这是**唯一**的失败方向 ══
   缺失 / 畸形 / 未知的一切都落到 DENY，且**没有一条**通往 ALLOW 的路径
   依赖任何东西的**存在**以外的条件：

     畸形 fact           → DENY invalid-fact
     fact 缺 owner       → DENY invalid-fact
     fact 缺 factId      → DENY invalid-fact（授权对象必须可审计，见 §grant 绑定）
     未知 level / 字符串 → DENY level-unknown
     未分类 level        → DENY level-not-authorizable
     PUBLIC              → DENY level-not-authorizable（公开权威在 publicProfile）
     recipient 缺失      → DENY recipient-missing
     recipient == owner  → DENY recipient-is-owner
     grants 不是数组     → DENY invalid-grant
     某一条 grant 畸形   → DENY invalid-grant
     没有匹配的 grant    → DENY no-explicit-grant
     匹配且合法          → ALLOW explicit-grant   ← 唯一一条 ALLOW

   并且本模块**从不 throw**。异常不是"让调用方自己决定"的接口：
   一个把 authorize() 包在 try/catch 里、catch 分支放行的调用方，
   会把异常读成允许 —— 所以这里根本不存在异常路径。

   ══ 关系分数**不是**授权权威（源码级禁止，不是纪律）══
   本文件去注释/去字符串后**零引用**：trust / affinity / familiarity /
   dmCount / relationship / toneCounts / initiative / intent / memorandum /
   任何消息历史。理由是具体的，不是洁癖：

     · 它们全部是 **inferred / behavioral state**，而披露对象是用户**显式**写下的
       敏感事实；
     · 当前 trust 的可达范围是 `[0.5, 1.0]`（初始 0.5、只涨不跌、无 negative、
       无 decay），其 writer 读的是**本侧自己说的话**，不是对方行为 ——
       它连"对方做了什么"都不是，更不是"用户授权了谁"。

   因此"关系好所以可以说"这件事在本模块里**没有代码可以表达它**。

   ══ grant：ALLOW-only、按 (factId, owner, recipient) 绑定、不持久化 ══
     { grantId?, factId, ownerCharacterId, recipientCharacterId, permission,
       authority, authoredBy?, updatedAt? }

   · **ALLOW grant only**：没有 ALLOW/DENY 双状态。默认已经 DENY，再发明一层
     deny override 只会制造"两次拒绝、一次允许"的优先级问题，而今天没有任何
     真实数据需要它。
   · **permission 是封闭单值 `disclose`**：PRIVATE 与 SECRET 要求的是**同一种**
     explicit per-fact recipient grant。刻意**不**发明 permission hierarchy ——
     没有证据支持"SECRET 需要比 PRIVATE 更强的 grant 类型"，
     更细粒度授权记在 Deferred。
   · **authority 必须是人类权威**（`human_authoring` / `human_confirmation`）。
     一条 `derived` grant（模型自己决定"可以告诉她"）是**无效 grant**，不是"弱一点的
     grant"。审计已排除：owner 模型自述 / peer 模型请求 / trust 高 / familiarity 高 /
     autonomous intent / memorandum / 对话正文 / Memory visibility 全部不得产生 grant。
   · **绑定 factId 而不是 text**：正文改了，授权对象没变（同一条事实）；
     fact 删除后 grant 失去主语（kernel 只会拿到 DENY）；level 提升
     （PRIVATE → SECRET）**不会**静默保留旧 grant —— 见 §level 提升。
   · **不持久化**：本模块零 IO。grant 的存储、UI 入口与生命周期（删除 / 迁移）
     是 4B-2B 的独立决策（见 DECISIONS D31 的 Deferred）。
     ⇒ `CONTRACT CAN REPRESENT ALLOW = YES` / `PRODUCTION GRANT WRITER = NO`。

   ══ level 提升：为什么旧 grant 不静默续期 ══
   用户在编辑一条事实时把 PRIVATE 改成 SECRET，是在**明确提高**敏感度。
   旧 grant 是人在**旧等级**下给出的许可，把它在等级提高后继续沿用，等于让
   一次升级"免费带走"了原本没有针对新等级作出的许可。
   判定用**许可时的等级**：`grant.levelAtGrant` 若低于 fact 当前等级 ⇒
   DENY `grant-level-stale`；`levelAtGrant` **缺失或非法** ⇒ 那不是"范围无限宽"，
   而是**残缺的授权** ⇒ DENY `invalid-grant`（fail closed）。
   ⚠ `levelAtGrant` 是本模块**唯一**会读取的 grant 上非身份字段，理由是它是
   **许可的范围**，不是关系信号。它本身也不含任何内容。

   ══ 隐私：授权结果里**没有**事实内容 ══
   结果对象只有 { allowed, reasonCode, factId, ownerCharacterId,
   recipientCharacterId, level }。**没有** text / prompt / persona /
   systemPrompt / Memory / apiKey / Authorization / endpoint / 任何分数。
   `resultKeys()` 把这一点变成可断言的性质。
   本模块**不**新增任何运行时 trace。
   ==================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(require('./disclosure-core.js')); }
  else { root.IBDisclosureAuthorizationCore = factory(root.IBDisclosureCore); }
})(typeof self !== 'undefined' ? self : this, function (DC) {
  'use strict';

  /* 核心缺失 ⇒ 整体 fail closed：每一条判定都是 DENY，绝不返回 allowed:true。
     这与仓库既有约定一致（依赖缺失是可诊断的失败，不是静默降级）。 */
  function hasCore() { return !!DC && typeof DC.normalizeDisclosureFact === 'function'; }

  /* ══════════ 1. 封闭枚举 ══════════ */

  /* grant 的权限值。**单值**：没有任何证据支持两级 grant（见文件头）。
     为什么不设 'deny'：默认已经是 DENY，一个显式的 deny 值只是一层
     覆盖默认的冗余状态；需要时再按证据增加，而不是先发明再找理由。 */
  var PERMISSION = { DISCLOSE: 'disclose' };
  var PERMISSIONS = [PERMISSION.DISCLOSE];

  /* 判定原因**闭集**。它必须能区分"缺 grant"与"grant 畸形"、
     "未知等级"与"等级不可授权" —— 否则调用方学不到真正的拒绝理由。 */
  var REASON = {
    /* ── ALLOW：唯一一条 ── */
    EXPLICIT_GRANT: 'explicit-grant',
    /* ── DENY ── */
    CORE_MISSING: 'authorization-core-unavailable',
    INVALID_FACT: 'invalid-fact',
    RECIPIENT_MISSING: 'recipient-missing',
    RECIPIENT_IS_OWNER: 'recipient-is-owner',
    LEVEL_UNKNOWN: 'level-unknown',
    LEVEL_NOT_AUTHORIZABLE: 'level-not-authorizable',
    GRANT_INVALID: 'invalid-grant',
    GRANT_LEVEL_STALE: 'grant-level-stale',
    NO_GRANT: 'no-explicit-grant'
  };
  var REASONS = [
    REASON.EXPLICIT_GRANT,
    REASON.CORE_MISSING, REASON.INVALID_FACT, REASON.RECIPIENT_MISSING,
    REASON.RECIPIENT_IS_OWNER, REASON.LEVEL_UNKNOWN, REASON.LEVEL_NOT_AUTHORIZABLE,
    REASON.GRANT_INVALID, REASON.GRANT_LEVEL_STALE, REASON.NO_GRANT
  ];
  /* 唯一允许放行的原因。任何新增原因都必须显式加到这张表里才会 ALLOW ——
     "忘了加"的默认结果是 DENY，方向是对的。 */
  var ALLOW_REASONS = [REASON.EXPLICIT_GRANT];

  var ALLOWED_KEYS = Object.freeze([
    'allowed', 'reasonCode', 'recipientCharacterId', 'factId', 'ownerCharacterId', 'level'
  ]);

  /* fact / grant 上**不得存在**的键。disclosure-core §5 的硬名单是基准
     （persona / publicProfile / 凭据 / 共享 thread / ACL），本模块再加两个
     只会出现在**判定结果**里的键：把它们写在 fact 或 grant 上，就是想用
     "既是输入又是输出"的形状让判定短路。 */
  var DENY_FIELDS = (DC && DC.DENY_FIELDS ? DC.DENY_FIELDS.slice() : []).concat([
    'visibility', 'allowed', 'reasonCode'
  ]);

  /* 绝不进入代码的字段（只出现在本文件**注释**里，用于说明为什么不算授权维度）。 */
  var NON_AUTHORITY_SIGNALS = Object.freeze([
    'trust', 'affinity', 'familiarity', 'dmCount', 'relationship',
    'toneCounts', 'initiative', 'memorandum'
  ]);

  /* ══════════ 2. 纯工具 ══════════ */
  function str(v) { return String(v == null ? '' : v); }

  function isPlainObject(v) {
    return !!v && typeof v === 'object' && !Array.isArray(v);
  }
  function has(o, k) {
    return isPlainObject(o) && Object.prototype.hasOwnProperty.call(o, k);
  }
  /* 读一个键，读不到 / 读炸了都返回 undefined。
     存在的理由很具体：一个带 getter 的对象可以让任何一次属性读取抛异常，
     而"本模块从不 throw"必须对**每一个**面向调用方的入口成立。 */
  function tryRead(o, k) {
    try { return o == null ? undefined : o[k]; } catch (e) { return undefined; }
  }

  /* id 归一化：与 disclosure-core §2 同一条规则，但**刻意不 import 它** ——
     core 没有导出 normalizeId（那是它的内部工具），而把 owner 塞进探针记录
     再取回来（authoring-core 的做法）在这里是错的：本模块需要判定的正是
     "哪个键是 owner"，用一个伪造记录去问会产生循环依赖式的混淆。
     规则很短，且与 core 逐条对齐：trim、拒空、拒超长、拒空白/控制字符。
     绝不宽松匹配 —— id 是分区键，一个近似匹配就是伪造归属。 */
  function normalizeId(v) {
    var s = str(v).trim();
    if (!s || s.length > 200) return '';
    if (/[\u0000-\u001F\u007F\s]/.test(s)) return '';
    return s;
  }

  function normalizeText(v) {
    return (typeof v === 'string') ? v.trim() : '';
  }

  /* ══════════ 3. fact 归一化（fail closed，且不抛） ══════════ */

  /* ── 边界：本模块**从不 throw**，包括 disclosure-core 抛的时候 ──────────
     这条不是洁癖。disclosure-core 的归一化会**读取**输入的字段（`input.level`、
     `input.authority`…），因此一个带 getter 的对象可以让它抛 —— 而一个把
     authorize() 包在 try/catch 里、catch 分支放行的调用方，会把那个异常读成
     "允许"。契约里写了"本模块从不 throw"，但只写下来是不够的：
     核心的三个调用点确实可能抛（S8 组用一个访问即抛的 getter 实测抓到了）。

     修法不是给 core 加 try/catch（那是改冻结面，而且会把"异常"变成
     core 内部的默认值），而是**在边界上**把它变成一条明确的拒绝。
     用**显式允许名单**而不是 `el.authorize()` 之类的动态分发：
     名单里每一个函数的退化返回值各自写清楚，新增一个被允许的 core 函数
     必须同时回答"它失败时退化为什么"。 */
  var SAFE_DC = {
    denylistHits: function (v) { try { return DC.denylistHits(v); } catch (e) { return ['unreadable-input']; } },
    normalizeDisclosureFact: function (v) { try { return DC.normalizeDisclosureFact(v); } catch (e) { return null; } },
    normalizeDisclosureAuthority: function (v) { try { return DC.normalizeDisclosureAuthority(v); } catch (e) { return 'derived'; } },
    isHumanAuthority: function (v) { try { return DC.isHumanAuthority(v) === true; } catch (e) { return false; } },
    isGatedLevel: function (v) { try { return DC.isGatedLevel(v) === true; } catch (e) { return false; } },
    knownLevel: function (v) { try { return DC.LEVELS.indexOf(v) >= 0; } catch (e) { return false; } },
    rank: function (v) { try { var r = DC.levelRank(v); return (typeof r === 'number') ? r : null; } catch (e) { return null; } }
  };

  /* 返回 { ok:true, fact, factId, owner, level } 或 { ok:false, reason }。
     每一处否定都在这里给出精确原因；authorize 不含任何分支逻辑上的意外。 */
  function readFact(fact) {
    if (!hasCore()) return { ok: false, reason: REASON.CORE_MISSING };
    if (!isPlainObject(fact)) return { ok: false, reason: REASON.INVALID_FACT };
    /* 结构性硬名单先查：一个带 visibleTo / visibility / systemPrompt / persona /
       publicProfile / 凭据 / 共享 thread 字段 / domain 声明的对象**整体拒绝**，
       而不是"删掉该字段再继续"。这条同时是 MUT-D 的捕获点 —— 一个
       `visibility:'only'` 的 Memory 行在这里就被拒了，根本走不到授权判定。
       本模块自己的 `DENY_FIELDS` 也要查（它比 core 的多三个键）。 */
    var hits = SAFE_DC.denylistHits(fact);
    for (var di = 0; di < DENY_FIELDS.length; di++) {
      if (has(fact, DENY_FIELDS[di]) && hits.indexOf(DENY_FIELDS[di]) < 0) hits.push(DENY_FIELDS[di]);
    }
    if (hits.length) return { ok: false, reason: REASON.INVALID_FACT };
    var rec = SAFE_DC.normalizeDisclosureFact(fact);
    if (!rec) return { ok: false, reason: REASON.INVALID_FACT };
    if (!rec.ownerCharacterId) return { ok: false, reason: REASON.INVALID_FACT };
    if (!rec.text) return { ok: false, reason: REASON.INVALID_FACT };
    if (!rec.factId) return { ok: false, reason: REASON.INVALID_FACT };
    /* 判定对象的身份必须**原样**成立：normalize 丢弃未知字段，但它不该改写
       factId。改写说明调用方传的不是一条 canonical 记录。 */
    if (normalizeId(fact.factId) !== rec.factId) return { ok: false, reason: REASON.INVALID_FACT };
    /* level 三分：已知 gated / 已知但不可授权（PUBLIC、UNDETERMINED）/ 未知字符串。
       把一个未知字符串和"合法但不可 gate"混成同一个原因，会让调用方
       分不清"我拼错了 SECRET"与"我传了一条 PUBLIC"。 */
    if (!SAFE_DC.knownLevel(fact.level)) return { ok: false, reason: REASON.LEVEL_UNKNOWN };
    if (!SAFE_DC.isGatedLevel(rec.level)) return { ok: false, reason: REASON.LEVEL_NOT_AUTHORIZABLE };
    return { ok: true, fact: rec, factId: rec.factId, owner: rec.ownerCharacterId, level: rec.level };
  }

  /* ══════════ 4. grant 归一化（fail closed，且不抛） ══════════ */

  /* 允许的 grant 值（人类权威）。派生 grant 是"没有人负责的许可"。 */
  function isHumanGrantAuthority(v) {
    return hasCore() && SAFE_DC.isHumanAuthority(v);
  }

  /* 返回 null（畸形 / 无效）或一条 canonical grant。
     **绝不做部分归一的宽容**：缺 recipient、permission 拼错、authority 是
     derived —— 一律 null。返回 null 的 grant 会让整次判定变成 invalid-grant，
     而不是被安静地跳过（安静跳过等于"畸形 grant 不影响结果"，
     那正是 fail-open 的形状）。 */
  function normalizeGrant(g) {
    if (!hasCore()) return null;
    if (!isPlainObject(g)) return null;
    /* grant 自身也不得携带硬名单键（persona / ACL / allowed / …）。 */
    for (var i = 0; i < DENY_FIELDS.length; i++) {
      if (has(g, DENY_FIELDS[i])) return null;
    }
    var factId = normalizeId(g.factId);
    var owner = normalizeId(g.ownerCharacterId);
    var recipient = normalizeId(g.recipientCharacterId);
    if (!factId || !owner || !recipient) return null;
    /* 自己给自己授权不是授权 —— 授权描述的是**授予他人**。 */
    if (owner === recipient) return null;
    if (typeof g.permission !== 'string' || PERMISSIONS.indexOf(g.permission) < 0) return null;
    if (!isHumanGrantAuthority(g.authority)) return null;
    /* 许可的**范围**必须被记录下来。一条没有 `levelAtGrant` 的 grant 无法回答
       "它当初许可到哪一档"，因此它不是"范围无限宽"，而是**残缺** ——
       残缺的授权不是授权，落 invalid-grant（fail closed）。
       这条检查被从 authorize 挪到 normalizeGrant 有个具体理由：让
       `isValidGrant(g) === false` 与 `authorize(...) === invalid-grant`
       成为**同一件事**，而不是"归一化说合法、判定说陈旧"的两种说法。 */
    if (!SAFE_DC.knownLevel(g.levelAtGrant)) return null;
    var levelAtGrant = g.levelAtGrant;
    var now = Number(g.updatedAt);
    if (!isFinite(now) || now <= 0) now = 0;   /* 缺失时间戳落 0：**绝不**写"现在" */
    return {
      grantId: normalizeId(g.grantId),
      factId: factId,
      ownerCharacterId: owner,
      recipientCharacterId: recipient,
      permission: g.permission,
      authority: DC.normalizeDisclosureAuthority(g.authority),
      authoredBy: DC.isHumanAuthority(g.authority) ? normalizeId(g.authoredBy) : '',
      levelAtGrant: levelAtGrant,
      updatedAt: Math.trunc(now)
    };
  }

  function isValidGrant(g) { return normalizeGrant(g) !== null; }

  /* collect 的结果三态：
       { ok:true,  grants:[…] }   一条合法的都没有（列表为空是**合法**的）
       { ok:true,  grants:[…] }   有合法的
       { ok:false, reason }       列表本身畸形，或**存在**畸形项

     `level` 是 fact 当前等级，用于判断 grant 是否已因等级提升而失效。 */
  function collectGrants(input, owner, recipient, factId, level) {
    if (input == null) return { ok: true, grants: [] };
    if (!Array.isArray(input)) return { ok: false, reason: REASON.GRANT_INVALID };
    var out = [];
    for (var i = 0; i < input.length; i++) {
      var g = normalizeGrant(input[i]);
      /* 一条畸形 grant 让整次判定变成 invalid-grant（不是被跳过）。
         理由：调用方以为自己提交了一份许可，而系统"没看见"它，
         比明确报错危险得多。 */
      if (!g) return { ok: false, reason: REASON.GRANT_INVALID };
      if (g.factId !== factId) continue;
      if (g.ownerCharacterId !== owner) continue;
      if (g.recipientCharacterId !== recipient) continue;
      out.push(g);
    }
    return { ok: true, grants: out };
  }

  /* ══════════ 5. 授权判定 ══════════ */

  function deny(code, extra) {
    return Object.assign({ allowed: false, reasonCode: code }, extra || {});
  }

  /*
      authorize(fact, context) → { allowed, reasonCode, … }

      context = { recipientCharacterId, grants? }

      **唯一**的判定入口。返回对象是**值**，不是句柄：它不含任何内容、
      不含任何 store 引用、不含任何关系分数，因此"授权通过了"这件事
      在类型上就无法被误当成"内容可以进 prompt 了"（那是第四个问题）。

      第三个参数 `opts` **刻意不被读取**：留它是为了兼容未来可能的纯选项
      （例如一个显式的判定时刻），而不是留一个"调用方能塞东西进来"的口子。
      S/I 组断言它的形参数量恰好是 3 —— 多一个参数就是多一个可能的入口，
      应当由测试而不是由注释来拦住。
  */
  function authorize(fact, context, opts) {
    try {
      return decide(fact, context);
    } catch (e) {
      /* 到这里说明有一条本模块**没有**想到的路径。它仍然是 DENY，
         而且是一个**可命名**的 DENY —— 绝不让异常逃出去被调用方读成允许。
         （正常实现下 S8 组证明这里不可达；它是最后一道网，不是主要防线。） */
      return deny(REASON.INVALID_FACT);
    }
  }

  function decide(fact, context) {
    var ctx = isPlainObject(context) ? context : null;
    if (!ctx) return deny(REASON.RECIPIENT_MISSING);
    var recipient = normalizeId(ctx.recipientCharacterId);
    if (!recipient) return deny(REASON.RECIPIENT_MISSING);

    var f = readFact(fact);
    if (!f.ok) {
      /* 失败时**尽量**带上可审计的身份（能取到多少带多少），但绝不带正文。
         取不到就留空 —— 不猜。`SAFE_DC` 保证这一步自己不会抛。 */
      var rec = (hasCore() && isPlainObject(fact)) ? SAFE_DC.normalizeDisclosureFact(fact) : null;
      return deny(f.reason, {
        recipientCharacterId: recipient,
        factId: rec ? rec.factId : '',
        ownerCharacterId: rec ? rec.ownerCharacterId : '',
        level: ''
      });
    }

    /* 方向性：owner 是披露**主体**，recipient 是**对象**。两者相同不属于
       Role DM 披露 —— 本条不构成任何新权限的载体（也不是"造一条自授权 grant"
       的漏洞，因为 grant 的 owner === recipient 会被 normalizeGrant 拒绝）。
       仓库里不存在 self-DM，因此不为理论完整性发明一种 A→A 行为。 */
    if (recipient === f.owner) {
      return deny(REASON.RECIPIENT_IS_OWNER, {
        recipientCharacterId: recipient, factId: f.factId, ownerCharacterId: f.owner, level: f.level
      });
    }

    var own = { recipientCharacterId: recipient, factId: f.factId, ownerCharacterId: f.owner, level: f.level };

    /* grant 列表只有在本等级是 gated 时才需要 —— 但**先**检查列表形状。
       一个畸形 grants 值在任何等级下都是调用方错误，不是"本轮不适用"。 */
    var collected = collectGrants(ctx.grants, f.owner, recipient, f.factId, f.level);
    if (!collected.ok) return deny(collected.reason, own);
    if (!collected.grants.length) return deny(REASON.NO_GRANT, own);

    /* level 提升后的 grant 是否仍有效：见文件头。取**存在**语义而不是"最大"语义 ——
       只要存在一条许可范围覆盖当前等级的 grant 就放行；一条陈旧 grant 不会
       因为"旁边还有一条新的"而被忽略 —— 它是被新的那条覆盖，而不是被跳过。
       （`normalizeGrant` 已保证 `levelAtGrant` 一定是合法档位，因此这里无需
       再判空：那个"跳过"分支会在结构上变成一条永不执行的死路径。）
       任何一个 rank 取不到时按 `null` 处理 ⇒ 不满足 >=（number）⇒ 继续找，
       最终仍然是 DENY —— 依赖缺失的方向永远是拒绝。 */
    var curRank = SAFE_DC.rank(f.level);
    var stale = true;
    for (var i = 0; i < collected.grants.length; i++) {
      var gRank = SAFE_DC.rank(collected.grants[i].levelAtGrant);
      if (gRank !== null && curRank !== null && gRank >= curRank) { stale = false; break; }
    }
    if (stale) return deny(REASON.GRANT_LEVEL_STALE, own);

    /* 到这里：owner 对得上、recipient 对得上、factId 对得上、permission 合法、
       authority 是人类、许可范围覆盖当前等级。**唯一**放行路径。 */
    return { allowed: true, reasonCode: REASON.EXPLICIT_GRANT, recipientCharacterId: recipient,
      factId: f.factId, ownerCharacterId: f.owner, level: f.level };
  }

  function isAllowed(fact, context) {
    return authorize(fact, context).allowed === true;
  }

  /* 可审计的判定摘要：**只有**这些键，且**没有**事实内容。
     注意它返回的是判定的**元数据**，不是"可以喂给模型的东西"——
     调用方拿它写 trace / 反馈 UI，不拿它装配 prompt。 */
  function describeDecision(decision) {
    var d = isPlainObject(decision) ? decision : {};
    /* ⚠ 这里的每一次 getter 读取都要能被 S7/S8 那种"访问即抛"的对象接住。
       `tryRead` 就是为此存在的：判定核的"从不 throw"必须对**它自己导出的
       每一个入口**成立，不只是对 authorize。 */
    var reason = tryRead(d, 'reasonCode');
    var lvlRaw = tryRead(d, 'level');
    var reasonOut = (typeof reason === 'string' && REASONS.indexOf(reason) >= 0) ? reason : '';
    var lvl = (typeof lvlRaw === 'string' && hasCore() && SAFE_DC.knownLevel(lvlRaw)) ? lvlRaw : '';
    return {
      allowed: tryRead(d, 'allowed') === true,
      reasonCode: reasonOut,
      recipientCharacterId: normalizeId(tryRead(d, 'recipientCharacterId')),
      factId: normalizeId(tryRead(d, 'factId')),
      ownerCharacterId: normalizeId(tryRead(d, 'ownerCharacterId')),
      level: lvl
    };
  }

  /* 结果对象的键**闭集**。它的用途是把"结果里没有正文"从一句承诺
     变成一条可断言的性质（tests §T：ALLOW 与 DENY 两个结果都过这张表，
     且逐字比对 fact 正文不出现在 JSON 里）。 */
  function resultKeys() { return ALLOWED_KEYS.slice(); }

  /* ══════════ 6. 导出 ═══════════════
     **没有** filter() / applyTrust() / scoreRecipient() / pickDisclosable() ——
     把判定变成"挑出可以说的那几条"是 prompt 装配（第四个问题），
     被本轮明确禁止。导出表里不存在这些名字是刻意的：
     "未实现"应当是**找不到函数**，而不是"有个函数永远返回 true"。 */
  return {
    PERMISSION: PERMISSION,
    PERMISSIONS: PERMISSIONS,
    REASON: REASON,
    REASONS: REASONS,
    ALLOW_REASONS: ALLOW_REASONS,
    ALLOWED_KEYS: ALLOWED_KEYS,
    NON_AUTHORITY_SIGNALS: NON_AUTHORITY_SIGNALS,

    authorize: authorize,
    isAllowed: isAllowed,
    normalizeGrant: normalizeGrant,
    isValidGrant: isValidGrant,
    describeDecision: describeDecision,
    resultKeys: resultKeys
  };
});
