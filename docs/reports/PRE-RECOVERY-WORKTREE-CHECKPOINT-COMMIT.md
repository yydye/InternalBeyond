# PRE-RECOVERY WORKTREE CHECKPOINT — COMMIT

Generated: 2026-09-26  
Status: `PRE_RECOVERY_CHECKPOINT_COMMITTED`

## Result

A single pre-recovery source checkpoint was committed. This is **not** a Credential Bridge atomic commit and **not** a production apply — it is the current InternalBeyond recovery-engineering source state captured before any production apply. No push was performed.

| Item | Value |
|---|---|
| Commit | `85f91bef2f2417cf97917585904a696d58a9c511` |
| Parent | `e2d6e886fb1a1e27c5882236719f65c8dfd8e8e6` |
| Author / date | `yydye` · 2026-09-26 07:15:35 +0800 |
| Message | `chore: checkpoint recovery work before production apply` |
| Files changed | **373** |
| Insertions / deletions | **118,582** / **941** |
| Branch state | `master`, ahead of `origin/master` by 148 (not pushed) |
| Index after commit | empty |

## Step 1 — Drift re-check

Re-checked before staging: 79 modified / 284 untracked (collapsed), HEAD `e2d6e88…`. No unexplained new source or runtime mutation versus `docs/reports/PRE-RECOVERY-WORKTREE-CHECKPOINT-AUDIT.md`. The only new path since that audit was the audit report file itself, which is allowed.

## Step 3 — Minimal `.gitignore` hygiene

Four local, machine-only caches were confirmed **not** ignored and were added (committed in this checkpoint), no other rules touched:

```
.dsh-research/
.codegraph/
.ua/
.claude/
```

Already-adequate ignores confirmed unchanged: `src-tauri/target/`, `src-tauri/gen/`, `dist/`, `android/app/build/` (via `android/.gitignore`), `runtime/node/node.exe`. After the change, `git check-ignore` reports all four new entries as ignored (`.gitignore:71–74`).

## Step 4 — Explicit candidate staging

No `git add -A` / `git add .` was used. An explicit candidate file list was generated from `git status --porcelain=v1 -uall -z` and staged with `git add --pathspec-from-file=… --pathspec-file-nul`.

- Candidates staged: **373** = 79 tracked changes (incl. `.gitignore`) + 294 untracked source (source modules, tests, docs incl. the prior audit report, `Recovery.html`, `src-tauri/**` source/config).
- Explicitly excluded during candidate generation: **370** = `tmp/**` (367) + root evidence JSONs (3).
- Shared hunks were **not** split; the Credential Bridge and RecoveryOnly/R3 source were kept in the snapshot together.

## Step 5 — Staged secret / data gate

Checked staged content only:

| Gate | Result |
|---|---|
| Staged vault data file (`credential-vault.json` / `.key`) | **0** |
| Staged production DB / `*.db` / `*.sqlite*` | **0** |
| Staged `*-wal` / `*-shm` | **0** |
| Staged build output (`src-tauri/target`, `dist`, `android/**`, `tmp/**`, caches) | **0** |
| High-specificity secret-like hits (count/path/category only; no values emitted) | 15 files |

The 15 high-specificity staged hits are all non-credentials, by category:

| Category | Files |
|---|---|
| Test fixtures (JWT-like / bearer / sample values) | `tests/test_boot_state.js`, `tests/test_diagnostics.js`, `tests/test_diagnostics_smoke.js`, `tests/test_error_catalog.js`, `tests/test_mobile_thin_client.js`, `tests/test_installer.js`, `tests/test_p11_3c_supervisor.js`, `android/app/src/test/java/com/internalbeyond/mobile/SequenceAndOverlayTest.kt` |
| Scanner / redaction pattern definitions & fixtures | `scripts/capture-guide-shots.js`, `scripts/guide-fixtures.js`, `scripts/release-audit.js`, `tests/test_guide_shots.js`, `tools/release-builder/tests/test_release_builder_astages.js`, `tools/release-builder/tests/test_release_builder_plan.js` |
| This checkpoint's own audit doc (documents the pattern set) | `docs/reports/PRE-RECOVERY-WORKTREE-CHECKPOINT-AUDIT.md` |

14 of 15 are already at `HEAD`; the one new file is the audit doc containing pattern-name text (`sk-ant-`, `sk-or-v1-`) from its scan-method description. `docs/reports/CREDENTIAL-VAULT-RECOVERY-AUDIT.json` matched the `credential-vault` name filter but is a **read-only audit report** (`schema: internalbeyond.credential-vault-recovery-audit`, `auditMode: READ_ONLY`), not vault data.

## Step 6 — Staged validation

| Check | Result |
|---|---|
| `node --check` on all staged `.js` | **238 / 238 OK**, 0 FAIL |
| `node tests/test_credential_bridge_r1.js` | **`CREDENTIAL_BRIDGE_R1_SYNTHETIC_PASS`** (exit 0) |
| `cargo check --offline` (`src-tauri`) | **Finished** `dev` profile in 7.76s, exit 0 |

Not run (out of scope by instruction): full production test suite, provider calls, normal IB launch, installer build, first boot, `apiConfigs` apply, reconstruction.

## Step 7 — Commit

Executed only after the staged gate passed:

```
git commit -m "chore: checkpoint recovery work before production apply"
```

→ `85f91bef2f2417cf97917585904a696d58a9c511` (no push).

## Excluded artifact summary

| Excluded | Size / count | Where |
|---|---|---|
| `tmp/**` (P32-W5 R3 run scratch, Rust spawn-harness `target`, PNG evidence) | 367 files / 66.6 MB | untracked, excluded |
| Root recovery evidence JSONs | 3 files | untracked, excluded |
| `src-tauri/target/**` | 28,591 files / 17,972.4 MB | ignored |
| `dist/**` | 411 files / 484.0 MB | ignored |
| `android/app/build/**` | 1,431 files / 74.7 MB | ignored |
| `.dsh-research/**` | 452.1 MB | now ignored |
| `.codegraph/**`, `.ua/**`, `.claude/**`, `.dsh/**` | 495.9 / 54.9 / — / 11.4 MB | now ignored / ignored |
| `browser-data/**`, `.venv-vision/**` | 86.9 MB / 2,956.1 MB | ignored |
| vault data, production DB / WAL / SHM | none present in workspace | n/a |

Post-commit `git ls-files` confirms **0** tracked paths under `src-tauri/target`, `dist`, `android/`, `tmp`, or the local caches. The only tracked `credential-vault` paths are the source `active/credential-vault.js` (unchanged) and the read-only audit report JSON.

## Remaining unstaged / untracked categories

`git status --porcelain` = **4 entries**, all intentionally excluded:

```
?? deleted-backup-audit.json
?? hibit-identity-transition-report.json
?? role-metadata-continuity-report.json
?? tmp/
```

These are RecoveryOnly/R3 run evidence and scratch, deliberately kept out of the source checkpoint.

## Boundaries held

No `git push`; no Credential Rebind apply; no installer build; no install; no IB launch; no R3-C / R3-E; no first boot; no Active re-arm; no provider call. This checkpoint only establishes the reversible source boundary.

## Next step

The frozen Credential Rebind WriteSet (`INSERT=13`, `UPDATE=0`, `DELETE=0`, sha256 `71e4ded955b90823d4530f59c5c16827a4245ad5759b1b7bc6b9809f7896171b`) is now reversible against commit `85f91be`. Proceed only under a separate, explicit authorization.
