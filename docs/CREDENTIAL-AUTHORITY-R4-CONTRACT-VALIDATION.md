# Credential Authority R4 Contract Validation

日期：2026-09-22（Asia/Shanghai）

R0：DEGRADED / forensic complete  
R1：DEGRADED / authority mapping complete  
R2：PASS  
R3：COMPLETE / design only  
R4：PASS

R4 只验证 R3 contract 是否能在当前代码结构之外用 synthetic authority、isolated projection 和 test-only DOM harness 表达。没有接入真实 Vault，没有解密真实 credential，没有读取真实 API key，没有启动会写入真实 WebView profile 的 runtime，也没有执行 provider/model request。

R4 新增的 test-only harness：

tests/test_credential_authority_r4_contract.js

该 harness 只使用明确的合成 fixture，运行时 projection 不返回 fixture secret、fingerprint、Authorization、Bearer 或 apiKey 字段。

## A. Scope

本阶段验证：

- 当前 API 页面“无密钥”的真实判断路径。
- 当前 authority seams 是否已经提供 secret-free status projection。
- R3 CredentialRecord、API Config v2、Role binding 和 Execution Intent 是否可由 synthetic harness 表达。
- READY、MISSING、LOCKED、UNAVAILABLE、DISABLED、UNKNOWN、NO_CREDENTIAL_REQUIRED、CAPABILITY_MISMATCH 八类状态。
- Frontend projection、isolated DOM、serialization、error、telemetry 和 backup preview 是否不泄漏 synthetic secret。
- Middle Brain Hybrid、Image Router wrapper-only、Audio/Bridge boundary。
- R5 Local Authority Adapter 的 evidence gate。

本阶段不做：

- 不接真实 credential-vault。
- 不读取或解密 credential-vault.json。
- 不读取 apiConfigs_recovery_import.json 的 key 内容。
- 不修改 production API page、Active runtime、Bridge、Home Node、IndexedDB、localStorage 或 apiSettings。
- 不实现 Backup v2、Storage Convergence、R5 adapter、migration 或 provider execution。

## B. Production Invariance

Pre-flight：

- branch：master，ahead 147。
- HEAD：e2d6e886fb1a1e27c5882236719f65c8dfd8e8e6。
- R4 开始时 dirty worktree 已存在；本阶段没有执行 reset、clean、restore、checkout、stash、commit 或 push。

R4 只对以下真实文件做 size/mtime stat，不读取其 credential 内容：

| Production artifact | R4 interval stat unchanged |
|---|---|
| credential-vault.json | true |
| credential-vault.key | true |
| apiConfigs_recovery_import.json | true |
| active-message-service.json | true |
| Bridge config.json | true |
| Home Node desktop-credential.json | true |

R4 invariance result：

- Production credential reads = 0。
- Production credential writes = 0。
- Production business-data writes = 0。
- Provider calls = 0。
- Real WebView profile reads/writes = 0。
- Real Vault decrypts = 0。
- Real recovery key reads = 0。

R3/R2 报告保持 immutable；R4 只新增本报告和 test-only harness。

## C. Current API UI Audit

### C1. 页面模块

角色 API 页面由 assets/js/social.js 的 renderApiList() 渲染：

- assets/js/social.js:845-854 定义 renderApiList、加载 apiConfigs 并生成 API 角色列表。
- assets/js/social.js:1746 通过 loadApiSettingsUI() 触发 API 列表渲染。
- assets/js/social.js:2840 和 :3026 暴露 renderApiList。

### C2. “无密钥”的真实判断

当前代码在 assets/js/social.js:851 使用：

- a.apiKey 存在：不显示“无密钥”标签。
- endpoint 是 loopback 且 apiKey 为空：显示“本机免密钥”。
- 其他 apiKey 为空：显示“无密钥”。

因此当前 UI 的真实 flow 是：

Role/API list item  
→ apiConfigs record  
→ cfg.apiKey presence  
→ endpoint loopback special case  
→ “本机免密钥”或“无密钥”

确认结果：

1. 页面直接检查 apiKey。
2. 页面不通过 authority projection 获取 credentialStatus。
3. 页面不读取 credential-vault.has()。
4. keyTag 没有检查 imageGenApiKey；image-only key 不能独立让该标签显示 ready。
5. 当前 UI config 为空时，renderApiList() 显示空状态；assets/js/social.js:808-841 先读 IndexedDB，再合并 local/session/memory fallback。
6. 如果所有 config 都不存在，assets/js/social.js:832-838 还会尝试从 apiSettings.main 迁移旧 config；这仍是旧 apiKey path。
7. editApi() 在 assets/js/social.js:1147 将 cfg.apiKey 放回页面 input。
8. saveCurrentApi() 在 assets/js/social.js:1297 将页面 input 重新写进 cfg.apiKey。

### C3. Role 与 apiConfig 绑定

当前角色绑定以 API config ID 为角色/character ID：

- assets/js/active-diary.js:106-108 用 apiConfigs.id 填充角色选择器。
- assets/js/active-diary.js:126-141 用 characterId 查找 apiConfigs。
- assets/js/active-diary.js:1331-1342 将 characterId/provider/apiKey/endpoint/model 同步到 Active /credentials。

当前业务 snapshot 不再持久化 key，但 UI apiConfigs 仍然是 page-readable direct-apiKey storage。

### C4. 是否已有 secret-free authority status seam

当前已有的 seam：

- active/credential-vault.js:102 有内部 has(characterId)。
- active/http.js:219-243 有 POST /credentials 写入 endpoint。
- active/http.js:82-87 有业务 snapshot credential stripping。
- services/active-message-service.js:151-160 有 Vault 装配和 legacy migration。

当前缺少的 seam：

- 没有 frontend 可用的 credential presence/status projection。
- 没有 GET /credential-status 或等价的 status-only endpoint。
- 没有把 credentialVault.has() 的 boolean/status 投影给 API 页面。
- /credentials 目前只有 POST 写入路径，不能作为前端 status read path。

结论：Current UI Credential Status Flow 存在明确的 CONTRACT_GAP；R4 不修复它，只验证 R3 未来 contract 可以表达该 projection。

## D. Existing Authority Seams

当前可复用的 existing seams：

| Seam | Current behavior | R4 conclusion |
|---|---|---|
| credential-vault.has() | Node 内部只判断指定 characterId 是否有 non-empty key | 可作为未来 authority adapter 内部 primitive |
| credential-vault.get() | Node 内部返回完整 credential | 只能留在 authority 内，不能投影到 frontend |
| POST /credentials | browser/Active sync 写 Vault | 未来应由 adapter/transaction seam 包装，R4 不改 |
| active business snapshot stripping | 删除 snapshot character.apiKey | 可保留为 defense-in-depth |
| apiConfigs loader | IndexedDB + local/session/memory fallback | 未来只加载 metadata/status，不再加载 secret |
| Image Router apiConfigId | route 解析已有 API Config | 适合作为 wrapper-only seam |
| Bridge /api/tts | Bridge-local execution | 保持 Audio authority 边界 |

R4 没有创建第二套 production authority，也没有把真实 Vault 接到 UI。

## E. Synthetic Credential Authority

test-only harness 建立了 SyntheticCredentialAuthority：

    resolveCredentialStatus({
      credentialRef,
      capability,
      authorityScope
    })

public projection 只有：

    {
      credentialRef,
      authorityScope,
      status,
      capabilities,
      secretPresent
    }

内部 synthetic record 可以持有测试 secret，但 public projection、DOM、logs、errors、telemetry 和 serialization 都不返回该值。

Synthetic cases：

| Case | Expected result | Result |
|---|---|---|
| READY | credentialRef 存在、authority ready、capability 匹配 | PASS |
| MISSING | credentialRef 不存在 | PASS |
| LOCKED | authority store locked | PASS |
| UNAVAILABLE | authority runtime unavailable | PASS |
| DISABLED | credential record disabled | PASS |
| UNKNOWN | metadata 存在但 execution readiness 未知 | PASS |
| NO_CREDENTIAL_REQUIRED | credentialPolicy=none，不执行 secret lookup | PASS |
| CAPABILITY_MISMATCH | credential 存在但 capability 不匹配 | PASS |

## F. Projection Contract

R3 projection 在 synthetic runtime 中可表达：

- credentialRef。
- authorityScope。
- status。
- capabilities。
- secretPresent boolean。
- providerClass 等非敏感 metadata。
- lastErrorCode 等稳定错误码。

projection 明确不包含：

- secret。
- secretEnvelopeRef。
- raw fingerprint。
- Authorization。
- Bearer。
- ciphertext。
- vault path。
- decryption key。

测试结果：

- Projection secret-free：PASS。
- API Config secret-free：PASS。
- Role secret-free：PASS。
- DOM secret-free：PASS。
- Error serialization secret-free：PASS。
- Telemetry secret-free：PASS。

## G. API Config v2 Validation

Synthetic API Config v2 可使用：

    {
      id,
      provider,
      model,
      capabilities,
      credentialRef,
      credentialPolicy
    }

验证结果：

- chat config 不含 apiKey 仍可得到 READY：PASS。
- image config 通过 image.generate capability 得到 READY：PASS。
- local config 使用 credentialPolicy=none：PASS。
- API Config object 不含 authorization、bearer、secret、fingerprint：PASS。
- capability mismatch 返回稳定 CAPABILITY_MISMATCH：PASS。

R4 没有把该 synthetic model 写入 production apiConfigs。

## H. Role Binding Validation

Synthetic Role：

    {
      id: role-test,
      apiConfigId: cfg-test-chat
    }

验证链：

Role  
→ apiConfigId  
→ API Config  
→ credentialRef  
→ Synthetic Authority  
→ credentialStatus

结果：

- Role object 不含 apiKey：PASS。
- Role object 不含 secret/Authorization/Bearer：PASS。
- Role 不直接解析 credential：PASS。
- Role 绑定 READY config：PASS。
- Role binding 只使用 metadata/reference：PASS。

## I. UI Projection Validation

R4 使用 test-only DOM string harness 模拟 API 页面列表，没有修改 production API page。

UI projection 只消费：

- credentialStatus。
- credentialPolicy。
- capability。

UI 不消费：

- cfg.apiKey。
- role.apiKey。
- secret。

模拟状态：

| Status | Synthetic UI result |
|---|---|
| ready | 凭据就绪 |
| missing | 缺少凭据 |
| locked | 凭据已锁定 |
| unavailable | 凭据服务不可用 |
| disabled | 凭据已禁用 |
| unknown | 凭据状态未知 |
| none | 无需凭据 |
| capability_mismatch | 凭据能力不匹配 |

R4 acceptance result：API page status 可以只由 authority projection status 驱动；这证明 contract 可实施，不代表 production UI 已经切换。

## J. Status Vocabulary

状态词汇已在 synthetic harness 中统一：

| Runtime status | UI vocabulary |
|---|---|
| ready | 凭据就绪 |
| missing | 缺少凭据 |
| locked | 凭据已锁定 |
| unavailable | 凭据服务不可用 |
| disabled | 凭据已禁用 |
| unknown | 凭据状态未知 |
| credentialPolicy=none | 无需凭据 |
| capability_mismatch | 凭据能力不匹配 |

R4 不再把所有非-ready 状态统一渲染为“无密钥”。

## K. Secret Leakage Tests

Synthetic runtime leakage gate：

| Surface | Synthetic secret occurrences |
|---|---:|
| Projection JSON | 0 |
| Rendered DOM | 0 |
| Console/log artifacts | 0 |
| Error objects | 0 |
| Serialized API Config | 0 |
| Role object | 0 |
| Backup preview | 0 |
| Middle Brain projection | 0 |
| Image Router projection | 0 |
| Audio profile | 0 |
| Execution intent/result | 0 |

Harness source 中存在 synthetic fixture literals 和 negative-test forbidden field assertions；这些属于 SOURCE ASSERTION，不属于 runtime leak，已从 runtime leakage count 中排除。

最终 synthetic secret leakage count：0。

## L. Serialization Tests

已验证：

- JSON.stringify(frontendProjection)：无 synthetic secret。
- JSON.stringify(apiConfigV2)：无 synthetic secret、apiKey 或 Authorization。
- JSON.stringify(role)：无 synthetic secret。
- JSON.stringify(error)：只包含稳定错误码，不包含输入 secret。
- JSON.stringify(telemetry)：只包含 authorityScope/status，不包含 secret。
- JSON.stringify(backupPreview)：只包含 metadata/status/conflict count。

Serialization gate：PASS。

## M. Backup Preview Validation

R4 没有实现 Backup v2 encryption 或 import。

只验证 synthetic metadata preview：

- Normal Backup：secret section absent。
- Encrypted Recovery preview：只显示 credentialRef alias、provider/capability/status/conflict count。
- Preview 中没有 plaintext synthetic secret。
- Preview 中没有 ciphertext、raw fingerprint 或密码。
- Preview 不触发 authority write。

Backup preview gate：PASS。

## N. Middle Brain Validation

Synthetic Middle Brain config：

- enabled。
- model。
- reasoning。
- credentialRef。

验证：

- policy/config 可独立存在：PASS。
- secret resolution 通过 Synthetic Authority：PASS。
- Middle Brain config 不需要 apiKey：PASS。
- authority status 可以返回 ready/missing/locked/unavailable/disabled/unknown：PASS。
- 没有修改现有 Middle Brain production code：PASS。

R3 Hybrid contract 在 synthetic harness 中可表达；R4 没有把真实 apiSettings['middle_brain'] 接入。

## O. Image Router Validation

Synthetic flow：

image route  
→ apiConfigId  
→ API Config  
→ credentialRef  
→ Synthetic Authority

验证：

- image.generate capability 存在：READY，PASS。
- 只有 chat capability：CAPABILITY_MISMATCH，PASS。
- local image model + credentialPolicy=none：PASS。
- Image Router projection 不含 secret：PASS。
- Image Router 不成为 secret store：PASS。

## P. Audio Boundary

Synthetic voice profile 只包含：

- source。
- voiceId。
- voiceType。

验证：

- Role voice profile 不含 secret：PASS。
- Bridge TTS source 仍是 Bridge boundary：PASS。
- Desktop Local 与 Bridge Audio 没有被 synthetic harness 合并：PASS。
- Voicebox/local runtime 可以使用 no-credential boundary：PASS。
- browser voiceTrans 只登记为未来 migration seam，没有修改 production：PASS。

## Q. Execution Intent Contract

Synthetic Frontend intent 只包含：

- requestId。
- capability。
- apiConfigId。
- credentialRef reference。
- input。
- timeout。
- trace metadata。

Synthetic authority 执行结果只包含：

- ok。
- status。
- result metadata。
- errorCode。
- redacted telemetry。

Frontend request 不包含 apiKey、Authorization、Bearer 或 secret。Execution Intent gate：PASS。

## R. Negative Tests

| Negative case | Result |
|---|---|
| Role 带 apiKey | PASS / reject |
| API Config 带 apiKey | PASS / reject |
| Frontend request 带 Authorization | PASS / reject |
| Frontend request 带 secret | PASS / reject |
| credentialRef missing | PASS / missing |
| authority locked | PASS / locked |
| authority unavailable | PASS / unavailable |
| disabled credential | PASS / disabled |
| capability mismatch | PASS / stable error |
| loopback policy none | PASS / no credential lookup |
| Middle Brain plaintext apiKey | PASS / reject |
| Image route plaintext key | PASS / reject |

Negative test aggregate：PASS。

## S. Current Screenshot Acceptance Rule

当前真实截图中的“无密钥”应登记为：

CURRENT LEGACY UI BEHAVIOR

它表示当前 API page 无法从 page-readable apiConfigs.apiKey 得到 key presence，不等于 credential lost。

R0-R2 已证明：

current runtime credential authority  
≠  
current Web UI apiConfigs storage

未来 v2 cutover acceptance rule：

Role binding exists  
＋ authority projection.status=ready  
→ UI 显示“凭据就绪”

即使 Frontend 中不存在 apiKey，也必须显示 ready。

反向规则：

- status=missing → 缺少凭据。
- status=locked → 凭据已锁定。
- status=unavailable → 凭据服务不可用。
- status=disabled → 凭据已禁用。
- status=unknown → 凭据状态未知。
- credentialPolicy=none → 无需凭据。

R4 没有把该 acceptance rule 写入 production API page。

## T. R5 Entry Gate

R4 evidence gate：

- R3 contract 可由 synthetic harness 表达：PASS。
- API Config v2 不需要 apiKey：PASS。
- Role 不需要 credential plaintext：PASS。
- Frontend projection secret-free：PASS。
- API page status 可只依赖 credentialStatus：PASS。
- ready/missing/locked/unavailable/disabled/unknown/none 均可表达：PASS。
- Middle Brain Hybrid contract：PASS。
- Image Router wrapper contract：PASS。
- Audio authority boundary 未被破坏：PASS。
- 所有 synthetic secret leakage tests：PASS，0。
- 所有 negative tests：PASS。
- production writes：0。
- provider calls：0。
- real credential reads/decrypts：0。

R5 Local Authority Adapter may begin only after explicit approval。

但 R5 本轮没有开始：

- 没有接真实 Vault。
- 没有创建 production /credential-status endpoint。
- 没有修改 API page。
- 没有修改 Active runtime/provider execution。

## U. Remaining

1. 当前 API 页面仍使用 legacy cfg.apiKey presence；这是已确认的 production contract gap，不是 R4 测试失败。
2. 未来 R5 需要设计 read-only metadata/status adapter，但必须先获得明确批准。
3. R5 初期应只做 current Active Vault read-only adapter、status projection 和 no-secret boundary，不做 production cutover。
4. production API page、Middle Brain、Image Router、Bridge、Home Node 和 Backup v2 均未修改。
5. R4 不启动 Storage Convergence、P33、Android、Jev 或其他后续阶段。

## Closure Gate

R4 PASS 条件全部满足：

- R3 contract 可由 synthetic harness 表达。
- API Config v2、Role、Projection 和 UI status 均可不依赖 plaintext secret。
- 八类 synthetic status 全部 PASS。
- Middle Brain Hybrid、Image Router wrapper-only、Audio boundary 全部 PASS。
- 12 项 negative tests 全部 PASS。
- synthetic secret runtime leakage count：0。
- DOM leak count：0。
- log leak count：0。
- serialization leak count：0。
- production credential reads：0。
- production credential writes：0。
- provider calls：0。
- R4 interval production stat gate：PASS。

**Credential Authority Convergence R4 complete.**

**Synthetic contract validation passed.**

**The frontend credential projection can operate without plaintext secrets.**

**API Config v2 and Role bindings do not require apiKey.**

**The API-page credential state can be derived from authority status rather than page-readable key presence.**

**Synthetic secret leakage count: 0.**

**Production credential reads: 0.**

**Production credential writes: 0.**

**Provider calls: 0.**

**R5 Local Authority Adapter may begin only after explicit approval.**
