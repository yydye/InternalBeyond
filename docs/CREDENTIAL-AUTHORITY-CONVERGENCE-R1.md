# Credential Authority Convergence R1

审计日期：2026-09-22（Asia/Shanghai）

R0 状态：DEGRADED  
R1 状态：DEGRADED

本阶段完成了 authority inventory、角色/配置/凭据关系核对、指纹去重和隔离 staging restore simulation。没有执行生产恢复、导入、迁移、重发、删除、provider 网络验证或真实请求。没有输出完整 API key、Authorization、Bearer token、完整 credential JSON 或可逆密文。

## A. Scope

R1 的范围是：

- 确认 Active Message、Web UI、legacy snapshot、recovery JSON、Middle Brain、Image Router、Bridge、TTS/ASR 和 Home Node 的凭据边界。
- 通过 file:line 证据建立 Credential Authority Graph。
- 用 characterId、roleId、configId、provider、model、endpoint presence 和单向指纹完成关系映射。
- 在临时 staging root 中只复制凭据恢复所需文件，进行不写回生产的重建和一致性模拟。
- 只设计 Credential Authority v2，不实现迁移。

硬边界：

- 真实 credential-vault.json、credential-vault.key、IndexedDB、localStorage、Home Node DB、Bridge config、active-message-service.json、角色数据均未修改。
- 没有把 recovery JSON 导入任何运行时。
- 没有向 provider 发送任何真实 key，也没有发起 provider 网络验证。
- 所有输出只保留 provider、ID、presence、count 和不可逆的临时 fingerprint alias。

## B. Existing Authority Inventory

按 R1 要求，当前审计到 8 个 credential domain/source boundary；其中 5 个是实际保存或持有 secret 的 authority，legacy/recovery 是来源层，Image Router 是引用层。

| Domain | Current Authority | Data Location | Canonical? | Migration Need |
|---|---|---|---|---|
| Active provider credential | Active credential vault | %LOCALAPPDATA%\InternalBeyond\credential-vault.key + credential-vault.json；active/credential-vault.js:19-20,75-129；services/active-message-service.js:151-160 | 是，Active Message runtime canonical | KEEP；作为 v2 local authority 的后端候选 |
| Web UI provider config | IndexedDB apiConfigs + fallback mirror | InternalBeyondDB apiConfigs；assets/js/social.js:779-841,1297,1380-1383 | 是，Browser UI config authority；当前现场为空 | MIGRATE；保留 metadata，最终以 credentialRef 替代直接 apiKey |
| Legacy character credential | character.apiKey | active-message-service.json 中的 tasks/plans/moments character；active/credential-vault.js:114-129；active/moments.js:31-39 | 否，仅 migration/fallback | DEPRECATE；保留只读兼容直到迁移边界关闭 |
| Recovery import source | apiConfigs_recovery_import.json | %LOCALAPPDATA%\InternalBeyond\apiConfigs_recovery_import.json | 否，quarantined recovery source | KEEP 暂存；核验后再 DEPRECATE/REMOVE LATER，不在 R1 覆盖 |
| Middle Brain/Astra credential | Private middle_brain API setting | apiSettings['middle_brain']；assets/js/middle-brain-config.js:5,102-120,181-204,520-528 | 是，Middle Brain 自己的 authority；不属于 role vault | KEEP separate；未来可迁入本机 authority，但不与角色 key 混库 |
| Image Router credential reference | image_router route metadata | apiSettings['image_router'].routes；assets/js/image-router-config.js:1-18,60-100 | 否，只有引用层 | KEEP metadata；MIGRATE route apiConfigId 指向 v2 config |
| Bridge/TTS/ASR/local voice | Bridge config and local Voicebox boundary | %LOCALAPPDATA%\InternalBeyond\bridge\config.json；bridge/config.js:33-67,146；bridge/tts.js:10-13,307-371；assets/js/communication/voice.js:35-80 | 是，Bridge-local authority；角色只保存 source 引用 | KEEP separate；不要并入角色 provider vault |
| Home Node service credential | Desktop pairing credential | %LOCALAPPDATA%\InternalBeyond\home-node\desktop-credential.json；services/home-node-service.js:129-131,1511-1513 | 是，Home Node service authority；不是 provider API key | KEEP separate；不参与 provider key 恢复 |

现场补充：

- canonical vault 解密成功，121 entries、23 unique credentials。
- recovery import 有 14 条 key-bearing records、14 unique credentials。
- current HTTP WebView apiConfigs 为 0 条，fallback mirror 不存在。
- Bridge config 中 tts、ttsMimo、voiceAsr、proactive 的 apiKey 当前均为空；Bridge top-level token 为空。
- Bridge config 的 music.kugouCookie 当前存在，但它是音乐服务 cookie，不计入 provider API key 指纹。
- Home Node desktop token 当前存在，但属于本机服务鉴权。

## C. Credential Graph

### C1. Role、API Config 与 Active Vault

代码关系是：

Role/character ID  
→ Web UI apiConfigs.id  
→ Active sync characterId  
→ credential-vault characterId key  
→ Active Message runtime provider/model/endpoint。

证据：

- assets/js/active-diary.js:106-108,126-141,626-627 以 apiConfigs.id 作为 characterId/apiConfigId。
- active/http.js:219-243 的 /credentials endpoint 按 characterId 写 vault，明确不按 nickname、provider 或 model 合并。
- active/credential-vault.js:23,75-97 以 characterId 为 vault key，并把 provider、endpoint、model 与 apiKey 同一条 credential record 保存。
- active/moments.js:34-39 优先按 character.id/characterId 从 vault 取 credential；只有 vault 无记录才回退 snapshot character.apiKey。

### C2. 角色是否直接保存 key

存在两条不同答案：

- 业务 snapshot 的新写入路径不应保存 key：active/http.js:82-87、active/plan-domain.js:469 会剥离 apiKey。
- Web UI apiConfigs 当前 schema 仍直接保存 apiKey：assets/js/social.js:1297 创建 cfg 时写入 apiKey，assets/js/social.js:1380-1383 还会校验保存后的 apiKey。

当前 active-message-service.json 的实际现场只有 2 个 legacy character.apiKey 字段，均为空；没有观察到仍依赖非空 legacy key 的角色。

### C3. credentialRef 是否存在

当前 recovery records 中 credentialRef 字段数量为 0；现有 Web UI persistence 也直接使用 apiKey，没有独立 credentialRef authority。R1 因此确认 v2 需要新增明确的 credentialRef 层，但本阶段不实现。

### C4. Middle Brain

Middle Brain 不使用角色 credential vault 作为自己的配置源：

- assets/js/middle-brain-config.js:102-120 从 apiSettings['middle_brain'] 读取 endpoint、model、apiKey，并独立判断 middleBrainReady。
- assets/js/middle-brain-astra.js:127-150,221-259 使用该独立配置发起 Astra 请求。
- services/home-node/middle-brain.js:25-30,296-318 明确把 Home Node 投影中的 apiKey 固定为空；Home Node 不持有 Middle Brain credential，Astra 在 Node 侧恒未就绪并回落本地 pipeline。

### C5. Image Router

Image Router 不建立第二套 secret store：

- assets/js/image-router-config.js:1-18、60-100 把 route 持久化在 apiSettings['image_router']，route 只保存 apiConfigId/model/fallback。
- assets/js/image-router-config.js:136-218 通过 apiConfigId 找到已有 apiConfig，并从 imageGenApiKey 或 apiKey 解析执行凭据。

因此 Image Router 的 provider key 依赖 UI apiConfigs/v2 apiConfig，不依赖 Home Node 或独立 image secret store。

### C6. Voice/TTS/ASR

- 角色 voice 只保存 source/profile 引用；bridge/tts.js:10-13、assets/js/social.js:1358-1360 明确禁止角色复制 endpoint/apiKey。
- OpenAI-compatible TTS 和 MiMo TTS 的凭据来自 Bridge config.json 的 tts、ttsMimo 区块。
- voiceAsr 的 API key 也在 Bridge config 的 voiceAsr 区块，代码注释明确不发送到浏览器。
- 直接浏览器语音转写另有 apiSettings['voiceTrans'] 路径，assets/js/communication/voice.js:35-80；它是独立的浏览器能力配置。
- Voicebox 是 local-runtime，不要求 provider API key。

## D. Role Mapping

角色引用从 Active Message 的 moments、plans、events、history 中按 characterId/character_id 去重：

| Role reference source | Unique IDs | Canonical vault match |
|---|---:|---:|
| moments | 21 | 21 |
| plans | 2 | 1 |
| events | 12 | 11 |
| history | 1 | 0 |
| union | 22 | 21 |

结果：

- 当前 Active 状态观察到 22 个 unique role/character references。
- 其中 21 个能通过相同 ID 解析到 canonical vault。
- 1 个未解析角色是 char_bgai；它的 legacy character.apiKey 字段存在但为空，没有可用 legacy fingerprint。
- 21 个 vault-backed live roles 使用 16 个 unique credential fingerprints。
- canonical vault 的 121 entries 是历史/运行时 credential entries，不能直接等同于 121 个 live roles。

这是 R0 “角色数量未知”问题的可计算部分；当前 WebView apiConfigs 为空，所以无法从 UI 当前配置还原完整历史角色目录。

## E. Config Mapping

### E1. Canonical 与 recovery ID 关系

- canonical vault config/character IDs：121。
- recovery import config IDs：14。
- recovery-only IDs：0；14 个 recovery IDs 全部存在于 canonical vault ID 集合。
- vault-only IDs：107。
- 同 ID 且 fingerprint 相同：2。
- 同 ID 但 fingerprint 不同：12。
- unique fingerprint overlap：3。
- unique fingerprint union：34。

结论：recovery JSON 不是可以直接覆盖 canonical vault 的同构副本。12 个同 ID 冲突必须保留为待决 mapping，不允许用 recovery source 盲覆盖。

### E2. 当前 UI Config

当前隔离读取的 HTTP WebView profile：

- apiConfigs：0。
- ib_apiConfigsFallback_v1：不存在。
- 当前没有可直接读取的 UI configId→credentialRef mapping。

这表示“当前 UI 空”而不是“历史 121 个 config 全部丢失”；Active runtime 的 21 个 live role bindings 仍可从 vault 解析。

### E3. Image/Voice/Bridge mapping

- image_router route → apiConfigId → apiConfigs record → imageGenApiKey 或 apiKey。
- Role voice source → Bridge TTS source → Bridge config tts/ttsMimo/voicebox。
- voiceTrans → apiSettings['voiceTrans']，独立于角色 provider vault。
- Bridge config actual provider key fields tts、ttsMimo、voiceAsr、proactive 当前 presence 均为 false；music.kugouCookie 是另一个 secret class，presence 为 true。
- Middle Brain → apiSettings['middle_brain']，不经过 role apiConfigs。

## F. Fingerprint Deduplication

本节所有 fingerprint 只显示临时 alias，不显示真实摘要值。fp-001 至 fp-034 仅用于本次报告阅读，不是持久化 ID。

| Source | Records / fields | Key present | Unique credential fingerprints |
|---|---:|---:|---:|
| canonical credential-vault | 121 | 121 | 23 |
| recovery import | 14 | 14 | 14 |
| legacy snapshot character.apiKey | 2 fields | 0 | 0 |
| current UI apiConfigs | 0 | 0 | 0 |
| current live Active roles | 21 resolved role bindings | 21 | 16 |

关系核对：

- canonical vault 与 recovery import 的 fingerprint overlap 为 3。
- recovery import 的 14 个 ID 均可在 vault 找到，但 12 个 ID 对应的 fingerprint 不同。
- vault-only unique fingerprints 为 20。
- recovery-only unique fingerprints 为 11。
- 两来源 union 为 34。

没有把 fingerprint alias 写入任何生产文件，也没有根据 fingerprint 选择覆盖源；staging 只验证 canonical-first 的候选策略。

## G. Staging Restore

已创建并执行临时 isolated staging root，位置位于系统临时目录，不是生产数据目录。

只复制了：

- credential-vault.key
- credential-vault.json
- apiConfigs_recovery_import.json

没有复制聊天、memory、relationship、diary、moments 内容、个人资料或 Home Node DB。Active role mapping 只在内存中读取，并生成不含 key 的最小 role metadata。

staging 过程：

1. snapshot：复制三份允许的凭据恢复材料。
2. decrypt：在 staging copy 中解密 canonical vault。
3. import candidate：在 staging memory 中读取 recovery records。
4. reconstruct：从 canonical vault 构造 121 条 metadata-only apiConfig candidates。
5. attach：为每条 candidate 分配临时 credentialRef alias；没有物化 apiKey 字段。
6. role binding：将 22 个 live role refs 绑定到 canonical vault。
7. consistency report：记录冲突、未解析角色和 source precedence。
8. cleanup：staging root 与临时 metadata 已清理。

staging 安全结果：

| Check | Result |
|---|---|
| Production writes | 0 |
| Provider calls | 0 |
| Real IndexedDB/localStorage writes | 0 |
| Raw credential printed | false |
| Raw credential written to metadata | false |
| User personal data copied | false |

## H. Recovery Simulation

模拟采用 canonical credential-vault-first，不把 recovery JSON 写回任何 authority：

- vault 内部解密：通过。
- recovery IDs 是否都能在 canonical vault 找到：通过。
- metadata-only apiConfig reconstruction：121 条，121 条都有临时 credentialRef alias。
- role binding：22 个 role refs 中 21 个解析成功，1 个未解析。
- source conflict：12 个同 ID 不同 fingerprint。
- staging infrastructure：通过。
- overall consistency gate：未通过，因此 R1 仍为 DEGRADED。

失败项不是解密失败，而是两个待决条件：

1. char_bgai 没有 canonical vault credential，legacy apiKey 也为空。
2. recovery JSON 与 canonical vault 存在 12 个同 ID fingerprint conflicts。

没有把这两类结果转化为生产导入或重发决定。

## I. Missing Credential Analysis

当前可证明的 missing 情况只有：

- 1 个 live role reference（char_bgai）没有 canonical vault credential。
- 该角色也没有非空 legacy apiKey。
- 该角色是否是已停用/诊断/测试角色，现有只读证据不能判定。

当前不能判定的情况：

- 不能把当前 UI apiConfigs=0 直接当作 121 个 credential 丢失。
- 不能把 12 个 source conflicts 当作 12 个缺失 key；它们都有本地材料，但 authority 尚未选择。
- 不能用 provider 网络验证来证明某个 key 已失效，因为 R1 明确禁止网络请求。

因此：

- unique live role refs：22。
- canonical-resolved live roles：21。
- unresolved live role refs：1。
- unique credentials required by resolved live roles：16。
- recoverable canonical credentials：23 unique。
- recoverable source union：34 unique candidates。
- provider credential reissue minimum：0。
- exact provider credentials requiring reissue：UNKNOWN，必须等 authority conflict 与 char_bgai 语义确认。

## J. Backup Contract

当前代码存在三种不同用途，必须在契约上明确区分：

1. 普通 JSON export：assets/js/core.js:998、1035-1051 走 _ibBuildRedactedExportData 和 _ibScrubSecrets，预期不含 API key。
2. emergency local mirror：assets/js/core.js:1117-1120 为同源灾备保留完整 apiKey，属于本机恢复材料，不是普通备份。
3. encrypted .ibvault：assets/js/local-vault.js:11-14,83-127,154-199 对完整 data 做 PBKDF2 + AES-GCM 加密，理论上包含完整 recovery data 和 secrets。

R0/R1 现场还发现 apiConfigs_recovery_import.json 以明文 JSON 形式存在，是当前主要 static recovery exposure；本阶段没有删除或导入。

未来契约建议：

- 一个统一 container schema，按 export policy 标注 redacted/full-recovery，而不是两套互不相容的数据模型。
- 普通备份永远没有 API key、secret、token。
- 加密备份包含完整恢复数据，但只在本地解密，密码不上传、不落日志。
- import 必须在 staging 中先完成 schema、fingerprint、ID mapping 和 transaction check。
- import 错误必须区分 WebCrypto、binary rejection、file parse、password/authentication、transaction stages。

## K. Future Authority v2

只设计，不实现：

Role  
→ apiConfigId

API Config  
→ provider/model/endpoint/metadata  
→ credentialRef

Credential Authority  
→ encrypted secret record

执行边界：

- Frontend/UI 只能读取 role/config metadata 和 credential presence/status，不能读取 secret。
- Frontend 只能 request execution。
- Local Authority 负责 decrypt、attach auth、provider request、redacted telemetry。
- Active Message、Browser chat、Image Router 共享 stable apiConfigId/credentialRef contract，但不共享明文 secret。
- Middle Brain 作为独立 capability authority，可复用 Local Authority 的执行 seam，但不把角色 key 写入 Middle Brain config。
- Bridge TTS/ASR/Voicebox 和 Home Node desktop token 保持独立 authority，不强行合入 provider role vault。

## L. Security Findings

### L1. Plaintext storage

- Web UI apiConfigs 的现有 schema 直接保存 apiKey；assets/js/social.js:1297、1380-1383。
- emergency local mirror 直接保留 apiKey；assets/js/core.js:1117-1120。
- apiConfigs_recovery_import.json 当前是可解析的 key-bearing JSON。
- Middle Brain 的 apiSettings['middle_brain'] 代码路径直接保存其独立 apiKey；assets/js/middle-brain-config.js:102-120,520-528。
- Bridge config 是 Bridge-local secret authority；当前 tts/ttsMimo/voiceAsr/proactive apiKey 为空，但 music.kugouCookie 存在。
- canonical Active vault 仍为 AES-256-GCM 加密落盘。

### L2. Debug/prefix leakage

assets/js/communication.js:5759-5771 在显式 debug 开启时仍记录 Authorization 的 key 前缀。它不是完整 key，但属于 prefix leakage。

### L3. Backup/export leakage

- 普通 export 已做 secret scrub。
- emergency mirror 与 recovery JSON 保留完整 key。
- local-vault encrypted export 的 plaintext 输入包含 full data，符合恢复用途，但需保持本地解密和密码边界。

### L4. R1 action

本阶段只登记，不顺手修改任何源码、配置或日志实现。

## M. Migration Boundary

| Artifact | Classification | Boundary |
|---|---|---|
| character.apiKey | DEPRECATE | 只保留迁移/兼容读取；禁止新增业务写入；当前发现 2 个空字段、0 个非空 legacy key |
| IndexedDB apiConfigs | MIGRATE | 保留 config metadata 与 stable id；未来移除直接 apiKey，改用 credentialRef |
| credential-vault | KEEP | 当前 Active runtime canonical；作为 v2 local encrypted authority 候选 |
| apiConfigs_recovery_import.json | KEEP（quarantine）→ DEPRECATE → REMOVE LATER | R1 不覆盖、不删除；待冲突核验和加密备份确认后再处理 |
| Bridge config | KEEP separate | TTS/ASR/Voicebox/音乐等 Bridge-local secret 不并入角色 provider vault |
| apiSettings['middle_brain'] | KEEP separate → future authority seam | Middle Brain 独立 credential domain，不与角色配置混淆 |
| apiSettings['image_router'] | KEEP metadata / MIGRATE reference | 只保存 route 与 apiConfigId，不建立第二份 secret |
| Home Node desktop credential | KEEP separate | 仅用于 Home Node service pairing/auth，不作为 provider key |

不执行删除、不执行迁移、不执行重命名；以上只是边界分类。

## N. Remaining

1. 确认 char_bgai 是否为仍需运行的角色；在确认前不重发 key。
2. 对 recovery import 与 canonical vault 的 12 个 same-ID fingerprint conflicts 做业务 authority decision；不允许自动覆盖。
3. 若需要完整 UI 历史角色盘点，应在用户批准后对外部旧 profile 做只读 profile inventory；当前 profile 的 apiConfigs 已为空。
4. 独立审计 Middle Brain apiSettings['middle_brain'] 的实际 record presence；不把它混入 role provider key 数。
5. 继续保持 Bridge TTS/ASR/Voicebox、music cookie、Home Node token 的独立生命周期。
6. 修复未来的 debug prefix leakage、普通备份文案和加密备份阶段错误码；本阶段不修改。
7. R1 结束后再决定是否进入获批的 R2 staging restore；在此之前不得进入真实迁移。
8. 不进入 Android、P33，不 push。

## Closure Gate

**R1 = DEGRADED。**

已完成：

- Credential Authority Graph 已建立。
- Role/API Config/Credential 的真实 ID 关系已核对到可见范围。
- canonical vault、recovery source、legacy snapshot、当前 UI storage、Bridge、Middle Brain、Image Router、Voice/TTS/ASR 和 Home Node 边界已分类。
- isolated staging restore simulation 已执行，生产写入为 0、provider calls 为 0、secret 输出为 0。
- 当前 live role refs 为 22，canonical resolved 为 21，unresolved 为 1；live unique credentials 为 16。
- canonical unique credentials 为 23，recovery unique credentials 为 14，两来源 union 为 34。

未完成：

- 12 个 same-ID fingerprint conflicts 尚未获得 authority decision。
- char_bgai 的业务语义尚未确认。
- 没有执行真实 restore、migration 或生产收敛。

因此 R1 不得宣称 PASS，也不得进入真正迁移。下一步只能在明确授权后继续 staging 级冲突处理；当前 provider credential reissue minimum 仍为 0。
