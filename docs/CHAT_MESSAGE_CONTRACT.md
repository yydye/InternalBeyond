# Chat Message Contract (canonical)

**Status:** frozen fact table for M1-A · every row is taken from source, not from prose.
**Repository:** `E:\InternalBeyond-main` · branch `master`
**Base commit:** `6db3a0e6c009b1208e500176cdd6111966aac922`

> Rule: source beats documentation. Where this file contradicts `docs/ARCHITECTURE.md`,
> `docs/HANDOVER.md`, `docs/SOCIAL_RUNTIME.md` or any README, **this file wins** and the other
> document is stale. Each claim carries `file:line`.

> Voice shapes/call architecture are documented canonically in
> [`architecture/VOICE.md`](architecture/VOICE.md) and [`contracts/voice/`](contracts/voice/).

---

## 1. The store

| Fact | Value | Evidence |
|---|---|---|
| Database | `InternalBeyondDB`, version **23** | `assets/js/core.js:3` |
| Object store | `chatMessages` | `assets/js/core.js:4` |
| `keyPath` | `id` (no autoIncrement) | `assets/js/core.js:4` |
| Indexes | exactly one — `byFriend` on `friendId`, non-unique | `assets/js/core.js:4` |
| Timestamp index | **none** — every time-ordered read happens in memory after a full `byFriend` fetch | e.g. `assets/js/communication.js:2026` (`.sort((a,b)=>a.timestamp-b.timestamp)`) |
| Attachment storage | inline base64 data URLs **inside the record**; no blob store, no FS store, no CDN | `assets/js/communication.js:1990` |
| Node reachability before M1-A | **zero** — no file under `services/`, `bridge/`, `active/`, `runtime/` read or wrote this store | repo-wide grep |

---

## 2. Field table

Legend — **R** required on every production write · **C** conditional (present only on some
surfaces, but canonical when present) · **L** legacy / read-only in practice · **S** surface-specific.

| Field | Type | Class | Written by | Notes |
|---|---|---|---|---|
| `id` | string | **R** | all writers | **Primary key.** Browser-generated only. Three literal shapes exist (see §3). Must never be regenerated. |
| `role` | `'user' \| 'assistant' \| 'system'` | **R** | all writers | `'system'` appears only as group membership events. |
| `content` | string | **R** (may be `''`) | all writers | Final text only. Streaming deltas are **never** persisted incrementally (`communication.js:2243-2304`). |
| `friendId` | string | **R** | all writers | **This is the conversation key today.** Either an `apiConfigs.id`, or a group id `group_<ms>`, or a proactive setting id. |
| `timestamp` | number | **R** | all writers | ms epoch. Not unique — collides at ms resolution; ordering therefore relies on array order for same-ms rows. |
| `reasoning_content` | string | **C** | assistant writes | `''` when the model returned no thinking. Saved for every assistant row, displayed per `metadata.showThinking`. |
| `threadId` | string | **C** | any writer when a topic channel is active | Absent ⇒ the main conversation. Present ⇒ a channel **inside** the same `friendId`. `filterSealed` treats the main conversation and channels with different seal rules (`communication.js:2026`). |
| `senderName` | string | **C → effectively R** | group rows | Mandatory on group assistant rows (`communication.js:1905`, producer `:2305`). Optional on 1:1. |
| `images` | array | **C** | user uploads + generated images | Uploads: `{dataUrl, base64, mime, name}` (`communication.js:1990`). Generated: same plus lineage (`workspace.js:280-294`). A single image is stored **twice** — full `dataUrl` *and* the `base64` payload. |
| `files` | array | **C** | user uploads | `{name, ext, size, text}` — the raw base64 is deliberately dropped; only extracted text is persisted (`communication.js:1991`). |
| `voice` | object | **C** | voice messages | `{dataUrl, mime, duration, transcript, tone}` (`communication.js:1992`). |
| `metadata` | object | **C** | assistant + call + proactive + waifu | Union of surface tags, see §4. |
| `truncated` | `true` (absent otherwise) | **C** | assistant rows | Set when continuation rounds were exhausted (`communication.js:2303`, `:2375`). |
| `withdrawn` | `true` (absent otherwise) | **C** | `_chatWithdrawMsg` | Tombstone flag; `content` is **overwritten** with `【<who>撤回了一条消息】` and `images`/`wsSearches`/`memOps` are **deleted** (`communication.js:3370-3373`). |
| `withdrawnBy` | string (`'self'`) | **C** | `_chatWithdrawMsg` | Written together with `withdrawn` (`communication.js:3371`). |
| `wsSearches` | array | **S** | assistant rows | Tool-result echo (`communication.js:2298`). |
| `memOps` | array of `{ok,status,label,detail}` | **S** | assistant rows | Memory-op echo (`communication.js:2299`). |
| `calNotes` | array of `{ok,label,detail}` | **S** | assistant rows | Calendar-note echo (`communication.js:2300`). |
| `upstreamRaw` | any | **L** | export strip only | Removed on export (`core.js:850`); never read for rendering. |
| `thinkingSources` | any | **L** | export strip only | Same (`core.js:850`). |

### 2.1 There is no `config_id` top-level field

`communication.js:3369` reads `m.config_id`, but **no production writer ever sets it** — the
character id lives at `metadata.config_id` (`communication.js:2297`). The read site is therefore
always `undefined` and falls through to its `'AI'` fallback. This is a latent read/write mismatch;
M1-A does **not** fix it (it would change user-visible withdrawal text) and the canonical store
preserves the record exactly as written.

### 2.2 There is no `source` top-level field

Proactive provenance is recorded as `metadata.source = 'active_message'`
(`assets/js/active-diary.js:1303-1304` region), not as a top-level `source`. Voice-call rows use
`metadata.source = 'voice_call'` (`communication.js:1993`).

---

## 3. Canonical `id` shapes (all verified)

| Shape | Producer | Evidence |
|---|---|---|
| `msg_<ms>_u` | 1:1 user message | `communication.js:1989` |
| `msg_<ms>_<rand>` | 1:1 assistant message | `communication.js:2297`, `:2369` |
| `msg_<ms>_<rand>_<i>` | waifu split assistant part | `communication.js:2385` |
| `msg_sys_<ms>_<rand36>` | group system event | `social.js:1868` |
| `_activeMessageId(settingId, scheduledFor)` | proactive assistant message | `active-diary.js:1301` |

All five are opaque strings to every reader. **M1-A must preserve them verbatim** — re-keying
messages would break `favorites.sourceId` (`favorites.js:17-33`), notification deep links, and the
`message_id` dedupe in the proactive ACK loop (`active-diary.js:1301-1302`).

---

## 4. `metadata` union (verified members)

| Key | Written at | Meaning |
|---|---|---|
| `model` | `communication.js:2297` | `cfg.provider \|\| cfg.model` |
| `model_id` | `communication.js:2297` | `cfg.model` |
| `config_id` | `communication.js:2297`, `workspace.js:1038` | the `apiConfigs.id` that produced the row |
| `showThinking` | `communication.js:2297` | display hint resolved per config |
| `source:'voice_call'` + `callSessionId` + `turnId` | `communication.js:1993` | voice-turn provenance |
| `source:'active_message'` + `activePlanId` | `active-diary.js:1303-1304` region | proactive provenance |
| `waifu:true` | `communication.js:2386` | MessagePresentation split part |
| `turnId` + `sequenceIndex` (+ `sequenceTotal`) | `delivery-sequence-core.js`（构造）、`communication.js`（waifu 多段与工具续轮的生产点） | **回合身份**：一次模型生成交付多条消息时的稳定归组键（P23 Phase 2A，见 §4.1） |
| `eventType` + `characterId` | `social.js:1873` | group membership event |
| `activityId` | `communication.js:2499-2503`（user）、`:2846`/`:2931`（assistant 从 `_turn.activityId` 继承）、`activity-runtime.js` 的 `send`/`mark` | 本轮注入的陪伴活动来源（与 `threadId` 的对话归属正交）；普通聊天与 legacy 频道消息不带此键 |

Metadata is an **open union** — the union is not closed by a schema, and readers use
`m.metadata && m.metadata.x` defensively. The canonical store therefore keeps metadata inside the
JSON payload rather than as columns, and must round-trip unknown keys unchanged.

### 4.1 Turn identity — one model turn may deliver N messages (P23 Phase 2A)

One model turn can be delivered as **N independent chat messages** (this already happens in two
production paths: waifu multi-part presentation and the tool-continuation round). The delivery-unit
boundary is therefore *message*, never a segment inside a message: each unit has its own `id`, its
own withdraw, its own playback, its own delete. Three metadata keys tie the units back to the turn:

| Key | Meaning |
|---|---|
| `turnId` | stable identity of **one model generation**; byte-identical on every message of that turn. Absent on single-message turns and on every legacy row. |
| `sequenceIndex` | deterministic order inside the turn (0-based). Readers must sort by it inside the turn. |
| `sequenceTotal` | advisory count, present only when the producer knows it (the tool-continuation path cannot know it when it writes its first message). Readers **must** count by `turnId` instead of trusting it. |

Why metadata and not a new top-level field: `metadata` is already the home of per-message
cross-message annotations (`activityId` links the user row and assistant row of one host turn), it is
a canonical conditional field, and it round-trips through the Home Node payload unchanged — so turn
identity is **additive**: no DB migration, no new `KNOWN_FIELDS` entry, no change for legacy rows.

Ordering is part of the contract, not an accident of the storage engine: the canonical order of a
conversation is "each turn's units contiguous at the position of the turn's earliest message, units
in `sequenceIndex` order, legacy rows by `(timestamp, id)`" — implemented once, in
`assets/js/delivery-sequence-core.js` (`compareMessages` / `orderMessages`), and consumed by every
chat read path (desktop mirror and Home Node paging alike). The full audit, the rejected
alternatives and the frozen invariants live in `docs/P23-2A-MESSAGE-SEQUENCE-CONTRACT.md`.

Line numbers in §6/§7 below are the M1-A snapshot they were written from; P23 Phase 2A added
**no** new write or read sites — it stamped turn identity onto existing ones and routed existing
reads through the canonical order.

---

## 5. Conversation identity — the facts that force a derived key

| Fact | Evidence |
|---|---|
| The conversation key **today is `friendId`**, nothing else. | every `byFriend` read |
| `threadId` is a **channel inside a `friendId`**, not a separate conversation. | `communication.js:2026`, `:2302` |
| Groups are `friendId = 'group_<ms>'`, distinguished **only by the string prefix**, never by a flag. | `social.js:1772` region; `communication.js:1678` |
| `chatThreads` is a separate store holding channel metadata, keyed by its own `id`. | `social.js:2003-2031` |
| There is **no conversation table** in the schema. | `core.js:4` store list |
| A `threadId` is unique **only within its `friendId`**. Deleting a thread deletes across all friends by `m.threadId===tid` (`social.js:2013-2014`) — i.e. the code itself treats `threadId` as globally named, but scopes reads per friend. | `communication.js:2026` |

**Derived canonical conversation id (M1-A):**

```
dm:<friendId>                       — 1:1 main conversation
dm:<friendId>|<threadId>            — 1:1 topic channel
group:<groupId>                      — group main conversation
group:<groupId>|<threadId>           — group topic channel
```

* `|` is the delimiter, **not** `:`, because both `apiConfigs.id` and `group_<ms>` ids may contain
  colons in principle while `|` is absent from every producer shape in §3 and from `chatThreads.ids`.
* Derivation is deterministic and pure: `conversationIdOf(friendId, threadId)`.
* `parseConversationId` is the inverse and is exact for every producer shape.
* A record written without a `threadId` maps to the **main** conversation, byte-identical to today's
  `!m.threadId` filter semantics.

---

## 6. Every production write site (complete)

| # | File:line | What it writes | Kind |
|---|---|---|---|
| 1 | `communication.js:1660` | group-chat user message (incl. `[Name]` prefix rows) | create |
| 2 | `communication.js:1910` | group-chat assistant message (`senderName` mandatory) | create |
| 3 | `communication.js:1995` | 1:1 user message (+ `images`/`files`/`voice`/`metadata`/`threadId`) | create |
| 4 | `communication.js:2304` | 1:1 streaming assistant message (+ `wsSearches`/`memOps`/`calNotes`/`images`/`truncated`) | create |
| 5 | `communication.js:2388` | waifu split assistant parts (loop) | create |
| 6 | `communication.js:2394` | 1:1 non-streaming assistant message | create |
| 7 | `communication.js:3098` | `_cMsg` — call/chat variant assistant row | create |
| 8 | `communication.js:3373` | withdrawal tombstone (mutates `content`, adds `withdrawn`/`withdrawnBy`, deletes `images`/`wsSearches`/`memOps`) | **update** |
| 9 | `communication.js:3398` | `_maybePatWithdraw` second tombstone note | update |
| 10 | `social.js:1875` | group system membership event | create |
| 11 | `active-diary.js:636` | proactive/active message (guarded by `dbGet` existence) | create, idempotent by `msgId` |
| 12 | `active-diary.js:1304` | proactive event ingest (guarded by `dbGet` existence) | create, idempotent by `msgId` |
| 13 | `active-plans.js:476` | plan-driven proactive message (guarded) | create, idempotent by `msgId` |
| 14 | `activity-runtime.js:206` | shared-activity message | create |
| 15 | `workspace.js:1042` | **continuation** rewrite of an existing assistant row | **update** |
| 16 | `site-operations.js:34` | strip `images` from every row ("clear images" operation) | update |
| 17 | `core.js:1123` | `importAll` — restore from a backup JSON | bulk create |

### 6.1 Every production delete site

| File:line | What it deletes |
|---|---|
| `communication.js:4022` | all messages (clear-all) |
| `communication.js:4093` | all messages of selected characters |
| `communication.js:2583` | a single message (`deleteSingleMsg`) |
| `memory.js:1403` | messages by id list |
| `social.js:1362` | all messages of one character (delete character) |
| `social.js:1978` | all messages of one group |
| `social.js:2014` | all messages of one thread across all friends |
| `auto-memory.js:639` | one day's messages of one character |

Deletes are **hard deletes** — there is no tombstone row left behind. `favorites.js:17-33` already
degrades a favorite to its text snapshot when its `sourceId` is gone, which is the precedent the
canonical change log follows with `message.deleted`.

---

## 7. Every production read site (complete, by shape)

| Shape | Sites |
|---|---|
| `dbGet('chatMessages', id)` | `communication.js:2553`, `:2576` (favorites probe), `:3368`, `:3386`; `favorites.js:21`; `workspace.js:971`; `active-diary.js:632`, `:678`, `:1302`; `active-plans.js:474`; `memory.js:1501` |
| `dbGetAll('chatMessages')` | `communication.js:597`, `:4021`, `:4044`, `:4067`, `:4090`, `:4123`, `:4142`, `:4207`; `app-store.js:101`; `calendar.js:199`; `coread.js:125`; `site-operations.js:33`; `social.js:2013`, `:2193`, `:2196` |
| `dbGetByIndex('chatMessages','byFriend',X)` | `active-diary.js:207`, `:377`, `:382`, `:658`; `active-plans.js:340`; `communication.js:597`, `:1678`, `:1962`, `:2026`, `:2441`, `:3387`, `:3419`; `diary.js:386`; `letters.js:213`; `summary.js:173`; `favorites.js` (via `:17-33`); `image-edit.js:73`; `memory.js:1310`, `:1506`, `:1572`, `:1711`, `:1727`, `:1743`; `auto-memory.js:612`, `:617`; `social.js:1361`, `:1528`, `:1960`, `:1977`, `:2031`, `:2063`, `:2163`, `:2178`, `:2282` |
| `dbDelete` | §6.1 |

**Consequence for M1-A.** 91 call sites touch this store. Rewriting them is not M1-A's scope; the
store must therefore be redirected **at the data-access helper boundary** (`core.js:9-13`) so that
every existing reader and writer keeps its exact semantics while authority moves.

---

## 8. Invariants M1-A freezes

1. **Message ids are never regenerated.** The five shapes in §3 are opaque; the canonical store
   stores them verbatim and treats them as immutable.
2. **`friendId` + `threadId` remain the canonical identity inputs.** `conversationId` is *derived*,
   never written back into a record.
3. **Unknown fields survive a round trip.** Reads come from a stored payload, not from a
   re-projection, so a field this document does not list is preserved rather than dropped.
4. **`content` is final text.** No delta is ever persisted; the terminal write is the only write.
5. **`reasoning_content` is stored but never re-sent to a provider.** `communication.js:2059`
   states this explicitly and the history mapper at `:2062-2069` honours it.
6. **Deletes are hard deletes**, recorded in the change log as `message.deleted` carrying only the
   id, so consumers can drop a row they cannot see.
7. **Proactive ingest stays idempotent by `message_id`** (`active-diary.js:1301-1302`) — the
   canonical store must not weaken that guard by allocating a second id.

---

## 9. Invariants P23 Phase 2A freezes (message sequences)

1. **One delivery unit = one canonical chatMessage.** No parent row with embedded segments, no
   renderer-only illusion.
2. **One model turn may produce N chatMessages.**
3. **Every message has an independent `id`** (so withdraw / delete / playback / favourites keep
   working per unit — they are all id-keyed today).
4. **Same model turn shares a stable `turnId`**; absent on single-message turns and legacy rows.
5. **Ordering is deterministic** (see §4.1); no fake millisecond offsets, no timer-driven skew.
6. **`content` remains the text authority** — a sequence never creates a second copy of the text.
7. **Voice stays the Phase 1 canonical voice** — no `sequenceVoice` / `deliveryVoice` second schema.
8. **No parent+child duplicate persistence** — the units are the rows; nothing else is stored.
9. **No secret in sequence metadata** — a sequence carrying a credential-shaped key or value is
   rejected as a whole (fail closed).
10. **Legacy single-message behaviour is unchanged** — legacy rows keep their exact shape, and a
    turn with no sequence writes exactly what it wrote before.
11. **Storage truth ≠ provider wire representation** — merging for providers that require
    alternating roles happens only at the request-building boundary (`IBModelCore.normalizeWireRoles`).
12. **The Sequence Core contains no timing / provider / network behaviour** — it is a pure module
    (`assets/js/delivery-sequence-core.js`, zero DOM / fetch / storage / clock).
