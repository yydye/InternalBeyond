/* ====================================================================
   M1-C.2n · Moments ACL Contract Suite（M-ACL-1..10）
   --------------------------------------------------------------------
   P2「red-first」的证据形态（与 M1-C.2m 的教训一致）：

     · 每条断言都指向**唯一实现**（assets/js/moments-visibility-core.js）。
       "冻结契约"如果只写在文档里，任何一处生产者都可以悄悄换个判断；
       只有"所有判定都来自同一个可被测对象"时，契约才是可执行的。

     · 每个正例都先证明 fixture **确实可见**（pos 字段），
       每个负例都配一个**反事实**：只改 visibility，同一内容必须变成可注入。
       这正是 M1-C.2m 那次假绿的教训 ——
       "发现期望的文本出现了" 不等于 "注入路径真的会放行它"。

     · 结构性断言（noSecondPredicate）扫描生产源码，
       要求 moments.js / social-network.js / active-diary.js 里不再存在
       独立的 visibility 暴露判定表达式。

   运行：node tests/test_moments_acl_contract.js
   ==================================================================== */
'use strict';

const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const CORE_PATH = path.join(ROOT, 'assets', 'js', 'moments-visibility-core.js');
const CORE = require(CORE_PATH);

let passed = 0, failed = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { passed++; console.log('  ✔ ' + name); }
  else {
    failed++; failures.push(name);
    console.log('  ✖ ' + name + (detail === undefined ? '' : '  ' + JSON.stringify(detail)));
  }
}
function section(title) { console.log('\n── ' + title + ' ──'); }

/* ── fixtures ─────────────────────────────────────────────────────────
   刻意构造"隐藏行比可见行更有吸引力"的反事实对：
   同一条内容、同一个分数、同一个时间，只改 visibility。 */
const USER = { kind: 'user', id: 'user-1' };
const AUTHOR = { kind: 'role', id: 'role-a' };
/* 观察者刻意用**任何 fixture 都不会成为作者**的 id。
   否则「非作者不可见」这类断言会被作者短路悄悄放行 —— 那正是最容易被写错的假绿。 */
const OTHER = { kind: 'role', id: 'role-observer' };
const LISTED = { kind: 'role', id: 'role-c' };

function moment(patch) {
  return Object.assign({
    id: 'mom_x',
    authorType: 'role',
    roleId: 'role-a',
    content: 'MOMENT_CONTENT',
    images: [],
    visibility: 'all',
    visibleRoleIds: [],
    likes: [],
    comments: [],
    source: 'manual',
    createdAt: '2025-01-01T00:00:00.000Z'
  }, patch || {});
}

console.log('M1-C.2n · Moments ACL Contract Suite');
console.log('core: ' + path.relative(ROOT, CORE_PATH));

/* ══════════ M-ACL-1 · 作者可读自己的动态 ══════════ */
section('M-ACL-1 作者可读（冻结契约允许的每一档）');
(function () {
  ['all', 'user', 'roles', 'private', 'invalid'].forEach(function (v) {
    const m = moment({ visibility: v, visibleRoleIds: [] });
    check('M-ACL-1.a 角色作者可读自己的 ' + v, CORE.isMomentVisibleTo(m, AUTHOR) === true, CORE.explain(m, AUTHOR));
  });
  const um = moment({ authorType: 'user', authorId: 'user-1', roleId: '' , visibility: 'private' });
  check('M-ACL-1.b 用户作者可读自己的 private', CORE.isMomentVisibleTo(um, USER) === true);
  check('M-ACL-1.c 用户作者可读自己的 invalid', CORE.isMomentVisibleTo(moment({ authorType: 'user', authorId: 'user-1', roleId: '', visibility: 'private' }), USER) === true);
  /* 旧记录：无 authorType，roleId 即 authorId。 */
  const legacy = { id: 'mom_legacy', roleId: 'role-a', content: 'C', visibility: 'private' };
  check('M-ACL-1.d 旧记录（无 authorType）作者可读', CORE.isMomentVisibleTo(legacy, AUTHOR) === true, CORE.explain(legacy, AUTHOR));
})();

/* ══════════ M-ACL-2 · 无关角色不可见受限动态 ══════════ */
section('M-ACL-2 无关角色不可见受限动态');
(function () {
  ['private', 'user'].forEach(function (v) {
    const m = moment({ visibility: v });
    check('M-ACL-2.a 其他角色看不到 ' + v, CORE.isMomentVisibleTo(m, OTHER) === false, CORE.explain(m, OTHER));
  });
  const roles = moment({ visibility: 'roles', visibleRoleIds: ['role-c'] });
  check('M-ACL-2.b roles 未列名 → 其他角色不可见', CORE.isMomentVisibleTo(roles, OTHER) === false, CORE.explain(roles, OTHER));
  /* roles 档不得因为"名单为空"而变成全体可见。 */
  const emptyRoles = moment({ visibility: 'roles', visibleRoleIds: [] });
  check('M-ACL-2.c roles 名单为空 → 其他角色不可见（不是 all）', CORE.isMomentVisibleTo(emptyRoles, OTHER) === false);
  /* 用户作者给角色的动态：作者恒可读，其他角色不可见。 */
  const u = moment({ authorType: 'user', authorId: 'user-1', roleId: '', visibility: 'roles', visibleRoleIds: ['role-c'] });
  check('M-ACL-2.d 用户 private 不被其他角色读到', CORE.isMomentVisibleTo(moment({ authorType: 'user', authorId: 'user-1', roleId: '', visibility: 'private' }), OTHER) === false);
  check('M-ACL-2.e 用户动态从未列名 → 其他角色不可见', CORE.isMomentVisibleTo(u, OTHER) === false, CORE.explain(u, OTHER));
})();

/* ══════════ M-ACL-3 · 显式许可的角色可读 ══════════ */
section('M-ACL-3 显式许可的角色可读');
(function () {
  const roles = moment({ visibility: 'roles', visibleRoleIds: ['role-c'] });
  check('M-ACL-3.a roles 列名 → 该角色可读', CORE.isMomentVisibleTo(roles, LISTED) === true);
  check('M-ACL-3.b roles 列名 → 未列名的另一个角色仍不可读', CORE.isMomentVisibleTo(roles, OTHER) === false);
  /* 字符串 id 与数字 id 必须一致判定（历史数据里两种都出现过）。 */
  check('M-ACL-3.c visibleRoleIds 数字 id → 归一化后可读',
    CORE.isMomentVisibleTo(moment({ visibility: 'roles', visibleRoleIds: [7] }), { kind: 'role', id: '7' }) === true);
  check('M-ACL-3.d all → 任一角色可读', CORE.isMomentVisibleTo(moment({ visibility: 'all' }), OTHER) === true);
  check('M-ACL-3.e user → 用户可读', CORE.isMomentVisibleTo(moment({ visibility: 'user' }), USER) === true);
})();

/* ══════════ M-ACL-4 · 缺失元数据 fail-closed ══════════ */
section('M-ACL-4 缺失 / 非法 ACL 元数据 fail-closed');
(function () {
  /* 注意断言方向：本组要证的是"缺 ACL 不构成公开"，因此观察者必须是**非作者**。
     同一条记录换作者观察时由作者规则放行（M-ACL-4.b），那是另一条独立规则的证据。 */
  const noVis = moment({ roleId: 'role-zzz' });
  delete noVis.visibility;
  check('M-ACL-4.a 缺 visibility → 非作者不可读', CORE.isMomentVisibleTo(noVis, OTHER) === false, CORE.explain(noVis, OTHER));
  check('M-ACL-4.b 缺 visibility → 作者仍可读', CORE.isMomentVisibleTo(noVis, { kind: 'role', id: 'role-zzz' }) === true);
  check('M-ACL-4.c 读侧：缺 visibility → invalid（不是 all）', CORE.readVisibility(undefined) === 'invalid'
    && CORE.readVisibility(null) === 'invalid' && CORE.readVisibility('') === 'invalid');
  check('M-ACL-4.c2 写侧：缺 visibility → all（产品默认：未标注即公开）', CORE.writeVisibility(undefined) === 'all'
    && CORE.writeVisibility('') === 'all');
  check('M-ACL-4.d 拼错的档位 → invalid（不得兜底成 all）', CORE.readVisibility('everyone') === 'invalid'
    && CORE.writeVisibility('everyone') === 'invalid');
  check('M-ACL-4.e 非字符串档位 → invalid', CORE.readVisibility(123) === 'invalid' && CORE.readVisibility({}) === 'invalid'
    && CORE.writeVisibility(123) === 'invalid');
  /* 反事实：拼错档位与合法 all 的差别必须**真的**体现在可见性上。 */
  const typo = moment({ visibility: 'everyone' });
  const realAll = moment({ visibility: 'all' });
  check('M-ACL-4.f 反事实：拼错档位不可见而 all 可见（同一内容）',
    CORE.isMomentVisibleTo(typo, OTHER) === false && CORE.isMomentVisibleTo(realAll, OTHER) === true);
  check('M-ACL-4.g 无 principal → 不可见', CORE.isMomentVisibleTo(moment({ visibility: 'all' }), null) === false
    && CORE.isMomentVisibleTo(moment({ visibility: 'all' }), { kind: 'role', id: '' }) === false);
  check('M-ACL-4.h 畸形 moment → 不可见', CORE.isMomentVisibleTo(null, AUTHOR) === false
    && CORE.isMomentVisibleTo({ visibility: 'all' }, AUTHOR) === false);
  /* 作者身份不可判定时不得放行（旧数据 authorType 缺失且 roleId 为空）。 */
  check('M-ACL-4.i 作者无法判定 → 不可见', CORE.isMomentVisibleTo(moment({ roleId: '', visibility: 'private' }), AUTHOR) === false);
})();

/* ══════════ M-ACL-5 · 隐藏行不得挤占可见行的 top-k / 分页槽位 ══════════ */
section('M-ACL-5 隐藏高分/高新鲜度行不得挤占可见行的 top-k / 分页');
(function () {
  /* 反事实 fixture：5 条隐藏行比 3 条可见行**更新**（时间更晚）。
     若先 slice 再过滤，可见行会被挤出窗口 —— 这正是原实现 A3/A5/A7 的形态。 */
  const rows = [];
  for (let i = 0; i < 5; i++) {
    rows.push(moment({ id: 'hidden_' + i, visibility: 'private', createdAt: '2025-06-0' + (9 - i) + 'T00:00:00.000Z' }));
  }
  for (let i = 0; i < 3; i++) {
    rows.push(moment({ id: 'visible_' + i, visibility: 'all', createdAt: '2025-01-0' + (i + 1) + 'T00:00:00.000Z' }));
  }
  const byId = rows.slice().sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));

  const wrongWay = byId.slice(0, 3).filter(m => CORE.isMomentVisibleTo(m, OTHER));
  check('M-ACL-5.a 先 slice 再过滤确实会丢掉全部可见行（反事实成立）', wrongWay.length === 0, wrongWay.length);

  const rightWay = CORE.filterVisibleMoments(byId, OTHER).slice(0, 3);
  check('M-ACL-5.b filter-first 后 top-3 全是可见行', rightWay.length === 3
    && rightWay.every(m => m.id.indexOf('visible_') === 0), rightWay.map(m => m.id));
  check('M-ACL-5.c 隐藏行不消耗任何可见槽位', rightWay.every(m => m.visibility === 'all'));
  /* 预算场景：隐藏行不得占用字符预算。
     预算刻意设为"只装得下一条"（每条内容 12 字符），于是判据变成：
     被消耗的那一份预算必须来自可见行。 */
  const budget = 16;
  let used = 0, kept = [];
  for (const m of CORE.filterVisibleMoments(byId, OTHER)) {
    if (used + m.content.length > budget) continue;
    kept.push(m); used += m.content.length;
  }
  check('M-ACL-5.d 预算只由可见行消耗', kept.length === 1 && kept[0].id.indexOf('visible_') === 0 && used === 'MOMENT_CONTENT'.length, { kept: kept.map(m => m.id), used });
  /* 分页：一页 2 条，第二页必须仍有可见行（不得因隐藏行而提前"没有更多"）。 */
  const vis = CORE.filterVisibleMoments(byId, OTHER);
  check('M-ACL-5.e 分页第二页仍有可见行', vis.slice(2, 4).length === 1, vis.length);
})();

/* ══════════ M-ACL-6 · 收窄即刻生效（无后台修复） ══════════ */
section('M-ACL-6 可见性收窄在下一次读取即刻生效');
(function () {
  const wide = moment({ visibility: 'all' });
  check('M-ACL-6.a 收窄前可读', CORE.isMomentVisibleTo(wide, OTHER) === true);
  /* 同一条记录对象被改成更窄：读侧是纯函数，因此下一次读取必然反映新值。 */
  const narrow = Object.assign({}, wide, { visibility: 'private' });
  check('M-ACL-6.b 收窄后同一次调用即刻不可读', CORE.isMomentVisibleTo(narrow, OTHER) === false);
  /* 无缓存：同一个 moment 对象先后判定两次必须各按当时的值回答。 */
  const live = moment({ visibility: 'all' });
  const first = CORE.isMomentVisibleTo(live, OTHER);
  live.visibility = 'roles';
  live.visibleRoleIds = [];
  const second = CORE.isMomentVisibleTo(live, OTHER);
  check('M-ACL-6.c 无缓存（同一对象两次判定各按当时的值）', first === true && second === false);
  /* roles → all 的反方向必须要求显式写入新值（见 M-ACL-7）。 */
  const rec = moment({ visibility: 'roles', visibleRoleIds: ['role-c'] });
  check('M-ACL-6.d 收窄 visibleRoleIds 即刻生效',
    CORE.isMomentVisibleTo(rec, LISTED) === true
    && CORE.isMomentVisibleTo(Object.assign({}, rec, { visibleRoleIds: [] }), LISTED) === false);
})();

/* ══════════ M-ACL-7 · 放宽必须来自显式合法写入 ══════════ */
section('M-ACL-7 放宽需要显式合法写入');
(function () {
  const hidden = moment({ visibility: 'private' });
  check('M-ACL-7.a private 不会因为读次数/时间变化而自己变宽', CORE.isMomentVisibleTo(hidden, OTHER) === false
    && CORE.isMomentVisibleTo(hidden, OTHER) === false);
  /* 缺字段不能"意外"变宽：删掉 visibility 与写成 all 是两种结果。
     （观察者必须是非作者，否则作者规则会同时放行两边，断言就失去意义。） */
  const hidden2 = moment({ roleId: 'role-a', visibility: 'private' });
  const stripped = Object.assign({}, hidden2); delete stripped.visibility;
  check('M-ACL-7.b 删除 visibility 字段 ≠ 变公开', CORE.isMomentVisibleTo(stripped, OTHER) === false
    && CORE.isMomentVisibleTo(Object.assign({}, hidden2, { visibility: 'all' }), OTHER) === true);
  /* 显式写入 all 才放宽。 */
  check('M-ACL-7.c 显式 all 才放宽', CORE.isMomentVisibleTo(Object.assign({}, hidden, { visibility: 'all' }), OTHER) === true);
  /* 非法值也不能被当成"没写"而放宽。 */
  check('M-ACL-7.d 非法值不构成放宽', CORE.isMomentVisibleTo(Object.assign({}, hidden, { visibility: 'PUBLIC' }), OTHER) === false);
})();

/* ══════════ M-ACL-8 · AI 与用户作者同语义（除合同显式区分处） ══════════ */
section('M-ACL-8 AI 创建与用户创建遵循同一语义');
(function () {
  const pairs = [
    ['private', 'private'], ['all', 'all'], ['user', 'user'], ['roles', 'roles']
  ];
  pairs.forEach(function (p) {
    const roleM = moment({ visibility: p[0], visibleRoleIds: ['role-c'] });
    const userM = moment({ authorType: 'user', authorId: 'user-1', roleId: '', visibility: p[1], visibleRoleIds: ['role-c'] });
    const roleVerdict = CORE.isMomentVisibleTo(roleM, OTHER);
    const userVerdict = CORE.isMomentVisibleTo(userM, OTHER);
    check('M-ACL-8.a 其他角色对 ' + p[0] + ' 的判定与作者类型无关', roleVerdict === userVerdict, { roleVerdict, userVerdict });
  });
  const uv = moment({ authorType: 'user', authorId: 'user-1', roleId: '', visibility: 'user' });
  const rv = moment({ visibility: 'user' });
  check('M-ACL-8.b user 档对用户一致可见', CORE.isMomentVisibleTo(uv, USER) === true && CORE.isMomentVisibleTo(rv, USER) === true);
  check('M-ACL-8.c 合同显式区分的唯一一处：用户恒可读自己发的',
    CORE.isMomentVisibleTo(moment({ authorType: 'user', authorId: 'user-1', roleId: '', visibility: 'private' }), USER) === true
    && CORE.isMomentVisibleTo(moment({ authorType: 'role', roleId: 'role-a', visibility: 'private' }), USER) === false);
})();

/* ══════════ M-ACL-9 · 桌面与纯 Node 判定逐位一致 ══════════ */
section('M-ACL-9 同一核心在浏览器与 Node 给出同一答案');
(function () {
  /* Node 侧就是本文件 require 到的对象；浏览器侧经 UMD 暴露到 window。
     这里用与浏览器完全相同的 UMD 入口再加载一次（vm 里带 self），
     断言两边的每个方法对同一输入逐位一致 —— 这排除"双载时行为不同"。 */
  const vm = require('vm');
  const src = fs.readFileSync(CORE_PATH, 'utf8');
  const sandbox = { self: {}, console };
  sandbox.self.self = sandbox.self;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  const browserCore = sandbox.self.IBMomentsVisibilityCore;
  check('M-ACL-9.a 浏览器入口已导出', !!browserCore && typeof browserCore.isMomentVisibleTo === 'function');
  const principals = { user: USER, author: AUTHOR, other: OTHER, listed: LISTED, none: null, empty: { kind: 'role', id: '' } };
  const cases = [];
  ['all', 'user', 'roles', 'private', 'invalid', 'everyone', 123].forEach(function (v) {
    cases.push(moment({ visibility: v, visibleRoleIds: ['role-c'] }));
    cases.push(moment({ authorType: 'user', authorId: 'user-1', roleId: '', visibility: v, visibleRoleIds: ['role-c'] }));
  });
  cases.push({ id: 'no-vis', authorType: 'role', roleId: 'role-a', content: 'x' });
  cases.push(null);
  let mismatches = [];
  Object.keys(principals).forEach(function (pk) {
    cases.forEach(function (m, i) {
      const a = CORE.isMomentVisibleTo(m, principals[pk]);
      const b = browserCore.isMomentVisibleTo(m, principals[pk]);
      if (a !== b) mismatches.push({ pk, i, node: a, browser: b });
    });
  });
  check('M-ACL-9.b ' + (cases.length * Object.keys(principals).length) + ' 组判定逐位一致', mismatches.length === 0, mismatches.slice(0, 5));
  check('M-ACL-9.c 归一化函数一致', browserCore.normalizeVisibility('nope') === CORE.normalizeVisibility('nope'));
  check('M-ACL-9.d 子制品派生一致',
    JSON.stringify(browserCore.deriveChildVisibility([{ visibility: 'all' }, { visibility: 'roles', visibleRoleIds: ['x'] }]))
    === JSON.stringify(CORE.deriveChildVisibility([{ visibility: 'all' }, { visibility: 'roles', visibleRoleIds: ['x'] }])));
})();

/* ══════════ M-ACL-10 · 受限内容不得进入模型可见块 ══════════ */
section('M-ACL-10 受限动态文本不得进入模型可见上下文');
(function () {
  /* 用真实的生产渲染函数：Middle Brain 的 moments 块拼装（middle-brain-policy.js 第 179 行）
     与 chat 注入的 `【朋友圈动态…】` 头（moments.js getMomentsContext）。
     这里断言的是**选择**这一层：喂给渲染器的候选集必须先经过核心。 */
  const candidates = [
    moment({ id: 'pub', content: 'PUBLIC_MOMENT_TEXT', visibility: 'all', createdAt: '2025-03-01T00:00:00.000Z' }),
    moment({ id: 'hid', content: 'HIDDEN_MOMENT_TEXT', visibility: 'private', createdAt: '2025-05-01T00:00:00.000Z' }),
    moment({ id: 'hid2', content: 'HIDDEN2_MOMENT_TEXT', visibility: 'roles', visibleRoleIds: ['role-z'], createdAt: '2025-06-01T00:00:00.000Z' })
  ];
  const injected = CORE.filterVisibleMoments(candidates, OTHER).map(m => m.content).join('\n');
  check('M-ACL-10.a 可见文本进入', injected.indexOf('PUBLIC_MOMENT_TEXT') >= 0, injected);
  check('M-ACL-10.b 受限文本不进入', injected.indexOf('HIDDEN_MOMENT_TEXT') < 0 && injected.indexOf('HIDDEN2_MOMENT_TEXT') < 0, injected);
  /* 反事实：只把可见性改成 all，同一文本立刻变成可注入。 */
  const flipped = candidates.map(m => Object.assign({}, m, { visibility: 'all', visibleRoleIds: [] }));
  const injected2 = CORE.filterVisibleMoments(flipped, OTHER).map(m => m.content).join('\n');
  check('M-ACL-10.c 反事实：仅改 visibility 后 HIDDEN_MOMENT_TEXT 变为可注入', injected2.indexOf('HIDDEN_MOMENT_TEXT') >= 0);
  /* 子制品继承（评论）：受限动态的评论不得出现在"我发过的回复"列表里。 */
  const withComments = [
    moment({ id: 'restricted', visibility: 'private', comments: [{ id: 'c1', authorType: 'user', authorId: 'user-1', content: 'RESTRICTED_COMMENT' }] }),
    moment({ id: 'open', visibility: 'all', comments: [{ id: 'c2', authorType: 'user', authorId: 'user-1', content: 'OPEN_COMMENT' }] })
  ];
  const replyRows = [];
  CORE.filterVisibleMoments(withComments, USER).forEach(m => (m.comments || []).forEach(c => {
    if (c.authorType === 'user' && c.authorId === 'user-1') replyRows.push(c.content);
  }));
  check('M-ACL-10.d 受限动态的评论不进入"我发过的回复"', replyRows.indexOf('RESTRICTED_COMMENT') < 0, replyRows);
  check('M-ACL-10.e 同一条评论在公开动态下可见（反事实成立）', replyRows.indexOf('OPEN_COMMENT') >= 0, replyRows);
  /* 转发文本同理：repostText 与被转发正文都属于该行自己的可见性。 */
  const repost = moment({ id: 'rp', visibility: 'private', repostOf: 'x', repostText: 'REPOST_TEXT', content: 'REPOST_QUOTED' });
  check('M-ACL-10.f 受限转发的正文与评语都不可注入',
    CORE.isMomentVisibleTo(repost, OTHER) === false);
})();

/* ══════════ 结构性：不存在第二份实现 ══════════ */
section('结构性 · 生产代码不得含第二份 Moments 可见性判定');(function () {
  /* 判据：在这些"曾经各自实现过"的文件里，不允许再出现
     "直接读 moment.visibility 做暴露判定" 的表达式。
     允许出现的形态：
       · 调用 IBMomentsVisibilityCore.*
       · 纯粹的**透传/存值**（把 visibility 原样带进快照、写库、日志字段）
       · 测试/观测字段 */
  const files = [
    'assets/js/moments.js',
    'assets/js/social-network.js',
    'assets/js/active-diary.js'
  ];
  /* 这些是"把 visibility 当作**值**搬运"的合法形态（不是判定）。 */
  const ALLOW = [
    /visibility:\s*[A-Za-z_.]*\.?visibility/,          /* 透传字段 */
    /String\(m\.visibility/,
    /visibility:\s*'?'?[\w"']+/,                       /* 落盘/归一后的字面量 */
    /\.visibility\s*\)/,                               /* 作为参数传入 */
    /core\.normalizeVisibility/,
    /(readVisibility|writeVisibility)\(/,             /* 经共享核心归一 */
    /IBMomentsVisibilityCore/,
    /\|\|\s*'all'/                                     /* 写入侧默认（P3 后只允许出现在写入归一） */
  ];
  /* 只挑 bare（或 m./moment.）主体的 visibility 判定；
     `cur.visibility` / `want.visibility` 这类限定名属于 **memory** 的 ACL
     （memory-visibility-core 的域），不在本核心的收敛范围内，
     把它们算进来会让这条结构性断言变成噪声而不是证据。 */
  /* active-diary.js 同时承载两个 ACL 域：moments（本核心收敛）与 **memory**
     （由 memory-visibility-core 收敛，M1-C.2d 已闭合）。下面两条是 memory 域的
     历史修复逻辑（visibleTo 的规整），既不是 moment 判定，也不属于本阶段范围。
     显式列名而不是放宽正则 —— 放宽会让"m.visibility"这种最常见的 moment 判定形态
     一起失效，那这条断言就废了。 */
  const MEMORY_DOMAIN_ALLOW = [
    'assets/js/active-diary.js:997',   /* _memRepairVisibleState：memory 'only' + 空 visibleTo */
    'assets/js/active-diary.js:1013'   /* _memRepair 判定：memory visibleTo/excludeFrom 规整 */
  ];
  const offenders = [];
  files.forEach(function (rel) {
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) return;
    const raw = fs.readFileSync(abs, 'utf8').split(/\r?\n/);
    /* 先剥注释再扫描：注释里引用旧代码（本阶段的说明文字）不是"第二份实现"。
       若不剥，这条断言会因为"我把旧谓词写进注释讲清楚"而变红 —— 那是噪声，
       而且会诱导作者删掉解释性注释，正好与"可审计"相反。 */
    let inBlock = false;
    raw.forEach(function (line, i) {
      if (MEMORY_DOMAIN_ALLOW.indexOf(rel + ':' + (i + 1)) >= 0) return;
      let code = line;
      if (inBlock) {
        const end = code.indexOf('*/');
        if (end < 0) return;
        code = code.slice(end + 2); inBlock = false;
      }
      const open = code.indexOf('/*');
      if (open >= 0) {
        const end = code.indexOf('*/', open + 2);
        if (end < 0) { code = code.slice(0, open); inBlock = true; }
        else code = code.slice(0, open) + code.slice(end + 2);
      }
      const lineComment = code.indexOf('//');
      if (lineComment >= 0) code = code.slice(0, lineComment);
      if (code.indexOf('visibility') < 0) return;
      const isDecision = /([^\w.$]|^)(m|moment)?\.?visibility\s*(===|!==|==|!=|\.includes\()/.test(code)
        || /['"](all|user|roles|private)['"]\s*(===|!==)\s*(\w+\.)?visibility/.test(code);
      if (!isDecision) return;
      if (ALLOW.some(re => re.test(code))) return;
      offenders.push(rel + ':' + (i + 1) + '  ' + line.trim());
    });
  });
  check('noSecondPredicate 生产代码里没有第二份可见性判定', offenders.length === 0, offenders);
})();

/* ══════════ 归一化与子制品派生的边界 ══════════ */
section('边界 · deriveChildVisibility 只可能更窄');
(function () {
  check('empty → private', CORE.deriveChildVisibility([]).visibility === 'private');
  check('all+all → all', CORE.deriveChildVisibility([{ visibility: 'all' }, { visibility: 'all' }]).visibility === 'all');
  check('all+private → private', CORE.deriveChildVisibility([{ visibility: 'all' }, { visibility: 'private' }]).visibility === 'private');
  check('all+invalid → private', CORE.deriveChildVisibility([{ visibility: 'all' }, { visibility: 'zzz' }]).visibility === 'private');
  const inter = CORE.deriveChildVisibility([
    { visibility: 'roles', visibleRoleIds: ['a', 'b'] },
    { visibility: 'roles', visibleRoleIds: ['b', 'c'] }
  ]);
  check('roles ∩ roles 取交集', inter.visibility === 'roles' && JSON.stringify(inter.visibleRoleIds) === '["b"]', inter);
  const mixed = CORE.deriveChildVisibility([{ visibility: 'all' }, { visibility: 'roles', visibleRoleIds: ['b'] }]);
  check('all + roles → roles（不得放宽为 all）', mixed.visibility === 'roles' && JSON.stringify(mixed.visibleRoleIds) === '["b"]', mixed);
  const userMix = CORE.deriveChildVisibility([{ visibility: 'user' }, { visibility: 'all' }]);
  check('user + all → 收窄（不是 all）', userMix.visibility !== 'all', userMix);
})();

console.log('\n' + '='.repeat(64));
console.log('Moments ACL contract: ' + passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('failed: ' + failures.join(', ')); process.exitCode = 1; }
