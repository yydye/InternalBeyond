# P31 · Middle Brain Direct Channel

状态：P31 implementation closure（不包含 P32）。

## 1. 目的与边界

P31 为 InternalBeyond 增加一个隐藏的 Middle Brain 独立直连面。它是用户与 Middle Brain 的直接对话，不是角色、不创建角色、不进入普通 Chat / Role DM / Group Chat，也不改变既有角色运行链。

入口是：

```text
InternalBeyond.html?middlebrain
```

入口由 `assets/js/middle-brain-direct.js` 读取 query flag 后动态挂载 `#ib-middle-brain-direct-root`。它不创建 `#page-middle-brain-direct`，不调用 `navTo()`，不写 `location.hash`，不出现在普通导航、角色列表或侧栏。关闭时只移除 query，保留原 hash 与 `currentPage`。

## 2. 审计结论

实现前的只读审计确认了以下 canonical seams：

- 页面路由和 hash 恢复位于 `assets/js/core.js:356-455`；未知的 `page-*` 不会被普通导航接受，因此 P31 使用独立 query overlay。
- Middle Brain 的 runtime prompt 为 `MB_SYSTEM_PROMPT`，位于 `assets/js/middle-brain-config-core.js:71-153`，由 `assets/js/middle-brain-config.js` 读取；P31 不修改该常量或其 runtime consumer。
- Middle Brain 的唯一 Astra 网络边界为 `MBC.astra.middleBrainModelCall`，位于 `assets/js/middle-brain-astra.js:127-167`，请求构造继续经过 `AstraAdapter` / `IBModelCore`；P31 通过 `IB.middleBrainDirectModelCall` 公共 facade 调用它，不读取内部层契约。
- 普通角色消息在 `assets/js/communication.js:2835-3197` 经过角色 friend/thread、活动解析、`chatMessages`、主动消息 / 日记 / side-effect / integrity 链；P31 不调用这条链。
- `chatMessages` 的 canonical identity / `friendId` / `threadId` 由 `assets/js/chat-core.js:64-140` 定义；P31 不把 Direct transcript 放入该 store。
- `memories` 的既有 `getMemoryContext` 会记录 activation，位于 `assets/js/memory.js:115-125`；P31 不调用它，改用可见性核心 + bounded read-only resolver。
- Moments、Role Letters、Activity、Diary 各自有独立 store / authority；P31 只读，不调用各域 writer、tick、autonomy 或 side-effect seam。

## 3. Prompt contract

P31 保持两个明确且不互相污染的 prompt contract：

| Contract | 来源 | 消费者 | 语义 |
| --- | --- | --- | --- |
| `runtimeSystemPrompt` | `MB_SYSTEM_PROMPT` / `getMiddleBrainSystemPrompt()` | 普通角色运行链 | 认知层，不是角色回复，不创建世界副作用 |
| `directChatSystemPrompt` | `DIRECT_CHAT_SYSTEM_PROMPT` in `assets/js/middle-brain-direct.js` | `?middlebrain` Direct Channel | 用户直接与 Middle Brain 对话；只读世界，只有自己的 transcript 可写 |

Direct 请求将 `system: directChatSystemPrompt` 与 bounded messages 交给 `IB.middleBrainDirectModelCall`（内部委托 canonical `MBC.astra.middleBrainModelCall`），并强制 `jsonMode:false`、`consumer:'middle_brain.direct'`。它不把 runtime prompt 拼进 direct prompt，也不调用角色 persona / integrity / side-effect。

## 4. Storage

Direct transcript 使用独立 key：

```text
localStorage['ib_middle_brain_direct_v1']
```

值为 `{ version: 1, messages: [...] }`，最多保留 200 条 user / assistant 消息，每条正文最多 8000 字。刷新后恢复，清除只删除这个 key。

P31 不新增 IndexedDB store，不升 `DB_VER=24`，不写 `chatMessages`、`chatThreads`、`chatSummaries`、`activities`、`memories`、`diary_entries`、`moments`、`roleLetters`，也不进入普通导出 / 导入数据结构。Direct transcript 是自己的 conversation namespace，不参与角色列表、聊天搜索、活动、主动消息或角色记忆。

## 5. Read-only context resolver

`createResolver()` 返回一个只读 resolver。每轮的输入是当前 query 与 Direct 近期对话；检索上下文仅按 bounded budget 收敛：

- 最近 Direct 消息：最多 12 条；
- 私聊 / 群聊：canonical Home Node 复用现有 `/list` cursor 分页，单会话最多读取 420 条候选；非 canonical 宿主使用 IndexedDB `byFriend` cursor，旧宿主才回退既有 `dbGetByIndex`；最终每会话最多 6 条，不对 `chatMessages` 做整表 `getAll`，`roledm_` 角色私信被排除；
- Memories / Diary / Activities / fallback Moments：通过 `dbScan` 游标逐条读取，单 store 最多扫描 420 条；不调用 `getMemoryContext`，因此不产生 activation 写入；
- Moments 优先复用既有 `getMoments(maxScan)` 用户可见 bounded read；
- Relationship：复用 `IB.roleDm.relationsAll()` 的只读 canonical getter，只投影 `from/to`、`trust`、`familiarity`、`affinity`、`updatedAt` 等摘要，不读取或注入 observations 原文；
- Role Letters：按已有 `byFrom` / `byTo` 索引逐角色读取并按 id 去重；不调用 role-letter tick 或 read writer；
- 角色 metadata 只白名单传入 id / name / model / provider / relationship，不传 `apiKey`、endpoint 或完整 role `systemPrompt`；
- 最终来源最多 28 条、每来源类型最多 8 条、上下文最多 7200 字 / 1900 tokens；按 relevance → timestamp → stable source order 排序，按 source id 与内容去重；
- 每条模型来源保留 `sourceType`、`sourceId`、角色 / 群 / thread、timestamp provenance；上下文正文被定界为 evidence，不作为指令。

使用的来源类别：`private_chat`、`group_chat`、`memory`、`relationship`、`diary`、`moment`、`role_letter`、`activity`。

`assets/js/core.js` 新增的 `dbScan()` 是通用只读 cursor helper，只增加读能力，不改变既有 `dbGet*` 契约或数据库 schema。

## 6. Permission boundary

Direct Channel 的模型输入可以观察 InternalBeyond 的授权上下文，但模型输出只作为 Direct transcript 的 assistant 文本保存。输入 `/remember`、`/message` 等内容没有命令解析路径，按普通文本处理。Direct 模块没有 `dbPut`、`dbDelete`、角色 tick、活动发送、Moments publish、Diary generate、Role Letter writer 或普通 `sendChatMessage` 调用。

## 7. Provider / reasoning

Direct 沿用 `IB.middleBrainDirectModelCall` → `middleBrainModelCall` → `buildMiddleBrainResponsesRequest` → `AstraAdapter` → `IBModelCore` 的 canonical provider / endpoint / reasoning effort 路径，不复制 API key、provider endpoint、reasoning wire map 或模型请求体。Direct 仅改变 consumer metadata 与 `jsonMode:false`，不会创建第二套 provider adapter。

## 8. Verification

P31 测试覆盖：

- query route 的默认隐藏、关闭恢复、普通 hash / page 不变；
- `runtimeSystemPrompt` 与 `directChatSystemPrompt` 独立；
- source provenance、相关性 / 时间排序、去重、字符 / token budget；
- Direct transcript 的独立 namespace、刷新恢复与上限；
- resolver 不写世界域，排除 Role DM，并使用 bounded read seam；
- canonical Astra model-call consumer / `jsonMode:false`；
- 普通 Chat contract / runtime prompt regression。

验证命令：

```text
node tests/test_middle_brain_direct.js
node --check assets/js/middle-brain-direct.js
node --check assets/js/core.js
node tests/test_chat_core_contract.js
node tests/test_middle_brain_convergence.js
node tests/test_middle_brain_semantics.js
node scripts/scripts_check_html.js InternalBeyond.html
```

浏览器 smoke 使用本地静态服务器验证 `?middlebrain#chat`、刷新恢复、Direct transcript 写入、无 provider 时 fail-safe、关闭后恢复 `#chat` 与底部隐藏提示；验证结束后已按会话与服务 PID 清理浏览器和静态服务器。
