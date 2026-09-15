# P22-7 · Approval + Autonomous Purchase Policy

> Economy 的**权限层**。它回答一个问题，且只回答这一个：
>
> **这台 Agent 有没有权不问用户直接花这笔钱？**
>
> 它**不**回答"这笔钱花得起吗"（那是 P22-4 的 Budget，冻结未改），
> 也**不**回答"Agent 想不想买"（那是一个 Decision，本阶段不存在）。

- commit：`P22-7 · add Economy approval and autonomous purchase policy`
- 前置：P22-1..P22-6 已冻结（P22-6 = `5b14634`）
- schema 水位：**5 → 6**

---

## 0 · 一句话的边界

```text
Budget ALLOW  AND  (Autonomy AUTO_ALLOW OR a valid Approval)
```

三件事各自有**自己的**封闭词表、自己的表、自己的判据，而最终权限是三者
**相乘**：

| 层 | 问题 | 词表 | 表 |
|---|---|---|---|
| Budget（P22-4） | 最多允许花多少 | `ALLOW` / `DENY` / `REQUIRE_APPROVAL` | `economy_budget_policies` |
| Autonomy（P22-7） | 有没有权自主花 | `AUTO_ALLOW` / `DENY` / `REQUIRE_APPROVAL` | `economy_autonomy_policies` |
| Approval（P22-7） | 用户授权了哪一件具体的事 | `PENDING`/`APPROVED`/`REJECTED`/`EXPIRED`/`CONSUMED` | `economy_approvals` |

两个词表**共享** `DENY` 与 `REQUIRE_APPROVAL`（那两句话在两层上含义逐字
一样），而"允许"那个词刻意不同族：Budget 说 `ALLOW`（花得起），Autonomy 说
`AUTO_ALLOW`（有权自主花）。若两层都叫 `ALLOW`，"这笔为什么买成了"在审计里
就会有两个同名的答案。这是一条**载入期不变量**，不是注释。

---

## 1 · schema 5 → 6

两张新表 + `economy_purchases` 上的**五**个新列。

```text
economy_autonomy_policies(policy_id PK, owner_id UNIQUE, owner_type,
  enabled, per_purchase_limit_minor, daily_autonomous_limit_minor,
  approval_above_minor, allowed_product_kinds, allowed_settlement_types,
  allow_gift, idempotency_key, fingerprint, revision,
  created_at, updated_at)
  CHECK per_purchase <= daily
  CHECK approval_above <= per_purchase
  CHECK owner_type <> 'system'

economy_approvals(approval_id PK, buyer_id, buyer_type, recipient_id,
  recipient_type, product_id, quote_id, quote_kind, currency, amount_minor,
  settlement_type, grant_quantity, units, binding_fingerprint,
  approval_mode, autonomy_policy_id, autonomy_outcome, autonomy_reason_code,
  status, decided_by_id, decided_by_type, consume_reason,
  consumed_by_purchase_id, idempotency_key, fingerprint, revision,
  created_at, updated_at, expires_at, decided_at, consumed_at)
  UNIQUE consumed_by_purchase_id
  CHECK status IN (PENDING, APPROVED, REJECTED, EXPIRED, CONSUMED)
  CHECK status <> 'CONSUMED' OR consumed_by_purchase_id IS NOT NULL
  CHECK decided_by_type IS NULL OR decided_by_type <> 'system'

economy_purchases += approval_mode TEXT
                   + approval_id TEXT
                   + autonomy_policy_id TEXT
                   + approval_binding_fingerprint TEXT
                   + units INTEGER
```

### ★ 5 → 6 是仓库里**第一条非空**迁移

前五次抬水位都只**多表**（`CREATE TABLE IF NOT EXISTS` 补上即可，没有任何
既有行需要改写）。这一次不同：**"这笔购买当初凭什么成立"是一个既有行上的
新事实**，一句 `CREATE TABLE IF NOT EXISTS` 碰不到已经存在的行，因此必须真的
`ALTER TABLE`。

五个列全部可空、且**不**回填。P22-7 之前写下的购买**没有**授权模式：把它猜成
`AUTO_ALLOW` 是伪造"这台 Agent 当时有权自主买"，猜成 `APPROVAL` 是伪造"当时
有人批准过"。两种回填都会让审计指认一个从未发生的事实。`NULL` 是一个**准确**
的答案："这条记录早于授权层"。

### ★★ 这个迁移必须容忍"表还不存在"

迁移框架的调用点排在所有 DDL **之前**（P22-3 起冻结的纪律：`SCHEMA_TOO_NEW`
的库上不能悄悄多出空表）。因此一个 schema 4 的库走 4→5→6 时，5→6 这一步面对
的是一个**还没有** `economy_purchases` 的数据库。

这是一个真实缺陷（开发期实测：P22-5 的迁移组在一个 schema 4 的库上打开时读作
`no such table: economy_purchases`）。迁移如果假设"更早版本负责过的表已经
存在"，那么**跨两级**的升级路径会失败，而"跨一级"的路径是绿的 —— 后者恰好是
大多数测试走的那条。修法是先查 `sqlite_master`，表不存在就什么都不做（稍后
DDL 会按当前的 `CREATE` 语句建出带这五列的表）。

---

## 2 · Autonomy policy 模型

```js
{
  policyId, ownerId, kind: 'autonomy',
  enabled,                            // 唯一开关
  perPurchaseLimitMinor,              // 必填
  dailyAutonomousLimitMinor,          // 必填
  approvalAboveMinor,                 // 缺省 = perPurchaseLimitMinor
  allowedProductKinds: [],            // 缺省 = 空集（什么都不能自主买）
  allowedSettlementTypes: [],
  allowGift                           // 缺省 false
}
```

### 为什么两条额度**必填**

一个 `enabled: true` 却没有上限的自主策略**就是**"以后随便花"，而 §6 逐字
禁止那句话。这里刻意不用 `0` 当缺省：`0` 是"一分钱都不许自主花"，与"没写"
是两个不同的结论，而其中的差别决定了这台 Agent 是"只能问用户"还是"可以被
配置成只能问用户"。

### 三条序关系（全部由 CHECK + 读侧双重把关）

```text
approvalAbove ≤ perPurchase ≤ daily
```

一条**永远不会被触发**的审批线比没有审批线更糟 —— 它看起来像一条保证。

### 输入白名单（12 个键，封闭）

```text
ownerId · buyerId · recipientId · productId · productKind · settlementType
currency · amountMinor · gift · selfDirected · spentTodayMinor · timestamp
```

**任何**未列出的键都被拒。§2 点名的五类禁用输入在这里**无处可放**：

```text
LLM 输出      prompt / llmOutput / modelOutput / completion / reasoning / thoughts
Memory        memory / memoryRef / memories
Relationship  relationship / relationshipId / affection / trust / affinity
聊天内容      message / messages / content / text / reply
"觉得可以买"  agentDecided / feelsLikeBuying / importance / urgency
```

这不是"记得别传"，而是三层结构性约束：① 白名单键（未知键 = 拒绝）；
② `autonomyContextOf` 是唯一的 context 构造点，它只从 quote / product /
policy / purchases 四个 canonical 来源读字段；③ 载入期不变量检查白名单里
不含任何正文类键。

★★ 而"关系高所以自动允许送礼"这句话**在类型上不成立**：`relationship`
不在白名单里，因此它连一个字段都没有。

---

## 3 · `evaluateAutonomousPurchase(policy, context)` —— 确定性纯策略

签名是一对**数据**参数。没有 store、没有时钟、没有随机、没有任何 I/O。

十条判据的顺序是冻结的，结果里带回 `priorityRule`：

```text
 0 policy-present-and-effective
 1 input-structured
 2 scope-matches
 3 autonomy-enabled                  DENY  AUTONOMY_NOT_PERMITTED
 4 currency-matches                  DENY  INVALID_CURRENCY
 5 product-kind-allowed              DENY  AUTONOMY_NOT_PERMITTED
 6 settlement-type-supported         DENY  AUTONOMY_NOT_PERMITTED
 7 autonomy-max-per-purchase         DENY  AUTONOMY_LIMIT
 8 autonomy-purchase-approval-threshold   REQUIRE_APPROVAL  APPROVAL_REQUIRED
 9 autonomy-daily-limit              DENY  AUTONOMY_LIMIT
```

### ★★ 顺序里那个算过的判断

三条 DENY 判据里，"作用域 / 商品种类 / 结算形态"与"单笔上限"排在审批线
**之前** —— 一件被规则排除的商品、或一笔越过了单笔上限的钱，永远得到
`DENY`，而不会看起来像一件"等人点头"的事（那时候没有人该去点头：规则已经
说不，用户点头也没有意义）。

**而日自主额度刻意排在审批线之后。** 理由是一个真实的选择：一笔在单笔上限
之内、但会撞穿日额度的钱，应该得到 `REQUIRE_APPROVAL`（"这件事需要人点头"），
而不是直接 `DENY`。额度是**能力**线，审批线是**许可**线 —— 能问就先问，
因为用户点头之后仍有别的规则（预算、单笔上限）继续约束它。

### fail closed 的三层

```text
没有策略            → REQUIRE_APPROVAL   （★ 不是 AUTO_ALLOW）
策略存在但形状不可信 → DENY               （不是"读不懂就随便吧"）
字段缺失            → DENY               （spentTodayMinor 缺席**不**兜成 0）
```

② 比 ① 更严格是对的：一台**配过**自主策略的 Agent 如果那条策略坏了，那说明
有人正在改规则而改到一半 —— 这时放行比拒绝危险得多。

### 三个结论各自都写着什么

```js
{
  outcome: 'AUTO_ALLOW' | 'REQUIRE_APPROVAL' | 'DENY',
  reasonCode, priority, priorityRule, errors, reasons, rule,
  autoAllowed / requiresApproval / denied,
  evaluatedOnly: true,
  snapshot: { kind: 'autonomy-evaluation', authority: 'none', at },
  answers: 'may-this-agent-spend-without-asking-the-user',
  notABudgetDecision: true,
  grantsBudget: false
}
```

★ 三句自述在**三种结论上都出现**（不只是 `AUTO_ALLOW`）。只写在成功路径上会
让"这条结论是什么"变成一个"字段存不存在"的问题，而 read 侧要么写
`=== false`（对缺字段为 false ⇒ 断言无声失败），要么写 `!== true`（对任何
缺失都为 true ⇒ 断言永不失败）。两种写法都不会失败得**有意义**。

---

## 4 · Approval 模型与状态机

```text
PENDING ──▶ APPROVED ──▶ CONSUMED
   │  │         │
   │  │         └────▶ EXPIRED      （批准了但一直没被用掉）
   │  └────▶ REJECTED                （用户说不）
   └───────▶ EXPIRED                （用户一直没回答）
```

四条终态（`REJECTED` / `EXPIRED` / `CONSUMED`）的出边**全部为空**，因此
"REJECTED → APPROVED"、"EXPIRED → APPROVED"、"CONSUMED → APPROVED" 三句话
在结构上不成立 —— 需要重新批准时创建一条**新的** Approval。

★ `APPROVED` **不是**终态：一个还没被用掉的批准可以在有效期过后失去效力
（`APPROVED → EXPIRED`）。把它设成终态会让"一份批准永远不会过期"成为结构性
的结论。

### 有效期有上界：24 小时

一条"永久有效"的批准与"以后随便花 500"是同一种东西。上界比任何一次真实购买
需要的决策时间长得多，又不至于让一条批准在下个月还能被用掉。

### self-approval 被**结构性**拒绝

`decidedBy` 必须是一个 canonical party，而它与 buyer 相同即拒绝
（`PARTY_NOT_ALLOWED` + `selfApprovalRejected: true`）。于是"Agent 自己批准
自己"在类型上不可表达。判据是 `(type, id)` **二元组**，不是一个裸字符串。

---

## 5 · Approval snapshot / fingerprint（§6）

一张批准**必须绑定九个经济事实**：

```text
buyerId · recipientId · productId · quoteId
currency · amountMinor · settlementType · grantQuantity · units
```

`binding_fingerprint` 是这九个的纯函数身份，**不含任何生成的 id**，因此
"批准的是哪一件事"可以被独立重算。integrity check 逐行重算它 —— 手工改过库里
的 `amount_minor` 会被抓出来（`binding-fingerprint-does-not-describe-the-bound-facts`）。

### ★★ 批准不能被挪给另一笔购买

批准之后换掉**任何一项**，验证就失败，因为验证比的是**九项**，不是"一个金额"：

```text
「用户批准过 400」  ⇏  「用户批准了另一次 400」
```

这条纪律的两半：

- **prepare 之前**：`approvalId` 的 `quoteId` 粗筛（便宜的快速失败）；
- **prepare 的写锁里**：`validateApprovalForPreparationInTx` 逐项比对九个字段，
  不成立即抛 ⇒ 整个 prepare 回滚。

`grantQuantity` 与 `units` 刻意是**两个**键：它们是不同的事实（"买 3 份"与
"收到 30 个 computeUnit"），而 §6 要求换掉"数量"之后批准必须失效 —— 换掉
哪一个都算。

### `units` 为什么是新列

Quote 行上的 `quantity` 是**计算出来的发放份数**（`grantQuantity × units`），
因此"买了几份"在 P22-6 里从来没有被落库过。而它是九元组里的一员，所以结算时
那句"这张许可证说的就是这一笔吗"必须有一个权威来源 —— 从 `granted_quantity`
反推会在商品改过 `grantQuantity` 之后给出错误答案（`grantQuantity` 是 P22-5 的
**不可变**本体列，但"反推"这个动作本身依赖那个假设，而落一列不依赖任何假设）。

---

## 6 · 与 P22-6 的接入：两个事务内 seam

§10 的四个出口，逐字对应 `authorizePurchaseIntent` 的四条 return：

```text
AUTO_ALLOW        → allowed:true, mode:AUTO_ALLOW, proceedToPrepare:true
REQUIRE_APPROVAL  → allowed:false, approvalRequired:true, 并创建一条 PENDING 记录
valid APPROVED    → allowed:true, mode:APPROVAL, proceedToPrepare:true
DENY              → allowed:false, denied:true（**不创建任何记录**）
```

★ `DENY` 不创建任何记录是刻意的：一次被规则排除的尝试不是一条待批准的事 ——
创建一个永远没人该处理的 `PENDING` 记录会把"被拒绝"伪装成"等待中"。

★ `authorizePurchaseIntent` **不**调用 `preparePurchase`，也**不**评估预算。
合并它们会让"授权说可以但购买因为其它原因失败"这个真实情形在审计里消失，
而"Gate 说可以"与"花得起"是两个独立的问题。

### ★★ 消费发生在**结算**事务里（本阶段最重要的一个判断）

`Approval` 的真值与可用性在 prepare 时被**验证**，而在 settle 时被**消费**：

```text
settlePurchase 的一个 BEGIN IMMEDIATE：
  re-read → 四元组一致性 → 过期检查 → **Budget 最终再评估**
  → consumeApprovalForPurchaseInTx（批准 → CONSUMED + APPROVAL_CONSUMED）
  → commitReservationInTx（预留 → COMMITTED；ledger transaction + entries）
  → Quote → CONSUMED → 结算原语 → Purchase → COMPLETED
  → change log + 幂等 → COMMIT
```

三条理由，逐条论证：

1. **§8 要求「成功进入对应 Purchase 后」才 `APPROVED → CONSUMED`。** 哪一刻
   算"成功进入"？若在 prepare（Purchase 行 RESERVED）消费，则此后进程崩溃或
   购买被取消会留下"批准已消费 + 购买 RESERVED 然后 RELEASED"—— 一条被烧掉的
   批准对应一次失败的购买，§10 逐字禁止这个形状。在 settle（钱真的动了）消费，
   崩溃只留下"批准仍 APPROVED + 购买 RESERVED"，可安全重试。
2. **§15 要求「两个进程拿同一个 APPROVED Approval 买 ⇒ 最多一个 Purchase」，
   而这一条不依赖消费时刻**：`setApprovalConsumed` 的 `AND status='APPROVED'`
   谓词让第二次消费 `changes=0`；而授权绑定的 `quoteId` 与 purchase 的
   `quote_id` UNIQUE 索引一起保证"一份报价最多一笔购买"。
3. **§11 要求「Approval 绝不能绕过 P22-4/P22-6」。** 在结算事务里消费恰好把
   "批准"与"最终预算复核"放进同一个原子单位：预算 DENY 时整个事务回滚，批准
   回到 `APPROVED`，钱一分不动 —— 于是"批准不是预算豁免"不仅是同一句话，而是
   同一个 `ROLLBACK` 的两个后果。

### 授权证据不可伪造：`preparePurchase` 接受的是**两份证据**，不是一个模式

```text
approvalId                    ⇒ mode = APPROVAL（九元组必须逐项一致）
approvalFingerprint           ⇒ mode = AUTO_ALLOW（必须**重算**一致）
autonomyPolicyId              ⇒ 可追溯"为什么没问用户"
两者都不给                     ⇒ mode = NULL（没有走闸门）
两者同时给                     ⇒ 拒绝（一次无法回答的声明）
```

★ 刻意**不**接受 `authorizationMode` 参数。"这笔购买是自主的还是被批准的"
不是调用方可以声明的东西 —— 允许调用方自己写 mode 会让"我声称我是
`AUTO_ALLOW`"成为一条绕过批准的路。

`validateAutonomousApprovalInTx` 对 `AUTO_ALLOW` **重算**九元组身份并与提交值
比较：如果只把它存下来，"拿着一条真实的指纹去准备一笔经济内容完全不同的购买"
就会成功。

---

## 7 · single-use / exactly-once

```text
一个 Approval  →  最多一笔 Purchase
```

三层结构保证：

1. `setApprovalConsumed` 的 `AND status='APPROVED'` —— 第二次消费 `changes=0`
   ⇒ 整个事务回滚 ⇒ 那笔购买不会被扣款；
2. `consumed_by_purchase_id` 的 UNIQUE 索引 —— 一笔购买只出现一次；
3. 授权绑定的 `quoteId` + purchase 的 `quote_id` UNIQUE —— 同一份报价不可能
   有两笔购买。

重放同一笔结算请求返回**当初那个结果**（幂等回放），而用另一个 key 再结算
同一笔购买得到**终态冲突**（`TRANSITION_NOT_ALLOWED` + `terminal: true`）——
**绝不是第二次扣款**。

---

## 8 · 并发与崩溃

### 多进程（真实子进程，不是"更狠一点的单进程测试"）

`node:sqlite` 的 `DatabaseSync` 是同步 API，单线程里两次 `decide` 不可能交错，
因此"并发只有一个成功"在单进程内**无法被证伪**。

| 组 | 场景 | 断言 |
|---|---|---|
| D | 两个进程分别 `APPROVE` / `REJECT` 同一条 PENDING 批准 | 恰好**一个**决定成功；终态恰好一个 |
| D8 | 两个进程用**同一个 key** 同时决定 | 一个写入者（另一个是幂等回放，或在写锁里被状态闸门拒绝） |
| E | 两个进程同时拿同一条 APPROVED 批准去买 | 恰好一笔 COMPLETED / 一笔交易 / 一次发放 / 一次消费 |

### ★★ 故障注入的真相：`faults.hit()` 抛错**不是**一次崩溃

开发期最重要的一个发现。`deps.faults.hit(name)`（P22 §17 的唯一注入缝）**在
事务内部**，而 `withTransaction` 的 catch 在 store 的入口函数里被翻成一次业务
拒绝 —— 于是事务照常 `COMMIT`，调用方甚至看不到异常。

实测：注入 `after-approval-consumed` 之后结算仍然报 `ok: true`，而库里已经写下
了消费。

真正的"崩溃"（进程消失 ⇒ 没有 `COMMIT` ⇒ SQLite 回滚）需要进程真的死掉。
因此 runtime fixture 用 `--crash <point>`：命中那个点时直接 `process.abort()`。
abort 是同步的、立即的，且**没有** JS catch 能拦住它 —— 于是"崩溃之后库里是
什么样"变成一个可以被真实读出来的问题。

### 7 个注入点 × 真实崩溃

清单**从源码推导**（`/faultPoint\('([a-z0-9-]+)'\)/g`），而不是手写一份。手写
清单有一个安静的失效模式：某天有人重命名了一个注入点，而测试仍然去请求那个
已经不存在的名字 —— 注入变成 no-op、worker 顺利跑完、世界看起来完全正常，
于是"崩溃回滚"这句话被验证了 0 次。

```text
after-approval-requested          批准申请事务
before-approval-request-commit    批准申请事务
after-approval-decided            批准决定事务
before-approval-decision-commit   批准决定事务
after-approval-consumed           结算事务（消费那一条 change 之后）
after-autonomy-policy-written     自主策略写入事务
before-autonomy-policy-commit     自主策略写入事务
```

每个点用它**自己的**入口到达（一个从不运行的注入点等于一句没有证据的声明），
并带回 **hit 计数**（`hitCount === 1`）作为"它真的被执行过"的证据。

**七个点上的不变量（全部为真）：**

```text
不存在「批准已 CONSUMED 但没有 Purchase」        tornFacts.length === 0
consumed 的数量 === completed 的数量              （0=都回滚了，1=都留下了）
integrity check 零问题                            没有任何半完成状态
transactions === (播种那一次 MINT) + completed
inventoryTotalQuantity === 100 × completed
```

而 `after-approval-decided` 与 `before-approval-decision-commit` 上的崩溃把那条
批准**退回 PENDING 且没有决定者** —— 决定、change log、幂等行一起消失，这就是
"半个决定不可达"的直接证据。

### ★ 崩溃之后的重试语义是**两段**的

崩溃可能停在一笔**已经提交过**的购买之后，而 P22-6 的 `quote_id` UNIQUE 会让
"再 prepare 同一份报价"被 `this-quote-is-already-linked-to-a-purchase` 拒绝 ——
那正是"一份报价最多一笔购买"在起作用，不是缺陷。因此 `resume`：

```text
这份报价已经有一笔 RESERVED 的购买  →  续做它（settle）
没有                                →  prepare + settle
```

---

## 9 · Gift

```text
allowGift 缺省 false  ⇒  送礼  DENY（AUTONOMY_NOT_PERMITTED）
```

判据排在**金额判据之前**：一次送礼是否是"被允许的行为"与金额无关。而
"Relationship 高所以自动允许送礼"这句话在这里连一个字段都找不到。

`allowGift: true` 时送礼仍然**不是**自动允许：它只是不再被礼物规则拦下，
两条额度与审批线照常生效。Gift 仍然 `buyer pays / recipient receives`，而
Relationship / Memory **零修改**。

---

## 10 · Compute / API quota

自主策略可以对 `COMPUTE_CREDIT` / `API_QUOTA` 设自主权限（例如"这台 Agent
每日最多自主购买 500 computeUnit 对应商品"），但这仍然只是
**InternalBeyond 内部 compute entitlement**：

```text
settlementPrimitiveOfFulfillment('COMPUTE_GRANT').primitive === 'COMPUTE_ENTITLEMENT'
assetKindOfProductKind('COMPUTE_CREDIT') === ASSET_KIND.COMPUTE
COMPUTE_UNIT_NAME === 'computeUnit'
isForbiddenComputeAlias('computeUnit') === false       ← 合法的单位名不被误判
isForbiddenComputeAlias('providerToken' | 'realCredit' | 'balance') === true
FORBIDDEN_PURCHASE_LEDGER_ACCOUNTS 含 'system:quota' / 'apiBalance' / 'tokenBalance'
FORBIDDEN_PURCHASE_LEDGER_ACCOUNTS 含 'provider:openai' 等六个 provider 账户
```

机器证明继续成立：**0 Provider API calls · 0 credential access ·
0 real Provider recharge · 0 network**。

★ 而 `evaluateAutonomousPurchase` 的结论里**没有任何** provider / payment /
topup / credential / apiKey 字段：它只说"这笔 IB 内部购买可以自主"。

---

## 11 · HTTP / security

`/economy/*` 仍然是 **GET-only**。本阶段即使有了 Approval runtime 也**不**开放：

```text
POST /economy/approve        POST /economy/reject
POST /economy/buy            POST /economy/autonomy
```

20 次写尝试（4 个动词 × 5 条新路径，加上 P22-6 的写形态）**全部 405
`economy-is-read-only`**。真正的"用户点批准"入口留给未来的 UI / Action
authority 阶段 —— 在那之前，"谁有权替谁点头"这个问题没有答案，而没有答案的
写入口就是一个权限漏洞。

新增五条**只读**路由：

```text
GET /economy/approvals           列出（buyerId / quoteId / status）
GET /economy/approval            单条（approvalId），带九元组快照
GET /economy/autonomy-policies   列出（ownerId）
GET /economy/autonomy-policy     单条（policyId 或 ownerId）
GET /economy/autonomy-evaluation 对一份**已存在的报价**做一次只读自主判定
```

`/security` 的 `economyPolicy` 增加十一项**可断言**字段：

```js
approvalRuntimeImplemented: true
approvalWritesExposed: []        autonomyWritesExposed: []
approveViaHttpIsForbidden: true
approvalConsumptionIsInsideSettlement: true
approvalIsSingleUse: true
autonomyDefaultWhenNoPolicy: 'REQUIRE_APPROVAL'
autonomyIsADecisionLayer: false
```

★ 而 `/economy/approval` 从 `unreachable` 里**移走**了（它现在是一条真路由），
`/economy/approve` 与 `/economy/reject` 逐名留下。一条声明若比真实路由更保守，
它就不再是在描述这个系统；因此移走它不是放松。

---

## 12 · Provider / Payment / Memory / Relationship / Decision / Action 隔离

```text
No Provider · No Payment · No Commerce · No Credential Vault
No Memory · No Relationship · No Decision · No Action · No MCP
No Middle Brain · No network
```

结构性的那一半：

- 自主策略的输入白名单**不含**任何正文 / 关系 / 模型输出类键，而载入期不变量
  检查这一条 —— "某天有人加了 relationship 字段"会在 `require` 的那一刻炸；
- `economy_autonomy_policies` 与 `economy_approvals` 的列里**没有**任何
  provider / payment / memory / relationship 字段 —— 不是"暂时没填"，而是
  **没有地方可以填**；
- P22-7 的十条事件每一条都带齐四句否认（`providerMutation` /
  `paymentMutation` / `memoryMutation` / `relationshipMutation` 全为 `false`）；
- `P22-7 只是"权限判定"，不是"Agent 决策"`：`AUTONOMY_POLICY_IS_A_DECISION_LAYER
  === false`，而 `health()` 把它写成一个可断言字段。

---

## 13 · 测试

```text
tests/test_p22_7_economy_autonomy.js    34 项   契约 + 纯策略
tests/test_p22_7_economy_approval.js    59 项   批准生命周期
tests/test_p22_7_economy_runtime.js     43 项   真实进程 + 并发 + 崩溃
tests/fixtures/p22-7-approval-worker.js 419 行  多进程 fixture
```

### autonomy（A..F）

```text
A  APPROVAL_STATE 五态与四条禁止的边
B  三个结论 · 十条判据的冻结顺序 · no-policy fail closed · 一千次纯函数性
C  §3 Budget × Autonomy 两层边界（两者能给出相反的答案）
D  §2/§4 输入纪律（白名单 / 禁止键 / 没有裸 limit）
E  §6 九元组绑定（重算一致 / 换任何一项即失效）
F  §12/§13 Gift 与 Compute/API quota 的边界
```

### approval（A..G）

```text
A  自主策略的持久化（写 / 读 / revision / 事件 / 幂等 / 乐观并发）
B  §5/§9 五态状态机与四条终态不可倒退的边（含 self-approval 拒绝）
C  §6 九元组绑定：批准不能被挪给另一笔购买
D  §8 一次性消费：一个批准最多一笔购买 + 重放/终态冲突
E  §7 快照：批准针对 Quote，而不是 mutable Product
F  §10/§11 授权闸门与"批准不是预算豁免"
G  §16 审计：仅凭 canonical facts 回答四个问题
```

### runtime（B..F）

```text
B  真实 Home Node（schema 6）+ 五条只读路由 + 九个 health 计数 + 重启
C  20 次写尝试全部 405 + /security 十一项字段 + desktopPaths/unreachable 双向
D  两个进程分别 APPROVE/REJECT（恰好一个写入者）+ 同 key 并发
E  两个进程同时拿同一条批准去买（恰好一笔购买 / 一次消费 / 无撕裂事实）
F  7 个注入点 × 真实崩溃（exit 134）+ hit 证明 + 不变量 + 重试成功一次
```

### 结果

```text
P22 全量 18 条：2093 项 · 0 失败（104 s）
aggregate（static 99 + service 29）：3 项失败，全部是既有基线
```

aggregate 的三项失败**与本阶段无关**：

| 测试 | 性质 | 证据 |
|---|---|---|
| `test_cache_audit.js` | 基线既有失败 | P22-6 的 baseline `f843b3b` 反证里同样失败 |
| `test_middle_brain_convergence_counterproof.js` | 基线既有失败 | 同上 |
| `test_astra_readiness_observe.js` | **阶段守卫** | 唯一失败项是 `Z1.noProductionFileChanged`（要求 `git diff -- services` 为空）—— 它断言的是"阶段进行中"，不是产品不变量 |

---

## 14 · 开发期抓到的真实缺陷

十一项，全部由测试或审计在**写出它们的那一刻**抓到：

1. **`gate.ok` 恒为 undefined** —— `canTransitionApproval` 返回 `allowed`，
   没有 `ok`。`gate.ok !== true` 让**每一条**合法的批准转移都被拒。
2. **`decideApproval` 的幂等闸门排在状态闸门之后** —— 一次成功决定的重放先撞
   上状态闸门，收到 `TRANSITION_NOT_ALLOWED` 而不是当初那个结果；而"重放必须
   返回当初那个结果"正是幂等的定义。
3. **`APPROVAL_EXPIRED` 不在封闭集合里** —— store 在三条路径上写
   `C.DENY_REASON.APPROVAL_EXPIRED`，而它**不存在**。`String(undefined)` 让
   返回里的 `reasonCode` 变成字面量字符串 `"undefined"`；症状与前两次同源
   （P22-6 的 `policyRow.policy_id`、`budgetRefusalOf` 的 `.detail`）：
   拒绝发生了，但**为什么**被拒绝消失了。
4. **`denial()` 被 extras 覆盖 `reasonCode`** —— 任何把别的拒绝对象当 extra
   传进来的调用点都会把 `reasonCode` 抹成 `"undefined"`。修在唯一出口处，并加
   规则："extras 只有在**显式给出有意义的值**时才允许覆盖"。
5. **`ensureSystemAccount` 的裸 INSERT** —— 两个真实进程第一次同时购买同一个
   quote kind 时，双方各自读到"账户不存在"然后各自 INSERT，第二个拿到
   `UNIQUE constraint failed: economy_ledger_accounts.account_id`。它不是罕见
   竞态：它恰好发生在**第一次**并发购买上。改为 `INSERT OR IGNORE`。
6. **`if (approved)` 分支里少了 outcome 把关** —— AUTO_ALLOW 仍然走进
   `REQUIRE_APPROVAL` 分支并要求一个 `approvalExpiresAt`，于是策略明确说
   "自主"而闸门回答"需要用户批准"。
7. **`after-approval-consumed` 上抛错不是崩溃** —— `faults.hit()` 在事务内部，
   异常被 store 的 catch 翻成业务拒绝，事务照常 COMMIT；测试却在断言"崩溃
   回滚"。改用 `process.abort()` 做真崩溃。
8. **argv 位置参数让注入静默失效** —— 调用方传
   `fault <dir> <point> <quote> <approval> <key>`，worker 解构成
   `[, dir, point, quote, approval, key]`，于是 `point` 拿到的是 quoteId，
   `throwAt` 与任何真实注入点都不相等。改用具名 `--flag value`。
9. **注入点清单手写会漂移** —— 我最初写的 `before-approval-consume` 与
   `after-purchase-authorization` 都**不存在**。改成从源码推导 + 逐点入口 +
   hit 证明。
10. **5→6 迁移假设表已存在** —— 跨两级的升级路径（schema 4 → 6）失败，而跨
    一级的是绿的。
11. **一次被撤销的危险改动**：我一度在 `withTransaction` 的嵌套分支上加
    `catch + ROLLBACK`，理由看起来是对的（"嵌套事务里的故障必须由这一层
    回滚"）。它把 `settlePurchase` 的**外层**事务回滚掉并把 `txDepth` 归零，
    于是外层最后那句 COMMIT 变成一次"没有活动事务"的提交（抛错被吞掉），
    调用方拿到一个**看起来成功**的结果。实测症状：注入消费点之后结算仍然报
    `ok: true`，而库里留下了半完成状态。已撤销，并在代码里留下"为什么**不**
    在这里回滚"的逐字说明。

---

## 15 · Stop Gate 的六问

| # | 问题 | 答案 | 代码 | 测试 |
|---|---|---|---|---|
| 1 | 没有 autonomy policy 时默认 `REQUIRE_APPROVAL`？ | **是** | `evaluateAutonomousPurchase` ①；`AUTONOMY_DEFAULT_WHEN_NO_POLICY`；载入期不变量 | autonomy B1/B1b；approval B1；runtime B9 |
| 2 | Budget ALLOW 仍可能因 autonomy 要求批准？ | **是** | 两个独立判据，`AP_DECISION.ALLOW` 与 `BUDGET_DECISION.ALLOW` 是**两个**词 | autonomy C2（Budget ALLOW + Autonomy REQUIRE_APPROVAL）；C3（反向） |
| 3 | Approval 严格绑定 Quote/金额/recipient，不能挪用？ | **是** | 九元组 + `approvalFingerprint` + `approvalBindingMismatch` + integrity 重算 | autonomy E1..E8；approval C1..C7（含改库篡改） |
| 4 | 一个 Approval 最多消费一次？ | **是** | `setApprovalConsumed` 的 `AND status='APPROVED'` + `consumed_by_purchase_id` UNIQUE + `quote_id` UNIQUE | approval D1..D6；runtime E2..E8 |
| 5 | Approval 绝对不能绕过最终 Budget revalidation？ | **是** | 消费在 settle 事务里、**排在**预算最终复核**之后**；预算 DENY ⇒ 同一 ROLLBACK | approval F2/F3；approval A（P22-6 的结算顺序未改） |
| 6 | Compute/API quota 自主购买仍只增 IB 内部 entitlement？ | **是** | `COMPUTE_ENTITLEMENT` / `computeUnit` / 账户白名单 / 四句否认 | autonomy F4/F5/F6；runtime C2 |

---

## 16 · 仍然停在哪里

**未进入**：Agent autonomous decision · Decision integration ·
Action integration · Middle Brain · UI · 素材 · 真实 Provider quota ·
真实支付 · 退款 · Exchange。

`Approval` 是一条**一次性事实**（"用户授权某个被冻结的购买意图继续执行"），
它**不是**一笔购买、**不是**预算豁免、**不是**一个可复用的 capability。
真正的"用户点批准"入口留给未来的 UI / Action authority 阶段。
