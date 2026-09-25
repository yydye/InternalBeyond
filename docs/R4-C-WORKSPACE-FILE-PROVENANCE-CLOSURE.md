# R4-C Workspace File Provenance Closure

## 1. State

R4-C State: PASS — WORKSPACE FILE PROVENANCE CLOSED

R4 Workspace File Provenance: CLOSED

R3 Media Attribution / Image Queue Scope: CLOSED

Deferred Semantic Debt:

- R3 — REMOVED
- R4 — REMOVED

P29: LOGICALLY FROZEN  
P30: LOGICALLY FROZEN  
DB_VER: 24

This was a closure audit only. No production file was modified during R4-C.

## 2. Scope

The audit re-attacked the original R4 display-label/canonical-identity defect and checked the frozen R4-1/R4-2 contract across:

- role, same-name role, reserved-label role, human, import, script, and tool-mediated paths;
- canonical-first archive collision routing;
- legacy and partial canonical records;
- IndexedDB persistence and browser reload;
- export/import and the existing local mirror;
- UI display compatibility;
- P29, P30, and R3 regressions;
- frozen boundaries and the narrow adjacent provenance-debt search.

The pre-existing dirty worktree was preserved. No reset, checkout, broad restore, clean, stash, stage, or commit was used.

## 3. Original Defect

Before R4, `projectFiles.lastModifiedBy` served both as a human-readable display label and as semantic routing input. A role named `User`, `你`, or `导入` could therefore be misclassified as a human or import source; same-name roles could also collapse into one apparent identity.

The frozen repair keeps `lastModifiedBy` as display data and moves routing authority to canonical provenance fields.

## 4. Frozen Contract

The persisted shape remains additive and flat:

    lastModifiedBy: string
    lastModifiedByKind?: role | user | import | script | system
    lastModifiedById?: string

Role provenance uses the existing `cfg.id` directly. No nickname reverse lookup is used. A valid role record requires a non-empty ID; valid non-role kinds have no ID. Legacy, unknown, partial, and invalid canonical records are not repaired from display labels and use conservative unique-path/no-overwrite behavior.

Canonical routing is:

    valid kind=user or kind=import -> protect old path
    valid kind=role/script/system -> do not protect from display-label collision
    absent or invalid canonical fields -> conservative unique-path routing

## 5. Static Canonical-First Audit

The production consumer in [workspace.js](../assets/js/workspace.js:27) validates canonical fields and [workspace.js](../assets/js/workspace.js:35) reads only canonical kind for archive collision routing. No production semantic comparison of `lastModifiedBy` to `User`, `你`, or `导入` remains.

The remaining `lastModifiedBy` uses are allowed by contract:

- writer-time display-label persistence in [files.js](../assets/js/workspace/files.js:84);
- canonical field carry-forward on copy in [files.js](../assets/js/workspace/files.js:1236);
- UI-only human-readable rendering in [files.js](../assets/js/workspace/files.js:1034);
- legacy/export/import/debug data pass-through.

The exact reserved-label search found only the UI display mapping and test fixtures/guards; no canonical-present routing path uses display-name fallback. The adjacent `modifiedBy`/`createdBy`/`author`/`owner` search found runtime author/actor metadata and tool feedback, but no second persisted `projectFiles` display-to-identity consumer.

## 6. Role "User" Reproduction

The real browser Workspace writer persisted the reserved-name role as:

    lastModifiedBy     = User
    lastModifiedByKind = role
    lastModifiedById   = r4-role-user

The archive route returned `false` for unique-path protection; the subsequent write stayed on the original path and remained `kind=role`. The role was not classified as human.

Result: original R4 reproduction is NOT REPRODUCIBLE.

## 7. Role "你" Reproduction

The real browser Workspace writer persisted:

    lastModifiedBy     = 你
    lastModifiedByKind = role
    lastModifiedById   = r4-role-you

Routing remained role routing, not human routing. The original R4 reproduction is NOT REPRODUCIBLE.

## 8. Role "导入" Reproduction

The real browser Workspace writer persisted:

    lastModifiedBy     = 导入
    lastModifiedByKind = role
    lastModifiedById   = r4-role-import

Routing remained role routing, not import routing. The original R4 reproduction is NOT REPRODUCIBLE.

## 9. Same-Name Reproduction

Roles `r4-role-a` and `r4-role-b` both used display name `X`. Both records displayed `X`, while their persisted canonical tuples were respectively `(role, r4-role-a)` and `(role, r4-role-b)`. The tuples remained distinct and routing did not merge them.

Result: PASS.

## 10. Human Control

The real human/manual writer persisted:

    lastModifiedBy     = User
    lastModifiedByKind = user
    lastModifiedById   = absent

Archive routing protected the original path and wrote the replacement to a unique path. The human case retained its intended behavior and was not weakened by the reserved-role fix.

Result: PASS.

## 11. Import Control

The real import writer persisted:

    lastModifiedBy     = 导入
    lastModifiedByKind = import
    lastModifiedById   = absent

Archive routing protected the imported path and used a unique path for the replacement.

Result: PASS.

## 12. Script / Tool Control

The real script writeback path persisted:

    lastModifiedBy     = 脚本
    lastModifiedByKind = script
    lastModifiedById   = absent

The script path does not fabricate a user or role ID. The audit found no independent tool-to-`projectFiles` writer. Tool execution continues to write runtime results only; a role-mediated file write retains the requesting role tuple.

Result: script PASS; tool boundary PASS.

## 13. Canonical Dominance

The hard probes passed for both collision forms:

- `lastModifiedBy=User`, `kind=role`, `id=role_x` remained role routing;
- `lastModifiedBy=导入`, `kind=role`, `id=role_y` remained role routing.

The canonical-mismatch probe also passed: a record displayed `User` while carrying a valid role tuple, and routing used the tuple without display fallback. After archive write, the new role tuple was persisted.

The R4-2 mutation evidence remains valid: replacing the canonical consumer with the old display-only predicate caused the focused suite to fail on reserved-role and canonical-dominance cases; the exact byte restore matched the pre-mutation SHA256:

    2BD3046384F3C56406CF5EF8532585820F61995F951D9C256DA6AD112B57A94E

No second mutation was performed during R4-C.

## 14. Legacy Compatibility

Records containing only `lastModifiedBy` remained readable without backfill or crash. Legacy `User`, `你`, and `导入` labels remained ambiguous and used conservative unique-path/no-overwrite routing. No canonical identity was fabricated from current role nicknames.

Result: PASS.

## 15. Partial Canonical Fields

The following all used frozen conservative behavior:

- role kind without ID;
- role kind with empty ID;
- non-role kind with an ID;
- invalid/unknown kind.

No fuzzy recovery or display-label fallback was introduced.

Result: PASS.

## 16. IndexedDB Persistence

Real browser/CDP evidence covered writer → `InternalBeyondDB.projectFiles` → read. Role, human, import, script, legacy, and invalid cases were inspected from IndexedDB. Canonical fields survived actual object-store persistence. `DB_VER` remained 24 in source and runtime; no migration, new store, index, or backfill was introduced.

Result: PASS.

## 17. Reload Semantic Verification

After a real browser reload, the canonical role display/ID fields were still present. An additional one-shot R4-C probe then called the real archive writer after reload with display label `User` and canonical provenance `{kind: 'role', id: 'r4-role-b'}`. The original path was reused, the record count stayed one, and the resulting record persisted the role tuple.

Result: PASS — reload preserves fields and canonical-first routing remains active after reload.

## 18. Export / Import

The existing whole-object export builder and import path preserved `lastModifiedBy`, `lastModifiedByKind`, and `lastModifiedById`. The round-trip record remained readable and semantically canonical. No serializer allowlist or vault/schema change was required.

Result: PASS.

## 19. Mirror / Home Node

The existing local mirror retained the canonical fields during the runtime probe. Home Node continues not to own, rewrite, or synchronize `projectFiles`; no Home Node provenance path was added.

Result: PASS.

## 20. UI Compatibility

The file UI continues to render the human-readable `lastModifiedBy` label, including role names and source labels. Canonical role IDs are not exposed in ordinary display metadata. The remaining `你` → `User` mapping is display-only and is not used by semantic routing.

Result: PASS.

## 21. Regression

The closure reran the required focused and directly related suites:

| Suite | Result |
|---|---:|
| `node tests/test_workspace_file_provenance.js` | 30/30 PASS |
| `node tests/test_workspace_actor_identity.js` | 50/50 PASS |
| `node tests/test_workspace_conversation_scope.js` | 30/30 PASS |
| `node tests/test_image_queue_scope.js` | 37/37 PASS |
| post-reload R4-C probe | 31/31 PASS |

The focused browser runs reported zero new TypeError, ReferenceError, or unhandled-rejection exceptions. Syntax checks for all R4 implementation files and the focused test passed. `git diff --check` reported no content errors; its output contained only existing line-ending warnings.

## 22. Browser / Runtime Evidence

The evidence used a real headless Chromium/CDP browser with an isolated temporary profile, real IndexedDB, real Workspace writers, real archive routing, real reload, real export/import, real local mirror, and UI rendering.

Dedicated manual computer-control interaction was not exposed in this turn, so no manual click evidence is claimed. This did not require deferral: the real browser/runtime gate passed, including the reserved-role and human control cases and the post-reload semantic routing probe.

## 23. Frozen Boundaries

R4-C did not modify production. The following remained outside the closure change surface:

- P23 delivery/message/voice contracts;
- P24 group identity, participation, targeting, and recent-speaker semantics;
- P29 production actor identity semantics;
- P30 conversation scope fields and consumers;
- R3 image attribution and queue semantics;
- `chatMessages.images`;
- IndexedDB store shape and `DB_VER`.

No Manager, Registry, Service, EventBus, conversation-scope field, or new global provenance authority was introduced. P29 and P30 related tests remained green; R3 remained green and CLOSED.

## 24. Remaining Debt Search

The narrow Workspace-adjacent search covered `lastModifiedBy`, `modifiedBy`, `createdBy`, `author`, and `owner` in Workspace, communication, and tool paths.

The only adjacent `author`/`actor` uses are runtime operation context, feedback, or tool-result metadata. They do not write or semantically classify `projectFiles` records. The only persisted file provenance consumer is canonical-first archive collision routing.

Result: no new R4 semantic blocker.

## 25. Closure Matrix

| Case | Before R4 | After R4 | Canonical Kind | Canonical ID | Routing |
|---|---|---|---|---|---|
| Role named User | wrong human classification | not reproducible | role | `r4-role-user` | role; no user protection |
| Role named 你 | wrong human classification | not reproducible | role | `r4-role-you` | role; no user protection |
| Role named 导入 | wrong import classification | not reproducible | role | `r4-role-import` | role; no import protection |
| Same-name Role A/B | ambiguous | distinguishable | role | `r4-role-a` / `r4-role-b` | tuple-separated |
| Real human | valid control | preserved | user | absent | protected; unique path |
| Real import | valid control | preserved | import | absent | protected; unique path |

## 26. Git / Worktree

The initial dirty worktree was recorded before the audit and preserved. Existing modifications and untracked artifacts from prior work were not reset, restored broadly, cleaned, or overwritten.

R4-C added only this closure document. The temporary reload probe was removed after it passed. No files were staged and no commit was created.

## 27. Required Final Answers

Q1. Role name=`User` 原始错误是否不可复现？是。  
Q2. Role name=`你` 原始错误是否不可复现？是。  
Q3. Role name=`导入` 原始错误是否不可复现？是。  
Q4. same-name roles 是否 semantic distinguishable？是。  
Q5. 真正 human writer 是否仍正确？是。  
Q6. 真正 import writer 是否仍正确？是。  
Q7. script writer 是否符合 contract？是。  
Q8. tool writer 是否符合 contract？是；当前无独立 persisted tool writer，role-mediated write 保持 requesting role provenance。  
Q9. canonical present 时是否完全禁止 display fallback？是。  
Q10. reserved label 是否只剩 display semantics？是；legacy label 仍按 frozen ambiguous policy 保守处理。  
Q11. legacy records 是否仍可读？是。  
Q12. legacy ambiguous label 是否没有被伪造 canonical identity？是。  
Q13. partial canonical provenance 是否按 contract 处理？是。  
Q14. canonical provenance 是否真实写入 IndexedDB？是。  
Q15. reload 后是否保留？是。  
Q16. reload 后 rename routing 是否仍 canonical-first？是。  
Q17. export/import 是否保留 canonical provenance？是。  
Q18. mirror/Home Node 是否保留？是；mirror 透传，Home Node 不接管。  
Q19. UI 是否仍显示 human-readable `lastModifiedBy`？是。  
Q20. 是否存在 semantic consumer 仍错误依赖 display label？否。  
Q21. R4-2 mutation gate evidence 是否有效？是。  
Q22. R4 focused regression 是否 green？是，30/30。  
Q23. P29 regression 是否 green？是，50/50。  
Q24. P30 regression 是否 green？是，30/30。  
Q25. R3 regression 是否 green？是，37/37。  
Q26. DB_VER 是否仍为 24？是。  
Q27. P29 是否保持 frozen？是，LOGICALLY FROZEN。  
Q28. P30 是否保持 frozen？是，LOGICALLY FROZEN。  
Q29. R3 是否保持 CLOSED？是。  
Q30. P23/P24 是否未重开？是。  
Q31. 是否存在新的 R4 semantic blocker？否。  
Q32. production 是否零 mutation？是，R4-C 期间为零。  
Q33. 是否 stage？否。  
Q34. 是否 commit？否。  
Q35. R4 是否可以 CLOSED？是。  
Q36. R3/R4 是否都可以从 deferred debt list 移除？是。  

## 28. Final State

R4-C State: PASS — WORKSPACE FILE PROVENANCE CLOSED

R4 Workspace File Provenance: CLOSED  
R3 Media Attribution / Image Queue Scope: CLOSED  
Deferred Semantic Debt: R3 — REMOVED; R4 — REMOVED  
P29: LOGICALLY FROZEN  
P30: LOGICALLY FROZEN  
DB_VER: 24

No new phase is opened. No production change, stage, or commit is performed after this closure artifact.
