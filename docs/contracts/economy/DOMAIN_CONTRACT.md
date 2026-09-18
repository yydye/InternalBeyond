# Economy Domain & Namespace Contract

> Canonical authority for the Economy **domain marker** (`domain`) and the in-domain **namespace** closed set.
> Narrow contract: routes, wire errors, and the frozen v1 behavior set live in the sibling Economy contracts.

---

## 1. Scope

This contract fixes two current Economy rules:

1. every cross-module Economy payload / event / persistence record carries the **domain marker** with the canonical value;
2. the in-domain **namespace** strings form a **closed set**.

It is deliberately small. It does not describe routes, wire errors, storage schema, or UI.

---

## 2. Authority

| Layer | Source of truth |
| --- | --- |
| Production | `services/home-node/economy-contract.js` — `DOMAIN`, `NAMESPACES`, `isEconomyDomain`, `validateEconomyDomain` |
| Enforcement tests | `tests/test_p22_1_economy_domain_contract.js` (D1.1 / D1.5 / D14.33), `tests/test_p22_6_economy_purchase.js`, `tests/test_p22_21_economy_v1_closure_audit.js` |

Relationship to the sibling Economy contracts:

- `ECONOMY_V1_FROZEN_CONTRACT.md` freezes the route / capability / schema / event / currency closed sets.
- `ECONOMY_PUBLIC_SURFACE.md` lists the routes.
- `WIRE_NOT_FOUND_CONTRACT.md` fixes the not-found absence tokens.
- **This** contract fixes only the domain marker and the namespace closed set.

---

## 3. Domain Marker

- Canonical value: `DOMAIN = 'ib.economy'`.
- Rule: a cross-module Economy payload / event / persistence record carries `domain: 'ib.economy'`. `validateEconomyDomain(v)` accepts exactly this value and rejects everything else (including `undefined`, `'ib.payment'`, `'economy'`, `''`) with `missing-economy-domain`.
- Evidence: `economy-contract.js` — value at `DOMAIN`; `isEconomyDomain`; `validateEconomyDomain`. Every constructor (wallet view / ledger entry / event / audit record / quote / approval / …) stamps `domain: DOMAIN`.

---

## 4. Namespaces (closed set)

`NAMESPACES` is an `Object.freeze`d closed set of **15** entries, each prefixed `ib.economy.`:

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

Stability rule: namespace strings are never built at runtime; the set is closed. Adding a namespace is **additive** (existing literals must not change). The autonomy policy deliberately **reuses** `BUDGET` — it shares the record shape and needs its own event names, not a second namespace.

---

## 5. Where the marker appears vs where it is persisted

- **Not persisted as a key**: the Economy store schema has no `domain` / `namespace` column. The marker is not a query key and does not affect DB migration or backup / restore.
- **Present in read views**: the serializers include it on wire responses (`serializeWallet` → `domain`; `serializeBudgetPolicy` / `serializeQuote` / `serializePurchase` / `serializeApproval` / `serializeAutonomyPolicy` → `domain` + `namespace`).
- **Not branched on**: no production code and no client reads `domain` / `namespace` to make a decision. `validateEconomyDomain` is exported for callers but is not invoked inside the current production path.

Compatibility consequence: changing `DOMAIN` or any namespace literal silently changes every stamped payload / view and breaks the enforcing tests. This is a v1 identity marker — do not change it in place; declare a new version instead.

---

## 6. Non-goals

This contract does **not** freeze: routes, response field sets, wire error tokens, persistence schema, UI, or the frozen behavior set (see the sibling contracts).

---

## 7. Enforcement

| Test | What it pins |
| --- | --- |
| `tests/test_p22_1_economy_domain_contract.js` | `DOMAIN === 'ib.economy'`; `validateEconomyDomain` accept/reject; every namespace prefixed `ib.economy.`; exact namespace literals |
| `tests/test_p22_6_economy_purchase.js` | exact namespace literals; `Object.keys(NAMESPACES).length === 15` |
| `tests/test_p22_21_economy_v1_closure_audit.js` | `C.DOMAIN === 'ib.economy'` among the closure audit |

These are behavior-level tests against the production contract. This document is **human authority backed by runtime tests** — it is not itself a machine-parsed manifest.

---

## 8. Historical Origin

Historical origin: `docs/history/economy/P22/P22-1-ECONOMY-CONTRACT.md`
