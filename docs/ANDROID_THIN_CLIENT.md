# ANDROID_THIN_CLIENT — the first real Android InternalBeyond

**Stage:** M1-C · Android Shell + First Pairing
**Status:** landed. Companions: `MOBILE_HOME_NODE_AUDIT.md` (M0),
`docs/HOME_NODE_CHAT.md` (M1-A canonical chat authority),
`docs/MOBILE_GATEWAY.md` (M1-B device identity, pairing, protocol v1).

> Source beats prose. Every claim here is backed by a file or a test name, and the
> build instructions live in `android/README.md`.

The deliverable is `android/` — a standalone Gradle project that produces an
installable APK which pairs with the desktop Home Node over the LAN and then does
character list, canonical history, chat, live streaming and disconnect recovery.

---

## 1. What Android owns, and what it must never own

```
Desktop / Home Node   canonical chat · character runtime config · provider
                      credentials · generation · revision · idempotency ·
                      device registry
Android               UI · native capabilities · cache · drafts · device
                      credential · sync cursor
```

The second column is the whole of the client. Enforced structurally rather than by
discipline:

| Rule | How it is enforced |
|---|---|
| no provider call, ever | `data/api/HomeNodeClient.kt` is the only file that speaks HTTP; `chat.send` is the only generation path, and it goes to the Home Node |
| no provider credential | no DTO field exists to hold one (`domain/model/Models.kt`), and `Character DTO ≠ runtime config` is the Home Node's two-table split, not a client filter |
| no second canonical chat store | the cache holds server DTOs verbatim keyed by canonical id (`data/cache/CacheSchema.kt`); it is a copy and is treated as one |
| no second IBModelCore / Middle Brain | nothing in `android/` implements inference, context assembly or memory |
| no IP-based trust | `HomeNodeEndpoint` carries an address; identity is the device token (`data/auth/CredentialStore.kt`) |

The APK's permission surface is one entry: `INTERNET`.

---

## 2. Stack, and why

Kotlin · Jetpack Compose (Material 3) · OkHttp · platform SQLite · Android Keystore.
`android/app/build.gradle.kts` carries the full justification; the short version:

* **Native, not a WebView shell.** The AI runtime is on the Home Node, so the phone
  needs a protocol client, not a browser. Reusing the desktop HTML would drag in the
  world the desktop owns (IndexedDB chat authority, `apiConfigs`) that M1-A
  explicitly moved *off* the client.
* **One third-party runtime dependency (OkHttp).** SSE needs a request whose connect
  has a deadline while its read does not, plus cancellation of a blocked read from
  another thread; `HttpURLConnection` cannot express that without global state.
* **No Room/KSP.** Six small tables with hand-written upsert *and* delete semantics.
  A `SqlDatabase` seam (`data/cache/SqlDatabase.kt`) lets the real SQL run in JVM
  tests instead.
* **No navigation-compose.** Four screens and one precise back ladder; `app/BackStack.kt`
  is 40 lines and unit-tested.
* **No security-crypto.** Deprecated; Keystore AES/GCM is used directly.

---

## 3. The credential

```
AES-256-GCM(token JSON) → base64(iv ‖ ct) → SharedPreferences "ib_secure"
        key: AndroidKeyStore, alias ib.device.credential.v1, non-exportable
```

* the raw token is never written anywhere, in any form;
* `deviceId`, endpoint and fingerprint are stored **unencrypted** on purpose, so the
  app can say "Connected to &lt;node&gt;" and "your credential is unreadable, pair
  again" *before* it can open the Keystore;
* an unopenable blob is left in place and reported, never silently treated as "never
  paired" (`CredentialStorageTest`);
* `IbLog` redacts `ibd1_…`, `pair_…`, `sk-…`, `Bearer …` and long opaque runs before
  any sink sees them, and the integration test asserts no token, key, hidden prompt or
  message body appears in the captured log.

---

## 4. Protocol behaviour that M1-C had to get exactly right

| Rule | Where | Test |
|---|---|---|
| `v` is validated on the way in **and** out; `{"v":true}` refused | `data/api/Envelope.kt` | `ProtocolParsingTest` |
| the client never invents a canonical message id; optimistic state lives in a separate `SendAttempt` record | `domain/model/SendAttempt.kt`, `domain/AttemptOverlay.kt` | `SequenceAndOverlayTest` |
| the requestId is persisted **before** the request and reused by every delivery retry | `data/repository/ConversationSession.kt` | `ConversationRecoveryTest`, `HomeNodeIntegrationTest.a06` |
| a terminal frame ends the mandate: "send again" is a NEW requestId | same | `ConversationRecoveryTest` |
| `disconnect ≠ cancellation`: a lost stream becomes `RECOVERING`, never `FAILED`, then `turns.get` → resume → `sync.changes` | same | `ConversationRecoveryTest`, `a07` |
| duplicate frames are dropped, gaps reconnect from the last accepted sequence | `data/api/StreamEvents.kt` | `SequenceAndOverlayTest` |
| `REPLAY_GAP` means "resync from canonical state", not "your data is gone" | `ConversationSession` | `ConversationRecoveryTest` |
| cache is filled from the node and an empty catalog never wipes it | `data/repository/CharacterRepository.kt`, `LocalCache` | `CacheTest`, `a04` |
| `DEVICE_REVOKED` deletes the credential, tears down streams and returns to pairing | `data/repository/SessionRepository.kt` | `a12` |
| the UI says "LAN connection · not encrypted", never "secure" | `HomeNodeEndpoint.transportLabel` | `ProtocolParsingTest` |

---

## 5. Evidence

```
cd android && ./gradlew test          # 103 tests, all green
cd android && ./gradlew assembleDebug # app/build/outputs/apk/debug/app-debug.apk
```

| Suite | Tests | What it proves |
|---|---|---|
| `ProtocolParsingTest` | 31 | envelope/version/SSE/DTO/pairing/endpoint parsing, including rejections |
| `ErrorMappingTest` | 8 | every code maps to a distinct actionable presentation and the right action |
| `CredentialStorageTest` | 10 | sealing, no plaintext at rest, tamper/lost-key behaviour |
| `CacheTest` | 17 | real SQLite: upsert, delete + tombstone, cursor, attempts, durability across reopen |
| `SequenceAndOverlayTest` | 14 | dedupe/gap, overlay visibility, back ladder, log redaction |
| `ConversationRecoveryTest` | 11 | severed stream, frame gap, unknown turn, restart, revocation |
| `HomeNodeIntegrationTest` | 12 | **the real Home Node**: pair → list → history → send → stream → disconnect → resume → sync → retry → presence → revoke |

`HomeNodeIntegrationTest` spawns `services/home-node-service.js` (temp data dir,
random port) and a real OpenAI-compatible SSE mock provider, then drives the same
`HomeNodeClient` / `SessionRepository` / `ConversationSession` the APK uses. It needs
Node on PATH and fails loudly without it — a silently skipped acceptance test would
be worse than none.

Two bugs the integration test caught that unit tests could not: the send body was
built from the *streamed buffer* instead of the user's text, and pairing left the
device's own record unset so a just-paired device reported an empty `deviceId`.

---

## 6. The one thing that stops a real phone today

**A phone on the LAN cannot reach the Home Node at all — and that is a desktop-side
gate, not an Android bug.**

Measured, not inferred, with the real service bound to the LAN
(`IB_HOME_NODE_HOST=0.0.0.0`, temp data dir, device registry open, `lan-bind-enabled`
logged):

```
LAN /health                          → 403 {"ok":false,"error":"loopback-only"}
LAN /mobile/v1/character/list        → 403 {"ok":false,"error":"loopback-only"}
LAN /mobile/v1/pairing/complete      → 403 {"ok":false,"error":"loopback-only"}
loopback /mobile/v1/pairing/complete → 200 (a device token is issued)
```

`services/home-node/http.js:435` refuses every non-loopback request — before routing,
so it covers the whole mobile namespace — unless `deps.allowRemote` is set:

```js
if (!isLoopback(req) && !deps.allowRemote) { … 403 'loopback-only' … }
```

`isLoopback` accepts only `127.0.0.1`, `::1` and `::ffff:127.0.0.1`, and **nothing in
`services/home-node-service.js` ever sets `allowRemote`** — the seam exists, the switch
is never thrown. This is an M1-A-era protection ("the Home Node binds loopback") that
M1-B's LAN-bind work did not relax.

What already works once that gate is opened — verified in the same probe:

* binding to `0.0.0.0` is **permitted** now that the device registry exists (M1-B's
  refuse-to-start path is not triggered), and the service logs `lan-bind-enabled`;
* `POST /pairing/session` then reports the **real LAN address** in
  `endpoints.mobile.host` with `lanReachable:true`, so a phone needs no address
  override;
* pairing, the device token and the authenticated mobile surface all work;
* provider credentials and hidden prompts stay out of the responses, and the device
  token never reaches the service log.

**This stage did not flip that switch.** Opening the Home Node to the LAN is a
security-posture decision about the desktop side, it belongs to the Home Node rather
than to the Android client, and M1-B deliberately made LAN exposure opt-in. It is
recorded here as the single remaining blocker, with the exact line and the exact
mechanism, so the next stage can decide it on purpose.

The app now names it too: an `{"ok":false,"error":"loopback-only"}` answer is mapped to
`ProtocolError.LOOPBACK_ONLY` and presented as *"The Home Node only accepts connections
from the desktop … LAN access is not switched on"* with a desktop-action hint, instead
of the vague "unexpected answer" a strict v1 parser would otherwise produce.

---

## 7. Known limits (stated, not hidden)

1. **The LAN gate above** (§6) — the one thing that stops a real phone today.
2. **QR scanning is not implemented.** Manual paste is the supported path; a disabled
   "Scan QR" button was deliberately not added.
3. **Release builds cannot reach an arbitrary LAN IP.** Android's network security
   config accepts hostnames and IP *literals*, never ranges. The M1-C APK is the
   **debug** variant, whose policy explicitly permits trusted-LAN cleartext; the
   release variant denies cleartext except loopback/emulator/`.local`. Closing this
   needs TLS or a hostname — the deferred transport work.
4. **`apiConfigs` authority is still the browser** (M1-B §8.5). A character the
   desktop has never published is unusable from the phone, with a clear `CONFLICT`.
5. **Attachments are metadata only.** Images, files and voice render as placeholders;
   no upload, camera, file picker or voice input.
6. **No notifications, no background delivery.** Realtime notification is the
   `/mobile/v1/events` channel, which this stage does not subscribe to; durable
   recovery is `sync.changes`.
7. **A terminal turn error can leave a duplicate user message** if the failure
   happened after the Home Node stored it, because a real retry needs a new
   requestId. That is a consequence of the frozen protocol, not an oversight.
8. **No emulator run.** The APK compiles, is signed, and its packaged manifest and
   network policy were inspected; the app has not been launched on a device or
   emulator in this environment.
9. **Cache ordering for same-millisecond messages** falls back to `(timestamp, id)`
   because `insert_seq` is not part of the mobile DTO. Sync is unaffected (it applies
   by id).

Deferred, explicitly: QR scan · native notifications · proactive background delivery ·
Voice · Video · Image generation · Moments · Diary · Letters · Memory UI · API/provider
settings · Tailscale · TLS · FCM.
