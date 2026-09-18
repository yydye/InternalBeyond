# Economy Domain & Namespace Contract

> Economy **domain marker**（`domain`）与 in-domain **namespace** 闭集的 Canonical authority。
> Narrow Contract：routes、wire errors，以及 frozen v1 behavior set 位于 sibling Economy Contracts。

---

## 1. 范围

本 Contract 固定当前两条 Economy 规则：

1. 每个 cross-module Economy payload / event / persistence record 都携带具有 canonical 值的 **domain marker**；
2. in-domain **namespace** 字符串构成一个**闭集**。

它刻意保持很小。它不描述 routes、wire errors、storage schema 或 UI。

---

## 2. Authority

| 层 | Source of truth |
| --- | --- |
| 生产 | `services/home-node/economy-contract.js` — `DOMAIN`, `NAMESPACES`, `isEconomyDomain`, `validateEconomyDomain` |
| Enforcement tests | `tests/test_p22_1_economy_domain_contract.js` (D1.1 / D1.5 / D14.33), `tests/test_p22_6_economy_purchase.js`, `tests/test_p22_21_economy_v1_closure_audit.js` |

与 sibling Economy Contracts 的关系：

- `ECONOMY_V1_FROZEN_CONTRACT.md` 冻结 route / capability / schema / event / currency 闭集。
- `ECONOMY_PUBLIC_SURFACE.md` 列出 routes。
- `WIRE_NOT_FOUND_CONTRACT.md` 固定 not-found absence tokens。
- **本** Contract 只固定 domain marker 与 namespace 闭集。

---

## 3. Domain Marker

- Canonical 值：`DOMAIN = 'ib.economy'`。
- 规则：cross-module Economy payload / event / persistence record 携带 `domain: 'ib.economy'`。`validateEconomyDomain(v)` 只接受这个值，拒绝其他一切（包括 `undefined`、`'ib.payment'`、`'economy'`、`''`），并以 `missing-economy-domain` 拒绝。
- 证据：`economy-contract.js` —— 值位于 `DOMAIN`；`isEconomyDomain`；`validateEconomyDomain`。每个 constructor（wallet view / ledger entry / event / audit record / quote / approval / …）都会盖上 `domain: DOMAIN`。

---

## 4. Namespaces（闭集）

`NAMESPACES` 是一个 `Object.freeze` 的闭集，包含 **15** 个条目，每个都以 `ib.economy.` 为前缀：

| Key | Value |
| --- | --- |
| `WALLET` | `ib.economy.wallet` |
| `TRANSACTION` | `ib.economy.transaction` |
| `LEDGER` | `ib.economy.ledger` |
| `RESERVATION` | `ib.economy.reservation` |
| `BUDGET` | `ib.economy.budget` |
| `STORE` | `ib.economy.store` |
| `INVENTORY` | `ib.economy.inventory` |
| `EXCHANGE` | `ib.economy.exchange` |
| `COMPUTE` | `ib.economy.compute` |
| `QUOTE` | `ib.economy.quote` |
| `PURCHASE` | `ib.economy.purchase` |
| `APPROVAL` | `ib.economy.approval` |
| `AGENT_INTENT` | `ib.economy.agent-intent` |
| `EVENT` | `ib.economy.event` |
| `AUDIT` | `ib.economy.audit` |

Stability 规则：namespace 字符串绝不在 runtime 构建；该集合是闭集。添加一个 namespace 是**增量的**（既有 literal 不得改变）。autonomy policy 刻意**复用** `BUDGET` —— 它共享 record shape，且需要自己的 event names，而不是第二个 namespace。

---

## 5. marker 出现的位置 vs 它被持久化的位置

- **不作为 key 持久化**：Economy store schema 没有 `domain` / `namespace` 列。marker 不是查询 key，也不影响 DB migration 或 backup / restore。
- **出现在 read views 中**：serializers 将其包含在 wire responses 上（`serializeWallet` → `domain`；`serializeBudgetPolicy` / `serializeQuote` / `serializePurchase` / `serializeApproval` / `serializeAutonomyPolicy` → `domain` + `namespace`）。
- **不作为分支依据**：没有任何 production code 或 client 读取 `domain` / `namespace` 来做决策。`validateEconomyDomain` 为 callers 导出，但在当前 production path 内部并未被调用。

Compatibility 后果：更改 `DOMAIN` 或任何 namespace literal 会静默改变每个已盖戳的 payload / view，并破坏 enforcing tests。这是 v1 identity marker —— 不要就地更改它；应声明新版本。

---

## 6. Non-goals

本 Contract **不**冻结：routes、response field sets、wire error tokens、persistence schema、UI，或 frozen behavior set（见 sibling contracts）。

---

## 7. Enforcement

| 测试 | 固定内容 |
| --- | --- |
| `tests/test_p22_1_economy_domain_contract.js` | `DOMAIN === 'ib.economy'`；`validateEconomyDomain` 接受/拒绝；每个 namespace 前缀为 `ib.economy.`；精确的 namespace literals |
| `tests/test_p22_6_economy_purchase.js` | 精确的 namespace literals；`Object.keys(NAMESPACES).length === 15` |
| `tests/test_p22_21_economy_v1_closure_audit.js` | closure audit 中的 `C.DOMAIN === 'ib.economy'` |

这些是针对 production contract 的 behavior-level tests。本文档是 **human authority backed by runtime tests** —— 它本身不是 machine-parsed manifest。

---

## 8. 历史引用

历史来源：`docs/history/economy/P22/P22-1-ECONOMY-CONTRACT.md`
