# P22-4 · Economy 预算规则（Budget Policy）与报价（Quote）

> 本阶段回答的两个问题：
>
> **「这项经济行为在当前预算规则下是否允许？」**
> **「如果执行，需要锁定多少资源？」**
>
> 而**不**真正执行购买。

P22-2 让 Economy 能回答"这个钱包有多少钱"。P22-3 让它回答"这些钱现在能
不能花"（`available = ledger − Σactive`）。P22-4 加上第三、第四层：

```text
Economic Request
      ↓
   Quote            ← 价格命题：什么 / 多少钱 / 到什么时候
      ↓
Budget Policy       ← 规则：允不允许花
      ↓
ALLOW / DENY / REQUIRE_APPROVAL
      ↓
（P22-x：Approval workflow）
      ↓
（P22-5：Purchase → Reservation → Ledger）
```

本阶段**没有**做的事（一个字都没碰）：

```text
真正执行购买           approval workflow         product / inventory / store   （P22-5）
exchange                （P22-6）                  compute 计价                  （P22-7）
Decision / Action adapter（P22-8）                 provider 适配                 （P22-9）
provider 额度购买       真实支付 / 充值              UI / 浏览器镜像               （P22-11）
```

---

## 0. 五个问题，五条边界

| 层 | 回答的问题 | 本阶段 |
|---|---|---|
| **Wallet** | 有没有这么多钱？ | 沿用 P22-2/P22-3，一个字没改 |
| **Budget Policy** | 规则允不允许花？ | **新增**（确定性纯规则系统） |
| **Approval** | 需不需要用户批准？ | **只分类**：返回 `REQUIRE_APPROVAL`，不创建 Approval |
| **Decision** | Agent 想不想买？ | 不属于 Economy |
| **Action** | 是否真的执行？ | 不属于 Economy |

把这几层混起来最常见的后果是：LLM 说"我很想买" → 某个 `if` 把它读成
"预算允许"。本阶段的实现方式不是"记得别读正文"，而是让那段文字**没有
地方可以放** —— 见 §3。

---

## 1. Budget Policy 的 canonical 来源

```text
economy_budget_policies          ← 规则本身（一个 owner 恰好一条）
        +
committed ledger facts           ← 已经花了多少（按 UTC 窗口分桶）
        ↓
   评估上下文（纯数据）
        ↓
   evaluateBudget(policy, context)   ← 契约里的**纯函数**
        ↓
   ALLOW / DENY / REQUIRE_APPROVAL
```

**没有第三个来源。** 窗口累计不来自缓存、不来自 UI 计数器、不来自
`localStorage`、不来自任何"记忆"。`health()` 把这句话写成了可断言字段：

```js
budgetCanonical: 'sqlite-budget-policies + committed-ledger-facts'
budgetDerived: 'none'
budgetWindowsCanonical: 'UTC day/week/month buckets over committed ledger debits'
budgetEvaluationIsNotASpendPermit: true
```

---

## 2. 政策 schema

```sql
economy_budget_policies (
  policy_id TEXT PRIMARY KEY,          -- econ_policy_…（P22-1 §5 冻结的第 6 种）
  owner_id TEXT NOT NULL, owner_type TEXT NOT NULL,
  currency TEXT NOT NULL,
  status TEXT NOT NULL,                -- POLICY_STATUS = {ACTIVE, DISABLED}
  max_per_tx_minor INTEGER,            -- 五个限额列，全部带 _minor 后缀
  max_per_day_minor INTEGER,
  max_per_week_minor INTEGER,
  max_per_month_minor INTEGER,
  approval_above_minor INTEGER,
  cooldown_ms INTEGER,                 -- **时长**，不是金额（单独一列）
  autonomy_level TEXT,
  term_ends_at INTEGER,                -- NULL = 没有期限
  hard_stop INTEGER NOT NULL DEFAULT 0,
  hard_stopped_at INTEGER,
  idempotency_key TEXT NOT NULL, fingerprint TEXT NOT NULL,
  revision INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  UNIQUE (owner_id))
```

三处刻意的决定：

**`UNIQUE(owner_id)` 而不是 `UNIQUE(owner_id, currency)`。** 政策自己说它
作用在哪个币种上。若按二元组唯一，一个 owner 就能同时拥有"IB_CREDIT 的
政策"和"COMPUTE 的政策"，而评估时必须先选一条 —— 那是一次**没有正确答案
的选择**（两条都"对"）。把 scope 变成政策的属性之后，"有没有规则"这个
问题只有一个是非答案。

**`status` 与 `hard_stop` 分开，而它们必须一致。** `status` 说"现在生效
吗"，`hard_stop`/`hard_stopped_at` 说"是谁、什么时候把它停掉的"。开发期
在这里抓到一个真实缺陷（§14）。

**表里没有的列**：`provider` / `api_key` / `payment_intent` / `payment_link`
/ `checkout_url` / `real_currency` / `cny` / `usd` / `max_budget` /
`relationship` / `memory`。C16 对**真实 PRAGMA 读回来的列**逐条否认。

---

## 3. 确定性评估器（本阶段的核心）

```js
evaluateBudget(policy, context) → ALLOW | DENY | REQUIRE_APPROVAL
```

签名刻意是**两个数据参数**：没有 store、没有时钟、没有随机、没有 I/O。
于是

```text
same policy + same context  ⇒  same result
```

是**结构性**成立，而不是"我们小心地没有引入不确定性"。这一点被真的证伪过：

| 断言 | 做法 |
|---|---|
| 千次一致 | 同一个 `(policy, context)` 跑 1000 次，JSON **逐字节**相同 |
| 键序无关 | 把 policy 的所有键反序重建，结果相同 |
| 深拷贝无关 | `JSON.parse(JSON.stringify(ctx))` 得到同一个结果 |
| 不读时钟 | 把 `Date.now` 换成一年后，结果一个字都不变 |
| 不读随机 | 把 `Math.random` 换掉，结果一个字都不变 |

### 3.1 输入是封闭的

`context` 的键**必须**来自 P22-1 §13 的 `BUDGET_INPUT_KEYS`：

```text
ownerId  currency  amountMinor  quantity  category  productId
recipientId  actorId  usage  limits  timestamp  autonomyLevel  walletState
```

任何其它键 → `policy-input-key-not-whitelisted`；已知的正文污染键 →
`policy-input-carries-non-deterministic-text`。

```js
prompt            → 拒绝
llmOutput         → 拒绝
reasoning         → 拒绝
relationship      → 拒绝      // {trust: 0.9} 也是拒绝
narration         → 拒绝
maxBudget         → 拒绝      // P22-0 R2 的真实人民币键
```

**LLM 未来可以决定"我想买这个"，但不能决定"我觉得预算应该允许"。**
后者在数据类型里根本不存在。

### 3.2 结果形状

```js
{
  domain: 'ib.economy', namespace: 'ib.economy.budget',
  outcome: 'ALLOW' | 'DENY' | 'REQUIRE_APPROVAL',
  allowed, denied, requiresApproval,       // 三个互斥的布尔
  reasonCode,                              // 封闭集合里的一个，绝不自由文本
  priority,                                // 哪一条规则说的（可断言）
  snapshot: { kind: 'evaluation', authority: 'none', at: <ts> },
  timezone: 'UTC'
}
```

`snapshot.authority === 'none'` 不是修辞：它把"这是一次快照评估、不是
可以拿去执行的许可"写进**每一份**返回值里（§10）。

三个 outcome 各自**恒有**一个 reasonCode：`ALLOW → 'BUDGET_ALLOWED'`、
`REQUIRE_APPROVAL → 'AMOUNT_EXCEEDS_APPROVAL_THRESHOLD'`、`DENY →`
封闭的 `DENY_REASON` 之一。

---

## 4. 评估顺序（11 步，冻结）

```text
1  policy-effective       规则在这个作用域与这个时刻存在且生效吗？
2  wallet-ready           canonical 余额**可不可信**（不是"够不够"）
3  policy-scope           ownerId / currency 就是政策的作用域吗？
4  amount-valid           金额是 canonical 量（> 0）吗？
5  available-balance      available >= amount 吗？
6  per-transaction        单笔上限
7  daily                  日额度
8  weekly                 周额度
9  monthly                月额度
10 approval-threshold     超过审批线 ⇒ REQUIRE_APPROVAL（不是 DENY）
11 allow
```

顺序写在 `BUDGET_EVALUATION_PRIORITY` 里（一个**编号的常量数组**），结果
里带回 `priority` 字符串。于是"为什么是这个 reasonCode 而不是另一个"可以
从输出直接读出来，测试也能逐条断言 —— 同一输入只可能得到一个 reasonCode。

**为什么 5 排在 6-9 之前。** 余额不足是"这次根本买不起"，而额度不足是
"这次买得起，但规则不允许"。前者的正确反应是换商品或等收入，后者是等
窗口滚动。顺序反了会让调用方看到一个不准确的原因。

**为什么 10 排在最后。** `REQUIRE_APPROVAL` 表达的是"这件事可以做，但
需要用户点头"。只有当所有**硬**规则都通过之后，"需要点头"才是一个有意义
的结论 —— 否则它会把"超额度"也说成"待批准"。

**为什么 ALLOW 也在编号里。** 因为"走到最后一步"这件事本身需要被断言
（E9 检查三个不同输入的 priority 各自落在预期的那一格）。

---

## 5. machine reasonCode

| 场景 | outcome | reasonCode |
|---|---|---|
| 一切通过，金额 ≤ 审批线 | `ALLOW` | `BUDGET_ALLOWED` |
| 一切通过，金额 > 审批线 | `REQUIRE_APPROVAL` | `AMOUNT_EXCEEDS_APPROVAL_THRESHOLD` |
| 没有政策 / 政策 DISABLED / owner 不匹配 | `DENY` | `POLICY_NOT_FOUND` |
| 政策存在但期限已过 | `DENY` | `POLICY_TERM_EXPIRED` |
| 币种不匹配 | `DENY` | `INVALID_CURRENCY` |
| 金额 0 / 缺失 / 非法表示 | `DENY` | `INVALID_AMOUNT` 或 `POLICY_INPUT_NOT_STRUCTURED` |
| 输入键不在白名单 / 正文污染 / 快照不完整 | `DENY` | `POLICY_INPUT_NOT_STRUCTURED` |
| available < amount | `DENY` | `INSUFFICIENT_AVAILABLE_BALANCE` |
| amount > per-tx 上限 | `DENY` | `AMOUNT_EXCEEDS_PER_TRANSACTION` |
| spent + amount > 日/周/月额度 | `DENY` | `DAILY_LIMIT` / `WEEKLY_LIMIT` / `MONTHLY_LIMIT` |
| canonical 不可信 | `DENY` + `systemFailure:true` | `WALLET_NOT_READY` |

**P22-4 对封闭集合的加法（4 个，零修改）：**

```text
POLICY_NOT_FOUND                    "这个作用域上没有生效的规则"
POLICY_TERM_EXPIRED                 "规则存在过，但期限走完了"
AMOUNT_EXCEEDS_PER_TRANSACTION      "这次金额超出单笔上限"（PER_TX_LIMIT 的具名化）
AMOUNT_EXCEEDS_APPROVAL_THRESHOLD   REQUIRE_APPROVAL 的 reasonCode
```

四个都不能复用已有的代码，理由逐条写在契约里。`POLICY_NOT_FOUND` 与
`POLICY_TERM_EXPIRED` 分开，是因为"政策没配"与"政策到期"在时间线上是
两件不同的事；`INSUFFICIENT_BALANCE` 与 `INSUFFICIENT_AVAILABLE_BALANCE`
（P22-3 加的）继续分开，理由同源。

**没有 `OTHER` / `UNKNOWN` / `ERROR` 兜底值。** 契约里有一条自检：评估器
可能返回的每一个 reasonCode 都必须在封闭集合 ∪ `{BUDGET_ALLOWED}` 里，
否则契约**载入期就抛错**。

---

## 6. 消费窗口（§13/§14）

```text
day    = floor(now / 86400000) * 86400000          UTC 日
week   = 该 UTC 日所属的**周一** 00:00Z             （ISO 周，纯算术）
month  = 该 UTC 月的 1 日 00:00Z                    （纯整数日期算法）
```

**时区是 UTC，明确写进 `health().budgetTimezone` 与每一份评估结果。**
不读 locale、不读时区数据库、不读环境变量。日与周是纯算术（UTC 没有
夏令时）；月必须读日历，但读的是 Howard Hinnant 的 civil-from-days
整数算法 —— `utcMonthStart` 用 **131 年 × 12 月 × 4 个采样点**逐个与
`Date.UTC(y, m, 1)` 交叉验证过（6288 个样本，0 个不一致）。

### 6.1 只统计**真正花掉**的

```text
sum(entries.amount_minor)
  WHERE account = 该钱包的 WALLET 账户
    AND direction = 'CREDIT'
    AND transactions.state = 'COMMITTED'
    AND transactions.tx_type ∈ BUDGET_SPENDING_TYPES
    AND entries.created_at >= 窗口起点
```

三处刻意，每一处都有代价：

**① 金额只从 `entries.amount_minor` 读。** `economy_transactions` **没有**
金额列（P22-2 §6：交易上再存一份金额就是第二个事实源）。

**② 方向只从 `direction` 读，绝不用 `amount < 0` 猜。**

**③ 哪些 type 算消费来自契约的封闭表**，不是 SQL 里再写一遍 `IN` 列表：

```js
BUDGET_SPEND_CLASS = {
  PURCHASE: 'SPEND', GIFT: 'SPEND', COMPUTE_CONSUME: 'SPEND',
  EXCHANGE: 'NEUTRAL', COMPUTE_GRANT: 'NEUTRAL', REFUND: 'NEUTRAL',
  MINT: 'NEUTRAL', BURN: 'NEUTRAL'
}
```

契约载入期自检这张表**恰好**覆盖 `TX_TYPES`。于是"新增一个 transaction
type 却忘了说它算不算消费"会在契约载入时失败，而不是在某个窗口的求和里
静默地少算一笔。

**为什么 EXCHANGE 是 NEUTRAL 而不是 SPEND**：兑换是同一 owner 内部的
币种搬移（P22-6 的语义），而政策按 `(owner, currency)` 作用域。把它记成
消费会让一次换钱永久吃掉某个币种的日额度 —— 那是一条没人要求过的规则。
`COMPUTE_GRANT` 同理：额度是**被授予**的。

### 6.2 这一组抓到的一个真实缺陷（READ 这个）

消费查询最初写成 `direction = 'DEBIT'`。而 P22-2 §8.2 里：

```text
WALLET 账户： balance = Σ(DEBIT) − Σ(CREDIT)
```

也就是说 —— **"钱从这个钱包出去"记成一条 `CREDIT`**（余额减少），而
增发记成一条 `DEBIT`。在这份账本里"花掉"与"增加"的方向正好与直觉相反。

后果：**所有消费窗口恒为 0**。而除了"窗口应该是 120"这一条之外，**每一条
断言都还是绿的** —— 因为 0 是一个合法的窗口值，"没有消费"与"读不到消费"
在数据上长得一模一样。

这正是 §14 要求按**冻结的 transaction type** 判断、而不是按符号或方向
直觉判断的原因：判据必须是账本自己的语义。D18 现在同时钉住两件事：
SQL 里写的是 `CREDIT`，以及"钱进来是 DEBIT / 钱出去是 CREDIT"在真实
账本行上成立。

### 6.3 三类"还回去"都不吃掉预算

`reserve` 之后 `release` / `expire` / `fail` —— 三者都**不计入**窗口：

- `reserve` 本身不计入（钱还没花，只是被锁住）；
- `release` / `expire` / `fail` 不产生 ledger 事实（P22-3 §12/§13），
  因此窗口求和里根本没有它们的行。

D13–D15 逐条断言。否则"一次取消"就等于"花掉了一笔"。

### 6.4 窗口边界逐个可断言

```text
D6  23:59:59.999 与次日 00:00:00.000 落在**不同**的日窗口
D7  跨日之后 spentToday 归零，spentThisWeek / spentThisMonth 仍是 120
D9  周窗口起点是 UTC 周一 00:00Z，7 天后仍是周一
D10 跨周之后 today=0 / week=0，而 month 仍是 200
D11 月界：1 月 31 日 / 2 月 29 日 / 2 月 28 日（平年）全部算对
D12 跨月之后三个窗口全部归零
```

---

## 7. fail closed：系统故障 ≠ 业务拒绝

| 情形 | 结果 |
|---|---|
| 政策不存在 / DISABLED | `DENY` + `POLICY_NOT_FOUND`，`systemFailure` 不设 |
| owner 没有钱包 | `DENY` + `WALLET_NOT_READY`，`systemFailure: false`（**业务**结论） |
| 账户引用链断了 | `DENY` + `WALLET_NOT_READY` + `systemFailure: true` + `integrity:[…]` |
| 窗口求和读不出来 | 同上（`available` 那一半仍然是真实的数） |
| `now` 不是安全整数 | `DENY` + `POLICY_INPUT_NOT_STRUCTURED` + `systemFailure: true` |
| 库没打开 | **抛** `STORE_CLOSED`（不是返回一个"余额 0"的结论） |
| `health()` 在库关着时 | 返回 state（**不抛错** —— 抛错会诱使调用方写 `catch { return 0 }`） |

两条不可协商：

```text
available 未知 ⇒ null，绝不是 0
系统故障与业务拒绝必须可区分（systemFailure 字段）
```

F 组对**真实 SQLite** 做破坏（把账户行的 `wallet_id` 断掉），断言：
available 是 `null`、决策是 `DENY` + `WALLET_NOT_READY` + `systemFailure`、
而且 reasonCode **不是** `INSUFFICIENT_AVAILABLE_BALANCE`、**也不是**
`POLICY_INPUT_NOT_STRUCTURED`（把系统故障说成"输入不对"会让运维去查请求，
而真正坏的是库）。

---

## 8. 报价（Quote）：价格命题 ≠ 资源锁定

### 8.1 schema

```sql
economy_quotes (
  quote_id TEXT PRIMARY KEY,           -- econ_quote_…（P22-1 §5 冻结的第 9 种）
  product_id TEXT NOT NULL,            -- econ_product_…
  buyer_id TEXT NOT NULL, buyer_type TEXT NOT NULL,
  recipient_id TEXT, recipient_type TEXT,
  currency TEXT NOT NULL,
  amount_minor INTEGER NOT NULL,
  quantity INTEGER NOT NULL,
  quote_kind TEXT NOT NULL,            -- QUOTE_KIND = {PURCHASE, GIFT, COMPUTE_GRANT}
  service_role TEXT NOT NULL,          -- **冻结的**结算 transaction type
  state TEXT NOT NULL,                 -- QUOTE_STATE = {OPEN, CONSUMED, EXPIRED}
  expires_at INTEGER NOT NULL,
  predecessor_quote_id TEXT,           -- 重新报价的链（UNIQUE）
  idempotency_key TEXT NOT NULL, fingerprint TEXT NOT NULL,
  revision INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)
```

**报价表里没有的列**：`inventory_count` / `owned_items` /
`provider_quota_balance` / `api_key` / `payment_link`。报价只描述
"什么 / 多少钱 / 到什么时候"（§28：报价不得变成隐蔽库存）。

### 8.2 状态机

```text
OPEN → { CONSUMED, EXPIRED }
CONSUMED → ∅        （终态）
EXPIRED  → ∅        （终态）
```

用的是 P22-1 §14 冻结的三个状态，**转移表是 P22-4 补的**（P22-1 冻结了
状态但没有写下转移表，而"已消费的报价不能回到 OPEN"必须是一条被**执行**
的规则）。有意**没有** `CANCELLED`：契约里没有这个字，而"作废一份还没被
接受的报价"完全可以由**过期**表达（把 `expiresAt` 设到过去是调用方的
决定，不是一个新的状态）。

终态回退的失败信息指名出路：

```text
terminal-quote-cannot-transition-must-create-a-new-quote
```

### 8.3 金额与币种不可变

唯一一条写 `quotes` 的 SQL：

```sql
UPDATE economy_quotes SET state=?, revision=?, updated_at=? WHERE quote_id=? AND state=?
```

`SET` 里**没有** `amount_minor` / `currency` / `buyer_id` / `product_id` /
`quantity` / `quote_kind` / `service_role` / `expires_at` / `created_at`。
于是 §9 的 immutable 不是一句纪律，而是"那些列根本没有出现在任何 UPDATE
的 SET 里"。E 组同时做三件事：静态扫 SET 列、扫"不存在另一种写语句的
形态"、以及**篡改派生列之后**证明完整性检查会抓住它（`service_role` 与
`quote_kind` 不一致是可检测的）。

改价的**正确**形态是开一份新报价并链回去：

```js
createQuote({ ..., predecessorQuoteId: oldQuoteId })
```

`predecessor_quote_id` 上有一条 UNIQUE 索引，于是链不可能分叉。第二次
尝试会被拒绝（`DUPLICATE_REQUEST` + `this-quote-already-has-a-successor`）。
开发期这里也抓到过一次：第一个版本让 SQLite 的 `UNIQUE constraint failed`
直接冒出去 —— 调用方拿到 `ERR_SQLITE_ERROR` 之后不知道该说什么。现在
先显式查一次（变成业务语言），索引仍然在（并发下它才是权威，catch 会把
同一个约束错误翻译成**同一句**拒绝）。

### 8.4 报价的种类与未来兼容（§29）

```js
QUOTE_KIND = { PURCHASE, GIFT, COMPUTE_GRANT }
QUOTE_SETTLEMENT_TYPE = {
  PURCHASE: 'PURCHASE',        // 钱从钱包流向 system:market
  GIFT: 'GIFT',                // 同上，但 recipientId 有值
  COMPUTE_GRANT: 'COMPUTE_GRANT'  // 额度从 system:treasury 流向钱包
}
```

`service_role` 在**创建时**派生并写下来，而不是结算时再推导一次 ——
理由与报价存在的意义同源：将来真正执行时读到的必须是与报价一起冻结的
那个答案。契约载入期自检：每个 settlement type 都必须是冻结 `TX_TYPE` 的
成员。

**`API_QUOTA` 今天就能被表达**，而 provider 一个字节都没碰：

```js
createQuote({
  amountMinor: 400,          // 400 IB_CREDIT（**支付**币种）
  quantity: 1000,            // 1000 个 computeUnit（**数量**）
  productId: 'api-quota-premium-1000',
  kind: 'COMPUTE_GRANT'      // 结算形态 = 额度被授予
})
```

K 组七条断言钉住这件事：结算形态落在冻结词表里、`COMPUTE_GRANT` 是
NEUTRAL（不花这个 owner 的额度）、评估仍然走支付币种的预算作用域、
`compute` 币种没有被误当成支付币种、币种表里**没有**任何 provider 余额
代币、报价表里没有任何额度余额列。

### 8.5 到期（§10）

与 P22-3 的预留到期**逐条同构**：显式 `now`、确定性、幂等、分批、每份
一个自己的事务、**没有定时器**。资源后果是**零** —— 过期一份报价不释放
任何东西，因为它从来没有锁住任何东西。G 组断言：扫描只改报价的状态而
账本 / 预留 / 钱包那一半逐字未变（两个指纹分开比：经济的那个必须相同，
含报价的那个必须不同）。

幂等键由 `quoteId` 确定性派生（`econ.sweep.quote+<id>`），而且**刻意不含
now**：换一个 `now` 扫同一次到期是同一个业务决定。G8 断言这一点。

---

## 9. 报价 ≠ 预留：结构证据，而不是注释

这是本阶段最需要被证明的分离性，因为最容易发生的错误是把 `createQuote`
写成"顺手 reserve 一下，反正马上要用"——那样报价一多，可用余额就被一堆
没人要的报价吃光，而每一笔单独看都"对"。

**C 组**连开三份总额 1200 > 可用余额 1000 的报价，然后断言：

```text
C1  账本 / 预留 / 钱包**逐字未变**（一个经济指纹前后相同）
C2  available 一动不动（仍是 1000，reserved 仍是 0）
C3  0 笔 transaction / 0 笔 reservation / 0 个 operation 被创建
C4  三份报价各自 reservedFunds:false / ledgerMutation:false
C5  只有 quotes 那一层的计数在变（openQuotes → 3）
C6  对照组：真的做一次 reserve 时，同一个指纹**确实**会变
C7  对照组收尾：release 之后 available 回到 1000，而报价一份没少
```

C6/C7 是刻意的：没有对照组的话，C1 有可能只是"指纹不敏感"。

**D 组**证明"评估报价"不会偷偷变成"接受报价"：两千次 `evaluateQuote`
之后世界逐字未变（含报价状态），结论是 ALLOW 的那一份仍然是 `OPEN`，
返回对象里带着 `evaluatedOnly: true` / `reserved: false` /
`consumed: false` / `notASpendPermit: '…'` 四个逐字声明。

---

## 10. TOCTOU 与 in-transaction seam（§19/§31）

**`ALLOW` 是一次快照评估，不是一张通行证。**

```text
ALLOW at T1  ⇏  ALLOW at T2
```

理由是可验证的：评估读的是 `available` 与三个窗口，而这两样东西在两次
调用之间都可能被别的事务改变。契约把这句话写进**每一份**结果
（`snapshot.authority === 'none'`），store 把它写进每一个出口
（`notASpendPermit`），HTTP 把它写进 `/security`
（`budgetEvaluationIsASnapshotOnly: true`、
`budgetEvaluationReservesFunds: false`）。

因此未来的 purchase 流程必须在**同一个事务里**重新组装快照并重新评估。
P22-4 提供的正是那个接缝：

```text
buildBudgetSnapshot({ ownerId, currency, amountMinor, now })   ← 组装（纯读）
evaluateBudget(policy, context)                                ← 判定（纯函数）
evaluateBudgetFor({ ownerId, currency, amountMinor, now })     ← 上面两个的组合
```

三者都是**读**，可以在任何事务内部调用。并且 `reserveFunds` 已经接上了
这条路径（`enforceBudget: true`）：

```text
BEGIN IMMEDIATE
  … 重算 ledger / reserved / available …
  ★ if (o.enforceBudget === true) {
      const budget = evaluateBudgetFor({ … now: at });   ← 在同一个锁里
      if (!budget.decision.allowed) throw refuse(budget.decision.reasonCode, …);
    }
  … 插入 operation / reservation …
COMMIT
```

**为什么缺省不强制。** `reserveFunds` 是 P22-3 的冻结面，而"没有政策 ⇒
拒绝一切"会改变 P22-3 已经冻结的行为（那些测试里没有政策，它们校验的是
余额与锁定量）。因此强制是一个**显式**开关，由将来的 purchase 流程
（P22-5）打开。P22-4 提供的是这个可以原子调用的接缝，而不是替 P22-5
决定它的语义。

**`REQUIRE_APPROVAL` 在 reserve 里等同于不允许。** 执行的前置条件是一个
`ALLOW`，不是一个待批准；把"需要点头"当成可以继续会让审批这一层消失。

---

## 11. 判断与执行的分工：验证式分离

P22-4 里 `reserve` 是唯一会花钱的方法，而 P22-4 **不做购买**。因此本阶段
对"评估不是执行"给出的不是一条注释，而是一组可执行的分离断言：

```text
G1  四次评估（ALLOW / REQUIRE_APPROVAL / DENY / INVALID）之后，世界逐字未变
G2  评估**不消耗 revision**（评估不是一次经济事件，也不该是审计噪音）
G3  每一份结果都带着 evaluatedOnly / notASpendPermit / reserved:false
G4  改政策**不写 ledger**：交易数 / entry 数 / reserved / available 全部不变
G5  改政策的 change payload 里逐字写着 ledgerMutation:false
G6  改政策**消耗**一个 revision（规则的变化是一条不该被静默的事实）
G8  给一个不存在的 owner 做评估不会凭空创建钱包 / 政策
G9  spendingWindows 被调用十次不改变任何东西
```

B13 进一步断言：**十条只读 HTTP 请求（含两次评估）之后世界逐字未变**。

---

## 12. 幂等（§18 的同一纪律，两个新 scope）

持久化身份仍然是 `(scope, key)`，新增两个：

```text
OPERATION_SCOPE = { RESERVE, COMMIT, RELEASE, EXPIRE, FAIL, QUOTE, POLICY }
```

七个而不是五个 —— 这是一次**加法**（D13.15 的断言从"五元集合"改成
"七元集合"，它问的仍然是 scope 是封闭集合）。它们共用同一张
`economy_operation_idempotency` 表，因此"同一个 key 在 `QUOTE` 与 `POLICY`
下是两件事"逐字成立（H11 对真实表断言 scope 分别是 `QUOTE` / `POLICY`）。

| scope | 指纹覆盖 | 刻意**不含** |
|---|---|---|
| `QUOTE` | productId + buyerId + buyerType + recipientId + currency + amountMinor + quantity + kind + expiresAt | **quoteId**、predecessorQuoteId |
| `POLICY` | ownerId + ownerType + currency + status + limits + cooldownMs + termEndsAt + autonomyLevel | policyId、时间戳 |

`quoteId` 不在指纹里是刻意的（§11）：它是执行时才知道的。H9 断言"显式给
一个不同的 quoteId 仍然是重放，不是冲突"。

**一处顺带的加强：** `writeOperationIdempotency` 从裸 `INSERT` 改成
`ON CONFLICT(scope, idempotency_key) DO NOTHING`。理由：P22-4 加上了两种
"目标行可以被重建"的 mutation（政策的自然键是 `owner_id`，报价的
`quoteId` 可以由调用方显式指定）。那意味着"同一个 key 在清理窗口之后
重试"可能撞上一条已存在的幂等行，而裸 INSERT 会抛出一个 UNIQUE 约束异常
—— 那是**崩溃**，不是拒绝，而且它把一次无害的重试变成 500。
`DO NOTHING` 让"保留先到的那一条"成为确定的规则：幂等记录是**第一次**
执行的证据，后来的重试没有权力覆盖它。真正需要的重放路径早就在这个函数
**之前**返回了。

### 12.1 幂等闸门排在"当前状态判定"之前 —— 又一次

H4/H5 的断言是"同一个 key 换个买家 / 换个币种 ⇒ `IDEMPOTENCY_CONFLICT`"，
而开发期第一条实现给的是 `wallet-not-found`。根因是顺序：钱包存在性检查
排在了幂等闸门**之前**。

正确的问题顺序是：

```text
① 这个请求做过没有？           → 做过 ⇒ 返回当初的结果 / 冲突
② 它现在能不能做？             → 这才是余额、到期、钱包、规则
```

反过来会产生一个自相矛盾的答案：调用方问"我那次请求成没成"，却被回答
"那个买家没有钱包"。修法是把钱包查询移到闸门之后（`createQuote` 里现在
有一段注释专门说明这件事）。

---

## 13. 崩溃注入（§33）：15 个故障点

每一个都用一个**全新**的库，注入后逐项对真实 SQLite 断言。

| 组 | 点 |
|---|---|
| 政策写入 | `after-policy-insert` · `after-policy-update` · `before-policy-change-log` · `before-policy-commit` |
| 政策到期 | `after-policy-expire-validated` · `after-policy-expired` · `before-policy-expire-change-log` · `before-policy-expire-commit` |
| 报价写入 | `after-quote-insert` · `before-quote-change-log` · `before-quote-commit` |
| 报价到期 | `after-quote-expire-validated` · `after-quote-expired` · `before-quote-expire-change-log` · `before-quote-expire-commit` |

每个点断言：

```text
a  抛出的是注入的错误（不是被吞掉）
b  没有留下部分行（政策 / 报价的行数与状态回到注入前）
c  幂等表回到注入前的行数（重试能真的落地）
d  change log / 账本 / revision 全部回到注入前
e  回滚之后用同一个 key 重试**真的**成功（且只成功一次）
```

**预算评估本身是纯读，因此没有 rollback 问题** —— 它的"崩溃"断言是另一
种形状：无论怎么调用，世界不变（G1/G2/G9）。

### 13.1 这一组抓到的一个真实缺陷

`after-policy-update` 这个故障点最初**永远不会被执行**。因为它只在政策
**已存在**时才会被命中（新建走的是 `after-policy-insert`），而测试的播种
逻辑只对"到期"那一路建了政策。于是那条断言在"什么都没执行"的情况下变绿
—— 一个关于注入的断言在注入没发生时通过，是这类测试最坏的失败方式。

修法是在测试里显式区分两条路径，并让更新路径先**真的**建一条政策（用不同
的 idempotencyKey，因为同 key 不同 payload 是刻意的 `IDEMPOTENCY_CONFLICT`）。

---

## 14. 政策停用/重新启用：一个真实缺陷

第一版的 `upsertBudgetPolicy` 里，硬停用标记的写法是"停用时写 1，否则
**保留原值**"：

```js
disable ? 1 : Number(currentRow.hard_stop)      // ← 错的
```

后果：`停用 → 重新启用` 之后行上仍然是 `hard_stop = 1`，而
`policyEffectiveness` 看到 `hardStop` 就判不生效 —— **政策永远回不来了**，
而 `status` 列明明写着 `ACTIVE`。

那是一种特别难发现的坏：两个字段各自都自洽（`status=ACTIVE` 是对的，
`hardStop` 曾经也是对的），只有把它们放在一起看才矛盾，而
`policyEffectiveness` 读的是 `hardStop`。

修法是把这一个开关绑定到**本次写入的意图**上：

```js
disable ? 1 : 0, disable ? Number(at) : null    // 停用记时刻，启用清空
```

于是"`status` 与 `hardStop` 必须一致"不再是一条纪律，而是同一个布尔值的
两种表达。C10/C12 逐条断言这件事（含 `hardStoppedAt` 在重新启用之后必须
回到 `null`）。

---

## 15. 重启恢复（§34）

```text
open → mint 1000 → putPolicy → createQuote → spend 120 → close → open
```

断言：政策逐字还在（含期限与 autonomyLevel）、三个窗口逐字相同（它们是
从 committed 事实**重算**的，不是存下来的）、同一个输入的评估结论逐字
相同、**重启不消耗 revision**（对账无误 ⇒ 什么都不写）。

离线过期（政策）：

```text
putPolicy(termEndsAt = T) → close → 时钟推进 → open
```

数据上政策仍然是 `ACTIVE`（到期是一个比较），但 `expiredByTerm = true`，
**评估立刻说不**（`POLICY_TERM_EXPIRED`）；扫一次之后落定为 `DISABLED`，
再扫一次什么都不做，`BUDGET_POLICY_EXPIRED` 恰好一条。

离线过期（报价）：同一形状，且断言过期**不产生任何经济后果**
（`transactions` / `entries` 都不动）。

---

## 16. schema 2 → 3

```text
ECONOMY_SCHEMA_VERSION = 3
```

第三次应用同一条纪律。P22-4 让库多出两张表（`economy_budget_policies` /
`economy_quotes`），于是：

- 一个 P22-3 的 build 打开 P22-4 的库 ⇒ **拒绝**（`SCHEMA_TOO_NEW`）。
  如果它不拒绝，它就会看到一个"没有政策、没有报价"的经济 —— 而那是
  一个**错误的**世界：它会认为任何消费都没有规则约束。这正是"读得到
  账本但不认识规则"最危险的形态，比打不开严重得多。
- 一个 P22-4 的 build 打开 P22-3 的库 ⇒ 受支持的老版本路径，DDL 补上
  两张表，水位抬到 3，**既有 ledger / reservation 行一个字节都不动**。

`2 → 3` 的 `MIGRATIONS` 条目为空：没有既有列需要改写，只有新表。
K 组在**真实的 `DROP TABLE` 造出来的旧库**上断言：补表之后两张新表是
**空的**（补表不等于补数据）、既有账本与预留逐字未变、能力立即可用。

顺带修好了一条**P22-3 遗留的假绿**：`M9`（"拒绝是只读的"）原先用
"先建全表再 DROP 掉几张"造库，而抬水位之后被 DROP 的表会被重新补上 ——
于是那条断言其实测不出"DDL 发生在水位检查之前还是之后"。现在它用手工
造的 P22-2 代库（只有 `economy_meta`、水位写成本代 +1），逐表断言那
**四张**表一张都没被创建。另外两处写死的水位数字（`A1`/`M2`）改成
"等于本 build 声明的水位"—— 它们要问的是"有没有第二套水位"，那件事与
具体数字无关，而写死会让**下一次**抬水位的人被迫改一条与本阶段无关的
断言。

---

## 17. 生产文件仍然是 2 个

```text
services/home-node/economy-contract.js     ← 契约（P22-4 的加法面在这里）
services/home-node/economy-store.js        ← runtime（政策 + 报价 + 评估）
```

**P22-4 没有新增生产文件。** 这不是为了省一个文件：

- 判定逻辑（`evaluateBudget`）放在**契约**里，因为它是 P22-1 §13 冻结的
  那套输入的**唯一合法解读**，而且它必须是纯函数。放进 store 会让"预算
  是一个纯规则系统"这句话从结构事实降级成一句注释。
- 持久化与快照组装放在 **store** 里，因为它们需要 `db` / `withTransaction` /
  `allocateRevision` / `appendChange`。拆成第三个文件就得把这些私有件暴露出
  去，而那会把"ledger 与预算判定在同一个 atomic boundary 里"从**结构保证**
  降级成跨模块约定 —— 与 P22-3 拒绝拆分 Reservation 是同一条理由。

依赖闭包仍然是 **3 个** require 目标（`node:sqlite`、`runtime/db-failure.js`、
`./economy-contract.js`）。没有 Memory / Relationship / Middle Brain /
Provider Router / 工具执行面 / 真实支付 / 凭据面。

---

## 18. HTTP 面：五条只读路由，30 次写尝试全部 405

```text
GET /economy/policies     列出预算政策（ownerId / status / limit）
GET /economy/policy       单条（policyId 或 ownerId）
GET /economy/budget       一次**快照评估**（ownerId / currency / amountMinor / now）
GET /economy/quotes       列出一份报价集合（buyerId / state / limit）
GET /economy/quote        单份（quoteId）；?evaluate=1 额外做一次预算评估
```

**没有** `POST` / `PUT` / `DELETE` 到这些路径中的任何一条。理由不是保守：

- 改预算规则是**权限**问题（"谁有权替一个角色决定它一天能花多少"），而
  本仓库还没有任何权限模型；在没有它之前开放一个 POST，等于让任何一个
  能发请求的人改所有人的花钱规则。
- 创建报价是**定价**问题（"这个价格是谁定的"），而定价属于 P22-5 的
  商品目录。
- `approve` 属于 P22-x 的 Approval workflow；`purchase` / `inventory` /
  `store` / `exchange` 属于后续阶段。

B 组对**十条路径 × 三种写动词 = 30 次写尝试**逐个断言 405
`economy-is-read-only`，然后断言政策 / 报价 / 钱包 / 账本 / revision
**一个字节都没变**。

两条刻意：

**`DENY` 是一个 200。** 它是评估的**结论**，不是一次 HTTP 失败。真正的
参数问题（缺 `ownerId`）才是 400。把两者混起来会让调用方无法区分
"规则说不"与"我的请求写错了"。

**报价的读取面不含 `idempotencyKey`**（与 reservation 同款）：请求标识
没有必要被广播。

`/security` 的 `economyPolicy` 把"没有"写成可断言字段：

```js
httpVerbs: ['GET']
writesExposed: []
reservationWritesExposed: []
budgetWritesExposed: []          // P22-4 新增
quoteWritesExposed: []           // P22-4 新增
mintingExposed: false
expirationIsNotATimer: true
budgetEvaluationIsASnapshotOnly: true     // P22-4 新增
budgetEvaluationReservesFunds: false      // P22-4 新增
quoteLocksFunds: false                    // P22-4 新增
budgetTimezone: 'UTC'                     // P22-4 新增
desktopPaths: [… 12 条]
unreachable: [… 含 '/economy/approve' '/economy/inventory' '/economy/store' '/economy/exchange']
```

`/economy/*` 仍在 `isDesktopOnlyPath` 里，**不给** loopback 豁免 ——
B21/B22 在配了桌面 token 的实例上断言新路由不带 token 一律 401。

装配缺口给 **501 `economy-not-assembled`**（F 组），不是 404、也不是
200 + 空数组 —— "没接线"与"没这个路径"必须给不同的回答。

---

## 19. Provider / Payment 隔离（§24/§25）

```text
Economy → Provider billing   NO WRITE
Economy → Real payment       NO
Economy → Credential vault   NO
```

三层强制：

**① 依赖闭包**（boundary B3）：Economy 的 require 目标只有 `node:sqlite`、
`runtime/db-failure.js`、`./economy-contract.js`。B13.2 逐条断言没有
`commerce` / `pay-gate` / `alipay` / `payment` / `credential-vault` /
`shopping`。

**② 真实人民币预算的硬隔离**（§4 的新增重点 boundary）：B13.1 扫**代码**
（剥掉注释与字符串）断言不存在 `maxBudget` / `dailyBudget` / `priceCNY` /
`realBudget`；B13.3 反向断言契约的冲突键清单里**确实**有 `maxBudget` 且
Budget 输入拒绝它（否则 B13.1 在保护空气）；B13.4 断言 P22-4 的每一个
政策限额字段都带 `Minor` 后缀（与真实人民币字段**字形不同族**），并且
表里没有 `max_budget` / `budget_minor` 这样的列。

**③ 凭据边界**（boundary B6.3）：`authorization` 这个词在 Economy 生产
代码里出现 0 次。P22-4 为此把两个字段改名（`notAnAuthorization` →
`notASpendPermit`、`budgetEvaluationIsNotAnAuthorization` →
`budgetEvaluationIsNotASpendPermit`）—— 不是为了让断言变绿，而是因为
**给一条安全断言开例外正是它最容易失效的方式**。改的是新字段的名字，
断言一个字没动。

**「topup 这个词在代码里不存在」**：L3 用代码扫描器（剥注释与字符串）
断言 `topup` 不出现在**代码**里，同时断言它**必须**作为否认数据出现在
`doesNotExpose` 里。一句解释"这里没有 topup"的注释不该让断言失败 ——
保护注释是这个仓库最不该丢的东西。

---

## 20. Memory / Relationship / Decision / Action（§26/§27）

```text
Economy → Memory        NO WRITE
Economy → Relationship  NO WRITE
Economy → Decision      NO OWNERSHIP
Economy → Action        NO EXECUTION
```

Budget evaluation **不偷读 Relationship**。三种"玩法"在结构上不可能：

```text
trust > 0.8        → 提高预算        ✗  评估上下文里没有 trust 这个键
affinity 高        → 免除审批        ✗  同上，normalizeBudgetInput 会拒绝
relationship 特殊  → 免费购买        ✗  同上
```

未来如果要做这种玩法，必须由上层明确**转换成 policy mutation**（改规则
是一次被审计的事件），而不是让预算层偷读关系。

B13.16 继续断言 `affection` / `trust` / `familiarity` / `affinity` 的累加
形态（`+=` / `-=` / `++` / `--`）在 Economy 生产代码里一次都不出现。
B13.15 断言评估上下文的构造**只使用**契约白名单里的键 —— 一个键名都不多。

---

## 21. 本阶段对契约的全部改动（逐项）

**七类加法，零修改**（domain contract 测试新增 D-ADDITIVE-P22-4 组 31 项
逐条钉住，并同时断言 P22-1 冻结的字面值一个字都没变）：

| # | 改动 | 理由 |
|---|---|---|
| 1 | `DENY_REASON` +4 | `POLICY_NOT_FOUND` / `POLICY_TERM_EXPIRED` / `AMOUNT_EXCEEDS_PER_TRANSACTION` / `AMOUNT_EXCEEDS_APPROVAL_THRESHOLD`（31 → 35） |
| 2 | `OPERATION_SCOPE` +2 | `QUOTE` / `POLICY`（5 → 7）；D13.15 的"五元集合"改成"七元集合" |
| 3 | `QUOTE_TRANSITIONS` / `QUOTE_TERMINAL_STATES` / `isQuoteState` / `canTransitionQuote` / `assertQuoteTransition` | P22-1 冻结了三个状态但没写转移表；"终态不可回退"必须被**执行** |
| 4 | `QUOTE_KIND` / `QUOTE_SETTLEMENT_TYPE` / `isQuoteKind` / `settlementTypeOfQuoteKind` | 让"买算力额度"这类未来商品今天就能被表达（§29） |
| 5 | `EVENT_TYPE` +8 | 政策四个（CREATED / UPDATED / DISABLED / EXPIRED）+ 报价四个（CREATED / EXPIRED / CONSUMED / CANCELLED）；后两个现在只登记不写 |
| 6 | `BUDGET_SPEND_CLASS` / `BUDGET_SPENDING_TYPES` / `BUDGET_NEUTRAL_TYPES` / `spendClassOfTransactionType` / `isSpendingTransactionType` | §14 禁止用 `amount < 0` 猜；分类必须是封闭数据表，且**恰好**覆盖 `TX_TYPES`（载入期自检） |
| 7 | `BUDGET_WINDOW*` / `utcDayStart` / `utcWeekStart` / `utcMonthStart` / `budgetWindowStart` / `POLICY_STATUS` / `POLICY_TERM` / `policyIsEffectiveAt` / `POLICY_LIMIT_TABLE` / `BUDGET_WINDOW_RULES` / `BUDGET_DECISION` / `BUDGET_ALLOWED_REASON` / `BUDGET_EVALUATION_PRIORITY` / `normalizePolicyLimits` / `validateBudgetPolicy` / `partyRefEquals` / `evaluateBudget` / `budgetDecision` | 确定性评估器与它的全部输入/输出词表 |

`validateQuote` 顺手用了新加的 `isQuoteState`（行为不变，只是不再内联
`QUOTE_STATES.indexOf`）。

**唯一改动的既有断言**：`D13.15` 的"五元集合"→"七元集合"。断言语义
一个字没变（scope 是封闭集合、`RESERVE` 必须在内、`TOPUP` 必须不在），
多出来的两个必须被**显式**列进去 —— 这正是它该有的阻力。

**载入期自检（三条，失败即抛错，不是返回错误对象）：**

```text
BUDGET_SPEND_CLASS 必须**恰好**覆盖 TX_TYPES
QUOTE_SETTLEMENT_TYPE 的每个值都必须是 QUOTE_KINDS 的成员 ∧ TX_TYPES 的成员
BUDGET_WINDOW_RULES 必须恰好覆盖每个 BUDGET_WINDOW 一次
POLICY_LIMIT_TABLE 只能命名 BUDGET_LIMIT_KEYS 里冻结的键
评估器返回的每一个 reasonCode 必须在封闭集合 ∪ {BUDGET_ALLOWED} 里
```

这些是模块自身的**一致性**，不是一个可以被调用方处理的情况 —— 因此它们
在载入期失败。

---

## 22. 契约的一处刻意避开

`evaluateBudget` 的结果里本来有一个 `authorization: false` 字段。它与
boundary B6.3（"Economy 不读 HTTP 的 Authorization 头"）在**文本上**撞车。

两个选项：给安全断言开一个例外，或者换一个词。选了后者 ——
`notAnAuthorization` → `notASpendPermit`，`budgetEvaluationIsNotAnAuthorization`
→ `budgetEvaluationIsNotASpendPermit`。撞车的后果不是编译错误，而是那条
断言不得不为一个**正确的**新字段开例外，而**给安全断言开例外正是它最
容易失效的方式**。改的是新字段的名字，断言一个字没动。

---

## 23. boundary 测试的扩展（P22-1 全部继续生效）

| 组 | P22-4 的变化 |
|---|---|
| B1–B12 | 继续生效 |
| **B13（新增 18 项）** | **B13.1** Economy 生产代码里没有 `maxBudget`/`dailyBudget`/`priceCNY`/`realBudget`（剥注释与字符串）· **B13.2** 没有 require 到购物/支付/凭据域 · **B13.3** 契约的冲突键清单确实有 `maxBudget` 且 Budget 输入拒绝它 · **B13.4** 每个政策限额字段都带 `Minor` 后缀 · **B13.5** 预算评估那一段代码里没有任何写路径（`commitLedgerTransactionInTx` / `applyReservedCache` / `setWalletBalance` / `insertOperation` / `allocateRevision` / `appendChange` … 逐个不存在）· **B13.6** 组装快照同样纯读 · **B13.7** `evaluateQuote` 只读（且逐字带 `reserved: false` / `consumed: false`）· **B13.8** 唯一写 quotes 的 UPDATE 只赋状态与版本列（11 个经济内容列逐列断言）· **B13.9** 带 `AND state=?` 并发守卫 · **B13.10** 到期是 `WHERE state=? AND expires_at <= ?`，且生产文件没有定时器 · **B13.11** http.js 里没有 P22-4 的六个 mutation 方法名 · **B13.12** http.js 里出现的读取面恰好是那九个只读方法 · **B13.13** 五条新路由全是 GET 且都在 `economyPolicy.desktopPaths` 里 · **B13.14** `/security` 把五项"没有"写成可断言字段 · **B13.15** 评估上下文的构造只使用契约白名单里的键 · **B13.16** 没有关系维度的累加形态 · **B13.17** 报价表的列**恰好**是允许的那 19 列，没有任何隐蔽库存列 · **B13.18** 输入存在（否则上面每一条都在保护空气） |
| B4.4 | "不许被 http 层调用"的名单从 15 个扩到 **21 个**（加上 P22-4 的六个） |
| B9.1/B9.2 | 重跑：2 个生产文件 + 3 个 require 目标逐个在 release manifest 里 |

### 23.1 B13 开发期抓到的两处假阳性（修的是**断言**，不是生产代码）

**B13.13** 原先从文件里取**第一处** `desktopPaths` 来比对，而 `/security`
里有四处（memory / understanding / moments / economy）—— 于是那条断言
实际上在检查 **memory 的路径表**。修法是从 `economyPolicy: {` 之后取。

**B13.17** 原先在**文件文本**上找 `inventory_count` / `provider_quota`，
而那几个词恰好出现在"报价表刻意没有这些列"的**解释注释**里。修法是先剥
注释（只剥注释，**不**剥字符串 —— 列名本身就在字符串里），再把列清单与
一份精确白名单逐列比对。这比 grep 一个词强：多一列就失败。

---

## 24. 测试

| 测试 | 结果 | 项数 |
|---|---|---|
| `test_p22_1_economy_domain_contract.js` | 全部通过 ✔ | 275（+32：D13.15 改述 + D-ADDITIVE-P22-4 组 31 项） |
| `test_p22_1_economy_boundary.js` | 全部通过 ✔ | 116（+19：B4.4 扩名单 + B13 组 18 项） |
| `test_p22_2_economy_store.js` | 全部通过 ✔ | 204（+1：`O9` 的可改表集合加上 P22-4 的两张规则/命题表） |
| `test_p22_2_economy_runtime.js` | 全部通过 ✔ | 67 |
| `test_p22_3_economy_reservation.js` | 全部通过 ✔ | 314（A1/M2/M8/M9 按 §16 改述） |
| `test_p22_3_economy_runtime.js` | 全部通过 ✔ | 56（A3/C2/D4 按 §16 改述） |
| **`test_p22_4_economy_budget.js`** | **全部通过 ✔** | **141** |
| **`test_p22_4_economy_quote.js`** | **全部通过 ✔** | **122** |
| **`test_p22_4_economy_runtime.js`** | **全部通过 ✔** | **48** |

### 24.1 P22-2/P22-3 的三处**有意修改**（每一处都让断言更强）

1. **`test_p22_2_economy_store.js` 的 `O9`**：可改表集合加上
   `BUDGET_POLICIES_TABLE` / `QUOTES_TABLE`，并注明"它们改的是规则与报价
   的状态，不是任何一笔已发生的经济事实；quotes 的金额/币种/买家不可变
   由 P22-4 的 E 组逐列断言"。**没有放松任何东西** —— 三个 ledger 事实表
   与 ACCOUNTS 仍然不在允许集合里，`O9b` 继续逐字断言。
2. **`test_p22_3_economy_reservation.js` 的 `A1` / `M2`**：写死的水位 `2`
   改成"等于本 build 声明的水位"。它们要问的是"水位有没有被一致地报告"，
   而那件事与具体数字无关；写死会让**下一次**抬水位的人被迫改一条与
   P22-3 无关的断言。"P22-3 自己抬到 2"仍由 M 组守着。
3. **`test_p22_3_economy_reservation.js` 的 `M8` / `M9`**：水位改成
   `SCHEMA_VERSION + 1`，造库方式从"先建全表再 DROP"改成"手工造的
   P22-2 代库"。**这是一条真实的加强** —— 旧写法里被 DROP 的表在抬水位
   之后会被重新补上，于是那条断言根本测不出 DDL 与水位检查的先后顺序；
   新写法逐表断言那**四张**表一张都没被创建。

---

## 25. 本阶段刻意**没有**做的事

```text
真正执行购买（purchase / acceptQuote / consumeQuote）     Approval workflow（创建 / 审批 / 拒绝）
product / inventory / store 目录（P22-5）                  Exchange 与汇率（P22-6）
compute 计价与消耗（P22-7）                                Decision / Action adapter（P22-8）
provider 适配 / provider 额度购买（P22-9）                 UI · 浏览器镜像（P22-11）
真实支付 / 充值 / provider 余额写路径                       CoinGecko 类外部价格源
第二个 Middle Brain · 第二份 provider metadata              第二套 revision / 第二份角色表
```

---

## 26. 给后续阶段的接入纪律

1. `tests/test_p22_1_economy_boundary.js` 的 `PRODUCTION_FILES`（新增文件
   必须登记，否则 B2 立刻失败）；
2. `tests/test-all.js` 的 `GROUPS`（新测试不登记就不会被任何回归跑到）；
3. `scripts/release-manifest.js`（若新模块被**启动链** require —— 目录规则
   已覆盖，由 B9 逐次复核）；
4. `services/home-node-service.js` 的 `createHttp({...})` 里那一次接线
   （P22-2 §13.2 的 501 就是漏了它）；
5. **`tests/test_p22_1_economy_boundary.js` 的 `B4.4` 名单**（新增会改状态
   的方法时，把方法名加进去 —— 那份名单是"http 层不得调用"的可执行形式）；
6. **`http.js` 的 `economyPolicy`**（新增"没有"的能力时，把它写成可断言
   字段；`unreachable` / `desktopPaths` / `*WritesExposed` 三张表跟着长）。

**P22-5（Product / Inventory / Store）的第一件事**应该是：把 `createQuote`
的 `productExists` 谓词接到真实的商品目录上（现在它由装配层注入，未注入
时不做校验），并打开 `reserveFunds` 的 `enforceBudget: true`。在那之前，
`Quote` 的 `productId` 是一个 canonical 但未被解析的引用。
