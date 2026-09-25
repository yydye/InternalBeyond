# Credential Authority v2 Contract

设计阶段：R3  
日期：2026-09-22（Asia/Shanghai）  
状态：DESIGN ONLY

本契约只定义未来 Credential Authority v2 的边界、引用、执行、备份和迁移原则。它不修改当前实现，不创建生产数据，不创建真实 credential，不替换当前 Vault，不执行 migration/restore/import，也不发起 provider 请求。

R2 是 immutable evidence baseline：

- 12 个 same-ID/different-fingerprint conflicts 已全部判定为 VAULT_CURRENT。
- recovery 侧 12 条记录仅作为 historical alternate source。
- char_bgai 是 TEST_FIXTURE + ORPHANED_RUNTIME_REFERENCE，NO_CREDENTIAL_REQUIRED。
- canonical metadata-only mapping 可构造。
- provider reissue minimum 为 0。
- R2 production invariance 通过，production writes/provider calls 均为 0。

## A. Motivation

当前系统已经有一个可工作的 Active Message encrypted credential vault，但 provider secret 仍分散在多个边界：

- Web UI 的 IndexedDB apiConfigs 可能直接保存 apiKey。
- emergency mirror 和历史 recovery artifact 可能保留明文 key。
- Middle Brain 使用独立的 apiSettings credential。
- Bridge/TTS/ASR/外部集成由 Bridge config 持有 secret。
- browser voiceTrans 仍有独立 apiSettings credential。
- Home Node desktop token 是独立的设备配对凭据。
- Image Router 当前是 apiConfig 引用层，但最终仍可能解析 apiKey。

v2 的目标不是把所有 secret 强行塞入一个文件，而是把 secret lookup、decrypt、request signing 和 redacted telemetry 收敛到明确的本地执行 authority，同时保留 Bridge/Home Node 的进程和能力边界。

设计成功标准：

1. Role 和 Frontend 永远不再以 apiKey 作为绑定关系。
2. API Config 只保存 capability metadata 和 credentialRef。
3. provider 请求只由受控的 Local Execution Authority 或 Bridge Authority 发起。
4. 普通备份永远不含 secret；加密恢复备份通过同一 container schema 的可选 encrypted secret section 表达。
5. stale copy、fingerprint conflict 和 rollback 在写入前可预览、可拒绝。

## B. Current Authority Map

计数口径：

- 当前具体 secret-holding stores：6。
- 当前 authority families：5，因为 TTS/ASR/proactive/music 等 Bridge config secret 共用一个 Bridge-local family。
- recovery JSON、legacy character.apiKey、emergency mirror 和 Image Router route metadata 是 source/reference boundary，不计为新的 canonical authority。

| Domain | Current Owner | Storage | Consumer | Secret Access Pattern | Future Authority Decision | Migration Complexity |
|---|---|---|---|---|---|---|
| Chat Provider | Web UI apiConfigs；Active runtime 另有 credential-vault | IndexedDB apiConfigs；Active vault | chat、group、Activity、Active Message | Frontend 当前可读 apiKey；Active runtime 从 vault 读取 | MERGE_TO_CREDENTIAL_AUTHORITY | High |
| Active Message | encrypted credential-vault | credential-vault.json + credential-vault.key | moments、plans、scheduler、execution | Node runtime 解密后注入 model client | KEEP as compatibility source, then MERGE_TO_CREDENTIAL_AUTHORITY | Medium |
| Middle Brain | private apiSettings['middle_brain'] | IndexedDB apiSettings | Astra compression、judge、integrity seams | frontend config path 当前可保存/读取 apiKey | Hybrid：policy config separate，secret lookup MERGE_TO_CREDENTIAL_AUTHORITY | Medium |
| Image Router | route metadata + apiConfigs | apiSettings['image_router'] + apiConfigs | image generation/editing | route 解析 imageGenApiKey 或 apiKey | WRAPPER_ONLY；credentialRef 由统一 authority 解析 | Medium |
| TTS | Bridge config | Bridge config.json tts/ttsMimo | Bridge /api/tts | Bridge 进程读取并 attach provider auth | KEEP_SEPARATE，未来可引用 sharedRef 但不跨进程复制 plaintext | Medium |
| ASR | Bridge voiceAsr；browser voiceTrans 是另一具体 store | Bridge config voiceAsr；apiSettings voiceTrans | voice transcription / voice call | 当前 Bridge 或 browser 直接读取 key | KEEP_SEPARATE at execution boundary；browser voiceTrans migrate out of frontend | Medium |
| Voice | role voice source/profile | role metadata + Bridge source registry | TTS/Voicebox | role 只保存 source/profile，不应保存 secret | WRAPPER_ONLY；secret 由 TTS/Voice authority 负责 | Low |
| Bridge | Bridge config local secret family | Bridge config.json、LAN token、music/external fields | TTS、ASR、proactive、music、webhooks | Bridge-local read and request signing | KEEP_SEPARATE | Medium |
| Home Node tokens | Home Node desktop credential | home-node/desktop-credential.json | desktop/mobile pairing and service auth | Home Node service only | KEEP_SEPARATE | Low |
| Desktop credentials | Home Node desktop token and local service pairing | Home Node credential authority | local service transport | bearer-like service credential, not provider key | KEEP_SEPARATE | Low |
| External integrations | mostly Bridge-owned today | Bridge config fields such as music/external integration secrets | Bridge integrations | integration-specific secret lookup | KEEP_SEPARATE by capability; may use common encrypted storage implementation later | Medium |

Current map must not be read as permission to migrate. It is a design inventory only.

## C. Design Principles

### Principle 1 — Frontend secret isolation

未来 Frontend 不得持有或读取：

- plaintext API key。
- Authorization/Bearer token。
- provider secret payload。
- encrypted secret material that can be directly decrypted by page JavaScript。

Frontend 可以看到：

- opaque credentialRef。
- derived status：missing、locked、unavailable、disabled、ready、unknown。
- capability set：chat、vision、image.generate、tts、asr 等。
- provider/model/endpoint class metadata。

Frontend 只提交 execution intent；它不负责 secret lookup 或 request signing。

### Principle 2 — Credential references

唯一允许的角色配置关系是：

Role  
→ apiConfigId  
→ credentialRef  
→ Local Credential Authority

禁止：

Role → apiKey  
API Config → plaintext apiKey  
Frontend → Authorization header built from page-readable secret

credentialRef 是不透明引用，不是 fingerprint，不是 key prefix，也不应泄露 secret 内容。

### Principle 3 — Execution authority

每个请求必须有一个明确的 execution authority：

- Desktop Local Credential Authority：Chat Provider、Active Message、Middle Brain secret plane、Image Router provider calls。
- Bridge Credential Authority：TTS、ASR、Voicebox adapter、proactive Bridge calls、music 和外部 Bridge integrations。
- Home Node Device Authority：desktop/mobile pairing 和 Home Node service token。

Execution authority 负责：

1. 根据 apiConfigId/capability lookup credentialRef。
2. 从本机 encrypted store 解密 secret。
3. 在 authority 内 attach provider authentication。
4. 发起 provider request。
5. 只返回业务结果和 redacted telemetry。
6. 清理 request scope 中的 secret，避免进入 DOM、UI state、普通日志和业务 snapshot。

Frontend、Role model、Home Node cognitive projection 和 Image Router route parser 都不能越过 authority 直接读取 secret。

### Principle 4 — Offline local-first

v2 不要求服务器保存 key，也不要求云端 credential service：

- secret 仍留在用户本机。
- encrypted store 可以由操作系统保护、应用密钥或用户密码解锁。
- provider execution 可以通过本机 loopback/local service 完成。
- Offline 时可明确返回 locked/unavailable/unknown，而不是把所有情况伪装成 invalid。
- Cloud sync、Home Node sync 和 mobile pairing 只传递 metadata、capability 和短期授权，不传递长期 provider secret。

## D. Credential Model

R3 只定义 schema，不创建 record。

建议的逻辑模型：

    CredentialRecord
      credentialRef
      authorityScope
      provider
      capabilities
      secretEnvelopeRef
      metadata
      lifecycle
      backupPolicy
      audit

字段契约：

| Field | Meaning | Secret allowed? |
|---|---|---|
| credentialRef | stable opaque reference within authority scope | no |
| authorityScope | desktop、bridge、home-node 等 authority namespace | no |
| provider | provider family identifier | no |
| capabilities | chat、vision、image.generate、tts、asr 等 | no |
| secretEnvelopeRef | authority-local encrypted secret locator | no plaintext |
| metadata | endpoint class、label class、region/cost hints、provenance | no |
| lifecycle | createdAt、updatedAt、disabledAt、rotationCounter | no |
| backupPolicy | never、encrypted-recovery-only、metadata-only | no |
| audit | provenance class、lastUsedAt class、lastErrorCode、version | no |

secretEnvelopeRef 只能由 authority 解释；它不能是浏览器可读取的 file path、raw ciphertext 或 provider payload。

必须支持的 lifecycle：

- version：记录格式版本，未知版本不得静默读取。
- rotation：新 secret 生成新的 internal version，旧版本进入保留/撤销状态。
- disabled：显式阻止使用，但不删除历史 provenance。
- backupPolicy：普通备份永远排除 secret；加密恢复备份按策略包含 encrypted section。
- fingerprint：只在 authority 内用于去重/conflict detection；UI 和文档使用临时 alias 或 status，不输出 raw fingerprint。
- audit metadata：记录 source class、migration batch、conflict decision、operator/approval reference；不得记录 secret。

credential status 是派生状态，不应被当成 provider validity 的无网络证明：

| Status | Meaning |
|---|---|
| missing | 没有 credentialRef 或 authority 没有对应 record |
| locked | authority 存在但 encrypted store 未解锁 |
| unavailable | authority 进程/本地 runtime 不可用 |
| disabled | record 被明确禁用 |
| ready | 本地结构、权限和解密流程可用；不代表 provider 已验证 |
| invalid | 仅在 authority 收到明确的本地协议/授权错误后产生；R3 不执行 provider validation |
| unknown | 当前证据不足，不自动重发或自动选择其他 key |

## E. API Config Contract

API Config v2 是 secret-free metadata：

    {
      id,
      provider,
      endpoint,
      endpointClass,
      model,
      capabilities,
      credentialRef,
      credentialPolicy,
      credentialStatus,
      metadata,
      version
    }

禁止字段：

- apiKey
- authorization
- bearer
- encrypted secret payload
- raw fingerprint

credentialPolicy：

- required：远程 provider 默认值；没有可用 credentialRef 时不可执行。
- optional：provider 可能允许匿名或 authority 可选能力；执行前仍必须明确 capability。
- none：loopback/local model、Edge TTS 等不需要 provider secret 的路径。

配置是否允许没有 credential：

- 允许，但必须有明确的 credentialPolicy。
- remote/custom endpoint 默认 required，除非 authority capability contract 明确声明 optional。
- loopback endpoint 可以是 none 或 optional；不能因为 UI 没有 key 就隐式猜测它是安全本地服务。
- local model 走 none + local-runtime capability，不创建空 credential 记录。

credential missing、invalid、unavailable 的表示：

- apiConfig 保留 credentialRef/status metadata，不把错误写入 apiKey 字段。
- missing：credentialRef 不存在或指向不存在记录。
- unavailable：authority 离线/未解锁。
- invalid：authority 已得到明确拒绝证据；未验证时必须使用 unknown/ready-not-verified，而不是 invalid。

custom provider：

- provider=custom 只说明 wire adapter 未预设。
- credentialRef 仍由 authority 管理。
- endpointClass、capabilities 和 request adapter 独立于 secret。

local model/loopback：

- endpointClass=loopback/local。
- credentialPolicy=none 或 optional。
- 不创建空 apiKey，不把空 key 当成 credential。

## F. Role Binding Contract

Role v2 不拥有 credential：

    Role
      id
      apiConfigId
      voiceProfile
      public metadata

Role 不得拥有：

- apiKey
- credentialRef 以外的 secret locator
- provider Authorization
- Bridge TTS/ASR secret

apiConfigId 是 role 的稳定绑定；credentialRef 由 API Config/authority metadata 解析，不复制到每个角色 record。

不同消费者的统一程度：

| Consumer | Binding |
|---|---|
| Chat | Role.apiConfigId → API Config → Desktop Local Credential Authority |
| Active Message | characterId/config ID → API Config/authority projection；当前 Vault 是兼容 source |
| Activity | 使用 chat/apiConfigId，不拥有第二份 credential |
| Image Router | route.apiConfigId → API Config；route 本身只保存 model/fallback metadata |
| Middle Brain | capability config 独立；secret plane 使用 authority credentialRef，不绑定某个 chat role |
| Voice/TTS/ASR | role 只保存 voice source/profile；Bridge/Audio authority 解析 credential |

Role 与 Middle Brain 不应共享同一个 role binding，只共享 secret authority 的抽象能力。

## G. Execution Authority

### G1. Desktop Local Credential Authority

负责：

- Chat Provider execution。
- Active Message execution。
- Middle Brain/Astra provider execution。
- Image Router 的远程 image generation/editing execution。
- local encrypted credential lookup/decrypt。
- provider request signing。
- redacted telemetry。

不负责：

- Role business state。
- Chat message persistence。
- Memory、Diary、Moments、Role Letters 或 Home Node data authority。

### G2. Bridge Credential Authority

Bridge 保持进程边界和 capability boundary：

- TTS/TTSMimo。
- ASR。
- Voicebox adapter。
- proactive Bridge provider calls。
- music、LAN、webhook 和外部 integration secrets。

Bridge 可以在未来使用同一种 encrypted storage implementation，但不能把 Bridge secret plaintext 复制给浏览器或 Role。

### G3. Home Node Device Authority

只负责：

- desktop pairing。
- Home Node service authentication。
- mobile gateway/session transport。

Home Node 不负责 provider credential lookup，也不负责 Middle Brain provider execution。

### G4. Request contract

Frontend 到 authority 的请求只应包含：

- requestId。
- capability。
- apiConfigId 或 capabilityConfigId。
- input handle/业务 payload。
- timeout、cancellation 和 trace metadata。

authority 内部解析 credentialRef、解密、签名和执行；response 只返回业务结果、稳定错误码和 redacted telemetry。

## H. Middle Brain Boundary

当前 Middle Brain 使用 apiSettings['middle_brain']，并拥有独立 endpoint/model/apiKey 配置。R3 比较三种方案：

| Option | Security | Complexity | Local deployment | Migration risk |
|---|---|---|---|---|
| A. 独立 Credential Domain | 中；继续存在 frontend secret surface | 低 | 好 | 低 |
| B. 完全并入 Chat API Config | 高，但混淆 capability/config 与 role | 中 | 好 | 高 |
| C. Hybrid | 高；secret plane 统一、policy/config 独立 | 中 | 好 | 中 |

建议：Hybrid。

- Middle Brain 保留独立 capability config：enabled、model、reasoning、image mode、policy、integrity settings。
- Middle Brain 不再保存 plaintext apiKey。
- Middle Brain config 只保存 credentialRef/status metadata，或由 Local Authority 通过 capabilityConfigId 解析。
- Astra/provider request 由 Desktop Local Credential Authority 执行。
- Home Node 继续只接收 policy projection，不能持有 Middle Brain secret。
- Middle Brain 是否使用与 Chat 相同的 credential 是 explicit reference decision，不根据 provider 名称自动共享。

因此，Middle Brain 在 secret plane 进入统一 authority；在 policy/config plane 保持独立。

## I. Image Router Boundary

建议 Image Router 采用 wrapper-only 设计：

    image_router route
      apiConfigId
      model/fallback metadata
        ↓
    API Config
      credentialRef
        ↓
    Desktop Local Credential Authority

OpenAI Image：

- 可复用同一 provider credential，前提是 capability set 包含 image.generate/edit。
- 不把 image key 复制成 route-local secret。

Custom image endpoint：

- 可使用独立 API Config 和独立 credentialRef。
- provider=custom 不改变 secret authority。

Local image model：

- credentialPolicy=none。
- Image Router 仍保存 route/model metadata，但不创建空 credential。

Image Router 本身不成为新的 secret authority；它只解析 route 和 capability。

## J. Voice/TTS/ASR Boundary

Audio Credential Strategy：

| Audio path | Strategy | Future owner |
|---|---|---|
| Edge TTS | Local/remote capability with no API secret where applicable | Bridge wrapper |
| OpenAI-compatible TTS | Dedicated Credential by default | Bridge Credential Authority |
| MiMo TTS/VoiceClone/VoiceDesign | Dedicated Credential by default | Bridge Credential Authority |
| OpenAI-compatible ASR | Dedicated Credential | Bridge Credential Authority |
| browser voiceTrans | Migrate out of page-readable apiSettings | Bridge or Desktop Local Execution Authority |
| Voicebox | Local Runtime | Voicebox/Bridge local boundary |
| role voice profile | Shared metadata only | Role wrapper; no secret |

Shared Credential：

- 允许通过显式 shared credentialRef 使用同一 provider secret。
- 必须按 capability 授权，不因 provider 相同自动共享。
- Bridge 不把 shared secret 注入 browser。

Dedicated Credential：

- TTS、ASR、外部音频 provider 默认使用 dedicated credentialRef。
- rotation、disabled、backupPolicy 独立。

Local Runtime：

- Edge、Voicebox 等不需要 secret 的路径使用 credentialPolicy=none。
- 不创建 fake credential 或空 key。

Audio 继续保持独立 authority family；未来只共享抽象 contract，不强制共享 storage 或 process。

## K. Backup Contract v2

统一 container 名称：IB Backup Container v2。

逻辑结构：

    {
      format,
      version,
      createdAt,
      metadata,
      applicationData,
      configuration,
      integrity,
      encryptedSecrets?
    }

metadata：

- app/build/schema versions。
- authority families present。
- counts、capabilities、provider metadata。
- 不含 secret、raw fingerprint 或密码。

applicationData：

- application business data。
- 角色/route/profile metadata。
- 普通业务数据不自动取得 secret。

configuration：

- API Config metadata。
- Role.apiConfigId。
- Image Router routes。
- Middle Brain capability config。
- Audio/Bridge source metadata。
- credentialRef/status metadata。

Normal Backup：

- encryptedSecrets section 必须 absent。
- 不包含 apiKey、Authorization、token、secret 或 emergency plaintext mirror。
- preview 可以展示 counts、missing status 和 capability，不展示 secret。

Encrypted Recovery Backup：

- encryptedSecrets section present。
- secret section 使用独立 authenticated encryption envelope。
- 密码只在本地使用，不上传、不进入 logs、metadata 或 user-facing report。
- section 内仍以 authority scope 分区，不能把 Bridge/Home Node token 无条件合并到 Chat provider secret。

Versioning：

- container version 与 authority record version 独立。
- 未知 major version 拒绝导入。
- minor version 只允许显式兼容规则。
- import 前完成 schema validation 和 capability policy validation。

Integrity verification：

- manifest 覆盖 metadata、applicationData、configuration 和 encrypted section。
- encrypted section 使用 authenticated encryption。
- integrity failure 在 preview 阶段报告，不进入 write transaction。

Preview restore：

1. 在隔离内存/临时目录解密。
2. 展示 counts、config IDs、credentialRef aliases、missing/conflict counts。
3. 不写 IndexedDB、Vault、Bridge 或 Home Node。
4. 用户确认后才允许未来 migration phase 创建 transaction。

Fingerprint conflict detection：

- 以 stable config/role ID、provider、capability、endpoint class、model 和 authority-local fingerprint 比较。
- UI 只显示 opaque alias/status。
- 禁止自动选择 Vault 或 recovery source。
- 冲突必须标记为 current、historical、unresolved 或 rejected，并保留 provenance。

Rollback：

- 任何 future write 前创建 authority-scoped snapshot。
- 写入按 authority transaction 执行。
- 任一 authority 失败则停止后续 commit，使用 snapshot/transaction journal 回滚。
- rollback 不删除原 recovery artifact，除非另一个明确的 retention phase 批准。

R3 只确定 contract，不实现 container、encryption、preview 或 rollback。

## L. Migration Boundary

| Existing artifact | Future classification | Boundary |
|---|---|---|
| Active credential-vault | KEEP → adapter source | 当前 runtime 继续使用；未来由 Local Authority adapter 读取，不在 R3 替换 |
| Role character.apiKey | DEPRECATE | 保留只读兼容/诊断窗口，禁止新写入 |
| IndexedDB apiConfigs.apiKey | MIGRATE | metadata 保留，secret 改为 credentialRef |
| emergency plaintext mirror | DEPRECATE → REMOVE LATER | encrypted recovery contract ready 且 rollback 可验证后再处理 |
| apiConfigs_recovery_import.json | KEEP quarantine → REMOVE LATER | 作为历史 alternate source 留存，不自动导入 |
| Middle Brain apiSettings key | MIGRATE | policy/config 保留，secret 改为 Local Authority credentialRef |
| Image Router route | KEEP metadata → MIGRATE reference | apiConfigId/model/fallback 保留，不保存 secret |
| Bridge TTS/ASR/config secrets | KEEP_SEPARATE → adapter migration | 迁入 Bridge authority schema，不复制到 frontend |
| browser voiceTrans key | MIGRATE | 移出 page-readable apiSettings，交给 execution authority |
| Home Node desktop credential | KEEP_SEPARATE | 不并入 provider credential authority |
| external integration secrets | KEEP_SEPARATE | 按 capability/authority scope 迁移，禁止跨域复制 |

REMOVE LATER 只允许在：

- encrypted recovery backup 已验证。
- source/provenance mapping 已保存。
- rollback 已演练。
- 用户明确批准 retention change。

R3 不执行任何上述动作。

## M. Threat Model

### M1. Accidental export

当前风险：

- apiConfigs direct apiKey。
- emergency mirror raw key。
- recovery JSON raw key-bearing records。

未来目标：

- Normal Backup secret section absent。
- UI export 只输出 metadata/status。
- encrypted recovery 独立 section，密码和 plaintext 只留在 authority 内。

### M2. Debug leakage

当前风险：

- communication.js opt-in debug path 仍可能输出 key prefix。

未来目标：

- logs 只输出 credentialRef alias、status、provider/capability。
- 禁止完整 key、稳定 prefix/suffix、Authorization/Bearer。

### M3. Frontend exposure

当前风险：

- apiConfigs 和 Middle Brain apiSettings 可由页面读取。
- communication.js 直接构造 provider headers。

未来目标：

- 页面只看到 opaque ref/status/capability。
- provider header 只在 execution authority 内生成。

### M4. Backup leakage

当前风险：

- recovery artifact 是本地明文 key-bearing source。
- full encrypted export 与普通 export 的边界容易被文案混淆。

未来目标：

- 一个 container schema，Normal Backup 无 encryptedSecrets，Encrypted Recovery Backup 只有 authenticated encrypted section。

### M5. Stale credential copies

当前风险：

- Vault、UI apiConfigs、recovery JSON、legacy snapshot 可在不同时间点分叉。
- R2 已证明同 ID conflict 需要 provenance，不得按文件名或 authority 名称猜测。

未来目标：

- source metadata、version、updatedAt、transaction reference 和 authority-local fingerprint。
- preview conflict detection。
- no auto-selection、no silent overwrite、rollback before commit。

### M6. Scope and limits

本契约不承诺在本机被完全攻破、浏览器调试权限被滥用或操作系统密钥保护失效时仍能保护 secret。它的目标是减少应用层 accidental exposure、跨域复制、stale copy 和错误备份恢复。

## N. Non Goals

R3 不做：

- storage convergence。
- IndexedDB → Home Node migration。
- Chat、Memory、Relationship、Diary、Moments、Role Letters、Activity data migration。
- Android。
- Tauri Host changes。
- Backup implementation。
- API Router rewrite。
- Provider adapter rewrite。
- Credential Authority v2 implementation。
- Vault replacement。
- Legacy deletion。
- provider validation、key reissue 或真实请求。
- commit、push 或 production code refactor。

## O. Future Migration Plan

以下是未来 phase 的进入顺序，不是当前执行计划：

### O1. Contract validation

- 用 synthetic credentials 和 isolated storage 验证 schema、status、capability、alias 和 no-secret output。
- 不接 provider，不读取真实 secret。

### O2. Local Authority adapter

- 为当前 Active Vault 建立 read-only adapter。
- 先支持 metadata projection、credentialRef/status、redacted telemetry。
- 不改变现有 runtime write path。

### O3. API Config metadata migration

- 在 staging 将 apiConfigs.apiKey 转为 credentialRef candidate。
- 用 preview/conflict/rollback gate。
- Role、Activity、Image Router 只消费 apiConfigId。

### O4. Capability authority integration

- Middle Brain 采用 hybrid：policy config separate，secret execution through Local Authority。
- Image Router 复用 API Config credentialRef。
- browser voiceTrans 迁出 page-readable storage。
- Bridge TTS/ASR 保持 Bridge-local authority。

### O5. Cutover and retirement

- 只有明确批准后才进入 production transaction。
- 保留旧 source snapshot 和 rollback。
- 观察期结束后才 DEPRECATE/REMOVE legacy direct apiKey、emergency plaintext mirror 和 recovery import artifact。

## Closure Gate

R3 完成条件：

- credential domain map 已定义。
- target authority families 和 KEEP_SEPARATE 边界已定义。
- Frontend secret isolation 原则已定义。
- CredentialRecord、API Config、Role binding、Execution Authority 已定义。
- Middle Brain、Image Router、TTS/ASR/Voice boundary 已定义。
- Backup Container v2 的 normal/encrypted、integrity、preview、conflict、rollback contract 已定义。
- migration boundary、threat model、non-goals 和 future plan 已定义。

R3 运行结果：

- No production code changes.
- No production data changes.
- No credential created.
- No credential migration executed.
- No provider calls performed.
- No API key、raw fingerprint、Authorization、token 或 secret payload 输出。

**Credential Authority Convergence R3 complete.**

**Design contract only.**

**No production changes.**

**No credential migration executed.**

**No provider calls performed.**
