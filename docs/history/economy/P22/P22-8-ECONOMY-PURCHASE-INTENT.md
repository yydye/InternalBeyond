# P22-8 · Agent Purchase Intent + Decision Bridge

> 基线：`5a10940` · P22-7 · add Economy approval and autonomous purchase policy
> 本阶段：第一次允许 Agent（模型）**提出内部购买意图**，而它只能提出"想买什么"。

---

## 1. 三句话，三个层，绝不合并

```text
Agent decides WANT          →  proposeAgentPurchaseIntent   （本阶段）
Economy decides MAY         →  evaluateAutonomousPurchaseFor（P22-7，冻结）
Runtime executes SETTLEMENT →  preparePurchase / settlePurchase（P22-6，冻结）
```

本阶段**只**新增第一层，并且它一次都没有越过第二层与第三层：所有执行都由
P22-6 的两个既有入口完成，所有权限都由 P22-7 的既有判定回答。

```text
Agent reasoning
      ↓
Purchase Intent                 （canonical，econ_agentintent_）
      ↓
deterministic validation        （§4：模型不得提供经济事实）
      ↓
Product-backed Quote            （价格只能来自 canonical 商品行）
      ↓
P22-7 Authority Gate            AUTO_ALLOW / REQUIRE_APPROVAL / DENY
      ↓
P22-6 Purchase                  Budget → Reservation → 原子结算
```

---

## 2. 先审计，再接线（§2 要求的只读确认）

| 被审计的 seam | 结论 |
|---|---|
| `active/commerce.js` | **不是**治理缝。它是浏览器侧的购物状态机（Playwright MCP 的 `mcp.shopping.*`），通向真实收银台（`alipay-agent-payment` 边界）；按它的文件头铁律**零 Harness 耦合**（不 require `node-model-port` / `agent-runtime`）。因此它与 Home Node 的内部经济**没有任何**调用关系 —— 它是一条**平行**域。 |
| `active/active-plans.js` | 已有的"结构化意图"形态：模型输出 `{"action":"schedule", …}`，由 `active-plans` 校验并落成一条 plan。它是**调度**意图，不是经济意图，且活在浏览器侧。**值得借用的是形状**（窄 JSON + 确定性校验 + 拒绝整体回滚），不是它的代码。 |
| `services/home-node/middle-brain.js` | Home Node 进入 **canonical Middle Brain 执行缝**的唯一入口，而它自己不做任何 decision/side-effect（无 decision / intent / action 分支）。因此本阶段**不**改它（§14：不得让它成为第二个 Economy authority）。 |
| P22-1 冻结的 `PURCHASE_INTENT` | ★ 关键发现：`PURCHASE_INTENT`（`econ_intent_`）**已经**被 P22-6 用在"一笔 Purchase 本身"上了。因此 Agent 的"一次打算"**不能**复用它 —— 见 §3。 |
| P22-6 / P22-7 的既有接口 | `preparePurchase` 的入参里**没有** `approvalMode`（授权由两份证据推导）；`settlePurchase` 恰好三个键（`purchaseId` / `idempotencyKey` / `now`）；`evaluateAutonomousPurchaseFor` 返回 `evaluatedOnly:true` 的快照。本阶段全部照用，一个都没改。 |

**最小 canonical seam 的结论**：本阶段**不新造 Decision framework**。它加的是
一个**窄接口**（`proposeAgentPurchaseIntent`）+ 一个新实体（Agent Purchase
Intent），而两者都挂在既有的 Economy runtime 上。

---

## 3. 为什么 Intent 需要自己的第 16 种 id 前缀

这是本阶段最容易走错的一步，因为两个名字读起来几乎一样：

```text
PURCHASE_INTENT  econ_intent_        = 一笔 Purchase **本身**（P22-6 用掉的）
AGENT_INTENT     econ_agentintent_   = 一次**打算**（本阶段新增）
```

它们**不是**同一个东西：一条打算可以永远不变成购买（`WAITING_APPROVAL` /
`DENIED` / `EXPIRED`），也可能变成一个购买（`COMPLETED`）。而"一个会变成
另一个的东西不是同一个东西"。

如果两者共用一个前缀，那么每一次审计都要先回答"这个 `econ_intent_` 指向打算
还是购买"—— 而那个答案取决于它出现在哪张表里。这正是 P22-7 拒绝让 Approval
复用 `econ_intent_` 时给出的**同一个**理由。

配套的还有命名空间：`ib.economy.agent-intent`（与 `ib.economy.purchase` 并列）。

---

## 4. 表里**没有地方**可以读价格

`economy_purchase_intents` 的列清单里**没有**：

```text
amount_minor   currency   price   unit_price_minor   grant_quantity
settlement_type   asset_kind   unit_name
reservation_id   transaction_id   ledger_transaction_id   inventory_entry_id
```

唯一的数量列是 `units`，而它是一个**选择**（"两杯咖啡"）而不是一个**事实**。

于是 §4 那句话不是靠"我们记得不要读 price"来遵守的，而是结构性的：
**没有那一列**。这条纪律的机器版本是 P22-8 测试的 L 组（列级断言）。

---

## 5. §4：模型不得提供经济事实

提议入口只接受**六个键**：

```text
agentId · productId · recipientId · units · reason · expiresAt
```

而下面这些**任何**一个出现在提议里都会让**整条提议**被拒绝，理由码是
`MODEL_SUPPLIED_ECONOMIC_FACT`：

```text
amountMinor · amount · price · unitPriceMinor · cost · totalMinor
currency · discount · promo · coupon · priceMinor
grantQuantity · settlementType · assetKind · fulfillment · unitName
walletId · walletBalance · balanceMinor · reservedBalanceMinor
budgetResult · budgetDecision · budgetOutcome · budgetPolicyId
autonomyOutcome · autonomyPolicyId · autoAllow
approvalId · approvalBindingFingerprint · approved · isApproved · approvalRequired
purchaseId · purchaseState · quoteId · quoteState · reservationId
transactionId · ledgerTransactionId · inventoryEntryId
providerApiKey · providerAccount · providerBalance · providerTopup
providerQuota · realMoney · realPrice · fiatAmount · cny · usd
checkoutUrl · paymentIntent · paymentLink · stock · owned
```

三条设计决定值得单独写下：

1. **匹配是大小写不敏感 + 去分隔符的**。`amount_minor` / `AmountMinor` /
   `amount-minor` 是同一个企图。一个只认精确 camelCase 的黑名单等于在说
   "换个写法就可以"，那不是边界，那是拼写检查。
2. **经济事实的拒绝排在未知键之前**。一条同时递了 `price` 与 `nonsense` 的
   提议，正确的第一句话是"你的手伸进了经济事实里"，而不是"你有个不认识的
   字段"。前者更严重（信任边界违规），而它只有在顺序正确时才说得出。
3. **未知键是拒绝而不是静默忽略**。静默忽略一个模型以为有用的参数，会让它
   反复尝试同一个参数而永远得不到更正 —— 那正是"幻觉的参数看起来像是生效了"。

### `units` 在，`grantQuantity` 不在

这不是漏了，而是本阶段最要紧的一次切分：

| Agent 有权选择的（WANT） | Economy 独占的（FACT） |
|---|---|
| `productId` | `amountMinor` / `price` / `currency` |
| `recipientId` | `discount` / `promo` / `coupon` |
| `units`（要几份） | `grantQuantity`（一份实际发放多少） |
| | `settlementType` / `assetKind` / `unitName` |
| | 任何权威词（`approved` / `approvalId` / `autoAllow` …） |

左边三个是"选哪一件、送给谁、要几份"——**一个选择**。右边是"这东西值多少
钱、要发多少资产、谁批准了"——**一个事实**。把 `units` 当成经济事实会让
Agent 连"两杯咖啡"都说不出口；把 `grantQuantity` 交给它等于让它自己发资产
（P22-5 的 `grantQuantity` 是商品的**本体**列）。

**载入期不变量**在执行这条切分：提议白名单与"派生经济值"清单必须**不相交**，
而七个权威词必须全部被认成经济事实。`units` 曾经被误列进那份名单，而契约在
`require` 的那一刻就炸了 —— 这正是"把纪律写成载入期不变量"要得到的反馈速度。

### `reason` 只是 telemetry

```text
PURCHASE_INTENT_REASON_IS_AUTHORITY = false
PURCHASE_INTENT_REASON_PARTICIPATES_IN_DECISIONS = false
PURCHASE_INTENT_IS_A_PERMISSION = false
```

三条机器可断言的自述。而 `reason`：

- **不进**意图指纹（所以"换个说法"不能绕过重复抑制）；
- **不进**任何判定（LLM 说"很便宜""必须买""用户肯定同意"全部没有 authority）；
- 有**上界**（400，与 `makeEconomyEvent` 的 metadata 字符串上限逐字相同）。

它进 `change log` 的 payload（可解释性），并在读面上与
`reasonIsAuthority: false` **并列**出现 —— 读到理由的消费者同时读到"它不是权限"。

---

## 6. §5 Intent → Product-backed Quote

```text
productId → canonical Product row → createProductQuote()
```

`createProductQuote` 的参数列表里**没有** `amountMinor` / `currency` /
`quantity` / `kind`。因此"模型指定价格"在这一层不是被拒绝，而是**没有地方可放**。

报价的 id 由 intent **确定性派生**（`econ_quote_from_<intentSuffix>`）：同一条
intent 的报价永远是**同一份**，于是重放时找到的是它，而不是第二份。

**报价的有效期与 intent 的有效期是同一个数**（`expiresAt` 直接传给报价）。
这不是省事：§7 要求"批准不得复活已经过期的报价"，而如果 intent 活得比它的
报价久，就会出现"intent 还有效、而它那份报价已经死了"这种只能靠运行时兜的
缝隙。两者同寿之后，"intent 没过期"**蕴含**"它那份报价也没过期" —— 不变量，
而不是检查。

商品 `DISABLED` / `RETIRED` / missing / 货架不 ACTIVE 一律 fail closed，而且
在**写任何东西之前**（`proposedNothing: true`）：一条指向不存在商品的 intent
连自己的报价都生成不出来，先写一条注定失败的记录只会让审计多出噪音。

---

## 7. §6 三条出口

| 权威判定 | Intent 走到 | 经济动作 |
|---|---|---|
| `AUTO_ALLOW` | `EXECUTING` → `COMPLETED` | **完整**走 P22-6：Budget → Reservation → 最终复核 → 原子结算 |
| `REQUIRE_APPROVAL` | `WAITING_APPROVAL` | **零**：不 reserve、不扣钱、不发货；只创建一条 `PENDING` 批准 |
| `DENY` | `DENIED`（终态） | 零；**不创建可执行的 Purchase** |

`REQUIRE_APPROVAL` 那一条路径上**没有任何 P22-6 调用** —— 不是"我们记得跳过
它"，而是那一段代码里根本没有那个函数名。

**AUTO_ALLOW 仍然必经 Budget**：权威说"这台 Agent 有权不问用户直接花"，
而预算说"这笔钱超了单笔上限"时，intent 走 `FAILED`、一分钱没动。
这条由 C1/C2 逐条断言（余额逐字不变、`reserved` 为 0）。

---

## 8. §7 Approval 恢复路径

恢复**不问模型第二次**：`resumeAgentPurchaseIntent` 的入参只有
`agentIntentId` / `approvalId` / `idempotencyKey` —— 它**不接受**
`agentId` / `productId` / `recipientId` / `units` / 报价。

它**也不重新生成报价**：用的就是 intent 上挂的那一份。于是"批准一份 400 的
报价、然后执行一份 500 的"在结构上不成立。

**批准不得复活已经过期的报价**：报价过期时 P22-6 的 `preparePurchase` 会在
自己的写锁里重新比较 `expires_at` 并拒绝，intent 走到 `EXPIRED`，而那**条批准
仍然存在且没有被消费** —— "没执行"与"批准被用掉了"是两句话（E7/E8）。

---

## 9. §8 Intent 状态机

```text
PROPOSED ──┬─→ WAITING_APPROVAL ──┬─→ EXECUTING ──┬─→ COMPLETED  （终态）
           │                      │              ├─→ EXPIRED    （终态）
           ├─→ EXECUTING ─────────┘              └─→ FAILED     （终态）
           ├─→ DENIED   （终态）
           ├─→ EXPIRED  （终态）
           └─→ FAILED   （终态）
```

- **四条终态的出边全空** → §8 的三条禁令（COMPLETED 不可逆 / DENIED 不可复活 /
  EXPIRED 不可复活）是**结构**事实，而载入期不变量逐条断言它们。
- **一个自环都没有**：每一个合法迁移都意味着**真的动了**。这也是为什么"挂报价"
  与"挂购买"**不是**状态迁移，而是各自一条独立的 SQL（带 `AND quote_id IS NULL`
  前置条件）—— 把它们压进状态机会要求 `PROPOSED → PROPOSED` 这样的自环，而
  自环会让"静默重入同一状态"变成合法。
- **刻意没有** `EXECUTING → WAITING_APPROVAL`：执行到一半才想起要问用户，
  意味着那笔钱可能已经预留在路上 —— 那正是 P22-7 花整段篇幅禁止的"先 reserve
  再问"。
- `EXECUTING` 是**持久**的，因为 §16 要求"在 Purchase prepared 与 Intent
  completed 之间崩溃之后不得重复买"。如果它只活在内存里，崩溃重启后那条 intent
  读起来仍是"刚被收下"。

**Intent 状态只是 orchestration fact。** 真正经济事实仍由 Quote / Approval /
Purchase / Ledger / Inventory 各自的 canonical owner 管理。这一句写在读面上
（`stateIsAnOrchestrationFact: true` / `stateIsNotAnEconomicFact: true`）。

---

## 10. §10/§11 指纹与幂等

### 两个指纹，分工明确

```text
意图指纹 purchaseIntentFingerprint
   = f(agentId, productId, recipientId, units, selfDirected)   ← 不含 reason、不含 expiresAt
操作指纹 purchaseFingerprint(AGENT_INTENT_PROPOSE, …)
   = f(agentId, productId, recipientId, units, selfDirected)   ← 同样不含 expiresAt
```

`reason` **不在**意图指纹里：模型把同一句话换个说法（"快没额度了" → "我需要
更多算力"）不能让重复抑制失效。`expiresAt` 也不在：有效期是"这个打算我想到
什么时候为止"，不是"这是哪一件事"。

★ 开发期实测踩到：操作指纹曾经**含** `expiresAt`，于是"同一次提议请求"在两次
调用之间（默认有效期按 `now` 重新计算）得到**两个不同的指纹**，而幂等闸门把
一次纯重试读成"你换了另一个意图" —— 症状是第一条 intent 明明已经写下来了，
调用方却收到 `IDEMPOTENCY` 冲突。

### §10 重复窗口

```text
同 agent + 同 product + 同 recipient + 同 units，窗口 60 秒
→ 第二条返回**已经存在**的那一条（suppressedBy: DUPLICATE_INTENT_WINDOW）
```

- `COMPLETED` 也抑制（"上一个已经买成了"恰恰意味着"不要再买"）；
- `DENIED` / `EXPIRED` / `FAILED` **不**抑制（"上一次没成"必须允许再试，
  否则一次暂时缺货就永久禁止了这件商品）。
- 它自述 `dedupeIsNotABudget: true`：真正的上限永远是 P22-7 的 per-purchase /
  daily 自主额度与 P22-4 的预算。

### §11 幂等

```text
same key + same intent    → 同一条 Intent（重放）
same key + 不同 product/recipient → DUPLICATE_REQUEST（带回两个指纹）
```

跨重启仍然成立：第一次调用写下的 intent 就在库里，`(key, fingerprint)` 是
一次索引查找。

---

## 11. §12 Gift 与 §13 Compute quota

**Gift**：Agent 可以提出"A 给 B 买 Product X"，而 `allowGift=false` 时由
P22-7 判 `DENY / AUTONOMY_NOT_PERMITTED`。Decision Bridge **不得**根据
`trust` / `affection` / `relationship` 擅自升级权限 —— 那三个词既不在提议
白名单里，也不在权威输入白名单里，因此它们是"未知键"，一次拒绝、零副作用。
本阶段**不**修改 Relationship / Memory。

（★ 附带发现：`COMPUTE_GRANT` 商品**不能**作为礼物送出，因为它的结算形态在
§14 就冻结成"额度被授予"，没有"送给谁"这个位置 —— P22-5 的 `productQuoteKindFor`
因此拒绝带 `recipient` 的 compute 报价。测试夹具照这条规则构造。）

**Compute / API quota**：Agent 提出"我的 computeUnit 快不够了，想买 Premium
Compute ×1000"只形成一条 Purchase Intent。之后完整经过 Quote → Budget →
Autonomy → Approval（如需要）→ Purchase，而成功后增加的仍然只是
**InternalBeyond 内部的 compute entitlement**：

```text
settlementPrimitive = COMPUTE_ENTITLEMENT
0 provider top-up · 0 provider credential · 0 网络 · 0 真实支付
```

---

## 12. §14 边界隔离：窄接口，没有通用执行器

```text
proposeAgentPurchaseIntent(input)   ← 唯一的写入口，接受六字段的提议白名单
resumeAgentPurchaseIntent(input)    ← 唯一"继续执行"的入口
```

公开面上**不存在**（结构性断言，逐名检查）：

```text
executeEconomyAction · executeAction · runAction · runEconomyAction
performAction · buyNow · purchase · approveForAgent · settleForAgent
grantForAgent · applyModelAction
```

而且 `proposeAgentPurchaseIntent` 的**函数体**里没有一句
`settlePurchase` / `preparePurchase` / `grantInventory` —— 那些调用只出现在
它调用 `executeIntent` 之后的那一层。

三处接入但**不**成为 authority：

- `http.js`：只加两条 GET 路由；
- `home-node-service.js`：**零**改动（服务层不获得购买权）；
- `middle-brain.js`：**零**改动。

---

## 13. §15 HTTP 继续只读

```text
可以加：
  GET /economy/intents   列出意图（agentId / productId / state / limit）
  GET /economy/intent    单条（agentIntentId，withChain=1 带因果链）

禁止（全部落在兜底分支上，一律 405 economy-is-read-only）：
  POST /economy/intent · /economy/buy · /economy/execute · /economy/approve
  /economy/intent/propose · /economy/intent/execute · /economy/intent/resume
  /economy/intents/create · /economy/intent/create · /economy/approval/decide
```

★ 本阶段第一次让**模型**有能力影响经济，而 HTTP 上依然一条写路由都没有。
这不是保守：把"提出购买意图"做成一个 HTTP 端点，等于让任何能发请求的东西
获得 Agent 的购买权 —— 而"谁有权替谁提出意图"这个问题在本阶段同样没有答案
（与 P22-7 拒绝 `POST /economy/approve` 是同一条理由）。

读面上六句自述：`isAnEconomicFact: false` / `isAnOrchestrationFact: true` /
`isAnApproval: false` / `isAPurchase: false` / `isAQuote: false` /
`carriesPrice: false` / `grantsBudget: false` / `reasonIsAuthority: false`
/ `exposesMutation: false`。

---

## 14. §16 Crash / concurrency：多进程实测改对了四处

本阶段的六个可崩溃边界各自带一个 `faultPoint`，而 G 组用**真实
`process.abort()`**（不是"注入点抛错"）在它们上面真的把进程杀掉：

```text
after-intent-created            → 事务整体回滚，库里什么都没有
after-intent-quote-created      → intent 在、报价在、绑定未写
after-intent-approval-created   → 批准在（PENDING），intent 未绑定 → 停在等待
after-intent-purchase-prepared  → 一笔 RESERVED 的购买 + 一次未释放的预留
after-intent-purchase-settled   → 事实全部成立，intent 还写着 EXECUTING
after-intent-completed          → 状态已 COMPLETED，只少一条 change log
```

★★ **崩溃必须是真的**：P22-7 的教训在这里被继续遵守 —— `faults.hit()` 抛出的
异常发生在事务**内部**，而它只要被任何一层 catch 翻成一次业务拒绝，事务就会
照常 COMMIT。`process.abort()` 是同步的、立即的、没有 JS catch 能拦住的。

### 多进程逼出来的四个真实缺陷

| # | 症状 | 根因 | 修法 |
|---|---|---|---|
| 1 | 两个进程同时提同一份提议 → 一个报 COMPLETED、一个报 PROPOSED | 读到的是**过期快照**（赢家领走前的那一版） | 领不到时**走一遍与赢家相同的幂等流程**，而不是把快照当成结局 |
| 2 | 同上，一个报 COMPLETED、一个报 QUOTE_MISMATCH | 两边都执行 → 各自 prepare 同一份报价、各自 attach 同一笔购买 | 执行权由**一句 CAS**（`state → EXECUTING`）独占：**领到的人执行，领不到的人等结局** |
| 3 | 两个进程同时恢复同一条 APPROVED Intent → 留下一笔 RESERVED 的购买 + 未释放的预留 | 输的一方把 `changes=0` 报成一次业务拒绝 | 并发失败时**读回真实结局**；`RESERVED` 时**有界地再试结算**（幂等） |
| 4 | 一条 COMPLETED 的购买对应一条 FAILED 的 intent | "结算没成功"被合并成一种意思 | 区分**"别人已经结算完了"**（照常完成 intent）与**"结算真的失败了"**（FAILED） |

另外两处由崩溃组逼出来：

- **`attachedPurchaseId` 的三种原因**：挂不上 purchase 可能是"另一笔购买占用"
  （冲突）、"已经完成"（读回）、或者**"同一笔购买、还在执行中"**（接着结算）。
  合并它们会让一条正确的实现被判成失败。
- **"崩溃留下的 EXECUTING"必须能被接着做完**：`after-intent-purchase-prepared`
  留下的形状是"intent 停在 EXECUTING 且 `purchase_id` 为 NULL，而报价上已经有
  一笔 RESERVED 的购买"。少了认领那一段时，重试会走到 `preparePurchase`，而
  P22-6 的 `UNIQUE(quote_id)` 会以 `this-quote-is-already-linked-to-a-purchase`
  拒绝 —— 于是那条 intent 永久卡住，而库里躺着一笔**锁住的钱没有主人**。

### 三个"最多一次"

```text
D 组  两个真实进程同时提同一份模型输出  → 最多一条 Intent · 一笔购买 · 一次扣款 · 一次发放
E 组  两个真实进程同时执行同一条 Intent  → 最多一笔购买 · 一次结算 · 一次发放
F 组  两个真实进程同时恢复同一条 APPROVED Intent → 最多消费一次 Approval
```

**D6 的判据在本阶段被改对了，理由值得记下**：它一度要求"两个 worker 各自的
瞬时快照逐字相同"。那句话测试的是一件**不可能**的事 —— 两个进程必然在彼此的
写入之间采样。现在的判据分三步，每步都测一件真的会发生的事：

```text
D6a  每一个见证人各自的读数要么是那个收敛的数字、要么明确是"还没定局"
D6b  至少一个见证人**确认** intent 已到终态，且没有任何人报 DENIED/EXPIRED/FAILED
D6c  两个**独立进程**读到的最终事实逐字相同（含 integrity 零问题）
```

---

## 15. §17 Audit / Explainability

`GET /economy/intent?withChain=1` 与 `getPurchaseIntent({withChain:true})` 仅凭
canonical facts 回答六个问题：

| 问题 | 答案来自 |
|---|---|
| 为什么出现这笔购买？ | `chain.whyThisPurchaseExists` → Agent Purchase Intent |
| Agent 当时想买什么？ | `chain.whatTheAgentWanted` → Intent（`reasonIsAuthority:false`） |
| 为什么没直接买？ | `chain.whyItDidNotBuyDirectly` → Autonomy `REQUIRE_APPROVAL` |
| 为什么直接买了？ | `chain.whyItBoughtDirectly` → `AUTO_ALLOW` + `budgetWasStillRequired:true` |
| 最终买了多少钱？ | `chain.quote` / `chain.purchase` / `purchase.ledgerTransactionId` |
| Agent 的理由是什么？ | `chain.whatTheAgentWanted.reason` |

两个"为什么"字段**互斥**（K8 断言）。`reason ≠ authority` 在系统里是
**可断言**的，而不是文档里的一句话。

**Agent reasoning 没有被写进 Memory**（K9 逐键检查读面上不含 `memory*` /
`relationship*` / `affection` / `trust`）。

---

## 16. 测试

```text
tests/test_p22_8_economy_intent.js            契约与纯函数（零数据库）
tests/test_p22_8_economy_decision_bridge.js   store 层编排
tests/test_p22_8_economy_runtime.js           真实进程 + 多进程 + 崩溃
tests/fixtures/p22-8-intent-worker.js         多进程/崩溃 worker（fixture）
```

P22 全量（21 个文件）：

```text
21/21 files · 2337 checks · 0 failed
```

其中 P22-8 三个文件各自的组：

```text
intent          A 身份 · B 状态机 · C §4 边界 · D reason≠authority · E 指纹
                F 两份哈希逐字相同 · G 裁决表 · H 自述与载入期不变量
bridge          A Quote · B 三条出口 · C AUTO_ALLOW 必经 Budget · D 等待路径
                E 恢复路径 · F 重复窗口 · G 幂等 · H 经济事实注入 · I Gift/Compute
                J 边界隔离 · K 可解释性 · L 表结构
runtime         A 静态边界 · B 真实 Home Node 读面+重启 · C 60 次写尝试全 405
                D 重复输出竞争 · E AUTO_ALLOW 竞争 · F Approval 竞争
                G 六个崩溃边界 · H 重试语义 · I 隔离
```

**phase guard 更新**（加一层不是换词表）：

```text
test_p22_1_economy_domain_contract.js   47 → 50 个拒绝码 · 15 → 16 种 id · 17 → 19 个 scope
test_p22_1_economy_boundary.js          B1.7 的例外名单逐字加上 purchaseIntentFingerprint
test_p22_2_economy_store.js             MUTABLE_TABLES 加上 PURCHASE_INTENTS_TABLE（生命周期行）
test_p22_5_economy_catalog.js           J3 改成"恰好两条迁移，其中 5→6 ALTER、6→7 无 SQL"
test_p22_6_economy_purchase.js          A6/A10 的 id 种类与命名空间计数
test_p22_6/7_economy_runtime.js         schema 水位 6 → 7
test_p22_7_economy_runtime.js           F0 的注入点清单**排除** intent- 族（新阶段的点不该被旧阶段执行）
```

---

## 17. 未进入（本阶段刻意不做）

```text
通用 Action integration      · MCP purchase tool      · Middle Brain 自主执行
商店 UI / 购买按钮 / Approval UI / 素材                · HTTP 写路由
真实支付                     · Provider quota         · Exchange    · Refund
Relationship / Memory 的任何修改
```

---

## 18. 已知限制（诚实记录）

- `AP_EVALUATION_PRIORITY`（P22-7）的注释把审批线写成排在日额度**之前**，
  而实现是**日额度先判、且它是 DENY**。本阶段**不改** P22-7，而是在 B7 组里
  把**实测**行为钉住（撞穿日额度 → `DENY / AUTONOMY_LIMIT`），并在测试里逐字
  说明这一处注释与实现的出入。
- `health().counts` 里新增的七个 intent 计数是 health 的**快照**；多进程测试
  的见证人读数改从表里直接读（见 worker 的 `worldOf`），因为"两个进程看到同一
  个最终事实"这条断言要的是各自**当下**读到的行数。
