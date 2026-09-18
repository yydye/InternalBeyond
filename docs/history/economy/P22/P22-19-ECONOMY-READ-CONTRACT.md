# P22-19 · Economy Read Model & Owner Scope Closure

基线 `7ab1d57`（P22-18）· 提交名 **`P22-19 · close Economy owner-scoped read model`**

> **本阶段不是新增 Economy 功能。**
> 它把"一条 change 属于谁"从浏览器解释层收回到 canonical 的只读 query 里，
> 并把 Economy 的只读契约冻结成机器可检查的东西。

```text
生产改动：2 个文件（economy-store.js · http.js）· 零新路由 · 零新表 · 零 schema 迁移
UI 改动：2 个文件（economy-shell-core.js · economy-shell.js）· 结构/类名/节点顺序逐字未变
```

---

## §1 · Read Authority Audit

穷举当前 Economy 的 **GET** surface，并沿 `HTTP → store query → SQL → response projection`
确认真实行为（不看路由名字）。

| endpoint | canonical source | owner-scoped？ | owner 参数 | 过滤位置 | 排序权威 | 分页权威 | 需要浏览器 join？ | 会泄露别的 owner 吗 | UI consumer |
|---|---|---|---|---|---|---|---|---|---|
| `/economy/wallet` | `economy_wallets`（± ledger 重算） | **是** | `ownerId`（或 `walletId`） | SQL（`selectWalletByOwner`） | `currency ASC` | 无（点查） | 否 | 不会（未给 owner 时必须给 walletId） | P22-16 · P22-17 · P22-18 |
| `/economy/policy` | `economy_budget_policies` | **是** | `ownerId`（或 `policyId`） | SQL（`selectBudgetPolicyByOwner`） | — | 无 | 否 | 不会 | P22-16 · P22-17 · P22-18 |
| `/economy/budget` | 钱包 + 政策 + 账本（快照求值） | **是** | `ownerId` | SQL（同上两支） | — | 无 | 否 | 不会 | P22-16 · P22-18 |
| `/economy/autonomy-policy` | `economy_autonomy_policies` | **是** | `ownerId`（或 `policyId`） | SQL（`selectAutonomyPolicyByOwner`） | — | 无 | 否 | 不会 | P22-16 |
| `/economy/stores` | `economy_stores` | **否（目录）** | 无 | SQL（status 过滤） | `sort_order, created_at` | `LIMIT`（无游标） | 否 | 不适用：货架不属于任何角色 | P22-17 · P22-18 |
| `/economy/products` | `economy_products` | **否（目录）** | 无 | SQL（store/status/kind/currency） | `created_at` | `LIMIT` | 否 | 不适用 | P22-15 · P22-17 · P22-18 |
| `/economy/inventory` | `economy_inventory` | **是** | `ownerId`（或 `productId`） | SQL（`selectInventoryFiltered`） | `asset_kind, product_id` | `LIMIT` | 否 | 不会 | P22-17 · P22-18 |
| `/economy/purchases` | `economy_purchases` | **是** | `buyerId` / `recipientId` | SQL（`selectPurchasesFiltered`） | `created_at ASC` | `LIMIT` | 否 | 不会 | P22-17 · P22-18 |
| `/economy/intents` | `economy_purchase_intents` | **是** | `agentId` | SQL（`selectPurchaseIntentsFiltered`） | `created_at ASC` | `LIMIT` | 否 | 不会 | P22-15 · P22-17 · P22-18 |
| `/economy/approvals` | `economy_approvals` | **是** | `buyerId` / `quoteId` / `status` | SQL（`selectApprovalsFiltered`） | `created_at ASC` | `LIMIT` | 否 | 不会 | P22-15 |
| **`/economy/changes`** | `economy_change_log` | **否 ← 唯一的例外** | **无（P22-19 前）** | — | `revision ASC` | keyset（`revision > ?`，≤500/页） | **是 ← 唯一一条** | **会**：全局日志（所有 owner / 货架 / 商品 / intent 共用） | P22-18 |
| `/security` | 进程自述（无 Economy 行） | **否** | 无 | — | — | — | 否 | 不适用：它回答"这条进程没有什么" | P22-15 · P22-16 |

### 审计结论

**`/economy/changes` 是唯一一条 owner 作用域没有写在 canonical 里的读面。**
其余十条要么本来就带 canonical 的 owner 参数，要么（目录类与 `/security`）
根本不属于任何角色。

换句话说：这一阶段要修的**不是**"Economy 缺一个 owner filter"，
而是"**恰好有一条读面漏了**"。

---

## §2 · P22-A 的 owner 推导审计

### §2.1 当时的实现

`assets/js/economy-shell-core.js` 的 `changeBelongsTo(change, ownerId, walletId)`：
逐字比较四个依据。

```text
change.walletId                       （列）
payload.ownerId / buyerId / agentId   （逐字相等）
payload.wallets[].walletId            （账本交易的两端）
recipientId                           （刻意**不**算 —— P22-18 的决定）
```

### §2.2 逐字段回答

| 字段 | 谁写进去的 | 所有相关 EVENT_TYPE 都有吗 | 语义稳定吗 | 历史记录会缺吗 | 一个事件能同时属于两个 owner 吗 |
|---|---|---|---|---|---|
| `walletId`（列） | `appendChange` 的 `walletId` 参数 | 否 | 稳定 | 是（`APPROVAL_*` / `AGENT_INTENT_*` / `BUDGET_POLICY_*` / `QUOTE_EXPIRED` / `INVENTORY_*` 全为 `NULL`） | 是 |
| `payload.ownerId` | 政策 / 初始额度 / 库存 / 自主策略的写入点 | 否 | 稳定（裸 id） | 是 | 否 |
| `payload.buyerId` | 报价 / 购买 / 批准 / 自主裁决的写入点 | 否 | **不稳定（两种拼写）** | 是 | 否 |
| `payload.agentId` | intent 的写入点 | 否 | 稳定（裸 id） | 是 | 否 |
| `payload.wallets[]` | 账本提交（`applyDerivedBalances`） | 只在 `_COMMITTED` 上有 | 稳定（**affected** wallets） | 是 | **是**（两端各算一次） |
| `recipientId` | 报价 / 购买 / 批准 | 部分 | 稳定 | 是 | 刻意排除 |

### §2.3 ★ 实测出来的两个结构性缺陷（运行时证据）

用真实 store 跑完 §12 的全部流程之后，逐行比对"归一化判据"与"逐字判据"：

```text
★ rev 14  APPROVAL_APPROVED  逐字证据=["character:char_a"]  浏览器判=false  归一化判=true
★ rev 24  APPROVAL_REJECTED  逐字证据=["character:char_a"]  浏览器判=false  归一化判=true
归一化能看见、逐字看不见的行 = 2     逐字能看见、归一化看不见的行 = 0
```

**① 同一个 payload 键在同一个文件里有两种 canonical 拼写。**

```text
APPROVAL_REQUESTED  buyerId: buyerId                        → "char_a"
APPROVAL_APPROVED   buyerId: partyKeyOf(buyer_type, buyer_id) → "character:char_a"
APPROVAL_REJECTED   同上
APPROVAL_CONSUMED   同上
```

后果是确定的：**逐字比较必然漏掉 `APPROVAL_APPROVED` / `APPROVAL_REJECTED` /
`APPROVAL_CONSUMED`** —— 而它们恰好是"用户点过头的证据"。P22-18 的时间线上
因此只有"有一个决定在等你"，永远没有"你允许继续"。

★ 写入侧**不**修：`serializeApproval().buyerId === 'character:…'` 是 P22-7
逐字钉住的 canonical 形状（`test_p22_7_economy_approval.js:468`），而
`serializePurchase().buyerId` 同理（`test_p22_6_economy_purchase.js:695`）。
两种拼写在**别的**读面上各自都是冻结事实；而 change log 是**已经写下的历史**
—— 无论写入侧怎么改，历史行仍然是两种拼写并存。因此归一化**必须**发生在
读的那一条实现里。

**② `APPROVAL_EXPIRED` 的 payload 里一个 owner 字段都没有。**

```text
payload 键 = approvalId, approvalStatus, consumedByPurchaseId, domain,
             expiresAt, fromStatus, inventoryMutation, ledgerMutation
wallet_id  = NULL
```

它的 owner 权威在 `economy_approvals` 行上，而浏览器没有那张表（P22-18 的
九条读面里**没有** approvals）—— 于是它在这条规则下**永远**无法归属。

### §2.4 `wallets[]` 是参与者还是 affected wallets？—— 实测

`appendChange` 的账本提交通道（`economy-store.js` 的 `commitLedgerTransaction`）：

```js
walletId: touched.length ? touched[0].walletId : null,   /* ← 只记第一个 */
payload: { wallets: touched.map(w => ({ walletId: w.walletId, … })) }
```

一次 A→B 的转账：

```text
rev 98  GIFT_COMMITTED  wallet:…_5  wallets=[…_5, …_7]
```

**结论**：`wallets[]` 表达的是 **affected wallets**（缓存余额真的被改写的那些），
而 `walletId` 列只是 `touched[0]` —— 一个确定性但**任意**的挑选。因此
"只看 `walletId` 列"的读法会漏掉交易的另一端。

`recipientId` 与 gift 的关系见 §6。

### §2.5 EVENT_TYPE × ownership evidence 矩阵

`kind` 词表的两个来源（都**抽**出来，不是手写）：

```text
契约的 EVENT_TYPE —— 52 个（economy-contract.js）
store 自有的 kind —— BALANCE_REBUILT / ECONOMY_INITIAL_CREDIT_BOOTSTRAPPED
                     / <TX_TYPE>_COMMITTED（由 ledger 的 transaction type 拼出）
```

一次真实运行里写下过 26 个 kind。逐类归属证据：

| 证据 | kind | 为什么只有它 |
|---|---|---|
| **E1** `wallet_id` 属于该 owner 的钱包 | `WALLET_OPENED` · `MINT_COMMITTED` · `PURCHASE_RESERVED` · `QUOTE_CONSUMED` · `RESERVATION_CREATED` · `RESERVATION_COMMITTED` · `INVENTORY_*`（部分） · `ECONOMY_INITIAL_CREDIT_BOOTSTRAPPED` | payload 里没有任何当事人字段 |
| **E2** 该交易的账本 entry 落在该 owner 的钱包账户上 | `*_COMMITTED`（MINT / PURCHASE / GIFT / COMPUTE_GRANT） | **列只记 `touched[0]`**，另一端只能靠 entry→钱包这条 join |
| **E3** payload 的 `ownerId` / `buyerId` / `agentId` 等于该 owner | `BUDGET_POLICY_*` · `INVENTORY_GRANTED` / `_CONSUMED` · `QUOTE_CREATED` / `_EXPIRED` · `PURCHASE_CREATED` / `_COMPLETED` · `AGENT_INTENT_*` · `APPROVAL_REQUESTED` | 这些行 `wallet_id` 为 `NULL` 或不是充分条件 |
| **E4** 该 change 的 `entity_id` 是一条属于该 owner 的批准 | `APPROVAL_APPROVED` / `_REJECTED` / `_CONSUMED` / `_EXPIRED` | APPROVAL_\* 的 owner 权威在 approvals 行上，不在 payload 里 |
| **无（owner-less）** | `STORE_CREATED` / `_UPDATED` · `PRODUCT_CREATED` / `_UPDATED` / `_DISABLED` / `_RETIRED` | 货架与商品**不属于任何角色**（§2 的六条不等式之一） |

★ 这不是"漏了"，是"目录没有主人"。测试把它写成**显式声明**（`C2`/`E2`），
于是以后新增一个 owner-less 的 kind 会当场变红，而不是静默变成"归属失败"。

---

## §3 · 判定：需要 backend 改动吗？

§3 的判定条件是 A–E，**A、B、D、E 四条都成立**。

### §3.1 A —— UI 无法仅凭稳定 canonical 字段正确判断 owner ✅

见 §2.3：三个 kind 的 `buyerId` 是另一种拼写（逐字比较必漏），
一个 kind 没有任何 owner 字段（结构性无法归属）。

### §3.2 D + E —— 分页后再筛会造成"看起来完整、其实是最旧的" ✅（对抗性反证）

旧读法：`WHERE revision > cursor ORDER BY revision ASC LIMIT 500`，UI 最多 6 页。
用一个**与规模无关**的对抗性交错把这个性质证死：

```text
A 先写下 1 条 change
→ 另一个 owner / 目录写下 30 条噪声
→ A 再写下**最新**的 1 条

page=5 · cap=6：读到 30 行 · truncated=true · 其中属于 A 的 3 条
A 最新那条在窗口里吗？ ★ 不在
窗口覆盖的 revision 上界 = 30，A 最新那条 = 38
```

★ **即使把 `truncated` 标出来，被截掉的是最新那一段。** 那时页面把窗口里
"最旧的一段"叫作"最近活动"，是错的 —— 而且"最近什么都没发生"是这一格
最危险的一句假信息。规模只是把这个性质放大（真实规模下 6×500 之后同样成立），
所以小规模的精确反证就是证明。

### §3.3 B —— 同一条规则会被两个以上 consumer 重复实现 ✅

归属规则原本在浏览器里；任何第二个 consumer（诊断页、移动端、导出）都必须
各自再实现一遍，包括那两种拼写与 approvals 的那次 join。

### §3.4 结论

**需要 backend 改动**，且按 §5 的优先级第 1 条：给既有 `/economy/changes`
增加 owner query。提交名因此是
`P22-19 · close Economy owner-scoped read model`。

---

## §4 · 落地的形态（§5）

```text
GET /economy/changes?ownerId=<canonical-owner-id>[&order=desc][&cursor=…][&limit=…]
```

**只允许最小只读扩展**：

| 加了什么 | 为什么 |
|---|---|
| `ownerId` | §5 优先级 1 |
| `order`（`asc` \| `desc`） | §7 要求 direction = newest first，而 asc + 截断只能给出**最旧**的一段（§3.2）。没有它，"这里只显示最近的一部分活动"这句话就不可能是真的。同名 endpoint 上的一个参数，仍然落在 §5 优先级 1 的范围内 |

**禁止项一个都没做**：没有 POST、没有 mutation、没有 subscription、没有 websocket、
没有新事件表、没有新读数据库、没有物化分析表。

### §4.1 过滤发生在 canonical query

```sql
-- SQL.selectChangesByOwnerAsc / Desc（economy-store.js）
SELECT … FROM economy_change_log
WHERE revision > ?            -- 或 revision < ?（desc）
  AND (
      wallet_id IN (SELECT wallet_id FROM economy_wallets WHERE owner_id = ?)      -- E1
   OR transaction_id IN (SELECT e.transaction_id FROM economy_ledger_entries e
                          JOIN economy_wallets w ON w.account_id = e.account_id
                          WHERE w.owner_id = ? AND e.transaction_id IS NOT NULL)   -- E2
   OR (json_valid(payload_json) AND (
          json_extract(payload_json,'$.ownerId')  IN (…)                          -- E3
       OR json_extract(payload_json,'$.buyerId')  IN (…)
       OR json_extract(payload_json,'$.agentId')  IN (…)))
   OR entity_id IN (SELECT approval_id FROM economy_approvals WHERE buyer_id = ?)  -- E4
  )
ORDER BY revision ASC|DESC LIMIT ?
```

★ HTTP handler **只透传**：`http.js` 里那一段没有 `.filter(` —— 测试
`A1` 逐字扫源码，并在下一条路由处**切断窗口**（一个宽窗口会把
`/economy/reservations` 的 active 计数当成违规，开发期实测踩到过）。

★ `json_valid` 守卫是必要的：`listChanges` 的 JS 读取路径对坏 JSON 是
`try/catch`（返回 `null`），而 SQL 的 `json_extract` 遇到坏 JSON 会**整个查询
报错** —— 一行历史数据形状异常不该让整条时间线打不开（`F1`）。

★ owner 键的词表来自契约的封闭 `PARTY_TYPES`（三个），不在这里另写一份（`A4`）。

---

## §5 · owner semantics（§6）

### §5.1 定义

```text
affectOwner(X, change) ⟺
   E1  change.wallet_id 属于 X 的一个钱包
∨  E2  该 change 的交易有一笔 entry 落在 X 的某个钱包账户上
∨  E3  payload 的 ownerId / buyerId / agentId 等于 X（两种 canonical 拼写都认）
∨  E4  该 change 的 entity_id 是一条 buyer = X 的批准
```

`X` 是 **canonical 的 wallet-owner 键**：裸 party id（`char_a`，或用户方的
`user`），与 `/economy/wallet?ownerId=` 逐字同一个词表。ref 形态
（`character:char_a`）在这里被当成**另一个不存在的 id**，与其它 owner-scoped
读面完全一致 —— 一个 owner 只有一种写下来的样子。

### §5.2 五种身份明确分开

| 身份 | 是 owner 吗 | 为什么 |
|---|---|---|
| buyer | **是**（E3） | 钱从它出去 |
| wallet owner | **是**（E1 / E2） | 余额真的被改写 |
| agent | **是**（E3，`agentId`） | canonical 的 `intent.buyer = intent.agentId`，它自己的账要出现 |
| approval decider | **否**（E4 用的是 buyer，不是 decider） | "我批准了"这件事的 owner 是**被批准的那一方**；决定的身份在 approvals 行的 `decided_by_*` 上，那是另一件事 |
| recipient | **否**（刻意排除） | 见 §6 |

### §5.3 曾经`agentId` 是否必然等于 buyer owner？

在**当前** canonical 里，`proposeAgentPurchaseIntent({proposal:{agentId}})` 使
`intent.agentId` 既是提出者也是买家（P22-16 冻结事实：budget/autonomy 都按
buyer 查，而 `intent.buyer = intent.agentId`）。但这**不是**本读面的假设：
E3 把三者并列，因此将来若出现"用户替 Agent 买"的形状，买家与提出者各自
仍能被正确归属 —— 不会被一条"agentId 就是 buyer"的隐含假设锁死。

---

## §6 · Gift 语义：A 买给 B

canonical 的事实（真实运行）：

```text
A 买给 B：
  PURCHASE_CREATED / _RESERVED / _COMPLETED   wallet_id = A 的钱包, buyerId = char_a, recipientId = char_b
  GIFT_COMMITTED                              wallet_id = A 的钱包, wallets[] = [A 的钱包]
  INVENTORY_GRANTED                           ownerId = char_b（货到了 B 手上）
```

| 问题 | 答案 | 为什么 |
|---|---|---|
| A 的 Economy timeline 出现吗？ | **出现** | 钱从 A 出去 ⇒ E1/E3 都命中 |
| B 的 Economy timeline 出现吗？ | **不出现那条购买** | `recipientId` 不是归属证据；B 的余额一动没动 |
| 那 B 的时间线上有什么？ | **`INVENTORY_GRANTED`（ownerId = char_b）** | 礼物在收礼者那边体现为"资产变了"，不是"钱变了" |

★ `recipientId` **不等于** "money moved for recipient"。P22-18 已经刻意避免
这个错误，P22-19 不倒退：谓词里没有 `recipientId`（测试 `A3`），纯层的
`changeRefsOf` 也带不出它（测试 `B4`）。

★ **一次 A→B 的裸转账**是另一回事：那笔账本交易**两端**都是 wallet owner，
`wallets[]` 里两个钱包都在 ⇒ 两个 owner 的时间线**都该有它**（`H6`）。

---

## §7 · Timeline completeness（§7）

```text
order      = canonical revision
direction  = newest first（`order=desc`，写在**请求**上）
pagination = canonical cursor/page semantics（revision 上的 keyset，≤500/页）
```

UI 侧的安全上限仍然存在（`CHANGE_MAX_PAGES = 6`），但**三态必须分开**：

| 态 | 什么时候 | 页面上那一句 |
|---|---|---|
| `complete` | 某一页短了（走到了这一端） | 什么都不说 |
| `truncated` | 配额用完，或中途失败但拿到了前面的部分 | **"这里只显示最近的一部分活动，更早的记录没有读出来。"** |
| `unknown` | 第一页就没读成，或窗口内顺序不成立 | **"这一页拿到了活动记录，但没法确定它是不是完整的。"** |

★ 三态在**页面文案**上就是三句**不同**的话（`C2` / `C3`），因为"看少了"
与"不知道看了多少"是两件事，说成同一句用户就分不出来。

★ **没有截断标记的响应 ⇒ `unknown`，不是 `complete`**：把"没说"默认成
"完整"正是 §7 逐字禁止的"truncated → 当 complete 展示"的另一种写法（`D5`）。

★ **完整性是全页一致的**（开发期发现）：经济活动那一格的脚注原本无条件说
"更早的仍然在「活动时间线」里"。时间线被截断时那是**另一句假话** —— 同一页
上两格对同一件事给出相反的说法，比不说还坏。现在它按时间线的完整性选句子
（`D8` / `C10` / read-contract `C5`）。

---

## §8 · 这个投影不是第二权威

`listChangesForOwner` 只做 **join / filter / sort / project**。它**不**重算：

```text
balance · budget decision · approval validity · quote validity
purchase outcome · inventory quantity · autonomy verdict
```

可断言的证据（测试 `I1`–`I4`）：

- 同一个 `revision` 在**全局读面**与**owner 读面**上逐字相同（没有第二个投影）；
- 行的键恰好是 `at / domain / entityId / kind / payload / revision / transactionId / walletId`
  —— 没有任何被重算的经济事实字段；
- 读面不写任何东西（读完之后 revision 与行数逐字不变）；
- `spentTodayMinor` / `availableBalanceMinor` / approval status 仍然只来自
  各自的 canonical 读面，这一层一个都不提供。

响应里还有两句逐字的自述：`ownerScope: {ownerId, order, scoped}` 与
`recomputesEconomyFacts: false`。

---

## §9 · 冻结的 UI 读依赖契约

`tests/test_p22_19_economy_read_contract.js` 的 `UI_CONTRACT` 是**唯一**的声明表，
而断言把声明与各个 core 的**真实导出**逐个比对（不是抄一遍常量）：

| UI | READS | WRITES | OPTIONAL_READS | AUTHORITY_FIELDS | DERIVED_FIELDS |
|---|---|---|---|---|---|
| P22-15 Approval | 4：intents / approvals / products / security | `ID.DECISION_PATH`（`/internal/economy/approval-decision`） | — | approvalId · status · decidedBy · decidedAt · expiresAt · bindingFingerprint · authorityOutcome · authorityReasonCode | effectiveStatus · faces · canDecide · reasonText |
| P22-16 Configuration | 5：wallet / policy / autonomy-policy / budget / security | `WRITE_PATH`（`/internal/economy/configuration`） | — | ownerId · currency · amountMinor · limits · termEndsAt · autonomyLevel · enabled · approvalAboveMinor · allowedProductKinds · allowedSettlementTypes · allowGift · ifRevision · cachedBalanceMinor | commandList · ownerOptions · limitsDraft · scaleText |
| P22-17 Store | 8（`READS`，P22-17 的 A4 逐字钉住） | **无** | `/economy/changes` | walletId · cachedBalanceMinor · availableBalanceMinor · reservedBalanceMinor · state · balanceKnown · unitPriceMinor · quantity · assetKind · amountMinor · purchaseId · productId · storeId · status · ownerId · currency · limits | assetCounts · purchaseCount · saturated · visualVariant · priceText |
| P22-18 Experience | 同上 8 条 | **无** | — | revision · kind · entityId · walletId · transactionId · at · payload · agentIntentId · approvalId · purchaseId · quoteId · reason · state · authorityOutcome · authorityReasonCode · completed | face · tone · knownKind · amountText · atText · source · steps · spendTotalMinor · completeness |

外加第九条：`CHANGE_READ = '/economy/changes'`。它**不在** `READS` 里 ——
P22-17 的 A4 钉住"八条读面"是那一阶段的冻结事实，`readPathList()` 仍然是八条。

★ 不造新的 runtime framework：就是测试常量 + 从 core 抽（§9 的"测试常量即可"）。

---

## §10 · 高级信息仍然只是调试面（§10）

- 默认折叠（`open: false` 是模型的**初值**）；
- 四句逐字的自述都在：不含数据库行 / 账本内部 / 版本号 / 迁移状态；
- 四个编号仍然**只有**那四个：`agentIntentId` / `approvalId` / `purchaseId` / `quoteId`
  （`reservationId` / `transactionId` 一个都没进来）；
- `buildAuditModel` 的输出里不含 `payload` / 数据库行 / JSON —— "复制整条数据库记录"
  这条路在**数据上**不存在。

---

## §11 · UI 改动纪律（§11）

| 文件 | 改动 |
|---|---|
| `assets/js/economy-shell-core.js` | 删除 `changeBelongsTo`（归属上移）；时间线只排序不筛；三态完整性；经济活动那一格的脚注按时间线完整性选句子 |
| `assets/js/economy-shell.js` | 读取逻辑：`ownerId` + `order=desc` + 首轮 cursor 语义；三态落笔；技术说明那一行反映作用域 |
| `assets/js/economy-approval-core.js` | **0 diff** |
| `assets/js/economy-approval.js` | **0 diff** |
| `assets/js/economy-configuration-core.js` | **0 diff** |
| `assets/js/economy-configuration.js` | **0 diff** |
| `assets/css/economy-shell.css` | **0 diff**（结构、类名、节点顺序逐字未变） |

★ **视觉结构一个字都没重画**：P22-18 的视觉矩阵按 §13 的要求**不**重跑全部
156 项之外的东西 —— 但它自身仍然跑了一遍（157/157，其中新增一项证明
"每一次 change 请求都带 ownerId 与 order=desc，且页面上没有别人的行"）。

---

## §12 · 测试

| 文件 | 项数 | 资源 |
|---|---|---|
| `tests/test_p22_19_economy_read_contract.js` | 28 | 0 子进程 · 0 socket · 0 浏览器 |
| `tests/test_p22_19_economy_owner_scope.js` | 44 | 同上（真实 store，临时库文件） |
| `tests/test_p22_19_economy_owner_scope_http.js` | 21 | **一个 in-process Home Node + 真 socket**（§13 允许；不 spawn、不开第二个） |

§12 点名的场景覆盖（全部走**真实** canonical 流程，不是手写 change）：

```text
owner A purchase · owner B purchase · A buys gift for B · B buys gift for A
AUTO_ALLOW · user approval（APPROVED + resume）· rejected approval
expired approval · expired quote · reservation · initial bootstrap
balance rebuild · inventory grant · inventory consume · compute entitlement
unknown / historical payload shape（三种，含坏 JSON）
```

并验证：

```text
A timeline 不混入 B 的 money movement          （B2 / B6 / HTTP B2）
B timeline 不因 recipientId 被算成 buyer activity （H2 / H4）
pagination 后 owner filter 仍完整               （D1–D5 / HTTP D1–D3）
revision ordering 稳定                          （D5 / I1）
truncation 被明确标记                           （P22-18 的 D5/D6 与 UI C9/C10）
```

★ §12 末句"如果 backend 不改：用 counterproof 证明浏览器推导足够"——
本阶段的证据指向反面，因此这里给的是**反面**的反证（§3.2 + §2.3），
外加一份**独立 oracle**（走 canonical 的读 API + JS，不抄那段 SQL）对
canonical 的答案做**正反两向**交叉核对（`B4` / `B5`）。

---

## §13 · 资源

```text
非视觉测试    child_process = 0 · spawn = 0 · browser = 0 · socket = 0
HTTP 测试     child_process = 0 · spawn = 0 · browser = 0 · 本进程 1 个真实 server/socket
视觉测试      spawn = 1（一次 Chrome，复用到底）· browser = 1
结束           Browser.close + child.kill + 临时 profile 清理 · leftover = 0
仓库新增 PNG  0（截图仍然全在 %TEMP%\ib-p22-18-shots）
```

**没有**启动 Desktop / Electron / DSH / 多实例 Playwright / IB 完整桌面环境。

★ §13 说"视觉如果 UI 没有结构变化，不要重新跑完整 156 项视觉矩阵"。
本阶段的结构/类名/节点顺序逐字未变，因此只跑了 P22-18 那一条既有回归
（它同时覆盖 P22-15/16/17 的三个节点顺序断言），并单独跑了 P22-17 的
整份视觉回归（92/92）—— 因为 P22-17 与 P22-18 共用同一个 shell core。

---

## §14 · 禁止面

以下**一个都没有**出现（测试 `E1`–`E5` 逐条断言）：

```text
Exchange · Refund · Provider quota · Provider billing · Provider top-up
Real payment · Human direct purchase · Store management · Merchant
Promotion · Discount · Coupon
新的 Economy write endpoint · 新的 Agent capability · 新的 Approval capability
新的 Action · 新的事件表 · 新的读数据库 · 物化分析表
```

★ `exchange` 这个词在浏览器侧**确实**出现 —— 但它每一次都只是 canonical 的
**拒绝原因码**（`exchange_rate_unknown` / `exchange_rounds_to_zero`）。
`E1b` 因此逐个取它所在的整段标识符，核对它是契约 `DENY_REASON` 里的一个词；
这个判据比"子串不出现"精确，也不会为了变绿而删掉一句真实的说明。

★ **schema 水位仍然是 7**（`E4`）：本阶段只加了两个 SQL 常量与一个读方法，
不抬水位就意味着没有迁移、没有写入侧改动。

---

## §15 · 开发期发现并修掉的真实缺陷

| # | 缺陷 | 怎么发现的 | 修法 |
|---|---|---|---|
| 1 | 逐字归属漏掉 `APPROVAL_APPROVED` / `_REJECTED` / `_CONSUMED` | 真实 store 上逐行比对两种判据 | 归一化两种 canonical 拼写（读的一条实现里） |
| 2 | `APPROVAL_EXPIRED` 结构性无法归属 | 同上（payload 一个 owner 字段都没有） | E4：走 approvals 行的 buyer |
| 3 | asc + 截断给出"最旧的一段" | 对抗性交错反证 | `order=desc` |
| 4 | 两格对完整性的说法互相矛盾 | 改完文案之后读页面 | 经济活动那一格按时间线的完整性选句子 |
| 5 | P22-18 的夹具比生产**宽松** | 真实 payload 与夹具逐字对比 | 夹具改成 canonical 真实的形状（含 `character:` 拼写）与真实的分页语义 |
| 6 | P22-18 的视觉夹具把全局 change log 当成 owner 作用域的 | 同上 | 夹具按 query 真的分作用域 —— 于是"外壳带没带 ownerId"变成可证伪的性质 |

★ 第 5、6 条是同一类缺陷的第三次出现（P22-16 记过一次：纯 Node 测试全绿
而真浏览器里错）。**替身比生产宽松**是这一仓库最容易复发的一类问题。

---

## §16 · 明确记录、本阶段**不**修的问题

1. **change log 的 `buyerId` 有两种 canonical 拼写。** 不修写入侧：两种拼写
   在各自的读面上都是 P22-6 / P22-7 冻结的 canonical 形状，而 change log 是
   历史数据 —— 无论写入侧怎么改，历史行仍然并存。读面因此永久负责归一化。
2. **`walletId` 列只记 `touched[0]`。** 不修写入侧：列是"这条变化主要关于哪个
   钱包"的一个提示，`wallets[]` 才是权威集合；改它会改变已落库的行形状。
3. **`/economy/changes` 的默认方向仍然是 asc。** 全局读面是内部审计面，
   P22-2 的 C10 逐字钉住它的顺序；"要最新的一段"这个需求只在 owner 作用域下
   被证明过，因此 `order` 必须与 `ownerId` 同时出现（`C1`）。
4. **owner-scoped 读面**没有**把 `order` 也开放给全局读面。** 那会扩大一条
   没有被证明需要的表面（§5 的最小原则）。
