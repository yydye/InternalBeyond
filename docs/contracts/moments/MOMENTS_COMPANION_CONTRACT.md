# Moments Companion Contract

**Status: Canonical**
**Scope: Companion ↔ Moments boundary**

> Current-state contract. Source: `active/moments.js` (Companion background Moments domain), returned
> events, and `tests/test_moments_companion.js`.

---

## 1. Core Rule

```
Companion executes Moments work   ≠   Companion owns Moments authority
```

---

## 2. Companion YES

`active/moments.js` owns:

- **background trigger** — a per-role recurrence schedule (`nextAt` / `lastPostAt` / `frequency` /
  `enabled` / `status`), mirroring the browser tick semantics without redefining frequency;
- **generation request** — calls the character model via `active/model-client` (`callCharacterModel`,
  `jsonMode`), with `proactiveTextSimilarity` dedup;
- **`wantImage` recommendation** — the model may recommend an image (`wantImage` / `imagePrompt`); this
  is a suggestion only;
- **event emission** — results are returned as `events` (`kind='moment'`) for browser reconcile
  (`moment_ids`), consistent with the active `/events` + `/ack` flow.

---

## 3. Companion NO

Companion does **not** own:

- persistence (the browser ingest persists through the Moments authority);
- ACL / visibility (Moments visibility core);
- image execution (no image interface calls; the browser Image Provider does it);
- storage or retrieval authority;
- the canonical record identity (`revision` / `revision` watermark from the service snapshot is used for
  reconcile, not authored by Companion).

---

## 4. Failure Posture

Companion Moments work is fail-open: any failure is recorded and rescheduled with backoff; it never
affects proactive messaging or task scheduling. Companion records only background failure / rejection /
deferral / placement facts as events — successful text is persisted by the browser ingest, so there is
no double-write.

---

## 5. Visibility

Companion requires the shared visibility core (`../assets/js/moments-visibility-core.js`) rather than a
mirror copy, so the two ends cannot drift.

---

## 6. Non-goals

This contract does not define Moments persistence, ACL, or sync. It does not grant Companion any
Moments authority.

---

## 7. Enforcement

| Test | Pins |
| --- | --- |
| `tests/test_moments_companion.js` | Companion ↔ Moments boundary |
| `tests/test_runtime_convergence_moments.js` | browser↔companion convergence (no double-write) |

---

## 8. Historical Origin

`active/moments.js`; boundary context in `docs/architecture/COMPANION.md`.
