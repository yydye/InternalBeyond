# P22-24 · Economy Not-Found Wire Contract Closure

基线：`234b481`（P22-23 · Economy First-Run / Home Node Provisioning Closure）。
提交信息：`P22-24 · close the Economy not-found wire contract`。

这一阶段只做一件事：**把 canonical 裁决词表与客户端资源缺席词表分开**。
它不是 UI 美化、不是新能力、不是 Catalog 实现，也不是 Authorization 的任何改动。

---

## 1 · 范围（做了什么，以及刻意没做什么）

**做**：

1. 修 `services/home-node/http.js` 上**两条**读面在"资源不存在"时的 error token
   ——`/economy/approval` 与 `/economy/autonomy-policy`；
2. 新增 anti-leak 回归守卫 `tests/test_p22_24_not_found_wire_contract.js`；
3. 新增 fresh-owner 真路径验收 `tests/test_p22_24_fresh_owner_autonomy_ui.js`
   （真实 Home Node + 真实静态层 + 真实浏览器，**纯 GUI** 走完首次自主购买配置）；
4. 修改 `tests/test_p22_7_economy_runtime.js:262` 那一条**冻结了错误 wire shape**
   的断言（旧断言冻结的是一个 bug，见 §4）；
5. 顺带做只读的 **Catalog fresh-world 审计**（§7）——只审计，不实现。

**刻意没做**（逐条）：

* 没有改 `economy-store.js` / `economy-contract.js` / evaluator / settlement /
  schema / capability / event types；
* 没有让 `assets/js/economy-configuration-core.js` 去特判 `POLICY_NOT_FOUND`
  ——那等于让客户端学习泄漏出来的内部裁决词表；
* 没有新增任何错误词（新 token 一个都没有：`errors[0]` 本来就是 store 给
  客户端的那个词）；
* 没有自动创建 autonomy policy、没有自动 enable、没有给 fresh owner 写默认
  allow 规则、没有把 absence 读成 AUTO_ALLOW；
* 没有实现 Catalog provisioning（只在 §7 标记为 NEXT_CANDIDATE）；
* 没有碰 `Economy-v1-release/` 那份镜像目录（它不在本阶段范围内）。

**production diff 精确清单（只有一条文件）**：

```
services/home-node/http.js      | 两条读面的 error token + 说明性注释
```

（`git diff --stat`：`services/home-node/http.js | 33 +++++++++++++++++--`
—— 其中 **2 行是行为改动**，其余是注释。`assets/**`、`runtime/**`、
`economy-store.js`、`economy-contract.js` 的 diff **为空**。）

UI 侧 **production diff = 0**：`assets/js/**` 一个字节都没改。

**测试侧改动清单**（供审计对照）：

```
tests/test_p22_7_economy_runtime.js                 | B8 一条断言 + 凭据接线（见 §8.1）
tests/test-all.js                                   | 登记新的 anti-leak 守卫（加一行 + 说明）
tests/test_p22_24_not_found_wire_contract.js        | 新增
tests/test_p22_24_fresh_owner_autonomy_ui.js        | 新增
tests/fixtures/p22-cdp-client.js                    | 新增（从 P22-23 那条验收里抽出的共享 CDP 夹具）
docs/P22-24-NOT-FOUND-WIRE-CONTRACT.md              | 本文件
```

---

## 2 · 只读审计的结论（根因）

### 2.1 两级词表本来是分开的，seam 把它们混了

```
store / evaluator（裁决面）
  reasonCode = 'POLICY_NOT_FOUND'        ← canonical DENY_REASON，SCREAMING_SNAKE
  errors[]   = ['autonomy-policy-not-found']  ← 给客户端的资源缺席 token，kebab-case

HTTP client-facing（`body.error`）
  应当发的是上面那个 **errors[0]**

UI（P22-16 的 production core）
  code === 'autonomy-policy-not-found'  →  state = 'absent'  →  渲染首次配置表单
```

`economy-store.js:10538` 给的正是这一对：

```js
if (!row) return { ok: false, denied: true, reasonCode: C.DENY_REASON.POLICY_NOT_FOUND,
                   errors: ['autonomy-policy-not-found'], ownerId: ... };
```

而 `http.js` 发的是 `result.reasonCode || result.errors[0] || …` —— 顺序反了。

### 2.2 同一个 seam 上本来就有一条正确的规矩

真实节点实测（`127.0.0.1:23118`，带桌面凭据）：

| 读面 | 线上 `error` |
|---|---|
| `/economy/wallet` | `wallet-not-found` |
| `/economy/policy` | `budget-policy-not-found` |
| `/economy/product` | `product-not-found` |
| `/economy/store` | `store-not-found` |
| `/economy/quote` | `quote-not-found` |
| `/economy/purchase` | `purchase-not-found` |
| `/economy/approval` | **`APPROVAL_NOT_FOUND`** ← 泄漏 |
| `/economy/autonomy-policy` | **`POLICY_NOT_FOUND`** ← 泄漏 |

源码级证据：`http.js` 里"缺席即 404"的 error token **15 条**（11 条
`bad(res, 404, …)` + 2 条三元状态形态 + 2 条同族），其中被修的这 2 条是唯一
写成 `reasonCode ||` 的。相邻的 `/economy/wallet`（:1562）与 `/economy/policy`
（:1757）一直用的是 `errors[0]`。

### 2.3 后果是**产品级**的（这是"断链"的证据，不是猜测）

把**真实服务器回答**（不是手写的夹具）喂给 production UI core：

```
autonomy · 真实回答        -> state=unknown  text="读不到自主规则"  detail="POLICY_NOT_FOUND"
autonomy · 测试夹具的回答   -> state=absent
budget   · 真实回答        -> state=absent
```

于是 Economy 设置页「自主购买」那一格在**全新 owner** 上显示的是
「读不到自主规则」+ 一个原始裁决词 + 一个永远无效的「再试一次」，而
`state === 'absent'` 那条分支（含首次配置表单）在**产品里从来没有执行过**。

为什么 P22-16 → P22-22 → P22-23 三轮都没发现（测试保真度缺口，逐条可证）：

* `tests/test_p22_16_economy_configuration_ui_core.js:561`、
  `tests/test_p22_16_economy_configuration_ui.js:257`、
  `tests/test_p22_22_economy_empty_state_visual.js:240` —— 三处夹具都手写
  `error: 'autonomy-policy-not-found'`，正是 UI 想要的那个词；
* `test_p22_14_economy_bootstrap_runtime.js:222` 只断言
  `store.getAutonomyPolicy(...).ok === false`，**从不断言那条 404 的线上 error**；
* `test_p22_23_first_run_acceptance.js` 从未打开「自主购买」那一格；
* `test_p22_7_economy_runtime.js:262` 反而把错误的形状**当成契约冻结**了。

---

## 3 · 修复（production）

```diff
--- a/services/home-node/http.js
@@ /economy/approval (GET)
-        bad(res, result.reasonCode === 'APPROVAL_NOT_FOUND' ? 404 : 400,
-          result.reasonCode || result.errors[0] || 'approval-not-found', null, req);
+        bad(res, result.reasonCode === 'APPROVAL_NOT_FOUND' ? 404 : 400,
+          result.errors[0] || 'approval-not-found', null, req);
@@ /economy/autonomy-policy (GET)
-        bad(res, result.reasonCode === 'POLICY_NOT_FOUND' ? 404 : 400,
-          result.reasonCode || result.errors[0] || 'autonomy-policy-not-found', null, req);
+        bad(res, result.reasonCode === 'POLICY_NOT_FOUND' ? 404 : 400,
+          result.errors[0] || 'autonomy-policy-not-found', null, req);
```

**status 的判据一个字都没改**：`reasonCode === 'X' ? 404 : 400` 仍然是"算不算
404"的答案；改的只是"这句话用哪个词说"。因此：

* 404 仍然是 404；
* canonical `DENY_REASON.POLICY_NOT_FOUND` / `APPROVAL_NOT_FOUND` 仍然存在、
  仍然由 store 与 evaluator 产生；
* store 的 result 形状（`ok/denied/reasonCode/errors`）一个字段没动。

两处都写了注释说明**为什么顺序是 `errors[0]` 而不是 `reasonCode`** ——
下一次有人手滑写回去时，注释与守卫（§5 的 ⑧）会同时拦他。

---

## 4 · P22-7 那一条断言：OLD ASSERTION FROZE A BUG

**文件**：`tests/test_p22_7_economy_runtime.js`
**位置**：B8（原第 260–262 行）
**授权范围**：只改这一条。本阶段**没有**动 P22-7 的任何其它断言。

| | 内容 |
|---|---|
| **旧期待** | `noPolicy.status === 404 && noPolicy.body.error === 'POLICY_NOT_FOUND'` |
| **新期待** | `noPolicy.status === 404 && noPolicy.body.error === 'autonomy-policy-not-found'`（并且 `body.error !== C.DENY_REASON.POLICY_NOT_FOUND`） |
| **canonical reason** | `C.DENY_REASON.POLICY_NOT_FOUND` —— **不变**。新断言里用**同一份 fixture 库**直接读 store 对证：`getAutonomyPolicy({ownerId}).reasonCode === C.DENY_REASON.POLICY_NOT_FOUND`、`denied === true`、`errors[0] === body.error` |
| **HTTP status** | `404` —— **不变** |
| **为什么 authority semantics 没有变化** | 这条断言说的是"读面在资源缺席时**怎么说话**"，不是"经济侧怎么裁决"。裁决面（store 的 reasonCode、evaluator 的 fail closed、`AUTONOMY_DEFAULT_WHEN_NO_POLICY = REQUIRE_APPROVAL`）在这条断言的**新版本里被加强了**：它现在同时证明 store 侧仍是 `POLICY_NOT_FOUND`，而线上发的是另一个词表里的词 |

同一条断言的新版本还顺手把两个词表的关系钉成了可执行的事实：
`canonicalNoPolicy.errors[0] === noPolicy.body.error`。

---

## 5 · 新增守卫一：anti-leak wire contract

`tests/test_p22_24_not_found_wire_contract.js` —— **35/35 通过**（约 1.0s，
一个真实 Home Node 子进程 + 私有临时目录 + 显式测试凭据，结束即清理）。
它**不在** test-all 的浏览器集合里，也不开浏览器，因此可以直接进 test-all
的 Node 集合。

它证明四层：

1. **真实节点上** 11 条只读缺席面全部 `404` + kebab-case 资源 token；
2. **词表不互相顶替**：`body.error` 不是任何 `DENY_REASON` 成员。
   判据是**结构**的，不是字符串黑名单：canonical 裁决词是 `SCREAMING_SNAKE`
   （50 个成员全部满足），客户端资源 token 是 kebab-case，两者交集为 0。
   本阶段涉及的两个 token 也逐字证明不在 `DENY_REASON` 里；
3. **同一份真实 payload 喂给 production UI core**：`state === 'absent'`，
   且不带 `text`/`detail`（absent 是系统状态，不是故障）；反方向
   `{ok:false, error:'timeout'}` 仍然是 `state === 'unknown'`
   —— 证明的是**分离**，不是"把一切都读成 absent"；
4. **源码级**：`http.js` 里所有"缺席即 404"的 error token（15 条）都不是
   `reasonCode`；两条被修的路由各自带着客户端兜底 token。

**判据的边界**（刻意限定）：只覆盖这 11 条只读资源面。写面
（`/internal/economy/configuration`）的信封本来就把 `reasonCode` 当
`reasonCode` 发，那是它的契约 —— 这条守卫**不**全局禁止 reason code 出现在
响应里，也不禁止它出现在 diagnostics / debug 数据里。

---

## 6 · 新增守卫二：fresh owner 的真路径（真实浏览器）

`tests/test_p22_24_fresh_owner_autonomy_ui.js` —— **25/25 通过**（约 60–100s，
真实 Chromium + 真实 Home Node + 真实静态层，一个浏览器实例复用到底）。

它走的链（全部真实，一个字节的网络都不假）：

```
环境里没有 IB_HOME_NODE_TOKEN 的正常启动
  → 凭据由 P22-23 的 authority 自动创造（磁盘上真的出现那一份）
  → 权威侧：这个 owner count=0
  → GET /economy/autonomy-policy ⇒ 404 + 'autonomy-policy-not-found'
  → 页面经 http://127.0.0.1:<web>/InternalBeyond.html 载入（产品启动链的 origin）
  → 真实页面：Economy → 设置 → 自主购买
  → 看到「还没有自主规则 …」（系统状态）+ 真实表单，**没有**「读不到自主规则」，
    **没有**「再试一次」，页面上不出现 POLICY_NOT_FOUND
  → 填表（开关 + 300/900/150 + 两个范围）→ 点真实的「保存」
  → 权威侧真的落了一条策略（300 → 30000 minor，canonical 形状）
  → 重新读 GET /economy/autonomy-policy ⇒ 200 + canonical rule
  → 页面进入 configured 状态（表单里是刚写下的那一份）
```

外加**对照面**（这一条是本阶段的另一半要求）：

* 用真实 fetch 覆盖只让那一条读面失败 → 出现「再试一次」，且**没有**保存表单；
* 于是 absence 与真故障是**两件事**，各自有各自的界面。

以及两个外观：Internal 与 Infernal Beyond 各拍一次，`390` 窄屏一次。
截图只落 `%TEMP%\ib-p22-24-shots\`（7 张，仓库新增 PNG = 0）。

**这一条测试也在"看图"这件事上吃过亏**（诚实记录）：第一版 25 条断言全绿，
而截图拍到的是**首启欢迎向导**盖住整屏 —— 文字断言在被盖住的 DOM 上照样成立。
因此补了两条硬判据：

* 首启向导按**产品自己的路径**关掉（点它自己的关闭按钮），不是 `removeChild`；
* 探针把"有没有东西盖住这一屏"算成**数值**（向导 `is-open`、启动页
  `visibility/opacity`），并断言两者都是 0/未打开。

---

## 7 · Catalog fresh-world 只读审计（只审计，未实现）

真实 GUI 已经证明：**Store = 0、Product = 0**。逐条回答：

| # | 问题 | 答案（Evidence） |
|---|---|---|
| 1 | `putStore` 的 production caller | **0 个**。8 个生产文件（`services/home-node/*` + `services/*-service.js` + `runtime/*`）里 `putStore(` 只出现 1 次，就是它自己的**定义**（`economy-store.js:7249`） |
| 2 | `putProduct` 的 production caller | **0 个**。同上，唯一出现是定义（`economy-store.js:7376`） |
| 3 | fresh install 时谁创建 Store | **没有任何人**。没有 HTTP 路由、没有 GUI、没有 runner、没有 store 内部 seed |
| 4 | fresh install 时谁创建 Product | **没有任何人**（同上） |
| 5 | 是否存在 built-in catalog fixture | 生产里**不存在**。只有测试夹具会种（例：`tests/fixtures/p22-11-home-node-process.js:72`） |
| 6 | 是否存在 catalog bootstrap | **不存在**（生产文件里 `seedCatalog`/`BUILT_IN`/`DEFAULT_CATALOG`/`bootstrapCatalog` 计数 = 0） |
| 7 | 是否存在版本化 catalog seed | **不存在**（同上；Economy 的 schema 版本只描述表，不种内容） |
| 8 | Store/Product 空库是否就是 canonical fresh-install 状态 | **是**，而且是**设计上正确**的状态。空目录的规范含义是"没有商品"，不是"越权"（P22-21 · D1 逐字）；`/economy/catalog` 与 `/economy/products` 读面在空库上答 200 + 空列表 |
| 9 | AI 是否存在创建 canonical 商品的能力 | **没有**。Economy capability 表是 `2 capability × 4 consumer`（P22-1 起冻结，P22-20 · L2 再次断言），`STORE_ADMIN` / `PRODUCT_ADMIN` 这类 consumer 不在其中；14 个未来动作词全部 `UNKNOWN_ECONOMY_ACTION` |
| 10 | 当前有没有任何 GUI 能创建商品 | **没有**。`economy-shell-core.js` 的读面只有 `/economy/stores` 与 `/economy/products`（只读 GET）；`/economy` 下不存在任何 POST/PUT/PATCH/DELETE（`/economy/*` 写尝试一律 `405 economy-is-read-only`）；`http.js` 里 `economy.putStore`/`economy.putProduct` 调用 = **0** |
| 11 | P22-21 D1 是否已经从"非阻塞引擎债务"变成"Fresh-World 产品可用性缺口" | **是**。当时（P22-21）结论成立的环境是"目录由别的路径提供"；P22-23 关闭首次运行链之后，**纯 GUI 的用户没有任何一条路径能让商店里出现一件商品**：设置页能配钱与规则、钱包能 READY、自主规则能写，但"买什么"永远是空的。这是**Fresh-World 可用性缺口**，不再是"引擎债务" |

**结论**：Catalog provisioning 在生产里**整条缺失**（写方 0、读面齐、GUI 只读、
无 seed、无 bootstrap）。`/economy/catalog` 与 `/economy/products` 在空库上是
**诚实的空**，不是坏掉；缺的是"谁来把第一件商品放进去"。

**NEXT_CANDIDATE: Economy Catalog / Fresh-World Bootstrap** ——
下一阶段处理，本阶段**不实现**（§11 明令）。

一个必须写在这里的边界：Catalog 的写方存在（`putStore`/`putProduct` 是被
P22-5 的 2000+ 条断言压过的生产代码），因此下一阶段补的是**入口与权限**，
不是"从零造一个目录系统"。同时它必须回答"谁有权上架"这个问题 ——
而 `STORE_ADMIN` 现在是**不存在的 capability**，不能顺手加。

---

## 8 · 回归矩阵

| 套件 | 结果 |
|---|---|
| `test_p22_7_economy_runtime.js` | **42/42 通过**（本阶段修了 B8 那一条） |
| `test_p22_7_economy_approval.js` | 全部通过 |
| `test_p22_7_economy_autonomy.js` | 全部通过 |
| `test_p22_13_economy_approval_runtime.js` | 全部通过（child 0 / spawn 0 / leftover 0） |
| `test_p22_13_economy_approval_decision.js` | 全部通过（child 0 / spawn 0 / leftover 0） |
| `test_p22_14_economy_bootstrap_runtime.js` | 34/34 |
| `test_p22_14_economy_configuration.js` | 61/61 |
| `test_p22_15_economy_approval_ui_core.js` | ALL PASS |
| `test_p22_15_economy_approval_ui.js` | ALL PASS |
| `test_p22_15_economy_approval_visual.js` | ALL PASS |
| `test_p22_16_economy_configuration_ui_core.js` | 60/60 |
| `test_p22_16_economy_configuration_ui.js` | 59/59 |
| `test_p22_16_economy_configuration_visual.js` | ALL PASS |
| `test_p22_18_economy_experience_ui_core.js` | 66/66 |
| `test_p22_19_economy_owner_scope.js` | PASS |
| `test_p22_19_economy_owner_scope_http.js` | PASS（21 项） |
| `test_p22_19_economy_read_contract.js` | PASS（28 项） |
| `test_p22_20_economy_boundary_injection.js` | PASS（31 项，见下面的 flake 说明） |
| `test_p22_20_economy_external_boundary.js` | PASS（42 项） |
| `test_p22_20_economy_public_surface.js` | PASS（23 项） |
| `test_p22_21_economy_golden_path.js` | PASS（临时目录残留 0） |
| `test_p22_21_economy_v1_closure_audit.js` | PASS（临时目录残留 0） |
| `test_p22_21_economy_v1_freeze.js` | PASS（临时目录残留 0） |
| `test_p22_22_economy_empty_state_visual.js` | ALL PASS |
| `test_p22_23_home_node_provisioning.js` | 全部通过（子进程残留 0） |
| `test_p22_23_first_run_acceptance.js` | 全部通过 |
| **`test_p22_24_not_found_wire_contract.js`**（新增） | **35/35 通过** |
| **`test_p22_24_fresh_owner_autonomy_ui.js`**（新增） | **25/25 通过** |
| `test_p22_1_economy_domain_contract.js` / `test_p22_1_economy_boundary.js` | 全部通过 |

**P22-15 全套重跑的理由**：`/economy/approval` 的 error token 属于决定面读路径
的邻接面，因此按 §9 的要求把 P22-15 三条（core / ui / visual）都跑了 —— 都绿。

**一条 flake，如实披露（未复现）**：`test_p22_20_economy_boundary_injection.js`
在**两个 PowerShell 批次并行**跑 P22 套件时**失败过一次**（`1 FAILED（31 项）`），
失败项的文本没有被当时的输出捕获；此后**串行**连跑 5 次 + 再跑 1 次，6/6
`PASS（31 项）`。因此我**不能**说它已被解释 —— 它在串行下稳定通过，在并行
争用下失败过 1 次。它与本阶段的改动没有可证的联系（该文件的断言集中在
币种注入与 capability 反例，本阶段只改了"缺少资源时 HTTP 说什么词"）。
结论：**未解释、已记录**，下次并行跑 P22 套件时留意。

### 8.1 P22-7 的**凭据接线**（不是断言语义，但同样是本阶段的一处测试改动）

P22-7 的 runtime 测试在 P22-23 之后**整体红了**：那个文件用
`IB_HOME_NODE_DATA_DIR` 指向一个空临时目录起真实节点，**不发任何凭据**；
P22-23 让节点自动 provision 凭据并要求每个 Economy 读面带它，于是 B 组
十几条断言全部变成 `401 unauthenticated`。这与本阶段的修复无关（在
`git stash` 的 `234b481` 基线上同样 401），但本阶段必须把它修好，否则
"回归 P22-7"这句话没有意义。

修法（**只加夹具，不改被测语义**）：

* 该文件新增一个**测试用**常量 `TOKEN`，并把它显式注入被 spawn 的节点
  （`IB_HOME_NODE_TOKEN`）——与 P22-14 runtime 的
  `buildHomeNode({ token: TOKEN })` 同一条纪律，而不是关掉自动 provisioning
  让节点跑在"没有凭据"的形态里（后者会换掉被测对象）；
* `request()` 对 `/economy/*` 与 `/security` 自动附上
  `X-IB-Home-Token`（`/health` 仍然是公开探活面）；
* worker 子进程不碰 HTTP（`tests/fixtures/p22-7-approval-worker.js` 直接
  开 store），因此不需要额外接线。

改完之后 P22-7 runtime **42/42 全绿**，且这一条修复本身没有任何产品代码
改动（没有硬编码 token，产品里也不存在默认 token）。

---

## 9 · 没有改变的 canonical 语义（逐条对证）

| 不变量 | 状态 | 证据 |
|---|---|---|
| `POLICY_NOT_FOUND` 仍是 canonical `DENY_REASON` | **不变** | `economy-contract.js:420`；守卫 ② 断言 50 个成员全是 SCREAMING_SNAKE；P22-7 B8 新版本直接从 store 读它 |
| `AUTONOMY_DEFAULT_WHEN_NO_POLICY = REQUIRE_APPROVAL` | **不变** | `economy-contract.js:4351`；P22-7 B9 仍断言"没有策略 ⇒ fail closed"；本阶段没有一行 evaluator 改动 |
| 没有 policy ≠ 自主购买开启 | **不变** | P22-24 验收里 absence 只解锁**配置表单**；写策略是用户的显式动作，且写下的规则仍受 Budget/商品/报价/Approval 约束 |
| `APPROVAL_NOT_FOUND` 仍是 canonical `DENY_REASON` | **不变** | P22-13 I3 仍断言决定面 seam 的 `downstreamReasonCode === C.DENY_REASON.APPROVAL_NOT_FOUND` |
| store/evaluator/settlement 语义 | **零变化** | production diff 只有 `http.js` 的两行 error token |
| 新增 capability / 写面 / 事件 / schema | **零** | `git status`：`assets/**` 未修改；`services/home-node/http.js` 之外无 production 改动 |

---

## 10 · Stop Gate

| # | 问题 | 答案 |
|---|---|---|
| 1 | `POLICY_NOT_FOUND` 是否仍是 canonical DENY_REASON？ | **是**。`economy-contract.js:420`，未改；守卫与 P22-7 都直接对证 |
| 2 | no-policy 是否仍 REQUIRE_APPROVAL？ | **是**。evaluator 一行未改；P22-7 B9 仍绿 |
| 3 | HTTP 是否不再把 `POLICY_NOT_FOUND` 当 client error？ | **是**。实测 `404 {"ok":false,"error":"autonomy-policy-not-found"}`；守卫 ② 断言它不是任何 DENY_REASON 成员 |
| 4 | fresh owner 是否进入 absent 而不是 unknown？ | **是**。真实 payload 喂 production core ⇒ `state=absent`；真实页面显示「还没有自主规则」 |
| 5 | 首次 autonomy 配置是否能纯 GUI 完成？ | **是**。真实浏览器：填表 → 点保存 → 权威侧落规则 → 页面进 configured（25/25） |
| 6 | absence 是否不再显示 Retry？ | **是**。⑧ 断言「再试一次」不在按钮里；absence 分支渲染表单 |
| 7 | 真 transport failure 是否仍显示 Retry？ | **是**。⑱/⑲：只让那一条读面失败 ⇒ 出现「再试一次」且**没有**保存表单 |
| 8 | approval 是否消除了同类 reason-code leak？ | **是**。`/economy/approval` 现在答 `approval-not-found`；`downstreamReasonCode` 语义未动（P22-13 绿） |
| 9 | P22-7 哪一条坏冻结断言被修改？ | **B8**（`tests/test_p22_7_economy_runtime.js`），逐条披露见 §4 |
| 10 | 是否只有被证明错误的测试语义被修改？ | **是**。整仓只动了 1 条既有断言；P22-7 之外零改动；没有批量更新任何字符串/snapshot |
| 11 | store/evaluator/settlement 是否零语义变化？ | **是**。三个文件一个字节都没改 |
| 12 | 是否新增任何 Economy capability/write/event/schema？ | **否**。新增文件只有两个测试文件与一个测试夹具模块 |
| 13 | P22-14～23 是否回归？ | **是**。见 §8；P22-15 全套也重跑（因为 approval wire 变化） |
| 14 | Catalog fresh-world audit 的结论？ | 写方 0、读面齐、GUI 只读、无 seed、无 bootstrap；空库是 canonical fresh-install 状态，缺的是"谁把第一件商品放进去" |
| 15 | 是否需要下一阶段处理 Catalog provisioning？ | **是** —— `NEXT_CANDIDATE: Economy Catalog / Fresh-World Bootstrap`。本阶段不实现 |
| 16 | production diff 精确有哪些文件？ | **1 个**：`services/home-node/http.js`（两条读面的 error token） |
| 17 | child/spawn/browser/socket/temp/leftover？ | 见下 |

### 17 的明细

| 套件 | child / spawn / browser / socket / temp / leftover |
|---|---|
| `test_p22_24_not_found_wire_contract.js` | 子进程 **1**（真实 Home Node，结束 kill）· spawn 1 · browser **0** · socket 1 个 HTTP server（子进程内）· 临时目录 1（结束 `rmSync`）· 残留 **0** |
| `test_p22_24_fresh_owner_autonomy_ui.js` | 子进程 **3**（home node / 静态层 / Chromium 子进程树按 `taskkill /T /F` 结束）· browser **1**（单实例复用）· 临时目录 3（chrome profile + 两个数据目录，结束 `rmSync`）· 残留 **0**（实测结束后仓库相关 node 进程只剩开发目录本来就在跑的那 5 个） |
| `test_p22_7_economy_runtime.js` | 崩溃注入 worker 全部收敛；结束无残留（`openChildren` 归零） |
| `test_p22_13_*` | 自报 `max concurrent child = 0 · total spawn = 0 · leftover = 0` |
| `test_p22_21_*` | 自报 `临时目录：残留 0 个（目标 0）` |
| `test_p22_23_home_node_provisioning.js` | 自报 `子进程残留：0 个` |
| 仓库新增 PNG | **0**（P22-24 的 7 张截图只落 `%TEMP%\ib-p22-24-shots\`） |

**一次自己造成的副作用，如实披露**：收尾时我用
`node -e "require('./tests/test-all.js')"` 想做一次语法/加载检查，而那个文件
在被 require 时会**真的把全量套件跑起来**。我发现后立刻终止了它（连同它已经
spawn 的子进程，实测只剩 5 个开发目录本来就在跑的服务），并把它在 `%TEMP%`
留下的 686 个临时目录（`ib-devreg-*` / `ib-cdp-band-*`，其中一部分是更早的
运行留下的）全部删除。`git status` 未因此产生任何改动；本阶段产物目录
`ib-p22-24-shots` 保留。

---

## 11 · 最终 verdict

**P22-24 Not-Found Wire Contract = CLOSED**

* 两条泄漏（autonomy / approval）在 canonical HTTP seam 上关闭；
* 客户端词表与裁决词表的分离被**一条守卫**（35/35）钉住，含结构判据；
* fresh owner 的首次自主购买配置**纯 GUI 走通**（25/25，真实浏览器）；
* absence 与真 transport failure 的界面分离被证明；
* authority 语义（canonical reason code / fail closed / REQUIRE_APPROVAL）
  零变化；
* 一条冻结了错误 wire shape 的 P22-7 断言被**逐条披露**地修正。

**未进入**：Catalog implementation · P23 · Android。
