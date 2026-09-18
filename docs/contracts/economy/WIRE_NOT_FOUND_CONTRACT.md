# Economy Not-Found Wire Contract

> Current-state contract for how Economy read surfaces report a **missing resource**, and how the production client classifies that answer.
> This is a **narrow** contract. It does not describe the whole Economy surface; route membership lives in
> `docs/contracts/economy/ECONOMY_PUBLIC_SURFACE.md`, and the frozen closed sets live in
> `docs/contracts/economy/ECONOMY_V1_FROZEN_CONTRACT.md`.

---

## 1. Scope

This contract fixes exactly three things:

1. the **HTTP status** an Economy read surface returns when the requested resource does not exist;
2. the **client-facing error token** in the response body for that condition;
3. the **client-side classification** of that token (`absent` vs `unknown`).

It is the separation between two vocabularies:

- the canonical **decision** vocabulary (`DENY_REASON`, `SCREAMING_SNAKE_CASE`) — internal, authoritative, never sent as a client resource token;
- the **client resource-absence** vocabulary (kebab-case resource tokens) — the only thing a not-found read surface emits as `body.error`.

---

## 2. Authority

| Layer | Source of truth |
| --- | --- |
| Production implementation | `services/home-node/http.js` — the single `bad(res, status, error, …)` envelope helper (sends `{ ok:false, error, … }`) |
| Decision vocabulary | `services/home-node/economy-contract.js` — `DENY_REASON` (canonical, `SCREAMING_SNAKE`) |
| Client classification | `assets/js/economy-configuration-core.js` |
| Enforcing tests | `tests/test_p22_24_not_found_wire_contract.js`, `tests/test_p22_24_fresh_owner_autonomy_ui.js` |

Relationship to the other Economy contracts:

- `ECONOMY_V1_FROZEN_CONTRACT.md` remains the authority for the **route / capability / schema closed sets**. This contract does not add, remove, or rename any of them.
- `ECONOMY_PUBLIC_SURFACE.md` remains the authority for the **route list**. This contract only fixes the not-found **wire shape** of the single-resource read routes listed there.

---

## 3. Server Wire Semantics

When a single-resource Economy `GET` read resolves to **no row**, the response is:

```json
{ "ok": false, "error": "<kebab-case resource token>" }
```

with HTTP status **404**. The token is the store's client-facing `errors[0]` (never the canonical `reasonCode`).

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

**Boundary (not the same condition, not these tokens):**

- an **unmatched** `/economy/*` path is `404 unknown-economy-path` on `GET` and `405 economy-is-read-only` otherwise;
- a **non-resource read failure** (list / aggregate / ledger / change-scope) is `400` with its own read-failure token;
- a **write-surface** response (`/internal/economy/*`) carries its own envelope and may carry `reasonCode` as `reasonCode` — that is a different contract.

---

## 4. Client Interpretation

The production configuration UI core classifies a read answer from its `code` (the response `error`):

| View | Token | Client state | Carries text/detail? |
| --- | --- | --- | --- |
| `buildWalletView` | `wallet-not-found` | `absent` | no |
| `buildBudgetView` | `budget-policy-not-found` | `absent` | no |
| `buildAutonomyView` | `autonomy-policy-not-found` | `absent` | no |
| (any view) | any other code / no response | `unknown` | yes (`text`, and `detail` when the code is unknown) |

`absent` means "the system does not have this resource yet" (a normal, expected state that unlocks first-time configuration). `unknown` means "the answer could not be interpreted or did not arrive" (a real failure that shows retry wording). The two must not be collapsed.

---

## 5. Invariants

| # | Invariant | Evidence |
| --- | --- | --- |
| I1 | The two vocabularies are **disjoint**: canonical decision reasons are `SCREAMING_SNAKE` (`DENY_REASON`, ≥ 50 members, all matching `^[A-Z][A-Z0-9_]*$`); client resource tokens are kebab-case. Intersection = 0. | `economy-contract.js`; guard checks ①/② |
| I2 | On every "absence ⇒ 404" line, `body.error` is the **client token** (`errors[0]` or a literal), **never** a `reasonCode`. A `reasonCode` may only appear as a status selector (`reasonCode === 'X' ? 404 : 400`). | `http.js`; guard check ⑧ |
| I3 | `NOT_FOUND ≠ EMPTY`: a missing single resource is `404` + resource token; an empty collection is `200` + an empty list. | `GET /economy/stores` / `/economy/products` on a fresh world return empty; single-resource reads above return 404 |
| I4 | `NOT_FOUND ≠ TRANSPORT_FAILURE`: an absence token yields client `state=absent`; a transport failure / no response yields `state=unknown`. | `economy-configuration-core.js`; guard checks ④/⑥ |
| I5 | Absence is a **system state, not an error**: the `absent` result carries no `text`/`detail` and no retry. | `economy-configuration-core.js`; guard check ⑤ |
| I6 | The canonical decision vocabulary is unchanged: `POLICY_NOT_FOUND` and `APPROVAL_NOT_FOUND` remain `DENY_REASON` members; absence of an autonomy policy does **not** mean autonomy is enabled (evaluator default `REQUIRE_APPROVAL` is unchanged). | `economy-contract.js`; guard checks ②/⑨ |

---

## 6. Non-goals

This contract deliberately does **not** freeze:

- UI wording, copy, or layout;
- implementation function names or internal helpers;
- internal storage, tables, or schema;
- write-surface envelopes or their `reasonCode` usage;
- Economy errors unrelated to a missing resource;
- the route list itself (owned by `ECONOMY_PUBLIC_SURFACE.md`);
- phase history (see §8).

---

## 7. Enforcement

| Test | What it pins |
| --- | --- |
| `tests/test_p22_24_not_found_wire_contract.js` | live 404 + kebab token on the enumerated absence surfaces; token ∉ `DENY_REASON`; production UI core → `absent`; source-level "no `reasonCode` as error token" invariant |
| `tests/test_p22_24_fresh_owner_autonomy_ui.js` | real browser: a fresh owner sees the absence state (config form), not an unknown/retry state; and a real transport failure still shows retry |

These are behavioral tests against the production implementation. This Markdown file is **human authority backed by runtime tests** — it is not itself a machine-parsed manifest.

---

## 8. Historical Origin

Historical origin: `docs/history/economy/P22/P22-24-NOT-FOUND-WIRE-CONTRACT.md`
