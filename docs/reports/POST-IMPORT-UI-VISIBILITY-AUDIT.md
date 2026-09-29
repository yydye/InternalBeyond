# POST-IMPORT UI VISIBILITY AUDIT

Generated: 2026-09-26  
Status: `POST_IMPORT_UI_VISIBILITY_PASS`

## Result

The data was never lost. IndexedDB and Home Node both hold the records; the **runtime store never hydrated** because the module `db` was never assigned, so every `dbGet*` threw and the UI rendered 0. A one-line hydrate fix restores the reads. No data was imported, inserted, updated, or deleted; the Vault and Home Node were not modified; no Recovery/R3-C/C3.5 or character projection was touched.

## The four counts and the first NONZERO → ZERO

| Layer | messages | memory_records | moments | apiConfigs |
|---|---:|---:|---:|---:|
| **HOME_NODE_COUNT** | 345 | 4 | 155 | — |
| **INDEXEDDB_COUNT** (InternalBeyondDB v24, tauri.localhost) | 345 | 4 | 155 | 13 |
| **RUNTIME_STORE_COUNT** (before fix) | 0 | 0 | 0 | **0** |
| **UI_RENDER_COUNT** (before fix) | 0 | 0 | 0 | **0** (「还没有添加 API」) |

**First NONZERO → ZERO: the RUNTIME_STORE hydration layer.** `assets/js/core.js` opens the DB but never stores the handle: `openDB()` returns the DB and `ensureDB()` returns `_dbReadyP`, but the module variable `db` is **never assigned**. So `dbGetAll` / `dbGet` / `dbPut` do `db.transaction(...)` on `undefined` and throw `TypeError: Cannot read properties of undefined (reading 'transaction')`.

Observed live (read-only) before the fix:

- `window.IB.core.db` / `window.db` → `null`
- console: `Uncaught (in promise) TypeError: … at core.js:35:83 at dbGetAll`, `… at core.js:36:82 at dbGet …`
- `IndexedDB API config read failed; using local fallback TypeError: …`
- `[HomeNode] memory-sync-degraded / sync-fail / moments-sync-degraded` (same root)
- `apiConfigs.length === 0`, UI `共 0 条消息`, 「还没有添加 API」

The only `db` assignment in the file was the live accessor `ibCoreLive('db', ()=>db, v=>db=v)` — nothing ever called the setter.

## Audit answers (read-only)

- **WebView profile**: origin `http://tauri.localhost`, `InternalBeyondDB` v24, 33 stores — the **same** profile that held the 13 apiConfigs (the canonical Tauri host). Not a profile/origin mismatch.
- **IndexedDB actual counts**: `apiConfigs 13`, `chatMessages 345`, `memories 4`, `moments 155`.
- **UI data sources**: 角色库/API renders from the in-memory `apiConfigs` (`social.js:967`); chat records read `dbGetAll('chatMessages')` (`communication.js:6350`); Memory/Moments likewise read IndexedDB via `dbGet*`. All of them depend on the broken `db` handle.
- **Home Node live counts**: `messages 345`, `memory_records 4`, `moment_records 155` (unchanged).
- **Hydrate/sync chain**: Home Node → Web Core IndexedDB (present) → **runtime store (`db`) — broke here** → UI render.

## Minimal fix (hydrate)

`assets/js/core.js`:

```js
// before
async function ensureDB(){if(db)return db; … return _dbReadyP}
// after
async function ensureDB(){if(db)return db; … db=await _dbReadyP; return db}
```

`db` is now assigned the opened handle; every `dbGet*`/`dbPut` works. Applied to `assets/js/core.js`, synced to the embedded frontend (`.tauri-frontend`), the host rebuilt (`cargo build --release --features custom-protocol --locked`) and redeployed. No re-import; no Home Node/Vault writes.

## Verification (after fix)

| Check | Result |
|---|---|
| `window.db` | **open: InternalBeyondDB v24** |
| API configs (in-memory + list render) | **13 / 13 items** |
| memories read via `dbGetAll` | **4** |
| moments read via `dbGetAll` | **155** |
| historical chat for a role (byFriend) | **105 messages** |
| chat storage UI | **「345 条消息 · 12 张图片」** |
| 「还没有添加 API」 shown | **no** |
| runtime exceptions | **none** |
| Home Node (read-only re-check) | **messages 345 · memory_records 4 · moment_records 155** (unchanged) |

## Constraints honored

No historical data re-imported; no INSERT/UPDATE/DELETE; Home Node and Vault unmodified; no Recovery / R3-C / C3.5; no character projection. Only a hydrate/store-binding fix was made, plus the host rebuild to ship it. Runtime left stopped (0 processes); scratch removed.

## Final status

`POST_IMPORT_UI_VISIBILITY_PASS` — the imported history, Memory, Moments and the 13 API configs are visible in ordinary IB again, with Home Node counts unchanged at 345 / 4 / 155.
