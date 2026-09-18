# P22-6 · Purchase Orchestrator + Atomic Settlement

> 第一次把 Product → Product-backed Quote → Budget → Reservation →
> Final Revalidation → Atomic Settlement 串成**一条** IB 内部购买流程，
> 并保证最终经济事实处在**不可撕裂**的 SQLite atomic boundary 里。

## 0. 本阶段做了/没做什么

**做了**：Purchase 实体（contract + schema 5 + runtime）、`preparePurchase` /
`settlePurchase` / `cancelPurchase` / `getPurchase` / `listPurchases`、
两条只读 HTTP 路由、`/security` 的购买面声明。

**没做**（§104 Stop Gate）：Approval workflow、Agent 自主购买、Decision /
Action 集成、Exchange、Provider adapter、真实 Provider 额度、真实支付、
退款 / 折扣 / 推荐、UI、视觉素材。

---

## 1. 修改 / 新增文件

| 文件 | 变更 |
|---|---|
| `services/home-node/economy-contract.js` | **M** +582 −7 —— §22 Purchase 契约一节 |
| `services/home-node/economy-store.js` | **M** +2837 −357 —— schema 4→5、purchases 表、五个方法、三个 in-tx seam、完整性、health |
| `services/home-node/http.js` | **M** +81 −3 —— 两条只读路由 + `/security` 十一个字段 |
| `tests/test_p22_6_economy_purchase.js` | **A** 1137 行 · **108 项** |
| `tests/test_p22_6_economy_settlement.js` | **A** 1085 行 · **101 项** |
| `tests/test_p22_6_economy_runtime.js` | **A** 544 行 · **35 项**（真实子进程 + 多进程竞争） |
| `tests/fixtures/p22-6-purchase-worker.js` | **A** 127 行（fixture，不是测试） |
| `tests/test_p22_1_economy_domain_contract.js` | **M** —— 三处冻结计数（11→13 scope、40→42 reason、事件表）+ D14.26 子集断言 |
| `tests/test_p22_1_economy_boundary.js` | **M** —— 契约导出面（`purchaseCounterpartyFor` → `settlementCounterpartyFor`） |
| `tests/test_p22_2_economy_store.js` | **M** —— `O9` 可改表集合 + `O9f/O9g/O9h` 逐列断言 |
| `tests/test_p22_2_economy_runtime.js` | **M** —— `C15` 的 unreachable 名单 + 反向断言 |
| `tests/test_p22_5_economy_catalog.js` | **M** —— `A1/A2/J1/J8/J10` 的水位与表清单 |
| `tests/test_p22_5_economy_inventory.js` | **M** —— `N5` 从"没有买"改成"买有了具名入口" |
| `tests/test-all.js` | **M** —— 登记三个新测试 |
| `docs/P22-6-ECONOMY-PURCHASE.md` | **A** 本文件 |

**Economy 生产文件 = 仍然是 2 个。require 目标 = 仍然是 3 个**
（`node:sqlite`、`runtime/db-failure.js`、`./economy-contract.js`）。

---

## 2. schema 版本

```text
1 → 2 (P22-3)  operations / reservations / operation_idempotency
2 → 3 (P22-4)  budget_policies / quotes
3 → 4 (P22-5)  stores / products / inventory
4 → 5 (P22-6)  purchases                          ← 本阶段（只多一张表）
```

`MIGRATIONS` 条目**仍然为空**（只有新表，没有既有列改写）。`quotes` 与
`reservations` 各加了**零**列 —— "这笔预留属于哪次购买"的事实写在
**purchase 那一侧**（`reservation_id` 是 purchase 自己的列），往 reservation
上加一列只会制造第二个归属来源。

一个 P22-5 build 打开 P22-6 的库 → `SCHEMA_TOO_NEW` 拒绝；反向 → 补一张表、
水位抬到 5、既有七类行**一字节不动**（catalog 的 `J1/J2/J3`）。手工造一个
"水位 = 下一版且缺四张表"的库，拒绝打开之后逐表断言那四张**一张都没被创建**
（`J10`）—— DDL 排在兼容性判断之后。

---

## 3. Purchase schema

```sql
economy_purchases (
  purchase_id PK, buyer_id, buyer_type, recipient_id, recipient_type,
  product_id, store_id, quote_id, reservation_id, ledger_transaction_id,
  currency, amount_minor CHECK(>=0),
  quote_kind    CHECK IN (PURCHASE, GIFT, COMPUTE_GRANT),
  settlement_type CHECK IN (INVENTORY_GRANT, COMPUTE_GRANT, SERVICE_EXECUTION),
  asset_kind    CHECK (NULL OR IN (ITEM, COMPUTE)),
  granted_quantity CHECK(>=0), unit_name, status CHECK IN (RESERVED, COMPLETED, RELEASED, FAILED),
  release_reason, reason_code, reservation_state, reservation_expires_at,
  inventory_entry_id, consent_snapshot,
  idempotency_key, fingerprint, revision,
  created_at, updated_at, completed_at
)
```

四条约束落在 SQLite 上，不是只靠 JS：

| # | 约束 | 它挡住什么 |
|---|---|---|
| ① | `purchase_id` PRIMARY KEY | 身份唯一 |
| ② | `ledger_transaction_id` **UNIQUE** | 一笔交易不可能被两笔购买指向 |
| ③ | `quote_id` **UNIQUE** | 一份报价不可能被两笔购买指向（§51） |
| ④ | `status` / `quote_kind` / `settlement_type` / `asset_kind` CHECK | 词表成员由数据库把关 |

**刻意没有的列**：provider / api_key / payment_intent / checkout_url /
relationship_id / memory_ref / discount / coupon / recommended —— 它们不是
"暂时没填"，而是**没有地方可以填**。

`ledger_transaction_id` 在 RESERVED 期间必须是 **NULL**：把它预先写上会让
`IS NOT NULL` 不再等于"已结算"，而那正是 `getPurchase().settlement` 判定的
依据。它在**结算**那一刻被填上，值确定性地派生自 `purchaseId`。

---

## 4. Purchase 状态机

```text
RESERVED ──▶ COMPLETED      结算成功（终态，不可逆）
         ├─▶ RELEASED       主动放弃 / 预算要求批准（"流程被放弃"）
         └─▶ FAILED         规则或时间不允许继续（"试过了、不成立"）
```

四态，刻意**没有** `CREATED` / `PENDING`：`RESERVED` 是唯一的入口状态，
所以"尚未 settlement"与"还没有 Purchase"不会互相伪装。

- 三个终态的出边都是空数组，`assertPurchaseTransition` **在运行路径上真的
  被调用**一次（不是注释）。
- `RELEASED` 与 `FAILED` 分开的理由与 P22-3 分出
  `RESERVATION_RELEASED` / `OPERATION_FAILED` 逐字同源；**本阶段真正用到
  这个区分的地方是 §32 的 REQUIRE_APPROVAL**（见 §11）。
- ★ 一个真实缺陷：`needsApproval` 曾经拿 `C.APPROVAL.USER_APPROVAL_REQUIRED`
  去比 `budget.decision.outcome` —— 而后者来自 **P22-4 的 `BUDGET_DECISION`**
  （`ALLOW`/`DENY`/`REQUIRE_APPROVAL`），两个词表**没有一个成员相同**，
  所以那个比较恒为 false：需要批准的购买被记成了 FAILED。修法是改用
  `C.BUDGET_DECISION.REQUIRE_APPROVAL`。

### 身份（§3）

**不新增第 15 种 id 种类。** P22-1 冻结的 `ID_PREFIX` 里有
`PURCHASE_INTENT: 'econ_intent_'`，它从冻结那天起没有任何写入方 ——
那是"先冻结形状、后实现"留下的空槽，语义正是"一次购买"。P22-6 把它用起来：

- 加第 15 个前缀会让两个语义相同的前缀同时存在，此后每次审计都要先回答
  "intent 与 purchase 差在哪"，而它们没有差；
- 这个前缀此前从未被写过，因此**零迁移**。

`purchaseId` 与 `quoteId` / `reservationId` / `transactionId` / `operationId`
四个前缀互不相同，形状校验互相拒绝（`A7`）。

---

## 5. 五个边界

```text
Product          商品定义（可变的只有 status 与 unit_price_minor）
Quote            某一时刻的价格命题（写下即不可变；P22-6 给它加了零列）
Budget Evaluation 当前规则允不允许（每一次执行时重新算）
Reservation      对 Wallet 可用资源的临时锁定
Ledger Transaction 已发生的 accounting fact
Inventory/Entitlement settlement 产生的资产事实
Purchase         以上六者的**组织方式**
```

`serializePurchase()` 逐字写着 `isALedgerTransaction: false` /
`isAReservation: false` / `isAQuote: false` / `hasRefund: false` /
`exposesHttpMutation: false` —— 不是忘了加，是这一层没有那个概念。

---

## 6. Prepare flow

```text
preparePurchase({ quoteId, buyerId, recipientId?, expiresAt, units?, idempotencyKey })
```

```
快速失败（事务外）：
  形状 / seller-seller 一致 / 报价存在 / 商品存在（Product-backed 硬门）
  金额与数量 == 商品基准 × units（不接受"改一下金额"的报价）
  fulfillment → primitive 必须存在且非 null（SERVICE fail closed）
  报价 OPEN 且未过期
幂等闸门（PURCHASE_PREPARE scope）
 ┌ BEGIN IMMEDIATE
 │ ① 重读报价与商品；再问一次状态与时间
 │ ② Budget 评价 —— **在写锁里**（ALLOW 之外两种结局都停下，零写入）
 │ ③ reservation（P22-3 canonical 形态）+ reserved 缓存 ← Σ(ACTIVE)
 │ ④ 余额/可用量在预留之后再确认（守卫：Σ(ACTIVE) ≤ ledger 余额）
 │ ⑤ INSERT purchase（RESERVED）+ consent 快照
 │ ⑥ 两条 change log：PURCHASE_CREATED、PURCHASE_RESERVED（各自 revision）
 │ ⑦ 幂等行
 └ COMMIT
```

Prepare 成功后世界**逐字**是：

```text
Purchase     = RESERVED
Reservation  = ACTIVE
Quote        = OPEN          ← 资金只是被锁住，还没有最终 settlement
Ledger       = unchanged     （transactions / entries 计数不变）
Inventory    = unchanged     （一件都没有发）
reserved     = amount        （锁住了，但没有花掉）
```

### 为什么 Quote 在 Reserve 时仍保持 OPEN（§6）

如果此时就写 `CONSUMED`，那么"reserve 成功 + 进程崩溃"会留下
**"报价已消费但商品没发"的假事实**。

### 结算形态来自**不可变**的商品列

`fulfillment` 与 `asset_kind` 是 Product 的**本体列**，P22-5 冻结了它们不
可变（唯一能改的是 `status` 与 `unit_price_minor`）。因此从它们派生是安全
的，而**单价绝不参与**：价格事实只来自 Quote 快照。

Product.status 在 Prepare 里**刻意不检查**：一份在商品还 ACTIVE 时创建的
报价，在商品 RETIRED 之后依然可以被买到它那一刻表达的价格与交付
（P22-5 的 F 组冻结结论）。

---

## 7. Settlement flow —— 一个 SQLite atomic boundary

```text
settlePurchase({ purchaseId, now?, idempotencyKey })
```

**入参恰好三个键**（`C.PURCHASE_SETTLE_INPUT_KEYS`）。`amountMinor` /
`currency` / `grantQuantity` / `assetKind` / `settlementType` / `recipientId` /
`productId` / `buyerId` / `quoteId` / `reservationId` **全部不在名单里** ——
于是"settle 时改价"这句话在**结构上**不成立：不是被校验拒绝，而是没有字段
可以承载它。

```
幂等闸门（PURCHASE_SETTLE scope；fingerprint 里只有 purchaseId）
 ┌ BEGIN IMMEDIATE
 │ ① re-read Purchase / Quote / Reservation / Wallet（+ Product）
 │ ② 四元组一致性：purchase ↔ quote ↔ reservation 的每一个可变属性
 │    金额 == reservation 金额；币种三方一致；buyer/recipient 两行一致；
 │    product.fulfillment == purchase.settlement_type（不可变列）
 │ ③ 报价/预留已过期？
 │      → 释放预留 + Purchase FAILED + Quote→EXPIRED（同一事务）→ 返回
 │ ④ evaluateBudgetInTx（**最新**规则）
 │      → DENY            → 释放预留 + Purchase FAILED → 返回
 │      → REQUIRE_APPROVAL → 释放预留 + Purchase RELEASED → 返回
 │ ⑤ commitReservationInTx（P22-3 的同一个事务体内核）
 │      reservation → COMMITTED · reserved 缓存 ← Σ(ACTIVE)
 │      ledger transaction + entries · operation → COMMITTED
 │ ⑥ Quote OPEN → CONSUMED（+ QUOTE_CONSUMED 事件）
 │ ⑦ 结算原语（INVENTORY / COMPUTE_ENTITLEMENT 走同一条）
 │ ⑧ Purchase RESERVED → COMPLETED（completedAt 与 commit 同事务）
 │ ⑨ change log（PURCHASE_COMPLETED）+ 幂等行
 └ COMMIT
```

**任何一步失败 → ROLLBACK。** 数据库最终只有两种形态：整笔购买从未完成，
或者整笔购买完整完成。

### 为什么"预留先离开 ACTIVE"必须排在 ledger 之前

P22-2 的 `applyDerivedBalances` 有一条真实守卫：若 `reserved > resulting
ledger balance` 就抛 `RESERVED_EXCEEDS_LEDGER_BALANCE`。余额 100、预留 70
时先扣款会让 ledger 变成 30 而 reserved 仍是 70 ⇒ 守卫触发、整个 commit
回滚。先释放预留再扣款则两数同步下降，守卫在任何中间时刻都成立。
这不是"绕过守卫"：守卫仍然在，只是被正确地喂了当前值。

### 一次结算产生 **5** 个 revision（一条 change 行各占一个）

`economy_change_log.revision` 是**主键**，而 P22-3 的纪律是"每一次
`allocateRevision` 恰好配一条 change 行"。开发期实测踩到两次
`UNIQUE constraint failed: economy_change_log.revision`：
① Prepare 的两条 Purchase 事件曾共用同一个 revision；
② 过期路径的 `QUOTE_EXPIRED` 与 `PURCHASE_FAILED` 曾共用同一个。
两处都已修，并且 K2 断言"revision 单调且无洞"。

---

## 8. 复用 canonical seam（不是复制）

| 需要的能力 | P22-6 调用的东西 | 它原来在哪 |
|---|---|---|
| 预留提交 + ledger 提交 | `commitReservationInTx`（**提取**自 `commitReservation`） | P22-3 |
| 释放预留 | `settleReservationInTx`（**提取**自 `settleReservation`） | P22-3 |
| 发放库存 / 额度 | `mutateInventoryInTx`（**提取**自 `mutateInventory`） | P22-5 |
| ledger 事务体 | `commitLedgerTransactionInTx` | P22-2 |
| 预算评价 | `evaluateBudgetFor` | P22-4 |

三次提取都是**纯机械**的：同一条 SQL、同一组状态机闸门、同一条 change log、
同一条幂等写入。公开出口（`commitReservation` / `releaseReservation` /
`grantInventory` …）继续作为独立 operation wrapper，行为逐字不变
（P22-3 / P22-5 全量回归全绿）。

### `withTransaction` 变成**可重入**

SQLite 不允许嵌套 `BEGIN`，因此"在一个事务里调用会自己开事务的 primitive"
只有两条路：复制实现（= 第二份 validator，禁止），或者让事务可重入。

```js
function withTransaction(fn) {
  if (txDepth > 0) {            // 已经在事务里
    txDepth += 1;
    try { return fn(); } finally { txDepth -= 1; }   // 内层**永不** COMMIT
  }
  db.exec('BEGIN IMMEDIATE');
  txDepth = 1;
  try { const out = fn(); db.exec('COMMIT'); return out; }
  catch (e) { try { db.exec('ROLLBACK'); } catch (_) {} throw e; }
  finally { txDepth = 0; }
}
```

决定性的一点：**内层永不 COMMIT**，提交与否完全由最外层决定。于是"任何一步
失败 ⇒ 整体回滚"在嵌套下逐字成立。`close()` 把 `txDepth` 归零 —— 留下一个
非零深度会让下一次 open 之后的第一个事务**跳过 BEGIN**。

`_internal.transactionDepth()` 是一个**只读观测口**，没有任何生产分支依赖它；
测试用它证明"结算发生在恰好一条事务里"不是一句注释（E1/E2）。

### 幂等**只写一次**

`operation_idempotency` 的主键是 `(scope, idempotency_key)`，而 P22-4 给
INSERT 加了 `ON CONFLICT DO NOTHING`（"幂等记录是第一次执行的证据"）。
两条写入用同一个 `(scope, key)` 时第二条会被**静默丢弃** —— 于是重放 settle
会拿到 commit 那一层的 result，而不是这次购买的 result。开发期实测踩到：
`settlePurchase` 的重放返回 `{ok:false}`。

因此 `settlePurchase` 把 `commitReservationInTx` 的幂等写入**关掉**
（`idempotencyScope: null`），一个请求恰好一行、一个结果。

---

## 9. Budget：Prepare 评估 + 最终再评估

- **Prepare**：`budgetDecisionOf` 在写锁里面评估。`ALLOW` 之外的两种结局
  （`DENY` / `REQUIRE_APPROVAL`）都在**预留之前**停下，一个字节都没写。
- **Settlement**：**必须再评估一次**。原因是一个具体的时序：

  ```text
  T1 prepare A → ALLOW + reserve
  T2 另一笔购买提交
  T3 settle A
  ```

  日/周/月窗口在 T2 已经变了。**Reservation 保证的是"这笔钱不会被别的
  预留花掉"，它不保证预算没有被别的已提交交易用掉。**

- ★ Prepare 的预算结论在返回里逐字写着 `isACapability: false` /
  `revalidatedAtSettlement: true` —— 它是**解释性历史**，不是 capability。
- ★ **词表纪律**：预算决策的 outcome 词表是 P22-4 的 `BUDGET_DECISION`
  （`ALLOW` / `DENY` / `REQUIRE_APPROVAL`），而 P22-1 §4 的 `APPROVAL` 是
  另一套（`AUTO_APPROVED` / `USER_APPROVAL_REQUIRED` / `DENIED`）。两者
  刻意不同 —— 混用会让"规则允许"与"已经批准"看起来是同一件事，而
  §5 那个缺陷正是它的直接后果。
- 一个真实缺陷：拒绝返回里的 `policyId` 曾经是字面量 `"undefined"` ——
  代码写成 `String(policyRow.policy_id)`，而 `policyForOwner` 返回的是
  `rowToBudgetPolicy` 的**视图**，键名是 `policyId`。现在直接用决策对象
  自己的 `policyId`。

---

## 10. 结算原语与账本

```text
fulfillment          → primitive            → ledger TX_TYPE（来自 Quote 快照）
INVENTORY_GRANT      → INVENTORY            → PURCHASE / GIFT
COMPUTE_GRANT        → COMPUTE_ENTITLEMENT  → COMPUTE_GRANT
SERVICE_EXECUTION    → null（本阶段做不到）  → 在 Prepare 就 fail closed
```

**结算对手方**（§17/§18）：

```text
buyer wallet ──CREDIT──▶ system:market
```

- 白名单来自 P22-1 的 `SYSTEM_ACCOUNTS`，本阶段**不新增任何账户**。
- ★ Store **不是**商家：它没有价格、没有拥有关系，因此 `storeId` 不可能
  是一个 accounting account（把 storeId 当账户会让一次目录变更变成一次
  记账拓扑变更）。
- ★★ `COMPUTE_GRANT` 的对手方**也是** `system:market`，不是 `system:mint`。
  这里曾经写过 MINT（理由是"额度是被授予的、没有第二方"），而那条路走
  不通 —— 而且走不通是**对的**：P22-2 的 `assertBalanced` 有一条硬规则
  "`system:mint` / `system:burn` 只允许出现在 MINT / BURN 里"，它的存在
  理由是"否则写一笔 PURCHASE 而把对手方写成 system:mint 就能绕过增发的
  显式命名要求"。真实语义也更准确：一次 compute 额度购买不是一次增发
  （IB Credit 总量没有从无到有），"额度"是这次交易**交付的东西**。

金额只从**已经落库的 reservation 行**读；账户只从**wallet 行的
`account_id`** 读（不是 `wallet_id` —— 钱包 id 与它在 ledger 里的账户 id
是两个不同的东西）。

### Compute / API quota settlement（§20/§21/§53/§89）

```text
Product:  API_QUOTA / COMPUTE_CREDIT, price = 400, grant = 1000
Settlement: wallet −400；recipient 的 compute entitlement +1000 computeUnit
```

落点就是 P22-5 的 `economy_inventory`（`assetKind = COMPUTE`）—— **没有**
新建 `providerQuota` / `apiBalance` / `tokenBalance`，单位名**恰是**
`computeUnit`（`tokens` / `usd` / `providerBalance` 被 `isForbiddenComputeAlias`
拒绝）。`COMPUTE_GRANT` 是 **NEUTRAL**：它不占日消费额度（额度是被**授予**
的，不是被花掉的）。

**准确称法**：InternalBeyond **internal** compute/API quota entitlement。
**不是** Provider recharge。

### Service（§22/§54）

`SERVICE_EXECUTION` 在契约里指向 `null` primitive（"这一刻还做不到"），
而 `null` 与"未登记"是两件事（`registered: true` vs `false`）。它在
**Prepare 就 fail closed**（`PURCHASE_NOT_SUPPORTED` + `reservedNothing: true`），
不是"先锁再放"：那会白占一次 revision、一行预留与一次 change log，而
"这件事还做不到"是一个**静态**事实。它**绝不**借机执行任何 Action。

---

## 11. 报价消费、预留提交、购买完成

三者与 ledger **同事务**，且都不是"先做一半"：

| 事实 | 何时写 | 回滚后果 |
|---|---|---|
| `reservation → COMMITTED` | 与 ledger 同一事务，排在 ledger 之前 | 预留在库外仍是 ACTIVE |
| `quote OPEN → CONSUMED` | 结算事务里，且写一条 `QUOTE_CONSUMED` 事件 | 报价仍然 OPEN |
| `purchase → COMPLETED` + `completedAt` | 所有 settlement facts 之后 | 购买仍然 RESERVED |

`QUOTE_CONSUMED` 事件是一个真实缺陷的修复：这里曾经**只**改状态、不写事件
（因为"ledger 那一条已经记过这笔交易了"）。ledger 记的是钱，报价状态记的是
命题被用掉 —— 两件事各有一条事件，合并会让"报价被消费"在 change log 里
变得不可见。

---

## 12. 取消、过期、失败

```text
cancelPurchase({ purchaseId, reasonCode?, idempotencyKey })
```

只对**未完成**的 Purchase 生效，效果恰好两件：释放活跃的 Reservation +
Purchase → RELEASED。它**不产生任何 Ledger refund**（钱从来没有离开钱包，
§28）；它也**不取消报价**（§58：Purchase 的取消 ≠ Quote 的取消）。

### 报价/预留在 Prepare 之后过期（§29/§57）

```text
12:00 报价 12:05 过期
12:04 Purchase RESERVED
12:06 settle
```

结算**重新检查** `quote.expires_at <= now`（以及预留的 `expires_at`）。
已过期时：**不扣钱、不发货**，释放预留，Purchase → **FAILED**，
Quote → **EXPIRED**（按 P22-4 canonical 语义），全部在**同一个事务**里。
审计里逐字写着 `quoteExpiredAtSettlement: true` / `ledgerMutation: false`。

不能因为 12:04 reserve 时有效，就在 12:06 强行按过期报价扣钱。

---

## 13. 幂等与 exactly-once

| scope | 锁的是什么 |
|---|---|
| `PURCHASE_PREPARE` | 一次购买准备 |
| `PURCHASE_SETTLE` | 一次购买结算 |

与 P22-3 的 `RESERVE` / `COMMIT` **刻意不同**：同一个 HTTP/内部请求里的
key 会被 prepare 与 settle 各用一次，而 RESERVE/COMMIT 的语义是
"锁钱 / 把锁变成事实"—— 那是 Purchase **内部**的两步。压成同一个 scope 会
让"我那次购买准备成没成"与"我那笔预留成没成"变成同一个问题。

**fingerprint 只描述业务意图**：`{buyer, recipient, quoteId, productId,
currency, amountMinor, units, reservationExpiresAt}` —— `purchaseId` /
`operationId` / `reservationId` 都不在里面（§36）。

### exactly-once 的三层结构

```text
one Purchase  → at most one committed Ledger Transaction
                ② economy_purchases.ledger_transaction_id UNIQUE
one Purchase  → at most one settlement
                transactionId = derive(purchaseId)（确定性派生）
one Quote     → at most one successful Purchase
                ③ economy_purchases.quote_id UNIQUE
```

② 是**确定性派生**（`C.derivePurchaseLedgerTransactionId`）：重放同一个业务
得到同一个记账身份，而第二次提交会撞上同一个 `transactionId`。③ 不依赖任何
状态检查就挡住了 §38 的复用攻击。

★ 一个真实缺陷：`settlePurchase` 曾经把 `purchase.ledger_transaction_id`
直接传给 `commitReservationInTx`，而那一列在 RESERVED 期间**必须是 NULL**，
于是每一次结算都以 `transaction-id-not-canonical` 拒绝 —— 一次永远无法完成
的结算。现在交易 id 在结算那一刻**派生**，不从行里读。

★ 另一个：`preparePurchase` 曾经让 SQLite 的裸约束异常冒出去
（`UNIQUE constraint failed: economy_purchases.quote_id`）。那**不是**一次可
解释的拒绝：没有 reasonCode、没有 detail。现在先做一次结构化检查，唯一索引
是**最后一道**而不是唯一一道。

---

## 14. 故障注入与 fake-green 防线（§43/§44/§45/§84）

13 个注入点，每一个都断言**七件事**：

```text
after-purchase-settle-budget        after-commit-ledger
after-commit-validated              after-commit-operation-status
after-reservation-committed         after-purchase-quote-consumed
after-commit-reserved-cache         after-inventory-insert
after-transaction-insert            after-purchase-completed
after-first-ledger-entry            before-purchase-settle-change-log
                                    before-purchase-settle-commit
```

```text
① Ledger 未扣款          ④ Inventory 未增加
② Reservation 仍 ACTIVE   ⑤ Purchase 未假完成
③ Quote 未被消费          ⑥ revision 未泄漏   ⑦ 幂等未残留
```

外加两条：

- **hit counter**：每一个点都断言 `hit >= 1`。没有计数器的话，
  "注入点存在但没人调用"会静默通过。
- **重试真的成功**：故障之后换一个 key 重试，那笔购买必须**真的完成一次**。

★ 两个开发期真实踩到的陷阱（写在测试注释里）：

1. **注入必须在装填之后才生效。** `after-transaction-insert` 这类点号也会被
   **fixture 自己**的铸币命中（`mintForSystem` → `commitLedgerTransaction`
   → 同一个故障点）。如果 fixture 在创建时就抛错，那么"造一个有钱的钱包"
   这一步会在测试的 try/catch **之外**炸掉，而报错看起来像结算路径的问题。
   → `fx.arm()` 在装填那一刻才打开注入。
2. **抛错必须是一次性的。** 一个永远抛错的 fixture 会让"故障之后重试必须
   成功"这条断言**永远无法成立**。
3. **深度探针必须读装了探针的那个实例。** `txDepth` 是**每个实例**的，
   不是全局的 —— 开发期第一次跑时报告里每个点都写着 depth 0。

### 两个最重要的反例（§44/§45）

- **"扣钱成功、发货失败"**：`after-transaction-insert` / `after-first-ledger-entry`
  / `after-commit-ledger` 三个点注入 ⇒ Ledger 回滚、Reservation 未 COMMIT、
  Quote 未消费、Inventory 未增、Purchase 未 COMPLETED。
- **"发货成功、Purchase 状态失败"**：`after-inventory-insert` /
  `after-purchase-completed` 之前注入 ⇒ 发货**也**回滚。

---

## 15. 多进程（§50/§51）

★ 只有真实进程才能证伪的东西：`node:sqlite` 的 `DatabaseSync` 是同步 API，
单线程里两次 settle 不可能交错。

| 组 | 场景 | 结果 |
|---|---|---|
| **D** | **两个真实进程**同时 settle 同一笔购买 | 恰好一笔 COMPLETED / 恰好一笔交易 / 恰好一次发放 / 恰好一次报价消费；另一个是幂等回放或终态冲突，**绝不是双扣** |
| D9 | 两笔**不同**的购买同时 settle | 两笔都成功，账本 3 笔、库存 2，完整性零问题 |
| **E** | **两个进程**同时 prepare 同一份报价 | 库里**恰好一条**指向它的购买行 |
| **F** | **6 个进程**各自 prepare | 6 个互不相同的 `purchaseId`（跨进程唯一性，§3） |

每个 worker 在返回之前都用**自己的独立连接**读一遍世界（`transactions` /
`entries` / `completedPurchases` / 库存 / Quote / Reservation / 完整性），
因此"最终世界"不是某个进程的自述，而是被反复独立读出来的事实。

---

## 16. HTTP：只读面 + 写面逐名不存在（§60/§61）

```text
GET /economy/purchases   列出（buyerId / recipientId / status / productId / quoteId / limit）
GET /economy/purchase    单条（purchaseId）+ 三个小结 + settlement
```

**没有** `POST /economy/purchase`、`POST /economy/prepare`、
`POST /economy/settle`、`POST /economy/buy`、`POST /economy/cancel`、
`POST /economy/refund`、`POST /economy/reverse` —— 八条路径 × 三种写动词
= **24 次写尝试全部 405** `economy-is-read-only`（真实生产进程上实测）。

理由不是"还没写"，而是 **Decision / Action / Approval / 用户权限边界都还
没有接入** —— 在那之前，"谁能要求系统为谁买什么"没有这个问题答案，而没有
答案的写入口就是一个权限漏洞。

`/security` 新增：

```text
purchaseWritesExposed: []        settlementWritesExposed: []
policyApprovalWritesExposed: []  purchaseExposed: false
purchaseRuntimeImplemented: true purchaseSettlementIsOneTransaction: true
purchaseAmountSource: 'quote-snapshot'  purchaseHasRefund: false
purchaseCreatesPendingApprovalRecords: false  purchaseRewritesHistoricalQuotes: false
purchaseIsALedgerTransaction: false  purchaseTouchesProvider/Payment: false
```

`/economy/purchase` 从 `unreachable` **移走**（它现在是一条真路由），
换进它的是 prepare / settle / buy / cancel / refund / reverse —— 并做
**反向**断言证明它确实被移走了（否则"移走"与"忘了留"在测试里长得一样）。

---

## 17. 隔离（§62–§69）

| 边界 | 证据 |
|---|---|
| **Provider** | 依赖闭包仍 3 个 require 目标；无 `topUpProvider` / `checkoutUrl` / `paymentIntent` / `submitPayment`；`FORBIDDEN_PURCHASE_LEDGER_ACCOUNTS` 18 个成员逐字点名；compute 两类 `unitName` **必须恰是** `computeUnit` |
| **支付** | 无 `pay-gate` / `alipay` / `credential-vault` / `commerce-adapter` / `shopping-execution` / `payment-auth` |
| **网络** | 无 `fetch(` / `node:http` / `node:https` / `axios` / `WebSocket` / `node:net` / `XMLHttpRequest` |
| **Memory** | 无 `memorySave` / `Memory.create` / `memoryStore` / `memory-contract` / `memoryRef`；送礼结算逐字写着 `memoryMutation: false` |
| **Relationship** | 无 `relationshipSave` / `affection` / `familiarity`；Gift 结算逐字写着 `relationshipMutation: false` |
| **Decision** | 无 `decide` / `recommendProducts` / `chooseProduct`；只提供 `preparePurchase` / `settlePurchase` 给未来的编排层 |
| **Action** | 无 `executeAction` / `tool-execution-guard` / `middle-brain` / `IBMCP` / `mcp`；SERVICE 不借机执行工具 |
| **Approval** | 认识 `REQUIRE_APPROVAL` 但**不实现** Approval Request / UI / Approve / Reject；不创建任何待批准记录 |

`health()` 里每一条都是**可断言的字段**，不是注释。

---

## 18. 回归（§94–§99）

| 测试 | 结果 | 断言数 |
|---|---|---|
| `test_p22_1_economy_domain_contract.js` | 全部通过 ✔ | 275 → **300** |
| `test_p22_1_economy_boundary.js` | 全部通过 ✔ | 116 → **133** |
| `test_p22_2_economy_store.js` | 全部通过 ✔ | 203 → **206** |
| `test_p22_2_economy_runtime.js` | 全部通过 ✔ | **66** |
| `test_p22_3_economy_reservation.js` | 全部通过 ✔ | **313** |
| `test_p22_3_economy_runtime.js` | 全部通过 ✔ | **55** |
| `test_p22_4_economy_budget.js` | 全部通过 ✔ | **140** |
| `test_p22_4_economy_quote.js` | 全部通过 ✔ | **122** |
| `test_p22_4_economy_runtime.js` | 全部通过 ✔ | **47** |
| `test_p22_5_economy_catalog.js` | 全部通过 ✔ | **140** |
| `test_p22_5_economy_inventory.js` | 全部通过 ✔ | **98** |
| `test_p22_5_economy_runtime.js` | 全部通过 ✔ | **39** |
| `test_p22_6_economy_purchase.js` | 全部通过 ✔ | **108** |
| `test_p22_6_economy_settlement.js` | 全部通过 ✔ | **101** |
| `test_p22_6_economy_runtime.js` | 全部通过 ✔ | **35** |

**P22 全量 15 条：1626 项 · 0 失败**（本机实测耗时 80.4 秒）。

### Aggregate（§99）

```text
node tests/test-all.js --quick
  static   96 项 · 295.1s · 3 失败
  service  29 项 · 106.6s · 全部通过
总耗时 401.7s · 3 项失败 ✘

│ PASS  test_p22_6_economy_purchase.js   (1.1s)
│ PASS  test_p22_6_economy_settlement.js (4.2s)
│ PASS  test_p22_6_economy_runtime.js   (15.1s)
```

三条新测试**确实出现在 aggregate 输出里**（§99 的硬要求）。

### Baseline counterproof（§99：以 P22-5 为 baseline，不复制上一阶段的结论）

用 `git worktree add --detach <tmp> f843b3b` 造一个**干净**的 P22-5 工作树，
跑完即删（`git worktree list` 只剩主工作树）：

| 失败 | baseline（`f843b3b`） | P22-6 | 判定 |
|---|---|---|---|
| `test_cache_audit.js` | **exit 1** | exit 1 | **既有** |
| `test_middle_brain_convergence_counterproof.js` | **exit 1**（0 passed, 11 failed） | exit 1 | **既有** |
| `test_astra_readiness_observe.js` | exit 0 | **exit 1** | **P22 触发，但它是阶段守卫** |

第三条的**唯一**失败断言是：

```text
FAIL  Z1.noProductionFileChanged  -> services/home-node/economy-contract.js
```

它的判据是 `git diff --name-only HEAD -- assets services InternalBeyond.html`
必须为空 —— 那是 astra 阶段用来证明"本阶段零生产改动"的守卫，不是产品不变量。
P22-6 按定义就要改 `services/home-node/economy-contract.js`，因此这条断言
**必然**变红；它与 P22-6 的正确性无关。

其余 6 项在 baseline 那一跑里也失败过的测试（`test_node_runtime` /
`test_installer` / `test_installer_mock` / `test_update_install` /
`test_pe_version` / `test_welcome_canvas_payload`，外加需要内置运行时的
`test_p22_2_economy_runtime`）来自**全新 worktree 缺少内置运行时与已构建
安装产物**的环境缺失，不是 P22-6 引入的。

### 每一处有意修改，以及为什么它让断言更强

| 位置 | 改动 | 理由 |
|---|---|---|
| `D13.15` / `D14.26` | scope 11 → **13** | 冻结计数存在的意义就是"有人悄悄加了一个"必须失败 |
| `D14.2` | reason code 40 → **42** | 同上 |
| `B1.7`（boundary） | `purchaseCounterpartyFor` → `settlementCounterpartyFor` | 契约导出的名字里**不该有** `purchase` 这个前缀：它让"契约不导出能花钱的函数"这条断言要为一个纯映射开例外。改名的同时保留了那条断言 |
| `O9` | 可改表集合 + `PURCHASES_TABLE` | 并追加 `O9f/O9g/O9h`：两条 purchase UPDATE 的 SET 列**精确**读出来，经济内容列一次都不出现 |
| `C15`（P22-2 runtime） | 移走 `/economy/purchase`、换进五个写形态 | 并**反向**断言它确实被移走 |
| `A1/A2/J1/J8/J10`（P22-5 catalog） | 水位 4 → **5**、表数 15 → **16** | `J10` 的缺失集合从三张扩到**四张** |
| `N5`（P22-5 inventory） | "没有买" → "买有了具名入口" | 一条恒为 true 的断言在它变成 false 的那一天不会自己消失，因此必须**显式替换**；替换后同时断言 `purchase` / `buy` / `acceptQuote` 这三个**名字**仍然不存在（"买"是两阶段编排，不是一次原子调用） |

---

## 19. 可视化素材审计（上一轮结论，本阶段**不做**）

`DEFERRED / NOT BLOCKING`。本阶段：
`NO image generation` · `NO downloaded assets` · `NO placeholder PNG` ·
`NO Economy banner` · `NO product artwork`。

---

## 20. Commit

```text
P22-6 · add atomic Economy purchase settlement
```

四个 untracked 文件（`.dsh-research/`、`MOBILE_HOME_NODE_AUDIT.md`、
`Mobile Master Roadmap v1.md`、`docs/P22-0-ECONOMY-AUDIT.md`）保持 untracked，
未混入提交。

---

## 21. Stop Gate 的十二个问题

> **1. 一笔 Purchase 最终 settlement 是否真的只有一个 SQLite COMMIT 边界？**

**是，而且有三层证据。**

- **代码**：`settlePurchase` 的整个事务体在一个 `withTransaction(...)` 里；
  它调用的每一步都是**事务体内核**（`commitReservationInTx` /
  `commitLedgerTransactionInTx` / `mutateInventoryInTx`），而 `withTransaction`
  在 `txDepth > 0` 时**只增加深度、永不 COMMIT**。
- **运行期观测**（E1/E2）：把所有 `after-purchase-*` / `after-commit-*` /
  `after-reservation-*` / `after-inventory-*` 故障点当成探针，每一个都在
  `transactionDepth() >= 1` 时被命中；并且"深度从未回到 0 之后再上升"
  成立 —— 那正是两次 COMMIT 的形状。
- **故障注入**（F1–F11）：13 个点 × 七件事全部成立（见 §14）。

> **2. 是否可能出现 Ledger 已扣款，但 Inventory / Compute entitlement 没有发放？**

**不可能。** `after-transaction-insert` / `after-first-ledger-entry` /
`after-commit-ledger` 三个点注入之后：`transactions` / `entries` / `topology`
**逐字不变**、库存**一件未增**、Purchase 仍 RESERVED。§44 点名的那个形状
（"扣钱成功、发货失败"）被逐条证否。

> **3. 是否可能出现 Inventory 已发放，但 Ledger 没有扣款？**

**不可能。** `after-inventory-insert` 与 `after-inventory-write` 注入之后，
库存也**回滚**（`after.inventory === before.inventory`），账本未变。
§45 点名的那个形状（"东西到了但钱没扣"）被逐条证否。

> **4. Reservation → COMMITTED、Quote → CONSUMED、Purchase → COMPLETED 是否与 Ledger/settlement 同事务？**

**是。** 四者在同一个事务里按固定顺序写下（§7 的 ⑤⑥⑦⑧），任何一步抛错
都整体回滚：`after-reservation-committed` / `after-commit-reserved-cache` /
`after-purchase-quote-consumed` / `after-purchase-completed` 四个注入点之后，
四者**全部**回到注入前的状态（预留在库外仍是 ACTIVE、报价仍 OPEN、购买仍
RESERVED、库存未增）。

> **5. Prepare 时 ALLOW、Settlement 时 Budget 已变化的情况下，是否会重新评估并 fail closed？**

**是。** J1：Prepare 时 perTx=100000 → ALLOW；settle 前把 perTx 改成 100 →
最终 `AMOUNT_EXCEEDS_PER_TRANSACTION`。J2：日额度 500，Prepare ALLOW；另一笔
已提交的购买用掉 300 → 最终 `DAILY_LIMIT`。J4：政策期限走完 → 最终
`POLICY_NOT_FOUND` / `POLICY_TERM_EXPIRED`。三种都 fail closed，且都
"no Ledger mutation / no Inventory grant / no Quote consumption"。

> **6. 同一个 Purchase 被两个进程同时 settle，是否最多只产生一笔 Ledger Transaction 和一次资产发放？**

**是。** D 组：两个真实进程同时 settle ⇒ 恰好一笔 COMPLETED、`transactions = 2`
（mint + 购买）、`entries = 4`、库存总量 **1**、Quote 恰好 CONSUMED 一次、
Reservation 恰好 COMMITTED 一次，完整性零问题。三层结构性保证：唯一索引
`ledger_transaction_id`、`setPurchaseSettled` 的 `AND status=?`、以及
`transactionId = derive(purchaseId)` 的确定性派生。

> **7. 同一个 Quote 是否最多只能成功完成一次 Purchase？**

**是。** `economy_purchases.quote_id` 是 **UNIQUE**（不依赖任何状态检查）。
E 组：两个进程同时 prepare 同一份报价 ⇒ 库里恰好一条指向它的购买行。
H8/H9：先 prepare 一次、再 settle、再尝试同一份报价 ⇒ 拒绝且账本逐字未变。

> **8. Gift 是否做到 buyer 付款、recipient 收货，而没有修改 Relationship / Memory？**

**是。** G2：A 的余额 1000 → 600、B 的库存 0 → 1、**A 的库存一件都没有**；
ledger 的 `ownerId = cfg_a`（payer）、`recipientId = cfg_b`、
`txType = GIFT`；`relationshipMutation: false` / `memoryMutation: false`，
静态断言生产代码里没有 `relationshipSave` / `affection +` / `memorySave` /
`Memory.create`。

> **9. API_QUOTA / COMPUTE_CREDIT Purchase 是否已经能够增加 IB 内部 compute/API entitlement？**

**是。** G3：`API_QUOTA` 商品（400 / 1000）结算之后，A 的
`economy_inventory` 多出一行 `assetKind = COMPUTE`、`quantity = 1000`、
`unitName = computeUnit`；钱包同时 1000 → 600，交易类型是已冻结的
`COMPUTE_GRANT`（NEUTRAL，不占日额度）。

> **10. 上述额度增加是否完全没有调用真实 Provider、没有读取 Provider credential、没有真实充值？**

**是，四层都是结构性的。** ①依赖闭包仍 3 个 require 目标；②代码文本里没有
`topUpProvider` / `updateProviderBalance` / `checkoutUrl` / `paymentIntent` /
`submitPayment`；③`FORBIDDEN_PURCHASE_LEDGER_ACCOUNTS` 逐个点名否认
`provider:openai` / `provider:anthropic` / `provider:deepseek` /
`providerBalance` / `tokenBalance` / `apiBalance`；④输入的
`unitName` 被强制恰为 `computeUnit`（`tokens` / `usd` / `providerBalance`
被拒绝）。结算结果逐字写着 `providerMutation: false` /
`paymentMutation: false`。

> **11. HTTP 是否仍然只有只读 Economy 能力，没有 `/buy`、`/settle`、`/purchase` POST？**

**是，四层否认。** ①路由表：两条新路由都带 `&& method === 'GET'`；②名字：
装配层里**不存在** `preparePurchase` / `settlePurchase` / `cancelPurchase` /
`refundPurchase` / `reversePurchase`；③`/security` 自述：三项写面名单全空、
`purchaseExposed: false`、`unreachable` 逐条列着写形态；④运行期：真实生产
进程上 **24 次写尝试全部 405** `economy-is-read-only`。

> **12. P22-6 是否仍然完全离线可运行？**

**是。** 生产代码里没有 `fetch(` / `node:http` / `node:https` / `axios` /
`WebSocket` / `node:net` / `XMLHttpRequest`；整条链路（Product → Quote →
Budget → Reservation → Purchase → Ledger → Inventory/Compute）只碰
SQLite 与注入的时钟/随机源。全部 15 条 P22 测试（含真实子进程与多进程
竞争）在无网络条件下跑完。

**十二项全部可证明 ⇒ P22-6 闭环。**

