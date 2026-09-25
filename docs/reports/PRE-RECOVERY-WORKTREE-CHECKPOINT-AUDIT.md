# PRE-RECOVERY WORKTREE CHECKPOINT AUDIT

Generated: 2026-09-26  
Status: `READY_FOR_PRE_RECOVERY_CHECKPOINT`

## Scope and actions

This was a **read-only** worktree classification. No `git reset`, `git clean`, `git add`, commit, or push was performed; the index was not touched. No `apiConfigs` apply, no IB launch, no provider request, no Vault write, and no production-storage access occurred. No secret value was read, printed, or written. The only file created by this audit is this report.

Purpose: establish the source-state boundary for a **pre-recovery checkpoint** so the upcoming credential rebind / recovery run is reversible. This audit does **not** split or re-scope the Credential Bridge commit (see [Relation to prior audits](#relation-to-prior-audits)).

## Baseline

| Item | Value |
|---|---|
| Branch / HEAD | `master` / `e2d6e886fb1a1e27c5882236719f65c8dfd8e8e6` |
| Upstream | `origin/master`, ahead by 147 |
| `git status --porcelain` | **363 entries** = 79 modified + 284 untracked (collapsed) |
| Index | empty (no staged paths) |
| Expanded (`-uall`) | 2,161 entries; untracked expanded = 2,082 |
| Untracked source (excl. caches/tmp) | **296 files** |
| Tracked diff | 79 files, `7909 insertions(+)`, `941 deletions(-)` |
| Recorded rebind WriteSet | `INSERT=13 UPDATE=0 DELETE=0`, sha256 `71e4ded955b90823d4530f59c5c16827a4245ad5759b1b7bc6b9809f7896171b` (present in `docs/reports/CREDENTIAL-REBIND-R1-PLAN.json` at lines 1063/1130) |

## 1. File classification (A–F)

Counts use the collapsed status inventory (363) unless marked "expanded". B and C are ownership subsets of A source.

### A. Current source (candidate checkpoint content)

| Scope | Count | Representative paths |
|---|---:|---|
| Modified tracked files | 79 | `assets/js/*` (30), `tests/*` (17), `services/*` (8), `docs/*` (6), `active/*` (4), `runtime/*` (4), `bridge/*` (3), `scripts/*` (2), `installer/*` (2), `apps/ib-app-cinema.js`, `InternalBeyond.html`, `.gitignore` |
| New source modules | expanded: 47 `assets/**` + 14 `services/**` + 4 `active/**` + 2 `scripts/**` + 1 `runtime/**` + 1 `bridge/**` | P23–P31 cores: `agent-orchestration-core.js`, `autonomy-core.js`, `delivery-runtime.js`, `domain-event-core.js`, `feedback-core.js`, `group-runtime-core.js`, `session-core.js`, `wake-runtime-core.js`, `moments-semantic-core.js`, `tauri-window-chrome.js`, `webcore-db-schema.js`, `bridge/voicebox.js`, `services/project-knowledge.js`, `assets/css/core/middle-brain-direct.css` |
| New tests | expanded: 115 | `tests/test_activation_*`, `tests/test_agent_orchestration_*`, `tests/test_group_*`, `tests/test_p2x_*`, `tests/test_voice_*`, `tests/test_workspace_*` |
| New docs | expanded: 99 | `docs/P23*`–`docs/P31*`, `docs/P32-*`, `docs/R3-*`, `docs/R4-*`, `docs/Mobile Master Roadmap v1.md`, `docs/incidents/`, `docs/reports/` |

Note: several modified shared files (`communication.js`, `core.js`, `social.js`, `workspace.js`, `host-capability.js`) contain **mixed** Credential-Bridge hunks interleaved with unrelated feature diffs. This audit does not separate them.

### B. Credential Bridge (subset of A)

| Scope | Paths |
|---|---|
| Resolver / authority (untracked) | `active/credential-resolver.js`, `active/credential-resolver-cli.js`, `active/credential-authority-adapter.js`, `active/credential-authority-adapter-cli.js`, `assets/js/credential-authority-consumers.js`, `assets/js/secret-routes.js`, `assets/js/host-capability.js` |
| Request-path edits (modified, **mixed**) | `assets/js/communication.js`, `assets/js/core.js`, `assets/js/social.js`, `assets/js/workspace.js`, `assets/js/image-router-config.js` |
| Native integration (untracked, **mixed**) | `src-tauri/src/lib.rs` (credential command ~L4283–4378, registration ~L5254, inside a 303 KB host file) |
| Unchanged vault (tracked) | `active/credential-vault.js` |
| Tests | `tests/test_credential_bridge_r1.js`, `tests/credential-shadow-migration.js`, `tests/test_credential_authority_r4..r9_*.js`, `tests/test_r10_1_active_metadata_transaction.js`, `tests/test_secret_routes*.js` (5) |
| Docs / reports | `docs/CREDENTIAL-AUTHORITY-*.md` (11), `docs/CREDENTIAL-RECOVERY-R0-AUDIT.md`, `docs/reports/CREDENTIAL-{BRIDGE-CLEAN-COMMIT-AUDIT.md,REBIND-R1-*,VAULT-RECOVERY-AUDIT.json}` |

### C. RecoveryOnly / R3 (subset of A)

| Scope | Paths |
|---|---|
| Recovery UI / engine | `Recovery.html`, `assets/js/recovery-{apply-executor,c3-5-reconstruction,engine,first-boot,production-adapter,shell,source-manifest,ui,webcore-adapter}.js`, `assets/js/composite-recovery-plan.js` |
| Home Node reconstruction | `services/home-node/{character-projection-store,composite-reconstruction-approval,composite-reconstruction-executor,production-reconstruction-adapter,reconstruction-runner}.js`, `services/home-node/reconstruction-contracts/`, `services/home-node/c35 child boundary probe 子进程.js` |
| Native host | `src-tauri/**` (`Cargo.toml`, `Cargo.lock`, `build.rs`, `tauri.conf.json`, `capabilities/default.json`, `src/main.rs`, `src/lib.rs`, `src/project_knowledge.rs`, `icons/`) |
| Runtime / scripts | `runtime/host-origin.js`, `scripts/p32-w5-p5_8_6-preview-gate.js`, `scripts/stage-tauri-host.ps1`, `installer/*` (modified) |
| Tests | `tests/test_p32_*`, `tests/test_recovery_*`, `tests/p32-w4*.js`, `tests/p32-w5*.js`, `tests/fixtures/recovery-adapter-browser.*` |
| Docs | `docs/P32-*`, `docs/R3-*`, `docs/R4-*`, `docs/incidents/`, `docs/reports/` |
| Root evidence JSON | `deleted-backup-audit.json`, `hibit-identity-transition-report.json`, `role-metadata-continuity-report.json` |
| Run evidence | `tmp/p32-w5-r3a/`, `tmp/p32-w5-r3b/`, `tmp/p32-w5r-recovery/` |

### D. Build artifacts (exclude)

| Path | Size | Ignored? |
|---|---|---|
| `src-tauri/target/` | 28,591 files / 17,972.4 MB | yes (`.gitignore:67`) |
| `src-tauri/gen/` | 4 files / 0.3 MB | yes (`.gitignore:68`) |
| `dist/` | 411 files / 484.0 MB | yes (`.gitignore:31`) |
| `android/app/build/` | 1,431 files / 74.7 MB | yes (`android/.gitignore`) |
| `tmp/p32-w5-r3b/c3_5_h_native_spawn_harness/target/` | Rust build output | **no** (inside `tmp/`) |
| `runtime/node/node.exe` | bundled binary | yes (`.gitignore:47`) |

### E. Temporary files (exclude)

| Path | Size | Note |
|---|---|---|
| `tmp/**` | 367 files / 66.6 MB | P32-W5 R3 run scratch: reports, `*.png`, probe JS, Rust spawn harness |
| Root loose audit JSONs | 3 files (16.6 / 15.5 / 64.6 KB) | also classified C; evidence, not source |
| `.yanagent/tmp/**` | this audit's scratch | deleted at end of run |

### F. Secrets / runtime data (exclude)

| Item | Result |
|---|---|
| `credential-vault.json` / `credential-vault.key` | **Absent from workspace** (`active/credential-vault.js` resolves `dataDir` at runtime; prior audit locates them at `%LOCALAPPDATA%/InternalBeyond/`) → cannot enter checkpoint |
| Production DB / `*.wal` / `*.shm` | none in source tree |
| Machine-local caches | `.codegraph/codegraph.db` (496 MB), `.ua/knowledge-graph.json` (55 MB), `.dsh/index.sqlite`, `.dsh-research/**/*.db`, `browser-data/*.db` |
| Tool-cache dirs | `.dsh-research/` (452 MB, 1,414 files), `.codegraph/`, `.ua/`, `.claude/`, `.dsh/` |

**Hazard:** `.dsh-research/`, `.ua/`, `.claude/`, `.codegraph/` (except its own `.gitignore`) and `tmp/` are **not** covered by root `.gitignore`. A blind `git add -A` would stage ~500+ MB of machine-local cache and build output.

## 2. Committable scope (checkpoint boundary)

The checkpoint is a **single source-state snapshot**: the entire current source tree, with credential-bridge and RecoveryOnly/R3 source included as they exist (no split, no re-scoping). Stage by **explicit path**, never `git add -A` / `git add .`.

**Include allowlist** (tracked-modified + untracked source):

```
.gitignore  InternalBeyond.html
active/**  apps/**  assets/**  bridge/**  installer/**  runtime/**
scripts/**  services/**  tests/**  docs/**  tools/**
src-tauri/Cargo.toml  src-tauri/Cargo.lock  src-tauri/build.rs
src-tauri/tauri.conf.json  src-tauri/capabilities/**  src-tauri/icons/**
src-tauri/src/**  Recovery.html
```

Root loose JSONs (`deleted-backup-audit.json`, `hibit-identity-transition-report.json`, `role-metadata-continuity-report.json`) are RecoveryOnly/R3 evidence; include **only** if the checkpoint is meant to carry R3 evidence — otherwise relocate to `docs/reports/` or leave out.

## 3. Excluded scope

```
src-tauri/target/**  src-tauri/gen/**  **/target/**
dist/**  android/app/build/**  android/build/**  android/.gradle/**
tmp/**  .yanagent/**
runtime/node/node.exe
.dsh-research/**  .dsh/**  .codegraph/**  .ua/**  .claude/**
browser-data/**  .venv-vision/**  .playwright-mcp/**
**/*.db  **/*.sqlite  **/*.sqlite3  **/*.wal  **/*.shm
credential-vault.json  credential-vault.key
docs/*.results.json
**/*.exe  **/*.dll  **/*.pdb  **/*.rlib  **/*.rmeta  **/*.o  **/*.node
```

## 4. Secret scan (counts only — no matched value emitted)

Method: high-specificity regex set (`openai sk-`, `sk-ant-`, `sk-or-v1-`, Google `AIza…`, GitHub `gh[pousr]_…`, Slack `xox…`, AWS `AKIA…`, PEM `BEGIN … PRIVATE KEY`, JWT-like, `Bearer <token>`). Values were never printed or persisted.

| Scope | Files scanned | Files with hits |
|---|---:|---:|
| Tracked (`git grep`) | 888 | 13 |
| Untracked candidate source | 996 | 0 (all hits resolve to already-tracked test/tool files) |
| `tmp/**` text evidence | 90 | 0 |
| `docs/**` text | 223 | 0 |

Interpretation:
- All 13 tracked hits are **test fixtures or scanner-pattern definitions**, not live credentials. 5 of them (`scripts/capture-guide-shots.js`, `scripts/guide-fixtures.js`, `scripts/release-audit.js`, `tests/test_guide_shots.js`, `tools/release-builder/.../test_release_builder_plan.js`) self-match because they *define* these detection patterns; the remainder are in `tests/*` fixtures.
- **No untracked source file introduces a high-specificity secret pattern.**
- Per policy, no value-level review of matched strings was performed. These 13 files are already tracked (already in history), so they do not change the checkpoint's secret exposure.
- Vault files are absent from the workspace and therefore out of checkpoint scope.

## 5. Test status

| Check | Result |
|---|---|
| Test runner manifest | none (`package.json` absent); tests run directly via `node` |
| Node runtime | `v24.18.0` |
| `node --check` on 19 candidate files (vault, resolver, authority, `secret-routes`, bridge-edited `communication/core/workspace/social/image-router-config`, `host-capability`, `voicebox`, `host-origin`, `project-knowledge`, `desktop-credential`, bridge/secret tests) | **19 OK / 0 FAIL** |
| `node tests/test_credential_bridge_r1.js` | **`CREDENTIAL_BRIDGE_R1_SYNTHETIC_PASS`** (exit 0) — synthetic-only; no Vault/provider/storage |
| Full suite (`tests/test-all.js`) | **not run** — would launch services and could cross the first-boot lifecycle gate / make provider calls; out of scope for this read-only checkpoint audit |
| R3 / R4 reconstruction tests | not run (recovery not in scope) |
| Build / installer / Cargo | not run |

## 6. Checkpoint preconditions

1. Stage by explicit allowlist (§2); verify with `git status --short` that no `src-tauri/target`, `dist`, `tmp`, `.dsh-research`, `.codegraph`, `.ua`, `*.db`, or `credential-vault.*` path is staged.
2. Confirm the index contains only §2 paths before commit.
3. Do **not** split the Credential Bridge out of the checkpoint in this step (per instruction).
4. Keep `credential-vault.json` / `credential-vault.key` and all runtime data outside the checkpoint.
5. After the checkpoint exists, the credential rebind (`INSERT=13`, sha256 `71e4ded9…`) becomes reversible.

## Relation to prior audits

`docs/reports/CREDENTIAL-BRIDGE-CLEAN-COMMIT-AUDIT.md` and `docs/reports/CREDENTIAL-REBIND-R1-APPLY-CLOSEOUT.md` both reached `BLOCKED_*` because a **credential-only** commit could not be cleanly isolated from RecoveryOnly/R3 and generated artifacts. This audit's objective is different and complementary: it defines a **whole-source pre-recovery checkpoint**, so the bridge is intentionally kept inside the snapshot rather than split. The prior `BLOCKED` verdicts on a *narrow* commit are unchanged and not re-litigated here.

## Final gate

**`READY_FOR_PRE_RECOVERY_CHECKPOINT`** — the source boundary is classifiable, no secret is present in the candidate set, all build/temp/cache hazards are excluded by explicit path, and the Credential Bridge synthetic contract test passes. Blocking risk is limited to `git add` discipline (must be explicit-path, never `-A`). No commit, push, apply, IB launch, or provider call was performed.
