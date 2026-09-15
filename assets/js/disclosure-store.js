/* ====================================================================
   IB Disclosure Store — canonical 披露事实的**唯一**持久化权威（Phase 4B-1.2）
   --------------------------------------------------------------------
   浏览器运行时层（IIFE，与 role-dm.js / social.js 同款）。挂在：
     window.IBDisclosureStore           （直接挂载，供独立诊断/测试）
     window.IB.disclosureStore          （IB 命名空间注册）

   它做四件事，**只做**这四件事：
     createFact(writerContext, userInput)   → 造一条 canonical 事实
     listFacts(ownerCharacterId)            → 读**某一个 owner** 的事实
     updateFact(writerContext, factId, patch)
     deleteFact(writerContext, factId)

   一个字节的判定逻辑都不在这里：形状归 disclosure-core.js，
   写者权威与可变面归 disclosure-authoring-core.js。本文件只负责
   **身份（factId）** 与 **落盘**。

   ── STORAGE AUTHORITY（为什么是独立 objectStore，而不是 memories）─────
   见 docs/DECISIONS.md D30 的完整审计。三句话版本：

     ① `memories` 的 `visibility` 是 **ACL**（哪些消费方可以读这条记录），
        `disclosure.level` 是 **sensitivity**（这条内容本身有多敏感）。
        放进同一张表，等于让每一个 `dbGetAll('memories')` 的调用方
        自己去分辨两种正交的语义 —— 而仓库里这样的调用方有十几处。
     ② `quickCreateMemory`（memory.js:954）的 canonical 默认是
        `visibility: data.visibility || 'public'` —— 用它造 disclosure fact
        会让一条 SECRET **立刻**变成可被召回、可被 consolidation 送进模型的
        public 记忆。安全性建立在一个必须**恰好缺失**的字段上，不是安全。
     ③ 仓库自己对"角色私有的长期记忆"已经做过同一个决定：
        role-letters.js:26 的 'roleLetterMemories' 命名空间，理由原文是
        "绝不写入共享 memories，避免污染 Memory 面板/export/backup"。
        披露事实比私信记忆更敏感，没有理由反而放宽。

   独立 store 还带来一个**可验证**的好处：core.js 的导出 / 镜像 / 文件夹同步
   全部按**显式 store 名单**工作（`_ibBuildExportData` core.js:986、
   `_ibMirrorPack` core.js:1029、`_ibFsSyncNow` core.js:1121），
   新 store 不在名单里 ⇒ 明文 SECRET **不会**被写进备份 JSON、
   localStorage 镜像或同步文件夹。这不是"忘了加"——见 §导出边界。

   ── 本模块**不做**什么（本轮硬边界）──────────────────────────────
     · 不读 trust / relationship / Memory / publicProfile / persona；
     · 不做授权、不做过滤、不判断"该不该告诉谁"；
     · **不被任何模型上下文构建器引用** —— 今天读不到，将来也只能经 4B-2 授权读；
     · 不写 memories / persona / publicProfile / relationship；
     · 不做 candidate 生成、不做 human_confirmation 流程。

   写入路径存在，读取路径不存在：
       本文件 → disclosureFacts（只增删改查）
       composeSide / getMemoryContext / diary / moments / letters / understanding
       / Middle Brain —— **没有任何一处**引用 window.IBDisclosureStore。

   §导出边界（刻意不做的事，写在这里免得被当成遗漏）
     本轮**不**把 disclosureFacts 加进 `_ibBuildExportData`。
     原因不是偷懒：导出 JSON 是**明文**（core.js:988-1000 的脱敏只清
     名字像 apiKey/token/secret 的**字段名**，不清正文），把 SECRET 正文
     写进去是"把秘密复制到三个明文表面"，需要它自己的契约与用户开关。
     代价是这一轮的用户创作**不进备份**（换机/恢复会丢），
     这条如实记在 D30 的 Deferred 里，而不是假装已经处理。
   ==================================================================== */
(function () {
  'use strict';

  /* ── canonical store 名（core.js 的 store 名单里必须有同名一项）── */
  var STORE_NAME = 'disclosureFacts';

  /* store 的 keyPath 是 'factId'（见 core.js 的 openDB keyPath 三元式）——
     刻意**不**用通用的 'id'：canonical 记录里没有 `id` 字段，
     为了迁就 keyPath 而复制一份 `id: factId` 会让身份有两个真源。 */

  /* 测试注入用。null = 走 window 上的生产实现。 */
  var ADAPTER = null;

  function win() {
    try { return (typeof window !== 'undefined') ? window : null; } catch (e) { return null; }
  }
  function core() {
    var w = win();
    return (w && w.IBDisclosureCore) || null;
  }
  function authoring() {
    var w = win();
    return (w && w.IBDisclosureAuthoringCore) || null;
  }
  /* IO 每次调用时**重新解析** —— 与仓库其余运行时层同一纪律：
     本文件不得在加载期就对另一个脚本求值（脚本顺序问题会变成静默 undefined）。 */
  function io() {
    if (ADAPTER) return ADAPTER;
    var w = win();
    return {
      put: w && w.dbPut,
      get: w && w.dbGet,
      all: w && w.dbGetAll,
      del: w && w.dbDelete
    };
  }

  /* factId 由 **store** 生成，不由契约生成：身份是持久化关注点，
     不是"这条事实是什么"的一部分（disclosure-core 的 normalize 刻意留空 factId，
     只有 buildDisclosureFact 会兜底生成 —— 那条路径不经过本 seam）。 */
  function newFactId() {
    return 'disc_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  }

  function fail(reason, extra) {
    return Object.assign({ ok: false, reason: reason }, extra || {});
  }
  /* 依赖缺失**不是**可恢复的业务失败，必须能被看见：
     静默返回空数组会让 UI 显示"你还没有任何私密事实" ——
     那是假的，而且是**危险方向**的假（用户会以为自己没写过秘密）。 */
  function depsReady() {
    if (!core()) return fail('disclosure-core-unavailable');
    if (!authoring()) return fail('authoring-core-unavailable');
    var d = io();
    if (!d.put || !d.all || !d.get || !d.del) return fail('store-unavailable');
    return { ok: true };
  }

  /* ══════════ create ══════════════════════════════════════════ */
  async function createFact(writerContext, userInput, opts) {
    var ready = depsReady();
    if (!ready.ok) return ready;
    var plan = authoring().planCreate(writerContext, userInput, opts);
    if (!plan.ok) return plan;
    var rec = Object.assign({}, plan.fact, { factId: newFactId() });
    try {
      await io().put(STORE_NAME, rec);
    } catch (e) {
      return fail('persist-failed', { error: String((e && e.message) || e) });
    }
    /* 返回**写进去的那一条**（含真实 factId），不是 plan 里的半成品。 */
    return { ok: true, fact: rec };
  }

  /* ══════════ list ══════════════════════════════════════════

     读**一个** owner 的事实，且**只**读它。分区由 authoring-core 的
     partitionForOwner 完成（按 canonical 记录的 ownerCharacterId），
     不按 createdBy / subjectCharacterId / visibleTo / 当前 peer 分组 ——
     那几个键在本契约里都不是归属。

     为什么用 dbGetAll + 过滤而不是 byOwner 索引：事实是**每条角色几十条**
     量级，而索引会给 core.js 增加一条必须与 store 名同步的声明，
     并且 dbGetByIndex 在索引缺失时会退化成一个**字段名猜错**的 fallback
     （core.js:13 的 fields 表里没有 byOwner）。分区语义写在契约里、
     不写在索引声明里，只有一个地方会错。 */
  async function listFacts(ownerCharacterId) {
    var ready = depsReady();
    if (!ready.ok) return ready;
    var rows;
    try {
      rows = await io().all(STORE_NAME);
    } catch (e) {
      return fail('read-failed', { error: String((e && e.message) || e) });
    }
    var A = authoring();
    var owner = A.normalizeOwner(ownerCharacterId);
    if (!owner) return fail('no-writer-owner');
    return { ok: true, ownerCharacterId: owner, facts: A.partitionForOwner(rows, owner) };
  }

  /* ══════════ update ══════════════════════════════════════════

     先按 factId 取回**磁盘上的**那一条，再让契约判定能不能改。
     绝不接受调用方传进来的"existing" —— 否则 UI 可以自己编一份
     带任意 owner 的 existing 来通过归属校验。 */
  async function updateFact(writerContext, factId, patch, opts) {
    var ready = depsReady();
    if (!ready.ok) return ready;
    if (typeof factId !== 'string' || !factId) return fail('missing-fact-id');
    var cur;
    try {
      cur = await io().get(STORE_NAME, factId);
    } catch (e) {
      return fail('read-failed', { error: String((e && e.message) || e) });
    }
    if (!cur) return fail('not-found', { factId: factId });
    var plan = authoring().planUpdate(cur, writerContext, patch, opts);
    if (!plan.ok) return plan;
    try {
      await io().put(STORE_NAME, plan.fact);
    } catch (e) {
      return fail('persist-failed', { error: String((e && e.message) || e) });
    }
    return { ok: true, fact: plan.fact };
  }

  /* ══════════ delete ══════════════════════════════════════════

     真删：`dbDelete` 走 IndexedDB 的物理删除，不留 tombstone、不留影子副本。
     本轮**不发明**墓碑系统 —— 仓库里没有任何 mirror/sync 消费方读这个 store
     （见文件头的导出边界），所以"删除后还能被谁读到"这个问题今天没有主语。
     将来若接入同步，墓碑语义应当在**那一次**按既有 canonical 规则决定，
     而不是现在提前发明一套。

     删除也**不**旁写任何东西：不写 memories、不改 persona、
     不动 publicProfile、不动 relationship。 */
  async function deleteFact(writerContext, factId) {
    var ready = depsReady();
    if (!ready.ok) return ready;
    if (typeof factId !== 'string' || !factId) return fail('missing-fact-id');
    var cur;
    try {
      cur = await io().get(STORE_NAME, factId);
    } catch (e) {
      return fail('read-failed', { error: String((e && e.message) || e) });
    }
    if (!cur) return fail('not-found', { factId: factId });
    var plan = authoring().planDelete(cur, writerContext);
    if (!plan.ok) return plan;
    try {
      await io().del(STORE_NAME, factId);
    } catch (e) {
      return fail('delete-failed', { error: String((e && e.message) || e) });
    }
    return { ok: true, factId: factId, ownerCharacterId: plan.ownerCharacterId };
  }

  /* 计数：只用于 UI 徽标。与 listFacts 同一条分区规则。 */
  async function countFacts(ownerCharacterId) {
    var r = await listFacts(ownerCharacterId);
    if (!r.ok) return r;
    return { ok: true, count: r.facts.length };
  }

  var api = {
    STORE_NAME: STORE_NAME,
    createFact: createFact,
    listFacts: listFacts,
    updateFact: updateFact,
    deleteFact: deleteFact,
    countFacts: countFacts,
    /* 测试注入（生产不调用）。传 null 恢复 window 上的实现。 */
    _setAdapter: function (a) { ADAPTER = a || null; }
  };

  var w = win();
  if (w) {
    w.IBDisclosureStore = api;
    if (w.IB && typeof w.IB.expose === 'function') w.IB.expose('disclosureStore', api);
  }
})();
