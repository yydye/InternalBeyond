# R3 · Media Attribution / Image Queue Scope Closure

## R3 State: CLOSED

Closure date: 2026-09-21

## 1. Original risk and audit result

R3 was `CONFIRMED / DEFERRED`: `_ibImageDrain` was a global runtime array of bare `dataUrl` strings. Its single-chat, group-chat, and tool-continuation consumers removed all entries with `splice(0)` without checking conversation ownership. `_ibToolDrainImages` was a second derived image buffer that also lost the parent tool-result attribution.

The isolated runtime probe used the real loaded page in Chrome/CDP and the existing provider path. It seeded the historical bare-string queue shape, so it was a runtime probe rather than a real UI image-generation E2E. Before the fix:

| Scenario | Before queue | After wrong consumer | Wrong request contained image |
|---|---:|---:|---|
| conversation A → conversation B | 0 | 0 | yes |
| same actor, main conversation → different thread | 0 | 0 | yes |

The risk was real cross-conversation media consumption and loss, not a display-only false positive.

## 2. Root cause classification

R3 was both WHO + WHERE missing at the runtime queue boundary:

- WHO was absent from the old queue item even though the producer knew `cfg.id`.
- WHERE was absent from the old queue item even though the producer knew `friendId` and `threadId`.
- The destructive consumer had no way to distinguish an owner item from an unrelated conversation.

The current consume authorization is WHERE-based because the image is a conversation-context item. `actorId` is still captured and preserved for origin attribution and audit; display names are never used as identity.

## 3. Frozen contract and implementation

The contract is frozen in [R3-MEDIA-ATTRIBUTION-QUEUE-SCOPE-CONTRACT.md](/E:/InternalBeyond-main/docs/R3-MEDIA-ATTRIBUTION-QUEUE-SCOPE-CONTRACT.md).

Implemented surfaces:

- `workspace.js` captures `actorId`, `friendId`, and `threadId` at image origin time for generated/edited/read images.
- tool-result image children inherit the parent result's attribution.
- single chat, group chat, and tool continuation use the existing P30 canonical scope adapter and stable take/keep partitioning.
- legacy bare strings/objects without `friendId` fail closed and remain runtime-only; no current-conversation fallback is used.
- `chatMessages.images` and its existing `{dataUrl, base64, mime, name}` representation remain unchanged.

No Media Manager, Scope Registry, Event Bus, Universal Attribution Manager, image-router rewrite, provider API change, or schema migration was introduced.

## 4. Closure invariants

```text
wrong WHERE or legacy/unscoped → KEEP
right WHERE → TAKE
scope verification happens before destructive removal
matching and nonmatching relative order remains FIFO
```

`DB_VER` remains `24`; both affected queues are runtime-only.

## 5. Focused verification

`node tests/test_image_queue_scope.js` — 37 focused checks passed, including:

- A → B isolation and owner consumption;
- same actor / different conversation and different thread;
- cross-group isolation;
- wrong-consumer KEEP and owner TAKE;
- FIFO stable partition;
- legacy fail-closed behavior;
- tool-image attribution inheritance;
- no consume-then-filter;
- no duplicate image injection;
- no `[object Object]`/`undefined` prompt payload;
- canonical `chatMessages.images` unchanged;
- P29 identity, P30 conversation adapter, and DB version invariants.

## 6. Related regression

The focused change was also checked against the directly related surfaces:

- `node tests/test_workspace_conversation_scope.js` — 30 passed
- `node tests/test_workspace_actor_identity.js` — 50 passed
- `node tests/test_workspace_smoke.js` — passed
- `node tests/test_group_speaker_identity.js` — 50 passed
- `node tests/test_image_router_smoke.js` — passed
- `node tests/test_image_edit_smoke.js` — passed
- `node tests/test_moments_phase4_smoke.js` — passed
- JavaScript syntax checks for all changed runtime files and the focused test — passed

No full-suite run was needed under the IB test budget.

## 7. Runtime evidence level

`AUTOMATED_REAL-BROWSER VERIFIED`: the focused R3 test used a real local Chrome instance through the repository's CDP harness and observed actual provider request payloads and queue lengths.

This report does not claim computer-controlled manual UI verification. No `REAL_BROWSER_GATE_DEFERRED_BY_TOOLING` note is required because the automated real-browser gate was available and passed.

## 8. Final closure notes

The original scoped cross-conversation leakage/loss is no longer present in the audited consumers. The only retained compatibility note is intentional: legacy unscoped runtime items are not auto-injected and may remain until runtime reset/page unload. This is fail-closed behavior, not a semantic blocker.

P29 remains logically frozen. P30 remains logically frozen. P23/P24 contracts were not reopened. R4 has not been audited or modified in this checkpoint.
