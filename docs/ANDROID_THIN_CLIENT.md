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
cd android && ./gradlew test          # 105 tests, all green
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
| `HomeNodeIntegrationTest` | 14 | **the real Home Node**: pair → list → history → send → stream → disconnect → resume → sync → retry → presence → revoke |

`HomeNodeIntegrationTest` spawns `services/home-node-service.js` (temp data dir,
random port) and a real OpenAI-compatible SSE mock provider, then drives the same
`HomeNodeClient` / `SessionRepository` / `ConversationSession` the APK uses. It needs
Node on PATH and fails loudly without it — a silently skipped acceptance test would
be worse than none.

Two bugs the integration test caught that unit tests could not: the send body was
built from the *streamed buffer* instead of the user's text, and pairing left the
device's own record unset so a just-paired device reported an empty `deviceId`.

---

## 6. The LAN gate — found here, fixed in the Home Node

**This stage found the last thing that stopped a real phone; it was fixed separately, on the
desktop side, in D21.**

Measured here first, with the real service bound to the LAN
(`IB_HOME_NODE_HOST=0.0.0.0`, temp data dir, device registry open, `lan-bind-enabled` logged):

```
LAN /health                          → 403 {"ok":false,"error":"loopback-only"}
LAN /mobile/v1/character/list        → 403 {"ok":false,"error":"loopback-only"}
LAN /mobile/v1/pairing/complete      → 403 {"ok":false,"error":"loopback-only"}
loopback /mobile/v1/pairing/complete → 200 (a device token is issued)
```

`services/home-node/http.js` refuses every non-loopback request — before routing, so it covers
the whole mobile namespace — unless `deps.allowRemote` is set, and **nothing in
`services/home-node-service.js` ever set it**. That was an M1-A-era protection ("the Home Node
binds loopback") which M1-B's LAN-bind work did not relax.

**Now fixed** (decision D21, `tests/test_home_node_lan_gate.js`, 41 checks). `allowRemote` is
no longer a switch that can be flipped to `true`: it is a predicate re-evaluated per request —
*explicit non-loopback bind* **and** `deviceAuthReady(registry)`, the latter proven by a real
authentication round trip, not by a flag. And opening the gate does not hand over the desktop
surface: remote non-`/mobile/v1/*` paths require a **configured** Home Node token, so a default
install (no token) answers `403 remote-admin-disabled` there while the phone path keeps working.

Measured against the built APK's own payload, over a real LAN address:

```
LAN /mobile/v1/pairing/complete  → 200, device token issued
LAN /mobile/v1/character/list    → 200, the published character
LAN /mobile/v1/character/list    → 401 AUTH_REQUIRED     (no token)
LAN /mobile/v1/character/list    → 401 AUTH_INVALID      (forged token)
LAN /pairing/session             → 403 remote-admin-disabled  (no desktop token configured)
LAN /status                      → 403 remote-admin-disabled
loopback /health                 → 200 (unchanged for the desktop)
```

What this means for the client: the app needs **no** change. It talks `/mobile/v1/*` with a
device token, which is exactly the surface that opens. The `LOOPBACK_ONLY` mapping below stays
useful for installs that have *not* opted into LAN mode.

The app names the refusal explicitly: an `{"ok":false,"error":"loopback-only"}` answer is mapped
to `ProtocolError.LOOPBACK_ONLY` and presented as *"The Home Node only accepts connections from
the desktop … LAN access is not switched on"* with a desktop-action hint, instead of the vague
"unexpected answer" a strict v1 parser would otherwise produce.

---

## 7. Known limits (stated, not hidden)

1. **The Home Node must be started in LAN mode** (`IB_HOME_NODE_HOST=0.0.0.0`) before a phone
   can reach it at all — the default is loopback-only and stays that way. The gate itself is
   fixed (§6); the remaining requirement is an explicit desktop-side opt-in.
2. **QR scanning is not implemented.** Manual paste is the supported path. Since M1-C.1
   the button exists as a disabled 扫描二维码 with 即将加入 on it, because the brief for
   that stage asked for the affordance to be visible; it still does nothing.
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
8. **The app has now been run, but only on an emulator.** M1-C shipped without ever
   launching the APK; M1-C.1 changed that — an `android-34` AOSP x86_64 image was
   booted headless, the debug APK installed, and the app paired against a real Home
   Node over the LAN and driven through all four screens (§8.5). What is still
   untested: a physical device, a real touch/keyboard, Android's own IME in anger,
   screen sizes other than 1080×2400 @420dpi, and process death under memory pressure.
9. **`character.archived` never reaches the app.** Publishing an entry with
   `archived: true` results in `status: "active"` on the device. The cause is upstream
   and outside this stage: `assets/js/mobile-dto.js` `characterDto` reads `raw.archived`
   only, while the outbound path re-projects the *stored DTO* (which carries
   `status`, not `archived`) — the same two-level-fallback gap that `name` and
   `capabilities` are explicitly protected against in that file's own comments. The
   app's 已归档 mark is therefore correct code that cannot currently fire. Fixing it is
   a one-line change in that projection, deliberately **not** made here (M1-C.1 is a UI
   stage, and that file is shared with the Home Node).
10. **`verify()` never runs on a cold start.** `SessionRepository.verify()` — documented
    as the step that "confirms or corrects" the optimistic `Connected` restored by
    `boot()` — is called from the pairing path only. A restored session therefore keeps
    the stored node facts, and `NodeInfo.protocol` stays `0` until the device is paired
    again, which is why 开发者信息 shows 协议版本 `—` after a restart. Cosmetic here (any
    real request still corrects the connection state), but the comment and the code
    disagree, and that is worth knowing before the next stage builds on either.
11. **Cache ordering for same-millisecond messages** falls back to `(timestamp, id)`
    because `insert_seq` is not part of the mobile DTO. Sync is unaffected (it applies
    by id).

Deferred, explicitly: QR scan · native notifications · proactive background delivery ·
Voice · Video · Image generation · Moments · Diary · Letters · Memory UI · API/provider
settings · Tailscale · TLS · FCM.

---

## 8. M1-C.1 · Mobile UI foundation (2026-09-11)

M1-C produced something that worked and looked like a protocol tester: a Material 3
screen with a JSON textarea on it, an `F12` command, and English everywhere. M1-C.1
changed only the interface. No protocol, pairing, credential, chat, sync or recovery
behaviour was touched — the same `HomeNodeClient`, the same requestIds, the same
`ConversationSession`, the same cache.

### 8.1 What it looks like now

Four screens, one system:

| Screen | What it is |
|---|---|
| 配对 | A brand mark, a promise, and two ways to keep it. No address, no console command, no JSON on the surface. |
| 角色 | One glass panel of rows: 52dp portrait, the name in the product's serif face, one line of who they are. |
| 聊天 | The character's face and name in the header, serif speech over glass against accent-tinted user bubbles, a pill composer with a filled send control. |
| 设置 | 当前设备 / 已连接的电脑 / 断开连接 / 关于, then a collapsed 开发者信息 holding everything else. |

### 8.2 The token system

`ui/theme/` holds the whole visual vocabulary, and no screen writes a colour, a radius
or a type size of its own (`IbColors`, `IbSpacing`, `IbShapes`, `IbTypography`,
`IbTheme`). `ui/common/` holds the components (`IbPrimaryButton`, `IbSecondaryButton`,
`IbGlassCard`, `IbGlassPanel`, `IbTextField`, `IbTopBar`, `IbConnectionBadge`,
`IbEmptyState`, `IbAvatar`, `IbBackground`, `IbBridgeMark`, `IbDisclosure`, `IbDialog`,
`IbSheet`).

Three decisions are worth recording:

1. **The palette is the desktop's, read across.** `IbColors` is the dark half of
   `assets/css/core.css` — `--bg-deep`/`--bg-mid`, the `rgba(155,180,218,α)` glass
   family, `--accent`/`--accent-light`, the four `--status-*` hues — not a new palette.
   A companion app is the same room as the thing it accompanies. Two deliberate
   departures: the page ground is one step deeper than `--bg-deep` so glass has
   something to be translucent against, and the ambient indigo/violet wash exists only
   as light, never as the colour of a word or a control.
2. **Dark only, and no Material You.** `IbTheme` ignores the system light setting and
   the wallpaper palette. Wallpaper-derived colours are exactly what turns a product's
   palette into "a Material app that happens to be dark".
3. **Two families, and they mean something.** `FontFamily.Serif` (Noto Serif CJK, which
   Android ships — nothing is bundled into the APK) is the voice of the characters: the
   pairing promise, a character's name, the words in a bubble. `FontFamily.Default` is
   the voice of the app: buttons, status, settings, timestamps. Neither costs a byte.

### 8.3 The copy rule, and the test that enforces it

Requirement: a user must never meet the architecture. So `ui/IbStrings.kt` holds every
string the app says, split structurally:

* every value directly on `IbStrings` is user-facing and may not contain a developer
  term;
* `IbStrings.Dev` is the only place `Home Node`, `payload`, `JSON`, `HTTP`, `F12` and
  `IB_HOME_NODE_HOST` are allowed, and it is rendered only inside a collapsed
  disclosure labelled 开发者信息 or 开发帮助.

`IbCopyTest` walks both halves by reflection: it fails on a single leaked term in the
user-facing half, and it fails if the developer half has been emptied — because a guard
like this passes vacuously the moment the vocabulary is deleted rather than moved. It
also checks every `ErrorPresenter` branch, whose titles and bodies were the largest
single surface of English in the old build, and which now carry the protocol's own
words in a separate `technical` field shown only under 详细信息.

### 8.4 How a pairing payload is obtained

The desktop has no button for this yet; `IB.homeNode.pairing.create()` is a console
API. Rather than put an `F12` instruction on the first screen, it now lives in the
app's 开发帮助 disclosure, collapsed, inside 手动连接 — and the command is there
verbatim and copyable:

```js
JSON.stringify((await IB.homeNode.pairing.create({deviceName:'Android'})).payload)
```

That is the one place in the app allowed to speak developer, and it exists because
removing the instruction entirely would have made the app unusable rather than merely
plainer. When the desktop grows a real pairing entry point, this disclosure is what
should be deleted.

### 8.5 Evidence

* **109/109 unit tests green** (`:app:testDebugUnitTest`), `:app:assembleDebug` builds.
  Six assertions that pinned English copy moved to the equivalent Chinese wording with
  the same strength; one (`IB_HOME_NODE_HOST`) moved to where that fact now lives.
* **A real run, on a real Android system image, against a real Home Node.** An
  `android-34` AOSP x86_64 image was booted headless, the debug APK installed, and the
  app paired over the LAN to an `IB_HOME_NODE_HOST=0.0.0.0` Home Node (the M1-C LAN
  gate), with a four-character roster and a synthetic conversation published into — and
  read back out of — the canonical store. All four screens were driven with real taps
  located from the accessibility tree, and captured as PNGs.

  This is also what found the two defects in §7.9 and §7.10: neither is visible in a
  compile, and both surfaced within minutes of putting the interface on a screen.

* **The screenshots are not committed.** They live at
  `.dsh-research/m1c1-preview/` alongside this stage's other scratch artifacts — the
  same convention `MOBILE_HOME_NODE_AUDIT.md` uses for its working notes. Regenerating
  them means booting an emulator, starting the Home Node in LAN mode, and driving the
  four screens; the point-in-time images are reference, not a regression harness.
