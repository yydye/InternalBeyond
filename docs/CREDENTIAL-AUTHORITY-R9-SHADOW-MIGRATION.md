# Credential Authority R9 Shadow Migration

日期：2026-09-22（Asia/Shanghai）

R0-R8：immutable baseline  
R9：staging-only shadow migration

R9 建立了一个 test-owned migration transaction layer。它只在系统临时目录写 metadata-only staging state，不写生产 Vault、IndexedDB、localStorage、Bridge、Home Node 或角色数据。

## A. Migration model

R9 的目标是让 legacy source 和 credentialRef candidate 在 staging 中双存在：

    legacy source
      +
    credentialRef candidate
      +
    credentialStatus
      +
    rollback pointer

Shadow migration 不改变现有 runtime authority，也不删除 legacy field。

Candidate binding 的 metadata shape：

- bindingId。
- apiConfigId。
- authorityScope。
- credentialStatus。
- credentialPolicy。
- sourceClass。
- legacyPresence boolean。
- credentialRefCandidate。
- mappingDecision。
- conflictState。

R9 不保存：

- raw key。
- raw fingerprint。
- secret payload。
- ciphertext。
- Authorization/Bearer。

## B. Snapshot design

每次 staging prepare 生成 metadata-only snapshot：

- schemaVersion。
- transactionClass。
- transactionId。
- rollbackPointer。
- sourceMode。
- candidates。

每个 candidate 只保存：

- binding metadata。
- authority scope。
- mapping decision。
- credential status。
- legacy presence boolean。
- opaque credentialRef candidate。
- conflict state。

snapshot 不包含：

- legacy apiKey value。
- Vault record。
- fingerprint。
- provider token。
- encryption key。

R9 snapshot 是 staging transaction artifact，不是 persisted v2 credentialRef schema。

## C. Rollback design

Transaction states：

1. prepare：只生成 snapshot 和 shadow-before metadata。
2. dry-run：只输出 aggregate，不写 consumer state。
3. commit：必须提供明确的 synthetic staging approval token。
4. shadow commit：只写 temporary staging state，legacy marker 保留。
5. rollback：用 shadow-before metadata 恢复 staging state。
6. cleanup：删除 temporary staging root。

验证结果：

- 没有 approval token 的 commit 被拒绝。
- 有 explicit staging approval 的 commit 成功。
- legacy source marker 与 credentialRef candidate 同时存在。
- rollback restored = true。
- production writes = 0。

## D. Consumer migration matrix

| Consumer | Real/current metadata refs | Staging candidates | Shadow action | Ownership |
|---|---:|---:|---|---|
| apiConfigs | 0 current profile records | 21 Active-bound metadata candidates | add candidate ref beside legacy marker in staging only | Desktop Local |
| Active Message | 22 live bindings | 22 | ready refs for 21, none for char_bgai | Desktop Local |
| Middle Brain | 0 current profile target records | 0 real candidates | keep legacy config; no ref write | separate policy, future Desktop secret plane |
| Image Router | 0 current profile route refs | 0 real candidates | keep route metadata; no ref write | wrapper-only |
| Voice/Bridge/Home Node | separate authorities | 0 | no migration | KEEP_SEPARATE |

Voice、Bridge、Home Node 不进入 R9 shadow migration。

## E. Shadow result

R9 metadata-only dry-run：

| Result | Count |
|---|---:|
| Candidate bindings | 22 |
| Resolved | 22 |
| Unresolved | 0 |
| New conflict | 0 |
| Credential-required ready bindings | 21 |
| No-credential-required bindings | 1 |

Legacy read result：

- current Active metadata 只检查 legacy field presence，不读取 legacy value。
- 21 个 credential-required live bindings 使用 authority status/compatibility ref。
- char_bgai 保持 none。
- legacy source 与 shadow credentialRef 在 staging 中共存。

CredentialRef read result：

- 21 个 required candidates → ready。
- 1 个 loopback/test candidate → none。
- missing required → 0。
- unresolved → 0。

R2 的 12 个 historical alternate conflicts 已经完成 provenance resolution，不在 R9 重新选择，因此新 conflict count 为 0。

## F. Safety checks

R9 transaction layer：

- 只存在于 tests/credential-shadow-migration.js。
- staging root 使用系统临时目录。
- snapshot/shadow state 只含 metadata。
- commit 需要 explicit synthetic approval。
- rollback 在 staging 内验证。
- 不调用 provider/model。
- 不调用 Vault writer。
- 不执行 recovery import。
- 不执行 API Config/IndexedDB/localStorage migration。

R9 test output 不包含：

- raw key。
- raw fingerprint。
- key prefix/suffix。
- decrypted record。
- Authorization/Bearer。

## G. Production invariance

R9 前后以下 production artifacts 保持 hash/size/mtime unchanged：

- credential-vault.json。
- credential-vault.key。
- apiConfigs_recovery_import.json。
- active-message-service.json。
- Bridge config。
- Home Node credential。

R9 production invariance：

- production credential writes：0。
- production business-data writes：0。
- IndexedDB writes：0。
- localStorage writes：0。
- Bridge/Home Node writes：0。
- provider calls：0。

没有删除 apiKey、旧 Vault、recovery artifact 或 emergency mirror。

## Closure Gate

R9 shadow migration preparation complete.

- transaction layer created。
- dry-run first：PASS。
- explicit commit step：PASS。
- rollback available and verified：PASS。
- legacy + credentialRef coexistence：PASS。
- candidate bindings：22。
- resolved：22。
- unresolved：0。
- conflict：0。
- production writes：0。
- provider calls：0。

R10 requires explicit approval and has not started.
