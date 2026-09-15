/* ====================================================================
   IB Disclosure Authoring Core — 「人类显式创作一条披露事实」的唯一契约实现
   --------------------------------------------------------------------
   UMD 双载：
     - Browser: <script src="assets/js/disclosure-authoring-core.js"> → window.IBDisclosureAuthoringCore
     - Node   : require('../assets/js/disclosure-authoring-core.js')
   规则（与 disclosure-core.js / public-profile-core.js / role-dm-core.js 同款）：
   **零 window / 零 DOM / 零 fetch / 零 IndexedDB / 零 localStorage / 零副作用**。

   ── 它补的是哪一个洞（Phase 4B-1.2）──────────────────────────────────
   Phase 4B-1 定义了 canonical 记录的形状，4B-1.1 定义了「谁有资格」，
   但两者都是**纯函数上的契约**：`normalizeDisclosureFact({...})` 谁来调都行，
   而当时**没有任何生产代码调用它**（DECISIONS D29 如实记录）。
   于是仓库里出现了一个精确的、可测量的缺口：

       PRODUCTION DISCLOSURE WRITER = 0
       ⇒ 契约能描述一条秘密，但**造不出**一条秘密

   本模块是那个缺口的第一块填补：一个**只能由人类显式动作进入**的写入路径。

   ── 本模块解决的核心问题：把"谁在写"从表单里拿出来 ────────────────
   一个真实的 UI 里，用户填的是**正文和等级**；而 owner / source / authority
   是**关于这次写入本身**的事实。如果它们和正文一起从表单读，那么：

     · 表单可以改 owner     → 用户在编辑 A，却能造出一条属于 B 的秘密；
     · 表单可以改 source    → 一次人类点击可以被标成"模型生成"（或反之）；
     · 表单可以改 authority → 4B-1.1 的整个权威维度退化成**用户自填字段**，
                              而 4B-1.1 的全部价值就是它**不是**自填的。

   因此本模块把输入**结构性拆成两个参数**，而且这个拆分不是风格问题：

       writerContext  —— 可信上下文。由 UI 从"你正在编辑哪个角色"派生，
                         用户**看不见也改不了**。只有 ownerCharacterId /
                         authoredBy 两个键被读取，其余键一律**不读**。
       userInput      —— 表单数据。只允许 level / text / subjectCharacterId。

   并且 userInput 里出现任何**保留键**（ownerCharacterId / authority /
   source / authoredBy / factId / updatedAt / id / createdBy …）一律
   **整体拒绝**，而不是静默丢弃 —— 与 disclosure-core 的 `denylistHits` 同款理由：
   静默丢弃会让调用方以为自己成功提交了一份带自定义权威的记录。

   ── 三条靠**代码结构**保证的性质（不是注释纪律）────────────────────
   ① **UI 造不出 PUBLIC**：显式创作可用的档位恰好是 `GATED_LEVELS`
      （PERSONAL / PRIVATE / SECRET），PUBLIC 被**拒绝而不是降级**。
      理由见 §3：PUBLIC 的 authority 是 public-profile-core 的构造式白名单，
      在本契约里再产出一条 PUBLIC 就是**第二份公开资料权威**。
      注意区分两件事：disclosure-core **类型层**允许 PUBLIC 记录
      （那是边界语义，例如"公开可说的观察"），与本模块**写作层**禁止用户
      创建 PUBLIC **不矛盾** —— 前者回答"这条记录是什么形状"，
      后者回答"这条路径有资格造什么"。
   ② **owner 不接受推断**：ownerCharacterId 只从 writerContext 读；本模块
      **从不**看 currentSpeaker / visibleTo / createdBy / subject / peer /
      最后一个说话人。缺失或畸形 ⇒ 拒绝，绝不回落到"当前正在聊的那个角色"。
   ③ **update 不能改归属**：factId / ownerCharacterId / authority / source /
      authoredBy / updatedAt 全部不可变，出现即**拒绝**。把 A 的事实改成
      B 的事实**不是编辑**，是"删掉 A 的一条、再为 B 建一条"两件事 ——
      允许 owner mutation 就等于允许把秘密静默转移给另一个角色。

   ── 本模块**不做**什么（本轮硬边界）────────────────────────────────
     · 不做授权：没有 canDisclose / authorize / filter；
     · 不读 trust、不读 relationship、不读 Memory、不读 publicProfile；
     · 不注入 Role DM prompt、不做 candidate 生成、不做 human_confirmation 流程；
     · **不写任何 store** —— 持久化在 disclosure-store.js，本文件零 IO。

   写入路径存在 ≠ 读取路径存在：
       human explicit authoring → [本模块] → canonical fact → [store]
                                                                  ↓
                                                    authorization (4B-2, DEFERRED)
                                                                  ↓
                                                    composeSide → prompt（今天读不到）
   ==================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(require('./disclosure-core.js')); }
  else { root.IBDisclosureAuthoringCore = factory(root.IBDisclosureCore); }
})(typeof self !== 'undefined' ? self : this, function (DC) {
  'use strict';

  /* 核心缺失时**整体 fail closed**：所有 plan* 返回拒绝，绝不返回一份
     "看起来能用"的记录。这与本仓库既有约定一致 —— 依赖缺失是可诊断的失败，
     不是静默降级。 */
  function hasCore() { return !!DC && typeof DC.normalizeDisclosureFact === 'function'; }

  /* ══════════ 1. 由 seam 填写的两个常量（**不是** UI 参数）══════════════

     它们从 disclosure-core 的枚举里取，而不是在这里重新写一遍字符串 ——
     否则枚举一改，seam 就会悄悄产生一份"合法但不被识别"的记录。 */

  var WRITER_SOURCE = (DC && DC.SOURCE) ? DC.SOURCE.CHARACTER_AUTHORING : 'character_authoring';
  var WRITER_AUTHORITY = (DC && DC.AUTHORITY) ? DC.AUTHORITY.HUMAN_AUTHORING : 'human_authoring';

  /* ══════════ 2. 可创作档位（PUBLIC 被排除）══════════════

     直接取 `GATED_LEVELS`：显式创作能造的档位**恰好**是需要授权才能进入
     peer 上下文的那三档。这不是巧合 —— 一条"公开可说"的事实本来就不该
     需要人类在这里显式授权（它的权威在 publicProfile），而一条真正需要
     保护的事实**才**需要有人在明确知道 owner 的情况下写下来。

     于是"能不能从这条路径造出来"与"要不要经过 4B-2 授权"在同一份数据上
     对齐：本路径产出的每一条事实，将来都必须过授权。 */
  var AUTHORING_LEVELS = (DC && DC.GATED_LEVELS) ? DC.GATED_LEVELS.slice() : ['PERSONAL', 'PRIVATE', 'SECRET'];

  /* ══════════ 3. 保留键（userInput 里出现即整体拒绝）══════════════

     分三类，理由各不相同：
       · 元数据类（ownerCharacterId / source / authority / authoredBy）——
         由 writerContext 提供。让表单传 = 让用户自填权威。
       · 身份类（factId / id）—— 由 store 生成或由既有记录携带。
         让表单传 = 让用户覆盖一条已存在的事实（写到别人的 id 上）。
       · 派生类（updatedAt / isDisclosureFact / createdBy / createdByName）——
         由 core 或 store 生成；`createdBy` 尤其危险，因为 4B-1.1 的 B3
         已经证明它就是**最容易被误当成 owner** 的那个键。 */
  var RESERVED_INPUT_KEYS = [
    'ownerCharacterId', 'source', 'authority', 'authoredBy',
    'factId', 'id', 'updatedAt',
    'createdBy', 'createdByName', 'isDisclosureFact'
  ];

  /* ══════════ 4. update 的可变 / 不可变面 ══════════════

     可变的只有三个：正文、等级、对象角色（subjectCharacterId）。
     其余全部不可变。**特别地**：等级可以改（SECRET → PRIVATE 是用户在
     降低敏感度，这是编辑的正常内容），但归属和权威不能改。 */
  var MUTABLE_FIELDS = ['text', 'level', 'subjectCharacterId'];
  var IMMUTABLE_FIELDS = ['factId', 'ownerCharacterId', 'authority', 'source', 'authoredBy', 'updatedAt'];

  /* ══════════ 5. 拒绝原因（诊断用；**不含正文**）══════════════ */
  var REJECT = {
    NO_CORE: 'authoring-core-unavailable',
    NOT_AN_OBJECT: 'not-an-object',
    BAD_WRITER_CONTEXT: 'bad-writer-context',
    NO_WRITER_OWNER: 'no-writer-owner',
    CALLER_SUPPLIED_METADATA: 'caller-supplied-metadata',
    BAD_LEVEL: 'bad-authoring-level',
    PUBLIC_NOT_CREATABLE: 'public-not-creatable-by-explicit-writer',
    MISSING_TEXT: 'missing-text',
    TEXT_DENYLISTED: 'text-denylisted',
    NOT_A_FACT: 'not-a-canonical-fact',
    OWNER_MISMATCH: 'owner-mismatch',
    IMMUTABLE_FIELD: 'immutable-field',
    NOTHING_TO_UPDATE: 'nothing-to-update'
  };

  /* ══════════ 6. 纯工具 ══════════════ */
  function isPlainObject(v) {
    return !!v && typeof v === 'object' && !Array.isArray(v);
  }
  function has(o, k) {
    return isPlainObject(o) && Object.prototype.hasOwnProperty.call(o, k);
  }

  /* owner 的**唯一**归一化权威是 disclosure-core（4B-1 已冻结该规则）。
     本模块**不复制**那条规则 —— 复制就是第二权威，而且两处早晚会分叉。
     做法：把 owner 塞进一条最小合法记录让 core 归一化，取回它认定的人。
     core 拒绝（缺 owner / 空白 / 控制字符 / 超长）⇒ 返回 ''。 */
  function normalizeOwner(v) {
    if (!hasCore()) return '';
    var rec = DC.normalizeDisclosureFact({
      ownerCharacterId: v,
      level: 'PERSONAL',
      text: 'probe',
      source: WRITER_SOURCE,
      authority: WRITER_AUTHORITY
    });
    /* 这条探针事实**只用于取回 owner**，不返回、不写盘、不进入任何结果。 */
    return rec ? rec.ownerCharacterId : '';
  }

  /* writerContext → { ok, owner, authoredBy }。
     **只读两个键**：ownerCharacterId / authoredBy。其余键（哪怕是一整个
     角色 cfg 被传进来）一律不读 —— 因此"传了 source/authority 想影响写入"
     在这条路径上**结构性地不可能生效**：代码里没有读它的地方。
     这不是"忽略"，是"不存在读取点"。 */
  function readWriterContext(writerContext) {
    if (!isPlainObject(writerContext)) return { ok: false, reason: REJECT.BAD_WRITER_CONTEXT };
    if (!has(writerContext, 'ownerCharacterId')) return { ok: false, reason: REJECT.NO_WRITER_OWNER };
    var owner = normalizeOwner(writerContext.ownerCharacterId);
    if (!owner) return { ok: false, reason: REJECT.NO_WRITER_OWNER };
    /* authoredBy 是可选的旁证（谁在场），不是授权本身 —— 4B-1.1 §③ 已
       如实记录过它为什么不能成为授权载体。这里只做透传：有就带上，
       没有就留空；它**不参与任何**允许/拒绝判断。 */
    var authoredBy = '';
    if (has(writerContext, 'authoredBy') && typeof writerContext.authoredBy === 'string') {
      authoredBy = writerContext.authoredBy;
    }
    return { ok: true, owner: owner, authoredBy: authoredBy };
  }

  /* userInput 里是否出现保留键。**不**检查未知键 —— 未知键会被
     normalize 的封闭记录丢弃，那是既有契约的行为（见 disclosure-core §8）。 */
  function reservedHits(userInput) {
    var hits = [];
    for (var i = 0; i < RESERVED_INPUT_KEYS.length; i++) {
      if (has(userInput, RESERVED_INPUT_KEYS[i])) hits.push(RESERVED_INPUT_KEYS[i]);
    }
    return hits;
  }

  /* level 的创作期校验：必须是三档之一。
     **PUBLIC 单独给一个拒因** —— 它被拒是因为"公开权威在别处"，
     不是因为"敏感度不够"，调用方必须能分辨这两件事。 */
  function checkAuthoringLevel(level) {
    if (!hasCore()) return REJECT.NO_CORE;
    if (!DC.isClassified(level)) return REJECT.BAD_LEVEL;
    if (AUTHORING_LEVELS.indexOf(level) < 0) return REJECT.PUBLIC_NOT_CREATABLE;
    return '';
  }

  function isAuthoringLevel(level) {
    return hasCore() && DC.isClassified(level) && AUTHORING_LEVELS.indexOf(level) >= 0;
  }

  /* ══════════ 7. create ══════════════════════════════════════════ */

  /* 唯一的 canonical 创作入口。返回 {ok:true, fact} 或 {ok:false, reason,...}。
     绝不在失败时返回半成品 —— 调用方拿到 ok:false 就没有任何东西可写盘。 */
  function planCreate(writerContext, userInput, opts) {
    if (!hasCore()) return { ok: false, reason: REJECT.NO_CORE };
    var w = readWriterContext(writerContext);
    if (!w.ok) return { ok: false, reason: w.reason };
    if (!isPlainObject(userInput)) return { ok: false, reason: REJECT.NOT_AN_OBJECT };
    var clash = reservedHits(userInput);
    if (clash.length) return { ok: false, reason: REJECT.CALLER_SUPPLIED_METADATA, fields: clash };
    /* ── 结构性硬名单必须**穿过**这条路径生效 ──────────────────────────
       为什么需要这一步：本函数只把 owner/level/text/source/authority/subject
       组装进 canonical 输入，因此 userInput 里那些被 disclosure-core §5
       禁掉的字段**根本不会**被复制过去，denylistHits 也就永远看不到它们 ——
       结果是"表单里塞了 systemPrompt 仍然创建成功"，字段被静默丢掉。
       disclosure-core §5 自己写过为什么这不行：**静默删字段会让调用方以为
       自己成功提交了一个 persona 派生事实**。所以这里显式再跑一次硬名单，
       让拒绝发生在写入路径上，而不是等下游某天读到一个不该存在的字段。 */
    var deny = DC.denylistHits(userInput);
    if (deny.length) return { ok: false, reason: REJECT.TEXT_DENYLISTED, fields: deny };
    if (DC.publicProfileWouldDoubleOwn(userInput)) {
      return { ok: false, reason: REJECT.TEXT_DENYLISTED, fields: ['public-profile-double-authority'] };
    }
    var lvlReason = checkAuthoringLevel(userInput.level);
    if (lvlReason) return { ok: false, reason: lvlReason, level: String(userInput.level) };
    /* 组装写入输入：owner / source / authority **全部**来自 seam，
       一个字节都不来自 userInput。 */
    var input = {
      ownerCharacterId: w.owner,
      level: userInput.level,
      text: userInput.text,
      source: WRITER_SOURCE,
      authority: WRITER_AUTHORITY
    };
    if (has(userInput, 'subjectCharacterId')) input.subjectCharacterId = userInput.subjectCharacterId;
    if (w.authoredBy) input.authoredBy = w.authoredBy;
    var o = isPlainObject(opts) ? opts : {};
    if (o.now != null) input.updatedAt = o.now;
    /* 交给 core 归一并给出精确拒因（含 denylist / 正文缺失）。 */
    var ex = DC.explain(input);
    if (!ex || !ex.ok) return { ok: false, reason: (ex && ex.reason) || REJECT.NOT_A_FACT };
    var rec = DC.normalizeDisclosureFact(input);
    if (!rec || !DC.isDisclosureFact(rec)) return { ok: false, reason: REJECT.NOT_A_FACT };
    return { ok: true, fact: rec };
  }

  /* ══════════ 8. update ══════════════════════════════════════════

     签名刻意把 existing 放在最前：编辑的对象是**一条已经存在的记录**，
     而不是"一组字段"。owner 与 factId 从 existing 取得，patch 只能改内容。 */
  function planUpdate(existing, writerContext, patch, opts) {
    if (!hasCore()) return { ok: false, reason: REJECT.NO_CORE };
    var rec = DC.normalizeDisclosureFact(existing);
    if (!rec) return { ok: false, reason: REJECT.NOT_A_FACT };
    var w = readWriterContext(writerContext);
    if (!w.ok) return { ok: false, reason: w.reason };
    /* 归属校验：**只有**该事实的 owner 才能编辑它。
       ownerCharacterId 不可变，所以这里用 existing 的 owner 而不是 patch 的 ——
       patch 里根本不允许出现 ownerCharacterId（见下）。 */
    if (w.owner !== rec.ownerCharacterId) return { ok: false, reason: REJECT.OWNER_MISMATCH };
    if (!isPlainObject(patch)) return { ok: false, reason: REJECT.NOT_AN_OBJECT };
    /* 不可变字段：出现即拒绝（整体拒绝，不静默忽略）。
       ⚠ 注意顺序：保留键检查在不可变检查**之前**是**必须**的 ——
       否则 patch 里出现 `ownerCharacterId` 会走到这里被当成"不可变字段"，
       虽然同样被拒，但拒因会把"你在伪造归属"说成"这个字段不能改"，
       调用方学不到真正的理由。两者都在同一结果里给出，便于诊断。 */
    var imm = [];
    for (var i = 0; i < IMMUTABLE_FIELDS.length; i++) {
      if (has(patch, IMMUTABLE_FIELDS[i])) imm.push(IMMUTABLE_FIELDS[i]);
    }
    if (imm.length) {
      return { ok: false, reason: REJECT.IMMUTABLE_FIELD, fields: imm, ownerCharacterId: rec.ownerCharacterId };
    }
    var reserved = reservedHits(patch).filter(function (k) { return IMMUTABLE_FIELDS.indexOf(k) < 0; });
    if (reserved.length) return { ok: false, reason: REJECT.CALLER_SUPPLIED_METADATA, fields: reserved };
    /* 硬名单与 create 同款：patch 里出现 persona / publicProfile / 凭据 /
       共享 thread 字段同样整体拒绝，而不是静默丢弃。 */
    var deny = DC.denylistHits(patch);
    if (deny.length) return { ok: false, reason: REJECT.TEXT_DENYLISTED, fields: deny };
    if (DC.publicProfileWouldDoubleOwn(patch)) {
      return { ok: false, reason: REJECT.TEXT_DENYLISTED, fields: ['public-profile-double-authority'] };
    }
    /* 至少要改一件事。空 patch 不是错误，但它也不该被当成"成功保存"——
       那会让 UI 显示"已保存"而磁盘上什么都没变。 */
    var anyMutable = MUTABLE_FIELDS.some(function (k) { return has(patch, k); });
    if (!anyMutable) return { ok: false, reason: REJECT.NOTHING_TO_UPDATE };
    if (has(patch, 'level')) {
      var lvlReason = checkAuthoringLevel(patch.level);
      if (lvlReason) return { ok: false, reason: lvlReason, level: String(patch.level) };
    }
    var o = isPlainObject(opts) ? opts : {};
    var next = {
      factId: rec.factId,
      ownerCharacterId: rec.ownerCharacterId,   /* 不可变：来自 existing */
      level: has(patch, 'level') ? patch.level : rec.level,
      text: has(patch, 'text') ? patch.text : rec.text,
      source: rec.source,                       /* 不可变 */
      authority: rec.authority,                 /* 不可变 */
      authoredBy: rec.authoredBy,               /* 不可变 */
      subjectCharacterId: has(patch, 'subjectCharacterId') ? patch.subjectCharacterId : rec.subjectCharacterId,
      updatedAt: (o.now != null) ? o.now : Date.now()
    };
    var ex = DC.explain(next);
    if (!ex || !ex.ok) return { ok: false, reason: (ex && ex.reason) || REJECT.NOT_A_FACT };
    var out = DC.normalizeDisclosureFact(next);
    if (!out || !DC.isDisclosureFact(out)) return { ok: false, reason: REJECT.NOT_A_FACT };
    /* 最后一道结构断言：结果必须是**同一条**事实、**同一个** owner。
       这不是多余的 —— 它把"update 不能改归属"变成返回值上的性质，
       而不是只由上面的字段检查间接保证。 */
    if (out.factId !== rec.factId || out.ownerCharacterId !== rec.ownerCharacterId) {
      return { ok: false, reason: REJECT.OWNER_MISMATCH };
    }
    return { ok: true, fact: out };
  }

  /* ══════════ 9. delete ══════════════════════════════════════════

     删除同样要过归属校验：**只有** A 的上下文能删 A 的事实。
     否则"用户在编辑 B"这一个状态就足以删掉 A 的秘密。 */
  function planDelete(existing, writerContext) {
    if (!hasCore()) return { ok: false, reason: REJECT.NO_CORE };
    var rec = DC.normalizeDisclosureFact(existing);
    if (!rec) return { ok: false, reason: REJECT.NOT_A_FACT };
    var w = readWriterContext(writerContext);
    if (!w.ok) return { ok: false, reason: w.reason };
    if (w.owner !== rec.ownerCharacterId) return { ok: false, reason: REJECT.OWNER_MISMATCH };
    return { ok: true, factId: rec.factId, ownerCharacterId: rec.ownerCharacterId };
  }

  /* ══════════ 10. 分区读取 ══════════════════════════════════════════

     给定一批记录与一个 owner，返回**只属于该 owner** 的 canonical 记录。
     这是"切到 B 就只看到 B 的事实"的实现点，也是 A/B 分区在
     **读取侧**的保证（写入侧由 planCreate 的 owner 绑定保证）。

     非 canonical 记录（缺 owner / 未分类 / 无正文）一律**不进结果** ——
     旧数据不因为"恰好躺在同一张表里"而获得归属。 */
  function partitionForOwner(facts, ownerCharacterId) {
    var owner = normalizeOwner(ownerCharacterId);
    var list = Array.isArray(facts) ? facts : [];
    var out = [];
    if (!owner) return out;
    for (var i = 0; i < list.length; i++) {
      var rec = DC.normalizeDisclosureFact(list[i]);
      if (rec && rec.ownerCharacterId === owner) out.push(rec);
    }
    return out;
  }

  /* ══════════ 11. 导出 ══════════════════════════════════════════
     **没有** authorize() / canDisclose() / filterFor() / applyTrust() ——
     授权属 Phase 4B-2，被本轮明确禁止。导出表里不存在这些名字是刻意的：
     "未实现"应当是**找不到函数**，而不是"有个函数永远返回 true"。 */
  return {
    AUTHORING_LEVELS: AUTHORING_LEVELS,
    WRITER_SOURCE: WRITER_SOURCE,
    WRITER_AUTHORITY: WRITER_AUTHORITY,
    RESERVED_INPUT_KEYS: RESERVED_INPUT_KEYS,
    MUTABLE_FIELDS: MUTABLE_FIELDS,
    IMMUTABLE_FIELDS: IMMUTABLE_FIELDS,
    REJECT: REJECT,

    isAuthoringLevel: isAuthoringLevel,
    normalizeOwner: normalizeOwner,
    reservedHits: reservedHits,
    planCreate: planCreate,
    planUpdate: planUpdate,
    planDelete: planDelete,
    partitionForOwner: partitionForOwner
  };
});
