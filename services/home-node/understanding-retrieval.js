/* ====================================================================
   IB Home Node · Canonical Understanding Retrieval（M1-C.2m P7）
   --------------------------------------------------------------------
   职责：把 Home Node canonical 的 `understanding_records` 渲染成**与桌面逐字
   相同**的理解块，并做与桌面**同一份**的读时存证。

       canonical understanding_records（每角色恰好一份 active）
             ↓   memory-visibility-core.attestDerivedArtifact
             ↓   understanding-derivation-core.renderUnderstandingContext
             ↓   理解块
             ↓   Middle Brain 的 contextSnapshot（understanding 字段）
             ↓   organized.understanding → 注入

   ── 为什么渲染也必须共享 ──────────────────────────────────────────────
   M1-C.2m §10 要求"同一语义证据信封"，而不是"模型最后写出的文字相同"。
   若两端各自拼标题/维度/依据条数，同一份 canonical 文档会渲染出两段不同文本，
   Middle Brain 的 `understandingItems` 计数与压缩结果也随之不同 ——
   于是"证据相同"无法被证明。因此渲染只有一份实现，在共享核心里。

   ── 读时存证**不做**第二套实现 ────────────────────────────────────────
   沿用 `memory-visibility-core.attestDerivedArtifact`：印章必须允许该角色
   **且**每条证据仍可见 **且**证据集非空。因此"某条源记忆后来对该角色隐藏了"
   会在**读取即刻**停止注入，而不是等后台修复遍跑过（M1-C.2m §11）。

   ── 失败语义（与 memory-retrieval / thread-retrieval 同款纪律）────────
   store 不可读 / 渲染失败  → consulted:false（"没读成功"）
   文档存在但存证不过    → consulted:true, block:''（"读到了，但按规则不能注入"）
   两者对诊断的含义完全不同，绝不能合并成"空"。
   ==================================================================== */
'use strict';

const path = require('path');

const ASSETS_JS = path.join(__dirname, '..', '..', 'assets', 'js');
const UNDERSTANDING = require(path.join(ASSETS_JS, 'understanding-derivation-core.js'));
const VISIBILITY_CORE = require(path.join(ASSETS_JS, 'memory-visibility-core.js'));

function createUnderstandingRetrieval(deps) {
  deps = deps || {};
  const store = deps.store || null;                 /* understanding-store */
  const memoryStore = deps.memoryStore || null;     /* canonical memory store */
  const logger = deps.logger || (() => {});
  const core = deps.core || UNDERSTANDING;
  const visibilityCore = deps.visibilityCore || VISIBILITY_CORE;

  function readMemories() {
    if (!memoryStore || typeof memoryStore.listRecords !== 'function') {
      return { ok: false, error: 'memory-store-unavailable', records: [] };
    }
    try {
      const page = memoryStore.listRecords({});
      if (!page || !page.ok) return { ok: false, error: (page && page.error) || 'memory-read-failed', records: [] };
      return { ok: true, records: Array.isArray(page.records) ? page.records : [] };
    } catch (error) {
      logger('understanding-retrieve-memory-failed', { error: String((error && error.message) || error) });
      return { ok: false, error: 'memory-read-failed', records: [] };
    }
  }

  /* ── 纯读：canonical 文档 + 存证（无副作用）──────────────────────────
     返回 {ok, consulted, present, doc, attest, reason}：
       consulted  —— 真的读到了 store（区分"读不到"与"读到但不可注入"）
       present    —— 存在 active 文档且存证通过
       reason     —— 不可注入的结构化原因词表 */
  function read(characterId, options) {
    options = options || {};
    const owner = String(characterId == null ? '' : characterId);
    if (!owner) return { ok: false, consulted: false, present: false, doc: null, reason: 'no-character' };
    if (!store || typeof store.getActive !== 'function') {
      return { ok: false, consulted: false, present: false, doc: null, reason: 'understanding-store-unavailable' };
    }
    let doc = null;
    try { doc = store.getActive(owner); }
    catch (error) {
      logger('understanding-retrieve-failed', { error: String((error && error.message) || error) });
      return { ok: false, consulted: false, present: false, doc: null, reason: 'understanding-read-failed' };
    }
    /* 读到了 store：从这里开始 consulted 恒为 true —— 即使没有文档。 */
    if (!doc) return { ok: true, consulted: true, present: false, doc: null, reason: 'empty' };
    if (!doc.current || !doc.current.content) {
      return { ok: true, consulted: true, present: false, doc: doc, reason: 'no-content' };
    }
    const rows = readMemories();
    if (!rows.ok) {
      /* 证据来源读不出来 → **不**声明"没有理解"（那会让 Middle Brain 以为
         她确实没想法），而是如实报"没读成功"，允许消费方自行 retry。 */
      return { ok: false, consulted: false, present: false, doc: doc, reason: rows.error };
    }
    let attest = null;
    try {
      attest = visibilityCore.attestDerivedArtifact(
        doc.visibility,
        (doc.current && doc.current.evidenceIds) || [],
        rows.records,
        owner
      );
    } catch (error) {
      attest = { ok: false, permits: false, evidence: null, reason: 'attestation-failed' };
    }
    if (!attest || !attest.ok) {
      return {
        ok: true, consulted: true, present: false, doc: doc, attest: attest,
        reason: (attest && attest.reason) || 'attestation-failed'
      };
    }
    return { ok: true, consulted: true, present: true, doc: doc, attest: attest, reason: null };
  }

  /* ── 理解块：'' 表示"读到了但按规则不注入" ───────────────────────────
     渲染委托给共享核心，因此与桌面 `getUnderstandingContext` 逐字一致。 */
  function buildUnderstandingBlock(characterId, options) {
    options = options || {};
    const picked = read(characterId, options);
    if (!picked.present) {
      return Object.assign({}, picked, { block: '', reason: picked.reason || 'not-present' });
    }
    let block = '';
    try { block = core.renderUnderstandingContext(picked.doc, { maxChars: options.maxChars }); }
    catch (error) {
      logger('understanding-render-failed', { error: String((error && error.message) || error) });
      return Object.assign({}, picked, { present: false, block: '', reason: 'render-failed' });
    }
    if (!block) return Object.assign({}, picked, { present: false, block: '', reason: 'empty-render' });
    return Object.assign({}, picked, { block: block, reason: null });
  }

  /* ── 快照字段：交给 Middle Brain 的 context-snapshot 契约 ────────────
     三态与 memory / thread 完全一致：
       present —— 已读且有内容
       empty   —— 已读但为空（**禁止**消费方二次 retrieval）
       missing —— 本轮未读取 / 读取失败（允许消费方自行 retrieval）
     `gatedBy` 只在 missing 时出现，且必须**如实**区分"不可注入"与"读不到"。 */
  function snapshotField(characterId, options) {
    const built = buildUnderstandingBlock(characterId, options);
    const consulted = built.consulted === true;
    return {
      text: built.block || '',
      consulted: consulted,
      gatedBy: consulted ? null : 'home-node.understanding-unavailable',
      /* 诊断用（不进快照值）：读到了但不可注入时的结构化原因。 */
      reason: built.reason || null,
      docRevision: built.doc ? Number(built.doc.revision) || 0 : 0,
      evidenceCount: (built.doc && built.doc.current && built.doc.current.evidenceIds)
        ? built.doc.current.evidenceIds.length : 0
    };
  }

  /* ── 失效自检（诊断 / 后台调和）────────────────────────────────────
     返回"应当被标记为 stale 但当前仍是 active"的文档及其原因。
     刻意**不在读路径上写库**：读路径的职责是"立刻不注入"（已由存证保证），
     状态标记是另一件事，由显式调和调用完成。两者分开之后，
     "读一次就写一次盘"这种事情在结构上不可能发生。 */
  function staleCandidates(characterId) {
    const owner = String(characterId == null ? '' : characterId);
    const picked = read(owner);
    if (!picked.doc || picked.present) return { ok: true, stale: null };
    if (!picked.consulted) return { ok: false, error: picked.reason, stale: null };
    if (picked.reason === 'empty' || picked.reason === 'no-content') return { ok: true, stale: null };
    const evidence = picked.attest && picked.attest.evidence;
    const reason = (evidence && evidence.missing && evidence.missing.length) ? 'evidence-lost' : 'evidence-hidden';
    return { ok: true, stale: { id: picked.doc.id, revision: picked.doc.revision, reason: reason, attestReason: picked.reason } };
  }

  return {
    store: store,
    memoryStore: memoryStore,
    read: read,
    buildUnderstandingBlock: buildUnderstandingBlock,
    snapshotField: snapshotField,
    staleCandidates: staleCandidates
  };
}

module.exports = createUnderstandingRetrieval;
