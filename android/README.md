# InternalBeyond · Android thin client (M1-C)

The first real InternalBeyond on Android. It is a **thin client**: it owns the UI,
the device credential, a cache, drafts and a sync cursor — and nothing else.

```
Desktop / Home Node  =  canonical chat authority, character runtime config,
                       provider credentials, generation, revision, idempotency,
                       device registry
Android              =  UI, local cache, credential, sync cursor, drafts
```

What this app deliberately does **not** contain, and must never grow: a provider
API call, a provider API key, a second implementation of `IBModelCore` or Middle
Brain, a second canonical chat database, an API-settings screen, Moments, Diary,
Letters, Voice, Video, image generation, notifications or FCM. If a future stage
adds one of those, it needs its own decision record — not a quiet commit here.

The wire contract it speaks is frozen in `docs/MOBILE_GATEWAY.md` (protocol v1).

---

## Build

```bash
cd android
./gradlew assembleDebug          # → app/build/outputs/apk/debug/app-debug.apk
./gradlew test                   # JVM unit + integration tests
```

Requirements:

| Tool | Version used | Notes |
|---|---|---|
| JDK | 17 (Temurin 17.0.20.1 verified) | `JAVA_HOME` must point at it |
| Android SDK | platform **android-35** + build-tools **35.0.0** | `sdk.dir` in `local.properties`, or `ANDROID_HOME` |
| Gradle | 8.10.2 (via the wrapper) | |
| Node.js | any recent LTS | **only** for the integration test, which drives the real Home Node |

`local.properties` is machine-local and git-ignored. Android Studio writes it for
you; otherwise:

```properties
sdk.dir=/path/to/Android/Sdk
```

### Repository note for this machine

`settings.gradle.kts` lists Chinese mirrors (Aliyun for Maven/Google Maven)
**before** `google()` and `mavenCentral()`, because on the network this project is
developed on `dl.google.com` is unreachable and `repo1.maven.org` runs at about
100 KB/s — a clean build would take hours. The mirrors serve the same artifacts,
and resolution falls through to the official repositories if a mirror is
unavailable. Delete the mirror lines if your network reaches the originals.

The same applies to the Gradle wrapper: `gradle-wrapper.properties` points at a
mirror distribution URL. Replace it with
`https://services.gradle.org/distributions/gradle-8.10.2-bin.zip` if you prefer.

---

## Dependencies

One non-AndroidX runtime dependency, and three test-only ones. Each is a decision,
not a default:

| Dependency | Why | Where |
|---|---|---|
| `com.squareup.okhttp3:okhttp` | SSE needs a request whose connect has a timeout while its read does not, plus cancellation of a blocked read from another thread. `HttpURLConnection` cannot express that without global system properties. | APK |
| `org.json` | Ships inside the Android platform → zero APK bytes. Hand-written parsing is also what the protocol's strict `v` validation needs. | APK (platform) |
| `com.squareup.okhttp3:mockwebserver` | Test-only HTTP server for scripted streams, throttling and disconnects. | tests |
| `org.xerial:sqlite-jdbc` | Lets the real cache SQL run in JVM tests. | tests |
| `org.json:json` | Shadows the `android.jar` stub so production parsers can be unit-tested. | tests |

**Not used, deliberately:** Room/KSP (the cache is six small tables with
hand-written upsert *and* delete semantics; see `CacheSchema`), navigation-compose
(four screens and one precise back ladder — `BackStack` is 40 lines and unit-tested),
security-crypto (deprecated; the Keystore is used directly).

---

## Where the device credential lives

The token is an opaque `ibd1_…` string issued once at pairing. It is stored as:

```
AES-256-GCM( token JSON )  →  base64(iv ‖ ciphertext)  →  SharedPreferences "ib_secure"
        ▲
        └── key lives in the Android KeyStore (alias ib.device.credential.v1),
            non-exportable, hardware-backed where available, randomized IV required
```

* the raw token is never written anywhere, in any form;
* `deviceId`, endpoint and node fingerprint are stored **unencrypted** on purpose —
  the app must be able to say "Connected to <node>" and "your credential is
  unreadable, pair again" *before* it can open the Keystore;
* if the key is gone, the stored blob is left in place and reported as unreadable,
  rather than the app pretending it was never paired;
* nothing in this app logs the token, and `IbLog` redacts anything credential-shaped
  before it reaches a log sink — including in debug builds;
* `allowBackup="false"` plus both extraction-rule files keep app data out of cloud
  backup and device transfer.

---

## Network security (cleartext on a trusted LAN)

The Home Node currently speaks plain HTTP on the LAN, and the app says so: the
Settings screen shows **"LAN connection · not encrypted"** and never the words
*secure* or *encrypted* (Phase 27).

| Build | Policy |
|---|---|
| `debug` (the M1-C deliverable) | `cleartextTrafficPermitted="true"` in `src/debug/res/xml/network_security_config.xml` — an explicit, debug-scoped trusted-LAN development policy |
| `release` | `cleartextTrafficPermitted="false"`, with cleartext allowed only for loopback, `10.0.2.2` (emulator) and `*.local` |

**Limitation, recorded rather than hidden:** Android's network security config can
list a hostname or an IP *literal*, never an address **range**, so an arbitrary
`192.168.x.x` cannot be allowlisted statically in the release build. That is why the
M1-C APK is the debug variant, and why a release build reaching an arbitrary LAN
address needs TLS or a hostname — which is the deferred transport work
(`docs/MOBILE_GATEWAY.md` §15). Identity does not depend on this: the device token
is the identity, an IP address is not, and nothing in this app treats an address as
trust.

---

## Tests

```bash
./gradlew test
```

| Suite | Covers |
|---|---|
| `ProtocolParsingTest` | envelope and `v` validation, SSE framing (split chunks, CRLF, comments, flush), stream event decoding, pairing payload shapes and rejections, endpoint overrides, DTO round-trips and whitelists |
| `ErrorMappingTest` | every protocol code → a distinct, actionable presentation; actions (re-pair vs retry vs desktop action); transport classification |
| `CredentialStorageTest` | seal/open, per-seal IV, tamper and truncation refusal, **no plaintext token at rest**, lost-key behaviour |
| `CacheTest` | real SQLite: character replacement and the empty-answer refusal, message upsert and ordering, deletes + tombstones, sync state, attempts, drafts, durability across reopen |
| `SequenceAndOverlayTest` | duplicate/gap detection, resume adoption, optimistic-overlay visibility, the back ladder, log redaction |
| `ConversationRecoveryTest` | against a scripted fake: severed stream → `RECOVERING` (never `FAILED`) → resume; frame gap → reconnect from the last sequence; `NOT_FOUND` → re-send the **same** requestId; restart recovery; `DEVICE_REVOKED` |
| `HomeNodeIntegrationTest` | against the **real** Home Node: pair → character.list → chat.history → chat.send → streaming → disconnect mid-generation → resume → sync.changes → retry same requestId → presence → revoke |

`HomeNodeIntegrationTest` spawns `services/home-node-service.js` and therefore needs
Node.js. It fails loudly if Node is missing rather than skipping.

---

## Layout

```
android/app/src/main/java/com/internalbeyond/mobile/
├─ app/          IbApplication, MainActivity, AppGraph, BackStack, Route
├─ data/
│  ├─ api/       HomeNodeClient (the ONLY place that speaks HTTP), envelope,
│  │             SSE parser, stream events, DTO codec, pairing payload, endpoint
│  ├─ auth/      Keystore-backed credential store, session record, KeyValueStore
│  ├─ cache/     SqlDatabase seam, schema, LocalCache (SQLite)
│  ├─ repository/ SessionRepository, CharacterRepository, ConversationSession
│  └─ sync/      SyncEngine
├─ domain/       models, ProtocolError, ErrorPresenter, AttemptOverlay
├─ platform/     IbLog (redacting), StreamRegistry, IdGen
└─ ui/           pairing, character, chat, settings, theme, common
```

Only `HomeNodeClient` builds a URL or a JSON envelope. Only `SessionRepository`
touches the credential. The UI holds no authoritative state — everything it shows
comes from the cache, which is filled from the Home Node.
