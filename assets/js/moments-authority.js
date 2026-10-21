/* ====================================================================
   IB Moments Authority — 浏览器侧"Home Node 说了算"的适配层（M1-C.2n P5/P6）
   --------------------------------------------------------------------
   - Browser: <script src="assets/js/moments-authority.js"> → window.IBMomentsAuthority
   - Node   : require('../assets/js/moments-authority.js').createMomentsAuthority

   与 memory / understanding 同款三态（canonical / mirror / off），**但写协议
   是第四种**，因为动态与它们都不同：

     只读的认知状态（理解）   写完就没人能改，写者也只有派生器一个
     可变的映射（记忆）       覆盖式，无 CAS
     **动态**                 多条、可编辑、可删除、可点赞、可评论；
                             两个真实写者（用户界面 + 后台 companion）

   因此本层的三件关键事情是：

     ① **写先到 Home Node**，成功之后才更新镜像（不是"先写本地再同步"）。
        后者是假收敛：两台 canonical 并存，谁都不是权威。

     ② **CAS 由书写者携带**：编辑/删除带 expectedRev，服务端拒绝过期基版本。
        没有这一条，"用户在编辑"与"角色在点赞"同时发生时会静默覆盖。

     ③ **幂等键随写带上**：动态的创建可能因为网络重试而被提交两次。
        服务端按 requestId 重放，因此重试不产生第二条动态（R7）。

   ── 为什么本地镜像仍然必须存在 ───────────────────────────────────────
   它不是"第二权威"，而是：
     · 桌面渲染的读来源（读镜像，不每帧打网络）；
     · 迁移的来源（搬家之前的老数据在这里）；
     · 回滚影子（file:// / mode=off / mirror 时行为与迁移前逐字相同）。

   ── 镜像读的纪律 ─────────────────────────────────────────────────────
   读之前必须 `ensureReady()`（先补齐镜像）。否则页面刚打开时会读到
   "迁移之前"的本地动态，而权威已经是 Home Node。这条与 memory/understanding
   完全同款：那是本仓库吃过一次的亏。

   ══ canonical hydration contract（P11-3F）══════════════════════════════
   ONE CANONICAL REMOTE STATE → ONE LOCAL MIRROR。
   镜像的**破坏性整表替换**（replaceAll）只允许发生在下面这一条成立之后：

       远端 authority 已成功返回一个**完整、权威、可解释**的 snapshot

   判据（四条缺一不可，全部看**服务端明说的东西**，不看推断）：

     ① `res.ok === true`          —— 传输层没有把它合成为失败；
     ② `Array.isArray(records)`   —— 字段**存在且是数组**（不是 undefined/null）；
     ③ `res.truncated === false`  —— 服务端**显式声明**这一页是完整的；
     ④ `typeof revision === 'number' && isFinite(revision)`

   于是下面这些状态**永远不构成** authoritative empty，**永远不许**碰镜像：

     HTTP/network failure · timeout · 503 store-closed · 500 db-* ·
     malformed JSON · 缺 payload / 错信封 · records 缺失或 null ·
     分页被截断 · revision 缺失 · 任何 `catch` 兜底出来的 `[]`

   而**真正的** authoritative empty（`ok:true` + `truncated:false` + `records:[]`
   + 合法 revision）**必须**能够合法地清空镜像 —— 这不矛盾：
   禁止的是"没有证据的清空"，不是"清空"。

   失败时：**不碰镜像**，只如实记 `degradedReason` / `lastError`，
   `hydrated` 不许变真，`cursor` / `mirrorRevision` 不许前进。

   另两条并发不变量：

     · **串行化**：所有会改镜像的路径（hydrate 提交 / 增量 / put / remove）
       排在同一条 promise 链上，"检查代次"与"真正落盘"之间因此没有窗口；
     · **代次 + 水位**：`hydrateGen` 保证旧的 hydrate 不能覆盖更新的 hydrate；
       `mirrorRevision`（已落盘的最高权威版本）保证晚提交的旧快照不能把
       镜像拖回更早的状态（hydrate × 增量 changes 的竞争）。

   `[]` 是**数据**，不是错误兜底 —— 这一条是本层最容易写反的地方。

   ══ change-log delivery contract（P11-3G）══════════════════════════════
   ONE CHANGE EVENT → BOUNDED DELIVERY → EXPLICIT OUTCOME → NO PERMANENT
   HEAD-OF-LINE BLOCKING。快照是**恢复权威**，change_log 只是**有界增量传输**：
   它既不是永久历史，也不是第二 authority。

   ── 四个状态，绝不压成一个 boolean ────────────────────────────────────

     PENDING           已读到、还没有持久结论
     APPLIED           该 event 的镜像写入**已经持久提交**
     RETRYABLE_FAILURE 应用失败且 attempts < 上界（退避中）
     TERMINAL_FAILURE  应用失败且 attempts 用尽（或结构上不可能应用）

   APPLIED 刻意**不**单独持久化：镜像行本身就是"已应用"的证据，而每个
   event 的应用语义（按 id put / 按 id delete）天然幂等，所以重放不需要
   去重表 —— 需要持久化的是"还欠着什么"（pending/terminal）与"确认到哪"
   （cursor）。把 APPLIED 也存一份只会得到一个可以与镜像漂移的第二份事实。

   ── ACK 到底证明什么 ─────────────────────────────────────────────────

        ACK(W) = consumer 对 revision ≤ W 的**每一个** event
                 都已经得出**持久结论**（applied 或 terminal）

   它**不**证明：HTTP 200 / 事件被读过 / 事件被尝试过 —— 那三件事都不是结论。
   服务端只需要 W 一个数，且只拿它做一件事：决定 change_log 哪些行可以回收。

   W 的推进规则（三条都是可测的）：
     · 只在一个 event 得出**持久结论之后**推进，绝不提前 ——
       因此"先 ack 再 apply"这个会真正丢数据的顺序在本层不可能出现；
     · 只沿**连续前缀**推进：前缀里有一个还是 pending，W 就停在它前面；
     · 单调：回退的结论一律取 max 吃掉。

   ── crash consistency ────────────────────────────────────────────────

        apply → 持久结论  之间 crash：**允许重放**，而重放必须幂等。
        （镜像写入 → 状态写入；状态落后于镜像永远是安全方向。）

   反向顺序（持久 ack → apply）**禁止**：那会产生真正的丢数据窗口 ——
   重启后 cursor 已经越过某个从未落盘的 event，而它再也不会被投递。

   ── 毒事件与队头阻塞 ─────────────────────────────────────────────────

   一个永久失败的 event 绝不能**永久**占据 limit 窗口。这里的收口方式是
   最小的一种：**attempts 有界 → 终态 → cursor 越过它**。三条一起才成立：
     · 页面上第一个失败就**停下本页**（不去逐个尝试后面的事件）——
       这避免了一次镜像级故障把整窗 event 全部烧成终态（那是大规模数据丢失，
       比队头阻塞更糟）；代价是健康事件最多等 maxAttempts 轮；
     · attempts 用尽 → 记为终态 → cursor **越过**它，本页继续；
     · 终态意味着"镜像少了这条"，因此随即用**快照**把它补回来
       （P11-3F 的 hydrate，一字不改）—— 这是"终态不等于丢数据"的依据。
   结构上就不可能应用的 event（缺 id / 未知 kind）**一次也不重试**：
   同样的字节重试一万次也是同样的结果。

   ── retention 与 gap ────────────────────────────────────────────────

   服务端只在"全体已注册投递水位的最小值"以下回收日志。消费者据此自检：
   `retainedFrom > cursor + 1` → 我未确认的那一段已被回收 → **回退到快照重建**。
   revision 在日志里是稠密的、回收只删前缀，所以这个判据是充分的。
   ==================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); }
  else { root.IBMomentsAuthority = factory(); }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var MODES = ['canonical', 'mirror', 'off'];
  /* 镜像播种的上界。刻意**不**用一个小小的默认值：那会让"库里的动态比它多"
     变成"镜像被静默截断"。攒不够时由服务端的 `truncated` 如实报告，
     本层据此**拒绝**破坏性替换（镜像保持原样 + 如实降级），而不是截断它。 */
  var DEFAULT_SEED_LIMIT = 20000;
  var DEFAULT_MIGRATE_BATCH = 100;

  /* ── P11-3G · 投递策略（delivery policy）────────────────────────────────
     这是**投递重试**，不是进程恢复：它约束的是"一个 change event 最多被
     尝试几次"，不是"一个进程最多被拉起几次"。因此**刻意不**引入
     runtime/component-supervisor.js —— 那是 P11-3C 的进程级 supervisor
     （滑动窗口 + 锁闭 + 重启编排），照搬过来会得到第二套完整的恢复系统，
     而这里需要的只是三个数字与一条顺序。

     复用的是**纪律**而不是那个对象：
       · 上界必须是有限的，且构造处夹紧（拒绝 Infinity/NaN/负数）；
       · 退避永远不为 0 —— 零退避是穿着策略外衣的忙循环；
       · 只有**真实的失败尝试**才 +1，一次被退避挡下的轮次不算尝试。

     与 bootstrap 的 `withRetry` 的关系也是分层的：那个是**同一次调用内**的
     毫秒级重试（传输/镜像写），崩溃即消失；这里是**跨 sync 轮次、可持久**的
     投递重试。两者不是同一个问题，也不共用状态。 */
  var DELIVERY_CONSUMER = 'desktop-mirror';
  var DELIVERY_MAX_ATTEMPTS = 4;        /* 夹紧在 1..8 */
  var DELIVERY_HARD_MAX_ATTEMPTS = 8;
  var DELIVERY_BASE_BACKOFF_MS = 500;
  var DELIVERY_MAX_BACKOFF_MS = 30000;
  var DELIVERY_TERMINAL_KEEP = 20;      /* 终态诊断环的**有界**保留条数 */

  function normalizeAttempts(value) {
    var n = Number(value);
    if (!isFinite(n) || n < 0) return 0;
    n = Math.trunc(n);
    return n > DELIVERY_HARD_MAX_ATTEMPTS ? DELIVERY_HARD_MAX_ATTEMPTS : n;
  }
  function backoffFor(attempts) {
    var n = normalizeAttempts(attempts);
    if (n <= 1) return DELIVERY_BASE_BACKOFF_MS;
    var scaled = DELIVERY_BASE_BACKOFF_MS * Math.pow(2, n - 1);
    return scaled > DELIVERY_MAX_BACKOFF_MS ? DELIVERY_MAX_BACKOFF_MS : scaled;
  }
  /* 应用失败的分类：封闭词表 + 一个保守兜底。分类**只**影响诊断与"是否
     值得继续尝试后面的 event"，不改变上界 —— 分不出来的错误照样是有界的。 */
  function applyFailureOf(error) {
    var name = String((error && error.name) || '');
    if (name === 'QuotaExceededError') return { error: 'mirror-quota', category: 'mirror-level' };
    if (name === 'InvalidStateError' || name === 'UnknownError' || name === 'AbortError' ||
      name === 'VersionError' || name === 'NotFoundError' || name === 'NotAllowedError') {
      return { error: 'mirror-unavailable', category: 'mirror-level' };
    }
    if (name === 'DataError' || name === 'DataCloneError' || name === 'ConstraintError' ||
      name === 'TypeError' || name === 'SyntaxError' || name === 'NotSupportedError') {
      return { error: 'event-rejected', category: 'event-local' };
    }
    if (error === false) return { error: 'mirror-not-written', category: 'mirror-level' };
    /* 分不出来 → 按"这一条自己的问题"处理（继续后面的 event），
       但上界照旧 —— 未知错误不会变成无限重试。 */
    return { error: 'mirror-write-failed', category: 'unclassified' };
  }
  /* event 的**结构**判据。做不到的 event 一次也不重试：同样的字节重试一万次
     也是同样的结果，把它记成终态才是诚实的（而终态会被快照补回来）。 */
  function inapplicableReason(event) {
    if (event.kind !== 'upsert' && event.kind !== 'delete') return 'unknown-kind';
    if (!event.row || event.row.id == null || String(event.row.id) === '') return 'record-id-missing';
    if (!(event.revision > 0) || !isFinite(event.revision)) return 'revision-invalid';
    return null;
  }
  function freshDelivery() {
    return {
      v: 1, consumer: DELIVERY_CONSUMER, cursor: 0,
      attempts: {}, terminal: [], lastAckAt: 0, recovery: null
    };
  }
  function normalizeDelivery(raw) {
    var base = freshDelivery();
    if (!raw || typeof raw !== 'object') return base;
    if (Number(raw.v) !== 1) return base;
    /* consumer 不匹配 → 这不是我们的状态（换过 consumer id / 别人写的），
       宁可从头开始（boot hydrate 会把 cursor 重新立起来）。 */
    if (String(raw.consumer || '') !== DELIVERY_CONSUMER) return base;
    var out = freshDelivery();
    out.cursor = Math.max(0, Number(raw.cursor) || 0);
    out.lastAckAt = Math.max(0, Number(raw.lastAckAt) || 0);
    var attempts = (raw.attempts && typeof raw.attempts === 'object') ? raw.attempts : {};
    Object.keys(attempts).forEach(function (key) {
      var rev = Number(key);
      var rec = attempts[key];
      if (!(rev > 0) || !rec || typeof rec !== 'object') return;
      out.attempts[String(rev)] = {
        revision: rev, kind: String(rec.kind || ''), recordId: String(rec.recordId || ''),
        attempts: normalizeAttempts(rec.attempts), error: String(rec.error || ''),
        category: String(rec.category || ''), detail: String(rec.detail || ''), lastAt: Math.max(0, Number(rec.lastAt) || 0)
      };
    });
    var terminal = Array.isArray(raw.terminal) ? raw.terminal : [];
    for (var i = 0; i < terminal.length && out.terminal.length < DELIVERY_TERMINAL_KEEP; i++) {
      var t = terminal[i];
      if (!t || typeof t !== 'object' || !(Number(t.revision) > 0)) continue;
      out.terminal.push({
        revision: Number(t.revision), kind: String(t.kind || ''), recordId: String(t.recordId || ''),
        attempts: normalizeAttempts(t.attempts), error: String(t.error || ''),
        category: String(t.category || ''), detail: String(t.detail || ''), at: Math.max(0, Number(t.at) || 0),
        resolvedBy: t.resolvedBy ? String(t.resolvedBy) : null,
        resolvedAt: t.resolvedAt ? Math.max(0, Number(t.resolvedAt) || 0) : null
      });
    }
    if (raw.recovery && typeof raw.recovery === 'object' && raw.recovery.needed === true) {
      out.recovery = { needed: true, reason: String(raw.recovery.reason || 'terminal-outcome'), at: Math.max(0, Number(raw.recovery.at) || 0) };
    }
    return out;
  }

  function createMomentsAuthority(deps) {
    deps = deps || {};
    var remote = deps.remote || null;
    var local = deps.local || null;
    var clock = deps.clock || function () { return Date.now(); };
    var log = deps.log || function () {};
    var mode = MODES.indexOf(deps.mode) >= 0 ? deps.mode : 'canonical';
    var fileOrigin = !!deps.fileOrigin;

    var ctx = {
      mode: mode,
      fileOrigin: fileOrigin,
      remoteOnline: null,
      hydrated: false,
      cursor: 0,
      /* 已经**落盘到镜像**的最高权威版本（P11-3F）。它比 `cursor` 严：
         `cursor` 只说"增量读到哪里了"，`mirrorRevision` 说"镜像里的内容对应哪一版"。
         put / remove 会推进它（它们只走一条行、不动 cursor），
         而 hydrate 提交旧快照时会与它比较 —— 低于它的快照一律拒收（superseded）。 */
      mirrorRevision: 0,
      /* 与 memory / understanding 逐字同款：权威是否**结构性生效**
         （canonical 且非 file://）。刻意不看 remoteOnline —— 节点临时不可达时
         权威仍然是它，本地写必须 fail closed，而不是"悄悄写第二份 canonical"。 */
      authorityEffective: (mode === 'canonical') && !fileOrigin,
      degradedReason: mode === 'canonical'
        ? (fileOrigin ? 'file-origin-cannot-reach-home-node' : 'not-probed')
        : (mode === 'mirror' ? 'mode-mirror' : 'mode-off'),
      lastSyncAt: 0,
      lastError: null,
      /* P11-3G · 投递侧的可见状态。`deliveryDurable` 是**如实上报**：
         本地驱动没有持久化接缝时它是 false（重试上界本会话内仍然成立，
         但 attempts 不会跨进程存活）；绝不假装持久。 */
      deliveryDurable: false,
      deliveryGap: null,
      stats: {
        reads: 0, writes: 0, readsRemote: 0, writesRemote: 0,
        conflicts: 0, failures: 0, syncs: 0, hydrations: 0,
        migrated: 0, migrateSkipped: 0, migrateRejected: 0, replays: 0,
        delivered: 0, retried: 0, terminated: 0, recovered: 0, acks: 0
      }
    };

    var readyPromise = null;
    function remoteEnabled() { return !!remote && (mode === 'canonical') && !fileOrigin; }
    function authorityEffective() { return ctx.authorityEffective === true; }
    /* 降级的**唯一**判据（原先 status() 与 decorateRead() 各写一份，已经是一致的
       形状，但仍然是可以漂移的两处）。P11-3F 把"有 degradedReason"也算进来：
       镜像写入失败时节点其实是可达的，此前的公式会说 degraded:false ——
       一个"写不进镜像却自称健康"的假绿。 */
    function isDegraded() {
      return !authorityEffective() || ctx.remoteOnline === false || ctx.degradedReason != null;
    }
    function fail(code, extra) {
      ctx.stats.failures++;
      return Object.assign({ ok: false, error: code, authority: mode === 'canonical' ? 'home-node' : 'indexeddb' }, extra || {});
    }
    function noteRemoteFailure(error) {
      ctx.remoteOnline = false;
      ctx.degradedReason = (error && error.code) || 'home-node-unreachable';
      ctx.lastError = String((error && error.message) || error || '');
    }
    function isTransportFailure(res) {
      return !res || res.offline || /unreachable|transport|timeout/.test(String((res && res.error) || ''));
    }

    /* ── 失败响应的码：服务端的 error 是**对象**（{code,message,retryable}），
       传输层自己合成的失败是**字符串**（'timeout' / 'invalid-response' / …）。
       这里只做归一化，不新增词表：拿到的永远是既有闭集里的那个 id。 */
    function errorCodeOf(res) {
      if (!res) return 'list-failed';
      var raw = res.error;
      if (raw && typeof raw === 'object') return String(raw.code || raw.error || 'home-node-error');
      var code = String(raw == null ? '' : raw);
      return code || 'list-failed';
    }
    /* 终态判据与 P11-3E 的**同一套**：`runtime/db-failure.js` 分类出来的 db-*
       是"重试也不会好"的那一类；其余（store-closed / 传输）都可重试。 */
    function isTerminalCode(code) { return /^db-/.test(String(code || '')); }

    /* ── 快照裁决：唯一能授权破坏性替换的判据 ──────────────────────────────
       刻意**只**看服务端明说的字段。任何一处缺失 → 拒绝，且不猜。 */
    function validateSnapshot(page) {
      if (!page || page.ok !== true) {
        var code = errorCodeOf(page);
        var terminal = isTerminalCode(code);
        return {
          ok: false, error: code, status: (page && page.status) || null,
          outcome: terminal ? 'terminal-failure' : 'unavailable',
          retryable: !terminal
        };
      }
      /* 完整性必须**被声明**。缺失（老服务端 / 坏信封）不算完整 —— 这正是
         "缺字段"与"权威空集合"被压成同一个状态的入口。 */
      if (page.truncated !== false) {
        if (page.truncated === true) {
          return { ok: false, error: 'incomplete-snapshot', outcome: 'incomplete', status: page.status || null, detail: 'authority-declared-incomplete' };
        }
        return { ok: false, error: 'invalid-response', outcome: 'invalid-response', status: page.status || null, detail: 'missing-completeness-declaration' };
      }
      if (!Array.isArray(page.records)) {
        return { ok: false, error: 'invalid-response', outcome: 'invalid-response', status: page.status || null, detail: 'records-missing' };
      }
      /* revision 必须真的存在。`Number(page.revision || 0)` 会把"没有版本号"
         悄悄变成 0，而 0 是一个**合法的**版本（全新库）—— 于是"缺失"与
         "确实还没有任何写入"再次压成同一个状态。 */
      if (typeof page.revision !== 'number' || !isFinite(page.revision)) {
        return { ok: false, error: 'invalid-response', outcome: 'invalid-response', status: page.status || null, detail: 'revision-missing' };
      }
      return { ok: true, records: page.records, revision: page.revision, count: page.records.length };
    }

    /* 非权威结论的统一落地：**不碰镜像**，只把真实状态留在 ctx 里。
       `hydrated` 保持原值（绝不因为一次失败就变真），cursor / mirrorRevision 不动。 */
    function noteSnapshotFailure(verdict) {
      ctx.stats.failures++;
      ctx.remoteOnline = false;
      ctx.degradedReason = verdict.error;
      ctx.lastError = verdict.detail ? verdict.error + ':' + verdict.detail : verdict.error;
      log('moments-hydrate-refused', {
        outcome: verdict.outcome, error: verdict.error,
        detail: verdict.detail || null, status: verdict.status || null
      });
      return {
        ok: false, error: verdict.error, outcome: verdict.outcome, authority: 'home-node',
        retryable: verdict.retryable !== false, snapshotStatus: verdict.status || null
      };
    }

    /* 镜像写入串行化。所有会改镜像的路径都排在同一条链上，因此
       "检查代次 / 水位"与"真正落盘"之间不存在可插入的窗口。
       链上的失败被吞掉（只影响本次调用的返回值），否则一次失败会让后续全部卡死。 */
    var mirrorChain = Promise.resolve();
    function withMirrorLock(task) {
      var run = mirrorChain.then(task, task);
      mirrorChain = run.then(function () { }, function () { });
      return run;
    }
    /* 最近一次 hydrate 的代次（只有最新那一次有权提交镜像）。 */
    var hydrateGen = 0;

    /* ── P11-3G · 投递状态的持久面 ─────────────────────────────────────────
       状态住在**浏览器镜像库自己的 meta 平面**（与迁移水位 `migration:moments:*`
       同一类东西、同一个 store），因此**没有新表、没有 schema 变更**。
       它保存的不是动态内容，只是投递记账（cursor / attempts / terminal），
       所以它**不是**第二套 Moments authority —— 权威仍然只有 Home Node 一份。 */
    var deliveryState = null;
    /* 键的形状由本层唯一决定，驱动只是一个**哑的**键/值接缝
       （与迁移水位共用同一张 meta 表）—— 键的格式不在两处各写一份。 */
    function deliveryKey() { return 'delivery:moments:' + DELIVERY_CONSUMER; }
    function deliverySeam(load) {
      if (!local) return null;
      if (load) return typeof local.deliveryState === 'function' ? local.deliveryState : null;
      return typeof local.saveDeliveryState === 'function' ? local.saveDeliveryState : null;
    }
    function loadDelivery() {
      if (deliveryState) return Promise.resolve(deliveryState);
      var read = deliverySeam(true);
      if (!read) {
        deliveryState = freshDelivery();
        ctx.deliveryDurable = false;
        return Promise.resolve(deliveryState);
      }
      return Promise.resolve().then(function () { return read.call(local, deliveryKey()); }).then(function (raw) {
        deliveryState = normalizeDelivery(raw);
        ctx.deliveryDurable = true;
        return deliveryState;
      }, function (error) {
        /* 读不出来 → 不能假装读到了。内存里从零开始，并如实标注不可持久；
           boot 的 hydrate 会把 cursor 重新立到快照版本上，因此这不是丢数据。 */
        deliveryState = freshDelivery();
        ctx.deliveryDurable = false;
        ctx.lastError = 'delivery-state-unreadable:' + String((error && error.message) || error);
        log('moments-delivery-state-unreadable', { error: ctx.lastError });
        return deliveryState;
      });
    }
    /* 状态写入**永远**排在镜像写入之后。反过来的顺序会产生"ack 了但没应用"
       的窗口 —— 那是本层唯一真正会丢数据的顺序。写失败不抛：状态落后于镜像
       是安全方向（重放幂等），但它必须被如实上报，不能静默。 */
    function saveDelivery() {
      var write = deliverySeam(false);
      if (!write || !deliveryState) return Promise.resolve({ ok: false, durable: false });
      var snapshot = JSON.parse(JSON.stringify(deliveryState));
      return Promise.resolve().then(function () { return write.call(local, deliveryKey(), snapshot); }).then(function () {
        return { ok: true, durable: true };
      }, function (error) {
        ctx.deliveryDurable = false;
        ctx.lastError = 'delivery-state-write-failed:' + String((error && error.message) || error);
        log('moments-delivery-state-write-failed', { error: ctx.lastError });
        return { ok: false, durable: false };
      });
    }
    /* 把 ACK 水位报给权威。失败**不影响**本次同步的结论：ACK 送不到只让回收
       变保守（日志留得更多），不会让任何 event 被跳过。 */
    function reportDelivery() {
      if (!deliveryState || !remote || typeof remote.ack !== 'function') return Promise.resolve(null);
      var watermark = deliveryState.cursor;
      if (!(watermark > (deliveryState.lastAckAt || 0))) return Promise.resolve(null);
      var reported = watermark;
      return Promise.resolve().then(function () {
        return remote.ack(reported, { consumer: DELIVERY_CONSUMER });
      }).then(function (res) {
        if (res && res.ok) {
          ctx.stats.acks++;
          if (deliveryState.cursor === reported) deliveryState.lastAckAt = reported;
          log('moments-ack', { watermark: reported, pruned: Number(res.pruned) || 0 });
        } else {
          log('moments-ack-degraded', { watermark: reported, error: (res && res.error) || 'ack-failed' });
        }
        return res;
      }, function (error) {
        log('moments-ack-degraded', { watermark: reported, error: String((error && error.message) || error) });
        return null;
      });
    }
    /* 回收造成的空档：`retainedFrom` 是日志里**仍然存在**的最小 revision。
       缺这个字段**不算**证据（与 truncated 同一条纪律）：老节点/坏信封一律拒收，
       否则"日志被回收过"与"日志里没有"在客户端是同一个形状。 */
    function retentionGap(state, res) {
      if (res.retainedFrom === undefined) return { undeclared: true };
      var retainedFrom = res.retainedFrom === null ? null : Number(res.retainedFrom);
      if (retainedFrom !== null && !isFinite(retainedFrom)) return { undeclared: true };
      var revision = Number(res.revision);
      if (retainedFrom === null) {
        /* 日志是空的。若权威已经有过我们没确认的写入，那一段就是被回收掉的。 */
        return revision > state.cursor ? { from: retainedFrom, cursor: state.cursor, revision: revision } : null;
      }
      return (state.cursor + 1 < retainedFrom) ? { from: retainedFrom, cursor: state.cursor, revision: revision } : null;
    }

    /* 镜像的事故（原子替换失败 → IndexedDB 事务已回滚，旧镜像完整）。
       如实上报并留下原因；**绝不**在失败路径上置 hydrated / 推进版本。 */
    function noteMirrorFailure(error, event) {
      ctx.stats.failures++;
      ctx.degradedReason = 'mirror-write-failed';
      ctx.lastError = String((error && error.message) || error || 'mirror-write-failed');
      log(event, { error: ctx.lastError });
      return {
        ok: false, error: 'mirror-write-failed', outcome: 'mirror-write-failed',
        authority: 'home-node', detail: ctx.lastError
      };
    }

    function probe() {
      if (!remoteEnabled()) {
        ctx.remoteOnline = false;
        ctx.degradedReason = fileOrigin ? 'file-origin-cannot-reach-home-node'
          : (mode === 'off' ? 'mode-off' : 'mode-mirror');
        return Promise.resolve({ online: false, reason: ctx.degradedReason });
      }
      return remote.health().then(function (health) {
        ctx.remoteOnline = !!(health && health.ok);
        ctx.degradedReason = ctx.remoteOnline ? (ctx.hydrated ? null : 'not-hydrated') : 'home-node-unhealthy';
        if (ctx.remoteOnline) ctx.lastError = null;
        return { online: ctx.remoteOnline, reason: ctx.degradedReason };
      }, function (error) {
        noteRemoteFailure(error);
        return { online: false, reason: ctx.degradedReason };
      });
    }

    /* ── 同步：把 Home Node 的变更拉到镜像 ─────────────────────────────
       首次（未 hydrate）做有界播种，之后只应用 changesAfter(cursor) 增量。
       播种用 replaceAll：本地遗留的、权威已经不认的行必须消失 ——
       否则"镜像里还留着一条已经被删掉的动态"，而 UI 会把它渲染出来。

       P11-3G：增量这一段的所有权（谁推进 cursor、失败怎么记）都在
       `applyChanges` 里；本函数只负责"拿到一页 / 判定空档 / 串行化提交"。 */
    function sync(options) {
      options = options || {};
      if (!remoteEnabled()) return Promise.resolve({ ok: true, skipped: true, reason: ctx.degradedReason });
      if (!ctx.hydrated || options.full) return hydrate(options);
      return loadDelivery().then(function (state) {
        return remote.changes(state.cursor, { limit: options.limit }).then(function (res) {
          if (!res || res.ok !== true) return Promise.resolve(noteSnapshotFailure(changesVerdict(res)));
          /* 增量信封同样必须先验证再应用：一份 `ok:true` 但没有 upserts/deletes
             的回应如果被"当作没有变更"并推进游标，那些变更就**永久**不会再来 ——
             与"空快照清空镜像"是同一类错误的另一面。 */
          var invalid = validateChanges(res);
          if (invalid) return Promise.resolve(noteSnapshotFailure(invalid));
          var gap = retentionGap(state, res);
          if (gap) {
            /* 未确认的那一段已被回收 → 日志不再是可用的增量起点。
               恢复权威是**快照**（P11-3F 的 hydrate），不是"请求服务端别回收"：
               change_log 只是有界增量传输，它本来就不保证永久历史。 */
            ctx.deliveryGap = { at: clock(), retainedFrom: gap.from, cursor: gap.cursor, revision: gap.revision, undeclared: !!gap.undeclared };
            ctx.stats.failures++;
            log('moments-retention-gap', ctx.deliveryGap);
            if (gap.undeclared) {
              return noteSnapshotFailure({
                ok: false, error: 'invalid-response', outcome: 'invalid-response',
                detail: 'retained-from-missing', retryable: true
              });
            }
            return hydrate({ reason: 'retention-gap' });
          }
          return withMirrorLock(function () { return applyChanges(res, state); }).then(function (summary) {
            if (!summary || !summary.ok) return summary;
            /* ACK 与"终态后的快照恢复"都在**镜像锁之外**：前者是一次网络往返，
               后者自己会取锁（在锁内取锁会自锁）。顺序上二者都严格晚于
               状态落盘 —— ack 永远不早于 apply+outcome。 */
            return reportDelivery().then(function () {
              if (!summary.terminalRecorded) return summary;
              return recoverFromAuthority(summary);
            });
          });
        }, function (error) {
          noteRemoteFailure(error);
          return { ok: false, error: ctx.degradedReason, offline: true };
        });
      });
    }

    /* `changes` 的信封裁决。与 validateSnapshot 同一条纪律：字段必须存在且形状正确，
       否则**不动镜像、不动游标**，如实上报。 */
    function validateChanges(res) {
      if (!Array.isArray(res.upserts)) {
        return { ok: false, error: 'invalid-response', outcome: 'invalid-response', detail: 'upserts-missing', retryable: true };
      }
      if (!Array.isArray(res.deletes)) {
        return { ok: false, error: 'invalid-response', outcome: 'invalid-response', detail: 'deletes-missing', retryable: true };
      }
      if (typeof res.cursor !== 'number' || !isFinite(res.cursor)) {
        return { ok: false, error: 'invalid-response', outcome: 'invalid-response', detail: 'cursor-missing', retryable: true };
      }
      /* P11-3G：没有 `retainedFrom` 就不许应用这一页 —— 回收空档与"日志里没有"
         必须是两个形状（与 `truncated` 逐字同一条纪律）。 */
      if (res.retainedFrom === undefined) {
        return { ok: false, error: 'invalid-response', outcome: 'invalid-response', detail: 'retained-from-missing', retryable: true };
      }
      if (res.retainedFrom !== null && (typeof res.retainedFrom !== 'number' || !isFinite(res.retainedFrom))) {
        return { ok: false, error: 'invalid-response', outcome: 'invalid-response', detail: 'retained-from-invalid', retryable: true };
      }
      return null;
    }
    function changesVerdict(res) {
      var code = errorCodeOf(res);
      var terminal = isTerminalCode(code);
      return {
        ok: false, error: code, outcome: terminal ? 'terminal-failure' : 'unavailable',
        retryable: !terminal, status: (res && res.status) || null
      };
    }

    function hydrate(options) {
      options = options || {};
      var seedLimit = options.seedLimit || DEFAULT_SEED_LIMIT;
      /* 代次在这里领取：只有**最新**的一次 hydrate 有权提交镜像。
         旧的那次即使后到，也只会得到 superseded（不写、不改版本）。 */
      var gen = ++hydrateGen;
      return remote.list({ limit: seedLimit }).then(function (page) {
        var verdict = validateSnapshot(page);
        if (!verdict.ok) return noteSnapshotFailure(verdict);
        return withMirrorLock(function () {
          if (gen !== hydrateGen) {
            log('moments-hydrate-superseded', { reason: 'newer-hydration-started', snapshotRevision: verdict.revision });
            return { ok: false, error: 'superseded', outcome: 'superseded', reason: 'newer-hydration-started', authority: 'home-node' };
          }
          /* 镜像里已经有**更新**的权威状态（例如增量 changes 或一次写入先落了盘）
             → 这份旧快照无权把镜像拖回去。 */
          if (verdict.revision < ctx.mirrorRevision) {
            log('moments-hydrate-superseded', { reason: 'stale-snapshot', snapshotRevision: verdict.revision, mirrorRevision: ctx.mirrorRevision });
            return {
              ok: false, error: 'superseded', outcome: 'superseded', reason: 'stale-snapshot',
              snapshotRevision: verdict.revision, mirrorRevision: ctx.mirrorRevision, authority: 'home-node'
            };
          }
          return local.replaceAll(verdict.records).then(function () {
            /* 元数据在**落盘成功之后**才推进 —— 顺序反了就会留下
               "hydrated=true 但镜像还是旧的"这种假绿。 */
            ctx.cursor = verdict.revision;
            ctx.mirrorRevision = verdict.revision;
            ctx.hydrated = true;
            ctx.remoteOnline = true;
            ctx.degradedReason = null;
            ctx.lastError = null;
            ctx.lastSyncAt = clock();
            ctx.stats.hydrations++;
            log('moments-hydrate', { seeded: verdict.count, cursor: ctx.cursor, revision: verdict.revision });
            /* P11-3G：一次成功的快照把投递问题**整体回答**掉了 ——
               镜像现在与权威在这一版上逐条相等，因此 ≤ revision 的每个 event
               都不再"欠着"什么（pending 清空、终态结案），cursor 就是快照版本。
               这也是 retention 空档与毒事件的恢复路径：**归零重来，而不是补课**。
               状态写入排在镜像写入之后（同一个安全方向）。 */
            return settleDeliveryAfterHydrate(verdict.revision).then(function () {
              return reportDelivery();
            }).then(function () {
              return {
                ok: true, hydrated: true, outcome: 'authoritative-success',
                seeded: verdict.count, cursor: ctx.cursor, revision: verdict.revision
              };
            });
          }, function (error) {
            /* 原子替换失败 → 事务已回滚，旧镜像**完整保留**。 */
            return noteMirrorFailure(error, 'moments-hydrate-mirror-failed');
          });
        });
      }, function (error) {
        noteRemoteFailure(error);
        return { ok: false, error: ctx.degradedReason, offline: true };
      });
    }

    /* ── P11-3G · 投递的核心：一页 event 的逐个应用与结论 ──────────────────
       修复前的形状（真实复现，见报告）：`applyChanges` 把所有 upserts 串成
       一条 promise 链，**第一个失败就整页拒绝**，而 cursor 只在整页成功时
       前进。于是窗口第一条永久失败 → 每轮只尝试它一次 → cursor 永不前进 →
       服务端每轮发回同一个窗口 → 后面的事件**永久**不可达（hasMore=true）。

       现在的形状是"逐个事件 + 逐个结论"，而 cursor 只沿**持久结论的连续前缀**
       前进。三条性质一起构成"有界投递"：

         · 失败**只记在它自己的 revision 上**（attempts 持久化、有上界）；
         · 一页在第一个失败处**停下**（不逐个烧掉后面的事件：一次镜像级故障
           把整窗 event 全部烧成终态，是比队头阻塞更糟的失败）；
         · attempts 用尽 → 终态 → cursor **越过**它 → 本页继续；
           终态随后由快照（hydrate）补回内容，所以"终态"不等于"丢数据"。

       `state` 是**持久**投递状态。它的写序是"镜像先、状态后"：
       状态落后于镜像只意味着重启后重放一次（幂等），而反过来会产生
       "已经确认但从未应用"的窗口 —— 那是唯一真正会丢数据的顺序。 */
    function pageEvents(res) {
      var list = [];
      (res.upserts || []).forEach(function (row) {
        list.push({
          revision: Number(row && row.storeRevision), kind: 'upsert',
          recordId: String((row && row.id) || ''), row: row
        });
      });
      (res.deletes || []).forEach(function (d) {
        list.push({
          revision: Number(d && d.revision), kind: 'delete',
          recordId: String((d && d.id) || ''), row: d
        });
      });
      list.sort(function (a, b) { return a.revision - b.revision; });
      return list;
    }
    function terminalRecord(state, revision) {
      for (var i = 0; i < state.terminal.length; i++) {
        if (state.terminal[i].revision === revision) return state.terminal[i];
      }
      return null;
    }
    /* 单个 event 的应用。驱动**显式**解析成 `false` 表示"根本没有写"：
       生产驱动对缺 id 的行就是这么返回的（`if (!row || row.id == null)
       return Promise.resolve(false)`）。把它当成成功正是"静默丢失"的入口 ——
       cursor 会越过一条从未落盘的 event，而它再也不会被投递。 */
    function applyOne(event) {
      var work = event.kind === 'delete'
        ? local.remove(event.row && event.row.id)
        : local.put(event.row);
      return Promise.resolve().then(function () { return work; }).then(function (written) {
        if (written === false) return Promise.reject({ name: 'DataError', message: 'mirror did not write' });
        return true;
      });
    }
    function advanceWatermark(state, plan, revision) {
      if (revision > state.cursor) state.cursor = revision;
      plan.watermark = state.cursor;
    }
    function recordTerminal(state, plan, event, failure, attempts, now) {
      delete state.attempts[String(event.revision)];
      state.terminal.unshift({
        revision: event.revision, kind: event.kind, recordId: event.recordId,
        attempts: attempts, error: failure.error, category: failure.category,
        detail: failure.detail || '', at: now
      });
      if (state.terminal.length > DELIVERY_TERMINAL_KEEP) state.terminal.length = DELIVERY_TERMINAL_KEEP;
      /* 终态 = "镜像少了这一条"。恢复**不是**再去重试它，而是用快照把镜像
         整体带回权威的样子（P11-3F 的 hydrate，一字不改）。 */
      state.recovery = { needed: true, reason: 'terminal-outcome', at: now };
      plan.recorded.push({
        revision: event.revision, recordId: event.recordId, kind: event.kind,
        attempts: attempts, error: failure.error, category: failure.category
      });
      plan.terminalRecorded++;
      ctx.stats.terminated++;
      /* 诊断里**只有**投递坐标与失败分类：不放正文、不放 payload、不放凭据。 */
      log('moments-event-terminal', {
        revision: event.revision, recordId: event.recordId, kind: event.kind,
        attempts: attempts, error: failure.error, category: failure.category, detail: failure.detail || null
      });
    }
    /* 记一次失败。返回**是否已经变成终态** —— 调用方据此决定"停下本页"还是
       "继续下一个 event"：可重试失败要停（否则一次镜像级故障会把整窗 event
       全部烧成终态），而终态是**结论**、cursor 已经越过它，没有理由停。 */
    function noteFailure(state, plan, event, error, now) {
      var failure = applyFailureOf(error);
      var prev = state.attempts[String(event.revision)];
      var attempts = normalizeAttempts((prev ? prev.attempts : 0) + 1);
      if (attempts >= DELIVERY_MAX_ATTEMPTS) {
        recordTerminal(state, plan, event, failure, attempts, now);
        advanceWatermark(state, plan, event.revision);
        return true;
      }
      state.attempts[String(event.revision)] = {
        revision: event.revision, kind: event.kind, recordId: event.recordId,
        attempts: attempts, error: failure.error, category: failure.category, lastAt: now
      };
      plan.retried++;
      plan.blocked = {
        revision: event.revision, recordId: event.recordId, error: failure.error,
        category: failure.category, attempts: attempts, maxAttempts: DELIVERY_MAX_ATTEMPTS,
        dueInMs: backoffFor(attempts)
      };
      ctx.stats.retried++;
      log('moments-event-retryable', {
        revision: event.revision, recordId: event.recordId, attempts: attempts,
        max: DELIVERY_MAX_ATTEMPTS, error: failure.error, category: failure.category
      });
      return false;
    }
    function runPage(list, index, state, plan, now) {
      if (index >= list.length) return Promise.resolve();
      var event = list[index];
      /* 已经被持久结论覆盖（applied 前缀或终态）→ 跳过执行，但允许它继续
         充当"连续前缀"的一部分（终态是结论，不是待办）。 */
      if (event.revision <= state.cursor) { plan.skipped++; return runPage(list, index + 1, state, plan, now); }
      if (terminalRecord(state, event.revision)) {
        plan.skipped++;
        advanceWatermark(state, plan, event.revision);
        return runPage(list, index + 1, state, plan, now);
      }
      var reason = inapplicableReason(event);
      if (reason) {
        recordTerminal(state, plan, event, { error: 'event-inapplicable', category: 'event-local', detail: reason }, 1, now);
        advanceWatermark(state, plan, event.revision);
        return runPage(list, index + 1, state, plan, now);
      }
      var pending = state.attempts[String(event.revision)];
      if (pending && (now - pending.lastAt) < backoffFor(pending.attempts)) {
        /* 退避中的 event 不能被绕过：绕过它会让 cursor 越过一个还没有结论的
           event，那正是"未应用却已确认"的窗口。 */
        plan.retried++;
        plan.blocked = {
          revision: event.revision, recordId: event.recordId, error: pending.error,
          category: pending.category, attempts: pending.attempts, maxAttempts: DELIVERY_MAX_ATTEMPTS,
          dueInMs: backoffFor(pending.attempts) - (now - pending.lastAt)
        };
        return Promise.resolve();
      }
      return applyOne(event).then(function () {
        delete state.attempts[String(event.revision)];
        plan.applied++;
        advanceWatermark(state, plan, event.revision);
        /* mirrorRevision 只在内容**真的落盘**之后前进（终态不推进它：
           终态意味着镜像少了一条，声称那一版就是假绿）。 */
        if (event.revision > ctx.mirrorRevision) ctx.mirrorRevision = event.revision;
        return runPage(list, index + 1, state, plan, now);
      }, function (error) {
        var becameTerminal = noteFailure(state, plan, event, error, now);
        /* 可重试失败 → 停下本页（把"一次镜像级故障烧掉整窗 event"这条路堵死）。
           终态 → cursor 已经越过它，本页**继续**：这正是队头收口的那一步。 */
        if (!becameTerminal) return Promise.resolve();
        return runPage(list, index + 1, state, plan, now);
      });
    }
    function applyChanges(res, state) {
      if (!state) return loadDelivery().then(function (loaded) { return applyChanges(res, loaded); });
      var list = pageEvents(res);
      for (var i = 0; i < list.length; i++) {
        /* revision 是投递坐标。缺坐标不是"某一个 event 的问题"，而是这一页
           无法被按序应用与推进 —— 整页拒收，不动镜像也不动 cursor。 */
        if (!(list[i].revision > 0) || !isFinite(list[i].revision)) {
          return Promise.resolve(noteSnapshotFailure({
            ok: false, error: 'invalid-response', outcome: 'invalid-response',
            detail: 'event-revision-missing', retryable: true
          }));
        }
      }
      var plan = { applied: 0, retried: 0, terminalRecorded: 0, skipped: 0, blocked: null, recorded: [], watermark: state.cursor };
      return runPage(list, 0, state, plan, clock()).then(function () {
        ctx.cursor = state.cursor;
        ctx.remoteOnline = true;
        ctx.degradedReason = null;
        ctx.lastError = null;
        ctx.lastSyncAt = clock();
        ctx.stats.syncs++;
        ctx.stats.delivered += plan.applied;
        log('moments-sync', {
          cursor: state.cursor, applied: plan.applied, retried: plan.retried,
          terminated: plan.terminalRecorded, skipped: plan.skipped, hasMore: !!res.hasMore
        });
        var summary = {
          ok: true, cursor: state.cursor, upserts: (res.upserts || []).length,
          deletes: (res.deletes || []).length, hasMore: !!res.hasMore,
          applied: plan.applied, retried: plan.retried, terminated: plan.terminalRecorded,
          skipped: plan.skipped, blocked: plan.blocked || null,
          terminal: plan.recorded, terminalRecorded: plan.terminalRecorded,
          retainedFrom: res.retainedFrom === undefined ? null : res.retainedFrom
        };
        /* 状态落盘必须在报告 ACK **之前** —— 否则一次崩溃会留下
           "服务端以为我确认到了 W、而我其实没有"的窗口。 */
        return saveDelivery().then(function () { return summary; });
      });
    }

    /* 快照成功之后结算投递状态。刻意把 cursor **设成**快照版本（而不是取 max）：
       镜像现在与快照逐条相等，任何比它更大的旧水位都不再描述这个镜像，
       而服务端的水位是单调的（回落只会让回收更保守）。 */
    function settleDeliveryAfterHydrate(revision) {
      return loadDelivery().then(function (state) {
        state.cursor = revision;
        /* pending（retryable）在快照覆盖到它之后**不再是待办**：镜像现在与权威
           在这一版上逐条相等，那一条已经由权威的内容回答了。 */
        Object.keys(state.attempts).forEach(function (key) {
          if (Number(key) <= revision) delete state.attempts[key];
        });
        /* 终态**保留**（有界环）：它是一次真实失败的历史，也是本阶段要求保留的
           可观测面。它只是被标记为"已由快照结案" —— 删掉它就等于让"哪个 event
           曾经永久失败过"这件事变得不可见。 */
        state.terminal = state.terminal.map(function (rec) {
          if (!(rec.revision <= revision) || rec.resolvedBy) return rec;
          return Object.assign({}, rec, { resolvedBy: 'snapshot', resolvedAt: clock() });
        });
        state.recovery = null;
        ctx.cursor = state.cursor;
        return saveDelivery();
      });
    }
    /* 终态之后的恢复：请求一份**新的权威快照**重建镜像。
       这是"终态不等于丢数据"的全部依据 —— 它复用 P11-3F 的 hydrate，
       没有修改那条契约（完整性判据、代次、水位一字不动）。 */
    function recoverFromAuthority(summary) {
      return hydrate({ reason: 'terminal-outcome' }).then(function (res) {
        ctx.stats.recovered++;
        summary.recovered = res && res.ok ? 'authoritative-snapshot' : null;
        summary.recovery = res && res.ok
          ? { outcome: res.outcome, revision: res.revision, cursor: ctx.cursor }
          : { outcome: (res && res.outcome) || 'failed', error: (res && res.error) || null };
        return summary;
      }, function (error) {
        summary.recovered = null;
        summary.recovery = { outcome: 'failed', error: String((error && error.message) || error) };
        return summary;
      });
    }

    /* 读之前先补齐镜像。失败**不抛**：读路径要能降级（离线时读本地镜像），
       但把 degradedReason 留下，不把"读不到权威"伪装成"权威说没有"。 */
    function ensureReady() {
      if (!remoteEnabled()) return Promise.resolve({ ok: true, skipped: true, reason: ctx.degradedReason });
      if (readyPromise) return readyPromise;
      readyPromise = sync({}).then(function (res) {
        if (!res || !res.ok) readyPromise = null;   /* 失败允许下次重试 */
        return res;
      }, function (error) {
        readyPromise = null;
        noteRemoteFailure(error);
        return { ok: false, error: ctx.degradedReason, offline: true };
      });
      return readyPromise;
    }
    function resetReady() { readyPromise = null; }

    function readSource() { return authorityEffective() ? 'home-node' : 'indexeddb'; }

    /* ── 读：返回镜像行，并标注权威来源 ───────────────────────────────
       decorateRead 刻意**只加标注、不改行**：镜像行的形状必须与迁移前逐字相同，
       否则 moments.js 里每一处 `m.visibility` / `m.roleId` 的读法都要跟着改。 */
    function decorateRead(result) {
      ctx.stats.reads++;
      if (authorityEffective()) ctx.stats.readsRemote++;
      return {
        ok: true, authority: readSource(), authorityEffective: authorityEffective(),
        degraded: isDegraded(),
        degradedReason: ctx.degradedReason,
        value: result
      };
    }

    function get(id) {
      return ensureReady().then(function () { return local.get(id); }).then(decorateRead);
    }
    function getAll() {
      return ensureReady().then(function () { return local.getAll(); }).then(decorateRead);
    }
    function getByOwner(roleId) {
      return ensureReady().then(function () { return local.getByOwner(roleId); }).then(decorateRead);
    }

    /* ── 写：Node 优先 ─────────────────────────────────────────────────
       `expectedRev` 语义：
         · 新建            → 不传（服务端按"不存在则创建"处理）
         · 编辑/删除       → 传当前 rev；过期 → conflict，**不清本地**
       返回形状与 memory-authority 对齐（{ok, outcome, revision, ...}），
       唯一的例外是 conflict 会把服务端的 expectedRev/actualRev 带回给调用方，
       因为"我拿的是哪一版"是调用方唯一能修的东西。 */
    function put(record, options) {
      options = options || {};
      if (!remoteEnabled()) {
        /* 非 canonical 承载（mirror / off / file://）：本地写是**合法回滚路径**，
           行为与迁移之前逐字相同。status() 会如实标注权威不是 Home Node。 */
        ctx.stats.writes++;
        return local.put(record).then(function () {
          return { ok: true, outcome: 'local', authority: 'indexeddb', authorityEffective: false };
        });
      }
      return remote.put(record, {
        requestId: options.requestId,
        expectedRev: options.expectedRev
      }).then(function (res) {
        if (!res || !res.ok) {
          if (isTransportFailure(res)) { noteRemoteFailure(res); return fail(ctx.degradedReason, { offline: true }); }
          if (String(res.error || '') === 'CONFLICT' || res.error === 'revision-conflict') {
            ctx.stats.conflicts++;
            /* 冲突**不**写镜像：镜像必须保持权威的样子。把冲突的候选写进镜像，
               就是让镜像与权威不一致 —— 而这正是本阶段要消灭的形状。 */
            return {
              ok: false, error: 'revision-conflict', outcome: 'conflict', authority: 'home-node',
              expectedRev: res.expectedRev == null ? null : Number(res.expectedRev),
              actualRev: res.actualRev == null ? null : Number(res.actualRev)
            };
          }
          return fail(res.error || 'home-node-rejected', { rejected: true, detail: res });
        }
        ctx.stats.writes++;
        ctx.stats.writesRemote++;
        if (res.outcome === 'replayed') ctx.stats.replays++;
        /* 成功之后才更新镜像，且**用服务端回传的权威行**（不是本地候选）——
           否则并发情境下镜像会与权威漂移。
           走同一条镜像锁：一次写入与一次 hydrate 提交不允许交错。
           版本水位一并推进 —— 否则"先写一行、再提交一份更旧的快照"会让这行回退。 */
        var wroteRev = Number(res.revision);
        /* The remote row's payload rev can lag the separately indexed CAS rev:
           the store owns record_rev and returns it as res.rev. Stamp both revision
           coordinates into the mirror so the next like/comment/reply/delete uses
           the current expectedRev instead of conflict-looping on a stale row. */
        var authoritative = Object.assign({}, res.moment || record || {});
        if (res.rev != null && isFinite(Number(res.rev))) authoritative.rev = Number(res.rev);
        if (isFinite(wroteRev) && wroteRev > 0) authoritative.storeRevision = wroteRev;
        return withMirrorLock(function () {
          return local.put(authoritative).then(function () {
            if (isFinite(wroteRev) && wroteRev > ctx.mirrorRevision) ctx.mirrorRevision = wroteRev;
            return {
              ok: true, outcome: res.outcome || 'updated', authority: 'home-node',
              id: res.id || (record && record.id) || null, rev: res.rev == null ? null : Number(res.rev),
              revision: res.revision, moment: authoritative
            };
          }, function (error) {
            return noteMirrorFailure(error, 'moments-put-mirror-failed');
          });
        });
      }, function (error) {
        noteRemoteFailure(error);
        return fail(ctx.degradedReason, { offline: true });
      });
    }

    function remove(id, options) {
      options = options || {};
      if (!remoteEnabled()) {
        return local.remove(id).then(function () {
          return { ok: true, outcome: 'local', deleted: true, authority: 'indexeddb', authorityEffective: false };
        });
      }
      return remote.remove(id, { requestId: options.requestId, expectedRev: options.expectedRev }).then(function (res) {
        if (!res || !res.ok) {
          if (isTransportFailure(res)) { noteRemoteFailure(res); return fail(ctx.degradedReason, { offline: true }); }
          if (String(res.error || '') === 'CONFLICT') {
            ctx.stats.conflicts++;
            return { ok: false, error: 'revision-conflict', outcome: 'conflict', authority: 'home-node', id: id };
          }
          return fail(res.error || 'home-node-rejected', { rejected: true });
        }
        /* 服务端已软删除（墓碑 + change_log）→ 镜像侧同步移除。
           镜像保留墓碑没有意义：读路径本来就不该看到已删除的行。
           同一条镜像锁 + 同一个版本水位（理由与 put 逐条相同）。 */
        var removedRev = Number(res.revision);
        return withMirrorLock(function () {
          return local.remove(id).then(function () {
            if (isFinite(removedRev) && removedRev > ctx.mirrorRevision) ctx.mirrorRevision = removedRev;
            return { ok: true, outcome: res.outcome || 'deleted', deleted: true, authority: 'home-node', id: id, revision: res.revision };
          }, function (error) {
            return noteMirrorFailure(error, 'moments-remove-mirror-failed');
          });
        });
      }, function (error) {
        noteRemoteFailure(error);
        return fail(ctx.degradedReason, { offline: true });
      });
    }

    /* ── 迁移：浏览器遗留行 → canonical（幂等、非破坏、可续跑）─────────
       关键性质（§9）：
         · 不覆盖已存在的 canonical 行（服务端 writeMigrated 保证）；
         · **不删除**本地行 —— 浏览器副本就是回滚影子；
         · 缺失档位原样留空（服务端迁移模式不套用"未标注=公开"的写入默认），
           因此旧行在搬家途中不会从"仅作者可见"变成公开；
         · 不可归属（既无作者又无档位）的行**拒收并如实报告**，不落孤儿行。
       绝不自动执行：什么时候搬家是用户/运维的决定。 */
    function migrate(options) {
      options = options || {};
      if (!remoteEnabled()) return Promise.resolve({ ok: false, error: 'authority-disabled', reason: ctx.degradedReason });
      var source = String(options.source || 'browser-indexeddb:moments');
      var batchSize = Math.max(1, Math.min(500, Number(options.batchSize) || DEFAULT_MIGRATE_BATCH));
      var rows = null;
      return local.getAll().then(function (all) {
        rows = Array.isArray(all) ? all : [];
        var report = {
          ok: true, source: source, total: rows.length, created: 0, skipped: 0, replayed: 0,
          rejected: [], batches: 0, revision: null, authority: 'home-node'
        };
        if (!rows.length) {
          report.completed = true;
          return local.markMigrated(source, report).then(function () { return report; });
        }
        var batches = [];
        for (var i = 0; i < rows.length; i += batchSize) batches.push(rows.slice(i, i + batchSize));
        var chain = Promise.resolve();
        batches.forEach(function (batch, index) {
          chain = chain.then(function () {
            return remote.migrateBatch(batch, { prefix: source }).then(function (res) {
              report.batches++;
              if (!res || !res.ok) {
                report.ok = false;
                report.error = (res && res.error) || 'migrate-batch-failed';
                return;
              }
              report.created += Number(res.created) || 0;
              report.skipped += Number(res.skipped) || 0;
              report.revision = res.revision == null ? report.revision : res.revision;
              (res.rejected || []).forEach(function (r) { report.rejected.push(r); });
              log('moments-migrate-batch', { batch: index + 1, of: batches.length, created: res.created, skipped: res.skipped, invalid: res.invalid });
            }, function (error) {
              noteRemoteFailure(error);
              report.ok = false;
              report.error = ctx.degradedReason;
            });
          });
        });
        return chain.then(function () {
          report.migrateRejected = report.rejected.length;
          report.completed = report.ok === true;
          ctx.stats.migrated += report.created;
          ctx.stats.migrateSkipped += report.skipped;
          ctx.stats.migrateRejected += report.rejected.length;
          /* 水位如实记录：即使有 rejected 也记（否则每次重跑都会重来一遍）。 */
          return local.markMigrated(source, {
            version: 1, records: report.total, created: report.created,
            skipped: report.skipped, rejectedCount: report.rejected.length, completedAt: clock()
          }).then(function () { return report; });
        });
      }, function (error) {
        return { ok: false, error: 'local-read-failed', detail: String((error && error.message) || error) };
      });
    }

    /* 用 Home Node 完整重建镜像。显式调用，绝不自动执行。 */
    function rebuild(options) {
      options = options || {};
      if (!remoteEnabled()) return Promise.resolve({ ok: false, error: 'authority-disabled' });
      return hydrate(Object.assign({}, options, { seedLimit: options.seedLimit || DEFAULT_SEED_LIMIT }));
    }

    function status() {
      var state = deliveryState || freshDelivery();
      var attempts = Object.keys(state.attempts).map(function (key) { return state.attempts[key]; });
      var pendingCount = attempts.length;
      return {
        store: 'moments',
        mode: mode,
        authority: authorityEffective() ? 'home-node' : 'indexeddb',
        authorityEffective: authorityEffective(),
        remoteOnline: ctx.remoteOnline,
        hydrated: ctx.hydrated,
        cursor: ctx.cursor,
        mirrorRevision: ctx.mirrorRevision,
        degraded: isDegraded(),
        degradedReason: ctx.degradedReason,
        lastSyncAt: ctx.lastSyncAt,
        lastError: ctx.lastError,
        /* ── P11-3G · 投递状态（每个 event 的四种状态都可观测）────────────
           applied 不在这里逐条列出：镜像行本身是证据，而 cursor 已经表达了
           "连续前缀上全部已应用"。这里列出的是**还没有结论**和**已有终态结论**
           的那两类，以及 retry/ACK 的记账。 */
        delivery: {
          consumer: DELIVERY_CONSUMER,
          durable: ctx.deliveryDurable === true,
          ackWatermark: state.cursor,
          lastAckAt: state.lastAckAt,
          pending: pendingCount,
          pendingRevisions: attempts.map(function (rec) {
            return {
              revision: rec.revision, kind: rec.kind, recordId: rec.recordId,
              attempts: rec.attempts, maxAttempts: DELIVERY_MAX_ATTEMPTS,
              error: rec.error, category: rec.category, detail: rec.detail || null,
              lastAt: rec.lastAt, state: 'retryable-failure'
            };
          }),
          terminal: state.terminal.map(function (rec) {
            return {
              revision: rec.revision, kind: rec.kind, recordId: rec.recordId,
              attempts: rec.attempts, error: rec.error, category: rec.category,
              detail: rec.detail || null,
              at: rec.at, state: 'terminal-failure',
              resolvedBy: rec.resolvedBy || null, resolvedAt: rec.resolvedAt || null
            };
          }),
          terminalUnresolved: state.terminal.filter(function (rec) { return !rec.resolvedBy; }).length,
          recovery: state.recovery ? { needed: true, reason: state.recovery.reason, at: state.recovery.at } : null,
          gap: ctx.deliveryGap,
          policy: {
            maxAttempts: DELIVERY_MAX_ATTEMPTS, hardMaxAttempts: DELIVERY_HARD_MAX_ATTEMPTS,
            baseBackoffMs: DELIVERY_BASE_BACKOFF_MS, maxBackoffMs: DELIVERY_MAX_BACKOFF_MS,
            terminalKeep: DELIVERY_TERMINAL_KEEP
          }
        },
        stats: Object.assign({}, ctx.stats)
      };
    }

    return {
      MODES: MODES,
      probe: probe,
      sync: sync,
      hydrate: hydrate,
      ensureReady: ensureReady,
      resetReady: resetReady,
      put: put,
      remove: remove,
      get: get,
      getAll: getAll,
      getByOwner: getByOwner,
      migrate: migrate,
      rebuild: rebuild,
      status: status,
      authorityEffective: authorityEffective,
      remoteEnabled: remoteEnabled,
      applyChanges: applyChanges,
      remote: remote,
      local: local,
      /* 供测试与运维显式驱动投递状态（不进入任何生产读路径）。 */
      delivery: {
        load: function () { return loadDelivery().then(function (s) { return JSON.parse(JSON.stringify(s)); }); },
        save: saveDelivery,
        report: reportDelivery,
        policy: {
          DELIVERY_CONSUMER: DELIVERY_CONSUMER, DELIVERY_MAX_ATTEMPTS: DELIVERY_MAX_ATTEMPTS,
          DELIVERY_HARD_MAX_ATTEMPTS: DELIVERY_HARD_MAX_ATTEMPTS,
          DELIVERY_BASE_BACKOFF_MS: DELIVERY_BASE_BACKOFF_MS,
          DELIVERY_MAX_BACKOFF_MS: DELIVERY_MAX_BACKOFF_MS,
          DELIVERY_TERMINAL_KEEP: DELIVERY_TERMINAL_KEEP
        },
        backoffFor: backoffFor,
        applyFailureOf: applyFailureOf,
        inapplicableReason: inapplicableReason
      }
    };
  }

  return { createMomentsAuthority: createMomentsAuthority, MODES: MODES };
});
