# Economy Not-Found Wire Contract

> 关于 Economy read surfaces 如何报告**缺失资源**，以及 production client 如何对该答案进行分类的当前状态 Contract。
> 这是一个**narrow** Contract。它不描述整个 Economy surface；route membership 位于
> `docs/contracts/economy/ECONOMY_PUBLIC_SURFACE.md`，而 frozen closed sets 位于
> `docs/contracts/economy/ECONOMY_V1_FROZEN_CONTRACT.md`。

---

## 1. 范围

本 Contract 精确固定三件事：

1. 当请求的资源不存在时，Economy read surface 返回的 **HTTP status**；
2. 该情况下 response body 中的 **client-facing error token**；
3. 该 token 的 **client-side classification**（`absent` vs `unknown`）。

它是两套词表之间的分离：

- canonical **decision** 词表（`DENY_REASON`，`SCREAMING_SNAKE_CASE`）—— internal、authoritative，绝不作为 client resource token 发送；
- **client resource-absence** 词表（kebab-case resource tokens）—— not-found read surface 作为 `body.error` 发出的唯一内容。

---

## 2. Authority

| 层 | Source of truth |
| --- | --- |
| Production implementation | `services/home-node/http.js` — 唯一的 `bad(res, status, error, …)` envelope helper（发送 `{ ok:false, error, … }`） |
| Decision vocabulary | `services/home-node/economy-contract.js` — `DENY_REASON` (canonical, `SCREAMING_SNAKE`) |
| Client classification | `assets/js/economy-configuration-core.js` |
| Enforcing tests | `tests/test_p22_24_not_found_wire_contract.js`, `tests/test_p22_24_fresh_owner_autonomy_ui.js` |

与其他 Economy contracts 的关系：

- `ECONOMY_V1_FROZEN_CONTRACT.md` 仍是 **route / capability / schema 闭集**的 authority。本 Contract 不添加、删除或重命名其中任何一个。
- `ECONOMY_PUBLIC_SURFACE.md` 仍是 **route list** 的 authority。本 Contract 只固定其中所列 single-resource read routes 的 not-found **wire shape**。

---

## 3. Server Wire Semantics

当 single-resource Economy `GET` read 解析为**没有 row**时，response 为：

```json
{ "ok": false, "error": "<kebab-case resource token>" }
```

HTTP status 为 **404**。该 token 是 store 的 client-facing `errors[0]`（绝不是 canonical `reasonCode`）。

| Surface | Condition | HTTP | Wire token (`body.error`) | Evidence |
| --- | --- | ---: | --- | --- |
| `GET /economy/wallet` | owner has no wallet for the currency | 404 | `wallet-not-found` | `http.js` `bad(res, 404, errors[0] \|\| 'wallet-not-found')` |
| `GET /economy/transaction` | no transaction with that id | 404 | `transaction-not-found` | `http.js` |
| `GET /economy/reservation` | no reservation with that id | 404 | `reservation-not-found` | `http.js` |
| `GET /economy/policy` | owner has no budget policy | 404 | `budget-policy-not-found` | `http.js` |
| `GET /economy/quote` | no quote with that id | 404 | `quote-not-found` | `http.js` |
| `GET /economy/store` | no store with that id | 404 | `store-not-found` | `http.js` |
| `GET /economy/product` | no product with that id | 404 | `product-not-found` | `http.js` |
| `GET /economy/inventory-entry` | no inventory row with that id | 404 | `inventory-entry-not-found` | `http.js` |
| `GET /economy/purchase` | no purchase with that id | 404 | `purchase-not-found` | `http.js` |
| `GET /economy/approval` | no approval with that id | 404 | `approval-not-found` | `http.js` (status chosen by `reasonCode === 'APPROVAL_NOT_FOUND' ? 404 : 400`) |
| `GET /economy/intent` | no purchase intent with that id | 404 | `intent-not-found` | `http.js` |
| `GET /economy/autonomy-policy` | owner has no autonomy policy | 404 | `autonomy-policy-not-found` | `http.js` (status chosen by `reasonCode === 'POLICY_NOT_FOUND' ? 404 : 400`) |

**边界（不是同一种 condition，也不是这些 tokens）：**

- **未匹配**的 `/economy/*` path 在 `GET` 上是 `404 unknown-economy-path`，否则是 `405 economy-is-read-only`；
- **非资源 read failure**（list / aggregate / ledger / change-scope）是 `400`，并带有自己的 read-failure token；
- **write-surface** response（`/internal/economy/*`）携带自己的 envelope，并可能以 `reasonCode` 形式携带 `reasonCode` —— 那是另一个 Contract。

---

## 4. Client Interpretation

production configuration UI core 根据 read answer 的 `code`（即 response `error`）对其进行分类：

| View | Token | Client state | Carries text/detail? |
| --- | --- | --- | --- |
| `buildWalletView` | `wallet-not-found` | `absent` | no |
| `buildBudgetView` | `budget-policy-not-found` | `absent` | no |
| `buildAutonomyView` | `autonomy-policy-not-found` | `absent` | no |
| (any view) | any other code / no response | `unknown` | yes (`text`, and `detail` when the code is unknown) |

`absent` 意味着 "系统还没有这个资源"（一种正常、预期的 state，会解锁首次 configuration）。`unknown` 意味着 "答案无法被解释或没有到达"（一种真实 failure，会显示 retry wording）。两者绝不能合并。

---

## 5. Invariants

| # | Invariant | Evidence |
| --- | --- | --- |
| I1 | 两套词表是**不相交的**：canonical decision reasons 是 `SCREAMING_SNAKE`（`DENY_REASON`，≥ 50 个成员，全部匹配 `^[A-Z][A-Z0-9_]*$`）；client resource tokens 是 kebab-case。交集 = 0。 | `economy-contract.js`; guard checks ①/② |
| I2 | 在每一条 "absence ⇒ 404" 行上，`body.error` 都是 **client token**（`errors[0]` 或 literal），**绝不是** `reasonCode`。`reasonCode` 只可以作为 status selector 出现（`reasonCode === 'X' ? 404 : 400`）。 | `http.js`; guard check ⑧ |
| I3 | `NOT_FOUND ≠ EMPTY`：缺失的单个 resource 是 `404` + resource token；空 collection 是 `200` + 空 list。 | `GET /economy/stores` / `/economy/products` on a fresh world 返回空；上述 single-resource reads 返回 404 |
| I4 | `NOT_FOUND ≠ TRANSPORT_FAILURE`：absence token 产生 client `state=absent`；transport failure / 无 response 产生 `state=unknown`。 | `economy-configuration-core.js`; guard checks ④/⑥ |
| I5 | absence 是一种 **system state，而不是 error**：`absent` 结果不携带 `text`/`detail`，也不重试。 | `economy-configuration-core.js`; guard check ⑤ |
| I6 | canonical decision 词表未改变：`POLICY_NOT_FOUND` 与 `APPROVAL_NOT_FOUND` 仍是 `DENY_REASON` 成员；autonomy policy 的缺席**并不**意味着 autonomy 已启用（evaluator default `REQUIRE_APPROVAL` 未改变）。 | `economy-contract.js`; guard checks ②/⑨ |

---

## 6. Non-goals

本 Contract 刻意**不**冻结：

- UI wording、copy 或 layout；
- implementation function 名称或 internal helpers；
- 内部 storage、tables 或 schema；
- write-surface envelopes 或其 `reasonCode` 用法；
- 与缺失资源无关的 Economy errors；
- route list 本身（归 `ECONOMY_PUBLIC_SURFACE.md` 所有）；
- phase history（见 §8）。

---

## 7. Enforcement

| 测试 | 固定内容 |
| --- | --- |
| `tests/test_p22_24_not_found_wire_contract.js` | 枚举的 absence surfaces 上 live 404 + kebab token；token ∉ `DENY_REASON`；production UI core → `absent`；source-level "no `reasonCode` as error token" invariant |
| `tests/test_p22_24_fresh_owner_autonomy_ui.js` | 真实 browser：fresh owner 看到 absence state（config form），而不是 unknown/retry state；且真实 transport failure 仍显示 retry |

这些是针对 production implementation 的 behavioral tests。本 Markdown 文件是 **human authority backed by runtime tests** —— 它本身不是 machine-parsed manifest。

---

## 8. 历史引用

历史来源：`docs/history/economy/P22/P22-24-NOT-FOUND-WIRE-CONTRACT.md`
