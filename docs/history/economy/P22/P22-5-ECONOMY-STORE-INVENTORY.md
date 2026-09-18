# P22-5 · Economy Store + Product Catalog + Inventory

```text
Status      FROZEN
Phase       P22-5（Agent Economy 的第五阶段）
Depends on  P22-1 Economy Contract · P22-2 Ledger + Wallet ·
            P22-3 Transaction + Reservation · P22-4 Budget Policy + Quote
Produces    economy_stores · economy_products · economy_inventory
            Store / Product Catalog / Inventory canonical truth
            createProductQuote（唯一 canonical 的报价生成路径）
Schema      3 → 4
Commit      P22-5 · add Economy store catalog and inventory
```

---

## 0 · 本阶段回答的三个问题

```text
「有哪些商品？」                    Store + Product Catalog
「一份商品到底是什么？」             kind / fulfillment / 单价 + 单位
「谁拥有什么？」                    Inventory（canonical 拥有事实）
```

它**不**回答：

```text
「Agent 应该买什么？」   → Decision（不属于 Economy）
「要不要批准这次购买？」 → Approval workflow（不属于本阶段）
「现在买下来」           → Purchase（不属于本阶段）
```

框架图上本阶段只建立了**上半条**链路，下半条仍然是一个明确的空白：

```text
Store → Product Catalog → Quote → Budget Evaluation     ← 本阶段建立
Inventory ↑ future Purchase                              ← 本阶段只建 canonical truth
```

`Purchase` 在本阶段**一个字都没有实现**。`grantInventory` / `consumeInventory`
是底层 primitive，不是购买（它们逐字写着 `ledgerMutation: false` /
`isAPurchase: false`）。

---

## 1 · 五个概念为什么必须分开

```text
Store     = 商品的组织 / 展示边界
Product   = 可报价的商品定义
Quote     = 某一时刻针对 Product 的价格命题
Inventory = 某 owner 已经拥有的经济资产事实
Purchase  = 把 Quote + Reservation + Ledger + Inventory 串起来的未来原子动作
```

以及六条不等式，它们是本阶段所有测试的骨架：

```text
Product   ≠ Quote        —— 一件商品可以有多份价格命题
Quote     ≠ Reservation  —— P22-4 冻结
Reservation ≠ Purchase   —— P22-3 冻结
Product   ≠ Inventory    —— 定义 ≠ 拥有
Inventory ≠ Wallet       —— 拥有的东西 ≠ 支付能力
Store     ≠ Product      —— 组织方式 ≠ 价格事实
```

每一条都有一个**结构性**后果，而不只是一句话：

| 不等式 | 结构后果 |
|---|---|
| Product ≠ Quote | `quotes` 表在 P22-5 加了**零**列。价格在报价自己的列上 |
| Product ≠ Inventory | 三张表各自独立；改商品不碰 inventory，entitlement 不碰 product |
| Inventory ≠ Wallet | 库存表里**没有** `currency` / `balance` / `*_minor` 列 |
| Store ≠ Product | 货架表里**没有** `price` / `currency` / `stock` / `owned` 列 |

---

## 2 · 修改 / 新增文件

| 文件 | 变更 |
|---|---|
| `services/home-node/economy-contract.js` | **M** — +641，全部是加法（§22 一节 + 5 处小加法） |
| `services/home-node/economy-store.js` | **M** — +1503，schema 3→4、三张表、`putStore`/`putProduct`/`createProductQuote`/`grantInventory`/`consumeInventory`、读面、完整性、health |
| `services/home-node/http.js` | **M** — +162（六条只读路由 + `/security` 的十一个新字段） |
| `tests/test_p22_5_economy_catalog.js` | **A** — 1376 行 · **139 项** |
| `tests/test_p22_5_economy_inventory.js` | **A** — 1003 行 · **98 项** |
| `tests/test_p22_5_economy_runtime.js` | **A** — 664 行 · **39 项**（真实子进程 + 多进程竞争） |
| `tests/fixtures/p22-5-consume-worker.js` | **A** — 65 行，多进程竞争用的 worker（fixture，不是测试） |
| `tests/test_p22_1_economy_domain_contract.js` | **M** — +229（五处冻结计数 + 新增 D-ADDITIVE-P22-5 组 26 项） |
| `tests/test_p22_1_economy_boundary.js` | **M** — +177（B4.4 名单 21→26 + 新增 B15 组 17 项） |
| `tests/test_p22_2_economy_store.js` | **M** — +18（`O9` 的可改表集合） |
| `tests/test_p22_4_economy_budget.js` | **M** — +14（`K1` 的水位断言） |
| `tests/test_p22_4_economy_runtime.js` | **M** — +20（`B18` 的 unreachable 名单） |
| `tests/test-all.js` | **M** — +43（登记三个新测试） |
| `docs/P22-5-ECONOMY-STORE-INVENTORY.md` | **A** — 1401 行 |

**Economy 生产文件 = 仍然是 2 个**（`economy-contract.js` · `economy-store.js`）。

**require 目标 = 仍然是 3 个**（`node:sqlite` · `runtime/db-failure.js` ·
`./economy-contract.js`）。三张新表的写路径必须与 `change_log` / `revision` /
`idempotency` 处在**同一个事务边界**里；抽成独立文件会把那个保证从结构事实
降级成跨模块约定。

---

## 3 · schema 版本 3 → 4

```text
P22-2  schema 1   meta / change_log / idempotency / accounts / wallets /
                  transactions / entries
P22-3  schema 2   + operations / reservations / operation_idempotency
P22-4  schema 3   + budget_policies / quotes
P22-5  schema 4   + stores / products / inventory        ← 本阶段
```

**3 → 4 的 `MIGRATIONS` 条目仍然是空的**，因为这三张表全是新增：

```text
一个 P22-4 的 build 打开 P22-5 的库  → 拒绝（SCHEMA_TOO_NEW）
一个 P22-5 的 build 打开 P22-4 的库  → 补三张表、水位抬到 4、
                                       既有行一个字节都不动
```

第一条比"打不开"更重要：如果旧 build 不拒绝，它会看到一个"什么都没得卖"的
经济，而任何基于"这件商品不存在"的判断都会在错误的**前提**上成立。

旧库的拒绝**不能顺手补表**。DDL 排在 `migrateSchema()` **之后**（P22-3 把这
条纪律提到最前，P22-5 继续遵守），测试用手工造的"水位 5 且缺三张表"的库逐表
断言：拒绝打开之后，`economy_stores` / `economy_products` / `economy_inventory`
**一张都没被创建**（J10）。

---

## 4 · Store schema

```sql
economy_stores (
  store_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  idempotency_key TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  revision INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)
```

**列清单是精确的**（A4 逐列比对）：多一列就失败。**没有**的列：

```text
priceMinor / currency / stock / owned / inventoryCount / providerBalance
```

理由（§2）：价格属于 Product / Quote，拥有关系属于 Inventory。把这些塞进货架
之后，"改一个名字"与"改一个价格"会变成同一张表上的两次写入，而它们在审计里
是两件事。

于是货架的序列化里逐字写着三句否认：

```js
holdsPrices:    false
holdsOwnership: false
holdsInventory: false
```

`sort_order` 只影响展示顺序，**不参与任何判定** —— 没有"按 sort_order 决定能
不能买"的写法，因为它没有后果可以产生。

---

## 5 · Product schema

```sql
economy_products (
  product_id TEXT PRIMARY KEY,
  store_id TEXT NOT NULL,
  product_kind TEXT NOT NULL,
  fulfillment TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  currency TEXT NOT NULL,
  unit_price_minor INTEGER NOT NULL CHECK (unit_price_minor >= 0),
  unit_name TEXT NOT NULL,
  grant_quantity INTEGER NOT NULL DEFAULT 0 CHECK (grant_quantity >= 0),
  asset_kind TEXT,
  status TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  revision INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)
```

### 5.1 金额字段必须带单位

列名是 `unit_price_minor` + `currency`，**不是** `price`。§3 禁止"没有单位的
金额字段"，而 `BUDGET_INPUT_KEYS` 那一套纪律在这里被复用成 `PRODUCT_INPUT_KEYS`：

```js
PRODUCT_INPUT_KEYS = ['productId', 'storeId', 'kind', 'fulfillment', 'name',
  'description', 'currency', 'unitPriceMinor', 'unitName', 'grantQuantity',
  'status', 'ifRevision', 'idempotencyKey']
```

传一个不在名单里的键 → **拒绝**（不是静默忽略）：

```text
product-input-key-is-forbidden:price        ← 点名否认的键
product-input-key-is-forbidden:discount
product-input-key-is-forbidden:trust
product-input-key-not-whitelisted:whatever  ← 只是不认识
```

两类错误刻意分开：`forbidden` 说的是"这个词属于另一个域"，`not-whitelisted`
说的是"我不知道这是什么"。合并它们会让"有人试图接真实支付"与"有人打错了
一个字段名"变成同一条日志。

`FORBIDDEN_PRODUCT_FIELDS` 有 38 个成员，分四组：

```text
没有单位的金额   price / cost / money / budget / amount / value
隐蔽库存         stock / owned / onHand / inventoryCount
provider 与凭据  providerApiKey / providerAccount / providerBalance /
                 providerTopup / providerQuota
真实货币         realMoney / realPrice / cny / usd / fiatAmount / checkoutUrl /
                 paymentIntent / paymentLink
个性化           discount / discountRate / promo / promotion / coupon /
                 featured / recommended / recommendation / personalized
关系与正文       trust / affection / affinity / familiarity / relationshipId /
                 memoryRef / prompt / llmOutput
```

### 5.2 单价 = 0 是**显式**合法值

§34 的问题（"免费商品允不允许"）在本阶段有这样两半答案，而且两半都被断言：

1. **Product 层允许**：`unitPriceMinor: 0` 是合法值，读回来是 `'0'`（不是
   `null`、不是被丢掉）。校验用的是 `o.unitPriceMinor == null` 而**不是**
   `!o.unitPriceMinor`：
   ```text
   unitPriceMinor: 0     → ok，价格是 '0'
   unitPriceMinor 缺失   → product-unit-price-minor-required
   unitPriceMinor: -1    → amount-minor-negative（normalizeAmountMinor 拒绝）
   ```
   "免费"与"忘了写价格"因此在**错误码层面**就是两件事。
2. **Quote 层拒绝**：P22-4 冻结了 `quote-amount-must-be-positive`，因此一份
   0 元商品**当前无法生成报价** —— 而本阶段刻意**不**为它开一条"免费报价"
   的路，因为那是静默重新解释 P22-4。免费发放走 `grantInventory` primitive，
   购买走 future Purchase。C7 逐字断言这条拒绝的理由来自 P22-4。

### 5.3 `CHECK` 约束不是注释

```sql
CHECK (unit_price_minor >= 0)
CHECK (grant_quantity >= 0)
```

A11 的做法是**绕过 store 直接对表写一个负数**，断言库自己拒绝。一个负价格是
一次反向流动，它不该只被 JS 层的一个 `if` 挡着。

---

## 6 · Product kind 与 settlement model

§4 的要求是"先审计已冻结的词表，再决定要不要新增枚举"。审计结果是：五个
kind **每一个都映射到 P22-1 已经冻结的语义**，没有一个是新的经济概念。

```js
PRODUCT_KIND = { DIGITAL_ITEM, CONSUMABLE, API_QUOTA, COMPUTE_CREDIT, SERVICE }

FULFILLMENT_OF_PRODUCT_KIND = {
  DIGITAL_ITEM:   INVENTORY_GRANT,     // §15 GRANT_INVENTORY
  CONSUMABLE:     INVENTORY_GRANT,
  API_QUOTA:      COMPUTE_GRANT,       // §16 compute tier
  COMPUTE_CREDIT: COMPUTE_GRANT,
  SERVICE:        SERVICE_EXECUTION    // §27 的反例：没有永久库存
}

ASSET_KIND_OF_PRODUCT_KIND = {
  DIGITAL_ITEM: ITEM, CONSUMABLE: ITEM,
  API_QUOTA: COMPUTE, COMPUTE_CREDIT: COMPUTE,
  SERVICE: null                        // 交付形态是执行，不是持有
}

PRODUCT_UNIT_NAME = {
  DIGITAL_ITEM: 'item', CONSUMABLE: 'item',
  API_QUOTA: 'computeUnit', COMPUTE_CREDIT: 'computeUnit',   // §16 冻结
  SERVICE: 'service'
}
```

### 6.1 交付形态是**派生**的，不是声明的

`fulfillment` 写在行上（与商品一起冻结，于是将来某个 kind 的映射变了，历史行
仍然说着当时的话），但它**不能被调用方声明**：

```text
kind: SERVICE + fulfillment: INVENTORY_GRANT
  → product-fulfillment-does-not-match-the-product-kind
```

否则"这件商品买完给库存还是给算力"会有两个答案。

### 6.2 SERVICE 的 `grantQuantity` 必须是 **0**

```text
SERVICE + grantQuantity: 0  → ok
SERVICE + grantQuantity: 5  → a-service-product-must-not-grant-inventory-quantity
DIGITAL_ITEM + grantQuantity: 0 → product-grant-quantity-must-be-positive
```

这不是"允许它是 0"，而是"它必须是 0"：一个 SERVICE 带着 5 意味着某个下游会
去加库存，而那正是 §54 要让 schema 拒绝的建模错误。`grantInventory` 面对一件
SERVICE 商品时同样拒绝（`this-product-fulfillment-does-not-produce-inventory`）。

### 6.3 载入期自检

契约在载入时就把三件事查一遍，任何一条不成立即**抛错**（而不是带着洞继续跑）：

```text
① 每个 kind 都有 fulfillment
② 每个 kind 都有 unit name
③ 每个 fulfillment 都**至少**被一个 kind 用到（SERVICE_EXECUTION 不是死分支）
```

第 ③ 条是刻意的：一个"从来没被走过"的分支在代码审查里看起来像是对的。

---

## 7 · Product lifecycle

```js
PRODUCT_STATUS = { ACTIVE, DISABLED, RETIRED }

PRODUCT_STATUS_TRANSITIONS = {
  ACTIVE:   [DISABLED, RETIRED],
  DISABLED: [ACTIVE, RETIRED],
  RETIRED:  []                  // 终态
}
```

```text
created                        → PRODUCT_CREATED
!statusChanged                 → PRODUCT_UPDATED   （改价 / 改名 / 改描述）
status === RETIRED             → PRODUCT_RETIRED
status === DISABLED            → PRODUCT_DISABLED
status === ACTIVE（重新上架）   → PRODUCT_UPDATED
```

**为什么 RETIRED 与 DISABLED 分开**：DISABLED 是可逆的（暂时不卖），RETIRED
是终局（这件商品的生命结束了）。合并之后"这件商品已经结束"这句话不再可信，
而一个"netflix 式下架又上架"的商品会让"当时买的是什么"变成一个更难回答的
问题。终态不可回退由 SQL 承担：

```sql
UPDATE economy_products SET status=?, ... WHERE product_id=? AND status=?
```

一个 `RETIRED` 的商品不可能再被 disable 或重新上架：`changes = 0` ⇒ 调用点
拒绝，拒绝码 `TRANSITION_NOT_ALLOWED`，detail 是
`a-retired-product-is-terminal-and-must-not-be-relisted`。

**一个开发期抓到的真实缺陷**：第一版的事件类型写法是

```js
created ? PRODUCT_CREATED
        : (statusChanged ? (status === RETIRED ? RETIRED : DISABLED) : UPDATED)
```

再补一句"状态回到 ACTIVE 时归回 UPDATED"。两句组合起来让**新建**一个 ACTIVE
商品也报成 `PRODUCT_UPDATED` —— 因为 `statusChanged` 的定义是
`!existing || existing.status !== status`，对一次创建来说它是 true，而 status
恰好是 ACTIVE。症状极隐蔽：商品建对了、状态对了、payload 里 `previousStatus`
也是 `null`，只有 `kind` 这一个字段在说谎，而"有几件商品被创建过"这个审计问题
因此答不出来。**是 inventory 测试的 change log 计数抓到的**（它期望 3 条
`PRODUCT_*` 却看到别的形状）。修法是把 create 放在最前面，让后面三个分支只处理
"已存在的商品的状态推进"。

### 7.1 商品本体不可变（§20）

```text
product_id · store_id · product_kind · fulfillment · asset_kind · created_at
```

这六列**不出现在任何 UPDATE 的 SET 里**。改其一等于换了一件商品：

```text
换 storeId → product-store-is-immutable-relisting-is-a-new-product
换 kind    → product-kind-is-immutable-a-different-kind-is-a-different-product
```

正确形态是新建一个 product（并用一个新的 id），而不是让同一个 id 的两个时刻
说出不同的话。**价格历史通过 Quote 冻结**，不是通过 productId v2。

### 7.2 两条写语句各管一半

```sql
updateProduct     SET name, description, currency, unit_price_minor, unit_name,
                      grant_quantity, idempotency_key, fingerprint, revision, updated_at
setProductStatus  SET status, idempotency_key, fingerprint, revision, updated_at
```

于是两条很强的、**可静态断言**的性质成立（E9/E10）：

```text
改价格的语句里没有 status
改状态的语句里没有 unit_price_minor
```

"改价不得顺带改变上架状态"因此不是纪律，而是两条语句各自都做不到。

---

## 8 · Product pricing 与"改价不重写历史"

### 8.1 价格与关系无关（§41）

`PRICING_IS_RELATIONSHIP_FREE = true` 是一条**可断言的常量**，而让它成立的
机制是白名单：`validateProduct` 收到的键必须在 `PRODUCT_INPUT_KEYS` 里。因此
`trust` / `affection` / `affinity` / `relationshipId` / `memoryRef` **没有地方
可以放** —— 不是"记得别传"。

```text
trust > 0.8  → 提高预算           结构上不可能
affinity 高  → 免除审批           结构上不可能
relationship 特殊 → 免费购买      结构上不可能
```

未来若真需要折扣，必须设计独立的 Discount / Promotion contract，而不是偷偷
塞进 Product getter。`discount` 在本阶段是一个**被点名否认的字段名**。

### 8.2 改价证据（§7 / §12 / §49）

```text
Product price = 100
create Quote Q1            → Q1.amount = 100
update Product price = 120 → Q1.amount = 100（逐字节不变）
                             新 Quote Q2.amount = 120
```

E 组的证据强度是逐级递进的：

| 断言 | 强度 |
|---|---|
| E1 | 初始：商品 100，Q1 = 100（数量 = 1 份 × grantQuantity 2 = 2） |
| E2 | 改价成功，返回里带着**改之前**的价格（审计需要"从多少改到多少"） |
| E3 | 返回与 change log 里都逐字写着 `rewriteOfHistoricalQuotes: false` |
| E4 | ★ Q1 的**整行序列化**之后逐字节不变（不是"金额没变"） |
| E5 | amount / currency / quantity / kind / settlementType 五项逐项仍是创建时的值 |
| E6 | 新报价 Q2 = 120，而 Q1 仍然是 100 |
| E7 | 两句价格命题**同时存在**于世界上（这正是 Quote 存在的理由） |

E4 的写法刻意是"整行"，因为"金额没变"是一句**弱**断言：币种、数量、种类、
结算形态、买家、受赠人、到期时间都可能被一次 reprice 顺手改掉，而只比金额的
测试看不见它们。

而且 P22-5 对 `quotes` 表加了**零**列（E8）：唯一的 UPDATE 仍然只赋
`state` / `revision` / `updated_at`。冻结已经由 P22-4 的列集合完成，再加一列
只会制造第二个价格来源。

---

## 9 · Product-backed Quote（§6 / §21）

### 9.1 两个入口，分工写在名字里

```text
createQuote(input)          P22-4 的底层 primitive —— **行为保留**
createProductQuote(input)   P22-5 的 canonical 路径 —— 价格只来自商品
```

§21 明确要求不要为了"接口统一"破坏 P22-4。因此 raw primitive 一个字没改，
新路径另开一个方法，并且新路径的**参数列表里根本没有金额**：

```js
const out = createQuote({
  buyerId:   o.buyerId,
  currency:  product.currency,                    // ← 来自商品
  amountMinor: derivedAmount.amountMinor,         // ← 来自商品
  quantity:  derivedQuantity.quantity,            // ← 来自商品
  kind:      derivedKind.kind,                    // ← 来自商品
  productId: product.productId,
  expiresAt: o.expiresAt
});
```

D2 断言：即使调用方传 `amountMinor / currency / quantity / kind`，
**它们也不会被读到**（结果仍然是 100 / IB_CREDIT / 1 / PURCHASE）。

### 9.2 派生规则

```js
productQuoteKindFor(fulfillment, hasRecipient)
  COMPUTE_GRANT       → COMPUTE_GRANT（配额被授予；与"买给谁"无关）
  INVENTORY_GRANT     → hasRecipient ? GIFT : PURCHASE
  SERVICE_EXECUTION   → hasRecipient ? GIFT : PURCHASE

productQuoteQuantity(product, units) = units × max(grantQuantity, 1)
productQuoteAmountMinor(product, units) = unitPriceMinor × units   （BigInt）
```

`max(grantQuantity, 1)` 那一下不是随手写的：§14 要求 `quote.quantity ≥ 1`，而
服务商品的 `grantQuantity` 由校验**必须**是 0。于是对交付型商品 quantity 是
**送达量**（API_QUOTA ×1000 的报价上写着 1000 computeUnit），对服务商品它是
**执行次数** —— 那是它唯一有意义的数量。

溢出**拒绝**而不是静默变形：`unitPriceMinor = MAX_SAFE_INTEGER` × 2 →
`product-quote-amount-exceeds-the-canonical-maximum`；`units = 2^53` →
`units-must-be-a-positive-safe-integer`。

### 9.3 raw primitive 的一处加法修正

P22-4 的 `createQuote` 把入参当**后缀**处理（`formatEconomyId('PRODUCT', o.productId)`）。
对 `'widget'` 没问题，但对一个**已经是 canonical** 的 id 会得到
`econ_product_econ_product_x` —— 一个指向不存在商品的 id。

那不是"两种风格"，那是一次**悬空引用**：报价会被写下来，而它的 provenance
永远查不到。P22-5 把它改成"已经是 canonical 就原样使用，否则才补前缀"：

```text
以裸后缀传入（P22-4 的全部用法）→ 结果逐字相同（D8）
以全 id 传入（createProductQuote）→ 不再双重加前缀（D7）
```

唯一被改变的是那种以前**必然**产生死引用的输入。

### 9.4 raw primitive 现在认识真实的目录

```text
deps.productExists 注入缝     语义一个字没改（P22-4 的公开面）
目录里**真的**有这件商品时    它的状态也要被尊重：
                              DISABLED / RETIRED / 货架被停用 → 拒绝
目录里没有这件商品时          行为与 P22-4 逐字相同
```

为什么这不算破坏 P22-4：那个阶段的库里**没有** products 表，这条查询永远
返回 `undefined`；P22-4 的全部断言继续逐字成立（它们的 productId 都是随手起的
`econ_product_*`）。真正被加严的只有"目录里确实有这件商品、而它已经不再卖"
这一种新情况 —— 它在 P22-5 之前根本不可表示。

### 9.5 Quote 是自包含的，Product 只是 provenance（§22）

§22 要求二选一，而且要**明确**。P22-5 选第二个，并且把两句话同时写在代码里：

```text
QUOTE_PRODUCT_RELATION = { PROVENANCE_ONLY, DEPENDENCY }
PRODUCT_IS_PROVENANCE_FOR_QUOTES = true
```

```text
报价的**经济事实**在它自己的列上（币种 / 金额 / 数量 / 种类 / 结算形态 /
买家 / 受赠人 / 到期）→ 因此即使 Product 行消失了，历史报价仍然是一句完整的话
Product 行是 provenance → 它缺失/损坏**仍然是一次完整性失败**，只是失败在
                           "目录这一面"，不在"报价这一面"
```

可执行的形状：

```js
productProvenanceOf(productId) → {
  productId, present, relation: 'PROVENANCE_ONLY',
  name, storeId, storePresent, storeStatus, status, fulfillment, revision,
  quoteEconomicContentDependsOnThisRow: false
}
```

`present: false` 是一个**完整的**答案，不是一次失败。函数签名收的是
**请求的 productId** 而不是一行 —— 这样"查不到时怎么办"这个决定不由调用方
各自回答。

J4–J7 用真实场景证明它：删掉商品行之后，旧的 raw quote 仍然可读、金额仍然是
100、`withProvenance` 明确说 `present: false`，而 `economyIntegrityCheck`
把它报成**一条** problem（`product-provenance-missing-the-quote-is-still-explainable`）；
商品被重建之后那条 problem 消失。

`GET /economy/quote` **默认不**返回 provenance（B11）：若它无条件发生，
"报价可读"就会悄悄依赖"商品行还在"。只有 `?provenance=1` 才顺带查一次。

---

## 10 · Inventory：canonical 拥有事实

```sql
economy_inventory (
  inventory_entry_id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  owner_type TEXT NOT NULL,
  product_id TEXT NOT NULL,
  asset_kind TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity >= 0),
  idempotency_key TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  revision INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (owner_id, product_id)
)
```

### 10.1 canonical 键 = (ownerId, productId)

它是一张**数据**表，不是注释：

```js
INVENTORY_CANONICAL_KEY = ['ownerId', 'productId']
```

§51 要求的"不能按 productId 全局扣库存"因此是结构性的：每一行都带着它的
owner，而所有写语句都以行 id（或 owner + product）为条件，**没有任何一条按
product_id 单独更新**（F5 静态断言）。

`listInventory` 必须给 owner 或 product 之一，否则拒绝：

```text
inventory-listing-requires-an-owner-or-a-product
```

拒绝而不是返回一个跨 owner 的大列表：一次"全局列库存"正是"按 productId 全局
扣库存"这类错误的温床。

### 10.2 库存**没有**派生缓存（§17）

§17 明确要求先判断需不需要，而不是为了和 Wallet 对称而人为造一个
`inventory_cached_quantity` 再写 rebuild。判断结果是**不需要**：

```text
canonical 库存就是 economy_inventory 的那一行，没有第二个数
→ 没有 rebuild、没有开库对账、没有漂移这个类别
```

因此 A 组不是"检查 rebuilt 对不对"，而是"检查 rebuild 这个东西根本不存在"：

```text
health().inventoryCanonical = 'sqlite-inventory-rows'
health().inventoryDerived   = 'none'
health().inventoryHasNoDerivedCacheToRebuild = true
typeof store.rebuildInventory === 'undefined'
表上没有 cache 相关的列
```

反向断言同时存在（A2）：`rebuildWalletBalance` 与 `rebuildReservedBalance`
**是**函数 —— 两条并存才说明这是一个被判断过的决定，而不是一次遗漏。

### 10.3 库存 ≠ 余额（§12）

表里没有 `currency` / `balance` / `*_minor` 列。序列化里逐字写着：

```js
isABalance: false
contributesToAvailableBalance: false
countsAsPaymentCurrency: false
```

`health().inventoryIsNotABalance === true`。

---

## 11 · grant / consume

```js
grantInventory({ ownerId, productId, quantity, idempotencyKey })
consumeInventory({ ownerId, productId, quantity, idempotencyKey })
```

两者是**同一个实现**（`mutateInventory(mode, input)`）的两个出口：差别只有
符号、守卫与 scope —— 三样都是参数。分成两份拷贝会让"并发安全"这条性质必须
被证明两次，而其中一次的证明通常会被漏掉。

### 11.1 §50 的算术逐个成立

```text
grant 10   → quantity 10（新建一行）
grant  5   → quantity 15（同一行累加，不是第二行）
consume 8  → quantity  7
consume 8  → DENY，quantity 仍然是 7
正好用光   → quantity 0，而**那一行保留**（§23）
```

不足的两种形态共用**一个** reason code，不同的 detail：

```text
从来没有过这一行  → INSUFFICIENT_INVENTORY · inventory-entry-not-found（available: 0）
有过但现在不够    → INSUFFICIENT_INVENTORY · inventory-quantity-is-insufficient
                    （带着 available 与 requested 两个数）
```

对调用方它们是同一件事（拿不出这么多），因此共用一个代码；而两个数字把差别
说清楚。

**刻意不是 `INSUFFICIENT_BALANCE`**（C4）："我还剩 3 个"与"我还有 300 元"是
两种完全不同的不足，它们的正确反应也不同（前者是"别用了"，后者是"去挣"）。
这与 P22-3 分出 `INSUFFICIENT_AVAILABLE_BALANCE` 的理由逐字同源。

### 11.2 primitive ≠ Purchase（§13）

```js
ledgerMutation: false
walletMutation: false
isAPurchase: false
notAPurchase: 'grantInventory is an inventory primitive; a purchase is quote +
               reservation + ledger + inventory in ONE transaction (a later phase)'
```

这三句也逐字写进 change log 的 payload（M4）。结构性证据（J5/G10）：两个函数
体里**没有一次** `commitLedgerTransactionInTx` / `applyDerivedBalances` /
`applyReservedCache` / `setWalletBalance` / `setWalletReserved` / `insertOperation` /
`insertReservation` / `insertQuote` / `setQuoteState`。

`grantInventory` 面对一件 SERVICE 商品时拒绝（`EFFECT_NOT_ALLOWED`）：
"给一次服务发库存"是一次建模错误。

### 11.3 数量不变量（§11 / §35）

```text
integer · ≥ 0 · 不接受 NaN / Infinity / 小数 / 负数 / 非数字 / 不安全整数
```

G1 用 **11 种**非法输入逐个断言拒绝，G2 断言 11 次拒绝之后**零痕迹**（没有行、
没有 change log）。

唯一物品在本阶段**不可表示**（§10）：契约用一条显式否认表达它
（`INVENTORY_UNIQUE_ITEMS_MODELLED = false` + `ASSET_KINDS` 里没有
`UNIQUE_ITEM`），运行时把"有人试图按实例发放"变成明确失败：

```text
instanceId / serial / uniqueItemId → unique-item-instances-are-not-modelled-in-this-schema
```

**安全整数边界**：数量可以到达 `2^53 − 1`，再 grant 2 会溢出 —— 拒绝
（`inventory-quantity-would-exceed-the-safe-integer-range`），数量**仍然是**
`2^53 − 1`，且 SQLite 里存的就是那个精确值（G5–G7）。不是静默变形、不是 NaN、
不是回绕。

---

## 12 · Inventory idempotency（§15）

两个 scope：

```js
OPERATION_SCOPE.INVENTORY_GRANT
OPERATION_SCOPE.INVENTORY_CONSUME
```

指纹覆盖 `{ ownerId, ownerType, productId, quantity }`：

```text
同 key + 同请求        → replay（quantity 不再变化）        D1 / D7
同 key + 不同 quantity → IDEMPOTENCY_CONFLICT              D2
同 key + 不同 owner    → IDEMPOTENCY_CONFLICT              D3
同 key + 不同商品      → IDEMPOTENCY_CONFLICT              D4
同 key 在 GRANT 与 CONSUME 下 → **两件事**（不是重放）      D5
同 key + '3' vs 3      → 同一个请求（数字与字符串归一化）    D8
```

D5 是本组最要紧的一条：把两个方向压成一个 scope 会让"我那次发放到底成没成"
收到一个关于消耗的答案。

---

## 13 · Inventory concurrency（§16）

```text
两个独立连接同时 consume 8，而库存只有 10 → 不能都成功
最终 quantity ≥ 0                         → 结构性保证
```

三道防线**同时**存在，而且刻意不依赖任何单点：

```text
① BEGIN IMMEDIATE —— 写锁在**读 canonical 数量之前**拿到，
   因此"读到的数"与"写回的数"之间不可能插入另一个 writer
② 带算术守卫的 UPDATE
     grow  : SET quantity = quantity + ? ... WHERE inventory_entry_id=? AND quantity + ? <= ?
     shrink: SET quantity = quantity - ? ... WHERE inventory_entry_id=? AND quantity >= ?
   changes ≠ 1 ⇒ 拒绝
③ 表上的 CHECK (quantity >= 0)
   即使前两道都被将来的重构破坏，负数量也进不了库
```

### 13.1 测试

```text
H1/H2  两个独立 store 实例（两个 SQLite 连接）同时 consume 8（库存 10）
       → 恰好一个成功、另一个 INSUFFICIENT_INVENTORY，最终 2
H3/H4  20 轮 × 两个连接各扣 1（库存 10）
       → 成功的次数**恰好** 10，最终恰好 0，
         change log = 基线 + 1 grant + 10 consume（失败零痕迹）
E1–E7  **四个真实子进程**在同一墙钟时刻同时 consume 8（库存 20）
       → 恰好 2 个成功、2 个被拒；最终 canonical = 4 且 ≥ 0；
         每个 worker 在自己连接上读到的数只可能是 20 / 12 / 4
```

E5 的写法值得说明：worker 的读发生在它的写之后、别的 worker 的写之前**或**
之后，因此它可能看到 20 / 12 / 4。**唯一不允许出现的是 −4** —— 那正是"两个 8
都扣成功"的形状，也正是本组要否证的那件事。断言 `seen.indexOf(-4) < 0`
比断言 `max === 4` 更准确。

A11 做的是同一件事的**数据库层**证明：绕过 store 直接对表写一个负数量，库
自己拒绝。

---

## 14 · Inventory 与"不物理删除经济历史"（§23 / §24）

```text
商品 RETIRED 之后 → 已有库存**仍然存在**（L1）
quantity = 0 的行 → **保留**（C6/C7），entryId 稳定，再 grant 时复用同一行
```

它们的可读性也**不依赖**商品行：`assetKind` / `ownerId` / `createdAt` /
`quantity` 都写在这一行上（L2）。

静态断言（L5/L6 + boundary B15.7）：

```text
生产代码里没有 DELETE FROM economy_stores
生产代码里没有 DELETE FROM economy_products
生产代码里没有 DELETE FROM economy_inventory
被允许 DELETE 的只有两张按 TTL 清理的**幂等表**
```

这条断言**必须先剥注释**：store 里有一句解释性注释逐字写着"没有 DELETE FROM
economy_inventory"，整文件 grep 会把它判成一次真实的删除 —— 而修法就会变成
"把解释删掉"。这与 boundary B3 的 `scanRequires` 踩过的是同一个坑，修的是
扫描器。

---

## 15 · 崩溃注入（§36 / §37）

```text
货架    after-store-insert · after-store-update ·
        before-store-change-log · before-store-commit                 4 个点
商品    after-product-insert · after-product-update ·
        after-product-status-transition ·
        before-product-change-log · before-product-commit             5 个点
库存    after-inventory-insert · after-inventory-write（grow + shrink）·
        before-inventory-change-log · before-inventory-commit         4 个点
```

每个点都断言五件事：

```text
① 抛出的是**注入的**那个错误
② 没有残留部分行（商品 / 库存 / 货架回到注入前）
③ revision 与 change log 回到注入前
④ 幂等表没有留下残渣
⑤ 在**干净**的 store 上，同一个 key 重试**真的**成功且只成功一次
```

库存那一组的三种坏形状被逐条点名（§37）：

```text
quantity changed but no audit       → 不可能（同一事务）
audit exists but quantity unchanged → 不可能（同一事务）
idempotency residue after rollback  → 不可能（第 ④ 条断言）
```

**开发期踩到的一个坑**（写在测试注释里）：`faultPoint` 在同一实例上会**再次**
命中，因此"回滚之后同一个 key 重试成功"如果在新旧混用的实例上跑，测到的是
"注入还在"，而不是"幂等表没有残渣"。库存那一组还多一层：`before-inventory-*`
这两个点**同样**落在**播种**的那次 grant 上，于是"先建 fixture 再注入"会让
注入在真正被测试的动作之前就把整个 body 抛穿。修法是把**播种**与**注入**分成
两个实例：先在干净的 store 上播种、关掉，再用带注入的实例重新打开同一个库。

---

## 16 · 重启恢复（§38）

```text
create store → create product → grant inventory → create product-backed quote
→ close → open
```

重启之后**五样**逐字相同（I1）：

```text
Store identical
Product identical
Inventory identical
Quote identical
Budget result identical
```

而且**重启不消耗 revision**（I2）。库存没有派生缓存，因此没有"开库对账"要跑
（这与 P22-2/P22-3 的 `reconcileReservations` 是一次刻意不同的选择）。

---

## 17 · revision / change log（§14 / §19）

八条新事件类型：

```text
STORE_CREATED · STORE_UPDATED
PRODUCT_CREATED · PRODUCT_UPDATED · PRODUCT_DISABLED · PRODUCT_RETIRED
INVENTORY_GRANTED · INVENTORY_CONSUMED
```

全部写 `ledgerMutation: false`。目录面的 payload 还各自带着：

```text
STORE_UPDATED     priceMutation: false · ownershipMutation: false
PRODUCT_UPDATED   rewriteOfHistoricalQuotes: false · ledgerMutation: false
INVENTORY_*       walletMutation: false · isAPurchase: false
```

四条新 scope：

```text
STORE · PRODUCT · INVENTORY_GRANT · INVENTORY_CONSUME
```

**为什么配置数据也要幂等**（§19）：一次 store/product 写入同样会消耗一个
revision、写一条 change log、并在崩溃后留下**部分**状态 —— 它与一次 reserve
面对的是同一个重试问题。把它们排除在幂等之外，等于让"配置数据"成为唯一一种
崩溃后必须靠人工判断的写。

M3 断言 change log 仍然是一条**无洞**序列（`revision === changes.length` 且逐条
递增），M6 断言库存事件的 `entityId` 是 inventory entry id（"哪一行变了"可以
被直接回答），M7 断言 payload 里带着 `previousQuantity` 与 `delta`。

---

## 18 · HTTP surface（§31 / §33）

```text
GET /economy/stores          列出货架（可按 status 过滤）
GET /economy/store           单个货架（storeId）
GET /economy/products        列出商品（storeId / status / kind / currency）
GET /economy/product         单个商品（productId）
GET /economy/inventory       列出库存（ownerId 或 productId 之一必填）
GET /economy/inventory-entry 单条（inventoryEntryId 或 ownerId + productId）
```

**没有**：

```text
POST /economy/store             405
POST /economy/product           405
POST /economy/inventory/grant   405
POST /economy/inventory/consume 405
POST /economy/purchase          405
```

§33 明确要求**不**开 `POST /economy/quote`，即使现在 Product 已经存在：
"谁可以要求系统为哪个 buyer 创建报价"仍然属于未来的 Decision/Action/Store
interaction 权限层。本阶段 HTTP 只展示已有的 canonical facts。

证据强度：

```text
B13  十条路径 × 三种写动词 = 30 次写尝试 → 全部 405 economy-is-read-only
B14  这些写尝试之后目录 / 库存 / 报价 / 钱包 / 账本一个字节都没变
B15  再跑一轮 10 次写尝试 → 世界仍然逐字未变
D4   生产子进程上的 POST 同样是 405（不是"开发机上挡着、生产上开着"）
```

`desktopPaths` 与 `unreachable` 必须**同时**更新：三条路径
（`/economy/inventory` · `/economy/store` · `/economy/product`）从
`unreachable` 里被**移走**（它们现在真的有只读路由了），换进来的是它们的
**写形态**。一条声明若比真实路由更保守，它就不再是在描述这个系统；而一条不再
为真的声明比没有声明更危险 —— 它会让人以为已经检查过了。

---

## 19 · `/security`（§32）

```js
economyPolicy: {
  httpVerbs: ['GET'],
  writesExposed: [], reservationWritesExposed: [], budgetWritesExposed: [],
  quoteWritesExposed: [],
  storeWritesExposed: [], productWritesExposed: [], inventoryWritesExposed: [],
  purchaseExposed: false,
  mintingExposed: false,
  inventoryCanonical: 'sqlite-inventory-rows',
  inventoryIsABalance: false,
  storeHoldsPrices: false, storeHoldsOwnership: false,
  productPricingIsRelationshipFree: true,
  catalogIsPersonalized: false,
  budgetEvaluationIsASnapshotOnly: true,
  budgetEvaluationReservesFunds: false,
  quoteLocksFunds: false,
  budgetTimezone: 'UTC'
}
```

`purchaseExposed: false` 是**显式**的：购买在本阶段不存在，而"不存在"必须是
一个可断言的字段，而不是"路由表里碰巧没写"。

`store.health()` 的自述同步扩展：

```text
doesNotExpose += 'store-writes', 'product-writes', 'inventory-writes', 'purchase'
storeCanonical / productCanonical / inventoryCanonical 三处各自指向一张表
inventoryDerived: 'none'
inventoryHasNoDerivedCacheToRebuild: true
inventoryIsNotABalance: true
inventoryUniqueItemsModelled: false
aGrantIsNotAPurchase: true
purchaseIsNotImplementedInThisPhase: true
```

---

## 20 · 隔离

### 20.1 Provider（§43）

三层，与 P22-4 同源但对象换成了目录：

```text
① 依赖闭包（boundary B15.2/B15.3）：仍然只有 3 个 require 目标
② 代码文本（B15.4）：没有 topUpProvider / purchaseProviderCredits /
   updateProviderBalance / providerBillingMutation / checkoutUrl /
   paymentIntent / submitPayment / commitSpend
③ 输入面（B15.3 + D22.16）：FORBIDDEN_PRODUCT_FIELDS 里逐个点名
   providerApiKey / providerAccount / providerBalance / providerTopup / providerQuota
```

API_QUOTA 商品只是 **IB 内部 entitlement 命题**：`unitName` 对 compute 两类
**必须恰是** `computeUnit`（§16 冻结），因此"这家店卖的是 provider token"这句
话在字形上就不可能成立 —— `tokens` / `usd` / `providerBalance` 做单位名会被
`isForbiddenComputeAlias` 拒绝（C20 / D22.12）。

### 20.2 Payment / 真实购物（§42）

```text
B13.1/B13.2（继续成立）Economy 生产代码里没有 maxBudget / commerce / alipay /
                        pay-gate / credential-vault / shopping
B15.4                没有任何新增的真实支付动词
B15.3                反向：FORBIDDEN_PRODUCT_FIELDS 里确实有点名的键
                     （没有这条，上面那些静态检查就在保护空气）
```

### 20.3 Memory / Relationship（§44 / §45）

```text
Economy → Memory        NO WRITE（只写自己的 change log 与 inventory 事实）
Economy → Relationship  NO WRITE（继续断言没有 affection/trust += 形态）
```

`"角色拥有了某物"` **不会**自动写进 Memory —— 那是未来的 integration，由
Memory 侧决定是否消费 economy event，不是 Economy 的写路径。

### 20.4 Decision / Action（§46）

```text
P22-5 回答：有哪些商品 / 商品是什么 / 当前报价是什么 / 角色拥有什么
P22-5 不回答：Agent 应该买什么
P22-5 不执行：buy(product)
```

可断言形式：`typeof store.recommendProducts === 'undefined'` ·
`typeof store.acceptQuote === 'undefined'` · `typeof store.purchase === 'undefined'` ·
`typeof store.buy === 'undefined'` · `typeof store.consumeQuote === 'undefined'`。

### 20.5 Store 不是推荐系统（§40）

`listStores` / `listProducts` 刻意**不接受**任何"给谁看"的参数：没有
`ownerId`、没有 `relationshipId`、没有推荐输入。C25 的写法是：给
`listProducts({ query: 'cheap widget', recommended: true })` 传这些参数，
结果与不传**完全相同** —— 它们不是被"忽略"（那会留下一个静默失效的接口），
而是根本没有地方可以放。

---

## 21 · 未来兼容性 fixture

### 21.1 Gift（§26 / §52）

```js
createProductQuote({ productId, buyerId: 'cfg_a', recipientId: 'cfg_b' })
  → { buyerId: 'cfg_a', recipientId: 'cfg_b', kind: 'GIFT',
      settlementType: 'GIFT', amountMinor: '60' }
```

而创建这份报价之后，**B 的库存一点都没变**、A 的钱包也没变（K2）—— 这是
"Quote ≠ Purchase"的第二次证明（第一次在 P22-4 的 C 组）。

compute 额度报价**不能**被当作礼物送出：它没有"把这 1000 个额度记在别人头上"
的形态（K3）。

### 21.2 Compute / API quota（§53 / §5）

```js
Product: name = 'Premium Compute ×1000', kind = 'API_QUOTA',
         currency = 'IB_CREDIT', unitPriceMinor = 400,
         grantQuantity = 1000, unitName = 'computeUnit'

createProductQuote → { currency: 'IB_CREDIT', amountMinor: '400',
                       quantity: 1000, kind: 'COMPUTE_GRANT',
                       settlementType: 'COMPUTE_GRANT' }
```

它的意思精确地是：

> 花 400 IB_CREDIT，未来 Purchase 成功后获得 1000 个 IB computeUnit。

而**不是**"给 OpenAI / Anthropic / DeepSeek 充值"。

结算形态落在**已冻结**的 transaction type 上（K5）：
`QUOTE_SETTLEMENT_TYPE.COMPUTE_GRANT === TX_TYPE.COMPUTE_GRANT`，因此不需要
新造 transaction 语义、也不需要碰 provider。`COMPUTE_GRANT` 是 NEUTRAL
（K6）：额度是**被授予**的，不花这个 owner 的日额度。

### 21.3 Service（§27 / §54）

```js
Product: kind = 'SERVICE', grantQuantity = 0, assetKind = null,
         fulfillment = 'SERVICE_EXECUTION'
createProductQuote → ok（schema **不**要求 grantQuantity > 0）
grantInventory     → EFFECT_NOT_ALLOWED（服务不产生库存）
```

§27 的要求是"不要设计成每个 Product 购买后都必须增加 inventory"，而 SERVICE
就是那个反例。交付形态因此是一个显式的、封闭的、创建时冻结的字段，而不是让
下游按 kind 猜。

K10 断言三类商品（数字物品 / 算力额度 / 服务）在同一个目录里共存，K11 断言
商品表的列清单里**没有**任何 RPG 专属字段（`equipSlot` / `rarity` / `attack` /
`level`）—— schema 没有被写死成"只能表达 RPG 物品"。

---

## 22 · 新增封闭词表与加法清单

### 22.1 契约的加法（逐项）

| 项 | 内容 | 为什么不能复用 |
|---|---|---|
| `ID_PREFIX.STORE` | `econ_store_` | 第 14 种 id 形状 |
| `OPERATION_SCOPE` +4 | `STORE` `PRODUCT` `INVENTORY_GRANT` `INVENTORY_CONSUME` | 四个不同的重试问题 |
| `EVENT_TYPE` +8 | 见 §17 | 目录与库存各需要可分辨的事件 |
| `DENY_REASON` +5 | 见 22.2 | 各自指向一个具体的域 |
| `STORE_STATUS` | ACTIVE / DISABLED | 与 POLICY_STATUS 是两个域在说同一句短话 |
| `PRODUCT_STATUS` | ACTIVE / DISABLED / RETIRED | POLICY_STATUS 没有 RETIRED |
| `PRODUCT_KIND` | 五个 | 每一个都映射到 §15/§16 已冻结的语义 |
| `FULFILLMENT` | INVENTORY_GRANT / COMPUTE_GRANT / SERVICE_EXECUTION | §27 要求交付形态显式 |
| `ASSET_KIND` | ITEM / COMPUTE | 刻意没有 UNIQUE_ITEM（§10） |

**没有任何既有字面值被修改或删除。**

### 22.2 五个新 reason code

| 代码 | 场景 | 为什么不复用 |
|---|---|---|
| `INSUFFICIENT_INVENTORY` | 库存不足 / 行不存在 | 库存不是余额（§12） |
| `PRODUCT_NOT_FOUND` | productId 指向不存在的商品 | P22-4 把它也写成 PRODUCT_DISABLED（那时没有目录）；"id 错了"与"不能卖"的正确反应不同 |
| `STORE_NOT_FOUND` | storeId 指向不存在的货架 | 同上，一层更外 |
| `CATALOG_INPUT_NOT_STRUCTURED` | 货架 / 商品的输入形状错误 | POLICY_INPUT_NOT_STRUCTURED 说的是政策；一个泛化的兜底名正是 §4 禁止的 |
| `INVENTORY_INPUT_NOT_STRUCTURED` | 库存 primitive 的输入形状错误 | 同上，另一个具体的域 |

`DENY_REASONS` 从 35 涨到 **40**，而 domain contract 测试里的
`C.DENY_REASONS.length === 40` 是**手写**的：加一个代码必须有人手动改那一行。

### 22.3 为什么 `STORE_STATUS` 不复用 `POLICY_STATUS`

两者今天恰好都有 ACTIVE / DISABLED。但它们回答的问题不同（"这条规则生效吗"
vs"这个货架开着吗"），而共用一套词表意味着将来给其中一个加成员会**静默地**
改写另一个的语义。两个字母相同的封闭集合不是重复，是两个不同的域在说同一句
短话。

---

## 23 · regression 与三处有意修改

| 测试 | 结果 | 本阶段测得的断言行数 |
|---|---|---|
| `test_p22_1_economy_domain_contract.js` | **全部通过 ✔** exit 0 | 275 → **300**（+25：D22 组 26 项，其中一条与既有断言合并） |
| `test_p22_1_economy_boundary.js` | **全部通过 ✔** exit 0 | 116 → **133**（+17：B15 组；2 生产文件 · 3 require 目标） |
| `test_p22_2_economy_store.js` | **全部通过 ✔** exit 0 | **203** |
| `test_p22_2_economy_runtime.js` | **全部通过 ✔** exit 0 | **66** |
| `test_p22_3_economy_reservation.js` | **全部通过 ✔** exit 0 | **313** |
| `test_p22_3_economy_runtime.js` | **全部通过 ✔** exit 0 | **55** |
| `test_p22_4_economy_budget.js` | **全部通过 ✔** exit 0 | **140** |
| `test_p22_4_economy_quote.js` | **全部通过 ✔** exit 0 | **122** |
| `test_p22_4_economy_runtime.js` | **全部通过 ✔** exit 0 | **47** |
| `test_p22_5_economy_catalog.js` | **全部通过 ✔** exit 0 | **139** |
| `test_p22_5_economy_inventory.js` | **全部通过 ✔** exit 0 | **98** |
| `test_p22_5_economy_runtime.js` | **全部通过 ✔** exit 0 | **39** |

**P22 全量 12 条：1655 项 · 0 失败。**

**四处有意修改，每一处都让断言更强：**

1. **`O9`**（P22-2 store）：可改表集合加上 `STORES_TABLE` / `PRODUCTS_TABLE` /
   `INVENTORY_TABLE`，注明它们改的是"组织方式 / 商品现在 / 数量与记账元数据"，
   而不是任何一笔已发生的经济事实。三个 ledger 事实表与 `ACCOUNTS` 仍不在允许
   集合里，`O9b` 继续逐字断言。
2. **`K1`**（P22-4 budget）：写死的水位 `3` 改成"等于本 build 声明的版本"。
   它问的是"旧库有没有被抬到当前水位"，与具体数字无关；写死会让**下一次**抬
   水位的人被迫改一条与 P22-4 无关的断言。
3. **`B18`**（P22-4 runtime）：`/economy/inventory` · `/economy/store` ·
   `/economy/product` 从 `unreachable` 的期望里**移走**（它们现在真的有只读
   路由了），换成它们的**写形态**，并且**反向**断言那三条不再被说成不可达。
4. **`D13.15` / `D14.2` / `D11.1` / `D14.26` / `D14.28`**（P22-1 contract）：
   五个冻结计数从 7→11 scope、35→40 reason code、13→14 id 种类逐条改。
   这些数字**必须**手动改 —— 它们的存在就是为了让"有人悄悄加了一个代码"失败。

### 23.1 aggregate

```text
node tests/test-all.js --quick

  static   93 项 · 270.4s · 3 失败
  service  29 项 · 107.8s · 全部通过
总耗时 378.3s · 3 项失败 ✘
```

**P22-5 确实出现在 aggregate output 里**：

```text
│ PASS    test_p22_5_economy_catalog.js  (2.3s)
│ PASS    test_p22_5_economy_inventory.js  (2.3s)
│ PASS    test_p22_5_economy_runtime.js  (7.8s)
```

（static 从 90 → 93 项，正是登记进去的三个新测试。）

### 23.2 baseline counterproof（`a92a0d7`，即 P22-4 完成提交）

在 `a92a0d7` 的干净 worktree 上跑**同一条命令**（`node tests/test-all.js --quick`），
跑完即删（`git worktree list` 只剩主工作树）：

```text
static  90 项 · 220.7s · 9 失败
service 29 项 · 106.7s · 全部通过
```

那份 9 项里，**6 项是 worktree 环境缺失造成的**（`test_node_runtime.js` ·
`test_installer.js` · `test_installer_mock.js` · `test_update_install.js` ·
`test_pe_version.js` · `test_welcome_canvas_payload.js` 依赖内置运行时与已构建
的安装产物，一个全新的 worktree 里没有；`test_p22_2_economy_runtime.js` 需要
内置 node 才能 spawn）—— 它们与 P22-5 无关，也**不是**本阶段引入的失败。

于是逐条对照：

| 失败 | baseline（a92a0d7） | P22-5 | 判定 |
|---|---|---|---|
| `test_cache_audit.js` | **exit 1** | **exit 1** | **既有**，与 P22 无关 |
| `test_middle_brain_convergence_counterproof.js` | **exit 1**（`0 passed, 11 failed`） | **exit 1** | **既有**，与 P22 无关 |
| `test_astra_readiness_observe.js` | **exit 0**（`PASS Z1.noProductionFileChanged`） | **exit 1** | **P22 触发，但它是阶段守卫**：唯一失败的断言是 `Z1.noProductionFileChanged -> services/home-node/economy-contract.js / economy-store.js / http.js`，它断言 `git diff --name-only HEAD -- assets services InternalBeyond.html` 必须为**空**，即"本阶段不得改生产文件"。它在 P22-1 之前 PASS、在任何触及 `services/` 的阶段 FAIL，**不是产品不变量，也不表示功能回归**。 |

### 23.3 一次被如实记录的 flake

第一次 aggregate 跑出了**第四个**失败：`test_role_dm_smoke.js`（浏览器 smoke，
1.3 s 就失败在"run 完成并产生 2 轮"）。

同一条测试在**本树隔离运行 4 次全部通过**（`结果: 41 通过, 0 失败`），而最终的
第二次 aggregate 里它 **PASS**。它测的对象（角色私信的两轮 run 循环）与 Economy
没有任何共用生产代码，而 P22-5 改的三个文件里只有 `http.js` 是共享的 —— 新增的
是六条 `/economy/*` 只读路由，不可能影响 `/role-dm` 的执行路径。

因此结论是**时序敏感的一次 flake**，而不是本阶段引入的回归。写在这里而不是删掉，
是因为"某个浏览器 smoke 在大批量串行运行时会偶发失败"本身就是一条应当被知道的
事实；把它藏起来会让下一次遇到它的人重新走一遍这条排查路。

---

## 24 · 最终回答（§63）

> **Product 改价后，已经存在的 Quote 是否仍保持创建时的价格？**

**是，而且证据是"整行逐字节不变"，不是"金额没变"。**

- **代码**：`quotes` 表在 P22-5 加了**零**列。报价的价格在它自己的列上
  （`currency` / `amount_minor` / `quantity` / `quote_kind` / `service_role`），
  而 `putProduct` 的函数体里**没有一次**触及 quotes 表。
- **E4**：`Product 100 → Q1 = 100 → Product 120 → Q1 的整行序列化逐字节不变`。
  只比金额是一句**弱**断言：币种、数量、种类、结算形态、买家、受赠人、到期时间
  都可能被一次 reprice 顺手改掉。
- **E2/E3**：改价的返回里带着**改之前**的价格，并且返回与 change log 里都逐字
  写着 `rewriteOfHistoricalQuotes: false`。
- **E6/E7**：新报价 Q2 = 120，而两句价格命题**同时存在**于世界上 —— 这正是
  Quote 存在的理由（P22-1 §14 要消灭的序列是 `check 50 → 改价 → commit 80`）。
- **E5**：amount / currency / quantity / kind / settlementType 五项逐项仍是
  创建时的值。
- **B12**：在**生产进程**里做同一件事：改价之后 `GET /economy/product` 报 999，
  而 `GET /economy/quote` 仍然报 100。
- **结构性原因**：唯一写 quotes 的 UPDATE 只赋 `state` / `revision` /
  `updated_at`（E8 静态扫 SET 列），而改价的语句里**没有** `status`、改状态的
  语句里**没有** `unit_price_minor`（E9/E10）。

> **Product 被 disable / retire 后，已经拥有的 Inventory 是否仍然存在？**

**是，而且"下架"与"终局"在这一层有完全相同的后果 —— 只有一个：不能创建新报价。**

- **F1/F2**：商品被停用之后，新的 product-backed 报价与 raw 报价**都**被拒绝
  （`PRODUCT_DISABLED`，detail 指出真实状态）。
- **F3/F4**：★ 已有报价 Q1 **整行逐字节不变**，而且仍然是 `OPEN` —— 报价的
  有效性只由它自己的 `state` 与 `expiresAt` 决定。若商品的状态能改报价的有效性，
  一次 Product mutation 就会偷偷重写历史报价，"当时是多少钱"将不再有答案。
- **F5**：★ 已有库存不变（数量、entry id、assetKind、createdAt 全部不变）。
  下架**不会**把用户已经拥有的东西删掉（§24）。
- **F7/F8**：RETIRED（终态）之后，新报价同样被拒（detail 里是 RETIRED），而
  历史报价与库存**仍然**逐字不变。
- **L1/L2/L3/L4**：retire 之后库存行仍然存在且完整（`assetKind` / `ownerId` /
  `createdAt` 都写在这一行上，因此**不依赖商品行**也能读懂它是"什么"），而且
  消耗与 grant 都仍然可以 —— 已经拥有的东西可以被用掉，它与"能不能再买"无关。
- **F9**：货架被停用 → 它上面的商品买不了（否则 DISABLED 只是一个装饰性的
  字段）。
- **§23**：`DELETE FROM economy_inventory` / `economy_stores` /
  `economy_products` 在生产代码里**一条都没有**（L5/L6 + boundary B15.7 静态
  断言，并且先剥注释以免把一句"没有 DELETE"的解释判成删除）。

> **创建 Product-backed Quote 是否仍然完全不会锁钱、扣钱或发放 Inventory？**

**是，而且这一点被"对照组"证明过不是假绿。**

- **G1/G2**：连开三份报价之后，"经济那一半"（钱包含 available 与 cached、
  reserved、ledger entries、transactions、reservations、operations、policies）
  的指纹**逐字未变**，`available` 仍为 1000、`reserved` 仍为 0。
- **G3**：0 笔 transaction / reservation / operation 被这三份报价创建。
- **G4**：三份报价各自逐字声明 `reservedFunds: false` / `ledgerMutation: false`。
- **G5/G6**：只有"命题那一半"在变（报价 3 份），库存 0 条，三份报价**全部**
  仍然是 `OPEN`（没有一份被"顺手消费掉"）。
- **G7/G8/G9 对照组**：真的 `reserve` 一次时，**同一个指纹确实会变**、
  `available` 变成 900；`release` 之后回到 1000 而报价一份都没少 —— 证明 G1
  不是"指纹不敏感"。
- **G10 结构性**：`createProductQuote` 的函数体里没有一次
  `commitLedgerTransactionInTx` / `applyReservedCache` / `setWalletBalance` /
  `setWalletReserved` / `reserveFunds` / `commitReservation` /
  `insertReservation` / `insertOperation` / `insertInventory` /
  `growInventory` / `shrinkInventory` / `setQuoteState` / `allocateRevision` /
  `appendChange`。
- **G11**：`productAvailabilityForQuote`（报价前的那次可用性查询）同样是纯读。
- **K2**：Gift fixture 同一件事的第二次证明 —— 创建一份
  `buyerId = A / recipientId = B` 的报价之后，**B 的库存一点都没变**。
- **B14/B15**：HTTP 面上 40 次写尝试（十条路径 × 三种写动词 + 第二轮十次）
  之后世界逐字未变。

> **Inventory 是否有独立 canonical truth，而不是藏在 Product / Wallet / Memory 中？**

**有，而且它**就是**那一行 —— 没有派生缓存，因此没有 rebuild、也没有对账。**

- **独立的表**：`economy_inventory`，`UNIQUE (owner_id, product_id)`，列清单
  恰好 11 列（A7）。**没有** `currency` / `balance` / `*_minor`（A8）：
  库存不是钱包（§12）。
- **没有缓存**（§17）：`inventory_canonical` 就是那一行；`health()` 逐字自述
  `inventoryDerived: 'none'` 与 `inventoryHasNoDerivedCacheToRebuild: true`；
  `typeof store.rebuildInventory === 'undefined'`；表上没有任何 cache 列。
  反向断言同时存在：`rebuildWalletBalance` 与 `rebuildReservedBalance` **是**
  函数 —— 两条并存才说明这是一个被判断过的决定，而不是一次遗漏。
- **不在 Product 里**：商品表的列清单里**没有** `owned` / `stock` / `count`
  （A5/A6），而 `serializeProduct` 逐字写着 `holdsOwnership: false`。
- **不在 Wallet 里**：J1/J2 两个方向都证 —— grant 500 件物品 + 1000 个算力额度
  之后钱包**逐字节未变**；铸币 2500 之后库存**一个字节都没动**。
- **不在 Memory 里**：Economy 生产代码里没有 `memory-store` /
  `memory-contract` 的依赖，也没有任何记忆写入形态（N1）。
- **canonical 键是数据**：`INVENTORY_CANONICAL_KEY = ['ownerId', 'productId']`，
  测试与 store 都读它。
- **多 owner 隔离**（§51）：A 有 10、B 有 3，A 消耗 7 之后 B 的 3 **一个字节
  都没动**（E2/E3），`listInventory` 拒绝"全局列库存"（E4）。

> **两个并发 consume 是否可能把 Inventory quantity 扣成负数？**

**不可能，而且这一点由三道**同时存在**的防线保证，不依赖任何单点。**

```text
① BEGIN IMMEDIATE：写锁在**读 canonical 数量之前**拿到
② 带算术守卫的 UPDATE：shrink 的 WHERE 里有 `quantity >= ?`（changes ≠ 1 ⇒ 拒绝）
③ 表上的 CHECK (quantity >= 0)：绕过前两道也进不了库
```

- **H1/H2**：两个独立 store 实例（两个真实 SQLite 连接）同时 consume 8
  （库存 10）→ **恰好一个**成功，最终 2 且 ≥ 0。
- **H3/H4**：20 轮 × 两个连接各扣 1（库存 10）→ 成功的次数**恰好** 10，最终
  恰好 0，而**每一次失败都留下零痕迹**（change log = 基线 + 1 grant + 10 consume）。
- **E1–E7（真实子进程）**：**四个**真实进程在同一墙钟时刻（±1.5 s 窗口内）
  同时 consume 8（库存 20）→ **恰好 2 个**成功、2 个以 `INSUFFICIENT_INVENTORY`
  被拒；最终 canonical 数量 = 4 且 ≥ 0；每个 worker 在自己连接上读到的数只可能
  是 20 / 12 / 4 —— **−4（"两个 8 都扣成功"的形状）一次都没有出现**。
- **A11**：绕过 store 直接对表写一个负数 → **数据库自己拒绝**（那条 CHECK 是
  真的在执行）。
- **G6**：另一个方向的上界也受检：grant 到 `2^53 − 1` 之后再 grant 2 → 拒绝，
  数量仍然是 `2^53 − 1`，SQLite 里存的就是那个精确值。

> **API_QUOTA / COMPUTE 商品是否仍然只是 IB 内部经济商品，没有任何 Provider top-up 或真实支付路径？**

**是，而且在三层上都是结构性的。**

- **数据模型**（K4/K5）：一份 API 额度商品今天就能被如实表达 ——
  `kind = API_QUOTA` → `fulfillment = COMPUTE_GRANT` → `assetKind = COMPUTE`
  → `unitName = computeUnit`，报价是 `400 IB_CREDIT / 1000 computeUnit /
  COMPUTE_GRANT`。它的结算形态落在**已冻结**的 `TX_TYPE.COMPUTE_GRANT` 上，
  因此不需要新造 transaction 语义，也不需要碰 provider。
- **单位名**：compute 两类商品的 `unitName` **必须恰是** `computeUnit`（§16
  冻结）。`tokens` / `usd` / `providerBalance` 做单位名会被
  `isForbiddenComputeAlias` 拒绝 —— "这家店卖的是 provider token"这句话在字形
  上就不可能成立。
- **输入面**：`FORBIDDEN_PRODUCT_FIELDS` 逐个点名 `providerApiKey` /
  `providerAccount` / `providerBalance` / `providerTopup` / `providerQuota`，
  而 `PRODUCT_INPUT_KEYS` 让它们**没有地方可以放**。
- **依赖闭包**：仍然只有 3 个 require 目标（boundary B15.2/B15.3），没有任何
  一个能碰 provider 或凭据。
- **代码文本**：没有 `topUpProvider` / `purchaseProviderCredits` /
  `updateProviderBalance` / `providerBillingMutation` / `checkoutUrl` /
  `paymentIntent` / `submitPayment` / `commitSpend`（B15.4）。
- **NEUTRAL**：`COMPUTE_GRANT` 不花这个 owner 的日额度（K6）——
  额度是被**授予**的，不是被买走的。
- **SERVICE 的反例**：服务商品没有 `assetKind`（`null`），`grantInventory`
  对它直接拒绝 —— 商品模型没有被写死成"每个商品购买后都必须增加 inventory"
  （§27）。

> **当前 HTTP 是否仍然完全没有 Store / Product / Inventory / Purchase mutation？**

**是，而且是四层否认，不是一个 grep。**

1. **路由表**：`/economy/*` 的六条新路由全带 `&& method === 'GET'`，
   `nonGet.length === 0`（boundary B4.4 用正则扫真实路由块）。
2. **方法名**：`http.js` 里**不存在** `putStore` / `putProduct` /
   `grantInventory` / `consumeInventory` / `createProductQuote` 这五个名字
   （boundary B4.4 + B15.9 逐名断言）—— 这一层根本拿不到写能力。
3. **`/security` 自述**：`writesExposed: []` · `storeWritesExposed: []` ·
   `productWritesExposed: []` · `inventoryWritesExposed: []` ·
   `purchaseExposed: false` · `mintingExposed: false`；而
   `unreachable` 里逐条列着 `/economy/inventory/grant` · `/economy/inventory/consume`
   · `/economy/store/create` · `/economy/store/update` · `/economy/product/create`
   · `/economy/product/update`，并**反向**断言三条真实的只读路径**不**在里面。
4. **运行期**：
   - `B13`：十条路径 × 三种写动词 = **30 次写尝试全部 405**
     `economy-is-read-only`；`B14`/`B15` 断言之后世界逐字未变。
   - `D4`：在**真实生产子进程**上，`POST /economy/inventory/grant` 与
     `POST /economy/product` 同样是 405，且 `D5` 断言库存仍然是 1000、商品仍然
     是 1 件、revision 未变。
   - `A2`：装配层（`services/home-node-service.js`）里**没有**这五个方法名
     —— 装配层只创建/打开 store，不替它决定业务。
   - `C1`：没有装配 Economy store 时，六条新路由给 **501
     `economy-not-assembled`**（不是 404、不是 200 + 空数组）。

---

## 25 · Stop Gate

P22-5 完成并**立即停手**。以下全部**未进入**：

```text
Purchase                  acceptQuote / consumeQuote as purchase
reserve → commit purchase workflow        Approval workflow
Exchange / 汇率            compute 计价
dynamic pricing            discount / promotion
recommendation             Provider quota mutation
real payment               Decision integration
Action integration         UI
```

`grantInventory` / `consumeInventory` 是**底层 primitive**：它们不动钱、不锁钱、
不消费任何报价，而且逐字写着 `isAPurchase: false`。真正的 Purchase 会在**同一个
事务**里同时写 ledger 与 inventory，而那是下一阶段的事。

`enforceBudget` 的缺省值仍然保持 P22-4 冻结的行为（**不强制**）—— P22-5 仍然
不把它切成 `true`，那留给真正实现 Purchase 的阶段决定。
