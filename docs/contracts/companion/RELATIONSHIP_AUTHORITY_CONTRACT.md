# Relationship Authority Contract

**Status: Canonical**
**Scope: What is authoritative relationship state today**

> This is an **authority contract**, not a relationship feature specification. It fixes which value is
> authoritative today and explicitly lists the non-authorities. Source of truth: character
> configuration (`cfg.relationship`), `assets/js/disclosure-authorization-core.js` /
> `disclosure-store.js`, `assets/js/moments.js` / `reply-chain-core.js`, and `docs/DECISIONS.md` D13.

---

## 1. Authoritative Relationship State

**`cfg.relationship`** — a free-text attribute on the character configuration — is the authoritative
relationship value. It is read as prompt context:

- `assets/js/communication.js` (`cfg.relationship`),
- `assets/js/memory.js` (context build),
- `assets/js/active-diary.js` / `active-diary/diary.js`,
- `assets/js/communication/letters.js` / `annotations.js`,
- `assets/js/agent-runtime.js`.

There is **no independent Relationship Engine** and no persisted "relationship score".

---

## 2. Disclosure Signals (not relationship state)

`trust / affinity / familiarity / dmCount / relationship / toneCounts / initiative / memorandum` are
**disclosure authorization signals** owned by the separate disclosure subsystem
(`disclosure-authorization-core.js`; stored in `disclosureFacts`, `disclosure-store.js`). They exist to
authorize disclosure, not to define relationship state.

## 3. pairAffinity (not relationship state)

`pairAffinity` (`assets/js/moments.js`, `assets/js/reply-chain-core.js`) is a **derived / ephemeral
interaction weighting** used to gate third-party interaction and reply-chain likelihood. It is not
persisted relationship authority.

## 4. Disjointness

```
cfg.relationship      ≠   disclosureFacts      ≠   pairAffinity
(authoritative            (disclosure               (interaction
 relationship attribute)   authorization signals)   weighting)
```

These three must not be merged, must not be unified into a single "relationship score", and must not be
migrated or given a new schema/state machine by this contract.

---

## 5. Non-authorities

- Companion is **not** relationship authority.
- Memory is **not** relationship authority.
- `disclosureFacts` is **not** relationship authority.
- `pairAffinity` is **not** relationship authority.

## 6. Existing Decision

`docs/DECISIONS.md` **D13** governs: no premature relationship state layer is introduced; the
relationship layer awaits calibration from `social-observe.js`. This contract is consistent with D13 and
does not supersede it.

---

## 7. Non-goals

This contract does not design a relationship model, add fields, propose a migration, or create a state
machine.

---

## 8. Enforcement

| Test | Pins |
| --- | --- |
| `tests/test_role_dm.js` / `test_role_dm_smoke.js` | Role DM / relationship-context behavior |
| `tests/test_disclosure_authorization.js` | `disclosureFacts` authorization behavior |
| `tests/test_socialnet_*` / `test_runtime_convergence_moments.js` | `pairAffinity` interaction weighting |

---

## 9. Historical Origin

`docs/ROLE_DM.md` (relationship review), `docs/DECISIONS.md` D13;
`docs/history/platform/ROLE_DM_RELATIONSHIP_PHASE4_AUDIT.md` (phase audit).
