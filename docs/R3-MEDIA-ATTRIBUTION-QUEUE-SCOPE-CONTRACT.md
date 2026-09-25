# R3 · Media Attribution / Image Queue Scope Contract

Status: CONTRACT FROZEN

Scope: runtime image queues only. This contract is independent of R4 workspace file provenance.

## 1. Evidence

### Static evidence

The audit found two runtime media buffers that can reach a model prompt:

| Queue | Current producer | Current item | Current consumer |
|---|---|---|---|
| `_ibImageDrain` | `workspace.js` `gen_image`/`edit_image` and `read_image` | bare `dataUrl` string | single chat, group chat, and workspace-tool continuation in `communication.js` |
| `_ibToolDrainImages` | images copied from the already queued `_ibToolPendingResults` item | bare image string | single chat and group chat; tool continuation did not consume this buffer |

`_ibImageDrain` is declared in `site-operations.js` and is not written to IndexedDB, `localStorage`, export/import data, or Home Node. It is runtime-only. The same is true of `_ibToolDrainImages` and `_ibToolPendingResults`.

The existing scope adapter is `_ibWsScopeFilter(friendId, threadId)`, whose comparison path is `_ibConvId` → `IBChatCore.conversationIdOf`. Existing P30 filtering applies to workspace text/tool feedback queues, but the two media buffers were still consumed with `splice(0)` and no scope predicate.

### Runtime probe evidence

An isolated runtime probe used the real loaded page in Chrome/CDP, seeded the existing queue with the historical bare-string shape, and sent through the existing provider path. It is not a real UI image-generation E2E.

Observed before implementation:

| Scenario | Before queue | After queue | Wrong request contained image |
|---|---:|---:|---|
| Role/conversation A → unrelated Role B | 0 | 0 | yes |
| Role B main conversation → Role B thread Y | 0 | 0 | yes |

The result confirms a real cross-conversation consume/loss risk, not a naming-only false positive.

## 2. Producer Inventory

| Producer | Category | Actor at origin? | WHERE at origin? | Persistence |
|---|---|---|---|---|
| `_execWsOps` successful `gen_image` / `edit_image` | AI generated / image edit result | `cfg.id` when a config object exists | `ictx.friendId` + `ictx.threadId` when supplied | runtime queue; canonical assistant message separately persists generated image |
| `_execWsOps` successful `read_image` | workspace/tool-generated image read | `cfg.id` when available | `ictx.friendId` + `ictx.threadId` when supplied | runtime queue; source file is separately persisted in `projectFiles` |
| `_ibToolPendingResults[*].images` → `_ibToolDrainImages` | external tool image | parent result already carries `actorId` and scope where producer had them | inherited from parent result; no consumer-time guessing | runtime only |
| `_pendingImages` | user uploaded / selected image | human user; no role actor attribution required | bound to the target conversation at send capture | user `chatMessages.images` plus request-local prompt parts |
| `image-edit.js` selection/reference candidates | image edit selected image / vision input | inherited from explicit selection or canonical message | selection is conversation-tagged; history lookup is by friend/thread | in-memory selection or existing canonical message |
| `sentImages` / `visionReference` | temporary request-local vision input | current request | current request only | not a global queue; no R3 mutation |
| workspace run `images` | script-generated chart/image | script operation | run output item already carries workspace scope | UI/run output only; not an image prompt queue |

No other production `_ibImageDrain.push` producer was found. `_ibToolDrainImages` is not an independent origin; it is a derived child buffer and must inherit the parent result attribution.

## 3. Consumer Inventory

| Consumer | Queue | Destructive operation | Frozen behavior |
|---|---|---|---|
| single-chat prompt construction | both media buffers | currently `splice(0)` | stable scope partition before removal |
| group-chat prompt construction | both media buffers | currently `splice(0)` | stable scope partition before removal |
| `_wsToolContinue` | `_ibImageDrain` and derived tool-image buffer | current image path removes all image-drain items | same partition using the continuation's captured friend/thread |

The consumer must never infer ownership from active UI state, display name, or actor identity.

## 4. Runtime Item Shapes

Scoped `_ibImageDrain` items become additive objects:

```js
{
  dataUrl,
  base64?,
  mime?,
  name?,
  actorId?,
  friendId?,
  threadId?
}
```

The `dataUrl`/`base64`/`mime` image representation remains the existing runtime/canonical representation. No `conversationId` is stored or derived by a producer.

Scoped `_ibToolDrainImages` items use the same media fields and copy `actorId`, `friendId`, and `threadId` from the parent tool-result item. The child buffer is not allowed to collapse back to a bare string.

## 5. Canonical vs Runtime Boundary

`chatMessages.images` remains canonical and unchanged. Generated assistant messages continue to store image objects in the existing shape; message-level `friendId` and optional `threadId` already provide the canonical conversation boundary. User-uploaded images continue to use the existing user-message shape.

R3 changes only ownership metadata on the two ephemeral prompt-injection buffers. It does not add fields to `chatMessages.images`, `chat-core` message schema, `projectFiles`, or the image-provider wire format.

## 6. WHO Semantics

`actorId` is the canonical origin actor when the producer has a config object. It is captured at producer time and preserved into the runtime item. Display names are not used to derive it.

Current media semantics do not require producer WHO as an independent consumption authorization gate: an image belongs to the conversation context, and a same-WHERE group member may need to see that context. WHO is retained for attribution/audit and future actor-sensitive policy, while WHERE is the current consume gate.

Missing `actorId` is never reconstructed from a display label. It is allowed only as a legacy/diagnostic omission.

## 7. WHERE Semantics

When the producer has a conversation context, it captures `{friendId, threadId}` at origin time. The consumer compares the item with the current request through the existing canonical adapter:

```text
chat-core.conversationIdOf(item.friendId, item.threadId)
==
chat-core.conversationIdOf(currentFriendId, currentThreadId)
```

No consumer may derive WHERE from `actorId`, display name, or the current active conversation for an old item.

## 8. Legacy Policy

Bare strings and objects without a non-empty `friendId` are legacy/unscoped. They are fail-closed for automatic prompt injection: keep them in the runtime queue, do not assign the current conversation, and do not consume them merely because they are present.

This is safe for compatibility because the queues are ephemeral and are not persisted or restored across reload. A legacy item may remain until runtime reset/page unload; it must never cause cross-conversation disclosure. Scoped items behind it remain independently partitionable.

## 9. Destructive Queue Rule

The consumer first evaluates the scope predicate, then creates `take` and `keep` arrays, and only then replaces the queue with `keep`. Therefore:

```text
wrong WHERE or legacy/unscoped → KEEP
right WHERE → TAKE
```

There is no drain-all-then-filter path and no consume-then-hide path.

## 10. FIFO

Partitioning is stable. Relative order among matching items is unchanged; relative order among nonmatching and legacy items is unchanged. `_ibImageDrain` and `_ibToolDrainImages` remain separate queues.

## 11. Persistence / DB Decision

Both affected queues are runtime-only. `chatMessages.images` and workspace files are already persisted safely at their existing boundaries. No IndexedDB store, index, export/import schema, or Home Node schema changes are required.

`DB_VER` remains `24`.

## 12. Implementation Surface

Only these surfaces are in scope:

1. `assets/js/workspace.js`: capture actor and WHERE when enqueueing generated/read images.
2. `assets/js/site-operations.js`: preserve attribution when tool-result images become the derived image buffer.
3. `assets/js/communication.js`: stable scope partition for both media buffers in single chat, group chat, and tool continuation; normalize legacy/scoped items without stringifying objects.
4. focused R3 tests and closure documentation.

No new manager, registry, event bus, runtime, or schema layer is permitted.

## 13. Explicit Non-Goals

- no image-router/provider/API rewrite;
- no canonical `chatMessages.images` schema change;
- no image edit or vision resolver redesign;
- no P23 delivery change;
- no P24 group participation change;
- no P29 identity contract change;
- no P30 conversation contract change;
- no R4 `projectFiles.lastModifiedBy` work;
- no DB version bump.
