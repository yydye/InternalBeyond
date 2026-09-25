# R4-0 Workspace File Provenance Audit

## 1. State

R4-0 State: PASS — MIXED SEMANTICS CONFIRMED / READY FOR CONTRACT

本阶段严格为 AUDIT ONLY。没有修改 Workspace production code、脚本运行时、工具运行时、通信层或 DB schema；没有升级 DB_VER；没有 commit。

结论依据：

- projectFiles.lastModifiedBy 是持久化到 IndexedDB 的人类可读标签，并在 UI 中展示。
- 同一字段还被 assets/js/workspace.js:32 用于判断旧文件是否应避让改名；这已经是 ROUTING / overwrite-policy 语义，不是纯展示。
- 普通同名角色只造成无法区分的 persisted provenance / display ambiguity；但角色昵称撞上 User、你或导入时，会触发错误的保留文件改名行为。
- 字段没有进入模型 prompt，也没有被用作权限判定、普通过滤或角色间 canonical identity 比较。

证据等级：

- STATIC：源代码、DB schema、既有 contract/audit 文档扫描。
- RUNTIME PROBE：隔离 Chrome profile、真实 Workspace producer、真实 IndexedDB 写入与 reload；探针执行后已删除。
- REAL UI：本阶段没有声称完成完整人工 UI 操作回放；用户手工保存路径由源码确认。

## 2. Scope

本审计只覆盖 Workspace persisted file provenance，主目标是 projectFiles.lastModifiedBy，并检查相邻候选字段：

createdBy、modifiedBy、author、owner、actor、actorId、lastEditor、editor、updatedBy、provenance。

P29 identity、P30 conversation scope 与 R3 media attribution 已视为 frozen。本阶段只引用它们对 Workspace 边界的既有结论，不重开、不改写、不扩展为全项目 Identity Audit。

当前源码中的 DB_VER 是 24（STATIC，assets/js/core.js:3）。

## 3. Canonical projectFiles Shape

当前 canonical record shape 来自 assets/js/workspace/files.js:103-117：

    {
      id,
      projectId,
      path,
      content,
      size,
      created,
      lastModified,
      lastModifiedBy
    }

字段事实：

| 字段 | 现状 |
|---|---|
| id | pf_...，IndexedDB keyPath |
| projectId | Workspace project/folder ID |
| path | 项目内文件路径 |
| content | 文本、data URL 或可序列化文件内容 |
| size | Blob size |
| created | 新建时写入；overwrite 保留原记录 |
| lastModified | create/overwrite/patch/move 时更新 |
| lastModifiedBy | author || 'AI'，当前只有 label，没有 canonical ID |

全仓库没有发现 projectFiles.actorId、lastModifiedById、authorId、modifiedById、metadata.actorId 或 provenance object。

## 4. Storage Authority

canonical storage authority 是浏览器 IndexedDB：

- assets/js/core.js:3-4 创建 InternalBeyondDB 的 projectFiles object store，并建立 byProject index。
- assets/js/core.js:9-13 的 dbPut、dbGet、dbGetAll 是底层读写原语。
- assets/js/workspace/files.js:76-78 通过 dbGetAll('projectFiles') 按 projectId 读取文件。
- assets/js/workspace/files.js:103-117 的 wsSaveFile 是 canonical writer；wsEditFileContent 在 :137-177 是同一 writer boundary 的 patch 入口。

其它存储面：

- localStorage 的 ib_mirror_v1 只是紧急恢复副本，见 assets/js/core.js:1040-1074；不取代 IndexedDB authority。
- Home Node bootstrap 只接管 chat/memory 等明确 store；assets/js/home-node-bootstrap.js:152-179 没有接管 projectFiles。
- Workspace file provenance 不进入 Home Node canonical DB，也不属于 P30 friendId + threadId conversation scope。

## 5. Producer Matrix

下表穷举直接赋值、object literal、copy、import/restore 以及各类上游触发点。所有真正新建/覆盖/patch 写入最终汇聚到 wsSaveFile 或 wsEditFileContent，但二者只接收 display author，不接收 actorId。

| Producer | File:Line | Trigger | Has cfg.id/actorId? | Value Written / carried | Persisted? |
|---|---|---|---|---|---|
| wsSaveFile overwrite | assets/js/workspace/files.js:103-112 | 同 path 覆盖 | 仅调用方可能有；writer 无 | author || 'AI' | 是，IndexedDB |
| wsSaveFile create | assets/js/workspace/files.js:114-117 | 新文件 | 同上 | author || 'AI' | 是，IndexedDB |
| AI ws_create | assets/js/workspace.js:450-464 | AI Workspace op；explicit overwrite 或唯一化后写入 | _execWsOps 能从 cfg.id 取得 actorId（:344-348），但没有传给 writer | authorName，通常是角色 nickname/model | 是 |
| AI ws_edit / patch | assets/js/workspace.js:465-471 → files.js:137-177 | find/replace patch | 同上；actorId 只留在 runtime op/result | authorName | 是 |
| AI file block archive | assets/js/workspace.js:21-37 | 回复中的文件块归档到 ICode | helper 只收到 author；没有 cfg.id | author || 'AI' | 是 |
| Rich file generation | assets/js/workspace/files.js:510-525 | make_docx/pdf/xlsx | caller 可能有 cfg.id，但 helper 只收 authorName | authorName | 是 |
| Generated/edited image file | assets/js/workspace.js:423-431 | 生图/改图归档到 ICode | _execWsOps 有 actorId，但 writer 只收 authorName | authorName | 是 |
| User attachment archive | assets/js/workspace/files.js:32-44 | 聊天附件自动归档到 User 文件夹 | 没有 user canonical actor ID | 固定 User | 是 |
| Human preview edit | assets/js/workspace/preview.js:704-738，保存为 :734 | 用户在预览区手工编辑并保存 | 没有 user canonical actor ID | 固定 User | 是 |
| Workspace file import | assets/js/workspace/files.js:869-882，写入为 :878 | ICode 文件导入 | 无 | 固定 导入 | 是 |
| Script writeback | assets/js/workspace/run.js:149-189，写入为 :178 | JS/Python 修改项目文件 | AI run context 可有 ctx.actorId；UI run 使用 author:'User'，但二者都被覆盖 | 固定 脚本 | 是 |
| Move file | assets/js/workspace/files.js:1186-1195 | 用户移动文件/重名路径 | 无 | 原 lastModifiedBy 原样保留；只更新 path/projectId/time | 是 |
| Copy file | assets/js/workspace/files.js:1196-1200 | 用户复制文件 | 无 | cur.lastModifiedBy || 'AI' 原样复制 | 是 |
| Collision rename | assets/js/workspace.js:456-464、files.js:521-525 | ws_create / rich generation 重名 | 同上 | path 改名后仍写原 author label | 是 |
| Plain JSON import/restore | assets/js/core.js:1276 | 普通备份导入 | 无 | data.projectFiles record 原样 dbPut；缺字段不补 | 是 |
| Emergency mirror restore | assets/js/core.js:1102-1110 | localStorage mirror 恢复 | 无 | mirror 中的 record 原样 dbPut | 是 |
| Migration | 全仓库扫描无 projectFiles migration writer | DB upgrade / legacy backfill | 无 | 未发现 projectFiles 专用迁移或 backfill | 无 |
| External tool writeback | assets/js/site-operations.js:235-430 | ws_tool / bridge / MCP | tool result runtime 可有 actorId；没有 projectFiles writer | 没有直接写入 | 否 |

Append producer：未发现 append API；所有实际写入是 create、overwrite、patch 或原样复制。

Rename producer：没有独立的“修改文件名并更新 provenance”API。项目 UI 的“重命名”是 project rename；文件重名保护先生成新 path，再通过 wsSaveFile 新建。移动路径时原 label 保留。

## 6. Consumer Matrix

仅列出实际读取 lastModifiedBy 或会把包含该字段的 projectFiles record 序列化/恢复的消费者。

| Consumer | File:Line | Purpose | Classification |
|---|---|---|---|
| Archive collision guard | assets/js/workspace.js:28-34 | User / 你 / 导入 命中时改存唯一新名，避免覆盖 | ROUTING |
| File list meta | assets/js/workspace/files.js:992-996 | 显示 size、作者 label、时间；你 映射为 User，空值 fallback AI | DISPLAY_ONLY |
| Copy path | assets/js/workspace/files.js:1196-1198 | 将既有 label 带到复制出的 record；不做身份判断 | UNKNOWN（data-preserving carry-forward） |
| Plain/export data source | assets/js/core.js:997-1001 | 全量读取 projectFiles，普通导出再递归脱敏 | EXPORT_IMPORT |
| File-system backup | assets/js/core.js:1138-1147 | 复用 redacted export 写本地 JSON；record 字段保留 | EXPORT_IMPORT |
| Encrypted vault export | assets/js/local-vault.js:160-184 | 复用 _ibBuildExportData 加密完整 payload | EXPORT_IMPORT |
| Emergency mirror pack | assets/js/core.js:1064-1073 | 将 projectFiles 按 lastModified 装入 localStorage mirror | EXPORT_IMPORT |
| Plain import | assets/js/core.js:1276 | data.projectFiles 原样逐条 dbPut | EXPORT_IMPORT |
| Emergency mirror restore | assets/js/core.js:1102-1110 | mirror record 原样回灌 IndexedDB | EXPORT_IMPORT |

负面证据：

- assets/js/workspace.js:476-488 的 ws_read 注入 path、projectId、actor、actorId、total、content/range，不含 lastModifiedBy。
- assets/js/chat-context-signals.js:64-82 读取 projectFiles 只匹配项目名/path，不读取作者字段。
- 全仓库精确搜索没有发现 lastModifiedBy !== ...、includes(lastModifiedBy)、Map/Set key、permission gate、filter predicate 或 prompt speaker attribution。

## 7. Semantic Comparison Search

精确 semantic comparison 只有 assets/js/workspace.js:32：

    old.lastModifiedBy === 'User'
      || old.lastModifiedBy === '你'
      || old.lastModifiedBy === '导入'

它的后果不是权限拒绝，而是把目标 path 改成 名 (2).ext，所以 primary classification 是 ROUTING，具体是保护性 overwrite policy。

这不是“角色 A 的 ID 是否等于角色 B 的 ID”的 canonical IDENTITY_COMPARE；但它把 persisted display string 当作作者类别 sentinel，仍然是 display label 承担 semantic decision 的窄缺陷。

没有发现：

- AUTHORIZATION：不决定谁可读、谁可写。
- FILTERING：不按 lastModifiedBy 筛列表或筛 prompt。
- 普通 actor/self/role matching。
- Map/Set ownership key。

## 8. Prompt Surface

lastModifiedBy 不进入模型 prompt：

- Workspace read 只注入文件内容和 runtime read attribution，不注入 persisted file author label。
- 动态 chat context 只注入真实项目/path 事实。
- 没有“最后修改者：...”或同等格式的 prompt block。

因此 PROMPT_ATTRIBUTION 不存在。模型不会因该字段直接做 canonical identity 解释；语义风险来自文件归档 routing 与 persisted provenance，而不是 prompt visibility。

## 9. UI Surface

唯一直接展示点是 assets/js/workspace/files.js:996 的文件 meta 行。用户看到的是：

    文件大小 · label · 最后修改时间

显示转换为：

- 你 → User
- 非空其它值 → 原字符串
- 空/缺失 → AI

同名角色 A/B 的 UI 都会显示同一个 nickname。这构成 DISPLAY AMBIGUITY，但单独看并不等于行为型 identity defect。问题在于同一个 label 还被 assets/js/workspace.js:32 当作保留类别使用，并且没有 persisted actor ID 可以消除歧义。

## 10. Same-Name Probe

证据等级：RUNTIME PROBE，不是完整 REAL UI 回放。

探针使用真实页面、真实 _execWsOps、真实 wsSaveFile/_wsArchiveFileBlocks 和隔离 IndexedDB：

1. Role A：id=role_A、nickname=同名角色。
2. Role B：id=role_B、nickname=同名角色。
3. 两者分别执行真实 Workspace ws_create，写入 from-a.txt 与 from-b.txt。
4. 记录 reload 前后均从 projectFiles 读取。

结果：

    from-a.txt -> lastModifiedBy: 同名角色
    from-b.txt -> lastModifiedBy: 同名角色
    persisted record keys -> content, created, id, lastModified,
                             lastModifiedBy, path, projectId, size
    actorId / lastModifiedById -> 不存在

reload 后两个 record 仍保留相同 label，证明 ambiguity 是 persisted 的，不是只存在 runtime。

同一探针还创建了旧的 reserved.txt（lastModifiedBy=User），然后由真实 _wsArchiveFileBlocks 写入同名新内容。结果是：

    reserved.txt       -> old / User
    reserved (2).txt   -> new / 同名角色

这证明保留 label collision 会造成实际 routing 行为：避让改名而非覆盖。普通 nickname 同名角色本身没有触发角色间 routing、权限或过滤错误；真实错误是角色名占用保留人类/导入 label 时的窄碰撞。

探针文件是临时文件，执行后已删除；没有写入仓库 production source。

## 11. Human Writer

人类来源不是单一路径：

- 聊天附件自动归档：assets/js/workspace/files.js:43 写 User。
- 预览区手工编辑保存：assets/js/workspace/preview.js:704-738，:734 写 User。
- ICode 文件导入：:878 写 导入，表示导入管线而非真实 user ID。
- 用户点“运行”只是发起脚本执行：assets/js/workspace/run.js:242-249 传 author:'User'；真正写回仍在 :178 固定写 脚本。

当前没有 user canonical actor ID 传入 projectFiles。因此 human provenance、import provenance、script/system provenance 与 role display provenance 共用一个 string field。

## 12. Role Writer

AI role Workspace op 在 assets/js/workspace.js:344-348 已经能从 cfg.id 取得 runtime actorId；这是 P29 已冻结的 runtime identity。但随后：

- ws_create 在 :463 只把 authorName 传给 wsSaveFile。
- ws_edit 在 :470 只把 authorName 传给 wsEditFileContent。
- file block、rich artifact、generated image 归档 helper 也只收 display authorName。

所以“producer 当场知道 role ID”不等于“persisted file record 保留 role ID”。当前 lastModifiedBy 的角色值是 nickname/model display string。

## 13. System / Tool Writer

当前 provenance domain 实际包含多种 writer kind：

- role：nickname/model 或 explicit authorName。
- human：User / 你。
- import pipeline：导入。
- script/system path：脚本。
- missing-author fallback：AI。

External tool path（assets/js/site-operations.js:235-430）只执行 HTTP、Bridge 或 MCP，并把结果放入 _ibToolPendingResults；未发现它直接调用 wsSaveFile 或 dbPut('projectFiles', ...)。如果某个工具的外部副作用改变了外部系统，那不等于它写入了本地 projectFiles。

因此只加 lastModifiedById = roleId 不能覆盖已经确认的 human/import/script/system/tool kind 问题；本阶段不冻结设计，只记录这个约束。

## 14. Script Writeback

script writeback 的唯一实际落点是：

    assets/js/workspace/run.js:167-179
    wsSaveFile(ctx.projId, n, c, '脚本')

它当前表达的是“脚本通道写回”，不是用户、当前角色或 tool 的 canonical identity：

- AI ws_run 的 ctx 可能有 author 和 actorId，但写回时二者都不进入 lastModifiedBy。
- 用户从预览面板运行已有脚本时，ctx.author='User'，但写回仍然写 脚本。

这使 lastModifiedBy 明确具有 kind/provenance 语义，而不只是 role display label。

## 15. Persistence

静态链路：

    wsSaveFile / wsEditFileContent
      -> dbPut('projectFiles', record)
      -> IndexedDB InternalBeyondDB.projectFiles
      -> dbGet/dbGetAll after reload

RUNTIME PROBE 结果确认：

- A/B 两个同名角色的 records 在写入后可读。
- reload 后 lastModifiedBy 仍保持原 label。
- persisted record 没有 actorId 或其他 canonical provenance key。

IndexedDB object store 本身不定义字段 schema；record 是可扩展 object，keyPath 只有 id。

## 16. Export / Import

已发现的路径：

| Path | 现状 |
|---|---|
| 普通 JSON export | _ibBuildExportData() 直接包含 projectFiles: await g('projectFiles')；redacted copy 只清理 secret key，不删除 provenance |
| 自动备份 | 复用 redacted export，保留 record fields |
| 本地文件夹同步 | IB_sync_latest.json / daily backup 复用 redacted export |
| encrypted vault export | local-vault 复用原始 _ibBuildExportData() 后加密 |
| 普通 import | data.projectFiles 原样逐条 dbPut |
| encrypted vault import | 解密后构造普通 JSON File，再调用 native import |
| emergency localStorage mirror | _ibMirrorPack 将 projectFiles 按 lastModified 装箱；未超预算时保留未知/additive fields，超预算时可能截断整个记录集合 |
| emergency mirror restore | 对 mirror 中的 record 原样 dbPut |

所以未来 additive field 在这些 JSON/object pass-through 路径中理论上会自动保留；这不解决旧记录缺字段，也不保证 mirror 在预算不足时保存全部历史记录。

## 17. Migration / DB

DB_VER 仍是 24，projectFiles 在 assets/js/core.js:4 作为普通 object store 创建，仅设置 keyPath id 与 byProject index。

没有发现：

- projectFiles 专用 DB version upgrade；
- projectFiles legacy backfill；
- lastModifiedBy migration；
- Home Node schema；
- 需要新 index 的当前 consumer。

结论：

- 仅增加 additive object property，理论上不需要 IndexedDB schema migration，也不应在本阶段升级 DB_VER。
- 如果未来 contract 要为旧记录补一个“unknown/ambiguous”值，仍可能需要一次显式 data backfill；这是数据迁移，不是 object-store schema 必需升级。
- 未来 writer/reader 的语义 contract 仍必须先冻结，再实现。

## 18. Legacy Records

当前 writer 生成的 record 只有 display lastModifiedBy，没有 canonical provenance ID；历史导入/restore 还允许 field 缺失。因而 legacy 情况至少包括：

- 只有 lastModifiedBy display label；
- lastModifiedBy 缺失；
- lastModifiedBy 是旧保留标签；
- 未来 additive field 尚未写入的旧记录。

没有真实生产 DB 的历史 corpus 或 telemetry，不能从源码估算“旧记录中各形态的普遍比例”；但从 shape 与 import/restore 机制可确认 legacy display-only record 是合法且必须支持的状态。

same-name 场景下，不能安全地从 lastModifiedBy='同名角色' 反推 role_A 或 role_B。也不能依赖当前 apiConfigs nickname 反查：同名候选不唯一、角色可能已重命名/删除、记录本身没有时间点上的 registry snapshot。legacy 应标记为 unknown/ambiguous，而不是强行解析。

## 19. Existing Canonical Identity

已经存在、可复用但尚未落入 file record 的 canonical identity：

- role Workspace runtime：cfg.id，见 assets/js/workspace.js:344-348。
- script runtime context：ctx.actorId，见 assets/js/workspace.js:532 与 assets/js/workspace/run.js:203-208。
- tool runtime result：actorId，见 assets/js/site-operations.js:291-295、:344-366。
- conversation scope：friendId + threadId，但它是 WHERE，不是 file provenance WHO，且不应写入本字段作为替代。

不存在可复用的 persisted file provenance field。当前不是“再造一个同名 actor registry”的问题，而是现有 canonical writer 没有把已知 provenance kind/id 传到 projectFiles。

## 20. Risk Classification

| Dimension | Finding | Classification |
|---|---|---|
| UI label | 文件列表显示 label | DISPLAY_ONLY |
| Export/import | record 原样序列化/恢复 | EXPORT_IMPORT |
| Model prompt | 不进入 prompt | 无 prompt semantic |
| Identity compare | 无 canonical WHO compare；只有保留 label equality | 窄 semantic risk |
| Authorization | 不决定权限 | 否 |
| Filtering | 不按作者过滤 | 否 |
| Routing | 保留 label 决定是否 _wsUniquePath() | 是，ROUTING |
| Audit provenance | persisted field 名称和 UI/contract 将其当作最后修改者标签，但缺 canonical identity | provenance debt |
| Same-name generic roles | 两条记录显示同名且不可区分 | DISPLAY AMBIGUITY |
| Reserved-label role | role nickname = User/你/导入 会被误判为 human/import protected | 实际窄 routing defect |

最终分类不是 DISPLAY_ONLY：字段存在 routing consumer 且产品存储/展示语义不是一次性 UI-only label。也不是把整个 Workspace 宣称为全面 identity architecture defect：没有权限、prompt、过滤或通用 role matching 证据。

因此 R4-0 分类为 MIXED_SEMANTICS。

## 21. Recommended Next Step

下一阶段应是 R4 Contract Freeze，而不是直接 implementation。

最小候选 contract surface（仅候选，不在 R4-0 冻结）：

1. 保持 lastModifiedBy 作为兼容的 human-readable label，不改现有 UI 文案。
2. 为 persisted provenance 明确 kind；候选至少要能区分 role、user、import/system/script、unknown，具体枚举需在 contract freeze 决定。
3. 当 writer 确实拥有 canonical ID 时，additive 地保留对应 ID；没有 canonical ID 的 human/system/tool/legacy 不得伪造。
4. assets/js/workspace.js:32 的保护性 routing 必须读取显式 kind/contract，而不能继续用 nickname 是否等于 User、你、导入来猜类别。
5. import/export/restore 对 additive fields 继续 pass-through；legacy record 明确 unknown/ambiguous。

不需要引入 ProvenanceManager、IdentityRegistry、WorkspaceActorService、EventBus、Global Audit Store 或新的 Home Node authority。现有 wsSaveFile / wsEditFileContent writer boundary 足以承载最小 additive contract。

## 22. Git / Worktree

审计开始时 worktree 已经存在大量与本阶段无关的 dirty changes、P23-P30 文档/测试及 R3 closure artifacts；本审计不重置、不覆盖、不清理它们。

本阶段实际动作：

- 读取源码、既有审计/contract 文档和附件要求。
- 运行一次隔离浏览器 RUNTIME PROBE；临时 probe 文件执行后删除。
- 只新增本文档 docs/R4-0-WORKSPACE-FILE-PROVENANCE-AUDIT.md。
- 没有修改 assets/js/workspace.js、assets/js/workspace/run.js、assets/js/workspace/files.js、assets/js/workspace/preview.js、assets/js/site-operations.js、assets/js/communication.js、assets/js/core.js、DB schema 或 DB_VER。
- 没有 commit。

因此“production diff 与审计开始时一致”按本阶段 scope 成立；现有 dirty production diff 属于审计前工作，不归因于 R4-0。

## 23. Required Final Answers

Q1. projectFiles 的 canonical storage authority 是什么？  
IndexedDB InternalBeyondDB.projectFiles，底层 authority 是 dbPut/dbGet/dbGetAll；localStorage mirror 只是恢复副本，Home Node 不接管。

Q2. lastModifiedBy 是否 persisted？  
是，作为每条 projectFiles record 的普通 object property 持久化。

Q3. 所有 producer 是哪些？  
wsSaveFile create/overwrite、wsEditFileContent patch、AI file block/rich/image/archive、AI ws_create/ws_edit、User attachment、preview manual save、Workspace import、script writeback、move/copy carry-forward、plain import、encrypted import 间接回灌、emergency mirror restore；没有独立 append、projectFiles migration 或 direct tool writer。

Q4. 哪些 producer 已知 canonical actorId？  
AI _execWsOps 已知 cfg.id；AI script context 可能有 ctx.actorId；tool runtime result 也可能有 actorId。但当前这些 ID 都没有写入 projectFiles；human/import/script kind 没有对应 ID。

Q5. human manual edit 写什么？  
预览区手工保存写 User；聊天上传归档也写 User；ICode 导入写 导入。

Q6. AI role edit 写什么？  
通常写 authorName，即角色 nickname/model display string；缺省为 AI。它不写 role ID。

Q7. script writeback 写什么？  
固定写 脚本，无论是 AI 触发还是用户从 UI 手动运行脚本。

Q8. tool writeback 写什么？  
没有发现 tool 直接写 Workspace projectFiles 的路径；工具结果只写 runtime pending-result queue，带 display actor/可选 actorId。

Q9. 所有 consumer 是哪些？  
文件列表 UI、archive collision guard、copy carry-forward、plain/redacted export、filesystem backup、encrypted vault export/import、emergency mirror pack/restore；prompt/context 只读 path/content 相关事实，不读该字段。

Q10. 是否存在 IDENTITY_COMPARE？  
不存在 canonical WHO-to-WHO compare；存在窄的 display-label equality，检查是否为 User/你/导入并参与 routing。

Q11. 是否存在 AUTHORIZATION use？  
否。它不决定权限。

Q12. 是否存在 FILTERING use？  
否。没有按 lastModifiedBy 过滤文件或 prompt。

Q13. 是否存在 ROUTING use？  
是。workspace.js:32 决定同名归档是覆盖还是改名避让。

Q14. 是否进入 model prompt？  
否。

Q15. 如果进入 prompt，承担什么语义？  
不适用；当前没有 prompt surface。Workspace read 的 attribution 是 runtime actor/actorId，不是 persisted lastModifiedBy。

Q16. UI 是否仅把它作为 label 展示？  
不是。UI 展示是 display-only，但同一字段还参与 archive collision routing，并被 export/import 持久化。

Q17. same-name roles 是否产生实际行为错误？  
普通同名 nickname 本身没有发现角色间 routing/权限/过滤错误；但同名角色若占用保留值 User、你或导入，会被误判为 human/import protected，触发错误改名避让。这是已由 runtime probe 复现的窄行为错误。

Q18. same-name roles 是否仅产生显示歧义？  
对普通非保留 nickname，是；A/B 两个不同 cfg.id reload 后都只有相同 lastModifiedBy，属于 persisted provenance/display ambiguity。

Q19. lastModifiedBy 是否属于 authoritative audit provenance？  
它当前被持久化并被 UI/保护逻辑当作“最后修改者 label”，但不是 authoritative canonical provenance，因为同名不可区分且混入 user/import/script/system kind。

Q20. 是否已有 canonical provenance 字段？  
否。

Q21. 是否已有可复用 actorId？  
是，在 AI Workspace runtime cfg.id、script context 与 tool result 上已有；但尚未落入 projectFiles。

Q22. legacy record 是否只有 display name？  
是，当前历史/兼容形态可只有 lastModifiedBy，也可能缺失该字段；没有 persisted actor ID。源码无法给出真实生产记录的比例。

Q23. 能否安全从 legacy display name 推导 actorId？  
不能；same-name、改名、删除和时间点 registry 变化都会造成歧义。必须保留 unknown/ambiguous，不能强行反查。

Q24. 如果 additive field，是否需要 DB migration？  
仅增加 object property 不需要 IndexedDB schema migration，DB_VER 可保持 24；若未来要回填旧记录，则需要显式 data backfill，但不是 store schema upgrade。

Q25. export/import 是否会自动保留 additive field？  
会，当前普通导出、vault、文件夹同步、import 和 mirror 都是 object/JSON pass-through；但 emergency mirror 受容量预算影响，可能截断记录集合。

Q26. Home Node/mirror 是否涉及？  
Home Node 不涉及 projectFiles；应用自己的 localStorage emergency mirror 涉及，并按预算保存/恢复 projectFiles records。

Q27. R4 应分类什么？  
MIXED_SEMANTICS。

Q28. 是否需要 production implementation？  
需要，但不是本阶段；应先做 R4 Contract Freeze，再按最小 additive surface 实现。

Q29. 如果需要，最小 contract surface 是什么？  
保留 lastModifiedBy label；新增明确 provenance kind，并在 writer 已知 canonical ID 时 additive 地保留 ID；routing 改读 kind 而不是 nickname sentinel；legacy 缺失/歧义保持 unknown；import/export/restore pass-through。

Q30. 是否有理由引入新 Manager/Registry/Service？  
没有。现有 Workspace writer boundary 与既有 cfg.id 足够，不应扩大架构。

Q31. DB_VER 是否仍为 24？  
是。

Q32. P29/P30/R3 是否完全未重开？  
是。本阶段只消费其冻结结论，没有修改或重新裁定。

Q33. production 是否零 mutation？  
是。R4-0 只新增本文档；临时 probe 已删除；production source、schema、DB_VER、commit 均未改。

Q34. 下一阶段应该是 R4 Contract Freeze 还是 R4 No-op Closure？  
R4 Contract Freeze，因为已确认 MIXED_SEMANTICS。

## 24. Final State

R4-0 State: PASS — MIXED SEMANTICS CONFIRMED / READY FOR CONTRACT

STOP。R4-0 结束；不进入 R4 implementation，等待下一步指令。
