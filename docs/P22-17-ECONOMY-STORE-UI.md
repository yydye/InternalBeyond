# P22-17 · Economy Store / Wallet / Inventory UI

基线：`68c6913`（P22-16 收官）。本阶段**零后端改动**：`git diff 68c6913..HEAD -- services/ runtime/` 为空。

交付物一句话：

> Economy 从"三个配置页签"变成**一页真正的门面** —— 概览（钱包 / 预算 / 最近购买 / 最近资产）、
> 商店（货架 + 商品目录）、我的资产（ITEM / COMPUTE），而「待处理」与「设置」仍然
> 由 P22-15 / P22-16 各自渲染。

---

## §1 只读审计（先审计，再实现）

### ① 现有 canonical GET 够不够（逐条对着 §1 的清单）

| 要显示的东西 | 用到的既有只读面 | 结论 |
|---|---|---|
| Wallet | `GET /economy/wallet?ownerId=` | 够：`availableBalanceMinor` / `reservedBalanceMinor` / 三态 `state` |
| Stores | `GET /economy/stores?status=&limit=` | 够：`storeId` / `name` / `description` / `status` / `sortOrder` |
| Products | `GET /economy/products?limit=` | 够：`kind` / `unitPriceMinor` / `unitName` / `grantQuantity` / `assetKind` / `status` / `fulfillment` |
| Inventory | `GET /economy/inventory?ownerId=` | 够：`assetKind` / `quantity` / `productPresent` / `updatedAt` |
| Purchases | `GET /economy/purchases?buyerId=` | 够：四态 `status` / `amountMinor` / `approvalMode` / `productId` |
| Agent Intents / Approval linkage | `GET /economy/intents?limit=` | **够，而且是本阶段唯一的新连接**：intent 带 `agentId` 与 `purchaseId`，于是"这次购买是哪位角色提的"有了可核对的答案 |
| Ledger / Change Log | 未使用 | 见 §3 的说明（这一页**不**从 ledger 重算任何东西） |
| Budget 摘要 | `GET /economy/policy?ownerId=` + `GET /economy/budget?...&amountMinor=0` | 够：限额来自 policy；当日累计来自权威自己的 snapshot |

**结论：一条新 Backend route 都不加。** `/economy/*` 的清单在本阶段前后逐字相同（八条读面
全部是 P22-2 ~ P22-8 已交付并被测试钉住的）。

### ② 缺字段的三类判断（§1 的纪律：只有第 2 类才报告 blocker）

| 想显示的东西 | 属于哪一类 | 处理 |
|---|---|---|
| 商品卡的视觉身份（颜色 / 线稿） | **① UI 可推导的展示信息** | productId 的确定性哈希 → CSS 变量（见 §4） |
| 货架上的"商品数量" | ① 可推导 | 从 canonical 商品列表**数**出来；窗口被截断时退回 null（不显示数字） |
| 购买记录里的"由谁发起" | ① 可推导（两条读面 join） | `intents.purchaseId → intents.agentId → 角色名`；连不上时**什么都不说** |
| 资产行的名字 | ① 可推导 | `inventory.productId → product.name`；`productPresent === false` 时写"已经不存在的商品" |
| "今日已用" | ② canonical 已有、只是没有单独的读面 | 用既有 `GET /economy/budget` 带回来的 `snapshot.spentTodayMinor`（权威自己算的数；**不**从 ledger 重算） |
| **商品详情里的"由 Agent 发起"** | **③ 不存在的业务事实** | canonical 的 Purchase 行**没有** initiator 字段。因此这一页只说**授权**那一面（`approvalMode`），不写"由 Agent 发起"这种它证明不了的话 |
| 商店的"允许购买的商店范围" | ③ 不存在（P22-16 已冻结同一结论） | 不发明 |

### ③ 人类直接购买这条接缝存在吗（§5 的硬要求）

**不存在，而且本阶段不造。** 证据（逐条可核对）：

```text
契约的权限矩阵（services/home-node/economy-contract.js:5731-5741）：
  active_agent_runtime  [PROPOSE_PURCHASE, RESUME_APPROVED_PURCHASE]
  home_node_authority   []
  desktop_bridge        []
  user_decision_seam    [RESUME_APPROVED_PURCHASE]
```

- 没有任何一个 consumer 的能力叫"买"：能到钱的只有 `PROPOSE_PURCHASE`（Agent 提议）与
  `RESUME_APPROVED_PURCHASE`（**在用户已经批准之后**继续那条既有 intent）。
- `user_decision_seam` 刻意**没有** `PROPOSE_PURCHASE`，因此"用户点一下"无法凭空发起一笔购买。
- HTTP 上的三条写面是 `/internal/economy/command`（Agent，来源凭据）、
  `/internal/economy/approval-decision`（用户决定）、`/internal/economy/configuration`（用户配置），
  一条都不是"人类直接买"。`/economy/buy` · `/economy/settle` · `/economy/reserve` 在路由表上是
  **不可达**（http.js 的 `unreachable` 名单里逐字有它们）。

因此商品页**没有购买按钮**，只有一句实话：

> Agent 可以在 Economy 规则允许时申请这里的商品。能不能申请、要不要先问你，由规则与预算决定 ——
> 这一页只显示货架。

### ④ P22-15 / P22-16 的现有结构

- `#page-economy` 的 HTML 只有 `<div id="economy-requests">`；
- P22-16 的外壳运行时**插在它前面**（`page.insertBefore(host, page.firstChild)`），
  于是两个节点稳定落在第 1、2 位 —— 它的视觉测试逐字断言 `children[0]` / `children[1]`；
- P22-16 自己的页签第一个是「待处理」，`paneId === null` 表示"那一块不归我画"。

**本阶段因此只能"追加"，不能"重排"。** 见 §2。

---

## §2 壳层重组（DOM 顺序不变，视觉顺序用 flex order）

```text
#page-economy（.page.active → display:flex; flex-direction:column）
  ├─ [order 2] #economy-configuration   ← P22-16 的外壳（DOM 第 1 位）
  ├─ [order 2] #economy-requests        ← P22-15 的容器（DOM 第 2 位）
  └─ [order 1] #economy-shell           ← 本阶段追加（DOM 第 3 位）
                 ├─ .esh-tabs           ← 五个外层页签
                 ├─ .esh-ownerbar       ← 「这是谁的」（只在需要的格子出现）
                 └─ .esh-panes
                      ├─ #economy-shell-overview
                      ├─ #economy-shell-store
                      └─ #economy-shell-assets
```

三件刻意的事：

1. **DOM 顺序一个字节都没动。** P22-15 / P22-16 的两个节点仍在第 1、2 位，
   它们的结构断言与视觉断言继续成立（P22-16 的 `shellIsFirstChild` / `requestsIsSecondChild` 逐字不变）。
   本模块用 `page.appendChild()` 追加自己的一个节点。
2. **视觉顺序由 flex `order` 决定。** 外层的页签条必须显示在两个被委托的容器**上面**，
   而它们必须留在前面 —— 唯一不改 DOM 顺序的做法就是 `order`。为此
   `#page-economy.active{display:flex;flex-direction:column}`（`.page.active` 是块级，
   选择器优先级 1,1,0 覆盖 0,2,0）；三个子节点的 `margin:0 auto` 在交叉轴上仍然居中
   （auto 外边距吸收自由空间，优先于 `align-items`）。
3. **可见性只有一个状态源。** 页面级 class `ibecon-tab-<key>` 表示当前外层页签；
   「待处理」与「设置」的可见性**全部委托**给 P22-16 自己的 `show()`：

   ```js
   config.show(wantsRequests ? 'requests' : lastConfigSection);
   ```

   于是 `#economy-requests` 的 display 仍然只由 P22-16 那一个状态机管，
   也不会出现"P22-16 的异步读回来之后把待处理重新显示出来"。

`#page-economy.ibecon-tab-settings .ecfg-tab[data-section="requests"]{display:none}`
是**唯一**一处对 P22-16 外观的收纳：它自己的页签条第一个是「待处理」，而那一格现在由外层提供，
所以把它藏起来 —— 一个节点没动，它仍然四个都在（只是其中一个在设置里不显示）。

---

## §3 三个面板

### 概览

| 卡片 | 内容 | 来源 |
|---|---|---|
| IB Credit | 主数字（等宽，千分位）· 币种名 · "IB 内部虚拟额度" · 预留（只在 > 0 时） | `availableBalanceMinor` / `reservedBalanceMinor` |
| 预算 | 单次 / 每日 / 审批线 / 每周 / 每月（**没设的那一档不出现**）+ 今日已用 | `policy.limits` + `snapshot.spentTodayMinor` |
| 最近购买 | 商品名 · 状态人话 · 金额 · 时间 · 授权面 · 发起者（连得上才写） | `purchases` × `products` × `intents` |
| 最近资产 | 最近三条（按 canonical 的 `updatedAt`） | `inventory` × `products` |

**钱包三态是三种形态**（P22-0 R5 的根因所在）：

```text
账户不存在      → 不画数字格 + "还没有额度账户" + 「去设置」
COLD / DEGRADED → 画**破折号** + 一句"为什么这里没有数字"（**绝不是 0**）
READY           → 权威的那个数字
```

保留破折号那一格是刻意的：卡片高度不跳，而且"这里本该有一个数字，只是现在读不到"
比"这一格不存在"更准确。

### 商店

- 货架卡：`name` / `description` / `status` / **商品数量**（从 canonical 商品列表数出来；
  窗口饱和时退回"不显示数字"）/ 「只看这家」；
- 商品卡：`name` / `description` / 类别 / **`unitPriceMinor`** / `unitName` + `grantQuantity`
  （投影成"每份发放 N 件"／SERVICE 是"一次执行"）/ `status` / 确定性视觉身份；
- 「全部 / 各货架」是一排安静的文字 chip，只改这一页看哪些商品；
- **没有购买按钮**，只有 §1 ③ 那句话。

### 我的资产

按 canonical 的 `assetKind` 分两组（**顺序固定：ITEM → COMPUTE**）：

```text
物品       ← ASSET_KIND.ITEM
算力额度   ← ASSET_KIND.COMPUTE
            IB 内部的算力额度（Compute Entitlement），不是任何外部服务的余额或额度。
服务类商品不会留下库存：它是一次执行。   ← SERVICE 的 assetKind 是 null，不伪造库存
```

每行：名字（能 join 就 join）· 数量 + 单位 · 最近变化。组内按 canonical 的 `updatedAt` 排序。

---

## §4 确定性视觉身份（§4 的硬要求）

```js
function hashProductId(productId)  // FNV-1a 32 位
function visualIdentityOf(productId) {
  //  → { variant: 0..5, angle: 0|45|90|135, mark: 0..4 }
}
```

- **函数签名只有一个位置参数**（`visualIdentityOf.length === 1`，测试逐条断言）——
  于是 `buyerId` / 关系 / 亲和度在**结构上**进不来工程。
- 输出只喂给 `data-variant` / `data-mark` 与两个 CSS 变量（`--esh-angle` / `--esh-variant`）。
- **不进价格、不进排序、不进推荐、不进"能不能申请"**：
  - `buildProductModel` 的顺序就是读面给的顺序，纯层里没有任何按 hash 排序的调用；
  - 有一组测试专门证明这件事：故意挑一组"字典序 ≠ 哈希序"的商品，断言渲染顺序 = 读面顺序，
    并断言打乱后的哈希序确实不同（否则那条断言是在为空气作证）；
  - 另有一条：改价格 / 状态 / 货架（`storeId`）之后，脸不变。

---

## §5 测试纪律与资源

| 套件 | 内容 | 资源 |
|---|---|---|
| `test_p22_17_economy_store_ui_core.js` | 纯层（62 项） | child process = 0 · spawn = 0 |
| `test_p22_17_economy_store_ui.js` | 渲染器 + DOM 桩 + 假 driver（62 项） | child process = 0 · spawn = 0 |
| `test_p22_17_economy_store_visual.js` | 真实浏览器（92 项，**不在**默认套件） | spawn = 1 · browser = 1（复用同一个实例跑完全部主题与宽度）· 结束 `Browser.close` + `child.kill` + 删临时 profile |

- 不重跑 P22-6 ~ P22-8 的 crash / race matrix；
- 不启动 Desktop / Electron / DSH / Playwright 多实例；
- 截图落 `%TEMP%\ib-p22-17-shots`，**不写进仓库**（本阶段 PNG 新增 = 0）。

---

## §6 开发期抓到的真实缺陷（都由测试或看图抓到）

1. **归属晚到时整页停在"还没有配置任何角色"。**
   `apiConfigs` 在页面里是**异步**填的，于是 fresh profile 第一次读会以"没有角色"结束；
   角色随后出现时，已经读回来的那一份数据属于"没有归属"。修法是渲染末尾的一次
   **有闸门的自动补读**（`autoSyncOwner()`：只补一次、请求中不重入、不造成循环）。
   纯 Node 测试的 I1~I4 钉住它。
2. **目录在桌面上只有两列。** 我按 `max-width:940px` 推的轨道宽度是错的 ——
   既有 `.page` 是 `max-width:900px` + 左右 32px padding（`assets/css/core/memory.css:4`），
   三个兄弟容器拿到的都是 **836**。浏览器里量出来之后把最小轨道改成 220/240px，
   现在桌面 3 列、手机 1 列，并且有两条断言钉住真实列数。
3. **文字按钮在深色主题里"浅灰压浅灰"。** 它原来铺了一层 `rgba(255,255,255,.12)`，
   在 infernal 下把 muted 的字压得几乎看不见。改成不铺底（一条边框 + 一行字），
   并把判据从"底色必须是透明的"换成 **WCAG 对比度**（按钮 ≥ 4.0、说明文字 ≥ 3.0）——
   后者在浅色主题里给出的是正确的绿，而前者会造出一条假红。
4. **十字线稿转 45° 读成了"错误叉"。** 商品卡的第 2 号线稿被旋转 45° 之后，
   在真实截图上看起来像一个"关闭 / 坏掉了"的图标 —— DOM 断言全绿也看不见这件事。
   改成 15° + 轻微缩放。
5. **`auto-fit` 的 computed `gridTemplateColumns` 会把折叠的空轨道也列出来**，
   直接数空格会把三档限额数成 4 列。改成数**真实位置**（同一 top 上有几格）。
6. **主题身份必须在同一处断言。** 只比较"两套主题的颜色不同"是不够的：
   它可能是"断言读的是一个状态、截图读的是另一个状态"。现在每一轮都断言
   `body` 上的主题 class 就是这一轮期望的那一个。

---

## §7 视觉检查结果（92 项断言 + 14 张图人工看过）

```text
2 主题 × 3 宽度  ·  概览页          6 张
2 主题          ·  商店页（桌面）    2 张
2 主题          ·  资产页（桌面）    2 张
空库存 / 空目录 ·  桌面              2 张
待处理 / 设置   ·  桌面              2 张
商店 / 概览     ·  手机              2 张  （长图，captureBeyondViewport）
```

真实排版引擎上断言的东西（摘）：

- 页面是 flex 主轴、外壳在、概览在最上面、两个被委托的容器都收起；
- 文档与面板都无横向溢出（三档宽度各一次）；
- 卡片不会横跨整个屏幕（有内容最大宽度）；
- 余额是 `tabular-nums`，且字号 ≥ 说明文字的 1.35 倍、≤ 30px；
- **预算三档在桌面上并排一行**、手机上最多两列；
- **目录网格桌面上 ≥ 3 列**、手机上 1 列（实测 792px → 3 × 256px）；
- 每一张商品卡都有 `data-variant` / `data-mark`，CSS 变量真的落到元素上，
  且**不同的 variant 真的算出不同的 `background-image`**（≥ 3 种）；
- 购买与资产那两行的名字用的是**同一个**前景色；
- 「重新读取」与说明文字的对比度在两种主题下都成立；
- 图标全是 inline SVG，页面上没有一个位图；
- 没有任何覆盖视口的模糊层压在页面上；
- `#economy-requests`（P22-15）与 `#economy-configuration`（P22-16）在各自的页签里
  仍然正常渲染，外壳的页签条在它们**上面**；
- 「设置」里 P22-16 自己的页签条只剩三个可见，而且它的配置面板真的读到了权威；
- `/economy/*` 上的写请求全程 **0**。

---

## §8 Stop Gate（§13 的十二条）

1. **用户能看到真实 Wallet？** 能。`availableBalanceMinor` 原样显示（等宽 + 千分位），
   三态各有各的话，`reserved` 只在 > 0 时出现。
2. **能浏览 Store / Products？** 能。三张货架卡 + 五件商品卡按列铺开，可按货架收窄。
3. **能看到自己的 Inventory？** 能。按 `assetKind` 分两组，名字 / 数量 / 单位 / 最近变化。
4. **能看到 Purchase History？** 能。四态人话 + 金额 + 时间 + 授权面 + （连得上时的）发起者。
5. **金额 / 库存 / 状态都来自 canonical？** 是。八条既有 GET；这一层不算任何经济事实，
   也不从 ledger 重算任何数字。
6. **UI 完全没有 raw Ledger / Mint / Transfer / Refund 权限？** 是。渲染器里没有 `fetch`，
   纯层里没有那些名字，两个写方法（`approvalDecision` / `economyConfiguration`）一次都没被调用。
7. **Compute 仍只是 IB 内部 entitlement？** 是。只有一句话，而且测试禁止 Provider / token 字样。
8. **没有偷偷造 human direct-buy seam？** 没有。证据见 §1 ③。
9. **P22-15 / P22-16 不回归？** 纯 Node 套件（62/62 · 55/55 · 60/60 · 59/59）**一行都没改**；
   两个视觉套件各只增加了一类调用（把外层页签切到它们那一格），一个断言都没改。
10. **`/economy/*` write 仍为 0？** 是（假 driver 与真浏览器两条路径各断言一次）。
11. **Internal / Infernal / mobile 真的看过？** 14 张图逐张看过（§7）。
12. **child / spawn / browser / leftover？** 非视觉测试 **0 / 0 / 0**；
    视觉测试 **0 / 1 / 1**（一次 Chrome，跑完全部主题与宽度，结束明确关闭）；
    结束时与本阶段相关的浏览器进程 = 0，临时 profile = 0。

---

## §9 已知的、由别的阶段拥有的观察

1. **P22-16 的配置面板也会遇到同一条"归属晚到"的路径**：它的 `view` 是页面打开时
   （角色目录还空着）读回来的那一份，而它的 `show()` 在 `stage !== 'idle'` 时不会重读，
   因此需要用户点一次「重新读取」。**本阶段不修**（P22-17 只碰外壳，改它会动 P22-16 的实现
   与它的测试）；本阶段的 `autoSyncOwner()` 是**只属于外壳**的那一份修法，
   两条路径不共用状态。
2. **千分位只在 P22-17 的三块里有**（"12,450.00"）。P22-16 的配置卡显示的是
   "12450.00 IB Credit" —— 那是它自己的格式化，本阶段不改它的文件。
3. **`NEEDS_GENERATED_ASSET`：无。** 14 张图看过之后，这一页不需要氛围图或大型资产图：
   商品卡的确定性视觉身份 + 三张 160×120 的空状态线稿已经够了，再加图会让它从
   "安静的内部资源系统"变成"商城"。

---

## §10 全量运行的真实结果（含一次**已知**抖动，写在这里而不是删掉）

```text
node tests/test-all.js --quick          # 提交后
  static  112 项 · 370.6s · 1 失败
  p22-ui    6 项 ·   3.2s · 全部通过
```

三次全量运行的实际图景（按仓库纪律 §12：失败的**重跑要留痕**）：

| 运行 | 结果 | 红项 | 定性 |
|---|---|---|---|
| #1（改动中，未提交） | static 2 失败 | `test_astra_readiness_observe.js` 的 `Z1.noProductionFileChanged` + 1 项 | Z1 是"工作树里不许有未提交的生产改动"这条守卫 —— 改动还没提交时它**必然**红 |
| #2（未提交） | static 1 失败 | 只剩 Z1 | 与 #1 同一棵树，另一项那条没有再现 ⇒ 抖动 |
| #3（**已提交**） | static 1 失败 | `test_role_dm_smoke.js` | **已知 flake**，见下 |

**`Z1` 已在提交后单独复跑通过**（`node tests/test_astra_readiness_observe.js` → `PASS Z1.noProductionFileChanged`，
`0 failed`）—— 它的语义就是"提交干净"，因此它在本阶段的正确读数是"提交后为绿"。

**`test_role_dm_smoke.js` 是**本仓库已记录的**时序敏感 flake，不是 P22-17 引入的：**

- 失败点逐字相同：`✗ 4) run 完成并产生 2 轮` → `✗ 恰好两次模型调用` → 1.7s 就停；
- `docs/P22-5-ECONOMY-STORE-INVENTORY.md` §23（:1253-1263）已经记录过**同一条测试、同一个失败点**，
  结论是"时序敏感的一次 flake"，并把"某个浏览器 smoke 在大批量串行运行时会偶发失败"写成了
  一条应当被知道的事实；
- 决定性证据：**#2 与 #3 之间，`InternalBeyond.html` 与 `assets/js/*` 逐字节相同**
  （中间只多了一次 `git commit` 与两个 **测试文件**的 BOM 补回），而它一次过、一次不过；
- 本轮单独复跑 **5 次**：`结果: 41 通过, 0 失败`（每一次）。

