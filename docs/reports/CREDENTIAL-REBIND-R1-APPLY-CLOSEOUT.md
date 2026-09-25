# CREDENTIAL-REBIND-R1 APPLY & RECOVERY CLOSEOUT

Generated: 2026-09-26  
Status: `BLOCKED_PREAPPLY_WORKTREE_SCOPE_AND_FIRST_BOOT_GATE`

## Result

The request-scoped Credential Bridge remains validated for the 13 frozen historical configuration IDs. This closeout did not reach apply. No commit, production write, build, deployment, normal runtime launch, or provider request was performed in this turn.

The supplied apply authorization does not resolve the repository scope conflict: the credential bridge is interleaved with unrelated uncommitted changes, and its native Tauri integration depends on an entirely untracked host crate that includes RecoveryOnly/R3 implementation. A commit containing that crate and whole edited files would include out-of-scope changes; a credential-only commit would omit required native integration and would not be a complete buildable checkpoint.

The requested normal-runtime smoke also crosses a recorded first-boot lifecycle gate. The frozen R3-C authority matrix records `FIRST_BOOT_PENDING`, with first-boot consumption owned by `R3-E Controlled First Start`. This task excludes R3 reconstruction and does not authorize lifecycle-marker consumption. Ordinary IB was not started.

## Phase 1: Commit checkpoint

- HEAD: `e2d6e886fb1a1e27c5882236719f65c8dfd8e8e6` on `master`.
- Worktree status: 362 status entries (79 modified, 283 untracked); the index is empty.
- `src-tauri` has zero tracked files. Its untracked source includes the native host and RecoveryOnly/R3 lifecycle code; generated `target` build artifacts are also present.
- Bridge-edited frontend files contain mixed unrelated diffs. For example, current diffs are 1,751 lines in `communication.js`, 128 in `core.js`, 532 in `social.js`, and 264 in `workspace.js`.
- No paths were staged and no commit was created. The requested commit message was not used.

## Phase 2: Apply preflight evidence

| Check | Evidence | Result |
|---|---|---|
| Vault data file | `%LOCALAPPDATA%/InternalBeyond/credential-vault.json`, 4,166 bytes, SHA-256 `d82ace3b74a967df570da88521d9563662cc36177224b52fdd728d6225d09bc5`; matches the frozen Vault audit | Match |
| Vault key file | `%LOCALAPPDATA%/InternalBeyond/credential-vault.key`, 44 bytes, SHA-256 `15f0466a01d6edfc1a41c53d25d6f98aa169bf90711e48f965cb9eff713a5c5e`; matches the frozen Vault audit | Match |
| Historical source | `D:\新建文件夹 (3)\IB_backup_2026-09-03.json`, 44,861,782 bytes, SHA-256 `37f45afe4c4477931dd475ec8be3816e75133bc361a6b471b088be7d70ed198d` | Matches frozen source binding |
| Frozen write set | `INSERT=13`, `UPDATE=0`, `DELETE=0`; SHA-256 `71e4ded955b90823d4530f59c5c16827a4245ad5759b1b7bc6b9809f7896171b` | Matches R1 plan |
| Target `apiConfigs` | Latest recorded offline readback is count `0` in the R1 plan/current Vault audit. It was not freshly re-read for apply in this turn, so this check is not marked revalidated. | Not revalidated |
| Active runtime | Read-only process query found no matching InternalBeyond Host, Home Node, or product runtime process. | No matching process observed |
| Provider activity | No provider request was made in this turn. The frozen R1 in-memory dry-run records 13 resolver successes, 13 request builds, and zero provider calls. | `0` in this turn / prior dry-run |

No row was inserted. Vault files and Home Node were not modified. No secret, token, `apiKey`, or `imageGenApiKey` was written to storage.

## Phase 3: Canonical build

Not started. The focused commit checkpoint was blocked; no canonical installer was built, audited, or deployed.

## Phase 4: Runtime smoke

Not started. No ordinary IB Host was launched, no role was selected, and no test message was sent. The recorded `FIRST_BOOT_PENDING` state remains a separate lifecycle gate; its authority matrix assigns consumption to R3-E Controlled First Start.

## Counts and write boundary

- Before apply: latest recorded `apiConfigs` count `0`; fresh apply-time target verification not performed.
- Planned: 13 inserts, 0 updates, 0 deletes.
- Actual this turn: 0 inserts, 0 updates, 0 deletes.
- Secret projection/persistence: 0 in the frozen R1 dry-run; 0 writes this turn.
- Provider calls this turn: 0.
- Vault mutations: 0.
- Home Node, messages, memories, and moments mutations: 0.

## Remaining work

1. Establish a clean, reviewable commit boundary containing the complete Credential Bridge native integration without unrelated RecoveryOnly/R3 host code or generated artifacts.
2. After that checkpoint, freshly verify the canonical profile's `apiConfigs` count and other apply preconditions before considering the frozen 13-row insert set.
3. Resolve the recorded first-boot lifecycle gate through its owning controlled phase before any normal-runtime smoke that could consume lifecycle state.
4. Then perform the explicitly authorized rebind, canonical build, and runtime smoke, stopping on any failed gate.

No R3 reconstruction, Home Node restore, Active re-arm, migration, approval/checkpoint system, commit, or push was performed.
