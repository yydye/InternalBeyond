/* ====================================================================
   IB Home Node · Canonical Moments Retrieval（M1-C.2n P7）
   --------------------------------------------------------------------
   职责：把 Home Node canonical 的 `moment_records` 渲染成**与桌面逐字相同**
   的朋友圈动态块。

       canonical moment_records
             ↓   moments-visibility-core（唯一 ACL 实现）
             ↓   moments-visibility-core.renderSelected（唯一渲染实现）
             ↓   【朋友圈动态（系统参考，勿提及此段）】块
             ↓   Middle Brain 的 contextSnapshot（moments 字段）
             ↓   organized.moments → 注入

   ── 为什么渲染也必须共享 ─────────────────────────────────────────────
   如果节点自己拼这段文本，同一份 canonical 状态在两端会渲染出两段不同的字，
   Middle Brain 的 momentItems 计数与压缩结果随之不同 —— 于是"证据相同"
   无法被证明。M1-C.2m 把理解块的渲染搬进共享核，这里对动态块做同一件事。

   ── 与理解域的一个**真实差异**：这里没有"读时存证" ───────────────────
   理解是**派生制品**（它的证据是一组记忆，记忆可以后来对该角色隐藏），
   所以必须有 attestDerivedArtifact 在读取时重新验证证据。动态**不是派生制品**：
   它自己就是那条记录，它的可见性就在自己行上。因此这里不需要"二次存证"，
   只需要**在读取的那一刻**按当前可见性判定 —— 而审计要求的正是这件事
   （§3-E 收窄即刻生效）：改窄一次 visibility，下一次读取立刻反映。
   在这里加一层"存证"只会引入一个与权威不同的第二判据。

   ── 失败语义（与 memory/understanding/thread retrieval 同款纪律）──────
   store 不可读 / 渲染失败  → consulted:false（"没读成功"）
   读到了但没有可见内容      → consulted:true, block:''（"读到了，但没有可注入的"）
   两者对诊断的含义完全不同，绝不能合并成"空"。
   ==================================================================== */
'use strict';

const path = require('path');

const ASSETS_JS = path.join(__dirname, '..', '..', 'assets', 'js');
const MOMENT_VIS = require(path.join(ASSETS_JS, 'moments-visibility-core.js'));

/* 一次读多少条候选：块本身只注入 4 条自己的 + 3 条朋友的，
   但候选要足够宽，否则"被隐藏的行"会把窗口占满（§10）。
   这个上限是**扫描闸门**，不是内容策略：不足时如实报 reachedScanLimit。 */
const DEFAULT_SCAN_LIMIT = 200;

function createMomentsRetrieval(deps) {
  deps = deps || {};
  const store = deps.store || null;
  const logger = deps.logger || (() => {});
  const core = deps.core || MOMENT_VIS;
  /* 名字解析：节点侧来自 characters 表（mobile-safe DTO 的 nickname/handle）。
     缺省 → 全部回落 '另一角色'/'我'，桌面在同样缺名字时也回落同样的字，
     因此"两端口径一致"不依赖于名字是否配全。 */
  const characterNameOf = (typeof deps.characterNameOf === 'function') ? deps.characterNameOf : null;

  function readCandidates(principal, options) {
    if (!store || typeof store.listVisible !== 'function') {
      return { ok: false, error: 'moments-store-unavailable', moments: [] };
    }
    try {
      const page = store.listVisible(principal, { limit: options.scanLimit || DEFAULT_SCAN_LIMIT });
      if (!page || !page.ok) return { ok: false, error: (page && page.error) || 'moments-read-failed', moments: [] };
      return { ok: true, moments: Array.isArray(page.moments) ? page.moments : [], reachedScanLimit: !!page.reachedScanLimit };
    } catch (error) {
      logger('moments-retrieve-failed', { error: String((error && error.message) || error) });
      return { ok: false, error: 'moments-read-failed', moments: [] };
    }
  }

  /* ── 纯读：返回 {ok, consulted, present, block, reason, moments} ─── */
  function build(characterId, options) {
    options = options || {};
    const roleId = String(characterId == null ? '' : characterId);
    if (!roleId) return { ok: false, consulted: false, present: false, block: '', reason: 'no-character', moments: [] };
    if (!store || typeof store.listVisible !== 'function') {
      return { ok: false, consulted: false, present: false, block: '', reason: 'moments-store-unavailable', moments: [] };
    }
    const principal = { kind: 'role', id: roleId };
    const rows = readCandidates(principal, options);
    if (!rows.ok) {
      /* 读不到 ≠ 没有动态：如实报"没读成功"，让消费方自行重试。 */
      return { ok: false, consulted: false, present: false, block: '', reason: rows.error, moments: [] };
    }
    let block = '';
    let picked = { own: [], others: [] };
    try {
      picked = core.selectContextMoments(rows.moments, principal, {
        ownLimit: options.ownLimit == null ? 4 : options.ownLimit,
        otherLimit: options.otherLimit == null ? 3 : options.otherLimit,
        otherRolesVisible: options.otherRolesVisible !== false
      });
      block = core.renderSelected(picked, {
        characterId: roleId,
        userName: String(options.userName || '').trim() || '用户',
        characterNameOf: characterNameOf,
        now: options.now,
        maxChars: options.maxChars
      });
    } catch (error) {
      logger('moments-render-failed', { error: String((error && error.message) || error) });
      return { ok: true, consulted: true, present: false, block: '', reason: 'render-failed', moments: [] };
    }
    const moments = picked.own.concat(picked.others);
    if (!block) {
      return { ok: true, consulted: true, present: false, block: '', reason: 'empty', moments: moments, scanned: rows.moments.length };
    }
    return { ok: true, consulted: true, present: true, block: block, reason: null, moments: moments, scanned: rows.moments.length };
  }

  /* ── 快照字段：交给 Middle Brain 的 context-snapshot 契约 ─────────────
     三态与 memory / understanding / thread 完全一致：
       present —— 已读且有内容
       empty   —— 已读但为空（**禁止**消费方二次 retrieval）
       missing —— 本轮未读取 / 读取失败（允许消费方自行 retrieval） */
  function snapshotField(characterId, options) {
    const built = build(characterId, options);
    const consulted = built.consulted === true;
    return {
      text: built.block || '',
      consulted: consulted,
      gatedBy: consulted ? null : 'home-node.moments-unavailable',
      reason: built.reason || null,
      visibleCount: (built.moments || []).length
    };
  }

  return {
    store: store,
    build: build,
    buildMomentsBlock: build,
    snapshotField: snapshotField,
    readCandidates: readCandidates
  };
}

module.exports = createMomentsRetrieval;
