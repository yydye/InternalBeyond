# Credential Authority R8 Migration Preparation

日期：2026-09-22（Asia/Shanghai）

R0-R7：immutable baseline  
R8：migration preparation only

R8 没有执行 credential migration。所有 mapping、dual-read 和 dry-run 都是只读/内存级分析，不写入生产 Vault、IndexedDB、localStorage、Bridge、Home Node 或角色数据。

## A. Scope

R8 覆盖：

- apiConfigs。
- Middle Brain。
- Image Router。
- Active Message。
- legacy browser voice。
- credentialRef binding schema。
- legacy apiKey → credentialRef mapping strategy。
- credentialRef-first / legacy-fallback dual-read strategy。
- metadata-only migration dry-run。

R8 不做：

- 删除 apiKey。
- 删除旧 Vault。
- 修改 provider execution。
- 修改 Bridge/Home Node credential ownership。
- provider validation。
- Vault upsert/rewrite。
- recovery import。
- persisted credentialRef write。
- Backup v2、R9、Storage Convergence、P33、Android 或 Jev。

## B. Current Consumer Inventory

| Consumer | Current source | Current status authority | R8 preparation |
|---|---|---|---|
| apiConfigs | IndexedDB apiConfigs + fallback mirror | R6 Desktop Local projection for current known bindings | dual-read design only |
| Active Message | credential-vault keyed by characterId | Desktop Local Authority | 21 ready bindings + char_bgai none |
| Middle Brain | apiSettings['middle_brain'] | legacy independent config | no current credentialRef; status unknown/none wrapper |
| Image Router | apiSettings['image_router'].routes → apiConfigId | route wrapper + R6 Desktop projection | route status follows referenced apiConfig |
| legacy browser voice | apiSettings voiceTrans | browser legacy boundary | KEEP_SEPARATE; no Desktop migration |
| Bridge TTS/ASR/Voice | Bridge config tts/ttsMimo/voiceAsr/voicebox | Bridge Authority/local runtime | KEEP_SEPARATE |

Current isolated profile metadata audit：

- apiConfigs records：0。
- Middle Brain target record：0。
- Image Router route record：0。
- browser voiceTrans target record：0。
- fallback mirror：absent。

这些是当前 profile 的 metadata facts，不被解释成历史 credential loss。

## C. CredentialRef Binding Schema

R8 只定义 migration candidate schema，不创建 production record：

    BindingCandidate
      bindingId
      apiConfigId?
      credentialRef?
      authorityScope
      credentialStatus
      credentialPolicy
      sourceClass
      legacyPresence
      mappingDecision
      conflictState

字段语义：

| Field | Meaning |
|---|---|
| bindingId | 当前 role/config/capability 的稳定业务绑定 ID |
| apiConfigId | API Config metadata ID；不等于 secret |
| credentialRef | Desktop/Bridge authority 的 opaque compatibility reference |
| authorityScope | desktop-local、bridge、home-node 等 |
| credentialStatus | ready、missing、unavailable、unknown、none |
| credentialPolicy | required、optional、none |
| sourceClass | vault-v1、legacy-api-config、bridge-owned、local-runtime 等 |
| legacyPresence | 只记录 legacy field 是否存在，不记录值 |
| mappingDecision | resolved、unresolved、conflict、not-required |
| conflictState | none、historical-alternate、unresolved |

credentialRef 的 R8 规则：

- 不使用 raw key。
- 不使用 raw fingerprint。
- 不把 fingerprint 当作最终 production ID。
- 不落盘。
- 不自动覆盖任何现有 record。
- R8 compatibility reference 不等于最终 v2 persisted credentialRef。

## D. Legacy apiKey → credentialRef Mapping Strategy

映射顺序：

1. 如果已有 credentialRef：
   - 以 credentialRef 为首选。
   - 通过 Desktop/Bridge authority 得到 status。
   - legacy apiKey 不参与 status 决策。
2. 如果没有 credentialRef，但有稳定 bindingId：
   - 查询现有 authority compatibility projection。
   - Active Message 使用 characterId → Vault compatibility reference。
3. 如果只有 legacy apiKey：
   - 只允许 authority 内部进行一次性候选匹配。
   - raw key 不离开 authority，不进入日志、projection、report 或 migration artifact。
   - 唯一匹配才标记 resolved candidate。
   - 无匹配标记 unresolved。
   - 多匹配/来源冲突标记 conflict，不自动选择。
4. 如果 endpoint 是 loopback/local 且 credentialPolicy=none：
   - 标记 none，不创建 credentialRef。
5. 如果属于 Bridge/Home Node：
   - 不映射到 Desktop Local Authority。
   - 按各自 authority scope 处理。

R2 已经将 12 个 same-ID/different-fingerprint source conflicts 判为 VAULT_CURRENT，因此本次 dry-run 将它们视为已解决的 historical alternate provenance，不计入新的 unresolved conflict。

## E. Dual-Read Strategy

R8 只设计 dual-read，不实现 production migration：

### E1. Primary path

    credentialRef
      ↓
    authority status
      ↓
    ready/missing/unavailable/unknown/none

如果 credentialRef 存在，UI/consumer 只读 status projection；不读取 apiKey。

### E2. Legacy compatibility path

    no credentialRef
      ↓
    legacy binding/source lookup
      ↓
    compatibility candidate
      ↓
    status or unresolved/conflict

legacy fallback 的约束：

- 只在 authority/compatibility layer 内使用。
- 不将 legacy apiKey 回填到 frontend projection。
- 不以 legacy apiKey presence 伪造 ready。
- 不因 authority unavailable 而 fallback 到 cfg.apiKey。
- 不写 credentialRef。
- 不删除或清空 apiKey。

### E3. Projection shape

Frontend-facing projection 仍然只允许：

- credentialRef。
- authorityScope。
- credentialStatus。
- credentialSecretPresent boolean。
- sourceClass。
- stable errorCode。

Stored API Config 可以暂时保留 legacy apiKey，但 projected API Config 不包含它。

## F. Consumer Preparation

### F1. apiConfigs

- 当前 stored apiConfigs 可能仍带 apiKey。
- R6 list projection 已不再使用 cfg.apiKey 判断 status。
- R8 mapping 保留 apiConfigId/bindingId，候选 credentialRef 只在 dry-run 内生成。
- 不改 IndexedDB，不自动写 credentialRef。

### F2. Active Message

- characterId 是当前稳定 binding。
- R5 adapter 使用 Vault has() 生成 read-only compatibility status。
- 21 个 credential-required bindings ready。
- char_bgai 为 none。
- Active execution 仍使用既有 Vault get() 路径，R8 不接管。

### F3. Middle Brain

- policy/config 继续由 apiSettings['middle_brain'] 管理。
- R7 owner-side wrapper 不读取 apiKey 判断 status。
- 无 credentialRef 时返回 unknown/CREDENTIAL_REF_MISSING；disabled policy 返回 none。
- 不迁移 legacy Middle Brain key，不改变 Astra/Admission/Integrity execution。

### F4. Image Router

- route 继续只保存 apiConfigId/model/fallback metadata。
- R7 imageRouteStatus 通过 apiConfigId 查询 Desktop status projection。
- resolveRoute/provider execution 仍保持既有路径。
- 不将 imageGenApiKey/apiKey 写入 route projection。

### F5. Legacy browser voice

- voiceTrans 仍是独立 legacy browser boundary。
- voice profile 只保存 source/profile metadata。
- TTS/ASR/Voicebox/Edge ownership 不转移到 Desktop Local。
- R8 不写 voice credentialRef，不改 Bridge config。

## G. Migration Dry-Run

Dry-run 只输出以下 aggregate：

| Metric | Result |
|---|---:|
| Candidate bindings | 22 |
| Resolved | 22 |
| Unresolved | 0 |
| Conflict | 0 |

Resolved breakdown：

- credential-required ready：21。
- no-credential-required：1（char_bgai）。
- unresolved required：0。
- new unresolved conflict：0。

历史冲突说明：

- R2 已处理 12 个 same-ID/different-fingerprint conflicts。
- 12 条 recovery side 仍保留为 historical alternate provenance。
- 它们不在 R8 dry-run 中重新选择，也不产生新的 conflict。

Consumer counts：

| Consumer/source | Current metadata refs |
|---|---:|
| Current profile apiConfigs | 0 |
| Middle Brain credentialRef refs | 0 |
| Image Router route refs | 0 |
| Active Message live bindings | 22 |
| legacy browser voice refs | 0 |

R8 dry-run 没有输出角色名、provider secret、fingerprint、key、prefix/suffix 或完整 credential record。

## H. Safety and Invariance

R8 使用：

- R5 read-only adapter。
- Active metadata keys。
- isolated WebView metadata audit baseline。
- in-memory candidate mapping。

R8 没有调用：

- credentialVault.get()。
- credentialVault.all()。
- credentialVault.upsert/save/remove/migrateFromState。
- POST /credentials。
- provider/model endpoint。

R8 生产写入：

- credential writes：0。
- business-data writes：0。
- IndexedDB/localStorage migration writes：0。
- Bridge/Home Node writes：0。
- provider calls：0。

## I. Conflict and Fallback Rules

| Situation | Dry-run decision |
|---|---|
| credentialRef exists and authority ready | resolved |
| credentialRef exists but authority unavailable | unresolved |
| stable binding maps uniquely to current Vault | resolved candidate |
| no binding and no credential required | not-required |
| legacy key has no authority match | unresolved |
| legacy key matches multiple authority candidates | conflict |
| R2 historical alternate already decided | no new conflict |
| provider validity unknown | keep status ready/unknown semantics; no network validation |

R8 不将 unavailable、unknown 或 conflict 自动变成 missing，也不自动选择“能用的 key”。

## J. R9 Boundary

R9 需要显式批准后才能开始。

R9 之前禁止：

- persisted credentialRef migration。
- API Config schema write migration。
- legacy apiKey deletion。
- Vault cleanup。
- recovery artifact deletion。
- emergency mirror cleanup。
- provider execution convergence。
- Backup v2 implementation。

## Closure Gate

R8 migration preparation complete.

- All five credential consumer classes audited。
- credentialRef binding schema defined。
- legacy apiKey → credentialRef mapping strategy defined。
- credentialRef-first / legacy-fallback dual-read strategy defined。
- metadata-only dry-run executed。
- candidate bindings：22。
- resolved：22。
- unresolved：0。
- conflict：0。
- production data writes：0。
- provider calls：0。

R9 may begin only after explicit approval.
