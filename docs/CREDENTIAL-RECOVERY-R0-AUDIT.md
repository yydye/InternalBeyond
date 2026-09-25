# InternalBeyond Credential Recovery — Phase R0 Audit

审计日期：2026-09-22（Asia/Shanghai）

审计状态：DEGRADED

本报告只记录只读取证结果。取证期间没有恢复、导入、重发、删除、迁移、清空、真实业务数据写入或向任何模型/供应商发起凭据校验请求。凭据值、完整 JSON、完整指纹和任何可逆密文均未写入本报告。

## A. 事件与目标

本阶段目标是确认旧 API 凭据是否仍存在、定位各类凭据的真实权威来源、检查普通备份与加密备份的可恢复性，并在不改变现场的前提下给出后续恢复边界。

已完成：

- 盘点 InternalBeyond 自有数据目录、当前安装版 WebView profile、Active Message runtime、Home Node 和 Bridge 代码路径。
- 在内存中解密并统计当前 credential-vault.json，只输出数量、长度类别和单向指纹统计。
- 在内存中读取并统计 apiConfigs_recovery_import.json，没有输出任何密钥值。
- 对当前 WebView profile 做隔离副本读取，避免向原始 IndexedDB 或 Local Storage 写入。
- 检查凭据日志暴露路径和备份/导入代码契约。

未执行：

- 没有向供应商网络发起请求。
- 没有把任何候选凭据恢复到 IndexedDB、credential-vault、Bridge 或其他运行时。
- 没有要求用户提供加密备份密码，因为已审计的 InternalBeyond 自有目录中没有找到可供解密的 .ibvault 文件。

## B. 凭据权威定义

当前代码把凭据分成几个不同边界，不能合并为一个“全局 API 配置”：

1. Active Message 的 provider/API 凭据权威是 active/credential-vault.js 创建的加密 vault。
   - 数据目录中的文件是 credential-vault.key 与 credential-vault.json。
   - credential-vault.json 使用 AES-256-GCM；本地 key 文件保存 32-byte key 的 Base64 表示。
   - active-message-service.js:151-160 载入 vault，并以旧业务 snapshot 的 character.apiKey 做幂等迁移兼容。
2. Web UI 的 API 配置权威是浏览器 IndexedDB InternalBeyondDB 的 apiConfigs store，assets/js/social.js:779-841 负责持久化和读取。缺失时才使用 ib_apiConfigsFallback_v1 镜像。
3. Web UI 的 /credentials bridge 会把角色 provider/API 凭据写入 Active Message vault；active/http.js:82-87,219-243 明确把业务 snapshot 中的 apiKey 剥离。
4. Voice/TTS/ASR、Bridge 配对 token 和 Home Node desktop token 是独立权限/凭据域。它们不能因为字段名相似就并入 provider API key 的重发统计。
5. 旧业务 snapshot 中的 character.apiKey 只是 migration/recovery fallback，不再是新写入路径；active/moments.js:31-39 仍保留兼容读取。

## C. 权威关系图

Web UI apiConfigs（IndexedDB）
        │
        ├─ /credentials ──> Active credential-vault
        │                         │
        │                         ├─ Active Message runtime
        │                         ├─ moments / scheduler / execution
        │                         └─ business snapshot 不应再持久化 apiKey
        │
        └─ 普通导出/自动备份 ──> 脱敏 JSON（预期不含 API key）

加密备份 .ibvault
        └─ full _ibBuildExportData ──> PBKDF2 + AES-256-GCM ──> 导入后重新进入 apiConfigs

Bridge TTS/TTSMimo、Home Node desktop token、Voicebox
        └─ 独立 authority，不纳入 provider vault 统计

## D. 现场凭据库存

| 来源 | 现场元数据 | 只读结果 | 分类 |
|---|---:|---|---|
| %LOCALAPPDATA%\InternalBeyond\credential-vault.key | 44 bytes，存在 | 可作为当前 vault 的本地解密 key | 可恢复 |
| %LOCALAPPDATA%\InternalBeyond\credential-vault.json | 31,150 bytes | AES-GCM 解密成功；121 个 character entries；全部 121 条有 apiKey；23 个唯一单向指纹 | 可恢复，canonical |
| %LOCALAPPDATA%\InternalBeyond\apiConfigs_recovery_import.json | 38,780 bytes | 14 个 apiConfigs records；14 个记录均有 key；14 个唯一单向指纹 | 可恢复，待人工确认的 recovery source |
| %LOCALAPPDATA%\InternalBeyond\active-message-service.json | 业务 snapshot | 递归 credential-field 检查只见到空/缺失字段，没有发现可直接恢复的 key 值 | 非凭据权威 |
| 当前 HTTP WebView origin 的 IndexedDB apiConfigs | 隔离副本读取 | 0 条；ib_apiConfigsFallback_v1 不存在 | 当前浏览器配置为空 |
| 当前 Tauri origin 的 IndexedDB | 隔离副本读取 | 没有可枚举的 InternalBeyondDB；原始 profile 的对应 LevelDB 也没有命中凭据字面量 | 未发现可恢复 provider key |
| 已审计的 InternalBeyond 自有目录中的 .ibvault | 文件名扫描 | 未找到 | 未发现加密备份文件 |

说明：vault 的 121 条是 character-ID entry 数，不等于 121 个不同的 API key；去重后为 23 个唯一凭据指纹。

## E. 普通导出/自动备份契约

代码层面的预期是：

- assets/js/core.js:998 的普通导出调用 _ibBuildRedactedExportData()，界面提示不含 API key。
- assets/js/core.js:1035-1051 的 _ibScrubSecrets() 会清除 apiKey、Authorization、token、secret、password、bearer 等字段。
- assets/js/core.js:1064-1067 的自动备份使用脱敏导出。
- assets/js/core.js:1172 的 filesystem sync 也使用脱敏导出。

同时存在一个必须在后续修复的契约歧义：

- assets/js/core.js:1117-1120 明确让本地 emergency mirror 保留完整 apiKey，用于 IndexedDB 意外清空时的同源恢复；这是本机恢复源，不应被当作普通备份。
- assets/js/local-vault.js:319-326 的 UI 文案仍笼统写成普通 JSON 会包含 API 密钥，与当前 exportAll() 的脱敏实现不一致。

因此，不能仅凭“普通 JSON 导出失败/成功”推断凭据是否存在；必须区分普通脱敏导出、同源 emergency mirror 和 .ibvault 全量加密导出。

## F. 加密备份契约

assets/js/local-vault.js 定义的 .ibvault 格式为 InternalBeyondEncryptedBackup，version 1：

- PBKDF2-SHA-256，310,000 iterations，随机 16-byte salt。
- AES-GCM-256，随机 12-byte IV。
- 明文输入是 _ibBuildExportData() 的完整 JSON，因此理论上包含 apiConfigs 内的 API key。
- envelope 仅保存格式、版本、创建时间、KDF 参数、cipher 参数和 ciphertext。
- 解密成功后会回到普通导入流程，普通导入对 data.apiConfigs 调用 _persistApiConfig()。
- 导出时如果全量数据含 Blob/File/ArrayBuffer，findBinary() 会拒绝写入加密 JSON（assets/js/local-vault.js:64-72,176-182）。
- 解密错误在 assets/js/local-vault.js:127 汇总为“密码不正确，或备份文件已损坏”，现场缺少阶段化错误码。

当前 profile 的隔离检查显示 uploadedFiles=0，没有发现二进制记录；这不能证明历史导出时一定没有二进制，只能说明当前现场没有证据支持该原因。

## G. 加密备份失败根因判定

判定：UNKNOWN，不能在 R0 只读现场上安全归因。

已知证据：

- 当前 InternalBeyond 自有目录没有 .ibvault 文件。
- 当前 HTTP origin 没有 ib_vault_lastEncryptedBackup 或 ib_vault_lastEncryptedImport 元数据。
- 当前 profile 可以读出其他 IndexedDB store，但 apiConfigs 为空，说明当前浏览器存储与旧 vault/recovery file 已经不一致。
- 加密实现会把 WebCrypto、二进制拒绝、密码错误、文件损坏等多种情况压缩成用户不可区分的提示。

不能据此断言是密码错误、WebCrypto 不可用、二进制 payload、文件损坏、下载未落盘或导入阶段失败。R0 不猜测根因，也不通过重试或导入来改变现场。

## H. 恢复来源分类

### H1. RECOVERABLE_CANONICAL — 高可信

credential-vault.key 存在，credential-vault.json 能在内存中成功解密，得到 121 个 character entries、23 个唯一凭据指纹。它是 Active Message 当前代码定义的运行时凭据权威。

### H2. RECOVERABLE_BACKUP — 高/中可信

apiConfigs_recovery_import.json 可解析，包含 14 条 key-bearing apiConfigs 记录和 14 个唯一指纹。它不是当前普通导出路径生成的脱敏文件，且文件名表明它是恢复/导入用途；本阶段没有导入、删除或重写它。

### H3. METADATA_ONLY / EMPTY_CURRENT

当前 WebView 的 apiConfigs store 为 0，fallback mirror 不存在，当前加密备份 metadata 也不存在。它是“当前 profile 的空状态”证据，不等于旧凭据不存在。

### H4. SEPARATE_AUTHORITY

Bridge TTS/TTSMimo、Voicebox/local voice、Home Node desktop credential 和 Bridge 自身鉴权 token 需要独立审计。它们不应按 provider API key 的 34 个候选指纹计数。

## I. 浏览器存储取证

原始 Tauri/WebView profile 位于：

[local path redacted]

本阶段先把该 profile 复制到临时目录，再用独立 headless browser 对副本访问已有的 loopback HTTP origin，读取结果后删除副本；没有打开原始 profile 写事务。

隔离副本的 http://127.0.0.1:23120 结果：

- InternalBeyondDB version 24 存在。
- apiConfigs：0 条。
- ib_apiConfigsFallback_v1：不存在。
- ib_vault_lastEncryptedBackup：不存在。
- ib_vault_lastEncryptedImport：不存在。
- 其他普通数据仍可读取，例如 chatMessages=500、memories=11、about=1、apiSettings=1。
- uploadedFiles=0，没有发现当前二进制记录。

对原始 LevelDB 的字节级扫描仅作为旁证：HTTP origin 命中 provider/model/endpoint 相关字节，但没有 apiKey、credential token 或 sk- key-pattern；这不是 LevelDB record parser，不能据此恢复或否定任意单条记录。

## J. Tauri origin 取证

原始 profile 中存在以下 Tauri-origin IndexedDB 目录：

- http_tauri.localhost_0.indexeddb.leveldb
- 对应的 .blob 目录

在隔离副本上访问 http://tauri.localhost:23120/README.md 时，没有枚举到 InternalBeyondDB。对原始 Tauri LevelDB 做的只读字节扫描没有命中 apiConfigs、apiKey、credential token 或 sk- key-pattern。

结论：没有发现可直接恢复的 Tauri-origin provider key 证据；LevelDB 字节扫描本身不是完整内容解析，因此该结论限定为“本阶段没有发现”，不扩展为对所有历史 profile 的绝对否定。

## K. Home Node、Bridge 与文件系统边界

- Active Message runtime 由 services/active-message-service.js:151-160 直接装配 credential vault。
- home-node/home-node.db 是 Home Node 的聊天、记忆、理解、moments 等存储，不是 provider API credential authority。
- home-node/desktop-credential.json 是 Home Node desktop pairing/auth token，属于另一种本机服务凭据，不计入 provider API key 盘点。
- services/ib-bridge-service.js 有独立的 Bridge/provider 配置和 TTS/ASR/图像等请求路径；代码在 :311-314 对 provider apiKey 做掩码。Bridge config.json 及其备份需要在 R1 作为独立 authority 做定向审计，不能从当前 vault 统计推导。
- UI 的 image router 若引用已有 API Config，应沿 apiConfigs 关系恢复；Bridge voice/TTS 配置则按 tts/ttsMimo 等独立配置域处理。

## L. 备份文件与风险

### L1. credential-vault.json + credential-vault.key

这是当前 canonical runtime 的加密落盘材料。两者均存在，且 vault 解密成功。没有把明文写回文件或输出。

### L2. apiConfigs_recovery_import.json

该文件在本机以可解析 JSON 形式保存 14 条含 key 的 recovery records。它是高价值恢复材料，也是当前发现的主要静态明文凭据暴露面。R0 冻结期间不删除、不移动、不覆盖、不导入。

### L3. .ibvault

在已审计的 InternalBeyond 自有目录、仓库和已知 profile 相关位置没有找到 .ibvault 文件，因此目前没有可进行密码验证的具体文件。

## M. 指纹去重结果

所有指纹均为内存计算的单向摘要；本报告不记录指纹值。

| 来源 | records/entries | 有 key | unique fingerprints |
|---|---:|---:|---:|
| canonical credential vault | 121 | 121 | 23 |
| recovery import JSON | 14 | 14 | 14 |
| 两来源交集 | — | — | 3 |
| 两来源并集 | — | — | 34 |

canonical vault 的 provider 分布（第一列为 entry rows，第二列为 unique fingerprints）：

| provider | rows | unique |
|---|---:|---:|
| deepseek | 5 | 5 |
| glm | 2 | 2 |
| qwen | 3 | 3 |
| mimo | 5 | 4 |
| openai | 60 | 2 |
| custom | 44 | 5 |
| anthropic | 2 | 2 |

recovery import JSON 的 provider 分布：

| provider | rows | unique |
|---|---:|---:|
| deepseek | 5 | 5 |
| glm | 2 | 2 |
| qwen | 2 | 2 |
| custom | 5 | 5 |

## N. 可恢复性矩阵

| 来源 | 是否有可恢复材料 | 是否已恢复到运行时 | 是否有明文静态暴露 | R0 处理 |
|---|---|---|---|---|
| credential vault | 是 | 否 | 否，仍为加密落盘 | 只读内存解密统计 |
| recovery import JSON | 是 | 否 | 是，文件含 key-bearing records | 保留原样，不导入、不清理 |
| 当前 HTTP IndexedDB apiConfigs | 否，0 条 | 否 | 未发现 | 只读统计 |
| 当前 Tauri IndexedDB | 未发现 | 否 | 未发现 | 只读 profile/字节旁证 |
| .ibvault | 未找到文件 | 否 | 不适用 | 不要求密码、不猜密码 |
| Bridge TTS/voice/config | 独立来源，R0 未做全量恢复 | 否 | 未在本报告输出 | 留给 R1 定向审计 |
| Home Node desktop token | 有，但不是 provider API key | 否 | 不纳入 provider 统计 | 与本事件隔离 |

## O. 影响角色与重发下限

- canonical vault 有 121 个 character-ID entries，但不能把它们当作 121 个不同角色或 121 个不同 key。
- 当前浏览器 apiConfigs 为空，因此无法从当前 UI 配置计算“受影响角色数”或“缺 key 角色数”。
- 两个已审计 provider-key 来源合计 34 个唯一指纹候选，其中 canonical vault 23 个，recovery import 14 个，交集 3 个。
- 对这 34 个已发现的候选凭据，重发下限为 0；它们已有本地可恢复材料，不能因为当前 profile 为空就直接判定为丢失。
- 精确的“仍缺失/必须重发”数量仍为 UNKNOWN，必须在获批的 R1 中把角色 ID、配置 ID、provider、endpoint/model 与 canonical vault/recovery source 做事务式关系核对后才能计算。
- R0 不执行任何凭据重发，也不向供应商发起存活性验证。

## P. 日志与泄露审计

已发现一个低范围但真实存在的部分凭据暴露路径：

- assets/js/communication.js:5759-5771 只有在显式设置 localStorage.setItem('ib_debug_body','1') 时才启用请求调试日志；请求 body 会先做首尾截断，URL query key 也会脱敏，但 Authorization 日志仍会写入 key 的前 6 个字符再加 ***。
- 这不是完整 API key 泄露，但属于不必要的 key-prefix 暴露，应在后续修复为固定掩码或完全不记录。
- services/ib-bridge-service.js:311-314 会把 provider apiKey 置为 ***。
- services/home-node-service.js:148-161 对 apiKey、Authorization、token 和常见 key pattern 做掩码。
- 定向审计没有发现完整 provider API key 被写入普通生产日志的证据。

R0 不修改日志代码；部分前缀风险列入 R1/后续 hardening。

## Q. R0 安全边界核对

本阶段确认：

- 没有 restore/import 到任何真实应用存储。
- 没有写入 credential-vault.key、credential-vault.json、active-message-service.json、IndexedDB、Local Storage、Bridge config 或 Home Node DB。
- 解密仅在内存中完成；只输出统计信息。
- WebView 取证只对临时 profile 副本执行。
- 没有调用 provider API、没有发送候选 key、没有进行网络存活验证。
- 没有删除、清理或迁移旧凭据文件。
- 本轮临时取证脚本已移除；保留用户原有工作区和测试产物。
- 唯一新增的持久化产物是本审计报告本身，不含凭据值。

## R. R1 建议（未执行）

R1 只能在用户明确批准后执行，建议顺序如下：

1. 对 credential-vault.json、credential-vault.key、apiConfigs_recovery_import.json 和独立 Bridge authority 做只读快照/哈希登记。
2. 以 stable character/config ID 建立 source-to-role mapping；以 provider、endpoint、model 和单向指纹做去重确认。
3. 在隔离 staging profile 中先做事务式恢复演练，成功后再由用户批准进入目标运行时。
4. 恢复后重新读取并核对：角色数量、unique fingerprint 数、provider 分布、endpoint/model、Active Message /credentials 与 UI apiConfigs 的一致性。
5. 若用户之后提供外部 .ibvault 文件及其密码，再单独验证 envelope、解密阶段和增量导入，不把密码写入报告或日志。
6. 为恢复失败增加阶段化诊断：WebCrypto availability、payload binary rejection、download creation、file parse、password/authentication、import transaction，而不是统一显示为“密码错误或文件损坏”。

R1 的默认原则是零重发、零联网校验、可回滚；只有证据证明某个角色没有任何可恢复来源时，才进入供应商重发决策。

## S. 后续备份契约建议

- 普通 JSON、自动备份和 filesystem sync 必须保持脱敏，文案应明确“不含 API key”。
- emergency mirror 如继续保留完整 key，必须明确标为本机同源恢复材料，不能被用户误认为普通备份。
- .ibvault 必须明确标示“全量本地加密备份，包含 API key”；密码只由用户持有，不上传、不写日志。
- 导出/导入应持久化非敏感的阶段状态和错误码，但不持久化 key、密码或完整 payload。
- 加密备份测试应使用合成 key 和隔离 profile，覆盖空 payload、二进制 payload、错误密码、损坏密文、重复导入和事务回滚。
- 任何日志调试开关都不应记录完整 key 或稳定可关联的 key prefix。

## T. 待决事项

1. 是否存在未位于当前 InternalBeyond 自有目录中的外部 .ibvault 文件；R0 没有扫描用户全盘、浏览器密码管理器或无关应用目录。
2. apiConfigs_recovery_import.json 是否是用户认可的恢复源；R0 只证明它可解析且包含可恢复材料，不替用户做恢复选择。
3. 121 个 canonical character entries 与当前业务角色/config ID 的完整映射。
4. Bridge tts、ttsMimo、ASR、图像服务和其他独立 config 的定向凭据审计。
5. 当前 Tauri/HTTP origin 为空是否是安装版迁移、profile 切换、导入未完成或历史清理的结果；现有只读证据不足以判断。
6. 是否批准执行 R1 staging restore；在批准前不需要提供加密备份密码。

## Closure Gate

**R0 = DEGRADED。**

恢复证据目标已达成：旧凭据材料确实存在，canonical vault 可解密，recovery import JSON 也可读取；两个来源合计发现 34 个唯一凭据指纹候选，当前重发下限为 0。降级项是：历史 .ibvault 文件未找到、加密备份失败的确切历史根因无法从当前只读现场还原、当前空 WebView profile 与旧 vault 的角色映射尚未完成。

下一步不是重发或盲目导入，而是等待明确授权后执行可回滚、指纹核验的 R1 恢复。
