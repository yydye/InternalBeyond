# Relationship Authority Contract

**Status: Canonical**
**Scope: 当前什么是权威的 relationship state**

> 这是一份 **authority contract**，不是 relationship feature specification。它固定当前哪个值是
> 权威的，并明确列出非权威项。真相来源：character
> configuration（`cfg.relationship`）、`assets/js/disclosure-authorization-core.js` /
> `disclosure-store.js`、`assets/js/moments.js` / `reply-chain-core.js`，以及 `docs/DECISIONS.md` D13。

---

## 1. 权威 Relationship State

**`cfg.relationship`** —— character configuration 上的 free-text 属性 —— 是权威的
relationship 值。它作为 prompt context 被读取：

- `assets/js/communication.js`（`cfg.relationship`），
- `assets/js/memory.js`（context build），
- `assets/js/active-diary.js` / `active-diary/diary.js`，
- `assets/js/communication/letters.js` / `annotations.js`，
- `assets/js/agent-runtime.js`。

不存在**独立的 Relationship Engine**，也不存在持久化的 "relationship score"。

---

## 2. Disclosure Signals（不是 relationship state）

`trust / affinity / familiarity / dmCount / relationship / toneCounts / initiative / memorandum` 是
由独立 disclosure 子系统拥有的 **disclosure authorization signals**
（`disclosure-authorization-core.js`；存储在 `disclosureFacts`、`disclosure-store.js`）。它们的存在是为了
授权 disclosure，而不是定义 relationship state。

## 3. pairAffinity（不是 relationship state）

`pairAffinity`（`assets/js/moments.js`、`assets/js/reply-chain-core.js`）是一种 **derived / ephemeral
interaction weighting**，用于 gate 第三方 interaction 与 reply-chain likelihood。它不是持久化的
relationship authority。

## 4. Disjointness

```
cfg.relationship      ≠   disclosureFacts      ≠   pairAffinity
(authoritative            (disclosure               (interaction
 relationship attribute)   authorization signals)   weighting)
```

这三者不得合并，不得统一为单一的 "relationship score"，本 Contract 也不得迁移它们或赋予新的
schema/state machine。

---

## 5. 非权威项

- Companion **不是** relationship authority。
- Memory **不是** relationship authority。
- `disclosureFacts` **不是** relationship authority。
- `pairAffinity` **不是** relationship authority。

## 6. 既有决策

`docs/DECISIONS.md` **D13** 规定：不引入过早的 relationship state layer；
relationship layer 等待来自 `social-observe.js` 的 calibration。本 Contract 与 D13 一致，且不取代它。

---

## 7. Non-goals

本 Contract 不设计 relationship model、不添加字段、不提议 migration、也不创建 state machine。

---

## 8. Enforcement

| Test | 固定内容 |
| --- | --- |
| `tests/test_role_dm.js` / `test_role_dm_smoke.js` | Role DM / relationship-context 行为 |
| `tests/test_disclosure_authorization.js` | `disclosureFacts` 授权行为 |
| `tests/test_socialnet_*` / `test_runtime_convergence_moments.js` | `pairAffinity` interaction weighting |

---

## 9. 历史来源

`docs/ROLE_DM.md`（relationship review）、`docs/DECISIONS.md` D13；
`docs/history/platform/ROLE_DM_RELATIONSHIP_PHASE4_AUDIT.md`（phase audit）。
