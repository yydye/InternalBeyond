# InternalBeyond Runtime Integration Audit

审计日期：2026-09-08。基准：HEAD `5a64cd0` 加审计开始时工作区已有改动，**不是纯 HEAD**。审计未修改运行时代码、配置或已有测试，未提交 Git，未重启用户服务。新增两个审计测试及本报告；测试故意保留失败，以呈现当前行为。

结论：**核心聊天可以闭环，但系统尚不是所有功能经过一个 Character Runtime 的架构；后台事件交接、记忆可见性和状态恢复存在已复现的断链。不能宣布整体验收通过。**

证据等级：A = 真实浏览器／真实 HTTP 配合 mock provider；B = 直接执行当前源函数，存储／网络用受控替身；C = 源码调用关系确认，未做相应实机场景。测试通过仅覆盖断言，不代表对应 subsystem 全面正确。

## 1. 当前真实运行架构

```mermaid
flowchart TD
  Launcher[Windows entry → launch-internal-beyond.js] --> Manager[local-services-runner.js]
  Launcher --> Web[internal-beyond-server.js :23120]
  Manager --> Bridge[Bridge :23115]
  Manager --> Active[Active companion :23114]
  Web --> Page[InternalBeyond.html]
  File[file:// InternalBeyond.html] --> Page
  Page --> Config[apiConfigs runtime view ← IndexedDB + fallback storage]
  Directory[provider-directory.js] --> Social[social.js / window.PROVIDERS]
  Directory --> Core[IBModelCore]
  Config --> Chat[sendChatMessage → buildChatContext]
  Social --> ChatExec[callApiChatStream / callApiChat]
  Chat --> ChatExec
  FrontBG[Browser Proactive / Moments / Diary / Consolidation] --> ChatExec
  ChatExec --> Transport[_ibApiPost]
  Transport -->|http page| Provider[Configured provider]
  Transport -->|file page| Proxy[Bridge /api/llm-proxy]
  Proxy --> Provider
  Transport -->|proxy fetch throws| Provider
  Provider --> Parse[Browser response / SSE parsing]
  Parse --> Store[chatMessages / domain stores]
  Store --> UI[UI rendering]
  Config --> Snapshot[Snapshots + separate credential sync]
  Snapshot --> Active
  Active --> Scheduler[Scheduler / Moments domain]
  Scheduler --> ModelClient[callCharacterModel]
  ModelClient --> Compat[NodeModelCompat]
  Compat --> Port[NodeModelPort]
  Core --> Port
  Port --> Provider
  Active --> Events[/events → browser consumers → ACK]
  Events --> Store
  Voice[VoiceCall / ASR transcript + video frame] --> Chat
  Chat --> Sentences[reply sentences]
  Sentences --> Bridge
  Bridge --> TTS[TTS audio → VoiceCall playback]
  OptIn[IB.runtime opt-in seam] -. delegates .-> ChatExec
```

### 入口与生命周期

- HTML 明确按顺序加载经典脚本；`provider-directory.js` 在 `social.js` 前，`ib-model-core.js` 在 `agent-runtime.js` 前。[HTML](../../../InternalBeyond.html)
- `launch-internal-beyond.js:186` 先确认 Bridge／Active 就绪，再确认 Web server，最后打开页面；manager 另有 `23116` 重启控制端口。Vision 是可选进程。
- `active-diary.js:948` 附近的 `init()` 完成 openDB、配置加载、录音初始化与页面调度启动；不是 React／Next.js，也没有从命名推断出来的统一 Router 框架。
- 当前源码中未找到生产调用方调用 `IB.runtime.instance.run/create`；它是已加载的 opt-in 接缝。新增浏览器测试对 singleton 安装计数，单聊＋群聊运行后为 **0**。不能据此删除对外暴露的接缝。
- “Model Router”的实际职责分布在 `apiConfigs` 选角色、`_providerFormat` 选协议、`callApiChat*` 选请求／重试、`_ibApiPost` 选传输路径。Provider Directory 提供默认元数据；保存的角色配置可以覆盖模型和 endpoint，目录不是所有运行时配置的替代物。

### 模型配置与执行器

| 场景 | 当前配置来源 | 实际执行入口 | 状态 |
|---|---|---|---|
| 单聊 | `apiConfigs.find(id)` | `sendChatMessage → buildChatContext → callApiChat*` | A：三种协议请求、身份、落库、UI通过 |
| 群聊 | group 成员 ID → 各自 `apiConfigs`；过滤 active/muted/removed | 同一 Chat 执行器，各成员独立 cfg | A：混合三协议、每成员一条回复通过 |
| 浏览器主动消息 | 当前 cfg＋实时上下文 | `generateProactiveMessage → callApiChat` | 原有生成测试通过；不经过 `IB.runtime` |
| 浏览器朋友圈 | `_momentsCfg(roleId)`＋`_momentsContext` | `_obsCall → callApiChat`；图像走独立 image provider | 生成路径有测试；后台交接见 P1 |
| companion 主动消息／朋友圈／回复链 | 同步的 character 快照＋vault 中的 key | `callCharacterModel → NodeModelCompat → NodeModelPort → IBModelCore` | service tests通过；消费闭环有缺陷 |
| 日记／Consolidation | 当前角色 cfg | `callApiChat` | 模型执行存在，写入与召回不完全闭环 |
| Middle Brain | 独立 `apiSettings` 配置 | AstraAdapter／Responses API | 可选协调层，不替换角色 provider |

Browser 与 Node 共享目录，但**不共享完整 request builder、parser、retry、usage contract**。Browser 包含流式、工具、自动续写和缓存统计；Node 主要是非流式 512 token 执行和两类兼容重试。不能用“统一 provider”推导“执行行为完全一致”。

## 2. Memory / Context / Diary 数据流

| 功能 | 读取／注入 | 写入／限制 |
|---|---|---|
| 单聊 | system：身份、关系、站点、Auto Memory 指令、日历；tail：时间、摘要、Memory、Understanding、Thread、Moments、Auto Memory、可选 Middle Brain、Activity、工具结果 | 回应后有标签处理、消息落库、异步摘要／规划 |
| 群聊 | 独立成员身份、群规则、摘要；`group.memoryEnabled` 控制普通 Memory | Auto Memory 有独立开关，不受该条件统一控制 |
| 话题频道 | 独立历史／摘要；`thread.memoryEnabled` 控制普通 Memory、Understanding、Thread、Moments等 | Auto Memory 构建发生在此判断之前；不能假设该开关等于关闭所有记忆层 |
| Proactive／Diary／Moments | `_activeRecentMessages` 只读主聊，最多16条；普通 Memory 最多8条；摘要独立注入 | 不等同单聊的完整上下文构建 |
| Consolidation | memories、diary、moments、summary → 模型归纳 | 直接新建／覆盖 semantic memory，有 admission gate；可见性缺陷见下 |

`getMemoryContext` 不是纯读：会更新 `activationCount/lastActivated`。Middle Brain 的组织阶段会再次调用它；单聊先检索再调用未传入已读取块的 pipeline，因此同一轮可能重复读取并重复增加激活计数。Astra 成功的“压缩”结果是追加到原上下文，而非替换原块，不能声称最终发给角色的 token 量减少。证据：`communication.js:1348–1367`、`middle-brain.js:449`、`memory.js:116`。

前台 Proactive/Moments 读取并使用 `roleLetterMemories`，但对应 companion snapshot 与 Node prompt 没有该字段。后台模型配置虽来自同一角色，角色私信记忆并未完整传过去。`_activeBuildSnapshot`、`_activeSyncAiPlan`、`_momentsCompanionSnapshot` 是实际边界。

## 3. Bridge / Active / Voice / Video / Vision

- Bridge HTTP 与 IBNET WebSocket 是不同连接状态；WS 已连接不意味着每个 HTTP/ASR/TTS provider 就绪。IBNET 有连接序号防旧 socket 覆盖、12秒连接超时、2–60秒退避、心跳检测、永久鉴权错误停重试和 pending tool reject。见 `integrations.js:1209–1315`。
- Active 浏览器调度每30秒 tick，health 检查节流15秒；一般背景快照约5分钟，Moments约1分钟同步；visibility change 和部分设置保存也触发同步。companion 重启后 `armedUsers` 是空的，必须 reconcile 后执行。服务测试覆盖了本地启动、重启、陌生进程端口保护及部分去重。
- 显式后台手动任务不会在 companion 离线时自动转前台：`_activeTick` 遇 `background_enabled` 就跳过。AI plan 对已同步副本的本地接管有删除确认，避免双发；不能把所有离线模式统称为“无缝降级”。
- Moments 离线／旧服务有本地调度回退；online/capability 不是逐角色同步成功的证明。当前事件消费和 reconcile 缺陷破坏了所谓后台独占闭环。
- 语音消息 `_vmFinish → sendChatMessage`；实时通话 `VoiceCall.onTranscript → sendChatMessage({voiceCall, roleId,...})`，模型仍由 Chat 执行。Bridge ASR 产出 transcript，Chat 流式句子经 `adapter_reply_sentence` 返回 Bridge TTS；非流式经 `adapter_reply`。
- Video Runtime 负责采帧，经 `visionReference` 回到同一 Chat 请求，声学／帧参考是 request-local。旧语音消息本来就会持久化录音与 transcript，不能把“实时通话参考不持久化”泛化到所有 Voice 数据。
- 本地 Vision `8765/vision` 是感知服务：文字模型使用的图片描述旁路，不是第二个角色回答模型。ASR/TTS 各自有 provider/voice 配置是职责分离，不要求它们调用 `IB.runtime`。
- 本次新增与原有测试覆盖了 mock 媒体链、声学注入、通话文字落库、帧处理、TTS/ASR 协议。未验证真实麦克风／扬声器、真实语音服务商或本地 Qwen 推理。

## 4. 问题分级

分级：P0=立即阻断、广泛破坏；P1=关键数据／执行链错误，应先修；P2=局部风险、契约／测试漂移、未启用接缝问题。没有从本次证据确认 P0；这不构成全系统无 P0 的保证。

### P1-01：Active 消费者吞掉 Moments 队列事件（A/B，已复现）

- 事实：`active/http.js:508` 的 `/events` 返回所有 kind。`active-diary.js:766` 在 Moments tick 前运行 `_activePullCompanionEvents`；后者不区分 kind，最终 ACK 每个事件。
- 当前实际：`moment_sent` 事件可能只进入 Active history，未写入 `moments` 就被服务端删除；`moment_reply` 的 `status:'sent'` 还可能误进聊天消息分支。
- 为什么：共用队列有两个独立消费者，却没有统一分发或消费权限边界。
- 风险：后台发帖／回复在前端丢失或落入错误业务存储；服务测试和直接 ingest 测试都可能通过。
- 验证：真实 `/events` 与 ACK 路由＋当前两段消费者源码，先 Active 后 Moments，事件消失且无动态记录；主动消息对照组成功。

### P1-02：朋友圈删评事件无法到达已有 handler（A/B，已复现）

- `moments.js:1545` 有 `moment_comment_deleted` handler；`moments.js:1626` 只接受 `moment`/`moment_reply`，因此 handler 不可经正常 pull 触达。
- 后台已删评论仍留在浏览器；与 P1-01 叠加还会被提前 ACK。测试在只运行 Moments pull 时也复现。

### P1-03：stale 快照被接受后，reconcile 反而删除计划（B＋真实路由C，已复现）

- `moments.js:1503` 的 `res.stale` 分支设置 `companionSynced:true` 后 `continue`，没有把角色加入 `synced`；末尾仍提交完整 `moment_ids:synced`。
- `active/http.js:491` 删除同一 user 下不在 keep set 的 schedule。re-own 的 stale 分支也有同类遗漏。
- 触发：浏览器上传的 updatedAt 早于服务端执行推进后的 updatedAt。影响后台连续调度；不能把 stale 视为同步失败后直接清理。
- 验证：当前同步函数＋受控 stale 响应确实提交缺失该角色的 keep set；删除效果由实际 reconcile 路由源码确认。

### P1-04：Consolidation 跨越 Memory 可见性边界（B，两个场景已复现）

- `active-diary.js:508–512` 按 createdBy/visibleTo 选源，不调用 `isMemoryVisibleTo`；`private` 且 createdBy 为角色的记录可进入 provider prompt。
- 新 semantic 固定 `visibility:'public'`（`:581`）；原本 only 某角色的记忆，经过归纳可能变成其他角色可读。
- 当前普通召回明确排除 private（`memory.js:25`）。不是文档歧义，而是两个当前实现有不同读取边界。
- 验证：实际 Consolidation 源函数，分别捕获 private 标记进入请求，以及 only 来源产出的 semantic 是 public；没有向外部模型发送任何测试内容。
- 风险：受限内容泄露到模型／其他角色。修复时还需审视已有 semantic provenance，不能在只修新写入后声称历史数据已恢复。

### P1-05：日记 Memory “已写入”但不可召回（B，已复现）

- `_diaryWriteMemory` (`diary.js:128`) 直接写 memories，缺 `visibility`；createdBy 是 `'ai'`，角色 ID 在 `characterId`。
- `isMemoryVisibleTo` 对缺失 visibility 返回 false；Consolidation 按 createdBy/visibleTo 过滤也不认该 characterId。
- 验证：真实日记写入函数产出记录，再交给真实可见性函数，同一角色不可见。UI 部分显示用 `visibility || 'public'`，因此还可能显示为公开而召回不读。

### P1-06：配置降级保存成功后被旧 IndexedDB 记录覆盖（B，已复现）

- `_persistApiConfig` 在 IDB 写失败后保存 local/session/memory；`loadApiConfigs` 对同 ID 无条件优先可读的旧 IDB 行（`social.js:561/586`）。
- 触发：IDB 旧记录仍可读但本次写入失败；重新 render/load 后模型／key恢复旧值。不是所有 fallback 场景都会发生。
- 验证：实际两个函数，旧 model 可读、写失败、新 fallback 保存成功，load 后 model 回到旧值。
- 风险：UI成功提示与后续运行配置不一致；修复需要版本／成功写入状态策略，不能重新改成“镜像永远覆盖 IDB”。

### P1-07：后台 AI 总开关未传到 companion（C）

- `bgAi` 仅存浏览器 apiSettings，`_bgAiSaveSwitches` 只保存本地；`_activeTick` 的 hibernate 早退不撤销已经 armed 的后台任务。
- Node scheduler 检查 task.enabled/background_enabled 或 plan prefs，不接收该 bgAi 总开关。关闭页面上“后台 AI”仍可能让已同步后台任务继续唤醒模型。
- 尚未对用户的真实后台计划执行停启测试；结论来自完整保存→快照→scheduler字段链。修复应明确总开关覆盖的任务类型，并保持 Moments 已有例外语义。

### P2-01：语音重连在握手前关闭时悬挂（B，已复现）

`call.js:110–148` 的 `connect(true)` 在尚未 hello_ack 时收到 clean close，设置 settled 后直接 return，没有 reject，调用方 `await` 不结束，也不能从 catch 进入后续重试。mock socket 仅发送握手前 close 即复现；正常已建立连接断开是另一分支，不能说所有重连都坏。

### P2-02：未启用 Runtime 的 ModelSpec 不正确（B/C）

`agent-runtime.js:137` 用只判断函数的 `has()` 检查 `IBModelCore` 和 `PROVIDERS` 对象，两个条件恒假，Anthropic/Gemini 的 `format` 都回落 openai。已执行实际模块复现。当前 Chat 不调用它，默认 adapter 又按 provider 路由，不能据此断言现有 Anthropic Chat 已坏。

同一接缝还没有把 loadContext 结果编进 request.messages；默认 ModelPort 重建 cfg 丢 id/maxTokens 等字段，usage 恒 null，非流式 abort 并未接到旧执行器。这些是下一次接入前的契约债务，不应在本审计中迁移主链来“修正”。

### P2-03：Middle Brain 重复检索／重复注入与状态漂移（C）

单聊先读取 Memory，再以空 opts 调用 pipeline 重新读取；getMemoryContext 具有激活写入副作用。Astra 成功后摘要与原块同时存在；失败也可能已经多做一次记忆激活。存在重复计数／上下文扩张路径，未用真实 Astra 测量重复率或 token 成本。

### P2-04：前后台上下文合同不等价（C）

roleLetterMemories 在前台 prompt 存在，在后台快照／prompt 缺失；Understanding/Thread/Auto Memory 也不是所有业务共同注入。普通 Memory、Auto Memory、话题 memoryEnabled 是不同门控。需要逐触发器确认产品预期，不能直接把所有上下文统一追加。

### P2-05：Consolidation 水位与 provenance 不完整（C）

源 episodic 的 lastConsolidatedAt 被读取但没有更新；只检查第一条 semantic 的时间／相似度；recent 来源 getAll 后 slice，没有显式按时间排序；提示未提供真实源 ID却允许返回 consolidatedFrom，空数组也不回退。这些可能造成旧材料重做、漏合并或不可靠来源引用；未把所有可能性视为已发生的数据损坏。

### P2-06：配置／凭证同步存在旧副本窗口（C）

- Browser `apiConfigs` 是内存视图；本次保存会刷新本页，但已检查的跨窗口 storage handler 仅处理 chatMessages，未发现对 API 配置更新的对应刷新。另一个长期打开页面可能继续使用旧 cfg。
- credential sync 按角色 upsert，空 key 跳过，不撤销旧 vault key；scheduler/Moments 仅把 vault.apiKey 合并进业务快照，不验证该 key 的 provider/endpoint 是否匹配。云端角色改成本机免 key 后，旧 key 仍可能被附加；配置与凭证分两次更新期间也有不一致窗口。
- 这些是多个存储的同步协议问题，不能用增加第二个 registry 解决。未对真实凭证做发送实验。

### P2-07：验证入口与断言漂移（A/B/C）

- `test-all.js --all` 仅包含50项，遗漏当时存在的31项 JS测试与Python vision测试。
- 结构测试：两个文件缺 BOM；inline styles 470 超预算。
- Harness guard 把 ModelCore 的任何 require 判失败，但当前目录提取新增了对纯 metadata 的 require；应更新允许的依赖边界，不应为了过测试复制目录。
- activity测试仍要求 DB_VER===21，当前源码23且对应 stores存在。
- worklet测试只等 `IB/activeFriendId` 即检查后加载的 voiceCall，存在加载竞态；新增等待完整加载的 localhost测试可看到 voiceCall。
- Moments删评测试用固定 `'local_user'` 而非当前 `_activeUserId()`，当前权限判断因此拒绝；不能直接移除权限检查。
- 两个生图测试在 force:true 下期待 wantImage:false 不生图，而当前 force 明确跳过该条件；需确认手动强制语义，不改生产行为迁就旧测试。
- provider契约测试本次CDP已READY，19条断言失败；其mock CORS未列实际Anthropic额外请求头，并存在发起后未等待请求完成就断言等缺陷。新隔离测试在两入口确认三协议实际闭环；原测试19项失败的全部因果未逐条拆完，不能标记成已修复。

## 5. Source of truth 清单

| 数据 | 持久层 | 运行视图／副本 | 审计结论 |
|---|---|---|---|
| Provider默认元数据 | JS directory | window.PROVIDERS 与 IBModelCore引用 | 当前只有一份字面量；无需新registry |
| 角色配置 | IndexedDB apiConfigs | local/session/memory fallback＋apiConfigs/archivedConfigs | 是有意降级设计；恢复优先级有复现缺陷 |
| 聊天／Memory／Diary | IndexedDB各store | UI、摘要、检索状态 | 各用途有区别；日记memory字段合同断链 |
| Moments调度 | 浏览器 localStorage state | companion JSON schedule＋浏览器标志 | 双端同步／reconcile是协议，不能一删了之 |
| 后台任务与运行状态 | companion JSON、原子保存／备份 | armedUsers进程内、快照 | 重启必须对账；事件导入有缺陷 |
| 后台凭证 | credential-vault | runtime enrich＋旧snapshot兼容 | 业务快照已剥key；清空／换端点传播未闭环 |
| Bridge | Bridge config/persistence | 启动时内存配置＋浏览器IBNET设置 | 与Active不同生命周期；各自health不等价 |

file:// 与 localhost、不同端口／浏览器 profile 是不同存储作用域。启动器引入 localhost 不会自动让原 file 数据迁入；本次未修改用户数据，也未假设“空库=数据丢失”。

## 6. 已确认闭环与未闭环边界

已确认：真实 HTML加载→配置→单聊三协议／混合群聊→身份进入请求→回复落库→UI；Anthropic/Gemini缓存统计；原有Chat语音转文字与声学参考测试；Bridge/Active隔离服务测试；Node model/compat 的现有测试；普通主动消息HTTP消费与ACK对照组。

未闭环：Moments完整后台事件导入；删评回传；stale后持续调度；日记Memory召回；Consolidation可见性；部分配置恢复。`IB.runtime`作为所有触发器的统一入口**尚不存在于实际调用链**，不能列为完成项。

## 7. 可删除的历史债务

本次没有删除任何代码。

较低风险候选：`active-message-service.js:135–136` 对 `modelClient.responseParts/fetchJson` 的两个未使用绑定；对应 `active/model-client.js` 的旧 responseParts/fetchJson（仍导出，但仓库运行调用与测试未发现消费者；删除导出前仍需确认仓库外使用）。真正在运行的解析版本位于 node-model-compat，Bridge自己的fetchJson仍被使用，不能同名批删。

可以清理／更新：NodeModelPort“未接入”、node-model-compat“未修改model-client”、HANDOVER“全绿”、ARCHITECTURE“Bridge不代理聊天”等失真说明；应以本报告事实替换，不能继续作为阶段完成证据。

不建议删除：NodeModelCompat（仍负责实际兼容重试）、browser parser（仍是主聊天执行器）、window双挂载（HTML内联与跨文件调用依赖）、callAPI旧入口（Letters/Blog等仍调用）、credential migration/fallback（老数据兼容）、本地Vision（有实际调用）、AgentRuntime公开接缝（未接入不等于获准删除）。

## 8. 测试结果与复现

| 执行集合 | 结果 |
|---|---|
| 原 `node test-all.js --all` | 50个脚本：44通过／6失败；276.3秒 |
| 额外原有JS测试 | 31个：28通过／2失败／1跳过；跳过进程退出0，不记通过 |
| 原有JS合计 | **81个：72通过／8失败／1跳过**；ModelCore通过伴8条WARN |
| `python test_vision.py` | 执行失败：默认test.jpg不存在；8765 health本次不可达，未验证真实Vision |
| 新 `node test_runtime_integration_audit.js` | 10个场景：1通过／9失败，保留真实缺陷 |
| 新 `node test_runtime_browser_audit.js` | localhost：5组通过，Runtime调用计数0 |
| 新 `node test_runtime_browser_audit.js --file` | file入口：5组通过，Runtime调用计数0 |

原有失败脚本：test_frontend_structure、test_harness_boundary、test_moments_smoke、test_moments_phase2_smoke、test_activity_smoke、test_worklet_localhost、test_chat_smoke_provider_contract、test_moments_phase4_smoke。

跳过：test_commerce_playwright_smoke，localhost:8931 MCP不可达。没有启动它、安装依赖或声称完成真实购物浏览器验证。

新增测试复用现有CDP harness；HTTP随机端口、浏览器新临时profile；新浏览器测试阻止访问用户服务和外部provider。Node审计执行当前函数片段，source boundary断言防止悄悄测错函数；它不是完整浏览器／真实IndexedDB事务测试。报告中的A/B/C界限不可省略。

原测试全量与额外集的部分浏览器执行时间存在重叠，因此对可能涉及时序的原测试失败保留竞态解释；新增针对性浏览器验证在原套件完成后独立运行，没有以原套件失败数替代产品故障数。

运行日志：`%TEMP%/ib-runtime-audit-all.log`、`%TEMP%/ib-audit-extra-z7ml5v/*/output.log`、`%TEMP%/ib-runtime-integration-audit.log`、`%TEMP%/ib-runtime-browser-audit.log`、`%TEMP%/ib-runtime-browser-file-audit.log`。持久化机器摘要见同目录 `RUNTIME-INTEGRATION-AUDIT-2026-09-08.results.json`；原日志在临时目录，可能被系统清理。

本次只读health探测：23114/23115/23120可达，8765不可达。health不证明正在运行的进程已加载当前工作区版本；没有读取真实key、导出用户聊天或重启用户服务。

## 9. 建议下一阶段（逐项最小修复，不合并为重构）

1. 先修事件分发／ACK边界、删评kind、stale keep set；让新增相关红测转绿，再跑原Moments/Active服务与浏览器回归。
2. 修Memory可见性与日记字段合同；单独设计已有坏记录的识别／修复策略，禁止直接把全部缺visibility记录公开。
3. 修配置降级恢复及vault清空／endpoint绑定语义；增加跨窗口、服务在线／离线切换的配置更新验证。
4. 把后台总开关的含义贯穿已同步companion任务；修握手前断线的重连Promise。
5. 校准测试入口和过时断言；保留产品行为决策与测试修复的区别。补足测试后重新跑全量，不能直接把9个新失败标为known skip。
6. 最后决定是否推进Character Runtime接入；先解决format/identity/budget/abort/usage/context契约，再选一个触发器渐进迁移。此次审计不建议全链一次性收敛。
