# HOME_NODE_CHAT — canonical chat authority

**Stage:** M1-A · Canonical Chat Authority + Node Execution Seam
**Status:** landed. Companion documents: `docs/CHAT_MESSAGE_CONTRACT.md` (the frozen field
table) and `MOBILE_HOME_NODE_AUDIT.md` (the M0 audit this stage implements).

> Source beats prose. Where this file disagrees with `docs/ARCHITECTURE.md`,
> `docs/HANDOVER.md` or `docs/SOCIAL_RUNTIME.md`, this file describes what the code does
> today and the others are stale. Every claim below carries a `file:line`.

---

## 1. Canonical ownership

Before M1-A the world lived in exactly one place: the browser's IndexedDB
(`assets/js/core.js:3`, `InternalBeyondDB` v23, 32 object stores). No file under
`services/`, `bridge/`, `active/` or `runtime/` ever read or wrote `chatMessages`.

M1-A moves **authority over chat records** to the Home Node, and nothing else.

| Role | Who | What that means |
|---|---|---|
| **Authority** | Home Node (`services/home-node-service.js`, port **23118**) | Owns the canonical SQLite store, allocates `revision`, owns the change log, owns idempotency. A field that did not come from here is not an authority value. |
| **Mirror** | Browser IndexedDB `chatMessages` | A **derived** replica. It exists for read performance (91 read sites, 14 of them full-table scans with inline base64 images) and as a rollback shadow. It can be rebuilt from the Home Node at any time (`IB.homeNode.rebuildMirror()`). |
| **Fallback** | Degradation path | Reads keep working from the mirror (possibly stale) and are marked degraded. Writes **fail closed** — see §8. |

```
                       ┌─ Desktop Browser   (localhost privileged client)
Canonical Home Node ───┼─ Android            (M1-B/M1-C — deliberately NOT in this stage)
                       └─ Future clients
```

### 1.1 One implementation, two hosts

Per D10 (`docs/DECISIONS.md:58-60`) there is **one** implementation of every shared rule,
loaded by both a browser `<script>` tag and Node `require()`:

| Module | Hosts | Contains |
|---|---|---|
| `assets/js/chat-core.js` | browser + Node | message contract, strict validation, canonical id shapes, derived conversation identity, idempotent id derivation |
| `assets/js/ib-model-core.js` | browser + Node | provider request build, response parse, **SSE stream parse** (`createStreamParser`) |
| `assets/js/provider-directory.js` | browser + Node | the only provider/model capability truth |
| `assets/js/chat-authority.js` | browser + Node (Node: tests only) | authority/mirror/fallback policy, migration, sync |

There is deliberately **no** `browser-chat-core.js` / `node-chat-core.js` pair.

---

## 2. Where the data lives

```
%LOCALAPPDATA%\InternalBeyond\home-node\home-node.db          ← canonical (SQLite, WAL)
%LOCALAPPDATA%\InternalBeyond\home-node\home-node.bak-*.db    ← online backup (VACUUM INTO)
%LOCALAPPDATA%\InternalBeyond\home-node\home-node.corrupt-*.db ← quarantined corrupt file
```

Resolution order (`services/home-node-service.js`):

1. `IB_HOME_NODE_DATA_DIR` (tests, isolation)
2. `%LOCALAPPDATA%\InternalBeyond\home-node` on Windows, `~/.internal-beyond/home-node` otherwise

This follows the existing convention shared with the Active companion
(`active-message-service.js:28-31`) and the Bridge (`bridge/config.js:17-19`): **state lives
outside the repository** — never in the repo directory, never in the installer payload.

Other environment knobs, all optional:

| Variable | Default | Meaning |
|---|---|---|
| `IB_HOME_NODE_PORT` | `23118` | listen port |
| `IB_HOME_NODE_HOST` | `127.0.0.1` | bind host — **loopback by default and by design** |
| `IB_HOME_NODE_TOKEN` | *(empty)* | when set, every request must carry it (header or query) |
| `IB_HOME_NODE_ORIGINS` | *(empty)* | extra CORS origins beyond `null` (file://) and loopback |
| `IB_HOME_NODE_TRACE` | *(unset)* | `1` logs one line per inbound request (method/path/origin only) |

Browser-side switch (`localStorage`, private keys, never exported):

| Key | Values | Meaning |
|---|---|---|
| `ib_home_node_http` | URL | Home Node base URL (same convention as `ib_bridge_http`) |
| `ib_home_node_mode` | `canonical` (default) / `mirror` / `off` | `mirror`/`off` restore pre-M1-A local-only behaviour |
| `ib_home_node_token` | string | optional token |

**Rollback in one line:** `localStorage.setItem('ib_home_node_mode','mirror')` then reload.
That restores the exact pre-M1-A read/write path; nothing is deleted, and the Home Node
store is left untouched for a later re-enable.

---

## 3. Schema

`services/home-node/chat-store.js`, schema version **1** (`meta.schema_version` +
`PRAGMA user_version` both recorded; a newer stored version refuses to open rather than
degrade silently).

```sql
CREATE TABLE messages (
  id             TEXT PRIMARY KEY,     -- the EXISTING canonical id, never regenerated
  conversation_id TEXT NOT NULL,       -- derived: dm:<friendId>[|<threadId>] / group:<groupId>[|<threadId>]
  friend_id      TEXT NOT NULL,        -- kept verbatim so `byFriend` reads stay exact
  thread_id      TEXT NOT NULL DEFAULT '',
  role           TEXT NOT NULL,
  content        TEXT NOT NULL DEFAULT '',
  timestamp      INTEGER NOT NULL,
  insert_seq     INTEGER NOT NULL,     -- per-database monotonic write counter
  revision       INTEGER NOT NULL,     -- revision at which this row was last written
  created_rev    INTEGER NOT NULL,
  deleted_at     INTEGER,              -- soft-delete tombstone
  deleted_rev    INTEGER,
  payload_json   TEXT NOT NULL         -- the authoritative record, byte-for-byte
);
CREATE INDEX idx_messages_conv   ON messages (conversation_id, timestamp, insert_seq);
CREATE INDEX idx_messages_friend ON messages (friend_id, thread_id, timestamp, insert_seq);
CREATE INDEX idx_messages_rev    ON messages (revision);

CREATE TABLE change_log (revision INTEGER PRIMARY KEY, kind TEXT, message_id TEXT,
                         conversation_id TEXT, at INTEGER);
CREATE TABLE idempotency (key TEXT PRIMARY KEY, kind TEXT, message_id TEXT, at INTEGER);
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
```

### 3.1 Why the columns are what they are

* **Only query-critical fields are columns.** `images`, `files`, `voice`, `metadata`,
  `reasoning_content`, `wsSearches`, `memOps`, `calNotes`, `truncated`, `withdrawn`, and any
  field this project has never heard of live in `payload_json` and round-trip **unchanged**.
  Reads return the stored payload, not a re-projection, so an unknown field survives a write.
* **The 20-column mechanical mapping was rejected.** The contract
  (`docs/CHAT_MESSAGE_CONTRACT.md` §2) has 5 required, 13 conditional and 2 legacy fields,
  two of which are attachment blobs. One column per field would be a schema that changes every
  time a surface adds a metadata tag.
* **`id` is never regenerated.** All five producer shapes
  (`msg_<ms>_u`, `msg_<ms>_<rand>`, `msg_<ms>_<rand>_<i>`, `msg_sys_<ms>_<rand36>`,
  `active_<settingId>_<scheduledFor>`) are stored verbatim. Re-keying would break
  `favorites.sourceId` (`favorites.js:17-33`), notification deep links, and the proactive
  `message_id` dedupe (`active-diary.js:1301-1302`).

### 3.2 Two runtime facts that shaped the implementation (both measured)

1. **`node:sqlite` binds JS numbers as REAL.** `typeof(?)` comes back `'real'`, and a REAL is
   greater than any INTEGER in SQLite's ordering, so `timestamp < ?` against an INTEGER column
   is silently wrong. **Every** numeric binding goes through `intOf()`
   (`services/home-node/chat-store.js`).
2. **A composite TEXT sort key does not work either.** Bound string comparison in
   `node:sqlite` can fall back to numeric ordering: `SELECT ? < ?` returns `0` for
   `('z','a')` **and** for `('~0ru','~0rt')`, while column-vs-column comparison is correct.
   Ordering is therefore built on `INTEGER (timestamp, insert_seq)` with a keyset predicate,
   verified exact in both directions and across same-millisecond ties in both shipped runtimes
   (v24.9.0 and the bundled v24.18.0).

---

## 4. Revision / cursor model

* One **monotonic integer `revision`**, allocated inside the same transaction as the write,
  persisted in `meta.revision`, and mirrored into `change_log.revision`. It is never reused,
  never renumbered and never gap-compacted. `getRevision()` takes the max of the meta value and
  `MAX(change_log.revision)`, so an outside edit to one of them cannot rewind it.
* **Every** canonical mutation appends exactly one `change_log` row: `kind='upsert'` or
  `kind='delete'`.
* `changesAfter(cursor, {limit})` returns `{cursor, revision, upserts[], deletes[], hasMore}`.
  Upserts carry the full message; deletes carry only `{messageId, conversationId, revision}`.
  A gap in revision numbers is **not** an error.
* Writes are idempotent two ways:
  * **by message id** — an identical payload is a no-op and the revision does **not** move
    (`outcome:'skipped'`). This is what makes a repeated migration free.
  * **by `requestId`** — a transport-level retry returns the original `messageId`
    (`outcome:'duplicate-request'`) with no second write. LRU-bounded (1000 entries / 24 h).
* Deletes are **soft** (tombstones). Hard-deleting would make "deleted" indistinguishable from
  "never existed", and a future mobile client could then never be told that an id is gone.
  All read paths default to excluding tombstones, so behaviour matches a hard delete.

### 4.1 Pagination

`listMessages({conversationId|friendId, threadId, cursor, before, after, limit})`

* **Default (no cursor)** returns the **newest** page, time-ascending — "open the conversation
  and see recent messages".
* `cursor=<oldest>` continues **backwards** (load older). `cursor=<cursor>` moves forwards.
* `before` / `after` take a message id, a millisecond timestamp, or a `{id}` / `{timestamp,insertSeq}`
  object and are **exclusive** bounds.
* `hasOlder` / `hasNewer` / `hasMore` are distinct; `hasMore` aliases `hasOlder`.
* `limit` defaults to 50 (matching the audit's `chat.history` contract) and is capped at 500.

---

## 5. Browser compatibility layer

The browser keeps working because authority moved at the **data-access boundary**, not at the
91 call sites.

```
assets/js/core.js          →  window.__ibCoreDb  (unwrapped helpers + mirror bulk writers)
assets/js/home-node-bootstrap.js
                           →  replaces dbPut / dbGet / dbGetAll / dbGetByIndex / dbDelete
                              for the `chatMessages` store ONLY, and only in canonical mode
assets/js/chat-authority.js →  the policy: authority / mirror / fallback, migration, sync
assets/js/home-node-client.js → the single HTTP implementation
```

Every other store, and every other call site, is untouched — the 14 full-table `dbGetAll`
reads, the 30+ `byFriend` reads, `favorites`, `calendar`, `coread`, the summary/annotation/
letter paths, and the eight delete sites all keep their exact semantics and return shapes.

**Read path:** if the mirror has been hydrated, reads are served from the mirror (it is a
materialised replica kept current by `changesAfter` plus local write-through). Before the first
hydration, or while the Home Node is unreachable, reads are marked degraded but still work.

**Write path:** `Home Node → mirror`, always in that order. A mirror failure does **not** undo a
Home Node success: the result is reported as `authority:'home-node', mirrored:false`, and a
`mirror-write-failed` entry is logged. A Home Node failure is fail-closed (§8).

**Sync:** one sync at boot, re-run on `visibilitychange` and `online`, plus a successful write.
There is deliberately **no `setInterval`** — a resident timer would keep the test harness from
exiting naturally (`MEMORY.md` test discipline).

**Full-history caveat:** the boot sync seeds the newest `MAX_LIST_LIMIT` messages and then moves
the cursor to the server revision. Older-than-seed history is therefore not in the mirror until
it is asked for; `status().hasFullHistory` reports this honestly rather than pretending.

### 5.1 ⚠️ `file://` cannot reach the Home Node (platform limit, not a bug)

Chrome blocks `file://`-origin pages from calling loopback services **at the network layer**.
Measured: the request never reaches the server (the service's own request trace shows nothing),
`Network.loadingFailed` reports `corsError: MissingAllowOriginHeader` /
`PreflightMissingAllowOriginHeader`, and neither a correct `Access-Control-Allow-Origin` nor
`Access-Control-Allow-Private-Network` changes it.

So:

* **The normal launch path works.** `runtime/launch-internal-beyond.js:19` opens
  `http://127.0.0.1:23120/InternalBeyond.html`, and from that origin the Home Node is fully
  reachable (verified end to end in `tests/test_m1a_chat_authority_smoke.js`).
* **Double-clicking `InternalBeyond.html` degrades safely.** `assets/js/home-node-bootstrap.js`
  detects `location.protocol === 'file:'`, warns in the console, and the authority layer keeps
  `chatMessages` on local IndexedDB with `status().degradedReason === 'file-origin-cannot-reach-home-node'`.
  Desktop chat keeps working; it simply does not claim Home Node authority it cannot have.

The Home Node's CORS policy is set accordingly (`services/home-node/http.js`): `Origin: null`
(file://) and loopback origins are echoed **when no token is configured**; a hostile origin is
never echoed; and configuring `IB_HOME_NODE_TOKEN` stops trusting `null` entirely, so every
request including the local one must authenticate.

---

## 6. Execution seam

`services/home-node/execution.js` → `executeCharacterTurn(request, options)` is the Home Node's
single character-turn entry point.

```
input    { requestId (required), character:{id, spec:{provider,model,endpoint,apiKey,systemPrompt}},
           userMessage, history[], runtimeContext, contextPolicy, maxTokens, temperature,
           reasoningEffort }
options  { onEvent, signal, timeoutMs, turnId }
events   start → ({type:'delta', kind:'reasoning'|'content', text, index})* → done | error
output   { ok, outcome, turnId, conversationId, userMessageId, assistantMessageId, revision,
           text, reasoning, message }
```

* **Both** the user message and the assistant message are written to the canonical store.
* Idempotent: replaying the same `requestId` returns the original `userMessageId` and does
  **not** call the model again (asserted by call count in `tests/test_home_node_execution.js`).
* One in-flight turn per `conversationId`; a second request gets `busy` (never queued).
* Empty output (no text and no reasoning) is rejected as `empty-output` rather than stored as
  an empty bubble.
* `abort` with partial text persists a `partial:true` assistant record (the browser's
  non-empty-partial rule, `communication.js:3796-3799`); abort with no text persists nothing.
* Errors are classified into a closed vocabulary: `abort`, `timeout`, `provider-error`,
  `empty-output`, `busy`, `character-not-ready`, `invalid-message`, `store-write-failed`.

> ⚠ **`character.spec.systemPrompt` is the single source of truth for the persona.**
> The lifecycle caller (`mobile-gateway.js`) passes `character: { id, spec }` — there is **no**
> top-level `character.systemPrompt`. `buildPrompt()` must resolve `spec` with the same
> `character.spec || character` rule as `executeCharacterTurn()`, and it keeps the top-level read
> only as a compatibility fallback. Reading the top-level field alone silently dropped the whole
> persona and sent an empty system prompt on the wire (GLM then answered as its pretrained default
> identity — it claimed to be Claude). Do not "simplify" either read away. Full post-mortem:
> [TROUBLESHOOTING.md](TROUBLESHOOTING.md) T42; the rule it produced: [DECISIONS.md](DECISIONS.md) D23.
>
> The regression tests pin this on the **production input shape** (top-level `systemPrompt`
> deliberately absent) in `tests/test_home_node_execution.js`, and on the real
> publish → pair → send → provider-wire E2E in `tests/test_mobile_thin_client.js`. When adding an
> assertion here, assert on the **wire body the provider actually received** — not on call counts,
> and not on a hand-built input the function happens to like.

### 6.1 Provider path and streaming

`executeCharacterTurn` → `NodeModelPort.runStream` (`active/node-model-port.js`) →
`IBModelCore.buildRequestBody` + `IBModelCore.createStreamParser` (`assets/js/ib-model-core.js`).

The wire formats are interpreted in **exactly one** place, `createStreamParser`:

| Format | Streaming behaviour |
|---|---|
| `openai` (and compatible) | `body.stream = true` + `stream_options.include_usage` (skipped for MiMo, which rejects it) |
| `anthropic` | `body.stream = true`; `thinking_delta` → reasoning, `text_delta` → content |
| `gemini` | `generateContent` → `streamGenerateContent` + `alt=sse` |
| `responses` | `response.output_text.delta` / `response.reasoning_summary_text.delta` |

Tolerance: incomplete lines stay buffered (never a half-parsed JSON), a malformed line is
counted and dropped and never aborts the stream, unknown event types are ignored, `[DONE]` and
SSE comments are handled, and a provider error object inside the stream surfaces as
`kind:'provider-stream'`. `finish()` returns the same shape as `parseResponse`, so callers treat
streaming and non-streaming identically. `run()` (non-streaming) is unchanged and still used by
the proactive path.

Anthropic-specific correctness note: usage arrives split across `message_start` (input tokens)
and `message_delta` (output tokens), so the merge only writes fields that actually appeared —
zero-filling the missing half used to clobber the real value.

### 6.2 Middle Brain boundary (Phase 10, Strategy A)

**Current MB ownership: the browser. Unchanged by this stage.** Middle Brain remains six
browser-only IIFEs loaded via `<script>` (`InternalBeyond.html:2996-3001`) that dereference
`window`, `document`, `dbGet`/`dbPut` and `localStorage`; they cannot be `require`d, and
`middleBrainExecute` is a context-organisation seam that never calls a model
(`middle-brain.js:159-172`).

The desktop single-chat path therefore keeps its existing Middle Brain preprocessing
**unchanged**: `sendChatMessage` builds context, applies Middle Brain, streams, runs tools,
applies memory ops, and only then writes the final assistant record — which now goes to the
Home Node. **No desktop behaviour was lowered.**

The Home Node execution seam does not claim MB parity. `request.contextPolicy` is a **required,
honest** label (`'browser-provided-context'`, `'unspecified'`, …) that is copied into the
assistant record's `metadata.contextPolicy` and echoed in the `done` event, so a future client
can tell what context quality it got instead of being silently served a thinner prompt.

**Future Node migration seam:** everything a Node-side MB would need already has a home —
`createStreamParser` and `buildRequestBody` for the wire, `chat-authority` for policy, and
`executeCharacterTurn`'s `runtimeContext`/`contextPolicy` inputs for context. When MB moves,
it moves as one unit behind that seam; it is not re-derived.

### 6.3 Group chat

Group chat **storage authority is not split** — `friendId = 'group_<ms>'` records go through the
same `dbPut` seam and land in the same canonical store under the `group:` namespace, so desktop
and future clients read one history. Its *execution* remains the browser's serial in-process
turn-taking loop (`communication.js:1716`), which is a temporary compatibility path: moving that
loop to Node is a later stage, and doing it piecemeal would fork turn-taking semantics.

---

## 7. Migration (IndexedDB → Home Node)

One-shot, **idempotent, repeatable, resumable**, exposed as `IB.homeNode.migrate()`.

```
Browser IndexedDB chatMessages
      ↓  sorted by (timestamp, id), batched (default 200, max 500)
POST /messages { messages:[…], existingPolicy:'skip' }   (HTTP seam, not a new protocol)
      ↓
Canonical SQLite
      ↓  /migrate marker: {source, version, lastTimestamp, messages}
```

Guarantees, each asserted in `tests/test_chat_migration.js`:

| Guarantee | How |
|---|---|
| message ids preserved | ids are sent verbatim; the store never re-keys |
| no duplicate inserts | identical payload → `skipped`, revision does not move |
| never overwrites newer Node data | `existingPolicy:'skip'` — an existing different record is reported `skipped`, not overwritten |
| repeatable | re-running is safe and produces `created:0` |
| resumable after interruption | the marker is written **only** on success; a failed run reports `failedAt` and leaves the watermark where it was, so the next run replays safely |
| no double counting on retry | each migration *attempt* gets its own `requestId` namespace, so a re-run gets real statistics while in-run retries stay idempotent |
| IndexedDB is **never** cleared | the mirror is the rollback shadow; migration only reads from IndexedDB |

**Where to run it:** the Home Node must be reachable. It cannot be driven from a `file://` page
(§5.1); open the app through the launcher, then call `IB.homeNode.migrate()` from the console, or
from a helper UI. Migration from `file://` is impossible for the same platform reason, and is not
silently attempted.

**Note on `existingPolicy:'skip'`:** it protects Home Node data, and the coupling cost is that an
offline browser edit made *during* migration is not carried over by that run. That is acceptable
because once authority has moved, such an edit is written through the Home Node in the first
place; the migration window is the only moment it can be missed, and re-running with
`existingPolicy:'overwrite'` (the store's default for non-migration writes) would resolve it.

---

## 8. Failure behaviour (Phase 16)

### 8.1 Home Node offline

| Aspect | Behaviour |
|---|---|
| reads | continue from the mirror; result carries `authority:'home-node'`, `readFrom:'mirror'`/`'mirror-degraded'`, and `status().degraded === true` with a `degradedReason` |
| writes | **fail closed.** The promise rejects with `code:'home-node-offline'`, the write never touches IndexedDB, and `status().stats.failures` increments. There is deliberately **no** silent local write, because that is exactly the second canonical store M1-A exists to remove (audit §1.7, R7). |
| user-visible result | the send fails; the desktop does not pretend it succeeded. The error carries a `hint` explaining that writes are stopped and no second copy was written. |
| recovery | the next write or `IB.homeNode.sync()` re-probes. There is no background timer; `visibilitychange` and `online` trigger a resync. |

> **Deliberate trade-off.** A user who wants chat to keep working while the Home Node is down
> can set `ib_home_node_mode = 'mirror'`. That is an explicit, reversible choice to run without
> Home Node authority — not a silent fallback, and `status().authority` then reports `'indexeddb'`.

### 8.2 SQLite corrupted

On open, the store runs `PRAGMA quick_check` **before** connecting to the live file. On failure:

1. the corrupt file **and its `-wal`/`-shm` sidecars** are renamed (never deleted) to
   `home-node.corrupt-<ISO timestamp>.db`;
2. a fresh database is created and opened;
3. a `corrupt-quarantined` line is logged at loud level and `open()` returns
   `recoveredFromCorrupt:<path>`.

Data is therefore never destroyed, the desktop is never stuck, and the situation is
explainable rather than presenting as "my history vanished". If the rename itself fails
(permissions), `open()` throws `CORRUPT_CANNOT_QUARANTINE` — writing on top of an unquarantined
corrupt file is worse than refusing to start.

**Backup:** `GET /verify?backup=1` (and `store.backup()`) produces a consistent online copy in
the same directory. It tries `node:sqlite`'s `backup()` first, validates the produced byte count,
and falls back to SQLite's native `VACUUM INTO` — measured behaviour is that `backup()` returns a
0-byte file on this runtime, and on Windows the empty file it leaves behind is held open and
cannot be renamed over, so the fallback target is used directly and its real path is returned.

**Integrity check:** `GET /verify` → `{integrity:{ok,result}, meta}`.

### 8.3 Home Node write succeeds, browser mirror write fails

Canonical remains the Home Node. The result is `{ok:true, authority:'home-node', mirrored:false,
mirrorError}` and a `mirror-write-failed` log entry. This is reported honestly rather than as a
plain success, and the mirror self-heals on the next `sync()` (`changesAfter` re-applies the
change).

### 8.4 Browser sends the same request twice

Two independent guards:

* **Transport level:** `requestId`. `POST /messages {requestId}` and `executeCharacterTurn`
  both return the original `messageId` with `outcome:'duplicate-request'`, and the model is not
  called again. Survives a process restart because the mapping lives in the SQLite
  `idempotency` table.
* **Content level:** the existing `message_id` existence guard
  (`active-diary.js:1301-1302`) is preserved unchanged, so a re-delivered proactive event still
  cannot create a duplicate.

`chat-core.js` additionally provides `messageIdFromRequest(requestId)` — a deterministic
`msg_req_<token>_u` id — for paths that must be retryable from scratch. The five pre-existing id
shapes are untouched.

### 8.5 Other cases

| Case | Behaviour |
|---|---|
| concurrent turns, same conversation | second gets `busy` (409); never queued |
| stale cursor | `changesAfter` from an old cursor is always safe (revision is monotonic and never renumbered) |
| store closed / schema too new | explicit error (`store-closed` / `SCHEMA_TOO_NEW`), never a silent rebuild |
| malformed `payload_json` | read returns a readable placeholder with `__malformedPayload:true` plus the schema-required columns; it never throws and never returns a half-object |
| Home Node absent at page load | page loads normally; `authority.hydrated` stays false and `degradedReason` is set |

---

## 9. Proactive (Active companion) messages

The existing flow is unchanged on the Node side of Active:

```
scheduler → generateProactiveMessage → NodeModelPort.run → state.events[eventId]   (durable outbox)
                                                                    ↓  GET /events?user_id=
browser  → dbGet('chatMessages', msgId) guard → dbPut('chatMessages', …) → POST /events/:id/ack
```

`dbPut` is now the canonical-write seam, so the proactive assistant record lands in the Home
Node store with its original `message_id`
(`active-diary.js:1301-1304`, `active-plans.js:474-476`). Nothing in `active/` or the scheduler
changed, and `message_id` dedupe plus per-event ACK semantics are preserved exactly.

`metadata.source = 'active_message'` and any `activePlanId` are carried verbatim, so a client can
tell proactive records apart without a new field.

**Deferred:** moving the outbox itself into the canonical store (`state.events` → change log) is
a later stage. M1-A only guarantees that proactive messages reach the same canonical store; the
transport that delivers them is still the Active poll queue.

---

## 10. Observability

Logs are structured, rotate through a 100-entry in-memory ring exposed at `GET /status`, and are
also written to stdout. Recorded events:

`opened` · `corrupt-quarantined` · `backup` · `backup-failed` · `listening` · `shutdown` ·
`put` (outcome/count/revision/conversationId) · `put-rejected` · `delete` · `migration-mark` ·
`turn-start` · `turn-done` (turnId/conversationId/revision/durationMs/contentLength) ·
`turn-error` · `turn-partial` · `turn-duplicate-request` · `unauthorized` ·
`rejected-non-loopback` · `unhandled`

Browser side: `IB.homeNode.log()` returns the same kind of ring (`boot`, `hydrate`, `sync`,
`sync-degraded`, `write`, `delete`, `probe`, `migrate-start`, `migrate-done`, `migrate-fail`,
`mirror-write-failed`, `write-fail-closed`, `authority-disabled`).
`IB.homeNode.status()` returns mode, authority, `remoteOnline`, `degraded`/`degradedReason`,
`hydrated`, `hasFullHistory`, `cursor`, `lastSyncAt` and counters.

**Never logged:** `apiKey`, `Authorization`/`Bearer` values, `X-IB-Home-Token`, provider
endpoints, system prompts, memory bodies, or message content.
`services/home-node-service.js:redact()` masks credential-shaped strings as a second line of
defence, and the HTTP layer's request trace records only method/path/origin.
`tests/test_home_node_http.js` asserts the status ring contains neither a message body nor the
configured token.

---

## 11. Security boundary

**Loopback only.** `127.0.0.1` by default; a non-loopback request is rejected
(`loopback-only`, 403) unless the process was explicitly configured otherwise. LAN exposure,
device identity and pairing are M1-B/M1-C and are **not** implemented here (audit §10).

**Not the Mobile Gateway.** The service does not import `bridge/routes.js`, so it has no
`/api/llm-proxy`, no tool table, no payment verbs, no TTS, no memory/moments/diary/letters/image
routes. `GET /security` states this in the response itself, and
`tests/test_home_node_http.js` asserts those paths 404.

**Accepted risk, stated plainly.** With no token configured, CORS echoes `Origin: null`
(file:// pages) and loopback origins, so any local page — including a hostile one, or a
sandboxed iframe that yields `Origin: null` — can read and write the canonical chat store over
loopback. This is within D1's stated risk acceptance for a single-user local application
(`docs/DECISIONS.md:6-13`) and is narrower than the Bridge's existing
`Access-Control-Allow-Origin: <requester>` behaviour, but it is a real exposure and it grows
with what the store contains. Setting `IB_HOME_NODE_TOKEN` closes it (all requests, including
the local file:// one, must authenticate). Tightening the default is a candidate for its own
decision record; it is **not** bundled into this stage.

**Not in scope and not changed:** the audit's R5/§3.11 SSRF finding in `POST /api/llm-proxy`
(`bridge/routes.js:195-258`) is untouched, and no mobile client can reach it, because the
gateway does not exist yet and the Home Node does not proxy caller-supplied URLs.

---

## 12. Tests

| File | Group | Covers |
|---|---|---|
| `tests/test_chat_core_contract.js` | static | every production write shape validates; five id shapes; conversation identity round-trip; validation vocabulary; deterministic `requestId→messageId`; unknown fields preserved |
| `tests/test_chat_authority.js` | static | authority/mirror/fallback policy: write order, fail-closed offline writes, mirror-failure reporting, rejection vs. offline, `mirror`/`off` modes, migrate idempotency and watermark |
| `tests/test_chat_migration.js` | static | real store + mock HTTP: empty DB, seeded DB, duplicate migration, interruption/resume, mixed threads, images/files/voice payloads, malformed JSON, marker persistence across restart |
| `tests/test_home_node_execution.js` | service | real SSE mock provider → `runStream` → `executeCharacterTurn` → store: delta order and indices, usage passthrough, canonical double-write, idempotent replay (one model call), `busy`, provider error, abort with/without partial, attachments reaching the request, restart-safe idempotency |
| `tests/test_home_node_http.js` | service | 73 checks over real HTTP: health identity, token auth, idempotency, batch atomicity, keyset pagination both directions including same-millisecond ties, change-log cursors, delete semantics, repeatable migration marks, backup, corruption quarantine, integrity, hostile-origin CORS, boundary routes 404 |
| `tests/test_home_node_service.js` | service | module require without listening, injected port/dataDir, bad dataDir fails loudly, runner registration and identity probing, isolation branches, no resident timer |
| `tests/test_m1a_chat_authority_smoke.js` | browser | real Home Node process + real model endpoint + real `sendChatMessage` over `http://127.0.0.1:…`: user and assistant messages land in the canonical SQLite store, revision advances, mirror holds the same ids, and with the Home Node stopped writes are refused while the mirror is unchanged |
| `tests/test_lan_bridge_auth_contract.js` | static | R19/§3.14 LAN auth parity (separate commit) |

Run the targeted set:

```
node tests/test_chat_core_contract.js
node tests/test_chat_authority.js
node tests/test_chat_migration.js
node tests/test_home_node_execution.js
node tests/test_home_node_http.js
node tests/test_home_node_service.js
node tests/test_m1a_chat_authority_smoke.js --browser
```

---

## 13. Known deferred domains

Not migrated, not read by Node, and deliberately absent from every M1-A surface:

| Domain | Where it still lives | Note |
|---|---|---|
| **Middle Brain** | browser only, 6 `<script>` modules | §6.2. No Node path exists and none is pretended. |
| **Memory** | browser `memories`/`autoMemory`/`understandings`/`threads` | Node still receives only a pre-ranked ≤8-row snapshot inside Active task payloads. |
| **Moments** | browser `moments` (+ Active schedule state) | |
| **Diary** | browser `diary_entries` | |
| **Letters** | browser `letters` / `roleLetters` / `roleLetterMemories` | |
| **Image generation / Image Router** | browser `workspace.js` + `image-router*.js` | |
| **Voice / video runtime** | transport and TTS/ASR are Node-side in the Bridge; the character turn is not | audit §4.9. |
| **Group chat execution** | browser serial loop | storage already canonical (§6.3). |
| **Proactive outbox** | Active `state.events` | proactive *records* are canonical; the queue is not (§9). |
| **Mobile Gateway / Android** | does not exist | next stage, on top of this. |
| **Credentials** | browser `apiConfigs` (plaintext) + Node vault | unchanged; the Home Node stores no credentials. |

---

## 14. Operational summary

```
start:      node services/home-node-service.js      (registered in runtime/local-services-runner.js as "HomeNode")
health:     GET  http://127.0.0.1:23118/health      → {service:'internal-beyond-home-node', role:'canonical-chat-authority'}
meta:       GET  /meta        status/rev          GET /status        conversations  GET /meta
read:       GET  /message?id=   GET /list?conversationId=&limit=&cursor=
sync:       GET  /changes?cursor=            migrate mark  POST /migrate   GET /migration?source=
write:      POST /messages {message|messages[], requestId?, existingPolicy?}    DELETE /message?id=
integrity:  GET  /verify      (+ ?backup=1)   boundary      GET /security
execute:    POST /turn {requestId, character, userMessage, history, …}          (non-streaming envelope)
browser:    IB.homeNode.status() / .sync() / .probe() / .migrate() / .rebuildMirror() / .log()
browser:    IB.chatAuthority.instance  — the policy object itself
```
