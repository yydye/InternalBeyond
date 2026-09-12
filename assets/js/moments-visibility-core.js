/* ====================================================================
   IB Moments Visibility Core — runtime-neutral moment 可见性语义（UMD dual-load）
   --------------------------------------------------------------------
   - Browser: <script src="assets/js/moments-visibility-core.js"> → window.IBMomentsVisibilityCore
              （必须在 moments.js / social-network.js 之前加载）
   - Node   : require('../assets/js/moments-visibility-core.js')
   - 规则：零 window / 零 DOM / 零 IndexedDB / 零 localStorage / 零副作用 / 纯函数。

   为什么存在（M1-C.2n P0 审计结论）：
   moment 的可见性此前以**十一处**互不相同的谓词散落在 moments.js / social-network.js /
   active-diary.js 里，彼此在 private / user / 缺失 visibility 三处给出不同答案，
   而且其中一处（回复页签）完全不施加谓词。最严重的一处不是"两条规则不一致"，
   而是"只要有一处忘了写，它就绕过其余所有处" —— 受限动态的评论正文与全文
   会经该路径到达用户界面。本模块把该语义收敛为**唯一实现**，供：

     ① 直接读取（Feed / 角色主页 / 讨论串 / 详情）
     ② 上下文注入（聊天注入、发圈 prompt、Middle Brain）
     ③ 派生消费者的**前置**过滤（consolidation / companion snapshot）
     ④ 子制品（评论 / 点赞）的可见性继承（最严）
     ⑤ 写入侧的档位归一（非法值不得兜底成公开）

   本模块只编码**冻结后的** IB 语义（见 M1-C.2n-MOMENTS-AUTHORITY-PLAN.md §2），
   不新增档位、不发明通用 ACL 框架、不处理 repost 继承。

   ── 唯一谓语（冻结契约 §2.1）──────────────────────────────────────────
     canSee(moment, principal):
       1. principal 不存在 / 为空                       → false
       2. moment 不是对象 / 无 id                       → false
       3. principal 是 moment 的作者                    → true
       4. principal 是用户且 moment 作者是用户          → true
       5. visibility 归一化：
            'invalid'（缺失 / 未知 / 非字符串）          → false
            'private'                                    → false（仅作者，见 3/4）
            'all'                                        → true
            'user'                                       → principal 是用户
            'roles'                                      → principal 是角色且 ∈ visibleRoleIds

   ── 为什么"作者恒可读"是**修复**而不是新增语义 ─────────────────────────
   moments.js 原有注释明确写"作者角色永远可读自己的动态（含 private）"，
   但实现只在 all/roles 命中时返回 true，于是 visibility==='user'（模型按提示词
   最可能为"私人情绪"选择的档位）恰恰是作者读不到自己的那一档。
   而发圈 prompt 会把"我最近发过的朋友圈"喂给作者自己 —— 若作者读不到 user 档，
   她会看不到自己刚说过的话，去重也随之失效。三处独立证据（注释意图、既有测试
   privateInOwn===true、发圈 prompt 自带 own moments）一致指向"作者恒可读"。
   ==================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); }
  else { root.IBMomentsVisibilityCore = factory(); }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var VISIBILITIES = ['all', 'user', 'roles', 'private'];

  function str(v) { return v == null ? '' : String(v); }

  /* ── 1. 档位归一：读侧与写侧**必须分开** ─────────────────────────────
     这是本核心最容易写错的一处，也是 M1-C.2n 审计最关键的区分：

       · 读侧（readVisibility，fail closed）：
           缺失（undefined / null / ''）→ 'invalid' → 不可见（作者除外）
           未知 / 非字符串              → 'invalid'
         理由：旧数据、被截断的镜像行、别处写入的脏行都可能没有 visibility。
         如果读侧把"没有"当成"公开"，那么任何一次字段丢失都会静默变成公开，
         而 §2.2 要求的恰恰相反 —— 缺失 ACL 的默认必须是"只有作者能看"。

       · 写侧（writeVisibility，产品默认）：
           缺失 → 'all'（不标注即公开，与既有产品行为一致）
           合法 → 原样
           非法但存在 → 'invalid'（**不得**兜底成 all）
         理由："模型没给档位"是一个产品默认值决策；"模型给了一个拼错的档位"
         不是缺省，而是非法输入 —— 把它当缺省处理就是从"合法缺省"到
         "静默放行非法输入"的一步之差。

     `invalid` 在读侧永不可见（作者除外），因此"模型拼错档位"的结果是**收窄**，
     而不是像原来的 `||'all'` 那样放宽成公开。 */
  var INVALID = 'invalid';

  function readVisibility(raw) {
    if (raw == null || raw === '') return INVALID;
    if (typeof raw !== 'string') return INVALID;
    return VISIBILITIES.indexOf(raw) >= 0 ? raw : INVALID;
  }

  function writeVisibility(raw) {
    if (raw == null || raw === '') return 'all';
    if (typeof raw !== 'string') return INVALID;
    return VISIBILITIES.indexOf(raw) >= 0 ? raw : INVALID;
  }

  /* 兼容别名：既有调用点（测试/探测）用 normalizeVisibility 表示**读侧**语义。 */
  function normalizeVisibility(raw) { return readVisibility(raw); }

  /* 归一化档位是否可读（不含作者规则）。导出供测试与诊断逐项断言。 */
  function visibilityAllows(visibility, principal) {
    var v = readVisibility(visibility);
    if (v === 'all') return true;
    if (v === 'user') return !!(principal && principal.kind === 'user');
    if (v === 'roles') {
      if (!principal || principal.kind !== 'role') return false;
      var id = str(principal.id);
      if (!id) return false;
      var list = principal.visibleRoleIds;
      return Array.isArray(list) && list.map(str).indexOf(id) >= 0;
    }
    /* 'private' 与 'invalid' 都只有作者规则能救（见 isMomentVisibleTo 第 3 步）。 */
    return false;
  }

  /* ── 2. 作者身份 ────────────────────────────────────────────────────
     旧记录无 authorType → 按 role 解释，roleId 即 authorId（与 moments.js 既有语义一致）。
     返回 {kind:'user'|'role'|'', id}；kind 为空表示无法判定作者（fail closed）。 */
  function authorOf(moment) {
    if (!moment || typeof moment !== 'object') return { kind: '', id: '' };
    if (moment.authorType === 'user') return { kind: 'user', id: str(moment.authorId || moment.roleId) };
    var roleId = str(moment.roleId || moment.authorId);
    if (!roleId) return { kind: '', id: '' };
    return { kind: 'role', id: roleId };
  }

  function principalOf(p) {
    if (!p || typeof p !== 'object') return { kind: '', id: '' };
    var kind = (p.kind === 'user' || p.kind === 'role') ? p.kind : '';
    return { kind: kind, id: kind ? str(p.id) : '' };
  }

  function isAuthor(moment, principal) {
    var a = authorOf(moment), p = principalOf(principal);
    /* 用户作者：authorId 就是该用户。ID 为空（旧数据可能没有）→ 不能证明 → false。 */
    if (a.kind !== p.kind) return false;
    if (!a.id || !p.id) return false;
    return a.id === p.id;
  }

  /* ── 3. 唯一谓语 ────────────────────────────────────────────────────
     调用方必须**先**用它过滤，**再**做 sort / slice / top-k / page / budget。
     它也必须覆盖"按 id 直读"的路径（详情、讨论串）—— 那条路径最容易漏。

     注意本谓语的两条**基础拒绝**（先于一切档位判断）：
       · principal 不可判定（缺 kind/id）→ false
       · id 不可判定（缺 id）→ false
     它们不是"档位判定"，而是"这次提问是否成立"。因此调用方在问
     **与暴露无关**的政策问题时（例如"这条动态能不能被 AI 点赞"）
     不应依赖本谓语传达那个政策 —— 那种问题有自己的主体与理由。
     早期版本让"无 id"这一条把 like 资格一起挡掉，结果是
     "fixture 没写 id"被静默解释成"不可见"，一个缺失字段伪装成了一条安全策略。 */
  function isMomentVisibleTo(moment, principal) {
    if (!moment || typeof moment !== 'object' || moment.id == null || str(moment.id) === '') return false;
    var p = principalOf(principal);
    if (!p.kind || !p.id) return false;
    /* 3/4：作者恒可读自己的动态（含 private / user / invalid）。 */
    if (isAuthor(moment, p)) return true;
    if (p.kind === 'user' && moment.authorType === 'user') return true;/* 用户恒可读自己发的 */
    /* 5：其余按档位。roles 需要把 principal 的可见名单带上。 */
    if (readVisibility(moment.visibility) === 'roles') {
      return visibilityAllows('roles', {
        kind: p.kind, id: p.id,
        visibleRoleIds: Array.isArray(moment.visibleRoleIds) ? moment.visibleRoleIds : []
      });
    }
    return visibilityAllows(moment.visibility, p);
  }

  /* ── 4. 列表过滤（**排序之前**的唯一入口）──────────────────────────
     非数组输入 → []（fail closed：读不到候选集时不能"当作全可见"）。 */
  function filterVisibleMoments(moments, principal) {
    if (!Array.isArray(moments)) return [];
    var out = [];
    for (var i = 0; i < moments.length; i++) {
      if (isMomentVisibleTo(moments[i], principal)) out.push(moments[i]);
    }
    return out;
  }

  /* ── 5. 子制品可见性：不得比来源更宽 ──────────────────────────────
     评论 / 点赞内嵌在 moment 行内、没有独立 ACL，其可见性**就是**该 moment 的可见性，
     因此调用方读 comments 时必须先过第 3 节谓语。本函数用于"从若干来源派生一件事物"
     的场景（最严胜出）：

       · 空来源集                                  → 'private'（无法证明公开）
       · 任一 private / invalid                    → 'private'
       · 全部 all                                  → 'all'
       · 其余（含 user / roles 混合）              → 'roles'（visibleRoleIds 取交集）
     'roles' 作为"收窄容器"：交集为空时只剩作者可见，与 private 的实际效果一致，
     但保住了"这是被指定名单"的语义，便于审计。 */
  function deriveChildVisibility(sources) {
    var rows = Array.isArray(sources) ? sources : [];
    if (!rows.length) return { visibility: 'private', visibleRoleIds: [] };
    var vs = [], roleSets = [], allAll = true;
    for (var i = 0; i < rows.length; i++) {
      var v = readVisibility(rows[i] && rows[i].visibility);
      vs.push(v);
      if (v === 'private' || v === 'invalid') return { visibility: 'private', visibleRoleIds: [] };
      if (v !== 'all') allAll = false;
      if (v === 'roles') roleSets.push((rows[i].visibleRoleIds || []).map(str));
    }
    if (allAll) return { visibility: 'all', visibleRoleIds: [] };
    if (!roleSets.length) return { visibility: 'roles', visibleRoleIds: [] };
    /* 只保留在**每一个** roles 来源里都出现的角色。 */
    var inter = roleSets[0].filter(function (x) {
      for (var j = 1; j < roleSets.length; j++) if (roleSets[j].indexOf(x) < 0) return false;
      return true;
    });
    return { visibility: 'roles', visibleRoleIds: inter };
  }

  /* ── 6. 诊断辅助（只读，不参与判定）──────────────────────────────
     供迁移报告与 parity probe 说明"这条为什么被拒"。绝不用于决策。 */
  function explain(moment, principal) {
    var p = principalOf(principal);
    var visible = isMomentVisibleTo(moment, p);
    var v = readVisibility(moment && moment.visibility);
    var reason = visible ? null
      : (!p.kind || !p.id ? 'no-principal'
        : (!moment || moment.id == null ? 'malformed-moment'
          : (isAuthor(moment, p) ? 'author-shortcut-failed'
            : (v === 'invalid' ? 'invalid-visibility'
              : (v === 'private' ? 'private'
                : (v === 'roles' ? 'not-in-visible-role-ids'
                  : (v === 'user' ? 'user-only' : 'not-permitted')))))));
    return { visible: visible, visibility: v, reason: reason };
  }

  /* 兼容层：把"因出站边界的严格性而被写下来的 {roleId: id} 形状"归一成
     {kind:'role', id}。仅当调用方**确实**在用旧形状时使用；新调用点直接用
     principalOf 的形状。 */
  function asPrincipal(p) {
    if (!p || typeof p !== 'object') return null;
    if (p.kind === 'user' || p.kind === 'role') return principalOf(p);
    if (Object.prototype.hasOwnProperty.call(p, 'roleId')) return principalOf({ kind: 'role', id: p.roleId });
    return principalOf(p);
  }

  /* ── 7. 聊天上下文的选择 + 渲染（两端**同一份**实现）───────────────
     M1-C.2m §10 要求比较"同一语义证据信封"，而不是"模型最后写出的文字"。
     如果两端各自拼"【朋友圈动态…】"这一段，同一份 canonical 状态会渲染出
     两段不同文本，Middle Brain 的 momentItems 计数与压缩结果也随之不同 ——
     于是"证据相同"根本无法被证明。因此选择与渲染在这里只有一份实现。

     两条**不同**的语义（答案确实不一样，刻意分开写）：
       ① 自己的动态：判"要不要让它进**她的聊天上下文**"，比"作者能否读到"
          更严 —— 私人日志是她愿意让我看见、却不愿意让它变成聊天素材的东西
          （tests/test_moments_phase3_smoke.js 的 privacy.ctxOwnExcludesPrivate
          锁定了这一点）。可读性用本核心判定，聊天可用性再叠一层"仅公开档"。
       ② 朋友的动态：同样只带**公开**档。这是既有产品语义（other_role_moments
          一直是 all-only），也避免"她随口引用别人只写给她的内容"。

     ★ 两处最终都是"只注入公开档"，但**理由是分开的**，所以分开写：
       · others 的理由是"那是别人的内容，另一主体的边界不能被我放宽"；
       · own 的理由是"这是我自己的内容，可读 ≠ 可当聊天素材"。
     把两条理由合成一句"反正都是 all"正是审计发现的那类退化：
     一旦有人为了某个需求放宽 own，他会顺手放宽 others（或反之），
     而没有人能说出被放宽的到底是哪条约束。

     传入的 characterNameOf 让"名字"由调用方决定（桌面用 apiConfigs，
     节点用 characters 表），但**行的选择与格式**由这里唯一决定。 */
  function selectContextMoments(moments, principal, options) {
    options = options || {};
    const p = asPrincipal(principal);
    if (!p) return { own: [], others: [] };
    const ownLimit = Math.max(0, Number(options.ownLimit == null ? 4 : options.ownLimit) || 0);
    const otherLimit = Math.max(0, Number(options.otherLimit == null ? 3 : options.otherLimit) || 0);
    const visible = filterVisibleMoments(moments, p);
    const byDesc = (a, b) => String(b && b.createdAt || '').localeCompare(String(a && a.createdAt || ''));
    const own = visible
      .filter(m => String(m && (m.roleId != null ? m.roleId : m.authorId) || '') === p.id)
      .filter(m => readVisibility(m && m.visibility) === 'all')
      .sort(byDesc)
      .slice(0, ownLimit);
    const others = (options.otherRolesVisible === false ? [] : visible)
      .filter(m => String(m && (m.roleId != null ? m.roleId : '') || '') !== p.id)
      .filter(m => String(authorOf(m).id || '') !== p.id)
      .filter(m => readVisibility(m && m.visibility) === 'all')
      .sort(byDesc)
      .slice(0, otherLimit);
    return { own: own, others: others };
  }

  /* 时间标签与浏览器侧 getMomentsContext 逐字一致（今天/昨天/M月D日 + HH:MM）。 */
  function contextTimeLabel(iso, nowMs) {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    const now = new Date(nowMs == null ? Date.now() : nowMs);
    const pad = n => String(n).padStart(2, '0');
    const hhmm = pad(d.getHours()) + ':' + pad(d.getMinutes());
    if (d.toDateString() === now.toDateString()) return '今天 ' + hhmm;
    const yest = new Date(now); yest.setDate(now.getDate() - 1);
    if (d.toDateString() === yest.toDateString()) return '昨天 ' + hhmm;
    return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + hhmm;
  }

  /* 渲染：返回可直接注入的整段文本；空 → ''（调用方据此不注入空块）。 */
  function renderMomentsContext(input) {
    input = input || {};
    const picked = selectContextMoments(input.moments, input.principal, input.options);
    return renderSelected(picked, input);
  }
  /* 给"已经选好"的调用方用（桌面先选后渲染，避免重复过滤）。 */
  function renderSelected(picked, input) {
    input = input || {};
    const own = (picked && picked.own) || [];
    const others = (picked && picked.others) || [];
    if (!own.length && !others.length) return '';
    const nameOf = (typeof input.characterNameOf === 'function') ? input.characterNameOf : null;
    const nameOr = (id, fallback) => {
      if (nameOf) { try { const n = String(nameOf(id) || '').trim(); if (n) return n; } catch (e) { /* ignore */ } }
      return fallback;
    };
    const selfName = nameOr(input.characterId, '我') || '我';
    const userName = String(input.userName || '').trim() || '用户';
    const nowMs = input.now == null ? Date.now() : input.now;
    const lines = [];
    for (const m of own) {
      lines.push('- （' + contextTimeLabel(m && m.createdAt, nowMs) + '）' + selfName + '：' + String(m && m.content || '').slice(0, 120));
    }
    for (const m of others) {
      const isUserAuthor = !!(m && m.authorType === 'user');
      const author = isUserAuthor ? userName : nameOr(authorOf(m).id, '另一角色') || '另一角色';
      lines.push('- （' + contextTimeLabel(m && m.createdAt, nowMs) + '）' + author + '：' + String(m && m.content || '').slice(0, 120));
    }
    let ctx = '【朋友圈动态（系统参考，勿提及此段）】\n' + lines.join('\n');
    const maxChars = Number(input.maxChars);
    if (Number.isFinite(maxChars) && maxChars > 0 && ctx.length > maxChars) ctx = ctx.slice(0, maxChars);
    return ctx;
  }

  return {
    VISIBILITIES: VISIBILITIES,
    readVisibility: readVisibility,
    writeVisibility: writeVisibility,
    normalizeVisibility: normalizeVisibility,
    visibilityAllows: visibilityAllows,
    authorOf: authorOf,
    isAuthor: isAuthor,
    isMomentVisibleTo: isMomentVisibleTo,
    filterVisibleMoments: filterVisibleMoments,
    deriveChildVisibility: deriveChildVisibility,
    selectContextMoments: selectContextMoments,
    contextTimeLabel: contextTimeLabel,
    renderMomentsContext: renderMomentsContext,
    renderSelected: renderSelected,
    asPrincipal: asPrincipal,
    explain: explain
  };
});
