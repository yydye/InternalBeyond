# P22-1 · Agent Economy 领域契约（Frozen）

> 状态：**冻结**。实现：`services/home-node/economy-contract.js`（唯一真源）。
> 测试：`tests/test_p22_1_economy_domain_contract.js`、`tests/test_p22_1_economy_boundary.js`。
> 本阶段**不包含**任何运行时：没有 store、没有 SQLite、没有 credit/debit、
> 没有 HTTP 路由、没有商店 UI、没有 provider 接线、没有自主购买。

契约的唯一职责是回答：**「Economy 里的一个数、一个 id、一个状态、一个事件到底是什么？」**

---

## 0. 为什么本阶段必须先做契约

P22-0 审计（`docs/P22-0-ECONOMY-AUDIT.md`）发现仓库里**已经存在**一套真实支付域，
而且它已经占用了 Economy 最想要的那批词：

| 证据 | 位置 | 冲突 |
|---|---|---|
| `a.task.maxBudget` | `active/commerce.js:572`（`'候选均超过预算 ' + a.task.maxBudget + ' 元'`） | 单位是**元**，与虚拟预算无法区分 |
| `a.paymentIntent` | `active/commerce.js:528` | 通向真实收银台 |
| `commitSpend` | `bridge/pay-gate.js` | 真实支出记账 |
| `spawnSync('alipay-bot','submit-payment',...)` | `bridge/alipay-provider.js` | **真的**会发起支付 |

如果 Economy 也用裸的 `amount` / `budget` / `balance` / `currency`，
虚拟经济与现实货币会在**类型层面**无法区分，而这个污染在测试里**看起来会是绿的**
（两边各自都自洽）。本契约因此把两件事钉死：

1. 跨模块 payload / event / persistence record 必须带 `domain` 标记，取值恒为
   `'ib.economy'`；缺标记一律拒绝。
2. 真实货币与 provider 余额**不是** Economy currency —— 它们是
   `FORBIDDEN_CURRENCY_TOKENS`，被逐字否认。

---

## 1. 域标记与命名空间

```js
DOMAIN = 'ib.economy'
```

`validateEconomyDomain(v)` 只接受恰好等于 `DOMAIN` 的值；`'ib.payment'` / `'economy'` / `''` / `undefined`
全部返回 `['missing-economy-domain']`。

子命名空间（`NAMESPACES`）：`wallet / transaction / ledger / reservation / budget / store /
inventory / exchange / compute / quote / event / audit`，各自以 `ib.economy.` 为前缀。

**规则**：任何离开 Economy 边界的对象都必须能**在不看上下文字段名**的情况下判断归属。
所有构造器（wallet view / ledger entry / event / audit record）都会写入 `domain: DOMAIN`。

---

## 2. Canonical Currency IDs

```js
CURRENCY = {
  IB_CREDIT, ACTIVITY_POINT, COMPUTE_STANDARD, COMPUTE_PREMIUM, IMAGE_CREDIT, VOICE_CREDIT
}
```

| currency | scale（1 展示单位 = N minor unit） | 含义 |
|---|---|---|
| `IB_CREDIT` | 100 | 通用虚拟余额 |
| `ACTIVITY_POINT` | 100 | 活动积分（兑换来源） |
| `COMPUTE_STANDARD` | **1** | 标准算力额度（粒度天然是"一次调用"） |
| `COMPUTE_PREMIUM` | **1** | 高级算力额度 |
| `IMAGE_CREDIT` | 1 | 图像生成额度 |
| `VOICE_CREDIT` | 1 | 语音额度 |

`scale` 是**币种自身**的属性，不是全局常量。把 COMPUTE 的 scale 也设成 100
只会制造「0.01 次付费调用」这种无意义的可表示状态。

### 2.1 硬边界

```
IB_CREDIT != CNY
IB_CREDIT != USD
IB_CREDIT != crypto
IB_CREDIT != provider balance
COMPUTE_PREMIUM != provider credits
```

`isForbiddenCurrencyToken` 逐字否认三组：

- **法币**：`CNY RMB USD EUR GBP JPY HKD TWD KRW AUD CAD CHF SGD USDT USDC BTC ETH`
- **符号**：`$ ¥ ￥ € £ ₩ ₿`
- **provider 余额/代币**：`TOKEN(S) VIRTUAL_TOKEN PROVIDER_BALANCE PROVIDER_CREDITS API_CREDITS
  OPENAI_BALANCE ANTHROPIC_BALANCE DEEPSEEK_BALANCE QWEN_BALANCE GEMINI_BALANCE`

### 2.2 两道闸门的分工（这是刻意的设计）

| 闸门 | 负责回答 | 例子 |
|---|---|---|
| deny-list（`isForbiddenCurrencyToken`） | **这是不是真实货币 / provider 余额？** | `USD` → 否认 |
| whitelist（`CURRENCY` 注册表） | **这是不是我们注册的虚拟资源？** | `GOLD_COIN` → 未注册，拒绝 |

`validateCurrency` 的判定顺序是 **先否认、再白名单**。顺序反了的话，
未来把 `USD` 加进白名单就会静默通过；先否认则不会。

currency 的否认是**精确匹配**（大小写不敏感），刻意不做"分隔符归一化"：
`'u-s-d'` 与 `'USD'` 不是同一个 token，把它模糊映射成 `USD` 意味着存在一条
token → USD 的映射，而那条映射在防漏的同时也会开始误伤（任何含 `usd`
子串的合法自造币种都会被吞掉）。含空白的 token（`'U S D'`）被直接否认。

**测试证据**：D2.1–D2.16。

---

## 3. Monetary Representation

| 层 | 表示 | 符号 |
|---|---|---|
| runtime（canonical 计算） | **BigInt** | `AMOUNT_RUNTIME_TYPE = 'bigint'` |
| JSON 序列化 | **十进制字符串** | `AMOUNT_SERIALIZED_TYPE = 'decimal-string'` |
| SQLite（P22-2） | `INTEGER` | `AMOUNT_SQLITE_TYPE = 'INTEGER'` |

**禁止浮点承担 canonical 余额计算。** 理由不是洁癖：`0.1 + 0.2` 类误差进入 ledger
之后，"总账守恒"这条不变量会以极低概率、极难复现的方式失败，而失败的表现是
**"钱变多了/少了"**。

```js
MAX_AMOUNT_MINOR = 9007199254740991   // Number.MAX_SAFE_INTEGER
MIN_AMOUNT_MINOR = 0
```

上界取**安全整数**而不是 64 位：SQLite INTEGER 能装 64 位，但浏览器侧最终会有
`number` 出现（渲染、比较），于是"canonical 能表示的"必须 ⊆ "JS 能精确表示的"。

### 3.1 唯一转换入口

- `normalizeAmountMinor(value)` → `{ ok, amountMinor: BigInt, errors }`
- `serializeAmountMinor(value)` → 十进制字符串或 `null`
- `toDisplayParts(value, currency)` → `{ whole, fractionText, scale }`

**拒绝**：`NaN` / `±Infinity` / 小数 / 超出安全整数 / 负数 / `'+1'` / `'1.0'` /
`'1e3'` / `'0x10'` / `'1,000'` / `''` / 非 `string|number|bigint` 类型。
**接受**：BigInt、安全非负整数、十进制整数字符串（允许前导零，允许两侧空白）。

`JSON.stringify` **不能**序列化 BigInt，因此序列化必须显式走 `serializeAmountMinor()`。
这是刻意的：静默地把它变成 `number` 正是要防的那件事。

**所有 ledger / budget / exchange 后续阶段共用这一套规则。禁止每个模块自己 round。**

**测试证据**：D3.1–D3.19（含 `0.1+0.2 !== 0.3` 这条把存在理由固定下来的断言）。

---

## 4. Canonical IDs

```js
ID_PREFIX = {
  WALLET:          'econ_wallet_',
  ACCOUNT:         'econ_account_',
  TRANSACTION:     'econ_tx_',
  LEDGER_ENTRY:    'econ_entry_',
  RESERVATION:     'econ_res_',
  BUDGET_POLICY:   'econ_policy_',
  PRODUCT:         'econ_product_',
  INVENTORY_ENTRY: 'econ_inv_',
  QUOTE:           'econ_quote_',
  EXCHANGE_RATE:   'econ_rate_',
  PURCHASE_INTENT: 'econ_intent_',
  EVENT:           'econ_evt_'
}
```

- 风格对齐既有习惯（`chat-core` 的 `msg_*`、`role-dm-core` 的 `roleDm_` / `roledmmsg_` / `roleRel_`）：
  小写 + 下划线 + `econ_` 命名空间首段，于是"这是虚拟经济的东西"在**看 id 的第一眼**就成立。
- suffix 语法 `[A-Za-z0-9_-]{1,64}`，全长上限 128。
- 前缀互不为彼此的前缀（`econ_tx_` 不会误吞别的种类）。
- `isEconomyId(kind, v)` **认种类**：`econ_wallet_w1` 不是合法 `TRANSACTION`。
  真实支付 / 聊天 / 关系的 id（`pay_123` / `msg_123` / `roleRel_abc`）一律不通过。

### 4.1 生成归属

契约**只冻结形状**，不提供 `makeXId()` 随机生成器 —— 随机源属于运行时（P22-2）。
这样契约就是纯函数、可枚举、可被测试穷举，也没有随机源。

### 4.2 `transactionId` ≠ `idempotencyKey`（重点）

```
transactionId    = 一笔已创建 transaction 的身份（一个**经济事实**）
idempotencyKey   = "这次业务请求是否已经执行过"的身份（一个**重试问题**）
```

一笔 transaction 只有一个交易 id；同一个业务请求重试时会带着**同一个**
`idempotencyKey` 再来，而正确结果是**返回原来那笔 transaction**，不是再记一笔。
把两者合成一个字段，就等于**把"重试"变成"再买一次"**。

这正是 `services/home-node/chat-store.js:140` 的 `idempotency` 表
（`requestId → userMessageId`）已经解决过的同一类问题；Economy 沿用其**语义**，
不复用其表。

`normalizeIdempotencyKey` 把数字与字符串都规范化成**字符串**——否则 `123` 与 `'123'`
会被判成两个 key，幂等性在类型边界上静默失效。

**测试证据**：D10.1–D10.5、D11.1–D11.8。

---

## 5. Actor / Owner / Counterparty / Recipient

canonical party reference 是**判别式对象**，不是裸字符串：

```js
{ type: 'character' | 'user' | 'system', id: '<string>' }
```

`PARTY_TYPE` 的**值**（小写）才是 canonical token —— 与 `moments.js:311`
的既有作者模型（`user | role` + `authorId`）同构，不新造第三个身份词汇表。

| 名字 | 回答的问题 |
|---|---|
| `actorId` | **谁发起了**这次经济操作（花的是它的钱/它的授权） |
| `ownerId` | **这笔资源 / 这个钱包属于谁** |
| `counterpartyId` | 记账对手方（复式记账的另一端） |
| `recipientId` | 购买是为了**给谁**（gift 的收礼人；自用则为 `null`） |

≤2 人场景下它们经常取值相同，但**"经常相同"不等于"是同一件事"**：
gift 把 `buyer(actor=owner)` 与 `recipient` 分开，MINT 把 `actor` 与
`counterparty(= system:mint)` 分开。

### 5.1 用户身份的表示

```
USER_PARTY_ID = 'user'
```

依据是**既有** production 语义，不是 Economy 发明的：

- `assets/js/memory-contract.js:78` `ownerIdOf()` 缺省返回 `'user'`
- `assets/js/moments.js:500` `authorId` 缺省 `'user'`

`makePartyRef('user', 'me')` / `('user','self')` **被拒绝**。
`promotePartyRef('user')` 提升成 `{type:'user', id:'user'}` —— **不是**
`{type:'character', id:'user'}`；后者会创造一个名叫 "user" 的**角色**，
于是"送给用户"在账本里变成"送给一个名字叫 user 的角色"，两者在数据上无法区分，
而语义完全不同。

### 5.2 system account 白名单

```js
SYSTEM_ACCOUNT = {
  MINT:     'system:mint',
  BURN:     'system:burn',
  TREASURY: 'system:treasury',
  MARKET:   'system:market'
}
```

**运行时（尤其 LLM）不得创建新的 system account。** 可执行形式：
`validateSystemAccountId` 只认这张表，没有第三种可能。

**测试证据**：D4.1–D4.10（含 `'me'` / `'self'` / `'system?'` 全部被拒）。

---

## 6. Wallet State Contract（P22-0 R5 的落点）

```js
WALLET_STATE = { COLD, READY, DEGRADED }
```

```
COLD     还没 hydrate：余额未知（≠ 0）
READY    canonical 已确认：余额可信
DEGRADED canonical 不可达：余额不可信（≠ 0）
```

**这是 P22-0 R5 的根因所在**：镜像冷启动读到空数据 → 被当成 `balance = 0` →
一笔凭空的交易。三态的存在就是为了让**"我不知道余额"有一个可表示的答案**，
而不是被迫借用 `0`。

```js
{
  walletId, owner, currency,
  cachedBalanceMinor,      // 缓存，不是事实源
  reservedBalanceMinor,    // 被 reservation 占用
  availableBalanceMinor,   // **派生**值：cached − reserved（READY 时），否则 null
  state, revision, createdAt, updatedAt
}
```

### 6.1 不可协商的规则

| 规则 | 可执行形式 |
|---|---|
| COLD ≠ 0 | `makeWalletView({state:'COLD'}).wallet.availableBalanceMinor === null` |
| DEGRADED ≠ 0 | 同上，即使 `cachedBalanceMinor = 9999` 也返回 `null` |
| 只有 READY 允许花费 | `walletStateAllowsSpend(state) === (state === 'READY')`，未知状态一律 `false`（fail closed） |
| `available` 是派生值 | 契约不存它；COLD/DEGRADED 下必须是 `null`，因为"未知减已知"仍是未知 |
| reserved 不得超过 cached | `'reserved-exceeds-cached-balance'` |

**canonical financial truth 来自 Ledger**（P22-2）。Wallet balance 只是缓存，
且**必须能从 Ledger 重建**。任何写路径都不得以缓存 balance 为输入来算新余额 ——
否则缓存漂移会变成真实经济错误。

**测试证据**：D5.1–D5.12。

---

## 7. Transaction State Machine

```js
TX_STATE = { CREATED, RESERVED, COMMITTED, RELEASED, EXPIRED, FAILED }
```

```
CREATED  → RESERVED | FAILED
RESERVED → COMMITTED | RELEASED | EXPIRED | FAILED
COMMITTED → ∅   （终态）
RELEASED  → ∅   （终态）
EXPIRED   → ∅   （终态）
FAILED    → ∅   （终态）
```

**禁止**：`COMMITTED → CREATED`、`COMMITTED → RELEASED`、以及**任何**终态回退。

要撤销一笔已提交的交易，只能记一笔**补偿 transaction**，而不是改历史。
这条规则就是"append-only 思维"在状态机上的形状。

### 7.1 为什么 EXPIRED 与 RELEASED 分开

两者都"把钱还回去了"，但原因不同：`RELEASED` 是流程主动放弃（action 失败、用户取消），
`EXPIRED` 是时间到了（reservation TTL）。合并会让"为什么这笔没成交"无法回答，
而 P22 §16 要求这个问题**必须可回答**。

### 7.2 交易类型

```js
TX_TYPE = { PURCHASE, GIFT, EXCHANGE, MINT, BURN, COMPUTE_GRANT, COMPUTE_CONSUME, REFUND }
```

只有 `MINT` / `BURN` 免除双向记账拓扑（`requiresBalanceTopology(type) === false`），
且它们必须显式命名，counterparty 必须是 `system:mint` / `system:burn`。
于是**"凭空增发"要么是一次写明的 MINT，要么是 ledger 不平衡（被拒绝）。没有第三条路。**

`assertTransactionTransition` 的失败信息区分两种情形：
- 终态回退 → `detail: 'terminal-state-cannot-transition-must-compensate-with-a-new-transaction'`
- 其它非法 → `detail: 'transition-not-in-allowed-set'`

**测试证据**：D6.1–D6.10。

---

## 8. Ledger Contract

**冻结一种表示，刻意不支持第二种：**

```
direction: 'DEBIT' | 'CREDIT'      （对称）
amountMinor: 无符号 BigInt          （LEDGER_AMOUNT_SIGN = 'unsigned'）
```

同时允许 signed 与 unsigned 两种 canonical 表示，就必然出现"一半代码按符号读、
一半按方向读"的状态，而**两边的测试都会绿**。

### 8.1 平衡规则

```
sum(DEBIT.amountMinor) === sum(CREDIT.amountMinor)    per currency
```

**逐 currency 分别平衡**：跨 currency 求和是错的 —— 那会让
`100 IB_CREDIT + 20 COMPUTE_PREMIUM` 看起来平衡。

### 8.2 单边 entry 被拒绝

即使"debit 0 == credit 0"，单条 entry 也算不平衡（`'ledger-needs-at-least-two-entries'`），
避免"只写了一半"看起来像一笔合法交易。

### 8.3 LedgerEntry

```js
{ ledgerEntryId, transactionId, accountId, direction, amountMinor, currency, domain }
```

### 8.4 Wallet 与 Ledger Account 的分层

| 概念 | 是什么 |
|---|---|
| **Wallet** | 面向 Agent / 用户的**聚合**概念（一个 owner + 一个 currency 一个钱包） |
| **Ledger Account** | **记账实体**（复式记账的一端） |

两者的关系不是 1:1：gift 让两个 wallet account 相对记账，MINT 让一个 wallet account
与 `system:mint` 相对记账。把两者混成一个东西，就会出现"`system:mint` 也是一个钱包"
这种没有 owner 的钱包。

`ACCOUNT_KIND = { WALLET, SYSTEM }`；`accountKindOf('system:mint') === 'SYSTEM'`、
`accountKindOf('econ_account_w1') === 'WALLET'`、其它一律 `null`。

**测试证据**：D7.1–D7.14、D8.1–D8.4。

---

## 9. Reservation Contract

```js
{ reservationId, walletId, currency, amountMinor, idempotencyKey,
  expiresAt, status, transactionId, createdAt, updatedAt }

RESERVATION_STATE = { ACTIVE, COMMITTED, RELEASED, EXPIRED }
```

```
reservation != transaction
   transaction 是**经济事实**（钱动了没有、动去哪了）
   reservation 是**暂时占用**（钱先别花，我可能要用）
```

一笔 COMMITTED transaction 恰好对应一次成功 commit 的 reservation；但 reservation
会过期、会释放，而 transaction 不会 —— 因此 reservation 有自己的状态与生命周期，
**不能折叠进 transaction**。

### 9.1 reserved 对 available 的影响

```
availableBalanceMinor = cachedBalanceMinor - reservedBalanceMinor   （仅 READY）
```

这是**派生**规则，不是存储字段。P22-2 必须照此实现。

**测试证据**：D9.1–D9.6。

---

## 10. Budget Policy Contract

**最关键规则：Budget Policy 的输入必须是确定性结构化数据。**

```js
BUDGET_INPUT_KEYS = [
  actorId, ownerId, recipientId, productId, category,
  amountMinor, currency, quantity, usage, limits,
  timestamp, autonomyLevel, walletState
]
```

### 10.1 禁止的输入

```
raw LLM output / prompt / persona text / relationship prose
```

实现方式**不是**"记得别传正文"，而是**拒绝一切未在白名单里的键**：

```js
FORBIDDEN_POLICY_INPUT_KEYS = [
  prompt, system, systemPrompt, persona, personality, mood,
  relationship, message, messages, content, text, reply,
  llmOutput, modelOutput, completion, rawOutput, reasoning,
  thoughts, narration, desire, plea, argument
]
```

未知键 → `'policy-input-key-not-whitelisted'`；
已知污染键 → `'policy-input-carries-non-deterministic-text'`。

这条比"点名禁止 `prompt`"强得多：它同时挡住了未来任何新的正文字段（以及拼错的白名单键）。

> **P22 §7 的要求**：`LLM: "I really want this."` / `Policy: DENIED_BUDGET`
> 结果必须仍然是拒绝。本契约让这句话在**类型层面**成立：
> 那段文字根本没有地方可以放进去。

`usage` 是"已经花了多少"的只读快照，其值必须是标量且不得是嵌套对象；
`limits` 的键受白名单约束（`BUDGET_LIMIT_KEYS`），值必须是金额。

### 10.2 limits 的键（= P22 §7 的那张表）

```
availableBalanceMinor  perTransactionMinor  dailyMinor  weeklyMinor  monthlyMinor
categoryMinor          recipientMinor       autonomousSpendMinor
emergencyReserveMinor  approvalThresholdMinor
cooldownMs（**时长**，不是金额，单独受理）
```

`cooldownMs` 刻意不在 `BUDGET_LIMIT_KEYS` 里：把 `90000ms` 当 amountMinor 处理会让
"冷却"与"限额"在类型上混起来。

### 10.3 `AUTONOMY_LEVEL = { NONE, LIMITED, STANDARD, ELEVATED }`

**测试证据**：D13.1–D13.19（含 8 条正文污染反例）。

---

## 11. Approval Contract

```js
APPROVAL = { AUTO_APPROVED, USER_APPROVAL_REQUIRED, DENIED }
```

**刻意不是 `true` / `false`** —— 后续要表达"需要用户确认"时，布尔值无处可放，
而那时再改结构就是破坏性变更。

`DENIED` **必须**带稳定 reason code，且 reason code 是**封闭集合**
（`DENY_REASON`，28 个）。**UI 文案不能成为 canonical reason。**

关键条款：**没有 `OTHER` / `UNKNOWN` / `ERROR` 兜底值** ——
兜底值会让静默拒绝重新变得可能。

```js
DENY_REASON = {
  INSUFFICIENT_BALANCE, PER_TX_LIMIT, DAILY_LIMIT, WEEKLY_LIMIT, MONTHLY_LIMIT,
  CATEGORY_LIMIT, RECIPIENT_LIMIT, AUTONOMY_LIMIT, COOLDOWN_ACTIVE, EMERGENCY_RESERVE,
  WALLET_NOT_READY, PRODUCT_DISABLED, PRODUCT_OUT_OF_STOCK, INVALID_CURRENCY,
  INVALID_AMOUNT, QUOTE_EXPIRED, QUOTE_MISMATCH, RESERVATION_EXPIRED,
  DUPLICATE_REQUEST, TRANSITION_NOT_ALLOWED, LEDGER_UNBALANCED, EFFECT_NOT_ALLOWED,
  PARTY_NOT_ALLOWED, ACCOUNT_NOT_ALLOWED, AUTONOMY_NOT_PERMITTED,
  INSUFFICIENT_COMPUTE_CREDIT, EXCHANGE_RATE_UNKNOWN, EXCHANGE_ROUNDS_TO_ZERO,
  EXCHANGE_CROSS_DOMAIN_FORBIDDEN, POLICY_INPUT_NOT_STRUCTURED
}
```

**测试证据**：D12.1–D12.10。

---

## 12. Quote Contract

```js
{ quoteId, productId, buyerId, recipientId?, currency, amountMinor,
  quantity, rateVersion?, expiresAt, createdAt, state }

QUOTE_STATE = { OPEN, CONSUMED, EXPIRED }
```

Quote 存在就是为了**消灭**这个序列：

```
check price = 50  →  price changes  →  commit 80
```

因此购买流程必须**消费** quote，而不是在 commit 时重新读 price
（P22 §16）。`expiresAt` 是必需的，不是摆设。

**测试证据**：D15.1–D15.7。

---

## 13. Product Effect Contract

**Product 里不允许出现任意 JS / function / code。**
商品 effect 是**数据**，由 Economy 解释，不由商品自己执行。

```js
EFFECT_TYPE = {
  GRANT_INVENTORY, GRANT_COMPUTE_STANDARD, GRANT_COMPUTE_PREMIUM,
  GRANT_IMAGE_CREDIT, GRANT_VOICE_CREDIT
}
```

`EFFECT_CURRENCY` 给出唯一的 effect → currency 映射（商品里**不**重复写）：

| effect | 授予 |
|---|---|
| `GRANT_INVENTORY` | 无 currency（走 inventory 域） |
| `GRANT_COMPUTE_STANDARD` | `COMPUTE_STANDARD` |
| `GRANT_COMPUTE_PREMIUM` | `COMPUTE_PREMIUM` |
| `GRANT_IMAGE_CREDIT` | `IMAGE_CREDIT` |
| `GRANT_VOICE_CREDIT` | `VOICE_CREDIT` |

### 13.1 逐字否认的 effect 名

```
Memory      : MODIFY_MEMORY  WRITE_MEMORY  CREATE_MEMORY  MEMORY
Relationship: MODIFY_RELATIONSHIP  AFFECTION  TRUST  AFFINITY  RELATIONSHIP
Provider    : CALL_PROVIDER  PROVIDER_CALL  TOP_UP_PROVIDER  PROVIDER_TOPUP
              PROVIDER_BALANCE  SET_PROVIDER_BALANCE  PURCHASE_PROVIDER_CREDITS
凭据        : CHANGE_API_KEY  SET_API_KEY  READ_API_KEY  API_KEY
真实支付    : SEND_PAYMENT  PAY  CHECKOUT  REAL_PURCHASE  FIAT_PURCHASE
网络/执行   : WEBHOOK  HTTP_REQUEST  FETCH  EXEC  EVAL  FUNCTION  CALLBACK  CODE  SCRIPT
```

`isForbiddenEffectName` 做分隔符归一化，于是 `'top-up-provider'` / `'TOP UP PROVIDER'`
都绕不过否认。

### 13.2 effect 的键也受白名单约束

只允许 `type / amountMinor / quantity / productId / metadata`。
未知键一律拒绝 —— 这挡住了 `{type:'GRANT_COMPUTE_PREMIUM', run:'...'}` 这类
"用数据字段夹带行为"的写法。

`effect.metadata` 不得含函数、不得含凭据类键名。

**测试证据**：D16.1–D16.15（含 Memory / Relationship / Provider / 支付 / 代码五类反例）。

---

## 14. Compute Credit Contract

```js
COMPUTE_TIER = { STANDARD: 'COMPUTE_STANDARD', PREMIUM: 'COMPUTE_PREMIUM' }
COMPUTE_UNIT_NAME = 'computeUnit'
COMPUTE_CONSUME_COUNTERPARTY = 'system:treasury'
```

Compute Credits **只表示**：IB 内部允许 Agent 使用**某类**计算资源的预算。

它**不表示**：

```
OpenAI balance / Anthropic balance / DeepSeek balance / Qwen balance
USD balance / token ownership at provider
```

### 14.1 刻意不引入 `virtualToken`

P22 §18 建议直接避免 —— 它与 provider 上报的 token usage 是**不同量纲**的东西，
同名必然导致误接。若将来确需一个抽象计量单位，名字是 `computeUnits`
（1 minor unit = 1 computeUnit），**不是** `tokens`。

`FORBIDDEN_COMPUTE_ALIASES` 逐字否认：`token(s)` / `virtualToken(s)` /
`providerToken(s)` / `openaiToken` / `anthropicToken` / `usd` / `cny` / `balance` /
`providerBalance` / `providerCredit(s)` / `apiCredit(s)` / `realCredit(s)`。

### 14.2 消耗算力的记账

一次消耗是 `COMPUTE_CONSUME` transaction，从 actor 的 compute currency account
流向 `system:treasury`。它**不**写 provider，也**不**减少任何 provider 余额。

**测试证据**：D17.1–D17.9。

---

## 15. Exchange Rate Contract

**兑换率是有理数，不是浮点。** 理由与 §3 同源：`0.2` 表示不了 `1/5`，
而汇率一旦进入 ledger，"总共换出去多少"就必须精确。

```js
{ exchangeRateId, fromCurrency, toCurrency, rateNumerator, rateDenominator, version }

creditAmount = floor(debitAmount * rateNumerator / rateDenominator)
```

`EXCHANGE_ROUNDING = 'floor-toward-zero-favoring-the-house'`。

**取 floor 而不是四舍五入**：舍入方向永远对用户不利，于是
**"舍入套利"不可能存在** —— 小额兑换宁可失败（`EXCHANGE_ROUNDS_TO_ZERO`）
也不产生免费收益。

- 分子/分母必须是正整数；from 与 to 必须不同。
- `version` 必须是正整数（汇率可版本化、可追踪用了哪一版）。
- 法币与 provider 余额**无法**出现在任何一端（`validateCurrency` 那里就已经过不去，
  `computeExchangeAmount` 是第二道显式闸门，给出 `EXCHANGE_CROSS_DOMAIN_FORBIDDEN`）。

**测试证据**：D18.1–D18.13（含 `100 ACTIVITY_POINT → 20 IB_CREDIT` = ratio `20/100`）。

---

## 16. Economy Event Contract

**Economy Event 是事实事件，不是 Memory。**

Economy 只**产出**事件；是否形成长期记忆由现有 Memory / Memory Consolidation
决定，关系是否变化由 Relationship 决定。因此 envelope 里**没有、也不允许有**
记忆或关系字段。

```js
EVENT_ENVELOPE_KEYS = [
  domain, economyEventId, eventType, timestamp,
  actor, subject, transactionId, productId, metadata
]
```

```js
EVENT_TYPE = {
  WALLET_OPENED, TRANSACTION_CREATED, RESERVATION_CREATED, RESERVATION_RELEASED,
  RESERVATION_EXPIRED, PURCHASE_COMMITTED, PURCHASE_DENIED, ITEM_GIFTED,
  ITEM_CONSUMED, COMPUTE_CREDIT_GRANTED, COMPUTE_CREDIT_CONSUMED,
  EXCHANGE_COMMITTED, MINT_COMMITTED, BURN_COMMITTED
}
```

事件类型是**封闭集合**（`isEconomyEventType`），未登记即拒绝。

envelope 的 metadata 约束：值必须是标量、不得含函数、不得含凭据类键名、
字符串不得超过 400 字符（**事实事件不是日记** —— 超过这个长度基本就是把
prompt / 回复塞进来了）。

**测试证据**：D19.1–D19.14。

---

## 17. Audit Contract

**Audit 与 debug log 分开。** 当前 IB **没有** canonical `decisionId` / `actionId`
（P22-0 §4/§5 的检索结果为空）。因此本契约**不发明**它们，只用 opaque 的
correlation ref：

```js
{ domain, economyEventId, timestamp, actor, operation,
  decisionRef?, actionRef?,                  // opaque correlation，可为 null
  purchaseIntentId?, quoteId?, reservationId?, transactionId?, productId?, walletId?,
  policyDecision?, reasonCode? }
```

**只有当现有 runtime 能稳定提供时才记录 `decisionRef` / `actionRef`，
否则为 `null`。不得为了填这两个字段去重构 Decision / Action。**

这与 integration 侧的既有做法一致：`active-plans.js` 的 `intent` 是可关联的
既有载荷，而它**没有 id**，所以 Economy 只能存一个引用串。

`operation` 是封闭集合（`AUDIT_OPERATION`，11 项）；`policyDecision` 只能是三态之一；
`reasonCode` 只能是封闭集合内。

**测试证据**：D20.1–D20.10。

---

## 18. Cross-domain Dependency Matrix

矩阵是**数据**（`DEPENDENCY_MATRIX`），不是注释 —— boundary 测试直接遍历它逐行断言。

| from | to | rule |
|---|---|---|
| Economy | Memory | `FORBIDDEN_WRITE` |
| Economy | Relationship | `FORBIDDEN_WRITE` |
| Economy | RealPayment | `FORBIDDEN` |
| Economy | CredentialVault | `FORBIDDEN` |
| Economy | ProviderBilling | `FORBIDDEN` |
| Economy | ProviderMetadata | `READ_ONLY_VIA_CANONICAL_API` |
| Economy | CharacterIdentity | `READ_ONLY` |
| Economy | ExistingAction | `ADAPTER_ONLY` |
| Memory | EconomyEvents | `EVENT_CONSUMER_OPTIONAL` |
| Relationship | EconomyEvents | `EVENT_CONSUMER_OPTIONAL` |
| ProviderTelemetry | Economy | `READ_ONLY_TELEMETRY` |

依赖方向被写成一条可验证的性质：

```
Provider telemetry  →  Economy          （只读）
Economy             ✗→ Provider billing （不存在）
```

**测试证据**：D21.1–D21.5 + boundary B3–B4。

---

## 19. 依赖边界如何被强制（P22-0 R1）

契约文件本身**不能**证明生产代码守规矩。强制分三层：

### 19.1 声明式清单

```js
BOUNDARY_FORBIDDEN_MODULES = [
  'bridge/pay-gate.js', 'bridge/alipay-provider.js', 'bridge/payment-provider.js',
  'active/payment-auth.js', 'active/shopping-execution.js', 'active/credential-vault.js',
  'active/commerce.js', 'assets/js/commerce-adapter.js',
  'assets/js/shopping-review.js', 'assets/js/payment-settings.js'
]
BOUNDARY_FORBIDDEN_IDENTIFIERS = [
  'topUpProvider', 'purchaseProviderCredits', 'updateProviderBalance',
  'providerPayment', 'providerBillingMutation', 'purchaseRealCredits',
  'sendPayment', 'submitPayment', 'submit_payment', 'commitSpend',
  'pay_register_checkout', 'pay_set_config', 'pay_request_confirm'
]
BOUNDARY_ALLOWED_MODULE_PREFIXES = [
  'node:', 'services/home-node/economy-', './economy-', './economy/', '../economy/'
]
```

### 19.2 `tests/test_p22_1_economy_boundary.js` 的四道闸门

| 组 | 检查什么 |
|---|---|
| **B1** | 契约模块载入期零 require / 零 I/O / 零时钟 / 零随机 / 运行期中立 |
| **B2** | Economy **生产文件清单**与磁盘一致（新增文件必须登记，否则边界检查漏过它） |
| **B3** | 从这些文件扫出的**每一个 `require` 目标**都必须落在允许前缀内（白名单，不是黑名单），且不得命中禁止清单 |
| **B4** | **反向边**也不存在：支付/购物模块不 require Economy；启动链（`home-node-service.js` / `http.js` / `execution.js` / runner）不 require Economy |
| **B5** | P22 §21 的写动词在任何 Economy 文件里都以**标识符**形态不存在（注释/字符串不算） |
| **B6** | 凭据边界：不引用 `character_runtime_specs`、不读 `Authorization`/`Bearer`、party 闭集里没有 provider/credential 身份 |
| **B7** | Memory / Relationship / Middle Brain / Provider Router / 工具执行面均不在 require 闭包里；源码不出现 `affection`/`affinity` 或 `trust +=` 形态 |
| **B8** | P22-0 R2：真实购物 `maxBudget` 被列为冲突键并**被 Policy 输入拒绝** |
| **B9** | P22-0 R4：Economy 文件及其 require 目标**真的进得了发行包**（release manifest 逐文件白名单） |
| **B10** | 以上检查的**输入**本身存在（否认清单非空、被禁模块真实存在）—— 否则前面的断言在保护空气 |

### 19.3 为什么"正向 + 反向"两条都要有

只有反向断言（"不 require 禁止模块"）的话，Economy 悄悄 require 一个**新**模块
不会被发现。因此 B3 是**白名单**：任何不在允许前缀里的 `require` 目标都失败。

### 19.4 一条诚实的限制

B5 的标识符扫描先剥掉注释与字符串字面量。一个**刻意**把写动词写成字符串
（`const op = 'topUpProvider'`）的实现可以绕开这一步。这条限制写在断言的名字里
（"以**标识符**形态不存在"），不藏在注释里。真正的兜底是 B3/B4 的依赖闭包：
即使有人把动词写成字符串，他也必须先 `require` 到某个能碰 provider 的模块，
而那一步会被 B3 拦住。

---

## 20. P22-0 四条风险分别如何被契约锁住

| 风险 | 契约落点 | 可执行证据 |
|---|---|---|
| **R1** Economy → Provider Billing 写路径 | `DEPENDENCY_MATRIX` 的 `Economy→ProviderBilling = FORBIDDEN`；`BOUNDARY_FORBIDDEN_MODULES` / `BOUNDARY_FORBIDDEN_IDENTIFIERS`；`FORBIDDEN_COMPUTE_ALIASES` | D17.5–D17.7、D21.3–D21.5、boundary B3–B5 |
| **R2** 真实购物 `maxBudget`（单位=元）命名冲突 | `REAL_COMMERCE_COLLIDING_KEYS` / `isRealCommerceKey`；Budget 输入白名单拒绝未知键；`BUDGET_LIMIT_KEYS` 全部带 `Minor` 后缀（字形不同族） | D14.1–D14.5、D13.4–D13.6、boundary B8.1–B8.5 |
| **R4** release manifest 逐文件白名单 | `BOUNDARY_ALLOWED_MODULE_PREFIXES` + boundary B9 真实调用 `release-manifest.resolve({})` 并断言每个 Economy 文件**及其 require 目标**都在 `files[].to` 里 | boundary B9.1–B9.4 |
| **R5** cold/hydrate 被当成零余额 | `WALLET_STATE = {COLD, READY, DEGRADED}`；`walletStateAllowsSpend`；`makeWalletView` 在非 READY 下让 `availableBalanceMinor === null` | D5.1–D5.12 |

---

## 21. 本阶段刻意**没有**做的事

```
createEconomyStore()      openEconomyStore()      wallet credit/debit
SQLite schema             /economy HTTP 路由      商店 UI
provider routing          自主购买                 第二个 Middle Brain
第二份 provider metadata   第二份角色表             virtualToken
realCostUsd 作为可消费余额
```

Economy 生产文件只有 **1 个**（契约），require 目标 **0 个**。
`services/home-node/economy/` 目录刻意**尚未创建**。

---

## 22. P22-1 的接入纪律（给后续阶段）

契约是运行期中立（UMD 双载、零 require、零 I/O、零时钟、零随机），
因此 P22-2 起它可以被两侧共用。但**物理位置**在 `services/home-node/`，
而 `test_frontend_structure.js` 的 BOM 断言只覆盖 `assets/css` / `assets/js` / `game`。

**因此**：当 P22-8 / P22-11 需要浏览器侧真的 `require`/`<script>` 它时，
必须先决定"是加一个 `assets/js/economy-contract.js` 桥文件，还是把契约物理移入
`assets/js/`（并补 UTF-8 BOM）"。**在那一天到来之前不要动**（本阶段也不需要）。

P22-2 起每加一个 Economy 生产文件，必须同步三处：

1. `tests/test_p22_1_economy_boundary.js` 的 `PRODUCTION_FILES` 清单；
2. `tests/test-all.js` 的 `GROUPS`（新测试不登记就不会被任何回归跑到）；
3. `scripts/release-manifest.js`（若新模块被**启动链** require —— `{from:'services/home-node',dir:true}`
   已覆盖该目录及其任意子目录，故正常无需改动；这条判断由 boundary B9 逐次复核）。
