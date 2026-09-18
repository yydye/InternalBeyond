# Economy 公开面冻结 · `ECONOMY_PUBLIC_SURFACE.md`

> 本文件是 **P22-20 · Economy External Boundary Audit** 的交付物之一（§8）。
> 它列出 Economy 今天**真正存在**的对外面：能读什么、能写什么、有哪些能力、
> 以及哪些词**不在**这里。
>
> ★ 它不是一份散文：`tests/test_p22_20_economy_public_surface.js` 会逐行解析
> 本文件的三张表，并与**真实代码**（`services/home-node/http.js` 的路由判定、
> 三个 seam 的 `describe()`、契约的 `CAPABILITY` / `CONSUMER_CAPABILITY_MATRIX`）
> 逐个比对。本文件与代码任何一处漂移，那条测试就变红。
>
> ★ 基线：P22-19 · `e0e9b8f`。Economy 生产文件 **7 个**
> （`services/home-node/economy-*.js`），schema 水位 **7**。

---

## 1 · Read（只读面 · 全部 `GET`）

未配置 `IB_HOME_NODE_TOKEN` 时读面仍然可达（本机单用户模型）；写面则整面 503。

| Method | Path | 它回答什么 |
| --- | --- | --- |
| `GET` | `/economy/health` | Economy 引擎自身的健康与计数（不开钱包、不改任何东西） |
| `GET` | `/economy/wallet` | 一个 owner（或 walletId）的余额与三态（COLD / DEGRADED 时余额是 `null`，**不是** 0） |
| `GET` | `/economy/wallets` | owner 名下全部钱包（按 currency 升序） |
| `GET` | `/economy/ledger` | 复式账本的分录/拓扑（按 transactionId 或 accountId） |
| `GET` | `/economy/transaction` | 一笔 transaction 的完整形状（含平衡拓扑） |
| `GET` | `/economy/changes` | change log；带 `ownerId` 时是 owner 作用域（P22-19） |
| `GET` | `/economy/reservations` | 预留列表（按 walletId / ownerId） |
| `GET` | `/economy/reservation` | 一条预留或一次 operation 的形状 |
| `GET` | `/economy/policies` | 预算政策列表 |
| `GET` | `/economy/policy` | 一条预算政策 |
| `GET` | `/economy/budget` | 预算**评估**（`evaluatedOnly`，不预留、不是花钱许可） |
| `GET` | `/economy/quotes` | 报价列表（价格命题，不是资源锁定） |
| `GET` | `/economy/quote` | 一条报价；`evaluate=1` 额外做一次预算评估（仍然只读） |
| `GET` | `/economy/stores` | 货架目录 |
| `GET` | `/economy/store` | 一个货架 |
| `GET` | `/economy/products` | 商品目录（非个性化：无推荐、无排序分数、无折扣） |
| `GET` | `/economy/product` | 一个商品 |
| `GET` | `/economy/inventory` | 库存（资产，**不是**余额） |
| `GET` | `/economy/inventory-entry` | 一条库存记录 |
| `GET` | `/economy/purchases` | 购买记录 |
| `GET` | `/economy/purchase` | 一笔购买 |
| `GET` | `/economy/approvals` | 许可（approval）列表 |
| `GET` | `/economy/approval` | 一份许可 |
| `GET` | `/economy/autonomy-policies` | 自主规则列表 |
| `GET` | `/economy/autonomy-policy` | 一条自主规则 |
| `GET` | `/economy/autonomy-evaluation` | 自主规则的**评估**（只读） |
| `GET` | `/economy/intents` | Agent 购买意图列表 |
| `GET` | `/economy/intent` | 一条 Agent 购买意图 |
| `GET` | `/security` | 本机节点的安全自述（含 `economyPolicy`：写面的开/关与不可达名单） |

**读面共 28 条 `/economy/*` + 1 条 `/security`。** 没有第二条 `/security` 式的自述面。

---

## 2 · Write（写面 · 全部 `POST` · 全部**不在** `/economy/` 下）

三条写面各自独立：**不共用**命令词、**不共用**信封、**不共用** consumer、
**不共用**凭据。三条都要求本机 loopback + 已配置的桌面凭据；未配置时整面 503。

| Method | Path | 信封 | 命令 / 决定词 | 凭据 |
| --- | --- | --- | --- | --- |
| `POST` | `/internal/economy/configuration` | `{command, config, idempotencyKey}` | `BOOTSTRAP_CREDIT` · `PUT_BUDGET_POLICY` · `PUT_AUTONOMY_POLICY` | 桌面凭据（`IB_HOME_NODE_TOKEN`） |
| `POST` | `/internal/economy/approval-decision` | `{approvalId, decision, idempotencyKey}` | `APPROVED` · `REJECTED` | 桌面凭据（`IB_HOME_NODE_TOKEN`） |
| `POST` | `/internal/economy/command` | `{command, proposal, idempotencyKey}` | `ECONOMY_PROPOSE_PURCHASE` | 来源凭据（`IB_ECONOMY_CHANNEL_TOKEN`） |

三条写面自述的"不存在的写形态"（`/security` 里逐字可读）：

* configuration：`BUY` / `SETTLE` / `RESERVE` / `GRANT_INVENTORY` / `APPROVE` / `REJECT` /
  `REFUND` / `EXCHANGE` / `PROVIDER_TOPUP` / `REAL_PAYMENT` / `RAW_LEDGER_WRITE`；
* approval-decision：`BUY` / `SETTLE` / `RESERVE` / `GRANT` / `REFUND` / `LEDGER` / `AUTO_ALLOW`；
* command：`ECONOMY_BUY` / `ECONOMY_SETTLE` / `ECONOMY_RESERVE` / `ECONOMY_APPROVE` /
  `ECONOMY_RESUME` / `ECONOMY_GRANT` / `ECONOMY_LEDGER` / `ECONOMY_WALLET_MUTATE`。

---

## 3 · Capability（Agent / User 侧的能力）

| Capability | 谁持有 | 它意味着什么 |
| --- | --- | --- |
| `PROPOSE_PURCHASE` | `active_agent_runtime` | Agent 可以**提出**一个购买意图（提出 ≠ 允许，允许由预算/自主/许可决定） |
| `RESUME_APPROVED_PURCHASE` | `active_agent_runtime` · `user_decision_seam` | 把一条**已被用户批准**的意图继续做完；Agent 不能自己发起 resume |

`home_node_authority` 与 `desktop_bridge` 的能力表**是空的**——
"本机节点自己"和"桌面桥"都不是经济行为的发起者。

---

## 4 · Not present（这些词在 Economy 里**不存在**）

下面每一个词都在仓库里被**逐字否认**（契约的否认清单、command 词表的拒绝名单、
`/security` 的 unreachable 名单各有其一），而不是"目前还没实现所以碰巧找不到"。

| Word | 现状 |
| --- | --- |
| `BUY` | 不是 capability、不是 command、不是路由；`/economy/buy` 不可达 |
| `PAY` | 不是 capability、不是 command、不是路由；Economy 的依赖闭包里没有任何支付模块 |
| `REFUND` | 词表里只有 `TX_TYPE.REFUND`（账本交易类型）与 `PURCHASE_HAS_REFUND = false`；没有操作、没有路由、没有 UI |
| `EXCHANGE` | 契约 §17 冻结了汇率**算术**（零调用方），但没有能力、没有路由、没有 UI |
| `TRANSFER` | 不是 capability、不是 command、不是路由；`transferBetweenWallets` 只是同进程 store 原语 |
| `TOPUP` | 不是 capability、不是 command、不是路由；`/economy/topup` 在 unreachable 名单里 |
| `WITHDRAW` | 不是 capability、不是 command、不是路由；Economy 里没有这个字 |

---

## 5 · 这张表怎么被守住

| 断言 | 在哪 |
| --- | --- |
| 本文件的三张表 ↔ 真实路由 / seam / capability 逐个比对 | `tests/test_p22_20_economy_public_surface.js` |
| 28 条读面在本进程 HTTP 上真的可达；每一条 `POST` 都 405 | 同上（in-process server，socket = 1） |
| `/economy/{refund,reverse,exchange,topup,buy,payment,purchase,transfer,withdraw}` 全部 404，且 change log 逐字不变 | 同上 |
| §1 的外部能力矩阵（谁拥有真实支付 / 商户 / 订单） | `tests/test_p22_20_economy_external_boundary.js` |
| 依赖闭包（sqlite / crypto / http / path / fs + `runtime/db-failure.js`，到此为止） | 同上 |
| §3 四资源注入（`USD` / `CNY` / `TOKEN` / `API_BALANCE`）fail closed | `tests/test_p22_20_economy_boundary_injection.js` |
| §10 Provider / Payment / Exchange / Refund / capability 反例注入 | 同上 |
| UI 上没有提前出现未来能力的入口 | `tests/test_p22_20_economy_public_surface.js`（§9） |
| 审计全文与结论 | `docs/history/economy/P22/P22-20-ECONOMY-EXTERNAL-BOUNDARY.md` |

---

## 6 · 页面上的入口（§9）

Economy 这一页只有四类动作，没有第五类：

* **查看** —— 切页签、切货架筛选、展开/收起技术说明、展开一条请求的细节；
* **解释** —— 读时间线、读"Agent 为什么提出请求"（Agent 的理由**原样**展示）；
* **批准** —— 「允许继续」/「拒绝请求」（写 `/internal/economy/approval-decision`）；
* **配置** —— 设置页保存预算/自主规则、发一次初始额度（写 `/internal/economy/configuration`）。

页面上**没有**：购买按钮（商品卡上没有任何动作）、充值、提现、兑换、退款、转账、
支付、结算入口。完整按钮文案表由 §9 的测试从**真实渲染器**的 DOM 里收出来逐个断言。
