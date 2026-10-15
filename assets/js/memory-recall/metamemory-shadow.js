/* ====================================================================
   IB Memory · deterministic MetaMemory SHADOW（R4-B）
   --------------------------------------------------------------------
   R4 第一阶段的第一个 reconstructive runtime —— 但它**只是影子**。

   ── 它回答什么 ──────────────────────────────────────────────────────
     「这条记忆的**证据基础**现在是什么状态？」
   而不是：
     「角色主观觉得自己记得多清楚？」

     SYSTEM EVIDENCE STATE  !=  CHARACTER SUBJECTIVE MEMORY STATE
     前者是**系统已知事实**的机械投影；后者需要模型，本模块永不产出。

   ── 绝对安全规则（SHADOW ONLY）──────────────────────────────────────
     不改变：recall ranking / MemoryValue / cooldown / activation /
             selection / seat / budget / prompt / disclosure /
             persona / relationship
     不写入：任何 durable 状态（DB / IndexedDB / localStorage / 文件）
     不调用：LLM / 网络 / Home Node
     失败：局部 catch → 返回 unavailable，**chat/recall 继续，结果丢弃**

   ── 为什么是纯函数 ──────────────────────────────────────────────────
     输入只有：已经过 ACL 的可见记录 + 最终注入的 ids + 角色 id
              + **显式传入**的 now（本模块**从不**调用 Date.now()）
     输出：有界的 plain object（JSON-safe），只含 id / 计数 / 状态词，
            **绝不含记忆正文**。
     因此它可以被 Node 直接测试，也可以在浏览器里逐字同源运行。

   ── 证据语义**只有一份** ────────────────────────────────────────────
     本模块**不**实现"证据是否还活着"。它调用
     `memory-visibility-core.js` 的 `evidenceLiveness`（同一份 ACL 谓词、
     同一份 missing/hidden/degraded 归类）。缺它时 fail closed
     （state='degraded'），**绝不**发明第二套判定。
   ==================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    var deps = {};
    try { deps.visibility = require('../memory-visibility-core.js'); } catch (e) { deps.visibility = null; }
    module.exports = factory(deps);
  } else {
    root.IBMemoryMetaMemoryShadow = factory({
      visibility: root.IBMemoryVisibilityCore || null
    });
  }
})(typeof self !== 'undefined' ? self : this, function (DEFAULT_DEPS) {
  'use strict';

  /* ── 闭集词表（每一档都必须机械可判、互斥、有优先级）────────────── */

  /* 证据状态：**只**描述系统已知的证据基础，不描述角色感受。
     优先级（自上而下，先命中先返回）：
       1 unknown               选中的 id 在当前可见集里找不到对应记录
       2 degraded              判定本身无法执行（可见集不可读 / 证据核心缺失）
       3 evidence-lost         派生记忆：≥1 条声明的上游证据**已确认不存在**
       4 evidence-hidden       派生记忆：≥1 条声明的上游证据仍存在但对本角色不可见
       5 evidence-unavailable  派生记忆：≥1 条声明证据**不在当前授权视图内**，
                               且**原因不可观察**（不存在？被 ACL 挡住？别的角色？
                               其它？—— 见 POST_ACL_EVIDENCE_KNOWLEDGE_BOUNDARY）
       6 evidence-unattested   **应当**有上游证据，但一条都没声明
       7 attested              派生记忆：声明的上游证据全部 live
       8 direct                直接记忆：语义上**不需要**上游证据

     ── 3/4 与 5 的**可达边界**（R4-B.1 reconciliation）──────────────────
     生产接缝（`filterVisible` → `visible`）交给影子的**只有已授权记录**。
     在这种输入下"证据不在集合里"是**不可观察原因的并集**，所以生产视图
     只会产生 `evidence-unavailable`。

     `evidence-lost` / `evidence-hidden` 复用 `memory-visibility-core` 的
     **既有** closedReason 词（见该文件 §4），**只在调用方显式声明
     `evidenceView: 'full'`（受信内部诊断）时才可达** —— 那时才真的有
     全量集可供区分。生产运行时**默认不得**产生它们。

     3/4 的相对顺序与 memory-visibility-core 的 `reason` 归类**逐字一致**
     （lost 优先于 hidden），避免出现第二套优先级。 */
  var EVIDENCE_STATES = [
    'unknown', 'degraded', 'evidence-lost', 'evidence-hidden',
    'evidence-unavailable', 'evidence-unattested', 'attested', 'direct'
  ];

  /* 授权视图的两个值。默认 `authorized` —— 生产接缝**永远**用它。 */
  var EVIDENCE_VIEWS = ['authorized', 'full'];
  /* 只有这两个状态需要"全量权威视图"才可达。 */
  var FULL_VIEW_ONLY_STATES = ['evidence-lost', 'evidence-hidden'];

  /* 离散的证据完整性**状态词**。刻意不是 0..1 标量：
     仓库里**没有**冻结的数值公式，凭审美造 0.73 就是把无知伪装成精度。

     `none-live`（原 `broken`）是 R4-B.1 的措辞修正：`live = 0` 只能机械支撑
     "当前没有存活证据"，**不能**支撑"canonical 证据已毁坏" —— 后者在生产
     授权视图下是**不可观察**的。 */
  var EVIDENCE_CONFIDENCE_STATES = [
    'not-applicable',   /* 直接记忆：没有"应有证据数"这回事 */
    'complete',         /* 派生：声明的证据全部 live */
    'partial',          /* 派生：部分 live，部分 unavailable/lost/hidden */
    'none-live',        /* 派生：当前没有任何存活证据（**不**声称已毁坏） */
    'not-evaluated'     /* 判定无法执行 */
  ];

  /* 主观置信度：**系统不评估**。
     词表刻意复用上面那个**同一个** `not-evaluated` —— 不新增第二套词。 */
  var SUBJECTIVE_CONFIDENCE_STATES = ['not-evaluated'];

  var REASON_CODES = {
    ok: 'ok',
    noSelectedMemory: 'no-selected-memory',
    recordNotFound: 'record-not-in-visible-set',
    notEvaluated: 'evidence-not-evaluated',
    visibilityCoreMissing: 'visibility-core-missing',
    recordsUnreadable: 'visible-records-unreadable',
    upstreamExpectedButMissing: 'upstream-evidence-expected-but-missing',
    noUpstreamRequired: 'no-upstream-evidence-required',
    upstreamAllLive: 'upstream-evidence-all-live',
    upstreamPartiallyLive: 'upstream-evidence-partially-live',
    upstreamNoneLive: 'upstream-evidence-none-live',
    /* R4-B.1：授权视图下"证据不在集合里"的**诚实**措辞 ——
       原因是不可观察的，因此不宣称 lost/hidden。 */
    upstreamEvidenceUnavailable: 'upstream-evidence-not-in-authorized-view',
    upstreamEvidenceLost: 'upstream-evidence-lost',
    upstreamEvidenceHidden: 'upstream-evidence-hidden',
    /* R4-B 明确的**未实现**声明：诚实登记，而不是填满字段 */
    stateDeferred: 'memory-state-deferred-r4b',
    numericConfidenceDeferred: 'numeric-confidence-deferred-r4b',
    subjectiveNotEvaluated: 'subjective-confidence-not-evaluated',
    shadowUnavailable: 'shadow-unavailable'
  };

  /* 直接记忆的 producer 语义：它们记录的就是**事件本身**，
     没有"上游证据"这个概念。缺 evidenceIds 不是"证据缺失"。 */
  var DIRECT_SOURCES = [
    'manual', 'chat', 'group_chat', 'blog', 'letter', 'diary',
    'coread', 'cinema', 'activity', 'role_dm', 'user', 'auto'
  ];
  var UPSTREAM_EXPECTED_KINDS = ['consolidated'];
  var UPSTREAM_EXPECTED_SOURCES = ['consolidation'];

  function isPlainObject(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }

  function uniqueStrings(list) {
    var out = [];
    var seen = Object.create(null);
    var arr = Array.isArray(list) ? list : [];
    for (var i = 0; i < arr.length; i++) {
      if (arr[i] == null) continue;
      var s = String(arr[i]);
      if (!s || seen[s]) continue;
      seen[s] = true;
      out.push(s);
    }
    return out;
  }

  /* 声明的上游证据集 = consolidatedFrom ∪ evidenceIds（去重、保序）。
     两条来源都算：consolidation 写 consolidatedFrom，派生制品写 evidenceIds。 */
  function declaredEvidenceIds(record) {
    if (!isPlainObject(record)) return [];
    return uniqueStrings([].concat(record.consolidatedFrom || [], record.evidenceIds || []));
  }

  /* 该记录的 producer 语义**是否**声称存在上游证据。
     注意：这看的是 producer/kind 的**声明**，不是"有没有 evidenceIds" ——
     否则"直接记忆没有上游"会被误判成"证据缺失"。 */
  function upstreamExpected(record) {
    if (!isPlainObject(record)) return false;
    var kind = String(record.kind || '').toLowerCase();
    var source = String(record.rawSource || record.source || '').toLowerCase();
    if (UPSTREAM_EXPECTED_KINDS.indexOf(kind) >= 0) return true;
    if (UPSTREAM_EXPECTED_SOURCES.indexOf(source) >= 0) return true;
    return false;
  }

  /* derivation 看的是 **producer 语义**，不是"有没有 evidenceIds"：
     consolidation/consolidated 即使 consolidatedFrom 为空，它**仍然是**派生记忆
     —— 那种空正是 §7 的 UPSTREAM-EVIDENCE-EXPECTED-BUT-MISSING，
     不能因为"列表为空"就把它降级成"直接记忆"。 */
  function derivationOf(record) {
    if (upstreamExpected(record)) return 'derived';
    return declaredEvidenceIds(record).length > 0 ? 'derived' : 'direct';
  }

  /* ── 单条记录的 shadow（纯函数，无副作用）─────────────────────────
     view = 'authorized'（生产默认）| 'full'（受信内部诊断）。
     授权视图下**不可观察**的东西一律不得被断言。 */
  function classifyOne(record, liveness, view) {
    var declared = declaredEvidenceIds(record);
    var expected = upstreamExpected(record);
    var fullView = view === 'full';
    var base = {
      memoryId: record && record.id != null ? String(record.id) : null,
      derivation: derivationOf(record),
      /* ── 明确不评估的三个字段（诚实 > 字段完整）────────────────── */
      state: null,                    /* clear/fuzzy/fragmentary/… 见 STATE_SUPPORT */
      /* R4-B.1：`subjectiveConfidence` 的**未来类型是 number**（模型/人类给的
         0..1 置信度）。因此当前**不得**塞字符串 —— 那会把字段冻结成
         `number|string` 多态。运行时值 = null，评估状态另立一个字段。 */
      subjectiveConfidence: null,
      subjectiveConfidenceState: 'not-evaluated',
      evidenceConfidence: null,       /* 无数值公式 ⇒ 不给数字 */
      completeness: null
    };
    var provenance = {
      source: record && record.rawSource != null ? String(record.rawSource)
        : (record && record.source != null ? String(record.source) : null),
      sourceId: record && record.sourceId != null ? String(record.sourceId) : null,
      kind: record && record.kind != null ? String(record.kind) : null,
      declaredEvidenceCount: declared.length
    };
    var emptyCounts = fullView
      ? { live: 0, lost: 0, hidden: 0, unavailable: 0, degraded: false }
      : { live: 0, unavailable: 0, lost: null, hidden: null, degraded: false };

    /* 1. 判定无法执行 ⇒ degraded（fail closed，绝不假装成 direct/attested） */
    if (!liveness || liveness.degraded) {
      return Object.assign(base, {
        evidenceState: 'degraded',
        reasonCodes: [REASON_CODES.notEvaluated],
        evidenceConfidenceState: 'not-evaluated',
        provenance: provenance,
        evidence: Object.assign({}, emptyCounts, { degraded: true })
      });
    }

    /* 2. 直接记忆：语义上不需要上游证据 ⇒ 不是"缺失" */
    if (!expected && declared.length === 0) {
      return Object.assign(base, {
        evidenceState: 'direct',
        reasonCodes: [REASON_CODES.noUpstreamRequired],
        evidenceConfidenceState: 'not-applicable',
        provenance: provenance,
        evidence: emptyCounts
      });
    }

    /* 3. 应当有上游证据，却一条都没声明 ⇒ unattested（≠ direct） */
    if (declared.length === 0) {
      return Object.assign(base, {
        evidenceState: 'evidence-unattested',
        reasonCodes: [REASON_CODES.upstreamExpectedButMissing],
        evidenceConfidenceState: 'not-evaluated',
        provenance: provenance,
        evidence: emptyCounts
      });
    }

    var l = liveness.byId[base.memoryId] || { live: [], lost: [], hidden: [], unavailable: [] };
    var live = l.live.length;
    var lost = fullView ? (l.lost || []).length : null;
    var hidden = fullView ? (l.hidden || []).length : null;
    var unavailable = fullView ? 0 : (l.unavailable || []).length;
    var state, codes, conf;

    if (fullView && lost > 0) {
      state = 'evidence-lost';
      codes = [REASON_CODES.upstreamEvidenceLost];
      conf = live > 0 ? 'partial' : 'none-live';
    } else if (fullView && hidden > 0) {
      state = 'evidence-hidden';
      codes = [REASON_CODES.upstreamEvidenceHidden];
      conf = live > 0 ? 'partial' : 'none-live';
    } else if (!fullView && unavailable > 0) {
      /* 生产接缝：**不可观察原因**的并集 ⇒ 只宣称"不在授权视图内"。 */
      state = 'evidence-unavailable';
      codes = [REASON_CODES.upstreamEvidenceUnavailable];
      conf = live > 0 ? 'partial' : 'none-live';
    } else {
      state = 'attested';
      codes = [REASON_CODES.upstreamAllLive];
      conf = 'complete';
    }
    if (live === 0 && state !== 'attested') codes = codes.concat([REASON_CODES.upstreamNoneLive]);

    /* completeness：**只**在"存在可枚举的应有证据数"时才给。
       直接记忆没有这个数 ⇒ 保持 null（不伪造 1）。
       键集**稳定**；授权视图下不可观察的两个计数用 **null**（不是 0）——
       0 会假装"我们知道没有 lost/hidden"，null 才如实说"不知道"。 */
    var completeness = fullView
      ? {
        expected: declared.length, live: live, unavailable: 0,
        lost: lost, hidden: hidden,
        complete: live === declared.length && lost === 0 && hidden === 0
      }
      : {
        expected: declared.length, live: live, unavailable: unavailable,
        lost: null, hidden: null,
        complete: live === declared.length
      };

    return Object.assign(base, {
      evidenceState: state,
      reasonCodes: codes.concat([REASON_CODES.stateDeferred, REASON_CODES.numericConfidenceDeferred,
        REASON_CODES.subjectiveNotEvaluated]),
      evidenceConfidenceState: conf,
      completeness: completeness,
      provenance: provenance,
      evidence: fullView
        ? { live: live, lost: lost, hidden: hidden, unavailable: 0, degraded: false }
        : { live: live, unavailable: unavailable, lost: null, hidden: null, degraded: false }
    });
  }

  /* ── 回合级 shadow ──────────────────────────────────────────────────
     input（**只有**这些；刻意不接受 query / relevance / cooldown /
     MemoryValue / seat budget / prompt / 当前用户消息）：
       selectedIds  : string[]   最终被注入的 memory ids（post-seat）
       records      : object[]   **已经过 ACL** 的可见记录集
       roleId       : string|null 本次注入的角色（读主体）
       now          : number|null **显式**时钟；不传则 evaluatedAt 为 null
       evidenceView : 'authorized' | 'full'
                    **默认 'authorized'**（生产接缝的唯一合法取值）。
                    只有受信内部诊断才可显式传 'full'（那时才真的有全量集
                    可供区分 lost/hidden）。生产代码**不得**传 'full'。

     输出永远是有界 plain object；任何异常都被调用方/自身吞掉。 */
  function evaluateTurnShadow(input, deps) {
    var d = deps || DEFAULT_DEPS || {};
    var visibility = d.visibility || null;
    var result = {
      ok: true,
      evaluatedAt: null,
      evidenceView: 'authorized',
      memories: [],
      counts: { selected: 0, direct: 0, attested: 0, degraded: 0, defective: 0, unavailable: 0, lost: 0, hidden: 0 },
      reasonCodes: [],
      degraded: false
    };
    try {
      var src = isPlainObject(input) ? input : {};
      var view = EVIDENCE_VIEWS.indexOf(src.evidenceView) >= 0 ? src.evidenceView : 'authorized';
      result.evidenceView = view;
      var fullView = view === 'full';
      var selectedIds = uniqueStrings(src.selectedIds);
      result.counts.selected = selectedIds.length;
      if (src.now != null && isFinite(Number(src.now))) result.evaluatedAt = Number(src.now);
      if (!selectedIds.length) {
        result.reasonCodes.push(REASON_CODES.noSelectedMemory);
        return result;
      }

      var records = src.records;
      if (!Array.isArray(records)) {
        result.ok = false;
        result.degraded = true;
        result.counts.degraded = selectedIds.length;
        result.reasonCodes.push(REASON_CODES.recordsUnreadable);
        return result;
      }
      if (!visibility || typeof visibility.evidenceLiveness !== 'function') {
        result.ok = false;
        result.degraded = true;
        result.counts.degraded = selectedIds.length;
        result.reasonCodes.push(REASON_CODES.visibilityCoreMissing);
        return result;
      }

      var byId = new Map();
      for (var i = 0; i < records.length; i++) {
        var r = records[i];
        if (r && r.id != null && !byId.has(String(r.id))) byId.set(String(r.id), r);
      }

      /* **一次**判定，然后按记录分区 —— O(selected + records + Σevidence)，
         不是每条记录各扫一遍。这是本模块唯一一次调用证据核心。

         注意：`liveness` 在这里**总是**一个对象。只有"本轮确实存在待判定的
         上游证据、但判定本身失败"才该是 null —— 若本轮一条上游证据都没有
         （例如全是直接记忆、或全是 unattested 的派生记忆），判定是**成功**的，
         只是结果集为空。把那种情况当成 degraded 会把"没有上游证据"
         误报成"系统评估失败"。 */
      var bucket = Object.create(null);
      var allDeclared = [];
      var selectedRecords = [];
      for (var k = 0; k < selectedIds.length; k++) {
        var rec = byId.get(selectedIds[k]) || null;
        selectedRecords.push(rec);
        if (!rec) continue;
        var ids = declaredEvidenceIds(rec);
        if (ids.length) allDeclared = allDeclared.concat(ids);
      }
      allDeclared = uniqueStrings(allDeclared);
      var liveness = { degraded: false, byId: Object.create(null) };
      if (allDeclared.length) {
        var raw = visibility.evidenceLiveness(allDeclared, records, src.roleId == null ? null : String(src.roleId));
        /* 按记录重新分区：核心返回的是**并集**的分类。

           ── 授权视图下的知识边界（R4-B.1）────────────────────────────
           核心的 `missing` 语义是"行不在传入的集合里"。在生产接缝上，
           传入的集合**只有已授权记录**，所以"不在集合里"是**不可观察原因的
           并集**：记录不存在 / 被 ACL 挡住 / 属于别的角色 / 其它。
           因此授权视图把它归入 `unavailable`，**不**宣称 lost。

           只有调用方显式传 `evidenceView:'full'`（受信内部诊断，真的持有
           全量集）时，`missing` 才可以被如实读作 `evidence-lost`。 */
        var liveSet = new Set(raw.live), hiddenSet = new Set(raw.hidden), missingSet = new Set(raw.missing);
        liveness = { degraded: !!raw.degraded, byId: Object.create(null) };
        for (var s = 0; s < selectedRecords.length; s++) {
          var rr = selectedRecords[s];
          if (!rr) continue;
          var mine = declaredEvidenceIds(rr);
          var acc = { live: [], lost: [], hidden: [], unavailable: [] };
          for (var e = 0; e < mine.length; e++) {
            if (liveSet.has(mine[e])) acc.live.push(mine[e]);
            else if (fullView) {
              if (hiddenSet.has(mine[e])) acc.hidden.push(mine[e]);
              else acc.lost.push(mine[e]);
            } else acc.unavailable.push(mine[e]);
          }
          liveness.byId[String(rr.id)] = acc;
        }
      }

      for (var n = 0; n < selectedIds.length; n++) {
        var record = selectedRecords[n];
        if (!record) {
          result.memories.push({
            memoryId: selectedIds[n], derivation: 'unknown', evidenceState: 'unknown',
            reasonCodes: [REASON_CODES.recordNotFound], evidenceConfidenceState: 'not-evaluated',
            state: null, subjectiveConfidence: null, subjectiveConfidenceState: 'not-evaluated',
            evidenceConfidence: null,
            completeness: null, provenance: null,
            evidence: { live: 0, unavailable: 0, lost: null, hidden: null, degraded: false }
          });
          result.counts.degraded++;
          continue;
        }
        var one = classifyOne(record, liveness, view);
        result.memories.push(one);
        if (one.evidenceState === 'direct') result.counts.direct++;
        else if (one.evidenceState === 'attested') result.counts.attested++;
        else if (one.evidenceState === 'degraded' || one.evidenceState === 'unknown') result.counts.degraded++;
        else {
          result.counts.defective++;
          if (one.evidenceState === 'evidence-unavailable') result.counts.unavailable++;
          else if (one.evidenceState === 'evidence-lost') result.counts.lost++;
          else if (one.evidenceState === 'evidence-hidden') result.counts.hidden++;
        }
      }
      result.reasonCodes.push(REASON_CODES.stateDeferred, REASON_CODES.subjectiveNotEvaluated);
      return result;
    } catch (e) {
      /* 失败必须 fail open：影子计算炸了不能让 recall 或 chat 受影响。 */
      return {
        ok: false,
        evaluatedAt: null,
        evidenceView: 'authorized',
        memories: [],
        counts: { selected: 0, direct: 0, attested: 0, degraded: 0, defective: 0, unavailable: 0, lost: 0, hidden: 0 },
        reasonCodes: [REASON_CODES.shadowUnavailable],
        degraded: true
      };
    }
  }

  /* 状态支持矩阵（§9）的**代码内**冻结副本：哪些现在真的能机械产生。
     它是数据而不是散文，因此可以被测试逐条强制。 */
  var STATE_SUPPORT = {
    evidenceState: 'CURRENTLY_DERIVABLE',
    clear: 'NOT_DERIVABLE_YET',
    fuzzy: 'REQUIRES_LLM',
    fragmentary: 'REQUIRES_LLM',
    reconstructed: 'REQUIRES_LLM',
    conflicted: 'REQUIRES_ASSOCIATION',
    subjectiveConfidence: 'REQUIRES_LLM',
    evidenceConfidence: 'DERIVABLE_BUT_UNFROZEN',
    completeness: 'CURRENTLY_DERIVABLE'
  };

  return {
    evaluateTurnShadow: evaluateTurnShadow,
    classifyOne: classifyOne,
    declaredEvidenceIds: declaredEvidenceIds,
    upstreamExpected: upstreamExpected,
    derivationOf: derivationOf,
    EVIDENCE_STATES: EVIDENCE_STATES,
    EVIDENCE_CONFIDENCE_STATES: EVIDENCE_CONFIDENCE_STATES,
    SUBJECTIVE_CONFIDENCE_STATES: SUBJECTIVE_CONFIDENCE_STATES,
    EVIDENCE_VIEWS: EVIDENCE_VIEWS,
    FULL_VIEW_ONLY_STATES: FULL_VIEW_ONLY_STATES,
    REASON_CODES: REASON_CODES,
    STATE_SUPPORT: STATE_SUPPORT,
    DIRECT_SOURCES: DIRECT_SOURCES,
    UPSTREAM_EXPECTED_KINDS: UPSTREAM_EXPECTED_KINDS,
    UPSTREAM_EXPECTED_SOURCES: UPSTREAM_EXPECTED_SOURCES
  };
});
