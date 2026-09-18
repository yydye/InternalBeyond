# P22-15 · Economy Approval UI

**Commit:** `P22-15 · add Economy approval UI`
**Baseline:** `e92a789 P22-14 · add Economy bootstrap and configuration path`
**Scope:** 给 P22-13 已经完成的 Approval Decision Path 做一个**真的能用、并且符合
InternalBeyond 现有视觉语言**的浏览器 UI。后端**一个字节都没有改**。

---

## 0 · 这一阶段做了什么（一句话）

浏览器里第一次有人能**看见**一条等待中的 Agent Intent，并对它点头或摇头；
而这件事本身不产生任何经济权威 —— 它只是把 P22-13 那条 authenticated seam
接到一张卡片上。

```
一个角色想做一件事  →  需要你决定  →  允许继续 / 拒绝请求
                                        │
                                        └─→ POST /internal/economy/approval-decision
                                              { approvalId, decision, idempotencyKey }
```

---

## 1 · 只读审计（写 UI 之前先问的三个问题）

### 1.1 数据面：canonical read model 在哪里？

| 实体 | 读面 | 本页用不用 |
|---|---|---|
| **Agent Intent** | `GET /economy/intents` · `GET /economy/intent?withChain=1` | **用**（列表：`?limit=N`） |
| **Approval** | `GET /economy/approvals` · `GET /economy/approval?approvalId=` | **用**（列表：金额 / 币种 / 状态 / 到期 / quoteKind 都在这里） |
| **Product** | `GET /economy/products` · `GET /economy/product?productId=` | **用**（列表：只要名字 / 描述 / 类别） |
| **Store** | `GET /economy/stores` · `/economy/store` | 不用（卡片不需要货架） |
| **Quote** | `GET /economy/quotes` · `/economy/quote` | **不用** —— 价格唯一来自批准绑定（见 §2） |
| **Purchase** | `GET /economy/purchases` · `/economy/purchase` | 不用（`purchaseId` 已在 intent 上） |
| Wallet / Budget Policy / Autonomy Policy | 各自有只读面 | 不用（§6：UI 不判定，也不展示"还剩多少"） |
| **决定路径开不开** | `GET /security` → `economyPolicy.approvalDecision.open` | **用**（进入页面就说清楚） |
| Intent Chain | `GET /economy/intent?withChain=1` | 不用（链是编排细节，不进主视觉） |

⇒ **四条既有 GET**，本阶段**没有新增任何读路径**。

### 1.2 写面：唯一允许的一件

```
POST /internal/economy/approval-decision      （P22-13 · 既有）
信封恰好 { approvalId, decision, idempotencyKey } · 决定词恰好 APPROVE / REJECT
```

浏览器**禁止**并且**做不到**的：直接 settle / reserve / 改 ledger / 改 approval row /
resume intent。做法不是"记得别写"，而是：

* 整个渲染器里**没有 `fetch`**（测试 A1 断言）；
* 唯一的写调用是 `driver.approvalDecision(body)`，而它的 body 是在纯层里
  **构造**出来的三键对象（测试 B1/B3b/C1/C3 逐条断言）；
* 那个构造函数的签名恰好三个位置参数（`length === 3`）—— 没有第四个位置
  可以放身份或金额。

### 1.3 视觉面：现有组件语言读到了什么

读了这些之后才动手（不是先画再解释）：

```
InternalBeyond.html（导航 / 页面容器 / a11y 约定 / 样式表顺序）
assets/css/core.css             :root 与 body.theme-infernal 两套令牌（--glass-* ·
                                 --radius-* · --surface-* · --border-* · --content-* ·
                                 --shadow-* · --accent · --status-* · --space-*）·
                                 浅色主题那条"整棵子树加白色发光"的规则
assets/css/core/api-components.css : .module-intro / .glass-card
assets/css/core/blog.css          : .btn / .btn-primary
assets/css/core/memory.css        : **Memory Approval** 浮层（最接近的先例：
                                    avatar + kicker + title + badge + 一段理由 +
                                    [拒绝][允许] 两个按钮）
assets/css/core/archive-active.css: .active-empty / 状态徽标 / 卡片头
assets/css/*.css 的 empty-state / plate / toast / responsive 断点
assets/js/glass-ripple.js         : 它只作用于背景与 pane，页面元素不需要接线
assets/js/moments.js · social.js  : 头像的唯一来源（apiConfigs[].avatar）
```

**结论：复用既有的 glass / plate / module 语言，不建 Economy Design System。**
具体复用：`.page` + `.ec-*` 只描述这一个页面；颜色 / 圆角 / 模糊 / 阴影 / 间距
全部取既有令牌；按钮直接用 `.btn` / `.btn-primary`；头像与角色名走
`window.apiConfigs`（P4 契约里角色的唯一事实源）；样式表按模块**运行时注入**
（与 diagnostics / guide-beginner / setup-wizard / update-card 同一条既有做法）。

---

## 2 · 金额从哪来（唯一一处"看起来像计算"的地方）

intent 读面**不携带价格**（契约里逐字说了：价格唯一来自 quote）。因此卡片上的
金额取自**批准绑定**：`GET /economy/approvals` 的 `amountMinor` / `currency`
（`binding` 也在，用作兜底）。

浏览器只做**展示换算**：`1000 IB_CREDIT` → `10.00 IB Credit`。
scale 与币种展示名是契约的镜像（`CURRENCY_SCALE` / `CURRENCY_DISPLAY`），
测试**逐键比对**这两张表：

```
F1 ★★★ 币种 scale 镜像与契约的 CURRENCY_SCALE 完全一致（增删键都会红）
F2 ★★★ 币种展示名镜像与契约的 CURRENCY_DISPLAY 完全一致
```

⇒ 未来契约加一种币而镜像没跟上，**这里是红**，而不是静默显示一个错的金额。

---

## 3 · 页面信息架构

```
Economy（导航）→ #page-economy → #economy-requests（空容器，整页由渲染器建）

  ┌ 待决定 · Requests ──────────────────── [同步于 刚刚] [刷新]
  │ ┌────────────────────────────────────────────────────────┐
  │ │ ⬤ 栖                    想补充一些算力      ⏱ 等待你的决定 │
  │ │   ├ [算力图标] Compute x1000                             │
  │ │   │             算力额度 · 给她的算力补充                 │
  │ │   ├ “算力快用完了，再给她一批我就能把今天那篇稿子写完。”   │
  │ │   ├ 12.50 IB Credit   × 2                                │
  │ │   │  ──────────────────────────────────────────────     │
  │ │   │  决定有效期 还有 15 分钟 · 经济裁决 需要你确认         │
  │ │   │  原因 金额超过了可以自己决定的上限，所以要问你          │
  │ │   └                            [拒绝请求]  [允许继续]     │
  │ │   细节 ▸（默认收起：intentId / approvalId / productId /   │
  │ │          quoteId / 状态码 / 原词）                        │
  │ └────────────────────────────────────────────────────────┘
  └ 近期的决定（安静区，opacity .86，最多 12 张 + "再看一些"）
```

围绕的是「**某个角色想做一件事，需要你决定**」，不是数据库的 Approval row。

---

## 4 · 状态设计（六种，不是六种高饱和色）

| canonical | 面 | 徽标文案 | tone |
|---|---|---|---|
| `WAITING_APPROVAL` + 批准 `PENDING` | 待决定 | 等待你的决定 | accent |
| 批准 `APPROVED` | 已允许 | 已允许 · 等待继续 | accent-light |
| intent `EXECUTING` | 进行中 | 已允许 · 正在继续 | accent-light |
| `COMPLETED` / 批准 `CONSUMED` | 完成 | 已完成 | status-success |
| `DENIED` | 未通过 | 没有通过 | status-warning |
| 批准 `REJECTED` | 拒绝 | 已拒绝 | status-warning |
| `EXPIRED` / 批准 `EXPIRED` / `expiredByTime` | 过期 | 已过期 | content-muted |
| `FAILED` | 失败 | 没能完成 | status-warning |
| 未知词 | —— | **状态未知**（保留原词，不硬塞进任何已知桶） | accent-light |

视觉只用：一个 11px 线性图标 + 短文案 + 一条 3px 左轨 + opacity + 一个
`.ec-tone-*` 变量。**没有六种颜色，`FAILED` 也不是巨大红框。**

**几处刻意的判断（都与"两个事实不要混在一起"有关）**

* 批准被拒优先于 intent 自己的 `DENIED` —— 用户刚点的"拒绝"要读作"已拒绝"，
  而不是 intent 那边的"没有通过"。
* intent 已经在跑（`EXECUTING`）优先于"批准已批" —— 那时该说"正在继续"。
* `APPROVED` 而最终 `DENIED`：卡片说"没有通过"，并且**额外**说一句
  "你已经允许了她继续，但经济侧没有放行"。
* 批准记录读不到（超出 limit）时**不**当作"等你决定"，而是落在历史区并如实
  说"这条请求对应的许可记录已经找不到了"。

---

## 5 · APPROVED ≠ PURCHASED（§5 的落点）

按钮的文字是「**允许继续**」，不是"购买 / 支付 / 结算 / 下单"（测试逐个断言，
而且**只**检查四个按钮字段 —— 解释性文案里可以说"内部购买"、"批准不等于买到"）。

决定之后**不做乐观成功**：点击只把按钮置为进行中（`aria-busy` + 一个 12px
环），然后**重新读**四条只读面；卡片显示的是读面说的：

| 决定面的回答 | 卡片说 |
|---|---|
| `continuation: 'refused'` | 已允许 + 「这一次它们没有放行：<原因>。你自己已经允许过了。」 |
| `purchaseExists: true`（这一次真的建了） | 已允许 + 「她这件事已经完成了。」 |
| `continuationReplayed: true` | 已允许 + 「她这件事之前就已经完成了（这一次是重放）。」 |
| `continuation: 'attempted'` 但还没终态 | 已允许 · 正在继续 |
| `REJECT` | 已拒绝 + 「这条请求到此结束，没有产生任何经济动作。」 |

---

## 6 · 空状态（§9）

一只安静的空托盘：`inline SVG` · `160×120` · `currentColor` · 线性轮廓 ·
**没有金币、没有银行卡、没有购物车、没有 emoji、没有 PNG。**

```
暂时没有需要你决定的请求
角色提出需要确认的内部购买时，会出现在这里。
```

---

## 7 · 图标（§10）

| 用途 | 实现 |
|---|---|
| credit / item / compute / service / api-quota | `KIND_ICON[canonical kind]`（5 个 24×24 SVG，未登录类别有一个中性兜底） |
| approval / reject / progress / done / expired / failed | `MARK[tone]`（6 个 11×11 SVG） |
| 空状态 | 一张 160×120 的 inline SVG |

全部：`viewBox` 固定 · `currentColor` · 统一 `stroke-linecap/linejoin` ·
两套主题自动适配。**零 emoji · 零 FontAwesome · 零外部 CDN · 零 PNG。**

---

## 8 · 响应式与双主题（§12 / §13）

三档断点：`1024`（窄桌面收内边距）· `880`（内容不再限宽、attrs 变单列）·
`640`（按钮整行 44px、金额降一级、badge 落到名字下面、safe-area 底部留白）。

真实浏览器读数（`test_p22_15_economy_approval_visual.js`，2 主题 × 3 宽度
= 6 组 × 11 条 + 空状态 3 条 + 真实点击 3 条 = **66/66**）：

```
✔ 页面真的打开着，两张待决定 + 两条历史
✔ 没有横向溢出（body 与 documentElement 的 scrollWidth 都不超过视口）
✔ 卡片不会横跨整个屏幕（≤ min(host, 960)）
✔ 主线按钮在大屏 ≥36px、在手机是整行（≥ width-80）且 ≥42px
✔ 主题真的是那一个，且卡片底色随主题变
✔ 金额被强调（≥16px）
✔ 技术详情默认收起（每张卡片恰好一个「细节」开关）
✔ 浅色主题那条白色发光在卡片子树里被关掉（text-shadow: none）
✔ 卡片文字色与底色都随主题真的换了
✔ 主线卡片的 opacity 是 1（"安静"只写在历史卡片上）
```

**浅色主题那条 `text-shadow` 覆盖是刻意的**：`core.css` 有一条
`body:not(.theme-infernal) .page.active div { text-shadow: 0 0 8px rgba(255,255,255,.4) … }`
—— 它让浅色子页的字在雾面上"发光"。但本页的卡片是**有玻璃底的浮起表面**，
那层白色光晕会让卡内小字糊掉。因此关闭**只作用于 `#economy-requests` 这棵
子树**，既有页面一个字都不受影响；页面标题保留一条与 `module-intro h2` 同款的
发光。

---

## 9 · 错误体验（§14）

| 情形 | 用户看到 | 原词去哪了 |
|---|---|---|
| 网络 / transport | 「连接不上本机节点」+「重启 InternalBeyond 之后再试一次」 | `home-node-unreachable` 只在字段里 |
| 读模型不成形 | 「读到的数据不成形」+「因此这里什么都不显示，也不猜」+ [再试一次] | `intents-malformed` 只在字段里 |
| 凭据没配 | **进入页面就**一句说明（来自 `/security`，不是猜的），按下去仍会真发一次请求 | 码只在字段里 |
| 批准过期 | 徽标"已过期" + 原因 | —— |
| 已被处理过 | 卡片留在原地 + 「不接受这个决定（这一步现在不能做）」 | 两个码都在字段里 |
| 预算最终拒绝 | 徽标"没有通过" + 「你已经允许了她继续，但经济侧没有放行」 | `DENY_REASON` 有 50 条中文映射 |

**没有一条用户正文里出现过 canonical 大写词**（测试 D2/D2c/A12 断言）。

---

## 10 · 测试与资源

```
tests/test_p22_15_economy_approval_ui_core.js     62/62 ✔   纯层（vm 沙箱，无 DOM / 无 fetch）
tests/test_p22_15_economy_approval_ui.js          55/55 ✔   DOM 桩 + 真实网络形状（无 socket）
tests/test_p22_15_economy_approval_visual.js      66/66 ✔   真实浏览器（**不在默认套件里**）
tests/test_p22_1_economy_boundary.js              B7.9–B7.13（新增：浏览器侧也在同一条边界里）
tests/test_frontend_structure.js                  通过（编码 / BOM / 样式表预算 20 不变）
tests/test_ui_regression.js                       通过（真实浏览器 UI 回归）
tests/test_home_node_client_envelope.js           55/55 ✔
tests/test_p22_12_economy_active_plan.js          36/36 ✔
tests/test_p22_12_economy_intent_producer.js      76/76 ✔
```

资源纪律：**child process = 0 · spawn = 0 · socket = 0 · Desktop/Electron/DSH = 0**。
视觉核对那一个文件要开浏览器，因此它**没有**登记进 `tests/test-all.js`
（与 `test_ui_regression.js` 同款）；默认套件里新增的是上面前两条。
截图落在 `%TEMP%\ib-p22-15-shots\`，**不写进仓库**（本阶段 PNG 新增 = 0）。

---

## 11 · 上游契约改动（逐条）

| 文件 | 改动 | 性质 |
|---|---|---|
| `InternalBeyond.html` | +1 导航项（`data-page="economy"`）· +1 空页面容器 · +2 `<script>` | 加法；样式表**仍为 20**（新样式表运行时注入） |
| `assets/js/core.js` | `navTo()` 里 +3 行：`page === 'economy'` 时调 `IB.economyApprovalUI.render()` | 加法，与既有 `apps` / `favorites` / `coread` 同一形状 |
| `assets/js/home-node-client.js` | +`approvalDecision(options)`（写）· +`getJson(path, query)`（只读） | 加法；既有方法一个字未改；`getJson` 没有 method 参数，路径必须 `/` 开头且不含 `://` / `..` |
| `assets/js/economy-approval-core.js` | 新文件（纯层） | 浏览器侧第一个 Economy 文件 |
| `assets/js/economy-approval.js` | 新文件（渲染器） | —— |
| `assets/css/economy-approval.css` | 新文件（运行时注入） | 只用既有令牌 |
| `tests/test_p22_1_economy_boundary.js` | +B7.9~B7.13 | 把浏览器侧接进既有边界 |
| `tests/test-all.js` | +`p22-ui` 组（两条） | —— |
| `scripts/ib-bom.py` | 新工具 | 补 UTF-8 BOM（write/edit 会剥掉它，而前端回归要求它） |

**后端零改动**：`git status` 里没有 `services/` 下的任何文件。P22-1～P22-14 的
冻结契约（schema 7 · 七份生产文件 · 三条写路径 · `/economy/*` 只读）逐字未变；
P22-1 boundary 仍然报"Economy 生产文件 7 个 · require 目标 12 个"。

---

## 12 · 开发期抓到并修掉的六个**真实**缺陷

1. **`effectiveStatus` 有一支只给了 `kind` 没给 `code`** —— 卡片状态码是
   `undefined` → 显示"状态未知"，而它其实有确切的答案（批准被拒）。
2. **`APPROVED` 盖过了 `EXECUTING`** —— 续做真的开始了，卡片却说"等待继续"。
3. **同一个 canonical 词在一张卡片上有两种说法**：事实行自己拼了"未通过"，
   而徽标说"没有通过"。现在两者都走唯一一张 `AUTHORITY_FACE` 表。
4. **用户点了"拒绝"之后卡片显示"没有通过"** —— 同一件事的两种说法里丢了
   "是谁决定的"。修成许可被拒优先。
5. **坏读模型的标题被兜底句顶掉**：`failure.text` 是一条读面失败在 transport
   词表里的兜底，把它当标题会把"数据不成形"说成"连不上"。标题改由本地文案定。
6. **`APPROVED` 而最终 DENIED 时什么都不说** —— "你允许了但预算没放行"与
   "这件事自己过期了"在读面上长得一样。现在终态里多一句只有这种情况才有的说明。

另外三处是**测试自身**的缺陷（值得写下来，因为它们都是"看起来绿"的失败形状）：
一条把阈值写成 `>= 4` 而文件里只有 3 处 SVG 来源；一条用"第一个 `});`"夹 COPY
的区间（一点点贪心差异就取到半张表）；一条把"断言检查的文案"写进了它自己
要检查的字符串里。

---

## 13 · 素材说明

本阶段达到视觉要求**没有**需要任何新位图：卡片、图标、空状态全部是 CSS +
inline SVG，角色头像复用既有的 `apiConfigs[].avatar`。
因此**没有需要额外提供的素材**。若将来要给 Economy 做真正的商品封面，
需要的是：正方形、透明背景、≤256×256 的 PNG/WebP，且必须由 store 侧的
product 记录给出 URL —— 那是 Store UI 阶段的事，不属于本阶段。

---

## 14 · 下一阶段建议

`P22-16 · Economy Configuration UI`（P22-14 已经让后端具备配置能力，而浏览器里
还没有人去调 `POST /internal/economy/configuration` 的三条命令）。
`P22-15` 留下的可复用件：`getJson` 只读读取器、`decisionGate` 的 `/security`
读法、以及这一页的三层样式语言。
