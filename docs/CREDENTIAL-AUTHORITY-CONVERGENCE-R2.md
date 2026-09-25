# Credential Authority Convergence R2

审计日期：2026-09-22（Asia/Shanghai）

R0：DEGRADED  
R1：DEGRADED  
R2：PASS

本报告完成了 12 个 same-ID/different-fingerprint conflict 的 provenance resolution、char_bgai 语义确认和 metadata-only canonical snapshot 构造。报告只包含 provider、模型元数据、时间元数据、角色/配置 alias、数量和决策；不包含 API key、key prefix/suffix、raw fingerprint、Authorization、Bearer token、完整 credential JSON 或可逆密文。

## A. Scope

R2 只处理：

- 12 个同 config/character ID、但 Vault 与 recovery fingerprint 不同的冲突。
- char_bgai 的业务语义和 credential requirement。
- staging-only、metadata-only canonical credential snapshot。
- 是否具备进入 Credential Authority v2 migration design 的证据条件。

R2 没有处理：

- 真实 restore、import、overwrite、migration、deletion 或 reissue。
- provider 网络验证、test API call、model call、Authorization/Bearer request。
- IndexedDB、localStorage、Home Node DB、Bridge config、apiSettings 或任何生产 runtime state。
- P32-W、Android、P33、Jev/Decision Plane、Storage Authority convergence 或 Backup v2 implementation。

Pre-flight：

- Branch：master，ahead 147。
- HEAD：e2d6e886fb1a1e27c5882236719f65c8dfd8e8e6。
- dirty worktree entries：263。
- untracked entries：197。
- 工作区已有改动全部保留；没有执行 reset、clean、restore、checkout、stash、commit 或 push。

## B. Safety / Production Invariance

本阶段所有凭据处理均在进程内读取或系统临时 staging 副本中完成。staging 只复制：

- credential-vault.key
- credential-vault.json
- apiConfigs_recovery_import.json

没有复制聊天、Memory、Relationship、Diary、Moments 内容、Role Letters、Activity、Home Node DB 或个人资料。

生产 invariance gate 结果：

| Artifact | Hash/stat unchanged |
|---|---|
| credential-vault.json | true |
| credential-vault.key | true |
| apiConfigs_recovery_import.json | true |
| active-message-service.json | true |
| Bridge config.json | true |
| Home Node desktop-credential.json | true |

最终安全计数：

- Production credential writes = 0。
- Production business-data writes = 0。
- Provider calls = 0。
- Raw key output = false。
- Raw fingerprint output = false。
- staging cleanup = complete。

IndexedDB/localStorage 仍只沿用 R0/R1 的隔离 profile 读取证据；R2 没有启动会修改原始 profile 的 runtime。

## C. R1 Baseline

R1 baseline 原样保留：

- canonical credential vault：121 entries，23 unique credential fingerprints。
- recovery import：14 key-bearing records，14 unique credential fingerprints。
- recovery 的 14 个 ID 全部存在于 canonical vault。
- same ID + same fingerprint：2。
- same ID + different fingerprint：12。
- 两来源 unique fingerprint union：34。
- current live Active role refs：22。
- canonical-resolved live roles：21。
- live unique credentials：16。
- unresolved role reference：char_bgai。
- provider credential reissue minimum：0。

R2 没有把 baseline 重新解释成“recovery 更新”或“Vault 必然历史正确”。本轮只根据当前 binding、源记录 metadata、代码写入语义和时间/版本证据做 authority decision；不判断任何 provider key 是否仍然有效。

## D. Conflict Inventory

12 个 conflict 的共同形态：

- 同一 character/config ID 在 Vault 与 recovery 各有一条 record。
- API key fingerprint 不同。
- provider、model、endpoint class、时间和当前 Active metadata 被分别比较。
- 所有 alias 都是本轮基于单向 fingerprint 的 deterministic alias；报告不输出原始 fingerprint。

总体计数：

| Property | Count |
|---|---:|
| Conflicts | 12 |
| Same-ID + same-fingerprint baseline | 2 |
| Same-ID + different-fingerprint | 12 |
| Recovery-only IDs | 0 |
| Vault-only IDs | 107 |
| Current Active live-used conflicts | 12 |
| Historical-only conflicts | 0 |

## E. Conflict Provenance Matrix

ID alias 按 conflict ID 排序生成，credential alias 按两来源 fingerprint 的排序结果生成。alias 不是生产 ID，也没有写回任何文件。

| Conflict | ID Alias | Vault Cred | Recovery Cred | Provider Vault/Recovery | Endpoint Class | Model Vault → Recovery | Vault updatedAt | Recovery created | Live | Metadata match | Decision | Evidence |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | id-001 | cred-023 | cred-006 | deepseek / deepseek | HTTPS remote default V1 | deepseek-flash → deepseek-v4-flash-vision-exp | 2026-09-21T08:51:09.840Z | 2026-08-31T16:00:00.000Z | yes | Vault=yes, recovery=no | VAULT_CURRENT | A current binding + B file order |
| 2 | id-002 | cred-016 | cred-009 | glm / glm | HTTPS remote default OTHER | glm-5.3-flash → glm-4-flash | 2026-09-21T08:51:09.843Z | 2026-08-31T16:00:00.000Z | yes | Vault=yes, recovery=no | VAULT_CURRENT | A current binding + B file order |
| 3 | id-003 | cred-014 | cred-005 | mimo / custom | HTTPS remote default V1 | mimo-v2.5 → mimo-v2.5 | 2026-09-21T08:51:09.850Z | 2026-08-31T16:00:00.000Z | yes | Vault=yes, recovery=no | VAULT_CURRENT | A provider/model current binding |
| 4 | id-004 | cred-032 | cred-026 | deepseek / deepseek | HTTPS remote default OTHER | deepseek-flash → deepseek-v4-flash-vision-exp | 2026-09-21T08:51:09.854Z | 2026-08-31T16:00:00.000Z | yes | Vault=yes, recovery=no | VAULT_CURRENT | A current binding + B file order |
| 5 | id-005 | cred-019 | cred-016 | glm / glm | HTTPS remote default OTHER | glm-5.3-flash → glm-4-flash | 2026-09-21T08:51:09.857Z | 2026-08-31T16:00:00.000Z | yes | Vault=yes, recovery=no | VAULT_CURRENT | A current binding + B file order |
| 6 | id-006 | cred-008 | cred-021 | mimo / custom | HTTPS remote default V1 | mimo-v2.5 → mimo-v2.5 | 2026-09-21T08:51:09.860Z | 2026-08-31T16:00:00.000Z | yes | Vault=yes, recovery=no | VAULT_CURRENT | A provider/model current binding |
| 7 | id-007 | cred-031 | cred-007 | mimo / custom | HTTPS remote default V1 | mimo-v2.5 → mimo-v2.5 | 2026-09-21T08:51:09.863Z | 2026-08-31T16:00:00.000Z | yes | Vault=yes, recovery=no | VAULT_CURRENT | A provider/model current binding |
| 8 | id-008 | cred-028 | cred-025 | deepseek / deepseek | HTTPS remote default V1 | deepseek-flash → deepseek-v4-flash-vision-exp | 2026-09-21T08:51:09.866Z | 2026-08-31T16:00:00.000Z | yes | Vault=yes, recovery=no | VAULT_CURRENT | A current binding + B file order |
| 9 | id-009 | cred-027 | cred-010 | mimo / custom | HTTPS remote default V1 | mimo-v2.5 → mimo-v2.5 | 2026-09-21T08:51:09.869Z | 2026-08-31T16:00:00.000Z | yes | Vault=yes, recovery=no | VAULT_CURRENT | A provider/model current binding |
| 10 | id-010 | cred-029 | cred-003 | deepseek / deepseek | HTTPS remote default V1 | deepseek-flash → deepseek-v4-flash-vision-exp | 2026-09-21T08:51:09.872Z | 2026-08-31T16:00:00.000Z | yes | Vault=yes, recovery=no | VAULT_CURRENT | A current binding + B file order |
| 11 | id-011 | cred-024 | cred-030 | deepseek / deepseek | HTTPS remote default V1 | deepseek-flash → deepseek-v4-flash-vision-exp | 2026-09-21T08:51:09.875Z | 2026-08-31T16:00:00.000Z | yes | Vault=yes, recovery=no | VAULT_CURRENT | A current binding + B file order |
| 12 | id-012 | cred-027 | cred-012 | mimo / custom | HTTPS remote default V1 | mimo-v2.5 → mimo-v2.5 | 2026-09-21T08:51:09.878Z | 2026-08-31T16:00:00.000Z | yes | Vault=yes, recovery=no | VAULT_CURRENT | A provider/model current binding |

关键证据是每个 conflict 的 current Active character metadata 都与 Vault 的 provider、model、normalized endpoint class 相同，而与 recovery record 不同。该证据只证明当前 authority/source 选择，不证明 key 的供应商有效性。

## F. Recovery Artifact Provenance

针对 apiConfigs_recovery_import.json 的结论：

1. 创建者：GENERATOR_UNKNOWN。
2. repo 中未找到以该文件名创建它的代码，也未找到 runtime 读取该文件名的路径。
3. 文件只包含 version 和 apiConfigs 顶层字段，没有 exportDate、source 或 migration marker。
4. schema version 为 8；每条 record 有 created 字段，但没有 updatedAt。
5. 14 条 record 的 created metadata 相同，解码为 2026-08-31T16:00:00.000Z。
6. 文件 mtime 为 2026-09-02T04:13:23.333Z。
7. 当前代码的历史 full export 在 commit 368bb8e（2026-08-27）仍使用 version 8；当前 core.js 已进入 version 9。
8. recovery record shape 与历史 apiConfigs export shape 一致，但文件是只保留 apiConfigs 的子集；不能证明它由当前 exportAll 自动生成。
9. 没有证据证明它曾成功同步到 /credentials。
10. 不能仅凭 recovery/import 文件名断言它“必然更旧”；本轮使用的是 schema、record metadata、file mtime 和 current binding 的组合证据。

最终分类：

- recovery 侧的 12 个冲突记录：HISTORICAL_ALTERNATE（作为非当前 alternate source）。
- recovery 侧没有证据支持 RECOVERY_CURRENT。
- 该历史 alternate 分类不表示文件损坏，也不表示 raw key 无效；只表示它没有当前 runtime binding，且其 metadata 与当前 Active/Vault binding 不一致。

## G. Vault Write Semantics

代码审计确认 Vault 正常路径可以产生当前观察到的 divergence：

- active/credential-vault.js:75-91 的 upsert 以 characterId 为唯一 key。
- incoming apiKey 为空时保留已有 non-empty key；没有 key 时整条 upsert 返回 false。
- provider、endpoint、model 和 apiKey 在一次 upsert 中写入；updatedAt 每次 upsert 都更新。
- save() 使用临时文件后 rename；单次成功写入替换整个加密 envelope。
- active/http.js:219-243 的 POST /credentials 只写 Vault，不写业务 state；按 characterId 存取，不按 nickname/provider/model 合并。
- services/active-message-service.js:151-160 的 startup migration 只从非空 legacy character.apiKey 迁移，且已有有效 Vault entry 时跳过。
- 当前 active state 的 legacy apiKey 字段为空，因此本次 12 个冲突不是由当前 char_bgai/legacy migration 产生。
- assets/js/active-diary.js:1331-1342 会从 UI apiConfigs 组织 characterId/provider/apiKey/endpoint/model 并发送到 /credentials；UI source 与 Vault source 可以在不同时间点存在。

因此，正常代码路径可以形成：

历史 recovery snapshot  
→ UI/provider metadata 发生后续变化  
→ /credentials upsert 更新 Vault  
→ Active business snapshot 只保留非 secret metadata  
→ recovery 文件继续作为静态旧 artifact 保留。

这解释了 divergence 的形成机制，但不证明 recovery 文件的具体生成器。

## H. Provenance Timeline

以下只画出证据支持的部分：

历史 export schema version 8（代码历史，2026-08-27）
→ recovery records 的 created metadata（2026-08-31）
→ recovery file mtime（2026-09-02）
→ Vault records 的 batch updatedAt（2026-09-21）
→ 当前 active-message state mtime 与当前 character metadata（2026-09-22）

可以证明：

- observed metadata order 是 recovery-side metadata/file evidence 在前，Vault batch update 在后。
- 当前 live Active metadata 与 Vault 版本一致，且与 recovery 版本不一致。

仍不能证明：

- recovery JSON 是由哪一次导出、人工操作或外部脚本产生。
- Vault 的 2026-09-21 batch 是由哪一次具体 UI sync 触发。
- recovery 是否曾被人工导入过；repo/log 中没有足够的 explicit transaction record。

所以“时间先后”部分可证明，“生成因果链”仍为 UNKNOWN；这不阻塞本轮 conflict authority decision。

## I. char_bgai Resolution

最终分类：TEST_FIXTURE。  
Secondary state：ORPHANED_RUNTIME_REFERENCE。  
Confidence：HIGH。

证据：

- tests/test_bgai_propagation.js:69-88 明确创建完全同构的 task_bgai、plan_bgai、char_bgai。
- 夹具中的 char_bgai 使用 custom provider、model m、loopback endpoint class、空 apiKey 和 nickname BG。
- 当前 active-message-service.json 的 char_bgai metadata 与该 fixture 同构：task/plan/event/history 都存在，event status 为 sent，generatedByFallback 为 true，generation attempts 为 3。
- 当前 char_bgai endpoint 的 normalized class 是 HTTP loopback、port 1、V1 API path；当前 role 不在 moments live-role set 中，但保留在 task/plan/event/history。
- repo scan 未找到另一份 production role definition 或 apiConfig definition；char_bgai 的唯一明确来源是 synthetic test fixture。
- active/model-client.js:275-294 将 localhost/127.0.0.1/::1 loopback endpoint 视为可用 credential boundary，即使 apiKey 为空也可达到 model-ready predicate。

业务判断：

- char_bgai 是 test fixture residue，不是仍需恢复 provider key 的产品角色。
- 它不是当前产品意义上的 active role；它是 Active service 中仍保留的 runtime task/plan/event/history reference。
- Credential requirement：NO_CREDENTIAL_REQUIRED。
- 不创建 credential、不补 key、不删除、不修改、不联网验证。

## J. Live Impact

12 个 conflict ID 全部在当前 Active moments 中存在且 enabled=true，因此按“当前 runtime reference”分类为 LIVE_USED。

| Category | Count |
|---|---:|
| LIVE_USED | 12 |
| HISTORICAL_ONLY | 0 |
| NOT_REFERENCED | 0 |
| UNKNOWN | 0 |
| LIVE_USED + UNRESOLVED | 0 |

部分 live roles 的 moments status 为 idle 或 failed；这里的 LIVE_USED 表示当前 Active role/scheduler binding 存在，不表示本阶段重新执行过 provider call。R2 没有运行 scheduler、model call 或网络请求。

char_bgai 不计入 12 个 provider conflict 的 live credential impact，因为其 endpoint 是 loopback test boundary，且不需要 provider credential。

## K. Canonical Credential Snapshot

已在内存中构造 metadata-only Canonical Credential Snapshot，未落盘。

Snapshot summary：

| Field | Result |
|---|---:|
| version | 1 |
| canonical credentials | 23 |
| conflict records | 12 |
| live role bindings resolved through Vault | 21 |
| live role references including char_bgai | 22 |
| unique live credential aliases | 16 |
| secretPresent metadata | true，仅表示来源中存在 secret，不含 secret |
| raw key included | false |
| raw fingerprint included | false |
| production write | 0 |

每条 snapshot credential 只有：

- credentialRef：本轮临时 cred-xxx alias。
- provider。
- sourceAuthority：VAULT。
- decision：CURRENT。
- confidence：live-bound credentials 为 HIGH，其余 canonical-only entries 为 MEDIUM。
- secretPresent：true/false metadata。
- role/config binding count。

本轮没有把 cred-xxx 写回 Vault、IndexedDB、localStorage 或未来生产 contract。它们仅用于报告和本次审计过程。

## L. Conflict Decisions

主冲突决策按每个 conflict 只取一个 classification：

| Classification | Count |
|---|---:|
| VAULT_CURRENT | 12 |
| RECOVERY_CURRENT | 0 |
| HISTORICAL_ALTERNATE | 0（作为主冲突决策） |
| SAME_SECRET_DIFFERENT_METADATA | 0 |
| UNRESOLVED | 0 |

补充说明：12 个 conflict 的 recovery side 均被记录为 HISTORICAL_ALTERNATE supporting provenance；这 12 不是额外的 unresolved conflict，也不改变主决策计数。

决策依据不是“Vault 名义上 canonical”这一条，而是：

1. 12 个 ID 都有当前 Active role binding。
2. 当前 Active provider/model/endpoint class 逐条匹配 Vault。
3. 当前 Active metadata 逐条不匹配 recovery。
4. Vault updatedAt/file mtime 晚于 recovery observed metadata/file mtime。
5. Vault 的写入口和 Active runtime 读取路径是明确、可追踪的；recovery 文件没有 runtime generator/reader。

结论仅为 provenance/authority decision，不是 provider key validity decision。

## M. Security Findings

登记但不修复：

1. apiConfigs_recovery_import.json 是本机 key-bearing plaintext recovery artifact；不在 repo 中，不在本阶段删除或移动。
2. Web UI apiConfigs 代码仍直接保存 apiKey；emergency mirror 也保留完整 key，属于既有 plaintext duplicate boundary。
3. assets/js/communication.js:5759-5771 的 opt-in debug path 仍有 key prefix leakage；R2 未修改。
4. Middle Brain apiSettings['middle_brain']、Bridge config secret fields、Home Node desktop token 属于独立 authority，不应互相合并或混计。
5. 本轮没有把任何真实 key 写入报告、staging metadata、Git 文件或日志。
6. repo scan 命中的 bgai/API key 示例均为 synthetic fixture/placeholder 证据；本轮没有发现需要触发 SECURITY BLOCKER 的真实 credential plaintext。

没有执行 Git history secret rewrite，也没有修改任何安全相关源码。

## N. R3 Entry Gate

证据 gate：

- 12 conflicts 全部有 evidence-backed classification：通过。
- 不存在 live-used + unresolved credential conflict：通过。
- char_bgai 业务语义已确认：通过。
- char_bgai 不需要 credential，因此不需要合法 key source/reference：通过。
- secret-free canonical mapping 可构造：通过。

因此 R3 entry evidence gate = PASS。

授权 gate 仍然关闭：

- R3 未开始。
- Credential Authority v2 未实现。
- 没有进入 storage convergence、Backup v2、Android、P33 或其他 migration。
- 只有用户明确批准后，才可以设计下一阶段；设计不等于实施。

## O. Remaining

1. recovery JSON 的具体 generator 仍为 GENERATOR_UNKNOWN；保留为历史 alternate/quarantine source。
2. recovery 与 Vault 的时间先后可从 metadata 观察到，但具体因果同步事件没有 explicit transaction log。
3. 如未来进入 R3，应把本轮 23 条 metadata snapshot 作为分析输入，而不是把 cred-xxx 当作生产 credentialRef。
4. R3 仍需先定义 secret-free mapping contract、rollback boundary 和 Local Credential Authority interface。
5. 未来再处理 debug prefix leakage、普通备份文案和 backup error-stage observability；本轮不修改。
6. 不删除 recovery artifact，不覆盖 Vault，不导入 IndexedDB，不重发 key。

## Closure Gate

**Credential Authority Convergence R2 complete.**

All credential conflicts have evidence-backed provenance decisions.

The unresolved live-role credential gate is clear.

A secret-free canonical credential mapping can be constructed.

本轮最终状态：**R2 = PASS**。

No production credential or business data was modified.

No provider credential was transmitted or validated over the network.

R3 Credential Authority v2 may be designed only after explicit approval.
