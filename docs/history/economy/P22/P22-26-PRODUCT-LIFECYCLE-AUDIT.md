# P22-26 · Product Lifecycle Audit 与 Economy Catalog v1 设计

阶段性质：**只读审计 + 设计**。本文件不授权任何实现。

基线：`5448026`（P22-25 · give the fresh world a canonical starting catalog）
审计方式：源码逐字阅读 + 只读探针（`.dsh-research/p22-26-*.js`，临时目录，不写被跟踪文件）。
未修改任何生产文件。

---

## 〇 · 一句话结论

> Economy v1 的商品**不是"没有功能闭环"**，它有一条真实的、从种子到库存的完整链路。
> 真正的断点有**四处具名**：**一处买不了**（SERVICE）、**一处算错**（`units > 1`）、
> **一处边缺失**（消耗）、**一处词表重复**（§15 `EFFECT_TYPE` vs §22 `fulfillment`）。
> 后两处都不是"忘了做"，而是"有两套东西被当成了同一套"。

审计开始时的假设（"shop 与 product 只有只读展示、没有 seed 商品"）**已被证伪**，
而且证伪的方式不是推理，是运行结果：

```
BOOTSTRAP: {"ok":true,"applied":true,"reason":"seeded","created":6}
· econ_product_catalog_memory_expansion  CONSUMABLE   quote OK · prepare OK · settle OK · inventory 0 → 1   (ITEM)
· econ_product_catalog_room_decoration   DIGITAL_ITEM quote OK · prepare OK · settle OK · inventory 0 → 1   (ITEM)
· econ_product_catalog_voice_pack        DIGITAL_ITEM quote OK · prepare OK · settle OK · inventory 0 → 1   (ITEM)
· econ_product_catalog_gift_box          CONSUMABLE   quote OK · prepare OK · settle OK · inventory 0 → 1   (ITEM)
· econ_product_catalog_compute_credit    API_QUOTA    quote OK · prepare OK · settle OK · inventory 0 → 1000 (COMPUTE)
· econ_product_catalog_agent_orchestration SERVICE    quote OK · prepare DENY PURCHASE_NOT_SUPPORTED
```

**6 件里有 5 件打通了（买 → 扣钱 → 入库）。** 因此本阶段的正确题目不是"造闭环"，
而是：**（a）修掉那 1 件买不了的，（b）修掉量词算错的，（c）补上消耗这条唯一的缺失边，
（d）把"商品是什么"收成一份**唯一**的契约（而不是再加一套），并且（e）停止发布买不了的商品。**

编号说明：本文件沿用 P22 系列自 P22-0 起的编号，P22-26 是**审计与设计**阶段，
因此它的产出是一份报告，不是一个补丁。

---

## 一 · 商品生命周期：逐段审计

### 1.1 Product canonical schema —— **齐备，且白名单是硬的**

`economy_products` 的 17 列（`economy-store.js` DDL）：

```
product_id · store_id · product_kind · fulfillment · name · description ·
currency · unit_price_minor(>=0) · unit_name · grant_quantity(>=0) ·
asset_kind · status · idempotency_key · fingerprint · revision ·
created_at · updated_at
```

契约侧（`economy-contract.js` §22）：

| 封闭集合 | 成员 |
|---|---|
| `PRODUCT_KIND` | `DIGITAL_ITEM` / `CONSUMABLE` / `API_QUOTA` / `COMPUTE_CREDIT` / `SERVICE` |
| `FULFILLMENT` | `INVENTORY_GRANT` / `COMPUTE_GRANT` / `SERVICE_EXECUTION` |
| `ASSET_KIND` | `ITEM` / `COMPUTE`（`SERVICE` 为 `null`） |
| `PRODUCT_STATUS` | `ACTIVE` / `DISABLED` / `RETIRED`（`RETIRED` 终态） |

`kind → fulfillment → assetKind → unitName` **全部是派生**，不是调用方声明：
`validateProduct` 逐条拒绝"调用方自己声明 fulfillment"，`settlePurchase` 再从 `products` 行
重新派生一次并断言与冻结的 `purchase.settlement_type` 相等。

**`PRODUCT_INPUT_KEYS` 恰好 13 个**，多一个键就整体拒绝。实测：

```
putProduct({... icon, effect, rarity})
→ ["product-input-key-not-whitelisted:icon",
   "product-input-key-not-whitelisted:effect",
   "product-input-key-not-whitelisted:rarity"]
```

这条不是障碍，是**下面 §4 设计必须绕开的真实约束**。

### 1.2 Product ownership —— **货架不是商家，拥有关系在别处**

三件事被刻意分开（P22-5 §1 的六条不等式）：

- `store_id` 只是**货架**：`Store` 不持有价格、不持有拥有关系、不持有库存（`serializeStore` 逐字写着三个 false）。
- 买家/收件人：`purchase.buyer_id/buyer_type` 与 `recipient_id/recipient_type`，**都在报价快照上冻结**。
- 真正的拥有事实：`economy_inventory(owner_id, owner_type, product_id, asset_kind, quantity)`，
  canonical key = `(ownerId, productId)`，**唯一物品不可表示**（`INVENTORY_UNIQUE_ITEMS_MODELLED = false`）。

### 1.3 Purchase flow —— **两段式，没有购物车**

```
createProductQuote   → quote(OPEN)，价格事实在此冻结
preparePurchase      → reservation(ACTIVE) + purchase(RESERVED)，钱被锁住但没动
settlePurchase       → 一个事务里做完下面全部
cancelPurchase       → reservation RELEASED
```

`settlePurchase` 的**单个**事务内顺序（`economy-store.js` §14）：

```
① 四个 canonical 事实 re-read
② 每个可变属性与快照一致（含 fulfillment == purchase.settlement_type）
③ 报价 / 预留的 expiresAt 复核（过期则先终结再拒绝，钱从未离开钱包）
④ 预算最终复核（DENY ⇒ 提前 return，批准原封不动）
④b 消费那条批准（approval_mode=APPROVAL 时）
⑤ reservation→COMMITTED + ledger transaction + entries
⑥ quote→CONSUMED（并有自己的 QUOTE_CONSUMED 事件）
⑦ 结算原语：grantQuantity > 0 ⇒ mutateInventoryInTx('grant', …)
⑧ purchase→COMPLETED（写 ledger_transaction_id 与 inventory_entry_id）
```

其中 `PURCHASE_SETTLEMENT_IS_ONE_TRANSACTION = true`，派生幂等键
`econ.purchase+<purchaseId>+ledger` 与 `+inventory` 也都在这一处。

### 1.4 Fulfillment flow —— **三条意图，两条落地，一条结构性缺席**

`SETTLEMENT_PRIMITIVE_OF_FULFILLMENT`：

| fulfillment | settlement primitive | 实际落地 |
|---|---|---|
| `INVENTORY_GRANT` | `INVENTORY` | ✅ `mutateInventoryInTx('grant')` |
| `COMPUTE_GRANT` | `COMPUTE_ENTITLEMENT` | ✅ **同一条原语**（`asset_kind = COMPUTE`） |
| `SERVICE_EXECUTION` | **`null`** | ❌ 在 `preparePurchase` **预留之前**就被拒 |

`SERVICE_EXECUTION` 的 `null` 不是"忘了填"，是一句被写下来的实话：

```
PURCHASE_NOT_SUPPORTED
["service-settlement-requires-the-action-layer-and-is-not-implemented-in-this-phase"]
  reservedNothing: true
```

**所以 `COMPUTE_ENTITLEMENT` 这个枚举名是个误导** —— 它底下跑的是 `INVENTORY` 原语，
"1000 computeUnit 的额度"与"1 件物品"在产品存储层是**同一种东西的两种单位**。
这一点对设计很重要：新增算力类商品**零新代码**，但**也不能**借它表达"一次性服务"。

### 1.5 Inventory integration —— **强，且三重并发防线**

`mutateInventoryInTx(mode, …)` 一个实现两个方向（grant/consume）：

1. `BEGIN IMMEDIATE` —— 写锁在**读 canonical 数量之前**拿到；
2. 带算术守卫的 UPDATE（`quantity + ? <= 上限` / `quantity >= ?`），0 行即拒绝；
3. 表上 `CHECK (quantity >= 0)`。

**库存没有派生缓存（刻意）**，所以"重建"这个问题不存在。
消耗侧 `consumeInventory` 已实现且实测可用（探针：`4 → 3`，写 `INVENTORY_CONSUMED` 事件 +
`INVENTORY_CONSUME` 幂等作用域）。

### 1.6 Asset granting —— **只有购买这一条生产入口**

`grantInventory` 被导出，但生产代码里**零调用**；`settlePurchase` 走的是内部
`mutateInventoryInTx`，不是公开的 `grantInventory`。这是对的：
"买完发货"和"平白发一次库存"必须是两件事，而后者在生产上没有入口。

### 1.7 Consumption semantics —— **★ 唯一的真缺口**

| 事实 | 证据 |
|---|---|
| `consumeInventory` 存在且可用 | `economy-store.js:7983`，探针实测 OK |
| `INVENTORY_CONSUME` 作用域冻结 | `OPERATION_SCOPE.INVENTORY_CONSUME` |
| `INVENTORY_CONSUMED` 事件冻结 | `EVENT_TYPE.INVENTORY_CONSUMED` |
| **生产代码调用方 = 0** | 全仓 `consumeInventory(` 只出现在 `tests/` 与 `Economy-v1-release/` 副本 |
| action adapter 把它列为**不提供** | `economy-action-adapter.js:195`（`NOT_OFFERED` 名单） |
| capability 句柄拿不到它 | 句柄键恰好 5 个，无 `mutateInventory` |
| HTTP 上不存在这条写路由 | `POST /economy/inventory/consume` 落兜底 → 405（boundary B15 逐名断言） |
| 上游也没有"使用/消耗"的意图 | 审批面 / 适配器 / 通道里 `consume/use/redeem` 零命中 |

**结论：`CONSUMABLE` 与 `DIGITAL_ITEM` 在当前运行时是同一个东西。**
两者都 `INVENTORY_GRANT / ITEM`；区别只在契约注释里那句"消耗品"。
一件买来只会**累加**的消耗品，不是消耗品 —— 它是一个挂着消耗品名字的永久资产。

同理 `COMPUTE_CONSUME`（`TX_TYPE.COMPUTE_CONSUME`，对手方 `system:treasury`，
记账 `SPEND`）**在全仓零写入方**：算力额度买得进，用不掉。

### 1.8 Refund —— **设计上关闭，且是明确的**

`PURCHASE_HAS_REFUND = false`；`PURCHASE_CANCEL_PRODUCES_A_LEDGER_REFUND = false`；
四个 purchase 状态全是终态，`assertPurchaseTransition` 的提示逐字写着
"a refund must be a new compensating economic operation"。
`REFUND` 交易类型存在于词表，但**没有任何入口**。

**本阶段不得改变这一条**（用户的禁止清单已含"不修改支付模块"）。

---

## 二 · 审计中最严重的一条：`units > 1` 是坏的

这不是"缺功能"，是**算错**。用自建商品（与目录种子无关）复现：

```
A · grantQuantity=1,    units=1 → quote{quantity=1,    amountMinor=400}  prepare OK   settle OK  inventory 0 → 1
B · grantQuantity=1,    units=3 → quote{quantity=3,    amountMinor=1200} prepare DENY QUOTE_MISMATCH
C · grantQuantity=1000, units=1 → quote{quantity=1000, amountMinor=400}  prepare OK   settle OK  inventory 0 → 1000
D · grantQuantity=1000, units=3 → quote{quantity=3000, amountMinor=1200} prepare DENY QUOTE_MISMATCH
```

报错恒为：

```
QUOTE_MISMATCH ["purchase-amount-must-equal-the-quote-snapshot"]
```

### 根因（逐字）

```js
// economy-store.js · preparePurchase
const units = o.units == null ? 1 : Number(o.units);   // ← 调用方不传时**假定 1**
...
const expectedAmount   = C.productQuoteAmountMinor(product, units);   // 用这个 units 重算金额
const expectedQuantity = C.productQuoteQuantity(product, units);      // 也用这个 units 重算送达量
if (expectedAmount.amountMinor !== quoteAmountMinor ||
    Number(quoteRow.quantity) !== expectedQuantity.quantity) → QUOTE_MISMATCH
```

而 `quotes` 表的列是：

```
quote_id · product_id · buyer_id · buyer_type · recipient_id · recipient_type ·
currency · amount_minor · quantity · quote_kind · service_role · state ·
expires_at · predecessor_quote_id · idempotency_key · fingerprint · revision ·
created_at · updated_at
```

**没有 `units` 列。** `quantity` 是**送达量**（`units × grantQuantity`），不是份数。

于是：`createProductQuote` 忠实写下了 `quantity = units × grantQuantity`，
`preparePurchase` 却用一个**没被任何人传进来的** `units = 1` 去重算并比对。
**报价把 `units` 算进去了，报价自己却没有保存它。**

### 为什么测试全绿而线上会坏

`tests/test_p22_6_economy_purchase.js` 的 helper 逐字写着 `units: 1` 默认值，
全仓**没有任何一处**向 `preparePurchase` 传 `units`。实测 P22-6 / P22-5 catalog / P22-5 inventory
三套件**全部通过** —— 因为这条路径从未被走过。

### 为什么这条是本阶段最该先修的

上游**真的**会产出 `units > 1`：

```js
// assets/js/active-diary/active-plans.js
var ACTIVE_ECONOMY_PROPOSAL_FIELDS = ['productId','recipientId','units','reason'];
if (typeof model.units !== 'number' || !Number.isSafeInteger(model.units) || model.units < 1) return null;
proposal.units = model.units;      // 模型可以提议 units = 3
```

`units` 一路到达 `proposeAgentPurchaseIntent` → `createProductQuote`（`units: Number(proposal.units)`）。
**模型提议 `units = 3` 时，收到的是一句 `QUOTE_MISMATCH`** —— 而且它不像"预算不够"那样可解释。
一条"看起来像账目对不上"的拒绝，对一个自主 Agent 是最难自愈的一种失败。

### 修法（设计，不在本阶段实施）

两个候选，**不新增任何经济概念**：

- **甲（推荐）**：`quotes` 加一列 `units INTEGER NOT NULL`，报价创建时冻结；
  `preparePurchase` **读** `quoteRow.units`，删掉那个 `== null ? 1` 的缺省。
  `quantity` 与 `units` 变成两个**各自独立被冻结**的事实，关系由 load-time 自检钉住
  （`quantity === units × grantQuantity`，而 `grantQuantity` 不可变）。
- **乙（零迁移）**：`preparePurchase` 由 `quantity ÷ grantQuantity` 反推 `units`。
  数学上唯一（比例恒为 1），但把"份数"变成派生量 —— 而 P22-4 的纪律是报价**快照**必须
  自足（"当时是多少"必须能重新回答，不依赖今天的商品行）。

甲更符合既有的"快照"纪律。两者都需要一条新测试：**`units > 1` 的报价必须能 prepare 成功**，
且 `amountMinor == units × unitPriceMinor`、`grantedQuantity == units × grantQuantity`。

同一条修复也解释了 §2 的可重复购买形态：**连买 N 次（每次 units=1）今天就能工作**
（探针实测 `1 → 2 → 3 → 4`），坏掉的只有"一次买 N 份"。

---

## 三 · 问题 2：第一批系统商品应该属于哪一种

四种候选逐个对照**已冻结的真实能力**：

| 候选 | 需要的机制 | 今天的状态 | 结论 |
|---|---|---|---|
| **A · 消耗品** | 购买 ✅ + 消耗 ❌ | 消耗边**完全缺失**（§1.7） | **本阶段核心**：补的是一条已冻结但没人调用的边 |
| **B · 永久资产** | 购买 ✅ + 库存 ✅ | **已可用**（探针 3 件全通） | **现在就发**；它是今天唯一"零缺口"的品类 |
| **C · 服务类** | `SERVICE_EXECUTION` 结算原语 | **结构性缺席**（`null`），且注释点名"需要 Action 层" | **不进 v1**。它是一个独立阶段 |
| **D · 权限/能力类** | 需要一个"授予能力"的 authority | **从未被设计**；`grantInventory` 之外没有任何授权面 | **不进 v1**，且**不得**在商品里表达 |

### 判定

> **第一批 = A + B，而且 A 必须有真正的消耗，否则 A 不成立。**

理由不是偏好，是三个事实：

1. **B 是唯一"零缺口"的品类。** 不发它，v1 就没有任何一件商品是完整的。
2. **A 的价值全在消耗边上。** 不补消耗，`CONSUMABLE` 就是 `DIGITAL_ITEM` 的同义词 ——
   发一件同义词商品等于在目录里放一条误导。补它的成本是**一条已冻结的缝**，
   不是一套新框架。
3. **C 不进 v1，而且是"目录"层面的决定，不是"阶段"层面的推迟。** 今天目录里
   真有一件 `SERVICE` 商品买不了（§0）。这句话本身就是缺陷：
   **一个商店不应该陈列无法结算的商品。**

### 因此必须同时决定：目录不得发布买不了的商品

这是一条**结构性**规则，不是纪律（沿用 P22-25 `missingSeedAssets` 的做法）：

```
载入期：对种子里每一件商品，断言
  settlementPrimitiveOfFulfillment(fulfillmentOfProductKind(kind)).primitive != null
否则 throw（节点拒绝启动，而不是陈列一件买不了的东西）
```

`SERVICE` 保留在 `PRODUCT_KIND` 里（那五个成员是冻结的，不动），
但**目录 v2 不发布它** —— 而"谁能被发布"这件事由上面那条载入期断言表达，由代码保证。

---

## 四 · 问题 3 + 5：最小 Economy Catalog v2 与 Asset Contract

### 4.1 五条禁止如何变成结构，而不是纪律

| 禁止 | 结构保证 |
|---|---|
| 不新增 Agent capability | 目录**不是** capability。`catalog-bootstrap.js` 的 `apply` 是装配期动作，HTTP 上零路由；`economy-capability.js` 不 import 它（P22-25 已断言） |
| 不新增真实支付 | `putProduct` 只写价格（`unit_price_minor`），生产代码里没有 provider / 支付动词（P22-6 J2/J3 断言） |
| 不接 Provider billing | `FORBIDDEN_PRODUCT_FIELDS` 逐名拒绝 `providerApiKey` / `providerBalance` / `providerTopup` / `providerQuota` |
| 不接外部商城 | `imageUrl` 只允许 `/assets/economy/` 之下；`:` `/` base64 在字形上不可能（`assetKeyIsRegex` 三条否认） |
| 不允许用户创建任意商品 | `putProduct` 的生产调用方**只有** `catalog-bootstrap.js`（P22-21 T5 + P22-25 断言 http.js 零调用形态） |

**System Catalog Bootstrap 是唯一 authority** —— 这一条在 P22-25 已经成立，本阶段不改它。

### 4.2 Asset Contract：8 个字段，逐个给出**落点**

用户提出的形状：

```
{ id, name, description, category, icon, fulfillmentType, effect, rarity }
```

**其中 4 个已经有权威落点，2 个必须换名，2 个必须新引入 —— 而新引入的 2 个不能进 `products` 表。**

| 契约字段 | 落点 | 说明 |
|---|---|---|
| `id` | `products.product_id` | 已有 |
| `name` | `products.name` | 已有（≤120） |
| `description` | `products.description` | 已有（≤500） |
| `category` | **`products.kind`**（语义落点；`category` 只是呈现层的别名） | 见 4.3 —— 新增一个 `category` 字段会造出第二个可能漂移的答案 |
| `fulfillmentType` | **`products.fulfillment`**（派生+不可变，不是声明） | 已冻结；**不得**由种子声明 |
| `icon` | **语义落点是既有的 `image`**（`icon` 只能是它的呈现层别名） | 见 4.4 —— 图片已经有 key→URL 形态，不要给它第二个名字 |
| `effect` | **★ 不加这个字段** | 见 4.5 —— 契约里**已经**有一个冻结的 `EFFECT_TYPE`，再加一个就是第三套词表 |
| `rarity` | **目录层的 `rarity`**，不进 `products` | 见 4.6 |

### 4.3 为什么 `category` 不该新加

`kind` 已经**恰好**是这个分类，而且它带着三张派生表（fulfillment / assetKind / unitName）
与两条 load-time 自检。再引入一个 `category` 会产生两个答案回答同一个问题，
而漂移的症状（"category 说是消耗品，kind 说是数字资产"）只在很久以后被一次审计发现。

**`category` 的取值就是 `PRODUCT_KIND` 的五个成员。** 契约字段名保留为
`category` 只是**目录层**的一个读法别名，等于 `kind`；不要在库里放第二个字段。

### 4.4 为什么 `icon` 应该改名为 `image`

一条形态已经在 P22-25 落地并且**已被测试钉住**：

```
目录种子 → imageKey: 'catalog/memory-expansion.webp'
         → IMAGE_KEY_BY_PRODUCT 表（catalog-bootstrap.js，唯一取值点）
         → HTTP 层 withCatalogImage() 派生 { image, imageUrl }
         → /assets/economy/catalog/<name>.webp
```

`withCatalogImage` 是**唯一**在商品 DTO 上增加键的地方，而 store 层
（`serializeProduct`）一字未改 —— P22-25 的 2.5b 逐字断言
"线上商品的字段集合 = P22-5 冻结的序列化视图 + `{image, imageUrl}`"。

**`icon` 与 `image` 是同一件事**。新引入 `icon` 会有两个后果，都是坏的：
① 商品的字段集合从 `+2` 变成 `+3`（P22-25 的断言当场变红，而且那个断言是对的）；
② 图片在目录里有两个名字。

**建议：契约字段名写作 `image`，并在文档里注明它承担 `icon` 的角色。**
若产品上确要 `icon` 这个名字，那它只能是 `image` 的一个**读法别名**，
不能是第二个存储位置。

关于 `assets/economy/products/*.png` vs 现有 `assets/economy/catalog/*.webp`：
静态层两种 MIME 都已支持（`services/internal-beyond-server.js:134` `.png → image/png`，
`:139` `.webp → image/webp`），因此**扩展名不是技术约束，是命名一致性问题**。
建议保持 `catalog/` 目录与 `.webp`（已有 6 张、已过载入期核对、已被测试引用），
或在 v2 里整体改名并**同时**改 `ASSET_KEY_RE` 与三条否认 —— 不要两套并存。

### 4.5 `effect`：**不要加这个字段** —— 契约里已经有一个冻结的 `EFFECT_TYPE`

审计中的一次自查更正。我最初按用户给的形状设计了"目录层的 `effect`"，
落在一个封闭集合上（`INVENTORY_GRANT` / `COMPUTE_GRANT` / `INVENTORY_CONSUME`）。
**那是错的**，因为 `economy-contract.js` §15 早就冻结了一套 `EFFECT_TYPE`：

```js
var EFFECT_TYPE = Object.freeze({
  GRANT_INVENTORY, GRANT_COMPUTE_STANDARD, GRANT_COMPUTE_PREMIUM,
  GRANT_IMAGE_CREDIT, GRANT_VOICE_CREDIT
});
var EFFECT_CURRENCY = Object.freeze({
  GRANT_INVENTORY: null,                       // inventory 走 inventory 域，不发 currency
  GRANT_COMPUTE_STANDARD: 'COMPUTE_STANDARD',  // 而 CURRENCIES 里真的有这五个
  GRANT_COMPUTE_PREMIUM:  'COMPUTE_PREMIUM',
  GRANT_IMAGE_CREDIT:     'IMAGE_CREDIT',
  GRANT_VOICE_CREDIT:     'VOICE_CREDIT'
});
```

**五个 `EFFECT_TYPE` 与 `CURRENCIES` 的五个成员一一对应**
（`IB_CREDIT` / `ACTIVITY_POINT` 是另外两个）。§22 的注释也逐字说
五个 `PRODUCT_KIND` "只是把 §15 的 `EFFECT_TYPE` 与 §16 的 compute tier
组织成货架上的分类"。

**但 §15 的 effect 在生产代码里不会被执行：**

| 事实 | 证据 |
|---|---|
| `validateProductEffect` 有测试（`test_p22_1_economy_domain_contract.js` 十余条） | ✅ |
| `validateProductEffect` 的生产调用方 | **0** |
| `EFFECT_TYPE` / `EFFECT_CURRENCY` 的生产读取方 | **0**（只有自己的定义与导出） |
| `products` 表有 `effect` 列吗 | **没有**（`PRODUCT_INPUT_KEYS` 里也没有） |
| `IMAGE_CREDIT` / `VOICE_CREDIT` / `COMPUTE_STANDARD` 在 `economy-store.js` 里 | **零命中** |

**因此商品实际走的是 §22 的模型，不是 §15 的模型。** 两者对同一件事给了两个答案：

```
§15（冻结，零调用）：  买 compute ⇒ 钱包 COMPUTE_STANDARD 余额 +N
§22（在跑，实测）：    买 API_QUOTA ⇒ economy_inventory(assetKind=COMPUTE) +1000
```

这是**审计要记下来的第二条真实不一致**（第一条是 §2 的 `units`）。
它同时解释了为什么 `COMPUTE_ENTITLEMENT` 与 `INVENTORY` 跑的是同一条原语（§1.4）：
两个模型被并到了同一条实现上。

**结论：把 `effect` 从 Asset Contract 里去掉。** 三条理由，每条独立成立：

1. **"买完发生什么"已经被完整编码**，而且是一份不会漂移的编码：
   `kind`（本体列）→ `fulfillment`（**派生**、不可变）→ `assetKind`（**派生**）。
   再写一个 `effect` 就是同一件事的第二个答案 —— 而第二个答案漂移的症状
   （"effect 说是消耗品，fulfillment 说是 grant"）只在很久以后被一次审计发现。
   这正是 P22-5 §4 冻结 `kind → fulfillment` 派生表要防的东西。
2. **用户明确禁止"新增未来能力词"。** 引入一个 catalog `effect` 集合，
   无论取值多用既有名字，都是一套**第三套**词表；而"不要为同一个概念造第二个名字"
   是这份契约从头到尾的纪律（见 §14 对 `settlementType` 为什么不另起名字的说明）。
3. **消耗不需要新词。** 消耗是一个**动词**（`consumeInventory`，`OPERATION_SCOPE.INVENTORY_CONSUME`
   已冻结），不是一个 effect。需要表达的是"这件商品用过就少一件" ——
   而它由 `kind === 'CONSUMABLE'` 承载，加上 §5 要建的那条缝。

**UI 要的"功能说明"文字怎么办？** 用**已存在**的呈现层标签：
`economy-shell-core.js` 的 `CFG.PRODUCT_KIND_LABEL[kind]`、`CFG.FULFILLMENT_LABEL[fulfillment]`、
`UNIT_FACE[unitName]`、以及 `unitLineOf()`。这些是**纯粹的读法**，不是经济事实，因此不需要新契约字段。
若确需一句更完整的说明，它应当长在**呈现层**并由 `kind` + `grantQuantity` + `unitName` 推导 ——
**不落库、不进 DTO、不参与任何判定。**

**处置建议（不属本阶段实施）**：§15 与 §22 的这处双模型应当在某个阶段被显式收敛 ——
二选一，然后在报告里点名。本阶段**不动它**（P22-21 冻结面），但**必须**把它作为已登记的
不一致留在审计里，而不是让下一个阶段的目录设计又一次"顺手"造出第三个模型。

### 4.6 `rarity`：可以放，但必须**声明为不参与经济**

`rarity` 是一个纯粹的呈现标签。它唯一危险的用法是变成定价或可用性的输入 ——
而那正是 `PRICING_IS_RELATIONSHIP_FREE = true` 与 `FORBIDDEN_PRODUCT_FIELDS`
里 `featured` / `recommended` / `personalized` / `promo` 要挡的东西。

（注意它与 §4.5 的区别：`effect` 是一个**有经济含义**的概念，因此不该有新名字；
`rarity` 是一个**没有经济含义**的纯呈现标签，因此它不制造第二套答案 ——
但它的安全性必须由"没有任何经济代码读它"来保证，而不是由它的名字来保证。）

**因此 `rarity` 允许存在于目录层，但必须带一条可断言的自述**，
与 `visualIdentityOf`（"只画脸，不参与价格/排序/推荐/可否购买"）同款：

```
rarity 不得被 pricing / availability / entitlement 任何一处读取。
```

可断言形式：目录模块里 `rarity` 的读取点**只**出现在呈现层；
`productQuoteAmountMinor` / `productAvailabilityForQuote` 的源码里零命中。
形状上建议用**封闭集合**（如 `COMMON` / `NOTABLE` / `RARE`），不要自由文本 ——
一个无上界的文本字段是一条把任意正文塞进目录的通道（P22-5 §19 的同一条理由）。

### 4.7 目录 v2 的官方形状

```
System Store（econ_store_system_market，已有）
│
├── 记忆扩容胶囊      kind=CONSUMABLE    rarity=COMMON   ← A（消耗：见 §5.4）
├── 心意礼盒          kind=CONSUMABLE    rarity=NOTABLE  ← A（礼物：报价带 recipientId）
├── 声线素材包        kind=DIGITAL_ITEM  rarity=RARE     ← B
├── 虚拟空间组件      kind=DIGITAL_ITEM  rarity=COMMON   ← B
├── 算力额度包        kind=API_QUOTA     rarity=NOTABLE  ← B（累加进 COMPUTE 库存）
└── （Agent 编排服务） kind=SERVICE       ——  v2 **不发布**，载入期断言禁止发布
```

**没有 `effect` 字段**（§4.5）：每件商品"买完发生什么"由
`kind` + 派生的 `fulfillment` + 派生的 `assetKind` 表达，读法与 v1 完全一致。

与 P22-25 的 v1 种子相比：**去掉 1 件（`SERVICE`），其余 5 件保留**（id 与图片沿用，
避免制造第二套目录），唯一新增的目录层事实是 `rarity`。

**版本化**：`SEED_VERSION` 从 `v1` 升到 `v2`，幂等键
`catalog-seed.v2.<id>` —— 因此"重放同一个版本"仍然是 replay，
"另一个版本又要写一遍"仍然是 **conflict 拒绝**（P22-25 已建立的行为）。
**关键**：v2 的入口条件仍是"目录为空"，因此**已经跑过 v1 的世界不会被改写**；
它需要一条独立的、显式的目录升级动作 —— **那属于本阶段之外**，
本阶段只把 v2 定义出来并让**新世界**用 v2 启动。

---

## 五 · 问题 4：每件商品必须回答的七个问题

### 5.1 消耗品的完整答案（`kind=CONSUMABLE`）

| 问题 | 答案 |
|---|---|
| **买了之后世界发生什么变化？** | `economy_inventory` 上 `(owner, product)` 那一行 `+grantQuantity`；钱包 `-unitPriceMinor`；`quote→CONSUMED`；`purchase→COMPLETED` |
| **哪个 authority 写入？** | **购买**：`settlePurchase`（P22-6，唯一）。**消耗**：`consumeInventory`（P22-5 原语）—— **今天没有生产调用方，这是本阶段要建的缝（§5.4）** |
| **哪个表记录？** | `economy_inventory`（canonical 数量，**没有派生缓存**）+ `economy_change_log`（`INVENTORY_GRANTED` / `INVENTORY_CONSUMED`，各带 `previousQuantity` / `delta`）+ `operation_idempotency`（`INVENTORY_GRANT` / `INVENTORY_CONSUME` 作用域） |
| **inventory 如何变化？** | 购买：`grant`，`quantity + N`，带算术守卫。消耗：`consume`，`quantity - N`，`quantity >= N` 否则拒绝，`CHECK (quantity >= 0)` 兜底 |
| **是否可重复购买？** | **可以**。同一 `(buyer, product)` 可以反复购买，每次一份新的 quote + reservation；库存**累加**（探针实测 `1→2→3→4`）。唯一的"不可重复"是**同一次购买**：`purchase` 四个状态全是终态，重放返回 `terminal: true` 的终态冲突 |
| **是否消耗？** | **是**。**这是本品类与 `DIGITAL_ITEM` 的唯一区别** —— 而今天这个区别**不存在**（两个 kind 的 `fulfillment` 与 `assetKind` 逐字相同，且没有消耗缝）。它由 §5.4 那条缝建立，**不由某个字段声明** |
| **是否退款支持？** | **否**。`PURCHASE_HAS_REFUND=false`，终态不可逆；将来的退款必须是**一条新的补偿性经济操作**，不是状态回滚。本阶段不改变这一条 |
| **是否需要审批？** | **由预算政策决定，不由商品决定**。`budget.decision.outcome = REQUIRE_APPROVAL` ⇒ reservation RELEASED + `PURCHASE_REQUIRES_APPROVAL`；`DENY` ⇒ FAILED。商品层**没有**任何"这个商品需要批准"的字段，也不应该有 |

### 5.2 永久资产的答案（`DIGITAL_ITEM`，今天已可用）

与上一节的差异只有两处，其余逐字相同：

| 问题 | 差异 |
|---|---|
| 买了之后世界发生什么变化？ | 同上（`INVENTORY_GRANT`） |
| 是否消耗？ | **否**。库存只增不减 |
| 其余五项 | **与消耗品逐字相同** |

### 5.3 礼物路径（`recipientId`）

`GIFT` 不是一种 `kind`，是**报价上的一个收件人**：
`productQuoteKindFor(fulfillment, hasRecipient)` ⇒ `hasRecipient ? GIFT : PURCHASE`。
`GIFT` 的 ledger 交易类型是 `TX_TYPE.GIFT`，而 `settlePurchase` 用
`target = recipientId ?? buyerId` 决定库存落到谁身上。

因此"心意礼盒"**不需要**新概念：它是 `CONSUMABLE` + 一次带 `recipientId` 的报价。
但有一条审计要**记下来**：`recipientId` 路径的**生产发起方**只有
`ACTIVE_ECONOMY_PROPOSAL_FIELDS` 里的 `recipientId`（模型可选）。
人类侧没有送礼接缝。

### 5.4 ★ 消耗缝（consume seam）的设计 —— 本阶段唯一的新接缝

这是整个设计里唯一"新增东西"的地方，因此必须解释为什么它不是提权。

**① 谁有权消耗？—— 答案：持有者，而授权来自"用户已经拥有的东西"，不是预算。**

一次消耗**不动钱**：`mutateInventory` 的结果里逐字写着
`ledgerMutation: false / walletMutation: false / isAPurchase: false`。
因此它**不是**一次支出，不需要预算、不需要审批、不需要 capability 意义上的
"花别人的钱的许可"。它需要的是"这个 owner 决定用掉自己的东西"。

**② 作用域：`INVENTORY_CONSUME` 已冻结，不需要新词。**

**③ 接缝形状（两个候选，本阶段只选一个）**

- **候选 α（推荐）：人类侧，复用 `user_decision_seam` 的形状。**
  在已认证的桌面请求下来到 `/internal/economy/consume-asset`（与
  `/internal/economy/command` 同族：loopback + 来源凭据，身份**不**来自 payload）。
  它对应一句真实的用户动作："用掉一个"。
  **代价**：`CONSUMER_CAPABILITY_MATRIX` 需要给这个接缝一个新 capability
  （PROPOSE / RESUME 之外的第三个），因为现有的两个都答不了"使用自己的持有物"。
  **必须逐字记下的是**：这**不是**给 Agent 新能力 ——
  `active_agent_runtime` 的能力表**不变**，`desktop_bridge` 仍然为空。

- **候选 β（零新 capability）：不进 v1。**
  只发布 B（永久资产），消耗推迟到它自己的阶段。

**建议：α**。理由是用户把 A 定为第一批的核心，而 A 的全部价值在消耗边上；
β 会让 v1 变成"只有永久资产"的目录，而那样 `CONSUMABLE` 就该从目录里拿掉 ——
那是一个更小的 v1，而且它把"消耗品"这个用户明确要的品类整个推后。

**④ 消耗必须 fail closed 的五条**（全部由既有代码保证，设计只需不绕开它们）：

1. `quantity < 1` 或非安全整数 ⇒ 拒绝（`INVENTORY_INPUT_NOT_STRUCTURED`）；
2. 商品不存在 ⇒ `PRODUCT_NOT_FOUND`；
3. `asset_kind == null`（即 SERVICE）⇒ `EFFECT_NOT_ALLOWED`；
4. 库存不足 ⇒ 带算术守卫的 UPDATE 影响 0 行 ⇒ 拒绝，**数量一字不变**；
5. system party 不能持有库存 ⇒ `system-party-cannot-hold-inventory`。

**⑤ 消耗的幂等**：`(INVENTORY_CONSUME, idempotencyKey)` + 指纹。
重放零成本、零副作用；同键不同指纹 ⇒ **conflict 拒绝**（不静默覆盖）。
**这条比购买的幂等更关键**：一次重复的购买是多花一次钱（可见），
一次重复的消耗是**静默丢掉一件东西**。

**⑥ 消耗的 UI 授权必须来自用户意图，不来自模型输出。**
使用者是 owner 自己；`ownerId` 必须由已认证请求的上下文给出，
**不得**从 payload 里读（与 economy command channel 的
`NOT_ALLOWED_FOR_A_CONSUMER_TO_SELF_REPORT` 同一条纪律）。

---

## 六 · 问题 6：UI —— 只加四样，不重做

现状（`economy-shell.js` `productTile` + `economy-shell-core.js` `buildProductModel`）：
商品卡已有 `name` / `description` / `priceText` / `unitLine` / `statusFace` / `kindFace` /
`fulfillmentFace`，商品图是**由 productId 确定性派生的 inline SVG**
（`visualIdentityOf`，纯函数，只吃 productId）。

**四样新增，全部是"读更多已有事实"，没有一样是新的经济判定：**

| 新增 | 数据来源 | 说明 |
|---|---|---|
| **商品状态** | **已有**（`status` → `statusFace`，`PRODUCT_STATUS_FACE`） | 已存在，只需确认 `RETIRED` / `DISABLED` 的措辞在卡片上可见 |
| **功能说明** | **已有**：`kind` + `grantQuantity` + `unitName` + `fulfillment` | "买完会发生什么"的一句话，由 `CFG.PRODUCT_KIND_LABEL` / `CFG.FULFILLMENT_LABEL` / `unitLineOf()` 拼出。**不新增契约字段、不落库**（§4.5） |
| **已拥有数量** | `GET /economy/inventory?ownerId=…&productId=…`（**已有只读路由**） | 卡片上写"已拥有 N"。这是把两张既有读面 join 起来，**不是**新的经济事实 |
| **购买后结果预览** | `kind` + 派生的 `fulfillment` + `grantQuantity` + `unitName`（**全部已有**） | 例："购买后：+1 件（可消耗）"。**不得**预测任何金额、余额或可用性 |

### UI 的三条硬边界

1. **不要加购买按钮。** `economy-shell.js:16` 与 `:1211` 逐字写着
   "canonical 没有人类直接购买这条接缝，本阶段不造"。加一个按钮等于**造**那条接缝，
   而它不在本阶段授权范围内。消费者可以"使用"（消耗，§5.4），**不可以"购买"**。
2. **图片不参与经济判断。** 商品图目前是 inline SVG；换成 `assets/economy/...` 里的
   真实图片是一件事，让图片参与价格/排序/推荐/可用性是另一件事 ——
   **后者永远不做**。`visualIdentityOf` 的自述是这件事的既有文字依据。
3. **"已拥有数量"必须能解释自己。** 它来自 `economy_inventory` 那一行（canonical），
   不是派生缓存 —— 所以它天然没有"缓存与行不一致"这类 bug，也不该在 UI 层再算一遍。

**关于把 inline SVG 换成真实图片**：那是一次**视觉验收**（P22-17 A6 逐字断言
"store UI 里零 PNG/WebP/JPG"），属于它自己的阶段。本阶段只让 `imageUrl` 在线上真实可达
（P22-25 已交付）。

---

## 七 · 问题 7：测试要求（五套，逐个写明它证明什么）

| # | 测试 | 证明什么 | 关键断言（样例） |
|---|---|---|---|
| 1 | **`test_p22_26_catalog_v2.js`**（catalog bootstrap） | 空世界 → 目录 v2；非空世界**一字不动** | ① `SEED_VERSION === 'v2'` 且幂等键前缀为 `catalog-seed.v2.`；② **载入期**断言：种子里每一件商品的 settlement primitive 非 null（**放进一件 SERVICE ⇒ require 抛**）；③ 第二遍 apply ⇒ `applied:false, reason:'catalog-not-empty'`，且全局 revision 不变（证明"根本没写"，不是"写了但值一样"）；④ v2 幂等键重放 ⇒ replay，另一个版本 ⇒ **conflict**；⑤ 目录层 `rarity` 的取值全在封闭集合里；⑥ **种子条目里没有 `effect` 键**（§4.5：不加第三套词表） |
| 2 | **`test_p22_26_product_schema_contract.js`**（product schema contract） | 商品契约**没有**被本阶段放松，也没有被造出第二套词表 | ① `PRODUCT_INPUT_KEYS` **仍然恰好 13 个**，且 `icon` / `effect` / `rarity` / `category` 逐个仍被 `product-input-key-not-whitelisted` 拒绝（**反证**：设计没有偷偷改契约）；② `FULFILLMENT_OF_PRODUCT_KIND` / `ASSET_KIND_OF_PRODUCT_KIND` / `PRODUCT_UNIT_NAME` 逐字未变；③ 商品 DTO 的字段集合仍 = P22-5 冻结视图 **+ `{image, imageUrl}` 恰好两个**（防 `effect`/`rarity` 漏进 DTO）；④ **`rarity` 只被呈现层读取**：`productQuoteAmountMinor` / `productAvailabilityForQuote` 源码里零命中；⑤ 全仓**只有一套**"买完发生什么"的词表：`PRODUCT_KIND` + `FULFILLMENT`，没有并行的 catalog `effect` 集合；⑥ 目录层没有 `icon` 与 `image` 两个名字 |
| 3 | **`test_p22_26_purchase_fulfillment_golden_path.js`**（purchase → fulfillment） | 目录 v2 的**每一件**商品都能 买 → 扣钱 → 入库 | ① 对种子里每件商品：quote OK → prepare OK → settle OK；② `ledgerMutation === true` 且钱包余额精确 `-unitPriceMinor`；③ `inventory` 精确 `+grantQuantity`，`assetKind` 与 kind 派生一致；④ `quote → CONSUMED`、`purchase → COMPLETED`，且 `purchase.inventory_entry_id` 非 null；⑤ **★ `units = 3` 必须成功**（§2 的修复证明）：`amountMinor == 3 × unitPriceMinor`、`grantedQuantity == 3 × grantQuantity`；⑥ SERVICE 商品**不在**种子里，且把一个 SERVICE 塞进种子会让目录 require **抛** |
| 4 | **`test_p22_26_inventory_mutation.js`**（inventory mutation） | 消耗边真实存在，且 fail closed 全面 | ① 买 1 件 ⇒ 拥有 1；② 消耗 1 ⇒ 拥有 0，写 `INVENTORY_CONSUMED` 且 `delta === -1`、`previousQuantity === 1`；③ **再消耗 1 ⇒ 拒绝**，且数量**仍然为 0**（守卫生效）；④ 库存不足的拒绝里 `ledgerMutation === false`；⑤ 消耗**不动钱**：钱包余额与 `reservedBalanceMinor` 一字不变；⑥ `asset_kind == null` 的商品 ⇒ `EFFECT_NOT_ALLOWED`；⑦ 并发两个消耗（两个 store 实例，同一条 `consume-worker` 夹具）⇒ 恰好一个成功（既有 `tests/fixtures/p22-5-consume-worker.js` 可直接复用） |
| 5 | **`test_p22_26_duplicate_purchase_semantics.js`**（duplicate purchase） | 重复购买 / 重复消耗的语义**各自正确且不同** | ① 连买 3 次同一件 ⇒ 3 条独立 purchase，库存 3；② 每次 `ledgerTransactionId` **互不相同**（三笔真实的钱）；③ **同一** `settlePurchase` 重放 ⇒ `replayed:true` 且 `terminal:true`，库存**不再增加**（`1` 而不是 `2`）；④ 同一 settle 幂等键**不同指纹** ⇒ conflict 拒绝；⑤ 消耗：同键重放 ⇒ replay 且库存**只减一次**；⑥ 同键不同指纹 ⇒ conflict；⑦ 终态 purchase 再次 settle ⇒ `purchaseStatus` 原样 + `terminal:true`，且**没有**任何 `REFUND` / 补偿交易被写入 |

**五套之外的回归要求**：P22-5 / P22-6 / P22-21 / P22-25 现有套件**必须保持全绿**，
且**不得**为了通过而放宽任何既有断言。若 `PRODUCT_INPUT_KEYS` 需要变（§4.5 说明它不该变），
那是一件**契约变更**，必须在报告里点名。

---

## 八 · 明确不做（本阶段的边界）

| 不做 | 为什么 |
|---|---|
| 修改 P22-21 frozen contract | 用户禁止，且本设计不需要 |
| 修改支付模块 / provider 模块 | 用户禁止；消耗**不动钱**，因此确实不需要 |
| 新增未来能力词（订阅 / 租赁 / 等级 / 升级 / 折扣 / 推荐 …） | 用户禁止；`FORBIDDEN_PRODUCT_FIELDS` 已经逐名拒绝 `discount` / `promo` / `featured` / `recommended` / `personalized` |
| 实现 `SERVICE_EXECUTION` 结算原语 | 它是**独立阶段**（需要 Action 层）；v1 的答案是**不发布**，不是"先做了" |
| 权限 / 能力类商品（候选 D） | 从未被设计；在商品里表达授权会造出一条绕过 capability matrix 的路径 |
| 人类直接购买接缝（UI 购买按钮） | UI 逐字写着 canonical 没有这条接缝，且不在本阶段授权范围 |
| 商品图片渲染进 Storefront | P22-17 A6 断言"零 PNG/WebP/JPG"；换图是独立的 UI + 视觉验收阶段 |
| 退款 | `PURCHASE_HAS_REFUND=false` 是冻结的；将来的退款必须是新的补偿性操作 |
| 已有 v1 世界的目录升级 | v2 的入口条件是"目录为空"；升级要一条**显式**的、自己的阶段，不能靠改种子悄悄发生 |
| **收敛 §15 `EFFECT_TYPE` 与 §22 `fulfillment` 的双模型** | 这是一处**已登记的不一致**（§4.5），不是本阶段的活。本阶段只**不制造第三套词表**；收敛它需要一次契约变更，应独立成阶段并点名 |

---

## 八·补 · 一条必须留给下一个阶段的不一致（已登记）

审计发现两套"买完发生什么"的模型并存，而**其中只有一套在跑**：

```
§15（P22-1 冻结，有测试、零生产调用）
     EFFECT_TYPE × 5  ⇄  CURRENCY × 5（COMPUTE_STANDARD / COMPUTE_PREMIUM /
                                       IMAGE_CREDIT / VOICE_CREDIT / null）
     "买 compute ⇒ 钱包余额 +N"

§22（P22-5 冻结，正在跑，实测通过）
     PRODUCT_KIND × 5 → FULFILLMENT × 3 → ASSET_KIND × 2
     "买 API_QUOTA ⇒ economy_inventory(assetKind=COMPUTE) +1000"

实测：IMAGE_CREDIT / VOICE_CREDIT / COMPUTE_STANDARD / COMPUTE_PREMIUM
      在 economy-store.js 里**零命中**。
```

两者不可调和的地方很具体：**一笔 `COMPUTE_STANDARD` 钱包余额与一行
`assetKind=COMPUTE` 的库存，是两种不同的可花费物**，而今天的产品只能产出后者。
这也是 `COMPUTE_ENTITLEMENT` 与 `INVENTORY` 跑同一条原语（§1.4）的成因。

**本阶段不做任何收敛**（P22-21 冻结面 + 用户禁止修改支付/provider 模块）。
但目录设计**必须**知道它存在 —— 否则下一个阶段会以为"要表达买完发生什么，
得再加一个字段"，而那正是第三个模型。

---

## 九 · 建议的下一步顺序（供确认，不自行进入）

1. **先修 `units > 1`（§2）。** 它是**算错**，不是缺功能，而且它的症状会被误读成"账目对不上"。
   修法 = `quotes` 加 `units` 列 + `preparePurchase` 读它 + 一条 `units > 1` 的测试。
2. **再建消耗缝（§5.4），并同时把 `CONSUMABLE` 与 `DIGITAL_ITEM` 真正分开。**
   在此之前 `CONSUMABLE` 是一个同义词，发布它等于在目录里放一条误导。
3. **再出目录 v2（§4.7）**：去 SERVICE + 引入目录层 `rarity`（**不引入 `effect`**，§4.5），
   并把"不得发布买不了的商品"变成载入期断言（§3）。
4. **最后才是 UI 四样（§6）**，而且不包含购买按钮。

若顺序反过来（先做目录与 UI），世界会变成一个**陈列着买不了的商品、卖着不会消耗的消耗品、
并且买多份会报账目错**的商店 —— 三样都是"看起来能用"的缺陷。

---

## 附 · 本审计用到的只读探针

| 文件 | 用途 |
|---|---|
| `.dsh-research/p22-26-lifecycle-probe.js` | 6 件 seed 商品逐个走 quote → prepare → settle，测量库存增量 |
| `.dsh-research/p22-26-units-probe.js` | 用**自建商品**隔离 `units > 1` 的失败层级（排除"种子特殊"） |

两者都在系统临时目录建库，不写任何被跟踪文件。
