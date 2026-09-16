# P22-16 · Economy Configuration UI

> 基线：`46864b5`（P22-15C）
> 本阶段只有一个目标：**把 P22-14 已经存在的 Economy Configuration 能力做成真正可用、好看、低门槛的 UI。**
> 不扩 Economy Backend，不造第二套配置 / 预算 / 自治逻辑。

---

## §1 只读审计（先审计，再实现）

审计结论逐条来自读代码，没有一条来自提示词假设。

### ① `POST /internal/economy/configuration` 的真实契约

`services/home-node/economy-configuration.js`

| 项 | 事实 | 位置 |
|---|---|---|
| 路径 | `/internal/economy/configuration` —— 刻意**不在** `/economy/` 下（那里全是只读 GET） | `:101` |
| 信封 | 恰好三个顶层键 `{ command, config, idempotencyKey }`，多一个即拒 | `:125` |
| 命令 | 封闭三词 `BOOTSTRAP_CREDIT` / `PUT_BUDGET_POLICY` / `PUT_AUTONOMY_POLICY` | `:110-117` |
| `config` 白名单 | 见下表 | `:137-147` |
| 身份键 | `actor / caller / consumerId / decidedBy / capability / approved / token …` 逐名拒绝 | `:155-160` |
| 凭据 | loopback + `X-IB-Home-Token`（或 Bearer），恒定时间比较；未配 `IB_HOME_NODE_TOKEN` → **503**；非 loopback → 401 | `:618-638` |
| 响应 | 成功 200 且带 `configuredAnything: true` + 一串**真的** mutation 位；失败 `{ok:false, refused:true, reasonCode, reachedStore}` | `:402-419` |

`config` 键白名单：

```text
BOOTSTRAP_CREDIT       ownerId · currency · amountMinor
PUT_BUDGET_POLICY      ownerId · currency · limits · termEndsAt · autonomyLevel · ifRevision
PUT_AUTONOMY_POLICY    ownerId · enabled · perPurchaseLimitMinor · dailyAutonomousLimitMinor ·
                       approvalAboveMinor · allowedProductKinds · allowedSettlementTypes ·
                       allowGift · ifRevision
```

### ② `BOOTSTRAP_CREDIT`

一次性事实是 canonical `economy_meta` 行 `bootstrap-credit:<ownerId>:<type>:<currency>`；事务外读一次、写锁内再读一次（`economy-store.js:3323 / 3366`）。二次请求 → `INITIAL_CREDIT_ALREADY_BOOTSTRAPPED`（409，`:3339`）；只有**逐字重放**（同金额，且幂等身份由 owner+currency 派生）才 `ok:true + replayed`。`currency` 必须是 `IB_CREDIT`，否则配置面直接拒（`economy-configuration.js:430`）。

### ③ `PUT_BUDGET_POLICY`

`store.putBudgetPolicy`（`economy-store.js:5790`）。`limits` 走 `normalizePolicyLimits`（`economy-contract.js:2069`）：接受 `BUDGET_LIMIT_KEYS` 十个键 + `cooldownMs`；有持久化列的是 `perTransactionMinor / dailyMinor / weeklyMinor / monthlyMinor`（`POLICY_LIMIT_TABLE :1988`），外加 `approvalThresholdMinor`（落到 `approval_above_minor`，`economy-store.js:5773`）。`termEndsAt` = 非负 safe integer；`autonomyLevel ∈ {NONE, LIMITED, STANDARD, ELEVATED}`。版本化更新 + 可选 `ifRevision` 乐观并发。**政策写入不是经济运动**：`ledgerMutation` 恒 false。

### ④ `PUT_AUTONOMY_POLICY`

`store.putAutonomyPolicy`（`economy-store.js:10219`）→ `validateAutonomyPolicy`（`economy-contract.js:4216`）：

* `enabled` 必填 boolean；
* `perPurchaseLimitMinor` / `dailyAutonomousLimitMinor` **必填**，且 per ≤ day（`:4242`）；
* `approvalAboveMinor` 可选，**缺省 = perPurchase**，且不得高于 perPurchase（`:4259`）；
* `allowedProductKinds ∈ {DIGITAL_ITEM, CONSUMABLE, API_QUOTA, COMPUTE_CREDIT, SERVICE}`；
* `allowedSettlementTypes ∈ {INVENTORY_GRANT, COMPUTE_GRANT, SERVICE_EXECUTION}`；
* 两个选集**缺省为空集**（= 不自主买任何东西，fail closed）；显式空数组**被拒**（`:4265 / :4274`）；
* `allowGift` 可选 boolean。

**两条必须报告的审计发现：**

> ★ §4 逐条要求表达「允许购买的商店范围」，而 **canonical 契约里没有这个字段** —— 全仓没有 store-scope / store allowlist。因此 UI 上**没有**这个控件，并且用一句实话把这件事说出来（页面上那条 `.ecfg-note`）。**没有发明一个字段。**

> ★ `evaluateAutonomousPurchaseFor` 用 `autonomyPolicyForOwner(buyer.party.id)` 查策略（`economy-store.js:10521`），而 intent 的 buyer 就是 `intent.agentId`（`:11749`）—— 也就是**角色**。因此自主与预算策略挂在角色上才生效；把政策挂到 `user:user` 上对 Agent 购买无效，那会是一个假象。**这就是「配置对象」是角色的原因。**

### ⑤ 当前可复用的只读数据

| 读面 | 给出 |
|---|---|
| `GET /economy/wallet?ownerId=&currency=` | `state / balanceKnown / cached / ledger / reserved / available BalanceMinor / revision`。**没有 spent today。** |
| `GET /economy/policy?ownerId=` | `limits / termEndsAt / autonomyLevel / status / revision` |
| `GET /economy/autonomy-policy?ownerId=` | 全部自主字段 + `revision`（保存时直接带 `ifRevision`） |
| `GET /economy/budget?ownerId=&currency=&amountMinor=` | `decision` + `snapshot{ spentTodayMinor, spentThisWeekMinor, spentThisMonthMinor, availableBalanceMinor, policyId, walletState }`。**唯一能读到"已用"的读面** → 刻度条能做真进度。两个限制：必须给 `amountMinor`（`http.js:1493`），钱包不存在时 `snapshot` 为 null。`snapshot.policyLimits` 存在但**未被序列化**，所以"上限"要另读 `/economy/policy` |
| `GET /security` | `economyPolicy.configuration.{open, implemented, configurationCommandsExposed}` —— **配置面开不开的唯一权威自述** |

> ★ **审计发现的缺口**：store 有 `getInitialCreditBootstrap`（`economy-store.js:3512`），但全仓**没有任何路由**暴露它（`http.js` 对它 0 引用）。因此 UI 无法从 authority 直接读"这个 owner 的初始额度发过了没有"。
> 有一条**结构性**的事实可以替代它：`openWallet` 全仓只有**一个**调用方（`economy-store.js:3382`，就在 `bootstrapInitialCredit` 的事务里）⇒ 生产里 `(owner, IB_CREDIT)` 钱包存在 ⟺ 初始额度已发过。
> **用户拍板：不扩后端**，走这条既有读面，并用测试把这条耦合逐字钉在 store 的源码上（`ui` 测试的 B1）。

### ⑥ P22-15 现有 seam

* DOM：`InternalBeyond.html:2443` —— `<div class="page" id="page-economy"><div id="economy-requests"></div></div>`，容器刻意是空的，整页由 JS 渲染；
* 导航：`assets/js/core.js` 的 `navTo('economy')` 里那一行；
* 纯层 `assets/js/economy-approval-core.js`（`NS.economyApprovalCore`）、渲染层 `assets/js/economy-approval.js`（`NS.economyApprovalUI`，无 `fetch`）；
* CSS `assets/css/economy-approval.css`：`<link>` 运行时注入，不占 HTML 的 20 个样式表预算；
* client seam `assets/js/home-node-client.js`：`_request`（唯一 HTTP 实现）、`approvalDecision()`（白名单构造三字段）、`getJson(path, query)`（钉死 GET）。

### ⑦ 可复用的配置卡片

有同类**做法**可复用（注入 CSS + 空容器 + JS 渲染）：`diagnostics.js / setup-wizard.js / guide-beginner.js / update-card.js`。但没有可以直接拿来当配置卡的既有组件，而且 setup-wizard 有自己的 `ibSetupV1*` 私有状态（P4 契约逐字禁止扩它）—— 因此**只复用外观语言，逻辑一个都不复用**。

---

## §2 信息架构

不再新建一个割裂的管理后台，直接在现有 Economy 页面上加一层页签：

```text
Economy
├─ 待处理            ← P22-15，一个字节都没改
├─ 钱包与初始额度
├─ 预算限制
└─ 自主购买
```

**接线方式（P22-15 不回归的结构保证）：**

* 新外壳 `#economy-configuration` **插在 `#economy-requests` 之前**（`insertBefore(page.firstChild)`），因此页面里那个节点的父节点、位置、内容**一个字都没变**；
* `#economy-requests` 的可见性由新模块按页签开合它的 `style.display`（**唯一**一处改动），默认页签是「待处理」⇒ 页面打开时的样子与 P22-15 交付时**逐字相同**；
* 只有「待处理」页签才去调 `IB.economyApprovalUI.render()`；其余三个页签一次都不碰它。

---

## §3 三个配置面板

### 钱包与初始额度

* **钱包不存在** → 唯一会出现初始化表单的状态：一个金额输入 + 一个主按钮，**两步确认**（第一次点击只把当前输入存成草稿并换成"确定设置？只能设置一次。＋ 再想想"）；
* **钱包存在** → 一枚安静的「初始额度已设置」标记 + 权威给的当前可用（主数，大字号）/ 账本余额 / 已预留 + 折叠的技术说明。**没有任何可执行的初始化控件** —— 因此这台节点上永远只会有一个"可执行的初始额度按钮"；
* 余额不可信时 `available` 显示为**空**（不是 0）："我不知道"与"没有钱"是两件事；
* 它不是充值：文案里没有充值 / 提现 / 银行卡 / 支付 / 余额充值 / 法币 / 货币符号。

### 预算限制

* 主区三格：**单次最多可花**（`limits.perTransactionMinor`）、**每日最多可花**（`dailyMinor`）、**超过多少先问我**（`approvalThresholdMinor`）；
* 高级设置默认收起：每周 / 每月上限、有效期（`termEndsAt`）、冷却（`cooldownMs`）、自主程度标记（`autonomyLevel`）；
* **留空 = 这一档不设**（省略该键），**显式填 0 = 一分钱都不许**（一个有含义的值，不是一个"没填"）；
* **每日预算刻度**：上限来自 `/economy/policy` 的 `dailyMinor`，已用来自 `/economy/budget` 的 `spentTodayMinor` —— **两个数都直接来自权威读面**，UI 只把它们画成一条带。读不到"已用"时退化成**纯额度刻度**，并写一句为什么，**不编一个进度值**；
* 预算快照里的 `decision`（ALLOW / DENY / REQUIRE_APPROVAL）**不进视图模型**，测试逐字断言整页模型里没有它；
* 保存成功只说「**预算规则已保存**」，下面一句固定的事实行：某一件东西能不能买，仍然由余额、预算、商品状态、报价与批准各自回答。

### 自主购买

字段逐条翻译成人话：是否允许自主购买 / 单次自主购买上限 / 每日自主购买上限 / 超过多少需要我确认 / 允许购买的商品范围（5 个类别）/ 允许的交付方式（3 种）/ 是否允许送礼。

* 页面上有那句 §4 要求的话：**自主购买仍受 Budget、商品状态、报价与 Approval 等 Economy authority 约束。这份规则不绕过它们中的任何一个。**
* **没有**「完全放权」「无限自主」「不再询问」这一类按钮；
* 两个必填上限空着 → **fail closed**（一个请求都不发），并且指名是哪一格；
* 一个类别都不选 → **省略字段**（canonical 的空集 = 不自主买任何东西），既不写 `[]`（会被拒），也不变成"全选"；
* 「商店范围」不在页面上，而那句实话在。

---

## §4 安全边界（结构事实，不是注释）

* 整个渲染层里**没有 `fetch`**；唯一的写动作是 `driver.economyConfiguration(...)`；
* `home-node-client.js` 里**新增一个方法**，路径与信封都是构造出来的（顶层恰好三个键，没有第四个位置）；
* 纯层里没有 `mintForSystem / transferBetweenWallets / settlePurchase / refund / exchange / topup / decideApproval / resumeAgentPurchaseIntent` 这些名字（测试逐名断言）；
* 命令词表就是 seam 的那三个，且恰好等于 seam 的 `RUNNERS` 受理的三个（测试逐字比对源码）；
* 浏览器**不能**自己改 Wallet / Ledger / Approval / Purchase：那些方法在渲染器与纯层里都不存在；
* 所有成功状态都**重新 GET 五条读面**之后才显示（视觉测试逐条断言五条都被再读了一次）。
* **服务端零改动**：`services/` 下一个字节都没动。

---

## §5 首次使用体验

```text
进入 Economy → 选配置对象（角色）→ 设置初始额度（两步确认）
→ 设置预算 → 设置自主 → 保存 → 页面重新读权威 → 显示当前配置
```

不需要 DevTools、curl，也不需要任何手工数据库操作。

**配置面关着时**（未配置 `IB_HOME_NODE_TOKEN`）：进页面就根据 `/security` 的 `economyPolicy.configuration.open` 显示一条安静的不可用状态 + 原因，**没有任何保存按钮、没有输入框**（视觉测试断言 `primaryButtons === 0 && inputCount === 0`）。底层词（环境变量名）只出现在折叠的「技术说明」里（P6 文案契约）。

---

## §6 视觉

* Internal / Infernal 双主题；桌面 / 平板 / 手机三档；
* 玻璃层级**最多两层**（卡片一层，输入面一层），刻度条 / 徽标 / 说明块一律 inset 实底，不叠 `backdrop-filter`；
* 数字用 `font-variant-numeric: tabular-nums`；主数用 display 字体放大到 1.7rem；
* 高级设置默认收起；页签在手机上是一条可横向滚动的轨；
* 状态只有**一种**色彩渠道（`--ecfg-tone` 式的低饱和族），没有红黄绿三盏灯；
* 图标与空状态全部是 inline SVG 线性图形，**没有 emoji、没有位图**（测试断言 `imgCount === 0`）；
* 复用 core.css 的全部设计令牌，**没有**一条只在一个主题里成立的硬编码 RGB。

### 素材

**本阶段没有生成任何外部图片，也没有 `NEEDS_GENERATED_ASSET`。** SVG + CSS 完成了全部需要，PNG 新增 = 0（截图只落 `%TEMP%`）。

---

## §7 测试纪律

```text
新增测试 child process = 0
spawn = 0（视觉测试除外：它是唯一一次启动的真实浏览器，复用同一个 browser，
          最后 Browser.close + child.kill）
```

四条测试（`p22-ui` 套件里跑前两条）：

| 文件 | 结果 |
|---|---|
| `tests/test_p22_16_economy_configuration_ui_core.js` | 60 / 60 |
| `tests/test_p22_16_economy_configuration_ui.js` | 59 / 59 |
| `tests/test_p22_16_economy_configuration_visual.js`（不在默认套件） | 86 / 86 |

覆盖 §8 的十条：

1. **Bootstrap fresh / already initialized** —— C1–C13（含"已初始化后一个主按钮都没有"）；
2. **Budget 表单 canonical projection** —— D1–D6（逐字节比对请求体）；
3. **Autonomy 表单 canonical projection** —— E1–E5；
4. **非法输入 fail closed** —— F1–F4（`writes.length === 0`）；
5. **保存后 authoritative reload** —— C5 / D5 / 视觉 ④-4（五条读面逐条被再读）；
6. **配置面关着时不给假按钮** —— H1–H5 / 视觉 ⑥-1；
7. **mobile 无横向溢出** —— 视觉 ①/②/③-4/⑤-3/⑦-4；
8. **Internal / Infernal** —— 视觉 ①（并断言两套主题的标题颜色真的不同）；
9. **P22-15 Approval UI 不回归** —— J1–J4 + 视觉 ⑦-1～⑦-4 + `test_p22_15_*` 62/62 与 55/55；
10. **`/economy/*` write 仍为 0** —— 渲染测试 C6 + 视觉 ④-1（假 driver / 真 fetch 两条路径各断言一次）。

**没有**重跑 P22-6～P22-8 的多进程 crash / race matrix（那些已经被证明过）。

---

## §8 开发期抓到的三个真实缺陷（都由测试或看图抓到）

1. **两步确认会把用户刚填的金额清空。** 第一次点击后重画整个面板，输入框回到空 —— 用户以为系统把他填的数吃掉了。修法不是"别重画"，而是加一层**草稿**：`input` 事件与"点击确认"两处都存值，而 `load()` 一开始清空草稿（因此保存成功后表单显示的是刚读回来的权威值，不是用户上一次的输入）。回归钉：`ui` 测试 C3。
2. **预算输入框右边写的是 canonical 代号 `IB_CREDIT`。** 纯 Node 测试全绿，只有看截图才看得见。修法：单位一律走 `CORE.currencyLabel()`（`IB Credit`）。回归钉：`ui` 测试 I7 / I8（正文里不得出现任何 canonical 原始代号）。
3. **视觉测试的桩比生产宽松。** 角色目录 `apiConfigs` 在生产里有**两条活入口**（`social.js:607` 的顶层 `let` + `:2654` 的 `ibSocialLive` 活 accessor）；只装一条的桩看不见"渲染器只认某一条路"。修法：桩与生产同形，两条都装。回归钉：`ui` 测试 I5b / I5c。另有一条更一般的教训：**首启的进场时间线会把 `#app` 停在 `opacity: 0`**，强行收起欢迎屏之后页面是一团雾而所有 DOM 断言全绿 —— 因此视觉测试多了一条"没有任何覆盖视口的层压在页面上"的断言（同时查覆盖层与祖先链的 opacity / filter）。

---

## §9 视觉检查结果

2 主题 × 3 宽度 + 5 个状态，共 **16 张截图**（落 `%TEMP%\ib-p22-16-shots`，**不写进仓库**），逐张人工看过：

```text
p22-16-budget-internal-{desktop,tablet,mobile}.png
p22-16-budget-infernal-{desktop,tablet,mobile}.png
p22-16-mobile-{wallet,budget,autonomy}.png
p22-16-wallet-initialized-desktop.png / p22-16-wallet-fresh-mobile.png
p22-16-budget-after-save-desktop.png / p22-16-closed-desktop.png
p22-16-autonomy-mobile.png
p22-16-requests-{desktop,mobile}.png
```

---

## §10 Stop Gate

1. **Fresh install 是否能通过 UI 完成 Economy 初始配置？** 能。选配置对象 → 初始额度（两步确认）→ 预算 → 自主 → 保存 → 重新读权威并显示当前配置。不需要 DevTools / curl / 手工数据库操作。
2. **Bootstrap 是否仍然只能一次？** 是，而且**持有者不是 UI**：一次性是 canonical `economy_meta` 行，由 store 的事务在写锁内复查；UI 侧的保证是"钱包存在时不出现任何初始化控件"。
3. **UI 是否完全没有 raw mint / ledger / transfer 能力？** 完全没有。渲染器里没有 `fetch`，纯层里没有那些名字，唯一的写路径是配置 seam（且服务端一个字节未改）。
4. **Budget 是否仍由 canonical evaluator 拥有？** 是。UI 只做形状校验与投影；刻度条的两个数都直接来自权威读面；快照里的 `decision` 不进视图模型。
5. **Autonomy 是否仍不能绕过 Approval / Budget？** 是。政策只是权限，保存文案明确说"不表示现在就可以买"，页面上有那句"仍受 Budget、商品状态、报价与 Approval 约束"。
6. **保存后是否重新读取 authority？** 是。每次保存之后重新读五条读面（视觉测试逐条断言）。
7. **P22-15 Approval UI 是否未回归？** 未回归：它的 HTML 容器逐字未改、DOM 节点未被搬动、只有默认页签会调它的渲染器；`test_p22_15_*` 62/62 + 55/55，视觉 ⑦ 全绿。
8. **`/economy/*` HTTP write 是否仍为 0？** 是（渲染测试 C6 + 视觉 ④-1，两条路径各断言一次）。
9. **Internal / Infernal / mobile 是否实际检查？** 是，16 张截图人工看过，并断言两套主题的令牌真的不同、三档宽度都无横向溢出。
10. **child process / spawn / leftover 各是多少？** 非视觉测试 **child process = 0、spawn = 0**；视觉测试 **spawn = 1**（一次 Chrome，复用同一个 browser，结束时 `Browser.close` + `child.kill` + 删临时 profile）；测试后无遗留进程与临时目录。
