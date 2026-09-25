# CREDENTIAL-BRIDGE-CLEAN-COMMIT-R1 Audit

Generated: 2026-09-26  
Status: `BLOCKED_COMMIT_BOUNDARY_UNRESOLVED`

## Scope and actions

This was a read-only worktree and dependency audit. No source file was changed, no path was staged, no commit was created, and no IB process, provider, Vault write, production storage, or Home Node operation was invoked. This report is the only file created by this audit.

## Worktree inventory

- Branch/HEAD: `master` / `e2d6e886fb1a1e27c5882236719f65c8dfd8e8e6`.
- Compact `git status --short`: 362 entries; the index is empty.
- Expanded status excluding ignored Rust `target/`: 2,159 paths before this report; this report adds one evidence path.
- `src-tauri/target/` exists locally with 28,591 files and 18,827,408,425 bytes. Git ignores it; it was not staged or force-added.
- `src-tauri/` has no tracked files at HEAD. The untracked native host source and crate setup form a new host project.

## File classification table

The path counts below use the expanded status inventory. Category A identifies candidate implementation paths, not a stageable commit. Some files contain mixed bridge and out-of-scope hunks.

| Category | Count / scope | Classification and representative paths |
|---|---:|---|
| A. Credential Bridge required | 10 candidate paths | `active/credential-resolver.js`, `active/credential-resolver-cli.js`, `assets/js/communication.js`, `assets/js/core.js`, `assets/js/host-capability.js`, `assets/js/image-router-config.js`, `assets/js/social.js`, `assets/js/workspace.js`, `src-tauri/src/lib.rs`, `tests/test_credential_bridge_r1.js`. The existing `active/credential-vault.js` is tracked and unchanged. |
| B. RecoveryOnly/R3, excluded | 84 paths, plus mixed hunks in `src-tauri/src/lib.rs` | `Recovery.html`, `assets/js/recovery*`, `assets/js/composite-recovery-plan.js`, `runtime/*`, `services/home-node/*`, `installer/*`, P32-W5 reports/docs/scripts/tests, and native host setup such as `src-tauri/Cargo.toml`, `Cargo.lock`, `build.rs`, `tauri.conf.json`, `capabilities/default.json`, `src/main.rs`, and `src/project_knowledge.rs`. |
| C. Generated/evidence artifacts, excluded | 378 status paths after adding this report, plus ignored `src-tauri/target/` | `tmp/**` reports/probes, `.codegraph/**`, `.ua/**`, generated audit JSONs, and `docs/reports/**`; Rust `target/` is the separate ignored 28,591-file tree above. |
| D. Unrelated worktree changes, excluded | 1,688 paths | Includes `.dsh-research/**` and unrelated P23–P31 feature, UI, runtime, service, installer, documentation, and test work. No such paths were staged. |

The categories are a path-family inventory; `src-tauri/src/lib.rs` is intentionally called out as mixed. Its credential command is at lines 4283–4378 and registration is at line 5254, while the same untracked 303 KB file contains the RecoveryOnly/R3 host implementation and other native behavior. `assets/js/host-capability.js` is also a new general host capability module with RecoveryOnly gating, not a credential-only file.

## Candidate boundary analysis

The ten Category A paths are the smallest apparent runtime/test path set. They do **not** form a safe commit by themselves:

1. `communication.js`, `core.js`, `social.js`, and `workspace.js` contain substantial unrelated edits mixed with Credential Bridge hunks. Current whole-file diffs are respectively 1,751, 128, 532, and 264 changed lines. Whole-file staging would violate the exclusion requirement; partial-hunk staging does not solve the native dependency.
2. The native binding exists only inside the untracked `src-tauri/src/lib.rs`. HEAD has no Tauri crate baseline. Building the binding from a clean checkout therefore requires adding the new crate setup and host entry files; the current host includes RecoveryOnly/R3 implementation, which this boundary explicitly excludes.
3. `host-capability.js` is an untracked shared host capability layer, not a standalone credential-only module. Committing it wholesale also carries unrelated host and RecoveryOnly integration.
4. Extracting a new recovery-independent native crate/module and rewriting its integration would be implementation work, not read-only scope reconciliation. No such split was attempted.

Thus no complete, independently buildable Credential Bridge checkpoint can be identified without either including excluded host functionality or changing code to create a new boundary. Neither is allowed in this phase.

## Excluded artifacts and unrelated files

- No `src-tauri/target/**` files, build outputs, release payloads, installer files, or generated recovery reports are candidate commit content.
- All RecoveryOnly/R3 code, C3 reconstruction code, Home Node code, and recovery lifecycle material remain excluded.
- Credential authority adapter/status-only files (`active/credential-authority-adapter*.js`, `assets/js/credential-authority-consumers.js`) are adjacent untracked work, not required by the request-scoped Web Core resolver path, and are excluded from this minimum candidate.
- Unrelated P23–P31 work and research files remain untouched.

## Tests

- No tests, syntax checks, or Cargo commands were run in this audit because no checkpoint was formed; the requested validation is conditional on a formed boundary.
- The prior R1 plan records `test_credential_bridge_r1.js` synthetic PASS, Node syntax PASS, and `cargo check` PASS. Those are prior results and were not re-run here.
- No installer build was run.

## Remaining blockers and gate

- Credential Bridge hunks are mixed with unrelated edits in shared files.
- The required native binding has no tracked, recovery-free crate boundary in HEAD.
- The recorded lifecycle state remains `FIRST_BOOT_PENDING`; first-boot consumption belongs to R3-E Controlled First Start. No launch or lifecycle mutation occurred in this audit.

Final gate: **`BLOCKED_COMMIT_BOUNDARY_UNRESOLVED`**. No commit was made. Do not apply apiConfigs or start IB from this audit result.
