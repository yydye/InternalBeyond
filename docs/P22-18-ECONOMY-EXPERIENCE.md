# P22-18 · Economy Experience Polish & Read-only Analytics

基线：`8edcb34`（P22-17）。提交信息：`P22-18 · add Economy experience polish`。

这一阶段的目标只有一句话：

> **让用户理解 Economy 当前发生了什么。**

它不扩任何经济能力。`git diff 8edcb34..HEAD -- services/ runtime/` **为空** ——
后端一个字节都没有动。

---

## §1 · 先只读审计（这一节没有写任何 UI 之前就做完了）

### 1.1 §1 列出的十二条既有 GET，够不够？

逐条回答"这个区域靠什么回答"，并给出**分类**：

| 需要的区域 | 靠哪些既有读面 | 够不够 | 分类 |
|---|---|---|---|
| Economy Overview | `/economy/wallet` + `/economy/policy` + `/economy/budget` + `/economy/inventory` | 够（P22-17 已经在做） | — |
| Wallet Summary 的**最近变化** | `/economy/wallet` 只说**现在**有多少，**没有任何历史** | 不够 | **B** |
| Activity Timeline（"为什么这里多了一笔变化"） | **`/economy/changes`** | 够 | **B** |
| Spending explanation | `/economy/purchases` + `/economy/budget` 的 snapshot | 够 | — |
| Agent request explanation | `/economy/intents`（`reason` / `units` / `state` 全在这一行上） | 够 | — |
| Approval history | `/economy/approvals`（当前状态）+ change log 的 `APPROVAL_*`（历史） | 够 | — |

### 1.2 B 类：canonical 已存在但没被展示 —— **但仍然没有新增一条 GET**

这一阶段真正缺的那一样是**历史**，而 canonical **早就有**它：

```text
GET /economy/changes          ← P22-1 就交付的只读面
  { ok, changes:[{ revision, kind, entityId, transactionId, walletId, at, payload }], revision }
```

它不在 §1 那份名单里，**但它是一个已经存在并被测试钉住的路由**，不是本阶段加的。
§2 逐字说"如果已有 change log：复用"—— 它真的有，于是**复用**，而不是从
`purchases` / `intents` / `approvals` 自己拼一个"看起来像时间线"的东西。

为什么拼接会更差（这一条决定了设计）：change log 里有一整类**没有自己一张表**的事件 ——
`RESERVATION_CREATED`（锁了一笔额度）、`QUOTE_EXPIRED`（报价失效）、
`BALANCE_REBUILT`（余额按账本重算）、`ECONOMY_INITIAL_CREDIT_BOOTSTRAPPED`（初始额度）。
自己拼会把它们**全部丢掉**，于是"为什么这里多了一笔变化"正好答不上来 ——
而那正是时间线唯一的用途。

因此本阶段对后端的改动是 **0**：没有新表（**没有 `economy_events`**），
没有新路由，没有 `POST /economy/*`。

### 1.3 A 类：UI 可以推导的（这一阶段真的推导了这些）

| 事实 | 怎么来的 |
|---|---|
| 已完成支出合计 | `purchases` 里 `status === COMPLETED` 的 `amountMinor` **整数相加**（不经过浮点） |
| 每条购买的"来源" | 由 `intent` / `approval` / `purchase` 三张记录的**存在与状态**连出来 |
| 时间线上的条数 / 归属不到的条数 | 数出来的 |
| 时段显示（`HH:MM`） | canonical 毫秒 → 本地排版（**只**影响显示） |
| 商品名、资产名 | `productId` 与 `/economy/products` join；join 不上写"已经不存在的商品" |

### 1.4 C 类：根本不存在 —— **禁止创造，逐条点名本阶段没有造**

```text
Agent 心情导致购买概率        ✗ 没造
用户价值评分                  ✗ 没造
消费能力评分                  ✗ 没造
关系影响指数                  ✗ 没造
增长率 / 收益率 / 资产价值     ✗ 没造（测试逐词断言它们不出现）
economy_events 表             ✗ 没造
```

这六条不是"还没做"，而是**这一层的定位不允许**：解释层只搬运 canonical 已有的事实。
一旦它开始计算"消费能力"，页面上就出现了第二个权威，而它与 canonical 冲突时
用户没有任何办法判断哪个是真的。

---

## §2 · Economy Overview（复用 `#economy-shell-overview`，**没有新增页面**）

§2 的四个区域全部落在同一格里，顺序是按"用户会先问什么"排的：

```text
#economy-shell-overview
  ① IB Credit            Wallet Summary（余额 + 其中已被预留 + 归属 + 最近变化）
  ② 活动时间线            Activity Timeline
  ③ 经济活动              §3 的购买记录升级（商品 / 金额 / 状态 + 来源 + 三步）
  ④ 预算                  既有（P22-17）
  ⑤ 支出说明              Spending explanation
  ⑥ Agent 为什么提出请求   Agent request explanation（§4）
  ⑦ 我的资产              既有（P22-17）
  ⑧ 高级信息              §7 的折叠区
```

**Wallet Summary 的"最近变化"**：来自时间线里**最近一次真的动了钱**的那一条
（tone 是 `money` 或 `hold`）。一条都没有时说 **"暂无记录"** —— 那是事实；
说"没有变化"是一个**结论**，而这一层不做结论。

**明令不显示的**：增长率、收益率、资产价值（测试逐词断言）。

---

## §3 · Activity Timeline

### 3.1 它是解释层，不是事件系统

每一行都能**指回去**一条 canonical 记录：`revision` 是序列号，`refs` 是那条记录
自己带的编号（`agentIntentId` / `approvalId` / `purchaseId` / `quoteId`）。
一行长这样：

```text
15:23   购买完成                     为这次购买锁住额度   5.00 IB Credit
15:22   你允许继续
15:21   Agent 提出购买请求            ×1
15:46   报价失效                     8.00 IB Credit
```

### 3.2 顺序按 **revision 倒序**，不是按毫秒

canonical 的 revision 是**单调分配**的，因此同一毫秒里发生的两件事也有确定的先后；
时间只用于显示。`at` 只参与"当 revision 缺失时"的兜底排序。

### 3.3 归属：用 canonical 自己的键比出来（这是整节的难点）

`/economy/changes` **没有 ownerId 参数** —— 它给的是整台设备的变化。一个按角色
显示的页面必须自己筛，而筛法只有一种是对的：

| 用的键 | 从哪来 |
|---|---|
| `change.walletId` | canonical 写下这条变化时就带着它（钱包那一格里就有这个值） |
| `payload.ownerId` / `payload.buyerId` / `payload.agentId` | 三个都是**当事人 id 本身**，逐字比较 |
| `payload.wallets[].walletId` | 账本交易的两端 |

**刻意不算的一条**：`recipientId`。一次"买给别人"是**买家**的钱动了，收礼的人
余额没有变化 —— 把它算进来会让收礼者的时间线上出现一笔"我没有变过的余额变化"，
而那正是这一页要避免的误导。这条有一个**否证式**断言（C4）。

归属不到的变化**不进时间线**，并且被计进 `unattributed`（一个可以被读出来的数，
而不是被静默丢掉）。

### 3.4 走到末尾地读（否则会给出**最旧**的一段）

canonical 的分页语义是：

```text
listChanges(cursor, limit) → WHERE revision > cursor ORDER BY revision ASC LIMIT limit
```

也就是**从最早的往新的**给。只取第一页会在记录超过一页时给出**最旧**的 500 条，
而"最近什么都没发生"正是这一格最不能犯的错。

因此外壳**走到末尾**：每次 500 条（canonical 自己的上限），短页即终点，
最多 6 页。被上限挡住时 `truncated: true`，页面**必须说出来**：

> 这台设备的活动记录比这一页读出来的多，因此这里不是全部。

（真实浏览器里的这条路径只有一种走法 —— 让假节点每页真的返回 500 条，
于是外壳必须翻满 6 页才发现自己被挡住。测试就是这么做的。）

---

## §4 · 购买记录 → 「经济活动」（§3）

每条记录四样东西，逐字对应 §3 那张图：

```text
商品 / 金额 / 状态      ← canonical 的 Purchase 行
来源                    ← Agent 提议 · 用户批准 · 系统完成（**各有证据**）
时间线                  ← Intent → Approval → Purchase（各有 canonical 时间）
```

**"来源"是连出来的，不是写死的三行。** 每一个词都要一条证据：

| 词 | 证据 |
|---|---|
| Agent 提议 | 有一条 intent 的 `purchaseId` 命中这次购买（`agentId` 认得出来时再补一句"由 阿尔法 发起"，**绝不**打印 id） |
| 用户批准 | `purchase.approval.status ∈ {APPROVED, CONSUMED}` 且 `decidedBy` 以 `user:` 开头 |
| 按自主规则放行 | `approvalMode === 'AUTO_ALLOW'`（与"用户批准"**互斥**） |
| 系统完成 | `purchase.completed === true` |

于是：一次自主放行的购买**不会**显示"用户批准"，一次没完成的购买**不会**显示
"系统完成"，一条连不上 intent 的购买**什么都不显示**。

**三步各有 canonical 的时间**：Intent 用 `intent.createdAt`；Approval 用
`purchase.approval.decidedAt`，没有时退回 change log 里那条 `APPROVAL_APPROVED/REJECTED`
的 `at`（Purchase 行上**没有**"什么时候被决定的"这个事实，只有"决定成了什么"）；
Purchase 用 `completedAt ?? createdAt`。

**三步"没有发生"的三种原因措辞各不相同**（同一句"无"会把它们混成同一个答案）：

```text
这条记录早于授权层                      ← approvalMode === null（旧行）
按自主规则直接放行，因此没有产生一条决定记录  ← AUTO_ALLOW
没有对应的记录                          ← 真的读不到
```

**顺序是 canonical 的 `createdAt` 倒序**：canonical 的列表是 `ORDER BY created_at ASC`，
也就是说它先给**最早**的；而这一格要的是"最近发生了什么"。这个反转发生在纯层，
并且**只**按 canonical 的时间。明细有上限（`ACTIVITY_KEEP = 6`），超出时**说出来**，
而完整的历史在时间线里。

---

## §5 · Agent Intent 解释卡（§4）

```text
数字绘画额度                         已经完成
原因
  用于生成更多视觉素材，这一批分镜需要 1 份。
数量
  1
```

**限制逐字落实**：`reason` 由提出请求的 Agent 写下，本层**逐字搬运** ——
不摘要、不改写、**不再调模型**。这不是一句文档承诺，而是模型的形状：

```js
reasonIsVerbatim: true, reasonSummarizedByAi: false, reasonIsAuthority: false
```

以及一条断言：带前后空格与换行的理由**逐字**出现在 DOM 里（`textContent`，
因此连换行都不会被解释成结构）。为什么这一条必须硬：一次摘要会让页面上出现
**第二份解释**，而两份不一致时用户没有任何办法判断哪一份是真的。

没有写下原因时说的是 **"这次请求没有写下原因"**，而不是一个空白。

---

## §6 · Economy Audit View（§7）

`高级信息`，**默认折叠**，里面**只有四个编号**：

```text
数字绘画额度   econ_agent_intent_1  econ_approval_1  econ_purchase_1  econ_quote_1
算力包         —                    —                econ_purchase_2  econ_quote_2
算力包         econ_agent_intent_9  econ_approval_2  —                —
```

**刻意不放的**（§7 明令）：数据库行、账本内部结构、`revision`、迁移状态。
模型的四句自述就是这条承诺的形状：

```js
showsDatabaseRows: false, showsLedgerInternals: false,
showsRevision: false, showsMigrationState: false
```

两条实现上的事：

① 它的**体内带 `esh-technical`** —— canonical 的编号按定义属于"折叠的技术层"
   这一类，而 P22-17 那条"正文里没有原始代号"的纪律正是以这个 class 为界的。
   本阶段不放开那条纪律，只把这一格放进那一类里。
② 窄屏（≤880px）四列会堆成一列、表头也因此藏起来，于是**每一格自己带一个
   "它是哪一种编号"的前缀**（`data-k` + `::before`，DOM 里没有多一层）。
   —— 只有四个裸 id 的"高级信息"是没法用来排查的，这一点是**在 320px 的
   真实截图上**发现的。

---

## §7 · Configuration UI 的两句话（§6）

P22-16 的配置面只加**话**，不加输入、不加按钮（有一条断言判这一点）：

```text
「预算限制」  这是限制，不是余额。
              它决定这位角色一次能动用多少上限，不表示它现在有多少。
              ← 放在**刻度之前**：用户最容易把这一格的数字读成"我还有多少"

「自主购买」  启用自主购买 ≠ 绕过审批。
              它只回答"要不要先问你"这一个问题……余额、预算、商品状态与报价
              仍然各自判定，任何一样不通过，这次购买都不会发生。
              ← 放在**表单之前**：误解是在拨开关的那一刻形成的
```

**明令禁止的三样没有加**：自动充值、自动增加额度、自动扩大预算。

---

## §8 · Approval UI（§5）：按"禁止"执行

§5 的实质是三条禁令，本阶段逐条遵守并有断言：

```text
approvalDecision()          ✗ 没有改（P22-15 的实现一个字节都没动）
approveAll / autoApprove /
batchApprove                ✗ 全仓浏览器侧经济文件里一个都不存在
新增写入口                   ✗ 没有
```

§5 允许的"视觉优化"落在本阶段**自己的**新面上（时间线、来源、三步），
而不是去改 P22-15 的卡片 —— 改它会同时动它的实现与它的四条测试，
而那与"零回归"这条硬要求直接冲突。

---

## §9 · 视觉（§8）

`IB 风格`：玻璃、安静、克制、柔软。**不**是银行后台 / 财务软件 / 游戏商城 /
加密钱包。时间线只用**一个**颜色变量（`--esh-tone`），七个语气各一张线稿：

```text
money → ledger    hold → hold     ask → ask        decision → check
asset → asset     rule → rule     fail → cross     note → dot
```

- 图标**全是** inline SVG（`circle` / `check` / `clock` / `arrow` / `line`）。
  **没有** emoji、**没有**外链图片、**没有** CDN icon、**没有** PNG（断言逐条判）。
- 轨是 CSS 的一根 1px 线 + 圆点里的 SVG。★ 它按**这一条自己的语气**着色 ——
  第一版用的是 `--border-soft`，在深色主题里几乎全透明，那一列于是只剩圆点、
  **没有连线**。这是**在真实截图上**看出来的，纯 Node 测试看不见。
- 数字一律 `tabular-nums`。

---

## §10 · Mobile（§9）

320px / 375px / 390px 三档，2 主题 × 4 宽度 = 8 轮：

| 检查 | 结果 |
|---|---|
| 没有横向滚动 | ✔（文档与面板都不超过视口） |
| Timeline 是否折叠 | **不折叠任何一条** —— 10 条各自成行，只是头部换行 |
| 卡片是否撑爆 | ✔ 每一条的宽度都不超过可用宽度 |
| 数字是否换行 | ✔ 余额那一格仍然等宽、≤26px |
| 按钮高度 | ✔（`.esh-actions` 在窄屏是整行主按钮） |
| 展开编号之后 | **仍然**没有横向滚动（长 id `overflow-wrap:anywhere`） |

三步在窄屏上**一步都没少**（只是竖过来），因为它们是这一格的解释力所在。

---

## §11 · 测试

```text
test_p22_18_economy_experience_ui_core.js     63 项   零子进程 · 零 socket · 零浏览器
test_p22_18_economy_experience_ui.js          52 项   同上（DOM 桩 + 假 driver）
test_p22_18_economy_experience_visual.js     156 项   真浏览器（**一个** Chrome 复用到底）
```

纯层测试里最强的那一条是 **B2**：canonical 的 `EVENT_TYPE` 名单是**从契约源码里
抽出来的**（正则扫 `services/home-node/economy-contract.js`），store 里那两个字面量
事件（`BALANCE_REBUILT` / `ECONOMY_INITIAL_CREDIT_BOOTSTRAPPED`）是从 store 里抽的，
然后逐个断言"这里有答案"。于是"某个事件类型在页面上没有话"这件事会当场变红，
而不是悄悄退化成一句"未知变化"。B4 判反向：表里的键**一个都不是编的**。

### 资源

```text
非视觉测试    child_process = 0 · spawn = 0 · socket = 0 · 浏览器 = 0
视觉测试      spawn = 1（一次 Chrome）· browser = 1（复用跑完全部 156 项）
结束时        Browser.close + child.kill + 重试删除临时 profile
测试后遗留    调试浏览器进程 = 0（Get-CimInstance 逐条核对）
              ib-p22-18-chrome-* 临时 profile = 0（第一次留下过一个，已修）
仓库里新增 PNG = 0（截图全在 %TEMP%\ib-p22-18-shots）
```

---

## §12 · ★ 唯一一处"上一阶段的断言"改动（必须报告）

本阶段改了 P22-17 的一条测试（`tests/test_p22_17_economy_store_ui.js`），
**两条断言**，理由各自如下。P22-15 / P22-16 的六个套件**一行都没有动**。

### ① `G1`：`Array.from(new Set(paths)).length === 8` → `=== allowed.length`

§2 要求复用 canonical 的 change log，于是这一页的读面从八条变成九条。
写死的 `8` 会把"这一页多读了一条**已声明的**只读面"判成红的，而那条真正的性质
（"请求的每一条路径都在声明表里"）并不需要那个数字。改成 `allowed.length` 之后，
这条断言在下一个阶段再加读面时**仍然在问同一个问题**。

`READS` 本身**没有动**（仍是 P22-17 的八条，A4 逐字钉住），第九条另立为
`CHANGE_READ` —— 两个集合各自可被读出，而不是把 8 偷偷改成 9 让上一阶段的断言
换一个含义。

### ② `C6`：`.esh-row` 计数 5..7 → 不变量

原判据隐含了 P22-17 的两个决定：①「最近购买」那一块最多铺三条；②那三条用
`.esh-row`。§3 把这一块升级成「经济活动」（多了"来源"与三步），于是它换了类名、
并且有自己的上限常量（`ACTIVITY_KEEP`）。那个 `5..7` 因此不再表达任何东西 ——
它还会因为"已完成购买多了一条"而随机变红。改成**不变量**：明细有上限、
上限就是常量、资产那一格最多三条。

### 没改但验证过的

- P22-17 的 `C5`（"由 阿尔法 发起"）**没有改**：本阶段把角色名放进了"来源"那一行，
  于是 H3 的性质逐字保留（说出来的是**角色名**，不是 id）。
- P22-16 的两个视觉断言（`shellIsFirstChild` / `requestsIsSecondChild`）逐字成立：
  三个节点的顺序仍是 `#economy-configuration` / `#economy-requests` / `#economy-shell`,
  本阶段只**追加**第三个。P22-18 的 UI 测试里有一条断言把这个顺序钉住。

---

## §13 · Stop Gate

1. **用户能理解 Economy 当前状态？** 能。同一格里有：多少额度（权威那个数）、
   预算上限与今日已用、最近一次变化、按时间排开的全部活动、每一次购买是怎么来的、
   支出合计、Agent 的请求与理由。
2. **能看到资金变化原因？** 能。时间线读的是 canonical change log（不是 UI 拼的），
   每一行都带 `revision` 与可指回的编号；"最近变化"取的就是最近一次真的动了钱的记录。
3. **能理解 Agent 为什么提出请求？** 能，而且**只有** Agent 自己写下的那一句 ——
   逐字、不摘要、不重写、不再调模型。
4. **能追踪 Intent → Approval → Purchase？** 能：每一条购买都有三步各自的状态与
   canonical 时间；连不上的那一步会说出**为什么**连不上（三种原因措辞不同）；
   三个编号在「高级信息」里可以直接查。
5. **所有事实来自 canonical read authority？** 是。九条既有只读面，零新增路由。
   这一层不算任何经济事实，唯一的"加法"是支出合计，而它在页面上逐字自述
   "这个合计是这一页把列表里的金额加起来的"，并且与权威的当日累计**并排**显示。
6. **没有新增经济写入口？** 是。`/economy/*` 上仍然只有 GET；整个过程中
   假 driver 与真浏览器两条路径各断言一次"写请求 = 0"。
7. **没有扩大 Agent 权限？** 是。`proposeAgentPurchaseIntent` 与本层无关；
   商品页仍然**没有**购买按钮，页面上没有"申请"按钮（有一条断言）。
8. **没有引入支付 / 兑换 / 退款？** 是。源码里连那四个词都不出现
   （A7 逐词断言），没有新表、没有新路由、没有新方法。
9. **三个已有 UI 零回归？** P22-15（62/62 · 55/55 · 视觉 66/66）与
   P22-16（60/60 · 59/59 · 视觉 86/86）**一行都没改**；
   P22-17（62/62 · 62/62 · 视觉 92/92）只有上面 §12 那两条断言按新设计改过。
10. **child / spawn / browser / leftover？** 非视觉 **0 / 0 / 0**；
    视觉 **0 / 1 / 1**；遗留调试浏览器进程 0、临时 profile 0、仓库新增 PNG 0。

**素材**：`NEEDS_GENERATED_ASSET` = 无。7 张截图逐张看过之后，这一页不需要
氛围图或大型资产图 —— 它是"AI 世界里的资源面板"，不是海报。
