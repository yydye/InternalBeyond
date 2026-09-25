# Credential Authority R5 Local Adapter

日期：2026-09-22（Asia/Shanghai）

R0：forensic complete  
R1：authority mapping complete  
R2：PASS  
R3：Credential Authority v2 design complete  
R4：PASS / synthetic validation  
R5：PASS

R5 建立了一个 Desktop Local Credential Authority 的 read-only compatibility adapter，并在 authority 内读取真实 Active Vault，只输出 secret-free status projection。没有调用 provider、没有修改生产数据、没有修改 Active execution path，也没有把真实 Vault 接入 Frontend。

新增文件：

- active/credential-authority-adapter.js
- tests/test_credential_authority_r5_adapter.js
- docs/CREDENTIAL-AUTHORITY-R5-LOCAL-ADAPTER.md

## A. Scope

本阶段完成：

- 审计 credential-vault.js 的加载、解密、has/get/write/migration 行为。
- 建立薄的 Desktop Local read-only compatibility adapter。
- 在 authority boundary 内使用真实 Vault 的 has() 生成 secret-free status。
- 读取当前 Active metadata，验证 R2 的 22 live role refs、21 credential-required refs 和 char_bgai 语义。
- 验证 unknown binding、缺失 authority material、malformed request、bounded batch 等错误路径。
- 验证 projection、serialization、error、telemetry 和报告中不出现 secret payload。

本阶段未做：

- 没有调用 credentialVault.get()。
- 没有调用 upsert、save、remove、migrateFromState 或任何 writer。
- 没有新增 HTTP/IPC status endpoint。
- 没有修改 renderApiList、editApi、saveCurrentApi、Active runtime、Bridge、Home Node、IndexedDB、localStorage 或 apiSettings。
- 没有进行 provider/model validation。

## B. Pre-flight

R5 开始时：

- Branch：master，ahead 147。
- HEAD：e2d6e886fb1a1e27c5882236719f65c8dfd8e8e6。
- 工作区已有大量 tracked modifications 和 untracked files；本阶段没有 reset、clean、restore、checkout、stash、commit 或 push。
- R0、R1、R2、R3、R4 文档作为 immutable baseline 读取。

## C. Vault API Audit

### C1. Constructor and load

active/credential-vault.js:17-23 创建 Vault factory，文件路径为：

- credential-vault.key
- credential-vault.json

ensureKey() 在 active/credential-vault.js:24-43 有一个重要行为：

- key 文件存在且 Base64 解码为 32 bytes：只读返回 key。
- key 文件缺失、损坏或长度不正确：生成新 key 并写入 key 文件。

load() 在 active/credential-vault.js:60-67 读取并解密 data file；解密失败时将内存 vault 置为空对象。

因此不能无条件调用现有 load() 作为 read-only probe。R5 adapter 先在 authority 内检查：

1. key 文件存在且是 regular file。
2. data 文件存在且是 regular file。
3. key 的结构长度为 32 bytes。
4. data envelope 具有 v、iv、tag、data。

任一前置条件失败时，adapter 返回 unavailable/unknown，不调用可能生成 key 的 loader 路径。

### C2. has()

active/credential-vault.js:100-104 的 has(characterId)：

- 只读取已经加载到内存的 vault。
- 返回 boolean。
- 不调用 save()。
- 不调用 migration。
- 不更新 updatedAt。
- 不修改文件或 mtime。
- 不返回 secret。

结论：has() 本身是 read-only primitive，可以安全用于 adapter；安全前提是 adapter 先阻断 missing/invalid key path，不能让 ensureKey() 走生成分支。

### C3. get() and writers

active/credential-vault.js:95-99 的 get() 会返回 provider、apiKey、endpoint、model。R5 adapter 没有调用它。

以下路径均未被 adapter 调用：

- get()
- all()
- upsert()
- save()
- remove()
- migrateFromState()

### C4. Migration behavior

active/credential-vault.js:114-137 的 migrateFromState() 可能读取 legacy character.apiKey 并调用 upsert。R5 adapter 不装配 state、不调用 migration，也不接入 Active service startup。

## D. Read-Only Safety

R5 adapter 的安全策略：

- 只在 authority 内加载真实 Vault。
- 只用 has() 判断 binding presence。
- secretPresent 只输出 boolean。
- credentialRef 是不透明 compatibility alias，不是 key/fingerprint。
- 不输出 provider/model/endpoint，因为当前 adapter 不调用 get()。
- capability 不伪造；当前 Vault v1 没有 capability metadata。
- adapter 不被 Active service 自动加载，不改变现有 execution path。

真实 Vault read-only 测试前后结果：

| Artifact | Hash/stat unchanged |
|---|---|
| credential-vault.json | true |
| credential-vault.key | true |
| apiConfigs_recovery_import.json | true |
| active-message-service.json | true |
| Bridge config.json | true |
| Home Node desktop-credential.json | true |

R5 production safety：

- Production credential writes：0。
- Production business-data writes：0。
- Provider calls：0。
- Real plaintext secret output：0。
- Real fingerprint output：0。
- Real decrypted credential JSON output：0。

## E. Adapter Design

文件：active/credential-authority-adapter.js

核心接口：

    getCredentialStatus({
      bindingId,
      capability?,
      credentialPolicy?,
      endpointClass?
    })

批量接口：

    getCredentialStatuses({
      bindings: [...]
    })

批量上限为 200。超过上限返回稳定 BATCH_TOO_LARGE，避免形成无界 presence query。

projection 字段：

- credentialRef：deterministic opaque compatibility reference。
- authorityScope：desktop-local。
- status。
- secretPresent：boolean。
- sourceClass。
- errorCode：仅稳定错误码。

projection 不包含：

- key。
- apiKey。
- secret。
- Authorization。
- Bearer。
- fingerprint。
- ciphertext。
- vault path。
- decryption key。

R5 compatibility reference：

- 由 authority scope 和 bindingId 在 authority 内 deterministic 派生。
- 不基于 raw secret。
- 不基于 credential fingerprint。
- 不可由它反推 secret。
- 不写入 production credential record。
- 不冻结为最终 v2 persisted credentialRef schema。

报告中的 role-001、role-002 和 cred-live-001 等只是审计别名，不是 adapter 返回的生产 ID。

## F. Status Semantics

R5 adapter 支持：

| Status | R5 meaning |
|---|---|
| ready | Vault 已安全加载，binding 存在且 has() 为 true |
| missing | Vault 已安全加载，但 binding 不存在 |
| unavailable | authority material/runtime 不可访问，或 key/vault 前置条件失败 |
| unknown | 当前 v1 loader 无法安全区分 empty/corrupt/decryption-unknown |
| none | credentialPolicy=none 或 loopback/local endpoint，不执行 credential lookup |

R5 不产生 invalid，因为禁止 provider validation。

R5 不伪造 locked/disabled：

- 当前 Vault v1 没有 lifecycle lock state。
- 当前 Vault v1 没有 disabled credential state。
- 这两个状态在 R5 为 NOT_EXPRESSIBLE_BY_CURRENT_VAULT。

## G. Capability Semantics

当前 credential-vault v1 record 只保证 characterId、provider、apiKey、endpoint、model、updatedAt；R5 adapter 只调用 has()，因此不推导 capability。

R5 status=ready 的严格含义是：

- local authority 可读取并判断 required credential presence。

R5 status=ready 不代表：

- provider key 有效。
- provider capability 匹配。
- 网络可达。
- model 可用。
- image.generate、vision、tts、asr 等能力已验证。

capabilities 在 R5 projection 中省略，而不是猜测。

## H. Projection Transport

R5 transport：**internal-only**。

adapter 是 authority-side module，由 test-only consumer 调用；没有新增 HTTP 或 IPC endpoint。

选择 internal-only 的原因：

- Active HTTP bind 在 services/active-message-service.js:25 是 127.0.0.1。
- active/http.js:90-108 使用 loopback/Tauri/null Origin 白名单。
- 当前 Active HTTP 没有针对 credential-status 的 token-authenticated read endpoint。
- Origin null 被允许，新增 status endpoint 会扩大 local credential presence oracle。

因此 R5 不新增 GET /credential-status 或 POST /credential-status/query。未来如果需要跨进程 projection，应先建立专用 authenticated local IPC/host seam；不能直接把 status oracle 暴露给现有无 token HTTP surface。

## I. HTTP / IPC Security Boundary

当前 Active HTTP 的边界：

- 监听 loopback。
- Origin policy 限制 foreign web origins。
- 没有适用于新 credential-status endpoint 的独立 token auth。
- CORS 允许 local/Tauri/null caller。

结论：

- 当前 execution API 的既有边界未被 R5 改变。
- credential status projection 选择 internal-only，不新增 HTTP presence oracle。
- SECURITY BLOCKER FOR HTTP PROJECTION：当前若要新增独立 HTTP status endpoint，必须先设计 authenticated local IPC/host boundary。
- adapter 本身仍然 PASS，因为它不打开网络面。

## J. Real Vault Validation

R5 使用真实 Active Vault，但只在 adapter authority 内调用 load + has；没有调用 get。

R2 baseline 实测仍成立：

| Binding class | Count | Status |
|---|---:|---|
| Current live role refs | 22 | observed |
| Credential-required live refs | 21 | observed |
| Ready credential-required refs | 21 | ready |
| Missing credential-required refs | 0 | none |
| Unavailable credential-required refs | 0 | none |
| Unknown credential-required refs | 0 | none |
| char_bgai | 1 | none |

R5 没有调用 provider 来判断“ready”是否可用；ready 只表示本机 Vault presence/readability。

## K. Live Binding Results

真实 live metadata 通过 role/config aliases 进行内部查询；报告只保留 aggregate：

- live role refs：22。
- credential-required refs：21。
- ready：21。
- missing：0。
- unavailable：0。
- unknown：0。
- char_bgai：none / no credential required。

char_bgai 仍保持 R2 语义：

- TEST_FIXTURE。
- ORPHANED_RUNTIME_REFERENCE。
- NO_CREDENTIAL_REQUIRED。

没有 provider call，没有 reissue，没有对任何 binding 做写入。

## L. CredentialRef Compatibility Mapping

R5 只生成 compatibility reference projection：

- deterministic。
- authority-side。
- stable for same authority scope + binding。
- opaque to frontend。
- not based on raw secret。
- not based on fingerprint。
- not persisted as v2 record。

R5 compatibility reference 不等于最终 v2 persisted credentialRef。R6 仍需重新定义 API Config/UI cutover 时的持久化 ID、rotation 和 backup semantics。

## M. Secret Boundary Tests

测试文件：tests/test_credential_authority_r5_adapter.js

验证：

- response schema 没有 forbidden secret property：PASS。
- adapter result 没有 forbidden secret property：PASS。
- JSON serialization 没有 forbidden secret property：PASS。
- error projection 没有 credential payload：PASS。
- telemetry 只保留 status/authority metadata：PASS。
- test artifact 没有真实 key、fingerprint、ciphertext 或 decrypted record：PASS。
- adapter executable source 没有调用 get/all/upsert/save/remove/migrateFromState：PASS。

R5 没有把真实 secret 值传给 scanner、日志、report 或 test artifact。

## N. Error Paths

已验证：

| Error path | Result |
|---|---|
| unknown binding | missing |
| missing vault/key material in isolated temp dir | unavailable |
| malformed binding request | unknown + MALFORMED_BINDING |
| batch above 200 | BATCH_TOO_LARGE |
| ambiguous/empty loaded state | unknown |
| missing lifecycle lock state | NOT_EXPRESSIBLE_BY_CURRENT_VAULT |
| missing lifecycle disabled state | NOT_EXPRESSIBLE_BY_CURRENT_VAULT |

没有删除真实文件来测试缺失路径；missing/unavailable 路径使用 isolated temp directory。

错误输出不含：

- secret。
- decrypted record。
- vault content。
- stack 中的 credential payload。

## O. Existing Runtime Compatibility

R5 adapter 没有接入：

- services/active-message-service.js。
- active/http.js。
- scheduler。
- plans。
- moments。
- execution/model-client。
- provider call path。

因此现有 Active Message：

credential-vault  
→ existing execution

完全不变。

R5 adapter 只是旁路 read-only projection。测试前后 Active execution path 未变化，scheduler 没有被启动来完成 status validation。

## P. Production Invariance

R5 前后真实文件 hash/size/mtime：

- credential-vault.json：unchanged。
- credential-vault.key：unchanged。
- apiConfigs_recovery_import.json：unchanged。
- active-message-service.json：unchanged。
- Bridge config：unchanged。
- Home Node credential：unchanged。

R5 没有修改：

- Vault。
- recovery JSON。
- IndexedDB/localStorage。
- apiSettings/apiConfigs。
- Bridge/Home Node。
- role data。
- active business state。

## Q. R6 Entry Gate

R6 evidence gate：

1. Real Vault status adapter works：PASS。
2. Projection secret-free：PASS。
3. Real live bindings resolve：PASS，21/21 ready。
4. Endpoint/IPC security boundary acceptable：PASS，R5 选择 internal-only，未暴露 HTTP oracle。
5. API page could consume status without apiKey：PASS，isolated consumer 验证通过。
6. Current Active execution unchanged：PASS。
7. Production credential data unchanged：PASS。

R6 authorization gate 仍关闭。R6 只能在明确批准后开始 API Config/UI Authority Cutover。

## R. Remaining

1. 当前 production API page 仍使用 cfg.apiKey presence；R5 不修改它。
2. R6 需要选择 authenticated local IPC/host seam，或在新的 auth boundary 下设计 status transport。
3. R6 需要把 adapter status 接入 API Config v2 projection；不能直接把 adapter 接到旧 renderApiList。
4. provider/model capability 仍未在 R5 验证；ready 不等于 provider valid。
5. locked/disabled 仍需 v2 lifecycle model 才能表达。
6. 不删除 legacy apiKey、不删除 emergency mirror、不删除 recovery artifact。
7. 不开始 Backup v2、Storage Convergence、P33、Android 或 Jev。

## Closure Gate

R5 PASS 条件：

- real Vault 可以安全 read-only query：通过。
- secret-free status projection：通过。
- 没有 secret 跨 authority boundary：通过。
- current live binding projection：通过，21 个 ready、0 个 required missing。
- char_bgai 保持 no-credential-required：通过。
- transport security boundary：通过，internal-only，未新增 HTTP oracle。
- existing Active execution unchanged：通过。
- production Vault byte/stat unchanged：通过。
- production business data unchanged：通过。
- provider calls：0。
- baseline-critical drift：0。

**Credential Authority Convergence R5 complete.**

**The existing Active credential vault is now exposed through a read-only, secret-free authority projection.**

**No plaintext credential crosses the authority boundary.**

**Existing Active execution remains unchanged.**

**Production credential data remains unchanged.**

**Provider calls: 0.**

**R6 API Config / UI Authority Cutover may begin only after explicit approval.**
