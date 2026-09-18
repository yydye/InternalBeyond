# Disclosure Authoring Contract

**Status: Canonical**
**Scope: How a formal disclosure fact is authored (what a fact is), not whether it is disclosed**

> Current-state contract derived from `assets/js/disclosure-authoring-core.js`,
> `assets/js/social.js`, and `tests/test_disclosure_authoring.js`.

---

## 1. Core Rule

```
Fact authored  ≠  Fact disclosed
```

Authoring determines **what formal fact exists**; authorization determines **whether a recipient may
receive it** (separate contract).

---

## 2. Path

```
Authoring surface (social.js)
      │  writerContext + userInput
      ▼
validation / writer context   (disclosure-authoring-core.js)
      ▼
fact creation / update        (disclosure-store.js createFact / updateFact)
      ▼
Disclosure store
```

---

## 3. Writer Context

The authoring core takes **owner / source / authority from writer context**, never from untrusted
client input:

- `ownerCharacterId` is derived from `writerContext` only (a user editing character A cannot author a
  fact owned by B);
- `source` is the writer's provenance (`character_authoring` for this path);
- `authority` is the writer's write authority (`human_authoring` for explicit authoring);
- explicit authoring is limited to **gated levels** (`PERSONAL` / `PRIVATE` / `SECRET`); `PUBLIC` is not
  creatable by an explicit writer.

`writerContext` represents "the UI is editing character X"; it is not itself a claim of authority.

---

## 4. Validation

Authoring rejects: missing core (`authoring-core-unavailable`), bad writer context
(`bad-writer-context`), no writer owner (`no-writer-owner`), invalid level (`bad-authoring-level`), and
`PUBLIC` creation by an explicit writer (`public-not-creatable-by-explicit-writer`).

---

## 5. Production Authoring Surface

The production authoring surface found is `assets/js/social.js` (`_dscStore`), which invokes the
disclosure store/core/authoring modules. It is an **authoring/control surface**, not the Disclosure
authority.

---

## 6. Non-goals

This contract does not define authorization, storage schema, or the fact model (see sibling contracts).

---

## 7. Enforcement

| Test | Pins |
| --- | --- |
| `tests/test_disclosure_authoring.js` | writer context, validation, boundary (no disclosure in memory.js etc.) |

---

## 8. Historical Origin

`assets/js/disclosure-authoring-core.js` (Phase 4B-1.2); `DECISIONS.md` D30.
