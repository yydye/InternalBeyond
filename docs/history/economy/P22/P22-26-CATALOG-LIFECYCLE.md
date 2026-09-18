# P22-26 · Economy Catalog 生命周期实现

阶段性质：**实现**。基线 `5448026`（P22-25 · give the fresh world a canonical
starting catalog）。设计依据是 `docs/P22-26-PRODUCT-LIFECYCLE-AUDIT.md`（只读审计）。

执行顺序按批准固定为 **Phase 1 → 5**，一步不换位。理由在审计 §9：
顺序反过来，世界会变成一个**陈列买不了的商品、卖不会消耗的消耗品、并且买
多份会报账目错**的商店。

---

## 〇 · 一句话

审计找到四处断点：**一处买不了**（SERVICE）、**一处算错**（`units > 1`）、
**一处边缺失**（消耗）、**一处词表重复**（§15 `EFFECT_TYPE` vs §22
`fulfillment`）。本阶段修掉了前三处，并且**明确不动**第四处（它是独立阶段）。

| # | 断点 | 处置 |
| --- | --- | --- |
| 1 | `units > 1` 是**算错** | **修**：份数成为报价上的一列（schema 7 → 8） |
| 2 | 消耗这条边不存在 | **建**：`consumeOwnedItem` 唯一 runtime seam |
| 3 | 目录陈列买不了的商品 | **修**：目录 v2 去 SERVICE + 载入期断言 |
| 4 | §15 `EFFECT_TYPE` 与 §22 双模型 | **不动**，但登记在册（本文件 §7） |

---

## 一 · Phase 1 —— Purchase `units` 契约

### 1.1 修掉的那一行

```js
// economy-store.js · preparePurchase（P22-26 之前）
const units = o.units == null ? 1 : Number(o.units);   // ← 调用方不传时**假定 1**
const expectedAmount   = C.productQuoteAmountMinor(product, units);
const expectedQuantity = C.productQuoteQuantity(product, units);
if (expectedAmount.amountMinor !== quoteAmountMinor ||
    Number(quoteRow.quantity) !== expectedQuantity.quantity) → QUOTE_MISMATCH
```

`quotes` 表**没有 `units` 列**：报价把 units 算进了 `quantity`（送达量 =
units × grantQuantity）与 `amountMinor`，**报价自己却没有保存它**。于是
`units = 3` 的报价必然被自己的重算判成 `QUOTE_MISMATCH`，而症状是
**"账目对不上"** —— 一句对自主 Agent 最难自愈的拒绝。

全仓没有一处向 `preparePurchase` 传 `units`，因此 P22-6 / P22-5 / P22-7
的套件全绿，而这条路径从未被走过；直到 `assets/js/active-diary/active-plans.js`
的 `ACTIVE_ECONOMY_PROPOSAL_FIELDS` 里的 `units` 真的让模型提议 3 份。

### 1.2 authority 的落点

**`units` 的权威是报价上的一列**，不是请求里的一个数。

```
createProductQuote(units)  →  createQuote({ …, units })  →  quotes.units（冻结）
                                                                    │
preparePurchase / createApprovalRequest / authorizePurchaseIntent ──┘
        （三者**只**通过 quoteQuantitiesOf 读它，请求里就算带了也**不参与**）
```

- **唯一实现**：`quoteUnitsOf(quoteRow)` 与 `quoteQuantitiesOf(product, quoteRow)`。
  后者顺带断言 `quantity === units × grantQuantity` —— 一条**载入期不变量**，
  而不是每天都会漂移的比较（`grantQuantity` 是 `updateProduct` 的 SET 里
  **没有**的那一列，因此它不可变）。
- **三处下游的 `o.units` 全部消失**：`preparePurchase` / `createApprovalRequest`
  / `authorizePurchaseIntent`。它们的权威是同一份报价快照。
- **旧单数量语义保持兼容**：不传 units 仍然是 1 份（`createQuote` 与
  `createProductQuote` 各自的缺省），而 raw `createQuote`（P22-4 的 primitive，
  没有商品行因而没有 grantQuantity 概念）落下的 units 就是 1。P22-4 的
  G3/G4 行为**逐字未变**（raw quote 写下与目录不符的金额仍然允许，拒绝发生在
  prepare 那一侧的金额比对）。

### 1.3 schema 7 → 8

| | |
| --- | --- |
| 改动 | `quotes` 加一列 `units INTEGER NOT NULL DEFAULT 1 CHECK (units >= 1)` |
| 迁移 | **非空**（既有实体上的新事实）—— 与 5→6 同款，与 6→7 的空迁移相反 |
| 语句 | `ALTER TABLE economy_quotes ADD COLUMN units INTEGER NOT NULL DEFAULT 1` |
| 只加列 | 没有 `UPDATE` / `DELETE` / `INSERT`，因此既有行一个字节都不被改写 |
| 三道防线 | ① `tableExists` 守卫（跨级升级时那张表可能还不存在）；② `PRAGMA` 列探测（迁移可安全重跑）；③ ALTER 之后**再查一次** `PRAGMA`，确认列真的在 |
| 旧行 | 拿到 `DEFAULT 1` —— 对它们唯一正确的答案（那时 `quantity` 就等于 `grantQuantity`） |
| 新行 | 一律由 `createProductQuote` / `createQuote` 显式写入 |

**为什么是 `NOT NULL DEFAULT 1` 而不是"可空 + 读的时候补 1"**：补 1 会把
"这一行没有落过份数"与"这一行就是一份"写成同一件事，而本阶段的全部内容正是
**不要猜**。DEFAULT 只在 ALTER 那一刻对既有行生效，此后每一次 INSERT 都必须
显式给出 `units`。

**水位抬到 8 是必须的**：一个 P22-25 的 build 打开这张库时看不到 `quotes.units`，
会把每一份报价都读成"一次一份"，随后用那个 1 去重算并拒绝一份 `units = 3` 的
报价。那个误读比"打不开"更隐蔽，因此必须打不开。

### 1.4 一条读面增量

`quotes` 的序列化视图多了一个 `units`（与 `quantity` 并列）。理由与
`quantity` 自己在那里一样：**"这份报价买了几份"必须能被重新回答**。

---

## 二 · Phase 2 —— Inventory Consume 缝

### 2.1 缝之前的状态

| 事实 | P22-26 之前 |
| --- | --- |
| `consumeInventory` 存在且可用 | ✅（P22-5 的 primitive） |
| `INVENTORY_CONSUME` 作用域已冻结 | ✅ |
| `INVENTORY_CONSUMED` 事件已冻结 | ✅ |
| **生产调用方** | **0** |
| action adapter | 把它列为 `NOT_OFFERED` |
| capability 句柄 | 拿不到它 |
| HTTP | 不存在这条写路由 |

**结论：`CONSUMABLE` 与 `DIGITAL_ITEM` 在运行时是同一个东西** —— 两者都
`INVENTORY_GRANT / ITEM`，区别只在契约注释里那句"消耗品"。一件买来只会**累加**
的消耗品不是消耗品，而是一个挂着消耗品名字的永久资产。

### 2.2 缝的形状

```js
store.consumeOwnedItem({ productId, quantity, idempotencyKey }, { ownerId, ownerType })
```

**它的五条硬性质，各自都是结构而不是纪律：**

1. **owner 来自权威上下文**。函数体里 `o.ownerId` / `o.characterId` /
   `o.buyerId` **一次都不出现** —— 因此"调用方自报身份"没有地方可以发生
   （与 command channel 的 `NOT_ALLOWED_FOR_A_CONSUMER_TO_SELF_REPORT`
   是同一条纪律的两种落地：那里拒绝那个键，这里根本没有读它的代码）。
2. **只朝一个方向**。传给底层 primitive 的方向是一个**字面量** `'consume'`，
   因此"通过消耗接缝发一次库存"在结构上不可能。
3. **只有 `CONSUMABLE` 能被用掉**。任何其它 kind（含 `DIGITAL_ITEM` /
   `API_QUOTA` / `SERVICE`）⇒ `EFFECT_NOT_ALLOWED` +
   `only-a-consumable-can-be-consumed`，**数量一字不变**。
   ★ 用 `kind` 而不是新加一个字段：`kind → fulfillment → assetKind` 已经是
   "买完发生什么"的唯一编码，再写一个 effect 就是同一件事的第二个答案。
4. **只接受 `productId`**，不接受 `inventoryEntryId`。库存的 canonical 键是
   `(owner_id, product_id)`，而一个 entry id 是**行 id** —— 接受它等于允许
   "拿别人的行 id 来扣"。用 `(owner, product)` 表达"用掉我的一个 X"让越权在
   形状上不可表达。
5. **fail closed 五项**：quantity 非正安全整数 / 商品不存在 / `asset_kind ==
   null` / 库存不足（算术守卫影响 0 行 ⇒ 数量一字不变）/ system party。

**消耗不动钱**：结果里逐字写着 `ledgerMutation: false` / `walletMutation:
false` / `isAPurchase: false` / `budgetEvaluated: false` / `approvalRequired:
false`。因此它不需要预算、不需要批准 —— 它需要的是"这个 owner 决定用掉自己的
东西"，而那个决定就是权威上下文。

**幂等比购买更关键**：一次重复的购买是多花一次钱（可见），一次重复的消耗是
**静默丢掉一件东西**。因此 `(INVENTORY_CONSUME, idempotencyKey)` + 指纹：
同键重放 ⇒ replay 且只减一次；同键不同用量 ⇒ 冲突，不静默覆盖。

### 2.3 这条缝**没有**被接上任何 transport

| 面 | 状态 |
| --- | --- |
| `http.js` | 零命中（HTTP 上不存在这条写路由） |
| `economy-capability.js` | 零命中（**不是**一个 Agent capability —— 能力表一字未改） |
| `economy-command-channel.js` | 零命中（跨进程唯一开放的命令仍然是那一个） |
| `economy-action-adapter.js` | 仍然把它列为不提供 |
| 生产目录里的调用方 | **0** |

**它是被建好的缝，不是被接上的线。** 把它接上（人类侧 `/internal/economy/
consume-asset`，那需要 `CONSUMER_CAPABILITY_MATRIX` 的第三个 capability）
属于它自己的阶段 —— **接上的时候要接的是这一个函数，而不是 P22-5 的
primitive**，于是"谁的东西可以被用掉"这个问题永远只有一个答案。

---

## 三 · Phase 3 —— Catalog v2

### 3.1 两处差异

```
v1（P22-25）：6 件，含 1 件 SERVICE
v2（P22-26）：5 件，**没有** SERVICE，每件多一个 rarity
```

**① 去掉 `agent_orchestration`（SERVICE）**。它是一件真商品，而它
`PURCHASE_NOT_SUPPORTED`：`SETTLEMENT_PRIMITIVE_OF_FULFILLMENT.
SERVICE_EXECUTION` 是 `null`（那句注释逐字写着"需要 Action 层"），因此
`preparePurchase` 在**预留之前**就拒绝。

> **一个商店不应该陈列无法结算的商品。**

★ `SERVICE` **保留在 `PRODUCT_KIND` 里**（那五个成员是冻结的，本阶段一个字
不动），只是目录不发布它。

**② 每件多一个 `rarity`**（封闭集合 `COMMON` / `NOTABLE` / `RARE`）。

| 它在哪里 | 它**不在**哪里 |
| --- | --- |
| `catalog-bootstrap.js` 的 SEED（目录层） | `products` 表（不是一列） |
| `RARITY_OF_PRODUCT` 映射 + `rarityFor()` | 商品的 DTO（不多一个键） |
| 呈现层的读法 | 定价 / 可用性 / 审批 / 能力（**零命中**） |

**它与 `effect` 的区别是决定性的**：`effect` 是一个**有经济含义**的概念，
因此它不该有第二个名字；`rarity` 是一个**没有任何经济含义**的纯呈现标签，
因此它不制造第二套答案 —— 但它的安全性必须由"没有任何经济代码读它"来保证，
而不是由它的名字来保证。

### 3.2 载入期四条核对（fail closed）

模块**载入时**逐条跑，命中就 `throw` —— 一个坏目录不可能被启动起来：

| # | 核对 | 命中时 |
| --- | --- | --- |
| ① | 每个 image key 都对应一个**真实存在**的仓库文件（且在 `assets/economy` 之内） | throw（P22-25 起） |
| ② | **每一件商品都买得了**：`settlementPrimitiveOfFulfillment(fulfillmentOfProductKind(kind)).primitive != null` | throw（**P22-26 新增**） |
| ③ | 每件商品的 `rarity` 都在封闭集合里 | throw（**P22-26 新增**） |
| ④ | 种子条目里**没有** `effect` / `category` / `icon` / `level` / `tier` / `attack` / `equipSlot` / `discount` / `featured` / … | throw（**P22-26 新增**） |

② 是本阶段最重要的一条结构规则，而且它的判据是**派生链**（读的就是 prepare
读的那一份登记表），不是一张会漂移的手写名单。

### 3.3 已有世界不被改写

| 世界 | 结果 |
| --- | --- |
| 空目录 | `applied: true` · `reason: 'seeded'` · 五件 v2 商品 |
| 第二遍 apply | `applied: false` · `reason: 'catalog-not-empty'` · **revision / change log / 计数逐字不变**（证明"根本没写"） |
| 用户自己开过店 | 同上，而且系统商店**没有**被建出来 |
| 跑过 v1 的世界 | 同上 —— v2 **不**撤下那件 SERVICE、**不**补 rarity |

**v2 的入口条件仍然是"目录为空"**，因此已经跑过 v1 的世界需要一条独立的、
**显式**的目录升级动作 —— 那属于本阶段之外。

幂等键 `catalog-seed.v2.<id>`：版本进键，因此"重放同一版本"是 replay，
"另一个版本又要写一遍"是 **conflict 拒绝**。

### 3.4 一件留在仓库里的历史资产（如实登记）

`assets/economy/catalog/agent-orchestration.webp` **没有**被删除。

理由：它记录的是 v1 曾经交付过的那件商品，而且**已经跑过 v1 的世界**里那一行
商品的 `imageUrl` 仍然指向它 —— 那是一条只存在于那些世界里的历史引用，而本
阶段看不见它。删掉它会把那些世界的一张图变成 404，而收益只是"磁盘上少一个
文件"。

代价由一条断言如实承担：P22-25 的 B5 原本要求"磁盘集合与种子引用的集合**恰好
相等**"，现在改成 **`磁盘集合 = 种子引用的集合 + 一份逐名登记的历史资产`**：

```js
const DETACHED_HISTORICAL_ASSETS = ['catalog/agent-orchestration.webp'];
```

于是任何**新的**孤儿文件仍然当场变红，而唯一被允许的那一个是被点名的 ——
判据不是一个不等式，而是一份**有名单**的等式。

### 3.5 新增商品是否需要 migration

**不需要，而且这不是"暂时不用"，是结构上不需要。**

| 问题 | 答案 |
| --- | --- |
| 五件 v2 商品要新表 / 新列吗？ | **不**。它们用的是 `products` 上那 17 个既有列，一个字没加 |
| `rarity` 要迁移吗？ | **不**。它不在库里（目录层的一份只读映射 + 呈现层的读法） |
| 要一段数据迁移把 v1 世界升到 v2 吗？ | **不，而且刻意不做**。v2 的入口条件是"目录为空"，因此跑过 v1 的世界根本进不了写路径 |
| 那 v1 世界里那件 SERVICE 怎么办？ | **仍然在**（本阶段不追溯改写历史）。撤下它需要一条**显式**的目录升级动作 —— 那是它自己的阶段 |
| id 会撞吗？ | **不会**：五件沿用 v1 的 id（不制造第二套目录），而幂等键带版本（`catalog-seed.v2.<id>` vs `…v1.<id>`），因此即使有人真的对 v1 世界跑一次 v2，得到的也是 **conflict 拒绝**，而不是静默覆盖 |

**本阶段唯一的 schema 迁移是 Phase 1 的那一条**（`quotes.units`，7 → 8），
它由 §1.3 逐条说明，而且只加列、不改写任何既有值。

---

## 四 · Phase 4 —— Product Fulfillment Contract

**本阶段没有给商品加任何字段。** 这一组的价值是把一条**已经存在**的派生链
写成会红的断言：

```
products.product_kind            ← 本体列
      │  fulfillmentOfProductKind
      ▼
products.fulfillment             ← 派生 + 不可变（不由调用方声明）
      │  settlementPrimitiveOfFulfillment / assetKindOfProductKind
      ▼
economy_inventory(asset_kind)    ← 那一行
```

| 断言 | 内容 |
| --- | --- |
| `PRODUCT_INPUT_KEYS` | 仍然**恰好 13 个** |
| `icon` / `effect` / `rarity` / `category` / `behavior` / `onUse` | 逐个仍被 `product-input-key-not-whitelisted` 拒绝 |
| `kind → fulfillment` · `kind → assetKind` · `fulfillment → primitive` | 三张派生表逐字未变 |
| `COMPUTE_ENTITLEMENT` | 与 `INVENTORY` 是**同一条原语**（assetKind 才是差别） |
| 商品 DTO | 没有 effect / rarity / icon / behavior |
| 行为脚本 | `behaviorScript` / `onPurchase` / `onUse` / `executeProduct` 作为**独立标识符**零命中 |
| `mutateInventoryInTx('grant', …)` | 全仓**只有一处**调用点（发货只有一条实现） |

`SERVICE` 那一侧：报价**可以**创建（价格命题是自洽的），`preparePurchase`
在**预留之前**拒绝（`PURCHASE_NOT_SUPPORTED` + `reservedNothing: true`），
钱包的 `reserved` 与预留计数都是 0。

---

## 五 · Phase 5 —— UI 最小同步

商品卡上只加四样，而且**四样里没有一样是新的经济判定**：

| 新增 | 数据来源 | 说明 |
| --- | --- | --- |
| **状态** | `status` → `statusFace`（**已有**） | 在架上 / 暂停提供 / 已下架 |
| **功能说明** | `fulfillment`（+ `kind`）派生 | 一句话，**不落库、不进 DTO** |
| **已拥有数量** | `GET /economy/inventory`（**已有只读路由**，这一页本来就同时读它 ⇒ **没有新的网络调用**） | "已拥有 N" / "还没有"；读不到时说 `null`（不显示），**不**说 0 |
| **购买后结果预览** | `fulfillment` + `grantQuantity` + `unitName`（**全部已有**） | "会多出 1 件"，**不**预测金额 / 余额 / 可用性 |

**没有加的**（逐条）：

- ❌ **购买按钮** —— `economy-shell.js` 逐字写着 canonical 没有人类直接购买
  这条接缝。加一个按钮等于**造**那条接缝。
- ❌ 管理按钮 / 创建商品按钮。
- ❌ 商品图片渲染 —— P22-17 A6 断言"store UI 里零 PNG/WebP/JPG"，换图是一次
  独立的视觉验收。

三处纯层读法（`functionFaceOf` / `resultPreviewOf` / `ownedQuantityOf`）逐个
导出，因此测试可以对它们做纯调用，不必解析渲染出来的 DOM。

---

## 六 · 六条限制的逐条对账

| 限制 | 结果 |
| --- | --- |
| 不修改 P22 frozen contract 的**语义** | ✅ `ECONOMY_V1_FROZEN_CONTRACT.md` 的三处**显式申报**（§1 水位 7→8；文件头三条例外）。冻结守卫 `test_p22_21_economy_v1_freeze.js` **51/51 通过** |
| 不新增支付能力 | ✅ 没有 provider / 支付动词；消耗**不动钱**，本阶段一次 `commitLedgerTransactionInTx` 都没有加 |
| 不新增 Agent capability | ✅ `CAPABILITY` 仍然恰好两个；`economy-capability.js` 零命中消耗缝 |
| 不新增真实商品管理后台 | ✅ `putStore` / `putProduct` 的生产调用方仍然**只有** `catalog-bootstrap.js`；`http.js` 的 28 个写动词零调用形态一字未改 |
| 不创建第二套 product/effect/asset 词表 | ✅ 没有 catalog `effect`；`PRODUCT_INPUT_KEYS` 仍然 13；载入期核④逐键拦那些名字 |
| Economy authority 单一来源 | ✅ 份数只有一处读取实现（`quoteQuantitiesOf`）；目录只有一处 authority（`catalog-bootstrap.js`）；发货只有一处调用点；消耗只有一条缝 |

---

## 七 · 明确不做（留给下一个阶段）

| 不做 | 为什么 |
| --- | --- |
| 收敛 §15 `EFFECT_TYPE` 与 §22 `fulfillment` 的双模型 | 一处**已登记的不一致**。收敛它需要一次契约变更，应独立成阶段并点名。本阶段只**不制造第三套** |
| 实现 `SERVICE_EXECUTION` 结算原语 | 需要 Action 层；v2 的答案是**不发布**，不是"先做了" |
| 把消耗缝接上 HTTP / 人类决定面 | 需要 `CONSUMER_CAPABILITY_MATRIX` 的第三个 capability。缝已经建好，接线是自己的阶段 |
| 已有 v1 世界的目录升级 | v2 的入口条件是"目录为空"；升级要一条显式动作 |
| 退款 | `PURCHASE_HAS_REFUND = false` 是冻结的 |
| 商品图片渲染进 Storefront | 独立的 UI + 视觉验收阶段 |
| Android | 用户明确禁止 |

---

## 八 · 新测试（五套之外的四套 + 一套扩展）

| 文件 | 证明什么 |
| --- | --- |
| `tests/test_p22_26_product_units.js` | 份数的权威只有一处；`units = 1 / 3 / (1000×3)` 三条黄金路径；旧单数量语义逐字兼容；坏 units fail closed；幂等 |
| `tests/test_p22_26_inventory_consume.js` | 缝存在且只朝一个方向；5 → 4；payload 自报 owner 被完全忽略；非消耗品拒绝；消耗不动钱；**两个真实进程**同时扣 ⇒ 恰好一个成功、数量恰好 0 |
| `tests/test_p22_26_catalog_v2.js` | 版本与幂等键；**把一件 SERVICE 放进种子 ⇒ 模块载入期真的抛**（+ 反向对照）；rarity 只在目录层；没有第二套词表；五件全都能买；已有世界一字不改 |
| `tests/test_p22_26_product_fulfillment.js` | 派生链逐字；`PRODUCT_INPUT_KEYS` 仍然 13；没有 effect / behavior；primitive 是唯一适配点；链上每一环由行为证明 |
| `tests/fixtures/p22-26-consume-item-worker.js` | 多进程夹具（**新增**，不改 P22-5 那一个 —— 改它会静默改变 P22-5 证明了什么） |

---

## 九 · 本阶段改动过断言的那些地方（逐条点名）

契约变化必然让一些**字面量**断言失效。每一处都逐个点名，并说明它证明的东西
有没有变：

| 文件 | 断言 | 为什么改 |
| --- | --- | --- |
| `test_p22_1_economy_boundary.js` | B13.17 报价列清单 | 多一列 `units`（否定清单未变） |
| `test_p22_2_economy_runtime.js` | C10 / C12 / D8 的 `SEEDED_CHANGES` 7 → 6 | 种子从 6 件变 5 件 |
| `test_p22_3_economy_runtime.js` | B9 的 `revision === 3` → 前后快照 | 字面 revision 依赖种子件数；判据回到"这些 POST 什么都没改" |
| `test_p22_5_economy_catalog.js` | J3 迁移形状 | 新增 7→8；判据仍是"每一步要么空、要么只加列" |
| `test_p22_5_economy_runtime.js` | B1 的 `SEEDED_PRODUCTS` 6 → 5 | 种子件数 |
| `test_p22_6_economy_runtime.js` | A5 / B2 / B10 水位 | 抬到 8 |
| `test_p22_6_economy_purchase.js` | D12 去掉两条 units 形状用例，新增 D12U / D12V | `units` 不再是入参，而是**被忽略的键** —— 新断言更强 |
| `test_p22_7_economy_runtime.js` | B2 / B10 水位 | 抬到 8 |
| `test_p22_8_economy_decision_bridge.js` | L5 / L5B / L6 / L7 | 新增 7→8 的判据；L7 的"更新的库"跟着 `SCHEMA_VERSION` 走 |
| `test_p22_8_economy_runtime.js` | B2 / B10 水位 | 抬到 8 |
| `test_p22_17_economy_store_ui_core.js` | （未改）B3 | 改成**改文案**而不是改断言：功能说明避开 P22-16 那三个类别中文名 |
| `test_p22_19_economy_read_contract.js` | E4 水位 | 已申报的抬水位；其余三条判据更强 |
| `test_p22_21_economy_v1_freeze.js` | S1 / T1 的写死 `7` | 改为由 §1 表格**自己**给出，并由 T1 核对真实新建的库 |
| `test_p22_25_catalog_bootstrap.js` | A4 / B5 / G9 | A4 原本要求种子里**含**那件 SERVICE 反例（v2 不发布它）；B5 的历史资产登记见 §3.4；G9 的判据回到它真正的主体（**商品表**的列清单 —— P22-26 改的是 quotes） |

**没有一处是为了让它变绿而放宽的**：上表里每一行要么是"字面量随已申报的契约
变化而更新"，要么是"判据换成同一件事的更强表达"。

### 9.1 两条**没有**改断言的假阳性（改的是被测代码）

| 命中 | 处置 |
| --- | --- |
| `test_p22_17_economy_store_ui_core.js` B3（"纯层源码里不得出现商品类别中文名"） | 命中两次，两次都在**我新写的注释与文案**里（"消耗品"这三个字）。判据**一个字没改** —— 改的是那两处措辞：它们本来就不需要逐字使用类别名。那条断言防的是"有人在这里又抄一张类别表"，而它现在仍然防得住 |
| `test_p22_4_economy_quote.js` A2（PRAGMA 读回来的报价列） | 见上表；而它的 `banned` 清单（`api_key` / `inventory_count` / `provider_quota_balance` …）**一个字没改** |

### 9.2 两次真实的自我纠正（如实记录）

**① 我压平了一行源码，而冻结守卫抓住了它。**

P22-21 的 T3 断言 `const *_TABLE` 常量恰好 **19** 个。我在用单行锚点替换 schema
水位那一行时，把 `const META_TABLE = …; const CHANGE_LOG_TABLE = …;` 压成了
**同一行** —— `CHANGE_LOG_TABLE` 因此不再匹配 `^const ([A-Z_]+_TABLE) = '…'`，
计数掉到 **18**。一个纯粹的意外改动，而它确实改变了源码的形状。已修复。

**② 我在 P22-7 的 runtime 里引用了 `SERVICE`，而那个文件里没有这个绑定。**

为了把"水位写成 `SCHEMA_VERSION`"这件事做对，我给两处断言加了
`Number(SERVICE.economyStore.SCHEMA_VERSION)` —— 而 `SERVICE` 是**别的** runtime
文件里的绑定（P22-2/3/4/5/6 有），P22-7 这个文件里**没有**。症状是 B 组整组抛
`ReferenceError`。已改为该文件里真实存在的 `createEconomyStore.SCHEMA_VERSION`。

**两次都不是"断言太严"**：第一次是源码被意外改形，第二次是被测代码（测试文件）
里有一个不存在的标识符。这两条都属于"守卫按设计工作"。

**③ 一条既有的、与本阶段无关的现象**：`test_p22_7_economy_runtime.js` 在**基线**
上也不会自行退出（断言全部打印完之后进程挂着）。我用 `git stash` 把生产文件退回
基线与本阶段改动各跑一次，**两边都挂** —— 因此它是既有的夹具行为，不是本阶段
引入的。回归脚本因此以"输出里出现结论行"为完成判据，而不是以进程退出为准。

---

## 十 · 冻结守卫抓到的一件事（如实记录）

P22-21 的冻结守卫在本阶段第一次运行时**报了三条红**，其中一条是**真问题**：

```
✖ T3 描述性缺口被如实冻结：`const *_TABLE` 常量 19 个 · … — {"constCount":18,…}
```

我在本文件开头用单行锚点替换 schema 水位那一行时，把
`const META_TABLE = …; const CHANGE_LOG_TABLE = …;` 压成了**同一行**。
`CHANGE_LOG_TABLE` 因此不再匹配 `^const ([A-Z_]+_TABLE) = '…'`，常量计数从
19 掉到 **18** —— 一个纯粹的意外改动，而它**确实**改变了源码的形状。

这正是那条守卫存在的理由。已修复（恢复独立行），T3 重新通过。

另两条红（S1 / T1）是水位字面量，按 §1 的申报更新。

---

## 十一 · 留给下一个人的一句话

```text
P22-26 申报了 schema 8（quotes.units）、目录 v2（去 SERVICE + 目录层 rarity）、
以及一条唯一且**未接线**的消耗缝（consumeOwnedItem）。

它没有扩大 v1 的公开面：没有新路由、没有新 capability、没有新事件类型、
没有新生产文件、没有新币种 / 资产类别 / 状态机成员。

下一步若要把消耗接上人类决定面，请接 consumeOwnedItem ——
不要接 P22-5 的 consumeInventory，那会让"谁的东西可以被用掉"有两个答案。
```
