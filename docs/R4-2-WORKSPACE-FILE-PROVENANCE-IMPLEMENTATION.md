# R4-2 Workspace File Provenance Implementation

## 1. State

R4-2 State: PASS — IMPLEMENTED / READY FOR CLOSURE

R4-1 frozen contract was implemented without changing the contract. DB_VER remains 24. No commit was created.

## 2. Frozen Contract Used

Implementation authority:

- docs/R4-0-WORKSPACE-FILE-PROVENANCE-AUDIT.md
- docs/R4-1-WORKSPACE-FILE-PROVENANCE-CONTRACT.md

Frozen Option B was used:

- lastModifiedBy remains the human-readable display string.
- lastModifiedByKind is the canonical source kind.
- lastModifiedById is the canonical ID and is meaningful for role today.
- kinds are role, user, import, script, and system.
- role ID is taken directly from cfg.id; nickname lookup is never used.

## 3. Modified Files

Production implementation:

- assets/js/workspace/files.js
- assets/js/workspace/preview.js
- assets/js/workspace/run.js
- assets/js/workspace.js
- assets/js/communication.js

Tests and registration:

- tests/test_workspace_file_provenance.js
- tests/test_workspace_actor_identity.js
- tests/test-all.js

The communication change is limited to passing already-known cfg.id context into the existing file-block writer. No new communication authority was introduced.

## 4. Producer Changes

The existing wsSaveFile and wsEditFileContent boundaries now accept optional frozen provenance context. The writer always preserves a string lastModifiedBy and clears invalid or absent canonical fields instead of inferring identity.

Updated producers:

- AI ws_create/ws_edit and rich/generated-file paths pass role provenance.
- AI file blocks pass role provenance through all existing response paths.
- preview manual save writes kind=user.
- uploaded human files write kind=user.
- ICode import writes kind=import.
- script writeback writes kind=script.
- copy carries lastModifiedByKind and lastModifiedById.
- move keeps the existing whole record and therefore keeps provenance.

No direct persisted tool writer was found or added.

## 5. Canonical Provenance Shape

Persisted records use:

    lastModifiedBy: string
    lastModifiedByKind: optional string
    lastModifiedById: optional string

A valid role record requires a non-empty string ID. Valid non-role kinds have no ID. Invalid, partial, unknown, or extra-ID shapes are not repaired or upgraded from display labels.

## 6. Role Writer

AI role writers receive role provenance directly from the existing cfg object:

    lastModifiedBy = cfg.nickname or existing display author
    lastModifiedByKind = role
    lastModifiedById = cfg.id

Same-name roles therefore persist the same display label with different canonical IDs. No display-name-to-ID reverse lookup exists.

## 7. Human Writer

Manual preview save and uploaded human files persist:

    lastModifiedBy = User
    lastModifiedByKind = user

No human ID is fabricated from the User or 你 strings.

## 8. Import Writer

ICode import persists:

    lastModifiedBy = 导入
    lastModifiedByKind = import

Import provenance is supplied by the import producer, not inferred from the 导入 label.

## 9. Script Writer

Script writeback persists:

    lastModifiedBy = 脚本
    lastModifiedByKind = script

lastModifiedById remains absent. This stays true for both AI-triggered and UI-triggered execution.

## 10. Tool Writer

R4-0 found no direct tool-to-projectFiles writer. assets/js/site-operations.js continues to write runtime tool results only.

The implementation does not add a tool kind, manager, registry, or alternate projectFiles writer. If a future tool write is mediated by a role, the existing role writer context remains the owner.

## 11. Rename Routing Fix

The existing archive collision consumer is now canonical-first:

- valid kind=user or kind=import: protect the old path and use a unique path;
- valid kind=role, kind=script, or kind=system: do not protect based on display labels;
- absent or invalid canonical fields: treat as legacy unknown and use conservative unique-path avoidance.

No canonical mismatch falls back to lastModifiedBy.

## 12. Legacy Behavior

Legacy records remain readable with their original display label. They are not migrated, backfilled, or reverse-resolved against current role nicknames.

Legacy User, 你, and 导入 labels remain ambiguous and use conservative no-overwrite routing.

## 13. Reserved-Label Collision

Role names User, 你, and 导入 persist kind=role with the actual role ID. They remain visible under their real nickname but are never classified as human or import by archive routing.

The mutation gate demonstrated that replacing the canonical consumer with the old display-only predicate makes these cases fail.

## 14. Persistence / Reload

Real browser tests verified:

    writer -> IndexedDB projectFiles -> browser reload -> canonical fields remain

The test also covered overwrite, role changes, legacy records, invalid fields, and UI rendering after persistence.

## 15. Export / Import

Existing whole-object export/import was retained. The real browser test used the existing export builder and import path and verified that lastModifiedByKind and lastModifiedById survive the round trip.

No serializer allowlist change was necessary.

## 16. Mirror / Home Node

No mirror or Home Node production change was necessary. The real browser test verified that the existing emergency localStorage mirror retains the canonical fields.

Home Node continues not to own or synchronize projectFiles.

## 17. DB Decision

DB_VER remains 24.

There is no new object store, index, schema migration, store rebuild, or legacy backfill.

## 18. Focused Tests

R4-2 focused test:

    node tests/test_workspace_file_provenance.js

Result: 30 checks passed, including same-name roles, reserved labels, human/import/script writers, legacy and partial canonical behavior, IndexedDB persistence, reload, export/import, mirror, UI display, DB_VER, and console exception gate.

The test is registered in the browser group of tests/test-all.js.

## 19. Mutation Test

Mutation target: assets/js/workspace.js semantic archive routing consumer.

Procedure:

1. Byte backup created and SHA256 recorded.
2. Canonical routing was temporarily replaced with display-only User/你/导入 routing.
3. R4 focused tests were run.
4. Expected failure occurred with exit code 1: reserved-role routing and canonical collision assertions failed.
5. Original bytes were restored from the backup.
6. Restored SHA256 equaled the pre-mutation SHA256 and the backup SHA256:

    2BD3046384F3C56406CF5EF8532585820F61995F951D9C256DA6AD112B57A94E

No git restore, checkout, reset, or clean was used.

## 20. Related Regression

All required related suites passed:

- P29 Workspace Actor Identity: 50 checks passed.
- P30 Workspace Conversation Scope: 30 checks passed.
- R3 Image Queue Scope: 37 checks passed.

The P29 test-only static expectation for the obsolete R4-0 display-label guard was updated to assert the R4 canonical-first guard. P29 actor runtime behavior remains unchanged and green.

## 21. Runtime / Browser Verification

The R4 test used a real headless Chrome, an isolated temporary profile, real IndexedDB, real Workspace writers, real archive routing, real reload, real export/import, and real mirror storage.

No new TypeError, ReferenceError, or unhandled runtime exception was observed. REAL_BROWSER_GATE_DEFERRED_BY_TOOLING was not needed.

## 22. Frozen Boundary Verification

Not changed by this implementation:

- P23 delivery/message/voice contracts
- P24 group identity, participation, and targeting contracts
- P29 production actor identity semantics
- P30 conversation scope fields or consumers
- R3 image queue and media attribution semantics
- chatMessages.images
- projectFiles DB schema

No conversation scope, message ID, run ID, or new provenance manager/registry/service was introduced.

## 23. Git / Worktree

No files were staged and no commit was created. The pre-existing dirty worktree was preserved.

The implementation stayed within the R4-1 surface, with communication.js used only to pass existing role context to the existing file-block writer. git diff --check reported no content errors; its output contained only the repository's existing LF-to-CRLF warnings.

## 24. Required Final Answers

Q1. 是。lastModifiedBy 仍是 string display label。

Q2. 是。lastModifiedByKind 已实现并由现有 writer producer-time 写入。

Q3. 是。lastModifiedById 已实现；当前用于 role 的 cfg.id。

Q4. 是。Role writer 在 producer-time 直接写 canonical identity。

Q5. 是。human writer 不依赖字符串推断。

Q6. 是。import writer 不依赖 导入 字符串推断。

Q7. 是。script writer 按 frozen contract 写 kind=script 且不伪造 ID。

Q8. 是。当前无 direct persisted tool writer；role-mediated write 保持 requesting role provenance，不改成 generic Tool。

Q9. 是。same-name roles 通过 lastModifiedById 区分。

Q10. 是。role name=User 不会被误认成 human。

Q11. 是。role name=你 不会被误认成 human。

Q12. 是。role name=导入 不会被误认成 import。

Q13. 是。rename routing 是 canonical-first。

Q14. 否。canonical present 时不存在 display fallback。

Q15. 是。legacy records 仍可读。

Q16. 是。legacy ambiguous labels 没有被伪造为 canonical identity。

Q17. partial/invalid canonical fields 不做 fuzzy repair，按 unknown 进入 conservative unique-path routing。

Q18. 是。provenance 已真实持久化到 IndexedDB projectFiles。

Q19. 是。reload 后保留。

Q20. 是。export/import 保持 canonical fields。

Q21. 是。mirror 保持；Home Node 继续不接管 projectFiles。

Q22. 是。UI 仍显示 lastModifiedBy label。

Q23. 否。未修改 projectFiles DB schema。

Q24. 是。DB_VER 仍为 24。

Q25. 是。mutation 成功杀死错误的 display-only routing implementation。

Q26. 是。mutation restore SHA256 与原始及 backup 一致。

Q27. 是。R4 focused tests 全绿，30 项通过。

Q28. 是。P29 regression 全绿，50 项通过。

Q29. 是。P30 regression 全绿，30 项通过。

Q30. 是。R3 regression 全绿，37 项通过。

Q31. 否。没有新的 semantic consumer 继续直接依赖 display label；label 仅用于 UI、writer display 与 legacy compatibility。

Q32. 否。未修改 P23/P24/P29/P30/R3 production contract；仅更新了 P29 regression 中已过时的 R4-0 静态 expectation。

Q33. 否。未创建 Manager、Registry 或 Service。

Q34. 否。不存在 implementation blocker。

Q35. 是。R4 已 READY FOR CLOSURE。

## 25. Final State

R4-2 State: PASS — IMPLEMENTED / READY FOR CLOSURE

下一阶段只能进入 R4-C · Workspace File Provenance Closure。

STOP。
