'use strict';
/* ====================================================================
   Internal Beyond · P0 角色连续性上下文（M1-C.2c-A）
   --------------------------------------------------------------------
   **只负责四个事实**，刻意保持小：

     userIdentity      ← 桌面 about/main 的 name（经 /characters/publish 发布）
     preferredAddress  ← 同一个 name。IB 没有独立"称呼"字段，桌面就是用
                          about.name 称呼用户（resources 见下），不另造字段
     relationship      ← characters.dto_json.relationship（角色 DTO，public）
     currentTime       ← Home Node 自己的时钟 + 明确时区语义

   ── 权威来源（都是**已存在**的桌面 production source，不是新发明）────
   Desktop 单聊 _buildSingleChatContext（communication.js:1398）：
     :1405  你的身份/昵称是「<cfg.nickname>」           ← 角色自己的昵称
     :1406  你和对方的关系是：<cfg.relationship>。       ← 与 P0 relationship 同源
     :1424  当前时间：<toLocaleString('zh-CN',{...})>。  ← 与 P0 currentTime 同源
   Desktop 用户资料 site-operations.js:66-77：
     dbGet('about','main') → 【对方的个人资料】\n昵称：<about.name>
                                                      ← 与 P0 userIdentity 同源

   ── 语义等价，不追求字节相等（本轮验收目标）────────────────────────
   这里**不逐字复制** Desktop 的空格/标题/换行/顺序 —— 那是 browser-specific
   composer 的形状。要求只有一条：四个事实的值一致。
   因此单一事实来源是【当前日期时间】那一行（与 Desktop 逐字同格式），
   其余三行是 Node 侧对同一事实的等价陈述。

   ── 为什么不是 "Context Composer" ──────────────────────────────────
   没有 registry / pipeline / plugin / DSL。就是一个纯函数、四行文本。
   Reference Spike 已冻结"Dual-host canonical composer 不做"，本模块不改变这一点：
   它只服务 Home Node 一条执行路径，不参与桌面 composer，也不被桌面加载。

   ── 不往这里加东西 ────────────────────────────────────────────────
   长期 Memory / Understanding / Thread / Moments / summary / diary 一律不接。
   本阶段必须是 NO，且不许为了报告好看偷偷接上。

   ── 决策记录（M1-C.2d Wave 1 · 记录一条**未来**授权，不改变本文件职责）──
   上面的冻结在本模块内永久有效：p0-context.js 只渲染身份 / 关系 / 时间，
   **不**成为通用 context composer。

   但该冻结**不等于**"Home Node 永远没有记忆"。两者是不同层的决定：

     · 本文件（p0 continuity context）
         → 保持 identity / relationship / time only。Memory 仍然排除。
     · Home Node execution / context 层（execution.js ← mobile-gateway.js 的
       provider context 组装处）
         → Wave 2 将在此处新增**独立的 memory source**，而不是把 memory
           塞进本文件、也不是把本文件扩展成 composer。

   即：授权的是"在别处加一个 memory 来源"，不是"在这里放宽冻结"。
   Wave 1 本身**不**接线任何 memory；本注释只是把下一波的合法落点写清楚，
   避免 Wave 2 因为找不到授权而悄悄改这个冻结。
   ==================================================================== */

/* 与 Desktop communication.js:1424 逐字相同的格式选项。
   刻意 hour12:false —— 桌面在 zh-CN 下默认就是 24 小时制，显式写死是为了
   让非 zh-CN 的 Node 环境（ICU/默认区域不同）也得到同一形状，
   否则"当前时间"会在某些机器上变成 "上午07:30"，格式断言就不再稳定。 */
const TIME_OPTIONS = {
  year: 'numeric', month: 'long', day: 'numeric', weekday: 'long',
  hour: '2-digit', minute: '2-digit', hour12: false
};

/* 时区语义：默认用 Home Node 进程的本地时区。
   桌面用浏览器的本地时区（new Date() + toLocaleString），
   单机部署下两者是同一个时区 —— 这是"same local time"的默认解释。
   显式传 timeZone 时按显式值渲染（LAN 部署 + 时区不一致时的唯一出口）。
   坏时区串绝不抛错：退回本地时区，因为"没有时间"比"时区写错"更糟。 */
function formatCurrentTime(ts, timeZone) {
  const date = new Date(Number(ts));
  const at = isFinite(date.getTime()) ? date : new Date();
  if (timeZone) {
    try {
      return new Intl.DateTimeFormat('zh-CN', Object.assign({ timeZone: String(timeZone) }, TIME_OPTIONS)).format(at);
    } catch (_) { /* 非法时区 → 退回本地，不抛 */ }
  }
  return new Intl.DateTimeFormat('zh-CN', TIME_OPTIONS).format(at);
}

/* 用户身份与称呼。IB 没有"用户昵称"与"偏好称呼"两个字段 —— 桌面统一用
   about.name 称呼用户，所以这两个 P0 事实在当前架构里**同源**。
   刻意不把 character.nickname 混进来：那是**角色**的名字，不是用户的。 */
function userIdentityOf(profile) {
  const p = profile && typeof profile === 'object' ? profile : {};
  const name = String(p.name == null ? '' : p.name).trim();
  return {
    /* id 目前只用于 provenance 记录；桌面 about/main 就是单用户模型。 */
    id: String(p.id == null ? 'main' : p.id).trim() || 'main',
    name: name,
    preferredAddress: name
  };
}

/* 产出一段追加到 system 尾部的运行上下文。
   返回 '' 表示**没有任何可注入事实** —— 此时不要把空标题塞进 prompt。 */
function buildContinuityContext(options) {
  const opts = options || {};
  const lines = [];

  /* 时间永远可注入：Node 自己算，绝不接受客户端上传的"现在几点"。 */
  const time = String(opts.currentTime == null ? '' : opts.currentTime).trim();
  if (time) lines.push('当前时间：' + time + '。');

  const identity = userIdentityOf(opts.userProfile);
  if (identity.name) {
    lines.push('【对方的个人资料】');
    lines.push('称呼：' + identity.name + '。');
    lines.push('（以上为对方的个人资料。）');
  }

  /* relationship 是角色 DTO 的 public 字段，真实语义就是当前字符串本身。
     不新增关系状态机、不枚举、不翻译。 */
  const relationship = String(opts.relationship == null ? '' : opts.relationship).trim();
  if (relationship) lines.push('你和对方的关系是：' + relationship + '。');

  if (!lines.length) return '';
  return lines.join('\n');
}

module.exports = {
  buildContinuityContext: buildContinuityContext,
  formatCurrentTime: formatCurrentTime,
  userIdentityOf: userIdentityOf,
  TIME_OPTIONS: TIME_OPTIONS
};
