# MOBILE_HOME_NODE_AUDIT

**M0 · Home Node Protocol Audit — Android Thin Client feasibility**

| | |
|---|---|
| Repository | `E:\InternalBeyond-main` |
| Branch / HEAD | `master` / `6db3a0e6c009b1208e500176cdd6111966aac922` — *"docs: restore the upstream credit to the README top and pin its position"* |
| Product version | `1.0.4` (`VERSION`) |
| Working tree at audit start | **clean** — `git status --porcelain` returned 0 lines. No prior uncommitted work existed, so nothing had to be preserved or worked around. |
| Method | Read-only source audit. Every claim below carries a `file:line` reference taken from the current checkout. Documentation was treated as suspect and cross-checked against code. |
| Deliverable type | Design/audit document only. **No production code was modified in this stage.** |
| Status | **Complete for M0.** Every `UNDETERMINED` item is resolved (Appendix B items 1–4, one of them by executing the shipped runtime). What remains in Appendix B are two open design/ownership questions, plus two verified live defects (§3.11, §3.14) that are explicitly out of this stage's scope and are carried as R5 and R19. |

> **How to read this document.** Section 2 onwards assumes you have read §1. Where this audit contradicts a repository document or an earlier assumption, the contradiction is stated explicitly with the evidence that wins. Anything not verifiable from source is marked `UNDETERMINED`.

---

## 1. Executive Summary

### 1.1 The single most important finding

**InternalBeyond is not one runtime. It is a browser-owned canonical world plus a set of Node services that borrow slices of it.**

The canonical world — chat messages, memory, moments, diary, letters, characters (`apiConfigs`), provider keys, Middle Brain config — lives in **one browser IndexedDB database**, `InternalBeyondDB` version 23, declared in a single line of source:

```js
// assets/js/core.js:3
const DB_NAME='InternalBeyondDB',DB_VER=23;let db;
```

Thirty-two object stores are created by the loop at `assets/js/core.js:4`. Every store uses `keyPath:'id'` except `categories` (`name`). There is **no server-side database of any kind**. A repo-wide grep for `chatMessages|InternalBeyondDB` over `services/`, `bridge/`, `active/`, `runtime/` returns **zero hits** — those directories do not know the canonical store exists.

Node services on the other side own *task* state, not *world* state: a scheduler queue, a credential vault, an event outbox, and a set of stateless proxies. They are real and useful, and one of them (`Active`, port 23114) already does server-side character generation. But they are **borrowers**, not authorities: they run only on data the browser pushes to them, and their generated output is queued until the browser comes back to claim it.

### 1.2 What that means for the B-plan

The plan — Desktop = Home Node / single source of truth, Android = thin client — is **architecturally correct but not yet implementable**. Not because of missing plumbing, but because the thing Android would need to be thin *against* (a server that owns the world) does not exist yet.

Concretely, the Home Node currently cannot answer any of these questions on its own:

| Question Android needs answered | Can Home Node answer it today? | Evidence — why not |
|---|---|---|
| What characters exist, and what are they? | **No** | `apiConfigs` is a browser IndexedDB store (`social.js:703`, `dbPut('apiConfigs')` at `:712`). Node only receives a *snapshot* of one character per background task, in the request payload. |
| What is the chat history for character X? | **No** | `chatMessages` is browser-only (`communication.js:1995`, `:2304`). Node has neither a reader nor a writer. |
| Send a message and get a streamed reply | **No** | Chat execution is 100% browser-side (see §4.1). Node has no streaming model path at all — every Node model call is a single non-streaming POST (`active/node-model-port.js:122`). |
| What does the character remember? | **Partially** | Node receives a pre-ranked `recent_memories` array of ≤8 rows inside the task snapshot (`active/http.js:332`, `:437`). It cannot query memory itself; `services/` contains zero memory references. |
| Are there proactive messages for me? | **Yes — this one works** | `GET /events?user_id=` on 23114 (`active/http.js:525-538`). This is the most Android-ready surface in the product. |
| What pictures/moments/diary exist? | **No** | All browser-only; Node has schedule metadata but no content. |

So: **Android cannot yet be a thin client, because there is currently nothing to be thin against except a browser tab.**

### 1.3 The good news — three assets that make this tractable

1. **A canonical execution seam already exists in Node and is already streaming-shaped at the port level.** `active/node-model-port.js` implements `run(request, {signal, onEvent})` and calls `onEvent({type:'done'|'error', ...})` (`:141`, `:149`, `:155`). It reuses the *identical* runtime-neutral core the browser uses: `IBModelCore.buildRequestBody` / `parseResponse` (`active/node-model-port.js:19`, `:71`, `:135`). Switching it from `res.text()` to an SSE reader is a contained change, not a rewrite.
2. **The dual-host module pattern is already frozen policy.** D10 in `docs/DECISIONS.md:58-60` mandates UMD single files loaded by *both* a browser `<script>` tag and Node `require`, with the explicit rule "禁止在两侧各写一份镜像逻辑". Three modules already work this way — `provider-directory.js` (`:26`), `ib-model-core.js` (`:12`), `reply-chain-core.js` (required at `active/moments.js:33`) — plus `context-snapshot.js` and `social-observe.js`. Porting chat execution to Node is therefore *not* "writing a second IB runtime"; it is **extending an existing, sanctioned, single-implementation pattern to one more module.**
3. **A complete sync/pairing-shaped protocol already exists for proactive messages.** The Active companion's `PUT snapshot → armedUsers → generate → events outbox → browser ingest → per-event ACK` cycle (`active/http.js:240-258`, `:474-524`, `:525-568`; browser side `assets/js/active-diary.js:1281-1337`) is exactly the shape M1's `chat.history`/`chat.send`/`sync.cursor` need. It has already solved idempotency (`msgId` dedupe at `active-diary.js:1301-1302`), stale-write rejection (`active/http.js:316`, `:423`), ownership (`:249-252`), and crash recovery (`active/scheduler.js:607-631`).

### 1.4 The four gaps, ranked

| # | Gap | Size | Why it blocks Android |
|---|---|---|---|
| **G1** | **No server-side canonical chat store.** The world's most important store has no server representation. | **L** | Without it, "Android shows the same conversation as desktop" is impossible. Everything else depends on this. |
| **G2** | **No pairing or device identity of any kind.** Zero matches for `deviceId`/`device_id`/`pairing` in any Node file. The only auth primitive is the Bridge's single shared LAN token (`bridge/config.js:24`, `:183-187`). | **M** | Exposing any world API on a LAN socket without per-device identity means one shared secret for the whole household, unrevocable, and no way to tell phone from laptop. |
| **G3** | **No Mobile Gateway namespace, and the obvious host is unsafe to reuse wholesale.** The Bridge (23115) is a **tool-execution surface**, not a world API — and it contains a generic arbitrary-URL forwarder, `POST /api/llm-proxy` (`bridge/routes.js:319` → `proxyLlm` `:195`), which will `fetch()` **any** URL with **any** method and **any** headers the caller supplies (`:199-212`, `:221`), with no redirect policy. On a default install its auth check is a **no-op for loopback callers** (`bridge/config.js:207-211`), and the response is released to `Origin: null` readers (`bridge/routes.js:234-238`, `bridge/config.js:120`). | **M** | Handing this to a mobile client imports an SSRF/credential-relay primitive into the mobile attack surface for no mobile benefit. **See §3.11 — this is a live finding in the current build, independent of the mobile work.** |
| **G4** | **Node cannot reach memory, moments content, diary, letters, or image generation.** Every one is a whole-file browser IIFE that dereferences `window` at module scope. | **L** | Android asking "what does she remember" or "show me the diary" has no server-side answer. M1 can defer these; M2+ cannot. |

### 1.5 Two premises in the brief that the code contradicts

These matter because designing against the assumed version would produce a wrong protocol.

**Premise: `middleBrainExecute` is the canonical generation seam that all surfaces go through.**

**Correction: `middleBrainExecute` never calls a model.** It is a *context-organization* seam. Its own body returns either `null` or the result of `middleBrainCompressPipeline` (`assets/js/middle-brain.js:159-172`), and the returned object is `{structured, compressedContext, stats, source, admission?, judge?}` — a text block, not a reply.

The real generation funnels are **three**, not one:

| Seam | Location | Consumers |
|---|---|---|
| `callApiChatStream` / `callApiChat` | `assets/js/communication.js:3473` / `:3543` | single chat, group chat, role letters, app-store, diagnostics test-connection, setup wizard |
| `callApi` (independent executor with its own body build and its own `_ibApiPost`) | `assets/js/communication.js:185` | blog comments (`:68`), annotations (`annotations.js:151`), chat summary (`summary.js:106`), memory generation (`memory.js:789`, `:1242`), letters (`letters.js:273`) |
| `callCharacterModel` → `NodeModelPort.run` | `active/model-client.js:294` → `active/node-model-port.js:60` | Node proactive messages, Node moments, Node reply chains |

And Middle Brain is applied to **exactly one surface**: `sendChatMessage`'s single-chat path. Group chat, voice, video, Moments, Diary, Proactive, Letters, and image generation all bypass it. This is deliberate and test-locked — `tests/test_middle_brain_integrity.js:158` asserts `A9.noGroupWiring`.

> **Consequence for the plan:** "Android must not bypass Middle Brain" is the correct *constraint*, but there is currently no canonical seam to route Android *through*. A single Node-side generation entry point has to be created; it does not exist to be reused.

**Premise: the Middle Brain is a runtime service the Home Node could host.**

**Correction: Middle Brain is browser-only and cannot load in Node.** All six files are IIFEs mounted on `root.IB`/`window` with no `module.exports`, hard-coded `window` writes (`middle-brain.js:261`, `:270-312`), DOM access (`middle-brain-config.js:228`, `:413`, `:479`), IndexedDB persistence via the global `dbGet`/`dbPut` (`middle-brain-config.js:136`, `:142`), and `localStorage` reads (`middle-brain.js:46`). `require()`-ing any of them throws.

**Premise: memory is semantic/vector memory.**

**Correction: there are no embeddings anywhere in the repository.** A repo-wide grep for `embedding|vector|cosine|dotProduct|faiss|hnsw|pgvector` returns exactly one match, and it is an SVG attribute (`communication/letters.js:10`, `vector-effect`). "Semantic memory" is an LLM-assigned provenance label (`kind:'semantic'`, written by consolidation at `active-diary.js:818`), retrieval is substring keyword overlap (`_calcRelevance` `memory.js:50-57`), and all dedup/merge similarity is **character-bigram Jaccard** (`_activeTextSimilarity` `active-diary.js:334-339`) at thresholds 0.5 and 0.8.

This is *good news* for the Home Node: a memory read API needs no vector index, no embedding provider, and no new credentials. It needs a table and a ranker.

### 1.6 Recommendation

Proceed with the B-plan, with one sequencing correction:

> **Do not start with Android UI. Do not start with the Mobile Gateway. Start by giving the Home Node a canonical chat store and a Node-side chat execution path — then put the gateway in front of it.**

M1 as scoped in the brief (gateway namespace, pairing, `character.list`, `chat.history`, `chat.send`, `chat.delta`/`chat.done`, reconnect, contract tests) is the right *shape*, but it must be preceded in the same stage by the two things it stands on: a Node `chat-core` module (extracted as a UMD single file per D10, not a reimplementation) and a Node conversation store. Without those, `chat.history` has nothing to read and `chat.send` has nothing to call.

**One architectural decision must be made by you before M1 starts** — see §7.6 and §14.3. It is the only fork that changes the whole shape: *does the desktop browser migrate to reading chat through the Home Node (true single authority), or does the Home Node own only mobile-originated conversations (two stores, no migration)?* This audit recommends the former and explains why, but the choice is a product decision, not a technical one, and it has a real cost.

### 1.7 Two present-day defects found on the way — neither is a mobile-design issue

Both were found while verifying component boundaries, both are verified in the current build, and both are out of this stage's scope (M0 is read-only). They are recorded here because they sit on surfaces the mobile work depends on, and because the mobile plan must not inherit either.

1. **`POST /api/llm-proxy` is an unauthenticated SSRF primitive.** It forwards a caller-supplied URL, method, and headers with `fetch()` and Node's default redirect policy, and on a default install its auth check is a no-op for loopback callers; the response is readable by `Origin: null`. Full detail and an honest severity argument in §3.11. It also contradicts a frozen decision record (`docs/DECISIONS.md:17`, D2) that tells a future engineer the component does not exist.
2. **Turning LAN exposure on breaks the desktop's own voice calls and TTS test button.** §3.14, verified end to end: the voice channel's token is permanently the empty string (`call.js:17`), so its WebSocket upgrade is rejected with 401 the moment `LAN_EXPOSED` becomes true; and the voice-preview button bypasses the token entirely (`social.js:454` bare `fetch`, `:456` `new Audio`). Since LAN exposure *is* the mobile gateway's v1 transport (§10.5), this is a precondition, not a footnote — see R19.

Both belong to a pattern this audit kept running into: **the prose and the code disagree about which surfaces exist and who owns them** (§3.13). The mobile plan has to be designed from the code.

---

## 2. Current Runtime Topology

### 2.1 Process and port map (verified listen calls)

| Port | Process | Bind host | Protocols | Authority it holds |
|---|---|---|---|---|
| **23120** | `services/internal-beyond-server.js` | `127.0.0.1` hard-coded (`:347`, `:348`, `:520`) | HTTP (static files + `/__*` control) | **None.** Serves `InternalBeyond.html` and ~3 MB of `assets/`. Control endpoints `/__boot-state`, `/__update-check`, `/__update/start`, `/__update/status`, `/__shutdown`. |
| **23115** | `services/ib-bridge-service.js` | `IB_BRIDGE_HOST` or `config.lan ? '0.0.0.0' : '127.0.0.1'` (`bridge/config.js:181-188`) | HTTP + WebSocket (hand-rolled RFC6455) | Tool surface + stateless LLM proxy + "resident AI" side-chat. Own JSON files in `%LOCALAPPDATA%\InternalBeyond\bridge`. |
| **23114** | `services/active-message-service.js` | `127.0.0.1` hard-coded (`:25`), no host override | HTTP only (no `upgrade` handler) | Background scheduler, credential vault, event outbox, plan/moment schedule state. |
| **23116** | `runtime/local-services-runner.js` | `127.0.0.1` hard-coded (`:51`) | HTTP | Lifecycle control only: `GET /status`, `POST /restart`, `POST /shutdown`. |
| **8765** | Python `vision/api.py` (uvicorn) | `127.0.0.1` (`scripts/windows/start-vision-service.cmd:49`) | HTTP | Optional local VLM (Qwen2.5-VL). **Not in the installer payload** — grep of `installer/*.iss` and `scripts/build-installer.ps1` for "vision" returns zero matches. Started only with `runner --vision` (`runtime/local-services-runner.js:38`, `:84-96`). |

Launcher chain: `runtime/launch-internal-beyond.js` spawns the runner detached (`:239-241`) and the web server (`:253-255`), both inheriting `process.env`. The runner spawns services from a declarative table (`runtime/local-services-runner.js:63-82`) with `command: process.execPath`, `cwd: ROOT`, `env: {...process.env, ...service.env}` (`:399-405`), `windowsHide: true`, output piped to `%LOCALAPPDATA%\InternalBeyond\logs\{bridge,active}.log` through a `redact()` filter (`:152-165`).

### 2.2 Where the world actually lives

```
┌─────────────────────────── BROWSER (InternalBeyond.html) ───────────────────────────┐
│                                                                                      │
│   InternalBeyondDB v23  —  THE CANONICAL WORLD                                       │
│   ┌────────────────────────────────────────────────────────────────────────────┐    │
│   │ chatMessages · memories · autoMemory · understandings · threads             │    │
│   │ moments · diary_entries · roleLetters · roleLetterMemories · letters        │    │
│   │ apiConfigs (characters + PLAINTEXT apiKey) · groups · chatThreads           │    │
│   │ chatSummaries · apiSettings (incl. Middle Brain config + key) · favorites    │    │
│   │ posts · blogComments · projects · projectFiles · activities · cal* · ...    │    │
│   └────────────────────────────────────────────────────────────────────────────┘    │
│                                                                                      │
│   Chat execution:  sendChatMessage (communication.js:1604)                           │
│                    → callApiChatStream/Once → provider (streaming SSE)               │
│   Middle Brain:    browser-only, 6 <script> tags (InternalBeyond.html:2996-3001)      │
│   30s heartbeat:   _activeTick (active-diary.js:1340) drives diary/moments/           │
│                    letters/consolidation/understanding                               │
└──────────────────────────────────────────────────────────────────────────────────────┘
        │  ▲                    │  ▲                        │  ▲
        │  │ snapshot PUT      │  │ /events poll + ACK     │  │ WS tool_call
        │  │ POST /credentials │  │                        │  │ POST /api/llm-proxy
        ▼  │                    ▼  │                        ▼  │
┌────────────────────┐  ┌────────────────────┐  ┌───────────────────────────┐
│  Active  23114     │  │  Active  23114     │  │  Bridge  23115            │
│  scheduler +       │  │  event outbox      │  │  tools, resident AI,      │
│  credential vault  │  │  (durable queue)   │  │  arbitrary-URL LLM proxy  │
│  ↳ generates with  │  │                    │  │                           │
│    NodeModelPort   │  │                    │  │  stateless, no world data │
└────────────────────┘  └────────────────────┘  └───────────────────────────┘
        │
        └── writes %LOCALAPPDATA%\InternalBeyond\active-message-service.json
            and credential-vault.{json,key}
```

### 2.3 What Node genuinely owns

Being precise here matters, because "Node owns some state" is not the same as "Node is an authority".

| Node-owned state | File | Is it canonical for anything? |
|---|---|---|
| Background task schedules, AI plans, moment schedules, reply-chain task queue, event outbox, run history, bg-AI switch | `%LOCALAPPDATA%\InternalBeyond\active-message-service.json`, shape `{version:3,tasks,plans,events,history,moments,replyChains,bgAi}` (`active/persistence.js:14`, `:19`) | **Yes** — this *is* the authority for "what is scheduled" and "what has been sent but not yet claimed". |
| Character credentials (AES-256-GCM) | `credential-vault.json` + `credential-vault.key` (`active/credential-vault.js:19-20`) | **Yes, and better protected than the browser copy.** |
| Bridge config, whispers, health, geo, letters, sessions, resident chats, push history, TTS assets | `%LOCALAPPDATA%\InternalBeyond\bridge\*.json` (`bridge/config.js:17-19`) | Only for its own auxiliary features. **Not** the world's `letters` store — that is a different, browser-side feature. |
| Behaviour observation counters | `social-observe.json` (`active-message-service.js:176`) | Statistics only. |

The vault is worth noting for the Android design: Node already stores provider keys **encrypted at rest**, while the browser stores them **in plaintext** in `apiConfigs.apiKey` (`social.js:712`) with an unencrypted localStorage fallback `ib_apiConfigsFallback_v1` (`social.js:610`, `:696`) and an unencrypted full-DB mirror `ib_mirror_v1` (`core.js:827`, `:932`). Moving credential authority Node-ward is therefore a **security improvement**, not merely a convenience.

### 2.4 The one existing end-to-end background flow (and why it is the template)

This is the most valuable existing artifact for the Mobile Gateway, so it is worth stating completely.

```
  BROWSER                                     ACTIVE (23114)                     MODEL
    │                                               │                              │
    │ 1. PUT /tasks/:id   { setting, character,      │                              │
    │      user, recent_memories[≤8],                │                              │
    │      recent_messages[≤16], chat_summary, ... } │                              │
    │──────────────────────────────────────────────► │  state.tasks[id] = snapshot  │
    │    (active-diary.js:1255, payload built at     │  (active/http.js:240-258)     │
    │     active-diary.js:1226-1231)                 │                              │
    │                                               │                              │
    │ 2. POST /credentials  { characterId, apiKey }  │                              │
    │──────────────────────────────────────────────► │  credential-vault.json       │
    │    (active-diary.js:1246)                      │  (active/http.js:188-209)     │
    │                                               │                              │
    │ 3. POST /reconcile  { user_id, task_ids }      │                              │
    │──────────────────────────────────────────────► │  prune undeclared            │
    │    (active-diary.js:1268)                      │  armedUsers.add(user_id) ◄── the ARMING signal
    │                                               │  (active/http.js:474-524)     │
    │                                               │                              │
    │                      [browser may now close]  │  schedulerTick every 15s     │
    │                                               │  (active/scheduler.js:668)    │
    │                                               │  gates: enabled &&           │
    │                                               │   background_enabled &&      │
    │                                               │   armedUsers.has(user) &&    │
    │                                               │   next_run_at <= now         │
    │                                               │            │                 │
    │                                               │            ▼                 │
    │                                               │  callCharacterModel ────────►│
    │                                               │  (model-client.js:294)       │
    │                                               │            │                 │
    │                                               │  validate (sim<0.82) /       │
    │                                               │  fallback / ≤3 attempts      │
    │                                               │            │                 │
    │                                               │  state.history[runId] = {…}  │
    │                                               │  state.events[eventId] = {   │
    │                                               │    status:'sent', content,   │
    │                                               │    message_id, sent_at, …}   │
    │                                               │  saveNow()                   │
    │                                               │  (scheduler.js:236-271)      │
    │ 4. GET /events?user_id=    ◄──────────────────│                              │
    │    (active-diary.js:1286, every ≤30s)          │                              │
    │                                               │                              │
    │ 5. dbPut('chatMessages', {id: ev.message_id,   │                              │
    │      role:'assistant', source:'active_message',│                              │
    │      ...})   ◄── THE CANONICAL WRITE           │                              │
    │    (active-diary.js:1303-1304)                 │                              │
    │    guarded by `if(!(await dbGet('chatMessages',│                              │
    │      msgId)))`  ← idempotency by message id     │                              │
    │                                               │                              │
    │ 6. POST /events/:id/ack    ──────────────────► │  event deleted               │
    │    (active-diary.js:1333)                      │  (active/http.js:539-568)    │
```

**Four properties of this flow that the Mobile Gateway should inherit outright:**

1. **The Node side never writes the world; it writes an event.** The canonical write happens in exactly one place and is guarded by an existence check on the message id. Adding a second writer would break the guard.
2. **Arming is an explicit, separate, last-step signal** (`armedUsers.add`, `active/http.js:521`), and it is deliberately process-local so that a service restart cannot silently resume scheduling against stale snapshots (`active-message-service.js:55-56`).
3. **Stale writes are rejected by monotonic comparison, not by last-writer-wins.** `updatedAt` regression returns `{ok:true, stale:true}` with the server's copy (`active/http.js:316`, `:423`), and `executedAt` is forward-only (`:315`, `:427-434`).
4. **Ownership is enforced per record, with an explicit, narrow re-own escape hatch** (`active/http.js:249-252`, `:408-419`).

**And two properties that must NOT be inherited:** the Active service has **no authentication at all** (its only gate is an Origin check that accepts `Origin: null`, `active/http.js:78-80`), and its scheduler **cannot start without a browser having been open at least once** since service start (`armedUsers`). The first is a LAN-exposure blocker; the second is an availability blocker for a phone-only user.

---

## 3. Existing Bridge Audit

Answers to the ten questions in the brief, grounded in `services/ib-bridge-service.js`, `bridge/ws.js`, `bridge/routes.js`, `bridge/config.js`.

### 3.1 HTTP / WS entry points

**WebSocket** — a hand-rolled RFC6455 implementation (`bridge/ws.js`), zero dependencies. Upgrade handling at `services/ib-bridge-service.js:1025-1074`.

Message types accepted (`bridge/ws.js:158-202`):

| Type | Direction | Shape |
|---|---|---|
| `hello` | C→S | `{type:'hello', token}` → reply `{type:'hello_ack', ok:true, server, version, tools:[{name,description,inputSchema}]}` (`:165-178`) |
| `tool_call` | C→S | `{type:'tool_call', id, name, args}` → reply `{type:'tool_result', id, ok, error, text, data}` (`:189-199`) |
| `tool_catalog_request` | C→S | → `{type:'tool_catalog', tools:[…]}` (`:185-187`) |
| `ping` / `pong` | both | `{type:'ping', t}` → `{type:'pong', t}` (`:160-164`) |
| `push` | S→C | `{type:'push', title, text, from}` — broadcast, **not persisted** (`:46-51`, emitted at `ib-bridge-service.js:993`) |

Binary frames are routed exclusively to the voice runtime if authorized (`:146-150`).

**The client's real vocabulary, verbatim** (`assets/js/integrations.js` — the `IBNET` object, which is the actual WS client; see §3.2):

| Frame | C→S, exact shape | Source |
|---|---|---|
| `hello` | `{type:'hello', client:'InternalBeyond', version:'1.1', token, capabilities:['push','tools','images']}` | `:1244` (`VERSION` at `:1078`) |
| `ping` | `{type:'ping', t:Date.now()}` | `:1319` |
| `pong` | `{type:'pong', t:m.t}` | `:1404` |
| `tool_catalog_request` | `{type:'tool_catalog_request'}` — **no id** | `:1358` |
| `tool_call` | `{type:'tool_call', id:'tc_'+base36(now)+'_'+seq, name, args}` | `:1371`, `:1379` |

and one server frame the table above omits: the heartbeat is a **raw WebSocket ping frame** (opcode `0x9`) whose payload happens to be `{"type":"ping"}`, not a JSON text frame (`bridge/ws.js:25`, `:29`). The browser answers the protocol-level pong itself and the client separately answers at the JSON level (`integrations.js:1404`) — two different pongs for one heartbeat.

**Correlation exists for tool calls and for nothing else.** `tool_call.id` is echoed in `tool_result.id` and dispatched by exact lookup (`integrations.js:1417`, `_pendingCalls` `:1092`, per-call timeout clamped to 3 000–180 000 ms `:1372`). Everywhere else: `ping`/`pong` correlate only by echoing `t`; `tool_catalog_request` has no id and `tool_catalog` echoes none, so two concurrent catalog requests are indistinguishable; `push` carries no id at all (`ib-bridge-service.js:733`), which is why the client mints a local one (`integrations.js:1431`) and why a server push can be **neither deduplicated nor acknowledged**. There is no global sequence number, no `reply_to`, and no per-frame schema version.

**Correction to the usual summary — a version field exists, but it is not a protocol version and it is not negotiated.** `hello.version` is the literal `'1.1'` (`integrations.js:1078`); the server **ignores `msg.version` entirely** (`bridge/ws.js:165-179`), and `hello_ack.version` is the **build** version (`VERSION='1.0.0'`, `services/ib-bridge-service.js:41`), not a wire version. `capabilities:['push','tools','images']` is likewise never read by the server — grep over `bridge/` returns only the client send site. The one forward-compatibility hook the client implements is `hello_ack.ok===false` (`integrations.js:1407-1410`), which this server **never sends**: it rejects by closing with `4401` instead. So the wire has a version-shaped field and zero version *semantics* — which is precisely the hole §7.2's envelope has to fill.

Unknown message types are silently dropped (`bridge/ws.js:201`; the client stores them in an inbox and still dispatches `ib-net-message`, `integrations.js:1402-1403`, `:1445-1447`). Client-side guards, for completeness: a frame over 12 MB sets `_manualOff` and stops reconnecting (`integrations.js:1392-1395`); close `4001/4003/4401/4403` is treated as permanent (`:1187-1191`, `:1267`); connect timeout is 12 s (`:1232-1238`); liveness is 75 s without a valid protocol frame (`:1312-1318`). The upgrade itself is accepted on **any** path (§3.10), so the URL is a convention, not a route.

**HTTP** — 26 routes. Notable groups (`bridge/routes.js`):

- Probes: `GET /health` (`:278`), `GET /status` (`:286`), `GET /api/diagnostics` (`:308`).
- **`POST /api/llm-proxy` (`:319`)** — the arbitrary-URL forwarder.
- Assets: `GET /stickers` + `/stickers/:name` (`:325`, `:330`), `GET /tts/:name` (`:355`).
- Data: `GET|POST /api/whispers` (`:378`, `:383`), `GET|POST /api/health` (`:432`, `:439`), `POST /api/geo` (`:463`), `GET /api/geo/latest` (`:485`), `/api/weather` (`:491`), `/api/music/*` (`:498`, `:503`, `:508`, `:527`), `GET|POST /api/letters` (`:585`, `:590`), `GET|POST /api/context` (`:642`, `:650`), `POST /api/push` (`:656`), `/api/push/history` (`:670`), `GET /api/config` (`:677`), `GET /api/tools` (`:681`), `POST /api/tts` (`:687`), `/api/tts/voices` (`:702`, `:707`).
- Resident AI (a *separate* side-chat with its own JSON history): `GET|POST /api/ai/sessions` (`:777`, `:781`), `POST /api/ai/chat` (`:805`), `POST /api/ai/proactive` (`:813`).

### 3.2 Clients today

Exactly one production client: the browser page. It reaches the Bridge through `assets/js/bridge.js` (WS + REST helpers, default `ws://127.0.0.1:23115` at `:98`) and `assets/js/integrations.js` (`hello` frame at `:1244`). `assets/js/communication.js:117-149` uses the Bridge as an HTTP proxy for provider calls when the page is on `file://`. `assets/js/communication/call.js:13` and `assets/js/social.js:454` also call it.

No shell, PowerShell, Python, or test-external client calls 23115.

### 3.3 Auth

- Default `token: ''` — meaning "loopback, unauthenticated" (`bridge/config.js:24`, comment at `:176-180`).
- When LAN-exposed (`config.lan === true` **or** a non-loopback `IB_BRIDGE_HOST`), a 32-byte base64url token is **auto-generated and persisted** (`:98-101`, `:181-187`).
- Enforcement: `needsHttpToken(req) { return lanExposed || (token set && !isLoopbackRequest(req)); }` (`:207-211`), compared with `constantTimeTokenMatch` (`:213-216`).
- Carriers: `Authorization: Bearer`, `X-IB-Token`, or `?token=` / `?ib_token=` (`:196-205`). Query-string support exists explicitly for iOS Shortcuts (`:202-204`) — and is a log-leak vector for anything else.
- Applied to all routes except `/health` and `/status` (`bridge/routes.js:278-316`).
- WS: validated **twice** — at the upgrade (`ib-bridge-service.js:1054-1059`, HTTP 401) and again in the `hello` frame (`bridge/ws.js:165-172`, close 4401). Good defence in depth; worth copying.

**Verdict: one global shared secret, no scopes, no expiry, no revocation list, no per-device identity, no audit trail.** Adequate for "my phone curls my home box". Not adequate as the trust root for a device that leaves the house.

### 3.4 Device concept

**Absent, and now verified exhaustively.** Search terms and results: `deviceId`, `device_id`, `deviceName`, `clientId`, `client_id` over every `*.js` in the repo → **0 matches**; `pairing` / `pairDevice` / `scanQr` / `qrCode` / `QRCode` over `*.js|*.py|*.json|*.md|*.html` → **0 real matches** (only the substring inside `S.repairing` in `assets/js/diagnostics.js`, the word "pairings" in fiction at `InternalBeyond.html:2041`, and 配对 in prose at `docs/history/zero-setup/P5-DIAGNOSTICS-REPORT.md:162`). There is no device registration, no device list, no revocation, no pairing code, no QR helper, and no client identifier in any frame: the WS `hello` sends a fixed literal `client:'InternalBeyond'`, and the server keeps only `this.remote = req.socket.remoteAddress` per connection (`bridge/ws.js:62`) with `wsSockets` an anonymous `Set` (`:20`) — there is no registry of connections by identity.

The three identity-shaped primitives that do exist:

| Primitive | What it really is | Exact shape / location |
|---|---|---|
| `user_id` | an **ownership tag**, not a principal | `_activeUserId()` — `assets/js/active-diary.js:46-48` |
| `character_id` | an `apiConfigs` record id | `apiConfigs` keyPath `id` (`assets/js/core.js:4`) |
| Bridge `config.token` | **one shared secret for every client** | `bridge/config.js:24` |

**`user_id` in full**, because the mobile plan will otherwise be tempted to reuse it as a device identity:

```js
// assets/js/active-diary.js:46-48 — the only assignment site in the repo
function _activeUserId(){
  try{let id=localStorage.getItem('ib_active_user_id');if(!id){id='local_'+Date.now().toString(36)+'_'+Math.random().toString(36).slice(2,8);localStorage.setItem('ib_active_user_id',id)}return id}catch(e){return'local_user'}
}
```

- Shape `local_<base36(ms)>_<6 base36 chars>` — not a UUID, not hashed, no server involvement, no expiry. Stored as a plain string in `localStorage['ib_active_user_id']`; that key appears **exactly once** in the whole of `assets/**` (this line). Exported at `:1399` and via `IB` at `:1503`; consumed at `active-diary.js:140,270,1265-1266,1277,1283`, `active-diary/active-plans.js:80,324,468,599,825,856`, `active-diary/diary.js:92`, `moments.js` (20 sites), `social-network.js:184,451,468,489,605,623,659,757`.
- The fallback `'local_user'` is returned only when `localStorage` throws, and is **not persisted** — so every quota-blocked/failed-storage client shares one colliding id.
- **The server never verifies it.** The only check anywhere is a *belongs-to* comparison against a previously stored value: tasks `active/http.js:243`, `:247-252` (403 `Task does not belong to this user`); plans `:299-308`; moments `:382-419` (plus the `reown` escape). Listing is a filter (`:284-288`), and `POST /reconcile` deletes only records whose stored `user_id` equals the caller's (`:492-503`, `:512`). The Active service has **no token, cookie, or session of any kind** — grep for `token|Authoriz` over `services/active-message-service.js` returns **0 matches**; there is only an Origin guard (`services/active-message-service.js:285-286` → `active/http.js:146-149`) on a loopback bind (`:25`). The id is minted locally and never registered anywhere; `POST /credentials` is keyed by `characterId`, not by user (`active/http.js:188-208`).
- **So there is no multi-user system.** Scoping by arbitrary string is *structurally* possible, but there is no identity issuance, no authentication, no isolation guarantee, and no registry — and the repository says so itself: `active/credential-vault.js:10-12` — *"Threat model：单用户本地应用… 不承诺对抗已取得本机文件读写权限的攻击者"*; `active/http.js:411` calls churn *"本机单用户 user_id churn"*. Two browsers on one machine would each mint an id and simply not see each other's server state — indistinguishable, from the user's side, from data loss.
- **It does not survive a browser data clear, and the product's own resets do not touch it.** `resetAllData()` (`site-operations.js:18-29`) deletes IndexedDB stores then calls `ibExtReset()`, whose key list (`integrations.js:1468-1470`) is `ib_mcp_cfg, ib_fcMode, ib_fcRounds, ib_mcpRounds, ib_pipAllow, ib_net_cfg, ib_net_inbox` (+ `ib_vecOn, ib_vecHost`) — `ib_active_user_id` is **not** in it, and there is **no `localStorage.clear()` anywhere** in `assets/**`. A user-initiated "clear site data" therefore produces a brand-new id while the old one's server-side records remain.
- **Only `moments` can be re-owned; tasks and plans cannot.** `moments.js:1607` PUTs `/moments/:characterId`, retries once with `reown:true` on 403 (`:1629`, comment `:1623-1624`, guard `_momentsReownTried` `:1625-1635`), sanctioned by the server at `active/http.js:409-419`. There is **no re-own path for `tasks` or `plans`** and no GC/expiry for orphans that I could find in `active/http.js` or `active/scheduler.js`.

**Consequence for the mobile plan (and for G2).** The phone cannot inherit this identity: it is a browser-local string with no issuance, no proof, and no lifetime, and it is *already* the documented source of a data-orphaning failure mode on the desktop. The gateway's device registry (§10.4) is a genuinely new primitive, and it must not be conflated with `user_id` — the two answer different questions ("which record belongs to whom" versus "which device is allowed to speak"). If the desktop later migrates to a Home-Node-owned world, the `user_id` tag should either be replaced by the authenticated device identity or be explicitly recorded as a legacy scoping field.

### 3.5 Reconnect / heartbeat

- **WS server → client heartbeat:** 30 s server ping, client considered dead after 60 s (`bridge/ws.js:24-33`), close code 1001.
- **Client → server:** `assets/js/bridge.js` implements reconnect; `assets/js/bridge.js:98` seeds a default URL. The frontend is the only reconnect implementation that exists.
- **Active (23114) has no push channel at all**, so "reconnect" there means "resume polling", handled by the 30 s `_activeTick` (`active-diary.js:1340`) plus `visibilitychange` (`:1343`).

### 3.6 Event bus

**There is none.** `grep -n "emit|EventEmitter|broadcast|hook"` over `services/active-message-service.js` returns only `module.exports` (`:318`). The Bridge has a `broadcast()` (`bridge/ws.js:46-51`) but it is fire-and-forget, non-persisted, and consumed by nothing but the UI connection panel (`assets/js/bridge.js:1135`).

The **only durable event mechanism in the product is the Active service's `state.events` outbox plus per-event ACK**. That is the de-facto event bus, and it is poll-based.

### 3.7 Can the Bridge be reused as the Mobile Gateway?

**No — not as-is, and not by widening it.** Four reasons, each verifiable:

1. **Wrong semantic scope.** The Bridge's WS surface is *tool execution for an AI* ("向 AI 暴露工具", `services/ib-bridge-service.js:9-11`). Those tools include `whispers_write`, `letter_write`, **`pay_register_checkout`**, **`submit_payment`**, **`pay_set_config`** (`:857-884`), and `session_save`. None of them is a mobile chat verb. Exposing the tool namespace to Android would hand a phone client payment-authorization endpoints it has no business calling.
2. **`/api/llm-proxy` is an open forwarder.** It takes `url`, `method`, and arbitrary `headers` from the caller and performs `fetch(target, …)` (`bridge/routes.js:199-212`, `:221`), echoing status/content-type/body. It does not restrict the target host. On a LAN-exposed Bridge this turns the desktop into a request-relay for anything on the home network. That is acceptable risk for a same-machine `file://` origin (its actual purpose, `communication.js:112`); it is **not** acceptable to place behind a phone's network path.
3. **No versioning or envelope.** Adopting it as the mobile protocol means inheriting `{type:'hello'|'tool_call'|…}` with no `v` field and no place to add one without breaking the existing IBCNET client.
4. **DECISIONS.md D2 explicitly forbids it.** `docs/DECISIONS.md:15-17`: *"Bridge 不做主聊天代理 … 主聊天由浏览器直连各家 API；Bridge 只提供工具/看板/推送/AI 常驻会话等辅助能力."* Repurposing the Bridge as the mobile world gateway directly contradicts a frozen design decision, and D18's discipline ("测试绿才提交", decisions are not casually overturned) means that needs to be an explicit decision, not a side effect.

**Recommended shape instead:** a **new, separate Mobile Gateway** that (a) reuses the Bridge's *patterns and leaf modules* — the origin guard, the constant-time token compare, the atomic JSON writer, the RFC6455 framing code, the headless `createX(deps)` factory style mandated by D4 — and (b) exposes a **new, small, allowlisted verb set** with a versioned envelope. It must not import `bridge/routes.js`.

### 3.8 Which exposed APIs would be dangerous

| Exposed surface | Risk | Note |
|---|---|---|
| `POST /api/llm-proxy` | **Critical** — arbitrary URL + arbitrary headers forwarder; SSRF and credential relay | `bridge/routes.js:195-258` |
| `submit_payment` / `pay_register_checkout` / `pay_set_config` | **Critical** — payment authorization | `ib-bridge-service.js:790-883` |
| `pay_get_config` | High — leaks authorization policy and spend ledger | `:821-830` |
| `GET /api/config` | High — configuration snapshot | `bridge/routes.js:677` |
| `GET /api/diagnostics` | Medium — data volumes + integration enablement | `bridge/routes.js:308` (explicitly treated as sensitive in its own comment at `:306-307`) |
| `webhook` tool | High — invokes user-registered arbitrary URLs | `ib-bridge-service.js:869` |
| `session_save` / `session_get` | Medium — cross-device state write | `:876-877` |
| `whispers_*`, `letter_write` | Low | Domain data, but write-capable |
| `GET /api/tts/voices`, `/api/tts` | Low–Medium — consumes paid TTS quota | `:702`, `:687` |

### 3.9 Loopback-only today?

**Yes for everything except the Bridge.** 23114, 23116, and 23120 hard-code `127.0.0.1`. Only the Bridge can bind `0.0.0.0`, and only via `config.lan = true` or an explicit `IB_BRIDGE_HOST`. When it does, a token is auto-generated. So the product has **one deliberate, token-guarded LAN escape hatch, and no world API on it.**

### 3.10 What LAN/Tailscale would require

| Requirement | Current state | Needed |
|---|---|---|
| Per-device identity | none | device id + per-device token |
| Revocation | none (rotate the global token = break every client) | device registry with revoke |
| Token expiry | none (immutable until manually edited) | issued-at/expiry, refresh or re-pair |
| Transport confidentiality | **plain HTTP/WS** | Tailscale/WireGuard, or TLS with a pinned cert |
| Origin policy | loopback-only allowlist; **would reject a LAN `Origin` on the Bridge WS unless `LAN_EXPOSED`** (`ib-bridge-service.js:1039-1043`) | explicit device-origin policy, or origin-agnostic token auth for native clients |
| Replay protection | none | nonce/timestamp on mutating verbs, or TLS-only transport |
| Presence | none | heartbeat + device state |
| Rate limiting | Bridge only (`RATE_LIMIT={window:1000,max:60,burst:80}`, `bridge/routes.js:47-58`) | per-device limits on the gateway |

The Origin finding deserves emphasis: a native Android client sends **no `Origin` header** (or `null`). The Bridge's upgrade check tolerates a missing Origin (`if (origin && origin !== 'null')`, `ib-bridge-service.js:1034`), so a native client passes — but a *Capacitor* client, being a WebView on `https://localhost` or `capacitor://localhost`, **will** send an Origin, and `capacitor://localhost` fails the protocol check at `:1039`. This is a concrete, easy-to-miss integration failure for the Hybrid/WebView route in §12.

Also undocumented: **the WS upgrade path is never checked.** `services/ib-bridge-service.js:1025-1074` accepts an upgrade on *any* path; `/voice` is a client-side convention only (`assets/js/communication/call.js:12-16`). Any authenticated socket can reach the voice runtime.

### 3.11 Live security finding — `POST /api/llm-proxy` is an unauthenticated SSRF primitive

This is not a mobile-design concern; it is a **present-day defect in the shipping build**, found during this audit. It is reported here because the mobile work must not inherit it, and because the repository's own decision record currently tells engineers not to look here.

**The route.** `bridge/routes.js:319` → `proxyLlm()` at `:195-258`:

| Property | Code | Consequence |
|---|---|---|
| Caller-supplied URL | `:199-204` — takes `payload.url` verbatim, rejects only non-`http(s)` schemes | **No host allowlist, no private-IP rejection** |
| Caller-supplied method | `:205` — `String(payload.method \|\| 'POST').toUpperCase()` | An unauthenticated client can issue `GET`/`PUT`/`DELETE` against an internal target |
| Caller-supplied headers | `:207-214` — forwards all string-valued headers except `Host` | Header injection into internal requests |
| Verbatim body | `:214`, `:221` | |
| Redirect policy | `:221` — plain `fetch(target, {method, headers, body, signal})` | **Node's default is `follow`** — a `302` to a private address is followed |
| Auth | `:316` `httpAuthorized(req, q)` | **No-op on a default install**: `needsHttpToken()` (`bridge/config.js:207-211`) is `lanExposed \|\| (token set && !loopback)`; a default config has neither, and the existing browser client is loopback. A token is only minted when LAN-exposed (`:181-187`) |
| Response exposure | `:234-238` re-echoes `Access-Control-Allow-Origin: <requester>`; `bridge/config.js:120-123` accepts `Origin: null` | Any `file://` page or sandboxed iframe on the machine can **read** the response |

**Net effect:** any web page the user opens in any browser on the desktop — including one in a sandboxed iframe, which yields `Origin: null` — can drive the local Bridge to issue arbitrary HTTP requests to the local network and read the results.

**Why the docs do not surface it.** `/api/llm-proxy` is documented **nowhere**: `docs/ARCHITECTURE.md:512-524` enumerates the Bridge REST groups and omits it. Worse, `docs/DECISIONS.md:17` (D2) states *"Bridge 不做主聊天代理 … 主聊天由浏览器直连各家 API"* — and that is **factually false today**: `assets/js/communication.js:131-149` routes every LLM POST through `POST /api/llm-proxy` whenever the page origin is `file://` (`_ibProxyShouldRoute` returns `false` for http/https at `:112`). D2 is a decision record telling a future engineer not to look at the exact component that needs looking at.

**Caveat on severity, stated honestly.** D1 (`docs/DECISIONS.md:6-13`) explicitly accepts the `Origin: null` read/write risk for the Bridge's *data* endpoints, on the reasoning that this is a single-user personal local application. That reasoning is coherent for "a hostile page could read my whispers". It does **not** extend to "a hostile page can use my machine as a request relay into my LAN", because the latter is a new capability (outbound request origination) rather than a read of already-local data, and it is not what D1's risk paragraph contemplates.

**Recommendation.** This is out of M0's scope (M0 is read-only) and out of M1's scope. It should be raised as its own fix, with three candidate remedies in ascending cost: (a) restrict `proxyLlm` targets to a host allowlist derived from `provider-directory.js`; (b) require an explicit token or `file://`-only origin for this route even on loopback; (c) drop the route and let the browser call providers directly with CORS-appropriate handling. Remedy (c) is only viable once the product stops supporting `file://` as a first-class origin, which is a larger change. **The right first action is to correct D2 and document the route**, so the next engineer inherits an accurate map.

---

### 3.12 Undocumented exposure of the static server

Worth recording alongside §3.11 because it is the same class of gap: `services/internal-beyond-server.js:111` sets `ROOT = path.resolve(__dirname, '..')` — the static server serves the **project root**. `DENY_SEGMENTS` (`:117`) blocks `logs`, `node_modules`, `browser-data`, `__pycache__`, `.venv-vision`, `runtime`, `tools`, and `resolveRequest` (`:153-183`) refuses hidden segments and traversal. But `installer/` and `vision/` are **not** denied, so `http://127.0.0.1:23120/installer/tools/ib-stop.js` and `/vision/api.py` are readable over HTTP.

Loopback-only, and no credentials are exposed by those two paths, so the practical impact is low. It is listed because: (a) no document states what 23120 exposes, so nobody knows this boundary exists; (b) a mobile gateway added to the same tree would inherit the same default if it reuses `resolveRequest`; and (c) if the user ever enables `IB_WEB_PORT` with a widened bind, the whitelist is the only thing standing between the LAN and the repository.

---

### 3.13 Documentation drift that affects this work

The audit found the docs materially wrong in places that matter for a Home Node design. These are recorded because §15's answer depends on readers trusting source over prose.

| Claim | Document | Reality |
|---|---|---|
| "Bridge 不做主聊天代理" | `docs/DECISIONS.md:17` | **False** — `communication.js:131-149` proxies all LLM POSTs through the Bridge under `file://` |
| `/api/llm-proxy` does not exist | `docs/ARCHITECTURE.md:512-524` (route list omits it) | It exists and is the SSRF primitive of §3.11 |
| No `IB.runtime` / `ModelPort` / `callCharacterModel` | `docs/ARCHITECTURE.md` — **zero** grep hits for any of the three | `assets/js/agent-runtime.js` is **on by default** (`active-diary.js:442`) and fronts four consumers (`active-diary.js:498`, `:535`; `moments.js:86`; `active-diary/diary.js:219`) |
| DeepSeek reasoning "当前刻意不生效 … 一律 abstain" | `docs/HANDOVER.md:168-170` | **Stale** — `provider-directory.js:350-360` registers `deepseek-flash` with a `tierMap`; `docs/DECISIONS.md:349-373` (D19.1) is correct. HANDOVER is dated 2026-09-11 and contradicts its own release notes |
| `DB_VER 21` | `docs/SOCIAL_RUNTIME.md:117` | **23** (`assets/js/core.js:3`) |
| `assets/js/*.js` = 21 files | `docs/ARCHITECTURE.md:126` | **58** at top level, 73 recursive |
| Static style budgets 16+1 / 17 | `docs/ARCHITECTURE.md:745`, `:769` | The enforced contract is `styleSources.length === 20` (`tests/test_frontend_structure.js:79`) |
| P1-01 / P1-02 defects still open | `docs/history/runtime/RUNTIME-INTEGRATION-AUDIT-2026-09-08.md:102-113` | **Both fixed** — kind filter at `active-diary.js:1296`; `moment_comment_deleted` accepted at `moments.js:1740` (handler `:1657`, producer `active/moments.js:976`) |
| Memory is one subsystem | `docs/MEMORY.md` | It never mentions `autoMemory`, `roleLetterMemories`, `understandings`, or `threads`; and consolidation and plain recall enforce **different** visibility rules |
| `session_save` is "断线/换设备不丢" | `services/ib-bridge-service.js:877` | Overstated — `bridge/routes.js:619-639` stores an opaque blob; no world state crosses a device |
| Upstream Mobile's entry file is `IB压缩版.html` ("压缩版") | `docs/CHRONICLE.md:60-63` | **`index.html`** — 3 118 535 B, single file, `IB_VER='v244-p'`; there is no `IB压缩版.html` in that repository today (Appendix C) |
| Docs imply the two products "share data" | `docs/CHRONICLE.md:60-63`; upstream README | Only through the **backup JSON file**, and only for the 21 base stores — the eleven companion stores this checkout added are absent upstream (Appendix C.2) |

**Consequence for M1:** the authoritative sources are the code files, not `docs/`. Appendix A records the fact set this audit verified from source.

---

### 3.14 Flipping `config.lan` to `true` breaks parts of the desktop today

A second live finding of the same character as §3.11: it is not a mobile-design question, but the mobile plan's **v1 transport is LAN exposure** (§10.5), so the gateway would be built on top of a configuration that is currently half-broken. Recorded here because I verified it end to end.

**The mechanism.** `ibBridgeToken()` is declared inside `bridge.js`'s IIFE — `(function(NS){ … })(window.IB || (window.IB = {}))` (`assets/js/bridge.js:6`, closing at `:1153`) — and, unlike its siblings, it is **never published to `window`**: `window.ibBridgeBase` is assigned at `:13` and `window.ibBridgeFetch` at `:72`, but a repo-wide grep for `window.ibBridgeToken` / `ibBridgeToken\s*=` finds **only reads**, never an assignment. Therefore:

```js
// assets/js/communication/call.js:17
function token(){try{return typeof ibBridgeToken==='function'?ibBridgeToken():''}catch(e){return ''}}
```

`typeof` on an undeclared identifier evaluates to `'undefined'` — it does not throw — so this returns `''` **on every call**, and `wsUrl()` (`:12-16`) never appends `?token=`. Note `wsUrl` gets the *base* right for the same reason it works elsewhere: `window.ibBridgeBase` *is* global.

**Why that is fatal in LAN mode.** The voice channel's upgrade carries no header — a browser `WebSocket` cannot set `Authorization` or `X-IB-Token` — so the query string is the only channel available to it, and `services/ib-bridge-service.js:1055` is exactly where that matters:

```js
if (LAN_EXPOSED && !constantTimeTokenMatch(upgradeToken, config.token)) {
  socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); socket.destroy(); return;
}
```

with `LAN_EXPOSED = !!config.lan || !isLoopbackHost(configuredHost)` (`bridge/config.js:182`). So **voice calls return 401 the moment LAN is on**, before the `hello` frame — the second boundary at `bridge/ws.js:166-172` never even runs.

**A second broken call site, same class.** `assets/js/social.js:454` posts the voice-preview with a bare `fetch(ibBridgeBase()+'/api/tts', {headers:{'Content-Type':'application/json'}})` — no `X-IB-Token` — and `:456` plays `new Audio(ibBridgeBase()+j.url)`, a media-element request that *cannot* carry a header by construction. In LAN mode `needsHttpToken()` (`bridge/config.js:207-211`) is true for **every** caller including loopback, and the global gate at `bridge/routes.js:316` sits below only `/health`, `/status` and `/api/diagnostics` — so the desktop's own voice-test button fails twice over: the POST is rejected and the audio URL is unauthenticated.

**The paths that are correct** — which is what makes this a localized regression rather than a design flaw: `communication.js:122-128` reads `window.ibBridgeToken` (absent) but **falls through to `IBNET.cfg().token`**, so the LLM proxy does send `X-IB-Token` (`:138`); every `bridge.js` REST call goes through `ibBridgeFetch` (`:29-44`); in-chat TTS playback uses `ibBridgeLoadAudio`, which fetches the audio as a blob precisely so the token can ride a header (`:64-71`); and `integrations.js:1165-1172` appends `ib_token=` for the tool socket. The pattern is understood and applied — three call sites were missed.

**The rule the code already follows, stated so it can be tested:** *a Bridge call that cannot attach a header must carry the token in the query string, and a Bridge asset that will be consumed by a media element or `<img>` must be blob-fetched rather than linked.*

**Recommendation** (out of M0/M1 scope, but cheaper before the gateway exists than after): (a) publish `window.ibBridgeToken = ibBridgeToken` in `bridge.js`; (b) route `social.js:454` through `ibBridgeFetch` and `:456` through `ibBridgeLoadAudio`; (c) add a contract test in the style of `tests/test_diagnostics.js:115` that fails when a bare `fetch(`/`new Audio(`/`.src=` appears adjacent to `ibBridgeBase()` in `assets/**`; (d) treat "LAN mode on, then click every Bridge-backed desktop feature" as the acceptance check for §10.5 v1 — this defect would have been found by exactly that pass.

---

## 4. Canonical Data Authorities

Per domain: who executes, who stores, what the schema is, and whether Node can reach it.

### 4.1 Chat

**Executor: the browser. 100%.** `sendChatMessage` (`assets/js/communication.js:1604`) → `callApiChatStream` (`:3473`) → `_callApiChatStreamOnce` (`:3632`) → `_ibApiPost` (`:131`) → provider SSE.

**Storer: the browser.** `dbPut('chatMessages', …)` at `:1660` (group user), `:1910` (group assistant), `:1995` (1:1 user), `:2304` (streaming assistant), `:2394` (non-streaming assistant).

**Canonical message schema** (real literals):

```js
// user — assets/js/communication.js:1989-1994
const userMsg={id:'msg_'+Date.now()+'_u',role:'user',content:text,
  friendId:_targetFriend,timestamp:Date.now()};
if(sentImages.length) userMsg.images=sentImages.map(img=>({dataUrl,base64,mime,name}));
if(sentFiles.length)  userMsg.files =sentFiles.map(f=>({name,ext,size,text}));
if(_voice)            userMsg.voice ={dataUrl,mime,duration,transcript,tone};
if(_targetThread)     userMsg.threadId=_targetThread;

// assistant — assets/js/communication.js:2297
const aiMsg={id:'msg_'+Date.now()+'_'+Math.floor(Math.random()*100000),
  role:'assistant',content:replyText,reasoning_content:thinkingText||'',
  metadata:{model:cfg.provider||cfg.model||'',model_id:cfg.model||'',
            config_id:cfg.id,showThinking:_resolveShowThinking(cfg)},
  friendId:_targetFriend,timestamp:Date.now()};
```

| Field | Type | Notes |
|---|---|---|
| `id` | string | **PK.** Browser-generated only. `msg_<ms>_u` (user) / `msg_<ms>_<rand>` (assistant) / `msg_sys_<ms>_<rand36>` (group system event, `social.js:1867-1874`) / `_activeMessageId(settingId, scheduledFor)` (proactive, `active-diary.js:1301`) |
| `role` | `'user'\|'assistant'\|'system'` | |
| `content` | string | Final text only; streaming deltas are **never** persisted incrementally |
| `reasoning_content` | string | |
| `friendId` | string | **This is the conversation key.** An `apiConfigs.id`, or `group_<ms>` |
| `senderName` | string? | Mandatory on group assistant rows (`:1905`) |
| `timestamp` | number | ms epoch |
| `threadId` | string? | Channel within a character |
| `images` | array? | `{dataUrl,base64,mime,name}` + lineage `{imageId,parentImageId,generationType,editDepth,model}` for generated ones (`workspace.js:280-294`) |
| `files` | array? | `{name,ext,size,text}` — the `raw` base64 is deliberately dropped from the record (`workspace.js/files.js:38` uses `f.raw`, but the persisted record carries only extracted `text`) |
| `voice` | object? | `{dataUrl,mime,duration,transcript,tone}` |
| `metadata` | object? | `{model,model_id,config_id,showThinking}` + surface tags: `{source:'voice_call',callSessionId,turnId}`, `{source:'active_message',activePlanId,…}`, `{waifu:true}`, `{eventType,characterId}` |
| `truncated`, `withdrawn`, `withdrawnBy` | bool/string? | |
| `wsSearches`, `memOps`, `calNotes` | array? | Tool-result echoes |

**There is no conversation/thread table.** The conversation is implicit in `friendId`. Separate stores hold `groups` (`social.js:1772`) and `chatThreads` (`social.js:2003`).

**Attachments are inline base64 data URLs inside the IndexedDB record.** There is no blob store, no filesystem store, and no CDN. A single chat image is stored twice (`dataUrl` full data-URI *and* `base64` payload) in the same row.

**Streaming:** `fetch` + `res.body.getReader()` + `TextDecoder`, parsing `data:` lines (`:3731-3741`). Delta handlers per provider: anthropic `text_delta`/`thinking_delta` (`:3763-3769`), gemini `p.thought`/`p.text` (`:3775-3776`), openai `delta.reasoning_content`/`delta.content` (`:3783-3784`). Only the terminal write persists.

**Group chat** shares the store, keyed `friendId = 'group_<ms>'`, with `senderName` mandatory. Turn-taking is a serial in-process `for` loop (`:1716`), not a scheduler; earlier speakers' replies are handed to later speakers via `roundExtras` (`:1739`, `:1911`). Only the speaking member's own lines map to `assistant`; everyone else's map to `user` with a `[Name]` prefix (`:1740-1747`).

**Quotes, reply-chains in chat, and emoji reactions do not exist.** `replyTo` is a Moments-comments-only field (`moments.js:461`). Favorites exist (`favorites.js:40-44`) as a *reference plus text snapshot*, re-reading bytes from `chatMessages` by `sourceId` (`:17-33`) — so a favorite degrades to text if the source message is deleted.

**Node-reachability: no, and this is G1.** No Node file reads or writes `chatMessages`. Node's only involvement in a chat turn is stateless transport (`proxyLlm`, `bridge/routes.js:195-258`), engaged only for `file://` origins.

### 4.2 Character Runtime

There is no "Character Runtime" module. A character *is* an `apiConfigs` record — a provider configuration that doubles as a persona:

- Storage: IndexedDB `apiConfigs`, written by `_persistApiConfig` → `dbPut('apiConfigs', saved)` (`social.js:703`, `:712`).
- Persona fields live on the same record: `nickname`, `systemPrompt`, `relationship`, `temperature`, `replyStyle`, `naturalEnding`, `conversationContinuity`, `amRecordOnly`, `imageGen` + `imageGenEndpoint`/`imageGenApiKey`/`imageGenModel`, plus `reasoningEffort`.
- Provider metadata is **not** duplicated per character: `assets/js/provider-directory.js` is the sole source of `endpoint`/`model`/`format`/`vision`/`streaming` (`:37-54`, plus OpenRouter and custom-relay entries at `:741`, `:762`). This is a locked contract (`MEMORY.md`: *provider metadata 唯一源为 assets/js/provider-directory.js*).
- `apiConfigs` is the single-write-path contract (P4): all UI save flows must go through `addNewApi`/`saveCurrentApi` → `_persistApiConfig`. `tests/test_api_onboarding.js:174` machine-enforces that onboarding code contains no `dbPut|indexedDB|localStorage|_persistApiConfig|createObjectStore`.
- **Correction, and it matters for a Node-side character store: the chokepoint is real but it is not the *only* writer.** A repo-wide search for `dbPut('apiConfigs'` finds **five** production sites; four of them are outside the chokepoint:

  | Site | Mechanism | What it writes |
  |---|---|---|
  | `social.js:712` — inside `_persistApiConfig` | the chokepoint: `dbPut` + mirror (`:714`) + `updatedAt` success marker (`:704-707`) | every user-facing save; also `core.js:1123` (import), `local-first.js:134`, `site-operations.js:7` (`clearAllApiKeys`), `social.js:1262` (`saveCurrentApi`), `:1348` (archive) |
  | `social.js:760` — inside `loadApiConfigs` | **direct** `dbPut` | one-shot legacy migration from the old `apiSettings/main` record (`id:'friend_1'`, `:757-762`) |
  | `memory.js:1440` — `setChatSealTimestamp` | **direct** `dbPut` | chat "seal line" mirror; the authority is `apiSettings` (`:1436`) |
  | `memory.js:1451` — `clearChatSeal` | **direct** `dbPut` | seal-line tombstone |
  | `memory/auto-memory.js:576` — `amToggleRecordOnly` | **direct** `dbPut` | the silent-mode flag |

  The three direct writers bypass the `updatedAt` marker that `_persistApiConfig` guarantees, which means `loadApiConfigs`'s precedence rule (`social.js:735-752`) can treat such a record as *older* than a mirror copy. For this audit the operative point is narrower and more important: **a Node-side character store that mirrors `apiConfigs` on `_persistApiConfig` alone would silently miss three mutation sites**, and one of them (`chatSeal`) is written on ordinary chat activity rather than on a settings save. Any eventual migration must hook the *store*, not the helper.
- **Context loading and prompt composition are browser code**: `_buildSingleChatContext` (`communication.js:1398-1509`) and `_buildGroupChatContext` (`:1510-1556`), orchestrated by `buildChatContext` (`:1557`).

**Node-reachability:** only as a per-task snapshot pushed into a request payload (`active-diary.js:1226-1231`). Node has no character store and no persona config file (`active/http.js:240-258` writes whatever the browser sent).

### 4.3 Middle Brain

Fully audited; see §1.5 for the two corrections. Summary of the real model:

- **Six UMD-less IIFE files** loaded as `<script>` tags at `InternalBeyond.html:2996-3001`, in a strict dependency DAG config → policy → astra → judge/integrity → facade (`middle-brain.js:10-16`).
- **Config** persisted in IndexedDB `apiSettings`, record id `'middle_brain'` (`middle-brain-config.js:141-143`), fields: `enabled` (default **false**), `provider('astra')`, `endpoint`, `model`, `apiKey`, `admissionEnabled`, `gate{}`, `middleBrainJudgeEnabled(false)`, `reasoningEffort('auto')`, `speed('standard')`, `characterIntegrityEnabled(false)`, `characterIntegritySensitivity('conservative')`, `characterIntegrityRewrite(false)`, `characterIntegrityVerify(false)`, `imageMode('auto')` (`:20-59`).
- **Readiness** = `enabled && endpoint && model` — deliberately **not** apiKey (`middle-brain-config.js:152-155`).
- **Admission Gate** is a deterministic scoring gate (weights `{context:.35, dialogue:.15, items:.20, redundancy:.30}`, thresholds `scoreOn .60` / `scoreHold .45`, cooldown 90 s, hysteresis 180 s, `middle-brain-policy.js:223-236`), with in-memory-only state (`:237`) and a named reason vocabulary (`:261`).
- **Astra** is the *only* network boundary for Middle Brain (`middle-brain-astra.js:119-127`), 20 s timeout (`:181`).
- **Judge** runs only after successful Astra compression (`middle-brain.js:120`), default off.
- **Integrity / OOC Guard** is a post-generation reply rewriter over six dimensions, max one rewrite per turn, default off → zero model calls (`middle-brain-integrity.js:25`, `:34-38`, `:364`).
- **Canonical entry points**: `IB.middleBrain.middleBrainExecute` (`middle-brain.js:159`) for context, `IB.middleBrain.middleBrainFinalizeReply` (`:181`) after generation. Both deliberately **have no `window.*` alias** (`:259-260`).
- **One genuine cross-surface policy gate**: Image Router reads `middleBrainImageMode()` (`image-router.js:49-59`).

**Node-reachability: no.** Seven concrete blockers are enumerated in §4.10. Note also that `middleBrainExecute` is *not* the generation seam, so "route Android through the existing seam" is not available as a shortcut.

### 4.4 Memory

**Single store, no vectors.** Full detail in §1.5. The operational facts that matter for the gateway:

| Memory type | Store | Writer |
|---|---|---|
| Long-term episodic/semantic/core | `memories` | `quickCreateMemory` (`memory.js:873-904`) — the canonical path |
| AI-owned profile | `autoMemory` | `_execMemOps` (`memory/auto-memory.js:336` etc.) |
| Understanding (living document) | `understandings` | `unWrite` (`memory.js:951-974`) |
| Open thread | `threads` | `thOpen` (`memory.js:1011-1041`) |
| Diary → memory projection | `memories` (`source:'diary'`, `visibility:'only'`) | `_diaryWriteMemory` (`active-diary/diary.js:128-148`, write `:144`) |
| Role-letter memory | `roleLetterMemories` | `_rlWriteRoleMemory` (`role-letters.js:220-241`) |
| Chat summary | `chatSummaries` | `saveChatSummary` (`communication/summary.js:91-94`) |

**The ranker**, quoted because it is the whole retrieval algorithm and it is short:

```js
// assets/js/memory.js:9-22
if(mem.pinned) return 999;
daysSince=(now-(mem.lastActivated||mem.created))/86400000;
lambda=mem.resolved?0.12:0.05;
emotionFactor=1.0+(mem.arousal||0.3)*0.8;
activationFactor=1+activationCount/(activationCount+300);
score=(mem.importance||5)*activationFactor*Math.exp(-lambda*daysSince)*emotionFactor*100/100;
```

Relevance is substring overlap (`_calcRelevance` `memory.js:50-57`, `1 + hits/keywords.length*1.5`, capped 2.5×) over keywords extracted as English words ≥3 chars plus Chinese 2- and 3-grams (`_extractKeywords` `:38-49`). `memories` has **no index** — every read is a full-table `dbGetAll`.

**Retrieval has a write side effect:** `getMemoryContext` increments `activationCount` and sets `lastActivated` on every selected row (`memory.js:118-123`). Any Node re-implementation must decide whether to preserve this — it feeds the decay term and the fatigue penalty (`:78-83`).

**Writes are AI-driven and automatic**, driven by `_activeTick` every 30 s (`active-diary.js:1340`) which fans out to `_diaryTick`, `_momentsTick`, `_roleLettersTick`, `_consolidationTick`, `_understandingAndThreadTick` (`:1173-1177`). Consolidation requires `importance ≥ 6` (`:768`) plus an admission gate (`:771-787`), and merges at bigram similarity ≥ 0.8 (`:798`). Per-reply Auto Memory tags are scraped from the assistant's own text (`_parseMemOps` → `_execMemOps` at `communication.js:2273-2274`) with `MAXOPS=3`.

**Node-reachability: read-only, and only via a pre-ranked snapshot.** `services/` has **zero** memory references. The single channel is the `recent_memories` array (≤8 rows, already ranked browser-side by `_activeRecentMemories` `active-diary.js:368-375`) inside the task payload, clamped at `active/http.js:332` and `:437`. Node formats it (`active/model-client.js:133-139`, prompt line `:168`).

> **Direct answer to the brief's question:** *Desktop can be the sole memory authority, but only once memory retrieval is reachable from Node.* Today the authority is the browser and Node is a consumer. Android needs **only a memory read DTO** — and that DTO already exists in shape (`{title, content, summary, created, relevance}`), it is simply produced by the wrong process. Android must never write memory directly: every memory write today is AI-driven with an approval queue, so a direct write API would bypass admission control entirely.

### 4.5 Active Companion / Proactive

Fully traced in §2.4. The answers to the brief's specific questions:

- **scheduler → role context → provider → model → save → last_sent:** `schedulerTick` (`active/scheduler.js:577-664`) → `executeTask` (`:94-276`) → `generateProactiveMessage` (`active/model-client.js:417-505`) → `callCharacterModel` (`:294`) → `NodeModelPort.run` (`node-model-port.js:60`) → persist `history[runId]` + `events[eventId]` (`scheduler.js:244-270`) → `saveNow()` (`:271`) → `last_sent` written at `:236-238`.
- **Is there a unified "message written to canonical chat" seam?** **No — and this is the critical negative finding.** The Node side never writes canonical chat. There is exactly one seam and it is a *durable poll queue*: `state.events` in `active-message-service.json`. Android notifications should consume **that**, and the canonical write must remain with whichever process owns the world.
- **Start delay:** first tick at `IB_ACTIVE_START_DELAY_MS` default **35 000 ms** (`active-message-service.js:27`), then every **15 000 ms**.
- **Suppression:** `adaptiveSkipReason` postpones if the user messaged within 12 h (`scheduler.js:80-92`); plans cancel on user reply (`:361-364`), attempt exhaustion, or no-reply-to-last-proactive (`:369-376`); DND reschedules with no model call (`:378-380`).
- **Retry:** tasks do ≤3 in-prompt attempts then a character-flavoured fallback; plans retry at +15 min up to `maxAttempts` (`:520-522`).
- **Crash recovery:** records stuck in `evaluating|sending` for >10 min are recovered (`:607-631`). Good pattern to copy.

### 4.6 Moments

**Split by capability, not by storage — this is the accurate description.**

- **Browser `assets/js/moments.js` is the CRUD authority.** Store `moments` (`:9`), schema at `:324-347`: `id('mom_…')`, `authorType('user'|'role')`, `authorId`, `roleId`, `content`≤2000, `images[]`≤9, `visibility('all'|'user'|'roles'|'private')`, `visibleRoleIds[]`, `likes[]` (array of string ids), `comments[]`≤200, `source('manual'|'proactive')`, `motive` (8-value enum), `repostOf`, `repostText`, `createdAt` (ISO).
- **Comment schema** (`:461`): `{id:'mc_…', authorType, authorId, content≤600, replyTo, createdAt}` + optional `withdrawn`. Threading is a flat array with `replyTo`; the tree is built in the UI, depth-capped at 3 (`social-network.js:556-570`).
- **AI author identity** = `authorType==='role' && authorId===apiConfig.id`; resolved via `_momentsAuthorRoleId(m)=String(m.roleId||m.authorId)` (`:313-315`), display name from `apiConfigs[].nickname||model` (`:364`, `:1847`).
- **Node `active/moments.js` owns schedule + reply-chain task state and executes generation while the browser is closed** (`:492` requires `armedUsers.has(userId)` at `:500`). It shares `reply-chain-core.js` verbatim (`:33`, per D10) so prompts and limits are single-sourced.
- **They do not share storage.** Node holds `state.moments[characterId]` = schedule + context snapshot only (`active/http.js:430-448`).
- **Handoff:** browser → Node via `PUT /moments/:characterId` (`moments.js:1607`); Node → browser via events of `kind:'moment'|'moment_reply'|'moment_comment_deleted'` (`active/moments.js:284`, `:976`, `:998`) ingested at `moments.js:1654` and ACKed per event id.
- **Mutual exclusion** prevents double-generation: when the companion is online with the `reply_chains` capability, the browser skips local scheduling (`moments.js:1508-1510`, `:1781-1786`, `:1256-1258`), with a `/health` capability probe to fall back on an old Node build (`:1593-1598`).
- **Pagination is in-memory slicing, no persisted cursor.** `_momentsScanDesc` uses the `byCreated` index with `openCursor(null,'prev')` and early stop (`:270-291`), scan cap `MOMENT_FEED_SCAN_MAX=360`, first scan 60; the UI holds `_momentsFeedShown` and slices (`:1848`, `:1906`, load-more `+30` at `:1961-1964`).
- **No edit path for any moment or comment — create and delete only.** The only ACK mechanism is Node→browser per-event (`:1662`, `:1666`, `:1677`, `:1690`), keyed on `moment.id`/`comment.id` for idempotency.

**Which parts map cleanly to a Mobile API:** read feed (bounded, cursor-shaped), read single moment + comments, create user post, delete own post/comment, like/unlike, and the event outbox for AI-authored content. All are bounded, id-indexed, and already have idempotency keys.

### 4.7 Diary / Letters

**Both are 100% browser-only. No Node implementation exists** — grep for `diary|roleLetter|letters` over `active/**` and `services/**` returns zero matches. Also, three paths in the brief do not exist: `assets/js/diary.js`, `assets/js/letters.js`, `assets/js/coread.js` are **not files**. The real paths are `assets/js/active-diary/diary.js`, `assets/js/communication/letters.js`, `assets/js/activity/coread.js`.

**Diary** — store `diary_entries` (`active-diary/diary.js:6`), schema `:32-48`: `id('diary_*')`, `characterId`, `date('YYYY-MM-DD')`, `title`≤120, `content`≤8000, `mood`≤40, `diaryType(['daily','weekly','event','emotion'])`, `importance` 0-10, `relatedMemoryIds[]`, `trigger(manual|weekly|daily_plan|first_chat|return_after_gap|wish)`, `reason`, `createdAt`.

Triggers (`_diaryTick` `:344`, driven from `active-diary.js:1173`):
- **Weekly cron** — `now.getDay()===prefs.weeklyDay && minutes>=prefs.weeklyTime`, ISO-week watermark (`:356-361`).
- **LLM daily planner** — `_diaryDailyPlanner` (`:312`), date watermark, writes only if `importance>=6` (`:335`).
- **Event triggers** — `_diaryMaybeEvent` (`:377`): first user message, or a >3-day chat gap; invoked from `communication.js:2001`.
- **Manual** — `_diaryWriteNow` (`:452`), `_diaryTodayWish` (`:460`), bound to HTML buttons at `InternalBeyond.html:903-904`.

**There is no random-diary feature.** "Random" exists only in Moments.

Diary generation reads memory via `_diaryContext` (`:82-94`) → `buildDiaryPrompt` (`:96-126`, label `【相关长期记忆】` at `:113`) → `_diaryModelCall` (`:219`) → writes the entry (`:302`) then the memory projection (`_diaryWriteMemory` `:128-148`, requiring `importance>=6` at `:131` and bigram similarity `<0.8` at `:138`).

**Letters — two distinct domains, do not conflate:**

| | System letters (character → user) | Role letters (character → character) |
|---|---|---|
| Store | `letters` (`communication/letters.js:24`) | `roleLetters` + `roleLetterMemories` (`role-letters.js:25-26`) |
| Schema | `{id:'letter_'+Date.now(), from, content, friendId, created}` + optional `isDiablo` (`:283-284`) | `{id:'rletter_*', fromRoleId, toRoleId, content, kind:'init'\|'reply', parentId, createdAt, readAt, replyStatus}` (`:251-256`) |
| `readAt` | **absent** | **present** (`:253`) |
| Owner filter | `friendId` | `byTo`/`byFrom` indexes (`:106-107`, `:337`, `:506-507`) |
| Trigger | **user click only** — `requestLetterFromSelected()` (`:167`), 180 s cooldown | `_roleLettersTick` (`:365`) → `_rlInitStep` (`:259`, 1/day + 24–72 h pair cooldown) → `_rlReplyStep` (`:296`, 1–6 h delay) → `_rlReadMemoStep` (`:335`, writes the receiver memory only after actual reading) |
| Memory | via `getMemoryContext` (`:248`) + Auto Memory ops (`:276-277`) | `roleLetterMemories`, purpose-isolated: `owner`, `roleKey`, `direction('send'\|'receive')`, `letterId` (`:230-236`) |

Note the brief asked about `readAt` on letters — it is a **role-letter-only** field.

**Node-reachability:** none for either domain. Android shows and acts; generation stays on the Home Node.

### 4.8 Image Router

- **Unified entry:** `IB.imageRouter.routeImageRequest` (`image-router.js:103`). Executors: `_wsExecImageGen` (`workspace.js:215`) and `_wsExecImageEdit` (`:149`). Producers: Moments (`moments.js:729`, `:732`) and chat image-gen (`workspace.js:369`).
- **Config lives on the `apiConfigs` character record** (`workspace.js:42-46`): `imageGenEndpoint` (empty = reuse the text `endpoint`), `imageGenApiKey` (empty = reuse the text `apiKey`), `imageGenProvider`, `imageGenModel`. Resolution at `:217-220`; the Image Router's own view at `image-router-config.js:136-137`.
- **Capability rules** (`_imgEditCapability` `workspace.js:138-146`): OpenAI-compatible `gpt-image*`/`dall-e-2` → `POST /v1/images/edits` (multipart); Gemini → `generateContent` with `inlineData`; Anthropic/DeepSeek → `IMAGE_EDIT_UNSUPPORTED`. Editing is never silently downgraded to regeneration.
- **Credentials:** `imageGenApiKey` sits in the *same* plaintext IndexedDB record as `apiKey`, and is filled straight back into a UI input with no masking (`social.js:1106`).
- **Generated-image storage:** inline data URLs in the message record. `_imgPickOpenAIImage` (`workspace.js:100-111`) reads `data[0].b64_json` or downloads `data[0].url` via `fetch` → `FileReader` → base64.
- **Chat image representation:** `userMsg.images[]` for uploads (`{dataUrl,base64,mime,name}`, produced by `compressImage` `communication.js:653` using `FileReader`/`Image`/canvas, limits `IMG_MAX_PX=2048`, `IMG_QUALITY=0.92`, `IMG_MAX_COUNT=6`, `IMG_MAX_BYTES=20 MiB` at `:610`); `aiMsg.images[]` with lineage for generated ones.
- **Vision:** a separate optional Python service. `communication.js:709` `LOCAL_VISION_ENDPOINT='http://127.0.0.1:8765/vision'`, POSTed at `:732`. Entry `vision/api.py`, Qwen2.5-VL, uvicorn on loopback, venv at `.venv-vision`. **Not shipped in the installer.**

**Node-reachability: no.** Every image call is a browser `fetch` with browser-only helpers (`atob`, `Blob`, `FormData`, `FileReader`, `canvas`). `workspace.js` bypasses the shared LLM transport entirely — it does not go through `_ibApiPost`, so it does not benefit from the Bridge proxy at all.

**Android boundary, as the brief specifies:** camera/file → upload to Home Node → canonical image object → runtime/image-router. **No provider key on the device.**

### 4.9 Voice / Video

**Two corrections to the brief up front, both verified:**

1. **`<ws_vsnap/>` does not exist in code.** Exactly one occurrence repo-wide: `docs/VIDEO-RUNTIME-P2.md:89`, listed as *"留档（不在 P2，需专门 design）"*. Nothing emits it and nothing consumes it. The complete set of `<ws_*>` openers the parser actually knows is `assets/js/workspace.js:776` — `vsnap` is absent. The nearest real tag is `<ws_read_image>` (`workspace.js:447-448`), which is an ICode *file* reader, not a camera snapshot.
2. **There is no video call and no WebRTC.** `RTCPeerConnection|RTCDataChannel|getDisplayMedia` → **zero** hits repo-wide. A "video call" is a voice call plus **one JPEG frame per turn**; the Bridge WS only ever receives audio PCM.

**Real file locations** (the brief's paths are partly wrong — five of the named files live in subdirectories): `assets/js/communication/voice.js`, `assets/js/communication/call.js`, `assets/js/communication/video-runtime.js`, `assets/js/workspace/run.js`, `assets/js/memory/constellations.js`.

#### Voice pipeline — nine stages, and the LLM turn is stage 8, in the browser

| # | Stage | Executes where | Evidence |
|---|---|---|---|
| 1 | Mic capture | **Browser** | `communication/call.js:87` `getUserMedia({audio:{…},video:false})` |
| 2 | Resample → 16 kHz PCM16 + RMS | Browser AudioWorklet | `assets/js/voice-worklet.js:6-31`; module loaded `call.js:99` |
| 3 | Client VAD / pre-roll | Browser | `call.js:214-241`; thresholds `call.js:49` (`endSilenceMs:650`, `bargeInMs:500`, …) |
| 4 | Raw PCM over WS binary frames | Browser → Node | `call.js:129` `new WebSocket(wsUrl())`, `:237` `this.ws.send(pcm)` |
| 5 | WS accept | Node, 23115 | `services/ib-bridge-service.js:1025-1074` |
| 6 | ASR | **Node → remote provider** | `bridge/voice-runtime.js:325` → `bridge/asr.js:39-62` `openaiWhisperTranscribe` |
| 7 | `transcript_final` back to client | Node → Browser | `bridge/voice-runtime.js:348`; received `call.js:484-486` |
| **8** | **LLM turn — prompt, history, memory, tools** | **BROWSER** | `call.js:440` `await sendChatMessage({voiceCall:true,…})` → `communication.js:1604` → `:2208` `callApiChatStream` |
| 9 | Streamed sentences → TTS → audio chunks | Browser (tap) → Node (synth) → Browser (play) | `communication.js:2920-2946` → `call.js:454` → `voice-runtime.js:164-203` → `call.js:384`, `:300-326` (per-sentence MSE `MediaSource`) |

**The decisive fact:** the voice runtime on the Node side **never calls a model**. `bridge/voice-runtime.js:360-366` validates only that `roleId`/`conversationId` are non-empty; it never resolves a character, never reads `apiConfigs`, never builds a prompt. Its own header says it owns *"audio, ASR, call state and generation lifecycle"* and that *"calls, tools, history, or memory … stay in the browser chat runtime"* (`bridge/voice-runtime.js:2`, echoed `bridge/asr.js:13`). A thin Android client therefore has no server-side voice turn to call today.

#### Call state machine — the server owns state, the browser owns the clock

Node machine (`bridge/voice-runtime.js:21-30`, enforced `:69-76`) — illegal transitions are coerced to `listening` except `interrupting`:

```
idle:         [connecting, listening, error, ended]
connecting:   [listening, error, ended]
listening:    [listening, thinking, speaking, interrupting, error, ended]
thinking:     [listening, speaking, interrupting, error, ended]
speaking:     [listening, interrupting, error, ended]
interrupting: [listening, error, ended]
error:        [listening, ended]
ended:        []
```

Browser mirror (`call.js:59-69`) adds UI-only labels and drives the duration timer (`:65-77`). A separate client-only machine handles the incoming-call overlay (`offerIncoming` `:604-621`, `acceptIncoming` `:635-642`), fed by the proactive plan path (`active-diary/active-plans.js:634-701`).

**Reconnect:** `VS_MAX_RECONNECT=5` (`call.js:27`), backoff `min(8000, 1000·n)` (`:165-182`); the handshake completes on `hello_ack` alone (`:153-159`). One caveat that a mobile plan must absorb: this transport is **proven on loopback only**, because the token it passes in the handshake (`call.js:17`) evaluates to an empty string on every call — see §3.14. It works today because a default install requires no token; it returns 401 as soon as LAN exposure is enabled, which is the configuration the gateway needs.

#### Barge-in — exists, in three layers with four stale-drop guards

1. **Browser VAD trigger** (`call.js:229-234`): while playing, the enter threshold is scaled by `speakingGain:2.8` (vs `gain:3.2` idle) and needs 500 ms of sustained speech.
2. **Browser interrupt** (`call.js:243-267`): bumps `turnEpoch`, bumps `asrGeneration`, `stopAudio()`, `stopStreaming()`, sends `{type:'interrupt'}`.
3. **Node interrupt** (`voice-runtime.js:119-143`): bumps `generation` **and** `asrGeneration`, cancels the pending turn, closes the ASR session, clears the TTS queue, emits `interrupted`.

Stale-drop guards exist at `call.js:385-386` (audio by `generation_id`), `:485` (transcript), `voice-runtime.js:169` (TTS emit), `:291` (ASR partial). This is a well-built subsystem and the pattern is worth reusing wholesale.

#### Voice profiles and reference audio (Node assets)

- Files `DATA_DIR/tts-voices/<refAudioId>.<ext>`; registry `DATA_DIR/tts-voices.json` (`bridge/tts-voices.js:14-15`, `:78`). `DATA_DIR` = `%LOCALAPPDATA%\InternalBeyond\bridge`. *Verified on disk: the directory exists and is currently empty; no `tts-voices.json`.*
- Triple validation — content-type, extension, and magic bytes; MP3/WAV only, ≤10 MB (`:23-26`, `:40-51`, `:121-145`). Path resolution comes only from the registry's stored `ext` (`:111-118`) — no user-controlled path concatenation. Good.
- **Field-name asymmetry to be aware of:** the client-side profile uses `voiceData = {refAudioId, mime, name, size}` (`social.js:1232-1237`) while the server registry uses `{refAudioId, mime, ext, size, originalName, created}` (`tts-voices.js:158`).
- Routes: `POST/GET /api/tts/voices`, `GET|HEAD|DELETE /api/tts/voices/:id` (`bridge/routes.js:696-774`), with a 409 when a delete target is still referenced. **This is the closest existing precedent for the attachment upload/download API** proposed in §8.4 — a Node-side binary asset store with a registry, validation, and reference checking.

#### TTS and ASR providers, and where their keys live

| Provider | Models | Endpoint | Key location |
|---|---|---|---|
| `edge` | — | `wss speech.platform.bing.com/…/edge/v1` (`bridge/tts.js:82-84`) | hardcoded trusted-client token (`:84`), no config |
| `openai` | `tts-1`, `tts-1-hd`, `gpt-4o-mini-tts` | `config.tts.endpoint` (`:531-539`) | `%LOCALAPPDATA%\InternalBeyond\bridge\config.json` → `.tts.apiKey` |
| `mimo` | `mimo-v2.5-tts` + voiceclone + voicedesign | `config.ttsMimo.endpoint` (`:540-553`) | same file → `.ttsMimo.apiKey` |

**ASR: exactly one provider, turn-based.** `openai-whisper` with `streaming:false` and `createSession:()=>null` (`bridge/asr.js:66-72`); the streaming *protocol* exists and is ready (`voice-runtime.js:286-303`, session contract documented `asr.js:96-103`) but no provider implements it. Config `config.voiceAsr` (`bridge/config.js:46-54`) carries the comment *"仅保存在 Bridge；绝不发送到浏览器"* — verified true; the config snapshot masks it (`bridge/routes.js:101-124`).

**Two separate transcription paths exist**, and this matters for a mobile design: voice *calls* use the Bridge ASR (key Node-side, never sent to the browser), while voice *messages* use a browser-side path — either the Web Speech API (`communication/voice.js:321-331`) or a user-configured `/audio/transcriptions` endpoint whose key is stored in **browser IndexedDB** `apiSettings` `'voiceTrans'` (`:43`, `:80`). A thin client must not inherit the second.

#### Video: what it actually is

`assets/js/communication/video-runtime.js` (160 lines, `window.IBVideoRuntime`) does camera → `<video>` preview → offscreen canvas → `toBlob('image/jpeg')` → existing `compressImage` → `{dataUrl, width, height, timestamp}` (`:54-109`). Its own header lists its non-goals: it does not build `visionReference`, does not route models, does not persist (`:5-7`). **`setLoop` is defined but never called** — so there is no periodic capture, exactly one frame per conversation turn. The frame rides the ordinary chat turn (`call.js:436-440` → `communication.js:2102`), which is why the Middle Brain integrity guard self-disables on the voice surface (`middle-brain-integrity.js:367`) and why no separate video runtime is needed.

#### Native vs AI-runtime classification

| Capability | Class | Where it runs | Evidence |
|---|---|---|---|
| Microphone capture, permission UX | **Native device** | Browser | `call.js:87-92` |
| PCM downsample (worklet) | Native (DSP) | Browser | `voice-worklet.js:6-31` |
| Speaker playback, MSE streaming | **Native device** | Browser | `call.js:300-382` |
| Output device selection, mute | Native (UI) | Browser | `call.js:500-511` |
| Camera capture, JPEG encode | **Native device** | Browser | `video-runtime.js:61-63`, `:77-109` |
| Notification display | **Native device** | Browser/OS today | `active-diary.js:1181-1183` |
| File/photo picker | **Native device** | Browser | `communication.js:639-651` |
| VAD / barge-in detection | AI runtime (latency-critical helper) | Browser | `call.js:214-253` |
| Acoustic tone analysis (F0, pauses) | AI runtime (local DSP) | Browser | `communication/voice.js:120-260` |
| **ASR provider + key** | **AI runtime** | **Node** | `bridge/asr.js`, `bridge/config.js:46-54` |
| **TTS provider + key + voice profile** | **AI runtime** | **Node** | `bridge/tts.js`, `bridge/tts-voices.js` |
| **Sentence segmentation + TTS queue** | AI runtime | **Node** | `voice-runtime.js:35-40`, `:210-233` |
| **Call session state machine** | AI runtime | **Node** | `voice-runtime.js:21-30` |
| **The character turn: prompt, history, memory** | **AI runtime — and currently in the WRONG place** | **Browser** | `call.js:440` → `communication.js:1604`, `:2208` |
| Frame → model vision injection | AI runtime | **Browser** | `communication.js:2102`, `:2113-2122` |
| Voice-clone reference store | AI runtime (server asset) | **Node FS** | `tts-voices.js:148-166` |

**Node-reachability verdict for voice/video: partially already there, and the missing part is exactly the same gap as §4.1.** Nine of the listed capabilities are *already* Node-side, including the whole call state machine, ASR transport, TTS synthesis, and the voice-asset store. What is missing is the character turn — the same `chat-core` gap G1/G2 identify. Camera frames never reach the Bridge at all, so server-side vision injection needs a new binary upload path plus a model call to attach it to.

**Consequence for the mobile plan:** voice is a *later* stage (M5) but it is not a from-scratch stage — the transport, state machine, ASR, and TTS are already server-side and already proven **on loopback**. The Android side contributes mic, camera, speaker, and the call UI; the Home Node contributes everything that must not be duplicated. Two pre-conditions must be met before M5 can lean on it: the empty-token handshake must be fixed (§3.14, a one-line export), and the character turn must move to Node (the same G1/G2 gap as §4.1) — because the Node voice runtime deliberately owns only *"audio, ASR, call state and generation lifecycle"* while *"calls, tools, history, or memory … stay in the browser chat runtime"* (`bridge/voice-runtime.js:2`).

### 4.10 Node-reachability summary

| Domain | Node can read | Node can write | Why not (if not) |
|---|---|---|---|
| Chat | ❌ | ❌ | No server store; execution is browser `fetch` + DOM |
| Characters (`apiConfigs`) | ❌ (snapshot only) | ❌ | IndexedDB; only pushed per-task |
| Middle Brain | ❌ | ❌ | 7 blockers: IIFE root on `IB`/`window`; no `module.exports`; hard `window.*` writes (`middle-brain.js:261`, `:270-312`); `document` (`config.js:228`, `:413`, `:479`); global `dbGet`/`dbPut` (`config.js:136`, `:142`); `localStorage` (`middle-brain.js:46`); `root.IBModelCore` only assigned in the browser UMD branch (`ib-model-core.js:13`) |
| Memory | ⚠️ snapshot only | ❌ | `window` deref at module scope (`memory.js:3`, `:2054`); IndexedDB-only persistence (`core.js:4`, `:8-13`) |
| Proactive | ✅ events outbox | ❌ | Node generates but the canonical write is the browser's |
| Moments content | ❌ | ❌ | Browser store; Node holds schedule + snapshot |
| Diary | ❌ | ❌ | No Node code exists at all |
| Letters | ❌ | ❌ | No Node code exists at all |
| Images | ❌ | ❌ | Browser `fetch` + `FileReader`/`canvas`/`FormData` |
| Voice (TTS/ASR) | ✅ | ✅ | Already Node-native in the Bridge |
| **Chat-core (request build + parse)** | ✅ | — | **Already dual-load**: `provider-directory.js:26`, `ib-model-core.js:12` |

The last row is the strategic asset: **the pure wire layer is already ported.** §14 builds M1 on exactly that.

---

## 5. Android Boundary

### 5.1 The line

```
┌──────────────────────── ANDROID (thin client) ────────────────────────┐
│  ALLOWED                                                              │
│   · Home Node address + device identity + pairing token               │
│   · UI state, theme, navigation, layout                               │
│   · Recent-message cache (bounded) + thumbnails                       │
│   · Offline drafts (outbound only)                                    │
│   · Downloaded attachments (cache)                                    │
│   · Notification state + sync cursor                                  │
│   · Native: mic, camera, speaker, picker, notifications, background   │
│                                                                        │
│  FORBIDDEN                                                            │
│   · Provider/API keys of any kind                                     │
│   · Middle Brain config or execution                                  │
│   · Long-term memory as an authority (read DTO only)                  │
│   · Canonical persona / character definition                          │
│   · Active-Companion scheduler                                        │
│   · Moment/diary/letter AI generation                                 │
│   · Image Router provider config                                      │
│   · Any second "world" database                                       │
└───────────────────────────────────────────────────────────────────────┘
                              │  versioned envelope over WS + HTTPS
                              ▼
┌──────────────────── HOME NODE (desktop) ──────────────────────────────┐
│  Canonical: characters, chat, memory, moments, diary, letters,        │
│  Middle Brain, providers, credentials, scheduler, image router        │
└───────────────────────────────────────────────────────────────────────┘
```

Two rules make this enforceable rather than aspirational:

1. **If a field exists on Android, it is a cache — never a source.** The gateway must be able to rebuild it entirely from Home Node state. If it cannot, the field is wrong.
2. **Android never holds a key that could be spent.** No provider key, no image key, no TTS key, no ASR key. The vault stays Node-side (`active/credential-vault.js`).

### 5.2 What this forbids that might be tempting

| Tempting shortcut | Why it is forbidden |
|---|---|
| Run the existing `InternalBeyond.html` inside a WebView | It *is* a second full runtime: it opens its own `InternalBeyondDB`, runs its own `_activeTick`, its own Middle Brain, its own image router, its own scheduler. The thin-client model collapses immediately — and it would show an *empty* world, because IndexedDB in the WebView is a different origin. |
| Send the provider key to Android so it can call providers directly | Violates the hard constraint, and loses the vault's at-rest encryption. |
| Let Android call providers and post finished replies to the Home Node | Android would then own prompt composition and context assembly — i.e. a second Character Runtime. |
| Sync via the existing JSON export/import | Explicitly forbidden by the brief, and it is a snapshot-copy model, not a single shared world. |
| Give Android the Bridge tool namespace | Pulls in payment endpoints and the URL forwarder (§3.8). |

---

## 6. Reference Mobile Comparison

**Resolved in this stage.** The reference repository was acquired in full and read; the condensed assessment is Appendix C, and the complete working note (with every line reference and the 20-item technique list) is retained at `.dsh-research/ibmob/REPORT-InternalBeyond-Mobile.md` — a scratch artifact, not part of the repo tree. Method: `Sui-IB/InternalBeyond-Mobile` @ `main`, root commit `8eb601113f156af71c34a116f925311b84e3c71d`; `index.html` downloaded whole (3 118 535 B) and analysed locally. Line references below are `index.html L<n>` in **that** file, not this checkout.

### 6.1 The repository, factually

| Fact | Value |
|---|---|
| Entry point | **one file** — `index.html`, 3 118 535 B, 24 212 lines, 13 `<style>` blocks, 24 `<script>` tags |
| Everything else | `ib-sw.js` (15 lines), `apps/ib-app-cinema.js` (73 549 B, lazy), `apps/catalog.{js,json}`, `manifest.webmanifest`, 2 icons, README, LICENSE — **12 blobs, 2 trees** |
| In-app version | `IB_VER='v244-p'`, dated 2026-09-11 (`L12663`) |
| Database | `InternalBeyondDB`, **`DB_VER=15`**, **22 object stores** (`L4150-4151`) |
| Service worker | registered, but **no `push`, no `notificationclick`, no background-sync** — fetch handler only (`ib-sw.js`, 15 lines) |
| Android project | **absent from the repo** — no `package.json`, no Gradle, no `AndroidManifest.xml`, no `capacitor.config.*` |
| Android shell | nevertheless fully described *inside* the page: a Capacitor bridge at `L19736-19833` advertising `IBNative.has:['insets','bars','back','route','exit','notify','presence']` |
| Licence | PolyForm Noncommercial 1.0.0 for code, CC BY-NC-SA 4.0 for assets — **the same licence family and the same author as this checkout's `LICENSE`** |

### 6.2 It is a sibling offline app, not a client — and that is decisive

**It never talks to the desktop.** `127.0.0.1` → **0** hits; `new WebSocket` / `ws://` / `wss://` → **0** hits; `:8765` / `:8080` → 0 hits. Every network call is either a provider endpoint the user typed in, or public data (open-meteo weather/geocoding, `L4367`, `L4307`), or the local app catalogue (`L6021`). The only "relay" it knows is a user-deployed Cloudflare Worker for music CORS. Its README states the boundary plainly: *"所有数据储存在本地浏览器，不依赖任何网络服务器；与电脑端 Internal Beyond 使用同一套备份文件互相导入导出。"*

**It is a second runtime authority — the same thing §5 forbids on Android:**

| Authority | Evidence in `index.html` |
|---|---|
| Own provider table | `PROVIDERS = {anthropic:{…}, openai:{…}, gemini:{…}}` `L4223-4228` |
| Own model-calling code that attaches the key **on the phone** | `headers['x-api-key']=cfg.apiKey` `L8852`; `headers['Authorization']='Bearer '+cfg.apiKey` `L8882`; entry points `callAI` `L8788`, `callAIC` `L8996`; connection-test path even sends `'anthropic-dangerous-direct-browser-access':'true'` `L11049-11104` |
| Own key-entry UI | `page-api` screen `L2995`; tabs `[{list:'独立配置'},{global:'全局设置'},{presence},{tools:'多模态'},{data:'数据'}]` `L5754`; per-modality key fields — `vt-ep` (STT) `L3152`, `call-key` type=password (TTS) `L3171`, `ig-ep` (image-gen) `L3196` |
| Own TTS/STT/image-gen calls | `L8150`, `L8166`, providers OpenAI / ElevenLabs / MiniMax / Azure / DashScope |
| Own memory store, ranker, **and consolidation** | `memories` + `autoMemory` in `IB_STORES` `L4151`; `getMemoryScore` `L8518`; `parseMemoryFieldsM` `L10761`; `saveMemoryFrom` → `dbPut('autoMemory',…)` `L10828`, `L10990` |
| Own proactive scheduler | a 60-second `setInterval` that decides unprompted whether the AI speaks first `L16644-16674`, with a `Presence` config tab and `pres-hb-gap` / `pres-dnd` fields — *and* it delegates to native code through `_hbSyncNative()` `L16609`, `window.IBNative.presenceSync` `L16619`, and a `presenceWake` listener `L19762` |

The README makes the parallel authority explicit rather than accidental: *"此处为手机端全局设置，对所有对话生效；电脑端 API 页也有同款全局配置（**两端各存一份**）"* (`L3198`).

**Schema overlap is partial, not equal.** Its 22 stores are this checkout's **first 21** (`posts … calLedger`, `assets/js/core.js:4`) **plus `feed`**. It has **none** of the eleven companion/persona stores — `active_message_settings`, `active_message_history`, `active_message_plans`, `diary_entries`, `moments`, `roleLetters`, `roleLetterMemories`, `activities`, `favorites`, `understandings`, `threads` — at v15 versus this checkout's v23. So a backup crosses the boundary in both directions but arrives **incomplete**: it carries the 21 base stores and silently drops everything the companion generation added. The mobile import path already anticipates this (`_mioSkipped`, `L12334`).

**The sync boundary is the backup file, and nothing else.** Export `_mioRunExport` `L12341` streams an allow-listed 20 stores (`SYNC_STORES` `L12242`) inside a version-4 envelope (`L12365`); import `_mioRunImport` `L12315` is last-writer-wins per id (*"同 id 记录以文件为准"*). The envelope carries the API keys **by default** — `noKey` mode strips `['apiKey','key','imageGenKey','sttKey','igKey']` `L12357` and the UI warns (`L3333`). This is structurally the same mechanism as `core.js:847-852` / `:1123` in this checkout, and it is subject to the same verdict: a snapshot copy, never a sync mechanism (§12.3).

### 6.3 What genuinely transfers

The runtime is not reusable; the **Android integration technique is**, and it is the most valuable thing in that repository for this project. The single best artifact: an Android-style back ladder (`backStep()` `L19791-19815`, wired from `App.addListener('backButton')`) that walks pattern overlay → lock exit-confirm → dialog → sheet → drawer → app overlays → sub-page → conversation → page → double-back-to-exit (1.9 s window). Also worth lifting, in order of expected pain saved: safe-area as four CSS variables with a native `WindowInsets` override (`L17`, `applyInsets` `L19748-19753`); derived status-bar icon colour with a mutation memo (`wantLight()` `L19767-19773`); `screenY` rather than `clientY` for hold-gesture detection, because `clientY` false-positives as an upward swipe once the virtual keyboard opens (`L8233-8234`); keyboard-aware composer re-pinning on `visualViewport` resize and focus (`L8323-8331`); sticky-bottom that survives lazy image loads (`pinBottom()` `L7908-7919`); prepend pagination that preserves scroll position and guards an in-flight page against a conversation switch (`loadEarlier()` `L7920-7947`); timestamp folding (`_tmCollapse` `L7875-7884`); client-side image downscale plus a **hard notification-bitmap size gate** `if(out.length<60000)` (`_imgDecodeScaled` `L5645-5662`, `L12611-12612`); voice-recorder hardening — capture-phase suppression of selection/context menus while recording, `setPointerCapture`, MIME capability probe, `blob.size<600` minimum, `pointercancel` → sticky recording with a 180 s cap, cancel on `visibilitychange` (`L8205-8314`); notification routing that shows an in-app banner and **returns** when the app is visible (no permission needed) and otherwise falls through native → SW → `Notification` (`_ibNotify` `L12616-12627`); the `conv:`/`page:` deep-link grammar behind one resolver (`_ibRouteGo` `L16621-16631`); and the first-gesture `AudioContext`/`speechSynthesis` unlock that stops the first reply being swallowed (`L20699-20703`).

**One caveat that is not technical.** Both repositories are Sui's PolyForm Noncommercial works, so reading and adapting between them is licence-compatible — but anything copied from that repository into an Android app carries the noncommercial restriction with it, and its README/asset licence (CC BY-NC-SA 4.0) is share-alike. That is a product decision to make deliberately, not a detail to discover at release.

**Net:** §12's matrix stands unchanged, and it is *confirmed* rather than merely conservative — the reference implementation is exactly the shape §5 forbids (a second runtime with its own keys, memory, and scheduler). Use it for **UX and Android-platform technique**; take nothing from its runtime.

---

## 7. Proposed Mobile Gateway

### 7.1 Hosting decision

**A new Node process, `services/mobile-gateway-service.js`, on port `23117` (loopback by default, LAN-bindable by explicit config).**

Rationale, in order of weight:

1. **It must not be the Bridge.** §3.7 gives four reasons; D2 in `docs/DECISIONS.md` is decisive.
2. **It must not be the Active service.** Active already has a job (background scheduling) and a state file with a `version: 3` schema; adding a world API to it means an incompatible schema change and a risk to a working feature. Also its Origin gate admits `Origin: null`, which is fine for a loopback companion and wrong for a LAN device API.
3. **A new process can be added to the existing runner declaratively** — one entry in `runtime/local-services-runner.js:63-82` — and it inherits the health-probe/identity-check pattern (`matchesHealth`) and the P7 verified-stop path for free.
4. **A new process is the only option that keeps the M1 blast radius small.** Nothing existing changes except the runner's service table, one installer file list, and the diagnostics page's component vocabulary.

Reuse from existing code, as leaf modules only (D4's factory pattern):

| Reuse | From | For |
|---|---|---|
| `parseQuery`, `uid`, `constantTimeTokenMatch` | `bridge/util.js` | plumbing |
| atomic JSON writer | `bridge/persistence.js` (`:19-51`) | device registry, cursor store |
| RFC6455 framing | `bridge/ws.js` | the WS transport (extract the framing, not `dispatch`) |
| Origin-guard shape | `services/internal-beyond-server.js:194-207` | request admission |
| headless `createX(deps)` factory style | everywhere | testability — `tests/test_local_services_runner.js` and friends already rely on it |
| `IBModelCore` | `assets/js/ib-model-core.js` | request build + response parse (already dual-load) |
| `PROVIDERS_DIR` | `assets/js/provider-directory.js` | provider/model capability truth (already dual-load) |

**Must NOT import:** `bridge/routes.js` (brings `/api/llm-proxy` and the tool table), `bridge/ws.js`'s `dispatch` (brings `tool_call`).

### 7.2 Envelope

The brief's proposed envelope is sound. Two adjustments from the real code:

```json
{
  "v": 1,
  "type": "chat.send",
  "requestId": "c3f1…",
  "deviceId": "dev_7Kq2…",
  "ts": 1783000000000,
  "payload": { }
}
```

- **`requestId` must be required on every mutating verb**, not merely present, because the existing idempotency mechanism (`active-diary.js:1301-1302`) is a *content* guard, and M1 needs a *transport* guard for retries. Echo it on every response and on every event caused by that request.
- **`ts` is required for replay rejection** (§8).
- **`deviceId` is server-derived**, not client-asserted. The server stamps it from the authenticated token; a client-supplied `deviceId` that disagrees with the token is an error (`device-mismatch`), not a silent override. This matters because the brief's example envelope puts `deviceId` at the top level, where it would otherwise look authoritative.

Events carry no `requestId`:

```json
{ "v": 1, "type": "chat.delta", "seq": 41, "conversationId": "char_abc", "payload": { "text": "…" } }
```

### 7.3 Verb namespace

Separate namespaces by trust level, so that "read-only" and "spends money/quota" never share a capability:

| Namespace | Trust | Verbs |
|---|---|---|
| `session.*` | pre-auth | `session.hello`, `session.pair`, `session.resume`, `session.bye` |
| `world.*` | read | `world.characters`, `world.character`, `world.presence` |
| `chat.*` | read + write | `chat.history`, `chat.send`, `chat.cancel`, `chat.delta`, `chat.done`, `chat.error` |
| `sync.*` | read | `sync.cursor`, `sync.delta` |
| `notify.*` | read | `notify.events`, `notify.ack` |
| `device.*` | self | `device.info`, `device.heartbeat`, `device.revoke` |

**Deliberately absent from v1:** `moment.*`, `diary.*`, `letter.*`, `memory.*`, `image.*`, `voice.*`, `video.*`, `provider.*`, `key.*`, `middlebrain.*`, `admin.*`. Every one of these is either unimplementable server-side today (§4.10) or forbidden by §5.

### 7.4 Transport

**WebSocket for everything, HTTPS for bytes.**

- WS for the envelope (requests, responses, deltas, events). Reasons: the product already has a working zero-dependency RFC6455 server to copy; bidirectional presence/heartbeat is needed anyway; and a long-lived socket avoids 30 s poll latency for proactive notification (today's `_activeTick` cadence, `active-diary.js:1340`).
- HTTPS for attachment upload/download and any payload over ~256 KB. Chat images are inline base64 data URLs today and can be megabytes; pushing those through a WS frame means holding them in the frame buffer, and `MAX_FRAME` in the Bridge is 8 MiB (`ib-bridge-service.js:39`). Define an upload verb that returns a canonical image reference, then reference it from the message.

**Heartbeat:** server ping every 30 s, dead at 60 s — reuse the exact Bridge constants (`bridge/ws.js:24`, `:32`). Client sends `device.heartbeat` every 45 s carrying presence.

### 7.5 The five invariants

These are the non-negotiables the implementation must be tested against:

1. **One writer per store.** A given canonical store has exactly one writing process. If the Home Node owns chat, the browser stops writing `chatMessages` directly.
2. **Every mutating verb is idempotent by `requestId`.** Replay of the same `requestId` returns the original result and must not produce a second message.
3. **Every generated message has one canonical id, allocated server-side**, and all surfaces render from it. This is a change from today, where the browser allocates the id (`communication.js:1989`, `:2297`) — without it, a proactive message generated while the phone is offline and re-delivered cannot be deduped across three surfaces.
4. **No credential crosses the boundary.** Enforced by a contract test that greps the gateway's outbound frames for key-shaped strings.
5. **The gateway is additive.** Its failure must never degrade the desktop app. (The product already has this discipline: the update runtime is loaded defensively at `internal-beyond-server.js:85-106` precisely so an optional subsystem cannot break startup.)

### 7.6 The decision you must make before M1

This is the fork in the road, and it is a product decision, not a technical one.

| | **Option A — Home Node becomes the true chat authority** | **Option B — Home Node owns mobile-originated chat only** |
|---|---|---|
| What happens | Node gains the canonical chat store; the **desktop browser is migrated to read/write chat through the Home Node**. | Node gets its own chat store for conversations started on mobile. Desktop keeps IndexedDB as-is. |
| Android/desktop same conversation | ✅ Yes | ❌ **No** — two stores, two histories |
| Matches the B-plan goal | ✅ Fully | ⚠️ Only superficially |
| Cost | Desktop chat/UI refactor: `sendChatMessage` and its 8 `dbPut` sites, the render path, and every feature that reads `chatMessages` (search, favorites re-read via `sourceId` at `favorites.js:17-33`, memoria generation, annotations, summaries, the seal line at `memory.js:1414`, cross-tab sync at `bridge.js:325`) | Small |
| Risk | Real — this is the single most-used surface in the product, and `assets/js/communication.js` is 4 764 lines | Low |
| M1 size | Larger | Small, as the brief scopes it |

**This audit recommends Option A**, because Option B produces an Android app that shows a *different conversation* from the desktop, which is a visible product defect rather than a hidden architectural one — and the brief's own framing is "同一个 IB 世界、同一个角色、同一套记忆和运行时".

**But Option A cannot be done inside M1** without violating the "M1 must be small" constraint. The reconciliation is a **staged Option A**:

- **M1** builds the Node chat-core + Node conversation store + gateway, and does **not** touch the desktop chat UI. The mobile conversation set is therefore empty-but-correct, and M1's acceptance test uses a dedicated test character. Android is not yet shipped.
- **M2** migrates the desktop to the Home Node store, one surface at a time, behind a read-through/dual-read seam, and only then is the mobile client pointed at a shared world.

If you choose Option B instead, M1 shrinks but M2 becomes "figure out how to merge two histories", which is strictly harder than M2 under Option A. **Do not decide this by default — decide it explicitly, and record it in `docs/DECISIONS.md` as a new D-number, because it overrides the implied scope of D2.**

---

## 8. MVP Protocol

Design rules applied throughout:

- **Direction:** `C→S` request, `S→C` response, `S→C` event.
- **Canonical backend function** names the real function that must serve it. `NEW` marks something M1 must create; everything else exists.
- **Idempotency:** how a retry is made safe.
- **Errors** use a closed vocabulary so the client can branch without string matching.

### 8.1 Error vocabulary

| Code | Meaning | Client action |
|---|---|---|
| `unauthenticated` | no/invalid device token | re-pair |
| `unauthorized` | token valid, verb not in scope | bug — do not retry |
| `device-mismatch` | asserted `deviceId` ≠ token's | bug — do not retry |
| `stale-timestamp` | `ts` outside acceptance window | resync clock, retry once |
| `duplicate-request` | (informational) replayed `requestId` | use the returned original result |
| `not-found` | unknown character/conversation/message | refresh `world.characters` |
| `busy` | a turn is already generating for this conversation | wait for `chat.done`, do not queue |
| `rate-limited` | per-device limit | back off; honour `retryAfterMs` |
| `provider-error` | upstream model failed | surface with a retry affordance |
| `provider-not-ready` | character lacks endpoint/model/credential | prompt on the desktop, not the phone |
| `cancelled` | turn aborted by user | normal |
| `gateway-degraded` | gateway up, a dependency is down | show read-only state |

### 8.2 M1 protocol table

| # | Verb | Dir | Request payload | Response / event payload | Canonical backend function | Writes DB? | Idempotency | Errors |
|---|---|---|---|---|---|---|---|---|
| 1 | `session.hello` | C→S | `{clientVersion, platform, capabilities[]}` | `{paired:bool, deviceName?, serverVersion, protocolVersion:1}` | `NEW` gateway session layer | no | read-only | — |
| 2 | `session.pair` | C→S | `{pairingCode, deviceName, platform}` | `{deviceToken, deviceId, homeNodeName, protocolVersion:1}` | `NEW` pairing module (§9) | **yes** — device registry | pairing code is single-use; re-submitting the consumed code → `unauthenticated` | `unauthenticated`, `rate-limited` |
| 3 | `session.resume` | C→S | `{deviceToken, lastCursor?}` | `{ok, deviceId, serverVersion, cursor}` | `NEW` gateway session layer | no (updates `lastSeenAt`) | read-only | `unauthenticated`, `device-mismatch` |
| 4 | `session.bye` | C→S | `{}` | `{ok}` | `NEW` | presence only | read-only | — |
| 5 | `world.characters` | C→S | `{}` | `{characters:[{id, nickname, avatarRef?, hasImageGen:bool, modelLabel, lastActivityAt}], groupCharacters:[{id:'group_*', name, members:[]}]}` | `NEW` Node reader over the canonical store; **field source today = `apiConfigs`** (`social.js:703`) and `groups` (`social.js:1772`). **Sanitized**: never `apiKey`, `imageGenApiKey`, `endpoint`, `systemPrompt`. | no | read-only | `unauthenticated` |
| 6 | `world.character` | C→S | `{characterId}` | `{id, nickname, relationship, avatarRef, speechStyleHints, pinnedMemoriesPreview?}` | `NEW` same reader | no | read-only | `not-found` |
| 7 | `world.presence` | C→S | `{}` | `{devices:[{deviceId,name,platform,lastSeenAt,online}]}` | `NEW` device registry | no | read-only | `unauthenticated` |
| 8 | `chat.history` | C→S | `{conversationId, before?{id\|timestamp}, limit≤50, afterCursor?}` | `{messages:[<canonical message DTO>], cursor, hasMore:bool}` | `NEW` `chatStore.listMessages()` (§14.2). **DTO = the §4.1 schema, byte-for-byte field names**, minus server-only fields. | no | read-only, cursor-bounded | `not-found`, `unauthenticated` |
| 9 | `chat.send` | C→S | `{conversationId, requestId, content, attachments?[{ref,mime}], threadId?, replyToMessageId?}` | ack: `{ok, userMessageId, turnId}` then `chat.delta`* then `chat.done` | `NEW` `chatCore.executeTurn()` — must call the **character model through the Node seam**, and must consult Middle Brain policy the same way the desktop does (§9.4) | **yes** — user message + assistant message | **required** `requestId`. Same `requestId` → same `userMessageId`, no second model call. | `busy`, `provider-error`, `provider-not-ready`, `rate-limited`, `duplicate-request` |
| 10 | `chat.cancel` | C→S | `{turnId}` | `{ok, cancelled:bool}` | `NEW` — `AbortController` per turn, mirroring `_chatCallStates` (`communication.js:2956-2967`) | yes (persists partial text if non-empty, per `:3796-3799`) | idempotent by `turnId` | `not-found` |
| 11 | `chat.delta` | S→C | — | `{turnId, seq, text, kind:'content'\|'reasoning'}` | emitted from the SSE delta handlers `NEW` in Node (browser twin: `communication.js:3763-3784`) | no | `seq` monotonic per turn; client drops `seq ≤ lastSeen` | — |
| 12 | `chat.done` | S→C | — | `{turnId, messageId, content, reasoning?, usage?, truncated:bool}` | `NEW` | no (message already persisted by `chat.send`) | `messageId` is the dedupe key | — |
| 13 | `chat.error` | S→C | — | `{turnId, code, message, retryable:bool}` | `NEW` | no | — | — |
| 14 | `sync.cursor` | C→S | `{}` | `{cursor, serverTime}` | `NEW` — see §10 | no | read-only | `unauthenticated` |
| 15 | `sync.delta` | C→S | `{cursor, limit≤200}` | `{changes:[{kind:'message.created'\|'message.updated'\|'message.deleted', conversationId, messageId, seq, message?}], cursor, hasMore}` | `NEW` — a **change log**, not a table scan. Populated by the same write path as #9 and by the proactive ingest. | no | cursor is monotonic; re-requesting an old cursor is safe | `stale-cursor` (client cache too old → full resync) |
| 16 | `notify.events` | C→S | `{cursor?, limit≤50}` | `{events:[{eventId, kind:'proactive_message', conversationId, characterId, messageId, preview, createdAt}], cursor}` | **`active/http.js:525-538` `GET /events`** — already exists; the gateway proxies it rather than reimplementing it | no (ACK does) | `eventId` is the dedupe key | `unauthenticated` |
| 17 | `notify.ack` | C→S | `{eventId}` | `{ok, missing:bool}` | **`active/http.js:539-568` `POST /events/:id/ack`** | **yes** — deletes the event | idempotent (`missing:true` on replay) | `not-found` (treated as success) |
| 18 | `device.heartbeat` | C→S | `{state:'foreground'\|'background', battery?}` | `{ok, serverTime}` | `NEW` device registry | presence only | read-only | — |
| 19 | `device.info` | C→S | `{}` | `{deviceId, name, platform, pairedAt, scopes[]}` | `NEW` | no | read-only | — |

### 8.3 What "no direct writes" means for `notify.ack`

`notify.ack` is the one verb in M1 that mutates a Node store directly, and that is correct: it acknowledges a *delivery*, not world content. Ingesting the event into canonical chat remains the world-owner's job. If M1 implements Option A, the gateway ingests and then ACKs; if Option B, the desktop ACKs as it does today and the gateway must not compete for the same event (see the two-consumer pattern at `active-diary.js:1296` vs `moments.js:1740` — the correct precedent is to **split the event queue by `kind`**, and `proactive_message` vs `moment*` is already such a split).

### 8.4 Minimum viable endpoint for attachments (M1.5, not M1)

`POST /mobile/v1/attachment` (HTTPS, device token) → `{ref, mime, bytes, sha256}`. Body limited to 20 MiB to match `IMG_MAX_BYTES` (`communication.js:610`). Returns a canonical image reference usable in `chat.send.attachments[]`. The Home Node builds the canonical image object and decides routing; Android never learns which provider served it.

---

## 9. Sync Model

### 9.1 Choice

**Server authority + monotonic cursor + change log. No CRDT, no vector clocks, no last-writer-wins.**

Why this is the right choice *for this product*, in its own terms:

- The world already has a **single writer per record type** — the browser. Nothing in the product ever needs conflict resolution, because two writers never touch the same record. Preserving that property is what makes CRDTs unnecessary.
- The product already has the primitive: monotonic comparison with stale rejection at `active/http.js:316` and `:423`, and forward-only `executedAt` at `:315` and `:427-434`. That is the same idea at record scope; M1 widens it to store scope.
- The product has already **considered and rejected** the heavier alternative: `docs/DECISIONS.md:92` — *"引入向量库做记忆/动态检索 | 否决"*.

### 9.2 Cursor design

A single server-assigned monotonic integer, `seq`, allocated under a write lock, assigned to every canonical mutation. The client stores `cursor = highest seq it has fully applied`.

```
seq is assigned, not derived.
 · allocated inside the same critical section that writes the record — never a separate clock
 · persisted alongside the record so a restart cannot rewind it
 · never reused, never renumbered, never gap-compacted
```

The `sync.delta` handler returns `changes` with `seq > cursor` ordered ascending, plus `hasMore`. A gap in `seq` is **not** an error — deletes and internal writes consume sequence numbers without appearing in the change log for that device's scope.

### 9.3 Client flow

```
 1. Android opens a conversation
 2. render local cache immediately (may be stale — that is fine)
 3. chat.history { conversationId, limit: 50 }        → newest page
 4. sync.delta   { cursor: storedCursor }              → everything missed
 5. merge by canonical id:  map[id] = serverRecord     ← server version always wins
 6. store cursor = response.cursor
 7. subscribe to chat.delta for the open conversation
 8. on reconnect: session.resume { lastCursor } → sync.delta → merge
```

Merge is an upsert by `messageId`; there is no field-level merge, because there is no field-level conflict.

### 9.4 The offline-proactive case, end to end

This is the case the brief correctly flags, and the existing code has already solved it — M1 must not regress it.

```
  Android offline.
  Node scheduler fires; the message is generated and written to the events outbox
      (active/scheduler.js:244-270).
  Android reconnects.
  notify.events { cursor } → returns the unacked events.
  Android renders a notification from `preview` + `messageId`.
  Android calls notify.ack { eventId }            ← delivery acknowledged
  Android (or the world owner) ingests into canonical chat, guarded by messageId.
```

Three properties make this safe, and all three are already proven in the running product:

- **The event is durable** in `active-message-service.json`, so a phone that was off for a day still receives it.
- **The ACK is per-event**, so a partial delivery does not lose the rest (`active/http.js:539-568`).
- **Ingest is guarded by `messageId` existence** (`active-diary.js:1301-1302`), so a re-delivered event cannot produce a duplicate message.

**The one thing M1 must change:** `message_id` must be allocated by the world owner (the Home Node), not by the browser, or the three surfaces cannot agree on identity. That is invariant #3 from §7.5.

### 9.5 Failure and edge cases

| Case | Handling |
|---|---|
| **Reconnect** | `session.resume` with `lastCursor`; server returns current cursor; client issues `sync.delta`. |
| **Duplicate send** | `requestId` in an LRU on the server (suggested 1 000 entries / 24 h). Replay returns the original `userMessageId` and **does not** re-call the model. |
| **Duplicated event** | `eventId` dedupe on the client; `messageId` existence guard on ingest. |
| **Request retry after the socket died mid-turn** | The turn is server-owned and continues; `session.resume` returns any in-flight `turnId`, and the client rejoins the stream via `chat.delta` from `seq > lastSeen`. If the turn finished, `sync.delta` delivers the message. |
| **Stale cache** | `chat.history` always returns the newest page first; the client may discard everything older than its cursor without asking. |
| **Message edit** | **Does not exist** in the product (verified: no edit path for any chat message, moment, comment, diary entry, or letter — create/delete only). Only two mutations exist: `withdrawn`/`withdrawnBy` (`communication.js:3370-3372`) and truncation flags. Both are ordinary `message.updated` changes in the log. |
| **Message delete** | `message.deleted` change carrying `messageId` only. The client removes the row and any favorite referencing it (favorites already degrade to text on a missing source, `favorites.js:17-33`). |
| **Proactive message while offline** | §9.4. |
| **Clock skew / replay** | `ts` on every mutating request, accepted within a ±5 min window; outside → `stale-timestamp`, with the server's time in the error so the client can correct. |
| **Server restart mid-turn** | In-flight turns are lost; no message is persisted for a turn that never completed. The client sees the socket close, resumes, finds no `chat.done`, and offers retry. (Precedent for bounded recovery of stuck states: `active/scheduler.js:607-631` recovers rows stuck >10 min.) |
| **Two devices, same conversation** | Allowed for reads; `chat.send` returns `busy` if a turn is in flight (`chat.send` error table). Do not queue — the user can see the other device's turn streaming. |

### 9.6 What is explicitly out of scope for M1 sync

Moments, diary, letters, memory, images, and group chat. Adding them without a Node-side store (§4.10) would mean inventing a sync protocol for data the server cannot see.

---

## 10. Pairing / Security Model

### 10.1 Threat model first

This is a **personal local application**, and the repository has already made that decision explicitly:

> `docs/DECISIONS.md:6-13` — D1: *"个人本地应用（Windows 单机 + 可选本机 companion 服务），不是 SaaS。**不引入** RBAC、用户隔离、token 鉴权、复杂认证等企业级设计 … 已按此定位接受的风险：companion 无鉴权 + null-origin 放行"*

and `:90-91`:

> *"RBAC/token 鉴权/用户隔离 | 否决 … companion 鉴权 + null-origin 收紧的架构级改造 | 否决"*

**So the pairing model below must be justified, not assumed.** The justification is narrow and specific: D1's risk acceptance is scoped to a **loopback** service, where "who can reach it" and "who is sitting at the machine" are the same person. Adding a phone breaks that identity, and the moment a listener answers on `192.168.x.x`, the accepted risk no longer covers the exposure. This is not "adding enterprise auth to a personal app"; it is **restoring the D1 threat model across a new transport**. That distinction should be written into the new decision record.

What we are defending against, in priority order:

1. **Another device on the same LAN** (a guest's phone, a compromised IoT device, a shared/coffee-shop network).
2. **A malicious web page** the user visits, reaching the LAN listener via the browser. Note this is *already* a partially-accepted risk for the Active service (`Origin: null` is admitted, `active/http.js:79`) — but a *native* Android client needs no Origin at all, so token auth must carry the whole load.
3. **A lost or stolen phone.**
4. **A phone that was paired and should no longer be trusted.**
5. **Passive network observation.** Out of scope for v1 (LAN only) — but see §10.5.

Not defended against: a user who pastes their own token into a chat window; a rooted phone with a keylogger; someone with physical access to the unlocked desktop.

### 10.2 Pairing flow

```
  DESKTOP (Home Node)                                ANDROID
      │                                                 │
      │ user opens Settings → Mobile Devices → Pair      │
      │ server generates:                                │
      │   code    = 8 chars, Crockford base32, 40 bits    │
      │   nonce   = 16 bytes                              │
      │   expires = now + 120 s                           │
      │   single-use                                      │
      │                                                   │
      │ renders QR:  ib://pair?host=192.168.1.42&port=23117│
      │              &nonce=<hex>&fp=<cert-or-host-fp>     │
      │              &code=<code>                          │
      │─────────────────────────── scan ─────────────────► │
      │                                                 │ 1. connect WSS/WS
      │  ◄── session.hello ─────────────────────────────── │
      │  ──► {paired:false, serverVersion}                 │
      │  ◄── session.pair {pairingCode, deviceName} ─────── │
      │                                                   │
      │ validate: code matches, not consumed, not expired │
      │ if invalid → generic `unauthenticated`,           │
      │             increment attempt counter,            │
      │             constant-time compare,                │
      │             lock the code after 5 failures        │
      │                                                   │
      │ generate:                                         │
      │   deviceId    = 'dev_' + base32(10 bytes)         │
      │   deviceToken = 32 random bytes, base64url        │
      │   store SHA-256(deviceToken) in device registry    │
      │   (NEVER store the token itself)                  │
      │ consume the code; emit a desktop-side              │
      │ confirmation event ("iPhone 15 paired")            │
      │                                                   │
      │  ──► {deviceToken, deviceId, homeNodeName} ──────► │ 2. store in
      │                                                   │    Android Keystore
      │                                                   │    (EncryptedSharedPreferences)
```

Design points worth defending:

- **The onboarding code is short-lived, single-use, and attempt-limited.** A 40-bit code is only safe because it has a 120 s window and a 5-attempt lockout; without both, it is brute-forceable in minutes.
- **The code is never the token.** It authorizes exactly one token issuance and is then dead. This is what makes a shoulder-surfed QR harmless after the fact.
- **Only a hash of the device token is stored server-side.** A stolen `devices.json` cannot be used to impersonate anyone. This is the same reasoning as the credential vault's file mode `0o600` (`active/persistence.js:85-116`) — protect at rest, and don't keep what you don't need.
- **`deviceId` and `deviceToken` are separate.** The id is public (it appends to logs and presence); the token is secret. Conflating them is a common and costly mistake.
- **The QR includes the host and port**, so there is no manual address entry — and manual entry should be *discouraged* in the UI, because entering an address by hand is exactly how a user ends up typed into a typo-squatted host.
- **A QR encoder does not exist in this repository, so the QR above is a new dependency that must be added deliberately.** A grep for `qrcode|qrCode|makeQR|generateQR|qr_encode` over `assets/`, `services/`, `bridge/`, `active/` and `runtime/` returns **0 matches**; there is no `package.json` and no `node_modules` (verified) — this project is dependency-free by construction, which is why `bridge/ws.js` hand-rolls RFC6455 instead of importing a WebSocket library. Two viable routes: **(a)** vendor one minimal byte-mode encoder as a single UMD file with its licence header, following the D10 pattern and the RFC6455 precedent — the recommendation, because it keeps pairing to a single scan and stays within the project's no-build-step discipline; **(b)** drop QR from v1 and pair with the 8-character code typed into the phone, which requires the user to know the host address — the exact failure mode the bullet above warns against. Option (a) costs roughly 10 KB and no toolchain; option (b) costs one support conversation per user.

### 10.3 Token model

| Property | Value | Rationale |
|---|---|---|
| Format | 32 random bytes, base64url | Matches existing `createAccessToken` (`bridge/config.js:98-101`) — reuse the pattern |
| Stored server-side | `SHA-256(token)` only | theft of the registry file yields nothing usable |
| Transport | header `X-IB-Device-Token` on HTTPS; **first frame** on WS | A WS handshake cannot carry a custom header from a browser, but a native client can — still, prefer the first-frame form so a Capacitor client works identically (see §11.4) |
| Scopes | `['chat.read','chat.write','notify.read','notify.ack','world.read','device.self']` | Explicit list, stored per device, checked per verb |
| Expiry | **none** for v1, explicit revoke instead | An expiring token on a phone that is used daily produces an unavoidable re-pair, which users route around by disabling security |
| Rotation | supported: pairing again issues a new token and invalidates the old one for that device | |
| Revoke | per device (`device.revoke`, or desktop-side UI) | |
| Limit | max 8 paired devices; refuse beyond with a clear message | Prevents silent accumulation |

**Do not** accept the token in a query string on the gateway, even though the Bridge does (`bridge/config.js:202-204`). That was a deliberate accommodation for iOS Shortcuts, and URLs leak into history, logs, and proxies.

### 10.4 Device registry

`%LOCALAPPDATA%\InternalBeyond\mobile-gateway\devices.json`, written with the existing atomic writer pattern (`bridge/persistence.js:19-51`: temp file + rename) and mode `0o600`.

```json
{
  "version": 1,
  "devices": {
    "dev_7Kq2…": {
      "deviceId": "dev_7Kq2…",
      "name": "Pixel 9",
      "platform": "android",
      "tokenHash": "<sha256 hex>",
      "scopes": ["world.read","chat.read","chat.write","notify.read","notify.ack","device.self"],
      "pairedAt": 1783000000000,
      "lastSeenAt": 1783000500000,
      "lastSeenIp": "192.168.1.77",
      "revokedAt": null
    }
  },
  "pairing": { "codeHash": "…", "nonce": "…", "expiresAt": 0, "attempts": 0, "consumedAt": 0 }
}
```

### 10.5 Transport, LAN, and the road to Tailscale

| Stage | Transport | Trust basis |
|---|---|---|
| **v1 (M1)** | Plain `ws://` on LAN + device token | LAN only, token per device, Origin not required for native clients. **Never bind `0.0.0.0` by default** — opt in explicitly, exactly as the Bridge does with `config.lan` (`bridge/config.js:181-187`), and surface the LAN IP + QR in the desktop UI so the user knows they opened a socket. |
| **v2** | Tailscale / WireGuard — no protocol change at all | The socket stays loopback-or-Tailscale-IP; the token model is unchanged. **This is why v1 must not depend on TLS**: an overlay network provides confidentiality below the application, and self-signed TLS in a LAN app is a support burden that users disable. |
| **v3 (optional)** | WSS with a pinned certificate | Only if remote access without an overlay network is ever wanted. |

**Explicitly forbidden in v1: opening a public port.** No port forwarding, no UPnP, no public relay, no "cloud pairing". The brief forbids it and the product's own D1 reasoning supports it.

### 10.6 Replay and abuse protection

| Mechanism | Where |
|---|---|
| `ts` window ±5 min on mutating verbs | gateway request admission |
| `requestId` dedupe (1 000-entry LRU, 24 h) | `chat.send` and every mutating verb |
| Per-device rate limit | reuse the Bridge's shape (`RATE_LIMIT={window:1000,max:60,burst:80}`, `bridge/routes.js:47-58`) → 429 + `retryAfterMs` |
| Pairing attempt lockout | 5 failures invalidate the code |
| Frame size cap | reuse `MAX_FRAME` (`ib-bridge-service.js:39`) |
| Body size cap | 20 MiB for attachments only; 256 KiB for envelopes |
| Max concurrent turns | 1 per conversation; `busy` otherwise |
| Constant-time token compare | reuse `constantTimeTokenMatch` (`bridge/util.js`) |

### 10.7 What must never appear in a gateway response

Enforced by a contract test that greps serialized outbound frames for key-shaped strings:

- any `apiKey` / `imageGenApiKey` / `Authorization` value
- `endpoint` URLs (they disclose which provider and sometimes embed a key in a query, e.g. Gemini's `?key=`, `workspace.js:86`)
- `systemPrompt` / persona text in bulk (a preview is acceptable; the full prompt is the character's identity and is the single most valuable thing to exfiltrate)
- full memory bodies for characters the device is not scoped to
- the pairing `code`, at any time, in any response

The product already has this discipline in two places worth copying: `_ibScrubSecrets` for export (`core.js:856`) and `redact()` for logs (`local-services-runner.js:152-165`).

---

## 11. Native Capability Boundary

### 11.1 The split, stated as a rule

> **If it requires a sensor, a radio, or an OS permission, it is Android's. If it requires a credential, a prompt, or history, it is the Home Node's.**

| Capability | Android (native) | Home Node (runtime) | Boundary crossing |
|---|---|---|---|
| Microphone capture | ✅ | — | raw audio (or transcript) → `chat.send` |
| Speech → text | optional (on-device) or Home Node | Home Node owns provider + key (`bridge/config.js:46-54`) | text crosses; **key never does** |
| Camera / photo picker | ✅ | — | bytes → `POST /attachment` → `ref` |
| Image understanding | — | Home Node (`vision/api.py` or a provider) | never crosses |
| Image generation / editing | — | Home Node Image Router (`image-router.js:103`) | Android sends `ref` + intent |
| Speaker playback | ✅ | — | audio bytes ← Home Node TTS |
| Video frame capture | ✅ | — | frame → `ref` → attaches to a turn |
| Notifications | ✅ display | Home Node decides | `notify.events` → notification |
| Call UI state (ring/in-call/mute) | ✅ | call *semantics* (turn-taking) | events both ways |
| File picker / download | ✅ | canonical metadata | `ref` both ways |
| Address book / contacts | ✅ (if ever) | not used | — |
| Background execution | ✅ (WorkManager) | not needed | push/poll |
| Clock | ✅ | authoritative time in every response | server time wins |
| Credentials, prompts, memory, persona, scheduler | ❌ **forbidden** | ✅ | never |

### 11.2 Notification deep-link contract

A notification must be able to open the exact message. The identifiers exist in the canonical schema already, so the payload is a projection, not a new concept:

```
intent extras:
  characterId    ← message.friendId                     (communication.js:1989)
  conversationId ← message.friendId
  threadId       ← message.threadId        (optional)
  messageId      ← message.id              (the dedupe + scroll anchor)
```

On tap: open the conversation, request `chat.history { conversationId, before: messageId }` so the message is present even if the cache is cold, then scroll to `messageId`. **The notification is never a data source** — it carries only ids and a preview string; the message is always re-read from the Home Node. This is the same discipline the current product follows: the proactive event carries `message_id` and the canonical store is read/written by id (`active-diary.js:1301-1304`).

### 11.3 Background execution

Android cannot hold a socket open indefinitely under Doze. Two mechanisms, both already supported by the product's shape:

1. **Foreground service with a persistent notification** while the user is actively chatting — keeps the socket alive for streaming.
2. **WorkManager periodic sync** (15 min minimum) for `notify.events`, plus a **push-to-wake** channel if remote access is ever added.

The 30 s `_activeTick` cadence (`active-diary.js:1340`) is *not* a viable mobile model — it is a browser timer that only runs while the tab is open, and it is the exact reason proactive delivery currently requires the desktop page to load.

### 11.4 The WebView origin trap

Flagging this now because it is cheap to avoid and expensive to discover late.

If the Android client is a Capacitor WebView (§12), its page origin is `https://localhost` or `capacitor://localhost`. Concrete consequences against the *existing* code, which a gateway design must not inherit:

- `capacitor://localhost` **fails** the Bridge's WS upgrade check, which requires `http:`/`https:` (`ib-bridge-service.js:1039`) → 403.
- `https://localhost` **passes** the Origin check but is then subject to it.
- `_ibApiPost` routes through the Bridge **only** when `location.protocol === 'file:'` (`communication.js:111-112`). A Capacitor page is `https:`/`capacitor:`, so it would take the *direct* path — where provider APIs must permit CORS from the WebView origin. Many do not. **This is a real, self-inflicted failure mode if the existing transport logic is reused unmodified.**

The gateway must therefore treat the device token as the sole auth input and **must not** gate on `Origin` for authenticated verbs — otherwise the client's own framework decides whether it can connect.

---

## 12. Reuse / Adapt / Reject Matrix

Every row is decided from **this** repository's evidence, so the matrix holds regardless of what the upstream Mobile contains.

### 12.1 Reuse concept

| Item | Evidence it is worth reusing |
|---|---|
| **Snapshot → arm → generate → outbox → ingest → ACK** as the async pattern | `active/http.js:240-258`, `:474-524`, `:525-568`; proven in production for proactive messages |
| **Per-event ACK with id-existence idempotency** | `active-diary.js:1301-1304`, `active/http.js:539-568` |
| **Monotonic stale rejection + forward-only executed flag** | `active/http.js:315-316`, `:427-434` |
| **Dual-host UMD module loaded by `<script>` and `require`** | `docs/DECISIONS.md:58-60`; live examples `provider-directory.js:26`, `ib-model-core.js:12`, `reply-chain-core.js` (required at `active/moments.js:33`) |
| **Provider capability truth in one file, no copies** | `assets/js/provider-directory.js:37-54`, `:288`, `:394` |
| **Reasoning-effort translation at exactly one boundary** | `ib-model-core.js:191-217` only; P21 contract |
| **Defensive optional-subsystem loading** (a broken gateway must not break startup) | `internal-beyond-server.js:85-106` |
| **Atomic JSON persistence with temp + backup rotation, mode 0600** | `active/persistence.js:85-116` |
| **Identity-checked health probe** (`matchesHealth`), not just "port answers" | `runtime/local-services-runner.js:70`, `:79`, `:122` |
| **Verified-process stop** (command-line match before kill) | `runtime/local-services-runner.js:201-253` |
| **Constant-time secret comparison** | `bridge/util.js` `constantTimeTokenMatch` |
| **Crash recovery for stuck states with a bounded age** | `active/scheduler.js:607-631` |
| **Capability probe before assuming a newer peer** | `moments.js:1593-1598` |
| **Redaction before anything reaches a log** | `local-services-runner.js:152-165` |
| **Lock-screen / chat-drawer / attachment-picker / safe-area / mobile-nav UX** | Browser side already has mobile CSS (`@media(max-width:768px)`, tested at 390×844 in `tests/test_ui_regression.js:834-840`) and the viewport meta is already correct (`InternalBeyond.html:5`) — worth studying as the *product's* mobile design language |
| **Upstream Mobile's Android-integration technique and mobile UX** | Assessed in full in this stage; see §6.3. The back ladder, safe-area variables, virtual-keyboard gesture and scroll handling, recorder hardening, and notification routing are concrete, portable, and already battle-tested on real devices — this is the highest-value material in that repository for a new Android client |
| **Upstream Mobile's mobile UX patterns** | Reference material; see `docs/CHRONICLE.md:60-63` — the fork explicitly did not derive from it, so treat as inspiration, verify nothing |

### 12.2 Adapt

| Item | Reuse | Must change because |
|---|---|---|
| **`NodeModelPort.run`** | Its shape is already right: `run(request, {signal, onEvent})` with `onEvent({type:'done'\|'error'})` (`node-model-port.js:60`, `:141`, `:149`, `:155`) and `IBModelCore` reuse (`:19`, `:71`, `:135`) | It is **non-streaming by design** (`:6`, `:122` `res.text()`). Streaming needs `res.body` iteration. Also, its transport builder (`:29-48`) is a **second copy** of provider header logic that duplicates `provider-directory.js` truth — the gateway should route that through the directory instead. |
| **`callCharacterModel` prompt building** | `active/model-client.js:126-199` already composes a character prompt from a snapshot | It is the *proactive* prompt, not the chat prompt. Chat needs `_buildSingleChatContext`'s block ordering (`communication.js:1398-1509`) or it will produce character-inconsistent replies. |
| **`recent_memories` snapshot (≤8)** | Works today; zero new plumbing | For chat, 8 pre-ranked rows and a 2000-char budget (`memory.js:64`) is the desktop's *tail* context, not its full context; a phone conversation needs the same 4 producers (memory/understanding/thread/moments) to feel like the same character |
| **Bridge WS framing** | The RFC6455 implementation is complete, correct, and dependency-free (`bridge/ws.js:53-247`) | Its `dispatch` carries the tool/payment namespace (`:158-202`); the gateway needs the framing without the semantics. Extract, do not reuse the class as-is. |
| **Bridge token auth** | Constant-time compare, dual validation (upgrade + first frame) | Needs per-device tokens, scopes, and revocation instead of one global secret; and Origin-independent for native clients |
| **`/events` + `/events/:id/ack`** | Both already exist and are already correct | Must not be consumed by two competing clients: split by `kind`, following the precedent at `active-diary.js:1296` vs `moments.js:1740` |
| **Mobile responsive CSS** | Mobile breakpoints and the phone-size regression test already exist | It styles a **desktop app shrunk down**, with 174 inline `onclick` handlers bound to globals and no touch-gesture layer. It is a design reference, not a UI to embed. |
| **JSON export/import** | Useful as a **user-controlled backup** | It is not a sync mechanism (brief constraint), and note it is already incomplete: `roleLetterMemories` is missing from both `_ibBuildExportData` (`core.js:851`) and `importAll` (`core.js:1123`) |

### 12.3 Reject

| Item | Why rejected | Evidence |
|---|---|---|
| **Running the desktop UI in a WebView** | It *is* a full second runtime: own IndexedDB, own `_activeTick`, own Middle Brain, own scheduler, own image router — and it would render an empty world because the WebView's IndexedDB is a different origin | `core.js:3-4`, `active-diary.js:1340`, `InternalBeyond.html:2996-3001` |
| **Any provider/API key on Android** | Hard constraint; also strictly worse than the existing Node vault | `active/credential-vault.js` |
| **Middle Brain on Android** | Cannot load outside a browser (7 blockers, §4.10), and duplicating it would fork character behaviour | `middle-brain.js:261`, `:270-312` |
| **A second memory authority on Android** | Memory writes are AI-driven with an approval queue (`auto-memory.js:244-321`); a direct write path bypasses admission control | `memory.js:118-123` (retrieval also writes) |
| **Backup-file import/export as sync** | Brief constraint; also structurally a snapshot copy, not one shared world | `core.js:847-852` |
| **CRDT / vector clocks / LWW merge** | Every store has a single writer; no conflict exists to resolve | §9.1 |
| **Exposing the Bridge tool namespace** | Imports payment verbs and the arbitrary-URL forwarder | `bridge/routes.js:199-221`; `ib-bridge-service.js:790-883` |
| **Repurposing the Bridge as the mobile gateway** | Wrong semantic scope, no versioning, and contradicts a frozen decision | `docs/DECISIONS.md:15-17` |
| **Android-side Active scheduler** | Duplicate proactive generation is already a known race the product fights with four mechanisms (`docs/DECISIONS.md:78`) | `active/http.js:474-524`, `scheduler.js:236-271` |
| **Android-side full canonical DB** | It is the definition of a second source of truth | §5 |
| **Public port / port forwarding / UPnP** | Brief constraint; D1 risk acceptance covers loopback only | `docs/DECISIONS.md:6-13` |
| **An Origin-based auth gate for native clients** | The client framework, not the user, would then decide whether it can connect | §11.4; `ib-bridge-service.js:1039` |
| **Query-string device tokens** | Leaks via history/logs/proxies | contrast `bridge/config.js:202-204` |
| **Adopting the reference Mobile repository as a base (fork / merge / vendor its `index.html`)** | It is a **second runtime authority** with its own provider keys, model calls, memory consolidation, and proactive scheduler — i.e. exactly what §5 forbids on the client — and its schema is `DB_VER 15` / 22 stores against this checkout's `23` / 32, missing all eleven companion stores | Appendix C.2; `index.html` `L4223-4228`, `L8852`, `L8882`, `L8518`, `L16644-16674`, `L4150-4151`; `assets/js/core.js:3-4` |
| **Treating a Mobile backup file as a sync channel** | Same verdict as this checkout's own export/import, plus it silently drops everything the companion generation added (`_mioSkipped`) | `index.html` `L12242`, `L12315`, `L12341`, `L12334` |

---

## 13. Risk Register

Scored **L**ikelihood / **I**mpact (H/M/L) and ordered by severity × imminence.

| # | Risk | L | I | Evidence / mechanism | Mitigation |
|---|---|---|---|---|---|
| R1 | **Android shows a different conversation from the desktop** — the single most likely way this project ships something that looks broken | **H** | **H** | Two stores if Option B is taken (§7.6); `chatMessages` has no server representation today | Decide §7.6 explicitly **before** M1; stage Option A as recommended |
| R2 | **Chat execution is ported twice and the copies drift** — the exact failure mode D10 exists to prevent | M | **H** | The browser path is 4 764 lines (`communication.js`), and `node-model-port.js:29-48` already duplicates provider header logic | Extract a UMD `chat-core.js` per D10; add a structural test asserting one implementation (precedent: `tests/test_reasoning_capability.js` guards capability-truth uniqueness) |
| R3 | **Desktop chat regresses during the M2 migration** | M | **H** | `chatMessages` is read by search, favorites (`favorites.js:17-33`), summary, memoria, annotations, the seal line (`memory.js:1414`), and cross-tab sync (`bridge.js:325`) | Migrate behind a read-through seam, one consumer at a time; keep the existing browser paths intact until each is verified |
| R4 | **LAN exposure widens attack surface beyond what D1 accepted** | M | **H** | D1 explicitly accepted an unauthenticated loopback companion; a LAN listener invalidates that scoping | Per-device tokens, LAN opt-in only, no public bind, QR-based pairing; record a new decision superseding D1's scope |
| R5 | **The arbitrary-URL proxy is reused in the mobile path** | M | **H** | `/api/llm-proxy` accepts caller-supplied URL + headers (`bridge/routes.js:199-212`) | Gateway must not import `bridge/routes.js`; add a contract test asserting the gateway never forwards a caller-supplied URL |
| R6 | **Provider credentials leak into a mobile response or log** | M | **H** | `endpoint` can embed a key (Gemini `?key=`, `workspace.js:86`); the browser stores keys in plaintext (`social.js:712`) | Allowlist serialization at the gateway boundary; contract test grepping outbound frames; keep keys Node-side only |
| R7 | **Proactive messages are delivered twice or lost across three surfaces** | M | M | Today's idempotency is browser-side (`active-diary.js:1301-1302`); adding a third writer breaks the assumption | Server-allocated `messageId` (invariant #3); split the event queue by `kind`; per-event ACK |
| R8 | **Reconnect/resume loses or duplicates a turn** | M | M | No WS resume exists in the product today (no seq, no turn registry) | Server-owned turns + `turnId` + monotonic `chat.delta.seq` + `sync.delta` on resume (§9.5) |
| R9 | **Node cannot serve memory, moments, diary, or letters** — so mobile is feature-poor and the user rejects it | **H** | M | §4.10; every one is a browser IIFE | M1 ships chat only and says so; M2/M3 port memory and content reads using the D10 pattern; do **not** fake these with snapshots |
| R10 | **The mobile client cannot reach providers because of CORS / origin rules** | M | M | `_ibApiPost` only proxies from `file://` (`communication.js:111-112`); a WebView origin takes the direct path (§11.4) | Android must never call a provider — this risk disappears entirely under the thin-client model; treat any design that reintroduces it as a regression |
| R11 | **Capacitor WebView origin rejected by the existing gateway/Bridge** | M | M | `capacitor://localhost` fails `ib-bridge-service.js:1039` | Don't gate authenticated verbs on Origin (§11.4) |
| R12 | **Pairing is brute-forced on a shared LAN** | L | **H** | A short code is the classic weak link | 40-bit code, 120 s TTL, single-use, 5-attempt lockout, constant-time compare (§10.2) |
| R13 | **A lost phone remains trusted indefinitely** | M | M | No device concept exists at all today | Explicit revoke + desktop-side device list + max 8 devices; show `lastSeenAt` |
| R14 | **Plaintext WS on LAN is observed** | L | M | v1 is LAN-only by design | Accept for v1 and document it; Tailscale in v2 requires no protocol change |
| R15 | **The gateway takes the desktop app down** | L | **H** | A new always-on listener next to a working product | Optional-subsystem loading (precedent `internal-beyond-server.js:85-106`); identity-checked health probe; P2's "optional service failure must not block the main UI" rule |
| R16 | **New service breaks the installer or the test budget** | M | M | 100 registered tests (`tests/test-all.js`); the installer has a fixed file list; P7 discipline forbids install-loop testing | Add the service to `runtime/local-services-runner.js`'s table, the installer file list, and the diagnostics component vocabulary; **contract tests only** — no install loops (P7) |
| R17 | **Node-side memory port changes character behaviour subtly** | M | M | The ranker has a write side effect (`memory.js:118-123`); the decay constants are load-bearing (`:9-22`) | Port the ranker verbatim as a UMD module and add a fixture test comparing Node output against the browser's for the same inputs |
| R18 | **Group chat is assumed to be a chat on the server, but its turn-taking is a browser loop** | M | M | `for(const cfg of speakingCfgs)` at `communication.js:1716` | Defer group chat out of M1/M2; when it lands, the loop must move to Node as one unit, not be re-derived |
| R19 | **LAN mode is not a working configuration for the desktop's own voice and TTS today** — so the gateway would be built on top of a mode nobody has exercised | **H** | M | Verified in §3.14: `call.js:17` always evaluates to `''`, so the voice WS upgrade gets 401 under `LAN_EXPOSED` (`ib-bridge-service.js:1055`); `social.js:454`/`:456` bypass the token entirely | Fix the three call sites + add the adjacency contract test **before M1**; make "LAN on, exercise every Bridge-backed desktop feature" the acceptance pass for §10.5 v1 |
| R20 | **The reference Mobile repository is adopted as a base rather than as reference material** | M | **H** | It is a second runtime authority — own provider keys, own model calls, own memory consolidation, own scheduler — and its schema is 22 stores at v15 against this checkout's 32 at v23 (Appendix C.2) | Keep it read-only; vendor nothing; the borrowable set is Android-integration technique and UX only (Appendix C.3). Note its licence is the same noncommercial family, so this is a product decision, not a legal accident |
| R21 | **A Node-side character mirror hooks `_persistApiConfig` and silently misses three direct writers** | M | M | §4.2: `social.js:760` (legacy migration), `memory.js:1440` / `:1451` (seal line — written on ordinary chat activity), `memory/auto-memory.js:576` | Mirror the **store**, not the helper; add a test that fails when a new direct `dbPut('apiConfigs'` site appears |

### 13.1 The three risks that must be closed before any Android code is written

**R1** (decide §7.6), **R2** (one implementation, enforced by a test), **R4** (pairing model + a recorded decision). Everything else is manageable during implementation; these three change the shape of the work.

**R19 is a sequencing precondition rather than a shape-changing risk**, and it is cheap to close first: the mobile gateway's whole v1 transport is LAN exposure, and §3.14 shows that turning LAN on breaks the desktop's own voice calls and TTS test button today. Building the gateway before that is fixed means debugging two unknowns at once.

---

## 14. M1 Implementation Plan

### 14.1 Stage name and scope

**M1 · Home Node Gateway Skeleton**

The brief's eight items are the right scope. This plan adds the two things they stand on, because `chat.history` cannot read a store that does not exist and `chat.send` cannot call a seam that does not exist — while keeping everything else out.

```
M1 DOES
  1. Node chat-core module (UMD, D10 pattern)                    ← prerequisite for 5,6
  2. Node conversation store + change log                        ← prerequisite for 4,5,7
  3. Mobile Gateway service namespace + envelope + versioning
  4. pairing / device identity / device-scoped tokens
  5. character.list / character.get
  6. chat.history (cursor-bounded)
  7. chat.send → chat.delta / chat.done / chat.error
  8. reconnect / resume (session.resume + sync.cursor + sync.delta)
  9. notify.events / notify.ack (proxying the existing 23114 endpoints)
 10. contract tests

M1 DOES NOT
  · Moments, Diary, Letters          · Voice, Video
  · Image generation                 · Memory write API
  · Any Android UI or APK            · Remote / public Internet access
  · Any change to the desktop chat UI (that is M2)
  · Any change to bridge/routes.js or the Bridge tool table
  · Any modification of existing DeepSeek/provider behaviour
```

### 14.2 Work breakdown

#### W1 · Node chat-core (UMD single file)

- **Deliverable:** `assets/js/chat-core.js` — UMD, loaded by a browser `<script>` tag *and* `require`d by Node, following D10 and the existing examples (`provider-directory.js:26`, `ib-model-core.js:12`).
- **Contents (pure, no I/O, no DOM):** message DTO construction and validation; `requestId → userMessageId` derivation; provider body assembly **delegating to `IBModelCore.buildRequestBody`**; SSE line parsing and delta extraction per format; error classification.
- **Explicitly not in it:** storage, transport, DOM, prompt composition.
- **Verification:** a fixture test that feeds identical inputs through the browser-loaded and Node-required instances and asserts byte-identical request bodies. This is the R2 mitigation and must exist before any Node execution code is written.

#### W2 · Node conversation store

- **Deliverable:** `services/mobile-gateway/chat-store.js` — a `createChatStore({dataDir, clock})` factory per D4.
- **Storage decision: settled — SQLite via `node:sqlite`.** **Verified in this stage by execution, not inference:** `runtime/node/node.exe` is `v24.18.0` and `require('node:sqlite')` succeeds, exposing `DatabaseSync, StatementSync, Session, constants, backup`. This gives W2 a real store with **zero dependencies**, which matters because the repository has no `package.json` and no `node_modules`. The JSON fallback (single atomic file with the existing temp+rename+backup pattern, `active/persistence.js:85-116`) is retained only as a portability escape hatch if a future runtime drops the module.
- **Record shape:** exactly the §4.1 schema, field names unchanged, plus server-owned `seq`. Do not invent a parallel schema.
- **Also owns:** the change log (§9.2) and cursor allocation under a single writer lock.
- **Verification:** unit tests for seq monotonicity under concurrent writes, restart persistence, and cursor no-rewind.

#### W3 · Mobile Gateway service

- **Deliverable:** `services/mobile-gateway-service.js` — composition root (D4: state in the root, logic in `createX(deps)` factories under `services/mobile-gateway/`).
- **Transport:** WS (envelope) + HTTPS (attachments later). Reuse the framing from `bridge/ws.js`; do **not** reuse its `dispatch`.
- **Port:** `23117` (`IB_MOBILE_PORT` override), **loopback by default**, LAN bind only via explicit config.
- **Registration:** one entry in `runtime/local-services-runner.js:63-82` with a `matchesHealth` identity check; launcher/installer file lists updated; diagnostics component vocabulary extended.
- **Failure isolation:** if the gateway cannot start, the desktop must be unaffected (precedent `internal-beyond-server.js:85-106`; P2's degraded-vs-fatal rule).
- **Verification:** a service test that spawns it on a random port with a temp data dir (the existing pattern — `tests/test_active_http.js:92`, `tests/test_moments_http.js:95`), plus a test asserting the desktop's own boot path is unchanged when the gateway is absent.

#### W4 · Pairing and device identity

- **Deliverable:** `services/mobile-gateway/devices.js` + a desktop-side pairing UI surface in the **existing** Settings → API/related page (do not create a second settings page — the P6 contract forbids a second help/settings page).
- **Registry:** §10.4, atomic write, mode `0600`, token hashes only.
- **QR generation:** the desktop already renders canvases; a QR encoder is a small, dependency-free addition — but **verify no existing QR/canvas helper can be reused before adding one**, and note that the release is zero-dependency by policy, so any new code must be hand-written or vendored with a license file (the repo has a `LICENSES/` directory, so vendoring is an accepted pattern).
- **Verification:** contract tests for single-use, expiry, attempt lockout, hash-only storage, revoke, and scope enforcement. Plus an explicit negative test: a request with a valid token but an out-of-scope verb returns `unauthorized`, never a partial success.

#### W5 · Read verbs

- `world.characters`, `world.character`, `world.presence`.
- **Sanitization is the whole risk here.** A test must assert that no response contains `apiKey`, `imageGenApiKey`, `endpoint`, `Authorization`, or a full `systemPrompt`.
- Source: the Node store's character projection. In M1 (Option A staged) this projection is seeded from the mobile conversation set; it does **not** read the browser's `apiConfigs`, because it cannot.

#### W6 · Chat verbs

- `chat.history` (cursor/`before` bounded, `limit ≤ 50`).
- `chat.send` → ack → `chat.delta`* → `chat.done` | `chat.error`; `chat.cancel`.
- **Execution path:** `chat.send` → W1 chat-core (body) → streaming port (new, or an extended `NodeModelPort.run`) → deltas out over WS → persist on completion.
- **Middleware policy:** M1 must apply the *same* reasoning-effort policy the desktop applies (`IB.middleBrain.middleBrainReasoningEffort` semantics, translated only in `IBModelCore.applyReasoningEffort`). Full Middle Brain context organization is **M2**, and M1 must state that clearly rather than silently producing lower-quality replies. Add a `gateway.contextPolicy` field to the response so the client can display "limited context" honestly.
- **Concurrency:** one in-flight turn per conversation; `busy` otherwise.
- **Verification:** contract tests for `requestId` replay (same `userMessageId`, **model called exactly once** — assert on a mock provider call count), cancel mid-stream, provider error classification, and `busy`.

#### W7 · Resume and sync

- `session.resume`, `sync.cursor`, `sync.delta`.
- **Verification:** a test that kills the socket mid-turn and asserts the client converges to the correct state after resume with no duplicate and no loss; plus a `stale-cursor` test.

#### W8 · Notifications

- `notify.events` / `notify.ack` proxying `active/http.js:525-538` and `:539-568`.
- **Do not** build a second event queue. Use the gateway as a device-facing façade over the existing one.
- **Verification:** a test that an event is delivered once, ACKed once, and that a second ACK is a no-op (`missing:true`).

#### W9 · Contract tests

- One test file per verb group, asserting the request/response/error shapes in §8.2. **Schema-shape assertions, not string matching.**
- Two cross-cutting tests:
  - **No-secret boundary:** serialized outbound frames contain no key-shaped values.
  - **Single implementation:** `chat-core.js` browser and Node instances produce identical bodies (the R2 guard).
- Register all of them in `tests/test-all.js` under the `service` group.

### 14.3 The decision gate

**M1 must not begin until §7.6 is decided and recorded.** Concretely:

1. Choose Option A or Option B and write it into `docs/DECISIONS.md` as a new D-number, explicitly noting that it extends D2 and re-scopes D1's risk acceptance.
2. If Option A: accept that M2 is a desktop chat/UI refactor of the product's most-used surface, and schedule it as its own staged effort with its own audit.
3. If Option B: accept that the Android app will show a different conversation history from the desktop, and get that in writing as a known product limitation rather than discovering it in testing.

### 14.4 Test budget

Following the recorded discipline (`MEMORY.md`: minimal targeted tests during development; one full regression at stage end; no install loops):

| When | What |
|---|---|
| During W1–W8 | Only that workstream's targeted test |
| Before commit | The relevant `service`-group tests |
| **End of M1, once** | Full `static` + `service` regression (`node tests/test-all.js --quick`) |
| **End of M1, once** | One minimal smoke: gateway starts, a device pairs, one turn round-trips |
| Never in M1 | Installer loops, browser suite, real Windows start chain (those belong to a delivery stage and to P7/P8) |

### 14.5 Definition of done

M1 is done when all of the following are demonstrably true:

1. A device can pair via QR and reconnect after an app restart without re-pairing.
2. `world.characters` returns the character list with **no** credential, endpoint, or full prompt in the payload (asserted by test).
3. `chat.history` returns a bounded, cursor-correct page.
4. `chat.send` streams `chat.delta` and terminates with exactly one `chat.done` carrying one server-allocated `messageId`.
5. Replaying the same `requestId` produces the same `userMessageId` and **exactly one** provider call.
6. Killing the socket mid-turn and reconnecting converges with no duplicate and no lost message.
7. A proactive message generated while no client is connected is delivered on next connect and ACKed exactly once.
8. A revoked device is refused with `unauthenticated` on the next request.
9. The desktop app's behaviour is **unchanged** when the gateway is disabled and absent.
10. `node tests/test-all.js --quick` is green.

### 14.6 What comes after (stated, not planned)

| Stage | Content | Precondition |
|---|---|---|
| **M2** | Desktop migration to Home Node chat (Option A) or history-merge design (Option B); Middle Brain context parity on the Node path; `chat-core` covers group chat | M1 done, §7.6 recorded |
| **M3** | Memory read DTO + Moments/Diary/Letters read APIs — all requiring Node-side ports of the browser modules via the D10 pattern | W1's UMD extraction pattern proven twice |
| **M4** | Attachments, image via Image Router, notifications polish | M3 |
| **M5** | Voice/video native capability split; ASR/TTS through the gateway | M4 |
| **M6** | Android UI on the chosen tech route (§12 conclusions) | M1 protocol frozen and stable for at least one release |

---

## 15. Final Answer

> **按当前仓库事实，Android 是否已经可以作为 Thin Client 接入？如果不能，最小缺口到底是什么？**

**不能。**

今天没有任何可以「变薄」的服务端：InternalBeyond 的整个世界（chat、memory、moments、diary、letters、角色、provider 凭据、Middle Brain）都只存在于浏览器的一个 IndexedDB 数据库里（`assets/js/core.js:3-4`，`InternalBeyondDB` v23，32 个 store）；`services/`、`bridge/`、`active/`、`runtime/` 中没有任何一行代码读写过 `chatMessages`。现有 Node 服务只是**借用**浏览器推给它们的数据分片——它们派发任务、排队事件，然后等浏览器回来认领结果。唯一真正安卓可用、且今天就能工作的接口，是主动消息事件队列（`GET /events?user_id=`，`active/http.js:525-538`）。

**最小缺口不是接线，而是三件实体上不存在的东西：**

1. **一个 Node 侧的 canonical chat 存储**——目前它没有服务端表示（G1）。
2. **一个 Node 侧的 chat 执行入口**——现在聊天 100% 在浏览器里跑；`middleBrainExecute` 只是上下文组织缝，它从不调用模型，所以「走现有执行缝」这条捷径并不存在。好消息是纯协议层（`ib-model-core.js`、`provider-directory.js`）**已经是双端可加载的 UMD**，而 D10 已经允许「一份实现、两个宿主」。
3. **一套设备身份与配对**——Node 侧 `deviceId`/`pairing` 零匹配，现有唯一鉴权是一个全局共享的 Bridge token（`bridge/config.js`）。而 Bridge 本身**不能**直接当网关用：它带着支付工具和一个可转发任意 URL 的代理（`bridge/routes.js:199-221`），并且 D2 明确写着「Bridge 不做主聊天代理」。

**在这三者之上，M1 的八个协议项才是可实现的。** 因此建议的执行顺序是：先做 W1（chat-core，UMD 单文件）与 W2（Node conversation store），再让 Mobile Gateway 站在它们前面——而不是先建网关、再补地基。

**并且在写第一行 M1 代码之前，必须先做一个产品决定（§7.6）**：桌面端是否迁移到经 Home Node 读写聊天（真·单一权威），还是 Home Node 只拥有手机发起的新会话（两个 store、两段历史）。前者符合 B 方案的初衷，代价是 M2 要动产品里最核心的 4 764 行聊天代码；后者 M1 更小，但会让安卓端显示一段与桌面**不同**的对话历史。本审计推荐前者，并把 M1/M2 拆开以保证 M1 足够小——但这个取舍应该被明确写下，而不是默认发生。

---

### Appendix A · Verified facts used above

| Fact | Evidence |
|---|---|
| Working tree clean at audit start | `git status --porcelain` → 0 lines |
| HEAD | `6db3a0e6c009b1208e500176cdd6111966aac922` on `master` |
| Product version | `VERSION` → `1.0.4` |
| Canonical DB | `assets/js/core.js:3`, store loop `:4` |
| Chat is browser-only | `communication.js:1604`, `:1995`, `:2304`; no Node reader/writer |
| Streaming is fetch+SSE, deltas not persisted | `communication.js:3731-3741`, `:3763-3784` |
| Proactive is a durable poll queue | `active/scheduler.js:244-271`, `active/http.js:525-568`, `active-diary.js:1301-1334` |
| Middle Brain is context-only, browser-only | `middle-brain.js:159-172`; six `<script>` tags `InternalBeyond.html:2996-3001` |
| No embeddings anywhere | repo-wide grep: one false positive at `communication/letters.js:10` |
| Active has no auth | `active/http.js:78-80`; no token check anywhere in `active/` |
| Bridge has one global token, auto-generated on LAN | `bridge/config.js:24`, `:181-187`, `:207-216` |
| Bridge can forward arbitrary URLs | `bridge/routes.js:199-221`, route `:319` |
| No device concept | `deviceId`/`pairing` → 0 matches in `services/`, `bridge/`, `active/`, `runtime/` |
| Ports and binds | 23120 `internal-beyond-server.js:347-348`; 23115 `bridge/config.js:188`; 23114 `active-message-service.js:25-26`; 23116 `local-services-runner.js:51-52`; 8765 `start-vision-service.cmd:49` |
| Vision not shipped | grep "vision" over `installer/*.iss` and `build-installer.ps1` → 0 matches |
| Dual-host UMD is frozen policy | `docs/DECISIONS.md:58-60`; examples `provider-directory.js:26`, `ib-model-core.js:12` |
| Node model port shape | `active/node-model-port.js:60`, `:141`, `:149`, `:155`; non-streaming `:122` |
| Export omits `roleLetterMemories` | `core.js:851`, `:1123` |
| Test harness | `tests/test-all.js`, 100 registered entries, zero dependencies |
| `user_id` is a locally minted ownership tag, not a principal | `active-diary.js:46-48`; `ib_active_user_id` occurs **once** in `assets/**`; server verifies only belongs-to (`active/http.js:243`, `:247-252`, `:299-308`, `:382-419`, `:492-503`) |
| Active has no session/token/cookie at all | `token\|Authoriz` over `services/active-message-service.js` → **0 matches**; Origin guard `:285-286`; loopback bind `:25` |
| `user_id` survives the product's own resets but not a browser data clear | `ibExtReset` key list `integrations.js:1468-1470` omits it; `localStorage.clear()` → 0 hits in `assets/**`; only `moments` has a `reown` path (`moments.js:1607`, `:1629`; `active/http.js:409-419`) |
| The WS client is `IBNET` in `integrations.js`, **not** `bridge.js` | `new WebSocket` → only `integrations.js:1223` and `communication/call.js:129` |
| Voice WS authentication is permanently empty, so LAN mode 401s | `bridge.js:21` is IIFE-private (`:6` … `:1153`); no `window.ibBridgeToken` assignment anywhere; `call.js:17`; rejected at `ib-bridge-service.js:1055` |
| The voice-preview button bypasses the Bridge token | `social.js:454` (bare `fetch`), `:456` (`new Audio`) vs the global gate `bridge/routes.js:316` |
| `apiConfigs` has five production writers; three bypass the chokepoint | `social.js:712` (chokepoint), `:760`; `memory.js:1440`, `:1451`; `memory/auto-memory.js:576` |
| Reference Mobile is a single 3.1 MB file with no Android project, yet a full Capacitor contract | its `index.html` 3 118 535 B / 24 212 lines; `DB_VER 15`, 22 stores `L4150-4151`; `IBNative.has:[…]` `L19821`; tree = 12 blobs |
| Reference Mobile never contacts the desktop | `127.0.0.1`, `new WebSocket`, `ws://`, `wss://` → **0 hits** in that `index.html`; only sync is the backup JSON (`L12242`, `L12341`) |
| `node:sqlite` is available in the shipped runtime | executed: `runtime/node/node.exe` → `v24.18.0`; `require('node:sqlite')` → `DatabaseSync, StatementSync, Session, constants, backup` |
| The repository is dependency-free | no `package.json`, no `node_modules` (both absent); RFC6455 hand-rolled in `bridge/ws.js` |
| No QR encoder exists in the repository | `qrcode\|qrCode\|makeQR\|generateQR\|qr_encode` over `assets/`, `services/`, `bridge/`, `active/`, `runtime/` → **0 matches** |

### Appendix B · Open items (not resolved by this stage)

1. ~~`UNDETERMINED` — full voice/video detail~~ **RESOLVED in this stage** — §4.9 carries the full nine-stage pipeline, call state machine, barge-in layers, voice-asset store, and the native/AI-runtime classification, plus two corrections to the brief (`<ws_vsnap/>` does not exist; there is no video call and no WebRTC). Newly added during integration: §3.14, the LAN-mode voice/TTS authentication defect this deep read exposed.
2. ~~`UNDETERMINED` — the upstream `Sui-IB/InternalBeyond-Mobile` file inventory and UX specifics~~ **RESOLVED in this stage** — §6 and Appendix C. The inventory is complete (12 blobs, one 3.1 MB `index.html`), and the conclusion is that the runtime is a second authority and must not be reused; only Android-integration technique and UX transfer.
3. ~~`UNDETERMINED` — whether `node:sqlite` is available in the pinned bundled runtime~~ **RESOLVED in this stage, and the answer is yes.** Executed against the shipped binary: `runtime/node/node.exe` reports `v24.18.0` and `require('node:sqlite')` succeeds, exposing `DatabaseSync, StatementSync, Session, constants, backup`. So W2 can have a real store with **zero dependencies** — which matters here more than usual, because the repository has no `package.json` and no `node_modules` at all.
4. ~~`UNDETERMINED` — whether an existing QR-generation helper exists in the repo~~ **RESOLVED in this stage, and the answer is no.** `qrcode|qrCode|makeQR|generateQR|qr_encode` over `assets/`, `services/`, `bridge/`, `active/`, `runtime/` → **0 matches**; the reference Mobile repository has none either, and has no pairing flow at all. §10.2 now states the two options and recommends vendoring a single-file encoder.
5. Open — whether `getMemoryContext`'s activation side effect (`memory.js:118-123`) should be preserved in a Node port (affects R17).
6. Open — the three LAN-mode call sites in §3.14 are verified defects but are **out of this stage's scope** (M0 is read-only). They need an owner before M1, per R19.

---

### Appendix C · Reference-repository evidence, anchored

**C.1 · Verification index.** The full working note — every quote, every line reference, and the complete 20-item technique list — is `.dsh-research/ibmob/REPORT-InternalBeyond-Mobile.md` (scratch artifact; not part of the repo tree). This appendix is the verification index for §6, so that no reader has to re-download 3 MB to check a claim. All anchors are `index.html` of `Sui-IB/InternalBeyond-Mobile` @ `main` (`8eb601113f156af71c34a116f925311b84e3c71d`).

| Claim in §6 | Anchor in that file |
|---|---|
| Single-file app; 13 style blocks, 24 script tags | structure counts `L12`–`L24199` |
| Version string | `IB_VER='v244-p'`, `IB_VER_DATE='2026-09-11'` — `L12663` |
| Own database, v15, 22 stores | `L4150-4151` (`DB_NAME`/`DB_VER`/`IB_STORES`) |
| Own provider table | `L4223-4228` |
| Own model calls attaching the key on-device | `callAI` `L8788`, `callAIC` `L8996`, `headers['x-api-key']` `L8852`, `Bearer ` `L8882`, direct-browser-access test `L11049-11104` |
| Own key-entry UI | `page-api` `L2995`, dock tabs `L5754`, key fields `L3152`, `L3171`, `L3196`, README quote `L3198` |
| Own TTS/STT calls | `L8150`, `L8166` |
| Own memory store, ranker, consolidation | `L4151`, `getMemoryScore` `L8518`, `parseMemoryFieldsM` `L10761`, `saveMemoryFrom` `L10828`, write `L10990` |
| Own proactive scheduler (+ native delegation) | `setInterval` loop `L16644-16674`, `_hbSyncNative` `L16609`, `presenceSync` `L16619`, `presenceWake` `L19762` |
| Native shell contract | `L19736-19833`, `has:[…]` `L19821`, orientation `L12631`, camera permission `L21626` |
| Backup-only sync | `SYNC_STORES` `L12242`, export `L12341`, envelope `L12365`, `noKey` strip `L12357`, import `L12315`, `_mioSkipped` `L12334`, letters/memories variants `L12839`, `L12018` |
| Service worker has no push/notificationclick/background-sync | `ib-sw.js` (15 lines, fetch handler only) |
| Technique anchors used in §6.3 | back ladder `L19791-19815`; insets `L17`, `L19748-19757`; bar colour `L19767-19801`; `screenY` gesture `L8233-8234`; composer re-pin `L8323-8331`; `pinBottom` `L7908-7919`; `loadEarlier` `L7920-7947`; `_tmCollapse` `L7875-7884`; image downscale `L5645-5662`, icon gate `L12611-12612`; recorder `L8205-8314`; `_ibNotify` `L12616-12627`; `_ibRouteGo` `L16621-16631`; audio unlock `L20699-20703` |

**C.2 Schema diff — why a backup crosses the boundary but arrives incomplete.** Its 22 stores are this checkout's **first 21** plus `feed`. Absent upstream, and therefore silently dropped (or `_mioSkipped`) on import here: `active_message_settings`, `active_message_history`, `active_message_plans`, `diary_entries`, `moments`, `roleLetters`, `roleLetterMemories`, `activities`, `favorites`, `understandings`, `threads`. That is the whole companion generation — proactive scheduling, diary, Moments, role letters, shared activities, favorites, and the understanding/thread memory layers — at v15 against v23 (`assets/js/core.js:3-4`).
