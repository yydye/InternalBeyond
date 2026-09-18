# P22-25 · Economy Catalog Bootstrap

> 阶段目标：解决 **Fresh World 空商店**。只建立 canonical 初始商品目录 ——
> 不实现商城后台、不新增用户/Agent 创建商品能力、不新增购买/支付/merchant 能力、
> 不让 AI 生成商品。
>
> 上游是 P22-24 §7 的那一句 **NEXT_CANDIDATE**：
> "写方存在、读面齐备、GUI 只读、无 seed、无 bootstrap —— 那么**谁**把第一件商品放进去？"

```
Fresh install
    Empty Catalog
        ↓  Catalog Bootstrap（装配期，一次）
    System Market
        ↓
    Initial Products Available
```

---

## 1 · authority 分析（只读审计的结论）

审计对象：`putStore` / `putProduct` · `products/stores` 两个 GET 面 ·
bootstrap/migration 框架 · 图片资产加载路径。

| # | 问题 | 结论 |
| --- | --- | --- |
| 1 | `putStore` / `putProduct` 的定义点 | `services/home-node/economy-store.js`（:7249 / :7376），**各一份** |
| 2 | 它们的生产调用方（P22-24 时） | **0 个**。8 个生产文件里只出现"定义"本身 |
| 3 | 它们能不能从 HTTP 到达 | **不能，而且不允许**。P22-21 §9 的 T5 逐字断言：http.js 的**代码**里 28 个 store 写动词零调用形态（`putStore` / `putProduct` 都在名单上） |
| 4 | 目录的读面 | 齐备：`GET /economy/stores` · `/economy/store` · `/economy/products` · `/economy/product`（:1880–:1911） |
| 5 | 是否存在 catalog bootstrap / 版本化 seed | **不存在**（生产里 `seedCatalog` / `BUILT_IN` / `DEFAULT_CATALOG` / `bootstrapCatalog` 计数 = 0） |
| 6 | Economy 的 schema 迁移框架 | **存在且成熟**：`ECONOMY_SCHEMA_VERSION = 7`，`MIGRATIONS` 由 `open()` 驱动（:1900–:1930）。表用 `CREATE TABLE IF NOT EXISTS` 补，列改动走版本步进 |
| 7 | 商品表的列 | `product_id / store_id / product_kind / fulfillment / name / description / currency / unit_price_minor / unit_name / grant_quantity / asset_kind / status / idempotency_key / fingerprint / revision / created_at / updated_at`。**没有**任何图片列 |
| 8 | 图片/素材资产的既有加载路径 | `services/internal-beyond-server.js`（桌面静态层，`IB_WEB_PORT` 默认 **23120**）从**仓库根**取文件，`.webp → image/webp` 已在 `MIME` 表里（:139）。因此 `/assets/economy/catalog/x.webp` → `<repo>/assets/economy/catalog/x.webp`，**零新代码** |
| 9 | Home Node（23118）会不会服务这些图片 | **不会**：`/assets/*` 不在任何路由上，落进 `authorized()` 之前的分支答 401。图片是**产品资产**，由桌面静态层服务 —— 这是正确的归属 |
| 10 | `represents` 一个商品"能不能买"的判据 | 不在目录里。`productAvailabilityForQuote` 要求**商品 ACTIVE 且货架 ACTIVE**，而预算 / 自主 / 批准三道闸门在购买链上。**空目录 ≠ 越权，也 ≠ 能买** |

**因此断链的确切位置**：不是缺读面、不是缺 schema、不是缺权限，
而是**缺"世界里第一次有商品"这件事的权威**。

---

## 2 · 是否需要 schema 变更

**不需要。** `ECONOMY_SCHEMA_VERSION` 仍然是 **7**，商品表的列一字未改，
没有新增列、没有新增表、没有新的迁移步。

理由是"图片属于谁"这个问题的一个明确答案：

```
"哪张图配这件商品"是**种子**的一部分，不是**商品行**的一部分。
```

顺着这条线，三个必须分开的东西各归其位：

| 事实 | 属于谁 | 为什么 |
| --- | --- | --- |
| 商品的**价格 / 单位 / 交付形态** | 商品行（DB 列） | 它是经济事实，历史报价要能说出"当时那句话"（§27） |
| 商品的**图片引用** | **种子**（`catalog-bootstrap.js` 的 `SEED`） | 它是**呈现**。而"呈现"不该进经济记录：一个换了配图的商品不是一件新商品，一次改图也不该产生一条 economic change |
| 图片的**文件** | 仓库代码资产 | 它是随版本走的静态内容，不是运行时产物 |

于是"用户/Agent 造出来的商品"拿到的是**诚实的 `null`**（它没有配图），
而不是一张猜出来的默认图 —— 这条否定同时被测钉住
（`test_p22_25_catalog_bootstrap.js` B7、`test_p22_25_fresh_catalog_wire.js` B5b）。

> **这条判断的另一面**：如果将来真的需要"用户给商品配图"，那是一个
> **新能力**（一条写入路径 + 一个存储决定 + 一条鉴权规则），
> 而本阶段明确禁止。把图片留在种子里，正好让那条路**现在不存在**而不是
> "存在但没人用"。

---

## 3 · seed 方案

### 3.1 唯一 authority

```
services/home-node/catalog-bootstrap.js      ← P22-25 新增，全仓唯一一份种子
services/home-node-service.js                ← 装配层，唯一调用点（两条启动路径共用）
```

`catalog-bootstrap.js` 的公开面：

| 导出 | 作用 |
| --- | --- |
| `SEED` | 冻结的种子（版本 + 1 间系统商店 + 6 件商品），含每件的 `imageKey` |
| `SEED_VERSION` | `'v1'` —— **固定字面量**，不是时间戳、不是随机值 |
| `SEED_ASSET_KEYS` | 种子引用到的全部 asset key（含商店那张） |
| `assetKeyIsCanonical` | asset key 的**字形**判据（见 §4.2） |
| `missingSeedAssets` | 载入期核对：逐个 `statSync` 每个 key |
| `isSeedProduct` / `imageKeyFor` / `imageUrlFor` | 商品 → 图片引用的**唯一**取值点 |
| `idempotencyKeyFor` | 版本化常量幂等键 `catalog-seed.v1.<id>` |
| `apply(store, { logger })` | **唯一的写入口** |

### 3.2 写路径（三条结构性保证）

```
apply(store)
  ├─ store 没打开 / 读不出来 → 拒绝（requested=false，reason 说清是哪一种）
  ├─ listStores + listProducts
  │     └─ 目录**非空** → applied=false / reason='catalog-not-empty'
  │           ★ 一次写都不发。不是"写之前先比对一下"，而是**根本不进入写路径**
  └─ 目录为空
        ├─ putStore(系统商店, 固定 id, status 显式 ACTIVE, key=catalog-seed.v1.<storeId>)
        └─ putProduct(逐件, 固定 id, status 显式 ACTIVE, key=catalog-seed.v1.<productId>)
```

三条保证不是纪律，是**代码做不到别的事**：

1. **不覆盖用户数据**：写路径的入口条件是"目录为空"。目录非空时那段代码
   从不执行，因此"用户改过的商品被覆盖"没有代码可以违反它。
2. **不重复创建**：`applied` 之外还有一个更强的判据 —— 第二遍之后
   **全局 revision 与 change log 一字不动**（`test_p22_25_catalog_bootstrap.js` D3）。
   "内容看起来一样"与"根本没写"是两件事，这里证明的是后者。
3. **幂等键是版本化常量**：同一个种子版本重放 → store 的 operation
   idempotency 表 `replayed`；另一个版本又要写同一个 id → `conflict`（**拒绝**，
   而不是静默覆盖）。

### 3.3 装配位置（为什么不是一条路由）

```
buildHomeNode().open()  ─┐
                         ├→ applyCatalogBootstrap(store)   ← 唯一实现，两处调用
openAll()               ─┘
```

`applyCatalogBootstrap` 是**一个**函数，两条启动路径共用它 ——
理由与 memoryAssembly / momentsAssembly / economyAssembly 逐字相同：
调用写两遍，"某个入口没种目录"就只会在其中一侧发生（P11-3E / P22-2 踩过的
"测试全绿、生产那台是空的"）。

它**不是** fatal gate：种子写不进去不是"这台节点坏了"（`economyStore.open()`
抛错才是）。空目录仍然是 canonical 的合法状态，它不该让聊天也起不来。
失败只记一次 `economy-catalog-bootstrap-failed`。

### 3.4 种子内容（6 件，覆盖四种交付形态）

| productId | kind → fulfillment / assetKind | 价格 | grantQuantity |
| --- | --- | --- | --- |
| `econ_product_catalog_memory_expansion` | CONSUMABLE → INVENTORY_GRANT / ITEM | 400 | 1 |
| `econ_product_catalog_room_decoration` | DIGITAL_ITEM → INVENTORY_GRANT / ITEM | 600 | 1 |
| `econ_product_catalog_voice_pack` | DIGITAL_ITEM → INVENTORY_GRANT / ITEM | 900 | 1 |
| `econ_product_catalog_gift_box` | CONSUMABLE → INVENTORY_GRANT / ITEM | 150 | 1 |
| `econ_product_catalog_compute_credit` | API_QUOTA → COMPUTE_GRANT / COMPUTE | 800 | 1000 |
| `econ_product_catalog_agent_orchestration` | SERVICE → SERVICE_EXECUTION / **null** | 500 | 0 |

★ 规格列（fulfillment / assetKind / unitName）由 `economy-contract.js`
**派生**，种子里**不重复声明** —— 一份事实只有一个来源，种子里多写一遍
只会制造第二个可能漂移的答案（A3 逐条断言）。

★ SERVICE 那件是契约 §27 点名的反例："买完不产生库存"必须是可表达的，
因此种子里有一件 `grantQuantity: 0` 的服务。

★ 价格量级与 `bootstrapInitialCredit` 的既有量级一致（Tier 个位到三位数
minor），不引入第二个尺度。

---

## 4 · 图片资产方案

### 4.1 生命周期（四段，每段一个 owner）

```
仓库代码资产                     assets/economy/catalog/<name>.webp      （6 个文件，~10KB/个）
    ↓  SEED 里的 image key（字面量）
Catalog seed                     image: 'catalog/<name>.webp'
    ↓  imageUrlFor（唯一取值点）
Product image reference          /assets/economy/catalog/<name>.webp
    ↓  http.js withCatalogImage（唯一派生出站）
UI render                        （既有 productTile —— 见 §7 的边界说明）
```

### 4.2 三条禁止写成**字形**

`assetKeyIsCanonical` 只接受 `catalog/<name>.webp`，其中 `<name>` 是
`[a-z0-9]` 加连字符。这个字符集把三件事变成**不可表示**而不是"被检查"：

| 禁止 | 为什么在这个字形下**没有地方可以放** |
| --- | --- |
| base64 | 字符集里没有 `+` `/` `=`，也没有大写 |
| data URL | 没有 `:` |
| 任何 provider / 临时网络 URL | 没有 scheme、没有第二个 `/`、没有主机名 |

反证也被断言：`https://cdn…/a.webp` · `data:image/webp;base64,…` ·
`/assets/economy/catalog/a.webp` · `catalog/a.png` · `catalog/../../etc/passwd`
**五个形状全部被拒**。

### 4.3 fail closed

- **方向一（引用 → 文件）**：模块**载入时**逐个核对每个 image key 都对应一个
  真实存在的仓库文件。缺一个就 `throw` —— 一个引用了不存在图片的种子会让
  **节点起不来**，而不是静默给出六张破图。
- **方向二（文件 → 引用）**：`assets/economy/**` 的**文件集合与种子引用的
  集合恰好相等**（无孤儿文件，也没有两条引用指向同一张图）。
- **方向三（对外形态）**：不存在的那张图在静态层上是 **404**，而不是一次
  HTML 回落 —— 回落会让 `<img>` 拿到 `200 + text/html`，那是"看起来成功了"
  的坏形态。

### 4.4 视觉

风格：InternalBeyond 玻璃 / 科幻 / companion ecosystem。
六张都是**抽象符号**（晶格环 + 扩容轴 / 等距线框立方体 / 同心发声弧 /
互锁环 + 晶体 / 六边形晶圆 + 电路晶格 / 中枢 + 卫星），不是传统电商图：

| 文件 | 语义 |
| --- | --- |
| `memory-expansion.webp` | 记忆扩容胶囊 |
| `space-module.webp` | 虚拟空间组件 |
| `voice-pack.webp` | 声线素材包 |
| `gift-box.webp` | 心意礼盒 |
| `compute-credit.webp` | 算力额度包 |
| `agent-orchestration.webp` | Agent 编排服务 |

生成方式：**构建期**一次性脚本（`.dsh-research/p22-25-gen-catalog-images.py`，
PIL，3× 超采样 + 辉光 + LANCZOS 降采样，512×512 WebP q90）。
**运行时永远不生成图片** —— `catalog-bootstrap.js` 里没有 `fetch`、没有
`http`、没有时间来源、没有随机源、没有图片编码（G8 先剥注释再断言）。

---

## 5 · 测试结果

### 5.1 新增（两条，全绿）

| 文件 | 规模 | 证明 |
| --- | --- | --- |
| `tests/test_p22_25_catalog_bootstrap.js` | **42 / 42** | 种子形状 · 图片字形与真实文件 · fail closed · fresh install 种成 · 幂等（revision 一字不动）· 用户数据不被覆盖 · 库没开/读不出/写入被拒三条 fail-closed 分支 · capability 里没有 CREATE_PRODUCT · http.js 零写动词 · 调用点唯一 |
| `tests/test_p22_25_fresh_catalog_wire.js` | **26 / 26** | 真实子进程：目录不为空 · 每行带 image/imageUrl · 图片真的可取（静态层在时 `200 + image/webp`；不在时按**文件字节**判定 RIFF/WEBP，逐件记录走的哪条路）· 缺图 404 不是 HTML 回落 · 六种写尝试 405 且商品不增加 · 无凭据仍 401 · **重启一次目录一字未增**（日志上 skipped 而不是 seeded） |

### 5.2 回归（全部串行）

新增改动触到的既有断言 **7 条**（`test_p22_2` ×3、`test_p22_5` ×4），
全部是"空目录/空库"这一类**前提**变了，而不是行为变了；
每条都改成"增量"或"按 id 找"，没有一条被放宽或删除。

| 文件 | 结果 |
| --- | --- |
| `test_p22_2_economy_runtime.js` | **全部通过**（**含修掉 3 条既有红**） |
| `test_p22_5_economy_runtime.js` | **全部通过**（**含修掉 1 条既有红**） |
| `test_p22_11_economy_command_channel.js` | **全部通过**（**含修掉 3 条既有红**） |
| `test_p22_21` golden path / v1 freeze / closure audit | 全绿 |
| `test_p22_1` · `test_p22_9` · `test_p22_10` ×2 · `test_p22_12` · `test_p22_13` ×2 · `test_p22_14` · `test_p22_17` ui_core · `test_p22_19` ×2 · `test_p22_20` ×2 · `test_p22_23` ×2 · `test_p22_24` wire | 全绿 |
| `test_home_node_http.js` · `middle_brain_assembly` · `production_memory_assembly` · `test_m11a` · mobile 五条 | 全绿 |

### 5.3 一条必须点名的既有红：P22-23 的凭据面

`test_p22_2` 的 C 组、`test_p22_5` 的整组 B/D、`test_p22_11` 的 E/H 两组，
在本阶段之前就是 401 —— 因为它们起真实节点、既不注入 token 也不带令牌头，
而 **P22-23 之后 Economy 的读面要求凭据**。这不是本阶段的回归
（每一条都在 `234b481`/`e529dcb` 基线上逐字复现过），但它让"回归 P22-x"
变成一句空话，因此本阶段**只补夹具**（显式测试凭据 + 令牌头），
**断言本身一条都没有放宽**。修完 42/42、全部通过、全部通过。

同一类**未修**（不在本阶段范围内，已逐条在基线上证实为既有红）：
`test_p11_3a` · `test_p11_3g` · `test_p11_3x_a` · `test_p11_3x_b` ·
`test_home_node_lan_gate` · `test_home_node_service`（2 项）。
`test_p11_3e_moments_canonical_closure` 与 `test_p11_3e_moments_mutations`
是**既有挂起**（载入/退出阶段，基线上同样 >120s 不退出）。

---

## 6 · 逐条对照本阶段的禁止项

| 禁止 | 怎么保证的 |
| --- | --- |
| 不新增 Agent capability | `economy-capability.js` **一字未改**；capability 词表仍然只有 `PROPOSE_PURCHASE` / `RESUME_APPROVED_PURCHASE`；`CREATE_PRODUCT` 请求得到 `UNKNOWN_CAPABILITY`（不是"未授予"，是"这个概念不存在"） |
| 不新增用户创建商品入口 | `/economy/*` 下仍然零 POST/PUT/DELETE：六种写尝试一律 405 `economy-is-read-only`，而且写尝试之后商品集合一件不多 |
| 不新增购买能力 | 购买链的文件（`economy-action-adapter` / `command-channel` / `approval-decision` / `configuration`）里 `catalog-bootstrap` **零引用** |
| 不新增支付能力 | 种子只调 `putStore` / `putProduct`，而这两个方法体里没有一次 `commitLedgerTransactionInTx`。change log 只有 `STORE_CREATED` + `PRODUCT_CREATED`；钱包与账本读面都是空数组 |
| 不新增 merchant | 种子里没有 merchant / seller / payout 任何字段；`FORBIDDEN_PRODUCT_FIELDS` 一字未改 |
| 不让 AI 生成商品 | 种子是 `Object.freeze` 的**字面量**；模块不 require 模型、不联网；`image` 只能是仓库里一个既有文件的 key |
| 不在运行时生成图片 | G8：剥注释与字符串之后，模块里没有 `fetch` / `http` / 时间 / 随机 / `sharp` / `canvas` / `base64` / `data:image` |

---

## 7 · 本阶段**没有**做的事（明确边界）

1. **没有把图片渲染进 Storefront。** P22-17 的 A6 逐字断言
   "economy store UI 里零 PNG/WebP/JPG、零外部 CDN、图标全是 inline SVG"，
   而商品格子的视觉身份是**由 productId 确定性派生**的 inline SVG。
   让 `productTile` 改成渲染 `<img>` 会推翻那条断言，那是**一个新阶段**
   （UI 阶段 + 它自己的视觉验收），不是本阶段的授权范围。
   本阶段交付的是**到 UI 边界为止的完整链路**：种子 → 库 → 线上 payload 的
   `image` / `imageUrl` → 一个真的取得到的 `/assets/economy/catalog/*.webp`。
2. **没有把系统商店做成"管理面"。** 种子的货架只能被系统种一次；
   没有改名/上架/下架的任何入口（既没有 HTTP，也没有 GUI）。
3. **没有动 schema。** 见 §2。
4. **没有进入 P23。** 没有 Android、没有 mobile 改动、没有 Catalog 后台、
   没有 P23 的任何一行。

---

## 8 · 变更清单

| 文件 | 性质 |
| --- | --- |
| `services/home-node/catalog-bootstrap.js` | **新增**（335 行）—— 目录 bootstrap 的唯一 authority |
| `services/home-node-service.js` | **+50 / −0**：一处 require、一个 `applyCatalogBootstrap`、两个调用点 |
| `services/home-node/http.js` | **+34 / −2**：一处只读 require、`withCatalogImage`、两个映射点（`/economy/products`、`/economy/product`）。★ 那一处 require 是**只读**的：本文件里 `catalogBootstrap.apply` 零调用，T5 仍然逐字成立 |
| `assets/economy/catalog/*.webp` | **新增** 6 个图片资产（512×512 WebP，共 ~55 KB） |
| `tests/test_p22_25_catalog_bootstrap.js` | **新增**（533 行）42 项 |
| `tests/test_p22_25_fresh_catalog_wire.js` | **新增**（319 行）26 项 |
| `tests/test_p22_2_economy_runtime.js` | 夹具（凭据）+ 3 条"空库"前提改写（+28 / −9） |
| `tests/test_p22_5_economy_runtime.js` | 夹具（凭据）+ 4 条"空目录"前提改写 + B5b 新增（+72 / −21） |
| `tests/test_p22_11_economy_command_channel.js` | 夹具（凭据）（+9 / −2） |
| `tests/test-all.js` | 登记两条新测试（+25 / −0） |
| `docs/ECONOMY_V1_FROZEN_CONTRACT.md` | D1-amend 一行（P22-25 的显式修正） |

**没有**改：`economy-store.js` · `economy-contract.js` · `economy-capability.js` ·
`economy-configuration.js` · `economy-command-channel.js` ·
`economy-action-adapter.js` · `economy-approval-decision.js` ·
`assets/js/**` · `assets/css/**` · `services/internal-beyond-server.js`。
