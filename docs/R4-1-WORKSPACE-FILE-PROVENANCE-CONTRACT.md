# R4-1 Workspace File Provenance Contract

## 1. State

R4-1 State: PASS — CONTRACT FROZEN / READY FOR IMPLEMENTATION

本阶段是 CONTRACT DESIGN + FREEZE ONLY。本文冻结最小 Workspace persisted provenance contract，供下一阶段 implementation 使用。

本阶段没有：

- 修改 production source；
- 修改 projectFiles store/schema；
- 升级 DB_VER；
- 遍历或重写旧 projectFiles；
- 修改 rename routing；
- 修改 P23/P24/P30/R3 runtime queues；
- commit。

冻结结论：

    lastModifiedBy       = backward-compatible display label
    lastModifiedByKind   = optional canonical provenance kind
    lastModifiedById     = optional canonical ID, meaningful only with kind=role today

持久化形状保持 flat additive fields；禁止把 lastModifiedBy 改成 object。

## 2. R4-0 Established Facts

R4-0 已确认，本契约不重新审计这些事实：

1. projectFiles 的 canonical authority 是 IndexedDB InternalBeyondDB.projectFiles。
2. lastModifiedBy 会持久化。
3. lastModifiedBy 当前同时承担 UI human-readable label 与 rename avoidance/routing input。
4. 普通 same-name role 会造成 persisted provenance ambiguity。
5. role nickname 为 User、你、导入等保留 label 时，可复现错误 rename routing。
6. 没有 model prompt identity、authorization、permission 或 filtering semantics。
7. DB_VER 当前为 24。
8. P29 logically frozen，P30 logically frozen，R3 CLOSED。

完整证据仍保留在：

docs/R4-0-WORKSPACE-FILE-PROVENANCE-AUDIT.md

## 3. Problem Statement

现状把 display label 当成 semantic provenance identity：

    lastModifiedBy = 'User'

这个字符串无法可靠区分：

- human user；
- nickname 为 User 的 AI role；
- import operation；
- script/system source；
- 未来可能出现的 tool-mediated writer。

R4 的边界是拆开 DISPLAY 与 CANONICAL PROVENANCE，不重新设计全局 identity architecture。

## 4. Display vs Canonical Provenance

冻结以下原则：

| Concern | Frozen meaning |
|---|---|
| lastModifiedBy | 继续是 string、human-readable、backward-compatible display label |
| lastModifiedByKind | canonical provenance kind；新增 record 可写，legacy 可缺失 |
| lastModifiedById | canonical identifier；当前只对 role kind 使用现有 cfg.id |
| semantic routing | 只读 canonical kind/id；canonical metadata 存在时不得回退到 display label |
| legacy | 只有旧 label 时不反查当前角色列表，不强行推导 ID |

禁止以下迁移：

    lastModifiedBy: { id, kind, label }

现有 UI、export/import、legacy record 与代码仍依赖 string；display label 的兼容性优先保留。

## 5. Canonical Field Shape

新 canonical projectFiles record 在现有 shape 上只增加 optional additive fields：

    {
      id,
      projectId,
      path,
      content,
      size,
      created,
      lastModified,
      lastModifiedBy,
      lastModifiedByKind?,
      lastModifiedById?
    }

字段规则：

| Field | Contract |
|---|---|
| lastModifiedBy | 必须保持 string；显示当前 modifier 的人类可读名字或来源标签 |
| lastModifiedByKind | 新的可识别 provenance 必须写入；legacy record 可 absence |
| lastModifiedById | 只有 kind=role 时当前 contract 要求写入；其它 current kind 不伪造 ID |

冻结 enum：

    role
    user
    import
    script
    system

不冻结 tool enum，因为 R4-0 没有发现 tool 直接写 projectFiles 的 producer。若未来出现独立 tool writer，必须先扩展 contract，不能静默复用 role、user 或 system。

canonical provenance 的有效性：

- kind=role：必须有非空 lastModifiedById；ID 来自现有 cfg.id/apiConfigs.id。
- kind=user/import/script/system：kind 足以表达当前 source，lastModifiedById 应保持缺省。
- kind 缺失：legacy/unknown，不得通过 label 反查。
- kind 存在但不在 enum，或 kind=role 却缺 ID：视为 invalid canonical metadata；routing 按 unknown 的保守规则处理，绝不使用 label fallback。

## 6. Identity Namespace

canonical identity key 不是裸字符串，而是有 kind discriminator 的 tuple：

    (lastModifiedByKind, lastModifiedById)

当前 namespace 冻结为：

| Kind | ID namespace | ID rule |
|---|---|---|
| role | existing apiConfigs/cfg namespace | lastModifiedById = cfg.id；不使用 nickname |
| user | no current persisted user actor ID | 不写 ID；kind=user 是 human boundary |
| import | operation/source kind namespace | 当前不写 ID；import 是来源类别，不是 role |
| script | script execution source kind | 当前不写 ID；不把执行脚本自动归给 User |
| system | system fallback kind | 当前不写 ID；不把 'AI' 当作 role ID |

禁止把 role ID、User、导入、System 等不同语义混在一个无类型的 ID 字段。不得创建 Identity Registry 或新的全局 resolver。

如果未来产品已经拥有 human/system/import 的稳定 canonical identifier，可以在对应 kind 下 additive 使用；当前实现不得凭空生成或从 label 猜测。

## 7. Human Writer

human user 修改或归档文件时冻结为：

    lastModifiedBy     = 'User'
    lastModifiedByKind = 'user'
    lastModifiedById   = absent

适用当前 producer：

- assets/js/workspace/preview.js 的预览区手工保存；
- assets/js/workspace/files.js 的聊天附件 User 文件夹归档。

ICode 导入不是 human writer，即使导入动作由用户点击发起，也使用 import kind，见第 9 节。

这个区分保证 nickname 为 User 的 role 不会在 canonical routing 中与真实 human user 混淆。

## 8. Role Writer

AI role 写文件时冻结为：

    lastModifiedBy     = 当前 role display name
    lastModifiedByKind = 'role'
    lastModifiedById   = cfg.id

要求：

- cfg.id 是唯一 canonical WHO；不得用 nickname 反查 ID。
- Role A 与 Role B 可以有相同 lastModifiedBy，但必须有不同 lastModifiedById。
- role nickname 可以是 User、你或导入；只要 kind=role，semantic routing 就不能把它当作其它 source。
- 如果 role producer 没有可信 cfg.id，不得伪造 ID；该 record 进入 legacy/unknown compatibility path，不能以 display label 反查。

当前 Workspace runtime 已经在 assets/js/workspace.js:344-348 得到 cfg.id；implementation 需要把它传到 persisted writer boundary，而不是重新定义 role identity。

## 9. Import Writer

Workspace import 文件冻结为：

    lastModifiedBy     = '导入'
    lastModifiedByKind = 'import'
    lastModifiedById   = absent

import kind 表示 file provenance source，不表示当前点击导入按钮的 human actor，也不表示某个 AI role。

semantic routing 必须读取 kind=import，而不能继续使用：

    lastModifiedBy === '导入'

这样 role nickname 为导入时，canonical role record 不会被误识别为 import。

Legacy record 只有 label 导入时，仍按第 14 节 legacy policy 处理，不升级、不回填。

## 10. Script Writer

script writeback 冻结为：

    lastModifiedBy     = '脚本'
    lastModifiedByKind = 'script'
    lastModifiedById   = absent

这表达“script execution channel 写回”，不自动表达 human 或 invoking role：

- AI ws_run 的 ctx.actorId 不改变 script kind；
- 用户从 UI 点运行也不把 script 写回改成 user；
- 当前 producer 的实际写点仍是 assets/js/workspace/run.js:178。

如果未来产品要审计“谁发起了脚本”，那是另一个 additive provenance concern；本 contract 不把 script source 偷换成 role 或 user。

## 11. Tool Writer

R4-0 没有发现 tool 直接写本地 projectFiles：

- assets/js/site-operations.js 的 tool path 写 runtime pending result；
- tool result 可以带 actorId，但不是 projectFiles writer；
- 当前没有 tool kind 的 persisted producer。

因此当前 contract 不新增 tool enum，也不为不存在的 producer 预留字段。

如果 AI role 请求 tool 执行一个 Workspace file write，且 writer 语义仍属于请求角色，则冻结为：

    lastModifiedByKind = 'role'
    lastModifiedById   = requesting cfg.id
    lastModifiedBy     = requesting role display name

tool 是 execution mechanism，不引入 “B via Tool” 复合 provenance。若未来出现独立、无 requesting role 的 tool-origin writer，必须先做 contract extension；当前阶段不得擅自把它归为 system 或 role。

## 12. Rename Routing Semantics

R4 的 semantic consumer 是 archive collision avoidance，而不是 permission。

冻结 semantic predicate：

    protectedFromWorkspaceArchiveOverwrite(record)

canonical record 的 predicate：

    record.lastModifiedByKind === 'user'
    OR
    record.lastModifiedByKind === 'import'

含义：该文件最后来自 human/user source 或 import source，新的 AI file-block archive 不应覆盖它，而应走 unique-path avoidance。

canonical role、script、system record 不因 display label 值为 User、你、导入而命中保护 predicate。

该 predicate 只约束已有的 archive overwrite decision；不重定义 ws_create 自身的普通重名保护，也不增加权限语义。

## 13. Canonical-First Rule

冻结：

    valid canonical provenance present
    -> canonical kind/id decides
    -> never use lastModifiedBy display semantics

禁止：

- canonical kind=role 且 label=User 时再回退到 label User；
- canonical kind=user 且 label=某个角色昵称时再按昵称解析；
- canonical ID mismatch 后再试 lastModifiedBy string；
- 通过 current apiConfigs nickname、角色列表或当前会话猜历史 actor。

canonical metadata 存在但 invalid 时，按 unknown 的保守 routing 处理，不把 display label 变成第二次身份解析入口。

## 14. Legacy Policy

旧 projectFiles 可能只有 lastModifiedBy，也可能完全没有新增 canonical fields。旧 record：

- 保持可读；
- 保持原 lastModifiedBy string；
- 不做启动时 migration；
- 不通过 display name 反查 actorId；
- 不强制写 kind='unknown'。

legacy semantic routing 冻结为 conservative compatibility：

    canonical fields absent or invalid
    -> provenance = legacy unknown/ambiguous
    -> archive collision uses unique-path avoidance
    -> never overwrite the unclassified legacy record in this semantic path

这会优先避免数据覆盖，代价是旧文件可能被另存为新 path；这是 R4 选择的安全兼容行为。legacy record 不能被宣称为 human、role、import、script 或 system。

尤其是：

- legacy lastModifiedBy='User' 不能安全推导为 human；
- legacy lastModifiedBy='你' 不能安全推导为 human；
- legacy lastModifiedBy='导入' 不能安全推导为 import；
- role name 与 label 的当前相等关系不提供历史事实。

## 15. Same-Name Rule

冻结：

    Role A: id=A, name=X
    Role B: id=B, name=X

持久化后允许：

    A.lastModifiedBy = X
    B.lastModifiedBy = X

但必须：

    A.lastModifiedByKind = 'role'
    A.lastModifiedById   = A
    B.lastModifiedByKind = 'role'
    B.lastModifiedById   = B

任何 semantic routing 都比较 kind/id，不比较 X。same-name 只保留 display ambiguity，不得造成 A/B provenance collision。

## 16. Reserved-Label Collision Rule

显式冻结以下 role cases：

| Role display name | Persisted canonical fields | Routing meaning |
|---|---|---|
| User | lastModifiedBy=User, kind=role, id=role ID | role；不是 human；不命中 user protection |
| 你 | lastModifiedBy=你, kind=role, id=role ID | role；不是 human；不命中 user protection |
| 导入 | lastModifiedBy=导入, kind=role, id=role ID | role；不是 import；不命中 import protection |

对应真实来源：

| Source | lastModifiedBy | kind | Routing |
|---|---|---|---|
| human manual write | User | user | protected |
| import pipeline | 导入 | import | protected |
| role named User/你/导入 | same display label | role | not protected because canonical kind wins |

UI 继续显示角色真实 nickname；contract 不要求用户看到 role ID。

## 17. Persistence / Reload

新增 fields 是 IndexedDB schemaless object 的 additive properties：

    writer
      -> dbPut('projectFiles', record)
      -> IndexedDB
      -> reload
      -> dbGet/dbGetAll

冻结要求：

- 新 canonical write 后 kind/id 必须进入 record；
- reload 后 kind/id 仍可读；
- move 保留 kind/id；
- copy 保留 kind/id；
- overwrite/patch 更新 modifier fields 为本次真实 writer；
- legacy record 不因 reload 被静默 backfill。

不允许只把 canonical provenance 放在 runtime queue、DOM card 或 in-memory context。

## 18. Export / Import

当前 whole-object pass-through 已被 R4-0 证明足够，冻结如下：

- 普通 export 保留 lastModifiedBy、lastModifiedByKind、lastModifiedById；
- redacted export 只清理 secret，不删除 provenance fields；
- encrypted vault 继续复用完整 export payload；
- filesystem backup 继续复用 redacted payload；
- plain import 保留新 fields；
- encrypted import 解密后继续走 plain import；
- legacy backup 只有 lastModifiedBy 时仍可导入和读取；
- import 不将 legacy label 自动升级为 canonical kind/id。

如果未来出现字段白名单 serializer，必须把两项 additive fields 加入该白名单；本阶段没有发现需要修改的白名单路径。

## 19. Mirror / Home Node

local emergency mirror：

- projectFiles record 通过 JSON object pass-through；
- lastModifiedByKind/id 在未被容量截断时自然保留；
- restore 原样写回 IndexedDB；
- mirror 容量不足造成 record truncation 的既有事实不改写为 provenance semantics。

Home Node：

- 不接管 projectFiles；
- 不新增 projectFiles Home Node table；
- 不新增 Home Node sync contract；
- 不把 friendId、threadId 或 conversationId 引入 file provenance。

因此本阶段没有 mirror/Home Node production change。

## 20. DB Decision

冻结：

    DB_VER remains 24
    NO STORE SHAPE MIGRATION
    NO LEGACY BACKFILL

理由：

- projectFiles 是 keyPath=id 的 schemaless object store；
- additive properties 可以由 IndexedDB 直接持久化；
- export/import/mirror 是 whole-object pass-through；
- 当前没有需要新 index 的 canonical consumer。

如果 implementation 证明某个实际 serializer 丢弃 additive fields，必须先报告 contract blocker 或补充 implementation surface；不得直接把 DB_VER 24 升为 25。

## 21. Implementation Surface

下一阶段预计范围：

### MUST

- assets/js/workspace/files.js：canonical writer、patch、move/copy carry-forward，以及 writer 的 kind/id 传递。
- assets/js/workspace.js：AI role producer 的 cfg.id 传递、file block/rich/image producer 归属、canonical-first archive routing。
- assets/js/workspace/preview.js：human manual save 写 kind=user。
- assets/js/workspace/run.js：script writeback 写 kind=script，不伪造 user/role ID。
- assets/js/workspace/files.js 的 import/upload source 写 kind=import 或 kind=user。
- tests/test_workspace_file_provenance.js：本契约第 22 节定义的 contract suite。

### MAYBE

- assets/js/core.js：只有在实际 export/import/mirror path 被证明不是 whole-object pass-through 时才改。
- assets/js/local-vault.js：只有在 vault payload 明确过滤新字段时才改；当前审计没有该证据。
- assets/js/site-operations.js：只有未来出现 direct tool projectFiles writer 时才纳入；当前不改。
- assets/js/communication.js：只有 producer context 无法到达既有 Workspace writer 时才纳入；当前不因 R4 扩大。

### FORBIDDEN

- DB_VER 24 → 25；
- projectFiles 全量 migration/backfill；
- 修改 P23 message/voice contracts；
- 修改 P24 group identity/memberTurn/planner/targeting/recent；
- 修改 P30 friendId/threadId conversation scope；
- 修改 R3 image queue、workspace pending queues 或 blog queues；
- 新建 ProvenanceManager、IdentityRegistry、WorkspaceActorService、EventBus、Global Audit Store；
- 把 lastModifiedBy 改成 object；
- 用 nickname 反查 canonical ID。

## 22. Test Contract

下一阶段新增：

    tests/test_workspace_file_provenance.js

必须冻结并通过以下 cases：

| Case | Expected |
|---|---|
| F1 Role A name X writes | persisted kind=role, id=A |
| F2 Role B name X writes | persisted kind=role, id=B |
| F3 same display name | routing compares canonical tuple and distinguishes A/B |
| F4 role named User | kind=role；never treated as human |
| F5 role named 你 | kind=role；never treated as human |
| F6 role named 导入 | kind=role；never treated as import |
| F7 human manual write | kind=user，id absent，label remains User |
| F8 import | kind=import，id absent，label remains 导入 |
| F9 script writeback | kind=script，id absent，label remains 脚本 |
| F10 tool writeback | current direct writer absent；role-mediated tool uses requesting role tuple |
| F11 legacy without canonical fields | readable，no backfill |
| F12 legacy ambiguous reserved label | conservative unique-path fallback |
| F13 canonical present + display collision | canonical kind/id wins；no label fallback |
| F14 reload | kind/id survive reload |
| F15 export/import | new fields survive; legacy backup remains readable |
| F16 UI | human-readable lastModifiedBy still renders |
| F17 DB version | DB_VER remains 24 |
| F18 P29 | existing identity regression remains green |
| F19 P30 | existing scope regression remains green |
| F20 R3 | existing media attribution regression remains green |

Browser gate for implementation closure：

    real Workspace write
      -> IndexedDB persist
      -> browser reload
      -> inspect kind/id
      -> exercise archive rename routing

若 computer-control 仍不可用，允许标记 REAL_BROWSER_GATE_DEFERRED_BY_TOOLING，但必须有 real IndexedDB/runtime probe 覆盖 write、persist、reload、semantic routing。

### Mutation-style guard

contract suite 必须证明 canonical-first 是行为约束，不是装饰字段：

1. 对实现文件做 byte-level backup，记录 SHA/hash。
2. 临时把 semantic routing 改为只看 lastModifiedBy 的 mutation。
3. 执行 same-name 与 reserved-label tests；测试必须失败。
4. 恢复 byte backup。
5. 再次校验 SHA/hash 与恢复前一致。

mutation 只在隔离副本/临时工作区执行；禁止使用危险 git restore，禁止触碰用户既有 dirty changes。

## 23. Explicit Non-Goals

本 contract 不处理：

- model prompt attribution；
- authorization、permission、visibility；
- P29 actor identity rewrite；
- P30 conversation scope；
- R3 image queue；
- workspace pending queue 的 runtime attribution；
- blog queue；
- Home Node canonicalization；
- 全局 user identity；
- 工具系统的独立 provenance registry；
- legacy record migration；
- UI debug 中显示 role ID。

R4 只冻结 persisted file provenance 及其现有 archive rename semantic consumer。

## 24. Git / Worktree

R4-1 开始前 worktree 已有大量既存 dirty changes，以及 R3 与 R4-0 artifacts。本阶段不重置、不覆盖、不清理。

本阶段允许且实际只做：

- 读取 R4-1 attachment；
- 读取 R4-0 frozen audit；
- 设计并新增本文档。

本阶段禁止且未做：

- 修改 assets/js/workspace.js；
- 修改 assets/js/workspace/run.js；
- 修改 assets/js/workspace/files.js；
- 修改 assets/js/workspace/preview.js；
- 修改 assets/js/site-operations.js；
- 修改 assets/js/communication.js；
- 修改 assets/js/core.js；
- 修改 DB schema 或 DB_VER；
- 新增 implementation test file；
- commit。

## 25. Required Final Answers

Q1. 是。现有 lastModifiedBy 冻结为向后兼容的 display-only 字符串，不再把它当作稳定身份。

Q2. Canonical fields 为平铺、可选、增量加入的 lastModifiedByKind 与 lastModifiedById；lastModifiedBy 保留为兼容显示字段。

Q3. 是。lastModifiedById 是 role provenance 的必要稳定键，用于区分同名 role。

Q4. 是。kind 必须区分 role、user、import、script、system 这些来源，否则 display label 会继续承担语义。

Q5. Identity namespace 是 typed tuple (lastModifiedByKind, lastModifiedById)。role 的 ID 使用现有 apiConfigs.id/cfg.id；ID 不存昵称、不存 display label，也不使用字符串 sentinel。当前非 role writer 不伪造 ID。

Q6. Human writer：lastModifiedBy = User，lastModifiedByKind = user，lastModifiedById 缺省。

Q7. AI role writer：lastModifiedBy = 当前 role display name，lastModifiedByKind = role，lastModifiedById = 当前 apiConfigs.id/cfg.id。

Q8. Import writer：lastModifiedBy = 导入，lastModifiedByKind = import，lastModifiedById 缺省。

Q9. Script writer：lastModifiedBy = 脚本，lastModifiedByKind = script，lastModifiedById 缺省；不根据脚本由谁触发来伪造 human 或 role provenance。

Q10. 当前没有独立的 direct persisted tool writer。role 通过 tool 写入 Workspace 文件时沿用 requesting role 的 role/id tuple；未来若出现 standalone tool writer，必须先扩展本 contract。

Q11. Rename/archive routing 的 canonical predicate 是 kind = user 或 kind = import 时保护目标文件，避免 archive overwrite；canonical role、script、system 不因 label 相似而保护。canonical 缺失或非法时按 legacy unknown 采用 unique-path 保守策略。

Q12. 是。canonical provenance 存在且有效时完全禁止按 display label fallback。

Q13. Legacy record 保持可读，不迁移、不回填、不从 label 反推 ID；其 provenance 视为 unknown/ambiguous，archive collision 采用不覆盖并生成 unique path。

Q14. 不能。legacy label User 不能安全证明是 human。

Q15. 不能。legacy label 你 不能安全证明是 human。

Q16. 不能。legacy label 导入 不能安全证明是 import。

Q17. 是。两个 display name 相同的 role 通过不同的 lastModifiedById 区分。

Q18. canonical kind = role 时，即使 role 名称为 User，也不按 human 处理。

Q19. canonical kind = role 时，即使 role 名称为 你，也不按 human 处理。

Q20. canonical kind = role 时，即使 role 名称为 导入，也不按 import 处理。

Q21. 是。UI 继续显示 lastModifiedBy；本 contract 不要求现有显示文案变化。

Q22. 否。不改变 IndexedDB object store、keyPath、索引或 DB_VER。

Q23. 否。新增字段是 object-level additive metadata，不做 schema migration 或历史 backfill；若实现阶段发现某个 serializer 丢字段，应作为实现阻塞处理，不通过 DB bump 绕过。

Q24. DB_VER 保持 24。

Q25. 是。写入并 reload 后，lastModifiedByKind 与 lastModifiedById 必须仍在 projectFiles record 上，并参与后续 routing。

Q26. 是。export/import 必须保留 canonical fields；现有 whole-object pass-through 继续保留 legacy record 的可读性。

Q27. 当前不需要改变 mirror 或 Home Node 的架构语义：emergency localStorage mirror whole-object pass-through，Home Node 不接管 projectFiles。只有证据显示字段在 round-trip 中丢失时，才允许在实现阶段修改对应 pass-through。

Q28. 不加入 conversation scope、message ID、run ID 或其他会把文件 provenance 绑定到对话生命周期的字段。

Q29. 不新增 manager、registry 或独立 provenance service；字段和 writer helper 是最小实现面。

Q30. MUST inspect/implement surface 是 assets/js/workspace/files.js、assets/js/workspace.js、assets/js/workspace/preview.js、assets/js/workspace/run.js，以及 tests/test_workspace_file_provenance.js。MAYBE 仅限证据驱动的 assets/js/core.js、local-vault pass-through、assets/js/site-operations.js 或 assets/js/communication.js。FORBIDDEN 是 P23/P24/P30、R3 语义、DB bump/migration，以及任何不必要的新 manager/registry。

Q31. 测试必须验证持久化字段和行为，而不只是对象 shape：覆盖 F1–F20、reload、routing、same-name role、reserved-label collision、export/import 和 mirror round-trip。

Q32. Mutation-style guard：先对 routing 实现做字节级备份并记录 hash，临时把 canonical routing 改为 display-only，测试必须失败；随后仅恢复该备份并重新校验 hash。不得使用 destructive git restore。

Q33. P29 保持 frozen，不 reopen。

Q34. P30 保持 frozen，不 reopen。

Q35. R3 保持 closed，不 reopen。

Q36. 基于 R4-0 没有当前 contract blocker：已有 object-level projectFiles、已有 round-trip 证据和可用的 role cfg.id 足以冻结本 contract。实现阶段若发现 serializer blocker，应作为 implementation blocker 报告。

Q37. 是。R4-1 已达到 ready for implementation；本轮到此停止，不进入 implementation。

## 26. Final State

R4-1 State: PASS — CONTRACT FROZEN / READY FOR IMPLEMENTATION

STOP。R4-1 结束；不进入 implementation，等待下一步指令。
