# MOBILE_GATEWAY — device identity, pairing, and the world API

**Stage:** M1-B · Device Identity + Pairing + Mobile Gateway Skeleton
**Status:** landed. Companions: `MOBILE_HOME_NODE_AUDIT.md` (M0 audit),
`docs/HOME_NODE_CHAT.md` (M1-A canonical chat authority) and
`docs/CHAT_MESSAGE_CONTRACT.md` (the frozen chat field table).

> Source beats prose. Where this file disagrees with `docs/ARCHITECTURE.md`,
> `docs/HANDOVER.md` or `docs/SOCIAL_RUNTIME.md`, this file describes what the code does today
> and the others are stale. Every claim below carries a `file:line` or a test name.

**No Android code exists.** M1-B builds only the server contract an Android thin client will
consume. See §16.

---

## 1. Trust model

```
                    Desktop Browser
                          │  localhost privileged client
                          │  (Home Node token + loopback, or loopback alone)
                          ▼
                    ┌───────────────┐
                    │ Home Node Core│   chat store · execution · device registry
                    └───────┬───────┘
              ┌─────────────┴──────────────┐
              ▼                            ▼
       Desktop APIs                 Mobile Gateway  /mobile/v1/*
   /status /list /messages                │  per-device token
   /turn /verify /migrate                 │  versioned envelope
   /pairing/session /devices         authenticated device
   /characters /characters/publish         │
                                     Android (M1-C, not built)
```

Three claims the whole design rests on:

1. **The Home Node is the authority for chat records** (M1-A). The desktop browser is a
   privileged *client* of it, not a second authority.
2. **A device token is identity. An IP address is not. An `Origin` header is not.**
   `192.168.x.x` appearing in a request proves nothing, which is exactly what makes the later
   Tailscale/WireGuard/TLS work (§15) a transport change rather than an identity change.
3. **The Mobile Gateway is a small, versioned, allowlisted, device-authenticated world API.**
   It is not the Bridge tool API, and it does not import it (§9).

### 1.1 What the gateway deliberately is not

| Not this | Because |
|---|---|
| A Bridge route surface | `bridge/routes.js` carries `/api/llm-proxy`, a tool catalog, `submit_payment`, `pay_register_checkout`, `pay_set_config`, webhooks and resident chat. The gateway does not import it (`services/home-node/mobile-gateway.js` has no `require` of anything under `bridge/`). |
| A second chat API | `chat.history` / `sync.changes` / `chat.send` read and write the **same** M1-A canonical store and the **same** revision cursor. No second database, no second message schema, no second revision. |
| A provider proxy | `chat.send` calls `executeCharacterTurn`; the device never sees a provider endpoint, model id in wire form, or API key. |
| A general-purpose RPC | Every mobile verb is in one allowlist (`ADMIN_PATHS` + the `/mobile/v1/*` branches). Anything else is `UNKNOWN_VERB` 404. |

---

## 2. Device model

`services/home-node/device-registry.js` — the domain layer. It knows nothing about HTTP,
WebSockets or Origins; the transport layer can only call its methods.

### 2.1 Identity is not `user_id`

| | `ib_active_user_id` | `deviceId` |
|---|---|---|
| What it is | a legacy ownership/scoping tag on Active tasks and the outbox | an authenticated client identity |
| Who writes it | the desktop, freely | the Home Node, at pairing |
| Does it prove anything | no | yes — a device credential is bound to it |
| Lifetime | user-editable | until revoked; revoke is a terminal state |

They are two different things and the code never assigns one to the other.

### 2.2 Tables (same SQLite file as chat, separate schema)

`%LOCALAPPDATA%\InternalBeyond\home-node\home-node.db`, WAL.

```sql
CREATE TABLE devices (
  device_id      TEXT PRIMARY KEY,   -- dev_<random>
  name           TEXT NOT NULL,      -- user-editable
  type           TEXT NOT NULL,      -- android | ios | desktop | tablet | unknown
  created_at     INTEGER NOT NULL,
  last_seen_at   INTEGER NOT NULL,
  revoked_at     INTEGER,            -- NULL = active; revoke is irreversible
  capabilities   TEXT NOT NULL,      -- JSON allowlist: chat | sync | notify | vision
  token_version  INTEGER NOT NULL,
  token_hash     TEXT,               -- SHA-256 hex. The raw token is NEVER stored.
  token_issued_at INTEGER,
  app_foreground INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE pairing_sessions (
  pairing_id  TEXT PRIMARY KEY,      -- pair_<random>
  secret_hash TEXT NOT NULL,         -- SHA-256 of the one-time secret
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  consumed_at INTEGER,               -- single-use marker
  consumed_by TEXT,                  -- device issued by this session
  device_name TEXT, device_type TEXT -- hints supplied by the desktop
);

CREATE TABLE device_events (at INTEGER, device_id TEXT, event TEXT, detail TEXT);

CREATE TABLE characters (               -- mobile-safe DTO only
  id TEXT PRIMARY KEY, dto_json TEXT NOT NULL, for_turn INTEGER NOT NULL, updated_at INTEGER NOT NULL);

CREATE TABLE character_runtime_specs (  -- provider credentials. NEVER leaves Node.
  character_id TEXT PRIMARY KEY, spec_json TEXT NOT NULL, updated_at INTEGER NOT NULL);
```

Isolation from the chat authority is structural, not conventional:

* device tables never touch `messages`, `change_log` or `idempotency`;
* the device schema version lives in its own `meta` key (`devices_schema`), so the two
  subsystems version independently and either can `open()` first;
* device events deliberately do **not** enter `change_log` — that revision sequence belongs to
  chat records alone (§12).

### 2.3 Capabilities

`['chat','sync','notify','vision']` — a closed allowlist. An unknown string is **dropped**, not
granted (`normalizeCapabilities`). Ordering is normalized so the same device always serializes
identically. `vision` gates image uploads through `chat.send`; a device without it gets
`CONFLICT` rather than a silently stripped image.

---

## 3. Pairing

```
Desktop (privileged)                      Home Node                        Device
  POST /pairing/session        ──▶  createPairingSession()
                                    pair_<random> + secret (256 bit)
       {pairingId, secret,      ◀──
        expiresAt, endpoints,
        fingerprint, v}
       present as QR / typed payload
                                                       POST /mobile/v1/pairing/complete
                                                              {v, payload:{pairingId, secret, …}}
                                    consumePairingSession()  ──▶ atomic single-use claim
       {device, token, profile}  ◀─────────────────────────────────────────┘
```

### 3.1 Session rules

| Rule | How |
|---|---|
| **single-use** | `UPDATE pairing_sessions SET consumed_at=… WHERE pairing_id=? AND consumed_at IS NULL AND expires_at > ?` — a conditional write, so two concurrent consumers cannot both win. The loser gets `PAIRING_USED`. |
| **short-lived** | `PAIRING_TTL_MS` = 5 minutes, recorded per session as `expires_at`. |
| **random** | `pairingId` = `pair_` + 12 random bytes; `secret` = 32 random bytes → base64url. **There is no 6-digit human code.** A human code would be a second, weaker credential with brute-force exposure; the payload is meant to be transferred verbatim (QR is presentation only, §14). |
| **server-recorded** | both the id and the secret hash are in SQLite; the session knows what it was created for and which device consumed it. |
| **no oracle for brute force** | an unknown `pairingId` and a wrong secret both return `PAIRING_INVALID`. Only a *correct* secret reveals `PAIRING_USED` / `PAIRING_EXPIRED`. |
| **rate limited** | pairing attempts are limited per remote address (`RULES.pair`, keyed by IP because the caller is unauthenticated). Exceeding it returns 429 with `Retry-After`. |

### 3.2 Why the secret is a random opaque string and not a JWT

The device table must be consulted on every request anyway (revocation, `lastSeen`), so a
self-contained token would add parsing and algorithm surface without removing a lookup. An
unreadable random string plus a server-side hash is smaller and auditable. No JWT library is
used and none is needed.

---

## 4. Token storage and verification

```
raw token  =  "ibd1_" + base64url(32 random bytes)      ← returned exactly once
stored     =  SHA-256(raw token) as hex                 ← the only server-side form
```

| Property | How | Test |
|---|---|---|
| device binding | the hash is a column on `devices`; verification returns that row's device | `dev.verify 正确 token → 设备` |
| issuance time | `token_issued_at` | `dev.DTO 字段齐备` |
| revocation | `revoked_at`; verification checks it **after** the hash matches | `revoke.撤销后立即拒绝（DEVICE_REVOKED）` |
| rotation | `token_version` +1 and a new hash; the old token cannot match the new hash | `rot.旧 token 立即失效` |
| constant-time compare | `crypto.timingSafeEqual` over the SHA-256 digests | `util.constantTimeEqual …` |
| no raw token at rest | the DB row and the whole DB file are grepped for the raw token | `sec.DB 里没有 raw token` |
| format version in the token | `ibd<v>_…`; an unrecognised version is `AUTH_INVALID` so the client re-pairs instead of guessing | `dev.verify 未知格式版本 → AUTH_INVALID` |

**Revocation keeps `token_hash` on purpose.** It lets a revoked device get a precise
`DEVICE_REVOKED` instead of being merged into `AUTH_INVALID`. Nothing is weakened: the
authorisation check happens *after* the hash matches, and every write path
(`rotateDeviceToken`, `issueDevice` with the same id) requires `revoked_at IS NULL`. The client
can therefore branch correctly: `DEVICE_REVOKED` → wipe local credentials and re-pair;
`AUTH_INVALID` → the credential itself is wrong.

### 4.1 Transport of the token

* **Header first.** `Authorization: Bearer <token>` or `X-IB-Mobile-Token: <token>`. Native
  Android should always use a header.
* **Never the query string.** `?token=` is rejected (`AUTH_REQUIRED`). URLs leak into logs,
  history and `Referer`; a permanent credential must not live there.
* **WebSocket is not used**, so there is no need to weaken this rule for browser handshakes
  (§10).

---

## 5. Revoking

`POST /device/revoke {deviceId}` (desktop, privileged) or `POST /mobile/v1/device/revoke`
(device, self).

* takes effect **immediately** — the very next request is rejected;
* **also tears down live streams** for that device (`disconnectDeviceStreams`), so a device
  cannot keep receiving after being revoked;
* **idempotent** — a repeat revoke returns `alreadyRevoked:true` rather than failing;
* **irreversible** — a revoked device cannot be revived by rotation or re-issued under the same id;
* **per-device** — revoking device A never affects device B, which is the entire point of
  per-device credentials instead of one shared token.

---

## 6. Transport

**Chosen: HTTP commands + SSE (`text/event-stream`)** — Option A.

| Candidate | Verdict |
|---|---|
| A · HTTP + SSE | **chosen.** Streaming is one-directional (server→client), which is exactly SSE's shape. History, sync and presence are idempotent pulls that belong on plain HTTP. Debuggable with `curl -N`. Any HTTP client on Android can consume it with no protocol library. |
| B · WebSocket multiplexing | rejected. Would require handshake, masking, fragmentation, ping/pong, reconnect backoff and a request/response correlation layer that HTTP already provides. |
| C · HTTP + WebSocket events | rejected for the same reason, plus two transports to secure and test. |

The Bridge already having WebSocket is **not** a reason to use it here, and this stage does not
reuse Bridge's message vocabulary in any case.

WebSocket is left for a future stage that genuinely needs bidirectional realtime (voice/video
signalling). That stage must define its own vocabulary rather than borrowing Bridge's.

### 6.1 Two SSE channels and why

| Channel | Endpoint | Lifetime | Durability |
|---|---|---|---|
| **Turn stream** | `POST /mobile/v1/chat/send` (with `Accept: text/event-stream`) or `GET /mobile/v1/chat/stream/<turnId>` | one turn; closes after `chat.done` / `chat.error` | buffered frames replayable by sequence within the window |
| **Event channel** | `GET /mobile/v1/events` | long-lived | **ephemeral by design** — durable state comes from `sync.changes` |

That split is Phase 23's `state sync` vs `ephemeral event` separation: losing event frames never
loses data, because the change log is the truth.

---

## 7. Protocol v1

Envelope (`services/home-node/mobile-gateway.js`):

```json
// success
{ "v": 1, "ok": true,  "type": "chat.send", "requestId": "…", "serverTime": 0, "payload": {} }
// failure
{ "v": 1, "ok": false, "type": "error",     "requestId": "…", "serverTime": 0,
  "error": { "code": "BAD_VERSION", "message": "…", "retryable": false, "detail": "2" } }
```

**`v` is really validated** — this is the specific failure mode the audit found in the Bridge
(`hello.version` existed but the server never read it). Here a missing, non-integer, or
unsupported `v` is `BAD_VERSION`; there is no "absent means 1" default, because such a default
makes "the client never implemented negotiation" indistinguishable from "the client is v1".
`{"v":true}` is also rejected — `Number(true) === 1`, and a version field must be stricter than
"coercible to 1" (`gw.1 v=true → BAD_VERSION`).

### 7.1 Verbs (complete allowlist)

| Verb | Method + path | Auth | Events |
|---|---|---|---|
| `pairing.complete` | `POST /mobile/v1/pairing/complete` | pairing secret | — |
| `handshake` | `GET /mobile/v1/handshake` | device | — |
| `device.self` | `GET /mobile/v1/device/self` | device | — |
| `device.rename` | `POST /mobile/v1/device/rename` | device | — |
| `device.token.rotate` | `POST /mobile/v1/device/token/rotate` | device | — |
| `device.revoke` | `POST /mobile/v1/device/revoke` | device | — |
| `character.list` | `GET /mobile/v1/character/list` | device | — |
| `character.get` | `GET /mobile/v1/character/<id>` | device | — |
| `chat.history` | `GET /mobile/v1/chat/history` | device | — |
| `sync.changes` | `GET /mobile/v1/sync/changes` | device | — |
| `chat.send` | `POST /mobile/v1/chat/send` | device | `chat.start` → `chat.delta`* → `chat.done` \| `chat.error` |
| `chat.retry` | `POST /mobile/v1/chat/retry` | device | same as `chat.send` |
| `chat.stream` | `GET /mobile/v1/chat/stream/<turnId>` \| `?requestId=` | device | replay + live |
| `turns.get` | `GET /mobile/v1/turns/<turnId>` \| `?requestId=` | device | — |
| `presence` | `GET /mobile/v1/presence` | device | — |
| `presence.report` | `POST /mobile/v1/presence/report` | device | — |
| `events` | `GET /mobile/v1/events` | device | `message.created`, `message.deleted`, `cursor.changed`, `presence.changed`, `notify.error` |

Desktop-only admin surface (not mobile; protected by the Home Node token + loopback):

| Path | Purpose |
|---|---|
| `POST /pairing/session` | mint a one-time pairing payload |
| `GET /devices` | list devices (with `online`, never credentials) |
| `POST /device/revoke` | revoke by `deviceId` |
| `GET /characters` | catalog summary (`id`, `forTurn`, `updatedAt`) |
| `POST /characters/publish` | publish the sanitized catalog snapshot (§8) |

### 7.2 Stream events and sequencing

```json
{ "type": "chat.delta", "sequence": 7,
  "payload": { "kind": "reasoning" | "content", "text": "…", "index": 3 } }
```

* reasoning and content share **one** event type with a `kind` discriminator — there is no
  separate reasoning protocol.
* every event is correlated by `requestId`, `conversationId` and `turnId`.
* `sequence` is monotonic per turn starting at 1, so a client can detect missing or duplicate
  frames. SSE `id:` is `<streamId>:<sequence>`; `Last-Event-ID` and `?after=<n>` both work.
* `chat.done` carries the **canonical** assistant message read back from the store, plus
  `assistantMessageId`, `revision` and `duplicate`. `chat.done` is the only success terminal.
* `stream.error` with `code:'REPLAY_GAP'` is emitted when the client asks to resume from a
  position older than the buffer; it means "the middle was lost, resync" — never "your data is
  gone".

### 7.3 Error codes

Closed vocabulary. A client branches on these and never on message text. Node stack traces,
SQL text and filesystem paths are never returned.

| Code | HTTP | Meaning |
|---|---|---|
| `AUTH_REQUIRED` | 401 | no credential presented |
| `AUTH_INVALID` | 401 | credential does not match any device |
| `DEVICE_REVOKED` | 403 | credential was valid, device is revoked |
| `PAIRING_INVALID` | 403 | unknown session id or wrong secret (deliberately merged) |
| `PAIRING_USED` | 409 | session already consumed |
| `PAIRING_EXPIRED` | 410 | session past TTL |
| `PAIRING_NOT_FOUND` | 404 | admin-side lookup of an unknown session |
| `BAD_VERSION` | 400 | missing / non-integer / unsupported `v` |
| `BAD_REQUEST` | 400 / 422 | unparsable or semantically invalid request |
| `UNKNOWN_VERB` | 404 / 405 | not in the allowlist |
| `NOT_FOUND` | 404 | known verb, unknown target (character, turn) |
| `BUSY` | 409 | another turn is in flight in this conversation |
| `CONFLICT` | 409 | e.g. device lacks a required capability |
| `RATE_LIMITED` | 429 | includes `Retry-After` |
| `TOO_LARGE` | 413 | body over `MOBILE_MAX_BODY_BYTES` (24 MiB) |
| `UNSUPPORTED` | 501 | verb exists but execution is unavailable |
| `INTERNAL` | 500 | everything else; detail is intentionally withheld |

---

## 8. Character DTO

**Character DTO ≠ Character Runtime Config.** This is the one real authority gap M1-B had to
solve, and it is solved by *structure* rather than by remembering to delete fields.

### 8.1 The gap, stated plainly

`apiConfigs` is browser-owned (M0/M1-A moved chat records, not provider configuration). It is
simultaneously a character's display identity **and** its provider runtime configuration,
including a plaintext `apiKey`. The Home Node must be able to execute a turn, and must never
expose the credential.

### 8.2 Chosen approach: temporary catalog snapshot (Strategy A)

```
window.apiConfigs
      │  assets/js/mobile-dto.js · characterCatalogEntry()   ← one implementation
      ▼
{ id, dto, spec }
      │  POST /characters/publish   (desktop, privileged)
      ▼
Home Node
   ├── characters               ← dto_json   : published to any authenticated device
   └── character_runtime_specs  ← spec_json  : read ONLY by executeCharacterTurn
```

Two tables, not one filtered object. With one table and a field picker, a single missed key
leaks a credential; with two, a leak requires someone to explicitly join the secrets table into
a DTO path.

`assets/js/mobile-dto.js` is loaded by **both** the browser (`<script>`) and Node (`require`),
so "what the desktop publishes" and "what the gateway serves" are the same projection. The
gateway projects a second time on the way out, from the same module — so even a desktop that
sent something wrong cannot produce a leaking DTO.

### 8.3 Exposed

```json
{
  "id": "friend_…", "name": "…", "avatar": "data:image/…",
  "relationship": "…", "handle": "…", "signature": "…", "bio": "…", "banner": "…",
  "createdAt": 0, "model": "…", "status": "active" | "archived",
  "capabilities": { "chat": true, "stream": true, "vision": true, "webSearch": false, "imageGen": true }
}
```

`model` is a display field the user typed; knowing a model name grants access to nothing. It is
not the same class of value as `endpoint`.

### 8.4 Never exposed

```
apiKey            imageGenApiKey        any *ApiKey / *api_key
endpoint          provider credential   Authorization header
systemPrompt      (raw hidden prompt)   temperature, cache flags
imageGenEndpoint  voice clone material  Middle Brain key
```

Enforced and asserted:

* `asset/js/mobile-dto.js` builds the output from **literals**, so an unexpected input key has
  no path into the result — a future `apiConfigs` secret is not automatically leaked;
* `tests/test_mobile_gateway_http.js` → `gw.7` scans real responses for
  `apiKey|api_key|authorization|bearer|credential|"secret"|sk-…` across `handshake`,
  `device/self`, `character/list`, `character/get`, `chat/history`, `sync/changes`, `presence`
  and `turns`, and additionally for the specific planted secrets and the hidden system prompt;
* `tests/test_m1a_chat_authority_smoke.js` does the same against a real browser + real Home Node
  with a real `apiConfigs` entry;
* `gw.7` also asserts that the pairing response **is** the one place a credential is returned —
  so the leak regex is not accidentally passing by matching nothing anywhere.

### 8.5 The honest dependency

Executing a turn on the Home Node requires a spec that only the browser can supply. Therefore
**a character that has never been published by the desktop cannot be used by a phone**;
`chat.send` returns `CONFLICT` with `detail:'this character has no runnable configuration on the
Home Node'` rather than pretending. The desktop publishes automatically after its first
successful sync and can be re-triggered with `IB.homeNode.publishCharacters()`.

An empty catalog is **never published** — publish has replace semantics, so an empty push would
wipe the Node catalog. That bug was caught by the browser smoke test and is now asserted.

---

## 9. The Bridge boundary

| Bridge surface | Mobile Gateway |
|---|---|
| `/api/llm-proxy` (and its SSRF finding, audit R5) | absent — no proxy of any kind |
| tool catalog / `tools/execute` | absent |
| `submit_payment`, `pay_register_checkout`, `pay_set_config` | absent |
| `webhook` | absent |
| resident chat (Bridge hello/chat vocabulary) | absent; protocol v1 has its own verb and event vocabulary |
| TTS / ASR / voice runtime | absent from the gateway |

`GET /security` states this in the response body, and `tests/test_mobile_gateway_http.js → gw.6`
asserts that every one of 13 dangerous paths under `/mobile/v1/` returns 404, and that the verb
allowlist reported by `/security` contains no Bridge verb.

Reused from the Bridge: *patterns only* — constant-time token comparison, atomic SQLite
persistence, headless `createX(deps)` construction. No Bridge module is imported, so no Bridge
dependency chain enters the Home Node. Where a primitive was needed, a small local one was
written (`constantTimeEqual` in both `http.js` and `device-registry.js`) rather than coupling
the gateway to Bridge internals.

---

## 10. LAN policy

**Rule: without device authentication, the service must not listen on LAN. There is no silent
insecure fallback.**

`services/home-node-service.js`:

```
HOST = IB_HOME_NODE_HOST || '127.0.0.1'
LOOPBACK_BIND = isLoopbackHost(HOST)

startup:
  openAll()                       → chat store, then device registry
  on failure:
     if !LOOPBACK_BIND  → "refuses to listen on <HOST>: its device registry could not be
                            opened, so LAN clients could not be authenticated.
                            Bind 127.0.0.1 or fix the data directory." → exit 1
     else               → open failure reported → exit 1
  on success and !LOOPBACK_BIND:
     assert registry.isOpen()     → else refuse and exit 1
     probe = deviceAuthReady(registry)      → real authentication round trip, see 10.2
     log 'lan-bind-enabled' {deviceAuth:'required', allowRemote:probe.ready,
                             deviceAuthProbe:probe.reason}
     if !probe.ready → keep serving, but say non-loopback requests will be refused
  listen:
     log 'listening' {loopbackOnly, remoteClients:
                      'refused (loopback bind)' | 'device-token-required'
                      | 'refused (<probe.reason>)'}
```

`isLoopbackHost` accepts `localhost`, `127.0.0.0/8`, `::1` and nothing else — `0.0.0.0`, `::`
and any hostname are *not* loopback, so they take the strict path.

Defaults: `IB_HOME_NODE_HOST=127.0.0.1`, `IB_HOME_NODE_PORT=23118`. LAN exposure is opt-in by
explicitly setting the host.

### 10.1 The remote request gate (`allowRemote`)

Binding is only half of it. A non-loopback request is admitted **only** if the request gate
can prove that device authentication is live *at that moment*:

```js
// services/home-node-service.js — the only definition
allowRemote: () => !loopbackBind && deviceAuthReady(registry).ready

// services/home-node/http.js
const allowRemoteSource = typeof deps.allowRemote === 'function' ? deps.allowRemote : () => !!deps.allowRemote;
function remoteAllowed() { try { return !!allowRemoteSource(); } catch (_) { return false; } }

if (remote && !remoteAllowed()) { … 403 'loopback-only' … }        // before routing: covers everything
```

Three properties are deliberate:

* **the predicate is a function, not a snapshot.** The http layer is constructed *before*
  `open()` runs, so freezing the answer into a boolean would bake an unproven assumption into
  a security decision — reorder startup and the door is open while device auth is not ready.
  It is therefore re-evaluated per request, and **fails closed** if the predicate throws;
* **`deviceAuthReady()` runs a real authentication round trip** (`services/home-node-service.js`):
  a well-formed but impossible token (`ibd1_probe-…`) must come back `AUTH_INVALID`.
  `STORE_CLOSED` (registry not open), a thrown query, or `ok:true` (a stranger's token accepted)
  all mean *not ready*. `touch:false`, so the probe writes no device state;
* **no override seam exists.** This is a security predicate; the only legal answer comes from
  the probe.

### 10.2 Authentication on every mobile endpoint

| Caller | Path | Requirement |
|---|---|---|
| remote (non-loopback) | `/mobile/v1/*` | device token, **except** `pairing/complete` (own one-time high-entropy secret) and `OPTIONS` preflight (no world data, grants nothing) |
| remote (non-loopback) | every other path | **a configured** Home Node token; with no token configured → `403 remote-admin-disabled` |
| loopback | `/mobile/v1/*` | device token (same rules) |
| loopback | desktop admin paths | Home Node token if configured |
| loopback | `/health` | none — the only unauthenticated read, and it returns no world data |

The remote/desktop row is a **necessary condition** of opening the gate, not hardening:
`authorized()` returns `true` for every request when no token is configured (the loopback
single-user model), and a default install has no token. Without that row, `allowRemote` would
hand anonymous LAN clients `/pairing/session` (mint a pairing credential) and `/device/revoke`.
`403` rather than `401` because there is no credential that could ever work in that state.
`/mobile/v1/*` is deliberately excluded — the device namespace authenticates with a device
token, and gating it would make LAN pairing impossible, which is the entire point of LAN mode.

Also enforced: constant-time comparison, immediate revocation, malformed-credential rejection,
per-key rate limiting, a 24 MiB body cap, and no permanent token in the query string.

### 10.3 Origin policy — why it is *not* the security boundary

`Origin` decides whether a **browser** may read a response; it never decides who may act.

* no `Origin` (native Android, curl) → no CORS headers needed;
* `capacitor://localhost`, `ionic://localhost`, loopback origins → echoed;
* `null` (file://, sandboxed iframe) → echoed;
* anything else → not echoed (the browser then blocks the read), unless listed in
  `IB_HOME_NODE_MOBILE_ORIGINS`.

Echoing an origin grants an attacker nothing: without a device token the response is
`AUTH_REQUIRED`.

`OPTIONS` is answered in `dispatch()`, **before** mobile/admin routing, so both `/mobile/v1/*`
and the desktop admin paths are callable from a browser. (An earlier implementation handled it
inside the mobile branch only; `/characters/publish`'s preflight then fell through to the admin
404, the browser judged the preflight failed, and the whole POST surfaced as "Failed to fetch"
while the server log showed only a single `OPTIONS`.)

### 10.4 Rate limits (no dependency)

Token bucket, per key, in-process (`createRateLimiter`).

| Rule | Key | Rate / burst | Applies to |
|---|---|---|---|
| `pair` | remote address | 10/min, burst 10 | unauthenticated `pairing/complete` |
| `authFail` | remote address | 2/s, burst 120 | failed authentication |
| `send` | device | 1/s, burst 60 | `chat.send`, writes |
| `read` | device | 240/min, burst 240 | reads |
| `stream` | device | 1/s, burst 60 | opening a stream |

429 responses carry `Retry-After`. Unauthenticated attempts are keyed by address precisely
because there is no device to key on yet.

---

## 11. Character and chat contracts from the client's side

### 11.1 `character.list` / `character.get`

(`character.list` is also covered in §8; `character.get` returns one entry plus `catalogUpdatedAt`.)

### 11.2 `chat.history`

`GET /mobile/v1/chat/history?conversationId=… | ?characterId=…[&threadId=][&limit=][&cursor=][&before=]`

Reads the **M1-A canonical store** directly. Pagination is the M1-A keyset contract verbatim:
`cursor` (continue backwards), `before` (exclusive bound), `limit` (default 50, max 500), and the
response carries `cursor`, `oldest`, `hasMore`, `hasOlder`, `hasNewer`, `revision`. A mobile
client must not invent a second paging model.

Message DTO:

| Kept | Dropped (runtime-only) |
|---|---|
| `id` (canonical, never regenerated), `role`, `content`, `timestamp`, `conversationId`, `threadId`, `senderName`, `truncated`, `withdrawn`(+`withdrawnBy`), `revision` | `reasoning_content` |
| `images` **metadata only** (`mime`, `name`, `width`, `height`, `size`, `inline:true/false`) | `wsSearches`, `memOps`, `calNotes` |
| `files` metadata, `voice` metadata (+`transcript`) | `upstreamRaw`, `thinkingSources` |
| `metadata` whitelist: `model`, `model_id`, `config_id`, `showThinking`, `source`, `eventType`, `characterId`, `waifu` | any unknown metadata key |

Two deliberate choices:

* **images are metadata only, never inlined base64.** One 20 MiB inline image would turn "read
  history" into a tens-of-megabytes download. `inline:true` tells the client the pixels exist if
  it wants to ask for the full record through the desktop API.
* **unknown top-level fields are not forwarded.** For chat, the whitelist is an explicit DTO
  rather than "everything minus a few", because a chat DTO is a projection, not a mirror — the
  canonical record is still preserved byte-for-byte in the store, so nothing is lost.

### 11.3 `chat.send`

```
POST /mobile/v1/chat/send
{ "v":1, "requestId":"…", "payload": { "characterId":"…", "content":"…",
                                       "threadId":"", "historyLimit":20,
                                       "maxTokens":0, "temperature":0, "reasoningEffort":"auto",
                                       "stream": false } }
```

* **`requestId` is required** — it is the idempotency key (§12).
* **`characterId` is required and is the conversation key.** The client cannot supply `friendId`,
  `role` or message `id`: the server derives `friendId = characterId` and
  `id = messageIdFromRequest(requestId)`. A device therefore cannot write into another
  conversation, and the store's id-level idempotency holds as a second line of defence.
* **the only generation path** is
  `chat.send → executeCharacterTurn → NodeModelPort.runStream → IBModelCore → provider`.
  There is no path from a device to a provider endpoint, to the Bridge proxy, or to a
  request the gateway builds itself.
* `contextPolicy` is recorded as `'mobile-gateway-history'` — an honest label saying the context
  is "character configuration + this conversation's history", i.e. **no Middle Brain**. M1-A
  requires that this not be pretended otherwise.
* Responds `202` with `{turnId, streamUrl, eventsUrl, disconnectPolicy}` — or streams in the
  same request when the client sends `Accept: text/event-stream` (or `payload.stream=true`).

### 11.4 `sync.changes`

`GET /mobile/v1/sync/changes?cursor=<revision>[&limit=]` → `{cursor, revision, upserts[], deletes[], hasMore, serverTime}`

This is **M1-A's `changesAfter` exposed directly**. The Home Node revision *is* the canonical
cursor: no second revision, no event table, no sequence of its own. `cursor=0` replays
everything; a stale cursor is always safe because the revision is monotonic and never
renumbered.

---

## 12. Idempotency and retry

The mobile reality is: lose the network → request times out → reconnect → retry. `chat.send`
therefore requires `requestId` and reuses M1-A's idempotency directly.

| Layer | Mechanism | Effect |
|---|---|---|
| transport | `store.idempotency` keyed by `requestId`, in SQLite | a retry returns the original `userMessageId` and **does not call the model** |
| gateway | `turnByRequest` map | an `chat.send` repeat returns the existing turn: `duplicateRequest:true`, plus the finished result if it already settled |
| content | message id derived deterministically from `requestId` | even a store-level replay cannot create a second row |

Asserted in `tests/test_mobile_thin_client.js → thin.11`:

* the retry returns `duplicateRequest:true` with the same `userMessageId` **and** the same
  `assistantMessageId`;
* the provider call count does **not** increase;
* `chat.history` still reports exactly the same number of messages.

---

## 13. Reconnect, resume, and disconnect semantics

> **`disconnect ≠ model cancellation`.** A client dropping its stream does not cancel the turn.

The execution is owned by the gateway's turn record, not by the HTTP response. When the client
disconnects, the response is detached (`stream-detached`) and the turn runs to completion,
writing both canonical messages.

| Client action | What it gets |
|---|---|
| `GET /mobile/v1/chat/stream/<turnId>?after=<seq>` (or `Last-Event-ID`) | buffered frames with `sequence > after`, then live frames while it runs, then `chat.done` and EOF |
| reconnect to an already-finished turn | the tail of the buffer, then `chat.done`, then EOF — never a hanging connection |
| resume from a position older than the buffer | `stream.error` `{code:'REPLAY_GAP', resync:true}`, followed by the remaining frames and the terminal frame |
| `GET /mobile/v1/turns/<turnId>` or `?requestId=` | `{status, sequence, assistantMessageId, revision, replayFrom, replayTo, error}` |
| `sync.changes` with the last cursor | the canonical messages, whatever happened to any stream |

A turn stream **closes** after its terminal frame; a client that wants further notifications
subscribes to `/mobile/v1/events` instead.

**Not attempted:** replaying the provider's TCP stream. That would be unreliable and buys
nothing, because the canonical store already holds the result. The replayed buffer is our own
protocol frames within a bounded window (`TURN_EVENT_BUFFER_MAX`, `TURN_HISTORY_MAX`,
`TURN_TTL_MS`), and exceeding it degrades to "read canonical state", which is always correct.

### 13.1 Notification events

`GET /mobile/v1/events` emits:

| Event | Payload | Note |
|---|---|---|
| `message.created` | `messageId`, `conversationId`, `characterId`, `threadId`, `role`, `timestamp`, `source`, `revision` | pointer only — **no content, no prompt, no memory body** |
| `message.deleted` | `messageId`, `conversationId`, `revision` | |
| `cursor.changed` | `cursor`, `revision` | sent as the first frame so a client knows where it stands |
| `presence.changed` | `deviceId`, `online`, `at` | |
| `notify.error` | `code`, `resync` | e.g. backlog over `SUBSCRIBER_QUEUE_MAX` — the client is dropped and told to resync |

Events are a **notification** channel: durable recovery is `sync.changes`. The pump reads the
same `change_log` as everything else (no second event database), polls on a `unref()`'d interval
so it can never keep the process alive, and drops slow subscribers rather than buffering
without bound.

This is the foundation for the future `proactive message → canonical store → gateway → Android
notification` path. **Android notification itself is not built** (Phase 22).

### 13.2 Presence

Minimal by construction: `online`, `lastSeenAt`, `appForeground`. `POST
/mobile/v1/presence/report` accepts **only** `appForeground`. Battery, GPS, sensors and full
device fingerprints are deliberately not accepted, and the character runtime does not read
presence at all — this stage establishes plumbing only.

---

## 14. Desktop developer surface (and QR)

Not a polished UI, as scoped. From the browser console on the normal launch path:

```js
await IB.homeNode.publishCharacters()          // push the sanitized catalog now
const p = await IB.homeNode.pairing.create({deviceName:'My Android', deviceType:'android'})
JSON.stringify(p.payload)                      // ← the pairing payload to transfer
await IB.homeNode.pairing.list()
await IB.homeNode.pairing.revoke('<deviceId>')
```

`POST /pairing/session` returns:

```json
{
  "pairingId": "pair_…", "secret": "…", "expiresAt": 0, "ttlMs": 300000,
  "lanReachable": false,
  "endpoints": { "mobile": { "host": "192.168.10.x", "port": 23118, "scheme": "http" },
                 "pairPath": "/mobile/v1/pairing/complete" },
  "fingerprint": "…"
}
```

**Pairing payload fields — what is in and what is not:**

| Field | In? | Why |
|---|---|---|
| `v` (version) | **yes** | a payload on disk / in a QR code outlives the code that read it |
| `pairingId`, `secret`, `expiresAt` | yes | the credential |
| `host`, `port`, `scheme` | yes | the device must know where to connect. `lanReachable:false` plus an empty host is returned when the Node is loopback-only, instead of handing out an address that can never work |
| `fingerprint` | yes | a **non-secret** visual check that the user is pairing with the intended machine. It is not a key and is not used in authentication |
| TLS mode / certificate pin | **no** | the current transport is plain HTTP over LAN. Advertising a TLS mode that does not exist would be worse than omitting the field; it will be added if and when TLS exists |

**QR rendering: deferred.** The payload is stable, versioned, and JSON — QR is presentation
only. No QR encoder exists in the repository and none was vendored, because doing so would add a
third-party file and a license question for a purely cosmetic step. When it is added it must be
a single vendored file, in its own commit, with its license stated, and it must not enter the
protocol or domain layer.

---

## 15. Tailscale / TLS readiness

Not implemented. What the protocol guarantees so that adding it is a transport change rather
than an identity redesign:

* **security never depends on `192.168.x.x` meaning "trusted"** — IP is not identity (§1);
* device tokens are the identity, so an overlay network is just a different path to the same
  authenticated endpoint;
* the payload carries `scheme`, so `https` can be expressed without a protocol version bump;
* the pairing payload has a version, so a TLS/fingerprint field can be added compatibly;
* tokens travel in headers, never in URLs, so they are not exposed to intermediary logs;
* nothing assumes a specific address family, interface or subnet.

---

## 16. Known limits

1. **The Android client (M1-C) is a thin client and needs the LAN gate open.** `android/`
   builds a signed APK that pairs, lists characters, reads the same history, sends and streams
   (see `docs/ANDROID_THIN_CLIENT.md`). It cannot reach a loopback-bound Home Node, so LAN mode
   (§10) must be opted into on the desktop. No Capacitor/WebView shell, no camera, no FCM, no
   native notifications.
2. **`apiConfigs` authority is still the browser** (§8). This is the one temporary dependency,
   it is explicit, and an unpublished character is unusable from a phone with a clear error.
3. **Plain HTTP on LAN.** No TLS yet; the LAN opt-in is explicit and the identity layer is
   already token-based (§15).
4. **Event frames are ephemeral.** A client that misses them must resync. By design (§13.1).
5. **Turn buffers are bounded in memory.** A very long disconnect can produce `REPLAY_GAP`;
   the terminal state is always still obtainable.
6. **One in-flight turn per conversation.** A second concurrent `chat.send` for the same
   conversation gets `BUSY` rather than being queued.
7. **`file://` cannot reach the Home Node at all** (Chrome blocks `file://` → loopback at the
   network layer; M1-A §5.1). Desktop publishing therefore only happens on the normal launch
   path (`http://127.0.0.1:23120/InternalBeyond.html`).
8. **No multi-user model.** Devices belong to one Home Node owner; there are no accounts.
9. **The Bridge SSRF finding (audit R5) is still open** and untouched. No mobile client can
   reach it — the gateway does not proxy caller-supplied URLs and does not import Bridge routes.
10. **Group-chat execution** remains the browser's serial loop (M1-A §6.3); its storage is
    already canonical, so a future client reads one history.

---

## 17. Tests

| File | Group | Covers |
|---|---|---|
| `tests/test_mobile_device_registry.js` | static | 85 checks: issue/verify/rotate/revoke, revoked-immediate, per-device independence, restart persistence, token hashed-not-stored (DB + file grep), pairing single-use/TTL/atomic double-consume, `consumed_by` audit, capability allowlist, DTO/spec separation |
| `tests/test_mobile_gateway_http.js` | service | 65 checks: version matrix (missing/0/2/3/-1/1.5/'one'/null/true), error envelope shape and non-leakage, body validation and size cap, auth matrix, query-token rejection, CORS matrix incl. capacitor/null/hostile and preflight, 13 dangerous routes 404, secret-leak scan over 8 surfaces, revoke-immediate incl. self-revoke, rotation, two rate-limit families, and two real-process LAN assertions (refuse-to-start without device auth; unauthenticated rejection after LAN bind) |
| `tests/test_home_node_lan_gate.js` | service | 41 checks: the LAN gate itself, with every "remote" request sent to a **non-loopback** address so the source address is non-loopback too. Asserts LAN `pairing/complete` → 200 + device token, LAN `character.list` → 200 through that token, unauthenticated/forged-pairing rejection, revoke-immediate over LAN, the default posture (remote refused at socket level), auth-not-ready (`devices_schema` too new) ⇒ every remote request `403 loopback-only` while loopback keeps working, and 5 desktop paths + `/health` `403 remote-admin-disabled` when no desktop token is configured while a phone can still pair |
| `tests/test_mobile_thin_client.js` | service | 86 checks: the whole client journey — pair → authenticate → `character.list` → `chat.history` → `chat.send` → streaming deltas → disconnect mid-generation → reconnect/resume → `sync.changes` → retry → revoke — plus conversation isolation, DTO field checks, sequence monotonicity, and "disconnect does not cancel generation" via a slow mock provider |
| `tests/test_m1a_chat_authority_smoke.js` | browser | the M1-A desktop smoke extended with M1-B: real browser + real Home Node, real `apiConfigs` → publish → `GET /characters` (with `forTurn:true`), device pairing from the test, `character.list` over the authenticated mobile surface, secret-leak scan, anonymous rejection, and the preflight regression guard |

```
node tests/test_mobile_device_registry.js
node tests/test_mobile_gateway_http.js
node tests/test_home_node_lan_gate.js
node tests/test_mobile_thin_client.js
node tests/test_m1a_chat_authority_smoke.js --browser
```

---

## 18. Operational summary

```
start:      node services/home-node-service.js     (runner name "HomeNode", port 23118)
health:     GET  /health                            → {service:'internal-beyond-home-node', role:'canonical-chat-authority'}

# desktop (privileged)
pairing:    POST /pairing/session                   {deviceName, deviceType}
devices:    GET  /devices        revoke: POST /device/revoke {deviceId}
catalog:    GET  /characters     publish: POST /characters/publish {characters[], merge}
boundary:   GET  /security                          → exposes / doesNotExpose / deviceAuth / mobile verb allowlist

# mobile (device token)
pair:       POST /mobile/v1/pairing/complete        {v, payload:{pairingId, secret, deviceName, deviceType}}
identity:   GET  /mobile/v1/handshake   GET /mobile/v1/device/self
device:     POST /mobile/v1/device/rename  /device/token/rotate  /device/revoke
characters: GET  /mobile/v1/character/list   GET /mobile/v1/character/<id>
history:    GET  /mobile/v1/chat/history?conversationId=|characterId=
sync:       GET  /mobile/v1/sync/changes?cursor=
send:       POST /mobile/v1/chat/send  {v, requestId, payload:{characterId, content}}
stream:     GET  /mobile/v1/chat/stream/<turnId>?after=<seq>      (Last-Event-ID also honoured)
turn:       GET  /mobile/v1/turns/<turnId> | ?requestId=
events:     GET  /mobile/v1/events
presence:   GET  /mobile/v1/presence   POST /mobile/v1/presence/report {appForeground}

env:        IB_HOME_NODE_HOST (default 127.0.0.1)   IB_HOME_NODE_PORT (23118)
            IB_HOME_NODE_DATA_DIR                   IB_HOME_NODE_TOKEN (desktop/admin, optional)
            IB_HOME_NODE_ORIGINS                    IB_HOME_NODE_MOBILE_ORIGINS
            IB_HOME_NODE_TRACE=1 (one log line per inbound request: method/path/origin only)

LAN:        IB_HOME_NODE_HOST=0.0.0.0                 → opt-in LAN mode; pairing payload then
                                                       carries the real LAN address
            remoteClients in the 'listening' log line: 'refused (loopback bind)'
                                                       | 'device-token-required' | 'refused (<reason>)'
            remote non-mobile paths need IB_HOME_NODE_TOKEN; without it they are 403
            remote-admin-disabled. /mobile/v1/* needs only the device token.
```

Deferred, explicitly: QR rendering · native notifications · Voice · Video ·
Image generation · Moments · Diary · Letters · Memory authority migration · Tailscale/TLS ·
multi-user accounts.
